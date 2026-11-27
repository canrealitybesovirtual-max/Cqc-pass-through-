// @ts-check
/**
 * Procedural animation for one soldier (pure: no three.js; allocation-free
 * after construction). The GLB has no clips, so every frame is built from
 * layers (CONTRACTS.md "Enemies"):
 *
 * 1. Locomotion. A stepping gait in WORLD space: each foot is planted where it
 *    landed and never slides; it lifts when the gait phase reaches its window
 *    and lands half a step ahead of where the hips will be (so the feet keep
 *    up at any speed and direction, turning in place included). Step length
 *    and cadence scale with speed. Heel strike, a roll onto the ball before
 *    toe-off, pelvis bob (the hips sink to keep both feet down), sway onto the
 *    stance leg, pelvis yaw and list, and two-bone leg IK.
 * 2. Rifle hold. Low ready (butt in the shoulder, muzzle 40° down) or aimed
 *    from the eye (the sight line runs from the right eye to the target, cheek
 *    on the stock). The right hand is solved to the pistol grip with two-bone
 *    IK, then the left hand to `rifleSupport` (palm up under the handguard).
 *    Fingers curl round the grip and handguard; twist joints share the roll.
 * 3. Upper-body aim spread over the three spine joints, the rest in the neck
 *    and head; bladed chest and cheek weld while aiming.
 * 4. Hit reaction: additive springs on the torso, head and knees, plus a
 *    recoil spring on the rifle.
 * 5. Death: a scripted fall away from the shot (an inverted pendulum about the
 *    feet with the knees buckling), twisting to land on the back or front, the
 *    rifle dropped, the body brought to rest ON the floor plane (the lowest
 *    body point touches y = floor, nothing sinks below it), limbs settling.
 *
 * Coordinates: the root is (x, floor y, z) + a yaw about +Y (0 = facing +Z);
 * the pose is solved in model space (Rig.js) and the caller copies `lq` (core
 * bone local rotations), `pelvisLocal`, `fingerQ`, `twistQ` and the rifle
 * transform onto the three.js objects.
 *
 * Bone rotations are never written in bone-local axes. A "delta" D for bone b
 * is a rotation in model axes applied as if the parent chain were at rest:
 *   modelQ[b] = Δparent · D · restModelQ[b],  Δparent = modelQ[p] · restModelQ[p]⁻¹
 * so "bend forward" is a rotation about +X for every bone, whatever UE axes the
 * bone has. IK-solved bones get absolute model rotations instead.
 */

import { B, CORE_COUNT } from './Rig.js';
import { Q, V3, Rng, clamp, rotationBetweenFrames } from './math.js';

/** Tuned values (design; desktop-checked against renders, not yet in the headset). */
export const ANIM = Object.freeze({
  // gait
  stepLen: [0.3, 0.26, 0.72], // step length = [0] + [1]·speed, at most [2] (m)
  stepPeriod: [0.34, 0.7], // s per step, clamped
  shufflePeriod: 0.42, // s per step when turning on the spot
  swingFrac: 0.8, // share of a step period a foot is in the air
  lead: 0.5, // a foot lands this share of a step ahead of the hips
  lift: [0.07, 0.03, 0.035], // swing lift = [0] + [1]·speed, shuffle [2] (m)
  stepError: 0.1, // m: a standing foot this far from its place starts a step
  stanceHalfWidth: 0.115,
  toeOut: 0.12, // rad each foot
  heelStrike: -0.24, // rad toes up at landing
  heelRise: 0.5, // rad max heel lift on a trailing foot
  kneeSoft: 0.03, // m pelvis drop standing (knees soft)
  kneeAim: 0.035, // extra drop while aiming
  kneeWalk: 0.02, // extra per m/s
  sway: 0.028, // m pelvis shift over the stance foot
  pelvisYaw: 0.08, pelvisRoll: 0.045, // rad at walking speed
  // upper body
  lean: 0.07, leanAim: 0.07, // rad forward lean of the spine (ready, extra when aiming)
  blade: -0.32, // rad the chest turns right while aiming (right-handed)
  spineYawW: [0.2, 0.35, 0.45], spinePitchW: [0.3, 0.3, 0.4],
  headDown: 0.16, headRoll: 0.16, // cheek weld while aiming
  mountS: 0.32, // s to raise the rifle from low ready
  aimLagS: 0.09, // s the aim point lags the target
  // springs (hit reaction, recoil)
  hitK: 170, hitC: 15, recoilK: 420, recoilC: 30,
  // death
  fallLen: 1.0, // m pendulum length (feet to centre of mass)
  restPelvis: 0.115, // m pelvis height lying
  holdS: 6, // body stays this long (manager hides it after)
});

/** Pocket (butt in the right shoulder) in the rest model frame, and the low-ready rifle axes. */
/** Rifle at low ready, in the chest's rest frame: butt position, muzzle direction, rifle up. */
export const LOW = {
  // butt high in the shoulder, muzzle 40° down and 42° across the body (searched so
  // that this model's 0.57 m arms reach both the grip and the handguard)
  butt: new V3(-0.13, 1.4, 0.05),
  fwd: new V3(0.513, -0.643, 0.569).normalize(),
  up: new V3(0.15, 0.72, 0.676).normalize(),
};
/** Left hand on the handguard, rifle space: finger direction, palm normal, wrist position. */
const SUP_F = new V3(0.72, 0.18, -0.67).normalize();
const SUP_N = new V3(0.35, 0.94, 0).normalize();
/** Finger curls (rad per segment) and thumb: right hand on the grip, left on the handguard, dead. */
const CURL_R = [[0.42, 0.55, 0.3], [1.15, 1.25, 0.75], [1.2, 1.3, 0.8], [1.25, 1.3, 0.8], [0.25, 0.35, 0.3]];
const CURL_L = [[0.95, 1.05, 0.65], [1.05, 1.15, 0.7], [1.1, 1.2, 0.75], [1.15, 1.2, 0.75], [0.2, 0.3, 0.25]];
const CURL_D = [[0.3, 0.45, 0.3], [0.35, 0.5, 0.35], [0.4, 0.55, 0.35], [0.45, 0.6, 0.4], [0.1, 0.2, 0.15]];

const UP = new V3(0, 1, 0);
/** Rifle-space points used to land a dropped rifle on the floor (magazine tip, front sight). */
const MAG_TIP = new V3(0, -0.2, 0.02);
const SIGHT_TOP = new V3(0, 0.05, 0);
const TAU = Math.PI * 2;
const SUB = 0.004; // spring sub-step (s)

/**
 * One foot of the stepping gait (world space). Number fields start as
 * non-integers so V8 stores them as unboxed doubles from the first write
 * (a field that starts as a small integer and later holds a fraction can
 * allocate on stores in some optimised code).
 */
class Foot {
  constructor() {
    this.px = 0.5; this.pz = 0.5; this.yaw = 0.5;
    this.planted = true;
    this.swingT = 0.5;
    this.fromX = 0.5; this.fromZ = 0.5; this.fromYaw = 0.5; this.fromPitch = 0.5;
    this.pitch = 0.5; this.landT = 0.5; this.err = 0.5;
  }
}

