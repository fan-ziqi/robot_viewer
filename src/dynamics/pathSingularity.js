/**
 * Scan the straight-line Cartesian path between two flange poses for singularities, joint-velocity
 * saturation, and IK discontinuities — the offline prediction of what the RobCo controller will do
 * with a LIN (cartesian) move.
 *
 * For each sample s∈[0,1] we interpolate the target pose (position lerp, orientation slerp), solve
 * IK seeded from the previous sample (path continuation), and evaluate:
 *   - manipulability σ = √det(J·Jᵀ) and its class (ok/warn/fault) — see singularity.js.
 *   - velocity headroom: the joint speed dq = J⁺·ξ required to hold the commanded Cartesian speed,
 *     vs each axis's dq_abs. The controller time-scales (slows) by 1/max(|dq|/dq_abs); near a
 *     singularity J⁺ blows up → the move stalls. `slowdown` is that speed fraction (1 = full).
 *   - continuity: ‖Δq‖ between samples (a spike = IK branch flip / wrist flip) and joint-limit
 *     clamping (the DLS IK clamps and the TCP drifts off the commanded line).
 *
 * σ is invariant to the tool/TCP offset (a rigid offset is a unit-determinant screw transform on
 * J), so a flange-frame Jacobian gives the controller-identical index. Pure JS — no THREE — so
 * scripts/ can import it headlessly.
 */
import { singularityMetrics, classifySingularity } from './singularity.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));

/** Rotation vector (axis·angle, world frame) of the rotation taking 3×3 A to B (row-major 9). */
function rotVecBetween(A, B) {
    const R = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            R[3 * i + j] = B[3 * i] * A[3 * j] + B[3 * i + 1] * A[3 * j + 1] + B[3 * i + 2] * A[3 * j + 2];
        }
    }
    const tr = R[0] + R[4] + R[8];
    const angle = Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
    const s = Math.sin(angle);
    if (Math.abs(s) < 1e-9) return [0, 0, 0];
    const k = angle / (2 * s);
    return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Row-major 3×3 rotation matrix → quaternion [w,x,y,z]. sqrt args are clamped ≥0 against
 *  floating-point round-off on borderline matrices (a NaN here would poison slerp → IK targets). */
function matToQuat(m) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    const tr = m00 + m11 + m22;
    const rt = (v) => Math.sqrt(Math.max(0, v));
    let w, x, y, z;
    if (tr > 0) { const s = rt(tr + 1) * 2 || 1e-12; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { const s = rt(1 + m00 - m11 - m22) * 2 || 1e-12; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
    else if (m11 > m22) { const s = rt(1 + m11 - m00 - m22) * 2 || 1e-12; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
    else { const s = rt(1 + m22 - m00 - m11) * 2 || 1e-12; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
    return [w, x, y, z];
}

/** Quaternion [w,x,y,z] → row-major 3×3 rotation matrix. */
function quatToMat(q) {
    const [w, x, y, z] = q;
    const n = Math.hypot(w, x, y, z) || 1;
    const W = w / n, X = x / n, Y = y / n, Z = z / n;
    return [
        1 - 2 * (Y * Y + Z * Z), 2 * (X * Y - Z * W), 2 * (X * Z + Y * W),
        2 * (X * Y + Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z - X * W),
        2 * (X * Z - Y * W), 2 * (Y * Z + X * W), 1 - 2 * (X * X + Y * Y),
    ];
}

/** Shortest-path spherical linear interpolation of quaternions [w,x,y,z]. */
function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b.slice();
    if (d < 0) { bb = bb.map((v) => -v); d = -d; }
    if (d > 0.9995) { // near-parallel → normalized lerp
        const r = a.map((v, i) => v + t * (bb[i] - v));
        const n = Math.hypot(...r) || 1;
        return r.map((v) => v / n);
    }
    const theta0 = Math.acos(d);
    const theta = theta0 * t;
    const s0 = Math.sin(theta0 - theta) / Math.sin(theta0);
    const s1 = Math.sin(theta) / Math.sin(theta0);
    return a.map((v, i) => s0 * v + s1 * bb[i]);
}

/** Solve A x = b for small dense symmetric A (Gaussian elimination, partial pivot). null if singular. */
function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-12) return null;
        [M[col], M[piv]] = [M[piv], M[col]];
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col] / M[col][col];
            for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map((row, i) => row[n] / row[i]);
}

/**
 * Minimum-norm joint velocity dq = Jᵀ(J·Jᵀ)⁻¹·ξ to realise Cartesian twist ξ (undamped, so it
 * blows up exactly at a singularity — which is what we want to detect). Returns null if J·Jᵀ is
 * singular (the twist cannot be realised → infinite joint speed).
 */
function requiredJointVelocity(J, twist) {
    const rows = J.length, nq = J[0].length;
    const JJt = Array.from({ length: rows }, (_, a) =>
        Array.from({ length: rows }, (_, b) => {
            let s = 0;
            for (let k = 0; k < nq; k++) s += J[a][k] * J[b][k];
            return s;
        }));
    const y = solveLinear(JJt, twist);
    if (!y) return null;
    const dq = new Array(nq).fill(0);
    for (let c = 0; c < nq; c++) {
        let s = 0;
        for (let a = 0; a < rows; a++) s += J[a][c] * y[a];
        dq[c] = s;
    }
    return dq;
}

