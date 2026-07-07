/**
 * Floating per-joint dynamics panel: angle / velocity / acceleration / torque / utilization.
 *
 * Pure DOM (no framework), styled to sit over the three.js canvas. Built once for a given
 * joint count; `render()` just updates values + the utilization bars.
 */
import { makeDraggable } from '../robco/draggable.js';
import { JointTimeline } from './JointTimeline.js';

const RAD2DEG = 180 / Math.PI;

function utilColor(u) {
    if (u == null) return '#5b6b7a';
    if (u < 0.5) return '#3fb950'; // green
    if (u < 0.8) return '#d29922'; // amber
    return '#f85149'; // red
}

// i²t heat index colour (% of the limiting threshold; the drive starts limiting at 100,
// releases at 50). Uses a cooler palette to read as "thermal" vs the load bar above.
function heatColor(h) {
    if (h == null) return 'transparent';
    if (h < 50) return '#2f81f7'; // blue (cool)
    if (h < 100) return '#d29922'; // amber (warming)
    return '#f85149'; // red (limiting)
}

/** Utilisation as a percent label; '>100%' over the limit, '—' when unknown. */
function fmtUtil(u) {
    if (u == null) return '—';
    return u > 1 ? '>100%' : `${(u * 100).toFixed(0)}%`;
}

/** Paint one utilisation bar (width clamped to 100%, colour by util, percent label). */
function setBar(bar, pct, u) {
    bar.style.width = u == null ? '0' : `${Math.min(100, u * 100).toFixed(0)}%`;
    bar.style.background = utilColor(u);
    pct.textContent = fmtUtil(u);
}

export class DynamicsDashboard {
    /**
     * @param {string[]} jointLabels - one label per joint (base->flange).
     * @param {HTMLElement} [parent=document.body]
     */
    constructor(jointLabels, parent = document.body) {
        this.jointLabels = jointLabels;
        this.rows = [];
        this._heatEma = []; // per-joint smoothed heat, for the trend arrow (rising/cooling)
        /** @type {?(s:{fixedDt:boolean,fixedDtMs:number})=>void} */
        this.onSettingsChange = null;
        /** @type {?(kg:number)=>void} */
        this.onPayloadChange = null;
        /** @type {?(on:boolean)=>void} */
        this.onMotorModelChange = null;
        /** @type {?()=>void} - reset the i²t heat accumulation (fired by the Graphs "Reset heat" button). */
        this.onResetHeat = null;
        this.settings = DynamicsDashboard._loadSettings();
        this._motorModel = DynamicsDashboard._loadMotorModel();
        const pay = DynamicsDashboard._loadPayload();
        this._payloadKg = pay.kg;
        this._payloadCom = pay.com; // CoM offset from the flange/TCP, in mm
        this._robotPayloadSeen = false; // have we ever heard a payload from RobFlow this session?
        this._build(parent);
    }

    getPayload() {
        return this._payloadKg;
    }

    /** CoM offset converted to metres (what the dynamics payload API expects). */
    getPayloadComMeters() {
        return this._payloadCom.map((v) => v / 1000);
    }

    /**
     * Render the "what we use" line: the combined payload across all sources.
     * @param {Array<{source:string, mass:number}>} entries
     */
    setPayloadSummary(entries) {
        const el = this._payloadSummaryEl;
        if (!el) return;
        const NAMES = { tcp: 'TCP', gripper: 'gripper', robot: 'RobFlow' };
        const active = (entries || []).filter((e) => e.mass > 0);
        if (active.length < 2) { el.style.display = 'none'; return; } // a single source is self-evident
        const total = active.reduce((s, e) => s + e.mass, 0);
        const parts = active.map((e) => `${NAMES[e.source] || e.source} ${e.mass.toFixed(2)}`);
        el.textContent = `payloads: ${parts.join(' + ')} = ${total.toFixed(2)} kg`;
        el.style.display = 'block';
    }

