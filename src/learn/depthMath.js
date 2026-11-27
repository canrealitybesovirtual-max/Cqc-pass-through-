// @ts-check
/**
 * The depth readback's maths (v0.5, src/xr/DepthTap.js): what the GPU
 * downsample writes and how the learner worker turns it back into points.
 *
 * The GPU (DepthTap's shader; `packBlocks` below is its exact CPU mirror,
 * used by the tests) reads the session's depth texture array (layer = eye,
 * raw window depth, rows bottom-up as three's occlusion pass reads it) in
 * 40 × 40 blocks per eye and writes one RGBA8 texel per block into an
 * 80 × 40 target (eye 0 left, eye 1 right):
 *   R, G  the NEAREST valid depth in the block, in mm (16 bit);
 *   B     that texel's position in the block (3 + 3 bits) << 2 | the
 *         spread class (max − min depth: < 3 cm, < 15 cm, < 50 cm, more);
 *   A     the valid texel count × 255 / 64.
 * Keeping the nearest texel's position matters: the block centre instead
 * gives 5–12 cm errors at 3 m; this gives about 1 mm (research F5).
 *
 * The pose block (Float64Array, POSE_LEN) sent with each readback: per eye
 * the projection P (16), the view's world transform M (16), the depth info's
 * normDepthBufferFromNormView N (16), near, far, depth width, height; then
 * the head position, the time, both controller positions.
 *
 * Pure: no three.js, no DOM.
 */
import { linearParams } from '../xr/occlusionMath.js';

export const TAP = Object.freeze({ cols: 40, rows: 40, eyes: 2, sub: 8, zMin: 0.15, zMax: 6 });
export const TAP_W = TAP.cols * TAP.eyes, TAP_H = TAP.rows;
export const TAP_BYTES = TAP_W * TAP_H * 4;
/** Per-eye fields in the pose block. */
export const EYE = Object.freeze({ P: 0, M: 16, N: 32, NEAR: 48, FAR: 49, W: 50, H: 51, LEN: 52 });
export const POSE = Object.freeze({ HEAD: 2 * EYE.LEN, T: 2 * EYE.LEN + 3, CTRL: 2 * EYE.LEN + 4, EYES: 2 * EYE.LEN + 10, LEN: 2 * EYE.LEN + 12 });

/**
 * CPU mirror of the GPU downsample (tests): the raw depth image (W × H × 2 layers, rows bottom-up, layer = eye)
 * → the RGBA8 slab.
 * @param {Float32Array} raw @param {number} W @param {number} H @param {number} near @param {number} far
 * @param {Uint8Array} [out]
 */
export function packBlocks(raw, W, H, near, far, out = new Uint8Array(TAP_BYTES)) {
  const L = linearParams(near, far, { a: 0, b: 0 });
  const bw = Math.max(1, Math.floor(W / TAP.cols)), bh = Math.max(1, Math.floor(H / TAP.rows));
  const sx = Math.max(1, Math.floor(bw / TAP.sub)), sy = Math.max(1, Math.floor(bh / TAP.sub));
  for (let eye = 0; eye < TAP.eyes; eye++) {
    for (let by = 0; by < TAP.rows; by++) {
      for (let bx = 0; bx < TAP.cols; bx++) {
        let best = 1e9, zmax = 0, bi = 0, bj = 0, cnt = 0;
        for (let j = 0; j < TAP.sub; j++) for (let i = 0; i < TAP.sub; i++) {
          const px = bx * bw + i * sx, py = by * bh + j * sy;
          if (px >= W || py >= H) continue;
          const r = raw[eye * W * H + py * W + px];
          if (r <= 0 || r >= 0.999999) continue;
          const z = L.a / Math.max(L.b - r, 1e-6);
          if (z < TAP.zMin || z > TAP.zMax) continue;
          cnt++;
          if (z < best) { best = z; bi = i; bj = j; }
          if (z > zmax) zmax = z;
        }
        const mm = cnt > 0 ? Math.floor(best * 1000 + 0.5) : 0;
        const spread = zmax - best, sc = spread < 0.03 ? 0 : spread < 0.15 ? 1 : spread < 0.5 ? 2 : 3;
        const o = 4 * (by * TAP_W + eye * TAP.cols + bx);
        out[o] = Math.floor(mm / 256);
        out[o + 1] = mm % 256;
        out[o + 2] = cnt > 0 ? (bi * 8 + bj) * 4 + sc : 0;
        out[o + 3] = Math.round((cnt * 255) / 64);
      }
    }
  }
  return out;
}

/**
 * Inverse of N's 2D affine part applied to (u, v) (depth buffer → view coordinates); identity when N is.
 * @param {ArrayLike<number>} pose @param {number} o eye offset @param {number} u @param {number} v @param {Float64Array} out
 */
function unN(pose, o, u, v, out) {
  const a = pose[o + EYE.N], b = pose[o + EYE.N + 1], c = pose[o + EYE.N + 4], d = pose[o + EYE.N + 5];
  const e = pose[o + EYE.N + 12], f = pose[o + EYE.N + 13];
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-9) || (a === 1 && d === 1 && b === 0 && c === 0 && e === 0 && f === 0)) { out[0] = u; out[1] = v; return out; }
  const x = u - e, y = v - f;
  out[0] = (d * x - c * y) / det;
  out[1] = (-b * x + a * y) / det;
  return out;
}

