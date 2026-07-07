/**
 * EndEffector — tool-changer simulation. Import tool models (GLB or OBJ +MTL +textures); at any
 * time AT MOST ONE tool is attached to the flange, every other tool is PARKED in the cell at its
 * dock pose (world/cell frame, so docks move with the Base placement). A tool change never
 * deletes anything: the outgoing tool is left exactly where the change happened (that spot
 * becomes its dock if it never had one — simulating the docking station), the incoming tool
 * snaps onto the flange with its correction transform. "Reset tool positions" re-attaches the
 * home tool and returns all others to their docks — the tool-side twin of "Reset MTBH positions".
 *
 * Live: RobFlow's robotConfig lists the configured tools ({uuid, name, tcp, …}) and
 * selectedToolUuid; the `tool` message streams selection changes. Each imported model can be
 * assigned a RobFlow tool NAME (picker fed by the live list) — when the robot selects that tool,
 * the viewer performs the same change. Selecting a RobFlow tool with no assigned model (or
 * "no tool") parks the current model.
 *
 * The "changer" slot holds a model for the no-tool state — e.g. the tool-changer master plate
 * that is bolted to the flange permanently. It is always attached and stays visible under any
 * tool, connecting flange and tool visually.
 *
 * Only the ATTACHED tool's mass + CoM feed the dynamics as the 'gripper' payload source, and its
 * tip can act as TCP (editable flange->tip offset routed into the TeachPendant). The `output`
 * field names the ONE digital output that closes the gripper for MTBH gripping ("1/0" = bank/io,
 * see MaterialManager). `attachPoint()` = attached tool's mount, else the changer, else the bare
 * flange — whatever gripped material should rigidly follow.
 */
import * as THREE from 'three';
import { parseOutputRef } from './mtbhEntry.js';

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
const TEXT = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 6px;font:inherit;';
const OPT = 'background:#0d1117;color:#e6edf3;';
const HINT = 'font-size:10px;color:#6e7681;margin:1px 0 4px;';

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

const normName = (s) => String(s || '').trim().toLowerCase();

