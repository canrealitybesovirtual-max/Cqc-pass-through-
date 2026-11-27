// @ts-check
/**
 * Time-sliced A* on a NavGrid (pure; typed arrays; no allocation after
 * construction). One search runs at a time; others queue. `step(n)` expands at
 * most n nodes and resumes the same search next call, so the main thread can
 * give path finding a fixed per-frame quota (PLAN §9: start ≈ 1,000 expansions,
 * then set the quota to ≤ 0.4 ms from measured expansions/ms on the Quest).
 *
 * - 8-connected, no corner cutting (a diagonal needs both side cells walkable).
 * - Octile heuristic (admissible: every step costs at least its length).
 * - Cost penalty near walls: cells within `wallBand` of the minimum clearance
 *   cost up to (1 + wallCost)×, so paths keep off walls where there is room.
 * - Expansion cap per search = the grid's walkable cell count.
 * - Unreachable goals (different region) fail at once, with no search.
 * - Straight walkable line from start to goal → a 2-point path, with no search.
 * - Paths are smoothed by string-pulling with grid line checks and stored in
 *   preallocated Float32Arrays as x,z pairs, from the start to the goal.
 */

import { IndexedMinHeap } from './Heap.js';
import { NAV_WALK } from './NavGrid.js';

export const PATH_PENDING = -1;
export const PATH_FAILED = -2;

const IDLE = 0, QUEUED = 1, ACTIVE = 2, DONE = 3, FAILED = 4;
const SQRT2 = Math.SQRT2;
const NDX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NDZ = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);

export class PathPlanner {
  /**
   * @param {import('./NavGrid.js').NavGrid} nav buffers are sized to nav.capacity, so build the
   *   planner at load (before World.build) and keep it for the whole page
   * @param {{ maxRequests?: number, maxPoints?: number, wallCost?: number, wallBand?: number, snapRadius?: number }} [o]
   */
  constructor(nav, { maxRequests = 16, maxPoints = 64, wallCost = 1.5, wallBand = 0.3, snapRadius = 1.0 } = {}) {
    this.nav = nav;
    const cap = nav.capacity;
    this.g = new Float32Array(cap);
    this.parent = new Int32Array(cap);
    this.seen = new Uint32Array(cap);
    this.closed = new Uint32Array(cap);
    this.gen = 0;
    this.heap = new IndexedMinHeap(cap);
    this.cells = new Int32Array(cap);
    this.maxRequests = maxRequests;
    this.maxPoints = maxPoints;
    this.wallCost = wallCost;
    this.wallBand = wallBand;
    this.snapRadius = snapRadius;
    this.status = new Uint8Array(maxRequests);
    this.req = new Float64Array(maxRequests * 4);
    this.paths = new Float32Array(maxRequests * maxPoints * 2);
    this.counts = new Int32Array(maxRequests);
    this.queue = new Int32Array(maxRequests);
    /** 1 while an id has an entry in the queue (a cancelled entry stays until dequeued). */
    this.inQueue = new Uint8Array(maxRequests);
    this.qHead = 0;
    this.qLen = 0;
    this.active = -1;
    this.goalCell = -1;
    this.gx = 0;
    this.gz = 0;
    this.expanded = 0;
    this.cap = 0;
    // Exact endpoints of the active search.
    this.ax = 0;
    this.az = 0;
    this.bx = 0;
    this.bz = 0;
    this.navVersion = nav.version;
    this.stats = { searches: 0, direct: 0, failures: 0, expansions: 0, lastExpansions: 0, truncated: 0 };
  }

  /**
   * Ask for a path; replaces any earlier request with this id.
   * @param {number} id 0 … maxRequests-1 (e.g. the enemy index)
   * @param {number} sx @param {number} sz start
   * @param {number} gx @param {number} gz goal
   */
  request(id, sx, sz, gx, gz) {
    this.sync();
    if (!(id >= 0 && id < this.maxRequests)) return;
    const o = id * 4;
    this.req[o] = sx; this.req[o + 1] = sz; this.req[o + 2] = gx; this.req[o + 3] = gz;
    if (this.status[id] === ACTIVE) this.abort();
    if (!this.inQueue[id]) {
      this.queue[(this.qHead + this.qLen) % this.maxRequests] = id;
      this.qLen++;
      this.inQueue[id] = 1;
    }
    this.status[id] = QUEUED;
    this.counts[id] = 0;
  }

  /** @param {number} id */
  cancel(id) {
    if (!(id >= 0 && id < this.maxRequests)) return;
    if (this.status[id] === ACTIVE) this.abort();
    this.status[id] = IDLE; // a queued entry is skipped when dequeued
  }

