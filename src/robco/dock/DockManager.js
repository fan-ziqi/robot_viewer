/**
 * DockManager — Photoshop-style docking layout for the RobCo tool panels.
 *
 * The RobCo panels (View, Setup, Camera, Waypoints, …) are self-contained DOM
 * singletons that all call makeDraggable()/makeCollapsible() from draggable.js.
 * When the dock is enabled (default RobCo mode, i.e. no ?chrome=1), draggable.js
 * hands each panel to dock.adoptPanel() instead of free-floating it. The dock
 * then owns all window chrome:
 *
 *   - a top menu bar (File / View / Window / Help + Connect button slot)
 *   - left & right sidebars the panels stack into, with drag-to-reorder,
 *     drag-out-to-float and drag-in-to-snap (insertion indicator included)
 *   - floating windows with a shared titlebar (collapse / pop-out / close)
 *   - pop-out into a real separate browser window (panel DOM is adopted into
 *     the child document and returned when it closes)
 *   - layout persistence in localStorage ('robco-dock-layout-v1'), which
 *     sessionSnapshot.js also embeds into saved workspace files
 *
 * The panels' own inline title rows are hidden; their DOM is otherwise moved,
 * never rebuilt — critical for CameraView's live WebGL canvas and CodeMirror.
 * The 3D viewport shrinks between the sidebars: we inset #canvas-container and
 * SceneManager's ResizeObserver (which watches that container) does the rest.
 */
import { icon } from './icons.js';

const LAYOUT_KEY = 'robco-dock-layout-v1';
const TOPBAR_H = 40;
const DOCK_MIN = 240;
const DOCK_MAX = 560;
const BOTTOM_MIN = 140;
const BOTTOM_MAX = 520;
const EDGE_SNAP = 56;      // px from a screen edge that counts as "over the dock"
const SIDES = ['left', 'right', 'bottom', 'top'];
const Z_DOCK = 2900;
const Z_FLOAT = 3000;      // floating windows live in 3000..3390 (ConnectUI modal is 4000)
const Z_TOPBAR = 3500;
const Z_MENU = 3600;

// Known tool windows, keyed by the same stable keys draggable.js already uses
// for 'robco-pos-<key>'. Unknown keys get a generic def so future panels dock too.
const PANEL_DEFS = {
    session:   { title: 'Session',         icon: 'session',   dock: 'left',  order: 0 },
    view:      { title: 'View',            icon: 'view',      dock: 'left',  order: 1 },
    setup:     { title: 'Setup',           icon: 'setup',     dock: 'left',  order: 2 },
    render:    { title: 'Render Settings', icon: 'render',    dock: 'left',  order: 3 },
    gizmo:     { title: 'Gizmo',           icon: 'gizmo',     dock: 'right', order: 0 },
    tools:     { title: 'RobFlow Tools',   icon: 'tools',     dock: 'right', order: 1 },
    camera:    { title: 'Camera',          icon: 'camera',    dock: 'right', order: 2 },
    waypoints: { title: 'Waypoints',       icon: 'waypoints', dock: 'right', order: 3 },
    singularity: { title: 'Singularity Analysis', icon: 'singularity', dock: 'right', order: 4 },
    stream:    { title: 'Stream Rate',     icon: 'stream',    dock: 'right', order: 5 },
    blender:   { title: 'Blender Export',  icon: 'blender',   dock: 'right', order: 6 },
    dynamics:  { title: 'Joint Dynamics',  icon: 'dynamics',  dock: 'float', order: 0 },
    takt:      { title: 'Takt Time',       icon: 'takt',      dock: 'bottom', order: 0 },
};

// Panels that only exist after some event — shown greyed out in the View menu until then.
const AVAILABILITY_HINT = {
    view: 'loads with a robot',
    setup: 'loads with a robot',
    render: 'loads with a robot',
    tools: 'loads with a robot',
    camera: 'loads with a robot',
    waypoints: 'loads with a robot',
    singularity: 'loads with a robot',
    dynamics: 'loads with a robot',
    blender: 'loads with a robot',
    stream: 'appears on live connect',
    takt: 'loads with a robot',
};