export class Animator {
  /**
   * @param {import('./Rig.js').RigDef} def
   * @param {number} [seed]
   */
  constructor(def, seed = 1) {
    this.def = def;
    this.rng = new Rng(seed);
    const mk = (/** @type {number} */ n, /** @type {() => any} */ f) => Array.from({ length: n }, f);
    /** Model-space rotation and position of each core bone (the solved pose). */
    /** @type {Q[]} */ this.mq = mk(CORE_COUNT, () => new Q());
    /** @type {V3[]} */ this.mp = mk(CORE_COUNT, () => new V3());
    /** Local rotations to write to the bones. */
    /** @type {Q[]} */ this.lq = mk(CORE_COUNT, () => new Q());
    this.pelvisLocal = new V3();
    /** @type {Q[]} */ this.fingerQ = def.fingers.map((f) => new Q().copy(f.restQ));
    // finger curls (local rotations: rest · curl about the joint's local Z)
    const curl = (/** @type {number[][]} */ right, /** @type {number[][]} */ left) => def.fingers.map((f) =>
      new Q().setAxisAngle(0, 0, 1, (f.hand === 0 ? left : right)[f.finger][f.seg]).preMul(f.restQ));
    this.curlHold = curl(CURL_R, CURL_L);
    this.curlDead = curl(CURL_D, CURL_D);
    /** @type {Q[]} */ this.twistQ = def.twists.map((t) => new Q().copy(t.restQ));
    /** Rifle transform in model space. */
    this.rifleP = new V3().copy(def.rifleRestP);
    this.rifleQ = new Q().copy(def.rifleRestQ);

    // inputs (world space), set by the owner before update()
    this.rootX = 0; this.rootY = 0; this.rootZ = 0; this.rootYaw = 0;
    this.goodX = 0; this.goodY = 0; this.goodZ = 0; this.goodYaw = 0;
    this.vx = 0; this.vz = 0;
    this.aimX = 0; this.aimY = 1.4; this.aimZ = 5;
    /** 0 low ready … 1 aimed. */
    this.raiseTarget = 0;

    // state
    this.raise = 0;
    this.sx = 0; this.sy = 0; this.sz = 0; // smoothed aim point (world)
    this.speed = 0;
    this.gaitOn = false;
    this.phi = 0;
    /** @type {Foot[]} */
    this.feet = [new Foot(), new Foot()];
    this.stepLen = ANIM.stepLen[0];
    /** @type {number} */ this.period = ANIM.shufflePeriod;
    this.moveAmt = 0; // 0 standing … 1 walking (smoothed)
    this.reachDrop = 0;
    /** Bit 0/1: left/right foot landed during the last update (footstep sounds). */
    this.stepEvents = 0;
    this.stepGain = 0;
    // springs: torso pitch/yaw/roll, head pitch/yaw, knee buckle (m), recoil back (m) / rise (rad)
    this.spr = new Float64Array(8);
    this.sprV = new Float64Array(8);

    // death
    this.dead = false;
    this.deathT = 0;
    this.landed = false;
    /** True for the update in which the body hit the floor (fall sound). */
    this.landEvent = false;
    this.settled = false;
    this.th = 0; this.om = 0; // topple angle and rate
    this.twist = 0; this.twistTo = 0;
    this.faceDown = false;
    this.dropT = 0.55; this.hEnd = 0.3; this.y0 = 0.94;
    this.p0 = new V3();
    this.fallX = 0; this.fallZ = -1; // model-space horizontal fall direction
    this.extendL = 0; this.extendR = 0; this.extendToL = 0.6; this.extendToR = 0.9;
    this.drop = 0; // floor-contact correction (m)
    this.low = 0; // lowest body point (lowest())
    this.footDL = new V3(); this.footDR = new V3(); // model-space feet at death
    /** Local pose captured at death (blended out over the first 0.2 s). */
    /** @type {Q[]} */ this.deathLq = mk(CORE_COUNT, () => new Q());
    // rifle drop
    this.rifleFree = false;
    this.rifleT = 0;
    this.rP0 = new V3(); this.rQ0 = new Q(); this.rQ1 = new Q(); this.rV = new V3();

    // scratch
    /** @type {V3[]} */ this._v = mk(24, () => new V3());
    /** @type {Q[]} */ this._q = mk(10, () => new Q());
    /** Scratch for rotationBetweenFrames (never aliased with its inputs). */
    /** @type {V3[]} */ this._rs = mk(6, () => new V3());
    /** Current pitch of each foot (rad, + = heel up). */
    this.footPitch = new Float64Array(2);
    this._ikE = new V3();
    this._handP = new V3();
    this._handQ = new Q();
    this._eye = new V3();
    this._tgt = new V3(); // aim target (model)
    this._ankle = [new V3(), new V3()];
    this._dq = new Q();
    /** Euler angles for euler(): pitch, yaw, roll (a typed array, so no double is boxed on the call). */
    this.E = new Float64Array(3);
    // per-update values shared by the pose passes (fields, not arguments: see euler())
    this.dt = 0; this.cosY = 1; this.sinY = 0; this.raiseE = 0;
    this.reset(0, 0, 0, 0);
  }

  /**
   * Stand at (x, floor y, z) facing `yaw`, feet planted, rifle at low ready.
   * @param {number} x @param {number} y @param {number} z @param {number} yaw
   */
  reset(x, y, z, yaw) {
    this.rootX = x; this.rootY = y; this.rootZ = z; this.rootYaw = yaw;
    this.vx = this.vz = 0;
    this.raise = this.raiseTarget = 0;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    this.aimX = this.sx = x + s * 5; this.aimY = this.sy = y + 1.5; this.aimZ = this.sz = z + c * 5;
    this.gaitOn = false;
    this.phi = 0;
    this.moveAmt = 0;
    this.reachDrop = 0;
    this.speed = 0;
    for (let f = 0; f < 2; f++) {
      const ft = this.feet[f];
      this.neutral(f, this._v[0]);
      ft.px = this._v[0].x; ft.pz = this._v[0].z; ft.yaw = this._v[0].y;
      ft.planted = true; ft.swingT = 0; ft.pitch = 0; ft.landT = 1; ft.err = 0;
    }
    this.spr.fill(0);
    this.sprV.fill(0);
    this.dead = false;
    this.deathT = 0;
    this.landed = this.landEvent = this.settled = false;
    this.rifleFree = false;
    this.drop = 0;
    this.stepEvents = 0;
    this.update(0);
  }

  // ───────────────────────────────────────────────────────────── inputs

  /**
   * Additive hit reaction. Direction = bullet travel (world); (hx, hy, hz) the
   * wound (world); strength ≈ damage / 40.
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {number} hx @param {number} hy @param {number} hz
   * @param {string} part
   * @param {number} strength
   */
  hit(dx, dy, dz, hx, hy, hz, part, strength) {
    const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
    // to model space
    const mx = dx * c - dz * s, mz = dx * s + dz * c;
    const rx0 = hx - this.rootX, rz0 = hz - this.rootZ;
    const rx = rx0 * c - rz0 * s, rz = rx0 * s + rz0 * c, ry = hy - this.rootY - this.def.pelvisY;
    const k = clamp(strength, 0.2, 2.5);
    const V = this.sprV;
    if (part === 'head' || part === 'neck') {
      V[3] += mz * 7 * k; // head snaps back (−pitch = up/back when the bullet travels −Z)
      V[4] += (rz * mx - rx * mz) * 30 * k;
    }
    V[0] += mz * (part === 'pelvis' ? 2 : 4.5) * k; // torso bends with the bullet
    V[1] += (rz * mx - rx * mz) * 9 * k; // twist from the off-axis hit
    V[2] += -ry * mx * 3 * k - mx * 1.5 * k; // lean away
    if (part === 'pelvis' || (part === 'limb' && hy - this.rootY < 0.9)) V[5] += 0.6 * k; // knees buckle
  }

  /** One rifle shot: kick back and muzzle rise, shoulder pushed back. */
  recoil() {
    this.sprV[6] += 0.55;
    this.sprV[7] += 2.6 + this.rng.next() * 0.8;
    this.sprV[0] -= 0.5;
    this.sprV[1] += (this.rng.next() - 0.5) * 0.6;
  }

