/**
 * PanelManager - Panel drag and resize management module
 * Responsible for drag, resize, and Z-index management of all floating panels
 */

export class PanelManager {
    constructor() {
        this.panels = new Map();
        this.modelGraphOriginalTransform = null; // Save original transform of model structure graph
        this.modelGraphView = null; // Save ModelGraphView instance reference
    }

    /**
     * Set ModelGraphView instance reference
     */
    setModelGraphView(modelGraphView) {
        this.modelGraphView = modelGraphView;
    }

    /**
     * Register panel
     */
    registerPanel(panelId, headerSelector = '.floating-panel-header') {
        const panel = document.getElementById(panelId);
        const header = panel?.querySelector(headerSelector);

        if (!panel || !header) {
            return;
        }

        this.setupPanelDragAndResize(panel, header);
        this.panels.set(panelId, { panel, header });
    }

    /**
     * Setup panel drag and resize
     */
    setupPanelDragAndResize(panel, header) {
        let isDragging = false;
        let isResizing = false;
        let resizeDirection = null;
        let currentX, currentY, initialX, initialY;
        let xOffset = 0, yOffset = 0;
        let startWidth, startHeight;
        let startTransformX, startTransformY;

        const resizeBorderWidth = 12;

        // Bring to front
        const bringToFront = () => {
            const allPanels = document.querySelectorAll('.floating-panel, #code-editor-panel');
            let maxZIndex = 50;

            allPanels.forEach(p => {
                const z = parseInt(window.getComputedStyle(p).zIndex) || 50;
                if (z > maxZIndex && p !== panel) {
                    maxZIndex = z;
                }
            });

            panel.style.zIndex = maxZIndex + 1;
        };

        // Mouse move to detect edges
        panel.addEventListener('mousemove', (e) => {
            if (isDragging || isResizing) return;

            const rect = panel.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            let cursor = 'default';
            resizeDirection = null;

            const isNearLeftEdge = x < resizeBorderWidth;
            const isNearRightEdge = x > rect.width - resizeBorderWidth;
            const isNearTopEdge = y < resizeBorderWidth;
            const isNearBottomEdge = y > rect.height - resizeBorderWidth;

            if (isNearLeftEdge && isNearTopEdge) {
                cursor = 'nw-resize';
                resizeDirection = 'nw';
            } else if (isNearRightEdge && isNearTopEdge) {
                cursor = 'ne-resize';
                resizeDirection = 'ne';
            } else if (isNearLeftEdge && isNearBottomEdge) {
                cursor = 'sw-resize';
                resizeDirection = 'sw';
            } else if (isNearRightEdge && isNearBottomEdge) {
                cursor = 'se-resize';
                resizeDirection = 'se';
            } else if (isNearLeftEdge) {
                cursor = 'w-resize';
                resizeDirection = 'w';
            } else if (isNearRightEdge) {
                cursor = 'e-resize';
                resizeDirection = 'e';
            } else if (isNearTopEdge) {
                cursor = 'n-resize';
                resizeDirection = 'n';
            } else if (isNearBottomEdge) {
                cursor = 's-resize';
                resizeDirection = 's';
            }

            panel.style.cursor = cursor;
        });

        // Mouse down to start drag or resize
        panel.addEventListener('mousedown', (e) => {
            bringToFront();

            if (e.target === header || header.contains(e.target)) {
                return;
            }

            if (resizeDirection) {
                e.preventDefault();
                isResizing = true;

                // Disable transition animation during resize to avoid delay
                panel.style.transition = 'none';

                const rect = panel.getBoundingClientRect();
                const style = window.getComputedStyle(panel);
                const matrix = new DOMMatrixReadOnly(style.transform);

                startWidth = rect.width;
                startHeight = rect.height;
                startTransformX = matrix.m41;
                startTransformY = matrix.m42;
                initialX = e.clientX;
                initialY = e.clientY;

                document.addEventListener('mousemove', resize);
                document.addEventListener('mouseup', stopResize);
            }
        });

        // Drag start
        const dragStart = (e) => {
            bringToFront();

            const target = e.target;
            if (target.tagName === 'BUTTON' || target.tagName === 'SELECT' ||
                target.closest('button') || target.closest('.code-editor-actions')) {
                return;
            }

            if (target === header || header.contains(target)) {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
                isDragging = true;
                header.style.cursor = 'grabbing';

                // Disable transition animation during drag to avoid delay
                panel.style.transition = 'none';

                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', dragEnd);
            }
        };

        const drag = (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                xOffset = currentX;
                yOffset = currentY;
                panel.style.transform = `translate(${currentX}px, ${currentY}px)`;
            }
        };

        const dragEnd = () => {
            isDragging = false;
            header.style.cursor = 'move';

            // Restore transition animation after drag ends
            panel.style.transition = '';

            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', dragEnd);
        };

