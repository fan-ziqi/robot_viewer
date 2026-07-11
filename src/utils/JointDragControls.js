import * as THREE from 'three';
import { MathUtils } from './MathUtils.js';
import { setRayFromCamera } from './pickRay.js';

/**
 * Universal joint drag control system
 * Supports URDF, MJCF, USD and other formats
 */

/**
 * Check if object is a joint (for URDF special cases)
 */
function isURDFJoint(obj) {
    return obj && obj.isURDFJoint && obj.jointType !== 'fixed';
}

/**
 * Find the Link that the clicked object belongs to
 * Traverse upward from clicked mesh to find first URDFLink object
 * Simple and direct, no merge logic
 */
function findParentLink(hitObject, model) {
    if (!model || !model.threeObject) {
        return null;
    }

    let current = hitObject;
    const modelRoot = model.threeObject;

    // Traverse upward to find first URDFLink object
    while (current) {
        // Check if is URDFLink
        if (current.type === 'URDFLink' || current.isURDFLink) {
            const linkName = current.name;
            if (linkName && model.links && model.links.has(linkName)) {
                const linkData = model.links.get(linkName);
                // Return information including link data and Three.js object
                return {
                    linkData: linkData,
                    threeObject: current,
                    name: linkName
                };
            }
        }

        // If reached model root node, stop searching
        if (current === modelRoot || !current.parent) {
            break;
        }

        current = current.parent;
    }

    return null;
}

/**
 * Find parent joint of Link (for drag rotation)
 * Skip fixed joints, find first movable joint
 */
function findParentJoint(link, model) {
    if (!link || !link.threeObject || !model.joints) {
        return null;
    }

    let currentLink = link.threeObject;

    // Search upward, skip fixed joints
    while (currentLink) {
        const parentObject = currentLink.parent;

        // If parent object is joint
        if (parentObject && (parentObject.type === 'URDFJoint' || parentObject.isURDFJoint)) {
            const jointName = parentObject.name;
            if (jointName && model.joints.has(jointName)) {
                const joint = model.joints.get(jointName);

                // If movable joint, return it
                if (joint.type !== 'fixed') {
                    return joint;
                }

                // If fixed joint, continue searching upward
                // Find this joint's parent link
                const parentLink = parentObject.parent;
                if (parentLink && (parentLink.type === 'URDFLink' || parentLink.isURDFLink)) {
                    currentLink = parentLink;
                    continue;
                }
            }
        }

        // No parent joint or reached root node
        break;
    }

    return null;
}

const prevHitPoint = new THREE.Vector3();
const newHitPoint = new THREE.Vector3();
const pivotPoint = new THREE.Vector3();
const tempVector = new THREE.Vector3();
const tempVector2 = new THREE.Vector3();
const projectedStartPoint = new THREE.Vector3();
const projectedEndPoint = new THREE.Vector3();
const plane = new THREE.Plane();

/**
 * Universal joint drag controller base class
 */
export class JointDragControls {
    constructor(scene, camera, domElement, model) {
        this.enabled = true;
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        this.model = model;
        this.raycaster = new THREE.Raycaster();
        // Allow raycasting to detect invisible objects (for when visual is hidden)
        this.raycaster.layers.enableAll();
        this.initialGrabPoint = new THREE.Vector3();
        this.hitDistance = -1;
        this.hovered = null;
        this.manipulating = null;
        this.renderer = null;
    }

    update() {
        const { raycaster, hovered, manipulating } = this;
        const model = this.model;

        if (manipulating || !this.enabled || !model || !model.threeObject) {
            return;
        }

        let hoveredLink = null;

        // Temporarily store and enable visibility for visual meshes to allow raycasting
        const hiddenMeshes = [];
        model.threeObject.traverse((child) => {
            if (child.isMesh && !child.visible) {
                // Check if it's a visual mesh (not collision)
                let isInCollider = false;
                let checkNode = child;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }
                if (!isInCollider) {
                    child.visible = true;
                    hiddenMeshes.push(child);
                }
            }
        });

        // Only detect robot model, not entire scene
        const intersections = raycaster.intersectObject(model.threeObject, true);

