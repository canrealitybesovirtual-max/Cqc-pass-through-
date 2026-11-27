// @ts-check
/**
 * Navigation grid (pure; no three.js, no DOM). 0.10 m cells, axis-aligned in
 * the reference space, fixed capacity so a PathPlanner built at load never has
 * to reallocate after the world is built.
 *
 * Per cell:
 * - `flags` (bits below);
 * - `clr`: clearance, the distance in metres from the cell centre to the nearest
 *   obstacle (outside the floor, a wall, or a furniture footprint + 2 cm),
 *   from an exact Euclidean distance transform;
 * - `region`: 4-connected component id of walkable cells (0 = none). 8-connected
 *   moves without corner cutting connect exactly the same cells;
 * - `pathDist`: path length in metres from the player start (through the
 *   player zone), Infinity when unreachable;
 * - `doors`: door openings crossed on that shortest path (0 = the player's room);
 * - `floorIdx`: which floor polygon the cell belongs to (nearest floor outside).
 *
 * Walkable (the `WALK` bit, what `isWalkable` reads) = on a mapped floor or a
 * carved door gap, not a wall, not a furniture footprint + 0.25 m, not the
 * player zone (r + 1.2 m), and clearance ≥ the agent clearance (0.28 m:
 * radius 0.25 + 0.03, PLAN §9). So a walkable cell is a valid CENTRE position
 * for an enemy: its body never overlaps a wall or furniture. Inside a carved
 * door gap the clearance needed is `doorClear` (finalize's 4th argument; the
 * world passes 0.24 m, so a 0.6 m door frame lets an enemy through, PLAN §6.2's
 * 0.62 m warning): the body may brush a jamb by 1 cm, which the occluder's 2 cm
 * jamb shrink never cuts.
 *
 * Flags are 16-bit (NAV_POCKET is bit 8).
 */

import { pointInPolygon } from '../util/geom2d.js';
import { IndexedMinHeap } from './Heap.js';

export const NAV_CELL = 0.1;
export const NAV_INSIDE = 1; // on a mapped (or virtual) floor polygon
export const NAV_WALL = 2; // wall slab (+ half a cell)
export const NAV_FURN = 4; // furniture footprint + 0.25 m
export const NAV_ZONE = 8; // player zone (r + 1.2 m)
export const NAV_DOOR = 16; // carved door gap
export const NAV_OBST = 32; // raw furniture footprint + 2 cm (distance-transform obstacle)
export const NAV_WALK = 64; // walkable for an enemy centre
export const NAV_VIRTUAL = 128; // virtual floor (no Space Setup data there)
export const NAV_POCKET = 256; // virtual spawn pocket behind a door into unmapped space (also NAV_VIRTUAL)

const SQRT2 = Math.SQRT2;
const BIG = 1e12;
/** Neighbour offsets: 4 orthogonal, then 4 diagonal. */
const NDX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NDZ = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);

export class NavGrid {
  /**
   * @param {number} [capacity] maximum cells (65,536 = a 25.6 m square at 0.10 m)
   * @param {number} [cell] metres
   */
  constructor(capacity = 65536, cell = NAV_CELL) {
    this.capacity = capacity;
    this.cell = cell;
    this.inv = 1 / cell;
    this.w = 0;
    this.h = 0;
    this.count = 0;
    /** World x/z of the min corner of cell (0, 0). */
    this.ox = 0;
    this.oz = 0;
    this.flags = new Uint16Array(capacity);
    this.clr = new Float32Array(capacity);
    this.region = new Uint16Array(capacity);
    this.pathDist = new Float32Array(capacity);
    this.doors = new Uint8Array(capacity);
    this.floorIdx = new Int8Array(capacity);
    /** Reachable-from-the-player flag per region id. */
    this.reach = new Uint8Array(65536);
    this.agentClear = 0.28;
    this.doorClear = 0.28;
    this.walkableCount = 0;
    this.regionCount = 0;
    /** Bumped on every rebuild; planners drop stale searches when it changes. */
    this.version = 0;
    /** Cell index the path field starts from (-1 if the start had no walkable cell nearby). */
    this.startCell = -1;
    this._queue = new Int32Array(capacity);
    /** @type {Float64Array|null} */ this._tmp = null;
  }

