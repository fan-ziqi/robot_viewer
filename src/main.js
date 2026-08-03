/**
 * Application main entry point
 * Integrates all modules
 */
import * as THREE from 'three';
import * as d3 from 'd3';
import { SceneManager } from './renderer/SceneManager.js';
import { UIController } from './ui/UIController.js';
import { FileHandler } from './controllers/FileHandler.js';
import { JointControlsUI } from './ui/JointControlsUI.js';
import { PanelManager } from './ui/PanelManager.js';
import { ModelGraphView } from './views/ModelGraphView.js';
import { FileTreeView } from './views/FileTreeView.js';
import { CodeEditorManager } from './controllers/CodeEditorManager.js';
import { MeasurementController } from './controllers/MeasurementController.js';
import { USDViewerManager } from './renderer/USDViewerManager.js';
import { MujocoSimulationManager } from './renderer/MujocoSimulationManager.js';
import { i18n } from './utils/i18n.js';
import { PoseController } from './animation/runtime/PoseController.js';
import { AnimationWorkspace } from './animation/ui/AnimationWorkspace.js';

// Expose d3 globally for PanelManager
window.d3 = d3;

// Expose i18n globally
window.i18n = i18n;

// Application state
class App {
    constructor() {
        this.sceneManager = null;
        this.uiController = null;
        this.fileHandler = null;
        this.jointControlsUI = null;
        this.panelManager = null;
        this.modelGraphView = null;
        this.fileTreeView = null;
        this.codeEditorManager = null;
        this.measurementController = null;
        this.usdViewerManager = null;
        this.mujocoSimulationManager = null;
        this.poseController = null;
        this.animationWorkspace = null;
        this.currentModel = null;
        this.currentMJCFFile = null;
        this.currentMJCFModel = null;
        this.angleUnit = 'rad';
        this.vscodeFileMap = new Map(); // Store VSCode files
    }

    /**
     * Load model from VSCode extension
     * @param {Object} fileInfo - File info from VSCode {name, path, content, directory}
     */
    async loadModelFromVSCode(fileInfo) {
        try {
            console.log('Loading model from VSCode:', fileInfo.name);

            // Create a File-like object from the content
            const blob = new Blob([fileInfo.content], { type: 'text/plain' });
            const file = new File([blob], fileInfo.name, { type: 'text/plain' });

            // Store file info for resolving relative paths
            file.vscodeDirectory = fileInfo.directory;
            file.vscodePath = fileInfo.path;

            // Add to file map
            this.fileHandler.fileMap.set(fileInfo.name, file);
            this.fileHandler.fileMap.set(fileInfo.path, file);
            this.vscodeFileMap.set(fileInfo.name, fileInfo);

            // Load the model
            await this.fileHandler.loadFile(file);

            // Update file tree
            const loadableFiles = [{
                file: file,
                name: fileInfo.name,
                type: this.detectFileType(fileInfo.name),
                path: fileInfo.path,
                category: 'model',
                ext: fileInfo.name.split('.').pop().toLowerCase()
            }];

            this.fileHandler.availableModels = loadableFiles;
            if (this.fileTreeView) {
                this.fileTreeView.updateFileTree(loadableFiles, this.fileHandler.fileMap);
            }

            vscodeAdapter.log(`Model loaded successfully: ${fileInfo.name}`);
        } catch (error) {
            console.error('Failed to load model from VSCode:', error);
            vscodeAdapter.showError(`Failed to load model: ${error.message}`);
        }
    }

    /**
     * Detect file type from filename
     */
    detectFileType(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        if (['urdf', 'xacro'].includes(ext)) return 'urdf';
        if (['mjcf', 'xml'].includes(ext)) return 'mjcf';
        if (['usd', 'usda', 'usdc', 'usdz'].includes(ext)) return 'usd';
        if (['obj', 'stl', 'dae', 'gltf', 'glb'].includes(ext)) return 'mesh';
        return 'unknown';
    }

