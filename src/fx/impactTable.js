// @ts-check
/**
 * What a bullet strike looks and sounds like on each real surface (pure: no
 * three.js; Node-tested). research-look §4 / R5 and the CQC lessons (fabric
 * takes a small hole, a stuffing puff and a soft thud; wood splinters;
 * plaster gives a torn paper ring and white dust).
 *
 * Surfaces come from the world raycast's `surface` label: Space Setup labels
 * for walls, doors, furniture boxes and the global mesh's owning furniture
 * ('wall', 'door', 'table', 'couch', 'bed', 'shelf', 'screen', …), or the mesh
 * class ('floor', 'wall', 'ceiling', 'soft', 'hard', 'other'). The floor's
 * material is not in Space Setup: a per-house setting (wood / carpet / tile).
 *
 * Sounds come from the existing bank only (assets/manifest.json): plaster is
 * the recorded impPla set; wood, doors and tile reuse it pitched down / up;
 * fabric is the flesh impact pitched up and quiet with a cloth rustle; metal
 * and glass add a pitched-down brass ring.
 */

/** Impact kinds (recipes below). */
export const IMP = Object.freeze({
  PLASTER: 0, CEILING: 1, DOOR: 2, WOOD: 3, COUCH: 4, BED: 5, METAL: 6, GLASS: 7,
  FLOOR_WOOD: 8, FLOOR_CARPET: 9, FLOOR_TILE: 10,
});
export const IMP_NAMES = Object.freeze(['plaster', 'ceiling', 'door', 'wood', 'couch', 'bed', 'metal', 'glass', 'floorWood', 'floorCarpet', 'floorTile']);

/** Decal atlas cells (decalAtlas.js): 4 × 2 grid. */
export const CELL = Object.freeze({ PLASTER_A: 0, PLASTER_B: 1, WOOD_A: 2, WOOD_B: 3, FABRIC_A: 4, FABRIC_B: 5, METAL: 6, GLASS: 7 });
export const ATLAS_COLS = 4, ATLAS_ROWS = 2, ATLAS_CELLS = 8;

/** Particle kinds (Impacts.js draws each with its own shape and colour). */
export const PK = Object.freeze({ DUST: 0, CHIP: 1, SPLINTER: 2, WOOD_DUST: 3, FOAM: 4, FEATHER: 5, GLINT: 6, DARK_DUST: 7 });
export const PK_COUNT = 8;

/**
 * Per particle kind: drag (1/s), gravity (m/s²), size (m) min / max, growth (×/s),
 * life (s) min / max, shape (0 soft blob, 1 chip, 2 sliver, 3 feather, 4 glint),
 * aspect (length / width), spin (rad/s max), flutter (m/s side sway), and the
 * albedo (sRGB) lit by the room light.
 * @type {ReadonlyArray<Readonly<{ drag: number, g: number, s0: number, s1: number, grow: number, life0: number, life1: number,
 *   shape: number, aspect: number, spin: number, flutter: number, rgb: readonly number[], alpha: number }>>}
 */
