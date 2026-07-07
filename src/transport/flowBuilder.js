/**
 * Build a RobFlow flow from an ordered viewer waypoint sequence (moves + delays + payloads).
 *
 * Inverse of flowParser.parseFlow. Poses are written INLINE (variables: []) so the flow round-trips
 * cleanly and can be PATCHed in place. Consecutive moves of the same mode collapse into ONE
 * movement node holding every pose in `movements[]`; a mode change, a delay, or a payload starts a
 * new node. The whole body is wrapped in an infinite loop, with a messageLog cycle marker at the end
 * so the CycleTimer can measure loop time.
 *
 * Units (matching the sequence model): joints deg, cartesian position mm + orientation deg, velocity
 * & acceleration 0..1 fractions, blendingRadius mm, delay seconds, payload mass kg + CoM mm
 * (converted to metres for the flow node, per the backend Payload model).
 */
const uuid = () =>
    (crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          }));

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 0));
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
// RobFlow's movement-node editor accepts at most 2 decimal places per numeric field. Round
// everything we write to match, so a pushed pose reads back identically in the editor and a later
// open+save there can't silently shift it. 0.01 mm / 0.01° / 0.01 (vel/acc) is well below robot
// repeatability, so this costs no practical accuracy.
const round2 = (v) => Math.round((Number.isFinite(+v) ? +v : 0) * 100) / 100;
const round2arr = (a) => (Array.isArray(a) ? a : []).map(round2);

// VueFlow edge: target always connects to the implicit "in" handle; source leaves via `handle`.
const edge = (src, tgt, handle = 'out') => ({
    id: `vueflow__edge-${src}${handle}-${tgt}in`,
    source: src,
    sourceHandle: handle,
    target: tgt,
});

/** Logged once per loop iteration; CycleTimer matches this exact text to time the full loop. */
export const CYCLE_MARKER = 'orrerium-cycle';

function startNode() {
    return { id: 'start', type: 'start', parentNode: null, data: { valid: true, validStates: { general: true } }, position: { x: 0, y: 0 } };
}

/** Infinite loop entry — its "loop" handle drives the body each iteration, forever. */
function loopNode(id, x) {
    return {
        id, type: 'loop', parentNode: null,
        data: { name: '', valid: true, infinite: true, canBeSaved: true, iterations: { dtype: 'integer', expressionRaw: '1', expressionProcessed: '1' } },
        position: { x, y: 0 },
    };
}

function messageLogNode(id, x) {
    return {
        id, type: 'messageLog', parentNode: null,
        data: { name: '', valid: true, message: { dtype: 'string', expressionRaw: CYCLE_MARKER, expressionProcessed: CYCLE_MARKER }, logLevel: 'info', canBeSaved: true },
        position: { x, y: 0 },
    };
}

/** One inline movement inside a movement node. */
function movementInline(mode, m) {
    const mv = {
        name: m.name || '', uuid: uuid(), valid: true,
        velocity: round2(clamp01(m.velocity ?? 1)), acceleration: round2(clamp01(m.acceleration ?? 1)),
        blendingRadius: Math.max(0, Math.round(num(m.blendingRadius, 0))),
    };
    if (mode === 'cartesian') {
        const c = m.cartesian || {};
        mv.pose = { position: round2arr(c.position || [0, 0, 0]), orientation: round2arr(c.orientation || [0, 0, 0]), poseVariableId: null };
    } else {
        mv.approachMode = 1; // PTP
        mv.pose = { jointAngles: round2arr(m.joints || []), poseVariableId: null };
    }
    return mv;
}

function moveNode(mode, id, label, movements, x) {
    return {
        id, type: mode === 'cartesian' ? 'cartesianMovement' : 'jointMovement', parentNode: null,
        data: { name: label, valid: true, canBeSaved: true, validStates: { general: true }, movements },
        position: { x, y: 0 },
    };
}

function delayNode(id, seconds, x) {
    const s = String(Math.max(0, num(seconds, 1)));
    return {
        id, type: 'delay', parentNode: null,
        data: { name: '', valid: true, canBeSaved: true, validStates: { general: true }, delay: { dtype: 'float', expressionRaw: s, expressionProcessed: s } },
        position: { x, y: 0 },
    };
}

function payloadNode(id, massKg, comMm, x) {
    const mass = String(Math.max(0, num(massKg, 0)));
    const com = (comMm || [0, 0, 0]).map((v) => num(v, 0) / 1000); // mm → m for the flow node
    return {
        id, type: 'payload', parentNode: null,
        data: { name: '', valid: true, canBeSaved: true, validStates: { general: true }, mass: { dtype: 'float', expressionRaw: mass, expressionProcessed: mass }, centerOfMass: com },
        position: { x, y: 0 },
    };
}