const CSS = `
.robco-topbar {
    position: fixed; top: 0; left: 0; right: 0; height: ${TOPBAR_H}px; z-index: ${Z_TOPBAR};
    display: flex; align-items: center; gap: 2px; padding: 0 10px;
    font: 12px/1 ui-monospace, Menlo, Consolas, monospace; color: #e6edf3;
    background: rgba(13,17,23,0.96); border-bottom: 1px solid rgba(255,255,255,0.09);
    backdrop-filter: blur(6px); user-select: none;
}
.robco-topbar-logo {
    display: flex; align-items: center; gap: 8px; margin-right: 14px;
    font-weight: 700; letter-spacing: .04em; color: #fff; white-space: nowrap;
}
.robco-topbar-logo .dot { width: 9px; height: 9px; border-radius: 50%; background: #2f81f7; box-shadow: 0 0 8px rgba(47,129,247,.8); }
.robco-menu-btn {
    font: inherit; color: #e6edf3; background: none; border: none; border-radius: 6px;
    padding: 7px 10px; cursor: pointer;
}
.robco-menu-btn:hover, .robco-menu-btn.open { background: rgba(255,255,255,0.08); }
.robco-topbar-spacer { flex: 1; }
.robco-topbar-right { display: flex; align-items: center; gap: 8px; }
.robco-menu {
    position: fixed; z-index: ${Z_MENU}; min-width: 230px; padding: 5px;
    font: 12px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #e6edf3;
    background: #10161d; border: 1px solid rgba(255,255,255,0.13); border-radius: 9px;
    box-shadow: 0 10px 32px rgba(0,0,0,0.55);
}
.robco-menu-item {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    font: inherit; color: #e6edf3; background: none; border: none; border-radius: 6px;
    padding: 7px 9px; cursor: pointer; white-space: nowrap;
}
.robco-menu-item:hover:not(:disabled) { background: rgba(47,129,247,0.22); }
.robco-menu-item:disabled { color: #6e7681; cursor: default; }
.robco-menu-item svg { flex: none; opacity: .8; }
.robco-menu-item .robco-menu-hint { margin-left: auto; font-size: 10px; color: #6e7681; padding-left: 18px; }
.robco-menu-item .robco-menu-check { width: 16px; flex: none; opacity: 0; }
.robco-menu-item.checked .robco-menu-check { opacity: 1; color: #2f81f7; }
.robco-menu-sep { height: 1px; margin: 5px 7px; background: rgba(255,255,255,0.09); }
.robco-menu-title { padding: 6px 9px 3px; font-size: 9.5px; letter-spacing: .08em; color: #6e7681; text-transform: uppercase; }

.robco-dock {
    position: fixed; top: ${TOPBAR_H}px; bottom: 0; z-index: ${Z_DOCK};
    display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden;
    background: rgba(13,17,23,0.96); backdrop-filter: blur(6px);
}
.robco-dock.left  { left: 0;  border-right: 1px solid rgba(255,255,255,0.09); }
.robco-dock.right { right: 0; border-left:  1px solid rgba(255,255,255,0.09); }
.robco-dock.bottom, .robco-dock.top {
    left: 0; right: 0; flex-direction: row; align-items: stretch;
    overflow-x: auto; overflow-y: hidden;
}
.robco-dock.bottom { top: auto; bottom: 0; border-top: 1px solid rgba(255,255,255,0.09); }
.robco-dock.top    { top: ${TOPBAR_H}px; bottom: auto; border-bottom: 1px solid rgba(255,255,255,0.09); }
.robco-dock.bottom > .robco-dock-item.docked, .robco-dock.top > .robco-dock-item.docked {
    flex: 1 1 0; min-width: 280px; border-bottom: none;
    border-right: 1px solid rgba(255,255,255,0.07); display: flex;
}
.robco-dock.bottom > .robco-dock-item.docked > .robco-dock-item-body,
.robco-dock.top > .robco-dock-item.docked > .robco-dock-item-body { flex: 1; overflow-y: auto; }
.robco-dock.drop-hint { background: rgba(21,30,41,0.97); }
.robco-dock-splitter {
    position: fixed; top: ${TOPBAR_H}px; bottom: 0; width: 6px; z-index: ${Z_DOCK + 1};
    cursor: col-resize; background: transparent;
}
.robco-dock-splitter.horizontal {
    top: auto; bottom: 0; width: auto; height: 6px; cursor: row-resize;
}
.robco-dock-splitter:hover, .robco-dock-splitter.active { background: rgba(47,129,247,0.45); }
.robco-drop-indicator {
    position: absolute; left: 6px; right: 6px; height: 2px; z-index: 5;
    background: #2f81f7; border-radius: 1px; box-shadow: 0 0 6px rgba(47,129,247,.9);
    pointer-events: none;
}

.robco-dock-item { display: flex; flex-direction: column; min-height: 0; }
.robco-dock-item.docked { flex: none; border-bottom: 1px solid rgba(255,255,255,0.07); }
.robco-dock-item.floating {
    position: fixed; z-index: ${Z_FLOAT};
    background: rgba(13,17,23,0.92); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,0.55);
    backdrop-filter: blur(6px); overflow: hidden;
}
.robco-dock-item-header {
    flex: none; display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 5px 0 9px;
    font: 600 10.5px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .07em;
    text-transform: uppercase; color: #c9d4de; background: rgba(255,255,255,0.045);
    cursor: grab; user-select: none; touch-action: none;
}
.robco-dock-item-header:active { cursor: grabbing; }
.robco-dock-item-header svg.robco-dock-item-icon { flex: none; color: #8b98a5; }
.robco-dock-item-header .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.robco-dock-item-btn {
    flex: none; display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border: none; border-radius: 5px;
    color: #8b98a5; background: none; cursor: pointer; opacity: .55;
}
.robco-dock-item-header:hover .robco-dock-item-btn { opacity: 1; }
.robco-dock-item-btn:hover { background: rgba(255,255,255,0.1); color: #e6edf3; }
.robco-dock-item-btn.close:hover { background: rgba(248,81,73,0.25); color: #f85149; }
.robco-dock-item-btn svg { transition: transform .15s ease; }
.robco-dock-item.collapsed .robco-dock-item-btn.collapse svg { transform: rotate(-90deg); }
.robco-dock-item-body { min-height: 0; overflow-x: hidden; }
.robco-dock-item.collapsed .robco-dock-item-body { display: none; }
.robco-dock-item.floating .robco-dock-item-body { max-height: calc(100vh - ${TOPBAR_H + 50}px); overflow-y: auto; }

.robco-drag-ghost {
    position: fixed; z-index: ${Z_MENU}; display: flex; align-items: center; gap: 8px;
    padding: 7px 12px; font: 600 11px ui-monospace, Menlo, Consolas, monospace;
    color: #e6edf3; background: rgba(21,30,41,0.95); border: 1px solid rgba(47,129,247,0.7);
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); pointer-events: none;
}

.robco-about-overlay {
    position: fixed; inset: 0; z-index: ${Z_MENU + 10}; display: flex;
    align-items: center; justify-content: center; background: rgba(0,0,0,0.5);
}
.robco-about-card {
    width: 380px; max-width: 90vw; padding: 22px 24px; border-radius: 12px;
    font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace; color: #e6edf3;
    background: #10161d; border: 1px solid rgba(255,255,255,0.13);
    box-shadow: 0 14px 44px rgba(0,0,0,0.6);
}
`;

function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html != null) e.innerHTML = html;
    return e;
}

