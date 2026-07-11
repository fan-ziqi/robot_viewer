/**
 * Drag State Manager
 * Used to apply forces when dragging objects during physics simulation
 */
import * as THREE from 'three';
import { setRayFromCamera } from './pickRay.js';

export class DragStateManager {
    constructor(scene, renderer, camera, container, controls) {
        this.scene = scene;
        this.renderer = renderer;
        this.camera = camera;
        this.mousePos = new THREE.Vector2();
        this.raycaster = new THREE.Raycaster();
        this.raycaster.params.Line.threshold = 0.1;
        this.grabDistance = 0.0;
        this.active = false;
        this.physicsObject = null;
        this.controls = controls;

        // Create force visualization arrow
        this.arrow = new THREE.ArrowHelper(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(0, 0, 0),
            15,
            0x666666
        );
        this.arrow.setLength(15, 3, 1);
        this.scene.add(this.arrow);
        this.arrow.line.material.transparent = true;
        this.arrow.cone.material.transparent = true;
        this.arrow.line.material.opacity = 0.5;
        this.arrow.cone.material.opacity = 0.5;
        this.arrow.visible = false;

        this.previouslySelected = null;
        this.highlightColor = 0xffffff; // White highlight
        this.originalEmissive = new Map(); // Save original materials

        this.localHit = new THREE.Vector3();
        this.worldHit = new THREE.Vector3();
        this.currentWorld = new THREE.Vector3();

        // Event listeners
        this.enabled = false; // Disabled by default, enabled during simulation
        this.container = container;
        this.boundOnPointer = this.onPointer.bind(this);
        this.mouseDown = false;
    }

    enable() {
        if (!this.enabled) {
            this.enabled = true;
            this.container.addEventListener('pointerdown', this.boundOnPointer, true);
            document.addEventListener('pointermove', this.boundOnPointer, true);
            document.addEventListener('pointerup', this.boundOnPointer, true);
            document.addEventListener('pointerout', this.boundOnPointer, true);
        }
    }

    disable() {
        if (this.enabled) {
            this.enabled = false;
            this.container.removeEventListener('pointerdown', this.boundOnPointer, true);
            document.removeEventListener('pointermove', this.boundOnPointer, true);
            document.removeEventListener('pointerup', this.boundOnPointer, true);
            document.removeEventListener('pointerout', this.boundOnPointer, true);

            if (this.active) {
                this.end();
            }
        }
    }

    updateRaycaster(x, y) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mousePos.x = ((x - rect.left) / rect.width) * 2 - 1;
        this.mousePos.y = -((y - rect.top) / rect.height) * 2 + 1;
        setRayFromCamera(this.raycaster, this.mousePos, this.camera);
    }

    start(x, y) {
        this.physicsObject = null;
        this.updateRaycaster(x, y);
        const intersects = this.raycaster.intersectObjects(this.scene.children, true);

        for (let i = 0; i < intersects.length; i++) {
            const obj = intersects[i].object;
            if (obj.bodyID !== undefined && obj.bodyID > 0) {
                this.physicsObject = obj;
                this.grabDistance = intersects[i].distance;
                const hit = this.raycaster.ray.origin.clone();
                hit.addScaledVector(this.raycaster.ray.direction, this.grabDistance);
                this.arrow.position.copy(hit);
                this.active = true;
                this.controls.enabled = false;
                this.localHit = obj.worldToLocal(hit.clone());
                this.worldHit.copy(hit);
                this.currentWorld.copy(hit);
                this.arrow.visible = true;

                // Highlight selected object
                this.highlightBody(obj);
                break;
            }
        }
    }

    move(x, y) {
        if (this.active) {
            this.updateRaycaster(x, y);
            const hit = this.raycaster.ray.origin.clone();
            hit.addScaledVector(this.raycaster.ray.direction, this.grabDistance);
            this.currentWorld.copy(hit);
            this.update();
        }
    }

    update() {
        if (this.worldHit && this.localHit && this.currentWorld && this.arrow && this.physicsObject) {
            this.worldHit.copy(this.localHit);
            this.physicsObject.localToWorld(this.worldHit);
            this.arrow.position.copy(this.worldHit);
            this.arrow.setDirection(this.currentWorld.clone().sub(this.worldHit).normalize());
            this.arrow.setLength(this.currentWorld.clone().sub(this.worldHit).length());
        }
    }

    end() {
        // Remove highlight
        if (this.physicsObject) {
            this.unhighlightBody(this.physicsObject);
        }

        this.physicsObject = null;
        this.active = false;
        this.controls.enabled = true;
        this.arrow.visible = false;
        this.mouseDown = false;
    }

    /**
     * Highlight entire body group
     */
    highlightBody(obj) {
        // Find body group (parent Group containing bodyID)
        let bodyGroup = obj;
        while (bodyGroup && !bodyGroup.isGroup) {
            bodyGroup = bodyGroup.parent;
        }

        if (!bodyGroup) return;

        // Traverse all meshes in body group and highlight
        bodyGroup.traverse((child) => {
            if (child.isMesh && child.material) {
                // Only process materials with emissive property (e.g., MeshPhongMaterial, MeshStandardMaterial)
                if (child.material.emissive) {
                    // Save original emissive
                    if (!this.originalEmissive.has(child.uuid)) {
                        this.originalEmissive.set(child.uuid, {
                            color: child.material.emissive.clone(),
                            intensity: child.material.emissiveIntensity || 0
                        });
                    }

                    // Apply highlight
                    child.material.emissive.setHex(this.highlightColor);
                    child.material.emissiveIntensity = 0.5;
                }
            }
        });
    }

    /**
     * Remove highlight from body group
     */
    unhighlightBody(obj) {
        // Find body group
        let bodyGroup = obj;
        while (bodyGroup && !bodyGroup.isGroup) {
            bodyGroup = bodyGroup.parent;
        }

        if (!bodyGroup) return;

        // Restore original materials
        bodyGroup.traverse((child) => {
            if (child.isMesh && child.material && this.originalEmissive.has(child.uuid)) {
                const original = this.originalEmissive.get(child.uuid);
                if (child.material.emissive) {
                    child.material.emissive.copy(original.color);
                    child.material.emissiveIntensity = original.intensity;
                }
                this.originalEmissive.delete(child.uuid);
            }
        });
    }

    onPointer(evt) {
        if (!this.enabled) return;

        if (evt.type === 'pointerdown') {
            this.start(evt.clientX, evt.clientY);
            this.mouseDown = true;
        } else if (evt.type === 'pointermove' && this.mouseDown) {
            if (this.active) {
                this.move(evt.clientX, evt.clientY);
            }
        } else if (evt.type === 'pointerup') {
            this.end(evt);
        }
    }
}

