// @ts-check
/**
 * Re-aligning the world to the house after a reference-space reset or slow
 * drift (pure: no three.js, no DOM). Roam walks the whole house for tens of
 * minutes, so the reference space can be reset (recentring, relocalisation:
 * the House Scanner saw one 4.35 s into an `unbounded` session) or drift
 * against the Space Setup planes. The world is built from a snapshot in the
 * session's space; when that space moves, the snapshot is moved with it and
 * the world rebuilt behind a pause.
 *
 * - `resetTransform(e.transform)`: XRReferenceSpaceEvent.transform is the new
 *   origin expressed in the previous space (p_old = T · p_new), so old
 *   coordinates map to new ones with T⁻¹ (returned, column-major 4×4).
 * - `rigidFromPoses(old, now)`: the same plane's pose at capture and now →
 *   the gravity-aligned (yaw-only) rigid transform old → new.
 * - `transformSnapshot(snap, m)`: every plane and mesh pose premultiplied by
 *   m (allocates: build time, behind a pause).
 * - `pickReferencePlanes(snap)`: up to 3 planes to watch (the largest floor,
 *   then the two longest walls that are not parallel).
 * - `DriftWatch`: once a second during play the integrator samples the
 *   reference planes' current poses (`check(frame, space, planes, t)`, 3
 *   getPose calls); drift over 0.10 m or 2° on 2 checks in a row asks for a
 *   realign, with the correction ready in `correction` (old → new).
 *
 * Decision (v0.3): nothing is stored as an XRAnchor (anchors are reported to
 * fail under `unbounded` on Quest 3); the Space Setup planes are the ground truth.
 */

/** Drift limits. */
export const DRIFT = Object.freeze({
  maxM: 0.10,
  maxDeg: 2.0,
  /** Checks in a row over a limit before a realign. */
  confirm: 2,
  periodS: 1.0,
});

/**
 * Rigid inverse of a column-major 4×4 (rotation + translation).
 * @param {ArrayLike<number>} m @param {Float64Array|number[]} out
 */
