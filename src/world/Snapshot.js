// @ts-check
/**
 * Space Setup snapshot: the planes and meshes the browser reports, copied once
 * into plain JSON-safe data (no XR objects), so a capture can be stored in the
 * session record and replayed on desktop. Pure: no three.js, no DOM.
 *
 * ```
 * SpaceSnapshot (v2) = { version: 2, space: string,
 *   planes: [{ label: string|null, orientation: 'horizontal'|'vertical',
 *              pose: number[16],          // column-major, plane space → reference space
 *              polygon: [[x, z], …] }],   // plane space: y is the plane normal
 *   meshes: [{ label: string|null,
 *              pose: number[16],          // column-major; this capture writes a
 *                                         //  gravity-aligned box frame (y up)
 *              min: [x,y,z], max: [x,y,z], // box in that frame
 *              vertexCount: number }],
 *   globalMesh: null | { label, mesh: number (index in meshes, −1 from a record), vertexCount, triangleCount,
 *              lastChangedTime,
 *              // after the world build (the worker) encodes it for the session record:
 *              space: 'reference', encoding: 'cqc-mesh-1', compression, quantum, origin, hash, bytes, data } }
 * ```
 * v2 adds `globalMesh` and, NOT enumerable (never in JSON, never cloned by
 * postMessage, so the record and Copy stay small), `snap.raw`: the captured
 * triangles of every XRMesh:
 * ```
 * raw = { token: number, global: number,       // index into raw.meshes (−1: none)
 *   meshes: [{ label, pose: Float64Array(16),  // mesh space → reference space
 *              lastChangedTime, data: { vertices: Float32Array, indices: Uint32Array } }] }
 * ```
 * `data` is a shared holder: a transformed snapshot (Realign) shares it, and
 * the world worker borrows its arrays (transferred there and back).
 * The session record keeps the global mesh as `globalMesh.data` (2 mm,
 * varint deltas, gzip, base64: MeshCodec.js); `snapshotForCopy` drops it for
 * Copy; `hydrateSnapshot` decodes it back into `raw` (desktop replay).
 * v1 snapshots (no mesh) are still accepted everywhere.
 *
 * WebXR facts used (plane-detection / mesh-detection modules): `frame.detectedPlanes`
 * and `frame.detectedMeshes` are set-likes; `XRPlane.polygon` is an array of
 * DOMPointReadOnly in plane space; `XRMesh.vertices` is a Float32Array of
 * x,y,z triplets in mesh space and `XRMesh.indices` a Uint32Array. On Quest 3
 * `lastChangedTime` ticks about 3×/s with no real change (docs/DEVICE_LOG.md),
 * so capture once (see CaptureGate) and never rebuild during play.
 */

import { convexHull, minAreaRect, rect } from './geom.js';
import { decodeMeshRecord } from './MeshCodec.js';

export const SNAPSHOT_VERSION = 2;
/** Versions normalizeSnapshot accepts. */
export const SNAPSHOT_VERSIONS = Object.freeze([1, 2]);

let rawToken = 0;

/** Meshes with more vertices than this (the global room mesh) get a world-axis box instead of a hull. */
const HULL_MAX_VERTICES = 6000;

/** Round, and turn -0 into 0 (JSON writes both as 0). @param {number} v */
const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0;
/** @param {number} v */
const r6 = (v) => Math.round(v * 1e6) / 1e6 + 0;

/**
 * @typedef {{ vertices: Float32Array, indices: Uint32Array }} MeshData
 * @typedef {{ label: string|null, pose: Float64Array, lastChangedTime: number, data: MeshData }} RawMesh
 * @typedef {{ token: number, global: number, meshes: RawMesh[] }} RawSet
 */

