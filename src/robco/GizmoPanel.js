/**
 * Gizmo panel — the single home for the combined-gizmo options (space, which handle sets show,
 * and — later phases — snapping / readout / extra handles). Same self-contained, draggable /
 * collapsible / dock-adoptable pattern as SessionPanel & SetupPanel (key 'gizmo').
 *
 * It only edits the shared gizmoSettings; every live TcpGizmo (teach + Setup align) applies those
 * automatically, so the options live here instead of being duplicated in the Teach and Setup
 * panels. Defaults reproduce today's behaviour (World space, both handle sets shown).
 */
import { makeDraggable, makeCollapsible } from './draggable.js';
import { get, set, subscribe } from './gizmoSettings.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:120px;z-index:3000;width:230px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'flex:1;font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 9px;cursor:pointer;';
const ACTIVE = '#1f6feb';
const IDLE = 'rgba(255,255,255,0.06)';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function label(text) {
    return el('div', 'font-size:10px;letter-spacing:.05em;opacity:.7;text-transform:uppercase;margin:6px 0 2px;', text);
}
function row() {
    return el('div', 'display:flex;gap:6px;');
}

export class GizmoPanel {
    static ensure() {
        if (window._robcoGizmoPanel) return window._robcoGizmoPanel;
        const p = new GizmoPanel();
        window._robcoGizmoPanel = p;
        return p;
    }

    constructor() {
        this._build();
        this._unsub = subscribe(() => this._refresh());
        this._refresh();
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const title = el('span', null, 'Gizmo  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(title, minBtn);
        root.append(header);

        const body = el('div', 'margin-top:6px;');
        root.append(body);
        body.append(el('div', 'font-size:10px;color:#6e7681;margin:2px 0 2px;',
            'Options for the teach + align gizmo.'));

        // --- Space -----------------------------------------------------------
        body.append(label('Space'));
        const spaceRow = row();
        this._worldBtn = el('button', BTN, 'World');
        this._localBtn = el('button', BTN, 'Local');
        this._worldBtn.addEventListener('click', () => set({ space: 'world' }));
        this._localBtn.addEventListener('click', () => set({ space: 'local' }));
        spaceRow.append(this._worldBtn, this._localBtn);
        body.append(spaceRow);

        // --- Handles ---------------------------------------------------------
        body.append(label('Handles'));
        const handleRow = row();
        this._moveBtn = el('button', BTN, 'Move');
        this._rotBtn = el('button', BTN, 'Rotate');
        this._moveBtn.addEventListener('click', () => set({ showTranslate: !get().showTranslate }));
        this._rotBtn.addEventListener('click', () => set({ showRotate: !get().showRotate }));
        handleRow.append(this._moveBtn, this._rotBtn);
        body.append(handleRow);

        makeCollapsible(body, minBtn, 'gizmo');
        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title, 'gizmo');
    }

    _refresh() {
        const s = get();
        this._worldBtn.style.background = s.space === 'world' ? ACTIVE : IDLE;
        this._localBtn.style.background = s.space === 'local' ? ACTIVE : IDLE;
        this._moveBtn.style.background = s.showTranslate ? ACTIVE : IDLE;
        this._rotBtn.style.background = s.showRotate ? ACTIVE : IDLE;
    }

    dispose() {
        this._unsub?.();
        this.root?.remove();
    }
}