function loadLayout() {
    try {
        const s = JSON.parse(localStorage.getItem(LAYOUT_KEY));
        if (s && s.v === 1) return s;
    } catch { /* ignore */ }
    return null;
}

class DockManager {
    constructor() {
        this.enabled = false;
        this.app = null;
        this.panels = new Map();      // key -> record
        this._pendingBodies = new Map(); // key -> body el (makeCollapsible before makeDraggable)
        this._zTop = Z_FLOAT;
        this._openMenu = null;
        this.state = {
            v: 1, leftWidth: 300, rightWidth: 340, bottomHeight: 240, topHeight: 240,
            left: [], right: [], bottom: [], top: [], // docked order (only keys seen at least once)
            float: {},                     // key -> {left, top}
            collapsed: {},                 // key -> bool
            closed: [],                    // keys hidden by the user
        };
    }

    // ------------------------------------------------------------------
    // bootstrap
    // ------------------------------------------------------------------
    enable(app) {
        if (this.enabled) return;
        this.enabled = true;
        this.app = app;

        const saved = loadLayout();
        if (saved) this.state = { ...this.state, ...saved };

        const style = document.createElement('style');
        style.id = 'robco-dock-css';
        style.textContent = CSS;
        document.head.appendChild(style);

        this._buildTopbar();
        this.docks = {
            left: el('div', 'robco-dock left'),
            right: el('div', 'robco-dock right'),
            bottom: el('div', 'robco-dock bottom'),
            top: el('div', 'robco-dock top'),
        };
        for (const side of SIDES) {
            const d = this.docks[side];
            d.style.position = 'fixed'; // keep before width so first paint is stable
            document.body.appendChild(d);
            this._buildSplitter(side);
        }
        this._indicator = el('div', 'robco-drop-indicator');
        this._indicator.style.display = 'none';

        window.addEventListener('resize', () => this._clampFloating());
        window.addEventListener('beforeunload', () => {
            for (const rec of this.panels.values()) rec.popup?.win?.close?.();
        });
        this._layoutDocks();
    }

    /** devLoad puts the Connect button (and future quick actions) here. */
    addTopbarWidget(elem) {
        this._topbarRight?.insertBefore(elem, this._topbarRight.firstChild);
    }

    // ------------------------------------------------------------------
    // panel adoption (called from draggable.js)
    // ------------------------------------------------------------------
    adoptCollapsible(body, btn, key) {
        // The dock provides its own collapse chrome; make sure a previously
        // persisted 'robco-collapsed-*' state can't leave the body hidden.
        body.style.display = '';
        this._pendingBodies.set(key, body);
    }

    adoptPanel(root, handle, key) {
        const def = PANEL_DEFS[key] ||
            { title: key.charAt(0).toUpperCase() + key.slice(1), icon: 'panel', dock: 'float', order: 99 };

        const existing = this.panels.get(key);
        if (existing) {
            // Rebuild path (e.g. DynamicsDashboard recreates its DOM on every attach,
            // liveConnect builds a fresh RobFlowToolsPanel per connect): swap the root
            // in place, keep chrome + location.
            if (existing.root !== root) {
                existing.root.remove();
                this._prepareRoot(root, handle, existing);
                existing.body.appendChild(root);
                existing.root = root;
            }
            return;
        }

        const rec = {
            key, def, root,
            baseWidth: this._measureWidth(root),
            location: null,        // 'left' | 'right' | 'float'
            collapsed: !!this.state.collapsed[key],
            hidden: this.state.closed.includes(key),
            popup: null,
        };
        this._prepareRoot(root, handle, rec);
        this._buildChrome(rec);
        this.panels.set(key, rec);

        // Place according to saved layout, else defaults.
        if (this.state.left.includes(key)) {
            this._placeDocked(rec, 'left', { index: this.state.left.indexOf(key) });
        } else if (this.state.right.includes(key)) {
            this._placeDocked(rec, 'right', { index: this.state.right.indexOf(key) });
        } else if (this.state.bottom.includes(key)) {
            this._placeDocked(rec, 'bottom', { index: this.state.bottom.indexOf(key) });
        } else if ((this.state.top || []).includes(key)) {
            this._placeDocked(rec, 'top', { index: this.state.top.indexOf(key) });
        } else if (this.state.float[key]) {
            this._placeFloating(rec, this.state.float[key]);
        } else if (def.dock === 'float') {
            this._placeFloating(rec, this._defaultFloatPos(rec));
        } else {
            this._placeDocked(rec, def.dock, { index: this._defaultDockIndex(rec, def.dock) });
        }

        if (rec.hidden) rec.item.style.display = 'none';
        this._setCollapsed(rec, rec.collapsed, false);
        this._layoutDocks();
        this._save();
    }

    _measureWidth(root) {
        const css = root.style.cssText || '';
        const m = css.match(/(?:^|;)\s*width:\s*([\d.]+)px/) || css.match(/min-width:\s*([\d.]+)px/);
        if (m) return Math.max(DOCK_MIN, parseFloat(m[1]) + 2);
        const w = root.getBoundingClientRect().width;
        return Math.max(DOCK_MIN, Math.round(w) || 300);
    }

    /** Neutralize the panel's free-floating inline styles; the wrapper owns geometry now. */
    _prepareRoot(root, handle, rec) {
        // Hide the panel's own title row ("View  ⠿" + ▾) — the dock header replaces it.
        let headerRow = null;
        if (handle && handle.parentElement === root) headerRow = handle;
        else if (handle && handle.parentElement?.parentElement === root) headerRow = handle.parentElement;
        if (headerRow) headerRow.style.display = 'none';

        const s = root.style;
        s.position = 'static';
        s.left = s.top = s.right = s.bottom = 'auto';
        s.width = 'auto';
        s.minWidth = '0';
        s.zIndex = 'auto';
        s.border = 'none';
        s.borderRadius = '0';
        s.boxShadow = 'none';
        s.background = 'transparent';
        s.backdropFilter = 'none';
        s.margin = '0';
        // Setup/Waypoints cap themselves at 80vh with their own scrollbar — the dock
        // (or the floating window body) owns scrolling now.
        s.maxHeight = 'none';
        if (s.overflow === 'auto') s.overflow = 'visible';
        rec.handle = handle;
    }