/**
 * Copy the current Space Setup planes and meshes. Call inside an XR frame
 * callback (an XRFrame is dead after any await). Planes or meshes whose pose is
 * not available this frame are skipped and counted in `opts.stats`.
 *
 * v2: each XRMesh's vertices and indices are copied too (one memcpy each; the
 * Quest's 36k-triangle global mesh is about 0.6 MB) into the non-enumerable
 * `snap.raw`, and `snap.globalMesh` describes the global mesh (label 'global
 * mesh', else the largest mesh over 5,000 triangles). `opts.raw === false`
 * skips the copies (v1 behaviour, with version 2).
 *
 * @param {any} frame XRFrame (or any object with detectedPlanes / detectedMeshes / getPose)
 * @param {any} space XRReferenceSpace the poses are expressed in
 * @param {{ spaceName?: string, stats?: { planes: number, meshes: number, skippedPlanes: number, skippedMeshes: number, meshTris?: number, meshBytes?: number },
 *   keep?: any[], raw?: boolean }} [opts] keep: filled with the XRPlane objects in `planes` order (for the drift watch:
 *   `keep[i]` is the live plane of `snap.planes[i]`; references only, nothing is copied)
 * @returns {import('./Layout.js').SpaceSnapshot}
 */
export function captureSnapshot(frame, space, opts = {}) {
  const job = new CaptureJob();
  job.begin(frame, space, opts);
  while (!job.done) job.step(frame, space, Infinity);
  return /** @type {import('./Layout.js').SpaceSnapshot} */ (job.snap);
}

/** Vertices a capture step handles per frame (copy + bounds): the 36k-triangle global mesh takes 2–4 frames. */
export const CAPTURE_VERTS_PER_FRAME = 16384;

/**
 * The capture spread over frames (v0.5, behind the panel): `begin` copies the planes (and takes the mesh
 * list); each `step` copies meshes and computes their boxes up to `CAPTURE_VERTS_PER_FRAME` vertices (a mesh's
 * vertices and indices are copied in one memcpy when first touched, with its pose in that frame; a large mesh's
 * bounds then go on over the next frames on the copy); `done` once every mesh is in. `ms`, `frames` and `maxMs`
 * say what the main thread paid (rec.play.capture). `captureSnapshot` is begin + steps without a budget.
 * Every step runs inside its own XR frame callback with that frame.
 */
export class CaptureJob {
  constructor() {
    /** @type {any} */ this.snap = null;
    this.done = false;
    this.active = false;
    this.ms = 0;
    this.maxMs = 0;
    this.frames = 0;
    /** @type {any[]} */ this._list = [];
    this._i = 0;
    /** @type {any} */ this._cur = null;
    /** @type {any} */ this._opts = null;
  }

  /**
   * @param {any} frame @param {any} space
   * @param {{ spaceName?: string, stats?: any, keep?: any[], raw?: boolean }} [opts] as captureSnapshot
   */
  begin(frame, space, opts = {}) {
    const t0 = clockMs();
    this._opts = opts;
    /** @type {any} */
    const snap = { version: SNAPSHOT_VERSION, space: opts.spaceName || 'local-floor', planes: [], meshes: [], globalMesh: null };
    this.snap = snap;
    this._raw = /** @type {RawSet} */ ({ token: ++rawToken, global: -1, meshes: [] });
    /** @type {number[]} */ this._rawOfMesh = [];
    this._meshTris = 0;
    this._meshBytes = 0;
    this._skippedPlanes = 0;
    this._skippedMeshes = 0;
    this.done = false;
    this.active = true;
    this.ms = 0;
    this.maxMs = 0;
    this.frames = 0;
    this._cur = null;
    this._i = 0;
    const keep = Array.isArray(opts.keep) ? opts.keep : null;
    if (keep) keep.length = 0;
    const planes = frame && frame.detectedPlanes;
    if (planes) {
      for (const p of planes) {
        const pose = p && p.planeSpace ? frame.getPose(p.planeSpace, space) : null;
        const poly = p && p.polygon;
        if (!pose || !poly || poly.length < 3) { this._skippedPlanes++; continue; }
        const m = pose.transform.matrix;
        /** @type {number[][]} */ const pts = [];
        for (let i = 0; i < poly.length; i++) pts.push([r4(poly[i].x), r4(poly[i].z)]);
        const orientation = p.orientation === 'vertical' || p.orientation === 'horizontal'
          ? p.orientation
          : (Math.abs(m[5]) > 0.7 ? 'horizontal' : 'vertical');
        snap.planes.push({ label: labelOf(p.semanticLabel), orientation, pose: poseArray(m), polygon: pts });
        if (keep) keep.push(p);
      }
    }
    const meshes = frame && frame.detectedMeshes;
    this._list = meshes ? Array.from(meshes) : [];
    this._tick(t0);
  }