    /**
     * Render the "what we receive from RobFlow" line: the live robot-reported payload, which feed
     * it came from, and whether the inertia tensor was usable. Pass null to clear (shows "none"
     * once RobFlow has been heard from at least once).
     * @param {{mass:number, com:number[], via?:string, inertia?:number[][]|null,
     *   inertiaApplied?:boolean, tool?:string|null}|null} info
     */
    setRobotPayloadInfo(info) {
        const el = this._robotPayloadEl;
        if (!el) return;
        if (!info || !(info.mass > 0)) {
            if (this._robotPayloadSeen) {
                el.innerHTML = '<span style="color:#238636;">●</span> '
                    + '<span style="opacity:.6;">RobFlow payload: none reported (0 kg)</span>';
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
            return;
        }
        this._robotPayloadSeen = true;
        const com = (info.com || [0, 0, 0]).map((v) => Math.round(v * 1000)); // m -> mm for display
        const inertia = info.inertiaApplied
            ? 'inertia ✓'
            : (info.inertia ? 'inertia ✗ ignored' : 'point mass');
        // The tool name is backend-supplied → escape before it goes into innerHTML.
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const tool = info.tool ? ` · tool “${esc(info.tool)}”` : '';
        el.innerHTML =
            `<span style="color:#238636;">●</span> <span style="color:#e6edf3;">RobFlow payload</span> `
            + `<span style="opacity:.85;">${info.mass.toFixed(2)} kg @ [${com.join(', ')}] mm · ${inertia}${tool}</span>`
            + `<br><span style="opacity:.5;">received via ${info.via || 'payload'} · applied to torque</span>`;
        el.style.display = 'block';
    }

    static _loadPayload() {
        try {
            const raw = JSON.parse(localStorage.getItem('robco-tcp-payload'));
            if (typeof raw === 'number') return { kg: Math.max(0, raw), com: [0, 0, 0] }; // legacy
            if (raw && typeof raw === 'object') {
                return { kg: Math.max(0, raw.kg || 0), com: Array.isArray(raw.com) ? raw.com : [0, 0, 0] };
            }
        } catch { /* ignore */ }
        return { kg: 0, com: [0, 0, 0] };
    }

    static _savePayload(kg, com) {
        try { localStorage.setItem('robco-tcp-payload', JSON.stringify({ kg, com })); } catch { /* ignore */ }
    }

    getSettings() {
        return { ...this.settings };
    }

    /** @returns {boolean} whether the motor model (friction + inertia + current) is applied. */
    getMotorModel() {
        return this._motorModel;
    }

    static _loadMotorModel() {
        try {
            const v = JSON.parse(localStorage.getItem('robco-dyn-motormodel'));
            if (typeof v === 'boolean') return v;
        } catch { /* ignore */ }
        return true; // default: real-hardware-accurate
    }

    static _saveMotorModel(on) {
        try { localStorage.setItem('robco-dyn-motormodel', JSON.stringify(!!on)); } catch { /* ignore */ }
    }

    static _loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('robco-dyn-settings'));
            if (s && typeof s.fixedDt === 'boolean') {
                return { fixedDt: s.fixedDt, fixedDtMs: s.fixedDtMs > 0 ? s.fixedDtMs : 60 };
            }
        } catch { /* ignore */ }
        return { fixedDt: true, fixedDtMs: 60 };
    }

    static _saveSettings(s) {
        try {
            localStorage.setItem('robco-dyn-settings', JSON.stringify(s));
        } catch { /* ignore */ }
    }

    _build(parent) {
        // Singleton in the DOM: drop any leftover Joint Dynamics panel from a prior controller so
        // there is never more than one (guards against any path that attaches twice on a reload).
        document.querySelectorAll('.robco-dynamics-panel').forEach((n) => n.remove());
        const el = document.createElement('div');
        el.className = 'robco-dynamics-panel';
        el.style.cssText = `
            position: fixed; left: 16px; bottom: 16px; z-index: 3000;
            font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
            color: #e6edf3; background: rgba(13,17,23,0.88);
            border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
            padding: 10px 12px; min-width: 450px; backdrop-filter: blur(6px);
            box-shadow: 0 6px 24px rgba(0,0,0,0.4);`;

        const title = document.createElement('div');
        title.textContent = 'Joint Dynamics  ⠿';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;color:#fff;';
        el.appendChild(title);
        this._title = title;

        // TCP payload — mass (kg) + CoM offset (mm, flange frame); included in torque / util.
        const inputCss = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
        const numIn = (val, w) => {
            const i = document.createElement('input');
            i.type = 'number'; i.step = '1'; i.value = String(val);
            i.style.cssText = inputCss + `width:${w}px;`;
            return i;
        };
        const dim = (t) => { const s = document.createElement('span'); s.textContent = t; s.style.opacity = '.6'; return s; };

        const massIn = numIn(this._payloadKg, 58);
        massIn.step = '0.1';
        const cx = numIn(this._payloadCom[0], 40);
        const cy = numIn(this._payloadCom[1], 40);
        const cz = numIn(this._payloadCom[2], 40);

        const emitPayload = () => {
            this._payloadKg = Math.max(0, parseFloat(massIn.value) || 0);
            massIn.value = String(this._payloadKg);
            this._payloadCom = [cx, cy, cz].map((i) => parseFloat(i.value) || 0);
            DynamicsDashboard._savePayload(this._payloadKg, this._payloadCom);
            this.onPayloadChange?.(this._payloadKg, this.getPayloadComMeters());
        };
        [massIn, cx, cy, cz].forEach((i) => i.addEventListener('change', emitPayload));

        const massRow = document.createElement('div');
        massRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';
        const massLbl = document.createElement('span'); massLbl.textContent = 'TCP load'; massLbl.style.opacity = '.8';
        massRow.append(massLbl, massIn, dim('kg'));
        el.appendChild(massRow);

        const comRow = document.createElement('div');
        comRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:6px;font-size:11px;';
        const comLbl = document.createElement('span'); comLbl.textContent = 'CoM'; comLbl.style.cssText = 'opacity:.8;margin-right:2px;';
        comRow.append(comLbl, dim('x'), cx, dim('y'), cy, dim('z'), cz, dim('mm'));
        el.appendChild(comRow);

        // "What we use": combined payload across all sources (TCP + gripper + RobFlow).
        this._payloadSummaryEl = document.createElement('div');
        this._payloadSummaryEl.style.cssText = 'font-size:10px;color:#9da7b3;margin:-2px 0 4px;display:none;';
        el.appendChild(this._payloadSummaryEl);
        // "What we receive": the live RobFlow-reported payload + how we apply it.
        this._robotPayloadEl = document.createElement('div');
        this._robotPayloadEl.style.cssText = 'font-size:10px;margin:0 0 8px;display:none;line-height:1.55;';
        el.appendChild(this._robotPayloadEl);

        const head = document.createElement('div');
        head.style.cssText =
            'display:grid;grid-template-columns:28px 44px 44px 44px 50px 44px 1fr 1fr;gap:6px;' +
            'opacity:.6;margin-bottom:4px;';
        ['', '°', '°/s', '°/s²', 'N·m', 'A', 'mech', 'curr'].forEach((h) => {
            const c = document.createElement('div');
            c.textContent = h;
            c.style.textAlign = h === '' ? 'left' : 'right';
            head.appendChild(c);
        });
        el.appendChild(head);

        this.jointLabels.forEach((label, i) => {
            const row = document.createElement('div');
            row.style.cssText =
                'display:grid;grid-template-columns:28px 44px 44px 44px 50px 44px 1fr 1fr;gap:6px;' +
                'align-items:center;padding:2px 0;';
            const cells = {};
            const mk = (key, align = 'right') => {
                const c = document.createElement('div');
                c.style.textAlign = align;
                row.appendChild(c);
                cells[key] = c;
                return c;
            };
            mk('name', 'left').textContent = `J${i + 1}`;
            mk('angle');
            mk('vel');
            mk('acc');
            mk('torque');
            mk('current');
            // Two utilisation bars: 'mech' = torque vs gearbox peak, 'curr' = motor current vs
            // the drive limit (speed-aware). The current bar also carries the i²t thermal
            // underline (a thin bar along the bottom, 0..100% = the drive's limiting threshold).
            const makeBar = (withHeat) => {
                const wrap = document.createElement('div');
                wrap.style.cssText =
                    'height:12px;background:rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;position:relative;';
                const bar = document.createElement('div');
                bar.style.cssText = 'height:100%;width:0;border-radius:6px;transition:width .08s linear;';
                wrap.appendChild(bar);
                let heat = null;
                if (withHeat) {
                    heat = document.createElement('div');
                    heat.style.cssText =
                        'position:absolute;left:0;bottom:0;height:3px;width:0;border-radius:2px;transition:width .15s linear;';
                    wrap.appendChild(heat);
                }
                const pct = document.createElement('span');
                pct.style.cssText =
                    'position:absolute;right:4px;top:0;line-height:12px;font-size:10px;color:#fff;';
                wrap.appendChild(pct);
                // i²t heat trend arrow (current bar only): ▲ heating / ▼ cooling / – steady.
                let trend = null;
                if (withHeat) {
                    trend = document.createElement('span');
                    trend.style.cssText =
                        'position:absolute;left:4px;top:0;line-height:12px;font-size:9px;font-weight:700;' +
                        'text-shadow:0 0 2px rgba(0,0,0,0.85);';
                    wrap.appendChild(trend);
                }
                row.appendChild(wrap);
                return { wrap, bar, pct, heat, trend };
            };
            const mech = makeBar(false);
            const curr = makeBar(true);
            cells.mechBar = mech.bar; cells.mechPct = mech.pct; cells.mechWrap = mech.wrap;
            cells.currBar = curr.bar; cells.currPct = curr.pct; cells.currWrap = curr.wrap;
            cells.heat = curr.heat;
            cells.trend = curr.trend;
            cells.title = label;
            row.title = label;

            el.appendChild(row);
            this.rows.push(cells);
        });

        this._buildSettings(el);

        // Per-joint time-series graphs (mech/curr utilization + i²t heat), collapsible.
        // Resetting heat also clears the trend baseline so the arrows restart neutral.
        this._timeline = new JointTimeline(this.jointLabels, {
            onResetHeat: () => { this._heatEma = []; this.onResetHeat?.(); },
        });
        el.appendChild(this._timeline.element);

        parent.appendChild(el);
        this.el = el;
        makeDraggable(el, this._title, 'dynamics');
    }

    _buildSettings(container) {
        const wrap = document.createElement('div');
        wrap.style.cssText =
            'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);' +
            'display:flex;align-items:center;gap:8px;font-size:11px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.settings.fixedDt;
        cb.style.cssText = 'accent-color:#3fb950;cursor:pointer;margin:0;';
        const lbl = document.createElement('label');
        lbl.textContent = 'Fixed Δt';
        lbl.style.cursor = 'pointer';
        lbl.prepend(cb);
        lbl.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';

        const num = document.createElement('input');
        num.type = 'number';
        num.min = '1';
        num.step = '0.5';
        num.value = String(this.settings.fixedDtMs);
        num.style.cssText =
            'width:52px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
        const unit = document.createElement('span');
        unit.textContent = 'ms';
        unit.style.opacity = '.7';
        const hz = document.createElement('span');
        hz.style.cssText = 'opacity:.55;margin-left:auto;';

        const updHz = () => {
            const ms = parseFloat(num.value) || 0;
            hz.textContent = ms > 0 ? `${(1000 / ms).toFixed(1)} Hz` : '';
        };
        const emit = () => {
            this.settings = { fixedDt: cb.checked, fixedDtMs: parseFloat(num.value) || 60 };
            num.disabled = !cb.checked;
            num.style.opacity = cb.checked ? '1' : '.4';
            DynamicsDashboard._saveSettings(this.settings);
            updHz();
            this.onSettingsChange?.(this.settings);
        };

        cb.addEventListener('change', emit);
        num.addEventListener('change', emit);
        num.addEventListener('input', updHz);
        num.disabled = !cb.checked;
        num.style.opacity = cb.checked ? '1' : '.4';
        updHz();

        wrap.append(lbl, num, unit, hz);
        container.appendChild(wrap);

        // Motor-model toggle: ON = real-hardware (NE + friction + reflected inertia + current),
        // OFF = twin-accurate (rigid-body Newton-Euler torque only).
        const mwrap = document.createElement('div');
        mwrap.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:8px;font-size:11px;';
        const mcb = document.createElement('input');
        mcb.type = 'checkbox';
        mcb.checked = this._motorModel;
        mcb.style.cssText = 'accent-color:#3fb950;cursor:pointer;margin:0;';
        const mlbl = document.createElement('label');
        mlbl.textContent = 'Motor model (friction + inertia)';
        mlbl.prepend(mcb);
        mlbl.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';
        const mnote = document.createElement('span');
        mnote.style.cssText = 'opacity:.55;margin-left:auto;';
        const updNote = () => { mnote.textContent = mcb.checked ? 'real' : 'twin'; };
        mcb.addEventListener('change', () => {
            this._motorModel = mcb.checked;
            DynamicsDashboard._saveMotorModel(this._motorModel);
            updNote();
            this.onMotorModelChange?.(this._motorModel);
        });
        updNote();
        mwrap.append(mlbl, mnote);
        container.appendChild(mwrap);
    }

    /**
     * @param {Object} t
     * @param {number[]} t.angleDeg
     * @param {number[]} t.velocity    - rad/s
     * @param {number[]} t.acceleration- rad/s²
     * @param {number[]} t.torque      - N·m
     * @param {(number|null)[]} t.utilization - torque utilization, 0..1
     * @param {(number|null)[]} [t.current]     - motor q-axis current, A
     * @param {(number|null)[]} [t.currentUtil] - current utilization (vs peak current), 0..1
     * @param {(number|null)[]} [t.heat]        - i²t heat index, 0..250 (%)
     */
    render({ angleDeg, velocity, acceleration, torque, utilization, current, currentUtil, heat }) {
        for (let i = 0; i < this.rows.length; i++) {
            const r = this.rows[i];
            r.angle.textContent = (angleDeg?.[i] ?? 0).toFixed(1);
            r.vel.textContent = ((velocity?.[i] ?? 0) * RAD2DEG).toFixed(1);
            r.acc.textContent = ((acceleration?.[i] ?? 0) * RAD2DEG).toFixed(0);
            r.torque.textContent = (torque?.[i] ?? 0).toFixed(1);
            const iq = current?.[i];
            r.current.textContent = iq == null ? '—' : iq.toFixed(1);
            // Two independent bars: mechanical (torque vs gearbox peak) and current (electrical,
            // speed-aware vs the drive limit). They are different ceilings, shown side by side.
            const ut = utilization?.[i];
            const uc = currentUtil?.[i];
            setBar(r.mechBar, r.mechPct, ut);
            setBar(r.currBar, r.currPct, uc);
            if (r.mechWrap) r.mechWrap.title = `${r.title} — torque (mechanical) ${fmtUtil(ut)}`;
            // i²t thermal underline under the current bar (heat is a %; 100 = limiting threshold).
            const h = heat?.[i];
            if (r.heat) {
                r.heat.style.width = h == null ? '0' : `${Math.min(100, h).toFixed(0)}%`;
                r.heat.style.background = heatColor(h);
            }
            // Minimal heat-trend arrow on the current bar: ▲ heating / ▼ cooling / – steady.
            if (r.trend) this._renderHeatTrend(r.trend, i, h);
            if (r.currWrap) {
                r.currWrap.title = `${r.title} — current (electrical) ${fmtUtil(uc)}`
                    + (h == null ? '' : `, i²t heat ${h.toFixed(0)}%`);
            }
        }
        // Append this sample to the per-joint time-series graphs.
        this._timeline?.push({ mech: utilization, curr: currentUtil, heat });
    }

    /**
     * Update the per-joint heat-trend arrow from the i²t heat index. Compares the live heat to a
     * slow EMA of itself: above the smoothed value ⇒ accumulating (▲), below ⇒ cooling (▼), within
     * a small deadband ⇒ steady (–). This reads the multi-second trend, not frame-to-frame jitter.
     * @param {HTMLElement} node
     * @param {number} i - joint index
     * @param {number|null} h - i²t heat index (%), null when unknown
     */
    _renderHeatTrend(node, i, h) {
        if (h == null) { node.textContent = ''; node.title = ''; return; }
        const ema = this._heatEma[i];
        if (ema == null) {
            this._heatEma[i] = h;
            node.textContent = '–'; node.style.color = '#5b6b7a'; node.title = 'heat steady';
            return;
        }
        const d = h - ema;
        this._heatEma[i] = ema + 0.05 * d; // ~1–2 s time constant at stream rate
        const EPS = 0.3; // % deadband so a flat heat doesn't flicker
        if (d > EPS) { node.textContent = '▲'; node.style.color = '#f85149'; node.title = 'heat rising'; }
        else if (d < -EPS) { node.textContent = '▼'; node.style.color = '#2f81f7'; node.title = 'heat cooling'; }
        else { node.textContent = '–'; node.style.color = '#5b6b7a'; node.title = 'heat steady'; }
    }

    dispose() {
        this._timeline?.dispose();
        this.el?.remove();
    }
}
