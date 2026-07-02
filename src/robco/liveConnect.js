/**
 * Live RobFlow session -> viewer bridge (P3).
 *
 * Opens the /robot WebSocket, builds the robot once `robotModuleIds` arrives, hands it to
 * the viewer's display path, then mirrors `jointAngles` (and `baseShift`) live.
 */
import { resolveSession } from '../transport/session.js';
import { RobFlowSocket } from '../transport/RobFlowSocket.js';
import { RobFlowClient } from '../transport/RobFlowClient.js';
import { FrequencyMeter } from '../transport/FrequencyMeter.js';
import { CycleTimer } from '../transport/CycleTimer.js';
import { CYCLE_MARKER } from '../transport/flowBuilder.js';
import { StreamRatePanel } from './StreamRatePanel.js';
import { RobCoModuleAdapter } from '../adapters/RobCoModuleAdapter.js';
import { applyAnglesDeg } from './poseUtils.js';
import { DynamicsController } from '../dynamics/DynamicsController.js';
import { TeachPendant } from './TeachPendant.js';
import { RobFlowToolsPanel } from './RobFlowToolsPanel.js';
import { canonicalIds } from './robotPresets.js';
import { saveSession, saveToken } from './sessionStore.js';

const redactSid = (url) => url.replace(/session\/ws\/[^/]+/, 'session/ws/<SID>');

/**
 * @param {Object} app - the viewer App instance (needs app.fileHandler.onModelLoaded).
 * @param {Object} opts - passed to resolveSession ({sid} for cloud, {host,port} for local).
 * @returns {Promise<RobFlowSocket>}
 */