  /**
   * Clear and resize (at build).
   * @param {number} ox @param {number} oz
   * @param {number} w @param {number} h
   */
  reset(ox, oz, w, h) {
    if (w * h > this.capacity || w <= 0 || h <= 0) throw new Error(`NavGrid: ${w}×${h} exceeds capacity ${this.capacity}`);
    this.ox = ox;
    this.oz = oz;
    this.w = w;
    this.h = h;
    this.count = w * h;
    this.flags.fill(0, 0, this.count);
    this.clr.fill(0, 0, this.count);
    this.region.fill(0, 0, this.count);
    this.pathDist.fill(Infinity, 0, this.count);
    this.doors.fill(0, 0, this.count);
    this.floorIdx.fill(-1, 0, this.count);
    this.walkableCount = 0;
    this.regionCount = 0;
    this.startCell = -1;
    this.version++;
  }

  // ---------------------------------------------------------------- queries (allocation-free)

  /** @param {number} x @param {number} z @returns {number} cell index or -1 */
  index(x, z) {
    const ix = Math.floor((x - this.ox) * this.inv), iz = Math.floor((z - this.oz) * this.inv);
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
    return iz * this.w + ix;
  }

  /** @param {number} x @param {number} z */
  isWalkable(x, z) {
    const i = this.index(x, z);
    return i >= 0 && (this.flags[i] & NAV_WALK) !== 0;
  }

  /** Clearance in metres (0 outside the grid or on an obstacle). @param {number} x @param {number} z */
  clearance(x, z) {
    const i = this.index(x, z);
    return i >= 0 ? this.clr[i] : 0;
  }

  /** @param {number} x @param {number} z */
  pathDistance(x, z) {
    const i = this.index(x, z);
    return i >= 0 ? this.pathDist[i] : Infinity;
  }

  /** Is (x, z) walkable and connected to the player's area? @param {number} x @param {number} z */
  isReachable(x, z) {
    const i = this.index(x, z);
    return i >= 0 && (this.flags[i] & NAV_WALK) !== 0 && this.reach[this.region[i]] === 1;
  }

  /** @param {number} ix @param {number} iz */
  walkableAt(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.w && iz < this.h && (this.flags[iz * this.w + ix] & NAV_WALK) !== 0;
  }

  /** @param {number} i */
  centerX(i) {
    return this.ox + ((i % this.w) + 0.5) * this.cell;
  }

  /** @param {number} i */
  centerZ(i) {
    return this.oz + (Math.floor(i / this.w) + 0.5) * this.cell;
  }

