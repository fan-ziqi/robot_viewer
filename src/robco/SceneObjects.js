/**
 * SceneObjects — import background/prop/cell files into the cell. Unlike the End-Effector
 * (only one visible at a time), every scene object can be visible simultaneously; each has its own
 * position/rotation/scale (gizmo or numeric), a hide toggle, a transparency slider, and a
 * "link to base" toggle: linked objects live in BaseFrame.worldGroup (they move when you reposition
 * the base — the Setup panel's Base section moves the whole cell against a fixed robot), unlinked
 * ones live directly in the scene's world group and stay put regardless of base placement.
 *
 * Imports GLB/GLTF or OBJ (+MTL +textures — multi-select or pick the OBJ's folder; textures may
 * sit in subfolders). Huge CAD exports go through the streaming importer in objImport.js.
 *
 * MTBH workflow ("export the whole cell once, then define which parts can move"): when a file has
 * multiple NAMED parts, a picker appears. SELECT parts — via list checkboxes or by clicking them
 * in the 3D view (Pick mode; hover = orange, selected = blue) — then CONFIRM with "→ MTBH":
 * confirmed parts graduate into individual MTBH elements owned by MaterialManager (each with its
 * own output/mass, grippable) and leave this picker's list. Deleting an element in the Material
 * section returns the part here. Parts matching the auto-select pattern (default "rundstahl")
 * are pre-selected on import.
 */
import * as THREE from 'three';
import { autoMatch, collectParts, tintNodes } from './mtbhEntry.js';
import { registerManipulator, activateManipulator, deactivateManipulator } from './manipulators.js';
import { setRayFromCamera } from './pickRay.js';

const KEY = 'robco-scene-objects';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const LIST_CAP = 250; // max part rows rendered at once (filter to narrow)
const HOVER_TINT = 0xf78166;
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const ICON_BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 8px;cursor:pointer;';
const NUM = 'width:46px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
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
    return `so${Date.now().toString(36)}${_idSeq}`;
}

/** Coerce a stored/partial config into a complete, valid scene-object config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Scene object'),
        fileName: typeof s.fileName === 'string' ? s.fileName : '',
        visible: s.visible !== false,
        opacity: (typeof s.opacity === 'number' && s.opacity >= 0 && s.opacity <= 1) ? s.opacity : 1,
        linkToBase: s.linkToBase !== false,
        pos: Array.isArray(s.pos) && s.pos.length === 3 ? s.pos.map((v) => +v || 0) : [0, 0, 0],
        euler: Array.isArray(s.euler) && s.euler.length === 3 ? s.euler.map((v) => +v || 0) : [0, 0, 0],
        scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1,
        parts: Array.isArray(s.parts) ? [...new Set(s.parts.filter((p) => typeof p === 'string' && p))] : [],
        hidden: Array.isArray(s.hidden) ? [...new Set(s.hidden.filter((p) => typeof p === 'string' && p))] : [],
    };
}

/** SetupPanel owns the shared gizmo + Base section; this class is constructed by it directly. */
export class SceneObjects {
    constructor(setupPanel) {
        this.setupPanel = setupPanel;
        this.sm = setupPanel.sm;
        this.base = setupPanel.base;
        // item: { cfg, root, sources, fileName, allParts:[names], nodesByName:Map }
        // cfg.parts = the CURRENT (unconfirmed) selection; confirmed parts live in MaterialManager.
        this.items = [];
        this.activeId = null;
        this._pattern = 'rundstahl';
        this._picking = false;
        this._hoverName = null;
        this._ray = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._onPickDown = (e) => { this._downXY = [e.clientX, e.clientY]; };
        this._onPickUp = (e) => this._pickClick(e);
        this._onPickMove = (e) => this._pickHover(e);
        registerManipulator('mtbh-pick', () => this._setPicking(false));
        this._loadPersisted();
        this.section = this._buildSection();
    }

    get active() { return this.items.find((it) => it.cfg.id === this.activeId) || null; }

    _mm() { return window._robcoMaterialManager || null; }

    /** Part names of this object that already graduated into MTBH elements. */
    _takenSet(item) { return this._mm()?.takenParts?.(item) || new Set(); }

    /** Parts still owned by this picker (not yet MTBH). */
    availableParts(item) {
        const taken = this._takenSet(item);
        return item.allParts.filter((n) => !taken.has(n));
    }

