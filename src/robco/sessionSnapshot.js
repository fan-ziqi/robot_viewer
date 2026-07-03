/**
 * Session snapshot — save the entire RobCo workspace to a file and restore it later.
 *
 * What a session captures:
 *   • the robot          — as a lightweight descriptor {baseUrl, moduleIds, anglesDeg}; rebuilt
 *                          from the RobCo module CDN on load (no module GLB bytes embedded).
 *   • imported GLBs       — every end-effector tool, gripped material, and scene object (and a
 *                          custom IBL EXR/HDRI, if any) are embedded as base64, since they are
 *                          user-supplied and have no URL to re-fetch from.
 *   • everything else     — base pose, waypoints, end-effector/material/scene-object configs,
 *                          render look, environment source, camera + orbit target, view toggles,
 *                          dynamics payload — most of which already self-persists to localStorage;
 *                          we snapshot those keys.
 *
 * RESTORE STRATEGY: write the saved localStorage keys FIRST, then run the normal static build
 * (buildStaticRobco) — the RobCo panels auto-restore base pose / render / waypoints / tool config
 * / dynamics from those keys in their constructors. Then we apply the few things that don't live
 * in localStorage: joint angles, embedded GLB bytes, environment source, view toggles, camera.
 *
 * "Load" always goes through IndexedDB + a page reload (stageAndReload) so restore runs on a
 * clean page — no stale `window._robco*` singletons to tear down. The same IndexedDB record
 * powers auto-restore on a plain reload. IndexedDB (not localStorage) because embedded GLBs
 * routinely exceed localStorage's ~5MB quota.
 */
import { buildStaticRobco } from './robcoBuild.js';
import { dock } from './dock/DockManager.js';

export const FORMAT = 'robco-session';
export const VERSION = 1;

// localStorage keys that already hold per-workspace state. We snapshot/restore these verbatim so
// the existing per-panel _restore() paths rehydrate them. Theme/language/RobFlow creds are
// deliberately excluded (global prefs / sensitive).
const LS_KEYS = [
    'robco-base-pose',
    'robco-render-settings-v6',
    'robco-endeffectors',
    'robco-materials',
    'robco-scene-objects',
    'robco-waypoints',
    'robco-tcp-payload',
    'robco-dyn-motormodel',
    'robco-dyn-settings',
    'robco-camera',
    'robco-blender',
    'robco-dock-layout-v1',
];

// ---------------------------------------------------------------------------
// base64 <-> bytes
// ---------------------------------------------------------------------------
function abToB64(buf) {
    if (!buf) return null;
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits on large meshes
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function b64ToFile(asset) {
    if (!asset?.b64) return null;
    const bin = atob(asset.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], asset.name || 'asset.bin');
}

function asset(bytes, name) {
    if (!bytes) return null;
    return { name: name || 'asset.bin', b64: abToB64(bytes) };
}

// A material/scene-object import can bundle several files (OBJ + MTL + textures) — embed the
// main file plus `extras`. Items above the embed cap can't be base64'd; instead their file
// names are recorded so the restore can re-read them from a remembered folder (dir handles).
function multiAsset(it) {
    if (!it.sources?.length) {
        if (it.bytes) return asset(it.bytes, it.fileName); // item saved by an older build
        if (it.sourceNames?.length) {
            console.log(`[RobCo] session save: "${it.fileName}" too large to embed — restore will re-read it from its folder`);
            return { name: it.fileName, disk: it.sourceNames };
        }
        console.warn(`[RobCo] session save: "${it.fileName}" has nothing to embed — re-import after restore`);
        return null;
    }
    const main = it.sources.find((s) => s.name === it.fileName) || it.sources[0];
    const a = asset(main.bytes, main.name);
    if (!a) return null;
    const extras = it.sources.filter((s) => s !== main).map((s) => asset(s.bytes, s.name)).filter(Boolean);
    if (extras.length) a.extras = extras;
    return a;
}

/** Turn a saved asset back into File objects: embedded bytes, or — for over-cap imports —
 *  the original files re-read from the folders remembered via directory handles. */
async function filesFromAsset(a) {
    if (a?.b64) return [b64ToFile(a), ...(a.extras || []).map(b64ToFile)].filter(Boolean);
    if (a?.disk?.length) {
        const { hydrateCacheFromStoredDirs, getCachedFileByName } = await import('./objImport.js');
        await hydrateCacheFromStoredDirs();
        const files = a.disk.map((n) => getCachedFileByName(n)).filter(Boolean);
        if (!files.length) {
            console.warn(`[RobCo] session restore: "${a.name}" was not embedded and its folder isn't accessible — re-import it (📁)`);
        }
        return files;
    }
    return [];
}

// ---------------------------------------------------------------------------
// IndexedDB (single record) — survives reloads, no size quota in practice
// ---------------------------------------------------------------------------
const DB_NAME = 'robco-session-db';
const STORE = 'session';
const RECORD_ID = 'current';

