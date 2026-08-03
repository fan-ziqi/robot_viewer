const SCHEMA_VERSION = 2;
const DEFAULT_DURATION_MS = 10000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const TRACK_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a'];

export function createId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeHandle(handle, fallback) {
    return {
        dxMs: Number.isFinite(handle?.dxMs) ? handle.dxMs : fallback.dxMs,
        dy: Number.isFinite(handle?.dy) ? handle.dy : fallback.dy
    };
}

export class AnimationStore {
    constructor() {
        this.listeners = new Set();
        this.history = { past: [], future: [], limit: 100 };
        this.transaction = null;
        this.restoring = false;
        this.project = this.createProject('Robot', []);
    }

    createTrack(jointName, index = 0) {
        return {
            id: createId('track'),
            type: 'joint',
            jointName,
            name: jointName,
            color: TRACK_COLORS[index % TRACK_COLORS.length],
            muted: false,
            locked: false,
            visible: true,
            recordArmed: false,
            keyframes: []
        };
    }

    createClip(name, jointNames, durationMs = DEFAULT_DURATION_MS) {
        const id = createId('clip');
        return {
            id,
            name,
            durationMs,
            fps: 30,
            loop: true,
            playRange: { startMs: 0, endMs: durationMs },
            recordRange: { startMs: 0, endMs: durationMs },
            markers: [],
            tracks: jointNames.map((jointName, index) => this.createTrack(jointName, index))
        };
    }

