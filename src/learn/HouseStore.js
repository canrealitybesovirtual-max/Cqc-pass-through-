// @ts-check
/**
 * Persistence of the learned house (v0.5): compact typed chunks, versioned,
 * per house, with a CRC per chunk (a corrupt chunk is quarantined and the
 * rest still loads), hard caps, and a store interface the worker backs with
 * IndexedDB (`IDBStore`, src/learn/learn.worker.js) and tests with memory.
 *
 * Chunk record (little-endian):
 *   0  'H' 'G'   magic
 *   2  u8        FORMAT
 *   3  u8        flags (0)
 *   4  i32       chunk x
 *   8  i32       chunk z
 *   12 u16       non-empty cells
 *   14 u32       CRC-32 of bytes 18..end
 *   18 200 B     bitmask of non-empty cells (1600 bits)
 *   218 9 B/cell floor i16, floorW u8, top i16, topW u8, occ u8, free u8, walked u8
 * A full chunk is 14.6 KB; a typical one (a room's floor and walls) 2–6 KB.
 *
 * Keys: `h:<houseId>` the house record { v, id, sig, sessions, savedAt, chunks: string[], bytes, appVersion };
 * `c:<houseId>:<cx>,<cz>` the chunks; `index` the houses kept (at most MAX_HOUSES, oldest dropped).
 *
 * Pure (the IndexedDB adapter lives in the worker): Node-tested.
 */
import { CELLS, HouseGrid, NO_FLOOR } from './HouseGrid.js';

