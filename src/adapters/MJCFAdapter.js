/**
 * MJCF Adapter
 * Parses MJCF XML and converts to unified model
 */
import { UnifiedRobotModel, Link, Joint, JointLimits, VisualGeometry, CollisionGeometry, InertialProperties, GeometryType, Constraint } from '../models/UnifiedRobotModel.js';
import * as THREE from 'three';
import { loadMeshFile, ensureMeshHasPhongMaterial, getLoaders } from '../utils/MeshLoader.js';
import { cleanFilePath, resolveFileFromMap } from '../utils/FileUtils.js';

export class MJCFAdapter {
    /**
     * Process include tags in MJCF XML
     * Replaces <include file="path"/> with the content of the referenced file
     * @param {string} xmlContent - MJCF XML content
     * @param {Map} fileMap - File map for loading included files
     * @param {string} basePath - Base path for resolving relative paths
     * @returns {Promise<string>} Processed XML content
     */
    static async processIncludes(xmlContent, fileMap = null, basePath = null, includeStack = new Set()) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlContent, 'text/xml');

        // Check for parse errors
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            // If there's a parse error, return original content
            console.warn('Initial XML parse error, skipping include processing:', parseError.textContent);
            return xmlContent;
        }

        // Find all include elements.  MJCF includes are textual includes, so an
        // included file may itself contain more includes (and it may be a
        // fragment such as sensors.xml rather than a complete <mujoco> file).
        const includes = Array.from(doc.querySelectorAll('include'));

        if (includes.length === 0) {
            return xmlContent;
        }

        console.log(`Processing ${includes.length} include tag(s)...`);

        // Process each include tag
        for (const includeEl of includes) {
            const filePath = includeEl.getAttribute('file')?.trim();

            if (!filePath) {
                console.warn('Include tag missing file attribute');
                includeEl.remove();
                continue;
            }

            if (!fileMap) {
                console.warn(`Could not find included file (no file map): ${filePath}`);
                includeEl.remove();
                continue;
            }

            // Resolve relative to the including file's directory.  This also
            // handles dragged folders whose File keys contain a leading slash,
            // Windows separators, and case differences.
            const includedFile = resolveFileFromMap(filePath, fileMap, { baseDir: basePath || '' });
            if (!includedFile) {
                console.warn(`Could not find included file: ${filePath}`);
                includeEl.remove();
                continue;
            }

            // Find the map key for the included file so nested includes resolve
            // relative to the actual file location, not just the parent model.
            let includedKey = null;
            for (const [key, value] of fileMap.entries()) {
                if (value === includedFile) {
                    includedKey = key;
                    break;
                }
            }
            const includedPath = cleanFilePath(
                includedKey || ((basePath ? `${basePath}/` : '') + filePath)
            );
            const includedDir = includedPath.includes('/')
                ? includedPath.slice(0, includedPath.lastIndexOf('/'))
                : '';

            // Prevent an accidentally cyclic include from recursing forever.
            const cycleKey = cleanFilePath(includedPath).toLowerCase();
            if (includeStack.has(cycleKey)) {
                console.warn(`Skipping cyclic MJCF include: ${filePath}`);
                includeEl.remove();
                continue;
            }

            let includedContent;
            try {
                includedContent = await includedFile.text();
            } catch (e) {
                console.warn(`Failed to read included file ${filePath}:`, e);
                includeEl.remove();
                continue;
            }

            // Process nested includes before importing this file's nodes.
            const nestedStack = new Set(includeStack);
            nestedStack.add(cycleKey);
            includedContent = await this.processIncludes(
                includedContent,
                fileMap,
                includedDir,
                nestedStack
            );

            // Parse the included content.  MuJoCo accepts both complete
            // <mujoco> files and XML fragments for include files.
            const includedDoc = parser.parseFromString(includedContent, 'text/xml');
            const includedParseError = includedDoc.querySelector('parsererror');

            if (includedParseError) {
                console.warn(`Failed to parse included file ${filePath}:`, includedParseError.textContent);
                includeEl.remove();
                continue;
            }

            // A complete MJCF contributes its children; a fragment contributes
            // its document element itself (e.g. <sensor> or <default>).
            const includedRoot = includedDoc.documentElement;
            const childNodes = includedRoot?.tagName?.toLowerCase() === 'mujoco'
                ? Array.from(includedRoot.childNodes)
                : includedRoot ? [includedRoot] : [];

            if (childNodes.length === 0) {
                console.warn(`Included file ${filePath} has no XML elements`);
                includeEl.remove();
                continue;
            }

            for (const child of childNodes) {
                // Skip text nodes and comment nodes
                if (child.nodeType !== 1) {
                    continue;
                }

                // Clone the node to avoid removing from included doc
                const importedNode = doc.importNode(child, true);

                // Insert before the include element
                includeEl.parentNode.insertBefore(importedNode, includeEl);
            }

            console.log(`Successfully included content from: ${filePath}`);

            // Remove the include element
            includeEl.remove();
        }

        // Serialize the modified document back to string
        const serializer = new XMLSerializer();
        return serializer.serializeToString(doc);
    }

    /**
     * Merge repeated top-level MJCF sections created by textual includes.
     * A scene commonly includes a robot that has its own <asset>/<worldbody>,
     * then adds another <asset>/<worldbody> for the floor and lighting.  DOM
     * querySelector() only returns the first section, which silently drops the
     * latter content.  MuJoCo treats include as text, so combining sections is
     * the faithful representation for the viewer.
     */
    static mergeTopLevelSections(doc) {
        const root = doc?.documentElement;
        if (!root) return;

        const mergeable = ['asset', 'worldbody', 'sensor', 'actuator', 'equality', 'contact', 'tendon', 'keyframe'];
        for (const tagName of mergeable) {
            const sections = Array.from(root.children).filter(
                child => child.tagName?.toLowerCase() === tagName
            );
            if (sections.length < 2) continue;

            const primary = sections[0];
            for (const section of sections.slice(1)) {
                while (section.firstChild) {
                    primary.appendChild(section.firstChild);
                }
                section.remove();
            }
        }
    }

    /**
     * Parse MJCF XML content and convert to unified model
     * @param {string} xmlContent - MJCF XML content
     * @param {Map} fileMap - File map (optional), for loading mesh files
     * @param {string} basePath - Base path for resolving relative include paths (optional)
     * @returns {Promise<UnifiedRobotModel>}
     */
    static async parse(xmlContent, fileMap = null, basePath = null) {
        // Process include tags first
        const processedContent = await this.processIncludes(xmlContent, fileMap, basePath);

        const parser = new DOMParser();
        const doc = parser.parseFromString(processedContent, 'text/xml');

        // Check parse errors
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            throw new Error('MJCF XML parsing failed: ' + parseError.textContent);
        }

        // Includes are textual in MJCF.  Normalize duplicate top-level
        // sections before parsing so included robot content and scene content
        // are both retained.
        this.mergeTopLevelSections(doc);

        const model = new UnifiedRobotModel();
        model.name = 'mujoco_model';

        // Parse default values and class definitions in default tags first
        // (needed for mesh scale inheritance)
        const { classDefaults, rootDefaults } = this.parseDefaults(doc);

        // Parse mesh definitions in asset tags (build mesh name to file path mapping)
        // Pass classDefaults and rootDefaults to inherit mesh scale
        const meshMap = this.parseAssets(doc, classDefaults, rootDefaults, basePath);

        // Parse material definitions in material tags
        const materialMap = this.parseMaterials(doc);

        // Get worldbody (root node)
        const worldbody = doc.querySelector('worldbody');
        if (!worldbody) {
            throw new Error('MJCF file missing worldbody element');
        }

        // Parse geoms directly in worldbody (not inside any body element)
        // These geoms belong to a special "worldbody" link
        const worldbodyGeoms = worldbody.querySelectorAll(':scope > geom');
        if (worldbodyGeoms.length > 0) {
            const worldbodyLink = new Link('worldbody');
            worldbodyLink.userData.isWorldbody = true;
            const seenVisualInstances = new Set();

            worldbodyGeoms.forEach((geomEl, geomIndex) => {
                // Get inherited properties from default class
                const inheritedProps = this.getGeomInheritedProperties(geomEl, classDefaults, rootDefaults);

                const group = geomEl.getAttribute('group');
                // Use inherited group if not explicitly defined
                const groupNum = group !== null ? parseInt(group) : 
                    (inheritedProps.group !== null ? inheritedProps.group : 0);
                const geomName = (geomEl.getAttribute('name') || '').toLowerCase();
                const hasRgba = geomEl.hasAttribute('rgba') || inheritedProps.rgba !== null;
                const meshRef = geomEl.getAttribute('mesh');
                const meshInstanceKey = meshRef ? this.getGeomInstanceKey(geomEl, meshRef) : null;
                
                // Use inherited contype/conaffinity if not explicitly defined
                const contype = geomEl.getAttribute('contype');
                const conaffinity = geomEl.getAttribute('conaffinity');
                const density = geomEl.getAttribute('density');
                const contypeNum = contype !== null ? parseInt(contype) : 
                    (inheritedProps.contype !== null ? inheritedProps.contype : null);
                const conaffinityNum = conaffinity !== null ? parseInt(conaffinity) : 
                    (inheritedProps.conaffinity !== null ? inheritedProps.conaffinity : null);
                const densityNum = density !== null ? parseFloat(density) : 
                    (inheritedProps.density !== null ? inheritedProps.density : null);

                // Determine if collision or visual (same logic as in parseBodies)
                let isCollisionGeom = false;
                if (!meshRef) {
                    // Primitive geoms can be visual too (e.g. the orange ball
                    // uses a sphere with rgba).  Only treat an unannotated
                    // primitive as collision; honor the same visual markers
                    // used for mesh geoms.
                    if (contypeNum === 0 && conaffinityNum === 0) {
                        isCollisionGeom = false;
                    } else if (groupNum === 3 || geomName.includes('collision')) {
                        isCollisionGeom = true;
                    } else if (groupNum === 1 || groupNum === 2 ||
                               (densityNum === 0 && groupNum === 1) || hasRgba) {
                        isCollisionGeom = false;
                    } else {
                        isCollisionGeom = true;
                    }
                } else {
                    if (contypeNum === 0 && conaffinityNum === 0) {
                        isCollisionGeom = false;
                    } else if (groupNum === 3) {
                        // group=3 is collision in MuJoCo convention
                        isCollisionGeom = true;
                    } else if (groupNum === 2 || groupNum === 1) {
                        // group=1,2 are visual
                        isCollisionGeom = false;
                    } else if (geomName.includes('collision')) {
                        isCollisionGeom = true;
                    } else if (seenVisualInstances.has(meshInstanceKey)) {
                        if (hasRgba || (contypeNum === 0 && conaffinityNum === 0)) {
                            return; // Skip duplicate visual
                        } else {
                            isCollisionGeom = true;
                        }
                    } else if (densityNum === 0 && groupNum === 1) {
                        isCollisionGeom = false;
                    } else if (hasRgba) {
                        isCollisionGeom = false;
                    } else {
                        isCollisionGeom = false;
                    }
                }

                const geom = this.parseGeom(geomEl, meshMap, inheritedProps);
                if (geom) {
                    if (isCollisionGeom) {
                        const collision = new CollisionGeometry();
                        collision.geometry = geom;
                        collision.name = geomEl.getAttribute('name') || `worldbody_collision_${geomIndex}`;
                        collision.origin = this.parseOrigin(geomEl);
                        worldbodyLink.collisions.push(collision);
                    } else {
                        if (meshRef) {
                            seenVisualInstances.add(meshInstanceKey);
                        }
                        const visual = new VisualGeometry();
                        visual.geometry = geom;
                        visual.name = geomEl.getAttribute('name') || `worldbody_geom_${geomIndex}`;
                        visual.origin = this.parseOrigin(geomEl);

                        // Parse rgba (priority: explicit > inherited)
                        let rgba = null;
                        if (geomEl.hasAttribute('rgba')) {
                            const rgbaStr = geomEl.getAttribute('rgba');
                            const rgbaVals = rgbaStr.split(' ').map(parseFloat);
                            if (rgbaVals.length >= 3) {
                                rgba = {
                                    r: rgbaVals[0],
                                    g: rgbaVals[1],
                                    b: rgbaVals[2],
                                    a: rgbaVals.length >= 4 ? rgbaVals[3] : 1.0
                                };
                            }
                        } else if (inheritedProps.rgba) {
                            rgba = inheritedProps.rgba;
                        }

                        visual.userData = {
                            group: groupNum,
                            hasRgba: hasRgba || !!rgba,
                            rgba: rgba,
                            meshRef: meshRef,
                            geomType: geomEl.getAttribute('type') || (meshRef ? 'mesh' : 'box')
                        };
                        worldbodyLink.visuals.push(visual);
                    }
                }
            });

            // Only add worldbody link if it has geometries
            if (worldbodyLink.visuals.length > 0 || worldbodyLink.collisions.length > 0) {
                model.addLink(worldbodyLink);
            }
        }

        // Parse all bodies (links), pass meshMap, materialMap, classDefaults and rootDefaults
        const bodyMap = new Map();
        // When worldbody itself owns renderable geoms (typically a scene
        // floor), keep top-level bodies structurally below that link. This
        // prevents them from being built once through their free joint and a
        // second time as independent roots.
        const topLevelParent = model.links.has('worldbody') ? 'worldbody' : null;
        this.parseBodies(worldbody, topLevelParent, bodyMap, model, null, meshMap, null, materialMap, classDefaults, rootDefaults);

        // Parse all joints
        this.parseJoints(worldbody, bodyMap, model, null, classDefaults);

        // Parse equality constraints (closed-chain constraints for parallel mechanisms)
        this.parseEquality(doc, model);

        // Find root body
        // Priority: worldbody link > bodies without parent joints > first link
        const worldbodyLink = model.links.get('worldbody');
        if (worldbodyLink) {
            model.rootLink = 'worldbody';
        } else {
            const rootBodies = Array.from(model.links.keys()).filter(
                name => !Array.from(model.joints.values()).some(j => j.child === name)
            );
            if (rootBodies.length > 0) {
                model.rootLink = rootBodies[0];
            } else if (model.links.size > 0) {
                model.rootLink = Array.from(model.links.keys())[0];
            }
        }

        // Create Three.js objects (asynchronously load mesh files)
        await this.createThreeObject(model, fileMap, meshMap);

        return model;
    }

    /**
     * Parse mesh definitions in asset tags
     * @param {Document} doc - XML document
     * @param {Map} classDefaults - Class default properties map (optional)
     * @param {object} rootDefaults - Root default properties (optional)
     * @param {string} basePath - Directory containing the MJCF document (optional)
     * @returns {Map<string, object>} Mapping from mesh names to mesh data
     * Mesh data can be: { type: 'file', path: string, scale: [x,y,z] } or { type: 'vertex', vertices: Float32Array, scale: [x,y,z] }
     */
    static parseAssets(doc, classDefaults = null, rootDefaults = null, basePath = null) {
        const meshMap = new Map();
        const asset = doc.querySelector('asset');
        if (!asset) {
            return meshMap;
        }

        // MJCF mesh files are resolved relative to compiler.meshdir, which is
        // itself relative to the XML document. Keeping that directory in the
        // asset path is essential when a dragged package contains duplicate
        // basenames (go2w has both meshes/calf.stl and mjcf/assets/calf.stl).
        const meshDir = doc.querySelector('compiler')?.getAttribute('meshdir')?.trim() || '';

        const meshes = asset.querySelectorAll('mesh');
        meshes.forEach((meshEl, index) => {
            let name = meshEl.getAttribute('name');
            const file = meshEl.getAttribute('file');
            const vertex = meshEl.getAttribute('vertex');
            const scale = meshEl.getAttribute('scale');
            const meshClass = meshEl.getAttribute('class');

            // Parse scale (priority: direct attribute > class inheritance > root defaults > [1,1,1])
            let scaleVec = [1, 1, 1];
            
            // First check direct scale attribute
            if (scale) {
                const scaleValues = scale.trim().split(/\s+/).map(parseFloat);
                if (scaleValues.length === 1) {
                    scaleVec = [scaleValues[0], scaleValues[0], scaleValues[0]];
                } else if (scaleValues.length === 3) {
                    scaleVec = scaleValues;
                }
            } else if (meshClass && classDefaults && classDefaults.has(meshClass)) {
                // Try to inherit scale from class defaults
                const classDefault = classDefaults.get(meshClass);
                if (classDefault.mesh && classDefault.mesh.scale) {
                    scaleVec = classDefault.mesh.scale;
                }
            } else if (rootDefaults && rootDefaults.mesh && rootDefaults.mesh.scale) {
                // Fall back to root defaults (e.g., robotis_op3)
                scaleVec = rootDefaults.mesh.scale;
            }

            // If has vertex attribute, it's an inline-defined mesh
            if (vertex) {
                if (!name) {
                    name = `inline_mesh_${index}`;
                }

                // Parse vertex data
                const vertexValues = vertex.trim().split(/\s+/).map(parseFloat);
                const vertices = new Float32Array(vertexValues);

                meshMap.set(name, {
                    type: 'vertex',
                    vertices: vertices,
                    scale: scaleVec
                });
            }
            // If has file attribute, it's an external file
            else if (file) {
                // If no name, extract filename from file (remove path and extension)
                if (!name) {
                    // Extract filename from path: "path/to/wheel.stl" -> "wheel"
                    const fileName = file.split('/').pop().split('\\').pop(); // Support / and \ path separators
                    name = fileName.split('.')[0]; // Remove extension
                }

                meshMap.set(name, {
                    type: 'file',
                    path: this.resolveAssetFilePath(file, basePath, meshDir),
                    scale: scaleVec
                });
            } else {
                console.warn('MJCF mesh element missing file or vertex attribute, skipping');
                return;
            }
        });

        return meshMap;
    }

    /**
     * Resolve an MJCF asset path using compiler directory semantics.
     */
    static resolveAssetFilePath(filePath, basePath = null, assetDir = '') {
        const isAnchored = path => /^(?:[a-zA-Z]:[\\/]|\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(path);

        if (isAnchored(filePath)) {
            return cleanFilePath(filePath);
        }

        let parentPath = basePath || '';
        if (assetDir) {
            parentPath = isAnchored(assetDir)
                ? assetDir
                : `${parentPath ? `${parentPath}/` : ''}${assetDir}`;
        }

        return cleanFilePath(`${parentPath ? `${parentPath}/` : ''}${filePath}`);
    }

    /**
     * Parse material definitions in asset tags
     * @param {Document} doc - XML document
     * @returns {Map<string, object>} Mapping from material names to material properties
     */
    static parseMaterials(doc) {
        const materialMap = new Map();
        const asset = doc.querySelector('asset');
        if (!asset) {
            return materialMap;
        }

        const materials = asset.querySelectorAll('material');
        materials.forEach((matEl) => {
            const name = matEl.getAttribute('name');
            if (!name) return;

            const material = {};

            // Parse rgba
            const rgba = matEl.getAttribute('rgba');
            if (rgba) {
                const vals = rgba.split(' ').map(parseFloat);
                if (vals.length >= 3) {
                    material.rgba = {
                        r: vals[0],
                        g: vals[1],
                        b: vals[2],
                        a: vals.length >= 4 ? vals[3] : 1.0
                    };
                }
            }

            // Parse other material properties
            const specular = matEl.getAttribute('specular');
            if (specular) {
                const vals = specular.split(' ').map(parseFloat);
                material.specular = vals[0] || 0.5;
            }

            const shininess = matEl.getAttribute('shininess');
            if (shininess) {
                material.shininess = parseFloat(shininess);
            }

            materialMap.set(name, material);
        });

        return materialMap;
    }

    /**
     * Parse default values and class definitions in default tags
     * @param {Document} doc - XML document
     * @returns {object} Object containing classDefaults Map and rootDefaults object
     */
    static parseDefaults(doc) {
        const classDefaults = new Map();
        let rootDefaults = {};

        // Recursively parse default tags
        const parseDefaultElement = (defaultEl, parentDefaults = {}) => {
            const className = defaultEl.getAttribute('class');

            // Start from parent defaults, deep copy to avoid reference issues
            const defaults = JSON.parse(JSON.stringify(parentDefaults || {}));

            // Parse mesh default values
            const meshEl = defaultEl.querySelector(':scope > mesh');
            if (meshEl) {
                if (!defaults.mesh) {
                    defaults.mesh = {};
                }

                // Parse scale
                const scale = meshEl.getAttribute('scale');
                if (scale) {
                    const scaleVals = scale.trim().split(/\s+/).map(parseFloat);
                    if (scaleVals.length === 1) {
                        defaults.mesh.scale = [scaleVals[0], scaleVals[0], scaleVals[0]];
                    } else if (scaleVals.length === 3) {
                        defaults.mesh.scale = scaleVals;
                    }
                }
            }

            // Parse joint default values
            const jointEl = defaultEl.querySelector(':scope > joint');
            if (jointEl) {
                // If parent has joint defaults, inherit first
                if (!defaults.joint) {
                    defaults.joint = {};
                }

                // Parse axis (if axis defined, completely replace parent axis)
                const axis = jointEl.getAttribute('axis');
                if (axis) {
                    const axisVals = axis.split(' ').map(parseFloat);
                    defaults.joint.axis = [axisVals[0] || 0, axisVals[1] || 0, axisVals[2] || 0];
                }

                // Parse range
                const range = jointEl.getAttribute('range');
                if (range) {
                    const rangeVals = range.split(' ').map(parseFloat);
                    defaults.joint.range = rangeVals;
                }

                // Parse damping
                const damping = jointEl.getAttribute('damping');
                if (damping) {
                    defaults.joint.damping = parseFloat(damping);
                }
            }

            // Parse geom default values
            const geomEl = defaultEl.querySelector(':scope > geom');
            if (geomEl) {
                if (!defaults.geom) {
                    defaults.geom = {};
                }

                // Parse contype
                const contype = geomEl.getAttribute('contype');
                if (contype !== null) {
                    defaults.geom.contype = parseInt(contype);
                }

                // Parse conaffinity
                const conaffinity = geomEl.getAttribute('conaffinity');
                if (conaffinity !== null) {
                    defaults.geom.conaffinity = parseInt(conaffinity);
                }

                // Parse group
                const group = geomEl.getAttribute('group');
                if (group !== null) {
                    defaults.geom.group = parseInt(group);
                }

                // Parse rgba
                const rgba = geomEl.getAttribute('rgba');
                if (rgba) {
                    const rgbaVals = rgba.split(' ').map(parseFloat);
                    if (rgbaVals.length >= 3) {
                        defaults.geom.rgba = {
                            r: rgbaVals[0],
                            g: rgbaVals[1],
                            b: rgbaVals[2],
                            a: rgbaVals.length >= 4 ? rgbaVals[3] : 1.0
                        };
                    }
                }

                // Parse material
                const material = geomEl.getAttribute('material');
                if (material) {
                    defaults.geom.material = material;
                }

                // Parse type
                const type = geomEl.getAttribute('type');
                if (type) {
                    defaults.geom.type = type;
                }

                // Parse density
                const density = geomEl.getAttribute('density');
                if (density !== null) {
                    defaults.geom.density = parseFloat(density);
                }
            }

            // If has class name, save to class map
            if (className) {
                classDefaults.set(className, defaults);
            } else {
                // No class name means this is a root default (inherits to all)
                // Store the final computed defaults as rootDefaults
                Object.assign(rootDefaults, defaults);
            }

            // Recursively process nested default tags
            const nestedDefaults = defaultEl.querySelectorAll(':scope > default');
            nestedDefaults.forEach(nested => {
                parseDefaultElement(nested, defaults);
            });
        };

        // Start parsing from root default tags
        const rootDefaultElements = doc.querySelectorAll('mujoco > default');
        rootDefaultElements.forEach(defaultEl => {
            parseDefaultElement(defaultEl);
        });

        return { classDefaults, rootDefaults };
    }

    /**
     * Get inherited geom properties from default class
     * @param {Element} geomEl - geom element
     * @param {Map} classDefaults - Class default properties map
     * @param {object} rootDefaults - Root default properties
     * @returns {object} Inherited properties object
     */
    static getGeomInheritedProperties(geomEl, classDefaults, rootDefaults, fallbackClass = null) {
        const inherited = {
            contype: null,
            conaffinity: null,
            group: null,
            rgba: null,
            material: null,
            type: null,
            density: null
        };

        // First apply root defaults
        if (rootDefaults && rootDefaults.geom) {
            Object.assign(inherited, rootDefaults.geom);
        }

        // Then apply class defaults (if geom has class attribute)
        // A body's childclass applies to all descendants unless a geom
        // explicitly overrides it.  The previous implementation only looked
        // at geom@class, so perfectly valid MJCF that relies on childclass was
        // parsed with the wrong geometry type/collision flags.
        const className = geomEl.getAttribute('class') || fallbackClass;
        if (className && classDefaults && classDefaults.has(className)) {
            const classDefault = classDefaults.get(className);
            if (classDefault.geom) {
                Object.assign(inherited, classDefault.geom);
            }
        }

        return inherited;
    }

    /**
     * Identify one placed mesh instance, not merely one mesh asset. MJCF often
     * reuses the same STL several times in a body at different transforms
     * (Microduck does this throughout its neck, legs and bearing supports).
     * Only a second geom with the same mesh and the same pose is a duplicate.
     */
    static getGeomInstanceKey(geomEl, meshRef) {
        const origin = this.parseOrigin(geomEl);
        const values = [...origin.xyz, ...origin.rpy].map(value => {
            const normalized = Math.abs(value) < 1e-12 ? 0 : value;
            return Number(normalized.toPrecision(12));
        });
        const fromto = (geomEl.getAttribute('fromto') || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(value => Number(value))
            .join(',');
        return `${meshRef}|${values.join(',')}|${fromto}`;
    }

    /**
     * Recursively parse body elements, record parent-child relationships
     */
    static parseBodies(element, parentName, bodyMap, model, parentLinkRef = null, meshMap = null, stats = null, materialMap = null, classDefaults = null, rootDefaults = null, inheritedChildClass = null) {
        // Initialize stats object (only on root call)
        if (!stats) {
            stats = { totalGeoms: 0, skippedCollisionGeoms: 0, visualGeoms: 0 };
        }

        const bodies = element.querySelectorAll(':scope > body');

        bodies.forEach(bodyEl => {
            const linkName = bodyEl.getAttribute('name') || `body_${bodyMap.size}`;
            const link = new Link(linkName);

            // childclass is inherited by nested bodies.  A child body's own
            // childclass replaces the inherited value for its descendants.
            const childClass = bodyEl.getAttribute('childclass') || inheritedChildClass;

            // Record parent link relationship (for building hierarchy later)
            if (parentName) {
                link.userData.parentName = parentName;
            }

            // Parse body's pos and quat (body's own position)
            const bodyOrigin = this.parseOrigin(bodyEl);
            link.userData.bodyOrigin = bodyOrigin;

            // Parse geometries (geom)
            const geoms = bodyEl.querySelectorAll(':scope > geom');
            const seenVisualInstances = new Set(); // Track exact placed visuals, not reusable mesh assets

            geoms.forEach((geomEl, geomIndex) => {
                stats.totalGeoms++;

                // Get inherited properties from default class
                const inheritedProps = this.getGeomInheritedProperties(geomEl, classDefaults, rootDefaults, childClass);

                const group = geomEl.getAttribute('group');
                // Use inherited group if not explicitly defined
                const groupNum = group !== null ? parseInt(group) : 
                    (inheritedProps.group !== null ? inheritedProps.group : 0);
                const geomName = (geomEl.getAttribute('name') || '').toLowerCase();
                const hasRgba = geomEl.hasAttribute('rgba') || inheritedProps.rgba !== null;
                const meshRef = geomEl.getAttribute('mesh');
                const meshInstanceKey = meshRef ? this.getGeomInstanceKey(geomEl, meshRef) : null;
                // Use inherited type if not explicitly defined
                const geomType = geomEl.getAttribute('type') || inheritedProps.type || (meshRef ? 'mesh' : 'box');

                // Check collision-related attributes (use inherited if not explicitly defined)
                const contype = geomEl.getAttribute('contype');
                const conaffinity = geomEl.getAttribute('conaffinity');
                const density = geomEl.getAttribute('density');
                const contypeNum = contype !== null ? parseInt(contype) : 
                    (inheritedProps.contype !== null ? inheritedProps.contype : null);
                const conaffinityNum = conaffinity !== null ? parseInt(conaffinity) : 
                    (inheritedProps.conaffinity !== null ? inheritedProps.conaffinity : null);
                const densityNum = density !== null ? parseFloat(density) : 
                    (inheritedProps.density !== null ? inheritedProps.density : null);

                // Determine geom type: visual or collision
                let isCollisionGeom = false;
                let skipReason = '';

                // [Key Strategy]: Distinguish visual and collision geoms
                // Basic geometries (box, cylinder, sphere) are usually simplified shapes for collision
                if (!meshRef) {
                    // Primitive geoms can be visual too (e.g. spheres with an
                    // rgba color).  Honor the same visual markers as meshes;
                    // an otherwise unannotated primitive remains collision.
                    if (contypeNum === 0 && conaffinityNum === 0) {
                        isCollisionGeom = false;
                    } else if (groupNum === 3 || geomName.includes('collision')) {
                        isCollisionGeom = true;
                    } else if (groupNum === 1 || groupNum === 2 ||
                               (densityNum === 0 && groupNum === 1) || hasRgba) {
                        isCollisionGeom = false;
                    } else {
                        isCollisionGeom = true;
                    }
                } else {
                    // Has mesh reference, check if should be collision

                    // Strategy 1: Explicitly disabled collision (contype="0" conaffinity="0") = visual only
                    if (contypeNum === 0 && conaffinityNum === 0) {
                        // This is explicitly marked as visual-only (no collision)
                        isCollisionGeom = false;
                    }
                    // Strategy 2: group=2 is visual, group=3 is collision
                    // MuJoCo convention: group 0=default, 1=visual1, 2=visual2, 3=collision
                    else if (groupNum === 3) {
                        isCollisionGeom = true;
                    } else if (groupNum === 2 || groupNum === 1) {
                        isCollisionGeom = false;
                    }
                    // Strategy 3: Name contains collision (indicates collision-specific)
                    else if (geomName.includes('collision')) {
                        isCollisionGeom = true;
                    }
                    // Strategy 4: If this exact placed mesh was already added
                    // as visual, the current geom is its duplicate collision
                    // representation. Reuse of the asset at a different pose
                    // remains a separate visible part.
                    else if (seenVisualInstances.has(meshInstanceKey)) {
                        // If current geom also has visual markers (rgba or contype="0"), skip duplicate visual
                        if (hasRgba || (contypeNum === 0 && conaffinityNum === 0)) {
                            stats.skippedCollisionGeoms++;
                            return;
                        } else {
                            // Same mesh, but current geom has no visual markers - treat as collision
                            isCollisionGeom = true;
                        }
                    }
                    // Strategy 5: If density="0" and group="1", likely visual-only (common pattern in MJCF)
                    else if (densityNum === 0 && groupNum === 1) {
                        // This pattern (density="0" group="1") is often used for visual-only geoms
                        isCollisionGeom = false;
                    }
                    // Strategy 6: Default: if has rgba, treat as visual
                    else if (hasRgba) {
                        isCollisionGeom = false;
                    }
                    // Strategy 7: Default for mesh: treat as visual (for display purposes)
                    else {
                        // No explicit markers, but it's a mesh - default to visual for display
                        // (collision might be handled by a separate geom with same mesh)
                        isCollisionGeom = false;
                    }
                }

                const geom = this.parseGeom(geomEl, meshMap, inheritedProps);
                if (geom) {
                    if (isCollisionGeom) {
                        // Add to collision list
                        const collision = new CollisionGeometry();
                        collision.geometry = geom;
                        collision.name = geomEl.getAttribute('name') || `collision_${geomIndex}`;
                        collision.origin = this.parseOrigin(geomEl);
                        link.collisions.push(collision);
                    } else {
                    // Add to visual list
                        stats.visualGeoms++;

                        // Record added mesh
                        if (meshRef) {
                            seenVisualInstances.add(meshInstanceKey);
                        }

                        const visual = new VisualGeometry();
                        visual.geometry = geom;
                        visual.name = geomEl.getAttribute('name') || `geom_${geomIndex}`;
                        visual.origin = this.parseOrigin(geomEl);

                        // Parse MJCF rgba color (priority: geom rgba > inherited rgba > material rgba)
                        let rgba = null;
                        let materialName = null;

                        // 1. First check geom's own rgba, then inherited rgba
                        if (geomEl.hasAttribute('rgba')) {
                            const rgbaStr = geomEl.getAttribute('rgba');
                            const rgbaVals = rgbaStr.split(' ').map(parseFloat);
                            if (rgbaVals.length >= 3) {
                                rgba = {
                                    r: rgbaVals[0],
                                    g: rgbaVals[1],
                                    b: rgbaVals[2],
                                    a: rgbaVals.length >= 4 ? rgbaVals[3] : 1.0
                                };
                            }
                        }

                        // 2. If geom has no explicit rgba, check inherited rgba
                        if (!rgba && inheritedProps.rgba) {
                            rgba = inheritedProps.rgba;
                        }

                        // 3. If still no rgba, check if references material (explicit or inherited)
                        if (!rgba && materialMap) {
                            materialName = geomEl.getAttribute('material') || inheritedProps.material;
                            if (materialName && materialMap.has(materialName)) {
                                const mat = materialMap.get(materialName);
                                if (mat.rgba) {
                                    rgba = mat.rgba;
                                }
                            }
                        }

                        visual.userData = {
                            group: groupNum,
                            hasRgba: hasRgba || !!rgba,
                            rgba: rgba,
                            materialName: materialName,
                            meshRef: meshRef,
                            geomType: geomType
                        };
                        link.visuals.push(visual);
                    }
                }
            });

            // Parse inertial properties
            const inertialEl = bodyEl.querySelector(':scope > inertial');
            if (inertialEl) {
                link.inertial = this.parseInertial(inertialEl);
            }

            model.addLink(link);
            bodyMap.set(linkName, { link, element: bodyEl, parentName });

            // Recursively parse child bodies
            this.parseBodies(bodyEl, linkName, bodyMap, model, link, meshMap, stats, materialMap, classDefaults, rootDefaults, childClass);
        });
    }

    /**
     * Parse geom element
     * @param {Element} geomEl - geom element
     * @param {Map} meshMap - Mapping from mesh names to file paths
     */
    static parseGeom(geomEl, meshMap = null, inheritedProps = null) {
        // In MJCF, if geom has mesh attribute, type should be mesh
        const meshAttr = geomEl.getAttribute('mesh');
        let type = geomEl.getAttribute('type') || inheritedProps?.type;

        // If has mesh attribute but no explicit type declaration, auto-set to mesh
        if (meshAttr && !type) {
            type = 'mesh';
        }

        // If no type attribute and no mesh attribute, default to sphere
        if (!type) {
            type = 'sphere';
        }

        const geometry = new GeometryType(type);

        switch (type) {
            case 'plane': {
                // MuJoCo planes with size 0 are infinite.  Three.js needs a
                // finite renderable geometry, so use a generous display mesh
                // while marking it as unbounded for camera framing. Otherwise
                // an included scene floor makes a small robot look missing.
                const size = geomEl.getAttribute('size');
                const sizes = size ? size.trim().split(/\s+/).map(parseFloat) : [];
                geometry.infinite = !(sizes[0] > 0 && sizes[1] > 0);
                geometry.size = {
                    width: sizes[0] > 0 ? sizes[0] * 2 : 100,
                    height: sizes[1] > 0 ? sizes[1] * 2 : 100
                };
                break;
            }

            case 'box':
                const size = geomEl.getAttribute('size');
                if (size) {
                    const sizes = size.split(' ').map(parseFloat);
                    // MJCF size is half-size, multiply by 2 to convert to full size
                    geometry.size = sizes.length === 1
                        ? { x: sizes[0] * 2, y: sizes[0] * 2, z: sizes[0] * 2 }
                        : { x: (sizes[0] || 0.05) * 2, y: (sizes[1] || 0.05) * 2, z: (sizes[2] || 0.05) * 2 };
                } else {
                    geometry.size = { x: 0.1, y: 0.1, z: 0.1 };
                }
                break;

            case 'sphere':
                // MJCF sphere size is radius
                const radius = parseFloat(geomEl.getAttribute('size') || '0.1');
                geometry.size = { radius };
                break;

            case 'cylinder':
            case 'capsule':
                // Handle fromto attribute for capsule/cylinder
                const fromto = geomEl.getAttribute('fromto');
                const radiusAttr = geomEl.getAttribute('size');
                
                if (fromto) {
                    const ft = fromto.split(' ').map(parseFloat);
                    if (ft.length >= 6) {
                        const p1 = new THREE.Vector3(ft[0], ft[1], ft[2]);
                        const p2 = new THREE.Vector3(ft[3], ft[4], ft[5]);
                        const center = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
                        const height = p1.distanceTo(p2);
                        
                        // Calculate rotation to align cylinder/capsule with the fromto vector
                        const direction = new THREE.Vector3().subVectors(p2, p1).normalize();
                        const defaultDir = new THREE.Vector3(0, 1, 0); // Default cylinder axis is Y
                        const quaternion = new THREE.Quaternion().setFromUnitVectors(defaultDir, direction);
                        const euler = new THREE.Euler().setFromQuaternion(quaternion);
                        
                        // Store fromto data
                        geometry.fromto = {
                            p1: [ft[0], ft[1], ft[2]],
                            p2: [ft[3], ft[4], ft[5]],
                            center: [center.x, center.y, center.z],
                            height: height,
                            rpy: [euler.x, euler.y, euler.z]
                        };
                        
                        // Parse radius - for fromto, size is just radius
                        const radiusVal = parseFloat(radiusAttr || '0.01');
                        geometry.size = { radius: radiusVal, height: height };
                    }
                } else if (radiusAttr) {
                    const radii = radiusAttr.split(' ').map(parseFloat);
                    // MJCF cylinder/capsule size is [radius, half-height], height needs to be multiplied by 2
                    geometry.size = {
                        radius: radii[0] || 0.1,
                        height: (radii[1] || 0.1) * 2  // Multiply by 2 to get full height
                    };
                } else {
                    geometry.size = { radius: 0.01, height: 0.1 };
                }
                break;

            case 'mesh':
                let meshRef = geomEl.getAttribute('mesh');
                // If meshMap exists, try to find data corresponding to mesh name
                if (meshMap && meshMap.has(meshRef)) {
                    const meshData = meshMap.get(meshRef);
                    if (meshData.type === 'file') {
                        // External file mesh
                        geometry.filename = meshData.path;
                        // Apply mesh scale from asset definition (class inheritance)
                        if (meshData.scale) {
                            geometry.meshScale = meshData.scale;
                        }
                    } else if (meshData.type === 'vertex') {
                        // Inline vertex mesh, store vertex data
                        geometry.inlineVertices = meshData.vertices;
                        geometry.inlineScale = meshData.scale;
                    }
                } else {
                    // Otherwise directly use mesh attribute value (may be file path)
                    geometry.filename = meshRef;
                    if (meshMap && meshMap.size > 0) {
                        console.warn(`⚠️ mesh "${meshRef}" not defined in assets`);
                    }
                }
                geometry.size = null;
                break;
        }

        return geometry;
    }

    /**
     * Parse origin attribute (pos + quat or xyz + rpy)
     */
    static parseOrigin(element) {
        const origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };

        // Check pos attribute
        const pos = element.getAttribute('pos');
        if (pos) {
            const xyz = pos.trim().split(/\s+/).map(parseFloat);
            origin.xyz = [xyz[0] || 0, xyz[1] || 0, xyz[2] || 0];
        }

        // Check quat attribute (quaternion, needs to be converted to rpy)
        const quat = element.getAttribute('quat');
        if (quat) {
            const q = quat.trim().split(/\s+/).map(parseFloat);
            // MJCF uses wxyz order
            const qw = q[0], qx = q[1], qy = q[2], qz = q[3];

            // Save original quaternion (for inertia visualization)
            origin.quat = { w: qw, x: qx, y: qy, z: qz };

            // Convert to Euler angles
            origin.rpy = this.quaternionToEuler(qw, qx, qy, qz);
        } else {
            // Check euler attribute
            const euler = element.getAttribute('euler');
            if (euler) {
                const rpy = euler.trim().split(/\s+/).map(parseFloat);
                origin.rpy = [rpy[0] || 0, rpy[1] || 0, rpy[2] || 0];
            }
        }

        return origin;
    }

    /**
     * Convert a parsed MJCF origin to a Three.js quaternion without routing an
     * explicit quaternion through Euler angles. The latter is ambiguous at
     * the 90/180 degree poses used extensively by Microduck.
     */
    static getOriginQuaternion(origin) {
        if (origin?.quat) {
            const { w, x, y, z } = origin.quat;
            return new THREE.Quaternion(x, y, z, w).normalize();
        }

        const rpy = origin?.rpy || [0, 0, 0];
        return new THREE.Quaternion().setFromEuler(
            new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')
        );
    }

    /** Apply a parsed MJCF pos/quat (or Euler fallback) to an Object3D. */
    static applyOriginTransform(object, origin) {
        const xyz = origin?.xyz || [0, 0, 0];
        object.position.set(...xyz);
        object.quaternion.copy(this.getOriginQuaternion(origin));
    }

    /**
     * Convert quaternion to Euler angles (simplified version)
     */
    static quaternionToEuler(w, x, y, z) {
        // Normalize quaternion first (MJCF may use non-normalized quaternions)
        const norm = Math.sqrt(w * w + x * x + y * y + z * z);
        if (norm > 0) {
            w = w / norm;
            x = x / norm;
            y = y / norm;
            z = z / norm;
        }

        // Simplified conversion (using standard formula)
        const sinr_cosp = 2 * (w * x + y * z);
        const cosr_cosp = 1 - 2 * (x * x + y * y);
        const roll = Math.atan2(sinr_cosp, cosr_cosp);

        const sinp = 2 * (w * y - z * x);
        const pitch = Math.abs(sinp) >= 1
            ? Math.sign(sinp) * Math.PI / 2
            : Math.asin(sinp);

        const siny_cosp = 2 * (w * z + x * y);
        const cosy_cosp = 1 - 2 * (y * y + z * z);
        const yaw = Math.atan2(siny_cosp, cosy_cosp);

        return [roll, pitch, yaw];
    }

    /**
     * Parse inertial element
     *
     * MJCF inertia is defined in inertial frame, needs:
     * 1. Transform to body frame via quat rotation
     * 2. Then perform MJCF to Three.js coordinate system conversion
     */
    static parseInertial(inertialEl) {
        const inertial = new InertialProperties();

        const mass = inertialEl.getAttribute('mass');
        if (mass) inertial.mass = parseFloat(mass);

        const origin = this.parseOrigin(inertialEl);
        inertial.origin = origin;

        // Parse inertia matrix
        const diaginertia = inertialEl.getAttribute('diaginertia');
        const fullinertia = inertialEl.getAttribute('fullinertia');

        let mjcf_ixx = 0, mjcf_iyy = 0, mjcf_izz = 0;
        let mjcf_ixy = 0, mjcf_ixz = 0, mjcf_iyz = 0;

        if (diaginertia) {
            const values = diaginertia.split(' ').map(parseFloat);
            mjcf_ixx = values[0] || 0;
            mjcf_iyy = values[1] || 0;
            mjcf_izz = values[2] || 0;
        }

        if (fullinertia) {
            const values = fullinertia.split(' ').map(parseFloat);
            mjcf_ixx = values[0] || 0;
            mjcf_iyy = values[1] || 0;
            mjcf_izz = values[2] || 0;
            mjcf_ixy = values[3] || 0;
            mjcf_ixz = values[4] || 0;
            mjcf_iyz = values[5] || 0;
        }

        // Save original diagonal inertia values (for visualization)
        // These are principal moments of inertia in inertial frame
        inertial.diagonalInertia = {
            ixx: mjcf_ixx,
            iyy: mjcf_iyy,
            izz: mjcf_izz
        };

        // If quat exists, need to rotate inertia tensor
        if (origin.quat) {
            const rotated = this.rotateInertiaTensor(
                mjcf_ixx, mjcf_iyy, mjcf_izz,
                mjcf_ixy, mjcf_ixz, mjcf_iyz,
                origin.quat
            );
            mjcf_ixx = rotated.ixx;
            mjcf_iyy = rotated.iyy;
            mjcf_izz = rotated.izz;
            mjcf_ixy = rotated.ixy;
            mjcf_ixz = rotated.ixz;
            mjcf_iyz = rotated.iyz;
        }

        // Coordinate system conversion: MJCF -> Three.js
        // On top of quat rotation, need to rotate 180 degrees around Y-axis (split into two 90-degree rotations)
        // This is the correct transformation from MJCF coordinate system (X-forward, Y-left, Z-up) to Three.js coordinate system (X-right, Y-up, Z-forward)
        const coordRotated1 = this.rotateInertiaAroundAxis(
            mjcf_ixx, mjcf_iyy, mjcf_izz,
            mjcf_ixy, mjcf_ixz, mjcf_iyz,
            'Y', 90
        );

        const coordRotated2 = this.rotateInertiaAroundAxis(
            coordRotated1.ixx, coordRotated1.iyy, coordRotated1.izz,
            coordRotated1.ixy, coordRotated1.ixz, coordRotated1.iyz,
            'Y', 90
        );

        inertial.ixx = coordRotated2.ixx;
        inertial.iyy = coordRotated2.iyy;
        inertial.izz = coordRotated2.izz;
        inertial.ixy = coordRotated2.ixy;
        inertial.ixz = coordRotated2.ixz;
        inertial.iyz = coordRotated2.iyz;

        return inertial;
    }

    /**
     * Rotate inertia tensor around specified axis
     * @param {string} axis - 'X', 'Y', or 'Z'
     * @param {number} degrees - Rotation angle (degrees)
     */
    static rotateInertiaAroundAxis(ixx, iyy, izz, ixy, ixz, iyz, axis, degrees) {
        const rad = degrees * Math.PI / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);

        let R;
        if (axis === 'X') {
            R = [
                [1, 0, 0],
                [0, c, -s],
                [0, s, c]
            ];
        } else if (axis === 'Y') {
            R = [
                [c, 0, s],
                [0, 1, 0],
                [-s, 0, c]
            ];
        } else if (axis === 'Z') {
            R = [
                [c, -s, 0],
                [s, c, 0],
                [0, 0, 1]
            ];
        }

        // Inertia matrix
        const I = [
            [ixx, ixy, ixz],
            [ixy, iyy, iyz],
            [ixz, iyz, izz]
        ];

        // Calculate R * I
        const RI = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 3; k++) {
                    RI[i][j] += R[i][k] * I[k][j];
                }
            }
        }

        // Calculate (R * I) * R^T
        const result = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 3; k++) {
                    result[i][j] += RI[i][k] * R[j][k]; // R^T[k][j] = R[j][k]
                }
            }
        }

        return {
            ixx: result[0][0],
            iyy: result[1][1],
            izz: result[2][2],
            ixy: result[0][1],
            ixz: result[0][2],
            iyz: result[1][2]
        };
    }

    /**
     * Rotate inertia tensor: I_rotated = R * I * R^T
     */
    static rotateInertiaTensor(ixx, iyy, izz, ixy, ixz, iyz, quat) {
        const {w, x, y, z} = quat;

        // Build rotation matrix R (from quaternion)
        const r11 = 1 - 2*(y*y + z*z);
        const r12 = 2*(x*y - w*z);
        const r13 = 2*(x*z + w*y);
        const r21 = 2*(x*y + w*z);
        const r22 = 1 - 2*(x*x + z*z);
        const r23 = 2*(y*z - w*x);
        const r31 = 2*(x*z - w*y);
        const r32 = 2*(y*z + w*x);
        const r33 = 1 - 2*(x*x + y*y);

        // Inertia matrix
        const I = [
            [ixx, ixy, ixz],
            [ixy, iyy, iyz],
            [ixz, iyz, izz]
        ];

        // Calculate R * I
        const RI = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];

        RI[0][0] = r11*I[0][0] + r12*I[1][0] + r13*I[2][0];
        RI[0][1] = r11*I[0][1] + r12*I[1][1] + r13*I[2][1];
        RI[0][2] = r11*I[0][2] + r12*I[1][2] + r13*I[2][2];

        RI[1][0] = r21*I[0][0] + r22*I[1][0] + r23*I[2][0];
        RI[1][1] = r21*I[0][1] + r22*I[1][1] + r23*I[2][1];
        RI[1][2] = r21*I[0][2] + r22*I[1][2] + r23*I[2][2];

        RI[2][0] = r31*I[0][0] + r32*I[1][0] + r33*I[2][0];
        RI[2][1] = r31*I[0][1] + r32*I[1][1] + r33*I[2][1];
        RI[2][2] = r31*I[0][2] + r32*I[1][2] + r33*I[2][2];

        // Calculate (R * I) * R^T
        const result = {
            ixx: RI[0][0]*r11 + RI[0][1]*r12 + RI[0][2]*r13,
            iyy: RI[1][0]*r21 + RI[1][1]*r22 + RI[1][2]*r23,
            izz: RI[2][0]*r31 + RI[2][1]*r32 + RI[2][2]*r33,
            ixy: RI[0][0]*r21 + RI[0][1]*r22 + RI[0][2]*r23,
            ixz: RI[0][0]*r31 + RI[0][1]*r32 + RI[0][2]*r33,
            iyz: RI[1][0]*r31 + RI[1][1]*r32 + RI[1][2]*r33
        };

        return result;
    }

    /**
     * Parse joint element
     */
    static parseJoints(element, bodyMap, model, parentBodyName = null, defaultsMap = null, inheritedChildClass = null) {
        const joints = element.querySelectorAll(':scope > joint');

        joints.forEach(jointEl => {
            const jointName = jointEl.getAttribute('name') || `joint_${model.joints.size}`;
            const jointType = jointEl.getAttribute('type') || 'hinge';

            // Map MJCF joint types to URDF types
            let urdfType = 'revolute';
            if (jointType === 'slide') urdfType = 'prismatic';
            else if (jointType === 'free') urdfType = 'continuous';
            else if (jointType === 'ball' || jointType === 'hinge') urdfType = 'revolute';

            const joint = new Joint(jointName, urdfType);

            // Joint types that don't require axis attribute
            const jointTypesWithoutAxis = ['free', 'ball'];
            const requiresAxis = !jointTypesWithoutAxis.includes(jointType);

            // [Critical fix] In MJCF, joint is defined inside body, representing the connection relationship between this body and its parent body
            // So: parent is parent body, child is current body
            const currentBody = jointEl.parentElement;
            const currentBodyName = currentBody.getAttribute('name');

            // parent is the passed parent body name (or worldbody)
            if (parentBodyName) {
                joint.parent = parentBodyName;
            } else {
                // If no parent body, parent is worldbody
                joint.parent = 'worldbody';
            }

            // child is current body
            if (currentBodyName) {
                joint.child = currentBodyName;
            }


            // [Important] Parse axis, consider class inheritance
            let axisVals = null;
            let axisSource = '';

            // First try to get axis from joint element itself
            const axis = jointEl.getAttribute('axis');
            if (axis) {
                axisVals = axis.split(' ').map(parseFloat);
                axisSource = 'directly defined';
            } else {
                // If not, inherit from class or childclass
                let className = jointEl.getAttribute('class');

                // If joint has no class, check parent body's childclass
                if (!className) {
                    className = currentBody.getAttribute('childclass') || inheritedChildClass;
                }

                if (className && defaultsMap) {
                    const defaults = defaultsMap.get(className);
                    if (defaults && defaults.joint && defaults.joint.axis) {
                        axisVals = defaults.joint.axis;
                        axisSource = `inherited from class="${className}"`;
                    }
                }

                // Only warn if axis is required for this joint type
                if (!axisVals && requiresAxis) {
                    console.warn(`  ⚠️ Joint "${jointName}" (type="${jointType}") has no axis attribute (class="${className || 'none'}")`);
                }
            }

            // Set axis
            if (axisVals) {
                joint.axis = { xyz: [axisVals[0] || 0, axisVals[1] || 0, axisVals[2] || 0] };
            }

            // [Important] Parse limits, consider class inheritance
            let rangeVals = null;

            // First try to get range from joint element itself
            const range = jointEl.getAttribute('range');
            if (range) {
                rangeVals = range.split(' ').map(parseFloat);
            } else {
                // If not, inherit from class or childclass
                let className = jointEl.getAttribute('class');

                // If joint has no class, check parent body's childclass
                if (!className) {
                    className = currentBody.getAttribute('childclass') || inheritedChildClass;
                }

                if (className && defaultsMap) {
                    const defaults = defaultsMap.get(className);
                    if (defaults && defaults.joint && defaults.joint.range) {
                        rangeVals = defaults.joint.range;
                    }
                }
            }

            // Set limits
            if (rangeVals && rangeVals.length >= 2) {
                const limits = new JointLimits();
                limits.lower = rangeVals[0];
                limits.upper = rangeVals[1];
                joint.limits = limits;
            }
            // If no range definition, joint.limits remains null (indicating unlimited/continuous)

            // Parse joint's own origin (if any)
            // joint's pos defines the offset of joint in this body's coordinate system
            joint.origin = this.parseOrigin(jointEl);

            model.addJoint(joint);
        });

        // Process freejoint elements (free-floating joints)
        const freejoints = element.querySelectorAll(':scope > freejoint');
        freejoints.forEach((freejointEl, index) => {
            const freejointName = freejointEl.getAttribute('name') || `freejoint_${model.joints.size}`;
            
            // Create a 'free' type joint (maps to continuous/floating in URDF terms)
            const joint = new Joint(freejointName, 'continuous');
            joint.type = 'free'; // Mark as free joint type
            
            // Get parent body
            const currentBody = freejointEl.parentElement;
            const currentBodyName = currentBody.getAttribute('name');
            
            // Parent is worldbody for freejoints
            if (parentBodyName) {
                joint.parent = parentBodyName;
            } else {
                joint.parent = 'worldbody';
            }
            
            // Child is current body
            if (currentBodyName) {
                joint.child = currentBodyName;
            }
            
            // Parse origin
            joint.origin = this.parseOrigin(freejointEl);
            
            model.addJoint(joint);
        });

        // Recursively process child bodies
        // Find direct child bodies (use :scope > body to ensure only direct children are selected)
        const bodies = element.querySelectorAll(':scope > body');
        const currentElementName = element.getAttribute('name'); // Name of current body or worldbody
        const childClass = element.getAttribute('childclass') || inheritedChildClass;

        bodies.forEach(body => {
            // Child body's parent body name is current element's name
            // Note: worldbody has no name attribute, so first level body's parent is null or 'worldbody'
            this.parseJoints(body, bodyMap, model, currentElementName || 'worldbody', defaultsMap, childClass);
        });
    }

    /**
     * Parse equality constraints (closed-chain constraints for parallel mechanisms)
     */
    static parseEquality(doc, model) {
        const equality = doc.querySelector('equality');
        if (!equality) {
            return; // No equality tag, skip
        }

        // Parse connect constraints (connect two bodies)
        const connects = equality.querySelectorAll('connect');
        connects.forEach((connectEl, index) => {
            const name = connectEl.getAttribute('name') || `connect_${index}`;
            const constraint = new Constraint(name, 'connect');

            constraint.body1 = connectEl.getAttribute('body1');
            constraint.body2 = connectEl.getAttribute('body2');

            const anchor = connectEl.getAttribute('anchor');
            if (anchor) {
                constraint.anchor = anchor.trim().split(/\s+/).map(parseFloat);
            }

            const torquescale = connectEl.getAttribute('torquescale');
            if (torquescale) {
                constraint.torquescale = parseFloat(torquescale);
            }

            constraint.userData = {
                body1: constraint.body1,
                body2: constraint.body2,
                anchor: constraint.anchor
            };

            model.addConstraint(constraint);
        });

        // Parse weld constraints (weld two bodies)
        const welds = equality.querySelectorAll('weld');
        welds.forEach((weldEl, index) => {
            const name = weldEl.getAttribute('name') || `weld_${index}`;
            const constraint = new Constraint(name, 'weld');

            constraint.body1 = weldEl.getAttribute('body1');
            constraint.body2 = weldEl.getAttribute('body2');

            const anchor = weldEl.getAttribute('anchor');
            if (anchor) {
                constraint.anchor = anchor.trim().split(/\s+/).map(parseFloat);
            }

            const torquescale = weldEl.getAttribute('torquescale');
            if (torquescale) {
                constraint.torquescale = parseFloat(torquescale);
            }

            constraint.userData = {
                body1: constraint.body1,
                body2: constraint.body2,
                anchor: constraint.anchor
            };

            model.addConstraint(constraint);
        });

        // Parse joint constraints (joint coupling)
        const joints = equality.querySelectorAll('joint');
        joints.forEach((jointEl, index) => {
            const name = jointEl.getAttribute('name') || `joint_constraint_${index}`;
            const constraint = new Constraint(name, 'joint');

            constraint.joint1 = jointEl.getAttribute('joint1');
            constraint.joint2 = jointEl.getAttribute('joint2');

            const polycoef = jointEl.getAttribute('polycoef');
            if (polycoef) {
                constraint.polycoef = polycoef.trim().split(/\s+/).map(parseFloat);
            } else {
                constraint.polycoef = [0, 1]; // Default 1:1
            }

            constraint.userData = {
                joint1: constraint.joint1,
                joint2: constraint.joint2,
                polycoef: constraint.polycoef
            };

            model.addConstraint(constraint);
        });

        // Parse distance constraints
        const distances = equality.querySelectorAll('distance');
        distances.forEach((distanceEl, index) => {
            const name = distanceEl.getAttribute('name') || `distance_${index}`;
            const constraint = new Constraint(name, 'distance');

            constraint.body1 = distanceEl.getAttribute('body1');
            constraint.body2 = distanceEl.getAttribute('body2');

            constraint.userData = {
                body1: constraint.body1,
                body2: constraint.body2
            };

            model.addConstraint(constraint);
        });
    }

    /**
     * Create Three.js objects (recursively build hierarchy)
     * @param {UnifiedRobotModel} model
     * @param {Map} fileMap - File map for loading mesh files
     * @param {Map} meshMap - Mesh name to file path mapping (optional)
     */
    static async createThreeObject(model, fileMap = null, meshMap = null) {
        // Preload loaders
        await getLoaders();

        const rootGroup = new THREE.Group();
        rootGroup.name = model.name;

        // Create Three.js objects for all links (but don't add to scene yet)
        const linkObjects = new Map();

        // Collect all unique mesh file paths (only need visual, as MJCF doesn't create collision separately)
        const uniqueMeshFiles = new Set();
        for (const [name, link] of model.links) {
            for (const visual of link.visuals) {
                if (visual.geometry.type === 'mesh' && visual.geometry.filename) {
                    uniqueMeshFiles.add(visual.geometry.filename);
                }
            }
        }

        // Load all unique mesh files in parallel
        const meshPromises = Array.from(uniqueMeshFiles).map(filename =>
            this.loadMeshFile(filename, fileMap).catch(err => {
                console.error(`Failed to load mesh: ${filename}`, err);
                return null;
            })
        );

        // Wait for all mesh loading to complete
        const meshResults = await Promise.all(meshPromises);
        const meshCache = new Map();

        // Build mesh cache (filename -> geometry)
        let index = 0;
        for (const filename of uniqueMeshFiles) {
            const result = meshResults[index++];
            meshCache.set(filename, result);
        }

        // Create link groups
        let totalVisuals = 0;
        for (const [name, link] of model.links) {
            const linkGroup = new THREE.Group();
            linkGroup.name = name;
            linkGroup.isURDFLink = true; // Mark as link for JointDragControls recognition
            linkGroup.type = 'URDFLink'; // Set type

            // [Critical] Do not apply body.pos on linkGroup!
            // body.pos should be applied on the jointGroup that connects it
            // linkGroup only needs to contain geometry, position is determined by jointGroup

            let linkVisualCount = 0;
            let linkCollisionCount = 0;

            // Create visual geometry
            for (const visual of link.visuals) {
                const mesh = await this.createGeometryMesh(visual.geometry, fileMap, meshCache);
                if (mesh) {
                    // Apply origin transformation
                    // Check if this geom has fromto data (for capsule/cylinder)
                    if (visual.geometry && visual.geometry.fromto) {
                        // Use fromto center position
                        mesh.position.set(...visual.geometry.fromto.center);
                        // Apply fromto rotation plus any explicit origin
                        // rotation using quaternion composition.
                        const fromtoRpy = visual.geometry.fromto.rpy;
                        mesh.quaternion.setFromEuler(
                            new THREE.Euler(fromtoRpy[0], fromtoRpy[1], fromtoRpy[2], 'ZYX')
                        );
                        mesh.quaternion.multiply(this.getOriginQuaternion(visual.origin));
                    } else {
                        this.applyOriginTransform(mesh, visual.origin);
                    }
                    mesh.name = visual.name || 'visual';

                    // If MJCF defines rgba color, apply to mesh
                    if (visual.userData && visual.userData.rgba) {
                        const rgba = visual.userData.rgba;
                        const color = new THREE.Color(rgba.r, rgba.g, rgba.b);

                        mesh.traverse((child) => {
                            if (child.isMesh && child.material) {
                                // Handle material arrays and single materials
                                if (Array.isArray(child.material)) {
                                    child.material = child.material.map(mat => {
                                        const clonedMat = mat.clone();
                                        clonedMat.color = color;
                                        if (rgba.a < 1.0) {
                                            clonedMat.transparent = true;
                                            clonedMat.opacity = rgba.a;
                                        }
                                        // Save original properties before enhancing (for lighting toggle)
                                        if (clonedMat.isMeshPhongMaterial || clonedMat.isMeshStandardMaterial) {
                                            if (clonedMat.userData.originalShininess === undefined) {
                                                clonedMat.userData.originalShininess = clonedMat.shininess !== undefined ? clonedMat.shininess : 30;
                                                // Save original specular - if material had no specular, save null
                                                if (!clonedMat.specular) {
                                                    clonedMat.userData.originalSpecular = null;
                                                } else if (clonedMat.specular.isColor) {
                                                    const spec = clonedMat.specular;
                                                    if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                                        clonedMat.userData.originalSpecular = null; // Likely default
                                                    } else {
                                                        clonedMat.userData.originalSpecular = spec.clone();
                                                    }
                                                } else if (typeof clonedMat.specular === 'number') {
                                                    if (clonedMat.specular === 0x111111 || clonedMat.specular < 0x111111) {
                                                        clonedMat.userData.originalSpecular = null;
                                                    } else {
                                                        clonedMat.userData.originalSpecular = new THREE.Color(clonedMat.specular);
                                                    }
                                                } else {
                                                    clonedMat.userData.originalSpecular = null;
                                                }
                                            }
                                            // Enhance material for better lighting (MuJoCo style) - default enabled
                                            if (clonedMat.shininess === undefined || clonedMat.shininess < 50) {
                                                clonedMat.shininess = 50;
                                            }
                                            if (!clonedMat.specular ||
                                                (clonedMat.specular.isColor && clonedMat.specular.r < 0.2) ||
                                                (typeof clonedMat.specular === 'number' && clonedMat.specular < 0x333333)) {
                                                clonedMat.specular = new THREE.Color(0.3, 0.3, 0.3);
                                            }
                                        }
                                        return clonedMat;
                                    });
                                } else {
                                    // Clone material to avoid affecting other instances
                                    child.material = child.material.clone();
                                    child.material.color = color;
                                    if (rgba.a < 1.0) {
                                        child.material.transparent = true;
                                        child.material.opacity = rgba.a;
                                    }
                                    // Save original properties before enhancing (for lighting toggle)
                                    if (child.material.isMeshPhongMaterial || child.material.isMeshStandardMaterial) {
                                        if (child.material.userData.originalShininess === undefined) {
                                            child.material.userData.originalShininess = child.material.shininess !== undefined ? child.material.shininess : 30;
                                            // Save original specular - if material had no specular, save null
                                            if (!child.material.specular) {
                                                child.material.userData.originalSpecular = null;
                                            } else if (child.material.specular.isColor) {
                                                const spec = child.material.specular;
                                                if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                                    child.material.userData.originalSpecular = null; // Likely default
                                                } else {
                                                    child.material.userData.originalSpecular = spec.clone();
                                                }
                                            } else if (typeof child.material.specular === 'number') {
                                                if (child.material.specular === 0x111111 || child.material.specular < 0x111111) {
                                                    child.material.userData.originalSpecular = null;
                                                } else {
                                                    child.material.userData.originalSpecular = new THREE.Color(child.material.specular);
                                                }
                                            } else {
                                                child.material.userData.originalSpecular = null;
                                            }
                                        }
                                        // Enhance material for better lighting (MuJoCo style) - default enabled
                                        if (child.material.shininess === undefined || child.material.shininess < 50) {
                                            child.material.shininess = 50;
                                        }
                                        if (!child.material.specular ||
                                            (child.material.specular.isColor && child.material.specular.r < 0.2) ||
                                            (typeof child.material.specular === 'number' && child.material.specular < 0x333333)) {
                                            child.material.specular = new THREE.Color(0.3, 0.3, 0.3);
                                        }
                                    }
                                }
                            }
                        });
                    }

                    linkGroup.add(mesh);
                    visual.threeObject = mesh;
                    totalVisuals++;
                    linkVisualCount++;
                }
            }

            // Create collision geometry
            for (const collision of link.collisions) {
                const mesh = await this.createGeometryMesh(collision.geometry, fileMap, meshCache);
                if (mesh) {
                    // Apply origin transformation
                    // Check if this geom has fromto data (for capsule/cylinder)
                    if (collision.geometry && collision.geometry.fromto) {
                        // Use fromto center position
                        mesh.position.set(...collision.geometry.fromto.center);
                        // Apply fromto rotation plus any explicit origin
                        // rotation using quaternion composition.
                        const fromtoRpy = collision.geometry.fromto.rpy;
                        mesh.quaternion.setFromEuler(
                            new THREE.Euler(fromtoRpy[0], fromtoRpy[1], fromtoRpy[2], 'ZYX')
                        );
                        mesh.quaternion.multiply(this.getOriginQuaternion(collision.origin));
                    } else {
                        this.applyOriginTransform(mesh, collision.origin);
                    }
                    mesh.name = collision.name || 'collision';

                    // Create collision body container (similar to URDF handling)
                    const colliderGroup = new THREE.Group();
                    colliderGroup.name = `${name}_collider_${linkCollisionCount}`;
                    colliderGroup.isURDFCollider = true; // Mark as collision body
                    colliderGroup.add(mesh);

                    linkGroup.add(colliderGroup);
                    collision.threeObject = colliderGroup;
                    linkCollisionCount++;
                }
            }

            link.threeObject = linkGroup;
            linkObjects.set(name, linkGroup);
        }


        // Build hierarchy based on body parent-child relationships (MJCF bodies are nested)
        const bodyMap = new Map();
        for (const [name, link] of model.links) {
            bodyMap.set(name, { link, parentName: link.userData.parentName });
        }

        // Find root body (body without parent)
        const rootLinks = Array.from(model.links.keys()).filter(
            name => !bodyMap.get(name).parentName
        );

        // Recursively build hierarchy
        function buildHierarchy(linkName, parentGroup) {
            const linkGroup = linkObjects.get(linkName);
            if (!linkGroup) return;

            // Add current link to parent group
            parentGroup.add(linkGroup);

            // Find all joints with this link as parent
            const childJoints = Array.from(model.joints.values()).filter(
                j => j.parent === linkName && j.child
            );

            // Process child joints and child bodies.  MJCF permits multiple
            // joints on one body (the microduck backlash model adds a passive
            // joint immediately after every servo joint).  Those joints are a
            // serial chain, not sibling alternatives.  Nesting their groups
            // keeps every joint functional and prevents Three.js from
            // re-parenting the link into only the last group.
            const jointsByChild = new Map();
            childJoints.forEach(joint => {
                if (!joint.child) return;
                if (!jointsByChild.has(joint.child)) jointsByChild.set(joint.child, []);
                jointsByChild.get(joint.child).push(joint);
            });

            jointsByChild.forEach((joints, childLinkName) => {
                const childLink = model.links.get(childLinkName);
                const bodyOrigin = childLink?.userData?.bodyOrigin || { xyz: [0, 0, 0], rpy: [0, 0, 0] };

                // body.pos/body.quat define the child body's nominal frame.
                // joint.pos is a pivot *inside* that frame; it must not be
                // added to body.pos or every non-zero joint anchor shifts the
                // complete child body at q=0.
                const bodyFrame = new THREE.Group();
                bodyFrame.name = `${childLinkName}_body_frame`;
                MJCFAdapter.applyOriginTransform(bodyFrame, bodyOrigin);
                linkGroup.add(bodyFrame);

                let jointParent = bodyFrame;

                joints.forEach((joint, jointIndex) => {
                    const jointGroup = new THREE.Group();
                    jointGroup.name = joint.name || `joint_${childLinkName}_${jointIndex}`;
                    jointGroup.isURDFJoint = true;
                    jointGroup.type = 'URDFJoint';
                    jointGroup.jointType = joint.type;

                    // Store joint axis information (for JointDragControls use)
                    if (joint.axis && joint.axis.xyz) {
                        const mjcfAxis = joint.axis.xyz;
                        jointGroup.axis = new THREE.Vector3(mjcfAxis[0], mjcfAxis[1], mjcfAxis[2]).normalize();
                    } else {
                        jointGroup.axis = new THREE.Vector3(0, 1, 0);
                    }

                    const jointOrigin = joint.origin || { xyz: [0, 0, 0], rpy: [0, 0, 0] };
                    MJCFAdapter.applyOriginTransform(jointGroup, jointOrigin);

                    jointParent.add(jointGroup);
                    joint.threeObject = jointGroup;

                    // Return to the body frame after the pivot transform. At
                    // zero joint value this pair is exactly identity; at a
                    // non-zero value the body and all descendants rotate or
                    // slide around the declared MJCF joint anchor.
                    const inverseOrigin = new THREE.Group();
                    inverseOrigin.name = `${jointGroup.name}_body_frame`;
                    const originQuaternion = jointGroup.quaternion.clone();
                    const inverseQuaternion = originQuaternion.clone().invert();
                    inverseOrigin.quaternion.copy(inverseQuaternion);
                    inverseOrigin.position
                        .set(...jointOrigin.xyz)
                        .multiplyScalar(-1)
                        .applyQuaternion(inverseQuaternion);
                    jointGroup.add(inverseOrigin);
                    jointParent = inverseOrigin;
                });

                // Build the child link below the final joint in the chain.
                buildHierarchy(childLinkName, jointParent);
            });

            // Process direct child bodies (find via bodyMap)
            for (const [childName, bodyData] of bodyMap.entries()) {
                if (bodyData.parentName === linkName) {
                    // Check if joint connection already exists
                    const hasJoint = Array.from(model.joints.values()).some(
                        j => j.parent === linkName && j.child === childName
                    );
                    if (!hasJoint) {
                        // If no joint, create fixed connection group to apply body position and rotation
                        const childLink = model.links.get(childName);
                        const childBodyOrigin = childLink.userData.bodyOrigin || { xyz: [0, 0, 0], rpy: [0, 0, 0] };

                        // Mark this as fixed-connected child body (for structure graph display)
                        childLink.userData.isFixedConnection = true;

                        // Create fixed connection group
                        const fixedGroup = new THREE.Group();
                        MJCFAdapter.applyOriginTransform(fixedGroup, childBodyOrigin);

                        // Recursively build child body and add to fixed group
                        buildHierarchy(childName, fixedGroup);

                        linkGroup.add(fixedGroup);
                    }
                }
            }
        }

        // Start building from root link
        if (rootLinks.length > 0) {
            rootLinks.forEach(rootName => {
                // Root link needs to apply its own body.pos (because it has no parent joint)
                const rootLink = model.links.get(rootName);
                const rootLinkGroup = linkObjects.get(rootName);
                if (rootLink.userData.bodyOrigin) {
                    MJCFAdapter.applyOriginTransform(rootLinkGroup, rootLink.userData.bodyOrigin);
                }
                buildHierarchy(rootName, rootGroup);
            });
        } else if (model.links.size > 0) {
            // If no root link found, use first link
            const firstLink = Array.from(model.links.keys())[0];
            const firstLinkObj = model.links.get(firstLink);
            const firstLinkGroup = linkObjects.get(firstLink);
            if (firstLinkObj.userData.bodyOrigin) {
                MJCFAdapter.applyOriginTransform(firstLinkGroup, firstLinkObj.userData.bodyOrigin);
            }
            buildHierarchy(firstLink, rootGroup);
        }

        model.threeObject = rootGroup;

        // Mark model type as MJCF (also set on model)
        if (!rootGroup.userData) rootGroup.userData = {};
        rootGroup.userData.type = 'mjcf';

        if (!model.userData) model.userData = {};
        model.userData.type = 'mjcf';
    }

    /**
     * Create Three.js Mesh based on geometry type
     * @param {GeometryType} geometry
     * @param {Map} fileMap - File map for loading mesh files
     * @param {Map} meshCache - Cache of loaded meshes (optional)
     * @returns {Promise<THREE.Mesh|null>}
     */
    static async createGeometryMesh(geometry, fileMap = null, meshCache = null) {
        let threeGeometry = null;

        switch (geometry.type) {
            case 'plane':
                if (geometry.size) {
                    // Three.js PlaneGeometry is already XY-aligned with its
                    // normal along +Z, matching an MJCF plane.
                    threeGeometry = new THREE.PlaneGeometry(
                        geometry.size.width,
                        geometry.size.height
                    );
                }
                break;

            case 'box':
                if (geometry.size) {
                    threeGeometry = new THREE.BoxGeometry(
                        geometry.size.x,
                        geometry.size.y,
                        geometry.size.z
                    );
                }
                break;

            case 'sphere':
                if (geometry.size && geometry.size.radius) {
                    threeGeometry = new THREE.SphereGeometry(geometry.size.radius, 32, 32);
                }
                break;

            case 'cylinder':
                if (geometry.size) {
                    // Three.js CylinderGeometry defaults to Y-axis
                    threeGeometry = new THREE.CylinderGeometry(
                        geometry.size.radius,
                        geometry.size.radius,
                        geometry.size.height,
                        32
                    );
                    // MJCF cylinder defaults to Z-axis, Three.js Cylinder is Y-axis aligned
                    // Rotate to align with Z-axis
                    threeGeometry.rotateX(Math.PI / 2);
                    
                    // If fromto is defined, the mesh will be positioned and rotated by fromto data
                    // in the calling code
                }
                break;

            case 'capsule':
                if (geometry.size) {
                    // Three.js doesn't have native CapsuleGeometry in older versions
                    // Use a combination of cylinder and spheres, or CapsuleGeometry if available
                    const { radius, height } = geometry.size;
                    
                    // Check if CapsuleGeometry is available (Three.js r133+)
                    if (typeof THREE.CapsuleGeometry !== 'undefined') {
                        threeGeometry = new THREE.CapsuleGeometry(radius, height, 4, 16);
                        // CapsuleGeometry is Y-axis aligned, MJCF capsule is Z-axis aligned
                        threeGeometry.rotateX(Math.PI / 2);
                    } else {
                        // Fallback: create a cylinder with sphere caps
                        const cylinderHeight = Math.max(0, height - 2 * radius);
                        const cylinder = new THREE.CylinderGeometry(radius, radius, cylinderHeight, 16);
                        cylinder.rotateX(Math.PI / 2); // Align with Z-axis
                        threeGeometry = cylinder;
                    }
                }
                break;

            case 'mesh':
                // Load mesh file
                if (geometry.filename) {
                    let cachedMesh = null;

                    // If already cached, get it
                    if (meshCache && meshCache.has(geometry.filename)) {
                        cachedMesh = meshCache.get(geometry.filename);
                    } else if (fileMap) {
                        cachedMesh = await this.loadMeshFile(geometry.filename, fileMap);
                    }

                    if (!cachedMesh) {
                        console.error(`❌ Cannot load mesh file: ${geometry.filename}`);
                        return null;
                    }

                    // loadMeshFile may return Group/Scene (OBJ/DAE/GLTF) or BufferGeometry (STL)
                    // If Group/Scene, need to clone (because Three.js objects can only have one parent)
                    if (cachedMesh.isGroup || cachedMesh.isObject3D) {
                        threeGeometry = cachedMesh.clone(true); // Deep clone (including materials)

                        // Apply mesh scale from MJCF class inheritance (e.g., scale="0.001 0.001 0.001")
                        if (geometry.meshScale) {
                            const [sx, sy, sz] = geometry.meshScale;
                            threeGeometry.scale.set(sx, sy, sz);
                        }

                        // Check cloned mesh material situation
                        let meshCount = 0;
                        let materialCount = 0;
                        threeGeometry.traverse((child) => {
                            if (child.isMesh) {
                                meshCount++;
                                if (child.material) {
                                    materialCount++;
                                }
                            }
                        });

                        // Ensure mesh uses lighting-compatible material
                        ensureMeshHasPhongMaterial(threeGeometry);
                        return threeGeometry;
                    }
                    // If BufferGeometry (e.g., STL), create a mesh and apply scale
                    if (geometry.meshScale) {
                        const [sx, sy, sz] = geometry.meshScale;
                        // Scale the geometry directly
                        threeGeometry = cachedMesh.clone();
                        threeGeometry.scale(sx, sy, sz);
                    } else {
                        threeGeometry = cachedMesh;
                    }
                } else {
                    console.warn('⚠️ Mesh type geometry missing filename');
                    return null;
                }
                break;
        }

        if (!threeGeometry) return null;

        // Create default material for BufferGeometry (basic geometries: box, sphere, cylinder, stl, etc.)
        // Enhanced for better lighting (MuJoCo style) with reflections
        const envMap = typeof window !== 'undefined' && window.app?.sceneManager?.environmentManager?.getEnvironmentMap();
        const material = new THREE.MeshPhongMaterial({
            color: 0xf0f0f0,  // Near white
            shininess: 50,  // Increased for better highlights
            specular: new THREE.Color(0.3, 0.3, 0.3),  // Enhanced specular reflection
            envMap: envMap || null,
            reflectivity: envMap ? 0.3 : 0
        });
        // Save original properties for lighting toggle
        material.userData.originalShininess = 30;
        material.userData.originalSpecular = null; // New material, no original specular
        const mesh = new THREE.Mesh(threeGeometry, material);
        if (geometry.infinite) {
            // The finite display stand-in for an infinite MJCF plane must not
            // dominate model bounds used for auto-fit and axes sizing.
            mesh.userData.excludeFromBounds = true;
        }
        return mesh;
    }

    /**
     * Load mesh file from fileMap (using universal loader)
     */
    static async loadMeshFile(meshPath, fileMap) {
        return loadMeshFile(meshPath, fileMap);
    }

    /**
     * Set joint angle
     */
    static setJointAngle(joint, angle) {
        joint.currentValue = angle;

        if (joint.threeObject) {
            // Rotate based on joint type and axis
            if (joint.type === 'revolute' || joint.type === 'continuous') {
                // Use axis stored on threeObject (already converted), if not available convert from joint.axis
                let axis;
                if (joint.threeObject.axis) {
                    axis = joint.threeObject.axis.clone().normalize();
                } else if (joint.axis && joint.axis.xyz) {
                    // If no pre-stored axis, need coordinate system conversion
                    const mjcfAxis = joint.axis.xyz;
                    axis = new THREE.Vector3(mjcfAxis[0], mjcfAxis[2], -mjcfAxis[1]).normalize();
                } else {
                    console.warn('Joint has no axis definition:', joint.name);
                    return;
                }

                // Save initial rotation (only save on first call)
                if (!joint.threeObject.userData.initialQuaternion) {
                    joint.threeObject.userData.initialQuaternion = joint.threeObject.quaternion.clone();
                }

                // Set rotation using quaternion: initial rotation * joint rotation
                const rotationQuat = new THREE.Quaternion();
                rotationQuat.setFromAxisAngle(axis, angle);

                // Combine rotations: apply initial rotation first, then joint rotation
                joint.threeObject.quaternion.copy(joint.threeObject.userData.initialQuaternion);
                joint.threeObject.quaternion.multiply(rotationQuat);

                // Update matrix
                joint.threeObject.updateMatrixWorld(true);
            } else if (joint.type === 'prismatic') {
                // Use axis stored on threeObject (already converted) or convert from joint.axis
                let axis;
                if (joint.threeObject.axis) {
                    axis = joint.threeObject.axis.clone().normalize();
                } else if (joint.axis && joint.axis.xyz) {
                    // If no pre-stored axis, need coordinate system conversion
                    const mjcfAxis = joint.axis.xyz;
                    axis = new THREE.Vector3(mjcfAxis[0], mjcfAxis[2], -mjcfAxis[1]).normalize();
                } else {
                    console.warn('Joint has no axis definition:', joint.name);
                    return;
                }

                // Save initial position (only save on first call)
                if (!joint.threeObject.userData.initialPosition) {
                    joint.threeObject.userData.initialPosition = joint.threeObject.position.clone();
                }

                // Translate joint: initial position + move along axis
                joint.threeObject.position.copy(joint.threeObject.userData.initialPosition);
                joint.threeObject.position.addScaledVector(axis, angle);

                // Update matrix
                joint.threeObject.updateMatrixWorld(true);
            }
        }
    }
}
