// @ts-check
import * as THREE from 'three';
import { Events } from '../core/Events.js';
import { warmXR } from '../core/Warmup.js';
import { World, CaptureGate, captureSnapshot } from '../world/World.js';
import { Player } from '../game/Player.js';
import { GameSession } from '../game/GameSession.js';
import { PHASE } from '../game/Rules.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { WristHud } from '../ui/WristHud.js';

/**
 * The play mode's game (CONTRACTS.md "Integration"): every system is built
 * ONCE at load (before the warm-up), and each play session only starts and
 * stops it. App owns the XR session, the Loop and the PerfMonitor; this owns
 * the shared runtime context (`ctx`, CONTRACTS "Ctx") and the session steps:
 *
 *   1. capture: CaptureGate waits until the Space Setup plane count is stable
 *      (0.5 s) or 3 s have passed, then `captureSnapshot` copies it (in
 *      ?emulate: the house fixture); the snapshot goes into the session record
 *      (`rec.spaceSnapshot`) for desktop replays;
 *   2. build: `world.build(snapshot, head)` once (synchronous, behind App's
 *      opaque "Get ready" panel, which also carries the controls card);
 *   3. warm: next frame, one draw of every pool into the XR framebuffer
 *      (`warmXR`, before that frame's own render), re-baselining the counts;
 *   4. start: the card stays up until a trigger pull is released (after 1 s) or
 *      8 s (the same pull never also confirms the spot);
 *   5. spot: `game.pickSpot` (SafeSpot): the ring follows the head until the
 *      player pulls the trigger in an open spot (GameSession's own panel; App's
 *      panel is hidden). The confirm callback runs inside game.preUpdate, so
 *      the round starts in the NEXT frame's world step (never mid-frame);
 *   6. rebuild (only when the spot is > 0.25 m from where the world was
 *      built): App's panel shows for a frame, then `world.build(snapshot,
 *      zone, { doors })` and one more frame with the panel up (the occluder's
 *      rewritten buffers upload in that draw);
 *   7. go: `game.start(zone)`; GameSession takes over the messages.
 *
 * Systems, in the contract order (PerfMonitor names = PLAY_SYSTEMS):
 * input → world → player → weapons → enemies → game → audio → ui → render.
 * Allocation-free per frame once playing (the one-time capture and build
 * aside).
 */
export const PLAY_SYSTEMS = Object.freeze(['input', 'world', 'player', 'weapons', 'enemies', 'game', 'audio', 'ui', 'render']);

/** Session steps (numbers kept from v0.2; SPOT, REBUILD and GO came with the safe-spot step). */
export const STEP = Object.freeze({ IDLE: 0, CAPTURE: 1, WARM: 2, START: 3, PLAY: 4, SPOT: 5, REBUILD: 6, GO: 7 });
const STEP_NAME = ['idle', 'capture', 'warm', 'start', 'play', 'spot', 'rebuild', 'go'];

/**
 * The controls card on the "Get ready" panel (the page's "How to play" has
 * the same list). Lines starting with '[' are drawn dimmer.
 */
export const CONTROLS = Object.freeze([
  '[How to play]',
  'Glock: right hand on your right hip, squeeze the grip',
  'AKM: right hand over your right shoulder, squeeze the grip',
  'Fire: trigger · AKM selector (semi/safe/auto): right stick click',
  'Reload: A drops the mag · left grip at left hip, push it in',
  'Rack: left grip on the slide, pull back · B: slide release',
  'Pause: B + Y · Exit: hold Y for 2 s',
]);
const CAPTURE_LINES = Object.freeze(['Get ready', 'Reading your room…', ...CONTROLS]);
/** Last line of the card once the world is built. */
const CARD_NEXT = 'Pull the trigger, then stand in an open spot';
/** The card stays up at least this long before a trigger pull moves on (ms), and at most this long. */
export const CARD_MIN_MS = 1000;
export const CARD_MAX_MS = 8000;
/** A confirmed spot farther than this from where the world was built rebuilds it there (m). */
export const REBUILD_M = 0.25;

/** Grip fit escape hatch limits (?gripPitch=<deg>&gripY=<m>&gripZ=<m>). */
const GRIP_MAX_DEG = 30;
const GRIP_MAX_M = 0.08;

