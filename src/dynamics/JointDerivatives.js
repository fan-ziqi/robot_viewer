/**
 * Estimate joint velocity and acceleration from a position-only stream.
 *
 * RobFlow streams joint *positions* only (no velocity/torque), at ~16 Hz and quantised to
 * 0.01°. We fit a quadratic q(t) ≈ a + b·τ + c·τ² (least squares) over a short sliding window
 * per joint, τ = t − t_latest, and read q̇ = q'(τ), q̈ = q''(τ) = 2c off the fit.
 *
 * WHERE the fit is evaluated matters more than the window width (see scripts/deriv_validate.mjs):
 *   - `centred` (default): evaluate at the window CENTRE. The quadratic's curvature estimates the
 *     acceleration at the middle of the window, so reporting it at the middle time is accurate;
 *     reporting it at the trailing edge (causal) mis-attributes it to "now" and biases q̈ by
 *     20–56 % of peak during real moves. Centring costs a fixed lag of ⌊(window−1)/2⌋ samples
 *     (~120 ms at window 5 / 60 ms), which is acceptable for a torque/current dashboard and free
 *     for offline replay. This is a symmetric-window / fixed-lag (Savitzky-Golay-style) smoother.
 *   - causal (`centred:false`): evaluate at the latest sample (zero lag) — use only when the
 *     readout must be strictly real-time; expect materially higher q̈ error.
 *
 * The reported {position, velocity, acceleration} are ALL at the same instant (the eval point),
 * so a caller can feed them together into inverse dynamics without mixing two time instants.
 *
 * Units are whatever you feed in (use radians + seconds for dynamics). Feed timestamps in
 * milliseconds; they are converted to seconds internally.
 */