    createProject(robotName, jointNames) {
        const clip = this.createClip('Animation 1', jointNames);
        return {
            schemaVersion: SCHEMA_VERSION,
            robot: { name: robotName || 'Robot', jointNames: [...jointNames] },
            settings: { snapToFrames: true },
            mediaAssets: [],
            poseAssets: [],
            inputMappings: [],
            activeClipId: clip.id,
            clips: [clip]
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(type, detail = {}) {
        const event = {
            type,
            project: this.project,
            canUndo: this.canUndo,
            canRedo: this.canRedo,
            ...detail
        };
        this.listeners.forEach((listener) => listener(event));
    }

    get activeClip() {
        return this.project.clips.find((clip) => clip.id === this.project.activeClipId)
            || this.project.clips[0];
    }

    get canUndo() {
        return this.history.past.length > 0;
    }

    get canRedo() {
        return this.history.future.length > 0;
    }

    snapshot() {
        return JSON.stringify(this.project);
    }

    recordHistory(label, before) {
        if (this.restoring || this.transaction || before === this.snapshot()) return;
        this.history.past.push({ label, snapshot: before });
        if (this.history.past.length > this.history.limit) this.history.past.shift();
        this.history.future = [];
    }

    mutate(label, type, callback, detail = {}) {
        const before = this.snapshot();
        const result = callback();
        this.recordHistory(label, before);
        this.emit(type, { label, ...detail });
        return result;
    }

    beginTransaction(label = 'Edit animation') {
        if (!this.transaction) this.transaction = { label, snapshot: this.snapshot() };
    }

    endTransaction(type = 'projectChanged') {
        if (!this.transaction) return;
        const transaction = this.transaction;
        this.transaction = null;
        this.recordHistory(transaction.label, transaction.snapshot);
        this.emit(type, { label: transaction.label });
    }

    cancelTransaction() {
        if (!this.transaction) return;
        this.project = JSON.parse(this.transaction.snapshot);
        this.transaction = null;
        this.emit('projectChanged');
    }

    undo() {
        const entry = this.history.past.pop();
        if (!entry) return false;
        this.history.future.push({ label: entry.label, snapshot: this.snapshot() });
        this.restoring = true;
        this.project = JSON.parse(entry.snapshot);
        this.restoring = false;
        this.emit('historyRestored', { label: entry.label, direction: 'undo' });
        return true;
    }

    redo() {
        const entry = this.history.future.pop();
        if (!entry) return false;
        this.history.past.push({ label: entry.label, snapshot: this.snapshot() });
        this.restoring = true;
        this.project = JSON.parse(entry.snapshot);
        this.restoring = false;
        this.emit('historyRestored', { label: entry.label, direction: 'redo' });
        return true;
    }

    setModel(model, robotName = 'Robot') {
        const jointNames = [];
        const jointDefinitions = {};
        model?.joints?.forEach((joint, jointName) => {
            if (joint.type !== 'fixed') {
                jointNames.push(jointName);
                jointDefinitions[jointName] = {
                    lower: Number.isFinite(joint.limits?.lower) ? joint.limits.lower : -Math.PI,
                    upper: Number.isFinite(joint.limits?.upper) ? joint.limits.upper : Math.PI,
                    velocity: Number.isFinite(joint.limits?.velocity) ? joint.limits.velocity : null
                };
            }
        });
        this.project = this.createProject(robotName, jointNames);
        this.project.robot.joints = jointDefinitions;
        this.activeClip.tracks.forEach((track) => {
            track.valueRange = clone(jointDefinitions[track.jointName]);
        });
        this.history.past = [];
        this.history.future = [];
        this.emit('projectReset');
    }

    frameDuration(clip = this.activeClip) {
        return 1000 / (clip?.fps || 30);
    }

    snapTime(timeMs, clip = this.activeClip, force = false) {
        const clamped = Math.max(0, Math.min(clip?.durationMs || 0, timeMs));
        if (!force && !this.project.settings.snapToFrames) return Math.round(clamped);
        const frame = this.frameDuration(clip);
        const snapped = Math.round(clamped / frame) * frame;
        return Math.max(0, Math.min(clip.durationMs, Math.round(snapped * 1000) / 1000));
    }

    setSnapToFrames(enabled) {
        this.mutate('Change frame snapping', 'settingsChanged', () => {
            this.project.settings.snapToFrames = Boolean(enabled);
        });
    }

    setActiveClip(clipId) {
        if (!this.project.clips.some((clip) => clip.id === clipId)) return false;
        this.project.activeClipId = clipId;
        this.emit('activeClipChanged', { clip: this.activeClip });
        return true;
    }

    createAnimation(name = `Animation ${this.project.clips.length + 1}`) {
        return this.mutate('Create animation', 'clipCreated', () => {
            const clip = this.createClip(name, this.project.robot.jointNames || []);
            clip.tracks.forEach((track) => {
                track.valueRange = clone(this.project.robot.joints?.[track.jointName] || {
                    lower: -Math.PI, upper: Math.PI, velocity: null
                });
            });
            this.project.clips.push(clip);
            this.project.activeClipId = clip.id;
            return clip;
        });
    }

    duplicateAnimation(clipId = this.activeClip?.id) {
        const source = this.project.clips.find((clip) => clip.id === clipId);
        if (!source) return null;
        return this.mutate('Duplicate animation', 'clipCreated', () => {
            const duplicate = clone(source);
            duplicate.id = createId('clip');
            duplicate.name = `${source.name} Copy`;
            const trackIdMap = new Map();
            duplicate.tracks.forEach((track) => {
                const oldTrackId = track.id;
                track.id = createId('track');
                trackIdMap.set(oldTrackId, track.id);
                track.keyframes.forEach((keyframe) => { keyframe.id = createId('key'); });
            });
            duplicate.markers.forEach((marker) => {
                marker.id = createId('marker');
                if (marker.trackId) marker.trackId = trackIdMap.get(marker.trackId) || null;
            });
            this.project.clips.push(duplicate);
            this.project.activeClipId = duplicate.id;
            return duplicate;
        });
    }

    deleteAnimation(clipId = this.activeClip?.id) {
        if (this.project.clips.length <= 1) return false;
        return this.mutate('Delete animation', 'clipDeleted', () => {
            const index = this.project.clips.findIndex((clip) => clip.id === clipId);
            if (index < 0) return false;
            this.project.clips.splice(index, 1);
            this.project.activeClipId = this.project.clips[Math.min(index, this.project.clips.length - 1)].id;
            return true;
        });
    }

    renameAnimation(name) {
        const trimmed = name?.trim();
        if (!trimmed || !this.activeClip) return false;
        return this.mutate('Rename animation', 'clipChanged', () => {
            this.activeClip.name = trimmed;
            return true;
        });
    }

    setDuration(durationMs) {
        const clip = this.activeClip;
        if (!clip || !Number.isFinite(durationMs)) return;
        this.mutate('Change animation duration', 'clipChanged', () => {
            const oldDuration = clip.durationMs;
            clip.durationMs = Math.max(100, Math.min(MAX_DURATION_MS, Math.round(durationMs)));
            clip.tracks.forEach((track) => {
                track.keyframes = track.keyframes.filter((keyframe) => keyframe.timeMs <= clip.durationMs);
            });
            clip.markers = clip.markers.filter((marker) => marker.timeMs <= clip.durationMs);
            clip.playRange.endMs = oldDuration === clip.playRange.endMs
                ? clip.durationMs
                : Math.min(clip.playRange.endMs, clip.durationMs);
            clip.playRange.startMs = Math.min(clip.playRange.startMs, clip.playRange.endMs);
            clip.recordRange ||= { startMs: 0, endMs: oldDuration };
            clip.recordRange.endMs = oldDuration === clip.recordRange.endMs
                ? clip.durationMs
                : Math.min(clip.recordRange.endMs, clip.durationMs);
            clip.recordRange.startMs = Math.min(clip.recordRange.startMs, clip.recordRange.endMs);
        }, { clip });
    }

    setLoop(loop) {
        if (!this.activeClip) return;
        this.mutate('Toggle animation loop', 'clipChanged', () => {
            this.activeClip.loop = Boolean(loop);
        }, { clip: this.activeClip });
    }

    setPlayRange(startMs, endMs) {
        const clip = this.activeClip;
        if (!clip) return;
        const minimum = this.frameDuration(clip);
        let start = this.snapTime(startMs, clip);
        let end = this.snapTime(endMs, clip);
        if (end - start < minimum) {
            if (start !== clip.playRange.startMs) start = Math.max(0, end - minimum);
            else end = Math.min(clip.durationMs, start + minimum);
        }
        clip.playRange = { startMs: start, endMs: end };
        this.emit('playRangeChanged', { playRange: clip.playRange });
    }

    setRecordRange(startMs, endMs) {
        const clip = this.activeClip;
        if (!clip) return;
        const minimum = this.frameDuration(clip);
        let start = this.snapTime(startMs, clip);
        let end = this.snapTime(endMs, clip);
        if (end - start < minimum) {
            if (start !== clip.recordRange.startMs) start = Math.max(0, end - minimum);
            else end = Math.min(clip.durationMs, start + minimum);
        }
        clip.recordRange = { startMs: start, endMs: end };
        this.emit('recordRangeChanged', { recordRange: clip.recordRange });
    }

    getTrack(jointName) {
        return this.activeClip?.tracks.find((track) => track.type === 'joint' && track.jointName === jointName) || null;
    }

    getTrackById(trackId) {
        return this.activeClip?.tracks.find((track) => track.id === trackId) || null;
    }

    getKeyframe(ref) {
        const track = this.getTrackById(ref?.trackId);
        const keyframe = track?.keyframes.find((item) => item.id === ref?.keyframeId);
        return track && keyframe ? { track, keyframe } : null;
    }

    clampTrackValue(track, value) {
        const lower = Number.isFinite(track?.valueRange?.lower) ? track.valueRange.lower : -Infinity;
        const upper = Number.isFinite(track?.valueRange?.upper) ? track.valueRange.upper : Infinity;
        return Math.max(lower, Math.min(upper, value));
    }

    setTrackProperty(trackId, property, value) {
        const track = this.getTrackById(trackId);
        if (!track || !['muted', 'locked', 'visible', 'recordArmed', 'name', 'color'].includes(property)) return;
        this.mutate('Change track', 'trackChanged', () => {
            track[property] = value;
        }, { track });
    }

    normalizeAutoHandles(track) {
        if (track.type !== 'joint' && !(track.type === 'event' && track.eventKind === 'number')) return;
        track.keyframes.forEach((keyframe, index, keyframes) => {
            if (keyframe.interpolation !== 'auto') return;
            const previous = keyframes[index - 1];
            const next = keyframes[index + 1];
            const leftSpan = previous ? keyframe.timeMs - previous.timeMs : 0;
            const rightSpan = next ? next.timeMs - keyframe.timeMs : 0;
            let slope = 0;
            if (previous && next && next.timeMs !== previous.timeMs) {
                slope = (next.value - previous.value) / (next.timeMs - previous.timeMs);
            } else if (next && rightSpan) {
                slope = (next.value - keyframe.value) / rightSpan;
            } else if (previous && leftSpan) {
                slope = (keyframe.value - previous.value) / leftSpan;
            }
            const inDx = -leftSpan / 3;
            const outDx = rightSpan / 3;
            keyframe.inHandle = { dxMs: inDx, dy: slope * inDx };
            keyframe.outHandle = { dxMs: outDx, dy: slope * outDx };
        });
    }

    upsertKeyframe(jointName, timeMs, value, options = {}) {
        const track = this.getTrack(jointName);
        const clip = this.activeClip;
        if (!track || track.locked || !clip || !Number.isFinite(value)) return null;
        const safeTime = this.snapTime(timeMs, clip);
        const tolerance = this.frameDuration(clip) * 0.25;
        const existing = track.keyframes.find((keyframe) => Math.abs(keyframe.timeMs - safeTime) <= tolerance);

        return this.mutate(existing ? 'Edit keyframe' : 'Add keyframe', existing ? 'keyframeChanged' : 'keyframeAdded', () => {
            if (existing) {
                existing.value = this.clampTrackValue(track, value);
                if (options.interpolation) existing.interpolation = options.interpolation;
                this.normalizeAutoHandles(track);
                return existing;
            }
            const frame = this.frameDuration(clip);
            const keyframe = {
                id: createId('key'),
                timeMs: safeTime,
                value: this.clampTrackValue(track, value),
                interpolation: options.interpolation || 'auto',
                inHandle: normalizeHandle(options.inHandle, { dxMs: -frame * 3, dy: 0 }),
                outHandle: normalizeHandle(options.outHandle, { dxMs: frame * 3, dy: 0 })
            };
            track.keyframes.push(keyframe);
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            this.normalizeAutoHandles(track);
            return keyframe;
        }, { track });
    }

    updateKeyframe(ref, changes, label = 'Edit keyframe') {
        const item = this.getKeyframe(ref);
        if (!item || item.track.locked) return null;
        return this.mutate(label, 'keyframeChanged', () => {
            const { track, keyframe } = item;
            if (Number.isFinite(changes.timeMs)) keyframe.timeMs = this.snapTime(changes.timeMs);
            if (Object.prototype.hasOwnProperty.call(changes, 'value')) {
                if ((track.type === 'joint' || track.eventKind === 'number') && Number.isFinite(changes.value)) {
                    keyframe.value = this.clampTrackValue(track, changes.value);
                } else if (track.type === 'event' && track.eventKind === 'boolean') {
                    keyframe.value = Boolean(changes.value);
                } else if (track.type === 'event' && track.eventKind === 'color'
                    && /^#[0-9a-f]{6}$/i.test(changes.value)) {
                    keyframe.value = changes.value;
                }
            }
            if (changes.interpolation) keyframe.interpolation = changes.interpolation;
            if (changes.inHandle) keyframe.inHandle = normalizeHandle(changes.inHandle, keyframe.inHandle);
            if (changes.outHandle) keyframe.outHandle = normalizeHandle(changes.outHandle, keyframe.outHandle);
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            if (changes.interpolation === 'auto' || keyframe.interpolation === 'auto') this.normalizeAutoHandles(track);
            return keyframe;
        }, { track: item.track, keyframe: item.keyframe });
    }

    updateHandle(ref, side, handle) {
        const item = this.getKeyframe(ref);
        if (!item || item.track.locked || !['in', 'out'].includes(side)) return null;
        const { track, keyframe } = item;
        const property = side === 'in' ? 'inHandle' : 'outHandle';
        const oppositeProperty = side === 'in' ? 'outHandle' : 'inHandle';
        const normalized = normalizeHandle(handle, keyframe[property]);
        normalized.dxMs = side === 'in' ? Math.min(0, normalized.dxMs) : Math.max(0, normalized.dxMs);
        keyframe[property] = normalized;

        if (['auto', 'smooth'].includes(keyframe.interpolation)) {
            const opposite = keyframe[oppositeProperty];
            const sourceLength = Math.hypot(normalized.dxMs, normalized.dy) || 1;
            const oppositeLength = Math.hypot(opposite.dxMs, opposite.dy) || sourceLength;
            keyframe[oppositeProperty] = {
                dxMs: -normalized.dxMs * oppositeLength / sourceLength,
                dy: -normalized.dy * oppositeLength / sourceLength
            };
            if (keyframe.interpolation === 'auto') keyframe.interpolation = 'smooth';
        }
        this.emit('keyframeChanged', { track, keyframe });
        return keyframe;
    }

    moveKeyframesFrom(originals, deltaTimeMs, deltaValue = 0, valueByTrack = false) {
        const clip = this.activeClip;
        if (!clip || originals.length === 0) return;
        const minimumTime = Math.min(...originals.map((item) => item.timeMs));
        const maximumTime = Math.max(...originals.map((item) => item.timeMs));
        const clampedDelta = Math.max(-minimumTime, Math.min(clip.durationMs - maximumTime, deltaTimeMs));
        const snappedAnchor = this.snapTime(minimumTime + clampedDelta, clip);
        const snappedDelta = snappedAnchor - minimumTime;

        originals.forEach((original) => {
            const item = this.getKeyframe(original);
            if (!item || item.track.locked) return;
            item.keyframe.timeMs = Math.max(0, Math.min(clip.durationMs, original.timeMs + snappedDelta));
            const perTrackDelta = valueByTrack && typeof deltaValue === 'object'
                ? deltaValue[original.trackId] || 0
                : deltaValue;
            if (Number.isFinite(original.value) && Number.isFinite(perTrackDelta)) {
                item.keyframe.value = this.clampTrackValue(item.track, original.value + perTrackDelta);
            }
        });
        clip.tracks.forEach((track) => {
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            this.normalizeAutoHandles(track);
        });
        this.emit('keyframesChanged');
    }

    removeKeyframes(refs) {
        if (!refs?.length) return false;
        return this.mutate('Delete keyframes', 'keyframesRemoved', () => {
            let removed = false;
            refs.forEach((ref) => {
                const track = this.getTrackById(ref.trackId);
                if (!track || track.locked) return;
                const index = track.keyframes.findIndex((keyframe) => keyframe.id === ref.keyframeId);
                if (index >= 0) {
                    track.keyframes.splice(index, 1);
                    removed = true;
                }
            });
            this.activeClip.tracks.forEach((track) => this.normalizeAutoHandles(track));
            return removed;
        });
    }

    removeTracks(trackIds) {
        if (!trackIds?.length || !this.activeClip) return false;
        return this.mutate('Delete tracks', 'tracksRemoved', () => {
            let changed = false;
            trackIds.forEach((trackId) => {
                const index = this.activeClip.tracks.findIndex((track) => track.id === trackId);
                if (index < 0) return;
                const track = this.activeClip.tracks[index];
                if (track.locked) return;
                if (track.type === 'media' || track.type === 'event') this.activeClip.tracks.splice(index, 1);
                else track.keyframes = [];
                changed = true;
            });
            return changed;
        });
    }

    copyKeyframes(refs) {
        const items = refs.map((ref) => this.getKeyframe(ref)).filter(Boolean);
        if (!items.length) return null;
        const baseTime = Math.min(...items.map(({ keyframe }) => keyframe.timeMs));
        const grouped = new Map();
        items.forEach(({ track, keyframe }) => {
            if (!grouped.has(track.id)) {
                grouped.set(track.id, {
                    sourceTrackId: track.id,
                    type: track.type,
                    jointName: track.jointName,
                    assetId: track.assetId,
                    eventKind: track.eventKind,
                    name: track.name,
                    keyframes: []
                });
            }
            grouped.get(track.id).keyframes.push({ ...clone(keyframe), offsetMs: keyframe.timeMs - baseTime });
        });
        return { baseTime, tracks: [...grouped.values()] };
    }

    pasteKeyframes(payload, atTimeMs, targetTrackIds = []) {
        if (!payload?.tracks?.length) return [];
        return this.mutate('Paste keyframes', 'keyframesAdded', () => {
            const created = [];
            const singleSource = payload.tracks.length === 1;
            let destinations = [];
            if (singleSource && targetTrackIds.length) {
                const source = payload.tracks[0];
                destinations = targetTrackIds.map((trackId) => ({ track: this.getTrackById(trackId), source }))
                    .filter(({ track }) => track && track.type === source.type
                        && (track.type !== 'event' || track.eventKind === source.eventKind));
            } else {
                destinations = payload.tracks.map((source) => ({
                    track: source.type === 'media'
                        ? this.getTrackById(source.sourceTrackId)
                            || this.activeClip.tracks.find((track) => track.type === 'media' && track.assetId === source.assetId)
                        : source.type === 'event'
                            ? this.getTrackById(source.sourceTrackId)
                                || this.activeClip.tracks.find((track) => track.type === 'event'
                                    && track.eventKind === source.eventKind && track.name === source.name)
                            : this.getTrack(source.jointName),
                    source
                }));
            }
            destinations.forEach(({ track, source }) => {
                if (!track || track.locked) return;
                source.keyframes.forEach((sourceKeyframe) => {
                    const timeMs = this.snapTime(atTimeMs + sourceKeyframe.offsetMs);
                    const existing = track.keyframes.find((keyframe) => Math.abs(keyframe.timeMs - timeMs) < 1);
                    const keyframe = {
                        ...clone(sourceKeyframe),
                        id: existing?.id || createId('key'),
                        timeMs
                    };
                    delete keyframe.offsetMs;
                    if (existing) Object.assign(existing, keyframe);
                    else track.keyframes.push(keyframe);
                    created.push({ trackId: track.id, keyframeId: keyframe.id });
                });
                track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
                this.normalizeAutoHandles(track);
            });
            return created;
        });
    }

    addMarker(timeMs, name = '', trackId = null) {
        const clip = this.activeClip;
        if (!clip) return null;
        return this.mutate('Add marker', 'markerAdded', () => {
            const marker = {
                id: createId('marker'),
                timeMs: this.snapTime(timeMs),
                name: name || `Marker ${clip.markers.length + 1}`,
                color: '#ffd60a',
                trackId: this.getTrackById(trackId) ? trackId : null
            };
            clip.markers.push(marker);
            clip.markers.sort((a, b) => a.timeMs - b.timeMs);
            return marker;
        });
    }

    addMediaAsset(asset) {
        if (!asset?.dataUrl || !asset?.name) return null;
        return this.mutate('Import media', 'mediaAssetAdded', () => {
            const mediaAsset = {
                id: createId('media'),
                name: asset.name,
                kind: asset.kind === 'video' ? 'video' : 'audio',
                mime: asset.mime || '',
                durationMs: Math.max(0, asset.durationMs || 0),
                dataUrl: asset.dataUrl,
                waveform: Array.isArray(asset.waveform) ? asset.waveform.slice(0, 512) : []
            };
            this.project.mediaAssets ||= [];
            this.project.mediaAssets.push(mediaAsset);
            return mediaAsset;
        });
    }

    addMediaTrack(assetId, timeMs = 0) {
        const asset = this.project.mediaAssets?.find((item) => item.id === assetId);
        if (!asset || !this.activeClip) return null;
        return this.mutate('Add media track', 'trackAdded', () => {
            const track = {
                id: createId('track'),
                type: 'media',
                assetId,
                name: asset.name,
                color: asset.kind === 'video' ? '#bf5af2' : '#30d158',
                muted: false,
                locked: false,
                visible: true,
                recordArmed: false,
                keyframes: [{ id: createId('key'), timeMs: this.snapTime(timeMs) }]
            };
            this.activeClip.tracks.push(track);
            return track;
        });
    }

    addMediaKeyframe(trackId, timeMs) {
        const track = this.getTrackById(trackId);
        if (!track || track.type !== 'media' || track.locked) return null;
        const safeTime = this.snapTime(timeMs);
        const existing = track.keyframes.find((keyframe) => Math.abs(keyframe.timeMs - safeTime) < 1);
        if (existing) return existing;
        return this.mutate('Add media keyframe', 'keyframeAdded', () => {
            const keyframe = { id: createId('key'), timeMs: safeTime };
            track.keyframes.push(keyframe);
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            return keyframe;
        }, { track });
    }

    addEventTrack(name, eventKind = 'trigger') {
        const supportedKinds = ['trigger', 'boolean', 'number', 'color'];
        const kind = supportedKinds.includes(eventKind) ? eventKind : 'trigger';
        return this.mutate('Add event track', 'trackAdded', () => {
            const track = {
                id: createId('track'),
                type: 'event',
                eventKind: kind,
                name: name?.trim() || `Event ${this.activeClip.tracks.filter((item) => item.type === 'event').length + 1}`,
                color: kind === 'color' ? '#bf5af2' : kind === 'boolean' ? '#30d158' : kind === 'number' ? '#64d2ff' : '#ff9f0a',
                muted: false,
                locked: false,
                visible: true,
                recordArmed: false,
                valueRange: kind === 'number' ? { lower: 0, upper: 1, velocity: null } : undefined,
                keyframes: []
            };
            this.activeClip.tracks.push(track);
            return track;
        });
    }

    addEventKeyframe(trackId, timeMs, value = true) {
        const track = this.getTrackById(trackId);
        if (!track || track.type !== 'event' || track.locked) return null;
        const safeTime = this.snapTime(timeMs);
        const tolerance = this.frameDuration() * 0.25;
        const existing = track.keyframes.find((keyframe) => Math.abs(keyframe.timeMs - safeTime) <= tolerance);
        return this.mutate(existing ? 'Edit event keyframe' : 'Add event keyframe', existing ? 'keyframeChanged' : 'keyframeAdded', () => {
            let safeValue = value;
            if (track.eventKind === 'number') safeValue = this.clampTrackValue(track, Number(value) || 0);
            else if (track.eventKind === 'boolean') safeValue = Boolean(value);
            else if (track.eventKind === 'color') safeValue = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
            else safeValue = true;
            if (existing) {
                existing.value = safeValue;
                this.normalizeAutoHandles(track);
                return existing;
            }
            const frame = this.frameDuration();
            const keyframe = {
                id: createId('key'),
                timeMs: safeTime,
                value: safeValue,
                interpolation: track.eventKind === 'number' ? 'auto' : 'step',
                inHandle: { dxMs: -frame * 3, dy: 0 },
                outHandle: { dxMs: frame * 3, dy: 0 }
            };
            track.keyframes.push(keyframe);
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            this.normalizeAutoHandles(track);
            return keyframe;
        }, { track });
    }

    generateTrackKeyframes(trackId, samples, { startMs = 0, endMs = this.activeClip?.durationMs, replace = true } = {}) {
        const track = this.getTrackById(trackId);
        const numericTrack = track?.type === 'joint'
            || (track?.type === 'event' && track.eventKind === 'number');
        if (!numericTrack || track.locked || !Array.isArray(samples) || !samples.length) return [];
        const rangeStart = Math.max(0, Math.min(startMs, endMs));
        const rangeEnd = Math.min(this.activeClip.durationMs, Math.max(startMs, endMs));
        return this.mutate('Generate keyframes', 'keyframesAdded', () => {
            if (replace) {
                track.keyframes = track.keyframes.filter((keyframe) => (
                    keyframe.timeMs < rangeStart || keyframe.timeMs > rangeEnd
                ));
            }
            const generatedByTime = new Map();
            samples.forEach((sample) => {
                if (!Number.isFinite(sample?.timeMs) || !Number.isFinite(sample?.value)) return;
                const timeMs = this.snapTime(sample.timeMs);
                if (timeMs < rangeStart || timeMs > rangeEnd) return;
                generatedByTime.set(timeMs, this.clampTrackValue(track, sample.value));
            });
            const refs = [];
            generatedByTime.forEach((value, timeMs) => {
                let keyframe = track.keyframes.find((item) => Math.abs(item.timeMs - timeMs) < 1);
                if (keyframe) {
                    keyframe.value = value;
                    keyframe.interpolation = 'auto';
                } else {
                    const frame = this.frameDuration();
                    keyframe = {
                        id: createId('key'),
                        timeMs,
                        value,
                        interpolation: 'auto',
                        inHandle: { dxMs: -frame * 3, dy: 0 },
                        outHandle: { dxMs: frame * 3, dy: 0 }
                    };
                    track.keyframes.push(keyframe);
                }
                refs.push({ trackId: track.id, keyframeId: keyframe.id });
            });
            track.keyframes.sort((a, b) => a.timeMs - b.timeMs);
            this.normalizeAutoHandles(track);
            return refs;
        }, { track });
    }

    clearTrackRange(trackIds, startMs, endMs) {
        const ids = new Set(trackIds || []);
        const start = Math.min(startMs, endMs);
        const end = Math.max(startMs, endMs);
        this.activeClip.tracks.forEach((track) => {
            if (!ids.has(track.id) || track.locked) return;
            track.keyframes = track.keyframes.filter((keyframe) => keyframe.timeMs < start || keyframe.timeMs > end);
            this.normalizeAutoHandles(track);
        });
        this.emit('keyframesRemoved');
    }

    savePose(name, values) {
        const poseValues = {};
        Object.entries(values || {}).forEach(([jointName, value]) => {
            if (this.project.robot.jointNames.includes(jointName) && Number.isFinite(value)) poseValues[jointName] = value;
        });
        if (!Object.keys(poseValues).length) return null;
        return this.mutate('Save pose', 'poseAdded', () => {
            const pose = { id: createId('pose'), name: name?.trim() || `Pose ${this.project.poseAssets.length + 1}`, values: poseValues };
            this.project.poseAssets.push(pose);
            return pose;
        });
    }

    deletePose(poseId) {
        const index = this.project.poseAssets?.findIndex((pose) => pose.id === poseId) ?? -1;
        if (index < 0) return false;
        return this.mutate('Delete pose', 'poseRemoved', () => {
            this.project.poseAssets.splice(index, 1);
            return true;
        });
    }

    moveMarker(markerId, timeMs) {
        const marker = this.activeClip?.markers.find((item) => item.id === markerId);
        if (!marker) return;
        marker.timeMs = this.snapTime(timeMs);
        this.activeClip.markers.sort((a, b) => a.timeMs - b.timeMs);
        this.emit('markerChanged', { marker });
    }

    removeMarker(markerId) {
        const clip = this.activeClip;
        const index = clip?.markers.findIndex((marker) => marker.id === markerId) ?? -1;
        if (index < 0) return false;
        return this.mutate('Delete marker', 'markerRemoved', () => {
            clip.markers.splice(index, 1);
            return true;
        });
    }

    getAllKeyframeTimes() {
        const times = new Set();
        this.activeClip?.tracks.forEach((track) => track.keyframes.forEach((keyframe) => times.add(keyframe.timeMs)));
        return [...times].sort((a, b) => a - b);
    }

    serialize() {
        return JSON.stringify(this.project, null, 2);
    }

    migrate(data) {
        if (data?.schemaVersion !== 1) return data;
        data.schemaVersion = SCHEMA_VERSION;
        data.settings = { snapToFrames: true };
        data.mediaAssets = [];
        const jointNames = [...new Set(data.clips.flatMap((clip) => clip.tracks.map((track) => track.jointName)))];
        data.robot ||= { name: 'Robot' };
        data.robot.jointNames = jointNames;
        data.clips.forEach((clip) => {
            clip.playRange = { startMs: 0, endMs: clip.durationMs };
            clip.markers = [];
            clip.tracks.forEach((track, index) => {
                Object.assign(track, {
                    type: 'joint',
                    name: track.jointName,
                    color: TRACK_COLORS[index % TRACK_COLORS.length],
                    muted: false,
                    locked: false,
                    visible: true
                });
                track.keyframes.forEach((keyframe) => {
                    if (keyframe.interpolation === 'bezier') keyframe.interpolation = 'auto';
                });
            });
        });
        return data;
    }

    load(serialized) {
        let data = typeof serialized === 'string' ? JSON.parse(serialized) : clone(serialized);
        data = this.migrate(data);
        if (!data || data.schemaVersion !== SCHEMA_VERSION
            || !Array.isArray(data.clips) || data.clips.length === 0) {
            throw new Error('Unsupported or invalid animation file');
        }

        data.robot ||= { name: 'Robot', jointNames: [] };
        data.robot.jointNames ||= [];
        data.settings ||= { snapToFrames: true };
        data.mediaAssets = Array.isArray(data.mediaAssets) ? data.mediaAssets : [];
        data.poseAssets = Array.isArray(data.poseAssets) ? data.poseAssets : [];
        data.inputMappings = (Array.isArray(data.inputMappings) ? data.inputMappings : [])
            .filter((mapping) => mapping && typeof mapping.trackId === 'string')
            .map((mapping) => {
                const axis = Number.isInteger(mapping.axis) && mapping.axis >= 0 && mapping.axis < 32
                    ? mapping.axis : null;
                const keys = Array.isArray(mapping.keys) && mapping.keys.length === 2
                    ? mapping.keys.map((key) => String(key).toLowerCase().slice(0, 24)) : null;
                return {
                    trackId: mapping.trackId,
                    axis,
                    ...(keys ? { keys } : {}),
                    invert: Boolean(mapping.invert),
                    smoothing: Math.max(0, Math.min(0.95, Number(mapping.smoothing) || 0))
                };
            }).filter((mapping) => Number.isInteger(mapping.axis) || mapping.keys);
        data.clips.forEach((clip) => {
            if (!Array.isArray(clip.tracks) || !Number.isFinite(clip.durationMs)) throw new Error('Invalid animation clip');
            clip.id ||= createId('clip');
            clip.name ||= 'Animation';
            clip.durationMs = Math.max(100, Math.min(MAX_DURATION_MS, Math.round(clip.durationMs)));
            clip.fps = Number.isFinite(clip.fps) ? clip.fps : 30;
            clip.loop = Boolean(clip.loop);
            clip.playRange ||= { startMs: 0, endMs: clip.durationMs };
            clip.playRange.startMs = Math.max(0, Math.min(clip.durationMs, clip.playRange.startMs));
            clip.playRange.endMs = Math.max(clip.playRange.startMs, Math.min(clip.durationMs, clip.playRange.endMs));
            clip.recordRange ||= { startMs: clip.playRange.startMs, endMs: clip.playRange.endMs };
            clip.recordRange.startMs = Math.max(0, Math.min(clip.durationMs, clip.recordRange.startMs));
            clip.recordRange.endMs = Math.max(clip.recordRange.startMs, Math.min(clip.durationMs, clip.recordRange.endMs));
            clip.markers = Array.isArray(clip.markers) ? clip.markers : [];
            clip.markers = clip.markers.map((marker) => ({
                id: marker.id || createId('marker'),
                timeMs: Math.max(0, Math.min(clip.durationMs, marker.timeMs || 0)),
                name: marker.name || 'Marker',
                color: marker.color || '#ffd60a',
                trackId: typeof marker.trackId === 'string' ? marker.trackId : null
            }));
            clip.tracks.forEach((track, trackIndex) => {
                if (!Array.isArray(track.keyframes)) throw new Error('Invalid animation track');
                track.id ||= createId('track');
                track.type = ['media', 'event'].includes(track.type) ? track.type : 'joint';
                if (track.type === 'joint' && typeof track.jointName !== 'string') throw new Error('Invalid joint track');
                if (track.type === 'media' && typeof track.assetId !== 'string') throw new Error('Invalid media track');
                if (track.type === 'event') {
                    track.eventKind = ['trigger', 'boolean', 'number', 'color'].includes(track.eventKind)
                        ? track.eventKind : 'trigger';
                }
                track.name ||= track.jointName || (track.type === 'event' ? 'Event' : 'Media');
                if (track.type === 'joint' || (track.type === 'event' && track.eventKind === 'number')) {
                    const definition = data.robot.joints?.[track.jointName] || {};
                    track.valueRange ||= {
                        lower: track.type === 'event' ? 0 : Number.isFinite(definition.lower) ? definition.lower : -Math.PI,
                        upper: track.type === 'event' ? 1 : Number.isFinite(definition.upper) ? definition.upper : Math.PI,
                        velocity: Number.isFinite(definition.velocity) ? definition.velocity : null
                    };
                }
                track.color ||= TRACK_COLORS[trackIndex % TRACK_COLORS.length];
                track.muted = Boolean(track.muted);
                track.locked = Boolean(track.locked);
                track.visible = track.visible !== false;
                track.recordArmed = Boolean(track.recordArmed);
                track.keyframes = track.keyframes
                    .filter((keyframe) => Number.isFinite(keyframe.timeMs)
                        && (track.type === 'media'
                            || (track.type === 'event' && ['trigger', 'boolean', 'color'].includes(track.eventKind))
                            || Number.isFinite(keyframe.value)))
                    .map((keyframe) => track.type === 'media' ? {
                        id: keyframe.id || createId('key'),
                        timeMs: Math.max(0, Math.min(clip.durationMs, keyframe.timeMs))
                    } : track.type === 'event' && ['trigger', 'boolean', 'color'].includes(track.eventKind) ? {
                        id: keyframe.id || createId('key'),
                        timeMs: Math.max(0, Math.min(clip.durationMs, keyframe.timeMs)),
                        value: track.eventKind === 'color'
                            ? (/^#[0-9a-f]{6}$/i.test(keyframe.value) ? keyframe.value : '#ffffff')
                            : track.eventKind === 'boolean' ? Boolean(keyframe.value) : true,
                        interpolation: 'step',
                        inHandle: { dxMs: 0, dy: 0 },
                        outHandle: { dxMs: 0, dy: 0 }
                    } : {
                        id: keyframe.id || createId('key'),
                        timeMs: Math.max(0, Math.min(clip.durationMs, keyframe.timeMs)),
                        value: keyframe.value,
                        interpolation: ['auto', 'smooth', 'broken', 'linear', 'step'].includes(keyframe.interpolation)
                            ? keyframe.interpolation : 'auto',
                        inHandle: normalizeHandle(keyframe.inHandle, { dxMs: -100, dy: 0 }),
                        outHandle: normalizeHandle(keyframe.outHandle, { dxMs: 100, dy: 0 })
                    }).sort((a, b) => a.timeMs - b.timeMs);
                this.normalizeAutoHandles(track);
            });
        });

        data.activeClipId = data.clips.some((clip) => clip.id === data.activeClipId)
            ? data.activeClipId : data.clips[0].id;
        this.project = data;
        this.history.past = [];
        this.history.future = [];
        this.emit('projectLoaded');
    }
}
