/**
 * Ties the dynamics pipeline together for a built RobCo model:
 *   live joint angles (deg) -> JointDerivatives -> MujocoDynamics.computeTorques -> dashboard.
 *
 * Use `DynamicsController.attach(model)` after the model is displayed, then call `update()`
 * for each new joint-angle sample (or once for a static pose).
 */
import * as THREE from 'three';
import { JointDerivatives } from './JointDerivatives.js';
import { MujocoDynamics } from './MujocoDynamics.js';
import { I2tModel } from './I2tModel.js';
import { DynamicsDashboard } from './DynamicsDashboard.js';

const DEG2RAD = Math.PI / 180;

// Per-source payload marker styling. Several loads can be present at once (a manual TCP load
// plus an imported gripper, plus a live robot-reported payload); each gets its own sphere in a
// distinct colour so they're individually visible. The manual TCP load keeps the original
// near-black look for visual continuity. Unknown sources fall back to the TCP style.
const MARKER_STYLE = {
    tcp: { color: 0x0d0d0d },
    gripper: { color: 0x1f6feb },
    robot: { color: 0x238636 },
};

/** Element-wise equality for two optional 3×3 inertia tensors (both null counts as equal). */
function inertiaEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (a[i]?.[j] !== b[i]?.[j]) return false;
        }
    }
    return true;
}

export class DynamicsController {
    /**
     * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
     * @param {Object} [opts] - {payloadMass, payloadCom, parent}
     * @returns {Promise<DynamicsController|null>} null if there are no drive joints.
     */
    static async attach(model, opts = {}) {
        const nodes = model.userData?.moduleNodes || [];
        const descriptors = nodes.map((n) => n.descriptor).filter(Boolean);
        const jointOrder = model.userData?.jointOrder || [];
        if (jointOrder.length === 0) return null;

        // Idempotent attach: tear down any prior controller (removes its Joint Dynamics panel and
        // frees its MuJoCo model) so a second attach on the same page — e.g. an auto-restore that
        // overlaps a live reconnect on reload — can't leave a stale duplicate panel behind.
        if (typeof window !== 'undefined' && window._robcoDynamics) {
            try { window._robcoDynamics.dispose(); } catch { /* ignore */ }
            window._robcoDynamics = null;
        }

        const dyn = await MujocoDynamics.create(descriptors, opts);
        const dash = new DynamicsDashboard(jointOrder, opts.parent);
        const ctrl = new DynamicsController(dyn, dash);

        // Live-tune the derivative estimator from the panel's settings (fixed Δt on/off + ms).
        ctrl.deriv.setOptions(dash.getSettings());
        dash.onSettingsChange = (s) => ctrl.deriv.setOptions(s);
        ctrl._initMarkers(model);

        // Motor-model toggle (real-hardware vs twin-accurate). Recompute on change so the
        // panel updates even while idle.
        ctrl.dyn.setMotorModel(dash.getMotorModel?.() ?? true);
        dash.onMotorModelChange = (on) => {
            ctrl.dyn.setMotorModel(on);
            if (ctrl._lastAngles) ctrl.update(ctrl._lastAngles, performance.now());
        };

        // Reset the i²t heat accumulation (from the Graphs "Reset heat" button), then recompute so
        // the bars + graphs show heat≈0 immediately even while idle.
        dash.onResetHeat = () => {
            ctrl.i2t.reset();
            ctrl._lastT = null; // don't integrate thermal across the reset gap
            if (ctrl._lastAngles) ctrl.update(ctrl._lastAngles, performance.now());
        };

        // TCP payload (kg + CoM offset) from the dashboard -> the 'tcp' source. It is combined
        // with any other source (gripper / robot) rather than overwriting it.
        dash.onPayloadChange = (kg, com) => ctrl.setPayloadSource('tcp', kg, com);
        const payload0 = dash.getPayload?.() || 0;
        const com0 = dash.getPayloadComMeters?.() || [0, 0, 0];
        if (payload0 > 0) ctrl.setPayloadSource('tcp', payload0, com0);

        return ctrl;
    }