export const FORMAT = 1;
export const SCHEMA = 'cqcpt.house.v1';
const HEAD = 18, MASK = CELLS / 8, CELL_B = 9;
/** Caps: chunks kept per house (40 × 40 m of evidence), houses kept. */
export const MAX_HOUSE_CHUNKS = 160;
export const MAX_HOUSES = 4;
/** Old evidence fades by this per loaded session (HouseGrid.decay). */
export const SESSION_DECAY = 0.75;

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
/** @param {Uint8Array} b @param {number} from */
export function crc32(b, from = 0) {
  let c = 0xffffffff;
  for (let i = from; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Encode one chunk (slot s of the grid).
 * @param {HouseGrid} g @param {number} s
 * @returns {Uint8Array}
 */
export function encodeChunk(g, s) {
  const a = s * CELLS;
  let nnz = 0;
  for (let i = 0; i < CELLS; i++) {
    const j = a + i;
    if (g.floorW[j] || g.topW[j] || g.occ[j] || g.free[j] || g.walked[j]) nnz++;
  }
  const out = new Uint8Array(HEAD + MASK + nnz * CELL_B);
  const dv = new DataView(out.buffer);
  out[0] = 72; out[1] = 71; out[2] = FORMAT; out[3] = 0;
  dv.setInt32(4, g.cx[s], true);
  dv.setInt32(8, g.cz[s], true);
  dv.setUint16(12, nnz, true);
  let o = HEAD + MASK;
  for (let i = 0; i < CELLS; i++) {
    const j = a + i;
    if (!(g.floorW[j] || g.topW[j] || g.occ[j] || g.free[j] || g.walked[j])) continue;
    out[HEAD + (i >> 3)] |= 1 << (i & 7);
    dv.setInt16(o, g.floorW[j] ? g.floor[j] : NO_FLOOR, true);
    out[o + 2] = g.floorW[j];
    dv.setInt16(o + 3, g.topW[j] ? g.top[j] : NO_FLOOR, true);
    out[o + 5] = g.topW[j];
    out[o + 6] = g.occ[j];
    out[o + 7] = g.free[j];
    out[o + 8] = g.walked[j];
    o += CELL_B;
  }
  dv.setUint32(14, crc32(out, 18), true);
  return out;
}

/**
 * Decode a chunk record into the grid (its own slot). Throws on any corruption (bad magic, format, size, CRC).
 * @param {HouseGrid} g @param {Uint8Array} b
 * @returns {number} the slot
 */
export function decodeChunk(g, b) {
  if (!(b instanceof Uint8Array) || b.length < HEAD + MASK) throw new Error('chunk: short');
  if (b[0] !== 72 || b[1] !== 71) throw new Error('chunk: bad magic');
  if (b[2] !== FORMAT) throw new Error(`chunk: format ${b[2]}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cx = dv.getInt32(4, true), cz = dv.getInt32(8, true), nnz = dv.getUint16(12, true);
  if (b.length !== HEAD + MASK + nnz * CELL_B) throw new Error('chunk: size');
  if (dv.getUint32(14, true) !== crc32(b, 18)) throw new Error('chunk: crc');
  let bits = 0;
  for (let i = 0; i < MASK; i++) { let v = b[HEAD + i]; while (v) { bits += v & 1; v >>= 1; } }
  if (bits !== nnz) throw new Error('chunk: mask');
  const s = g.slot(cx, cz, true);
  if (s < 0) throw new Error('chunk: no slot');
  g.clearSlot(s);
  const a = s * CELLS;
  let o = HEAD + MASK;
  for (let i = 0; i < CELLS; i++) {
    if (!(b[HEAD + (i >> 3)] & (1 << (i & 7)))) continue;
    const j = a + i;
    g.floor[j] = dv.getInt16(o, true);
    g.floorW[j] = b[o + 2];
    g.top[j] = dv.getInt16(o + 3, true);
    g.topW[j] = b[o + 5];
    g.occ[j] = b[o + 6];
    g.free[j] = b[o + 7];
    g.walked[j] = b[o + 8];
    o += CELL_B;
  }
  return s;
}

/** @param {number} cx @param {number} cz */
const ckey = (cx, cz) => `${cx},${cz}`;

/**
 * @typedef {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void>, del: (k: string) => Promise<void>,
 *   estimate?: () => Promise<{ usage?: number, quota?: number }|null> }} KV
 */

/** An in-memory KV (tests; the fallback when IndexedDB is missing). Values are copied in and out. */
export class MemoryStore {
  constructor() { /** @type {Map<string, any>} */ this.m = new Map(); this.quota = Infinity; }
  /** @param {string} k */
  async get(k) { const v = this.m.get(k); return v instanceof Uint8Array ? v.slice() : v === undefined ? undefined : structuredClone(v); }
  /** @param {string} k @param {any} v */
  async put(k, v) { this.m.set(k, v instanceof Uint8Array ? v.slice() : structuredClone(v)); }
  /** @param {string} k */
  async del(k) { this.m.delete(k); }
  async estimate() { let usage = 0; for (const v of this.m.values()) usage += v instanceof Uint8Array ? v.byteLength : JSON.stringify(v).length; return { usage, quota: this.quota }; }
  /** Bytes stored under a prefix. @param {string} prefix */
  bytes(prefix = '') { let n = 0; for (const [k, v] of this.m) if (k.startsWith(prefix)) n += v instanceof Uint8Array ? v.byteLength : JSON.stringify(v).length; return n; }
}

/**
 * Load a house into the grid: its record, then every chunk (a corrupt one is deleted and counted: quarantined),
 * then one session of decay. Returns what happened.
 * @param {KV} store @param {HouseGrid} grid @param {string} houseId
 */
export async function loadHouse(store, grid, houseId) {
  const t0 = now();
  grid.clear();
  const rec = await store.get(`h:${houseId}`);
  const res = { loaded: false, chunks: 0, quarantined: 0, bytes: 0, sessions: 0, ms: 0, why: '' };
  if (!rec || rec.v !== FORMAT || rec.schema !== SCHEMA || !Array.isArray(rec.chunks)) { res.why = rec ? 'old or unknown format' : 'no saved house'; res.ms = now() - t0; return res; }
  for (const k of rec.chunks.slice(0, MAX_HOUSE_CHUNKS)) {
    const key = `c:${houseId}:${k}`;
    try {
      const b = await store.get(key);
      const u = b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : null;
      if (!u) throw new Error('chunk: missing');
      decodeChunk(grid, u);
      res.chunks++;
      res.bytes += u.byteLength;
    } catch (e) {
      res.quarantined++;
      try { await store.put(`q:${houseId}:${k}`, { error: e instanceof Error ? e.message : String(e), at: Date.now() }); await store.del(key); } catch { /* the store itself failed */ }
    }
  }
  grid.decay(SESSION_DECAY);
  res.loaded = res.chunks > 0;
  res.sessions = rec.sessions | 0;
  res.ms = now() - t0;
  return res;
}

/**
 * Save the grid as the house (compacted first, capped), after a quota check. Writes only the chunks, the
 * record and the index; chunks no longer in the grid are deleted.
 * @param {KV} store @param {HouseGrid} grid @param {{ id: string, sig: string, sessions: number, appVersion?: string }} house
 */
export async function saveHouse(store, grid, house) {
  const t0 = now();
  grid.compact({ maxKeep: MAX_HOUSE_CHUNKS });
  /** @type {{ k: string, b: Uint8Array }[]} */ const out = [];
  let bytes = 0;
  for (let s = 0; s < grid.maxChunks; s++) {
    if (!grid.used[s]) continue;
    const b = encodeChunk(grid, s);
    out.push({ k: ckey(grid.cx[s], grid.cz[s]), b });
    bytes += b.byteLength;
  }
  const res = { saved: false, chunks: out.length, bytes, ms: 0, why: '', quota: /** @type {any} */ (null) };
  try {
    const est = store.estimate ? await store.estimate() : null;
    if (est && Number.isFinite(est.quota) && Number.isFinite(est.usage)) {
      res.quota = { usage: est.usage, quota: est.quota };
      if (/** @type {number} */ (est.quota) - /** @type {number} */ (est.usage) < 2 * bytes + 65536) { res.why = 'storage quota'; res.ms = now() - t0; return res; }
    }
  } catch { /* no estimate: write anyway */ }
  const prev = await store.get(`h:${house.id}`);
  const keep = new Set(out.map((x) => x.k));
  for (const x of out) await store.put(`c:${house.id}:${x.k}`, x.b);
  if (prev && Array.isArray(prev.chunks)) for (const k of prev.chunks) if (!keep.has(k)) await store.del(`c:${house.id}:${k}`);
  await store.put(`h:${house.id}`, { v: FORMAT, schema: SCHEMA, id: house.id, sig: house.sig, sessions: house.sessions, savedAt: Date.now(),
    chunks: out.map((x) => x.k), bytes, appVersion: house.appVersion || '' });
  // the index: newest first, at most MAX_HOUSES (an old house's data goes)
  const idx = (await store.get('index')) || [];
  const list = Array.isArray(idx) ? idx.filter((/** @type {any} */ e) => e && e.id !== house.id) : [];
  list.unshift({ id: house.id, savedAt: Date.now() });
  while (list.length > MAX_HOUSES) {
    const old = list.pop();
    await forgetHouse(store, old.id);
  }
  await store.put('index', list);
  res.saved = true;
  res.ms = now() - t0;
  return res;
}

/** Delete a house (its chunks, its record). @param {KV} store @param {string} houseId */
export async function forgetHouse(store, houseId) {
  const rec = await store.get(`h:${houseId}`);
  if (rec && Array.isArray(rec.chunks)) for (const k of rec.chunks) await store.del(`c:${houseId}:${k}`);
  await store.del(`h:${houseId}`);
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
