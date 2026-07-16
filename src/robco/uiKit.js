/**
 * Tiny shared UI helpers for the RobCo panels (no framework, inline styles by design).
 */

/** Create an element with inline css text and optional text content. */
export function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

/** 840 ms · 1.24 s */
export function fmtMs(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// Shared hover tooltip (one fixed div, shown next to whatever element is hovered). Used where a
// native title= is too small/slow — e.g. a folder's description, which must only appear on hover.
let _tipEl = null;
export function attachTip(target, textFn) {
    target.addEventListener('mouseenter', () => {
        const text = textFn();
        if (!text) return;
        if (!_tipEl) {
            _tipEl = el('div', 'position:fixed;z-index:5000;max-width:260px;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
                'color:#e6edf3;background:rgba(22,27,34,0.97);border:1px solid rgba(255,255,255,0.18);border-radius:6px;' +
                'padding:6px 8px;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.5);white-space:pre-wrap;');
            document.body.appendChild(_tipEl);
        }
        _tipEl.textContent = text;
        _tipEl.style.display = 'block';
        const r = target.getBoundingClientRect();
        _tipEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
        // Flip above the anchor when it sits in the lower quarter (e.g. bottom-docked panels).
        if (r.bottom > window.innerHeight - 120) {
            _tipEl.style.top = 'auto';
            _tipEl.style.bottom = `${window.innerHeight - r.top + 4}px`;
        } else {
            _tipEl.style.bottom = 'auto';
            _tipEl.style.top = `${r.bottom + 4}px`;
        }
    });
    target.addEventListener('mouseleave', () => { if (_tipEl) _tipEl.style.display = 'none'; });
}