  /**
   * Nearest walkable cell centre within `maxR` metres of (x, z).
   * @param {number} x @param {number} z @param {number} maxR
   * @returns {number} cell index or -1
   */
  nearestWalkable(x, z, maxR) {
    const w = this.w, h = this.h, cell = this.cell;
    const ix0 = Math.floor((x - this.ox) * this.inv), iz0 = Math.floor((z - this.oz) * this.inv);
    const R = Math.ceil(maxR * this.inv) + 1;
    const max2 = maxR * maxR;
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= R; r++) {
      for (let k = -r; k <= r; k++) {
        for (let e = 0; e < 4; e++) {
          // Ring cells: top/bottom rows for e = 0/1, left/right columns (excluding corners) for e = 2/3.
          let ix, iz;
          if (e === 0) { ix = ix0 + k; iz = iz0 - r; } else if (e === 1) { if (r === 0) continue; ix = ix0 + k; iz = iz0 + r; } else {
            if (k === -r || k === r) continue;
            ix = e === 2 ? ix0 - r : ix0 + r; iz = iz0 + k;
          }
          if (ix < 0 || iz < 0 || ix >= w || iz >= h) continue;
          const i = iz * w + ix;
          if ((this.flags[i] & NAV_WALK) === 0) continue;
          const dx = this.ox + (ix + 0.5) * cell - x, dz = this.oz + (iz + 0.5) * cell - z;
          const d = dx * dx + dz * dz;
          if (d < bestD && d <= max2) { bestD = d; best = i; }
        }
      }
      if (best >= 0 && bestD <= (r * cell) * (r * cell)) break;
    }
    return best;
  }

  /**
   * Every cell the segment passes through is walkable (grid traversal; a
   * diagonal step exactly through a corner needs both side cells, so it never
   * cuts a corner).
   * @param {number} ax @param {number} az @param {number} bx @param {number} bz
   */
  lineWalkable(ax, az, bx, bz) {
    const inv = this.inv;
    let ix = Math.floor((ax - this.ox) * inv), iz = Math.floor((az - this.oz) * inv);
    const jx = Math.floor((bx - this.ox) * inv), jz = Math.floor((bz - this.oz) * inv);
    if (!this.walkableAt(ix, iz)) return false;
    const dx = bx - ax, dz = bz - az;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const adx = dx < 0 ? -dx : dx, adz = dz < 0 ? -dz : dz;
    const tdx = adx > 1e-12 ? this.cell / adx : Infinity, tdz = adz > 1e-12 ? this.cell / adz : Infinity;
    let tmx = adx > 1e-12 ? (dx > 0 ? this.ox + (ix + 1) * this.cell - ax : ax - (this.ox + ix * this.cell)) / adx : Infinity;
    let tmz = adz > 1e-12 ? (dz > 0 ? this.oz + (iz + 1) * this.cell - az : az - (this.oz + iz * this.cell)) / adz : Infinity;
    let n = (jx > ix ? jx - ix : ix - jx) + (jz > iz ? jz - iz : iz - jz);
    while (n > 0) {
      if (tmx < tmz - 1e-12) { ix += sx; tmx += tdx; n--; }
      else if (tmz < tmx - 1e-12) { iz += sz; tmz += tdz; n--; }
      else {
        if (!this.walkableAt(ix + sx, iz) || !this.walkableAt(ix, iz + sz)) return false;
        ix += sx; iz += sz; tmx += tdx; tmz += tdz; n -= 2;
      }
      if (!this.walkableAt(ix, iz)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- rasterisation (build time)

  /**
   * Set `bits` on cells whose centre is inside the polygon (even–odd).
   * @param {ArrayLike<number>} pts flat x,z
   * @param {number} n
   * @param {number} bits
   * @param {number} floorIndex written to cells that have none yet (-1 = don't)
   */
  fillPolygon(pts, n, bits, floorIndex) {
    let z0 = Infinity, z1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, pts[2 * i]); x1 = Math.max(x1, pts[2 * i]);
      z0 = Math.min(z0, pts[2 * i + 1]); z1 = Math.max(z1, pts[2 * i + 1]);
    }
    const ix0 = Math.max(0, Math.floor((x0 - this.ox) * this.inv)), ix1 = Math.min(this.w - 1, Math.floor((x1 - this.ox) * this.inv));
    const iz0 = Math.max(0, Math.floor((z0 - this.oz) * this.inv)), iz1 = Math.min(this.h - 1, Math.floor((z1 - this.oz) * this.inv));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = this.oz + (iz + 0.5) * this.cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.ox + (ix + 0.5) * this.cell;
        if (!pointInPolygon(pts, n, x, z)) continue;
        const i = iz * this.w + ix;
        this.flags[i] |= bits;
        if (floorIndex >= 0 && this.floorIdx[i] < 0) this.floorIdx[i] = floorIndex;
      }
    }
  }

  /**
   * Visit cells whose centre lies in an oriented box grown by `inflate`.
   * @param {number} cx @param {number} cz @param {number} c @param {number} s
   * @param {number} hx @param {number} hz @param {number} inflate
   * @param {number} setBits
   * @param {number} [clearBits]
   */
  fillBox(cx, cz, c, s, hx, hz, inflate, setBits, clearBits = 0) {
    const ex = hx + inflate, ez = hz + inflate;
    const rx = Math.abs(c) * ex + Math.abs(s) * ez, rz = Math.abs(s) * ex + Math.abs(c) * ez;
    const ix0 = Math.max(0, Math.floor((cx - rx - this.ox) * this.inv)), ix1 = Math.min(this.w - 1, Math.floor((cx + rx - this.ox) * this.inv));
    const iz0 = Math.max(0, Math.floor((cz - rz - this.oz) * this.inv)), iz1 = Math.min(this.h - 1, Math.floor((cz + rz - this.oz) * this.inv));
    const keep = ~clearBits & 0xffff;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.oz + (iz + 0.5) * this.cell - cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.ox + (ix + 0.5) * this.cell - cx;
        const lx = dx * c + dz * s, lz = dz * c - dx * s;
        if (lx < -ex || lx > ex || lz < -ez || lz > ez) continue;
        const i = iz * this.w + ix;
        this.flags[i] = (this.flags[i] & keep) | setBits;
      }
    }
  }

  /**
   * @param {number} x @param {number} z @param {number} r @param {number} bits
   */
  fillDisc(x, z, r, bits) {
    const ix0 = Math.max(0, Math.floor((x - r - this.ox) * this.inv)), ix1 = Math.min(this.w - 1, Math.floor((x + r - this.ox) * this.inv));
    const iz0 = Math.max(0, Math.floor((z - r - this.oz) * this.inv)), iz1 = Math.min(this.h - 1, Math.floor((z + r - this.oz) * this.inv));
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.oz + (iz + 0.5) * this.cell - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.ox + (ix + 0.5) * this.cell - x;
        if (dx * dx + dz * dz <= r2) this.flags[iz * this.w + ix] |= bits;
      }
    }
  }

  /**
   * Count the cells whose centre lies in an oriented box and whose flags hold
   * every bit of `mask` (build-time diagnostics, e.g. walkable door cells).
   * With `reachable`, only walkable cells in a region connected to the player.
   * @param {number} cx @param {number} cz @param {number} c @param {number} s
   * @param {number} hx @param {number} hz
   * @param {number} mask
   * @param {boolean} [reachable]
   * @returns {number}
   */
  countInBox(cx, cz, c, s, hx, hz, mask, reachable = false) {
    const rx = Math.abs(c) * hx + Math.abs(s) * hz, rz = Math.abs(s) * hx + Math.abs(c) * hz;
    const ix0 = Math.max(0, Math.floor((cx - rx - this.ox) * this.inv)), ix1 = Math.min(this.w - 1, Math.floor((cx + rx - this.ox) * this.inv));
    const iz0 = Math.max(0, Math.floor((cz - rz - this.oz) * this.inv)), iz1 = Math.min(this.h - 1, Math.floor((cz + rz - this.oz) * this.inv));
    let n = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.oz + (iz + 0.5) * this.cell - cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.ox + (ix + 0.5) * this.cell - cx;
        const lx = dx * c + dz * s, lz = dz * c - dx * s;
        if (lx < -hx || lx > hx || lz < -hz || lz > hz) continue;
        const i = iz * this.w + ix;
        if ((this.flags[i] & mask) !== mask) continue;
        if (reachable && ((this.flags[i] & NAV_WALK) === 0 || this.reach[this.region[i]] !== 1)) continue;
        n++;
      }
    }
    return n;
  }

  /**
   * Clearance from an exact Euclidean distance transform (Felzenszwalb &
   * Huttenlocher). Obstacles: cells off every floor and door gap, plus any cell
   * with one of `obstacleBits`. Clearance = centre-to-centre distance minus
   * half a cell (≈ distance to the obstacle's edge).
   * @param {number} obstacleBits
   */
  computeClearance(obstacleBits) {
    const w = this.w, h = this.h, n = this.count, cell = this.cell;
    if (!this._tmp || this._tmp.length < n) this._tmp = new Float64Array(this.capacity);
    const g = this._tmp;
    const m = Math.max(w, h);
    const f = new Float64Array(m), d = new Float64Array(m), zb = new Float64Array(m + 1);
    const v = new Int32Array(m);
    for (let i = 0; i < n; i++) {
      const fl = this.flags[i];
      g[i] = (fl & (NAV_INSIDE | NAV_DOOR)) === 0 || (fl & obstacleBits) !== 0 ? 0 : BIG;
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      dt1(f, h, d, v, zb);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = g[row + x];
      dt1(f, w, d, v, zb);
      for (let x = 0; x < w; x++) {
        const d2 = d[x];
        this.clr[row + x] = d2 <= 0 ? 0 : d2 >= BIG ? 1e3 : Math.max(0, Math.sqrt(d2) * cell - 0.5 * cell);
      }
    }
  }

  /**
   * Finish the bake: WALK bits, the path field from the player start, the
   * player zone, regions, reachability and the floor index of every cell.
   * @param {number} agentClear metres
   * @param {number} sx @param {number} sz player start
   * @param {number} [doorClear] metres needed inside carved door gaps (default agentClear)
   */
  finalize(agentClear, sx, sz, doorClear = agentClear) {
    const n = this.count, fl = this.flags, clr = this.clr;
    this.agentClear = agentClear;
    this.doorClear = doorClear;
    // 1) Walkable ignoring the player zone (the path field runs through it).
    for (let i = 0; i < n; i++) {
      const b = fl[i];
      const need = (b & NAV_DOOR) !== 0 ? doorClear : agentClear;
      const ok = (b & (NAV_INSIDE | NAV_DOOR)) !== 0 && (b & (NAV_WALL | NAV_FURN | NAV_OBST)) === 0 && clr[i] >= need;
      fl[i] = ok ? b | NAV_WALK : b & ~NAV_WALK;
    }
    this.pathField(sx, sz);
    // 2) Enemies keep out of the player zone.
    let walk = 0;
    for (let i = 0; i < n; i++) {
      if (fl[i] & NAV_ZONE) fl[i] &= ~NAV_WALK;
      if (fl[i] & NAV_WALK) walk++;
    }
    this.walkableCount = walk;
    this.labelRegions();
    this.reach.fill(0);
    for (let i = 0; i < n; i++) if ((fl[i] & NAV_WALK) && this.pathDist[i] < Infinity) this.reach[this.region[i]] = 1;
    this.reach[0] = 0;
    this.propagateFloors();
  }

  /** 4-connected components of walkable cells. */
  labelRegions() {
    const w = this.w, h = this.h, n = this.count, fl = this.flags, reg = this.region, q = this._queue;
    reg.fill(0, 0, n);
    let id = 0;
    for (let s = 0; s < n; s++) {
      if ((fl[s] & NAV_WALK) === 0 || reg[s] !== 0) continue;
      if (id === 65535) break;
      id++;
      let head = 0, tail = 0;
      q[tail++] = s;
      reg[s] = id;
      while (head < tail) {
        const i = q[head++];
        const ix = i % w, iz = (i - ix) / w;
        if (ix > 0 && (fl[i - 1] & NAV_WALK) && reg[i - 1] === 0) { reg[i - 1] = id; q[tail++] = i - 1; }
        if (ix < w - 1 && (fl[i + 1] & NAV_WALK) && reg[i + 1] === 0) { reg[i + 1] = id; q[tail++] = i + 1; }
        if (iz > 0 && (fl[i - w] & NAV_WALK) && reg[i - w] === 0) { reg[i - w] = id; q[tail++] = i - w; }
        if (iz < h - 1 && (fl[i + w] & NAV_WALK) && reg[i + w] === 0) { reg[i + w] = id; q[tail++] = i + w; }
      }
    }
    this.regionCount = id;
  }

  /**
   * Dijkstra from the walkable cell nearest the player start over WALK cells
   * (8-connected, no corner cutting): path distance and doors crossed.
   * @param {number} sx @param {number} sz
   */
  pathField(sx, sz) {
    const w = this.w, h = this.h, fl = this.flags, dist = this.pathDist, doors = this.doors, cell = this.cell;
    const start = this.nearestWalkable(sx, sz, 3.0);
    this.startCell = start;
    if (start < 0) return;
    const heap = new IndexedMinHeap(this.count);
    dist[start] = Math.hypot(this.centerX(start) - sx, this.centerZ(start) - sz);
    doors[start] = 0;
    heap.push(start, dist[start]);
    for (;;) {
      const i = heap.pop();
      if (i < 0) break;
      const ix = i % w, iz = (i - ix) / w, di = dist[i];
      const inDoor = (fl[i] & NAV_DOOR) !== 0;
      for (let k = 0; k < 8; k++) {
        const jx = ix + NDX[k], jz = iz + NDZ[k];
        if (jx < 0 || jz < 0 || jx >= w || jz >= h) continue;
        const j = jz * w + jx;
        if ((fl[j] & NAV_WALK) === 0) continue;
        if (k >= 4 && ((fl[iz * w + jx] & NAV_WALK) === 0 || (fl[jz * w + ix] & NAV_WALK) === 0)) continue;
        const nd = di + (k >= 4 ? SQRT2 : 1) * cell;
        if (nd < dist[j]) {
          dist[j] = nd;
          const d = doors[i] + ((fl[j] & NAV_DOOR) !== 0 && !inDoor ? 1 : 0);
          doors[j] = d > 255 ? 255 : d;
          heap.push(j, nd);
        }
      }
    }
  }

  /** Cells outside every floor take the index of the nearest floor cell (BFS). */
  propagateFloors() {
    const w = this.w, h = this.h, n = this.count, fi = this.floorIdx, q = this._queue;
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (fi[i] >= 0) q[tail++] = i;
    while (head < tail) {
      const i = q[head++];
      const ix = i % w, iz = (i - ix) / w, f = fi[i];
      if (ix > 0 && fi[i - 1] < 0) { fi[i - 1] = f; q[tail++] = i - 1; }
      if (ix < w - 1 && fi[i + 1] < 0) { fi[i + 1] = f; q[tail++] = i + 1; }
      if (iz > 0 && fi[i - w] < 0) { fi[i - w] = f; q[tail++] = i - w; }
      if (iz < h - 1 && fi[i + w] < 0) { fi[i + w] = f; q[tail++] = i + w; }
    }
  }
}

/**
 * 1-D squared distance transform of a sampled function (lower envelope of parabolas).
 * @param {Float64Array} f input (0 = obstacle, BIG = free)
 * @param {number} n
 * @param {Float64Array} d output
 * @param {Int32Array} v
 * @param {Float64Array} z
 */
function dt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

