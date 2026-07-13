/**
 * ViewCube — a CAD-style navigation cube pinned to a corner of the viewport.
 *
 * A small self-contained 3D gizmo (its own scene + renderer + orthographic camera, exactly like
 * CameraView runs a second viewport) that:
 *   • mirrors the main camera's orientation every frame, so it always shows which way you're
 *     looking (TOP / BOTTOM / FRONT / BACK / LEFT / RIGHT labels in scene axes, Y-up);
 *   • snaps the main camera to a standard view when a face is clicked, or to an isometric view
 *     when an edge/corner is clicked — the whole cube is one mesh and the clicked direction is
 *     derived from where on the cube the ray landed (face = 1 axis, edge = 2, corner = 3);
 *   • carries a projection toggle (Persp ⇄ Ortho, driven by SceneManager.setProjectionMode) and a
 *     Home button that re-fits the model.
 *
 * Singleton (window._robcoViewCube); needs only the SceneManager. The projection choice persists
 * to localStorage. It is pinned to the bottom-right of the 3D viewport (#canvas-container) and
 * tracks that region, so it follows window resizes and slides clear of the right dock sidebar
 * instead of overlapping it. It deliberately does NOT use the dock/makeDraggable helpers (those
 * would adopt it as a dockable panel) — it is a fixed gizmo, not a movable tool window.
 */
import * as THREE from 'three';

const KEY_PROJ = 'robco-projection';
const CUBE = 96;            // gizmo canvas size (px)
const R = 5;               // cube-camera orbit radius (ortho → scale-independent)
const HALF = 0.72;         // cube half-size in its own scene
const SNAP = 0.5;          // |coord|/HALF above this counts toward an edge/corner direction
const TWEEN_MS = 380;

// Faces in THREE BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z.
const FACES = [
    { label: 'RIGHT', dir: [1, 0, 0] },
    { label: 'LEFT', dir: [-1, 0, 0] },
    { label: 'TOP', dir: [0, 1, 0] },
    { label: 'BOTTOM', dir: [0, -1, 0] },
    { label: 'FRONT', dir: [0, 0, 1] },
    { label: 'BACK', dir: [0, 0, -1] },
];

const WRAP_CSS =
    'position:fixed;right:16px;bottom:16px;z-index:3000;width:96px;' +
    'font:600 10px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3;' +
    'user-select:none;';
const BTN_CSS =
    'flex:1;font:600 10px ui-monospace,monospace;color:#e6edf3;background:rgba(13,17,23,0.82);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 0;cursor:pointer;' +
    'backdrop-filter:blur(6px);';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

/**
 * A face texture: label centred on a light tile with dark text (the classic CAD ViewCube look).
 * Light faces are the deliberate choice — the base material colour is white, so hover-tinting to
 * the accent via colour-multiply reads as a clean blue (multiplying a dark tile would only darken).
 */
