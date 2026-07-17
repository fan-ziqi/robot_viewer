/**
 * MuJoCo Simulation Manager
 * Integrates MuJoCo physics simulation directly into existing Three.js scene
 * Does not use iframe, runs in the same rendering layer
 */
import * as THREE from 'three';
import { DragStateManager } from '../utils/DragStateManager.js';
import { MathUtils } from '../utils/MathUtils.js';
import { CoordinateAxesManager } from './CoordinateAxesManager.js';
import { InertialVisualization } from './InertialVisualization.js';
import { VisualizationManager } from './VisualizationManager.js';

export class MujocoSimulationManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.mujoco = null;
        this.model = null;
        this.simulation = null;
        this.state = null;
        this.data = null;
        this.bodies = {};  // MuJoCo body ID -> Three.js Group mapping
        this.bodyToThreeMap = new Map();  // MuJoCo body -> original model link
        this.lights = [];
        this.mujocoRoot = null;
        this.dragStateManager = null;
        this.originalModel = null;  // Save original UnifiedRobotModel

        // Simulation parameters
        this.params = {
            paused: true,
            ctrlnoiserate: 0.0,
            ctrlnoisestd: 0.0
        };

        this.mujoco_time = 0.0;
        this.tmpVec = new THREE.Vector3();
        this.tmpQuat = new THREE.Quaternion();

        // Whether loaded
        this.isLoaded = false;
        this.isSimulating = false;
        this.isOldAPI = false;
    }

    /**
     * Initialize MuJoCo WASM
     */
    async init() {
        if (this.mujoco) {
            return this.mujoco;
        }

        try {
            // Import from mujoco-js npm package
            const load_mujoco = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
            this.mujoco = await load_mujoco();

            // Setup virtual file system
            this.mujoco.FS.mkdir('/working');
            this.mujoco.FS.mount(this.mujoco.MEMFS, { root: '.' }, '/working');

            return this.mujoco;
        } catch (error) {
            console.error('MuJoCo WASM loading failed:', error);
            throw error;
        }
    }

    /**
     * Load MJCF scene from file (load physics engine only, use existing visualization model)
     * @param {string} xmlContent - XML content
     * @param {string} filename - File name
     * @param {Map} fileMap - File map
     * @param {UnifiedRobotModel} originalModel - Original model (for mapping)
     */
    async loadScene(xmlContent, filename, fileMap, originalModel) {
        try {
            // Ensure MuJoCo is initialized
            if (!this.mujoco) {
                await this.init();
            }

            // Clear old scene
            this.clearScene();

            // Save original model
            this.originalModel = originalModel;

            // Add ground plane to XML if not present
            const modifiedXml = this.addGroundPlane(xmlContent);

            // Write XML file to virtual file system
            const xmlPath = `/working/${filename}`;
            this.mujoco.FS.writeFile(xmlPath, modifiedXml);

            // Write dependency files (mesh, texture, etc.)
            if (fileMap && fileMap.size > 0) {
                await this.writeAssetsToVFS(xmlContent, filename, fileMap);
            }

            // Load model (compatible with old and new API)
            try {
                if (this.mujoco.Model && typeof this.mujoco.Model.load_from_xml === 'function') {
                    this.model = this.mujoco.Model.load_from_xml(xmlPath);
                    this.state = new this.mujoco.State(this.model);
                    this.simulation = new this.mujoco.Simulation(this.model, this.state);
                }
                else if (this.mujoco.MjModel && typeof this.mujoco.MjModel.loadFromXML === 'function') {
                    this.model = this.mujoco.MjModel.loadFromXML(xmlPath);
                    this.data = new this.mujoco.MjData(this.model);
                    this.isOldAPI = true;
                } else {
                    throw new Error('Cannot find MuJoCo model loading method');
                }
            } catch (loadError) {
                // Provide more detailed error information
                let errorMsg = 'MuJoCo model loading failed: ';

                if (loadError.message) {
                    errorMsg += loadError.message;
                } else {
                    errorMsg += 'Unknown error';
                }

                // Check if it's a mesh compilation error
                if (loadError.message && (loadError.message.includes('mesh') || loadError.message.includes('mjCMesh'))) {
                    errorMsg += '\n\nThis is usually caused by one of the following:';
                    errorMsg += '\n1. Mesh file path is incorrect or file is missing';
                    errorMsg += '\n2. Mesh file format is not supported or corrupted';
                    errorMsg += '\n3. Mesh file was not properly written to virtual file system';
                }

                // Log detailed error for debugging
                console.error('MuJoCo model loading error:', loadError);
                console.error('XML file path:', xmlPath);

                throw new Error(errorMsg);
            }

            // Create MuJoCo visualization model (created directly from physics engine)
            await this.createThreeScene();

            // Reset simulation (compatible with old and new API)
            if (this.isOldAPI) {
                this.mujoco.mj_resetData(this.model, this.data);
                this.mujoco.mj_forward(this.model, this.data);
            } else {
                this.simulation.resetData();
                this.simulation.forward();
            }

            this.isLoaded = true;
            this.params.paused = true;

            // Create drag state manager
            if (!this.dragStateManager) {
                const canvas = this.sceneManager.renderer.domElement;
                this.dragStateManager = new DragStateManager(
                    this.sceneManager.scene,
                    this.sceneManager.renderer,
                    this.sceneManager.camera,
                    canvas,
                    this.sceneManager.controls
                );
            }

            return null;
        } catch (error) {
            console.error('Failed to load MJCF scene:', error);
            throw error;
        }
    }

    /**
     * Add ground plane to MJCF scene
     */
    addGroundPlane(xmlContent) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlContent, 'application/xml');

        // Check if ground already exists (plane geom)
        const worldbody = doc.querySelector('worldbody');
        if (!worldbody) {
            return xmlContent;
        }

        // Check if plane already exists
        const existingPlane = worldbody.querySelector('geom[type="plane"]');
        if (existingPlane) {
            return xmlContent;
        }

        // Get Three.js ground current position, ensure MuJoCo ground aligns with it
        const threeGroundY = this.sceneManager.groundPlane ? this.sceneManager.groundPlane.position.y : 0;

        // Add ground geom
        const groundGeom = doc.createElement('geom');
        groundGeom.setAttribute('name', 'ground');
        groundGeom.setAttribute('type', 'plane');
        groundGeom.setAttribute('size', '10 10 0.1');
        groundGeom.setAttribute('rgba', '0.9 0.9 0.9 1');
        groundGeom.setAttribute('pos', `0 0 ${threeGroundY}`);  // Use Three.js ground height
        groundGeom.setAttribute('contype', '1');
        groundGeom.setAttribute('conaffinity', '1');
        groundGeom.setAttribute('condim', '3');
        groundGeom.setAttribute('friction', '1 0.005 0.0001');

        // Insert at beginning of worldbody
        if (worldbody.firstChild) {
            worldbody.insertBefore(groundGeom, worldbody.firstChild);
        } else {
            worldbody.appendChild(groundGeom);
        }

        const serializer = new XMLSerializer();
        return serializer.serializeToString(doc);
    }

    /**
     * Write asset files to MuJoCo virtual file system
     */
    async writeAssetsToVFS(xmlContent, filename, fileMap) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlContent, 'application/xml');

        // Get compiler settings
        const compilerEl = doc.querySelector('compiler');
        const meshdir = compilerEl?.getAttribute('meshdir') || 'assets';
        const texturedir = compilerEl?.getAttribute('texturedir') || meshdir;

        // Parse all asset references
        const assetPaths = new Set();
        const meshAssetMap = new Map(); // Map from resolved path to original mesh element

        // Parse mesh files
        doc.querySelectorAll('mesh[file]').forEach(el => {
            const file = el.getAttribute('file');
            if (file) {
                const resolvedPath = this.resolvePath(filename, meshdir, file);
                assetPaths.add(resolvedPath);
                meshAssetMap.set(resolvedPath, { original: file, element: el });
            }
        });

        // Parse texture files
        doc.querySelectorAll('texture[file]').forEach(el => {
            const file = el.getAttribute('file');
            if (file) {
                assetPaths.add(this.resolvePath(filename, texturedir, file));
            }
        });

        // Write files to VFS
        let successCount = 0;
        const missingFiles = [];
        const failedFiles = [];

        for (const assetPath of assetPaths) {
            // Extract all possible top-level directory prefixes from fileMap keys
            const topDirs = new Set();
            for (const key of fileMap.keys()) {
                if (key.startsWith('/')) {
                    const parts = key.split('/');
                    if (parts.length > 1) {
                        topDirs.add(parts[1]); // e.g., go2_description
                    }
                }
            }

            // Try multiple path variations to find file
            const pathVariations = [
                assetPath,                          // assets/base_0.obj
                '/' + assetPath,                    // /assets/base_0.obj
                'mjcf/' + assetPath,                // mjcf/assets/base_0.obj
                '/mjcf/' + assetPath,               // /mjcf/assets/base_0.obj
                assetPath.split('/').pop()          // base_0.obj
            ];

            // Add paths including top-level directories
            for (const topDir of topDirs) {
                pathVariations.push(`/${topDir}/mjcf/${assetPath}`);  // /go2_description/mjcf/assets/base_0.obj
                pathVariations.push(`${topDir}/mjcf/${assetPath}`);   // go2_description/mjcf/assets/base_0.obj
            }

            let file = null;
            let matchedKey = null;

            // First try exact matches
            for (const variation of pathVariations) {
                file = fileMap.get(variation);
                if (file) {
                    matchedKey = variation;
                    break;
                }
            }

            // If not found, try case-insensitive matching
            if (!file) {
                const assetPathLower = assetPath.toLowerCase();
                const fileNameOnly = assetPath.split('/').pop().toLowerCase();

                for (const [key, value] of fileMap.entries()) {
                    const keyLower = key.toLowerCase();
                    const keyFileName = key.split('/').pop().toLowerCase();

                    // Match by full path or filename
                    if (keyLower === assetPathLower ||
                        keyLower.endsWith('/' + assetPathLower) ||
                        keyFileName === fileNameOnly ||
                        keyLower.includes(assetPathLower)) {
                        file = value;
                        matchedKey = key;
                        break;
                    }
                }
            }

            if (file) {
                try {
                    const vfsPath = `/working/${assetPath}`;
                    this.ensureDir(vfsPath);

                    const ext = assetPath.toLowerCase().split('.').pop();
                    const binaryExts = ['obj', 'stl', 'png', 'jpg', 'jpeg', 'bmp'];

                    if (binaryExts.includes(ext)) {
                        const buffer = await file.arrayBuffer();
                        this.mujoco.FS.writeFile(vfsPath, new Uint8Array(buffer));
                    } else {
                        const text = await file.text();
                        this.mujoco.FS.writeFile(vfsPath, text);
                    }

                    // Verify file was written successfully
                    try {
                        const stat = this.mujoco.FS.stat(vfsPath);
                        if (!stat) {
                            throw new Error('File write verification failed');
                        }
                    } catch (verifyError) {
                        throw new Error('File write verification failed');
                    }

                    successCount++;
                } catch (error) {
                    const meshInfo = meshAssetMap.get(assetPath);
                    const displayPath = meshInfo ? meshInfo.original : assetPath;
                    failedFiles.push({ path: displayPath, error: error.message });
                }
            } else {
                const meshInfo = meshAssetMap.get(assetPath);
                const displayPath = meshInfo ? meshInfo.original : assetPath;
                missingFiles.push(displayPath);
            }
        }

        // If critical mesh files are missing, throw detailed error
        if (missingFiles.length > 0 || failedFiles.length > 0) {
            let errorMsg = 'MuJoCo asset files loading failed:\n';

            if (missingFiles.length > 0) {
                errorMsg += `\nMissing files (${missingFiles.length}):\n`;
                missingFiles.slice(0, 10).forEach(path => {
                    errorMsg += `  - ${path}\n`;
                });
                if (missingFiles.length > 10) {
                    errorMsg += `  ... ${missingFiles.length - 10} more files missing\n`;
                }
            }

            if (failedFiles.length > 0) {
                errorMsg += `\nFailed to write files (${failedFiles.length}):\n`;
                failedFiles.slice(0, 10).forEach(({ path, error }) => {
                    errorMsg += `  - ${path}: ${error}\n`;
                });
                if (failedFiles.length > 10) {
                    errorMsg += `  ... ${failedFiles.length - 10} more files failed\n`;
                }
            }

            errorMsg += `\nSuccessfully loaded: ${successCount} files`;
            errorMsg += `\n\nPlease ensure all mesh files are included in the file list.`;

            throw new Error(errorMsg);
        }
    }

    /**
     * Resolve asset path
     */
    resolvePath(xmlFile, baseDir, file) {
        // Get directory where XML file is located
        const xmlDir = xmlFile.includes('/') ? xmlFile.substring(0, xmlFile.lastIndexOf('/')) : '';

        // If file is absolute path (starts with /), use directly
        if (file.startsWith('/')) {
            return file.substring(1);
        }

        // Combine path
        const parts = [];
        if (xmlDir) parts.push(xmlDir);
        if (baseDir && baseDir !== '.') parts.push(baseDir);
        parts.push(file);

        return parts.join('/');
    }

    /**
     * Ensure directory exists
     */
    ensureDir(fullPath) {
        const parts = fullPath.split('/');
        let acc = '';
        for (let i = 0; i < parts.length - 1; i++) {
            acc += (i === 0 ? '' : '/') + parts[i];
            if (acc && !this.mujoco.FS.analyzePath(acc).exists) {
                this.mujoco.FS.mkdir(acc);
            }
        }
    }

    /**
     * Create MuJoCo visualization scene (create geometries directly from physics engine)
     */
    async createThreeScene() {
        const model = this.model;

        // Create root node
        this.mujocoRoot = new THREE.Group();
        this.mujocoRoot.name = 'MuJoCo Physics Root';
        this.mujocoRoot.userData.isMuJoCo = true;
        this.mujocoRoot.visible = false;

        this.bodies = {};
        const meshes = {};

        // Parse body names
        const textDecoder = new TextDecoder('utf-8');
        const names_array = new Uint8Array(model.names);

        // Get all mesh materials from original model
        // Map: bodyName -> array of materials (in order of visual geometries)
        const linkMeshMaterials = new Map();
        // Also create a map: bodyName -> array of visual geometries with their materials
        const linkVisualGeometries = new Map();

        if (this.originalModel) {
            for (const [linkName, link] of this.originalModel.links) {
                const materials = [];
                const visualGeoms = [];

                // Extract materials from visual geometries (in order)
                if (link.visuals && link.visuals.length > 0) {
                    for (const visual of link.visuals) {
                        if (visual.threeObject) {
                            visual.threeObject.traverse((child) => {
                                if (child.isMesh && child.material) {
                                    // Clone material to avoid modifying original
                                    // Handle material arrays (common in DAE files)
                                    let clonedMaterial;
                                    if (Array.isArray(child.material)) {
                                        clonedMaterial = child.material.map(mat => mat ? mat.clone() : null);
                                    } else if (child.material.clone) {
                                        clonedMaterial = child.material.clone();
                                    } else {
                                        // Fallback: create a default material if clone is not available
                                        clonedMaterial = new THREE.MeshPhongMaterial({
                                            color: child.material.color || 0x808080,
                                            transparent: child.material.transparent || false,
                                            opacity: child.material.opacity !== undefined ? child.material.opacity : 1.0
                                        });
                                    }

                                    materials.push(clonedMaterial);
                                    visualGeoms.push({
                                        material: clonedMaterial,
                                        geometry: visual.geometry
                                    });
                                }
                            });
                        }
                    }
                } else if (link.threeObject) {
                    // Fallback: traverse threeObject if no visuals array
                    link.threeObject.traverse((child) => {
                        if (child.isMesh && child.material) {
                            // Handle material arrays
                            let clonedMaterial;
                            if (Array.isArray(child.material)) {
                                clonedMaterial = child.material.map(mat => mat ? mat.clone() : null);
                            } else if (child.material.clone) {
                                clonedMaterial = child.material.clone();
                            } else {
                                clonedMaterial = new THREE.MeshPhongMaterial({
                                    color: child.material.color || 0x808080,
                                    transparent: child.material.transparent || false,
                                    opacity: child.material.opacity !== undefined ? child.material.opacity : 1.0
                                });
                            }
                            materials.push(clonedMaterial);
                        }
                    });
                }

                if (materials.length > 0) {
                    linkMeshMaterials.set(linkName, materials);
                    linkVisualGeometries.set(linkName, visualGeoms);
                }
            }
        }

        // Create geometries
        // Check collision display toggle state
        const showCollision = this.sceneManager.visualizationManager.showCollision;

        for (let g = 0; g < model.ngeom; g++) {
            const group = model.geom_group[g];

            // Skip group 4 and above
            if (group >= 4) {
                continue;
            }

            const b = model.geom_bodyid[g];
            const type = model.geom_type[g];
            const size = [
                model.geom_size[g * 3 + 0],
                model.geom_size[g * 3 + 1],
                model.geom_size[g * 3 + 2]
            ];

            // Create body group
            if (!this.bodies[b]) {
                this.bodies[b] = new THREE.Group();
                const start_idx = model.name_bodyadr[b];
                let end_idx = start_idx;
                while (end_idx < names_array.length && names_array[end_idx] !== 0) {
                    end_idx++;
                }
                const name_buffer = names_array.subarray(start_idx, end_idx);
                this.bodies[b].name = textDecoder.decode(name_buffer);
                this.bodies[b].bodyID = b;
            }

            // Create geometry (null = unhandled type, skipped below — a sphere fallback rendered
            // e.g. the injected ground plane as a giant radius-10 ball)
            let geometry = null;

            if (type == this.mujoco.mjtGeom.mjGEOM_PLANE.value) {
                // MuJoCo plane: size[0]/size[1] are half-extents (0 = infinite → pick a large
                // visual bound). Normal is geom-local +Z (MuJoCo) = +Y after the scene swizzle,
                // so bake the facing into the geometry like the other branches bake their axes.
                const w = size[0] > 0 ? size[0] * 2 : 40;
                const h = size[1] > 0 ? size[1] * 2 : 40;
                geometry = new THREE.PlaneGeometry(w, h);
                geometry.rotateX(-Math.PI / 2);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_SPHERE.value) {
                geometry = new THREE.SphereGeometry(size[0], 32, 32);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_CAPSULE.value) {
                geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2.0, 20, 20);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_CYLINDER.value) {
                geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2.0, 32);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_BOX.value) {
                geometry = new THREE.BoxGeometry(size[0] * 2.0, size[2] * 2.0, size[1] * 2.0);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
                geometry = new THREE.SphereGeometry(1, 32, 32);
            } else if (type == this.mujoco.mjtGeom.mjGEOM_MESH.value) {
                const meshID = model.geom_dataid[g];
                if (!(meshID in meshes)) {
                    geometry = this.createMeshGeometry(meshID);
                    meshes[meshID] = geometry;
                } else {
                    geometry = meshes[meshID];
                }
            }

            // Unhandled geom type: keep an INVISIBLE placeholder child so the per-body
            // geomIndex used for material pairing (bodies[b].children.length) stays aligned —
            // skipping the geom outright would shift every later geom in this body onto the
            // wrong original material.
            let placeholderGeom = false;
            if (!geometry) {
                console.warn(`[MuJoCo] unhandled geom type ${type} (geom ${g}) — invisible placeholder`);
                geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
                placeholderGeom = true;
            }

            // Prefer using original model materials
            const bodyName = this.bodies[b].name;
            const geomIndex = this.bodies[b].children.length; // Current geom index in this body
            let material;
            let usedOriginalMaterial = false;
            let rgbaFromOriginal = null;

            // Strategy 1: Try to find material by matching mesh name (most accurate)
            if (type == this.mujoco.mjtGeom.mjGEOM_MESH.value && linkVisualGeometries.has(bodyName)) {
                const meshID = model.geom_dataid[g];
                // Get mesh name from MuJoCo model
                const meshNameStart = model.name_meshadr[meshID];
                let meshNameEnd = meshNameStart;
                while (meshNameEnd < names_array.length && names_array[meshNameEnd] !== 0) {
                    meshNameEnd++;
                }
                const meshNameBuffer = names_array.subarray(meshNameStart, meshNameEnd);
                const meshName = textDecoder.decode(meshNameBuffer);

                // Try to find matching visual geometry by mesh reference
                const visualGeoms = linkVisualGeometries.get(bodyName);
                for (const visualGeom of visualGeoms) {
                    if (visualGeom.geometry && visualGeom.geometry.filename) {
                        const filename = visualGeom.geometry.filename.split('/').pop().split('\\').pop();
                        const filenameBase = filename.replace(/\.[^/.]+$/, ''); // Remove extension
                        const meshFileName = meshName + '.STL';
                        const meshFileNameBase = meshFileName.replace(/\.[^/.]+$/, '');

                        // Match by exact name, case-insensitive name, or filename patterns
                        if (filename === meshName || filename.toLowerCase() === meshName.toLowerCase() ||
                            filenameBase === meshName || filenameBase.toLowerCase() === meshName.toLowerCase() ||
                            filename === meshFileName || filename.toLowerCase() === meshFileName.toLowerCase() ||
                            filenameBase === meshFileNameBase || filenameBase.toLowerCase() === meshFileNameBase.toLowerCase()) {

                            // Clone material safely (handle material arrays)
                            if (Array.isArray(visualGeom.material)) {
                                // If material is array, take first material or create default
                                const firstMat = visualGeom.material[0];
                                if (firstMat && firstMat.clone) {
                                    material = firstMat.clone();
                                } else if (firstMat) {
                                    material = new THREE.MeshPhongMaterial({
                                        color: firstMat.color || 0x808080,
                                        transparent: firstMat.transparent || false,
                                        opacity: firstMat.opacity !== undefined ? firstMat.opacity : 1.0
                                    });
                                }
                            } else if (visualGeom.material && visualGeom.material.clone) {
                                material = visualGeom.material.clone();
                            } else if (visualGeom.material) {
                                material = new THREE.MeshPhongMaterial({
                                    color: visualGeom.material.color || 0x808080,
                                    transparent: visualGeom.material.transparent || false,
                                    opacity: visualGeom.material.opacity !== undefined ? visualGeom.material.opacity : 1.0
                                });
                            }

                            // Save original properties if not already saved (for lighting toggle)
                            if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
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
                                // Apply lighting based on current state
                                const enhancedLighting = this.sceneManager.visualizationManager.showEnhancedLighting;
                                if (enhancedLighting) {
                                    // Apply enhanced lighting
                                    if (material.shininess !== undefined && material.shininess < 50) {
                                        material.shininess = 50;
                                    }
                                    if (!material.specular || material.specular.r < 0.2) {
                                        material.specular = new THREE.Color(0.3, 0.3, 0.3);
                                    }
                                } else {
                                    // Restore original lighting if disabled
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
                            }
                            usedOriginalMaterial = true;
                            break;
                        }
                    }
                }

                // If material found but want to use rgba from userData, extract it
                if (usedOriginalMaterial && this.originalModel) {
                    const link = this.originalModel.links.get(bodyName);
                    if (link && link.visuals) {
                        for (const visual of link.visuals) {
                            if (visual.geometry && visual.geometry.filename) {
                                const filename = visual.geometry.filename.split('/').pop().split('\\').pop();
                                const filenameBase = filename.replace(/\.[^/.]+$/, '');
                                if (filenameBase.toLowerCase() === meshName.toLowerCase() ||
                                    filename.toLowerCase() === (meshName + '.STL').toLowerCase()) {
                                    if (visual.userData && visual.userData.rgba) {
                                        rgbaFromOriginal = visual.userData.rgba;
                                        // Update material color from rgba (if material exists)
                                        if (material && material.color) {
                                            material.color.setRGB(rgbaFromOriginal.r, rgbaFromOriginal.g, rgbaFromOriginal.b);
                                            if (rgbaFromOriginal.a < 1.0) {
                                                material.transparent = true;
                                                material.opacity = rgbaFromOriginal.a;
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Strategy 2: Try to get rgba from original model's visual geometry by index
            if (!usedOriginalMaterial && this.originalModel) {
                const link = this.originalModel.links.get(bodyName);
                if (link && link.visuals && link.visuals.length > 0) {
                    // Try to match by geom index
                    const visualIndex = Math.min(geomIndex, link.visuals.length - 1);
                    const visual = link.visuals[visualIndex];
                    if (visual) {
                        if (visual.userData && visual.userData.rgba) {
                            rgbaFromOriginal = visual.userData.rgba;
                        } else if (visual.threeObject) {
                            // Try to extract rgba from material
                            visual.threeObject.traverse((child) => {
                                if (child.isMesh && child.material && !rgbaFromOriginal) {
                                    const matColor = child.material.color;
                                    rgbaFromOriginal = {
                                        r: matColor.r,
                                        g: matColor.g,
                                        b: matColor.b,
                                        a: child.material.opacity !== undefined ? child.material.opacity : 1.0
                                    };
                                }
                            });
                        }
                    }
                }
            }

            // Strategy 3: Use materials array if available (fallback)
            if (!usedOriginalMaterial) {
                const bodyMaterials = linkMeshMaterials.get(bodyName);
                if (bodyMaterials && bodyMaterials.length > 0) {
                    const matIndex = Math.min(geomIndex, bodyMaterials.length - 1);
                    const sourceMaterial = bodyMaterials[matIndex];

                    // Clone material safely (handle material arrays)
                    if (Array.isArray(sourceMaterial)) {
                        const firstMat = sourceMaterial[0];
                        if (firstMat && firstMat.clone) {
                            material = firstMat.clone();
                        } else if (firstMat) {
                            material = new THREE.MeshPhongMaterial({
                                color: firstMat.color || 0x808080,
                                transparent: firstMat.transparent || false,
                                opacity: firstMat.opacity !== undefined ? firstMat.opacity : 1.0
                            });
                        }
                    } else if (sourceMaterial && sourceMaterial.clone) {
                        material = sourceMaterial.clone();
                    } else if (sourceMaterial) {
                        material = new THREE.MeshPhongMaterial({
                            color: sourceMaterial.color || 0x808080,
                            transparent: sourceMaterial.transparent || false,
                            opacity: sourceMaterial.opacity !== undefined ? sourceMaterial.opacity : 1.0
                        });
                    }

                    // Save original properties if not already saved (for lighting toggle)
                    if (material && (material.isMeshPhongMaterial || material.isMeshStandardMaterial)) {
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
                        // Apply lighting based on current state
                        const enhancedLighting = this.sceneManager.visualizationManager.showEnhancedLighting;
                        if (enhancedLighting) {
                            // Apply enhanced lighting
                            if (material.shininess !== undefined && material.shininess < 50) {
                                material.shininess = 50;
                            }
                            if (!material.specular || material.specular.r < 0.2) {
                                material.specular = new THREE.Color(0.3, 0.3, 0.3);
                            }
                        } else {
                            // Restore original lighting if disabled
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
                    }
                    usedOriginalMaterial = true;
                }
            }

            // Strategy 4: Create material using rgba from original model or MuJoCo colors
            if (!usedOriginalMaterial) {
                const color = rgbaFromOriginal ?
                    [rgbaFromOriginal.r, rgbaFromOriginal.g, rgbaFromOriginal.b, rgbaFromOriginal.a] :
                    [
                        model.geom_rgba[g * 4 + 0],
                        model.geom_rgba[g * 4 + 1],
                        model.geom_rgba[g * 4 + 2],
                        model.geom_rgba[g * 4 + 3]
                    ];

                // If group=3 collision geom, set semi-transparent green for debugging
                const isCollisionGeom = group === 3;
                // Check current enhanced lighting state
                const enhancedLighting = this.sceneManager.visualizationManager.showEnhancedLighting;
                material = new THREE.MeshPhongMaterial({
                    color: isCollisionGeom ? new THREE.Color(0, 1, 0) : new THREE.Color(color[0], color[1], color[2]),
                    transparent: isCollisionGeom ? true : (color[3] < 1.0),
                    opacity: isCollisionGeom ? 0.3 : color[3],
                    shininess: enhancedLighting ? 50 : 30,  // Apply based on lighting state
                    specular: enhancedLighting ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111),  // Apply based on lighting state
                    wireframe: isCollisionGeom ? true : false  // Collision geoms displayed as wireframe
                });
                // Save original properties for lighting toggle
                material.userData.originalShininess = 30;
                material.userData.originalSpecular = null; // New material, no original specular
            }

            // Ensure material has correct lighting state applied
            if (material.isMeshPhongMaterial || material.isMeshStandardMaterial) {
                const enhancedLighting = this.sceneManager.visualizationManager.showEnhancedLighting;
                if (enhancedLighting) {
                    // Ensure enhanced lighting is applied
                    if (material.shininess < 50) {
                        material.shininess = 50;
                    }
                    if (!material.specular || (material.specular.isColor && material.specular.r < 0.2)) {
                        material.specular = new THREE.Color(0.3, 0.3, 0.3);
                    }
                } else {
                    // Ensure original lighting is applied
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

            // Create mesh
            let finalMaterial = material;

            // Use special material for collision geometry (semi-transparent yellow)
            if (group === 3) {
                finalMaterial = new THREE.MeshPhongMaterial({
                    transparent: true,
                    opacity: 0.35,
                    shininess: 2.5,
                    premultipliedAlpha: true,
                    color: 0xffbe38,
                    polygonOffset: true,
                    polygonOffsetFactor: -1,
                    polygonOffsetUnits: -1,
                });
            }

            const mesh = new THREE.Mesh(geometry, finalMaterial);
            mesh.castShadow = group !== 3;  // Collision geoms don't cast shadows
            mesh.receiveShadow = group !== 3;
            mesh.bodyID = b;

            // Mark collision geom and set initial visibility
            if (group === 3) {
                mesh.userData.isCollisionGeom = true;
                mesh.visible = showCollision;  // Set initial visibility based on UI button state
            }
            if (placeholderGeom) mesh.visible = false;

            // Set position and rotation (geom offset relative to body)
            this.getPosition(model.geom_pos, g, mesh.position);
            this.getQuaternion(model.geom_quat, g, mesh.quaternion);

            if (type == this.mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
                mesh.scale.set(size[0], size[2], size[1]);
            }

            this.bodies[b].add(mesh);
        }

        // Add all bodies to root node (flat structure)
        for (let b = 0; b < model.nbody; b++) {
            if (!this.bodies[b]) {
                this.bodies[b] = new THREE.Group();
                this.bodies[b].name = `body_${b}`;
                this.bodies[b].bodyID = b;
            }
            this.mujocoRoot.add(this.bodies[b]);

            this.bodies[b].traverse((child) => {
                if (child.isMesh) {
                    child.bodyID = b;
                }
            });
        }

        // Create visualization elements (coordinate axes, COM, inertia, joint axes)
        this.createVisualizationElements(model);

        return this.mujocoRoot;
    }

    /**
     * Create visualization elements (coordinate axes, COM, inertia, joint axes)
     * Directly use static methods from CoordinateAxesManager and InertialVisualization
     */
    createVisualizationElements(model) {
        // Get current UI button states
        const showAxes = document.getElementById('toggle-axes-btn')?.getAttribute('data-checked') === 'true';
        const showJointAxes = document.getElementById('toggle-joint-axes-btn')?.getAttribute('data-checked') === 'true';
        const showCOM = document.getElementById('show-com')?.classList.contains('active');
        const showInertia = document.getElementById('show-inertia')?.classList.contains('active');

        // Create visualization elements for each body
        for (let b = 0; b < model.nbody; b++) {
            if (!this.bodies[b]) continue;

            // 1. Coordinate axes - use CoordinateAxesManager.createAxesGeometry
            const axesGroup = CoordinateAxesManager.createAxesGeometry(0.1);
            axesGroup.userData.isVisualization = true;
            axesGroup.userData.type = 'axes';
            axesGroup.visible = showAxes;
            axesGroup.raycast = () => {};

            // Apply correction rotation to align axes with actual body orientation
            // Need -90° rotation around X axis (or 270°)
            const correctionQuat = new THREE.Quaternion();
            correctionQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
            axesGroup.quaternion.copy(correctionQuat);

            this.bodies[b].add(axesGroup);

            const mass = model.body_mass[b];
            if (mass > 0) {
                // 2. COM marker - use InertialVisualization.createCOMGeometry
                const comMarker = InertialVisualization.createCOMGeometry(0.02);
                comMarker.userData.isVisualization = true;
                comMarker.userData.type = 'com';
                comMarker.visible = showCOM;
                this.getPosition(model.body_ipos, b, comMarker.position);
                this.bodies[b].add(comMarker);

                // 3. Inertia box - use MathUtils (consistent with InertialVisualization)
                const mujoco_ixx = model.body_inertia[b * 3 + 0];
                const mujoco_iyy = model.body_inertia[b * 3 + 1];
                const mujoco_izz = model.body_inertia[b * 3 + 2];

                // Coordinate system conversion
                const inertia = {
                    ixx: mujoco_ixx,
                    iyy: mujoco_izz,
                    izz: mujoco_iyy,
                    mass: mass
                };

                const boxData = MathUtils.computeInertiaBox(inertia);
                const boxGeometry = MathUtils.createInertiaBoxGeometry(
                    boxData.width, boxData.height, boxData.depth
                );

                const boxMaterial = new THREE.MeshPhongMaterial({
                    color: 0x4a9eff,
                    transparent: true,
                    opacity: 0.35,
                    shininess: 2.5,
                    polygonOffset: true,
                    polygonOffsetFactor: -1,
                    polygonOffsetUnits: -1
                });

                const inertiaBox = new THREE.Mesh(boxGeometry, boxMaterial);
                inertiaBox.userData.isVisualization = true;
                inertiaBox.userData.type = 'inertia';
                inertiaBox.visible = showInertia;
                inertiaBox.castShadow = false;
                inertiaBox.receiveShadow = false;
                inertiaBox.raycast = () => {};

                this.getPosition(model.body_ipos, b, inertiaBox.position);
                if (model.body_iquat) {
                    this.getQuaternion(model.body_iquat, b, inertiaBox.quaternion);
                }

                this.bodies[b].add(inertiaBox);
            }
        }

        // 4. Joint axes - use CoordinateAxesManager.createJointArrowGeometry
        for (let j = 0; j < model.njnt; j++) {
            const jointType = model.jnt_type[j];
            const bodyId = model.jnt_bodyid[j];

            if ((jointType === this.mujoco.mjtJoint.mjJNT_HINGE.value ||
                 jointType === this.mujoco.mjtJoint.mjJNT_BALL.value) &&
                this.bodies[bodyId]) {

                const axis = new THREE.Vector3();
                this.getPosition(model.jnt_axis, j, axis);

                if (axis.length() > 0.001) {
                    axis.normalize();

                    const jointAxis = CoordinateAxesManager.createJointArrowGeometry(axis);
                    jointAxis.userData.isVisualization = true;
                    jointAxis.userData.type = 'jointAxis';
                    jointAxis.visible = showJointAxes;
                    jointAxis.raycast = () => {};

                    this.getPosition(model.jnt_pos, j, jointAxis.position);
                    this.bodies[bodyId].add(jointAxis);
                }
            }
        }
    }

    /**
     * Create mesh geometry (from MuJoCo data)
     */
    createMeshGeometry(meshID) {
        const model = this.model;
        const geometry = new THREE.BufferGeometry();

        // slice(), not subarray(): these are live views into the WASM heap backing mjModel —
        // swizzling them in place corrupts MuJoCo's own mesh data (and compounds on re-create).
        const vertex_buffer = model.mesh_vert.slice(
            model.mesh_vertadr[meshID] * 3,
            (model.mesh_vertadr[meshID] + model.mesh_vertnum[meshID]) * 3
        );

        // Coordinate system conversion: MuJoCo -> Three.js
        for (let v = 0; v < vertex_buffer.length; v += 3) {
            const temp = vertex_buffer[v + 1];
            vertex_buffer[v + 1] = vertex_buffer[v + 2];
            vertex_buffer[v + 2] = -temp;
        }

        const normal_buffer = model.mesh_normal.slice(
            model.mesh_vertadr[meshID] * 3,
            (model.mesh_vertadr[meshID] + model.mesh_vertnum[meshID]) * 3
        );

        for (let v = 0; v < normal_buffer.length; v += 3) {
            const temp = normal_buffer[v + 1];
            normal_buffer[v + 1] = normal_buffer[v + 2];
            normal_buffer[v + 2] = -temp;
        }

        const triangle_buffer = model.mesh_face.subarray(
            model.mesh_faceadr[meshID] * 3,
            (model.mesh_faceadr[meshID] + model.mesh_facenum[meshID]) * 3
        );

        geometry.setAttribute('position', new THREE.BufferAttribute(vertex_buffer, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normal_buffer, 3));
        geometry.setIndex(Array.from(triangle_buffer));
        geometry.computeVertexNormals();

        return geometry;
    }


    /**
     * Get position (coordinate system conversion MuJoCo -> Three.js)
     */
    getPosition(buffer, index, target, swizzle = true) {
        if (swizzle) {
            return target.set(
                buffer[index * 3 + 0],
                buffer[index * 3 + 2],
                -buffer[index * 3 + 1]
            );
        } else {
            return target.set(
                buffer[index * 3 + 0],
                buffer[index * 3 + 1],
                buffer[index * 3 + 2]
            );
        }
    }

    /**
     * Get quaternion (coordinate system conversion MuJoCo -> Three.js)
     */
    getQuaternion(buffer, index, target, swizzle = true) {
        if (swizzle) {
            return target.set(
                -buffer[index * 4 + 1],
                -buffer[index * 4 + 3],
                buffer[index * 4 + 2],
                -buffer[index * 4 + 0]
            );
        } else {
            return target.set(
                buffer[index * 4 + 1],
                buffer[index * 4 + 2],
                buffer[index * 4 + 3],
                buffer[index * 4 + 0]
            );
        }
    }

    /**
     * Update simulation (called in render loop)
     */
    update(timeMS) {
        if (!this.isLoaded || !this.model) {
            return;
        }

        if (!this.params.paused) {
            // Get timestep (compatible with old and new API)
            const timestep = this.isOldAPI ? this.model.opt.timestep : this.model.getOptions().timestep;

            // Time synchronization
            if (timeMS - this.mujoco_time > 35.0) {
                this.mujoco_time = timeMS;
            }

            // Step simulation (compatible with old and new API)
            while (this.mujoco_time < timeMS) {
                // Clear old applied forces
                if (this.isOldAPI) {
                    for (let i = 0; i < this.data.qfrc_applied.length; i++) {
                        this.data.qfrc_applied[i] = 0.0;
                    }
                }

                // Apply drag force
                if (this.dragStateManager && this.dragStateManager.active) {
                    const dragged = this.dragStateManager.physicsObject;
                    if (dragged && dragged.bodyID) {
                        // First update body positions to get current state
                        const xpos = this.isOldAPI ? this.data.xpos : this.simulation.xpos;
                        const xquat = this.isOldAPI ? this.data.xquat : this.simulation.xquat;

                        for (let b = 0; b < this.model.nbody; b++) {
                            const bodyGroup = this.bodies[b];
                            if (bodyGroup) {
                                this.getPosition(xpos, b, bodyGroup.position);
                                this.getQuaternion(xquat, b, bodyGroup.quaternion);
                                bodyGroup.updateMatrixWorld(true);
                            }
                        }

                        // Update drag state
                        this.dragStateManager.update();

                        const bodyID = dragged.bodyID;
                        const force = this.toMujocoPos(
                            this.dragStateManager.currentWorld.clone()
                                .sub(this.dragStateManager.worldHit)
                                .multiplyScalar(this.model.body_mass[bodyID] * 250)
                        );
                        const point = this.toMujocoPos(this.dragStateManager.worldHit.clone());

                        if (this.isOldAPI) {
                            this.mujoco.mj_applyFT(
                                this.model,
                                this.data,
                                [force.x, force.y, force.z],
                                [0, 0, 0],
                                [point.x, point.y, point.z],
                                bodyID,
                                this.data.qfrc_applied
                            );
                        }
                    }
                }

                if (this.isOldAPI) {
                    this.mujoco.mj_step(this.model, this.data);
                } else {
                    this.simulation.step();
                }
                this.mujoco_time += timestep * 1000.0;
            }
        }

        // Update original model body transforms (using MuJoCo physics calculation results)
        const xpos = this.isOldAPI ? this.data.xpos : this.simulation.xpos;
        const xquat = this.isOldAPI ? this.data.xquat : this.simulation.xquat;

        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (bodyGroup) {
                this.getPosition(xpos, b, bodyGroup.position, true);  // Use coordinate conversion
                this.getQuaternion(xquat, b, bodyGroup.quaternion, true);  // Use coordinate conversion
                bodyGroup.updateMatrixWorld(true);
            }
        }
    }

    /**
     * Convert to MuJoCo coordinate system
     */
    toMujocoPos(target) {
        return target.set(target.x, -target.z, target.y);
    }

    /**
     * Reset simulation
     */
    reset() {
        if (this.model) {
            // Save current simulation state (don't pause simulation)
            const wasSimulating = this.isSimulating;

            // Reset physics state
            if (this.isOldAPI) {
                this.mujoco.mj_resetData(this.model, this.data);
                this.mujoco.mj_forward(this.model, this.data);
            } else {
                this.simulation.resetData();
                this.simulation.forward();
            }
            this.mujoco_time = 0;
        }
    }

    /**
     * Start simulation
     */
    startSimulation() {
        this.params.paused = false;
        this.isSimulating = true;

        // Show MuJoCo model
        if (this.mujocoRoot) {
            if (!this.mujocoRoot.parent) {
                this.sceneManager.scene.add(this.mujocoRoot);
            }
            this.mujocoRoot.visible = true;
        }

        // Hide original model (use MuJoCo model instead)
        if (this.sceneManager.currentModel && this.sceneManager.currentModel.threeObject) {
            this.sceneManager.currentModel.threeObject.visible = false;
        }

        // Enable physics dragging
        if (this.dragStateManager) {
            this.dragStateManager.enable();
        }

        // Disable original model drag controls and interactions
        if (this.sceneManager.dragControls) {
            this.sceneManager.dragControls.enabled = false;
        }

        // Clear original model highlights
        if (this.sceneManager.highlightManager) {
            this.sceneManager.highlightManager.clearHighlight();
        }
    }

    /**
     * Pause simulation
     */
    pauseSimulation() {
        this.params.paused = true;
        this.isSimulating = false;

        // Disable physics dragging
        if (this.dragStateManager) {
            this.dragStateManager.disable();
        }

        // Hide MuJoCo model
        if (this.mujocoRoot) {
            this.mujocoRoot.visible = false;
        }

        // Restore original model drag controls
        if (this.sceneManager.dragControls) {
            this.sceneManager.dragControls.enabled = true;
        }
    }

    /**
     * Toggle simulation state
     */
    toggleSimulation() {
        if (this.params.paused) {
            this.startSimulation();
        } else {
            this.pauseSimulation();
        }
        return !this.params.paused;
    }

    /**
     * Clear scene
     */
    clearScene() {
        // Release MuJoCo resources (compatible with old and new API)
        if (this.isOldAPI) {
            if (this.data) {
                this.data.delete();
                this.data = null;
            }
            if (this.model) {
                this.model.delete();
                this.model = null;
            }
        } else {
            if (this.simulation) {
                this.simulation.free();
                this.simulation = null;
            }
            if (this.state) {
                this.state = null;
            }
            if (this.model) {
                this.model = null;
            }
        }

        // Clear files in VFS
        if (this.mujoco && this.mujoco.FS) {
            try {
                // Clear /working directory
                const files = this.mujoco.FS.readdir('/working');
                for (const file of files) {
                    if (file !== '.' && file !== '..') {
                        try {
                            const path = '/working/' + file;
                            const stat = this.mujoco.FS.stat(path);
                            if (this.mujoco.FS.isDir(stat.mode)) {
                                // Recursively delete directory
                                this.removeDirectory(path);
                            } else {
                                this.mujoco.FS.unlink(path);
                            }
                        } catch (e) {
                            // Ignore deletion errors
                        }
                    }
                }
            } catch (e) {
                // Ignore cleanup errors
            }
        }

        // Clear Three.js objects
        if (this.mujocoRoot) {
            if (this.mujocoRoot.parent) {
                this.mujocoRoot.parent.remove(this.mujocoRoot);
            }
            this.mujocoRoot = null;
        }

        // Restore original model visibility
        if (this.sceneManager.currentModel && this.sceneManager.currentModel.threeObject) {
            this.sceneManager.currentModel.threeObject.visible = true;
        }

        // Restore original model drag controls
        if (this.sceneManager.dragControls) {
            this.sceneManager.dragControls.enabled = true;
        }

        // Clear drag manager
        if (this.dragStateManager) {
            this.dragStateManager.disable();
            if (this.dragStateManager.arrow && this.dragStateManager.arrow.parent) {
                this.dragStateManager.arrow.parent.remove(this.dragStateManager.arrow);
            }
            this.dragStateManager = null;
        }

        this.originalModel = null;
        this.bodies = {};
        this.lights = [];
        this.isLoaded = false;
        this.isSimulating = false;
        this.params.paused = true;
    }

    /**
     * Recursively delete directory
     */
    removeDirectory(path) {
        if (!this.mujoco || !this.mujoco.FS) return;

        try {
            const files = this.mujoco.FS.readdir(path);
            for (const file of files) {
                if (file !== '.' && file !== '..') {
                    const fullPath = path + '/' + file;
                    const stat = this.mujoco.FS.stat(fullPath);
                    if (this.mujoco.FS.isDir(stat.mode)) {
                        this.removeDirectory(fullPath);
                    } else {
                        this.mujoco.FS.unlink(fullPath);
                    }
                }
            }
            this.mujoco.FS.rmdir(path);
        } catch (e) {
            // Ignore deletion errors
        }
    }

    /**
     * Toggle collision display
     */
    toggleCollisionDisplay(showCollision) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide group=3 collision geoms
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.children.forEach(mesh => {
                if (mesh.userData && mesh.userData.isCollisionGeom) {
                    mesh.visible = showCollision;
                }
            });
        }

        this.sceneManager.redraw();
    }

    /**
     * Toggle visual geometry display
     */
    toggleVisualDisplay(showVisual) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide non-visualization element geometries
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.children.forEach(child => {
                // Only control meshes (not visualization helper elements)
                if (child.isMesh && !child.userData.isVisualization && !child.userData.isCollisionGeom) {
                    child.visible = showVisual;
                }
            });
        }

        this.sceneManager.redraw();
    }

    /**
     * Update visual model transparency
     * Use VisualizationManager.setMeshTransparency static method
     */
    updateVisualTransparency() {
        if (!this.mujocoRoot) return;

        // Check if any visualization features are enabled (excluding inertia)
        const showCOM = document.getElementById('show-com')?.classList.contains('active');
        const showAxes = document.getElementById('toggle-axes-btn')?.getAttribute('data-checked') === 'true';
        const showJointAxes = document.getElementById('toggle-joint-axes-btn')?.getAttribute('data-checked') === 'true';

        const shouldBeTransparent = showCOM || showAxes || showJointAxes;

        // Traverse all body visual meshes, use VisualizationManager static method
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.children.forEach(mesh => {
                // Only process visual meshes (excluding visualization helper elements and collision geoms)
                if (mesh.isMesh && !mesh.userData.isVisualization && !mesh.userData.isCollisionGeom) {
                    VisualizationManager.setMeshTransparency(mesh, shouldBeTransparent);
                }
            });
        }

        this.sceneManager.redraw();
    }

    /**
     * Toggle COM display
     */
    toggleCOMDisplay(showCOM) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide COM markers
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.traverse(obj => {
                if (obj.userData && obj.userData.type === 'com') {
                    obj.visible = showCOM;
                }
            });
        }

        this.updateVisualTransparency();
        this.sceneManager.redraw();
    }

    /**
     * Toggle inertia display
     */
    toggleInertiaDisplay(showInertia) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide inertia boxes
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.traverse(obj => {
                if (obj.userData && obj.userData.type === 'inertia') {
                    obj.visible = showInertia;
                }
            });
        }

        this.updateVisualTransparency();
        this.sceneManager.redraw();
    }

    /**
     * Toggle axes display
     */
    toggleAxesDisplay(showAxes) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide coordinate axes
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.traverse(obj => {
                if (obj.userData && obj.userData.type === 'axes') {
                    obj.visible = showAxes;
                }
            });
        }

        this.updateVisualTransparency();
        this.sceneManager.redraw();
    }

    /**
     * Toggle joint axes display
     */
    toggleJointAxesDisplay(showJointAxes) {
        if (!this.mujocoRoot) return;

        // Traverse all bodies, show/hide joint axes
        for (let b = 0; b < this.model.nbody; b++) {
            const bodyGroup = this.bodies[b];
            if (!bodyGroup) continue;

            bodyGroup.traverse(obj => {
                if (obj.userData && obj.userData.type === 'jointAxis') {
                    obj.visible = showJointAxes;
                }
            });
        }

        this.updateVisualTransparency();
        this.sceneManager.redraw();
    }

    /**
     * Check if simulation is running
     */
    isSimulationRunning() {
        return this.isSimulating;
    }

    /**
     * Check if scene is loaded
     */
    hasScene() {
        return this.isLoaded;
    }
}

