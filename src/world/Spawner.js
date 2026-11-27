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
 * Virtual floor (no Space Setup data: real unmapped space, where an enemy
 * could stand inside a real wall or sofa) is never a candidate, except: door
 * pockets (NAV_POCKET, the small virtual floor behind a door into unmapped
 * space, made for spawning); the whole room is virtual (no Space Setup floor);
 * or no mapped cell qualifies at all (`virtualFallback`, noted in the report).
 *
 * Query (`find`, allocation-free): ≥ minDist (and never within 3.5 m) of the
 * player, not near a recent spawn, then in preference order:
 *   3. on the far side of a door (pockets included) and hidden from the player's eyes;
 *   2. hidden behind walls or furniture in the player's room;
 *   1. visible, but outside ±100° of the view direction (behind the player:
 *      the Quest 3 sees about ±55°, and the head turns);
 *   4. last resort, only when `inViewAfter` finds in a row found none of the
 *      above (nothing else exists, e.g. the player faces the only open floor;
 *      a wave must not stall): visible within ±100°, the one furthest from the
 *      view direction (≥ 55° when there is one: outside the Quest's view).
 * "Hidden" = every sight line from the eye (floor + 1.6 m) to the enemy's
 * shins, chest, head and both shoulders is blocked. Within a tier the choice is
 * random (seeded), mildly favouring 5–12 m of path. At most `evalCap`
 * candidates get sight tests per call, so the cost is bounded.
 *
 * Every find() is counted by the tier it returned (`finds[0..4]`, 0 = none
 * found), `lastTier` / `lastX` / `lastZ` hold the last find's result (the
 * enemy manager records each spawn's tier from them) and the last 16 spawns
 * are kept in a ring (x, z, tier, time) for the session record (`report`).
 */

import { NAV_DOOR, NAV_INSIDE, NAV_POCKET, NAV_VIRTUAL, NAV_WALK } from './NavGrid.js';

/** Spawn log ring size (x, z, tier, time per entry). */
export const SPAWN_LOG = 16;

/** Spawn tiers (`lastTier`, `finds[]`, the log). IN_VIEW is the last resort, not the best. */
export const SPAWN_TIER = Object.freeze({ NONE: 0, BEHIND: 1, HIDDEN_ROOM: 2, HIDDEN_DOOR: 3, IN_VIEW: 4 });

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
    /** 1 = the candidate is in a door pocket. */
    this.pocket = new Uint8Array(maxCandidates);
    this.count = 0;
    /** Candidates [0, doorCount) are on the far side of a door. */
    this.doorCount = 0;
    this.pocketCount = 0;
    /** The last build found no mapped candidate and used virtual floor. */
    this.virtualFallback = false;
    /** Cells the last build skipped because they are virtual floor. */
    this.skippedVirtual = 0;
    this.seed = seed >>> 0 || 1;
    this.rng = this.seed;
    /** Ring of recent spawns: x, z, time (s). */
    this.recent = new Float64Array(4 * 3);
    this.recentHead = 0;
    this.spawnClear = 0.35;
    /** A pocket is small: at most this many candidates each (the most open), so it does not outweigh real rooms. */
    this.maxPerPocket = 3;
    this.minPathBeyondZone = 4.0;
    this.eyeHeight = 1.6;
    /** Fallback tier: only outside ±100° of the view direction. */
    this.fovCos = Math.cos((100 * Math.PI) / 180);
    this.nearVisible = 3.0;
    /** Never closer than this to the player, whatever minDist says (m). */
    this.hardMin = 3.5;
    /** The in-view last resort needs this many finds in a row with nothing else. */
    this.inViewAfter = 4;
    /** Finds in a row that returned nothing outside the view. */
    this.failStreak = 0;
    /** cos of the Quest 3's horizontal half view (≈ 55°): the last resort prefers beyond it. */
    this.viewCos = Math.cos((55 * Math.PI) / 180);
    this.evalCap = 128;
    this.avoidR = 1.0;
    this.avoidS = 10;
    /** Diagnostics of the last find(): tier 0 = nothing found; the point it returned. */
    this.lastTier = 0;
    this.lastX = NaN;
    this.lastZ = NaN;
    this.lastEvals = 0;
    /** find() results by tier since the last build (0 = nothing found, 4 = in view). */
    this.finds = new Uint32Array(5);
    /** Last SPAWN_LOG spawns: x, z, tier, time (s). */
    this.log = new Float32Array(SPAWN_LOG * 4);
    this.logHead = 0;
    this.logCount = 0;
  }

  /**
   * @param {import('./NavGrid.js').NavGrid} nav finalized grid
   * @param {number} zoneR safe-zone radius (m)
   * @param {{ allowVirtual?: boolean }} [o] allowVirtual: the whole room is virtual (no Space Setup floor)
   */
  build(nav, zoneR, { allowVirtual = false } = {}) {
    this.rng = this.seed;
    this.recent.fill(-1e9);
    this.count = this.doorCount = this.pocketCount = 0;
    this.finds.fill(0);
    this.log.fill(0);
    this.logHead = this.logCount = 0;
    this.lastTier = 0;
    this.lastX = this.lastZ = NaN;
    this.failStreak = 0;
    this.virtualFallback = false;
    this.skippedVirtual = 0;
    const w = nav.w, h = nav.h, B = 5; // 0.5 m blocks
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const best = new Int32Array(bw * bh);
    const minPath = zoneR + this.minPathBeyondZone;
    let found = 0;
    for (let pass = 0; pass < 2 && found === 0; pass++) {
      // Pass 1 (only if pass 0 found nothing on mapped floor): any virtual floor.
      const virtualOk = allowVirtual || pass === 1;
      if (pass === 1) {
        if (allowVirtual || this.skippedVirtual === 0) break;
        this.virtualFallback = true;
      }
      best.fill(-1);
      for (let i = 0; i < nav.count; i++) {
        const fl = nav.flags[i];
        if ((fl & NAV_WALK) === 0 || (fl & NAV_INSIDE) === 0 || (fl & NAV_DOOR) !== 0) continue;
        if (nav.clr[i] < this.spawnClear) continue;
        const pd = nav.pathDist[i];
        if (!(pd >= minPath && pd < Infinity) || nav.reach[nav.region[i]] !== 1) continue;
        if ((fl & NAV_VIRTUAL) !== 0 && (fl & NAV_POCKET) === 0 && !virtualOk) {
          this.skippedVirtual++;
          continue;
        }
        const x = nav.centerX(i), z = nav.centerZ(i);
        if (!open(nav, x, z)) continue;
        const ix = i % w, iz = (i - ix) / w;
        const b = Math.floor(iz / B) * bw + Math.floor(ix / B);
        if (best[b] < 0) found++;
        if (best[b] < 0 || nav.clr[i] > nav.clr[best[b]]) best[b] = i;
      }
    }
    if (found === 0) this.virtualFallback = false;
    /** @type {number[]} */ const doorSide = [], room = [];
    /** @type {Map<number, number[]>} */ const pockets = new Map();
    for (let b = 0; b < best.length; b++) {
      const i = best[b];
      if (i < 0) continue;
      if ((nav.flags[i] & NAV_POCKET) !== 0) {
        const f = nav.floorIdx[i];
        let list = pockets.get(f);
        if (!list) pockets.set(f, (list = []));
        list.push(i);
      } else (nav.doors[i] > 0 ? doorSide : room).push(i);
    }
    for (const list of pockets.values()) {
      list.sort((a, b) => nav.clr[b] - nav.clr[a] || a - b);
      for (let k = 0; k < list.length && k < this.maxPerPocket; k++) (nav.doors[list[k]] > 0 ? doorSide : room).push(list[k]);
    }
    const all = doorSide.concat(room);
    const step = all.length > this.max ? all.length / this.max : 1;
    for (let k = 0; k < this.max && Math.floor(k * step) < all.length; k++) {
      const i = all[Math.floor(k * step)];
      this.x[k] = nav.centerX(i);
      this.z[k] = nav.centerZ(i);
      this.path[k] = nav.pathDist[i];
      this.door[k] = nav.doors[i] > 0 ? 1 : 0;
      this.pocket[k] = (nav.flags[i] & NAV_POCKET) !== 0 ? 1 : 0;
      if (this.door[k]) this.doorCount = k + 1;
      if (this.pocket[k]) this.pocketCount++;
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
    this.lastX = this.lastZ = NaN;
    this.lastEvals = 0;
    if (this.count === 0) return false;
    const vl = Math.sqrt(vx * vx + vz * vz);
    const hasView = vl > 1e-6;
    if (hasView) { vx /= vl; vz /= vl; }
    const eyeY = world.floorY(fromX, fromZ) + this.eyeHeight;
    const minD = minDist > this.hardMin ? minDist : this.hardMin;
    let bestScore = -1, bx = 0, bz = 0, bestTier = 0, evals = 0, hiddenDoor = 0;
    // the last resort: visible within ±100° (used only after inViewAfter empty finds)
    let ivScore = -1, ivx = 0, ivz = 0;
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
          if (cosA > this.fovCos) {
            // in view: remember the most peripheral one (beyond the Quest's view first), then farther
            const iv = (cosA <= this.viewCos ? 4 : 0) + (1 - cosA) * 2 + (d > 8 ? 8 : d) * 0.05 + (this.rand() / 4294967296) * 0.2;
            if (iv > ivScore) { ivScore = iv; ivx = x; ivz = z; }
            continue;
          }
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
    if (bestTier === 0) {
      this.failStreak++;
      if (ivScore < 0 || this.failStreak < this.inViewAfter) { this.finds[0]++; return false; }
      bestTier = 4; bx = ivx; bz = ivz; // nothing else for a while: the least visible point in view
    }
    this.failStreak = 0; // (after an in-view spawn the next one waits again: time to turn)
    this.finds[bestTier]++;
    out.x = bx;
    out.z = bz;
    this.lastTier = bestTier;
    this.lastX = bx;
    this.lastZ = bz;
    const o = this.recentHead * 3;
    this.recent[o] = bx; this.recent[o + 1] = bz; this.recent[o + 2] = time;
    this.recentHead = (this.recentHead + 1) & 3;
    const g = this.logHead * 4;
    this.log[g] = bx; this.log[g + 1] = bz; this.log[g + 2] = bestTier; this.log[g + 3] = time;
    this.logHead = (this.logHead + 1) % SPAWN_LOG;
    if (this.logCount < SPAWN_LOG) this.logCount++;
    return true;
  }

  /**
   * Session-record summary (allocates; build time or session end only):
   * candidate counts by kind; by tier as seen from (sx, sz) at build (eye at
   * floor + 1.6 m; 'visible' ones can only be used by the ±100° fallback or
   * the in-view last resort);
   * per floor; the find() results by tier; and the last spawns, oldest first.
   * @param {{ floorY(x: number, z: number): number, segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean,
   *   nav: import('./NavGrid.js').NavGrid }} world
   * @param {number} sx @param {number} sz player start
   */
  report(world, sx, sz) {
    const eyeY = world.floorY(sx, sz) + this.eyeHeight;
    let hiddenDoor = 0, hiddenRoom = 0, visible = 0, tooNear = 0;
    /** @type {number[]} */ const byFloor = [];
    for (let c = 0; c < this.count; c++) {
      const x = this.x[c], z = this.z[c];
      const i = world.nav.index(x, z);
      const f = i >= 0 ? world.nav.floorIdx[i] : -1;
      if (f >= 0) { while (byFloor.length <= f) byFloor.push(0); byFloor[f]++; }
      const d = Math.hypot(x - sx, z - sz);
      if (d < this.hardMin) { tooNear++; continue; }
      if (this.visible(world, eyeY, sx, sz, x, z, d)) visible++;
      else if (this.door[c]) hiddenDoor++;
      else hiddenRoom++;
    }
    /** @type {{ x: number, z: number, tier: number, t: number }[]} */ const recent = [];
    for (let k = 0; k < this.logCount; k++) {
      const g = ((this.logHead - this.logCount + k + SPAWN_LOG) % SPAWN_LOG) * 4;
      recent.push({
        x: Math.round(this.log[g] * 100) / 100, z: Math.round(this.log[g + 1] * 100) / 100,
        tier: this.log[g + 2], t: Math.round(this.log[g + 3] * 10) / 10,
      });
    }
    return {
      candidates: this.count, doorSide: this.doorCount, pocket: this.pocketCount, room: this.count - this.doorCount,
      virtualFallback: this.virtualFallback,
      fromStart: { tier3: hiddenDoor, tier2: hiddenRoom, visible, tooNear },
      byFloor,
      finds: { none: this.finds[0], tier1: this.finds[1], tier2: this.finds[2], tier3: this.finds[3], inView: this.finds[4] },
      recent,
    };
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
