/**
 * CameraView — virtual robot-mounted cameras with live viewports.
 *
 * A single manager panel owns one or more virtual PerspectiveCameras ("rigs"). Each rig is parented
 * into the robot scene graph so it follows the arm: the TCP flange, a chosen joint's frame, or the
 * robot base / world origin (a static camera watching the cell, positioned in free world
 * coordinates). Per rig you can set the focal length (drag the slider OR type a value, in mm), a
 * position + rotation offset relative to the mount, the near clipping distance (the "start point"),
 * and a frustum helper.
 *
 * The currently selected rig renders into a small in-panel viewport (a shared second WebGLRenderer,
 * driven by the SceneManager frame hook — on-demand, only on frames the main loop already draws).
 * Any rig can additionally be "popped out" into a separate, resizable browser window that renders
 * the same feed full-frame through its own dedicated WebGLRenderer.
 *
 * Settings (every camera + the active selection) persist to localStorage; rigs re-attach on robot
 * rebuild. Singleton: window._robcoCameraView.
 */
import * as THREE from 'three';
import { makeDraggable, makeCollapsible } from './draggable.js';

const KEY = 'robco-camera';
const D2R = Math.PI / 180;
const VW = 300, VH = 190;   // in-panel viewport size (px)
const FAR_M = 100;          // far clip plane (m, fixed) — governs what the camera *view* renders
const NEAR_MIN_M = 0.0001;  // smallest allowed near clip (m)
const HELPER_FAR_M = 0.5;   // frustum-helper draw length (m): keep the optional overlay small so it
                            // never dominates the main scene, independent of the (large) render far
const ROBOT_NEAR_M = 0.001; // near clip used for the robot-only pass when it's exempt from the clip

const PANEL_CSS =
    'position:fixed;right:16px;top:360px;z-index:3000;width:300px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
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

const CAM_DEFAULTS = {
    enabled: false, attach: 'tcp', focalMm: 24,
    offsetMm: [0, 0, 0], rotDeg: [0, 180, 0], nearMm: 10, showFrustum: false, noClipRobot: false,
    dof: false, dofFocusMm: 500, dofBlur: 0.5,
};

let _idSeq = 0;
function newId() {
    _idSeq += 1;
    return `cam${Date.now().toString(36)}${_idSeq}`;
}

/** Coerce a stored/partial config into a complete, valid camera config. */
function sanitizeCfg(s, fallbackName) {
    s = (s && typeof s === 'object') ? s : {};
    return {
        id: typeof s.id === 'string' && s.id ? s.id : newId(),
        name: typeof s.name === 'string' && s.name ? s.name : (fallbackName || 'Camera'),
        enabled: !!s.enabled,
        attach: typeof s.attach === 'string' ? s.attach : 'tcp',
        focalMm: s.focalMm > 0 ? s.focalMm : CAM_DEFAULTS.focalMm,
        offsetMm: Array.isArray(s.offsetMm) && s.offsetMm.length === 3 ? s.offsetMm.map((v) => +v || 0) : [...CAM_DEFAULTS.offsetMm],
        rotDeg: Array.isArray(s.rotDeg) && s.rotDeg.length === 3 ? s.rotDeg.map((v) => +v || 0) : [...CAM_DEFAULTS.rotDeg],
        nearMm: s.nearMm > 0 ? s.nearMm : CAM_DEFAULTS.nearMm,
        showFrustum: s.showFrustum === true, // opt-in overlay; the main view is clean by default
        noClipRobot: s.noClipRobot === true, // exempt the robot model from the near clip
        dof: s.dof === true,
        dofFocusMm: s.dofFocusMm > 0 ? s.dofFocusMm : CAM_DEFAULTS.dofFocusMm,
        dofBlur: (typeof s.dofBlur === 'number' && s.dofBlur >= 0 && s.dofBlur <= 1) ? s.dofBlur : CAM_DEFAULTS.dofBlur,
    };
}

/**
 * One virtual camera: a PerspectiveCamera parented into the robot graph, its frustum helper, and an
 * optional pop-out window (its own WebGLRenderer). The manager drives rendering via the frame hook.
 */
class CameraRig {
    constructor(cfg, mgr) {
        this.mgr = mgr;
        this.cfg = cfg;
        this.cam = new THREE.PerspectiveCamera(50, VW / VH, Math.max(NEAR_MIN_M, cfg.nearMm / 1000), FAR_M);
        this.cam.matrixAutoUpdate = false; // driven by parent chain · our explicit local matrix
        this.cam.filmGauge = 35;
        this.helper = null;
        this.popup = null; // { win, renderer, canvas, w, h, onResize }
    }

    get sm() { return this.mgr.sm; }
    get model() { return this.mgr.model; }
    get teach() { return this.mgr.teach; }

    // --- mount resolution ----------------------------------------------
    _flange() {
        const nodes = this.model?.userData?.moduleNodes || [];
        if (nodes.length) {
            const last = nodes[nodes.length - 1];
            return last.getDistalLink?.() || last.distal;
        }
        return this.model?.threeObject || null;
    }

    _targetObject() {
        const a = this.cfg.attach;
        if (!a || a === 'tcp') return this._flange();
        if (a === 'origin') return this.model?.threeObject || null; // robot base is pinned at the world origin
        const j = this.model?.joints?.get(a);
        return j?.threeObject || this._flange();
    }

