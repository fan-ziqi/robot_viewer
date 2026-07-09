// Validate the Cartesian path-scan analyzer on the real arm via mujoco-js (Node, headless).
//
// Scans the straight LIN path between two wrist-flipped poses (joint 5: +45° → −45°). The straight
// Cartesian line between them passes through the wrist singularity, so we expect: manipulability σ
// to dip in the path INTERIOR, the predicted slowdown to drop below 1 (joint speed saturates), and
// likely a warn/fault classification mid-path. Imports the REAL analyzer from src/dynamics.
import { readFileSync } from 'node:fs';
import { scanCartesianPath } from '../src/dynamics/pathSingularity.js';
import { ROBCO_AXIS_LIMIT_RAD } from '../src/robco/robcoLimits.js';

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
function jacobian(q, eps = 1e-6) { const cur = fk(q), J = Array.from({ length: 6 }, () => new Array(nq).fill(0)); for (let j = 0; j < nq; j++) { const qp = q.slice(); qp[j] += eps; const f = fk(qp), dp = sub(f.pos, cur.pos), dr = rotVec(cur.mat, f.mat); for (let r = 0; r < 3; r++) { J[r][j] = dp[r] / eps; J[r + 3][j] = dr[r] / eps; } } return J; }
function solveLin(A, b) { const n = b.length, M = A.map((r, i) => r.concat(b[i])); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) return null;[M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } } return M.map((r, i) => r[n] / r[i]); }
function solveIK(tPos, tMat, q0, opts = {}) {
    const lambda = 0.08, maxStep = 0.25, rows = 6, lo = -ROBCO_AXIS_LIMIT_RAD, hi = ROBCO_AXIS_LIMIT_RAD;
    let q = q0.slice(), pe = Infinity, re = 0, iter = 0;
    for (; iter < 100; iter++) {
        const cur = fk(q), ePos = sub(tPos, cur.pos), eRot = rotVec(cur.mat, tMat); pe = norm(ePos); re = norm(eRot);
        if (pe < 1e-3 && re < 5e-3) break;
        const err = ePos.concat(eRot), eps = 1e-6, J = Array.from({ length: rows }, () => new Array(nq).fill(0));
        for (let j = 0; j < nq; j++) { const qp = q.slice(); qp[j] += eps; const f = fk(qp), dp = sub(f.pos, cur.pos), dr = rotVec(cur.mat, f.mat); for (let r = 0; r < 3; r++) { J[r][j] = dp[r] / eps; J[r + 3][j] = dr[r] / eps; } }
        const JJt = Array.from({ length: rows }, (_, a) => Array.from({ length: rows }, (_, b) => { let s = 0; for (let c = 0; c < nq; c++) s += J[a][c] * J[b][c]; return s + (a === b ? lambda * lambda : 0); }));
        const y = solveLin(JJt, err); if (!y) break;
        const dq = new Array(nq).fill(0); for (let c = 0; c < nq; c++) { let s = 0; for (let a = 0; a < rows; a++) s += J[a][c] * y[a]; dq[c] = s; }
        const sn = norm(dq), sc = sn > maxStep ? maxStep / sn : 1; for (let c = 0; c < nq; c++) q[c] = clamp(q[c] + dq[c] * sc, lo, hi);
    }
    return { q, converged: pe < 1e-3 && re < 5e-3, iters: iter, posErr: pe, rotErr: re };
}

const kin = { nq, fk, jacobian, solveIK };
// Per-axis velocity limit from each drive descriptor (same extraction MujocoKinematics.dqAbs uses).
const dqAbs = descs.filter((d) => DRIVE.has(d['module-type']))
    .map((d) => { const v = d.module_properties?.max_velocity; return Number.isFinite(v) && v > 0 ? v : 6.28; });
console.log(`per-axis dq_abs (rad/s) from descriptors: [${dqAbs.map((v) => v.toFixed(2)).join(', ')}]`);
const limits = {
    qLower: new Array(nq).fill(-ROBCO_AXIS_LIMIT_RAD),
    qUpper: new Array(nq).fill(ROBCO_AXIS_LIMIT_RAD),
};

function runScan(label, start, end, seed) {
    const res = scanCartesianPath(kin, start, end, { seed, samples: 21, dqAbs, cartVel: 0.25, ...limits });
    const { samples, worst, summary } = res;
    console.log(`\n${label}`);
    console.log(`  segment: ${(summary.transLen * 1000).toFixed(1)} mm translation, ${(summary.rotLen * 180 / Math.PI).toFixed(1)}° rotation`);
    console.log('    s     σ         1/κ     slow%   satJ   Δq     class');
    for (const x of samples) {
        console.log(
            `  ${x.s.toFixed(2)}  ${x.manipulability.toExponential(2)}  ${x.reciprocalCondition.toFixed(4)}  ` +
            `${x.slowdown != null ? (x.slowdown * 100).toFixed(0).padStart(4) : '  --'}   ` +
            `${String(x.jointSat).padStart(3)}   ${x.dqJump.toFixed(3)}  ${x.class}${x.branchFlip ? ' FLIP' : ''}${x.clamped ? ' CLAMP' : ''}`,
        );
    }
    console.log(`  worst @ s=${worst.s.toFixed(2)}: σ=${worst.manipulability.toExponential(3)}, class=${worst.class}; ` +
        `minSlow ${(summary.minSlowdown * 100).toFixed(0)}%, maxΔq ${summary.maxDqJump.toFixed(3)}, worstClass ${summary.worstClass}`);
    return res;
}

let failures = 0;
const pass = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// Path 1 (graze): wrist-flip j5 +45°→−45° — the straight line passes near the wrist singularity.
const qA = deg([10, 35, -60, 20, 45, -10]);
const qB = deg([10, 35, -60, 20, -45, -10]);
const p1 = runScan('Path 1 — wrist-flip LIN (j5 +45°→−45°):', fk(qA), fk(qB), qA);
console.log('\nPath 1 checks (grazes the singularity):');
pass(p1.worst.s > 0 && p1.worst.s < 1, `worst sample in the interior (s=${p1.worst.s.toFixed(2)})`);
pass(p1.worst.manipulability < p1.samples[0].manipulability && p1.worst.manipulability < p1.samples[20].manipulability,
    'σ dips below both endpoints');
pass(p1.summary.minSlowdown < 1, `velocity headroom saturates (min slowdown ${(p1.summary.minSlowdown * 100).toFixed(0)}%)`);
pass(p1.summary.anyBranchFlip, 'the wrist flip is detected as a Δq spike');

// Path 2 (deep): healthy → the fully-extended straight-up pose (q=0), a BOUNDARY singularity that
// is branch-independent (every IK solution is near-singular at max reach), so the scan MUST flag it.
// (Contrast: a wrist-only singular *pose* like home can be reached on a healthy branch — see Path 1.)
const qHealthy = deg([0, 45, -90, 0, 45, 0]);
const qStraight = deg([0, 0, 0, 0, 0, 0]);
const p2 = runScan('Path 2 — LIN into the fully-extended (boundary-singular) pose:', fk(qHealthy), fk(qStraight), qHealthy);
console.log('\nPath 2 checks (ends at a boundary singularity):');
pass(p2.summary.worstClass !== 'ok', `scan flags the singular endpoint (worstClass '${p2.summary.worstClass}')`);
pass(p2.worst.manipulability < 0.01, `σ reaches the warn/fault band (min σ ${p2.worst.manipulability.toExponential(2)})`);
pass(p2.samples[20].manipulability < p2.samples[0].manipulability, 'σ ramps down toward the singular end');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
