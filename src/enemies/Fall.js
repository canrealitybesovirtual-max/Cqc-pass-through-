// @ts-check
/**
 * Which way a dying soldier falls (pure: no three.js; allocation-free).
 * Gap audit F5: bodies fell along the bullet's path whatever was there, so
 * they fell through real walls and sofas.
 *
 * Candidates, in order of preference: the shot direction with a random
 * scatter (±25°: variety when there is room), the shot direction itself,
 * ±60° from it, and back toward the shooter. Each is scored over the first
 * 1.2 m from where he stands (a body lies about that far from its feet):
 *   - floor: 4 points at 0.3, 0.6, 0.9 and 1.2 m must be on floor cells (mapped
 *     or virtual floor, or a carved door gap), not a wall or furniture
 *     footprint, with ≥ 0.15 m of clearance beyond the first (the torso's
 *     half-width); the first blocked point ends the count;
 *   - sight lines (world.segmentClear) at shin height (0.3 m) along the floor,
 *     and the arc of the fall: from chest height (1.2 m) at his feet down to
 *     0.25 m at the far end (a table top or a sofa back in the way).
 * The first candidate with a clear floor and both lines wins; otherwise the
 * best-scoring one (ties keep the order above).
 */

import { NAV_DOOR, NAV_INSIDE, NAV_OBST, NAV_WALL } from '../world/NavGrid.js';

export const FALL = Object.freeze({
  len: 1.2, // m: feet to the far end of a body lying on the floor
  samples: 4,
  minClear: 0.15, // m: clearance at the samples past the first (the torso's half-width)
  lowY: 0.3, // m above his floor: shins, sofa seats, bed sides
  arcY0: 1.2, arcY1: 0.25, // m: the falling torso's chord, feet end to far end
  side: Math.PI / 3, // ±60°
  scatter: 0.9, // rad: total spread of the random scatter (±25°)
});

/** Candidate rotations from the shot direction (index 0 is filled with the scatter). */
const ROT = new Float64Array([0, 0, FALL.side, -FALL.side, Math.PI]);
const FULL = 2 * FALL.samples + 2;
/** The score of a clear fall (every floor sample and both sight lines). */
export const FALL_FULL = FULL;

/**
 * @typedef {{ nav: import('../world/NavGrid.js').NavGrid,
 *   segmentClear: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean,
 *   floorY: (x: number, z: number) => number }} FallWorld
 */

/**
 * Score of a fall from (x, z) along the unit direction (dx, dz): 2 per floor
 * sample before the first blocked one, plus 1 per clear sight line. The
 * maximum (FALL_FULL) means a clear 1.2 m.
 * @param {FallWorld} world @param {number} x @param {number} z @param {number} fy floor height
 * @param {number} dx @param {number} dz
 * @returns {number} 0 … FALL_FULL
 */
export function fallScore(world, x, z, fy, dx, dz) {
  const nav = world.nav, step = FALL.len / FALL.samples;
  let k = 0;
  for (; k < FALL.samples; k++) {
    const d = step * (k + 1);
    const i = nav.index(x + dx * d, z + dz * d);
    if (i < 0) break;
    const f = nav.flags[i];
    if ((f & (NAV_INSIDE | NAV_DOOR)) === 0 || (f & (NAV_WALL | NAV_OBST)) !== 0) break;
    if (k > 0 && nav.clr[i] < FALL.minClear) break;
  }
  let s = 2 * k;
  const ex = x + dx * FALL.len, ez = z + dz * FALL.len;
  if (world.segmentClear(x, fy + FALL.lowY, z, ex, fy + FALL.lowY, ez)) s++;
  if (world.segmentClear(x, fy + FALL.arcY0, z, ex, fy + FALL.arcY1, ez)) s++;
  return s;
}

/**
 * Choose the fall direction for a soldier standing at (x, z) hit by a round
 * travelling (dx, dz) (any length; the horizontal part is used).
 * @param {FallWorld|null} world
 * @param {number} x @param {number} z
 * @param {number} dx @param {number} dz
 * @param {number} scatter rad added to the first candidate (e.g. (rand − 0.5) · FALL.scatter)
 * @param {Float64Array} out receives the unit direction [x, z] and, at [2], the score
 * @returns {number} the candidate used: 0 scattered shot, 1 shot, 2 / 3 ±60°, 4 back toward the shooter
 */
export function chooseFall(world, x, z, dx, dz, scatter, out) {
  let l = Math.sqrt(dx * dx + dz * dz);
  if (!(l > 1e-6)) { dx = 0; dz = -1; l = 1; }
  dx /= l; dz /= l;
  ROT[0] = Number.isFinite(scatter) ? scatter : 0;
  if (!world || !world.nav) {
    const c = Math.cos(ROT[0]), s = Math.sin(ROT[0]);
    out[0] = dx * c - dz * s; out[1] = dx * s + dz * c; out[2] = FULL;
    return 0;
  }
  const fy = world.floorY(x, z);
  let best = -1, bi = 0;
  for (let k = 0; k < ROT.length; k++) {
    const c = Math.cos(ROT[k]), s = Math.sin(ROT[k]);
    const cx = dx * c - dz * s, cz = dx * s + dz * c;
    const sc = fallScore(world, x, z, fy, cx, cz);
    if (sc > best) { best = sc; bi = k; out[0] = cx; out[1] = cz; }
    if (sc >= FULL) break;
  }
  out[2] = best;
  return bi;
}