    constructor(dyn, dash) {
        this.dyn = dyn;
        this.dash = dash;
        this.deriv = new JointDerivatives();
        // i²t heat index, seeded from the drives' motor-side current limits and per-motor peak
        // times (from the drive's overload configuration; unknown motors default 10 s).
        this.i2t = new I2tModel(dyn.ratedCurrent, dyn.maxCurrent, { tPeakSec: dyn.peakTime });
        this._lastT = null; // ms, for real-Δt thermal integration
        // Payloads by source ('tcp' | 'gripper' | 'robot'); summed into the dynamics model and
        // each drawn as its own marker sphere.
        this._payloads = new Map();
        this._markers = new Map();
        this._flange = null;
        this._robotPayloadInfo = null; // last RobFlow-reported payload (for the panel status line)
    }

    /**
     * @param {number[]} anglesDeg - live joint angles (degrees), base->flange.
     * @param {number} [tMs] - sample timestamp.
     */
    /**
     * Re-express world gravity in the robot base frame when the base mount orientation changes
     * (wall/ceiling mounts shift the static hold torque substantially). Rebuilds the MuJoCo
     * model only on an actual orientation change. Reads the BaseFrame lazily (it may be created
     * after this controller). g_base = baseQuat⁻¹ · [0,0,-9.81].
     */
    _syncGravity() {
        const base = this._baseFrame || (typeof window !== 'undefined' ? window._robcoBaseFrame : null);
        if (!base?.baseQuat) return;
        this._baseFrame = base;
        const q = base.baseQuat;
        const key = `${q.x},${q.y},${q.z},${q.w}`;
        if (key === this._baseQuatKey) return;
        this._baseQuatKey = key;
        const g = new THREE.Vector3(0, 0, -9.81).applyQuaternion(q.clone().invert());
        this.dyn.setGravity([g.x, g.y, g.z]);
    }

    update(anglesDeg, tMs = performance.now()) {
        this._lastAngles = anglesDeg;
        this._syncGravity();
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        // JointDerivatives returns q, q̇, q̈ ALL at the same instant (the centred/fixed-lag eval
        // point). Feed its `position` — not the raw latest qRad — into inverse dynamics so the
        // pose matches the velocity/accel; mixing latest-q with lagged q̇/q̈ would corrupt the
        // Coriolis/inertia torque. The displayed angle uses the same (lagged, smoothed) pose.
        const { position, velocity, acceleration } = this.deriv.update(qRad, tMs);
        const { torque, utilization, current, currentUtil } =
            this.dyn.computeTorques(position, velocity, acceleration);
        // Integrate the i²t heat index over real elapsed time (thermal, not the differentiation Δt).
        const dtSec = this._lastT == null ? 0 : (tMs - this._lastT) / 1000;
        this._lastT = tMs;
        const heat = this.i2t.update(current, dtSec);
        const angleDeg = position.map((r) => r / DEG2RAD);
        this.dash.render({ angleDeg, velocity, acceleration, torque, utilization, current, currentUtil, heat });
    }

    /**
     * Recompute at a static pose (zero velocity/acceleration) — used while posing with the
     * teach gizmo, so the panel shows the gravity + payload hold torque at that pose.
     * @param {number[]} anglesDeg
     */
    updateStatic(anglesDeg) {
        this._lastAngles = anglesDeg;
        this._syncGravity();
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const zeros = qRad.map(() => 0);
        // At zero velocity/acceleration the friction and motor-inertia terms vanish, so this is
        // the pure gravity + payload hold torque (Coulomb friction at standstill is indeterminate
        // and intentionally not added).
        const { torque, utilization, current, currentUtil } = this.dyn.computeTorques(qRad, zeros, zeros);
        // A manual gizmo pose is a what-if, not a real time series: hold the heat index (don't
        // accumulate) and reset the thermal clock so the next live sample sees no fake gap.
        this._lastT = null;
        const heat = this.i2t.heat.slice();
        this.dash.render({ angleDeg: anglesDeg, velocity: zeros, acceleration: zeros, torque, utilization, current, currentUtil, heat });
        this.deriv.reset(); // so a later live stream doesn't differentiate across the manual pose
    }