  /**
   * Start the death fall. (dx, dz) = bullet travel (world, horizontal part used).
   * @param {number} dx @param {number} dz @param {boolean} headshot
   */
  die(dx, dz, headshot) {
    if (this.dead) return;
    this.dead = true;
    this.deathT = 0;
    this.landed = this.landEvent = this.settled = false;
    const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
    let fx = dx * c - dz * s, fz = dx * s + dz * c;
    let l = Math.hypot(fx, fz);
    if (l < 1e-3) { fx = 0; fz = -1; l = 1; }
    fx /= l; fz /= l;
    // ±25° of scatter, and a head shot mostly drops where he stands
    const sc = (this.rng.next() - 0.5) * 0.9, cs = Math.cos(sc), sn = Math.sin(sc);
    this.fallX = fx * cs + fz * sn; this.fallZ = -fx * sn + fz * cs;
    // body yaw that lands him on his back (back toward the fall) or front
    const yawBack = Math.atan2(-this.fallX, -this.fallZ), yawFront = Math.atan2(this.fallX, this.fallZ);
    this.twistTo = Math.abs(yawBack) <= Math.abs(yawFront) + 0.6 ? yawBack : yawFront;
    this.faceDown = this.twistTo === yawFront;
    this.twist = 0;
    // torso: starts tipping with the hit; a head shot just goes limp
    this.th = 0.05;
    this.om = headshot ? 0.2 + this.rng.next() * 0.2 : 0.55 + this.rng.next() * 0.45;
    // hips: the knees give way and he sits (or kneels) down behind the hit
    this.dropT = headshot ? 0.42 : 0.5 + this.rng.next() * 0.15;
    this.hEnd = this.faceDown ? 0.5 + this.rng.next() * 0.1 : 0.28 + this.rng.next() * 0.12;
    this.y0 = this.mp[B.pelvis].y;
    this.p0.copy(this.mp[B.pelvis]);
    this.extendL = this.extendR = 0;
    const r = this.rng.next();
    this.extendToL = r < 0.5 ? 0.3 + this.rng.next() * 0.4 : 0.9;
    this.extendToR = r < 0.5 ? 0.9 : 0.3 + this.rng.next() * 0.4;
    if (this.faceDown) this.extendToL = this.extendToR = 1; // face down: legs out straight
    this.drop = 0;
    this.footDL.copy(this.mp[B.footL]); this.footDL.y = 0;
    this.footDR.copy(this.mp[B.footR]); this.footDR.y = 0;
    for (let b = 0; b < CORE_COUNT; b++) this.deathLq[b].copy(this.lq[b]);
    // the rifle leaves the hand at once and falls on its own
    this.rifleFree = true;
    this.rifleT = 0;
    this.rP0.copy(this.rifleP);
    this.rQ0.copy(this.rifleQ);
    // lying on its side, muzzle roughly along the fall, a random side up
    const ang = Math.atan2(this.fallX, this.fallZ) + (this.rng.next() - 0.5) * 2.2;
    const Z = this._v[0].set(-Math.sin(ang), 0, -Math.cos(ang)); // rifle +Z = −muzzle direction
    const side = this.rng.next() < 0.5 ? 1 : -1;
    const X = this._v[1].set(0, side, 0), Y = this._v[2].cross(Z, X);
    this.rQ1.setFromBasis(X, Y, Z);
    this.rV.set(this.fallX * 0.5 + (this.rng.next() - 0.5) * 0.4, 0.4, this.fallZ * 0.5 + (this.rng.next() - 0.5) * 0.4);
  }

  // ───────────────────────────────────────────────────────────── update

  /** @param {number} dt seconds */
  update(dt) {
    this.dt = dt;
    this.tick();
  }

  /**
   * Advance by `this.dt` seconds (owners in a hot loop set the field and call
   * this: a double passed to a method V8 does not inline is boxed).
   */
  tick() {
    let dt = this.dt;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;
    this.dt = dt;
    // inputs that are not finite keep their last good value (x − x is 0 only for finite x)
    if (this.rootX - this.rootX === 0 && this.rootZ - this.rootZ === 0 && this.rootY - this.rootY === 0 && this.rootYaw - this.rootYaw === 0) {
      this.goodX = this.rootX; this.goodY = this.rootY; this.goodZ = this.rootZ; this.goodYaw = this.rootYaw;
    } else { this.rootX = this.goodX; this.rootY = this.goodY; this.rootZ = this.goodZ; this.rootYaw = this.goodYaw; }
    if (!(this.vx - this.vx === 0 && this.vz - this.vz === 0)) { this.vx = 0; this.vz = 0; }
    if (!(this.aimX - this.aimX === 0 && this.aimY - this.aimY === 0 && this.aimZ - this.aimZ === 0)) { this.aimX = this.sx; this.aimY = this.sy; this.aimZ = this.sz; }
    if (!(this.raiseTarget >= 0)) this.raiseTarget = 0;
    this.cosY = Math.cos(this.rootYaw);
    this.sinY = Math.sin(this.rootYaw);
    this.stepEvents = 0;
    this.landEvent = false;
    this.springs();
    if (this.dead) this.updateDeath();
    else this.updateAlive();
    this.writeLocals();
  }

  springs() {
    const dt = this.dt;
    const X = this.spr, V = this.sprV, k = ANIM.hitK, c = ANIM.hitC, rk = ANIM.recoilK, rc = ANIM.recoilC;
    let t = dt;
    while (t > 1e-6) {
      const h = t > SUB ? SUB : t;
      t -= h;
      for (let i = 0; i < 6; i++) { V[i] += (-k * X[i] - c * V[i]) * h; X[i] += V[i] * h; }
      for (let i = 6; i < 8; i++) { V[i] += (-rk * X[i] - rc * V[i]) * h; X[i] += V[i] * h; }
    }
    for (let i = 0; i < 8; i++) {
      const lim = i === 5 ? 0.12 : i === 6 ? 0.06 : 0.7;
      if (!(X[i] > -lim)) { X[i] = -lim; if (!(V[i] > 0)) V[i] = 0; }
      else if (X[i] > lim) { X[i] = lim; if (V[i] > 0) V[i] = 0; }
    }
  }

  /**
   * World neutral place of foot f for the current root and stance: out.x/z, out.y = yaw.
   * @param {number} f @param {V3} out
   */
  neutral(f, out) {
    const sv = this.speed / 0.6, r = this.raise, still = sv >= 1 ? 0 : 1 - sv;
    const blade = r * still; // bladed stance while aiming in place
    const side = (f === 0 ? 1 : -1) * (ANIM.stanceHalfWidth + 0.02 * blade);
    const fwd = this.def.ankleZ + (f === 0 ? 0.1 : -0.1) * blade;
    const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
    out.x = this.rootX + side * c + fwd * s;
    out.z = this.rootZ - side * s + fwd * c;
    out.y = this.rootYaw + (f === 0 ? ANIM.toeOut : -ANIM.toeOut) - 0.35 * blade;
    return out;
  }

