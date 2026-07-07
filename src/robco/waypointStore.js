/**
 * WaypointStore — the canonical ORDERED sequence of teach steps + their 3D markers.
 *
 * A step is one of:
 *   move    — a waypoint: world-frame TCP pose (marker + IK seed), a captured joint snapshot, an
 *             optional exact cartesian, a per-step mode ('joint'|'cartesian') and vel/acc/blend.
 *   delay   — a dwell (seconds).
 *   payload — set payload during the run (mass kg + CoM mm).
 *
 * List order IS the flow execution order (and matches a loaded flow's order). A move's source of
 * truth is its **world-frame** pose so markers stay fixed when the base moves; the base-frame pose
 * for IK / RobFlow is derived on demand via BaseFrame.worldToBase(). Markers live under
 * BaseFrame.worldGroup and exist only for move steps.
 */
import * as THREE from 'three';

const KEY = 'robco-waypoints';
const ONE = new THREE.Vector3(1, 1, 1);
export const DEFAULT_BLEND_MM = 50;
let _seq = 0;

const uid = (p) => `${p}${++_seq}`;

export class WaypointStore {
    static ensure(sm, baseFrame) {
        if (window._robcoWaypointStore) {
            window._robcoWaypointStore.attachTo(baseFrame);
            return window._robcoWaypointStore;
        }
        const s = new WaypointStore(sm, baseFrame);
        window._robcoWaypointStore = s;
        return s;
    }

    constructor(sm, baseFrame) {
        this.sm = sm;
        this.base = baseFrame;
        this.items = [];
        this.onChange = null; // () => void (panel re-render)
        this._selectedId = null; // highlighted marker (persisted so a base move doesn't wipe it)

        this.group = new THREE.Group();
        this.group.name = 'robco-waypoints';
        baseFrame.attach(this.group);

        this._restore();
    }

    attachTo(baseFrame) {
        if (this.base === baseFrame) return;
        this.base = baseFrame;
        baseFrame.attach(this.group);
    }

    // --- add steps -----------------------------------------------------
    /** Capture a move from a world-frame TCP matrix + joint snapshot (defaults: joint, vel/acc max). */
    add(worldMatrix, jointsDeg, name, robflowPose = null) {
        const it = this._newMove({
            name: name || `P${this._moveCount() + 1}`,
            mode: 'joint',
            worldPose: this._poseFromMatrix(worldMatrix),
            joints: (jointsDeg || []).slice(),
            robflowPose: robflowPose && robflowPose.position
                ? { position: robflowPose.position.slice(), orientation: (robflowPose.orientation || []).slice() }
                : null,
        });
        this.items.push(it);
        this._commit();
        return it;
    }

    addDelay(seconds = 1, index = null) {
        const it = { id: uid('dl'), kind: 'delay', seconds: Math.max(0, +seconds || 0) };
        this._insert(it, index);
        this._commit();
        return it;
    }

    addPayload(mass = 0, com = [0, 0, 0], index = null) {
        const it = { id: uid('pl'), kind: 'payload', mass: Math.max(0, +mass || 0), com: (com || [0, 0, 0]).map((v) => +v || 0) };
        this._insert(it, index);
        this._commit();
        return it;
    }

    /** Digital-output step (native RobFlow setOutput node): drive bank/io to state at this point. */
    addOutput(bankId = 0, outputId = 0, state = true, delay = 0, index = null) {
        const it = {
            id: uid('out'), kind: 'output',
            bankId: Math.max(0, Math.round(+bankId || 0)), outputId: Math.max(0, Math.round(+outputId || 0)),
            state: !!state, delay: Math.max(0, +delay || 0),
        };
        this._insert(it, index);
        this._commit();
        return it;
    }

