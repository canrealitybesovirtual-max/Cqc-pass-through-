// @ts-check
/**
 * Fusion of depth points, hit-test rays and the head path into the HouseGrid
 * (v0.5; runs in the learner worker). Everything is in the house frame.
 *
 * A depth point (sensor origin o, surface point p):
 * - its height above the local floor (the cell's measured floor, else Space
 *   Setup's floor there, else the floor under the head) classifies it:
 *   on the floor (±7 cm) → the cell's floor height (running mean);
 *   0.07–1.3 m up → a surface top candidate (`top`, the highest seen) and,
 *   from 0.5 m, something standing there (`occ`); 1.3–2.1 m → `occ`; higher
 *   (ceilings) is ignored;
 * - the cells the line of sight crosses at wall height (0.5–1.9 m above the
 *   floor) before the point (stopping 15 cm short, at most 4.5 m) are `free`:
 *   a 2D DDA on the 10 cm grid (Amanatides–Woo), so a wall Space Setup put
 *   where the sensor sees through is contradicted.
 * The head path marks `walked` cells (radius 15 cm): the strongest evidence.
 * Allocation-free per point.
 *
 * Pure: no three.js, no DOM.
 */
import { CELL, NO_FLOOR } from './HouseGrid.js';

export const FLOOR_BAND = 0.07;
export const TOP_MAX = 1.3;
export const WALL_LO = 0.5, WALL_HI = 1.9, CEIL_MIN = 2.1;
export const CARVE_STOP = 0.15, CARVE_MAX = 4.5;
/** A floor's weight saturates here, so a changed floor (a rug moved, a scan error) is relearnt in a session. */
const FLOOR_W_MAX = 60;
/** The eye sits about this far above the floor when standing (the head's own floor estimate). */
export const EYE_H = 1.62;

export class Fuser {
  /**
   * @param {import('./HouseGrid.js').HouseGrid} grid
   * @param {{ floorAt?: (x: number, z: number) => number }} [o] floorAt: Space Setup's floor height there (NaN outside)
   */
  constructor(grid, { floorAt } = {}) {
    this.grid = grid;
    this.floorAt = floorAt || (() => NaN);
    /** The floor under the head (running estimate from head heights; NaN until a sample). */
    this.headFloor = NaN;
    this.points = 0;
    this.floorHits = 0;
    this.topHits = 0;
    this.occHits = 0;
    this.freeCells = 0;
    this.walks = 0;
    this.rejected = 0;
  }

  /** @param {(x: number, z: number) => number} f */
  setFloorPrior(f) { this.floorAt = f || (() => NaN); }

  /**
   * The local floor height at a cell (measured, else Space Setup, else under the head).
   * @param {number} c cell index (or −1) @param {number} x @param {number} z @param {number} oy sensor height
   */
  floorRef(c, x, z, oy) {
    const g = this.grid;
    if (c >= 0 && g.floorW[c] >= 2) return g.floor[c] / 1000;
    const p = this.floorAt(x, z);
    if (p === p) return p;
    if (this.headFloor === this.headFloor) return this.headFloor;
    return oy - EYE_H;
  }

