// @ts-check
/**
 * Recent poses of an item in the hand, for the release (pure, allocation-free).
 * Research spec §7 and CQC's throw estimate (values only):
 *
 * - linear velocity of the item origin: the least-squares slope over the last
 *   70 ms (at least 3 samples);
 * - angular velocity: recency-weighted over the last 65 ms (newer frame pairs
 *   count more), capped at 25 rad/s;
 * - the velocity of the centre of mass: v_origin + ω × r, r = R · com (the
 *   centre of mass in item space), capped at 12 m/s;
 * - a tracking jump (more than 0.45 rad or 0.25 m in one frame) clears the
 *   history, so a pose glitch never throws the gun across the room.
 *
 * `sample(age)` gives an older pose for the penetration-safe placement
 * (stepping back to the newest pose that was free).
 */

export const HISTORY = Object.freeze({
  n: 24,             // samples kept: 0.33 s at 72 Hz, 0.27 s at 90 Hz
  linS: 0.07,        // s window of the linear fit
  angS: 0.065,       // s window of the angular estimate
  minSamples: 3,
  jumpRad: 0.45,     // rad in one frame: a tracking jump
  jumpM: 0.25,       // m in one frame
  maxLin: 12,        // m/s
  maxAng: 25,        // rad/s
});

/** Velocity estimate written by `PoseHistory.velocity`. */
export class Velocity {
  constructor() {
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    /** |v| of the centre of mass (m/s) and |ω| (rad/s) after the caps. */
    this.lin = 0; this.ang = 0;
    /** Samples used by the linear fit. */
    this.n = 0;
    // born doubles: the fields never change representation mid-play
    this.vx = 0.5; this.vx = 0; this.lin = 0.5; this.lin = 0; this.ang = 0.5; this.ang = 0;
  }

  zero() { this.vx = this.vy = this.vz = this.wx = this.wy = this.wz = this.lin = this.ang = 0; this.n = 0; }
}

export class PoseHistory {
  /** @param {number} [n] samples kept */
  constructor(n = HISTORY.n) {
    this.n = n;
    this.t = new Float64Array(n);
    this.p = new Float64Array(n * 3);
    this.q = new Float64Array(n * 4);
    /** Samples stored (≤ n). */
    this.count = 0;
    /** Index of the newest sample. */
    this.head = -1;
    /** Histories cleared by a tracking jump. */
    this.jumps = 0;
  }

  reset() { this.count = 0; this.head = -1; }

  /**
   * Add the pose at time tS (s) from a column-major 4×4 matrix (rotation part orthonormal).
   * @param {number} tS @param {ArrayLike<number>} m
   */
  push(tS, m) {
    // rotation matrix → quaternion (Shepperd)
    const m00 = m[0], m10 = m[1], m20 = m[2], m01 = m[4], m11 = m[5], m21 = m[6], m02 = m[8], m12 = m[9], m22 = m[10];
    const tr = m00 + m11 + m22;
    let x = 0, y = 0, z = 0, w = 1;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    this.pushPQ(tS, m[12], m[13], m[14], x, y, z, w);
  }

