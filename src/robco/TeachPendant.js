/**
 * Teach pendant gizmo engine: a draggable TCP handle driven by inverse kinematics.
 *
 * Drag/rotate the handle -> the target world pose is mapped into the robot/MuJoCo frame via
 * the model root -> full 6-DOF DLS IK (MujocoKinematics) -> joint angles applied so the arm
 * follows. UI (buttons, send, status) lives in RobFlowToolsPanel, which drives this engine.
 *
 * Combined gizmo: translate arrows + rotate rings shown together via a custom single-raycaster
 * gizmo (see TcpGizmo) — one gesture = one handle, so translate and rotate never fire together.
 * The Move/Rotate toggles (or W/E keys) hide either set; at least one always stays live. While
 * enabled it sets app._teachActive so the live WS mirror pauses (no fight with drags).
 */
import * as THREE from 'three';
import { TcpGizmo } from './TcpGizmo.js';
import { get as gizmoGet, set as gizmoSet } from './gizmoSettings.js';
import { MujocoKinematics } from '../dynamics/MujocoKinematics.js';
import { ROBCO_AXIS_LIMIT_DEG } from './robcoLimits.js';
import { registerManipulator, activateManipulator } from './manipulators.js';

// Pose enumeration: how many seeds to try, when two solutions count as the same
// configuration, how many to surface, and how many solves to run per animation frame.
const FIND_SAMPLES = 48;        // random seeds (bumped for redundant arms — see buildSeeds)
const FIND_DEDUP_TOL_DEG = 2.0; // max per-joint diff below which two solutions are one config
const FIND_MAX_RESULTS = 12;
const FIND_CHUNK = 8;           // solves per frame in the async (UI) path

/** Smallest signed angular gap a→b (degrees), folded into (−180, 180]. */
function angDiffDeg(a, b, wrapAware = true) {
    let d = a - b;
    if (wrapAware) d = ((d + 180) % 360 + 360) % 360 - 180;
    return Math.abs(d);
}

/** Largest absolute joint angle in a vector (worst axis, for limit-margin colouring). */
function maxAbs(arr) {
    return arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}

/** Deterministic PRNG so the same TCP yields the same seed set (stable list between clicks). */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function quatToRowMajor(q) {
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}
function rowMajorToQuat(m) {
    const M = new THREE.Matrix4().set(
        m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1,
    );
    return new THREE.Quaternion().setFromRotationMatrix(M);
}

export class TeachPendant {
    static async attach(app, model, opts = {}) {
        const nodes = model.userData?.moduleNodes || [];
        const descriptors = nodes.map((n) => n.descriptor).filter(Boolean);
        const jointOrder = model.userData?.jointOrder || [];
        if (jointOrder.length === 0) return null;
        const kin = await MujocoKinematics.create(descriptors, opts);
        return new TeachPendant(app, model, kin);
    }

    constructor(app, model, kin) {
        this.app = app;
        this.model = model;
        this.kin = kin;
        this.sm = app.sceneManager;
        this.jointNames = model.userData.jointOrder;
        this.enabled = false;
        this.onIk = null; // (res) => void
        this.toolOffset = null; // Matrix4 flange→tool-tip when a tool defines the TCP, else null

        this.target = new THREE.Object3D();
        this._setTargetToTcp();
        this.sm.scene.add(this.target);

        // Combined translate+rotate gizmo (custom, single raycaster — see TcpGizmo). 'change'
        // fires once per transform → run IK; the gizmo disables OrbitControls itself while a
        // handle is hovered/dragged, and repaints through the on-demand redraw.
        this.gizmo = new TcpGizmo({
            camera: this.sm.camera,
            domElement: this.sm.renderer.domElement,
            orbit: this.sm.controls,
            redraw: () => this.sm.redraw?.(),
        });
        this.gizmo.attach(this.target);
        this.gizmo.addEventListener('change', () => this._onDrag());
        this.sm.scene.add(this.gizmo);

        this._onKey = (e) => {
            if (!this.enabled) return;
            // W/E toggle the handle sets through the shared Gizmo settings, so the Gizmo panel and
            // every gizmo stay in sync.
            if (e.key === 'w' || e.key === 'W') gizmoSet({ showTranslate: !gizmoGet().showTranslate });
            else if (e.key === 'e' || e.key === 'E') gizmoSet({ showRotate: !gizmoGet().showRotate });
        };

        // Arbiter: another manipulator activating turns this gizmo off.
        registerManipulator('teach', () => { if (this.enabled) this.setEnabled(false); });
    }

