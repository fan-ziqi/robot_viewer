/**
 * RobFlow Tools panel — consolidated control surface (inspired by RobFlowLink):
 *   • Status  — WebSocket ● + API ● + decoded robot / operation / safety state.
 *   • Teach   — gizmo on/off, Move/Rotate handle toggles, IK readout, Send (velocity/accel/approach), Stop.
 *   • Control — Enable (operational), Stop, global-speed.
 *
 * Drives the TeachPendant gizmo engine and a RobFlowClient. Sections that need a robot
 * (Send/Control/Status) are hidden when there is no client (static preview).
 */
import { OPERATION_MODE, ROBOT_STATE, SAFETY_STATE, label, SEVERITY_COLOR, canTeach } from './robcoEnums.js';
import { makeDraggable } from './draggable.js';
import { loadPresets, matchPreset, MODULES_CDN } from './robotPresets.js';

const PANEL_CSS =
    'position:fixed;right:16px;top:16px;z-index:3000;width:300px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:7px;padding:6px 10px;cursor:pointer;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function dot(color) {
    return `display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;`;
}
function sectionTitle(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:12px 0 6px;text-transform:uppercase;font-size:10px;', t);
}
/** Labeled slider row → { row, get } */
function slider(labelText, min, max, step, val, onInput) {
    const row = el('div', 'display:grid;grid-template-columns:64px 1fr 40px;gap:8px;align-items:center;margin:4px 0;');
    row.append(el('span', 'opacity:.8;', labelText));
    const input = el('input', 'width:100%;accent-color:#2f81f7;');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
    const out = el('span', 'text-align:right;opacity:.9;', (+val).toFixed(2));
    input.addEventListener('input', () => { out.textContent = (+input.value).toFixed(2); onInput?.(+input.value); });
    row.append(input, out);
    return { row, get: () => +input.value };
}

export class RobFlowToolsPanel {
    constructor(app, { teach = null, client = null } = {}) {
        this.app = app;
        this.teach = teach;
        this.client = client;
        this.states = {};
        this._build();
        if (teach) this.setTeach(teach);
        if (client) this._pingApi();
    }

    /** Attach (or replace) the teach gizmo engine after the robot is built. */
    setTeach(teach) {
        this.teach = teach;
        if (teach) {
            // onIk fires on a gizmo drag (the TCP moved) — show the new IK readout and drop any
            // configuration list, which was enumerated for the previous TCP and is now stale.
            teach.onIk = (res) => { this._setIk(res); this._clearPoses(); };
            // Keep the Teach button in sync when the arbiter turns the gizmo off.
            teach.onEnabledChange = (on) => this._teachVisible(on);
            if (this.client) this._buildJogRows(teach.jointNames);
        }
    }

    _buildJogRows(jointNames) {
        this._jogRows.innerHTML = '';
        jointNames.forEach((_, i) => {
            const row = el('div', 'display:flex;gap:6px;align-items:center;margin:3px 0;');
            row.append(el('span', 'width:30px;opacity:.8;', `J${i + 1}`));
            const minus = el('button', BTN + 'flex:1;', '−');
            const plus = el('button', BTN + 'flex:1;', '+');
            minus.addEventListener('pointerdown', (e) => { e.preventDefault(); this._jogStart(i, -1); });
            plus.addEventListener('pointerdown', (e) => { e.preventDefault(); this._jogStart(i, 1); });
            for (const b of [minus, plus]) {
                b.addEventListener('pointerup', () => this._jogStop());
                b.addEventListener('pointerleave', () => this._jogStop());
                b.addEventListener('pointercancel', () => this._jogStop());
            }
            row.append(minus, plus);
            this._jogRows.append(row);
        });
    }

    _jogStart(index, dir) {
        if (!this.client) return;
        this._jogStop();
        const v = dir * this._jogSpeed.get();
        const fire = () => this.client.jogJoint(index, v).then(() => this.setApi(true)).catch((e) => {
            this.setApi(false);
            this._ik.textContent = `jog failed: ${e.message}`;
            this._jogStop();
        });
        fire();
        this._jogTimer = setInterval(fire, 800); // re-send before the ~1 s jog timeout
    }