    // --- load / add / remove --------------------------------------------
    /** Back-compat single-file entry (session restore may call this). */
    async addFromFile(file) { return this.addFromFiles([file]); }

    /** Import a scene object — GLB, or OBJ +MTL +textures (multi-select or folder pick). */
    async addFromFiles(files, opts = {}) {
        try {
            const { loadAnyModel, guessScale } = await import('./objImport.js');
            let lastPct = -1;
            const { content, main, isObj, partNames, maxDim, sources, sourceNames, missingTextures } = await loadAnyModel(files, {
                preferMain: opts.preferMain,
                onProgress: (frac) => {
                    const pct = Math.floor(frac * 100);
                    if (pct !== lastPct) { lastPct = pct; this._status.textContent = `parsing… ${pct}%`; }
                },
                onAssetsLoaded: () => this.sm.redraw?.(), // textures decode async; show them
            });

            const persisted = this._takePersisted(main.name);
            const cfg = sanitizeCfg(persisted, main.name.replace(/\.(obj|glb|gltf)$/i, ''));
            cfg.fileName = main.name;
            const fresh = !persisted;

            // CAD OBJ exports come in mm, cm or m; the world is metres. Guess the unit that lands
            // the model at a plausible cell size; the scale field corrects any wrong guess.
            if (fresh && isObj) {
                const s = guessScale(maxDim, 0.5, 30, 5);
                if (s !== 1) {
                    cfg.scale = s;
                    console.log(`[RobCo] scene object: bbox ${maxDim.toFixed(0)} units — guessed scale ${s} (${(maxDim * s).toFixed(1)}m)`);
                }
            }

            const root = new THREE.Object3D();
            root.name = `robco-scene-object-${cfg.id}`;
            root.position.fromArray(cfg.pos);
            root.rotation.set(...cfg.euler);
            root.scale.setScalar(cfg.scale);
            root.visible = cfg.visible;
            root.add(content);
            if (cfg.linkToBase) this.base.attach(root);
            else (this.sm.world || this.sm.scene).add(root);

            const nodesByName = collectParts(content);
            let allParts = partNames.filter((n) => nodesByName.has(n));
            if (!allParts.length) allParts = [...nodesByName.keys()];
            if (allParts.length < 2) allParts = []; // a single named mesh isn't worth a picker

            const item = { cfg, root, sources, sourceNames, fileName: main.name, allParts, nodesByName };
            this.items.push(item);
            this.activeId = cfg.id;

            // restore per-part hiding
            cfg.hidden = cfg.hidden.filter((n) => nodesByName.has(n));
            for (const n of cfg.hidden) for (const node of nodesByName.get(n)) node.visible = false;

            // Re-bind persisted MTBH elements to this file's parts BEFORE computing the selection,
            // so restored elements never show up as selectable again.
            this._mm()?.bindPendingParts?.(item);

            if (allParts.length) {
                const avail = new Set(this.availableParts(item));
                const wanted = fresh ? autoMatch(this._pattern, item.allParts) : cfg.parts;
                cfg.parts = wanted.filter((n) => avail.has(n));
                for (const n of cfg.parts) tintNodes(nodesByName.get(n), true);
                if (fresh && cfg.parts.length) console.log(`[RobCo] scene object: pre-selected ${cfg.parts.length} part(s) matching "${this._pattern}" — confirm with "→ MTBH"`);
            } else {
                cfg.parts = [];
            }

            if (cfg.opacity < 1) this._applyOpacity(item);
            this._persist();
            this._rebuildListUI();
            this._status.textContent = `object: ${main.name}`
                + (sources ? '' : ' (too large to embed in session saves)')
                + (missingTextures?.length ? ` — ${missingTextures.length} texture(s) missing, import the folder (📁)` : '');
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] scene object load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        }
    }

    /** The persisted config saved for this exact file. Order-based fallback ONLY for legacy
     *  saves without a fileName. */
    _takePersisted(fileName) {
        const i = this._persistedCfgs.findIndex((c) => c && c.fileName === fileName);
        if (i >= 0) return this._persistedCfgs.splice(i, 1)[0];
        const legacy = this._persistedCfgs.findIndex((c) => c && !c.fileName);
        if (legacy >= 0) return this._persistedCfgs.splice(legacy, 1)[0];
        return null;
    }

    removeItem(id) {
        const idx = this.items.findIndex((it) => it.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel._editing === 'scene') this.setupPanel._stopEdit();
        const [it] = this.items.splice(idx, 1);
        this._mm()?.dropElementsFor?.(it); // MTBH elements die with their source object
        it.root.parent?.remove(it.root);
        if (this.activeId === id) this.activeId = this.items[0]?.cfg.id || null;
        if (!this.active) this._setPicking(false);
        this._persist();
        this._rebuildListUI();
        this.sm.redraw?.();
    }

    // --- MTBH selection + confirm ------------------------------------------
    toggleSelect(item, name, on) {
        if (!item || !item.nodesByName.has(name)) return;
        const has = item.cfg.parts.includes(name);
        if (on === has) return;
        if (on) {
            if (this._takenSet(item).has(name)) return; // already an MTBH element
            item.cfg.parts.push(name);
        } else {
            item.cfg.parts = item.cfg.parts.filter((n) => n !== name);
        }
        if (this._hoverName !== name) tintNodes(item.nodesByName.get(name), on);
        this._persist();
        this._refresh();
        this.sm.redraw?.();
    }

    /** Turn the current selection into individual MTBH elements (owned by MaterialManager). */
    confirmSelection() {
        const it = this.active;
        const mm = this._mm();
        if (!it || !mm || !it.cfg.parts.length) return;
        const names = it.cfg.parts;
        it.cfg.parts = [];
        mm.addPartElements(it, names);
        this._persist();
        this._refresh();
        this.sm.redraw?.();
    }

    /** An MTBH element was deleted in the Material section — its part is selectable again. */
    onElementsChanged() { this._refresh(); }

    /** Hide/show one named part of this object (persisted). */
    togglePartHidden(item, name, hidden) {
        if (!item || !item.nodesByName.has(name)) return;
        for (const node of item.nodesByName.get(name)) node.visible = !hidden;
        item.cfg.hidden = hidden
            ? [...new Set([...item.cfg.hidden, name])]
            : item.cfg.hidden.filter((n) => n !== name);
        this._persist();
        this._renderPartList();
        this.sm.redraw?.();
    }

    // --- 3D view picking ------------------------------------------------
    _setPicking(on) {
        on = !!on;
        if (on === this._picking) return;
        this._picking = on;
        const dom = this.sm.renderer?.domElement;
        if (!dom) { this._picking = false; return; }
        if (on) {
            activateManipulator('mtbh-pick'); // closes gizmos that would swallow clicks
            dom.addEventListener('pointerdown', this._onPickDown);
            dom.addEventListener('pointerup', this._onPickUp);
            dom.addEventListener('pointermove', this._onPickMove);
            dom.style.cursor = 'crosshair';
        } else {
            dom.removeEventListener('pointerdown', this._onPickDown);
            dom.removeEventListener('pointerup', this._onPickUp);
            dom.removeEventListener('pointermove', this._onPickMove);
            dom.style.cursor = '';
            this._applyHover(null);
            deactivateManipulator('mtbh-pick');
        }
        if (this._pickBtn) {
            this._pickBtn.style.background = on ? 'rgba(47,129,247,0.25)' : 'rgba(255,255,255,0.06)';
            this._pickBtn.style.borderColor = on ? 'rgba(47,129,247,0.7)' : 'rgba(255,255,255,0.15)';
        }
    }

    /** Raycast the event against the active object (plus its gripped MTBH nodes) → part name. */
    _partAt(e) {
        const it = this.active;
        if (!it) return null;
        const dom = this.sm.renderer.domElement;
        const rect = dom.getBoundingClientRect();
        this._ndc.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        setRayFromCamera(this._ray, this._ndc, this.sm.camera); // ortho-safe (faked projection)
        const targets = [it.root];
        for (const elItem of this._mm()?.elementsFor?.(it) || []) {
            for (const entry of elItem.entries.values()) {
                for (const n of entry.nodes) if (!targets.includes(n)) targets.push(n);
            }
        }
        for (const hit of this._ray.intersectObjects(targets, true)) {
            let n = hit.object;
            while (n && n !== this.sm.scene) {
                if (n.name && it.nodesByName.get(n.name)?.includes(n)) return n.name;
                n = n.parent;
            }
        }
        return null;
    }

    _pickClick(e) {
        if (e.button !== 0) return;
        const d = this._downXY;
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 6) return; // that was an orbit drag
        const it = this.active;
        if (!it) return;
        const name = this._partAt(e);
        if (!name) return;
        if (this._takenSet(it).has(name)) {
            this._mm()?.selectPartElement?.(it, name); // already MTBH — focus its element instead
        } else {
            this.toggleSelect(it, name, !it.cfg.parts.includes(name));
        }
    }

    _pickHover(e) {
        if (this._hoverPending) return; // throttle raycasts to one per frame
        this._hoverPending = true;
        requestAnimationFrame(() => {
            this._hoverPending = false;
            if (!this._picking) return;
            this._applyHover(this._partAt(e));
        });
    }

    _applyHover(name) {
        const it = this.active;
        if (name === this._hoverName) return;
        if (this._hoverName && it) {
            // restore the previous hover to its resting tint
            const nodes = it.nodesByName.get(this._hoverName);
            if (nodes) {
                const resting = it.cfg.parts.includes(this._hoverName) || this._takenSet(it).has(this._hoverName);
                tintNodes(nodes, resting);
            }
        }
        this._hoverName = name;
        if (name && it) tintNodes(it.nodesByName.get(name), true, HOVER_TINT, 0.6);
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
            if (typeof s?.pattern === 'string') this._pattern = s.pattern;
        } catch { this._persistedCfgs = []; }
    }

    _persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                items: this.items.map((it) => it.cfg),
                pattern: this._pattern,
            }));
        } catch { /* ignore */ }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');
        const listRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._sel = el('select', SELECT);
        this._sel.addEventListener('change', () => { this.activeId = this._sel.value; this._applyHover(null); this._refresh(); });
        const addBtn = el('button', ICON_BTN, '＋');
        addBtn.title = 'Import files — OBJ (+MTL +textures, multi-select) or GLB';
        const dirBtn = el('button', ICON_BTN, '📁');
        dirBtn.title = 'Import a folder — the OBJ plus its MTL and textures (subfolders included)';
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this object';
        delBtn.addEventListener('click', () => { if (this.activeId) this.removeItem(this.activeId); });
        listRow.append(this._sel, addBtn, dirBtn, delBtn);
        wrap.append(listRow);

        import('./objImport.js').then(({ makeFilePickers }) => {
            const { fileInput, dirInput, openFolder } = makeFilePickers(
                (files, opts) => this.addFromFiles(files, opts),
                { onHint: (t) => { this._status.textContent = t; } },
            );
            wrap.append(fileInput, dirInput);
            addBtn.addEventListener('click', () => fileInput.click());
            dirBtn.addEventListener('click', () => openFolder());
        });

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

        // ---- parts → MTBH picker (files with multiple named parts) ----
        this._partsBlock = el('div');
        this._partsBlock.append(el('div', 'font-weight:600;font-size:10px;opacity:.85;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.04em;', 'Parts → MTBH'));
        this._partsBlock.append(el('div', 'font-size:10px;color:#6e7681;margin:0 0 3px;', 'Select movable parts (list or 3D click), then confirm — they become MTBH elements in the Material section.'));

        const patRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;');
        patRow.append(el('span', 'width:46px;opacity:.8;', 'pattern'));
        this._patIn = el('input', TEXT);
        this._patIn.type = 'text';
        this._patIn.title = 'Auto-select pattern (regex or substring, case-insensitive). Applied on import; "Auto" re-applies it.';
        this._patIn.addEventListener('change', () => { this._pattern = this._patIn.value; this._persist(); });
        const autoBtn = el('button', ICON_BTN, 'Auto');
        autoBtn.title = 'Select all parts matching the pattern';
        autoBtn.addEventListener('click', () => {
            const it = this.active; if (!it) return;
            const avail = new Set(this.availableParts(it));
            for (const n of autoMatch(this._pattern, it.allParts)) {
                if (avail.has(n)) this.toggleSelect(it, n, true);
            }
        });
        patRow.append(this._patIn, autoBtn);
        this._partsBlock.append(patRow);

        const filterRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;');
        this._filterIn = el('input', TEXT);
        this._filterIn.type = 'text'; this._filterIn.placeholder = 'filter parts…';
        this._filterIn.addEventListener('input', () => this._renderPartList());
        const markShown = el('button', ICON_BTN, '✓');
        markShown.title = 'Select all shown parts';
        markShown.addEventListener('click', () => this._bulkShown(true));
        const clearShown = el('button', ICON_BTN, '✗');
        clearShown.title = 'Deselect all shown parts';
        clearShown.addEventListener('click', () => this._bulkShown(false));
        filterRow.append(this._filterIn, markShown, clearShown);
        this._partsBlock.append(filterRow);

        this._partList = el('div',
            'max-height:170px;overflow:auto;border:1px solid rgba(255,255,255,0.1);border-radius:6px;' +
            'padding:3px 5px;margin:3px 0;font-size:11px;');
        this._partsBlock.append(this._partList);
        this._partsHint = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', '');
        this._partsBlock.append(this._partsHint);

        const actRow = el('div', 'display:flex;gap:6px;margin:4px 0;');
        this._pickBtn = el('button', BTN, 'Pick 3D');
        this._pickBtn.title = 'Click parts in the 3D view to select/deselect them (hover = orange). Click again to exit.';
        this._pickBtn.addEventListener('click', () => this._setPicking(!this._picking));
        this._confirmBtn = el('button', BTN + 'background:rgba(47,129,247,0.18);border-color:rgba(47,129,247,0.55);', '→ MTBH');
        this._confirmBtn.title = 'Confirm the selection: turn the selected parts into individual MTBH elements (Material section).';
        this._confirmBtn.addEventListener('click', () => this.confirmSelection());
        actRow.append(this._pickBtn, this._confirmBtn);
        this._partsBlock.append(actRow);

        body.append(this._partsBlock);

        wrap.append(body);
        this._body = body;
        this._patIn.value = this._pattern;
        this._rebuildListUI();
        return wrap;
    }

    _bulkShown(on) {
        const it = this.active; if (!it) return;
        for (const n of this._shownParts(it)) this.toggleSelect(it, n, on);
    }

    _shownParts(it) {
        const f = (this._filterIn?.value || '').trim().toLowerCase();
        const avail = this.availableParts(it);
        const names = f ? avail.filter((n) => n.toLowerCase().includes(f)) : avail;
        return names.slice(0, LIST_CAP);
    }

    _renderPartList() {
        const it = this.active;
        if (!it || !this._partList) return;
        this._partList.innerHTML = '';
        const f = (this._filterIn?.value || '').trim().toLowerCase();
        const avail = this.availableParts(it);
        const all = f ? avail.filter((n) => n.toLowerCase().includes(f)) : avail;
        for (const name of all.slice(0, LIST_CAP)) {
            const hidden = it.cfg.hidden.includes(name);
            const row = el('label', 'display:flex;align-items:center;gap:6px;margin:1px 0;cursor:pointer;');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.style.accentColor = '#2f81f7';
            cb.checked = it.cfg.parts.includes(name);
            cb.addEventListener('change', () => this.toggleSelect(it, name, cb.checked));
            const span = el('span',
                `flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:${hidden ? '.4' : '.9'};`,
                name);
            span.title = name;
            const eye = el('button',
                'background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;' +
                `opacity:${hidden ? '1' : '.45'};`, hidden ? '🚫' : '👁');
            eye.title = hidden ? 'Show this part' : 'Hide this part from the scene';
            eye.addEventListener('click', (e) => {
                e.preventDefault(); // it's inside a <label> — don't toggle the checkbox
                this.togglePartHidden(it, name, !hidden);
            });
            row.append(cb, span, eye);
            this._partList.append(row);
        }
        const extra = all.length - Math.min(all.length, LIST_CAP);
        const taken = this._takenSet(it).size;
        this._partsHint.textContent =
            `${it.cfg.parts.length} selected / ${avail.length} parts` +
            (taken ? ` (${taken} already MTBH)` : '') +
            (extra > 0 ? ` — ${extra} hidden (refine filter)` : '');
        this._confirmBtn.textContent = `→ MTBH (${it.cfg.parts.length})`;
        this._confirmBtn.disabled = !it.cfg.parts.length;
        this._confirmBtn.style.opacity = it.cfg.parts.length ? '1' : '0.4';
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
        const hasParts = it.allParts.length > 0;
        this._partsBlock.style.display = hasParts ? 'block' : 'none';
        if (hasParts) this._renderPartList();
        else this._setPicking(false);
    }
}