  updateAlive() {
    const d = this.def, A = ANIM, dt = this.dt;
    // inputs
    const rs = dt / A.mountS;
    this.raise = this.raise < this.raiseTarget ? Math.min(this.raiseTarget, this.raise + rs) : Math.max(this.raiseTarget, this.raise - rs * 0.8);
    const ka = dt > 0 ? 1 - Math.exp(-dt / A.aimLagS) : 1;
    this.sx += (this.aimX - this.sx) * ka; this.sy += (this.aimY - this.sy) * ka; this.sz += (this.aimZ - this.sz) * ka;
    const speed = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
    this.speed = speed;
    const km = dt > 0 ? 1 - Math.exp(-dt / 0.25) : 1;
    const mt = speed / 1.1;
    this.moveAmt += ((mt > 1 ? 1 : mt) - this.moveAmt) * km;

    this.gait();
    const c = this.cosY, s = this.sinY;
    const rr = this.raise;
    const raiseE = rr <= 0 ? 0 : rr >= 1 ? 1 : rr * rr * (3 - 2 * rr);
    this.raiseE = raiseE;

    // ankle targets (model space) from the feet
    this.ankleModel(0, this._ankle[0]);
    this.ankleModel(1, this._ankle[1]);

    // ── pelvis
    const mv = this.moveAmt, ph = Math.PI * this.phi;
    const sw = Math.sin(ph);
    const P = this.mp[B.pelvis];
    const R0 = d.restModelP[B.pelvis];
    // weight over the stance foot, between the feet's average and the root
    const ax = (this._ankle[0].x + this._ankle[1].x) * 0.5, az = (this._ankle[0].z + this._ankle[1].z) * 0.5;
    let px = R0.x + (ax - R0.x) * 0.35 * (1 - mv) - A.sway * mv * sw;
    let pz = R0.z + (az - d.ankleZ) * 0.35 * (1 - mv) + 0.03 * raiseE;
    let py = d.pelvisY - A.kneeSoft - A.kneeAim * raiseE - A.kneeWalk * Math.min(speed, 1.5) - this.spr[5];
    // sink to keep both feet down
    let need = 0;
    for (let f = 0; f < 2; f++) {
      const an = this._ankle[f];
      const hx = px + (f === 0 ? d.hipHalfWidth : -d.hipHalfWidth) - an.x, hz = pz - an.z;
      const reach = (d.len.thigh + d.len.calf) * 0.985;
      const h2 = reach * reach - hx * hx - hz * hz;
      const maxY = (h2 > 0 ? Math.sqrt(h2) : 0) + an.y + (R0.y - d.restModelP[B.thighL].y);
      if (py - maxY > need) need = py - maxY;
    }
    if (need > 0.08) need = 0.08;
    const kr = need > this.reachDrop ? (dt > 0 ? 1 - Math.exp(-dt / 0.03) : 1) : (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1);
    this.reachDrop += (need - this.reachDrop) * kr;
    py -= this.reachDrop;
    P.set(px, py, pz);

    const pYaw = -A.pelvisYaw * mv * sw - 0.3 * raiseE * (1 - mv);
    const pRoll = -A.pelvisRoll * mv * sw;
    const pPitch = 0.05 + 0.03 * raiseE + 0.04 * mv;
    const D = this._dq;
    const E = this.E;
    E[0] = pPitch; E[1] = pYaw; E[2] = pRoll;
    this.euler(D);
    this.mq[B.pelvis].mul(D, d.restModelQ[B.pelvis]);

    // ── aim (model space)
    const T = this._tgt;
    {
      const wx = this.sx - this.rootX, wz = this.sz - this.rootZ;
      T.set(wx * c - wz * s, this.sy - this.rootY, wx * s + wz * c);
    }
    const chestY = d.restModelP[B.spine3].y;
    let yawAim = Math.atan2(T.x, T.z);
    const hd = Math.sqrt(T.x * T.x + T.z * T.z);
    let pitchAim = Math.atan2(T.y - (chestY + 0.3), Math.max(hd, 0.3));
    if (!(yawAim > -1.35)) yawAim = -1.35; else if (yawAim > 1.35) yawAim = 1.35;
    if (!(pitchAim > -1.0)) pitchAim = -1.0; else if (pitchAim > 0.9) pitchAim = 0.9;
    const blade = A.blade * raiseE;
    const sYaw = yawAim - pYaw + blade + this.spr[1];
    const sPitch = -pitchAim * 0.65 + A.lean + A.leanAim * raiseE + 0.04 * mv - pPitch + this.spr[0];
    const sRoll = -pRoll * 0.8 + this.spr[2];
    for (let i = 0; i < 3; i++) {
      E[0] = sPitch * A.spinePitchW[i]; E[1] = sYaw * A.spineYawW[i]; E[2] = sRoll * (i === 0 ? 0.5 : 0.25);
      this.euler(D);
      this.fkDelta(B.spine1 + i, D);
    }
    // neck and head: the rest of the look, cheek on the stock while aiming
    const hYaw = yawAim - (pYaw + sYaw) + this.spr[4] * 0.5;
    const hPitch = -pitchAim * 0.35 - (A.lean + A.leanAim * raiseE) * 0.8 + A.headDown * raiseE + this.spr[3];
    const hRoll = A.headRoll * raiseE;
    E[0] = hPitch * 0.45; E[1] = hYaw * 0.4; E[2] = hRoll * 0.4;
    this.fkDelta(B.neck, this.euler(D));
    E[0] = hPitch * 0.55 + this.spr[3] * 0.5; E[1] = hYaw * 0.6 + this.spr[4]; E[2] = hRoll * 0.6;
    this.fkDelta(B.head, this.euler(D));
    // clavicles: right shoulder forward and up into the stock while aiming
    E[0] = 0; E[1] = 0.12 * raiseE; E[2] = -0.06 * raiseE;
    this.fkDelta(B.clavR, this.euler(D));
    E[0] = 0; E[1] = -0.08 * raiseE - 0.06; E[2] = 0;
    this.fkDelta(B.clavL, this.euler(D));

    // ── rifle
    this.placeRifle(T);
    // ── arms
    this.armsOnRifle();
    // ── legs
    this.legs();
    this.fingersHold();
    this.twists();
  }

  /** Stepping gait (world space). */
  gait() {
    const A = ANIM, dt = this.dt, speed = this.speed;
    const moving = speed > 0.1;
    let sl = A.stepLen[0] + A.stepLen[1] * speed;
    if (sl > A.stepLen[2]) sl = A.stepLen[2];
    this.stepLen = sl;
    /** @type {number} */ let T = A.shufflePeriod;
    if (moving) { T = sl / speed; if (T < A.stepPeriod[0]) T = A.stepPeriod[0]; else if (T > A.stepPeriod[1]) T = A.stepPeriod[1]; }
    this.period = T;
    const nv = this._v[20];
    let maxErr = 0;
    for (let f = 0; f < 2; f++) {
      const ft = this.feet[f];
      if (!ft.planted) { ft.err = 0; continue; }
      this.neutral(f, nv);
      const ex = ft.px - nv.x, ez = ft.pz - nv.z;
      let ey = (ft.yaw - nv.y) % TAU;
      if (ey > Math.PI) ey -= TAU; else if (ey < -Math.PI) ey += TAU;
      ft.err = Math.sqrt(ex * ex + ez * ez) + 0.25 * Math.abs(ey);
      if (ft.err > maxErr) maxErr = ft.err;
    }
    if (!this.gaitOn) {
      if (moving || maxErr > A.stepError) {
        this.gaitOn = true;
        // start with the foot that is furthest out (or the trailing one when walking off)
        const f0 = this.feet[0].err >= this.feet[1].err ? 0 : 1;
        this.phi = f0;
        this.startSwing(f0);
      }
    } else {
      const prev = this.phi;
      this.phi += dt / T;
      for (let f = 0; f < 2; f++) {
        const st = f; // window start: left 0, right 1
        const crossed = (prev < st && this.phi >= st) || (this.phi >= 2 && st + 2 <= this.phi && prev < st + 2);
        const ft = this.feet[f];
        if (crossed && ft.planted && (moving || ft.err > 0.03)) this.startSwing(f);
      }
      if (this.phi >= 2) this.phi -= 2;
    }
    // swings
    const swingS = A.swingFrac * T;
    const lead = moving ? A.lead * this.stepLen : 0;
    const ivx = moving ? this.vx / speed : 0, ivz = moving ? this.vz / speed : 0;
    for (let f = 0; f < 2; f++) {
      const ft = this.feet[f];
      if (ft.planted) { ft.landT += dt; continue; }
      ft.swingT += dt / swingS;
      const remain = Math.max(0, 1 - ft.swingT) * swingS;
      this.neutral(f, nv);
      const tx = nv.x + this.vx * remain + ivx * lead, tz = nv.z + this.vz * remain + ivz * lead;
      if (ft.swingT >= 1) {
        ft.planted = true; ft.px = tx; ft.pz = tz; ft.yaw = nv.y; ft.landT = 0; ft.swingT = 1;
        const ks = speed < 0.3 ? 0.3 : speed > 1 ? 1 : speed;
        ft.pitch = moving ? A.heelStrike * ks : 0;
        this.stepEvents |= 1 << f;
        this.stepGain = 0.35 + 0.65 * ks;
      } else {
        // the target is tracked to the end, so turns and speed changes land true
        const u = ft.swingT, e = u * u * (3 - 2 * u);
        ft.px = ft.fromX + (tx - ft.fromX) * e;
        ft.pz = ft.fromZ + (tz - ft.fromZ) * e;
        let dy = (nv.y - ft.fromYaw) % TAU;
        if (dy > Math.PI) dy -= TAU; else if (dy < -Math.PI) dy += TAU;
        ft.yaw = ft.fromYaw + dy * e;
        const u2 = u / 0.85 > 1 ? 1 : u / 0.85, e2 = u2 * u2 * (3 - 2 * u2);
        const ks = speed < 0.3 ? 0.3 : speed > 1 ? 1 : speed;
        ft.pitch = ft.fromPitch * (1 - e2) + (moving ? A.heelStrike * ks : 0) * e2;
      }
    }
    if (this.gaitOn && !moving && this.feet[0].planted && this.feet[1].planted) {
      let e = 0;
      for (let f = 0; f < 2; f++) {
        this.neutral(f, nv);
        const ft = this.feet[f], ex = ft.px - nv.x, ez = ft.pz - nv.z, el = Math.sqrt(ex * ex + ez * ez);
        if (el > e) e = el;
      }
      if (e < 0.06) this.gaitOn = false;
    }
  }

  /** @param {number} f */
  startSwing(f) {
    const ft = this.feet[f];
    ft.planted = false;
    ft.swingT = 0;
    ft.fromX = ft.px; ft.fromZ = ft.pz; ft.fromYaw = ft.yaw; ft.fromPitch = ft.pitch;
  }

