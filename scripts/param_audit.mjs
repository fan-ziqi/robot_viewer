// Audit whether RobCo module descriptors carry the fields the torque/current OBSERVER needs.
//
// The observer (MujocoDynamics) reads mass/inertia/CoM, gear ratio, motor inertia, friction,
// torque constant and current limits straight off each Drive/BaseDrive descriptor. A missing,
// null, zero, or placeholder value silently degrades the reconstructed torque/current no matter
// how good the derivative stage is — so this bounds achievable fidelity.
//
// Usage:
//   node scripts/param_audit.mjs [base] [--all]
//     base   directory (default public/robco-fixtures) OR http(s) base URL (e.g.
//            https://robco.studio/modules) — the folder holding module_folder_mapping.json.
//     --all  audit every Drive/BaseDrive revision (default: only the latest non-legacy ones,
//            which are what current robots actually use — keeps remote runs to a few requests).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--all');
const ALL = process.argv.includes('--all');
const base = args[0] || 'public/robco-fixtures';
const isUrl = /^https?:\/\//.test(base);

async function loadJson(rel) {
    if (isUrl) {
        const res = await fetch(`${base}/${rel}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
    return JSON.parse(await readFile(join(base, rel), 'utf8'));
}

// --- field checks: exactly what MujocoDynamics.js reads ---------------------------------
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const mat = (v, r, c) => Array.isArray(v) && v.length === r && v.every((row) => Array.isArray(row) && row.length === c);
const vec = (v, k) => Array.isArray(v) && v.length === k && v.every(num);

/** @returns {string[]} problems for one drive descriptor (empty = fully covered). */
function auditDrive(d) {
    const p = [];
    const dyn = d.dynamics || {};
    const mp = d.module_properties || {};
    const fr = d.friction_parameters || {};
    const mo = d.motor || {};
    const g = d.gears || {};
    const k = d.kinematics || {};

    const need = (ok, label) => { if (!ok) p.push(label); };
    const pos = (v, label) => { if (!num(v)) p.push(`${label} missing`); else if (v <= 0) p.push(`${label}=${v} (≤0)`); };

    // inertia / mass (rigid-body NE)
    pos(dyn.proximal_mass, 'dyn.proximal_mass');
    need(mat(dyn.proximal_inertia, 3, 3), 'dyn.proximal_inertia !3x3');
    need(vec(dyn.proximal_center_of_mass, 3), 'dyn.proximal_center_of_mass !vec3');
    pos(dyn.distal_mass, 'dyn.distal_mass');
    need(mat(dyn.distal_inertia, 3, 3), 'dyn.distal_inertia !3x3');
    need(vec(dyn.distal_center_of_mass, 3), 'dyn.distal_center_of_mass !vec3');
    pos(dyn.motor_inertia, 'dyn.motor_inertia');
    // friction (motor model)
    if (!num(fr.friction_coulomb)) p.push('fr.friction_coulomb missing');
    if (!num(fr.friction_viscous)) p.push('fr.friction_viscous missing');
    // torque + current limits (utilisation denominators)
    pos(mp.peak_torque, 'mp.peak_torque');
    pos(mp.rated_torque, 'mp.rated_torque');
    pos(mp.max_velocity, 'mp.max_velocity');
    pos(g.ratio, 'gears.ratio');
    pos(mo.torque_constant, 'motor.torque_constant');
    pos(mo.rated_current, 'motor.rated_current');
    if (!num(mo.peak_current)) p.push('motor.peak_current missing');
    if (typeof mo.name !== 'string' || !mo.name) p.push('motor.name missing (no envelope/i²t lookup)');
    // kinematics (FK / Jacobian)
    need(mat(k.distal_transformation, 4, 4), 'kin.distal_transformation !4x4');
    return p;
}

/** @returns {string[]} data-quality warnings (present but suspect). */
function auditWarnings(d) {
    const w = [];
    const fr = d.friction_parameters || {};
    const mo = d.motor || {};
    const mp = d.module_properties || {};
    // The observer's load-dependent friction reads friction_load_dependent_quadratic — check which
    // load-dependent key (if any) the descriptor actually carries.
    const hasViewerKey = 'friction_load_dependent_quadratic' in fr;
    const hasPoly = 'friction_polynomial' in fr && fr.friction_polynomial != null;
    const hasCtrlKey = 'load_dependent_friction_coefficients' in fr;
    if (!hasViewerKey) {
        const alt = hasPoly ? 'has friction_polynomial' : hasCtrlKey ? 'has load_dependent_friction_coefficients' : 'no load-dep data';
        w.push(`load-dep friction: viewer key ABSENT (${alt}) → term is 0`);
    }
    // peak_current is read as ‰ of rated. 3000 (=3×) exactly reads like a placeholder.
    if (mo.peak_current === 3000) w.push(`motor.peak_current=3000 (‰) looks like a placeholder → i_max=3×rated`);
    if (typeof mo.datasheet_version === 'string' && /\?\?|^xx$/i.test(mo.datasheet_version.trim())) w.push(`motor.datasheet_version="${mo.datasheet_version}" (placeholder)`);
    // Round, equal coulomb==viscous integers read as nominal/uncharacterised (vs measured decimals).
    if (num(fr.friction_coulomb) && num(fr.friction_viscous)
        && Number.isInteger(fr.friction_coulomb) && fr.friction_coulomb === fr.friction_viscous) {
        w.push(`friction coulomb==viscous==${fr.friction_coulomb} (round → looks nominal, not characterised)`);
    }
    // two different "rated current" values — observer uses motor-side; drive reports vs its own.
    if (num(mo.rated_current) && num(mp.rated_current) && Math.abs(mo.rated_current - mp.rated_current) > 1e-6) {
        w.push(`rated_current motor=${mo.rated_current} vs module=${mp.rated_current} (observer uses motor-side)`);
    }
    return w;
}

async function main() {
    console.log(`=== param-coverage audit ===`);
    console.log(`source: ${base}${isUrl ? '  (remote)' : '  (local dir)'}\n`);
    const map = await loadJson('module_folder_mapping.json');
    let drives = Object.entries(map).filter(([, e]) => e.moduleType === 'Drive' || e.moduleType === 'BaseDrive');
    if (!ALL) drives = drives.filter(([, e]) => e.isLatestModuleOfName && !e.legacy);
    console.log(`${drives.length} ${ALL ? 'total' : 'latest non-legacy'} Drive/BaseDrive modules to audit\n`);

    let fetched = 0, missing = 0, clean = 0;
    const problemCounts = new Map();
    const warnCounts = new Map();
    for (const [id, e] of drives) {
        let d;
        try {
            d = await loadJson(`${e.folderName}/${e.fileName}`);
            fetched++;
        } catch (err) {
            missing++;
            console.log(`  [${id}] ${e.fullName.padEnd(16)} — descriptor UNAVAILABLE (${err.message})`);
            continue;
        }
        const probs = auditDrive(d);
        const warns = auditWarnings(d);
        for (const x of probs) problemCounts.set(x.replace(/=.*/, ''), (problemCounts.get(x.replace(/=.*/, '')) || 0) + 1);
        for (const x of warns) warnCounts.set(x.replace(/[=:].*/, ''), (warnCounts.get(x.replace(/[=:].*/, '')) || 0) + 1);
        if (probs.length === 0 && warns.length === 0) { clean++; continue; }
        const tag = probs.length ? 'GAPS' : 'warn';
        console.log(`  [${id}] ${e.fullName.padEnd(16)} ${tag}`);
        for (const x of probs) console.log(`         ✗ ${x}`);
        for (const x of warns) console.log(`         ⚠ ${x}`);
    }

    console.log(`\n=== summary ===`);
    console.log(`  audited: ${fetched}   unavailable: ${missing}   fully clean: ${clean}`);
    if (problemCounts.size) {
        console.log(`  hard gaps (missing/zero required field):`);
        for (const [k, c] of [...problemCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${c}×  ${k}`);
    } else if (fetched) {
        console.log(`  hard gaps: none — all audited drives carry every required field.`);
    }
    if (warnCounts.size) {
        console.log(`  data-quality warnings:`);
        for (const [k, c] of [...warnCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${c}×  ${k}`);
    }
}

main().catch((e) => { console.error('audit failed:', e.message); process.exit(1); });
