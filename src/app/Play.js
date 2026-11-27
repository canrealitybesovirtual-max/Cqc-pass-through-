// @ts-check
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
 *      opaque "Get ready" panel);
 *   3. warm: next frame, one draw of every pool into the XR framebuffer
 *      (`warmXR`, before that frame's own render), re-baselining the counts;
 *   4. play: `game.start(world.zone)`; GameSession takes over the messages.
 *
 * Systems, in the contract order (PerfMonitor names = PLAY_SYSTEMS):
 * input → world → player → weapons → enemies → game → audio → ui → render.
 * Allocation-free per frame once playing (the one-time capture and build
 * aside).
 */
export const PLAY_SYSTEMS = Object.freeze(['input', 'world', 'player', 'weapons', 'enemies', 'game', 'audio', 'ui', 'render']);

/** Session steps. */
export const STEP = Object.freeze({ IDLE: 0, CAPTURE: 1, WARM: 2, PLAY: 3 });
const STEP_NAME = ['idle', 'capture', 'warm', 'play'];

/** Enemy pool size (GameSession keeps at most 4 alive; 2 more for bodies still lying there). */
export const MAX_ENEMIES = 6;
/** A 60 s timing run starts with wave 1 (replaces Phase 1's A button, which is a weapon button now). */
export const RUN_MS = 60000;

/** @typedef {import('../world/Layout.js').SpaceSnapshot} SpaceSnapshot */

export class PlayKit {
  /**
   * At load, after `assets.load()` and the audio decode, BEFORE the warm-up.
   * @param {{ gfx: { renderer: any, scene: import('three').Scene, flashLights: import('three').PointLight[] },
   *   assets: any, audio: any, input: import('../xr/Input.js').Input, fixture?: SpaceSnapshot|null }} o
   *   fixture: a snapshot to use instead of the live capture (?emulate: IWER has no scene data)
   */
  constructor({ gfx, assets, audio, input, fixture = null }) {
    const renderer = gfx.renderer, scene = gfx.scene;
    this.events = new Events();
    this.world = new World();
    this.world.warmUp(); // the session's real build then runs on optimised code
    scene.add(this.world.occluder);
    this.planner = this.world.createPlanner({ maxRequests: 16 });
    this.player = new Player();
    /** One reused hit record for the combined raycast's world pass. */
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
    this.game = new GameSession(ctx, { enemies: this.enemies, weapons: this.weapons });
    this.hud = new WristHud(ctx, { game: this.game, weapons: this.weapons });
    if (this.audio && typeof this.audio.bind === 'function') this.audio.bind(this.events);

    this.gate = new CaptureGate();
    this.step = STEP.IDLE;
    /** @type {SpaceSnapshot|null} */ this.snapshot = null;
    this.captureStats = { planes: 0, meshes: 0, skippedPlanes: 0, skippedMeshes: 0 };
    /** @type {any} */ this.rec = null;
    /** @type {import('../debug/PerfMonitor.js').PerfMonitor|null} */ this.perf = null;
    /** @type {any} */ this.warmed = [];
    /** @type {any} */ this.warmReport = null;
    this.buildAtMs = -1;
    this.startedAtMs = -1;
    this.t0 = -1;
    this.runStarted = false;
    this.events.on('waveStart', (/** @type {{ wave: number }} */ p) => {
      if (p.wave === 1 && !this.runStarted && this.perf && !this.perf.running) {
        this.runStarted = true;
        this.perf.startRun(RUN_MS, 'play wave 1');
        this.perf.mark('run start');
      }
    });
    this.events.on('pause', (/** @type {{ paused: boolean, reason: string }} */ p) => {
      if (this.perf) this.perf.mark(p.paused ? `pause ${p.reason}` : 'resume');
    });
  }

  get stepName() { return STEP_NAME[this.step]; }

  /** Everything the warm-up must draw (all already in the scene). */
  warmObjects() {
    return [this.world.occluder, ...this.weapons.warmMeshes(), ...this.enemies.warmMeshes(), ...this.game.warmMeshes(), ...this.hud.warmMeshes()];
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
    this.runStarted = false;
    this.warmReport = null;
    rec.play = { step: 'capture' };
  }

  /**
   * The `world` system: the one-time capture, build and XR warm draw, then
   * world.update. Called with the shared ctx.
   * @param {number} dt @param {number} t @param {XRFrame} frame @param {any} ctx
   */
  worldUpdate(dt, t, frame, ctx) {
    if (this.t0 < 0) this.t0 = t;
    if (this.step === STEP.CAPTURE) this.capture(t, frame);
    else if (this.step === STEP.WARM) this.warmInXR(t);
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
    this.buildAtMs = Math.round(t - this.t0);
    if (this.perf) this.perf.mark('world build');
    if (this.rec) {
      // the user's real house, replayable on desktop (?emulate&snapshot=…)
      this.rec.spaceSnapshot = snap;
      const W = this.world;
      this.rec.play = {
        step: 'warm', source, capture: { ...S, atMs: this.buildAtMs, planesInSnapshot: snap ? snap.planes.length : 0, meshesInSnapshot: snap ? snap.meshes.length : 0 },
        world: { describe: W.describe(), buildMs: Math.round(buildMs * 10) / 10, virtual: W.virtual, partialVirtual: W.partialVirtual,
          zone: { ...W.zone }, occluderBoxes: W.occluderBoxes, stats: { ...W.stats, notes: W.stats.notes.slice(0, 20) } },
      };
    }
    this.step = STEP.WARM;
  }

  /**
   * One draw of every pool inside this XR frame, before its own render (which
   * clears and draws over it), then the round starts.
   * @param {number} t
   */
  warmInXR(t) {
    this.setWarm(true);
    let rep = null;
    try {
      rep = warmXR(this.ctx.renderer, this.ctx.scene, this.ctx.renderer.xr.getCamera(), this.warmed);
    } finally {
      this.setWarm(false);
    }
    this.warmReport = rep;
    if (this.rec) this.rec.warmXR = rep ? { skipped: rep.skipped || undefined, ms: Math.round(rep.ms * 10) / 10, drawables: rep.drawables, calls: rep.calls, grew: rep.grew, programs: rep.programs } : null;
    if (this.perf) this.perf.mark('warmXR');
    this.game.start(this.world.zone);
    this.startedAtMs = Math.round(t - this.t0);
    if (this.rec && this.rec.play) { this.rec.play.step = 'play'; this.rec.play.startedAtMs = this.startedAtMs; }
    this.step = STEP.PLAY;
  }

  /** The systems for the Loop, in the contract order ('input' and 'render' are App's / Loop's). */
  systems() {
    const c = this.ctx;
    return [
      { name: 'world', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.worldUpdate(dt, t, f, c) },
      { name: 'player', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.player.update(dt, t, f, c) },
      { name: 'weapons', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.weapons.update(dt, t, f, c) },
      { name: 'enemies', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.enemies.update(dt, t, f, c) },
      { name: 'game', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.game.update(dt, t, f, c) },
      { name: 'audio', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => { if (this.audio) this.audio.update(dt, t, f, c); } },
    ];
  }

  /** @param {string} state XRSession.visibilityState */
  setVisibility(state) { this.game.setVisibility(state); }

  onReferenceReset() { if (this.step === STEP.PLAY) this.game.onReferenceReset(); }

  /** Session over: everything idle and hidden, a summary into the record. */
  end() {
    const rec = this.rec;
    if (rec) {
      const g = this.game, w = this.weapons, e = this.enemies;
      rec.play = {
        ...(rec.play || {}), step: this.stepName, phase: g.phaseName, wave: g.wave, kills: g.kills, health: g.health,
        game: { ...g.stats }, weapons: { ...w.stats }, enemies: { ...e.stats }, hudDraws: this.hud.draws, messageUploads: g.panel.uploads,
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

  /** Lines for App's opaque panel before the round starts (null = hide it). */
  panelLines() {
    if (this.step === STEP.CAPTURE) return ['Get ready', 'Reading your room…', 'Stand where you want to fight'];
    if (this.step === STEP.WARM) return ['Get ready', this.world.describe()];
    return null;
  }

  /** True once the round runs (GameSession shows its own messages). */
  get playing() { return this.step === STEP.PLAY && this.game.phase !== PHASE.IDLE; }
}
