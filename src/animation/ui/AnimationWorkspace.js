import { AnimationStore } from '../core/AnimationStore.js';
import { EditorSelection } from '../core/EditorSelection.js';
import { PlaybackController } from '../runtime/PlaybackController.js';
import { MediaPlaybackController } from '../runtime/MediaPlaybackController.js';
import { TimelineCanvas } from './TimelineCanvas.js';
import { GraphCanvas } from './GraphCanvas.js';
import './animation-workspace.css';

export class AnimationWorkspace {
    constructor({ poseController }) {
        this.poseController = poseController;
        this.store = new AnimationStore();
        this.selection = new EditorSelection();
        this.playback = new PlaybackController(this.store, poseController);
        this.model = null;
        this.modelName = 'Robot';
        this.visible = false;
        this.autoKey = true;
        this.viewMode = 'timeline';
        this.clipboard = null;
        this.autosaveTimer = null;
        this.suspendAutosave = false;
        this.recording = false;
        this.recordingTrackIds = new Set();
        this.gamepadValues = new Map();
        this.pressedInputKeys = new Set();
        this.guideVisible = true;
        this.toastTimer = null;
        this.toastFinalizeTimer = null;

        this.createUI();
        this.timeline = new TimelineCanvas({
            canvas: this.timelineCanvas,
            scroller: this.timelineScroller,
            store: this.store,
            playback: this.playback,
            selection: this.selection,
            getVelocityLimit: (jointName) => this.model?.joints?.get(jointName)?.limits?.velocity
        });
        this.graph = new GraphCanvas({
            canvas: this.graphCanvas,
            scroller: this.graphScroller,
            store: this.store,
            playback: this.playback,
            selection: this.selection,
            getVelocityLimit: (jointName) => this.model?.joints?.get(jointName)?.limits?.velocity
        });
        this.mediaPlayback = new MediaPlaybackController(this.store, this.playback, this.videoPreviewContainer);
        this.timeline.onZoomChanged = (zoom) => this.syncZoomSlider(zoom);
        this.graph.onZoomChanged = (zoom) => this.syncZoomSlider(zoom);
        this.timeline.onEditMarker = (marker) => this.renameMarker(marker);

        this.bindEvents();
        this.setupDockingAvoidance();
        this.poseController.subscribe((event) => this.handlePoseEvent(event));
        this.store.subscribe((event) => this.handleStoreEvent(event));
        this.selection.subscribe(() => this.syncSelectionControls());
        this.playback.subscribe((state) => this.syncPlaybackControls(state));
        this.syncAllControls();
        this.gamepadFrame = requestAnimationFrame(() => this.pollGamepads());
    }

