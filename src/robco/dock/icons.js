/**
 * Inline SVG icon set for the dock UI (16x16 viewBox, stroke = currentColor).
 * Kept dependency-free on purpose — the RobCo layer ships no icon font or asset pipeline.
 */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
    // panel icons
    session: `<path d="M3 4.5h10v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M5 4.5V2.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v1.7"/><path d="M5.5 8h5M5.5 10.5h5"/>`,
    view: `<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="2.1"/>`,
    setup: `<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M14.2 8h-2M3.8 8h-2M12.4 3.6l-1.4 1.4M5 11l-1.4 1.4M12.4 12.4 11 11M5 5 3.6 3.6"/>`,
    render: `<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12c-1.6-1.2-2.4-3.6-2.4-6S6.4 3.2 8 2Z"/><path d="M2.3 6h11.4M2.3 10h11.4"/>`,
    tools: `<path d="M9.8 2.6a3.5 3.5 0 0 0-4.6 4.4L2 10.2a1.4 1.4 0 0 0 2 2l3.2-3.3a3.5 3.5 0 0 0 4.4-4.6L9.4 6.5l-1.9-1.9z"/>`,
    camera: `<rect x="1.8" y="4.4" width="9" height="7.2" rx="1.2"/><path d="m10.8 7.2 3.4-2v5.6l-3.4-2"/>`,
    waypoints: `<circle cx="3.4" cy="12.6" r="1.6"/><circle cx="12.6" cy="3.4" r="1.6"/><path d="M4.8 11.4c2.4-1 5.6-4.2 6.6-6.6" stroke-dasharray="2 1.6"/>`,
    stream: `<path d="M1.8 8h2.6l1.8-4.4 2.6 8.8L10.6 8h3.6"/>`,
    dynamics: `<path d="M2 13.5h12"/><path d="M2.5 11.5c2-.5 3-6 4.5-6s2 3.6 3.5 3.6 2-1.8 3.5-2"/>`,
    blender: `<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 3v10M11 3v10"/><path d="M2 6h3M2 10h3M11 6h3M11 10h3"/>`,
    singularity: `<path d="M8 1.8 14.6 13.4H1.4z"/><path d="M8 6v3.2"/><path d="M8 11.4v.1"/>`,
    gizmo: `<path d="M8 4v8M4 8h8"/><path d="M8 2.6 6.8 4.2M8 2.6 9.2 4.2M8 13.4 6.8 11.8M8 13.4 9.2 11.8M2.6 8 4.2 6.8M2.6 8 4.2 9.2M13.4 8 11.8 6.8M13.4 8 11.8 9.2"/>`,
    // generic fallback panel icon
    panel: `<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 5.5h12"/>`,
    // chrome / menu icons
    save: `<path d="M3 2.5h8.2L13 4.3V13a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 13V2.5Z"/><path d="M5 2.5V6h5.4V2.5"/><rect x="5" y="9" width="6" height="4.5"/>`,
    load: `<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>`,
    trash: `<path d="M2.8 4.4h10.4M6.4 4.4V3a.6.6 0 0 1 .6-.6h2a.6.6 0 0 1 .6.6v1.4M4.2 4.4l.7 8.4a.8.8 0 0 0 .8.7h4.6a.8.8 0 0 0 .8-.7l.7-8.4"/>`,
    gear: `<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M14.2 8h-2M3.8 8h-2M12.4 3.6l-1.4 1.4M5 11l-1.4 1.4M12.4 12.4 11 11M5 5 3.6 3.6"/>`,
    export: `<path d="M8 10V2.2M5.2 4.8 8 2l2.8 2.8"/><path d="M3 8.5V13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8.5"/>`,
    theme: `<circle cx="8" cy="8" r="6"/><path d="M8 2v12A6 6 0 0 0 8 2Z" fill="currentColor" stroke="none"/>`,
    reset: `<path d="M2.6 6.5A5.6 5.6 0 1 1 2.4 9.5"/><path d="M2.4 3.4v3.2h3.2"/>`,
    dockLeft: `<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/><path d="M3.2 8h1.6" />`,
    help: `<circle cx="8" cy="8" r="6"/><path d="M6.2 6.2A1.9 1.9 0 1 1 8 8.4v1"/><path d="M8 11.6v.1"/>`,
    plug: `<path d="M5.5 2.5v3M10.5 2.5v3M4 5.5h8v2.4a4 4 0 0 1-8 0z"/><path d="M8 11.9v1.9"/>`,
    // window buttons
    chevron: `<path d="m4.2 6.2 3.8 3.8 3.8-3.8"/>`,
    popout: `<path d="M6.5 3H3.6A.6.6 0 0 0 3 3.6v8.8a.6.6 0 0 0 .6.6h8.8a.6.6 0 0 0 .6-.6V9.5"/><path d="M9.4 2.6H13.4V6.6M13.2 2.8 8 8"/>`,
    close: `<path d="m4 4 8 8M12 4l-8 8"/>`,
    check: `<path d="m3.4 8.4 2.9 2.9 6.3-6.6"/>`,
};

/** Return an <svg> string for a named icon (falls back to a generic panel glyph). */
export function icon(name, size = 16) {
    const body = ICONS[name] || ICONS.panel;
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" ${STROKE} aria-hidden="true">${body}</svg>`;
}