        // Restore visibility
        hiddenMeshes.forEach(mesh => {
            mesh.visible = false;
        });

        // Filter out collision meshes (but allow invisible visual meshes for interaction)
        const validIntersections = intersections.filter(intersect => {
            const obj = intersect.object;
            // Skip collision meshes
            if (obj.isURDFCollider || obj.userData?.isCollision || obj.userData?.isCollisionGeom) {
                return false;
            }
            // Check if object is in collision hierarchy
            let isInCollider = false;
            let checkNode = obj;
            while (checkNode) {
                if (checkNode.isURDFCollider) {
                    isInCollider = true;
                    break;
                }
                checkNode = checkNode.parent;
            }
            if (isInCollider) {
                return false;
            }
            // Allow all visual meshes
            return obj.isMesh;
        });

        // Like urdf-loaders, only detect first intersecting object (closest)
        if (validIntersections.length !== 0) {
            const hit = validIntersections[0];
            hoveredLink = findParentLink(hit.object, model);

            if (hoveredLink) {
                this.hitDistance = hit.distance;
                this.initialGrabPoint.copy(hit.point);
            }
        }

        // Only trigger callback when hovered object actually changes (avoid duplicate highlighting)
        // Use name comparison because findParentLink returns new object each time
        const hoveredName = hoveredLink?.name || null;
        const currentHoveredName = hovered?.name || null;