    /** Base transform of the mount frame: the tool offset when the TCP is a tool tip, else identity. */
    _baseMatrix() {
        if ((!this.cfg.attach || this.cfg.attach === 'tcp') && this.teach?.toolOffset) {
            return this.teach.toolOffset.clone();
        }
        return new THREE.Matrix4();
    }

    _offsetMatrix() {
        const [x, y, z] = this.cfg.offsetMm.map((v) => (v || 0) / 1000);
        const [rx, ry, rz] = this.cfg.rotDeg.map((v) => (v || 0) * D2R);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
        return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
    }

    attach() {
        const target = this._targetObject();
        if (this.cam.parent) this.cam.parent.remove(this.cam);
        if (target) target.add(this.cam);
        this._applyCamMatrix();
    }

    _applyCamMatrix() {
        this.cam.matrix.copy(this._baseMatrix().multiply(this._offsetMatrix()));
        this.cam.matrixWorldNeedsUpdate = true;
    }

    /** Configured near clip in metres, clamped to a valid (0, far) range. */
    _nearM() {
        return Math.min(Math.max(NEAR_MIN_M, this.cfg.nearMm / 1000), FAR_M * 0.9);
    }

    /** Apply focal length + near clip + local matrix, and refresh the frustum helper. */
    applyCam() {
        this.cam.aspect = VW / VH;
        this.cam.near = this._nearM();
        this.cam.setFocalLength(this.cfg.focalMm); // sets fov + updateProjectionMatrix (35mm gauge, current near/far)
        this._applyCamMatrix();
        this._updateHelper();
    }

    /**
     * Refresh the frustum helper, drawing it with a short far (HELPER_FAR_M) so the overlay stays a
     * small aiming aid and never blasts lines across the whole scene. The camera's real far (used by
     * the rendered view) is restored immediately, so this only affects the helper geometry.
     */
    _updateHelper() {
        if (!this.helper) return;
        const realFar = this.cam.far;
        this.cam.far = Math.max(this.cam.near * 1.5, Math.min(realFar, HELPER_FAR_M));
        this.cam.updateProjectionMatrix();
        this.helper.update();
        this.cam.far = realFar;
        this.cam.updateProjectionMatrix();
    }

    ensureHelper() {
        if (this.helper || !this.sm?.scene) return;
        this.helper = new THREE.CameraHelper(this.cam);
        this.sm.scene.add(this.helper);
        this.setHelperVisible();
    }

    /** Move the helper onto a (new) scene, e.g. after a SceneManager swap. */
    rehostHelper() {
        if (!this.helper || !this.sm?.scene) return;
        this.helper.parent?.remove(this.helper);
        this.sm.scene.add(this.helper);
    }

    setHelperVisible() {
        if (this.helper) this.helper.visible = !!(this.cfg.enabled && this.cfg.showFrustum);
    }

    /**
     * Render this camera into a target renderer at the given backing-store size.
     *
     * When `noClipRobot` is set, the robot is exempt from the near clip: pass 1 draws the whole
     * scene at the configured near (clipping everything closer than the start point), then pass 2
     * re-draws only the robot at a near of ~0, composited on top — so the robot is always fully
     * visible while other geometry closer than the clip is still hidden.
     */
    renderInto(renderer, w, h, scene) {
        this.cam.aspect = w / h;

        // Depth of field takes over the pipeline: it needs a single, consistent scene depth, so it
        // can't combine with the robot clip-exemption two-pass (DoF wins when both are set).
        if (this.cfg.dof && this.mgr._dofReady()) {
            this.mgr._renderDof(this, renderer, w, h, scene);
            return;
        }

        const robot = this.model?.threeObject;
        if (this.cfg.noClipRobot && robot) {
            // Pass 1: the whole scene at the configured near (everything closer than the start point
            // is clipped — including the scene file, ground, etc.).
            this.cam.near = this._nearM();
            this.cam.updateProjectionMatrix();
            renderer.render(scene, this.cam);

            // Pass 2: ONLY the robot model subtree at near ≈ 0, composited on top. Isolate exactly the
            // robot by hiding every sibling along its ancestor path — so only the robot is exempt from
            // the clip; lights stay on so it's still lit. Keep the colour buffer (no autoClear), drop
            // the depth so the robot draws in full, and drop the background so pass 1 shows through.
            const prevAutoClear = renderer.autoClear;
            const prevBg = scene.background;
            renderer.autoClear = false;
            scene.background = null;
            renderer.clearDepth();
            this.cam.near = ROBOT_NEAR_M;
            this.cam.updateProjectionMatrix();
            const hidden = [];
            for (let node = robot; node && node !== scene; node = node.parent) {
                const parent = node.parent;
                if (!parent) break;
                for (const sib of parent.children) {
                    if (sib !== node && sib.visible && !sib.isLight) { sib.visible = false; hidden.push(sib); }
                }
            }
            renderer.render(scene, this.cam);
            for (const c of hidden) c.visible = true;
            scene.background = prevBg;
            renderer.autoClear = prevAutoClear;
            this.cam.near = this._nearM(); // restore for the frustum helper + next pass
            this.cam.updateProjectionMatrix();
        } else {
            this.cam.near = this._nearM();
            this.cam.updateProjectionMatrix();
            renderer.render(scene, this.cam);
        }
    }

    hasPopup() { return !!(this.popup && this.popup.win && !this.popup.win.closed); }