  /**
   * Add a pose (position, unit quaternion) at time tS (s). Non-finite poses are ignored;
   * a jump clears the history first.
   * @param {number} tS
   * @param {number} px @param {number} py @param {number} pz
   * @param {number} qx @param {number} qy @param {number} qz @param {number} qw
   */
  pushPQ(tS, px, py, pz, qx, qy, qz, qw) {
    if (!Number.isFinite(tS + px + py + pz + qx + qy + qz + qw)) return;
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (!(ql > 0.5)) return;
    qx /= ql; qy /= ql; qz /= ql; qw /= ql;
    if (this.count > 0) {
      const h = this.head, P = this.p, Q = this.q;
      const dt = tS - this.t[h];
      if (!(dt > 0)) {
        // same or older time: replace the newest (a repeated frame), never go back in time
        if (dt === 0) { P[h * 3] = px; P[h * 3 + 1] = py; P[h * 3 + 2] = pz; Q[h * 4] = qx; Q[h * 4 + 1] = qy; Q[h * 4 + 2] = qz; Q[h * 4 + 3] = qw; }
        return;
      }
      const dx = px - P[h * 3], dy = py - P[h * 3 + 1], dz = pz - P[h * 3 + 2];
      let d = qx * Q[h * 4] + qy * Q[h * 4 + 1] + qz * Q[h * 4 + 2] + qw * Q[h * 4 + 3];
      if (d < 0) d = -d;
      const ang = 2 * Math.acos(d > 1 ? 1 : d);
      if (dx * dx + dy * dy + dz * dz > HISTORY.jumpM * HISTORY.jumpM || ang > HISTORY.jumpRad) { this.count = 0; this.head = -1; this.jumps++; }
    }
    const i = (this.head + 1) % this.n;
    this.head = i;
    if (this.count < this.n) this.count++;
    this.t[i] = tS;
    const P = this.p, Q = this.q;
    P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = pz;
    Q[i * 4] = qx; Q[i * 4 + 1] = qy; Q[i * 4 + 2] = qz; Q[i * 4 + 3] = qw;
  }

  /** Time of the newest sample (NaN when empty). */
  get newestT() { return this.count > 0 ? this.t[this.head] : NaN; }

