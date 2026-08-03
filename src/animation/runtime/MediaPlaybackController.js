export class MediaPlaybackController {
    constructor(store, playback, previewContainer) {
        this.store = store;
        this.playback = playback;
        this.previewContainer = previewContainer;
        this.elements = new Map();
        this.playback.subscribe((state) => this.sync(state));
        this.store.subscribe(() => this.prune());
    }

    getAsset(track) {
        return this.store.project.mediaAssets?.find((asset) => asset.id === track.assetId) || null;
    }

    ensureElement(track) {
        if (this.elements.has(track.id)) return this.elements.get(track.id);
        const asset = this.getAsset(track);
        if (!asset) return null;
        const element = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
        element.src = asset.dataUrl;
        element.preload = 'auto';
        element.playsInline = true;
        element.dataset.mediaTrackId = track.id;
        if (asset.kind === 'video') {
            element.className = 'animation-video-preview';
            element.controls = true;
            element.hidden = true;
            this.previewContainer?.appendChild(element);
        }
        this.elements.set(track.id, element);
        return element;
    }

    sync(state = {}) {
        const clip = this.store.activeClip;
        if (!clip) return;
        const currentTimeMs = state.currentTimeMs ?? this.playback.currentTimeMs;
        const playing = state.playing ?? this.playback.playing;
        const activeTrackIds = new Set();

        clip.tracks.filter((track) => track.type === 'media').forEach((track) => {
            const asset = this.getAsset(track);
            const element = this.ensureElement(track);
            if (!asset || !element) return;
            activeTrackIds.add(track.id);
            const keyframe = [...track.keyframes].reverse().find((key) => key.timeMs <= currentTimeMs);
            const offsetMs = keyframe ? currentTimeMs - keyframe.timeMs : Infinity;
            const active = keyframe && offsetMs >= 0 && offsetMs <= asset.durationMs;
            element.muted = Boolean(track.muted);
            element.hidden = asset.kind === 'video' ? !active : true;

            if (!active) {
                element.pause();
                return;
            }

            const targetTime = offsetMs / 1000;
            if (Number.isFinite(element.duration) && Math.abs(element.currentTime - targetTime) > 0.08) {
                try {
                    element.currentTime = Math.min(targetTime, element.duration || targetTime);
                } catch (_) {
                    // Metadata may not be available on the first synchronization pass.
                }
            }
            if (playing) element.play().catch(() => {});
            else element.pause();
        });

        this.elements.forEach((element, trackId) => {
            if (!activeTrackIds.has(trackId)) {
                element.pause();
                element.remove();
                this.elements.delete(trackId);
            }
        });
    }

    prune() {
        const validTrackIds = new Set(
            this.store.project.clips.flatMap((clip) => clip.tracks.filter((track) => track.type === 'media').map((track) => track.id))
        );
        this.elements.forEach((element, trackId) => {
            if (!validTrackIds.has(trackId)) {
                element.pause();
                element.remove();
                this.elements.delete(trackId);
            }
        });
    }
}
