// @ts-check
/**
 * Hip yaw, pelvis and gear sockets estimated from the head and the two
 * controllers (pure: no three.js, no DOM; docs/PLAN.md §8, CONTRACTS.md "W2").
 *
 * There is no hip tracker. The estimator follows the head past a dead zone,
 * freezes while you look down at your belt (so the holster does not run from
 * your hand), lets raised hands vote where the chest faces, and hangs the
 * pelvis from the eyes through a neck chain. The tuning numbers are CQC's
 * tested ones (values only, no code): heading, freeze, dead zone and catch-up
 * (CQC BHEAD / CONFIG.body), the hands vote (bodyHandsFacing), the neck chain
 * (atlas, C7, torso length), the +8 cm body-forward offset (CQC-LOG step 98)
 * and the holster socket (SLOT_HOLSTER, CQC 2.35 "mid ride").
 *
 * Frames. World = the XR reference space, +Y up. A yaw ψ faces
 * (−sin ψ, 0, −cos ψ), so ψ = 0 faces −Z, as three's rotation.y. The body
 * frame is x = right, y = up, z = back, scaled by s = standEye / 1.70.
 *
 * Outputs (all smoothed with a critically damped filter, so what you see is
 * what you grab):
 * - `holster`: the pistol's palm point and its orientation in the right-hip
 *   holster (muzzle down, canted 12° to the rear, PLAN §8);
 * - `pouch`: the magazine's top point in the left-hip pouch, upright frame;
 * - `back`: the rifle's palm point slung on the back behind the right
 *   shoulder (muzzle down to the left, ejection port out) and `backAxis`, the
 *   unit vector from the grip toward the butt (the grab capsule over the
 *   shoulder);
 * - `thighs`: hip and knee points of both thighs (the draw's trigger gate).
 *
 * Usage, once per frame (allocation-free; inputs are objects, so no double is
 * boxed at the call):
 *   est.setHead(eye, quat);                   // { x, y, z }, { x, y, z, w }
 *   est.setHand(0, ok, leftPos, false); est.setHand(1, ok, rightPos, holdsGun);
 *   est.update(dt, player);                   // { floorY, standEye }
 */

/** Tuning (CQC values unless marked design). Lengths are × body scale. */
export const BODY_EST = Object.freeze({
  refEye: 1.70,
  // heading (CQC BHEAD)
  freezeFrom: 0.68, freezeTo: 0.90,     // rad pitch down: freeze from 39°, full at 52°
  upWeight: 1.0,                        // flattened head-up vector against the flattened forward
  tauAhead: 0.045, tauDown: 0.16,       // s heading smoothing
  dead: 0.75, deadFrozenAdd: 1.3,       // rad the head turns before the hips follow (0.75 → 2.05 frozen)
  catchUp: 5, catchUpFrozen: 1.2,       // rad/s past the dead zone
  settle: 0.7,                          // 1/s the hips settle back under the head
  settleWalk: 3,                        // extra 1/s per m/s of pelvis speed
  settleFrozenK: 0.04,                  // settle × this when frozen
  walkFreezeK: 0.6, walkFreezeSpeed: 0.8,
  // raised hands vote (CQC bodyHandsFacing)
  handsGain: 0.7, chestGain: 0.25, gunHandK: 1.25, handsRate: 10, voteSum: 1.1,
  voteDropOut: 0.62, voteDropIn: 0.38,   // hand below the eyes (× s): full vote above 0.38, none below 0.62
  reachDropOut: 0.56, reachDropIn: 0.44, // a hand down at the belt never votes
  voteNear: 0.16, voteFar: 0.30,         // horizontal reach (× s)
  voteAngOut: 1.7, voteAngIn: 1.2,       // rad off the heading
  // neck chain (CQC bodyPre)
  atlas: Object.freeze([0, -0.07, 0.085]),
  neckPitchK: 0.5, neckPitchMin: -0.6, neckPitchMax: 0.3, neckRate: 9,
  c7: Object.freeze([0, -0.12, 0.02]),
  bodyFwd: 0.08,                         // CQC step 98: the body 8 cm ahead (holster in view at ~45° nod)
  torso: 0.585, pelvisBack: 0.03,
  leanCrouchK: 0.85, leanCrouchMax: 0.7, leanLookFrom: 0.35, leanLookMax: 0.8, leanLookK: 0.12, leanRate: 6,
  pelvisMinAboveFloor: 0.3,
  chestFollow: 0.4, chestMax: 0.8,
  // sockets (body frame: x right, y up, z back; × s)
  holster: Object.freeze([0.212, 0.095, 0.02]),   // CQC SLOT_HOLSTER (palm point) relative to the pelvis
  holsterCant: 0.21,                              // rad muzzle to the rear (PLAN §8: 10–15°)
  holsterRoll: 0.05,                              // rad about the bore, along the hip (CQC SLOT_ROT)
  pouch: Object.freeze([-0.16, 0.12, -0.06]),     // magazine top, front of the weak-side hip (design)
  back: Object.freeze([0.15, -0.07, 0.17]),       // rifle palm point behind the right shoulder blade, from C7 (design)
  backMuzzle: Object.freeze([-0.45, -0.89, 0]),   // muzzle down to the left (design)
  hipJoint: 0.09, thigh: 0.43, kneeFwd: 0.05,
  omega: 30,                                      // 1/s output smoothing: 63 % in ~70 ms (PLAN §8: 60–100 ms)
  maxStep: 0.008,                                 // s filter sub-step
});

