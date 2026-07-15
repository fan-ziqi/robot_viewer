/**
 * Model import helpers shared by SceneObjects, MaterialManager and EndEffector — every import
 * slot accepts either GLB/GLTF or OBJ (+MTL +textures via multi-select or a folder pick, where
 * textures may sit in the same folder or a subfolder next to the OBJ).
 *
 * The OBJ path is a custom streaming parser: three's stock OBJLoader needs the whole file as ONE
 * string (V8 caps strings at ~1GB — a real ATF cell export is bigger) and emits non-indexed
 * geometry (~96 bytes/triangle — ~900MB of buffers for a 9.5M-triangle cell). This importer
 * instead streams the File in chunks, dedupes corners per group into INDEXED BufferGeometry,
 * finalizes each `g` group as soon as the next one starts (peak dedup memory is one group, not
 * the file), and names every mesh after its OBJ group — the MTBH parts picker keys off these.
 *
 * MTL support is delegated to three's MTLLoader (the .mtl is small), with two twists for
 * browser-local files: texture paths resolve against the co-selected files (by relative path
 * first — folder picks carry webkitRelativePath — then by basename), and map_* lines whose
 * texture wasn't provided are dropped up-front so materials fall back to their Kd color instead
 * of a never-loading black texture.
 */
import * as THREE from 'three';

