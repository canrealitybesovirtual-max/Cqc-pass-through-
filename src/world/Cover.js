// @ts-check
/**
 * Cover from the real house (v0.6, pure: no three.js, no DOM; allocation-free after construction).
 *
 * Built once per world build from its layout and nav grid (well under 1 ms for a large house; called in a wave
 * break or behind the card, when the world was rebuilt):
 * - **furniture cover**: next to every real piece of furniture at least 0.55 m tall (a table, a bed, a couch, a
 *   learned box), a point 0.55 m off each side, where an enemy can stand: he crouches into its shadow from a
 *   threat on the far side (`dir` points from the point to the furniture) and steps out past its end to fire
 *   (`peek`: the side point moved to the nearer end, 0.45 m beyond it);
 * - **door-frame cover**: beside every walkable open doorway, on both sides of the wall, a point 0.5 m off the
 *   wall 0.4 m past the jamb (covered from the far room); its peek is in front of the opening, 0.5 m back from
 *   the gap.
 * Every point keeps its nav room, so a room's defenders hold their own room (room clearing) and the brain can
 * ask for cover near a place.
 *
 * Queries the brain makes at 10 Hz (`world.segmentClear`) decide at run time whether a point covers against the
 * player where he is now; this index only knows the geometry.
 *
 *   const cover = new CoverIndex();
 *   cover.build(world);               // world: { layout, nav } (WorldCore / World)
 *   cover.count, cover.x[i], cover.z[i], cover.dx[i], cover.dz[i], cover.px[i], cover.pz[i], cover.room[i], cover.kind[i]
 */

import { NAV_HIDDEN, NAV_WALK } from './NavGrid.js';
import { ROOM_POCKET, ROOM_VIRTUAL } from './Roam.js';

export const COVER = Object.freeze({
  max: 512,
  /** Furniture at least this tall above its floor covers a crouched man (m). */
  minHeight: 0.55,
  /** Side points this far off the furniture's face (m). */
  off: 0.55,
  /** A peek point this far past the furniture's end (m). */
  peekOff: 0.45,
  /** Door-frame points this far past the jamb along the wall (m) and off the wall (m). */
  jambAlong: 0.4, jambOff: 0.5,
  /** Peek in front of the doorway, this far back from the gap (m). */
  doorPeekBack: 0.5,
  /** Furniture wider than this gets two points per long side (m). */
  splitLen: 1.4,
});

export const COVER_FURN = 0;
export const COVER_JAMB = 1;

export class CoverIndex {
  /** @param {number} [max] */
  constructor(max = COVER.max) {
    this.max = max;
    this.x = new Float32Array(max);
    this.z = new Float32Array(max);
    /** Unit direction from the point toward what covers it (the threat is beyond it). */
    this.dx = new Float32Array(max);
    this.dz = new Float32Array(max);
    /** Where he steps out to fire. */
    this.px = new Float32Array(max);
    this.pz = new Float32Array(max);
    /** Height of the cover above the floor (m): a bed hides a crouch, a wall a stand. */
    this.h = new Float32Array(max);
    this.room = new Uint16Array(max);
    this.kind = new Uint8Array(max);
    /** Brain-owned: the agent index + 1 holding the point (0 = free). */
    this.taken = new Uint8Array(max);
    this.count = 0;
    /** The nav grid version this was built for. */
    this.version = -1;
    this.stats = { furniture: 0, jambs: 0, rejected: 0 };
    /** The build has finished (`begin` / `step`). */
    this.ready = true;
    /** @type {any} the world being built from (sliced) */ this._w = null;
    this._k = 0;
  }

  /**
   * @param {{ layout: any, nav: import('./NavGrid.js').NavGrid|null, floorY?: (x: number, z: number) => number }|null} world
   */
  build(world) {
    this.begin(world);
    this.step(Infinity);
  }

  /**
   * Start a build (v0.6: sliced, so a wave-break rebuild never costs one frame much: `step(n)` takes n pieces of
   * furniture or doorways a frame; about 15 µs each on desktop). `ready` is false until the last step.
   * @param {any} world
   */
  begin(world) {
    this.count = 0;
    this.taken.fill(0);
    this.stats.furniture = this.stats.jambs = this.stats.rejected = 0;
    const nav = world ? world.nav : null, L = world ? world.layout : null;
    this.version = nav ? nav.version : -1;
    this._w = nav && L ? world : null;
    this._k = 0;
    this.ready = !this._w;
  }

