/**
 * TaktTimePanel — a takt-time (Gantt) diagram of the waypoint sequence.
 *
 * The ROBOT row is derived live from the WaypointStore: each folder renders as ONE rectangular
 * block (duration = summed last-execution time of its RobFlow nodes, from the NodeTimer), each
 * ungrouped step as its own block, laid out sequentially on a time axis. Layout is
 * pixel-cumulative — a block clamped to its minimum readable width pushes its neighbours right,
 * so blocks NEVER overlap — and timing updates patch the existing elements in place, so blocks
 * grow/shrink and slide smoothly (CSS transition) as new values are measured.
 *
 * A block shows its title, duration and description (always visible inside the block, full text
 * on hover), and — for folders — a ▸ that unfolds the sub-node list INSIDE the block (the block
 * grows; the row grows with it). Blocks without timing render dashed (a lone delay step estimates
 * from its seconds). CLICKING a robot block selects it: its waypoints stay visible in the 3D view
 * while every other marker is hidden (WaypointStore.isolate); click again to deselect.
 *
 * Below the robot row, CUSTOM rows can be added and configured individually (e.g. "Conveyor":
 * animate a new box, open a machine door). An element is either fully custom (title, start,
 * duration) or LINKED to an animated MTBH element (Material section): it then takes the MTBH's
 * name + animation duration and positions itself at the point in the robot sequence where the
 * animation's trigger output first switches ON (falls back to a manual start when the sequence
 * has no such output step). Elements are edited via a click-open popover and persist in
 * localStorage ('robco-takt-rows-v1').
 *
 * CAMERA rows (+ cam) hold camera SWITCHES: each switch names a Camera-panel rig and spans until
 * the next switch. Clicking a switch cuts the MASTER STREAM (one persistent pop-out window, ▶ in
 * the row label) to that camera; during a live run the playhead (the currently executing node)
 * cuts it automatically. Each segment carries a thumbnail filmstrip — one slot per interval
 * (settable in the row label): idle slots show the camera's current view, and during a run the
 * slot at the playhead is captured and pinned, building a filmstrip of the run.
 *
 * Navigation: mouse wheel zooms the time axis around the cursor; middle-mouse drag pans the view.
 * The label column is resizable (drag the handle on the axis row).
 * EDIT MODE (toolbar toggle): drag robot blocks to reorder the sequence (folders move as one),
 * drag custom blocks to shift their start time, and unfolded sub-node rows gain the Waypoints
 * panel's Go/✥ so a waypoint can be re-adjusted right from the diagram.
 *
 * Wide-screen panel: PANEL_DEFS docks it to the BOTTOM strip by default (drag it to any dock).
 * Draggable/minimizable, persisted position key `takt`.
 */
import { makeDraggable, makeCollapsible } from './draggable.js';
import { el, attachTip, fmtMs } from './uiKit.js';

const ROWS_KEY = 'robco-takt-rows-v1';
const EDIT_KEY = 'robco-takt-edit';
const LABELW_KEY = 'robco-takt-labelw';
const PANEL_CSS =
    'position:fixed;left:340px;bottom:16px;z-index:3000;width:720px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 8px;cursor:pointer;';
const INPUT = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;' +
    'color:#e6edf3;padding:2px 4px;font:inherit;';
const LABEL_W = 108;     // default label-column width (resizable via the handle on the axis row)
const LABEL_W_MIN = 64;
const LABEL_W_MAX = 340;
const ROW_H = 46;
const AXIS_H = 20;
const BLOCK_H = ROW_H - 12;
const DESC_H = 13;       // extra block height for the always-visible description line
const MIN_BLOCK_PX = 30;
const EXP_MIN_W = 190;   // an unfolded block needs room for its sub-node list
const SUB_ROW_H = 15;
const EST_S = 1;         // layout seconds for a block with no timing yet
const GAP_PX = 2;
const CAM_ROW_H = 64;    // camera rows are taller — they carry a thumbnail filmstrip
const THUMB_H = 34;
const THUMB_W = 56;
const ROW_COLORS = ['#39c5cf', '#d29922', '#db61a2', '#3fb950', '#8957e5'];

const uid = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const clampScale = (v) => Math.min(400, Math.max(4, v));

export class TaktTimePanel {
    static ensure(opts) {
        if (window._robcoTaktPanel) {
            window._robcoTaktPanel.update(opts);
            return window._robcoTaktPanel;
        }
        const p = new TaktTimePanel(opts);
        window._robcoTaktPanel = p;
        return p;
    }

    constructor({ store, nodeTimer }) {
        this.store = store;
        this.nodeTimer = nodeTimer || null;
        this._pxPerSec = null;        // null = auto-fit
        this._pop = null;             // the one open popover (custom-element editor)
        this._expanded = new Set();   // folder ids unfolded inside their block
        this._blockEls = new Map();   // block key -> {box, durEl} for in-place timing updates
        this._mtbhEls = [];           // MTBH-linked custom blocks — repositioned with the robot layout
        this._selectedKey = null;     // selected robot block (its waypoints isolated in 3D)
        this._blockKeysSig = '';      // structure signature of the last full render
        this._editMode = false;
        this._labelW = LABEL_W;       // resizable label-column width (persisted)
        this._thumbImgs = [];         // camera-row thumbnail slots of the last render
        try { this._editMode = localStorage.getItem(EDIT_KEY) === '1'; } catch { /* ignore */ }
        try {
            const w = +localStorage.getItem(LABELW_KEY);
            if (w) this._labelW = Math.min(LABEL_W_MAX, Math.max(LABEL_W_MIN, w));
        } catch { /* ignore */ }
        this._rows = this._loadRows();
        this._build();
        this._subscribe();
        this._render();
        // camera-row thumbnails refresh on a slow clock (only does work when slots exist)
        this._thumbTimer = setInterval(() => this._thumbTick(), 1000);
    }

    /** Shared label-cell style. IDENTICAL box metrics in the axis row and every timeline row —
     *  border-box with shared padding/border AND min-width:0 — or the 0s tick doesn't sit at the
     *  rows' start. (Without min-width:0, the row-name <input>'s intrinsic width inflates a
     *  custom row's label far beyond the column width — the flex "automatic minimum size" —
     *  shifting that row's whole timeline right.) */
    _labelCell() {
        return `flex:0 0 ${this._labelW}px;box-sizing:border-box;min-width:0;overflow:hidden;padding:0 6px 0 2px;` +
            'position:sticky;left:0;z-index:4;background:rgba(13,17,23,0.96);border-right:1px solid rgba(255,255,255,0.08);';
    }

    update({ store, nodeTimer }) {
        if (store && store !== this.store) { this._unsubStore?.(); this.store = store; this._unsubStore = store.subscribe?.(() => this._renderSoon()); }
        if (nodeTimer !== undefined && nodeTimer !== this.nodeTimer) {
            this._unsubTimer?.();
            this.nodeTimer = nodeTimer;
            if (nodeTimer) this._unsubTimer = nodeTimer.subscribe(() => this._timingsSoon());
        }
        this._render();
    }