class F32 {
    constructor(cap = 4096) { this.a = new Float32Array(cap); this.n = 0; }
    _grow(k) {
        if (this.n + k <= this.a.length) return;
        const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
        b.set(this.a); this.a = b;
    }
    push3(x, y, z) { this._grow(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
    push2(x, y) { this._grow(2); this.a[this.n++] = x; this.a[this.n++] = y; }
    done() { return this.a.slice(0, this.n); }
}

class U32 {
    constructor(cap = 4096) { this.a = new Uint32Array(cap); this.n = 0; }
    push(x) {
        if (this.n + 1 > this.a.length) {
            const b = new Uint32Array(this.a.length * 2);
            b.set(this.a); this.a = b;
        }
        this.a[this.n++] = x;
    }
    done() { return this.a.slice(0, this.n); }
}

const normPath = (p) => {
    try { p = decodeURIComponent(String(p)); } catch { p = String(p); }
    return p.replace(/\\/g, '/').trim().toLowerCase();
};
const basename = (p) => normPath(p).split('/').pop();
/** A file's path relative to the picked folder (folder picks) or just its name (file picks).
 *  Session-restored Files carry the relative path IN the name (multiAsset stores it that way). */
const relPath = (f) => f.webkitRelativePath || f.name;

const EMBED_CAP = 96 * 1024 * 1024; // above this, sources aren't kept for session embedding

/** Resolve MTL texture paths against a set of user-provided files: relative-path suffix match
 *  first (folder picks carry webkitRelativePath), then basename. Returns the File or null. */
function makeResolver(files) {
    const entries = files.map((f) => ({ rel: normPath(relPath(f)), f }));
    const byBase = new Map();
    for (const e of entries) if (!byBase.has(basename(e.rel))) byBase.set(basename(e.rel), e.f);
    return (path) => {
        const p = normPath(path);
        for (const e of entries) {
            if (e.rel === p || e.rel.endsWith(`/${p}`) || p.endsWith(`/${e.rel}`)) return e.f;
        }
        return byBase.get(basename(p)) || null;
    };
}

/** Texture file paths referenced by an MTL (map_* / bump / disp / decal / refl statements). */
function textureRefs(mtlText) {
    const out = [];
    for (const line of String(mtlText).split(/\r?\n/)) {
        const m = /^\s*(map_[\w]+|bump|disp|decal|refl)\s+(.+)$/i.exec(line);
        if (m) out.push(m[2].replace(/^(-\w+\s+[\d.-]+\s+)*/, '')); // strip leading numeric options
    }
    return out;
}

/** The `mtllib` reference in an OBJ's header (first 64KB — it sits at the top). */
async function objMtlRef(objFile) {
    try {
        const head = await objFile.slice(0, 65536).text();
        return /^[ \t]*mtllib[ \t]+(.+?)[ \t\r]*$/m.exec(head)?.[1] || null;
    } catch { return null; }
}

/** Choose the OBJ's material file: the one its mtllib names, else same-name, else the only one. */
export async function pickMtl(main, files) {
    const cands = files.filter((f) => /\.mtl$/i.test(f.name));
    if (!cands.length) return null;
    const ref = await objMtlRef(main);
    if (ref) {
        const hit = cands.find((f) => basename(f.name) === basename(ref));
        if (hit) return hit;
    }
    const stem = main.name.replace(/\.obj$/i, '').toLowerCase();
    return cands.find((f) => f.name.replace(/\.mtl$/i, '').toLowerCase() === stem) || cands[0];
}

// ---------------------------------------------------------------------------
// Folder memory — every folder pick is remembered (session-scoped), so a later
// bare-OBJ selection can auto-resolve its companions (.mtl + textures) with no dialog.
const _folderCache = []; // newest first: File[][]

export function rememberFolderFiles(files) {
    _folderCache.unshift([...files]);
    if (_folderCache.length > 6) _folderCache.pop();
}

// ---------------------------------------------------------------------------
// Persistent folder access (File System Access API, Chromium): folder picks made through
// showDirectoryPicker are stored as handles in IndexedDB. A later bare-OBJ pick — even in a NEW
// session — re-reads those folders silently (when the browser kept the permission; otherwise it
// asks once) and finds the .mtl + textures with no dialog at all.
const DIR_DB = 'robco-import-dirs';
const DIR_STORE = 'handles';
const DIR_MAX = 5;

function _dirDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DIR_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DIR_STORE, { keyPath: 'name' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function storeDirHandle(handle) {
    if (typeof indexedDB === 'undefined' || !handle?.name) return;
    try {
        const db = await _dirDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DIR_STORE, 'readwrite');
            const st = tx.objectStore(DIR_STORE);
            st.put({ name: handle.name, handle, ts: Date.now() });
            // keep only the most recent few
            st.getAll().onsuccess = (e) => {
                const all = e.target.result.sort((a, b) => b.ts - a.ts);
                for (const rec of all.slice(DIR_MAX)) st.delete(rec.name);
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) { console.warn('[RobCo] could not remember folder handle:', e); }
}

export async function loadDirHandles() {
    if (typeof indexedDB === 'undefined') return [];
    try {
        const db = await _dirDb();
        const recs = await new Promise((resolve, reject) => {
            const req = db.transaction(DIR_STORE).objectStore(DIR_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return recs.sort((a, b) => b.ts - a.ts).map((r) => r.handle).filter(Boolean);
    } catch { return []; }
}

/** Enumerate a directory handle into File objects carrying their relative paths. */
export async function filesFromDirHandle(handle, { maxDepth = 4, maxFiles = 4000 } = {}) {
    const out = [];
    async function walk(dir, prefix, depth) {
        if (depth > maxDepth || out.length >= maxFiles) return;
        for await (const entry of dir.values()) {
            if (out.length >= maxFiles) return;
            if (entry.kind === 'file') {
                const f = await entry.getFile();
                Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name });
                out.push(f);
            } else if (entry.kind === 'directory') {
                await walk(entry, `${prefix}${entry.name}/`, depth + 1);
            }
        }
    }
    await walk(handle, `${handle.name}/`, 0);
    return out;
}

/** Re-read every stored (and still readable) folder into the session cache.
 *  @returns {Promise<number>} folders loaded */
export async function hydrateCacheFromStoredDirs() {
    let added = 0;
    for (const handle of await loadDirHandles()) {
        try {
            let perm = await handle.queryPermission?.({ mode: 'read' });
            if (perm !== 'granted' && handle.requestPermission) {
                // needs a user gesture; inside the ＋ change handler this may or may not fly
                try { perm = await handle.requestPermission({ mode: 'read' }); } catch { /* blocked */ }
            }
            if (perm !== 'granted') continue;
            rememberFolderFiles(await filesFromDirHandle(handle));
            added += 1;
        } catch { /* stale/removed folder */ }
    }
    return added;
}

/** Find one cached file by relative path (suffix match) or basename — used by session restore
 *  to re-read files that were too big to embed from a remembered folder. */
export function getCachedFileByName(name) {
    const p = normPath(name);
    const b = basename(p);
    for (const folder of _folderCache) {
        const hit = folder.find((f) => {
            const rel = normPath(relPath(f));
            return rel === p || rel.endsWith(`/${p}`) || basename(rel) === b;
        });
        if (hit) return hit;
    }
    return null;
}

/** Find a companion check's missing files (by basename) in the remembered folders. */
export function findCompanionsInCache(check) {
    const want = [];
    if (check.expectMtl) want.push(normPath(check.expectMtl));
    for (const t of check.missingTextures || []) want.push(normPath(t));
    const found = [];
    for (const name of want) {
        for (const folder of _folderCache) {
            const hit = folder.find((f) => basename(relPath(f)) === name);
            if (hit) { found.push(hit); break; }
        }
    }
    return found;
}

/**
 * Is a selection complete? For an OBJ main: does the selection contain the MTL its `mtllib`
 * names, and every texture that MTL references? (GLB is always self-contained.)
 * @returns {Promise<{ok:boolean, main:File|null, expectMtl:string|null, missingTextures:string[]}>}
 */
export async function checkObjCompanions(files) {
    files = [...(files || [])].filter(Boolean);
    const mains = files.filter((f) => /\.(obj|glb|gltf)$/i.test(f.name));
    const main = mains.sort((a, b) => b.size - a.size)[0] || null;
    if (!main || !/\.obj$/i.test(main.name)) return { ok: true, main, expectMtl: null, missingTextures: [] };
    const mtl = await pickMtl(main, files);
    if (!mtl) {
        const ref = await objMtlRef(main);
        // no mtllib -> a bare-geometry OBJ, nothing to chase
        return ref
            ? { ok: false, main, expectMtl: basename(ref), missingTextures: [] }
            : { ok: true, main, expectMtl: null, missingTextures: [] };
    }
    const resolve = makeResolver(files.filter((f) => f !== main && f !== mtl));
    const missing = [...new Set(textureRefs(await mtl.text()).filter((p) => !resolve(p)).map(basename))];
    return { ok: missing.length === 0, main, expectMtl: null, missingTextures: missing };
}

/**
 * Build a MTLLoader MaterialCreator from raw .mtl text + user-provided sibling files.
 * Texture paths (which may point into subfolders) resolve by relative-path suffix first,
 * then by basename. Blob URLs are revoked once every referenced texture finished loading.
 * @param {string} mtlText
 * @param {File[]} resourceFiles
 * @param {{onTexturesLoaded?:()=>void}} [opts] - fires after ALL textures finished decoding —
 *        the app renders on demand, so the caller must redraw or the textures never show.
 * @returns {Promise<{creator:Object|null, missingTextures:string[]}>}
 */
export async function parseMtl(mtlText, resourceFiles = [], { onTexturesLoaded } = {}) {
    const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
    const resolve = makeResolver(resourceFiles);
    const urls = new Map(); // File -> blob URL (created on demand, revoked when all loads finish)
    const urlFor = (f) => {
        let u = urls.get(f);
        if (!u) { u = URL.createObjectURL(f); urls.set(f, u); }
        return u;
    };

    // Drop texture statements whose file wasn't provided (path after the option flags; MTL
    // texture paths may contain spaces, so "the filename" is everything after the last option).
    // Dropped ones are reported so the import status can say "use the folder import".
    const missingTextures = [];
    const filtered = mtlText.split(/\r?\n/).filter((line) => {
        const m = /^\s*(map_[\w]+|bump|disp|decal|refl)\s+(.+)$/i.exec(line);
        if (!m) return true;
        const path = m[2].replace(/^(-\w+\s+[\d.-]+\s+)*/, ''); // strip leading numeric options
        if (resolve(path)) return true;
        missingTextures.push(basename(path));
        return false;
    }).join('\n');
    if (missingTextures.length) {
        console.warn(`[RobCo] ${missingTextures.length} texture(s) not in the selection — import the OBJ's folder (📁) to include subfolders:`, missingTextures);
    }

    const dispose = () => { for (const u of urls.values()) URL.revokeObjectURL(u); };
    const manager = new THREE.LoadingManager(
        () => { dispose(); onTexturesLoaded?.(); },
        undefined,
        (url) => console.warn('[RobCo] texture failed to load:', url),
    );
    manager.setURLModifier((url) => {
        const f = resolve(url);
        return f ? urlFor(f) : url;
    });
    const loader = new MTLLoader(manager);
    const creator = loader.parse(filtered, '');
    creator.preload(); // kicks off texture loads; manager.onLoad revokes the blob URLs
    return { creator, missingTextures };
}

/**
 * Stream-parse an OBJ File into a THREE.Group of indexed meshes (one per g-group × material run).
 * @param {File} file
 * @param {Object|null} creator - MTLLoader MaterialCreator (from parseMtl) or null.
 * @param {(frac:number)=>void} [onProgress] - 0..1 by bytes consumed.
 * @returns {Promise<{group:THREE.Group, partNames:string[], maxDim:number}>}
 */
export async function importObjStream(file, creator, onProgress) {
    const group = new THREE.Group();
    group.name = file.name;

    const v = new F32(1 << 16);
    const vn = new F32(1 << 12);
    const vt = new F32(1 << 12);

    const matCache = new Map();
    const matFor = (name) => {
        const key = name || '';
        let m = matCache.get(key);
        if (m) return m;
        m = (name && creator?.create) ? creator.create(name) : null;
        if (!m) m = new THREE.MeshPhongMaterial({ color: 0xb8bec6, name: key });
        m.side = THREE.DoubleSide; // CAD exports routinely have inverted faces; culling looks broken
        // MTL spec: map_Kd REPLACES Kd, but three MULTIPLIES color into the texture — a dark Kd
        // would filter the texture's colors away. Neutralize so the texture shows as authored.
        if (m.map) {
            m.color.setRGB(1, 1, 1);
            m.map.colorSpace = THREE.SRGBColorSpace; // image textures are sRGB; untagged = washed out
        }
        matCache.set(key, m);
        return m;
    };

    const partNames = [];
    const seenNames = new Set();
    let curGroup = 'default';
    let curMtl = '';
    let bucket = null;

    const newBucket = () => ({
        map: new Map(), pos: new F32(1 << 12), nrm: new F32(1 << 12), uv: new F32(1 << 12),
        idx: new U32(1 << 12), count: 0, hasN: false, hasT: false,
        group: curGroup, mtl: curMtl,
    });

    const flush = () => {
        if (!bucket || bucket.count === 0) { bucket = null; return; }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(bucket.pos.done(), 3));
        if (bucket.hasN) geo.setAttribute('normal', new THREE.BufferAttribute(bucket.nrm.done(), 3));
        if (bucket.hasT) geo.setAttribute('uv', new THREE.BufferAttribute(bucket.uv.done(), 2));
        geo.setIndex(new THREE.BufferAttribute(bucket.idx.done(), 1));
        if (!bucket.hasN) geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, matFor(bucket.mtl));
        mesh.name = bucket.group;
        group.add(mesh);
        if (!seenNames.has(bucket.group)) { seenNames.add(bucket.group); partNames.push(bucket.group); }
        bucket = null;
    };

    // Resolve one "v/vt/vn" face corner into the current bucket, deduped by its literal token.
    const corner = (token) => {
        let e = bucket.map.get(token);
        if (e !== undefined) return e;
        let vi = 0; let ti = 0; let ni = 0;
        const s1 = token.indexOf('/');
        if (s1 < 0) {
            vi = +token;
        } else {
            vi = +token.slice(0, s1);
            const s2 = token.indexOf('/', s1 + 1);
            if (s2 < 0) ti = +token.slice(s1 + 1);
            else {
                if (s2 > s1 + 1) ti = +token.slice(s1 + 1, s2);
                ni = +token.slice(s2 + 1);
            }
        }
        // OBJ indices are 1-based; negative = relative to current count.
        vi = vi > 0 ? vi - 1 : v.n / 3 + vi;
        ti = ti > 0 ? ti - 1 : (ti < 0 ? vt.n / 2 + ti : -1);
        ni = ni > 0 ? ni - 1 : (ni < 0 ? vn.n / 3 + ni : -1);
        bucket.pos.push3(v.a[vi * 3], v.a[vi * 3 + 1], v.a[vi * 3 + 2]);
        if (ni >= 0) { bucket.nrm.push3(vn.a[ni * 3], vn.a[ni * 3 + 1], vn.a[ni * 3 + 2]); bucket.hasN = true; }
        else bucket.nrm.push3(0, 0, 1);
        if (ti >= 0) { bucket.uv.push2(vt.a[ti * 2], vt.a[ti * 2 + 1]); bucket.hasT = true; }
        else bucket.uv.push2(0, 0);
        e = bucket.count++;
        bucket.map.set(token, e);
        return e;
    };

    const parseLine = (line) => {
        if (line.length < 3) return;
        const c0 = line.charCodeAt(0);
        if (c0 === 35 /* # */) return;
        if (c0 === 118 /* v */) {
            const c1 = line.charCodeAt(1);
            const parts = line.split(/\s+/);
            if (c1 === 32) v.push3(+parts[1], +parts[2], +parts[3]);
            else if (c1 === 110) vn.push3(+parts[1], +parts[2], +parts[3]); // vn
            else if (c1 === 116) vt.push2(+parts[1], +parts[2]);            // vt
            return;
        }
        if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
            if (!bucket) bucket = newBucket();
            const parts = line.split(/\s+/);
            const n = parts.length - 1;
            if (n < 3) return;
            const i0 = corner(parts[1]);
            let iPrev = corner(parts[2]);
            for (let i = 3; i <= n; i++) { // fan-triangulate polygons
                const iCur = corner(parts[i]);
                bucket.idx.push(i0); bucket.idx.push(iPrev); bucket.idx.push(iCur);
                iPrev = iCur;
            }
            return;
        }
        if ((c0 === 103 /* g */ || c0 === 111 /* o */) && line.charCodeAt(1) === 32) {
            flush();
            curGroup = line.slice(2).trim() || 'default';
            return;
        }
        if (line.startsWith('usemtl')) {
            flush(); // material change splits the mesh; name stays = group, so parts still merge
            curMtl = line.slice(6).trim();
        }
    };

    // --- stream the file --------------------------------------------------
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let carry = '';
    let read = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        const text = carry + decoder.decode(value, { stream: true });
        let start = 0;
        for (;;) {
            const nl = text.indexOf('\n', start);
            if (nl < 0) break;
            let line = text.slice(start, nl);
            if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
            parseLine(line);
            start = nl + 1;
        }
        carry = text.slice(start);
        onProgress?.(read / file.size);
    }
    const tail = carry + decoder.decode();
    if (tail.trim()) parseLine(tail.trim());
    flush();

