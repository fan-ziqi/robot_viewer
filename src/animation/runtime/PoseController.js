import { ModelLoaderFactory } from '../../loaders/ModelLoaderFactory.js';

/**
 * The single write path for robot poses.
 *
 * UI controls, viewport dragging and animation playback all go through this
 * controller so an editor can distinguish previews from committed user edits.
 */
export class PoseController {
    constructor(sceneManager = null) {
        this.sceneManager = sceneManager;
        this.model = null;
        this.listeners = new Set();
    }

    setModel(model) {
        this.model = model || null;
        this.emit({ type: 'modelChanged', model: this.model });
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    getJointValue(jointName) {
        return this.model?.joints?.get(jointName)?.currentValue ?? 0;
    }

    getPose() {
        const pose = {};
        this.model?.joints?.forEach((joint, name) => {
            if (joint.type !== 'fixed') {
                pose[name] = joint.currentValue ?? 0;
            }
        });
        return pose;
    }

    setJointValue(jointName, value, options = {}) {
        const {
            source = 'user',
            commit = false,
            ignoreLimits = false,
            applyConstraints = true,
            render = true,
            measure = true
        } = options;

        const joint = this.model?.joints?.get(jointName);
        if (!joint || joint.type === 'fixed' || !Number.isFinite(value)) {
            return null;
        }

        let appliedValue = value;
        const limitsAreIgnored = ignoreLimits || this.sceneManager?.ignoreLimits;
        if (!limitsAreIgnored && joint.type !== 'continuous' && joint.limits) {
            const lower = Number.isFinite(joint.limits.lower) ? joint.limits.lower : -Infinity;
            const upper = Number.isFinite(joint.limits.upper) ? joint.limits.upper : Infinity;
            appliedValue = Math.max(lower, Math.min(upper, appliedValue));
        }

        ModelLoaderFactory.setJointAngle(this.model, jointName, appliedValue, limitsAreIgnored);
        joint.currentValue = appliedValue;

        if (applyConstraints && this.sceneManager?.constraintManager) {
            this.sceneManager.constraintManager.applyConstraints(this.model, joint);
        }

        if (render) {
            this.sceneManager?.redraw();
        }
        if (measure && this.sceneManager?.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }

        this.emit({
            type: 'jointChanged',
            model: this.model,
            joint,
            jointName,
            value: appliedValue,
            source,
            commit
        });

        return appliedValue;
    }

    commitJointValue(jointName, { source = 'user' } = {}) {
        const joint = this.model?.joints?.get(jointName);
        if (!joint || joint.type === 'fixed') return;

        this.emit({
            type: 'jointChanged',
            model: this.model,
            joint,
            jointName,
            value: joint.currentValue ?? 0,
            source,
            commit: true
        });
    }

    applyPose(values, { source = 'playback' } = {}) {
        if (!this.model || !values) return;

        Object.entries(values).forEach(([jointName, value]) => {
            this.setJointValue(jointName, value, {
                source,
                commit: false,
                render: false,
                measure: false
            });
        });

        this.sceneManager?.redraw();
        if (this.sceneManager?.onMeasurementUpdate) {
            this.sceneManager.onMeasurementUpdate();
        }
    }
}
