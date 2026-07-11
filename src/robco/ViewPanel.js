/**
 * View panel — visualization toggles + manual interaction, in the Render-Settings style
 * (draggable, minimizable). Hooks into the managers SceneManager already owns.
 *
 *   Geometry    : visual / collision meshes
 *   Inertia     : per-link centre-of-mass markers + inertia ellipsoids
 *   Frames      : link coordinate axes + joint axes
 *   Highlight   : hover-highlight a link (shows its name + mass)
 *   Interaction : per-joint sliders (FK) + drag-to-rotate (FK joint drag)
 *   Screenshot  : save the canvas as a PNG
 */
import * as THREE from 'three';
import { setRayFromCamera } from '../utils/pickRay.js';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { makeDraggable, makeCollapsible } from './draggable.js';
import { registerManipulator, activateManipulator, deactivateManipulator } from './manipulators.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:64px;z-index:3000;width:250px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function title(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', t);
}

export class ViewPanel {
    static ensure(sm, model) {
        if (window._robcoViewPanel) {
            window._robcoViewPanel.setModel(model);
            return window._robcoViewPanel;
        }
        const p = new ViewPanel(sm, model);
        window._robcoViewPanel = p;
        return p;
    }

    constructor(sm, model) {
        this.sm = sm;
        this.model = model;
        this._toggles = {}; // key -> {cb, onChange} so a session can save/restore each toggle
        this._build();
    }

    _model() { return this.sm.currentModel || this.model; }

    setModel(model) {
        this.model = model;
        this._buildJointSliders();
    }

    _check(labelText, onChange, checked = false, key = null) {
        const row = el('label', 'display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer;');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = checked; cb.style.accentColor = '#2f81f7';
        cb.addEventListener('change', () => { try { onChange(cb.checked); } catch (e) { console.warn('[RobCo] view toggle:', e); } this._render(); });
        row.append(cb, el('span', 'opacity:.9;', labelText));
        if (key) this._toggles[key] = { cb, onChange };
        return row;
    }

    /** Current on/off state of every named toggle — for a session snapshot. */
    getState() {
        const s = {};
        for (const k of Object.keys(this._toggles)) s[k] = !!this._toggles[k].cb.checked;
        return s;
    }

    /** Apply a saved toggle state: flip the checkbox and run its action only where it differs. */
    applyState(state) {
        if (!state) return;
        for (const k of Object.keys(state)) {
            const t = this._toggles[k];
            if (!t) continue;
            const want = !!state[k];
            if (t.cb.checked === want) continue;
            t.cb.checked = want;
            try { t.onChange(want); } catch (e) { console.warn('[RobCo] view applyState', k, e); }
        }
        this._render();
    }

    _render() { this.sm.redraw?.(); this.sm.render?.(); }

    /** Toggle the reference grid (kept in sync with the EnvironmentManager copy). */
    _setGridVisible(on) {
        const grid = this.sm.referenceGrid || this.sm.environmentManager?.referenceGrid;
        if (grid) grid.visible = on;
        this._render();
    }