/** Coerce a stored/partial config into a complete, valid tool config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    const corr = (s.correction && typeof s.correction === 'object') ? s.correction : {};
    const dock = (s.dock && Array.isArray(s.dock.pos) && s.dock.pos.length === 3
        && Array.isArray(s.dock.quat) && s.dock.quat.length === 4)
        ? { pos: s.dock.pos.map((v) => +v || 0), quat: s.dock.quat.map((v) => +v || 0) }
        : null;
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Tool'),
        fileName: typeof s.fileName === 'string' ? s.fileName : '',
        rfName: typeof s.rfName === 'string' ? s.rfName : '',
        isChanger: !!s.isChanger,
        mass: typeof s.mass === 'number' && s.mass >= 0 ? s.mass : 0,
        tcpOffsetMm: Array.isArray(s.tcpOffsetMm) && s.tcpOffsetMm.length === 3
            ? s.tcpOffsetMm.map((v) => +v || 0) : [0, 0, 0],
        // where THIS gripper grabs, relative to its mount — each end-effector has its own
        gripPointMm: Array.isArray(s.gripPointMm) && s.gripPointMm.length === 3
            ? s.gripPointMm.map((v) => +v || 0) : [0, 0, 0],
        toolTipIsTcp: !!s.toolTipIsTcp,
        correction: {
            pos: Array.isArray(corr.pos) && corr.pos.length === 3 ? corr.pos.map((v) => +v || 0) : [0, 0, 0],
            euler: Array.isArray(corr.euler) && corr.euler.length === 3 ? corr.euler.map((v) => +v || 0) : [0, 0, 0],
        },
        dock, // world-frame park pose; null until the tool is parked/aligned the first time
        // changer only: coupling offset (m, flange frame) — attached tools mount shifted by
        // this, since the changer plate sits between flange and tool
        toolOffset: Array.isArray(s.toolOffset) && s.toolOffset.length === 3
            ? s.toolOffset.map((v) => +v || 0) : [0, 0, 0],
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
        this.tools = []; // { cfg, mount, glb, sources, fileName, com }
        this.attachedId = null; // tool currently on the flange (runtime truth, persisted)
        this.homeId = null;     // tool that "Reset tool positions" re-attaches (user-designated)
        this.editId = null;     // picker selection (which tool the fields edit)
        this._rfTools = [];     // last robotConfig tool list ({uuid, name}) for the name picker
        this._loadPersisted();
        if (setupPanel) setupPanel.addSection(this._buildSection(), { title: 'End-Effector', key: 'endeffector' });
    }

    update({ sm, model, teach, setupPanel }) {
        const flangeChanged = model && model !== this.model;
        if (sm) this.sm = sm;
        if (model) this.model = model;
        if (teach) this.teach = teach;
        if (setupPanel && setupPanel !== this.setupPanel) {
            this.setupPanel = setupPanel;
            setupPanel.addSection(this._section || this._buildSection(), { title: 'End-Effector', key: 'endeffector' });
        }
        if (flangeChanged) this._reparentAll();
    }

    get attached() { return this.tools.find((t) => t.cfg.id === this.attachedId) || null; }

    get changer() { return this.tools.find((t) => t.cfg.isChanger) || null; }

    get edited() { return this.tools.find((t) => t.cfg.id === this.editId) || null; }

    /** Attach point for anything that should ride the gripper (e.g. gripped material). */
    attachPoint() {
        return this.attached?.mount || this.changer?.mount || this._flange();
    }

    /** The ONE output that closes this gripper — MaterialManager grips the closest MTBH
     *  element while it is ON. All parts share it; there are no per-part outputs. */
    gripOutputName() { return this.gripOutput || 'Gripper'; }

    /** Grip point of the CURRENT gripper (mm, relative to attachPoint) — per tool, so every
     *  end-effector keeps its own; the changer's applies when no tool is attached. */
    gripPointMm() {
        const t = this.attached || this.changer;
        return t?.cfg.gripPointMm || [0, 0, 0];
    }

    _flange() {
        const nodes = this.model?.userData?.moduleNodes || [];
        if (nodes.length) {
            const last = nodes[nodes.length - 1];
            return last.getDistalLink?.() || last.distal;
        }
        return this.model?.threeObject;
    }

    /** Cell/world frame for parked tools — docks move with the Base placement, like MTBH homes. */
    _world() {
        return window._robcoBaseFrame?.worldGroup || this.sm?.world || this.sm?.scene;
    }

    /** Re-parent flange-mounted tools onto the (new) flange after a live-session model rebuild.
     *  Parked tools live in the world group and are unaffected. */
    _reparentAll() {
        const flange = this._flange();
        if (!flange) return;
        for (const t of this.tools) {
            if (t.cfg.isChanger || t.cfg.id === this.attachedId) flange.add(t.mount);
        }
        this._applyToolTip();
        this._recomputeCoM();
        window._robcoMaterialManager?.onAttachPointChanged?.();
    }

    // --- tool change (the core of the docking simulation) -----------------
    /** Coupling offset of the changer plate (attached tools mount shifted by it). */
    _changerOffset() {
        return this.changer?.cfg.toolOffset || null;
    }

    _applyMountAttached(t) {
        t.mount.position.fromArray(t.cfg.correction.pos);
        t.mount.rotation.set(...t.cfg.correction.euler);
        const off = t.cfg.isChanger ? null : this._changerOffset();
        if (off) t.mount.position.add(new THREE.Vector3().fromArray(off));
    }

    /** Park a tool where it currently is; that spot becomes its dock if it never had one. */
    _parkInPlace(t) {
        this._world().attach(t.mount); // world pose preserved — the tool stays put visually
        if (!t.cfg.dock) {
            t.cfg.dock = { pos: t.mount.position.toArray(), quat: t.mount.quaternion.toArray() };
        }
    }

    _parkAtDock(t) {
        const w = this._world();
        w.add(t.mount);
        if (!t.cfg.dock) t.cfg.dock = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
        t.mount.position.fromArray(t.cfg.dock.pos);
        t.mount.quaternion.fromArray(t.cfg.dock.quat);
    }

    /**
     * Attach `id` (or null = no tool) to the flange. The outgoing tool is parked in place
     * (docking station); any gripped MTBH part is released in place first — a tool change
     * with a held part would otherwise teleport it to the new tool.
     */
    toolChange(id) {
        if (id === this.attachedId) return;
        const flange = this._flange();
        if (!flange) return;
        if (this.setupPanel?._editing === 'endeffector') this.setupPanel._stopEdit();
        window._robcoMaterialManager?.releaseAll?.();
        const cur = this.attached;
        if (cur) this._parkInPlace(cur);
        const next = id ? this.tools.find((t) => t.cfg.id === id && !t.cfg.isChanger) : null;
        if (next) {
            flange.add(next.mount);
            this._applyMountAttached(next);
        }
        this.attachedId = next ? next.cfg.id : null;
        this.editId = this.attachedId || this.editId;
        this._applyToolTip();
        this._recomputeCoM();
        window._robcoMaterialManager?.onAttachPointChanged?.();
        this._persist();
        this._rebuildToolsUI();
        this.sm.redraw?.();
    }

    /** Reset: home tool back on the flange, every other tool at its dock (twin of MTBH reset). */
    resetToolPositions() {
        const flange = this._flange();
        if (!flange) return;
        window._robcoMaterialManager?.releaseAll?.();
        for (const t of this.tools) {
            if (t.cfg.isChanger) continue;
            if (t.cfg.id === this.homeId) {
                flange.add(t.mount);
                this._applyMountAttached(t);
            } else {
                this._parkAtDock(t);
            }
        }
        this.attachedId = this.homeId;
        this._applyToolTip();
        this._recomputeCoM();
        window._robcoMaterialManager?.onAttachPointChanged?.();
        this._persist();
        this._rebuildToolsUI();
        this.sm.redraw?.();
    }

    // --- live RobFlow tool selection ---------------------------------------
    /** robotConfig arrived: remember the tool library (feeds the name picker) and mirror the
     *  current selection. */
    onRobflowConfig(cfg) {
        this._rfTools = (cfg?.tools || []).filter((t) => t && t.uuid);
        this._refreshRfDatalist();
        if (cfg && 'selectedToolUuid' in cfg) this._applyRfSelection(cfg.selectedToolUuid);
    }

    /** `tool` message: the robot switched tools. */
    onRobflowTool(uuid) { this._applyRfSelection(uuid ?? null); }

    _applyRfSelection(uuid) {
        if (!uuid) { this.toolChange(null); return; } // "no tool" — park whatever we hold
        const name = this._rfTools.find((t) => t.uuid === uuid)?.name;
        if (!name) return; // unknown uuid — the matching robotConfig hasn't arrived yet
        const target = this.tools.find((t) => !t.cfg.isChanger && normName(t.cfg.rfName) === normName(name));
        if (!target) {
            console.log(`[RobCo] tool change to "${name}" — no imported model assigned to that name; parking current tool`);
            this.toolChange(null);
            return;
        }
        this.toolChange(target.cfg.id);
    }

    _refreshRfDatalist() {
        if (!this._rfDatalist) return;
        this._rfDatalist.innerHTML = '';
        for (const t of this._rfTools) {
            const o = el('option');
            o.value = t.name;
            this._rfDatalist.append(o);
        }
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
    /** Back-compat single-file entry (session restore calls this). */
    async addFromFile(file) { return this.addFromFiles([file]); }

    /** Import a tool — GLB, or OBJ (+MTL +textures, multi-select or folder pick).
     *  opts.asChanger imports it into the "no tool" slot (always attached to the flange). */
    async addFromFiles(files, opts = {}) {
        try {
            const { loadAnyModel, guessScale } = await import('./objImport.js');
            let lastPct = -1;
            const { content, main, isObj, maxDim, sources, sourceNames } = await loadAnyModel(files, {
                preferMain: opts.preferMain,
                onProgress: (frac) => {
                    const pct = Math.floor(frac * 100);
                    if (pct !== lastPct) { lastPct = pct; this._status.textContent = `parsing… ${pct}%`; }
                },
                onAssetsLoaded: () => this.sm.redraw?.(), // textures decode async; show them
            });
            const flange = this._flange();
            if (!flange) { this._status.textContent = 'no flange to attach to'; return; }

            const persisted = this._takePersisted(main.name);
            const cfg = sanitizeCfg(persisted, main.name.replace(/\.(obj|glb|gltf)$/i, ''));
            cfg.fileName = main.name;
            if (opts.asChanger) cfg.isChanger = true;

            // OBJ tools are usually mm/cm exports; land them at hand-tool size (no scale UI here,
            // so bake the guess into the content node — the correction transform stays clean).
            if (isObj) {
                const s = guessScale(maxDim, 0.02, 2, 0.25);
                if (s !== 1) {
                    content.scale.setScalar(s);
                    console.log(`[RobCo] end-effector: bbox ${maxDim.toFixed(0)} units — guessed scale ${s}`);
                }
            }

            if (cfg.isChanger) {
                const old = this.changer;
                if (old) { old.mount.parent?.remove(old.mount); this.tools.splice(this.tools.indexOf(old), 1); }
            }

            const mount = new THREE.Object3D();
            mount.name = `robco-ee-mount-${cfg.id}`;
            mount.add(content);
            const tool = { cfg, mount, glb: content, sources, sourceNames, fileName: main.name };
            this.tools.push(tool);

            if (cfg.isChanger) {
                flange.add(mount);
                this._applyMountAttached(tool);
                // the plate now sits between flange and tool: shift the attached tool out
                if (this.attached) this._applyMountAttached(this.attached);
            } else {
                const shouldAttach = this._persistedAttachedId != null
                    ? cfg.id === this._persistedAttachedId
                    : !this.attached; // fresh import: first tool goes onto the flange
                if (shouldAttach) {
                    flange.add(mount);
                    this._applyMountAttached(tool);
                    this.attachedId = cfg.id;
                    if (!this.homeId) this.homeId = cfg.id;
                } else {
                    this._parkAtDock(tool); // dock from cfg (restore) or world origin (align it)
                }
            }
            this.editId = cfg.id;

            this._applyToolTip();
            this._recomputeCoM();
            window._robcoMaterialManager?.onAttachPointChanged?.();
            this._persist();
            this._rebuildToolsUI();
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] end-effector load failed:', e);
            this._status.textContent = `load failed: ${e.message}`;
        }
    }

    /** The persisted config saved for this exact file. Order-based fallback ONLY for legacy
     *  saves without a fileName — a skipped asset must not shift configs onto the wrong tool. */
    _takePersisted(fileName) {
        const i = this._persistedCfgs.findIndex((c) => c && c.fileName === fileName);
        if (i >= 0) return this._persistedCfgs.splice(i, 1)[0];
        const legacy = this._persistedCfgs.findIndex((c) => c && !c.fileName);
        if (legacy >= 0) return this._persistedCfgs.splice(legacy, 1)[0];
        return null;
    }

    /** Set THIS tool's dock (its default/reset position) to wherever it currently is —
     *  drive the robot to the docking station and press the button. */
    setDockHere(t) {
        if (!t || t.cfg.isChanger) return;
        const w = this._world();
        this.sm.scene?.updateMatrixWorld?.(true);
        const m = new THREE.Matrix4().copy(w.matrixWorld).invert().multiply(t.mount.matrixWorld);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        m.decompose(pos, quat, new THREE.Vector3());
        t.cfg.dock = { pos: pos.toArray(), quat: quat.toArray() };
        this._persist();
        this._refresh();
    }

    removeTool(id) {
        const idx = this.tools.findIndex((t) => t.cfg.id === id);
        if (idx < 0) return;
        if (this.setupPanel?._editing === 'endeffector') this.setupPanel._stopEdit();
        const [t] = this.tools.splice(idx, 1);
        t.mount.parent?.remove(t.mount);
        if (this.attachedId === id) this.attachedId = null;
        if (this.homeId === id) this.homeId = this.attachedId;
        if (this.editId === id) this.editId = this.attachedId || this.tools[0]?.cfg.id || null;
        // removing the changer removes its coupling offset from the attached tool
        if (t.cfg.isChanger && this.attached) this._applyMountAttached(this.attached);
        this._applyToolTip();
        this._recomputeCoM();
        window._robcoMaterialManager?.onAttachPointChanged?.();
        this._persist();
        this._rebuildToolsUI();
        this.sm.redraw?.();
    }

    /** CoM ~= bounding-box centre of the ATTACHED tool, in the flange-local frame (metres). */
    _recomputeCoM() {
        const t = this.attached;
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
            com = [0, 0, 0]; // no measurable geometry: still apply the mass at the flange origin
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
        const t = this.attached;
        if (t && t.cfg.toolTipIsTcp) {
            const off = t.cfg.tcpOffsetMm.map((v) => v / 1000);
            this.teach.setToolOffset(new THREE.Matrix4().makeTranslation(off[0], off[1], off[2]));
        } else {
            this.teach.setToolOffset(null);
        }
    }

    // --- persistence ---------------------------------------------------
    _loadPersisted() {
        this.gripOutput = 'Gripper';
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            this._persistedCfgs = (s && Array.isArray(s.tools)) ? s.tools : [];
            this._persistedAttachedId = s?.attachedId ?? s?.activeId ?? null; // activeId: pre-docking saves
            this.homeId = s?.homeId ?? this._persistedAttachedId ?? null;
            if (typeof s?.gripOutput === 'string' && s.gripOutput) this.gripOutput = s.gripOutput;
        } catch { this._persistedCfgs = []; this._persistedAttachedId = null; }
    }

    _persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                attachedId: this.attachedId,
                homeId: this.homeId,
                gripOutput: this.gripOutput,
                tools: this.tools.map((t) => t.cfg),
            }));
        } catch { /* ignore */ }
    }

    // --- UI section ----------------------------------------------------
    _buildSection() {
        const wrap = el('div');
        const listRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._sel = el('select', SELECT);
        this._sel.addEventListener('change', () => { this.editId = this._sel.value; this._refresh(); });
        const addBtn = el('button', ICON_BTN, '＋');
        addBtn.title = 'Import a tool — GLB, or OBJ (+MTL +textures, multi-select)';
        const dirBtn = el('button', ICON_BTN, '📁');
        dirBtn.title = 'Import a folder — the OBJ plus its MTL and textures';
        const delBtn = el('button', ICON_BTN, '🗑');
        delBtn.title = 'Remove this tool';
        delBtn.addEventListener('click', () => { if (this.editId) this.removeTool(this.editId); });
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

        this._status = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no tools imported');
        wrap.append(this._status);

        // the gripper's output — shared by every MTBH part; the closest one grips while it's ON
        const outRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0 0;');
        outRow.title = 'The robot output that closes this gripper, as bank/io (e.g. "1/0" = bank 1, output 0). ' +
            'Toggle the gripper in RobCo Studio and check the console to find yours. ' +
            'For testing without a robot, use the simulated toggle in the Material section.';
        outRow.append(el('span', 'width:46px;opacity:.8;', 'output'));
        this._outIn = el('input', TEXT);
        this._outIn.type = 'text';
        this._outIn.value = this.gripOutput;
        this._outIn.addEventListener('change', () => {
            this.gripOutput = this._outIn.value.trim() || 'Gripper';
            this._outIn.value = this.gripOutput;
            this._outHint.textContent = outHintText(this.gripOutput);
            this._persist();
        });
        outRow.append(this._outIn);
        wrap.append(outRow);
        const outHintText = (name) => {
            const ref = parseOutputRef(name);
            return ref
                ? `live: robot output bank ${ref.bank}, io ${ref.io} — ON grips, OFF releases`
                : `type bank/io (e.g. 1/0) — or log "output:${name}=1|0" in the flow`;
        };
        this._outHint = el('div', HINT, outHintText(this.gripOutput));
        wrap.append(this._outHint);

        // "no tool" slot: a model that is ALWAYS on the flange (e.g. the tool-changer master)
        const chgRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        chgRow.title = 'Model for the no-tool state — e.g. the tool-changer master plate. Always attached, stays visible under any tool.';
        chgRow.append(el('span', 'flex:1;opacity:.8;', 'changer / no-tool model'));
        const chgAdd = el('button', ICON_BTN, '＋');
        const chgDir = el('button', ICON_BTN, '📁');
        chgRow.append(chgAdd, chgDir);
        wrap.append(chgRow);
        import('./objImport.js').then(({ makeFilePickers }) => {
            const { fileInput, dirInput, openFolder } = makeFilePickers(
                (files, opts) => this.addFromFiles(files, { ...opts, asChanger: true }),
                { onHint: (t) => { this._status.textContent = t; } },
            );
            wrap.append(fileInput, dirInput);
            chgAdd.addEventListener('click', () => fileInput.click());
            chgDir.addEventListener('click', () => openFolder());
        });

        const resetPosBtn = el('button', BTN + 'margin:2px 0 4px;', 'Reset tool positions');
        resetPosBtn.title = 'Re-attach the home tool and return every other tool to its dock position.';
        resetPosBtn.addEventListener('click', () => this.resetToolPositions());
        wrap.append(resetPosBtn);

        // ---- per-tool body (edits the picker selection) ----
        const body = el('div', 'display:none;');

        this._attachRow = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        this._attachCb = el('input'); this._attachCb.type = 'checkbox'; this._attachCb.style.accentColor = '#2f81f7';
        this._attachCb.title = 'Attach this tool to the flange (the current one is parked in place). Unchecking parks it — no tool attached.';
        this._attachCb.addEventListener('change', () => {
            const t = this.edited; if (!t || t.cfg.isChanger) return;
            this.toolChange(this._attachCb.checked ? t.cfg.id : null);
            this.homeId = this.attachedId; // manual attachment designates the reset-home tool
            this._persist();
        });
        this._attachRow.append(this._attachCb, el('span', 'opacity:.9;', 'Attached to flange'));
        body.append(this._attachRow);

        // RobFlow tool assignment — live tool changes switch to the model with the matching name
        this._rfRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0 0;');
        this._rfRow.title = 'RobFlow tool name (from the robot config). When the robot selects that tool, this model is attached automatically.';
        this._rfRow.append(el('span', 'width:46px;opacity:.8;', 'robflow'));
        this._rfIn = el('input', TEXT);
        this._rfIn.type = 'text';
        this._rfIn.placeholder = '— not assigned —';
        this._rfDatalist = el('datalist');
        this._rfDatalist.id = `robco-rf-tools-${newId()}`;
        this._rfIn.setAttribute('list', this._rfDatalist.id);
        this._rfIn.addEventListener('change', () => {
            const t = this.edited; if (!t) return;
            t.cfg.rfName = this._rfIn.value.trim();
            this._persist();
        });
        this._rfRow.append(this._rfIn, this._rfDatalist);
        body.append(this._rfRow);
        this._rfHint = el('div', HINT, 'live tool changes attach the model assigned to the selected RobFlow tool');
        body.append(this._rfHint);

        this._alignBtn = el('button', BTN, 'Align');
        this._alignBtn.addEventListener('click', () => {
            const t = this.edited;
            if (!t) return;
            this.setupPanel?._edit('endeffector', t.mount, ['translate', 'rotate'], () => {
                this._saveMountPose(t);
                this._refresh();
                this._recomputeCoM();
            });
        });
        body.append(this._alignBtn);

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
        this._poseHint = el('div', 'font-size:10px;color:#6e7681;margin:2px 0;', '');
        body.append(this._poseHint);
        body.append(triple('pos m', ['px', 'py', 'pz'], 0.01));
        body.append(triple('rot °', ['rx', 'ry', 'rz'], 15));

        // changer only: coupling offset — where tools dock ON the changer plate (flange frame)
        this._offRow = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
        this._offRow.title = 'Coupling offset (m, flange frame): attached tools mount shifted by this — the changer plate sits between flange and tool.';
        this._offRow.append(el('span', 'width:46px;opacity:.8;', 'tool off'));
        ['ox', 'oy', 'oz'].forEach((k) => {
            const inp = el('input', NUM);
            inp.type = 'number'; inp.step = '0.005';
            inp.addEventListener('change', () => {
                const c = this.changer; if (!c) return;
                c.cfg.toolOffset = ['ox', 'oy', 'oz'].map((kk) => +this._fields[kk].value || 0);
                if (this.attached) this._applyMountAttached(this.attached); // tools ride the plate
                this._persist();
                this._recomputeCoM();
                this.sm.redraw?.();
            });
            this._fields[k] = inp;
            this._offRow.append(inp);
        });
        body.append(this._offRow);

        const yz = el('button', BTN, 'Y-up→Z-up');
        yz.addEventListener('click', () => {
            const t = this.edited; if (!t) return;
            t.mount.rotateX(Math.PI / 2);
            this._saveMountPose(t);
            this._refresh(); this._recomputeCoM(); this.sm.redraw?.();
        });
        const zeroBtn = el('button', BTN, 'Zero');
        zeroBtn.title = 'Zero this pose (attached: correction; parked: dock at world origin)';
        zeroBtn.addEventListener('click', () => {
            const t = this.edited; if (!t) return;
            t.mount.position.set(0, 0, 0); t.mount.rotation.set(0, 0, 0);
            this._saveMountPose(t);
            this._refresh(); this._recomputeCoM(); this.sm.redraw?.();
        });
        const r2 = el('div', 'display:flex;gap:6px;margin:4px 0;');
        r2.append(yz, zeroBtn);
        body.append(r2);

        // default/reset position in the cell — set it while the gripper sits in its docking station
        this._dockBtn = el('button', BTN, 'Set dock = here');
        this._dockBtn.title = 'Store this tool’s CURRENT position as its default (docking-station) position. "Reset tool positions" returns it here.';
        this._dockBtn.addEventListener('click', () => this.setDockHere(this.edited));
        body.append(this._dockBtn);
        this._dockHint = el('div', HINT, '');
        body.append(this._dockHint);

        // per-tool grip point (each end-effector grabs somewhere else)
        const gripRow = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
        gripRow.title = 'Gripping point of THIS tool (mm, relative to its mount) — used to find the closest MTBH element.';
        gripRow.append(el('span', 'width:46px;opacity:.8;', 'grip mm'));
        ['gx', 'gy', 'gz'].forEach((k) => {
            const inp = el('input', NUM);
            inp.type = 'number'; inp.step = '5';
            inp.addEventListener('change', () => {
                const t = this.edited; if (!t) return;
                t.cfg.gripPointMm = ['gx', 'gy', 'gz'].map((kk) => +this._fields[kk].value || 0);
                this._persist();
                window._robcoMaterialManager?.onAttachPointChanged?.(); // reposition the marker
            });
            this._fields[k] = inp;
            gripRow.append(inp);
        });
        body.append(gripRow);

        // mass
        const massRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        massRow.append(el('span', 'width:46px;opacity:.8;', 'mass kg'));
        this._massIn = el('input', NUM.replace('width:46px', 'width:64px'));
        this._massIn.type = 'number'; this._massIn.step = '0.1'; this._massIn.min = '0';
        this._massIn.addEventListener('change', () => {
            const t = this.edited; if (!t) return;
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
            const t = this.edited; if (!t) return;
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
                const t = this.edited; if (!t) return;
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

    /** Persist the edited tool's mount pose to the right slot: correction while on the flange
     *  (changer or attached; minus the changer's coupling offset, which is applied on mount),
     *  dock pose while parked. */
    _saveMountPose(t) {
        if (t.cfg.isChanger || t.cfg.id === this.attachedId) {
            const pos = t.mount.position.toArray();
            const off = t.cfg.isChanger ? null : this._changerOffset();
            if (off) for (let i = 0; i < 3; i++) pos[i] -= off[i];
            t.cfg.correction = {
                pos,
                euler: [t.mount.rotation.x, t.mount.rotation.y, t.mount.rotation.z],
            };
        } else {
            t.cfg.dock = { pos: t.mount.position.toArray(), quat: t.mount.quaternion.toArray() };
        }
        this._persist();
    }

    _applyNumeric() {
        const t = this.edited; if (!t) return;
        const f = this._fields;
        t.mount.position.set(+f.px.value || 0, +f.py.value || 0, +f.pz.value || 0);
        t.mount.rotation.set((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R);
        this._saveMountPose(t);
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
        if (!this.edited) this.editId = this.attachedId || this.tools[0].cfg.id;
        for (const t of this.tools) {
            const tag = t.cfg.isChanger ? '⚙ ' : (t.cfg.id === this.attachedId ? '▶ ' : '');
            const o = el('option', OPT, tag + t.cfg.name);
            o.value = t.cfg.id;
            this._sel.append(o);
        }
        this._sel.value = this.editId;
        this._refresh();
    }

    _refresh() {
        const t = this.edited;
        if (!t) { this._body.style.display = 'none'; return; }
        this._body.style.display = 'block';
        const isAttached = t.cfg.id === this.attachedId;
        const att = this.attached;
        this._status.textContent = att ? `attached: ${att.cfg.name}` : (this.changer ? 'no tool attached (changer only)' : 'no tool attached');
        this._attachRow.style.display = t.cfg.isChanger ? 'none' : 'flex';
        this._attachCb.checked = isAttached;
        this._rfRow.style.display = t.cfg.isChanger ? 'none' : 'flex';
        this._rfHint.style.display = t.cfg.isChanger ? 'none' : 'block';
        this._rfIn.value = t.cfg.rfName || '';
        this._poseHint.textContent = (t.cfg.isChanger || isAttached)
            ? 'correction (flange-local — realign export)'
            : 'dock position (in cell)';
        this._offRow.style.display = t.cfg.isChanger ? 'flex' : 'none';
        this._dockBtn.style.display = t.cfg.isChanger ? 'none' : 'inline-block';
        this._dockHint.style.display = t.cfg.isChanger ? 'none' : 'block';
        this._dockHint.textContent = t.cfg.dock
            ? `dock: [${t.cfg.dock.pos.map((v) => v.toFixed(2)).join(', ')}] m`
            : 'no dock yet — park or "Set dock = here"';
        const f = this._fields;
        if (t.cfg.isChanger) {
            f.ox.value = t.cfg.toolOffset[0] || 0;
            f.oy.value = t.cfg.toolOffset[1] || 0;
            f.oz.value = t.cfg.toolOffset[2] || 0;
        }
        f.gx.value = t.cfg.gripPointMm[0] || 0;
        f.gy.value = t.cfg.gripPointMm[1] || 0;
        f.gz.value = t.cfg.gripPointMm[2] || 0;
        const p = t.mount.position;
        const r = (v) => Math.round(v * 1000) / 1000;
        f.px.value = r(p.x); f.py.value = r(p.y); f.pz.value = r(p.z);
        f.rx.value = Math.round(t.mount.rotation.x * R2D); f.ry.value = Math.round(t.mount.rotation.y * R2D); f.rz.value = Math.round(t.mount.rotation.z * R2D);
        this._massIn.value = String(t.cfg.mass || 0);
        f.tx.value = t.cfg.tcpOffsetMm[0] || 0; f.ty.value = t.cfg.tcpOffsetMm[1] || 0; f.tz.value = t.cfg.tcpOffsetMm[2] || 0;
        this._tipCb.checked = t.cfg.toolTipIsTcp;
    }
}
