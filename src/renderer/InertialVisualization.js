import * as THREE from 'three';
import { MathUtils } from '../utils/MathUtils.js';

/**
 * InertialVisualization - Handles center of mass and inertia visualization
 */
export class InertialVisualization {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.comMarkers = [];
        this.inertiaEllipsoids = [];
        this.showCOM = false;
        this.showInertia = false;
    }

    /**
     * Static method: Create COM marker geometry (Blender-style black-and-white sphere)
     * @param {number} radius - Radius of COM marker
     * @returns {THREE.Group} COM marker group
     */
    static createCOMGeometry(radius) {
        const comGroup = new THREE.Group();
        const segments = 16;

        const comMaterialWhite = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true
        });
        const comMaterialBlack = new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true
        });

        // Create 8 quarter spheres with alternating black and white
        const sphereParts = [
            { phiStart: 0, phiLength: Math.PI/2, thetaStart: 0, thetaLength: Math.PI/2, material: comMaterialWhite },
            { phiStart: 0, phiLength: Math.PI/2, thetaStart: Math.PI/2, thetaLength: Math.PI/2, material: comMaterialBlack },
            { phiStart: Math.PI/2, phiLength: Math.PI/2, thetaStart: 0, thetaLength: Math.PI/2, material: comMaterialBlack },
            { phiStart: Math.PI/2, phiLength: Math.PI/2, thetaStart: Math.PI/2, thetaLength: Math.PI/2, material: comMaterialWhite },
            { phiStart: Math.PI, phiLength: Math.PI/2, thetaStart: 0, thetaLength: Math.PI/2, material: comMaterialWhite },
            { phiStart: Math.PI, phiLength: Math.PI/2, thetaStart: Math.PI/2, thetaLength: Math.PI/2, material: comMaterialBlack },
            { phiStart: Math.PI*1.5, phiLength: Math.PI/2, thetaStart: 0, thetaLength: Math.PI/2, material: comMaterialBlack },
            { phiStart: Math.PI*1.5, phiLength: Math.PI/2, thetaStart: Math.PI/2, thetaLength: Math.PI/2, material: comMaterialWhite }
        ];

        sphereParts.forEach(part => {
            const geometry = new THREE.SphereGeometry(
                radius, segments, segments,
                part.phiStart, part.phiLength,
                part.thetaStart, part.thetaLength
            );
            const mesh = new THREE.Mesh(geometry, part.material);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            // Allow raycasting so COM can be selected for dragging
            comGroup.add(mesh);
        });

        return comGroup;
    }

    /**
     * Extract and visualize inertial properties from model
     */
    extractInertialProperties(model) {
        // Clean up: remove from parent objects
        this.comMarkers.forEach(marker => {
            if (marker.parent) {
                marker.parent.remove(marker);
            }
        });
        this.inertiaEllipsoids.forEach(ellipsoid => {
            if (ellipsoid.parent) {
                ellipsoid.parent.remove(ellipsoid);
            }
        });
        this.comMarkers = [];
        this.inertiaEllipsoids = [];

        if (!model.links) {
            return;
        }

        model.links.forEach((link, name) => {
            if (!link.inertial) return;

            const inertial = link.inertial;

            // Try to get COM position, handling various data formats
            let comPosition;
            try {
                if (inertial.origin && inertial.origin.xyz) {
                    comPosition = MathUtils.xyzToVector3(inertial.origin.xyz);
                } else if (inertial.origin) {
                    // Might be array form
                    comPosition = new THREE.Vector3(
                        inertial.origin[0] || 0,
                        inertial.origin[1] || 0,
                        inertial.origin[2] || 0
                    );
                } else {
                    comPosition = new THREE.Vector3(0, 0, 0);
                }
            } catch (error) {
                console.error(`Failed to extract COM position for Link ${name}:`, error);
                comPosition = new THREE.Vector3(0, 0, 0);
            }

            // Create COM marker (only when display is needed)
            if (this.showCOM && inertial.mass !== undefined && inertial.mass > 0) {
                this.createCOMMarker(model, link, comPosition);
            }

            // Create inertia ellipsoid (only when display is needed)
            if (this.showInertia && (inertial.ixx !== undefined || inertial.inertia)) {
                this.createInertiaEllipsoid(model, link, comPosition, inertial);
            }
        });
    }

    /**
     * Create Blender-style quarter black-and-white sphere COM marker
     */
    createCOMMarker(model, link, position) {
        const linkObject = this.findLinkObject(model.threeObject, link.name);
        if (!linkObject) {
            return;
        }

        // Create Blender-style quarter black-white sphere
        const comGroup = new THREE.Group();
        const radius = 0.02;
        const segments = 16;

        // Material configuration: fully opaque, proper depth testing (occluded when inside model)
        const comMaterialWhite = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true
        });
        const comMaterialBlack = new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true
        });

        // Create 8 quarter spheres with alternating black and white
        // Front top: white (0° - 90° horizontal, 0° - 90° vertical)
        const frontTopGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            0, Math.PI / 2,
            0, Math.PI / 2
        );
        const frontTopMesh = new THREE.Mesh(frontTopGeo, comMaterialWhite);

        // Front bottom: black
        const frontBottomGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            0, Math.PI / 2,
            Math.PI / 2, Math.PI / 2
        );
        const frontBottomMesh = new THREE.Mesh(frontBottomGeo, comMaterialBlack);

        // Back top: black
        const backTopGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI / 2, Math.PI / 2,
            0, Math.PI / 2
        );
        const backTopMesh = new THREE.Mesh(backTopGeo, comMaterialBlack);

        // Back bottom: white
        const backBottomGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI / 2, Math.PI / 2,
            Math.PI / 2, Math.PI / 2
        );
        const backBottomMesh = new THREE.Mesh(backBottomGeo, comMaterialWhite);

        // Left top: white
        const leftTopGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI, Math.PI / 2,
            0, Math.PI / 2
        );
        const leftTopMesh = new THREE.Mesh(leftTopGeo, comMaterialWhite);

        // Left bottom: black
        const leftBottomGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI, Math.PI / 2,
            Math.PI / 2, Math.PI / 2
        );
        const leftBottomMesh = new THREE.Mesh(leftBottomGeo, comMaterialBlack);

        // Right top: black
        const rightTopGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI * 1.5, Math.PI / 2,
            0, Math.PI / 2
        );
        const rightTopMesh = new THREE.Mesh(rightTopGeo, comMaterialBlack);

        // Right bottom: white
        const rightBottomGeo = new THREE.SphereGeometry(
            radius, segments, segments,
            Math.PI * 1.5, Math.PI / 2,
            Math.PI / 2, Math.PI / 2
        );
        const rightBottomMesh = new THREE.Mesh(rightBottomGeo, comMaterialWhite);

        comGroup.add(frontTopMesh);
        comGroup.add(frontBottomMesh);
        comGroup.add(backTopMesh);
        comGroup.add(backBottomMesh);
        comGroup.add(leftTopMesh);
        comGroup.add(leftBottomMesh);
        comGroup.add(rightTopMesh);
        comGroup.add(rightBottomMesh);

        // Mark this as center of mass
        comGroup.userData.isCenterOfMass = true;

        comGroup.position.copy(position);
        comGroup.visible = this.showCOM;

        linkObject.add(comGroup);
        this.comMarkers.push(comGroup);
    }

    /**
     * Create inertia box visualization (Gazebo style)
     */
    createInertiaEllipsoid(model, link, comPosition, inertial) {
        // For MJCF models with quat, use the original diagonal inertia values
        // (before rotation), then apply the quat rotation to the visualization
        let inertiaForCalculation;
        if (inertial.diagonalInertia) {
            // Use the original diagonal inertia from MJCF inertial frame
            inertiaForCalculation = {
                ixx: inertial.diagonalInertia.ixx,
                iyy: inertial.diagonalInertia.iyy,
                izz: inertial.diagonalInertia.izz,
                ixy: 0, // No off-diagonal components
                ixz: 0,
                iyz: 0,
                mass: inertial.mass
            };
        } else {
            // For URDF or models without diagonalInertia, use as-is
            // (may have off-diagonal components)
            inertiaForCalculation = inertial;
        }

        // Calculate inertia box (like Gazebo)
        // This will perform eigendecomposition if there are off-diagonal components
        const boxData = MathUtils.computeInertiaBox(inertiaForCalculation);

        // If boxData is null, the inertia parameters are invalid or unreasonable
        // (e.g., very small mass with large inertia), so don't display the box
        if (!boxData) {
            return; // Skip creating inertia visualization
        }

        const boxGeometry = MathUtils.createInertiaBoxGeometry(
            boxData.width,
            boxData.height,
            boxData.depth
        );

        // Use semi-transparent light blue fill box (similar to collider style)
        const boxMaterial = new THREE.MeshPhongMaterial({
            transparent: true,
            opacity: 0.35,
            shininess: 2.5,
            premultipliedAlpha: true,
            color: 0x4a9eff,  // Light blue
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });

        const inertiaBox = new THREE.Mesh(boxGeometry, boxMaterial);
        inertiaBox.position.copy(comPosition);

        // Apply rotation
        if (inertial.origin && inertial.origin.quat) {
            // For MJCF: Need to transform the quat from MJCF frame to Three.js frame
            // The quat represents rotation in MJCF coordinate system
            // In MJCFAdapter.parseInertial, the inertia tensor is:
            // 1. Rotated by quat in MJCF frame
            // 2. Then transformed to Three.js frame by Y-axis 180° rotation
            //
            // For the visual ellipsoid, try applying coord conversion first:
            const quat = inertial.origin.quat;
            const mjcfQuat = new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w);

            // Apply coordinate system transformation: 180° around Y axis
            // This matches the two 90° Y-rotations in MJCFAdapter.parseInertial
            const coordConversionQuat = new THREE.Quaternion();
            coordConversionQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

            // Try reversed order: first coord conversion, then quat
            const finalQuat = new THREE.Quaternion();
            finalQuat.multiplyQuaternions(mjcfQuat, coordConversionQuat);

            inertiaBox.quaternion.copy(finalQuat);
        } else if (boxData.rotation && boxData.rotation.w !== undefined) {
            // For URDF with off-diagonal components: use the rotation from eigendecomposition
            inertiaBox.quaternion.copy(boxData.rotation);
        } else if (inertial.origin && inertial.origin.rpy) {
            // For URDF with RPY (though this is usually just for COM position, not inertia orientation)
            const rpy = inertial.origin.rpy;
            inertiaBox.rotation.set(rpy[0], rpy[1], rpy[2], 'ZYX');
        } else {
            inertiaBox.rotation.set(0, 0, 0, 'ZYX');
        }

        inertiaBox.visible = this.showInertia;
        inertiaBox.castShadow = false;
        inertiaBox.receiveShadow = false;

        // Allow raycasting so inertia box can be selected for dragging
        // Mark as inertia box
        inertiaBox.userData.isInertiaBox = true;

        const linkObject = this.findLinkObject(model.threeObject, link.name);
        if (linkObject) {
            linkObject.add(inertiaBox);
        } else {
            this.sceneManager.scene.add(inertiaBox);
        }

        this.inertiaEllipsoids.push(inertiaBox); // Although called ellipsoids, they're boxes now
    }

    /**
     * Find link object in scene graph
     */
    findLinkObject(root, linkName) {
        let found = null;
        root.traverse((child) => {
            if (child.name === linkName || child.name === `link_${linkName}` || child.name === `body_${linkName}`) {
                found = child;
            }
        });
        return found;
    }

    /**
     * Toggle COM display
     */
    toggleCenterOfMass(show, currentModel) {
        this.showCOM = show;

        if (show && this.comMarkers.length === 0 && currentModel) {
            // If enabling and not yet created, need to recreate
            this.extractInertialProperties(currentModel);
        } else {
            // Otherwise just toggle visibility
            this.comMarkers.forEach(marker => {
                marker.visible = show;
            });
        }
    }

    /**
     * Toggle inertia display
     */
    toggleInertia(show, currentModel) {
        this.showInertia = show;

        if (show && this.inertiaEllipsoids.length === 0 && currentModel) {
            // If enabling and not yet created, need to recreate
            this.extractInertialProperties(currentModel);
        } else {
            // Otherwise just toggle visibility
            this.inertiaEllipsoids.forEach(ellipsoid => {
                ellipsoid.visible = show;
            });
        }
    }

    /**
     * Clear all inertial visualizations
     */
    clear() {
        this.comMarkers.forEach(marker => {
            if (marker.parent) marker.parent.remove(marker);
        });
        this.inertiaEllipsoids.forEach(ellipsoid => {
            if (ellipsoid.parent) ellipsoid.parent.remove(ellipsoid);
        });
        this.comMarkers = [];
        this.inertiaEllipsoids = [];
    }
}

