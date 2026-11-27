// @ts-check
/**
 * SafeSpot (pure: no three.js, no DOM; allocation-free per frame): choosing
 * where the player stands before a round (docs/PLAN.md §6.2 "Safe zone",
 * gap audit S1). "Stand where you want to play, pull the trigger."
 *
 * A spot (x, z) with zone radius r is judged against the built world:
 * - CLEAR:   `world.nav.clearance(x, z)` ≥ r + 0.3 (walls, furniture
 *            footprints and the floor edge) AND no mapped box (walls,
 *            furniture, shelves, low lintels: anything starting below 2.2 m)
 *            within r + 0.8 horizontally (an arm swung from the ring edge);
 * - TIGHT:   the clearance holds but a box is within r + 0.8;
 * - BLOCKED: clearance < r + 0.3;
 * - OFFMAP:  not on a mapped floor (clearance 0);
 * - UNMAPPED: no map here at all (virtual room, or a virtual floor patch):
 *            the player has to check the space around them.
 *
 * Confirming: CLEAR or UNMAPPED with a trigger press; TIGHT by holding the
 * trigger 1 s (a deliberate "play here anyway"; the runtime ObstacleWarnings
 * still cover it). BLOCKED / OFFMAP cannot be confirmed.
 *
 * Which way to step: a time-sliced search (2 of 16 directions per frame, 12
 * radii from 0.15 to 3 m, so a full sweep every 8 frames) keeps, per
 * direction, the nearest CLEAR spot and the roomiest TIGHT one that can be
 * walked to in a straight line (no furniture or wall footprint in between).
 * The suggestion is the nearest CLEAR spot; failing that, from BLOCKED the
 * nearest usable spot, from TIGHT a spot with ≥ 0.15 m more room. It is given
 * as a world point plus a sector (8 directions relative to the player's
 * heading) and a distance in 0.1 m steps for the message panel. If a whole
 * sweep finds nothing usable the radius shrinks by 0.1 m (down to 0.5 m,
 * PLAN's range is 0.5–0.8 m).
 *
 * World interface (World / WorldCore): `built`, `virtual`, `nav.clearance`,
 * `nav.index`, `nav.flags` (NAV_INSIDE 1, NAV_DOOR 16, NAV_VIRTUAL 128), `shapes` ({ box, count }),
 * `floorY(x, z)`.
 */

import { nearestFootprint, walkClear } from './geom.js';

export const SPOT_STATUS = Object.freeze({ NONE: 0, CLEAR: 1, TIGHT: 2, BLOCKED: 3, OFFMAP: 4, UNMAPPED: 5 });
export const SPOT_STATUS_NAMES = Object.freeze(['none', 'clear', 'tight', 'blocked', 'offmap', 'unmapped']);

export const SPOT = Object.freeze({
  /** Clearance needed beyond r (m). */
  clearExtra: 0.3,
  /** No mapped box within r + this (m). */
  reachExtra: 0.8,
  /** Boxes starting below floor + this count as reachable obstacles (m). */
  reachHeight: 2.2,
  /** Boxes starting below floor + this block walking to a suggested spot (m). */
  walkHeight: 1.0,
  walkPad: 0.1,
  minR: 0.5,
  shrinkStep: 0.1,
  /** Hold the trigger this long to accept a TIGHT spot (s). */
  acceptTightS: 1.0,
  /** A TIGHT → TIGHT suggestion needs this much more room (m). */
  betterBy: 0.15,
  maxSuggest: 3.0,
  dirs: 16,
  dirsPerFrame: 2,
});

/** Search radii (m). */
const RADII = new Float64Array([0.15, 0.3, 0.45, 0.6, 0.8, 1.0, 1.25, 1.5, 1.8, 2.2, 2.6, 3.0]);
/** NavGrid flag bits (src/world/NavGrid.js). */
const NAV_INSIDE = 1, NAV_DOOR = 16, NAV_VIRTUAL = 128;

/** Sector names relative to the player's heading: 0 = forward, clockwise. */
export const SECTOR_NAMES = Object.freeze(['forward', 'forward and right', 'right', 'back and right', 'back', 'back and left', 'left', 'forward and left']);
/** Distance buckets: 0.1 m … 3.0 m. */
export const MAX_BUCKET = 30;

/** Prebuilt "Step back 0.6 m" lines: STEP_LINES[sector][bucket]. */
export const STEP_LINES = SECTOR_NAMES.map((name) => {
  const row = [];
  for (let b = 0; b <= MAX_BUCKET; b++) row.push(`Step ${name} ${(Math.max(1, b) / 10).toFixed(1)} m`);
  return Object.freeze(row);
});

