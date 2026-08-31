/**
 * Model Loader Factory
 * Selects appropriate adapter based on file type
 */
import * as THREE from 'three';
import { URDFAdapter } from '../adapters/URDFAdapter.js';
import { MJCFAdapter } from '../adapters/MJCFAdapter.js';
import { USDAdapter } from '../adapters/USDAdapter.js';
import { XacroAdapter } from '../adapters/XacroAdapter.js';
import { resolveFileFromMap } from '../utils/FileUtils.js';

export class ModelLoaderFactory {
    /**
     * Detect file type
     */
    static detectFileType(fileName, content) {
        const ext = fileName.toLowerCase().split('.').pop();

        switch (ext) {
            case 'urdf':
                return 'urdf';
            case 'xacro':
                return 'xacro';
            case 'xml':
                // XML files are MJCF format, verify the document by content
                if (content) {
                    // Verify if it's a valid MJCF model or scene
                    if (this.isValidRobotMJCF(content)) {
                        return 'mjcf';
                    } else {
                        return null;
                    }
                }
                return null;
            case 'usd':
            case 'usda':
            case 'usdc':
            case 'usdz':
                return 'usd';
            default:
                return null;
        }
    }

    /**
     * Verify if XML is a valid robot description file
     * @param {string} content - XML file content
     * @returns {boolean} Whether it's a valid robot description file
     */
    static isValidRobotDescriptionXML(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Remove comments and extra whitespace
        const cleanContent = content.trim();

        // Check if valid XML
        if (!cleanContent.startsWith('<?xml') && !cleanContent.startsWith('<')) {
            return false;
        }

        // XML files are MJCF format, including standalone scenes.
        return this.isValidRobotMJCF(cleanContent);
    }

    /**
     * Verify if XML contains a complete MJCF model or scene
     * @param {string} content - MJCF file content
     * @returns {boolean} Whether it's a robot MJCF file
     */
    static isValidRobotMJCF(content) {
        if (!content || typeof content !== 'string') {
            return false;
        }

        // Must contain <mujoco> root element
        if (!content.includes('<mujoco')) {
            return false;
        }

        // A scene can be a valid MJCF document without joints/actuators (for
        // example, microduck's scene.xml includes the robot and adds a floor).
        // Only reject XML fragments such as sensors.xml and additional.xml;
        // those do not have a worldbody/include and cannot be displayed alone.
        const hasWorldbody = /<worldbody\b/i.test(content);
        const hasInclude = /<include\b/i.test(content);
        const hasJoints = /<joint\b/i.test(content);
        const hasActuators = /<actuator\b/i.test(content);

        if (hasWorldbody || hasInclude || hasJoints || hasActuators) {
            return true;
        }

        // No model/scene sections means this is an included XML fragment, not
        // a standalone file that the viewer can load.
        return false;
    }

    /**
     * Load model
     * @param {string} fileType - File type
     * @param {string} content - File content
     * @param {string} fileName - File name (key in fileMap)
     * @param {Map} fileMap - File map (path -> File object), for loading mesh files
     * @param {File} file - Original file object (optional)
     * @param {Object} options - Additional options (e.g., usdViewerManager)
     */
    static async loadModel(fileType, content, fileName, fileMap = null, file = null, options = {}) {
        // Extract base path from fileName for MJCF include resolution
        let basePath = null;
        if (fileName) {
            const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
            if (lastSlash > 0) {
                basePath = fileName.substring(0, lastSlash);
            }
        }

        switch (fileType) {
            case 'urdf':
                return await this.loadURDF(content, fileName, fileMap, file);
            case 'xacro':
                return await this.loadXacro(content, fileName, fileMap, file);
            case 'mjcf':
                return await this.loadMJCF(content, fileMap, basePath);
            case 'usd':
                return await this.loadUSD(content, fileMap, file, options);
            default:
                throw new Error(`Unsupported file type: ${fileType}`);
        }
    }