    _buildChrome(rec) {
        const item = el('div', 'robco-dock-item');
        const header = el('div', 'robco-dock-item-header');
        header.innerHTML =
            `<span class="robco-dock-item-icon" style="display:flex">${icon(rec.def.icon, 14)}</span>` +
            `<span class="title">${rec.def.title}</span>`;

        const btn = (name, title, cls) => {
            const b = el('button', `robco-dock-item-btn ${cls}`, icon(name, 13));
            b.title = title;
            b.addEventListener('pointerdown', (e) => e.stopPropagation());
            header.appendChild(b);
            return b;
        };
        const collapseBtn = btn('chevron', 'Collapse', 'collapse');
        const popoutBtn = btn('popout', 'Open in separate window', 'popout');
        const closeBtn = btn('close', 'Close (reopen via View menu)', 'close');

        collapseBtn.addEventListener('click', () => this._setCollapsed(rec, !rec.collapsed));
        popoutBtn.addEventListener('click', () => this.popOut(rec.key));
        closeBtn.addEventListener('click', () => this.setPanelOpen(rec.key, false));
        header.addEventListener('pointerdown', (e) => this._startDrag(rec, e));

        const body = el('div', 'robco-dock-item-body');
        body.appendChild(rec.root);
        item.append(header, body);
        item.addEventListener('pointerdown', () => {
            if (rec.location === 'float') this._bringToFront(rec);
        });

        rec.item = item;
        rec.body = body;
        rec.headerEl = header;
    }

    _defaultFloatPos(rec) {
        // Float clear of the left sidebar; Dynamics historically sat bottom-left,
        // everything else cascades from the top-left of the canvas area.
        const x0 = (this._dockVisible('left') ? this.state.leftWidth : 0) + 16;
        const n = [...this.panels.values()].filter((r) => r.location === 'float').length;
        if (rec.key === 'dynamics') {
            return { left: x0, top: Math.max(TOPBAR_H + 10, window.innerHeight - 420) };
        }
        return { left: x0 + 44 + n * 28, top: TOPBAR_H + 24 + n * 28 };
    }

    _defaultDockIndex(rec, side) {
        // Keep the PANEL_DEFS order among default placements.
        const order = this.state[side];
        let idx = 0;
        for (const k of order) {
            const d = PANEL_DEFS[k];
            if (d && d.order <= rec.def.order) idx++;
        }
        return idx;
    }

    // ------------------------------------------------------------------
    // placement primitives
    // ------------------------------------------------------------------
    /**
     * @param {object} where - { index } (state-array position, used when restoring a
     *   saved layout) or { beforeKey } (insert before that panel; null = end — used by
     *   drag & drop so hidden/unregistered keys in the order array can't skew indices).
     */
    _placeDocked(rec, side, where = {}) {
        this.state[side] = this.state[side] || [];
        const order = this.state[side];
        for (const s of SIDES) {
            if (s === side) continue;
            const i = (this.state[s] || []).indexOf(rec.key);
            if (i >= 0) this.state[s].splice(i, 1);
        }
        delete this.state.float[rec.key];

        const cur = order.indexOf(rec.key);
        if (cur >= 0) order.splice(cur, 1);
        let index;
        if ('beforeKey' in where) {
            index = where.beforeKey == null ? order.length : order.indexOf(where.beforeKey);
            if (index < 0) index = order.length;
        } else {
            index = where.index;
        }
        if (index == null || index < 0 || index > order.length) index = order.length;
        order.splice(index, 0, rec.key);

        rec.location = side;
        rec.item.classList.add('docked');
        rec.item.classList.remove('floating');
        rec.item.style.left = rec.item.style.top = rec.item.style.width = rec.item.style.zIndex = '';

        // Insert before the next order-key that already has an item in this dock.
        const dockEl = this.docks[side];
        let ref = null;
        for (let i = order.indexOf(rec.key) + 1; i < order.length; i++) {
            const it = this.panels.get(order[i])?.item;
            if (it && it.parentElement === dockEl) { ref = it; break; }
        }
        dockEl.insertBefore(rec.item, ref);
        this._layoutDocks();
    }

    _placeFloating(rec, pos) {
        for (const side of SIDES) {
            const i = (this.state[side] || []).indexOf(rec.key);
            if (i >= 0) this.state[side].splice(i, 1);
        }
        rec.location = 'float';
        rec.item.classList.add('floating');
        rec.item.classList.remove('docked');
        rec.item.style.width = `${rec.baseWidth}px`;
        const left = Math.min(Math.max(0, pos.left), window.innerWidth - 60);
        const top = Math.min(Math.max(TOPBAR_H, pos.top), window.innerHeight - 40);
        rec.item.style.left = `${left}px`;
        rec.item.style.top = `${top}px`;
        this.state.float[rec.key] = { left, top };
        document.body.appendChild(rec.item);
        this._bringToFront(rec);
        this._layoutDocks();
    }

    _bringToFront(rec) {
        this._zTop += 1;
        if (this._zTop > Z_FLOAT + 390) {
            // renormalize the floating band so we never climb over the modal layer
            this._zTop = Z_FLOAT;
            for (const r of this.panels.values()) {
                if (r.location === 'float') r.item.style.zIndex = String(this._zTop++);
            }
        }
        rec.item.style.zIndex = String(this._zTop);
    }

    _setCollapsed(rec, collapsed, save = true) {
        rec.collapsed = collapsed;
        rec.item.classList.toggle('collapsed', collapsed);
        this.state.collapsed[rec.key] = collapsed;
        if (save) this._save();
    }