  /**
   * One frame's share. Returns true once the snapshot is complete.
   * @param {any} frame this frame @param {any} space @param {number} [budget] vertices this frame
   */
  step(frame, space, budget = CAPTURE_VERTS_PER_FRAME) {
    if (this.done || !this.active) return this.done;
    const t0 = clockMs();
    let spent = 0;
    const L = this._list, raw = this._raw, snap = this.snap, opts = this._opts;
    while (this._i < L.length && spent < budget) {
      const cur = this._cur;
      if (cur) {
        // a large mesh's bounds, on its copy
        const v = cur.v, n = Math.floor(v.length / 3), m = cur.m;
        const end = Math.min(n, cur.k + Math.max(1, budget - spent));
        for (let i = cur.k; i < end; i++) {
          const a = v[3 * i], b = v[3 * i + 1], c = v[3 * i + 2];
          const x = m[0] * a + m[4] * b + m[8] * c + m[12], y = m[1] * a + m[5] * b + m[9] * c + m[13], z = m[2] * a + m[6] * b + m[10] * c + m[14];
          if (x < cur.x0) cur.x0 = x; if (x > cur.x1) cur.x1 = x;
          if (y < cur.y0) cur.y0 = y; if (y > cur.y1) cur.y1 = y;
          if (z < cur.z0) cur.z0 = z; if (z > cur.z1) cur.z1 = z;
        }
        spent += end - cur.k;
        cur.k = end;
        if (end >= n) {
          snap.meshes.push(boundsBox(cur.label, cur));
          this._cur = null;
          this._i++;
        }
        continue;
      }
      const mesh = L[this._i];
      const pose = mesh && mesh.meshSpace ? frame.getPose(mesh.meshSpace, space) : null;
      const v = mesh && mesh.vertices;
      if (!pose || !v || v.length < 3) { this._skippedMeshes++; this._i++; continue; }
      const label = labelOf(mesh.semanticLabel);
      const mat = pose.transform.matrix;
      const ix = mesh.indices;
      /** @type {Float32Array|null} */ let copy = null;
      if (opts.raw !== false && ix && ix.length >= 3) {
        const data = { vertices: new Float32Array(v), indices: new Uint32Array(ix) };
        copy = data.vertices;
        this._meshTris += Math.floor(ix.length / 3);
        this._meshBytes += data.vertices.byteLength + data.indices.byteLength;
        this._rawOfMesh.push(raw.meshes.length);
        raw.meshes.push({ label, pose: Float64Array.from(mat), lastChangedTime: Number(mesh.lastChangedTime) || 0, data });
      } else this._rawOfMesh.push(-1);
      const n = Math.floor(v.length / 3);
      if (n <= HULL_MAX_VERTICES) {
        snap.meshes.push(meshBox(label, mat, v));
        spent += n;
        this._i++;
        continue;
      }
      // a large mesh (the global mesh): its bounds over this and the next frames, on the copy
      this._cur = { label, n, m: Float64Array.from(mat), v: copy || new Float32Array(v), k: 0,
        x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
      spent += Math.min(n, 4096); // the copies
    }
    if (this._i >= L.length && !this._cur) this._finish();
    this._tick(t0);
    return this.done;
  }

  _finish() {
    const raw = this._raw, snap = this.snap, opts = this._opts;
    if (raw.meshes.length) {
      const g = pickGlobal(raw.meshes);
      raw.global = g;
      if (g >= 0) {
        const r = raw.meshes[g];
        snap.globalMesh = { label: r.label, mesh: this._rawOfMesh.indexOf(g), vertexCount: Math.floor(r.data.vertices.length / 3),
          triangleCount: Math.floor(r.data.indices.length / 3), lastChangedTime: r.lastChangedTime };
      }
      attachRaw(snap, raw);
    }
    if (opts.stats) {
      opts.stats.planes = snap.planes.length;
      opts.stats.meshes = snap.meshes.length;
      opts.stats.skippedPlanes = this._skippedPlanes;
      opts.stats.skippedMeshes = this._skippedMeshes;
      opts.stats.meshTris = this._meshTris;
      opts.stats.meshBytes = this._meshBytes;
    }
    this._list = [];
    this.done = true;
    this.active = false;
  }

  /** @param {number} t0 */
  _tick(t0) {
    const ms = clockMs() - t0;
    this.ms += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    this.frames++;
  }

  /** For the record. */
  report() { return { ms: Math.round(this.ms * 100) / 100, maxMs: Math.round(this.maxMs * 100) / 100, frames: this.frames }; }
}

/** @returns {number} ms */
function clockMs() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

/**
 * The box of a large mesh from its world-axis bounds (meshBox's rule over HULL_MAX_VERTICES).
 * @param {string|null} label @param {{ x0: number, x1: number, y0: number, y1: number, z0: number, z1: number }} b
 */
function boundsBox(label, b) {
  const hy = (b.y1 - b.y0) / 2, cy = (b.y0 + b.y1) / 2;
  return {
    label,
    pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, r4((b.x0 + b.x1) / 2), r4(cy), r4((b.z0 + b.z1) / 2), 1],
    min: [r4(-(b.x1 - b.x0) / 2), r4(-hy), r4(-(b.z1 - b.z0) / 2)],
    max: [r4((b.x1 - b.x0) / 2), r4(hy), r4((b.z1 - b.z0) / 2)],
    vertexCount: /** @type {any} */ (b).n || 0,
  };
}

