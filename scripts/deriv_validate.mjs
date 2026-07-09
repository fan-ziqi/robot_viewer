// Quantify how well JointDerivatives recovers q̇, q̈ from a realistic RobFlow stream, and gate
// the estimator against regressions.
//
// The live /robot WS gives joint POSITIONS only (~16 Hz, quantised to 0.01°); torque and
// current are reconstructed from q̇, q̈ that we DIFFERENTIATE from that stream. Since q̇, q̈
// dominate the inertia (∝q̈) and Coriolis (∝q̇²) torque, the derivative error is the single
// biggest lever on reconstructed torque/current fidelity — and there is no robot-side
// torque/current on the wire to calibrate against, so this synthetic benchmark IS our metric.
//
// We feed analytic trajectories (known q̇, q̈) through a 0.01°/60 ms quantiser+sampler into
// JointDerivatives and report RMS / max error. The centred estimator reports the state at a
// fixed LAG behind the newest sample, so we compare its output to truth at that lagged instant
// (not "now") — otherwise we would mis-charge the lag as estimator error.
//
// Usage: node scripts/deriv_validate.mjs

import { JointDerivatives } from '../src/dynamics/JointDerivatives.js';

const RAD2DEG = 180 / Math.PI;
const QUANT_DEG = 0.01; // encoder/stream quantisation of the position stream

/** Quantise a radian angle to the 0.01° grid the stream is quantised to, back to radians. */
function quantize(qRad) {
    const deg = qRad * RAD2DEG;
    return (Math.round(deg / QUANT_DEG) * QUANT_DEG) / RAD2DEG;
}

// --- analytic test trajectories: t(s) -> {q, dq, ddq} in rad, rad/s, rad/s² -------------
/** Sinusoid q = A·sin(ωt): the classic velocity/accel test (Coriolis stresses q̇²). */
const sine = (A, f) => (t) => {
    const w = 2 * Math.PI * f;
    return { q: A * Math.sin(w * t), dq: A * w * Math.cos(w * t), ddq: -A * w * w * Math.sin(w * t) };
};
/** Smootherstep point-to-point move (C² quintic, zero q̇/q̈ at both ends) — mimics a real
 *  jerk-limited robot move, so the accel profile resembles what the controller commands. */
const move = (delta, T) => (t) => {
    if (t <= 0) return { q: 0, dq: 0, ddq: 0 };
    if (t >= T) return { q: delta, dq: 0, ddq: 0 };
    const x = t / T;
    const s = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
    const sp = (30 * x ** 4 - 60 * x ** 3 + 30 * x ** 2) / T;
    const spp = (120 * x ** 3 - 180 * x ** 2 + 60 * x) / (T * T);
    return { q: delta * s, dq: delta * sp, ddq: delta * spp };
};

// --- small stats ------------------------------------------------------------------------
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / (a.length || 1));
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// deterministic PRNG so jitter runs are reproducible
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fixed-lag sample count the centred estimator trails "now" by, once the window is full. */
function lagSamplesOf(estOpts) {
    const W = Math.max(3, estOpts.windowSize ?? 5);
    const centred = estOpts.centred ?? true;
    return centred ? (W - 1) - Math.floor((W - 1) / 2) : 0;
}

/**
 * Run one trajectory through the REAL JointDerivatives and return error stats vs analytic truth.
 * Centred output at step i reports the state `lag` samples in the past → compared to that instant.
 * @param {(t:number)=>{q:number,dq:number,ddq:number}} traj
 * @param {{dtTrueMs:number, estOpts:object, quant?:boolean, jitterMs?:number, duration:number}} cfg
 */
function run(traj, { dtTrueMs, estOpts, quant = true, jitterMs = 0, duration }) {
    const est = new JointDerivatives(estOpts);
    const W = Math.max(3, estOpts.windowSize ?? 5);
    const lag = lagSamplesOf(estOpts);
    const warm = W + 1;
    const dt = dtTrueMs / 1000;
    const n = Math.round(duration / dt);
    const rng = mulberry32(42);
    const errV = [], errA = [];
    let peakV = 0, peakA = 0, clock = 0;
    for (let i = 0; i <= n; i++) {
        const truth = traj(i * dt);
        const qin = quant ? quantize(truth.q) : truth.q;
        const tMs = clock + (jitterMs ? (rng() * 2 - 1) * jitterMs : 0);
        clock += dtTrueMs;
        const out = est.update([qin], tMs);
        if (i >= warm) {
            const ref = traj((i - lag) * dt); // truth at the reported (lagged) instant
            errV.push(out.velocity[0] - ref.dq);
            errA.push(out.acceleration[0] - ref.ddq);
            peakV = Math.max(peakV, Math.abs(ref.dq));
            peakA = Math.max(peakA, Math.abs(ref.ddq));
        }
    }
    return { vRMS: rms(errV), vMax: maxAbs(errV), peakV, aRMS: rms(errA), aMax: maxAbs(errA), peakA };
}