  /**
   * Velocity of the centre of mass and the angular velocity at the newest sample.
   * @param {number} cx @param {number} cy @param {number} cz centre of mass in item space
   * @param {Velocity} out
   * @returns {boolean} false (out zeroed) with fewer than 3 samples in the window
   */
  velocity(cx, cy, cz, out) {
    out.zero();
    const c = this.count;
    if (c < HISTORY.minSamples) return false;
    const N = this.n, T = this.t, P = this.p, Q = this.q, h = this.head, tN = T[h];
    // ── linear: least-squares slope over the window (time relative to the newest sample)
    let n = 0, st = 0, sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < c; k++) {
      const i = (h - k + N) % N, dt = T[i] - tN;
      if (dt < -HISTORY.linS - 1e-9) break;
      n++; st += dt; sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2];
    }
    if (n < HISTORY.minSamples) {
      // a slow frame rate: the last three samples whatever their age
      n = Math.min(c, HISTORY.minSamples);
      st = 0; sx = 0; sy = 0; sz = 0;
      for (let k = 0; k < n; k++) { const i = (h - k + N) % N; st += T[i] - tN; sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; }
    }
    const mt = st / n, mx = sx / n, my = sy / n, mz = sz / n;
    let stt = 0, bx = 0, by = 0, bz = 0;
    for (let k = 0; k < n; k++) {
      const i = (h - k + N) % N, dt = T[i] - tN - mt;
      stt += dt * dt; bx += dt * (P[i * 3] - mx); by += dt * (P[i * 3 + 1] - my); bz += dt * (P[i * 3 + 2] - mz);
    }
    let vx = 0, vy = 0, vz = 0;
    if (stt > 1e-12) { vx = bx / stt; vy = by / stt; vz = bz / stt; }
    // ── angular: recency-weighted frame-pair rotations (world frame: q_i = Δq · q_{i−1})
    let wx = 0, wy = 0, wz = 0, ws = 0;
    for (let k = 0; k < c - 1; k++) {
      const i = (h - k + N) % N, j = (i - 1 + N) % N;
      const dt = T[i] - T[j];
      if (!(dt > 0)) continue;
      if (tN - T[j] > HISTORY.angS + 1e-9 && k > 0) break;
      // Δq = q_i · conj(q_j)
      const ax = Q[i * 4], ay = Q[i * 4 + 1], az = Q[i * 4 + 2], aw = Q[i * 4 + 3];
      const bx2 = -Q[j * 4], by2 = -Q[j * 4 + 1], bz2 = -Q[j * 4 + 2], bw = Q[j * 4 + 3];
      let dx = aw * bx2 + ax * bw + ay * bz2 - az * by2;
      let dy = aw * by2 - ax * bz2 + ay * bw + az * bx2;
      let dz = aw * bz2 + ax * by2 - ay * bx2 + az * bw;
      let dw = aw * bw - ax * bx2 - ay * by2 - az * bz2;
      if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; dw = -dw; }
      const s = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const wgt = c - k;   // newest pair weighs most
      if (s > 1e-12) {
        const a = (2 * Math.atan2(s, dw)) / dt / s;
        wx += dx * a * wgt; wy += dy * a * wgt; wz += dz * a * wgt;
      }
      ws += wgt;
    }
    if (ws > 0) { wx /= ws; wy /= ws; wz /= ws; }
    let ang = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (ang > HISTORY.maxAng) { const k = HISTORY.maxAng / ang; wx *= k; wy *= k; wz *= k; ang = HISTORY.maxAng; }
    // ── centre of mass: v + ω × (R · com)
    const qx = Q[h * 4], qy = Q[h * 4 + 1], qz = Q[h * 4 + 2], qw = Q[h * 4 + 3];
    // r = q · c · q⁻¹
    const tx = 2 * (qy * cz - qz * cy), ty = 2 * (qz * cx - qx * cz), tz = 2 * (qx * cy - qy * cx);
    const rx = cx + qw * tx + (qy * tz - qz * ty), ry = cy + qw * ty + (qz * tx - qx * tz), rz = cz + qw * tz + (qx * ty - qy * tx);
    vx += wy * rz - wz * ry; vy += wz * rx - wx * rz; vz += wx * ry - wy * rx;
    let lin = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (lin > HISTORY.maxLin) { const k = HISTORY.maxLin / lin; vx *= k; vy *= k; vz *= k; lin = HISTORY.maxLin; }
    out.vx = vx; out.vy = vy; out.vz = vz; out.wx = wx; out.wy = wy; out.wz = wz; out.lin = lin; out.ang = ang; out.n = n;
    return true;
  }

  /**
   * The pose `ageS` seconds before the newest sample (linear / normalised-lerp between samples;
   * the oldest sample when older than the history).
   * @param {number} ageS @param {Float64Array|Float32Array|number[]} out7 px, py, pz, qx, qy, qz, qw
   * @returns {boolean} false when empty
   */
  sample(ageS, out7) {
    const c = this.count;
    if (c === 0) return false;
    const N = this.n, T = this.t, h = this.head, tq = T[h] - (ageS > 0 ? ageS : 0);
    let i = h;
    for (let k = 0; k < c - 1; k++) {
      const j = (i - 1 + N) % N;
      if (T[j] <= tq) {
        const span = T[i] - T[j], u = span > 0 ? (tq - T[j]) / span : 0;
        this._mix(j, i, u, out7);
        return true;
      }
      i = j;
    }
    this._mix(i, i, 0, out7);   // older than the history: the oldest sample
    return true;
  }

  /** Age of the oldest sample (s), 0 when empty. */
  get span() { return this.count > 1 ? this.t[this.head] - this.t[(this.head - this.count + 1 + this.n) % this.n] : 0; }

  /**
   * @param {number} a @param {number} b @param {number} u
   * @param {Float64Array|Float32Array|number[]} o
   */
  _mix(a, b, u, o) {
    const P = this.p, Q = this.q;
    o[0] = P[a * 3] + (P[b * 3] - P[a * 3]) * u;
    o[1] = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * u;
    o[2] = P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * u;
    let bx = Q[b * 4], by = Q[b * 4 + 1], bz = Q[b * 4 + 2], bw = Q[b * 4 + 3];
    const ax = Q[a * 4], ay = Q[a * 4 + 1], az = Q[a * 4 + 2], aw = Q[a * 4 + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, z = az + (bz - az) * u, w = aw + (bw - aw) * u;
    const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    o[3] = x / l; o[4] = y / l; o[5] = z / l; o[6] = w / l;
  }
}