export const PKIND = Object.freeze([
  Object.freeze({ drag: 4.5, g: 0.35, s0: 0.035, s1: 0.07, grow: 1.6, life0: 0.6, life1: 1.2, shape: 0, aspect: 1, spin: 0.6, flutter: 0, rgb: Object.freeze([0.88, 0.86, 0.82]), alpha: 0.55 }),
  Object.freeze({ drag: 0.6, g: 9.81, s0: 0.004, s1: 0.009, grow: 0, life0: 0.5, life1: 0.9, shape: 1, aspect: 1.3, spin: 18, flutter: 0, rgb: Object.freeze([0.93, 0.92, 0.89]), alpha: 1 }),
  Object.freeze({ drag: 0.8, g: 9.81, s0: 0.006, s1: 0.016, grow: 0, life0: 0.5, life1: 1.0, shape: 2, aspect: 4, spin: 14, flutter: 0, rgb: Object.freeze([0.66, 0.5, 0.33]), alpha: 1 }),
  Object.freeze({ drag: 4, g: 0.6, s0: 0.03, s1: 0.06, grow: 1.2, life0: 0.5, life1: 1.0, shape: 0, aspect: 1, spin: 0.6, flutter: 0, rgb: Object.freeze([0.56, 0.44, 0.31]), alpha: 0.5 }),
  Object.freeze({ drag: 3, g: 2.2, s0: 0.006, s1: 0.012, grow: 0, life0: 0.9, life1: 1.6, shape: 0, aspect: 1, spin: 3, flutter: 0.05, rgb: Object.freeze([0.85, 0.83, 0.76]), alpha: 0.95 }),
  Object.freeze({ drag: 5.5, g: 1.7, s0: 0.016, s1: 0.03, grow: 0, life0: 2.0, life1: 4.0, shape: 3, aspect: 2.2, spin: 2.5, flutter: 0.22, rgb: Object.freeze([0.96, 0.95, 0.93]), alpha: 1 }),
  Object.freeze({ drag: 0.4, g: 9.81, s0: 0.006, s1: 0.014, grow: 0, life0: 0.12, life1: 0.3, shape: 4, aspect: 1, spin: 0, flutter: 0, rgb: Object.freeze([1.25, 1.25, 1.25]), alpha: 1 }),
  Object.freeze({ drag: 4.5, g: 0.4, s0: 0.025, s1: 0.05, grow: 1.4, life0: 0.4, life1: 0.8, shape: 0, aspect: 1, spin: 0.6, flutter: 0, rgb: Object.freeze([0.32, 0.3, 0.28]), alpha: 0.45 }),
]);

/**
 * @typedef {Readonly<{ name: string, cells: readonly number[], size0: number, size1: number,
 *   parts: ReadonlyArray<readonly [number, number, number, number, number]>,
 *   sounds: ReadonlyArray<readonly [string, number, number]>, trickle: number }>} Recipe
 *   cells: decal cells to pick from; size0..size1: decal diameter (m);
 *   parts: [kind, count, speed0, speed1, spread] (speed m/s along the bounce direction, spread 0..1 cone);
 *   sounds: [key, gain, rate]; trickle: extra dust particles falling after the hit (ceiling)
 */