        const resize = (e) => {
            if (!isResizing) return;
            e.preventDefault();

            if (panel._resizeFrame) return;

            panel._resizeFrame = requestAnimationFrame(() => {
                panel._resizeFrame = null;

                const dx = e.clientX - initialX;
                const dy = e.clientY - initialY;

                let newWidth = startWidth;
                let newHeight = startHeight;
                let newTransformX = startTransformX;
                let newTransformY = startTransformY;

                if (resizeDirection.includes('w')) {
                    const desiredWidth = startWidth - dx;
                    newWidth = Math.max(280, desiredWidth);
                    if (desiredWidth >= 280) {
                        newTransformX = startTransformX + dx;
                    } else {
                        newTransformX = startTransformX - (startWidth - 280);
                    }
                }

                if (resizeDirection.includes('e')) {
                    newWidth = Math.max(280, startWidth + dx);
                    newTransformX = startTransformX;
                }

                if (resizeDirection.includes('s')) {
                    newHeight = Math.max(100, startHeight + dy);
                    newTransformY = startTransformY;
                }

                if (resizeDirection.includes('n')) {
                    const desiredHeight = startHeight - dy;
                    newHeight = Math.max(100, desiredHeight);
                    if (desiredHeight >= 100) {
                        newTransformY = startTransformY + dy;
                    } else {
                        newTransformY = startTransformY + (startHeight - 100);
                    }
                }

                panel.style.width = newWidth + 'px';
                panel.style.height = newHeight + 'px';
                panel.style.transform = `translate(${newTransformX}px, ${newTransformY}px)`;

                xOffset = newTransformX;
                yOffset = newTransformY;
            });
        };

        const stopResize = () => {
            isResizing = false;
            resizeDirection = null;
            panel.style.cursor = 'default';

            // Restore transition animation after resize ends
            panel.style.transition = '';

            document.removeEventListener('mousemove', resize);
            document.removeEventListener('mouseup', stopResize);
        };

        header.addEventListener('mousedown', dragStart);
    }

    /**
     * Initialize all panels
     */
    initAllPanels() {
        this.registerPanel('floating-files-panel');
        this.registerPanel('floating-joints-panel');
        this.registerPanel('floating-base-pose-panel');
        this.registerPanel('floating-model-tree');
        this.registerPanel('floating-help-panel');
        this.registerPanel('code-editor-panel', '.code-editor-header');

        // Setup all maximize buttons (common functionality)
        this.setupMaximizeButtons();
    }

    /**
     * Setup maximize buttons (common functionality)
     * Automatically find all buttons with panel-maximize-btn class and bind events
     */
    setupMaximizeButtons() {
        // Find all maximize buttons
        const maximizeButtons = document.querySelectorAll('.panel-maximize-btn');

        maximizeButtons.forEach(button => {
            // Get panel ID from data-panel-id attribute
            const panelId = button.getAttribute('data-panel-id');

            if (!panelId) {
                return;
            }

            const panel = document.getElementById(panelId);
            if (!panel) {
                return;
            }

            // Bind click event
            button.addEventListener('click', () => {
                const isCurrentlyMaximized = panel.classList.contains('maximized');

                if (isCurrentlyMaximized) {
                    // Restore original size
                    panel.classList.remove('maximized');
                    button.textContent = '⛶';

                    // If model structure graph, restore original view
                    if (panelId === 'floating-model-tree' && this.modelGraphView) {
                        setTimeout(() => {
                            this.restoreModelGraphView();
                        }, 450);
                    }
                } else {
                    // Maximize
                    panel.classList.add('maximized');
                    button.textContent = '❐';

                    // If model structure graph, save current view and adjust
                    if (panelId === 'floating-model-tree' && this.modelGraphView) {
                        this.saveModelGraphTransform();
                        setTimeout(() => {
                            this.modelGraphView.fitToView(true, 600);
                        }, 450);
                    }
                }
            });
        });
    }

    /**
     * Save current transform state of model structure graph
     */
    saveModelGraphTransform() {
        try {
            const svg = document.querySelector('#model-graph-svg');
            if (!svg) return;

            const d3 = window.d3;
            if (!d3) return;

            const svgSelection = d3.select(svg);
            const currentTransform = d3.zoomTransform(svg);

            if (currentTransform) {
                this.modelGraphOriginalTransform = {
                    x: currentTransform.x,
                    y: currentTransform.y,
                    k: currentTransform.k
                };
            }
        } catch (error) {
            console.error('Failed to save transform:', error);
        }
    }

    /**
     * Restore model structure graph to original view
     */
    restoreModelGraphView() {
        try {
            const svg = document.querySelector('#model-graph-svg');
            if (!svg) return;

            const d3 = window.d3;
            if (!d3) return;

            const svgSelection = d3.select(svg);
            const container = svgSelection.select('.zoom-container');

            if (container.empty()) return;

            // If saved transform exists, use it; otherwise call fitToView
            if (this.modelGraphOriginalTransform) {
                const zoom = d3.zoom()
                    .scaleExtent([0.1, 4])
                    .on('zoom', (event) => {
                        container.attr('transform', event.transform);
                    });

                svgSelection.call(zoom);

                const transform = d3.zoomIdentity
                    .translate(this.modelGraphOriginalTransform.x, this.modelGraphOriginalTransform.y)
                    .scale(this.modelGraphOriginalTransform.k);

                svgSelection.transition()
                    .duration(600)
                    .call(zoom.transform, transform);
            } else if (this.modelGraphView) {
                // If no saved transform, use fitToView for auto-fit
                this.modelGraphView.fitToView(true, 600);
            }
        } catch (error) {
            console.error('Failed to restore view:', error);
        }
    }
}

