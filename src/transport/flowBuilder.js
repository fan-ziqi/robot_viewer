/**
 * Build a RobFlow flow from an ordered viewer waypoint sequence (moves + delays + payloads +
 * outputs + verbatim-kept foreign nodes).
 *
 * Inverse of flowParser.parseFlow. Poses are written INLINE (variables: []) so the flow round-trips
 * cleanly and can be PATCHed in place. FOLDERS drive node merging: consecutive same-mode moves
 * sharing a folder (step.group.key) collapse into ONE movement node named after the folder;
 * ungrouped moves export one node each. A mode change or another step kind (delay/output/tool/…)
 * closes the node. kind:'tool' steps emit a native setTool node. Folders with group.exportDoc
 * become RobFlow Documentation Groups (groups[]): their member nodes are stacked BELOW each other
 * in one column, fully inside the frame (with clearance for the group title), and the neighboring
 * chain nodes keep a gap from the frame so they stay visually separate. kind:'node' steps re-emit
 * the original node + its captured branch subgraphs verbatim, so a round-trip keeps whatever the
 * viewer doesn't model. By default the whole body is wrapped in an infinite loop with a messageLog
 * cycle marker at the end (CycleTimer measures loop time); pass opts.loop:false for a run-once
 * flow (start → body, no loop node, no cycle marker).
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

/** Fresh flow uuid (for recreating a flow without colliding with the copy still on the controller). */
export const newFlowUuid = uuid;
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clone = (o) => JSON.parse(JSON.stringify(o));
// RobFlow's movement-node editor accepts at most 2 decimal places per numeric field. Round
// everything we write to match, so a pushed pose reads back identically in the editor and a later
// open+save there can't silently shift it. 0.01 mm / 0.01° / 0.01 (vel/acc) is well below robot
// repeatability, so this costs no practical accuracy.
const round2 = (v) => Math.round((Number.isFinite(+v) ? +v : 0) * 100) / 100;
const round2arr = (a) => (Array.isArray(a) ? a : []).map(round2);

// Assumed on-canvas footprint of a RobFlow node (chain spacing is 380). Documentation Group
// members are stacked vertically in one padded column; the frame keeps clearance for its title
// and a gap to the neighboring chain nodes so they never overlap the frame.
const NODE_W = 340;
const NODE_H = 120;      // visual node height
const GROUP_PAD = 40;    // frame padding around member nodes
const GROUP_TITLE = 90;  // clearance above the first member so the title stays readable
const GROUP_GAP = 80;    // horizontal distance between the frame and neighboring chain nodes
const GROUP_PITCH = 180; // vertical pitch of members stacked below each other

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
        mv.approachMode = m.approachMode === 2 ? 2 : 1; // PTP unless the loaded flow said Linear
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

/** Native RobFlow tool-change node — toolId null clears the mounted tool. */
function setToolNode(id, toolId, x) {
    return {
        id, type: 'setTool', parentNode: null,
        data: { name: '', valid: true, toolId: toolId ?? null, canBeSaved: true },
        position: { x, y: 0 },
    };
}

/**
 * Build an importable flow from an ordered step list.
 * @param {string} name
 * @param {Array<{kind:'move'|'tool'|'delay'|'payload'|'output'|'node', mode?:'joint'|'cartesian', joints?:number[],
 *   cartesian?:{position:number[],orientation:number[]}, name?:string, velocity?:number,
 *   acceleration?:number, blendingRadius?:number, toolId?:string|null,
 *   seconds?:number, mass?:number, com?:number[], bankId?:number, outputId?:number, state?:boolean,
 *   delay?:number, raw?:object|null, extraNodes?:object[], extraEdges?:object[],
 *   continueHandle?:string|null, group?:{key:string,name:string,description:string,exportDoc:boolean}}>} steps
 * @param {{flowUuid?:string, loop?:boolean}} [opts] - flowUuid lets a round-trip reuse the loaded
 *        flow's id; loop:false builds a run-once flow (no infinite-loop envelope, no cycle marker).
 * @returns {{flow:object, flowUuid:string, stepNodeIds:Array<string|null>}} flow for
 *          POST /flows/import (or PATCH /flows/{uuid}); stepNodeIds[i] is the id of the RobFlow
 *          node that executes steps[i] (merged moves share one id) — the hook for per-node timing.
 */
