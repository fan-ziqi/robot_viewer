/**
 * Singularity Analysis panel — the single control surface for the singularity feature.
 *
 * Off by default. A master toggle enables PathSingularityManager (which scans the LIN segments
 * between cartesian waypoints and draws the heat line / worst-point markers / lost-DOF arrows /
 * per-waypoint halos). Individual scene layers and the scan settings (commanded speed, sample
 * density) are steered here, and the panel renders the readouts the manager publishes:
 *   - per LIN segment: a σ-health sparkline (reciprocal condition vs path) + a pass/warn/fault
 *     badge, closest-approach type, predicted slowdown, and branch-flip / limit-clamp flags;
 *   - per cartesian waypoint: a badge flagging taught poses whose own configuration is near-singular.
 *
 * Docks as the "Singularity Analysis" tab (key `singularity`), same chrome as the other panels.
 */
import { makeDraggable, makeCollapsible } from './draggable.js';

const PANEL_CSS =
    'position:fixed;right:332px;top:80px;z-index:3000;width:312px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);max-height:82vh;overflow:auto;';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;' +
    'color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;width:56px;';

const CLASS_COLOR = { ok: '#2ea043', warn: '#e3873a', fault: '#f85149', unreachable: '#8957e5' };
const CLASS_LABEL = { ok: 'OK', warn: 'WARN', fault: 'SINGULAR', unreachable: 'UNREACH' };

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function title(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', t);
}

export class SingularityPanel {
    static ensure(opts) {
        if (window._robcoSingularityPanel) {
            window._robcoSingularityPanel.update(opts);
            return window._robcoSingularityPanel;
        }
        const p = new SingularityPanel(opts);
        window._robcoSingularityPanel = p;
        return p;
    }

    constructor({ manager }) {
        this.manager = manager;
        this._build();
        this._subscribe();
    }

    update({ manager } = {}) {
        if (manager && manager !== this.manager) { this.manager = manager; this._subscribe(); }
        this._syncControls();
        this._renderResults(this.manager?.lastResults || { segments: [], waypoints: [] });
    }

    _subscribe() {
        if (!this.manager) return;
        this.manager.onResults = (r) => this._renderResults(r);
        this.manager.onSpeedState = (st) => this._renderSpeedState(st);
        this._syncControls();
        this._renderResults(this.manager.lastResults || { segments: [], waypoints: [] });
    }

    /** Reflect the manager's current enabled/options state onto the controls (after a rebuild). */
    _syncControls() {
        if (!this.manager || !this._enableCb) return;
        this._enableCb.checked = this.manager.enabled;
        for (const [k, cb] of Object.entries(this._layerCbs)) cb.checked = !!this.manager.opts[k];
        if (this._samples) this._samples.value = String(this.manager.opts.samples);
        this._renderSpeedState(this.manager._speedState());
        this._setControlsEnabled(this.manager.enabled);
    }

    _setControlsEnabled(on) {
        for (const c of this._gated) c.disabled = !on;
        this._renderSpeedState();
    }

