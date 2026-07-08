/**
 * Combined translate + rotate gizmo for a single target Object3D — one handle set for both,
 * built directly on three.js primitives (no TransformControls, no extra deps).
 *
 * Why not two TransformControls: two instances on one canvas each add pointer listeners and both
 * latch a drag when their handles overlap in screen space → one gesture applies translate AND
 * rotate and fires the change twice. This gizmo uses ONE raycaster and ONE pointer pipeline that
 * resolves every gesture to exactly one handle (by priority, then distance), so that can't happen.
 *
 * Handles: 3 translate arrows (X/Y/Z), 3 planar-translate quads (XY/YZ/XZ) and 3 rotate rings
 * (about X/Y/Z), plus 3 "align" dots (one next to each plane) that snap the rotation about that
 * plane's normal to the nearest 90°. Scale is intentionally omitted (meaningless for a TCP pose).
 * The planar quads ride with the translate set (Move toggle); the align dots ride with the rotate
 * set (they change orientation). World space by default (axes = world X/Y/Z); `space`
 * can be set to 'local' to align the axes with the target's own frame.
 *
 * Integration: extends Object3D — `scene.add(gizmo)`, `gizmo.attach(target)`. Emits 'change'
 * on every transform (drive IK from it) and 'dragging-changed' {value} on drag start/end. It
 * disables the passed OrbitControls whenever a handle is hovered or dragged, so grabbing a handle
 * never rotates the camera. Rendering is on-demand here, so it calls the injected `redraw` on
 * hover/drag and re-fits its screen-constant size inside updateMatrixWorld (runs each frame).
 */
import * as THREE from 'three';

const COLORS = { X: 0xff3653, Y: 0x8adb00, Z: 0x2c8fff, hover: 0xffd24a };
const AXIS = {
    X: new THREE.Vector3(1, 0, 0),
    Y: new THREE.Vector3(0, 1, 0),
    Z: new THREE.Vector3(0, 0, 1),
};
const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);

const RING_RADIUS = 1.2;   // rings sit outside the arrow tips (~0.9) so hit-areas stay apart
const ARROW_LEN = 0.9;
const ROTATION_SPEED = 20;  // drag-pixels → radians sensitivity (matches three's TransformControls)

// Planar-translate handles: a small quad in each coordinate plane, coloured by its normal axis.
const PLANE_OFFSET = 0.34;  // quad centre offset from the origin, into the +/+ quadrant
const PLANE_HALF = 0.15;    // quad half-extent
const ALIGN_OFFSET = 0.55;  // "align to plane" dot, just outside the plane quad on the diagonal
const PLANES = [
    { key: 'XY', normal: 'Z', u: 'X', v: 'Y' },
    { key: 'YZ', normal: 'X', u: 'Y', v: 'Z' },
    { key: 'XZ', normal: 'Y', u: 'X', v: 'Z' },
];

function visMaterial(color) {
    return new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
        toneMapped: false, side: THREE.DoubleSide,
    });
}
// Picker meshes must be raycastable but never rendered: object.visible stays true (the raycaster
// includes it) while material.visible is false (the renderer skips it).
function pickerMaterial() {
    // DoubleSide so the flat plane pickers are hittable from either face.
    return new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
}
// Filled translucent quad for a planar-translate handle.
function planeMaterial(color) {
    return new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false,
        toneMapped: false, side: THREE.DoubleSide,
    });
}

export class TcpGizmo extends THREE.Object3D {
    /**
     * @param {Object} o
     * @param {THREE.Camera} o.camera
     * @param {HTMLElement} o.domElement           - the canvas that receives pointer events
     * @param {Object} [o.orbit]                   - OrbitControls to disable while hovering/dragging
     * @param {()=>void} [o.redraw]                - request an on-demand repaint
     * @param {number} [o.size=0.1]                - screen-constant size factor (tune to taste)
     */
    constructor({ camera, domElement, orbit = null, redraw = null, size = 0.1 } = {}) {
        super();
        this.camera = camera;
        this.domElement = domElement;
        this.orbit = orbit;
        this._redraw = redraw;
        this.size = size;

        this.space = 'world';
        this.object = null;         // attached target Object3D
        this.enabledFlag = false;
        this.showTranslate = true;
        this.showRotate = true;
        this.visible = false;

        this._raycaster = new THREE.Raycaster();
        this._ptr = new THREE.Vector2();
        this._pickers = [];         // { mesh, record }
        this._records = [];         // per-handle { kind, key, axis, priority, mat, baseColor, picker }

        this._dragging = false;
        this._active = null;        // record being dragged
        this._hovered = null;       // record under the cursor

        this._startWorldPos = new THREE.Vector3();
        this._startWorldQuat = new THREE.Quaternion(); // target's WORLD orientation at drag start
        this._startHit = new THREE.Vector3();
        this._plane = new THREE.Plane();
        this._dragAxis = new THREE.Vector3();
        this._tmp = new THREE.Vector3();
        this._camPos = new THREE.Vector3();
        this._q0 = new THREE.Quaternion(); // scratch for local-space plane-normal in _pick

        this._translateGroup = new THREE.Group();
        this._rotateGroup = new THREE.Group();
        this.add(this._translateGroup, this._rotateGroup);
        this._build();

        this._onDown = (e) => this._pointerDown(e);
        this._onMove = (e) => this._pointerMove(e);
        this._onUp = (e) => this._pointerUp(e);
    }

