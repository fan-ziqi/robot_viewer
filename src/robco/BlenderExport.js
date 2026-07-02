/**
 * BlenderExport — record the arm's motion and export it as a glTF-binary (.glb) with baked
 * node animation, ready to `File → Import → glTF 2.0` into Blender for offline rendering.
 *
 * Motion is captured source-agnostically: a timer samples the model's current joint transforms,
 * so it records whatever is moving the arm — the **live RobFlow stream**, a waypoint-flow run,
 * a teach-gizmo drag, or a jog. Each joint (revolute) contributes a QuaternionKeyframeTrack; the
 * robot root also gets position + quaternion tracks so base-shift motion is captured too.
 *
 * Binding: animation tracks target nodes by their `uuid` (resolved by THREE.PropertyBinding in
 * GLTFExporter), so we never rename the live scene nodes. Export runs on `model.threeObject`
 * with `onlyVisible:true`, which naturally drops the visibility-gated collision/CoM/frame helpers;
 * the TCP-trace line (the one visible non-robot child of the root) is hidden for the export.
 * A loaded end-effector tool hangs off the flange (a visible child of the robot), so it is
 * included automatically — we just re-assert its attachment first in case a live rebuild
 * orphaned it on a stale model.
 *
 * Up-axis: the viewer keeps the robot in its native Z-up frame (SceneManager.world applies a
 * −90°X rotation purely for display), while glTF is Y-up. By default the export therefore wraps
 * the robot in a −90°X group so Blender's importer (Y-up→Z-up) lands it upright; untick
 * "Z-up (Blender)" to export the raw viewer frame instead. The conversion lives on the wrapper —
 * not the root — because the clip's root quaternion track would overwrite a static rotation on
 * the root itself at playback.
 */
import * as THREE from 'three';
import { makeDraggable, makeCollapsible } from './draggable.js';

const MAX_SAMPLES = 12000;      // safety cap (~200 s @ 60 fps / ~400 s @ 30 fps)
const DEFAULT_FPS = 30;
const FPS_CHOICES = [24, 30, 60];
const LS_KEY = 'robco-blender';

const PANEL_CSS =
    'position:fixed;left:16px;bottom:16px;z-index:3000;width:260px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;cursor:pointer;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