    /** Render the global-speed control: the value in force + whether it's following the live
     *  session or a manual override, and enable/hide the ⟳ re-follow button accordingly. */
    _renderSpeedState(st) {
        if (!this._speed || !this._followBtn) return;
        const s = st || this.manager?._speedState();
        if (!s) return;
        // Show the value actually used by the scan; don't clobber the field while the user is typing.
        if (document.activeElement !== this._speed) this._speed.value = String(Math.round(s.effective * 100) / 100);
        const enabled = !!this.manager?.enabled;
        this._followBtn.style.display = s.hasSession ? 'inline-block' : 'none';
        this._followBtn.disabled = !enabled || s.following;
        this._followBtn.style.borderColor = s.following ? '#2ea043' : 'rgba(255,255,255,0.15)';
        this._followBtn.style.color = s.following ? '#2ea043' : '#e6edf3';
        if (!s.hasSession) {
            this._speedNote.textContent = 'No live session — manual scale.';
            this._speedNote.style.color = '#8b98a5';
        } else if (s.following) {
            this._speedNote.textContent = `⟳ following session global speed (${s.sessionSpeed.toFixed(2)})`;
            this._speedNote.style.color = '#2ea043';
        } else {
            this._speedNote.textContent = `manual override — session is ${s.sessionSpeed.toFixed(2)} · ⟳ to follow`;
            this._speedNote.style.color = '#e3873a';
        }
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Singularity Analysis  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        this._gated = [];
        this._layerCbs = {};

        // Master enable.
        const enableRow = el('label', 'display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;font-weight:600;');
        this._enableCb = el('input'); this._enableCb.type = 'checkbox'; this._enableCb.style.accentColor = '#2f81f7';
        this._enableCb.addEventListener('change', () => { this.manager?.setEnabled(this._enableCb.checked); this._setControlsEnabled(this._enableCb.checked); });
        enableRow.append(this._enableCb, el('span', null, 'Enable analysis'));
        body.append(enableRow);
        body.append(el('div', 'font-size:10.5px;color:#8b98a5;margin:0 0 4px;',
            'Scans the straight (LIN) path between cartesian waypoints and flags where the arm nears a singularity or must slow down. WARN = controller degrading path tracking (σ<0.04); SINGULAR = at the singularity limit (σ<0.005) — a programmed move damps & stalls here, only a manual jog hard-faults. Offline prediction; ≥6-axis arms only.'));
        this._status = el('div', 'font-size:11px;color:#9da7b3;min-height:14px;margin:4px 0;', 'Off.');
        body.append(this._status);

        // Layers.
        body.append(title('Show'));
        body.append(this._layer('showLine', 'Heat path line'));
        body.append(this._layer('showMarkers', 'Worst-point markers + labels'));
        body.append(this._layer('showArrows', 'Lost-DOF arrows'));
        body.append(this._layer('showWaypointFlags', 'Waypoint singularity halos'));

        // Settings.
        body.append(title('Settings'));
        const speedRow = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin:3px 0;');
        speedRow.append(el('span', 'opacity:.9;', 'Global speed scale ×'));
        const speedCtrls = el('div', 'display:flex;align-items:center;gap:5px;');
        this._speed = el('input', NUM); this._speed.type = 'number'; this._speed.min = '0.05'; this._speed.max = '1'; this._speed.step = '0.05'; this._speed.value = '1';
        this._speed.title = 'Type a value for offline what-if analysis; ⟳ re-follows the live session speed.';
        this._speed.addEventListener('change', () => this.manager?.setManualSpeedScale(+this._speed.value));
        // ⟳ re-follow the live RobFlow session's global speed (shown only when a session is connected).
        this._followBtn = el('button', BTN + 'padding:4px 7px;', '⟳');
        this._followBtn.title = 'Follow the live session global speed';
        this._followBtn.addEventListener('click', () => this.manager?.setFollowSession(true));
        speedCtrls.append(this._speed, this._followBtn);
        speedRow.append(speedCtrls);
        body.append(speedRow);
        body.append(el('div', 'font-size:10px;color:#8b98a5;margin:0 0 1px;',
            'Each segment’s speed = its waypoint velocity × this scale × 1.0 m/s.'));
        this._speedNote = el('div', 'font-size:10px;margin:0 0 2px;min-height:12px;');
        body.append(this._speedNote);
        this._gated.push(this._speed);

        const sampRow = el('div', 'display:flex;align-items:center;justify-content:space-between;margin:3px 0;');
        sampRow.append(el('span', 'opacity:.9;', 'Samples / segment'));
        this._samples = el('input', NUM); this._samples.type = 'number'; this._samples.min = '5'; this._samples.max = '81'; this._samples.step = '2'; this._samples.value = '21';
        this._samples.addEventListener('change', () => this.manager?.setOptions({ samples: Math.min(81, Math.max(5, Math.round(+this._samples.value || 21))) }));
        sampRow.append(this._samples);
        body.append(sampRow);
        this._gated.push(this._samples);

        const rescan = el('button', BTN + 'margin:6px 0 2px;', 'Rescan now');
        // scheduleRefresh so the click returns (and the button repaints) before a potentially
        // long synchronous scan starts.
        rescan.addEventListener('click', () => this.manager?.scheduleRefresh());
        body.append(rescan);
        this._gated.push(rescan);

        // Readouts.
        body.append(title('Segments (LIN)'));
        this._segList = el('div', 'display:flex;flex-direction:column;gap:6px;');
        body.append(this._segList);
        body.append(title('Waypoint configurations'));
        this._wpList = el('div', 'display:flex;flex-direction:column;gap:3px;');
        body.append(this._wpList);

        makeCollapsible(body, minBtn, 'singularity');
        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'singularity');