    /** Lazy-load the convex-decomposition collision STLs on first enable, then toggle them. */
    async _setCollision(on) {
        const nodes = this._model()?.userData?.moduleNodes || [];
        if (on && !this._collisionLoaded) {
            this._collisionLoaded = true;
            if (this._hoverOut) this._hoverOut.textContent = 'loading collision meshes…';
            await Promise.all(nodes.map((n) => n.loadCollision?.()));
            const count = nodes.reduce((s, n) => s + (n._collisionMeshes?.length || 0), 0);
            if (this._hoverOut) this._hoverOut.textContent = `collision: ${count} meshes`;
            console.log(`[RobCo] collision meshes loaded: ${count} from ${nodes.length} modules`);
        }
        nodes.forEach((n) => n.setCollisionVisible?.(on));
        this._render();
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'View  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        // Geometry
        body.append(title('Geometry'));
        body.append(this._check('Visual meshes', (on) => this.sm.visualizationManager?.toggleVisual(on, this._model()), true, 'visual'));
        body.append(this._check('Collision meshes', (on) => this._setCollision(on), false, 'collision'));
        body.append(this._check('Waypoints', (on) => window._robcoWaypointStore?.setVisible(on), true, 'waypoints'));

        // Scene
        body.append(title('Scene'));
        const grid = this.sm.referenceGrid || this.sm.environmentManager?.referenceGrid;
        body.append(this._check('Reference grid', (on) => this._setGridVisible(on), grid ? grid.visible !== false : true, 'grid'));

        // Trace — draw the path the TCP sweeps (any motion source). Engine lives on the global,
        // created with the teach pendant (same lazy pattern as the Waypoints toggle above).
        body.append(title('Trace'));
        body.append(this._check('TCP trace', (on) => window._robcoTcpTrace?.setEnabled(on), false, 'tcpTrace'));
        const clearTrace = el('button', BTN + 'margin:2px 0;', 'Clear trace');
        clearTrace.addEventListener('click', () => { window._robcoTcpTrace?.clear(); this._render(); });
        body.append(clearTrace);

        // Inertia
        body.append(title('Inertia'));
        body.append(this._check('Center of mass', (on) => this.sm.inertialVisualization?.toggleCenterOfMass(on, this._model()), false, 'com'));
        body.append(this._check('Inertia tensors', (on) => this.sm.inertialVisualization?.toggleInertia(on, this._model()), false, 'inertia'));

        // Frames
        body.append(title('Frames'));
        body.append(this._check('Link axes', (on) => on ? this.sm.axesManager?.showAllAxes() : this.sm.axesManager?.hideAllAxes(), false, 'linkAxes'));
        body.append(this._check('Joint axes', (on) => on ? this.sm.axesManager?.showAllJointAxes() : this.sm.axesManager?.hideAllJointAxes(), false, 'jointAxes'));

        // Highlight (custom hover; shows link name + mass)
        body.append(title('Highlight'));
        body.append(this._check('Hover highlight', (on) => this._setHover(on)));
        this._hoverOut = el('div', 'font-size:11px;color:#9da7b3;min-height:15px;margin-top:2px;');
        body.append(this._hoverOut);

        // Interaction
        body.append(title('Interaction'));
        const fkRow = this._check('Drag joints (FK)', (on) => this._setFkDrag(on));
        this._fkCheckbox = fkRow.querySelector('input');
        body.append(fkRow);
        // Arbiter: another manipulator activating turns FK drag off (+ uncheck the box).
        registerManipulator('fk-drag', () => {
            if (this._fkDrag?.enabled) {
                this._fkDrag.enabled = false;
                if (this._fkCheckbox) this._fkCheckbox.checked = false;
                if (window._robcoApp) window._robcoApp._teachActive = false;
                if (this.sm?.controls) this.sm.controls.enabled = true;
            }
        });
        const sliderToggle = el('button', BTN + 'margin:4px 0;', 'Joint sliders ▾');
        body.append(sliderToggle);
        this._sliderBox = el('div', 'display:none;');
        body.append(this._sliderBox);
        sliderToggle.addEventListener('click', () => {
            const show = this._sliderBox.style.display === 'none';
            this._sliderBox.style.display = show ? 'block' : 'none';
            sliderToggle.textContent = show ? 'Joint sliders ▴' : 'Joint sliders ▾';
        });
        this._buildJointSliders();

        // Screenshot
        body.append(title('Export'));
        const shot = el('button', BTN, 'Screenshot (PNG)');
        shot.addEventListener('click', () => this._screenshot());
        body.append(shot);

        makeCollapsible(body, minBtn, 'view');

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'view');
    }

    // --- joint sliders (FK) --------------------------------------------
    _buildJointSliders() {
        if (!this._sliderBox) return;
        this._sliderBox.innerHTML = '';
        const model = this._model();
        const order = model?.userData?.jointOrder || [];
        order.forEach((name, i) => {
            const joint = model.joints.get(name);
            if (!joint) return;
            const lo = joint.limits?.lower ?? -Math.PI;
            const hi = joint.limits?.upper ?? Math.PI;
            const row = el('div', 'display:grid;grid-template-columns:26px 1fr 44px;gap:6px;align-items:center;margin:3px 0;');
            row.append(el('span', 'opacity:.8;', `J${i + 1}`));
            const input = el('input', 'width:100%;accent-color:#2f81f7;');
            input.type = 'range'; input.min = lo; input.max = hi; input.step = 0.001;
            input.value = joint.currentValue ?? 0;
            const out = el('span', 'text-align:right;opacity:.9;', ((joint.currentValue ?? 0) * 180 / Math.PI).toFixed(1) + '°');
            input.addEventListener('input', () => {
                const rad = +input.value;
                out.textContent = (rad * 180 / Math.PI).toFixed(1) + '°';
                ModelLoaderFactory.setJointAngle(model, name, rad);
                const deg = order.map((n) => (model.joints.get(n)?.currentValue ?? 0) * 180 / Math.PI);
                window._robcoDynamics?.updateStatic?.(deg);
                this._render();
            });
            row.append(input, out);
            this._sliderBox.append(row);
        });
    }

    // --- hover highlight (self-contained; no dependency on removed UI) --
    _setHover(on) {
        const dom = this.sm.renderer?.domElement;
        if (!dom) return;
        if (on && !this._hoverHandler) {
            const raycaster = new THREE.Raycaster();
            const mouse = new THREE.Vector2();
            this._hoverHandler = (e) => {
                const r = dom.getBoundingClientRect();
                mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
                mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
                setRayFromCamera(raycaster, mouse, this.sm.camera);
                const model = this._model();
                if (!model?.threeObject) return;
                const hits = raycaster.intersectObject(model.threeObject, true);
                this._highlight(hits[0]?.object || null);
            };
            dom.addEventListener('pointermove', this._hoverHandler);
        } else if (!on && this._hoverHandler) {
            dom.removeEventListener('pointermove', this._hoverHandler);
            this._hoverHandler = null;
            this._highlight(null);
            this._hoverOut.textContent = '';
        }
    }

    _highlight(obj) {
        // find the owning link node (named *_proximal / *_distal)
        let node = obj;
        const links = this._model()?.links;
        while (node && !(links && links.has(node.name))) node = node.parent;
        if (this._hl === node) return;
        if (this._hl) {
            this._hl.traverse((c) => {
                if (c.isMesh && c.material?.emissive && c.userData._em) {
                    c.material.emissive.setHex(c.userData._em.h);
                    c.material.emissiveIntensity = c.userData._em.i;
                }
            });
        }
        this._hl = node || null;
        if (node) {
            node.traverse((c) => {
                if (c.isMesh && c.material?.emissive) {
                    c.userData._em = { h: c.material.emissive.getHex(), i: c.material.emissiveIntensity };
                    c.material.emissive.setHex(0x2f81f7);
                    c.material.emissiveIntensity = 0.4;
                }
            });
            const link = links.get(node.name);
            const d = link?.userData?.descriptor;
            const mass = link?.inertial?.mass;
            this._hoverOut.textContent = `${d?.name || node.name}${mass ? ` · ${mass.toFixed(2)} kg` : ''}`;
        } else {
            this._hoverOut.textContent = '';
        }
        this._render();
    }

    // --- FK joint drag --------------------------------------------------
    async _setFkDrag(on) {
        if (on && !this._fkDrag) {
            const { PointerJointDragControls } = await import('../utils/JointDragControls.js');
            this._fkDrag = new PointerJointDragControls(this.sm.scene, this.sm.camera, this.sm.renderer.domElement, this._model());
            // Disable OrbitControls only while actually dragging a joint, so the camera
            // doesn't orbit at the same time; restore it on release.
            this._fkDrag.onDragStart = () => { if (this.sm.controls) this.sm.controls.enabled = false; };
            this._fkDrag.onDragEnd = () => { if (this.sm.controls) this.sm.controls.enabled = true; };
        }
        if (this._fkDrag) this._fkDrag.enabled = on;
        if (on) activateManipulator('fk-drag'); // turn off teach gizmo / Setup gizmo
        else { deactivateManipulator('fk-drag'); if (this.sm?.controls) this.sm.controls.enabled = true; }
        // Pause the live WS mirror while FK-dragging so streamed angles don't fight the drag.
        if (window._robcoApp) window._robcoApp._teachActive = on;
    }

    _screenshot() {
        try {
            this.sm.render?.();
            const url = this.sm.renderer.domElement.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = url; a.download = 'robco-view.png';
            document.body.appendChild(a); a.click(); a.remove();
        } catch (e) {
            console.warn('[RobCo] screenshot failed:', e);
        }
    }
}
