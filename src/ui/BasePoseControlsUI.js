/**
 * BasePoseControlsUI - Base pose control UI module
 * Responsible for creating and managing base pose control sliders (roll, pitch, yaw, x, y, z)
 */
import * as THREE from 'three';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import backendConfig from '../utils/BackendConfig.js';

export class BasePoseControlsUI {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
        
        // Base pose state
        this.basePose = {
            roll: 0,
            pitch: 0,
            yaw: 0,
            x: 0,
            y: 0,
            z: 0
        };
        
        // Frame time (seconds)
        this.frameTime = 0.0;
        
        // Frame file name (user input)
        this.frameFileName = '';
        
        // World coordinate offset for all frames
        this.worldOffset = {
            x: 0,
            y: 0,
            z: 0
        };
        
        // Store current model reference
        this.currentModel = null;
        
        // Store original base transform
        this.originalBaseTransform = null;
        
        // Timer for dynamic range adjustment
        this.rangeAdjustTimer = null;
        
        // Store initial slider ranges for xyz (only expand, never shrink)
        this.xyzSliderRanges = {
            x: { min: -0.3, max: 0.3 },
            y: { min: -0.3, max: 0.3 },
            z: { min: -0.3, max: 0.3 }
        };
        
        // Inject styles once
        this.injectStyles();
    }

    /**
     * Inject styles for base pose controls
     */
    injectStyles() {
        // Check if styles already injected
        if (document.getElementById('base-pose-controls-styles')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'base-pose-controls-styles';
        style.textContent = `
            /* Frame time input group */
            .base-pose-frame-group {
                margin-top: 16px;
                padding: 12px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .base-pose-frame-label {
                font-size: 12px;
                font-weight: 600;
                color: var(--text-secondary);
                white-space: nowrap;
            }

            .base-pose-frame-input {
                flex: 1;
                padding: 6px 10px;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 6px;
                color: var(--text-primary);
                font-size: 13px;
                font-variant-numeric: tabular-nums;
                transition: all 0.2s;
                text-align: right;
                font-weight: 500;
            }

            .base-pose-frame-input::-webkit-outer-spin-button,
            .base-pose-frame-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }

            .base-pose-frame-input[type=number] {
                -moz-appearance: textfield;
                appearance: textfield;
            }

            .base-pose-frame-input:focus {
                outline: none;
                border-color: var(--accent);
                background: rgba(255, 255, 255, 0.08);
            }

            .base-pose-frame-input:hover {
                background: rgba(255, 255, 255, 0.06);
                border-color: rgba(255, 255, 255, 0.2);
            }

            /* Frame slider container */
            .base-pose-frame-slider-container {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
            }

            .base-pose-frame-slider {
                flex: 1;
                height: 4px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
                outline: none;
                -webkit-appearance: none;
                appearance: none;
            }

            .base-pose-frame-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 14px;
                height: 14px;
                background: var(--accent);
                border-radius: 50%;
                cursor: pointer;
                transition: all 0.2s;
            }

            .base-pose-frame-slider::-webkit-slider-thumb:hover {
                transform: scale(1.2);
                box-shadow: 0 0 8px rgba(10, 132, 255, 0.5);
            }

            .base-pose-frame-slider::-moz-range-thumb {
                width: 14px;
                height: 14px;
                background: var(--accent);
                border-radius: 50%;
                cursor: pointer;
                border: none;
                transition: all 0.2s;
            }

            .base-pose-frame-slider::-moz-range-thumb:hover {
                transform: scale(1.2);
                box-shadow: 0 0 8px rgba(10, 132, 255, 0.5);
            }

            .base-pose-frame-slider:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .base-pose-frame-slider-value {
                min-width: 60px;
                text-align: right;
                font-size: 12px;
                font-weight: 500;
                color: var(--text-secondary);
                font-variant-numeric: tabular-nums;
            }

            /* Frame navigation buttons */
            .frame-nav-btn {
                min-width: 32px;
                height: 32px;
                padding: 0;
                border-radius: 6px;
                border: 1px solid rgba(255, 255, 255, 0.15);
                background: rgba(255, 255, 255, 0.06);
                color: var(--text-primary);
                cursor: pointer;
                font-size: 14px;
                transition: all 0.2s;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .frame-nav-btn:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.12);
                border-color: rgba(255, 255, 255, 0.25);
                transform: scale(1.05);
            }

            .frame-nav-btn:active:not(:disabled) {
                transform: scale(0.95);
            }

            .frame-nav-btn:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }

            [data-theme="light"] .frame-nav-btn {
                border-color: rgba(0, 0, 0, 0.15);
                background: rgba(0, 0, 0, 0.04);
            }

            [data-theme="light"] .frame-nav-btn:hover:not(:disabled) {
                background: rgba(0, 0, 0, 0.08);
                border-color: rgba(0, 0, 0, 0.25);
            }

            /* Load frame button */
            .load-frame-btn {
                width: 100%;
                padding: 10px;
                margin-top: 8px;
                background: rgba(10, 132, 255, 0.1);
                border: 1px solid rgba(10, 132, 255, 0.3);
                border-radius: 10px;
                color: #0a84ff;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .load-frame-btn:hover {
                background: rgba(10, 132, 255, 0.2);
                border-color: rgba(10, 132, 255, 0.5);
                transform: translateY(-1px);
            }

            .load-frame-btn:active {
                transform: translateY(0);
            }

            .load-frame-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            /* Load frames button (for caching) */
            .load-frames-btn {
                width: 100%;
                padding: 10px;
                margin-top: 8px;
                background: rgba(88, 86, 214, 0.1);
                border: 1px solid rgba(88, 86, 214, 0.3);
                border-radius: 10px;
                color: #5856d6;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .load-frames-btn:hover:not(:disabled) {
                background: rgba(88, 86, 214, 0.2);
                border-color: rgba(88, 86, 214, 0.5);
                transform: translateY(-1px);
            }

            .load-frames-btn:active:not(:disabled) {
                transform: translateY(0);
            }

            .load-frames-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            /* Save frame button */
            .save-frame-btn {
                width: 100%;
                padding: 10px;
                margin-top: 8px;
                background: rgba(76, 217, 100, 0.1);
                border: 1px solid rgba(76, 217, 100, 0.3);
                border-radius: 10px;
                color: #4cd964;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .save-frame-btn:hover {
                background: rgba(76, 217, 100, 0.2);
                border-color: rgba(76, 217, 100, 0.5);
                transform: translateY(-1px);
            }

            .save-frame-btn:active {
                transform: translateY(0);
            }

            /* Interpolate frames button */
            .interpolate-frames-btn {
                width: 100%;
                padding: 10px;
                margin-top: 0;
                background: rgba(255, 159, 10, 0.1);
                border: 1px solid rgba(255, 159, 10, 0.3);
                border-radius: 10px;
                color: #ff9f0a;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .interpolate-frames-btn:hover:not(:disabled) {
                background: rgba(255, 159, 10, 0.2);
                border-color: rgba(255, 159, 10, 0.5);
                transform: translateY(-1px);
            }

            .interpolate-frames-btn:active:not(:disabled) {
                transform: translateY(0);
            }

            .interpolate-frames-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
                transform: none;
            }

            /* Reset base pose button */
            .reset-base-pose-btn {
                width: 100%;
                padding: 10px;
                margin-top: 8px;
                background: rgba(255, 59, 48, 0.1);
                border: 1px solid rgba(255, 59, 48, 0.3);
                border-radius: 10px;
                color: #ff3b30;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .reset-base-pose-btn:hover {
                background: rgba(255, 59, 48, 0.2);
                border-color: rgba(255, 59, 48, 0.5);
                transform: translateY(-1px);
            }

            .reset-base-pose-btn:active {
                transform: translateY(0);
            }

            /* Scan folder button */
            .scan-folder-btn {
                width: 100%;
                padding: 10px;
                margin-top: 8px;
                background: rgba(255, 159, 64, 0.1);
                border: 1px solid rgba(255, 159, 64, 0.3);
                border-radius: 10px;
                color: #ff9f40;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }

            .scan-folder-btn:hover {
                background: rgba(255, 159, 64, 0.2);
                border-color: rgba(255, 159, 64, 0.5);
                transform: translateY(-1px);
            }

            .scan-folder-btn:active {
                transform: translateY(0);
            }

            /* Frame file select dropdown */
            .base-pose-frame-select {
                width: 100%;
                padding: 8px 12px;
                margin-top: 6px;
                margin-bottom: 8px;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                color: var(--text-primary);
                font-size: 12px;
                cursor: pointer;
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 10px center;
                background-size: 10px 6px;
                padding-right: 30px;
                transition: all 0.2s;
            }

            .base-pose-frame-select:hover {
                background-color: rgba(255, 255, 255, 0.12);
                border-color: rgba(255, 255, 255, 0.2);
            }

            .base-pose-frame-select:focus {
                outline: none;
                background-color: rgba(255, 255, 255, 0.15);
                border-color: rgba(10, 132, 255, 0.5);
            }

            .base-pose-frame-select option {
                background: var(--bg-primary);
                color: var(--text-primary);
                padding: 8px;
            }

            [data-theme="light"] .base-pose-frame-select {
                background-color: rgba(0, 0, 0, 0.05);
                border-color: rgba(0, 0, 0, 0.1);
                background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23000000' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
            }

            [data-theme="light"] .base-pose-frame-select:hover {
                background-color: rgba(0, 0, 0, 0.08);
                border-color: rgba(0, 0, 0, 0.15);
            }

            [data-theme="light"] .base-pose-frame-select:focus {
                background-color: rgba(0, 0, 0, 0.1);
                border-color: var(--accent);
            }

            /* Confirmation modal */
            .confirm-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.6);
                backdrop-filter: blur(8px);
                z-index: 10000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: fadeIn 0.2s ease;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .confirm-modal {
                background: var(--glass-bg);
                border: 1px solid var(--glass-border);
                border-radius: 16px;
                padding: 24px;
                max-width: 450px;
                width: 90%;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
                animation: slideUp 0.3s ease;
            }

            @keyframes slideUp {
                from {
                    transform: translateY(20px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }

            .confirm-modal-title {
                font-size: 18px;
                font-weight: 700;
                color: var(--text-primary);
                margin-bottom: 12px;
            }

            .confirm-modal-message {
                font-size: 14px;
                color: var(--text-secondary);
                line-height: 1.6;
                margin-bottom: 20px;
            }

            .confirm-modal-warning {
                padding: 12px;
                background: rgba(255, 159, 10, 0.1);
                border: 1px solid rgba(255, 159, 10, 0.3);
                border-radius: 8px;
                color: #ff9f0a;
                font-size: 13px;
                margin-bottom: 20px;
                font-weight: 500;
            }

            .confirm-modal-buttons {
                display: flex;
                gap: 12px;
                justify-content: flex-end;
            }

            .confirm-modal-btn {
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                border: 1px solid;
            }

            .confirm-modal-btn-cancel {
                background: rgba(255, 255, 255, 0.08);
                border-color: rgba(255, 255, 255, 0.15);
                color: var(--text-primary);
            }

            .confirm-modal-btn-cancel:hover {
                background: rgba(255, 255, 255, 0.12);
                border-color: rgba(255, 255, 255, 0.25);
            }

            .confirm-modal-btn-confirm {
                background: rgba(255, 59, 48, 0.15);
                border-color: rgba(255, 59, 48, 0.3);
                color: #ff3b30;
            }

            .confirm-modal-btn-confirm:hover {
                background: rgba(255, 59, 48, 0.25);
                border-color: rgba(255, 59, 48, 0.5);
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Setup base pose controls
     */
    setupBasePoseControls(model) {
        const container = document.getElementById('base-pose-controls');
        if (!container) return;

        // Stop existing range adjustment timer
        if (this.rangeAdjustTimer) {
            clearInterval(this.rangeAdjustTimer);
            this.rangeAdjustTimer = null;
        }

        container.innerHTML = '';

        if (!model || !model.threeObject) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = window.i18n?.t('noModel') || 'No model loaded';
            container.appendChild(emptyState);
            return;
        }

        // Store current model reference
        this.currentModel = model;

        // Save original base transform
        this.originalBaseTransform = {
            position: model.threeObject.position.clone(),
            quaternion: model.threeObject.quaternion.clone()
        };

        // Reset base pose
        this.basePose = {
            roll: 0,
            pitch: 0,
            yaw: 0,
            x: model.threeObject.position.x,
            y: model.threeObject.position.y,
            z: model.threeObject.position.z
        };

        // Reset xyz slider ranges based on initial values
        const initialX = this.basePose.x;
        const initialY = this.basePose.y;
        const initialZ = this.basePose.z;
        this.xyzSliderRanges = {
            x: { min: initialX - 0.3, max: initialX + 0.3 },
            y: { min: initialY - 0.3, max: initialY + 0.3 },
            z: { min: initialZ - 0.3, max: initialZ + 0.3 }
        };

        // Store frames data (cached)
        this.framesData = [];
        this.currentFrameIndex = -1;
        this.isFramesLoaded = false;
        this.sliderUpdateTimer = null;
        this.isDragging = false;

        // 1. Frame file name - FIRST ROW
        const frameFileGroup = document.createElement('div');
        frameFileGroup.className = 'base-pose-frame-group';
        frameFileGroup.style.cssText = 'margin-bottom: 8px;';
        
        const frameFileNameLabel = document.createElement('label');
        frameFileNameLabel.className = 'base-pose-frame-label';
        frameFileNameLabel.textContent = window.i18n?.t('frameFileName') || 'Frame File Name';
        
        const frameFileNameInput = document.createElement('input');
        frameFileNameInput.type = 'text';
        frameFileNameInput.className = 'base-pose-frame-input';
        frameFileNameInput.value = this.frameFileName;
        frameFileNameInput.placeholder = 'e.g., frame_go1_description.json';
        frameFileNameInput.id = 'frame-file-name-input';
        
        frameFileNameInput.addEventListener('change', () => {
            this.frameFileName = frameFileNameInput.value.trim();
        });
        
        frameFileGroup.appendChild(frameFileNameLabel);
        frameFileGroup.appendChild(frameFileNameInput);
        container.appendChild(frameFileGroup);

        // Save and Load buttons - SECOND ROW
        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 12px;';
        
        const saveFrameBtn = document.createElement('button');
        saveFrameBtn.id = 'save-frame-btn';
        saveFrameBtn.className = 'save-frame-btn';
        saveFrameBtn.textContent = 'Save';
        saveFrameBtn.style.cssText = 'width: auto !important; padding: 6px 12px !important; margin: 0 !important; flex: 1; font-size: 12px; white-space: nowrap;';
        saveFrameBtn.addEventListener('click', async () => {
            await this.saveFrame(model);
        });
        
        const loadFramesBtn = document.createElement('button');
        loadFramesBtn.id = 'load-frames-btn';
        loadFramesBtn.className = 'load-frames-btn';
        loadFramesBtn.textContent = 'Load';
        loadFramesBtn.style.cssText = 'width: auto !important; padding: 6px 12px !important; margin: 0 !important; flex: 1; font-size: 12px; white-space: nowrap;';
        loadFramesBtn.addEventListener('click', async () => {
            await this.loadFrameFile(model);
        });
        
        buttonRow.appendChild(saveFrameBtn);
        buttonRow.appendChild(loadFramesBtn);
        container.appendChild(buttonRow);

        // Create controls for orientation (roll, pitch, yaw)
        const orientationGroup = document.createElement('div');
        orientationGroup.className = 'base-pose-group';
        
        const orientationTitle = document.createElement('div');
        orientationTitle.className = 'base-pose-group-title';
        orientationTitle.textContent = window.i18n?.t('orientation') || 'Orientation';
        orientationGroup.appendChild(orientationTitle);

        ['roll', 'pitch', 'yaw'].forEach(axis => {
            const control = this.createBasePoseControl(axis, true, model);
            orientationGroup.appendChild(control);
        });

        container.appendChild(orientationGroup);

        // Create controls for position (x, y, z)
        const positionGroup = document.createElement('div');
        positionGroup.className = 'base-pose-group';
        
        const positionTitle = document.createElement('div');
        positionTitle.className = 'base-pose-group-title';
        positionTitle.textContent = window.i18n?.t('position') || 'Position (World)';
        positionGroup.appendChild(positionTitle);

        ['x', 'y', 'z'].forEach(axis => {
            const control = this.createBasePoseControl(axis, false, model);
            positionGroup.appendChild(control);
        });

        container.appendChild(positionGroup);

        // 4. Reset base pose button
        const resetBtn = document.createElement('button');
        resetBtn.id = 'reset-base-pose-btn';
        resetBtn.className = 'reset-base-pose-btn';
        resetBtn.textContent = window.i18n?.t('resetBasePose') || 'Reset Base Pose';
        resetBtn.addEventListener('click', () => {
            this.resetBasePose(model);
        });
        container.appendChild(resetBtn);

        // 5. World offset: x, y, z, timescale, apply offset (all in one row, compact)
        const worldOffsetGroup = document.createElement('div');
        worldOffsetGroup.className = 'base-pose-frame-group';
        worldOffsetGroup.style.cssText = 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap;';
        
        // X offset
        const xOffsetGroup = document.createElement('div');
        xOffsetGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const xLabel = document.createElement('label');
        xLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 20px;';
        xLabel.textContent = 'X:';
        const xInput = document.createElement('input');
        xInput.type = 'number';
        xInput.className = 'base-pose-frame-input';
        xInput.id = 'offset-x-input';
        xInput.value = (this.worldOffset.x || 0).toFixed(4);
        xInput.step = '0.0001';
        xInput.style.cssText = 'width: 70px; padding: 4px 6px; text-align: center;';
        xInput.placeholder = '0.0000';
        xInput.addEventListener('change', () => {
            const value = parseFloat(xInput.value);
            if (!isNaN(value)) {
                this.worldOffset.x = value;
                xInput.value = value.toFixed(4);
            } else {
                xInput.value = (this.worldOffset.x || 0).toFixed(4);
            }
        });
        xOffsetGroup.appendChild(xLabel);
        xOffsetGroup.appendChild(xInput);
        
        // Y offset
        const yOffsetGroup = document.createElement('div');
        yOffsetGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const yLabel = document.createElement('label');
        yLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 20px;';
        yLabel.textContent = 'Y:';
        const yInput = document.createElement('input');
        yInput.type = 'number';
        yInput.className = 'base-pose-frame-input';
        yInput.id = 'offset-y-input';
        yInput.value = (this.worldOffset.y || 0).toFixed(4);
        yInput.step = '0.0001';
        yInput.style.cssText = 'width: 70px; padding: 4px 6px; text-align: center;';
        yInput.placeholder = '0.0000';
        yInput.addEventListener('change', () => {
            const value = parseFloat(yInput.value);
            if (!isNaN(value)) {
                this.worldOffset.y = value;
                yInput.value = value.toFixed(4);
            } else {
                yInput.value = (this.worldOffset.y || 0).toFixed(4);
            }
        });
        yOffsetGroup.appendChild(yLabel);
        yOffsetGroup.appendChild(yInput);
        
        // Z offset
        const zOffsetGroup = document.createElement('div');
        zOffsetGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const zLabel = document.createElement('label');
        zLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 20px;';
        zLabel.textContent = 'Z:';
        const zInput = document.createElement('input');
        zInput.type = 'number';
        zInput.className = 'base-pose-frame-input';
        zInput.id = 'offset-z-input';
        zInput.value = (this.worldOffset.z || 0).toFixed(4);
        zInput.step = '0.0001';
        zInput.style.cssText = 'width: 70px; padding: 4px 6px; text-align: center;';
        zInput.placeholder = '0.0000';
        zInput.addEventListener('change', () => {
            const value = parseFloat(zInput.value);
            if (!isNaN(value)) {
                this.worldOffset.z = value;
                zInput.value = value.toFixed(4);
            } else {
                zInput.value = (this.worldOffset.z || 0).toFixed(4);
            }
        });
        zOffsetGroup.appendChild(zLabel);
        zOffsetGroup.appendChild(zInput);
        
        // Time scale
        const timeScaleGroup = document.createElement('div');
        timeScaleGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const timeScaleLabel = document.createElement('label');
        timeScaleLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        timeScaleLabel.textContent = window.i18n?.t('timeScale') || 'Scale:';
        const timeScaleInput = document.createElement('input');
        timeScaleInput.type = 'number';
        timeScaleInput.className = 'base-pose-frame-input';
        timeScaleInput.id = 'time-scale-input';
        timeScaleInput.value = '1.0';
        timeScaleInput.step = '0.01';
        timeScaleInput.min = '0.01';
        timeScaleInput.max = '10.0';
        timeScaleInput.style.cssText = 'width: 60px; padding: 4px 6px; text-align: center;';
        timeScaleInput.placeholder = '1.0';
        timeScaleGroup.appendChild(timeScaleLabel);
        timeScaleGroup.appendChild(timeScaleInput);
        
        // Time offset
        const timeOffsetGroup = document.createElement('div');
        timeOffsetGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const timeOffsetLabel = document.createElement('label');
        timeOffsetLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        timeOffsetLabel.textContent = window.i18n?.t('timeOffset') || 'T-Offset:';
        const timeOffsetInput = document.createElement('input');
        timeOffsetInput.type = 'number';
        timeOffsetInput.className = 'base-pose-frame-input';
        timeOffsetInput.id = 'time-offset-input';
        timeOffsetInput.value = '0.0';
        timeOffsetInput.step = '0.0001';
        timeOffsetInput.style.cssText = 'width: 70px; padding: 4px 6px; text-align: center;';
        timeOffsetInput.placeholder = '0.0000';
        const timeOffsetUnit = document.createElement('span');
        timeOffsetUnit.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        timeOffsetUnit.textContent = 's';
        timeOffsetGroup.appendChild(timeOffsetLabel);
        timeOffsetGroup.appendChild(timeOffsetInput);
        timeOffsetGroup.appendChild(timeOffsetUnit);
        
        // Apply Offset button
        const applyOffsetBtn = document.createElement('button');
        applyOffsetBtn.id = 'apply-offset-btn';
        applyOffsetBtn.className = 'load-frame-btn';
        applyOffsetBtn.textContent = window.i18n?.t('applyOffset') || 'Apply';
        applyOffsetBtn.style.cssText = 'padding: 6px 12px; margin: 0; flex-shrink: 0;';
        applyOffsetBtn.addEventListener('click', async () => {
            await this.applyOffsetToFile(model);
        });
        
        worldOffsetGroup.appendChild(xOffsetGroup);
        worldOffsetGroup.appendChild(yOffsetGroup);
        worldOffsetGroup.appendChild(zOffsetGroup);
        worldOffsetGroup.appendChild(timeScaleGroup);
        worldOffsetGroup.appendChild(timeOffsetGroup);
        worldOffsetGroup.appendChild(applyOffsetBtn);
        container.appendChild(worldOffsetGroup);

        // Add frame time input
        const frameTimeGroup = document.createElement('div');
        frameTimeGroup.className = 'base-pose-frame-group';
        
        const frameTimeLabel = document.createElement('label');
        frameTimeLabel.className = 'base-pose-frame-label';
        frameTimeLabel.textContent = window.i18n?.t('frameTime') || 'Frame Time (s)';
        
        const frameTimeInput = document.createElement('input');
        frameTimeInput.type = 'number';
        frameTimeInput.className = 'base-pose-frame-input';
        frameTimeInput.value = this.frameTime.toFixed(4);
        frameTimeInput.step = '0.0001';
        frameTimeInput.min = '0';
        frameTimeInput.placeholder = '0.0000';
        frameTimeInput.id = 'frame-time-input';
        
        frameTimeInput.addEventListener('change', () => {
            const value = parseFloat(frameTimeInput.value);
            if (!isNaN(value) && value >= 0) {
                this.frameTime = value;
                // Update slider position if frames are loaded
                this.updateFrameSlider();
            } else {
                frameTimeInput.value = this.frameTime.toFixed(4);
            }
        });
        
        frameTimeGroup.appendChild(frameTimeLabel);
        frameTimeGroup.appendChild(frameTimeInput);
        container.appendChild(frameTimeGroup);

        // Add frame slider for browsing frames
        const frameSliderGroup = document.createElement('div');
        frameSliderGroup.className = 'base-pose-frame-group';
        
        const frameSliderLabel = document.createElement('label');
        frameSliderLabel.className = 'base-pose-frame-label';
        frameSliderLabel.textContent = window.i18n?.t('frameSlider') || 'Browse Frames';
        
        const frameSliderContainer = document.createElement('div');
        frameSliderContainer.className = 'base-pose-frame-slider-container';
        frameSliderContainer.style.cssText = 'display: flex; align-items: center; gap: 8px; width: 100%;';
        
        // Previous frame button
        const prevFrameBtn = document.createElement('button');
        prevFrameBtn.className = 'frame-nav-btn frame-prev-btn';
        prevFrameBtn.id = 'prev-frame-btn';
        prevFrameBtn.textContent = '◀';
        prevFrameBtn.title = window.i18n?.t('prevFrame') || 'Previous Frame';
        prevFrameBtn.disabled = true;
        prevFrameBtn.addEventListener('click', () => {
            this.goToPreviousFrame(model);
        });
        
        const frameSlider = document.createElement('input');
        frameSlider.type = 'range';
        frameSlider.className = 'base-pose-frame-slider';
        frameSlider.id = 'frame-slider';
        frameSlider.min = '0';
        frameSlider.max = '0';
        frameSlider.value = '0';
        frameSlider.step = '0.001';
        frameSlider.style.cssText = 'flex: 1;';
        
        // Next frame button
        const nextFrameBtn = document.createElement('button');
        nextFrameBtn.className = 'frame-nav-btn frame-next-btn';
        nextFrameBtn.id = 'next-frame-btn';
        nextFrameBtn.textContent = '▶';
        nextFrameBtn.title = window.i18n?.t('nextFrame') || 'Next Frame';
        nextFrameBtn.disabled = true;
        nextFrameBtn.addEventListener('click', () => {
            this.goToNextFrame(model);
        });
        
        const frameSliderValue = document.createElement('span');
        frameSliderValue.className = 'base-pose-frame-slider-value';
        frameSliderValue.id = 'frame-slider-value';
        frameSliderValue.textContent = '-';
        frameSliderValue.style.cssText = 'min-width: 60px; text-align: right; font-size: 12px;';
        
        // Real-time update during drag using requestAnimationFrame for smooth performance
        frameSlider.addEventListener('mousedown', () => {
            this.isDragging = true;
        });
        
        frameSlider.addEventListener('input', () => {
            const index = parseInt(frameSlider.value);
            if (index >= 0 && index < this.framesData.length) {
                // Update display immediately
                const frameData = this.framesData[index];
                const sliderValue = document.getElementById('frame-slider-value');
                if (sliderValue && frameData && frameData.frame_time !== undefined) {
                    sliderValue.textContent = frameData.frame_time.toFixed(4) + 's';
                }
                
                // Use requestAnimationFrame for smooth real-time updates
                if (this.sliderUpdateTimer) {
                    cancelAnimationFrame(this.sliderUpdateTimer);
                }
                this.sliderUpdateTimer = requestAnimationFrame(() => {
                    this.loadFrameByIndex(index, model, true); // true = fast mode during drag
                });
            }
        });
        
        // Update frame on slider release (full update with UI)
        frameSlider.addEventListener('mouseup', () => {
            this.isDragging = false;
            const index = parseInt(frameSlider.value);
            if (index >= 0 && index < this.framesData.length) {
                // Clear any pending animation frame
                if (this.sliderUpdateTimer) {
                    cancelAnimationFrame(this.sliderUpdateTimer);
                    this.sliderUpdateTimer = null;
                }
                // Load frame with full UI update on release
                this.loadFrameByIndex(index, model, false);
            }
        });
        
        // Also handle change event for touch devices
        frameSlider.addEventListener('change', () => {
            if (!this.isDragging) {
                const index = parseInt(frameSlider.value);
                if (index >= 0 && index < this.framesData.length) {
                    // Clear any pending animation frame
                    if (this.sliderUpdateTimer) {
                        cancelAnimationFrame(this.sliderUpdateTimer);
                        this.sliderUpdateTimer = null;
                    }
                    // Load frame with full UI update
                    this.loadFrameByIndex(index, model, false);
                }
            }
        });
        
        frameSliderContainer.appendChild(prevFrameBtn);
        frameSliderContainer.appendChild(frameSlider);
        frameSliderContainer.appendChild(nextFrameBtn);
        frameSliderContainer.appendChild(frameSliderValue);
        frameSliderGroup.appendChild(frameSliderLabel);
        frameSliderGroup.appendChild(frameSliderContainer);
        container.appendChild(frameSliderGroup);

        // 8. LaFAN section - compact layout
        const interpolateSection = document.createElement('div');
        interpolateSection.className = 'interpolate-section';
        interpolateSection.style.marginTop = '16px';
        interpolateSection.style.padding = '12px';
        interpolateSection.style.background = 'rgba(255, 255, 255, 0.04)';
        interpolateSection.style.border = '1px solid rgba(255, 255, 255, 0.08)';
        interpolateSection.style.borderRadius = '10px';

        const interpolateTitle = document.createElement('div');
        interpolateTitle.style.fontSize = '12px';
        interpolateTitle.style.fontWeight = '600';
        interpolateTitle.style.color = 'var(--text-secondary)';
        interpolateTitle.style.marginBottom = '8px';
        interpolateTitle.textContent = window.i18n?.t('interpolateFrames') || 'Interpolate to LaFAN Format';

        // Compact input row: Frequency, First Extend, Last Extend, Z Offset
        const compactInputRow = document.createElement('div');
        compactInputRow.style.cssText = 'display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px;';

        // Frequency
        const freqGroup = document.createElement('div');
        freqGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const freqLabel = document.createElement('label');
        freqLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        freqLabel.textContent = (window.i18n?.t('frequency') || 'Freq') + ':';
        const freqInput = document.createElement('input');
        freqInput.type = 'number';
        freqInput.id = 'interpolate-freq-input';
        freqInput.value = '30';
        freqInput.min = '1';
        freqInput.max = '120';
        freqInput.step = '1';
        freqInput.style.cssText = 'width: 50px; padding: 4px 6px; text-align: center; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; color: var(--text-primary); font-size: 12px;';
        const freqUnit = document.createElement('span');
        freqUnit.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        freqUnit.textContent = 'Hz';
        freqGroup.appendChild(freqLabel);
        freqGroup.appendChild(freqInput);
        freqGroup.appendChild(freqUnit);

        // First frame extend
        const firstFrameExtGroup = document.createElement('div');
        firstFrameExtGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const firstFrameExtLabel = document.createElement('label');
        firstFrameExtLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        firstFrameExtLabel.textContent = (window.i18n?.t('firstFrameExtend') || 'First') + ':';
        const firstFrameExtInput = document.createElement('input');
        firstFrameExtInput.type = 'number';
        firstFrameExtInput.id = 'first-frame-extend-input';
        firstFrameExtInput.value = '0';
        firstFrameExtInput.min = '0';
        firstFrameExtInput.step = '0.01';
        firstFrameExtInput.style.cssText = 'width: 50px; padding: 4px 6px; text-align: center; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; color: var(--text-primary); font-size: 12px;';
        const firstFrameExtUnit = document.createElement('span');
        firstFrameExtUnit.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        firstFrameExtUnit.textContent = 's';
        firstFrameExtGroup.appendChild(firstFrameExtLabel);
        firstFrameExtGroup.appendChild(firstFrameExtInput);
        firstFrameExtGroup.appendChild(firstFrameExtUnit);

        // Last frame extend
        const lastFrameExtGroup = document.createElement('div');
        lastFrameExtGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const lastFrameExtLabel = document.createElement('label');
        lastFrameExtLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        lastFrameExtLabel.textContent = (window.i18n?.t('lastFrameExtend') || 'Last') + ':';
        const lastFrameExtInput = document.createElement('input');
        lastFrameExtInput.type = 'number';
        lastFrameExtInput.id = 'last-frame-extend-input';
        lastFrameExtInput.value = '0';
        lastFrameExtInput.min = '0';
        lastFrameExtInput.step = '0.01';
        lastFrameExtInput.style.cssText = 'width: 50px; padding: 4px 6px; text-align: center; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; color: var(--text-primary); font-size: 12px;';
        const lastFrameExtUnit = document.createElement('span');
        lastFrameExtUnit.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        lastFrameExtUnit.textContent = 's';
        lastFrameExtGroup.appendChild(lastFrameExtLabel);
        lastFrameExtGroup.appendChild(lastFrameExtInput);
        lastFrameExtGroup.appendChild(lastFrameExtUnit);

        // Z-axis offset
        const lafanZOffsetGroup = document.createElement('div');
        lafanZOffsetGroup.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const lafanZOffsetLabel = document.createElement('label');
        lafanZOffsetLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 500; min-width: 50px;';
        lafanZOffsetLabel.textContent = (window.i18n?.t('zAxisOffset') || 'Z-Offset') + ':';
        const zOffsetInput = document.createElement('input');
        zOffsetInput.type = 'number';
        zOffsetInput.id = 'z-axis-offset-input';
        zOffsetInput.value = '0';
        zOffsetInput.step = '0.0001';
        zOffsetInput.style.cssText = 'width: 60px; padding: 4px 6px; text-align: center; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; color: var(--text-primary); font-size: 12px;';
        const lafanZOffsetUnit = document.createElement('span');
        lafanZOffsetUnit.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        lafanZOffsetUnit.textContent = 'm';
        lafanZOffsetGroup.appendChild(lafanZOffsetLabel);
        lafanZOffsetGroup.appendChild(zOffsetInput);
        lafanZOffsetGroup.appendChild(lafanZOffsetUnit);

        compactInputRow.appendChild(freqGroup);
        compactInputRow.appendChild(firstFrameExtGroup);
        compactInputRow.appendChild(lastFrameExtGroup);
        compactInputRow.appendChild(lafanZOffsetGroup);

        // Interpolate button
        const interpolateBtn = document.createElement('button');
        interpolateBtn.id = 'interpolate-frames-btn';
        interpolateBtn.className = 'interpolate-frames-btn';
        interpolateBtn.textContent = window.i18n?.t('interpolateAndSave') || 'Interpolate & Save';
        interpolateBtn.style.cssText = 'margin-top: 0;';
        interpolateBtn.addEventListener('click', async () => {
            const firstFrameExtend = parseFloat(firstFrameExtInput.value) || 0;
            const lastFrameExtend = parseFloat(lastFrameExtInput.value) || 0;
            const zOffset = parseFloat(zOffsetInput.value) || 0;
            await this.interpolateFrames(model, parseFloat(freqInput.value) || 30, firstFrameExtend, lastFrameExtend, zOffset);
        });

        interpolateSection.appendChild(interpolateTitle);
        interpolateSection.appendChild(compactInputRow);
        interpolateSection.appendChild(interpolateBtn);
        container.appendChild(interpolateSection);

        // Start dynamic range adjustment timer for xyz sliders
        this.startRangeAdjustment();
    }

    /**
     * Create base pose control element
     */
    createBasePoseControl(axis, isRotation, model) {
        const div = document.createElement('div');
        div.className = 'base-pose-control';

        // Header with axis name
        const header = document.createElement('div');
        header.className = 'base-pose-header';

        const name = document.createElement('div');
        name.className = 'base-pose-name';
        // Handle offset axis names
        if (axis.startsWith('offset_')) {
            name.textContent = axis.replace('offset_', '').toUpperCase() + ' Offset';
        } else {
            name.textContent = axis.toUpperCase();
        }

        header.appendChild(name);

        // Slider row
        const sliderRow = document.createElement('div');
        sliderRow.className = 'base-pose-slider-row';

        // Set limits based on whether it's rotation or position
        let min, max, step, initialValue;
        
        if (isRotation) {
            min = -Math.PI;
            max = Math.PI;
            step = 0.001;  // 更细的粒度
            initialValue = 0;
        } else {
            // Check if this is an offset control
            if (axis.startsWith('offset_')) {
                const offsetAxis = axis.replace('offset_', '');
                min = -10.0;   // Allow larger range for offset
                max = 10.0;
                step = 0.0001;
                initialValue = this.worldOffset[offsetAxis] || 0;
            } else {
                // For xyz axes, use current value ± 0.3
                initialValue = this.basePose[axis];
                min = initialValue - 0.3;
                max = initialValue + 0.3;
                step = 0.0001; // 更细的粒度
                
                // Store initial range
                if (['x', 'y', 'z'].includes(axis)) {
                    this.xyzSliderRanges[axis] = { min, max };
                }
            }
        }

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'base-pose-slider';
        slider.setAttribute('data-axis', axis);
        slider.min = min;
        slider.max = max;
        slider.value = initialValue;
        slider.step = step;

        // Editable min/max labels
        const minLabel = document.createElement('input');
        minLabel.type = 'number';
        minLabel.className = 'base-pose-limit-min editable-limit';
        minLabel.step = '0.0001';

        const maxLabel = document.createElement('input');
        maxLabel.type = 'number';
        maxLabel.className = 'base-pose-limit-max editable-limit';
        maxLabel.step = '0.0001';

        // Value input
        const valueInput = document.createElement('input');
        valueInput.type = 'number';
        valueInput.className = 'base-pose-value-input';
        valueInput.setAttribute('data-axis-input', axis);
        valueInput.step = '0.0001';

        const valueUnit = document.createElement('span');
        valueUnit.className = 'base-pose-value-unit';
        valueUnit.textContent = isRotation ? (this.angleUnit === 'deg' ? '°' : 'rad') : 'm';

        const updateLabels = () => {
            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);

            if (isRotation && this.angleUnit === 'deg') {
                minLabel.value = (currentMin * 180 / Math.PI).toFixed(4);
                maxLabel.value = (currentMax * 180 / Math.PI).toFixed(4);
            } else {
                minLabel.value = currentMin.toFixed(4);
                maxLabel.value = currentMax.toFixed(4);
            }
        };

        const updateValueInput = () => {
            const value = parseFloat(slider.value);
            if (isRotation && this.angleUnit === 'deg') {
                valueInput.value = (value * 180 / Math.PI).toFixed(4);
            } else {
                valueInput.value = value.toFixed(4);
            }
        };

        updateLabels();
        updateValueInput();

        // Min label change event
        minLabel.addEventListener('change', () => {
            let inputValue = parseFloat(minLabel.value);
            if (isNaN(inputValue)) {
                updateLabels();
                return;
            }

            let valueInUnit = isRotation && this.angleUnit === 'deg' ?
                inputValue * Math.PI / 180 :
                inputValue;

            const currentMax = parseFloat(slider.max);
            if (valueInUnit >= currentMax) {
                updateLabels();
                return;
            }

            slider.min = valueInUnit;
            slider.step = (slider.max - slider.min) / 1000;
            updateLabels();
        });

        // Max label change event
        maxLabel.addEventListener('change', () => {
            let inputValue = parseFloat(maxLabel.value);
            if (isNaN(inputValue)) {
                updateLabels();
                return;
            }

            let valueInUnit = isRotation && this.angleUnit === 'deg' ?
                inputValue * Math.PI / 180 :
                inputValue;

            const currentMin = parseFloat(slider.min);
            if (valueInUnit <= currentMin) {
                updateLabels();
                return;
            }

            slider.max = valueInUnit;
            slider.step = (slider.max - slider.min) / 1000;
            updateLabels();
        });

        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'base-pose-slider-container';
        sliderContainer.appendChild(slider);

        const valueInputContainer = document.createElement('div');
        valueInputContainer.className = 'base-pose-value-input-container';
        valueInputContainer.appendChild(valueInput);
        valueInputContainer.appendChild(valueUnit);

        sliderRow.appendChild(minLabel);
        sliderRow.appendChild(sliderContainer);
        sliderRow.appendChild(maxLabel);
        sliderRow.appendChild(valueInputContainer);

        div.appendChild(header);
        div.appendChild(sliderRow);

        // Slider input event
        slider.addEventListener('input', () => {
            const value = parseFloat(slider.value);
            if (axis.startsWith('offset_')) {
                const offsetAxis = axis.replace('offset_', '');
                this.worldOffset[offsetAxis] = value;
            } else {
                this.basePose[axis] = value;
            }
            updateValueInput();
            if (!axis.startsWith('offset_')) {
                this.updateBasePose(model);
            }
        });

        // Manual input event
        valueInput.addEventListener('change', () => {
            let inputValue = parseFloat(valueInput.value);
            if (isNaN(inputValue)) {
                updateValueInput();
                return;
            }

            let valueInUnit = isRotation && this.angleUnit === 'deg' ?
                inputValue * Math.PI / 180 :
                inputValue;

            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            valueInUnit = Math.max(currentMin, Math.min(currentMax, valueInUnit));

            slider.value = valueInUnit;
            this.basePose[axis] = valueInUnit;
            updateValueInput();
            this.updateBasePose(model);
        });

        // Save update function for angle unit changes
        div._updateDisplay = () => {
            updateValueInput();
            updateLabels();
            if (isRotation) {
                valueUnit.textContent = this.angleUnit === 'deg' ? '°' : 'rad';
            }
        };

        return div;
    }

    /**
     * Update base pose of the model
     */
    updateBasePose(model) {
        if (!model || !model.threeObject) return;

        const { roll, pitch, yaw, x, y, z } = this.basePose;

        // Update position
        model.threeObject.position.set(x, y, z);

        // Update rotation using Euler angles (ZYX order)
        const euler = new THREE.Euler(roll, pitch, yaw, 'XYZ');
        model.threeObject.quaternion.setFromEuler(euler);

        // Redraw scene
        this.sceneManager.redraw();
        this.sceneManager.render();

        // Trigger measurement update
        if (this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Reset base pose to original transform
     */
    resetBasePose(model) {
        if (!model || !model.threeObject) return;

        // Reset to original transform
        if (this.originalBaseTransform) {
            model.threeObject.position.copy(this.originalBaseTransform.position);
            model.threeObject.quaternion.copy(this.originalBaseTransform.quaternion);
        } else {
            model.threeObject.position.set(0, 0, 0);
            model.threeObject.quaternion.set(0, 0, 0, 1);
        }

        // Reset internal state
        this.basePose = {
            roll: 0,
            pitch: 0,
            yaw: 0,
            x: model.threeObject.position.x,
            y: model.threeObject.position.y,
            z: model.threeObject.position.z
        };

        // Update all sliders
        const sliders = document.querySelectorAll('.base-pose-slider');
        sliders.forEach(slider => {
            const axis = slider.getAttribute('data-axis');
            slider.value = this.basePose[axis];
            
            const control = slider.closest('.base-pose-control');
            if (control && control._updateDisplay) {
                control._updateDisplay();
            }
        });

        // Redraw scene
        this.sceneManager.redraw();
        this.sceneManager.render();

        // Trigger measurement update
        if (this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Load frame from JSON file or JSON string
     * @param {string} pathOrJson - File path or JSON string
     * @param {object} model - Robot model
     */
    async loadFrame(pathOrJson, model) {
        if (!model) {
            this.showNotification(window.i18n?.t('noModelLoaded') || 'No model loaded', 'error');
            return;
        }

        try {
            let frameData;
            
            // Check if input is JSON string
            if (pathOrJson.trim().startsWith('{')) {
                // Parse as JSON
                try {
                    frameData = JSON.parse(pathOrJson);
                } catch (e) {
                    this.showNotification(window.i18n?.t('invalidJSON') || 'Invalid JSON format', 'error');
                    return;
                }
            } else {
                // Try to fetch from URL/path
                try {
                    const response = await fetch(pathOrJson);
                    if (!response.ok) {
                        throw new Error(`Failed to load: ${response.status}`);
                    }
                    frameData = await response.json();
                } catch (e) {
                    this.showNotification(
                        window.i18n?.t('frameLoadFailed') || `Failed to load frame: ${e.message}`,
                        'error'
                    );
                    return;
                }
            }

            // Validate frame data structure
            if (!frameData || typeof frameData !== 'object') {
                this.showNotification(window.i18n?.t('invalidFrameData') || 'Invalid frame data', 'error');
                return;
            }

            // Apply frame time
            if (typeof frameData.frame_time === 'number') {
                this.frameTime = frameData.frame_time;
                const frameTimeInput = document.getElementById('frame-time-input');
                if (frameTimeInput) {
                    frameTimeInput.value = this.frameTime.toFixed(4);
                }
            }

            // Apply joint angles
            if (frameData.joint_angles && typeof frameData.joint_angles === 'object') {
                Object.entries(frameData.joint_angles).forEach(([jointName, angle]) => {
                    const joint = model.joints.get(jointName);
                    if (joint && typeof angle === 'number') {
                        // Use ModelLoaderFactory to set joint angle
                        ModelLoaderFactory.setJointAngle(model, jointName, angle);
                        joint.currentValue = angle;
                        
                        // Update joint slider if exists
                        const slider = document.querySelector(`.joint-slider[data-joint="${jointName}"]`);
                        if (slider) {
                            slider.value = angle;
                            const control = slider.closest('.joint-control');
                            if (control && control._updateDisplay) {
                                control._updateDisplay();
                            }
                        }
                    }
                });
            }

            // Apply base pose RPY
            if (frameData.rpy && typeof frameData.rpy === 'object') {
                if (typeof frameData.rpy.roll === 'number') this.basePose.roll = frameData.rpy.roll;
                if (typeof frameData.rpy.pitch === 'number') this.basePose.pitch = frameData.rpy.pitch;
                if (typeof frameData.rpy.yaw === 'number') this.basePose.yaw = frameData.rpy.yaw;
            }

            // Apply base pose position
            if (frameData.pos_world && typeof frameData.pos_world === 'object') {
                if (typeof frameData.pos_world.x === 'number') this.basePose.x = frameData.pos_world.x;
                if (typeof frameData.pos_world.y === 'number') this.basePose.y = frameData.pos_world.y;
                if (typeof frameData.pos_world.z === 'number') this.basePose.z = frameData.pos_world.z;
            }

            // Update base pose transform
            this.updateBasePose(model);

            // Update all base pose sliders
            const sliders = document.querySelectorAll('.base-pose-slider');
            sliders.forEach(slider => {
                const axis = slider.getAttribute('data-axis');
                if (this.basePose[axis] !== undefined) {
                    slider.value = this.basePose[axis];
                    const control = slider.closest('.base-pose-control');
                    if (control && control._updateDisplay) {
                        control._updateDisplay();
                    }
                }
            });

            // Redraw scene
            this.sceneManager.updateEnvironment();
            this.sceneManager.redraw();
            this.sceneManager.render();

            // Trigger measurement update
            if (this.sceneManager.onMeasurementUpdate) {
                this.sceneManager.onMeasurementUpdate();
            }

            console.log('Frame loaded successfully:', frameData);
            this.showNotification(window.i18n?.t('frameLoaded') || 'Frame loaded successfully', 'success');

        } catch (error) {
            console.error('Error loading frame:', error);
            this.showNotification(
                window.i18n?.t('frameLoadError') || `Error loading frame: ${error.message}`,
                'error'
            );
        }
    }

    /**
     * Get frame file path from user input
     */
    getFrameFilePath(model) {
        // Use user input file name
        if (this.frameFileName && this.frameFileName.trim() !== '') {
            const fileName = this.frameFileName.trim();
            // Ensure it starts with ./frames/ if not already a full path
            if (!fileName.startsWith('./') && !fileName.startsWith('/')) {
                return `./frames/${fileName}`;
            }
            return fileName;
        }
        // Default fallback if no file name provided
        return './frames/frame_robot.json';
    }

    /**
     * Save current frame to JSON file and reload frames
     */
    async saveFrame(model) {
        if (!model) {
            console.warn('No model loaded, cannot save frame');
            this.showNotification(window.i18n?.t('noModelLoaded') || 'No model loaded', 'error');
            return;
        }

        // Validate file name
        if (!this.frameFileName || this.frameFileName.trim() === '') {
            this.showNotification(window.i18n?.t('frameFileNameRequired') || 'Please enter a frame file name', 'error');
            const frameFileNameInput = document.getElementById('frame-file-name-input');
            if (frameFileNameInput) {
                frameFileNameInput.focus();
            }
            return;
        }

        // Collect joint angles
        const jointAngles = {};
        if (model.joints) {
            model.joints.forEach((joint, name) => {
                if (joint.type !== 'fixed') {
                    const currentValue = joint.currentValue !== undefined ? joint.currentValue : 0;
                    jointAngles[name] = currentValue;
                }
            });
        }

        // Create frame data
        const frameData = {
            frame_time: this.frameTime,
            joint_angles: jointAngles,
            rpy: {
                roll: this.basePose.roll,
                pitch: this.basePose.pitch,
                yaw: this.basePose.yaw
            },
            pos_world: {
                x: this.basePose.x,
                y: this.basePose.y,
                z: this.basePose.z
            }
        };

        // Convert to JSON
        const jsonString = JSON.stringify(frameData, null, 2);

        // Copy to clipboard using modern Clipboard API
        try {
            await navigator.clipboard.writeText(jsonString);
            console.log('Frame copied to clipboard:', frameData);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }

        // Save to file via backend API
        const filePath = this.getFrameFilePath(model);
        try {
            // Remember current frameTime before saving (to restore position after reload)
            const savedFrameTime = this.frameTime;
            
            // Ensure backend config is initialized
            await backendConfig.init();
            const response = await fetch(backendConfig.getApiUrl('api/save-frame-file'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    file: filePath,
                    frame: frameData,
                    frameTime: this.frameTime
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to save: ${response.status}`);
            }

            const result = await response.json();
            console.log('Frame saved to file:', result);

            // Reload frames after saving
            await this.loadFrameFile(model);

            // Restore to the saved frame position (by frameTime)
            // This ensures we stay at the saved frame position, not reset to first frame
            if (this.framesData.length > 0) {
                const closestIndex = this.findClosestFrameIndex(savedFrameTime);
                if (closestIndex >= 0) {
                    this.loadFrameByIndex(closestIndex, model, false);
                }
            }

            // Show success notification
            const message = window.i18n?.t('frameSaved') || `Frame saved (${result.count} frames total)`;
            this.showNotification(message, 'success');
        } catch (error) {
            console.error('Error saving frame file:', error);
            this.showNotification(
                window.i18n?.t('frameSaveError') || `Error saving frame: ${error.message}`,
                'error'
            );
        }
    }

    /**
     * Show confirmation modal
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {string} warning - Warning message (optional)
     * @returns {Promise<boolean>} - True if confirmed, false if cancelled
     */
    showConfirmModal(title, message, warning = '') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-modal-overlay';
            
            const modal = document.createElement('div');
            modal.className = 'confirm-modal';
            
            const modalTitle = document.createElement('div');
            modalTitle.className = 'confirm-modal-title';
            modalTitle.textContent = title;
            
            const modalMessage = document.createElement('div');
            modalMessage.className = 'confirm-modal-message';
            modalMessage.textContent = message;
            
            modal.appendChild(modalTitle);
            modal.appendChild(modalMessage);
            
            if (warning) {
                const modalWarning = document.createElement('div');
                modalWarning.className = 'confirm-modal-warning';
                modalWarning.textContent = warning;
                modal.appendChild(modalWarning);
            }
            
            const buttons = document.createElement('div');
            buttons.className = 'confirm-modal-buttons';
            
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'confirm-modal-btn confirm-modal-btn-cancel';
            cancelBtn.textContent = window.i18n?.t('cancel') || 'Cancel';
            cancelBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(false);
            });
            
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'confirm-modal-btn confirm-modal-btn-confirm';
            confirmBtn.textContent = window.i18n?.t('confirm') || 'Confirm';
            confirmBtn.addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(true);
            });
            
            buttons.appendChild(cancelBtn);
            buttons.appendChild(confirmBtn);
            modal.appendChild(buttons);
            
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            
            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(false);
                }
            });
        });
    }

    /**
     * Apply world offset to all frames in the file and save
     */
    async applyOffsetToFile(model) {
        if (!model) {
            this.showNotification(window.i18n?.t('noModelLoaded') || 'No model loaded', 'error');
            return;
        }

        // Validate file name
        if (!this.frameFileName || this.frameFileName.trim() === '') {
            this.showNotification(window.i18n?.t('frameFileNameRequired') || 'Please enter a frame file name', 'error');
            const frameFileNameInput = document.getElementById('frame-file-name-input');
            if (frameFileNameInput) {
                frameFileNameInput.focus();
            }
            return;
        }

        // Get time scale value
        const timeScaleInput = document.getElementById('time-scale-input');
        const timeScale = timeScaleInput ? parseFloat(timeScaleInput.value) : 1.0;
        
        if (isNaN(timeScale) || timeScale <= 0) {
            this.showNotification(window.i18n?.t('invalidTimeScale') || 'Invalid time scale value', 'error');
            return;
        }

        // Get time offset value
        const timeOffsetInput = document.getElementById('time-offset-input');
        const timeOffset = timeOffsetInput ? parseFloat(timeOffsetInput.value) : 0.0;
        
        if (isNaN(timeOffset)) {
            this.showNotification(window.i18n?.t('invalidTimeOffset') || 'Invalid time offset value', 'error');
            return;
        }

        // Show confirmation dialog
        let confirmMessage = `This will modify all frames in the file with offset (${this.worldOffset.x.toFixed(4)}, ${this.worldOffset.y.toFixed(4)}, ${this.worldOffset.z.toFixed(4)}), time scale ${timeScale.toFixed(2)}x`;
        if (timeOffset !== 0) {
            confirmMessage += `, and time offset ${timeOffset >= 0 ? '+' : ''}${timeOffset.toFixed(4)}s`;
        }
        confirmMessage += '.';
        
        const confirmed = await this.showConfirmModal(
            window.i18n?.t('confirmApplyOffset') || 'Apply Offset & Time Scale',
            window.i18n?.t('confirmApplyOffsetMessage') || confirmMessage,
            window.i18n?.t('backupWarning') || '⚠️ Please backup your file before proceeding! This operation cannot be undone.'
        );
        
        if (!confirmed) {
            return;
        }

        const applyBtn = document.getElementById('apply-offset-btn');
        if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.textContent = window.i18n?.t('applying') || 'Applying...';
        }

        try {
            const filePath = this.getFrameFilePath(model);
            
            // Send file path and offset to backend, backend will handle the rest
            await backendConfig.init();
            const response = await fetch(backendConfig.getApiUrl('api/apply-offset'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    file: filePath,
                    offset: {
                        x: this.worldOffset.x,
                        y: this.worldOffset.y,
                        z: this.worldOffset.z
                    },
                    timeScale: timeScale,
                    timeOffset: timeOffset
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to apply offset: ${response.status}`);
            }

            const result = await response.json();
            
            if (result.error) {
                throw new Error(result.error);
            }

            // Reload frames after saving
            await this.loadFrameFile(model);

            const message = window.i18n?.t('offsetApplied') || `Offset applied to ${result.count || 0} frames`;
            this.showNotification(message, 'success');

        } catch (error) {
            console.error('Error applying offset:', error);
            this.showNotification(
                window.i18n?.t('applyOffsetError') || `Error applying offset: ${error.message}`,
                'error'
            );
        } finally {
            if (applyBtn) {
                applyBtn.disabled = false;
                applyBtn.textContent = window.i18n?.t('applyOffset') || 'Apply Offset';
            }
        }
    }

    /**
     * Load frame file for current robot and cache all frames
     */
    async loadFrameFile(model) {
        if (!model) return;

        // Validate file name
        if (!this.frameFileName || this.frameFileName.trim() === '') {
            this.showNotification(window.i18n?.t('frameFileNameRequired') || 'Please enter a frame file name', 'error');
            const frameFileNameInput = document.getElementById('frame-file-name-input');
            if (frameFileNameInput) {
                frameFileNameInput.focus();
            }
            return;
        }

        const loadBtn = document.getElementById('load-frames-btn');
        if (loadBtn) {
            loadBtn.disabled = true;
            loadBtn.textContent = window.i18n?.t('loadingFrames') || 'Loading...';
        }

        const filePath = this.getFrameFilePath(model);
        
        try {
            // Ensure backend config is initialized
            await backendConfig.init();
            const response = await fetch(`${backendConfig.getApiUrl('api/read-frame-file')}?file=${encodeURIComponent(filePath)}`);
            
            if (!response.ok) {
                throw new Error(`Failed to load: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                console.warn('Error loading frame file:', data.error);
                this.framesData = [];
                this.isFramesLoaded = false;
                this.updateFrameSlider();
                if (loadBtn) {
                    loadBtn.disabled = false;
                    loadBtn.textContent = window.i18n?.t('loadFrames') || 'Load Frames';
                }
                this.showNotification(
                    window.i18n?.t('frameLoadError') || `Error loading frames: ${data.error}`,
                    'error'
                );
                return;
            }
            
            // Cache all frames
            this.framesData = data.frames || [];
            this.isFramesLoaded = true;
            
            // Update slider
            this.updateFrameSlider();
            
            // Show success notification
            const message = window.i18n?.t('framesLoaded') || `${this.framesData.length} frames loaded`;
            this.showNotification(message, 'success');
            
            // If frames exist, try to load the frame closest to current frameTime
            if (this.framesData.length > 0) {
                const closestIndex = this.findClosestFrameIndex(this.frameTime);
                if (closestIndex >= 0) {
                    this.loadFrameByIndex(closestIndex, model, false);
                }
            }
            
        } catch (error) {
            console.error('Error loading frame file:', error);
            this.framesData = [];
            this.isFramesLoaded = false;
            this.updateFrameSlider();
            this.showNotification(
                window.i18n?.t('frameLoadError') || `Error loading frames: ${error.message}`,
                'error'
            );
        } finally {
            if (loadBtn) {
                loadBtn.disabled = false;
                loadBtn.textContent = window.i18n?.t('loadFrames') || 'Load Frames';
            }
        }
    }

    /**
     * Find closest frame index by frame_time
     */
    findClosestFrameIndex(targetTime) {
        if (this.framesData.length === 0) return -1;
        
        let closestIndex = 0;
        let minDiff = Math.abs((this.framesData[0].frame_time || 0) - targetTime);
        
        for (let i = 1; i < this.framesData.length; i++) {
            const diff = Math.abs((this.framesData[i].frame_time || 0) - targetTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestIndex = i;
            }
        }
        
        return closestIndex;
    }

    /**
     * Update frame slider based on loaded frames
     */
    updateFrameSlider() {
        const slider = document.getElementById('frame-slider');
        const sliderValue = document.getElementById('frame-slider-value');
        const prevBtn = document.getElementById('prev-frame-btn');
        const nextBtn = document.getElementById('next-frame-btn');
        
        if (!slider || !sliderValue) return;
        
        if (!this.isFramesLoaded || this.framesData.length === 0) {
            slider.min = '0';
            slider.max = '0';
            slider.value = '0';
            slider.disabled = true;
            sliderValue.textContent = '-';
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            return;
        }
        
        slider.disabled = false;
        slider.min = '0';
        slider.max = String(this.framesData.length - 1);
        
        // Find current frame index
        const currentIndex = this.findClosestFrameIndex(this.frameTime);
        slider.value = String(currentIndex);
        this.currentFrameIndex = currentIndex;
        
        // Update display
        const currentFrame = this.framesData[currentIndex];
        if (currentFrame) {
            sliderValue.textContent = (currentFrame.frame_time || 0).toFixed(4) + 's';
        }
        
        // Update navigation buttons state
        if (prevBtn) {
            prevBtn.disabled = currentIndex <= 0;
        }
        if (nextBtn) {
            nextBtn.disabled = currentIndex >= this.framesData.length - 1;
        }
    }

    /**
     * Go to previous frame
     */
    goToPreviousFrame(model) {
        if (!this.isFramesLoaded || this.framesData.length === 0) return;
        
        const currentIndex = this.currentFrameIndex >= 0 ? this.currentFrameIndex : this.findClosestFrameIndex(this.frameTime);
        if (currentIndex > 0) {
            this.loadFrameByIndex(currentIndex - 1, model, false);
            // Update slider position
            const slider = document.getElementById('frame-slider');
            if (slider) {
                slider.value = String(currentIndex - 1);
            }
        }
    }

    /**
     * Go to next frame
     */
    goToNextFrame(model) {
        if (!this.isFramesLoaded || this.framesData.length === 0) return;
        
        const currentIndex = this.currentFrameIndex >= 0 ? this.currentFrameIndex : this.findClosestFrameIndex(this.frameTime);
        if (currentIndex < this.framesData.length - 1) {
            this.loadFrameByIndex(currentIndex + 1, model, false);
            // Update slider position
            const slider = document.getElementById('frame-slider');
            if (slider) {
                slider.value = String(currentIndex + 1);
            }
        }
    }

    /**
     * Load frame by index from cached data
     * @param {number} index - Frame index
     * @param {object} model - Robot model
     * @param {boolean} fastMode - If true, skip UI updates for better performance during drag
     */
    loadFrameByIndex(index, model, fastMode = false) {
        if (index < 0 || index >= this.framesData.length) return;
        
        const frameData = this.framesData[index];
        this.currentFrameIndex = index;
        
        // Update frame time
        if (typeof frameData.frame_time === 'number') {
            this.frameTime = frameData.frame_time;
            if (!fastMode) {
                const frameTimeInput = document.getElementById('frame-time-input');
                if (frameTimeInput) {
                    frameTimeInput.value = this.frameTime.toFixed(4);
                }
            }
        }
        
        // Apply joint angles (always needed for model update)
        if (frameData.joint_angles && typeof frameData.joint_angles === 'object') {
            Object.entries(frameData.joint_angles).forEach(([jointName, angle]) => {
                const joint = model.joints.get(jointName);
                if (joint && typeof angle === 'number') {
                    ModelLoaderFactory.setJointAngle(model, jointName, angle);
                    joint.currentValue = angle;
                    
                    // Update joint slider UI only if not in fast mode
                    if (!fastMode) {
                        const slider = document.querySelector(`.joint-slider[data-joint="${jointName}"]`);
                        if (slider) {
                            slider.value = angle;
                            const control = slider.closest('.joint-control');
                            if (control && control._updateDisplay) {
                                control._updateDisplay();
                            }
                        }
                    }
                }
            });
        }
        
        // Apply base pose RPY
        if (frameData.rpy && typeof frameData.rpy === 'object') {
            if (typeof frameData.rpy.roll === 'number') this.basePose.roll = frameData.rpy.roll;
            if (typeof frameData.rpy.pitch === 'number') this.basePose.pitch = frameData.rpy.pitch;
            if (typeof frameData.rpy.yaw === 'number') this.basePose.yaw = frameData.rpy.yaw;
        }
        
        // Apply base pose position
        if (frameData.pos_world && typeof frameData.pos_world === 'object') {
            if (typeof frameData.pos_world.x === 'number') this.basePose.x = frameData.pos_world.x;
            if (typeof frameData.pos_world.y === 'number') this.basePose.y = frameData.pos_world.y;
            if (typeof frameData.pos_world.z === 'number') this.basePose.z = frameData.pos_world.z;
        }
        
        // Update base pose transform (always needed)
        this.updateBasePose(model);
        
        // Update base pose sliders UI only if not in fast mode
        if (!fastMode) {
            const sliders = document.querySelectorAll('.base-pose-slider');
            sliders.forEach(slider => {
                const axis = slider.getAttribute('data-axis');
                if (this.basePose[axis] !== undefined) {
                    slider.value = this.basePose[axis];
                    const control = slider.closest('.base-pose-control');
                    if (control && control._updateDisplay) {
                        control._updateDisplay();
                    }
                }
            });
        }
        
        // Update slider display (always update for visual feedback)
        const slider = document.getElementById('frame-slider');
        const sliderValue = document.getElementById('frame-slider-value');
        if (slider && !fastMode) {
            slider.value = String(index);
        }
        if (sliderValue && frameData.frame_time !== undefined) {
            sliderValue.textContent = frameData.frame_time.toFixed(4) + 's';
        }
        
        // Update navigation buttons state
        if (!fastMode) {
            const prevBtn = document.getElementById('prev-frame-btn');
            const nextBtn = document.getElementById('next-frame-btn');
            if (prevBtn) {
                prevBtn.disabled = index <= 0;
            }
            if (nextBtn) {
                nextBtn.disabled = index >= this.framesData.length - 1;
            }
        }
        
        // Redraw scene (always needed)
        this.sceneManager.updateEnvironment();
        this.sceneManager.redraw();
        this.sceneManager.render();
        
        // Trigger measurement update only if not in fast mode
        if (!fastMode && this.sceneManager.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }

    /**
     * Show notification message
     * @param {string} message - Message to display
     * @param {string} type - 'success' or 'error'
     */
    showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        notification.className = 'frame-save-notification';
        notification.textContent = message;
        
        const bgColor = type === 'error' 
            ? 'rgba(255, 69, 58, 0.9)'  // Red for errors
            : 'rgba(76, 217, 100, 0.9)'; // Green for success
        
        notification.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            padding: 12px 20px;
            background: ${bgColor};
            color: white;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            animation: slideInRight 0.3s ease;
            max-width: 400px;
            word-wrap: break-word;
        `;
        
        document.body.appendChild(notification);
        
        const duration = type === 'error' ? 3000 : 2000; // Errors show longer
        
        setTimeout(() => {
            notification.style.transition = 'opacity 0.3s ease';
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, duration);
    }

    /**
     * Scan for JSON files in a folder via backend API
     * @param {string} folderPath - Path to the folder to scan
     * @param {HTMLElement} selectElement - Select dropdown to populate
     */
    async scanFrameFiles(folderPath, selectElement) {
        try {
            // Call backend API
            // Ensure backend config is initialized
            await backendConfig.init();
            const response = await fetch(`${backendConfig.getApiUrl('api/list-json-files')}?folder=${encodeURIComponent(folderPath)}`);
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                this.showNotification(`${window.i18n?.t('scanFailed') || 'Scan failed'}: ${data.error}`, 'error');
                return;
            }
            
            // Populate the select dropdown
            this.populateFileSelect(selectElement, data.files);
            
            const message = `${window.i18n?.t('filesFound') || 'Files found'}: ${data.count}`;
            this.showNotification(message, 'success');
            
        } catch (error) {
            console.error('Error scanning folder:', error);
            this.showNotification(
                `${window.i18n?.t('scanError') || 'Error scanning folder'}: ${error.message}`,
                'error'
            );
        }
    }

    /**
     * Populate file select dropdown with scanned files
     * @param {HTMLElement} selectElement - Select dropdown to populate
     * @param {Array} files - Array of file names
     */
    populateFileSelect(selectElement, files) {
        if (!selectElement) return;
        
        // Keep only the default option
        while (selectElement.options.length > 1) {
            selectElement.remove(1);
        }
        
        // Add file options
        files.forEach(fileName => {
            const option = document.createElement('option');
            option.value = fileName;
            option.textContent = fileName;
            selectElement.appendChild(option);
        });
        
        // Reset selection
        selectElement.value = '';
    }

    /**
     * Start dynamic range adjustment timer for xyz sliders
     */
    startRangeAdjustment() {
        // Stop existing timer if any
        if (this.rangeAdjustTimer) {
            clearInterval(this.rangeAdjustTimer);
        }
        
        // Check and adjust ranges every 100ms
        this.rangeAdjustTimer = setInterval(() => {
            this.adjustXYZSliderRanges();
        }, 100);
    }

    /**
     * Adjust xyz slider ranges dynamically based on current values
     * Only expands ranges, never shrinks them
     */
    adjustXYZSliderRanges() {
        const axes = ['x', 'y', 'z'];
        
        axes.forEach(axis => {
            const currentValue = this.basePose[axis];
            const slider = document.querySelector(`.base-pose-slider[data-axis="${axis}"]`);
            
            if (!slider) return;
            
            const currentMin = parseFloat(slider.min);
            const currentMax = parseFloat(slider.max);
            
            // Calculate desired range: current value ± 0.3
            const desiredMin = currentValue - 0.3;
            const desiredMax = currentValue + 0.3;
            
            // Only expand, never shrink
            let newMin = currentMin;
            let newMax = currentMax;
            
            if (desiredMin < currentMin) {
                newMin = desiredMin;
            }
            if (desiredMax > currentMax) {
                newMax = desiredMax;
            }
            
            // Update if range changed
            if (newMin !== currentMin || newMax !== currentMax) {
                slider.min = newMin.toString();
                slider.max = newMax.toString();
                
                // Update stored range
                this.xyzSliderRanges[axis] = { min: newMin, max: newMax };
                
                // Update min/max labels
                const control = slider.closest('.base-pose-control');
                if (control && control._updateDisplay) {
                    control._updateDisplay();
                }
            }
        });
    }

    /**
     * Set angle unit (rad or deg)
     */
    setAngleUnit(unit) {
        this.angleUnit = unit;
        const controls = document.querySelectorAll('.base-pose-control');
        controls.forEach(control => {
            if (control._updateDisplay) {
                control._updateDisplay();
            }
        });
    }

    /**
     * Clear controls when no model is loaded
     */
    clearControls() {
        // Stop range adjustment timer
        if (this.rangeAdjustTimer) {
            clearInterval(this.rangeAdjustTimer);
            this.rangeAdjustTimer = null;
        }
        
        const container = document.getElementById('base-pose-controls');
        if (!container) return;

        container.innerHTML = '';
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.textContent = window.i18n?.t('noModel') || 'No model loaded';
        container.appendChild(emptyState);
    }

    /**
     * Interpolate frames from JSON file and save as CSV
     * @param {Object} model - Current robot model
     * @param {number} fps - Frames per second for interpolation (default: 30)
     * @param {number} firstFrameExtend - Extension duration for first frame in seconds (default: 0)
     * @param {number} lastFrameExtend - Extension duration for last frame in seconds (default: 0)
     * @param {number} zOffset - Z-axis offset to apply to CSV third column (default: 0)
     */
    async interpolateFrames(model, fps = 30, firstFrameExtend = 0, lastFrameExtend = 0, zOffset = 0) {
        if (!model) {
            this.showNotification('No model loaded', 'error');
            return;
        }

        const interpolateBtn = document.getElementById('interpolate-frames-btn');
        if (interpolateBtn) {
            interpolateBtn.disabled = true;
            interpolateBtn.textContent = window.i18n?.t('processing') || 'Processing...';
        }

        try {
            // Validate file name
            if (!this.frameFileName || this.frameFileName.trim() === '') {
                throw new Error(window.i18n?.t('frameFileNameRequired') || 'Please enter a frame file name');
            }

            // Get frame file path
            const filePath = this.getFrameFilePath(model);
            
            // Read file from backend API
            // Ensure backend config is initialized
            await backendConfig.init();
            const response = await fetch(`${backendConfig.getApiUrl('api/read-frame-file')}?file=${encodeURIComponent(filePath)}`);
            
            if (!response.ok) {
                const errorMsg = (window.i18n?.t('failedToLoadFile') || 'Failed to load file: {status}')
                    .replace('{status}', response.status);
                throw new Error(errorMsg);
            }
            
            const result = await response.json();
            
            if (result.error) {
                throw new Error(result.error);
            }

            // Get frames data (could be array or object with frames property)
            let data;
            if (Array.isArray(result)) {
                data = { frames: result };
            } else if (result.frames) {
                data = result;
            } else {
                throw new Error(window.i18n?.t('invalidFileFormat') || 'Invalid file format: expected frames array');
            }

            // Check if frames array exists
            if (!data.frames || !Array.isArray(data.frames) || data.frames.length === 0) {
                throw new Error(window.i18n?.t('emptyFramesArray') || 'JSON file must contain a non-empty "frames" array');
            }

            const frames = data.frames;
            
            // Sort frames by frame_time
            frames.sort((a, b) => (a.frame_time || 0) - (b.frame_time || 0));

            // Extract joint names from first frame
            const jointNames = [];
            if (frames[0].joint_angles) {
                const desiredOrder = [
                    'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint',
                    'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint',
                    'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint',
                    'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint'
                ];
                
                const rawJoints = Object.keys(frames[0].joint_angles);
                for (const joint of desiredOrder) {
                    if (rawJoints.includes(joint)) {
                        jointNames.push(joint);
                    }
                }
                // Add any remaining joints
                for (const joint of rawJoints) {
                    if (!jointNames.includes(joint)) {
                        jointNames.push(joint);
                    }
                }
            }

            // Extract times
            const times = frames.map(f => f.frame_time || 0);

            // Generate interpolated trajectory
            const dt = 1.0 / fps;
            const tStart = times[0];
            const tEnd = times[times.length - 1];
            const trajectory = [];

            let t = tStart;
            while (t <= tEnd) {
                const frame = this.interpolateFrameAtTime(frames, times, t, jointNames);
                trajectory.push(frame);
                t += dt;
            }

            // Extend first frame if needed
            if (firstFrameExtend > 0) {
                const firstFrameExtendFrames = Math.round(firstFrameExtend * fps);
                const firstFrame = trajectory[0];
                const extendedFrames = [];
                
                // Add extended frames before the first frame (copy first frame)
                for (let i = 0; i < firstFrameExtendFrames; i++) {
                    const extendedFrame = JSON.parse(JSON.stringify(firstFrame)); // Deep copy
                    extendedFrames.push(extendedFrame);
                }
                
                // Prepend extended frames to trajectory
                trajectory.unshift(...extendedFrames);
            }

            // Extend last frame if needed
            if (lastFrameExtend > 0) {
                const lastFrameExtendFrames = Math.round(lastFrameExtend * fps);
                const lastFrame = trajectory[trajectory.length - 1];
                const extendedFrames = [];
                
                // Add extended frames after the last frame (copy last frame)
                for (let i = 0; i < lastFrameExtendFrames; i++) {
                    const extendedFrame = JSON.parse(JSON.stringify(lastFrame)); // Deep copy
                    extendedFrames.push(extendedFrame);
                }
                
                // Append extended frames to trajectory
                trajectory.push(...extendedFrames);
            }

            // Convert to CSV format
            const csvLines = [];
            for (const frame of trajectory) {
                const row = [];
                
                // Position (3 columns)
                if (frame.pos_world) {
                    row.push(frame.pos_world.x.toFixed(6));
                    row.push(frame.pos_world.y.toFixed(6));
                    // Apply z-axis offset to third column
                    const zValue = (frame.pos_world.z || 0) + zOffset;
                    row.push(zValue.toFixed(6));
                } else {
                    // Apply z-axis offset even if pos_world is missing
                    row.push('0.000000', '0.000000', zOffset.toFixed(6));
                }

                // Rotation quaternion (4 columns)
                if (frame.rot_quat) {
                    row.push(frame.rot_quat.x.toFixed(6));
                    row.push(frame.rot_quat.y.toFixed(6));
                    row.push(frame.rot_quat.z.toFixed(6));
                    row.push(frame.rot_quat.w.toFixed(6));
                } else {
                    row.push('0.000000', '0.000000', '0.000000', '1.000000');
                }

                // Joint angles
                for (const jointName of jointNames) {
                    const angle = frame.joint_angles?.[jointName] || 0;
                    row.push(angle.toFixed(6));
                }

                csvLines.push(row.join(','));
            }

            // Save CSV file to frames/lafan/{frame_file_name}.csv via backend API
            const csvContent = csvLines.join('\n');
            
            // Get output file name based on frame file name
            let outputFileName = 'robot';
            if (this.frameFileName && this.frameFileName.trim() !== '') {
                // Remove path and extension, keep only the base name
                let fileName = this.frameFileName.trim();
                // Remove directory path if present
                fileName = fileName.split('/').pop().split('\\').pop();
                // Remove .json extension if present
                if (fileName.toLowerCase().endsWith('.json')) {
                    fileName = fileName.slice(0, -5);
                }
                // Remove 'frame_' prefix if present (optional)
                if (fileName.toLowerCase().startsWith('frame_')) {
                    fileName = fileName.slice(6);
                }
                // Sanitize the name
                outputFileName = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
            } else if (model.name) {
                // Fallback to model name if frame file name not available
                outputFileName = model.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            }
            
            const outputPath = `./frames/lafan/${outputFileName}.csv`;
            
            // Save via backend API
            // Ensure backend config is initialized
            await backendConfig.init();
            const saveResponse = await fetch(backendConfig.getApiUrl('api/save-csv-file'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    file: outputPath,
                    content: csvContent
                })
            });

            if (!saveResponse.ok) {
                const errorData = await saveResponse.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to save file: ${saveResponse.status}`);
            }

            const saveResult = await saveResponse.json();
            
            if (saveResult.error) {
                throw new Error(saveResult.error);
            }

            // Calculate original frame count (before extension)
            const originalFrameCount = trajectory.length - 
                (firstFrameExtend > 0 ? Math.round(firstFrameExtend * fps) : 0) - 
                (lastFrameExtend > 0 ? Math.round(lastFrameExtend * fps) : 0);
            
            // Format success message with parameters
            let successMsg = (window.i18n?.t('interpolateSuccess') || 'Successfully interpolated {count} frames at {fps}Hz and saved to {path}')
                .replace('{count}', trajectory.length)
                .replace('{fps}', fps)
                .replace('{path}', outputPath);
            
            // Add extension info if any extension was applied
            if (firstFrameExtend > 0 || lastFrameExtend > 0) {
                const extensionInfo = [];
                if (firstFrameExtend > 0) {
                    extensionInfo.push(`${Math.round(firstFrameExtend * fps)} frames extended at start`);
                }
                if (lastFrameExtend > 0) {
                    extensionInfo.push(`${Math.round(lastFrameExtend * fps)} frames extended at end`);
                }
                successMsg += ` (${extensionInfo.join(', ')})`;
            }
            
            this.showNotification(successMsg, 'success');

        } catch (error) {
            console.error('Error interpolating frames:', error);
            
            // Format error message with parameters
            const errorMsg = (window.i18n?.t('interpolateError') || 'Interpolation failed: {error}')
                .replace('{error}', error.message);
            
            this.showNotification(errorMsg, 'error');
        } finally {
            if (interpolateBtn) {
                interpolateBtn.disabled = false;
                interpolateBtn.textContent = window.i18n?.t('interpolateAndSave') || 'Interpolate to LaFAN Format';
            }
        }
    }

    /**
     * Interpolate frame at specific time
     * @param {Array} frames - Array of frame objects
     * @param {Array} times - Array of corresponding times
     * @param {number} t - Target time
     * @param {Array} jointNames - Array of joint names
     * @returns {Object} Interpolated frame
     */
    interpolateFrameAtTime(frames, times, t, jointNames) {
        // Handle edge cases
        if (t <= times[0]) {
            return this.convertFrameToOutput(frames[0], jointNames);
        }
        if (t >= times[times.length - 1]) {
            return this.convertFrameToOutput(frames[frames.length - 1], jointNames);
        }

        // Find interpolation interval
        let i = 0;
        for (let j = 0; j < times.length - 1; j++) {
            if (times[j] <= t && t <= times[j + 1]) {
                i = j;
                break;
            }
        }

        const t1 = times[i];
        const t2 = times[i + 1];
        const frame1 = frames[i];
        const frame2 = frames[i + 1];

        const alpha = t2 === t1 ? 0 : (t - t1) / (t2 - t1);

        // Interpolate position
        const pos_world = {
            x: 0, y: 0, z: 0
        };
        if (frame1.pos_world && frame2.pos_world) {
            pos_world.x = frame1.pos_world.x * (1 - alpha) + frame2.pos_world.x * alpha;
            pos_world.y = frame1.pos_world.y * (1 - alpha) + frame2.pos_world.y * alpha;
            pos_world.z = frame1.pos_world.z * (1 - alpha) + frame2.pos_world.z * alpha;
        }

        // Interpolate rotation (RPY -> Quaternion)
        let rot_quat = { x: 0, y: 0, z: 0, w: 1 };
        if (frame1.rpy && frame2.rpy) {
            const q1 = this.rpyToQuaternion(frame1.rpy.roll, frame1.rpy.pitch, frame1.rpy.yaw);
            const q2 = this.rpyToQuaternion(frame2.rpy.roll, frame2.rpy.pitch, frame2.rpy.yaw);
            rot_quat = this.quaternionSlerp(q1, q2, alpha);
        }

        // Interpolate joint angles
        const joint_angles = {};
        if (frame1.joint_angles && frame2.joint_angles) {
            for (const jointName of jointNames) {
                const angle1 = frame1.joint_angles[jointName] || 0;
                const angle2 = frame2.joint_angles[jointName] || 0;
                
                // Handle angle wrapping
                let angleDiff = angle2 - angle1;
                if (angleDiff > Math.PI) {
                    angleDiff -= 2 * Math.PI;
                } else if (angleDiff < -Math.PI) {
                    angleDiff += 2 * Math.PI;
                }
                
                joint_angles[jointName] = angle1 + angleDiff * alpha;
            }
        }

        return {
            pos_world,
            rot_quat,
            joint_angles
        };
    }

    /**
     * Convert frame to output format
     * @param {Object} frame - Frame object
     * @param {Array} jointNames - Array of joint names
     * @returns {Object} Converted frame
     */
    convertFrameToOutput(frame, jointNames) {
        const pos_world = frame.pos_world || { x: 0, y: 0, z: 0 };
        
        let rot_quat = { x: 0, y: 0, z: 0, w: 1 };
        if (frame.rpy) {
            rot_quat = this.rpyToQuaternion(frame.rpy.roll, frame.rpy.pitch, frame.rpy.yaw);
        }

        const joint_angles = {};
        if (frame.joint_angles) {
            for (const jointName of jointNames) {
                joint_angles[jointName] = frame.joint_angles[jointName] || 0;
            }
        }

        return {
            pos_world,
            rot_quat,
            joint_angles
        };
    }

    /**
     * Convert RPY to quaternion (x, y, z, w)
     * @param {number} roll - Roll angle in radians (rotation around X axis)
     * @param {number} pitch - Pitch angle in radians (rotation around Y axis)
     * @param {number} yaw - Yaw angle in radians (rotation around Z axis)
     * @returns {Object} Quaternion {x, y, z, w}
     */
    rpyToQuaternion(roll, pitch, yaw) {
        // Using THREE.js Euler with XYZ order (same as scipy's 'xyz' order)
        const euler = new THREE.Euler(roll, pitch, yaw, 'XYZ');
        const quaternion = new THREE.Quaternion();
        quaternion.setFromEuler(euler);
        
        return {
            x: quaternion.x,
            y: quaternion.y,
            z: quaternion.z,
            w: quaternion.w
        };
    }

    /**
     * Quaternion spherical linear interpolation (SLERP)
     * @param {Object} q1 - First quaternion {x, y, z, w}
     * @param {Object} q2 - Second quaternion {x, y, z, w}
     * @param {number} t - Interpolation parameter (0 <= t <= 1)
     * @returns {Object} Interpolated quaternion {x, y, z, w}
     */
    quaternionSlerp(q1, q2, t) {
        // Normalize quaternions
        const len1 = Math.sqrt(q1.x * q1.x + q1.y * q1.y + q1.z * q1.z + q1.w * q1.w);
        const len2 = Math.sqrt(q2.x * q2.x + q2.y * q2.y + q2.z * q2.z + q2.w * q2.w);
        
        const nq1 = {
            x: q1.x / len1,
            y: q1.y / len1,
            z: q1.z / len1,
            w: q1.w / len1
        };
        
        const nq2 = {
            x: q2.x / len2,
            y: q2.y / len2,
            z: q2.z / len2,
            w: q2.w / len2
        };

        // Calculate dot product
        let dot = nq1.x * nq2.x + nq1.y * nq2.y + nq1.z * nq2.z + nq1.w * nq2.w;

        // If dot product is negative, negate one quaternion to take shortest path
        if (dot < 0) {
            nq2.x = -nq2.x;
            nq2.y = -nq2.y;
            nq2.z = -nq2.z;
            nq2.w = -nq2.w;
            dot = -dot;
        }

        // Clamp dot product
        dot = Math.max(-1, Math.min(1, dot));

        // Calculate angle
        const theta = Math.acos(dot);
        const sinTheta = Math.sin(theta);

        // If angle is very small, use linear interpolation
        if (sinTheta < 1e-10) {
            return {
                x: nq1.x * (1 - t) + nq2.x * t,
                y: nq1.y * (1 - t) + nq2.y * t,
                z: nq1.z * (1 - t) + nq2.z * t,
                w: nq1.w * (1 - t) + nq2.w * t
            };
        }

        // SLERP formula
        const w1 = Math.sin((1 - t) * theta) / sinTheta;
        const w2 = Math.sin(t * theta) / sinTheta;

        const result = {
            x: w1 * nq1.x + w2 * nq2.x,
            y: w1 * nq1.y + w2 * nq2.y,
            z: w1 * nq1.z + w2 * nq2.z,
            w: w1 * nq1.w + w2 * nq2.w
        };

        // Normalize result
        const len = Math.sqrt(result.x * result.x + result.y * result.y + result.z * result.z + result.w * result.w);
        return {
            x: result.x / len,
            y: result.y / len,
            z: result.z / len,
            w: result.w / len
        };
    }

    /**
     * Update base pose controls language
     * Called when language changes to update all text elements
     */
    updateBasePoseControlsLanguage() {
        const container = document.getElementById('base-pose-controls');
        if (!container) return;

        // Update orientation title (first group title)
        const orientationTitles = container.querySelectorAll('.base-pose-group-title');
        if (orientationTitles.length > 0) {
            orientationTitles[0].textContent = window.i18n?.t('orientation') || 'Orientation (RPY)';
        }

        // Update position title (second group title)
        if (orientationTitles.length > 1) {
            orientationTitles[1].textContent = window.i18n?.t('position') || 'Position (World)';
        }

        // Update frame file name label (first frame label)
        const frameLabels = container.querySelectorAll('.base-pose-frame-label');
        if (frameLabels.length > 0) {
            frameLabels[0].textContent = window.i18n?.t('frameFileName') || 'Frame File Name';
        }

        // Update frame time label (second frame label)
        if (frameLabels.length > 1) {
            frameLabels[1].textContent = window.i18n?.t('frameTime') || 'Frame Time (s)';
        }

        // Update frame slider label (third frame label)
        if (frameLabels.length > 2) {
            frameLabels[2].textContent = window.i18n?.t('frameSlider') || 'Browse Frames';
        }

        // Update prev/next frame button titles
        const prevFrameBtn = document.getElementById('prev-frame-btn');
        if (prevFrameBtn) {
            prevFrameBtn.title = window.i18n?.t('prevFrame') || 'Previous Frame';
        }

        const nextFrameBtn = document.getElementById('next-frame-btn');
        if (nextFrameBtn) {
            nextFrameBtn.title = window.i18n?.t('nextFrame') || 'Next Frame';
        }

        // Update save frame button
        const saveFrameBtn = document.getElementById('save-frame-btn');
        if (saveFrameBtn) {
            saveFrameBtn.textContent = window.i18n?.t('saveFrame') || 'Save Frame';
        }

        // Update reset button
        const resetBtn = document.getElementById('reset-base-pose-btn');
        if (resetBtn) {
            resetBtn.textContent = window.i18n?.t('resetBasePose') || 'Reset Base Pose';
        }

        // Update load frames button
        const loadFramesBtn = document.getElementById('load-frames-btn');
        if (loadFramesBtn) {
            const isLoading = loadFramesBtn.disabled && loadFramesBtn.textContent.includes('Loading');
            if (isLoading) {
                loadFramesBtn.textContent = window.i18n?.t('loadingFrames') || 'Loading...';
            } else {
                loadFramesBtn.textContent = window.i18n?.t('loadFrames') || 'Load Frames';
            }
        }

        // Update interpolate section title
        const interpolateSection = container.querySelector('.interpolate-section');
        if (interpolateSection) {
            const interpolateTitle = interpolateSection.querySelector('div:first-child');
            if (interpolateTitle && interpolateTitle.style.fontSize === '12px') {
                interpolateTitle.textContent = window.i18n?.t('interpolateFrames') || 'Interpolate to LaFAN Format';
            }
        }

        // Update frequency label
        const freqInput = document.getElementById('interpolate-freq-input');
        if (freqInput) {
            const freqGroup = freqInput.closest('div');
            if (freqGroup) {
                const freqLabel = freqGroup.querySelector('label');
                if (freqLabel) {
                    freqLabel.textContent = (window.i18n?.t('frequency') || 'Frequency') + ':';
                }
            }
        }

        // Update first frame extend label
        const firstFrameExtInput = document.getElementById('first-frame-extend-input');
        if (firstFrameExtInput) {
            const firstFrameExtGroup = firstFrameExtInput.closest('div');
            if (firstFrameExtGroup) {
                const firstFrameExtLabel = firstFrameExtGroup.querySelector('label');
                if (firstFrameExtLabel) {
                    firstFrameExtLabel.textContent = (window.i18n?.t('firstFrameExtend') || 'First Frame Extend') + ':';
                }
            }
        }

        // Update last frame extend label
        const lastFrameExtInput = document.getElementById('last-frame-extend-input');
        if (lastFrameExtInput) {
            const lastFrameExtGroup = lastFrameExtInput.closest('div');
            if (lastFrameExtGroup) {
                const lastFrameExtLabel = lastFrameExtGroup.querySelector('label');
                if (lastFrameExtLabel) {
                    lastFrameExtLabel.textContent = (window.i18n?.t('lastFrameExtend') || 'Last Frame Extend') + ':';
                }
            }
        }

        // Update z-axis offset label
        const zOffsetInput = document.getElementById('z-axis-offset-input');
        if (zOffsetInput) {
            const zOffsetGroup = zOffsetInput.closest('div');
            if (zOffsetGroup) {
                const zOffsetLabel = zOffsetGroup.querySelector('label');
                if (zOffsetLabel) {
                    zOffsetLabel.textContent = (window.i18n?.t('zAxisOffset') || 'Z-Axis Offset') + ':';
                }
            }
        }

        // Update interpolate button (only if not processing)
        const interpolateBtn = document.getElementById('interpolate-frames-btn');
        if (interpolateBtn) {
            const isProcessing = interpolateBtn.disabled && interpolateBtn.textContent.includes('Processing');
            if (isProcessing) {
                interpolateBtn.textContent = window.i18n?.t('processing') || 'Processing...';
            } else {
                interpolateBtn.textContent = window.i18n?.t('interpolateAndSave') || 'Interpolate to LaFAN Format';
            }
        }

        // Update angle unit displays in controls
        const controls = container.querySelectorAll('.base-pose-control');
        controls.forEach(control => {
            const updateDisplay = control._updateDisplay;
            if (updateDisplay && typeof updateDisplay === 'function') {
                updateDisplay();
            }
        });
    }
}
