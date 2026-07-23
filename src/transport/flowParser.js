/**
 * Parse a RobFlow flow (EximFlow from GET /flows/{uuid}/export) into an ordered list of steps the
 * viewer's waypoint sequence understands. Inverse of flowBuilder.buildSequenceFlow.
 *
 * Step descriptors (units match the viewer's sequence model):
 *   { kind:'move', mode:'joint',     joints:[deg],                       name, velocity, acceleration, blendingRadius }
 *   { kind:'move', mode:'cartesian', cartesian:{position:[mm], orientation:[deg]}, name, velocity, acceleration, blendingRadius }
 *   { kind:'tool', toolId }                                  (native setTool node — gripper/tool change)
 *   { kind:'delay', seconds }
 *   { kind:'payload', mass:[kg], com:[mm,mm,mm] }
 *   { kind:'output', bankId, outputId, state, delay:[s] }   (native setOutput node)
 *   { kind:'node', nodeType, label, raw, extraNodes, extraEdges, continueHandle }
 *     — ANY other node type, kept VERBATIM (its full node object + captured branch subgraphs) so a
 *       round-trip re-emits it instead of destroying what the viewer doesn't model.
 *
 * Grouping: a step may carry group:{key, name, description, exportDoc}. Equal keys become one
 * viewer folder. Sources: a RobFlow Documentation Group covering the node (exportDoc:true — it
 * round-trips back to a groups[] entry) or a movement node holding several movements[] (the folder
 * mirrors that node, so "waypoints inside one RobFlow node" stay visible as a unit).
 *
 * Every step carries srcNodeId — the id of the RobFlow node it came from (merged movements share
 * one) — which the per-node execution timer keys on. The returned `loops` flag says whether the
 * flow had the infinite-loop envelope (drives the panel's loop checkbox).
 *
 * Pure (no THREE/DOM): the caller computes each move's world-frame marker pose (joint → FK,
 * cartesian → base→world). Execution order is derived by walking start → `out` edges, descending
 * the push envelope's infinite loop. Movement poses are read inline, or resolved from the flow's
 * variables[] when a movement only carries pose.poseVariableId.
 */
import { CYCLE_MARKER, normalizeApproachMode } from './flowBuilder.js';

/** Node types the parser converts into editable steps; everything else is kept verbatim. */
const STEP_TYPES = new Set(['jointMovement', 'cartesianMovement', 'delay', 'payload', 'setOutput', 'setTool']);

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

/**
 * Walk the graph start → out. Returns the ordered chain entries, plus everything the chain can't
 * express — branch subgraphs hanging off kept nodes and nodes unreachable from start — captured
 * verbatim so the builder can re-emit them.
 *
 * Chain continuation for a foreign node: its `out` edge, else `afterCompletion`, else its only
 * outgoing edge; with several branch handles and no obvious continuation the walk stops there and
 * every branch is captured as that node's subgraph.
 */
