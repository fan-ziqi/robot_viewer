/**
 * Forward kinematics + damped-least-squares inverse kinematics for a RobCo arm, via MuJoCo.
 *
 * Builds the same dynamics MJCF (with a "tcp" site at the flange), then:
 *   - fk(q)       -> TCP world pose (position + 3x3 rotation, row-major)
 *   - solveIK()   -> joint angles that put the TCP at a target pose
 *
 * The Jacobian is computed numerically from FK (6 extra FK evals per iteration) — robust and
 * avoids marshalling MuJoCo's mj_jacSite output buffers. Cheap for a 6-DOF arm.
 *
 * All radians / metres. Validated headless in scripts/ik_validate.mjs.
 */
import { mjcfFromModules } from './mjcfFromModules.js';
import { ROBCO_AXIS_LIMIT_RAD } from '../robco/robcoLimits.js';

const DRIVE_TYPES = new Set(['Drive', 'BaseDrive']);

export class MujocoKinematics {
    static async create(descriptors, opts = {}) {
        const loadMujoco = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
        const mj = await loadMujoco();
        return new MujocoKinematics(mj, descriptors, opts);
    }

    constructor(mj, descriptors, opts = {}) {
        this.mj = mj;
        const drives = descriptors.filter((d) => DRIVE_TYPES.has(d['module-type']));
        // RobCo axes all travel ±270° (see robcoLimits.js); clamp IK to the same on every axis.
        this.qLower = drives.map(() => -ROBCO_AXIS_LIMIT_RAD);
        this.qUpper = drives.map(() => ROBCO_AXIS_LIMIT_RAD);
        try { mj.FS.mkdir('/working'); } catch { /* exists */ }
        try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch { /* mounted */ }

        const { xml, jointNames } = mjcfFromModules(descriptors, { ...opts, tcpSite: true });
        this.jointNames = jointNames;
        this.nq = jointNames.length;
        mj.FS.writeFile('/working/robco_kin.xml', xml);
        this.model = mj.MjModel.loadFromXML('/working/robco_kin.xml');
        this.data = new mj.MjData(this.model);
        const SITE = mj.mjtObj?.mjOBJ_SITE?.value ?? 6;
        this.siteId = mj.mj_name2id(this.model, SITE, 'tcp');
    }

    /** Forward kinematics: TCP world pose for joint angles q. */
    fk(q) {
        const { mj, model, data, nq, siteId } = this;
        for (let i = 0; i < nq; i++) data.qpos[i] = q[i] ?? 0;
        mj.mj_fwdPosition(model, data);
        const p = siteId * 3;
        const m = siteId * 9;
        return {
            pos: [data.site_xpos[p], data.site_xpos[p + 1], data.site_xpos[p + 2]],
            mat: Array.from({ length: 9 }, (_, k) => data.site_xmat[m + k]),
        };
    }

    /**
     * Numerical geometric Jacobian at joint angles q — a 6×nq matrix (array of 6 rows). Rows 0-2
     * are TCP linear velocity per joint (m/rad), rows 3-5 angular velocity (rad/rad), world frame.
     * Same forward-difference scheme as solveIK. Translation is in METRES so the value is directly
     * comparable to the controller's singularity index (√det(J·Jᵀ) < 0.005 faults).
     * @param {number[]} q - joint angles (rad).
     * @param {number} [eps=1e-6] - finite-difference step (rad).
     * @returns {number[][]} 6×nq Jacobian (row-major rows).
     */
    jacobian(q, eps = 1e-6) {
        const cur = this.fk(q);
        const J = Array.from({ length: 6 }, () => new Array(this.nq).fill(0));
        for (let j = 0; j < this.nq; j++) {
            const qp = q.slice();
            qp[j] += eps;
            const f = this.fk(qp);
            const dp = sub(f.pos, cur.pos);
            const dr = rotVecBetween(cur.mat, f.mat);
            for (let r = 0; r < 3; r++) { J[r][j] = dp[r] / eps; J[r + 3][j] = dr[r] / eps; }
        }
        return J;
    }