    /**
     * Initialize application
     */
    async init() {
        try {
            // Initialize internationalization
            i18n.init();

            // Initialize scene manager
            const canvas = document.getElementById('canvas');
            if (!canvas) {
                console.error('Canvas element not found');
                return;
            }

            this.sceneManager = new SceneManager(canvas);
            window.sceneManager = this.sceneManager; // For debugging

            this.poseController = new PoseController(this.sceneManager);
            this.sceneManager.setPoseController(this.poseController);

            // Create USD viewer container (container only, WASM initialized on demand)
            this.createUSDViewerContainer();

            // Initialize file handler
            this.fileHandler = new FileHandler();
            this.fileHandler.setupFileDrop();

            // Set USD viewer lazy loading
            this.fileHandler.setUSDViewerInitializer(async () => {
                return await this.getUSDViewerManager();
            });

            this.fileHandler.onFilesLoaded = (files) => {
                if (this.fileTreeView) {
                    this.fileTreeView.updateFileTree(files, this.fileHandler.getFileMap());
                }
            };

            this.fileHandler.onModelLoaded = (model, file, isMesh = false, snapshot = null) => {
                this.handleModelLoaded(model, file, isMesh, snapshot);
            };

            // Initialize joint controls UI
            this.jointControlsUI = new JointControlsUI(this.sceneManager);
            this.jointControlsUI.setPoseController(this.poseController);

            // Initialize model graph view
            this.modelGraphView = new ModelGraphView(this.sceneManager);

            // Initialize file tree view
            this.fileTreeView = new FileTreeView();
            this.fileTreeView.onFileClick = (fileInfo) => {
                this.handleFileClick(fileInfo);
            };

            // Initialize file tree with empty state (shows load button)
            this.fileTreeView.updateFileTree([], new Map());

            // Initialize panel manager
            this.panelManager = new PanelManager();
            this.panelManager.initAllPanels();

            // Pass ModelGraphView reference to PanelManager (set after modelGraphView initialization)
            if (this.modelGraphView) {
                this.panelManager.setModelGraphView(this.modelGraphView);
            }

            // Initialize UI controller
            this.uiController = new UIController(this.sceneManager);
            this.uiController.setupAll({
                onThemeChanged: (theme) => this.handleThemeChanged(theme),
                onAngleUnitChanged: (unit) => this.handleAngleUnitChanged(unit),
                onIgnoreLimitsChanged: (ignore) => this.handleIgnoreLimitsChanged(ignore),
                onLanguageChanged: (lang) => this.handleLanguageChanged(lang),
                onResetJoints: () => this.handleResetJoints(),
                onMujocoReset: () => this.handleMujocoReset(),
                onMujocoToggleSimulate: () => this.handleMujocoToggleSimulate()
            });

            // Animation editor is deliberately separate from hardware/simulation.
            this.animationWorkspace = new AnimationWorkspace({
                poseController: this.poseController
            });
            window.animationWorkspace = this.animationWorkspace;

            // Set measurement update callback
            this.sceneManager.onMeasurementUpdate = () => {
                if (this.measurementController) {
                    this.measurementController.updateMeasurement();
                }
            };

            // Setup canvas click handler
            this.setupCanvasClickHandler(canvas);

            // Initialize code editor manager
            this.codeEditorManager = new CodeEditorManager();
            this.codeEditorManager.init(this.fileHandler.getFileMap());

            // Set code editor manager to joint controls UI
            if (this.jointControlsUI) {
                this.jointControlsUI.setCodeEditorManager(this.codeEditorManager);
            }

            // Set code editor manager to model graph view
            if (this.modelGraphView) {
                this.modelGraphView.setCodeEditorManager(this.codeEditorManager);
            }

            this.codeEditorManager.onReload = async (file, skipTreeUpdate = false) => {
                // Set flag when saving/reloading to avoid updating file tree
                if (skipTreeUpdate) {
                    this._isReloading = true;
                }

                // Temporarily update currentModelFile
                this.fileHandler.currentModelFile = file;

                await this.fileHandler.loadFile(file);

                this._isReloading = false;
            };

            // Save as callback: update file tree and mark new file
            this.codeEditorManager.onSaveAs = (newFile) => {
                // Update availableModels list
                const newFileInfo = {
                    file: newFile,
                    name: newFile.name,
                    type: this.detectFileType(newFile.name),
                    path: newFile.name,
                    category: 'model',
                    ext: newFile.name.split('.').pop().toLowerCase()
                };

                // Add to availableModels if not exists
                const models = this.fileHandler.getAvailableModels();
                if (!models.find(m => m.name === newFile.name)) {
                    models.push(newFileInfo);
                }

                // Update file tree
                if (this.fileTreeView) {
                    this.fileTreeView.updateFileTree(
                        models,
                        this.fileHandler.getFileMap(),
                        true
                    );
                    setTimeout(() => {
                        this.fileTreeView.markActiveFile(newFile);
                    }, 100);
                }
            };

            // Initialize measurement controller
            this.measurementController = new MeasurementController(this.sceneManager);

            // Associate measurement controller with model graph view
            if (this.modelGraphView) {
                this.modelGraphView.setMeasurementController(this.measurementController);
            }

            // Initialize MuJoCo simulation manager
            this.mujocoSimulationManager = new MujocoSimulationManager(this.sceneManager);

            // Setup model tree panel
            this.setupModelTreePanel();

            // Update editor button visibility
            this.updateEditorButtonVisibility();

            // Start render loop
            this.animate();

        } catch (error) {
            console.error('Initialization error:', error);
        }
    }