function walkFlow(flow) {
    const nodes = flow.nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const outs = new Map(); // source id -> [edge]
    for (const e of flow.edges || []) {
        if (!outs.has(e.source)) outs.set(e.source, []);
        outs.get(e.source).push(e);
    }
    const handleMap = (id) => {
        const m = {};
        for (const e of outs.get(id) || []) m[e.sourceHandle || 'out'] = e.target;
        return m;
    };

    const visited = new Set();
    const entries = []; // {node, continueHandle?, branchEdges?}
    let envelopeSeen = false;

    const walk = (startId) => {
        let id = startId;
        while (id && !visited.has(id)) {
            visited.add(id);
            const node = byId.get(id);
            if (!node) break;
            const h = handleMap(id);
            if (node.type === 'start') { id = h.out; continue; }
            // The push envelope: the leading infinite loop wraps the whole body — descend, drop
            // (the builder re-adds it). Any OTHER loop is foreign and kept verbatim below.
            if (node.type === 'loop' && node.data?.infinite && !envelopeSeen && entries.length === 0) {
                envelopeSeen = true;
                walk(h.loop);
                id = h.afterCompletion ?? h.out;
                continue;
            }
            // Our own cycle marker (re-added on every push).
            if (node.type === 'messageLog' && node.data?.message?.expressionRaw === CYCLE_MARKER) { id = h.out; continue; }
            if (STEP_TYPES.has(node.type)) { entries.push({ node }); id = h.out; continue; }
            const nodeEdges = outs.get(id) || [];
            const continueHandle = h.out ? 'out'
                : (h.afterCompletion ? 'afterCompletion'
                : (nodeEdges.length === 1 ? (nodeEdges[0].sourceHandle || 'out') : null));
            entries.push({
                node,
                continueHandle,
                branchEdges: nodeEdges.filter((e) => (e.sourceHandle || 'out') !== continueHandle),
            });
            id = continueHandle ? h[continueHandle] : null;
        }
    };
    walk(nodes.find((n) => n.type === 'start')?.id);

    // Fallback: a flow with no edges at all (a node palette / template) — treat declaration order
    // as the chain so its movements still load as steps, like the pre-folder parser did.
    if (!entries.length && !(flow.edges || []).length) {
        for (const n of nodes) {
            if (n.type === 'start') continue;
            visited.add(n.id);
            entries.push({ node: n });
        }
    }

    // Capture each kept node's branch subgraphs (nodes not on the main chain, breadth-first from
    // its non-continuation edges). Edges that leave a branch back INTO the chain are kept too —
    // the builder drops any whose endpoint no longer exists.
    const claimed = new Set();
    for (const en of entries) {
        if (!en.branchEdges?.length) continue;
        const clusterIds = [];
        const queue = en.branchEdges.map((e) => e.target);
        while (queue.length) {
            const id = queue.shift();
            if (!id || visited.has(id) || claimed.has(id) || !byId.has(id)) continue;
            claimed.add(id);
            clusterIds.push(id);
            for (const e of outs.get(id) || []) queue.push(e.target);
        }
        const extraEdges = [...en.branchEdges];
        for (const id of clusterIds) extraEdges.push(...(outs.get(id) || []));
        en.branch = { nodes: clusterIds.map((id) => byId.get(id)), edges: extraEdges };
    }

    // Everything unreachable from start (second event chains, disconnected clusters) — one bucket.
    const unreached = nodes.filter((n) => !visited.has(n.id) && !claimed.has(n.id));
    const unreachedEdges = [];
    for (const n of unreached) unreachedEdges.push(...(outs.get(n.id) || []));
    return { entries, unreached, unreachedEdges, envelopeSeen };
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
 * The Documentation Group a node belongs to. An explicit parentNode link wins (the builder emits
 * it; a linked node's position is RELATIVE to its parent, so a spatial check would misfire).
 * Unlinked nodes fall back to spatial containment (editor-drawn groups).
 */
function docGroupOf(node, docGroups) {
    if (node.parentNode) return docGroups.find((g) => g.id === node.parentNode) || null;
    const p = node.position || {};
    return docGroups.find((g) => {
        const gp = g.position || {};
        const gd = g.dimensions || {};
        return p.x >= gp.x && p.x <= gp.x + (gd.width || 0)
            && p.y >= gp.y && p.y <= gp.y + (gd.height || 0);
    });
}

/** Verbatim-kept step for a node the viewer doesn't edit. */
function nodeStep(node, en, group) {
    const s = {
        kind: 'node',
        nodeType: node.type,
        label: node.data?.name || node.type,
        raw: node,
        extraNodes: en.branch?.nodes || [],
        extraEdges: en.branch?.edges || [],
        continueHandle: en.continueHandle !== undefined ? en.continueHandle : 'out',
        srcNodeId: node.id,
    };
    if (group) s.group = group;
    return s;
}

/**
 * @param {object} flow - an EximFlow (GET /flows/{uuid}/export).
 * @returns {{steps:Array<object>, name:string, uuid:string, skipped:string[], kept:string[], loops:boolean}}
 *   steps in execution order; kept lists foreign node types preserved verbatim (for a UI note);
 *   skipped lists the few things genuinely dropped (currently: reference groups); loops says
 *   whether the flow carried the infinite-loop envelope.
 */
export function parseFlow(flow) {
    const steps = [];
    const skipped = [];
    const kept = [];
    if (!flow || !Array.isArray(flow.nodes)) return { steps, name: flow?.name || '', uuid: flow?.uuid || '', skipped, kept, loops: true };

    const varsByUuid = new Map((flow.variables || []).map((v) => [v.uuid, v]));
    const docGroups = (flow.groups || []).filter((g) => g?.type === 'documentation');
    const refGroups = (flow.groups || []).filter((g) => g?.type && g.type !== 'documentation');
    if (refGroups.length) skipped.push(`${refGroups.length} reference group(s)`);

    const { entries, unreached, unreachedEdges, envelopeSeen } = walkFlow(flow);

    /** Folder spec for a node: its Documentation Group, else null (movement nodes may add their own). */
    const docSpec = (node) => {
        const g = docGroupOf(node, docGroups);
        if (!g) return null;
        return { key: `g-${g.id}`, name: g.data?.name || 'Group', description: g.data?.description || '', exportDoc: true };
    };

    for (const en of entries) {
        const node = en.node;
        const d = node.data || {};
        const doc = docSpec(node);
        switch (node.type) {
            case 'jointMovement':
            case 'cartesianMovement': {
                const mode = node.type === 'cartesianMovement' ? 'cartesian' : 'joint';
                const movements = Array.isArray(d.movements) ? d.movements : [];
                // Several movements in one node = a unit worth seeing — mirror it as a folder.
                const group = doc || (movements.length > 1
                    ? { key: `n-${node.id}`, name: d.name || 'Movements', description: '', exportDoc: false }
                    : null);
                movements.forEach((m, i) => {
                    const pose = resolvePose(m.pose, varsByUuid);
                    const step = {
                        kind: 'move',
                        mode,
                        name: m.name || d.name || `${mode === 'cartesian' ? 'C' : 'J'}${i + 1}`,
                        velocity: clamp01(exprNum(m.velocity, 1)),
                        acceleration: clamp01(exprNum(m.acceleration, 1)),
                        blendingRadius: Math.max(0, exprNum(m.blendingRadius, 0)),
                        srcNodeId: node.id,
                    };
                    if (mode === 'cartesian') {
                        step.cartesian = {
                            position: (pose?.position || [0, 0, 0]).map(Number),
                            orientation: (pose?.orientation || [0, 0, 0]).map(Number),
                        };
                    } else {
                        step.joints = (pose?.jointAngles || []).map(Number);
                        // approachMode is part of the JointMovement schema (1=PTP, 2=Linear) —
                        // must survive the round trip or a Linear segment silently becomes PTP.
                        step.approachMode = normalizeApproachMode(exprNum(m.approachMode, 1));
                    }
                    if (group) step.group = group;
                    steps.push(step);
                });
                break;
            }
            case 'delay': {
                const step = { kind: 'delay', seconds: Math.max(0, exprNum(d.delay, 1)), srcNodeId: node.id };
                if (doc) step.group = doc;
                steps.push(step);
                break;
            }
            case 'payload': {
                // v7: data.mass + data.centerOfMass; older flows nest under data.payload.
                const p = d.payload || d;
                const mass = Math.max(0, exprNum(p.mass, 0));
                // Flow CoM is in metres (backend Payload model); the viewer's sequence uses mm.
                const comM = Array.isArray(p.centerOfMass) ? p.centerOfMass : [0, 0, 0];
                const step = { kind: 'payload', mass, com: comM.map((v) => Math.round((Number(v) || 0) * 1000)), srcNodeId: node.id };
                if (doc) step.group = doc;
                steps.push(step);
                break;
            }
            case 'setOutput': {
                // One node can drive several outputs; flatten to one step each (the builder emits
                // one node per step, so a round-trip is stable).
                for (const o of Array.isArray(d.outputs) ? d.outputs : []) {
                    const step = {
                        kind: 'output',
                        bankId: Math.max(0, Math.round(exprNum(o.bankId, 0))),
                        outputId: Math.max(0, Math.round(exprNum(o.outputId, 0))),
                        state: !!o.state,
                        delay: Math.max(0, exprNum(o.delay, 0)),
                        srcNodeId: node.id,
                    };
                    if (doc) step.group = doc;
                    steps.push(step);
                }
                break;
            }
            case 'setTool': {
                // Gripper/tool change — its own step row in the list (editable tool picker).
                const step = { kind: 'tool', toolId: d.toolId ?? null, srcNodeId: node.id };
                if (doc) step.group = doc;
                steps.push(step);
                break;
            }
            default:
                steps.push(nodeStep(node, en, doc));
                kept.push(node.type);
                break;
        }
    }

    if (unreached.length) {
        steps.push({
            kind: 'node', nodeType: 'detached', label: `${unreached.length} unlinked node(s)`,
            raw: null, extraNodes: unreached, extraEdges: unreachedEdges, continueHandle: null,
        });
        kept.push('detached');
    }
    return { steps, name: flow.name || '', uuid: flow.uuid || '', skipped: [...new Set(skipped)], kept: [...new Set(kept)], loops: envelopeSeen };
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
