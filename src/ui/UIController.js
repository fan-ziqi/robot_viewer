/**
 * UI Controller - Manages all UI panels and button interactions
 */
import * as THREE from 'three';

export class UIController {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
    }

    /**
     * Setup control panel events
     */
    setupControlPanel() {
        const showVisualBtn = document.getElementById('show-visual');
        const showCollisionBtn = document.getElementById('show-collision');
        const showComBtn = document.getElementById('show-com');
        const showInertiaBtn = document.getElementById('show-inertia');
        const ignoreLimitsBtn = document.getElementById('ignore-limits');

        // Helper function: toggle button state
        const toggleButton = (button, callback) => {
            if (!button) return;

            const isActive = button.classList.contains('active');
            const newState = !isActive;

            if (newState) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }

            button.setAttribute('data-checked', newState.toString());

            if (callback) {
                callback(newState);
            }
        };

        // Sync initial state to sceneManager
        if (this.sceneManager && showVisualBtn) {
            const isChecked = showVisualBtn.classList.contains('active');
            this.sceneManager.visualizationManager.showVisual = isChecked;
        }
        if (this.sceneManager && showCollisionBtn) {
            this.sceneManager.visualizationManager.showCollision = showCollisionBtn.classList.contains('active');
        }
        if (this.sceneManager && showComBtn) {
            this.sceneManager.inertialVisualization.showCOM = showComBtn.classList.contains('active');
        }
        if (this.sceneManager && showInertiaBtn) {
            this.sceneManager.inertialVisualization.showInertia = showInertiaBtn.classList.contains('active');
        }
        if (this.sceneManager && ignoreLimitsBtn) {
            this.sceneManager.ignoreLimits = !ignoreLimitsBtn.classList.contains('active');
        }

        // Display options event listeners
        if (showVisualBtn) {
            showVisualBtn.addEventListener('click', () => {
                toggleButton(showVisualBtn, (newState) => {
                    this.sceneManager.visualizationManager.toggleVisual(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its visual display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleVisualDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showCollisionBtn) {
            showCollisionBtn.addEventListener('click', () => {
                toggleButton(showCollisionBtn, (newState) => {
                    this.sceneManager.visualizationManager.toggleCollision(newState);

                    // If MuJoCo simulation is running, also toggle its collision display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleCollisionDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showComBtn) {
            showComBtn.addEventListener('click', () => {
                toggleButton(showComBtn, (newState) => {
                    this.sceneManager.inertialVisualization.toggleCenterOfMass(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its COM display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleCOMDisplay(newState);
                    }

                    this.sceneManager.updateVisualTransparency();
                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showInertiaBtn) {
            showInertiaBtn.addEventListener('click', () => {
                toggleButton(showInertiaBtn, (newState) => {
                    this.sceneManager.inertialVisualization.toggleInertia(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its inertia display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleInertiaDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (ignoreLimitsBtn) {
            ignoreLimitsBtn.addEventListener('click', () => {
                toggleButton(ignoreLimitsBtn, (newState) => {
                    this.sceneManager.setIgnoreLimits(!newState);
                    this.onIgnoreLimitsChanged?.(!newState);
                });
            });
        }

        // Coordinate system direction toggle
        const upSelect = document.getElementById('up-select');
        if (upSelect) {
            upSelect.addEventListener('change', (e) => {
                this.sceneManager.setUp(e.target.value);
            });
        }

        // Angle unit toggle
        const unitRad = document.getElementById('unit-rad');
        const unitDeg = document.getElementById('unit-deg');

        if (unitRad) {
            unitRad.addEventListener('click', () => {
                this.angleUnit = 'rad';
                unitRad.classList.add('active');
                if (unitDeg) unitDeg.classList.remove('active');
                this.onAngleUnitChanged?.(this.angleUnit);
            });
        }

        if (unitDeg) {
            unitDeg.addEventListener('click', () => {
                this.angleUnit = 'deg';
                unitDeg.classList.add('active');
                if (unitRad) unitRad.classList.remove('active');
                this.onAngleUnitChanged?.(this.angleUnit);
            });
        }

        // Reset button
        const resetJointsBtn = document.getElementById('reset-joints-btn');
        if (resetJointsBtn) {
            resetJointsBtn.addEventListener('click', () => {
                this.onResetJoints?.();
            });
        }

        // MuJoCo simulation control buttons
        const mujocoResetBtn = document.getElementById('mujoco-reset-btn-bar');
        if (mujocoResetBtn) {
            mujocoResetBtn.addEventListener('click', () => {
                this.onMujocoReset?.();
            });
        }

        const mujocoSimulateBtn = document.getElementById('mujoco-simulate-btn-bar');
        if (mujocoSimulateBtn) {
            mujocoSimulateBtn.addEventListener('click', async () => {
                const isSimulating = await this.onMujocoToggleSimulate?.();
                if (isSimulating !== undefined) {
                    mujocoSimulateBtn.classList.toggle('active', isSimulating);
                    const span = mujocoSimulateBtn.querySelector('span');
                    if (span) {
                        // Use i18n to update button text
                        const key = isSimulating ? 'mujocoPause' : 'mujocoSimulate';
                        span.textContent = window.i18n?.t(key) || (isSimulating ? 'Pause' : 'Simulate');
                        span.setAttribute('data-i18n', key);
                    }
                }
            });
        }
    }

    /**
     * Setup theme toggle
     */
    setupThemeToggle(onThemeChanged) {
        const themeToggle = document.getElementById('theme-toggle');
        if (!themeToggle) {
            return;
        }

        const currentTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        this.updateThemeIcon(currentTheme);

        if (this.sceneManager) {
            this.sceneManager.updateBackgroundColor();
        }

        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            this.updateThemeIcon(newTheme);

            if (this.sceneManager) {
                this.sceneManager.updateBackgroundColor();
            }

            onThemeChanged?.(newTheme);
        });
    }

    /**
     * Setup language toggle
     */
    setupLanguageToggle(onLanguageChanged) {
        const languageToggle = document.getElementById('language-toggle');
        if (!languageToggle) {
            return;
        }

        // Get current language from i18n
        const currentLang = window.i18n?.getCurrentLanguage() || 'zh-CN';
        this.updateLanguageIcon(currentLang);

        languageToggle.addEventListener('click', () => {
            const currentLang = window.i18n?.getCurrentLanguage() || 'zh-CN';
            const newLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';

            onLanguageChanged?.(newLang);
            this.updateLanguageIcon(newLang);
        });
    }

    /**
     * Update language icon
     */
    updateLanguageIcon(lang) {
        const languageToggle = document.getElementById('language-toggle');
        const text = languageToggle?.querySelector('.tool-button-text');
        if (text) {
            // Display the other language based on current language (toggle hint)
            text.textContent = lang === 'zh-CN' ? 'Language' : '语言';
        }
    }

    /**
     * Update theme icon
     */
    updateThemeIcon(theme) {
        const themeToggle = document.getElementById('theme-toggle');
        const icon = themeToggle?.querySelector('.tool-button-icon');
        if (icon) {
            icon.textContent = theme === 'dark' ? '🌙' : '☀️';
        }
    }


    /**
     * Close a panel programmatically
     * @param {string} panelId - Panel ID to close
     * @param {string} buttonId - Toggle button ID (optional)
     */
    closePanel(panelId, buttonId = null) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        
        // Special handling for code-editor-panel which uses 'visible' class
        if (panelId === 'code-editor-panel') {
            const isVisible = panel.classList.contains('visible');
            if (isVisible) {
                panel.classList.remove('visible');
                if (buttonId) {
                    const button = document.getElementById(buttonId);
                    if (button) {
                        button.classList.remove('active');
                    }
                }
            }
            return;
        }
        
        // Standard panels use display style
        const isVisible = panel.style.display !== 'none' &&
                         getComputedStyle(panel).display !== 'none';
        
        if (isVisible) {
            panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            panel.style.opacity = '0';
            panel.style.transform = 'scale(0.95)';

            setTimeout(() => {
                panel.style.display = 'none';
                panel.style.opacity = '';
                panel.style.transform = '';
            }, 200);

            if (buttonId) {
                const button = document.getElementById(buttonId);
                if (button) {
                    button.classList.remove('active');
                }
            }
        }
    }

    /**
     * Setup panel close button functionality
     */
    setupPanelCloseButtons() {
        const panelButtonMap = {
            'floating-files-panel': 'toggle-files-panel',
            'floating-joints-panel': 'toggle-joints-panel',
            'floating-base-pose-panel': 'toggle-base-pose-panel',
            'floating-model-tree': 'toggle-model-tree',
            'floating-help-panel': 'help-button'
        };

        const closeButtons = document.querySelectorAll('.panel-close-btn');

        closeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panelId = btn.getAttribute('data-panel');
                const panel = document.getElementById(panelId);
                const toggleBtnId = panelButtonMap[panelId];
                const toggleBtn = toggleBtnId ? document.getElementById(toggleBtnId) : null;

                if (panel) {
                    const isVisible = panel.style.display !== 'none';

                    if (isVisible) {
                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        setTimeout(() => {
                            panel.style.display = 'none';
                            panel.style.opacity = '';
                            panel.style.transform = '';
                        }, 200);

                        if (toggleBtn) {
                            toggleBtn.classList.remove('active');
                        }
                        
                        // Unfix ground when base pose panel is closed
                        if (panelId === 'floating-base-pose-panel' && this.sceneManager) {
                            this.sceneManager.setFixedGround(false);
                            
                            // Update fixed ground button state
                            const fixedGroundBtn = document.getElementById('toggle-fixed-ground');
                            if (fixedGroundBtn) {
                                fixedGroundBtn.classList.remove('active');
                                fixedGroundBtn.setAttribute('data-checked', 'false');
                            }
                        }
                    }
                }
            });
        });

        Object.entries(panelButtonMap).forEach(([panelId, buttonId]) => {
            const button = document.getElementById(buttonId);
            const panel = document.getElementById(panelId);

            if (button && panel) {
                button.addEventListener('click', () => {
                    const isVisible = panel.style.display !== 'none' &&
                                     getComputedStyle(panel).display !== 'none';

                    if (isVisible) {
                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        setTimeout(() => {
                            panel.style.display = 'none';
                            panel.style.opacity = '';
                            panel.style.transform = '';
                        }, 200);

                        button.classList.remove('active');
                        
                        // Unfix ground when base pose panel is closed
                        if (panelId === 'floating-base-pose-panel' && this.sceneManager) {
                            this.sceneManager.setFixedGround(false);
                            
                            // Update fixed ground button state
                            const fixedGroundBtn = document.getElementById('toggle-fixed-ground');
                            if (fixedGroundBtn) {
                                fixedGroundBtn.classList.remove('active');
                                fixedGroundBtn.setAttribute('data-checked', 'false');
                            }
                        }
                    } else {
                        panel.style.display = 'flex';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        panel.offsetHeight;

                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '1';
                        panel.style.transform = 'scale(1)';

                        setTimeout(() => {
                            panel.style.transition = '';
                        }, 200);

                        button.classList.add('active');
                        
                        // Auto-fix ground when base pose panel is opened
                        if (panelId === 'floating-base-pose-panel' && this.sceneManager) {
                            this.sceneManager.setFixedGround(true);
                            
                            // Update fixed ground button state
                            const fixedGroundBtn = document.getElementById('toggle-fixed-ground');
                            if (fixedGroundBtn) {
                                fixedGroundBtn.classList.add('active');
                                fixedGroundBtn.setAttribute('data-checked', 'true');
                            }
                            
                            // Auto-load frames when base pose panel is opened
                            if (window.app && window.app.basePoseControlsUI && window.app.currentModel) {
                                window.app.basePoseControlsUI.loadFrameFile(window.app.currentModel);
                            }
                            
                            // Close other panels when base pose panel is opened
                            this.closePanel('floating-files-panel', 'toggle-files-panel');
                            this.closePanel('floating-model-tree', 'toggle-model-tree');
                            this.closePanel('code-editor-panel', 'open-editor-btn');
                        }
                    }
                });
            }
        });
    }

    /**
     * Setup coordinate axes toggle button
     */
    setupAxesToggle() {
        const axesBtn = document.getElementById('toggle-axes-btn');
        if (!axesBtn) {
            return;
        }

        axesBtn.addEventListener('click', () => {
            const isChecked = axesBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            axesBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                axesBtn.classList.add('active');
                this.sceneManager.axesManager.showAllAxes();

                // If MuJoCo simulation is running, also show its axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleAxesDisplay(true);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            } else {
                axesBtn.classList.remove('active');
                this.sceneManager.axesManager.hideAllAxes();

                // If MuJoCo simulation is running, also hide its axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleAxesDisplay(false);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            }
        });
    }

    /**
     * Setup joint axes toggle button
     */
    setupJointAxesToggle() {
        const jointAxesBtn = document.getElementById('toggle-joint-axes-btn');
        if (!jointAxesBtn) {
            return;
        }

        jointAxesBtn.addEventListener('click', () => {
            const isChecked = jointAxesBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            jointAxesBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                jointAxesBtn.classList.add('active');
                this.sceneManager.axesManager.showAllJointAxes();

                // If MuJoCo simulation is running, also show its joint axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleJointAxesDisplay(true);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            } else {
                jointAxesBtn.classList.remove('active');
                this.sceneManager.axesManager.hideAllJointAxes();

                // If MuJoCo simulation is running, also hide its joint axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleJointAxesDisplay(false);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            }
        });
    }

    /**
     * Setup shadow toggle button
     */
    setupShadowToggle() {
        const shadowBtn = document.getElementById('toggle-shadow');
        if (!shadowBtn) {
            return;
        }

        shadowBtn.addEventListener('click', () => {
            const isChecked = shadowBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            shadowBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                shadowBtn.classList.add('active');
                this.sceneManager.visualizationManager.toggleShadow(true, this.sceneManager.renderer, this.sceneManager.directionalLight);
                this.sceneManager.axesManager.ensureAxesNoShadow();
                this.sceneManager.updateEnvironment();
                this.sceneManager.redraw();
                this.sceneManager.render();
            } else {
                shadowBtn.classList.remove('active');
                this.sceneManager.visualizationManager.toggleShadow(false, this.sceneManager.renderer, this.sceneManager.directionalLight);
                this.sceneManager.redraw();
                this.sceneManager.render();
            }
        });
    }

    /**
     * Setup fixed ground toggle button
     */
    setupFixedGroundToggle() {
        const fixedGroundBtn = document.getElementById('toggle-fixed-ground');
        if (!fixedGroundBtn) {
            return;
        }

        fixedGroundBtn.addEventListener('click', () => {
            const isChecked = fixedGroundBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            fixedGroundBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                fixedGroundBtn.classList.add('active');
                this.sceneManager.setFixedGround(true);
            } else {
                fixedGroundBtn.classList.remove('active');
                this.sceneManager.setFixedGround(false);
            }
        });
    }

    /**
     * Setup lighting toggle button
     */
    setupLightingToggle() {
        const lightingBtn = document.getElementById('toggle-lighting');
        if (!lightingBtn) {
            return;
        }

        lightingBtn.addEventListener('click', () => {
            const isChecked = lightingBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            lightingBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                lightingBtn.classList.add('active');
                this.sceneManager.visualizationManager.toggleEnhancedLighting(true);
            } else {
                lightingBtn.classList.remove('active');
                this.sceneManager.visualizationManager.toggleEnhancedLighting(false);
            }
            this.sceneManager.redraw();
        });
    }


    /**
     * Setup all buttons and panels
     */
    setupAll(callbacks = {}) {
        // Save all callbacks (before setupControlPanel)
        this.onAngleUnitChanged = callbacks.onAngleUnitChanged;
        this.onIgnoreLimitsChanged = callbacks.onIgnoreLimitsChanged;
        this.onResetJoints = callbacks.onResetJoints;
        this.onMujocoReset = callbacks.onMujocoReset;
        this.onMujocoToggleSimulate = callbacks.onMujocoToggleSimulate;

        this.setupControlPanel();
        this.setupThemeToggle(callbacks.onThemeChanged);
        this.setupLanguageToggle(callbacks.onLanguageChanged);
        this.setupPanelCloseButtons();
        this.setupAxesToggle();
        this.setupJointAxesToggle();
        this.setupShadowToggle();
        this.setupFixedGroundToggle();
        this.setupLightingToggle();
    }

    /**
     * Get current angle unit
     */
    getAngleUnit() {
        return this.angleUnit;
    }
}

