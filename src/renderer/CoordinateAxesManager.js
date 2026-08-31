import * as THREE from 'three';

/**
 * CoordinateAxesManager - Handles link coordinate axes and joint axes visualization
 */
export class CoordinateAxesManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.linkAxesHelpers = new Map();
        this.jointAxesHelpers = new Map();
        this.showAxesEnabled = false;
        this.showJointAxesEnabled = false;
    }

    /**
     * Static method: Create coordinate axes geometry
     * @param {number} axesSize - Length of axes
     * @returns {THREE.Group} Axes group
     */
    static createAxesGeometry(axesSize) {
        const axesGroup = new THREE.Group();
        const axisRadius = Math.max(0.001, axesSize * 0.015);
        const axisGeometry = new THREE.CylinderGeometry(axisRadius, axisRadius, axesSize, 8);

        // X axis (red)
        const xAxis = new THREE.Mesh(axisGeometry, new THREE.MeshPhongMaterial({
            color: 0xff0000, shininess: 30, depthTest: true
        }));
        xAxis.position.x = axesSize / 2;
        xAxis.rotation.z = -Math.PI / 2;
        xAxis.castShadow = false;
        xAxis.receiveShadow = false;
        axesGroup.add(xAxis);

        // Y axis (green)
        const yAxis = new THREE.Mesh(axisGeometry, new THREE.MeshPhongMaterial({
            color: 0x00ff00, shininess: 30, depthTest: true
        }));
        yAxis.position.y = axesSize / 2;
        yAxis.castShadow = false;
        yAxis.receiveShadow = false;
        axesGroup.add(yAxis);

        // Z axis (blue)
        const zAxis = new THREE.Mesh(axisGeometry, new THREE.MeshPhongMaterial({
            color: 0x0000ff, shininess: 30, depthTest: true
        }));
        zAxis.position.z = axesSize / 2;
        zAxis.rotation.x = Math.PI / 2;
        zAxis.castShadow = false;
        zAxis.receiveShadow = false;
        axesGroup.add(zAxis);

        return axesGroup;
    }

    /**
     * Static method: Create joint arrow geometry with rotation indicator
     * @param {THREE.Vector3} axisDirection - Direction of joint axis
     * @returns {THREE.Group} Arrow group with rotation indicator
     */
    static createJointArrowGeometry(axisDirection) {
        const arrowLength = 0.2;
        const shaftLength = arrowLength * 0.7;
        const headLength = arrowLength * 0.3;
        const shaftRadius = 0.004;
        const headRadius = 0.012;
        const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });

        const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 16, 1);
        const shaftMesh = new THREE.Mesh(shaftGeometry, arrowMaterial);
        shaftMesh.position.y = shaftLength / 2;

        const headGeometry = new THREE.ConeGeometry(headRadius, headLength, 16);
        const headMesh = new THREE.Mesh(headGeometry, arrowMaterial);
        headMesh.position.y = shaftLength + headLength / 2;

        const arrow = new THREE.Group();
        arrow.add(shaftMesh);
        arrow.add(headMesh);

        // Rotate arrow to point in axis direction
        const upVector = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(upVector, axisDirection);
        arrow.quaternion.copy(quaternion);

        const axisGroup = new THREE.Group();
        axisGroup.add(arrow);

        // Add rotation direction indicator (green arc arrow)
        const rotationIndicator = CoordinateAxesManager.createRotationIndicator(axisDirection, arrowLength);
        axisGroup.add(rotationIndicator);

        return axisGroup;
    }

    /**
     * Static method: Create rotation direction indicator (arc arrow)
     * @param {THREE.Vector3} axisDirection - Direction of joint axis
     * @param {number} baseLength - Length of the arrow for sizing
     * @returns {THREE.Group} Rotation indicator group
     */
    static createRotationIndicator(axisDirection, baseLength) {
        const group = new THREE.Group();
        const radius = baseLength * 0.25;
        const tubeRadius = 0.002;
        const arrowSize = 0.008;
        const color = 0x00ff00; // Green

        // Create arc curve (positive rotation direction, right-hand rule)
        const arcAngle = Math.PI * 1.5; // Arc span 270 degrees
        const curve = new THREE.EllipseCurve(
            0, 0,
            radius, radius,
            0, arcAngle,
            false,
            0
        );

        // Generate arc path points
        const points = curve.getPoints(50);
        const points3D = points.map(p => new THREE.Vector3(p.x, p.y, 0));

        // Create tube geometry
        const curvePath = new THREE.CatmullRomCurve3(points3D);
        const tubeGeometry = new THREE.TubeGeometry(curvePath, 50, tubeRadius, 8, false);
        const tubeMaterial = new THREE.MeshBasicMaterial({ color: color });
        const tubeMesh = new THREE.Mesh(tubeGeometry, tubeMaterial);
        group.add(tubeMesh);

        // Create arrow at arc end (cone)
        const coneGeometry = new THREE.ConeGeometry(arrowSize, arrowSize * 2, 8);
        const coneMaterial = new THREE.MeshBasicMaterial({ color: color });
        const coneMesh = new THREE.Mesh(coneGeometry, coneMaterial);

        // Calculate arrow position and direction
        const endPoint = points3D[points3D.length - 1];
        const preEndPoint = points3D[points3D.length - 5];
        const tangent = new THREE.Vector3().subVectors(endPoint, preEndPoint).normalize();

        coneMesh.position.copy(endPoint);
        coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
        group.add(coneMesh);

        // Rotate entire arc arrow so it's perpendicular to axis direction
        const rotQuat = new THREE.Quaternion();
        rotQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisDirection);
        group.quaternion.copy(rotQuat);

        // Place arc near axis arrow
        const position = axisDirection.clone().multiplyScalar(baseLength * 0.85);
        group.position.copy(position);

        return group;
    }

    /**
     * Create coordinate axes for a link
     */
    createLinkAxes(link, linkName, modelSize = 1.0) {
        // Calculate actual size of current link
        let linkSize = modelSize; // Default use entire model size

        try {
            if (link.threeObject) {
                link.threeObject.updateMatrixWorld(true);
                const bbox = new THREE.Box3().setFromObject(link.threeObject);
                if (!bbox.isEmpty()) {
                    const size = bbox.getSize(new THREE.Vector3());
                    const maxDim = Math.max(size.x, size.y, size.z);
                    if (maxDim > 0.001) { // Ensure size is valid (greater than 1mm)
                        linkSize = maxDim;
                    }
                }
            }
        } catch (error) {
            // Failed to calculate Link size, using default
        }

        // Dynamically adjust axis length based on link size
        // Axis length = 25% of link size, minimum 3cm, maximum 50cm
        const axesSize = Math.max(0.03, Math.min(linkSize * 0.25, 0.5));
        const axesGroup = new THREE.Group();
        axesGroup.name = `${linkName}_axes`;
        axesGroup.userData.excludeFromBounds = true;

        // Create three axes, thickness proportional to length
        const axisRadius = Math.max(0.001, axesSize * 0.015); // 1.5% of length, minimum 1mm
        const axisGeometry = new THREE.CylinderGeometry(axisRadius, axisRadius, axesSize, 8);

        // X axis (red) - using lit material
        const xAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0xff0000,
            shininess: 30,
            depthTest: true
        });
        const xAxis = new THREE.Mesh(axisGeometry, xAxisMaterial);
        xAxis.position.x = axesSize / 2;
        xAxis.rotation.z = -Math.PI / 2;
        xAxis.castShadow = false;
        xAxis.receiveShadow = false;
        axesGroup.add(xAxis);

        // Y axis (green) - using lit material
        const yAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0x00ff00,
            shininess: 30,
            depthTest: true
        });
        const yAxis = new THREE.Mesh(axisGeometry, yAxisMaterial);
        yAxis.position.y = axesSize / 2;
        yAxis.castShadow = false;
        yAxis.receiveShadow = false;
        axesGroup.add(yAxis);

        // Z axis (blue) - using lit material
        const zAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0x0000ff,
            shininess: 30,
            depthTest: true
        });
        const zAxis = new THREE.Mesh(axisGeometry, zAxisMaterial);
        zAxis.position.z = axesSize / 2;
        zAxis.rotation.x = Math.PI / 2;
        zAxis.castShadow = false;
        zAxis.receiveShadow = false;
        axesGroup.add(zAxis);

        // Add to link's threeObject
        if (link.threeObject) {
            link.threeObject.add(axesGroup);
        }

        // Save reference
        this.linkAxesHelpers.set(linkName, axesGroup);

        // Decide whether to show based on current setting
        axesGroup.visible = this.showAxesEnabled;

        return axesGroup;
    }

    /**
     * Create joint axis visualization (large red arrow)
     */
    createJointAxis(joint, jointName) {
        if (!joint.threeObject || (joint.type !== 'revolute' && joint.type !== 'continuous')) {
            return null; // Only create axis for revolute joints
        }

        const jointObject = joint.threeObject;

        // Create joint axis helper (arrow)
        const axisGroup = new THREE.Group();
        axisGroup.name = `jointAxis_${jointName}`;

        // Get joint rotation axis direction (local coordinate system)
        let localAxisDirection = new THREE.Vector3(0, 0, 1); // Default Z axis

        // Prefer getting axis from urdf-loader's joint object
        if (jointObject.axis) {
            localAxisDirection.copy(jointObject.axis).normalize();
        } else if (joint.axis && joint.axis.xyz) {
            localAxisDirection.set(
                joint.axis.xyz[0] || 0,
                joint.axis.xyz[1] || 0,
                joint.axis.xyz[2] !== undefined ? joint.axis.xyz[2] : 1
            ).normalize();
        }

        // Create a long arrow representing rotation axis
        const arrowLength = 0.2;  // Arrow total length (reduced to half)
        const shaftLength = arrowLength * 0.7;  // Shaft length
        const headLength = arrowLength * 0.3;   // Arrow head length
        const shaftRadius = 0.004;  // Shaft radius (reduced to half)
        const headRadius = 0.012;   // Arrow head radius (reduced to half)
        const arrowColor = 0xff0000; // Red

        const arrowMaterial = new THREE.MeshBasicMaterial({ color: arrowColor });

        // 1. Create shaft (cylinder)
        const shaftGeometry = new THREE.CylinderGeometry(
            shaftRadius, shaftRadius, shaftLength, 16, 1
        );
        const shaftMesh = new THREE.Mesh(shaftGeometry, arrowMaterial);

        // 2. Create arrow head (cone)
        const headGeometry = new THREE.ConeGeometry(headRadius, headLength, 32, 1);
        const headMesh = new THREE.Mesh(headGeometry, arrowMaterial);

        // 3. Assemble arrow (in local coordinate system, along Y axis)
        const arrow = new THREE.Group();
        shaftMesh.position.y = shaftLength / 2;
        arrow.add(shaftMesh);
        headMesh.position.y = shaftLength + headLength / 2;
        arrow.add(headMesh);

        // 4. Rotate arrow to align with joint axis direction (local coordinates)
        const upVector = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(upVector, localAxisDirection);
        arrow.quaternion.copy(quaternion);

        axisGroup.add(arrow);

        // 5. Create rotation direction indicator (arc arrow)
        const rotationIndicator = this.createRotationIndicator(localAxisDirection, arrowLength);
        axisGroup.add(rotationIndicator);

        // Save reference (but don't add to scene yet)
        this.jointAxesHelpers.set(jointName, {
            mesh: axisGroup,
            parent: jointObject,  // Add to joint object so it follows joint movement
            joint: joint,
            isAttached: false
        });

        // Decide whether to add to scene based on current setting
        if (this.showJointAxesEnabled) {
            jointObject.add(axisGroup);
            this.jointAxesHelpers.get(jointName).isAttached = true;
        }
        return axisGroup;
    }

    /**
     * Create rotation direction indicator (arc arrow)
     */
    createRotationIndicator(axisDirection, baseLength) {
        const group = new THREE.Group();
        const radius = baseLength * 0.25; // Arc radius (reduced, closer to axis)
        const tubeRadius = 0.002; // Arc line thickness (thinner)
        const arrowSize = 0.008; // Arrow size (smaller)
        const color = 0x00ff00; // Green

        // Create arc curve (positive rotation direction, right-hand rule)
        const arcAngle = Math.PI * 1.5; // Arc span 270 degrees (3/4 circle)
        const curve = new THREE.EllipseCurve(
            0, 0,            // Center point
            radius, radius,  // x radius, y radius
            0, arcAngle,     // Start angle, end angle
            false,           // Clockwise
            0                // Rotation
        );

        // Generate arc path points
        const points = curve.getPoints(50);
        const points3D = points.map(p => new THREE.Vector3(p.x, p.y, 0));

        // Create tube geometry (TubeGeometry)
        const curvePath = new THREE.CatmullRomCurve3(points3D);
        const tubeGeometry = new THREE.TubeGeometry(curvePath, 50, tubeRadius, 8, false);
        const tubeMaterial = new THREE.MeshBasicMaterial({ color: color });
        const tubeMesh = new THREE.Mesh(tubeGeometry, tubeMaterial);
        group.add(tubeMesh);

        // Create arrow at arc end (cone)
        const coneGeometry = new THREE.ConeGeometry(arrowSize, arrowSize * 2, 8);
        const coneMaterial = new THREE.MeshBasicMaterial({ color: color });
        const coneMesh = new THREE.Mesh(coneGeometry, coneMaterial);

        // Calculate arrow position and direction
        const endPoint = points3D[points3D.length - 1];
        const preEndPoint = points3D[points3D.length - 5]; // Slightly earlier point
        const tangent = new THREE.Vector3().subVectors(endPoint, preEndPoint).normalize();

        coneMesh.position.copy(endPoint);
        coneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
        group.add(coneMesh);

        // Rotate entire arc arrow so it's perpendicular to axis direction and around axis
        // First find a vector perpendicular to axis
        const perpVector = new THREE.Vector3();
        if (Math.abs(axisDirection.y) < 0.9) {
            perpVector.set(0, 1, 0);
        } else {
            perpVector.set(1, 0, 0);
        }
        perpVector.crossVectors(axisDirection, perpVector).normalize();

        // Create rotation quaternion, make arc plane perpendicular to axis direction
        const rotQuat = new THREE.Quaternion();
        rotQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisDirection);
        group.quaternion.copy(rotQuat);

        // Place arc near axis arrow (closer to arrow tip)
        const position = axisDirection.clone().multiplyScalar(baseLength * 0.85);
        group.position.copy(position);

        return group;
    }

    /**
     * Show all link axes
     */
    showAllAxes() {
        this.showAxesEnabled = true;

        // Show all link axes
        this.linkAxesHelpers.forEach((axes) => {
            axes.visible = true;
        });    }

    /**
     * Hide all link axes
     */
    hideAllAxes() {
        this.showAxesEnabled = false;

        // Hide all link axes
        this.linkAxesHelpers.forEach((axes) => {
            axes.visible = false;
        });    }

    /**
     * Show all joint axes
     */
    showAllJointAxes() {
        this.showJointAxesEnabled = true;

        // Show all joint axes (add to scene)
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (!axisInfo.isAttached && axisInfo.parent) {
                axisInfo.parent.add(axisInfo.mesh);
                axisInfo.isAttached = true;
            }
        });    }

    /**
     * Hide all joint axes
     */
    hideAllJointAxes() {
        this.showJointAxesEnabled = false;

        // Hide all joint axes (remove from scene)
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (axisInfo.isAttached && axisInfo.parent) {
                axisInfo.parent.remove(axisInfo.mesh);
                axisInfo.isAttached = false;
            }
        });    }

    /**
     * Temporarily show only specified joint axis (for slider drag/model drag)
     */
    showOnlyJointAxis(joint) {
        // Hide all joint axes
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (axisInfo.isAttached && axisInfo.parent) {
                axisInfo.parent.remove(axisInfo.mesh);
                axisInfo.isAttached = false;
            }
        });

        // Show specified joint axis (regardless of switch state)
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (axisInfo.joint === joint) {
                if (!axisInfo.isAttached && axisInfo.parent) {
                    axisInfo.parent.add(axisInfo.mesh);
                    axisInfo.isAttached = true;
                }
            }
        });
    }

    /**
     * Restore all joint axes display (called after slider drag ends)
     */
    restoreAllJointAxes() {
        // Hide all joint axes
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (axisInfo.isAttached && axisInfo.parent) {
                axisInfo.parent.remove(axisInfo.mesh);
                axisInfo.isAttached = false;
            }
        });

        // If joint axes switch is on, show all axes
        if (this.showJointAxesEnabled) {
            this.jointAxesHelpers.forEach((axisInfo, jointName) => {
                if (!axisInfo.isAttached && axisInfo.parent) {
                    axisInfo.parent.add(axisInfo.mesh);
                    axisInfo.isAttached = true;
                }
            });
        }
    }

    /**
     * Ensure axes don't cast shadows
     */
    ensureAxesNoShadow() {
        // Ensure link axes don't cast shadows
        this.linkAxesHelpers.forEach((axes) => {
            axes.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = false;
                    child.receiveShadow = false;
                }
            });
        });

        // Ensure joint axes don't cast shadows
        this.jointAxesHelpers.forEach((axisInfo) => {
            axisInfo.mesh.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = false;
                    child.receiveShadow = false;
                }
            });
        });
    }

    /**
     * Clear all link axes
     */
    clearAllLinkAxes() {
        this.linkAxesHelpers.forEach((axes, linkName) => {
            if (axes.parent) {
                axes.parent.remove(axes);
            }
        });
        this.linkAxesHelpers.clear();
    }

    /**
     * Clear all joint axes
     */
    clearAllJointAxes() {
        this.jointAxesHelpers.forEach((axisInfo, jointName) => {
            if (axisInfo.isAttached && axisInfo.parent) {
                axisInfo.parent.remove(axisInfo.mesh);
            }
        });
        this.jointAxesHelpers.clear();
    }

    /**
     * Clear all axes
     */
    clear() {
        this.clearAllLinkAxes();
        this.clearAllJointAxes();
    }
}
