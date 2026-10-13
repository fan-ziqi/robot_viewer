/**
 * Regression tests for MJCF `fromto` geoms (capsule / cylinder).
 *
 * Regression: cylinder/capsule geoms with a `fromto` attribute were rendered
 * rotated 90 degrees off, because the alignment quaternion assumed the mesh's
 * long axis was +Y while createGeometryMesh() had already rotated the geometry
 * to +Z (MJCF's native geom axis). For a robot like the Unitree G1 that meant
 * thigh/shin/hip capsules showing up horizontal and the foot capsules vertical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MJCFAdapter } from '../../src/adapters/MJCFAdapter.js';

const EPS = 1e-6;

test('capsule and cylinder geometries are long along +Z', async () => {
    const capsule = await MJCFAdapter.createGeometryMesh({
        type: 'capsule',
        size: { radius: 0.05, height: 0.4 }
    });
    assert.ok(capsule, 'capsule geometry should be created');

    capsule.geometry.computeBoundingBox();
    const capsuleSize = new THREE.Vector3();
    capsule.geometry.boundingBox.getSize(capsuleSize);

    // total length = cylinder length + 2 * radius, along Z
    assert.ok(Math.abs(capsuleSize.z - 0.5) < EPS, `capsule z extent: ${capsuleSize.z}`);
    assert.ok(Math.abs(capsuleSize.x - 0.1) < EPS, `capsule x extent: ${capsuleSize.x}`);
    assert.ok(Math.abs(capsuleSize.y - 0.1) < EPS, `capsule y extent: ${capsuleSize.y}`);

    const cylinder = await MJCFAdapter.createGeometryMesh({
        type: 'cylinder',
        size: { radius: 0.05, height: 0.4 }
    });
    assert.ok(cylinder, 'cylinder geometry should be created');

    cylinder.geometry.computeBoundingBox();
    const cylinderSize = new THREE.Vector3();
    cylinder.geometry.boundingBox.getSize(cylinderSize);

    assert.ok(Math.abs(cylinderSize.z - 0.4) < EPS, `cylinder z extent: ${cylinderSize.z}`);
    assert.ok(Math.abs(cylinderSize.x - 0.1) < EPS, `cylinder x extent: ${cylinderSize.x}`);
});

test('fromto frame maps the geometry long axis onto the fromto direction', () => {
    // A sample of real geoms from the Unitree G1 MJCF (mujoco_menagerie).
    const cases = [
        [[0.02, 0, 0], [0.02, 0, -0.08]], // left_hip_collision (straight down)
        [[0, 0, -0.03], [-0.06, 0, -0.17]], // left_thigh_collision (tilted)
        [[0.01, 0, 0], [0.01, 0, -0.15]], // left_shin_collision (straight down)
        [[-0.054, 0, -0.025], [0.132, 0, -0.025]], // left_foot4_collision (forward)
        [[-0.01, 0, -0.01], [0.08, 0, -0.01]], // left_elbow_yaw_collision (forward)
        [[0.01, 0, 0.08], [0.01, 0, 0.2]], // torso_collision (straight up)
        [[0.07, 0, 0], [0.15, -0.02, 0]] // left_hand_collision (slightly sideways)
    ];

    for (const [p1, p2] of cases) {
        const from = new THREE.Vector3(...p1);
        const to = new THREE.Vector3(...p2);
        const frame = MJCFAdapter.computeFromtoFrame(p1, p2);

        // center is the midpoint of the two points
        const expectedCenter = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
        assert.ok(new THREE.Vector3().fromArray(frame.center).distanceTo(expectedCenter) < EPS,
            `center for fromto ${p1} -> ${p2}`);

        // height is the distance between the two points
        assert.ok(Math.abs(frame.height - from.distanceTo(to)) < EPS,
            `height for fromto ${p1} -> ${p2}`);

        // the quaternion must rotate the geom's +Z axis onto the fromto direction
        // (rotating +Y instead would be the 90 degree regression)
        const axis = new THREE.Vector3(0, 0, 1)
            .applyQuaternion(new THREE.Quaternion().fromArray(frame.quaternion));
        const direction = new THREE.Vector3().subVectors(to, from).normalize();
        const angle = THREE.MathUtils.radToDeg(axis.angleTo(direction));
        assert.ok(angle < 1e-3, `axis error for fromto ${p1} -> ${p2}: ${angle} degrees`);
    }
});

test('anti-parallel fromto still points along the fromto direction', () => {
    // setFromUnitVectors() has a special case when the two vectors are opposite
    const frame = MJCFAdapter.computeFromtoFrame([0, 0, 0], [0, 0, -0.08]);
    const axis = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(new THREE.Quaternion().fromArray(frame.quaternion));
    assert.ok(axis.distanceTo(new THREE.Vector3(0, 0, -1)) < EPS);
});

test('fromto attribute parsing tolerates runs of whitespace', () => {
    assert.deepEqual(
        MJCFAdapter.parseFromto('0.01 0 0 0.01 0 -0.15'),
        [0.01, 0, 0, 0.01, 0, -0.15]
    );

    // hand formatted / pretty printed attributes
    assert.deepEqual(
        MJCFAdapter.parseFromto('\n  -0.054\t0  -0.025\n  0.132   0 -0.025  '),
        [-0.054, 0, -0.025, 0.132, 0, -0.025]
    );

    // extra values are ignored, six are required
    assert.deepEqual(
        MJCFAdapter.parseFromto('1e-3 0 0 0 0 .2 0.5'),
        [0.001, 0, 0, 0, 0, 0.2]
    );
});

test('malformed fromto attributes are rejected instead of yielding NaN', () => {
    assert.equal(MJCFAdapter.parseFromto(null), null);
    assert.equal(MJCFAdapter.parseFromto(''), null);
    assert.equal(MJCFAdapter.parseFromto('0 0 0'), null, 'too few values');
    assert.equal(MJCFAdapter.parseFromto('0 0 0 0 0'), null, 'too few values');
    assert.equal(MJCFAdapter.parseFromto('0 0 0 0 0 x'), null, 'not a number');
    assert.equal(MJCFAdapter.parseFromto('0 0 0 0 0 0.2abc'), null, 'trailing garbage');
});

test('zero length fromto produces a valid identity transform', () => {
    const frame = MJCFAdapter.computeFromtoFrame([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]);

    assert.equal(frame.height, 0);
    assert.deepEqual(frame.center, [0.1, 0.2, 0.3]);
    assert.ok(frame.quaternion.every(Number.isFinite), `quaternion: ${frame.quaternion}`);
    assert.deepEqual(frame.quaternion, [0, 0, 0, 1], 'identity quaternion');

    const axis = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(new THREE.Quaternion().fromArray(frame.quaternion));
    assert.ok(axis.distanceTo(new THREE.Vector3(0, 0, 1)) < EPS);
});