export class JointDerivatives {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.windowSize=5] - samples per fit (>=3 enables accel). 5 (±2) minimises
     *   q̈ error for typical robot moves; wider windows fit the curvature worse, not better.
     * @param {number} [opts.minDtMs=1] - ignore samples closer than this in time (raw mode).
     * @param {boolean} [opts.fixedDt=true] - advance a synthetic clock by the measured mean sample
     *   interval instead of using per-sample wall-clock arrival time (which is jittery/batched).
     * @param {number} [opts.fixedDtMs=60] - seed/fallback interval used until the true mean rate is
     *   measured from arrival timestamps (~16.7 Hz).
     * @param {boolean} [opts.centred=true] - evaluate the fit at the window centre (fixed-lag) vs
     *   the trailing edge (causal, zero-lag).
     */
    constructor({ windowSize = 5, minDtMs = 1, fixedDt = true, fixedDtMs = 60, centred = true } = {}) {
        this.windowSize = Math.max(3, windowSize);
        this.minDtMs = minDtMs;
        this.fixedDt = fixedDt;
        this.fixedDtMs = fixedDtMs;
        this.centred = centred;
        this.reset();
    }

    /** Update options live (e.g. from the settings UI). */
    setOptions(opts = {}) {
        if (opts.windowSize !== undefined) this.windowSize = Math.max(3, opts.windowSize);
        if (opts.minDtMs !== undefined) this.minDtMs = opts.minDtMs;
        if (opts.fixedDt !== undefined) this.fixedDt = !!opts.fixedDt;
        if (opts.fixedDtMs !== undefined && opts.fixedDtMs > 0) this.fixedDtMs = opts.fixedDtMs;
        if (opts.centred !== undefined) this.centred = !!opts.centred;
    }

    reset() {
        this._t = []; // ms timestamps (synthetic clock in fixedDt mode)
        this._q = []; // number[][] positions per sample
        this._n = 0; // joint count
        this._clock = 0; // synthetic clock for fixed-Δt mode
        this._prevArrivalMs = null; // last real arrival time, for rate estimation
        this._dtMs = this.fixedDtMs; // measured mean interval (EMA), seeded by the fallback
    }

    /** Fixed-lag latency (ms) the centred estimate trails real time by, at the current rate. */
    get lagMs() {
        const m = Math.min(this._t.length, this.windowSize);
        const lagSamples = this.centred && m > 1 ? (m - 1) - Math.floor((m - 1) / 2) : 0;
        return lagSamples * this._dtMs;
    }

    /**
     * Push a new sample and return smoothed position/velocity/acceleration at the eval point.
     * @param {number[]} positions - joint positions (radians recommended).
     * @param {number} [tMs=performance.now()] - sample timestamp in ms.
     * @returns {{position:number[], velocity:number[], acceleration:number[]}}
     */
    update(positions, tMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
        if (this._n !== positions.length) {
            // joint count changed (robot rebuilt) -> restart the window
            this.reset();
            this._n = positions.length;
        }
        // Track the true mean sample interval from arrival timestamps (jitter-robust EMA) so the
        // fixed-Δt clock advances at the ACTUAL stream rate, not a hard-coded guess — this removes
        // the systematic velocity/accel bias that appears when the real rate ≠ fixedDtMs.
        if (Number.isFinite(tMs) && this._prevArrivalMs != null) {
            const raw = tMs - this._prevArrivalMs;
            if (raw >= 3 && raw <= 1000) this._dtMs += 0.15 * (raw - this._dtMs);
        }
        if (Number.isFinite(tMs)) this._prevArrivalMs = tMs;

        if (this.fixedDt) {
            // Advance the synthetic clock by the measured mean interval; removes network/event-loop
            // jitter while tracking the true rate.
            this._clock += this._dtMs;
            this._t.push(this._clock);
            this._q.push(positions.slice());
        } else {
            const last = this._t[this._t.length - 1];
            if (last !== undefined && tMs - last < this.minDtMs) {
                // too close in time (batched); just refresh the latest sample
                this._q[this._q.length - 1] = positions.slice();
                this._t[this._t.length - 1] = tMs;
            } else {
                this._t.push(tMs);
                this._q.push(positions.slice());
            }
        }
        while (this._t.length > this.windowSize) {
            this._t.shift();
            this._q.shift();
        }
        return this._fit(positions);
    }

    /** @private */
    _fit(latest) {
        const n = this._n;
        const m = this._t.length;
        const position = latest.slice();
        const velocity = new Array(n).fill(0);
        const acceleration = new Array(n).fill(0);
        if (m < 2) return { position, velocity, acceleration };

        const tLast = this._t[m - 1];
        const tau = this._t.map((t) => (t - tLast) / 1000); // seconds, <= 0
        // Evaluation point: window centre (centred/fixed-lag) or the latest sample (causal, τ=0).
        const centreIdx = this.centred ? Math.floor((m - 1) / 2) : m - 1;
        const te = tau[centreIdx]; // eval τ (seconds, <= 0)

        if (m === 2) {
            // first-order only
            const dt = tau[1] - tau[0];
            if (dt !== 0) {
                for (let j = 0; j < n; j++) {
                    const b = (this._q[1][j] - this._q[0][j]) / dt;
                    velocity[j] = b;
                    position[j] = this._q[m - 1][j] + b * te; // linear value at the eval point
                }
            }
            return { position, velocity, acceleration };
        }

        // Quadratic least squares: normal-equation sums (shared across joints).
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
        for (let i = 0; i < m; i++) {
            const t = tau[i], t2 = t * t;
            s0 += 1; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
        }
        for (let j = 0; j < n; j++) {
            let b0 = 0, b1 = 0, b2 = 0;
            for (let i = 0; i < m; i++) {
                const q = this._q[i][j], t = tau[i];
                b0 += q; b1 += q * t; b2 += q * t * t;
            }
            const coef = solve3(
                [s0, s1, s2, s1, s2, s3, s2, s3, s4],
                [b0, b1, b2],
            );
            if (coef) {
                const [a, b, c] = coef;
                // Evaluate the fit and its derivatives at the eval point te (centre or edge).
                position[j] = a + b * te + c * te * te; // q(te)
                velocity[j] = b + 2 * c * te; // q'(te)
                acceleration[j] = 2 * c; // q''(te) — constant for a quadratic
            }
        }
        return { position, velocity, acceleration };
    }
}

/**
 * Solve a 3x3 linear system A x = b (A row-major length 9) via Cramer's rule.
 * @returns {number[]|null} x, or null if singular.
 */
function solve3(A, b) {
    const [a, c, d, e, f, g, h, i, k] = A;
    const det =
        a * (f * k - g * i) - c * (e * k - g * h) + d * (e * i - f * h);
    if (Math.abs(det) < 1e-12) return null;
    const dx =
        b[0] * (f * k - g * i) - c * (b[1] * k - g * b[2]) + d * (b[1] * i - f * b[2]);
    const dy =
        a * (b[1] * k - g * b[2]) - b[0] * (e * k - g * h) + d * (e * b[2] - b[1] * h);
    const dz =
        a * (f * b[2] - b[1] * i) - c * (e * b[2] - b[1] * h) + b[0] * (e * i - f * h);
    return [dx / det, dy / det, dz / det];
}