    /** Open (or focus) a separate resizable window rendering this camera full-frame. */
    openPopup() {
        if (this.hasPopup()) { this.popup.win.focus(); return; }
        const win = window.open('', `robco-cam-${this.cfg.id}`, 'width=960,height=600');
        if (!win) {
            alert('The camera window was blocked. Please allow pop-ups for this site and try again.');
            return;
        }
        const doc = win.document;
        doc.title = `${this.cfg.name} · RobCo Camera`;
        doc.documentElement.style.cssText = 'height:100%;';
        doc.body.style.cssText = 'margin:0;height:100%;background:#000;overflow:hidden;';
        doc.body.innerHTML = '';
        const canvas = doc.createElement('canvas');
        canvas.style.cssText = 'display:block;width:100%;height:100%;';
        doc.body.appendChild(canvas);
        const cap = doc.createElement('div');
        cap.style.cssText = 'position:fixed;left:10px;top:8px;font:600 12px ui-monospace,Menlo,Consolas,monospace;' +
            'color:#e6edf3;background:rgba(13,17,23,0.55);padding:3px 8px;border-radius:6px;pointer-events:none;';
        doc.body.appendChild(cap);

        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        } catch (e) {
            console.warn('[RobCo] camera pop-out renderer failed:', e);
            win.close();
            alert('Could not create the camera window renderer.');
            return;
        }
        renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;

        this.popup = { win, renderer, canvas, cap, w: 1, h: 1, onResize: null };
        const resize = () => {
            const w = Math.max(1, win.innerWidth), h = Math.max(1, win.innerHeight);
            this.popup.w = w; this.popup.h = h;
            renderer.setSize(w, h, false);
            this.sm?.redraw?.();
        };
        this.popup.onResize = resize;
        win.addEventListener('resize', resize);
        win.addEventListener('beforeunload', () => this._onPopupClosed());
        resize();

        // Popping out implies you want to see it — turn the rig on.
        this.mgr.setRigEnabled(this, true);
        this.mgr.syncPopupBtn();
        this.sm?.redraw?.();
    }

    _onPopupClosed() {
        if (!this.popup) return;
        this.mgr._disposeDofFor(this.popup.renderer);
        try { this.popup.renderer.dispose(); } catch { /* ignore */ }
        this.popup = null;
        this.mgr.syncPopupBtn();
    }

    closePopup() {
        if (!this.popup) return;
        const win = this.popup.win;
        this._onPopupClosed();
        try { if (win && !win.closed) win.close(); } catch { /* ignore */ }
    }

    dispose() {
        this.closePopup();
        if (this.cam.parent) this.cam.parent.remove(this.cam);
        if (this.helper) { this.helper.parent?.remove(this.helper); this.helper.dispose?.(); this.helper = null; }
    }
}

export class CameraView {
    static ensure({ sm, model, teach }) {
        if (window._robcoCameraView) {
            window._robcoCameraView.repoint({ sm, model, teach });
            return window._robcoCameraView;
        }
        const c = new CameraView({ sm, model, teach });
        window._robcoCameraView = c;
        return c;
    }

    constructor({ sm, model, teach }) {
        this.sm = sm;
        this.model = model;
        this.teach = teach;

        const { cameras, activeId } = this._load();
        this.rigs = cameras.map((c) => new CameraRig(c, this));
        this.activeId = activeId && this.rigs.some((r) => r.cfg.id === activeId) ? activeId : this.rigs[0].cfg.id;

        this.inRenderer = null; // shared in-panel viewport renderer

        // Depth-of-field pipeline (lazy): postprocessing classes + one EffectComposer per renderer.
        this._dofLibs = null;
        this._dofLoading = false;
        this._dofComposers = new Map(); // renderer -> { composer, renderPass, bokeh, w, h }
        if (this.rigs.some((r) => r.cfg.dof)) this._ensureDofLibs();

        this._build();
        this._rebuildCamSelect();
        this._rebuildJointOptions();
        this._syncUIFromActive();

        for (const r of this.rigs) {
            r.attach();
            r.applyCam();
            if (r.cfg.enabled) { r.ensureHelper(); r.setHelperVisible(); }
        }
        this._unhook = this.sm.addFrameHook(() => this._onFrame());
        this._refreshViewport();
        this.sm.redraw?.();
    }

    get active() { return this.rigs.find((r) => r.cfg.id === this.activeId) || this.rigs[0]; }

    /** Re-point at a (re)built robot: re-attach every camera + refresh the joint list. */
    repoint({ sm, model, teach }) {
        const smChanged = sm && sm !== this.sm;
        const modelChanged = model && model !== this.model;
        if (sm) this.sm = sm;
        if (teach) this.teach = teach;
        if (model) this.model = model;

        if (smChanged) {
            if (this._unhook) { this._unhook(); this._unhook = null; }
            this._unhook = this.sm.addFrameHook(() => this._onFrame());
            for (const r of this.rigs) r.rehostHelper();
        }
        if (modelChanged || smChanged) {
            this._rebuildJointOptions();
            for (const r of this.rigs) { r.attach(); r.applyCam(); r.setHelperVisible(); }
            this._syncUIFromActive();
            this._refreshViewport();
            this.sm.redraw?.();
        }
    }

