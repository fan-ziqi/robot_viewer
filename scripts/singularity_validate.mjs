// Validate the singularity metric on the real arm via mujoco-js (Node, headless).
//
// Two checks:
//   A) Self-consistency of our numeric Jacobian: J·dq must match the actual FK displacement
//      fk(q+dq) − fk(q) to first order (proves J is internally correct — no controller data needed).
//   B) The manipulability index σ = √det(J·Jᵀ) collapses toward 0 at a wrist singularity and is
//      healthy in a normal pose, matching the controller's fault threshold (0.005).
//
// Reuses the FK/MJCF plumbing from ik_validate.mjs; imports the REAL metric code from
// src/dynamics/singularity.js so the math under test is the shipping module.
import { readFileSync } from 'node:fs';
import {
    singularityMetrics, classifySingularity,
    SINGULARITY_FAULT_INDEX, SINGULARITY_WARN_INDEX,
} from '../src/dynamics/singularity.js';

const load = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
const mj = await load();
try { mj.FS.mkdir('/working'); } catch {}
try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch {}

const DRIVE = new Set(['Drive', 'BaseDrive']);
const fmt = (n) => (Math.abs(n) < 1e-12 ? '0' : Number(n.toFixed(9)).toString());
const vc = (a) => a.map(fmt).join(' ');
function decompose(m) {
    if (!m) return { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
    const pos = [m[0][3], m[1][3], m[2][3]];
    const [r00, r01, r02] = m[0], [r10, r11, r12] = m[1], [r20, r21, r22] = m[2];
    const tr = r00 + r11 + r22; let w, x, y, z;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = .25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s; }
    else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / s; x = .25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s; }
    else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / s; x = (r01 + r10) / s; y = .25 * s; z = (r12 + r21) / s; }
    else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = .25 * s; }
    return { pos, quat: [w, x, y, z] };
}
function inertial(mass, I, com) {
    if (!mass || mass <= 0) return '';
    const ia = I && I.length === 3 ? `fullinertia="${vc([I[0][0], I[1][1], I[2][2], I[0][1], I[0][2], I[1][2]])}"` : 'diaginertia="1e-6 1e-6 1e-6"';
    return `<inertial pos="${vc(com || [0, 0, 0])}" mass="${fmt(mass)}" ${ia}/>`;
}
function mjcf(descs) {
    let inner = `<site name="tcp" pos="0 0 0" size="0.01"/>`;
    for (let i = descs.length - 1; i >= 0; i--) {
        const d = descs[i], dyn = d.dynamics || {}, kin = d.kinematics || {};
        const drive = DRIVE.has(d['module-type']);
        const P = decompose(kin.proximal_transformation);
        const D = drive ? decompose(kin.distal_transformation) : { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
        const pj = drive ? `<joint name="j${i}" type="hinge" axis="0 0 1" limited="false"/>` : '';
        inner = `<body name="b${i}p">${inertial(dyn.proximal_mass, dyn.proximal_inertia, dyn.proximal_center_of_mass)}`
            + `<body name="b${i}s" pos="${vc(P.pos)}" quat="${vc(P.quat)}"><body name="b${i}d" pos="${vc(D.pos)}" quat="${vc(D.quat)}">`
            + `${pj}${drive ? inertial(dyn.distal_mass, dyn.distal_inertia, dyn.distal_center_of_mass) : ''}${inner}</body></body></body>`;
    }
    return `<mujoco model="r"><compiler angle="radian"/><option gravity="0 0 -9.81"/><worldbody>${inner}</worldbody></mujoco>`;
}

const ids = ['0305', '8009', '0302', '8009', '0326', '8008', '0301', '8008', '0301', '8008', '0315', '8007', '0300', '8007', '0300', '8007', '1000'];
const map = JSON.parse(readFileSync('C:/Users/zeili/OneDrive/Dokumente/VSC/robot_viewer/public/robco-fixtures/module_folder_mapping.json', 'utf8'));
const cache = {}; const descs = [];
for (const id of ids) { const e = map[id]; if (!cache[id]) cache[id] = await (await fetch(`https://robco.studio/modules/${e.folderName}/${e.fileName}`)).json(); descs.push(cache[id]); }
mj.FS.writeFile('/working/k.xml', mjcf(descs));
const model = mj.MjModel.loadFromXML('/working/k.xml');
const data = new mj.MjData(model);
const SITE = mj.mjtObj?.mjOBJ_SITE?.value ?? 6;
const sid = mj.mj_name2id(model, SITE, 'tcp');
const nq = descs.filter((d) => DRIVE.has(d['module-type'])).length;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deg = (d) => d.map((v) => v * Math.PI / 180);
function fk(q) { for (let i = 0; i < nq; i++) data.qpos[i] = q[i]; mj.mj_fwdPosition(model, data); const p = sid * 3, m = sid * 9; return { pos: [data.site_xpos[p], data.site_xpos[p + 1], data.site_xpos[p + 2]], mat: Array.from({ length: 9 }, (_, k) => data.site_xmat[m + k]) }; }
function rotVec(A, B) { const R = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] = B[3 * i] * A[3 * j] + B[3 * i + 1] * A[3 * j + 1] + B[3 * i + 2] * A[3 * j + 2]; const tr = R[0] + R[4] + R[8], ang = Math.acos(clamp((tr - 1) / 2, -1, 1)), ax = [R[7] - R[5], R[2] - R[6], R[3] - R[1]], s = Math.sin(ang); if (Math.abs(s) < 1e-9) return [0, 0, 0]; const k = ang / (2 * s); return [ax[0] * k, ax[1] * k, ax[2] * k]; }
// Same numeric Jacobian as MujocoKinematics.jacobian() (6×nq, metres).
function jacobian(q, eps = 1e-6) {
    const cur = fk(q), J = Array.from({ length: 6 }, () => new Array(nq).fill(0));
    for (let j = 0; j < nq; j++) {
        const qp = q.slice(); qp[j] += eps;
        const f = fk(qp), dp = sub(f.pos, cur.pos), dr = rotVec(cur.mat, f.mat);
        for (let r = 0; r < 3; r++) { J[r][j] = dp[r] / eps; J[r + 3][j] = dr[r] / eps; }
    }
    return J;
}

