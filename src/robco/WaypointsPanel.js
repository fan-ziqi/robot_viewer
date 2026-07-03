/**
 * Waypoints panel — an ordered teach SEQUENCE editor that round-trips with RobFlow flows.
 *
 * Load a RobFlow flow to pull its waypoints (joint + cartesian movements), delays and payloads into
 * the list + viewport markers, in execution order. Edit the sequence: capture poses, switch a row
 * between joint/cartesian, set per-row velocity/acceleration/blending, insert delays and payloads,
 * and drag rows to reorder. Push writes it back as a flow with INLINE poses — updating the loaded
 * flow in place (PATCH) or importing a new one. Consecutive same-mode moves export as one node; a
 * delay/payload/mode-change starts a new node. The whole body loops; a cycle marker times each pass.
 *
 * Draggable/minimizable, persisted position key `waypoints`.
 */
import * as THREE from 'three';
import { makeDraggable, makeCollapsible } from './draggable.js';
import { buildSequenceFlow, flowGraphPatch } from '../transport/flowBuilder.js';
import { parseFlow } from '../transport/flowParser.js';
import { DEFAULT_BLEND_MM } from './waypointStore.js';

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

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

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

    constructor({ app, teach, base, store, client, cycleTimer }) {
        this.app = app;
        this.teach = teach;
        this.base = base;
        this.store = store;
        this.client = client || null;
        this.cycleTimer = cycleTimer || null;
        this._currentFlowUuid = null; // the flow we round-trip to (loaded, or first import)
        this._dragFrom = null;
        this._build();
        this._bindCycleTimer();

        this.store.onChange = () => this._renderList();
        this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); };
        this.store.refreshReachability(this.teach);
    }

    update({ teach, base, store, client, cycleTimer }) {
        if (teach) this.teach = teach;
        if (base) { this.base = base; this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); }; }
        if (store) { this.store = store; this.store.onChange = () => this._renderList(); }
        if (client !== undefined) { this.client = client; this._refreshClientUi(); }
        if (cycleTimer) { this.cycleTimer = cycleTimer; this._bindCycleTimer(); }
        this._renderList();
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

        // --- add steps + count ---
        const topRow = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;');
        const capBtn = el('button', BTN, 'Capture');
        capBtn.addEventListener('click', () => this._capture());
        const delayBtn = el('button', BTN, '+ delay');
        delayBtn.addEventListener('click', () => { this.store.addDelay(1); this._status.textContent = 'added 1 s delay'; });
        const payBtn = el('button', BTN, '+ payload');
        payBtn.addEventListener('click', () => { this.store.addPayload(0, [0, 0, 0]); this._status.textContent = 'added payload step'; });
        const outBtn = el('button', BTN, '+ output');
        outBtn.title = 'Set a digital output at this point (native RobFlow setOutput node) — e.g. fire the gripper valve';
        outBtn.addEventListener('click', () => { this.store.addOutput(0, 0, true); this._status.textContent = 'added output step'; });
        topRow.append(capBtn, delayBtn, payBtn, outBtn);
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
        clearBtn.addEventListener('click', () => { this.store.clear(); this._currentFlowUuid = null; this._loadedName = null; });
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

    // --- capture / load ------------------------------------------------
    _capture() {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        const baseM = this.teach.tcpBaseMatrix();
        const worldM = this.base.baseToWorld(baseM);
        const robflowPose = (!this.app._teachActive && this.app._robcoLatestPose) ? this.app._robcoLatestPose : null;
        const it = this.store.add(worldM, this.teach.currentAnglesDeg(), null, robflowPose);
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
            const { steps, name, skipped } = parseFlow(flow);
            const specs = steps.map((s) => this._toSpec(s)).filter(Boolean);
            this.store.loadSteps(specs);
            this.store.refreshReachability(this.teach);
            this._currentFlowUuid = uuid;
            this._loadedName = name;
            if (name) this._flowName.value = name;
            const note = skipped.length ? ` · skipped node(s): ${skipped.join(', ')}` : '';
            this._status.textContent = `loaded "${name}" — ${specs.length} step(s)${note}`;
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

        items.forEach((it, idx) => {
            const row = el('div', 'display:flex;align-items:center;gap:5px;margin:2px 0;padding:1px 2px;border-radius:5px;');
            row.dataset.idx = String(idx);
            row.draggable = true;
            this._wireDrag(row, idx);
            const handle = el('span', 'cursor:grab;opacity:.45;flex:0 0 auto;', '⠿');
            row.append(handle);

            if (it.kind === 'delay') this._delayRow(row, it);
            else if (it.kind === 'payload') this._payloadRow(row, it);
            else if (it.kind === 'output') this._outputRow(row, it);
            else this._moveRow(row, it);

            this._list.append(row);
        });
        if (items.length === 0) this._list.append(el('div', 'opacity:.6;font-size:11px;', 'empty — Capture, +delay/+payload/+output, or Load a flow'));

        if (restore?.idx != null) {
            const sel = this._list.querySelector(`[data-idx="${restore.idx}"] [data-field="${restore.field}"]`);
            if (sel) { sel.focus(); try { sel.setSelectionRange(restore.s, restore.e); } catch { /* number inputs reject setSelectionRange */ } }
        }
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
        const go = el('button', BTN + 'padding:3px 6px;flex:0 0 auto;', 'Go');
        go.draggable = false;
        go.addEventListener('click', () => this._goTo(it));
        const del = this._delBtn(it.id);
        row.append(dot, name, modeBtn, vel, acc, blend, alt, go, del);
    }

    _delayRow(row, it) {
        row.style.background = 'rgba(210,153,34,0.12)';
        row.append(el('span', 'flex:0 0 auto;opacity:.85;', '⏱ delay'));
        const secs = numInput(it.seconds, { w: 56, step: 0.5, min: 0, field: 'seconds', onChange: (i) => this.store.update(it.id, { seconds: Math.max(0, +i.value || 0) }) });
        const spacer = el('span', 'flex:1;');
        row.append(secs, el('span', 'opacity:.6;', 's'), spacer, this._delBtn(it.id));
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
        row.append(el('span', 'opacity:.6;margin-left:4px;', 'CoM'), cx, cy, cz, el('span', 'opacity:.6;', 'mm'), this._delBtn(it.id));
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
        row.append(el('span', 'opacity:.6;', 'bank'), bank, el('span', 'opacity:.6;', 'io'), io, state, name, this._delBtn(it.id));
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
            row.style.opacity = '0.4';
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch { /* ignore */ }
        });
        row.addEventListener('dragend', () => { row.style.opacity = '1'; this._dragFrom = null; });
        row.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ } });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const from = this._dragFrom;
            const to = Number(row.dataset.idx);
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
    /** Build the ordered step list for export from the store, solving IK / cartesian per the base. */
    _buildSteps() {
        const steps = [];
        const unreachable = [];
        const noPose = [];
        for (const it of this.store.items) {
            if (it.kind === 'delay') { steps.push({ kind: 'delay', seconds: it.seconds }); continue; }
            if (it.kind === 'payload') { steps.push({ kind: 'payload', mass: it.mass, com: it.com }); continue; }
            if (it.kind === 'output') { steps.push({ kind: 'output', bankId: it.bankId, outputId: it.outputId, state: it.state, delay: it.delay }); continue; }
            const common = { name: it.name, velocity: it.velocity, acceleration: it.acceleration, blendingRadius: it.blendingRadius };
            if (it.mode === 'cartesian') {
                // Loaded cartesian → use its pose verbatim (base-relative truth). Captured → exact
                // RobFlow capture if available, else derive from the world pose at the current base.
                const c = it.cartesian
                    || (it.robflowPose?.position ? it.robflowPose : (it.worldPose ? this.store.cartesianBaseFrame(it) : null));
                if (!c?.position) { noPose.push(it.name); continue; }
                steps.push({ kind: 'move', mode: 'cartesian', cartesian: { position: c.position, orientation: c.orientation }, ...common });
            } else if (it.worldPose) {
                const s = this.teach.solveBaseMatrix(this.store.baseMatrix(it), it.joints);
                if (!s.converged) { unreachable.push(it.name); continue; }
                steps.push({ kind: 'move', mode: 'joint', joints: s.deg.map((d) => Math.round(d * 1000) / 1000), ...common });
            } else if (it.joints?.length) {
                // No world pose to re-solve against (e.g. a loaded joint move) — send joints as-is.
                steps.push({ kind: 'move', mode: 'joint', joints: it.joints.map((d) => Math.round(d * 1000) / 1000), ...common });
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
            const { flow } = buildSequenceFlow(name, steps, { flowUuid: this._currentFlowUuid || undefined });
            let uuid = flow.uuid;
            if (this._currentFlowUuid) {
                try {
                    await this.client.patchFlow(this._currentFlowUuid, flowGraphPatch(flow));
                    uuid = this._currentFlowUuid;
                } catch (e) {
                    if (!/\b404\b/.test(e.message)) throw e;
                    // The flow is gone (e.g. a reset cloud session) — import a fresh one.
                    const fresh = buildSequenceFlow(name, steps);
                    const created = await this.client.importFlow(fresh.flow);
                    uuid = created?.uuid || fresh.flow.uuid;
                }
            } else {
                const created = await this.client.importFlow(flow);
                uuid = created?.uuid || flow.uuid;
            }
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
