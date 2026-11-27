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
 * are kept in a ring (x, z, tier, time, room, player room) for the session
 * record (`report`).
 *
 * v0.4.1 (the user's house: five of six spawns stood in plain view through
 * the living room's doors, in space Space Setup never scanned): a cell in
 * unscanned space (NAV_HIDDEN: behind the real walls, see WorldCore.markHidden)
 * is a candidate only next to a door into scanned space (NAV_POCKET), like the
 * door pockets; while the door curtains stand (`world.curtainsOn`: the player is
 * in scanned space) such a candidate is hidden whatever the sight lines say (the
 * walls and the curtains cover it), so an enemy can wait right behind an open
 * door and walk in through it. The roam search prefers these door spawns
 * (`ROAM_SPAWN.doorBonus`): enemies come into the scanned rooms through real
 * doorways instead of appearing in the middle of a room.
 *
 * Roam (the default play mode, `buildRoam` + `beginRoam` / `stepRoam`): the
 * player walks the whole house, so candidates cover every room (no path
 * minimum from the build start), each with its cell and room. A search is
 * resumable across frames under a clock deadline and keeps only points that
 * are, in order: not in the player's room(s) (a door gap counts as both of
 * its rooms); ≥ 3.5 m from the head and from where the head will be in 1 s
 * (head + velocity); not near a recent spawn; 5–30 m of path from the player
 * (RoamIndex.pathFromPlayerCell: through the doors of the player's room; in a
 * small house, when nothing qualifies, 3.5–5 m will do); and hidden from the
 * eyes (the 5 sight lines). Score: path near 9 m, a random
 * part, +1.0 for a room not used by the last two spawns, +1.0 behind a door. The pick is checked
 * again against the newest head when the search ends.
 */

import { NAV_DOOR, NAV_HIDDEN, NAV_INSIDE, NAV_POCKET, NAV_VIRTUAL, NAV_WALK } from './NavGrid.js';

/** Spawn log ring size (x, z, tier, time, room, player room per entry). */
export const SPAWN_LOG = 16;
const LOG_STRIDE = 6;