    /**
     * Load URDF
     * @param {string} content - URDF content
     * @param {string} fileName - URDF file key in fileMap (includes path)
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object (optional)
     */
    static async loadURDF(content, fileName, fileMap = null, file = null) {
        // Dynamically import urdf-loader
        let URDFLoader;
        try {
            const urdfModule = await import('urdf-loader');
            URDFLoader = urdfModule.URDFLoader || urdfModule.default || urdfModule;
        } catch (error) {
            throw new Error('Failed to load urdf-loader: ' + error.message);
        }

        return new Promise((resolve, reject) => {
            const loader = new URDFLoader();

            // Enable collision parsing
            loader.parseCollision = true;

            // Extract directory where URDF file is located (workingPath)
            // fileName might be "e3.urdf" or "e3_v2/e3.urdf"
            const urdfDir = fileName.includes('/') ? fileName.substring(0, fileName.lastIndexOf('/') + 1) : '';

            // If file map provided, setup resource loader
            if (fileMap) {
                // Parse URDF content, find all used package names
                const packages = this.extractPackagesFromURDF(content);

                // Build package map (urdf-loader expects string paths)
                const packageMap = {};

                // Create mapping for each package, return a path prefix for resolvePath
                packages.forEach(pkg => {
                    // Provide a path prefix, resolvePath will concatenate it with relative path
                    // Example: if URDF has package://go2w_description/meshes/file.stl
                    // resolvePath returns: packages['go2w_description'] + '/' + 'meshes/file.stl'
                    // We return a virtual path, actual loading handled in loadMeshCb
                    packageMap[pkg] = pkg; // Return package name itself
                });

                // Add default empty package mapping
                packageMap[''] = '';

                loader.packages = packageMap;

                // Set URL Modifier to intercept all URL requests (including textures)
                // This MUST be set on loader.manager to catch TextureLoader requests
                const urlModifier = (url) => {
                    // Check if this is a malformed blob URL (blob:http://host/filename instead of blob:http://host/uuid)
                    // This can happen when ColladaLoader or other loaders incorrectly create blob URLs
                    if (url.startsWith('blob:')) {
                        // Extract the path after blob:http://host/
                        const blobMatch = url.match(/^blob:https?:\/\/[^\/]+\/(.+)$/);
                        if (blobMatch && blobMatch[1]) {
                            const fileName = blobMatch[1];
                            // If it looks like a filename (has extension), it's a malformed blob URL
                            if (/\.(jpg|jpeg|png|gif|bmp|tga|tiff|webp|dae|stl|obj|gltf|glb)$/i.test(fileName)) {
                                // Treat it as a regular file path and process it
                                url = fileName;
                            } else {
                                // Valid blob URL format (has UUID), return as-is
                                return url;
                            }
                        } else {
                            // Valid blob URL format, return as-is
                            return url;
                        }
                    }

                    const isTextureFile = /\.(jpg|jpeg|png|gif|bmp|tga|tiff|webp)$/i.test(url);
                    const isMeshFile = /\.(dae|stl|obj|gltf|glb)$/i.test(url);

                    // Clean path - handle both absolute URLs and relative paths
                    let meshPath = url;

                    // Remove http:// or https:// prefix if present (shouldn't happen but be safe)
                    if (meshPath.startsWith('http://') || meshPath.startsWith('https://')) {
                        // This is an absolute URL, try to extract path
                        try {
                            const urlObj = new URL(meshPath);
                            meshPath = urlObj.pathname;
                            // Remove leading slash
                            if (meshPath.startsWith('/')) {
                                meshPath = meshPath.substring(1);
                            }
                        } catch (e) {
                            // Invalid URL, use as-is
                        }
                    }

                    const matchedFile = resolveFileFromMap(meshPath, fileMap, { baseDir: urdfDir });

                    if (matchedFile) {
                        // Create Blob URL (don't revoke immediately, let loader finish using it)
                        const bloburl = URL.createObjectURL(matchedFile);
                        // IMPORTANT: Return the blob URL directly - TextureLoader will use it as-is
                        return bloburl;
                    }

                    // If not found, return original URL - urdf-loader will handle it
                    return url;
                };

                // Set the URL modifier on the manager
                loader.manager.setURLModifier(urlModifier);

                // Custom loadMeshCb to load mesh files from fileMap
                const originalLoadMeshCb = loader.loadMeshCb || loader.defaultMeshLoader.bind(loader);
                loader.loadMeshCb = (path, manager, done) => {
                    // Use Promise but don't await, let loading happen in background
                    this.findFileInMapByPath(path, fileMap, urdfDir).then(file => {
                        if (file) {
                            // Directly use Three.js loaders to load mesh file

                            // Select appropriate loader based on file extension
                            const ext = (file.name || path).toLowerCase().split('.').pop();

                            // Dynamically import corresponding loader and load file
                            this.loadMeshFileAsync(file, ext, manager).then(meshObject => {
                                if (meshObject) {
                                    done(meshObject, null);
                                } else {
                                    done(null, new Error(`Failed to load mesh file: ${path}`));
                                }
                            }).catch(err => {
                                console.error(`Failed to load mesh: ${path}`, err);
                                done(null, err);
                            });
                        } else {
                            // If not found, try using original path loader
                            originalLoadMeshCb(path, manager, done);
                        }
                    }).catch(error => {
                        console.error(`Failed to find file: ${path}`, error);
                        // Try using original path loader
                        originalLoadMeshCb(path, manager, done);
                    });
                };
            }

            // Create temporary URL
            const blob = new Blob([content], { type: 'text/xml' });
            const url = URL.createObjectURL(blob);

            loader.load(url, (robot) => {
                URL.revokeObjectURL(url);

                // Convert to unified model
                try {
                    const model = URDFAdapter.convert(robot, content); // Pass original XML content
                    resolve(model);
                } catch (error) {
                    console.error('URDF conversion error:', error);
                    reject(new Error('URDF conversion failed: ' + error.message));
                }
            }, undefined, (error) => {
                URL.revokeObjectURL(url);
                console.error('URDF loading error:', error);
                reject(new Error('URDF loading failed: ' + (error.message || error)));
            });
        });
    }

