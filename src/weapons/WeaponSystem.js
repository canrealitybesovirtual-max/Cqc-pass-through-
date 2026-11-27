// @ts-check
import * as THREE from 'three';
import { getDef } from './WeaponDefs.js';
import { WeaponInstance, CHAMBER_LIVE, HOME_RACK, HOME_RELEASE } from './WeaponInstance.js';
import { Recoil } from './Recoil.js';
import { WeaponView } from './WeaponView.js';
import { WeaponFX } from './WeaponFX.js';
import { BodyEstimator } from '../player/BodyEstimator.js';
import {
  Carry, GrabSense, SLOTS, arcPoint, pointDist, segmentDist,
  CARRY_SLOT, CARRY_DRAW, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP, CARRY_SHRINK, CARRY_GROW, EV_STOWED,
} from '../player/Slots.js';
import { HANDLING, MagWell, MAG_FREE, MAG_GUIDED, TriggerGate, HapticGate, rackFraction, boreAtThighs } from '../player/Handling.js';

/**
 * The `weapons` system (CONTRACTS.md "W2"): both guns, the body slots, the
 * hands on the guns, shots, effects and haptics. Allocation-free per frame.
 *
 * Controls (right hand = gun hand):
 * - Right grip at the right hip draws the Glock; over the right shoulder
 *   takes the AKM off the back. Let go near the slot to put it back.
 * - Right trigger fires (bore at the moment the trigger breaks, through
 *   `ctx.raycast`). A = magazine release; A again with the magazine out =
 *   assisted reload (1.2 s, for testing). B = slide release. Right stick
 *   click = AKM selector (safe → auto → semi).
 * - Left grip at the left-hip pouch takes a fresh magazine; bring it to the
 *   well, aligned, and push it home. Left grip on the slide's rear / the
 *   AKM's charging handle racks (the slide follows the hand along its axis).
 *   Left grip on the AKM handguard: two-handed (the aim runs from the right
 *   grip to the left hand, recoil × 0.55); on the Glock, cupping the right
 *   hand: two-handed recoil.
 *
 * Integration:
 *   const weapons = new WeaponSystem(ctx, { fpScene });   // at load, after assets; adds its own objects
 *   warm-up: weapons.setWarm(true) … draw … weapons.setWarm(false); weapons.warmMeshes()
 *   `weapons` system: weapons.update(dt, t, frame, ctx) (after `player`)
 *   HUD: weapons.ammo() → { weapon, mag, chambered } (one reused object)
 * It listens to `pause` (no firing while paused; the guns still follow the
 * hands) and emits `shot` and `enemyHit` (reused payloads). Pass
 * `{ enemies }` to also call enemies.applyHit for each enemy hit.
 */

/** Haptics [strength, ms] (contract + CQC mechPulse table). */
export const HAPTIC = Object.freeze({
  shot: Object.freeze([1.0, 45]),
  shotSupport: Object.freeze([0.65, 35]),
  battery: Object.freeze([0.3, 14]),
  rack: Object.freeze([0.55, 22]),
  rackPrimary: Object.freeze([0.25, 14]),
  home: Object.freeze([0.75, 26]),
  release: Object.freeze([0.7, 26]),
  eased: Object.freeze([0.3, 16]),
  magCatch: Object.freeze([0.28, 12]),
  magIn: Object.freeze([0.55, 30]),
  magInPrimary: Object.freeze([0.4, 25]),
  selector: Object.freeze([0.18, 9]),
  dry: Object.freeze([0.2, 12]),
  pouch: Object.freeze([0.4, 25]),
  support: Object.freeze([0.3, 14]),
});

export const SYSTEM = Object.freeze({
  range: 100,               // m hitscan range indoors
  magPush: 0.6,             // m/s a released magazine leaves the well (design)
  glockCup: 0.09,           // m: left grip this close to the right grip cups the Glock (design)
  glockCupSlip: 0.15,
  assistShow: 0.15,         // s: the assisted reload's magazine slides in over the last of it
  assistDepth: 0.08,        // m
  dropRest: 0.04,           // m a dropped gun's root rests above the floor while it waits to return
});

const LEFT = 0, RIGHT = 1;
const L_NONE = 0, L_RACK = 1, L_SUPPORT = 2, L_MAG = 3;

/**
 * Grip-space pose inside the aim-ray space for Quest Touch Plus controllers,
 * from Meta's IWER emulator profile (meta-quest-touch-plus gripOffsetMatrix,
 * column-major). Used only as a fallback for frames with a grip pose but no
 * ray pose before both have been seen together; then the live relation is used.
 */