    /**
     * Replace the whole sequence (e.g. after loading a flow). `specs` are step descriptors; move
     * specs must carry a `worldMatrix` (THREE.Matrix4) for the marker, plus joints and/or cartesian.
     */
    loadSteps(specs) {
        this._clearMarkers();
        this.items = [];
        for (const s of specs || []) {
            if (s.kind === 'delay') {
                this.items.push({ id: uid('dl'), kind: 'delay', seconds: Math.max(0, +s.seconds || 0) });
            } else if (s.kind === 'payload') {
                this.items.push({ id: uid('pl'), kind: 'payload', mass: Math.max(0, +s.mass || 0), com: (s.com || [0, 0, 0]).map((v) => +v || 0) });
            } else if (s.kind === 'output') {
                this.items.push({
                    id: uid('out'), kind: 'output',
                    bankId: Math.max(0, Math.round(+s.bankId || 0)), outputId: Math.max(0, Math.round(+s.outputId || 0)),
                    state: !!s.state, delay: Math.max(0, +s.delay || 0),
                });
            } else {
                this.items.push(this._newMove({
                    name: s.name || `P${this._moveCount() + 1}`,
                    mode: s.mode === 'cartesian' ? 'cartesian' : 'joint',
                    worldPose: s.worldMatrix ? this._poseFromMatrix(s.worldMatrix) : null,
                    joints: (s.joints || []).slice(),
                    cartesian: s.cartesian ? { position: s.cartesian.position.slice(), orientation: s.cartesian.orientation.slice() } : null,
                    velocity: s.velocity, acceleration: s.acceleration, blendingRadius: s.blendingRadius,
                }));
            }
        }
        this._commit();
    }

    _newMove(spec) {
        const it = {
            id: uid('wp'),
            kind: 'move',
            name: spec.name,
            mode: spec.mode || 'joint',
            worldPose: spec.worldPose || null,
            joints: spec.joints || [],
            cartesian: spec.cartesian || null,
            robflowPose: spec.robflowPose || null,
            velocity: clamp01(spec.velocity ?? 1),
            acceleration: clamp01(spec.acceleration ?? 1),
            blendingRadius: Math.max(0, Math.round(spec.blendingRadius ?? DEFAULT_BLEND_MM)),
            reachable: true,
        };
        if (it.worldPose) { it._marker = this._makeMarker(it); this.group.add(it._marker); }
        return it;
    }

    _insert(it, index) {
        if (index == null || index < 0 || index >= this.items.length) this.items.push(it);
        else this.items.splice(index, 0, it);
    }

    // --- mutate --------------------------------------------------------
    remove(id) {
        const i = this.items.findIndex((w) => w.id === id);
        if (i < 0) return;
        const [it] = this.items.splice(i, 1);
        this._disposeMarker(it._marker);
        if (this._selectedId === id) this._selectedId = null;
        this._commit();
    }

    clear() {
        this._clearMarkers();
        this.items = [];
        this._commit();
    }

    rename(id, name) {
        const it = this.byId(id);
        if (it) { it.name = name; this._persist(); this._touch(); }
    }

    /** Patch arbitrary step fields. Pass {worldMatrix} to also move a move's marker. */
    update(id, patch) {
        const it = this.byId(id);
        if (!it) return;
        if (patch.worldMatrix) { it.worldPose = this._poseFromMatrix(patch.worldMatrix); delete patch.worldMatrix; }
        Object.assign(it, patch);
        if (it.kind === 'move' && it.worldPose) {
            if (!it._marker) { it._marker = this._makeMarker(it); this.group.add(it._marker); }
            else this._placeMarker(it);
            this._styleMarker(it, it.id === this._selectedId); // re-colour (mode/reachable may have changed)
        }
        this._commit();
    }

    /** Move a step from one index to another (drag-reorder). `to` is a pre-removal index. */
    moveStep(from, to) {
        if (from === to || from < 0 || from >= this.items.length) return;
        const [it] = this.items.splice(from, 1);
        // Removing index `from` shifts every later index left by one, so a downward drag
        // (from < to) must target `to - 1` to land where the user dropped it.
        const dest = Math.max(0, Math.min(this.items.length, to > from ? to - 1 : to));
        this.items.splice(dest, 0, it);
        this._commit();
    }

