// @ts-check
/**
 * The head pose for this frame from the XR camera (pure: no three.js import, so
 * the audio engine and Node tests use it too).
 *
 * three r187 decomposes each XR view into `camera.cameras[i]` at the start of
 * the frame, but the ArrayCamera's own position is view 0 (the LEFT eye) until
 * `render()` recombines it (WebXRManager.onAnimationFrame / updateCamera). So
 * inside the systems the head is the midpoint of the two eye cameras, with
 * view 0's orientation (both eyes share it on Quest). Outside XR (one camera,
 * desktop warm-up) the camera's own pose is used.
 */

/**
 * @param {{ position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number },
 *   cameras?: { position: { x: number, y: number, z: number }, quaternion: { x: number, y: number, z: number, w: number } }[] }} camera
 * @param {Float64Array|Float32Array|number[]} out [px, py, pz, qx, qy, qz, qw]
 * @returns {boolean} false when there is no pose yet (all zero)
 */
export function headPose(camera, out) {
  const cams = camera.cameras;
  let q;
  if (cams && cams.length >= 2) {
    const a = cams[0].position, b = cams[1].position;
    out[0] = (a.x + b.x) * 0.5;
    out[1] = (a.y + b.y) * 0.5;
    out[2] = (a.z + b.z) * 0.5;
    q = cams[0].quaternion;
  } else {
    const p = camera.position;
    out[0] = p.x; out[1] = p.y; out[2] = p.z;
    q = camera.quaternion;
  }
  out[3] = q.x; out[4] = q.y; out[5] = q.z; out[6] = q.w;
  return !(out[0] === 0 && out[1] === 0 && out[2] === 0);
}

/**
 * Rotate (0, 0, −1) by a unit quaternion: the view direction.
 * @param {number} x @param {number} y @param {number} z @param {number} w
 * @param {Float64Array|Float32Array|number[]} out @param {number} o write offset
 */
export function quatForward(x, y, z, w, out, o) {
  out[o] = -2 * (x * z + w * y);
  out[o + 1] = 2 * (w * x - y * z);
  out[o + 2] = -(1 - 2 * (x * x + y * y));
}

/**
 * Rotate (0, 1, 0) by a unit quaternion: the head's up direction.
 * @param {number} x @param {number} y @param {number} z @param {number} w
 * @param {Float64Array|Float32Array|number[]} out @param {number} o write offset
 */
export function quatUp(x, y, z, w, out, o) {
  out[o] = 2 * (x * y - w * z);
  out[o + 1] = 1 - 2 * (x * x + z * z);
  out[o + 2] = 2 * (y * z + w * x);
}