    const box = new THREE.Box3().setFromObject(group);
    const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    return { group, partNames, maxDim: Math.max(size.x, size.y, size.z) };
}

/**
 * Promote non-PBR import materials to MeshStandardMaterial so imports react to the scene's
 * IBL environment (scene.environment) and the Render panel's "env IBL" slider exactly like the
 * GLB robot modules do. The OBJ path (default material + MTLLoader output) produces
 * MeshPhongMaterial, which IGNORES scene.environment and has no envMapIntensity — a Phong
 * gripper/cell sits visually dead next to the env-lit robot. Roughness derives from the Phong
 * shininess so the authored MTL look survives; unlit (Basic) materials are left alone.
 * PBR materials only get their envMapIntensity aligned with the panel's current setting.
 */
export function promoteToPBR(root) {
    const envIntensity = window._robcoRenderPanel?.s?.envIntensity ?? 1.0;
    const cache = new Map(); // old material -> converted (materials are shared across meshes)
    const convert = (m) => {
        if (!m) return m;
        if ('envMapIntensity' in m) { m.envMapIntensity = envIntensity; return m; }
        if (!m.isMeshPhongMaterial && !m.isMeshLambertMaterial) return m; // keep unlit/special
        let std = cache.get(m);
        if (!std) {
            std = new THREE.MeshStandardMaterial({
                name: m.name,
                color: m.color?.clone() ?? new THREE.Color(0xb8bec6),
                map: m.map || null,
                normalMap: m.normalMap || null,
                bumpMap: m.bumpMap || null,
                bumpScale: m.bumpScale ?? 1,
                alphaMap: m.alphaMap || null,
                emissiveMap: m.emissiveMap || null,
                transparent: m.transparent,
                opacity: m.opacity,
                side: m.side,
                metalness: 0,
                roughness: Math.min(1, Math.max(0.1, 1 - Math.sqrt((m.shininess ?? 30) / 100))),
                envMapIntensity: envIntensity,
            });
            if (m.emissive) std.emissive.copy(m.emissive);
            cache.set(m, std);
        }
        return std;
    };
    root.traverse((o) => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
    });
}