        if (hoveredName !== currentHoveredName) {
            if (hovered) {
                this.onUnhover(hovered);
            }
            this.hovered = hoveredLink;
            if (hoveredLink) {
                this.onHover(hoveredLink);
            }
        } else if (hoveredLink && hovered) {
            // Even for same link, update object reference (keep latest object)
            this.hovered = hoveredLink;
        }
    }

    updateJoint(joint, angle) {
        // joint is unified model Joint object, need to update via onUpdateJoint callback
        if (this.onUpdateJoint) {
            this.onUpdateJoint(joint, angle);
        }
    }

    onDragStart(link) {
        // Subclasses can override, parameter is dragged link
    }

    onDragEnd(link) {
        // Subclasses can override, parameter is dragged link
    }

    onHover(link) {
        // Subclasses can override, parameter is hovered link
    }

    onUnhover(link) {
        // Subclasses can override, parameter is link leaving hover
    }

    /**
     * Get joint axis vector (universal method)
     */
    getJointAxis(joint) {
        // Prefer getting axis from threeObject
        if (joint.threeObject) {
            // URDF: joint.threeObject.axis (Vector3)
            if (joint.threeObject.axis instanceof THREE.Vector3) {
                return joint.threeObject.axis.clone();
            }
            // Other formats may have different structures
        }

        // Use unified model axis data
        if (joint.axis && joint.axis.xyz) {
            return MathUtils.xyzToVector3(joint.axis.xyz);
        }

        // Default z-axis
        return new THREE.Vector3(0, 0, 1);
    }

    /**
     * Get joint's Three.js object (for matrix transformations)
     */
    getJointThreeObject(joint) {
        return joint.threeObject;
    }

    /**
     * Get joint current value (universal method)
     */
    getJointCurrentValue(joint) {
        // Prefer getting from threeObject
        if (joint.threeObject) {
            // URDF: joint.threeObject.angle
            if (joint.threeObject.angle !== undefined) {
                return joint.threeObject.angle;
            }
            // URDF: joint.threeObject.jointValue[0]
            if (joint.threeObject.jointValue && joint.threeObject.jointValue.length > 0) {
                return joint.threeObject.jointValue[0];
            }
        }

        // Use unified model currentValue
        return joint.currentValue !== undefined ? joint.currentValue : 0;
    }

    getRevoluteDelta(joint, startPoint, endPoint) {
        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) {
            return 0;
        }

        const axis = this.getJointAxis(joint);

        tempVector
            .copy(axis)
            .transformDirection(jointObj.matrixWorld)
            .normalize();
        pivotPoint
            .set(0, 0, 0)
            .applyMatrix4(jointObj.matrixWorld);
        plane
            .setFromNormalAndCoplanarPoint(tempVector, pivotPoint);

        // project the drag points onto the plane
        plane.projectPoint(startPoint, projectedStartPoint);
        plane.projectPoint(endPoint, projectedEndPoint);

        // get the directions relative to the pivot
        projectedStartPoint.sub(pivotPoint);
        projectedEndPoint.sub(pivotPoint);

        tempVector.crossVectors(projectedStartPoint, projectedEndPoint);

        const dot = tempVector.dot(plane.normal);
        const direction = Math.sign(dot);
        const angle = projectedEndPoint.angleTo(projectedStartPoint);
        const delta = direction * angle;

        return delta;
    }

    getPrismaticDelta(joint, startPoint, endPoint) {
        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) return 0;

        tempVector.subVectors(endPoint, startPoint);
        const axis = this.getJointAxis(joint);

        plane.normal
            .copy(axis)
            .transformDirection(jointObj.parent?.matrixWorld || new THREE.Matrix4())
            .normalize();

        return tempVector.dot(plane.normal);
    }

    moveRay(toRay) {
        const { raycaster, hitDistance, manipulating } = this;
        const { ray } = raycaster;

        if (manipulating) {
            ray.at(hitDistance, prevHitPoint);
            toRay.at(hitDistance, newHitPoint);

            let delta = 0;
            const jointType = manipulating.type;

            if (jointType === 'revolute' || jointType === 'continuous') {
                delta = this.getRevoluteDelta(manipulating, prevHitPoint, newHitPoint);
            } else if (jointType === 'prismatic') {
                delta = this.getPrismaticDelta(manipulating, prevHitPoint, newHitPoint);
            }

            if (delta) {
                const currentValue = this.getJointCurrentValue(manipulating);
                let newAngle = currentValue + delta;

                // Apply limits
                if (manipulating.limits) {
                    const ignoreLimits = this.model?.userData?.ignoreLimits || this.model?.threeObject?.userData?.ignoreLimits || false;
                    if (!ignoreLimits) {
                        newAngle = Math.max(manipulating.limits.lower, Math.min(manipulating.limits.upper, newAngle));
                    }
                }

                this.updateJoint(manipulating, newAngle);
            }
        }

        this.raycaster.ray.copy(toRay);
        this.update();
    }

    setGrabbed(grabbed) {
        const { hovered, manipulating } = this;

        if (grabbed) {
            if (manipulating !== null || hovered === null) {
                return;
            }

            // hovered is now a link object, need to find its parent joint for dragging
            const parentJoint = findParentJoint(hovered, this.model);

            if (parentJoint) {
                // Has parent joint, can drag to rotate
                this.manipulating = parentJoint;
                this.manipulatingLink = hovered; // Save the link being manipulated
                this.onDragStart(hovered);  // Callback passes link
            } else {
                // No parent joint (base link or fixed link), cannot drag, but still trigger event
                // This disables orbit controller to avoid conflicts
                this.manipulatingLink = hovered;
                this.onDragStart(hovered);
            }
        } else {
            if (this.manipulating === null && !this.manipulatingLink) {
                return;
            }
            this.onDragEnd(this.manipulatingLink || hovered);  // Callback passes link
            this.manipulating = null;
            this.manipulatingLink = null;
            this.update();
        }
    }
}

/**
 * Pointer-based joint drag controller
 */