  /**
   * One surface point seen from the sensor.
   * @param {number} ox @param {number} oy @param {number} oz sensor (house frame)
   * @param {number} px @param {number} py @param {number} pz point
   * @param {number} [ny] the surface normal's y when known (hit-test), else NaN
   */
  addPoint(ox, oy, oz, px, py, pz, ny = NaN) {
    const g = this.grid;
    if (!(py === py) || !(px === px) || !(pz === pz)) { this.rejected++; return; }
    const c = g.cell(px, pz, true);
    if (c < 0) { this.rejected++; return; }
    this.points++;
    const F = this.floorRef(c, px, pz, oy);
    const dy = py - F;
    if (dy > -FLOOR_BAND && dy < FLOOR_BAND && !(ny === ny && ny < 0.6)) {
      const w = g.floorW[c], mm = Math.round(py * 1000);
      g.floor[c] = w === 0 || g.floor[c] === NO_FLOOR ? mm : Math.round((g.floor[c] * w + mm) / (w + 1));
      if (w < FLOOR_W_MAX) g.floorW[c] = w + 1;
      this.floorHits++;
    } else if (dy <= -FLOOR_BAND && dy > -0.3 && g.floorW[c] < 2 && py < oy - 1.0) {
      // lower than the prior: a step down or a floor Space Setup put too high; take it as this cell's floor
      g.floor[c] = Math.round(py * 1000);
      g.floorW[c] = 1;
      this.floorHits++;
    } else if (dy >= FLOOR_BAND && dy < TOP_MAX) {
      const mm = Math.round(py * 1000), t = g.top[c], w = g.topW[c];
      const horizontal = !(ny === ny) || ny > 0.8;
      if (horizontal) {
        if (w === 0 || t === NO_FLOOR || mm > t + 30) { g.top[c] = mm; g.topW[c] = 1; }
        else if (mm > t - 30) { g.top[c] = Math.round((t * w + mm) / (w + 1)); if (w < 255) g.topW[c] = w + 1; }
        this.topHits++;
      }
      if (dy >= WALL_LO && g.occ[c] < 255) { g.occ[c]++; this.occHits++; }
    } else if (dy >= TOP_MAX && dy < CEIL_MIN) {
      if (g.occ[c] < 255) { g.occ[c]++; this.occHits++; }
    }
    this.carve(ox, oy, oz, px, py, pz, F);
  }

  /**
   * Free space along the line of sight at wall height (2D DDA over the grid, stopping short of the point).
   * @param {number} ox @param {number} oy @param {number} oz @param {number} px @param {number} py @param {number} pz @param {number} F floor height
   */
  carve(ox, oy, oz, px, py, pz, F) {
    const dx = px - ox, dz = pz - oz;
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L < 0.25) return;
    const tEnd = Math.min(1, (L - CARVE_STOP) / L, CARVE_MAX / L);
    if (tEnd <= 0) return;
    const g = this.grid;
    let gx = Math.floor(ox / CELL), gz = Math.floor(oz / CELL);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity, tdz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? (gx + 1) * CELL - ox : ox - gx * CELL) / Math.abs(dx)) : Infinity;
    let tmz = dz !== 0 ? ((dz > 0 ? (gz + 1) * CELL - oz : oz - gz * CELL) / Math.abs(dz)) : Infinity;
    let t = 0;
    const lo = F + WALL_LO, hi = F + WALL_HI, vy = py - oy;
    for (let k = 0; k < 64 && t < tEnd; k++) {
      // the ray's height in the middle of this cell's segment
      const tn = Math.min(tmx, tmz, tEnd);
      const h = oy + vy * (t + tn) * 0.5;
      if (h > lo && h < hi) {
        const c = g.cellAt(gx, gz, true);
        if (c >= 0 && g.free[c] < 255) { g.free[c]++; this.freeCells++; }
      }
      t = tn;
      if (tmx < tmz) { tmx += tdx; gx += sx; } else { tmz += tdz; gz += sz; }
    }
  }

  /**
   * A head sample: the cells under it are walked; the floor under the head follows (eye height above it).
   * @param {number} x @param {number} y @param {number} z
   */
  addWalk(x, y, z) {
    const g = this.grid;
    this.walks++;
    const f = y - EYE_H;
    this.headFloor = this.headFloor === this.headFloor ? this.headFloor + (f - this.headFloor) * 0.05 : f;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const c = g.cellAt(gx + i, gz + j, true);
        if (c >= 0 && g.walked[c] < 255) g.walked[c]++;
      }
    }
  }

  stats() {
    return { points: this.points, floorHits: this.floorHits, topHits: this.topHits, occHits: this.occHits, freeCells: this.freeCells, walks: this.walks, rejected: this.rejected };
  }
}
