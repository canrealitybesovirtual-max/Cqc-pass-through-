// @ts-check
/**
 * The learner's map of the house (v0.5): a sparse, chunked 2.5D grid in the
 * house frame (src/learn/houseFrame.js). Chunks are 4 × 4 m of 10 cm cells
 * (40 × 40), taken from a fixed pool (`maxChunks`, preallocated typed arrays:
 * nothing is allocated while learning), keyed by chunk coordinates in a Map.
 * A large house is a few dozen chunks; only chunks with evidence exist.
 *
 * Per cell (9 bytes):
 * - floor   Int16 mm (house frame y) and its weight floorW (Uint8): the floor
 *           height measured there (depth points on the floor);
 * - top     Int16 mm and topW: the highest surface seen 0.1–1.3 m above the
 *           floor (furniture tops, counters);
 * - occ     hits at wall height (0.5–1.9 m above the floor): something stands there;
 * - free    lines of sight that crossed the cell at wall height: nothing stands there;
 * - walked  the head passed over it (the strongest evidence: people do not walk through walls).
 * Counters saturate at 255, so a chunk's size and its evidence are bounded.
 *
 * Pure: no three.js, no DOM; Node-tested (tests/unit/learn.*.test.js).
 */

export const CELL = 0.1;
export const CHUNK = 40;
export const CHUNK_M = CELL * CHUNK;
export const CELLS = CHUNK * CHUNK;
export const NO_FLOOR = -32768;
/** Chunk coordinates live in ±OFF (a house over 130 km wide is not a house). */
const OFF = 32768;

export class HouseGrid {
  /** @param {{ maxChunks?: number }} [o] */
  constructor({ maxChunks = 192 } = {}) {
    this.maxChunks = maxChunks;
    const n = maxChunks * CELLS;
    this.floor = new Int16Array(n).fill(NO_FLOOR);
    this.floorW = new Uint8Array(n);
    this.top = new Int16Array(n).fill(NO_FLOOR);
    this.topW = new Uint8Array(n);
    this.occ = new Uint8Array(n);
    this.free = new Uint8Array(n);
    this.walked = new Uint8Array(n);
    /** Per slot: chunk coordinates, in use, the session it was last touched in. */
    this.cx = new Int32Array(maxChunks);
    this.cz = new Int32Array(maxChunks);
    this.used = new Uint8Array(maxChunks);
    this.touched = new Uint32Array(maxChunks);
    /** @type {Map<number, number>} key → slot */ this.map = new Map();
    /** Free slots (a stack). */
    this.freeSlots = new Int32Array(maxChunks);
    this.nFree = maxChunks;
    for (let i = 0; i < maxChunks; i++) this.freeSlots[i] = maxChunks - 1 - i;
    this.epoch = 0;
    this.evictions = 0;
    /** Last lookup (most writes hit the same chunk as the previous one). */
    this._lk = -1;
    this._ls = -1;
  }

  /** @param {number} cx @param {number} cz */
  static key(cx, cz) { return (cx + OFF) * 65536 + (cz + OFF); }

  get chunkCount() { return this.maxChunks - this.nFree; }

  /**
   * The slot of chunk (cx, cz); with `create`, a new chunk from the pool (evicting the weakest one when full).
   * @param {number} cx @param {number} cz @param {boolean} create
   * @returns {number} slot or −1
   */
  slot(cx, cz, create) {
    const k = HouseGrid.key(cx, cz);
    if (k === this._lk) return this._ls;
    const s = this.map.get(k);
    if (s !== undefined) { this._lk = k; this._ls = s; this.touched[s] = this.epoch; return s; }
    if (!create) return -1;
    let ns = -1;
    if (this.nFree > 0) ns = this.freeSlots[--this.nFree];
    else {
      ns = this.weakest(-1);
      if (ns < 0) return -1;
      this.release(ns);
      this.evictions++;
      ns = this.freeSlots[--this.nFree];
    }
    this.clearSlot(ns);
    this.cx[ns] = cx;
    this.cz[ns] = cz;
    this.used[ns] = 1;
    this.touched[ns] = this.epoch;
    this.map.set(k, ns);
    this._lk = k;
    this._ls = ns;
    return ns;
  }

  /**
   * Cell index (slot · CELLS + local) under house-frame (x, z); −1 when its chunk does not exist (and !create).
   * @param {number} x @param {number} z @param {boolean} create
   */
  cell(x, z, create) {
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    return this.cellAt(gx, gz, create);
  }

  /** Cell index of global cell coordinates (gx, gz). @param {number} gx @param {number} gz @param {boolean} create */
  cellAt(gx, gz, create) {
    const cx = Math.floor(gx / CHUNK), cz = Math.floor(gz / CHUNK);
    const s = this.slot(cx, cz, create);
    if (s < 0) return -1;
    return s * CELLS + (gz - cz * CHUNK) * CHUNK + (gx - cx * CHUNK);
  }