function withStore(mode, fn) {
    return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(STORE, mode);
            const out = fn(tx.objectStore(STORE));
            tx.oncomplete = () => { db.close(); resolve(out?.result ?? null); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        };
    });
}

function idbPut(obj) { return withStore('readwrite', (s) => s.put(obj, RECORD_ID)); }
function idbGet() { return withStore('readonly', (s) => s.get(RECORD_ID)); }
function idbDel() { return withStore('readwrite', (s) => s.delete(RECORD_ID)); }

// ---------------------------------------------------------------------------
// localStorage snapshot
// ---------------------------------------------------------------------------
function captureLocalStorage() {
    const out = {};
    try {
        for (const k of LS_KEYS) {
            const v = localStorage.getItem(k);
            if (v != null) out[k] = v;
        }
        // panel positions (robco-pos-*) so the layout comes back too
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('robco-pos-')) out[k] = localStorage.getItem(k);
        }
    } catch { /* storage unavailable */ }
    return out;
}

function writeLocalStorage(map) {
    if (!map) return;
    for (const k of Object.keys(map)) {
        try { localStorage.setItem(k, map[k]); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------
const round = (v, d = 4) => { const f = 10 ** d; return Math.round(v * f) / f; };

/** Build a plain session object from the current live workspace. */
export function captureSession(app) {
    const sm = app.sceneManager;
    const model = app.currentModel || sm.currentModel || null;

    let robot = null;
    if (model?.userData?.type === 'robco') {
        const order = model.userData.jointOrder || [];
        robot = {
            source: 'robco',
            baseUrl: model.userData.baseUrl || null,
            moduleIds: model.userData.moduleIds
                || (model.userData.moduleNodes || []).map((n) => n.moduleId),
            anglesDeg: order.map((n) => round((model.joints.get(n)?.currentValue ?? 0) * 180 / Math.PI)),
        };
    }

    const ee = window._robcoEndEffector;
    const mat = window._robcoMaterialManager;
    const setup = window._robcoSetupPanel;
    const render = window._robcoRenderPanel;
    const view = window._robcoViewPanel;

    const session = {
        format: FORMAT,
        version: VERSION,
        savedAt: new Date().toISOString(),
        app: { name: 'robot-viewer' },
        robot,
        camera: {
            position: sm.camera.position.toArray().map((v) => round(v, 5)),
            target: sm.controls.target.toArray().map((v) => round(v, 5)),
            fov: sm.camera.fov,
        },
        env: { source: render?._envSource || 'studio' },
        view: {
            ...(view?.getState?.() || {}),
            ground: sm.groundPlane ? sm.groundPlane.visible : true,
        },
        localStorage: captureLocalStorage(),
        assets: {
            endEffectors: (ee?.tools || []).map((t) => multiAsset(t)).filter(Boolean),
            materials: (mat?.items || []).map((it) => multiAsset(it)).filter(Boolean),
            sceneObjects: (setup?.sceneObjects?.items || []).map((it) => multiAsset(it)).filter(Boolean),
            envMap: render?._envSource === 'custom' ? asset(render?._envBytes, render?._envFileName) : null,
        },
    };
    return session;
}

/** Rough byte size of a session's embedded assets (for a UI warning). */
export function assetsBytes(session) {
    const a = session?.assets || {};
    const size = (x) => (x?.b64 ? Math.floor(x.b64.length * 0.75) : 0);
    return Object.values(a).reduce((s, x) => s + (Array.isArray(x) ? x.reduce((s2, y) => s2 + size(y), 0) : size(x)), 0);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------
function restoreCameraOnReady(sm, cam) {
    if (!cam) return;
    let done = false;
    const apply = () => {
        if (done) return;
        done = true;
        try {
            if (Array.isArray(cam.position)) sm.camera.position.fromArray(cam.position);
            if (Array.isArray(cam.target)) sm.controls.target.fromArray(cam.target);
            if (cam.fov) { sm.camera.fov = cam.fov; sm.camera.updateProjectionMatrix(); }
            sm.controls.update();
            sm.redraw?.();
            sm.render?.();
        } catch (e) { console.warn('[RobCo] camera restore failed:', e); }
        sm.off?.('modelReady', apply);
    };
    // The model load runs fitCameraToModel and only then emits 'modelReady'; restore after it so
    // our saved view isn't clobbered. The timeout is a safety net if the event is missed.
    sm.on?.('modelReady', apply);
    setTimeout(apply, 2000);
}

/**
 * Fully restore a workspace from a session object. Assumes a clean page (no stale RobCo
 * singletons) — that is guaranteed by stageAndReload(), and is true on first paint for
 * auto-restore. Best-effort: each stage is independently guarded.
 */
export async function restoreSession(app, session) {
    if (!session || session.format !== FORMAT) {
        throw new Error('Not a RobCo session file');
    }
    if (session.version > VERSION) {
        console.warn(`[RobCo] session version ${session.version} is newer than supported (${VERSION}); restoring best-effort`);
    }
    const sm = app.sceneManager;

    // 1) Seed localStorage so the panels' own _restore() paths rehydrate base pose, render
    //    settings, waypoints, tool config and dynamics during the build below. The dock consumed
    //    localStorage at boot (before this seed), so tell it to re-read — otherwise the session's
    //    panel layout would never apply, and the dock's next _save() would clobber it.
    writeLocalStorage(session.localStorage);
    if (dock.enabled) dock.reloadLayout();

    // 2) Arm the camera restore before the model build kicks off fitCameraToModel.
    restoreCameraOnReady(sm, session.camera);

    // 3) Rebuild the robot (+ wire the full RobCo toolset). Only RobCo-descriptor robots are
    //    supported; user-file robots are out of scope for this format.
    if (session.robot?.source === 'robco' && Array.isArray(session.robot.moduleIds)) {
        const { baseUrl, moduleIds, anglesDeg } = session.robot;
        await buildStaticRobco(app, {
            baseUrl: baseUrl || '/robco-fixtures',
            moduleIds,
            anglesDeg: anglesDeg || null,
        });
    } else {
        console.warn('[RobCo] session has no RobCo robot descriptor — restoring scene state only');
    }

    // 4) Re-import the embedded GLB/EXR assets (these need the raw bytes). Each manager's own
    //    _loadPersisted() already consumed the matching config (name/transform/mass/...) from the
    //    localStorage seeded in step 1, so addFromFile() re-applies it as each asset loads, in the
    //    same order it was saved.
    const A = session.assets || {};
    if (window._robcoEndEffector) {
        for (const a of A.endEffectors || []) {
            try {
                const files = await filesFromAsset(a);
                if (files.length) await window._robcoEndEffector.addFromFiles(files, { preferMain: a.name });
            } catch (e) { console.warn('[RobCo] end-effector restore failed:', e); }
        }
    }
    if (window._robcoMaterialManager) {
        for (const a of A.materials || []) {
            try {
                const files = await filesFromAsset(a);
                if (files.length) await window._robcoMaterialManager.addFromFiles(files, { preferMain: a.name });
            } catch (e) { console.warn('[RobCo] material restore failed:', e); }
        }
    }
    if (window._robcoSetupPanel?.sceneObjects) {
        for (const a of A.sceneObjects || []) {
            try {
                const files = await filesFromAsset(a);
                if (files.length) await window._robcoSetupPanel.sceneObjects.addFromFiles(files, { preferMain: a.name });
            } catch (e) { console.warn('[RobCo] scene object restore failed:', e); }
        }
    }
    if (session.env?.source === 'custom' && A.envMap && window._robcoRenderPanel) {
        try { await window._robcoRenderPanel._loadEnvFile(b64ToFile(A.envMap)); }
        catch (e) { console.warn('[RobCo] environment restore failed:', e); }
    }

    // 5) View toggles + ground visibility.
    try {
        const { ground, ...toggles } = session.view || {};
        window._robcoViewPanel?.applyState?.(toggles);
        if (typeof ground === 'boolean') sm.setGroundVisible?.(ground);
    } catch (e) { console.warn('[RobCo] view-state restore failed:', e); }

    sm.redraw?.();
    sm.render?.();
}

// ---------------------------------------------------------------------------
// public entry points (used by SessionPanel + devLoad auto-restore)
// ---------------------------------------------------------------------------

/** Capture the current workspace, persist it for auto-restore, and return it for download. */
export async function saveSession(app) {
    const session = captureSession(app);
    try { await idbPut(session); } catch (e) { console.warn('[RobCo] could not persist session for auto-restore:', e); }
    return session;
}

/** Stage a session for restore-on-clean-page, then reload so restore runs without stale state. */
export async function stageAndReload(session) {
    if (!session || session.format !== FORMAT) throw new Error('Not a RobCo session file');
    await idbPut(session);
    location.reload();
}

/** Auto-restore the last saved session on boot. Returns true if a session was applied. */
export async function restoreLastSession(app) {
    let session = null;
    try { session = await idbGet(); } catch { return false; }
    if (!session || session.format !== FORMAT) return false;
    console.log('[RobCo] restoring saved session from', session.savedAt);
    try {
        await restoreSession(app, session);
        return true;
    } catch (e) {
        console.error('[RobCo] session restore failed:', e);
        return false;
    }
}

/** Forget the saved session so the next plain reload boots clean (e.g. to go live again). */
export async function clearSavedSession() {
    try { await idbDel(); } catch (e) { console.warn('[RobCo] clear session failed:', e); }
}

export async function hasSavedSession() {
    try { const s = await idbGet(); return !!(s && s.format === FORMAT); }
    catch { return false; }
}
