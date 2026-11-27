// @ts-check
/**
 * Collision shapes and masses of the items (pure: no three.js, no DOM).
 *
 * A gun is a compound of convex hulls in gun space (metres, +Y up, −Z muzzle,
 * origin on the bore at the breech face, CONTRACTS "Weapon GLB layout"). Each
 * hull is the 26-direction extreme points of the mesh vertices inside one
 * region box ("bin") of the gun: the Glock as slide, trigger guard and grip;
 * the AKM as barrel, handguard, receiver, pistol grip and stock, plus its
 * curved magazine as two hulls when it is seated. Built once at load from the
 * GLB vertices (WeaponSystem.attachPhysics), so the hulls follow the real
 * model. A magazine is one hull (Glock) or two (the AKM's curve), in magazine
 * space (origin at its top, as the mesh).
 *
 * Masses (design, from published weights): G17 0.905 kg loaded, 0.63 kg
 * without its magazine; AKM 3.6 kg with a loaded magazine (research), 3.1 kg
 * without; magazines by their rounds (9 mm 8.1 g, 7.62×39 16.3 g a round).
 */

/** The 26 directions of the extreme-point sampling (cube faces, edges and corners). */
export const DIRS26 = (() => {
  /** @type {number[]} */ const d = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (!x && !y && !z) continue;
    const l = Math.hypot(x, y, z);
    d.push(x / l, y / l, z / l);
  }
  return Float64Array.from(d);
})();

/** Item kinds (PhysicsWorld kind ids). */
export const K_GLOCK = 0;
export const K_GLOCK_NOMAG = 1;
export const K_AKM = 2;
export const K_AKM_NOMAG = 3;
export const K_MAG9 = 4;
export const K_MAG762 = 5;
export const KIND_COUNT = 6;
export const KIND_NAMES = Object.freeze(['glock', 'glock-nomag', 'akm', 'akm-nomag', 'mag9', 'mag762']);
/** Bit masks for `PhysicsWorld.nearest`. */
export const MASK_GUNS = (1 << K_GLOCK) | (1 << K_GLOCK_NOMAG) | (1 << K_AKM) | (1 << K_AKM_NOMAG);
export const MASK_MAGS = (1 << K_MAG9) | (1 << K_MAG762);

/**
 * Region boxes [x0, y0, z0, x1, y1, z1] in gun space (design, from the baked GLBs'
 * vertex profile along the bore).
 */
export const GUN_BINS = Object.freeze({
  glock: Object.freeze([
    Object.freeze([-1, -0.03, -1, 1, 1, 1]),         // slide and dust cover
    Object.freeze([-1, -1, -1, 1, -0.02, 0.005]),    // trigger guard
    Object.freeze([-1, -1, 0.005, 1, -0.02, 1]),     // grip (the magazine sits inside it)
  ]),
  akm: Object.freeze([
    Object.freeze([-1, -1, -1, 1, 1, -0.235]),       // barrel, gas block, front sight
    Object.freeze([-1, -1, -0.24, 1, 1, 0.065]),     // handguard, gas tube, receiver front, charging handle
    Object.freeze([-1, -0.08, 0.06, 1, 1, 0.215]),   // receiver rear, trigger guard
    Object.freeze([-1, -1, 0.15, 1, -0.06, 0.26]),   // pistol grip
    Object.freeze([-1, -1, 0.255, 1, 1, 1]),         // stock
  ]),
});

/** Region boxes in magazine space (origin at the top). */
export const MAG_BINS = Object.freeze({
  glock: Object.freeze([Object.freeze([-1, -1, -1, 1, 1, 1])]),
  akm: Object.freeze([Object.freeze([-1, -0.1, -1, 1, 1, 1]), Object.freeze([-1, -1, -1, 1, -0.09, 1])]),
});

/** Masses (kg) and surface coefficients per item (design). */
export const ITEM = Object.freeze({
  glock: Object.freeze({ mass: 0.905, massNoMag: 0.63, friction: 0.6, restitution: 0.15 }),   // polymer frame
  akm: Object.freeze({ mass: 3.6, massNoMag: 3.1, friction: 0.5, restitution: 0.2 }),         // steel and wood
  mag9: Object.freeze({ empty: 0.075, perRound: 0.0081, friction: 0.6, restitution: 0.15 }),
  mag762: Object.freeze({ empty: 0.33, perRound: 0.0163, friction: 0.5, restitution: 0.2 }),
});

/**
 * Mass of a magazine with `rounds` rounds.
 * @param {'glock'|'akm'} id @param {number} rounds
 */
export function magMass(id, rounds) {
  const m = id === 'akm' ? ITEM.mag762 : ITEM.mag9;
  return m.empty + m.perRound * (rounds > 0 ? rounds : 0);
}

/**
 * Extreme points of the vertices inside a box, along the 26 directions (duplicates dropped).
 * @param {ArrayLike<number>} pos xyz triples
 * @param {ArrayLike<number>} bin [x0, y0, z0, x1, y1, z1]
 * @param {number} [ox] @param {number} [oy] @param {number} [oz] offset added to every point (after the bin test)
 * @returns {Float32Array|null} null with fewer than 4 points inside
 */