    // --- per-frame rendering -------------------------------------------
    /** After the main frame (scene world matrices current): render each enabled rig's targets. */
    _onFrame() {
        const scene = this.sm?.scene;
        if (!scene) return;
        const act = this.active;

        // Hide all camera frustums so they don't clutter the secondary (viewport / pop-out) renders.
        for (const r of this.rigs) if (r.helper) r.helper.visible = false;

        for (const r of this.rigs) {
            if (!r.cfg.enabled) continue;
            if (r.popup && r.popup.win.closed) r._onPopupClosed();
            r.cam.updateMatrixWorld(true);
            if (r.hasPopup()) r.renderInto(r.popup.renderer, r.popup.w, r.popup.h, scene);
            if (r === act && this.inRenderer) r.renderInto(this.inRenderer, VW, VH, scene);
        }

        // Master stream: the takt diagram's camera row switches which rig feeds this window.
        // Renders regardless of the rig's "enabled" flag — a switch must always show a picture.
        if (this.master) {
            if (this.master.win.closed) this._onMasterClosed();
            else {
                const rig = this.rigs.find((r) => r.cfg.id === this.master.rigId) || act;
                if (rig) {
                    rig.cam.updateMatrixWorld(true);
                    rig.renderInto(this.master.renderer, this.master.w, this.master.h, scene);
                }
            }
        }

        // Restore frustum visibility + refresh with a stable aspect (the pop-out's, else in-panel).
        for (const r of this.rigs) {
            if (!r.helper) continue;
            r.helper.visible = !!(r.cfg.enabled && r.cfg.showFrustum);
            if (r.helper.visible) {
                const w = r.hasPopup() ? r.popup.w : VW;
                const h = r.hasPopup() ? r.popup.h : VH;
                r.cam.aspect = w / h;
                r.cam.updateProjectionMatrix();
                r._updateHelper();
            }
        }
    }

    // --- depth of field ------------------------------------------------
    _dofReady() { return !!this._dofLibs; }

