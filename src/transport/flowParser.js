/**
 * Parse a RobFlow flow (EximFlow from GET /flows/{uuid}/export) into an ordered list of steps the
 * viewer's waypoint sequence understands. Inverse of flowBuilder.buildSequenceFlow.
 *
 * Step descriptors (units match the viewer's sequence model):
 *   { kind:'move', mode:'joint',     joints:[deg],                       name, velocity, acceleration, blendingRadius }
 *   { kind:'move', mode:'cartesian', cartesian:{position:[mm], orientation:[deg]}, name, velocity, acceleration, blendingRadius }
 *   { kind:'delay', seconds }
 *   { kind:'payload', mass:[kg], com:[mm,mm,mm] }
 *   { kind:'output', bankId, outputId, state, delay:[s] }   (native setOutput node)
 *
 * Pure (no THREE/DOM): the caller computes each move's world-frame marker pose (joint → FK,
 * cartesian → base→world). Execution order is derived by walking start → `out` edges, descending a
 * loop's `loop` (body) handle. Movement poses are read inline, or resolved from the flow's
 * variables[] when a movement only carries pose.poseVariableId.
 */

/** Numeric value of a RobFlow field that may be a literal number or an Expression {expressionRaw}. */
function exprNum(v, fallback = 0) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (v && typeof v === 'object') {
        const raw = v.expressionRaw ?? v.expressionProcessed;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : fallback;
    }
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

/** Ordered list of step-producing nodes: walk start → out, descending each loop's body. */
function orderedNodes(flow) {
    const byId = new Map((flow.nodes || []).map((n) => [n.id, n]));
    const out = new Map(); // source id -> { handle: targetId }
    for (const e of flow.edges || []) {
        if (!out.has(e.source)) out.set(e.source, {});
        out.get(e.source)[e.sourceHandle || 'out'] = e.target;
    }
    const start = (flow.nodes || []).find((n) => n.type === 'start');
    const seq = [];
    const seen = new Set();
    const walk = (startId) => {
        let id = startId;
        while (id && !seen.has(id)) {
            seen.add(id);
            const node = byId.get(id);
            if (!node) break;
            if (node.type === 'loop') {
                walk(out.get(id)?.loop); // run the loop body in order
                id = out.get(id)?.out;   // then continue after the loop (usually nothing)
                continue;
            }
            seq.push(node);
            id = out.get(id)?.out;
        }
    };
    walk(start?.id);
    // Fallback: a flow with no reachable start — keep declaration order so we still show something.
    return seq.length ? seq : (flow.nodes || []);
}

/** Resolve a movement's pose: inline pose, else the bound variable's currentValue/initialValue. */
function resolvePose(pose, varsByUuid) {
    if (!pose) return null;
    if (pose.poseVariableId && varsByUuid.has(pose.poseVariableId)) {
        const v = varsByUuid.get(pose.poseVariableId);
        return v?.currentValue ?? v?.initialValue ?? pose;
    }
    return pose;
}

/**
 * @param {object} flow - an EximFlow (GET /flows/{uuid}/export).
 * @returns {{steps:Array<object>, name:string, uuid:string, skipped:string[]}}
 *   steps in execution order; skipped lists node types we don't represent (for a UI note).
 */
export function parseFlow(flow) {
    const steps = [];
    const skipped = [];
    if (!flow || !Array.isArray(flow.nodes)) return { steps, name: flow?.name || '', uuid: flow?.uuid || '', skipped };

    const varsByUuid = new Map((flow.variables || []).map((v) => [v.uuid, v]));
    const PASSIVE = new Set(['start', 'stop', 'loop', 'messageLog']);

    for (const node of orderedNodes(flow)) {
        const d = node.data || {};
        switch (node.type) {
            case 'jointMovement':
            case 'cartesianMovement': {
                const mode = node.type === 'cartesianMovement' ? 'cartesian' : 'joint';
                const movements = Array.isArray(d.movements) ? d.movements : [];
                movements.forEach((m, i) => {
                    const pose = resolvePose(m.pose, varsByUuid);
                    const step = {
                        kind: 'move',
                        mode,
                        name: m.name || d.name || `${mode === 'cartesian' ? 'C' : 'J'}${i + 1}`,
                        velocity: clamp01(exprNum(m.velocity, 1)),
                        acceleration: clamp01(exprNum(m.acceleration, 1)),
                        blendingRadius: Math.max(0, exprNum(m.blendingRadius, 0)),
                    };
                    if (mode === 'cartesian') {
                        step.cartesian = {
                            position: (pose?.position || [0, 0, 0]).map(Number),
                            orientation: (pose?.orientation || [0, 0, 0]).map(Number),
                        };
                    } else {
                        step.joints = (pose?.jointAngles || []).map(Number);
                    }
                    steps.push(step);
                });
                break;
            }
            case 'delay':
                steps.push({ kind: 'delay', seconds: Math.max(0, exprNum(d.delay, 1)) });
                break;
            case 'payload': {
                // v7: data.mass + data.centerOfMass; older flows nest under data.payload.
                const p = d.payload || d;
                const mass = Math.max(0, exprNum(p.mass, 0));
                // Flow CoM is in metres (backend Payload model); the viewer's sequence uses mm.
                const comM = Array.isArray(p.centerOfMass) ? p.centerOfMass : [0, 0, 0];
                steps.push({ kind: 'payload', mass, com: comM.map((v) => Math.round((Number(v) || 0) * 1000)) });
                break;
            }
            case 'setOutput': {
                // One node can drive several outputs; flatten to one step each (the builder emits
                // one node per step, so a round-trip is stable).
                for (const o of Array.isArray(d.outputs) ? d.outputs : []) {
                    steps.push({
                        kind: 'output',
                        bankId: Math.max(0, Math.round(exprNum(o.bankId, 0))),
                        outputId: Math.max(0, Math.round(exprNum(o.outputId, 0))),
                        state: !!o.state,
                        delay: Math.max(0, exprNum(o.delay, 0)),
                    });
                }
                break;
            }
            default:
                if (!PASSIVE.has(node.type)) skipped.push(node.type);
                break;
        }
    }
    return { steps, name: flow.name || '', uuid: flow.uuid || '', skipped: [...new Set(skipped)] };
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