/**
 * Grip fit override from the page URL, for both guns:
 * - `gripPitch` (degrees, + = muzzle up): turns the gun about its palm point
 *   relative to the controller's aim ray (what WeaponView's FIT.aimPitch does);
 * - `gripY`, `gripZ` (metres, in the hand frame: + = up, + = back toward
 *   you): moves the gun in the hand (its palm point moves the other way, so
 *   the holstered gun shifts by the same amount).
 * Values are clamped (±30°, ±0.08 m); anything not a number counts as 0.
 * @param {URLSearchParams} params
 * @returns {{ pitchDeg: number, y: number, z: number, source: 'url'|'default' }}
 */
export function gripFitFromParams(params) {
  /** @param {string} k @param {number} max */
  const read = (k, max) => {
    const raw = params.get(k);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0;
  };
  const any = params.has('gripPitch') || params.has('gripY') || params.has('gripZ');
  return { pitchDeg: read('gripPitch', GRIP_MAX_DEG), y: read('gripY', GRIP_MAX_M), z: read('gripZ', GRIP_MAX_M), source: any ? 'url' : 'default' };
}

/** @param {number} v */
const mm = (v) => Math.round(v * 1000) / 1000;

/** Enemy pool size (GameSession keeps at most 4 alive; 2 more for bodies still lying there). */
export const MAX_ENEMIES = 6;
/** A 60 s timing run starts with wave 1 (replaces Phase 1's A button, which is a weapon button now). */
export const RUN_MS = 60000;

/** @typedef {import('../world/Layout.js').SpaceSnapshot} SpaceSnapshot */

/**
 * The world's own JSON-safe build report (walls, doors, spawn tiers…), when it has one.
 * @param {any} w
 */
function worldReport(w) {
  try { return w.report(); } catch (e) { return { error: String(e) }; }
}

