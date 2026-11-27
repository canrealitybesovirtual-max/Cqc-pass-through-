// @ts-check
/**
 * The house frame and the house's identity (v0.5, the persistent learner).
 *
 * Everything the learner stores lives in a HOUSE frame that is the same
 * physical frame in every session, whatever the session's reference space
 * (`unbounded` starts where the session starts): the largest Space Setup
 * floor plane's pose, yaw only (its x axis projected on the floor), at the
 * plane's origin. Meta keeps Space Setup planes anchored to the room, so the
 * frame comes back session after session with no extra anchor.
 *
 * The house id is a hash of what Space Setup says about the house (floor
 * count and areas, wall count and lengths, door count), rounded so float
 * noise between sessions cannot change it; a new Space Setup scan of the
 * house gives a new id (and a fresh learned map).
 *
 * Pure: no three.js, no DOM.
 */

/** @typedef {{ label: string|null, orientation: string, pose: ArrayLike<number>, polygon: number[][] }} Plane */

/**
 * @param {string|null} l
 */
function norm(l) { return l ? l.toLowerCase().trim().replace(/[_-]+/g, ' ') : ''; }

/**
 * World points of a plane's polygon (plane space y = 0).
 * @param {Plane} p
 * @returns {{ xs: number[], ys: number[], zs: number[] }}
 */
export function planePoints(p) {
  const m = p.pose, xs = [], ys = [], zs = [];
  for (const q of p.polygon) {
    const px = q[0], pz = q[1];
    xs.push(m[0] * px + m[8] * pz + m[12]);
    ys.push(m[1] * px + m[9] * pz + m[13]);
    zs.push(m[2] * px + m[10] * pz + m[14]);
  }
  return { xs, ys, zs };
}

/** @param {number[]} xs @param {number[]} zs */
function area(xs, zs) {
  let a = 0;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) a += xs[j] * zs[i] - xs[i] * zs[j];
  return Math.abs(a / 2);
}

/**
 * The house frame of a snapshot, or null without a floor plane.
 * `m`: session → house (column-major 4×4, yaw + translation); `inv`: house → session.
 * @param {{ planes: Plane[] }|null} snap
 * @returns {{ id: string, sig: string, m: Float64Array, inv: Float64Array, floorY: number, floorArea: number }|null}
 */
export function houseFrameOf(snap) {
  if (!snap || !Array.isArray(snap.planes)) return null;
  let best = null, bestA = 0;
  const floors = [], walls = [];
  let doors = 0;
  // only Space Setup's own planes (a merged snapshot carries learned planes after `scanBase.planes`)
  const base = /** @type {any} */ (snap).scanBase;
  const nBase = base && Number.isInteger(base.planes) ? base.planes : snap.planes.length;
  for (let k = 0; k < nBase; k++) {
    const p = snap.planes[k];
    const l = norm(p.label);
    const { xs, ys, zs } = planePoints(p);
    if (p.orientation === 'horizontal' && l === 'floor') {
      const a = area(xs, zs);
      floors.push(a);
      if (a > bestA) { bestA = a; best = p; }
    } else if (p.orientation === 'vertical' && (l === 'wall' || l === 'wall face')) {
      let u0 = Infinity, u1 = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        const u = xs[i] * p.pose[0] + zs[i] * p.pose[2];
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
      }
      walls.push(u1 - u0);
      void ys;
    } else if (l === 'door' || l === 'door frame' || l === 'doorframe') doors++;
  }
  if (!best) return null;
  const P = best.pose;
  let cx = P[0], cz = P[2];
  const hl = Math.hypot(cx, cz);
  if (hl < 1e-6) { cx = 1; cz = 0; } else { cx /= hl; cz /= hl; }
  // house x axis = (cx, 0, cz) in session coords; house z = (−cz, 0, cx)... right-handed with y up: z = x × y
  // x × y = (cx,0,cz) × (0,1,0) = (−cz, 0, cx)
  const ox = P[12], oy = P[13], oz = P[14];
  const inv = new Float64Array([cx, 0, cz, 0, 0, 1, 0, 0, -cz, 0, cx, 0, ox, oy, oz, 1]); // house → session
  const m = invertRigid(inv, new Float64Array(16));
  floors.sort((a, b) => b - a);
  walls.sort((a, b) => b - a);
  const sig = `f${floors.length}:${floors.map((a) => Math.round(a * 2) / 2).join(',')};w${walls.length}:${walls.slice(0, 12).map((l) => Math.round(l * 4) / 4).join(',')};d${doors}`;
  return { id: `house-${fnv(sig)}`, sig, m, inv, floorY: oy, floorArea: bestA };
}

/**
 * Inverse of a rigid transform (rotation + translation), column-major.
 * @param {ArrayLike<number>} a @param {Float64Array} out
 */
export function invertRigid(a, out) {
  // R^T
  out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = 0;
  out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = 0;
  out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = 0;
  const tx = a[12], ty = a[13], tz = a[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
  return out;
}

/**
 * Apply a column-major 4×4 to a point (writes out[0..2]).
 * @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z @param {Float64Array|number[]} out
 */
export function apply(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** FNV-1a 32-bit as 8 hex digits. @param {string} s */
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
