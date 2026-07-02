/**
 * Make a fixed-positioned element draggable by a handle (e.g. its title bar).
 * Pins the element to left/top on first drag (clearing right/bottom) and clamps to the
 * viewport. Drags that start on an interactive control are ignored so buttons/sliders work.
 *
 * Pass a stable `key` to remember the panel's position across reloads (localStorage).
 *
 * When the docking layout is active (default RobCo mode), both entry points hand the
 * panel over to the DockManager instead: the same key becomes the panel's dock identity,
 * and free-floating drag/collapse (plus the robco-pos- / robco-collapsed- persistence)
 * is bypassed entirely. `?chrome=1` keeps the legacy behavior below.
 */
import { dock } from './dock/DockManager.js';

const POS_PREFIX = 'robco-pos-';
const COLLAPSE_PREFIX = 'robco-collapsed-';

/**
 * Persist a panel's collapsed (minimized) state across reloads, mirroring how positions are stored.
 * Wires the minimize button to toggle `body` visibility + the ▾/▸ glyph, restores the saved state
 * on load, and saves on every toggle.
 * @param {HTMLElement} body - the collapsible content element.
 * @param {HTMLElement} btn  - the minimize button (text becomes ▾ when expanded / ▸ when collapsed).
 * @param {string} key       - stable key (shared with makeDraggable's position key).
 */
export function makeCollapsible(body, btn, key) {
    if (dock.enabled) {
        dock.adoptCollapsible(body, btn, key);
        return;
    }
    const apply = (collapsed) => {
        body.style.display = collapsed ? 'none' : 'block';
        btn.textContent = collapsed ? '▸' : '▾';
    };
    let collapsed = false;
    if (key) {
        try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_PREFIX + key)) === true; } catch { /* ignore */ }
    }
    apply(collapsed);
    btn.addEventListener('click', () => {
        collapsed = body.style.display !== 'none';
        apply(collapsed);
        if (key) { try { localStorage.setItem(COLLAPSE_PREFIX + key, JSON.stringify(collapsed)); } catch { /* ignore */ } }
    });
}

function loadPos(key) {
    try {
        const s = localStorage.getItem(POS_PREFIX + key);
        return s ? JSON.parse(s) : null;
    } catch {
        return null;
    }
}

function savePos(key, pos) {
    try {
        localStorage.setItem(POS_PREFIX + key, JSON.stringify(pos));
    } catch {
        /* storage unavailable */
    }
}

function clampPos(left, top) {
    return {
        left: Math.max(0, Math.min(window.innerWidth - 40, left)),
        top: Math.max(0, Math.min(window.innerHeight - 28, top)),
    };
}

export function makeDraggable(el, handle, key) {
    if (dock.enabled) {
        dock.adoptPanel(el, handle, key);
        return;
    }
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.style.touchAction = 'none';

    // Restore a saved position (pins to left/top, clearing the CSS right/bottom anchor).
    if (key) {
        const saved = loadPos(key);
        if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
            const { left, top } = clampPos(saved.left, saved.top);
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
    }

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button,input,select,textarea,a,label')) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';

        const startX = e.clientX;
        const startY = e.clientY;
        const origLeft = rect.left;
        const origTop = rect.top;

        const move = (ev) => {
            const { left, top } = clampPos(origLeft + ev.clientX - startX, origTop + ev.clientY - startY);
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (key) savePos(key, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });
}
