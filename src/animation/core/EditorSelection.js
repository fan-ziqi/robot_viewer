function refKey(ref) {
    return `${ref.trackId}:${ref.keyframeId}`;
}

export class EditorSelection {
    constructor() {
        this.keyframes = new Map();
        this.trackIds = new Set();
        this.markerId = null;
        this.listeners = new Set();
        this.anchor = null;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit() {
        const state = this.getState();
        this.listeners.forEach((listener) => listener(state));
    }

    getState() {
        return {
            keyframes: this.getKeyframeRefs(),
            trackIds: [...this.trackIds],
            markerId: this.markerId
        };
    }

    getKeyframeRefs() {
        return [...this.keyframes.values()];
    }

    hasKeyframe(ref) {
        return this.keyframes.has(refKey(ref));
    }

    clear({ silent = false } = {}) {
        this.keyframes.clear();
        this.trackIds.clear();
        this.markerId = null;
        this.anchor = null;
        if (!silent) this.emit();
    }

    selectKeyframe(ref, { additive = false, toggle = false } = {}) {
        const key = refKey(ref);
        if (!additive && !toggle) this.clear({ silent: true });
        if (toggle && this.keyframes.has(key)) this.keyframes.delete(key);
        else this.keyframes.set(key, { trackId: ref.trackId, keyframeId: ref.keyframeId });
        this.trackIds.add(ref.trackId);
        this.markerId = null;
        this.anchor = ref;
        this.emit();
    }

    selectKeyframes(refs, { additive = false } = {}) {
        if (!additive) this.clear({ silent: true });
        refs.forEach((ref) => {
            this.keyframes.set(refKey(ref), { trackId: ref.trackId, keyframeId: ref.keyframeId });
            this.trackIds.add(ref.trackId);
        });
        this.markerId = null;
        this.emit();
    }

    selectTrack(trackId, { additive = false, toggle = false } = {}) {
        if (!additive && !toggle) this.clear({ silent: true });
        if (toggle && this.trackIds.has(trackId)) this.trackIds.delete(trackId);
        else this.trackIds.add(trackId);
        this.markerId = null;
        this.emit();
    }

    selectMarker(markerId) {
        this.clear({ silent: true });
        this.markerId = markerId;
        this.emit();
    }
}
