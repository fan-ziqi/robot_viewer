import * as THREE from 'three';

/**
 * PostFXManager — optional post-processing pipeline layered on the scene render:
 *   RenderPass → GTAO (ambient occlusion) → UnrealBloom → OutputPass (tone map + sRGB) → SMAA.
 *
 * Built lazily via dynamic import so the post-processing modules stay out of the initial
 * bundle. Until it's ready — or if init fails — SceneManager falls back to a plain
 * renderer.render(), so the viewer can never black-screen because of post-processing.
 * Every effect is individually toggleable / tunable at runtime (see the Render panel).
 */
export class PostFXManager {
    constructor(sceneManager) {
        this.sm = sceneManager;
        this.renderer = sceneManager.renderer;
        this.scene = sceneManager.scene;
        this.camera = sceneManager.camera;

        this.ready = false;
        this.composer = null;
        this.passes = {};

        // Conservative defaults — visible but not heavy-handed. Tunable at runtime.
        this.options = {
            ao: true,
            aoScale: 1.0,            // GTAO strength (maps to material `scale`)
            aoRadius: 0.25,          // metres — good for robot-scale models
            bloom: true,
            bloomStrength: 0.25,
            bloomRadius: 0.3,
            bloomThreshold: 0.9,     // only very bright (emissive LEDs / hot highlights) bloom
        };
    }

    async init() {
        try {
            const [
                { EffectComposer },
                { RenderPass },
                { GTAOPass },
                { UnrealBloomPass },
                { OutputPass },
                { SMAAPass },
            ] = await Promise.all([
                import('three/examples/jsm/postprocessing/EffectComposer.js'),
                import('three/examples/jsm/postprocessing/RenderPass.js'),
                import('three/examples/jsm/postprocessing/GTAOPass.js'),
                import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
                import('three/examples/jsm/postprocessing/OutputPass.js'),
                import('three/examples/jsm/postprocessing/SMAAPass.js'),
            ]);

            const { width, height } = this._size();

            const composer = new EffectComposer(this.renderer);
            composer.setPixelRatio(this.renderer.getPixelRatio());
            composer.setSize(width, height);

            const renderPass = new RenderPass(this.scene, this.camera);
            composer.addPass(renderPass);

            // Ambient occlusion (grounds the model, adds depth in joints/crevices).
            const gtao = new GTAOPass(this.scene, this.camera, width, height);
            try {
                gtao.output = GTAOPass.OUTPUT.Default;
                gtao.updateGtaoMaterial?.({
                    radius: this.options.aoRadius,
                    scale: this.options.aoScale,
                    samples: 16,
                    distanceExponent: 1.0,
                    thickness: 1.0,
                });
            } catch { /* keep GTAO defaults if param shape differs */ }
            gtao.enabled = this.options.ao;
            composer.addPass(gtao);

            // Bloom — high threshold so only emissive LEDs / hot highlights glow.
            const bloom = new UnrealBloomPass(
                new THREE.Vector2(width, height),
                this.options.bloomStrength,
                this.options.bloomRadius,
                this.options.bloomThreshold,
            );
            bloom.enabled = this.options.bloom;
            composer.addPass(bloom);

            // Tone mapping + color-space conversion (reads renderer.toneMapping).
            composer.addPass(new OutputPass());

            // Anti-aliasing on the final image (MSAA is unavailable through the composer).
            const smaa = new SMAAPass(width, height);
            composer.addPass(smaa);

            this.composer = composer;
            this.passes = { renderPass, gtao, bloom, smaa };
            this.ready = true;
            // GTAOPass bakes PERSPECTIVE_CAMERA from camera.isPerspectiveCamera at construction;
            // our ortho mode fakes the projection on a perspective camera, so re-sync in case the
            // mode was toggled before this lazy init finished.
            this.syncProjection();
            // Re-apply any persisted Render-panel AO/bloom prefs now that the passes exist
            // (the panel may have run applyAll() before the composer finished loading).
            try { window._robcoRenderPanel?.applyPostFX?.(); } catch { /* ignore */ }
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[PostFX] disabled (init failed):', e);
            this.ready = false;
            this.composer = null;
        }
    }

    _size() {
        const w = this.sm.canvas?.clientWidth || this.renderer.domElement.width || 1;
        const h = this.sm.canvas?.clientHeight || this.renderer.domElement.height || 1;
        return { width: Math.max(1, w), height: Math.max(1, h) };
    }

    /** Render the frame through the composer. Returns false if not available (caller falls back). */
    render() {
        if (this.ready && this.composer) {
            this.composer.render();
            return true;
        }
        return false;
    }

    setSize(width, height) {
        if (!this.ready) return;
        const w = Math.max(1, width), h = Math.max(1, height);
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(w, h);
        this.passes.gtao?.setSize?.(w, h);
        this.passes.bloom?.setSize?.(w, h);
        this.passes.smaa?.setSize?.(w, h);
    }

    /**
     * Keep GTAO's depth-reconstruction shader define in sync with the (faked) projection mode.
     * The camera object is always a PerspectiveCamera, so the define baked at pass construction
     * is wrong whenever SceneManager's orthographic mode is active.
     */
    syncProjection(mode = this.sm.projectionMode) {
        const mat = this.passes.gtao?.gtaoMaterial;
        if (!mat) return;
        const v = mode === 'orthographic' ? 0 : 1;
        if (mat.defines.PERSPECTIVE_CAMERA !== v) {
            mat.defines.PERSPECTIVE_CAMERA = v;
            mat.needsUpdate = true;
        }
    }

    /** Toggle / tune ambient occlusion. intensity (0..2) maps to the GTAO `scale`. */
    setAO(enabled, intensity) {
        this.options.ao = enabled;
        if (intensity != null) this.options.aoScale = intensity;
        const gtao = this.passes.gtao;
        if (gtao) {
            gtao.enabled = enabled;
            if (intensity != null) {
                try { gtao.updateGtaoMaterial?.({ scale: intensity }); } catch { /* ignore */ }
            }
        }
        this.sm.redraw?.();
    }

    /** Toggle / tune bloom. */
    setBloom(enabled, strength) {
        this.options.bloom = enabled;
        const bloom = this.passes.bloom;
        if (bloom) {
            bloom.enabled = enabled;
            if (strength != null) { bloom.strength = strength; this.options.bloomStrength = strength; }
        }
        this.sm.redraw?.();
    }

    dispose() {
        try { this.composer?.dispose?.(); } catch { /* ignore */ }
        this.ready = false;
        this.composer = null;
        this.passes = {};
    }
}