const IWER_GRIP_IN_RAY = Object.freeze({
  left: [0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1],
  right: [0.99255, 0, 0.12187, 0, -0.08617, 0.70711, 0.70184, 0, -0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1],
});

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _ZN = new THREE.Vector3(0, 0, -1);
const _XA = new THREE.Vector3(1, 0, 0);
const _YA = new THREE.Vector3(0, 1, 0);
const _arc = new Float64Array(3);
const _slot = new Float64Array(3);
const _side = new Float64Array(3);

/** One controller as the weapons see it. */
class Hand {
  /** @param {'left'|'right'} side */
  constructor(side) {
    this.ok = false;
    this.pos = new THREE.Vector3();
    /** Aim-ray orientation (the hand frame guns are held in). */
    this.quat = new THREE.Quaternion();
    this.gripQuat = new THREE.Quaternion();
    /** grip → ray rotation (learned live; IWER profile until then) */
    this.rel = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(IWER_GRIP_IN_RAY[side])).invert();
    this.vel = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.hadPrev = false;
    this.lostT = 0;
    this.sense = new GrabSense();
    this.hap = new HapticGate();
  }
}

/** One weapon: mechanism, recoil, view, carry state and poses. */
class Weapon {
  /**
   * @param {'glock'|'akm'} id @param {WeaponView} view @param {number} bit grab-zone bit
   */
  constructor(id, view, bit) {
    this.id = id;
    this.def = getDef(id);
    this.view = view;
    this.fit = view.fit;
    this.inst = new WeaponInstance(this.def);
    this.recoil = new Recoil(this.def.recoil);
    this.carry = new Carry();
    this.gate = new TriggerGate();
    this.well = new MagWell(view.fit.magWindow);
    this.bit = bit;
    /** Slot frame in the world: palm point and gun orientation. */
    this.slotP = new THREE.Vector3();
    this.slotQ = new THREE.Quaternion();
    /** Base pose of the gun root (no recoil). */
    this.bp = new THREE.Vector3();
    this.bq = new THREE.Quaternion();
    /** Hand and slot poses of the gun root. */
    this.hp = new THREE.Vector3();
    this.hq = new THREE.Quaternion();
    this.sp = new THREE.Vector3();
    this.sq = new THREE.Quaternion();
    /** Pose when let go (holster arc start, drop). */
    this.relP = new THREE.Vector3();
    this.relQ = new THREE.Quaternion();
    this.dropV = new THREE.Vector3();
    /** Gun velocity (brass, magazines). */
    this.vel = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.hadPrev = false;
    this.assistT = -1;
    this.twoHand = false;
    this.scale = 1;
  }
}

