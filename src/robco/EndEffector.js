/**
 * EndEffector — import one or more tool GLBs, mount them at the flange, and swap which one is
 * active (only the active tool is visible/mounted-live; the rest sit hidden). Each tool has its
 * own correction transform (a mis-exported frame can be realigned via gizmo or numeric), mass,
 * and CoM (bounding-box-center approximation, flange-local). Optionally the active tool's tip
 * becomes the TCP (an editable flange->tip offset routed into the TeachPendant).
 *
 * Only the active tool's mass + CoM are pushed to the dynamics as the 'gripper' payload source
 * (DynamicsController.setPayloadSource) so they're summed with any manual TCP load rather than
 * overwriting it. Builds its UI (a tool picker + shared edit fields for "the active tool", mirroring
 * CameraView's rig picker) as a section of the Setup panel.
 *
 * `attachPoint()` exposes the active tool's mount (or the bare flange if no tool is mounted) so
 * MaterialManager can rigidly follow whichever tool is currently active.
 */
import * as THREE from 'three';

const KEY = 'robco-endeffectors';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const ICON_BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 8px;cursor:pointer;';
const NUM = 'width:46px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
const SELECT = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:5px;padding:3px;font:inherit;color-scheme:dark;';
const OPT = 'background:#0d1117;color:#e6edf3;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

let _idSeq = 0;
function newId() {
    _idSeq += 1;
    return `ee${Date.now().toString(36)}${_idSeq}`;
}

