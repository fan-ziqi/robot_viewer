/**
 * PathSingularityManager — the scene half of the Singularity Analysis feature. Steered entirely by
 * the Singularity Analysis panel (SingularityPanel); does nothing until that panel enables it.
 *
 * When enabled it scans every LIN segment (consecutive move pair whose DESTINATION is a cartesian
 * waypoint) with scanCartesianPath and renders, under BaseFrame.worldGroup:
 *   - a heat-coloured path line (green ok / amber warn / red fault / purple unreachable);
 *   - a marker + label at the worst point on flagged segments (type guess, σ, predicted speed);
 *   - an arrow along the lost Cartesian DOF (σ_min twist) at the worst point;
 *   - a halo on any taught cartesian waypoint whose own configuration sits near a singularity.
 * Each individual layer can be toggled from the panel.
 *
 * It also computes the analysis DATA and publishes it via `onResults(results)` so the panel can
 * render per-segment sparklines/badges and per-waypoint flags. σ is tool-offset invariant, so the
 * flange-frame scan matches the controller's TCP index.
 */
import * as THREE from 'three';
import { scanCartesianPath } from '../dynamics/pathSingularity.js';
import { singularityMetrics, classifySingularity } from '../dynamics/singularity.js';

const CLASS_COLOR = { ok: 0x2ea043, warn: 0xe3873a, fault: 0xf85149, unreachable: 0x8957e5 };
const DEFAULT_DQ_ABS = 6.28; // module max_velocity (rad/s) — uniform default for headroom
const REFRESH_DEBOUNCE_MS = 150;
const D2R = Math.PI / 180;
const SETTINGS_KEY = 'robco-singularity-v1'; // persists enabled + layer/scan options

// Controller Cartesian velocity caps a waypoint velocity fraction of 1.0 reaches, from robcontrol
// global_properties.hpp (soft limits). A LIN move commands velocity_fraction × these.
const X_VEL_LIMIT = 1.0; // dx_abs_limit (m/s), translational
const O_VEL_LIMIT = 1.0; // w_abs_limit (rad/s), rotational

