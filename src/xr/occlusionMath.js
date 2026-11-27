// @ts-check
/**
 * Pure maths for soft live-depth occlusion (PLAN §5, mode C). It imports
 * neither three.js nor the DOM, so `node --test` covers it. The GLSL in
 * `src/xr/DepthOcclusion.js` mirrors every function here, line for line, and
 * `tests/e2e/depth-occlusion.mjs` checks the GPU output against these
 * functions pixel by pixel.
 *
 * Depth encoding (the way three r187's occlusion pass reads it):
 *   three writes the raw depth texel straight into `gl_FragDepth`
 *   (`_occlusion_fragment`) and forces the XR camera's near/far to the depth
 *   data's `depthNear`/`depthFar` (`WebXRManager.updateCamera`). So the raw
 *   value is a window-space depth of a GL perspective projection with that
 *   near/far and `glDepthRange(0, 1)`:
 *
 *     raw = f (z − n) / (z (f − n))        z = view-space depth in metres (> 0)
 *     z   = n f / (f − raw (f − n)) = a / (b − raw),  a = n f / (f − n),  b = f / (f − n)
 *
 *   With f = Infinity (Quest 3: near 0.1, far Infinity, DEVICE_LOG) this is
 *   raw = 1 − n / z and z = n / (1 − raw), i.e. a = n, b = 1. Meta's IWER
 *   emulator writes exactly `1 − depthNear / depthM` into its R32F
 *   texture-array depth, layer = eye, rows bottom-up (iwer 2.8.0).
 *   `rawValueToMeters` is not used for GPU depth (three ignores it too).
 */

/** Smallest `b − raw` before the division (raw = 1 → "very far"). */
export const LIN_EPS = 1e-6;
/** Smallest fade band (m), so the band never divides by zero. */
export const BAND_MIN = 1e-4;
/** A fully hidden fragment (visibility below this) is discarded in fade mode. */
export const VIS_DISCARD = 0.004;

/**
 * Linearisation constants for a near/far pair (far may be Infinity).
 * @param {number} near metres (> 0)
 * @param {number} far metres (> near), or Infinity
 * @param {{ a: number, b: number }} out
 * @returns {{ a: number, b: number }} out: metres = a / (b − raw)
 */
export function linearParams(near, far, out) {
  if (!(far < Infinity) || !(far > near)) { // Infinity, NaN, or a degenerate range: infinite far plane
    out.a = near;
    out.b = 1;
  } else {
    const k = far / (far - near);
    out.a = near * k;
    out.b = k;
  }
  return out;
}

/**
 * Raw depth-buffer value → view-space depth in metres, clamped to `maxMetres`.
 * A raw value at or below `noDataRaw` counts as "no data" (= maxMetres, so it
 * hides nothing). Pass −1 to disable that (three's behaviour: raw 0 = the near
 * plane, which hides everything).
 * @param {number} raw [0, 1]
 * @param {number} a from linearParams
 * @param {number} b from linearParams
 * @param {number} maxMetres
 * @param {number} [noDataRaw]
 */
export function rawToMetres(raw, a, b, maxMetres, noDataRaw = -1) {
  if (raw <= noDataRaw) return maxMetres;
  const den = b - raw;
  const z = a / (den > LIN_EPS ? den : LIN_EPS);
  return z < maxMetres ? z : maxMetres;
}

/**
 * Inverse of rawToMetres (for tests and fake depth textures).
 * @param {number} z metres (> 0)
 * @param {number} near
 * @param {number} far metres, or Infinity
 */
export function metresToRaw(z, near, far) {
  if (!(far < Infinity) || !(far > near)) return 1 - near / z;
  return (far * (z - near)) / (z * (far - near));
}

