/**
 * JointControlsUI - Joint control UI module
 * Responsible for creating and managing joint control sliders and pose presets
 */
import YAML, { isMap, isSeq } from 'yaml';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { XMLUpdater } from '../utils/XMLUpdater.js';

export class JointControlsUI {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
        this.initialJointValues = new Map();
        this.initialValueModel = null;
        this.codeEditorManager = null;
        this.isUpdatingFromEditor = false;

        this.jointControlElements = new Map();

        this.poseGroupText = '';
        this.poseValuesText = '';
        this.poseStatus = null;
        this.activePoseConfig = null;
        this.activePoseModel = null;

        this.poseGroupsTextarea = null;
        this.poseValuesTextarea = null;
        this.poseStatusElement = null;
    }

    /**
     * Set code editor manager reference
     */
    setCodeEditorManager(codeEditorManager) {
        this.codeEditorManager = codeEditorManager;
    }

    /**
     * Update XML content in editor (URDF format only)
     */
    updateEditorXML(jointName, limits) {
        if (this.isUpdatingFromEditor || !this.codeEditorManager) {
            return;
        }

        const editor = this.codeEditorManager.getEditor();
        if (!editor) {
            return;
        }

        const currentContent = editor.getValue();
        if (!currentContent || currentContent.trim().length === 0) {
            return;
        }

        if (!currentContent.includes('<robot')) {
            return;
        }

        this.isUpdatingFromEditor = true;

        try {
            const updatedXML = XMLUpdater.updateURDFJointLimits(currentContent, jointName, limits);

            if (updatedXML !== currentContent) {
                const cursorPos = editor.view.state.selection.main.head;
                editor.setValue(updatedXML);

                try {
                    const maxPos = editor.view.state.doc.length;
                    const newPos = Math.min(cursorPos, maxPos);
                    editor.view.dispatch({
                        selection: { anchor: newPos, head: newPos }
                    });
                } catch (error) {
                    // Ignore cursor restoration errors.
                }
            }
        } catch (error) {
            console.error('Failed to update editor XML:', error);
        } finally {
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
        this.jointControlElements.clear();
        this.poseGroupsTextarea = null;
        this.poseValuesTextarea = null;
        this.poseStatusElement = null;

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

        if (this.activePoseConfig && this.activePoseModel && this.activePoseModel !== model) {
            this.activePoseConfig = null;
            this.activePoseModel = null;

            if (this.poseGroupText.trim() || this.poseValuesText.trim()) {
                this.setPoseStatus('info', 'jointPoseReapplyRequired');
            }
        }

        if (this.initialValueModel !== model) {
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
            this.initialValueModel = model;
        }

        const poseCard = this.createPoseConfigCard(model);
        container.appendChild(poseCard);

        model.joints.forEach((joint) => {
            if (joint.type === 'fixed') return;
            const control = this.createJointControl(joint, model);
            container.appendChild(control);
        });

        this.refreshAllJointControlsFromModel(model);
        this.syncPoseValuesTextFromModel(model);
        this.updatePoseStatusElement();
    }

    /**
     * Create pose config card
     */
    createPoseConfigCard(model) {
        const card = document.createElement('div');
        card.className = 'joint-pose-config';

        const title = document.createElement('div');
        title.className = 'joint-pose-title';
        title.textContent = this.t('jointPoseTitle');
        card.appendChild(title);

        const groupsField = document.createElement('div');
        groupsField.className = 'joint-pose-field';

        const groupsLabel = document.createElement('label');
        groupsLabel.className = 'joint-pose-label';
        groupsLabel.textContent = this.t('jointPoseGroupsField');
        groupsField.appendChild(groupsLabel);

        const groupsTextarea = document.createElement('textarea');
        groupsTextarea.className = 'joint-pose-textarea';
        groupsTextarea.rows = 5;
        groupsTextarea.spellcheck = false;
        groupsTextarea.placeholder = this.t('jointPoseGroupsPlaceholder');
        groupsTextarea.value = this.poseGroupText;
        groupsField.appendChild(groupsTextarea);
        card.appendChild(groupsField);

        const valuesField = document.createElement('div');
        valuesField.className = 'joint-pose-field';

        const valuesLabel = document.createElement('label');
        valuesLabel.className = 'joint-pose-label';
        valuesLabel.textContent = this.t('jointPoseValuesField');
        valuesField.appendChild(valuesLabel);

        const valuesTextarea = document.createElement('textarea');
        valuesTextarea.className = 'joint-pose-textarea';
        valuesTextarea.rows = 5;
        valuesTextarea.spellcheck = false;
        valuesTextarea.placeholder = this.t('jointPoseValuesPlaceholder');
        valuesTextarea.value = this.poseValuesText;
        valuesField.appendChild(valuesTextarea);
        card.appendChild(valuesField);

        const actions = document.createElement('div');
        actions.className = 'joint-pose-actions';

        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'joint-pose-button primary';
        applyButton.textContent = this.t('jointPoseApply');
        actions.appendChild(applyButton);

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'joint-pose-button';
        copyButton.textContent = this.t('jointPoseCopyValues');
        actions.appendChild(copyButton);

        card.appendChild(actions);

        const status = document.createElement('div');
        status.className = 'joint-pose-status';
        card.appendChild(status);

        groupsTextarea.addEventListener('input', () => {
            this.poseGroupText = groupsTextarea.value;
            this.handlePoseTextEdited(model);
        });

        valuesTextarea.addEventListener('input', () => {
            this.poseValuesText = valuesTextarea.value;
            this.handlePoseTextEdited(model);
        });

        applyButton.addEventListener('click', () => {
            this.applyPoseConfiguration(model);
        });

        copyButton.addEventListener('click', async () => {
            await this.copyPoseValues();
        });

        this.poseGroupsTextarea = groupsTextarea;
        this.poseValuesTextarea = valuesTextarea;
        this.poseStatusElement = status;

        return card;
    }

    /**
     * Create joint control element
     */
    createJointControl(joint, model) {
        const div = document.createElement('div');
        div.className = 'joint-control';

        const header = document.createElement('div');
        header.className = 'joint-header';

        const name = document.createElement('div');
        name.className = 'joint-name';
        name.textContent = joint.name;
        name.title = joint.name;
        header.appendChild(name);

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

        const minLabel = document.createElement('input');
        minLabel.type = 'number';
        minLabel.className = 'joint-limit-min editable-limit';
        minLabel.step = '0.01';
        minLabel.title = window.i18n.t('clickToEditMin');

        const maxLabel = document.createElement('input');
        maxLabel.type = 'number';
        maxLabel.className = 'joint-limit-max editable-limit';
        maxLabel.step = '0.01';
        maxLabel.title = window.i18n.t('clickToEditMax');

        const valueInput = document.createElement('input');
        valueInput.type = 'number';
        valueInput.className = 'joint-value-input';
        valueInput.setAttribute('data-joint-input', joint.name);
        valueInput.step = '0.01';

        const valueUnit = document.createElement('span');
        valueUnit.className = 'joint-value-unit';

        const controlState = {
            joint,
            slider,
            minLabel,
            maxLabel,
            valueInput,
            valueUnit,
            updateLabels: () => {
                const currentMin = parseFloat(slider.min);
                const currentMax = parseFloat(slider.max);

                if (this.angleUnit === 'deg') {
                    minLabel.value = (currentMin * 180 / Math.PI).toFixed(1);
                    maxLabel.value = (currentMax * 180 / Math.PI).toFixed(1);
                } else {
                    minLabel.value = currentMin.toFixed(2);
                    maxLabel.value = currentMax.toFixed(2);
                }
            },
            updateValueInput: () => {
                const currentValue = this.getJointCurrentValue(model, joint.name);
                valueInput.value = this.angleUnit === 'deg'
                    ? (currentValue * 180 / Math.PI).toFixed(1)
                    : currentValue.toFixed(2);
                valueUnit.textContent = this.angleUnit === 'deg' ? '°' : 'rad';
            },
            updateDisplay: () => {
                slider.value = this.getJointCurrentValue(model, joint.name);
                controlState.updateValueInput();
                controlState.updateLabels();
            }
        };

        const initialValue = this.getJointCurrentValue(model, joint.name);
        slider.value = initialValue;
        controlState.updateLabels();
        controlState.updateValueInput();

        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'joint-slider-container';
        sliderContainer.appendChild(slider);

        const valueInputContainer = document.createElement('div');
        valueInputContainer.className = 'joint-value-input-container';
        valueInputContainer.appendChild(valueInput);
        valueInputContainer.appendChild(valueUnit);

        sliderRow.appendChild(minLabel);
        sliderRow.appendChild(sliderContainer);
        sliderRow.appendChild(maxLabel);
        sliderRow.appendChild(valueInputContainer);

        const modelType = model.threeObject?.userData?.type || 'urdf';
        const showEffortVelocity = modelType === 'urdf';

        if (showEffortVelocity) {
            const effortContainer = document.createElement('div');
            effortContainer.className = 'joint-extra-field';

            const effortLabel = document.createElement('label');
            effortLabel.textContent = 't:';
            effortLabel.className = 'joint-extra-label';
            effortLabel.title = 'Effort (max force/torque)';

            const effortInput = document.createElement('input');
            effortInput.type = 'number';
            effortInput.className = 'joint-extra-input';
            effortInput.step = '0.1';
            effortInput.value = limits.effort !== null && limits.effort !== undefined ? limits.effort : '';
            effortInput.placeholder = '-';
            effortInput.title = 'Effort (max force/torque)';

            effortContainer.appendChild(effortLabel);
            effortContainer.appendChild(effortInput);

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
            velocityInput.value = limits.velocity !== null && limits.velocity !== undefined ? limits.velocity : '';
            velocityInput.placeholder = '-';
            velocityInput.title = 'Velocity (max speed)';

            velocityContainer.appendChild(velocityLabel);
            velocityContainer.appendChild(velocityInput);

            header.appendChild(effortContainer);
            header.appendChild(velocityContainer);

            effortInput.addEventListener('change', () => {
                const inputValue = parseFloat(effortInput.value);
                if (Number.isNaN(inputValue) || effortInput.value === '') {
                    if (!joint.limits) {
                        joint.limits = {
                            lower,
                            upper,
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
                        lower,
                        upper,
                        effort: inputValue,
                        velocity: limits.velocity
                    };
                } else {
                    joint.limits.effort = inputValue;
                }

                this.updateEditorXML(joint.name, { effort: inputValue });
            });

            velocityInput.addEventListener('change', () => {
                const inputValue = parseFloat(velocityInput.value);
                if (Number.isNaN(inputValue) || velocityInput.value === '') {
                    if (!joint.limits) {
                        joint.limits = {
                            lower,
                            upper,
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
                        lower,
                        upper,
                        effort: limits.effort,
                        velocity: inputValue
                    };
                } else {
                    joint.limits.velocity = inputValue;
                }

                this.updateEditorXML(joint.name, { velocity: inputValue });
            });
        }

        slider.addEventListener('mousedown', () => {
            this.sceneManager.axesManager.showOnlyJointAxis(joint);
        });

        slider.addEventListener('mouseup', () => {
            this.sceneManager.axesManager.restoreAllJointAxes();
        });

        slider.addEventListener('input', () => {
            const value = parseFloat(slider.value);
            this.applyJointValueChange(model, joint.name, value, {
                render: false
            });

            if (!slider._pendingRender) {
                slider._pendingRender = true;
                requestAnimationFrame(() => {
                    this.finalizeJointUpdates();
                    slider._pendingRender = false;
                });
            }
        });

        valueInput.addEventListener('change', () => {
            const inputValue = parseFloat(valueInput.value);
            if (Number.isNaN(inputValue)) {
                controlState.updateValueInput();
                return;
            }

            const valueInRad = this.angleUnit === 'deg'
                ? inputValue * Math.PI / 180
                : inputValue;

            this.applyJointValueChange(model, joint.name, valueInRad);
        });

        minLabel.addEventListener('change', () => {
            const inputValue = parseFloat(minLabel.value);
            if (Number.isNaN(inputValue)) {
                controlState.updateLabels();
                return;
            }

            const valueInRad = this.angleUnit === 'deg'
                ? inputValue * Math.PI / 180
                : inputValue;

            const currentMax = parseFloat(slider.max);
            if (valueInRad >= currentMax) {
                controlState.updateLabels();
                return;
            }

            slider.min = valueInRad;
            slider.step = (parseFloat(slider.max) - parseFloat(slider.min)) / 1000;

            if (joint.limits) {
                joint.limits.lower = valueInRad;
            }

            this.updateEditorXML(joint.name, { lower: valueInRad });

            if (this.getJointCurrentValue(model, joint.name) < valueInRad) {
                this.applyJointValueChange(model, joint.name, valueInRad);
            } else {
                controlState.updateLabels();
            }
        });

        maxLabel.addEventListener('change', () => {
            const inputValue = parseFloat(maxLabel.value);
            if (Number.isNaN(inputValue)) {
                controlState.updateLabels();
                return;
            }

            const valueInRad = this.angleUnit === 'deg'
                ? inputValue * Math.PI / 180
                : inputValue;

            const currentMin = parseFloat(slider.min);
            if (valueInRad <= currentMin) {
                controlState.updateLabels();
                return;
            }

            slider.max = valueInRad;
            slider.step = (parseFloat(slider.max) - parseFloat(slider.min)) / 1000;

            if (joint.limits) {
                joint.limits.upper = valueInRad;
            }

            this.updateEditorXML(joint.name, { upper: valueInRad });

            if (this.getJointCurrentValue(model, joint.name) > valueInRad) {
                this.applyJointValueChange(model, joint.name, valueInRad);
            } else {
                controlState.updateLabels();
            }
        });

        div.appendChild(header);
        div.appendChild(sliderRow);
        div._updateDisplay = controlState.updateDisplay;

        this.jointControlElements.set(joint.name, controlState);

        return div;
    }

    /**
     * Apply pose configuration from textareas
     */
    applyPoseConfiguration(model) {
        try {
            const groupText = this.poseGroupsTextarea ? this.poseGroupsTextarea.value : this.poseGroupText;
            const valueText = this.poseValuesTextarea ? this.poseValuesTextarea.value : this.poseValuesText;

            this.poseGroupText = groupText;
            this.poseValuesText = valueText;

            const groupConfig = this.parsePoseYamlMap(groupText, 'groups');
            const valueConfig = this.parsePoseYamlMap(valueText, 'values');
            const validatedConfig = this.validatePoseConfigs(model, groupConfig, valueConfig);

            this.activePoseConfig = {
                groups: validatedConfig.groups.map((group) => ({
                    name: group.name,
                    joints: [...group.joints]
                }))
            };
            this.activePoseModel = model;

            let clampedCount = 0;

            validatedConfig.groups.forEach((group) => {
                group.joints.forEach((jointName, index) => {
                    const result = this.applyJointValueChange(model, jointName, group.values[index], {
                        render: false,
                        syncPoseValues: false,
                        refreshControls: false
                    });

                    if (result.wasClamped) {
                        clampedCount++;
                    }
                });
            });

            this.refreshAllJointControlsFromModel(model);
            this.syncPoseValuesTextFromModel(model);
            this.finalizeJointUpdates();

            if (clampedCount > 0) {
                this.setPoseStatus('warning', 'jointPoseApplyClamped', { count: clampedCount });
            } else {
                this.setPoseStatus('success', 'jointPoseApplySuccess');
            }
        } catch (error) {
            this.setPoseStatus('error', null, {}, error.message);
        }
    }

    /**
     * Copy pose values text
     */
    async copyPoseValues() {
        const text = this.poseValuesTextarea ? this.poseValuesTextarea.value : this.poseValuesText;

        try {
            await this.copyTextToClipboard(text);
            this.setPoseStatus('success', 'jointPoseCopySuccess');
        } catch (error) {
            this.setPoseStatus('error', 'jointPoseCopyFailed', {
                reason: error.message || this.t('jointPoseClipboardUnavailable')
            });
        }
    }

    /**
     * Sync UI after an external joint update such as 3D dragging
     */
    handleExternalJointValueChange(model) {
        this.refreshAllJointControlsFromModel(model);
        this.syncPoseValuesTextFromModel(model);
    }

    /**
     * Update a single joint value and keep the panel in sync
     */
    applyJointValueChange(model, jointName, requestedValue, options = {}) {
        const joint = model?.joints?.get(jointName);
        if (!joint || joint.type === 'fixed') {
            return {
                requestedValue,
                appliedValue: requestedValue,
                wasClamped: false
            };
        }

        const control = this.jointControlElements.get(jointName);
        let appliedValue = requestedValue;

        if (options.clampToSliderRange !== false && control) {
            const min = parseFloat(control.slider.min);
            const max = parseFloat(control.slider.max);

            if (Number.isFinite(min) && Number.isFinite(max)) {
                appliedValue = Math.max(min, Math.min(max, appliedValue));
            }
        }

        ModelLoaderFactory.setJointAngle(model, jointName, appliedValue, options.ignoreLimits === true);
        joint.currentValue = appliedValue;

        if (this.sceneManager.constraintManager) {
            this.sceneManager.constraintManager.applyConstraints(model, joint);
        }

        if (options.refreshControls !== false) {
            this.refreshAllJointControlsFromModel(model);
        }

        if (options.syncPoseValues !== false) {
            this.syncPoseValuesTextFromModel(model);
        }

        if (options.render !== false) {
            this.finalizeJointUpdates();
        }

        return {
            requestedValue,
            appliedValue,
            wasClamped: Math.abs(appliedValue - requestedValue) > 1e-9
        };
    }

    /**
     * Reset all joints to their initial values
     */
    resetAllJoints(model) {
        if (!model || !model.joints) return;

        model.joints.forEach((joint, name) => {
            if (joint.type === 'fixed') {
                return;
            }

            let initialValue = this.initialJointValues.get(name);

            if (initialValue === undefined) {
                const limits = joint.limits || {};
                const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                const upper = limits.upper !== undefined ? limits.upper : Math.PI;
                initialValue = joint.currentValue !== undefined ? joint.currentValue : (lower + upper) / 2;
            }

            this.applyJointValueChange(model, name, initialValue, {
                clampToSliderRange: false,
                ignoreLimits: true,
                render: false,
                syncPoseValues: false,
                refreshControls: false
            });
        });

        this.refreshAllJointControlsFromModel(model);
        this.syncPoseValuesTextFromModel(model);
        this.finalizeJointUpdates();
    }

    /**
     * Update limits for all sliders
     */
    updateAllSliderLimits(model, ignoreLimits) {
        if (!model) return;

        this.jointControlElements.forEach((control, jointName) => {
            const joint = model.joints.get(jointName);
            if (!joint || joint.type === 'fixed') {
                return;
            }

            if (ignoreLimits) {
                control.slider.min = -Math.PI * 2;
                control.slider.max = Math.PI * 2;
                control.slider.step = 0.01;
            } else {
                const limits = joint.limits || {};
                const lower = limits.lower !== undefined ? limits.lower : -Math.PI;
                const upper = limits.upper !== undefined ? limits.upper : Math.PI;

                if (joint.type === 'continuous') {
                    control.slider.min = -Math.PI;
                    control.slider.max = Math.PI;
                } else {
                    control.slider.min = lower;
                    control.slider.max = upper;
                }
                control.slider.step = (parseFloat(control.slider.max) - parseFloat(control.slider.min)) / 1000;
            }

            control.updateDisplay();
        });

        this.syncPoseValuesTextFromModel(model);
    }

    /**
     * Set angle unit
     */
    setAngleUnit(unit) {
        this.angleUnit = unit;
        this.refreshAllJointControlsFromModel(this.activePoseModel || this.initialValueModel);
    }

    /**
     * Refresh all control displays from the model
     */
    refreshAllJointControlsFromModel(model) {
        if (!model) return;

        this.jointControlElements.forEach((control) => {
            control.updateDisplay();
        });
    }

    /**
     * Sync pose values text from the active pose config
     */
    syncPoseValuesTextFromModel(model) {
        if (!this.activePoseConfig || this.activePoseModel !== model) {
            return;
        }

        const yamlText = this.buildPoseValuesYaml(model, this.activePoseConfig);
        this.poseValuesText = yamlText;

        if (this.poseValuesTextarea) {
            this.poseValuesTextarea.value = yamlText;
        }
    }

    /**
     * Parse YAML for pose config
     */
    parsePoseYamlMap(text, fieldType) {
        const fieldLabel = this.t(fieldType === 'groups' ? 'jointPoseGroupsField' : 'jointPoseValuesField');

        if (!text || text.trim().length === 0) {
            throw new Error(this.t(fieldType === 'groups' ? 'jointPoseGroupsRequired' : 'jointPoseValuesRequired'));
        }

        let document;
        try {
            document = YAML.parseDocument(text);
        } catch (error) {
            throw new Error(this.formatMessage('jointPoseYamlParseFailed', {
                field: fieldLabel,
                reason: error.message
            }));
        }

        if (document.errors.length > 0) {
            throw new Error(this.formatMessage('jointPoseYamlParseFailed', {
                field: fieldLabel,
                reason: document.errors[0].message
            }));
        }

        if (!isMap(document.contents)) {
            throw new Error(this.formatMessage('jointPoseMappingExpected', {
                field: fieldLabel
            }));
        }

        const orderedGroups = [];
        const values = new Map();

        document.contents.items.forEach((item) => {
            const groupName = String(item.key?.toJSON?.() ?? item.key?.value ?? '').trim();

            if (!groupName) {
                throw new Error(this.formatMessage('jointPoseGroupNameRequired', {
                    field: fieldLabel
                }));
            }

            if (values.has(groupName)) {
                throw new Error(this.formatMessage('jointPoseGroupDuplicate', {
                    field: fieldLabel,
                    group: groupName
                }));
            }

            if (!isSeq(item.value)) {
                throw new Error(this.formatMessage('jointPoseSequenceExpected', {
                    field: fieldLabel,
                    group: groupName
                }));
            }

            const sequence = item.value.toJSON();
            if (!Array.isArray(sequence)) {
                throw new Error(this.formatMessage('jointPoseSequenceExpected', {
                    field: fieldLabel,
                    group: groupName
                }));
            }

            const normalized = sequence.map((entry, index) => {
                if (fieldType === 'groups') {
                    if (typeof entry !== 'string' || !entry.trim()) {
                        throw new Error(this.formatMessage('jointPoseJointNameInvalid', {
                            field: fieldLabel,
                            group: groupName,
                            index: index + 1
                        }));
                    }
                    return entry.trim();
                }

                const numericValue = typeof entry === 'number' ? entry : Number(entry);
                if (!Number.isFinite(numericValue)) {
                    throw new Error(this.formatMessage('jointPoseValueInvalid', {
                        field: fieldLabel,
                        group: groupName,
                        index: index + 1
                    }));
                }
                return numericValue;
            });

            orderedGroups.push(groupName);
            values.set(groupName, normalized);
        });

        return { orderedGroups, values };
    }

    /**
     * Validate pose configs against the current model
     */
    validatePoseConfigs(model, groupConfig, valueConfig) {
        if (groupConfig.orderedGroups.length !== valueConfig.orderedGroups.length) {
            throw new Error(this.t('jointPoseGroupMismatch'));
        }

        const groups = [];
        const seenJoints = new Set();

        groupConfig.orderedGroups.forEach((groupName, index) => {
            const valueGroupName = valueConfig.orderedGroups[index];
            if (groupName !== valueGroupName) {
                throw new Error(this.t('jointPoseGroupOrderMismatch'));
            }

            const joints = groupConfig.values.get(groupName) || [];
            const values = valueConfig.values.get(groupName) || [];

            if (joints.length !== values.length) {
                throw new Error(this.formatMessage('jointPoseLengthMismatch', {
                    group: groupName,
                    jointCount: joints.length,
                    valueCount: values.length
                }));
            }

            joints.forEach((jointName) => {
                if (seenJoints.has(jointName)) {
                    throw new Error(this.formatMessage('jointPoseJointDuplicate', {
                        joint: jointName
                    }));
                }

                const joint = model.joints.get(jointName);
                if (!joint) {
                    throw new Error(this.formatMessage('jointPoseJointMissing', {
                        joint: jointName
                    }));
                }

                if (joint.type === 'fixed') {
                    throw new Error(this.formatMessage('jointPoseJointFixed', {
                        joint: jointName
                    }));
                }

                seenJoints.add(jointName);
            });

            groups.push({
                name: groupName,
                joints: [...joints],
                values: [...values]
            });
        });

        return { groups };
    }

    /**
     * Build values YAML from the active groups
     */
    buildPoseValuesYaml(model, config) {
        return config.groups.map((group) => {
            const values = group.joints.map((jointName) => {
                return this.formatPoseNumber(this.getJointCurrentValue(model, jointName));
            });
            return `${group.name}: [${values.join(', ')}]`;
        }).join('\n');
    }

    /**
     * Handle textarea edits
     */
    handlePoseTextEdited(model) {
        if (this.activePoseConfig && this.activePoseModel === model) {
            this.activePoseConfig = null;
            this.activePoseModel = null;
            this.setPoseStatus('info', 'jointPoseConfigEdited');
        }
    }

    /**
     * Finalize joint updates with one render and measurement refresh
     */
    finalizeJointUpdates() {
        this.sceneManager.redraw();
        this.sceneManager.render();

        if (this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Get the current joint value
     */
    getJointCurrentValue(model, jointName) {
        const joint = model?.joints?.get(jointName);
        if (!joint) {
            return 0;
        }

        if (typeof joint.currentValue === 'number' && Number.isFinite(joint.currentValue)) {
            return joint.currentValue;
        }

        const control = this.jointControlElements.get(jointName);
        if (control) {
            const sliderValue = parseFloat(control.slider.value);
            if (Number.isFinite(sliderValue)) {
                return sliderValue;
            }
        }

        return 0;
    }

    /**
     * Format a joint value for exported YAML
     */
    formatPoseNumber(value) {
        let rounded = Number(value.toFixed(6));
        if (Object.is(rounded, -0) || Math.abs(rounded) < 1e-9) {
            rounded = 0;
        }

        const normalized = rounded.toString();
        return normalized.includes('.') ? normalized : `${normalized}.0`;
    }

    /**
     * Copy text to the clipboard
     */
    async copyTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();

        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (!copied) {
            throw new Error(this.t('jointPoseClipboardUnavailable'));
        }
    }

    /**
     * Update pose status state and element
     */
    setPoseStatus(type, key = null, params = {}, rawMessage = '') {
        this.poseStatus = {
            type,
            key,
            params,
            rawMessage
        };
        this.updatePoseStatusElement();
    }

    /**
     * Update the rendered pose status element
     */
    updatePoseStatusElement() {
        if (!this.poseStatusElement) {
            return;
        }

        const status = this.poseStatus;
        const statusText = status
            ? (status.key ? this.formatMessage(status.key, status.params) : status.rawMessage)
            : '';

        this.poseStatusElement.textContent = statusText;
        this.poseStatusElement.className = 'joint-pose-status';

        if (status?.type) {
            this.poseStatusElement.classList.add(status.type);
        }
    }

    /**
     * Translate a key
     */
    t(key) {
        return window.i18n?.t(key) || key;
    }

    /**
     * Replace template placeholders in translated text
     */
    formatMessage(key, params = {}) {
        const template = this.t(key);
        return template.replace(/\{(\w+)\}/g, (_, token) => {
            return params[token] !== undefined ? String(params[token]) : '';
        });
    }
}