    /**
     * Load Xacro
     * @param {string} content - Xacro content
     * @param {string} fileName - Xacro file key in fileMap (includes path)
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object (optional)
     */
    static async loadXacro(content, fileName, fileMap = null, file = null) {
        try {
            const model = await XacroAdapter.parse(content, fileName, fileMap, file);
            return model;
        } catch (error) {
            console.error('Xacro parsing error:', error);
            throw new Error('Xacro parsing failed: ' + error.message);
        }
    }

    /**
     * Extract all used package names from URDF content
     * @param {string} urdfContent - URDF file content
     * @returns {Set<string>} Set of package names
     */
    static extractPackagesFromURDF(urdfContent) {
        const packages = new Set();
        // Match package://package_name/... format
        const packageRegex = /package:\/\/([^\/]+)/g;
        let match;
        while ((match = packageRegex.exec(urdfContent)) !== null) {
            packages.add(match[1]);
        }
        return packages;
    }

    /**
     * Resolve URDF path (supports package paths and relative paths)
     * Reference urdf-loaders resolvePath implementation
     * @param {string} path - File path (urdf-loader already removed package:// prefix)
     * @param {string} pkg - Package name
     * @param {Map} fileMap - File map
     * @param {string} fileName - URDF file name
     * @returns {Promise<ArrayBuffer>}
     */
    static async resolveURDFPath(path, pkg, fileMap, fileName) {
        // path is already relative path with package:// prefix removed
        // Example: meshes/wheel.stl or wheel.stl

        // Build list of possible paths
        const possiblePaths = [];

        // If has package name, try package-related paths
        if (pkg) {
            // package://package_name/path/to/file -> package_name/path/to/file
            possiblePaths.push(`${pkg}/${path}`);
            possiblePaths.push(`/${pkg}/${path}`); // Support paths starting with /

            // Also try direct filename (if path contains subdirectories)
            const fileNameOnly = path.split('/').pop();
            possiblePaths.push(`${pkg}/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/urdf/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/models/${fileNameOnly}`);

            // Find if fileMap has directories starting with package name
            const pkgLower = pkg.toLowerCase();
            for (const [key] of fileMap.entries()) {
                const keyLower = key.toLowerCase();
                // Check if key contains package name
                if (keyLower.includes(pkgLower)) {
                    // Extract relative path after package
                    const pkgIndex = keyLower.indexOf(pkgLower);
                    const relativePath = key.substring(pkgIndex + pkg.length);
                    const fileNameOnly = path.split('/').pop();

                    // Check if matches
                    if (relativePath.endsWith(path) ||
                        relativePath.endsWith(`/${path}`) ||
                        relativePath.endsWith(fileNameOnly) ||
                        relativePath.endsWith(`/${fileNameOnly}`) ||
                        relativePath.includes(fileNameOnly)) {
                        possiblePaths.push(key);
                    }
                }
            }
        }

        // Try relative paths
        const dir = fileName.substring(0, fileName.lastIndexOf('/') + 1);
        possiblePaths.push(path);
        possiblePaths.push(dir + path);

        // Try filename only
        const fileNameOnly = path.split('/').pop();
        possiblePaths.push(fileNameOnly);

        // Try each path one by one
        for (const tryPath of possiblePaths) {
            let file = fileMap.get(tryPath);
            if (file) {
                return await file.arrayBuffer();
            }
        }

        // Try fuzzy matching (filename matching, reference dragAndDrop.js logic)
        const cleaned = this.cleanFilePath(path);
        const fileNames = Array.from(fileMap.keys()).map(n => this.cleanFilePath(n));

        for (const fileKey of fileNames) {
            // Check if filename endings match
            const len = Math.min(fileKey.length, cleaned.length);
            if (cleaned.substr(cleaned.length - len) === fileKey.substr(fileKey.length - len)) {
                const file = fileMap.get(fileKey);
                if (file) {
                    return await file.arrayBuffer();
                }
            }
        }

        // If not found, log warning but don't throw error
        console.warn(`Cannot find URDF file: ${path} (package: ${pkg})`);

        // Return empty ArrayBuffer instead of throwing error
        return new ArrayBuffer(0);
    }