/** @type {ReadonlyArray<Recipe>} indexed by IMP */
export const RECIPES = Object.freeze([
  Object.freeze({ name: 'plaster', cells: Object.freeze([CELL.PLASTER_A, CELL.PLASTER_B]), size0: 0.05, size1: 0.075,
    parts: Object.freeze([Object.freeze([PK.DUST, 6, 0.4, 1.1, 0.55]), Object.freeze([PK.CHIP, 4, 1.2, 2.6, 0.7])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.9, 1])]), trickle: 0 }),
  Object.freeze({ name: 'ceiling', cells: Object.freeze([CELL.PLASTER_A, CELL.PLASTER_B]), size0: 0.05, size1: 0.075,
    parts: Object.freeze([Object.freeze([PK.DUST, 6, 0.3, 0.9, 0.55]), Object.freeze([PK.CHIP, 4, 0.6, 1.6, 0.7])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.85, 1.05])]), trickle: 3 }),
  Object.freeze({ name: 'door', cells: Object.freeze([CELL.WOOD_A, CELL.WOOD_B]), size0: 0.035, size1: 0.05,
    parts: Object.freeze([Object.freeze([PK.SPLINTER, 4, 1.0, 2.4, 0.6]), Object.freeze([PK.WOOD_DUST, 3, 0.3, 0.8, 0.5])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.95, 0.68])]), trickle: 0 }),
  Object.freeze({ name: 'wood', cells: Object.freeze([CELL.WOOD_A, CELL.WOOD_B]), size0: 0.03, size1: 0.045,
    parts: Object.freeze([Object.freeze([PK.SPLINTER, 5, 1.2, 2.8, 0.6]), Object.freeze([PK.WOOD_DUST, 3, 0.3, 0.8, 0.5])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.95, 0.78])]), trickle: 0 }),
  Object.freeze({ name: 'couch', cells: Object.freeze([CELL.FABRIC_A, CELL.FABRIC_B]), size0: 0.018, size1: 0.026,
    parts: Object.freeze([Object.freeze([PK.FOAM, 5, 0.4, 1.0, 0.6]), Object.freeze([PK.DARK_DUST, 2, 0.2, 0.5, 0.5])]),
    sounds: Object.freeze([Object.freeze(['impactFlesh', 0.4, 1.3]), Object.freeze(['cloth', 0.3, 1.4])]), trickle: 0 }),
  Object.freeze({ name: 'bed', cells: Object.freeze([CELL.FABRIC_A, CELL.FABRIC_B]), size0: 0.018, size1: 0.026,
    parts: Object.freeze([Object.freeze([PK.FEATHER, 7, 0.5, 1.2, 0.7]), Object.freeze([PK.FOAM, 2, 0.3, 0.7, 0.6])]),
    sounds: Object.freeze([Object.freeze(['impactFlesh', 0.32, 1.4]), Object.freeze(['cloth', 0.35, 1.3])]), trickle: 0 }),
  Object.freeze({ name: 'metal', cells: Object.freeze([CELL.METAL]), size0: 0.022, size1: 0.03,
    parts: Object.freeze([Object.freeze([PK.GLINT, 4, 1.5, 3.5, 0.5]), Object.freeze([PK.DARK_DUST, 2, 0.2, 0.5, 0.5])]),
    sounds: Object.freeze([Object.freeze(['brassM', 1.0, 0.55]), Object.freeze(['impactWall', 0.45, 1.25])]), trickle: 0 }),
  Object.freeze({ name: 'glass', cells: Object.freeze([CELL.GLASS]), size0: 0.08, size1: 0.12,
    parts: Object.freeze([Object.freeze([PK.GLINT, 6, 1.0, 2.6, 0.7])]),
    sounds: Object.freeze([Object.freeze(['brassS', 0.9, 0.7]), Object.freeze(['impactWall', 0.4, 1.35])]), trickle: 0 }),
  Object.freeze({ name: 'floorWood', cells: Object.freeze([CELL.WOOD_A, CELL.WOOD_B]), size0: 0.03, size1: 0.045,
    parts: Object.freeze([Object.freeze([PK.SPLINTER, 3, 0.8, 2.0, 0.6]), Object.freeze([PK.WOOD_DUST, 3, 0.3, 0.8, 0.5])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.9, 0.82])]), trickle: 0 }),
  Object.freeze({ name: 'floorCarpet', cells: Object.freeze([CELL.FABRIC_A, CELL.FABRIC_B]), size0: 0.016, size1: 0.022,
    parts: Object.freeze([Object.freeze([PK.DARK_DUST, 3, 0.2, 0.6, 0.5]), Object.freeze([PK.FOAM, 2, 0.3, 0.7, 0.6])]),
    sounds: Object.freeze([Object.freeze(['impactFlesh', 0.4, 1.2])]), trickle: 0 }),
  Object.freeze({ name: 'floorTile', cells: Object.freeze([CELL.PLASTER_B]), size0: 0.03, size1: 0.045,
    parts: Object.freeze([Object.freeze([PK.CHIP, 5, 1.4, 3.0, 0.7]), Object.freeze([PK.DUST, 3, 0.3, 0.8, 0.5])]),
    sounds: Object.freeze([Object.freeze(['impactWall', 0.9, 1.18])]), trickle: 0 }),
]);

/** Floor settings → impact kind. */
const FLOOR_IMP = Object.freeze({ wood: IMP.FLOOR_WOOD, carpet: IMP.FLOOR_CARPET, tile: IMP.FLOOR_TILE });

/**
 * Surface label → impact kind (allocation-free: a switch on the label).
 * @param {string} surface world raycast label (lower case; '-' / '_' as spaces)
 * @param {string} [floor] 'wood' | 'carpet' | 'tile' (the floor's material, a per-house setting)
 * @returns {number} IMP.*
 */
