/**
 * Singularity metrics for a manipulator Jacobian — mirrors the RobCo controller's model so the
 * viewer's warnings predict real robot behaviour.
 *
 * The controller (robcontrol, RobotModel::is_close_to_singularity) uses the Yoshikawa
 * manipulability index σ = √det(J·Jᵀ) and faults a Cartesian move when σ < 0.005; its DLS IK
 * already ramps up damping and ramps path-tracking gain toward zero below ~0.01. We reproduce the
 * same index and the same two thresholds here. For a square 6×6 arm σ = |det J|; for a redundant
 * (>6 DOF) arm σ = √det(J·Jᵀ); for <6 DOF σ = √det(Jᵀ·J) (the controller's convention).
 *
 * IMPORTANT: J must carry translation rows in METRES (rad in the angular rows) for the 0.005
 * threshold to mean anything — MujocoKinematics.jacobian() already returns metre units.
 *
 * Pure JS, no dependencies, so scripts/ can import it headlessly.
 */

/** Controller singularity index below which a Cartesian move FAULTS (gbl_prop::singularity_index_limit). */
export const SINGULARITY_FAULT_INDEX = 0.005;
/** Index below which the controller's DLS heavily damps / degrades path tracking (IK epsilon). */
export const SINGULARITY_WARN_INDEX = 0.01;

/**
 * Eigen-decomposition of a small real SYMMETRIC matrix via cyclic Jacobi rotations.
 * @param {number[][]} Ain - symmetric n×n matrix (nested rows); not mutated.
 * @param {number} [maxSweeps=60]
 * @returns {{values:number[], vectors:number[][]}} eigenvalues and eigenvectors, sorted DESCENDING
 *   by eigenvalue. `vectors[i]` is the (unit) eigenvector for `values[i]`.
 */
export function jacobiEigenSymmetric(Ain, maxSweeps = 60) {
    const n = Ain.length;
    const A = Ain.map((r) => r.slice());
    // V accumulates the rotations; its columns become the eigenvectors.
    const V = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
        if (off < 1e-30) break;

        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = A[p][q];
                if (Math.abs(apq) < 1e-300) continue;
                // Angle that zeroes A[p][q]:  tan(2θ) = 2·apq / (aqq − app).
                const phi = 0.5 * Math.atan2(2 * apq, A[q][q] - A[p][p]);
                const c = Math.cos(phi), s = Math.sin(phi);
                // A ← Gᵀ A G  with G the Givens rotation [[c,s],[-s,c]] in the (p,q) plane.
                for (let k = 0; k < n; k++) {
                    const akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk;
                    A[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }

    const raw = A.map((row, i) => row[i]);
    const order = raw.map((_, i) => i).sort((a, b) => raw[b] - raw[a]);
    return {
        values: order.map((i) => raw[i]),
        vectors: order.map((i) => V.map((row) => row[i])),
    };
}

/** Gram matrix J·Jᵀ (rows×rows, symmetric). */
function gramJJt(J) {
    const rows = J.length, n = J[0].length;
    const A = Array.from({ length: rows }, () => new Array(rows).fill(0));
    for (let a = 0; a < rows; a++) {
        for (let b = a; b < rows; b++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += J[a][k] * J[b][k];
            A[a][b] = s; A[b][a] = s;
        }
    }
    return A;
}

/** Gram matrix Jᵀ·J (n×n, symmetric). */
function gramJtJ(J) {
    const rows = J.length, n = J[0].length;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
            let s = 0;
            for (let k = 0; k < rows; k++) s += J[k][a] * J[k][b];
            A[a][b] = s; A[b][a] = s;
        }
    }
    return A;
}

/**
 * Compute singularity metrics for a Jacobian.
 * @param {number[][]} J - a rows×nq Jacobian (typically 6×nq), translation rows in metres.
 * @returns {{
 *   manipulability:number,       // σ = √det(gram) — the controller's index (|det J| when square)
 *   sigmaMin:number,             // smallest singular value (distance to singularity)
 *   sigmaMax:number,             // largest singular value
 *   reciprocalCondition:number,  // σ_min/σ_max ∈ [0,1] — normalized "health" (1 = isotropic)
 *   singularValues:number[],     // all singular values, descending
 *   lostDirection:number[],      // 6-vector twist [vx,vy,vz,wx,wy,wz] the arm moves LEAST along
 * }}
 */
export function singularityMetrics(J) {
    const rows = J.length;
    const nq = J[0].length;
    // Use the smaller Gram matrix so every returned singular value is meaningful (an under-DOF arm
    // would otherwise show spurious zero singular values from JJᵀ's rank deficiency).
    const useJJt = nq >= rows;
    const gram = useJJt ? gramJJt(J) : gramJtJ(J);
    const { values, vectors } = jacobiEigenSymmetric(gram);

    // Gram eigenvalues are the squared singular values (clamp roundoff negatives).
    const singularValues = values.map((v) => Math.sqrt(Math.max(0, v)));
    const sigmaMax = singularValues[0] || 0;
    const sigmaMin = singularValues[singularValues.length - 1] || 0;
    const manipulability = singularValues.reduce((p, v) => p * v, 1);
    const reciprocalCondition = sigmaMax > 0 ? sigmaMin / sigmaMax : 0;

    // Lost direction lives in Cartesian twist space → smallest-eigenvalue eigenvector of J·Jᵀ.
    let twist = useJJt ? { values, vectors } : jacobiEigenSymmetric(gramJJt(J));
    const lostDirection = twist.vectors[twist.vectors.length - 1];

    return { manipulability, sigmaMin, sigmaMax, reciprocalCondition, singularValues, lostDirection };
}

/**
 * Classify a manipulability index against the controller thresholds.
 * @param {number} manipulability - σ from {@link singularityMetrics}.
 * @returns {'ok'|'warn'|'fault'} 'fault' = controller stops the move; 'warn' = degraded tracking.
 */
export function classifySingularity(manipulability) {
    if (manipulability < SINGULARITY_FAULT_INDEX) return 'fault';
    if (manipulability < SINGULARITY_WARN_INDEX) return 'warn';
    return 'ok';
}