  /**
   * Run up to `maxExpansions` node expansions, across queued requests.
   * @param {number} maxExpansions
   * @returns {number} expansions done
   */
  step(maxExpansions) {
    this.sync();
    let done = 0;
    while (done < maxExpansions) {
      if (this.active < 0) {
        if (!this.startNext()) break;
        continue;
      }
      done += this.expand(maxExpansions - done);
    }
    this.stats.expansions += done;
    return done;
  }

  /**
   * @param {number} id
   * @param {Float32Array} outPath receives x,z pairs (start … goal)
   * @returns {number} points written, PATH_PENDING (-1) while queued or searching,
   *   PATH_FAILED (-2) when unreachable, cancelled or never requested
   */
  result(id, outPath) {
    if (!(id >= 0 && id < this.maxRequests)) return PATH_FAILED;
    this.sync();
    const st = this.status[id];
    if (st === QUEUED || st === ACTIVE) return PATH_PENDING;
    if (st !== DONE) return PATH_FAILED;
    const n = Math.min(this.counts[id], outPath.length >> 1);
    const o = id * this.maxPoints * 2;
    for (let i = 0; i < 2 * n; i++) outPath[i] = this.paths[o + i];
    return n;
  }

  /** Requests queued or searching. */
  pending() {
    let n = 0;
    for (let i = 0; i < this.maxRequests; i++) if (this.status[i] === QUEUED || this.status[i] === ACTIVE) n++;
    return n;
  }

  // ------------------------------------------------------------------ internals

  /** A rebuilt grid invalidates every search and result. */
  sync() {
    if (this.nav.version === this.navVersion) return;
    this.navVersion = this.nav.version;
    this.heap.clear();
    this.active = -1;
    this.status.fill(IDLE);
    this.inQueue.fill(0);
    this.qHead = this.qLen = 0;
  }

  abort() {
    this.heap.clear();
    this.active = -1;
  }

  /** @returns {boolean} false when the queue is empty */
  startNext() {
    while (this.qLen > 0) {
      const id = this.queue[this.qHead];
      this.qHead = (this.qHead + 1) % this.maxRequests;
      this.qLen--;
      this.inQueue[id] = 0;
      if (this.status[id] !== QUEUED) continue;
      this.begin(id);
      return true;
    }
    return false;
  }

  /** @param {number} id */
  begin(id) {
    const nav = this.nav, o = id * 4;
    const sx = this.req[o], sz = this.req[o + 1], gx = this.req[o + 2], gz = this.req[o + 3];
    this.stats.searches++;
    const s0 = nav.index(sx, sz), g0 = nav.index(gx, gz);
    const s = s0 >= 0 && (nav.flags[s0] & NAV_WALK) ? s0 : nav.nearestWalkable(sx, sz, this.snapRadius);
    const g = g0 >= 0 && (nav.flags[g0] & NAV_WALK) ? g0 : nav.nearestWalkable(gx, gz, this.snapRadius);
    if (s < 0 || g < 0 || nav.region[s] !== nav.region[g]) { this.fail(id); return; }
    this.ax = s === s0 ? sx : nav.centerX(s);
    this.az = s === s0 ? sz : nav.centerZ(s);
    this.bx = g === g0 ? gx : nav.centerX(g);
    this.bz = g === g0 ? gz : nav.centerZ(g);
    if (s === g || nav.lineWalkable(this.ax, this.az, this.bx, this.bz)) {
      const p = id * this.maxPoints * 2;
      this.paths[p] = this.ax; this.paths[p + 1] = this.az;
      this.paths[p + 2] = this.bx; this.paths[p + 3] = this.bz;
      this.counts[id] = 2;
      this.status[id] = DONE;
      this.stats.direct++;
      this.stats.lastExpansions = 0;
      return;
    }
    if (++this.gen >= 0xffffffff) { this.seen.fill(0); this.closed.fill(0); this.gen = 1; }
    this.heap.clear();
    const w = nav.w;
    this.goalCell = g;
    this.gx = g % w;
    this.gz = (g - this.gx) / w;
    this.seen[s] = this.gen;
    this.g[s] = 0;
    this.parent[s] = -1;
    this.heap.push(s, this.h(s));
    this.active = id;
    this.status[id] = ACTIVE;
    this.expanded = 0;
    this.cap = Math.max(64, nav.walkableCount);
  }