/** Completely black surfaces render as holes under most lighting: lift pure-black diffuse to
 *  rgb(20,20,20) — but ONLY when the material has no color texture linked; textured materials
 *  are left exactly as authored. */
export function liftBlackMaterials(root) {
    root.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (!m?.color || m.map || m.color.getHex() !== 0x000000) continue;
            m.color.setRGB(20 / 255, 20 / 255, 20 / 255);
        }
    });
}

/** Guess a unit scale (mm/cm/m export) that lands maxDim inside [lo, hi], closest to `ideal`.
 *  Returns 1 when nothing fits (caller keeps the import as-is). */
export function guessScale(maxDim, lo, hi, ideal) {
    if (!(maxDim > 0)) return 1;
    let best = 1;
    let bestScore = Infinity;
    for (const s of [1, 0.1, 0.01, 0.001]) {
        const d = maxDim * s;
        const score = (d >= lo && d <= hi) ? Math.abs(Math.log(d / ideal)) : Infinity;
        if (score < bestScore) { best = s; bestScore = score; }
    }
    return bestScore === Infinity ? 1 : best;
}

/**
 * Load a model from a user file selection — GLB/GLTF or OBJ (+MTL +textures). Accepts a plain
 * multi-select or a whole folder pick (textures resolve from subfolders via webkitRelativePath).
 *
 * @param {File[]} files
 * @param {{onProgress?:(frac:number)=>void, onAssetsLoaded?:()=>void, preferMain?:string}} [opts]
 *        onAssetsLoaded fires when async textures finished decoding (callers redraw — on-demand
 *        renderer); preferMain names the model file to load when the set contains several.
 * @returns {Promise<{content:THREE.Object3D, main:File, isObj:boolean, partNames:string[],
 *   maxDim:number, sources:Array<{name:string,bytes:ArrayBuffer}>|null, missingTextures:string[]}>}
 *   `sources` mirrors the selection for session embedding (relative paths kept in `name`);
 *   null when the selection is too big to embed.
 */