    /**
     * Solve IK for a target TCP pose.
     * @param {number[]} targetPos
     * @param {number[]|null} targetMat - target 3x3 (row-major). null => position-only.
     * @param {number[]} q0 - seed joint angles.
     * @param {Object} [opts]
     * @returns {{q:number[], converged:boolean, iters:number, posErr:number, rotErr:number}}
     */
    solveIK(targetPos, targetMat, q0, opts = {}) {
        const maxIters = opts.maxIters ?? 100;
        const lambda = opts.lambda ?? 0.08;
        const maxStep = opts.maxStep ?? 0.25;
        const posTol = opts.posTol ?? 1e-3;
        const rotTol = opts.rotTol ?? 5e-3;
        const useRot = !!targetMat;
        const rows = useRot ? 6 : 3;

        let q = q0.slice();
        let posErr = Infinity, rotErr = 0;

        for (var iter = 0; iter < maxIters; iter++) {
            const cur = this.fk(q);
            const ePos = sub(targetPos, cur.pos);
            posErr = norm(ePos);
            let err = ePos.slice();
            if (useRot) {
                const eRot = rotVecBetween(cur.mat, targetMat);
                rotErr = norm(eRot);
                err = ePos.concat(eRot);
            }
            if (posErr < posTol && (!useRot || rotErr < rotTol)) break;

            // Numerical Jacobian (rows x nq).
            const eps = 1e-6;
            const J = Array.from({ length: rows }, () => new Array(this.nq).fill(0));
            for (let j = 0; j < this.nq; j++) {
                const qp = q.slice();
                qp[j] += eps;
                const f = this.fk(qp);
                const dp = sub(f.pos, cur.pos);
                J[0][j] = dp[0] / eps; J[1][j] = dp[1] / eps; J[2][j] = dp[2] / eps;
                if (useRot) {
                    const dr = rotVecBetween(cur.mat, f.mat);
                    J[3][j] = dr[0] / eps; J[4][j] = dr[1] / eps; J[5][j] = dr[2] / eps;
                }
            }

            // Damped least squares: dq = Jᵀ (J Jᵀ + λ²I)⁻¹ err
            const JJt = Array.from({ length: rows }, (_, a) =>
                Array.from({ length: rows }, (_, b) => {
                    let s = 0;
                    for (let c = 0; c < this.nq; c++) s += J[a][c] * J[b][c];
                    return s + (a === b ? lambda * lambda : 0);
                }),
            );
            const y = solveLinear(JJt, err);
            if (!y) break;
            const dq = new Array(this.nq).fill(0);
            for (let c = 0; c < this.nq; c++) {
                let s = 0;
                for (let a = 0; a < rows; a++) s += J[a][c] * y[a];
                dq[c] = s;
            }

            // Clamp step size, apply, clamp to joint limits.
            const stepNorm = norm(dq);
            const scale = stepNorm > maxStep ? maxStep / stepNorm : 1;
            for (let c = 0; c < this.nq; c++) {
                q[c] = clamp(q[c] + dq[c] * scale, this.qLower[c], this.qUpper[c]);
            }
        }

        return { q, converged: posErr < posTol && (!useRot || rotErr < rotTol), iters: iter, posErr, rotErr };
    }

    dispose() {
        this.data?.delete?.();
        this.model?.delete?.();
    }
}

// --- small linear algebra ---------------------------------------------------
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Rotation vector (axis*angle) taking rotation matrix A to B (both row-major 3x3). */
function rotVecBetween(A, B) {
    // R = B * Aᵀ ; with row-major, R[i][j] = dot(row i of B, row j of A)
    const R = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            R[3 * i + j] = B[3 * i] * A[3 * j] + B[3 * i + 1] * A[3 * j + 1] + B[3 * i + 2] * A[3 * j + 2];
        }
    }
    const tr = R[0] + R[4] + R[8];
    const angle = Math.acos(clamp((tr - 1) / 2, -1, 1));
    const axis = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
    const s = Math.sin(angle);
    if (Math.abs(s) < 1e-9) return [0, 0, 0];
    const k = angle / (2 * s);
    return [axis[0] * k, axis[1] * k, axis[2] * k];
}

/** Solve A x = b for small dense A (Gaussian elimination with partial pivoting). */
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
