/**
 * CameraView — a virtual camera rigidly mounted to the robot's TCP (or a chosen joint), with a
 * live viewport rendering that camera's perspective.
 *
 * The camera is parented into the robot's scene graph (flange link for the TCP, or a joint's
 * threeObject) exactly like EndEffector mounts a tool, so it follows the arm for free. The viewport
 * is a second small WebGLRenderer drawing the shared scene from this camera, driven by the
 * SceneManager frame hook (on-demand — only on frames the main loop already draws).
 *
 * Controls (a standalone draggable/collapsible "Camera" panel): enable, attach target (TCP / Jn),
 * focal length (mm), position + rotation offset relative to the mount, and a frustum toggle.
 * Settings persist to localStorage. Singleton (window._robcoCameraView); repoints on robot rebuild.
 */
import * as THREE from 'three';
import { makeDraggable, makeCollapsible } from './draggable.js';

const KEY = 'robco-camera';
const D2R = Math.PI / 180;
const VW = 300, VH = 190; // viewport size (px)
const PANEL_CSS =
    'position:fixed;right:16px;top:360px;z-index:3000;width:300px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
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

const DEFAULTS = { enabled: false, attach: 'tcp', focalMm: 24, offsetMm: [0, 0, 0], rotDeg: [0, 180, 0], showFrustum: true };

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
        this.cfg = this._load();

        this.cam = new THREE.PerspectiveCamera(50, VW / VH, 0.01, 100);
        this.cam.matrixAutoUpdate = false; // driven by parent chain · our explicit local matrix
        this.cam.filmGauge = 35;

        this.renderer = null;
        this.helper = null;
        this._unhook = null;

        this._build();
        this._rebuildJointOptions();
        this._applyCfgToUI();
        this._attach();
        this._applyCam();
        if (this.cfg.enabled) this.setEnabled(true);
    }

    /** Re-point at a (re)built robot: re-attach the camera + refresh the joint list. */
    repoint({ sm, model, teach }) {
        const modelChanged = model && model !== this.model;
        if (sm) this.sm = sm;
        if (teach) this.teach = teach;
        if (model) this.model = model;
        if (modelChanged) {
            this._rebuildJointOptions();
            this._attach();
            this._applyCam();
            if (this._unhook) { this._unhook(); this._unhook = null; } // re-arm on the new SceneManager
            if (this.cfg.enabled) this._unhook = this.sm.addFrameHook(() => this._onFrame());
            this.sm.redraw?.();
        }
    }

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
        if (!this.cfg.attach || this.cfg.attach === 'tcp') return this._flange();
        const j = this.model?.joints?.get(this.cfg.attach);
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

    _attach() {
        const target = this._targetObject();
        if (this.cam.parent) this.cam.parent.remove(this.cam);
        if (target) target.add(this.cam);
        this._applyCamMatrix();
    }

    _applyCamMatrix() {
        this.cam.matrix.copy(this._baseMatrix().multiply(this._offsetMatrix()));
        this.cam.matrixWorldNeedsUpdate = true;
    }

    /** Apply focal length + local matrix, and refresh the readout. */
    _applyCam() {
        this.cam.aspect = VW / VH;
        this.cam.setFocalLength(this.cfg.focalMm); // sets fov + updateProjectionMatrix (35mm gauge)
        this._applyCamMatrix();
        this.helper?.update();
        if (this._focalOut) this._focalOut.textContent = `${Math.round(this.cfg.focalMm)}mm · ${this.cam.fov.toFixed(0)}°`;
        this.sm.redraw?.();
    }

    // --- lifecycle ------------------------------------------------------
    setEnabled(on) {
        this.cfg.enabled = !!on;
        if (this.cfg.enabled) {
            this._ensureRenderer();
            this._ensureHelper();
            if (!this._unhook) this._unhook = this.sm.addFrameHook(() => this._onFrame());
            if (this._canvasWrap) this._canvasWrap.style.display = 'block';
        } else {
            if (this._unhook) { this._unhook(); this._unhook = null; }
            if (this._canvasWrap) this._canvasWrap.style.display = 'none';
        }
        this._setHelperVisible();
        this._save();
        this.sm.redraw?.();
    }

    _ensureRenderer() {
        if (this.renderer) return;
        const r = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.setSize(VW, VH, false); // backing store only; canvas CSS size is fixed
        r.outputColorSpace = THREE.SRGBColorSpace;
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        this.renderer = r;
    }

    _ensureHelper() {
        if (this.helper || !this.sm?.scene) return;
        this.helper = new THREE.CameraHelper(this.cam);
        this.sm.scene.add(this.helper);
        this._setHelperVisible();
    }

    _setHelperVisible() {
        if (this.helper) this.helper.visible = !!(this.cfg.enabled && this.cfg.showFrustum);
    }

    /** After the main frame: matrices are current — render the viewport + refresh the frustum. */
    _onFrame() {
        if (!this.cfg.enabled || !this.renderer || !this.sm?.scene) return;
        this.cam.updateMatrixWorld(true);
        this.renderer.render(this.sm.scene, this.cam);
        if (this.helper && this.helper.visible) this.helper.update();
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

        // enable
        const enRow = el('label', 'display:flex;align-items:center;gap:8px;margin:2px 0 6px;cursor:pointer;');
        this._enCb = el('input'); this._enCb.type = 'checkbox'; this._enCb.style.accentColor = '#2f81f7';
        this._enCb.addEventListener('change', () => this.setEnabled(this._enCb.checked));
        enRow.append(this._enCb, el('span', 'opacity:.9;', 'Enable camera'));
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
        this._attachSel.addEventListener('change', () => { this.cfg.attach = this._attachSel.value; this._attach(); this._save(); this.sm.redraw?.(); });
        atRow.append(this._attachSel);
        body.append(atRow);

        // focal length
        const fRow = el('div', 'display:grid;grid-template-columns:44px 1fr 74px;gap:8px;align-items:center;margin:4px 0;');
        fRow.append(el('span', 'opacity:.8;', 'focal'));
        this._focal = el('input', 'width:100%;accent-color:#2f81f7;');
        this._focal.type = 'range'; this._focal.min = '6'; this._focal.max = '120'; this._focal.step = '1';
        this._focal.addEventListener('input', () => { this.cfg.focalMm = +this._focal.value; this._applyCam(); this._save(); });
        this._focalOut = el('span', 'text-align:right;opacity:.9;', '');
        fRow.append(this._focal, this._focalOut);
        body.append(fRow);

        // offset + rotation
        this._fields = {};
        const triple = (label, keys, step, onChange) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:44px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', onChange);
                this._fields[k] = inp; row.append(inp);
            });
            return row;
        };
        body.append(triple('off mm', ['ox', 'oy', 'oz'], 5, () => this._applyNumeric()));
        body.append(triple('rot °', ['rx', 'ry', 'rz'], 15, () => this._applyNumeric()));

        // frustum + reset
        const r2 = el('div', 'display:flex;align-items:center;gap:10px;margin-top:6px;');
        const frRow = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;');
        this._frCb = el('input'); this._frCb.type = 'checkbox'; this._frCb.style.accentColor = '#2f81f7';
        this._frCb.addEventListener('change', () => { this.cfg.showFrustum = this._frCb.checked; this._setHelperVisible(); this._save(); this.sm.redraw?.(); });
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

    _rebuildJointOptions() {
        if (!this._attachSel) return;
        const order = this.model?.userData?.jointOrder || [];
        this._attachSel.innerHTML = '';
        const tcpOpt = el('option', OPT, 'TCP'); tcpOpt.value = 'tcp';
        this._attachSel.append(tcpOpt);
        order.forEach((name, i) => {
            const o = el('option', OPT, `Joint J${i + 1}`);
            o.value = name;
            this._attachSel.append(o);
        });
        // Keep the current selection if still valid, else fall back to TCP.
        if (this.cfg.attach !== 'tcp' && !order.includes(this.cfg.attach)) this.cfg.attach = 'tcp';
        this._attachSel.value = this.cfg.attach;
    }

    _applyNumeric() {
        const f = this._fields;
        this.cfg.offsetMm = [+f.ox.value || 0, +f.oy.value || 0, +f.oz.value || 0];
        this.cfg.rotDeg = [+f.rx.value || 0, +f.ry.value || 0, +f.rz.value || 0];
        this._applyCam();
        this._save();
    }

    _applyCfgToUI() {
        this._enCb.checked = !!this.cfg.enabled;
        this._focal.value = String(this.cfg.focalMm);
        this._frCb.checked = !!this.cfg.showFrustum;
        const f = this._fields;
        [f.ox.value, f.oy.value, f.oz.value] = this.cfg.offsetMm;
        [f.rx.value, f.ry.value, f.rz.value] = this.cfg.rotDeg;
        if (this._attachSel) this._attachSel.value = this.cfg.attach;
    }

    _reset() {
        this.cfg.attach = 'tcp';
        this.cfg.focalMm = DEFAULTS.focalMm;
        this.cfg.offsetMm = [...DEFAULTS.offsetMm];
        this.cfg.rotDeg = [...DEFAULTS.rotDeg];
        this._rebuildJointOptions();
        this._applyCfgToUI();
        this._attach();
        this._applyCam();
        this._save();
    }

    // --- persistence ----------------------------------------------------
    _load() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY));
            if (s && typeof s === 'object') {
                return {
                    enabled: !!s.enabled,
                    attach: typeof s.attach === 'string' ? s.attach : 'tcp',
                    focalMm: s.focalMm > 0 ? s.focalMm : DEFAULTS.focalMm,
                    offsetMm: Array.isArray(s.offsetMm) && s.offsetMm.length === 3 ? s.offsetMm : [...DEFAULTS.offsetMm],
                    rotDeg: Array.isArray(s.rotDeg) && s.rotDeg.length === 3 ? s.rotDeg : [...DEFAULTS.rotDeg],
                    showFrustum: s.showFrustum !== false,
                };
            }
        } catch { /* ignore */ }
        return { ...DEFAULTS, offsetMm: [...DEFAULTS.offsetMm], rotDeg: [...DEFAULTS.rotDeg] };
    }

    _save() {
        try { localStorage.setItem(KEY, JSON.stringify(this.cfg)); } catch { /* ignore */ }
    }

    dispose() {
        if (this._unhook) { this._unhook(); this._unhook = null; }
        if (this.cam.parent) this.cam.parent.remove(this.cam);
        if (this.helper) { this.helper.parent?.remove(this.helper); this.helper.dispose?.(); this.helper = null; }
        this.renderer?.dispose?.();
        this.renderer = null;
        this.root?.remove();
        if (window._robcoCameraView === this) window._robcoCameraView = null;
    }
}