    createUI() {
        this.root = document.createElement('section');
        this.root.id = 'animation-workspace';
        this.root.hidden = true;
        this.root.innerHTML = `
            <div class="animation-resize-handle" data-action="resize"></div>
            <div class="animation-toolbar animation-toolbar-primary">
                <div class="animation-title">
                    <span class="animation-title-mark">◆</span>
                    <span data-i18n="animationEditor">Animation Editor</span>
                    <span class="animation-experimental-badge" data-i18n="animationExperimental">Experimental · In development</span>
                </div>
                <div class="animation-tool-group animation-clip-group">
                    <select class="animation-select animation-clip-select" data-action="clip" title="Animation"></select>
                    <div class="animation-popover-wrap">
                        <button type="button" class="animation-icon-button" data-menu-toggle="clip" title="Animation options">•••</button>
                        <div class="animation-popover" data-menu="clip" hidden>
                            <button type="button" data-action="new-clip"><span>＋</span> New animation</button>
                            <button type="button" data-action="duplicate-clip"><span>⧉</span> Duplicate</button>
                            <button type="button" data-action="rename-clip"><span>✎</span> Rename</button>
                            <button type="button" class="danger" data-action="delete-clip"><span>⌫</span> Delete</button>
                        </div>
                    </div>
                </div>
                <div class="animation-tool-group">
                    <button type="button" class="animation-icon-button" data-action="undo" title="Undo (Ctrl/Cmd+Z)">↶</button>
                    <button type="button" class="animation-icon-button" data-action="redo" title="Redo (Ctrl/Cmd+Shift+Z)">↷</button>
                </div>
                <div class="animation-tool-group animation-transport">
                    <button type="button" class="animation-icon-button" data-action="stop" title="Stop">■</button>
                    <button type="button" class="animation-icon-button animation-play-button" data-action="play" title="Play/Pause (Space)">▶</button>
                    <button type="button" class="animation-icon-button animation-record-button" data-action="record" title="Record armed or selected tracks">●</button>
                </div>
                <div class="animation-segmented animation-view-switch">
                    <button type="button" class="active" data-action="show-timeline" data-i18n="dopeSheet">Dope Sheet</button>
                    <button type="button" data-action="show-graph" data-i18n="graphView">Graph</button>
                </div>
                <button type="button" class="animation-icon-button" data-action="input-map" title="Live gamepad input">⌁</button>
                <button type="button" class="animation-icon-button animation-guide-button" data-action="guide" title="Quick start guide">?</button>
                <span class="animation-spacer"></span>
                <span class="animation-save-status" data-i18n="saved">Saved</span>
                <div class="animation-popover-wrap">
                    <button type="button" class="animation-icon-button" data-menu-toggle="file" title="Project file">☰</button>
                    <div class="animation-popover animation-popover-right" data-menu="file" hidden>
                        <button type="button" data-action="import"><span>⇧</span> Import JSON</button>
                        <button type="button" data-action="export"><span>⇩</span> Export JSON</button>
                    </div>
                </div>
                <button type="button" class="animation-icon-button" data-action="close" title="Close">×</button>
                <input type="file" data-action="file" accept=".json,.robotanim.json,application/json" hidden>
            </div>
            <div class="animation-toolbar animation-toolbar-tools">
                <div class="animation-tool-group animation-nav-group">
                    <button type="button" class="animation-icon-button" data-action="previous-key" title="Previous keyframe (J)">◀◆</button>
                    <button type="button" class="animation-icon-button" data-action="next-key" title="Next keyframe (K)">◆▶</button>
                    <button type="button" class="animation-icon-button" data-action="previous-frame" title="Previous frame (Left)">−1f</button>
                    <button type="button" class="animation-icon-button" data-action="next-frame" title="Next frame (Right)">+1f</button>
                </div>
                <label class="animation-time-field"><span data-i18n="time">Time</span><input class="animation-time-input" data-action="time" value="0:00"></label>
                <div class="animation-popover-wrap">
                    <button type="button" class="animation-button animation-primary-action" data-menu-toggle="add">＋ <i data-i18n="animationAdd">Add</i></button>
                    <div class="animation-popover" data-menu="add" hidden>
                        <button type="button" data-action="key-current-pose"><span>◆</span><i data-i18n="animationAddPose">Record current pose</i></button>
                        <button type="button" data-action="key-current-pose-next"><span>◆→</span><i data-i18n="animationAddPoseNext">Record pose and advance</i></button>
                        <span class="animation-menu-separator"></span>
                        <button type="button" data-action="add-key"><span>◇</span><i data-i18n="animationAddSelectedKey">Key selected track</i></button>
                        <button type="button" data-action="add-media"><span>♪</span><i data-i18n="animationAddMedia">Audio / video</i></button>
                        <button type="button" data-menu-toggle="event"><span>⚡</span><i data-i18n="animationAddEvent">Event track</i><b>›</b></button>
                        <button type="button" data-action="marker"><span>▽</span><i data-i18n="animationAddMarker">Marker</i></button>
                        <span class="animation-menu-separator"></span>
                        <button type="button" data-action="capture-pose"><span>◉</span><i data-i18n="animationSavePose">Save reusable pose</i></button>
                        <button type="button" data-action="key-pose"><span>◇</span><i data-i18n="animationKeySavedPose">Key saved pose</i></button>
                        <button type="button" data-action="audio-reactive"><span>≋</span><i data-i18n="animationAudioReactive">Audio reactive keys</i></button>
                    </div>
                    <div class="animation-popover animation-submenu" data-menu="event" hidden>
                        <button type="button" data-event-kind="trigger"><span>⚡</span> Trigger event</button>
                        <button type="button" data-event-kind="boolean"><span>◐</span> On / off event</button>
                        <button type="button" data-event-kind="number"><span>◆</span> Curved value</button>
                        <button type="button" data-event-kind="color"><span>⬟</span> Color event</button>
                    </div>
                </div>
                <div class="animation-popover-wrap">
                    <button type="button" class="animation-icon-button" data-menu-toggle="edit" title="Edit selection">⋮</button>
                    <div class="animation-popover" data-menu="edit" hidden>
                        <button type="button" data-action="copy"><span>⧉</span> Copy</button>
                        <button type="button" data-action="paste"><span>▣</span> Paste</button>
                        <button type="button" class="danger" data-action="delete-key"><span>⌫</span> Delete selection</button>
                    </div>
                </div>
                <label class="animation-chip animation-autokey" title="Auto Key"><input type="checkbox" data-action="auto-key" checked><span data-i18n="autoKey">Auto Key</span></label>
                <label class="animation-chip" title="Loop playback"><input type="checkbox" data-action="loop" checked><span data-i18n="loop">Loop</span></label>
                <label class="animation-chip" title="Snap to 30 fps frames"><input type="checkbox" data-action="snap" checked><span>30 fps</span></label>
                <div class="animation-tool-group animation-zoom-group">
                    <span class="animation-zoom-icon">−</span><input type="range" data-action="zoom" min="0" max="100" value="75" title="Timeline zoom"><span class="animation-zoom-icon">＋</span>
                    <button type="button" class="animation-icon-button" data-action="fit-time" title="Fit animation">↔</button>
                    <button type="button" class="animation-icon-button graph-only" data-action="fit-value" title="Fit graph values">↕</button>
                </div>
                <div class="animation-segmented graph-only">
                    <button type="button" class="active" data-axis="none" title="Free move">◇</button>
                    <button type="button" data-axis="time" title="Lock to time axis">↔</button>
                    <button type="button" data-axis="value" title="Lock to value axis">↕</button>
                </div>
                <button type="button" class="animation-icon-button graph-only" data-action="lock-graph" title="Lock displayed curves to the current selection">♙</button>
                <span class="animation-spacer"></span>
                <label class="animation-duration-field"><span data-i18n="duration">Duration</span><input class="animation-time-input" data-action="duration" value="10:00"></label>
            </div>
            <div class="animation-toolbar animation-toolbar-properties" hidden>
                <span class="animation-selection">—</span>
                <label class="animation-field" title="Keyframe time"><span data-i18n="keyTime">Key time</span><input class="animation-time-input" data-action="key-time" disabled></label>
                <label class="animation-field" title="Keyframe value"><span data-i18n="keyValue">Value</span><input type="number" data-action="key-value" step="0.001" disabled></label>
                <label class="animation-field animation-event-value" title="Event state" hidden><span>State</span><input type="checkbox" data-action="key-boolean"></label>
                <label class="animation-field animation-event-color" title="Event color" hidden><span>Color</span><input type="color" data-action="key-color"></label>
                <label class="animation-field" title="Interpolation"><span data-i18n="interpolation">Interpolation</span>
                    <select class="animation-select" data-action="interpolation" disabled>
                        <option value="auto" data-i18n="autoSmooth">Auto Smooth</option>
                        <option value="smooth" data-i18n="smooth">Smooth</option>
                        <option value="broken" data-i18n="broken">Broken</option>
                        <option value="linear" data-i18n="linear">Linear</option>
                        <option value="step" data-i18n="step">Step</option>
                    </select>
                </label>
                <label class="animation-pose-field" title="Saved pose"><span>Pose</span><select class="animation-select" data-action="pose"><option value="">—</option></select></label>
                <button type="button" class="animation-icon-button" data-action="delete-pose" title="Delete saved pose">⌫</button>
                <span class="animation-selection-help">Shift adds · Ctrl/Cmd toggles · red track dot arms recording</span>
            </div>
            <div class="animation-status" hidden></div>
            <div class="animation-guide" hidden>
                <div class="animation-guide-progress" aria-hidden="true">
                    <i data-guide-dot="1"></i><i data-guide-dot="2"></i><i data-guide-dot="3"></i>
                </div>
                <span class="animation-guide-step">1</span>
                <div class="animation-guide-copy">
                    <strong></strong>
                    <span></span>
                </div>
                <div class="animation-guide-actions">
                    <button type="button" class="animation-button" data-action="guide-record"></button>
                    <button type="button" class="animation-button" data-action="guide-play">▶</button>
                    <button type="button" class="animation-button animation-primary-action" data-action="guide-next"></button>
                    <button type="button" class="animation-icon-button" data-action="dismiss-guide" title="Dismiss">×</button>
                </div>
            </div>
            <div class="animation-editor-body">
                <div class="animation-timeline-scroller"><canvas class="animation-timeline"></canvas></div>
                <div class="animation-graph-scroller" hidden><canvas class="animation-graph"></canvas></div>
                <div class="animation-video-preview-container"></div>
            </div>
            <div class="animation-dialog-backdrop" data-dialog="input" hidden>
                <div class="animation-dialog">
                    <div class="animation-dialog-header"><div><strong>Live Input</strong><span>Map gamepad axes or keyboard pairs, then record editable keys.</span></div><button type="button" class="animation-icon-button" data-action="close-input">×</button></div>
                    <div class="animation-input-status">No gamepad detected</div>
                    <div class="animation-input-mappings"></div>
                    <div class="animation-dialog-footer"><button type="button" class="animation-button" data-action="clear-input">Clear</button><button type="button" class="animation-button animation-primary-action" data-action="auto-input">Auto map axes</button></div>
                </div>
            </div>
            <div class="animation-dialog-backdrop" data-dialog="audio-reactive" hidden>
                <div class="animation-dialog animation-audio-dialog">
                    <div class="animation-dialog-header"><div><strong>Audio Reactive Keys</strong><span>Convert an imported waveform into editable joint keyframes.</span></div><button type="button" class="animation-icon-button" data-action="close-audio-reactive">×</button></div>
                    <div class="animation-dialog-fields">
                        <label><span>Audio source</span><select class="animation-select" data-audio-source></select></label>
                        <label><span>Target track</span><select class="animation-select" data-audio-target></select></label>
                        <div class="animation-dialog-field-grid">
                            <label><span>Minimum</span><input type="number" step="0.01" data-audio-min></label>
                            <label><span>Maximum</span><input type="number" step="0.01" data-audio-max></label>
                            <label><span>Keys / second</span><input type="number" min="1" max="30" step="1" value="10" data-audio-rate></label>
                            <label><span>Smoothing</span><input type="range" min="0" max="0.9" step="0.05" value="0.25" data-audio-smoothing></label>
                        </div>
                        <label class="animation-dialog-check"><input type="checkbox" data-audio-replace checked><span>Replace existing keys in the generated range</span></label>
                    </div>
                    <div class="animation-dialog-footer"><span class="animation-dialog-note">The generated keys remain fully editable in Dope Sheet and Graph.</span><button type="button" class="animation-button animation-primary-action" data-action="generate-audio-reactive">Generate keys</button></div>
                </div>
            </div>
            <div class="animation-hint"><span data-i18n="animationHint">Double-click a track to add a keyframe.</span><span class="animation-shortcuts">Space Play · J/K Keys · ←/→ Frames · Ctrl/Cmd C/V · Delete · Ctrl/Cmd Z</span></div>
            <div class="animation-toast" role="status" aria-live="polite" hidden></div>
        `;
        document.body.appendChild(this.root);

        this.timelineCanvas = this.root.querySelector('.animation-timeline');
        this.timelineScroller = this.root.querySelector('.animation-timeline-scroller');
        this.graphCanvas = this.root.querySelector('.animation-graph');
        this.graphScroller = this.root.querySelector('.animation-graph-scroller');
        this.status = this.root.querySelector('.animation-status');
        this.selectionLabel = this.root.querySelector('.animation-selection');
        this.clipSelect = this.root.querySelector('[data-action="clip"]');
        this.playButton = this.root.querySelector('[data-action="play"]');
        this.recordButton = this.root.querySelector('[data-action="record"]');
        this.timeInput = this.root.querySelector('[data-action="time"]');
        this.durationInput = this.root.querySelector('[data-action="duration"]');
        this.loopInput = this.root.querySelector('[data-action="loop"]');
        this.snapInput = this.root.querySelector('[data-action="snap"]');
        this.zoomInput = this.root.querySelector('[data-action="zoom"]');
        this.keyTimeInput = this.root.querySelector('[data-action="key-time"]');
        this.keyValueInput = this.root.querySelector('[data-action="key-value"]');
        this.keyBooleanInput = this.root.querySelector('[data-action="key-boolean"]');
        this.keyColorInput = this.root.querySelector('[data-action="key-color"]');
        this.interpolationSelect = this.root.querySelector('[data-action="interpolation"]');
        this.poseSelect = this.root.querySelector('[data-action="pose"]');
        this.propertiesToolbar = this.root.querySelector('.animation-toolbar-properties');
        this.guide = this.root.querySelector('.animation-guide');
        this.guideStep = this.root.querySelector('.animation-guide-step');
        this.guideTitle = this.root.querySelector('.animation-guide-copy strong');
        this.guideText = this.root.querySelector('.animation-guide-copy span');
        this.guideRecordButton = this.root.querySelector('[data-action="guide-record"]');
        this.guideNextButton = this.root.querySelector('[data-action="guide-next"]');
        this.guidePlayButton = this.root.querySelector('[data-action="guide-play"]');
        this.toast = this.root.querySelector('.animation-toast');
        this.fileInput = this.root.querySelector('[data-action="file"]');
        this.mediaFileInput = document.createElement('input');
        this.mediaFileInput.type = 'file';
        this.mediaFileInput.accept = 'audio/*,video/*';
        this.mediaFileInput.hidden = true;
        this.root.appendChild(this.mediaFileInput);
        this.videoPreviewContainer = this.root.querySelector('.animation-video-preview-container');
        this.inputDialog = this.root.querySelector('[data-dialog="input"]');
        this.inputStatus = this.root.querySelector('.animation-input-status');
        this.inputMappings = this.root.querySelector('.animation-input-mappings');
        this.audioReactiveDialog = this.root.querySelector('[data-dialog="audio-reactive"]');
        this.audioSourceSelect = this.root.querySelector('[data-audio-source]');
        this.audioTargetSelect = this.root.querySelector('[data-audio-target]');
        this.audioMinimumInput = this.root.querySelector('[data-audio-min]');
        this.audioMaximumInput = this.root.querySelector('[data-audio-max]');
        this.audioRateInput = this.root.querySelector('[data-audio-rate]');
        this.audioSmoothingInput = this.root.querySelector('[data-audio-smoothing]');
        this.audioReplaceInput = this.root.querySelector('[data-audio-replace]');
        this.saveStatus = this.root.querySelector('.animation-save-status');
        window.i18n?.updatePageLanguage();
    }

