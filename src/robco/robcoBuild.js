/**
 * Build a static RobCo robot from a module descriptor and wire up the full RobCo toolset
 * (render/view/setup panels, dynamics dashboard, teach pendant, waypoints, end-effector).
 *
 * This is the single source of truth for the static build-and-wire sequence. Both the dev
 * loader (`?robco=fixtures|live|<url>`) and the session-restore path call it, so a restored
 * workspace is wired identically to a freshly loaded one. A live session does its own wiring
 * in liveConnect.js (it mirrors a stream rather than a fixed pose).
 */
import { RobCoModuleAdapter } from '../adapters/RobCoModuleAdapter.js';
import { applyAnglesDeg } from './poseUtils.js';

/**
 * @param {import('../main.js').App} app
 * @param {{baseUrl:string, moduleIds:string[], anglesDeg?:number[]|null}} spec
 * @returns {Promise<{model:Object, teach:Object|null}>}
 */
export async function buildStaticRobco(app, { baseUrl, moduleIds, anglesDeg = null }) {
    console.log(`[RobCo] building robot ${JSON.stringify(moduleIds)} from ${baseUrl}`);
    const model = await RobCoModuleAdapter.build({ baseUrl, moduleIds });
    if (anglesDeg) applyAnglesDeg(model, anglesDeg);
    app.fileHandler.onModelLoaded(model, { name: 'robco-robot.robco' });
    console.log(
        `[RobCo] loaded: ${model.links.size} links, ${model.joints.size} joints`,
        model.userData.jointOrder,
    );

    try {
        const { enhanceVisuals } = await import('./enhanceVisuals.js');
        await enhanceVisuals(model, app.sceneManager);
    } catch (e) { console.warn('[RobCo] enhanceVisuals failed:', e); }

    // Dynamics dashboard (static pose -> static gravity torques).
    try {
        const { DynamicsController } = await import('../dynamics/DynamicsController.js');
        const ctrl = await DynamicsController.attach(model);
        if (ctrl) {
            const a = anglesDeg || (model.userData.jointOrder || []).map(() => 0);
            ctrl.update(a, performance.now());
            window._robcoDynamics = ctrl;
        }
    } catch (e) {
        console.error('[RobCo] dynamics dashboard failed:', e);
    }

    // Teach tools panel (gizmo + IK preview). No client in static mode → preview only.
    let teach = null;
    try {
        const { TeachPendant } = await import('./TeachPendant.js');
        const { RobFlowToolsPanel } = await import('./RobFlowToolsPanel.js');
        // Dispose a prior teach (TeachPendant.attach isn't idempotent) so repeated static builds —
        // e.g. loading different sample robots from the Robot Config panel — don't leak a gizmo /
        // MuJoCo kinematics instance.
        try { window._robcoTeach?.dispose?.(); } catch { /* ignore */ }
        teach = await TeachPendant.attach(app, model);
        window._robcoTeach = teach;
        // Reuse the existing tools panel across rebuilds (e.g. loading another sample robot from its
        // Robot Config section) — otherwise each build would stack a duplicate panel and reset the
        // section. Just re-point its teach engine.
        if (window._robcoPanel) window._robcoPanel.setTeach(teach);
        else window._robcoPanel = new RobFlowToolsPanel(app, { teach, client: null });
        // Dragging the gizmo -> recompute the dynamics panel for the posed arm.
        if (teach) teach.onPose = (deg) => window._robcoDynamics?.updateStatic?.(deg);

        // Waypoints (capture / load flow / reorder / go-to) — preview only without a client.
        if (teach && window._robcoBaseFrame) {
            const { WaypointStore } = await import('./waypointStore.js');
            const { WaypointsPanel } = await import('./WaypointsPanel.js');
            const store = WaypointStore.ensure(app.sceneManager, window._robcoBaseFrame);
            WaypointsPanel.ensure({ app, teach, base: window._robcoBaseFrame, store, client: null });
            const { EndEffector } = await import('./EndEffector.js');
            EndEffector.ensure({ sm: app.sceneManager, model, teach, setupPanel: window._robcoSetupPanel });
            const { TcpTrace } = await import('./TcpTrace.js');
            TcpTrace.ensure({ sm: app.sceneManager, model, teach });
            const { BlenderExport } = await import('./BlenderExport.js');
            BlenderExport.ensure({ sm: app.sceneManager, model, teach });
        }
    } catch (e) {
        console.error('[RobCo] teach tools failed:', e);
    }

    return { model, teach };
}
