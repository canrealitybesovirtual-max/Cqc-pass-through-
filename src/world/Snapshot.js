// @ts-check
/**
 * Space Setup snapshot: the planes and meshes the browser reports, copied once
 * into plain JSON-safe data (no XR objects), so a capture can be stored in the
 * session record and replayed on desktop. Pure: no three.js, no DOM.
 *
 * ```
 * SpaceSnapshot = { version: 1, space: string,
 *   planes: [{ label: string|null, orientation: 'horizontal'|'vertical',
 *              pose: number[16],          // column-major, plane space → reference space
 *              polygon: [[x, z], …] }],   // plane space: y is the plane normal
 *   meshes: [{ label: string|null,
 *              pose: number[16],          // column-major; this capture writes a
 *                                         //  gravity-aligned box frame (y up)
 *              min: [x,y,z], max: [x,y,z], // box in that frame
 *              vertexCount: number }] }
 * ```
 *
 * WebXR facts used (plane-detection / mesh-detection modules): `frame.detectedPlanes`
 * and `frame.detectedMeshes` are set-likes; `XRPlane.polygon` is an array of
 * DOMPointReadOnly in plane space; `XRMesh.vertices` is a Float32Array of
 * x,y,z triplets in mesh space. On Quest 3 `lastChangedTime` ticks about 3×/s
 * with no real change (docs/DEVICE_LOG.md), so capture once (see CaptureGate)
 * and never rebuild during play.
 */

import { convexHull, minAreaRect, rect } from './geom.js';

export const SNAPSHOT_VERSION = 1;

/** Meshes with more vertices than this (the global room mesh) get a world-axis box instead of a hull. */
const HULL_MAX_VERTICES = 6000;

/** Round, and turn -0 into 0 (JSON writes both as 0). @param {number} v */
const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0;
/** @param {number} v */
const r6 = (v) => Math.round(v * 1e6) / 1e6 + 0;

/**
 * Copy the current Space Setup planes and meshes. Call inside an XR frame
 * callback (an XRFrame is dead after any await). Planes or meshes whose pose is
 * not available this frame are skipped and counted in `opts.stats`.
 *
 * @param {any} frame XRFrame (or any object with detectedPlanes / detectedMeshes / getPose)
 * @param {any} space XRReferenceSpace the poses are expressed in
 * @param {{ spaceName?: string, stats?: { planes: number, meshes: number, skippedPlanes: number, skippedMeshes: number } }} [opts]
 * @returns {import('./Layout.js').SpaceSnapshot}
 */
export function captureSnapshot(frame, space, opts = {}) {
  /** @type {import('./Layout.js').SpaceSnapshot} */
  const snap = { version: SNAPSHOT_VERSION, space: opts.spaceName || 'local-floor', planes: [], meshes: [] };
  let skippedPlanes = 0, skippedMeshes = 0;
  const planes = frame && frame.detectedPlanes;
  if (planes) {
    for (const p of planes) {
      const pose = p && p.planeSpace ? frame.getPose(p.planeSpace, space) : null;
      const poly = p && p.polygon;
      if (!pose || !poly || poly.length < 3) { skippedPlanes++; continue; }
      const m = pose.transform.matrix;
      /** @type {number[][]} */ const pts = [];
      for (let i = 0; i < poly.length; i++) pts.push([r4(poly[i].x), r4(poly[i].z)]);
      const orientation = p.orientation === 'vertical' || p.orientation === 'horizontal'
        ? p.orientation
        : (Math.abs(m[5]) > 0.7 ? 'horizontal' : 'vertical');
      snap.planes.push({ label: labelOf(p.semanticLabel), orientation, pose: poseArray(m), polygon: pts });
    }
  }
  const meshes = frame && frame.detectedMeshes;
  if (meshes) {
    for (const mesh of meshes) {
      const pose = mesh && mesh.meshSpace ? frame.getPose(mesh.meshSpace, space) : null;
      const v = mesh && mesh.vertices;
      if (!pose || !v || v.length < 3) { skippedMeshes++; continue; }
      snap.meshes.push(meshBox(labelOf(mesh.semanticLabel), pose.transform.matrix, v));
    }
  }
  if (opts.stats) {
    opts.stats.planes = snap.planes.length;
    opts.stats.meshes = snap.meshes.length;
    opts.stats.skippedPlanes = skippedPlanes;
    opts.stats.skippedMeshes = skippedMeshes;
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
  return normalizeSnapshot(await res.json());
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
  if (obj.version !== SNAPSHOT_VERSION) throw new Error(`snapshot: unsupported version ${obj.version}`);
  /** @type {import('./Layout.js').SpaceSnapshot} */
  const out = { version: SNAPSHOT_VERSION, space: typeof obj.space === 'string' ? obj.space : 'local-floor', planes: [], meshes: [] };
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
