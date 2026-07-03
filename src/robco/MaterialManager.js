/**
 * MaterialManager — the gripper side of MTBH ("material to be handled").
 *
 * Two kinds of MTBH elements live in this section's list:
 *   • kind 'part' — confirmed parts of a Scene Object (the main workflow: export the whole cell
 *     once, import it in Scene Objects, select parts, confirm "→ MTBH"). Each confirmed part is
 *     an individual element here (own mass), removed from the scene picker's list; deleting it
 *     returns the part to the picker. Elements re-bind automatically when their source file is
 *     re-imported (matched by source object id / file name).
 *   • kind 'file' — standalone workpiece imports (GLB or OBJ +MTL +textures), grippable as a
 *     whole; useful for quick tests without a full cell export.
 *
 * Gripping: ONE output — the End-Effector section's `output` field (EndEffector.gripOutputName())
 * — is shared by every element; there are no per-part outputs. `setOutput(name, active)` is the
 * single entry point (manual sim toggle and the live RobFlow message stream both call it) and
 * ignores names that don't match the gripper's output. On a rising edge it grips the CLOSEST
 * non-gripped element to the grip point — a configurable offset (mm, relative to the gripper/tool
 * origin, EndEffector.attachPoint()) with an optional marker sphere — and that element follows
 * the gripper while the output stays ON. Attachment is THREE.Object3D.attach(): a
 * world-pose-preserving reparent, so pickup never snaps and needs no per-frame code. On the
 * falling edge the gripped element is released in place. "Reset MTBH positions" returns every
 * element to its captured default pose.
 *
 * Live trigger, two paths (both baseline the state present at connect, acting on EDGES only):
 *   • `ingestOutputs()` — the /robot WS streams the robot's digital outputs as
 *     `{type:'outputs', data:[{bankId, ios:[bool…]}]}`. When the End-Effector's output field is
 *     an output reference ("1/0" = bank 1, io 0; plain "3" = bank 0, io 3), that real output
 *     drives the grip directly. Every output edge is console-logged, so toggling the gripper in
 *     RobCo Studio reveals which bank/io to type.
 *   • `ingestMessages()` — fallback for named outputs: flow messageLog entries of the form
 *     `output:<name>=<1|0|on|off|true|false>` route to setOutput().
 *
 * While gripped, an element's mass feeds the dynamics as the 'material' payload source, summed
 * alongside 'tcp'/'gripper'/'robot'.
 */
import * as THREE from 'three';
import { makeEntry, gripEntry, releaseEntry, resetEntry, entryDistance, tintNodes, parseOutputRef } from './mtbhEntry.js';

const KEY = 'robco-materials';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const ICON_BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 8px;cursor:pointer;';
const NUM = 'width:52px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
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
    return `mat${Date.now().toString(36)}${_idSeq}`;
}

const normName = (s) => String(s || '').trim().toLowerCase();

