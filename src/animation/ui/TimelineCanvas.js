const MIN_PIXELS_PER_SECOND = 0.05;
const MAX_PIXELS_PER_SECOND = 1200;

export class TimelineCanvas {
    constructor({ canvas, scroller, store, playback, selection }) {
        this.canvas = canvas;
        this.scroller = scroller;
        this.store = store;
        this.playback = playback;
        this.selection = selection;
        this.labelWidth = 190;
        this.rulerHeight = 52;
        this.rowHeight = 28;
        this.pixelsPerSecond = 100;
        this.drag = null;
        this.selectionRect = null;
        this.onZoomChanged = null;
        this.onEditMarker = null;
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

    get tracks() {
        return this.store.activeClip?.tracks || [];
    }

    get visibleTracks() {
        return this.tracks;
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

    setZoom(pixelsPerSecond, anchorClientX = null) {
        const oldZoom = this.pixelsPerSecond;
        const nextZoom = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecond));
        if (Math.abs(nextZoom - oldZoom) < 0.01) return;

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

    zoomToFit() {
        const durationSeconds = Math.max(0.1, (this.store.activeClip?.durationMs || 1000) / 1000);
        const available = Math.max(200, this.scroller.clientWidth - this.labelWidth - 40);
        this.setZoom(available / durationSeconds);
        this.scroller.scrollLeft = 0;
    }

    scrollToTime(timeMs) {
        const x = this.contentTimeToX(timeMs);
        const left = this.scroller.scrollLeft;
        const right = left + this.scroller.clientWidth;
        if (x < left + this.labelWidth) this.scroller.scrollLeft = Math.max(0, x - this.labelWidth - 20);
        else if (x > right - 30) this.scroller.scrollLeft = x - this.scroller.clientWidth + 30;
    }

    getPointer(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    rowAt(y) {
        const rowIndex = Math.floor((y - this.rulerHeight) / this.rowHeight);
        if (rowIndex < 0 || rowIndex >= this.visibleTracks.length) return null;
        return { track: this.visibleTracks[rowIndex], rowIndex };
    }

    hitKeyframe(x, y) {
        const row = this.rowAt(y);
        if (!row) return null;
        const centerY = this.rulerHeight + row.rowIndex * this.rowHeight + this.rowHeight / 2;
        const keyframe = row.track.keyframes.find((item) => (
            Math.abs(this.timeToX(item.timeMs) - x) <= 8 && Math.abs(centerY - y) <= 9
        ));
        return keyframe ? {
            track: row.track,
            keyframe,
            ref: { trackId: row.track.id, keyframeId: keyframe.id }
        } : null;
    }

    hitMarker(x, y) {
        return this.store.activeClip?.markers.find((marker) => {
            const markerX = this.timeToX(marker.timeMs);
            if (Math.abs(markerX - x) > 7) return false;
            if (!marker.trackId) return y <= 20;
            const rowIndex = this.visibleTracks.findIndex((track) => track.id === marker.trackId);
            if (rowIndex < 0) return false;
            const markerY = this.rulerHeight + rowIndex * this.rowHeight + 5;
            return Math.abs(markerY - y) <= 9;
        }) || null;
    }

    hitPlayRange(x, y) {
        if (y < 23 || y > 39) return null;
        const range = this.store.activeClip?.playRange;
        if (!range) return null;
        if (Math.abs(this.timeToX(range.startMs) - x) <= 8) return 'start';
        if (Math.abs(this.timeToX(range.endMs) - x) <= 8) return 'end';
        return null;
    }

    hitRecordRange(x, y) {
        if (y < 40 || y > 52) return null;
        const range = this.store.activeClip?.recordRange;
        if (!range) return null;
        if (Math.abs(this.timeToX(range.startMs) - x) <= 8) return 'start';
        if (Math.abs(this.timeToX(range.endMs) - x) <= 8) return 'end';
        return null;
    }

    getSelectedOriginals() {
        return this.selection.getKeyframeRefs().map((ref) => {
            const item = this.store.getKeyframe(ref);
            return item ? { ...ref, timeMs: item.keyframe.timeMs, value: item.keyframe.value } : null;
        }).filter(Boolean);
    }

    bindEvents() {
        this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        this.canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
        this.canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
        this.canvas.addEventListener('pointercancel', (event) => this.pointerUp(event));
        this.canvas.addEventListener('dblclick', (event) => this.doubleClick(event));
        this.canvas.addEventListener('wheel', (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            const factor = Math.exp(-event.deltaY * 0.002);
            this.setZoom(this.pixelsPerSecond * factor, event.clientX);
        }, { passive: false });
    }

    pointerDown(event) {
        const point = this.getPointer(event);
        const marker = this.hitMarker(point.x, point.y);
        if (marker) {
            this.selection.selectMarker(marker.id);
            this.store.beginTransaction('Move marker');
            this.drag = { type: 'marker', markerId: marker.id };
        } else {
            const rangeSide = this.hitPlayRange(point.x, point.y);
            if (rangeSide) {
                this.store.beginTransaction('Change play range');
                this.drag = { type: 'playRange', side: rangeSide };
            } else {
                const recordRangeSide = this.hitRecordRange(point.x, point.y);
                if (recordRangeSide) {
                    this.store.beginTransaction('Change record range');
                    this.drag = { type: 'recordRange', side: recordRangeSide };
                } else {
                    const hit = this.hitKeyframe(point.x, point.y);
                    if (hit) {
                        const additive = event.shiftKey;
                        const toggle = event.ctrlKey || event.metaKey;
                        if (!this.selection.hasKeyframe(hit.ref) || additive || toggle) {
                            this.selection.selectKeyframe(hit.ref, { additive, toggle });
                        }
                        this.store.beginTransaction('Move keyframes');
                        this.drag = {
                            type: 'keys',
                            start: point,
                            originals: this.getSelectedOriginals()
                        };
                    } else if (point.x < this.labelWidth && point.y >= this.rulerHeight) {
                        const row = this.rowAt(point.y);
                        if (!row) return;
                        if (point.x >= 101 && point.x < 122) {
                            this.store.setTrackProperty(row.track.id, 'recordArmed', !row.track.recordArmed);
                        } else if (point.x >= 122 && point.x < 145) {
                            this.store.setTrackProperty(row.track.id, 'visible', !row.track.visible);
                        } else if (point.x >= 145 && point.x <= 167) {
                            this.store.setTrackProperty(row.track.id, 'muted', !row.track.muted);
                        } else if (point.x > 167) {
                            this.store.setTrackProperty(row.track.id, 'locked', !row.track.locked);
                        } else {
                            this.selection.selectTrack(row.track.id, {
                                additive: event.shiftKey,
                                toggle: event.ctrlKey || event.metaKey
                            });
                        }
                        return;
                    } else if (point.y < this.rulerHeight) {
                        this.selection.clear();
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
            }
        }
        if (this.drag) {
            this.canvas.setPointerCapture(event.pointerId);
            event.preventDefault();
        }
    }

    pointerMove(event) {
        if (!this.drag) return;
        const point = this.getPointer(event);
        if (this.drag.type === 'keys') {
            const deltaMs = (point.x - this.drag.start.x) * 1000 / this.pixelsPerSecond;
            this.store.moveKeyframesFrom(this.drag.originals, deltaMs, 0);
        } else if (this.drag.type === 'marker') {
            this.store.moveMarker(this.drag.markerId, this.xToTime(point.x));
        } else if (this.drag.type === 'playRange') {
            const range = this.store.activeClip.playRange;
            const time = this.xToTime(point.x);
            if (this.drag.side === 'start') this.store.setPlayRange(time, range.endMs);
            else this.store.setPlayRange(range.startMs, time);
        } else if (this.drag.type === 'recordRange') {
            const range = this.store.activeClip.recordRange;
            const time = this.xToTime(point.x);
            if (this.drag.side === 'start') this.store.setRecordRange(time, range.endMs);
            else this.store.setRecordRange(range.startMs, time);
        } else if (this.drag.type === 'scrub') {
            this.playback.seek(this.store.snapTime(this.xToTime(point.x)));
        } else if (this.drag.type === 'box') {
            this.drag.current = point;
            this.selectionRect = {
                x1: Math.min(this.drag.start.x, point.x),
                y1: Math.min(this.drag.start.y, point.y),
                x2: Math.max(this.drag.start.x, point.x),
                y2: Math.max(this.drag.start.y, point.y)
            };
            this.draw();
        }
        event.preventDefault();
    }

    pointerUp(event) {
        if (!this.drag) return;
        if (this.drag.type === 'keys' || this.drag.type === 'marker'
            || this.drag.type === 'playRange' || this.drag.type === 'recordRange') {
            this.store.endTransaction();
        } else if (this.drag.type === 'box') {
            const rect = this.selectionRect;
            if (rect && (rect.x2 - rect.x1 > 4 || rect.y2 - rect.y1 > 4)) {
                const refs = [];
                this.visibleTracks.forEach((track, rowIndex) => {
                    const y = this.rulerHeight + rowIndex * this.rowHeight + this.rowHeight / 2;
                    if (y < rect.y1 || y > rect.y2) return;
                    track.keyframes.forEach((keyframe) => {
                        const x = this.timeToX(keyframe.timeMs);
                        if (x >= rect.x1 && x <= rect.x2) refs.push({ trackId: track.id, keyframeId: keyframe.id });
                    });
                });
                this.selection.selectKeyframes(refs, { additive: this.drag.additive });
            } else {
                const row = this.rowAt(this.drag.start.y);
                this.selection.clear();
                if (row) this.selection.selectTrack(row.track.id);
                if (this.drag.start.x >= this.labelWidth) {
                    this.playback.seek(this.store.snapTime(this.xToTime(this.drag.start.x)));
                }
            }
            this.selectionRect = null;
        }
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.drag = null;
        this.draw();
    }

    doubleClick(event) {
        const point = this.getPointer(event);
        const marker = this.hitMarker(point.x, point.y);
        if (marker) {
            this.onEditMarker?.(marker);
            return;
        }
        const row = this.rowAt(point.y);
        if (!row || point.x < this.labelWidth || row.track.locked) return;
        const timeMs = this.xToTime(point.x);
        const previousEventKey = [...row.track.keyframes].reverse().find((keyframe) => keyframe.timeMs <= timeMs);
        const keyframe = row.track.type === 'media'
            ? this.store.addMediaKeyframe(row.track.id, timeMs)
            : row.track.type === 'event'
                ? this.store.addEventKeyframe(
                    row.track.id,
                    timeMs,
                    row.track.eventKind === 'number' ? 0.5
                        : row.track.eventKind === 'color' ? row.track.color
                            : row.track.eventKind === 'boolean'
                                ? !Boolean(previousEventKey?.value) : true
                )
                : this.store.upsertKeyframe(
                row.track.jointName,
                timeMs,
                this.playback.poseController.getJointValue(row.track.jointName)
            );
        if (keyframe) this.selection.selectKeyframe({ trackId: row.track.id, keyframeId: keyframe.id });
    }

    getColors() {
        const styles = getComputedStyle(this.canvas);
        return {
            background: styles.getPropertyValue('--animation-editor-surface').trim() || 'rgba(127,127,127,.045)',
            panel: styles.getPropertyValue('--animation-editor-ruler').trim() || 'rgba(127,127,127,.085)',
            border: styles.getPropertyValue('--glass-border').trim() || '#444',
            text: styles.getPropertyValue('--text-primary').trim() || '#fff',
            muted: styles.getPropertyValue('--text-tertiary').trim() || '#aaa',
            accent: styles.getPropertyValue('--accent').trim() || '#0a84ff',
            selected: styles.getPropertyValue('--accent-secondary').trim() || 'rgba(10,132,255,.18)'
        };
    }

    chooseGridInterval() {
        const candidates = [1 / 30, 1 / 15, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
        return candidates.find((seconds) => seconds * this.pixelsPerSecond >= 55) || 60;
    }

    formatTime(timeMs) {
        const clip = this.store.activeClip;
        const totalFrames = Math.round(timeMs / 1000 * clip.fps);
        const frames = totalFrames % clip.fps;
        const totalSeconds = Math.floor(totalFrames / clip.fps);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60);
        return minutes > 0
            ? `${minutes}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
            : `${seconds}:${String(frames).padStart(2, '0')}`;
    }

    drawDiamond(context, x, y, selected, color, locked) {
        context.save();
        context.translate(x, y);
        context.rotate(Math.PI / 4);
        context.fillStyle = selected ? '#ffffff' : color;
        context.strokeStyle = locked ? '#8e8e93' : '#ffffff';
        context.lineWidth = selected ? 2 : 1;
        context.beginPath();
        context.rect(-5, -5, 10, 10);
        context.fill();
        context.stroke();
        context.restore();
    }

    fitText(context, text, maxWidth) {
        const value = String(text || '');
        if (context.measureText(value).width <= maxWidth) return value;
        let end = value.length;
        while (end > 1 && context.measureText(`${value.slice(0, end)}…`).width > maxWidth) end -= 1;
        return `${value.slice(0, end)}…`;
    }

    draw() {
        const clip = this.store.activeClip;
        if (!clip) return;
        const logicalWidth = this.scroller.clientWidth || 640;
        const contentWidth = Math.max(
            logicalWidth,
            this.labelWidth + clip.durationMs * this.pixelsPerSecond / 1000 + 60
        );
        const logicalHeight = Math.max(
            this.scroller.clientHeight || 180,
            this.rulerHeight + Math.max(1, this.visibleTracks.length) * this.rowHeight
        );
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
        context.font = '11px system-ui, sans-serif';
        context.textBaseline = 'middle';

        const rangeStartX = this.timeToX(clip.playRange.startMs);
        const rangeEndX = this.timeToX(clip.playRange.endMs);
        const recordStartX = this.timeToX(clip.recordRange?.startMs ?? clip.playRange.startMs);
        const recordEndX = this.timeToX(clip.recordRange?.endMs ?? clip.playRange.endMs);
        context.fillStyle = 'rgba(0,0,0,.24)';
        context.fillRect(this.labelWidth, this.rulerHeight, Math.max(0, rangeStartX - this.labelWidth), logicalHeight);
        context.fillRect(rangeEndX, this.rulerHeight, Math.max(0, logicalWidth - rangeEndX), logicalHeight);

        const intervalSeconds = this.chooseGridInterval();
        const intervalMs = intervalSeconds * 1000;
        const visibleStartMs = Math.max(0, this.xToTime(this.labelWidth));
        const visibleEndMs = Math.min(clip.durationMs, this.xToTime(logicalWidth));
        if (this.pixelsPerSecond >= 300) {
            const frameMs = this.store.frameDuration(clip);
            context.strokeStyle = 'rgba(127,127,127,.12)';
            context.lineWidth = 1;
            const firstFrameTime = Math.floor(visibleStartMs / frameMs) * frameMs;
            for (let time = firstFrameTime; time <= visibleEndMs + frameMs; time += frameMs) {
                const x = this.timeToX(time);
                context.beginPath();
                context.moveTo(x + 0.5, this.rulerHeight - 5);
                context.lineTo(x + 0.5, logicalHeight);
                context.stroke();
            }
        }
        const firstGridTime = Math.floor(visibleStartMs / intervalMs) * intervalMs;
        for (let time = firstGridTime; time <= visibleEndMs + intervalMs; time += intervalMs) {
            const x = this.timeToX(time);
            context.strokeStyle = colors.border;
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x + 0.5, 20);
            context.lineTo(x + 0.5, logicalHeight);
            context.stroke();
            context.fillStyle = colors.muted;
            context.fillText(this.formatTime(time), x + 4, 15);
        }

        this.visibleTracks.forEach((track, index) => {
            const y = this.rulerHeight + index * this.rowHeight;
            if (this.selection.trackIds.has(track.id)) {
                context.fillStyle = colors.selected;
                context.fillRect(0, y, logicalWidth, this.rowHeight);
            } else if (index % 2) {
                context.fillStyle = 'rgba(127,127,127,.05)';
                context.fillRect(0, y, logicalWidth, this.rowHeight);
            }
            context.strokeStyle = colors.border;
            context.beginPath();
            context.moveTo(0, y + this.rowHeight + 0.5);
            context.lineTo(logicalWidth, y + this.rowHeight + 0.5);
            context.stroke();
            context.fillStyle = track.muted ? colors.muted : colors.text;
            const typeIcon = track.type === 'media' ? '♪ '
                : track.type === 'event' ? `${{ trigger: '⚡', boolean: '◐', number: '◆', color: '⬟' }[track.eventKind] || '⚡'} ` : '';
            context.fillText(this.fitText(context, `${typeIcon}${track.name || track.jointName}`, 74), 24, y + this.rowHeight / 2);
            context.fillStyle = track.color;
            context.fillRect(10, y + 9, 7, 10);
            context.fillStyle = track.recordArmed ? '#ff453a' : colors.muted;
            context.fillText(track.recordArmed ? '●' : '○', 106, y + this.rowHeight / 2);
            context.fillStyle = track.visible ? colors.muted : '#ff9f0a';
            context.fillText(track.visible ? '◉' : '⊘', 128, y + this.rowHeight / 2);
            context.fillStyle = track.muted ? '#ff453a' : colors.muted;
            context.fillText(track.muted ? 'M' : '○', 150, y + this.rowHeight / 2);
            context.fillStyle = track.locked ? '#ffd60a' : colors.muted;
            context.fillText(track.locked ? '▣' : '□', 173, y + this.rowHeight / 2);
            context.globalAlpha = track.muted ? 0.45 : 1;
            if (track.type === 'media') {
                const asset = this.store.project.mediaAssets?.find((item) => item.id === track.assetId);
                track.keyframes.forEach((keyframe) => {
                    const startX = this.timeToX(keyframe.timeMs);
                    const endTime = Math.min(clip.durationMs, keyframe.timeMs + (asset?.durationMs || 500));
                    const endX = this.timeToX(endTime);
                    context.fillStyle = `${track.color}38`;
                    context.fillRect(startX, y + 4, Math.max(5, endX - startX), this.rowHeight - 8);
                    context.strokeStyle = track.color;
                    context.strokeRect(startX + 0.5, y + 4.5, Math.max(5, endX - startX), this.rowHeight - 9);
                    if (asset?.waveform?.length && endX - startX > 20) {
                        context.strokeStyle = track.color;
                        context.beginPath();
                        asset.waveform.forEach((sample, sampleIndex) => {
                            const waveX = startX + sampleIndex / (asset.waveform.length - 1) * (endX - startX);
                            const amplitude = sample * (this.rowHeight - 10) / 2;
                            context.moveTo(waveX, y + this.rowHeight / 2 - amplitude);
                            context.lineTo(waveX, y + this.rowHeight / 2 + amplitude);
                        });
                        context.stroke();
                    }
                });
            }
            track.keyframes.forEach((keyframe) => {
                const ref = { trackId: track.id, keyframeId: keyframe.id };
                const keyX = this.timeToX(keyframe.timeMs);
                const keyY = y + this.rowHeight / 2;
                if (track.type === 'event' && track.eventKind !== 'number') {
                    context.fillStyle = track.eventKind === 'color' ? keyframe.value
                        : track.eventKind === 'boolean' && !keyframe.value ? colors.muted : track.color;
                    context.strokeStyle = this.selection.hasKeyframe(ref) ? '#ffffff' : colors.border;
                    context.lineWidth = this.selection.hasKeyframe(ref) ? 2 : 1;
                    context.beginPath();
                    if (track.eventKind === 'color') context.rect(keyX - 5, keyY - 5, 10, 10);
                    else context.arc(keyX, keyY, 5, 0, Math.PI * 2);
                    context.fill();
                    context.stroke();
                } else {
                    this.drawDiamond(context, keyX, keyY, this.selection.hasKeyframe(ref), track.color, track.locked);
                }
            });
            context.globalAlpha = 1;
        });

        context.fillStyle = colors.text;
        context.fillText('Tracks', 12, 15);
        context.fillStyle = 'rgba(10,132,255,.25)';
        context.fillRect(rangeStartX, 27, Math.max(2, rangeEndX - rangeStartX), 9);
        context.fillStyle = colors.accent;
        context.fillRect(rangeStartX - 3, 24, 6, 15);
        context.fillRect(rangeEndX - 3, 24, 6, 15);
        context.fillStyle = 'rgba(255,69,58,.24)';
        context.fillRect(recordStartX, 44, Math.max(2, recordEndX - recordStartX), 4);
        context.fillStyle = '#ff453a';
        context.fillRect(recordStartX - 2, 40, 4, 12);
        context.fillRect(recordEndX - 2, 40, 4, 12);

        clip.markers.forEach((marker) => {
            const x = this.timeToX(marker.timeMs);
            const rowIndex = marker.trackId
                ? this.visibleTracks.findIndex((track) => track.id === marker.trackId)
                : -1;
            const y = rowIndex >= 0 ? this.rulerHeight + rowIndex * this.rowHeight + 2 : 0;
            context.fillStyle = marker.color;
            context.beginPath();
            context.moveTo(x - 5, y);
            context.lineTo(x + 5, y);
            context.lineTo(x, y + 9);
            context.closePath();
            context.fill();
            if (this.selection.markerId === marker.id || this.pixelsPerSecond > 150) {
                context.fillText(marker.name, x + 6, y + 7);
            }
        });

        context.strokeStyle = colors.border;
        context.beginPath();
        context.moveTo(this.labelWidth + 0.5, 0);
        context.lineTo(this.labelWidth + 0.5, logicalHeight);
        context.stroke();

        const playheadX = this.timeToX(this.playback.currentTimeMs);
        context.strokeStyle = '#ff453a';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(playheadX, 0);
        context.lineTo(playheadX, logicalHeight);
        context.stroke();
        context.fillStyle = '#ff453a';
        context.beginPath();
        context.moveTo(playheadX - 5, 0);
        context.lineTo(playheadX + 5, 0);
        context.lineTo(playheadX, 8);
        context.closePath();
        context.fill();

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
