/**
 * Dev entry points for the RobCo pipeline, selected via a `?robco=` query param:
 *
 *   ?robco=fixtures                 -> bundled samples in /robco-fixtures (offline, single D86)
 *   ?robco=fixtures&ids=0001,0005   -> custom module-id chain from fixtures
 *   ?robco=live                     -> captured demo arm, built static from the public CDN
 *   ?robco=<robot_modules_url>&ids= -> any geometry base URL + id chain (static)
 *   ?robco=session&sid=<SID>        -> LIVE: connect WS, build from robotModuleIds, mirror angles
 *   ?robco=local&host=<ip>&port=8000 -> LIVE against a local robot
 *
 * Static builds go through RobCoModuleAdapter; live modes go through connectLiveSession.
 */
import { connectLiveSession } from './liveConnect.js';
import { buildStaticRobco } from './robcoBuild.js';
import { loadSession, loadToken, loadCreds } from './sessionStore.js';
import { dock } from './dock/DockManager.js';

// RobCo's public geometry CDN (Access-Control-Allow-Origin: *), no session/auth needed.
const PUBLIC_MODULES_CDN = 'https://robco.studio/modules';

// A real 6-DOF demo arm captured from a live session's `robotModuleIds` (clamps included;
// the adapter drops them). Posed to the streamed jointAngles for a lifelike preview.
const LIVE_ROBOT = {
    ids: [
        '0305', '8009', '0302', '8009', '0326', '8008', '0301', '8008', '0301',
        '8008', '0315', '8007', '0300', '8007', '0300', '8007', '1000',
    ],
    anglesDeg: [0, 45, -90, 0, 0, 0],
};