export async function loadAnyModel(files, { onProgress, onAssetsLoaded, preferMain } = {}) {
    files = [...(files || [])].filter(Boolean);
    const mains = files.filter((f) => /\.(obj|glb|gltf)$/i.test(f.name));
    if (!mains.length) throw new Error('no .obj or .glb file in the selection');
    const main = (preferMain && mains.find((f) => f.name === preferMain))
        || mains.sort((a, b) => b.size - a.size)[0]; // folder picks may contain several
    const mtlFile = await pickMtl(main, files); // the mtllib-named / same-name one, not just any
    const resources = files.filter((f) => f !== main && f !== mtlFile && !/\.(obj|glb|gltf|mtl)$/i.test(f.name));

    // Keep raw bytes so a session save can embed the import — unless it's too big to base64.
    // sourceNames is always kept: an over-cap session save records them so a restore can re-read
    // the files from a remembered folder instead of embedding.
    const keep = [main, mtlFile, ...resources].filter(Boolean);
    const sourceNames = keep.map((f) => relPath(f));
    let sources = null;
    if (keep.reduce((s, f) => s + f.size, 0) <= EMBED_CAP) {
        try {
            sources = await Promise.all(keep.map(async (f) => ({ name: relPath(f), bytes: await f.arrayBuffer() })));
        } catch { sources = null; }
    }

    const isObj = /\.obj$/i.test(main.name);
    let content;
    let partNames = [];
    let maxDim = 0;
    let missingTextures = [];
    if (isObj) {
        let creator = null;
        if (mtlFile) {
            try { ({ creator, missingTextures } = await parseMtl(await mtlFile.text(), resources, { onTexturesLoaded: onAssetsLoaded })); }
            catch (e) { console.warn('[RobCo] MTL parse failed (using default material):', e); }
        }
        const res = await importObjStream(main, creator, onProgress);
        content = res.group;
        partNames = res.partNames;
        maxDim = res.maxDim;
    } else {
        const url = URL.createObjectURL(main);
        try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
            const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
            content = gltf.scene || gltf;
        } finally { URL.revokeObjectURL(url); }
        const box = new THREE.Box3().setFromObject(content);
        if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3());
            maxDim = Math.max(size.x, size.y, size.z);
        }
    }
    liftBlackMaterials(content);
    promoteToPBR(content); // imports must react to env IBL like the GLB robot modules
    return { content, main, isObj, partNames, maxDim, sources, sourceNames, missingTextures };
}