    _subscribe() {
        this._unsubStore = this.store?.subscribe?.(() => this._renderSoon());
        if (this.nodeTimer) this._unsubTimer = this.nodeTimer.subscribe(() => this._timingsSoon());
    }

    /** Structure changed (steps/folders/rows) — full rebuild, debounced. */
    _renderSoon() {
        if (this._renderPending) return;
        this._renderPending = true;
        setTimeout(() => { this._renderPending = false; this._render(); }, 300);
    }

    /** Only timing values changed — patch blocks in place so they slide/resize smoothly. */
    _timingsSoon() {
        if (this._timingsPending) return;
        this._timingsPending = true;
        setTimeout(() => { this._timingsPending = false; this._refreshTimings(); }, 300);
    }

    // --- rows persistence ------------------------------------------------
    _loadRows() {
        try {
            const d = JSON.parse(localStorage.getItem(ROWS_KEY));
            if (Array.isArray(d)) return d;
        } catch { /* ignore */ }
        return [];
    }

    _saveRows() {
        try { localStorage.setItem(ROWS_KEY, JSON.stringify(this._rows)); } catch { /* ignore */ }
    }

    // --- build -------------------------------------------------------------
    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Takt Time  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        const bar = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;');
        this._totalLabel = el('span', 'font-size:11px;color:#9da7b3;flex:1;min-width:120px;', 'Σ —');
        const zoomOut = el('button', BTN, '−');
        zoomOut.title = 'zoom out (or scroll wheel over the timeline)';
        zoomOut.addEventListener('click', () => this._zoom(1 / 1.4));
        const zoomIn = el('button', BTN, '＋');
        zoomIn.title = 'zoom in (or scroll wheel over the timeline)';
        zoomIn.addEventListener('click', () => this._zoom(1.4));
        const fit = el('button', BTN, 'fit');
        fit.title = 'fit the whole cycle into the panel width';
        fit.addEventListener('click', () => { this._pxPerSec = null; this._render(); });
        this._editBtn = el('button', BTN + (this._editMode ? 'background:rgba(47,129,247,0.35);border-color:#2f81f7;' : ''), '✎ edit');
        this._editBtn.title = 'Edit mode: drag robot blocks to reorder the sequence, drag custom blocks to shift their start, and unfolded sub-nodes get Go/✥ (adjust the waypoint in 3D)';
        this._editBtn.addEventListener('click', () => {
            this._editMode = !this._editMode;
            try { localStorage.setItem(EDIT_KEY, this._editMode ? '1' : '0'); } catch { /* ignore */ }
            this._editBtn.style.cssText = BTN + (this._editMode ? 'background:rgba(47,129,247,0.35);border-color:#2f81f7;' : '');
            this._render();
        });
        const addRow = el('button', BTN, '+ row');
        addRow.title = 'add a configurable timeline row (e.g. conveyor, machine door)';
        addRow.addEventListener('click', () => {
            this._rows.push({ id: uid(), name: `Row ${this._rows.length + 1}`, elements: [] });
            this._saveRows();
            this._render();
        });
        const addCam = el('button', BTN, '+ cam');
        addCam.title = 'add a CAMERA row: place camera switches on the timeline, cut the master video stream, and show interval thumbnails';
        addCam.addEventListener('click', () => {
            this._rows.push({ id: uid(), kind: 'camera', name: 'Camera', intervalS: 2, elements: [] });
            this._saveRows();
            this._render();
        });
        bar.append(this._totalLabel, zoomOut, zoomIn, fit, this._editBtn, addRow, addCam);
        body.append(bar);

        // One horizontal scroller holds the axis + every row; the label column is sticky.
        this._scroll = el('div', 'overflow-x:auto;overflow-y:hidden;border-top:1px solid rgba(255,255,255,0.1);');
        this._wireScrollNav(this._scroll);
        body.append(this._scroll);
        this._hint = el('div', 'font-size:10px;color:#6e7681;margin-top:4px;', '');
        body.append(this._hint);

