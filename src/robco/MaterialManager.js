/**
 * MaterialManager — the gripper side of MTBH ("material to be handled").
 *
 * Four kinds of MTBH elements live in this section's list:
 *   • kind 'part' — confirmed parts of a Scene Object (the main workflow: export the whole cell
 *     once, import it in Scene Objects, select parts, confirm "→ MTBH"). Each confirmed part is
 *     an individual element here (own mass), removed from the scene picker's list; deleting it
 *     returns the part to the picker. Elements re-bind automatically when their source file is
 *     re-imported (matched by source object id / file name).
 *   • kind 'file' — standalone workpiece imports (GLB or OBJ +MTL +textures), grippable as a
 *     whole; useful for quick tests without a full cell export.
 *   • kind 'group' — several part elements merged into ONE unit: gripped as one, animated as
 *     one, one mass. Deleting a group ungroups it (members return as individual elements).
 *   • kind 'clone' — a respawned copy (see Respawn below). Transient: never persisted, removed
 *     by "Reset MTBH positions".
 *
 * Gripping: ONE output — the End-Effector section's bank/io fields (EndEffector.gripOutputRef())
 * — is shared by every element; there are no per-part grip outputs. Output edges (live stream,
 * sim toggle, or messageLog fallback) are routed through _applyOutputEdge(): an edge on the
 * gripper's address grips the CLOSEST non-gripped element to the grip point — a configurable
 * offset (mm, relative to the gripper/tool origin, EndEffector.attachPoint()) with an optional
 * marker sphere — and that element follows the gripper while the output stays ON. Attachment is
 * THREE.Object3D.attach(): a world-pose-preserving reparent, so pickup never snaps and needs no
 * per-frame code. On the falling edge the gripped element is released in place. "Reset MTBH
 * positions" returns every element to its captured default pose.
 *
 * Animation (per element): an optional output-triggered linear move — bank/io + Δx/Δy/Δz (mm,
 * world/cell frame) + duration (s). Rising edge plays the move; the falling edge plays it in
 * REVERSE only when the element's "reverse on OFF" option is set (pneumatic-cylinder style,
 * resumable mid-travel), otherwise OFF is ignored and every rising edge moves the element
 * further from its current pose. Triggers are ignored (and a grip cancels the tween) while the
 * element hangs in the gripper.
 *
 * Respawn (per element): simulates a conveyor feeding parts. Once the element has moved beyond
 * AWAY_MM from its home pose (carried off by the gripper or pushed by an animation), a countdown
 * starts; after the configured seconds a CLONE of it appears at the home pose, inheriting mass /
 * grippability / animation / respawn — so the chain continues. The original stays wherever it
 * was placed and stops watching its slot (the clone owns it now). A per-lineage cap limits the
 * number of live clones; "Reset MTBH positions" deletes all clones.
 *
 * Live trigger, two paths (both baseline the state present at connect, acting on EDGES only):
 *   • `ingestOutputs()` — the /robot WS streams the robot's digital outputs as
 *     `{type:'outputs', data:[{bankId, ios:[bool…]}]}` on every change (50 ms controller cycle)
 *     plus once on connect; `ios` is indexed by outputId. The End-Effector's output field
 *     resolves against the session's NAMED outputs (robotConfig.outputs [{bankId, ioId, name}],
 *     fed via setIOConfigs(), case-insensitive — so the default "Gripper" just works when the
 *     robot has an output of that name) or a literal reference ("1/0" = bank 1, io 0; plain
 *     "3" = bank 0, io 3). Every output edge is console-logged, so toggling the gripper in
 *     RobCo Studio reveals which output it is.
 *   • `ingestMessages()` — fallback for named outputs the config doesn't list: flow messageLog
 *     entries of the form `output:<name>=<1|0|on|off|true|false>` route to setOutput().
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

const AWAY_MM = 80; // an element farther than this from its home pose counts as "moved away"

/** Coerce a stored/partial animation config (output-triggered linear move). */
function sanitizeAnim(a) {
    a = (a && typeof a === 'object') ? a : {};
    return {
        enabled: a.enabled === true,
        bank: Number.isFinite(+a.bank) ? Math.max(0, Math.round(+a.bank)) : 0,
        io: Number.isFinite(+a.io) ? Math.max(0, Math.round(+a.io)) : 0,
        dx: +a.dx || 0, dy: +a.dy || 0, dz: +a.dz || 0, // mm, world/cell frame
        dur: a.dur > 0 ? +a.dur : 2,                    // seconds
        reverse: a.reverse === true,                    // falling edge plays the move backward
    };
}

/** Coerce a stored/partial respawn config (clone at home after a delay). */
function sanitizeRespawn(r) {
    r = (r && typeof r === 'object') ? r : {};
    return {
        enabled: r.enabled === true,
        sec: r.sec > 0 ? +r.sec : 5,
        cap: Number.isFinite(+r.cap) && +r.cap > 0 ? Math.round(+r.cap) : 20,
    };
}

