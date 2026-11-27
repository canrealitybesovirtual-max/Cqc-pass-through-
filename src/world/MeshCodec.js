// @ts-check
/**
 * Compact mesh encoding for the session record (pure: no three.js, no DOM;
 * runs in the world worker). Never part of Copy (see Snapshot.js
 * `snapshotForCopy`).
 *
 * Format 'cqc-mesh-1' (little-endian):
 * ```
 * 0   'CQM1'                      magic
 * 4   u8 version (1), u8 flags (bit 0: a per-triangle u8 attribute follows)
 * 6   u16 reserved
 * 8   f32 quantum (m)             default 0.002 (2 mm: max error 1 mm per axis)
 * 12  f32 × 3 origin              the minimum corner
 * 24  varint vertexCount, varint triangleCount
 *     x stream: zigzag varint of q[i] − q[i−1] (q = round((v − origin) / quantum)), then y, then z
 *     index stream: zigzag varint of idx[k] − idx[k−1]
 *     [tri attribute: triangleCount raw bytes]
 * ```
 * Per-axis streams keep gzip's window full of similar numbers; Quest meshes
 * are spatially coherent, so most deltas fit one byte. The research bench
 * measured 27 KB of base64 for a 36k-triangle synthetic house at 2 mm.
 *
 * `encodeMeshRecord` / `decodeMeshRecord` wrap it with gzip
 * (CompressionStream: browsers, workers and Node 18+) and base64 into the
 * JSON-safe record kept in `snapshot.globalMesh`.
 */

export const MESH_ENCODING = 'cqc-mesh-1';
export const MESH_QUANTUM = 0.002;
const MAGIC = 0x314d5143; // 'CQM1' little-endian

/**
 * @typedef {{ vertices: Float32Array, indices: Uint32Array, tri8?: Uint8Array|null }} MeshArrays
 * @typedef {{ encoding: string, compression: 'gzip'|'none', quantum: number, origin: number[], vertexCount: number,
 *   triangleCount: number, hash: string, bytes: number, data: string }} MeshRecord
 */

/**
 * @param {MeshArrays} m
 * @param {{ quantum?: number }} [o]
 * @returns {Uint8Array}
 */
export function encodeMesh(m, { quantum = MESH_QUANTUM } = {}) {
  const V = m.vertices, I = m.indices, nv = Math.floor(V.length / 3), nt = Math.floor(I.length / 3);
  const tri8 = m.tri8 && m.tri8.length >= nt ? m.tri8 : null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  for (let i = 0; i < nv; i++) {
    if (V[3 * i] < x0) x0 = V[3 * i];
    if (V[3 * i + 1] < y0) y0 = V[3 * i + 1];
    if (V[3 * i + 2] < z0) z0 = V[3 * i + 2];
  }
  if (nv === 0) x0 = y0 = z0 = 0;
  // f32 origin: quantise against the value the decoder will read back
  const org = new Float32Array([x0, y0, z0]);
  const q = Math.fround(quantum);
  // worst case 5 bytes per varint
  const out = new Uint8Array(24 + 10 + nv * 15 + nt * 15 + (tri8 ? nt : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  out[4] = 1;
  out[5] = tri8 ? 1 : 0;
  dv.setFloat32(8, q, true);
  dv.setFloat32(12, org[0], true);
  dv.setFloat32(16, org[1], true);
  dv.setFloat32(20, org[2], true);
  let p = 24;
  p = putVarint(out, p, nv);
  p = putVarint(out, p, nt);
  const inv = 1 / q;
  for (let axis = 0; axis < 3; axis++) {
    let prev = 0;
    const o = org[axis];
    for (let i = 0; i < nv; i++) {
      const qi = Math.round((V[3 * i + axis] - o) * inv);
      p = putVarint(out, p, zigzag(qi - prev));
      prev = qi;
    }
  }
  let prev = 0;
  for (let k = 0; k < nt * 3; k++) {
    const v = I[k];
    p = putVarint(out, p, zigzag(v - prev));
    prev = v;
  }
  if (tri8) { out.set(tri8.subarray(0, nt), p); p += nt; }
  return out.slice(0, p);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ vertices: Float32Array, indices: Uint32Array, tri8: Uint8Array|null, quantum: number, origin: number[] }}
 */
export function decodeMesh(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 26 || dv.getUint32(0, true) !== MAGIC) throw new Error('decodeMesh: not a cqc-mesh-1 stream');
  if (bytes[4] !== 1) throw new Error(`decodeMesh: unsupported version ${bytes[4]}`);
  const hasTri = (bytes[5] & 1) !== 0;
  const q = dv.getFloat32(8, true);
  const origin = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const cur = { p: 24 };
  const nv = getVarint(bytes, cur), nt = getVarint(bytes, cur);
  if (nv > 1 << 24 || nt > 1 << 24) throw new Error('decodeMesh: implausible counts');
  const vertices = new Float32Array(nv * 3);
  for (let axis = 0; axis < 3; axis++) {
    let qi = 0;
    const o = origin[axis];
    for (let i = 0; i < nv; i++) {
      qi += unzigzag(getVarint(bytes, cur));
      vertices[3 * i + axis] = o + qi * q;
    }
  }
  const indices = new Uint32Array(nt * 3);
  let v = 0;
  for (let k = 0; k < nt * 3; k++) {
    v += unzigzag(getVarint(bytes, cur));
    if (v < 0 || v >= nv) throw new Error('decodeMesh: index out of range');
    indices[k] = v;
  }
  let tri8 = null;
  if (hasTri) {
    if (cur.p + nt > bytes.byteLength) throw new Error('decodeMesh: truncated');
    tri8 = bytes.slice(cur.p, cur.p + nt);
    cur.p += nt;
  }
  if (cur.p > bytes.byteLength) throw new Error('decodeMesh: truncated');
  return { vertices, indices, tri8, quantum: q, origin };
}

