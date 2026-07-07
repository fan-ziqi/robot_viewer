/**
 * Shared MTBH ("material to be handled") helpers used by SceneObjects (which owns the parts
 * picker — cell files import there, parts get marked) and MaterialManager (which owns the
 * gripper: grip point, output routing, closest-candidate selection, reset).
 *
 * An MTBH grip candidate is an "entry": a named set of nodes plus the home (parent + local
 * transform) captured when it was marked, so it can be released in place or reset to default.
 */
import * as THREE from 'three';

/** Map part name -> nodes. OBJ meshes carry their g-group name; for GLB an unnamed mesh
 *  falls back to its nearest named ancestor (typical exporter structure). */
export function collectParts(content) {
    const map = new Map();
    const add = (name, node) => {
        let arr = map.get(name);
        if (!arr) { arr = []; map.set(name, arr); }
        if (!arr.includes(node)) arr.push(node);
    };
    content.traverse((o) => {
        if (!o.isMesh) return;
        let n = o;
        while (n && n !== content && !n.name) n = n.parent;
        if (n && n !== content && n.name) add(n.name, n);
    });
    return map;
}

/** Parse a digital-output reference as typed in the End-Effector's output field:
 *  "1/0" (also 1.0 / 1:0) = bank 1, io 0; a plain "3" = bank 0, io 3. Anything else (a free
 *  name like "Gripper") returns null — those only work via messageLog texts / the sim toggle. */
export function parseOutputRef(s) {
    const m = /^\s*(\d+)\s*[/.:,]\s*(\d+)\s*$/.exec(s || '');
    if (m) return { bank: +m[1], io: +m[2] };
    const n = /^\s*(\d+)\s*$/.exec(s || '');
    if (n) return { bank: 0, io: +n[1] };
    return null;
}

/** Names matching an auto-mark pattern — regex if it compiles, else case-insensitive substring. */
export function autoMatch(pattern, names) {
    const p = (pattern || '').trim();
    if (!p) return [];
    let re = null;
    try { re = new RegExp(p, 'i'); } catch { /* fall back to substring */ }
    return names.filter((n) => (re ? re.test(n) : n.toLowerCase().includes(p.toLowerCase())));
}

/** Build an entry for `nodes`, capturing their current parent + local transform as "home". */
export function makeEntry(name, nodes) {
    return {
        name,
        nodes,
        homes: nodes.map((n) => ({
            parent: n.parent,
            pos: n.position.clone(), quat: n.quaternion.clone(), scale: n.scale.clone(),
        })),
        gripped: false,
        seq: 0,
    };
}

/** Attach the entry to the gripper, preserving world pose (no visual snap). */
export function gripEntry(entry, attachPoint, seq) {
    for (const n of entry.nodes) attachPoint.attach(n);
    entry.gripped = true;
    entry.seq = seq;
}

/** Release in place — back to the home parent, world pose preserved (dropped where it is). */
export function releaseEntry(entry, fallbackParent) {
    for (let i = 0; i < entry.nodes.length; i++) {
        (entry.homes[i]?.parent || fallbackParent).attach(entry.nodes[i]);
    }
    entry.gripped = false;
}

/** Hard reset to the captured default pose (home parent + home local transform). */
export function resetEntry(entry) {
    for (let i = 0; i < entry.nodes.length; i++) {
        const h = entry.homes[i];
        if (!h) continue;
        h.parent.add(entry.nodes[i]);
        entry.nodes[i].position.copy(h.pos);
        entry.nodes[i].quaternion.copy(h.quat);
        entry.nodes[i].scale.copy(h.scale);
    }
    entry.gripped = false;
}

/** Distance from a world point to the entry's bbox (0 when inside) + centre tie-breaker. */
export function entryDistance(entry, gp) {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const n of entry.nodes) {
        tmp.setFromObject(n);
        if (!tmp.isEmpty()) box.union(tmp);
    }
    if (box.isEmpty()) return { d: Infinity, dc: Infinity };
    return { d: box.distanceToPoint(gp), dc: box.getCenter(new THREE.Vector3()).distanceTo(gp) };
}

/** Emissive tint marking MTBH parts (blue) or the hovered pick candidate (orange) in the
 *  viewport. Clones materials once per mesh so the tint can't bleed into other parts sharing
 *  an MTL material. Re-tinting with another color keeps the ORIGINAL emissive for restore. */
export function tintNodes(nodes, on, colorHex = 0x1f6feb, intensity = 0.45) {
    for (const node of nodes) {
        node.traverse((o) => {
            if (!o.isMesh) return;
            if (on && !o.userData.__matCloned) {
                o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
                o.userData.__matCloned = true;
            }
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                if (!m.emissive) continue;
                if (on) {
                    if (m.userData.__origEmissive === undefined) m.userData.__origEmissive = m.emissive.getHex();
                    m.emissive.setHex(colorHex);
                    m.emissiveIntensity = intensity;
                } else if (m.userData.__origEmissive !== undefined) {
                    m.emissive.setHex(m.userData.__origEmissive);
                    m.emissiveIntensity = 1;
                    delete m.userData.__origEmissive;
                }
            }
        });
    }
}