export function impactKind(surface, floor = 'wood') {
  switch (surface) {
    case 'wall': case 'wall face': case 'invisible wall face': case 'other': case '': return IMP.PLASTER;
    case 'ceiling': return IMP.CEILING;
    case 'door': case 'door frame': case 'doorframe': return IMP.DOOR;
    case 'table': case 'desk': case 'shelf': case 'storage': case 'cabinet': case 'bookshelf': case 'dresser': case 'hard':
    case 'chair': case 'wardrobe': case 'nightstand': case 'counter':
      return IMP.WOOD;
    case 'couch': case 'sofa': case 'armchair': case 'soft': case 'pillow': case 'ottoman':
      return IMP.COUCH;
    case 'bed': case 'mattress':
      return IMP.BED;
    case 'screen': case 'tv': case 'monitor': case 'lamp': case 'radiator': case 'appliance': case 'refrigerator':
      return IMP.METAL;
    case 'window': case 'window frame': case 'wall art': case 'mirror': case 'glass': case 'picture':
      return IMP.GLASS;
    case 'floor': {
      const k = /** @type {any} */ (FLOOR_IMP)[floor];
      return k === undefined ? IMP.FLOOR_WOOD : k;
    }
    default: return IMP.WOOD; // an unknown piece of furniture (plants, baskets…): a hard knock
  }
}

/** particleVelocity input layout. */
export const PV = Object.freeze({ NX: 0, NY: 1, NZ: 2, DX: 3, DY: 4, DZ: 5, R1: 6, R2: 7, R3: 8, SPEED: 9, SPREAD: 10 });
export const PV_LEN = 11;

/**
 * Initial velocity of one particle: out of the surface along the normal,
 * tilted back toward the shooter (spall comes back along the shot), with a
 * random cone. Inputs in a PV array (no doubles cross the call: see
 * shadowMath.js): normal (unit, toward the shooter's side), bullet travel
 * (unit), three uniforms in [0, 1), speed (m/s) and spread (0 along the
 * bounce .. 1 hemisphere).
 * @param {Float64Array} p PV layout
 * @param {Float64Array} out [vx, vy, vz]
 */
export function particleVelocity(p, out) {
  const nx = p[0], ny = p[1], nz = p[2], dx = p[3], dy = p[4], dz = p[5];
  // bounce direction: the normal, pulled toward the incoming ray reversed
  let bx = nx * 0.75 - dx * 0.25, by = ny * 0.75 - dy * 0.25, bz = nz * 0.75 - dz * 0.25;
  let l = Math.sqrt(bx * bx + by * by + bz * bz);
  if (!(l > 1e-6)) { bx = nx; by = ny; bz = nz; l = 1; }
  bx /= l; by /= l; bz /= l;
  // tangent basis round b
  const side = Math.abs(by) < 0.9;
  let tx = side ? -bz : 0, ty = side ? 0 : bz, tz = side ? bx : -by;
  l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= l; ty /= l; tz /= l;
  const ux = by * tz - bz * ty, uy = bz * tx - bx * tz, uz = bx * ty - by * tx;
  // cone: polar angle up to spread × 85°, uniform azimuth
  const th = Math.sqrt(p[6]) * p[10] * 1.48, ph = p[7] * Math.PI * 2;
  const st = Math.sin(th), ct = Math.cos(th), cp = Math.cos(ph), sp = Math.sin(ph);
  let vx = bx * ct + (tx * cp + ux * sp) * st, vy = by * ct + (ty * cp + uy * sp) * st, vz = bz * ct + (tz * cp + uz * sp) * st;
  // never into the surface
  const into = vx * nx + vy * ny + vz * nz;
  if (into < 0.05) { vx += nx * (0.05 - into); vy += ny * (0.05 - into); vz += nz * (0.05 - into); }
  const s = p[9] * (0.7 + 0.6 * p[8]);
  out[0] = vx * s; out[1] = vy * s; out[2] = vz * s;
  return out;
}

/** Particles one impact spawns (the recipe's parts summed, AKM × 1.3 rounded). @param {number} kind @param {boolean} [rifle] */
export function particleCount(kind, rifle = false) {
  const r = RECIPES[kind];
  if (!r) return 0;
  let n = 0;
  for (let i = 0; i < r.parts.length; i++) n += rifle ? Math.round(r.parts[i][1] * 1.3) : r.parts[i][1];
  return n + r.trickle;
}