/** @param {number} v */
function zigzag(v) {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}
/** @param {number} u */
function unzigzag(u) {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

/**
 * Unsigned varint (7 bits per byte, values up to 2^35).
 * @param {Uint8Array} out @param {number} p @param {number} v
 */
function putVarint(out, p, v) {
  while (v >= 128) {
    out[p++] = (v % 128) | 128;
    v = Math.floor(v / 128);
  }
  out[p++] = v;
  return p;
}
/** @param {Uint8Array} b @param {{ p: number }} cur */
function getVarint(b, cur) {
  let v = 0, mul = 1, p = cur.p;
  for (let k = 0; k < 6; k++) {
    if (p >= b.length) throw new Error('decodeMesh: truncated');
    const x = b[p++];
    v += (x & 127) * mul;
    if (x < 128) { cur.p = p; return v; }
    mul *= 128;
  }
  throw new Error('decodeMesh: bad varint');
}

/**
 * FNV-1a (32 bit) as 8 hex digits: a stable id for a mesh blob.
 * @param {Uint8Array} bytes
 */
export function meshHash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── base64 (no btoa: it needs a binary string; this works on any size) ─────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;

/** @param {Uint8Array} b */
export function toBase64(b) {
  /** @type {string[]} */ const parts = [];
  const CH = 3 * 4096;
  for (let o = 0; o < b.length; o += CH) {
    const e = Math.min(b.length, o + CH);
    let s = '';
    for (let i = o; i < e; i += 3) {
      const n = (b[i] << 16) | ((i + 1 < e ? b[i + 1] : 0) << 8) | (i + 2 < e ? b[i + 2] : 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < e ? B64[(n >> 6) & 63] : '=') + (i + 2 < e ? B64[n & 63] : '=');
    }
    parts.push(s);
  }
  return parts.join('');
}

/** @param {string} s */
export function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const n = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64_REV[clean.charCodeAt(i)], b = B64_REV[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? B64_REV[clean.charCodeAt(i + 2)] : 0, d = i + 3 < clean.length ? B64_REV[clean.charCodeAt(i + 3)] : 0;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    if (p < n) out[p++] = (v >> 16) & 255;
    if (p < n && i + 2 < clean.length) out[p++] = (v >> 8) & 255;
    if (p < n && i + 3 < clean.length) out[p++] = v & 255;
  }
  return out.subarray(0, p);
}

// ── gzip (CompressionStream; async) ───────────────────────────────────────

/** CompressionStream exists here (browsers, workers, Node 18+). */
export const hasCompression = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/**
 * @param {Uint8Array} bytes
 * @param {'gzip'|'none'} [mode]
 * @returns {Promise<Uint8Array>}
 */
export async function compress(bytes, mode = 'gzip') {
  if (mode === 'none' || !hasCompression) return bytes;
  return pipe(bytes, new CompressionStream('gzip'));
}

/**
 * @param {Uint8Array} bytes
 * @param {'gzip'|'none'} [mode]
 * @returns {Promise<Uint8Array>}
 */
export async function decompress(bytes, mode = 'gzip') {
  if (mode === 'none') return bytes;
  if (!hasCompression) throw new Error('decompress: no DecompressionStream here');
  return pipe(bytes, new DecompressionStream('gzip'));
}

/** @param {Uint8Array} bytes @param {any} stream a CompressionStream or DecompressionStream */
async function pipe(bytes, stream) {
  const w = stream.writable.getWriter();
  // a bad stream rejects these as well as the read: the read reports it
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  const r = stream.readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * The JSON-safe record of a mesh: encoded, gzipped (when available), base64.
 * @param {MeshArrays} m
 * @param {{ quantum?: number, compression?: 'gzip'|'none' }} [o]
 * @returns {Promise<MeshRecord>}
 */
export async function encodeMeshRecord(m, { quantum = MESH_QUANTUM, compression = 'gzip' } = {}) {
  const raw = encodeMesh(m, { quantum });
  const mode = compression === 'gzip' && hasCompression ? 'gzip' : 'none';
  const packed = await compress(raw, mode);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    encoding: MESH_ENCODING, compression: mode, quantum: dv.getFloat32(8, true),
    origin: [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)],
    vertexCount: Math.floor(m.vertices.length / 3), triangleCount: Math.floor(m.indices.length / 3),
    hash: meshHash(raw), bytes: packed.length, data: toBase64(packed),
  };
}

/**
 * Decode a record made by encodeMeshRecord (checks the hash).
 * @param {{ encoding?: string, compression?: string, hash?: string, data?: string }} rec
 */
export async function decodeMeshRecord(rec) {
  if (!rec || rec.encoding !== MESH_ENCODING || typeof rec.data !== 'string') throw new Error('decodeMeshRecord: no cqc-mesh-1 data');
  const raw = await decompress(fromBase64(rec.data), rec.compression === 'gzip' ? 'gzip' : 'none');
  if (rec.hash && meshHash(raw) !== rec.hash) throw new Error('decodeMeshRecord: hash mismatch');
  return decodeMesh(raw);
}
