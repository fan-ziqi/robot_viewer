/**
 * Waypoints panel — an ordered teach SEQUENCE editor that round-trips with RobFlow flows.
 *
 * Load a RobFlow flow to pull its waypoints (joint + cartesian movements), delays, payloads and
 * outputs into the list + viewport markers, in execution order; every OTHER node type is kept as a
 * verbatim list row so a push can't destroy what the viewer doesn't model. Edit the sequence:
 * capture poses, switch a row between joint/cartesian, set per-row velocity/acceleration/blending,
 * insert delays/payloads/outputs/tool-changes (a tool step picks from the session tool list and
 * exports as a native setTool node), and drag rows to reorder.
 *
 * FOLDERS: steps can be collected into foldable folders (title + hover-ⓘ description). A folder of
 * same-mode moves round-trips as ONE RobFlow movement node — a multi-movement node loads back as a
 * folder — and a checked folder additionally pushes a RobFlow Documentation Group with its name.
 *
 * Push writes the sequence back as a flow with INLINE poses — updating the loaded flow in place
 * (PATCH) or importing a new one. The whole body loops; a cycle marker times each pass.
 *
 * Draggable/minimizable, persisted position key `waypoints`.
 */
import * as THREE from 'three';
import { makeDraggable, makeCollapsible } from './draggable.js';
import { buildSequenceFlow, flowGraphPatch } from '../transport/flowBuilder.js';
import { parseFlow } from '../transport/flowParser.js';
import { DEFAULT_BLEND_MM } from './waypointStore.js';
import { TcpGizmo } from './TcpGizmo.js';
import { registerManipulator, activateManipulator, deactivateManipulator } from './manipulators.js';
import { el, attachTip, fmtMs } from './uiKit.js';

const PANEL_CSS =
    'position:fixed;right:332px;top:330px;z-index:3000;width:340px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);max-height:82vh;overflow:auto;';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;' +
    'color:#e6edf3;padding:1px 3px;font:inherit;text-align:right;';
// The flow <select>: color-scheme:dark makes Chromium render the native option popup dark; the
// opaque per-option colours below cover Firefox (its popup ignores the parent's translucent bg).
const SELECT = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;color-scheme:dark;';
const OPT = 'background:#0d1117;color:#e6edf3;';
const D2R = Math.PI / 180;

function numInput(value, { w = 44, step = 1, min = 0, max = null, field = null, onChange }) {
    const i = el('input', NUM + `width:${w}px;`);
    i.type = 'number'; i.step = String(step); i.min = String(min);
    if (max != null) i.max = String(max);
    if (field) i.dataset.field = field;
    i.value = String(value);
    i.addEventListener('change', () => onChange(i));
    // Don't let a drag started on the input reorder the row.
    i.draggable = false;
    return i;
}

/** RobFlow base-frame cartesian (position mm, orientation deg [rz,ry,rx]) → base-frame matrix. */
function cartesianToBaseMatrix(c) {
    const [x, y, z] = c.position;
    const [rz, ry, rx] = c.orientation;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, 'ZYX'));
    return new THREE.Matrix4().compose(new THREE.Vector3(x / 1000, y / 1000, z / 1000), q, new THREE.Vector3(1, 1, 1));
}

export class WaypointsPanel {
    static ensure(opts) {
        if (window._robcoWaypointsPanel) {
            window._robcoWaypointsPanel.update(opts);
            return window._robcoWaypointsPanel;
        }
        const p = new WaypointsPanel(opts);
        window._robcoWaypointsPanel = p;
        return p;
    }