    _jogStop() {
        if (this._jogTimer) {
            clearInterval(this._jogTimer);
            this._jogTimer = null;
            this.client?.stopJogging?.().catch(() => {});
        }
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const title = el('div', 'font-weight:600;font-size:14px;color:#fff;margin-bottom:2px;', 'RobFlow Tools  ⠿');
        root.append(title);

        // --- Status ---
        root.append(sectionTitle('Status'));
        const conn = el('div', 'margin-bottom:4px;');
        this._wsDot = el('span', dot('#5b6b7a')); this._wsTxt = el('span', 'margin-right:12px;', 'WS —');
        this._apiDot = el('span', dot('#5b6b7a')); this._apiTxt = el('span', null, 'API —');
        conn.append(this._wsDot, this._wsTxt, this._apiDot, this._apiTxt);
        root.append(conn);
        this._robotLine = el('div'); this._modeLine = el('div'); this._safetyLine = el('div');
        root.append(this._robotLine, this._modeLine, this._safetyLine);
        this._renderStates();

        // --- Robot Config (pick + apply a virtual-robot preset) ---
        this._buildRobotConfig(root);

        // --- Teach ---
        root.append(sectionTitle('Teach Pendant'));
        const teachRow = el('div', 'display:flex;gap:6px;flex-wrap:wrap;');
        this._teachBtn = el('button', BTN, 'Teach: OFF');
        this._findBtn = el('button', BTN + 'display:none;', 'Find poses');
        // Move/Rotate handle toggles + space now live in the dedicated Gizmo panel (GizmoPanel.js).
        teachRow.append(this._teachBtn, this._findBtn);
        root.append(teachRow);
        this._ik = el('div', 'margin-top:6px;font-size:11px;color:#9da7b3;min-height:16px;');
        root.append(this._ik);
        // Alternate IK configurations for the current TCP (filled by Find poses).
        this._posesBox = el('div', 'margin-top:6px;display:none;');
        root.append(this._posesBox);

        this._teachBtn.addEventListener('click', () => this._toggleTeach());
        this._findBtn.addEventListener('click', () => this._findPoses());

        // --- Send (needs client) ---
        this._sendBox = el('div', 'margin-top:8px;');
        this._vel = slider('velocity', 0.01, 1, 0.01, 1);
        this._acc = slider('accel', 0.01, 1, 0.01, 1);
        const apprRow = el('div', 'display:flex;align-items:center;gap:8px;margin:4px 0;');
        apprRow.append(el('span', 'opacity:.8;width:64px;', 'approach'));
        // color-scheme:dark darkens the native option popup in Chromium; the per-option
        // background/colour covers Firefox, whose popup ignores the parent's translucent bg.
        this._appr = el('select', 'flex:1;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px;font:inherit;color-scheme:dark;');
        this._appr.innerHTML = '<option style="background:#0d1117;color:#e6edf3;" value="1">PTP</option><option style="background:#0d1117;color:#e6edf3;" value="2">Linear</option>';
        apprRow.append(this._appr);
        const sendRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        this._sendBtn = el('button', BTN + 'border-color:#2f81f7;flex:1;', 'Send to Robot');
        this._stopBtn = el('button', BTN + 'background:#5a1e1e;border-color:#f85149;', 'Stop');
        sendRow.append(this._sendBtn, this._stopBtn);
        this._sendBox.append(this._vel.row, this._acc.row, apprRow, sendRow);
        root.append(this._sendBox);
        this._sendBtn.addEventListener('click', () => this._send());
        this._stopBtn.addEventListener('click', () => this._control('stop'));

        // --- Control (needs client) ---
        this._ctrlBox = el('div');
        this._ctrlBox.append(sectionTitle('Control'));
        const ctrlRow = el('div', 'display:flex;gap:6px;');
        this._enableBtn = el('button', BTN + 'border-color:#3fb950;flex:1;', 'Enable (operational)');
        const ctrlStop = el('button', BTN + 'background:#5a1e1e;border-color:#f85149;', 'Stop');
        ctrlRow.append(this._enableBtn, ctrlStop);
        this._ctrlBox.append(ctrlRow);
        this._gspeed = slider('glob spd', 0, 1, 0.01, 1, () => {});
        this._gspeed.row.querySelector('input').addEventListener('change', (e) => this._setGlobalSpeed(+e.target.value));
        this._ctrlBox.append(this._gspeed.row);
        root.append(this._ctrlBox);
        this._enableBtn.addEventListener('click', () => this._control('enable'));
        ctrlStop.addEventListener('click', () => this._control('stop'));

        // (Waypoints → Flow moved to the dedicated Waypoints panel.)

        // --- Jog (needs client; press-and-hold per joint, requires JOGGING/TEACH mode) ---
        // Collapsed by default — click the section title to expand.
        this._jogBox = el('div');
        const jogTitle = sectionTitle('Jog (hold)  ▸');
        jogTitle.style.cursor = 'pointer';
        jogTitle.style.userSelect = 'none';
        this._jogContent = el('div', 'display:none;');
        jogTitle.addEventListener('click', () => {
            const show = this._jogContent.style.display === 'none';
            this._jogContent.style.display = show ? 'block' : 'none';
            jogTitle.textContent = show ? 'Jog (hold)  ▾' : 'Jog (hold)  ▸';
        });
        this._jogBox.append(jogTitle);
        this._jogSpeed = slider('speed', 0.01, 1, 0.01, 1);
        this._jogContent.append(this._jogSpeed.row);
        this._jogRows = el('div');
        this._jogContent.append(this._jogRows);
        this._jogBox.append(this._jogContent);
        root.append(this._jogBox);

        // Hide robot-only sections without a client.
        if (!this.client) {
            this._sendBox.style.display = 'none';
            this._ctrlBox.style.display = 'none';
            this._jogBox.style.display = 'none';
        }

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title, 'tools');
        this._teachVisible(false);
    }

    // --- status ---------------------------------------------------------
    setWs(connected) {
        this._wsDot.style.cssText = dot(connected ? SEVERITY_COLOR.ok : SEVERITY_COLOR.err);
        this._wsTxt.textContent = connected ? 'WS live' : 'WS down';
    }
    setApi(reachable) {
        this._apiDot.style.cssText = dot(reachable ? SEVERITY_COLOR.ok : SEVERITY_COLOR.err);
        this._apiTxt.textContent = reachable ? 'API ok' : 'API err';
    }
    setStates(patch) {
        Object.assign(this.states, patch);
        this._renderStates();
    }
    _stateLine(node, name, map, code) {
        const [text, sev] = label(map, code);
        node.innerHTML = `<span style="${dot(SEVERITY_COLOR[sev])}"></span>${name}: ${text}`;
    }
    _renderStates() {
        this._stateLine(this._robotLine, 'Robot', ROBOT_STATE, this.states.robotState);
        this._stateLine(this._modeLine, 'Mode', OPERATION_MODE, this.states.operationMode);
        this._stateLine(this._safetyLine, 'Safety', SAFETY_STATE, this.states.safetyState);
        const teachable = canTeach(this.states.operationMode, this.states.safetyState);
        if (this._sendBtn) {
            this._sendBtn.style.borderColor = teachable ? '#2f81f7' : '#d29922';
            this._sendBtn.title = teachable ? 'Send the previewed joint pose' : 'Robot not in TEACH mode';
        }
    }

    // --- robot config (preset picker) -----------------------------------
    // Indicator + dropdown + Apply. Connected → POST /virtual-robot/configure (via
    // app._robcoApplyModules); the live mirror then rebuilds the viewer. Offline → build locally.
    _buildRobotConfig(root) {
        root.append(sectionTitle('Robot Config'));
        this._rcPresets = [];
        this._rcConnected = false;
        this._rcLiveIds = null;
        this._rcSyncedKey = null;

        const line = el('div', 'margin-bottom:4px;');
        this._rcDot = el('span', dot('#5b6b7a'));
        this._rcTxt = el('span', null, 'loading catalog…');
        line.append(this._rcDot, this._rcTxt);
        root.append(line);

        const row = el('div', 'display:flex;gap:6px;align-items:center;margin-top:2px;');
        this._rcSelect = el('select',
            'flex:1;min-width:0;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:5px;padding:3px;font:inherit;color-scheme:dark;');
        this._rcSelect.append(el('option', 'background:#0d1117;color:#e6edf3;', '— robots —'));
        this._rcSelect.addEventListener('change', () => this._rcRenderDetail());
        this._rcApplyBtn = el('button', BTN + 'flex:0 0 auto;border-color:#2f81f7;', 'Load in viewer');
        this._rcApplyBtn.addEventListener('click', () => this._rcApply());
        row.append(this._rcSelect, this._rcApplyBtn);
        root.append(row);

        this._rcDetail = el('div', 'font-size:10px;color:#6e7681;margin-top:4px;min-height:12px;');
        root.append(this._rcDetail);

        this._rcLoadPresets();
    }

    async _rcLoadPresets() {
        this._rcStatus('loading robot catalog…');
        try {
            this._rcPresets = await loadPresets();
        } catch (e) {
            this._rcPresets = [];
            console.warn('[RobCo] preset catalog load failed:', e);
        }
        this._rcFillSelect();
        this._rcRender();
    }

    _rcFillSelect() {
        this._rcSelect.innerHTML = '';
        const opt = (t, v) => { const o = el('option', 'background:#0d1117;color:#e6edf3;', t); if (v != null) o.value = v; return o; };
        if (!this._rcPresets.length) { this._rcSelect.append(opt('— catalog unavailable —')); return; }
        this._rcSelect.append(opt('— pick a robot —'));
        this._rcPresets.forEach((p, i) => {
            const bits = [`${p.dof ?? '?'}-DoF`];
            if (p.reachM != null) bits.push(`${p.reachM.toFixed(2)} m`);
            if (p.payloadKg != null) bits.push(`${p.payloadKg} kg`);
            this._rcSelect.append(opt(`${p.englishName} — ${bits.join(' · ')}`, String(i)));
        });
    }

    /** Live state from liveConnect: whether a Studio session is connected + its module ids. */
    setRobotLive({ connected, ids } = {}) {
        if (connected !== undefined) this._rcConnected = !!connected;
        if (ids !== undefined) this._rcLiveIds = ids;
        this._rcRender();
    }

    _rcSelectedPreset() {
        const i = parseInt(this._rcSelect.value, 10);
        return Number.isInteger(i) ? this._rcPresets[i] : null;
    }

    _rcStatus(text, color = '#9da7b3') {
        if (this._rcTxt) { this._rcTxt.textContent = text; this._rcDot.style.cssText = dot(color); }
    }

    _rcRender() {
        const hasSession = !!this.app._robflowSocket;
        const matched = this._rcLiveIds ? matchPreset(this._rcLiveIds, this._rcPresets) : null;
        if (!hasSession) {
            this._rcStatus('Offline — Apply builds the robot locally');
        } else if (!this._rcLiveIds || !this._rcLiveIds.length) {
            this._rcStatus(this._rcConnected ? 'Studio — no robot reported yet' : 'Studio reconnecting…', '#d29922');
        } else if (matched) {
            const bits = [`${matched.dof}-DoF`];
            if (matched.reachM != null) bits.push(`${matched.reachM.toFixed(2)} m`);
            if (matched.payloadKg != null) bits.push(`${matched.payloadKg} kg`);
            this._rcStatus(`Studio: ${matched.englishName} · ${bits.join(' · ')}`, '#3fb950');
            // Reflect the applied config in the dropdown only when it actually changes.
            const key = matched.idsPadded.join(',');
            if (key !== this._rcSyncedKey) { this._rcSyncedKey = key; this._rcSelect.value = String(this._rcPresets.indexOf(matched)); }
        } else {
            this._rcStatus(`Studio: custom (${this._rcLiveIds.length} modules)`, '#d29922');
            this._rcSyncedKey = null;
        }
        this._rcApplyBtn.textContent = hasSession ? 'Apply to Studio' : 'Load in viewer';
        this._rcRenderDetail();
    }

    _rcRenderDetail() {
        const p = this._rcSelectedPreset();
        this._rcDetail.textContent = p ? p.buildOrder : '';
    }

    async _rcApply() {
        const p = this._rcSelectedPreset();
        if (!p) { this._rcStatus('pick a robot from the list first', '#d29922'); return; }

        if (this.app._robflowSocket) {
            if (!this.app._robcoApplyModules) { this._rcStatus('reconnect with your account token to apply', '#d29922'); return; }
            this._rcApplyBtn.disabled = true;
            this._rcStatus(`applying ${p.englishName} to Studio…`, '#2f81f7');
            try {
                // POST /public/virtual-robot/configure — Studio streams new robotModuleIds and the mirror rebuilds.
                await this.app._robcoApplyModules(p.idsRaw);
                this._rcStatus(`applied ${p.englishName} — Studio reconfiguring…`, '#3fb950');
            } catch (e) {
                const hint = /\b401\b/.test(e.message) ? ' (account token expired — reconnect)' : '';
                this._rcStatus(`apply failed: ${e.message}${hint}`, '#f85149');
            } finally {
                this._rcApplyBtn.disabled = false;
            }
            return;
        }

        // Offline: build the robot locally from the public module CDN.
        this._rcApplyBtn.disabled = true;
        this._rcStatus(`building ${p.englishName}…`, '#2f81f7');
        try {
            const { buildStaticRobco } = await import('./robcoBuild.js');
            await buildStaticRobco(this.app, { baseUrl: MODULES_CDN, moduleIds: p.idsPadded });
            this._rcStatus(`loaded ${p.englishName}`, '#3fb950');
        } catch (e) {
            this._rcStatus(`build failed: ${e.message}`, '#f85149');
            console.error('[RobCo] offline robot build failed:', e);
        } finally {
            this._rcApplyBtn.disabled = false;
        }
    }

    // --- teach ----------------------------------------------------------
    _teachVisible(on) {
        this._findBtn.style.display = on ? 'inline-block' : 'none';
        this._sendBox.style.display = on && this.client ? 'block' : 'none';
        this._ik.style.display = on ? 'block' : 'none';
        if (!on) this._clearPoses();
        this._teachBtn.textContent = `Teach: ${on ? 'ON' : 'OFF'}`;
        this._teachBtn.style.background = on ? '#238636' : 'rgba(255,255,255,0.06)';
    }
    _toggleTeach() {
        if (!this.teach) return;
        const on = !this.teach.enabled;
        this.teach.setEnabled(on);
        this._teachVisible(on);
    }
    _setIk(res) {
        this._ik.textContent = res.converged
            ? `IK ok · ${res.iters} it · ${(res.posErr * 1000).toFixed(1)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(1)}°`
            : `IK best-effort · ${(res.posErr * 1000).toFixed(0)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(0)}°`;
    }

    // --- find alternate configurations ----------------------------------
    /** Enumerate the joint configurations that reach the current TCP, then list them. */
    _findPoses() {
        if (!this.teach) return;
        this._findBtn.disabled = true;
        this._ik.textContent = 'finding poses…';
        // Defer one frame so the "finding…" label paints before the (synchronous-per-chunk) sweep.
        requestAnimationFrame(async () => {
            try {
                const list = await this.teach.findConfigurationsAsync(
                    this.teach.tcpBaseMatrix(), {},
                    (p) => { this._ik.textContent = `finding poses… ${Math.round(p * 100)}%`; },
                );
                this._renderPoses(list);
                const alts = list.filter((c) => !c.isCurrent).length;
                this._ik.textContent = alts
                    ? `${alts} alternate configuration(s)`
                    : 'no alternate configurations found';
            } catch (e) {
                this._ik.textContent = `find poses failed: ${e.message}`;
                console.error('[RobCo] find poses failed:', e);
            } finally {
                this._findBtn.disabled = false;
            }
        });
    }

    _renderPoses(list) {
        this._posesBox.innerHTML = '';
        this._posesBox.style.display = 'block';
        const redundant = this.teach?.jointNames?.length > 6;
        const head = el('div', 'font-size:10px;color:#6e7681;margin-bottom:3px;',
            redundant ? 'configurations (sampled — redundant arm)' : 'configurations (same TCP)');
        this._posesBox.append(head);
        if (!list.length) { this._posesBox.append(el('div', 'opacity:.6;font-size:11px;', 'none found')); return; }

        let n = 0;
        for (const cfg of list) {
            const row = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;padding:1px 3px;border-radius:5px;' +
                (cfg.isCurrent ? 'background:rgba(35,134,54,0.12);' : ''));
            const tight = cfg.minMarginDeg < 20;
            const color = cfg.isCurrent ? '#3fb950' : (tight ? '#d29922' : '#2f81f7');
            row.append(el('span', `display:inline-block;width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:${color};`));
            const label = cfg.isCurrent ? 'Current' : `Config ${++n}`;
            row.append(el('span', 'flex:1;min-width:0;', label));
            if (!cfg.isCurrent) row.append(el('span', 'opacity:.7;font-size:10px;', `Δ${Math.round(cfg.dist)}°`));
            const margin = el('span', `opacity:.7;font-size:10px;${tight ? 'color:#d29922;' : ''}`, `m${Math.round(cfg.minMarginDeg)}°`);
            margin.title = 'worst-axis margin to the ±270° limit';
            row.append(margin);
            const prev = el('button', BTN + 'padding:2px 7px;flex:0 0 auto;', 'Preview');
            prev.title = cfg.deg.map((d) => d.toFixed(1)).join(', ') + '°';
            prev.addEventListener('click', () => {
                this.teach.applyConfig(cfg.deg);
                this._markPreviewed(row);
                this._ik.textContent = `previewing ${label} — use Send / Capture to apply`;
            });
            row.append(prev);
            this._posesBox.append(row);
        }
    }

    _markPreviewed(activeRow) {
        for (const r of this._posesBox.querySelectorAll('[data-prev]')) r.removeAttribute('data-prev');
        activeRow.dataset.prev = '1';
        for (const r of this._posesBox.children) r.style.outline = '';
        activeRow.style.outline = '1px solid #2f81f7';
    }

    _clearPoses() {
        if (!this._posesBox) return;
        this._posesBox.innerHTML = '';
        this._posesBox.style.display = 'none';
    }

    // --- robot commands -------------------------------------------------
    async _send() {
        if (!this.client || !this.teach) return;
        const deg = this.teach.currentAnglesDeg();
        const v = this._vel.get(), a = this._acc.get(), appr = +this._appr.value;
        this._ik.textContent = 'sending move…';
        try {
            await this.client.moveJointAngles(deg, { velocity: v, acceleration: a, approachMode: appr });
            this.setApi(true);
            this._ik.textContent = 'move sent ✓';
        } catch (e) {
            this.setApi(false);
            this._ik.textContent = `send failed: ${e.message}`;
        }
    }
    async _control(kind) {
        if (!this.client) return;
        try {
            if (kind === 'enable') await this.client.setDesiredRobotState(2);
            else if (kind === 'stop') await this.client.stop();
            this.setApi(true);
            this._ik.textContent = `${kind} ✓`;
        } catch (e) {
            this.setApi(false);
            this._ik.textContent = `${kind} failed: ${e.message}`;
        }
    }
    async _setGlobalSpeed(v) {
        if (!this.client) return;
        try { await this.client.setGlobalSpeed(v); this.setApi(true); }
        catch (e) { this.setApi(false); this._ik.textContent = `speed failed: ${e.message}`; }
    }
    async _pingApi() {
        try { await this.client.getRobotConfig(); this.setApi(true); }
        catch { this.setApi(false); }
    }

    dispose() {
        this._jogStop();
        this.root?.remove();
    }
}