const _uv = new Float64Array(2);

/**
 * Decode a slab into world points (session coordinates), one per valid block: out[3k..3k+2], and the sensor
 * origin of each eye in origins[3·eye..]. `rowsDown` flips the row convention (calibration); `minCount` drops
 * blocks with fewer valid texels; `maxSpread` drops edge blocks (spread class above it).
 * @param {Uint8Array} pix @param {ArrayLike<number>} pose @param {Float32Array} out @param {Float32Array} origins
 * @param {{ rowsDown?: boolean, minCount?: number, maxSpread?: number, eyeOf?: Uint8Array }} [o]
 * @returns {number} points written
 */
export function decodeSlab(pix, pose, out, origins, { rowsDown = false, minCount = 6, maxSpread = 3, eyeOf } = {}) {
  let n = 0;
  const eyes = Math.min(TAP.eyes, pose[POSE.EYES] || 1);
  for (let eye = 0; eye < eyes; eye++) {
    const e = eye * EYE.LEN;
    const W = pose[e + EYE.W], H = pose[e + EYE.H];
    if (!(W > 0 && H > 0)) continue;
    const M = e + EYE.M, P = e + EYE.P;
    origins[3 * eye] = pose[M + 12]; origins[3 * eye + 1] = pose[M + 13]; origins[3 * eye + 2] = pose[M + 14];
    const bw = Math.max(1, Math.floor(W / TAP.cols)), bh = Math.max(1, Math.floor(H / TAP.rows));
    const sx = Math.max(1, Math.floor(bw / TAP.sub)), sy = Math.max(1, Math.floor(bh / TAP.sub));
    const P0 = pose[P], P5 = pose[P + 5], P8 = pose[P + 8], P9 = pose[P + 9];
    for (let by = 0; by < TAP.rows; by++) {
      for (let bx = 0; bx < TAP.cols; bx++) {
        const q = 4 * (by * TAP_W + eye * TAP.cols + bx);
        const cnt = Math.round((pix[q + 3] * 64) / 255);
        if (cnt < minCount) continue;
        const mm = pix[q] * 256 + pix[q + 1];
        if (mm <= 0) continue;
        const B = pix[q + 2], sc = B & 3, pos = B >> 2;
        if (sc > maxSpread) continue;
        const bi = pos >> 3, bj = pos & 7;
        const ti = bx * bw + bi * sx, tj = by * bh + bj * sy;
        unN(pose, e, (ti + 0.5) / W, (tj + 0.5) / H, _uv);
        const x = 2 * _uv[0] - 1, y = rowsDown ? 1 - 2 * _uv[1] : 2 * _uv[1] - 1;
        const d = mm / 1000;
        const vx = (d * (x + P8)) / P0, vy = (d * (y + P9)) / P5, vz = -d;
        out[3 * n] = pose[M] * vx + pose[M + 4] * vy + pose[M + 8] * vz + pose[M + 12];
        out[3 * n + 1] = pose[M + 1] * vx + pose[M + 5] * vy + pose[M + 9] * vz + pose[M + 13];
        out[3 * n + 2] = pose[M + 2] * vx + pose[M + 6] * vy + pose[M + 10] * vz + pose[M + 14];
        if (eyeOf) eyeOf[n] = eye;
        n++;
      }
    }
  }
  return n;
}

/**
 * A raw depth image (tests): each eye's view of a scene given by `cast(ox, oy, oz, dx, dy, dz) → t`, rows
 * bottom-up, raw = window depth for near / far.
 * @param {ArrayLike<number>} pose @param {number} W @param {number} H
 * @param {(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => number} cast
 */
export function renderDepth(pose, W, H, cast) {
  const raw = new Float32Array(W * H * 2);
  for (let eye = 0; eye < 2; eye++) {
    const e = eye * EYE.LEN, M = e + EYE.M, P = e + EYE.P, near = pose[e + EYE.NEAR], far = pose[e + EYE.FAR];
    const P0 = pose[P], P5 = pose[P + 5], P8 = pose[P + 8], P9 = pose[P + 9];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = (2 * (i + 0.5)) / W - 1, y = (2 * (j + 0.5)) / H - 1;
      // view direction for depth 1 (z = −1)
      const vx = (x + P8) / P0, vy = (y + P9) / P5, vz = -1;
      const dx = pose[M] * vx + pose[M + 4] * vy + pose[M + 8] * vz, dy = pose[M + 1] * vx + pose[M + 5] * vy + pose[M + 9] * vz, dz = pose[M + 2] * vx + pose[M + 6] * vy + pose[M + 10] * vz;
      const t = cast(pose[M + 12], pose[M + 13], pose[M + 14], dx, dy, dz); // t along (dx, dy, dz): the view depth
      raw[eye * W * H + j * W + i] = t > 0 && t < 1e6 ? (far < Infinity ? (far * (t - near)) / (t * (far - near)) : 1 - near / t) : 0;
    }
  }
  return raw;
}