/** GLSL `smoothstep(0, 1, t)` with the clamp. @param {number} t */
export function smooth01(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Visibility of a virtual fragment against one real depth sample: 1 = in
 * front, 0 = hidden. The fade band is centred on the real surface: 50 % at the
 * surface, fully visible band/2 in front, fully hidden band/2 behind. The band
 * may grow with distance (the sensor gets noisier): band + growth · realZ.
 * @param {number} realZ metres (sensor)
 * @param {number} fragZ metres (virtual fragment, already minus its bias)
 * @param {number} band metres (5–10 cm)
 * @param {number} growth metres of band per metre of depth (0 = fixed band)
 */
export function visibility(realZ, fragZ, band, growth) {
  const w = band + growth * realZ;
  const bw = w > BAND_MIN ? w : BAND_MIN;
  return smooth01((realZ - fragZ) / bw + 0.5);
}

/**
 * Viewport-relative UV of a fragment and its eye (texture layer), as three's
 * `_occlusion_fragment` derives it: the right eye is every fragment at or
 * right of the eye-1 viewport's x (side-by-side layout). gl_FragCoord is at
 * pixel centres (x + 0.5).
 * @param {number} fx gl_FragCoord.x
 * @param {number} fy gl_FragCoord.y
 * @param {ArrayLike<number>} vp0 eye-0 viewport [x, y, w, h] px
 * @param {ArrayLike<number>} vp1 eye-1 viewport [x, y, w, h] px (x = 1e9 for one view)
 * @param {{ eye: number, u: number, v: number }} out
 */
export function eyeUv(fx, fy, vp0, vp1, out) {
  const vp = fx >= vp1[0] ? vp1 : vp0;
  out.eye = vp === vp1 ? 1 : 0;
  out.u = (fx - vp[0]) / vp[2];
  out.v = (fy - vp[1]) / vp[3];
  return out;
}

/** @param {number} i @param {number} hi */
function clampi(i, hi) { return i < 0 ? 0 : i > hi ? hi : i; }

/**
 * Nearest texel for a UV (what NEAREST sampling and three's pass read).
 * @param {number} u @param {number} v
 * @param {number} w texels @param {number} h texels
 * @param {{ x: number, y: number }} out
 */
export function nearestTexel(u, v, w, h, out) {
  out.x = clampi(Math.floor(u * w), w - 1);
  out.y = clampi(Math.floor(v * h), h - 1);
  return out;
}

/**
 * The four texels and weights of a bilinear lookup at a UV (texel centres at
 * (i + 0.5) / size, clamp to edge).
 * @param {number} u @param {number} v
 * @param {number} w texels @param {number} h texels
 * @param {{ x0: number, y0: number, x1: number, y1: number, fx: number, fy: number }} out
 */
export function bilinearTexels(u, v, w, h, out) {
  const px = u * w - 0.5, py = v * h - 0.5;
  const ix = Math.floor(px), iy = Math.floor(py);
  out.fx = px - ix;
  out.fy = py - iy;
  out.x0 = clampi(ix, w - 1); out.x1 = clampi(ix + 1, w - 1);
  out.y0 = clampi(iy, h - 1); out.y1 = clampi(iy + 1, h - 1);
  return out;
}

/**
 * Percentage-closer filter: bilinear blend of the four per-texel visibilities
 * (soft across texel edges however large the depth step is).
 * @param {number} v00 @param {number} v10 @param {number} v01 @param {number} v11
 * @param {number} fx @param {number} fy
 */
export function pcf(v00, v10, v01, v11, fx, fy) {
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/**
 * 4×4 ordered-dither (Bayer) index 0..15 for integer pixel coordinates, by
 * bit interleaving (the same integer ops as the GLSL).
 * @param {number} x @param {number} y
 */
export function bayer4(x, y) {
  const qx = x & 3, qy = y & 3, r = qx ^ qy;
  return ((r & 1) << 3) | ((qy & 1) << 2) | (r & 2) | ((qy & 2) >> 1);
}

/** Dither threshold in (0, 1): a fragment survives when visibility ≥ it. @param {number} x @param {number} y */
export function ditherThreshold(x, y) {
  return (bayer4(x, y) + 0.5) / 16;
}