/**
 * The global mesh among raw meshes: label 'global mesh', else the largest
 * over 5,000 triangles (−1 none). Same rule as MeshPrep.pickGlobalMesh.
 * @param {RawMesh[]} meshes
 */
function pickGlobal(meshes) {
  let best = -1, bestTris = 5000;
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const l = typeof m.label === 'string' ? m.label.toLowerCase().trim().replace(/[_-]+/g, ' ') : '';
    const tris = Math.floor(m.data.indices.length / 3);
    if (l === 'global mesh' && tris > 0) return i;
    if (tris > bestTris) { bestTris = tris; best = i; }
  }
  return best;
}

/**
 * Attach the captured triangles to a snapshot (not enumerable: never in
 * JSON, never structured-cloned).
 * @param {object} snap @param {RawSet|null} raw
 */
export function attachRaw(snap, raw) {
  Object.defineProperty(snap, 'raw', { value: raw, enumerable: false, writable: true, configurable: true });
  return snap;
}

/**
 * The snapshot's captured triangles, or null.
 * @param {any} snap
 * @returns {RawSet|null}
 */
export function rawOf(snap) {
  const r = snap && snap.raw;
  return r && Array.isArray(r.meshes) ? r : null;
}

/**
 * The global mesh to build from (pose + arrays), or null when the snapshot has
 * none or its arrays are lent to the worker right now.
 * @param {any} snap
 * @returns {RawMesh|null}
 */
export function globalRawMesh(snap) {
  const r = rawOf(snap);
  if (!r || r.global < 0 || r.global >= r.meshes.length) return null;
  const m = r.meshes[r.global];
  const d = m && m.data;
  if (!d || !d.vertices || !d.indices || d.vertices.length < 9 || d.indices.length < 3) return null;
  return m;
}

/**
 * The snapshot for Copy: the same JSON without the encoded mesh blob
 * (`globalMesh.data`; the counts and the hash stay). Allocates.
 * @param {any} snap
 */
export function snapshotForCopy(snap) {
  if (!snap || typeof snap !== 'object' || !snap.globalMesh) return snap;
  const { data, ...meta } = snap.globalMesh;
  return { ...snap, globalMesh: { ...meta, dataOmitted: typeof data === 'string' } };
}

/**
 * Decode `globalMesh.data` (a session record or the fixture) into `snap.raw`
 * when the snapshot has no captured triangles (async: gzip). Returns the
 * snapshot; a bad blob is noted in `globalMesh.error` and left undecoded.
 * @param {any} snap
 */
export async function hydrateSnapshot(snap) {
  if (!snap || rawOf(snap) || !snap.globalMesh || typeof snap.globalMesh.data !== 'string') return snap;
  try {
    const d = await decodeMeshRecord(snap.globalMesh);
    const pose = new Float64Array(16);
    pose[0] = pose[5] = pose[10] = pose[15] = 1;
    attachRaw(snap, { token: ++rawToken, global: 0,
      meshes: [{ label: snap.globalMesh.label || 'global mesh', pose, lastChangedTime: Number(snap.globalMesh.lastChangedTime) || 0,
        data: { vertices: d.vertices, indices: d.indices } }] });
  } catch (e) {
    snap.globalMesh.error = (e instanceof Error ? e.message || e.name : String(e)) || 'mesh decode failed';
  }
  return snap;
}

