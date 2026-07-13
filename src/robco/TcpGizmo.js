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
 * (about X/Y/Z). Scale is intentionally omitted (meaningless for a TCP pose). The planar quads
 * ride with the translate set (Move toggle). World space by default (axes = world X/Y/Z); `space`
 * can be set to 'local' to align the axes with the target's own frame.
 *
 * Integration: extends Object3D — `scene.add(gizmo)`, `gizmo.attach(target)`. Emits 'change'
 * on every transform (drive IK from it) and 'dragging-changed' {value} on drag start/end. It
 * disables the passed OrbitControls whenever a handle is hovered or dragged, so grabbing a handle
 * never rotates the camera. Rendering is on-demand here, so it calls the injected `redraw` on
 * hover/drag and re-fits its screen-constant size inside updateMatrixWorld (runs each frame).
 */
import * as THREE from 'three';
import { registerGizmo, unregisterGizmo } from './gizmoSettings.js';
import { setRayFromCamera, isOrthoProjection } from './pickRay.js';

const COLORS = { X: 0xff3653, Y: 0x8adb00, Z: 0x2c8fff, hover: 0xffd24a, screen: 0xcfd8e3 };
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
const TRANSLATE_SNAP_M = 0.01; // 10 mm grid when hold-Shift snapping translation

// Planar-translate handles: a small quad in each coordinate plane, coloured by its normal axis.
const PLANE_OFFSET = 0.34;  // quad centre offset from the origin, into the +/+ quadrant
const PLANE_HALF = 0.15;    // quad half-extent
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

