import { evaluateTrack } from '../core/BezierEvaluator.js';

const MIN_PIXELS_PER_SECOND = 0.05;
const MAX_PIXELS_PER_SECOND = 1200;

export class GraphCanvas {
    constructor({ canvas, scroller, store, playback, selection, getVelocityLimit = null }) {
        this.canvas = canvas;
        this.scroller = scroller;
        this.store = store;
        this.playback = playback;
        this.selection = selection;
        this.getVelocityLimit = getVelocityLimit;
        this.labelWidth = 72;
        this.rulerHeight = 26;
        this.pixelsPerSecond = 100;
        this.valueMin = -1;
        this.valueMax = 1;
        this.axisLock = 'none';
        this.lockedTrackIds = null;
        this.drag = null;
        this.selectionRect = null;
        this.onZoomChanged = null;
        this.spacer = document.createElement('div');
        this.spacer.className = 'animation-canvas-spacer';
        this.scroller.insertBefore(this.spacer, this.canvas);

        this.store.subscribe(() => this.draw());
        this.playback.subscribe(() => this.draw());
        this.selection.subscribe(() => this.draw());
        this.resizeFrame = null;
        this.resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(this.resizeFrame);
            this.resizeFrame = requestAnimationFrame(() => this.draw());
        });
        this.resizeObserver.observe(this.scroller);
        this.scroller.addEventListener('scroll', () => this.draw());
        this.bindEvents();
    }

    get displayedTracks() {
        const ids = this.lockedTrackIds ? new Set(this.lockedTrackIds) : new Set(this.selection.trackIds);
        if (!this.lockedTrackIds) this.selection.getKeyframeRefs().forEach((ref) => ids.add(ref.trackId));
        return (this.store.activeClip?.tracks || []).filter((track) => (
            (track.type === 'joint' || (track.type === 'event' && track.eventKind === 'number'))
            && ids.has(track.id) && track.visible
        ));
    }

    toggleSelectionLock() {
        if (this.lockedTrackIds) {
            this.lockedTrackIds = null;
            this.draw();
            return false;
        }
        const trackIds = this.displayedTracks.map((track) => track.id);
        if (!trackIds.length) return false;
        this.lockedTrackIds = trackIds;
        this.draw();
        return true;
    }

    timeToX(timeMs) {
        return this.contentTimeToX(timeMs) - this.scroller.scrollLeft;
    }

    contentTimeToX(timeMs) {
        return this.labelWidth + timeMs * this.pixelsPerSecond / 1000;
    }

    xToTime(x) {
        return (x + this.scroller.scrollLeft - this.labelWidth) * 1000 / this.pixelsPerSecond;
    }

    graphHeight() {
        return Math.max(80, (parseFloat(this.canvas.style.height) || this.scroller.clientHeight) - this.rulerHeight - 18);
    }

    valueToY(value) {
        const height = this.graphHeight();
        const progress = (value - this.valueMin) / Math.max(1e-9, this.valueMax - this.valueMin);
        return this.rulerHeight + (1 - progress) * height;
    }

    yToValue(y) {
        const progress = 1 - (y - this.rulerHeight) / this.graphHeight();
        return this.valueMin + progress * (this.valueMax - this.valueMin);
    }

    setZoom(pixelsPerSecond, anchorClientX = null) {
        const nextZoom = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond));
        if (Math.abs(nextZoom - this.pixelsPerSecond) < 0.0001) return;

        let anchorTime = this.playback.currentTimeMs;
        let viewportX = this.scroller.clientWidth / 2;
        if (Number.isFinite(anchorClientX)) {
            const rect = this.scroller.getBoundingClientRect();
            viewportX = anchorClientX - rect.left;
            anchorTime = this.xToTime(viewportX);
        }
        this.pixelsPerSecond = nextZoom;
        this.draw();
        this.scroller.scrollLeft = Math.max(0, this.contentTimeToX(anchorTime) - viewportX);
        this.onZoomChanged?.(this.pixelsPerSecond);
    }

    setValueZoom(scaleFactor) {
        const center = (this.valueMin + this.valueMax) / 2;
        const half = Math.max(0.0001, (this.valueMax - this.valueMin) / 2 * scaleFactor);
        this.valueMin = center - half;
        this.valueMax = center + half;
        this.draw();
    }

    fitValues() {
        const values = [];
        this.displayedTracks.forEach((track) => {
            track.keyframes.forEach((keyframe) => {
                values.push(keyframe.value);
                values.push(keyframe.value + (keyframe.inHandle?.dy || 0));
                values.push(keyframe.value + (keyframe.outHandle?.dy || 0));
            });
        });
        if (!values.length) {
            this.valueMin = -1;
            this.valueMax = 1;
        } else {
            const minimum = Math.min(...values);
            const maximum = Math.max(...values);
            const padding = Math.max(0.1, (maximum - minimum) * 0.15);
            this.valueMin = minimum - padding;
            this.valueMax = maximum + padding;
        }
        this.draw();
    }

    getPointer(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    hitKeyframe(x, y) {
        for (const track of this.displayedTracks) {
            for (const keyframe of track.keyframes) {
                if (Math.abs(this.timeToX(keyframe.timeMs) - x) <= 8
                    && Math.abs(this.valueToY(keyframe.value) - y) <= 8) {
                    return { track, keyframe, ref: { trackId: track.id, keyframeId: keyframe.id } };
                }
            }
        }
        return null;
    }

    hitHandle(x, y) {
        for (const ref of this.selection.getKeyframeRefs()) {
            const item = this.store.getKeyframe(ref);
            if (!item || ['linear', 'step'].includes(item.keyframe.interpolation)) continue;
            for (const side of ['in', 'out']) {
                const handle = side === 'in' ? item.keyframe.inHandle : item.keyframe.outHandle;
                const handleX = this.timeToX(item.keyframe.timeMs + handle.dxMs);
                const handleY = this.valueToY(item.keyframe.value + handle.dy);
                if (Math.abs(handleX - x) <= 8 && Math.abs(handleY - y) <= 8) {
                    return { ...item, ref, side };
                }
            }
        }
        return null;
    }

    selectedOriginals() {
        return this.selection.getKeyframeRefs().map((ref) => {
            const item = this.store.getKeyframe(ref);
            return item ? { ...ref, timeMs: item.keyframe.timeMs, value: item.keyframe.value } : null;
        }).filter(Boolean);
    }

    bindEvents() {
        this.canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
        this.canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
        this.canvas.addEventListener('pointercancel', (event) => this.pointerUp(event));
        this.canvas.addEventListener('wheel', (event) => {
            if (event.altKey) {
                event.preventDefault();
                this.setValueZoom(Math.exp(event.deltaY * 0.002));
            } else if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                this.setZoom(this.pixelsPerSecond * Math.exp(-event.deltaY * 0.002), event.clientX);
            }
        }, { passive: false });
    }

    pointerDown(event) {
        const point = this.getPointer(event);
        const handle = this.hitHandle(point.x, point.y);
        if (handle) {
            this.store.beginTransaction('Edit curve handle');
            this.drag = { type: 'handle', ...handle };
        } else {
            const hit = this.hitKeyframe(point.x, point.y);
            if (hit) {
                const additive = event.shiftKey;
                const toggle = event.ctrlKey || event.metaKey;
                if (!this.selection.hasKeyframe(hit.ref) || additive || toggle) {
                    this.selection.selectKeyframe(hit.ref, { additive, toggle });
                }
                this.store.beginTransaction('Move graph keyframes');
                this.drag = { type: 'keys', start: point, originals: this.selectedOriginals() };
            } else if (point.y < this.rulerHeight) {
                this.drag = { type: 'scrub' };
                this.playback.seek(this.store.snapTime(this.xToTime(point.x)));
            } else {
                this.drag = {
                    type: 'box',
                    start: point,
                    current: point,
                    additive: event.shiftKey || event.ctrlKey || event.metaKey
                };
                this.selectionRect = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
            }
        }
        this.canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    pointerMove(event) {
        if (!this.drag) return;
        const point = this.getPointer(event);
        if (this.drag.type === 'keys') {
            const deltaTime = this.axisLock === 'value'
                ? 0 : (point.x - this.drag.start.x) * 1000 / this.pixelsPerSecond;
            const deltaValue = this.axisLock === 'time'
                ? 0 : this.yToValue(point.y) - this.yToValue(this.drag.start.y);
            this.store.moveKeyframesFrom(this.drag.originals, deltaTime, deltaValue);
        } else if (this.drag.type === 'handle') {
            const keyframe = this.store.getKeyframe(this.drag.ref)?.keyframe;
            if (!keyframe) return;
            this.store.updateHandle(this.drag.ref, this.drag.side, {
                dxMs: this.xToTime(point.x) - keyframe.timeMs,
                dy: this.yToValue(point.y) - keyframe.value
            });
        } else if (this.drag.type === 'scrub') {
            this.playback.seek(this.store.snapTime(this.xToTime(point.x)));
        } else if (this.drag.type === 'box') {
            this.drag.current = point;
            this.selectionRect = {
                x1: Math.min(point.x, this.drag.start.x),
                y1: Math.min(point.y, this.drag.start.y),
                x2: Math.max(point.x, this.drag.start.x),
                y2: Math.max(point.y, this.drag.start.y)
            };
            this.draw();
        }
        event.preventDefault();
    }

    pointerUp(event) {
        if (!this.drag) return;
        if (['keys', 'handle'].includes(this.drag.type)) {
            this.store.endTransaction();
        } else if (this.drag.type === 'box') {
            const rect = this.selectionRect;
            if (rect && (rect.x2 - rect.x1 > 4 || rect.y2 - rect.y1 > 4)) {
                const refs = [];
                this.displayedTracks.forEach((track) => {
                    track.keyframes.forEach((keyframe) => {
                        const x = this.timeToX(keyframe.timeMs);
                        const y = this.valueToY(keyframe.value);
                        if (x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2) {
                            refs.push({ trackId: track.id, keyframeId: keyframe.id });
                        }
                    });
                });
                this.selection.selectKeyframes(refs, { additive: this.drag.additive });
            } else {
                this.playback.seek(this.store.snapTime(this.xToTime(this.drag.start.x)));
                if (!this.drag.additive) this.selection.clear();
            }
            this.selectionRect = null;
        }
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.drag = null;
        this.draw();
    }

    getColors() {
        const styles = getComputedStyle(this.canvas);
        return {
            background: styles.getPropertyValue('--animation-editor-surface').trim() || 'rgba(127,127,127,.045)',
            panel: styles.getPropertyValue('--animation-editor-ruler').trim() || 'rgba(127,127,127,.085)',
            border: styles.getPropertyValue('--glass-border').trim() || '#444',
            text: styles.getPropertyValue('--text-primary').trim() || '#fff',
            muted: styles.getPropertyValue('--text-tertiary').trim() || '#aaa',
            accent: styles.getPropertyValue('--accent').trim() || '#0a84ff'
        };
    }

    drawHandle(context, keyframe, handle, color) {
        const keyX = this.timeToX(keyframe.timeMs);
        const keyY = this.valueToY(keyframe.value);
        const handleX = this.timeToX(keyframe.timeMs + handle.dxMs);
        const handleY = this.valueToY(keyframe.value + handle.dy);
        context.strokeStyle = color;
        context.globalAlpha = 0.65;
        context.beginPath();
        context.moveTo(keyX, keyY);
        context.lineTo(handleX, handleY);
        context.stroke();
        context.globalAlpha = 1;
        context.fillStyle = '#ffffff';
        context.strokeStyle = color;
        context.beginPath();
        context.arc(handleX, handleY, 4, 0, Math.PI * 2);
        context.fill();
        context.stroke();
    }

    draw() {
        const clip = this.store.activeClip;
        if (!clip) return;
        const logicalWidth = this.scroller.clientWidth || 640;
        const contentWidth = Math.max(
            logicalWidth,
            this.labelWidth + clip.durationMs * this.pixelsPerSecond / 1000 + 60
        );
        const logicalHeight = Math.max(180, this.scroller.clientHeight || 180);
        const ratio = window.devicePixelRatio || 1;
        this.spacer.style.width = `${contentWidth}px`;
        this.spacer.style.height = `${logicalHeight}px`;
        if (this.canvas.width !== Math.round(logicalWidth * ratio)
            || this.canvas.height !== Math.round(logicalHeight * ratio)) {
            this.canvas.width = Math.round(logicalWidth * ratio);
            this.canvas.height = Math.round(logicalHeight * ratio);
            this.canvas.style.width = `${logicalWidth}px`;
            this.canvas.style.height = `${logicalHeight}px`;
        }

        const context = this.canvas.getContext('2d');
        const colors = this.getColors();
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, logicalWidth, logicalHeight);
        context.fillStyle = colors.background;
        context.fillRect(0, 0, logicalWidth, logicalHeight);
        context.fillStyle = colors.panel;
        context.fillRect(0, 0, logicalWidth, this.rulerHeight);
        context.font = '10px system-ui, sans-serif';
        context.textBaseline = 'middle';

        for (let index = 0; index <= 5; index++) {
            const value = this.valueMin + (this.valueMax - this.valueMin) * index / 5;
            const y = this.valueToY(value);
            context.strokeStyle = colors.border;
            context.beginPath();
            context.moveTo(this.labelWidth, y + 0.5);
            context.lineTo(logicalWidth, y + 0.5);
            context.stroke();
            context.fillStyle = colors.muted;
            context.fillText(value.toFixed(2), 5, y);
        }

        const visibleStartMs = Math.max(0, this.xToTime(this.labelWidth));
        const visibleEndMs = Math.min(clip.durationMs, this.xToTime(logicalWidth));
        const secondsStep = Math.max(1 / 30, Math.ceil(60 / this.pixelsPerSecond * 2) / 2);
        const firstGridSecond = Math.floor(visibleStartMs / 1000 / secondsStep) * secondsStep;
        for (let seconds = firstGridSecond; seconds * 1000 <= visibleEndMs + secondsStep * 1000; seconds += secondsStep) {
            const x = this.timeToX(seconds * 1000);
            context.strokeStyle = colors.border;
            context.beginPath();
            context.moveTo(x + 0.5, 0);
            context.lineTo(x + 0.5, logicalHeight);
            context.stroke();
            context.fillStyle = colors.muted;
            context.fillText(`${seconds.toFixed(secondsStep < 1 ? 1 : 0)}s`, x + 3, 12);
        }

        if (!this.displayedTracks.length) {
            context.fillStyle = colors.muted;
            context.font = '12px system-ui, sans-serif';
            context.fillText('Select one or more tracks to edit curves', this.labelWidth + 18, this.rulerHeight + 24);
        }

        this.displayedTracks.forEach((track) => {
            if (track.keyframes.length) {
                const stepMs = Math.max(2, 3000 / this.pixelsPerSecond);
                const velocityLimit = Number(this.getVelocityLimit?.(track.jointName));
                let previous = null;
                const curveStartMs = Math.max(0, visibleStartMs - stepMs);
                const curveEndMs = Math.min(clip.durationMs, visibleEndMs + stepMs);
                for (let time = curveStartMs; time <= curveEndMs; time += stepMs) {
                    const value = evaluateTrack(track, time);
                    const x = this.timeToX(time);
                    const y = this.valueToY(value);
                    if (previous) {
                        const velocity = Math.abs(value - previous.value) / ((time - previous.time) / 1000);
                        const exceedsLimit = Number.isFinite(velocityLimit) && velocityLimit > 0 && velocity > velocityLimit;
                        context.strokeStyle = exceedsLimit ? '#ff453a' : track.color;
                        context.lineWidth = 2;
                        context.setLineDash(exceedsLimit ? [5, 4] : []);
                        context.beginPath();
                        context.moveTo(previous.x, previous.y);
                        context.lineTo(x, y);
                        context.stroke();
                    }
                    previous = { time, value, x, y };
                }
                context.setLineDash([]);
            }

            track.keyframes.forEach((keyframe) => {
                const ref = { trackId: track.id, keyframeId: keyframe.id };
                const selected = this.selection.hasKeyframe(ref);
                if (selected && !['linear', 'step'].includes(keyframe.interpolation)) {
                    this.drawHandle(context, keyframe, keyframe.inHandle, track.color);
                    this.drawHandle(context, keyframe, keyframe.outHandle, track.color);
                }
                const keyX = this.timeToX(keyframe.timeMs);
                if (keyX < this.labelWidth - 8 || keyX > logicalWidth + 8) return;
                context.fillStyle = selected ? '#ffffff' : track.color;
                context.strokeStyle = selected ? track.color : '#ffffff';
                context.lineWidth = selected ? 2 : 1;
                context.beginPath();
                context.arc(keyX, this.valueToY(keyframe.value), 5, 0, Math.PI * 2);
                context.fill();
                context.stroke();
            });
        });

        const playheadX = this.timeToX(this.playback.currentTimeMs);
        context.strokeStyle = '#ff453a';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(playheadX, 0);
        context.lineTo(playheadX, logicalHeight);
        context.stroke();

        if (this.selectionRect) {
            context.fillStyle = 'rgba(10,132,255,.14)';
            context.strokeStyle = colors.accent;
            context.fillRect(
                this.selectionRect.x1,
                this.selectionRect.y1,
                this.selectionRect.x2 - this.selectionRect.x1,
                this.selectionRect.y2 - this.selectionRect.y1
            );
            context.strokeRect(
                this.selectionRect.x1 + 0.5,
                this.selectionRect.y1 + 0.5,
                this.selectionRect.x2 - this.selectionRect.x1,
                this.selectionRect.y2 - this.selectionRect.y1
            );
        }
    }
}
