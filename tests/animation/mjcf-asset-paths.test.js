import test from 'node:test';
import assert from 'node:assert/strict';

import { MJCFAdapter } from '../../src/adapters/MJCFAdapter.js';
import { resolveFileFromMap } from '../../src/utils/FileUtils.js';

function element(attributes = {}) {
    return {
        getAttribute(name) {
            return Object.hasOwn(attributes, name) ? attributes[name] : null;
        }
    };
}

test('MJCF mesh assets retain compiler meshdir and model directory', () => {
    const compiler = element({ meshdir: 'assets' });
    const meshes = [element({ file: 'calf.stl' })];
    const asset = { querySelectorAll: selector => selector === 'mesh' ? meshes : [] };
    const doc = {
        querySelector(selector) {
            if (selector === 'compiler') return compiler;
            if (selector === 'asset') return asset;
            return null;
        }
    };

    const meshMap = MJCFAdapter.parseAssets(
        doc,
        null,
        null,
        '/go2w_description/mjcf'
    );

    const calfAsset = meshMap.get('calf');
    assert.deepEqual(calfAsset, {
        type: 'file',
        path: 'go2w_description/mjcf/assets/calf.stl',
        scale: [1, 1, 1]
    });

    const mjcfCalf = { name: 'calf.stl', source: 'mjcf' };
    const urdfCalf = { name: 'calf.stl', source: 'urdf' };
    const fileMap = new Map([
        ['/go2w_description/mjcf/assets/calf.stl', mjcfCalf],
        ['/go2w_description/meshes/calf.stl', urdfCalf]
    ]);
    assert.equal(resolveFileFromMap(calfAsset.path, fileMap), mjcfCalf);
});

test('MJCF asset paths without meshdir remain relative to the model', () => {
    assert.equal(
        MJCFAdapter.resolveAssetFilePath('meshes/base.obj', 'robots/go2'),
        'robots/go2/meshes/base.obj'
    );
});
