/**
 * WaypointStore — the canonical ORDERED sequence of teach steps + their 3D markers.
 *
 * A step is one of:
 *   move    — a waypoint: world-frame TCP pose (marker + IK seed), a captured joint snapshot, an
 *             optional exact cartesian, a per-step mode ('joint'|'cartesian') and vel/acc/blend.
 *   tool    — a gripper/tool change at this point (native RobFlow setTool node; toolId null = none).
 *   delay   — a dwell (seconds).
 *   payload — set payload during the run (mass kg + CoM mm).
 *   output  — drive a digital output (native RobFlow setOutput node).
 *   node    — a RobFlow node the viewer doesn't edit, kept VERBATIM (raw node + captured branch
 *             subgraphs) so a push re-emits it instead of destroying it.
 *
 * FOLDERS: steps may carry a groupId pointing into this.folders — a foldable, named unit with an
 * optional description and an exportDoc flag (push it as a RobFlow Documentation Group). A folder's
 * members are one CONTIGUOUS run of the list; a folder of same-mode moves exports as ONE RobFlow
 * movement node. Member markers get a color halo so the grouping is visible in 3D too.
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
export const FOLDER_COLORS = ['#2f81f7', '#3fb950', '#e3873a', '#8957e5', '#d29922', '#db61a2', '#39c5cf'];
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
        this.folders = {}; // folderId -> {name, description, exportDoc, collapsed, color}
        this.onChange = null; // () => void (panel re-render; single owner — WaypointsPanel)
        this._listeners = new Set(); // additional observers (e.g. the takt-time diagram)
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

    // --- add steps (index null = append; else insert at that list position) ---
    /** Capture a move from a world-frame TCP matrix + joint snapshot (defaults: joint, vel/acc max). */
    add(worldMatrix, jointsDeg, name, robflowPose = null, index = null) {
        const it = this._newMove({
            name: name || `P${this._moveCount() + 1}`,
            mode: 'joint',
            worldPose: this._poseFromMatrix(worldMatrix),
            joints: (jointsDeg || []).slice(),
            robflowPose: robflowPose && robflowPose.position
                ? { position: robflowPose.position.slice(), orientation: (robflowPose.orientation || []).slice() }
                : null,
        });
        this._insert(it, index);
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

    /** Gripper/tool-change step (native RobFlow setTool node). toolId null = remove the tool. */
    addTool(toolId = null, index = null) {
        const it = { id: uid('tl'), kind: 'tool', toolId: toolId ?? null };
        this._insert(it, index);
        this._commit();
        return it;
    }

    /**
     * Replace the whole sequence (e.g. after loading a flow). `specs` are step descriptors; move
     * specs must carry a `worldMatrix` (THREE.Matrix4) for the marker, plus joints and/or cartesian.
     * A spec's group:{key,name,description,exportDoc} becomes a folder (equal keys = one folder).
     */
    loadSteps(specs) {
        this._clearMarkers();
        this.items = [];
        this.folders = {};
        const keyToFolder = new Map();
        for (const s of specs || []) {
            let it;
            if (s.kind === 'delay') {
                it = { id: uid('dl'), kind: 'delay', seconds: Math.max(0, +s.seconds || 0) };
            } else if (s.kind === 'payload') {
                it = { id: uid('pl'), kind: 'payload', mass: Math.max(0, +s.mass || 0), com: (s.com || [0, 0, 0]).map((v) => +v || 0) };
            } else if (s.kind === 'output') {
                it = {
                    id: uid('out'), kind: 'output',
                    bankId: Math.max(0, Math.round(+s.bankId || 0)), outputId: Math.max(0, Math.round(+s.outputId || 0)),
                    state: !!s.state, delay: Math.max(0, +s.delay || 0),
                };
            } else if (s.kind === 'tool') {
                it = { id: uid('tl'), kind: 'tool', toolId: s.toolId ?? null };
            } else if (s.kind === 'node') {
                it = {
                    id: uid('nd'), kind: 'node',
                    nodeType: s.nodeType || 'node', label: s.label || s.nodeType || 'node',
                    raw: s.raw || null,
                    extraNodes: s.extraNodes || [], extraEdges: s.extraEdges || [],
                    continueHandle: s.continueHandle !== undefined ? s.continueHandle : 'out',
                };
            } else {
                it = this._newMove({
                    name: s.name || `P${this._moveCount() + 1}`,
                    mode: s.mode === 'cartesian' ? 'cartesian' : 'joint',
                    worldPose: s.worldMatrix ? this._poseFromMatrix(s.worldMatrix) : null,
                    joints: (s.joints || []).slice(),
                    cartesian: s.cartesian ? { position: s.cartesian.position.slice(), orientation: s.cartesian.orientation.slice() } : null,
                    velocity: s.velocity, acceleration: s.acceleration, blendingRadius: s.blendingRadius,
                });
            }
            if (s.group?.key) {
                let fid = keyToFolder.get(s.group.key);
                if (!fid) {
                    fid = uid('f');
                    this.folders[fid] = {
                        name: s.group.name || 'Folder', description: s.group.description || '',
                        exportDoc: !!s.group.exportDoc, collapsed: false,
                        color: FOLDER_COLORS[keyToFolder.size % FOLDER_COLORS.length],
                    };
                    keyToFolder.set(s.group.key, fid);
                }
                it.groupId = fid;
            }
            if (s.srcNodeId) it.srcNodeId = s.srcNodeId; // RobFlow node this step came from (timing key)
            this.items.push(it);
        }
        this._commit();
    }

    /** Re-key steps to the RobFlow nodes a push just emitted (ids[i] belongs to items[i] — the
     *  builder's stepNodeIds). Keys the per-node execution timer. */
    applyNodeIds(ids) {
        if (!Array.isArray(ids)) return;
        this.items.forEach((it, i) => { it.srcNodeId = ids[i] || null; });
        this._persist();
        this._touch();
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
        // Inserted between two members of the same folder → join it (keeps folders contiguous).
        const i = this.items.indexOf(it);
        const p = this.items[i - 1];
        const n = this.items[i + 1];
        if (p?.groupId && p.groupId === n?.groupId) it.groupId = p.groupId;
    }

    // --- mutate --------------------------------------------------------
    remove(id) {
        const i = this.items.findIndex((w) => w.id === id);
        if (i < 0) return;
        const [it] = this.items.splice(i, 1);
        this._disposeMarker(it._marker);
        if (this._selectedId === id) this._selectedId = null;
        this._pruneFolders();
        this._commit();
    }

    clear() {
        this._clearMarkers();
        this.items = [];
        this.folders = {};
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
        // Folder membership follows the drop position: strictly inside a folder run → join it;
        // at a folder's edge, keep your own folder; anywhere else → leave the folder.
        const p = this.items[dest - 1];
        const n = this.items[dest + 1];
        if (p?.groupId && p.groupId === n?.groupId) it.groupId = p.groupId;
        else if (!(it.groupId && (p?.groupId === it.groupId || n?.groupId === it.groupId))) it.groupId = undefined;
        this._pruneFolders();
        this._commit();
    }

    // --- folders ---------------------------------------------------------
    /** Wrap the given step ids (plus anything between them) in a new folder. Returns its id. */
    createFolder(name = 'Folder', ids = []) {
        const idxs = ids.map((id) => this.items.findIndex((w) => w.id === id)).filter((i) => i >= 0);
        if (!idxs.length) return null;
        const fid = uid('f');
        this.folders[fid] = {
            name, description: '', exportDoc: false, collapsed: false,
            color: FOLDER_COLORS[Object.keys(this.folders).length % FOLDER_COLORS.length],
        };
        const lo = Math.min(...idxs);
        const hi = Math.max(...idxs);
        for (let i = lo; i <= hi; i++) this.items[i].groupId = fid;
        this._commit();
        return fid;
    }

    /** Patch folder props (name / description / exportDoc / collapsed). */
    setFolder(fid, patch) {
        const f = this.folders[fid];
        if (!f) return;
        Object.assign(f, patch);
        if ('color' in patch) this.items.forEach((it) => { if (it.groupId === fid) this._styleMarker(it, it.id === this._selectedId); });
        this._commit();
    }

    /** Dissolve a folder — its steps stay, ungrouped. */
    ungroup(fid) {
        for (const it of this.items) if (it.groupId === fid) it.groupId = undefined;
        delete this.folders[fid];
        this._commit();
    }

    /** Move a step to the END of a folder (drop on its header). */
    addToFolder(id, fid) {
        if (!this.folders[fid]) return;
        const from = this.items.findIndex((w) => w.id === id);
        if (from < 0) return;
        const [it] = this.items.splice(from, 1);
        let end = -1;
        this.items.forEach((w, i) => { if (w.groupId === fid) end = i; });
        if (end < 0) { this.items.splice(from, 0, it); return; } // folder emptied mid-flight
        it.groupId = fid;
        this.items.splice(end + 1, 0, it);
        this._commit();
    }

    /** Move a whole folder block to a new list position (never INTO another folder). */
    moveFolder(fid, to) {
        const idxs = this.items.map((w, i) => (w.groupId === fid ? i : -1)).filter((i) => i >= 0);
        if (!idxs.length) return;
        const lo = idxs[0];
        const count = idxs.length;
        if (to >= lo && to <= lo + count) return; // dropped onto itself
        const block = this.items.splice(lo, count);
        let dest = to > lo ? to - count : to;
        dest = Math.max(0, Math.min(this.items.length, dest));
        // Landing inside another folder would fragment it — snap to that folder's nearest edge.
        const g = this.items[dest - 1]?.groupId;
        if (g && g === this.items[dest]?.groupId) {
            let s = dest;
            while (s > 0 && this.items[s - 1].groupId === g) s--;
            let e = dest;
            while (e < this.items.length && this.items[e].groupId === g) e++;
            dest = (dest - s <= e - dest) ? s : e;
        }
        this.items.splice(dest, 0, ...block);
        this._commit();
    }

    folderOf(it) { return it?.groupId ? this.folders[it.groupId] || null : null; }
    folderMembers(fid) { return this.items.filter((w) => w.groupId === fid); }

    /** Drop folder entries that lost all their members. */
    _pruneFolders() {
        for (const fid of Object.keys(this.folders)) {
            if (!this.items.some((w) => w.groupId === fid)) delete this.folders[fid];
        }
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

    /**
     * Show ONLY the given move steps' markers, hiding all others (the takt diagram's element
     * selection). null = end isolation, every marker visible again. Isolating force-shows the
     * marker group — the point is to SEE the selected element's waypoints.
     */
    isolate(ids) {
        if (ids && !this._isolatedIds) this.group.visible = true; // force-show only on transition
        this._isolatedIds = ids ? new Set(ids) : null;
        for (const it of this.items) this._applyIsolation(it);
        this.sm.redraw?.();
    }

    _applyIsolation(it) {
        if (it._marker) it._marker.visible = !this._isolatedIds || this._isolatedIds.has(it.id);
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
        // Folder halo: a translucent shell in the folder's color, so grouping reads in 3D too.
        const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.019, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.35 }),
        );
        halo.renderOrder = 997;
        halo.visible = false;
        g.add(halo);
        g._halo = halo;
        item._marker = g;
        this._placeMarker(item);
        this._styleMarker(item, item.id === this._selectedId);
        this._applyIsolation(item); // a marker (re)built during isolation must respect it
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
        const halo = item._marker?._halo;
        if (halo) {
            const f = this.folderOf(item);
            halo.visible = !!f;
            if (f) halo.material.color.set(f.color);
        }
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
            const items = this.items.map((it) => {
                let d;
                if (it.kind === 'delay') d = { kind: 'delay', id: it.id, seconds: it.seconds };
                else if (it.kind === 'payload') d = { kind: 'payload', id: it.id, mass: it.mass, com: it.com };
                else if (it.kind === 'output') d = { kind: 'output', id: it.id, bankId: it.bankId, outputId: it.outputId, state: it.state, delay: it.delay };
                else if (it.kind === 'tool') d = { kind: 'tool', id: it.id, toolId: it.toolId ?? null };
                else if (it.kind === 'node') {
                    d = {
                        kind: 'node', id: it.id, nodeType: it.nodeType, label: it.label,
                        raw: it.raw || null, extraNodes: it.extraNodes || [], extraEdges: it.extraEdges || [],
                        continueHandle: it.continueHandle ?? null,
                    };
                } else {
                    d = {
                        kind: 'move', id: it.id, name: it.name, mode: it.mode,
                        worldPose: it.worldPose, joints: it.joints, cartesian: it.cartesian || null,
                        robflowPose: it.robflowPose || null,
                        velocity: it.velocity, acceleration: it.acceleration, blendingRadius: it.blendingRadius,
                    };
                }
                if (it.groupId) d.groupId = it.groupId;
                if (it.srcNodeId) d.srcNodeId = it.srcNodeId;
                return d;
            });
            localStorage.setItem(KEY, JSON.stringify({ v: 2, folders: this.folders, items }));
        } catch { /* ignore */ }
    }

    _restore() {
        try {
            const raw = JSON.parse(localStorage.getItem(KEY));
            // v2 payload is {v, folders, items}; anything older is a bare items array.
            const data = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : null);
            if (!data) return;
            if (raw?.folders && typeof raw.folders === 'object') this.folders = raw.folders;
            for (const fid of Object.keys(this.folders)) this._bumpSeq(fid);
            for (const d of data) {
                const kind = d.kind || 'move'; // legacy entries had no kind
                let it = null;
                if (kind === 'delay') it = { id: d.id || uid('dl'), kind: 'delay', seconds: Math.max(0, +d.seconds || 0) };
                else if (kind === 'payload') it = { id: d.id || uid('pl'), kind: 'payload', mass: Math.max(0, +d.mass || 0), com: (d.com || [0, 0, 0]).map((v) => +v || 0) };
                else if (kind === 'output') it = { id: d.id || uid('out'), kind: 'output', bankId: Math.max(0, Math.round(+d.bankId || 0)), outputId: Math.max(0, Math.round(+d.outputId || 0)), state: !!d.state, delay: Math.max(0, +d.delay || 0) };
                else if (kind === 'tool') it = { id: d.id || uid('tl'), kind: 'tool', toolId: d.toolId ?? null };
                else if (kind === 'node') {
                    it = {
                        id: d.id || uid('nd'), kind: 'node',
                        nodeType: d.nodeType || 'node', label: d.label || d.nodeType || 'node',
                        raw: d.raw || null, extraNodes: d.extraNodes || [], extraEdges: d.extraEdges || [],
                        continueHandle: d.continueHandle ?? null,
                    };
                } else if (kind === 'move') {
                    it = {
                        id: d.id || uid('wp'), kind: 'move', name: d.name, mode: d.mode === 'cartesian' ? 'cartesian' : 'joint',
                        worldPose: d.worldPose || null, joints: d.joints || [], cartesian: d.cartesian || null,
                        robflowPose: d.robflowPose || null,
                        velocity: clamp01(d.velocity ?? 1), acceleration: clamp01(d.acceleration ?? 1),
                        blendingRadius: Math.max(0, Math.round(d.blendingRadius ?? DEFAULT_BLEND_MM)),
                        reachable: true,
                    };
                }
                if (!it) continue; // forward-compat: a kind from a newer build must not become a bogus row
                if (d.groupId && this.folders[d.groupId]) it.groupId = d.groupId;
                if (d.srcNodeId) it.srcNodeId = d.srcNodeId;
                this._bumpSeq(it.id);
                if (it.kind === 'move' && it.worldPose) { it._marker = this._makeMarker(it); this.group.add(it._marker); }
                this.items.push(it);
            }
            this._pruneFolders();
        } catch { /* ignore */ }
    }

    _bumpSeq(id) {
        const n = parseInt(String(id).replace(/\D/g, ''), 10);
        if (!Number.isNaN(n) && n > _seq) _seq = n;
    }

    /** Register an additional change observer (onChange stays the panel's). @returns unsubscribe */
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _touch() {
        try { this.onChange?.(); } catch (e) { console.warn('[RobCo] waypointStore.onChange:', e); }
        for (const fn of this._listeners) {
            try { fn(); } catch (e) { console.warn('[RobCo] waypointStore listener:', e); }
        }
    }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 1));
}