    setVisible(on) { this.group.visible = on; this.sm.redraw?.(); }
    isVisible() { return this.group.visible; }

    // --- derive --------------------------------------------------------
    byId(id) { return this.items.find((w) => w.id === id); }
    moves() { return this.items.filter((w) => w.kind === 'move'); }
    _moveCount() { return this.items.reduce((n, w) => n + (w.kind === 'move' ? 1 : 0), 0); }

    worldMatrix(it) {
        const pos = new THREE.Vector3().fromArray(it.worldPose.pos);
        const quat = new THREE.Quaternion().fromArray(it.worldPose.quat);
        return new THREE.Matrix4().compose(pos, quat, ONE);
    }

    /** Base/robot-root-frame matrix for IK + RobFlow push (depends on current base pose). */
    baseMatrix(it) {
        return this.base.worldToBase(this.worldMatrix(it));
    }

    /**
     * Base-frame cartesian for a RobFlow cartesianPose: position mm + orientation deg. RobFlow's
     * orientation array is [rz, ry, rx]; this reads the rotation in ZYX euler order so it is the
     * exact inverse of WaypointsPanel.cartesianToBaseMatrix (the load/decode path).
     */
    cartesianBaseFrame(it) {
        const m = this.baseMatrix(it);
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(m), 'ZYX');
        const r = (v) => Math.round(v * 1000) / 1000;
        const deg = (rad) => r((rad * 180) / Math.PI);
        return {
            position: [r(p.x * 1000), r(p.y * 1000), r(p.z * 1000)],
            orientation: [deg(e.z), deg(e.y), deg(e.x)], // [rz, ry, rx]
        };
    }

    /** Recompute reachability of every move at the current base via the teach pendant. */
    refreshReachability(teach) {
        if (!teach) return;
        for (const it of this.items) {
            if (it.kind !== 'move' || !it.worldPose) continue;
            it.reachable = teach.checkReachable(this.baseMatrix(it), it.joints);
            this._styleMarker(it, it.id === this._selectedId);
        }
        this.sm.redraw?.();
        this._touch();
    }

    reachableCount() { return this.moves().filter((w) => w.reachable).length; }

    /** Highlight one move's marker (or null to clear). Persisted so a base move keeps the highlight. */
    select(id) {
        this._selectedId = id;
        for (const it of this.items) if (it.kind === 'move') this._styleMarker(it, it.id === id);
        this.sm.redraw?.();
    }

    // --- markers -------------------------------------------------------
    _makeMarker(item) {
        const g = new THREE.Group();
        g.add(new THREE.AxesHelper(0.06));
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x2f81f7, depthTest: false, transparent: true }),
        );
        dot.renderOrder = 998;
        g.add(dot);
        g._dot = dot;
        item._marker = g;
        this._placeMarker(item);
        this._styleMarker(item, item.id === this._selectedId);
        return g;
    }

    /** Detach a marker and free its GPU geometry/material (called on remove/replace). */
    _disposeMarker(mesh) {
        if (!mesh) return;
        mesh.parent?.remove(mesh);
        mesh.traverse?.((o) => {
            o.geometry?.dispose?.();
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            mats.forEach((m) => m?.dispose?.());
        });
    }

    _placeMarker(item) {
        if (!item._marker || !item.worldPose) return;
        item._marker.position.fromArray(item.worldPose.pos);
        item._marker.quaternion.fromArray(item.worldPose.quat);
    }

    _styleMarker(item, selected = false) {
        const dot = item._marker?._dot;
        if (!dot) return;
        // Hue by mode (joint = blue, cartesian = orange); red when unreachable; yellow when selected.
        const base = item.mode === 'cartesian' ? 0xe3873a : 0x2f81f7;
        const color = !item.reachable ? 0xf85149 : selected ? 0xffd000 : base;
        dot.material.color.setHex(color);
        dot.scale.setScalar(selected ? 1.6 : 1);
    }

    _clearMarkers() {
        this.items.forEach((it) => this._disposeMarker(it._marker));
    }

    rebuildMarkers() {
        this.items.forEach((it) => {
            if (it.kind !== 'move' || !it.worldPose) return;
            this._disposeMarker(it._marker);
            it._marker = this._makeMarker(it);
            this.group.add(it._marker);
        });
        this.sm.redraw?.();
    }

    // --- helpers / persistence -----------------------------------------
    _poseFromMatrix(m4) {
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        m4.decompose(pos, quat, new THREE.Vector3());
        return { pos: pos.toArray(), quat: quat.toArray() };
    }

    _commit() {
        this._persist();
        this._touch();
        this.sm.redraw?.();
    }

    _persist() {
        try {
            const data = this.items.map((it) => {
                if (it.kind === 'delay') return { kind: 'delay', id: it.id, seconds: it.seconds };
                if (it.kind === 'payload') return { kind: 'payload', id: it.id, mass: it.mass, com: it.com };
                if (it.kind === 'output') return { kind: 'output', id: it.id, bankId: it.bankId, outputId: it.outputId, state: it.state, delay: it.delay };
                return {
                    kind: 'move', id: it.id, name: it.name, mode: it.mode,
                    worldPose: it.worldPose, joints: it.joints, cartesian: it.cartesian || null,
                    robflowPose: it.robflowPose || null,
                    velocity: it.velocity, acceleration: it.acceleration, blendingRadius: it.blendingRadius,
                };
            });
            localStorage.setItem(KEY, JSON.stringify(data));
        } catch { /* ignore */ }
    }

    _restore() {
        try {
            const data = JSON.parse(localStorage.getItem(KEY));
            if (!Array.isArray(data)) return;
            for (const d of data) {
                const kind = d.kind || 'move'; // legacy entries had no kind
                if (kind === 'delay') { const id = d.id || uid('dl'); this._bumpSeq(id); this.items.push({ id, kind: 'delay', seconds: Math.max(0, +d.seconds || 0) }); continue; }
                if (kind === 'payload') { const id = d.id || uid('pl'); this._bumpSeq(id); this.items.push({ id, kind: 'payload', mass: Math.max(0, +d.mass || 0), com: (d.com || [0, 0, 0]).map((v) => +v || 0) }); continue; }
                if (kind === 'output') { const id = d.id || uid('out'); this._bumpSeq(id); this.items.push({ id, kind: 'output', bankId: Math.max(0, Math.round(+d.bankId || 0)), outputId: Math.max(0, Math.round(+d.outputId || 0)), state: !!d.state, delay: Math.max(0, +d.delay || 0) }); continue; }
                if (kind !== 'move') continue; // forward-compat: a kind from a newer build must not become a bogus move row
                const it = {
                    id: d.id || uid('wp'), kind: 'move', name: d.name, mode: d.mode === 'cartesian' ? 'cartesian' : 'joint',
                    worldPose: d.worldPose || null, joints: d.joints || [], cartesian: d.cartesian || null,
                    robflowPose: d.robflowPose || null,
                    velocity: clamp01(d.velocity ?? 1), acceleration: clamp01(d.acceleration ?? 1),
                    blendingRadius: Math.max(0, Math.round(d.blendingRadius ?? DEFAULT_BLEND_MM)),
                    reachable: true,
                };
                this._bumpSeq(it.id);
                if (it.worldPose) { it._marker = this._makeMarker(it); this.group.add(it._marker); }
                this.items.push(it);
            }
        } catch { /* ignore */ }
    }

    _bumpSeq(id) {
        const n = parseInt(String(id).replace(/\D/g, ''), 10);
        if (!Number.isNaN(n) && n > _seq) _seq = n;
    }

    _touch() { try { this.onChange?.(); } catch (e) { console.warn('[RobCo] waypointStore.onChange:', e); } }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 1));
}