// --- independent centred reference (acausal symmetric window) ---------------------------
function gauss(A, b) {
    const n = b.length;
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((r, i) => r[n] / r[i]);
}
function polyfitCoeffs(ts, ys, order) {
    const N = order + 1;
    const A = Array.from({ length: N }, (_, j) => Array.from({ length: N }, (_, k) => ts.reduce((s, t) => s + t ** (j + k), 0)));
    const b = Array.from({ length: N }, (_, j) => ts.reduce((s, t, i) => s + ys[i] * t ** j, 0));
    return gauss(A, b);
}
/** Reference: symmetric ±half window, evaluate at centre. Validates run(centred:true). */
function runCentered(traj, { dtTrueMs, half, order, quant = true, duration }) {
    const dt = dtTrueMs / 1000;
    const n = Math.round(duration / dt);
    const q = [];
    for (let i = 0; i <= n; i++) {
        const truth = traj(i * dt);
        q.push(quant ? quantize(truth.q) : truth.q);
    }
    const errV = [], errA = [];
    let peakV = 0, peakA = 0;
    for (let i = half; i <= n - half; i++) {
        const ts = [], ys = [];
        for (let k = -half; k <= half; k++) { ts.push(k * dt); ys.push(q[i + k]); }
        const c = polyfitCoeffs(ts, ys, order);
        const truth = traj(i * dt);
        errV.push((c[1] ?? 0) - truth.dq);
        errA.push(2 * (c[2] ?? 0) - truth.ddq);
        peakV = Math.max(peakV, Math.abs(truth.dq));
        peakA = Math.max(peakA, Math.abs(truth.ddq));
    }
    return { vRMS: rms(errV), vMax: maxAbs(errV), peakV, aRMS: rms(errA), aMax: maxAbs(errA), peakA };
}

const pct = (e, peak) => (peak > 0 ? (100 * e / peak).toFixed(1).padStart(6) + '%' : '   n/a');
const f4 = (v) => v.toFixed(4).padStart(9);
const line = (label, r) =>
    console.log(`${label.padEnd(32)} | ${f4(r.vRMS)} ${pct(r.vRMS, r.peakV)} | ${f4(r.vMax)} | ${f4(r.aRMS)} ${pct(r.aRMS, r.peakA)} | ${f4(r.aMax)}`);

function report(title, traj, duration) {
    console.log(`\n### ${title}`);
    console.log('config                           | vel RMS   (%pk) | vel max   | acc RMS   (%pk) | acc max');
    console.log('---------------------------------+-----------------+-----------+-----------------+----------');
    const CAUSAL = (w) => ({ windowSize: w, fixedDt: true, fixedDtMs: 60, centred: false });
    const CENTRED = (w) => ({ windowSize: w, fixedDt: true, fixedDtMs: 60, centred: true });
    line('OLD causal  win=7  (was default)', run(traj, { dtTrueMs: 60, estOpts: CAUSAL(7), duration }));
    line('    causal  win=3', run(traj, { dtTrueMs: 60, estOpts: CAUSAL(3), duration }));
    line('NEW centred win=5  (now default)', run(traj, { dtTrueMs: 60, estOpts: CENTRED(5), duration }));
    line('    centred win=7', run(traj, { dtTrueMs: 60, estOpts: CENTRED(7), duration }));
    line('    centred win=5  NO quantise', run(traj, { dtTrueMs: 60, estOpts: CENTRED(5), quant: false, duration }));
    line('    centred win=5  +8ms jitter', run(traj, { dtTrueMs: 60, estOpts: CENTRED(5), jitterMs: 8, duration }));
    line('    centred win=5  true rate 62.5', run(traj, { dtTrueMs: 62.5, estOpts: CENTRED(5), duration }));
    line('    centred win=5  NO rate-track*', run(traj, { dtTrueMs: 62.5, estOpts: { windowSize: 5, fixedDt: false, centred: true }, duration }));
}

report('Sine  A=1.0 rad  f=0.25 Hz  (gentle)', sine(1.0, 0.25), 12);
report('Sine  A=1.0 rad  f=0.75 Hz  (fast — near Nyquist stress)', sine(1.0, 0.75), 12);
report('Move  Δ=1.5 rad  over 2.0 s  (jerk-limited PTP)', move(1.5, 2.0), 3);

// --- Real centred impl vs independent acausal reference (implementation check) ----------
function checkImpl(title, traj, duration) {
    console.log(`\n### impl check — ${title}  (real JointDerivatives vs acausal reference)`);
    console.log('estimator                        | vel RMS   (%pk) | vel max   | acc RMS   (%pk) | acc max');
    console.log('---------------------------------+-----------------+-----------+-----------------+----------');
    line('real  centred win=5', run(traj, { dtTrueMs: 60, estOpts: { windowSize: 5, fixedDt: true, fixedDtMs: 60, centred: true }, duration }));
    line('ref   symmetric ±2 quad', runCentered(traj, { dtTrueMs: 60, half: 2, order: 2, duration }));
}
checkImpl('Sine f=0.75 Hz', sine(1.0, 0.75), 12);
checkImpl('Move Δ=1.5 rad / 2 s', move(1.5, 2.0), 3);

console.log('\nNotes:');
console.log('  • Centred output is compared to truth at the LAGGED instant it actually reports (lag = ⌊(win-1)/2⌋ samples).');
console.log('  • acc RMS %pk is the headline: it maps ~1:1 onto the inertia-torque (and its share of current) error.');
console.log('  • "true rate 62.5" vs "NO rate-track*": the rate-tracking clock removes the systematic bias when the');
console.log('    real sample spacing ≠ the 60 ms seed; the * row (fixedDt=false, raw jittery timestamps) is the contrast.');
console.log('  • "real centred win=5" should match the "ref symmetric ±2 quad" row (validates the fixed-lag implementation).');