export function extremePoints(pos, bin, ox = 0, oy = 0, oz = 0) {
  const D = DIRS26, nd = D.length / 3;
  const best = new Float64Array(nd).fill(-Infinity);
  const idx = new Int32Array(nd).fill(-1);
  let inside = 0;
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (!(x >= bin[0] && x <= bin[3] && y >= bin[1] && y <= bin[4] && z >= bin[2] && z <= bin[5])) continue;
    inside++;
    for (let k = 0; k < nd; k++) {
      const d = x * D[k * 3] + y * D[k * 3 + 1] + z * D[k * 3 + 2];
      if (d > best[k]) { best[k] = d; idx[k] = i; }
    }
  }
  if (inside < 4) return null;
  /** @type {number[]} */ const out = [];
  const seen = new Set();
  for (let k = 0; k < nd; k++) {
    const i = idx[k];
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    out.push(pos[i] + ox, pos[i + 1] + oy, pos[i + 2] + oz);
  }
  if (out.length < 12) return null;
  // flat (all points in one plane along an axis): no volume, no hull
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < out.length; i += 3) {
    if (out[i] < x0) x0 = out[i]; if (out[i] > x1) x1 = out[i];
    if (out[i + 1] < y0) y0 = out[i + 1]; if (out[i + 1] > y1) y1 = out[i + 1];
    if (out[i + 2] < z0) z0 = out[i + 2]; if (out[i + 2] > z1) z1 = out[i + 2];
  }
  if (x1 - x0 < 0.002 || y1 - y0 < 0.002 || z1 - z0 < 0.002) return null;
  return Float32Array.from(out);
}

/** A bin that holds every point. */
const ALL = Object.freeze([-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity]);

/**
 * Hulls (point clouds) of the vertices in each bin.
 * @param {ArrayLike<number>} pos
 * @param {ReadonlyArray<ArrayLike<number>>} bins
 * @param {ArrayLike<number>} [offset] added to every point
 * @returns {Float32Array[]}
 */
export function hullsFromBins(pos, bins, offset) {
  /** @type {Float32Array[]} */ const out = [];
  const ox = offset ? offset[0] : 0, oy = offset ? offset[1] : 0, oz = offset ? offset[2] : 0;
  for (const b of bins) {
    const h = extremePoints(pos, b, ox, oy, oz);
    if (h) out.push(h);
  }
  if (!out.length) {
    // no bin made a solid hull (a model unlike the baked one): one hull of everything
    const h = extremePoints(pos, ALL, ox, oy, oz);
    if (h) out.push(h);
  }
  return out;
}

/**
 * Bounding box (centre and half extents) of a set of hulls.
 * @param {Float32Array[]} hulls
 * @returns {{ centre: Float64Array, half: Float64Array }}
 */
export function hullBounds(hulls) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const h of hulls) {
    for (let i = 0; i + 2 < h.length; i += 3) {
      for (let k = 0; k < 3; k++) { if (h[i + k] < mn[k]) mn[k] = h[i + k]; if (h[i + k] > mx[k]) mx[k] = h[i + k]; }
    }
  }
  const centre = new Float64Array(3), half = new Float64Array(3);
  for (let k = 0; k < 3; k++) {
    if (!(mx[k] >= mn[k])) { centre[k] = 0; half[k] = 0.01; continue; }
    centre[k] = (mn[k] + mx[k]) / 2;
    half[k] = Math.max(0.002, (mx[k] - mn[k]) / 2);
  }
  return { centre, half };
}

/**
 * Item kind definitions (PhysicsWorld.defineKind input) for both guns and their magazines.
 * @param {{ glock: { gun: ArrayLike<number>, mag: ArrayLike<number>, magSeat: ArrayLike<number>, grip: ArrayLike<number> },
 *   akm: { gun: ArrayLike<number>, mag: ArrayLike<number>, magSeat: ArrayLike<number>, grip: ArrayLike<number> } }} src
 *   per gun: gun-space vertex positions, magazine-space vertex positions, the seated magazine's offset and the grip centre
 * @returns {{ kind: number, def: import('./PhysicsWorld.js').KindDef }[]}
 */
export function itemKinds(src) {
  /** @type {{ kind: number, def: import('./PhysicsWorld.js').KindDef }[]} */
  const out = [];
  for (const id of /** @type {const} */ (['glock', 'akm'])) {
    const s = src[id], I = ITEM[id];
    const gunHulls = hullsFromBins(s.gun, GUN_BINS[id]);
    const magHullsSeated = hullsFromBins(s.mag, MAG_BINS[id], s.magSeat);
    const magHulls = hullsFromBins(s.mag, MAG_BINS[id]);
    // Glock: the magazine sits inside the grip (same hulls); AKM: it hangs below the receiver
    const withMag = id === 'akm' ? gunHulls.concat(magHullsSeated) : gunHulls;
    const grip = [s.grip[0], s.grip[1], s.grip[2]];
    const gb = hullBounds(withMag), gb0 = hullBounds(gunHulls), mb = hullBounds(magHulls);
    out.push({ kind: id === 'glock' ? K_GLOCK : K_AKM, def: { name: id, hulls: withMag, mass: I.mass, friction: I.friction, restitution: I.restitution, grip, centre: Array.from(gb.centre), half: Array.from(gb.half) } });
    out.push({ kind: id === 'glock' ? K_GLOCK_NOMAG : K_AKM_NOMAG, def: { name: `${id}-nomag`, hulls: gunHulls, mass: I.massNoMag, friction: I.friction, restitution: I.restitution, grip, centre: Array.from(gb0.centre), half: Array.from(gb0.half) } });
    const M = id === 'akm' ? ITEM.mag762 : ITEM.mag9;
    out.push({
      kind: id === 'glock' ? K_MAG9 : K_MAG762,
      def: { name: id === 'glock' ? 'mag9' : 'mag762', hulls: magHulls, mass: magMass(id, id === 'akm' ? 30 : 17), massEmpty: M.empty, massPerRound: M.perRound,
        friction: M.friction, restitution: M.restitution, grip: Array.from(mb.centre), centre: Array.from(mb.centre), half: Array.from(mb.half) },
    });
  }
  return out;
}