  /** @param {number} n pieces this call @returns {boolean} ready */
  step(n) {
    const w = this._w;
    if (!w) { this.ready = true; return true; }
    const F = w.layout.furniture || [], D = w.layout.doors || [];
    for (let m = 0; m < n; m++) {
      const k = this._k++;
      if (k < F.length) this.furniture(w, F[k], k);
      else if (k < F.length + D.length) this.doorway(w.nav, D[k - F.length]);
      else { this._w = null; this.ready = true; return true; }
    }
    return false;
  }

  /** @param {any} world @param {any} b @param {number} i */
  furniture(world, b, i) {
    const nav = world.nav;
    if (!b || b.kind === 'curtain') return;
    const floor = typeof world.floorY === 'function' ? world.floorY(b.cx, b.cz) : b.y0;
    const hgt = b.y1 - floor;
    if (!(hgt >= COVER.minHeight) || hgt > 2.6) return;
    // local axes: u = (c, s), v = (−s, c); sides at ±(hx + off) along u and ±(hz + off) along v
    const c = b.c, s = b.s;
    for (let side = 0; side < 4; side++) {
      const alongU = side < 2, sg = side % 2 === 0 ? 1 : -1;
      const nx = alongU ? c * sg : -s * sg, nz = alongU ? s * sg : c * sg; // outward normal of that face
      const tx = -nz, tz = nx; // along the face
      const half = alongU ? b.hz : b.hx; // the face's half length
      const dist = (alongU ? b.hx : b.hz) + COVER.off;
      const parts = 2 * half > COVER.splitLen ? 2 : 1;
      for (let p = 0; p < parts; p++) {
        const along = parts === 1 ? 0 : (p === 0 ? -0.5 : 0.5) * half;
        const x = b.cx + nx * dist + tx * along, z = b.cz + nz * dist + tz * along;
        // peek past the nearer end of the face
        const endSg = along < 0 ? -1 : along > 0 ? 1 : (i + side) % 2 === 0 ? 1 : -1;
        const ex = b.cx + nx * dist + tx * endSg * (half + COVER.peekOff), ez = b.cz + nz * dist + tz * endSg * (half + COVER.peekOff);
        if (this.add(nav, x, z, -nx, -nz, ex, ez, hgt, COVER_FURN)) this.stats.furniture++;
      }
    }
  }

  /** @param {import('./NavGrid.js').NavGrid} nav @param {any} d */
  doorway(nav, d) {
    if (!d || !d.open || !d.walkable) return;
    const hw = d.width / 2;
    for (let face = -1; face <= 1; face += 2) {
      // the room on this side: n · face; covered from the far side through the wall (dir = −n · face)
      const ox = d.nx * face * COVER.jambOff, oz = d.nz * face * COVER.jambOff;
      for (let end = -1; end <= 1; end += 2) {
        const a = hw + COVER.jambAlong;
        const x = d.cx + d.tx * end * a + ox, z = d.cz + d.tz * end * a + oz;
        const qx = d.cx + d.nx * face * COVER.doorPeekBack, qz = d.cz + d.nz * face * COVER.doorPeekBack;
        if (this.add(nav, x, z, -d.nx * face, -d.nz * face, qx, qz, 2.0, COVER_JAMB)) this.stats.jambs++;
      }
    }
  }

  /**
   * @param {import('./NavGrid.js').NavGrid} nav
   * @param {number} x @param {number} z @param {number} dx @param {number} dz
   * @param {number} px @param {number} pz @param {number} h @param {number} kind
   * @returns {boolean}
   */
  add(nav, x, z, dx, dz, px, pz, h, kind) {
    if (this.count >= this.max) return false;
    const i = nav.index(x, z);
    if (i < 0 || (nav.flags[i] & NAV_WALK) === 0 || (nav.flags[i] & NAV_HIDDEN) !== 0) { this.stats.rejected++; return false; }
    // the peek point must be walkable too (else he could never fire from here): pull it back toward the point
    let qx = px, qz = pz, ok = false;
    for (let t = 0; t < 4; t++) {
      const j = nav.index(qx, qz);
      if (j >= 0 && (nav.flags[j] & NAV_WALK) !== 0 && nav.lineWalkable(x, z, qx, qz)) { ok = true; break; }
      qx = x + (qx - x) * 0.7; qz = z + (qz - z) * 0.7;
    }
    if (!ok || (qx - x) * (qx - x) + (qz - z) * (qz - z) < 0.2 * 0.2) { this.stats.rejected++; return false; }
    const k = this.count++;
    this.x[k] = x; this.z[k] = z; this.dx[k] = dx; this.dz[k] = dz; this.px[k] = qx; this.pz[k] = qz;
    this.h[k] = h; this.room[k] = nav.room ? nav.room[i] : 0; this.kind[k] = kind;
    return true;
  }