/**
 * @param {Object} kin - MujocoKinematics-like: fk(q), jacobian(q), solveIK(pos,mat,seed,opts), nq.
 * @param {{pos:number[], mat:number[]}} startPose - base-frame flange pose (metres, row-major 3×3).
 * @param {{pos:number[], mat:number[]}} endPose
 * @param {Object} [opts]
 * @param {number[]} [opts.seed] - IK seed for the first sample (rad). Default zeros.
 * @param {number} [opts.samples=25] - samples along the path (>=2).
 * @param {number[]} [opts.dqAbs] - per-joint max speed (rad/s) for headroom. Omit to skip headroom.
 * @param {number} [opts.cartVel=0.25] - commanded translational speed (m/s).
 * @param {number} [opts.rotVel=1.0] - commanded rotational speed (rad/s), used for pure reorientation.
 * @param {number[]} [opts.qLower] @param {number[]} [opts.qUpper] - joint limits (rad) for clamp flags.
 * @param {number} [opts.jumpTol=0.35] - ‖Δq‖ (rad) above which a sample is flagged a branch flip.
 * @returns {{samples:Object[], worst:Object, summary:Object}}
 */
export function scanCartesianPath(kin, startPose, endPose, opts = {}) {
    const nSamples = Math.max(2, Math.round(opts.samples ?? 25));
    const seed0 = opts.seed ? opts.seed.slice() : new Array(kin.nq).fill(0);
    const dqAbs = opts.dqAbs || null;
    const cartVel = opts.cartVel ?? 0.25;
    const rotVel = opts.rotVel ?? 1.0;
    const jumpTol = opts.jumpTol ?? 0.35;
    const { qLower, qUpper } = opts;

    const qStart = matToQuat(startPose.mat);
    const qEnd = matToQuat(endPose.mat);

    // Commanded twist ξ is CONSTANT along a straight lerp+slerp path (position is linear, slerp is
    // constant angular velocity), so compute it once. The segment duration is set by whichever axis
    // BINDS — translation at cartVel or rotation at rotVel — matching the controller, which scales
    // both the translational and rotational velocity caps by the same waypoint velocity fraction and
    // runs the slower to completion. (Trapezoidal accel ramp ignored; cruise dominates the estimate.)
    const dPos = sub(endPose.pos, startPose.pos);
    const transLen = norm(dPos);
    const rotVecTotal = rotVecBetween(startPose.mat, endPose.mat);
    const rotLen = norm(rotVecTotal);
    const tTrans = transLen > 1e-9 ? transLen / cartVel : 0;
    const tRot = rotLen > 1e-9 ? rotLen / rotVel : 0;
    const T = Math.max(tTrans, tRot);
    const twist = T > 0
        ? [dPos[0] / T, dPos[1] / T, dPos[2] / T, rotVecTotal[0] / T, rotVecTotal[1] / T, rotVecTotal[2] / T]
        : [0, 0, 0, 0, 0, 0]; // degenerate: start == end

    const samples = [];
    let prevQ = seed0;
    for (let i = 0; i < nSamples; i++) {
        const s = i / (nSamples - 1);
        const pos = startPose.pos.map((v, k) => v + s * dPos[k]);
        const mat = quatToMat(slerp(qStart, qEnd, s));

        const ik = kin.solveIK(pos, mat, prevQ);
        const q = ik.q;
        const J = kin.jacobian(q);
        const metrics = singularityMetrics(J);
        const cls = ik.converged ? classifySingularity(metrics.manipulability, J[0].length) : 'unreachable';

        // Velocity headroom.
        let slowdown = null, dqRatio = null, jointSat = -1;
        if (dqAbs) {
            const dq = requiredJointVelocity(J, twist);
            if (!dq) { slowdown = 0; dqRatio = Infinity; }
            else {
                dqRatio = 0;
                for (let k = 0; k < dq.length; k++) {
                    const r = Math.abs(dq[k]) / (dqAbs[k] || dqAbs[0]);
                    if (r > dqRatio) { dqRatio = r; jointSat = k; }
                }
                slowdown = dqRatio > 0 ? Math.min(1, 1 / dqRatio) : 1;
            }
        }

        const dqJump = i === 0 ? 0 : norm(sub(q, samples[i - 1].q));
        const clamped = qLower && qUpper
            ? q.some((v, k) => v <= qLower[k] + 1e-4 || v >= qUpper[k] - 1e-4)
            : false;

        samples.push({
            s, pos, mat, q,
            converged: ik.converged, posErr: ik.posErr, rotErr: ik.rotErr,
            manipulability: metrics.manipulability,
            reciprocalCondition: metrics.reciprocalCondition,
            sigmaMin: metrics.sigmaMin,
            lostDirection: metrics.lostDirection,
            class: cls,
            slowdown, dqRatio, jointSat,
            dqJump, branchFlip: dqJump > jumpTol, clamped,
        });
        prevQ = q;
    }

    // Worst sample = lowest manipulability (ties broken by lowest slowdown).
    const worst = samples.reduce((w, x) =>
        (x.manipulability < w.manipulability) ? x : w, samples[0]);

    const has = (c) => samples.some((x) => x.class === c);
    const minSlowdown = dqAbs ? samples.reduce((m, x) => Math.min(m, x.slowdown ?? 1), 1) : null;
    const summary = {
        nSamples,
        worstClass: has('unreachable') ? 'unreachable' : has('fault') ? 'fault' : has('warn') ? 'warn' : 'ok',
        minManipulability: worst.manipulability,
        minReciprocalCondition: samples.reduce((m, x) => Math.min(m, x.reciprocalCondition), Infinity),
        minSlowdown,
        maxDqJump: samples.reduce((m, x) => Math.max(m, x.dqJump), 0),
        anyBranchFlip: samples.some((x) => x.branchFlip),
        anyClamped: samples.some((x) => x.clamped),
        anyUnreachable: has('unreachable'),
        transLen, rotLen,
    };

    return { samples, worst, summary };
}
