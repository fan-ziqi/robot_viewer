/**
 * MaterialManager — import workpiece GLBs ("material") that can be gripped by the active
 * end-effector. Each material rests in the world (base-linked, like the world-origin marker) until
 * its "output" toggle is switched on, at which point it rigidly follows whichever tool is currently
 * active (EndEffector.attachPoint()) via THREE.Object3D.attach() — a reparent that preserves world
 * transform, so the pickup doesn't visually snap, and needs no per-frame code: the object simply
 * becomes part of the flange's scene-graph subtree.
 *
 * The "output" is a named boolean (default "Gripper") standing in for a RobFlow output that in a
 * real cell fires a pneumatic valve. There's no live per-output signal in this codebase yet
 * (liveConnect.js streams payload/tool/robotConfig, not discrete digital outputs), so today it's a
 * manual per-item checkbox — but `setOutput(name, active)` is the same entry point a future live
 * signal handler would call, so wiring the real thing later needs no UI rework.
 *
 * While gripped, a material's mass (if set) feeds the dynamics as the 'material' payload source
 * (DynamicsController.setPayloadSource), summed alongside 'tcp'/'gripper'/'robot' like a real pickup.
 */
import * as THREE from 'three';

const KEY = 'robco-materials';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const ICON_BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 8px;cursor:pointer;';
const NUM = 'width:64px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
const TEXT = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 6px;font:inherit;';
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
    return `mat${Date.now().toString(36)}${_idSeq}`;
}

