/**
 * Per-node execution timer fed by the `nodeState` websocket message.
 *
 * The RobFlow backend broadcasts a node's state when it starts/finishes running
 * (`_broadcast_node_state()` — the editor's live execution highlight). The exact payload shape
 * varies across backend versions, so ingest() is defensive: it accepts one object or a list,
 * reads the node id from id/nodeId/uuid/node_id, and uses start/finish flags when present.
 * Timing works even without flags: RobFlow executes the chain depth-first, one node at a time,
 * so any broadcast for node X closes the open span of the previous node and opens one for X;
 * a finished-only stream is timed by the gap between consecutive finish broadcasts.
 *
 * Durations use client arrival time (performance.now()), so they include a little transport
 * jitter — fine for the "how long did this step take" display, not a profiler.
 */
export class NodeTimer {
    constructor() {
        this.lastMs = new Map(); // nodeId -> duration (ms) of its most recent completed execution
        this.onUpdate = null;    // fn() — new timing data landed (single owner — WaypointsPanel)
        this._listeners = new Set(); // additional observers (e.g. the takt-time diagram)
        this._openId = null;     // node currently executing (when start broadcasts exist)
        this._openSince = 0;
        this._lastFinishAt = null; // fallback baseline for finished-only streams
    }

    /** Register an additional update observer (onUpdate stays the panel's). @returns unsubscribe */
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** Duration (ms) of the node's last completed execution, or null. */
    msFor(nodeId) {
        return nodeId != null ? this.lastMs.get(nodeId) ?? null : null;
    }

    /** The node currently executing (open span), or null — the takt diagram's live playhead. */
    currentNodeId() { return this._openId; }

    /** How many nodes have timing data. */
    get size() { return this.lastMs.size; }

    /** Forget everything (e.g. a different flow was loaded). */
    reset() {
        this.lastMs.clear();
        this.rebase();
        this._touch();
    }

    /** Close any open span without recording it (call when a run starts, so the idle gap
     *  since the previous run can't be counted into the first node). Keeps last durations. */
    rebase() {
        this._openId = null;
        this._lastFinishAt = null;
    }

    /**
     * Feed a `nodeState` WS payload.
     * @param {Object|Array} data - one state object or a list ({id|nodeId|uuid, [state.]finished…}).
     * @param {number} [nowMs] - arrival time (performance.now()).
     */
    ingest(data, nowMs = performance.now()) {
        const entries = Array.isArray(data) ? data
            : Array.isArray(data?.nodes) ? data.nodes
            : Array.isArray(data?.nodeStates) ? data.nodeStates
            : [data];
        let changed = false;
        for (const e of entries) {
            if (!e || typeof e !== 'object') continue;
            const id = e.id ?? e.nodeId ?? e.uuid ?? e.node_id;
            if (!id) continue;
            const st = (e.state && typeof e.state === 'object') ? e.state : e;
            if (st.finished === true) {
                if (this._openId === id) {
                    this.lastMs.set(id, nowMs - this._openSince); // start…finish span
                    changed = true;
                } else if (this._lastFinishAt != null) {
                    this.lastMs.set(id, nowMs - this._lastFinishAt); // finished-only stream: gap
                    changed = true;
                }
                this._openId = null;
                this._lastFinishAt = nowMs;
                continue;
            }
            // Anything else = "this node is (now) running": close the previous open span.
            if (this._openId && this._openId !== id) {
                this.lastMs.set(this._openId, nowMs - this._openSince);
                changed = true;
            }
            if (this._openId !== id) {
                this._openId = id;
                this._openSince = nowMs;
            }
            this._lastFinishAt = null; // explicit start broadcasts supersede the gap fallback
        }
        if (changed) this._touch();
    }

    _touch() {
        try { this.onUpdate?.(); } catch { /* an observer must never break ingest */ }
        for (const fn of this._listeners) {
            try { fn(); } catch { /* an observer must never break ingest */ }
        }
    }
}