    bindEvents() {
        this.toggleButton = document.getElementById('toggle-animation-panel');
        this.toggleButton?.addEventListener('click', () => this.toggle());
        this.onAction('close', () => this.close());
        this.onAction('play', () => this.playback.toggle());
        this.onAction('stop', () => this.playback.stop());
        this.onAction('record', () => this.toggleRecording());
        this.onAction('undo', () => this.store.undo());
        this.onAction('redo', () => this.store.redo());
        this.onAction('new-clip', () => this.createClip());
        this.onAction('duplicate-clip', () => this.duplicateClip());
        this.onAction('rename-clip', () => this.renameClip());
        this.onAction('delete-clip', () => this.deleteClip());
        this.onAction('show-timeline', () => this.setViewMode('timeline'));
        this.onAction('show-graph', () => this.setViewMode('graph'));
        this.onAction('previous-key', () => this.jumpKeyframe(-1));
        this.onAction('next-key', () => this.jumpKeyframe(1));
        this.onAction('previous-frame', () => this.stepFrame(-1));
        this.onAction('next-frame', () => this.stepFrame(1));
        this.onAction('add-key', () => this.addKeyframes());
        this.onAction('key-current-pose', () => this.keyCurrentPose());
        this.onAction('key-current-pose-next', () => this.keyCurrentPose({ advanceMs: 1000 }));
        this.onAction('add-media', () => this.mediaFileInput.click());
        this.onAction('delete-key', () => this.deleteSelection());
        this.onAction('copy', () => this.copySelection());
        this.onAction('paste', () => this.pasteSelection());
        this.onAction('marker', () => this.addMarker());
        this.onAction('capture-pose', () => this.capturePose());
        this.onAction('key-pose', () => this.keySavedPose());
        this.onAction('audio-reactive', () => this.openAudioReactive());
        this.onAction('delete-pose', () => this.deleteSavedPose());
        this.onAction('fit-time', () => this.fitTime());
        this.onAction('fit-value', () => this.graph.fitValues());
        this.onAction('export', () => this.exportAnimation());
        this.onAction('import', () => this.fileInput.click());
        this.onAction('input-map', () => this.openInputMappings());
        this.onAction('guide', () => {
            this.guideVisible = true;
            this.updateGuide();
        });
        this.onAction('dismiss-guide', () => {
            this.guideVisible = false;
            this.updateGuide();
        });
        this.onAction('guide-record', () => this.keyCurrentPose());
        this.onAction('guide-next', () => this.handleGuideNext());
        this.onAction('guide-play', () => this.playback.toggle());
        this.onAction('close-input', () => { this.inputDialog.hidden = true; });
        this.onAction('auto-input', () => this.autoMapGamepad());
        this.onAction('clear-input', () => this.clearInputMappings());
        this.onAction('close-audio-reactive', () => { this.audioReactiveDialog.hidden = true; });
        this.onAction('generate-audio-reactive', () => this.generateAudioReactive());
        this.onAction('lock-graph', () => this.toggleGraphSelectionLock());

        this.clipSelect.addEventListener('change', () => this.selectClip(this.clipSelect.value));
        this.root.querySelector('[data-action="auto-key"]').addEventListener('change', (event) => {
            this.autoKey = event.target.checked;
            this.showToast(window.i18n?.t(this.autoKey ? 'animationAutoKeyOn' : 'animationAutoKeyOff'));
            this.updateGuide();
        });
        this.timeInput.addEventListener('change', () => this.playback.seek(this.parseTime(this.timeInput.value)));
        this.durationInput.addEventListener('change', () => this.store.setDuration(this.parseTime(this.durationInput.value)));
        this.loopInput.addEventListener('change', () => this.store.setLoop(this.loopInput.checked));
        this.snapInput.addEventListener('change', () => this.store.setSnapToFrames(this.snapInput.checked));
        this.zoomInput.addEventListener('input', () => {
            const zoom = this.sliderToZoom(Number(this.zoomInput.value));
            this.timeline.setZoom(zoom);
            this.graph.setZoom(zoom);
        });
        this.keyTimeInput.addEventListener('change', () => this.updateSelectedKeyTime());
        this.keyValueInput.addEventListener('change', () => this.updateSelectedKeyValue());
        this.keyBooleanInput.addEventListener('change', () => this.updateSelectedEventValue(this.keyBooleanInput.checked));
        this.keyColorInput.addEventListener('input', () => this.updateSelectedEventValue(this.keyColorInput.value));
        this.interpolationSelect.addEventListener('change', () => this.setInterpolation(this.interpolationSelect.value));
        this.poseSelect.addEventListener('change', () => this.previewSavedPose());
        this.fileInput.addEventListener('change', (event) => this.importAnimation(event.target.files?.[0]));
        this.mediaFileInput.addEventListener('change', (event) => this.importMedia(event.target.files?.[0]));
        this.root.querySelectorAll('[data-axis]').forEach((button) => {
            button.addEventListener('click', () => this.setGraphAxisLock(button.dataset.axis));
        });
        this.root.querySelectorAll('[data-menu-toggle]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const menu = this.root.querySelector(`[data-menu="${button.dataset.menuToggle}"]`);
                const willOpen = menu?.hidden;
                this.closeMenus();
                if (menu && willOpen) menu.hidden = false;
            });
        });
        this.root.querySelectorAll('[data-event-kind]').forEach((button) => {
            button.addEventListener('click', () => {
                this.createEventTrack(button.dataset.eventKind);
                this.closeMenus();
            });
        });
        this.root.querySelectorAll('.animation-dialog-backdrop').forEach((backdrop) => {
            backdrop.addEventListener('pointerdown', (event) => {
                if (event.target === backdrop) backdrop.hidden = true;
            });
        });
        this.root.addEventListener('click', (event) => {
            if (event.target.closest('[data-action]') && !event.target.closest('[data-menu-toggle]')) this.closeMenus();
        });
        document.addEventListener('pointerdown', (event) => {
            if (!this.root.contains(event.target)) this.closeMenus();
        });
        this.bindResize();
        window.addEventListener('keydown', (event) => this.handleKeyboard(event));
        window.addEventListener('keydown', (event) => {
            if (!this.visible || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
            this.pressedInputKeys.add(event.key.toLowerCase());
        });
        window.addEventListener('keyup', (event) => this.pressedInputKeys.delete(event.key.toLowerCase()));
        window.addEventListener('blur', () => this.pressedInputKeys.clear());
    }

    onAction(action, callback) {
        this.root.querySelector(`[data-action="${action}"]`)?.addEventListener('click', callback);
    }

    closeMenus() {
        this.root.querySelectorAll('.animation-popover').forEach((menu) => { menu.hidden = true; });
    }

    openInputMappings() {
        this.renderInputMappings();
        this.inputDialog.hidden = false;
    }

    renderInputMappings() {
        const mappings = new Map((this.store.project.inputMappings || []).map((mapping) => [mapping.trackId, mapping]));
        const tracks = this.store.activeClip.tracks.filter((track) => track.type === 'joint');
        this.inputMappings.innerHTML = '';
        tracks.forEach((track) => {
            const mapping = mappings.get(track.id);
            const mappingValue = Array.isArray(mapping?.keys)
                ? `keys:${mapping.keys.join(',')}`
                : Number.isInteger(mapping?.axis) ? String(mapping.axis) : '';
            const row = document.createElement('div');
            row.className = 'animation-input-row';
            row.innerHTML = `
                <span class="animation-input-track"><i></i><span data-input-track-name></span></span>
                <select class="animation-select" data-input-axis>
                    <option value="">Unmapped</option>
                    ${Array.from({ length: 8 }, (_, index) => `<option value="${index}">Axis ${index + 1}</option>`).join('')}
                    <option value="keys:a,d">Keys A / D</option>
                    <option value="keys:w,s">Keys W / S</option>
                    <option value="keys:arrowleft,arrowright">Keys ← / →</option>
                    <option value="keys:arrowdown,arrowup">Keys ↓ / ↑</option>
                </select>
                <label><input type="checkbox" data-input-invert ${mapping?.invert ? 'checked' : ''}> Invert</label>
                <label>Smooth <input type="range" data-input-smoothing min="0" max="0.95" step="0.05" value="${mapping?.smoothing ?? 0.15}"></label>
            `;
            row.querySelector('[data-input-track-name]').textContent = track.name;
            row.querySelector('.animation-input-track i').style.background = /^#[0-9a-f]{6}$/i.test(track.color)
                ? track.color : '#0a84ff';
            const sourceSelect = row.querySelector('[data-input-axis]');
            sourceSelect.value = mappingValue;
            sourceSelect.addEventListener('change', (event) => {
                if (!event.target.value) this.setInputMapping(track.id, { remove: true });
                else if (event.target.value.startsWith('keys:')) {
                    this.setInputMapping(track.id, { keys: event.target.value.slice(5).split(',') });
                } else {
                    this.setInputMapping(track.id, { axis: Number(event.target.value) });
                }
                this.renderInputMappings();
            });
            const invertInput = row.querySelector('[data-input-invert]');
            const smoothingInput = row.querySelector('[data-input-smoothing]');
            invertInput.disabled = !mapping;
            smoothingInput.disabled = !mapping;
            invertInput.addEventListener('change', (event) => {
                this.setInputMapping(track.id, { invert: event.target.checked });
            });
            smoothingInput.addEventListener('input', (event) => {
                this.setInputMapping(track.id, { smoothing: Number(event.target.value) });
            });
            this.inputMappings.appendChild(row);
        });
        if (!tracks.length) this.inputMappings.innerHTML = '<div class="animation-dialog-empty">Load a robot with movable joints first.</div>';
    }

    openAudioReactive() {
        const audioTracks = this.store.activeClip.tracks.filter((track) => {
            const asset = this.store.project.mediaAssets?.find((item) => item.id === track.assetId);
            return track.type === 'media' && asset?.kind === 'audio' && asset.waveform?.length;
        });
        const targetTracks = this.store.activeClip.tracks.filter((track) => track.type === 'joint' && !track.locked);
        if (!audioTracks.length || !targetTracks.length) {
            window.alert('Import an audio file and select a movable joint track first.');
            return;
        }
        const selectedTrackId = [...this.selection.trackIds]
            .find((trackId) => targetTracks.some((track) => track.id === trackId));
        const fillSelect = (select, items, selectedId) => {
            select.innerHTML = '';
            items.forEach((item) => {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = item.name;
                option.selected = item.id === selectedId;
                select.appendChild(option);
            });
        };
        fillSelect(this.audioSourceSelect, audioTracks, audioTracks[0].id);
        fillSelect(this.audioTargetSelect, targetTracks, selectedTrackId || targetTracks[0].id);
        const syncRange = () => {
            const target = this.store.getTrackById(this.audioTargetSelect.value);
            const lower = Number.isFinite(target?.valueRange?.lower) ? target.valueRange.lower : -1;
            const upper = Number.isFinite(target?.valueRange?.upper) ? target.valueRange.upper : 1;
            this.audioMinimumInput.value = String(Number(lower.toFixed(4)));
            this.audioMaximumInput.value = String(Number(upper.toFixed(4)));
        };
        this.audioTargetSelect.onchange = syncRange;
        syncRange();
        this.audioReactiveDialog.hidden = false;
    }

    generateAudioReactive() {
        const mediaTrack = this.store.getTrackById(this.audioSourceSelect.value);
        const targetTrack = this.store.getTrackById(this.audioTargetSelect.value);
        const asset = this.store.project.mediaAssets?.find((item) => item.id === mediaTrack?.assetId);
        if (!mediaTrack || !targetTrack || !asset?.waveform?.length) return;
        const minimum = Number(this.audioMinimumInput.value);
        const maximum = Number(this.audioMaximumInput.value);
        const rate = Math.max(1, Math.min(30, Number(this.audioRateInput.value) || 10));
        const smoothing = Math.max(0, Math.min(0.9, Number(this.audioSmoothingInput.value) || 0));
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return;

        const restart = [...mediaTrack.keyframes].sort((left, right) => (
            Math.abs(left.timeMs - this.playback.currentTimeMs) - Math.abs(right.timeMs - this.playback.currentTimeMs)
        ))[0];
        const startMs = restart?.timeMs || 0;
        const endMs = Math.min(this.store.activeClip.durationMs, startMs + asset.durationMs);
        const sampleCount = Math.max(2, Math.min(7200, Math.ceil((endMs - startMs) / 1000 * rate) + 1));
        let smoothed = asset.waveform[0] || 0;
        const samples = Array.from({ length: sampleCount }, (_, index) => {
            const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1);
            const waveformIndex = progress * (asset.waveform.length - 1);
            const lowIndex = Math.floor(waveformIndex);
            const highIndex = Math.min(asset.waveform.length - 1, lowIndex + 1);
            const fraction = waveformIndex - lowIndex;
            const amplitude = asset.waveform[lowIndex] * (1 - fraction) + asset.waveform[highIndex] * fraction;
            smoothed = smoothing * smoothed + (1 - smoothing) * amplitude;
            return {
                timeMs: startMs + progress * Math.max(0, endMs - startMs),
                value: minimum + (maximum - minimum) * Math.max(0, Math.min(1, smoothed))
            };
        });
        const refs = this.store.generateTrackKeyframes(targetTrack.id, samples, {
            startMs,
            endMs,
            replace: this.audioReplaceInput.checked
        });
        if (refs.length) {
            this.selection.selectKeyframes(refs);
            this.playback.seek(startMs);
        }
        this.audioReactiveDialog.hidden = true;
    }

    setInputMapping(trackId, changes) {
        this.store.mutate('Change live input mapping', 'inputMappingsChanged', () => {
            this.store.project.inputMappings ||= [];
            const index = this.store.project.inputMappings.findIndex((mapping) => mapping.trackId === trackId);
            if (changes.remove) {
                if (index >= 0) this.store.project.inputMappings.splice(index, 1);
                return;
            }
            const mapping = index >= 0 ? this.store.project.inputMappings[index] : {
                trackId, axis: 0, invert: false, smoothing: 0.15
            };
            Object.assign(mapping, changes);
            if (Object.prototype.hasOwnProperty.call(changes, 'axis')) delete mapping.keys;
            if (Object.prototype.hasOwnProperty.call(changes, 'keys')) mapping.axis = null;
            delete mapping.remove;
            if (index < 0) this.store.project.inputMappings.push(mapping);
            const track = this.store.getTrackById(trackId);
            if (track) track.recordArmed = true;
        });
    }

    autoMapGamepad() {
        const gamepad = [...(navigator.getGamepads?.() || [])].find(Boolean);
        const axisCount = Math.max(1, gamepad?.axes?.length || 4);
        const selected = [...this.selection.trackIds]
            .map((trackId) => this.store.getTrackById(trackId))
            .filter((track) => track?.type === 'joint');
        const tracks = selected.length ? selected : this.store.activeClip.tracks.filter((track) => track.type === 'joint');
        this.store.mutate('Auto-map gamepad', 'inputMappingsChanged', () => {
            this.store.project.inputMappings = tracks.map((track, index) => ({
                trackId: track.id,
                axis: index % axisCount,
                invert: false,
                smoothing: 0.15
            }));
            tracks.forEach((track) => { track.recordArmed = true; });
        });
        this.renderInputMappings();
    }

    clearInputMappings() {
        this.store.mutate('Clear live input mappings', 'inputMappingsChanged', () => {
            this.store.project.inputMappings = [];
        });
        this.renderInputMappings();
    }

    pollGamepads() {
        const gamepad = [...(navigator.getGamepads?.() || [])].find(Boolean);
        if (this.inputStatus) {
            this.inputStatus.textContent = gamepad
                ? `${gamepad.id} · ${gamepad.axes.length} axes · ${gamepad.buttons.length} buttons`
                : 'Keyboard ready · no gamepad detected';
            this.inputStatus.classList.toggle('connected', Boolean(gamepad));
        }
        if (this.visible && this.model) {
            let changed = false;
            (this.store.project.inputMappings || []).forEach((mapping) => {
                const track = this.store.getTrackById(mapping.trackId);
                const rawAxis = Array.isArray(mapping.keys)
                    ? (this.pressedInputKeys.has(mapping.keys[1]) ? 1 : 0)
                        - (this.pressedInputKeys.has(mapping.keys[0]) ? 1 : 0)
                    : gamepad?.axes?.[mapping.axis];
                if (!track || track.type !== 'joint' || track.muted || !Number.isFinite(rawAxis)) return;
                let normalized = Math.abs(rawAxis) < 0.06 ? 0 : rawAxis;
                if (mapping.invert) normalized *= -1;
                const lower = Number.isFinite(track.valueRange?.lower) ? track.valueRange.lower : -Math.PI;
                const upper = Number.isFinite(track.valueRange?.upper) ? track.valueRange.upper : Math.PI;
                const target = lower + (normalized + 1) / 2 * (upper - lower);
                const previous = this.gamepadValues.get(track.id) ?? target;
                const alpha = Math.max(0.05, 1 - (mapping.smoothing ?? 0.15));
                const value = previous + (target - previous) * alpha;
                this.gamepadValues.set(track.id, value);
                this.poseController.setJointValue(track.jointName, value, {
                    source: 'user', commit: false, render: false, measure: false
                });
                changed = true;
            });
            if (changed) {
                this.poseController.sceneManager?.redraw();
                this.poseController.sceneManager?.onMeasurementUpdate?.();
            }
        }
        this.gamepadFrame = requestAnimationFrame(() => this.pollGamepads());
    }

    bindResize() {
        const handle = this.root.querySelector('[data-action="resize"]');
        handle.addEventListener('pointerdown', (event) => {
            const startY = event.clientY;
            const startHeight = this.root.getBoundingClientRect().height;
            handle.setPointerCapture(event.pointerId);
            const move = (moveEvent) => {
                const height = Math.max(260, Math.min(window.innerHeight - 70, startHeight + startY - moveEvent.clientY));
                this.root.style.height = `${height}px`;
                this.updateDockingInsets();
                this.timeline.draw();
                this.graph.draw();
            };
            const up = () => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
    }

    setupDockingAvoidance() {
        this.dockingFrame = null;
        this.sidePanels = [...document.querySelectorAll('.floating-panel')]
            .filter((panel) => panel !== this.root);
        this.scheduleDockingUpdate = () => {
            cancelAnimationFrame(this.dockingFrame);
            this.dockingFrame = requestAnimationFrame(() => this.updateDockingInsets());
        };
        this.panelResizeObserver = new ResizeObserver(this.scheduleDockingUpdate);
        this.sidePanels.forEach((panel) => this.panelResizeObserver.observe(panel));
        this.panelMutationObserver = new MutationObserver(this.scheduleDockingUpdate);
        this.sidePanels.forEach((panel) => {
            this.panelMutationObserver.observe(panel, {
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden']
            });
        });
        window.addEventListener('resize', this.scheduleDockingUpdate);
    }

    updateDockingInsets() {
        const baseGap = window.innerWidth <= 900 ? 6 : 14;
        if (!this.visible || window.innerWidth <= 900) {
            this.root.style.left = `${baseGap}px`;
            this.root.style.right = `${baseGap}px`;
            return;
        }

        const workspaceRect = this.root.getBoundingClientRect();
        const viewportMiddle = window.innerWidth / 2;
        let left = baseGap;
        let right = baseGap;

        this.sidePanels.forEach((panel) => {
            const styles = getComputedStyle(panel);
            if (styles.display === 'none' || styles.visibility === 'hidden') return;
            const rect = panel.getBoundingClientRect();
            const overlapsVertically = rect.bottom > workspaceRect.top && rect.top < workspaceRect.bottom;
            if (!overlapsVertically || rect.width <= 0 || rect.height <= 0) return;

            const center = rect.left + rect.width / 2;
            if (center < viewportMiddle && rect.right < window.innerWidth * 0.72) {
                left = Math.max(left, rect.right + baseGap);
            } else if (center >= viewportMiddle && rect.left > window.innerWidth * 0.28) {
                right = Math.max(right, window.innerWidth - rect.left + baseGap);
            }
        });

        const minimumWidth = 360;
        if (window.innerWidth - left - right < minimumWidth) {
            const availableInset = Math.max(0, window.innerWidth - minimumWidth - baseGap * 2);
            const leftExtra = Math.max(0, left - baseGap);
            const rightExtra = Math.max(0, right - baseGap);
            const extraTotal = leftExtra + rightExtra || 1;
            left = baseGap + availableInset * leftExtra / extraTotal;
            right = baseGap + availableInset * rightExtra / extraTotal;
        }

        this.root.style.left = `${Math.round(left)}px`;
        this.root.style.right = `${Math.round(right)}px`;
        this.timeline.draw();
        this.graph.draw();
    }

    setModel(model, modelName = 'Robot') {
        this.playback.stop();
        this.model = model?.joints ? model : null;
        this.modelName = modelName || 'Robot';
        this.poseController.setModel(this.model);
        this.suspendAutosave = true;
        this.store.setModel(this.model, this.modelName);
        if (this.model) this.restoreAutosave();
        this.suspendAutosave = false;
        this.selection.clear();
        const firstTrack = this.store.activeClip?.tracks[0];
        if (firstTrack) this.selection.selectTrack(firstTrack.id);
        this.status.hidden = true;
        this.root.querySelector('.animation-editor-body').hidden = false;
        if (this.toggleButton) {
            this.toggleButton.title = this.translate('animationEditor');
        }
        this.guideVisible = Boolean(this.model && firstTrack && this.getJointKeyTimes().length < 2);
        this.syncAllControls();
        requestAnimationFrame(() => this.fitTime());
    }

    storageKey() {
        return `robot-viewer-animation:${this.modelName}`;
    }

    restoreAutosave() {
        try {
            const saved = localStorage.getItem(this.storageKey());
            if (saved) {
                this.store.load(saved);
                this.reconcileModelTracks();
            }
        } catch (error) {
            console.warn('Animation autosave could not be restored:', error);
        }
    }

    reconcileModelTracks() {
        const jointNames = [];
        this.model?.joints?.forEach((joint, name) => {
            if (joint.type !== 'fixed') jointNames.push(name);
        });
        this.store.project.robot.jointNames = jointNames;
        this.store.project.robot.joints = {};
        this.model?.joints?.forEach((joint, name) => {
            if (joint.type === 'fixed') return;
            this.store.project.robot.joints[name] = {
                lower: Number.isFinite(joint.limits?.lower) ? joint.limits.lower : -Math.PI,
                upper: Number.isFinite(joint.limits?.upper) ? joint.limits.upper : Math.PI,
                velocity: Number.isFinite(joint.limits?.velocity) ? joint.limits.velocity : null
            };
        });
        this.store.project.clips.forEach((clip) => {
            jointNames.forEach((jointName, index) => {
                if (!clip.tracks.some((track) => track.jointName === jointName)) {
                    clip.tracks.push(this.store.createTrack(jointName, index));
                }
                const track = clip.tracks.find((item) => item.type === 'joint' && item.jointName === jointName);
                track.valueRange = { ...this.store.project.robot.joints[jointName] };
            });
        });
    }

    scheduleAutosave() {
        if (this.suspendAutosave || !this.model) return;
        this.saveStatus.textContent = window.i18n?.t('unsaved') || 'Unsaved';
        clearTimeout(this.autosaveTimer);
        this.autosaveTimer = setTimeout(() => {
            try {
                localStorage.setItem(this.storageKey(), this.store.serialize());
                this.saveStatus.textContent = window.i18n?.t('saved') || 'Saved';
            } catch (error) {
                this.saveStatus.textContent = 'Save failed';
                console.warn('Animation autosave failed:', error);
            }
        }, 300);
    }

    open() {
        this.visible = true;
        this.root.hidden = false;
        document.body.classList.add('animation-editor-open');
        this.toggleButton?.classList.add('active');
        this.updateGuide();
        requestAnimationFrame(() => {
            this.updateDockingInsets();
            this.timeline.draw();
            this.graph.draw();
        });
    }

    close() {
        this.visible = false;
        this.stopRecording();
        this.playback.pause();
        this.root.hidden = true;
        this.inputDialog.hidden = true;
        this.audioReactiveDialog.hidden = true;
        document.body.classList.remove('animation-editor-open');
        this.toggleButton?.classList.remove('active');
    }

    toggle() {
        if (this.visible) this.close();
        else this.open();
    }

    refreshTheme() {
        this.timeline.draw();
        this.graph.draw();
    }

    refreshLanguage() {
        window.i18n?.updatePageLanguage();
        this.syncAllControls();
    }

    translate(key, replacements = {}) {
        let text = window.i18n?.t(key) || key;
        Object.entries(replacements).forEach(([name, value]) => {
            text = text.replaceAll(`{${name}}`, String(value));
        });
        return text;
    }

    getJointKeyTimes() {
        const times = new Set();
        this.store.activeClip?.tracks.forEach((track) => {
            if (track.type !== 'joint') return;
            track.keyframes.forEach((keyframe) => times.add(keyframe.timeMs));
        });
        return [...times].sort((a, b) => a - b);
    }

    showToast(message) {
        if (!message || !this.toast) return;
        clearTimeout(this.toastTimer);
        clearTimeout(this.toastFinalizeTimer);
        this.toast.textContent = message;
        this.toast.hidden = false;
        requestAnimationFrame(() => this.toast.classList.add('visible'));
        this.toastTimer = setTimeout(() => {
            this.toast.classList.remove('visible');
            this.toastFinalizeTimer = setTimeout(() => { this.toast.hidden = true; }, 180);
        }, 1800);
    }

    keyCurrentPose({ advanceMs = 0 } = {}) {
        if (!this.model) return [];
        const clip = this.store.activeClip;
        const pose = this.poseController.getPose();
        const timeMs = this.playback.currentTimeMs;
        const targetTime = timeMs + Math.max(0, advanceMs);
        this.playback.pause();

        if (targetTime > clip.durationMs) {
            this.store.setDuration(Math.ceil(targetTime / 5000) * 5000);
        }

        const created = [];
        this.store.beginTransaction('Key current pose');
        clip.tracks.forEach((track) => {
            if (track.type !== 'joint' || track.locked || !Number.isFinite(pose[track.jointName])) return;
            const keyframe = this.store.upsertKeyframe(track.jointName, timeMs, pose[track.jointName]);
            if (keyframe) created.push({ trackId: track.id, keyframeId: keyframe.id });
        });
        this.store.endTransaction();

        if (advanceMs > 0) {
            this.selection.clear();
            this.playback.seek(targetTime);
            this.timeline.scrollToTime(targetTime);
            this.showToast(this.translate('animationPoseRecordedNext', {
                count: created.length,
                time: this.formatTime(targetTime)
            }));
        } else {
            if (created.length && !this.guideVisible) this.selection.selectKeyframes(created);
            else this.selection.clear();
            this.showToast(this.translate('animationPoseRecorded', {
                count: created.length,
                time: this.formatTime(timeMs)
            }));
        }
        this.updateGuide();
        return created;
    }

    handleGuideNext() {
        if (!this.model) return;
        if (this.getJointKeyTimes().length === 0) {
            this.playback.seek(0);
        }
        this.keyCurrentPose({ advanceMs: 1000 });
    }

    updateGuide() {
        if (!this.guide) return;
        const hasJointTracks = Boolean(this.model
            && this.store.activeClip?.tracks.some((track) => track.type === 'joint'));
        this.guide.hidden = !hasJointTracks || !this.guideVisible;
        this.root.querySelector('[data-action="guide"]')?.classList.toggle('active', hasJointTracks && this.guideVisible);
        if (!hasJointTracks || !this.guideVisible) return;

        const keyTimes = this.getJointKeyTimes();
        const stage = keyTimes.length === 0 ? 1 : keyTimes.length === 1 ? 2 : 3;
        this.guideStep.textContent = String(stage);
        this.root.querySelectorAll('[data-guide-dot]').forEach((dot) => {
            const dotStage = Number(dot.dataset.guideDot);
            dot.classList.toggle('active', dotStage === stage);
            dot.classList.toggle('done', dotStage < stage);
        });

        this.guideRecordButton.hidden = stage === 1;
        this.guidePlayButton.hidden = stage < 3;
        this.guidePlayButton.textContent = this.playback.playing
            ? '❚❚' : `▶ ${this.translate('animationGuidePlay')}`;
        this.guideRecordButton.textContent = this.translate('animationGuideRecord');

        if (stage === 1) {
            this.guideTitle.textContent = this.translate('animationGuideStartTitle');
            this.guideText.textContent = this.translate('animationGuideStartText');
            this.guideNextButton.textContent = this.translate('animationGuideStartButton');
        } else if (stage === 2) {
            this.guideTitle.textContent = this.translate('animationGuideAdjustTitle');
            this.guideText.textContent = this.translate('animationGuideAdjustText', {
                time: this.formatTime(this.playback.currentTimeMs)
            });
            this.guideNextButton.textContent = this.translate('animationGuideNext');
        } else {
            this.guideTitle.textContent = this.translate('animationGuideContinueTitle');
            this.guideText.textContent = this.translate('animationGuideContinueText', {
                count: keyTimes.length,
                time: this.formatTime(this.playback.currentTimeMs)
            });
            this.guideNextButton.textContent = this.translate('animationGuideNext');
        }
    }

    setViewMode(mode) {
        const outgoingScroller = this.viewMode === 'graph' ? this.graphScroller : this.timelineScroller;
        const scrollLeft = outgoingScroller.scrollLeft;
        this.viewMode = mode === 'graph' ? 'graph' : 'timeline';
        const graphMode = this.viewMode === 'graph';
        this.timelineScroller.hidden = graphMode;
        this.graphScroller.hidden = !graphMode;
        this.root.classList.toggle('graph-mode', graphMode);
        this.root.querySelector('[data-action="show-timeline"]').classList.toggle('active', !graphMode);
        this.root.querySelector('[data-action="show-graph"]').classList.toggle('active', graphMode);
        const zoom = this.sliderToZoom(Number(this.zoomInput.value));
        this.timeline.setZoom(zoom);
        this.graph.setZoom(zoom);
        if (graphMode) {
            this.graphScroller.scrollLeft = scrollLeft;
            this.graph.fitValues();
            this.graph.draw();
        } else {
            this.timelineScroller.scrollLeft = scrollLeft;
            this.timeline.draw();
        }
    }

    handlePoseEvent(event) {
        if (event.type !== 'jointChanged' || event.source === 'playback') return;
        const track = this.store.getTrack(event.jointName);
        if (track) this.selection.selectTrack(track.id);

        if (this.recording && this.recordingTrackIds.has(track?.id)
            && this.playback.currentTimeMs >= this.recordingRange.startMs
            && this.playback.currentTimeMs <= this.recordingRange.endMs
            && ['user', 'viewport'].includes(event.source)) {
            this.store.upsertKeyframe(event.jointName, this.playback.currentTimeMs, event.value);
            return;
        }

        if (this.visible && this.autoKey && event.commit && ['user', 'viewport'].includes(event.source)) {
            const keyframe = this.store.upsertKeyframe(event.jointName, this.playback.currentTimeMs, event.value);
            if (keyframe && track) {
                if (!this.guideVisible) {
                    this.selection.selectKeyframe({ trackId: track.id, keyframeId: keyframe.id });
                }
                this.showToast(this.translate('animationAutoKeyed', {
                    joint: track.name,
                    time: this.formatTime(keyframe.timeMs)
                }));
                this.updateGuide();
            }
        }
    }

    handleStoreEvent(event) {
        this.scheduleAutosave();
        if (event.type === 'clipCreated') this.guideVisible = true;
        if (['activeClipChanged', 'clipCreated', 'clipDeleted', 'historyRestored', 'projectLoaded'].includes(event.type)) {
            this.selection.clear();
            this.playback.pause();
            this.playback.seek(Math.min(this.playback.currentTimeMs, this.store.activeClip.durationMs));
        }
        this.syncAllControls();
    }

    syncAllControls() {
        this.syncClipControls();
        this.syncSelectionControls();
        this.syncPlaybackControls();
        this.root.querySelector('[data-action="undo"]').disabled = !this.store.canUndo;
        this.root.querySelector('[data-action="redo"]').disabled = !this.store.canRedo;
        const requiresModel = [
            'play', 'stop', 'record', 'previous-key', 'next-key', 'previous-frame', 'next-frame',
            'add-key', 'add-media', 'marker', 'capture-pose', 'key-pose', 'audio-reactive', 'input-map'
        ];
        requiresModel.forEach((action) => {
            const button = this.root.querySelector(`[data-action="${action}"]`);
            if (button) button.disabled = !this.model;
        });
        this.updateGuide();
    }

    syncClipControls() {
        const clip = this.store.activeClip;
        if (!clip) return;
        const selectedId = clip.id;
        this.clipSelect.innerHTML = '';
        this.store.project.clips.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.id;
            option.textContent = item.name;
            option.selected = item.id === selectedId;
            this.clipSelect.appendChild(option);
        });
        this.durationInput.value = this.formatTime(clip.durationMs);
        this.loopInput.checked = clip.loop;
        this.snapInput.checked = this.store.project.settings.snapToFrames;
        const selectedPoseId = this.poseSelect.value;
        this.poseSelect.innerHTML = '<option value="">—</option>';
        this.store.project.poseAssets?.forEach((pose) => {
            const option = document.createElement('option');
            option.value = pose.id;
            option.textContent = pose.name;
            option.selected = pose.id === selectedPoseId;
            this.poseSelect.appendChild(option);
        });
        if (this.playback.currentTimeMs > clip.durationMs) this.playback.seek(clip.durationMs);
    }

    syncPlaybackControls(state = {}) {
        const playing = state.playing ?? this.playback.playing;
        const currentTimeMs = state.currentTimeMs ?? this.playback.currentTimeMs;
        this.playButton.textContent = playing ? '❚❚' : '▶';
        this.timeInput.value = this.formatTime(currentTimeMs);
        if (this.guidePlayButton && !this.guidePlayButton.hidden) {
            this.guidePlayButton.textContent = playing
                ? '❚❚' : `▶ ${this.translate('animationGuidePlay')}`;
        }
        if (this.recording && currentTimeMs >= this.recordingRange.endMs - 0.5) {
            this.playback.pause();
            this.stopRecording();
            return;
        }
        if (this.recording && !playing) this.stopRecording();
    }

    syncSelectionControls() {
        const refs = this.selection.getKeyframeRefs();
        const items = refs.map((ref) => this.store.getKeyframe(ref)).filter(Boolean);
        const single = items.length === 1 ? items[0] : null;
        const singleNumeric = single && (single.track.type === 'joint'
            || (single.track.type === 'event' && single.track.eventKind === 'number')) ? single : null;
        const singleBoolean = single?.track.type === 'event' && single.track.eventKind === 'boolean' ? single : null;
        const singleColor = single?.track.type === 'event' && single.track.eventKind === 'color' ? single : null;
        const interpolated = (item) => item.track.type === 'joint'
            || (item.track.type === 'event' && item.track.eventKind === 'number');
        this.keyTimeInput.disabled = !single;
        this.keyValueInput.disabled = !singleNumeric;
        this.interpolationSelect.disabled = items.length === 0 || items.some((item) => !interpolated(item));
        this.keyTimeInput.value = single ? this.formatTime(single.keyframe.timeMs) : '';
        this.keyValueInput.value = singleNumeric ? String(Number(singleNumeric.keyframe.value.toFixed(5))) : '';
        this.root.querySelector('.animation-event-value').hidden = !singleBoolean;
        this.root.querySelector('.animation-event-color').hidden = !singleColor;
        if (singleBoolean) this.keyBooleanInput.checked = singleBoolean.keyframe.value;
        if (singleColor) this.keyColorInput.value = singleColor.keyframe.value;
        const interpolation = items[0]?.keyframe.interpolation;
        this.interpolationSelect.value = items.every((item) => item.keyframe.interpolation === interpolation)
            ? interpolation : '';

        if (items.length === 1) {
            this.selectionLabel.textContent = `${single.track.name} · ${this.formatTime(single.keyframe.timeMs)}`;
        } else if (items.length > 1) {
            this.selectionLabel.textContent = `${items.length} keys`;
        } else if (this.selection.trackIds.size) {
            const names = [...this.selection.trackIds]
                .map((trackId) => this.store.getTrackById(trackId)?.name)
                .filter(Boolean);
            this.selectionLabel.textContent = names.join(', ') || '—';
        } else if (this.selection.markerId) {
            const marker = this.store.activeClip.markers.find((item) => item.id === this.selection.markerId);
            this.selectionLabel.textContent = marker?.name || 'Marker';
        } else {
            this.selectionLabel.textContent = '—';
        }
        this.propertiesToolbar.hidden = items.length === 0
            && (this.store.project.poseAssets?.length || 0) === 0;
    }

    formatTime(timeMs) {
        const fps = this.store.activeClip?.fps || 30;
        const totalFrames = Math.round(Math.max(0, timeMs || 0) / 1000 * fps);
        const frames = totalFrames % fps;
        const totalSeconds = Math.floor(totalFrames / fps);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60);
        return minutes
            ? `${minutes}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
            : `${seconds}:${String(frames).padStart(2, '0')}`;
    }

    parseTime(value) {
        const fps = this.store.activeClip?.fps || 30;
        const parts = String(value).trim().split(':').map(Number);
        if (parts.some((part) => !Number.isFinite(part))) return this.playback.currentTimeMs;
        let minutes = 0;
        let seconds = 0;
        let frames = 0;
        if (parts.length >= 3) [minutes, seconds, frames] = parts.slice(-3);
        else if (parts.length === 2) [seconds, frames] = parts;
        else seconds = parts[0];
        return Math.max(0, (minutes * 60 + seconds + frames / fps) * 1000);
    }

    sliderToZoom(value) {
        return 0.05 * Math.pow(24000, Math.max(0, Math.min(100, value)) / 100);
    }

    zoomToSlider(zoom) {
        return Math.log(Math.max(0.05, zoom) / 0.05) / Math.log(24000) * 100;
    }

    syncZoomSlider(zoom) {
        this.zoomInput.value = String(this.zoomToSlider(zoom));
    }

    fitTime() {
        this.timeline.zoomToFit();
        this.graph.setZoom(this.timeline.pixelsPerSecond);
    }

    setGraphAxisLock(axis) {
        this.graph.axisLock = axis;
        this.root.querySelectorAll('[data-axis]').forEach((button) => {
            button.classList.toggle('active', button.dataset.axis === axis);
        });
    }

    toggleGraphSelectionLock() {
        const locked = this.graph.toggleSelectionLock();
        const button = this.root.querySelector('[data-action="lock-graph"]');
        button.classList.toggle('active', locked);
        button.title = locked ? 'Unlock displayed curves' : 'Lock displayed curves to the current selection';
    }

    createClip() {
        const name = window.prompt(window.i18n?.t('animationName') || 'Animation name', `Animation ${this.store.project.clips.length + 1}`);
        if (!name?.trim()) return;
        this.store.createAnimation(name.trim());
        this.playback.seek(0);
    }

    duplicateClip() {
        this.store.duplicateAnimation();
        this.playback.seek(this.store.activeClip.playRange.startMs);
    }

    renameClip() {
        const name = window.prompt(window.i18n?.t('animationName') || 'Animation name', this.store.activeClip.name);
        if (name?.trim()) this.store.renameAnimation(name.trim());
    }

    deleteClip() {
        if (this.store.project.clips.length <= 1) return;
        this.store.deleteAnimation();
        this.playback.seek(this.store.activeClip.playRange.startMs);
    }

    selectClip(clipId) {
        this.stopRecording();
        if (this.store.setActiveClip(clipId)) {
            this.guideVisible = this.getJointKeyTimes().length < 2;
            this.playback.seek(this.store.activeClip.playRange.startMs);
            const firstTrack = this.store.activeClip.tracks[0];
            if (firstTrack) this.selection.selectTrack(firstTrack.id);
            this.fitTime();
        }
    }

    addKeyframes() {
        let trackIds = [...this.selection.trackIds];
        if (!trackIds.length && this.store.activeClip.tracks[0]) trackIds = [this.store.activeClip.tracks[0].id];
        const created = [];
        this.store.beginTransaction('Add keyframes');
        trackIds.forEach((trackId) => {
            const track = this.store.getTrackById(trackId);
            if (!track || track.locked) return;
            const previousEventKey = [...track.keyframes].reverse()
                .find((keyframe) => keyframe.timeMs <= this.playback.currentTimeMs);
            const keyframe = track.type === 'media'
                ? this.store.addMediaKeyframe(track.id, this.playback.currentTimeMs)
                : track.type === 'event'
                    ? this.store.addEventKeyframe(
                        track.id,
                        this.playback.currentTimeMs,
                        track.eventKind === 'number' ? 0.5
                            : track.eventKind === 'color' ? track.color
                                : track.eventKind === 'boolean' ? !Boolean(previousEventKey?.value) : true
                    )
                    : this.store.upsertKeyframe(
                    track.jointName,
                    this.playback.currentTimeMs,
                    this.poseController.getJointValue(track.jointName)
                );
            if (keyframe) created.push({ trackId: track.id, keyframeId: keyframe.id });
        });
        this.store.endTransaction();
        if (created.length) this.selection.selectKeyframes(created);
    }

    deleteSelection() {
        if (this.selection.markerId) {
            this.store.removeMarker(this.selection.markerId);
            this.selection.clear();
            return;
        }
        let refs = this.selection.getKeyframeRefs();
        if (!refs.length && this.selection.trackIds.size) {
            if (this.store.removeTracks([...this.selection.trackIds])) this.selection.clear();
            return;
        }
        if (this.store.removeKeyframes(refs)) this.selection.clear();
    }

    copySelection() {
        this.clipboard = this.store.copyKeyframes(this.selection.getKeyframeRefs());
        if (!this.clipboard) return;
        navigator.clipboard?.writeText(JSON.stringify({ type: 'robotanim/keyframes', payload: this.clipboard })).catch(() => {});
    }

    async pasteSelection() {
        let payload = this.clipboard;
        if (!payload && navigator.clipboard?.readText) {
            try {
                const external = JSON.parse(await navigator.clipboard.readText());
                if (external.type === 'robotanim/keyframes') payload = external.payload;
            } catch (_) {
                // The internal clipboard remains the reliable fallback.
            }
        }
        if (!payload) return;
        const created = this.store.pasteKeyframes(
            payload,
            this.playback.currentTimeMs,
            [...this.selection.trackIds]
        );
        if (created.length) this.selection.selectKeyframes(created);
    }

    addMarker() {
        const trackIds = [...this.selection.trackIds];
        const marker = this.store.addMarker(
            this.playback.currentTimeMs,
            '',
            trackIds.length === 1 ? trackIds[0] : null
        );
        if (marker) this.selection.selectMarker(marker.id);
    }

    createEventTrack(kind) {
        const defaultNames = {
            trigger: 'Trigger',
            boolean: 'On / Off',
            number: 'Value Event',
            color: 'Color Event'
        };
        const name = window.prompt('Event track name', defaultNames[kind] || 'Event');
        if (!name?.trim()) return;
        const track = this.store.addEventTrack(name.trim(), kind);
        if (track) this.selection.selectTrack(track.id);
    }

    capturePose() {
        const name = window.prompt('Pose name', `Pose ${(this.store.project.poseAssets?.length || 0) + 1}`);
        if (!name?.trim()) return;
        const pose = this.store.savePose(name.trim(), this.poseController.getPose());
        if (pose) this.poseSelect.value = pose.id;
    }

    previewSavedPose() {
        const pose = this.store.project.poseAssets?.find((item) => item.id === this.poseSelect.value);
        if (pose) this.poseController.applyPose(pose.values, { source: 'posePreview' });
    }

    keySavedPose() {
        const pose = this.store.project.poseAssets?.find((item) => item.id === this.poseSelect.value)
            || this.store.project.poseAssets?.at(-1);
        if (!pose) {
            this.capturePose();
            return;
        }
        const created = [];
        this.store.beginTransaction('Key saved pose');
        Object.entries(pose.values).forEach(([jointName, value]) => {
            const track = this.store.getTrack(jointName);
            const keyframe = this.store.upsertKeyframe(jointName, this.playback.currentTimeMs, value);
            if (track && keyframe) created.push({ trackId: track.id, keyframeId: keyframe.id });
        });
        this.store.endTransaction();
        this.poseController.applyPose(pose.values, { source: 'posePreview' });
        if (created.length) this.selection.selectKeyframes(created);
    }

    deleteSavedPose() {
        if (!this.poseSelect.value) return;
        this.store.deletePose(this.poseSelect.value);
    }

    renameMarker(marker) {
        const name = window.prompt(window.i18n?.t('markerName') || 'Marker name', marker.name);
        if (!name?.trim()) return;
        this.store.mutate('Rename marker', 'markerChanged', () => { marker.name = name.trim(); }, { marker });
    }

    jumpKeyframe(direction) {
        const times = this.store.getAllKeyframeTimes();
        const current = this.playback.currentTimeMs;
        const time = direction > 0
            ? times.find((item) => item > current + 0.5)
            : [...times].reverse().find((item) => item < current - 0.5);
        if (Number.isFinite(time)) {
            this.playback.seek(time);
            this.timeline.scrollToTime(time);
        }
    }

    stepFrame(direction) {
        this.playback.seek(this.playback.currentTimeMs + direction * this.store.frameDuration());
        this.timeline.scrollToTime(this.playback.currentTimeMs);
    }

    updateSelectedKeyTime() {
        const ref = this.selection.getKeyframeRefs()[0];
        if (!ref) return;
        this.store.updateKeyframe(ref, { timeMs: this.parseTime(this.keyTimeInput.value) });
        this.playback.seek(this.store.getKeyframe(ref)?.keyframe.timeMs || 0);
    }

    updateSelectedKeyValue() {
        const ref = this.selection.getKeyframeRefs()[0];
        const value = Number(this.keyValueInput.value);
        if (!ref || !Number.isFinite(value)) return;
        const item = this.store.getKeyframe(ref);
        this.store.updateKeyframe(ref, { value });
        if (item?.track.type === 'joint') {
            this.poseController.setJointValue(item.track.jointName, value, { source: 'animationEditor', commit: false });
        }
    }

    updateSelectedEventValue(value) {
        const ref = this.selection.getKeyframeRefs()[0];
        const item = this.store.getKeyframe(ref);
        if (!item || item.track.type !== 'event') return;
        this.store.updateKeyframe(ref, { value }, 'Edit event keyframe');
    }

    setInterpolation(interpolation) {
        const refs = this.selection.getKeyframeRefs().filter((ref) => {
            const track = this.store.getKeyframe(ref)?.track;
            return track?.type === 'joint' || (track?.type === 'event' && track.eventKind === 'number');
        });
        if (!refs.length) return;
        this.store.beginTransaction('Change interpolation');
        refs.forEach((ref) => this.store.updateKeyframe(ref, { interpolation }));
        this.store.endTransaction();
    }

    toggleRecording() {
        if (this.recording) this.stopRecording();
        else this.startRecording();
    }

    startRecording() {
        if (!this.model) return;
        const jointTracks = this.store.activeClip.tracks.filter((track) => track.type === 'joint' && !track.locked);
        const armed = jointTracks.filter((track) => track.recordArmed).map((track) => track.id);
        const selected = [...this.selection.trackIds]
            .filter((trackId) => this.store.getTrackById(trackId)?.type === 'joint');
        this.recordingTrackIds = new Set(armed.length ? armed : selected.length ? selected : jointTracks.map((track) => track.id));
        this.recordingRange = { ...this.store.activeClip.recordRange };
        this.playback.rangeOverride = { ...this.recordingRange };
        this.playback.loopOverride = false;
        this.playback.suppressedJointNames = new Set(
            [...this.recordingTrackIds].map((trackId) => this.store.getTrackById(trackId)?.jointName).filter(Boolean)
        );
        this.store.beginTransaction('Record performance');
        this.store.clearTrackRange([...this.recordingTrackIds], this.recordingRange.startMs, this.recordingRange.endMs);
        this.playback.seek(this.recordingRange.startMs);
        this.recording = true;
        this.recordButton.classList.add('active');
        this.playback.play();
    }

    stopRecording() {
        if (!this.recording) return;
        this.recording = false;
        this.recordButton.classList.remove('active');
        this.playback.suppressedJointNames = new Set();
        this.playback.rangeOverride = null;
        this.playback.loopOverride = null;
        this.store.endTransaction();
    }

    handleKeyboard(event) {
        if (!this.visible) return;
        const editingText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
        const command = event.ctrlKey || event.metaKey;
        if (editingText && !(command && ['z', 'y'].includes(event.key.toLowerCase()))) return;

        let handled = true;
        const key = event.key.toLowerCase();
        if (event.code === 'Space') this.playback.toggle();
        else if (event.key === 'Delete' || event.key === 'Backspace') this.deleteSelection();
        else if (command && key === 'z' && event.shiftKey) this.store.redo();
        else if (command && key === 'z') this.store.undo();
        else if (command && key === 'y') this.store.redo();
        else if (command && key === 'c') this.copySelection();
        else if (command && key === 'v') this.pasteSelection();
        else if (key === 'j') event.altKey ? this.stepFrame(-1) : this.jumpKeyframe(-1);
        else if (key === 'k') event.altKey ? this.stepFrame(1) : this.jumpKeyframe(1);
        else if (event.key === 'ArrowLeft') this.stepFrame(-1);
        else if (event.key === 'ArrowRight') this.stepFrame(1);
        else if (event.key === 'Home') this.playback.seek(this.store.activeClip.playRange.startMs);
        else if (event.key === 'End') this.playback.seek(this.store.activeClip.playRange.endMs);
        else if (key === 'g') this.setViewMode(this.viewMode === 'graph' ? 'timeline' : 'graph');
        else if (key === 'z' && !command) this.graph.fitValues();
        else if (event.key === 'Escape') {
            if (!this.inputDialog.hidden || !this.audioReactiveDialog.hidden) {
                this.inputDialog.hidden = true;
                this.audioReactiveDialog.hidden = true;
            } else {
                this.closeMenus();
                this.selection.clear();
            }
        }
        else handled = false;
        if (handled) event.preventDefault();
    }

    exportAnimation() {
        const blob = new Blob([this.store.serialize()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const safeName = this.modelName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
        anchor.href = url;
        anchor.download = `${safeName || 'robot'}.robotanim.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    async inspectMedia(file) {
        const kind = file.type.startsWith('video/') ? 'video' : 'audio';
        const url = URL.createObjectURL(file);
        try {
            const element = document.createElement(kind);
            element.preload = 'metadata';
            element.src = url;
            const durationMs = await new Promise((resolve, reject) => {
                element.onloadedmetadata = () => resolve(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
                element.onerror = () => reject(new Error('Unsupported media file'));
            });
            let waveform = [];
            if (kind === 'audio') {
                try {
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    const context = new AudioContextClass();
                    const buffer = await context.decodeAudioData(await file.arrayBuffer());
                    const channel = buffer.getChannelData(0);
                    const sampleCount = 240;
                    const blockSize = Math.max(1, Math.floor(channel.length / sampleCount));
                    waveform = Array.from({ length: sampleCount }, (_, index) => {
                        let peak = 0;
                        const start = index * blockSize;
                        const end = Math.min(channel.length, start + blockSize);
                        for (let cursor = start; cursor < end; cursor++) peak = Math.max(peak, Math.abs(channel[cursor]));
                        return peak;
                    });
                    await context.close();
                } catch (error) {
                    console.warn('Waveform extraction failed:', error);
                }
            }
            return { kind, durationMs, waveform };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async importMedia(file) {
        if (!file) return;
        try {
            const metadata = await this.inspectMedia(file);
            const asset = this.store.addMediaAsset({
                name: file.name,
                mime: file.type,
                dataUrl: await this.fileToDataUrl(file),
                ...metadata
            });
            const track = this.store.addMediaTrack(asset.id, this.playback.currentTimeMs);
            if (track) this.selection.selectTrack(track.id);
            this.timeline.draw();
        } catch (error) {
            console.error('Failed to import media:', error);
            window.alert(`Media import failed: ${error.message}`);
        } finally {
            this.mediaFileInput.value = '';
        }
    }

    async importAnimation(file) {
        if (!file) return;
        try {
            this.stopRecording();
            this.playback.pause();
            this.suspendAutosave = true;
            this.store.load(await file.text());
            this.reconcileModelTracks();
            this.selection.clear();
            this.playback.seek(this.store.activeClip.playRange.startMs);
            this.status.hidden = true;
            this.root.querySelector('.animation-editor-body').hidden = false;
            this.guideVisible = this.getJointKeyTimes().length < 2;
            this.fitTime();
            this.showToast(this.translate('animationImported', { name: this.store.activeClip.name }));
        } catch (error) {
            console.error('Failed to import animation:', error);
            window.alert(`Animation import failed: ${error.message}`);
        } finally {
            this.suspendAutosave = false;
            this.fileInput.value = '';
            this.scheduleAutosave();
        }
    }
}