/** Coerce a stored/partial config into a complete, valid material config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Material'),
        outputName: typeof s.outputName === 'string' && s.outputName ? s.outputName : 'Gripper',
        gripped: false, // never restore "gripped" as a saved state — always starts released
        mass: typeof s.mass === 'number' && s.mass >= 0 ? s.mass : 0,
        pos: Array.isArray(s.pos) && s.pos.length === 3 ? s.pos.map((v) => +v || 0) : [0, 0, 0],
        quat: Array.isArray(s.quat) && s.quat.length === 4 ? s.quat.map((v) => +v || 0) : [0, 0, 0, 1],
    };
}

export class MaterialManager {
    static ensure({ sm, model, teach, setupPanel, endEffector, base }) {
        if (window._robcoMaterialManager) {
            window._robcoMaterialManager.update({ sm, model, teach, setupPanel, endEffector, base });
            return window._robcoMaterialManager;
        }
        const mm = new MaterialManager({ sm, model, teach, setupPanel, endEffector, base });
        window._robcoMaterialManager = mm;
        return mm;
    }

    constructor({ sm, model, teach, setupPanel, endEffector, base }) {
        this.sm = sm;
        this.model = model;
        this.teach = teach;
        this.endEffector = endEffector;
        this.base = base;
        this.setupPanel = setupPanel;
        this.items = []; // { cfg, root, bytes, fileName }
        this.activeId = null;
        this._loadPersisted();
        if (setupPanel) setupPanel.addSection(this._buildSection());
    }

    update({ sm, model, teach, setupPanel, endEffector, base }) {
        const rebuilt = model && model !== this.model;
        if (sm) this.sm = sm;
        if (model) this.model = model;
        if (teach) this.teach = teach;
        if (endEffector) this.endEffector = endEffector;
        if (base) this.base = base;
        if (setupPanel && setupPanel !== this.setupPanel) {
            this.setupPanel = setupPanel;
            setupPanel.addSection(this._section || this._buildSection());
        }
        if (rebuilt) this._reattachGripped();
    }

    get active() { return this.items.find((it) => it.cfg.id === this.activeId) || null; }

    _flange() {
        const nodes = this.model?.userData?.moduleNodes || [];
        if (nodes.length) {
            const last = nodes[nodes.length - 1];
            return last.getDistalLink?.() || last.distal;
        }
        return this.model?.threeObject;
    }

    // A live-session model rebuild destroys the old flange/tool mounts; any gripped item needs a
    // fresh home. Rare edge case (holding a part while the robot config changes) — best effort,
    // not a smooth re-pickup.
    _reattachGripped() {
        const ap = this.endEffector?.attachPoint?.() || this._flange();
        if (!ap) return;
        for (const it of this.items) {
            if (it.cfg.gripped) { it.root.position.set(0, 0, 0); it.root.quaternion.identity(); ap.add(it.root); }
        }
        this._syncMassPayload();
    }

    // --- load / add / remove --------------------------------------------
    async addFromFile(file) {
        this._status.textContent = `loading ${file.name}…`;
        let bytes = null;
        try { bytes = await file.arrayBuffer(); } catch { bytes = null; }
        const url = URL.createObjectURL(file);
        try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
            const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));

            const persisted = (this._persistedCfgs && this._persistedCfgs.length) ? this._persistedCfgs.shift() : null;
            const cfg = sanitizeCfg(persisted, file.name.replace(/\.(glb|gltf)$/i, ''));

            const root = new THREE.Object3D();
            root.name = `robco-material-${cfg.id}`;
            root.position.fromArray(cfg.pos);
            root.quaternion.fromArray(cfg.quat);
            root.add(gltf.scene || gltf);
            if (this.base) this.base.attach(root);
            else this.sm.scene.add(root);

            const item = { cfg, root, bytes, fileName: file.name };
            this.items.push(item);
            this.activeId = cfg.id;
            this._persist();
            this._rebuildListUI();
            this._status.textContent = `material: ${file.name}`;
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] material load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    removeItem(id) {
        const idx = this.items.findIndex((it) => it.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel?._editing === 'material') this.setupPanel._stopEdit();
        const [it] = this.items.splice(idx, 1);
        if (it.cfg.gripped) window._robcoDynamics?.setPayloadSource?.('material', 0, [0, 0, 0]);
        it.root.parent?.remove(it.root);
        if (this.activeId === id) this.activeId = this.items[0]?.cfg.id || null;
        this._persist();
        this._rebuildListUI();
        this.sm.redraw?.();
    }

    // --- grip (the "output" toggle) --------------------------------------
    setGripped(item, on) {
        if (!item || on === item.cfg.gripped) return;
        if (on) {
            const ap = this.endEffector?.attachPoint?.() || this._flange();
            if (!ap) return; // nothing to attach to yet
            ap.attach(item.root);
        } else if (this.base) {
            this.base.worldGroup.attach(item.root);
        } else {
            this.sm.scene.attach(item.root);
        }
        item.cfg.gripped = on;
        this._syncMassPayload();
        this._persist();
        this._refresh();
        this.sm.redraw?.();
    }

    /** Drive the grip toggle by output name — the entry point a future live RobFlow signal reuses. */
    setOutput(outputName, active) {
        const name = (outputName || '').trim().toLowerCase();
        if (!name) return;
        for (const it of this.items) {
            if ((it.cfg.outputName || '').trim().toLowerCase() === name) this.setGripped(it, active);
        }
    }

    /** CoM ~= bounding-box centre of the gripped item, expressed in the attach point's local frame. */
    _recomputeMaterialCoM(item) {
        const ap = item.root.parent;
        if (!ap) return [0, 0, 0];
        ap.updateMatrixWorld(true);
        item.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(item.root);
        if (box.isEmpty()) return [0, 0, 0];
        const centerWorld = box.getCenter(new THREE.Vector3());
        return ap.worldToLocal(centerWorld.clone()).toArray();
    }

    // Only one gripper in this simulation: if more than one material is (unusually) marked
    // gripped, the most-recently-gripped one wins the mass feed rather than summing them.
    _syncMassPayload() {
        const gripped = this.items.filter((it) => it.cfg.gripped && it.cfg.mass > 0);
        if (!gripped.length) { window._robcoDynamics?.setPayloadSource?.('material', 0, [0, 0, 0]); return; }
        const it = gripped[gripped.length - 1];
        window._robcoDynamics?.setPayloadSource?.('material', it.cfg.mass, this._recomputeMaterialCoM(it));
    }

    // --- persistence ---------------------------------------------------
    _loadPersisted() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            this._persistedCfgs = (s && Array.isArray(s.items)) ? s.items : [];
        } catch { this._persistedCfgs = []; }
    }

    _persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({ items: this.items.map((it) => it.cfg) }));
        } catch { /* ignore */ }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', 'Material'));

        const listRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._sel = el('select', SELECT);
        this._sel.addEventListener('change', () => { this.activeId = this._sel.value; this._refresh(); });
        const fileInput = el('input');
        fileInput.type = 'file'; fileInput.accept = '.glb,.gltf'; fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.[0]) this.addFromFile(fileInput.files[0]);
            fileInput.value = '';
        });
        const addBtn = el('button', ICON_BTN, '＋');
        addBtn.title = 'Import a material GLB';
        addBtn.addEventListener('click', () => fileInput.click());
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this material';
        delBtn.addEventListener('click', () => { if (this.activeId) this.removeItem(this.activeId); });
        listRow.append(this._sel, addBtn, delBtn);
        wrap.append(listRow, fileInput);

        this._status = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no material imported');
        wrap.append(this._status);

        const body = el('div', 'display:none;');
        this._alignBtn = el('button', BTN, 'Align');
        this._alignBtn.addEventListener('click', () => {
            const it = this.active;
            if (!it || it.cfg.gripped) return;
            this.setupPanel?._edit('material', it.root, ['translate', 'rotate'], () => {
                it.cfg.pos = it.root.position.toArray();
                it.cfg.quat = it.root.quaternion.toArray();
                this._persist();
            });
        });
        body.append(this._alignBtn);

        const massRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        massRow.append(el('span', 'width:52px;opacity:.8;', 'mass kg'));
        this._massIn = el('input', NUM);
        this._massIn.type = 'number'; this._massIn.step = '0.1'; this._massIn.min = '0';
        this._massIn.addEventListener('change', () => {
            const it = this.active; if (!it) return;
            it.cfg.mass = Math.max(0, +this._massIn.value || 0);
            this._persist();
            if (it.cfg.gripped) this._syncMassPayload();
        });
        massRow.append(this._massIn);
        body.append(massRow);

        const outRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        outRow.append(el('span', 'width:52px;opacity:.8;', 'output'));
        this._outIn = el('input', TEXT);
        this._outIn.type = 'text';
        this._outIn.addEventListener('change', () => {
            const it = this.active; if (!it) return;
            it.cfg.outputName = this._outIn.value || 'Gripper';
            this._persist();
        });
        outRow.append(this._outIn);
        body.append(outRow);

        const gripRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        this._gripCb = el('input'); this._gripCb.type = 'checkbox'; this._gripCb.style.accentColor = '#2f81f7';
        this._gripCb.addEventListener('change', () => this.setGripped(this.active, this._gripCb.checked));
        gripRow.append(this._gripCb, el('span', 'opacity:.9;', 'Gripper output ON (simulated)'));
        body.append(gripRow);

        wrap.append(body);
        this._body = body;
        this._section = wrap;
        this._rebuildListUI();
        return wrap;
    }

    _rebuildListUI() {
        if (!this._sel) return;
        this._sel.innerHTML = '';
        if (!this.items.length) {
            this._sel.append(el('option', OPT, '— no materials —'));
            this._status.textContent = 'no material imported';
            this._body.style.display = 'none';
            return;
        }
        for (const it of this.items) {
            const o = el('option', OPT, it.cfg.name);
            o.value = it.cfg.id;
            this._sel.append(o);
        }
        this._sel.value = this.activeId;
        this._refresh();
    }

    _refresh() {
        const it = this.active;
        if (!it) { this._body.style.display = 'none'; return; }
        this._body.style.display = 'block';
        this._status.textContent = `material: ${it.fileName}`;
        this._massIn.value = String(it.cfg.mass || 0);
        this._outIn.value = it.cfg.outputName || 'Gripper';
        this._gripCb.checked = it.cfg.gripped;
        this._alignBtn.disabled = it.cfg.gripped;
        this._alignBtn.style.opacity = it.cfg.gripped ? '0.4' : '1';
        this._alignBtn.title = it.cfg.gripped ? 'Release the gripper output first' : '';
    }
}
