/**
 * EndEffector — import a tool GLB, attach it at the flange, set its mass, and feed an
 * approximate CoM into the dynamics. The tool is wrapped in a correction "mount" Object3D so a
 * mis-exported frame can be realigned (gizmo or numeric). Optionally the tool tip becomes the
 * TCP (an editable flange→tip offset routed into the TeachPendant).
 *
 * v1: visual + mass + CoM (bounding-box-center approximation, flange-local). The CoM is "good
 * enough, not accurate" per the brief. Mass + CoM are pushed to the dynamics as the 'gripper'
 * payload source (DynamicsController.setPayloadSource) so they're summed with any manual TCP load
 * rather than overwriting it, and drawn as their own marker sphere. Builds its UI as a section of
 * the Setup panel.
 */
import * as THREE from 'three';

const KEY = 'robco-endeffector';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'width:46px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
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
        this.mount = null;
        this.glb = null;
        this.mass = 0;
        this.tcpOffsetMm = [0, 0, 0];
        this.toolTipIsTcp = false;
        this._cfg = this._loadCfg();
        if (setupPanel) setupPanel.addSection(this._buildSection());
    }

    update({ sm, model, teach, setupPanel }) {
        if (sm) this.sm = sm;
        const modelChanged = model && model !== this.model;
        if (model) this.model = model;
        if (teach) this.teach = teach;
        if (setupPanel && setupPanel !== this.setupPanel) {
            this.setupPanel = setupPanel;
            setupPanel.addSection(this._section || this._buildSection());
        }
        // A live rebuild swaps in a fresh model with brand-new scene nodes; the loaded tool is
        // still parented to the OLD flange (now off-scene), so move it onto the new flange or it
        // silently vanishes from both the viewport and the Blender export.
        if (modelChanged) this.reattach();
    }

    /**
     * Re-parent the loaded tool onto the current model's flange. Idempotent and safe to call with
     * no tool loaded. Uses add() (not attach()) so the flange-local correction transform is kept.
     */
    reattach() {
        if (!this.mount) return;
        const flange = this._flange();
        if (!flange || this.mount.parent === flange) return;
        flange.add(this.mount);
        this._recomputeCoM();
        this._applyToolTip();
        this.sm?.redraw?.();
    }

    _flange() {
        const nodes = this.model?.userData?.moduleNodes || [];
        if (nodes.length) {
            const last = nodes[nodes.length - 1];
            return last.getDistalLink?.() || last.distal;
        }
        return this.model?.threeObject;
    }

    // --- load / transform ----------------------------------------------
    async load(file) {
        this._status.textContent = `loading ${file.name}…`;
        // Read the raw GLB bytes up-front so a session save can embed the tool (user-supplied —
        // no URL to re-fetch on restore). Assigned only AFTER remove() below, which nulls them.
        let bytes = null;
        try { bytes = await file.arrayBuffer(); } catch { bytes = null; }
        const url = URL.createObjectURL(file);
        try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
            const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
            this.remove();
            const flange = this._flange();
            if (!flange) { this._status.textContent = 'no flange to attach to'; return; }
            this.mount = new THREE.Object3D();
            this.mount.name = 'robco-ee-mount';
            this.glb = gltf.scene || gltf;
            this.mount.add(this.glb);
            flange.add(this.mount);
            this._fileBytes = bytes; // set AFTER remove() above so the bytes survive the save
            this._fileName = file.name;
            this._applyCfg();
            this._refresh();
            this._body.style.display = 'block';
            this._status.textContent = `tool: ${file.name}`;
            this._recomputeCoM();
            this._applyToolTip();
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] end-effector load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    remove() {
        if (this.toolTipIsTcp) this.teach?.setToolOffset?.(null);
        if (this.mount) { this.mount.parent?.remove(this.mount); this.mount = null; this.glb = null; }
        this._fileBytes = null; this._fileName = null;
        window._robcoDynamics?.setPayloadSource?.('gripper', 0, [0, 0, 0]);
        if (this._body) this._body.style.display = 'none';
        if (this._status) this._status.textContent = 'no tool loaded';
        this.sm.redraw?.();
    }

    /** CoM ≈ bounding-box centre of the tool, expressed in the flange-local frame (metres). */
    _recomputeCoM() {
        if (!this.mount || !this.glb) return;
        const flange = this._flange();
        flange.updateMatrixWorld(true);
        this.glb.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.glb);
        if (box.isEmpty()) {
            // No measurable geometry (e.g. an empty/points-only GLB): still apply the mass, at the
            // flange origin, so a set mass isn't silently dropped.
            this._com = [0, 0, 0];
        } else {
            const centerWorld = box.getCenter(new THREE.Vector3());
            const com = flange.worldToLocal(centerWorld.clone()); // flange-local metres
            this._com = com.toArray();
        }
        window._robcoDynamics?.setPayloadSource?.('gripper', this.mass, this._com);
        if (this._comOut) this._comOut.textContent = `CoM ≈ [${this._com.map((v) => (v * 1000).toFixed(0)).join(', ')}] mm`;
    }

    _applyToolTip() {
        if (!this.teach) return;
        if (this.toolTipIsTcp) {
            const t = this.tcpOffsetMm.map((v) => v / 1000);
            this.teach.setToolOffset(new THREE.Matrix4().makeTranslation(t[0], t[1], t[2]));
        } else {
            this.teach.setToolOffset(null);
        }
    }

    // --- persistence ---------------------------------------------------
    _loadCfg() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
    }

    _persist() {
        try {
            const c = {
                correction: this.mount
                    ? { pos: this.mount.position.toArray(), euler: [this.mount.rotation.x, this.mount.rotation.y, this.mount.rotation.z] }
                    : null,
                mass: this.mass, tcpOffsetMm: this.tcpOffsetMm, toolTipIsTcp: this.toolTipIsTcp,
            };
            localStorage.setItem(KEY, JSON.stringify(c));
        } catch { /* ignore */ }
    }

    _applyCfg() {
        const c = this._cfg || {};
        this.mass = c.mass || 0;
        this.tcpOffsetMm = Array.isArray(c.tcpOffsetMm) ? c.tcpOffsetMm : [0, 0, 0];
        this.toolTipIsTcp = !!c.toolTipIsTcp;
        if (c.correction && this.mount) {
            this.mount.position.fromArray(c.correction.pos || [0, 0, 0]);
            this.mount.rotation.set(...(c.correction.euler || [0, 0, 0]));
        }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', 'End-Effector'));
        this._status = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no tool loaded');
        wrap.append(this._status);

        const fileInput = el('input');
        fileInput.type = 'file'; fileInput.accept = '.glb,.gltf'; fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) this.load(fileInput.files[0]); });
        wrap.append(fileInput);
        const row1 = el('div', 'display:flex;gap:6px;');
        const loadBtn = el('button', BTN, 'Import GLB…');
        loadBtn.addEventListener('click', () => fileInput.click());
        const alignBtn = el('button', BTN, 'Align');
        alignBtn.addEventListener('click', () => {
            if (!this.mount) return;
            this.setupPanel?._edit('endeffector', this.mount, ['translate', 'rotate'], () => {
                this._refresh(); this._persist(); this._recomputeCoM();
            });
        });
        row1.append(loadBtn, alignBtn);
        wrap.append(row1);

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
        yz.addEventListener('click', () => { this.mount?.rotateX(Math.PI / 2); this._refresh(); this._persist(); this._recomputeCoM(); this.sm.redraw?.(); });
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => { if (this.mount) { this.mount.position.set(0, 0, 0); this.mount.rotation.set(0, 0, 0); } this._refresh(); this._persist(); this._recomputeCoM(); this.sm.redraw?.(); });
        const removeBtn = el('button', BTN, 'Remove');
        removeBtn.addEventListener('click', () => { this.remove(); this._persist(); });
        const r2 = el('div', 'display:flex;gap:6px;margin:4px 0;');
        r2.append(yz, resetBtn, removeBtn);
        body.append(r2);

        // mass
        const massRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        massRow.append(el('span', 'width:46px;opacity:.8;', 'mass kg'));
        this._massIn = el('input', NUM.replace('width:46px', 'width:64px'));
        this._massIn.type = 'number'; this._massIn.step = '0.1'; this._massIn.min = '0'; this._massIn.value = String(this.mass || 0);
        this._massIn.addEventListener('change', () => { this.mass = Math.max(0, +this._massIn.value || 0); this._persist(); this._recomputeCoM(); });
        massRow.append(this._massIn);
        body.append(massRow);
        this._comOut = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', 'CoM ≈ —');
        body.append(this._comOut);

        // tool tip = TCP option
        const tipRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        const tipCb = el('input'); tipCb.type = 'checkbox'; tipCb.checked = this.toolTipIsTcp; tipCb.style.accentColor = '#2f81f7';
        tipCb.addEventListener('change', () => { this.toolTipIsTcp = tipCb.checked; this._applyToolTip(); this._persist(); });
        tipRow.append(tipCb, el('span', 'opacity:.9;', 'Tool tip = TCP'));
        body.append(tipRow);
        const tipTriple = el('div', 'display:flex;align-items:center;gap:4px;margin:2px 0;');
        tipTriple.append(el('span', 'width:46px;opacity:.8;', 'tip mm'));
        ['tx', 'ty', 'tz'].forEach((k, i) => {
            const inp = el('input', NUM);
            inp.type = 'number'; inp.step = '5'; inp.value = String(this.tcpOffsetMm[i] || 0);
            inp.addEventListener('change', () => {
                this.tcpOffsetMm = ['tx', 'ty', 'tz'].map((kk) => +this._fields[kk].value || 0);
                this._applyToolTip(); this._persist();
            });
            this._fields[k] = inp; tipTriple.append(inp);
        });
        body.append(tipTriple);

        wrap.append(body);
        this._body = body;
        this._section = wrap;
        return wrap;
    }

    _applyNumeric() {
        if (!this.mount) return;
        const f = this._fields;
        this.mount.position.set(+f.px.value || 0, +f.py.value || 0, +f.pz.value || 0);
        this.mount.rotation.set((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R);
        this._persist();
        this._recomputeCoM();
        this.sm.redraw?.();
    }

    _refresh() {
        if (!this.mount) return;
        const f = this._fields;
        const p = this.mount.position;
        const r = (v) => Math.round(v * 1000) / 1000;
        if (f.px) { f.px.value = r(p.x); f.py.value = r(p.y); f.pz.value = r(p.z); }
        if (f.rx) { f.rx.value = Math.round(this.mount.rotation.x * R2D); f.ry.value = Math.round(this.mount.rotation.y * R2D); f.rz.value = Math.round(this.mount.rotation.z * R2D); }
        if (this._massIn) this._massIn.value = String(this.mass || 0);
        if (f.tx) { f.tx.value = this.tcpOffsetMm[0] || 0; f.ty.value = this.tcpOffsetMm[1] || 0; f.tz.value = this.tcpOffsetMm[2] || 0; }
    }
}
