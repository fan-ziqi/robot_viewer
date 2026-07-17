/**
 * Escape untrusted text (file names, model- or backend-supplied strings) before it is
 * interpolated into innerHTML. The single vetted implementation — don't hand-roll copies.
 */
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
