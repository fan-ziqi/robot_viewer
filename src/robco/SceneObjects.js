/**
 * SceneObjects — import one or more background/prop GLBs into the cell. Unlike the End-Effector
 * (only one visible at a time), every scene object can be visible simultaneously; each has its own
 * position/rotation/scale (gizmo or numeric), a hide toggle, a transparency slider, and a
 * "link to base" toggle: linked objects live in BaseFrame.worldGroup (they move when you reposition
 * the base — the Setup panel's Base section moves the whole cell against a fixed robot), unlinked
 * ones live directly in the scene's world group and stay put regardless of base placement.
 *
 * Builds its UI (an object picker + shared edit fields for "the active object", mirroring
 * CameraView's rig picker / EndEffector's tool picker) as a section of the Setup panel.
 */
import * as THREE from 'three';

const KEY = 'robco-scene-objects';
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
    return `so${Date.now().toString(36)}${_idSeq}`;
}

/** Coerce a stored/partial config into a complete, valid scene-object config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Scene object'),
        visible: s.visible !== false,
        opacity: (typeof s.opacity === 'number' && s.opacity >= 0 && s.opacity <= 1) ? s.opacity : 1,
        linkToBase: s.linkToBase !== false,
        pos: Array.isArray(s.pos) && s.pos.length === 3 ? s.pos.map((v) => +v || 0) : [0, 0, 0],
        euler: Array.isArray(s.euler) && s.euler.length === 3 ? s.euler.map((v) => +v || 0) : [0, 0, 0],
        scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1,
    };
}

/** SetupPanel owns the shared gizmo + Base section; this class is constructed by it directly. */
export class SceneObjects {
    constructor(setupPanel) {
        this.setupPanel = setupPanel;
        this.sm = setupPanel.sm;
        this.base = setupPanel.base;
        this.items = []; // { cfg, root, bytes, fileName }
        this.activeId = null;
        this._loadPersisted();
        this.section = this._buildSection();
    }

    get active() { return this.items.find((it) => it.cfg.id === this.activeId) || null; }

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
            root.name = `robco-scene-object-${cfg.id}`;
            root.position.fromArray(cfg.pos);
            root.rotation.set(...cfg.euler);
            root.scale.setScalar(cfg.scale);
            root.visible = cfg.visible;
            root.add(gltf.scene || gltf);
            if (cfg.linkToBase) this.base.attach(root);
            else (this.sm.world || this.sm.scene).add(root);