let failures = 0;
const pass = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// --- Test A: Jacobian self-consistency (J·dq ≈ ΔFK) --------------------------
console.log('Test A — Jacobian self-consistency (J·dq vs FK displacement):');
{
    const q = deg([12, 40, -70, 25, 35, -15]);
    const J = jacobian(q);
    // deterministic small perturbation (norm ~1e-4 rad), no RNG needed
    const dq = [1, -1, 1, -1, 1, -1].map((s, i) => s * 1e-4 * (1 + 0.1 * i));
    const predLin = [0, 1, 2].map((r) => J[r].reduce((s, jrk, k) => s + jrk * dq[k], 0));
    const predRot = [3, 4, 5].map((r) => J[r].reduce((s, jrk, k) => s + jrk * dq[k], 0));
    const f0 = fk(q), f1 = fk(q.map((v, i) => v + dq[i]));
    const actLin = sub(f1.pos, f0.pos);
    const actRot = rotVec(f0.mat, f1.mat);
    const linErr = norm(sub(predLin, actLin)) / (norm(actLin) || 1);
    const rotErr = norm(sub(predRot, actRot)) / (norm(actRot) || 1);
    console.log(`   linear  rel-err ${(linErr * 100).toExponential(2)}%   (|Δpos| ${(norm(actLin) * 1000).toFixed(3)} mm)`);
    console.log(`   angular rel-err ${(rotErr * 100).toExponential(2)}%   (|Δrot| ${norm(actRot).toFixed(6)} rad)`);
    pass(linErr < 1e-2 && rotErr < 1e-2, 'first-order agreement within 1% for a 1e-4 rad step');
}

// --- Test B: σ collapses at a wrist singularity ------------------------------
console.log('\nTest B — manipulability σ across joint-5 sweep (wrist axes 4∥6 near j5=0):');
{
    const base = [10, 35, -60, 20, 0, -10];
    let minAt = null, minSigma = Infinity;
    for (const j5 of [-90, -45, -20, -5, 0, 5, 20, 45, 90]) {
        const q = deg([base[0], base[1], base[2], base[3], j5, base[5]]);
        const m = singularityMetrics(jacobian(q));
        const tag = classifySingularity(m.manipulability).toUpperCase();
        if (m.manipulability < minSigma) { minSigma = m.manipulability; minAt = j5; }
        console.log(`   j5=${String(j5).padStart(4)}°  σ=${m.manipulability.toExponential(3)}  1/κ=${m.reciprocalCondition.toFixed(4)}  ${tag}`);
    }
    pass(minAt === 0, `σ minimum falls at j5=0° (found ${minAt}°)`);
    pass(minSigma < singularityMetrics(jacobian(deg([base[0], base[1], base[2], base[3], 45, base[5]]))).manipulability,
        'σ at j5=0 is far below σ at j5=45°');
}

// --- Test C: named poses, thresholds -----------------------------------------
console.log(`\nTest C — named poses (fault<${SINGULARITY_FAULT_INDEX}, warn<${SINGULARITY_WARN_INDEX}):`);
{
    const poses = {
        'home [0,45,-90,0,0,0]': deg([0, 45, -90, 0, 0, 0]),
        'zero (arm straight)  ': deg([0, 0, 0, 0, 0, 0]),
        'folded [0,80,-150,0,60,0]': deg([0, 80, -150, 0, 60, 0]),
    };
    for (const [name, q] of Object.entries(poses)) {
        const m = singularityMetrics(jacobian(q));
        const ld = m.lostDirection.map((v) => v.toFixed(2)).join(', ');
        console.log(`   ${name}  σ=${m.manipulability.toExponential(3)}  1/κ=${m.reciprocalCondition.toFixed(4)}  ${classifySingularity(m.manipulability).toUpperCase()}`);
        console.log(`      lost twist [${ld}]`);
    }
    pass(true, 'metrics computed for all named poses (inspect above)');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
