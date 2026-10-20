import * as THREE from 'three';

/**
 * VisualizationManager - Handles visual and collision mesh extraction and visibility
 */
export class VisualizationManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.visualMeshes = [];
        this.collisionMeshes = [];
        this.colliders = [];
        this.hiddenLinks = new Set();

        // Display states
        this.showVisual = true;
        this.showCollision = false;
        this.showShadow = true;
        this.showEnhancedLighting = true;  // Default: enhanced lighting enabled
    }

    /**
     * Extract visual and collision meshes from model
     */
    extractVisualAndCollision(model) {
        // Clear arrays only on first call to avoid duplicates on subsequent async calls
        const isFirstCall = this.visualMeshes.length === 0;
        if (!isFirstCall) {
            // Subsequent call - only process newly loaded meshes
            return this.processNewlyLoadedMeshes(model);
        }

        this.visualMeshes = [];
        this.collisionMeshes = [];
        this.colliders = [];

        if (!model.threeObject) return;

        // First pass: ensure all materials are properly set up (especially for DAE/STL files loaded asynchronously)
        // This ensures materials have original properties saved AND enhanced lighting applied
        model.threeObject.traverse((child) => {
            // Viewer helpers (axes, COM, inertia) are not robot geometry
            if (VisualizationManager.isVisualizationHelper(child)) return;
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                const processedMaterials = [];

                materials.forEach((material, matIndex) => {
                    if (!material) {
                        processedMaterials.push(null);
                        return;
                    }

                    // Convert MeshBasicMaterial or MeshLambertMaterial to MeshPhongMaterial
                    if (material.type === 'MeshBasicMaterial' || material.type === 'MeshLambertMaterial') {
                        const oldMaterial = material;
                        const enhancedLighting = this.showEnhancedLighting;
                        const envMap = this.sceneManager.environmentManager?.getEnvironmentMap();
                        const newMaterial = new THREE.MeshPhongMaterial({
                            color: oldMaterial.color,
                            map: oldMaterial.map,
                            transparent: oldMaterial.transparent,
                            opacity: oldMaterial.opacity,
                            side: oldMaterial.side,
                            shininess: enhancedLighting ? 50 : 30,
                            specular: enhancedLighting ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111),
                            envMap: envMap || null,
                            reflectivity: envMap ? 0.3 : 0
                        });
                        newMaterial.userData.originalShininess = 30;
                        newMaterial.userData.originalSpecular = null;
                        if (newMaterial.map) {
                            newMaterial.map.colorSpace = THREE.SRGBColorSpace;
                        }
                        processedMaterials.push(newMaterial);
                        material = newMaterial;
                    } else {
                        processedMaterials.push(material);
                    }

                    // Save original properties and apply enhanced lighting for all Phong/Standard materials
                    if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
                        // Save original properties if not already saved
                        if (material.userData.originalShininess === undefined) {
                            material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                            if (!material.specular) {
                                material.userData.originalSpecular = null;
                            } else if (material.specular.isColor) {
                                const spec = material.specular;
                                if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                    material.userData.originalSpecular = null;
                                } else {
                                    material.userData.originalSpecular = spec.clone();
                                }
                            } else if (typeof material.specular === 'number') {
                                if (material.specular === 0x111111 || material.specular < 0x111111) {
                                    material.userData.originalSpecular = null;
                                } else {
                                    material.userData.originalSpecular = new THREE.Color(material.specular);
                                }
                            } else {
                                material.userData.originalSpecular = null;
                            }
                        }

                        // Apply enhanced lighting if enabled (this was missing!)
                        if (this.showEnhancedLighting) {
                            if (material.shininess === undefined || material.shininess < 50) {
                                material.shininess = 50;
                            }
                            if (!material.specular ||
                                (material.specular.isColor && material.specular.r < 0.2) ||
                                (typeof material.specular === 'number' && material.specular < 0x333333)) {
                                material.specular = new THREE.Color(0.3, 0.3, 0.3);
                            }
                            material.needsUpdate = true;
                        }
                    }
                });

                // Update mesh material (handle arrays)
                if (Array.isArray(child.material)) {
                    child.material = processedMaterials;
                } else if (processedMaterials.length === 1 && processedMaterials[0]) {
                    child.material = processedMaterials[0];
                }
            }
        });

        // Step 1: Collect all colliders and apply current display state
        // Only collect colliders on first call
        if (isFirstCall) {
            model.threeObject.traverse((child) => {
                if (child.isURDFCollider) {
                    this.colliders.push(child);
                    child.visible = this.showCollision;
                }
            });
        }
        // Step 2: Process collider materials (only on first call)
        if (isFirstCall) {
            this.colliders.forEach(collider => {
            collider.traverse((child) => {
                if (child.isMesh) {
                    // Save original material
                    if (!child.userData.originalMaterial) {
                        child.userData.originalMaterial = child.material;
                    }

                    // Set collision-specific material (semi-transparent yellow)
                    child.material = new THREE.MeshPhongMaterial({
                        transparent: true,
                        opacity: 0.35,
                        shininess: 2.5,
                        premultipliedAlpha: true,
                        color: 0xffbe38,
                        polygonOffset: true,
                        polygonOffsetFactor: -1,
                        polygonOffsetUnits: -1,
                    });

                    child.castShadow = false;
                    child.receiveShadow = false;

                    // Disable raycasting for colliders (don't interfere with dragging)
                    child.raycast = () => {};

                        this.collisionMeshes.push(child);
                    }
                });
            });
        }

        // Step 3: Collect all visual meshes (materials already processed in first pass)
        model.threeObject.traverse((child) => {
            // Viewer helpers (axes, COM, inertia) are not robot geometry
            if (VisualizationManager.isVisualizationHelper(child)) return;
            if (child.isMesh || child.type === 'Mesh') {
                // Check if self or parent is a collider
                let isInCollider = false;
                let checkNode = child;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }

                // Only add non-collider meshes
                if (!isInCollider) {
                    child.castShadow = this.showShadow;
                    child.receiveShadow = this.showShadow;
                    child.visible = this.showVisual;
                    this.visualMeshes.push(child);
                }
            }
        });
    }

    /**
     * Process newly loaded meshes (for subsequent async calls)
     */
    processNewlyLoadedMeshes(model) {
        if (!model.threeObject) return;

        // First pass: Process materials for visual meshes only (skip collision meshes)
        model.threeObject.traverse((child) => {
            // Viewer helpers (axes, COM, inertia) are not robot geometry
            if (VisualizationManager.isVisualizationHelper(child)) return;
            if (child.isMesh && child.material) {
                // Check if this is a collision mesh
                let isInCollider = false;
                let checkNode = child;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }

                // Skip collision meshes in material processing - they will be handled separately
                if (isInCollider) {
                    return;
                }

                const materials = Array.isArray(child.material) ? child.material : [child.material];
                const processedMaterials = [];

                materials.forEach((material, matIndex) => {
                    if (!material) {
                        processedMaterials.push(null);
                        return;
                    }

                    // Convert MeshBasicMaterial or MeshLambertMaterial to MeshPhongMaterial
                    if (material.type === 'MeshBasicMaterial' || material.type === 'MeshLambertMaterial') {
                        const oldMaterial = material;
                        const enhancedLighting = this.showEnhancedLighting;
                        const envMap = this.sceneManager.environmentManager?.getEnvironmentMap();
                        const newMaterial = new THREE.MeshPhongMaterial({
                            color: oldMaterial.color,
                            map: oldMaterial.map,
                            transparent: oldMaterial.transparent,
                            opacity: oldMaterial.opacity,
                            side: oldMaterial.side,
                            shininess: enhancedLighting ? 50 : 30,
                            specular: enhancedLighting ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111),
                            envMap: envMap || null,
                            reflectivity: envMap ? 0.3 : 0
                        });
                        newMaterial.userData.originalShininess = 30;
                        newMaterial.userData.originalSpecular = null;
                        if (newMaterial.map) {
                            newMaterial.map.colorSpace = THREE.SRGBColorSpace;
                        }
                        processedMaterials.push(newMaterial);
                        material = newMaterial;
                    } else {
                        processedMaterials.push(material);
                    }

                    // Save original properties and apply enhanced lighting for Phong/Standard materials
                    if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
                        if (material.userData.originalShininess === undefined) {
                            material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                            if (!material.specular) {
                                material.userData.originalSpecular = null;
                            } else if (material.specular.isColor) {
                                const spec = material.specular;
                                if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                    material.userData.originalSpecular = null;
                                } else {
                                    material.userData.originalSpecular = spec.clone();
                                }
                            } else if (typeof material.specular === 'number') {
                                if (material.specular === 0x111111 || material.specular < 0x111111) {
                                    material.userData.originalSpecular = null;
                                } else {
                                    material.userData.originalSpecular = new THREE.Color(material.specular);
                                }
                            } else {
                                material.userData.originalSpecular = null;
                            }
                        }

                        // Apply environment map for reflections
                        const envMap = this.sceneManager.environmentManager?.getEnvironmentMap();
                        if (envMap && !material.envMap) {
                            material.envMap = envMap;
                            if (material.reflectivity === undefined) {
                                material.reflectivity = 0.3;
                            }
                            material.needsUpdate = true;
                        }

                        if (this.showEnhancedLighting) {
                            if (material.shininess === undefined || material.shininess < 50) {
                                material.shininess = 50;
                            }
                            if (!material.specular ||
                                (material.specular.isColor && material.specular.r < 0.2) ||
                                (typeof material.specular === 'number' && material.specular < 0x333333)) {
                                material.specular = new THREE.Color(0.3, 0.3, 0.3);
                            }
                            material.needsUpdate = true;
                        }
                    }
                });

                // Update mesh material
                if (Array.isArray(child.material)) {
                    child.material = processedMaterials;
                } else if (processedMaterials.length === 1 && processedMaterials[0]) {
                    child.material = processedMaterials[0];
                }
            }
        });

        // Second pass: Add newly loaded visual meshes or collision meshes
        model.threeObject.traverse((child) => {
            // Viewer helpers (axes, COM, inertia) are not robot geometry
            if (VisualizationManager.isVisualizationHelper(child)) return;

            // Add newly loaded visual meshes or collision meshes
            if ((child.isMesh || child.type === 'Mesh') && !this.visualMeshes.includes(child) && !this.collisionMeshes.includes(child)) {
                let isInCollider = false;
                let checkNode = child;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }

                if (isInCollider) {
                    // This is a newly loaded collision mesh - set collision material
                    if (!child.userData.originalMaterial) {
                        child.userData.originalMaterial = child.material;
                    }

                    // Set collision-specific material (semi-transparent yellow)
                    child.material = new THREE.MeshPhongMaterial({
                        transparent: true,
                        opacity: 0.35,
                        shininess: 2.5,
                        premultipliedAlpha: true,
                        color: 0xffbe38,
                        polygonOffset: true,
                        polygonOffsetFactor: -1,
                        polygonOffsetUnits: -1,
                    });

                    child.castShadow = false;
                    child.receiveShadow = false;

                    // Disable raycasting for colliders
                    child.raycast = () => {};

                    // Set visibility based on current collision display state
                    child.visible = this.showCollision;

                    this.collisionMeshes.push(child);
                } else {
                    // This is a visual mesh
                    child.castShadow = this.showShadow;
                    child.receiveShadow = this.showShadow;
                    child.visible = this.showVisual;
                    this.visualMeshes.push(child);
                }
            }
        });
    }

    /**
     * Toggle visual mesh visibility
     */
    toggleVisual(show, currentModel) {
        this.showVisual = show;

        // Update all visual meshes, considering individually hidden links
        if (currentModel && currentModel.links) {
            currentModel.links.forEach((link, linkName) => {
                if (link.threeObject) {
                    // If link is individually hidden, keep it hidden; otherwise follow global setting
                    const shouldBeVisible = show && !this.hiddenLinks.has(linkName);
                    this.setLinkVisibility(link.threeObject, shouldBeVisible, currentModel);
                }
            });
        }
    }

    /**
     * Toggle collision mesh visibility
     */
    toggleCollision(show) {
        this.showCollision = show;
        // Set visibility for both collider parent objects and internal meshes
        if (this.colliders) {
            this.colliders.forEach(collider => {
                collider.visible = show;
            });
        }
        this.collisionMeshes.forEach(mesh => {
            mesh.visible = show;
        });
    }

    /**
     * Toggle shadow casting/receiving
     */
    toggleShadow(show, renderer, directionalLight) {
        this.showShadow = show;

        // Update renderer shadow settings
        renderer.shadowMap.enabled = show;

        // Update light shadow casting
        if (directionalLight) {
            directionalLight.castShadow = show;
        }

        // Update all visual meshes shadow casting/receiving
        this.visualMeshes.forEach(mesh => {
            mesh.castShadow = show;
            mesh.receiveShadow = show;
        });

        // Clear shadow map if disabling (ensures immediate effect)
        if (!show && directionalLight && directionalLight.shadow) {
            directionalLight.shadow.map?.dispose();
            directionalLight.shadow.map = null;
        }
    }

    /**
     * Toggle enhanced lighting (shininess and specular)
     */
    toggleEnhancedLighting(enable) {
        this.showEnhancedLighting = enable;

        // Process current model first (most comprehensive, covers all meshes including DAE files)
        // This is critical because DAE files may have nested Groups and material arrays
        if (this.sceneManager && this.sceneManager.currentModel && this.sceneManager.currentModel.threeObject) {
            this.sceneManager.currentModel.threeObject.traverse((child) => {
                // Viewer helpers (axes, COM, inertia) are not robot geometry
                if (VisualizationManager.isVisualizationHelper(child)) return;
                if (child.isMesh && child.material && !this.collisionMeshes.includes(child)) {
                    // Handle material arrays (common in DAE files with multiple materials)
                    const materials = Array.isArray(child.material) ? child.material : [child.material];

                    materials.forEach((material, matIndex) => {
                        if (!material) return;

                        // Convert MeshBasicMaterial or MeshLambertMaterial to MeshPhongMaterial
                        if (material.type === 'MeshBasicMaterial' || material.type === 'MeshLambertMaterial') {
                            const oldMaterial = material;
                            const newMaterial = new THREE.MeshPhongMaterial({
                                color: oldMaterial.color,
                                map: oldMaterial.map,
                                transparent: oldMaterial.transparent,
                                opacity: oldMaterial.opacity,
                                side: oldMaterial.side,
                                shininess: enable ? 50 : 30,
                                specular: enable ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111)
                            });
                            newMaterial.userData.originalShininess = 30;
                            newMaterial.userData.originalSpecular = null;
                            if (newMaterial.map) {
                                newMaterial.map.colorSpace = THREE.SRGBColorSpace;
                            }
                            materials[matIndex] = newMaterial;
                            material = newMaterial;
                        }

                        if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
                            // Save original properties if not already saved
                            if (material.userData.originalShininess === undefined) {
                                material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                                // Save original specular
                                if (!material.specular) {
                                    material.userData.originalSpecular = null;
                                } else if (material.specular.isColor) {
                                    const spec = material.specular;
                                    if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                        material.userData.originalSpecular = null;
                                    } else {
                                        material.userData.originalSpecular = spec.clone();
                                    }
                                } else if (typeof material.specular === 'number') {
                                    if (material.specular === 0x111111 || material.specular < 0x111111) {
                                        material.userData.originalSpecular = null;
                                    } else {
                                        material.userData.originalSpecular = new THREE.Color(material.specular);
                                    }
                                } else {
                                    material.userData.originalSpecular = null;
                                }
                            }

                            if (enable) {
                                // Apply enhanced lighting
                                material.shininess = 50;
                                if (!material.specular ||
                                    (material.specular.isColor && material.specular.r < 0.2) ||
                                    (typeof material.specular === 'number' && material.specular < 0x333333)) {
                                    material.specular = new THREE.Color(0.3, 0.3, 0.3);
                                }
                            } else {
                                // Restore original lighting
                                if (material.userData.originalShininess !== undefined) {
                                    material.shininess = material.userData.originalShininess;
                                }
                                if (material.userData.originalSpecular === null) {
                                    material.specular = new THREE.Color(0x111111);
                                } else if (material.userData.originalSpecular) {
                                    const originalSpec = material.userData.originalSpecular;
                                    if (originalSpec.isColor) {
                                        material.specular = originalSpec.clone();
                                    } else {
                                        material.specular = originalSpec;
                                    }
                                }
                            }
                            material.needsUpdate = true;
                        }
                    });

                    // Update mesh material (handle arrays)
                    if (Array.isArray(child.material)) {
                        child.material = materials;
                        materials.forEach(mat => {
                            if (mat) mat.needsUpdate = true;
                        });
                    } else if (materials.length === 1) {
                        child.material = materials[0];
                        if (child.material) child.material.needsUpdate = true;
                    }
                }
            });
        }

        // Also process visual meshes (for compatibility)
        this.visualMeshes.forEach(mesh => {
            if (mesh.material) {
                // Handle material arrays (common in DAE files with multiple materials)
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

                materials.forEach((material, matIndex) => {
                    if (!material) return;

                    // Convert MeshBasicMaterial or MeshLambertMaterial to MeshPhongMaterial
                    if (material.type === 'MeshBasicMaterial' || material.type === 'MeshLambertMaterial') {
                        const oldMaterial = material;
                        const enhancedLighting = enable;
                        const envMap = this.sceneManager.environmentManager?.getEnvironmentMap();
                        const newMaterial = new THREE.MeshPhongMaterial({
                            color: oldMaterial.color,
                            map: oldMaterial.map,
                            transparent: oldMaterial.transparent,
                            opacity: oldMaterial.opacity,
                            side: oldMaterial.side,
                            shininess: enhancedLighting ? 50 : 30,
                            specular: enhancedLighting ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111),
                            envMap: envMap || null,
                            reflectivity: envMap ? 0.3 : 0
                        });
                        newMaterial.userData.originalShininess = 30;
                        newMaterial.userData.originalSpecular = null;
                        if (newMaterial.map) {
                            newMaterial.map.colorSpace = THREE.SRGBColorSpace;
                        }
                        materials[matIndex] = newMaterial;
                        material = newMaterial;
                    }

                    if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
                        // Save original properties if not already saved
                        if (material.userData.originalShininess === undefined) {
                            material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                            // Save original specular - if material had no specular, save null
                            // Check if specular exists and is not the default dark value (0x111111)
                            if (!material.specular) {
                                material.userData.originalSpecular = null; // Mark as "no specular"
                            } else if (material.specular.isColor) {
                                // Check if it's Three.js default (0x111111)
                                const spec = material.specular;
                                if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                    material.userData.originalSpecular = null; // Likely default, treat as no specular
                                } else {
                                    material.userData.originalSpecular = spec.clone();
                                }
                            } else if (typeof material.specular === 'number') {
                                if (material.specular === 0x111111 || material.specular < 0x111111) {
                                    material.userData.originalSpecular = null; // Default or darker
                                } else {
                                    material.userData.originalSpecular = new THREE.Color(material.specular);
                                }
                            } else {
                                material.userData.originalSpecular = null;
                            }
                        }

                        if (enable) {
                            // Apply enhanced lighting
                            material.shininess = 50;
                            if (!material.specular ||
                                (material.specular.isColor && material.specular.r < 0.2) ||
                                (typeof material.specular === 'number' && material.specular < 0x333333)) {
                                material.specular = new THREE.Color(0.3, 0.3, 0.3);
                            }
                        } else {
                            // Restore original lighting
                            if (material.userData.originalShininess !== undefined) {
                                material.shininess = material.userData.originalShininess;
                            }
                            // Check if original material had no specular (marked as null)
                            if (material.userData.originalSpecular === null) {
                                // Original material had no specular, use Three.js default
                                material.specular = new THREE.Color(0x111111);
                            } else if (material.userData.originalSpecular) {
                                const originalSpec = material.userData.originalSpecular;
                                if (originalSpec.isColor) {
                                    material.specular = originalSpec.clone();
                                } else {
                                    material.specular = originalSpec;
                                }
                            }
                            // If no original specular saved, keep current (shouldn't happen)
                        }
                        material.needsUpdate = true;
                    }
                });

                // If material was an array, ensure the mesh uses the updated array
                // This is critical for DAE files with multiple materials
                if (Array.isArray(mesh.material)) {
                    mesh.material = materials;
                    // Mark all materials in array as needing update
                    materials.forEach(mat => {
                        if (mat) mat.needsUpdate = true;
                    });
                } else if (materials.length === 1) {
                    mesh.material = materials[0];
                    if (mesh.material) mesh.material.needsUpdate = true;
                }
            }
        });


        // Also process MuJoCo simulation scene if available
        // Access mujocoSimulationManager through window.app (it's in App class, not SceneManager)
        const mujocoManager = window.app?.mujocoSimulationManager;
        if (mujocoManager && mujocoManager.mujocoRoot) {
            mujocoManager.mujocoRoot.traverse((child) => {
                if (child.isMesh && child.material) {
                    const materials = Array.isArray(child.material) ? child.material : [child.material];

                    materials.forEach(material => {
                        if (material.isMeshPhongMaterial || material.isMeshStandardMaterial) {
                            // Save original properties if not already saved
                            if (material.userData.originalShininess === undefined) {
                                material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                                // Save original specular
                                if (!material.specular) {
                                    material.userData.originalSpecular = null;
                                } else if (material.specular.isColor) {
                                    const spec = material.specular;
                                    if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                        material.userData.originalSpecular = null;
                                    } else {
                                        material.userData.originalSpecular = spec.clone();
                                    }
                                } else {
                                    material.userData.originalSpecular = null;
                                }
                            }

                            if (enable) {
                                // Apply enhanced lighting
                                material.shininess = 50;
                                if (!material.specular ||
                                    (material.specular.isColor && material.specular.r < 0.2) ||
                                    (typeof material.specular === 'number' && material.specular < 0x333333)) {
                                    material.specular = new THREE.Color(0.3, 0.3, 0.3);
                                }
                            } else {
                                // Restore original lighting
                                if (material.userData.originalShininess !== undefined) {
                                    material.shininess = material.userData.originalShininess;
                                }
                                // Check if original material had no specular (marked as null)
                                if (material.userData.originalSpecular === null) {
                                    // Original material had no specular, use Three.js default
                                    material.specular = new THREE.Color(0x111111);
                                } else if (material.userData.originalSpecular) {
                                    const originalSpec = material.userData.originalSpecular;
                                    if (originalSpec.isColor) {
                                        material.specular = originalSpec.clone();
                                    } else {
                                        material.specular = originalSpec;
                                    }
                                }
                            }
                            material.needsUpdate = true;
                        }
                    });
                }
            });
        }
    }

    /**
     * Toggle individual link visibility
     */
    toggleLinkVisibility(linkName, currentModel) {
        if (!currentModel || !currentModel.links) {
            return false;
        }

        const link = currentModel.links.get(linkName);
        if (!link || !link.threeObject) {
            return false;
        }

        // Toggle hidden state
        const isHidden = this.hiddenLinks.has(linkName);
        if (isHidden) {
            this.hiddenLinks.delete(linkName);
        } else {
            this.hiddenLinks.add(linkName);
        }

        const newVisibility = !isHidden ? false : true;

        // Update link's all visual mesh visibility (including fixed child links)
        this.setLinkVisibility(link.threeObject, newVisibility, currentModel);
        return newVisibility;
    }

    /**
     * Check if link is hidden
     */
    isLinkHidden(linkName) {
        return this.hiddenLinks.has(linkName);
    }

    /**
     * Set link and its fixed child links visibility
     */
    setLinkVisibility(linkObject, visible, currentModel) {
        // Recursively traverse link and its fixed child links
        const traverseNonRecursive = (obj, isRoot = false) => {
            // If not root and is URDFLink, stop (this is a non-fixed child link)
            if (!isRoot && (obj.type === 'URDFLink' || obj.isURDFLink)) {
                return;
            }

            // If is URDFJoint
            if (obj.isURDFJoint || obj.type === 'URDFJoint') {
                // Check if it's a fixed joint
                const jointName = obj.name;
                let isFixed = false;

                if (jointName && currentModel?.joints && currentModel.joints.has(jointName)) {
                    const joint = currentModel.joints.get(jointName);
                    isFixed = (joint.type === 'fixed');
                }

                if (isFixed) {
                    // Continue traversing fixed joint's children (merged display)
                    for (const child of obj.children) {
                        traverseNonRecursive(child, false);
                    }
                    return;
                } else {
                    // Encountered movable joint, stop
                    return;
                }
            }

            // Skip auxiliary visualization objects and their entire subtrees
            if (this.isAuxiliaryVisualization(obj) || obj.userData?.isCenterOfMass || obj.userData?.isInertiaBox) {
                return; // Skip completely, don't process children
            }

            // Skip coordinate axes (should be independent of visual display)
            if (obj.name && obj.name.endsWith('_axes')) {
                return; // Skip coordinate axes and their children
            }

            // Process mesh
            if (obj.type === 'Mesh' || obj.isMesh) {
                // Skip collision mesh - don't modify collision visibility here
                let isCollision = false;
                let checkNode = obj;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isCollision = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }
                if (isCollision || obj.userData?.isCollision) {
                    return;
                }

                // Set visibility (only affects visual meshes, considering global showVisual state)
                obj.visible = visible && this.showVisual;
            }

            // Recursively process children
            for (const child of obj.children) {
                traverseNonRecursive(child, false);
            }
        };

        // Start traversing from root link
        traverseNonRecursive(linkObject, true);
    }

    /**
     * Check if object is auxiliary visualization object (should not be highlighted)
     */
    isAuxiliaryVisualization(obj) {
        // Check if in auxiliary object lists (will be set by InertialVisualization)
        if (obj.userData?.isInertiaBox) return true;
        if (obj.userData?.isCOMMarker) return true;
        if (obj.userData?.isCollision) return true;

        return false;
    }

    /**
     * Check if object belongs to a viewer helper (link axes, joint axes, COM, inertia)
     * Helpers are parented into the robot tree so they follow joint motion, but they
     * are not robot geometry. The flag sits on the helper's root group, so walk up.
     * Any new helper added under the robot tree must set userData.isVisualization.
     */
    static isVisualizationHelper(obj) {
        for (let node = obj; node; node = node.parent) {
            if (node.userData?.isVisualization) return true;
        }
        return false;
    }

    /**
     * Update visual model transparency
     * When COM, axes, or joint axes are enabled, set model to semi-transparent
     * Note: Inertia visualization does NOT make model transparent
     * Note: Only affects robot models with joints, not single meshes
     */
    updateVisualTransparency(showCOM, showAxes, showJointAxes, isSingleMesh) {
        // Single mesh doesn't need transparency effect
        if (isSingleMesh) {
            return;
        }

        // Check if any feature is enabled (inertia visualization excluded)
        const shouldBeTransparent = showCOM || showAxes || showJointAxes;
        // Traverse all visual meshes and set transparency
        this.visualMeshes.forEach((mesh, index) => {
            VisualizationManager.setMeshTransparency(mesh, shouldBeTransparent, index);
        });
    }

    /**
     * Static method: Set mesh transparency
     * @param {THREE.Mesh} mesh - The mesh to set transparency on
     * @param {boolean} shouldBeTransparent - Whether to make transparent
     * @param {number} index - Optional index for logging
     */
    static setMeshTransparency(mesh, shouldBeTransparent, index = -1) {
        if (!mesh.material) {
            return;
        }

        // Handle material array case
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

        materials.forEach(material => {
            // Save original material info (if not already saved)
            // Must save on first call, regardless of whether transparency is needed
            if (material.userData.originalOpacity === undefined) {
                material.userData.originalOpacity = material.opacity !== undefined ? material.opacity : 1.0;
                material.userData.originalTransparent = material.transparent || false;
            }

            if (shouldBeTransparent) {
                // Set semi-transparent
                material.transparent = true;
                material.opacity = 0.5;
                material.needsUpdate = true;
            } else {
                // Restore original state
                if (material.userData.originalOpacity !== undefined) {
                    material.opacity = material.userData.originalOpacity;
                    material.transparent = material.userData.originalTransparent;
                    material.needsUpdate = true;
                }
            }
        });
    }

    /**
     * Clear all meshes
     */
    clear() {
        this.visualMeshes = [];
        this.collisionMeshes = [];
        this.colliders = [];
        this.hiddenLinks.clear();
    }
}