/**
 * Hidden file + folder inputs for an import slot. Callers wire ＋ to `fileInput.click()` and
 * 📁 to `openFolder()`, and must append both inputs to the DOM.
 *
 * Selecting a bare OBJ "just works": its mtllib-named MTL and the referenced textures are
 * auto-resolved (1) from folders already picked this session, then (2) from folders remembered
 * across sessions via stored directory handles — both silent — and only when neither knows the
 * files is the folder dialog opened. Folder picks prefer showDirectoryPicker so the handle can
 * be remembered; cancelling — or a browser that blocks the auto-opened dialog — imports the OBJ
 * without materials, with a hint to use 📁.
 *
 * @param {(files:File[], opts?:{preferMain?:string})=>void} onFiles
 * @param {{onHint?:(text:string)=>void}} [opts] - status-line messages during the guided flow.
 * @returns {{fileInput:HTMLInputElement, dirInput:HTMLInputElement, openFolder:()=>void}}
 */
export function makeFilePickers(onFiles, { onHint } = {}) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = '.obj,.mtl,.glb,.gltf,image/*';
    fileInput.style.display = 'none';
    const dirInput = document.createElement('input');
    dirInput.type = 'file';
    dirInput.style.display = 'none';
    dirInput.setAttribute('webkitdirectory', '');

    let pending = null; // { files, mainName, what } while waiting for the companion folder
    const importNow = (files, opts) => { pending = null; onFiles(files, opts); };
    const giveUp = (hint) => {
        if (!pending) return;
        const p = pending;
        onHint?.(`${p.what} missing — ${hint}`);
        importNow(p.files);
    };
    const handleFolderFiles = (folder) => {
        if (!folder.length) return;
        rememberFolderFiles(folder); // future bare-OBJ picks resolve from here silently
        if (pending) importNow([...pending.files, ...folder], { preferMain: pending.mainName });
        else onFiles(folder);
    };

    const openFolder = async () => {
        if (window.showDirectoryPicker) {
            try {
                const handle = await window.showDirectoryPicker({ mode: 'read' });
                storeDirHandle(handle); // remembered — next time no dialog is needed at all
                handleFolderFiles(await filesFromDirHandle(handle));
                return;
            } catch (e) {
                if (e?.name === 'AbortError') { giveUp('use 📁 to reload with materials'); return; }
                // SecurityError (no user activation on the auto-open) etc. -> classic input
            }
        }
        try { dirInput.click(); } catch { /* blocked */ }
    };

    fileInput.addEventListener('change', async () => {
        let files = [...(fileInput.files || [])];
        fileInput.value = '';
        if (!files.length) return;
        try {
            // Auto-complete a bare OBJ from known folders. Two passes per source — a found MTL
            // may reference textures we then also have to find.
            let check = await checkObjCompanions(files);
            const tryCache = async () => {
                for (let i = 0; i < 2 && !check.ok; i++) {
                    const extra = findCompanionsInCache(check);
                    if (!extra.length) break;
                    files = [...files, ...extra];
                    check = await checkObjCompanions(files);
                }
            };
            await tryCache();
            if (!check.ok && await hydrateCacheFromStoredDirs()) await tryCache();
            if (check.ok) return importNow(files);

            const what = check.expectMtl || `${check.missingTextures.length} texture(s)`;
            pending = { files, mainName: check.main?.name, what };
            onHint?.(`${what} not in the selection — choose the OBJ's folder…`);
            // Auto-open the folder dialog. If the browser withholds activation, nothing opens
            // (no window blur) and the timeout falls back to a material-less import.
            let dialogOpened = false;
            window.addEventListener('blur', () => {
                dialogOpened = true;
                // dialog closed without change/cancel firing (older browsers) -> fall back
                window.addEventListener('focus', () => setTimeout(() => giveUp('use 📁 to reload with materials'), 1500), { once: true });
            }, { once: true });
            openFolder();
            setTimeout(() => { if (!dialogOpened) giveUp('click 📁 and choose the OBJ’s folder to reload with materials'); }, 700);
        } catch (e) {
            console.warn('[RobCo] companion check failed:', e);
            importNow(files);
        }
    });

    dirInput.addEventListener('change', () => {
        const folder = [...(dirInput.files || [])];
        dirInput.value = '';
        handleFolderFiles(folder);
    });
    dirInput.addEventListener('cancel', () => giveUp('use 📁 to reload with materials'));

    return { fileInput, dirInput, openFolder };
}
