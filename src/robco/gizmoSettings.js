/**
 * Shared gizmo options — one source of truth for every TcpGizmo in the app (the teach pendant's
 * and the Setup align tool's). The dedicated Gizmo panel (GizmoPanel.js) edits these; each live
 * gizmo registers itself and gets `applySettings()` on every change, so both stay in lockstep and
 * the options live in exactly one place instead of being duplicated across panels.
 *
 * Defaults reproduce the historic behaviour exactly (world space, both handle sets shown, no snap,
 * no readout, no extra handles) — every new capability is opt-in from the panel. Persisted to
 * localStorage so a choice survives reloads.
 */
const KEY = 'robco-gizmo-settings';

const DEFAULTS = {
    space: 'world',       // 'world' | 'local'
    showTranslate: true,  // translate arrows + planar quads visible
    showRotate: true,     // rotate rings visible
    snap: false,          // hold-Shift snapping enabled (phase 2)
    snapDeg: 15,          // rotation snap increment when snapping (15 | 45 | 90)
    readout: false,       // live delta chip during a drag (phase 2)
    screenHandle: false,  // centre screen-space translate handle (phase 3)
    ringFade: false,      // depth cue on the rotate rings (phase 4)
};

let current = load();
const gizmos = new Set();
const subs = new Set();

function load() {
    try {
        const s = JSON.parse(localStorage.getItem(KEY));
        // Keep only known keys; fall back to defaults for anything missing or corrupt.
        return s && typeof s === 'object' ? { ...DEFAULTS, ...pick(s) } : { ...DEFAULTS };
    } catch {
        return { ...DEFAULTS };
    }
}

function pick(s) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (k in s) out[k] = s[k];
    return out;
}

/** Current settings (a copy — never mutate the returned object). */
export function get() {
    return { ...current };
}

/** Merge a partial update, persist, then push it to every live gizmo and subscriber. */
export function set(partial) {
    current = { ...current, ...pick(partial) };
    if (!current.showTranslate && !current.showRotate) current.showTranslate = true; // never both off
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage unavailable */ }
    const snapshot = get();
    for (const g of gizmos) { try { g.applySettings(snapshot); } catch (e) { console.warn('[RobCo] gizmo applySettings:', e); } }
    for (const fn of subs) { try { fn(snapshot); } catch (e) { console.warn('[RobCo] gizmo settings subscriber:', e); } }
}

/** A gizmo registers to receive settings now and on every future change. */
export function registerGizmo(g) {
    gizmos.add(g);
    try { g.applySettings(get()); } catch (e) { console.warn('[RobCo] gizmo applySettings:', e); }
}

export function unregisterGizmo(g) {
    gizmos.delete(g);
}

/** UI (the Gizmo panel) subscribes to reflect changes it didn't originate (e.g. the W/E keys). */
export function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}
