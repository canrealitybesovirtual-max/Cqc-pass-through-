// @ts-check
/**
 * Spawn points (pure). PLAN §9 "Spawning", split into a bake and a query.
 *
 * Bake (at world build): candidate cells that are walkable, on a mapped floor
 * (not in a door gap), with clearance ≥ 0.35 m (radius + 0.10, which also keeps
 * them ≥ 0.37 m from furniture, never under a table), open in ≥ 5 of 8
 * directions at 0.32 m and ≥ 4 of 8 at 0.6 m, reachable from the player, and
 * at least 4 m of path beyond the safe-zone edge. One candidate per 0.5 m block
 * (the most open cell), the far-side-of-a-door ones first.
 *
 * Query (`find`, allocation-free): ≥ minDist (and ≥ 2.5 m) from the player,
 * not near a recent spawn, then in preference order:
 *   3. on the far side of a door and hidden from the player's eyes;
 *   2. hidden behind walls or furniture in the player's room;
 *   1. visible but outside ±60° of the view direction and ≥ 3 m away.
 * "Hidden" = every sight line from the eye (floor + 1.6 m) to the enemy's
 * shins, chest, head and both shoulders is blocked. Within a tier the choice is
 * random (seeded), mildly favouring 5–12 m of path. At most `evalCap`
 * candidates get sight tests per call, so the cost is bounded.
 */

import { NAV_DOOR, NAV_INSIDE, NAV_WALK } from './NavGrid.js';

const DIRX = new Float32Array(8), DIRZ = new Float32Array(8);
for (let k = 0; k < 8; k++) { DIRX[k] = Math.cos((k * Math.PI) / 4); DIRZ[k] = Math.sin((k * Math.PI) / 4); }

