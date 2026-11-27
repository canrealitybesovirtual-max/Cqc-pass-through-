// @ts-check
/**
 * Small vector and quaternion classes for the enemy rig (pure: no three.js, no
 * DOM, so the animator and hit shapes run in Node tests). Every method mutates
 * `this` and returns it; nothing allocates after construction, so per-frame
 * code keeps preallocated scratch objects.
 *
 * Quaternions are (x, y, z, w), unit length, and compose like three.js:
 * `a.mul(b)` = a·b, which applies b first, then a.
 */

export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  /** @param {number} x @param {number} y @param {number} z */
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  /** @param {V3} v */
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  /** @param {V3} v */
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  /** @param {V3} v */
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  /** this = a − b @param {V3} a @param {V3} b */
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  /** @param {V3} v @param {number} s */
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  /** @param {number} s */
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  /** @param {V3} v */
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  /** this = a × b (a, b may alias this) @param {V3} a @param {V3} b */
  cross(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  /** Unit length; a zero vector stays zero. */
  normalize() {
    const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    if (l > 1e-12) { this.x /= l; this.y /= l; this.z /= l; }
    return this;
  }
  /** @param {V3} v */
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  /** this = a + (b − a)·t @param {V3} a @param {V3} b @param {number} t */
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t;
    return this;
  }
  /** Rotate by a unit quaternion. @param {Q} q */
  applyQ(q) {
    const vx = this.x, vy = this.y, vz = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 q.xyz × v ; v' = v + w t + q.xyz × t
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    this.x = vx + qw * tx + (qy * tz - qz * ty);
    this.y = vy + qw * ty + (qz * tx - qx * tz);
    this.z = vz + qw * tz + (qx * ty - qy * tx);
    return this;
  }
  /** Rotate by the inverse of a unit quaternion. @param {Q} q */
  applyQInv(q) {
    const vx = this.x, vy = this.y, vz = this.z, qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    this.x = vx + qw * tx + (qy * tz - qz * ty);
    this.y = vy + qw * ty + (qz * tx - qx * tz);
    this.z = vz + qw * tz + (qx * ty - qy * tx);
    return this;
  }
  /** Component of this perpendicular to unit `n`. @param {V3} n */
  rejectFrom(n) { const d = this.x * n.x + this.y * n.y + this.z * n.z; this.x -= n.x * d; this.y -= n.y * d; this.z -= n.z * d; return this; }
}