  /** Points in room `r` (0: none). @param {number} r */
  inRoom(r) {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.room[i] === r) n++;
    return n;
  }
}

/**
 * Room clearing (v0.6): where the house's defenders wait at the round start. Every room but the player's that
 * holds furniture or door-frame cover gets one defender (two in a room of 12 m² or more), at the cover point that
 * hides him best from the room's doors (farthest from them, a furniture point first), facing the nearest door,
 * up to `max` in all; rooms nearer the player come first so every room has a chance before a big house runs out.
 * Pure: reads the world (layout, nav, roomAt, roamIndex), allocates its result (round start only).
 * @param {any} world @param {CoverIndex} cover @param {number} px @param {number} pz player head @param {number} max
 * @param {() => number} rand [0, 1)
 * @returns {{ x: number, z: number, yaw: number, room: number, cover: number }[]}
 */
export function planHides(world, cover, px, pz, max, rand) {
  /** @type {{ x: number, z: number, yaw: number, room: number, cover: number }[]} */ const out = [];
  if (!world || !world.nav || !cover || cover.count === 0) return out;
  const nav = world.nav, R = world.roamIndex || null;
  const playerRoom = typeof world.roomAt === 'function' ? world.roomAt(px, pz) : 0;
  /** @type {Map<number, number[]>} */ const byRoom = new Map();
  for (let i = 0; i < cover.count; i++) {
    const r = cover.room[i];
    if (!r || r === playerRoom) continue;
    if (R && R.roomFlags && (R.roomFlags[r] & (ROOM_VIRTUAL | ROOM_POCKET)) !== 0) continue; // unscanned / a pocket: no defenders inside
    let a = byRoom.get(r);
    if (!a) { a = []; byRoom.set(r, a); }
    a.push(i);
  }
  /** doors of a room (centres), from the Roam index when present */
  const doorsOf = (/** @type {number} */ r) => {
    /** @type {number[]} */ const d = [];
    if (R && R.doorCount) for (let k = 0; k < R.doorCount; k++) if (R.doorRoomA[k] === r || R.doorRoomB[k] === r) d.push(R.doorX[k], R.doorZ[k]);
    return d;
  };
  const rooms = [...byRoom.keys()].map((r) => {
    const pts = /** @type {number[]} */ (byRoom.get(r));
    let sx = 0, sz = 0;
    for (const i of pts) { sx += cover.x[i]; sz += cover.z[i]; }
    const d = Math.hypot(sx / pts.length - px, sz / pts.length - pz);
    let cells = 0;
    if (R && R.roomCells) cells = R.roomCells[r];
    else if (nav.room) for (let c = 0; c < nav.count; c++) if (nav.room[c] === r) cells++;
    return { r, pts, d, area: cells * nav.cell * nav.cell };
  }).filter((q) => q.area >= 2.0).sort((a, b) => a.d - b.d);
  // one each first, then the second defender of the big rooms
  for (let pass = 0; pass < 2 && out.length < max; pass++) {
    for (const q of rooms) {
      if (out.length >= max) break;
      if (pass === 1 && q.area < 12) continue;
      const doors = doorsOf(q.r);
      let best = -1, bestSc = -Infinity;
      for (const i of q.pts) {
        if (cover.taken[i]) continue;
        let dmin = 6;
        for (let k = 0; k < doors.length; k += 2) dmin = Math.min(dmin, Math.hypot(cover.x[i] - doors[k], cover.z[i] - doors[k + 1]));
        let near = 9;
        for (const o of out) near = Math.min(near, Math.hypot(cover.x[i] - o.x, cover.z[i] - o.z));
        if (near < 1.5) continue;
        const sc = dmin + (cover.kind[i] === COVER_FURN ? 1.0 : 0) + rand() * 0.8;
        if (sc > bestSc) { bestSc = sc; best = i; }
      }
      if (best < 0) continue;
      cover.taken[best] = 1;
      // face the nearest door (where the player comes in), else the player
      let fx = px, fz = pz, dbest = Infinity;
      for (let k = 0; k < doors.length; k += 2) {
        const dd = Math.hypot(cover.x[best] - doors[k], cover.z[best] - doors[k + 1]);
        if (dd < dbest) { dbest = dd; fx = doors[k]; fz = doors[k + 1]; }
      }
      out.push({ x: cover.x[best], z: cover.z[best], yaw: Math.atan2(fx - cover.x[best], fz - cover.z[best]), room: q.r, cover: best });
    }
  }
  cover.taken.fill(0);
  return out;
}