  /**
   * Ankle joint target in model space for foot f (heel strike about the heel,
   * heel rise about the ball, swing lift).
   * @param {number} f @param {V3} out
   */
  ankleModel(f, out) {
    const d = this.def, ft = this.feet[f], A = ANIM, c = this.cosY, s = this.sinY;
    // stance pitch: roll flat after the heel strike, then rise onto the ball when trailing
    if (ft.planted) {
      let p = ft.landT < 0.12 ? ft.pitch * (1 - ft.landT / 0.12) : 0;
      if (ft.landT >= 0.12) ft.pitch = 0;
      if (this.speed > 0.1) {
        // trailing distance behind the hips along the walk direction
        const ivx = this.vx / this.speed, ivz = this.vz / this.speed;
        const trail = -((ft.px - this.rootX) * ivx + (ft.pz - this.rootZ) * ivz);
        let hr = (trail - 0.06) / 0.3;
        hr = (hr < 0 ? 0 : hr > 1 ? 1 : hr) * A.heelRise;
        if (hr > p) p = hr;
      }
      ft.fromPitch = p;
      this.footPitch[f] = p;
    } else this.footPitch[f] = ft.pitch;
    const p = this.footPitch[f];
    // flat ankle in world, then pivot
    const fyaw = ft.yaw, fc = Math.cos(fyaw), fs = Math.sin(fyaw);
    let lx = 0, ly = d.ankleY, lz = 0; // ankle relative to the ground point, foot frame (+Z toe)
    if (p > 0) {
      // about the ball: ball = (0, ankleY + bo.y, bo.z); v = −bo rotated by p about X
      const by = d.ankleY + d.ballOffset.y, bz = d.ballOffset.z, vy = -d.ballOffset.y, vz = -d.ballOffset.z;
      const cp = Math.cos(p), sp = Math.sin(p);
      ly = by + vy * cp - vz * sp; lz = bz + vy * sp + vz * cp;
    } else if (p < 0) {
      const hy = 0.0, hz = -0.07, vy = d.ankleY - hy, vz = -hz;
      const cp = Math.cos(p), sp = Math.sin(p);
      ly = hy + vy * cp - vz * sp; lz = hz + vy * sp + vz * cp;
    }
    if (!ft.planted) {
      const sp = this.speed > 0.1 ? A.lift[0] + A.lift[1] * Math.min(this.speed, 1.5) : A.lift[2];
      const u = ft.swingT < 0 ? 0 : ft.swingT > 1 ? 1 : ft.swingT;
      ly += sp * Math.sin(Math.PI * u);
    }
    const wx = ft.px + lx * fc + lz * fs - this.rootX, wz = ft.pz - lx * fs + lz * fc - this.rootZ;
    out.set(wx * c - wz * s, ly, wx * s + wz * c);
    return out;
  }

  /**
   * Rifle transform in model space: low ready from the shoulder pocket, aimed
   * from the right eye, blended by the eased raise; then recoil.
   * @param {V3} T aim target (model)
   */
  placeRifle(T) {
    const d = this.def, v = this._v, q = this._q, r = this.raiseE;
    const chestD = q[0].mulConj(this.mq[B.spine3], d.restModelQ[B.spine3]);
    // shoulder pocket now
    const pocket = v[0].subVectors(LOW.butt, d.restModelP[B.spine3]).applyQ(chestD).add(this.mp[B.spine3]);
    // low ready: the chest's heading only (stays low when he leans or looks up)
    const fwd = v[1].set(0, 0, 1).applyQ(chestD);
    const hy = Math.atan2(fwd.x, fwd.z) * 0.5;
    const qy = q[1];
    qy.x = 0; qy.y = Math.sin(hy); qy.z = 0; qy.w = Math.cos(hy);
    const lf = v[2].copy(LOW.fwd).applyQ(qy), lu = v[3].copy(LOW.up).applyQ(qy);
    const Zr = v[4].copy(lf).scale(-1), Xr = v[5].cross(lu, Zr).normalize(), Yr = v[6].cross(Zr, Xr);
    const qLow = q[2].setFromBasis(Xr, Yr, Zr);
    const pLow = v[7].copy(d.rifle.butt).applyQ(qLow).scale(-1).add(pocket);
    // aimed: the eye on the sight line, muzzle at the target, no cant
    const headD = q[3].mulConj(this.mq[B.head], d.restModelQ[B.head]);
    const eye = this._eye.copy(d.eyeR).applyQ(headD).add(this.mp[B.head]);
    const dir = v[8].subVectors(T, eye).normalize();
    const Za = v[9].copy(dir).scale(-1), Xa = v[10].cross(UP, Za).normalize(), Ya = v[11].cross(Za, Xa);
    const qAim = q[4].setFromBasis(Xa, Ya, Za);
    const pAim = v[12].copy(d.rifle.eye).applyQ(qAim).scale(-1).add(eye);
    // blend (nlerp: the two are never far apart, and no double crosses a call)
    const dq = qLow.x * qAim.x + qLow.y * qAim.y + qLow.z * qAim.z + qLow.w * qAim.w;
    const RQ = this.rifleQ, r0 = 1 - r, r1 = dq < 0 ? -r : r;
    RQ.x = qLow.x * r0 + qAim.x * r1; RQ.y = qLow.y * r0 + qAim.y * r1; RQ.z = qLow.z * r0 + qAim.z * r1; RQ.w = qLow.w * r0 + qAim.w * r1;
    RQ.normalize();
    const RP = this.rifleP;
    RP.x = pLow.x * r0 + pAim.x * r; RP.y = pLow.y * r0 + pAim.y * r; RP.z = pLow.z * r0 + pAim.z * r;
    // recoil: back along the bore, muzzle up about the rifle's X at the butt
    const hr = this.spr[7] * 0.5;
    const rise = q[5];
    rise.x = Math.sin(hr); rise.y = 0; rise.z = 0; rise.w = Math.cos(hr);
    const butt = v[13].copy(d.rifle.butt).applyQ(RQ).add(RP);
    RQ.postMul(rise);
    RP.copy(d.rifle.butt).applyQ(RQ).scale(-1).add(butt);
    const kick = v[14];
    kick.x = 0; kick.y = 0; kick.z = this.spr[6];
    RP.add(kick.applyQ(RQ));
  }

  /** Right hand to the grip, rifle re-derived from the hand, left hand to the support. */
  armsOnRifle() {
    const d = this.def, v = this._v, q = this._q, R = d.rifle;
    // right hand target
    const hq = this._handQ.mulConj(this.rifleQ, R.inHandQ);
    const hp = this._handP.copy(R.inHandP).applyQ(hq).scale(-1).add(this.rifleP);
    const chestD = q[0].mulConj(this.mq[B.spine3], d.restModelQ[B.spine3]);
    const poleR = v[15].set(-0.55, -0.8, -0.2).applyQ(chestD);
    this.ik(1, hp, poleR);
    this.fkAbs(B.handR, hq);
    // the rifle follows the hand where it actually got to
    this.rifleP.copy(R.inHandP).applyQ(hq).add(this.mp[B.handR]);
    // left hand: palm up under the handguard
    const fT = v[16].copy(SUP_F).applyQ(this.rifleQ), nT = v[17].copy(SUP_N).applyQ(this.rifleQ);
    const handL = q[6];
    rotationBetweenFrames(handL, d.handF[0], d.handN[0], fT, nT, this._rs);
    handL.postMul(d.restModelQ[B.handL]);
    // wrist so the palm sits on the support point
    const wp = v[18].copy(R.support).applyQ(this.rifleQ).add(this.rifleP);
    wp.addScaled(nT, -0.045).addScaled(fT, -0.055);
    const poleL = v[15].set(0.45, -0.85, -0.1).applyQ(chestD);
    this.ik(0, wp, poleL);
    this.fkAbs(B.handL, handL);
  }

