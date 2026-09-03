import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SceneManager } from '../../src/renderer/SceneManager.js';

test('renderIfNeeded submits one frame per dirty state', () => {
    let renderCount = 0;
    const manager = Object.assign(Object.create(SceneManager.prototype), {
        _dirty: false,
        _renderingPaused: false,
        renderer: {
            render() {
                renderCount++;
            }
        },
        scene: {},
        camera: {}
    });

    assert.equal(manager.renderIfNeeded(), false);
    assert.equal(renderCount, 0);

    manager.redraw();
    assert.equal(manager.renderIfNeeded(), true);
    assert.equal(manager.renderIfNeeded(), false);
    assert.equal(renderCount, 1);

    manager.redraw();
    manager.pauseRendering();
    assert.equal(manager.renderIfNeeded(), false);
    assert.equal(manager._dirty, true);

    manager.resumeRendering();
    assert.equal(manager.renderIfNeeded(), true);
    assert.equal(renderCount, 2);
});

test('application has one animation loop and uses the dirty render gate', () => {
    const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
    const sceneManagerSource = readFileSync(
        new URL('../../src/renderer/SceneManager.js', import.meta.url),
        'utf8'
    );
    const animateStart = mainSource.indexOf('    animate() {');
    const animateEnd = mainSource.indexOf('\n    }\n}', animateStart);
    const animateSource = mainSource.slice(animateStart, animateEnd);

    assert.notEqual(animateStart, -1);
    assert.match(animateSource, /sceneManager\.renderIfNeeded\(\)/);
    assert.doesNotMatch(animateSource, /sceneManager\.render\(\)/);
    assert.doesNotMatch(sceneManagerSource, /startRenderLoop\s*\(/);
});