    /**
     * Add / update / clear one payload source. Sources accumulate rather than overwrite, so a
     * manual TCP load and an imported gripper (and a live robot payload) all coexist and are
     * summed into the dynamics model. A mass of 0 removes that source.
     * @param {string} source - 'tcp' | 'gripper' | 'robot'
     * @param {number} mass - kg
     * @param {number[]} com - flange-frame CoM (m)
     */
    setPayloadSource(source, mass, com = [0, 0, 0], inertia = null) {
        if (mass > 0) {
            // Skip a redundant full MuJoCo model rebuild + recompute when nothing changed —
            // including the inertia-tensor case (deep-compared), so a live payload re-pushed at
            // stream rate doesn't recompile the WASM model every frame.
            const prev = this._payloads.get(source);
            if (prev && prev.mass === mass
                && prev.com[0] === com[0] && prev.com[1] === com[1] && prev.com[2] === com[2]
                && inertiaEqual(prev.inertia, inertia)) {
                return prev.inertiaApplied || false;
            }
            this._payloads.set(source, { mass, com: com.slice(), inertia: inertia || null, inertiaApplied: false });
        } else {
            if (!this._payloads.has(source)) return false; // clearing a source that was never set
            this._payloads.delete(source);
        }
        // setPayloads returns whether MuJoCo accepted the inertia tensor(s); record the real
        // outcome on the just-set source so the panel can report it honestly.
        const inertiaKept = this.dyn.setPayloads([...this._payloads.values()]);
        const entry = this._payloads.get(source);
        if (entry) entry.inertiaApplied = !!(entry.inertia && inertiaKept);
        this._updateMarkers();
        this.dash?.setPayloadSummary?.(
            [...this._payloads.entries()].map(([s, p]) => ({ source: s, mass: p.mass })),
        );
        // Recompute immediately so the change shows even when idle (static pose).
        if (this._lastAngles) this.update(this._lastAngles, performance.now());
        return entry ? entry.inertiaApplied : false;
    }

    /**
     * Apply a RobFlow-reported payload as the 'robot' source and reflect it in the panel status.
     * The caller passes already unit-normalized values (kg, m, kg·m²); a falsy/zero-mass info
     * clears the source. The inertia tensor is handed to MuJoCo, which is the authority on whether
     * it's physical — the reported `inertiaApplied` reflects MuJoCo's actual outcome, not a guess.
     * @param {{mass:number, com:number[], inertia?:number[][]|null, via?:string,
     *   tool?:string|null}|null} info
     */
    applyRobotPayload(info) {
        if (!info || !(info.mass > 0)) {
            this.setPayloadSource('robot', 0);
            this._robotPayloadInfo = null;
            this.dash?.setRobotPayloadInfo?.(null);
            return;
        }
        const inertiaApplied = this.setPayloadSource('robot', info.mass, info.com || [0, 0, 0], info.inertia || null);
        this._robotPayloadInfo = { ...info, inertiaApplied };
        this.dash?.setRobotPayloadInfo?.(this._robotPayloadInfo);
    }

    /** Resolve & cache the flange so payload markers can be parented to it on demand. */
    _initMarkers(model) {
        const nodes = model.userData?.moduleNodes || [];
        this._flange = nodes.length
            ? (nodes[nodes.length - 1].getDistalLink?.() || nodes[nodes.length - 1].distal)
            : model.threeObject;
    }

    /** Lazily create the marker sphere for a payload source, parented at the flange. */
    _ensureMarker(source) {
        if (this._markers.has(source)) return this._markers.get(source);
        if (!this._flange) return null;
        const style = MARKER_STYLE[source] || MARKER_STYLE.tcp;
        const mat = new THREE.MeshStandardMaterial({ color: style.color, roughness: 0.45, metalness: 0.1 });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
        mesh.castShadow = true;
        mesh.visible = false;
        mesh.name = `robco-payload-marker-${source}`;
        this._flange.add(mesh);
        this._markers.set(source, mesh);
        return mesh;
    }

    /** One sphere per active payload source, at its CoM offset, sized by its mass. */
    _updateMarkers() {
        for (const [source, mesh] of this._markers) {
            if (!this._payloads.has(source)) mesh.visible = false;
        }
        for (const [source, { mass, com }] of this._payloads) {
            const mesh = this._ensureMarker(source);
            if (!mesh) continue;
            mesh.visible = mass > 0;
            mesh.position.set(com[0] || 0, com[1] || 0, com[2] || 0);
            const r = 0.025 + 0.02 * Math.cbrt(Math.max(0, mass)); // grows gently with load
            mesh.scale.setScalar(r);
        }
    }

    dispose() {
        for (const mesh of this._markers.values()) {
            mesh.parent?.remove(mesh);
            mesh.geometry?.dispose?.();
            mesh.material?.dispose?.();
        }
        this._markers.clear();
        this.dash?.dispose();
        this.dyn?.dispose();
    }
}