    constructor({ app, teach, base, store, client, cycleTimer, nodeTimer }) {
        this.app = app;
        this.teach = teach;
        this.base = base;
        this.store = store;
        this.client = client || null;
        this.cycleTimer = cycleTimer || null;
        this.nodeTimer = nodeTimer || null;
        this._currentFlowUuid = null; // the flow we round-trip to (loaded, or first import)
        this._dragFrom = null;
        this._dragFolder = null;      // folder id being dragged (whole-block reorder)
        this._descFor = null;         // folder id whose description editor is open
        this._insertAfterId = null;   // step id new steps are inserted after (null = append at end)
        this._wpEditId = null;        // waypoint currently being moved with the gizmo
        // Arbiter: the teach gizmo / setup gizmo / FK drag activating closes this one (and vice versa).
        registerManipulator('waypoint-gizmo', () => this._stopWpEdit());
        this._build();
        this._bindCycleTimer();
        this._bindNodeTimer();

        this.store.onChange = () => this._renderList();
        this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); };
        this.store.refreshReachability(this.teach);
    }

    update({ teach, base, store, client, cycleTimer, nodeTimer }) {
        if (teach) this.teach = teach;
        if (base) { this.base = base; this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); }; }
        if (store) { this.store = store; this.store.onChange = () => this._renderList(); }
        if (client !== undefined) { this.client = client; this._refreshClientUi(); }
        if (cycleTimer) { this.cycleTimer = cycleTimer; this._bindCycleTimer(); }
        if (nodeTimer) { this.nodeTimer = nodeTimer; this._bindNodeTimer(); }
        this._renderList();
    }

    /** Refresh the time chips (dim → lit) as timing data lands, at most once a second. The
     *  tooltips themselves always read live values, so this is just cosmetic catch-up. */
    _bindNodeTimer() {
        if (!this.nodeTimer) return;
        this.nodeTimer.onUpdate = () => {
            if (this._timesDirty) return;
            this._timesDirty = true;
            setTimeout(() => { this._timesDirty = false; this._renderList(); }, 1000);
        };
    }

    _bindCycleTimer() {
        if (!this.cycleTimer) return;
        this.cycleTimer.onUpdate = (stats) => this._renderCycle(stats);
        this._renderCycle(this.cycleTimer.stats());
    }

    _renderCycle(stats) {
        if (!this._cycleLine) return;
        if (!stats || stats.lastMs == null) { this._cycleLine.textContent = 'Cycle: —'; return; }
        const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
        const avg = stats.avgMs != null ? ` · avg ${s(stats.avgMs)}` : '';
        this._cycleLine.textContent = `Cycle: ${s(stats.lastMs)}${avg} · n=${stats.count}`;
    }

    // --- build ---------------------------------------------------------
    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Waypoints  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        // --- load from RobFlow ---
        const flowsRow = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:6px;');
        this._flowSelect = el('select', SELECT);
        this._flowSelect.append(el('option', OPT, '— flows —'));
        const refreshBtn = el('button', BTN, '↻');
        refreshBtn.title = 'List RobFlow flows';
        refreshBtn.addEventListener('click', () => this._refreshFlows());
        const loadBtn = el('button', BTN, 'Load');
        loadBtn.addEventListener('click', () => this._loadSelected());
        flowsRow.append(this._flowSelect, refreshBtn, loadBtn);
        body.append(flowsRow);

        // --- add steps + count. New steps land at the insertion point (the ⤵ caret on a row —
        // click one to insert after that row; no caret = append at the end). The point follows
        // whatever was just added, like a text cursor.
        const topRow = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;');
        const capBtn = el('button', BTN, 'Capture');
        capBtn.addEventListener('click', () => this._capture());
        const delayBtn = el('button', BTN, '+ delay');
        delayBtn.addEventListener('click', () => {
            this._afterAdd(this.store.addDelay(1, this._insertIndex()));
            this._status.textContent = 'added 1 s delay';
        });
        const payBtn = el('button', BTN, '+ payload');
        payBtn.addEventListener('click', () => {
            this._afterAdd(this.store.addPayload(0, [0, 0, 0], this._insertIndex()));
            this._status.textContent = 'added payload step';
        });
        const outBtn = el('button', BTN, '+ output');
        outBtn.title = 'Set a digital output at this point (native RobFlow setOutput node) — e.g. fire the gripper valve';
        outBtn.addEventListener('click', () => {
            // default to the gripper's resolved output, so "+ output" fires the valve as-is
            const gripName = window._robcoEndEffector?.gripOutputName?.();
            const ref = window._robcoMaterialManager?.resolveOutputRef?.(gripName);
            this._afterAdd(this.store.addOutput(ref?.bank ?? 0, ref?.io ?? 0, true, 0, this._insertIndex()));
            this._status.textContent = 'added output step';
        });
        const toolBtn = el('button', BTN, '+ tool');
        toolBtn.title = 'change the gripper/tool at this point — pick one from the session tool list (native RobFlow setTool node)';
        toolBtn.addEventListener('click', () => {
            // default to the currently mounted tool (the End-Effector's RobFlow mirror), else none
            const cur = window._robcoEndEffector?._rfWantUuid ?? null;
            this._afterAdd(this.store.addTool(cur, this._insertIndex()));
            this._status.textContent = 'added tool-change step — pick the tool in its row';
        });
        const foldBtn = el('button', BTN, '+ folder');
        foldBtn.title = 'wrap the insertion-caret row (or the last step) in a new folder — drag more rows onto its header to add them';
        foldBtn.addEventListener('click', () => {
            const items = this.store.items;
            if (!items.length) { this._status.textContent = 'add steps first, then wrap them in a folder'; return; }
            const anchor = (this._insertAfterId && items.find((w) => w.id === this._insertAfterId)) || items[items.length - 1];
            if (anchor.groupId) { this._status.textContent = 'that step is already in a folder'; return; }
            const fid = this.store.createFolder(`Folder ${Object.keys(this.store.folders).length + 1}`, [anchor.id]);
            if (fid) this._status.textContent = 'folder created — drag rows onto its header to add them';
        });
        topRow.append(capBtn, delayBtn, payBtn, outBtn, toolBtn, foldBtn);
        body.append(topRow);
        this._count = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;');
        body.append(this._count);

        // visibility toggle
        const visRow = el('label', 'display:flex;align-items:center;gap:8px;margin:2px 0 6px;cursor:pointer;');
        const vis = el('input'); vis.type = 'checkbox'; vis.checked = this.store.isVisible(); vis.style.accentColor = '#2f81f7';
        vis.addEventListener('change', () => this.store.setVisible(vis.checked));
        this._visCb = vis;
        visRow.append(vis, el('span', 'opacity:.9;', 'Show waypoints'));
        body.append(visRow);

        // list
        this._list = el('div', 'border-top:1px solid rgba(255,255,255,0.1);padding-top:4px;');
        body.append(this._list);

        const clearRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        const clearBtn = el('button', BTN, 'Clear all');
        clearBtn.addEventListener('click', () => {
            this.store.clear();
            this._currentFlowUuid = null;
            this._loadedName = null;
            this._insertAfterId = null;
            this._descFor = null;
        });
        clearRow.append(clearBtn);
        body.append(clearRow);

        this._status = el('div', 'font-size:11px;color:#9da7b3;min-height:14px;margin-top:6px;');
        body.append(this._status);

        // Alternate-configurations result list (filled by a row's ⌥ button). Lives outside the
        // dynamic step list so a base move / reachability refresh re-render doesn't wipe it.
        this._altBox = el('div', 'margin-top:6px;display:none;');
        body.append(this._altBox);

        body.append(this._buildPush());

        makeCollapsible(body, minBtn, 'waypoints');

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'waypoints');
        this._refreshClientUi();
        this._renderList();
    }

    _buildPush() {
        const wrap = el('div', 'border-top:1px solid rgba(255,255,255,0.1);margin-top:8px;padding-top:6px;');
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin-bottom:4px;text-transform:uppercase;font-size:10px;', 'RobFlow'));

        const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;');
        nameRow.append(el('span', 'opacity:.8;', 'name'));
        this._flowName = el('input', 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;');
        this._flowName.value = 'Viewer Flow';
        this._flowName.addEventListener('change', () => {
            // Renaming → treat as a new flow on next push (don't overwrite the loaded one's graph
            // under a different name unless the user kept the same name).
            if (this._loadedName && this._flowName.value !== this._loadedName) this._currentFlowUuid = null;
        });
        nameRow.append(this._flowName);
        wrap.append(nameRow);

        // Optional infinite-loop envelope. Off = run-once flow (no loop node, no cycle marker).
        const loopRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0 0;cursor:pointer;');
        this._loopCb = el('input');
        this._loopCb.type = 'checkbox';
        this._loopCb.style.accentColor = '#2f81f7';
        let loopPref = true;
        try { loopPref = localStorage.getItem('robco-flow-loop') !== '0'; } catch { /* ignore */ }
        this._loopCb.checked = loopPref;
        this._loopCb.addEventListener('change', () => {
            try { localStorage.setItem('robco-flow-loop', this._loopCb.checked ? '1' : '0'); } catch { /* ignore */ }
        });
        const loopLbl = el('span', 'opacity:.9;', 'loop flow (∞)');
        loopLbl.title = 'wrap the sequence in an infinite loop node + cycle marker; uncheck for a run-once flow';
        loopRow.append(this._loopCb, loopLbl);
        wrap.append(loopRow);

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:4px;');
        this._pushBtn = el('button', BTN, 'Push');
        this._pushBtn.addEventListener('click', () => this._push(false));
        this._runBtn = el('button', BTN, 'Push & Run');
        this._runBtn.addEventListener('click', () => this._push(true));
        this._runOnlyBtn = el('button', BTN + 'border-color:#3fb950;', 'Run');
        this._runOnlyBtn.addEventListener('click', () => this._runLast());
        btnRow.append(this._pushBtn, this._runBtn, this._runOnlyBtn);
        wrap.append(btnRow);

        this._cycleLine = el('div', 'font-size:11px;color:#9da7b3;margin-top:6px;min-height:14px;', 'Cycle: —');
        wrap.append(this._cycleLine);
        this._connectHint = el('div', 'font-size:10px;color:#6e7681;margin-top:3px;', '');
        wrap.append(this._connectHint);
        return wrap;
    }

    _refreshClientUi() {
        const has = !!this.client;
        if (this._connectHint) this._connectHint.textContent = has ? '' : 'connect a session to load / push';
    }

    // --- insertion point -------------------------------------------------
    /** List index new steps go to — right after the caret row; null appends at the end. */
    _insertIndex() {
        if (!this._insertAfterId) return null;
        const i = this.store.items.findIndex((w) => w.id === this._insertAfterId);
        return i < 0 ? null : i + 1;
    }

    /** Advance the insertion point past the step that was just added (text-cursor behavior). */
    _afterAdd(it) {
        if (this._insertAfterId && it) {
            this._insertAfterId = it.id;
            this._renderList(); // the caret moved — the store's own re-render already happened
        }
        return it;
    }

    // --- gizmo editing of a waypoint pose --------------------------------
    _ensureWpGizmo() {
        if (this._tc) return this._tc;
        const sm = this.app.sceneManager;
        const tc = new TcpGizmo({
            camera: sm.camera,
            domElement: sm.renderer.domElement,
            orbit: sm.controls, // the gizmo disables orbit itself while hovering/dragging
            redraw: () => sm.redraw?.(),
        });
        // the marker is the gizmo's target, so it moves live; the arm follows it via IK
        tc.addEventListener('change', () => { this._wpFollow(); sm.redraw?.(); });
        tc.addEventListener('dragging-changed', (e) => { if (!e.value) this._commitWpPose(); });
        sm.scene.add(tc);
        this._tc = tc;
        return tc;
    }

    /** Toggle gizmo editing of a move's marker: drag it to reposition/reorient the waypoint.
     *  The virtual arm drives to the waypoint on start and FOLLOWS the marker while dragging
     *  (IK preview); the live WS mirror is paused so incoming angles don't snap it back. */
    _editWaypoint(it) {
        if (this._wpEditId === it.id) { this._stopWpEdit(); return; }
        if (!it._marker || !it.worldPose) { this._status.textContent = `${it.name}: no marker to edit`; return; }
        activateManipulator('waypoint-gizmo'); // turn off teach/setup gizmo + FK drag
        if (!this.store.isVisible()) this.store.setVisible(true); // can't drag an invisible marker
        const tc = this._ensureWpGizmo();
        tc.attach(it._marker);
        tc.setEnabled(true);
        this._wpEditId = it.id;
        this.store.select(it.id);
        if (this._wpPrevTeach == null) this._wpPrevTeach = !!this.app._teachActive;
        this.app._teachActive = true; // pause the live mirror — the arm previews this waypoint
        this._wpSeed = (it.joints || []).slice(); // IK seed, carried drag-to-drag for continuity
        const res = this.teach?.goToBaseMatrix(this.store.baseMatrix(it), it.joints);
        if (res?.converged) this._wpSeed = res.q.map((r) => (r * 180) / Math.PI);
        this._status.textContent = `editing ${it.name} — drag the gizmo, click ✥ again to finish`;
        this._renderList();
        this.app.sceneManager?.redraw?.();
    }

    /** While dragging: solve IK for the marker's current pose and pose the arm on it. An
     *  unreachable spot leaves the arm at the last reachable pose (the commit marks it red). */
    _wpFollow() {
        const it = this.store.byId(this._wpEditId);
        if (!it?._marker || !this.teach) return;
        const m = new THREE.Matrix4().compose(it._marker.position, it._marker.quaternion, new THREE.Vector3(1, 1, 1));
        const res = this.teach.goToBaseMatrix(this.base.worldToBase(m), this._wpSeed?.length ? this._wpSeed : it.joints);
        if (res.converged) this._wpSeed = res.q.map((r) => (r * 180) / Math.PI);
    }

    /** Drag ended: persist the marker pose as the waypoint's world pose. A joint-mode step gets a
     *  fresh IK solve (its captured joints are stale now); the exact captured cartesian is dropped
     *  for the same reason. */
    _commitWpPose() {
        const it = this.store.byId(this._wpEditId);
        if (!it?._marker) return;
        const m = new THREE.Matrix4().compose(it._marker.position, it._marker.quaternion, new THREE.Vector3(1, 1, 1));
        const patch = { worldMatrix: m, robflowPose: null };
        if (this.teach) {
            // seed with the followed configuration — the arm is already posed on the marker
            const s = this.teach.solveBaseMatrix(this.base.worldToBase(m), this._wpSeed?.length ? this._wpSeed : it.joints);
            if (s?.converged) patch.joints = s.deg.map((d) => Math.round(d * 1000) / 1000);
        }
        this.store.update(it.id, patch);
        this.store.refreshReachability(this.teach);
    }

    _stopWpEdit() {
        if (!this._wpEditId && !this._tc) return;
        if (this._tc) this._tc.setEnabled(false);
        if (this._wpEditId) {
            this._wpEditId = null;
            this._wpSeed = null;
            // resume the live mirror (the next streamed frame re-poses the arm on the real robot)
            if (this._wpPrevTeach != null) {
                this.app._teachActive = this._wpPrevTeach;
                this._wpPrevTeach = null;
            }
            deactivateManipulator('waypoint-gizmo');
            this._renderList();
        }
    }

    // --- capture / load ------------------------------------------------
    _capture() {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        const baseM = this.teach.tcpBaseMatrix();
        const worldM = this.base.baseToWorld(baseM);
        const robflowPose = (!this.app._teachActive && this.app._robcoLatestPose) ? this.app._robcoLatestPose : null;
        const it = this._afterAdd(this.store.add(worldM, this.teach.currentAnglesDeg(), null, robflowPose, this._insertIndex()));
        this._status.textContent = `captured ${it.name}${robflowPose ? ' (exact cartesian)' : ''}`;
    }

    async _refreshFlows() {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        this._status.textContent = 'listing flows…';
        try {
            const flows = await this.client.listFlows();
            this._flowSelect.innerHTML = '';
            this._flowSelect.append(el('option', OPT, `— ${flows.length} flow(s) —`));
            for (const f of flows) {
                const o = el('option', OPT, f.name || f.uuid);
                o.value = f.uuid;
                this._flowSelect.append(o);
            }
            this._status.textContent = `found ${flows.length} flow(s)`;
        } catch (e) {
            this._status.textContent = `list failed: ${e.message}`;
        }
    }

    async _loadSelected() {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        const uuid = this._flowSelect.value;
        if (!uuid) { this._status.textContent = 'pick a flow (press ↻ to list)'; return; }
        this._status.textContent = 'loading flow…';
        try {
            const flow = await this.client.getExportableFlow(uuid);
            const { steps, name, skipped, kept, loops } = parseFlow(flow);
            const specs = steps.map((s) => this._toSpec(s)).filter(Boolean);
            this._insertAfterId = null; // fresh sequence — the old caret row is gone
            this._descFor = null;
            if (this._loopCb && typeof loops === 'boolean') {
                this._loopCb.checked = loops; // mirror the loaded flow's envelope
                try { localStorage.setItem('robco-flow-loop', loops ? '1' : '0'); } catch { /* ignore */ }
            }
            this.store.loadSteps(specs);
            this.store.refreshReachability(this.teach);
            this._currentFlowUuid = uuid;
            this._loadedName = name;
            if (name) this._flowName.value = name;
            const notes = [];
            if (kept?.length) notes.push(`kept as RobFlow nodes: ${kept.join(', ')}`);
            if (skipped.length) notes.push(`dropped: ${skipped.join(', ')}`);
            this._status.textContent = `loaded "${name}" — ${specs.length} step(s)${notes.length ? ' · ' + notes.join(' · ') : ''}`;
        } catch (e) {
            this._status.textContent = `load failed: ${e.message}`;
            console.error('[RobCo] flow load failed:', e);
        }
    }

    /** Parsed step → store spec (compute the world marker pose for moves). */
    _toSpec(s) {
        if (s.kind !== 'move') return s;
        let baseM = null;
        if (s.mode === 'cartesian' && s.cartesian) {
            baseM = cartesianToBaseMatrix(s.cartesian);
        } else if (this.teach && s.joints?.length) {
            baseM = this.teach.fkBaseMatrix(s.joints);
        }
        const worldMatrix = baseM ? this.base.baseToWorld(baseM) : null;
        return { ...s, worldMatrix };
    }

    // --- list ----------------------------------------------------------
    _renderList() {
        if (!this._list) return;
        // The gizmo-edited step was removed (delete / clear / flow load) — its marker is gone.
        if (this._wpEditId && !this.store.byId(this._wpEditId)) this._stopWpEdit();
        // Preserve an in-progress edit across the full rebuild (base moves / reachability refresh
        // re-render the whole list; without this the field you're typing in loses focus).
        const active = document.activeElement;
        let restore = null;
        if (active && this._list.contains(active) && active.dataset?.field) {
            const row = active.closest('[data-idx]');
            restore = { idx: row?.dataset.idx, field: active.dataset.field, s: active.selectionStart, e: active.selectionEnd };
        }
        this._list.innerHTML = '';
        const items = this.store.items;
        const moves = items.filter((w) => w.kind === 'move');
        const reach = this.store.reachableCount();
        this._count.textContent = `${items.length} steps · ${moves.length} moves · ${reach}/${moves.length} reachable`;
        if (this._visCb) this._visCb.checked = this.store.isVisible();

        let lastFolder = null;
        items.forEach((it, idx) => {
            // Folder boundaries: a contiguous run of the same groupId renders one header above it.
            const fid = (it.groupId && this.store.folders[it.groupId]) ? it.groupId : null;
            if (fid !== lastFolder) {
                lastFolder = fid;
                if (fid) {
                    this._list.append(this._folderHeader(fid, idx));
                    if (this._descFor === fid) this._list.append(this._descEditor(fid));
                }
            }
            const folder = fid ? this.store.folders[fid] : null;
            if (folder?.collapsed) return; // members hidden while folded (header shows the count)

            const row = el('div', 'display:flex;align-items:center;gap:5px;margin:2px 0;padding:1px 2px;border-radius:5px;' +
                (folder ? `margin-left:9px;border-left:2px solid ${folder.color};padding-left:4px;` : ''));
            row.dataset.idx = String(idx);
            row.draggable = true;
            this._wireDrag(row, idx);
            const handle = el('span', 'cursor:grab;opacity:.45;flex:0 0 auto;', '⠿');
            row.append(handle);

            // Insertion caret: new steps (Capture / +delay / +payload / +output) land after this
            // row. Click to set, click again to go back to appending at the end.
            const here = it.id === this._insertAfterId;
            const caret = el('span', 'cursor:pointer;flex:0 0 auto;font-size:11px;padding:0 2px;border-radius:4px;' +
                (here ? 'color:#2f81f7;background:rgba(47,129,247,0.22);' : 'opacity:.35;'), '⤵');
            caret.title = here
                ? 'new steps are inserted here — click to append at the end again'
                : 'insert new steps after this row';
            caret.draggable = false;
            caret.addEventListener('click', () => {
                this._insertAfterId = here ? null : it.id;
                this._renderList();
            });
            row.append(caret);

            if (it.kind === 'delay') this._delayRow(row, it);
            else if (it.kind === 'payload') this._payloadRow(row, it);
            else if (it.kind === 'output') this._outputRow(row, it);
            else if (it.kind === 'tool') this._toolRow(row, it);
            else if (it.kind === 'node') this._nodeRow(row, it);
            else this._moveRow(row, it);

            this._list.append(row);
            if (here) this._list.append(el('div', 'height:2px;background:#2f81f7;border-radius:1px;margin:0 2px 1px 20px;'));
        });
        if (items.length === 0) this._list.append(el('div', 'opacity:.6;font-size:11px;', 'empty — Capture, +delay/+payload/+output/+tool/+folder, or Load a flow'));

        if (restore?.idx != null) {
            const sel = this._list.querySelector(`[data-idx="${restore.idx}"] [data-field="${restore.field}"]`);
            if (sel) { sel.focus(); try { sel.setSelectionRange(restore.s, restore.e); } catch { /* number inputs reject setSelectionRange */ } }
        }
    }

    // --- folders ---------------------------------------------------------
    /** Folder header row: fold triangle, color chip, name, hover-ⓘ description, ✎ edit, doc-group
     *  checkbox, count, ✕ dissolve. Draggable as a block; dropping a step on it joins the folder. */
    _folderHeader(fid, idx) {
        const f = this.store.folders[fid];
        const members = this.store.folderMembers(fid);
        const head = el('div', 'display:flex;align-items:center;gap:5px;margin:4px 0 2px;padding:2px 3px;border-radius:5px;background:rgba(255,255,255,0.04);');
        head.dataset.idx = String(idx);
        head.draggable = true;
        this._wireFolderDrag(head, fid);
        const grip = el('span', 'cursor:grab;opacity:.45;flex:0 0 auto;', '⠿');
        const tri = el('button', 'background:transparent;border:0;color:#e6edf3;cursor:pointer;padding:0 3px;font:inherit;flex:0 0 auto;', f.collapsed ? '▸' : '▾');
        tri.title = f.collapsed ? 'expand folder' : 'collapse folder';
        tri.draggable = false;
        tri.addEventListener('click', () => this.store.setFolder(fid, { collapsed: !f.collapsed }));
        const chip = el('span', `width:9px;height:9px;border-radius:3px;flex:0 0 auto;background:${f.color};`);
        const name = el('input', 'flex:1;min-width:30px;background:transparent;border:0;border-bottom:1px dashed rgba(255,255,255,0.18);color:#e6edf3;font:600 12px ui-monospace,Menlo,Consolas,monospace;padding:1px 2px;');
        name.value = f.name;
        name.draggable = false;
        name.dataset.field = `fname-${fid}`;
        name.addEventListener('change', () => this.store.setFolder(fid, { name: name.value }));
        // The description stays hidden until the ⓘ is hovered (per design: never shown inline).
        const info = el('span', 'flex:0 0 auto;cursor:help;opacity:.65;font-size:11px;', 'ⓘ');
        attachTip(info, () => this.store.folders[fid]?.description || '(no description — click ✎ to add one)');
        const edit = el('button', BTN + 'padding:1px 5px;flex:0 0 auto;', '✎');
        edit.title = 'edit the folder description';
        edit.draggable = false;
        edit.addEventListener('click', () => { this._descFor = this._descFor === fid ? null : fid; this._renderList(); });
        const count = el('span', 'flex:0 0 auto;opacity:.55;font-size:10px;', f.collapsed ? `${members.length} step(s)` : '');
        const doc = el('input');
        doc.type = 'checkbox';
        doc.checked = !!f.exportDoc;
        doc.style.accentColor = f.color;
        doc.draggable = false;
        doc.title = 'push this folder as a RobFlow Documentation Group (named after the folder, description included)';
        doc.addEventListener('change', () => this.store.setFolder(fid, { exportDoc: doc.checked }));
        const ung = el('button', BTN + 'padding:1px 5px;flex:0 0 auto;', '✕');
        ung.title = 'dissolve the folder (keeps its steps)';
        ung.draggable = false;
        ung.addEventListener('click', () => this.store.ungroup(fid));
        head.append(grip, tri, chip, name, info, edit, count, this._folderTimeChip(fid), doc, ung);
        return head;
    }

    _descEditor(fid) {
        const f = this.store.folders[fid];
        const wrap = el('div', 'margin:0 2px 3px 18px;');
        wrap.dataset.idx = `desc-${fid}`;
        const ta = el('textarea', 'width:100%;box-sizing:border-box;min-height:44px;background:rgba(255,255,255,0.06);' +
            'border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;padding:3px 5px;resize:vertical;');
        ta.value = f.description || '';
        ta.placeholder = 'short description (shown on ⓘ hover; pushed with the Documentation Group)';
        ta.dataset.field = `fdesc-${fid}`;
        ta.draggable = false;
        ta.addEventListener('change', () => this.store.setFolder(fid, { description: ta.value }));
        wrap.append(ta);
        return wrap;
    }

    _wireFolderDrag(head, fid) {
        head.addEventListener('dragstart', (e) => {
            if (e.target.closest('input,button,select,textarea')) { e.preventDefault(); return; }
            this._dragFolder = fid;
            this._dragFrom = null;
            head.style.opacity = '0.4';
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', fid); } catch { /* ignore */ }
        });
        head.addEventListener('dragend', () => { head.style.opacity = '1'; this._dragFolder = null; });
        head.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ } });
        head.addEventListener('drop', (e) => {
            e.preventDefault();
            if (this._dragFrom != null) {
                // a step dropped onto the folder header joins the folder (at its end)
                const it = this.store.items[this._dragFrom];
                if (it && it.groupId !== fid) this.store.addToFolder(it.id, fid);
            } else if (this._dragFolder && this._dragFolder !== fid) {
                this.store.moveFolder(this._dragFolder, Number(head.dataset.idx));
            }
        });
    }

    /** Small ◔ chip: hover to see the last execution time of this step's RobFlow node (fed by
     *  the nodeState websocket while a flow runs). Lit amber once data exists. */
    _timeChip(it) {
        const has = this.nodeTimer?.msFor?.(it.srcNodeId) != null;
        const chip = el('span', 'flex:0 0 auto;cursor:help;font-size:11px;' + (has ? 'color:#d29922;' : 'opacity:.3;'), '◔');
        chip.draggable = false;
        attachTip(chip, () => {
            if (!this.nodeTimer) return 'execution timing needs a live session';
            if (!it.srcNodeId) return 'not linked to a RobFlow node yet — Push or Load first';
            const ms = this.nodeTimer.msFor(it.srcNodeId);
            return ms != null ? `last execution: ${fmtMs(ms)}` : 'no timing yet — Run the flow';
        });
        return chip;
    }

    /** Folder ◔ chip: hover for the summed last-execution time of the folder's RobFlow nodes
     *  (each node counted once — merged moves share one node). */
    _folderTimeChip(fid) {
        const sum = () => {
            const ids = [...new Set(this.store.folderMembers(fid).map((m) => m.srcNodeId).filter(Boolean))];
            let total = 0;
            let n = 0;
            for (const id of ids) {
                const ms = this.nodeTimer?.msFor?.(id);
                if (ms != null) { total += ms; n += 1; }
            }
            return { total, n, of: ids.length };
        };
        const has = this.nodeTimer && sum().n > 0;
        const chip = el('span', 'flex:0 0 auto;cursor:help;font-size:11px;' + (has ? 'color:#d29922;' : 'opacity:.3;'), '◔');
        chip.draggable = false;
        attachTip(chip, () => {
            if (!this.nodeTimer) return 'execution timing needs a live session';
            const { total, n, of } = sum();
            if (!of) return 'not linked to RobFlow nodes yet — Push or Load first';
            if (!n) return 'no timing yet — Run the flow';
            return `folder total (last run): ${fmtMs(total)}${n < of ? ` — ${n}/${of} node(s) timed` : ''}`;
        });
        return chip;
    }

    /** A RobFlow node the viewer doesn't edit — kept verbatim, reorderable, deletable. */
    _nodeRow(row, it) {
        row.style.background = 'rgba(110,118,129,0.12)';
        row.title = 'RobFlow node the viewer does not edit — kept as-is and written back on push';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '⬡'));
        const type = el('span', 'flex:0 0 auto;font-size:10px;padding:0 5px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;opacity:.75;', it.nodeType);
        const label = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8;',
            it.label && it.label !== it.nodeType ? it.label : '');
        row.append(type, label);
        if (it.extraNodes?.length) {
            const extra = el('span', 'flex:0 0 auto;opacity:.5;font-size:10px;', `+${it.extraNodes.length}`);
            extra.title = `${it.extraNodes.length} attached RobFlow node(s) (branches / unlinked) — kept verbatim on push`;
            row.append(extra);
        }
        row.append(this._timeChip(it), this._delBtn(it.id));
    }

    _moveRow(row, it) {
        const isCart = it.mode === 'cartesian';
        const dot = el('span', `width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${it.reachable ? (isCart ? '#e3873a' : '#3fb950') : '#f85149'};`);
        const name = el('input', 'flex:1;min-width:30px;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,0.12);color:#e6edf3;font:inherit;padding:1px 2px;');
        name.value = it.name; name.draggable = false; name.dataset.field = 'name';
        name.addEventListener('change', () => this.store.rename(it.id, name.value));
        name.addEventListener('focus', () => { this.store.select(it.id); this.app.sceneManager?.redraw?.(); });

        // joint/cartesian toggle — colour-coded (blue = joint, orange = cartesian).
        const modeBtn = el('button', BTN + 'padding:2px 6px;flex:0 0 auto;' +
            (isCart ? 'background:rgba(227,135,58,0.35);border-color:#e3873a;' : 'background:rgba(47,129,247,0.35);border-color:#2f81f7;'),
            isCart ? 'C' : 'J');
        modeBtn.title = isCart ? 'cartesian — click for joint' : 'joint — click for cartesian';
        modeBtn.draggable = false;
        modeBtn.addEventListener('click', () => this._toggleMode(it));

        const vel = numInput(it.velocity, { w: 38, step: 0.05, min: 0, max: 1, field: 'vel', onChange: (i) => this.store.update(it.id, { velocity: clampNum(i.value, 0, 1) }) });
        vel.title = 'velocity (0–1)';
        const acc = numInput(it.acceleration, { w: 38, step: 0.05, min: 0, max: 1, field: 'acc', onChange: (i) => this.store.update(it.id, { acceleration: clampNum(i.value, 0, 1) }) });
        acc.title = 'acceleration (0–1)';
        const blend = numInput(it.blendingRadius, { w: 40, step: 5, min: 0, field: 'blend', onChange: (i) => this.store.update(it.id, { blendingRadius: Math.max(0, Math.round(+i.value || 0)) }) });
        blend.title = 'blending radius (mm)';

        const alt = el('button', BTN + 'padding:3px 6px;flex:0 0 auto;', '⌥');
        alt.title = 'find alternate joint configurations for this TCP';
        alt.draggable = false;
        alt.addEventListener('click', () => this._showAlternates(it));
        const editing = it.id === this._wpEditId;
        const giz = el('button', BTN + 'padding:3px 6px;flex:0 0 auto;'
            + (editing ? 'background:rgba(47,129,247,0.35);border-color:#2f81f7;' : ''), '✥');
        giz.title = editing ? 'finish editing this waypoint' : 'move this waypoint with a gizmo in the 3D view';
        giz.draggable = false;
        giz.addEventListener('click', () => this._editWaypoint(it));
        const go = el('button', BTN + 'padding:3px 6px;flex:0 0 auto;', 'Go');
        go.draggable = false;
        go.addEventListener('click', () => this._goTo(it));
        const del = this._delBtn(it.id);
        row.append(dot, name, modeBtn, vel, acc, blend, this._timeChip(it), alt, giz, go, del);
    }

    /** Gripper/tool-change step: pick a tool from the session's tool list ('∅' removes the tool).
     *  Exports as a native RobFlow setTool node at this point in the sequence. */
    _toolRow(row, it) {
        row.style.background = 'rgba(57,197,207,0.12)';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '🔧'));
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', 'tool'));
        const tools = window._robcoEndEffector?._rfTools || [];
        const sel = el('select', SELECT);
        sel.draggable = false;
        sel.dataset.field = 'tool';
        const add = (value, text) => { const o = el('option', OPT, text); o.value = value; sel.append(o); };
        add('null', '∅ no tool');
        for (const t of tools) add(t.uuid, t.name || t.uuid);
        const cur = it.toolId ?? 'null';
        if (cur !== 'null' && !tools.some((t) => t.uuid === cur)) add(cur, `tool ${String(cur).slice(0, 8)}…`); // library not loaded (offline)
        sel.value = cur;
        sel.title = 'gripper/tool mounted from this point on (RobFlow setTool node)';
        sel.addEventListener('change', () => this.store.update(it.id, { toolId: sel.value === 'null' ? null : sel.value }));
        row.append(sel, this._timeChip(it), this._delBtn(it.id));
    }

    _delayRow(row, it) {
        row.style.background = 'rgba(210,153,34,0.12)';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '⏱ delay'));
        const secs = numInput(it.seconds, { w: 56, step: 0.5, min: 0, field: 'seconds', onChange: (i) => this.store.update(it.id, { seconds: Math.max(0, +i.value || 0) }) });
        const spacer = el('span', 'flex:1;');
        row.append(secs, el('span', 'opacity:.6;', 's'), spacer, this._timeChip(it), this._delBtn(it.id));
    }

    _payloadRow(row, it) {
        row.style.background = 'rgba(35,134,54,0.12)';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '⚖'));
        const mass = numInput(it.mass, { w: 46, step: 0.1, min: 0, onChange: (i) => this.store.update(it.id, { mass: Math.max(0, +i.value || 0) }) });
        mass.title = 'payload mass (kg)';
        row.append(mass, el('span', 'opacity:.6;', 'kg'));
        const setCom = () => this.store.update(it.id, { com: [cx, cy, cz].map((i) => +i.value || 0) });
        const cx = numInput(it.com[0], { w: 34, step: 1, min: -100000, field: 'comx', onChange: setCom });
        const cy = numInput(it.com[1], { w: 34, step: 1, min: -100000, field: 'comy', onChange: setCom });
        const cz = numInput(it.com[2], { w: 34, step: 1, min: -100000, field: 'comz', onChange: setCom });
        row.append(el('span', 'opacity:.6;margin-left:4px;', 'CoM'), cx, cy, cz, el('span', 'opacity:.6;', 'mm'), this._timeChip(it), this._delBtn(it.id));
    }

    _outputRow(row, it) {
        row.style.background = 'rgba(137,87,229,0.12)';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '⚡'));
        const bank = numInput(it.bankId, { w: 34, step: 1, min: 0, field: 'bank', onChange: (i) => this.store.update(it.id, { bankId: Math.max(0, Math.round(+i.value || 0)) }) });
        bank.title = 'output bank id';
        const io = numInput(it.outputId, { w: 34, step: 1, min: 0, field: 'io', onChange: (i) => this.store.update(it.id, { outputId: Math.max(0, Math.round(+i.value || 0)) }) });
        io.title = 'output id within the bank';
        const state = el('button', BTN + 'padding:2px 8px;flex:0 0 auto;' + (it.state
            ? 'background:rgba(63,185,80,0.35);border-color:#3fb950;'
            : ''), it.state ? 'ON' : 'OFF');
        state.title = 'state this output is driven to';
        state.draggable = false;
        state.addEventListener('click', () => this.store.update(it.id, { state: !it.state }));
        // Resolved name from the live robot config (e.g. "Gripper") — confirms the address is right.
        const ioConfigs = window._robcoMaterialManager?.ioConfigs || [];
        const named = ioConfigs.find((c) => c?.bankId === it.bankId && c?.ioId === it.outputId);
        const name = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6;font-size:10px;', named?.name || '');
        row.append(el('span', 'opacity:.6;', 'bank'), bank, el('span', 'opacity:.6;', 'io'), io, state, name, this._timeChip(it), this._delBtn(it.id));
    }

    _delBtn(id) {
        const del = el('button', BTN + 'padding:3px 6px;flex:0 0 auto;', '✕');
        del.draggable = false;
        del.addEventListener('click', () => this.store.remove(id));
        return del;
    }

    _wireDrag(row, idx) {
        row.addEventListener('dragstart', (e) => {
            if (e.target.closest('input,button,select')) { e.preventDefault(); return; } // editing, not reordering
            this._dragFrom = idx;
            this._dragFolder = null;
            row.style.opacity = '0.4';
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch { /* ignore */ }
        });
        row.addEventListener('dragend', () => { row.style.opacity = '1'; this._dragFrom = null; });
        row.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ } });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const to = Number(row.dataset.idx);
            if (this._dragFolder) { this.store.moveFolder(this._dragFolder, to); return; } // whole-folder drop
            const from = this._dragFrom;
            if (from != null && from !== to) this.store.moveStep(from, to);
        });
    }

    _toggleMode(it) {
        if (!it.worldPose && !it.cartesian) { this._status.textContent = `${it.name}: no pose to convert`; return; }
        if (it.mode === 'joint') {
            // joint → cartesian: just flip the mode. The cartesian is derived at push time from the
            // current base (exact capture or FK), so it isn't frozen to a stale base position.
            this.store.update(it.id, { mode: 'cartesian' });
            this._status.textContent = `${it.name} → cartesian`;
        } else {
            // cartesian → joint: solve IK at the current base for an exact joint snapshot.
            const s = this.teach?.solveBaseMatrix(this.store.baseMatrix(it), it.joints);
            if (!s || !s.converged) { this._status.textContent = `${it.name}: no IK solution (stays cartesian)`; return; }
            this.store.update(it.id, { mode: 'joint', joints: s.deg.map((d) => Math.round(d * 1000) / 1000) });
            this._status.textContent = `${it.name} → joint`;
        }
    }

    async _goTo(it) {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        if (!it.worldPose) { this._status.textContent = `${it.name}: no world pose to drive to`; return; }
        const res = this.teach.goToBaseMatrix(this.store.baseMatrix(it), it.joints);
        if (!res.converged) {
            this._status.textContent = `${it.name}: unreachable (posErr ${(res.posErr * 1000).toFixed(0)} mm)`;
            return;
        }
        if (!this.client) { this._status.textContent = `preview ${it.name}`; return; }
        const deg = res.q.map((r) => (r * 180) / Math.PI);
        const move = () => this.client.moveJointAngles(deg, { velocity: 0.3, acceleration: 0.3 });
        try {
            // RobFlow only allows /move-joint-angles in OperationMode TEACH + RobotState IDLE. If the
            // robot is merely SWITCHED_ON (powered, not enabled), request OPERATIONAL first to bring
            // it to IDLE, then move. If it's still transitioning the move 409s → wait briefly + retry.
            await this.client.setDesiredRobotState(2).catch(() => {}); // 2 = OPERATIONAL
            await move();
            this._status.textContent = `moving to ${it.name}`;
        } catch (e) {
            if (/\b409\b/.test(e.message)) {
                await new Promise((r) => setTimeout(r, 600));
                try { await move(); this._status.textContent = `moving to ${it.name}`; return; }
                catch (e2) { e = e2; }
            }
            const hint = /\b(AUTOMATIC|FLOW)\b/.test(e.message)
                ? ' — set the robot to TEACH mode on the pendant'
                : (/\b(SWITCHED_ON|DISABLED)\b/.test(e.message) ? ' — enable the robot on the pendant' : '');
            this._status.textContent = `move failed: ${e.message}${hint}`;
        }
    }

    // --- alternate configurations --------------------------------------
    /**
     * Find the joint configurations that reach a waypoint's TCP and list them for preview. Drives
     * to the waypoint's stored branch first (preview only — no robot command) so the enumerated
     * Current row is that branch and the rest are genuine alternates. Pauses the live WS mirror
     * (app._teachActive) for the list's lifetime so a preview isn't snapped back by an incoming frame.
     */
    _showAlternates(it) {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        if (!it.worldPose) { this._status.textContent = `${it.name}: no pose to search`; return; }
        const baseM = this.store.baseMatrix(it);
        const drive = this.teach.goToBaseMatrix(baseM, it.joints);
        if (!drive.converged) {
            this._status.textContent = `${it.name}: unreachable from this base`;
            return;
        }
        this.app.sceneManager?.redraw?.();
        if (this._altFor == null) this._altPrevTeach = this.app._teachActive; // remember once
        this.app._teachActive = true;
        this._altFor = it.id;
        this._status.textContent = `finding poses for ${it.name}…`;
        requestAnimationFrame(async () => {
            try {
                const list = await this.teach.findConfigurationsAsync(
                    baseM, {}, (p) => { this._status.textContent = `finding poses for ${it.name}… ${Math.round(p * 100)}%`; },
                );
                this._renderAlternates(it, list);
                const alts = list.filter((c) => !c.isCurrent).length;
                this._status.textContent = `${it.name}: ${alts} alternate configuration(s)`;
            } catch (e) {
                this._status.textContent = `find poses failed: ${e.message}`;
                console.error('[RobCo] waypoint alternates failed:', e);
            }
        });
    }

    _renderAlternates(it, list) {
        this._altBox.innerHTML = '';
        this._altBox.style.display = 'block';
        const head = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:3px;');
        const redundant = this.teach?.jointNames?.length > 6;
        head.append(el('span', 'flex:1;min-width:0;font-size:10px;color:#6e7681;text-transform:uppercase;letter-spacing:.04em;',
            `${it.name} — configs${redundant ? ' (sampled)' : ''}`));
        const close = el('button', BTN + 'padding:2px 7px;flex:0 0 auto;', '✕');
        close.title = 'close (resume live mirror)';
        close.addEventListener('click', () => this._clearAlternates());
        head.append(close);
        this._altBox.append(head);

        let n = 0;
        for (const cfg of list) {
            const row = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;padding:1px 3px;border-radius:5px;' +
                (cfg.isCurrent ? 'background:rgba(35,134,54,0.12);' : ''));
            const tight = cfg.minMarginDeg < 20;
            const color = cfg.isCurrent ? '#3fb950' : (tight ? '#d29922' : '#2f81f7');
            row.append(el('span', `display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${color};`));
            const labelText = cfg.isCurrent ? 'Captured' : `Config ${++n}`;
            row.append(el('span', 'flex:1;min-width:0;', labelText));
            if (!cfg.isCurrent) row.append(el('span', 'opacity:.7;font-size:10px;', `Δ${Math.round(cfg.dist)}°`));
            const margin = el('span', `opacity:.7;font-size:10px;${tight ? 'color:#d29922;' : ''}`, `m${Math.round(cfg.minMarginDeg)}°`);
            margin.title = 'worst-axis margin to the ±270° limit';
            row.append(margin);
            const prev = el('button', BTN + 'padding:2px 7px;flex:0 0 auto;', 'Preview');
            prev.title = cfg.deg.map((d) => d.toFixed(1)).join(', ') + '°';
            prev.addEventListener('click', () => {
                this.teach.applyConfig(cfg.deg);
                this.app.sceneManager?.redraw?.();
                for (const r of this._altBox.children) r.style.outline = '';
                row.style.outline = '1px solid #2f81f7';
                this._status.textContent = `previewing ${labelText} — use Capture / Send to apply`;
            });
            row.append(prev);
            this._altBox.append(row);
        }
    }

    _clearAlternates() {
        if (this._altFor != null) this.app._teachActive = this._altPrevTeach;
        this._altFor = null;
        if (this._altBox) { this._altBox.innerHTML = ''; this._altBox.style.display = 'none'; }
    }

    // --- push ----------------------------------------------------------
    /** Build the ordered step list for export from the store, solving IK / cartesian per the base.
     *  Steps carry their folder (group) so the builder can merge moves + emit Documentation Groups,
     *  their toolChange (→ setTool node), and kind:'node' rows pass through verbatim. */
    _buildSteps() {
        const steps = [];
        const unreachable = [];
        const noPose = [];
        for (const it of this.store.items) {
            const f = this.store.folderOf(it);
            const group = f ? { key: it.groupId, name: f.name, description: f.description || '', exportDoc: !!f.exportDoc } : null;
            const push = (s) => { if (group) s.group = group; steps.push(s); };
            if (it.kind === 'delay') { push({ kind: 'delay', seconds: it.seconds }); continue; }
            if (it.kind === 'payload') { push({ kind: 'payload', mass: it.mass, com: it.com }); continue; }
            if (it.kind === 'output') { push({ kind: 'output', bankId: it.bankId, outputId: it.outputId, state: it.state, delay: it.delay }); continue; }
            if (it.kind === 'tool') { push({ kind: 'tool', toolId: it.toolId ?? null }); continue; }
            if (it.kind === 'node') {
                push({
                    kind: 'node', nodeType: it.nodeType, raw: it.raw,
                    extraNodes: it.extraNodes, extraEdges: it.extraEdges, continueHandle: it.continueHandle,
                });
                continue;
            }
            const common = { name: it.name, velocity: it.velocity, acceleration: it.acceleration, blendingRadius: it.blendingRadius };
            if (it.mode === 'cartesian') {
                // Loaded cartesian → use its pose verbatim (base-relative truth). Captured → exact
                // RobFlow capture if available, else derive from the world pose at the current base.
                const c = it.cartesian
                    || (it.robflowPose?.position ? it.robflowPose : (it.worldPose ? this.store.cartesianBaseFrame(it) : null));
                if (!c?.position) { noPose.push(it.name); continue; }
                push({ kind: 'move', mode: 'cartesian', cartesian: { position: c.position, orientation: c.orientation }, ...common });
            } else if (it.worldPose) {
                const s = this.teach.solveBaseMatrix(this.store.baseMatrix(it), it.joints);
                if (!s.converged) { unreachable.push(it.name); continue; }
                push({ kind: 'move', mode: 'joint', joints: s.deg.map((d) => Math.round(d * 1000) / 1000), ...common });
            } else if (it.joints?.length) {
                // No world pose to re-solve against (e.g. a loaded joint move) — send joints as-is.
                push({ kind: 'move', mode: 'joint', joints: it.joints.map((d) => Math.round(d * 1000) / 1000), ...common });
            } else {
                noPose.push(it.name);
            }
        }
        const clampedBlend = this._clampBlending(steps);
        return { steps, unreachable, noPose, clampedBlend };
    }

    /**
     * Clamp each move's blending radius to ~half the distance to its nearest move neighbour (mm),
     * since RobFlow rejects a blend that overruns the segment. Returns the moves whose value was
     * actually reduced so the caller can surface it — otherwise a raised blend that lands above the
     * cap looks like "the edit did nothing".
     */
    _clampBlending(steps) {
        const moves = steps.filter((s) => s.kind === 'move');
        const pos = moves.map((m) => (m.mode === 'cartesian' ? m.cartesian.position : null));
        const clamped = [];
        for (let i = 0; i < moves.length; i++) {
            if (!pos[i]) continue; // joint move — distance unknown without FK; leave as set
            let maxR = Infinity;
            for (const j of [i - 1, i + 1]) {
                if (j < 0 || j >= moves.length || !pos[j]) continue;
                const d = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1], pos[i][2] - pos[j][2]);
                maxR = Math.min(maxR, d / 2);
            }
            if (!Number.isFinite(maxR)) continue;
            const capped = Math.min(moves[i].blendingRadius, Math.floor(maxR));
            if (capped < moves[i].blendingRadius) clamped.push(`${moves[i].name || `move ${i + 1}`}→${capped}mm`);
            moves[i].blendingRadius = capped;
        }
        return clamped;
    }

    async _push(run) {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        if (this.store.items.length === 0) { this._status.textContent = 'nothing to push'; return; }
        const { steps, unreachable, noPose, clampedBlend } = this._buildSteps();
        if (unreachable.length) {
            this._status.textContent = `unreachable from this base: ${unreachable.join(', ')} — reposition base or switch to cartesian`;
            return;
        }
        if (noPose.length) {
            this._status.textContent = `no usable pose for: ${noPose.join(', ')} — remove or re-capture those steps`;
            return;
        }
        if (!steps.length) { this._status.textContent = 'nothing pushable'; return; }
        const name = this._flowName.value || 'Viewer Flow';
        this._setBusy(true);
        try {
            const loop = this._loopCb ? this._loopCb.checked : true;
            const { flow, stepNodeIds } = buildSequenceFlow(name, steps, { flowUuid: this._currentFlowUuid || undefined, loop });
            let nodeIds = stepNodeIds;
            let uuid = flow.uuid;
            if (this._currentFlowUuid) {
                try {
                    await this.client.patchFlow(this._currentFlowUuid, flowGraphPatch(flow));
                    uuid = this._currentFlowUuid;
                } catch (e) {
                    if (!/\b404\b/.test(e.message)) throw e;
                    // The flow is gone (e.g. a reset cloud session) — import a fresh one.
                    const fresh = buildSequenceFlow(name, steps, { loop });
                    const created = await this.client.importFlow(fresh.flow);
                    uuid = created?.uuid || fresh.flow.uuid;
                    nodeIds = fresh.stepNodeIds;
                }
            } else {
                const created = await this.client.importFlow(flow);
                uuid = created?.uuid || flow.uuid;
            }
            // Re-key the steps to the nodes this push emitted, so per-node timing lines up.
            this.store.applyNodeIds(nodeIds);
            this._currentFlowUuid = uuid;
            this._loadedName = name;
            this._lastPush = { flowUuid: uuid, name };
            // Surface any blend reduced to fit its segment, so a raised value that hit the cap
            // doesn't look like the edit was ignored.
            const blendNote = clampedBlend.length ? ` · blend capped: ${clampedBlend.join(', ')}` : '';
            if (run) {
                await this._beginRun(uuid);
                this._status.textContent = `running "${name}" (${steps.length} step(s))${blendNote}`;
            } else {
                // Plain Push only updates the flow definition — a looping flow keeps the old params
                // until re-run, so nudge toward Run when the change should take effect live.
                this._status.textContent = `pushed "${name}" — ${steps.length} step(s) · press Run to apply${blendNote}`;
            }
        } catch (e) {
            const hint = /\b40[13]\b/.test(e.message) ? ' — editor login required (reconnect with the editor password)' : '';
            this._status.textContent = `push failed: ${e.message}${hint}`;
            console.error('[RobCo] waypoint push failed:', e);
        } finally {
            this._setBusy(false);
        }
    }

    async _runLast() {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        const uuid = this._currentFlowUuid || this._lastPush?.flowUuid;
        if (!uuid) { this._status.textContent = 'nothing pushed yet — Push first'; return; }
        this._runOnlyBtn.disabled = true;
        this._status.textContent = 'running…';
        try {
            await this._beginRun(uuid);
            this._status.textContent = `running "${this._lastPush?.name || this._flowName.value}"`;
        } catch (e) {
            const hint = /\b40[13]\b/.test(e.message) ? ' — editor login required' : '';
            this._status.textContent = `run failed: ${e.message}${hint}`;
        } finally {
            this._runOnlyBtn.disabled = false;
        }
    }

    /**
     * Start (or restart) a run. Our flows loop forever, so a prior run is usually still active —
     * stop first to clear FLOW_CONTINUOUS_RUNNING (else /run → 409), re-assert operational, reset
     * the cycle meter, then run. Retries once if the robot was still mid-stop.
     */
    async _beginRun(uuid) {
        await this.client.stop().catch(() => {});
        await this.client.setDesiredRobotState(2).catch(() => {});
        this.cycleTimer?.reset();
        this.nodeTimer?.rebase(); // don't count the idle gap since the last run into the first node
        try {
            await this.client.runFlow(uuid);
        } catch (e) {
            if (!/\b409\b/.test(e.message)) throw e;
            await new Promise((r) => setTimeout(r, 500));
            await this.client.setDesiredRobotState(2).catch(() => {});
            await this.client.runFlow(uuid);
        }
    }

    _setBusy(b) {
        this._pushBtn.disabled = this._runBtn.disabled = this._runOnlyBtn.disabled = b;
    }
}

function clampNum(v, lo, hi) {
    return Math.max(lo, Math.min(hi, +v || 0));
}