/** @param {unknown} l */
function labelOf(l) {
  return typeof l === 'string' && l.trim() ? l : null;
}

/** @param {ArrayLike<number>} m */
function poseArray(m) {
  /** @type {number[]} */ const out = new Array(16);
  for (let i = 0; i < 16; i++) out[i] = i >= 12 ? r4(m[i]) : r6(m[i]);
  return out;
}

/**
 * Gravity-aligned oriented box of a mesh in the reference space: yaw from the
 * minimum-area rectangle of the convex hull of its x/z points (PLAN §6.1),
 * y range from its vertices. The pose is a rotation about +Y at the box centre.
 * @param {string|null} label
 * @param {ArrayLike<number>} m column-major mesh pose
 * @param {ArrayLike<number>} v vertices (mesh space)
 */
export function meshBox(label, m, v) {
  const n = Math.floor(v.length / 3);
  const xs = new Float64Array(n), zs = new Float64Array(n);
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = v[3 * i], b = v[3 * i + 1], c = v[3 * i + 2];
    const x = m[0] * a + m[4] * b + m[8] * c + m[12];
    const y = m[1] * a + m[5] * b + m[9] * c + m[13];
    const z = m[2] * a + m[6] * b + m[10] * c + m[14];
    xs[i] = x; zs[i] = z;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const r = rect();
  if (n <= HULL_MAX_VERTICES) {
    const hull = new Int32Array(n + 1);
    minAreaRect(xs, zs, hull, convexHull(xs, zs, n, hull), r);
  } else {
    r.cx = (x0 + x1) / 2; r.cz = (z0 + z1) / 2; r.c = 1; r.s = 0; r.hx = (x1 - x0) / 2; r.hz = (z1 - z0) / 2;
  }
  const hy = (y1 - y0) / 2, cy = (y0 + y1) / 2;
  const c = r6(r.c), s = r6(r.s);
  return {
    label,
    pose: [c, 0, s, 0, 0, 1, 0, 0, 0 - s, 0, c, 0, r4(r.cx), r4(cy), r4(r.cz), 1],
    min: [r4(-r.hx), r4(-hy), r4(-r.hz)],
    max: [r4(r.hx), r4(hy), r4(r.hz)],
    vertexCount: n,
  };
}

/**
 * Fetch a stored snapshot (e.g. tests/fixtures/house.json for ?emulate).
 * @param {string} url
 * @returns {Promise<import('./Layout.js').SpaceSnapshot>}
 */