export function rigidInverse(m, out) {
  // R^T
  const r00 = m[0], r10 = m[1], r20 = m[2], r01 = m[4], r11 = m[5], r21 = m[6], r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = r00; out[1] = r01; out[2] = r02; out[3] = 0;
  out[4] = r10; out[5] = r11; out[6] = r12; out[7] = 0;
  out[8] = r20; out[9] = r21; out[10] = r22; out[11] = 0;
  out[12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[14] = -(r02 * tx + r12 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/**
 * a · b (column-major 4×4) into out (out may not alias a or b).
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {Float64Array|number[]} out
 */
export function mul4(a, b, out) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/**
 * Old-space → new-space transform for a reference-space `reset` event.
 * @param {{ matrix?: ArrayLike<number>, position?: { x: number, y: number, z: number }, orientation?: { x: number, y: number, z: number, w: number } }|null|undefined} t
 *   the event's XRRigidTransform (or a copy of it)
 * @returns {Float64Array|null} column-major 4×4, null without a transform
 */
export function resetTransform(t) {
  if (!t) return null;
  const m = new Float64Array(16);
  if (t.matrix && t.matrix.length === 16) {
    for (let i = 0; i < 16; i++) m[i] = t.matrix[i];
  } else if (t.position && t.orientation) {
    const { x, y, z, w } = t.orientation;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
    m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x);
    m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y);
    m[12] = t.position.x; m[13] = t.position.y; m[14] = t.position.z; m[15] = 1;
  } else return null;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return null;
  const inv = new Float64Array(16);
  rigidInverse(m, inv);
  return inv;
}

/**
 * Yaw (rad, about +Y) of a transform's rotation: the heading of its local x axis.
 * @param {ArrayLike<number>} m
 */
export function yawOf(m) {
  return Math.atan2(-m[2], m[0]);
}

/**
 * The gravity-aligned rigid transform X with X · old ≈ now, from one plane's
 * pose at capture (`old`) and now (`now`): yaw only (both poses' local axes),
 * translation so the plane origin lands where it is now.
 * @param {ArrayLike<number>} old @param {ArrayLike<number>} now
 * @param {Float64Array|number[]} out column-major 4×4
 * @param {number} [oo] offset of the old pose in `old` @param {number} [on] offset of the current pose in `now`
 * @returns {{ dyaw: number, dx: number, dy: number, dz: number }} the parts (rad, m), reused object
 */
export function rigidFromPoses(old, now, out, oo = 0, on = 0) {
  // A plane's local frame: use the axis that is horizontal (x for every Quest plane).
  const a0 = Math.atan2(-old[oo + 2], old[oo]), a1 = Math.atan2(-now[on + 2], now[on]);
  let dyaw = a1 - a0;
  while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  const c = Math.cos(dyaw), s = Math.sin(dyaw);
  // rotation about +Y: x' = c·x + s·z, z' = −s·x + c·z
  out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
  const ox = old[oo + 12], oy = old[oo + 13], oz = old[oo + 14];
  const rx = c * ox + s * oz, rz = -s * ox + c * oz;
  out[12] = now[on + 12] - rx; out[13] = now[on + 13] - oy; out[14] = now[on + 14] - rz; out[15] = 1;
  PARTS.dyaw = dyaw;
  PARTS.dx = out[12];
  PARTS.dy = out[13];
  PARTS.dz = out[14];
  return PARTS;
}
const PARTS = { dyaw: 0, dx: 0, dy: 0, dz: 0 };

/**
 * A copy of the snapshot with every pose premultiplied by m (old space → new space).
 * @param {import('./Layout.js').SpaceSnapshot} snap
 * @param {ArrayLike<number>} m column-major 4×4
 * @param {string} [space] the new space name (default: the snapshot's)
 * @returns {import('./Layout.js').SpaceSnapshot}
 */
export function transformSnapshot(snap, m, space) {
  const tmp = new Float64Array(16);
  /** @param {number[]} pose */
  const move = (pose) => {
    mul4(m, pose, tmp);
    /** @type {number[]} */ const out = new Array(16);
    for (let i = 0; i < 16; i++) out[i] = Math.round(tmp[i] * 1e6) / 1e6 + 0;
    return out;
  };
  /** @type {any} */ const out = {
    version: snap.version,
    space: space || snap.space,
    planes: snap.planes.map((p) => ({ label: p.label, orientation: p.orientation, pose: move(p.pose), polygon: p.polygon.map((q) => [q[0], q[1]]) })),
    meshes: snap.meshes.map((x) => ({ label: x.label, pose: move(x.pose), min: x.min.slice(), max: x.max.slice(), vertexCount: x.vertexCount })),
  };
  // v2: the global mesh's description (its encoded blob is in the old space: left out) and the
  // captured triangles (shared arrays, every pose moved)
  const g = /** @type {any} */ (snap).globalMesh;
  if (g && typeof g === 'object') {
    out.globalMesh = { label: g.label, mesh: g.mesh, vertexCount: g.vertexCount, triangleCount: g.triangleCount, lastChangedTime: g.lastChangedTime,
      ...(g.hash ? { movedFrom: g.hash } : {}) };
  } else if (snap.version >= 2) out.globalMesh = null;
  const raw = /** @type {any} */ (snap).raw;
  if (raw && Array.isArray(raw.meshes)) {
    const moved = {
      token: raw.token, global: raw.global,
      meshes: raw.meshes.map((/** @type {any} */ r) => ({ label: r.label, pose: mul4(m, r.pose, new Float64Array(16)), lastChangedTime: r.lastChangedTime, data: r.data })),
    };
    Object.defineProperty(out, 'raw', { value: moved, enumerable: false, writable: true, configurable: true });
  }
  return out;
}

/**
 * Apply m to a point (x, z) on the floor (y ignored): the player start after a realign.
 * @param {ArrayLike<number>} m @param {{ x: number, z: number }} p modified in place
 */
export function transformPointXZ(m, p) {
  const x = p.x, z = p.z;
  p.x = m[0] * x + m[8] * z + m[12];
  p.z = m[2] * x + m[10] * z + m[14];
  return p;
}

/**
 * Up to 3 reference planes for the drift watch: the largest floor, then the
 * longest wall, then the longest wall not parallel to it (|n₁·n₂| < 0.5).
 * @param {import('./Layout.js').SpaceSnapshot|null} snap
 * @returns {number[]} indices into snap.planes
 */
export function pickReferencePlanes(snap) {
  if (!snap || !snap.planes) return [];
  let floor = -1, floorA = 0;
  /** @type {{ i: number, len: number, nx: number, nz: number }[]} */ const walls = [];
  snap.planes.forEach((p, i) => {
    const lab = (p.label || '').toLowerCase();
    const poly = p.polygon;
    if (p.orientation === 'horizontal') {
      if (lab !== 'floor') return;
      let a = 0;
      for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) a += poly[j][0] * poly[k][1] - poly[k][0] * poly[j][1];
      a = Math.abs(a) / 2;
      if (a > floorA) { floorA = a; floor = i; }
    } else if (lab === 'wall' || lab === 'wall face') {
      let u0 = Infinity, u1 = -Infinity;
      for (const q of poly) { if (q[0] < u0) u0 = q[0]; if (q[0] > u1) u1 = q[0]; }
      const nx = p.pose[4], nz = p.pose[6], nl = Math.hypot(nx, nz) || 1;
      walls.push({ i, len: u1 - u0, nx: nx / nl, nz: nz / nl });
    }
  });
  walls.sort((a, b) => b.len - a.len);
  const out = [];
  if (floor >= 0) out.push(floor);
  if (walls.length) {
    out.push(walls[0].i);
    const w2 = walls.find((w) => Math.abs(w.nx * walls[0].nx + w.nz * walls[0].nz) < 0.5);
    if (w2) out.push(w2.i);
  }
  return out;
}

/**
 * The drift watch. Feed it the reference planes' poses as they are now; it
 * tells when the world no longer matches the house.
 */