    _currentQ() {
        return this.jointNames.map((n) => this.model.joints.get(n)?.currentValue ?? 0);
    }

    /** Current previewed joint angles in degrees (what Send would transmit). */
    currentAnglesDeg() {
        return this._currentQ().map((r) => (r * 180) / Math.PI);
    }

    /**
     * Define the TCP as a tool tip offset from the flange (Matrix4) or clear it (null).
     * When set, the gizmo, captured waypoints, and IK targets are all at the tool tip.
     */
    setToolOffset(m4) {
        this.toolOffset = m4 ? m4.clone() : null;
        this.syncTcp();
        this.sm.redraw?.();
    }

    _tipFromFlange(flangeM4) {
        return this.toolOffset ? flangeM4.clone().multiply(this.toolOffset) : flangeM4;
    }

    _flangeFromTip(tipM4) {
        return this.toolOffset ? tipM4.clone().multiply(this.toolOffset.clone().invert()) : tipM4;
    }

    _tcpPose() {
        const baseM = this.tcpBaseMatrix(); // flange, or tool tip when a tool offset is set
        this.model.threeObject.updateMatrixWorld(true);
        const pos = new THREE.Vector3().setFromMatrixPosition(baseM);
        const quat = new THREE.Quaternion().setFromRotationMatrix(baseM);
        const position = this.model.threeObject.localToWorld(pos);
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        return { position, quaternion: qRoot.multiply(quat) };
    }

    _setTargetToTcp() {
        const pose = this._tcpPose();
        this.target.position.copy(pose.position);
        this.target.quaternion.copy(pose.quaternion);
    }

    _applyQ(q) {
        this.jointNames.forEach((n, i) => {
            const j = this.model.joints.get(n);
            if (!j) return;
            j.currentValue = q[i];
            j.threeObject?.setJointValue?.(q[i]);
        });
    }

    _onDrag() {
        if (!this.enabled) return;
        this.model.threeObject.updateMatrixWorld(true);
        const local = this.model.threeObject.worldToLocal(this.target.position.clone());
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        const qTarget = this.target.getWorldQuaternion(new THREE.Quaternion());
        // Target is the tool tip (base frame); convert to the flange the IK actually solves for.
        const tipBase = new THREE.Matrix4().compose(local, qRoot.conjugate().multiply(qTarget), new THREE.Vector3(1, 1, 1));
        const flangeBase = this._flangeFromTip(tipBase);
        const fpos = new THREE.Vector3().setFromMatrixPosition(flangeBase);
        const fquat = new THREE.Quaternion().setFromRotationMatrix(flangeBase);
        const res = this.kin.solveIK([fpos.x, fpos.y, fpos.z], quatToRowMajor(fquat), this._currentQ());
        this._applyQ(res.q);
        this.onIk?.(res);
        this.onPose?.(this.currentAnglesDeg()); // let the dynamics panel recompute for the new pose
    }

    /** Re-snap the gizmo to the current TCP (call from the live mirror when not teaching). */
    syncTcp() {
        if (!this.enabled) this._setTargetToTcp();
    }

    /** Current TCP pose (flange, or tool tip when a tool offset is set) in the base frame. */
    tcpBaseMatrix() {
        const fk = this.kin.fk(this._currentQ());
        const flange = new THREE.Matrix4().compose(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
            rowMajorToQuat(fk.mat),
            new THREE.Vector3(1, 1, 1),
        );
        return this._tipFromFlange(flange);
    }

    /**
     * Forward kinematics for arbitrary joint angles (degrees) → base-frame TCP matrix. Same frame
     * as tcpBaseMatrix (tool tip when a tool offset is set). Used to place markers for joint
     * waypoints loaded from a flow without disturbing the live pose.
     */
    fkBaseMatrix(anglesDeg) {
        const fk = this.kin.fk((anglesDeg || []).map((d) => (d * Math.PI) / 180));
        const flange = new THREE.Matrix4().compose(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
            rowMajorToQuat(fk.mat),
            new THREE.Vector3(1, 1, 1),
        );
        return this._tipFromFlange(flange);
    }

    // A base-frame target matrix refers to the TCP (tool tip); the IK solves for the flange.
    _solveTip(m4, seedDeg) {
        const flange = this._flangeFromTip(m4);
        const pos = new THREE.Vector3().setFromMatrixPosition(flange);
        const q = new THREE.Quaternion().setFromRotationMatrix(flange);
        const seed = seedDeg && seedDeg.length ? seedDeg.map((d) => (d * Math.PI) / 180) : this._currentQ();
        return this.kin.solveIK([pos.x, pos.y, pos.z], quatToRowMajor(q), seed);
    }