    /** Lazy-load the postprocessing classes for DoF; renders fall back to a plain draw until ready. */
    async _ensureDofLibs() {
        if (this._dofLibs || this._dofLoading) return;
        this._dofLoading = true;
        try {
            const [{ EffectComposer }, { RenderPass }, { BokehPass }, { OutputPass }] = await Promise.all([
                import('three/examples/jsm/postprocessing/EffectComposer.js'),
                import('three/examples/jsm/postprocessing/RenderPass.js'),
                import('three/examples/jsm/postprocessing/BokehPass.js'),
                import('three/examples/jsm/postprocessing/OutputPass.js'),
            ]);
            this._dofLibs = { EffectComposer, RenderPass, BokehPass, OutputPass };
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] depth of field unavailable:', e);
        } finally {
            this._dofLoading = false;
        }
    }

    /** Render a rig's view through a Bokeh (depth-of-field) composer for the given renderer. */
    _renderDof(rig, renderer, w, h, scene) {
        const L = this._dofLibs;
        let e = this._dofComposers.get(renderer);
        if (!e) {
            const composer = new L.EffectComposer(renderer);
            composer.setPixelRatio(renderer.getPixelRatio());
            composer.setSize(w, h);
            const renderPass = new L.RenderPass(scene, rig.cam);
            const bokeh = new L.BokehPass(scene, rig.cam, { focus: 1.0, aperture: 0.02, maxblur: 0.01 });
            composer.addPass(renderPass);
            composer.addPass(bokeh);
            composer.addPass(new L.OutputPass()); // tone map + sRGB (composer bypasses the renderer's)
            e = { composer, renderPass, bokeh, w, h };
            this._dofComposers.set(renderer, e);
        }
        if (e.w !== w || e.h !== h) {
            e.composer.setPixelRatio(renderer.getPixelRatio());
            e.composer.setSize(w, h);
            e.bokeh.setSize(w, h);
            e.w = w; e.h = h;
        }
        e.renderPass.scene = scene; e.renderPass.camera = rig.cam;
        e.bokeh.scene = scene; e.bokeh.camera = rig.cam;
        const blur = Math.min(1, Math.max(0, rig.cfg.dofBlur ?? 0.5));
        const u = e.bokeh.uniforms;
        u['focus'].value = Math.max(0.01, (rig.cfg.dofFocusMm || CAM_DEFAULTS.dofFocusMm) / 1000);
        u['aperture'].value = 0.002 + blur * 0.05; // circle-of-confusion scale
        u['maxblur'].value = 0.004 + blur * 0.016;  // cap on blur radius
        u['aspect'].value = w / h;
        rig.cam.aspect = w / h;
        rig.cam.near = rig._nearM();
        rig.cam.updateProjectionMatrix();
        e.composer.render();
    }

    /** Dispose the DoF composer bound to a renderer (on pop-out close / teardown). */
    _disposeDofFor(renderer) {
        const e = this._dofComposers.get(renderer);
        if (e) { try { e.composer.dispose(); } catch { /* ignore */ } this._dofComposers.delete(renderer); }
    }

    _ensureInRenderer() {
        if (this.inRenderer) return;
        const r = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.setSize(VW, VH, false); // backing store only; canvas CSS size is fixed
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        this.inRenderer = r;
    }

    /** Show the in-panel viewport iff the active camera is enabled. */
    _refreshViewport() {
        const act = this.active;
        if (act && act.cfg.enabled) {
            this._ensureInRenderer();
            this._canvasWrap.style.display = 'block';
        } else if (this._canvasWrap) {
            this._canvasWrap.style.display = 'none';
        }
    }

    // --- camera set management -----------------------------------------
    setRigEnabled(rig, on) {
        rig.cfg.enabled = !!on;
        if (rig.cfg.enabled) { rig.ensureHelper(); }
        rig.setHelperVisible();
        if (!rig.cfg.enabled) rig.closePopup();
        if (rig === this.active) { this._enCb.checked = rig.cfg.enabled; this._refreshViewport(); }
        this._save();
        this.sm.redraw?.();
    }

    _addCamera() {
        const n = this.rigs.length + 1;
        const cfg = sanitizeCfg({ ...CAM_DEFAULTS, id: newId(), name: `Camera ${n}`, enabled: true });
        const rig = new CameraRig(cfg, this);
        this.rigs.push(rig);
        rig.attach();
        rig.applyCam();
        rig.ensureHelper();
        rig.setHelperVisible();
        this.activeId = cfg.id;
        this._rebuildCamSelect();
        this._syncUIFromActive();
        this._refreshViewport();
        this._save();
        this.sm.redraw?.();
    }

    _removeCamera() {
        if (this.rigs.length <= 1) return; // keep at least one
        const idx = this.rigs.findIndex((r) => r.cfg.id === this.activeId);
        const [rig] = this.rigs.splice(idx < 0 ? 0 : idx, 1);
        rig.dispose();
        this.activeId = this.rigs[Math.min(idx, this.rigs.length - 1)].cfg.id;
        this._rebuildCamSelect();
        this._syncUIFromActive();
        this._refreshViewport();
        this._save();
        this.sm.redraw?.();
    }

    _selectCamera(id) {
        if (!this.rigs.some((r) => r.cfg.id === id)) return;
        this.activeId = id;
        this._syncUIFromActive();
        this._refreshViewport();
        this._save();
        this.sm.redraw?.();
    }

    // --- master stream (driven by the takt diagram's camera row) --------------
    hasMaster() { return !!(this.master && this.master.win && !this.master.win.closed); }

    /** The rig currently feeding the master stream, or null when the window is closed. */
    masterCameraId() { return this.hasMaster() ? this.master.rigId : null; }

    /** Open (or focus) the MASTER STREAM window: one persistent feed that camera switches cut. */
    openMaster() {
        if (this.hasMaster()) { this.master.win.focus(); return true; }
        const win = window.open('', 'robco-cam-master', 'width=960,height=600');
        if (!win) {
            alert('The master stream window was blocked. Please allow pop-ups for this site and try again.');
            return false;
        }
        const doc = win.document;
        doc.title = 'Master Stream · RobCo Camera';
        doc.documentElement.style.cssText = 'height:100%;';
        doc.body.style.cssText = 'margin:0;height:100%;background:#000;overflow:hidden;';
        doc.body.innerHTML = '';
        const canvas = doc.createElement('canvas');
        canvas.style.cssText = 'display:block;width:100%;height:100%;';
        doc.body.appendChild(canvas);
        const cap = doc.createElement('div');
        cap.style.cssText = 'position:fixed;left:10px;top:8px;font:600 12px ui-monospace,Menlo,Consolas,monospace;' +
            'color:#e6edf3;background:rgba(200,40,40,0.65);padding:3px 8px;border-radius:6px;pointer-events:none;';
        doc.body.appendChild(cap);

        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        } catch (e) {
            console.warn('[RobCo] master stream renderer failed:', e);
            win.close();
            return false;
        }
        renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;

        this.master = { win, renderer, canvas, cap, w: 1, h: 1, rigId: this.activeId };
        const resize = () => {
            const w = Math.max(1, win.innerWidth), h = Math.max(1, win.innerHeight);
            this.master.w = w; this.master.h = h;
            renderer.setSize(w, h, false);
            this.sm?.redraw?.();
        };
        win.addEventListener('resize', resize);
        win.addEventListener('beforeunload', () => this._onMasterClosed());
        resize();
        this.setMasterCamera(this.master.rigId);
        this.sm?.redraw?.();
        return true;
    }

    /** Cut the master stream to another camera. Returns true when the rig exists. */
    setMasterCamera(rigId) {
        const rig = this.rigs.find((r) => r.cfg.id === rigId);
        if (!rig || !this.master) return false;
        this.master.rigId = rigId;
        if (this.master.cap) this.master.cap.textContent = `● MASTER · ${rig.cfg.name}`;
        this.sm?.redraw?.();
        return true;
    }

    _onMasterClosed() {
        if (!this.master) return;
        this._disposeDofFor(this.master.renderer);
        try { this.master.renderer.dispose(); } catch { /* ignore */ }
        this.master = null;
    }

    closeMaster() {
        if (!this.master) return;
        const win = this.master.win;
        this._onMasterClosed();
        try { if (win && !win.closed) win.close(); } catch { /* ignore */ }
    }

    /** Render a rig into a small offscreen canvas → JPEG data URL (null on failure). Used by the
     *  takt diagram's camera-row thumbnails. Works for disabled rigs too. */
    captureThumb(camId, w = 128, h = 72) {
        const rig = this.rigs.find((r) => r.cfg.id === camId);
        if (!rig || !this.sm?.scene) return null;
        if (!this._thumbRenderer) {
            try {
                const canvas = document.createElement('canvas');
                this._thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
                this._thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
                this._thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
                this._thumbRenderer.toneMappingExposure = 1.0;
            } catch (e) {
                console.warn('[RobCo] thumbnail renderer failed:', e);
                return null;
            }
        }
        const r = this._thumbRenderer;
        const size = r.getSize(new THREE.Vector2());
        if (size.x !== w || size.y !== h) r.setSize(w, h, false);
        this.sm.scene.updateMatrixWorld(true);
        rig.cam.updateMatrixWorld(true);
        // frustum helpers are aiming aids for the main view — keep them out of thumbnails
        const helpers = this.rigs.filter((x) => x.helper?.visible);
        for (const x of helpers) x.helper.visible = false;
        try {
            rig.renderInto(r, w, h, this.sm.scene);
            return r.domElement.toDataURL('image/jpeg', 0.65);
        } catch (e) {
            console.warn('[RobCo] thumbnail capture failed:', e);
            return null;
        } finally {
            for (const x of helpers) x.helper.visible = true;
        }
    }

    // --- UI -------------------------------------------------------------
    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Camera  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        // camera selector + add/remove
        const camRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0 4px;');
        this._camSel = el('select', SELECT);
        this._camSel.addEventListener('change', () => this._selectCamera(this._camSel.value));
        this._addBtn = el('button', ICON_BTN, '＋');
        this._addBtn.title = 'Add camera';
        this._addBtn.addEventListener('click', () => this._addCamera());
        this._delBtn = el('button', ICON_BTN, '🗑');
        this._delBtn.title = 'Remove this camera';
        this._delBtn.addEventListener('click', () => this._removeCamera());
        camRow.append(this._camSel, this._addBtn, this._delBtn);
        body.append(camRow);

        // name
        const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        nameRow.append(el('span', 'opacity:.8;width:44px;', 'name'));
        this._nameInp = el('input', TEXT);
        this._nameInp.type = 'text';
        this._nameInp.addEventListener('input', () => {
            this.active.cfg.name = this._nameInp.value || 'Camera';
            const opt = [...this._camSel.options].find((o) => o.value === this.activeId);
            if (opt) opt.textContent = this.active.cfg.name;
            if (this.active.popup?.cap) this.active.popup.cap.textContent = this.active.cfg.name;
            this._save();
        });
        nameRow.append(this._nameInp);
        body.append(nameRow);

        // enable + pop out
        const enRow = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0 6px;');
        const enLbl = el('label', 'display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;');
        this._enCb = el('input'); this._enCb.type = 'checkbox'; this._enCb.style.accentColor = '#2f81f7';
        this._enCb.addEventListener('change', () => this.setRigEnabled(this.active, this._enCb.checked));
        enLbl.append(this._enCb, el('span', 'opacity:.9;', 'Enable camera'));
        this._popBtn = el('button', BTN, '⧉ Pop out');
        this._popBtn.title = 'Open this camera in a separate window';
        this._popBtn.addEventListener('click', () => this.active.openPopup());
        enRow.append(enLbl, this._popBtn);
        body.append(enRow);

        // viewport
        this._canvasWrap = el('div', 'display:none;margin:2px 0 6px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;overflow:hidden;');
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = `display:block;width:${VW}px;height:${VH}px;`;
        this._canvasWrap.append(this._canvas);
        body.append(this._canvasWrap);

        // attach target
        const atRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        atRow.append(el('span', 'opacity:.8;width:44px;', 'attach'));
        this._attachSel = el('select', SELECT);
        this._attachSel.addEventListener('change', () => {
            this.active.cfg.attach = this._attachSel.value;
            this._updateOffsetLabel();
            this.active.attach();
            this.active.applyCam();
            this._save();
            this.sm.redraw?.();
        });
        atRow.append(this._attachSel);
        body.append(atRow);

        // focal length: slider + typed value + fov readout
        const fRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        fRow.append(el('span', 'opacity:.8;width:44px;', 'focal'));
        this._focal = el('input', 'flex:1;min-width:0;accent-color:#2f81f7;');
        this._focal.type = 'range'; this._focal.min = '6'; this._focal.max = '120'; this._focal.step = '1';
        this._focal.addEventListener('input', () => this._setFocal(+this._focal.value));
        this._focalNum = el('input', NUM);
        this._focalNum.type = 'number'; this._focalNum.min = '1'; this._focalNum.max = '800'; this._focalNum.step = '1';
        this._focalNum.title = 'Focal length (mm) — type a value';
        this._focalNum.addEventListener('change', () => this._setFocal(+this._focalNum.value));
        this._focalOut = el('span', 'width:34px;text-align:right;opacity:.9;', '');
        fRow.append(this._focal, this._focalNum, this._focalOut);
        body.append(fRow);

        // offset + rotation
        this._fields = {};
        const triple = (labelText, keys, step, onChange) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            const lbl = el('span', 'width:44px;opacity:.8;', labelText);
            row.append(lbl);
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', onChange);
                this._fields[k] = inp; row.append(inp);
            });
            return { row, lbl };
        };
        const offTriple = triple('off mm', ['ox', 'oy', 'oz'], 5, () => this._applyNumeric());
        this._offLabel = offTriple.lbl;
        body.append(offTriple.row);
        body.append(triple('rot °', ['rx', 'ry', 'rz'], 15, () => this._applyNumeric()).row);

        // near clipping ("start point")
        const nRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        nRow.append(el('span', 'opacity:.8;width:44px;', 'near mm'));
        this._nearInp = el('input', NUM);
        this._nearInp.type = 'number'; this._nearInp.min = '0.1'; this._nearInp.step = '1';
        this._nearInp.title = 'Near clipping distance — geometry closer than this is hidden';
        this._nearInp.addEventListener('change', () => this._applyNear());
        nRow.append(this._nearInp);
        nRow.append(el('span', 'opacity:.55;', 'clip start'));
        body.append(nRow);

        // Exempt the robot from the near clip — only other geometry is clipped by the start point.
        const ncRow = el('label', 'display:flex;align-items:center;gap:8px;margin:2px 0 4px;cursor:pointer;');
        this._noClipCb = el('input'); this._noClipCb.type = 'checkbox'; this._noClipCb.style.accentColor = '#2f81f7';
        this._noClipCb.title = 'Never clip the robot with the near plane — only other geometry is clipped';
        this._noClipCb.addEventListener('change', () => {
            this.active.cfg.noClipRobot = this._noClipCb.checked;
            this._save();
            this.sm.redraw?.();
        });
        ncRow.append(this._noClipCb, el('span', 'opacity:.9;', 'Robot ignores clip'));
        body.append(ncRow);

        // depth of field (Bokeh) — enable + focus distance + blur strength
        const dofRow = el('label', 'display:flex;align-items:center;gap:8px;margin:6px 0 2px;cursor:pointer;');
        this._dofCb = el('input'); this._dofCb.type = 'checkbox'; this._dofCb.style.accentColor = '#2f81f7';
        this._dofCb.title = 'Blur out-of-focus areas (overrides "Robot ignores clip" while on)';
        this._dofCb.addEventListener('change', () => {
            this.active.cfg.dof = this._dofCb.checked;
            if (this._dofCb.checked) this._ensureDofLibs();
            this._updateDofRows();
            this._save();
            this.sm.redraw?.();
        });
        dofRow.append(this._dofCb, el('span', 'opacity:.9;', 'Depth of field'));
        body.append(dofRow);

        this._dofFocusRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        this._dofFocusRow.append(el('span', 'opacity:.8;width:44px;', 'DoF mm'));
        this._dofFocusInp = el('input', NUM);
        this._dofFocusInp.type = 'number'; this._dofFocusInp.min = '10'; this._dofFocusInp.step = '10';
        this._dofFocusInp.title = 'Focus distance — geometry at this distance from the camera is sharp';
        this._dofFocusInp.addEventListener('change', () => {
            this.active.cfg.dofFocusMm = Math.max(10, +this._dofFocusInp.value || CAM_DEFAULTS.dofFocusMm);
            this._dofFocusInp.value = String(this.active.cfg.dofFocusMm);
            this._save(); this.sm.redraw?.();
        });
        this._dofFocusRow.append(this._dofFocusInp);
        this._dofFocusRow.append(el('span', 'opacity:.55;', 'focus dist'));
        body.append(this._dofFocusRow);

        this._dofBlurRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        this._dofBlurRow.append(el('span', 'opacity:.8;width:44px;', 'blur'));
        this._dofBlur = el('input', 'flex:1;min-width:0;accent-color:#2f81f7;');
        this._dofBlur.type = 'range'; this._dofBlur.min = '0'; this._dofBlur.max = '1'; this._dofBlur.step = '0.01';
        this._dofBlur.addEventListener('input', () => { this.active.cfg.dofBlur = +this._dofBlur.value; this._save(); this.sm.redraw?.(); });
        this._dofBlurRow.append(this._dofBlur);
        body.append(this._dofBlurRow);

        // frustum + reset
        const r2 = el('div', 'display:flex;align-items:center;gap:10px;margin-top:6px;');
        const frRow = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;');
        this._frCb = el('input'); this._frCb.type = 'checkbox'; this._frCb.style.accentColor = '#2f81f7';
        this._frCb.addEventListener('change', () => {
            this.active.cfg.showFrustum = this._frCb.checked;
            this.active.setHelperVisible();
            this._save();
            this.sm.redraw?.();
        });
        frRow.append(this._frCb, el('span', 'opacity:.9;', 'Show frustum'));
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => this._reset());
        r2.append(frRow, resetBtn);
        body.append(r2);

        document.body.appendChild(root);
        this.root = root;
        makeCollapsible(body, minBtn, 'camera');
        makeDraggable(root, t, 'camera');
    }

    _rebuildCamSelect() {
        if (!this._camSel) return;
        this._camSel.innerHTML = '';
        this.rigs.forEach((r) => {
            const o = el('option', OPT, r.cfg.name);
            o.value = r.cfg.id;
            this._camSel.append(o);
        });
        this._camSel.value = this.activeId;
        this._delBtn.disabled = this.rigs.length <= 1;
        this._delBtn.style.opacity = this.rigs.length <= 1 ? '0.4' : '1';
    }

    _rebuildJointOptions() {
        if (!this._attachSel) return;
        const order = this.model?.userData?.jointOrder || [];
        this._attachSel.innerHTML = '';
        const tcpOpt = el('option', OPT, 'TCP'); tcpOpt.value = 'tcp';
        const orgOpt = el('option', OPT, 'Origin (world)'); orgOpt.value = 'origin';
        this._attachSel.append(tcpOpt, orgOpt);
        order.forEach((name, i) => {
            const o = el('option', OPT, `Joint J${i + 1}`);
            o.value = name;
            this._attachSel.append(o);
        });
        // Drop any now-invalid joint selections back to TCP.
        for (const r of this.rigs) {
            if (r.cfg.attach !== 'tcp' && r.cfg.attach !== 'origin' && !order.includes(r.cfg.attach)) {
                r.cfg.attach = 'tcp';
            }
        }
        this._attachSel.value = this.active.cfg.attach;
    }

    _setFocal(mm) {
        const v = Math.max(1, +mm || CAM_DEFAULTS.focalMm);
        this.active.cfg.focalMm = v;
        this.active.applyCam();   // recompute fov first so the readout below is current
        this._syncFocalUI(v);
        this._save();
        this.sm.redraw?.();
    }

    _syncFocalUI(mm) {
        const lo = +this._focal.min, hi = +this._focal.max;
        this._focal.value = String(Math.min(hi, Math.max(lo, mm)));
        this._focalNum.value = String(mm);
        this._focalOut.textContent = `${this.active.cam.fov.toFixed(0)}°`;
    }

    _applyNear() {
        this.active.cfg.nearMm = Math.max(0.1, +this._nearInp.value || CAM_DEFAULTS.nearMm);
        this._nearInp.value = String(this.active.cfg.nearMm);
        this.active.applyCam();
        this._save();
        this.sm.redraw?.();
    }

    _applyNumeric() {
        const f = this._fields;
        this.active.cfg.offsetMm = [+f.ox.value || 0, +f.oy.value || 0, +f.oz.value || 0];
        this.active.cfg.rotDeg = [+f.rx.value || 0, +f.ry.value || 0, +f.rz.value || 0];
        this.active.applyCam();
        this._save();
        this.sm.redraw?.();
    }

    _updateOffsetLabel() {
        if (this._offLabel) this._offLabel.textContent = this.active.cfg.attach === 'origin' ? 'pos mm' : 'off mm';
    }

    /** Show the DoF focus/blur controls only while depth of field is enabled. */
    _updateDofRows() {
        const on = !!this.active.cfg.dof;
        if (this._dofFocusRow) this._dofFocusRow.style.display = on ? 'flex' : 'none';
        if (this._dofBlurRow) this._dofBlurRow.style.display = on ? 'flex' : 'none';
    }

    syncPopupBtn() {
        if (!this._popBtn) return;
        this._popBtn.textContent = this.active.hasPopup() ? '⧉ Focus' : '⧉ Pop out';
    }

    /** Load every control from the active camera's config. */
    _syncUIFromActive() {
        const a = this.active;
        if (this._camSel) this._camSel.value = a.cfg.id;
        this._nameInp.value = a.cfg.name;
        this._enCb.checked = !!a.cfg.enabled;
        this._syncFocalUI(a.cfg.focalMm);
        this._frCb.checked = !!a.cfg.showFrustum;
        this._nearInp.value = String(a.cfg.nearMm);
        this._noClipCb.checked = !!a.cfg.noClipRobot;
        this._dofCb.checked = !!a.cfg.dof;
        this._dofFocusInp.value = String(a.cfg.dofFocusMm);
        this._dofBlur.value = String(a.cfg.dofBlur);
        this._updateDofRows();
        const f = this._fields;
        [f.ox.value, f.oy.value, f.oz.value] = a.cfg.offsetMm;
        [f.rx.value, f.ry.value, f.rz.value] = a.cfg.rotDeg;
        if (this._attachSel) this._attachSel.value = a.cfg.attach;
        this._updateOffsetLabel();
        this.syncPopupBtn();
    }

    _reset() {
        const a = this.active;
        a.cfg.attach = 'tcp';
        a.cfg.focalMm = CAM_DEFAULTS.focalMm;
        a.cfg.offsetMm = [...CAM_DEFAULTS.offsetMm];
        a.cfg.rotDeg = [...CAM_DEFAULTS.rotDeg];
        a.cfg.nearMm = CAM_DEFAULTS.nearMm;
        a.cfg.noClipRobot = false;
        a.cfg.dof = false;
        a.cfg.dofFocusMm = CAM_DEFAULTS.dofFocusMm;
        a.cfg.dofBlur = CAM_DEFAULTS.dofBlur;
        this._rebuildJointOptions();
        this._syncUIFromActive();
        a.attach();
        a.applyCam();
        this._save();
        this.sm.redraw?.();
    }

    // --- persistence ----------------------------------------------------
    _load() {
        try {
            const raw = JSON.parse(localStorage.getItem(KEY));
            if (raw && Array.isArray(raw.cameras) && raw.cameras.length) {
                const cameras = raw.cameras.map((c, i) => sanitizeCfg(c, `Camera ${i + 1}`));
                return { cameras, activeId: raw.activeId };
            }
            if (raw && typeof raw === 'object') {
                // v1 single-camera config → wrap it as the first camera.
                return { cameras: [sanitizeCfg({ ...raw, name: 'Camera 1' })], activeId: null };
            }
        } catch { /* ignore */ }
        return { cameras: [sanitizeCfg({ name: 'Camera 1' })], activeId: null };
    }

    _save() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                version: 2,
                activeId: this.activeId,
                cameras: this.rigs.map((r) => r.cfg),
            }));
        } catch { /* ignore */ }
    }

    dispose() {
        if (this._unhook) { this._unhook(); this._unhook = null; }
        this.closeMaster();
        for (const r of this.rigs) r.dispose();
        this.rigs = [];
        for (const e of this._dofComposers.values()) { try { e.composer.dispose(); } catch { /* ignore */ } }
        this._dofComposers.clear();
        this._thumbRenderer?.dispose?.();
        this._thumbRenderer = null;
        this.inRenderer?.dispose?.();
        this.inRenderer = null;
        this.root?.remove();
        if (window._robcoCameraView === this) window._robcoCameraView = null;
    }
}