    setPanelOpen(key, open) {
        const rec = this.panels.get(key);
        if (!rec) return;
        if (rec.popup) this._returnFromPopup(rec);
        rec.hidden = !open;
        rec.item.style.display = open ? '' : 'none';
        const ci = this.state.closed.indexOf(key);
        if (open && ci >= 0) this.state.closed.splice(ci, 1);
        if (!open && ci < 0) this.state.closed.push(key);
        this._layoutDocks();
        this._save();
    }

    resetLayout() {
        localStorage.removeItem(LAYOUT_KEY);
        this.state = {
            v: 1, leftWidth: 300, rightWidth: 340, bottomHeight: 240, topHeight: 240,
            left: [], right: [], bottom: [], top: [], float: {}, collapsed: {}, closed: [],
        };
        const recs = [...this.panels.values()];
        for (const rec of recs) {
            if (rec.popup) this._returnFromPopup(rec);
            rec.hidden = false;
            rec.item.style.display = '';
            this._setCollapsed(rec, false, false);
        }
        for (const rec of recs.sort((a, b) => a.def.order - b.def.order)) {
            if (rec.def.dock === 'float') this._placeFloating(rec, this._defaultFloatPos(rec));
            else this._placeDocked(rec, rec.def.dock);
        }
        this._layoutDocks();
        this._save();
    }

    dockAll() {
        for (const rec of [...this.panels.values()].sort((a, b) => a.def.order - b.def.order)) {
            if (rec.popup) this._returnFromPopup(rec);
            if (rec.location === 'float') {
                const side = ['right', 'bottom', 'top'].includes(rec.def.dock) ? rec.def.dock : 'left';
                this._placeDocked(rec, side);
            }
        }
        this._save();
    }

    /**
     * Re-read the persisted layout and re-place every adopted panel accordingly. Session restore
     * needs this: enable() consumed localStorage at boot, before restoreSession() seeds the
     * session file's layout — without a re-read the seeded layout would never apply, and the next
     * _save() would clobber it with the stale in-memory state. Panels adopted after this call
     * (the robot toolset built during restore) pick the new state up via adoptPanel as usual.
     */
    reloadLayout() {
        const saved = loadLayout();
        if (!saved) return;
        this.state = { ...this.state, ...saved };
        const recs = [...this.panels.values()];
        for (const rec of recs) {
            if (rec.popup) this._returnFromPopup(rec);
            rec.hidden = this.state.closed.includes(rec.key);
            rec.item.style.display = rec.hidden ? 'none' : '';
        }
        // _placeDocked's insert-before-next-placed-key scan makes this order-independent.
        for (const rec of recs.sort((a, b) => a.def.order - b.def.order)) {
            if (this.state.left.includes(rec.key)) {
                this._placeDocked(rec, 'left', { index: this.state.left.indexOf(rec.key) });
            } else if (this.state.right.includes(rec.key)) {
                this._placeDocked(rec, 'right', { index: this.state.right.indexOf(rec.key) });
            } else if (this.state.bottom.includes(rec.key)) {
                this._placeDocked(rec, 'bottom', { index: this.state.bottom.indexOf(rec.key) });
            } else if ((this.state.top || []).includes(rec.key)) {
                this._placeDocked(rec, 'top', { index: this.state.top.indexOf(rec.key) });
            } else if (this.state.float[rec.key]) {
                this._placeFloating(rec, this.state.float[rec.key]);
            } else if (rec.def.dock === 'float') {
                this._placeFloating(rec, this._defaultFloatPos(rec));
            } else {
                this._placeDocked(rec, rec.def.dock, { index: this._defaultDockIndex(rec, rec.def.dock) });
            }
            this._setCollapsed(rec, !!this.state.collapsed[rec.key], false);
        }
        this._layoutDocks();
        this._save();
    }

    // ------------------------------------------------------------------
    // geometry: docks <-> canvas
    // ------------------------------------------------------------------
    _dockVisible(side) {
        return (this.state[side] || []).some((k) => {
            const r = this.panels.get(k);
            return r && !r.hidden && !r.popup;
        });
    }

    _layoutDocks() {
        // Top & bottom strips span the FULL window width; the side docks (and their splitters)
        // are reduced in height instead, sitting between the two strips.
        const topVisible = this._dockVisible('top');
        const bottomVisible = this._dockVisible('bottom');
        const th = this.state.topHeight || 240;
        const bh = this.state.bottomHeight || 240;
        const insetTop = TOPBAR_H + (topVisible ? th : 0);
        const insetBottom = bottomVisible ? bh : 0;

        for (const side of ['left', 'right']) {
            const visible = this._dockVisible(side);
            const w = side === 'left' ? this.state.leftWidth : this.state.rightWidth;
            const d = this.docks?.[side];
            if (!d) continue;
            d.style.width = visible ? `${w}px` : '0px';
            d.style.display = visible ? 'flex' : 'none';
            d.style.top = `${insetTop}px`;
            d.style.bottom = `${insetBottom}px`;
            const sp = this._splitters?.[side];
            if (sp) {
                sp.style.display = visible ? 'block' : 'none';
                sp.style.top = `${insetTop}px`;
                sp.style.bottom = `${insetBottom}px`;
                if (side === 'left') sp.style.left = `${w - 3}px`;
                else sp.style.right = `${w - 3}px`;
            }
        }
        for (const side of ['top', 'bottom']) {
            const visible = side === 'top' ? topVisible : bottomVisible;
            const h = side === 'top' ? th : bh;
            const d = this.docks?.[side];
            if (!d) continue;
            d.style.display = visible ? 'flex' : 'none';
            d.style.left = '0px';
            d.style.right = '0px';
            d.style.height = visible ? `${h}px` : '0px';
            const sp = this._splitters?.[side];
            if (sp) {
                sp.style.display = visible ? 'block' : 'none';
                sp.style.left = '0px';
                sp.style.right = '0px';
                if (side === 'top') { sp.style.top = `${TOPBAR_H + th - 3}px`; sp.style.bottom = 'auto'; }
                else { sp.style.bottom = `${bh - 3}px`; sp.style.top = 'auto'; }
            }
        }
        const cc = document.getElementById('canvas-container');
        if (cc) {
            cc.style.top = `${insetTop}px`;
            cc.style.left = this._dockVisible('left') ? `${this.state.leftWidth}px` : '0px';
            cc.style.right = this._dockVisible('right') ? `${this.state.rightWidth}px` : '0px';
            cc.style.bottom = `${insetBottom}px`;
        }
    }