export async function connectLiveSession(app, opts) {
    window._robcoApp = app; // referenced by ViewPanel FK-drag to pause the live mirror
    const session = resolveSession(opts);
    console.log(`[RobCo] live ${session.mode} connect: ${redactSid(session.wsUrl)}`);

    const client = new RobFlowClient(session.restBase, { token: opts.token });
    // Inner editor login unlocks flow push/save/delete (read + move are open via the SID).
    if (opts.username) {
        try {
            await client.login(opts.username, opts.password || '');
            console.log('[RobCo] editor login ok — flow push/save enabled');
        } catch (e) {
            console.warn('[RobCo] editor login failed — push/save disabled (read + move still work):', e.message);
        }
    }
    const panel = new RobFlowToolsPanel(app, { client }); // Status + Robot Config + Teach; two-way sync
    const socket = new RobFlowSocket(session.wsUrl);

    // Reconfiguring the virtual robot's modules is an account-level REST POST to
    // /public/virtual-robot/configure (the /robot WS is read-only for this — a `module_ids` frame
    // there is silently dropped). Authorized by the Cognito account token, NOT the session editor
    // token. Cloud only; needs a token (view-only sessions can't reconfigure). The panel's Robot
    // Config section calls this on Apply; the session then streams new robotModuleIds and the mirror rebuilds.
    if (session.mode === 'cloud' && opts.token) {
        const publicBase = session.restBase.split('/virtual-robot/session/')[0]; // https://<host>/public
        const configureUrl = `${publicBase}/virtual-robot/configure`;
        app._robcoApplyModules = async (moduleIds) => {
            const res = await fetch(configureUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
                credentials: 'omit',
                body: JSON.stringify({ type: 'module_ids', module_ids: moduleIds }),
            });
            if (!res.ok) throw new Error(`configure → HTTP ${res.status}`);
            return res.status;
        };
    } else {
        app._robcoApplyModules = null;
    }

    // Stream-rate meter: timestamp every frame off the socket (with event.timeStamp), measure
    // the jointAngles push cadence. Tap is passive — never touches the per-type handlers.
    const meter = new FrequencyMeter({ type: 'jointAngles', sampleSize: 300, warmup: 20 });
    socket.addTap((type, data, ts, recvNow) => meter.tick(type, data, ts, recvNow));
    StreamRatePanel.ensure(meter);
    app._robcoStreamMeter = meter;

    // Cycle-time meter: the pushed loop logs CYCLE_MARKER once per pass; time the gaps.
    const cycleTimer = new CycleTimer({ marker: CYCLE_MARKER });
    socket.on('messages', (data) => cycleTimer.ingest(data, performance.now()));
    app._robcoCycleTimer = cycleTimer;
    let model = null;
    let building = false;
    let currentCanonical = null; // canonical module-id list the viewer is currently built for
    let pendingIds = null;       // a config change that arrived mid-rebuild (coalesced)
    let latestAngles = null;
    let latestBaseShift = null;
    let dynamics = null;
    let teach = null;
    let firstJa = true;

    // --- RobFlow-reported payload --------------------------------------------------------------
    // RobFlow can report the payload three ways; we feed the richest available into the dynamics
    // as the 'robot' source and surface it in the panel. Wire units: mass kg, CoM mm, inertia
    // kg·m² (about the CoM, end-flange frame). CoM is converted mm -> m here (the dynamics is SI).
    let rfPayload = null;     // from the `payload` message (mass + CoM)
    let rfInertial = null;    // from `payloadInertialParameters` (mass + CoM + tensor)
    let rfPayloadAt = 0;      // arrival time (perf clock) of each feed, for recency tie-breaking
    let rfInertialAt = 0;
    let rfTools = null;       // robot-config tool library (to name the active tool)
    let rfToolsFromWs = false; // a live robotConfig push wins over the one-shot REST fetch
    let rfActiveToolUuid = null;
    let rfActiveToolName = null;
    let pendingRobotPayload = null; // buffered until the dynamics controller exists
    let havePendingRobot = false;

    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const mm2m = (v) => num(v) / 1000;
    const com3 = (raw) => (Array.isArray(raw)
        ? [mm2m(raw[0]), mm2m(raw[1]), mm2m(raw[2])]
        : [mm2m(raw?.x), mm2m(raw?.y), mm2m(raw?.z)]);
    const rfResolveActiveTool = () => {
        rfActiveToolName = (rfTools || []).find((x) => x?.uuid === rfActiveToolUuid)?.name || null;
    };
    const rfResolvePayload = () => {
        const inOk = rfInertial && rfInertial.mass > 0;
        const plOk = rfPayload && rfPayload.mass > 0;
        // Both feeds live: prefer the richer inertial feed unless the plain payload is strictly
        // newer (robot switched to reporting only `payload`) — that un-sticks a stale tensor.
        if (inOk && plOk) return { ...(rfInertialAt >= rfPayloadAt ? rfInertial : rfPayload) };
        if (inOk) return { ...rfInertial };
        if (plOk) return { ...rfPayload };
        return null;
    };
    const rfApply = () => {
        const info = rfResolvePayload();
        if (info && rfActiveToolName) info.tool = rfActiveToolName;
        if (dynamics) dynamics.applyRobotPayload(info);
        else { pendingRobotPayload = info; havePendingRobot = true; }
    };

    // Build the arm from a module-id list and (re)wire the full toolset. Called for the first
    // build and for every subsequent config change (full mirror). Assigns the closure vars
    // `model`/`dynamics`/`teach`.
    async function buildAndWire(ids) {
        console.log(`[RobCo] building live robot from ${ids.length} module ids`);
        model = await RobCoModuleAdapter.build({ baseUrl: session.modulesBase, moduleIds: ids });
        app.fileHandler.onModelLoaded(model, { name: 'robco-live.robco' }); // disposes the old model
        if (latestAngles) applyAnglesDeg(model, latestAngles);
        console.log(`[RobCo] live robot ready: ${model.links.size} links, ${model.joints.size} joints`);
        try {
            const { enhanceVisuals } = await import('./enhanceVisuals.js');
            await enhanceVisuals(model, app.sceneManager);
        } catch (e) { console.warn('[RobCo] enhanceVisuals failed:', e); }

        // enhanceVisuals created the BaseFrame; apply any base shift the robot reported.
        if (latestBaseShift) window._robcoBaseFrame?.setBaseShiftWS(latestBaseShift);

        // Live dynamics dashboard (torque/utilization each frame).
        try {
            dynamics = await DynamicsController.attach(model); // disposes any prior controller
            window._robcoDynamics = dynamics; // used by View-panel sliders + end-effector payload
            if (dynamics && havePendingRobot) dynamics.applyRobotPayload(pendingRobotPayload);
            if (dynamics && latestAngles) dynamics.update(latestAngles, performance.now());
        } catch (e) {
            console.error('[RobCo] dynamics dashboard failed:', e);
        }

        // Teach pendant (drag gizmo -> IK preview). Pauses the mirror while teaching.
        try {
            teach = await TeachPendant.attach(app, model);
            window._robcoTeach = teach;
            panel.setTeach(teach);
            // While posing with the gizmo, the dynamics panel follows the previewed pose.
            if (teach) teach.onPose = (deg) => dynamics?.updateStatic(deg);

            // Waypoints (capture / load flow / reorder / go-to) — world-frame, base-relative.
            if (teach && window._robcoBaseFrame) {
                const { WaypointStore } = await import('./waypointStore.js');
                const { WaypointsPanel } = await import('./WaypointsPanel.js');
                const store = WaypointStore.ensure(app.sceneManager, window._robcoBaseFrame);
                WaypointsPanel.ensure({ app, teach, base: window._robcoBaseFrame, store, client, cycleTimer });
                const { EndEffector } = await import('./EndEffector.js');
                EndEffector.ensure({ sm: app.sceneManager, model, teach, setupPanel: window._robcoSetupPanel });
                const { TcpTrace } = await import('./TcpTrace.js');
                TcpTrace.ensure({ sm: app.sceneManager, model, teach });
                const { BlenderExport } = await import('./BlenderExport.js');
                BlenderExport.ensure({ sm: app.sceneManager, model, teach });
            }
        } catch (e) {
            console.error('[RobCo] teach pendant failed:', e);
        }
    }

    // Rebuild the viewer to match a module-id list (full two-way mirror). No-op if unchanged;
    // coalesces changes that arrive mid-rebuild so we always converge on the latest.
    async function rebuildTo(ids) {
        const canon = canonicalIds(ids).join(',');
        if (!canon || canon === currentCanonical) return;
        if (building) { pendingIds = ids; return; }
        building = true;
        try {
            // Tear down the previous arm's teach before rebuilding (dynamics.attach + the ensure()
            // singletons repoint themselves; onModelLoaded disposes the old mesh).
            if (teach) { try { teach.dispose(); } catch { /* ignore */ } teach = null; }
            model = null;
            await buildAndWire(ids);
            currentCanonical = canon;
        } catch (err) {
            console.error('[RobCo] live build failed:', err);
        } finally {
            building = false;
        }
        if (pendingIds) { const next = pendingIds; pendingIds = null; rebuildTo(next); }
    }

    socket.on('robotModuleIds', (ids) => {
        panel.setRobotLive({ connected: true, ids });
        rebuildTo(ids);
    });

    socket.on('jointAngles', (angles) => {
        if (firstJa) { firstJa = false; console.log(`[RobCo] first jointAngles received (${angles?.length} joints)`); }
        latestAngles = angles;
        // Pause the mirror while teaching so dragging isn't fought by incoming angles.
        if (model && !app._teachActive) applyAnglesDeg(model, angles);
        // While teaching, the dynamics panel follows the gizmo (updateStatic), not the stream.
        if (dynamics && !app._teachActive) dynamics.update(angles, performance.now());
        if (teach) teach.syncTcp();
        // Streamed updates aren't user input, so request an on-demand frame to show them.
        app.sceneManager?.redraw();
    });

    // RobFlow's own cartesian TCP pose — used verbatim for cartesian waypoint capture, since
    // its orientation convention isn't a simple offset from our FK frame (calibration finding).
    socket.on('pose', (p) => { app._robcoLatestPose = p; });

    socket.on('baseShift', (bs) => {
        latestBaseShift = bs;
        // Single source of truth: the base shift moves the world (inverse), not the robot root.
        window._robcoBaseFrame?.setBaseShiftWS(bs);
        app.sceneManager?.redraw();
    });

    // RobFlow-reported payload — independent of the user's manual TCP load and imported gripper
    // (its own 'robot' source). Three feeds; rfApply() picks the richest and pushes it to the
    // dynamics + panel. CoM is normalized + converted mm -> m via com3(); never trust the shape.
    socket.on('payload', (p) => {
        const mass = num(p?.mass);
        rfPayload = mass > 0 ? { mass, com: com3(p?.centerOfMass), via: 'payload' } : null;
        rfPayloadAt = performance.now();
        rfApply();
    });
    socket.on('payloadInertialParameters', (p) => {
        const mass = num(p?.mass);
        if (mass > 0) {
            // Symmetric 3×3 about the CoM, end-flange frame (kg·m²).
            const inertia = [
                [num(p.ixx), num(p.ixy), num(p.ixz)],
                [num(p.ixy), num(p.iyy), num(p.iyz)],
                [num(p.ixz), num(p.iyz), num(p.izz)],
            ];
            rfInertial = { mass, com: com3(p?.centerOfMass), inertia, via: 'payloadInertialParameters' };
        } else {
            rfInertial = null;
        }
        rfInertialAt = performance.now();
        rfApply();
    });
    socket.on('robotConfig', (cfg) => { rfTools = cfg?.tools || []; rfToolsFromWs = true; rfResolveActiveTool(); rfApply(); });
    socket.on('tool', (t) => { rfActiveToolUuid = t?.toolUuid || null; rfResolveActiveTool(); rfApply(); });

    // Pull the configured tool library once up-front so the active tool can be named in the status
    // even before a `robotConfig` push arrives. Read-only; non-fatal if it fails. A live
    // `robotConfig` push is authoritative, so don't let this late REST result clobber it.
    client.getRobotConfig()
        .then((cfg) => { if (!rfToolsFromWs) { rfTools = cfg?.tools || []; rfResolveActiveTool(); rfApply(); } })
        .catch(() => { /* also delivered via the robotConfig WS message */ });

    socket.on('robotState', (d) => panel.setStates({ robotState: d }));
    socket.on('operationMode', (d) => panel.setStates({ operationMode: d }));
    socket.on('safetyState', (d) => panel.setStates({ safetyState: d }));
    socket.onStatus((state) => {
        panel.setWs(state === 'open');
        panel.setRobotLive({ connected: state === 'open' });
        // Don't average a connection gap into the rate; resume cleanly on (re)connect.
        meter.breakGap();
        if (state === 'open') {
            console.log(`[RobCo] WS open: ${redactSid(session.wsUrl)}`);
            // Persist any working cloud session so a reload auto-reconnects to THIS sid.
            // Pass null for the URL so saveSession keeps the human-readable URL the user
            // typed in the dialog (it only updates the SID here).
            if (opts.sid) {
                saveSession(null, opts.sid);
                saveToken(opts.token);
            }
        } else {
            console.log(`[RobCo] WS ${state}`);
        }
    });

    socket.connect();
    app._robflowSocket = socket; // keep a handle for teardown/debugging
    return socket;
}