export class PointerJointDragControls extends JointDragControls {
    constructor(scene, camera, domElement, model) {
        super(scene, camera, domElement, model);
        this.camera = camera;
        this.domElement = domElement;

        // Create local raycaster for mouse events (critical fix!)
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        const updateMouse = (e) => {
            // Use getBoundingClientRect() to get more accurate coordinates
            const rect = domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };

        this._mouseDown = e => {
            if (e.button !== 0) return;
            updateMouse(e);
            setRayFromCamera(raycaster, mouse, this.camera);

            // Only grab if actually clicking on the model
            // Check if ray intersects with the model before disabling camera controls
            if (!this.model || !this.model.threeObject) return;

            // Temporarily store and enable visibility for visual meshes to allow raycasting
            const hiddenMeshes = [];
            this.model.threeObject.traverse((child) => {
                if (child.isMesh && !child.visible) {
                    // Check if it's a visual mesh (not collision)
                    let isInCollider = false;
                    let checkNode = child;
                    while (checkNode) {
                        if (checkNode.isURDFCollider) {
                            isInCollider = true;
                            break;
                        }
                        checkNode = checkNode.parent;
                    }
                    if (!isInCollider) {
                        child.visible = true;
                        hiddenMeshes.push(child);
                    }
                }
            });

            const intersections = raycaster.intersectObject(this.model.threeObject, true);

            // Restore visibility
            hiddenMeshes.forEach(mesh => {
                mesh.visible = false;
            });

            // Filter out collision meshes (but allow invisible visual meshes for interaction)
            const validIntersections = intersections.filter(intersect => {
                const obj = intersect.object;
                // Skip collision meshes
                if (obj.isURDFCollider || obj.userData?.isCollision || obj.userData?.isCollisionGeom) {
                    return false;
                }
                // Check if object is in collision hierarchy
                let isInCollider = false;
                let checkNode = obj;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }
                if (isInCollider) {
                    return false;
                }
                // Allow all visual meshes
                return obj.isMesh;
            });

            const hitLink = validIntersections.length > 0 ? findParentLink(validIntersections[0].object, this.model) : null;

            // Only set grabbed if we actually hit a visible link
            if (hitLink) {
                this.moveRay(raycaster.ray);
                this.setGrabbed(true);
            }
            // If not hitting model, don't grab - allow camera controls to work
        };

        this._mouseMove = e => {
            updateMouse(e);
            setRayFromCamera(raycaster, mouse, this.camera);
            this.moveRay(raycaster.ray);
        };

        this._mouseUp = e => {
            if (e.button !== 0) return;
            updateMouse(e);
            setRayFromCamera(raycaster, mouse, this.camera);
            this.moveRay(raycaster.ray);
            this.setGrabbed(false);
        };

        this._mouseLeave = () => {
            if (this.manipulating) {
                this.setGrabbed(false);
            }
            if (this.hovered) {
                this.onUnhover(this.hovered);
                this.hovered = null;
            }
        };

        domElement.addEventListener('mousedown', this._mouseDown);
        domElement.addEventListener('mousemove', this._mouseMove);
        domElement.addEventListener('mouseup', this._mouseUp);
        domElement.addEventListener('mouseleave', this._mouseLeave);
    }

    getRevoluteDelta(joint, startPoint, endPoint) {
        const { camera, initialGrabPoint } = this;

        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) return 0;

        const axis = this.getJointAxis(joint);

        tempVector
            .copy(axis)
            .transformDirection(jointObj.matrixWorld)
            .normalize();
        pivotPoint
            .set(0, 0, 0)
            .applyMatrix4(jointObj.matrixWorld);
        plane
            .setFromNormalAndCoplanarPoint(tempVector, pivotPoint);

        tempVector
            .copy(camera.position)
            .sub(initialGrabPoint)
            .normalize();

        // if looking into the plane of rotation
        if (Math.abs(tempVector.dot(plane.normal)) > 0.3) {
            return super.getRevoluteDelta(joint, startPoint, endPoint);
        } else {
            // get the up direction
            tempVector.set(0, 1, 0).transformDirection(camera.matrixWorld);

            // get points projected onto the plane of rotation
            plane.projectPoint(startPoint, projectedStartPoint);
            plane.projectPoint(endPoint, projectedEndPoint);

            tempVector.set(0, 0, -1).transformDirection(camera.matrixWorld);
            tempVector.cross(plane.normal);
            tempVector2.subVectors(endPoint, startPoint);

            return tempVector.dot(tempVector2);
        }
    }

    dispose() {
        const { domElement } = this;
        domElement.removeEventListener('mousedown', this._mouseDown);
        domElement.removeEventListener('mousemove', this._mouseMove);
        domElement.removeEventListener('mouseup', this._mouseUp);
        domElement.removeEventListener('mouseleave', this._mouseLeave);
    }
}

// For backward compatibility, export old names
export { JointDragControls as URDFDragControls, PointerJointDragControls as PointerURDFDragControls };

