import { evaluateClip, evaluateTrack } from '../core/BezierEvaluator.js';

export class PlaybackController {
    constructor(store, poseController) {
        this.store = store;
        this.poseController = poseController;
        this.currentTimeMs = 0;
        this.playing = false;
        this.listeners = new Set();
        this.frameRequest = null;
        this.startedAt = 0;
        this.suppressedJointNames = new Set();
        this.eventListeners = new Set();
        this.rangeOverride = null;
        this.loopOverride = null;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    subscribeEvents(listener) {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    emitRuntimeEvent(detail) {
        this.eventListeners.forEach((listener) => listener(detail));
        if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
            globalThis.dispatchEvent(new CustomEvent('robot-animation-event', { detail }));
        }
    }

    dispatchEvents(fromTimeMs, toTimeMs) {
        const clip = this.store.activeClip;
        if (!clip || toTimeMs < fromTimeMs) return;
        clip.tracks.filter((track) => track.type === 'event' && !track.muted).forEach((track) => {
            if (track.eventKind === 'number') return;
            track.keyframes.forEach((keyframe) => {
                if (keyframe.timeMs <= fromTimeMs || keyframe.timeMs > toTimeMs) return;
                const detail = {
                    clipId: clip.id,
                    clipName: clip.name,
                    trackId: track.id,
                    name: track.name,
                    kind: track.eventKind,
                    timeMs: keyframe.timeMs,
                    value: keyframe.value
                };
                this.emitRuntimeEvent(detail);
            });
        });
    }

    dispatchContinuousEvents(timeMs) {
        const clip = this.store.activeClip;
        clip?.tracks.filter((track) => (
            track.type === 'event' && track.eventKind === 'number' && !track.muted
        )).forEach((track) => {
            const value = evaluateTrack(track, timeMs);
            if (!Number.isFinite(value)) return;
            this.emitRuntimeEvent({
                clipId: clip.id,
                clipName: clip.name,
                trackId: track.id,
                name: track.name,
                kind: track.eventKind,
                timeMs,
                value,
                continuous: true
            });
        });
    }

    emit() {
        const state = { currentTimeMs: this.currentTimeMs, playing: this.playing };
        this.listeners.forEach((listener) => listener(state));
    }

    activeRange(clip = this.store.activeClip) {
        return this.rangeOverride || clip?.playRange || { startMs: 0, endMs: clip?.durationMs || 0 };
    }

    seek(timeMs) {
        const clip = this.store.activeClip;
        if (!clip || !Number.isFinite(timeMs)) return;
        this.currentTimeMs = Math.max(0, Math.min(clip.durationMs, timeMs));
        const pose = evaluateClip(clip, this.currentTimeMs);
        this.suppressedJointNames.forEach((jointName) => delete pose[jointName]);
        this.poseController.applyPose(pose, { source: 'playback' });
        this.dispatchContinuousEvents(this.currentTimeMs);
        this.emit();
    }

    play() {
        const clip = this.store.activeClip;
        if (this.playing || !clip) return;
        const range = this.activeRange(clip);
        if (this.currentTimeMs < range.startMs || this.currentTimeMs >= range.endMs) {
            this.seek(range.startMs);
        }
        this.playing = true;
        this.startedAt = performance.now() - this.currentTimeMs;
        this.dispatchEvents(this.currentTimeMs - 0.001, this.currentTimeMs);
        this.emit();
        this.frameRequest = requestAnimationFrame((now) => this.tick(now));
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
        this.frameRequest = null;
        this.emit();
    }

    toggle() {
        if (this.playing) this.pause();
        else this.play();
    }

    stop() {
        this.pause();
        this.seek(this.store.activeClip?.playRange?.startMs || 0);
    }

    tick(now) {
        if (!this.playing) return;
        const clip = this.store.activeClip;
        const range = this.activeRange(clip);
        const previousTime = this.currentTimeMs;
        let time = now - this.startedAt;

        if (time >= range.endMs) {
            if (this.loopOverride ?? clip.loop) {
                const rangeDuration = Math.max(1, range.endMs - range.startMs);
                this.dispatchEvents(previousTime, range.endMs);
                time = range.startMs + ((time - range.startMs) % rangeDuration);
                this.dispatchEvents(range.startMs - 0.001, time);
                this.startedAt = now - time;
            } else {
                this.dispatchEvents(previousTime, range.endMs);
                this.seek(range.endMs);
                this.pause();
                return;
            }
        }

        if (time >= previousTime) this.dispatchEvents(previousTime, time);
        this.seek(time);
        this.frameRequest = requestAnimationFrame((nextNow) => this.tick(nextNow));
    }
}