function parseIds(csv, fallback) {
    if (!csv) return fallback;
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

// Remove the original robot_viewer chrome from the DOM (top bar, side panels, editor, etc.)
// so only the 3D canvas + RobCo panels remain — a clean base for redesigning our UI. It's
// hidden from first paint by an inline script in index.html (no flash); here we delete it.
// All of main.js's post-init references to these are null-guarded. `?chrome=1` keeps it.
function removeOriginalChrome() {
    const ids = [
        'top-control-bar', 'floating-files-panel', 'floating-joints-panel',
        'floating-model-tree', 'floating-help-panel', 'mujoco-simulation-bar',
        'hover-info', 'drop-zone', 'bottom-help-bar', 'copyright-watermark',
        'help-button', 'code-editor-panel', 'code-editor-wrapper',
        'joints-panel', 'joint-controls-panel', 'graph-panel', 'model-graph-panel',
    ];
    ids.forEach((id) => document.getElementById(id)?.remove());
}

function addConnectButton(app) {
    if (window._robcoConnectBtn) return;
    const btn = document.createElement('button');
    btn.textContent = 'Connect RobFlow';
    btn.style.cssText = dock.enabled
        // topbar variant — the DockManager hosts it on the right side of the menu bar
        ? 'font:600 11px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3;' +
          'background:rgba(47,129,247,0.18);border:1px solid rgba(47,129,247,0.55);' +
          'border-radius:6px;padding:6px 11px;cursor:pointer;'
        : 'position:fixed;left:16px;top:16px;z-index:3000;font:600 12px ui-monospace,Menlo,Consolas,monospace;' +
          'color:#e6edf3;background:rgba(13,17,23,0.88);border:1px solid rgba(255,255,255,0.15);' +
          'border-radius:8px;padding:7px 12px;cursor:pointer;backdrop-filter:blur(6px);';
    btn.addEventListener('click', async () => {
        const { openConnectDialog } = await import('./ConnectUI.js');
        openConnectDialog(app);
    });
    if (dock.enabled) dock.addTopbarWidget(btn);
    else document.body.appendChild(btn);
    window._robcoConnectBtn = btn;
}

// Save / Load session panel, shown directly under the Connect button (no launcher button —
// the panel itself is the UI). Lazy-imports so the session machinery is only pulled in here.
function addSessionPanel(app) {
    import('./SessionPanel.js')
        .then(({ SessionPanel }) => SessionPanel.ensure(app)) // builds it already shown
        .catch((e) => console.warn('[RobCo] session panel failed to load:', e));
}

// Auto-reconnect the last working session on a plain reload (no ?robco= mode).
// A still-valid saved token lets us re-derive the CURRENT session SID — the stored SID can
// go stale when the cloud session is re-provisioned, which is why a reload would otherwise
// connect to a dead session (robot frozen) and require a manual reconnect. Falls back to the
// stored SID (view-only) when there's no valid token. Mirrors the Connect dialog's logic.
async function restoreSavedSession(app) {
    const saved = loadSession();
    const token = loadToken();
    if (!saved?.sid && !token) {
        console.log('[RobCo] reload: no saved session to restore');
        return;
    }
    let sid = saved?.sid || '';
    if (token) {
        try {
            const { decodeToken, fetchSession } = await import('../transport/robcoAuth.js');
            const info = decodeToken(token);
            if (info && !info.expired) {
                sid = await fetchSession(token); // current SID for this account
                console.log('[RobCo] reload: refreshed SID from saved token');
            } else {
                console.warn('[RobCo] reload: saved token expired — using stored SID (view-only)');
            }
        } catch (e) {
            console.warn('[RobCo] reload: token→SID refresh failed, using stored SID:', e);
        }
    }
    if (!sid) {
        console.warn('[RobCo] reload: no usable SID to restore');
        return;
    }
    const creds = loadCreds();
    console.log(`[RobCo] reload: auto-reconnecting ${token ? '(control)' : '(view-only)'}${creds ? ' +editor-login' : ''}`);
    try {
        await connectLiveSession(app, {
            sid, token: token || undefined,
            username: creds?.username, password: creds?.password,
        });
    } catch (e) {
        console.error('[RobCo] reload: auto-reconnect failed:', e);
    }
}

export async function maybeLoadRobCo(app) {
    window._robcoApp = app; // referenced by ViewPanel FK-drag to pause the live mirror
    const params = new URLSearchParams(location.search);
    if (params.get('chrome') !== '1') {
        removeOriginalChrome();
        dock.enable(app); // Photoshop-style docking UI (topbar + sidebars) for the RobCo panels
    }
    addConnectButton(app);
    addSessionPanel(app);
    if (!params.has('robco')) {
        // Prefer an explicitly saved workspace snapshot (full scene: robot, waypoints, tool,
        // settings, camera). If none, fall back to reconnecting the last live RobFlow session.
        try {
            const { restoreLastSession } = await import('./sessionSnapshot.js');
            if (await restoreLastSession(app)) return;
        } catch (e) {
            console.warn('[RobCo] session auto-restore failed:', e);
        }
        await restoreSavedSession(app); // reconnect the last session across reloads
        return;
    }
    const mode = params.get('robco');

    if (mode === 'connect') {
        const { openConnectDialog } = await import('./ConnectUI.js');
        return openConnectDialog(app);
    }

    // --- Live modes -------------------------------------------------------
    if (mode === 'session') {
        const sid = params.get('sid');
        if (!sid) return console.error('[RobCo] ?robco=session requires &sid=<SID>');
        return connectLiveSession(app, {
            sid,
            token: params.get('token') || undefined,
            modulesBase: params.get('base') || undefined,
        });
    }
    if (mode === 'local') {
        return connectLiveSession(app, {
            host: params.get('host') || 'localhost',
            port: Number(params.get('port') || 8000),
            secure: params.get('secure') === '1',
            token: params.get('token') || undefined,
        });
    }

    // --- Static builds ----------------------------------------------------
    let baseUrl;
    let ids;
    let anglesDeg = null;
    if (mode === 'live') {
        baseUrl = params.get('base') || PUBLIC_MODULES_CDN;
        ids = parseIds(params.get('ids'), LIVE_ROBOT.ids);
        anglesDeg = LIVE_ROBOT.anglesDeg;
    } else {
        baseUrl = !mode || mode === 'fixtures' ? '/robco-fixtures' : mode;
        ids = parseIds(params.get('ids'), ['0001']);
    }

    try {
        await buildStaticRobco(app, { baseUrl, moduleIds: ids, anglesDeg });
    } catch (err) {
        console.error('[RobCo] load failed:', err);
    }
}
