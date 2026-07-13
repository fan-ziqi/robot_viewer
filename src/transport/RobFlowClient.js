/**
 * Minimal RobFlow REST client (the bits the teach pendant needs to command a robot).
 *
 * Base URL forms (see transport/session.js):
 *   cloud: https://api.robco.studio/public/virtual-robot/session/{SID}/api/v3.0
 *   local: http://{host}:{port}/api/v3.0
 *
 * Auth: cloud accepts the Cognito id token as Bearer (verified) and also the in-session
 * cookie (credentials: include). Moves require the robot in TEACH mode + a safe state.
 * Angles are in DEGREES (matches RobFlow), velocity/acceleration are 0..1 fractions.
 */
export class RobFlowClient {
    /**
     * @param {string} restBase - .../api/v3.0
     * @param {Object} [opts]
     * @param {string} [opts.token] - Bearer token (cloud Cognito id token).
     */
    constructor(restBase, { token = null } = {}) {
        this.restBase = restBase.replace(/\/$/, '');
        this.token = token;
    }

    _headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.token) h.Authorization = `Bearer ${this.token}`;
        return h;
    }

    /**
     * Inner editor login (RobFlowLink pattern). The Cognito token only authorizes the OUTER
     * /status; the inner API's write endpoints (flows/import, delete, run) need the session
     * editor token, returned as `access_token` in the /login body (NOT a cookie — so it works
     * cross-origin). On success this becomes the Bearer for all subsequent inner calls.
     * @returns {Promise<string>} the access token
     */
    async login(username = 'editor', password = '') {
        const loginUrl = this.restBase.replace(/\/api\/v[\d.]+\/?$/, '/login');
        const res = await fetch(loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            credentials: 'omit',
            body: new URLSearchParams({ username, password }).toString(),
        });
        if (!res.ok) throw new Error(`/login → HTTP ${res.status} (check editor credentials)`);
        const data = await res.json();
        if (!data.access_token) throw new Error('/login returned no access_token');
        this.token = data.access_token; // replaces the Cognito token for inner-API writes
        this.loggedIn = true;
        return data.access_token;
    }

    /**
     * Pull a human-readable detail out of an error response body. FastAPI returns a JSON
     * `{detail: …}` (a string, or a 422 validation array pinpointing the bad field) — surfacing
     * it turns an opaque "HTTP 422" into something diagnosable. Best-effort; never throws.
     */
    async _detail(res) {
        try {
            const txt = await res.text();
            if (!txt) return '';
            try {
                const j = JSON.parse(txt);
                if (j && j.detail != null) {
                    return ` — ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}`;
                }
            } catch { /* body wasn't JSON */ }
            return ` — ${txt.slice(0, 400)}`;
        } catch {
            return '';
        }
    }

    async _put(path, body) {
        const res = await fetch(`${this.restBase}${path}`, {
            method: 'PUT',
            headers: this._headers(),
            // The API returns Access-Control-Allow-Origin: *, which the browser rejects with
            // credentials:'include'. Auth is the Bearer token, so omit credentials.
            credentials: 'omit',
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const hint = res.status === 401 || res.status === 403
                ? ' (missing/expired token, or robot not in TEACH mode)'
                : '';
            throw new Error(`PUT ${path} → HTTP ${res.status}${hint}${await this._detail(res)}`);
        }
        return res.status;
    }

    async _get(path) {
        const res = await fetch(`${this.restBase}${path}`, {
            headers: this._headers(),
            credentials: 'omit',
        });
        if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}${await this._detail(res)}`);
        return res.json();
    }

    /** GET /robot-config/ — also used as a lightweight API-reachability ping. */
    getRobotConfig() {
        return this._get('/robot-config/');
    }

    /** Set global speed fraction. The API accepts 0.01..1 (a 0 → HTTP 422), so clamp to that floor. */
    setGlobalSpeed(speed) {
        const v = Math.min(1, Math.max(0.01, Number.isFinite(+speed) ? +speed : 0.01));
        return this._put('/global-speed', Math.round(v * 1000) / 1000);
    }

    /** Stop any active jog motion. */
    stopJogging() {
        return this._put('/stop-jogging');
    }

    /** Jog a single joint at a velocity fraction (requires JOGGING/TEACH mode). */
    jogJoint(jointIndex, velocity) {
        return this._put('/jog-joint', { jointIndex, velocity });
    }

    /** Move to joint angles (degrees). approachMode: 1=PTP, 2=Linear. */
    moveJointAngles(anglesDeg, { velocity = 0.1, acceleration = 0.1, approachMode = 1 } = {}) {
        return this._put('/move-joint-angles', [
            { pose: { jointAngles: anglesDeg }, velocity, acceleration, approachMode },
        ]);
    }

    /** Move the TCP to a Cartesian pose. position mm, orientation deg. */
    moveCartesian(position, orientation, { velocity = 0.1, acceleration = 0.1 } = {}) {
        return this._put('/move-cartesian', [
            { pose: { position, orientation }, velocity, acceleration },
        ]);
    }

    /** Desired robot state: 2 = OPERATIONAL. */
    setDesiredRobotState(state) {
        return this._put('/desired-robot-state', state);
    }

    /** Emergency stop — halts motion. */
    stop() {
        return this._put('/stop');
    }

    async _post(path, body) {
        const res = await fetch(`${this.restBase}${path}`, {
            method: 'POST',
            headers: this._headers(),
            credentials: 'omit',
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}${await this._detail(res)}`);
        return res.json();
    }

    async _patch(path, body) {
        const res = await fetch(`${this.restBase}${path}`, {
            method: 'PATCH',
            headers: this._headers(),
            credentials: 'omit',
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`PATCH ${path} → HTTP ${res.status}${await this._detail(res)}`);
        return res.status === 204 ? null : res.json().catch(() => null);
    }

    async _delete(path) {
        const res = await fetch(`${this.restBase}${path}`, {
            method: 'DELETE', headers: this._headers(), credentials: 'omit',
        });
        if (!res.ok) throw new Error(`DELETE ${path} → HTTP ${res.status}${await this._detail(res)}`);
        return res.status;
    }

    /** POST /flows/ — create a variable-free flow (NewFlow); returns the created flow. */
    createFlow(flow) {
        return this._post('/flows/', flow);
    }

    /**
     * POST /flows/import — create a flow that carries its own variables[] (EximFlow).
     * Required for variable-bound movement nodes. Re-importing a flow whose variables already
     * exist by NAME throws HTTP 500 — use fresh per-push names or deleteVariable() first.
     */
    importFlow(flow) {
        return this._post('/flows/import?restore_from_backup=False', flow);
    }

    /** PUT /flows/{uuid}/run — run an existing flow. */
    runFlow(uuid) {
        return this._put(`/flows/${uuid}/run`);
    }

    /** DELETE /flows/{uuid} — remove a flow (409 while it is running). */
    deleteFlow(uuid) {
        return this._delete(`/flows/${uuid}`);
    }

    /** GET /flows/ — list flows (full Flow objects: uuid, name, nodes, edges, settings; no variables). */
    listFlows() {
        return this._get('/flows/');
    }

    /** GET /flows/{uuid} — a flow's graph (nodes/edges/settings; no variables). */
    getFlow(uuid) {
        return this._get(`/flows/${uuid}`);
    }

    /**
     * GET /flows/{uuid}/export — the full importable flow incl. variables[]. Use this to LOAD a
     * flow: it's the only read endpoint that bundles nodes + edges + the pose variables together,
     * so variable-bound movement poses can be resolved.
     */
    getExportableFlow(uuid) {
        return this._get(`/flows/${uuid}/export`);
    }

    /**
     * PATCH /flows/{uuid} — partial in-place graph update (PartialFlow: nodes/edges/groups/
     * settings/name; required field is only uuid). Used to round-trip edits back to a loaded flow
     * without re-importing. 404 if the flow no longer exists (e.g. a reset cloud session).
     */
    patchFlow(uuid, partial) {
        return this._patch(`/flows/${uuid}`, { uuid, ...partial });
    }

    /** POST /variables — create one variable (HTTP 409 if the name already exists). */
    createVariable(v) {
        return this._post('/variables', v);
    }

    /**
     * PATCH /variables/{uuid} — partial value update (e.g. {currentValue}) without re-import.
     * The body is a `dtype`-discriminated tagged union, so the patch MUST include the variable's
     * `dtype` (e.g. {dtype:'jointPose', currentValue}); omitting it → 422 (errorCode 250).
     */
    updateVariable(uuid, patch) {
        return this._patch(`/variables/${uuid}`, patch);
    }

    /** DELETE /variables/{uuid} — remove a variable (use before re-import to dodge the 500). */
    deleteVariable(uuid) {
        return this._delete(`/variables/${uuid}`);
    }
}
