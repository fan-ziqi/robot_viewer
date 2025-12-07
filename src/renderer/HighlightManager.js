import * as THREE from 'three';

/**
 * HighlightManager - Handles link highlighting and hover information display
 */
export class HighlightManager {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.currentHighlightedLink = null;

        // Highlight material
        this.highlightMaterial = new THREE.MeshPhongMaterial({
            shininess: 10,
            color: 0xffffff,
            emissive: 0xffffff,
            emissiveIntensity: 0.25
        });
    }

    /**
     * Highlight link (based on link selection, not joint)
     */
    highlightLink(link, currentModel) {
        if (!link) return;

        // If already highlighted the same link, return directly (use name comparison)
        if (this.currentHighlightedLink && this.currentHighlightedLink.name === link.name) {
            return;
        }

        // If there's a previously highlighted link, unhighlight it first
        if (this.currentHighlightedLink) {
            this.unhighlightLink(this.currentHighlightedLink, currentModel);
        }

        // Record currently highlighted link
        this.currentHighlightedLink = link;

        // Highlight all meshes of the link (including child links connected via fixed joints)
        if (link.threeObject) {
            this.highlightLinkGeometry(link.threeObject, currentModel);
        }

        // Show hover info
        this.showHoverInfo(link, currentModel);

        // Trigger redraw immediately
        this.sceneManager.redraw();
    }

    /**
     * Unhighlight link
     */
    unhighlightLink(link, currentModel) {
        if (!link) return;

        // Clear current highlighted link record (use name comparison)
        if (this.currentHighlightedLink && this.currentHighlightedLink.name === link.name) {
            this.currentHighlightedLink = null;
        }

        // Only restore materials for current link (including child links connected via fixed joints)
        if (link.threeObject) {
            this.unhighlightLinkGeometry(link.threeObject, currentModel);
        }

        // Hide hover info
        this.hideHoverInfo();

        // Trigger redraw immediately
        this.sceneManager.redraw();
    }

    /**
     * Highlight link geometry
     */
    highlightLinkGeometry(linkObject, currentModel) {
        // Traverse current link and its fixed child links
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

            // Process mesh
            if (obj.type === 'Mesh' || obj.isMesh) {
                // Skip collision mesh and auxiliary visualization objects
                if (obj.isURDFCollider || obj.userData?.isCollision || this.isAuxiliaryVisualization(obj)) {
                    return;
                }

                if (!obj.__origMaterial) {
                    obj.__origMaterial = obj.material;
                }
                obj.material = this.highlightMaterial;
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
     * Unhighlight link geometry
     */
    unhighlightLinkGeometry(linkObject, currentModel) {
        // Traverse current link and its fixed child links
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

            // Process mesh
            if (obj.type === 'Mesh' || obj.isMesh) {
                if (this.isAuxiliaryVisualization(obj)) {
                    return;
                }

                if (obj.__origMaterial) {
                    obj.material = obj.__origMaterial;
                    delete obj.__origMaterial;
                }
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
        // Check userData markers
        if (obj.userData?.isInertiaBox) return true;
        if (obj.userData?.isCOMMarker) return true;
        if (obj.userData?.isCenterOfMass) return true;
        if (obj.userData?.isCollision) return true;

        return false;
    }

    /**
     * Show hover information (Link name, parent Joint name, mass, pose)
     */
    showHoverInfo(link, currentModel) {
        const hoverInfo = document.getElementById('hover-info');
        const jointNameEl = document.getElementById('hover-joint-name');
        const linkNameEl = document.getElementById('hover-link-name');
        const linkMassEl = document.getElementById('hover-link-mass');
        const linkPoseEl = document.getElementById('hover-link-pose');

        if (!hoverInfo || !jointNameEl || !linkNameEl || !linkMassEl || !linkPoseEl) return;

        // Line 1: Display Link name
        linkNameEl.textContent = `Link: ${link.name || 'Unknown'}`;

        // Line 2: Display parent Joint name (skip fixed joints, find the actual joint controlling this link)
        let parentJointName = 'None (Base Link)';
        let parentJointType = '';  // Save joint type

        // Use same logic to find movable parent joint
        let currentLink = link.threeObject;
        while (currentLink) {
            const parentObject = currentLink.parent;

            if (parentObject && (parentObject.type === 'URDFJoint' || parentObject.isURDFJoint)) {
                const jointName = parentObject.name;
                if (jointName && currentModel?.joints && currentModel.joints.has(jointName)) {
                    const joint = currentModel.joints.get(jointName);

                    // If it's a movable joint, display it
                    if (joint.type !== 'fixed') {
                        parentJointName = jointName;
                        parentJointType = joint.type;  // Save joint type
                        break;
                    }

                    // If it's a fixed joint, continue searching upward
                    const parentLink = parentObject.parent;
                    if (parentLink && (parentLink.type === 'URDFLink' || parentLink.isURDFLink)) {
                        currentLink = parentLink;
                        continue;
                    }
                }
            }

            break;
        }

        // Display joint name, add type in parentheses if available
        if (parentJointType) {
            jointNameEl.textContent = `Joint: ${parentJointName} (${parentJointType})`;
        } else {
            jointNameEl.textContent = `Joint: ${parentJointName}`;
        }

        // Line 3: Display mass (including all child links connected via fixed joints)
        let totalMass = 0;
        let hasMass = false;
        let mergedLinks = [];  // Collect all merged link names

        // Recursively calculate mass of all fixed child links
        const calculateTotalMass = (linkObj, isRoot = true) => {
            // Get current link's mass and name
            const linkName = linkObj.name;
            if (linkName && currentModel?.links && currentModel.links.has(linkName)) {
                const linkData = currentModel.links.get(linkName);

                // Record link name (root link handled separately)
                if (!isRoot) {
                    mergedLinks.push(linkName);
                }

                // Accumulate mass
                if (linkData.inertial && linkData.inertial.mass !== undefined && linkData.inertial.mass > 0) {
                    totalMass += linkData.inertial.mass;
                    hasMass = true;
                }
            }

            // Traverse child objects, find child links connected via fixed joints
            for (const child of linkObj.children) {
                if (child.isURDFJoint || child.type === 'URDFJoint') {
                    const jointName = child.name;
                    if (jointName && currentModel?.joints && currentModel.joints.has(jointName)) {
                        const joint = currentModel.joints.get(jointName);

                        // If it's a fixed joint, continue accumulating child link's mass
                        if (joint.type === 'fixed') {
                            for (const grandChild of child.children) {
                                if (grandChild.type === 'URDFLink' || grandChild.isURDFLink) {
                                    calculateTotalMass(grandChild, false);
                                }
                            }
                        }
                    }
                }
            }
        };

        // Start calculating total mass from current link
        calculateTotalMass(link.threeObject, true);

        if (hasMass) {
            linkMassEl.textContent = `Mass: ${totalMass.toFixed(4)} kg`;
        } else {
            linkMassEl.textContent = 'Mass: N/A';
        }

        // Line 4: Display merged links (if any)
        const mergedLinksEl = document.getElementById('hover-merged-links');
        if (mergedLinksEl) {
            if (mergedLinks.length > 0) {
                mergedLinksEl.textContent = `Includes: ${mergedLinks.join(', ')}`;
                mergedLinksEl.style.display = 'block';
            } else {
                mergedLinksEl.style.display = 'none';
            }
        }

        // Line 5: Display link position and orientation
        if (linkPoseEl && link.threeObject) {
            const linkPos = new THREE.Vector3();
            const linkQuat = new THREE.Quaternion();
            const linkEuler = new THREE.Euler();

            link.threeObject.getWorldPosition(linkPos);
            link.threeObject.getWorldQuaternion(linkQuat);
            linkEuler.setFromQuaternion(linkQuat, 'XYZ');
            
            const num_sig_figs = 4; // Decimals to display
            const quatX = linkQuat.x.toFixed(num_sig_figs);
            const quatY = linkQuat.y.toFixed(num_sig_figs);
            const quatZ = linkQuat.z.toFixed(num_sig_figs);
            const quatW = linkQuat.w.toFixed(num_sig_figs);

            const rollRad = linkEuler.x.toFixed(num_sig_figs);
            const pitchRad = linkEuler.y.toFixed(num_sig_figs);
            const yawRad = linkEuler.z.toFixed(num_sig_figs);

            const rollDeg = THREE.MathUtils.radToDeg(linkEuler.x).toFixed(num_sig_figs);
            const pitchDeg = THREE.MathUtils.radToDeg(linkEuler.y).toFixed(num_sig_figs);
            const yawDeg = THREE.MathUtils.radToDeg(linkEuler.z).toFixed(num_sig_figs);

            const positionBlock = 
                `• Position (world):\n` +
                `    \tx = ${linkPos.x.toFixed(num_sig_figs)} m\n` +
                `    \ty = ${linkPos.y.toFixed(num_sig_figs)} m\n` +
                `    \tz = ${linkPos.z.toFixed(num_sig_figs)} m\n`;
            const orientationBlock = 
            `• Orientation (world):\n` +
            `   Quat: x=${quatX} y=${quatY} z=${quatZ} w=${quatW}\n` +
            `   RPY (deg): r=${rollRad} p=${pitchRad} y=${yawRad}\n` +
            `   RPY (rad): r=${rollDeg} p=${pitchDeg} y=${yawDeg}\n`;

            linkPoseEl.textContent = positionBlock + orientationBlock;
            linkPoseEl.style.display = 'block';
        } else if (linkPoseEl) {
            linkPoseEl.textContent = 'Link pose: N/A';
            linkPoseEl.style.display = 'block';
        }

        // Show tooltip
        hoverInfo.classList.add('visible');
    }

    /**
     * Hide hover information
     */
    hideHoverInfo() {
        const hoverInfo = document.getElementById('hover-info');
        if (hoverInfo) {
            hoverInfo.classList.remove('visible');
        }
    }

    /**
     * Clear all highlights
     */
    clearHighlight() {
        // Clear link highlight
        if (this.currentHighlightedLink) {
            this.unhighlightLink(this.currentHighlightedLink, this.sceneManager.currentModel);
        }
    }
}