    _buildSplitter(side) {
        this._splitters = this._splitters || {};
        const horizontal = side === 'bottom' || side === 'top';
        const sp = el('div', `robco-dock-splitter${horizontal ? ' horizontal' : ''}`);
        sp.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            sp.classList.add('active');
            sp.setPointerCapture(e.pointerId);
            const move = (ev) => {
                if (side === 'bottom') {
                    this.state.bottomHeight = Math.min(BOTTOM_MAX,
                        Math.max(BOTTOM_MIN, Math.round(window.innerHeight - ev.clientY)));
                } else if (side === 'top') {
                    this.state.topHeight = Math.min(BOTTOM_MAX,
                        Math.max(BOTTOM_MIN, Math.round(ev.clientY - TOPBAR_H)));
                } else {
                    const w = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX;
                    this.state[side === 'left' ? 'leftWidth' : 'rightWidth'] =
                        Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(w)));
                }
                this._layoutDocks();
            };
            const up = () => {
                sp.classList.remove('active');
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                this._save();
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
        document.body.appendChild(sp);
        this._splitters[side] = sp;
    }

    _clampFloating() {
        for (const rec of this.panels.values()) {
            if (rec.location !== 'float') continue;
            const left = Math.min(parseFloat(rec.item.style.left) || 0, window.innerWidth - 60);
            const top = Math.min(Math.max(TOPBAR_H, parseFloat(rec.item.style.top) || TOPBAR_H), window.innerHeight - 36);
            rec.item.style.left = `${left}px`;
            rec.item.style.top = `${top}px`;
            this.state.float[rec.key] = { left, top };
        }
    }

    // ------------------------------------------------------------------
    // drag / snap
    // ------------------------------------------------------------------
    _startDrag(rec, e) {
        if (e.button !== 0 || rec.popup) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const wasFloating = rec.location === 'float';
        let active = false;
        let ghost = null;
        let offX = 0;
        let offY = 0;

        const move = (ev) => {
            if (!active) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
                active = true;
                if (wasFloating) {
                    const r = rec.item.getBoundingClientRect();
                    offX = startX - r.left;
                    offY = startY - r.top;
                    this._bringToFront(rec);
                } else {
                    // Docked panels drag as a light ghost chip; the panel itself only
                    // moves on drop (keeps live WebGL/CodeMirror DOM churn minimal).
                    ghost = el('div', 'robco-drag-ghost',
                        `${icon(rec.def.icon, 14)}<span>${rec.def.title}</span>`);
                    document.body.appendChild(ghost);
                }
            }
            if (wasFloating) {
                rec.item.style.left = `${ev.clientX - offX}px`;
                rec.item.style.top = `${Math.max(TOPBAR_H, ev.clientY - offY)}px`;
            } else if (ghost) {
                ghost.style.left = `${ev.clientX + 12}px`;
                ghost.style.top = `${ev.clientY + 10}px`;
            }
            this._updateDropTarget(rec, ev.clientX, ev.clientY);
        };

        const up = (ev) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            ghost?.remove();
            const target = this._dropTarget;
            this._hideDropTarget();
            if (!active) return;
            if (target) {
                this._placeDocked(rec, target.side, { beforeKey: target.beforeKey });
            } else if (!wasFloating) {
                this._placeFloating(rec, {
                    left: ev.clientX - Math.min(140, rec.baseWidth / 2),
                    top: Math.max(TOPBAR_H + 4, ev.clientY - 15),
                });
            } else {
                this.state.float[rec.key] = {
                    left: parseFloat(rec.item.style.left) || 0,
                    top: parseFloat(rec.item.style.top) || TOPBAR_H,
                };
            }
            this._save();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    _updateDropTarget(rec, x, y) {
        let side = null;
        // Full-width strips win in their bands; the side docks take the middle region.
        const topBand = TOPBAR_H + (this._dockVisible('top') ? this.state.topHeight || 240 : EDGE_SNAP);
        const bottomBand = window.innerHeight - (this._dockVisible('bottom') ? this.state.bottomHeight || 240 : EDGE_SNAP);
        if (y >= TOPBAR_H && y <= topBand) side = 'top';
        else if (y >= bottomBand) side = 'bottom';
        if (!side) {
            for (const s of ['left', 'right']) {
                const visible = this._dockVisible(s);
                const w = s === 'left' ? this.state.leftWidth : this.state.rightWidth;
                const inDock = visible &&
                    (s === 'left' ? x <= w : x >= window.innerWidth - w);
                const nearEdge = !visible &&
                    (s === 'left' ? x <= EDGE_SNAP : x >= window.innerWidth - EDGE_SNAP);
                if (y >= TOPBAR_H && (inDock || nearEdge)) { side = s; break; }
            }
        }
        if (!side) { this._hideDropTarget(); return; }

        const horizontal = side === 'bottom' || side === 'top';
        const dockEl = this.docks[side];
        dockEl.classList.add('drop-hint');
        dockEl.style.display = 'flex';
        if (!this._dockVisible(side)) {
            if (horizontal) dockEl.style.height = `${EDGE_SNAP}px`;
            else dockEl.style.width = `${EDGE_SNAP}px`; // temporary strip while hovering an empty dock
        }
        const visible = this.state[side]
            .map((k) => this.panels.get(k))
            .filter((r) => r && !r.hidden && !r.popup && r.key !== rec.key);
        let beforeKey = null; // null = drop at the end
        let indicatorPos = 0;
        const dockRect = dockEl.getBoundingClientRect();
        for (const r of visible) {
            const b = r.item.getBoundingClientRect();
            const mid = horizontal ? b.left + b.width / 2 : b.top + b.height / 2;
            const cursor = horizontal ? x : y;
            if (cursor < mid) {
                beforeKey = r.key;
                indicatorPos = horizontal
                    ? b.left - dockRect.left + dockEl.scrollLeft
                    : b.top - dockRect.top + dockEl.scrollTop;
                break;
            }
            indicatorPos = horizontal
                ? b.right - dockRect.left + dockEl.scrollLeft
                : b.bottom - dockRect.top + dockEl.scrollTop;
        }
        if (this._indicator.parentElement !== dockEl) dockEl.appendChild(this._indicator);
        this._indicator.style.display = 'block';
        if (horizontal) { // vertical insertion line between side-by-side panels
            this._indicator.style.cssText += ';left:auto;right:auto;top:6px;bottom:6px;height:auto;width:2px;';
            this._indicator.style.left = `${Math.max(0, indicatorPos - 1)}px`;
        } else {
            this._indicator.style.cssText += ';left:6px;right:6px;bottom:auto;width:auto;height:2px;';
            this._indicator.style.top = `${Math.max(0, indicatorPos - 1)}px`;
        }
        this._dropTarget = { side, beforeKey };
        for (const s of SIDES) {
            if (s !== side) this.docks[s].classList.remove('drop-hint');
        }
    }

    _hideDropTarget() {
        this._dropTarget = null;
        this._indicator.style.display = 'none';
        for (const side of SIDES) this.docks[side]?.classList.remove('drop-hint');
        this._layoutDocks(); // restores width/display of a temporarily shown empty dock
    }

    // ------------------------------------------------------------------
    // pop-out windows
    // ------------------------------------------------------------------
    popOut(key) {
        const rec = this.panels.get(key);
        if (!rec || rec.popup) { rec?.popup?.win?.focus?.(); return; }
        const w = Math.max(rec.baseWidth + 40, 360);
        const h = Math.min(Math.max(rec.root.scrollHeight + 80, 300), 900);
        const win = window.open('', `robco-dock-${key}`,
            `width=${w},height=${h},left=${window.screenX + 80},top=${window.screenY + 80}`);
        if (!win) {
            alert('Pop-out blocked by the browser. Allow pop-ups for this site.');
            return;
        }
        const doc = win.document;
        doc.title = `${rec.def.title} — Robot Viewer`;
        doc.body.style.cssText =
            'margin:0;background:#0d1117;color:#e6edf3;' +
            'font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow:auto;';
        // Same-document listeners travel with the nodes; adoptNode keeps the live
        // DOM (incl. CameraView's WebGL canvas) instead of cloning it.
        doc.body.appendChild(doc.adoptNode(rec.root));
        this._setCollapsed(rec, false, false);
        rec.item.style.display = 'none';

        const poll = setInterval(() => {
            if (win.closed) this._returnFromPopup(rec);
        }, 400);
        win.addEventListener('beforeunload', () => {
            // let the window actually close first, then reclaim the panel
            setTimeout(() => this._returnFromPopup(rec), 0);
        });
        rec.popup = { win, poll };
        this._layoutDocks();
        this._refreshMenus();
    }

    _returnFromPopup(rec) {
        if (!rec.popup) return;
        const { win, poll } = rec.popup;
        rec.popup = null;
        clearInterval(poll);
        try {
            if (rec.root.ownerDocument !== document) {
                rec.body.appendChild(document.adoptNode(rec.root));
            }
        } catch { /* window already gone; root was adopted lazily */ }
        if (!rec.root.parentElement) rec.body.appendChild(rec.root);
        try { if (!win.closed) win.close(); } catch { /* ignore */ }
        if (!rec.hidden) rec.item.style.display = '';
        this._layoutDocks();
        this._refreshMenus();
    }

    // ------------------------------------------------------------------
    // top bar + menus
    // ------------------------------------------------------------------
    _buildTopbar() {
        const bar = el('div', 'robco-topbar');
        bar.appendChild(el('div', 'robco-topbar-logo', '<span class="dot"></span>Robot Viewer'));

        for (const menu of this._menuDefs()) {
            const btn = el('button', 'robco-menu-btn', menu.label);
            btn.addEventListener('click', () => this._toggleMenu(btn, menu));
            btn.addEventListener('pointerenter', () => {
                if (this._openMenu && this._openMenu.btn !== btn) this._toggleMenu(btn, menu);
            });
            bar.appendChild(btn);
        }

        bar.appendChild(el('div', 'robco-topbar-spacer'));
        this._topbarRight = el('div', 'robco-topbar-right');
        bar.appendChild(this._topbarRight);

        document.addEventListener('pointerdown', (e) => {
            if (this._openMenu && !this._openMenu.el.contains(e.target) && e.target !== this._openMenu.btn) {
                this._closeMenu();
            }
        }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._closeMenu();
        });

        document.body.appendChild(bar);
        this.topbar = bar;
    }

    _menuDefs() {
        return [
            {
                label: 'File',
                items: () => [
                    { label: 'Save Session', icon: 'save', action: () => this._sessionAction('save') },
                    { label: 'Load Session…', icon: 'load', action: () => this._sessionAction('load') },
                    { label: 'Clear Saved Session', icon: 'trash', action: () => this._sessionAction('clear') },
                    { sep: true },
                    { label: 'Settings…', icon: 'gear', disabled: true, hint: 'soon' },
                    { label: 'Export…', icon: 'export', disabled: true, hint: 'soon' },
                ],
            },
            {
                label: 'View',
                items: () => {
                    const items = [{ title: 'Tool Windows' }];
                    for (const [key, def] of Object.entries(PANEL_DEFS)) {
                        const rec = this.panels.get(key);
                        items.push({
                            label: def.title,
                            icon: def.icon,
                            checked: !!rec && !rec.hidden,
                            disabled: !rec,
                            hint: rec ? (rec.popup ? 'window' : '') : (AVAILABILITY_HINT[key] || ''),
                            keepOpen: true,
                            action: () => this.setPanelOpen(key, !!rec?.hidden),
                        });
                    }
                    items.push({ sep: true });
                    const light = document.documentElement.getAttribute('data-theme') === 'light';
                    items.push({
                        label: `Canvas Theme: ${light ? 'Light' : 'Dark'}`,
                        icon: 'theme',
                        keepOpen: true,
                        action: () => {
                            const next = light ? 'dark' : 'light';
                            document.documentElement.setAttribute('data-theme', next);
                            try { localStorage.setItem('theme', next); } catch { /* ignore */ }
                        },
                    });
                    return items;
                },
            },
            {
                label: 'Window',
                items: () => [
                    { label: 'Reset Layout', icon: 'reset', action: () => this.resetLayout() },
                    { label: 'Dock All Panels', icon: 'dockLeft', action: () => this.dockAll() },
                ],
            },
            {
                label: 'Help',
                items: () => [
                    { label: 'About Robot Viewer', icon: 'help', action: () => this._showAbout() },
                ],
            },
        ];
    }

    _toggleMenu(btn, menu) {
        const wasOpen = this._openMenu?.btn === btn;
        this._closeMenu();
        if (wasOpen) return;

        const m = el('div', 'robco-menu');
        this._renderMenuItems(m, menu);
        const r = btn.getBoundingClientRect();
        m.style.left = `${r.left}px`;
        m.style.top = `${r.bottom + 4}px`;
        document.body.appendChild(m);
        btn.classList.add('open');
        this._openMenu = { el: m, btn, menu };
    }

    _renderMenuItems(m, menu) {
        m.innerHTML = '';
        for (const it of menu.items()) {
            if (it.sep) { m.appendChild(el('div', 'robco-menu-sep')); continue; }
            if (it.title) { m.appendChild(el('div', 'robco-menu-title', it.title)); continue; }
            const b = el('button', `robco-menu-item${it.checked ? ' checked' : ''}`);
            b.innerHTML =
                `<span class="robco-menu-check">${icon('check', 12)}</span>` +
                (it.icon ? icon(it.icon, 14) : '') +
                `<span>${it.label}</span>` +
                (it.hint ? `<span class="robco-menu-hint">${it.hint}</span>` : '');
            if (it.disabled) b.disabled = true;
            else {
                b.addEventListener('click', () => {
                    it.action?.();
                    if (it.keepOpen) this._refreshMenus();
                    else this._closeMenu();
                });
            }
            m.appendChild(b);
        }
    }

    _refreshMenus() {
        if (this._openMenu) this._renderMenuItems(this._openMenu.el, this._openMenu.menu);
    }

    _closeMenu() {
        if (!this._openMenu) return;
        this._openMenu.el.remove();
        this._openMenu.btn.classList.remove('open');
        this._openMenu = null;
    }

    async _sessionAction(kind) {
        this._closeMenu();
        try {
            const snap = await import('../sessionSnapshot.js');
            if (kind === 'save') {
                const session = await snap.saveSession(this.app);
                const json = JSON.stringify(session);
                const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                const a = document.createElement('a');
                const stamp = (session.savedAt || '').replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
                a.href = url;
                a.download = `workspace-${stamp || 'session'}.robcosession.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } else if (kind === 'load') {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,.robcosession.json,application/json';
                input.style.display = 'none';
                input.addEventListener('change', async () => {
                    const file = input.files?.[0];
                    input.remove();
                    if (!file) return;
                    const session = JSON.parse(await file.text());
                    if (session?.format !== snap.FORMAT) {
                        alert('Not a RobCo session file.');
                        return;
                    }
                    await snap.stageAndReload(session);
                });
                document.body.appendChild(input);
                input.click();
            } else if (kind === 'clear') {
                await snap.clearSavedSession();
                setTimeout(() => location.reload(), 200);
            }
        } catch (e) {
            console.error(`[RobCo] session ${kind} failed:`, e);
            alert(`Session ${kind} failed: ${e.message}`);
        }
    }

    _showAbout() {
        this._closeMenu();
        const overlay = el('div', 'robco-about-overlay');
        overlay.innerHTML = `<div class="robco-about-card">
            <div style="font-weight:700;font-size:14px;margin-bottom:8px;">Robot Viewer — RobCo Studio</div>
            <div style="color:#9da7b3;">Web-based robot model viewer (URDF / MJCF / USD / RobCo modules)
            with live RobFlow sessions, teach tools and virtual TCP cameras.</div>
            <div style="margin-top:12px;color:#6e7681;font-size:10.5px;">Drag panel headers to rearrange,
            snap them into the side bars, or pop them out into their own window.
            The layout is saved automatically.</div>
        </div>`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    // ------------------------------------------------------------------
    _save() {
        // prune stale keys, then persist
        this.state.left = this.state.left.filter((k, i, a) => a.indexOf(k) === i);
        this.state.right = this.state.right.filter((k, i, a) => a.indexOf(k) === i);
        this.state.bottom = (this.state.bottom || []).filter((k, i, a) => a.indexOf(k) === i);
        this.state.top = (this.state.top || []).filter((k, i, a) => a.indexOf(k) === i);
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.state)); } catch { /* ignore */ }
    }
}

export const dock = new DockManager();
