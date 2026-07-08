/**
 * PathSingularityManager — draws the offline singularity/velocity analysis of the Cartesian (LIN)
 * segments between waypoints, directly in the scene.
 *
 * For every consecutive move pair whose DESTINATION is a cartesian waypoint (i.e. a straight-line
 * LIN move is actually commanded), it runs scanCartesianPath() and renders:
 *   - a heat-coloured polyline along the straight TCP path (green ok / amber warn / red fault /
 *     purple unreachable), coloured per sample by the controller's σ thresholds;
 *   - a marker + text label at the worst point (closest approach to a singularity), showing the
 *     likely type (wrist / boundary-elbow / shoulder), σ, and the predicted speed;
 *   - an arrow at the worst point along the Cartesian direction the arm can least move (the σ_min
 *     twist), i.e. the lost DOF.
 *
 * Geometry is authored in WORLD coordinates under BaseFrame.worldGroup (like the waypoint markers),
 * so it tracks base moves. The analysis itself runs in the base/flange frame via teach.kin; σ is
 * tool-offset invariant so a flange scan matches the controller's TCP index.
 *
 * v1 note: with a non-zero tool offset the analyzed flange line and the drawn tool-tip line differ
 * slightly (both are straight, but a rigid offset doesn't commute with slerp); σ is unaffected.
 */
import * as THREE from 'three';
import { scanCartesianPath } from '../dynamics/pathSingularity.js';
import { SINGULARITY_FAULT_INDEX, SINGULARITY_WARN_INDEX } from '../dynamics/singularity.js';

const CLASS_COLOR = {
    ok: 0x2ea043,
    warn: 0xe3873a,
    fault: 0xf85149,
    unreachable: 0x8957e5,
};
const SAMPLES = 21;
const DEFAULT_DQ_ABS = 6.28; // module max_velocity (rad/s) — uniform default for headroom
const CART_VEL = 0.25;       // commanded translational speed (m/s), controller manual-mode limit
const REFRESH_DEBOUNCE_MS = 150;

const D2R = Math.PI / 180;

export class PathSingularityManager {
    static ensure(opts) {
        if (window._robcoPathSingularity) {
            window._robcoPathSingularity.update(opts);
            return window._robcoPathSingularity;
        }
        const m = new PathSingularityManager(opts);
        window._robcoPathSingularity = m;
        return m;
    }

    constructor({ sm, base, store, teach }) {
        this.sm = sm;
        this.base = base;
        this.store = store;
        this.teach = teach;
        this.enabled = true;
        this._timer = null;

        this.group = new THREE.Group();
        this.group.name = 'robco-path-singularity';
        base.attach(this.group);

        this._wire();
        this.scheduleRefresh();
    }

    update({ base, store, teach } = {}) {
        if (base && base !== this.base) { this.base = base; base.attach(this.group); }
        if (store) this.store = store;
        if (teach) this.teach = teach;
        this._wire();
        this.scheduleRefresh();
    }

    /** Decorate the store/base change hooks so an edit or base move re-runs the scan (debounced). */
    _wire() {
        if (this.store && this.store.onChange !== this._wrappedStoreOnChange) {
            const prev = this.store.onChange;
            this._wrappedStoreOnChange = () => { prev?.(); this.scheduleRefresh(); };
            this.store.onChange = this._wrappedStoreOnChange;
        }
        if (this.base && this.base.onChange !== this._wrappedBaseOnChange) {
            const prev = this.base.onChange;
            this._wrappedBaseOnChange = () => { prev?.(); this.scheduleRefresh(); };
            this.base.onChange = this._wrappedBaseOnChange;
        }
    }

    setVisible(on) {
        this.enabled = !!on;
        this.group.visible = this.enabled;
        if (this.enabled) this.scheduleRefresh(); else this.sm.redraw?.();
    }
    isVisible() { return this.enabled; }

    scheduleRefresh() {
        if (!this.enabled) return;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
    }

    /** Recompute and redraw all cartesian-segment analyses. */
    refresh() {
        this._clear();
        if (!this.enabled || !this.teach?.kin) return;
        const moves = this.store.moves();
        const kin = this.teach.kin;
        const qLower = kin.qLower, qUpper = kin.qUpper;
        const dqAbs = new Array(kin.nq).fill(DEFAULT_DQ_ABS);

        for (let i = 1; i < moves.length; i++) {
            const from = moves[i - 1], to = moves[i];
            if (to.mode !== 'cartesian' || !from.worldPose || !to.worldPose) continue;

            const startPose = this._flangePose(from);
            const endPose = this._flangePose(to);
            const seed = (from.joints && from.joints.length) ? from.joints.map((d) => d * D2R) : undefined;
            let scan;
            try {
                scan = scanCartesianPath(kin, startPose, endPose, {
                    seed, samples: SAMPLES, dqAbs, cartVel: CART_VEL, qLower, qUpper,
                });
            } catch (e) {
                console.warn('[RobCo] path singularity scan failed:', e);
                continue;
            }
            this._drawSegment(from, to, scan);
        }
        this.sm.redraw?.();
    }