/** Coerce a stored/partial config into a complete, valid element config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        kind: s.kind === 'part' ? 'part' : 'file',
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Material'),
        fileName: typeof s.fileName === 'string' ? s.fileName : '',
        partName: typeof s.partName === 'string' ? s.partName : '',
        sourceId: typeof s.sourceId === 'string' ? s.sourceId : '',
        sourceFile: typeof s.sourceFile === 'string' ? s.sourceFile : '',
        gripped: false, // never restore "gripped" as a saved state — always starts released
        mass: typeof s.mass === 'number' && s.mass >= 0 ? s.mass : 0,
        scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1,
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
        // item (file): { cfg, root, sources, fileName, entries:Map('' -> whole entry) }
        // item (part): { cfg, sourceItem, fileName, entries:Map(partName -> entry) } — no root
        this.items = [];
        this.activeId = null;
        this._seq = 0;
        this._showGrip = false;
        this._msgSeen = null; // null until the first messages frame baselines the backlog
        this._loadPersisted();
        if (setupPanel) setupPanel.addSection(this._buildSection(), { title: 'Material (MTBH)', key: 'material' });
        // Scene objects imported before this manager existed: bind their persisted elements now.
        for (const sit of setupPanel?.sceneObjects?.items || []) this.bindPendingParts(sit);
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
            setupPanel.addSection(this._section || this._buildSection(), { title: 'Material (MTBH)', key: 'material' });
        }
        if (rebuilt) this.onAttachPointChanged();
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

    _attachPoint() { return this.endEffector?.attachPoint?.() || this._flange(); }

    _worldParent() { return this.base ? this.base.worldGroup : (this.sm.world || this.sm.scene); }

    /** Every grip candidate as {entry, mass, label} — they all share the gripper's one output. */
    _allEntries() {
        const out = [];
        for (const it of this.items) {
            for (const entry of it.entries.values()) {
                out.push({ entry, mass: it.cfg.mass, label: it.cfg.name });
            }
        }
        return out;
    }

    /** The gripper's output name — owned by the End-Effector section. */
    _gripOutputName() { return this.endEffector?.gripOutputName?.() || 'Gripper'; }

    // --- MTBH elements from scene-object parts -------------------------------
    _elementFor(sceneItem, partName) {
        return this.items.find((it) => it.cfg.kind === 'part' && it.cfg.sourceId === sceneItem.cfg.id && it.cfg.partName === partName);
    }

    /** All elements sourced from a scene object. */
    elementsFor(sceneItem) {
        return this.items.filter((it) => it.cfg.kind === 'part' && it.cfg.sourceId === sceneItem.cfg.id);
    }

    /** Part names of a scene object that already are MTBH elements (its picker hides them). */
    takenParts(sceneItem) {
        return new Set(this.elementsFor(sceneItem).map((it) => it.cfg.partName));
    }

    _makePartItem(cfg, sceneItem) {
        const nodes = sceneItem.nodesByName.get(cfg.partName);
        const entry = makeEntry(cfg.partName, nodes);
        tintNodes(nodes, true);
        return { cfg, sourceItem: sceneItem, fileName: cfg.sourceFile, entries: new Map([[cfg.partName, entry]]) };
    }

    /** Confirm scene-object parts as individual MTBH elements. */
    addPartElements(sceneItem, names) {
        let added = 0;
        for (const name of names || []) {
            if (!sceneItem.nodesByName.has(name) || this._elementFor(sceneItem, name)) continue;
            const cfg = sanitizeCfg({
                kind: 'part', name, partName: name,
                sourceId: sceneItem.cfg.id, sourceFile: sceneItem.fileName,
            }, name);
            this.items.push(this._makePartItem(cfg, sceneItem));
            added += 1;
        }
        if (added) {
            this.activeId = this.items[this.items.length - 1].cfg.id;
            this._persist();
            this._rebuildListUI();
            this.sm.redraw?.();
        }
        return added;
    }

    /** A scene object finished loading: re-create its persisted MTBH elements. */
    bindPendingParts(sceneItem) {
        let bound = 0;
        for (let i = this._persistedCfgs.length - 1; i >= 0; i--) {
            const c = this._persistedCfgs[i];
            if (!c || c.kind !== 'part') continue;
            if (c.sourceId !== sceneItem.cfg.id && c.sourceFile !== sceneItem.fileName) continue;
            if (!sceneItem.nodesByName.has(c.partName)) continue;
            this._persistedCfgs.splice(i, 1);
            const cfg = sanitizeCfg(c, c.partName);
            cfg.sourceId = sceneItem.cfg.id; // heal a file-name-only match
            cfg.sourceFile = sceneItem.fileName;
            this.items.push(this._makePartItem(cfg, sceneItem));
            bound += 1;
        }
        if (bound) {
            if (!this.activeId) this.activeId = this.items[0].cfg.id;
            this._persist();
            this._rebuildListUI();
            this.sm.redraw?.();
        }
        return bound;
    }

    /** The source scene object was removed — its elements go with it. */
    dropElementsFor(sceneItem) {
        const drop = this.elementsFor(sceneItem);
        if (!drop.length) return;
        this.items = this.items.filter((it) => !drop.includes(it));
        if (drop.some((it) => it.cfg.id === this.activeId)) this.activeId = this.items[0]?.cfg.id || null;
        this._syncMassPayload();
        this._persist();
        this._rebuildListUI();
    }

    /** Focus an element in the picker (3D click on an already-confirmed part). */
    selectPartElement(sceneItem, partName) {
        const it = this._elementFor(sceneItem, partName);
        if (!it) return;
        this.activeId = it.cfg.id;
        this._rebuildListUI();
    }

    // --- load / add / remove --------------------------------------------
    /** Back-compat single-file entry (session restore calls this). */
    async addFromFile(file) { return this.addFromFiles([file]); }

    /**
     * Import a standalone workpiece (GLB, or OBJ +MTL +textures) — grippable as a whole.
     * Cell files with selectable parts belong in Scene Objects instead.
     */
    async addFromFiles(files, opts = {}) {
        try {
            const { loadAnyModel, guessScale } = await import('./objImport.js');
            let lastPct = -1;
            const { content, main, isObj, maxDim, sources, sourceNames, missingTextures } = await loadAnyModel(files, {
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
            // Workpieces are decimetre-scale; guess mm/cm exports (the scale field corrects).
            if (!persisted && isObj) {
                const s = guessScale(maxDim, 0.01, 3, 0.3);
                if (s !== 1) {
                    cfg.scale = s;
                    console.log(`[RobCo] material: bbox ${maxDim.toFixed(0)} units — guessed scale ${s}`);
                }
            }

            const root = new THREE.Object3D();
            root.name = `robco-material-${cfg.id}`;
            root.position.fromArray(cfg.pos);
            root.quaternion.fromArray(cfg.quat);
            root.scale.setScalar(cfg.scale);
            root.add(content);
            this._worldParent().add(root);

            const item = { cfg, root, sources, sourceNames, fileName: main.name, entries: new Map() };
            item.entries.set('', this._makeWholeEntry(item));
            this.items.push(item);
            this.activeId = cfg.id;

            this._persist();
            this._rebuildListUI();
            this._status.textContent = `material: ${main.name}`
                + (sources ? '' : ' (too large to embed in session saves)')
                + (missingTextures?.length ? ` — ${missingTextures.length} texture(s) missing, import the folder (📁)` : '');
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] material load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        }
    }

    /** The persisted config saved for this exact file (part-element configs are bound via
     *  bindPendingParts, never consumed here). Order-based fallback ONLY for legacy saves
     *  without a fileName. */
    _takePersisted(fileName) {
        const files = (c) => c && c.kind !== 'part';
        const i = this._persistedCfgs.findIndex((c) => files(c) && c.fileName === fileName);
        if (i >= 0) return this._persistedCfgs.splice(i, 1)[0];
        const legacy = this._persistedCfgs.findIndex((c) => files(c) && !c.fileName);
        if (legacy >= 0) return this._persistedCfgs.splice(legacy, 1)[0];
        return null;
    }

    _makeWholeEntry(item) {
        const entry = makeEntry('', [item.root]);
        entry.homes[0].parent = this._worldParent();
        return entry;
    }

    removeItem(id) {
        const idx = this.items.findIndex((it) => it.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel?._editing === 'material') this.setupPanel._stopEdit();
        const [it] = this.items.splice(idx, 1);
        for (const entry of it.entries.values()) {
            if (entry.gripped) releaseEntry(entry, it.sourceItem?.root || this._worldParent());
        }
        if (it.cfg.kind === 'part') {
            // the part returns to its scene object's picker, untinted
            for (const entry of it.entries.values()) tintNodes(entry.nodes, false);
            this.setupPanel?.sceneObjects?.onElementsChanged?.();
        } else {
            it.root.parent?.remove(it.root);
        }
        if (this.activeId === id) this.activeId = this.items[0]?.cfg.id || null;
        this._syncMassPayload();
        this._persist();
        this._rebuildListUI();
        this.sm.redraw?.();
    }

    // --- grip point --------------------------------------------------------
    /** The current gripper's grip point (mm) — per tool, owned by the End-Effector section. */
    _gripMmNow() { return this.endEffector?.gripPointMm?.() || [0, 0, 0]; }

    _gripPointWorld(out = new THREE.Vector3()) {
        const ap = this._attachPoint();
        if (!ap) return null;
        ap.updateMatrixWorld(true);
        const g = this._gripMmNow();
        return out.set(g[0] / 1000, g[1] / 1000, g[2] / 1000).applyMatrix4(ap.matrixWorld);
    }

    _ensureGripMarker() {
        if (!this._marker) {
            const geo = new THREE.SphereGeometry(0.008, 16, 12);
            const mat = new THREE.MeshBasicMaterial({ color: 0x2f81f7, depthTest: false, transparent: true, opacity: 0.9 });
            this._marker = new THREE.Mesh(geo, mat);
            this._marker.name = 'robco-grip-point';
            this._marker.renderOrder = 999;
        }
        const ap = this._attachPoint();
        if (ap && this._marker.parent !== ap) ap.add(this._marker);
        const g = this._gripMmNow();
        this._marker.position.set(g[0] / 1000, g[1] / 1000, g[2] / 1000);
        this._marker.visible = this._showGrip;
    }

    /** The active tool changed or the model was rebuilt: re-home the marker + gripped nodes.
     *  Gripped nodes keep their gripper-local pose (plain add, not attach). */
    onAttachPointChanged() {
        const ap = this._attachPoint();
        if (!ap) return;
        for (const { entry } of this._allEntries()) {
            if (entry.gripped) for (const n of entry.nodes) ap.add(n);
        }
        this._ensureGripMarker();
        this._syncMassPayload();
        this.sm.redraw?.();
    }

    // --- grip / release -----------------------------------------------------
    /**
     * Drive the grip by output name — called by the sim toggle and the live message stream.
     * Only the gripper's output (End-Effector section) is honored; other names are ignored.
     * Rising edge: grip the closest non-gripped element to the grip point (hold if one is
     * already gripped); it follows the gripper while the output stays ON. Falling edge:
     * release in place.
     */
    setOutput(outputName, active) {
        const want = normName(outputName);
        if (!want || want !== normName(this._gripOutputName())) return;
        const cands = this._allEntries();
        if (!cands.length) return;
        if (active) {
            if (cands.some((c) => c.entry.gripped)) return; // already holding — keep it
            const ap = this._attachPoint();
            const gp = this._gripPointWorld();
            if (!ap || !gp) return;
            this.sm.scene.updateMatrixWorld(true);
            let best = null;
            let bestD = null;
            for (const c of cands) {
                const d = entryDistance(c.entry, gp);
                if (!best || d.d < bestD.d - 1e-9 || (Math.abs(d.d - bestD.d) <= 1e-9 && d.dc < bestD.dc)) {
                    best = c; bestD = d;
                }
            }
            if (!best || bestD.d === Infinity) return;
            this._seq += 1;
            gripEntry(best.entry, ap, this._seq);
            console.log(`[RobCo] gripped "${best.label}" (${(bestD.d * 1000).toFixed(0)}mm from grip point)`);
        } else {
            for (const c of cands) if (c.entry.gripped) releaseEntry(c.entry, this._worldParent());
        }
        this._syncMassPayload();
        this._refresh();
        this.sm.redraw?.();
    }

    /** Direct grip of the active element (the per-item checkbox — bypasses closest-match). */
    setGripped(item, on) {
        const entry = item ? item.entries.values().next().value : null;
        if (!entry || on === entry.gripped) return;
        if (on) {
            const ap = this._attachPoint();
            if (!ap) return;
            this._seq += 1;
            gripEntry(entry, ap, this._seq);
        } else {
            releaseEntry(entry, item.sourceItem?.root || this._worldParent());
        }
        item.cfg.gripped = entry.gripped;
        this._syncMassPayload();
        this._refresh();
        this.sm.redraw?.();
    }

    /** Release every gripped element in place — a tool change may not carry parts over. */
    releaseAll() {
        let any = false;
        for (const c of this._allEntries()) {
            if (c.entry.gripped) { releaseEntry(c.entry, this._worldParent()); any = true; }
        }
        if (!any) return;
        this._syncMassPayload();
        this._refresh();
        this.sm.redraw?.();
    }

    /** Return every MTBH element to its captured default pose. */
    resetPositions() {
        for (const { entry } of this._allEntries()) resetEntry(entry);
        for (const it of this.items) it.cfg.gripped = false;
        this._syncMassPayload();
        this._refresh();
        this.sm.redraw?.();
    }

    // --- live RobFlow digital outputs -----------------------------------------
    /**
     * Feed a `{type:'outputs'}` WS payload: `[{bankId, ios:[bool…]}, …]`. The state present in
     * the first frame is baselined (never acted on); afterwards every edge is logged — toggle
     * the gripper in RobCo Studio and the console shows which bank/io it is — and an edge on
     * the End-Effector's configured output (e.g. "1/0") grips/releases.
     */
    ingestOutputs(data) {
        if (!Array.isArray(data)) return;
        const cur = new Map(); // 'bank/io' -> bool
        for (const b of data) {
            const ios = Array.isArray(b?.ios) ? b.ios : [];
            for (let i = 0; i < ios.length; i++) cur.set(`${b.bankId ?? 0}/${i}`, !!ios[i]);
        }
        if (!this._outState) { this._outState = cur; return; }
        const name = this._gripOutputName();
        const ref = parseOutputRef(name);
        const watched = ref ? `${ref.bank}/${ref.io}` : null;
        for (const [key, val] of cur) {
            const prev = this._outState.get(key);
            if (prev === undefined || prev === val) continue;
            console.log(`[RobCo] output ${key} -> ${val ? 'ON' : 'OFF'}${key === watched ? ' (gripper)' : ''}`);
            if (key === watched) this.setOutput(name, val);
        }
        this._outState = cur;
    }

    // --- live RobFlow message stream -----------------------------------------
    /**
     * Feed a `{type:'messages'}` WS payload (cumulative log). Matches messageLog entries of the
     * form `output:<name>=<value>` and routes them to setOutput(). The backlog present in the
     * first frame is baselined (marked seen, never applied) so history can't fire the gripper.
     */
    ingestMessages(data) {
        const list = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : null);
        if (!list) return;
        if (!this._msgSeen) {
            this._msgSeen = new Set(list.map((m) => m?.uuid).filter(Boolean));
            return;
        }
        const fresh = [];
        for (const m of list) {
            if (!m || !m.uuid || this._msgSeen.has(m.uuid)) continue;
            this._msgSeen.add(m.uuid);
            fresh.push(m);
        }
        if (this._msgSeen.size > 8000) this._msgSeen = new Set(list.map((m) => m?.uuid).filter(Boolean));
        if (!fresh.length) return;
        fresh.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
        for (const m of fresh) {
            const hit = /output\s*[:=\s]\s*([\w .\-]+?)\s*[:=]\s*(on|off|true|false|high|low|1|0)\b/i
                .exec(String(m.message ?? ''));
            if (!hit) continue;
            this.setOutput(hit[1], /^(on|true|high|1)$/i.test(hit[2]));
        }
    }

    /** CoM ~= bbox centre of the gripped nodes, in the attach point's local frame. */
    _grippedCoM(entry, ap) {
        ap.updateMatrixWorld(true);
        const box = new THREE.Box3();
        const tmp = new THREE.Box3();
        for (const n of entry.nodes) {
            n.updateMatrixWorld(true);
            tmp.setFromObject(n);
            if (!tmp.isEmpty()) box.union(tmp);
        }
        if (box.isEmpty()) return [0, 0, 0];
        return ap.worldToLocal(box.getCenter(new THREE.Vector3())).toArray();
    }

    // Only one gripper in this simulation: the most-recently-gripped candidate wins the mass feed.
    _syncMassPayload() {
        let latest = null;
        for (const c of this._allEntries()) {
            if (c.entry.gripped && (!latest || c.entry.seq > latest.entry.seq)) latest = c;
        }
        const dyn = window._robcoDynamics;
        if (!latest) { dyn?.setPayloadSource?.('material', 0, [0, 0, 0]); return; }
        const ap = this._attachPoint();
        dyn?.setPayloadSource?.('material', latest.mass || 0, ap ? this._grippedCoM(latest.entry, ap) : [0, 0, 0]);
    }

    // --- persistence ---------------------------------------------------
    _loadPersisted() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            this._persistedCfgs = (s && Array.isArray(s.items)) ? s.items : [];
            if (typeof s?.showGrip === 'boolean') this._showGrip = s.showGrip;
        } catch { this._persistedCfgs = []; }
    }

    _persist() {
        try {
            // Part-element configs still waiting for their scene object must survive the save.
            const pending = (this._persistedCfgs || []).filter((c) => c && c.kind === 'part');
            localStorage.setItem(KEY, JSON.stringify({
                items: [...this.items.map((it) => it.cfg), ...pending],
                showGrip: this._showGrip,
            }));
        } catch { /* ignore */ }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');

        this._status = el('div', 'font-size:11px;color:#9da7b3;margin:2px 0 4px;', 'no MTBH elements');
        wrap.append(this._status);

        // ---- element list (confirmed parts + standalone workpieces) ----
        const listRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._sel = el('select', SELECT);
        this._sel.addEventListener('change', () => { this.activeId = this._sel.value; this._refresh(); });
        const addBtn = el('button', ICON_BTN, '＋');
        addBtn.title = 'Import a standalone workpiece (GLB or OBJ). Cell files with selectable parts go to Scene Objects.';
        const dirBtn = el('button', ICON_BTN, '📁');
        dirBtn.title = 'Import a folder — the OBJ plus its MTL and textures';
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this element (a scene-object part returns to its picker)';
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

        const body = el('div', 'display:none;');

        this._srcNote = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', '');
        body.append(this._srcNote);

        // file-item-only rows (a part element is aligned via its scene object)
        this._fileRows = el('div');
        const alignRow = el('div', 'display:flex;gap:6px;margin:2px 0;align-items:center;');
        this._alignBtn = el('button', BTN, 'Align');
        this._alignBtn.addEventListener('click', () => {
            const it = this.active;
            if (!it || it.cfg.kind === 'part') return;
            this.setupPanel?._edit('material', it.root, ['translate', 'rotate', 'scale'], () => this._onAligned());
        });
        const yupBtn = el('button', BTN, 'Y-up→Z-up');
        yupBtn.addEventListener('click', () => {
            const it = this.active; if (!it || it.cfg.kind === 'part') return;
            it.root.rotateX(Math.PI / 2);
            this._onAligned();
        });
        alignRow.append(this._alignBtn, yupBtn);
        this._fileRows.append(alignRow);

        const scaleRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        scaleRow.append(el('span', 'width:64px;opacity:.8;', 'scale'));
        this._scaleIn = el('input', NUM.replace('width:52px', 'width:64px'));
        this._scaleIn.type = 'number'; this._scaleIn.step = '0.001';
        this._scaleIn.addEventListener('change', () => {
            const it = this.active; if (!it || it.cfg.kind === 'part') return;
            it.root.scale.setScalar(+this._scaleIn.value || 1);
            this._onAligned();
        });
        scaleRow.append(this._scaleIn);
        this._fileRows.append(scaleRow);
        body.append(this._fileRows);

        const massRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        massRow.append(el('span', 'width:64px;opacity:.8;', 'mass kg'));
        this._massIn = el('input', NUM.replace('width:52px', 'width:64px'));
        this._massIn.type = 'number'; this._massIn.step = '0.1'; this._massIn.min = '0';
        this._massIn.addEventListener('change', () => {
            const it = this.active; if (!it) return;
            it.cfg.mass = Math.max(0, +this._massIn.value || 0);
            this._persist();
            this._syncMassPayload();
        });
        massRow.append(this._massIn);
        body.append(massRow);

        const manualRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        this._gripCb = el('input'); this._gripCb.type = 'checkbox'; this._gripCb.style.accentColor = '#2f81f7';
        this._gripCb.addEventListener('change', () => this.setGripped(this.active, this._gripCb.checked));
        manualRow.append(this._gripCb, el('span', 'opacity:.9;', 'Grip this element (direct)'));
        body.append(manualRow);

        wrap.append(body);
        this._body = body;

        // ---- gripper block (simulation + resets; grip point + output live per-tool in End-Effector) ----
        wrap.append(el('div', 'font-weight:600;font-size:10px;opacity:.85;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.04em;', 'Gripper'));

        const showRow = el('label', 'display:flex;align-items:center;gap:8px;margin:3px 0;cursor:pointer;');
        showRow.title = 'Marker sphere at the active tool’s grip point (set per tool in the End-Effector section).';
        this._showCb = el('input'); this._showCb.type = 'checkbox'; this._showCb.style.accentColor = '#2f81f7';
        this._showCb.addEventListener('change', () => {
            this._showGrip = this._showCb.checked;
            this._ensureGripMarker();
            this._persist();
            this.sm.redraw?.();
        });
        showRow.append(this._showCb, el('span', 'opacity:.9;', 'Show grip point'));
        wrap.append(showRow);

        const simRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        simRow.title = 'Simulate the gripper output (name set in the End-Effector section): ON grips the closest MTBH element — it follows the gripper until OFF releases it.';
        this._simCb = el('input'); this._simCb.type = 'checkbox'; this._simCb.style.accentColor = '#2f81f7';
        this._simCb.addEventListener('change', () => this.setOutput(this._gripOutputName(), this._simCb.checked));
        simRow.append(this._simCb, el('span', 'opacity:.9;', 'Gripper output ON (simulated)'));
        wrap.append(simRow);

        const resetBtn = el('button', BTN + 'margin:2px 0 4px;', 'Reset MTBH positions');
        resetBtn.title = 'Release the gripper and return every MTBH element to its default position.';
        resetBtn.addEventListener('click', () => this.resetPositions());
        wrap.append(resetBtn);

        this._section = wrap;
        this._showCb.checked = this._showGrip;
        this._rebuildListUI();
        this._ensureGripMarker();
        return wrap;
    }

    _onAligned() {
        const it = this.active; if (!it || it.cfg.kind === 'part') return;
        it.cfg.pos = it.root.position.toArray();
        it.cfg.quat = it.root.quaternion.toArray();
        it.cfg.scale = it.root.scale.x;
        // the default (reset) pose follows Align
        const whole = it.entries.get('');
        if (whole && !whole.gripped) {
            whole.homes[0].pos.copy(it.root.position);
            whole.homes[0].quat.copy(it.root.quaternion);
            whole.homes[0].scale.copy(it.root.scale);
        }
        this._persist();
        this._refresh();
        this.sm.redraw?.();
    }

    _rebuildListUI() {
        if (!this._sel) return;
        this._sel.innerHTML = '';
        if (!this.items.length) {
            this._sel.append(el('option', OPT, '— no MTBH elements —'));
            this._body.style.display = 'none';
            this._refresh();
            return;
        }
        for (const it of this.items) {
            const o = el('option', OPT, it.cfg.kind === 'part' ? `▣ ${it.cfg.name}` : it.cfg.name);
            o.value = it.cfg.id;
            this._sel.append(o);
        }
        this._sel.value = this.activeId;
        this._refresh();
    }

    _refresh() {
        const grippedNames = this._allEntries().filter((c) => c.entry.gripped).map((c) => c.label || 'material');
        const it = this.active;
        if (this._status) {
            this._status.textContent = grippedNames.length
                ? `gripped: ${grippedNames.join(', ')}`
                : (it ? (it.cfg.kind === 'part' ? `element: ${it.cfg.name}` : `material: ${it.fileName}`)
                    : 'no MTBH elements — confirm parts on a scene object, or import a workpiece');
        }
        if (!it) { if (this._body) this._body.style.display = 'none'; return; }
        this._body.style.display = 'block';
        const isPart = it.cfg.kind === 'part';
        this._fileRows.style.display = isPart ? 'none' : 'block';
        this._srcNote.textContent = isPart ? `part of ${it.cfg.sourceFile}` : '';
        this._srcNote.style.display = isPart ? 'block' : 'none';
        if (!isPart) this._scaleIn.value = Math.round(it.root.scale.x * 10000) / 10000;
        this._massIn.value = String(it.cfg.mass || 0);
        const entry = it.entries.values().next().value;
        this._gripCb.checked = !!entry?.gripped;
        if (!isPart) {
            this._alignBtn.disabled = !!entry?.gripped;
            this._alignBtn.style.opacity = entry?.gripped ? '0.4' : '1';
            this._alignBtn.title = entry?.gripped ? 'Release the gripper first' : '';
        }
    }
}