/**
 * Home defense (v0.6): the doors enemies breach through: the Roam index's doors that lead out of the mapped house
 * (`doorExterior`), those into unmapped space first (a front door), then into pockets / unscanned rooms. Indices
 * into the Roam index's door arrays. Round start only (allocates).
 * @param {any} world
 * @returns {number[]}
 */
export function breachDoors(world) {
  const R = world && world.roamIndex;
  if (!R || !R.doorCount) return [];
  const L = world.layout, out = [], second = [];
  for (let k = 0; k < R.doorCount; k++) {
    if (!R.doorExterior[k]) continue;
    const d = L && L.doors ? L.doors[k] : null;
    if (d && (!d.open || !d.walkable)) continue;
    (d && d.leadsTo === 'unmapped' ? out : second).push(k);
  }
  return out.length ? out : second;
}

/**
 * Home defense (v0.6): a spawn point right behind exterior door `k` (a Roam index door), on its outer side: a
 * spawn candidate within 2.8 m of the door centre in the door's unscanned / pocket room (hidden by the door's
 * curtain until he steps through), at least 3.5 m from the player. Writes out.x / out.z.
 * @param {any} world @param {number} k @param {number} px @param {number} pz
 * @param {{ x: number, z: number }} out @param {number} r a random number in [0, 1)
 * @returns {boolean}
 */
export function breachSpawn(world, k, px, pz, out, r) {
  const R = world && world.roamIndex, S = world && world.spawner, nav = world && world.nav;
  if (!R || !S || !nav || !(k >= 0 && k < R.doorCount)) return false;
  const dx = R.doorX[k], dz = R.doorZ[k], ra = R.doorRoomA[k], rb = R.doorRoomB[k];
  const outer = (/** @type {number} */ r0) => r0 === 0 || (R.roomFlags[r0] & (ROOM_VIRTUAL | ROOM_POCKET)) !== 0;
  const oa = outer(ra), ob = outer(rb);
  let pick = -1;
  for (let pass = 0; pass < 2 && pick < 0; pass++) {
    // count the valid ones, then take the one the random number lands on
    let n = 0;
    for (let step = 0; step < 2 && pick < 0; step++) {
      const want = step === 1 ? Math.min(n - 1, Math.floor(r * n)) : -1;
      if (step === 1 && n === 0) break;
      let m = 0;
      for (let c = 0; c < S.count; c++) {
        const x = S.x[c], z = S.z[c];
        if ((x - dx) * (x - dx) + (z - dz) * (z - dz) > 2.8 * 2.8) continue;
        if ((x - px) * (x - px) + (z - pz) * (z - pz) < 3.5 * 3.5) continue;
        const rc = S.room[c], cell = S.cell[c];
        const hidden = cell >= 0 && (nav.flags[cell] & NAV_HIDDEN) !== 0;
        const ok = pass === 0 ? ((oa && rc === ra && ra !== 0) || (ob && rc === rb && rb !== 0) || (hidden && rc !== ra && rc !== rb) || S.pocket[c] === 1)
          : hidden || S.pocket[c] === 1;
        if (!ok) continue;
        if (step === 0) n++;
        else if (m++ === want) { pick = c; break; }
      }
    }
  }
  if (pick < 0) return false;
  out.x = S.x[pick];
  out.z = S.z[pick];
  return true;
}