    /**
     * Update editor button visibility
     */
    updateEditorButtonVisibility() {
        const openEditorBtn = document.getElementById('open-editor-btn');
        if (openEditorBtn) {
            openEditorBtn.classList.add('visible');
        }
    }

    /**
     * Handle model loaded
     */
    async handleModelLoaded(model, file, isMesh = false, snapshot = null) {
        // Check if MJCF file (show simulation controls, don't auto-start simulation)
        const fileExt = file.name.split('.').pop().toLowerCase();
        const isMJCF = fileExt === 'xml' && model?.userData?.type === 'mjcf';

        // Clear MuJoCo simulation state when switching files
        if (this.mujocoSimulationManager && this.mujocoSimulationManager.hasScene()) {
            // Always clear simulation when switching files (MJCF or non-MJCF)
            this.mujocoSimulationManager.clearScene();
        }

        if (isMJCF && model.joints && model.joints.size > 0) {
            // Save model info for simulation
            this.currentMJCFFile = file;
            this.currentMJCFModel = model;

            // Show simulation control bar
            const simulationBar = document.getElementById('mujoco-simulation-bar');
            const resetBtn = document.getElementById('mujoco-reset-btn-bar');
            const simulateBtn = document.getElementById('mujoco-simulate-btn-bar');

            if (simulationBar) {
                simulationBar.style.display = 'flex';
            }

            // Enable buttons
            if (resetBtn) {
                resetBtn.disabled = false;
                resetBtn.style.opacity = '1';
                resetBtn.style.cursor = 'pointer';

                // Set localized text
                const resetSpan = resetBtn.querySelector('span');
                if (resetSpan) {
                    resetSpan.textContent = window.i18n?.t('mujocoReset') || 'Reset';
                }
            }

            if (simulateBtn) {
                simulateBtn.disabled = false;
                simulateBtn.style.opacity = '1';
                simulateBtn.style.cursor = 'pointer';
                simulateBtn.classList.remove('active');
                const span = simulateBtn.querySelector('span');
                if (span) {
                    // Use i18n to set correct text
                    span.textContent = window.i18n?.t('mujocoSimulate') || 'Simulate';
                }
            }
        } else {
            // Hide simulation control bar (non-MJCF files)
            const simulationBar = document.getElementById('mujoco-simulation-bar');
            if (simulationBar) simulationBar.style.display = 'none';

            this.currentMJCFFile = null;
            this.currentMJCFModel = null;
        }

        // Check if USD WASM model
        if (model?.userData?.isUSDWASM) {
            // Hide Three.js canvas, show USD viewer
            const canvas = document.getElementById('canvas');
            const usdContainer = document.getElementById('usd-viewer-container');
            if (canvas && usdContainer) {
                canvas.style.display = 'none';
                usdContainer.style.display = 'block';
            }

            // Hide joint controls and graph (USD WASM models don't support these features)
            const jointPanel = document.getElementById('joint-controls-panel');
            const graphPanel = document.getElementById('graph-panel');
            if (jointPanel) {
                jointPanel.style.display = 'none';
            }
            if (graphPanel) {
                graphPanel.style.display = 'none';
            }

            this.currentModel = model;
            this.animationWorkspace?.setModel(null, file.name);
            this.updateModelInfo(model, file);

            // Hide snapshot if exists
            const snapshot = document.getElementById('canvas-snapshot');
            if (snapshot?.parentNode) {
                snapshot.parentNode.removeChild(snapshot);
            }

            return;
        }

        // If regular model, ensure USD viewer is hidden
        let canvas = document.getElementById('canvas');
        const usdContainer = document.getElementById('usd-viewer-container');
        if (canvas && usdContainer) {
            canvas.style.display = 'block';
            usdContainer.style.display = 'none';
        }

        // Clear USD viewer if running
        if (this.usdViewerManager) {
            this.usdViewerManager.clear();
            this.usdViewerManager.hide();
        }

        // Restore joint controls and graph display
        const jointPanel = document.getElementById('joint-controls-panel');
        const graphPanel = document.getElementById('graph-panel');
        if (jointPanel) jointPanel.style.display = '';
        if (graphPanel) graphPanel.style.display = '';

        // Clear old model
        if (this.currentModel) {
            this.sceneManager.removeModel(this.currentModel);
            this.currentModel = null;
        }

        this.currentModel = model;
        this.animationWorkspace?.setModel(isMesh ? null : model, file.name);

        // Force render current state first (important!)
        this.sceneManager.redraw();
        this.sceneManager.render();

        // Create snapshot (synchronous), before addModel
        canvas = document.getElementById('canvas');
        let loadingSnapshot = null;

        if (canvas) {
            try {
                const dataURL = canvas.toDataURL('image/png');

                loadingSnapshot = document.createElement('div');
                loadingSnapshot.id = 'canvas-snapshot';
                loadingSnapshot.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-image: url(${dataURL});
                    background-size: cover;
                    background-position: center;
                    background-color: var(--bg-primary);
                    background-repeat: no-repeat;
                    z-index: 2;
                    pointer-events: none;
                `;

                const canvasContainer = document.getElementById('canvas-container');
                if (canvasContainer) {
                    canvasContainer.appendChild(loadingSnapshot);
                } else {
                    document.body.appendChild(loadingSnapshot);
                }
            } catch (error) {
                console.error('Failed to create snapshot:', error);
            }
        }

        // Define snapshot removal function
        let snapshotRemoving = false;
        const removeSnapshot = () => {
            if (loadingSnapshot && loadingSnapshot.parentNode && !snapshotRemoving) {
                snapshotRemoving = true;
                loadingSnapshot.style.transition = 'opacity 0.3s ease';
                loadingSnapshot.style.opacity = '0';

                setTimeout(() => {
                    if (loadingSnapshot && loadingSnapshot.parentNode) {
                        loadingSnapshot.parentNode.removeChild(loadingSnapshot);
                        loadingSnapshot = null;
                    }
                }, 300);
            }
        };

        // Safety mechanism: 5 second timeout
        const timeoutId = setTimeout(() => {
            if (loadingSnapshot && loadingSnapshot.parentNode) {
                console.error('Model loading timeout (5000ms)');
                removeSnapshot();
                this.sceneManager.off('modelReady', onModelReady);
            }
        }, 5000);

        // Listen for model ready event
        const onModelReady = () => {
            clearTimeout(timeoutId);
            removeSnapshot();
            this.sceneManager.off('modelReady', onModelReady);
        };
        this.sceneManager.on('modelReady', onModelReady);

        // Add to scene (render in background under snapshot)
        this.sceneManager.addModel(model);

        // Hide drop zone
        const dropZone = document.getElementById('drop-zone');
        if (dropZone) {
            dropZone.classList.remove('show');
            dropZone.classList.remove('drag-over');
        }

        if (!isMesh) {
            // Normal model
            this.sceneManager.setGroundVisible(true);
            this.jointControlsUI.setupJointControls(model);

            // Draw model graph
            if (this.modelGraphView) {
                this.modelGraphView.drawModelGraph(model);
            }

            // Show panels
            const graphPanel = document.getElementById('model-graph-panel');
            if (graphPanel) graphPanel.style.display = 'block';

            const jointsPanel = document.getElementById('joints-panel');
            if (jointsPanel) jointsPanel.style.display = 'block';

            // Hide axes by default
            this.setAxesButtonState(false);
        } else {
            // Mesh file
            this.sceneManager.setGroundVisible(false);

            // Clear and hide graph
            if (this.modelGraphView) {
                const svg = d3.select('#model-graph-svg');
                svg.selectAll('*:not(defs)').remove();
                const emptyState = document.getElementById('graph-empty-state');
                if (emptyState) {
                    emptyState.classList.remove('hidden');
                }
            }
            const graphPanel = document.getElementById('model-graph-panel');
            if (graphPanel) graphPanel.style.display = 'none';

            // Clear and hide joint controls area
            const jointContainer = document.getElementById('joint-controls');
            if (jointContainer) {
                jointContainer.innerHTML = '';
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.textContent = window.i18n.t('noModel');
                jointContainer.appendChild(emptyState);
            }
            const jointsPanel = document.getElementById('joints-panel');
            if (jointsPanel) jointsPanel.style.display = 'none';

            // Mesh files show axes by default
            this.setAxesButtonState(true);

            // Clear editor content (mesh files don't need editing)
            if (this.codeEditorManager) {
                this.codeEditorManager.clearEditor();
            }
        }

        // Update file tree: expand folders and scroll to file position
        // Note: don't update file tree on reload (avoid showing temp files)
        if (this.fileTreeView && !this._isReloading) {
            // Re-render tree to maintain expanded state
            this.fileTreeView.updateFileTree(
                this.fileHandler.getAvailableModels(),
                this.fileHandler.getFileMap(),
                true // Maintain expanded state
            );
            // Expand and scroll to current file
            this.fileTreeView.expandAndScrollToFile(file, this.fileHandler.getFileMap());
        }

        // Auto-open editor and load file (skip on reload)
        // Only robot model files (non-mesh files) are loaded into editor
        if (!this._isReloading && !isMesh) {
            const editorPanel = document.getElementById('code-editor-panel');
            if (editorPanel && this.codeEditorManager) {
                editorPanel.classList.add('visible');
                const openEditorBtn = document.getElementById('open-editor-btn');
                if (openEditorBtn) {
                    openEditorBtn.classList.add('active');
                }
                this.codeEditorManager.loadFile(file);
            }
        }

        // Update editor button visibility
        this.updateEditorButtonVisibility();

        // Update model info
        this.updateModelInfo(model, file);
    }

    /**
     * Setup canvas click handler
     */
    setupCanvasClickHandler(canvas) {
        let mouseDownPos = null;
        let mouseDownTime = 0;

        canvas.addEventListener('mousedown', (event) => {
            if (event.button === 0) {
                mouseDownPos = { x: event.clientX, y: event.clientY };
                mouseDownTime = Date.now();
            }
        }, true);

        canvas.addEventListener('mouseup', (event) => {
            if (event.button !== 0 || !this.sceneManager || !mouseDownPos) return;

            const dx = event.clientX - mouseDownPos.x;
            const dy = event.clientY - mouseDownPos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const duration = Date.now() - mouseDownTime;

            if (distance < 5 && duration < 300) {
                const raycaster = new THREE.Raycaster();
                const mouse = new THREE.Vector2();

                const rect = canvas.getBoundingClientRect();
                mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
                mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

                raycaster.setFromCamera(mouse, this.sceneManager.camera);
                const intersects = raycaster.intersectObjects(this.sceneManager.scene.children, true);

                const modelIntersects = intersects.filter(intersect => {
                    const obj = intersect.object;
                    let current = obj;
                    while (current) {
                        const name = current.name || '';
                        if (name.includes('jointAxis') || name.includes('helper') ||
                            name.includes('grid') || name.includes('Ground') ||
                            name === 'groundPlane') {
                            return false;
                        }
                        current = current.parent;
                    }
                    return obj.isMesh && obj.visible;
                });

                if (modelIntersects.length === 0) {
                    this.sceneManager.highlightManager.clearHighlight();

                    // Clear selection in graph
                    if (this.modelGraphView) {
                        const svg = d3.select('#model-graph-svg');
                        this.modelGraphView.clearAllSelections(svg);
                    }

                    // Clear measurement state
                    if (this.measurementController) {
                        this.measurementController.clearMeasurement();
                    }
                }
            }

            mouseDownPos = null;
        }, true);
    }

    /**
     * Setup model tree panel
     */
    setupModelTreePanel() {
        const toggleBtn = document.getElementById('toggle-model-tree');
        const floatingPanel = document.getElementById('floating-model-tree');

        if (toggleBtn && floatingPanel) {
            floatingPanel.style.display = 'flex';
            toggleBtn.classList.add('active');
        }

        if (floatingPanel) {
            // Click blank area to deselect
            floatingPanel.addEventListener('click', (event) => {
                const target = event.target;

                if (target === floatingPanel ||
                    target.classList?.contains('graph-controls-hint') ||
                    target.classList?.contains('empty-state') ||
                    target.id === 'floating-model-tree') {

                    if (this.modelGraphView) {
                        const svg = d3.select('#model-graph-svg');
                        this.modelGraphView.clearAllSelections(svg);
                    }

                    if (this.measurementController) {
                        this.measurementController.clearMeasurement();
                    }

                    if (this.sceneManager) {
                        this.sceneManager.highlightManager.clearHighlight();
                    }
                }
            });
        }
    }

    /**
     * Update model info display
     */
    updateModelInfo(model, file) {
        const statusInfo = document.getElementById('status-info');
        if (!statusInfo || !model) return;

        let info = `<strong>${file.name}</strong><br>`;

        const fileType = file.name.split('.').pop().toLowerCase();
        info += `Type: ${fileType.toUpperCase()}<br>`;

        if (model.links) {
            info += `Links: ${model.links.size}<br>`;
        }

        if (model.joints) {
            const controllableJoints = Array.from(model.joints.values()).filter(j => j.type !== 'fixed').length;
            info += `Joints: ${model.joints.size} (${controllableJoints} controllable)<br>`;
        }

        // Show constraint info (parallel mechanism)
        if (model.constraints && model.constraints.size > 0) {
            info += `<span style="color: #00aaff; font-weight: bold;">Constraints: ${model.constraints.size} 🔗</span><br>`;

            // Count different constraint types
            const constraintTypes = {};
            model.constraints.forEach((constraint) => {
                constraintTypes[constraint.type] = (constraintTypes[constraint.type] || 0) + 1;
            });

            // Show constraint type details
            const typeLabels = {
                'connect': 'Connect',
                'weld': 'Weld',
                'joint': 'Joint Coupling',
                'distance': 'Distance'
            };

            const typeDetails = Object.entries(constraintTypes)
                .map(([type, count]) => `${typeLabels[type] || type}: ${count}`)
                .join(', ');

            info += `<span style="font-size: 11px; color: #888;">${typeDetails}</span><br>`;
        }

        if (model.rootLink) {
            info += `Root Link: ${model.rootLink}`;
        }

        statusInfo.innerHTML = info;
        statusInfo.className = 'success';
    }

    /**
     * Handle file click
     */
    handleFileClick(fileInfo) {
        const ext = fileInfo.ext;
        const modelExts = ['urdf', 'xacro', 'xml', 'usd', 'usda', 'usdc', 'usdz'];
        const meshExts = ['dae', 'stl', 'obj', 'collada'];

        if (modelExts.includes(ext)) {
            // Robot model file, load model and load into editor
            this.fileHandler.loadFile(fileInfo.file);

            // If editor is open, auto-load file into editor
            const editorPanel = document.getElementById('code-editor-panel');
            if (editorPanel && editorPanel.classList.contains('visible') && this.codeEditorManager) {
                this.codeEditorManager.loadFile(fileInfo.file);
            }
        } else if (meshExts.includes(ext)) {
            // Mesh file, load as standalone model only, don't load into editor
            this.fileHandler.loadMeshAsModel(fileInfo.file, fileInfo.name);
        }
    }

    /**
     * Create USD viewer container
     */
    createUSDViewerContainer() {
        // Create USD viewer container in canvas container
        const canvasContainer = document.getElementById('canvas-container');
        if (!canvasContainer) {
            return;
        }

        const usdContainer = document.createElement('div');
        usdContainer.id = 'usd-viewer-container';
        usdContainer.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: none;
            z-index: 1;
            pointer-events: none;
        `;
        canvasContainer.appendChild(usdContainer);
    }

    /**
     * Get or create USD viewer manager (lazy loading)
     */
    async getUSDViewerManager() {
        if (!this.usdViewerManager) {
            const container = document.getElementById('usd-viewer-container');
            if (!container) {
                throw new Error('USD viewer container not found');
            }

            this.usdViewerManager = new USDViewerManager(container);
            this.fileHandler.setUSDViewerManager(this.usdViewerManager);

            // Listen for loading progress
            this.usdViewerManager.on('USD_LOADING_START', (event) => {
                const message = event.data?.message || 'Loading USD...';
                const statusInfo = document.getElementById('status-info');
                if (statusInfo) {
                    statusInfo.textContent = message;
                    statusInfo.className = 'info';
                }
            });

            this.usdViewerManager.on('USD_LOADED', () => {
                const statusInfo = document.getElementById('status-info');
                if (statusInfo) {
                    statusInfo.textContent = 'USD file loaded successfully';
                    statusInfo.className = 'success';
                }
            });

            this.usdViewerManager.on('USD_ERROR', (event) => {
                const error = event.data?.error || 'Load failed';
                const statusInfo = document.getElementById('status-info');
                if (statusInfo) {
                    statusInfo.textContent = `Load failed: ${error}`;
                    statusInfo.className = 'error';
                }
            });
        }

        return this.usdViewerManager;
    }

    /**
     * Handle theme change
     */
    handleThemeChanged(theme) {
        if (this.codeEditorManager) {
            this.codeEditorManager.updateTheme(theme);
        }
        if (this.currentModel && this.modelGraphView) {
            this.modelGraphView.drawModelGraph(this.currentModel);
        }
        this.animationWorkspace?.refreshTheme();
    }

    /**
     * Handle angle unit change
     */
    handleAngleUnitChanged(unit) {
        this.angleUnit = unit;
        if (this.jointControlsUI) {
            this.jointControlsUI.setAngleUnit(unit);
        }
    }

    /**
     * Handle reset joints button
     */
    handleResetJoints() {
        if (this.currentModel && this.jointControlsUI) {
            this.jointControlsUI.resetAllJoints(this.currentModel);
        }
    }

    /**
     * Handle ignore limits toggle
     */
    handleIgnoreLimitsChanged(ignore) {
        if (this.jointControlsUI && this.currentModel) {
            this.jointControlsUI.updateAllSliderLimits(this.currentModel, ignore);
        }
    }

    /**
     * Handle language change
     */
    handleLanguageChanged(lang) {
        i18n.setLanguage(lang);
        this.animationWorkspace?.refreshLanguage();

        // Update code editor save status text
        if (this.codeEditorManager) {
            this.codeEditorManager.updateEditorSaveStatus();
        }

        // Update joint controls panel (if model exists)
        if (this.currentModel && this.jointControlsUI) {
            this.jointControlsUI.setupJointControls(this.currentModel);
        }

        // Redraw model graph (if current model exists)
        if (this.currentModel && this.modelGraphView) {
            this.modelGraphView.drawModelGraph(this.currentModel);
        }

        // Update file tree view (preserve expanded state)
        if (this.fileTreeView && this.fileHandler) {
            this.fileTreeView.updateFileTree(
                this.fileHandler.getAvailableModels(),
                this.fileHandler.getFileMap(),
                true
            );
        }

        // Update simulation button text
        const simulateBtn = document.getElementById('mujoco-simulate-btn-bar');
        if (simulateBtn) {
            const span = simulateBtn.querySelector('span');
            if (span) {
                const isActive = simulateBtn.classList.contains('active');
                const key = isActive ? 'mujocoPause' : 'mujocoSimulate';
                span.textContent = i18n.t(key);
                span.setAttribute('data-i18n', key);
            }
        }
    }

    /**
     * Set axes button state
     */
    setAxesButtonState(show) {
        const axesBtn = document.getElementById('toggle-axes-btn');
        if (!axesBtn) return;

        axesBtn.setAttribute('data-checked', show.toString());
        if (show) {
            axesBtn.classList.add('active');
            if (this.sceneManager) {
                this.sceneManager.axesManager.showAllAxes();
            }
        } else {
            axesBtn.classList.remove('active');
            if (this.sceneManager) {
                this.sceneManager.axesManager.hideAllAxes();
            }
        }
    }

    /**
     * Detect file type
     */
    detectFileType(fileName) {
        const ext = fileName.toLowerCase().split('.').pop();
        const typeMap = {
            'urdf': 'urdf',
            'xml': 'mjcf',
            'usd': 'usd',
            'usda': 'usd',
            'usdc': 'usd',
            'usdz': 'usd'
        };
        return typeMap[ext] || 'urdf';
    }

    /**
     * Handle MuJoCo reset
     */
    handleMujocoReset() {
        if (this.mujocoSimulationManager) {
            // Only reset simulation state, don't change run/pause state
            this.mujocoSimulationManager.reset();
        }
    }

    /**
     * Handle MuJoCo simulation toggle
     */
    async handleMujocoToggleSimulate() {
        // If simulation not loaded, load first
        if (!this.mujocoSimulationManager.hasScene() && this.currentMJCFFile && this.currentMJCFModel) {
            try {
                const xmlContent = await this.currentMJCFFile.text();

                // Load MuJoCo physics engine (pass original model for material info)
                await this.mujocoSimulationManager.loadScene(
                    xmlContent,
                    this.currentMJCFFile.name,
                    this.fileHandler.getFileMap(),
                    this.currentMJCFModel  // Pass original model (for material info)
                );

                // Hide original model
                if (this.currentModel && this.currentModel.threeObject) {
                    this.currentModel.threeObject.visible = false;
                }

                // Start simulation immediately
                this.mujocoSimulationManager.startSimulation();
                return true;
            } catch (error) {
                console.error('MuJoCo scene loading failed:', error);
                // Error details are already logged to console, no need for alert popup
                return false;
            }
        }

        // Toggle simulation state
        if (this.mujocoSimulationManager) {
            const isSimulating = this.mujocoSimulationManager.toggleSimulation();

            // Toggle original model visibility
            if (this.currentModel && this.currentModel.threeObject) {
                this.currentModel.threeObject.visible = !isSimulating;
            }

            return isSimulating;
        }
        return false;
    }

    /**
     * Animation loop
     */
    animate() {
        requestAnimationFrame(() => this.animate());
        if (this.sceneManager) {
            this.sceneManager.update();

            // Update MuJoCo simulation
            if (this.mujocoSimulationManager && this.mujocoSimulationManager.hasScene()) {
                this.mujocoSimulationManager.update(performance.now());
            }

            this.sceneManager.render();
        }
    }
}

// Create and start application
const app = new App();
app.init();

// Expose to global (for debugging)
window.app = app;