function faceTexture(label) {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = '#e7ebf1';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(13,17,23,0.35)';
    g.lineWidth = 6;
    g.strokeRect(3, 3, s - 6, s - 6);
    g.fillStyle = '#1b2430';
    g.font = '600 22px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, s / 2, s / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

export class ViewCube {
    static ensure({ sm }) {
        if (window._robcoViewCube) {
            window._robcoViewCube.repoint(sm);
            return window._robcoViewCube;
        }
        const v = new ViewCube(sm);
        window._robcoViewCube = v;
        return v;
    }

    constructor(sm) {
        this.sm = sm;
        this._tween = null;
        this._hovered = -1;
        this._buildGizmoScene();
        this._buildDom();
        this._unhook = this.sm.addFrameHook(() => this._onFrame());
        // Restore the persisted projection choice.
        try {
            if (localStorage.getItem(KEY_PROJ) === 'orthographic') {
                this.sm.setProjectionMode('orthographic');
                this._projBtn.textContent = 'Ortho';
            }
        } catch { /* ignore */ }
        this._onFrame(); // sync the gizmo camera before the first paint (frame hooks fire later)
    }

    /** Re-point at a (possibly) new SceneManager after a rebuild. */
    repoint(sm) {
        if (!sm || sm === this.sm) return;
        if (this._unhook) this._unhook();
        this.sm = sm;
        this._unhook = this.sm.addFrameHook(() => this._onFrame());
        this._onFrame();
    }

    // --- gizmo scene ----------------------------------------------------
    _buildGizmoScene() {
        this.scene = new THREE.Scene();
        // Orthographic camera → the cube reads as a crisp CAD cube with no perspective distortion.
        this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
        this._setCamFrustum();

        this._baseColor = new THREE.Color(0xffffff);
        this._hoverColor = new THREE.Color(0x2f81f7);
        this._mats = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label) }));
        const geo = new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2);
        this.cube = new THREE.Mesh(geo, this._mats);
        this.scene.add(this.cube);

        // Thin edge outline so the silhouette stays legible against the scene behind it.
        this._edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({ color: 0x0d1117, transparent: true, opacity: 0.6 }),
        );
        this.cube.add(this._edges);

        this._ray = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
    }

    _setCamFrustum() {
        const s = HALF * 1.9; // a little padding around the cube
        this.cam.left = -s; this.cam.right = s; this.cam.top = s; this.cam.bottom = -s;
        this.cam.updateProjectionMatrix();
    }

    // --- DOM ------------------------------------------------------------
    _buildDom() {
        const wrap = el('div', WRAP_CSS);

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = `display:block;width:${CUBE}px;height:${CUBE}px;cursor:pointer;`;
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(CUBE, CUBE, false);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        wrap.append(this.canvas);

        // Controls row: Home (fit) + projection toggle.
        const row = el('div', 'display:flex;gap:4px;margin-top:5px;');
        const homeBtn = el('button', BTN_CSS, 'Home');
        homeBtn.title = 'Fit model to view';
        homeBtn.addEventListener('click', () => this.sm.updateEnvironment?.(true));
        this._projBtn = el('button', BTN_CSS, 'Persp');
        this._projBtn.title = 'Toggle perspective / orthographic';
        this._projBtn.addEventListener('click', () => this._toggleProjection());
        row.append(homeBtn, this._projBtn);
        wrap.append(row);

        this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this.canvas.addEventListener('pointerleave', () => this._setHover(-1));
        this.canvas.addEventListener('click', (e) => this._onClick(e));

        document.body.appendChild(wrap);
        this.root = wrap;
        this._installAutoPosition();
    }

    _toggleProjection() {
        const next = this.sm.projectionMode === 'orthographic' ? 'perspective' : 'orthographic';
        this.sm.setProjectionMode(next);
        this._projBtn.textContent = next === 'orthographic' ? 'Ortho' : 'Persp';
        try { localStorage.setItem(KEY_PROJ, next); } catch { /* ignore */ }
    }

    // --- per-frame sync -------------------------------------------------
    _onFrame() {
        this._syncFromMainCamera();
        this._render();
    }

    /**
     * Mirror the main camera's orientation onto the gizmo camera: same world rotation, positioned
     * along the main camera's offset-from-target direction at a fixed radius. Because the gizmo
     * camera carries the same quaternion, its forward (-Z) points back through the origin, so the
     * cube shows exactly the faces the user is currently looking at (roll/tilt included).
     */
    _syncFromMainCamera() {
        const mainCam = this.sm.camera;
        const target = this.sm.controls?.target;
        if (!mainCam || !target) return;
        const offset = new THREE.Vector3().subVectors(mainCam.position, target);
        if (offset.lengthSq() < 1e-9) offset.set(0, 0, 1);
        this.cam.position.copy(offset.setLength(R));
        this.cam.quaternion.copy(mainCam.quaternion);
        this.cam.updateMatrixWorld(true);
    }

    _render() {
        this.renderer.render(this.scene, this.cam);
    }

    // --- picking --------------------------------------------------------
    _pick(e) {
        const rect = this.canvas.getBoundingClientRect();
        this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._ray.setFromCamera(this._ndc, this.cam);
        return this._ray.intersectObject(this.cube, false)[0] || null;
    }

    _onPointerMove(e) {
        const hit = this._pick(e);
        this._setHover(hit ? hit.face.materialIndex : -1);
    }

    _setHover(faceIndex) {
        if (faceIndex === this._hovered) return;
        if (this._hovered >= 0) this._mats[this._hovered].color.copy(this._baseColor);
        this._hovered = faceIndex;
        if (faceIndex >= 0) this._mats[faceIndex].color.copy(this._hoverColor);
        this._render();
    }

    /**
     * Snap the picked surface point to a view direction in scene space. Each axis component of the
     * local hit point, normalised by the half-size, becomes -1/0/+1 — so a face yields one non-zero
     * axis, an edge two, a corner three. That single test covers all 26 CAD view directions.
     */
    _onClick(e) {
        const hit = this._pick(e);
        if (!hit) return;
        const p = hit.point; // cube is at the origin, unrotated → local == scene axes
        const dir = new THREE.Vector3(
            Math.abs(p.x) / HALF > SNAP ? Math.sign(p.x) : 0,
            Math.abs(p.y) / HALF > SNAP ? Math.sign(p.y) : 0,
            Math.abs(p.z) / HALF > SNAP ? Math.sign(p.z) : 0,
        );
        if (dir.lengthSq() === 0) return;
        this._goToDirection(dir.normalize());
    }

    // --- camera move ----------------------------------------------------
    _goToDirection(dir) {
        const controls = this.sm.controls;
        const cam = this.sm.camera;
        if (!controls || !cam) return;
        const target = controls.target.clone();
        const dist = cam.position.distanceTo(target) || 3;
        // Nudge pure top/bottom off the pole so OrbitControls keeps a stable, non-flipping azimuth.
        if (Math.abs(dir.y) > 0.999) dir.z += dir.y > 0 ? -1e-3 : 1e-3;
        const to = target.clone().add(dir.normalize().multiplyScalar(dist));
        this._tweenCameraTo(to, target);
    }

    _tweenCameraTo(toPos, toTarget) {
        const controls = this.sm.controls;
        const cam = this.sm.camera;
        const fromPos = cam.position.clone();
        const fromTarget = controls.target.clone();
        const start = performance.now();
        this._cancelTween();
        // A grab on the main canvas mid-tween must win — otherwise OrbitControls and the tween
        // both write the camera every frame and fight for the tween's remaining duration.
        const dom = this.sm.renderer?.domElement;
        const onGrab = () => this._cancelTween();
        dom?.addEventListener('pointerdown', onGrab);
        this._unbindTweenCancel = () => { dom?.removeEventListener('pointerdown', onGrab); this._unbindTweenCancel = null; };
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad
        const step = () => {
            const k = Math.min(1, (performance.now() - start) / TWEEN_MS);
            const e = ease(k);
            cam.position.lerpVectors(fromPos, toPos, e);
            controls.target.lerpVectors(fromTarget, toTarget, e);
            controls.update();
            this.sm.redraw?.();
            this._tween = k < 1 ? requestAnimationFrame(step) : null;
            if (!this._tween) this._unbindTweenCancel?.();
        };
        step();
    }

    _cancelTween() {
        if (this._tween) { cancelAnimationFrame(this._tween); this._tween = null; }
        this._unbindTweenCancel?.();
    }

    // --- auto-position: bottom-right of the 3D viewport, clear of the dock ---
    /**
     * Pin the gizmo to the bottom-right of the actual viewport region (#canvas-container — the
     * element SceneManager already watches). The dock insets that container's right edge whenever
     * a panel is snapped to the right sidebar, so tracking it means the cube slides left of the
     * sidebar instead of overlapping it, and follows every window resize / splitter drag for free.
     */
    _installAutoPosition() {
        const container = this.sm?.canvas?.parentElement;
        this._reposition();
        if (container && typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this._reposition());
            this._ro.observe(container);
        }
        this._onResize = () => this._reposition();
        window.addEventListener('resize', this._onResize);
    }

    _reposition() {
        if (!this.root) return;
        const container = this.sm?.canvas?.parentElement;
        const M = 16;
        const rect = container ? container.getBoundingClientRect()
            : { right: window.innerWidth, bottom: window.innerHeight };
        const w = this.root.offsetWidth || CUBE;
        const h = this.root.offsetHeight || (CUBE + 24);
        const left = Math.max(0, Math.min(window.innerWidth - w, rect.right - w - M));
        const top = Math.max(0, Math.min(window.innerHeight - h, rect.bottom - h - M));
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
        this.root.style.left = `${left}px`;
        this.root.style.top = `${top}px`;
    }

    dispose() {
        this._cancelTween();
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
        if (this._unhook) { this._unhook(); this._unhook = null; }
        this._mats?.forEach((m) => { m.map?.dispose(); m.dispose(); });
        this.cube?.geometry?.dispose();
        this._edges?.geometry?.dispose();
        this._edges?.material?.dispose();
        this.renderer?.dispose?.();
        this.root?.remove();
        if (window._robcoViewCube === this) window._robcoViewCube = null;
    }
}