export async function loadFixture(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadFixture ${url}: HTTP ${res.status}`);
  return hydrateSnapshot(normalizeSnapshot(await res.json()));
}

/** @param {unknown} a @param {number} n */
function finiteArray(a, n) {
  if (!a || typeof a !== 'object' || /** @type {any} */ (a).length !== n) return false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(/** @type {any} */ (a)[i])) return false;
  return true;
}

/**
 * Validate a snapshot from storage or a file. Entries that are malformed are
 * dropped; a wrong version or shape throws.
 * @param {any} obj
 * @returns {import('./Layout.js').SpaceSnapshot}
 */
export function normalizeSnapshot(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('snapshot: not an object');
  if (!SNAPSHOT_VERSIONS.includes(obj.version)) throw new Error(`snapshot: unsupported version ${obj.version}`);
  /** @type {import('./Layout.js').SpaceSnapshot} */
  const out = { version: SNAPSHOT_VERSION, space: typeof obj.space === 'string' ? obj.space : 'local-floor', planes: [], meshes: [], globalMesh: null };
  for (const p of Array.isArray(obj.planes) ? obj.planes : []) {
    if (!p || !finiteArray(p.pose, 16) || !Array.isArray(p.polygon) || p.polygon.length < 3) continue;
    if (!p.polygon.every((/** @type {unknown} */ q) => finiteArray(q, 2))) continue;
    const orientation = p.orientation === 'vertical' || p.orientation === 'horizontal'
      ? p.orientation
      : (Math.abs(p.pose[5]) > 0.7 ? 'horizontal' : 'vertical');
    out.planes.push({
      label: labelOf(p.label),
      orientation,
      pose: p.pose.slice(),
      polygon: p.polygon.map((/** @type {number[]} */ q) => [q[0], q[1]]),
    });
  }
  for (const m of Array.isArray(obj.meshes) ? obj.meshes : []) {
    if (!m || !finiteArray(m.pose, 16) || !finiteArray(m.min, 3) || !finiteArray(m.max, 3)) continue;
    out.meshes.push({
      label: labelOf(m.label),
      pose: m.pose.slice(),
      min: m.min.slice(),
      max: m.max.slice(),
      vertexCount: Number.isFinite(m.vertexCount) ? m.vertexCount : 0,
    });
  }
  const g = obj.globalMesh;
  if (g && typeof g === 'object') {
    /** @type {any} */ const gm = {
      label: labelOf(g.label) || 'global mesh', mesh: Number.isInteger(g.mesh) ? g.mesh : -1,
      vertexCount: Number.isFinite(g.vertexCount) ? g.vertexCount : 0, triangleCount: Number.isFinite(g.triangleCount) ? g.triangleCount : 0,
      lastChangedTime: Number.isFinite(g.lastChangedTime) ? g.lastChangedTime : 0,
    };
    if (typeof g.data === 'string' && typeof g.encoding === 'string') {
      gm.space = typeof g.space === 'string' ? g.space : 'reference';
      gm.encoding = g.encoding;
      gm.compression = g.compression === 'gzip' ? 'gzip' : 'none';
      gm.quantum = Number(g.quantum) || 0;
      gm.origin = finiteArray(g.origin, 3) ? g.origin.slice() : [0, 0, 0];
      gm.hash = typeof g.hash === 'string' ? g.hash : '';
      gm.bytes = Number(g.bytes) || 0;
      gm.data = g.data;
    }
    out.globalMesh = gm;
  }
  // v0.5: the learned overlay's bookkeeping (src/learn/overlay.js): how many planes / volumes are Space Setup's,
  // and the points the user walked (a walked room is never taken for unscanned space)
  const sb = obj.scanBase;
  if (sb && Number.isInteger(sb.planes) && Number.isInteger(sb.meshes)) {
    /** @type {any} */ (out).scanBase = { planes: Math.min(sb.planes, out.planes.length), meshes: Math.min(sb.meshes, out.meshes.length) };
  }
  if (Array.isArray(obj.scanWalked)) {
    /** @type {any} */ (out).scanWalked = obj.scanWalked.filter((/** @type {unknown} */ q) => finiteArray(q, 2)).slice(0, 2000).map((/** @type {number[]} */ q) => [q[0], q[1]]);
  }
  const raw = rawOf(obj);
  if (raw) attachRaw(out, raw); // a live capture keeps its triangles through normalisation
  return out;
}

/**
 * Decides when to capture: once the plane count has been stable for
 * `stableMs` (with at least one plane), or `timeoutMs` after the first call
 * (then the capture may be empty, and the world falls back to a virtual room).
 * `update` is allocation-free.
 */
export class CaptureGate {
  /** @param {{ stableMs?: number, timeoutMs?: number }} [o] */
  constructor({ stableMs = 500, timeoutMs = 3000 } = {}) {
    this.stableMs = stableMs;
    this.timeoutMs = timeoutMs;
    this.t0 = -1;
    this.count = -1;
    this.since = 0;
    this.done = false;
  }

  reset() {
    this.t0 = -1;
    this.count = -1;
    this.since = 0;
    this.done = false;
  }

  /**
   * @param {any} frame XRFrame
   * @param {number} tMs frame time
   * @returns {boolean} true once, on the frame to capture in
   */
  update(frame, tMs) {
    if (this.done) return false;
    if (this.t0 < 0) this.t0 = tMs;
    const planes = frame ? frame.detectedPlanes : null;
    const n = planes ? planes.size : 0;
    if (n !== this.count) { this.count = n; this.since = tMs; }
    if ((n > 0 && tMs - this.since >= this.stableMs) || tMs - this.t0 >= this.timeoutMs) {
      this.done = true;
      return true;
    }
    return false;
  }
}
