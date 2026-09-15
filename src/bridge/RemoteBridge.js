/**
 * RemoteBridge - live joint stream from a local service (Python / Node.js / C++).
 *
 * The transport is a plain WebSocket to a loopback address, so the page itself
 * can be served from anywhere (including a cloud host) while the robot data
 * never leaves the operator's machine.
 *
 * Protocol
 *   server -> client, once, JSON text:
 *     {"type":"hello","joints":["j1","j2"],"units":"rad","dtype":"f32","rate":100}
 *   server -> client, per frame, binary:
 *     Float32Array (or Float64Array, see dtype) holding one value per joint,
 *     in the order declared by hello
 *   server -> client, per frame, JSON text (simpler, for low rates):
 *     {"type":"pose","values":{"j1":0.42}}
 *   client -> server, right after hello:
 *     {"type":"ready","joints":[...movable joints of the loaded model...]}
 *
 * Units are radians for rotational joints and metres for prismatic ones.
 * A hello declaring "units":"deg" only rescales the rotational joints.
 */

export const BRIDGE_DEFAULT_URL = 'ws://127.0.0.1:9090';

/** Frames are state, not events: only the newest one is worth drawing. */
export class RemoteBridge {
    constructor(poseController) {
        this.poseController = poseController;
        this.model = poseController?.model || null;

        this.ws = null;
        this.status = 'disconnected';   // disconnected | connecting | connected | error
        this.statusDetail = '';
        this.listeners = new Set();

        this.url = BRIDGE_DEFAULT_URL;
        this.token = '';
        this.autoReconnect = true;
        this.reconnectTimer = null;
        this.reconnectDelay = 1000;
        this.manualClose = false;

        // Negotiated frame layout, all indexed the same way as an incoming frame.
        this.remoteJoints = [];
        this.frameTargets = [];         // joint name, or null when the model has no such joint
        this.frameScale = [];
        this.units = 'rad';
        this.dtype = 'f32';
        this.mapping = { matched: [], unknown: [], undriven: [], total: 0 };

        this.pendingPose = null;
        this.poseScratch = {};
        this.rafId = null;
        this.warnedShortFrame = false;

        this.counters = { received: 0, applied: 0, dropped: 0 };
        this.stats = { rateIn: 0, rateOut: 0, dropped: 0 };
        this.statsTimer = null;

        poseController?.subscribe((event) => {
            if (event.type === 'modelChanged') {
                this.model = event.model;
                this.recomputeMapping();
            }
        });
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    setStatus(status, detail = '') {
        this.status = status;
        this.statusDetail = detail;
        this.emit({ type: 'status', status, detail });
    }

    // ---------------------------------------------------------------- connect

    connect(url = this.url, token = this.token) {
        this.disconnect({ silent: true });
        this.url = url;
        this.token = token;
        this.manualClose = false;

        let target;
        try {
            target = new URL(url);
            if (token) target.searchParams.set('token', token);
        } catch {
            this.setStatus('error', `Invalid URL: ${url}`);
            return;
        }

        this.setStatus('connecting', target.origin);
        try {
            this.ws = new WebSocket(target.toString());
        } catch (error) {
            // Thrown synchronously for a blocked scheme, e.g. ws:// from an https page in Safari.
            this.setStatus('error', error.message);
            return;
        }
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.reconnectDelay = 1000;
            this.setStatus('connected', target.origin);
            this.startStats();
        };
        this.ws.onmessage = (event) => this.handleMessage(event.data);
        this.ws.onerror = () => {
            // The event carries no detail by design; onclose reports the outcome.
            this.setStatus('error', 'Connection failed');
        };
        this.ws.onclose = (event) => {
            this.stopStats();
            this.ws = null;
            if (this.manualClose) {
                this.setStatus('disconnected');
                return;
            }
            this.setStatus('disconnected', event.reason || `closed (${event.code})`);
            if (this.autoReconnect) this.scheduleReconnect();
        };
    }

    scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(delay * 2, 15000);
        this.reconnectTimer = setTimeout(() => this.connect(this.url, this.token), delay);
    }

    disconnect({ silent = false } = {}) {
        this.manualClose = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.stopStats();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.pendingPose = null;
        if (!silent) this.setStatus('disconnected');
    }

    // --------------------------------------------------------------- messages

    handleMessage(data) {
        if (typeof data === 'string') {
            let msg;
            try {
                msg = JSON.parse(data);
            } catch {
                return;
            }
            if (msg.type === 'hello') this.handleHello(msg);
            else if (msg.type === 'pose') this.handlePoseMessage(msg.values);
            return;
        }
        this.handleFrame(data);
    }

    handleHello(msg) {
        this.remoteJoints = Array.isArray(msg.joints) ? msg.joints : [];
        this.units = msg.units === 'deg' ? 'deg' : 'rad';
        this.dtype = msg.dtype === 'f64' ? 'f64' : 'f32';
        this.rate = Number.isFinite(msg.rate) ? msg.rate : null;
        this.poseScratch = {};
        this.warnedShortFrame = false;
        this.recomputeMapping();

        const modelJoints = [];
        this.model?.joints?.forEach((joint, name) => {
            if (joint.type !== 'fixed') modelJoints.push(name);
        });
        this.send({ type: 'ready', joints: modelJoints });
    }

    send(payload) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    /** Binary frame: one value per joint, in the order hello declared. */
    handleFrame(buffer) {
        if (!this.frameTargets.length) return;

        const values = this.dtype === 'f64' ? new Float64Array(buffer) : new Float32Array(buffer);
        if (values.length < this.frameTargets.length && !this.warnedShortFrame) {
            this.warnedShortFrame = true;
            console.warn(
                `[RemoteBridge] frame holds ${values.length} values but hello declared ` +
                `${this.frameTargets.length} joints; the extra joints stay untouched`
            );
        }

        const count = Math.min(values.length, this.frameTargets.length);
        // Reused across frames: applyPose reads it synchronously, and every frame
        // rewrites the same keys, so a coalesced frame is never half-stale.
        const pose = this.poseScratch;
        for (let i = 0; i < count; i++) {
            const name = this.frameTargets[i];
            if (name !== null) pose[name] = values[i] * this.frameScale[i];
        }
        this.queue(pose);
    }

    /** JSON frame, keyed by joint name - convenient below ~30 Hz. */
    handlePoseMessage(values) {
        if (!values || typeof values !== 'object') return;
        const pose = {};
        Object.entries(values).forEach(([name, value]) => {
            const joint = this.model?.joints?.get(name);
            if (!joint || joint.type === 'fixed' || !Number.isFinite(value)) return;
            pose[name] = value * this.scaleFor(name);
        });
        this.queue(pose);
    }

    queue(pose) {
        this.counters.received++;
        if (this.pendingPose) this.counters.dropped++;
        this.pendingPose = pose;
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            const next = this.pendingPose;
            this.pendingPose = null;
            if (!next) return;
            this.poseController.applyPose(next, { source: 'remote' });
            this.counters.applied++;
        });
    }

    // ---------------------------------------------------------------- mapping

    scaleFor(jointName) {
        if (this.units !== 'deg') return 1;
        const joint = this.model?.joints?.get(jointName);
        // Prismatic joints are metres in either mode; only rotations are degrees.
        return joint && joint.type !== 'prismatic' ? Math.PI / 180 : 1;
    }

    /**
     * Resolve the declared joint names against the loaded model, and report what
     * failed to line up - a silent mismatch here looks like a dead connection.
     */
    recomputeMapping() {
        const movable = [];
        this.model?.joints?.forEach((joint, name) => {
            if (joint.type !== 'fixed') movable.push(name);
        });
        const known = new Set(movable);

        this.frameTargets = [];
        this.frameScale = [];
        const matched = [];
        const unknown = [];

        this.remoteJoints.forEach((name) => {
            if (known.has(name)) {
                matched.push(name);
                this.frameTargets.push(name);
                this.frameScale.push(this.scaleFor(name));
            } else {
                unknown.push(name);
                this.frameTargets.push(null);
                this.frameScale.push(1);
            }
        });

        const driven = new Set(matched);
        this.mapping = {
            matched,
            unknown,
            undriven: movable.filter((name) => !driven.has(name)),
            total: movable.length
        };
        this.emit({ type: 'mapping', mapping: this.mapping });
    }

    // ------------------------------------------------------------------ stats

    startStats() {
        this.stopStats();
        this.counters = { received: 0, applied: 0, dropped: 0 };
        this.statsSince = performance.now();
        this.statsTimer = setInterval(() => {
            // A background tab throttles this timer well past 1 s, so divide by the
            // time that actually passed rather than by the interval we asked for.
            const now = performance.now();
            const elapsed = Math.max((now - this.statsSince) / 1000, 0.001);
            this.statsSince = now;

            this.stats = {
                rateIn: Math.round(this.counters.received / elapsed),
                rateOut: Math.round(this.counters.applied / elapsed),
                dropped: this.counters.dropped
            };
            this.counters.received = 0;
            this.counters.applied = 0;
            this.counters.dropped = 0;
            this.emit({ type: 'stats', stats: this.stats });
        }, 1000);
    }

    stopStats() {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
        this.stats = { rateIn: 0, rateOut: 0, dropped: 0 };
        this.emit({ type: 'stats', stats: this.stats });
    }
}
