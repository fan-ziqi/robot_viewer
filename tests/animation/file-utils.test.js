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