/** Coerce a stored/partial config into a complete, valid element config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        kind: ['part', 'group', 'clone'].includes(s.kind) ? s.kind : 'file',
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
        members: Array.isArray(s.members) ? s.members : null, // group only: raw member cfgs
        lineage: typeof s.lineage === 'string' ? s.lineage : '', // clone only: original element id
        anim: sanitizeAnim(s.anim),
        respawn: sanitizeRespawn(s.respawn),
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
        this.ioConfigs = []; // named outputs from robotConfig.outputs [{bankId, ioId, name}]
        this._gripActive = false; // last commanded gripper-output state (feeds the EE indicator offline)
        this._animRaf = null;     // shared rAF loop, running only while an animation is playing
        this._loadPersisted();
        // the View panel's "MTBH highlight" checkbox defaults to on — align it with our persisted state
        if (this._tintOn === false) window._robcoViewPanel?.applyState?.({ mtbhTint: false });
        if (setupPanel) setupPanel.addSection(this._buildSection(), { title: 'Material (MTBH)', key: 'material' });
        // Scene objects imported before this manager existed: bind their persisted elements now.
        for (const sit of setupPanel?.sceneObjects?.items || []) this.bindPendingParts(sit);
        // Respawn watchdog: cheap scan, only items with respawn enabled do any work.
        this._respawnTimer = setInterval(() => this._respawnTick(), 500);
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

    /** Every grip candidate as {item, entry, mass, label} — they all share the gripper's one output. */
    _allEntries() {
        const out = [];
        for (const it of this.items) {
            for (const entry of it.entries.values()) {
                out.push({ item: it, entry, mass: it.cfg.mass, label: it.cfg.name });
            }
        }
        return out;
    }

    /** The gripper's output name — owned by the End-Effector section. */
    _gripOutputName() { return this.endEffector?.gripOutputName?.() || 'Gripper'; }

    /** The gripper's output address {bank, io} — owned by the End-Effector section. */
    _gripRef() {
        return this.endEffector?.gripOutputRef?.() || this.resolveOutputRef(this._gripOutputName());
    }

    /**
     * Current state of an output for the UI indicators: the live streamed value when the WS has
     * delivered one, else the last simulated gripper state for the gripper's own address, else
     * null (unknown).
     */
    getOutputState(bank, io) {
        const live = this._outState?.get(`${bank}/${io}`);
        if (live !== undefined) return live;
        const g = this._gripRef();
        if (g && g.bank === bank && g.io === io) return !!this._gripActive;
        return null;
    }

    // --- named outputs (robotConfig.outputs) ----------------------------------
    /**
     * Ingest the session's named outputs — robotConfig.outputs [{bankId, ioId, name}] — so the
     * End-Effector's output field can hold a RobFlow output NAME (e.g. "Gripper") instead of a
     * raw bank/io. A WS robotConfig push is authoritative; liveConnect feeds the one-shot REST
     * config only for quiet sessions.
     */
    setIOConfigs(ioConfigs) {
        this.ioConfigs = Array.isArray(ioConfigs) ? ioConfigs : [];
        this._refreshOutputNames();
        window._robcoEndEffector?.refreshOutputHint?.(); // its output field may resolve by name now
    }

    /**
     * Resolve an output reference to {bank, io}: a session output name first (case-insensitive,
     * from setIOConfigs), else a literal address ("1/0", "1:0", plain "3" = bank 0, io 3).
     * Null when the name is unknown and not a literal — messageLog/sim-toggle only.
     */
    resolveOutputRef(name) {
        const want = normName(name);
        if (!want) return null;
        const cfg = this.ioConfigs.find((c) => normName(c?.name) === want);
        if (cfg) return { bank: cfg.bankId ?? 0, io: cfg.ioId ?? 0 };
        return parseOutputRef(name);
    }

    /** Refill the output-name autocomplete list (the End-Effector's output field uses it too). */
    _refreshOutputNames() {
        if (!this._nameList) return;
        this._nameList.innerHTML = '';
        for (const c of this.ioConfigs) {
            if (!c?.name) continue;
            const o = document.createElement('option');
            o.value = c.name;
            this._nameList.append(o);
        }
    }

    // --- MTBH elements from scene-object parts -------------------------------
    _elementFor(sceneItem, partName) {
        return this.items.find((it) => it.cfg.kind === 'part' && it.cfg.sourceId === sceneItem.cfg.id && it.cfg.partName === partName);
    }

    /** All elements sourced from a scene object. */
    elementsFor(sceneItem) {
        return this.items.filter((it) => it.cfg.kind === 'part' && it.cfg.sourceId === sceneItem.cfg.id);
    }

    /** Part names of a scene object that already are MTBH elements (its picker hides them) —
     *  including parts bound inside a group. */
    takenParts(sceneItem) {
        const set = new Set(this.elementsFor(sceneItem).map((it) => it.cfg.partName));
        for (const it of this.items) {
            if (it.cfg.kind !== 'group') continue;
            for (const m of it.cfg.members || []) {
                if (m.sourceId === sceneItem.cfg.id || m.sourceFile === sceneItem.fileName) set.add(m.partName);
            }
        }
        return set;
    }

    _makePartItem(cfg, sceneItem) {
        const nodes = sceneItem.nodesByName.get(cfg.partName);
        const entry = makeEntry(cfg.partName, nodes);
        tintNodes(nodes, this.getHighlight());
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

    /** A scene object finished loading: re-create its persisted MTBH elements (and any groups
     *  whose members are all available now). */
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
        bound += this._tryBindGroups();
        if (bound) {
            if (!this.activeId) this.activeId = this.items[0].cfg.id;
            this._persist();
            this._rebuildListUI();
            this.sm.redraw?.();
        }
        return bound;
    }

    // --- groups (several parts as ONE grip/animation unit) --------------------
    /** The scene object a group member config points at (by id, else by file name). */
    _sceneItemFor(mcfg) {
        const list = this.setupPanel?.sceneObjects?.items || [];
        return list.find((s) => s.cfg.id === mcfg.sourceId)
            || list.find((s) => s.fileName === mcfg.sourceFile) || null;
    }

    /** Build a group item from its config — null while any member's scene object is missing. */
    _makeGroupItem(cfg) {
        const nodes = [];
        for (const m of cfg.members || []) {
            const src = this._sceneItemFor(m);
            const list = src?.nodesByName.get(m.partName);
            if (!list?.length) return null;
            nodes.push(...list);
        }
        if (!nodes.length) return null;
        const entry = makeEntry(cfg.name, nodes);
        tintNodes(nodes, this.getHighlight());
        return { cfg, entries: new Map([['', entry]]) };
    }

    /** Persisted group configs whose members are all loadable now: bind them. */
    _tryBindGroups() {
        let bound = 0;
        for (let i = this._persistedCfgs.length - 1; i >= 0; i--) {
            const c = this._persistedCfgs[i];
            if (!c || c.kind !== 'group') continue;
            const g = this._makeGroupItem(sanitizeCfg(c, c.name));
            if (!g) continue; // some member's scene object hasn't loaded yet — keep waiting
            this._persistedCfgs.splice(i, 1);
            this.items.push(g);
            bound += 1;
        }
        return bound;
    }

    /**
     * Merge part elements into ONE group element: gripped as one, animated as one, one mass
     * (initialized to the members' sum). The members leave the list; deleting the group brings
     * them back unchanged.
     */
    groupItems(ids, name) {
        const sel = this.items.filter((it) => ids.includes(it.cfg.id) && it.cfg.kind === 'part');
        if (sel.length < 2) return false;
        for (const it of sel) {
            for (const e of it.entries.values()) {
                if (e.gripped) releaseEntry(e, it.sourceItem?.root || this._worldParent());
            }
            it._anim = null;
        }
        const cfg = sanitizeCfg({
            kind: 'group',
            name: name || 'Group',
            mass: sel.reduce((s, it) => s + (it.cfg.mass || 0), 0),
            members: sel.map((it) => it.cfg),
        }, name || 'Group');
        const g = this._makeGroupItem(cfg);
        if (!g) return false;
        this.items = this.items.filter((it) => !sel.includes(it));
        this.items.push(g);
        this.activeId = cfg.id;
        this._syncMassPayload();
        this._persist();
        this._rebuildListUI();
        this.sm.redraw?.();
        return true;
    }

    /** The source scene object was removed — its elements (parts, groups touching it, and
     *  clones spawned from it) go with it. */
    dropElementsFor(sceneItem) {
        const fromIt = (cfg) => cfg.sourceId === sceneItem.cfg.id || cfg.sourceFile === sceneItem.fileName;
        const drop = this.items.filter((it) => {
            if (it.cfg.kind === 'part' || it.cfg.kind === 'clone') return fromIt(it.cfg);
            if (it.cfg.kind === 'group') return (it.cfg.members || []).some(fromIt);
            return false;
        });
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

    /** The persisted config saved for this exact file (part/group configs are bound via
     *  bindPendingParts/_tryBindGroups, never consumed here). Order-based fallback ONLY for
     *  legacy saves without a fileName. */
    _takePersisted(fileName) {
        const files = (c) => c && (!c.kind || c.kind === 'file');
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
        } else if (it.cfg.kind === 'group') {
            // deleting a group UNGROUPS it — the members come back as individual elements
            for (const m of it.cfg.members || []) {
                const src = this._sceneItemFor(m);
                if (src?.nodesByName.has(m.partName)) {
                    this.items.push(this._makePartItem(sanitizeCfg(m, m.partName), src));
                }
            }
            this.setupPanel?.sceneObjects?.onElementsChanged?.();
        } else if (it.cfg.kind === 'clone') {
            for (const entry of it.entries.values()) {
                for (const n of entry.nodes) n.parent?.remove(n);
            }
        } else {
            it.root.parent?.remove(it.root);
        }
        // removing an original takes its respawned clones along (their lineage is orphaned)
        if (it.cfg.kind !== 'clone') {
            const orphans = this.items.filter((x) => x.cfg.kind === 'clone' && x.cfg.lineage === it.cfg.id);
            for (const o of orphans) {
                for (const entry of o.entries.values()) {
                    if (entry.gripped) releaseEntry(entry, this._worldParent());
                    for (const n of entry.nodes) n.parent?.remove(n);
                }
            }
            this.items = this.items.filter((x) => !orphans.includes(x));
        }
        if (!this.items.some((x) => x.cfg.id === this.activeId)) this.activeId = this.items[0]?.cfg.id || null;
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

    // --- grip / release / output routing --------------------------------------
    /**
     * Drive outputs by NAME — called by the sim toggle and the live message stream
     * (`output:<name>=<1|0>` messageLog entries). Resolvable references (a session output name
     * or a literal "bank/io") are routed as a full edge — gripper AND animations; an
     * unresolvable free name falls back to an exact-name match against the gripper.
     */
    setOutput(outputName, active) {
        const ref = this.resolveOutputRef(outputName);
        if (ref) { this._applyOutputEdge(ref, active); return; }
        const want = normName(outputName);
        if (want && want === normName(this._gripOutputName())) this._setGrip(active);
    }

    /**
     * Route one output edge (resolved bank/io) to everything listening on that address: the
     * gripper (End-Effector's bank/io) and every element animation triggered by it. Single
     * funnel for the live outputs stream, the sim toggles, and resolvable messageLog entries.
     */
    _applyOutputEdge(ref, active) {
        const g = this._gripRef();
        if (g && g.bank === ref.bank && g.io === ref.io) {
            this._gripActive = !!active;
            this._setGrip(active);
        }
        for (const it of this.items) {
            const a = it.cfg.anim;
            if (a?.enabled && a.bank === ref.bank && a.io === ref.io) this._animEdge(it, active);
        }
        window._robcoEndEffector?.refreshOutputState?.();
        this._refreshAnimDot();
    }

    /**
     * Rising edge: grip the closest non-gripped element to the grip point (hold if one is
     * already gripped); it follows the gripper while the output stays ON. Falling edge:
     * release in place.
     */
    _setGrip(active) {
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
            // a live grip cancels an in-progress Align edit — its persist callback would
            // otherwise write gripper-local coordinates into the world-frame cfg
            if (this.setupPanel?._editing === 'material') this.setupPanel._stopEdit();
            // the gripper takes over the nodes — a running tween would fight the reparent
            best.item._anim = null;
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
            if (this.setupPanel?._editing === 'material') this.setupPanel._stopEdit();
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

    // --- object animation -------------------------------------------------
    /**
     * An edge arrived on an element's animation trigger. Rising edge plays the configured move;
     * the falling edge plays it backward only in reverse mode ("reverse on OFF"), else it's
     * ignored. Reverse mode is resumable mid-travel (pneumatic-cylinder style); one-shot mode
     * re-captures from the current pose on every rising edge, so repeated triggers keep moving
     * the element further. Ignored while the element hangs in the gripper.
     */
    _animEdge(item, rising) {
        const a = item.cfg.anim;
        if (!a?.enabled) return;
        const entry = item.entries.values().next().value;
        if (!entry?.nodes.length || entry.gripped) return;
        const st = item._anim || (item._anim = { t: 0, dir: 0, cap: null });
        if (rising) {
            // (re)capture when starting fresh; a reverse-mode element resumes its captured span
            if (!a.reverse || !st.cap || st.t <= 0) this._animCapture(item, st);
            st.dir = 1;
        } else {
            if (!a.reverse || !st.cap) return;
            st.dir = -1;
        }
        st.last = performance.now();
        this._animLoopStart();
    }

    /** Freeze the move: per node, current local position + the world-frame delta converted into
     *  the node's parent frame (handles rotated/scaled ancestors, e.g. cm-scale cell imports). */
    _animCapture(item, st) {
        const a = item.cfg.anim;
        const entry = item.entries.values().next().value;
        const delta = new THREE.Vector3(a.dx / 1000, a.dy / 1000, a.dz / 1000); // mm -> m, world frame
        this.sm.scene.updateMatrixWorld(true);
        st.cap = entry.nodes.map((n) => {
            const from = n.position.clone();
            const target = n.getWorldPosition(new THREE.Vector3()).add(delta);
            const to = n.parent ? n.parent.worldToLocal(target) : target;
            return { n, from, move: to.sub(from) };
        });
        st.t = 0;
    }

    /** Shared rAF loop — runs only while at least one element is tweening. */
    _animLoopStart() {
        if (this._animRaf) return;
        const tick = () => {
            this._animRaf = null;
            const now = performance.now();
            let playing = false;
            for (const it of this.items) {
                const st = it._anim;
                if (!st || !st.dir || !st.cap) continue;
                const dt = (now - st.last) / 1000;
                st.last = now;
                st.t = Math.min(1, Math.max(0, st.t + (st.dir * dt) / Math.max(0.05, it.cfg.anim.dur)));
                for (const c of st.cap) c.n.position.copy(c.from).addScaledVector(c.move, st.t);
                if (st.t <= 0 || st.t >= 1) {
                    st.dir = 0;
                    if (!it.cfg.anim.reverse) st.cap = null; // one-shot: next edge re-captures from here
                } else {
                    playing = true;
                }
            }
            this.sm.redraw?.();
            if (playing) this._animRaf = requestAnimationFrame(tick);
        };
        this._animRaf = requestAnimationFrame(tick);
    }

    /** Return every MTBH element to its captured default pose; respawned clones are deleted. */
    resetPositions() {
        const clones = this.items.filter((it) => it.cfg.kind === 'clone');
        for (const it of clones) {
            for (const e of it.entries.values()) {
                for (const n of e.nodes) n.parent?.remove(n);
            }
        }
        if (clones.length) {
            this.items = this.items.filter((it) => it.cfg.kind !== 'clone');
            if (!this.items.some((it) => it.cfg.id === this.activeId)) this.activeId = this.items[0]?.cfg.id || null;
        }
        for (const it of this.items) {
            it.cfg.gripped = false;
            it._anim = null;       // stop tweens; resetEntry restores the home pose anyway
            it._awaySince = null;  // re-arm the respawn watch
            it._spawned = false;
        }
        for (const { entry } of this._allEntries()) resetEntry(entry);
        this._syncMassPayload();
        this._rebuildListUI();
        this.sm.redraw?.();
    }

    // --- respawn (clone at home) -------------------------------------------
    /**
     * Watchdog (500 ms): an element with respawn enabled that sits farther than AWAY_MM from its
     * home pose starts a countdown; after cfg.respawn.sec a clone of it appears at home and takes
     * over the slot (the original stops watching — the clone inherits the respawn config, so the
     * chain continues). Returning home before the timer fires cancels the countdown.
     */
    _respawnTick() {
        let spawned = false;
        const now = performance.now();
        const pos = new THREE.Vector3();
        const home = new THREE.Vector3();
        for (const it of [...this.items]) {
            const r = it.cfg.respawn;
            if (!r?.enabled || it._spawned) continue;
            const entry = it.entries.values().next().value;
            const h = entry?.homes?.[0];
            if (!entry?.nodes.length || !h?.parent) continue;
            h.parent.updateMatrixWorld(true);
            home.copy(h.pos).applyMatrix4(h.parent.matrixWorld);
            entry.nodes[0].getWorldPosition(pos);
            if (pos.distanceTo(home) <= AWAY_MM / 1000) { it._awaySince = null; continue; }
            if (!it._awaySince) { it._awaySince = now; continue; }
            if (now - it._awaySince < r.sec * 1000) continue;
            if (this._cloneCount(it) >= r.cap) { it._awaySince = now; continue; } // full — retry later
            this._spawnClone(it);
            it._spawned = true; // the clone owns the home slot now
            spawned = true;
        }
        if (spawned) {
            this._rebuildListUI();
            this.sm.redraw?.();
        }
    }

    /** Live clones descended from this element's lineage (the original counts as #1, not a clone). */
    _cloneCount(it) {
        const root = it.cfg.lineage || it.cfg.id;
        return this.items.filter((x) => x.cfg.kind === 'clone' && x.cfg.lineage === root).length;
    }

    /** Deep-clone the element's nodes at their home pose — a fresh, independent MTBH element that
     *  inherits mass, grippability, animation and respawn. Clones are transient (not persisted). */
    _spawnClone(src) {
        const entry = src.entries.values().next().value;
        const root = src.cfg.lineage || src.cfg.id;
        const cfg = sanitizeCfg({
            ...src.cfg,
            id: newId(),
            kind: 'clone',
            lineage: root,
            name: `${src.cfg.name.replace(/ #\d+$/, '')} #${this._cloneCount(src) + 2}`,
            members: null,
        }, src.cfg.name);
        const nodes = entry.nodes.map((node, i) => {
            const c = node.clone(true);
            const h = entry.homes[i];
            (h?.parent || this._worldParent()).add(c);
            if (h) { c.position.copy(h.pos); c.quaternion.copy(h.quat); c.scale.copy(h.scale); }
            return c;
        });
        const item = { cfg, fileName: src.fileName, entries: new Map([['', makeEntry(cfg.name, nodes)]]) };
        this.items.push(item);
        console.log(`[RobCo] respawned "${cfg.name}" at home (${this._cloneCount(src)}/${src.cfg.respawn.cap} clones)`);
    }

    // --- live RobFlow digital outputs -----------------------------------------
    /**
     * The WS (re)connected: drop the edge/backlog baselines so the next frames re-baseline.
     * A reconnect re-delivers the outputs snapshot and the cumulative messageLog — connect-time
     * state must never be acted on (a gripper edge from the disconnect gap would otherwise
     * grip/release at whatever pose the arm has NOW).
     */
    resetLiveBaselines() {
        this._outState = null;
        this._msgSeen = null;
    }

    /**
     * Feed a `{type:'outputs'}` WS payload: `[{bankId, ios:[bool…]}, …]`. The state present in
     * the first frame is baselined (never acted on); afterwards every edge is logged — toggle
     * the gripper in RobCo Studio and the console shows which bank/io it is — and an edge on
     * the End-Effector's configured output (a session output name like "Gripper", or a literal
     * "1/0") grips/releases.
     */
    ingestOutputs(data) {
        if (!Array.isArray(data)) return;
        const cur = new Map(); // 'bank/io' -> bool
        for (const b of data) {
            const ios = Array.isArray(b?.ios) ? b.ios : [];
            for (let i = 0; i < ios.length; i++) cur.set(`${b.bankId ?? 0}/${i}`, !!ios[i]);
        }
        if (!this._outState) {
            this._outState = cur;
            window._robcoEndEffector?.refreshOutputState?.(); // indicator can show real state now
            return;
        }
        const g = this._gripRef();
        const watched = g ? `${g.bank}/${g.io}` : null;
        const edges = [];
        for (const [key, val] of cur) {
            const prev = this._outState.get(key);
            if (prev === undefined || prev === val) continue;
            console.log(`[RobCo] output ${key} -> ${val ? 'ON' : 'OFF'}${key === watched ? ' (gripper)' : ''}`);
            const m = /^(\d+)\/(\d+)$/.exec(key);
            if (m) edges.push({ ref: { bank: +m[1], io: +m[2] }, val });
        }
        this._outState = cur; // update BEFORE dispatch so indicators read the fresh state
        for (const e of edges) this._applyOutputEdge(e.ref, e.val);
        if (!edges.length) window._robcoEndEffector?.refreshOutputState?.();
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
            if (typeof s?.tint === 'boolean') this._tintOn = s.tint;
        } catch { this._persistedCfgs = []; }
    }

    _persist() {
        try {
            // Part/group configs still waiting for their scene object must survive the save;
            // respawned clones are transient and never saved.
            const pending = (this._persistedCfgs || []).filter((c) => c && (c.kind === 'part' || c.kind === 'group'));
            localStorage.setItem(KEY, JSON.stringify({
                items: [
                    ...this.items.filter((it) => it.cfg.kind !== 'clone').map((it) => it.cfg),
                    ...pending,
                ],
                showGrip: this._showGrip,
                tint: this._tintOn !== false,
            }));
        } catch { /* ignore */ }
    }

    // --- MTBH highlight (blue emissive tint on confirmed parts/groups) --------
    /** Whether MTBH elements are marked blue in the viewport (View panel toggle). */
    getHighlight() { return this._tintOn !== false; }

    /** Turn the blue MTBH marking on/off for every part/group element (persisted). */
    setHighlight(on) {
        this._tintOn = !!on;
        for (const it of this.items) {
            if (it.cfg.kind !== 'part' && it.cfg.kind !== 'group') continue;
            for (const e of it.entries.values()) tintNodes(e.nodes, this._tintOn);
        }
        this._persist();
        this.sm.redraw?.();
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
        const grpBtn = el('button', ICON_BTN, '⧉');
        grpBtn.title = 'Group part elements into ONE unit — gripped and animated as one object';
        grpBtn.addEventListener('click', () => this._toggleGroupChooser());
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this element (a part returns to its picker; deleting a group ungroups it)';
        delBtn.addEventListener('click', () => { if (this.activeId) this.removeItem(this.activeId); });
        listRow.append(this._sel, addBtn, dirBtn, grpBtn, delBtn);
        wrap.append(listRow);
        this._grpAnchor = listRow; // the group chooser opens right under the list

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

        // rename the active element (list label, grip log, takt-diagram links all follow)
        const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        nameRow.append(el('span', 'width:64px;opacity:.8;', 'name'));
        this._nameIn = el('input', 'flex:1;min-width:0;background:rgba(255,255,255,0.08);' +
            'border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;padding:2px 6px;font:inherit;');
        this._nameIn.type = 'text';
        this._nameIn.addEventListener('change', () => {
            const it = this.active;
            if (!it) return;
            const v = this._nameIn.value.trim();
            if (!v) { this._nameIn.value = it.cfg.name; return; }
            it.cfg.name = v;
            this._persist();
            this._rebuildListUI();
        });
        nameRow.append(this._nameIn);
        body.append(nameRow);

        this._srcNote = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', '');
        body.append(this._srcNote);

        // file-item-only rows (a part element is aligned via its scene object)
        this._fileRows = el('div');
        const alignRow = el('div', 'display:flex;gap:6px;margin:2px 0;align-items:center;');
        this._alignBtn = el('button', BTN, 'Align');
        this._alignBtn.addEventListener('click', () => {
            const it = this.active;
            if (!it || it.cfg.kind !== 'file') return;
            this.setupPanel?._edit('material', it.root, ['translate', 'rotate', 'scale'], () => this._onAligned());
        });
        const yupBtn = el('button', BTN, 'Y-up→Z-up');
        yupBtn.addEventListener('click', () => {
            const it = this.active; if (!it || it.cfg.kind !== 'file') return;
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
            const it = this.active; if (!it || it.cfg.kind !== 'file') return;
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

        const subhdr = (t) => el('div',
            'font-weight:600;font-size:10px;opacity:.85;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.04em;', t);
        const numIn = (w, step, min, title, onChange) => {
            const inp = el('input', NUM.replace('width:52px', `width:${w}px`));
            inp.type = 'number'; inp.step = String(step); if (min != null) inp.min = String(min);
            if (title) inp.title = title;
            inp.addEventListener('change', onChange);
            return inp;
        };
        const saveAnim = () => { this._readAnimUI(); this._persist(); };

        // ---- Animation: output-triggered linear move --------------------
        body.append(subhdr('Animation'));
        const anEnRow = el('label', 'display:flex;align-items:center;gap:8px;margin:3px 0;cursor:pointer;');
        anEnRow.title = 'Move this element when a robot output switches: ON plays the move (Δ in world/cell mm ' +
            'over the duration); OFF plays it backward when "reverse on OFF" is set, else OFF is ignored.';
        this._anEnCb = el('input'); this._anEnCb.type = 'checkbox'; this._anEnCb.style.accentColor = '#2f81f7';
        this._anEnCb.addEventListener('change', () => { saveAnim(); this._updateAnimRows(); });
        anEnRow.append(this._anEnCb, el('span', 'opacity:.9;', 'Animate on output'));
        body.append(anEnRow);

        this._animRows = el('div');
        const anIoRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        anIoRow.append(el('span', 'width:64px;opacity:.8;', 'trigger'));
        this._anBank = numIn(34, 1, 0, 'output bank id', saveAnim);
        this._anIo = numIn(34, 1, 0, 'output id within the bank', saveAnim);
        this._anDot = el('span', 'font:600 10px ui-monospace,monospace;border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:5px;padding:2px 7px;min-width:20px;text-align:center;', '—');
        this._anDot.title = 'current state of the trigger output';
        anIoRow.append(el('span', 'opacity:.6;', 'bank'), this._anBank, el('span', 'opacity:.6;', 'io'), this._anIo, this._anDot);
        this._animRows.append(anIoRow);

        const anMoveRow = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
        anMoveRow.append(el('span', 'width:64px;opacity:.8;', 'Δ x y z mm'));
        this._anDx = numIn(52, 10, null, 'move in world X (mm)', saveAnim);
        this._anDy = numIn(52, 10, null, 'move in world Y (mm)', saveAnim);
        this._anDz = numIn(52, 10, null, 'move in world Z (mm)', saveAnim);
        anMoveRow.append(this._anDx, this._anDy, this._anDz);
        this._animRows.append(anMoveRow);

        const anTimeRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        anTimeRow.append(el('span', 'width:64px;opacity:.8;', 'time s'));
        this._anDur = numIn(52, 0.1, 0.05, 'duration of the move (seconds)', saveAnim);
        const anRevLbl = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;');
        anRevLbl.title = 'OFF edge plays the move backward over the same duration (pneumatic-cylinder style). ' +
            'Unchecked: OFF is ignored — every ON moves the element further.';
        this._anRevCb = el('input'); this._anRevCb.type = 'checkbox'; this._anRevCb.style.accentColor = '#2f81f7';
        this._anRevCb.addEventListener('change', saveAnim);
        anRevLbl.append(this._anRevCb, el('span', 'opacity:.9;', 'reverse on OFF'));
        anTimeRow.append(this._anDur, anRevLbl);
        this._animRows.append(anTimeRow);

        const anSimRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        anSimRow.append(el('span', 'width:64px;opacity:.8;', 'simulate'));
        const anOn = el('button', BTN, '▶ ON');
        anOn.title = 'Simulate a rising edge on the trigger output';
        anOn.addEventListener('click', () => {
            const a = this.active?.cfg.anim;
            if (a?.enabled) this._applyOutputEdge({ bank: a.bank, io: a.io }, true);
        });
        const anOff = el('button', BTN, '◀ OFF');
        anOff.title = 'Simulate a falling edge (plays the move backward in reverse mode)';
        anOff.addEventListener('click', () => {
            const a = this.active?.cfg.anim;
            if (a?.enabled) this._applyOutputEdge({ bank: a.bank, io: a.io }, false);
        });
        anSimRow.append(anOn, anOff);
        this._animRows.append(anSimRow);
        body.append(this._animRows);

        // ---- Respawn: clone at home after a delay ------------------------
        body.append(subhdr('Respawn'));
        const rsEnRow = el('label', 'display:flex;align-items:center;gap:8px;margin:3px 0;cursor:pointer;');
        rsEnRow.title = 'Once this element has been moved away from its home position (e.g. carried off by the ' +
            'gripper), a fresh copy appears at home after the delay — like a conveyor feeding new parts. ' +
            '"Reset MTBH positions" removes all copies.';
        this._rsEnCb = el('input'); this._rsEnCb.type = 'checkbox'; this._rsEnCb.style.accentColor = '#2f81f7';
        this._rsEnCb.addEventListener('change', () => { this._readRespawnUI(); this._persist(); this._updateRespawnRows(); });
        rsEnRow.append(this._rsEnCb, el('span', 'opacity:.9;', 'Respawn when moved away'));
        body.append(rsEnRow);

        this._respawnRows = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        this._respawnRows.append(el('span', 'width:64px;opacity:.8;', 'after s'));
        this._rsSec = numIn(52, 0.5, 0.5, 'seconds after the element left home until the copy appears',
            () => { this._readRespawnUI(); this._persist(); });
        this._rsCap = numIn(46, 1, 1, 'maximum number of live copies of this element',
            () => { this._readRespawnUI(); this._persist(); });
        this._rsCount = el('span', 'opacity:.55;font-size:10px;', '');
        this._respawnRows.append(this._rsSec, el('span', 'opacity:.6;', 'max'), this._rsCap, this._rsCount);
        body.append(this._respawnRows);

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
        simRow.title = 'Simulate the gripper output (bank/io set in the End-Effector section): ON grips the closest MTBH element — it follows the gripper until OFF releases it.';
        this._simCb = el('input'); this._simCb.type = 'checkbox'; this._simCb.style.accentColor = '#2f81f7';
        this._simCb.addEventListener('change', () => this.setOutput(this._gripOutputName(), this._simCb.checked));
        simRow.append(this._simCb, el('span', 'opacity:.9;', 'Gripper output ON (simulated)'));
        wrap.append(simRow);

        const resetBtn = el('button', BTN + 'margin:2px 0 4px;', 'Reset MTBH positions');
        resetBtn.title = 'Release the gripper and return every MTBH element to its default position.';
        resetBtn.addEventListener('click', () => this.resetPositions());
        wrap.append(resetBtn);

        // shared autocomplete of the session's output names (End-Effector's output field
        // references it by id); ioConfigs may have arrived before the panel was built
        this._nameList = el('datalist');
        this._nameList.id = 'robco-output-names';
        wrap.append(this._nameList);

        this._section = wrap;
        this._showCb.checked = this._showGrip;
        this._rebuildListUI();
        this._ensureGripMarker();
        this._refreshOutputNames();
        return wrap;
    }

    _onAligned() {
        const it = this.active; if (!it || it.cfg.kind !== 'file') return;
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
        const ICONS = { part: '▣ ', group: '⧉ ', clone: '↻ ', file: '' };
        for (const it of this.items) {
            const o = el('option', OPT, `${ICONS[it.cfg.kind] || ''}${it.cfg.name}`);
            o.value = it.cfg.id;
            this._sel.append(o);
        }
        this._sel.value = this.activeId;
        this._refresh();
    }

    /** Store the animation inputs into the active element's config. */
    _readAnimUI() {
        const it = this.active;
        if (!it) return;
        it.cfg.anim = sanitizeAnim({
            enabled: this._anEnCb.checked,
            bank: +this._anBank.value, io: +this._anIo.value,
            dx: +this._anDx.value, dy: +this._anDy.value, dz: +this._anDz.value,
            dur: +this._anDur.value,
            reverse: this._anRevCb.checked,
        });
        it._anim = null; // config changed — drop a stale capture
        this._refreshAnimDot();
    }

    /** Store the respawn inputs into the active element's config. */
    _readRespawnUI() {
        const it = this.active;
        if (!it) return;
        it.cfg.respawn = sanitizeRespawn({
            enabled: this._rsEnCb.checked,
            sec: +this._rsSec.value,
            cap: +this._rsCap.value,
        });
        it._awaySince = null; // re-time from the new settings
    }

    _updateAnimRows() {
        if (this._animRows) this._animRows.style.display = this.active?.cfg.anim?.enabled ? 'block' : 'none';
    }

    _updateRespawnRows() {
        if (this._respawnRows) this._respawnRows.style.display = this.active?.cfg.respawn?.enabled ? 'flex' : 'none';
    }

    /** Live/sim state of the active element's animation trigger output. */
    _refreshAnimDot() {
        if (!this._anDot) return;
        const a = this.active?.cfg.anim;
        const st = a ? this.getOutputState(a.bank, a.io) : null;
        const known = st === true || st === false;
        this._anDot.textContent = known ? (st ? 'ON' : 'OFF') : '—';
        this._anDot.style.color = st === true ? '#3fb950' : 'rgba(230,237,243,0.55)';
        this._anDot.style.borderColor = st === true ? '#3fb950' : 'rgba(255,255,255,0.15)';
        this._anDot.style.background = st === true ? 'rgba(63,185,80,0.2)' : 'transparent';
    }

    /** Open/close the inline chooser that merges part elements into a group. */
    _toggleGroupChooser() {
        if (this._grpBox) { this._grpBox.remove(); this._grpBox = null; return; }
        const box = el('div', 'border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 8px;margin:4px 0;');
        const parts = this.items.filter((it) => it.cfg.kind === 'part');
        if (parts.length < 2) {
            box.append(el('div', 'font-size:11px;color:#f0b72f;',
                'Grouping needs at least two part elements — confirm parts on a scene object first.'));
        } else {
            box.append(el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;',
                'Merge the selected parts into ONE object (gripped + animated as one):'));
            const cbs = [];
            for (const it of parts) {
                const row = el('label', 'display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer;');
                const cb = el('input');
                cb.type = 'checkbox'; cb.style.accentColor = '#2f81f7'; cb.value = it.cfg.id;
                row.append(cb, el('span', 'opacity:.9;', it.cfg.name));
                box.append(row);
                cbs.push(cb);
            }
            const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin:6px 0 2px;');
            const nameIn = el('input', 'flex:1;min-width:0;background:rgba(255,255,255,0.08);' +
                'border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;padding:2px 6px;font:inherit;');
            nameIn.type = 'text'; nameIn.placeholder = 'group name';
            const okBtn = el('button', BTN, 'Group');
            okBtn.addEventListener('click', () => {
                const ids = cbs.filter((c) => c.checked).map((c) => c.value);
                if (ids.length < 2) { this._status.textContent = 'select at least two parts to group'; return; }
                this.groupItems(ids, nameIn.value.trim() || 'Group');
                this._toggleGroupChooser();
            });
            const noBtn = el('button', BTN, 'Cancel');
            noBtn.addEventListener('click', () => this._toggleGroupChooser());
            nameRow.append(nameIn, okBtn, noBtn);
            box.append(nameRow);
        }
        this._grpAnchor.after(box);
        this._grpBox = box;
    }

    _refresh() {
        const grippedNames = this._allEntries().filter((c) => c.entry.gripped).map((c) => c.label || 'material');
        const it = this.active;
        if (this._status) {
            this._status.textContent = grippedNames.length
                ? `gripped: ${grippedNames.join(', ')}`
                : (it ? (it.cfg.kind === 'file' ? `material: ${it.fileName}` : `element: ${it.cfg.name}`)
                    : 'no MTBH elements — confirm parts on a scene object, or import a workpiece');
        }
        if (!it) { if (this._body) this._body.style.display = 'none'; return; }
        this._body.style.display = 'block';
        if (this._nameIn) this._nameIn.value = it.cfg.name;
        const kind = it.cfg.kind;
        this._fileRows.style.display = kind === 'file' ? 'block' : 'none';
        const note = kind === 'part' ? `part of ${it.cfg.sourceFile}`
            : kind === 'group' ? `group of ${(it.cfg.members || []).length} parts`
                : kind === 'clone' ? 'respawned copy' : '';
        this._srcNote.textContent = note;
        this._srcNote.style.display = note ? 'block' : 'none';
        if (kind === 'file') this._scaleIn.value = Math.round(it.root.scale.x * 10000) / 10000;
        this._massIn.value = String(it.cfg.mass || 0);
        const entry = it.entries.values().next().value;
        this._gripCb.checked = !!entry?.gripped;
        if (kind === 'file') {
            this._alignBtn.disabled = !!entry?.gripped;
            this._alignBtn.style.opacity = entry?.gripped ? '0.4' : '1';
            this._alignBtn.title = entry?.gripped ? 'Release the gripper first' : '';
        }
        // animation + respawn settings of the active element
        const a = it.cfg.anim;
        this._anEnCb.checked = !!a.enabled;
        this._anBank.value = String(a.bank);
        this._anIo.value = String(a.io);
        this._anDx.value = String(a.dx);
        this._anDy.value = String(a.dy);
        this._anDz.value = String(a.dz);
        this._anDur.value = String(a.dur);
        this._anRevCb.checked = !!a.reverse;
        this._updateAnimRows();
        this._refreshAnimDot();
        const r = it.cfg.respawn;
        this._rsEnCb.checked = !!r.enabled;
        this._rsSec.value = String(r.sec);
        this._rsCap.value = String(r.cap);
        this._rsCount.textContent = r.enabled ? `${this._cloneCount(it)} live` : '';
        this._updateRespawnRows();
    }
}