  /** @param {number} c cell @returns {number} octile distance to the goal (m) */
  h(c) {
    const w = this.nav.w;
    const ix = c % w, iz = (c - ix) / w;
    const dx = ix > this.gx ? ix - this.gx : this.gx - ix, dz = iz > this.gz ? iz - this.gz : this.gz - iz;
    return (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx) * this.nav.cell;
  }

  /**
   * @param {number} quota
   * @returns {number} expansions done
   */
  expand(quota) {
    const nav = this.nav, w = nav.w, hgt = nav.h, fl = nav.flags, clr = nav.clr, cell = nav.cell;
    const gen = this.gen, seen = this.seen, closed = this.closed, G = this.g, parent = this.parent, heap = this.heap;
    const minC = nav.agentClear, band = this.wallBand, wc = this.wallCost, gxi = this.gx, gzi = this.gz, K = SQRT2 - 1;
    let n = 0;
    while (n < quota) {
      const c = heap.pop();
      if (c < 0) { this.fail(this.active); this.active = -1; return n; }
      closed[c] = gen;
      n++;
      this.expanded++;
      if (c === this.goalCell) { this.finish(); return n; }
      if (this.expanded > this.cap) { const id = this.active; this.abort(); this.fail(id); return n; }
      const ix = c % w, iz = (c - ix) / w, gc = G[c];
      for (let k = 0; k < 8; k++) {
        const jx = ix + NDX[k], jz = iz + NDZ[k];
        if (jx < 0 || jz < 0 || jx >= w || jz >= hgt) continue;
        const j = jz * w + jx;
        if ((fl[j] & NAV_WALK) === 0 || closed[j] === gen) continue;
        if (k >= 4 && ((fl[iz * w + jx] & NAV_WALK) === 0 || (fl[jz * w + ix] & NAV_WALK) === 0)) continue;
        const cj = clr[j];
        const pen = cj >= minC + band ? 0 : 1 - (cj - minC) / band;
        const ng = gc + (k >= 4 ? SQRT2 * cell : cell) * (1 + wc * (pen > 1 ? 1 : pen));
        if (seen[j] !== gen || ng < G[j]) {
          seen[j] = gen;
          G[j] = ng;
          parent[j] = c;
          // Octile heuristic, inlined (a non-inlined call returning a double boxes it).
          const hx = jx > gxi ? jx - gxi : gxi - jx, hz = jz > gzi ? jz - gzi : gzi - jz;
          heap.push(j, ng + (hx > hz ? hx + K * hz : hz + K * hx) * cell);
        }
      }
    }
    return n;
  }

  /** @param {number} id */
  fail(id) {
    if (id >= 0 && id < this.maxRequests) this.status[id] = FAILED;
    this.stats.failures++;
    this.stats.lastExpansions = this.expanded;
  }

  finish() {
    const id = this.active, nav = this.nav, cells = this.cells;
    // Goal → start, then reverse into path order.
    let m = 0;
    for (let c = this.goalCell; c >= 0; c = this.parent[c]) cells[m++] = c;
    for (let i = 0, j = m - 1; i < j; i++, j--) { const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
    // String-pulling: from each anchor, the farthest path point still in a walkable straight line.
    // Points: the exact start, cell centres, the exact goal (computed inline: no boxed doubles).
    const P = this.paths, base = id * this.maxPoints * 2, maxP = this.maxPoints;
    const w = nav.w, ox = nav.ox + 0.5 * nav.cell, oz = nav.oz + 0.5 * nav.cell, cs = nav.cell, last = m - 1;
    P[base] = this.ax;
    P[base + 1] = this.az;
    let k = 1, anchor = 0, axp = this.ax, azp = this.az;
    while (anchor < last && k < maxP) {
      let j = anchor + 1;
      for (;;) {
        const q = j + 1;
        if (q > last) break;
        const c = cells[q];
        const qx = q === last ? this.bx : ox + (c % w) * cs, qz = q === last ? this.bz : oz + Math.floor(c / w) * cs;
        if (!nav.lineWalkable(axp, azp, qx, qz)) break;
        j = q;
      }
      const c = cells[j];
      axp = j === last ? this.bx : ox + (c % w) * cs;
      azp = j === last ? this.bz : oz + Math.floor(c / w) * cs;
      P[base + 2 * k] = axp;
      P[base + 2 * k + 1] = azp;
      k++;
      anchor = j;
    }
    if (anchor < m - 1) this.stats.truncated++;
    this.counts[id] = k;
    this.status[id] = DONE;
    this.stats.lastExpansions = this.expanded;
    this.heap.clear();
    this.active = -1;
  }

}