    /** Base-frame FLANGE pose {pos, mat(row-major 9)} for a move, for the analyzer/IK. */
    _flangePose(move) {
        const tipBase = this.store.baseMatrix(move);              // base-frame tool tip
        const flange = this.teach._flangeFromTip(tipBase);        // base-frame flange
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        flange.decompose(pos, quat, new THREE.Vector3());
        const e = new THREE.Matrix4().makeRotationFromQuaternion(quat).elements;
        return { pos: [pos.x, pos.y, pos.z], mat: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] };
    }

    _drawSegment(from, to, scan) {
        // Line vertices in WORLD coords: lerp the two waypoints' world tip positions (commutes with
        // the base transform, so it matches the base-frame analysis sample-for-sample).
        const a = new THREE.Vector3().fromArray(from.worldPose.pos);
        const b = new THREE.Vector3().fromArray(to.worldPose.pos);
        const n = scan.samples.length;
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        const col = new THREE.Color();
        for (let i = 0; i < n; i++) {
            const s = scan.samples[i].s;
            const p = a.clone().lerp(b, s);
            positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
            col.setHex(CLASS_COLOR[scan.samples[i].class] ?? CLASS_COLOR.ok);
            colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, depthTest: false,
        }));
        line.renderOrder = 997;
        this.group.add(line);

        // Only annotate segments that actually approach a singularity or saturate speed.
        const worst = scan.worst;
        const flagged = scan.summary.worstClass !== 'ok' || (scan.summary.minSlowdown ?? 1) < 0.9;
        if (!flagged) return;

        const wp = a.clone().lerp(b, worst.s);
        const cls = worst.class === 'ok' ? 'warn' : worst.class; // speed-only flag → amber
        this._addWorstMarker(wp, cls);
        this._addLostArrow(wp, worst.lostDirection, cls);
        this._addLabel(wp, `${this._type(worst)}  σ=${worst.manipulability.toExponential(1)}  ${Math.round((worst.slowdown ?? 1) * 100)}%`, cls);
    }

    _addWorstMarker(worldPos, cls) {
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.016, 16, 12),
            new THREE.MeshBasicMaterial({ color: CLASS_COLOR[cls], depthTest: false, transparent: true }),
        );
        dot.position.copy(worldPos);
        dot.renderOrder = 999;
        this.group.add(dot);
    }

    /** Arrow along the lost Cartesian direction (σ_min twist, base frame) at the worst point. */
    _addLostArrow(worldPos, lostDir, cls) {
        const v = new THREE.Vector3(lostDir[0], lostDir[1], lostDir[2]);
        if (v.lengthSq() < 1e-9) return; // lost DOF is purely rotational — nothing to draw as a line
        // lostDir is base-frame; author it in world coords (worldGroup applies B⁻¹) via the base rotation.
        v.applyQuaternion(this.base.baseQuat).normalize();
        const arrow = new THREE.ArrowHelper(v, worldPos, 0.09, CLASS_COLOR[cls], 0.03, 0.018);
        arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 999; });
        this.group.add(arrow);
    }

    _addLabel(worldPos, text, cls) {
        const pad = 8, font = 24;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `600 ${font}px ui-monospace, Menlo, Consolas, monospace`;
        const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
        const h = font + pad * 2;
        canvas.width = w; canvas.height = h;
        ctx.font = `600 ${font}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillStyle = 'rgba(13,17,23,0.85)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = `#${CLASS_COLOR[cls].toString(16).padStart(6, '0')}`;
        ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
        ctx.fillStyle = '#e6edf3';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, pad, h / 2);

        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
        const scale = 0.0012; // world metres per canvas pixel
        sprite.scale.set(w * scale, h * scale, 1);
        sprite.position.copy(worldPos).add(new THREE.Vector3(0, 0, 0.03));
        sprite.renderOrder = 1000;
        sprite.center.set(0, 0);
        this.group.add(sprite);
    }

    /**
     * Heuristic singularity type from the worst configuration. Structural, so approximate:
     * wrist = axes 4∥6 (joint-5 near 0/±180); shoulder = wrist centre near the base vertical axis;
     * otherwise boundary/elbow (near full reach). Labelled a guess — σ is the authoritative flag.
     */
    _type(sample) {
        const q = sample.q || [];
        if (q.length >= 6) {
            const j5 = q[4];
            const foldTo = (a, t) => Math.abs(((a - t + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
            if (foldTo(j5, 0) < 0.26 || foldTo(j5, Math.PI) < 0.26) return 'wrist';
        }
        const [x, y] = sample.pos || [0, 0, 0];
        if (Math.hypot(x, y) < 0.08) return 'shoulder';
        return 'boundary';
    }

    _clear() {
        for (let i = this.group.children.length - 1; i >= 0; i--) {
            const o = this.group.children[i];
            this.group.remove(o);
            o.traverse?.((c) => {
                c.geometry?.dispose?.();
                const mats = Array.isArray(c.material) ? c.material : (c.material ? [c.material] : []);
                mats.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
            });
            o.geometry?.dispose?.();
            o.material?.map?.dispose?.();
            o.material?.dispose?.();
        }
    }

    dispose() {
        clearTimeout(this._timer);
        this._clear();
        this.group.parent?.remove(this.group);
        if (window._robcoPathSingularity === this) window._robcoPathSingularity = null;
    }
}