    /** Solve IK to a base-frame target matrix and apply it (preview). Returns the IK result. */
    goToBaseMatrix(m4, seedDeg) {
        const res = this._solveTip(m4, seedDeg);
        this._applyQ(res.q);
        this.onPose?.(this.currentAnglesDeg());
        this.syncTcp();
        return res;
    }

    /**
     * Test reachability of a base-frame target matrix without moving the arm. Tries the captured
     * seed first (fast path), then a few spread seeds so a poor seed after a large base move
     * doesn't flag a genuinely reachable pose as unreachable.
     */
    checkReachable(m4, seedDeg) {
        if (this._solveTip(m4, seedDeg).converged) return true;
        for (const alt of this._altSeeds()) {
            if (this._solveTip(m4, alt).converged) return true;
        }
        return false;
    }

    /** A small spread of fallback IK seeds (degrees) for the reachability retry. */
    _altSeeds() {
        return this._structuredSeeds();
    }

    /**
     * Deterministic IK seeds (degrees) covering the canonical branch structure: the current pose,
     * home, two coarse spreads, single-joint sign flips of the current pose, and a last-joint
     * (wrist) pre-flip. These are where alternate-branch IK basins (elbow up/down, wrist flip)
     * tend to cluster. Shared by reachability retries and pose enumeration.
     */
    _structuredSeeds() {
        const n = this.jointNames.length;
        const cur = this.currentAnglesDeg();
        const seeds = [
            cur,                                                      // current pose
            new Array(n).fill(0),                                     // home
            Array.from({ length: n }, (_, i) => (i % 2 ? 90 : -90)),  // spread A
            Array.from({ length: n }, (_, i) => (i % 2 ? -120 : 60)), // spread B
        ];
        // Single-joint sign flips of the current pose.
        for (let j = 0; j < n; j++) {
            const s = cur.slice();
            s[j] = -s[j];
            seeds.push(s);
        }
        // Wrist pre-flip: rotate the last axis ±180° (common wrist-flip branch).
        if (n > 0) {
            const a = cur.slice(); a[n - 1] += 180; seeds.push(a);
            const b = cur.slice(); b[n - 1] -= 180; seeds.push(b);
        }
        return seeds;
    }

    /**
     * Build the full enumeration seed set: structured seeds + `samples` pseudo-random vectors over
     * ±ROBCO_AXIS_LIMIT_DEG, drawn from a PRNG seeded by the target so the list is stable per TCP.
     */
    _buildSeeds(samples, prng) {
        const n = this.jointNames.length;
        const seeds = this._structuredSeeds();
        const span = 2 * ROBCO_AXIS_LIMIT_DEG;
        for (let s = 0; s < samples; s++) {
            seeds.push(Array.from({ length: n }, () => prng() * span - ROBCO_AXIS_LIMIT_DEG));
        }
        return seeds;
    }

    /**
     * Enumerate the distinct joint configurations (degrees) that reach a base-frame TCP target.
     * IK has no closed form here, so we solve from many diverse seeds and de-duplicate the
     * converged solutions by joint-space distance. Wrap-aware dedup collapses ±360° winding
     * variants to distinct arm shapes. Returns rows sorted by joint travel from the current pose
     * (closest alternative first), the current pose folded in / flagged as `isCurrent`.
     *
     * @param {THREE.Matrix4} m4 base-frame TCP (tool tip when a tool offset is set).
     * @returns {Array<{deg:number[], posErr:number, rotErr:number, dist:number, isCurrent:boolean, minMarginDeg:number}>}
     */
    findConfigurationsForMatrix(m4, opts = {}) {
        const seeds = this._enumSeeds(m4, opts);
        const accepted = [];
        for (const seedDeg of seeds) this._tryAccept(m4, seedDeg, accepted, opts);
        return this._finishConfigs(accepted, opts);
    }

    /** Enumerate configurations for the current TCP pose. */
    findConfigurations(opts = {}) {
        return this.findConfigurationsForMatrix(this.tcpBaseMatrix(), opts);
    }

    /**
     * Chunked enumeration for the UI: runs FIND_CHUNK solves per animation frame so a heavy sweep
     * doesn't block the main thread, reporting fractional progress (0→1) via `onProgress`.
     */
    async findConfigurationsAsync(m4, opts = {}, onProgress = null) {
        const seeds = this._enumSeeds(m4, opts);
        const accepted = [];
        for (let i = 0; i < seeds.length; i += FIND_CHUNK) {
            for (let k = i; k < Math.min(i + FIND_CHUNK, seeds.length); k++) {
                this._tryAccept(m4, seeds[k], accepted, opts);
            }
            onProgress?.(Math.min(1, (i + FIND_CHUNK) / seeds.length));
            await new Promise((r) => requestAnimationFrame(() => r()));
        }
        return this._finishConfigs(accepted, opts);
    }

