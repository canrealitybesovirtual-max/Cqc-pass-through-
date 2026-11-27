// @ts-check
import * as THREE from 'three';
import { getDef } from './WeaponDefs.js';
import { WeaponInstance, CHAMBER_LIVE, HOME_RACK, HOME_RELEASE, SLIDE_LOCKED } from './WeaponInstance.js';
import { Recoil } from './Recoil.js';
import { WeaponView } from './WeaponView.js';
import { WeaponFX, Rng } from './WeaponFX.js';
import { BodyEstimator } from '../player/BodyEstimator.js';
import {
  Carry, GrabSense, SLOTS, arcPoint, pointDist, segmentDist,
  CARRY_SLOT, CARRY_DRAW, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP, CARRY_SHRINK, CARRY_GROW, CARRY_FREE, EV_STOWED,
} from '../player/Slots.js';
import { PoseHistory } from '../physics/PoseHistory.js';
import { PhysicsWorld, ReleaseInfo, ST_LOST, ST_FREE as PST_FREE } from '../physics/PhysicsWorld.js';
import { loadRapier } from '../physics/Rapier.js';
import { ITEMS, releaseKind, REL_HOLSTER, landingClass, landingGain, LAND_NONE } from '../physics/ItemRules.js';
import { itemKinds, K_GLOCK, K_GLOCK_NOMAG, K_AKM, K_AKM_NOMAG, K_MAG9, K_MAG762 } from '../physics/ItemShapes.js';
import { staticFromWorld, SURF } from '../physics/StaticGeometry.js';
import { LooseMags, LOOSE } from './LooseItems.js';
import { HANDLING, MagWell, MAG_FREE, MAG_GUIDED, TriggerGate, HapticGate, rackFraction, boreAtThighs } from '../player/Handling.js';
import { computeFit, parseFits, serializeFits, clampAdj, zeroAdj, FIT_KEY } from './GunFit.js';
import { makeHolsterShell } from './Holster.js';


/**
 * The `weapons` system (CONTRACTS.md "W2"): both guns, the body slots, the
 * hands on the guns, shots, effects and haptics. Allocation-free per frame.
 *
 * Controls (right hand = gun hand; v0.3 = CQC's Quest map, see Controls.js):
 * - Right grip at the right hip draws the Glock (seated: on the right thigh);
 *   over the right shoulder takes the AKM off the back (slung out of sight).
 *   Let go near the slot to put it back.
 * - Right trigger fires (bore at the moment the trigger breaks, through
 *   `ctx.raycast`).
 * - A, or X with the left hand on the gun: magazine release (it leaves the
 *   well at 1.1 m/s, CQC). B, or Y with the left hand on the gun: Glock slide
 *   release; AKM selector (lever order, wrapping: safe → auto → semi → safe;
 *   issued on semi). Right stick click = selector too. Test aid: hold A 0.8 s
 *   with no magazine = assisted reload (1.2 s). Empty hands: face buttons do
 *   nothing here.
 * - Left grip at the left-hip pouch takes a fresh magazine; bring it to the
 *   well, aligned, and push it home. A free left hand squeezing the lower
 *   75 % of the AKM's seated magazine strips it into the hand (CQC MAG_STRIP).
 *   Left grip on the slide's rear / the AKM's charging handle racks (reach
 *   0.085 / 0.10 m, +0.02 unchambered or locked; a tick when a free hand
 *   comes into reach). Left grip on the AKM handguard: two-handed (the aim
 *   runs from the right grip to the left hand, recoil × 0.55); on the Glock,
 *   cupping the right hand: two-handed recoil.
 * - Guns are held in GRIP space (GunFit; the player's nudges via setFit).
 *   A held gun whose bore would pass through a world shape (grip → muzzle
 *   ray) slides back along the bore, with a haptic tick.
 * - Real-surface physics (v0.4, `attachPhysics`): let go anywhere and the gun
 *   falls, lands and stays where a real one would (the bed, the couch, a
 *   table, the floor); a nearly still hand sets it down with no velocity, a
 *   moving one drops or throws it (PoseHistory: recency-weighted, ω × r).
 *   Let go near the holster / over the shoulder holsters or slings it; the
 *   holster only when no real surface is within 3 cm below (laid on the bed
 *   beside the hip) and the muzzle is within 60° of its axis. The right grip
 *   within 0.13 m of a lying gun's grip (or 0.05 m of its box) picks it up
 *   (the same 0.15 s draw blend from where it lies). Magazines (dropped with A
 *   / X or let go from the left hand) are physics items carrying their
 *   rounds; the left grip within 0.10 m picks one up; a magazine let go at the
 *   pouch goes back into it. Only the lost-object net (10 s outside the
 *   house) returns an item. With physics off, failed, or not built yet, the
 *   v0.3 rules stay (timed return to the slot, ballistic magazines).
 *
 * Integration:
 *   const weapons = new WeaponSystem(ctx, { fpScene });   // at load, after assets; adds its own objects
 *   warm-up: weapons.setWarm(true) … draw … weapons.setWarm(false); weapons.warmMeshes()
 *   `weapons` system: weapons.update(dt, t, frame, ctx) (after `player`)
 *   HUD: weapons.ammo() → { weapon, mag, chambered, mode } (one reused object; mode 'safe' | 'semi' | 'auto')
 *   Fit: weapons.loadFits(localStorage[FIT_KEY]) at load; setFit(id, {pitch, up, fwd}, source) any time
 *   (allocation-free); fitsJSON() to save (outside the frame loop); fitReport() for the record.
 *   Game / watch: busyLeft, busyRight, onGunLeft (face buttons belong to the gun then); body.seated;
 *   triggerBlocked (the watch has the trigger: no shot); fitHold(id | null) for the watch's GUN FIT page.
 *   Physics (v0.4): weapons.attachPhysics(physics) at load, before physics.warmUp() (it defines the item
 *   kinds from the GLB vertices); the static colliders follow the world's builds by themselves (a new
 *   world.layout → beginStatic, then buildSlice within SYSTEM.physSliceMs a frame); the step runs inside
 *   update(). weapons.realignItems(m) next to world.realign(m); weapons.physicsReport() at session end.
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
  rackHover: Object.freeze([0.12, 12]),   // CQC: a free hand comes into rack reach
  strip: Object.freeze([0.35, 25]),       // CQC stripMag
  wall: Object.freeze([0.15, 10]),        // the held gun meets a wall (design)
});

export const SYSTEM = Object.freeze({
  range: 100,               // m hitscan range indoors
  magPush: 1.1,             // m/s a released magazine leaves the well (CQC)
  assistHoldS: 0.8,         // s holding A with no magazine starts the assisted reload (test aid)
  rackReach: Object.freeze({ glock: 0.085, akm: 0.10 }),   // m (CQC defs)
  rackOpenBonus: 0.02,      // m more reach when unchambered or locked open (CQC rackReachOf)
  stripReach: 0.06,         // m left hand to the seated AKM magazine (CQC MAG_STRIP)
  stripBand: 0.75,          // lower fraction of the magazine that counts
  stripBlendS: 0.08,        // s the stripped magazine moves into the hand
  wallMargin: 0.02,         // m kept between the muzzle and a wall
  wallMaxPush: 0.3,         // m
  wallTickMin: 0.006,       // m of push that ticks
  wallRelax: 14,            // 1/s the gun slides forward again
  glockCup: 0.09,           // m: left grip this close to the right grip cups the Glock (design)
  glockCupSlip: 0.15,
  assistShow: 0.15,         // s: the assisted reload's magazine slides in over the last of it
  assistDepth: 0.08,        // m
  dropRest: 0.04,           // m a dropped gun's root rests above the floor while it waits to return
  physSliceMs: 4,           // ms a frame for the static collider build (behind the panel or a pause)
  magTumble: 1.5,           // rad/s a magazine dropped from the well tumbles (design)
});

const LEFT = 0, RIGHT = 1;
const L_NONE = 0, L_RACK = 1, L_SUPPORT = 2, L_MAG = 3, L_STRIP = 4, L_PICK = 5;
/** GrabSense bit of the left hand's rack zone (hover tick). */
const RACK_BIT = 4;

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
    /** Session sum of the learned grip → ray rotation (sign-aligned), for the record. */
    this.relSum = new Float64Array(4);
    this.relN = 0;
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
    /** The A press that is held began with no magazine seated (the assisted-reload test aid). */
    this.aNoMag = false;
    this.twoHand = false;
    this.scale = 1;
    /** Floor under the let-go point (a dropped gun rests on it until it returns). */
    this.dropFloor = 0;
    /** The player's grip-fit nudges (GunFit). */
    this.fitAdj = zeroAdj();
    /** m the held gun is slid back from a wall, and whether it is touching (tick once). */
    this.wallPush = 0;
    this.wallTouch = false;
    /** Physics item id while it lies in the world (CARRY_FREE), else -1. */
    this.physId = -1;
    /** Recent poses in the hand (the throw estimate and the penetration-safe placement). */
    this.hist = new PoseHistory();
    /** Time of its last landing sound (s). */
    this.lastSoundT = -1;
  }
}