export class PlayKit {
  /**
   * At load, after `assets.load()` and the audio decode, BEFORE the warm-up.
   * @param {{ gfx: { renderer: any, scene: import('three').Scene, camera: import('three').Camera, flashLights: import('three').PointLight[] },
   *   assets: any, audio: any, input: import('../xr/Input.js').Input, fixture?: SpaceSnapshot|null,
   *   grip?: { pitchDeg: number, y: number, z: number, source?: string } | null }} o
   *   fixture: a snapshot to use instead of the live capture (?emulate: IWER has no scene data);
   *   grip: the grip fit override (gripFitFromParams), applied to both guns once, here
   */
  constructor({ gfx, assets, audio, input, fixture = null, grip = null }) {
    const renderer = gfx.renderer, scene = gfx.scene;
    /** The scene camera the Loop renders with (three substitutes the XR camera). */
    this.sceneCamera = gfx.camera;
    this.events = new Events();
    this.world = new World();
    this.world.warmUp(); // the session's real build then runs on optimised code
    /** The world's meshes (the depth-only occluder and the dev overlay): in the scene and in every warm-up draw. */
    this.worldMeshes = this.world.warmMeshes();
    for (const m of this.worldMeshes) scene.add(m);
    this.planner = this.world.createPlanner({ maxRequests: 16 });
    this.player = new Player();
    this.fixture = fixture;
    this.audio = audio || null;

    const world = this.world;
    /** @type {any} */
    const ctx = {
      renderer, scene, camera: renderer.xr.getCamera(), session: null, space: null, input,
      events: this.events, audio: this.audio, world, assets, gfx: { flashLights: gfx.flashLights }, player: this.player,
      raycast: /** @type {any} */ (null),
    };
    this.ctx = ctx;
    this.enemies = new EnemyManager(assets, scene, MAX_ENEMIES, { world, planner: this.planner, light: gfx.flashLights[1] });
    this.enemies.bind(this.events); // applies 'enemyHit' itself: WeaponSystem gets no { enemies }
    const enemies = this.enemies;
    /**
     * CONTRACTS "Ctx.raycast": world + enemies, nearest. world.raycast and
     * enemies.raycast write `out` only on a hit, so the enemy pass is limited to
     * the world hit's distance.
     */
    ctx.raycast = (/** @type {number} */ ox, /** @type {number} */ oy, /** @type {number} */ oz,
      /** @type {number} */ dx, /** @type {number} */ dy, /** @type {number} */ dz,
      /** @type {number} */ max, /** @type {any} */ out, ignoreEnemy = -1) => {
      let reach = max;
      let got = false;
      if (world.built && world.raycast(ox, oy, oz, dx, dy, dz, max, out)) { got = true; reach = out.dist; }
      if (enemies.raycast(ox, oy, oz, dx, dy, dz, reach, out, ignoreEnemy)) got = true;
      return got;
    };
    this.weapons = new WeaponSystem(ctx);
    /** The effective grip fit, for the session record (`rec.play.grip`). */
    this.gripReport = this.applyGripFit(grip || { pitchDeg: 0, y: 0, z: 0, source: 'default' });
    this.game = new GameSession(ctx, { enemies: this.enemies, weapons: this.weapons });
    this.hud = new WristHud(ctx, { game: this.game, weapons: this.weapons });
    if (this.audio && typeof this.audio.bind === 'function') this.audio.bind(this.events);

    this.gate = new CaptureGate();
    /** @type {readonly string[]} the panel after the build (made once per build) */
    this.builtLines = CAPTURE_LINES;
    /** @type {number} STEP */ this.step = STEP.IDLE;
    /** @type {SpaceSnapshot|null} */ this.snapshot = null;
    this.captureStats = { planes: 0, meshes: 0, skippedPlanes: 0, skippedMeshes: 0 };
    /** @type {any} */ this.rec = null;
    /** @type {import('../debug/PerfMonitor.js').PerfMonitor|null} */ this.perf = null;
    /** @type {any} */ this.warmed = [];
    /** @type {any} */ this.warmReport = null;
    this.buildAtMs = -1;
    this.startedAtMs = -1;
    this.t0 = -1;
    /** Where the world was last built (x, z), and when the card went up after it (ms). */
    this.buildX = 0;
    this.buildZ = 0;
    this.cardAt = -1;
    /** @type {{ x: number, z: number, r: number, facing: number }|null} the confirmed spot (GameSession's reused object) */
    this.spotZone = null;
    this.spotMoved = 0;
    this.rebuilt = false;
    /** game.pickSpot's confirm callback (bound once). */
    this._onSpot = (/** @type {{ x: number, z: number, r: number, facing: number }} */ z) => this.spotConfirmed(z);
    this.runStarted = false;
    this.events.on('waveStart', (/** @type {{ wave: number }} */ p) => {
      if (p.wave === 1 && !this.runStarted && this.perf && !this.perf.running) {
        this.runStarted = true;
        this.perf.startRun(RUN_MS, 'play wave 1');
        this.perf.mark('run start');
      }
    });
    this.events.on('pause', (/** @type {{ paused: boolean, reason: string }} */ p) => {
      if (this.perf) this.perf.mark(!p.paused ? 'resume' : p.reason === 'zone' ? 'pause zone' : p.reason === 'hidden' ? 'pause hidden' : 'pause');
    });
  }

  get stepName() { return STEP_NAME[this.step]; }