/** @param {number} a @param {number} b */
function gcd(a, b) {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

export class SpawnFinder {
  /** @param {{ maxCandidates?: number, seed?: number }} [o] */
  constructor({ maxCandidates = 1024, seed = 0x2545f491 } = {}) {
    this.max = maxCandidates;
    this.x = new Float32Array(maxCandidates);
    this.z = new Float32Array(maxCandidates);
    this.path = new Float32Array(maxCandidates);
    this.door = new Uint8Array(maxCandidates);
    this.count = 0;
    /** Candidates [0, doorCount) are on the far side of a door. */
    this.doorCount = 0;
    this.seed = seed >>> 0 || 1;
    this.rng = this.seed;
    /** Ring of recent spawns: x, z, time (s). */
    this.recent = new Float64Array(4 * 3);
    this.recentHead = 0;
    this.spawnClear = 0.35;
    this.minPathBeyondZone = 4.0;
    this.eyeHeight = 1.6;
    this.fovCos = Math.cos((60 * Math.PI) / 180);
    this.nearVisible = 3.0;
    this.hardMin = 2.5;
    this.evalCap = 128;
    this.avoidR = 1.0;
    this.avoidS = 10;
    /** Diagnostics of the last find(): tier 0 = nothing found. */
    this.lastTier = 0;
    this.lastEvals = 0;
  }

  /**
   * @param {import('./NavGrid.js').NavGrid} nav finalized grid
   * @param {number} zoneR safe-zone radius (m)
   */
  build(nav, zoneR) {
    this.rng = this.seed;
    this.recent.fill(-1e9);
    this.count = this.doorCount = 0;
    const w = nav.w, h = nav.h, B = 5; // 0.5 m blocks
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const best = new Int32Array(bw * bh).fill(-1);
    const minPath = zoneR + this.minPathBeyondZone;
    for (let i = 0; i < nav.count; i++) {
      const fl = nav.flags[i];
      if ((fl & NAV_WALK) === 0 || (fl & NAV_INSIDE) === 0 || (fl & NAV_DOOR) !== 0) continue;
      if (nav.clr[i] < this.spawnClear) continue;
      const pd = nav.pathDist[i];
      if (!(pd >= minPath && pd < Infinity) || nav.reach[nav.region[i]] !== 1) continue;
      const x = nav.centerX(i), z = nav.centerZ(i);
      if (!open(nav, x, z)) continue;
      const ix = i % w, iz = (i - ix) / w;
      const b = Math.floor(iz / B) * bw + Math.floor(ix / B);
      if (best[b] < 0 || nav.clr[i] > nav.clr[best[b]]) best[b] = i;
    }
    /** @type {number[]} */ const doorSide = [], room = [];
    for (let b = 0; b < best.length; b++) {
      const i = best[b];
      if (i >= 0) (nav.doors[i] > 0 ? doorSide : room).push(i);
    }
    const all = doorSide.concat(room);
    const step = all.length > this.max ? all.length / this.max : 1;
    for (let k = 0; k < this.max && Math.floor(k * step) < all.length; k++) {
      const i = all[Math.floor(k * step)];
      this.x[k] = nav.centerX(i);
      this.z[k] = nav.centerZ(i);
      this.path[k] = nav.pathDist[i];
      this.door[k] = nav.doors[i] > 0 ? 1 : 0;
      if (this.door[k]) this.doorCount = k + 1;
      this.count = k + 1;
    }
  }

  rand() {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng;
  }

  /**
   * @param {{ floorY(x: number, z: number): number, segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean }} world
   * @param {number} fromX @param {number} fromZ player head position
   * @param {number} vx @param {number} vz horizontal view direction
   * @param {number} minDist metres
   * @param {{ x: number, z: number }} out
   * @param {number} time seconds (for the recent-spawn memory)
   * @returns {boolean}
   */
  find(world, fromX, fromZ, vx, vz, minDist, out, time) {
    this.lastTier = 0;
    this.lastEvals = 0;
    if (this.count === 0) return false;
    const vl = Math.sqrt(vx * vx + vz * vz);
    const hasView = vl > 1e-6;
    if (hasView) { vx /= vl; vz /= vl; }
    const eyeY = world.floorY(fromX, fromZ) + this.eyeHeight;
    const minD = minDist > this.hardMin ? minDist : this.hardMin;
    let bestScore = -1, bx = 0, bz = 0, bestTier = 0, evals = 0, hiddenDoor = 0;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1 && bestTier === 3) break;
      const lo = pass === 0 ? 0 : this.doorCount, hi = pass === 0 ? this.doorCount : this.count;
      const m = hi - lo;
      if (m <= 0) continue;
      let stride = m > 1 ? 1 + (this.rand() % (m - 1)) : 1;
      while (gcd(stride, m) !== 1) stride = stride % (m - 1) + 1;
      let j = this.rand() % m;
      for (let k = 0; k < m && evals < this.evalCap && hiddenDoor < 6; k++, j = (j + stride) % m) {
        const c = lo + j;
        const x = this.x[c], z = this.z[c];
        const dx = x - fromX, dz = z - fromZ;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minD || this.nearRecent(x, z, time)) continue;
        evals++;
        let tier = 0, cosA = 1;
        if (!this.visible(world, eyeY, fromX, fromZ, x, z, d)) tier = this.door[c] ? 3 : 2;
        else {
          if (d < this.nearVisible || !hasView) continue;
          cosA = (dx * vx + dz * vz) / d;
          if (cosA > this.fovCos) continue;
          tier = 1;
        }
        const p = this.path[c];
        const pathPref = 1 - Math.min(1, Math.abs(p - 8.5) / 8);
        const score = tier * 10 + pathPref + (this.rand() / 4294967296) * 2 + (tier === 1 ? 1 - cosA : 0);
        if (tier === 3) hiddenDoor++;
        if (score > bestScore) { bestScore = score; bx = x; bz = z; bestTier = tier; }
      }
    }
    this.lastEvals = evals;
    if (bestTier === 0) return false;
    out.x = bx;
    out.z = bz;
    this.lastTier = bestTier;
    const o = this.recentHead * 3;
    this.recent[o] = bx; this.recent[o + 1] = bz; this.recent[o + 2] = time;
    this.recentHead = (this.recentHead + 1) & 3;
    return true;
  }

  /** @param {number} x @param {number} z @param {number} time */
  nearRecent(x, z, time) {
    const r2 = this.avoidR * this.avoidR;
    for (let k = 0; k < 4; k++) {
      const o = k * 3;
      if (time - this.recent[o + 2] > this.avoidS) continue;
      const dx = this.recent[o] - x, dz = this.recent[o + 1] - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /**
   * Any sight line from the eye to the enemy's body?
   * @param {{ floorY(x: number, z: number): number, segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean }} world
   * @param {number} eyeY @param {number} ex @param {number} ez
   * @param {number} x @param {number} z @param {number} d horizontal distance
   */
  visible(world, eyeY, ex, ez, x, z, d) {
    const fy = world.floorY(x, z);
    if (world.segmentClear(ex, eyeY, ez, x, fy + 1.65, z)) return true;
    if (world.segmentClear(ex, eyeY, ez, x, fy + 1.1, z)) return true;
    if (world.segmentClear(ex, eyeY, ez, x, fy + 0.45, z)) return true;
    const px = -(z - ez) / d * 0.25, pz = (x - ex) / d * 0.25; // shoulders, across the sight line
    if (world.segmentClear(ex, eyeY, ez, x + px, fy + 1.35, z + pz)) return true;
    return world.segmentClear(ex, eyeY, ez, x - px, fy + 1.35, z - pz);
  }
}

/**
 * ≥ 5 of 8 directions walkable at 0.32 m and ≥ 4 of 8 at 0.6 m (CQC's tested rule).
 * @param {import('./NavGrid.js').NavGrid} nav
 * @param {number} x @param {number} z
 */
function open(nav, x, z) {
  let a = 0, b = 0;
  for (let k = 0; k < 8; k++) {
    if (nav.isWalkable(x + DIRX[k] * 0.32, z + DIRZ[k] * 0.32)) a++;
    if (nav.isWalkable(x + DIRX[k] * 0.6, z + DIRZ[k] * 0.6)) b++;
  }
  return a >= 5 && b >= 4;
}