        makeCollapsible(body, minBtn, 'takt');
        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'takt');

        document.addEventListener('pointerdown', (e) => {
            if (this._pop && !this._pop.contains(e.target) && !this._pop._anchor?.contains?.(e.target)) this._closePop();
        }, true);
    }

    /** Wheel = zoom around the cursor; middle-mouse drag = pan the view window. */
    _wireScrollNav(sc) {
        sc.addEventListener('wheel', (e) => {
            e.preventDefault();
            const cur = this._pxPerSec || this._fitScale();
            const next = clampScale(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
            if (next === cur) return;
            const rect = sc.getBoundingClientRect();
            const viewX = e.clientX - rect.left - this._labelW;   // cursor offset inside the track view
            const contentX = sc.scrollLeft + viewX;          // content px under the cursor
            this._pxPerSec = next;
            this._render();
            sc.scrollLeft = Math.max(0, contentX * (next / cur) - viewX);
        }, { passive: false });
        sc.addEventListener('pointerdown', (e) => {
            if (e.button !== 1) return; // middle mouse: grab + pan
            e.preventDefault();
            sc.setPointerCapture(e.pointerId);
            sc.style.cursor = 'grabbing';
            let lastX = e.clientX;
            const move = (ev) => { sc.scrollLeft -= ev.clientX - lastX; lastX = ev.clientX; };
            const up = () => {
                sc.style.cursor = '';
                sc.removeEventListener('pointermove', move);
                sc.removeEventListener('pointerup', up);
            };
            sc.addEventListener('pointermove', move);
            sc.addEventListener('pointerup', up);
        });
    }

    _zoom(f) {
        this._pxPerSec = clampScale((this._pxPerSec || this._fitScale()) * f);
        this._render();
    }

    // --- robot row blocks ----------------------------------------------
    /** Sequence blocks: one per folder (members summed) / one per ungrouped step. */
    _robotBlocks() {
        const items = this.store?.items || [];
        const folders = this.store?.folders || {};
        const blocks = [];
        let i = 0;
        while (i < items.length) {
            const it = items[i];
            const fid = it.groupId && folders[it.groupId] ? it.groupId : null;
            if (fid) {
                const startIdx = i;
                const members = [];
                while (i < items.length && items[i].groupId === fid) { members.push(items[i]); i += 1; }
                const f = folders[fid];
                blocks.push({ key: `f:${fid}`, fid, title: f.name, description: f.description || '', color: f.color, members, startIdx });
            } else {
                blocks.push({ key: `i:${it.id}`, fid: null, title: this._stepLabel(it), description: '', color: null, members: null, item: it, startIdx: i });
                i += 1;
            }
        }
        for (const b of blocks) {
            const ids = [...new Set((b.members || [b.item]).map((m) => m?.srcNodeId).filter(Boolean))];
            let ms = 0;
            let n = 0;
            for (const id of ids) {
                const v = this.nodeTimer?.msFor?.(id);
                if (v != null) { ms += v; n += 1; }
            }
            b.ms = n > 0 ? ms : null;
            b.timed = n;
            b.of = ids.length;
            // a lone delay step knows its own duration — use it as an estimate until timed
            if (b.ms == null && b.item?.kind === 'delay') { b.ms = (b.item.seconds || 0) * 1000; b.est = true; }
        }
        return blocks;
    }

    _stepLabel(it) {
        if (it.kind === 'move') return it.name || 'move';
        if (it.kind === 'delay') return `delay ${it.seconds}s`;
        if (it.kind === 'payload') return 'payload';
        if (it.kind === 'output') return `out ${it.bankId}/${it.outputId}`;
        if (it.kind === 'tool') return 'tool change';
        if (it.kind === 'node') return it.nodeType || 'node';
        return it.kind;
    }

    // --- MTBH-linked elements ---------------------------------------------
    /** The MaterialManager item a custom element is linked to (null = fully custom / gone). */
    _mtbhFor(e2) {
        if (!e2.mtbhId) return null;
        return (window._robcoMaterialManager?.items || []).find((it) => it.cfg.id === e2.mtbhId) || null;
    }

    /** MTBH elements offered in the link picker: animation configured (clones are transient). */
    _animatedMtbhs() {
        return (window._robcoMaterialManager?.items || []).filter((it) => it.cfg.anim?.enabled && it.cfg.kind !== 'clone');
    }

    /**
     * Where output bank/io first switches ON in the robot sequence: cumulative seconds from 0
     * plus — when the blocks carry layout (xPx/wPx) — the exact pixel position, so the element
     * aligns with the (possibly min-width-clamped) robot block that triggers it.
     * Null when the sequence has no such output step.
     */
    _triggerPoint(bank, io, blocks) {
        let accS = 0;
        for (const b of blocks) {
            const durS = b.ms != null ? b.ms / 1000 : EST_S;
            let inS = 0;
            const seen = new Set();
            for (const m of (b.members || [b.item])) {
                if (!m) continue;
                if (m.kind === 'output' && m.state && m.bankId === bank && m.outputId === io) {
                    const s = Math.min(inS, durS);
                    const frac = durS > 0 ? s / durS : 0;
                    return { s: accS + s, xPx: b.xPx != null ? b.xPx + frac * b.wPx : null };
                }
                if (m.srcNodeId) {
                    if (seen.has(m.srcNodeId)) continue; // merged movement — same node as above
                    seen.add(m.srcNodeId);
                    const ms = this.nodeTimer?.msFor?.(m.srcNodeId);
                    if (ms != null) inS += ms / 1000;
                    else if (m.kind === 'delay') inS += m.seconds || 0;
                } else if (m.kind === 'delay') {
                    inS += m.seconds || 0;
                }
            }
            accS += durS;
        }
        return null;
    }

    /**
     * Effective timing of a row element. MTBH-linked elements take the animation's duration and
     * start at their trigger output's position in the robot sequence (stored startS = fallback
     * when the sequence has no such output step).
     */
    _elementTiming(e2, blocks) {
        const mtbh = this._mtbhFor(e2);
        if (!mtbh) return { startS: e2.startS || 0, durS: e2.durS || 1, mtbh: null, trigger: null };
        const a = mtbh.cfg.anim;
        const trigger = a?.enabled ? this._triggerPoint(a.bank, a.io, blocks) : null;
        return { startS: trigger ? trigger.s : (e2.startS || 0), durS: (a?.dur > 0 ? a.dur : 1), mtbh, trigger };
    }

    /**
     * Pixel-cumulative layout: width from duration, clamped to stay readable; each block starts
     * where the previous one ends, so clamped blocks push their neighbours instead of overlapping.
     * @returns {number} total content width (px)
     */
    _layoutBlocks(blocks, px) {
        let x = 0;
        for (const b of blocks) {
            const durS = b.ms != null ? b.ms / 1000 : EST_S;
            b.wPx = Math.max(this._expanded.has(b.fid) ? EXP_MIN_W : MIN_BLOCK_PX, durS * px - GAP_PX);
            b.xPx = x;
            x += b.wPx + GAP_PX;
        }
        return x;
    }

    /** Auto-fit scale: whole cycle into the visible track width. */
    _fitScale() {
        const blocks = this._robotBlocks();
        let robotS = 0;
        for (const b of blocks) robotS += (b.ms != null ? b.ms / 1000 : EST_S);
        let customS = 0;
        for (const r of this._rows) {
            for (const e2 of r.elements) {
                const t = this._elementTiming(e2, blocks);
                customS = Math.max(customS, t.startS + t.durS);
            }
        }
        const total = Math.max(robotS, customS, 1);
        const avail = Math.max(220, (this._scroll?.clientWidth || 680) - this._labelW - 24);
        return clampScale(avail / total);
    }

    // --- render ----------------------------------------------------------
    _render() {
        if (!this._scroll) return;
        this._closePop();
        const px = this._pxPerSec || this._fitScale();
        const blocks = this._robotBlocks();
        const robotW = this._layoutBlocks(blocks, px);

        // keep the 3D isolation in sync with the selected block: clear it when the block is
        // gone, re-assert it otherwise (its member set may have changed since the last render)
        if (this._selectedKey) {
            const sel = blocks.find((b) => b.key === this._selectedKey);
            if (!sel) {
                this._selectedKey = null;
                this.store?.isolate?.(null);
            } else {
                this.store?.isolate?.((sel.members || (sel.item ? [sel.item] : []))
                    .filter((m) => m.kind === 'move').map((m) => m.id));
            }
        }

        let totalS = Math.max(robotW / px, 1);
        for (const r of this._rows) {
            for (const e2 of r.elements) {
                const t = this._elementTiming(e2, blocks);
                totalS = Math.max(totalS, t.startS + t.durS);
            }
        }
        const trackW = Math.ceil(totalS * px) + 80;

        this._updateTotalLabel(blocks);
        this._blockEls = new Map();
        this._mtbhEls = [];
        this._blockKeysSig = blocks.map((b) => b.key).join('|') + `#${[...this._expanded].join(',')}#${this._editMode}`;

        this._scroll.innerHTML = '';
        const inner = el('div', `min-width:${this._labelW + trackW}px;`);
        this._scroll.append(inner);
        this._axisTrack = null;
        inner.append(this._axisRow(totalS, px, trackW));

        // robot row — height grows with the tallest block (description line / unfolded sub-list)
        const tallest = blocks.reduce((h, b) => Math.max(h, this._blockH(b)), BLOCK_H);
        const rowH = Math.max(ROW_H, tallest + 12);
        this._robotTrack = this._rowShell(inner, 'Robot', null, rowH);
        for (const b of blocks) this._robotTrack.append(this._block(b, px));
        if (!blocks.length) {
            this._robotTrack.append(el('div', 'position:absolute;left:8px;top:14px;font-size:10px;color:#6e7681;',
                'no steps — capture waypoints or load a flow'));
        }

        // custom + camera rows
        this._thumbImgs = [];
        for (const [ri, row] of this._rows.entries()) {
            if (row.kind === 'camera') {
                const track = this._rowShell(inner, row, '#e3873a', CAM_ROW_H);
                for (const seg of this._cameraSegments(row, totalS)) track.append(this._cameraBlock(row, seg, px));
                if (!row.elements.length) {
                    track.append(el('div', 'position:absolute;left:8px;top:24px;font-size:10px;color:#6e7681;',
                        'no switches — ＋ adds one; each switch cuts the master stream to its camera'));
                }
                continue;
            }
            const tall = row.elements.reduce((h, e2) => Math.max(h, BLOCK_H + (e2.description ? DESC_H : 0)), BLOCK_H);
            const track = this._rowShell(inner, row, ROW_COLORS[ri % ROW_COLORS.length], Math.max(ROW_H, tall + 12));
            for (const e2 of row.elements) track.append(this._customBlock(row, e2, px, ROW_COLORS[ri % ROW_COLORS.length], blocks));
        }
        this._fillThumbsFromCache();

        this._hint.textContent = (this.nodeTimer
            ? 'durations = last execution per RobFlow node · wheel: zoom · middle-mouse: pan · click a robot block: show only its waypoints in 3D'
            : 'connect a live session to measure durations · wheel: zoom · middle-mouse: pan · click a robot block: show only its waypoints in 3D')
            + (this._editMode ? ' · EDIT: drag blocks to reorder / shift' : '');
    }

    /** A robot block's rendered height: base + description line + unfolded sub-node list. */
    _blockH(b) {
        const expanded = b.members && this._expanded.has(b.fid);
        return BLOCK_H + (b.description ? DESC_H : 0) + (expanded ? b.members.length * SUB_ROW_H + 8 : 0);
    }

    _updateTotalLabel(blocks) {
        let robotS = 0;
        for (const b of blocks) robotS += (b.ms != null ? b.ms / 1000 : EST_S);
        const timed = blocks.filter((b) => b.ms != null && !b.est).length;
        this._totalLabel.textContent = `Robot Σ ${robotS > 0 ? fmtMs(robotS * 1000) : '—'}`
            + (blocks.length ? ` · ${timed}/${blocks.length} block(s) timed` : '');
    }

    /** New timing values: same structure → patch left/width/labels in place (CSS animates). */
    _refreshTimings() {
        const blocks = this._robotBlocks();
        const sig = blocks.map((b) => b.key).join('|') + `#${[...this._expanded].join(',')}#${this._editMode}`;
        if (sig !== this._blockKeysSig || !this._blockEls.size) { this._render(); return; }
        const px = this._pxPerSec || this._fitScale();
        this._layoutBlocks(blocks, px);
        for (const b of blocks) {
            const rec = this._blockEls.get(b.key);
            if (!rec) { this._render(); return; }
            rec.box.style.left = `${b.xPx}px`;
            rec.box.style.width = `${b.wPx}px`;
            rec.box.style.borderStyle = (b.ms == null || b.est) ? 'dashed' : 'solid';
            rec.durEl.textContent = this._durText(b);
        }
        // MTBH-linked elements ride on the robot layout — slide them along with their trigger
        for (const rec of this._mtbhEls || []) {
            const t = this._elementTiming(rec.e2, blocks);
            rec.box.style.left = `${t.trigger?.xPx != null ? t.trigger.xPx : t.startS * px}px`;
            rec.box.style.width = `${Math.max(MIN_BLOCK_PX, t.durS * px - GAP_PX)}px`;
        }
        this._updateTotalLabel(blocks);
    }

    _durText(b) {
        return b.ms != null
            ? `${b.est ? '~' : ''}${fmtMs(b.ms)}${b.members && b.timed < b.of ? ` (${b.timed}/${b.of})` : ''}`
            : 'not timed';
    }

    /** Axis with adaptive ticks + the label-column resize handle. */
    _axisRow(totalS, px, trackW) {
        const row = el('div', `display:flex;height:${AXIS_H}px;`);
        const label = el('div', this._labelCell() + 'border-right-color:transparent;');
        label.append(this._labelResizeHandle());
        const track = el('div', `position:relative;width:${trackW}px;flex:0 0 auto;`);
        const stepS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s * px >= 46) || 120;
        for (let s = 0; s <= totalS + stepS; s += stepS) {
            track.append(
                el('div', `position:absolute;left:${s * px}px;top:6px;bottom:0;width:1px;background:rgba(255,255,255,0.12);`),
                el('div', `position:absolute;left:${s * px + 3}px;top:3px;font-size:9px;color:#6e7681;`,
                    stepS < 1 ? `${s.toFixed(1)}s` : `${s}s`),
            );
        }
        row.append(label, track);
        return row;
    }

    /** Drag handle on the axis label's right edge: resize the label (row-description) column. */
    _labelResizeHandle() {
        const h = el('div', 'position:absolute;right:-1px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:5;' +
            'border-right:2px solid rgba(255,255,255,0.18);');
        h.title = 'drag to resize the row-label column';
        h.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = this._labelW;
            let raf = null;
            // listeners live on document — the re-render destroys and recreates the handle itself
            const move = (ev) => {
                this._labelW = Math.min(LABEL_W_MAX, Math.max(LABEL_W_MIN, startW + ev.clientX - startX));
                if (!raf) raf = requestAnimationFrame(() => { raf = null; this._render(); });
            };
            const up = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                try { localStorage.setItem(LABELW_KEY, String(this._labelW)); } catch { /* ignore */ }
                this._render();
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        });
        return h;
    }

    /** Row = sticky label cell + relative track. `rowOrName` is 'Robot' or a custom row object. */
    _rowShell(inner, rowOrName, color, rowH) {
        const isRobot = typeof rowOrName === 'string';
        const wrap = el('div', `display:flex;height:${rowH}px;border-top:1px solid rgba(255,255,255,0.07);`);
        const label = el('div', this._labelCell() + 'display:flex;align-items:center;gap:4px;');
        if (isRobot) {
            label.append(el('span', 'font-weight:600;font-size:11px;', rowOrName));
        } else {
            const row = rowOrName;
            const isCam = row.kind === 'camera';
            const chip = el('span', `width:8px;height:8px;border-radius:2px;flex:0 0 auto;background:${color};`);
            const name = el('input', INPUT + 'flex:1;min-width:0;font-size:11px;background:transparent;border:0;border-bottom:1px dashed rgba(255,255,255,0.18);border-radius:0;');
            name.value = row.name;
            name.addEventListener('change', () => { row.name = name.value; this._saveRows(); });
            label.append(chip, name);
            if (isCam) {
                const iv = el('input', INPUT + 'width:30px;text-align:right;font-size:10px;');
                iv.type = 'number'; iv.step = '0.5'; iv.min = '0.5'; iv.value = String(row.intervalS || 2);
                iv.title = 'thumbnail interval (s) — one small image per interval along the timeline';
                iv.addEventListener('change', () => {
                    row.intervalS = Math.max(0.5, +iv.value || 2);
                    this._thumbCacheFor(row).clear(); // slot times changed
                    this._saveRows();
                    this._render();
                });
                const master = el('button', BTN + 'padding:1px 5px;', '▶');
                master.title = 'open the MASTER STREAM window — the one feed the camera switches cut';
                master.addEventListener('click', () => { window._robcoCameraView?.openMaster?.(); this._render(); });
                label.append(iv, master);
            }
            const add = el('button', BTN + 'padding:1px 5px;', '＋');
            add.title = isCam ? 'add a camera switch to this row' : 'add an element to this row';
            add.addEventListener('click', () => {
                if (isCam) {
                    const cv = window._robcoCameraView;
                    const last = row.elements.reduce((m, e2) => Math.max(m, e2.startS || 0), -5);
                    row.elements.push({ id: uid(), camId: cv?.rigs?.[0]?.cfg.id || '', startS: Math.max(0, last + 5) });
                } else {
                    row.elements.push({ id: uid(), title: 'element', description: '', startS: 0, durS: 1 });
                }
                this._saveRows();
                this._render();
            });
            const del = el('button', BTN + 'padding:1px 5px;', '✕');
            del.title = 'delete this row';
            del.addEventListener('click', () => {
                this._rows = this._rows.filter((r) => r !== row);
                this._saveRows();
                this._render();
            });
            label.append(add, del);
        }
        const track = el('div', 'position:relative;flex:1;');
        wrap.append(label, track);
        inner.append(wrap);
        return track;
    }

    /** Robot-row block: title + duration + description (always inside); ▸ unfolds the sub-node
     *  list INSIDE; click selects it (only its waypoints stay visible in 3D). */
    _block(b, px) {
        const expanded = b.members && this._expanded.has(b.fid);
        const selected = b.key === this._selectedKey;
        const box = el('div',
            `position:absolute;left:${b.xPx}px;top:5px;height:${this._blockH(b)}px;width:${b.wPx}px;box-sizing:border-box;` +
            `border-radius:6px;padding:3px 6px;overflow:hidden;` +
            `transition:left .35s ease,width .35s ease;` +
            `${expanded ? 'z-index:3;' : ''}` +
            `background:${expanded ? 'rgba(22,27,34,0.97)' : (b.color ? hexA(b.color, 0.16) : 'rgba(110,118,129,0.14)')};` +
            `border:1px ${b.ms == null || b.est ? 'dashed' : 'solid'} ${b.color ? hexA(b.color, 0.75) : 'rgba(139,152,165,0.6)'};` +
            `${selected ? 'box-shadow:0 0 0 1.5px #2f81f7,0 0 10px rgba(47,129,247,0.55);' : ''}` +
            `cursor:${this._editMode ? 'grab' : 'pointer'};`);
        const top = el('div', 'display:flex;align-items:center;gap:4px;min-width:0;');
        if (b.members) {
            const tri = el('span', 'cursor:pointer;flex:0 0 auto;opacity:.8;font-size:10px;', expanded ? '▾' : '▸');
            tri.title = expanded ? 'fold the sub-node list' : 'unfold the sub-nodes inside this block';
            tri.addEventListener('pointerdown', (e) => e.stopPropagation());
            tri.addEventListener('click', (e) => {
                e.stopPropagation();
                if (expanded) this._expanded.delete(b.fid);
                else this._expanded.add(b.fid);
                this._render();
            });
            top.append(tri);
        }
        top.append(el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px;', b.title || '—'));
        const dur = el('div', 'font-size:10px;color:#9da7b3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', this._durText(b));
        box.append(top, dur);
        if (b.description) box.append(this._descLine(b.description));
        if (expanded) box.append(this._subList(b));
        if (!expanded) {
            box.title = b.ms == null ? 'no timing yet — run the flow with a live session' : '';
        }
        box.addEventListener('click', (e) => {
            if (box._dragged) { box._dragged = false; return; }
            if (e.target.closest('input,button,textarea')) return;
            this._selectBlock(selected ? null : b);
        });
        if (this._editMode) this._wireBlockDrag(box, b, px);
        this._blockEls.set(b.key, { box, durEl: dur });
        return box;
    }

    /** The always-visible description line inside a block (full text on hover when clipped). */
    _descLine(text) {
        const d = el('div', `height:${DESC_H}px;font-size:9px;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`, text);
        attachTip(d, () => text);
        return d;
    }

    /** Select a robot block (null = deselect): 3D shows ONLY its waypoints via the store. */
    _selectBlock(b) {
        this._selectedKey = b ? b.key : null;
        if (!b) this.store?.isolate?.(null);
        this._render(); // (re)asserts the isolation for the selected block
    }

    /** The sub-node list rendered INSIDE an unfolded folder block. */
    _subList(b) {
        const list = el('div', 'margin-top:2px;border-top:1px solid rgba(255,255,255,0.12);padding-top:2px;');
        const wpp = window._robcoWaypointsPanel;
        const seen = new Set();
        for (const m of b.members) {
            const line = el('div', `display:flex;align-items:center;gap:5px;height:${SUB_ROW_H}px;font-size:10px;`);
            line.append(el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', this._stepLabel(m)));
            let txt = '—';
            if (m.srcNodeId) {
                const ms = this.nodeTimer?.msFor?.(m.srcNodeId);
                if (seen.has(m.srcNodeId)) txt = '〃'; // same node as the row above (merged movement)
                else if (ms != null) txt = fmtMs(ms);
                seen.add(m.srcNodeId);
            }
            line.append(el('span', 'flex:0 0 auto;color:#9da7b3;', txt));
            if (this._editMode && m.kind === 'move' && wpp) {
                const giz = el('span', 'flex:0 0 auto;cursor:pointer;opacity:.75;', '✥');
                giz.title = 'adjust this waypoint with the 3D gizmo';
                giz.addEventListener('pointerdown', (e) => e.stopPropagation());
                giz.addEventListener('click', (e) => { e.stopPropagation(); wpp._editWaypoint(m); });
                const go = el('span', 'flex:0 0 auto;cursor:pointer;opacity:.75;', '▶');
                go.title = 'drive / preview to this waypoint';
                go.addEventListener('pointerdown', (e) => e.stopPropagation());
                go.addEventListener('click', (e) => { e.stopPropagation(); wpp._goTo(m); });
                line.append(giz, go);
            }
            list.append(line);
        }
        return list;
    }

    /** EDIT MODE: drag a robot block horizontally to reorder the sequence. */
    _wireBlockDrag(box, b, px) {
        box.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('input,button,textarea')) return;
            const startX = e.clientX;
            let active = false;
            let marker = null;
            const track = this._robotTrack;
            const all = this._robotBlocks();
            this._layoutBlocks(all, px);
            const boundaries = [...all.map((x) => x.xPx), all.length ? all[all.length - 1].xPx + all[all.length - 1].wPx + GAP_PX : 0];
            const insertionAt = (clientX) => {
                const r = track.getBoundingClientRect();
                const cx = clientX - r.left;
                let best = 0;
                let dist = Infinity;
                boundaries.forEach((bx, k) => { const d = Math.abs(cx - bx); if (d < dist) { dist = d; best = k; } });
                return best;
            };
            const move = (ev) => {
                if (!active) {
                    if (Math.abs(ev.clientX - startX) < 5) return;
                    active = true;
                    box.setPointerCapture(e.pointerId);
                    box.style.opacity = '0.45';
                    box.style.cursor = 'grabbing';
                    marker = el('div', 'position:absolute;top:2px;bottom:2px;width:2px;background:#2f81f7;border-radius:1px;box-shadow:0 0 6px rgba(47,129,247,.9);z-index:5;');
                    track.append(marker);
                }
                marker.style.left = `${boundaries[insertionAt(ev.clientX)] - 1}px`;
            };
            const up = (ev) => {
                box.removeEventListener('pointermove', move);
                box.removeEventListener('pointerup', up);
                if (!active) return;
                box._dragged = true; // suppress the click that follows a real drag
                box.style.opacity = '1';
                box.style.cursor = 'grab';
                marker?.remove();
                const k = insertionAt(ev.clientX);
                const items = this.store.items;
                const targetIdx = k < all.length ? all[k].startIdx : items.length;
                if (b.fid) {
                    this.store.moveFolder(b.fid, targetIdx);
                } else {
                    const from = items.indexOf(b.item);
                    if (from >= 0 && from !== targetIdx) this.store.moveStep(from, targetIdx);
                }
            };
            box.addEventListener('pointermove', move);
            box.addEventListener('pointerup', up);
        });
    }

    // --- camera rows --------------------------------------------------------
    /** Switches sorted by time; each spans until the next one (the last until the cycle end). */
    _cameraSegments(row, totalS) {
        const els = [...row.elements].sort((a, b) => (a.startS || 0) - (b.startS || 0));
        return els.map((e2, i) => ({
            e2,
            startS: e2.startS || 0,
            endS: i + 1 < els.length ? (els[i + 1].startS || 0) : Math.max(totalS, (e2.startS || 0) + 1),
        }));
    }

    /** A camera switch: colored per camera, ● LIVE while it feeds the master stream, with a
     *  thumbnail filmstrip (one slot per interval). Click = cut the master stream to it. */
    _cameraBlock(row, seg, px) {
        const cv = window._robcoCameraView;
        const rigIdx = cv ? cv.rigs.findIndex((r) => r.cfg.id === seg.e2.camId) : -1;
        const rig = rigIdx >= 0 ? cv.rigs[rigIdx] : null;
        const color = rig ? ROW_COLORS[rigIdx % ROW_COLORS.length] : '#8b949e';
        const live = rig && cv.masterCameraId() === rig.cfg.id;
        const w = Math.max(MIN_BLOCK_PX, (seg.endS - seg.startS) * px - GAP_PX);
        const box = el('div',
            `position:absolute;left:${seg.startS * px}px;top:5px;height:${CAM_ROW_H - 10}px;width:${w}px;box-sizing:border-box;` +
            'border-radius:6px;padding:2px 6px;overflow:hidden;transition:left .2s ease,width .2s ease;' +
            `cursor:${this._editMode ? 'grab' : 'pointer'};` +
            `background:${hexA(color, 0.13)};border:1px ${rig ? 'solid' : 'dashed'} ${hexA(color, 0.7)};` +
            `${live ? 'box-shadow:0 0 0 1.5px #f85149,0 0 10px rgba(248,81,73,0.5);' : ''}`);
        const top = el('div', 'display:flex;align-items:center;gap:4px;min-width:0;');
        top.append(el('span', 'flex:0 0 auto;font-size:10px;opacity:.8;', '🎥'));
        top.append(el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px;',
            rig ? rig.cfg.name : '(pick camera)'));
        if (live) top.append(el('span', 'flex:0 0 auto;font-size:9px;color:#f85149;font-weight:700;', '● LIVE'));
        box.append(top);
        box.title = rig
            ? `switch to "${rig.cfg.name}" on the master stream${this._editMode ? ' (drag to move the switch)' : ''}`
            : 'no camera picked yet — click to configure';

        // thumbnail filmstrip: one slot per interval within the segment
        const strip = el('div', `position:relative;height:${THUMB_H}px;margin-top:2px;`);
        const iv = Math.max(0.5, row.intervalS || 2);
        let n = 0;
        for (let t = Math.ceil(seg.startS / iv) * iv; t < seg.endS && n < 60; t += iv, n += 1) {
            const img = el('img', `position:absolute;left:${(t - seg.startS) * px}px;top:0;width:${THUMB_W}px;height:${THUMB_H}px;` +
                'object-fit:cover;border-radius:3px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);');
            img.title = `${t}s · ${rig ? rig.cfg.name : '?'}`;
            strip.append(img);
            if (rig) this._thumbImgs.push({ img, row, camId: rig.cfg.id, t });
        }
        box.append(strip);

        if (this._editMode) {
            // drag to move the switch time; a plain click opens the editor
            let moved = false;
            box.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                const startX = e.clientX;
                const origS = seg.e2.startS || 0;
                moved = false;
                const move = (ev) => {
                    const dS = (ev.clientX - startX) / px;
                    if (!moved && Math.abs(ev.clientX - startX) < 4) return;
                    if (!moved) { moved = true; box.setPointerCapture(e.pointerId); box.style.transition = 'none'; }
                    seg.e2.startS = Math.max(0, Math.round((origS + dS) * 10) / 10);
                    box.style.left = `${seg.e2.startS * px}px`;
                };
                const up = () => {
                    box.removeEventListener('pointermove', move);
                    box.removeEventListener('pointerup', up);
                    if (moved) { this._thumbCacheFor(row).clear(); this._saveRows(); this._render(); }
                };
                box.addEventListener('pointermove', move);
                box.addEventListener('pointerup', up);
            });
            box.addEventListener('click', () => { if (!moved) this._toggleCamEditorPop(box, row, seg.e2); });
        } else {
            box.addEventListener('click', () => {
                if (!cv || !rig) { this._toggleCamEditorPop(box, row, seg.e2); return; }
                if (!cv.hasMaster()) cv.openMaster();
                cv.setMasterCamera(rig.cfg.id);
                this._render(); // move the LIVE badge
            });
        }
        return box;
    }

    /** Click-open editor for a camera switch: which camera, when, delete. */
    _toggleCamEditorPop(anchor, row, e2) {
        if (this._pop?._anchor === anchor) { this._closePop(); return; }
        this._closePop();
        const pop = el('div', 'position:fixed;z-index:5100;width:230px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
            'color:#e6edf3;background:#10161d;border:1px solid rgba(255,255,255,0.16);border-radius:8px;padding:8px;' +
            'box-shadow:0 10px 28px rgba(0,0,0,0.55);display:flex;flex-direction:column;gap:5px;');
        const field = (lbl, input) => {
            const r = el('div', 'display:flex;align-items:center;gap:6px;');
            r.append(el('span', 'flex:0 0 52px;opacity:.7;', lbl), input);
            return r;
        };
        const cv = window._robcoCameraView;
        const sel = el('select', INPUT + 'flex:1;min-width:0;color-scheme:dark;');
        const opt = (v, label, s) => {
            const o = el('option', 'background:#0d1117;color:#e6edf3;', label);
            o.value = v;
            if (s) o.selected = true;
            sel.append(o);
        };
        if (!e2.camId) opt('', '(pick camera)', true);
        for (const r of cv?.rigs || []) opt(r.cfg.id, r.cfg.name, e2.camId === r.cfg.id);
        if (e2.camId && !(cv?.rigs || []).some((r) => r.cfg.id === e2.camId)) opt(e2.camId, '(missing camera)', true);
        sel.addEventListener('change', () => {
            e2.camId = sel.value;
            this._thumbCacheFor(row).clear();
            this._saveRows();
            this._render();
        });
        const start = el('input', INPUT + 'width:64px;text-align:right;');
        start.type = 'number'; start.step = '0.1'; start.min = '0'; start.value = String(e2.startS ?? 0);
        start.addEventListener('change', () => {
            e2.startS = Math.max(0, +start.value || 0);
            this._thumbCacheFor(row).clear();
            this._saveRows();
            this._render();
        });
        const del = el('button', BTN + 'align-self:flex-end;border-color:rgba(248,81,73,0.6);', 'delete');
        del.addEventListener('click', () => {
            row.elements = row.elements.filter((x) => x !== e2);
            this._saveRows();
            this._closePop();
            this._render();
        });
        pop.append(field('camera', sel), field('start s', start), del);
        this._openPop(pop, anchor);
    }

    /** Live playhead: cumulative time of the block whose node is currently executing, or null
     *  (no live session / idle). Block granularity — good enough to place captures and cuts. */
    _playheadPoint(blocks) {
        const openId = this.nodeTimer?.currentNodeId?.();
        if (!openId) return null;
        let accS = 0;
        for (const b of blocks) {
            if ((b.members || [b.item]).some((m) => m?.srcNodeId === openId)) return { s: accS };
            accS += b.ms != null ? b.ms / 1000 : EST_S;
        }
        return null;
    }

    // --- camera-row thumbnails --------------------------------------------
    _thumbCacheFor(row) {
        if (!this._thumbCache) this._thumbCache = new Map();
        let m = this._thumbCache.get(row.id);
        if (!m) { m = new Map(); this._thumbCache.set(row.id, m); }
        return m;
    }

    /** After a full render: restore captured (pinned) thumbnails into the fresh slots. */
    _fillThumbsFromCache() {
        for (const rec of this._thumbImgs) {
            const url = this._thumbCacheFor(rec.row).get(rec.t);
            if (url) rec.img.src = url;
        }
    }

    /**
     * 1 s clock. During a LIVE run: capture the slot at the playhead and PIN it (a filmstrip of
     * the run builds up along the timeline), and auto-cut the master stream to the camera whose
     * segment contains the playhead. Idle: uncached slots show their camera's current view.
     */
    _thumbTick() {
        if (!this._thumbImgs?.length || document.hidden) return;
        const cv = window._robcoCameraView;
        if (!cv?.captureThumb) return;
        const playhead = this._playheadPoint(this._robotBlocks());
        if (playhead) {
            for (const rec of this._thumbImgs) {
                const iv = Math.max(0.5, rec.row.intervalS || 2);
                if (Math.abs(rec.t - playhead.s) > iv / 2) continue;
                const url = cv.captureThumb(rec.camId);
                if (!url) continue;
                rec.img.src = url;
                const cache = this._thumbCacheFor(rec.row);
                cache.set(rec.t, url);
                if (cache.size > 400) cache.delete(cache.keys().next().value);
            }
            if (cv.hasMaster()) {
                const camRow = this._rows.find((r) => r.kind === 'camera' && r.elements.length);
                if (camRow) {
                    const seg = this._cameraSegments(camRow, Infinity).filter((s) => s.startS <= playhead.s).pop();
                    if (seg?.e2.camId && cv.masterCameraId() !== seg.e2.camId) {
                        if (cv.setMasterCamera(seg.e2.camId)) this._render(); // move the LIVE badge
                    }
                }
            }
        } else {
            const perCam = new Map(); // one capture per camera, shared by all its live slots
            for (const rec of this._thumbImgs) {
                if (this._thumbCacheFor(rec.row).has(rec.t)) continue; // keep the run filmstrip
                if (!perCam.has(rec.camId)) perCam.set(rec.camId, cv.captureThumb(rec.camId));
                const url = perCam.get(rec.camId);
                if (url) rec.img.src = url;
            }
        }
    }

    // --- custom-row blocks ------------------------------------------------
    /** A row element: free block (title/start/duration), or MTBH-linked — it then shows the
     *  MTBH's name, lasts its animation duration, and sits where its trigger output fires. */
    _customBlock(row, e2, px, color, blocks) {
        const t = this._elementTiming(e2, blocks);
        const leftPx = t.trigger?.xPx != null ? t.trigger.xPx : t.startS * px;
        const w = Math.max(MIN_BLOCK_PX, t.durS * px - GAP_PX);
        const h = BLOCK_H + (e2.description ? DESC_H : 0);
        const unanchored = t.mtbh && !t.trigger; // linked, but the trigger isn't in the sequence
        const box = el('div',
            `position:absolute;left:${leftPx}px;top:5px;height:${h}px;width:${w}px;box-sizing:border-box;` +
            `border-radius:6px;padding:3px 6px;overflow:hidden;transition:left .2s ease,width .2s ease;` +
            `cursor:${this._editMode && !t.trigger ? 'grab' : 'pointer'};` +
            `background:${hexA(color, 0.14)};border:1px ${unanchored ? 'dashed' : 'solid'} ${hexA(color, 0.7)};`);
        const top = el('div', 'display:flex;align-items:center;gap:4px;min-width:0;');
        if (t.mtbh) top.append(el('span', 'flex:0 0 auto;font-size:10px;opacity:.8;', '⚙'));
        top.append(el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px;',
            t.mtbh ? t.mtbh.cfg.name : (e2.title || '—')));
        box.append(top, el('div', 'font-size:10px;color:#9da7b3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            fmtMs(t.durS * 1000) + (t.mtbh ? ` · out ${t.mtbh.cfg.anim.bank}/${t.mtbh.cfg.anim.io}` : '')));
        if (e2.description) box.append(this._descLine(e2.description));
        if (t.mtbh) {
            box.title = t.trigger
                ? `MTBH "${t.mtbh.cfg.name}" — positioned where output ${t.mtbh.cfg.anim.bank}/${t.mtbh.cfg.anim.io} switches ON`
                : `MTBH "${t.mtbh.cfg.name}" — output ${t.mtbh.cfg.anim.bank}/${t.mtbh.cfg.anim.io} is not in the robot sequence; start is manual`;
            if (t.trigger) this._mtbhEls.push({ box, e2 });
        } else if (e2.mtbhId) {
            box.title = 'the linked MTBH element no longer exists — click to re-link';
        }

        if (this._editMode && !t.trigger) {
            // drag to shift the element's start time; a plain click still opens the editor
            let moved = false;
            box.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                const startX = e.clientX;
                const origS = e2.startS || 0;
                moved = false;
                const move = (ev) => {
                    const dS = (ev.clientX - startX) / px;
                    if (!moved && Math.abs(ev.clientX - startX) < 4) return;
                    if (!moved) { moved = true; box.setPointerCapture(e.pointerId); box.style.transition = 'none'; }
                    e2.startS = Math.max(0, Math.round((origS + dS) * 10) / 10);
                    box.style.left = `${e2.startS * px}px`;
                };
                const up = () => {
                    box.removeEventListener('pointermove', move);
                    box.removeEventListener('pointerup', up);
                    if (moved) { this._saveRows(); this._render(); }
                };
                box.addEventListener('pointermove', move);
                box.addEventListener('pointerup', up);
            });
            box.addEventListener('click', () => { if (!moved) this._toggleEditorPop(box, row, e2); });
        } else {
            box.addEventListener('click', () => this._toggleEditorPop(box, row, e2));
        }
        return box;
    }

    /** Click-open editor for a row element: custom (title/start/duration) or MTBH link,
     *  plus description and delete. */
    _toggleEditorPop(anchor, row, e2) {
        if (this._pop?._anchor === anchor) { this._closePop(); return; }
        this._closePop();
        const pop = el('div', 'position:fixed;z-index:5100;width:230px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
            'color:#e6edf3;background:#10161d;border:1px solid rgba(255,255,255,0.16);border-radius:8px;padding:8px;' +
            'box-shadow:0 10px 28px rgba(0,0,0,0.55);display:flex;flex-direction:column;gap:5px;');
        const field = (lbl, input) => {
            const r = el('div', 'display:flex;align-items:center;gap:6px;');
            r.append(el('span', 'flex:0 0 52px;opacity:.7;', lbl), input);
            return r;
        };

        // element kind: fully custom, or riding an animated MTBH element
        const link = el('select', INPUT + 'flex:1;min-width:0;color-scheme:dark;');
        const opt = (v, label, sel) => {
            const o = el('option', 'background:#0d1117;color:#e6edf3;', label);
            o.value = v;
            if (sel) o.selected = true;
            link.append(o);
        };
        const mtbhs = this._animatedMtbhs();
        opt('', 'custom element', !e2.mtbhId);
        for (const it of mtbhs) opt(it.cfg.id, `${it.cfg.name} (out ${it.cfg.anim.bank}/${it.cfg.anim.io})`, e2.mtbhId === it.cfg.id);
        if (e2.mtbhId && !mtbhs.some((it) => it.cfg.id === e2.mtbhId)) opt(e2.mtbhId, '(missing MTBH element)', true);
        link.title = 'A linked MTBH element takes its name + animation duration and positions itself where the animation\'s trigger output switches ON in the robot sequence';
        link.addEventListener('change', () => {
            e2.mtbhId = link.value || undefined;
            this._saveRows();
            this._render();
        });
        pop.append(field('element', link));

        const mtbh = this._mtbhFor(e2);
        if (mtbh) {
            const a = mtbh.cfg.anim;
            const trig = this._triggerPoint(a.bank, a.io, this._robotBlocks());
            pop.append(el('div', 'font-size:10px;color:#9da7b3;', trig
                ? `starts at ${trig.s.toFixed(1)}s (output ${a.bank}/${a.io} switches ON) · duration ${a.dur}s (animation)`
                : `output ${a.bank}/${a.io} is not in the robot sequence — set the start manually:`));
            if (!trig) {
                const start = el('input', INPUT + 'width:64px;text-align:right;');
                start.type = 'number'; start.step = '0.1'; start.min = '0'; start.value = String(e2.startS ?? 0);
                start.addEventListener('change', () => { e2.startS = Math.max(0, +start.value || 0); this._saveRows(); this._render(); });
                pop.append(field('start s', start));
            }
        } else {
            const title = el('input', INPUT + 'flex:1;min-width:0;');
            title.value = e2.title || '';
            title.addEventListener('change', () => { e2.title = title.value; this._saveRows(); this._render(); });
            const start = el('input', INPUT + 'width:64px;text-align:right;');
            start.type = 'number'; start.step = '0.1'; start.min = '0'; start.value = String(e2.startS ?? 0);
            start.addEventListener('change', () => { e2.startS = Math.max(0, +start.value || 0); this._saveRows(); this._render(); });
            const dur = el('input', INPUT + 'width:64px;text-align:right;');
            dur.type = 'number'; dur.step = '0.1'; dur.min = '0.1'; dur.value = String(e2.durS ?? 1);
            dur.addEventListener('change', () => { e2.durS = Math.max(0.1, +dur.value || 1); this._saveRows(); this._render(); });
            pop.append(field('title', title), field('start s', start), field('dur s', dur));
        }

        const desc = el('textarea', INPUT + 'width:100%;box-sizing:border-box;min-height:40px;resize:vertical;');
        desc.value = e2.description || '';
        desc.placeholder = 'description (shown inside the block)';
        desc.addEventListener('change', () => { e2.description = desc.value; this._saveRows(); this._render(); });
        const del = el('button', BTN + 'align-self:flex-end;border-color:rgba(248,81,73,0.6);', 'delete');
        del.addEventListener('click', () => {
            row.elements = row.elements.filter((x) => x !== e2);
            this._saveRows();
            this._closePop();
            this._render();
        });
        pop.append(desc, del);
        this._openPop(pop, anchor);
    }

    _openPop(pop, anchor) {
        document.body.appendChild(pop);
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth || 230;
        const h = pop.offsetHeight || 120;
        pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 10))}px`;
        // open above the block when it sits low (bottom dock), else below
        if (r.bottom + h + 8 > window.innerHeight) pop.style.top = `${Math.max(8, r.top - h - 6)}px`;
        else pop.style.top = `${r.bottom + 6}px`;
        pop._anchor = anchor;
        this._pop = pop;
    }

    _closePop() {
        this._pop?.remove();
        this._pop = null;
    }
}

/** '#rrggbb' + alpha → rgba() string. */
function hexA(hex, a) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