            const item = { cfg, root, bytes, fileName: file.name };
            this.items.push(item);
            this.activeId = cfg.id;
            if (cfg.opacity < 1) this._applyOpacity(item);
            this._persist();
            this._rebuildListUI();
            this._status.textContent = `object: ${file.name}`;
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] scene object load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    removeItem(id) {
        const idx = this.items.findIndex((it) => it.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel._editing === 'scene') this.setupPanel._stopEdit();
        const [it] = this.items.splice(idx, 1);
        it.root.parent?.remove(it.root);
        if (this.activeId === id) this.activeId = this.items[0]?.cfg.id || null;
        this._persist();
        this._rebuildListUI();
        this.sm.redraw?.();
    }

    // --- per-item behavior -----------------------------------------------
    setLinkToBase(item, linked) {
        if (!item || linked === item.cfg.linkToBase) return;
        const dest = linked ? this.base.worldGroup : (this.sm.world || this.sm.scene);
        dest.attach(item.root); // preserves current world pose across the reparent
        item.cfg.linkToBase = linked;
        item.cfg.pos = item.root.position.toArray();
        item.cfg.euler = [item.root.rotation.x, item.root.rotation.y, item.root.rotation.z];
        this._persist();
        this.sm.redraw?.();
    }

    _ensureUniqueMaterial(mesh) {
        if (mesh.userData.__matCloned) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
        mesh.userData.__matCloned = true;
    }

    _applyOpacity(item) {
        const v = Math.max(0, Math.min(1, item.cfg.opacity));
        item.root.traverse((o) => {
            if (!o.isMesh) return;
            this._ensureUniqueMaterial(o);
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) { m.transparent = true; m.opacity = v; }
        });
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
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', 'Scene Objects'));

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
        addBtn.title = 'Import a scene object GLB';
        addBtn.addEventListener('click', () => fileInput.click());
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this object';
        delBtn.addEventListener('click', () => { if (this.activeId) this.removeItem(this.activeId); });
        listRow.append(this._sel, addBtn, delBtn);
        wrap.append(listRow, fileInput);

        this._status = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no objects loaded');
        wrap.append(this._status);

        const body = el('div', 'display:none;');

        const row1 = el('div', 'display:flex;gap:6px;');
        this._alignBtn = el('button', BTN, 'Align');
        this._alignBtn.addEventListener('click', () => {
            const it = this.active;
            if (!it) return;
            this.setupPanel._edit('scene', it.root, ['translate', 'rotate', 'scale'], () => this._onGizmo());
        });
        row1.append(this._alignBtn);
        body.append(row1);

        this._fields = {};
        const triple = (label, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:34px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applyNumeric());
                this._fields[k] = inp;
                row.append(inp);
            });
            return row;
        };
        body.append(triple('m', ['px', 'py', 'pz'], 0.1));
        body.append(triple('deg', ['rx', 'ry', 'rz'], 15));
        const scaleRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        scaleRow.append(el('span', 'width:34px;opacity:.8;', 'scale'));
        const scaleIn = el('input', NUM.replace('width:46px', 'width:64px'));
        scaleIn.type = 'number'; scaleIn.step = '0.05';
        scaleIn.addEventListener('change', () => this._applyNumeric());
        this._fields.scale = scaleIn;
        scaleRow.append(scaleIn);
        body.append(scaleRow);

        const row2 = el('div', 'display:flex;gap:6px;margin-top:4px;');
        const yup = el('button', BTN, 'Y-up→Z-up');
        yup.addEventListener('click', () => {
            const it = this.active; if (!it) return;
            it.root.rotateX(Math.PI / 2);
            this._onGizmo();
        });
        const reset = el('button', BTN, 'Reset');
        reset.addEventListener('click', () => {
            const it = this.active; if (!it) return;
            it.root.position.set(0, 0, 0); it.root.rotation.set(0, 0, 0); it.root.scale.setScalar(1);
            this._onGizmo();
        });
        row2.append(yup, reset);
        body.append(row2);

        // hide / opacity / link-to-base
        const visRow = el('label', 'display:flex;align-items:center;gap:8px;margin:6px 0 2px;cursor:pointer;');
        this._visCb = el('input'); this._visCb.type = 'checkbox'; this._visCb.style.accentColor = '#2f81f7';
        this._visCb.addEventListener('change', () => {
            const it = this.active; if (!it) return;
            it.cfg.visible = this._visCb.checked;
            it.root.visible = it.cfg.visible;
            this._persist();
            this.sm.redraw?.();
        });
        visRow.append(this._visCb, el('span', 'opacity:.9;', 'Visible'));
        body.append(visRow);

        const opRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        opRow.append(el('span', 'width:34px;opacity:.8;', 'opac.'));
        this._opIn = el('input', 'flex:1;min-width:0;accent-color:#2f81f7;');
        this._opIn.type = 'range'; this._opIn.min = '0'; this._opIn.max = '1'; this._opIn.step = '0.01';
        this._opOut = el('span', 'width:32px;text-align:right;opacity:.9;font-size:10px;', '100%');
        this._opIn.addEventListener('input', () => {
            const it = this.active; if (!it) return;
            it.cfg.opacity = +this._opIn.value;
            this._opOut.textContent = `${Math.round(it.cfg.opacity * 100)}%`;
            this._applyOpacity(it);
            this.sm.redraw?.();
        });
        this._opIn.addEventListener('change', () => this._persist());
        opRow.append(this._opIn, this._opOut);
        body.append(opRow);

        const linkRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0 2px;cursor:pointer;');
        this._linkCb = el('input'); this._linkCb.type = 'checkbox'; this._linkCb.style.accentColor = '#2f81f7';
        this._linkCb.title = 'When on, this object moves with the Base section’s cell placement; when off, it stays fixed in world space.';
        this._linkCb.addEventListener('change', () => this.setLinkToBase(this.active, this._linkCb.checked));
        linkRow.append(this._linkCb, el('span', 'opacity:.9;', 'Link to base position'));
        body.append(linkRow);

        wrap.append(body);
        this._body = body;
        this._rebuildListUI();
        return wrap;
    }

    _onGizmo() {
        const it = this.active;
        if (!it) return;
        it.cfg.pos = it.root.position.toArray();
        it.cfg.euler = [it.root.rotation.x, it.root.rotation.y, it.root.rotation.z];
        it.cfg.scale = it.root.scale.x;
        this._refresh();
        this._persist();
        this.sm.redraw?.();
    }

    _applyNumeric() {
        const it = this.active; if (!it) return;
        const f = this._fields;
        it.root.position.set(+f.px.value || 0, +f.py.value || 0, +f.pz.value || 0);
        it.root.rotation.set((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R);
        it.root.scale.setScalar(+f.scale.value || 1);
        it.cfg.pos = it.root.position.toArray();
        it.cfg.euler = [it.root.rotation.x, it.root.rotation.y, it.root.rotation.z];
        it.cfg.scale = it.root.scale.x;
        this._persist();
        this.sm.redraw?.();
    }

    _rebuildListUI() {
        if (!this._sel) return;
        this._sel.innerHTML = '';
        if (!this.items.length) {
            this._sel.append(el('option', OPT, '— no objects —'));
            this._status.textContent = 'no objects loaded';
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
        this._status.textContent = `object: ${it.fileName}`;
        const f = this._fields;
        const p = it.root.position;
        const r = (v) => Math.round(v * 1000) / 1000;
        f.px.value = r(p.x); f.py.value = r(p.y); f.pz.value = r(p.z);
        f.rx.value = Math.round(it.root.rotation.x * R2D); f.ry.value = Math.round(it.root.rotation.y * R2D); f.rz.value = Math.round(it.root.rotation.z * R2D);
        f.scale.value = r(it.root.scale.x);
        this._visCb.checked = it.cfg.visible;
        this._opIn.value = String(it.cfg.opacity);
        this._opOut.textContent = `${Math.round(it.cfg.opacity * 100)}%`;
        this._linkCb.checked = it.cfg.linkToBase;
    }
}