export class WeaponSystem {
  /**
   * @param {{ scene: THREE.Object3D, assets: { models: any }, audio?: any, events?: any,
   *   gfx?: { flashLights?: THREE.PointLight[] }, world?: any }} ctx
   * @param {{ fpScene?: THREE.Object3D | null, enemies?: { applyHit?: (enemy: number, part: string, damage: number, dx: number, dy: number, dz: number) => void } | null, seed?: number }} [opts]
   */
  constructor(ctx, opts = {}) {
    const models = ctx.assets.models;
    this.fpRoot = new THREE.Group();
    this.fpRoot.name = 'w2-fp';
    this.worldRoot = new THREE.Group();
    this.worldRoot.name = 'w2-world';
    (opts.fpScene || ctx.scene).add(this.fpRoot);
    ctx.scene.add(this.worldRoot);

    const glockView = new WeaponView('glock', models.glock);
    const akmView = new WeaponView('akm', models.akm);
    this.glock = new Weapon('glock', glockView, 1);
    this.akm = new Weapon('akm', akmView, 2);
    /** @type {Weapon[]} */
    this.weapons = [this.glock, this.akm];
    for (const w of this.weapons) {
      this.fpRoot.add(w.view.root, w.view.handMag);
      w.view.root.visible = false;
      this._wire(w);
    }
    this.fx = new WeaponFX({
      worldRoot: this.worldRoot, fpRoot: this.fpRoot,
      light: ctx.gfx && ctx.gfx.flashLights ? ctx.gfx.flashLights[0] : null,
      views: { glock: glockView, akm: akmView },
    });
    this.body = new BodyEstimator();
    this.L = new Hand('left');
    this.R = new Hand('right');
    /** @type {Weapon|null} in the right hand */
    this.held = null;
    /** @type {Weapon} the weapon the pouch and the HUD refer to when the hand is empty */
    this.lastHeld = this.glock;
    this.lRole = L_NONE;
    /** @type {Weapon|null} the weapon the left hand's rack / support role works on */
    this.lWeapon = null;
    this.rackOffset = 0;
    /** @type {Weapon|null} whose magazine is in the left hand */
    this.handMag = null;
    this.handMagRounds = 0;
    this.enemies = opts.enemies || null;
    this.paused = false;
    this.now = 0;
    /** @type {any} */
    this.ctx = ctx;
    this.rand = (opts.seed ?? 0x51ed2701) | 0 || 1;

    /** One reused hit record (CONTRACTS "Hit"). */
    this.hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' };
    this.shotEv = { weapon: 'glock', x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
    this.hitEv = { enemy: -1, part: '', damage: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
    this._ammo = { weapon: /** @type {string|null} */ ('glock'), mag: -1, chambered: 0 };
    this.stats = { shots: 0, hits: 0, enemyHits: 0, draws: 0, reloads: 0 };

    this._mp = new THREE.Vector3();
    this._mq = new THREE.Quaternion();
    this._lp = new THREE.Vector3();
    this._lq = new THREE.Quaternion();
    this._warm = false;

    if (ctx.events && ctx.events.on) ctx.events.on('pause', (/** @type {any} */ p) => { this.paused = !!(p && p.paused); });
  }

  // ======================================================================= frame

  /**
   * @param {number} dt seconds @param {number} t ms @param {XRFrame|null|undefined} _frame
   * @param {any} ctx shared context (input, player, world, audio, events, raycast)
   */
  update(dt, t, _frame, ctx) {
    if (!(dt >= 0)) dt = 0;
    this.now = t / 1000;
    this.ctx = ctx;
    const I = ctx.input || null;
    this._readHand(this.L, I ? I.left : null, dt);
    this._readHand(this.R, I ? I.right : null, dt);

    const P = ctx.player || null, body = this.body;
    if (P && P.eye && P.quat && P.valid !== false) body.setHead(P.eye.x, P.eye.y, P.eye.z, P.quat.x, P.quat.y, P.quat.z, P.quat.w);
    body.setHand(LEFT, this.L.ok, this.L.pos.x, this.L.pos.y, this.L.pos.z, false);
    body.setHand(RIGHT, this.R.ok, this.R.pos.x, this.R.pos.y, this.R.pos.z, this.held !== null);
    body.update(dt, P && Number.isFinite(P.floorY) ? P.floorY : 0, P && P.standEye > 0 ? P.standEye : 1.65);
    this._slotFrames();

    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.carry.update(dt) === EV_STOWED) this._sound(w.id === 'glock' ? 'holsterIn' : 'cloth', w.slotP, 0.8);
    }
    this._right(dt, I);
    for (let i = 0; i < this.weapons.length; i++) this._base(this.weapons[i], dt);
    this._left(dt, I);
    const held = this.held;
    if (held && this.lRole === L_SUPPORT && this.lWeapon === held && held.id === 'akm' && held.carry.inHand && this.L.ok) {
      held.view.aimTwoHanded(held.bq, this.R.pos, this.L.pos, held.bp, HANDLING.supportMinSpan);
    }
    // the bore at the trigger break = base + the recoil so far
    for (let i = 0; i < this.weapons.length; i++) this._display(this.weapons[i]);
    if (held && held.carry.inHand) this._operate(held, dt, I);
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w !== held) w.inst.setTrigger(0);
      w.inst.update(dt);
      w.recoil.update(dt);
    }
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i], v = w.view;
      this._display(w);
      this._velocity(w, dt);
      if (v.magOut > 0 && w.assistT < 0) v.magOut = Math.max(0, v.magOut - HANDLING.magSlide * dt);
      if (w.assistT >= 0 && w.assistT < SYSTEM.assistShow) v.magOut = SYSTEM.assistDepth * (w.assistT / SYSTEM.assistShow);
      const inHand = w === held;
      v.updateParts(dt, w.inst, inHand && I ? I.right.trigger : 0, inHand && I ? I.right.a : false);
      v.mag.visible = w.inst.magSeated || (w.assistT >= 0 && w.assistT < SYSTEM.assistShow);
    }
    this._placeHandMag();
    this.fx.update(dt, this.now, ctx);
  }

  /**
   * @param {Hand} h @param {any} s Input hand state @param {number} dt
   */
  _readHand(h, s, dt) {
    h.ok = !!(s && s.present && s.hasGrip);
    if (!h.ok) { h.lostT += dt; h.hadPrev = false; return; }
    _m.fromArray(s.grip);
    h.pos.setFromMatrixPosition(_m);
    h.gripQuat.setFromRotationMatrix(_m);
    if (s.hasRay) {
      _m.fromArray(s.ray);
      h.quat.setFromRotationMatrix(_m);
      h.rel.copy(h.gripQuat).invert().multiply(h.quat);
    } else {
      h.quat.copy(h.gripQuat).multiply(h.rel);
    }
    if (!Number.isFinite(h.pos.x + h.pos.y + h.pos.z + h.quat.x + h.quat.y + h.quat.z + h.quat.w)) { h.ok = false; h.lostT += dt; h.hadPrev = false; return; }
    if (h.hadPrev && dt > 0) {
      _v.subVectors(h.pos, h.prev).multiplyScalar(1 / dt);
      if (_v.lengthSq() < 400) h.vel.lerp(_v, 1 - Math.exp(-dt * 25));
    } else h.vel.set(0, 0, 0);
    h.prev.copy(h.pos);
    h.hadPrev = true;
    h.lostT = 0;
  }

  /** Slot frames (world) from the body estimate. */
  _slotFrames() {
    const B = this.body, H = B.holster, K = B.back;
    this.glock.slotP.set(H.p[0], H.p[1], H.p[2]);
    this.glock.slotQ.set(H.q[0], H.q[1], H.q[2], H.q[3]);
    this.akm.slotP.set(K.p[0], K.p[1], K.p[2]);
    this.akm.slotQ.set(K.q[0], K.q[1], K.q[2], K.q[3]);
  }

  /**
   * Distance from a hand to a weapon's grab zone (holster point, or the
   * slung rifle's grip-to-butt line over the shoulder).
   * @param {Weapon} w @param {THREE.Vector3} p
   */
  _grabDist(w, p) {
    const B = this.body;
    return w.id === 'glock' ? pointDist(p.x, p.y, p.z, B.holster.p) : segmentDist(p.x, p.y, p.z, B.back.p, B.backAxis, SLOTS.backLen);
  }

  // ======================================================================= right hand

  /** @param {number} dt @param {any} I */
  _right(dt, I) {
    const R = this.R, s = I ? I.right : null;
    R.sense.update(dt, !!(s && s.squeezeDown), !!(s && s.squeezeHeld));
    const w = this.held;
    if (!w) {
      if (!R.ok || !this.body.valid) { R.sense.inside = 0; return; }
      /** @type {Weapon|null} */
      let best = null, bestD = Infinity;
      for (let i = 0; i < this.weapons.length; i++) {
        const x = this.weapons[i];
        const d = x.carry.grabbable ? this._grabDist(x, R.pos) : Infinity;
        const near = d <= SLOTS.grabReach;
        if (R.sense.enter(x.bit, near)) this._pulse(RIGHT, SLOTS.tick);
        if (near && d < bestD) { best = x; bestD = d; }
      }
      if (best && R.sense.wantsGrab) this._draw(best);
      return;
    }
    if (!w.carry.inHand) { this.held = null; return; }
    if (!(s && s.squeezeHeld)) this._letGo(w, false);
    else if (R.lostT > SLOTS.lostS) this._letGo(w, true);
  }

  /** @param {Weapon} w */
  _draw(w) {
    if (!w.carry.grab()) return;
    this.held = w;
    this.lastHeld = w;
    this.R.sense.consume();
    this.R.sense.inside = 0;
    w.gate.arm();
    w.recoil.reset();
    this.stats.draws++;
    this._pulse(RIGHT, SLOTS.draw);
    this._sound(w.id === 'glock' ? 'holsterOut' : 'cloth', w.slotP, 0.8);
  }

  /**
   * @param {Weapon} w @param {boolean} lost tracking lost: auto-holster
   */
  _letGo(w, lost) {
    const v = w.view;
    v.toWorld(v.palm, _v);
    const near = !lost && _v.distanceTo(w.slotP) <= SLOTS.slotReach;
    if (lost) w.carry.lost(); else w.carry.release(near);
    w.relP.copy(v.root.position);
    w.relQ.copy(v.root.quaternion);
    w.dropV.copy(this.R.vel);
    this._endLeftOn(w);
    w.inst.setTrigger(0);
    w.recoil.reset();
    w.assistT = -1;
    w.twoHand = false;
    this.held = null;
    if (near) this._pulse(RIGHT, SLOTS.holster);
  }

  // ======================================================================= poses

  /** @param {Weapon} w @param {number} dt */
  _base(w, dt) {
    const v = w.view, c = w.carry;
    v.slotPose(w.slotP, w.slotQ, w.sp, w.sq);
    if (c.inHand && this.R.ok) v.holdPose(this.R.pos, this.R.quat, w.hp, w.hq);
    w.scale = c.scale;
    switch (c.state) {
      case CARRY_DRAW: {
        const k = c.blend;
        w.bp.lerpVectors(w.sp, w.hp, k);
        w.bq.slerpQuaternions(w.sq, w.hq, k);
        break;
      }
      case CARRY_HAND:
        w.bp.copy(w.hp);
        w.bq.copy(w.hq);
        break;
      case CARRY_HOLSTER: {
        const k = c.blend, ys = this.body.yawS;
        _side[0] = Math.cos(ys); _side[1] = 0; _side[2] = -Math.sin(ys);
        _arc[0] = w.relP.x; _arc[1] = w.relP.y; _arc[2] = w.relP.z;
        _slot[0] = w.sp.x; _slot[1] = w.sp.y; _slot[2] = w.sp.z;
        arcPoint(_arc, _slot, k, _side, _arc, 0);
        w.bp.set(_arc[0], _arc[1], _arc[2]);
        w.bq.slerpQuaternions(w.relQ, w.sq, k);
        break;
      }
      case CARRY_DROP: {
        const fy = this._floorY(w.relP.x, w.relP.z) + SYSTEM.dropRest;
        if (dt > 0 && w.relP.y > fy) {
          w.dropV.y -= 9.81 * dt;
          w.relP.addScaledVector(w.dropV, dt);
          if (w.relP.y < fy) { w.relP.y = fy; w.dropV.set(0, 0, 0); }
        }
        w.bp.copy(w.relP);
        w.bq.copy(w.relQ);
        break;
      }
      case CARRY_SHRINK:
        w.bp.copy(w.relP);
        w.bq.copy(w.relQ);
        break;
      default:   // SLOT, GROW
        w.bp.copy(w.sp);
        w.bq.copy(w.sq);
        break;
    }
  }

  /** Display pose: base, plus recoil while in the hand. @param {Weapon} w */
  _display(w) {
    const v = w.view, r = w.recoil, root = v.root;
    if (w.carry.inHand && r.active) v.applyRecoil(w.bp, w.bq, r.back, r.pitch, r.yaw, root.position, root.quaternion);
    else { root.position.copy(w.bp); root.quaternion.copy(w.bq); }
    root.scale.setScalar(w.scale > 1e-3 ? w.scale : 1e-3);
    const st = w.carry.state;
    root.visible = this._warm || (st !== CARRY_SLOT && st !== CARRY_GROW) || this.body.valid;
  }

  /** @param {Weapon} w @param {number} dt */
  _velocity(w, dt) {
    const p = w.view.root.position;
    if (w.hadPrev && dt > 0) {
      _v.subVectors(p, w.prev).multiplyScalar(1 / dt);
      if (_v.lengthSq() < 400) w.vel.lerp(_v, 1 - Math.exp(-dt * 25)); else w.vel.set(0, 0, 0);
    }
    w.prev.copy(p);
    w.hadPrev = true;
  }

  /** @param {number} x @param {number} z */
  _floorY(x, z) {
    const W = this.ctx.world;
    const y = W && W.floorY ? W.floorY(x, z) : 0;
    return Number.isFinite(y) ? y : 0;
  }

  // ======================================================================= left hand

  /** @param {number} dt @param {any} I */
  _left(dt, I) {
    const L = this.L, s = I ? I.left : null;
    L.sense.update(dt, !!(s && s.squeezeDown), !!(s && s.squeezeHeld));
    const held = this.held && this.held.carry.inHand ? this.held : null;
    if (this.lRole !== L_NONE) {
      if (!(s && s.squeezeHeld) || L.lostT > SLOTS.lostS) { this._endLeft(); return; }
      if ((this.lRole === L_RACK || this.lRole === L_SUPPORT) && this.lWeapon !== held) { this._endLeft(); return; }
      if (this.lRole === L_SUPPORT && held && L.ok) {
        if (held.id === 'akm' && held.view.support) {
          held.view.toLocal(L.pos, held.bp, held.bq, _v);
          const sp = held.view.support;
          if (Math.hypot(_v.x - sp.x, _v.y - sp.y) > HANDLING.supportSlip || Math.abs(_v.z - sp.z) > 0.25) this._endLeft();
        } else if (L.pos.distanceTo(this.R.pos) > SYSTEM.glockCupSlip) this._endLeft();
      }
      return;
    }
    if (!(s && s.squeezeDown) || !L.ok) return;
    let role = L_NONE, best = 1;
    if (held) {
      const v = held.view;
      v.rackLocal(held.inst.slidePos, _v);
      _v.applyQuaternion(held.bq).add(held.bp);
      const dr = L.pos.distanceTo(_v) / HANDLING.rackReach;
      if (dr < best) { best = dr; role = L_RACK; }
      let ds = Infinity;
      if (held.id === 'akm' && v.support) {
        _v.copy(v.support).applyQuaternion(held.bq).add(held.bp);
        ds = L.pos.distanceTo(_v) / HANDLING.supportReach;
      } else if (held.id === 'glock') ds = L.pos.distanceTo(this.R.pos) / SYSTEM.glockCup;
      if (ds < best) { best = ds; role = L_SUPPORT; }
    }
    if (!this.handMag && this.body.valid) {
      const dp = pointDist(L.pos.x, L.pos.y, L.pos.z, this.body.pouch.p) / SLOTS.pouchReach;
      if (dp < best) { best = dp; role = L_MAG; }
    }
    if (role === L_RACK && held) {
      const v = held.view;
      v.toLocal(L.pos, held.bp, held.bq, _v);
      this.rackOffset = _v.dot(v.slideAxis) - held.inst.slidePos * v.travel;
      this.lRole = L_RACK;
      this.lWeapon = held;
    } else if (role === L_SUPPORT && held) {
      this.lRole = L_SUPPORT;
      this.lWeapon = held;
      this._pulse(LEFT, HAPTIC.support);
    } else if (role === L_MAG) {
      const w = held || this.lastHeld;
      this.lRole = L_MAG;
      this.handMag = w;
      this.handMagRounds = w.def.capacity;
      w.well.reset();
      w.view.handMag.visible = true;
      this._pulse(LEFT, HAPTIC.pouch);
      this._sound('cloth', L.pos, 0.6);
    }
  }

  /** The left hand lets go of whatever it does. */
  _endLeft() {
    if (this.lRole === L_RACK && this.lWeapon) this.lWeapon.inst.rackRelease();
    if (this.lRole === L_MAG && this.handMag) {
      const w = this.handMag, v = w.view;
      this.fx.dropMag(w.id, v.handMag.position, v.handMag.quaternion, this.L.vel, 3);
      v.handMag.visible = false;
      w.well.reset();
      this.handMag = null;
    }
    this.lRole = L_NONE;
    this.lWeapon = null;
  }

  /**
   * The gun left the right hand: end the left hand's rack or support on it (a magazine stays in hand).
   * @param {Weapon} w
   */
  _endLeftOn(w) {
    if ((this.lRole === L_RACK || this.lRole === L_SUPPORT) && this.lWeapon === w) this._endLeft();
  }

  // ======================================================================= the held gun

  /**
   * Rack, buttons, magazine, trigger (before the mechanism's update).
   * @param {Weapon} w @param {number} dt @param {any} I
   */
  _operate(w, dt, I) {
    const s = I ? I.right : null, inst = w.inst, v = w.view;
    w.twoHand = this.lRole === L_SUPPORT && this.lWeapon === w;
    // rack: the slide / carrier follows the left hand along its axis
    if (this.lRole === L_RACK && this.lWeapon === w && this.L.ok) {
      v.toLocal(this.L.pos, w.bp, w.bq, _v);
      _v2.copy(_v).sub(v.rackPoint);
      const along = _v2.dot(v.slideAxis);
      _v2.addScaledVector(v.slideAxis, -along);
      if (_v2.length() > HANDLING.rackSlip) this._endLeft();
      else inst.rackPull(rackFraction(_v.dot(v.slideAxis), this.rackOffset, v.travel));
    }
    if (s) {
      if (s.aDown) {
        if (inst.magSeated) { this._pulse(RIGHT, HAPTIC.magCatch); inst.magRelease(); }
        else if (w.assistT < 0) w.assistT = HANDLING.assistS;
      }
      if (s.bDown) inst.slideRelease();
      if (s.stickDown) inst.selector();
    }
    if (w.assistT >= 0) {
      if (inst.magSeated) w.assistT = -1;
      else {
        w.assistT -= dt;
        if (w.assistT <= 0) { w.assistT = -1; v.magOut = 0; this.stats.reloads++; inst.magInsert(w.def.capacity); }
      }
    }
    this._seatCheck(w);
    // trigger, behind the draw gate (the muzzle must clear where it sat in the slot)
    const trig = s ? s.trigger : 0;
    v.toWorld(v.muzzle, _v);
    v.dirWorld(_ZN, _v2);
    const atThigh = this.body.valid && boreAtThighs(_v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, this.body.thighs);
    _v3.copy(v.muzzle).applyQuaternion(w.sq).add(w.sp);
    const open = w.gate.update(trig, _v.distanceTo(_v3), atThigh);
    inst.setTrigger(open && w.carry.state === CARRY_HAND && !this.paused ? trig : 0);
  }

  /**
   * The magazine in the left hand against the held gun's well.
   * @param {Weapon} w
   */
  _seatCheck(w) {
    if (this.lRole !== L_MAG || this.handMag !== w || !this.L.ok) return;
    const v = w.view;
    if (w.inst.magSeated) { w.well.state = MAG_FREE; return; }
    v.handMagPose(this.L.pos, this.L.quat, this._mp, this._mq);
    v.toLocal(this._mp, w.bp, w.bq, _v).sub(v.magSeat);
    _q.copy(w.bq).invert().multiply(this._mq);
    _v2.copy(v.magAxis).applyQuaternion(_q);
    const dot = _v2.dot(v.magAxis);
    w.well.update(_v.x, _v.y, _v.z, v.magAxis.x, v.magAxis.y, v.magAxis.z, dot);
    if (w.well.home) {
      v.magOut = Math.max(0, -w.well.along);
      v.handMag.visible = false;
      this.handMag = null;
      this.lRole = L_NONE;
      w.assistT = -1;
      this.stats.reloads++;
      w.inst.magInsert(this.handMagRounds);
      w.well.reset();
      this._pulse(LEFT, HAPTIC.magIn);
      this._pulse(RIGHT, HAPTIC.magInPrimary);
    }
  }

  /** The magazine in the left hand: free in the hand, or guided by the well. */
  _placeHandMag() {
    const w = this.handMag;
    if (!w || this.lRole !== L_MAG) return;
    const v = w.view, m = v.handMag;
    if (w === this.held && w.well.state === MAG_GUIDED) {
      v.guidedMagLocal(w.well.along, this._lp, this._lq);
      v.localToWorldPose(this._lp, this._lq, v.root.position, v.root.quaternion, m.position, m.quaternion);
    } else if (this.L.ok) {
      v.handMagPose(this.L.pos, this.L.quat, m.position, m.quaternion);
    }
    m.visible = true;
  }

  // ======================================================================= mechanism callbacks

  /** @param {Weapon} w */
  _wire(w) {
    const I = w.inst, S = w.def.sounds;
    I.onFire = () => this._fire(w);
    I.onDry = () => { this._soundAt(w, S.dry, 1); this._pulse(RIGHT, HAPTIC.dry); };
    I.onReset = () => { this._soundAt(w, S.reset, 0.5); };
    I.onEject = (_i, live) => this._eject(w, live);
    I.onMagOut = () => this._magOut(w);
    I.onMagIn = () => { this._soundAt(w, S.magIn, 1); };
    I.onChamber = (_i, cycled) => { if (cycled && w.inst.mode !== 'auto') this._pulse(RIGHT, HAPTIC.battery); };
    I.onRack = () => { this._soundAt(w, S.rackBack, 1); this._pulse(LEFT, HAPTIC.rack); this._pulse(RIGHT, HAPTIC.rackPrimary); };
    I.onHome = (_i, kind) => {
      if (kind === HOME_RACK) { this._soundAt(w, S.rackFwd, 1); this._pulse(RIGHT, HAPTIC.home); }
      else if (kind === HOME_RELEASE) { this._soundAt(w, S.slideRelease, 1); this._pulse(RIGHT, HAPTIC.release); }
      else { this._soundAt(w, S.rackFwd, 0.35); this._pulse(RIGHT, HAPTIC.eased); }
    };
    // No selector recording exists: the trigger-reset click stands in for the lever's detent.
    I.onSelector = () => { this._soundAt(w, 'dryReset', 0.9); this._pulse(RIGHT, HAPTIC.selector); };
  }

  /**
   * A round fired: the bore at this moment is the shot line.
   * @param {Weapon} w
   */
  _fire(w) {
    const v = w.view, ctx = this.ctx, fit = w.fit;
    // muzzle and shot direction (zeroed bore line plus mechanical dispersion)
    v.toWorld(v.muzzle, _v);
    const r = fit.spread * Math.sqrt(this.random()), a = this.random() * Math.PI * 2;
    _v2.copy(v.shotDir).addScaledVector(_XA, r * Math.cos(a)).addScaledVector(_YA, r * Math.sin(a)).normalize();
    v.dirWorld(_v2, _v2);
    const E = this.shotEv;
    E.weapon = w.id;
    E.x = _v.x; E.y = _v.y; E.z = _v.z; E.dx = _v2.x; E.dy = _v2.y; E.dz = _v2.z;
    this.stats.shots++;
    if (ctx.events && ctx.events.emit) ctx.events.emit('shot', E);
    this._sound(w.def.sounds.shot, _v, 1);
    this.fx.flash(v, this.now);
    w.recoil.fire(w.twoHand);
    this._pulse(RIGHT, HAPTIC.shot);
    if (w.twoHand) this._pulse(LEFT, HAPTIC.shotSupport);
    // hitscan from the breech face along the shot line (a muzzle through a wall still hits the wall)
    const H = this.hit, o = v.root.position;
    H.kind = 'none'; H.enemy = -1; H.part = ''; H.surface = ''; H.dist = 0;
    let got = false;
    if (typeof ctx.raycast === 'function') got = ctx.raycast(o.x, o.y, o.z, _v2.x, _v2.y, _v2.z, SYSTEM.range, H, -1);
    else if (ctx.world && ctx.world.raycast) got = ctx.world.raycast(o.x, o.y, o.z, _v2.x, _v2.y, _v2.z, SYSTEM.range, H);
    if (!got) return;
    this.stats.hits++;
    if (H.kind === 'enemy') {
      const dmg = /** @type {any} */ (w.def.damage)[H.part] ?? w.def.damage.limb;
      const p = this.hitEv;
      p.enemy = H.enemy; p.part = H.part; p.damage = dmg;
      p.x = H.x; p.y = H.y; p.z = H.z; p.dx = _v2.x; p.dy = _v2.y; p.dz = _v2.z;
      this.stats.enemyHits++;
      if (this.enemies && this.enemies.applyHit) this.enemies.applyHit(H.enemy, H.part, dmg, _v2.x, _v2.y, _v2.z);
      if (ctx.events && ctx.events.emit) ctx.events.emit('enemyHit', p);
    } else {
      this.fx.decal(H, fit.decal, fit.hole);
      _v3.set(H.x, H.y, H.z);
      this._sound('impactWall', _v3, 0.9);
    }
  }

  /**
   * A case or a live round leaves the ejection port.
   * @param {Weapon} w @param {boolean} _live
   */
  _eject(w, _live) {
    const v = w.view, fit = w.fit;
    v.toWorld(v.port, _v);
    v.dirWorld(v.ejectDir, _v2).multiplyScalar(fit.brassSpeed * (0.85 + 0.3 * this.random())).add(w.vel);
    this.fx.eject(_v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, v.root.quaternion, fit.caseRL, w.def.sounds.brass);
  }

  /**
   * The magazine catch let the magazine go: it falls out of the well.
   * @param {Weapon} w
   */
  _magOut(w) {
    const v = w.view;
    _v3.copy(v.magSeat).addScaledVector(v.magAxis, -v.magOut);
    v.toWorld(_v3, _v);
    v.dirWorld(v.magAxis, _v2).multiplyScalar(-SYSTEM.magPush).add(w.vel);
    this.fx.dropMag(w.id, _v, v.root.quaternion, _v2, 1.5);
    v.magOut = 0;
    this._soundAt(w, w.def.sounds.magOut, 1);
  }

  // ======================================================================= helpers

  /** Uniform [0, 1) from a private xorshift32. */
  random() {
    let x = this.rand;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rand = x;
    return (x >>> 0) / 4294967296;
  }

  /**
   * @param {number} hand LEFT | RIGHT @param {readonly number[]} hp [strength, ms]
   */
  _pulse(hand, hp) {
    const I = this.ctx && this.ctx.input;
    const s = I ? (hand === RIGHT ? I.right : I.left) : null;
    const src = s && s.source, gp = src && src.gamepad;
    const act = gp && gp.hapticActuators && gp.hapticActuators[0];
    if (!act || typeof act.pulse !== 'function') return;
    const h = hand === RIGHT ? this.R : this.L;
    if (!h.hap.allow(this.now, hp[0], hp[1])) return;
    try { act.pulse(hp[0], hp[1]); } catch { /* no haptics here */ }
  }

  /**
   * @param {string} key @param {THREE.Vector3} p @param {number} gain
   */
  _sound(key, p, gain) {
    const a = this.ctx && this.ctx.audio;
    if (a && typeof a.play === 'function' && key) a.play(key, p.x, p.y, p.z, gain, 1);
  }

  /** @param {Weapon} w @param {string} key @param {number} gain */
  _soundAt(w, key, gain) { this._sound(key, w.view.root.position, gain); }

  // ======================================================================= public

  /** Ammo of the gun in hand (or the last one held), for the HUD: one reused object. */
  ammo() {
    const w = this.held || this.lastHeld, o = this._ammo;
    o.weapon = w ? w.id : null;
    o.mag = w && w.inst.magSeated ? w.inst.magRounds : -1;
    o.chambered = w && w.inst.chamber === CHAMBER_LIVE ? 1 : 0;
    return o;
  }

  /**
   * New round: both guns re-issued (full magazine + one chambered; AKM on
   * safe), effects cleared. A gun in the hand stays in the hand.
   */
  reset() {
    if (this.lRole !== L_NONE) {
      if (this.handMag) { this.handMag.view.handMag.visible = false; this.handMag = null; }
      this.lRole = L_NONE;
      this.lWeapon = null;
    }
    for (const w of this.weapons) {
      w.inst.reset();
      w.recoil.reset();
      w.well.reset();
      w.assistT = -1;
      w.view.magOut = 0;
      if (w !== this.held) w.carry.stow();
    }
    this.fx.reset();
  }

  /** Meshes for the warm-up compile and draw. */
  warmMeshes() {
    /** @type {THREE.Object3D[]} */
    const out = [];
    for (const w of this.weapons) out.push(w.view.root, w.view.handMag);
    return out.concat(this.fx.warmMeshes());
  }

  /** Textures to upload in the warm-up (the gun textures come from assets.textures()). */
  textures() { return []; }

  /**
   * Show every mesh (frustum culling off) for the warm-up, then restore.
   * @param {boolean} on
   */
  setWarm(on) {
    this._warm = on;
    for (const w of this.weapons) {
      const v = w.view;
      v.root.visible = on || v.root.visible;
      v.handMag.visible = on ? true : this.handMag === w && this.lRole === L_MAG;
      for (const m of [v.gun, v.mag, v.handMag]) m.frustumCulled = !on;
      if (!on) v.root.visible = this.body.valid || w.carry.state !== CARRY_SLOT;
    }
    this.fx.setWarm(on);
  }
}