const TAU = Math.PI * 2;

/** @param {number} a */
export function wrap(a) {
  if (!Number.isFinite(a)) return 0;
  a %= TAU;
  if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU;
  return a;
}

/**
 * Hermite smoothstep; a > b gives the falling edge (1 for x ≤ b, 0 for x ≥ a).
 * @param {number} a @param {number} b @param {number} x
 */
export function smooth(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** @param {number} v @param {number} a @param {number} b */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * out = q · v (v at out[o..o+2]).
 * @param {ArrayLike<number>} q @param {number} x @param {number} y @param {number} z
 * @param {Float64Array} out @param {number} o
 */
export function qRotate(q, x, y, z, out, o) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  out[o] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out[o + 1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out[o + 2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

/**
 * out = a · b (Hamilton product, [x, y, z, w]).
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {Float64Array} out
 */
export function qMul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** @param {number} yaw @param {Float64Array} out */
export function qYaw(yaw, out) {
  out[0] = 0; out[1] = Math.sin(yaw / 2); out[2] = 0; out[3] = Math.cos(yaw / 2);
}

/**
 * Euler order 'YXZ' (yaw, then pitch, then roll), as three.js.
 * @param {number} x @param {number} y @param {number} z @param {Float64Array} out
 */
export function qEulerYXZ(x, y, z, out) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 - s1 * s2 * c3;
  out[3] = c1 * c2 * c3 + s1 * s2 * s3;
}

/**
 * Quaternion from an orthonormal basis (columns X, Y, Z).
 * @param {number[]} X @param {number[]} Y @param {number[]} Z @param {Float64Array} out
 */
export function qBasis(X, Y, Z, out) {
  const m11 = X[0], m12 = Y[0], m13 = Z[0], m21 = X[1], m22 = Y[1], m23 = Z[1], m31 = X[2], m32 = Y[2], m33 = Z[2];
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out[3] = 0.25 / s; out[0] = (m32 - m23) * s; out[1] = (m13 - m31) * s; out[2] = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    out[3] = (m32 - m23) / s; out[0] = 0.25 * s; out[1] = (m12 + m21) / s; out[2] = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    out[3] = (m13 - m31) / s; out[0] = (m12 + m21) / s; out[1] = 0.25 * s; out[2] = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    out[3] = (m21 - m12) / s; out[0] = (m13 + m31) / s; out[1] = (m23 + m32) / s; out[2] = 0.25 * s;
  }
}

/** A world pose: position and orientation. */
function pose() { return { p: new Float64Array(3), q: new Float64Array([0, 0, 0, 1]) }; }

export class BodyEstimator {
  /**
   * @param {{ holsterUp?: number, holsterFwd?: number, holsterOut?: number }} [o]
   *   player offsets of the holster in metres (PLAN §8 settings: height ±0.15, forward/back ±0.10, outward ±0.05)
   */
  constructor(o = {}) {
    this.holsterUp = o.holsterUp ?? 0;
    this.holsterFwd = o.holsterFwd ?? 0;
    this.holsterOut = o.holsterOut ?? 0;

    // inputs
    this._head = new Float64Array(7);
    this._hq = new Float64Array([0, 0, 0, 1]);
    this._hand = new Float64Array(8);           // x, y, z, ok per hand (0 left, 1 right)
    this._gun = [false, false];
    this._headSet = false;

    // state
    this.valid = false;
    this.yaw = 0;          // hips (raw)
    this.chestYaw = 0;
    this.heading = 0;      // smoothed head heading
    this.freeze = 0;
    this.handConf = 0;
    this.handYaw = 0;
    this.neckPitch = 0;
    this.lean = 0;
    this.speed = 0;
    this.scale = 1;
    this.pelvis = new Float64Array(3);
    this.c7 = new Float64Array(3);
    this._lastP = new Float64Array(3);
    this._vel = new Float64Array(2);

    // smoothed frame (critically damped): pelvis xyz, C7 xyz, hip yaw, chest yaw
    this._ft = new Float64Array(8);   // targets
    this._fx = new Float64Array(8);   // values
    this._fv = new Float64Array(8);   // rates
    this.holster = pose();
    this.pouch = pose();
    this.back = pose();
    this.backAxis = new Float64Array(3);
    /** Hip L, knee L, hip R, knee R (x, y, z each). */
    this.thighs = new Float64Array(12);
    /** Smoothed pelvis and yaw the sockets hang from. */
    this.pelvisS = new Float64Array(3);
    this.yawS = 0;

    // scratch: working scalars (dt, floor, stand eye, scale, pitch down, pitch, forward xyz, up x z,
    // hip and chest targets) and vectors
    this._w = new Float64Array(16);
    this._first = true;
    this._v = new Float64Array(6);
    this._q = new Float64Array(4);
    this._q2 = new Float64Array(4);
    this._qHolster = new Float64Array(4);
    this._qBack = new Float64Array(4);
    this._recomputeLocal();
  }

  /** Socket orientations in the body frame (fixed). */
  _recomputeLocal() {
    const B = BODY_EST;
    qEulerYXZ(-Math.PI / 2 - B.holsterCant, 0, B.holsterRoll, this._qHolster);
    const m = B.backMuzzle, n = Math.hypot(m[0], m[1], m[2]);
    const Z = [-m[0] / n, -m[1] / n, -m[2] / n];           // gun +Z (toward the butt)
    const X = [0, 0, 1];                                   // ejection side out of the back
    const Y = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];   // Y = Z × X
    qBasis(X, Y, Z, this._qBack);
  }

  /** Forget the body (new session, reference-space reset). */
  reset() {
    this.valid = false;
    this._headSet = false;
    this.freeze = 0;
    this.handConf = 0;
    this.speed = 0;
    this._vel[0] = this._vel[1] = 0;
  }

  /**
   * Head pose this frame: eye midpoint and orientation.
   * @param {{ x: number, y: number, z: number }} p @param {{ x: number, y: number, z: number, w: number }} r
   */
  setHead(p, r) {
    const px = p.x, py = p.y, pz = p.z, qx = r.x, qy = r.y, qz = r.z, qw = r.w;
    const h = this._head;
    h[0] = px; h[1] = py; h[2] = pz; h[3] = qx; h[4] = qy; h[5] = qz; h[6] = qw;
    const q = this._hq;
    q[0] = qx; q[1] = qy; q[2] = qz; q[3] = qw;
    this._headSet = Number.isFinite(px + py + pz + qx + qy + qz + qw) && !(px === 0 && py === 0 && pz === 0);
  }

  /**
   * @param {number} i 0 = left, 1 = right
   * @param {boolean} ok tracked this frame
   * @param {{ x: number, y: number, z: number } | null} p grip position
   * @param {boolean} holdsGun
   */
  setHand(i, ok, p, holdsGun) {
    const o = i * 4, h = this._hand;
    const x = p ? p.x : 0, y = p ? p.y : 0, z = p ? p.z : 0;
    const good = ok && !!p && Number.isFinite(x + y + z);
    h[o] = good ? x : 0; h[o + 1] = good ? y : 0; h[o + 2] = good ? z : 0; h[o + 3] = good ? 1 : 0;
    this._gun[i] = holdsGun;
  }

  /**
   * @param {number} dt seconds
   * @param {{ floorY: number, standEye: number } | null} ref floor height and calibrated standing
   *   eye height above it (the Player has both)
   */
  update(dt, ref) {
    if (!this._headSet) return;
    // Every step below is a small method that reads and writes fields and typed arrays only:
    // no double crosses a call, so nothing is boxed even where V8 does not inline.
    const W = this._w;
    W[0] = dt >= 0 ? (dt > 0.25 ? 0.25 : dt) : 0;
    const fy = ref ? ref.floorY : 0, se = ref ? ref.standEye : 1.65;
    W[1] = Number.isFinite(fy) ? fy : 0;
    W[2] = se > 0.5 && se < 2.5 ? se : 1.65;
    W[3] = W[2] / BODY_EST.refEye;
    this.scale = W[3];
    this._first = !this.valid;
    this._axes();
    this._headingStep();
    this._vote();
    this._hips();
    this._chain();
    this._speedStep();
    this._frame();
    this._sockets();
    this.valid = true;
  }

  /** Head axes: forward (0,0,−1) and up (0,1,0) rotated by the head quaternion; pitch. */
  _axes() {
    const H = this._head, W = this._w;
    const qx = H[3], qy = H[4], qz = H[5], qw = H[6];
    W[6] = -2 * (qx * qz + qw * qy);
    W[7] = 2 * (qw * qx - qy * qz);
    W[8] = -(1 - 2 * (qx * qx + qy * qy));
    W[9] = 2 * (qx * qy - qw * qz);
    W[10] = 2 * (qy * qz + qw * qx);
    const sp = clamp(-W[7], -1, 1);
    W[4] = Math.asin(sp);       // pitch down
    W[5] = -W[4];               // pitch (+ up)
  }

  /** 1. A heading that holds while looking down: forward + up · sign(pitch down), flattened; the freeze. */
  _headingStep() {
    const B = BODY_EST, W = this._w, dt = W[0];
    const sp = -W[7], k = B.upWeight * (sp > 0 ? 1 : sp < 0 ? -1 : 0);
    const hx = W[6] + W[9] * k, hz = W[8] + W[10] * k;
    const raw = hx * hx + hz * hz > 1e-12 ? Math.atan2(-hx, -hz) : this.heading;
    let frz = smooth(B.freezeFrom, B.freezeTo, W[4]);
    frz *= 1 - B.walkFreezeK * clamp(this.speed / B.walkFreezeSpeed, 0, 1);
    this.freeze = frz;
    if (this._first) this.heading = raw;
    const tau = B.tauAhead + (B.tauDown - B.tauAhead) * frz;
    this.heading = wrap(this.heading + wrap(raw - this.heading) * (1 - Math.exp(-dt / tau)));
  }

  /** 2. Raised hands in front say where the chest faces (never while looking down or reaching low). */
  _vote() {
    const B = BODY_EST, W = this._w, H = this._head, h = this._hand, dt = W[0], s = W[3], hh = this.heading, frz = this.freeze;
    let sx = 0, cx = 0, wt = 0;
    for (let i = 0; i < 2; i++) {
      const o = i * 4;
      if (!h[o + 3]) continue;
      const dx = h[o] - H[0], dz = h[o + 2] - H[2], drop = H[1] - h[o + 1];
      const d = wrap(Math.atan2(-dx, -dz) - hh);
      let w = smooth(B.voteDropOut * s, B.voteDropIn * s, drop) * smooth(B.voteNear * s, B.voteFar * s, Math.sqrt(dx * dx + dz * dz))
        * smooth(B.voteAngOut, B.voteAngIn, Math.abs(d));
      w *= (1 - frz) * smooth(B.reachDropOut * s, B.reachDropIn * s, drop);
      if (!(w > 0)) continue;
      if (this._gun[i]) w = Math.min(1, w * B.gunHandK);
      sx += w * Math.sin(d); cx += w * Math.cos(d); wt += w;
    }
    const kh = 1 - Math.exp(-dt * B.handsRate);
    if (this._first) { this.handConf = 0; this.handYaw = hh; }
    this.handConf += (Math.min(1, wt / B.voteSum) - this.handConf) * kh;
    const haT = wt > 1e-3 ? hh + Math.atan2(sx, cx) : hh;
    this.handYaw = wrap(this.handYaw + wrap(haT - this.handYaw) * kh);
    const hOff = wrap(this.handYaw - hh) * this.handConf;
    W[11] = hh + hOff * B.handsGain;                                   // where the hips aim
    W[12] = hh + hOff * Math.min(1, B.handsGain + B.chestGain);        // where the chest aims
  }

  /** 3. Hips: dead zone, capped catch-up, slow settle; nearly frozen while looking down. */
  _hips() {
    const B = BODY_EST, W = this._w, dt = W[0], frz = this.freeze, fYaw = W[11];
    if (this._first) this.yaw = wrap(fYaw);
    let dYaw = wrap(fYaw - this.yaw);
    const dead = B.dead + B.deadFrozenAdd * frz, ex = Math.abs(dYaw) - dead;
    if (ex > 0) {
      const st = Math.min(ex, (B.catchUp + (B.catchUpFrozen - B.catchUp) * frz) * dt) * (dYaw > 0 ? 1 : -1);
      this.yaw = wrap(this.yaw + st);
      dYaw -= st;
    }
    dYaw = clamp(dYaw, -dead, dead);
    const rate = (B.settle + this.speed * B.settleWalk) * (1 - (1 - B.settleFrozenK) * frz);
    this.yaw = wrap(this.yaw + dYaw * (1 - Math.exp(-dt * rate)));
    const yaw = this.yaw;
    this.chestYaw = wrap(yaw + clamp(wrap(W[12] - yaw), -B.chestMax, B.chestMax) * (B.chestFollow + B.chestGain * this.handConf));
  }

  /** 4. Neck chain: eyes → atlas → C7 (half the nod), body 8 cm forward, torso down to the pelvis. */
  _chain() {
    const B = BODY_EST, W = this._w, H = this._head, v = this._v, dt = W[0], s = W[3], floorY = W[1], hPitch = W[5];
    qRotate(this._hq, B.atlas[0] * s, B.atlas[1] * s, B.atlas[2] * s, v, 0);
    const ax = H[0] + v[0], ay = H[1] + v[1], az = H[2] + v[2];
    const npT = clamp(hPitch * B.neckPitchK, B.neckPitchMin, B.neckPitchMax);
    this.neckPitch = this._first ? npT : this.neckPitch + (npT - this.neckPitch) * (1 - Math.exp(-dt * B.neckRate));
    qEulerYXZ(this.neckPitch, this.chestYaw, 0, this._q);
    qRotate(this._q, B.c7[0] * s, B.c7[1] * s, B.c7[2] * s, v, 0);
    const yaw = this.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const C = this.c7;
    C[0] = ax + v[0] - sy * B.bodyFwd * s; C[1] = ay + v[1]; C[2] = az + v[2] - cy * B.bodyFwd * s;
    const drop = Math.max(0, W[2] - (H[1] - floorY));
    const leanT = clamp(drop * B.leanCrouchK, 0, B.leanCrouchMax) + clamp(-hPitch - B.leanLookFrom, 0, B.leanLookMax) * B.leanLookK;
    this.lean = this._first ? leanT : this.lean + (leanT - this.lean) * (1 - Math.exp(-dt * B.leanRate));
    const Lt = B.torso * s, ly = -Lt * Math.cos(this.lean), lz = Lt * Math.sin(this.lean) - B.pelvisBack * s;
    const P = this.pelvis;
    P[0] = C[0] + sy * lz; P[1] = Math.max(C[1] + ly, floorY + B.pelvisMinAboveFloor); P[2] = C[2] + cy * lz;
  }

  /** Pelvis speed (walking eases the freeze and speeds the settle). */
  _speedStep() {
    const P = this.pelvis, L = this._lastP, V = this._vel, dt = this._w[0];
    if (!this._first && dt > 0) {
      let vx = (P[0] - L[0]) / dt, vz = (P[2] - L[2]) / dt;
      if (vx * vx + vz * vz > 36) vx = vz = 0;               // a jump in tracking, not a walk
      const kv = 1 - Math.exp(-dt * 8);
      V[0] += (vx - V[0]) * kv; V[1] += (vz - V[1]) * kv;
      this.speed = Math.sqrt(V[0] * V[0] + V[1] * V[1]);
    }
    L[0] = P[0]; L[1] = P[1]; L[2] = P[2];
  }

  /** 5. The smoothed frame the sockets hang from: critically damped pelvis, C7, hip and chest yaw. */
  _frame() {
    const T = this._ft, X = this._fx, V = this._fv, P = this.pelvis, C = this.c7, dt = this._w[0];
    T[0] = P[0]; T[1] = P[1]; T[2] = P[2]; T[3] = C[0]; T[4] = C[1]; T[5] = C[2]; T[6] = this.yaw; T[7] = this.chestYaw;
    if (this._first) { for (let i = 0; i < 8; i++) { X[i] = T[i]; V[i] = 0; } } else {
      const w = BODY_EST.omega, w2 = w * w, c = 2 * w;
      const n = Math.max(1, Math.ceil(dt / BODY_EST.maxStep)), h = dt / n;
      for (let k = 0; k < n; k++) {
        for (let i = 0; i < 8; i++) {
          let e = T[i] - X[i];
          if (i >= 6) e = wrap(e);
          V[i] += (w2 * e - c * V[i]) * h;
          X[i] += V[i] * h;
        }
      }
      X[6] = wrap(X[6]);
      X[7] = wrap(X[7]);
    }
    const pS = this.pelvisS;
    pS[0] = X[0]; pS[1] = X[1]; pS[2] = X[2];
    this.yawS = X[6];
  }

  /** Holster, pouch, thighs and back from the smoothed frame. */
  _sockets() {
    const B = BODY_EST, pS = this.pelvisS, q = this._q, v = this._v, s = this._w[3];
    qYaw(this.yawS, q);
    // holster (palm point + pistol orientation)
    const hp = B.holster;
    qRotate(q, hp[0] * s + this.holsterOut, hp[1] * s + this.holsterUp, hp[2] * s - this.holsterFwd, v, 0);
    const Hs = this.holster;
    Hs.p[0] = pS[0] + v[0]; Hs.p[1] = pS[1] + v[1]; Hs.p[2] = pS[2] + v[2];
    qMul(q, this._qHolster, Hs.q);
    // pouch (magazine top, upright body frame)
    const pp = B.pouch;
    qRotate(q, pp[0] * s, pp[1] * s, pp[2] * s, v, 0);
    const Ps = this.pouch;
    Ps.p[0] = pS[0] + v[0]; Ps.p[1] = pS[1] + v[1]; Ps.p[2] = pS[2] + v[2];
    Ps.q[0] = q[0]; Ps.q[1] = q[1]; Ps.q[2] = q[2]; Ps.q[3] = q[3];
    // thighs
    const T = this.thighs, cy = Math.cos(this.yawS), sy = Math.sin(this.yawS);
    for (let side = 0; side < 2; side++) {
      const sd = side ? 1 : -1, o = side * 6;
      T[o] = pS[0] + cy * B.hipJoint * s * sd; T[o + 1] = pS[1]; T[o + 2] = pS[2] - sy * B.hipJoint * s * sd;
      T[o + 3] = T[o] - sy * B.kneeFwd * s; T[o + 4] = pS[1] - B.thigh * s; T[o + 5] = T[o + 2] - cy * B.kneeFwd * s;
    }
    // back (rifle palm point behind the right shoulder; chest frame)
    const fx = this._fx;
    qYaw(fx[7], this._q2);
    const bp = B.back, Bk = this.back;
    qRotate(this._q2, bp[0] * s, bp[1] * s, bp[2] * s, v, 0);
    Bk.p[0] = fx[3] + v[0]; Bk.p[1] = fx[4] + v[1]; Bk.p[2] = fx[5] + v[2];
    qMul(this._q2, this._qBack, Bk.q);
    qRotate(Bk.q, 0, 0, 1, this.backAxis, 0);
  }
}
