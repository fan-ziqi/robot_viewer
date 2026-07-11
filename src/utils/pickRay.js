/**
 * Drop-in replacement for THREE.Raycaster.setFromCamera that respects SceneManager's faked
 * orthographic projection.
 *
 * In ortho mode the main camera stays a PerspectiveCamera — only its projection matrix is
 * overwritten (see SceneManager.setProjectionMode / _applyOrthographicProjection) so every
 * consumer holding a camera reference keeps working. Raycaster.setFromCamera, however, branches
 * on `camera.isPerspectiveCamera`, and unprojecting a perspective-style ray through the ortho
 * matrix collapses every pick to a near-constant ray through the screen centre — breaking all
 * picking/dragging while ortho is active. Build the orthographic ray explicitly instead (same
 * math as Raycaster's own ortho branch: origin unprojected onto the near plane, direction along
 * the view axis).
 */
export function setRayFromCamera(raycaster, ndc, camera) {
    if (camera.isPerspectiveCamera && camera.userData?.projectionMode === 'orthographic') {
        raycaster.ray.origin
            .set(ndc.x, ndc.y, (camera.near + camera.far) / (camera.near - camera.far))
            .unproject(camera);
        raycaster.ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
        raycaster.camera = camera;
        return raycaster;
    }
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
}