const DEFAULT_OPTS = {
    showLine: true,
    showMarkers: true,
    showArrows: true,
    showWaypointFlags: true,
    samples: 21,
    // Global speed scale (0..1) that multiplies each waypoint's velocity. Two modes:
    //   followSession=true  → the EFFECTIVE scale tracks the live RobFlow session's global speed
    //                         (fed via setSessionSpeed) so the prediction matches the real arm;
    //   followSession=false → the EFFECTIVE scale is `speedScale` below (a manual what-if override).
    // `speedScale` is the persisted manual value; the live session speed is not persisted.
    speedScale: 1.0,
    followSession: true,
};

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
        // Restore persisted state (default OFF on first run, honouring the panel's default).
        const saved = this._load();
        this.enabled = saved?.enabled ?? false;
        this.opts = { ...DEFAULT_OPTS, ...(saved?.opts || {}) };
        this.onResults = null; // (results) => void — panel subscribes to render readouts
        this.onSpeedState = null; // (state) => void — panel subscribes to render the speed follow/override UI
        this.sessionSpeed = null; // last global speed reported by the live session (0..1), or null when offline
        this._timer = null;
        this.lastResults = { segments: [], waypoints: [] };

        this.group = new THREE.Group();
        this.group.name = 'robco-path-singularity';
        this.group.visible = this.enabled;
        base.attach(this.group);

        this._wire();
        if (this.enabled) this.scheduleRefresh(); // deferred → panel subscribes to onResults first
    }

    _load() {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return null; }
    }
    _save() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled: this.enabled, opts: this.opts })); } catch { /* ignore */ }
    }

    update({ base, store, teach } = {}) {
        if (base && base !== this.base) { this.base = base; base.attach(this.group); }
        if (store) this.store = store;
        if (teach) this.teach = teach;
        this._wire();
        if (this.enabled) this.scheduleRefresh();
    }

    /** Subscribe to store/base changes so an edit or base move re-runs the scan (debounced).
     *  Uses onChanged() subscriptions — the single-slot onChange belongs to WaypointsPanel, and
     *  decorating it was silently droppable whenever the panel re-assigned its handler. */
    _wire() {
        if (this.store && this.store !== this._wiredStore) {
            this._unwireStore?.();
            this._unwireStore = this.store.onChanged(() => this.scheduleRefresh());
            this._wiredStore = this.store;
        }
        if (this.base && this.base !== this._wiredBase) {
            this._unwireBase?.();
            this._unwireBase = this.base.onChanged(() => this.scheduleRefresh());
            this._wiredBase = this.base;
        }
    }

    setEnabled(on) {
        this.enabled = !!on;
        this.group.visible = this.enabled;
        this._save();
        // scheduleRefresh (not refresh): the scan can block for seconds on a bad path, so let the
        // click handler return and the checkbox paint before the work starts.
        if (this.enabled) { this._wire(); this.scheduleRefresh(); }
        else { this._clear(); this.lastResults = { segments: [], waypoints: [] }; this.onResults?.(this.lastResults); this.sm.redraw?.(); }
    }
    isEnabled() { return this.enabled; }

    setOptions(patch = {}) {
        this.opts = { ...this.opts, ...patch };
        this._save();
        if (this.enabled) this.scheduleRefresh();
    }

    // --- global speed: follow the live session, or a manual what-if override ------------------
    /** The scale actually used by the scan: the live session speed when following, else the manual value. */
    effectiveSpeedScale() {
        return (this.opts.followSession && this.sessionSpeed != null) ? this.sessionSpeed : this.opts.speedScale;
    }

    /** Snapshot for the panel: what value is in force and why. */
    _speedState() {
        const hasSession = this.sessionSpeed != null;
        return {
            effective: this.effectiveSpeedScale(),
            sessionSpeed: this.sessionSpeed,
            manual: this.opts.speedScale,
            followSession: !!this.opts.followSession,
            hasSession,
            following: !!this.opts.followSession && hasSession,
        };
    }

    /** The live session reported its global speed (via the WS `globalSpeed` push, 0.01..1, or null
     *  when the session drops). Re-scans when following so the prediction tracks the real arm.
     *  Quantized to 3 decimals so float jitter on a re-pushed value can't re-trigger the scan. */
    setSessionSpeed(v) {
        const next = (v == null || !Number.isFinite(+v))
            ? null
            : Math.round(Math.min(1, Math.max(0.01, +v)) * 1000) / 1000;
        if (next === this.sessionSpeed) { this.onSpeedState?.(this._speedState()); return; }
        this.sessionSpeed = next;
        this.onSpeedState?.(this._speedState());
        if (this.opts.followSession) this.scheduleRefresh();
    }

    /** User typed a scale in the panel → switch to manual override and use it. */
    setManualSpeedScale(v) {
        const val = Math.min(1, Math.max(0.05, Number.isFinite(+v) ? +v : 1));
        this.opts = { ...this.opts, speedScale: val, followSession: false };
        this._save();
        this.onSpeedState?.(this._speedState());
        if (this.enabled) this.scheduleRefresh();
    }

    /** Re-follow the live session speed (the ⟳ button), or explicitly go manual. */
    setFollowSession(on) {
        this.opts = { ...this.opts, followSession: !!on };
        this._save();
        this.onSpeedState?.(this._speedState());
        if (this.enabled) this.scheduleRefresh();
    }

    scheduleRefresh() {
        if (!this.enabled) return;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
    }

    /** Recompute the analysis, redraw the enabled scene layers, and publish results to the panel. */
    refresh() {
        this._clear();
        if (!this.enabled || !this.teach?.kin) {
            this.lastResults = { segments: [], waypoints: [] };
            this.onResults?.(this.lastResults);
            return;
        }
        const moves = this.store.moves();
        const kin = this.teach.kin;
        const qLower = kin.qLower, qUpper = kin.qUpper;
        // Per-axis speed limits from the module descriptors (falls back to a uniform nominal value).
        const dqAbs = (kin.dqAbs && kin.dqAbs.length === kin.nq) ? kin.dqAbs : new Array(kin.nq).fill(DEFAULT_DQ_ABS);

        const segments = [];
        for (let i = 1; i < moves.length; i++) {
            const from = moves[i - 1], to = moves[i];
            if (to.mode !== 'cartesian' || !from.worldPose || !to.worldPose) continue;
            const seed = (from.joints && from.joints.length) ? from.joints.map((d) => d * D2R) : undefined;
            // Commanded speed = destination waypoint's velocity fraction × global speed scale × caps.
            const velFrac = Math.max(0.001, Math.min(1, (to.velocity ?? 1) * this.effectiveSpeedScale()));
            const cartVel = velFrac * X_VEL_LIMIT;
            const rotVel = velFrac * O_VEL_LIMIT;
            let scan;
            try {
                scan = scanCartesianPath(kin, this._flangePose(from), this._flangePose(to), {
                    seed, samples: this.opts.samples, dqAbs, cartVel, rotVel, qLower, qUpper,
                });
            } catch (e) {
                console.warn('[RobCo] path singularity scan failed:', e);
                continue;
            }
            this._drawSegment(from, to, scan);
            segments.push(this._segmentResult(from, to, scan, cartVel));
        }

        const waypoints = this._analyzeWaypoints(moves, kin);
        this.lastResults = { segments, waypoints };
        this.onResults?.(this.lastResults);
        this.sm.redraw?.();
    }

    /** Per-waypoint configuration singularity (the taught pose itself), for cartesian moves. */
    _analyzeWaypoints(moves, kin) {
        const out = [];
        for (const m of moves) {
            if (m.mode !== 'cartesian' || !m.joints || m.joints.length < kin.nq || !m.worldPose) continue;
            const q = m.joints.map((d) => d * D2R);
            let metrics;
            try { metrics = singularityMetrics(kin.jacobian(q)); } catch { continue; }
            const cls = classifySingularity(metrics.manipulability, kin.nq);
            out.push({ id: m.id, name: m.name, class: cls, manipulability: metrics.manipulability, reciprocalCondition: metrics.reciprocalCondition });
            if (this.opts.showWaypointFlags && cls !== 'ok') this._addWaypointHalo(m, cls);
        }
        return out;
    }

    _segmentResult(from, to, scan, cartVel) {
        const s = scan.summary;
        return {
            from: from.name, to: to.name, commandedSpeed: cartVel,
            worstClass: s.worstClass, worstS: scan.worst.s, worstType: this._type(scan.worst),
            minManipulability: s.minManipulability, minReciprocalCondition: s.minReciprocalCondition,
            minSlowdown: s.minSlowdown, maxDqJump: s.maxDqJump,
            anyBranchFlip: s.anyBranchFlip, anyClamped: s.anyClamped, anyUnreachable: s.anyUnreachable,
            profile: scan.samples.map((x) => ({ s: x.s, reciprocalCondition: x.reciprocalCondition, manipulability: x.manipulability, class: x.class, slowdown: x.slowdown })),
        };
    }

    /** Base-frame FLANGE pose {pos, mat(row-major 9)} for a move, for the analyzer/IK. */
    _flangePose(move) {
        const flange = this.teach._flangeFromTip(this.store.baseMatrix(move));
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        flange.decompose(pos, quat, new THREE.Vector3());
        const e = new THREE.Matrix4().makeRotationFromQuaternion(quat).elements;
        return { pos: [pos.x, pos.y, pos.z], mat: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] };
    }

    _drawSegment(from, to, scan) {
        const a = new THREE.Vector3().fromArray(from.worldPose.pos);
        const b = new THREE.Vector3().fromArray(to.worldPose.pos);
        const n = scan.samples.length;

        if (this.opts.showLine) {
            const positions = new Float32Array(n * 3);
            const colors = new Float32Array(n * 3);
            const col = new THREE.Color();
            for (let i = 0; i < n; i++) {
                const p = a.clone().lerp(b, scan.samples[i].s);
                positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
                col.setHex(CLASS_COLOR[scan.samples[i].class] ?? CLASS_COLOR.ok);
                colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }));
            line.renderOrder = 997;
            this.group.add(line);
        }

        const worst = scan.worst;
        const flagged = scan.summary.worstClass !== 'ok' || (scan.summary.minSlowdown ?? 1) < 0.9;
        if (!flagged) return;
        const wp = a.clone().lerp(b, worst.s);
        const cls = worst.class === 'ok' ? 'warn' : worst.class; // speed-only flag → amber
        if (this.opts.showMarkers) {
            this._addWorstMarker(wp, cls);
            this._addLabel(wp, `${this._type(worst)}  σ=${worst.manipulability.toExponential(1)}  ${Math.round((worst.slowdown ?? 1) * 100)}%`, cls);
        }
        if (this.opts.showArrows) this._addLostArrow(wp, worst.lostDirection, cls);
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

    /** Wireframe halo around a taught waypoint whose own configuration is near-singular. */
    _addWaypointHalo(move, cls) {
        const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.028, 14, 10),
            new THREE.MeshBasicMaterial({ color: CLASS_COLOR[cls], wireframe: true, transparent: true, opacity: 0.6, depthTest: false }),
        );
        halo.position.fromArray(move.worldPose.pos);
        halo.renderOrder = 998;
        this.group.add(halo);
    }

    /** Arrow along the lost Cartesian direction (σ_min twist, base frame) at the worst point. */
    _addLostArrow(worldPos, lostDir, cls) {
        const v = new THREE.Vector3(lostDir[0], lostDir[1], lostDir[2]);
        if (v.lengthSq() < 1e-9) return; // lost DOF is purely rotational — nothing to draw as a line
        v.applyQuaternion(this.base.baseQuat).normalize(); // base-frame dir → world (worldGroup is B⁻¹)
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
        sprite.scale.set(w * 0.0012, h * 0.0012, 1);
        sprite.position.copy(worldPos).add(new THREE.Vector3(0, 0, 0.03));
        sprite.renderOrder = 1000;
        sprite.center.set(0, 0);
        this.group.add(sprite);
    }

    /**
     * Heuristic singularity type from the worst configuration (structural, so approximate):
     * wrist = axes 4∥6 (joint-5 near 0/±180); shoulder = wrist centre near the base vertical axis;
     * otherwise boundary/elbow (near full reach). σ is the authoritative flag — this is a label.
     */
    _type(sample) {
        const q = sample.q || [];
        if (q.length >= 6) {
            const j5 = q[4];
            const foldTo = (aa, t) => Math.abs(((aa - t + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
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
        this._unwireStore?.(); this._unwireStore = null; this._wiredStore = null;
        this._unwireBase?.(); this._unwireBase = null; this._wiredBase = null;
        this._clear();
        this.group.parent?.remove(this.group);
        if (window._robcoPathSingularity === this) window._robcoPathSingularity = null;
    }
}