        this._setControlsEnabled(false);
    }

    _layer(key, label) {
        const row = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.style.accentColor = '#2f81f7';
        cb.addEventListener('change', () => this.manager?.setOptions({ [key]: cb.checked }));
        row.append(cb, el('span', 'opacity:.9;', label));
        this._layerCbs[key] = cb;
        this._gated.push(cb);
        return row;
    }

    _badge(cls) {
        const b = el('span', `display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;` +
            `color:#0d1117;background:${CLASS_COLOR[cls] || '#6e7681'};`, CLASS_LABEL[cls] || cls.toUpperCase());
        return b;
    }

    _renderResults({ segments = [], waypoints = [] } = {}) {
        // Status line.
        if (!this.manager?.enabled) this._status.textContent = 'Off.';
        else if (!segments.length) this._status.textContent = 'No cartesian segments to analyze — add ≥2 cartesian waypoints.';
        else {
            const worst = segments.reduce((w, s) => rank(s.worstClass) > rank(w) ? s.worstClass : w, 'ok');
            this._status.innerHTML = `${segments.length} LIN segment(s) analyzed · worst: `;
            this._status.append(this._badge(worst));
        }

        // Segments.
        this._segList.innerHTML = '';
        for (const s of segments) this._segList.append(this._segCard(s));
        if (this.manager?.enabled && !segments.length) this._segList.append(el('div', 'font-size:11px;color:#6e7681;', '—'));

        // Waypoints.
        this._wpList.innerHTML = '';
        if (!waypoints.length) this._wpList.append(el('div', 'font-size:11px;color:#6e7681;', this.manager?.enabled ? 'No cartesian waypoints with a captured pose.' : '—'));
        for (const w of waypoints) {
            const row = el('div', 'display:flex;align-items:center;gap:8px;');
            row.append(this._badge(w.class));
            row.append(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', w.name));
            row.append(el('span', 'color:#9da7b3;font-size:10.5px;', `1/κ ${w.reciprocalCondition.toFixed(3)}`));
            this._wpList.append(row);
        }
    }

    _segCard(s) {
        const card = el('div', 'border:1px solid rgba(255,255,255,0.1);border-radius:7px;padding:6px 7px;background:rgba(255,255,255,0.03);');
        const head = el('div', 'display:flex;align-items:center;gap:7px;margin-bottom:4px;');
        head.append(this._badge(s.worstClass));
        head.append(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', `${s.from} → ${s.to}`));
        head.append(el('span', 'color:#9da7b3;font-size:10.5px;', `${Math.round((s.minSlowdown ?? 1) * 100)}% speed`));
        card.append(head);

        card.append(this._sparkline(s.profile));

        const bits = [`cmd ${s.commandedSpeed.toFixed(2)} m/s`];
        if (s.worstClass !== 'ok') bits.push(`${s.worstType} · σ≥${s.minManipulability.toExponential(1)}`);
        else bits.push(`min 1/κ ${s.minReciprocalCondition.toFixed(3)}`);
        if (s.anyBranchFlip) bits.push('branch flip');
        if (s.anyClamped) bits.push('joint-limit clamp');
        card.append(el('div', 'font-size:10px;color:#8b98a5;margin-top:3px;', bits.join('  ·  ')));
        return card;
    }

    /** σ-health sparkline: reciprocal condition (0..1) vs path position, stroked per-sample by class. */
    _sparkline(profile) {
        const W = 286, H = 34, dpr = Math.min(2, window.devicePixelRatio || 1);
        const canvas = el('canvas', `width:100%;height:${H}px;display:block;`);
        canvas.width = W * dpr; canvas.height = H * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, 0, W, H);
        if (!profile || profile.length < 2) return canvas;
        const x = (i) => 1 + (i / (profile.length - 1)) * (W - 2);
        const y = (v) => H - 1 - Math.max(0, Math.min(1, v)) * (H - 2);
        // baseline at 0
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, H - 1); ctx.lineTo(W, H - 1); ctx.stroke();
        // per-segment coloured line
        ctx.lineWidth = 2;
        for (let i = 1; i < profile.length; i++) {
            ctx.strokeStyle = CLASS_COLOR[profile[i].class] || '#2ea043';
            ctx.beginPath();
            ctx.moveTo(x(i - 1), y(profile[i - 1].reciprocalCondition));
            ctx.lineTo(x(i), y(profile[i].reciprocalCondition));
            ctx.stroke();
        }
        return canvas;
    }
}

function rank(cls) { return { ok: 0, warn: 1, fault: 2, unreachable: 3 }[cls] ?? 0; }