/**
 * Native RobFlow digital-output node (schema per an editor export): each entry addresses one
 * output by bankId + outputId and drives it to `state` after `delay` seconds. The viewer's
 * MaterialManager listens to the resulting `{type:'outputs'}` WS broadcast to grip/release.
 */
function setOutputNode(id, s, x) {
    return {
        id, type: 'setOutput', parentNode: null,
        data: {
            name: '', valid: true, canBeSaved: true,
            outputs: [{
                name: '', uuid: uuid(),
                delay: Math.max(0, num(s.delay, 0)),
                state: !!s.state, valid: true,
                bankId: Math.max(0, Math.round(num(s.bankId, 0))),
                outputId: Math.max(0, Math.round(num(s.outputId, 0))),
            }],
        },
        position: { x, y: 0 },
    };
}

/**
 * Build an importable flow from an ordered step list.
 * @param {string} name
 * @param {Array<{kind:'move'|'delay'|'payload'|'output', mode?:'joint'|'cartesian', joints?:number[],
 *   cartesian?:{position:number[],orientation:number[]}, name?:string, velocity?:number,
 *   acceleration?:number, blendingRadius?:number, seconds?:number, mass?:number, com?:number[],
 *   bankId?:number, outputId?:number, state?:boolean, delay?:number}>} steps
 * @param {{flowUuid?:string}} [opts] - flowUuid lets a round-trip reuse the loaded flow's id.
 * @returns {{flow:object, flowUuid:string}} flow for POST /flows/import (or PATCH /flows/{uuid}).
 */
export function buildSequenceFlow(name, steps, opts = {}) {
    const flowUuid = opts.flowUuid || uuid();
    const nodes = [startNode(), loopNode('loop', 380)];
    const edges = [edge('start', 'loop')];
    let prev = 'loop';
    let prevHandle = 'loop'; // first body edge leaves the loop via its "loop" (body) handle
    let x = 760;
    let idx = 0;
    const connect = (id) => { edges.push(edge(prev, id, prevHandle)); prev = id; prevHandle = 'out'; x += 380; };

    const list = Array.isArray(steps) ? steps : [];
    let moveCount = 0;
    let i = 0;
    while (i < list.length) {
        const s = list[i];
        if (s.kind === 'move') {
            const mode = s.mode === 'cartesian' ? 'cartesian' : 'joint';
            const run = [];
            while (i < list.length && list[i].kind === 'move'
                && (list[i].mode === 'cartesian' ? 'cartesian' : 'joint') === mode) {
                run.push(list[i]);
                i += 1;
            }
            const id = `move-${idx++}`;
            const label = run.length > 1 ? `Move ${idx}` : (run[0].name || `Move ${idx}`);
            nodes.push(moveNode(mode, id, label, run.map((m) => movementInline(mode, m)), x));
            connect(id);
            moveCount += run.length;
        } else if (s.kind === 'delay') {
            nodes.push(delayNode(`delay-${idx++}`, s.seconds ?? 1, x));
            connect(nodes[nodes.length - 1].id);
            i += 1;
        } else if (s.kind === 'payload') {
            nodes.push(payloadNode(`payload-${idx++}`, s.mass ?? 0, s.com ?? [0, 0, 0], x));
            connect(nodes[nodes.length - 1].id);
            i += 1;
        } else if (s.kind === 'output') {
            nodes.push(setOutputNode(`output-${idx++}`, s, x));
            connect(nodes[nodes.length - 1].id);
            i += 1;
        } else {
            i += 1;
        }
    }

    nodes.push(messageLogNode('cycle-log', x));
    edges.push(edge(prev, 'cycle-log', prevHandle));

    const flow = {
        name, uuid: flowUuid, version: 'v7.1.7', nodes, edges, groups: [],
        settings: {
            speed: 1.0,
            isHomePositionActive: false,
            homePosition: { poseVariableId: null, jointAngles: [] },
            description: `RobFlow Viewer — ${moveCount} waypoint(s) in ${list.length} step(s)`,
            environmentFile: null, environmentShift: [0, 0, 0, 0, 0, 0], environmentScale: 1, valid: true,
        },
        variables: [], subflows: [], modbusConnections: [], robVisionDeviceConnections: [],
        tools: [], workspaces: [], sqlConfigs: [], conflictAction: null, csvConfigs: [],
    };
    return { flow, flowUuid };
}

/** Graph-only PartialFlow body for PATCH /flows/{uuid} (in-place round-trip; no variables field). */
export function flowGraphPatch(flow) {
    return { name: flow.name, nodes: flow.nodes, edges: flow.edges, groups: flow.groups, settings: flow.settings };
}