export class Q {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  /** @param {number} x @param {number} y @param {number} z @param {number} w */
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  identity() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; return this; }
  /** @param {Q} q */
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  conj() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  /** @param {Q} q */
  dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
  normalize() {
    const l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l < 1e-12) return this.identity();
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  /** this = a·b (a, b may alias this) @param {Q} a @param {Q} b */
  mul(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  /** this = conj(a)·b @param {Q} a @param {Q} b */
  conjMul(a, b) {
    const ax = -a.x, ay = -a.y, az = -a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  /** this = a·conj(b) @param {Q} a @param {Q} b */
  mulConj(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = -b.x, by = -b.y, bz = -b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  /** this = this·b @param {Q} b */
  postMul(b) { return this.mul(this, b); }
  /** this = a·this @param {Q} a */
  preMul(a) { return this.mul(a, this); }
  /** Rotation of `angle` rad about the unit axis (x, y, z). */
  setAxisAngle(x, y, z, angle) {
    const h = angle * 0.5, s = Math.sin(h);
    this.x = x * s; this.y = y * s; this.z = z * s; this.w = Math.cos(h);
    return this;
  }
  /**
   * From an orthonormal basis given as the columns X, Y, Z of a rotation matrix.
   * @param {V3} X @param {V3} Y @param {V3} Z
   */
  setFromBasis(X, Y, Z) {
    const m00 = X.x, m10 = X.y, m20 = X.z, m01 = Y.x, m11 = Y.y, m21 = Y.z, m02 = Z.x, m12 = Z.y, m22 = Z.z;
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      this.w = 0.25 / s; this.x = (m21 - m12) * s; this.y = (m02 - m20) * s; this.z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = 0.25 * s; this.y = (m01 + m10) / s; this.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      this.w = (m02 - m20) / s; this.x = (m01 + m10) / s; this.y = 0.25 * s; this.z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      this.w = (m10 - m01) / s; this.x = (m02 + m20) / s; this.y = (m12 + m21) / s; this.z = 0.25 * s;
    }
    return this.normalize();
  }
  /**
   * Shortest-arc rotation taking unit vector a to unit vector b.
   * @param {V3} a @param {V3} b
   */
  setFromUnitVectors(a, b) {
    let r = a.x * b.x + a.y * b.y + a.z * b.z + 1;
    if (r < 1e-8) {
      // opposite: any perpendicular axis
      r = 0;
      if (Math.abs(a.x) > Math.abs(a.z)) this.set(-a.y, a.x, 0, r); else this.set(0, -a.z, a.y, r);
    } else {
      this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, r);
    }
    return this.normalize();
  }
  /**
   * Spherical interpolation from a to b (shortest path). this may alias a or b.
   * @param {Q} a @param {Q} b @param {number} t
   */
  slerp(a, b, t) {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let c = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let ka = 1 - t, kb = t;
    if (c < 0.9995) {
      const th = Math.acos(c), s = Math.sin(th);
      ka = Math.sin((1 - t) * th) / s;
      kb = Math.sin(t * th) / s;
    }
    this.x = a.x * ka + bx * kb; this.y = a.y * ka + by * kb; this.z = a.z * ka + bz * kb; this.w = a.w * ka + bw * kb;
    return this.normalize();
  }
  /**
   * Rotation angle (rad) of this quaternion's twist about the unit axis (ax, ay, az),
   * in (−π, π]: the swing–twist decomposition's twist.
   */
  twistAngle(ax, ay, az) {
    const p = this.x * ax + this.y * ay + this.z * az;
    let a = 2 * Math.atan2(p, this.w);
    if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
}

/**
 * Rotation R with R·aFrom = aTo and R·bFrom ≈ bTo (b re-orthogonalised against a).
 * Uses the scratch vectors passed in, so it allocates nothing.
 * @param {Q} out
 * @param {V3} aFrom unit @param {V3} bFrom
 * @param {V3} aTo unit @param {V3} bTo
 * @param {V3[]} s at least 6 scratch vectors
 */
export function rotationBetweenFrames(out, aFrom, bFrom, aTo, bTo, s) {
  const b1 = s[0].copy(bFrom).rejectFrom(aFrom).normalize(), c1 = s[1].cross(aFrom, b1);
  const b2 = s[2].copy(bTo).rejectFrom(aTo).normalize(), c2 = s[3].cross(aTo, b2);
  // R = B2 · B1ᵀ, built column by column: R·e_k = a2·a1_k + b2·b1_k + c2·c1_k
  const X = s[4].set(aTo.x * aFrom.x + b2.x * b1.x + c2.x * c1.x, aTo.y * aFrom.x + b2.y * b1.x + c2.y * c1.x, aTo.z * aFrom.x + b2.z * b1.x + c2.z * c1.x);
  const Y = s[5].set(aTo.x * aFrom.y + b2.x * b1.y + c2.x * c1.y, aTo.y * aFrom.y + b2.y * b1.y + c2.y * c1.y, aTo.z * aFrom.y + b2.z * b1.y + c2.z * c1.y);
  // Z column = X × Y for a proper rotation; reuse s[0] (b1 is no longer needed).
  const Z = s[0].cross(X, Y);
  return out.setFromBasis(X, Y, Z);
}

/** Wrap an angle to (−π, π]. @param {number} a */
export function wrapAngle(a) {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI; else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** @param {number} x @param {number} lo @param {number} hi */
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Smoothstep on [0, 1]. @param {number} t */
export const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * xorshift32 PRNG in [0, 1). Deterministic per seed; allocation-free
 * (Math.random refills its cache with garbage in V8).
 */
export class Rng {
  /** @param {number} [seed] */
  constructor(seed = 0x9e3779b9) { this.s = (seed >>> 0) || 1; }
  next() {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
  /** @param {number} a @param {number} b */
  range(a, b) { return a + (b - a) * this.next(); }
}