/** Any unit vector perpendicular to n (used to build an in-plane snap grid). */
function perpTo(n) {
    const a = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return a.cross(n).normalize();
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
        this._ringMats = [];        // rotate-ring visible materials (for the depth-fade toggle)
        this._ringFaints = [];      // faint always-on-top ring copies (shown only when fading)

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

        // Opt-in options driven by the shared Gizmo settings (see gizmoSettings.js). Defaults
        // reproduce today's behaviour; registering applies the current settings immediately.
        this._snap = false;      // hold-Shift snapping
        this._snapDeg = 15;
        this._readout = false;   // live drag readout
        this._ptrShift = false;  // Shift held on the latest pointer event
        this._ptrClientX = 0;
        this._ptrClientY = 0;
        this._readoutEl = null;  // lazily-created drag-readout chip
        this._screenHandle = false; // centre screen-space translate handle
        this._ringFade = false;     // depth cue on the rotate rings (phase 4)
        this._screenGroup = null;
        this._q1 = new THREE.Quaternion(); // scratch (screen-handle billboard)
        registerGizmo(this);
    }

    // ---- construction -------------------------------------------------------

    _build() {
        for (const key of ['X', 'Y', 'Z']) {
            this._buildArrow(key);
            this._buildRing(key);
        }
        for (const spec of PLANES) this._buildPlane(spec);
        this._buildScreen();
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
        const geom = new THREE.TorusGeometry(RING_RADIUS, 0.014, 8, 64);
        const ring = new THREE.Mesh(geom, mat);
        // Faint always-on-top twin, shown only with depth-fade: it keeps the occluded (far) half of
        // the ring faintly visible while the bright depth-tested copy shows the near half.
        const faintMat = visMaterial(COLORS[key]);
        faintMat.opacity = 0.22;
        const faint = new THREE.Mesh(geom, faintMat);
        faint.visible = false;
        const picker = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 0.1, 6, 48), pickerMaterial());
        const g = new THREE.Group();
        g.quaternion.setFromUnitVectors(UNIT_Z, axis); // torus hole-normal (+Z) → rotation axis
        [ring, faint, picker].forEach((m) => { m.renderOrder = 500; });
        g.add(ring, faint, picker);
        this._rotateGroup.add(g);
        this._ringMats.push(mat);
        this._ringFaints.push(faint);
        this._register({ kind: 'rotate', key, axis, priority: 1, mat, picker });
    }

    /** Depth-fade: bright rings become depth-tested (occluded by the arm), faint twins fill in. */
    _applyRingFade() {
        for (const m of this._ringMats) { m.depthTest = this._ringFade; m.needsUpdate = true; }
        for (const f of this._ringFaints) f.visible = this._ringFade;
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
    }

    // Centre screen-space translate handle: a small camera-facing quad that drags the target in
    // the view plane. Built once; shown only when the option is on (see updateMatrixWorld).
    _buildScreen() {
        const mat = visMaterial(COLORS.screen);
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), mat);
        const picker = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), pickerMaterial());
        [quad, picker].forEach((m) => { m.renderOrder = 502; });
        const g = new THREE.Group();
        g.visible = false;
        g.add(quad, picker);
        this._translateGroup.add(g); // rides with the translate set
        this._screenGroup = g;
        this._register({ kind: 'screen', key: 'S', axis: UNIT_Z.clone(), priority: 5, mat, picker });
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

    /** Apply the shared Gizmo settings (called by gizmoSettings on register + every change). */
    applySettings(s) {
        this.setSpace(s.space);
        this.setParts(s.showTranslate, s.showRotate);
        this._snap = !!s.snap;
        this._snapDeg = s.snapDeg || 15;
        this._readout = !!s.readout;
        this._screenHandle = !!s.screenHandle;
        this._ringFade = !!s.ringFade;
        this._applyRingFade();
        this._redraw?.();
    }

    dispose() {
        unregisterGizmo(this);
        this._removeListeners();
        this._readoutEl?.remove();
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
            if (this._screenGroup) {
                this._screenGroup.visible = this._screenHandle && this.showTranslate;
                if (this._screenGroup.visible) {
                    // Billboard the centre handle to face the camera, whatever the gizmo's own frame.
                    this.camera.getWorldQuaternion(this._q1);
                    this._screenGroup.quaternion.copy(this.quaternion).invert().multiply(this._q1);
                }
            }
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
        this._ptrClientX = e.clientX;
        this._ptrClientY = e.clientY;
        this._ptrShift = !!e.shiftKey;
    }

    _partShown(rec) {
        if (rec.kind === 'screen') return this._screenHandle && this.showTranslate;
        return rec.kind === 'rotate' ? this.showRotate : this.showTranslate;
    }

    /** Raycast all shown pickers; the winner is highest priority, then nearest. */
    _pick() {
        const active = this._pickers.filter((p) => this._partShown(p.userData.record));
        if (!active.length) return null;
        setRayFromCamera(this._raycaster, this._ptr, this.camera); // ortho-safe (faked projection)
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
        this._dragging = true;
        this._active = hit;
        // Disable orbit the instant we grab a handle — covers touch, which has no prior hover to
        // pre-disable it (mouse already did via _refreshOrbit on hover).
        if (this.orbit) this.orbit.enabled = false;
        this.domElement.setPointerCapture?.(e.pointerId);

        this.object.updateWorldMatrix(true, false);
        this.object.getWorldPosition(this._startWorldPos);
        this.object.getWorldQuaternion(this._startWorldQuat);
        this._dragAxis.copy(this._worldAxis(hit));
        this._setupPlane(hit);

        setRayFromCamera(this._raycaster, this._ptr, this.camera);
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
        this._hideReadout();
        this.domElement.releasePointerCapture?.(e.pointerId);
        this._refreshOrbit();
        this.dispatchEvent({ type: 'dragging-changed', value: false });
        this._redraw?.();
    }

    // ---- drag readout chip (a small DOM pill that follows the cursor) -------
    _ensureReadout() {
        if (this._readoutEl) return this._readoutEl;
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;z-index:3450;pointer-events:none;display:none;' +
            'padding:2px 7px;border-radius:5px;font:600 11px ui-monospace,Menlo,Consolas,monospace;' +
            'color:#e6edf3;background:rgba(13,17,23,0.92);border:1px solid rgba(255,255,255,0.18);' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.45);';
        document.body.appendChild(d);
        this._readoutEl = d;
        return d;
    }

    _showReadout(text) {
        const d = this._ensureReadout();
        d.textContent = text;
        d.style.left = `${this._ptrClientX + 14}px`;
        d.style.top = `${this._ptrClientY + 16}px`;
        d.style.display = 'block';
    }

    _hideReadout() {
        if (this._readoutEl) this._readoutEl.style.display = 'none';
    }

    /** World-space axis for a handle (rotated into the target frame in 'local' space). */
    _worldAxis(rec) {
        if (this.space === 'local') return rec.axis.clone().applyQuaternion(this._startWorldQuat);
        return rec.axis.clone();
    }

    /** Direction from `origin` toward the eye, written into `out`. Perspective: camera position −
     *  origin. Ortho (real or faked — parallel view rays): the camera's world +Z axis, the same
     *  for every origin. */
    _eyeDir(origin, out) {
        if (isOrthoProjection(this.camera)) return out.setFromMatrixColumn(this.camera.matrixWorld, 2);
        return out.copy(this._camPos).sub(origin);
    }

    _setupPlane(rec) {
        this.camera.getWorldPosition(this._camPos); // ensure the camera position is current for the plane
        const axis = this._dragAxis;
        const origin = this._startWorldPos;
        if (rec.kind === 'rotate' || rec.kind === 'screen') {
            // Camera-facing plane (normal = toward the camera). For 'rotate' this keeps the
            // ray∩plane well-conditioned at every angle (no edge-on blow-up); for the 'screen'
            // handle it IS the drag plane (translate parallel to the view).
            const n = this._eyeDir(origin, this._tmp);
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
        const eye = this._eyeDir(origin, this._tmp).normalize();
        let n = eye.clone().addScaledVector(axis, -eye.dot(axis));
        if (n.lengthSq() < 1e-6) n = eye.clone(); // axis ≈ view ray → fall back
        this._plane.setFromNormalAndCoplanarPoint(n.normalize(), origin);
    }

    _drag() {
        setRayFromCamera(this._raycaster, this._ptr, this.camera);
        const now = this._tmp;
        if (!this._raycaster.ray.intersectPlane(this._plane, now)) return;
        const axis = this._dragAxis;

        const snapping = this._snap && this._ptrShift; // opt-in snap, only while Shift is held
        const snap = (v, step) => Math.round(v / step) * step;
        let label = null;

        if (this._active.kind === 'translate') {
            let offset = now.clone().sub(this._startHit).dot(axis);
            if (snapping) offset = snap(offset, TRANSLATE_SNAP_M);
            this._applyWorldPosition(this._startWorldPos.clone().addScaledVector(axis, offset));
            label = `${(offset * 1000).toFixed(snapping ? 0 : 1)} mm`;
        } else if (this._active.kind === 'plane' || this._active.kind === 'screen') {
            const rel = now.clone().sub(this._startHit); // already in the drag plane
            let delta = rel;
            if (snapping) {
                const n = this._plane.normal; // the handle's own plane, or the camera plane for 'screen'
                const e1 = perpTo(n);
                const e2 = n.clone().cross(e1).normalize();
                delta = e1.multiplyScalar(snap(rel.dot(e1), TRANSLATE_SNAP_M))
                    .addScaledVector(e2, snap(rel.dot(e2), TRANSLATE_SNAP_M));
            }
            this._applyWorldPosition(this._startWorldPos.clone().add(delta));
            label = `${(delta.length() * 1000).toFixed(snapping ? 0 : 1)} mm`;
        } else {
            // Rotation on the camera-facing plane (see _setupPlane): project the drag onto the ring's
            // screen tangent (axis × eye) — well-conditioned at every camera angle, no edge-on blow-up.
            const eye = this._eyeDir(this._startWorldPos, new THREE.Vector3()).normalize();
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
            if (snapping) angle = snap(angle, (this._snapDeg * Math.PI) / 180);
            const dq = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle);
            // dq is a world-space delta; compose with the WORLD start orientation, then
            // _applyWorldQuaternion converts to the target's local frame — correct even when the
            // target sits under a rotated parent (e.g. the base worldGroup under sm.world's −90°X).
            this._applyWorldQuaternion(dq.multiply(this._startWorldQuat.clone()));
            label = `${(angle * 180 / Math.PI).toFixed(snapping ? 0 : 1)}°`;
        }
        if (this._readout && label != null) this._showReadout(label); else this._hideReadout();
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