    /**
     * Clean file path (remove '..' and '.', normalize slashes)
     * Reference dragAndDrop.js cleanFilePath
     */
    static cleanFilePath(path) {
        return path
            .replace(/\\/g, '/')
            .split(/\//g)
            .reduce((acc, el) => {
                if (el === '..') acc.pop();
                else if (el !== '.') acc.push(el);
                return acc;
            }, [])
            .join('/');
    }

    /**
     * Find file in fileMap based on URDF directory
     * @param {string} path - File path (path passed by urdf-loader)
     * @param {Map} fileMap - File map
     * @param {string} urdfDir - Directory where URDF file is located
     * @returns {Promise<File|null>}
     */
    static async findFileInMapByPath(path, fileMap, urdfDir) {
        return resolveFileFromMap(path, fileMap, { baseDir: urdfDir });
    }

    /**
     * Find file in fileMap (old method, kept for backward compatibility)
     * @param {string} path - File path (may be path returned by resolvePath)
     * @param {Map} fileMap - File map
     * @param {string} fileName - URDF filename
     * @returns {Promise<File|null>}
     */
    static async findFileInMap(path, fileMap, fileName) {
        // Remove package:// prefix (if present)
        let searchPath = path.replace(/^package:\/\//, '');

        // Remove leading ./
        searchPath = searchPath.replace(/^\.\//, '');

        // Remove blob: prefix (if present)
        searchPath = searchPath.replace(/^blob:[^\/]+\//, '');

        // Build list of possible paths
        const possiblePaths = [];

        // Extract package name (if present)
        const pathParts = searchPath.split('/');
        if (pathParts.length > 1) {
            const pkg = pathParts[0];
            const relPath = pathParts.slice(1).join('/');
            const fileNameOnly = relPath.split('/').pop();

            // Package-related paths
            possiblePaths.push(`${pkg}/${relPath}`);
            possiblePaths.push(`/${pkg}/${relPath}`);
            possiblePaths.push(`${pkg}/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/${fileNameOnly}`);
            possiblePaths.push(`${pkg}/meshes/${fileNameOnly}`);
            possiblePaths.push(`/${pkg}/meshes/${fileNameOnly}`);

            // Find paths in fileMap containing package name
            const pkgLower = pkg.toLowerCase();
            for (const [key] of fileMap.entries()) {
                const keyLower = key.toLowerCase();
                if (keyLower.includes(pkgLower)) {
                    const pkgIndex = keyLower.indexOf(pkgLower);
                    const relativePath = key.substring(pkgIndex + pkg.length);
                    if (relativePath.endsWith(relPath) ||
                        relativePath.endsWith(`/${relPath}`) ||
                        relativePath.endsWith(fileNameOnly) ||
                        relativePath.endsWith(`/${fileNameOnly}`) ||
                        relativePath.includes(fileNameOnly)) {
                        possiblePaths.push(key);
                    }
                }
            }
        }

        // Direct path
        possiblePaths.push(searchPath);
        possiblePaths.push(`/${searchPath}`);
        possiblePaths.push(`./${searchPath}`); // Add ./ prefix version

        // Relative path
        const dir = fileName.substring(0, fileName.lastIndexOf('/') + 1);
        possiblePaths.push(dir + searchPath);

        // Filename only
        const fileNameOnly = searchPath.split('/').pop();
        possiblePaths.push(fileNameOnly);

        // Try each one
        for (const tryPath of possiblePaths) {
            const file = fileMap.get(tryPath);
            if (file) {
                return file;
            }
        }

        // Try cleaned key matching
        const cleanedSearch = this.cleanFilePath(searchPath).replace(/^\.\//, '');
        for (const [key, file] of fileMap.entries()) {
            const cleanedKey = this.cleanFilePath(key).replace(/^\.\//, '');
            if (cleanedKey === cleanedSearch) {
                return file;
            }
        }

        // Fuzzy matching
        const cleaned = this.cleanFilePath(searchPath);
        const fileNames = Array.from(fileMap.keys()).map(n => this.cleanFilePath(n));

        for (const fileKey of fileNames) {
            const len = Math.min(fileKey.length, cleaned.length);
            if (cleaned.substr(cleaned.length - len) === fileKey.substr(fileKey.length - len)) {
                const file = fileMap.get(fileKey);
                if (file) {
                    return file;
                }
            }
        }

        return null;
    }

    /**
     * Load mesh file directly using Three.js loaders
     * @param {File} file - File object
     * @param {string} path - Original path (used to determine file type)
     * @returns {Promise<THREE.Group|THREE.Mesh|null>}
     */
    static async loadMeshFileDirect(file, path) {
        const fileExt = file.name ? file.name.toLowerCase().split('.').pop() : path.toLowerCase().split('.').pop();
        const blobUrl = URL.createObjectURL(file);

        try {
            let meshObject = null;

            switch (fileExt) {
                case 'stl':
                    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
                    const stlLoader = new STLLoader();
                    const stlGeometry = await new Promise((resolve, reject) => {
                        stlLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    const stlMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });
                    meshObject = new THREE.Mesh(stlGeometry, stlMaterial);
                    break;

                case 'dae':
                    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
                    const colladaLoader = new ColladaLoader();
                    const colladaModel = await new Promise((resolve, reject) => {
                        colladaLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    // ColladaLoader returns scene
                    meshObject = colladaModel.scene || colladaModel;

                    // Remove lights
                    if (meshObject && meshObject.traverse) {
                        const lightsToRemove = [];
                        meshObject.traverse(child => {
                            if (child.isLight) {
                                lightsToRemove.push(child);
                            }
                        });
                        lightsToRemove.forEach(light => {
                            if (light.parent) {
                                light.parent.remove(light);
                            }
                        });
                    }

                    // Note: Do not apply rotation here!
                    // SceneManager's world object has already applied coordinate system conversion (-90 degrees X-axis)
                    // Applying rotation again will cause double rotation error
                    break;

                case 'obj':
                    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
                    const objLoader = new OBJLoader();
                    meshObject = await new Promise((resolve, reject) => {
                        objLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    break;

                case 'gltf':
                case 'glb':
                    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
                    const gltfLoader = new GLTFLoader();
                    const gltfModel = await new Promise((resolve, reject) => {
                        gltfLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    meshObject = gltfModel.scene || gltfModel;
                    break;

                default:
                    console.warn(`Unsupported file format: ${fileExt}`);
                    URL.revokeObjectURL(blobUrl);
                    return null;
            }

            URL.revokeObjectURL(blobUrl);
            return meshObject;
        } catch (error) {
            URL.revokeObjectURL(blobUrl);
            console.error(`Failed to load mesh file: ${path}`, error);
            return null;
        }
    }

    /**
     * Asynchronously load mesh file (for URDFLoader's loadMeshCb)
     * @param {File} file - File object
     * @param {string} ext - File extension
     * @param {THREE.LoadingManager} manager - Three.js loading manager
     * @returns {Promise<THREE.Group|THREE.Mesh|null>}
     */
    static async loadMeshFileAsync(file, ext, manager) {
        const blobUrl = URL.createObjectURL(file);

        try {
            let meshObject = null;

            switch (ext) {
                case 'stl': {
                    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
                    const stlLoader = new STLLoader(manager);
                    const stlGeometry = await new Promise((resolve, reject) => {
                        stlLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    // Use MeshPhongMaterial to match URDFLoader behavior
                    const stlMaterial = new THREE.MeshPhongMaterial();
                    meshObject = new THREE.Mesh(stlGeometry, stlMaterial);
                    break;
                }

                case 'dae': {
                    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
                    const colladaLoader = new ColladaLoader(manager);
                    const colladaModel = await new Promise((resolve, reject) => {
                        colladaLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    // ColladaLoader returns an object, scene property is the scene
                    meshObject = colladaModel.scene;

                    // Remove lights (consistent with URDFLoader behavior)
                    if (meshObject && meshObject.traverse) {
                        const lightsToRemove = [];
                        meshObject.traverse(child => {
                            if (child.isLight) {
                                lightsToRemove.push(child);
                            }
                        });
                        lightsToRemove.forEach(light => {
                            if (light.parent) {
                                light.parent.remove(light);
                            }
                        });
                    }

                    // Note: Do not apply rotation here!
                    // SceneManager's world object has already applied coordinate system conversion
                    break;
                }

                case 'obj': {
                    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
                    const objLoader = new OBJLoader(manager);
                    meshObject = await new Promise((resolve, reject) => {
                        objLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    break;
                }

                case 'gltf':
                case 'glb': {
                    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
                    const gltfLoader = new GLTFLoader(manager);
                    const gltfModel = await new Promise((resolve, reject) => {
                        gltfLoader.load(blobUrl, resolve, undefined, reject);
                    });
                    meshObject = gltfModel.scene;
                    break;
                }

                default:
                    console.warn(`Unsupported file format: ${ext}`);
                    URL.revokeObjectURL(blobUrl);
                    return null;
            }

            URL.revokeObjectURL(blobUrl);
            return meshObject;
        } catch (error) {
            URL.revokeObjectURL(blobUrl);
            console.error(`Failed to load mesh file: ${file.name}`, error);
            throw error;
        }
    }

    /**
     * Load MJCF
     */
    static async loadMJCF(content, fileMap = null, basePath = null) {
        try {
            const model = await MJCFAdapter.parse(content, fileMap, basePath);
            return model;
        } catch (error) {
            console.error('MJCF parsing error:', error);
            console.error('Error stack:', error.stack);
            throw new Error('MJCF parsing failed: ' + error.message + (error.stack ? '\n' + error.stack : ''));
        }
    }

    /**
     * Load USD
     * @param {string|ArrayBuffer} content - USD content
     * @param {Map} fileMap - File map
     * @param {File} file - Original file object
     * @param {Object} options - Additional options (e.g., usdViewerManager)
     */
    static async loadUSD(content, fileMap = null, file = null, options = {}) {
        try {
            const model = await USDAdapter.parse(content, fileMap, file, options);
            return model;
        } catch (error) {
            throw new Error('USD parsing failed: ' + error.message);
        }
    }

    /**
     * Set joint angle (universal method)
     */
    static setJointAngle(model, jointName, angle, ignoreLimits = false) {
        const joint = model.getJoint(jointName);
        if (!joint) {
            console.warn(`Joint ${jointName} does not exist`);
            return;
        }

        // Get ignoreLimits flag from model's userData (if parameter not specified)
        if (!ignoreLimits && model.userData && model.userData.ignoreLimits) {
            ignoreLimits = true;
        }

        // Call corresponding adapter based on model type
        // URDF format: joint.threeObject is URDFJoint object, has setJointValue or setAngle method
        if (joint.threeObject && (typeof joint.threeObject.setJointValue === 'function' || typeof joint.threeObject.setAngle === 'function')) {
            URDFAdapter.setJointAngle(joint, angle, ignoreLimits);
        } else {
            // MJCF or USD format
            MJCFAdapter.setJointAngle(joint, angle);
        }

        // Ensure model matrix is updated
        if (model.threeObject) {
            model.threeObject.updateMatrixWorld(true);
        }
    }
}
