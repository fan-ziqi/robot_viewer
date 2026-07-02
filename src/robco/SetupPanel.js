/**
 * Setup panel — cell layout controls, in the same draggable/minimizable style as the View
 * and Render panels. Collapsible sections:
 *   Base          : reposition the robot base within the world (numeric + gizmo).
 *   Scene Objects : import background/prop GLBs, align/hide/fade them (SceneObjects.js).
 *   End-Effector  : import tool GLBs, swap the active one, set mass + CoM (EndEffector.js).
 *   Material      : import grippable workpiece GLBs (MaterialManager.js).
 *
 * A single shared TransformControls gizmo is reused across sections (only one editable at a
 * time, via `_edit`/`_stopEdit` below). The Base section drives BaseFrame directly (worldGroup =
 * inverse(basePose)); the other sections are self-contained managers that call back into `_edit`
 * and `addSection` — this file owns only the shared gizmo plumbing and the Base section.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { makeDraggable, makeCollapsible } from './draggable.js';
import { registerManipulator, activateManipulator, deactivateManipulator } from './manipulators.js';
import { SceneObjects } from './SceneObjects.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:330px;z-index:3000;width:272px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);max-height:80vh;overflow:auto;';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'width:46px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function sectionTitle(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', t);
}

export class SetupPanel {
    static ensure(sm, baseFrame) {
        if (window._robcoSetupPanel) {
            window._robcoSetupPanel.sm = sm;
            window._robcoSetupPanel.base = baseFrame;
            return window._robcoSetupPanel;
        }
        const p = new SetupPanel(sm, baseFrame);
        window._robcoSetupPanel = p;
        return p;
    }

    constructor(sm, baseFrame) {
        this.sm = sm;
        this.base = baseFrame;
        this._editing = null; // current gizmo target name
        this._build();
        // Arbiter: another manipulator activating closes this gizmo.
        registerManipulator('setup-gizmo', () => this._stopEdit());
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Setup  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);
        this._body = body;

        // shared gizmo mode bar
        this._modeBar = el('div', 'display:none;gap:6px;margin:4px 0;align-items:center;');
        this._modeBar.append(el('span', 'opacity:.7;', 'gizmo:'));
        ['translate', 'rotate', 'scale'].forEach((m) => {
            const b = el('button', BTN, m === 'translate' ? 'move' : m === 'rotate' ? 'rot' : 'scale');
            b.dataset.mode = m;
            b.addEventListener('click', () => this._setMode(m));
            this._modeBar.append(b);
        });
        const done = el('button', BTN, 'done');
        done.addEventListener('click', () => this._stopEdit());
        this._modeBar.append(done);

        body.append(this._buildBaseSection());
        body.append(this._modeBar);
        this.sceneObjects = new SceneObjects(this);
        body.append(this.sceneObjects.section);

        makeCollapsible(body, minBtn, 'setup');

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'setup');
    }

    addSection(node) { this._body.append(node); }

    // --- shared gizmo --------------------------------------------------
    _ensureGizmo() {
        if (this._tc) return this._tc;
        const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
        tc.setSpace('world');
        tc.setSize(0.7);
        tc.addEventListener('dragging-changed', (e) => { this.sm.controls.enabled = !e.value; });
        tc.addEventListener('objectChange', () => { this._onGizmo?.(); });
        this.sm.scene.add(tc);
        this._tc = tc;
        return tc;
    }

    _edit(name, target, modes, onChange) {
        activateManipulator('setup-gizmo'); // turn off teach gizmo / FK drag
        const tc = this._ensureGizmo();
        tc.attach(target);
        tc.setMode(modes[0]);
        tc.visible = true;
        tc.enabled = true;
        this._editing = name;
        this._onGizmo = onChange;
        this._allowedModes = modes;
        this._modeBar.style.display = 'flex';
        // dim mode buttons not allowed for this target (e.g. base has no scale)
        [...this._modeBar.querySelectorAll('button[data-mode]')].forEach((b) => {
            b.style.opacity = modes.includes(b.dataset.mode) ? '1' : '0.3';
        });
        this.sm.redraw?.();
    }

    _stopEdit() {
        if (this._tc) { this._tc.visible = false; this._tc.enabled = false; this._tc.detach(); }
        this._editing = null;
        this._onGizmo = null;
        this._modeBar.style.display = 'none';
        if (this.sm?.controls) this.sm.controls.enabled = true; // never leave orbit disabled
        deactivateManipulator('setup-gizmo');
        this.sm.redraw?.();
    }

    _setMode(m) {
        if (this._allowedModes && !this._allowedModes.includes(m)) return;
        this._tc?.setMode(m);
    }

    // --- Base section --------------------------------------------------
    _buildBaseSection() {
        const wrap = el('div');
        wrap.append(sectionTitle('Base position (in cell)'));
        wrap.append(el('div', 'font-size:10px;color:#6e7681;margin:-2px 0 5px;',
            'Robot stays at origin; the scene + waypoints move so you can test base placements.'));

        this._baseFields = {};
        const triple = (label, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:34px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applyBaseNumeric());
                this._baseFields[k] = inp;
                row.append(inp);
            });
            return row;
        };
        wrap.append(triple('mm', ['x', 'y', 'z'], 10));
        wrap.append(triple('deg', ['rx', 'ry', 'rz'], 5));

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        const editBtn = el('button', BTN, 'Drag world');
        editBtn.addEventListener('click', () =>
            this._edit('base', this.base.worldGroup, ['translate', 'rotate'],
                () => { this.base.recomputeFromWorld(); this._refreshBase(); }));
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => { this.base.reset(); this._refreshBase(); });
        btnRow.append(editBtn, resetBtn);
        wrap.append(btnRow);

        this._refreshBase();
        return wrap;
    }

    _applyBaseNumeric() {
        const f = this._baseFields;
        const pos = new THREE.Vector3((+f.x.value || 0) / 1000, (+f.y.value || 0) / 1000, (+f.z.value || 0) / 1000);
        const e = new THREE.Euler((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R, 'XYZ');
        this.base.setBasePose(pos, new THREE.Quaternion().setFromEuler(e));
    }

    _refreshBase() {
        const r = this.base.readout();
        const f = this._baseFields;
        const set = (k, v) => { if (f[k]) f[k].value = Math.round(v * 100) / 100; };
        set('x', r.x); set('y', r.y); set('z', r.z); set('rx', r.rx); set('ry', r.ry); set('rz', r.rz);
    }
}