  /**
   * Apply the grip fit override to both guns (once, at load). WeaponView has
   * no fit hook (its FIT is frozen), so this adjusts the objects the
   * WeaponSystem exposes: the view's palm point (the gun-space point held at
   * the controller's grip origin) and, for a pitch, the view's `holdPose`
   * (the aim-ray orientation turned about the gun's X axis first, exactly as
   * FIT.aimPitch would; allocation-free per call).
   * @param {{ pitchDeg: number, y: number, z: number, source?: string }} fit
   */
  applyGripFit(fit) {
    /** @type {{ pitchDeg: number, y: number, z: number, source: string, applied: string[], palm: Record<string, number[]>, notes: string[] }} */
    const rep = { pitchDeg: fit.pitchDeg || 0, y: fit.y || 0, z: fit.z || 0, source: fit.source || 'url', applied: [], palm: {}, notes: [] };
    const W = /** @type {any} */ (this.weapons);
    for (const id of ['glock', 'akm']) {
      const w = W[id], v = w && w.view;
      if (!v || !v.palm || typeof v.palm.set !== 'function' || typeof v.holdPose !== 'function') {
        rep.notes.push(`${id}: no palm / holdPose to adjust`);
        continue;
      }
      if (rep.y || rep.z) { v.palm.y -= rep.y; v.palm.z -= rep.z; }
      if (rep.pitchDeg) {
        const base = v.holdPose;
        const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rep.pitchDeg * Math.PI) / 180);
        const q = new THREE.Quaternion();
        v.holdPose = (/** @type {THREE.Vector3} */ gp, /** @type {THREE.Quaternion} */ hq, /** @type {THREE.Vector3} */ op, /** @type {THREE.Quaternion} */ oq) =>
          base.call(v, gp, q.copy(hq).multiply(pitch), op, oq);
      }
      if (rep.pitchDeg || rep.y || rep.z) rep.applied.push(id);
      rep.palm[id] = [mm(v.palm.x), mm(v.palm.y), mm(v.palm.z)];
    }
    return rep;
  }

  /** Everything the warm-up must draw (all already in the scene). */
  warmObjects() {
    return [...this.worldMeshes, ...this.weapons.warmMeshes(), ...this.enemies.warmMeshes(), ...this.game.warmMeshes(), ...this.hud.warmMeshes()];
  }

  /**
   * Show every pool for the warm-up draw (or restore after it).
   * @param {boolean} on
   */
  setWarm(on) {
    this.weapons.setWarm(on);
    this.enemies.setWarm(on);
    this.game.setWarm(on);
    this.hud.setWarm(on);
  }

  /**
   * A play session starts (after attachSession).
   * @param {{ session: XRSession, space: XRReferenceSpace, rec: any, perf: import('../debug/PerfMonitor.js').PerfMonitor, warmed: any[] }} o
   */
  begin({ session, space, rec, perf, warmed }) {
    const c = this.ctx;
    c.session = session;
    c.space = space;
    this.rec = rec;
    this.perf = perf;
    this.warmed = warmed || [];
    this.player.reset();
    this.gate.reset();
    this.snapshot = null;
    this.step = STEP.CAPTURE;
    this.t0 = -1;
    this.buildAtMs = -1;
    this.startedAtMs = -1;
    this.cardAt = -1;
    this.spotZone = null;
    this.spotMoved = 0;
    this.rebuilt = false;
    this.runStarted = false;
    this.warmReport = null;
    rec.play = { step: 'capture', grip: this.gripReport };
  }

  /**
   * The `world` system: the one-time capture, build and XR warm draw, then
   * world.update. Called with the shared ctx.
   * @param {number} dt @param {number} t @param {XRFrame} frame @param {any} ctx
   */
  worldUpdate(dt, t, frame, ctx) {
    if (this.t0 < 0) this.t0 = t;
    switch (this.step) {
      case STEP.CAPTURE: this.capture(t, frame); break;
      case STEP.WARM: this.warmInXR(); break;
      case STEP.START: this.waitCard(t); break;
      case STEP.REBUILD: this.rebuildForSpot(t); break;
      case STEP.GO: this.startRound(t); break;
      default: break;
    }
    this.world.update(dt, t, frame, ctx);
  }

  /** @param {number} t @param {XRFrame} frame */
  capture(t, frame) {
    // A fixture needs no wait; a live capture waits for stable planes (or 3 s).
    // `gate.update` returns true once, so `gate.done` carries it to later frames.
    const ready = this.fixture ? t - this.t0 >= 300 : this.gate.update(frame, t) || this.gate.done;
    // the zone is centred on the head: wait for a pose (the player system ran last frame)
    if (!ready || !this.player.valid) return;
    const S = this.captureStats;
    S.planes = S.meshes = S.skippedPlanes = S.skippedMeshes = 0;
    let snap = this.fixture;
    let source = 'fixture';
    if (!snap) {
      source = 'live';
      try {
        snap = captureSnapshot(frame, this.ctx.space, { spaceName: this.rec?.granted?.referenceSpace || 'local-floor', stats: S });
      } catch (e) {
        snap = null;
        this.note(`capture failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.snapshot = snap;
    const p = this.player;
    const tb = performance.now();
    this.world.build(snap, { x: p.head.x, z: p.head.z, r: this.game.rules.zoneR });
    const buildMs = performance.now() - tb;
    this.buildX = p.head.x;
    this.buildZ = p.head.z;
    this.buildAtMs = Math.round(t - this.t0);
    if (this.perf) this.perf.mark('world build');
    this.builtLines = ['Get ready', this.world.describe(), ...CONTROLS, CARD_NEXT];
    if (this.rec) {
      // the user's real house, replayable on desktop (?emulate&snapshot=…)
      this.rec.spaceSnapshot = snap;
      this.rec.play = {
        step: 'warm', source, grip: this.gripReport,
        capture: { ...S, atMs: this.buildAtMs, planesInSnapshot: snap ? snap.planes.length : 0, meshesInSnapshot: snap ? snap.meshes.length : 0 },
        world: this.worldRecord(buildMs),
      };
    }
    this.step = STEP.WARM;
  }

  /**
   * One draw of every pool inside this XR frame, before its own render (which
   * clears and draws over it).
   */
  warmInXR() {
    this.setWarm(true);
    let rep = null;
    try {
      rep = warmXR(this.ctx.renderer, this.ctx.scene, this.sceneCamera, this.warmed);
    } finally {
      this.setWarm(false);
    }
    this.warmReport = rep;
    if (this.rec) this.rec.warmXR = rep ? { skipped: rep.skipped || undefined, ms: Math.round(rep.ms * 10) / 10, drawables: rep.drawables, calls: rep.calls, grew: rep.grew, programs: rep.programs } : null;
    if (this.perf) this.perf.mark('warmXR');
    this.step = STEP.START;
  }

  /**
   * The session record's view of the world just built (allocates: build time only).
   * `report` is the world's own JSON-safe report; session end refreshes it with the spawn tiers used.
   * @param {number} buildMs
   */
  worldRecord(buildMs) {
    const W = this.world;
    return { describe: W.describe(), buildMs: Math.round(buildMs * 10) / 10, virtual: W.virtual, partialVirtual: W.partialVirtual,
      zone: { ...W.zone }, occluderBoxes: W.occluderBoxes, stats: { ...W.stats, notes: W.stats.notes.slice(0, 20) },
      report: worldReport(W) };
  }

  /**
   * The card stays up until a trigger pull is released (after CARD_MIN_MS) or CARD_MAX_MS;
   * then the player chooses the spot (GameSession's panel and ring).
   * @param {number} t
   */
  waitCard(t) {
    if (this.cardAt < 0) this.cardAt = t;
    const up = t - this.cardAt;
    const I = this.ctx.input;
    // Move on when the pull is RELEASED (and never while a trigger is held): pickSpot runs before
    // game.preUpdate in this same frame, and a trigger-down edge there would also confirm a clear
    // (or unmapped) spot at once, skipping the spot step the player was just told about.
    const released = !!I && ((I.left && I.left.triggerUp) || (I.right && I.right.triggerUp));
    const held = !!I && ((I.left && I.left.triggerHeld) || (I.right && I.right.triggerHeld));
    if (!((up >= CARD_MAX_MS && !held) || (released && up >= CARD_MIN_MS))) return;
    this.game.pickSpot(this._onSpot);
    this.step = STEP.SPOT;
    if (this.rec && this.rec.play) { this.rec.play.step = 'spot'; this.rec.play.cardMs = Math.round(up); this.rec.play.cardSkipped = up < CARD_MAX_MS; }
  }

  /**
   * game.pickSpot's callback, inside game.preUpdate (the player step): the round
   * starts in the next frame's world step, after a rebuild when the spot moved.
   * @param {{ x: number, z: number, r: number, facing: number }} zone
   */
  spotConfirmed(zone) {
    if (this.step !== STEP.SPOT) return;
    this.spotZone = zone;
    this.spotMoved = Math.hypot(zone.x - this.buildX, zone.z - this.buildZ);
    this.step = this.spotMoved > REBUILD_M ? STEP.REBUILD : STEP.GO;
    if (this.perf) this.perf.mark('spot');
  }

  /**
   * The spot moved: build the world again around it (App's panel is up this
   * frame and the next, which draws, and so uploads, the occluder's new buffers).
   * @param {number} t
   */
  rebuildForSpot(t) {
    const z = this.spotZone, W = this.world;
    if (z) {
      const tb = performance.now();
      try {
        W.build(W.snapshot, z, { doors: W.doorOpen.slice() });
      } catch (e) {
        this.note(`rebuild for the spot failed: ${e instanceof Error ? e.message : e}`);
      }
      const buildMs = performance.now() - tb;
      this.buildX = z.x;
      this.buildZ = z.z;
      this.rebuilt = true;
      const d = W.describe();
      if (d !== this.builtLines[1]) this.builtLines = ['Get ready', d, ...CONTROLS, CARD_NEXT];
      if (this.perf) this.perf.mark('world rebuild');
      if (this.rec && this.rec.play) {
        const first = this.rec.play.world;
        this.rec.play.world = { ...this.worldRecord(buildMs), firstBuildMs: first ? first.buildMs : null,
          rebuild: { movedM: Math.round(this.spotMoved * 100) / 100, buildMs: Math.round(buildMs * 10) / 10, atMs: Math.round(t - this.t0) } };
      }
    }
    this.step = STEP.GO;
  }

  /** @param {number} t */
  startRound(t) {
    const z = this.spotZone;
    this.game.start(z || this.world.zone);
    this.startedAtMs = Math.round(t - this.t0);
    if (this.rec && this.rec.play) {
      this.rec.play.step = 'play';
      this.rec.play.startedAtMs = this.startedAtMs;
      this.rec.play.spot = { movedM: Math.round(this.spotMoved * 100) / 100, rebuilt: this.rebuilt, r: z ? z.r : this.world.zone.r };
    }
    this.step = STEP.PLAY;
  }

  /**
   * The systems for the Loop, in the contract order ('input' and 'render' are App's / Loop's).
   * GameSession decides pauses and enemy freezes in `preUpdate`, right after the player and
   * before weapons and enemies run; frozen enemies are stepped with dt = 0.
   */
  systems() {
    const c = this.ctx, game = /** @type {any} */ (this.game);
    const pre = typeof game.preUpdate === 'function';
    return [
      { name: 'world', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.worldUpdate(dt, t, f, c) },
      { name: 'player', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => {
        this.player.update(dt, t, f, c);
        if (pre) game.preUpdate(dt, t, f, c);
      } },
      { name: 'weapons', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.weapons.update(dt, t, f, c) },
      { name: 'enemies', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.enemies.update(game.freezeEnemies ? 0 : dt, t, f, c) },
      { name: 'game', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.game.update(dt, t, f, c) },
      { name: 'audio', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => { if (this.audio) this.audio.update(dt, t, f, c); } },
    ];
  }

  /** @param {string} state XRSession.visibilityState */
  setVisibility(state) { this.game.setVisibility(state); }

  onReferenceReset() { if (this.step === STEP.PLAY || this.step === STEP.SPOT) this.game.onReferenceReset(); }

  /** Session over: everything idle and hidden, a summary into the record. */
  end() {
    const rec = this.rec;
    if (rec) {
      const g = this.game, w = this.weapons, e = this.enemies;
      const world = rec.play && rec.play.world;
      if (world && this.world.built) world.report = worldReport(this.world); // again: with the spawn tiers used
      /** @type {any} */ let safety = null;
      try { safety = g.safetyReport(); } catch (err) { safety = { error: String(err) }; } // before stop(), which clears the counts
      rec.play = {
        ...(rec.play || {}), step: this.stepName, phase: g.phaseName, wave: g.wave, kills: g.kills, health: g.health,
        game: { ...g.stats }, weapons: { ...w.stats }, enemies: { ...e.stats }, hudDraws: this.hud.draws, messageUploads: g.panel.uploads,
        safety,
      };
    }
    this.game.stop();
    this.enemies.reset();
    this.weapons.reset();
    this.step = STEP.IDLE;
    this.ctx.session = null;
    this.ctx.space = null;
    this.rec = null;
    this.perf = null;
  }

  /** @param {string} msg */
  note(msg) {
    if (this.rec && this.rec.errors && this.rec.errors.length < 50) this.rec.errors.push(msg);
  }

  /**
   * Lines for App's opaque panel before the round starts (null = hide it).
   * Hidden while the spot is chosen (GameSession's own panel and ring show
   * then). Cached arrays: no allocation per frame.
   */
  panelLines() {
    if (this.game.spotting) return null;
    switch (this.step) {
      case STEP.CAPTURE: return CAPTURE_LINES;
      case STEP.WARM: case STEP.START: case STEP.REBUILD: return this.builtLines;
      case STEP.GO: return this.rebuilt ? this.builtLines : null;
      default: return null; // IDLE, SPOT (game.spotting), PLAY
    }
  }

  /** True once the round runs (GameSession shows its own messages). */
  get playing() { return this.step === STEP.PLAY && this.game.phase !== PHASE.IDLE; }
}
