// @ts-check
/**
 * Hit capsules per body part, placed from the solved bone transforms (pure;
 * allocation-free after construction).
 *
 * 18 capsules: head, neck, abdomen, chest, shoulders, pelvis (parts 'head',
 * 'neck', 'torso', 'pelvis'), and upper arm, forearm, hand, thigh, calf, foot
 * on both sides ('limb'). Sizes were measured from the soldier mesh: the
 * vertices each joint carries, in the rest pose (tools: gltf-transform), and
 * kept a little inside the cloth so a grazing round does not count.
 *
 * Capsule ends are stored in their bone's rest-local frame, so a pose costs
 * one rotation per end: p = jointPos + jointRot · local. World ends come from
 * the instance root (x, floor y, z, yaw).
 */

import { B } from './Rig.js';
import { V3 } from './math.js';

export const PARTS = /** @type {const} */ (['head', 'neck', 'torso', 'pelvis', 'limb']);
export const PART_HEAD = 0, PART_NECK = 1, PART_TORSO = 2, PART_PELVIS = 3, PART_LIMB = 4;
/** Culling / quick-reject sphere round the pelvis (covers the body in any pose). */
export const REACH = 1.25;

/**
 * Capsule table: bone, two ends as offsets in the REST MODEL frame from the
 * joint (or a joint name for "up to that joint"), radius, part.
 * @typedef {{ bone: number, a: number[], b: number[] | number, r: number, part: number }} CapsuleSpec
 * @type {CapsuleSpec[]}
 */
const SPECS = [
  { bone: B.head, a: [0, 0.03, 0.035], b: [0, 0.12, 0.025], r: 0.1, part: PART_HEAD },
  { bone: B.neck, a: [0, -0.005, 0.015], b: B.head, r: 0.062, part: PART_NECK },
  { bone: B.spine1, a: [0, 0.05, 0.01], b: B.spine2, r: 0.145, part: PART_TORSO },
  { bone: B.spine3, a: [0, -0.1, 0.0], b: [0, 0.06, -0.01], r: 0.15, part: PART_TORSO },
  { bone: B.spine3, a: [-0.12, 0.06, -0.02], b: [0.12, 0.06, -0.02], r: 0.1, part: PART_TORSO },
  { bone: B.pelvis, a: [-0.085, -0.05, 0], b: [0.085, -0.05, 0], r: 0.135, part: PART_PELVIS },
  { bone: B.upperArmL, a: [0, 0, 0], b: B.lowerArmL, r: 0.06, part: PART_LIMB },
  { bone: B.lowerArmL, a: [0, 0, 0], b: B.handL, r: 0.05, part: PART_LIMB },
  { bone: B.handL, a: [0, 0, 0], b: -1, r: 0.045, part: PART_LIMB },
  { bone: B.upperArmR, a: [0, 0, 0], b: B.lowerArmR, r: 0.06, part: PART_LIMB },
  { bone: B.lowerArmR, a: [0, 0, 0], b: B.handR, r: 0.05, part: PART_LIMB },
  { bone: B.handR, a: [0, 0, 0], b: -1, r: 0.045, part: PART_LIMB },
  { bone: B.thighL, a: [0, -0.02, 0], b: B.calfL, r: 0.09, part: PART_LIMB },
  { bone: B.calfL, a: [0, 0, 0], b: B.footL, r: 0.065, part: PART_LIMB },
  { bone: B.footL, a: [0, -0.04, -0.04], b: -2, r: 0.05, part: PART_LIMB },
  { bone: B.thighR, a: [0, -0.02, 0], b: B.calfR, r: 0.09, part: PART_LIMB },
  { bone: B.calfR, a: [0, 0, 0], b: B.footR, r: 0.065, part: PART_LIMB },
  { bone: B.footR, a: [0, -0.04, -0.04], b: -2, r: 0.05, part: PART_LIMB },
];

/**
 * Shared capsule definition for a rig (built once).
 */
export class CapsuleSet {
  /** @param {import('./Rig.js').RigDef} def */
  constructor(def) {
    const n = SPECS.length;
    this.count = n;
    this.bone = new Int8Array(n);
    this.part = new Uint8Array(n);
    this.radius = new Float32Array(n);
    /** Ends in the bone's rest-local frame. */
    this.la = new Float64Array(n * 3);
    this.lb = new Float64Array(n * 3);
    const P = def.restModelP, v = new V3();
    for (let i = 0; i < n; i++) {
      const s = SPECS[i];
      this.bone[i] = s.bone;
      this.part[i] = s.part;
      this.radius[i] = s.r;
      const q = def.restModelQ[s.bone];
      v.set(s.a[0], s.a[1], s.a[2]).applyQInv(q);
      this.la[i * 3] = v.x; this.la[i * 3 + 1] = v.y; this.la[i * 3 + 2] = v.z;
      if (Array.isArray(s.b)) v.set(s.b[0], s.b[1], s.b[2]);
      else if (s.b === -1) v.copy(def.handF[s.bone === B.handL ? 0 : 1]).scale(0.085); // hand: wrist → knuckles
      else if (s.b === -2) v.copy(def.ballOffset).add(new V3(0, 0, 0.05)); // foot: ankle → past the ball
      else v.subVectors(P[s.b], P[s.bone]);
      v.applyQInv(q);
      this.lb[i * 3] = v.x; this.lb[i * 3 + 1] = v.y; this.lb[i * 3 + 2] = v.z;
    }
  }
}

