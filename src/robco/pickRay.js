/**
 * Projection-agnostic pick-ray setup.
 *
 * The main view's orthographic mode is FAKED: the camera stays a PerspectiveCamera and only its
 * projection matrix is overridden per frame (SceneManager._applyOrthographicProjection), so every
 * cached camera reference keeps working. Raycaster.setFromCamera() however branches on the camera
 * TYPE and casts from the camera position — wrong under parallel ortho rays, where picking then
 * misses everything away from the frustum's mid-depth. This helper derives the ray purely from
 * the projection matrix: unproject the pointer at the near and far NDC depths and aim through
 * both points. Correct for genuine perspective, genuine ortho, and the faked ortho alike
 * (projectionMatrixInverse is kept in sync by the SceneManager).
 */
import * as THREE from 'three';

const _far = new THREE.Vector3();

/** Point `raycaster` along the pointer at `ndc` ({x,y} in [-1,1]) as seen by `camera`. */
export function setRayFromCamera(raycaster, ndc, camera) {
    const ray = raycaster.ray;
    ray.origin.set(ndc.x, ndc.y, -1).unproject(camera);
    _far.set(ndc.x, ndc.y, 1).unproject(camera);
    ray.direction.copy(_far).sub(ray.origin).normalize();
    raycaster.camera = camera; // Sprite/Points raycasting reads it
}

/** True while the camera currently projects orthographically (real or faked). */
export function isOrthoProjection(camera) {
    return camera.projectionMatrix.elements[15] === 1;
}