  /**
   * Two-bone IK for chain k (0 left arm, 1 right arm, 2 left leg, 3 right leg).
   * Writes model rotations/positions of the upper and lower bone; the end bone's
   * position is placed (its rotation is set by the caller).
   * @param {number} k @param {V3} target end-joint target (model) @param {V3} pole
   */
  ik(k, target, pole) {
    const ch = this.def.chains[k], v = this._v, q = this._q;
    const S = this.mp[ch.upper];
    // the upper bone's position comes from its parent (already solved)
    const p = this.def.parent[ch.upper];
    S.copy(this.def.restLocalT[ch.upper]).applyQ(this.mq[p]).add(this.mp[p]);
    const a = ch.a, b = ch.b;
    const w = v[20].subVectors(target, S);
    let dl = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    const maxD = (a + b) * 0.999, minD = Math.abs(a - b) + 1e-3;
    if (dl < 1e-6) { w.set(0, -1, 0); dl = minD; } else { const k = 1 / dl; w.x *= k; w.y *= k; w.z *= k; }
    if (dl > maxD) dl = maxD; else if (dl < minD) dl = minD;
    const pp = v[21].copy(pole).rejectFrom(w);
    if (pp.x * pp.x + pp.y * pp.y + pp.z * pp.z < 1e-8) pp.set(0, 0, 1).rejectFrom(w);
    pp.normalize();
    let ca = (a * a + dl * dl - b * b) / (2 * a * dl);
    if (ca > 1) ca = 1; else if (ca < -1) ca = -1;
    const sa = Math.sqrt(1 - ca * ca);
    // (written out: a double passed to a method that is not inlined here would be boxed)
    const ka = a * ca, kp = a * sa;
    const E = this._ikE.set(S.x + w.x * ka + pp.x * kp, S.y + w.y * ka + pp.y * kp, S.z + w.z * ka + pp.z * kp);
    const end = v[22].set(S.x + w.x * dl, S.y + w.y * dl, S.z + w.z * dl);
    const au = v[23].subVectors(E, S).normalize();
    const hinge = v[19].cross(pp, w).normalize();
    const R = q[7];
    rotationBetweenFrames(R, ch.axisU, ch.hinge, au, hinge, this._rs);
    this.mq[ch.upper].mul(R, this.def.restModelQ[ch.upper]);
    const al = v[23].subVectors(end, E).normalize();
    rotationBetweenFrames(R, ch.axisL, ch.hinge, al, hinge, this._rs);
    this.mq[ch.lower].mul(R, this.def.restModelQ[ch.lower]);
    this.mp[ch.lower].copy(this.def.restLocalT[ch.lower]).applyQ(this.mq[ch.upper]).add(S);
    this.mp[ch.end].copy(this.def.restLocalT[ch.end]).applyQ(this.mq[ch.lower]).add(this.mp[ch.lower]);
  }

  /** Legs to the ankle targets, feet yawed and pitched, toes flat. */
  legs() {
    const d = this.def, v = this._v, q = this._q;
    for (let f = 0; f < 2; f++) {
      const ft = this.feet[f];
      let fy = (ft.yaw - this.rootYaw) % TAU;
      if (fy > Math.PI) fy -= TAU; else if (fy < -Math.PI) fy += TAU;
      const pole = v[14].set(Math.sin(fy) + (f === 0 ? 0.12 : -0.12), 0.1, Math.cos(fy));
      this.ik(f === 0 ? 2 : 3, this._ankle[f], pole);
      const p = this.footPitch[f];
      const qy = q[8], qp = q[9];
      qy.x = 0; qy.y = Math.sin(fy * 0.5); qy.z = 0; qy.w = Math.cos(fy * 0.5);
      qp.x = Math.sin(p * 0.5); qp.y = 0; qp.z = 0; qp.w = Math.cos(p * 0.5);
      const fb = f === 0 ? B.footL : B.footR, tb = f === 0 ? B.ballL : B.ballR;
      this._dq.mul(qy, qp).postMul(d.restModelQ[fb]);
      this.fkAbs(fb, this._dq);
      // toes stay flat while the heel is up; follow the foot otherwise
      const tp = ft.planted && p > 0 ? 0 : p;
      qp.x = Math.sin(tp * 0.5); qp.w = Math.cos(tp * 0.5);
      this._dq.mul(qy, qp).postMul(d.restModelQ[tb]);
      this.fkAbs(tb, this._dq);
    }
  }

