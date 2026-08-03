/**
 * JointControlsUI - Joint control UI module
 * Responsible for creating and managing joint control sliders and input fields
 */
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { XMLUpdater } from '../utils/XMLUpdater.js';

export class JointControlsUI {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
        this.initialJointValues = new Map(); // Save initial joint positions when model loads
        this.codeEditorManager = null; // Code editor manager reference
        this.isUpdatingFromEditor = false; // Flag to prevent circular updates
        this.poseController = null;
        this.unsubscribePose = null;
    }

    setPoseController(poseController) {
        this.unsubscribePose?.();
        this.poseController = poseController;
        this.unsubscribePose = poseController?.subscribe((event) => {
            if (event.type === 'jointChanged') {
                this.updateJointDisplay(event.jointName, event.value);
            }
        });
    }

    updateJointDisplay(jointName, value) {
        const slider = Array.from(document.querySelectorAll('input[data-joint]'))
            .find((input) => input.dataset.joint === jointName);
        if (!slider) return;
        slider.value = value;
        const control = slider.closest('.joint-control');
        control?._updateDisplay?.();
    }

    /**
     * Set code editor manager reference
     */
    setCodeEditorManager(codeEditorManager) {
        this.codeEditorManager = codeEditorManager;
    }

    /**
     * Whether the joint moves along an axis (translation) instead of rotating.
     * URDF "prismatic" and MJCF "slide" joints are both normalized to 'prismatic'.
     */
    isTranslational(joint) {
        return joint && joint.type === 'prismatic';
    }

    /**
     * Display unit for a joint, depending on its type and the current unit toggle.
     * Translation: m / mm. Rotation: rad / °.
     */
    getJointUnit(joint) {
        if (this.isTranslational(joint)) {
            return this.angleUnit === 'deg' ? 'mm' : 'm';
        }
        return this.angleUnit === 'deg' ? '°' : 'rad';
    }

    /**
     * Number of decimals used when displaying a joint value.
     */
    getDisplayDecimals(joint) {
        if (this.isTranslational(joint)) {
            return this.angleUnit === 'deg' ? 1 : 3; // mm : m
        }
        return this.angleUnit === 'deg' ? 1 : 2; // ° : rad
    }

    /**
     * Convert an internal joint value (radians for rotation, meters for
     * translation) to the currently displayed unit.
     */
    toDisplayValue(joint, baseValue) {
        if (this.isTranslational(joint)) {
            return this.angleUnit === 'deg' ? baseValue * 1000 : baseValue; // m -> mm
        }
        return this.angleUnit === 'deg' ? baseValue * 180 / Math.PI : baseValue; // rad -> deg
    }

    /**
     * Convert a value entered in the displayed unit back to the internal value
     * (radians for rotation, meters for translation).
     */
    fromDisplayValue(joint, displayValue) {
        if (this.isTranslational(joint)) {
            return this.angleUnit === 'deg' ? displayValue / 1000 : displayValue; // mm -> m
        }
        return this.angleUnit === 'deg' ? displayValue * Math.PI / 180 : displayValue; // deg -> rad
    }

    /**
     * Update XML content in editor (URDF format only)
     */
    updateEditorXML(jointName, limits) {
        // If updating from editor, skip
        if (this.isUpdatingFromEditor) {
            return;
        }

        if (!this.codeEditorManager) {
            return;
        }

        const editor = this.codeEditorManager.getEditor();
        if (!editor) {
            return;
        }

        // Get current editor content
        const currentContent = editor.getValue();
        if (!currentContent || currentContent.trim().length === 0) {
            return;
        }

        // Check if URDF format (contains <robot> tag)
        if (!currentContent.includes('<robot')) {
            return;
        }

        // Set flag to prevent circular updates
        this.isUpdatingFromEditor = true;

        try {
            // Use XMLUpdater to update XML
            const updatedXML = XMLUpdater.updateURDFJointLimits(currentContent, jointName, limits);

            // If content changed, update editor
            if (updatedXML !== currentContent) {
                // Save cursor position
                const cursorPos = editor.view.state.selection.main.head;

                // Update content
                editor.setValue(updatedXML);

                // Restore cursor position (if possible)
                try {
                    const maxPos = editor.view.state.doc.length;
                    const newPos = Math.min(cursorPos, maxPos);
                    editor.view.dispatch({
                        selection: { anchor: newPos, head: newPos }
                    });
                } catch (e) {
                    // Ignore cursor restoration errors
                }
            }
        } catch (error) {
            console.error('Failed to update editor XML:', error);
        } finally {
            // Delay resetting flag to ensure editor onChange doesn't immediately trigger update
            setTimeout(() => {
                this.isUpdatingFromEditor = false;
            }, 100);
        }
    }

    /**
     * Setup joint controls
     */
    setupJointControls(model) {
        const container = document.getElementById('joint-controls');
        if (!container) return;

        container.innerHTML = '';

        if (!model || !model.joints || model.joints.size === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = window.i18n.t('noModel');
            container.appendChild(emptyState);
            return;
        }

        let controllableJoints = 0;
        model.joints.forEach((joint) => {
            if (joint.type !== 'fixed') {
                controllableJoints++;
            }
        });

        if (controllableJoints === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = window.i18n.t('noControllableJoints');
            container.appendChild(emptyState);
            return;
        }

        // Save initial joint values when model loads
        this.initialJointValues.clear();
        model.joints.forEach((joint, name) => {
            if (joint.type !== 'fixed') {
                const limits = joint.limits || {};
                const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                const upper = limits.upper !== undefined ? limits.upper : Math.PI;
                const initialValue = joint.currentValue !== undefined ? joint.currentValue : (lower + upper) / 2;
                this.initialJointValues.set(name, initialValue);
            }
        });

        model.joints.forEach((joint, name) => {
            if (joint.type === 'fixed') return;
            const control = this.createJointControl(joint, model);
            container.appendChild(control);
        });
    }

    /**
     * Create joint control element
     */
    createJointControl(joint, model) {
        const div = document.createElement('div');
        div.className = 'joint-control';
        // Tint only translation joints differently; rotation joints keep the default style
        if (this.isTranslational(joint)) {
            div.classList.add('joint-control--prismatic');
        }

        // First row: name + value
        const header = document.createElement('div');
        header.className = 'joint-header';

        const name = document.createElement('div');
        name.className = 'joint-name';
        name.textContent = joint.name;
        name.title = joint.name;

        header.appendChild(name);

        // Second row: editable limit labels + slider
        const sliderRow = document.createElement('div');
        sliderRow.className = 'joint-slider-row';

        const limits = joint.limits || {};
        let lower = limits.lower !== undefined ? limits.lower : -Math.PI;
        let upper = limits.upper !== undefined ? limits.upper : Math.PI;

        if (joint.type === 'continuous') {
            lower = -Math.PI;
            upper = Math.PI;
        }

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'joint-slider';
        slider.setAttribute('data-joint', joint.name);
        slider.min = lower;
        slider.max = upper;
        slider.step = (upper - lower) / 1000;

        let initialValue = joint.currentValue !== undefined ? joint.currentValue : (lower + upper) / 2;
        slider.value = initialValue;

        // Editable lower limit label
        const minLabel = document.createElement('input');
        minLabel.type = 'number';
        minLabel.className = 'joint-limit-min editable-limit';
        minLabel.step = '0.01';
        minLabel.title = window.i18n.t('clickToEditMin');

        // Editable upper limit label
        const maxLabel = document.createElement('input');
        maxLabel.type = 'number';
        maxLabel.className = 'joint-limit-max editable-limit';
        maxLabel.step = '0.01';
        maxLabel.title = window.i18n.t('clickToEditMax');

        // Predefine valueInput and valueUnit (for updateValueInput function)
        const valueInput = document.createElement('input');
        valueInput.type = 'number';
        valueInput.className = 'joint-value-input';
        valueInput.setAttribute('data-joint-input', joint.name);
        valueInput.step = '0.01';

        const valueUnit = document.createElement('span');
        valueUnit.className = 'joint-value-unit';
        valueUnit.textContent = this.getJointUnit(joint);

        const updateLabels = () => {
            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            const decimals = this.getDisplayDecimals(joint);
            minLabel.value = this.toDisplayValue(joint, currentMin).toFixed(decimals);
            maxLabel.value = this.toDisplayValue(joint, currentMax).toFixed(decimals);
        };

        const updateValueInput = () => {
            const value = parseFloat(slider.value);
            valueInput.value = this.toDisplayValue(joint, value).toFixed(this.getDisplayDecimals(joint));
        };

        updateLabels();
        updateValueInput();

        // Lower limit edit event
        minLabel.addEventListener('change', () => {
            let inputValue = parseFloat(minLabel.value);
            if (isNaN(inputValue)) {
                updateLabels();
                return;
            }

            let valueInRad = this.fromDisplayValue(joint, inputValue);

            const currentMax = parseFloat(slider.max);
            if (valueInRad >= currentMax) {
                updateLabels();
                return;
            }

            slider.min = valueInRad;
            slider.step = (slider.max - slider.min) / 1000;

            // Update limits in model
            if (joint.limits) {
                joint.limits.lower = valueInRad;
            }

            // Sync to editor
            this.updateEditorXML(joint.name, { lower: valueInRad });

            // If current value exceeds new limit, adjust to within limit
            const currentValue = parseFloat(slider.value);
            if (currentValue < valueInRad) {
                slider.value = valueInRad;
                if (this.poseController) {
                    this.poseController.setJointValue(joint.name, valueInRad, {
                        source: 'limits',
                        commit: false
                    });
                } else {
                    ModelLoaderFactory.setJointAngle(model, joint.name, valueInRad);
                    joint.currentValue = valueInRad;
                }
                updateValueInput();
                this.sceneManager.redraw();
                this.sceneManager.render();

                // Trigger measurement update
                if (this.sceneManager.onMeasurementUpdate) {
                    this.sceneManager.onMeasurementUpdate();
                }
            }

            updateLabels();
        });

        // Upper limit edit event
        maxLabel.addEventListener('change', () => {
            let inputValue = parseFloat(maxLabel.value);
            if (isNaN(inputValue)) {
                updateLabels();
                return;
            }

            let valueInRad = this.fromDisplayValue(joint, inputValue);

            const currentMin = parseFloat(slider.min);
            if (valueInRad <= currentMin) {
                updateLabels();
                return;
            }

            slider.max = valueInRad;
            slider.step = (slider.max - slider.min) / 1000;

            // Update limits in model
            if (joint.limits) {
                joint.limits.upper = valueInRad;
            }

            // Sync to editor
            this.updateEditorXML(joint.name, { upper: valueInRad });

            // If current value exceeds new limit, adjust to within limit
            const currentValue = parseFloat(slider.value);
            if (currentValue > valueInRad) {
                slider.value = valueInRad;
                if (this.poseController) {
                    this.poseController.setJointValue(joint.name, valueInRad, {
                        source: 'limits',
                        commit: false
                    });
                } else {
                    ModelLoaderFactory.setJointAngle(model, joint.name, valueInRad);
                    joint.currentValue = valueInRad;
                }
                updateValueInput();
                this.sceneManager.redraw();
                this.sceneManager.render();

                // Trigger measurement update
                if (this.sceneManager.onMeasurementUpdate) {
                    this.sceneManager.onMeasurementUpdate();
                }
            }

            updateLabels();
        });

        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'joint-slider-container';
        sliderContainer.appendChild(slider);

        // Value input container (placed after slider)
        const valueInputContainer = document.createElement('div');
        valueInputContainer.className = 'joint-value-input-container';
        valueInputContainer.appendChild(valueInput);
        valueInputContainer.appendChild(valueUnit);

        sliderRow.appendChild(minLabel);
        sliderRow.appendChild(sliderContainer);
        sliderRow.appendChild(maxLabel);
        sliderRow.appendChild(valueInputContainer);

        // Determine model type (URDF only shows effort and velocity)
        const modelType = model.threeObject?.userData?.type || 'urdf';
        const showEffortVelocity = modelType === 'urdf';

        // Effort control (only shown in URDF)
        if (showEffortVelocity) {
            const effortContainer = document.createElement('div');
            effortContainer.className = 'joint-extra-field';

            const effortLabel = document.createElement('label');
            effortLabel.textContent = 'τ:';
            effortLabel.className = 'joint-extra-label';
            effortLabel.title = 'Effort (max force/torque)';

            const effortInput = document.createElement('input');
            effortInput.type = 'number';
            effortInput.className = 'joint-extra-input';
            effortInput.step = '0.1';
            // Read actual value from model, show empty string if not available
            const effortValue = limits.effort !== null && limits.effort !== undefined ? limits.effort : '';
            effortInput.value = effortValue;
            effortInput.placeholder = '-';
            effortInput.title = 'Effort (max force/torque)';

            effortContainer.appendChild(effortLabel);
            effortContainer.appendChild(effortInput);

            // Velocity control
            const velocityContainer = document.createElement('div');
            velocityContainer.className = 'joint-extra-field';

            const velocityLabel = document.createElement('label');
            velocityLabel.textContent = 'v:';
            velocityLabel.className = 'joint-extra-label';
            velocityLabel.title = 'Velocity (max speed)';

            const velocityInput = document.createElement('input');
            velocityInput.type = 'number';
            velocityInput.className = 'joint-extra-input';
            velocityInput.step = '0.1';
            // Read actual value from model, show empty string if not available
            const velocityValue = limits.velocity !== null && limits.velocity !== undefined ? limits.velocity : '';
            velocityInput.value = velocityValue;
            velocityInput.placeholder = '-';
            velocityInput.title = 'Velocity (max speed)';

            velocityContainer.appendChild(velocityLabel);
            velocityContainer.appendChild(velocityInput);

            // Add Effort and Velocity to first row
            header.appendChild(effortContainer);
            header.appendChild(velocityContainer);

            // Effort input event
            effortInput.addEventListener('change', () => {
                let inputValue = parseFloat(effortInput.value);
                if (isNaN(inputValue) || effortInput.value === '') {
                    // If input is empty or invalid, set to null
                    if (!joint.limits) {
                        joint.limits = {
                            lower: lower,
                            upper: upper,
                            effort: null,
                            velocity: limits.velocity
                        };
                    } else {
                        joint.limits.effort = null;
                    }
                    return;
                }

                if (!joint.limits) {
                    joint.limits = {
                        lower: lower,
                        upper: upper,
                        effort: inputValue,
                        velocity: limits.velocity
                    };
                } else {
                    joint.limits.effort = inputValue;
                }

                // Sync to editor
                this.updateEditorXML(joint.name, { effort: inputValue });
            });

            // Velocity input event
            velocityInput.addEventListener('change', () => {
                let inputValue = parseFloat(velocityInput.value);
                if (isNaN(inputValue) || velocityInput.value === '') {
                    // If input is empty or invalid, set to null
                    if (!joint.limits) {
                        joint.limits = {
                            lower: lower,
                            upper: upper,
                            effort: limits.effort,
                            velocity: null
                        };
                    } else {
                        joint.limits.velocity = null;
                    }
                    return;
                }

                if (!joint.limits) {
                    joint.limits = {
                        lower: lower,
                        upper: upper,
                        effort: limits.effort,
                        velocity: inputValue
                    };
                } else {
                    joint.limits.velocity = inputValue;
                }

                // Sync to editor
                this.updateEditorXML(joint.name, { velocity: inputValue });
            });
        }

        // Slider events
        slider.addEventListener('mousedown', () => {
            this.sceneManager.axesManager.showOnlyJointAxis(joint);
        });

        slider.addEventListener('mouseup', () => {
            this.sceneManager.axesManager.restoreAllJointAxes();
        });

        div.appendChild(header);
        div.appendChild(sliderRow);

        slider.addEventListener('input', () => {
            const value = parseFloat(slider.value);
            if (this.poseController) {
                this.poseController.setJointValue(joint.name, value, {
                    source: 'user',
                    commit: false
                });
            } else {
                ModelLoaderFactory.setJointAngle(model, joint.name, value);
                joint.currentValue = value;
            }
            updateValueInput();

            // Apply parallel mechanism constraints
            if (!this.poseController && this.sceneManager.constraintManager) {
                this.sceneManager.constraintManager.applyConstraints(model, joint);
            }

            if (!slider._pendingRender) {
                slider._pendingRender = true;
                requestAnimationFrame(() => {
                    this.sceneManager.redraw();
                    this.sceneManager.render();

                    // Trigger measurement update
                    if (this.sceneManager.onMeasurementUpdate) {
                        this.sceneManager.onMeasurementUpdate();
                    }

                    slider._pendingRender = false;
                });
            }
        });

        slider.addEventListener('change', () => {
            this.poseController?.commitJointValue(joint.name, { source: 'user' });
        });

        // Manual input event
        valueInput.addEventListener('change', () => {
            let inputValue = parseFloat(valueInput.value);
            if (isNaN(inputValue)) {
                updateValueInput();
                return;
            }

            let valueInRad = this.fromDisplayValue(joint, inputValue);

            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            valueInRad = Math.max(currentMin, Math.min(currentMax, valueInRad));

            slider.value = valueInRad;
            if (this.poseController) {
                this.poseController.setJointValue(joint.name, valueInRad, {
                    source: 'user',
                    commit: true
                });
            } else {
                ModelLoaderFactory.setJointAngle(model, joint.name, valueInRad);
                joint.currentValue = valueInRad;
            }

            // Apply parallel mechanism constraints
            if (!this.poseController && this.sceneManager.constraintManager) {
                this.sceneManager.constraintManager.applyConstraints(model, joint);
            }

            updateValueInput();
            this.sceneManager.redraw();
            this.sceneManager.render();

            // Trigger measurement update
            if (this.sceneManager.onMeasurementUpdate) {
                this.sceneManager.onMeasurementUpdate();
            }
        });

        // Save update function
        div._updateDisplay = () => {
            updateValueInput();
            updateLabels();
            valueUnit.textContent = this.getJointUnit(joint);
        };

        return div;
    }

    /**
     * Set angle unit
     */
    setAngleUnit(unit) {
        this.angleUnit = unit;
        const controls = document.querySelectorAll('.joint-control');
        controls.forEach(control => {
            if (control._updateDisplay) {
                control._updateDisplay();
            }
        });
    }

    /**
     * Reset all joints to initial positions when model loaded
     */
    resetAllJoints(model) {
        if (!model || !model.joints) return;

        model.joints.forEach((joint, name) => {
            if (joint.type !== 'fixed') {
                // Use saved initial value, if not saved use middle value
                let initialValue = this.initialJointValues.get(name);

                if (initialValue === undefined) {
                    const limits = joint.limits || {};
                    const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                    const upper = limits.upper !== undefined ? limits.upper : Math.PI;
                    initialValue = joint.currentValue !== undefined ? joint.currentValue : (lower + upper) / 2;
                }

                // Set joint angle, ignore limit constraints because initial position may exceed current limits
                if (this.poseController) {
                    this.poseController.setJointValue(name, initialValue, {
                        source: 'reset',
                        commit: false,
                        ignoreLimits: true,
                        render: false,
                        measure: false
                    });
                } else {
                    ModelLoaderFactory.setJointAngle(model, name, initialValue, true);
                    joint.currentValue = initialValue;
                }

                const slider = document.querySelector(`input[data-joint="${name}"]`);
                if (slider) {
                    slider.value = initialValue;
                    const control = slider.closest('.joint-control');
                    if (control && control._updateDisplay) {
                        control._updateDisplay();
                    }
                }
            }
        });

        this.sceneManager.render();

        // Trigger measurement update
        if (this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Update limits for all sliders
     */
    updateAllSliderLimits(model, ignoreLimits) {
        if (!model) return;

        document.querySelectorAll('.joint-slider').forEach(slider => {
            const jointName = slider.getAttribute('data-joint');
            const joint = model.joints.get(jointName);

            if (joint && joint.type !== 'fixed') {
                if (ignoreLimits) {
                    slider.min = -Math.PI * 2;
                    slider.max = Math.PI * 2;
                    slider.step = 0.01;
                } else {
                    const limits = joint.limits || {};
                    const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                    const upper = limits.upper !== undefined ? limits.upper : Math.PI;

                    if (joint.type === 'continuous') {
                        slider.min = -Math.PI;
                        slider.max = Math.PI;
                    } else {
                        slider.min = lower;
                        slider.max = upper;
                    }
                    slider.step = (slider.max - slider.min) / 1000;
                }

                const control = slider.closest('.joint-control');
                if (control && control._updateDisplay) {
                    control._updateDisplay();
                }
            }
        });
    }
}