/**
 * Ray against a capsule (segment a–b, radius r). Direction must be unit length.
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} ax @param {number} ay @param {number} az
 * @param {number} bx @param {number} by @param {number} bz
 * @param {number} r
 * @returns {number} entry distance ≥ 0, or −1 for a miss (also when the origin is inside)
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  if (A > 1e-12) {
    const Bq = baba * rdoa - baoa * bard;
    const C = baba * oaoa - baoa * baoa - r * r * baba;
    const h = Bq * Bq - A * C;
    if (h < 0) return -1;
    const t = (-Bq - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;
  }
  // end caps: the sphere at the end nearer along the axis (or both when parallel)
  let best = -1;
  for (let k = 0; k < 2; k++) {
    const cx = k === 0 ? ax : bx, cy = k === 0 ? ay : by, cz = k === 0 ? az : bz;
    const ocx = ox - cx, ocy = oy - cy, ocz = oz - cz;
    const b = dx * ocx + dy * ocy + dz * ocz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    const h = b * b - c;
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/**
 * Ray against a sphere: the entry distance, or 0 when the origin is inside
 * (so a quick reject never drops a ray that starts within the sphere).
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} cx @param {number} cy @param {number} cz
 * @param {number} r
 * @returns {number} −1 on a miss
 */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ocx = ox - cx, ocy = oy - cy, ocz = oz - cz;
  const b = dx * ocx + dy * ocy + dz * ocz;
  const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  if (-b + s < 0) return -1;
  return -b - s > 0 ? -b - s : 0;
}

/** World-space capsules of one enemy. */
export class Hitbox {
  /** @param {CapsuleSet} set */
  constructor(set) {
    this.set = set;
    const n = set.count;
    /** World ends. */
    this.a = new Float64Array(n * 3);
    this.b = new Float64Array(n * 3);
    /** Quick-reject sphere (world). */
    this.cx = 0; this.cy = -100; this.cz = 0;
    /** Body scale (v0.4.1: the soldier's height / the model's), applied to the ends and the radii. */
    this.k = 1;
    this.valid = false;
    // last hit
    this.hitIndex = -1;
    this.hitPart = -1;
    this.nx = 0; this.ny = 0; this.nz = 0;
    this._p = new V3();
  }

  /**
   * Place the capsules from a solved pose and its root.
   * The pose's scale (`pose.k`, the animator's) sizes the capsules too.
   * @param {{ mp: V3[], mq: import('./math.js').Q[], rootX: number, rootY: number, rootZ: number, rootYaw: number, k?: number }} pose
   */
  update(pose) {
    const S = this.set, n = S.count, p = this._p;
    const k = pose.k !== undefined && pose.k > 0 ? pose.k : 1;
    this.k = k;
    const c = Math.cos(pose.rootYaw) * k, s = Math.sin(pose.rootYaw) * k, X = pose.rootX, Y = pose.rootY, Z = pose.rootZ;
    for (let i = 0; i < n; i++) {
      const bone = S.bone[i], q = pose.mq[bone], j = pose.mp[bone], o = i * 3;
      for (let e = 0; e < 2; e++) {
        const L = e === 0 ? S.la : S.lb, out = e === 0 ? this.a : this.b;
        p.set(L[o], L[o + 1], L[o + 2]).applyQ(q).add(j);
        out[o] = X + p.x * c + p.z * s;
        out[o + 1] = Y + p.y * k;
        out[o + 2] = Z - p.x * s + p.z * c;
      }
    }
    const pv = pose.mp[B.pelvis];
    this.cx = X + pv.x * c + pv.z * s;
    this.cy = Y + pv.y * k;
    this.cz = Z - pv.x * s + pv.z * c;
    this.valid = true;
  }

  /**
   * Nearest capsule hit within `max`. Direction must be unit length. On a hit
   * sets hitIndex, hitPart and the surface normal (nx, ny, nz).
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {number} max
   * @returns {number} distance, or −1
   */
  raycast(ox, oy, oz, dx, dy, dz, max) {
    if (!this.valid) return -1;
    const k = this.k;
    const ts = raySphere(ox, oy, oz, dx, dy, dz, this.cx, this.cy, this.cz, REACH * k);
    if (ts < 0 || ts > max) return -1;
    const S = this.set, A = this.a, Bv = this.b;
    let best = max, bi = -1;
    for (let i = 0; i < S.count; i++) {
      const o = i * 3;
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, A[o], A[o + 1], A[o + 2], Bv[o], Bv[o + 1], Bv[o + 2], S.radius[i] * k);
      if (t >= 0 && t < best) { best = t; bi = i; }
    }
    if (bi < 0) return -1;
    this.hitIndex = bi;
    this.hitPart = S.part[bi];
    // normal: from the closest point on the axis to the hit point
    const o = bi * 3;
    const px = ox + dx * best, py = oy + dy * best, pz = oz + dz * best;
    const ax = A[o], ay = A[o + 1], az = A[o + 2], bx = Bv[o] - ax, by = Bv[o + 1] - ay, bz = Bv[o + 2] - az;
    const bb = bx * bx + by * by + bz * bz;
    let u = bb > 1e-12 ? ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / bb : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    let nx = px - (ax + bx * u), ny = py - (ay + by * u), nz = pz - (az + bz * u);
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-9) { nx /= l; ny /= l; nz /= l; } else { nx = -dx; ny = -dy; nz = -dz; }
    this.nx = nx; this.ny = ny; this.nz = nz;
    return best;
  }

  /** Capsule i is on a leg (thigh, calf or foot). @param {number} i */
  isLeg(i) { return i >= 12; }
}