export function buildSequenceFlow(name, steps, opts = {}) {
    const flowUuid = opts.flowUuid || uuid();
    const useLoop = opts.loop !== false;
    const list = Array.isArray(steps) ? steps : [];
    const stepNodeIds = new Array(list.length).fill(null);

    // Verbatim-kept nodes reuse their original ids; make sure generated chain ids never collide.
    const usedIds = new Set(['start', 'loop', 'cycle-log']);
    for (const s of list) {
        if (s.kind !== 'node') continue;
        if (s.raw?.id) usedIds.add(s.raw.id);
        for (const n of s.extraNodes || []) if (n?.id) usedIds.add(n.id);
    }
    const genId = (base) => {
        let id = base;
        while (usedIds.has(id)) id += 'x';
        usedIds.add(id);
        return id;
    };

    const nodes = useLoop ? [startNode(), loopNode('loop', 380)] : [startNode()];
    const edges = useLoop ? [edge('start', 'loop')] : [];
    const pendingNodes = []; // captured branch/detached nodes, re-emitted after the chain
    const pendingEdges = [];
    let prev = useLoop ? 'loop' : 'start';
    let prevHandle = useLoop ? 'loop' : 'out'; // the loop's body edge leaves via its "loop" handle
    let x = useLoop ? 760 : 380;
    let idx = 0;
    const connect = (id) => { edges.push(edge(prev, id, prevHandle)); prev = id; prevHandle = 'out'; };

    // Doc-folder column layout state + extents (group key -> {id, name, description, x, maxY}).
    const groupBounds = new Map();
    let curDoc = null; // exportDoc folder currently being laid out as a vertical column
    let colX = 0;
    let colY = 0;

    /** Layout slot for the next chain node. Members of an exportDoc folder stack BELOW each other
     *  in one padded column and are LINKED to the Documentation Group (parentNode = group id,
     *  position relative to the group frame — Vue Flow child semantics, so the editor moves them
     *  with the group). Everyone else advances the horizontal chain, keeping GROUP_GAP clearance
     *  when stepping into or out of a frame.
     *  @returns {{pos:{x:number,y:number}, parentId:string|null}} */
    const place = (g) => {
        const dg = g?.exportDoc ? g.key : null;
        if (dg !== curDoc) {
            if (curDoc !== null) x = colX + NODE_W + GROUP_PAD + GROUP_GAP; // step out of the frame
            if (dg !== null) {
                // previous chain node ends at x-380+NODE_W; frame left edge lands GROUP_GAP after it
                colX = (x - 380 + NODE_W) + GROUP_GAP + GROUP_PAD;
                colY = 0;
            }
            curDoc = dg;
        }
        if (dg !== null) {
            const b = groupBounds.get(dg) || { id: uuid(), name: g.name, description: g.description, x: colX, maxY: 0 };
            b.maxY = Math.max(b.maxY, colY);
            groupBounds.set(dg, b);
            // relative to the frame origin (frame = {x: colX-GROUP_PAD, y: -GROUP_TITLE})
            const pos = { x: GROUP_PAD, y: colY + GROUP_TITLE };
            colY += GROUP_PITCH;
            return { pos, parentId: b.id };
        }
        const pos = { x, y: 0 };
        x += 380;
        return { pos, parentId: null };
    };
    const emit = (node, g) => {
        const slot = place(g);
        node.position = slot.pos;
        node.parentNode = slot.parentId;
        nodes.push(node);
        connect(node.id);
    };

    let moveCount = 0;
    let i = 0;
    while (i < list.length) {
        const s = list[i];
        if (s.kind === 'move') {
            const mode = s.mode === 'cartesian' ? 'cartesian' : 'joint';
            const gkey = s.group?.key || null;
            // Folders drive merging: only moves sharing a folder collapse into one node — ungrouped
            // moves export one node each.
            const first = i;
            const run = [];
            while (i < list.length && list[i].kind === 'move'
                && (list[i].mode === 'cartesian' ? 'cartesian' : 'joint') === mode
                && (list[i].group?.key || null) === gkey) {
                run.push(list[i]);
                i += 1;
                if (!gkey) break;
            }
            const id = genId(`move-${idx++}`);
            const label = (gkey && s.group?.name)
                || (run.length > 1 ? `Move ${idx}` : (run[0].name || `Move ${idx}`));
            emit(moveNode(mode, id, label, run.map((m) => movementInline(mode, m)), 0), s.group);
            for (let k = first; k < i; k++) stepNodeIds[k] = id;
            moveCount += run.length;
        } else if (s.kind === 'tool') {
            const id = genId(`tool-${idx++}`);
            emit(setToolNode(id, s.toolId ?? null, 0), s.group);
            stepNodeIds[i] = id;
            i += 1;
        } else if (s.kind === 'delay') {
            const id = genId(`delay-${idx++}`);
            emit(delayNode(id, s.seconds ?? 1, 0), s.group);
            stepNodeIds[i] = id;
            i += 1;
        } else if (s.kind === 'payload') {
            const id = genId(`payload-${idx++}`);
            emit(payloadNode(id, s.mass ?? 0, s.com ?? [0, 0, 0], 0), s.group);
            stepNodeIds[i] = id;
            i += 1;
        } else if (s.kind === 'output') {
            const id = genId(`output-${idx++}`);
            emit(setOutputNode(id, s, 0), s.group);
            stepNodeIds[i] = id;
            i += 1;
        } else if (s.kind === 'node') {
            // Verbatim-kept foreign node: re-emit it in the chain (fresh layout slot, original id +
            // data), then continue via its recorded continuation handle. Terminal nodes still
            // advance the chain — an edge into a nonexistent handle is dropped at import, which
            // keeps everything after it present (if disconnected) instead of lost.
            if (s.raw) {
                const raw = clone(s.raw);
                const slot = place(s.group);
                raw.position = slot.pos;
                raw.parentNode = slot.parentId; // re-laid-out chain node — old parent no longer applies
                nodes.push(raw);
                edges.push(edge(prev, raw.id, prevHandle));
                prev = raw.id;
                prevHandle = s.continueHandle || 'out';
                stepNodeIds[i] = raw.id;
            }
            if (s.extraNodes?.length) pendingNodes.push(...s.extraNodes.map(clone));
            if (s.extraEdges?.length) pendingEdges.push(...s.extraEdges.map(clone));
            i += 1;
        } else {
            i += 1;
        }
    }

    if (useLoop) {
        const logNode = messageLogNode('cycle-log', 0);
        logNode.position = place(null).pos; // steps out of a trailing doc frame if one is open
        nodes.push(logNode);
        edges.push(edge(prev, 'cycle-log', prevHandle));
    }

    // Captured branch/detached subgraphs, verbatim (original positions). Skip id collisions, and
    // drop edges whose endpoint no longer exists (e.g. a branch that rejoined a rebuilt chain node
    // — its old id is gone; a dangling edge can fail the import).
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of pendingNodes) {
        if (!n?.id || ids.has(n.id)) continue;
        ids.add(n.id);
        nodes.push(n);
    }
    const edgeIds = new Set(edges.map((e) => e.id));
    for (const e of pendingEdges) {
        if (!e || edgeIds.has(e.id) || !ids.has(e.source) || !ids.has(e.target)) continue;
        edgeIds.add(e.id);
        edges.push(e);
    }

    // Checked folders → Documentation Groups (visual-only in RobFlow). The frame wraps its member
    // column with padding, plus headroom above the first member so the title isn't hidden. Member
    // nodes reference the group via parentNode (ids pre-generated in place()).
    const groups = [];
    for (const b of groupBounds.values()) {
        groups.push({
            id: b.id, type: 'documentation',
            data: { name: b.name || 'Group', valid: true, canBeSaved: true, description: b.description || '', backgroundColor: 'robco-aquamarin' },
            position: { x: b.x - GROUP_PAD, y: -GROUP_TITLE },
            dimensions: { width: NODE_W + GROUP_PAD * 2, height: GROUP_TITLE + b.maxY + NODE_H + GROUP_PAD },
            parent: null,
        });
    }
    // A parentNode must reference something that exists in THIS flow (a group or another node) —
    // e.g. a verbatim-kept node may point at a reference group we dropped. Null dangling links.
    const groupIds = new Set(groups.map((g) => g.id));
    for (const n of nodes) {
        if (n.parentNode && !groupIds.has(n.parentNode) && !ids.has(n.parentNode)) n.parentNode = null;
    }

    const flow = {
        name, uuid: flowUuid, version: 'v7.1.7', nodes, edges, groups,
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
    return { flow, flowUuid, stepNodeIds };
}

/** Graph-only PartialFlow body for PATCH /flows/{uuid} (in-place round-trip; no variables field). */
export function flowGraphPatch(flow) {
    return { name: flow.name, nodes: flow.nodes, edges: flow.edges, groups: flow.groups, settings: flow.settings };
}