  /**
   * Fingers curl round the grip and the handguard (or open, dead): an
   * exponential approach to precomputed local rotations (normalised lerp,
   * written out so no double crosses a call).
   */
  fingersHold() {
    const dt = this.dt;
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.08) : 1;
    const target = this.dead ? this.curlDead : this.curlHold;
    for (let i = 0; i < target.length; i++) {
      const c = this.fingerQ[i], t = target[i];
      const sg = c.x * t.x + c.y * t.y + c.z * t.z + c.w * t.w < 0 ? -k : k;
      c.x += (t.x * sg - c.x) * k; c.y += (t.y * sg - c.y) * k; c.z += (t.z * sg - c.z) * k; c.w += (t.w * sg - c.w) * k;
      c.normalize();
    }
  }

  /**
   * Twist joints take a share of the roll of their bone (or of the hand / foot
   * below). Written out inline: a helper returning a double would be boxed here.
   */
  twists() {
    const d = this.def, T = d.twists, q = this._q[8], r = this._q[9];
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      // roll of `distal` about its own X (the limb axis): L = L0 · Δ, twist of Δ about X
      const db = t.distal;
      q.conjMul(this.mq[d.parent[db]], this.mq[db]); // current local L
      r.conjMul(d.restLocalQ[db], q); // Δ = L0⁻¹ · L, in the bone's rest frame
      let ang = 2 * Math.atan2(r.x, r.w);
      if (ang > Math.PI) ang -= 2 * Math.PI; else if (ang < -Math.PI) ang += 2 * Math.PI;
      if (ang > 2.5) ang = 2.5; else if (ang < -2.5) ang = -2.5;
      const h = ang * t.k * 0.5;
      q.x = Math.sin(h); q.y = 0; q.z = 0; q.w = Math.cos(h);
      this.twistQ[i].mul(t.restQ, q);
    }
  }

  // ───────────────────────────────────────────────────────────── death

  updateDeath() {
    const d = this.def, v = this._v, q = this._q, A = ANIM, dt = this.dt, E = this.E;
    // (scalar maths is written out here: a double passed to a helper V8 does not inline is boxed)
    this.deathT += dt;
    const t = this.deathT;
    // torso topples about the hips: θ'' = (g / L)·sin θ (an inverted pendulum)
    const thEnd = Math.PI / 2 - 0.03;
    let h = dt;
    while (h > 1e-6 && !this.landed) {
      const st = h > SUB ? SUB : h;
      h -= st;
      this.om += (9.81 / A.fallLen) * Math.sin(this.th) * st;
      this.th += this.om * st;
      if (this.th >= thEnd) {
        this.th = thEnd;
        this.om = -this.om * 0.12; // a small rebound off the floor
        this.landed = true;
        this.landEvent = true;
      }
    }
    if (this.landed && this.th < thEnd) {
      this.om += 14 * dt;
      this.th += this.om * dt;
      if (this.th >= thEnd) { this.th = thEnd; this.om = 0; }
    }
    let prog = this.th / thEnd;
    prog = prog < 0 ? 0 : prog > 1 ? 1 : prog;
    let w = prog * 1.15;
    w = w > 1 ? 1 : w;
    this.twist = this.twistTo * w * w * (3 - 2 * w);
    const ke = dt > 0 ? 1 - Math.exp(-dt / 0.45) : 1;
    if (this.landed) {
      this.extendL += (this.extendToL - this.extendL) * ke;
      this.extendR += (this.extendToR - this.extendR) * ke;
    }
    if (t > 2.5) this.settled = true;

    // body rotation: fall about axis = up × fallDir = (fz, 0, −fx), after the twist
    const hf = this.th * 0.5, sf = Math.sin(hf), ht = this.twist * 0.5;
    const qf = q[0], qt = q[1];
    qf.x = this.fallZ * sf; qf.y = 0; qf.z = -this.fallX * sf; qf.w = Math.cos(hf);
    qt.x = 0; qt.y = Math.sin(ht); qt.z = 0; qt.w = Math.cos(ht);
    const body = q[2].mul(qf, qt);
    // hips: drop as the knees give way (and as the torso goes down), moving back over the fall
    let u = t / this.dropT;
    u = u > 1 ? 1 : u;
    const yr = A.restPelvis, y0 = this.y0;
    let py = y0 - (y0 - yr) * u * u;
    const pyT = yr + (y0 - yr) * Math.cos(this.th);
    if (pyT < py) py = pyT;
    if (this.faceDown && this.th < 0.9 && py < 0.5) py = 0.5; // onto the knees first
    let um = u > prog ? u : prog;
    um = um * um * (3 - 2 * um);
    const hT = this.hEnd * um;
    const P = this.mp[B.pelvis];
    P.x = this.p0.x + this.fallX * hT; P.y = py < yr ? yr : py; P.z = this.p0.z + this.fallZ * hT;
    this.mq[B.pelvis].mul(body, d.restModelQ[B.pelvis]);

    // spine and head: limp, lagging the fall; the head rolls to a side once down
    const D = this._dq;
    let lag = -this.om * 0.08;
    lag = lag < -0.25 ? -0.25 : lag > 0.25 ? 0.25 : lag;
    for (let i = 0; i < 3; i++) {
      E[0] = lag * 0.33 + this.spr[0] * 0.3; E[1] = this.spr[1] * 0.3; E[2] = this.spr[2] * 0.3;
      this.fkDelta(B.spine1 + i, this.euler(D));
    }
    let ur = (t - 0.9) / 0.6;
    ur = ur < 0 ? 0 : ur > 1 ? 1 : ur;
    const roll = this.landed ? ur * ur * (3 - 2 * ur) * (this.extendToL > this.extendToR ? 0.6 : -0.6) : 0;
    E[0] = lag * 0.5; E[1] = roll * 0.5; E[2] = 0;
    this.fkDelta(B.neck, this.euler(D));
    E[0] = lag * 0.5 + this.spr[3]; E[1] = roll; E[2] = 0;
    this.fkDelta(B.head, this.euler(D));
    D.identity();
    this.fkDelta(B.clavL, D);
    this.fkDelta(B.clavR, D);
    // arms: limp, swinging out with the fall, then lying
    // (rest is an A-pose: −0.55 brings a limp arm in to hang by the body)
    const us = t / 0.9;
    const swing = Math.sin(Math.PI * (us > 1 ? 1 : us)) * 0.35 * prog;
    let ua = prog * 1.3;
    ua = ua > 1 ? 1 : ua;
    const abd = -0.55 + 0.35 * ua * ua * (3 - 2 * ua) + swing;
    for (let side = 0; side < 2; side++) {
      const ub = side === 0 ? B.upperArmL : B.upperArmR, lb = side === 0 ? B.lowerArmL : B.lowerArmR, hb = side === 0 ? B.handL : B.handR;
      E[0] = -0.1 - swing * 0.4; E[1] = 0; E[2] = (side === 0 ? 1 : -1) * abd;
      this.fkDelta(ub, this.euler(D));
      const hg = d.chains[side].hinge, he = (0.35 + swing * 0.3) * 0.5, se = Math.sin(he);
      D.x = hg.x * se; D.y = hg.y * se; D.z = hg.z * se; D.w = Math.cos(he);
      this.fkDelta(lb, D);
      E[0] = 0.2; E[1] = 0; E[2] = 0;
      this.fkDelta(hb, this.euler(D));
    }
    // blend out of the pose he died in (everything above the hips) over 0.2 s
    let ub0 = t / 0.22;
    ub0 = ub0 > 1 ? 1 : ub0;
    const bo = ub0 * ub0 * (3 - 2 * ub0);
    if (bo < 1) {
      const b0 = 1 - bo;
      for (let b = B.spine1; b <= B.handR; b++) {
        const pb = d.parent[b];
        const lq = q[3].conjMul(this.mq[pb], this.mq[b]), s0 = this.deathLq[b];
        const k1 = s0.x * lq.x + s0.y * lq.y + s0.z * lq.z + s0.w * lq.w < 0 ? -bo : bo;
        lq.x = s0.x * b0 + lq.x * k1; lq.y = s0.y * b0 + lq.y * k1; lq.z = s0.z * b0 + lq.z * k1; lq.w = s0.w * b0 + lq.w * k1;
        lq.normalize();
        this.mq[b].mul(this.mq[pb], lq);
        this.mp[b].copy(d.restLocalT[b]).applyQ(this.mq[pb]).add(this.mp[pb]);
      }
    }
    // the floor: nothing below it; once down, the lowest point rests on it
    this.lowest();
    let lift = -this.low;
    if (this.landed) {
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.08) : 1;
      this.drop += (lift - this.drop) * k;
      if (lift > this.drop) this.drop = lift; // never inside the floor
      lift = this.drop;
    } else if (lift < 0) lift = 0;
    if (lift !== 0) for (let b = B.pelvis; b <= B.handR; b++) this.mp[b].y += lift;
    if (this.landed) this.headToFloor();
    this.armsToFloor();
    // legs: to the feet he stood on, sliding out straight once down
    const legL = d.len.thigh + d.len.calf;
    for (let f = 0; f < 2; f++) {
      const ft = f === 0 ? this.footDL : this.footDR, ex = f === 0 ? this.extendL : this.extendR;
      const hipB = f === 0 ? B.thighL : B.thighR;
      const hip = v[2].copy(d.restLocalT[hipB]).applyQ(this.mq[B.pelvis]).add(this.mp[B.pelvis]);
      // straight-leg place: from the hip, away from the head, on the floor
      const bodyAxis = v[3].set(0, 1, 0).applyQ(body);
      const sx = hip.x - bodyAxis.x * legL * 0.97, sz = hip.z - bodyAxis.z * legL * 0.97;
      const an = this._ankle[f];
      an.x = ft.x + (sx - ft.x) * ex; an.y = d.ankleY * (1 - 0.4 * ex); an.z = ft.z + (sz - ft.z) * ex;
      // a foot the hips have left behind is dragged along
      const dx = an.x - hip.x, dy = an.y - hip.y, dz = an.z - hip.z, dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const reach = legL * 0.99;
      if (dl > reach) {
        const k = reach / dl;
        an.x = hip.x + dx * k; an.y = hip.y + dy * k; an.z = hip.z + dz * k;
        if (an.y < d.ankleY * 0.6) an.y = d.ankleY * 0.6;
        ft.x = an.x; ft.z = an.z;
      }
      const pole = v[4].set(0, 0, 1).applyQ(body);
      pole.y += 0.3;
      this.ik(f === 0 ? 2 : 3, an, pole);
      // a bent leg keeps its foot flat on the floor; a straight one lies with the body
      const fb = f === 0 ? B.footL : B.footR, tb = f === 0 ? B.ballL : B.ballR;
      const hy = this.twist * 0.2, hp = (0.45 + (f === 0 ? 0.15 : -0.1)) * 0.5;
      const flat = q[4], tilt = q[6];
      flat.x = 0; flat.y = Math.sin(hy); flat.z = 0; flat.w = Math.cos(hy);
      tilt.x = Math.sin(hp); tilt.y = 0; tilt.z = 0; tilt.w = Math.cos(hp);
      const lying = q[5].mul(qf, qt).postMul(tilt);
      let ue = ex < 0 ? 0 : ex > 1 ? 1 : ex;
      ue = ue * ue * (3 - 2 * ue);
      const k1 = flat.x * lying.x + flat.y * lying.y + flat.z * lying.z + flat.w * lying.w < 0 ? -ue : ue, k0 = 1 - ue;
      D.x = flat.x * k0 + lying.x * k1; D.y = flat.y * k0 + lying.y * k1; D.z = flat.z * k0 + lying.z * k1; D.w = flat.w * k0 + lying.w * k1;
      D.normalize().postMul(d.restModelQ[fb]);
      this.fkAbs(fb, D);
      this.fkDelta(tb, D.identity());
    }
    this.updateRifleDrop();
    this.fingersHold();
    this.twists();
  }

  /** Lowest body point above the floor (y − radius), model space, into this.low. */
  lowest() {
    const P = this.mp, d = this.def;
    const hd = this._v[6].copy(d.eyeR).scale(0.5).applyQ(this._q[3].mulConj(this.mq[B.head], d.restModelQ[B.head])).add(P[B.head]);
    let m = hd.y - 0.1;
    if (P[B.spine3].y - 0.13 < m) m = P[B.spine3].y - 0.13;
    if (P[B.spine2].y - 0.13 < m) m = P[B.spine2].y - 0.13;
    if (P[B.pelvis].y - 0.11 < m) m = P[B.pelvis].y - 0.11;
    if (P[B.upperArmL].y - 0.07 < m) m = P[B.upperArmL].y - 0.07;
    if (P[B.upperArmR].y - 0.07 < m) m = P[B.upperArmR].y - 0.07;
    this.low = m;
  }

  /**
   * Limp arms lie on the floor: a hand that would go through it, or (once he is
   * down) floats above it, is solved back onto it with the elbow up and out.
   */
  armsToFloor() {
    const v = this._v, q = this._q;
    let k = 0;
    if (this.landed) {
      k = (this.deathT - this.dropT * 0.5) / 0.6;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      k = k * k * (3 - 2 * k);
    }
    for (let side = 0; side < 2; side++) {
      const hb = side === 0 ? B.handL : B.handR, ub = side === 0 ? B.upperArmL : B.upperArmR, lb = side === 0 ? B.lowerArmL : B.lowerArmR;
      const hand = this.mp[hb], elbow = this.mp[lb];
      const want = 0.045;
      const low = hand.y < elbow.y + 0.01 ? hand.y : elbow.y + 0.01;
      if (low >= want && k <= 0) continue;
      let ty = hand.y;
      if (low < want) ty += want - low;
      ty += (want - ty) * k;
      const tgt = v[2];
      tgt.x = hand.x; tgt.y = ty; tgt.z = hand.z;
      const pole = v[3].subVectors(elbow, this.mp[ub]).rejectFrom(v[4].subVectors(hand, this.mp[ub]).normalize());
      pole.y += 0.05;
      const hq = q[3].copy(this.mq[hb]);
      this.ik(side, tgt, pole);
      this.fkAbs(hb, hq);
    }
  }

  /** Once down, bend the neck so the head rests on the floor too. */
  headToFloor() {
    const d = this.def, v = this._v, q = this._q;
    const hc = v[7].copy(d.eyeR).scale(0.5).applyQ(q[3].mulConj(this.mq[B.head], d.restModelQ[B.head])).add(this.mp[B.head]);
    const gap = hc.y - 0.1;
    if (gap < 0.01) return;
    const nk = this.mp[B.neck];
    const arm = v[8].subVectors(hc, nk);
    const L = Math.sqrt(arm.x * arm.x + arm.y * arm.y + arm.z * arm.z);
    if (L < 1e-3) return;
    // rotate about the horizontal axis perpendicular to the neck→head direction
    const axis = v[9].cross(arm, UP).normalize();
    if (axis.x * axis.x + axis.y * axis.y + axis.z * axis.z < 1e-6) return;
    let sn = gap / L;
    sn = sn > 1 ? 1 : sn;
    let ang = Math.asin(sn);
    ang = ang > 0.5 ? 0.5 : ang;
    const hs = -ang * 0.5, s = Math.sin(hs);
    const r = q[4];
    r.x = axis.x * s; r.y = axis.y * s; r.z = axis.z * s; r.w = Math.cos(hs);
    this.mq[B.neck].preMul(r);
    this.mq[B.head].preMul(r);
    this.mp[B.head].subVectors(this.mp[B.head], nk).applyQ(r).add(nk);
  }

  updateRifleDrop() {
    if (!this.rifleFree) return;
    const dt = this.dt;
    this.rifleT += dt;
    const t = this.rifleT, rv = this.rV;
    // ballistic until the lowest end reaches the floor, rotating toward lying flat
    let k = t / 0.55;
    k = k > 1 ? 1 : k;
    k = k * k * (3 - 2 * k);
    const a = this.rQ0, b = this.rQ1, RQ = this.rifleQ, k0 = 1 - k;
    const k1 = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -k : k;
    RQ.x = a.x * k0 + b.x * k1; RQ.y = a.y * k0 + b.y * k1; RQ.z = a.z * k0 + b.z * k1; RQ.w = a.w * k0 + b.w * k1;
    RQ.normalize();
    const tt = t < 1.5 ? t : 1.5, RP = this.rifleP;
    RP.x = this.rP0.x + rv.x * tt; RP.y = this.rP0.y + rv.y * tt - 4.9 * tt * tt; RP.z = this.rP0.z + rv.z * tt;
    // floor contact: lift so the rifle's lowest sample point is on the floor
    const R = this.def.rifle, v = this._v[10];
    let low = Infinity;
    for (let i = 0; i < 4; i++) {
      if (i === 0) v.copy(R.muzzle); else if (i === 1) v.copy(R.butt); else if (i === 2) v.copy(MAG_TIP); else v.copy(SIGHT_TOP);
      v.applyQ(RQ).add(RP);
      if (v.y < low) low = v.y;
    }
    if (low < 0.025) {
      RP.y += 0.025 - low;
      // stop sliding once it has landed
      if (t > 0.3) { this.rP0.x = RP.x - rv.x * tt; this.rP0.z = RP.z - rv.z * tt; rv.x *= 0.85; rv.z *= 0.85; }
    }
  }

  // ───────────────────────────────────────────────────────────── FK helpers

  /**
   * Rotation from the angles in this.E = [pitch about +X, yaw about +Y, roll
   * about +Z]: pitch first, then roll, then yaw (D = Y·Z·X). Angles come in a
   * typed array because doubles passed to a method V8 does not inline are boxed.
   * @param {Q} out
   */
  euler(out) {
    const hp = this.E[0] * 0.5, hy = this.E[1] * 0.5, hr = this.E[2] * 0.5;
    const cp = Math.cos(hp), sp = Math.sin(hp), cy = Math.cos(hy), sy = Math.sin(hy), cr = Math.cos(hr), sr = Math.sin(hr);
    // Y·Z = (0, sy, 0, cy)·(0, 0, sr, cr)
    const ax = sy * sr, ay = sy * cr, az = cy * sr, aw = cy * cr;
    // (Y·Z)·X with X = (sp, 0, 0, cp)
    out.x = ax * cp + aw * sp;
    out.y = ay * cp + az * sp;
    out.z = az * cp - ay * sp;
    out.w = aw * cp - ax * sp;
    return out;
  }

  /**
   * Bone b gets delta D (model axes, in the parent's moved frame).
   * @param {number} b @param {Q} D
   */
  fkDelta(b, D) {
    const d = this.def, p = d.parent[b], q = this._q[8];
    // Δparent · D · restModelQ[b]
    q.mulConj(this.mq[p], d.restModelQ[p]);
    this.mq[b].mul(q, D).postMul(d.restModelQ[b]);
    this.mp[b].copy(d.restLocalT[b]).applyQ(this.mq[p]).add(this.mp[p]);
  }

  /** Bone b gets an absolute model rotation. @param {number} b @param {Q} M */
  fkAbs(b, M) {
    const d = this.def, p = d.parent[b];
    this.mq[b].copy(M);
    this.mp[b].copy(d.restLocalT[b]).applyQ(this.mq[p]).add(this.mp[p]);
  }

  writeLocals() {
    const d = this.def;
    this.lq[B.pelvis].conjMul(d.baseQ, this.mq[B.pelvis]);
    this.pelvisLocal.subVectors(this.mp[B.pelvis], d.baseP).applyQInv(d.baseQ);
    for (let b = 1; b < CORE_COUNT; b++) this.lq[b].conjMul(this.mq[d.parent[b]], this.mq[b]);
  }

  // ───────────────────────────────────────────────────────────── outputs

  /**
   * Model point → world (into out).
   * @param {V3} m @param {V3} out
   */
  toWorld(m, out) {
    const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
    const x = m.x, z = m.z;
    out.set(this.rootX + x * c + z * s, this.rootY + m.y, this.rootZ - x * s + z * c);
    return out;
  }

  /**
   * Muzzle position and bore direction in world space.
   * @param {V3} pos @param {V3} dir
   */
  muzzle(pos, dir) {
    const R = this.def.rifle;
    const m = this._v[13].copy(R.muzzle).applyQ(this.rifleQ).add(this.rifleP);
    this.toWorld(m, pos);
    const f = this._v[14].set(0, 0, -1).applyQ(this.rifleQ);
    const c = Math.cos(this.rootYaw), s = Math.sin(this.rootYaw);
    dir.set(f.x * c + f.z * s, f.y, -f.x * s + f.z * c);
    return pos;
  }
}