export class WeaponSystem {
  /**
   * @param {{ scene: THREE.Object3D, assets: { models: any }, audio?: any, events?: any,
   *   gfx?: { flashLights?: THREE.PointLight[] }, world?: any }} ctx
   * @param {{ fpScene?: THREE.Object3D | null, enemies?: { applyHit?: (enemy: number, part: string, damage: number, dx: number, dy: number, dz: number) => void } | null, seed?: number,
   *   physics?: import('../physics/PhysicsWorld.js').PhysicsWorld | null }} [opts] physics: attach at once (else attachPhysics / initPhysics)
   */
  constructor(ctx, opts = {}) {
    /** Left glove on the AKM handguard: off until it is re-posed to wrap the handguard (v0.3). */
    this.supportGlove = false;
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
    /** The Glock's holster shell: at the holster socket every frame, drawn or not. */
    this.holster = makeHolsterShell();
    this.holster.visible = false;
    this.fpRoot.add(this.holster);
    /** 'default' | 'saved' | 'url' | 'edit' — where the current grip fit came from. */
    this.fitSource = 'default';
    this.fitEdits = 0;
    this._pose7 = new Float64Array(7);
    this._palm3 = new Float64Array(3);
    /** Wall push-back ray (one reused hit record). */
    this._wallHit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' };
    /** Draw the gloved hands on held guns. */
    this.gloves = true;
    /** A magazine is being stripped (its catch release must not drop it). */
    this._stripping = false;
    this._stripT = 0;
    this._stripP = new THREE.Vector3();
    this._stripQ = new THREE.Quaternion();
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
    this.rng = new Rng(opts.seed ?? 0x51ed2701);

    /** One reused hit record (CONTRACTS "Hit"). */
    this.hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' };
    this.shotEv = { weapon: 'glock', x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
    this.hitEv = { enemy: -1, part: '', damage: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
    /** @type {{ weapon: string|null, mag: number, chambered: number, mode: import('./WeaponDefs.js').FireMode|null }} */
    this._ammo = { weapon: 'glock', mag: -1, chambered: 0, mode: 'semi' };
    this.stats = { shots: 0, hits: 0, enemyHits: 0, draws: 0, reloads: 0 };

    this._mp = new THREE.Vector3();
    this._mq = new THREE.Quaternion();
    this._lp = new THREE.Vector3();
    this._lq = new THREE.Quaternion();
    this._warm = false;
    /** The trigger belongs to something else this frame (the watch: pointing at it / its menu open). */
    this.triggerBlocked = false;
    /** @type {Weapon|null} gun-fit mode keeps this gun in the right hand without the squeeze */
    this._fitHold = null;
    /** The fit mode drew it (it goes back to its slot when the mode ends). */
    this._fitDrew = false;

    // ── real-surface physics (v0.4; null = the v0.3 rules)
    /** @type {import('../physics/PhysicsWorld.js').PhysicsWorld|null} */
    this.phys = null;
    /**
     * The physics step runs in its own `physics` system (PlayKit, v0.4: after `weapons`, before
     * `enemies`, timed by the PerfMonitor) through physicsUpdate(); false: inside update() as before.
     */
    this.physExternal = false;
    /** @type {any} the world layout the static colliders were built from */
    this._physLayout = null;
    /** The physics failed this session (items were returned to their slots once). */
    this._physDown = false;
    /** @type {Record<string, LooseMags>|null} loose magazines per weapon */
    this.looseMags = null;
    /** @type {LooseMags[]} */
    this._loose = [];
    this._p7 = new Float64Array(7);
    this._rel = new ReleaseInfo();
    /** Recent poses of the magazine in the left hand. */
    this._magHist = new PoseHistory();
    this.physStats = { released: 0, setDown: 0, thrown: 0, holstered: 0, pickedUp: 0, lostReturns: 0, magsDropped: 0, magsPicked: 0, magsPouched: 0, fallbacks: 0 };

    if (ctx.events && ctx.events.on) ctx.events.on('pause', (/** @type {any} */ p) => { this.paused = !!(p && p.paused); });
    if (opts.physics) this.attachPhysics(opts.physics);
  }

  // ======================================================================= physics (v0.4)

  /**
   * The whole physics load step (Preload, before Enter and before the GPU warm-up): import and
   * init Rapier, a PhysicsWorld with the item kinds (attachPhysics), and its contact warm-up. With
   * `off` (`?physics=off`, the device A/B switch) or on any failure the v0.3 rules stay.
   * @param {{ off?: boolean }} [o]
   * @returns {Promise<{ ok: boolean, off?: boolean, load?: any, warm?: any, error?: string }>} for the record
   */
  async initPhysics(o = {}) {
    if (o.off) { this.attachPhysics(null); return { ok: false, off: true }; }
    try {
      const { R, info } = await loadRapier();
      const P = new PhysicsWorld(R);
      P.load = info;
      if (!this.attachPhysics(P)) { this.attachPhysics(null); return { ok: false, load: info, error: P.guard.error || 'item kinds refused' }; }
      const warm = P.warmUp();
      if (!warm.ok || P.failed) { this.attachPhysics(null); return { ok: false, load: info, warm, error: P.guard.error || 'warm-up failed' }; }
      return { ok: true, load: info, warm };
    } catch (e) {
      this.attachPhysics(null);
      return { ok: false, error: String(e && /** @type {any} */ (e).message || e).slice(0, 200) };
    }
  }

  /**
   * Use real-surface physics for dropped guns and magazines. At load, before `physics.warmUp()`:
   * defines the item kinds (hulls from the gun and magazine GLB vertices) and the loose-magazine pools.
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld|null} physics
   * @returns {boolean} attached
   */
  attachPhysics(physics) {
    this.phys = physics || null;
    this.looseMags = null;
    this._loose = [];
    if (!physics) return false;
    /** @type {any} */ const src = {};
    for (const w of this.weapons) {
      const v = w.view;
      src[w.id] = { gun: positionsOf(v.gun), mag: positionsOf(v.mag), magSeat: [v.magSeat.x, v.magSeat.y, v.magSeat.z], grip: [v.gripCentre.x, v.gripCentre.y, v.gripCentre.z] };
    }
    let ok = true;
    for (const { kind, def } of itemKinds(src)) if (!physics.defineKind(kind, def)) ok = false;
    const n = Math.min(LOOSE.perWeapon, this.fx.loose.glock.instanceMatrix.count);
    this.looseMags = {
      glock: new LooseMags(this.fx.loose.glock, n, K_MAG9),
      akm: new LooseMags(this.fx.loose.akm, n, K_MAG762),
    };
    this._loose = [this.looseMags.glock, this.looseMags.akm];
    if (!ok) this.phys = null;
    return ok;
  }

  /** Physics is attached, working and its static colliders are built. */
  get physOn() { return !!this.phys && !this.phys.failed && this.phys.ready; }

  /** @param {Weapon} w the gun's physics kind (with or without its magazine) */
  _gunKind(w) { return w.id === 'glock' ? (w.inst.magSeated ? K_GLOCK : K_GLOCK_NOMAG) : (w.inst.magSeated ? K_AKM : K_AKM_NOMAG); }

  /**
   * Per frame: the static colliders follow the world's builds, the step, and the items lying in
   * the world (lost-object net, landing sounds). Allocation-free when everything rests.
   * @param {number} dt @param {any} ctx
   */
  _physFrame(dt, ctx) {
    const P = this.phys;
    if (!P) return;
    if (P.failed) { if (!this._physDown) this._physFailed(); return; }
    // a new world build (its static geometry, or its layout) → new static colliders
    const W = ctx.world;
    const g = W && typeof W.staticGeometry === 'function' ? W.staticGeometry() : null;
    const key = g || (W && W.built !== false ? W.layout : null);
    if (key && key !== this._physLayout) {
      this._physLayout = key;
      P.beginStatic(staticFromWorld(W));   // allocates: only when the world was rebuilt (behind the panel / a pause)
    }
    if (!P.ready && P.geo) P.buildSlice(SYSTEM.physSliceMs);
    P.step(dt);
    if (P.failed) { this._physFailed(); return; }
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.carry.state !== CARRY_FREE || w.physId < 0) continue;
      const s = P.state(w.physId);
      if (s === ST_LOST || s === PST_FREE) { this._returnLost(w); continue; }
      const dv = P.landing(w.physId);
      if (landingClass(dv) !== LAND_NONE && this.now - w.lastSoundT >= ITEMS.soundGapS) {
        w.lastSoundT = this.now;
        const g = landingGain(dv);
        // no gun-drop recording exists: the magazine clatter pitched down stands in; soft: the cloth thud
        if (P.landSurf(w.physId) === SURF.SOFT) this._sound('cloth', w.view.root.position, 0.55 * g, 0.85);
        else this._sound('magDrop', w.view.root.position, g, w.id === 'akm' ? 0.7 : 0.82);
      }
    }
    const audio = this.ctx && this.ctx.audio ? this.ctx.audio : null;
    for (let i = 0; i < this._loose.length; i++) this._loose[i].sync(P, this.now, audio);
  }