    // ---- construction -------------------------------------------------------

    _build() {
        for (const key of ['X', 'Y', 'Z']) {
            this._buildArrow(key);
            this._buildRing(key);
        }
        for (const spec of PLANES) this._buildPlane(spec);
    }

    _buildArrow(key) {
        const axis = AXIS[key];
        const mat = visMaterial(COLORS[key]);
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, ARROW_LEN, 12), mat);
        shaft.position.y = ARROW_LEN / 2;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.2, 16), mat);
        tip.position.y = ARROW_LEN + 0.06;
        // Fat invisible cylinder for forgiving picking along the whole arrow.
        const picker = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, ARROW_LEN + 0.2, 8), pickerMaterial());
        picker.position.y = (ARROW_LEN + 0.2) / 2;
        const g = new THREE.Group();
        g.quaternion.setFromUnitVectors(UNIT_Y, axis); // orient +Y → axis
        [shaft, tip, picker].forEach((m) => { m.renderOrder = 500; });
        g.add(shaft, tip, picker);
        this._translateGroup.add(g);
        this._register({ kind: 'translate', key, axis, priority: 2, mat, picker });
    }

    _buildRing(key) {
        const axis = AXIS[key];
        const mat = visMaterial(COLORS[key]);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 0.014, 8, 64), mat);
        const picker = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 0.1, 6, 48), pickerMaterial());
        const g = new THREE.Group();
        g.quaternion.setFromUnitVectors(UNIT_Z, axis); // torus hole-normal (+Z) → rotation axis
        [ring, picker].forEach((m) => { m.renderOrder = 500; });
        g.add(ring, picker);
        this._rotateGroup.add(g);
        this._register({ kind: 'rotate', key, axis, priority: 1, mat, picker });
    }

    _buildPlane(spec) {
        const normal = AXIS[spec.normal];
        const mat = planeMaterial(COLORS[spec.normal]);
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2), mat);
        const picker = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_HALF * 2.4, PLANE_HALF * 2.4), pickerMaterial());
        const g = new THREE.Group();
        g.position.copy(AXIS[spec.u]).add(AXIS[spec.v]).multiplyScalar(PLANE_OFFSET); // corner of the plane
        g.quaternion.setFromUnitVectors(UNIT_Z, normal); // PlaneGeometry (+Z normal) → the plane normal
        [quad, picker].forEach((m) => { m.renderOrder = 500; });
        g.add(quad, picker);
        this._translateGroup.add(g); // planar handles ride with the translate set (Move toggle)
        this._register({ kind: 'plane', key: spec.key, axis: normal, priority: 3, mat, picker });

        // "Align" dot next to this plane — a rotation tool: clicking snaps the target's rotation
        // about the plane's normal to the nearest 90°, squaring the object to that plane. It rides
        // with the rotate set (it changes orientation) and sits just outside the plane quad.
        const dotMat = visMaterial(COLORS[spec.normal]);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), dotMat);
        const dotPicker = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), pickerMaterial());
        dot.position.copy(AXIS[spec.u]).add(AXIS[spec.v]).multiplyScalar(ALIGN_OFFSET);
        dotPicker.position.copy(dot.position);
        dot.renderOrder = 501; dotPicker.renderOrder = 501;
        this._rotateGroup.add(dot, dotPicker);
        this._register({ kind: 'snap', key: spec.key, axis: normal, priority: 4, mat: dotMat, picker: dotPicker });
    }

    _register(rec) {
        rec.baseColor = rec.mat.color.getHex(); // works for arrows/rings AND multi-axis plane keys
        rec.picker.userData.record = rec;
        this._records.push(rec);
        this._pickers.push(rec.picker);
    }

    // ---- public API ---------------------------------------------------------

    attach(object) {
        this._endHoverAndDrag(); // reset transient hover/drag state when (re)targeting
        this.object = object;
        this.visible = this.enabledFlag && !!object;
        this._refreshOrbit();
        return this;
    }

    detach() {
        this._endHoverAndDrag();
        this.object = null;
        this.visible = false;
        this._refreshOrbit(); // hover/drag cleared → let the camera orbit again
        this._redraw?.();
        return this;
    }

    setEnabled(on) {
        this.enabledFlag = on;
        this.visible = on && !!this.object;
        if (on) this._addListeners();
        else { this._removeListeners(); this._endHoverAndDrag(); }
        this._refreshOrbit();
        this._redraw?.();
    }

    /** Show/hide each handle set; never both off (keeps the gizmo usable). */
    setParts(showTranslate, showRotate) {
        this.showTranslate = showTranslate;
        this.showRotate = showRotate;
        if (!this.showTranslate && !this.showRotate) this.showTranslate = true;
        if (this._hovered && !this._partShown(this._hovered)) this._setHover(null);
        this._refreshOrbit();
        this._redraw?.();
    }

    setSpace(space) { this.space = space === 'local' ? 'local' : 'world'; this._redraw?.(); }

    dispose() {
        this._removeListeners();
        this._endHoverAndDrag(); // clear hover/drag (touches mat.color) BEFORE disposing materials
        this._refreshOrbit();    // never leave OrbitControls stuck disabled after teardown
        this.traverse((o) => {
            o.geometry?.dispose?.();
            const m = o.material;
            if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose?.());
        });
        this.parent?.remove(this);
    }

    // ---- per-frame: follow the target + hold a constant screen size ---------

    updateMatrixWorld(force) {
        if (this.object) {
            this.object.getWorldPosition(this.position);
            if (this.space === 'local') this.object.getWorldQuaternion(this.quaternion);
            else this.quaternion.identity();
            this.scale.setScalar(this._scaleFactor());
            this._translateGroup.visible = this.showTranslate;
            this._rotateGroup.visible = this.showRotate;
        }
        super.updateMatrixWorld(force);
    }

    _scaleFactor() {
        const cam = this.camera;
        cam.getWorldPosition(this._camPos); // keep _camPos valid for both camera types (drag planes use it)
        if (cam.isOrthographicCamera) return ((cam.top - cam.bottom) / cam.zoom) * this.size;
        return this.position.distanceTo(this._camPos) * this.size; // ∝ distance ⇒ constant on-screen
    }

    // ---- pointer pipeline ---------------------------------------------------

    _addListeners() {
        this.domElement.addEventListener('pointerdown', this._onDown);
        this.domElement.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
        window.addEventListener('pointercancel', this._onUp);
    }

    _removeListeners() {
        this.domElement.removeEventListener('pointerdown', this._onDown);
        this.domElement.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        window.removeEventListener('pointercancel', this._onUp);
    }

    _updatePointer(e) {
        const r = this.domElement.getBoundingClientRect();
        this._ptr.set(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1,
        );
    }

    _partShown(rec) { return (rec.kind === 'rotate' || rec.kind === 'snap') ? this.showRotate : this.showTranslate; }

    /** Raycast all shown pickers; the winner is highest priority, then nearest. */
    _pick() {
        const active = this._pickers.filter((p) => this._partShown(p.userData.record));
        if (!active.length) return null;
        this._raycaster.setFromCamera(this._ptr, this.camera);
        let hits = this._raycaster.intersectObjects(active, false);
        if (!hits.length) return null;
        // Drop plane handles seen too edge-on — they're near-invisible slivers there and dragging in
        // a grazing plane is ill-conditioned; let the click fall through to orbit instead.
        const viewDir = this._raycaster.ray.direction;
        hits = hits.filter((h) => {
            const r = h.object.userData.record;
            if (r.kind !== 'plane') return true;
            const n = this.space === 'local' && this.object
                ? r.axis.clone().applyQuaternion(this.object.getWorldQuaternion(this._q0))
                : r.axis;
            return Math.abs(viewDir.dot(n)) > 0.15;
        });
        if (!hits.length) return null;
        hits.sort((a, b) =>
            (b.object.userData.record.priority - a.object.userData.record.priority)
            || (a.distance - b.distance));
        return hits[0].object.userData.record;
    }

    _pointerMove(e) {
        if (!this.enabledFlag || !this.object) return;
        this._updatePointer(e);
        if (this._dragging) { this._drag(); return; }
        const hit = this._pick();
        if (hit !== this._hovered) {
            this._setHover(hit);
            this._refreshOrbit();
            this._redraw?.();
        }
    }

    _pointerDown(e) {
        if (!this.enabledFlag || !this.object || e.button !== 0) return;
        this._updatePointer(e);
        const hit = this._pick();
        if (!hit) return; // empty space → let OrbitControls handle it
        if (hit.kind === 'snap') { this._applySnap(hit); return; } // discrete 90° click, no drag
        this._dragging = true;
        this._active = hit;
        this.domElement.setPointerCapture?.(e.pointerId);

        this.object.updateWorldMatrix(true, false);
        this.object.getWorldPosition(this._startWorldPos);
        this.object.getWorldQuaternion(this._startWorldQuat);
        this._dragAxis.copy(this._worldAxis(hit));
        this._setupPlane(hit);

        this._raycaster.setFromCamera(this._ptr, this.camera);
        if (!this._raycaster.ray.intersectPlane(this._plane, this._startHit)) {
            // Degenerate view (plane edge-on) — abort this gesture cleanly.
            this._dragging = false; this._active = null;
            return;
        }
        this._refreshOrbit();
        this.dispatchEvent({ type: 'dragging-changed', value: true });
        this._redraw?.();
    }

    _pointerUp(e) {
        if (!this._dragging) return;
        this._dragging = false;
        this._active = null;
        this.domElement.releasePointerCapture?.(e.pointerId);
        this._refreshOrbit();
        this.dispatchEvent({ type: 'dragging-changed', value: false });
        this._redraw?.();
    }

    /** World-space axis for a handle (rotated into the target frame in 'local' space). */
    _worldAxis(rec) {
        if (this.space === 'local') return rec.axis.clone().applyQuaternion(this._startWorldQuat);
        return rec.axis.clone();
    }

    _setupPlane(rec) {
        this.camera.getWorldPosition(this._camPos); // ensure the camera position is current for the plane
        const axis = this._dragAxis;
        const origin = this._startWorldPos;
        if (rec.kind === 'rotate') {
            // Camera-facing plane (normal = toward the camera): never edge-on to the view, so the
            // ray∩plane stays well-conditioned at every angle — this is what removes the edge-on
            // rotation blow-up. The angle comes from the tangential drag in _drag, not this plane.
            const n = this._tmp.copy(this._camPos).sub(origin);
            this._plane.setFromNormalAndCoplanarPoint(n.lengthSq() < 1e-9 ? UNIT_Z : n.normalize(), origin);
            return;
        }
        if (rec.kind === 'plane') {
            // Planar translate: drag within the handle's own plane (normal = the plane normal).
            this._plane.setFromNormalAndCoplanarPoint(axis, origin);
            return;
        }
        // Translate-axis: the drag plane contains the axis and faces the camera as much as possible
        // (normal = the view direction with its along-axis component removed).
        const eye = this._tmp.copy(this._camPos).sub(origin).normalize();
        let n = eye.clone().addScaledVector(axis, -eye.dot(axis));
        if (n.lengthSq() < 1e-6) n = eye.clone(); // axis ≈ view ray → fall back
        this._plane.setFromNormalAndCoplanarPoint(n.normalize(), origin);
    }

    _drag() {
        this._raycaster.setFromCamera(this._ptr, this.camera);
        const now = this._tmp;
        if (!this._raycaster.ray.intersectPlane(this._plane, now)) return;
        const axis = this._dragAxis;

        if (this._active.kind === 'translate') {
            const offset = now.clone().sub(this._startHit).dot(axis);
            const world = this._startWorldPos.clone().addScaledVector(axis, offset);
            this._applyWorldPosition(world);
        } else if (this._active.kind === 'plane') {
            // Both points lie on the drag plane, so their delta is already in-plane → apply directly.
            const world = this._startWorldPos.clone().add(now.clone().sub(this._startHit));
            this._applyWorldPosition(world);
        } else {
            // Rotation on the camera-facing plane (see _setupPlane): project the drag onto the ring's
            // screen tangent (axis × eye) — well-conditioned at every camera angle, no edge-on blow-up.
            const eye = this._camPos.clone().sub(this._startWorldPos).normalize();
            const tangent = axis.clone().cross(eye);
            let rotAxis = axis;
            let angle;
            if (tangent.lengthSq() < 1e-9) {
                // Ring exactly face-on (axis ∥ eye): rotate in-plane about the view axis instead.
                const a = this._startHit.clone().sub(this._startWorldPos);
                const b = now.clone().sub(this._startWorldPos);
                if (a.lengthSq() < 1e-9 || b.lengthSq() < 1e-9) return;
                rotAxis = eye;
                angle = a.angleTo(b) * (b.cross(a).dot(eye) < 0 ? 1 : -1);
            } else {
                const speed = ROTATION_SPEED / this._startWorldPos.distanceTo(this._camPos);
                angle = now.clone().sub(this._startHit).dot(tangent.normalize()) * speed;
            }
            const dq = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);
            // dq is a world-space delta; compose with the WORLD start orientation, then
            // _applyWorldQuaternion converts to the target's local frame — correct even when the
            // target sits under a rotated parent (e.g. the base worldGroup under sm.world's −90°X).
            this._applyWorldQuaternion(dq.multiply(this._startWorldQuat.clone()));
        }
        this.dispatchEvent({ type: 'change' });
        this._redraw?.();
    }

    _applyWorldPosition(world) {
        const parent = this.object.parent;
        this.object.position.copy(parent ? parent.worldToLocal(world.clone()) : world);
    }

    _applyWorldQuaternion(worldQuat) {
        const parent = this.object.parent;
        if (parent) {
            const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
            this.object.quaternion.copy(pq.multiply(worldQuat));
        } else {
            this.object.quaternion.copy(worldQuat);
        }
    }

    /**
     * "Align to plane": snap the target's rotation about `rec.axis` (the plane normal) to the
     * NEAREST 90°. Applied by STEPPING from the current orientation to the snapped one in small
     * (~5°) increments, firing 'change' at each — so a downstream IK consumer (the teach arm)
     * tracks it exactly as it would a smooth drag, instead of choking on one big jump. For a free
     * object (Setup align) the steps simply converge on the final orientation.
     */
    _applySnap(rec) {
        const a = (this.space === 'local' && this.object)
            ? rec.axis.clone().applyQuaternion(this.object.getWorldQuaternion(this._q0)).normalize()
            : rec.axis.clone();
        const q0 = this.object.getWorldQuaternion(new THREE.Quaternion());
        // Swing-twist about `a`: keep the swing, snap the twist angle to the nearest 90°.
        const d = q0.x * a.x + q0.y * a.y + q0.z * a.z;
        const twist = new THREE.Quaternion(a.x * d, a.y * d, a.z * d, q0.w);
        if (twist.lengthSq() < 1e-8) twist.identity(); else twist.normalize();
        const swing = q0.clone().multiply(twist.invert());        // swing = Q · twist⁻¹
        const theta = 2 * Math.atan2(d, q0.w);                    // signed twist angle about a
        const snapped = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
        const qFinal = swing.multiply(new THREE.Quaternion().setFromAxisAngle(a, snapped));

        const total = q0.angleTo(qFinal);
        if (total < 1e-3) return; // already on the 90° grid → nothing to do
        const steps = Math.max(1, Math.ceil(total / (5 * Math.PI / 180))); // ~5° per step (drag-like)
        const qi = new THREE.Quaternion();
        for (let i = 1; i <= steps; i++) {
            this._applyWorldQuaternion(qi.copy(q0).slerp(qFinal, i / steps));
            this.dispatchEvent({ type: 'change' });
        }
        this._redraw?.();
    }

    // ---- hover highlight + orbit gating ------------------------------------

    _setHover(rec) {
        if (this._hovered && this._hovered !== rec) this._hovered.mat.color.setHex(this._hovered.baseColor);
        this._hovered = rec;
        if (rec) rec.mat.color.setHex(COLORS.hover);
    }

    _endHoverAndDrag() {
        this._setHover(null);
        this._dragging = false;
        this._active = null;
    }

    /** Orbit off whenever a handle is hovered or dragged, so a grab never orbits the camera. */
    _refreshOrbit() {
        if (this.orbit) this.orbit.enabled = !(this._dragging || this._hovered);
    }
}
