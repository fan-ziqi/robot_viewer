import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFileFromMap } from '../../src/utils/FileUtils.js';

test('package-qualified mesh paths win over duplicate basenames', () => {
    const a1Base = { name: 'base.dae', package: 'a1' };
    const go2Base = { name: 'base.dae', package: 'go2' };
    const go2wBase = { name: 'base.dae', package: 'go2w' };
    const fileMap = new Map([
        ['unitree/a1_description/meshes/base.dae', a1Base],
        ['unitree/go2_description/meshes/base.dae', go2Base],
        ['unitree/go2w_description/meshes/base.dae', go2wBase]
    ]);

    assert.equal(
        resolveFileFromMap('go2_description/meshes/base.dae', fileMap, {
            baseDir: 'go2_description/urdf/'
        }),
        go2Base
    );
    assert.equal(
        resolveFileFromMap('package://go2w_description/meshes/base.dae', fileMap),
        go2wBase
    );
});

test('an unqualified duplicate basename remains ambiguous', () => {
    const fileMap = new Map([
        ['unitree/a1_description/meshes/hip.dae', { package: 'a1' }],
        ['unitree/go2_description/meshes/hip.dae', { package: 'go2' }]
    ]);

    assert.equal(resolveFileFromMap('hip.dae', fileMap), null);
});

test('base directory disambiguates duplicate relative includes', () => {
    const go2Robot = { name: 'robot.xml', package: 'go2' };
    const go2wRobot = { name: 'robot.xml', package: 'go2w' };
    const fileMap = new Map([
        ['/unitree/go2/mjcf/robot.xml', go2Robot],
        ['/unitree/go2w/mjcf/robot.xml', go2wRobot]
    ]);

    assert.equal(
        resolveFileFromMap('robot.xml', fileMap, { baseDir: '/unitree/go2w/mjcf' }),
        go2wRobot
    );
});

test('directory identity separates unrelated files with the same basename', () => {
    const armCollision = { name: 'base_link.stl', role: 'arm-collision' };
    const robanVisual = { name: 'base_link.STL', role: 'roban-visual' };
    const fileMap = new Map([
        ['/roban_v2/meshes/arm/collision/base_link.stl', armCollision],
        ['/roban_v2/meshes/roban/base_link.STL', robanVisual]
    ]);

    assert.equal(
        resolveFileFromMap(
            'mecha_description/models/roban_v2/meshes/roban/base_link.STL',
            fileMap,
            { baseDir: '/roban_v2/urdf/' }
        ),
        robanVisual
    );
    assert.equal(
        resolveFileFromMap(
            'mecha_description/models/roban_v2/meshes/arm/collision/base_link.stl',
            fileMap,
            { baseDir: '/roban_v2/urdf/' }
        ),
        armCollision
    );
});

test('an equally specific duplicated directory path remains ambiguous', () => {
    const fileMap = new Map([
        ['/robots/a/meshes/roban/base_link.STL', { robot: 'a' }],
        ['/robots/b/meshes/roban/base_link.STL', { robot: 'b' }]
    ]);

    assert.equal(
        resolveFileFromMap('meshes/roban/base_link.STL', fileMap),
        null
    );
});

test('a longer directory match wins even when its path casing differs', () => {
    const intended = { role: 'intended' };
    const shorterExactCase = { role: 'shorter-exact-case' };
    const fileMap = new Map([
        ['/roban_v2/MESHES/roban/base_link.STL', intended],
        ['/other/roban/base_link.STL', shorterExactCase]
    ]);

    assert.equal(
        resolveFileFromMap('models/roban_v2/meshes/roban/base_link.STL', fileMap),
        intended
    );
});