export class DriftWatch {
  /** @param {{ maxM?: number, maxDeg?: number, confirm?: number, periodS?: number }} [o] */
  constructor({ maxM = DRIFT.maxM, maxDeg = DRIFT.maxDeg, confirm = DRIFT.confirm, periodS = DRIFT.periodS } = {}) {
    this.maxM = maxM;
    this.maxDeg = maxDeg;
    this.confirm = confirm;
    this.periodS = periodS;
    this.refs = 0;
    this.old = new Float64Array(48);
    this.now = new Float64Array(48);
    this.have = new Uint8Array(3);
    this.correction = new Float64Array(16);
    this._tmp = new Float64Array(16);
    this.lastT = -1e9;
    this.streak = 0;
    this.stats = { checks: 0, maxM: 0, maxDeg: 0, lastM: 0, lastDeg: 0, triggers: 0, missing: 0 };
  }

  /**
   * Remember the reference planes' poses at capture.
   * @param {import('./Layout.js').SpaceSnapshot|null} snap @param {number[]} indices from pickReferencePlanes
   */
  setReference(snap, indices) {
    this.refs = 0;
    this.streak = 0;
    this.lastT = -1e9;
    if (!snap) return;
    for (const i of indices.slice(0, 3)) {
      const p = snap.planes[i];
      if (!p) continue;
      for (let k = 0; k < 16; k++) this.old[this.refs * 16 + k] = p.pose[k];
      this.refs++;
    }
  }

  /** Is a check due at time t (s)? @param {number} t */
  due(t) { return this.refs > 0 && t - this.lastT >= this.periodS; }

  /**
   * One check: sample each reference plane's pose now (3 getPose calls; the
   * browser allocates their results), then evaluate.
   * @param {any} frame XRFrame @param {any} space @param {ArrayLike<any>} planes the XRPlane objects, in reference order
   * @param {number} t seconds
   * @returns {boolean} true when a realign is wanted (correction ready)
   */
  check(frame, space, planes, t) {
    this.lastT = t;
    for (let r = 0; r < this.refs; r++) {
      this.have[r] = 0;
      const pl = planes && planes[r];
      let pose = null;
      try { pose = pl && pl.planeSpace ? frame.getPose(pl.planeSpace, space) : null; } catch { pose = null; }
      if (pose) this.sample(r, pose.transform.matrix);
    }
    return this.evaluate();
  }

  /** @param {number} r reference index @param {ArrayLike<number>|null} m current pose (column-major) */
  sample(r, m) {
    if (r < 0 || r >= this.refs) return;
    if (!m) { this.have[r] = 0; return; }
    for (let k = 0; k < 16; k++) this.now[r * 16 + k] = m[k];
    this.have[r] = 1;
  }

  /**
   * Drift = max over the sampled planes of the plane origin's horizontal move
   * and the yaw change. Over a limit on `confirm` checks in a row → true, and
   * `correction` holds old → new (from the first sampled plane).
   * Allocation-free.
   */
  evaluate() {
    const st = this.stats;
    st.checks++;
    let maxM = 0, maxDeg = 0, first = -1;
    for (let r = 0; r < this.refs; r++) {
      if (!this.have[r]) { st.missing++; continue; }
      if (first < 0) first = r;
      const o = r * 16, A = this.old, B = this.now;
      const dx = B[o + 12] - A[o + 12], dz = B[o + 14] - A[o + 14];
      const m = Math.sqrt(dx * dx + dz * dz);
      let dy = Math.atan2(-B[o + 2], B[o]) - Math.atan2(-A[o + 2], A[o]);
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      const deg = Math.abs(dy) * (180 / Math.PI);
      if (m > maxM) maxM = m;
      if (deg > maxDeg) maxDeg = deg;
    }
    st.lastM = maxM;
    st.lastDeg = maxDeg;
    if (maxM > st.maxM) st.maxM = maxM;
    if (maxDeg > st.maxDeg) st.maxDeg = maxDeg;
    if (first < 0) { this.streak = 0; return false; }
    const over = maxM > this.maxM || maxDeg > this.maxDeg;
    this.streak = over ? this.streak + 1 : 0;
    if (this.streak < this.confirm) return false;
    const o = first * 16;
    rigidFromPoses(this.old, this.now, this.correction, o, o);
    this.streak = 0;
    st.triggers++;
    return true;
  }

  /** After the world was rebuilt from the moved snapshot: the planes' poses now are the new reference. */
  rebase() {
    for (let r = 0; r < this.refs; r++) {
      if (!this.have[r]) continue;
      for (let k = 0; k < 16; k++) this.old[r * 16 + k] = this.now[r * 16 + k];
    }
    this.streak = 0;
  }

  /** Session-record summary (allocates). */
  report() {
    const s = this.stats, r3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
    return { refs: this.refs, checks: s.checks, maxM: r3(s.maxM), maxDeg: r3(s.maxDeg), lastM: r3(s.lastM), lastDeg: r3(s.lastDeg), triggers: s.triggers, missing: s.missing };
  }
}