  /** @param {number} s */
  clearSlot(s) {
    const a = s * CELLS, b = a + CELLS;
    this.floor.fill(NO_FLOOR, a, b);
    this.floorW.fill(0, a, b);
    this.top.fill(NO_FLOOR, a, b);
    this.topW.fill(0, a, b);
    this.occ.fill(0, a, b);
    this.free.fill(0, a, b);
    this.walked.fill(0, a, b);
  }

  /** Return a slot to the pool. @param {number} s */
  release(s) {
    if (!this.used[s]) return;
    this.map.delete(HouseGrid.key(this.cx[s], this.cz[s]));
    this.used[s] = 0;
    this.freeSlots[this.nFree++] = s;
    this._lk = -1;
  }

  /** Everything gone (a new house). */
  clear() {
    for (let s = 0; s < this.maxChunks; s++) if (this.used[s]) this.release(s);
  }

  /** Evidence in a chunk (walked weighs most). @param {number} s */
  evidence(s) {
    const a = s * CELLS, b = a + CELLS;
    let e = 0;
    for (let i = a; i < b; i++) e += this.floorW[i] + this.topW[i] + this.occ[i] + this.free[i] + 8 * this.walked[i];
    return e;
  }

  /** The slot with the least evidence (oldest first among equals), except `keep`. @param {number} keep */
  weakest(keep) {
    let best = -1, bestE = Infinity, bestT = Infinity;
    for (let s = 0; s < this.maxChunks; s++) {
      if (!this.used[s] || s === keep || s === this._ls) continue;
      const e = this.evidence(s), t = this.touched[s];
      if (e < bestE || (e === bestE && t < bestT)) { best = s; bestE = e; bestT = t; }
    }
    return best;
  }

  /**
   * Old evidence fades (once per loaded session): the counters scale by `k` (rounded down), so what is no longer
   * seen loses weight and a changed house relearns; walked cells keep at least 1 (walls do not move away from a
   * path the user walked). Bounded by construction (counters saturate).
   * @param {number} k
   */
  decay(k) {
    const n = this.maxChunks * CELLS;
    for (let s = 0; s < this.maxChunks; s++) {
      if (!this.used[s]) continue;
      const a = s * CELLS, b = a + CELLS;
      for (let i = a; i < b; i++) {
        if (this.floorW[i]) this.floorW[i] = Math.max(1, (this.floorW[i] * k) | 0);
        if (this.topW[i]) { this.topW[i] = (this.topW[i] * k) | 0; if (!this.topW[i]) this.top[i] = NO_FLOOR; }
        this.occ[i] = (this.occ[i] * k) | 0;
        this.free[i] = (this.free[i] * k) | 0;
        if (this.walked[i]) this.walked[i] = Math.max(1, (this.walked[i] * k) | 0);
      }
    }
    void n;
  }

  /**
   * Compaction: weak cells are cleared (so chunks stay sparse when stored), chunks with almost no evidence go
   * back to the pool, and at most `maxKeep` chunks are kept (the weakest go). Returns the chunks dropped.
   * @param {{ minChunkEvidence?: number, maxKeep?: number }} [o]
   */
  compact({ minChunkEvidence = 24, maxKeep = this.maxChunks } = {}) {
    let dropped = 0;
    for (let s = 0; s < this.maxChunks; s++) {
      if (!this.used[s]) continue;
      const a = s * CELLS, b = a + CELLS;
      for (let i = a; i < b; i++) {
        if (this.walked[i]) continue;
        if (this.floorW[i] === 1 && !this.occ[i] && !this.free[i] && !this.topW[i]) { this.floorW[i] = 0; this.floor[i] = NO_FLOOR; }
        if (this.occ[i] === 1 && this.free[i] === 0) this.occ[i] = 0;
        if (this.free[i] === 1 && this.occ[i] === 0) this.free[i] = 0;
      }
      if (this.evidence(s) < minChunkEvidence) { this.release(s); dropped++; }
    }
    while (this.chunkCount > maxKeep) {
      const w = this.weakest(-1);
      if (w < 0) break;
      this.release(w);
      dropped++;
    }
    return dropped;
  }

  /** Non-empty cells of a slot. @param {number} s */
  nonEmpty(s) {
    const a = s * CELLS, b = a + CELLS;
    let n = 0;
    for (let i = a; i < b; i++) if (this.floorW[i] || this.topW[i] || this.occ[i] || this.free[i] || this.walked[i]) n++;
    return n;
  }

  /** Bounds of the used chunks in global cell coordinates [gx0, gz0, gx1, gz1] (exclusive), or null. */
  cellBounds() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let s = 0; s < this.maxChunks; s++) {
      if (!this.used[s]) continue;
      if (this.cx[s] < x0) x0 = this.cx[s];
      if (this.cz[s] < z0) z0 = this.cz[s];
      if (this.cx[s] > x1) x1 = this.cx[s];
      if (this.cz[s] > z1) z1 = this.cz[s];
    }
    if (x0 === Infinity) return null;
    return [x0 * CHUNK, z0 * CHUNK, (x1 + 1) * CHUNK, (z1 + 1) * CHUNK];
  }
}