    /** Seed set for an enumeration run (structured + target-seeded random samples). */
    _enumSeeds(m4, opts) {
        const samples = opts.samples ?? (this.jointNames.length > 6 ? 64 : FIND_SAMPLES);
        const p = new THREE.Vector3().setFromMatrixPosition(m4);
        const hash = Math.round(p.x * 1000) * 73856093 ^ Math.round(p.y * 1000) * 19349663 ^ Math.round(p.z * 1000) * 83492791;
        return this._buildSeeds(samples, mulberry32(hash | 0));
    }

    /** Solve from one seed; if it converges and is a new configuration, push it onto `accepted`. */
    _tryAccept(m4, seedDeg, accepted, opts) {
        const tol = opts.dedupTolDeg ?? FIND_DEDUP_TOL_DEG;
        const wrap = opts.wrapAware ?? true;
        const res = this._solveTip(m4, seedDeg);
        if (!res.converged) return;
        const deg = res.q.map((r) => (r * 180) / Math.PI);
        for (const a of accepted) {
            if (a.deg.every((v, i) => angDiffDeg(v, deg[i], wrap) < tol)) {
                // Duplicate: keep whichever winds closer to zero (better limit margin).
                if (maxAbs(deg) < maxAbs(a.deg)) { a.deg = deg; a.posErr = res.posErr; a.rotErr = res.rotErr; }
                return;
            }
        }
        accepted.push({ deg, posErr: res.posErr, rotErr: res.rotErr });
    }

    /** Annotate (travel, limit margin, current flag), fold in the current pose, sort + cap. */
    _finishConfigs(accepted, opts) {
        const tol = opts.dedupTolDeg ?? FIND_DEDUP_TOL_DEG;
        const wrap = opts.wrapAware ?? true;
        const curDeg = this.currentAnglesDeg();
        const rows = accepted.map((a) => ({
            ...a,
            dist: a.deg.reduce((s, v, i) => s + angDiffDeg(v, curDeg[i], wrap), 0),
            minMarginDeg: ROBCO_AXIS_LIMIT_DEG - maxAbs(a.deg),
            isCurrent: false,
        }));
        const current = rows.find((r) => r.deg.every((v, i) => angDiffDeg(v, curDeg[i], wrap) < tol));
        if (current) { current.isCurrent = true; current.dist = 0; }
        else if (opts.includeCurrent ?? true) {
            rows.unshift({
                deg: curDeg, posErr: 0, rotErr: 0, dist: 0,
                minMarginDeg: ROBCO_AXIS_LIMIT_DEG - maxAbs(curDeg), isCurrent: true,
            });
        }
        rows.sort((a, b) => a.dist - b.dist);
        return rows.slice(0, opts.maxResults ?? FIND_MAX_RESULTS);
    }

    /**
     * Apply a configuration (degrees) as a joint-space preview — no IK solve; the TCP is unchanged.
     * Deliberately does NOT fire onIk: that callback signals a TCP change (a gizmo drag) and the
     * panel uses it to drop a now-stale configuration list, which a same-TCP preview must not do.
     */
    applyConfig(deg) {
        this._applyQ((deg || []).map((d) => (d * Math.PI) / 180));
        this.onPose?.(this.currentAnglesDeg());
        this.syncTcp();
    }

    /** Solve IK to a base-frame target WITHOUT moving the arm; returns joint angles (deg). */
    solveBaseMatrix(m4, seedDeg) {
        const res = this._solveTip(m4, seedDeg);
        return { deg: res.q.map((r) => (r * 180) / Math.PI), converged: res.converged, posErr: res.posErr };
    }

    setEnabled(on) {
        this.enabled = on;
        this.app._teachActive = on;
        this.gizmo.setEnabled(on);
        if (on) {
            activateManipulator('teach'); // turn off the Setup gizmo / FK drag
            this._setTargetToTcp();
            window.addEventListener('keydown', this._onKey);
        } else {
            window.removeEventListener('keydown', this._onKey);
            if (this.sm?.controls) this.sm.controls.enabled = true; // never leave orbit disabled
        }
        this.onEnabledChange?.(on);
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        this.gizmo?.dispose();
        if (this.sm?.controls) this.sm.controls.enabled = true; // never leave orbit disabled on teardown
        this.target?.parent?.remove(this.target);
        this.kin?.dispose();
    }
}
