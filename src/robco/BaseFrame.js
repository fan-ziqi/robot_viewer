/**
 * BaseFrame — the single source of truth for where the robot base sits in the "world".
 *
 * RobFlow keeps the robot base at the origin, so instead of moving the robot we move a
 * `worldGroup` (scene mesh + waypoint markers) by the INVERSE of the base pose. Net effect:
 * the robot stays at 0,0,0 while the environment + waypoints move when you reposition the
 * base — letting you test different base placements against a fixed set of waypoints.
 *
 * Frame: worldGroup is a child of SceneManager.world (which applies the −90°X Z-up→Y-up
 * display conversion), so it shares the robot's native Z-up frame. A point authored at world
 * coords W (Z-up) therefore renders, in the robot-root/base frame, at inverse(basePose)·W —
 * exactly the base-frame coordinate used for IK and for the RobFlow push.
 *
 *   basePose B   = where the base sits in the world (pos m, quat), Z-up.
 *   worldGroup   = B⁻¹  (so scene/waypoints live in world coords but render in base coords).
 *   baseToWorld(m) = B·m   worldToBase(m) = B⁻¹·m
 */
import * as THREE from 'three';

const ONE = new THREE.Vector3(1, 1, 1);
const KEY = 'robco-base-pose';

export class BaseFrame {
    static ensure(sm, model) {
        if (window._robcoBaseFrame) {
            window._robcoBaseFrame.setModel(sm, model);
            return window._robcoBaseFrame;
        }
        const bf = new BaseFrame(sm, model);
        window._robcoBaseFrame = bf;
        return bf;
    }

    constructor(sm, model) {
        this.sm = sm;
        this.model = model;
        this.onChange = null; // () => void — fired after the base pose changes (single owner, see onChanged)
        this._changeListeners = new Set(); // additional subscribers (survive onChange overwrites)

        this.basePos = new THREE.Vector3(0, 0, 0);
        this.baseQuat = new THREE.Quaternion();

        // worldGroup holds the scene + waypoint markers; lives under SceneManager.world so it
        // shares the Z-up→Y-up convention with the robot. matrixAutoUpdate stays on so the
        // base gizmo (TransformControls) can drive it directly.
        this.worldGroup = new THREE.Group();
        this.worldGroup.name = 'robco-world';
        const parent = sm.world || sm.scene;
        parent.add(this.worldGroup);

        // Small world-origin marker so base moves are visible even before a scene is loaded.
        this._origin = new THREE.AxesHelper(0.3);
        this._origin.name = 'robco-world-origin';
        this.worldGroup.add(this._origin);

        this._restore(); // restore a persisted base placement (a live baseShift overrides later)
        this._apply();
    }

    setModel(sm, model) {
        this.sm = sm;
        this.model = model;
        if (this.worldGroup.parent !== (sm.world || sm.scene)) {
            (sm.world || sm.scene).add(this.worldGroup);
        }
    }

    /** Parent an object (scene GLB, waypoint-marker group) into the world frame. */
    attach(obj) {
        this.worldGroup.add(obj);
        this._touch();
    }

    /** B = base pose matrix (base in world coords). */
    matrix() {
        return new THREE.Matrix4().compose(this.basePos, this.baseQuat, ONE);
    }

    inverseMatrix() {
        return this.matrix().invert();
    }

    /** world-frame matrix → base/robot-root-frame matrix. */
    worldToBase(m4) {
        return this.inverseMatrix().multiply(m4);
    }

    /** base/robot-root-frame matrix → world-frame matrix (e.g. freeze current TCP as a waypoint). */
    baseToWorld(m4) {
        return this.matrix().multiply(m4);
    }

    /** Set the base pose (pos: THREE.Vector3 m, quat: THREE.Quaternion). */
    setBasePose(pos, quat) {
        this.basePos.copy(pos);
        this.baseQuat.copy(quat).normalize();
        this._apply();
        this._persist();
        this._touch();
    }

    /** Apply a live WS baseShift ({position mm, orientation deg XYZ-euler}). */
    setBaseShiftWS(bs) {
        if (!bs) return;
        const p = bs.position || [0, 0, 0];
        const o = bs.orientation || [0, 0, 0];
        const pos = new THREE.Vector3(p[0] / 1000, p[1] / 1000, p[2] / 1000);
        const e = new THREE.Euler((o[0] * Math.PI) / 180, (o[1] * Math.PI) / 180, (o[2] * Math.PI) / 180, 'XYZ');
        this.setBasePose(pos, new THREE.Quaternion().setFromEuler(e));
    }

    reset() {
        this.setBasePose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion());
    }

    /**
     * After a gizmo has manipulated worldGroup directly, recover basePose = inverse(worldGroup).
     * Pass {commit:false} for intermediate drag frames: basePos/baseQuat (and the panel readout)
     * stay live, but the expensive onChange consumers (per-waypoint reachability IK, waypoint-list
     * rebuild, singularity re-scan) and the localStorage write only run on the final commit —
     * firing them per pointermove freezes the app on large waypoint sets.
     */
    recomputeFromWorld({ commit = true } = {}) {
        this.worldGroup.updateMatrix();
        const inv = this.worldGroup.matrix.clone().invert();
        const s = new THREE.Vector3();
        inv.decompose(this.basePos, this.baseQuat, s);
        if (!commit) return; // gizmo already redraws while dragging
        this._persist();
        this._touch();
    }

    _persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({ pos: this.basePos.toArray(), quat: this.baseQuat.toArray() }));
        } catch { /* ignore */ }
    }

    _restore() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            if (s && Array.isArray(s.pos) && Array.isArray(s.quat)) {
                this.basePos.fromArray(s.pos);
                this.baseQuat.fromArray(s.quat).normalize();
            }
        } catch { /* ignore */ }
    }

    /** {x,y,z} mm + {rx,ry,rz} deg (XYZ euler) for the panel. */
    readout() {
        const e = new THREE.Euler().setFromQuaternion(this.baseQuat, 'XYZ');
        const r2d = 180 / Math.PI;
        return {
            x: this.basePos.x * 1000, y: this.basePos.y * 1000, z: this.basePos.z * 1000,
            rx: e.x * r2d, ry: e.y * r2d, rz: e.z * r2d,
        };
    }

    _apply() {
        // worldGroup = B⁻¹, decomposed onto position/quaternion (matrixAutoUpdate stays true).
        const inv = this.inverseMatrix();
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        inv.decompose(p, q, s);
        this.worldGroup.position.copy(p);
        this.worldGroup.quaternion.copy(q);
        this.worldGroup.updateMatrixWorld(true);
    }

    /** Subscribe to change notifications WITHOUT racing panels that assign `onChange` directly.
     *  Returns an unsubscribe function. */
    onChanged(fn) {
        this._changeListeners.add(fn);
        return () => this._changeListeners.delete(fn);
    }

    _touch() {
        this.sm?.redraw?.();
        try { this.onChange?.(); } catch (e) { console.warn('[RobCo] BaseFrame.onChange:', e); }
        for (const fn of this._changeListeners) {
            try { fn(); } catch (e) { console.warn('[RobCo] BaseFrame listener:', e); }
        }
    }
}