  /**
   * The `physics` system (v0.4; with `physExternal`): the static colliders, the fixed step and the
   * lying items, then the lying guns' display poses from this step (no frame of lag). Allocation-free
   * when everything rests.
   * @param {number} dt @param {any} ctx
   */
  physicsUpdate(dt, ctx) {
    if (!this.physExternal) return;
    if (!(dt >= 0)) dt = 0;
    this._physFrame(dt, ctx);
    const P = this.phys;
    if (!P || P.failed) return;
    const p7 = this._p7;
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.carry.state !== CARRY_FREE || w.physId < 0 || !P.readPose(w.physId, p7, 0)) continue;
      w.relP.set(p7[0], p7[1], p7[2]);
      w.relQ.set(p7[3], p7[4], p7[5], p7[6]);
      w.bp.copy(w.relP);
      w.bq.copy(w.relQ);
      this._display(w);
    }
  }

  /** The physics failed: lying guns go back to their slots (shrink, grow), loose magazines vanish. */
  _physFailed() {
    this._physDown = true;
    for (const w of this.weapons) {
      if (w.carry.state === CARRY_FREE) { w.physId = -1; w.carry.returnLost(); this.physStats.fallbacks++; }
    }
    for (const lm of this._loose) lm.clear(null);
  }

  /**
   * The lost-object net returned a gun: it shrinks where it lay and grows back in its slot.
   * @param {Weapon} w
   */
  _returnLost(w) {
    if (this.phys && w.physId >= 0) this.phys.remove(w.physId);
    w.physId = -1;
    w.carry.returnLost();
    this.physStats.lostReturns++;
  }

  /**
   * Remove a gun from the world (if it lies there) and put it in its slot now.
   * @param {Weapon} w
   */
  _stow(w) {
    if (w.physId >= 0 && this.phys) this.phys.remove(w.physId);
    w.physId = -1;
    w.carry.stow();
  }

  /**
   * Right grip to a lying gun (in units of reach, ≤ 1 = in reach): its grip centre within
   * 0.13 m, or its box within 0.05 m.
   * @param {Weapon} w @param {THREE.Vector3} p
   */
  _worldGrabDist(w, p) {
    const P = this.phys;
    const K = P ? P.kinds[this._gunKind(w)] : null;
    if (!K) return Infinity;
    const v = w.view;
    v.toLocal(p, w.relP, w.relQ, _v3);
    const dGrip = _v3.distanceTo(v.gripCentre);
    const c = K.centre, h = K.half;
    const ex = Math.max(0, Math.abs(_v3.x - c[0]) - h[0]), ey = Math.max(0, Math.abs(_v3.y - c[1]) - h[1]), ez = Math.max(0, Math.abs(_v3.z - c[2]) - h[2]);
    const a = dGrip / ITEMS.pickReach, b = Math.sqrt(ex * ex + ey * ey + ez * ez) / ITEMS.pickHull;
    return a < b ? a : b;
  }

  /**
   * Pick a lying gun up: the draw blends from where it lies into the fitted grip.
   * @param {Weapon} w
   */
  _pickUp(w) {
    if (!w.carry.grabFromWorld()) return;
    if (this.phys && w.physId >= 0) this.phys.remove(w.physId);
    w.physId = -1;
    this.held = w;
    this.lastHeld = w;
    this.R.sense.consume();
    this.R.sense.inside = 0;
    w.gate.arm();
    w.recoil.reset();
    w.hist.reset();
    this.stats.draws++;
    this.physStats.pickedUp++;
    this._pulse(RIGHT, SLOTS.draw);
  }

  /**
   * The physics release of a gun (not holstered): returns true when it is now a physics item.
   * @param {Weapon} w
   */
  _releaseToWorld(w) {
    const P = this.phys;
    if (!P) return false;
    const root = w.view.root, p7 = this._p7;
    p7[0] = root.position.x; p7[1] = root.position.y; p7[2] = root.position.z;
    p7[3] = root.quaternion.x; p7[4] = root.quaternion.y; p7[5] = root.quaternion.z; p7[6] = root.quaternion.w;
    const id = P.release(this._gunKind(w), p7, w.hist, this._rel, -1);
    if (id < 0) return false;
    w.physId = id;
    w.lastSoundT = this.now;   // no landing sound from the release itself
    P.pose(id, p7, 0);
    w.relP.set(p7[0], p7[1], p7[2]);
    w.relQ.set(p7[3], p7[4], p7[5], p7[6]);
    this.physStats.released++;
    if (this._rel.setDown) this.physStats.setDown++; else this.physStats.thrown++;
    return true;
  }

  /**
   * A magazine becomes a loose physics item (from the well or the left hand).
   * @param {Weapon} w whose magazine @param {THREE.Vector3} pos its origin (top) @param {THREE.Quaternion} q
   * @param {number} rounds
   * @param {PoseHistory|null} hist hand history (null: spawned with `vel` and a tumble)
   * @param {THREE.Vector3|null} vel
   * @returns {boolean}
   */
  _looseMag(w, pos, q, rounds, hist, vel) {
    const P = this.phys, lm = this.looseMags ? this.looseMags[w.id] : null;
    if (!P || !lm) return false;
    const pl = this.ctx && this.ctx.player, head = pl ? pl.head || pl.eye || null : null, fwd = pl && pl.forward ? pl.forward : null;
    const slot = lm.room(P, head, fwd, this.ctx ? this.ctx.world : null);
    const p7 = this._p7, kind = w.id === 'glock' ? K_MAG9 : K_MAG762;
    p7[0] = pos.x; p7[1] = pos.y; p7[2] = pos.z; p7[3] = q.x; p7[4] = q.y; p7[5] = q.z; p7[6] = q.w;
    let id = -1;
    if (hist) id = P.release(kind, p7, hist, this._rel, rounds);
    else {
      P.placeAt(kind, p7);
      const r = this.rng.fill(4), sp = SYSTEM.magTumble * (0.5 + r[3]);
      _v3.set(r[0] - 0.5, r[1] - 0.5, r[2] - 0.5);
      if (_v3.lengthSq() < 1e-6) _v3.set(1, 0, 0);
      _v3.normalize().multiplyScalar(sp);
      id = P.spawn(kind, p7, vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0, _v3.x, _v3.y, _v3.z, rounds);
    }
    if (id < 0) return false;
    lm.add(P, slot, id, rounds);
    this.physStats.magsDropped++;
    return true;
  }

  /**
   * The left hand takes a loose magazine (with its rounds); it blends from where it lay into the hand.
   * @param {LooseMags} lm @param {number} slot
   */
  _pickMag(lm, slot) {
    const P = this.phys;
    if (!P) return;
    const w = lm === (this.looseMags && this.looseMags.akm) ? this.akm : this.glock;
    const p7 = this._p7, rounds = lm.take(P, slot, p7);
    if (rounds < 0) return;
    this.lRole = L_MAG;
    this.handMag = w;
    this.handMagRounds = rounds;
    w.well.reset();
    w.view.handMag.visible = true;
    this._stripP.set(p7[0], p7[1], p7[2]);
    this._stripQ.set(p7[3], p7[4], p7[5], p7[6]);
    this._stripT = SYSTEM.stripBlendS;
    this._magHist.reset();
    this.physStats.magsPicked++;
    this._pulse(LEFT, HAPTIC.pouch);
  }

  /**
   * A reference-space realign moved the world (old → new, column-major): move the lying items with it
   * (call next to world.realign(m); the static colliders rebuild by themselves after it).
   * @param {ArrayLike<number>} m
   */
  realignItems(m) {
    if (this.phys) this.phys.transformAll(m);
  }

  /** `rec.physics` (allocates; session end): the PhysicsWorld record plus the release counts. */
  physicsReport() {
    if (!this.phys) return { attached: false };
    return { attached: true, ...this.phys.report(), weapons: { ...this.physStats }, looseMags: this._loose.map((lm) => ({ live: lm.count, recycled: lm.recycled, lost: lm.lost })) };
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
    this.fx.world = ctx.world || null;
    const I = ctx.input || null;
    this._readHand(this.L, I ? I.left : null, dt);
    this._readHand(this.R, I ? I.right : null, dt);

    const P = ctx.player || null, body = this.body;
    if (P && P.eye && P.quat && P.valid !== false) body.setHead(P.eye, P.quat);
    body.setHand(LEFT, this.L.ok, this.L.pos, false);
    body.setHand(RIGHT, this.R.ok, this.R.pos, this.held !== null);
    body.update(dt, P);
    this._slotFrames();

    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      if (w.carry.update(dt) === EV_STOWED) this._sound(w.id === 'glock' ? 'holsterIn' : 'cloth', w.slotP, 0.8);
    }
    if (!this.physExternal) this._physFrame(dt, ctx);
    this._right(dt, I);
    for (let i = 0; i < this.weapons.length; i++) this._base(this.weapons[i], dt);
    this._left(dt, I);
    const held = this.held;
    if (held && this.lRole === L_SUPPORT && this.lWeapon === held && held.id === 'akm' && held.carry.inHand && this.L.ok) {
      held.view.aimTwoHanded(held.bq, this.R.pos, this.L.pos, held.bp, HANDLING.supportMinSpan);
    }
    if (held && held.carry.inHand) this._wallStep(held, dt);
    else if (held) held.wallPush = 0;
    if (held && held.carry.inHand) held.hist.pushPQ(this.now, held.bp.x, held.bp.y, held.bp.z, held.bq.x, held.bq.y, held.bq.z, held.bq.w);
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
      this._gloves(w);
    }
    this._placeHandMag(dt);
    this._placeHolster();
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
      const S = h.relSum, r = h.rel, sg = h.relN > 0 && S[0] * r.x + S[1] * r.y + S[2] * r.z + S[3] * r.w < 0 ? -1 : 1;
      if (Number.isFinite(r.x + r.y + r.z + r.w)) { S[0] += sg * r.x; S[1] += sg * r.y; S[2] += sg * r.z; S[3] += sg * r.w; h.relN++; }
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
    const B = this.body;
    this.glock.slotP.fromArray(B.holster.p);
    this.glock.slotQ.fromArray(B.holster.q);
    this.akm.slotP.fromArray(B.back.p);
    this.akm.slotQ.fromArray(B.back.q);
  }

  /**
   * Distance from a hand to a weapon's grab zone (the holstered grip centre,
   * or the slung rifle's grip-to-butt line over the shoulder), in units of
   * that zone's reach (≤ 1 = in reach).
   * @param {Weapon} w @param {THREE.Vector3} p
   */
  _grabDist(w, p) {
    const B = this.body;
    return w.id === 'glock' ? pointDist(p.x, p.y, p.z, B.holster.p) / SLOTS.grabReach
      : segmentDist(p.x, p.y, p.z, B.back.p, B.backAxis, B.backLen) / SLOTS.backReach;
  }

  // ======================================================================= right hand

  /** @param {number} dt @param {any} I */
  _right(dt, I) {
    const R = this.R, s = I ? I.right : null;
    R.sense.update(dt, !!(s && s.squeezeDown), !!(s && s.squeezeHeld));
    const w = this.held;
    if (!w) {
      if (!R.ok) { R.sense.inside = 0; return; }
      /** @type {Weapon|null} */
      let best = null, bestD = Infinity, entered = false, fromWorld = false;
      for (let i = 0; i < this.weapons.length; i++) {
        const x = this.weapons[i];
        let d = Infinity, inWorld = false;
        if (x.carry.grabbable && this.body.valid) d = this._grabDist(x, R.pos);
        else if (x.carry.inWorld && x.physId >= 0 && this.phys) { d = this._worldGrabDist(x, R.pos); inWorld = true; }
        const near = d <= 1;
        if (R.sense.enter(x.bit, near)) entered = true;
        if (near && d < bestD) { best = x; bestD = d; fromWorld = inWorld; }
      }
      if (best && R.sense.wantsGrab) { if (fromWorld) this._pickUp(best); else this._draw(best); }   // the draw's own pulse, not the entry tick
      else if (entered) this._pulse(RIGHT, SLOTS.tick);
      return;
    }
    if (!w.carry.inHand) { this.held = null; return; }
    if (!(s && s.squeezeHeld)) { if (this._fitHold !== w) this._letGo(w, false); }
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
    v.toWorld(v.gripCentre, _v);
    const dist = _v.distanceTo(w.slotP);
    let near = !lost && dist <= SLOTS.slotReach;
    let free = false;
    const P = this.physOn ? this.phys : null;
    if (!lost && P) {
      if (near) {
        // the holster rule (research §7): muzzle within 60° of the holster's axis, and no real surface
        // within 3 cm below (a gun laid on the bed beside the hip or thigh is set down, not holstered).
        // The sling over the shoulder takes the rifle whatever its angle and whatever is below (a couch
        // backrest behind a seated player is not a place to lay it).
        let dot = 1, gap = Infinity;
        if (w.id === 'glock') {
          _v2.copy(_ZN).applyQuaternion(v.root.quaternion); _v3.copy(_ZN).applyQuaternion(w.slotQ); dot = _v2.dot(_v3);
          const p7 = this._p7, r = v.root;
          p7[0] = r.position.x; p7[1] = r.position.y; p7[2] = r.position.z;
          p7[3] = r.quaternion.x; p7[4] = r.quaternion.y; p7[5] = r.quaternion.z; p7[6] = r.quaternion.w;
          gap = P.gapBelow(this._gunKind(w), p7);
        }
        near = releaseKind(dist, dot, gap, 0, 0) === REL_HOLSTER;
        if (near) this.physStats.holstered++;
      }
      if (!near) free = this._releaseToWorld(w);
    }
    if (lost) w.carry.lost(); else w.carry.release(near, free);
    if (!free) {
      w.relP.copy(v.root.position);
      w.relQ.copy(v.root.quaternion);
    }
    w.dropV.copy(this.R.vel);
    w.dropFloor = this._floorY(w.relP.x, w.relP.z) + SYSTEM.dropRest;
    this._endLeftOn(w);
    w.inst.setTrigger(0);
    w.recoil.reset();
    w.assistT = -1;
    w.twoHand = false;
    w.wallPush = 0;
    w.wallTouch = false;
    this.held = null;
    if (near) this._pulse(RIGHT, SLOTS.holster);
  }

  // ======================================================================= poses

  /** @param {Weapon} w @param {number} dt */
  _base(w, dt) {
    const v = w.view, c = w.carry;
    v.slotPose(w.slotP, w.slotQ, w.sp, w.sq);
    if (c.inHand && this.R.ok) v.holdPose(this.R.pos, this.R.gripQuat, w.hp, w.hq);
    w.scale = c.scale;
    switch (c.state) {
      case CARRY_DRAW: {
        const k = c.blend;
        if (c.fromWorld) { w.bp.lerpVectors(w.relP, w.hp, k); w.bq.slerpQuaternions(w.relQ, w.hq, k); }
        else { w.bp.lerpVectors(w.sp, w.hp, k); w.bq.slerpQuaternions(w.sq, w.hq, k); }
        break;
      }
      case CARRY_FREE: {
        const p7 = this._p7;
        if (this.phys && w.physId >= 0 && this.phys.readPose(w.physId, p7, 0)) {
          w.relP.set(p7[0], p7[1], p7[2]);
          w.relQ.set(p7[3], p7[4], p7[5], p7[6]);
        }
        w.bp.copy(w.relP);
        w.bq.copy(w.relQ);
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
        const fy = w.dropFloor;
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
    const st = w.carry.state, slung = st === CARRY_SLOT || st === CARRY_GROW;
    // a rifle on your back is out of sight (research-fit B: no occluder hid it without hiding the holster too)
    root.visible = this._warm || !slung || (this.body.valid && w.id !== 'akm');
  }

  /**
   * Gun–wall push-back: a ray from the grip to the muzzle against the world;
   * on a hit the gun slides back along its bore so the muzzle stays 2 cm off
   * the surface (fast in, eased out), with one haptic tick on contact.
   * @param {Weapon} w @param {number} dt
   */
  _wallStep(w, dt) {
    const W = this.ctx && this.ctx.world, R = this.R;
    let target = 0;
    if (W && typeof W.raycast === 'function' && W.built !== false && R.ok) {
      _v.copy(w.view.muzzle).applyQuaternion(w.bq).add(w.bp);
      _v2.subVectors(_v, R.pos);
      const len = _v2.length();
      if (len > 1e-3) {
        _v2.multiplyScalar(1 / len);
        const H = this._wallHit, reach = len + SYSTEM.wallMargin;
        if (W.raycast(R.pos.x, R.pos.y, R.pos.z, _v2.x, _v2.y, _v2.z, reach, H) && H.dist < reach) {
          target = reach - H.dist;
          if (target > SYSTEM.wallMaxPush) target = SYSTEM.wallMaxPush;
        }
      }
    }
    if (target >= w.wallPush) w.wallPush = target;
    else w.wallPush += (target - w.wallPush) * (1 - Math.exp(-SYSTEM.wallRelax * (dt > 0 ? dt : 0)));
    if (w.wallPush < 1e-5) w.wallPush = 0;
    if (!w.wallTouch && w.wallPush > SYSTEM.wallTickMin) { w.wallTouch = true; this._pulse(RIGHT, HAPTIC.wall); }
    else if (w.wallTouch && w.wallPush < SYSTEM.wallTickMin * 0.5) w.wallTouch = false;
    if (w.wallPush > 0) {
      _v3.set(0, 0, 1).applyQuaternion(w.bq);
      w.bp.addScaledVector(_v3, w.wallPush);
    }
  }

  /**
   * Gloves: the right one while the gun is in the hand (from half-way through the draw), the
   * left one while the left hand supports the AKM.
   * @param {Weapon} w
   */
  _gloves(w) {
    const v = w.view, c = w.carry, on = this.gloves || this._warm;
    if (v.handR) v.handR.visible = this._warm || (on && (c.state === CARRY_HAND || (c.state === CARRY_DRAW && c.blend > 0.5)));
    // The AKM support glove is off until it is re-posed to wrap the handguard (v0.3 verifier: it
    // stood upright beside it, ~4 cm above the real controller). Still warmed.
    if (v.handL) v.handL.visible = this._warm || (this.supportGlove && on && c.inHand && w.twoHand && this.lRole === L_SUPPORT && this.lWeapon === w && w.id === 'akm');
  }

  /**
   * Gun-fit mode (the watch's GUN FIT page, research-fit C): keep gun `id` in
   * the right hand without the squeeze, drawing it from its slot when the hand
   * is empty (or holds a gun this mode drew; a gun the player drew stays).
   * `null` ends the mode: the held gun goes back to its slot unless the grip
   * is squeezed. Called from
   * the watch's action (an event, not per frame). `fitHolding` says which gun is held this way.
   * @param {'glock'|'akm'|null} id
   */
  fitHold(id) {
    const s = this.ctx && this.ctx.input ? this.ctx.input.right : null;
    const squeezed = !!(s && s.squeezeHeld);
    if (!id) {
      const w = this._fitHold;
      this._fitHold = null;
      if (w && this.held === w && !squeezed) this._letGo(w, true); // not squeezed: back to its slot
      this._fitDrew = false;
      return;
    }
    const w = id === 'akm' ? this.akm : this.glock;
    if (this.held === w) { if (this._fitHold !== w) this._fitDrew = false; this._fitHold = w; return; }
    if (this.held) {
      if (!(this._fitDrew && this._fitHold === this.held)) { this._fitHold = this.held; return; } // the player's own gun stays
      this._letGo(this.held, true);
    }
    this._fitHold = w;
    this._fitDrew = false;
    if (w.carry.state !== CARRY_SLOT) this._stow(w);
    this._draw(w);
    this._fitDrew = this.held === w;
  }

  /** The gun the fit mode holds in the right hand (null outside it). */
  get fitHolding() { return this._fitHold ? this._fitHold.id : null; }

  /**
   * Gloved hands on or off (URL `?gloves=0`, a watch setting). Default on.
   * @param {boolean} on
   */
  setGloves(on) { this.gloves = !!on; }

  /** The holster shell at the holster socket's gun-root pose (drawn or not). */
  _placeHolster() {
    const H = this.holster, g = this.glock;
    H.visible = this._warm || this.body.valid;
    if (!this.body.valid) return;
    H.position.copy(g.sp);
    H.quaternion.copy(g.sq);
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
    // rack reach (CQC rackReachOf) and the hover tick for a free hand
    let dr = Infinity;
    if (held && L.ok) {
      held.view.rackLocal(held.inst.slidePos, _v);
      _v.applyQuaternion(held.bq).add(held.bp);
      dr = L.pos.distanceTo(_v) / this._rackReach(held);
    }
    if (L.sense.enter(RACK_BIT, dr <= 1) && !(s && s.squeezeHeld)) this._pulse(LEFT, HAPTIC.rackHover);
    if (!(s && s.squeezeDown) || !L.ok) return;
    let role = L_NONE, best = 1;
    if (held) {
      const v = held.view;
      if (dr < best) { best = dr; role = L_RACK; }
      let ds = Infinity;
      if (held.id === 'akm' && v.support) {
        _v.copy(v.support).applyQuaternion(held.bq).add(held.bp);
        ds = L.pos.distanceTo(_v) / HANDLING.supportReach;
      } else if (held.id === 'glock') ds = L.pos.distanceTo(this.R.pos) / SYSTEM.glockCup;
      if (ds < best) { best = ds; role = L_SUPPORT; }
      if (held.id === 'akm' && held.inst.magSeated && !this.handMag) {
        const dm = this._stripDist(held, L.pos) / SYSTEM.stripReach;
        if (dm < best) { best = dm; role = L_STRIP; }
      }
    }
    if (!this.handMag && this.body.valid) {
      const dp = pointDist(L.pos.x, L.pos.y, L.pos.z, this.body.pouch.p) / SLOTS.pouchReach;
      if (dp < best) { best = dp; role = L_MAG; }
    }
    /** @type {LooseMags|null} */
    let pickLm = null;
    let pickSlot = -1;
    if (!this.handMag && this.physOn) {
      const P = /** @type {import('../physics/PhysicsWorld.js').PhysicsWorld} */ (this.phys);
      for (let i = 0; i < this._loose.length; i++) {
        const lm = this._loose[i], sl = lm.nearest(P, L.pos.x, L.pos.y, L.pos.z, ITEMS.magReach);
        if (sl < 0) continue;
        const d = lm.lastD / ITEMS.magReach;
        if (d < best) { best = d; role = L_PICK; pickLm = lm; pickSlot = sl; }
      }
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
    } else if (role === L_STRIP && held) {
      this._strip(held);
    } else if (role === L_PICK && pickLm) {
      this._pickMag(pickLm, pickSlot);
    } else if (role === L_MAG) {
      const w = held || this.lastHeld;
      this.lRole = L_MAG;
      this.handMag = w;
      this.handMagRounds = w.def.capacity;
      w.well.reset();
      w.view.handMag.visible = true;
      this._magHist.reset();
      this._pulse(LEFT, HAPTIC.pouch);
      this._sound('cloth', L.pos, 0.6);
    }
  }

  /** @param {Weapon} w rack reach (m), more when unchambered or locked open */
  _rackReach(w) {
    const i = w.inst, base = w.id === 'akm' ? SYSTEM.rackReach.akm : SYSTEM.rackReach.glock;
    return i.chamber !== CHAMBER_LIVE || i.slide === SLIDE_LOCKED ? base + SYSTEM.rackOpenBonus : base;
  }

  /**
   * Distance from a point to the lower `stripBand` of the seated magazine (its box, gun space).
   * @param {Weapon} w @param {THREE.Vector3} p world
   */
  _stripDist(w, p) {
    const v = w.view;
    v.toLocal(p, w.bp, w.bq, _v3).sub(v.mag.position);
    const c = v.magCentre, h = v.magHalf;
    const y0 = c.y - h.y, y1 = y0 + 2 * h.y * SYSTEM.stripBand;
    const x = _v3.x < c.x - h.x ? c.x - h.x : _v3.x > c.x + h.x ? c.x + h.x : _v3.x;
    const y = _v3.y < y0 ? y0 : _v3.y > y1 ? y1 : _v3.y;
    const z = _v3.z < c.z - h.z ? c.z - h.z : _v3.z > c.z + h.z ? c.z + h.z : _v3.z;
    return Math.hypot(_v3.x - x, _v3.y - y, _v3.z - z);
  }

  /**
   * The left hand strips the seated magazine (CQC MAG_STRIP): it comes out
   * with its rounds into the hand and must leave the well before it re-seats.
   * @param {Weapon} w
   */
  _strip(w) {
    const v = w.view, inst = w.inst;
    v.localToWorldPose(v.mag.position, v.mag.quaternion, w.bp, w.bq, this._stripP, this._stripQ);
    this._stripping = true;
    const rounds = inst.magRelease();
    this._stripping = false;
    if (rounds < 0) return;
    this.lRole = L_MAG;
    this.handMag = w;
    this.handMagRounds = rounds;
    w.well.reset();
    w.well.block();
    v.handMag.visible = true;
    this._stripT = SYSTEM.stripBlendS;
    this._pulse(LEFT, HAPTIC.strip);
  }

  /** The left hand lets go of whatever it does. */
  _endLeft() {
    if (this.lRole === L_RACK && this.lWeapon) this.lWeapon.inst.rackRelease();
    if (this.lRole === L_MAG && this.handMag) {
      const w = this.handMag, v = w.view, m = v.handMag;
      if (this.physOn) {
        // physics: back into the pouch when let go there, else a loose magazine with its rounds
        const atPouch = this.body.valid && this.L.ok && pointDist(this.L.pos.x, this.L.pos.y, this.L.pos.z, this.body.pouch.p) <= ITEMS.pouchReach;
        if (atPouch) { this.physStats.magsPouched++; this._sound('cloth', this.L.pos, 0.4); }
        else if (!this._looseMag(w, m.position, m.quaternion, this.handMagRounds, this._magHist, null)) this.fx.dropMag(w.id, m.position, m.quaternion, this.L.vel, 3);
      } else this.fx.dropMag(w.id, m.position, m.quaternion, this.L.vel, 3);
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
    // face buttons on whichever hand is on the gun (CQC): A / X magazine release, B / Y slide release or selector
    const Lb = I ? I.left : null;
    const onL = !!Lb && this.L.ok && (this.lRole === L_SUPPORT || this.lRole === L_RACK) && this.lWeapon === w;
    const aR = !!s && s.aDown, aL = onL && /** @type {any} */ (Lb).aDown;
    if (aR) w.aNoMag = !inst.magSeated;
    if (aR || aL) {
      if (inst.magSeated) { this._pulse(aR ? RIGHT : LEFT, HAPTIC.magCatch); inst.magRelease(); }
    }
    if ((s && s.bDown) || (onL && /** @type {any} */ (Lb).bDown)) this._buttonB(w);
    if (s && s.stickDown) inst.selector();
    // test aid: hold A 0.8 s with no magazine
    if (s && s.a && w.aNoMag && s.aHeldS >= SYSTEM.assistHoldS && !inst.magSeated && w.assistT < 0 && this.handMag !== w) {
      w.assistT = HANDLING.assistS;
      w.aNoMag = false;
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
    const atThigh = this.body.valid && boreAtThighs(_v, _v2, this.body.thighs);
    _v3.copy(v.muzzle).applyQuaternion(w.sq).add(w.sp);
    const open = w.gate.update(trig, _v.distanceTo(_v3), atThigh);
    inst.setTrigger(open && w.carry.state === CARRY_HAND && !this.paused && !this.triggerBlocked ? trig : 0);
  }

  /**
   * B / Y: the slide release where the gun has one (or the action is locked
   * open), otherwise the fire selector (AKM).
   * @param {Weapon} w
   */
  _buttonB(w) {
    const inst = w.inst;
    if (w.def.hasSlideRelease || inst.slide === SLIDE_LOCKED) inst.slideRelease();
    else if (w.def.modes.length > 1) inst.selector();
  }

  /**
   * The magazine in the left hand against the held gun's well.
   * @param {Weapon} w
   */
  _seatCheck(w) {
    if (this.lRole !== L_MAG || this.handMag !== w || !this.L.ok) return;
    const v = w.view;
    if (w.inst.magSeated) { w.well.state = MAG_FREE; return; }
    v.handMagPose(this.L.pos, this.L.gripQuat, this._mp, this._mq);
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

  /**
   * The magazine in the left hand: free in the hand, or guided by the well
   * (a stripped one moves from the well into the hand over 80 ms).
   * @param {number} dt
   */
  _placeHandMag(dt) {
    const w = this.handMag;
    if (!w || this.lRole !== L_MAG) { this._stripT = 0; return; }
    const v = w.view, m = v.handMag;
    if (w === this.held && w.well.state === MAG_GUIDED) {
      v.guidedMagLocal(w.well.along, this._lp, this._lq);
      v.localToWorldPose(this._lp, this._lq, v.root.position, v.root.quaternion, m.position, m.quaternion);
    } else if (this.L.ok) {
      v.handMagPose(this.L.pos, this.L.gripQuat, m.position, m.quaternion);
      if (this._stripT > 0) {
        this._stripT -= dt > 0 ? dt : 0;
        const k = this._stripT > 0 ? this._stripT / SYSTEM.stripBlendS : 0;
        m.position.lerp(this._stripP, k);
        m.quaternion.slerp(this._stripQ, k);
      }
      if (this.phys) this._magHist.pushPQ(this.now, m.position.x, m.position.y, m.position.z, m.quaternion.x, m.quaternion.y, m.quaternion.z, m.quaternion.w);
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
    I.onMagOut = (_i, rounds) => this._magOut(w, rounds);
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
    const R = this.rng.fill(2), r = fit.spread * Math.sqrt(R[0]), a = R[1] * Math.PI * 2;
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
    } else if (ctx.look && ctx.look.impactsOn) {
      ctx.look.impact(H, _v2.x, _v2.y, _v2.z, w.id); // v0.4: decal, puff and sound per real material (src/fx/Look.js)
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
    v.dirWorld(v.ejectDir, _v2).multiplyScalar(fit.brassSpeed * (0.85 + 0.3 * this.rng.fill(1)[0])).add(w.vel);
    this.fx.eject(_v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, v.root.quaternion, fit.caseRL, w.def.sounds.brass);
  }

  /**
   * The magazine catch let the magazine go: it falls out of the well (with physics: a loose
   * magazine carrying its rounds).
   * @param {Weapon} w @param {number} [rounds]
   */
  _magOut(w, rounds = 0) {
    const v = w.view;
    if (this._stripping) { v.magOut = 0; this._soundAt(w, w.def.sounds.magOut, 1); return; }   // into the hand, not the floor
    _v3.copy(v.magSeat).addScaledVector(v.magAxis, -v.magOut);
    v.toWorld(_v3, _v);
    v.dirWorld(v.magAxis, _v2).multiplyScalar(-SYSTEM.magPush).add(w.vel);
    if (!(this.physOn && this._looseMag(w, _v, v.root.quaternion, rounds > 0 ? rounds : 0, null, _v2))) this.fx.dropMag(w.id, _v, v.root.quaternion, _v2, 1.5);
    v.magOut = 0;
    this._soundAt(w, w.def.sounds.magOut, 1);
  }

  // ======================================================================= helpers

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
   * @param {string} key @param {THREE.Vector3} p @param {number} gain @param {number} [rate]
   */
  _sound(key, p, gain, rate = 1) {
    const a = this.ctx && this.ctx.audio;
    if (a && typeof a.play === 'function' && key) a.play(key, p.x, p.y, p.z, gain, rate);
  }

  /** @param {Weapon} w @param {string} key @param {number} gain */
  _soundAt(w, key, gain) { this._sound(key, w.view.root.position, gain); }

  // ======================================================================= public

  /**
   * Ammo of the gun in hand (or the last one held), for the HUD: one reused
   * object. `mode`: the fire mode, 'safe' | 'semi' | 'auto' (the Glock is
   * always 'semi'; null with no gun yet).
   */
  ammo() {
    const w = this.held || this.lastHeld, o = this._ammo;
    o.weapon = w ? w.id : null;
    o.mag = w && w.inst.magSeated ? w.inst.magRounds : -1;
    o.chambered = w && w.inst.chamber === CHAMBER_LIVE ? 1 : 0;
    o.mode = w ? w.inst.mode : null;
    return o;
  }

  /**
   * New round: both guns re-issued (full magazine + one chambered; AKM on
   * semi), effects cleared. A gun in the hand stays in the hand.
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
      w.aNoMag = false;
      w.view.magOut = 0;
      if (w !== this.held) this._stow(w);
    }
    this._stripT = 0;
    this.fx.reset();
    for (const lm of this._loose) lm.clear(this.phys);
  }

  // ----------------------------------------------------------------------- fit

  /**
   * The player's grip-fit nudges for one gun (a copy).
   * @param {'glock'|'akm'} id
   * @returns {{ pitch: number, up: number, fwd: number }}
   */
  getFit(id) { const a = (id === 'akm' ? this.akm : this.glock).fitAdj; return { pitch: a.pitch, up: a.up, fwd: a.fwd }; }

  /**
   * Set one gun's grip fit (clamped: ±30°, ±0.04 m). Allocation-free, so the
   * in-headset fit mode may call it every frame. Never writes storage.
   * @param {'glock'|'akm'} id
   * @param {{ pitch?: number, up?: number, fwd?: number }} adj
   * @param {'default'|'saved'|'url'|'edit'} [source]
   * @returns {{ pitch: number, up: number, fwd: number }} the effective nudges (the weapon's own object: read, do not keep)
   */
  setFit(id, adj, source = 'edit') {
    const w = id === 'akm' ? this.akm : this.glock, a = w.fitAdj;
    a.pitch = adj && adj.pitch !== undefined ? adj.pitch : 0;
    a.up = adj && adj.up !== undefined ? adj.up : 0;
    a.fwd = adj && adj.fwd !== undefined ? adj.fwd : 0;
    clampAdj(a);
    computeFit(w.id, a, this._pose7, this._palm3);
    w.view.setFit(this._pose7, this._palm3);
    this.fitSource = source;
    if (source === 'edit') this.fitEdits++;
    return a;
  }

  /**
   * Apply saved fits (localStorage[FIT_KEY], a string or parsed object; junk = defaults).
   * @param {unknown} json
   * @returns {boolean} anything other than the defaults
   */
  loadFits(json) {
    const f = parseFits(json);
    this.setFit('glock', f.glock, 'saved');
    this.setFit('akm', f.akm, 'saved');
    const any = [f.glock, f.akm].some((a) => a.pitch !== 0 || a.up !== 0 || a.fwd !== 0);
    if (!any) this.fitSource = 'default';
    return any;
  }

  /** JSON for localStorage[FIT_KEY] (write it outside the frame loop, e.g. in a setTimeout). */
  fitsJSON() { return serializeFits({ glock: this.glock.fitAdj, akm: this.akm.fitAdj }); }

  /** The storage key the integrator saves `fitsJSON()` under. */
  static get FIT_KEY() { return FIT_KEY; }

  /**
   * `rec.play.grip` (research-fit D): the fit per gun (nudges, gun root in
   * grip space) and the session mean of the learned grip → ray rotation per
   * hand (device-verifies the 45° / 7° IWER relation). Allocates; call at
   * session end.
   */
  fitReport() {
    const r4 = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;
    /** @param {Weapon} w */
    const gun = (w) => ({
      pitch: w.fitAdj.pitch, up: w.fitAdj.up, fwd: w.fitAdj.fwd,
      pos: w.view.fitPos.toArray().map(r4), quat: w.view.fitQuat.toArray().map(r4), palm: w.view.palm.toArray().map(r4),
    });
    /** @param {Hand} h */
    const rel = (h) => {
      if (!h.relN) return null;
      const S = h.relSum, q = new THREE.Quaternion(S[0], S[1], S[2], S[3]).normalize();
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q);   // ray direction in grip space
      return {
        q: q.toArray().map(r4), n: h.relN,
        rayPitchDeg: Math.round((Math.atan2(-d.z, -d.y) * 1800) / Math.PI) / 10,
        rayYawDeg: Math.round((Math.asin(Math.max(-1, Math.min(1, d.x))) * 1800) / Math.PI) / 10,
      };
    };
    return {
      fitVersion: 2, source: this.fitSource, edits: this.fitEdits,
      glock: gun(this.glock), akm: gun(this.akm),
      rayRel: { right: rel(this.R), left: rel(this.L) },
      seated: this.body.seated, stance: this.body.stance,
    };
  }

  /**
   * The right controller's aim-ray orientation that points the held gun's
   * bore along (dx, dy, dz) with the gun upright (tests and the e2e driver:
   * ray = gun · fit⁻¹ · rel, where grip = ray · rel⁻¹). Allocation-free.
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {THREE.Quaternion} out
   * @returns {boolean} false with no gun in the right hand
   */
  aimRayFor(dx, dy, dz, out) {
    const w = this.held;
    if (!w) return false;
    _v.set(dx, dy, dz).normalize();
    // gun upright: yaw then pitch so −Z → dir
    const yaw = Math.atan2(-_v.x, -_v.z), pitch = Math.asin(Math.max(-1, Math.min(1, _v.y)));
    out.setFromAxisAngle(_YA, yaw).multiply(_q.setFromAxisAngle(_XA, pitch));
    out.multiply(_q.copy(w.view.fitQuat).invert()).multiply(this.R.rel);
    return true;
  }

  // ----------------------------------------------------------------------- state for the game / watch

  /** The left hand is doing something with a gun or a magazine. */
  get busyLeft() { return this.lRole !== L_NONE; }
  /** The right hand holds a gun. */
  get busyRight() { return !!(this.held && this.held.carry.inHand); }
  /** The left hand is on the held gun (support or rack): its X / Y are gun buttons. */
  get onGunLeft() { return (this.lRole === L_SUPPORT || this.lRole === L_RACK) && !!this.held && this.lWeapon === this.held; }

  /**
   * Stance: 'auto' (eye height), 'standing' or 'seated' (a setting).
   * @param {'auto'|'standing'|'seated'} s
   */
  setStance(s) { this.body.stance = s === 'standing' || s === 'seated' ? s : 'auto'; }

  /** Meshes for the warm-up compile and draw. */
  warmMeshes() {
    /** @type {THREE.Object3D[]} */
    const out = [];
    for (const w of this.weapons) out.push(w.view.root, w.view.handMag);
    out.push(this.holster);
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
      for (const h of [v.handR, v.handL]) if (h) { h.frustumCulled = !on; h.visible = on; }
      if (!on) v.root.visible = (this.body.valid && w.id !== 'akm') || w.carry.state !== CARRY_SLOT;
    }
    this.holster.visible = on || this.body.valid;
    this.holster.frustumCulled = !on;
    this.fx.setWarm(on);
  }
}

/**
 * A mesh's vertex positions in its own geometry space (load time, for the physics hulls).
 * @param {THREE.Mesh} mesh
 * @returns {Float32Array}
 */
function positionsOf(mesh) {
  const a = /** @type {THREE.BufferAttribute} */ (mesh.geometry.attributes.position);
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
}