function downloadGlb(buffer, filename) {
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class BlenderExport {
    static ensure({ sm, model, teach }) {
        if (window._robcoBlenderExport) {
            window._robcoBlenderExport.repoint({ sm, model, teach });
            return window._robcoBlenderExport;
        }
        const b = new BlenderExport({ sm, model, teach });
        window._robcoBlenderExport = b;
        return b;
    }

    constructor({ sm, model, teach }) {
        this.sm = sm;
        this.model = model;
        this.teach = teach;
        this.recording = false;
        this.samples = [];        // [{ t, jq: [[x,y,z,w],…], rp: [x,y,z], rq: [x,y,z,w] }]
        this._recNodes = null;    // joint Object3D list captured at record start
        this._timer = null;
        this._startT = 0;
        this._capped = false;
        this._busy = false;       // export in flight
        this.fps = DEFAULT_FPS;
        this.zUp = true;              // pre-rotate export so the robot stands upright in Blender
        try {
            const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
            if (FPS_CHOICES.includes(saved.fps)) this.fps = saved.fps;
            if (typeof saved.zUp === 'boolean') this.zUp = saved.zUp;
        } catch { /* ignore */ }
        this._build();
        this._refresh();
    }

    /** Re-point at a freshly (re)built robot. A different arm invalidates any capture. */
    repoint({ sm, model, teach }) {
        this.sm = sm || this.sm;
        this.teach = teach || this.teach;
        if (model && model !== this.model) {
            if (this.recording) this._stop();
            this.model = model;
            this.samples = [];
            this._recNodes = null;
            this._capped = false;
            this._refresh();
        }
    }

    _root() {
        return this.model?.threeObject || null;
    }

    /** Joint Object3D nodes in base->flange order (skips joints without a three object). */
    _jointNodes() {
        const order = this.model?.userData?.jointOrder || [];
        const nodes = [];
        for (const name of order) {
            const node = this.model?.joints?.get(name)?.threeObject;
            if (node) nodes.push(node);
        }
        return nodes;
    }

    _persist() {
        try { localStorage.setItem(LS_KEY, JSON.stringify({ fps: this.fps, zUp: this.zUp })); } catch { /* ignore */ }
    }

    // --- Recording ---------------------------------------------------------

    _start() {
        if (this.recording) return;
        const root = this._root();
        if (!root) return;
        this._recNodes = this._jointNodes();
        this.samples = [];
        this._capped = false;
        this._startT = performance.now();
        this.recording = true;
        this._capture();                       // one immediate keyframe at t=0
        const dt = Math.max(1, Math.round(1000 / this.fps));
        this._timer = setInterval(() => this._capture(), dt);
        this._refresh();
    }

    _stop() {
        this.recording = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this._refresh();
    }

    _capture() {
        const root = this._root();
        if (!root || !this._recNodes) return;
        const jq = this._recNodes.map((n) => {
            const q = n.quaternion;
            return [q.x, q.y, q.z, q.w];
        });
        const rp = [root.position.x, root.position.y, root.position.z];
        const rq = [root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w];
        this.samples.push({ t: performance.now() - this._startT, jq, rp, rq });
        if (this.samples.length >= MAX_SAMPLES) {
            this._capped = true;
            this._stop();               // refreshes
            return;
        }
        this._refresh();                // live-update the time/keys readout
    }

    _clear() {
        if (this.recording) this._stop();
        this.samples = [];
        this._recNodes = null;
        this._capped = false;
        this._refresh();
    }

    // --- Export ------------------------------------------------------------

    _buildClip() {
        const n = this.samples.length;
        const t0 = this.samples[0].t;
        const times = new Float32Array(n);
        for (let i = 0; i < n; i++) times[i] = (this.samples[i].t - t0) / 1000;

        const tracks = [];
        // One quaternion track per joint (revolute: only the joint's rotation changes).
        this._recNodes.forEach((node, j) => {
            const vals = new Float32Array(n * 4);
            for (let i = 0; i < n; i++) {
                const q = this.samples[i].jq[j];
                vals[i * 4] = q[0]; vals[i * 4 + 1] = q[1]; vals[i * 4 + 2] = q[2]; vals[i * 4 + 3] = q[3];
            }
            tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, vals));
        });
        // Root position + quaternion (captures RobFlow base-shift motion).
        const root = this._root();
        const posVals = new Float32Array(n * 3);
        const rqVals = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const s = this.samples[i];
            posVals[i * 3] = s.rp[0]; posVals[i * 3 + 1] = s.rp[1]; posVals[i * 3 + 2] = s.rp[2];
            rqVals[i * 4] = s.rq[0]; rqVals[i * 4 + 1] = s.rq[1]; rqVals[i * 4 + 2] = s.rq[2]; rqVals[i * 4 + 3] = s.rq[3];
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${root.uuid}.position`, times, posVals));
        tracks.push(new THREE.QuaternionKeyframeTrack(`${root.uuid}.quaternion`, times, rqVals));

        return new THREE.AnimationClip('RobCoMotion', times[n - 1] || 0, tracks);
    }

    async _export() {
        const root = this._root();
        if (this._busy || this.recording || !root || this.samples.length < 2) return;
        this._busy = true;
        this._refresh();

        // Make sure a loaded end-effector tool is parented to the current flange (a live rebuild
        // can leave it on a stale model) so it's part of the exported subtree — it rides along as
        // a visible child of the flange node, following the baked joint motion in Blender.
        window._robcoEndEffector?.reattach?.();

        // Hide the TCP-trace polyline (the only visible non-robot child of the root) so it isn't
        // baked into the mesh export; restore afterwards.
        const trace = window._robcoTcpTrace?.line || null;
        const traceWasVisible = trace ? trace.visible : false;
        if (trace) trace.visible = false;

        // Z-up: reparent the root under a −90°X group for the duration of the export, so the
        // Z-up robot data becomes Y-up per the glTF spec and Blender's importer re-erects it.
        // The wrapper joins sm.scene (same net transform as sm.world's display conversion), so
        // the robot stays visibly in place while the exporter's async passes run.
        let wrap = null;
        let prevParent = null;
        if (this.zUp) {
            wrap = new THREE.Group();
            wrap.name = 'ZUp';
            wrap.rotation.x = -Math.PI / 2;
            prevParent = root.parent;
            this.sm?.scene?.add(wrap);
            wrap.add(root);
            wrap.updateMatrixWorld(true);
        }

        try {
            const clip = this._buildClip();
            const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
            const exporter = new GLTFExporter();
            const buffer = await new Promise((resolve, reject) => {
                exporter.parse(
                    wrap || root,
                    (gltf) => resolve(gltf),
                    (err) => reject(err),
                    { binary: true, onlyVisible: true, animations: [clip] },
                );
            });
            downloadGlb(buffer, 'robco-motion.glb');
            this._status.textContent = `exported robco-motion.glb (${this.samples.length} keys)`;
            this._status.style.color = '#3fb950';
        } catch (e) {
            console.error('[RobCo] Blender export failed:', e);
            this._status.textContent = `export failed: ${e?.message || e}`;
            this._status.style.color = '#f85149';
        } finally {
            if (wrap) {
                if (prevParent) prevParent.add(root);
                else wrap.remove(root);
                wrap.removeFromParent();
                prevParent?.updateMatrixWorld(true);
            }
            if (trace) trace.visible = traceWasVisible;
            this._busy = false;
            this._refresh();
        }
    }

    // --- UI ----------------------------------------------------------------

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Blender Export  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);

        const body = el('div', 'margin-top:8px;');
        root.append(body);

        this._big = el('div', 'font:700 15px ui-monospace,monospace;color:#fff;', 'idle');
        body.append(this._big);

        const row = el('div', 'display:flex;gap:6px;align-items:center;margin-top:8px;');
        this._recBtn = el('button', BTN, '● Record');
        this._recBtn.addEventListener('click', () => (this.recording ? this._stop() : this._start()));
        this._clearBtn = el('button', BTN, 'Clear');
        this._clearBtn.addEventListener('click', () => this._clear());
        row.append(this._recBtn, this._clearBtn);
        body.append(row);

        const fpsRow = el('div', 'display:flex;gap:6px;align-items:center;margin-top:6px;');
        fpsRow.append(el('span', 'color:#9da7b3;', 'fps'));
        this._fpsSel = el('select', 'flex:1;font:11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px;');
        for (const f of FPS_CHOICES) {
            const opt = el('option', null, String(f));
            opt.value = String(f);
            if (f === this.fps) opt.selected = true;
            this._fpsSel.append(opt);
        }
        this._fpsSel.addEventListener('change', () => {
            this.fps = Number(this._fpsSel.value) || DEFAULT_FPS;
            this._persist();
        });
        fpsRow.append(this._fpsSel);
        body.append(fpsRow);

        const zRow = el('label', 'display:flex;gap:6px;align-items:center;margin-top:6px;color:#9da7b3;cursor:pointer;');
        this._zUpChk = el('input');
        this._zUpChk.type = 'checkbox';
        this._zUpChk.style.cssText = 'margin:0;accent-color:#3fb950;';
        this._zUpChk.checked = this.zUp;
        this._zUpChk.addEventListener('change', () => {
            this.zUp = this._zUpChk.checked;
            this._persist();
        });
        zRow.append(this._zUpChk, el('span', null, 'Z-up (upright in Blender)'));
        body.append(zRow);

        this._exportBtn = el('button', BTN + 'width:100%;margin-top:8px;', 'Export .glb');
        this._exportBtn.addEventListener('click', () => this._export());
        body.append(this._exportBtn);

        this._status = el('div', 'font-size:10px;color:#6e7681;margin-top:6px;min-height:12px;');
        body.append(this._status);

        body.append(el('div', 'font-size:10px;color:#6e7681;margin-top:6px;',
            'Records the arm’s motion (incl. the live stream). Import in Blender: File → Import → glTF 2.0. ' +
            'Z-up pre-rotates the export so the robot stands upright in Blender; untick to keep the viewer’s native axes.'));

        makeCollapsible(body, minBtn, 'blender');
        document.body.appendChild(root);
        this.root = root;
        this.body = body;
        makeDraggable(root, t, 'blender');
    }

    _refresh() {
        const n = this.samples.length;
        const secs = n > 1 ? (this.samples[n - 1].t - this.samples[0].t) / 1000 : 0;
        if (this.recording) {
            this._big.textContent = `● REC  ${secs.toFixed(1)}s · ${n} keys`;
            this._big.style.color = '#f85149';
            this._recBtn.textContent = '■ Stop';
        } else {
            this._big.textContent = n > 0 ? `${secs.toFixed(1)}s · ${n} keys${this._capped ? ' (max)' : ''}` : 'idle';
            this._big.style.color = n > 0 ? '#e6edf3' : '#9da7b3';
            this._recBtn.textContent = '● Record';
        }
        const canExport = !this.recording && !this._busy && n >= 2;
        this._exportBtn.disabled = !canExport;
        this._exportBtn.style.opacity = canExport ? '1' : '0.5';
        this._recBtn.disabled = this._busy || !this._root();
        if (this._busy) { this._status.textContent = 'exporting…'; this._status.style.color = '#9da7b3'; }
    }

    dispose() {
        this._stop();
        this.root?.remove();
        this.samples = [];
        this._recNodes = null;
        if (window._robcoBlenderExport === this) window._robcoBlenderExport = null;
    }
}