export class SafeSpot {
  /** @param {{ r?: number }} [o] */
  constructor({ r = 0.8 } = {}) {
    this.r0 = r;
    this.r = r;
    this.active = false;
    /** @type {number} SPOT_STATUS at the head */
    this.status = SPOT_STATUS.NONE;
    this.clearance = 0;
    /** Horizontal distance to the nearest mapped box (m). */
    this.nearest = Infinity;
    // per direction: nearest CLEAR spot, roomiest TIGHT spot (NaN = none)
    const n = SPOT.dirs;
    this.cosD = new Float64Array(n);
    this.sinD = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.cosD[i] = Math.cos((i / n) * Math.PI * 2); this.sinD[i] = Math.sin((i / n) * Math.PI * 2); }
    this.clearX = new Float64Array(n).fill(NaN);
    this.clearZ = new Float64Array(n).fill(NaN);
    this.tightX = new Float64Array(n).fill(NaN);
    this.tightZ = new Float64Array(n).fill(NaN);
    this.tightNear = new Float64Array(n);
    this.dirNext = 0;
    this.swept = 0;
    this.sweepUsable = false;
    // suggestion
    this.hasStep = false;
    this.stepX = 0;
    this.stepZ = 0;
    this.stepDist = 0;
    this.sector = 0;
    this.bucket = 0;
    // confirm
    this.holdT = 0;
    this.confirmed = false;
    this.x = 0;
    this.z = 0;
    this.facing = 0;
    this._near = Infinity;
    this._clr = 0;
    this._idx = new Int32Array(1);
    this.evaluations = 0;
    /** The head position the sweep searches around (set by update). */
    this.hx = 0;
    this.hz = 0;
  }

  /** Start choosing (before a round). @param {number} [r] zone radius */
  begin(r = this.r0) {
    this.r0 = r;
    this.r = r;
    this.active = true;
    this.confirmed = false;
    this.status = SPOT_STATUS.NONE;
    this.holdT = 0;
    this.restartSweep();
  }

  /** Forget the search (the world moved, e.g. a reference-space reset). */
  restartSweep() {
    this.clearX.fill(NaN);
    this.clearZ.fill(NaN);
    this.tightX.fill(NaN);
    this.tightZ.fill(NaN);
    this.tightNear.fill(0);
    this.dirNext = 0;
    this.swept = 0;
    this.sweepUsable = false;
    this.hasStep = false;
  }

  stop() { this.active = false; this.hasStep = false; }

  /**
   * Judge one spot. Also leaves the clearance and the nearest-box distance in
   * `lastClearance` / `lastNearest`.
   * @param {any} world
   * @param {number} x @param {number} z @param {number} r
   * @returns {number} SPOT_STATUS
   */
  evaluate(world, x, z, r) {
    this.evaluations++;
    this._near = Infinity;
    this._clr = Infinity;
    const nav = world && world.built !== false ? world.nav : null;
    if (!nav || world.virtual || typeof nav.clearance !== 'function') return SPOT_STATUS.UNMAPPED;
    let onFloor = true;
    if (nav.flags && typeof nav.index === 'function') {
      const i = nav.index(x, z);
      const f = i >= 0 ? nav.flags[i] : 0;
      if ((f & NAV_VIRTUAL) !== 0) return SPOT_STATUS.UNMAPPED;
      onFloor = (f & (NAV_INSIDE | NAV_DOOR)) !== 0;
    }
    const clr = nav.clearance(x, z);
    this._clr = clr;
    // clearance 0: off every floor, or inside a wall / furniture footprint
    if (!(clr > 0)) return onFloor ? SPOT_STATUS.BLOCKED : SPOT_STATUS.OFFMAP;
    if (clr < r + SPOT.clearExtra) return SPOT_STATUS.BLOCKED;
    const fy = typeof world.floorY === 'function' ? world.floorY(x, z) : 0;
    const near = nearestFootprint(world.shapes, x, z, fy + SPOT.reachHeight, this._idx);
    this._near = near;
    return near >= r + SPOT.reachExtra ? SPOT_STATUS.CLEAR : SPOT_STATUS.TIGHT;
  }

  get lastClearance() { return this._clr; }
  get lastNearest() { return this._near; }

  /**
   * One frame while choosing.
   * @param {number} dt
   * @param {any} world
   * @param {number} hx @param {number} hz head (world x, z)
   * @param {number} fx @param {number} fz horizontal heading (unit)
   * @param {boolean} triggerDown a trigger was pulled this frame
   * @param {boolean} triggerHeld a trigger is held
   * @returns {boolean} true once, on the frame the spot is confirmed
   */
  update(dt, world, hx, hz, fx, fz, triggerDown, triggerHeld) {
    if (!this.active || this.confirmed) return false;
    if (!(dt >= 0)) dt = 0;
    this.hx = hx;
    this.hz = hz;
    const st = this.evaluate(world, hx, hz, this.r);
    this.status = st;
    this.clearance = this._clr;
    this.nearest = this._near;
    if (st !== SPOT_STATUS.UNMAPPED && st !== SPOT_STATUS.CLEAR) this.sweep(world);
    this.suggest(hx, hz, fx, fz);

    let ok = false;
    if (st === SPOT_STATUS.CLEAR || st === SPOT_STATUS.UNMAPPED) {
      ok = triggerDown;
      this.holdT = 0;
    } else if (st === SPOT_STATUS.TIGHT) {
      this.holdT = triggerHeld ? this.holdT + dt : 0;
      ok = this.holdT >= SPOT.acceptTightS;
    } else this.holdT = 0;
    if (!ok) return false;
    this.confirmed = true;
    this.active = false;
    this.hasStep = false;
    this.x = hx;
    this.z = hz;
    this.facing = Math.atan2(fx, fz);
    return true;
  }

  /** Time-sliced search around the head (nothing allocated). @param {any} world */
  sweep(world) {
    const n = SPOT.dirs, r = this.r;
    const hx = this.hx, hz = this.hz;
    for (let k = 0; k < SPOT.dirsPerFrame; k++) {
      const d = this.dirNext;
      let cx = NaN, cz = NaN, tx = NaN, tz = NaN, tn = 0;
      for (let j = 0; j < RADII.length; j++) {
        const x = hx + this.cosD[d] * RADII[j], z = hz + this.sinD[d] * RADII[j];
        const s = this.evaluate(world, x, z, r);
        if (s !== SPOT_STATUS.CLEAR && s !== SPOT_STATUS.TIGHT) continue;
        const fy = typeof world.floorY === 'function' ? world.floorY(x, z) : 0;
        if (!walkClear(world.shapes, hx, hz, x, z, fy + SPOT.walkHeight, SPOT.walkPad)) continue;
        if (s === SPOT_STATUS.CLEAR) { cx = x; cz = z; break; }
        if (this._near > tn + 1e-6) { tn = this._near; tx = x; tz = z; }
      }
      this.clearX[d] = cx; this.clearZ[d] = cz;
      this.tightX[d] = tx; this.tightZ[d] = tz; this.tightNear[d] = tn;
      if (cx === cx || tx === tx) this.sweepUsable = true;
      this.dirNext = (d + 1) % n;
      if (this.dirNext === 0) {
        this.swept++;
        const st = this.status;
        if (!this.sweepUsable && (st === SPOT_STATUS.BLOCKED || st === SPOT_STATUS.OFFMAP) && this.r > SPOT.minR + 1e-9) {
          this.r = Math.max(SPOT.minR, Math.round((this.r - SPOT.shrinkStep) * 100) / 100);
        }
        this.sweepUsable = false;
      }
    }
  }

  /** Pick the suggested spot from the per-direction results. */
  suggest(hx, hz, fx, fz) {
    this.hasStep = false;
    const st = this.status;
    if (st === SPOT_STATUS.CLEAR || st === SPOT_STATUS.UNMAPPED || st === SPOT_STATUS.NONE) return;
    const n = SPOT.dirs;
    let best = Infinity, bx = 0, bz = 0;
    for (let d = 0; d < n; d++) {
      const x = this.clearX[d];
      if (x !== x) continue;
      const dx = x - hx, dz = this.clearZ[d] - hz, l = dx * dx + dz * dz;
      if (l < best) { best = l; bx = x; bz = this.clearZ[d]; }
    }
    if (!(best <= SPOT.maxSuggest * SPOT.maxSuggest)) {
      best = Infinity;
      if (st === SPOT_STATUS.TIGHT) {
        // the roomiest spot with clearly more room than here (ties: the nearer)
        const need = this.nearest + SPOT.betterBy, max2 = SPOT.maxSuggest * SPOT.maxSuggest;
        let bestN = -1;
        for (let d = 0; d < n; d++) {
          const x = this.tightX[d], tn = this.tightNear[d];
          if (x !== x || tn < need) continue;
          const dx = x - hx, dz = this.tightZ[d] - hz, l = dx * dx + dz * dz;
          if (l > max2) continue;
          if (tn > bestN + 0.02 || (tn >= bestN - 0.02 && l < best)) {
            if (tn > bestN) bestN = tn;
            best = l; bx = x; bz = this.tightZ[d];
          }
        }
      } else {
        // out of a blocked spot: the nearest usable one
        for (let d = 0; d < n; d++) {
          const x = this.tightX[d];
          if (x !== x) continue;
          const dx = x - hx, dz = this.tightZ[d] - hz, l = dx * dx + dz * dz;
          if (l < best) { best = l; bx = x; bz = this.tightZ[d]; }
        }
      }
    }
    if (!(best < Infinity)) return;
    const dx = bx - hx, dz = bz - hz, dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.05) return;
    this.hasStep = true;
    this.stepX = bx;
    this.stepZ = bz;
    this.stepDist = dist;
    // sector relative to the heading: right = (−fz, fx)
    const fwd = dx * fx + dz * fz, right = dx * -fz + dz * fx;
    const a = Math.atan2(right, fwd);
    this.sector = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    const b = Math.round(dist * 10);
    this.bucket = b < 1 ? 1 : b > MAX_BUCKET ? MAX_BUCKET : b;
  }
}