/** Roam search limits. */
export const ROAM_SPAWN = Object.freeze({
  minPath: 5.0,
  /** A small house: when nothing hidden lies ≥ minPath away, a hidden point this far (and ≥ 3.5 m straight) will do. */
  minPathSmall: 3.5,
  maxPath: 30.0,
  /** Path preference peak and half width (m). */
  pathPeak: 9.0,
  pathWidth: 7.0,
  /** Prediction horizon for the moving head (s) and the speed clamp (m/s). */
  predictS: 1.0,
  maxSpeed: 1.5,
  /** Stop after this many hidden candidates were scored. */
  enough: 6,
  /** Read the clock every this many candidates. */
  clockEvery: 16,
  /** Score bonus for a spawn behind a door into unscanned space (a pocket): he walks in through the doorway (v0.4.1). */
  doorBonus: 1.0,
  /** Score bonus for a room neither of the last two spawns used (variety: not always the same door; v0.4.1, was 0.5). */
  freshBonus: 1.0,
});

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
  constructor({ maxCandidates = 2048, seed = 0x2545f491 } = {}) {
    this.max = maxCandidates;
    this.x = new Float32Array(maxCandidates);
    this.z = new Float32Array(maxCandidates);
    /** Cell index and room id per candidate (roam builds; room 0 otherwise). */
    this.cell = new Int32Array(maxCandidates);
    this.room = new Uint16Array(maxCandidates);
    /** The last build was a roam build. */
    this.roam = false;
    /** Rooms that hold at least one candidate (roam build). */
    this.roomsWithCandidates = 0;
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
    /** Cells the last build skipped because they are unscanned space away from a door (NAV_HIDDEN, v0.4.1). */
    this.skippedHidden = 0;
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
    /** Last SPAWN_LOG spawns: x, z, tier, time (s), room, player room. */
    this.log = new Float32Array(SPAWN_LOG * LOG_STRIDE);
    this.logHead = 0;
    this.logCount = 0;
    // ── the resumable roam search ──
    this.rsActive = false;
    this.rsHx = 0; this.rsHz = 0; this.rsPx = 0; this.rsPz = 0;
    this.rsEyeY = 0; this.rsTime = 0;
    this.rsJ = 0; this.rsStride = 1; this.rsK = 0; this.rsM = 0;
    this.rsEvals = 0; this.rsHidden = 0;
    this.rsBest = -1; this.rsBestScore = -1;
    /** The newest head for the search: x, z, velocity x, z (written by the caller: no doubles passed). */
    this.aim = new Float64Array(4);
    /** Clock deadline of the current slice (ms, written by the caller). */
    this.rsDeadline = 0;
    /** Best hidden candidate with 3.5–5 m of path (the small-house fallback). */
    this.rsNear = -1; this.rsNearScore = -1;
    /** Rooms of the last two spawns (roam variety). */
    this.lastRooms = new Uint16Array(2);
    /** Roam searches: started, found, none, restarted (the pick failed the final check), frames used. */
    this.roamStats = { searches: 0, found: 0, none: 0, restarts: 0, slices: 0, maxEvals: 0 };
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
    this.skippedHidden = 0;
    this.roam = false;
    this.roomsWithCandidates = 0;
    this.rsActive = false;
    this.lastRooms.fill(0);
    const w = nav.w, h = nav.h, B = Math.max(1, Math.round(0.5 / nav.cell)); // 0.5 m blocks
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
        if ((fl & NAV_HIDDEN) !== 0 && (fl & NAV_POCKET) === 0) { this.skippedHidden++; continue; }
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
      this.cell[k] = i;
      this.room[k] = nav.room[i];
      if (this.door[k]) this.doorCount = k + 1;
      if (this.pocket[k]) this.pocketCount++;
      this.count = k + 1;
    }
  }

  /**
   * Roam bake: candidates in every room of the house (walkable, on a floor,
   * not in a door gap, clearance ≥ 0.35 m, open, in a room of ≥ 1 m²; virtual
   * floor only in door pockets, at most 3 per pocket), one per 0.5 m block.
   * No path minimum from the build start (the player moves).
   * @param {import('./NavGrid.js').NavGrid} nav finalized grid with rooms (labelRooms)
   */
  buildRoam(nav) {
    this.build(nav, 0, { allowVirtual: false }); // resets the counters; its candidates are replaced below
    this.roam = true;
    this.count = this.doorCount = this.pocketCount = 0;
    this.skippedVirtual = 0;
    this.skippedHidden = 0;
    this.virtualFallback = false;
    const w = nav.w, h = nav.h, B = Math.max(1, Math.round(0.5 / nav.cell));
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    const best = new Int32Array(bw * bh).fill(-1);
    for (let i = 0; i < nav.count; i++) {
      const fl = nav.flags[i];
      if ((fl & NAV_WALK) === 0 || (fl & NAV_INSIDE) === 0 || (fl & NAV_DOOR) !== 0) continue;
      if (nav.clr[i] < this.spawnClear || nav.room[i] === 0) continue;
      if ((fl & NAV_VIRTUAL) !== 0 && (fl & NAV_POCKET) === 0) { this.skippedVirtual++; continue; }
      if ((fl & NAV_HIDDEN) !== 0 && (fl & NAV_POCKET) === 0) { this.skippedHidden++; continue; }
      if (!open(nav, nav.centerX(i), nav.centerZ(i))) continue;
      const ix = i % w, iz = (i - ix) / w;
      const b = Math.floor(iz / B) * bw + Math.floor(ix / B);
      if (best[b] < 0 || nav.clr[i] > nav.clr[best[b]]) best[b] = i;
    }
    /** @type {number[]} */ const mapped = [];
    /** @type {Map<number, number[]>} */ const pockets = new Map();
    for (let b = 0; b < best.length; b++) {
      const i = best[b];
      if (i < 0) continue;
      if ((nav.flags[i] & NAV_POCKET) !== 0) {
        const r = nav.room[i];
        let list = pockets.get(r);
        if (!list) pockets.set(r, (list = []));
        list.push(i);
      } else mapped.push(i);
    }
    for (const list of pockets.values()) {
      list.sort((a, b) => nav.clr[b] - nav.clr[a] || a - b);
      for (let k = 0; k < list.length && k < this.maxPerPocket; k++) mapped.push(list[k]);
    }
    const step = mapped.length > this.max ? mapped.length / this.max : 1;
    /** @type {Set<number>} */ const rooms = new Set();
    for (let k = 0; k < this.max && Math.floor(k * step) < mapped.length; k++) {
      const i = mapped[Math.floor(k * step)];
      this.x[k] = nav.centerX(i);
      this.z[k] = nav.centerZ(i);
      this.path[k] = nav.pathDist[i];
      this.door[k] = 0;
      this.pocket[k] = (nav.flags[i] & NAV_POCKET) !== 0 ? 1 : 0;
      this.cell[k] = i;
      this.room[k] = nav.room[i];
      if (this.pocket[k]) this.pocketCount++;
      rooms.add(nav.room[i]);
      this.count = k + 1;
    }
    this.roomsWithCandidates = rooms.size;
  }

  /**
   * Start a roam search (allocation-free). The head comes from `aim`.
   * @param {{ floorY(x: number, z: number): number }} world
   * @param {number} time seconds
   */
  beginRoam(world, time) {
    this.rsActive = this.count > 0;
    if (!this.rsActive) return;
    const m = this.count;
    let stride = m > 1 ? 1 + (this.rand() % (m - 1)) : 1;
    while (gcd(stride, m) !== 1) stride = stride % (m - 1) + 1;
    this.rsStride = stride;
    this.rsJ = this.rand() % m;
    this.rsM = m;
    this.rsK = 0;
    this.rsEvals = 0;
    this.rsHidden = 0;
    this.rsBest = -1;
    this.rsBestScore = -1;
    this.rsNear = -1;
    this.rsNearScore = -1;
    this.rsTime = time;
    this.aimRoam(world);
    this.roamStats.searches++;
  }

  /**
   * The head the search (and the final check) uses: the newest one, from `aim`.
   * @param {{ floorY(x: number, z: number): number }} world
   */
  aimRoam(world) {
    const A = this.aim, hx = A[0], hz = A[1], vx = A[2], vz = A[3];
    const v = Math.sqrt(vx * vx + vz * vz), lim = ROAM_SPAWN.maxSpeed;
    const k = v > lim ? lim / v : 1;
    this.rsHx = hx;
    this.rsHz = hz;
    this.rsPx = hx + vx * k * ROAM_SPAWN.predictS;
    this.rsPz = hz + vz * k * ROAM_SPAWN.predictS;
    this.rsEyeY = world.floorY(hx, hz) + this.eyeHeight;
  }

  /**
   * Continue the roam search until it ends or the clock passes `deadline`.
   * @param {{ floorY(x: number, z: number): number, segmentClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean }} world
   * @param {{ isPlayerRoom(r: number): boolean, pathFromPlayerCm(i: number): number }} roam
   * @param {() => number} clock (the deadline is `rsDeadline`)
   * @param {{ x: number, z: number }} out
   * @returns {number} 1 found (written to out), 2 still searching, 0 nothing qualified
   */
  stepRoam(world, roam, clock, out) {
    if (!this.rsActive) return 0;
    this.roamStats.slices++;
    const m = this.rsM, hx = this.rsHx, hz = this.rsHz, px = this.rsPx, pz = this.rsPz, time = this.rsTime;
    const min2 = this.hardMin * this.hardMin, deadline = this.rsDeadline;
    const RS = ROAM_SPAWN;
    const minCm = RS.minPath * 100, smallCm = RS.minPathSmall * 100, maxCm = RS.maxPath * 100;
    while (this.rsK < m && this.rsHidden < RS.enough) {
      if ((this.rsK % RS.clockEvery) === 0 && this.rsK > 0 && clock() >= deadline) return 2;
      const c = this.rsJ;
      this.rsK++;
      this.rsJ = (this.rsJ + this.rsStride) % m;
      const r = this.room[c];
      if (roam.isPlayerRoom(r)) continue;
      const x = this.x[c], z = this.z[c];
      const dx = x - hx, dz = z - hz, d2 = dx * dx + dz * dz;
      if (d2 < min2) continue;
      const qx = x - px, qz = z - pz;
      if (qx * qx + qz * qz < min2) continue;
      if (this.nearRecent(x, z, time)) continue;
      let pc = roam.pathFromPlayerCm(this.cell[c]); // integer cm: no boxed double per candidate
      if (pc < 0) pc = this.path[c] < 1e7 ? Math.ceil(this.path[c] * 100) : 0x3fffffff; // fields not baked: the build-start path
      if (!(pc >= smallCm && pc <= maxCm)) continue;
      const near = pc < minCm;
      if (near && this.rsBest >= 0) continue; // a proper one exists already
      this.rsEvals++;
      if (this.visible(world, this.rsEyeY, hx, hz, x, z, Math.sqrt(d2))) continue;
      const pathPref = 1 - Math.min(1, Math.abs(pc * 0.01 - RS.pathPeak) / RS.pathWidth);
      const fresh = r !== this.lastRooms[0] && r !== this.lastRooms[1] ? RS.freshBonus : 0;
      const score = pathPref + fresh + (this.pocket[c] ? RS.doorBonus : 0) + (this.rand() / 4294967296) * 2;
      if (near) {
        if (score > this.rsNearScore) { this.rsNearScore = score; this.rsNear = c; }
        continue;
      }
      this.rsHidden++;
      if (score > this.rsBestScore) { this.rsBestScore = score; this.rsBest = c; }
    }
    this.rsActive = false;
    if (this.rsEvals > this.roamStats.maxEvals) this.roamStats.maxEvals = this.rsEvals;
    const c = this.rsBest >= 0 ? this.rsBest : this.rsNear;
    if (c < 0) { this.roamStats.none++; this.finds[0]++; this.lastTier = 0; return 0; }
    // the final check against the newest head (the search may have taken a few frames)
    const x = this.x[c], z = this.z[c];
    const dx = x - this.rsHx, dz = z - this.rsHz, d2 = dx * dx + dz * dz;
    const qx = x - this.rsPx, qz = z - this.rsPz;
    if (roam.isPlayerRoom(this.room[c]) || d2 < min2 || qx * qx + qz * qz < min2
      || this.visible(world, this.rsEyeY, this.rsHx, this.rsHz, x, z, Math.sqrt(d2))) {
      this.roamStats.restarts++;
      return 0;
    }
    this.roamStats.found++;
    this.commit(x, z, SPAWN_TIER.HIDDEN_DOOR, time, this.room[c], playerRoomOf(roam));
    out.x = x;
    out.z = z;
    return 1;
  }

  /**
   * Record a spawn (recent ring, log, counters, last*).
   * @param {number} x @param {number} z @param {number} tier @param {number} time @param {number} room @param {number} playerRoom
   */
  commit(x, z, tier, time, room, playerRoom) {
    this.finds[tier]++;
    this.lastTier = tier;
    this.lastX = x;
    this.lastZ = z;
    const o = this.recentHead * 3;
    this.recent[o] = x; this.recent[o + 1] = z; this.recent[o + 2] = time;
    this.recentHead = (this.recentHead + 1) & 3;
    const g = this.logHead * LOG_STRIDE;
    this.log[g] = x; this.log[g + 1] = z; this.log[g + 2] = tier; this.log[g + 3] = time;
    this.log[g + 4] = room; this.log[g + 5] = playerRoom;
    this.logHead = (this.logHead + 1) % SPAWN_LOG;
    if (this.logCount < SPAWN_LOG) this.logCount++;
    this.lastRooms[1] = this.lastRooms[0];
    this.lastRooms[0] = room;
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
   * @param {{ isPlayerRoom(r: number): boolean, pathFromPlayerCell(i: number): number }|null} [roam] roam build:
   *   "behind a door" and the path are relative to the player's room now (one pass over every candidate)
   * @returns {boolean}
   */
  find(world, fromX, fromZ, vx, vz, minDist, out, time, roam = null) {
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
    const byRoom = !!roam && this.roam;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1 && (bestTier === 3 || byRoom)) break;
      const lo = byRoom ? 0 : pass === 0 ? 0 : this.doorCount, hi = byRoom ? this.count : pass === 0 ? this.doorCount : this.count;
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
        const other = byRoom ? !/** @type {any} */ (roam).isPlayerRoom(this.room[c]) : this.door[c] === 1;
        if (!this.visible(world, eyeY, fromX, fromZ, x, z, d)) tier = other ? 3 : 2;
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
        const p = byRoom ? /** @type {any} */ (roam).pathFromPlayerCell(this.cell[c]) : this.path[c];
        const pathPref = p < Infinity ? 1 - Math.min(1, Math.abs(p - 8.5) / 8) : 0;
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
    out.x = bx;
    out.z = bz;
    const nav = byRoom ? /** @type {any} */ (world).nav : null;
    const ci = nav ? nav.index(bx, bz) : -1;
    const room = ci >= 0 ? nav.room[ci] : 0;
    this.commit(bx, bz, bestTier, time, room, byRoom ? playerRoomOf(/** @type {any} */ (roam)) : 0);
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
    /** @type {{ x: number, z: number, tier: number, t: number, room: number, playerRoom: number }[]} */ const recent = [];
    for (let k = 0; k < this.logCount; k++) {
      const g = ((this.logHead - this.logCount + k + SPAWN_LOG) % SPAWN_LOG) * LOG_STRIDE;
      recent.push({
        x: Math.round(this.log[g] * 100) / 100, z: Math.round(this.log[g + 1] * 100) / 100,
        tier: this.log[g + 2], t: Math.round(this.log[g + 3] * 10) / 10, room: this.log[g + 4], playerRoom: this.log[g + 5],
      });
    }
    return {
      candidates: this.count, doorSide: this.doorCount, pocket: this.pocketCount, room: this.count - this.doorCount, skippedHidden: this.skippedHidden,
      virtualFallback: this.virtualFallback, roam: this.roam, roomsWithCandidates: this.roomsWithCandidates,
      roamSearch: this.roam ? { ...this.roamStats } : null,
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
    // unscanned space behind the walls / a door curtain: covered while the curtains stand (v0.4.1)
    const nav = /** @type {any} */ (world).nav;
    if (nav && /** @type {any} */ (world).curtainsOn === true) {
      const ix = Math.floor((x - nav.ox) * nav.inv), iz = Math.floor((z - nav.oz) * nav.inv);
      if (ix >= 0 && iz >= 0 && ix < nav.w && iz < nav.h && (nav.flags[iz * nav.w + ix] & NAV_HIDDEN) !== 0) return false;
    }
    const fy = world.floorY(x, z);
    if (world.segmentClear(ex, eyeY, ez, x, fy + 1.65, z)) return true;
    if (world.segmentClear(ex, eyeY, ez, x, fy + 1.1, z)) return true;
    if (world.segmentClear(ex, eyeY, ez, x, fy + 0.45, z)) return true;
    const px = -(z - ez) / d * 0.25, pz = (x - ex) / d * 0.25; // shoulders, across the sight line
    if (world.segmentClear(ex, eyeY, ez, x + px, fy + 1.35, z + pz)) return true;
    return world.segmentClear(ex, eyeY, ez, x - px, fy + 1.35, z - pz);
  }
}

/** @param {any} roam */
function playerRoomOf(roam) {
  return roam && roam.pRoomA ? roam.pRoomA : 0;
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