/** Coerce a stored/partial config into a complete, valid tool config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    const corr = (s.correction && typeof s.correction === 'object') ? s.correction : {};
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Tool'),
        mass: typeof s.mass === 'number' && s.mass >= 0 ? s.mass : 0,
        tcpOffsetMm: Array.isArray(s.tcpOffsetMm) && s.tcpOffsetMm.length === 3
            ? s.tcpOffsetMm.map((v) => +v || 0) : [0, 0, 0],
        toolTipIsTcp: !!s.toolTipIsTcp,
        correction: {
            pos: Array.isArray(corr.pos) && corr.pos.length === 3 ? corr.pos.map((v) => +v || 0) : [0, 0, 0],
            euler: Array.isArray(corr.euler) && corr.euler.length === 3 ? corr.euler.map((v) => +v || 0) : [0, 0, 0],
        },
    };
}

export class EndEffector {
    static ensure({ sm, model, teach, setupPanel }) {
        if (window._robcoEndEffector) {
            window._robcoEndEffector.update({ sm, model, teach, setupPanel });
            return window._robcoEndEffector;
        }
        const ee = new EndEffector({ sm, model, teach, setupPanel });
        window._robcoEndEffector = ee;
        return ee;
    }

    constructor({ sm, model, teach, setupPanel }) {
        this.sm = sm;
        this.model = model;
        this.teach = teach;
        this.setupPanel = setupPanel;
        this.tools = []; // { cfg, mount, glb, bytes, fileName, com }
        this.activeId = null;
        this._loadPersisted();
        if (setupPanel) setupPanel.addSection(this._buildSection());
    }

    update({ sm, model, teach, setupPanel }) {
        const flangeChanged = model && model !== this.model;
        if (sm) this.sm = sm;
        if (model) this.model = model;
        if (teach) this.teach = teach;
        if (setupPanel && setupPanel !== this.setupPanel) {
            this.setupPanel = setupPanel;
            setupPanel.addSection(this._section || this._buildSection());
        }
        if (flangeChanged) this._reparentAll();
    }

    get active() { return this.tools.find((t) => t.cfg.id === this.activeId) || null; }

    /** Attach point for anything that should ride the currently active tool (e.g. gripped material). */
    attachPoint() {
        return this.active?.mount || this._flange();
    }

    _flange() {
        const nodes = this.model?.userData?.moduleNodes || [];
        if (nodes.length) {
            const last = nodes[nodes.length - 1];
            return last.getDistalLink?.() || last.distal;
        }
        return this.model?.threeObject;
    }

    /** Re-parent every tool's mount onto the (new) flange after a live-session model rebuild. */
    _reparentAll() {
        const flange = this._flange();
        if (!flange) return;
        for (const t of this.tools) {
            flange.add(t.mount);
            t.mount.visible = t.cfg.id === this.activeId;
        }
        this._applyToolTip();
        this._recomputeCoM();
    }

    /**
     * Public hook (BlenderExport calls this right before exporting): re-assert every tool's
     * attachment to the current flange in case a rebuild raced the panel wiring, so the active
     * tool is guaranteed to sit inside the exported subtree (only it is visible → only it exports).
     */
    reattach() {
        this._reparentAll();
    }

    // --- load / add / remove --------------------------------------------
    async addFromFile(file) {
        this._status.textContent = `loading ${file.name}…`;
        // Read the raw GLB bytes up-front so a session save can embed the tool (user-supplied —
        // no URL to re-fetch on restore).
        let bytes = null;
        try { bytes = await file.arrayBuffer(); } catch { bytes = null; }
        const url = URL.createObjectURL(file);
        try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
            const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
            const flange = this._flange();
            if (!flange) { this._status.textContent = 'no flange to attach to'; return; }

            // Consume the next unconsumed persisted config (session-restore order matches save order).
            const persisted = (this._persistedCfgs && this._persistedCfgs.length) ? this._persistedCfgs.shift() : null;
            const cfg = sanitizeCfg(persisted, file.name.replace(/\.(glb|gltf)$/i, ''));

            const mount = new THREE.Object3D();
            mount.name = `robco-ee-mount-${cfg.id}`;
            mount.position.fromArray(cfg.correction.pos);
            mount.rotation.set(...cfg.correction.euler);
            const glb = gltf.scene || gltf;
            mount.add(glb);
            flange.add(mount);
            mount.visible = false;

            const tool = { cfg, mount, glb, bytes, fileName: file.name };
            this.tools.push(tool);

            const shouldActivate = this._persistedActiveId ? cfg.id === this._persistedActiveId : true;
            if (shouldActivate || !this.activeId) this._activate(cfg.id);
            else { this._persist(); this._rebuildToolsUI(); }

            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] end-effector load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    _activate(id) {
        if (!this.tools.some((t) => t.cfg.id === id)) return;
        if (this.setupPanel?._editing === 'endeffector') this.setupPanel._stopEdit();
        this.activeId = id;
        for (const t of this.tools) t.mount.visible = t.cfg.id === id;
        this._applyToolTip();
        this._recomputeCoM();
        this._persist();
        this._rebuildToolsUI();
        this.sm.redraw?.();
    }

    removeTool(id) {
        const idx = this.tools.findIndex((t) => t.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel?._editing === 'endeffector') this.setupPanel._stopEdit();
        const [t] = this.tools.splice(idx, 1);
        t.mount.parent?.remove(t.mount);
        if (this.activeId === id) {
            const next = this.tools[0] || null;
            this.activeId = next ? next.cfg.id : null;
            if (next) next.mount.visible = true;
        }
        this._applyToolTip();
        this._recomputeCoM();
        this._persist();
        this._rebuildToolsUI();
        this.sm.redraw?.();
    }

    /** CoM ~= bounding-box centre of the active tool, expressed in the flange-local frame (metres). */
    _recomputeCoM() {
        const t = this.active;
        if (!t) {
            window._robcoDynamics?.setPayloadSource?.('gripper', 0, [0, 0, 0]);
            if (this._comOut) this._comOut.textContent = 'CoM ≈ —';
            return;
        }
        const flange = this._flange();
        flange.updateMatrixWorld(true);
        t.glb.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(t.glb);
        let com;
        if (box.isEmpty()) {
            // No measurable geometry (e.g. an empty/points-only GLB): still apply the mass, at the
            // flange origin, so a set mass isn't silently dropped.
            com = [0, 0, 0];
        } else {
            const centerWorld = box.getCenter(new THREE.Vector3());
            com = flange.worldToLocal(centerWorld.clone()).toArray(); // flange-local metres
        }
        t.com = com;
        window._robcoDynamics?.setPayloadSource?.('gripper', t.cfg.mass, com);
        if (this._comOut) this._comOut.textContent = `CoM ≈ [${com.map((v) => (v * 1000).toFixed(0)).join(', ')}] mm`;
    }

    _applyToolTip() {
        if (!this.teach) return;
        const t = this.active;
        if (t && t.cfg.toolTipIsTcp) {
            const off = t.cfg.tcpOffsetMm.map((v) => v / 1000);
            this.teach.setToolOffset(new THREE.Matrix4().makeTranslation(off[0], off[1], off[2]));
        } else {
            this.teach.setToolOffset(null);
        }
    }

    // --- persistence ---------------------------------------------------
    _loadPersisted() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            this._persistedCfgs = (s && Array.isArray(s.tools)) ? s.tools : [];
            this._persistedActiveId = s?.activeId ?? null;
        } catch { this._persistedCfgs = []; this._persistedActiveId = null; }
    }

    _persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                activeId: this.activeId,
                tools: this.tools.map((t) => t.cfg),
            }));
        } catch { /* ignore */ }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', 'End-Effector'));

        const listRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._sel = el('select', SELECT);
        this._sel.addEventListener('change', () => this._activate(this._sel.value));
        const fileInput = el('input');
        fileInput.type = 'file'; fileInput.accept = '.glb,.gltf'; fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.[0]) this.addFromFile(fileInput.files[0]);
            fileInput.value = '';
        });
        const addBtn = el('button', ICON_BTN, '＋');
        addBtn.title = 'Import a tool GLB';
        addBtn.addEventListener('click', () => fileInput.click());
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this tool';
        delBtn.addEventListener('click', () => { if (this.activeId) this.removeTool(this.activeId); });
        listRow.append(this._sel, addBtn, delBtn);
        wrap.append(listRow, fileInput);

        this._status = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no tools imported');
        wrap.append(this._status);

        const alignBtn = el('button', BTN, 'Align');
        alignBtn.addEventListener('click', () => {
            const t = this.active;
            if (!t) return;
            this.setupPanel?._edit('endeffector', t.mount, ['translate', 'rotate'], () => {
                this._refresh(); this._persist(); this._recomputeCoM();
            });
        });
        wrap.append(alignBtn);

        const body = el('div', 'display:none;');
        this._fields = {};
        const triple = (label, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:46px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applyNumeric());
                this._fields[k] = inp; row.append(inp);
            });
            return row;
        };
        body.append(el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', 'correction (realign export)'));
        body.append(triple('pos m', ['px', 'py', 'pz'], 0.01));
        body.append(triple('rot °', ['rx', 'ry', 'rz'], 15));

        const yz = el('button', BTN, 'Y-up→Z-up');
        yz.addEventListener('click', () => {
            const t = this.active; if (!t) return;
            t.mount.rotateX(Math.PI / 2);
            t.cfg.correction = { pos: t.mount.position.toArray(), euler: [t.mount.rotation.x, t.mount.rotation.y, t.mount.rotation.z] };
            this._refresh(); this._persist(); this._recomputeCoM(); this.sm.redraw?.();
        });
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => {
            const t = this.active; if (!t) return;
            t.mount.position.set(0, 0, 0); t.mount.rotation.set(0, 0, 0);
            t.cfg.correction = { pos: [0, 0, 0], euler: [0, 0, 0] };
            this._refresh(); this._persist(); this._recomputeCoM(); this.sm.redraw?.();
        });
        const r2 = el('div', 'display:flex;gap:6px;margin:4px 0;');
        r2.append(yz, resetBtn);
        body.append(r2);

        // mass
        const massRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        massRow.append(el('span', 'width:46px;opacity:.8;', 'mass kg'));
        this._massIn = el('input', NUM.replace('width:46px', 'width:64px'));
        this._massIn.type = 'number'; this._massIn.step = '0.1'; this._massIn.min = '0';
        this._massIn.addEventListener('change', () => {
            const t = this.active; if (!t) return;
            t.cfg.mass = Math.max(0, +this._massIn.value || 0);
            this._persist();
            this._recomputeCoM();
        });
        massRow.append(this._massIn);
        body.append(massRow);
        this._comOut = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', 'CoM ≈ —');
        body.append(this._comOut);

        // tool tip = TCP option
        const tipRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        this._tipCb = el('input'); this._tipCb.type = 'checkbox'; this._tipCb.style.accentColor = '#2f81f7';
        this._tipCb.addEventListener('change', () => {
            const t = this.active; if (!t) return;
            t.cfg.toolTipIsTcp = this._tipCb.checked;
            this._applyToolTip(); this._persist();
        });
        tipRow.append(this._tipCb, el('span', 'opacity:.9;', 'Tool tip = TCP'));
        body.append(tipRow);
        const tipTriple = el('div', 'display:flex;align-items:center;gap:4px;margin:2px 0;');
        tipTriple.append(el('span', 'width:46px;opacity:.8;', 'tip mm'));
        ['tx', 'ty', 'tz'].forEach((k) => {
            const inp = el('input', NUM);
            inp.type = 'number'; inp.step = '5';
            inp.addEventListener('change', () => {
                const t = this.active; if (!t) return;
                t.cfg.tcpOffsetMm = ['tx', 'ty', 'tz'].map((kk) => +this._fields[kk].value || 0);
                this._applyToolTip(); this._persist();
            });
            this._fields[k] = inp; tipTriple.append(inp);
        });
        body.append(tipTriple);

        wrap.append(body);
        this._body = body;
        this._section = wrap;
        this._rebuildToolsUI();
        return wrap;
    }

    _applyNumeric() {
        const t = this.active; if (!t) return;
        const f = this._fields;
        t.mount.position.set(+f.px.value || 0, +f.py.value || 0, +f.pz.value || 0);
        t.mount.rotation.set((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R);
        t.cfg.correction = { pos: t.mount.position.toArray(), euler: [t.mount.rotation.x, t.mount.rotation.y, t.mount.rotation.z] };
        this._persist();
        this._recomputeCoM();
        this.sm.redraw?.();
    }

    _rebuildToolsUI() {
        if (!this._sel) return;
        this._sel.innerHTML = '';
        if (!this.tools.length) {
            this._sel.append(el('option', OPT, '— no tools —'));
            this._status.textContent = 'no tools imported';
            this._body.style.display = 'none';
            return;
        }
        for (const t of this.tools) {
            const o = el('option', OPT, t.cfg.name);
            o.value = t.cfg.id;
            this._sel.append(o);
        }
        this._sel.value = this.activeId;
        this._refresh();
    }

    _refresh() {
        const t = this.active;
        if (!t) { this._body.style.display = 'none'; return; }
        this._body.style.display = 'block';
        this._status.textContent = `tool: ${t.fileName}`;
        const f = this._fields;
        const p = t.mount.position;
        const r = (v) => Math.round(v * 1000) / 1000;
        f.px.value = r(p.x); f.py.value = r(p.y); f.pz.value = r(p.z);
        f.rx.value = Math.round(t.mount.rotation.x * R2D); f.ry.value = Math.round(t.mount.rotation.y * R2D); f.rz.value = Math.round(t.mount.rotation.z * R2D);
        this._massIn.value = String(t.cfg.mass || 0);
        f.tx.value = t.cfg.tcpOffsetMm[0] || 0; f.ty.value = t.cfg.tcpOffsetMm[1] || 0; f.tz.value = t.cfg.tcpOffsetMm[2] || 0;
        this._tipCb.checked = t.cfg.toolTipIsTcp;
    }
}
