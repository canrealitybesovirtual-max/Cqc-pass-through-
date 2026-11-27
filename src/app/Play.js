// @ts-check
import { Events } from '../core/Events.js';
import { warmXR } from '../core/Warmup.js';
import { World, CaptureGate, captureSnapshot, DriftWatch, pickReferencePlanes, resetTransform } from '../world/World.js';
import { mul4, transformPointXZ, yawOf } from '../world/Realign.js';
import { Player } from '../game/Player.js';
import { GameSession } from '../game/GameSession.js';
import { PHASE } from '../game/Rules.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { CONTROLS_CARD } from '../weapons/Controls.js';
import { FIT_KEY, adjFromUrl } from '../weapons/GunFit.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { Watch, installWatchSounds } from '../ui/Watch.js';
import { SETTINGS_KEY, parseSettings, serializeSettings } from './Settings.js';

/**
 * The play mode's game (CONTRACTS.md "Integration"): every system is built
 * ONCE at load (before the warm-up), and each play session only starts and
 * stops it. App owns the XR session, the Loop and the PerfMonitor; this owns
 * the shared runtime context (`ctx`, CONTRACTS "Ctx") and the session steps:
 *
 *   1. capture: CaptureGate waits until the Space Setup plane count is stable
 *      (0.5 s) or 3 s have passed, then `captureSnapshot` copies it (in
 *      ?emulate: the house fixture) and keeps the live planes for the drift
 *      watch; the snapshot goes into the session record (`rec.spaceSnapshot`);
 *   2. build: `world.build(snapshot, head, { roam: game.roam })` once
 *      (synchronous, behind App's opaque "Get ready" panel with the controls
 *      card); in Roam the bake then runs in slices inside world.update (4 ms a
 *      frame while the card is up, 1 ms in play);
 *   3. warm: next frame, one draw of every pool into the XR framebuffer
 *      (`warmXR`, before that frame's own render), re-baselining the counts;
 *   4. start: the card stays up until a trigger pull is released (after 1 s) or
 *      8 s (the same pull never also confirms the spot);
 *   5. spot: `game.pickSpot`. Roam (the default): the current position, on the
 *      next frame, no ring, no rebuild. Spot mode: SafeSpot's ring until the
 *      player pulls the trigger in an open spot (GameSession's own panel);
 *   6. rebuild (spot mode only, when the spot is > 0.25 m from where the world
 *      was built): `world.build(snapshot, zone, { doors })` behind App's panel;
 *   7. go: `game.start(zone)`; GameSession takes over (Roam: no text in the
 *      view during play; the watch shows the wave);
 *   8. realign (a reference-space reset during the round, or drift of the
 *      Space Setup planes found by the DriftWatch, research-roam §3): the game
 *      is paused and held (enemies back in the queue); the world is rebuilt
 *      moved by the reset's transform / the drift correction (or, without a
 *      transform, from a fresh capture), then
 *   9. rewarm: one warmXR draw (the occluder's rewritten buffers upload), and
 *      `game.realigned()` releases the hold (the normal resume protocol).
 *   A reset before the round (capture, warm, card, spot) goes back to capture
 *   silently. The watch's MODE row rebuilds the world in the other mode and
 *   restarts at the card (step 3).
 *
 * The watch (src/ui/Watch.js) is the only menu: its actions come to
 * `onWatch` (inside the frame; storage writes go to a setTimeout). Gun fit
 * nudges are applied live (`weapons.setFit`) and saved per weapon in
 * localStorage[FIT_KEY]; difficulty and the ammo line in
 * localStorage[SETTINGS_KEY].
 *
 * Systems, in the contract order (PerfMonitor names = PLAY_SYSTEMS):
 * input → world → player → weapons → enemies → game → audio → ui → render.
 * Allocation-free per frame once playing (the one-time capture and builds,
 * the 1/s drift check's browser poses and the watch's button actions aside).
 */
export const PLAY_SYSTEMS = Object.freeze(['input', 'world', 'player', 'weapons', 'enemies', 'game', 'audio', 'ui', 'render']);

/** Session steps (numbers kept from v0.2; SPOT, REBUILD and GO came with the safe-spot step, REALIGN and REWARM with Roam). */
export const STEP = Object.freeze({ IDLE: 0, CAPTURE: 1, WARM: 2, START: 3, PLAY: 4, SPOT: 5, REBUILD: 6, GO: 7, REALIGN: 8, REWARM: 9 });
const STEP_NAME = ['idle', 'capture', 'warm', 'start', 'play', 'spot', 'rebuild', 'go', 'realign', 'rewarm'];

/**
 * The controls card on the "Get ready" panel: the weapon card
 * (src/weapons/Controls.js CONTROLS_CARD, CQC's Quest map) and the game's
 * own buttons. Lines starting with '[' are drawn dimmer.
 */
export const CONTROLS = Object.freeze([
  ...CONTROLS_CARD,
  'Menu: look at your watch, touch it',
  'Pause: B + Y · Exit: hold Y for 2 s',
]);
const CAPTURE_LINES = Object.freeze(['Get ready', 'Reading your room…', ...CONTROLS]);
/** Last line of the card once the world is built (Roam / spot mode). */
const CARD_NEXT_ROAM = 'Pull the trigger to start';
const CARD_NEXT_SPOT = 'Pull the trigger, then stand in an open spot';
/** The card stays up at least this long before a trigger pull moves on (ms), and at most this long. */
export const CARD_MIN_MS = 1000;
export const CARD_MAX_MS = 8000;
/** A confirmed spot farther than this from where the world was built rebuilds it there (m; spot mode). */
export const REBUILD_M = 0.25;
/** Roam bake budget per frame while the opaque card is up, and in play (ms). */
export const BAKE_CARD_MS = 4;
export const BAKE_PLAY_MS = 1;

export { SETTINGS_KEY, gripFitFromParams, watchFitFromParams, parseSettings } from './Settings.js';

/** @param {number} v */
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Enemy pool size (GameSession keeps at most 4 alive; 2 more for bodies still lying there). */
export const MAX_ENEMIES = 6;
/** A 60 s timing run starts with wave 1 (replaces Phase 1's A button, which is a weapon button now). */
export const RUN_MS = 60000;
/** Enemy cloth's response to the room environment (research-fit E: cloth looked shiny at 1). */
export const ENEMY_CLOTH_ENV = 0.35;

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
   * @param {{ gfx: { renderer: any, scene: import('three').Scene, camera: import('three').Camera, flashLights: import('three').PointLight[],
   *     envTexture?: any, lighting?: any },
   *   assets: any, audio: any, input: import('../xr/Input.js').Input, fixture?: SpaceSnapshot|null,
   *   grip?: { pitchDeg: number, y: number, z: number, source?: string } | null,
   *   gloves?: boolean, watchFit?: { back?: number, out?: number, tiltDeg?: number, scale?: number } | null, bracelet?: boolean,
   *   difficultyFromUrl?: boolean, storage?: Storage | null }} o
   *   fixture: a snapshot to use instead of the live capture (?emulate: IWER has no scene data);
   *   grip: the URL grip fit override (gripFitFromParams; applied over the saved fit, never saved);
   *   gloves (default true): the gloved hands on held guns (?gloves=0 turns them off);
   *   watchFit / bracelet: the watch on the wrist (URL knobs); difficultyFromUrl: ?difficulty= was given (it wins over the saved one);
   *   storage: localStorage (read here, at load; written only from a setTimeout)
   */
  constructor({ gfx, assets, audio, input, fixture = null, grip = null, gloves = true, watchFit = null, bracelet = true,
    difficultyFromUrl = false, storage = null }) {
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
    /** @type {Storage|null} */ this.storage = storage;
    /** The room environment (Renderer: PMREM, set before the warm-up and never replaced) and the light levels, for the record. */
    this.envTexture = gfx.envTexture || null;
    this.lighting = gfx.lighting || null;

    const world = this.world;
    /** @type {any} */
    const ctx = {
      renderer, scene, camera: renderer.xr.getCamera(), session: null, space: null, input,
      events: this.events, audio: this.audio, world, assets, gfx: { flashLights: gfx.flashLights }, player: this.player,
      raycast: /** @type {any} */ (null), body: null,
    };
    this.ctx = ctx;
    // Enemy cloth: dimmer in the room environment (a uniform: no program change). The pool's clones share the material.
    const sm = assets && assets.models && assets.models.soldier && assets.models.soldier.mesh ? assets.models.soldier.mesh.material : null;
    for (const m of Array.isArray(sm) ? sm : sm ? [sm] : []) if (m && 'envMapIntensity' in m) m.envMapIntensity = ENEMY_CLOTH_ENV;
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
    /** One seated decision for everyone (BodyEstimator's): GameSession reads ctx.body.seated, Player gets seatedOverride. */
    ctx.body = this.weapons.body;
    // Gun fit: saved (per weapon) → the URL override on top (never saved) → the watch's fit page starts from these.
    try { this.weapons.loadFits(storage ? storage.getItem(FIT_KEY) : null); } catch { this.weapons.loadFits(null); }
    /** @type {{ pitchDeg: number, y: number, z: number, source: string }|null} */
    this.gripUrl = grip && grip.source === 'url' ? { pitchDeg: grip.pitchDeg || 0, y: grip.y || 0, z: grip.z || 0, source: 'url' } : null;
    if (this.gripUrl) {
      const a = adjFromUrl(this.gripUrl);
      this.weapons.setFit('glock', a, 'url');
      this.weapons.setFit('akm', a, 'url');
    }
    this.gloves = gloves !== false;
    this.weapons.setGloves(this.gloves);
    /** The effective grip fit at load (WeaponSystem.fitReport; `rec.play.grip` is refreshed at session end). */
    this.gripReport = this.weapons.fitReport();
    /** @type {{ difficulty: 'test'|'realistic', ammoLine: boolean }} */
    this.settings = parseSettings(readKey(storage, SETTINGS_KEY));
    if (!difficultyFromUrl) this.enemies.setDifficulty(this.settings.difficulty);
    this.game = new GameSession(ctx, { enemies: this.enemies, weapons: this.weapons });
    this.watch = new Watch(ctx, { game: this.game, weapons: this.weapons, audio: this.audio, fit: watchFit, bracelet,
      onAction: (n, v) => this.onWatch(n, v) });
    this.watch.enabled = false; // on in play sessions only
    this.game.setWarnSink(this.watch); // diegetic cues: the watch vibrates and shows the warning
    this.watch.setStatus({ difficulty: this.enemies.diff.name === 'realistic' ? 'realistic' : 'test', playMode: 'roam', ammoLine: this.settings.ammoLine });
    for (const id of /** @type {const} */ (['glock', 'akm'])) { const f = this.weapons.getFit(id); this.watch.setFit(id, f.pitch, f.up, f.fwd); }
    /** The watch's ticks and alert are AudioBuffers made here (after decodeAll, before Enter). */
    this.watchSounds = this.audio ? installWatchSounds(this.audio) : false;
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

    // ── Roam: drift watch and realign (research-roam §3) ──
    this.drift = new DriftWatch();
    /** @type {any[]} the live XRPlanes of the capture, in snapshot order */ this._keep = [];
    /** @type {number[]} indices of the reference planes in the snapshot */ this.refIdx = [];
    /** @type {any[]} the reference XRPlanes (drift checks) */ this.refPlanes = [];
    /** The pending realign: old → new transform (when `realignHasM`), its cause. */
    this.realignM = new Float64Array(16);
    this._mTmp = new Float64Array(16);
    this.realignHasM = false;
    this.realignCause = '';
    this.realignAt = 0;
    this.realignBuildMs = 0;
    this.realignPlanes = 0;
    /** @type {{ x: number, z: number }} */ this._zoneTmp = { x: 0, z: 0 };
    /** Session-record arrays (event-time pushes only). @type {any[]} */ this.resets = [];
    /** @type {any[]} */ this.realigns = [];
    /** @type {string|null} attachSession's honest line when Roam has no `unbounded` */ this.spaceNote = null;
    this.spaceName = '';

    // ── watch actions ──
    /** -1 none, 0 spot, 1 Roam: the watch's MODE row asked for a rebuild in that mode. */
    this.modeWanted = -1;
    /** @type {any[]} */ this.modeSwitches = [];
    this._fitAdj = { pitch: 0, up: 0, fwd: 0 };
    /** Weapons whose fit is waiting to be written (bit 1 Glock, bit 2 AKM). */
    this._fitSaveMask = 0;
    /** @type {any[]} saved fits this session (rec.play.fitSaves) */ this.fitSaves = [];
    this._settingsQueued = false;
    /** @type {Record<string, number>} */ this.watchActions = { menu: 0, resume: 0, restart: 0, exit: 0, difficulty: 0, mode: 0, ammoLine: 0, fitBegin: 0, fit: 0, fitSave: 0, fitEnd: 0 };
    /** @type {string[]} storage errors (the record) */ this.storageErrors = [];
    this._saveFitsNow = () => this.writeFits();
    this._saveSettingsNow = () => this.writeSettings();

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

  /** Everything the warm-up must draw (all already in the scene). */
  warmObjects() {
    return [...this.worldMeshes, ...this.weapons.warmMeshes(), ...this.enemies.warmMeshes(), ...this.game.warmMeshes(), ...this.watch.warmMeshes()];
  }

  /**
   * Show every pool for the warm-up draw (or restore after it).
   * @param {boolean} on
   */
  setWarm(on) {
    this.weapons.setWarm(on);
    this.enemies.setWarm(on);
    this.game.setWarm(on);
    this.watch.setWarm(on);
  }

  /**
   * A play session starts (after attachSession).
   * @param {{ session: XRSession, space: XRReferenceSpace, rec: any, perf: import('../debug/PerfMonitor.js').PerfMonitor, warmed: any[],
   *   roam?: boolean, spaceName?: string, spaceNote?: string|null }} o
   *   roam: Roam rules (default) or the stationary spot mode; spaceName / spaceNote: the space in use and the honest line when Roam has no `unbounded`
   */
  begin({ session, space, rec, perf, warmed, roam = true, spaceName = '', spaceNote = null }) {
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
    this.modeWanted = -1;
    this.modeSwitches = [];
    this.fitSaves = [];
    this.resets = [];
    this.realigns = [];
    this.realignHasM = false;
    this.refIdx = [];
    this.refPlanes = [];
    this.drift.setReference(null, []);
    this.spaceName = spaceName;
    this.spaceNote = spaceNote;
    for (const k in this.watchActions) this.watchActions[k] = 0;
    this.game.setRoam(roam);
    this.watch.setStatus({ playMode: roam ? 'roam' : 'spot' });
    this.watch.enabled = true;
    this.weapons.triggerBlocked = false;
    rec.play = { step: 'capture', mode: roam ? 'roam' : 'spot', grip: this.gripReport };
  }

  /**
   * The `world` system: the one-time capture, build and XR warm draw, the
   * realign steps, the drift watch, then world.update. Called with the shared ctx.
   * @param {number} dt @param {number} t @param {XRFrame} frame @param {any} ctx
   */
  worldUpdate(dt, t, frame, ctx) {
    if (this.t0 < 0) this.t0 = t;
    if (this.modeWanted >= 0) this.switchMode(t);
    switch (this.step) {
      case STEP.CAPTURE: this.capture(t, frame); break;
      case STEP.WARM: this.warmInXR(); this.step = STEP.START; break;
      case STEP.START: this.waitCard(t); break;
      case STEP.REBUILD: this.rebuildForSpot(t); break;
      case STEP.GO: this.startRound(t); break;
      case STEP.PLAY: this.driftStep(t, frame); break;
      case STEP.REALIGN: this.realignStep(t, frame); break;
      case STEP.REWARM: this.rewarm(t); break;
      default: break;
    }
    this.world.update(dt, t, frame, ctx);
  }

  /** @param {number} t @param {XRFrame} frame */
  capture(t, frame) {
    // A fixture needs no wait; a live capture waits for stable planes (or 3 s).
    // `gate.update` returns true once, so `gate.done` carries it to later frames.
    const ready = this.fixture ? t - this.t0 >= 300 : this.gate.update(frame, t) || this.gate.done;
    // the start is the head: wait for a pose (the player system ran last frame)
    if (!ready || !this.player.valid) return;
    const S = this.captureStats;
    S.planes = S.meshes = S.skippedPlanes = S.skippedMeshes = 0;
    const snap = this.takeSnapshot(frame);
    const source = this.fixture ? 'fixture' : 'live';
    this.snapshot = snap;
    this.setDriftReference(snap, !this.fixture);
    const p = this.player;
    const tb = performance.now();
    this.world.build(snap, { x: p.head.x, z: p.head.z, r: this.game.rules.zoneR }, { roam: this.game.roam });
    const buildMs = performance.now() - tb;
    this.world.bakeBudgetMs = BAKE_CARD_MS; // the opaque card is up: bake faster
    this.buildX = p.head.x;
    this.buildZ = p.head.z;
    this.buildAtMs = Math.round(t - this.t0);
    if (this.perf) this.perf.mark('world build');
    this.makeCard();
    if (this.rec) {
      // the user's real house, replayable on desktop (?emulate&snapshot=…)
      this.rec.spaceSnapshot = snap;
      this.rec.play = {
        step: 'warm', source, mode: this.game.roam ? 'roam' : 'spot', grip: this.gripReport,
        capture: { ...S, atMs: this.buildAtMs, planesInSnapshot: snap ? snap.planes.length : 0, meshesInSnapshot: snap ? snap.meshes.length : 0, refPlanes: this.refIdx.length },
        world: this.worldRecord(buildMs),
      };
    }
    this.step = STEP.WARM;
  }

  /**
   * The Space Setup snapshot now: the fixture, or a live capture that keeps
   * the XRPlanes (allocates: capture time only).
   * @param {XRFrame} frame
   * @returns {SpaceSnapshot|null}
   */
  takeSnapshot(frame) {
    if (this.fixture) { this._keep.length = 0; return this.fixture; }
    try {
      return captureSnapshot(frame, this.ctx.space, { spaceName: this.spaceName || (this.rec && this.rec.granted && this.rec.granted.referenceSpace) || 'local-floor',
        stats: this.captureStats, keep: this._keep });
    } catch (e) {
      this._keep.length = 0;
      this.note(`capture failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * The drift watch's reference planes from a live capture (none for the fixture: IWER has no planes).
   * @param {SpaceSnapshot|null} snap @param {boolean} live
   */
  setDriftReference(snap, live) {
    this.refIdx = live && snap ? pickReferencePlanes(snap) : [];
    this.refPlanes = this.refIdx.map((i) => this._keep[i]).filter((x) => !!x);
    if (this.refPlanes.length !== this.refIdx.length) { this.refIdx = []; this.refPlanes = []; }
    this.drift.setReference(this.refIdx.length ? snap : null, this.refIdx);
  }

  /** The card's lines after a build (made once per build). */
  makeCard() {
    this.builtLines = ['Get ready', this.world.describe(), ...CONTROLS, this.game.roam ? CARD_NEXT_ROAM : CARD_NEXT_SPOT];
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
    return rep;
  }

  /**
   * The session record's view of the world just built (allocates: build time only).
   * `report` is the world's own JSON-safe report; session end refreshes it with the spawn tiers used.
   * @param {number} buildMs
   */
  worldRecord(buildMs) {
    const W = this.world;
    return { describe: W.describe(), buildMs: Math.round(buildMs * 10) / 10, mode: W.roamOn ? 'roam' : 'spot', virtual: W.virtual, partialVirtual: W.partialVirtual,
      zone: { ...W.zone }, occluderBoxes: W.occluderBoxes, stats: { ...W.stats, notes: W.stats.notes.slice(0, 20) },
      report: worldReport(W) };
  }

  /**
   * The card stays up until a trigger pull is released (after CARD_MIN_MS) or CARD_MAX_MS;
   * then the start (Roam: where the player stands) or the spot choice.
   * @param {number} t
   */
  waitCard(t) {
    if (this.cardAt < 0) this.cardAt = t;
    const up = t - this.cardAt;
    const I = this.ctx.input;
    // Move on when the pull is RELEASED (and never while a trigger is held): pickSpot runs before
    // game.preUpdate in this same frame, and a trigger-down edge there would also confirm a clear
    // (or unmapped) spot at once, skipping the spot step the player was just told about.
    // A pull that belongs to the watch (pointing at it, its menu open) never moves on.
    const W = this.watch;
    const released = !W.capture && !W.menuOpen && !!I && ((I.left && I.left.triggerUp) || (I.right && I.right.triggerUp));
    const held = !!I && ((I.left && I.left.triggerHeld) || (I.right && I.right.triggerHeld));
    if (!((up >= CARD_MAX_MS && !held && !W.menuOpen) || (released && up >= CARD_MIN_MS))) return;
    this.game.pickSpot(this._onSpot);
    this.step = STEP.SPOT;
    if (this.rec && this.rec.play) { this.rec.play.step = 'spot'; this.rec.play.cardMs = Math.round(up); this.rec.play.cardSkipped = up < CARD_MAX_MS; }
  }

  /**
   * game.pickSpot's callback, inside game.preUpdate (the player step): the round
   * starts in the next frame's world step, after a rebuild when the spot moved (spot mode).
   * @param {{ x: number, z: number, r: number, facing: number }} zone
   */
  spotConfirmed(zone) {
    if (this.step !== STEP.SPOT) return;
    this.spotZone = zone;
    this.spotMoved = Math.hypot(zone.x - this.buildX, zone.z - this.buildZ);
    this.step = !this.game.roam && this.spotMoved > REBUILD_M ? STEP.REBUILD : STEP.GO;
    if (this.perf) this.perf.mark('spot');
  }

  /**
   * The spot moved (spot mode): build the world again around it (App's panel is
   * up this frame and the next, which draws, and so uploads, the occluder's new buffers).
   * @param {number} t
   */
  rebuildForSpot(t) {
    const z = this.spotZone, W = this.world;
    if (z) {
      const tb = performance.now();
      let built = false;
      try {
        built = W.build(W.snapshot, z, { doors: W.doorOpen.slice(), roam: this.game.roam });
      } catch (e) {
        this.note(`rebuild for the spot failed: ${e instanceof Error ? e.message : e}`);
      }
      const buildMs = performance.now() - tb;
      this.buildX = z.x;
      this.buildZ = z.z;
      this.rebuilt = built;
      const d = W.describe();
      if (d !== this.builtLines[1]) this.makeCard();
      if (this.perf) this.perf.mark('world rebuild');
      if (this.rec && this.rec.play) {
        const first = this.rec.play.world;
        this.rec.play.world = { ...this.worldRecord(buildMs), firstBuildMs: first ? first.buildMs : null,
          rebuild: { movedM: Math.round(this.spotMoved * 100) / 100, buildMs: Math.round(buildMs * 10) / 10, atMs: Math.round(t - this.t0), built } };
      }
    }
    this.step = STEP.GO;
  }

  /** @param {number} t */
  startRound(t) {
    const z = this.spotZone;
    this.world.bakeBudgetMs = BAKE_PLAY_MS;
    this.game.start(z || this.world.zone);
    this.startedAtMs = Math.round(t - this.t0);
    if (this.rec && this.rec.play) {
      this.rec.play.step = 'play';
      this.rec.play.startedAtMs = this.startedAtMs;
      this.rec.play.spot = { mode: this.game.roam ? 'roam' : 'spot', movedM: Math.round(this.spotMoved * 100) / 100, rebuilt: this.rebuilt,
        r: z ? z.r : this.world.zone.r, bakeDone: this.world.bakeDone };
    }
    this.step = STEP.PLAY;
  }

  // ── reference-space resets, drift, realign ─────────────────────────────

  /**
   * App's lifecycle: the reference space was reset (recentred, relocalised).
   * Before the round: capture again, silently. During the round: pause, hold,
   * enemies back in the queue, then the REALIGN step rebuilds the world moved
   * by the event's transform (or from a fresh capture without one).
   * @param {{ transform?: any }|null} [e] the XRReferenceSpaceEvent (or a copy)
   */
  onReferenceReset(e) {
    const tr = e && e.transform ? e.transform : null;
    const m = tr ? resetTransform(tr) : null;
    const t = this.t0 >= 0 ? Math.round(performance.now() - this.t0) : 0;
    if (this.resets.length < 20) {
      const p = tr && tr.position, yaw = m ? Math.round((yawOf(m) * 1800) / Math.PI) / 10 : null;
      this.resets.push({ step: this.stepName, hasTransform: !!tr, x: p ? r3(p.x) : null, y: p ? r3(p.y) : null, z: p ? r3(p.z) : null, yawDeg: yaw });
    }
    switch (this.step) {
      case STEP.IDLE: return;
      case STEP.CAPTURE: case STEP.WARM: case STEP.START: case STEP.SPOT: case STEP.REBUILD: case STEP.GO:
        // before the round: read the room again in the new space (the card goes back up)
        if (this.game.spotting || this.game.phase !== PHASE.IDLE) this.game.stop();
        this.gate.reset();
        this.snapshot = null;
        this.cardAt = -1;
        this.spotZone = null;
        this.t0 = -1;
        this.step = STEP.CAPTURE;
        if (this.rec && this.rec.play) this.rec.play.step = 'capture';
        return;
      default: break;
    }
    // during the round (PLAY, or already realigning)
    this.game.onReferenceReset({ hold: true });
    if (!this.game.roam) this.game.requeueEnemies(); // Roam does this itself
    this.queueRealign('reset', m);
  }

  /**
   * Queue a realign: compose with one still pending (both with a transform), else a fresh capture.
   * @param {'reset'|'drift'} cause @param {ArrayLike<number>|null} m old → new
   */
  queueRealign(cause, m) {
    const pending = this.step === STEP.REALIGN;
    if (m && pending && this.realignHasM) {
      mul4(m, this.realignM, this._mTmp);
      this.realignM.set(this._mTmp);
    } else if (m && !pending) {
      this.realignM.set(m);
      this.realignHasM = true;
    } else this.realignHasM = false;
    if (!pending) this.realignCause = cause;
    else if (this.realignCause !== cause) this.realignCause = 'reset+drift';
    this.realignAt = performance.now();
    if (!this.realignHasM) this.gate.reset();
    this.step = STEP.REALIGN;
    if (this.perf) this.perf.mark(`realign ${cause}`);
  }

  /**
   * Once a second in play (not paused): are the Space Setup planes where they
   * were at capture? Drift over 0.10 m or 2° twice in a row realigns.
   * @param {number} t @param {XRFrame} frame
   */
  driftStep(t, frame) {
    if (!this.refPlanes.length || !frame || this.game.paused) return;
    const s = t / 1000;
    if (!this.drift.due(s)) return;
    if (!this.drift.check(frame, this.ctx.space, this.refPlanes, s)) return;
    this.game.beginRealign();
    this.queueRealign('drift', this.drift.correction);
  }

  /**
   * Behind the held pause: rebuild the world in the new coordinates (allocates;
   * the build may take longer than 2 ms: it runs while paused, like the spot rebuild).
   * @param {number} t @param {XRFrame} frame
   */
  realignStep(t, frame) {
    /** @type {SpaceSnapshot|null} */ let fresh = null;
    if (!this.realignHasM) {
      const ready = this.fixture ? true : this.gate.update(frame, t) || this.gate.done;
      if (!ready) return;
      fresh = this.takeSnapshot(frame);
      if (!fresh && !this.fixture) { this.note('realign: no snapshot; the world keeps its old coordinates'); }
    }
    const W = this.world;
    const before = W.snapshot ? W.snapshot.planes.length : 0;
    const tb = performance.now();
    try {
      if (this.realignHasM) W.realign(this.realignM);
      else if (fresh) W.realign(null, fresh);
    } catch (e) {
      this.note(`realign failed: ${e instanceof Error ? e.message : e}`);
    }
    this.realignBuildMs = performance.now() - tb;
    // the drift watch's reference follows the world
    if (this.realignCause === 'drift' && this.realignHasM) this.drift.rebase();
    else if (this.realignHasM) { if (this.refIdx.length) this.drift.setReference(W.snapshot, this.refIdx); }
    else if (fresh) this.setDriftReference(fresh, !this.fixture);
    if (W.snapshot) this.snapshot = W.snapshot;
    this.realignPlanes = before;
    this.step = STEP.REWARM;
  }

  /** One warm draw for the rewritten occluder, then the hold is released. @param {number} t */
  rewarm(t) {
    this.warmInXR();
    const g = this.game;
    /** @type {{ x: number, z: number }|undefined} */ let zone;
    if (!g.roam && this.realignHasM) {
      const z = this._zoneTmp;
      z.x = g.zone.x; z.z = g.zone.z;
      zone = transformPointXZ(this.realignM, z);
    }
    g.realigned(zone);
    if (this.realigns.length < 20) {
      const M = this.realignM;
      this.realigns.push({ t: this.t0 >= 0 ? Math.round(t - this.t0) : 0, cause: this.realignCause, transform: this.realignHasM,
        dx: this.realignHasM ? r3(M[12]) : null, dz: this.realignHasM ? r3(M[14]) : null,
        dyawDeg: this.realignHasM ? Math.round((yawOf(M) * 1800) / Math.PI) / 10 : null,
        planesBefore: this.realignPlanes, planesAfter: this.world.snapshot ? this.world.snapshot.planes.length : 0,
        buildMs: Math.round(this.realignBuildMs * 10) / 10, waitMs: Math.round(performance.now() - this.realignAt) });
    }
    this.realignHasM = false;
    if (this.perf) this.perf.mark('realigned');
    this.step = STEP.PLAY;
  }

  // ── the watch ───────────────────────────────────────────────────────────

  /**
   * The watch's actions (inside the frame, in the 'ui' step): game calls,
   * live gun fit; storage writes go to a setTimeout.
   * @param {string} name @param {any} [v]
   */
  onWatch(name, v) {
    const g = this.game, W = this.weapons;
    if (name in this.watchActions) this.watchActions[name]++;
    switch (name) {
      case 'menu': if (v) g.openMenu(); else g.closeMenu(); break; // closing resumes through the 3-2-1
      case 'resume': g.closeMenu(); break;
      case 'restart': g.restart(); break;
      case 'exit': g.requestExit('watch'); break;
      case 'difficulty':
        // the enemy preset (damage to the player, aim, reaction); GameSession's own multiplier stays ×1 (no double scaling)
        this.settings.difficulty = v === 'realistic' ? 'realistic' : 'test';
        this.enemies.setDifficulty(this.settings.difficulty);
        this.saveSettings();
        break;
      case 'ammoLine':
        this.settings.ammoLine = !!v;
        this.saveSettings();
        break;
      case 'mode': this.modeWanted = v === 'spot' ? 0 : 1; break;
      case 'fitBegin': W.fitHold(v === 'akm' ? 'akm' : 'glock'); break;
      case 'fit': if (v && v.weapon) this.applyFit(v); break;
      case 'fitSave':
        if (v && v.weapon) { this.applyFit(v); this._fitSaveMask |= v.weapon === 'akm' ? 2 : 1; this.saveFits(); }
        break;
      case 'fitEnd':
        if (v && v.weapon) {
          const a = (v.weapon === 'akm' ? W.akm : W.glock).fitAdj;
          if (a.pitch !== v.pitchDeg || a.up !== v.up || a.fwd !== v.fwd) this.applyFit(v);
        }
        W.fitHold(null);
        break;
      default: break;
    }
  }

  /** @param {{ weapon: string, pitchDeg: number, up: number, fwd: number }} v */
  applyFit(v) {
    const a = this._fitAdj;
    a.pitch = +v.pitchDeg || 0;
    a.up = +v.up || 0;
    a.fwd = +v.fwd || 0;
    this.weapons.setFit(v.weapon === 'akm' ? 'akm' : 'glock', a, 'edit');
  }

  /** Write the fits after this frame (never from the frame loop). */
  saveFits() { setTimeout(this._saveFitsNow, 0); }

  writeFits() {
    const mask = this._fitSaveMask;
    if (!mask) return;
    this._fitSaveMask = 0;
    let ok = true;
    try { if (this.storage) this.storage.setItem(FIT_KEY, this.weapons.fitsJSON()); else ok = false; } catch (e) { ok = false; this.storageError(`fit: ${e}`); }
    for (const id of /** @type {const} */ (['glock', 'akm'])) {
      if (!(mask & (id === 'akm' ? 2 : 1)) || this.fitSaves.length >= 40) continue;
      const f = this.weapons.getFit(id);
      this.fitSaves.push({ weapon: id, pitch: f.pitch, up: f.up, fwd: f.fwd, saved: ok, atMs: this.t0 >= 0 ? Math.round(performance.now() - this.t0) : 0 });
    }
  }

  saveSettings() {
    if (this._settingsQueued) return;
    this._settingsQueued = true;
    setTimeout(this._saveSettingsNow, 0);
  }

  writeSettings() {
    this._settingsQueued = false;
    try { if (this.storage) this.storage.setItem(SETTINGS_KEY, serializeSettings(this.settings)); } catch (e) { this.storageError(`settings: ${e}`); }
  }

  /** @param {string} msg */
  storageError(msg) { if (this.storageErrors.length < 10) this.storageErrors.push(msg); }

  /**
   * The watch's MODE row: rebuild the world in the other mode and start over
   * at the card (the game is paused while the menu is open). Inside the world step.
   * @param {number} t
   */
  switchMode(t) {
    const roam = this.modeWanted === 1;
    this.modeWanted = -1;
    const g = this.game;
    if (roam === g.roam) return;
    const pre = this.step === STEP.IDLE || this.step === STEP.CAPTURE;
    if (this.watch.menuOpen) this.watch.closeMenu('mode');
    if (!pre) {
      if (g.spotting || g.phase !== PHASE.IDLE) g.stop();
      this.enemies.reset();
    }
    g.setRoam(roam);
    this.watch.setStatus({ playMode: roam ? 'roam' : 'spot' });
    if (this.modeSwitches.length < 10) this.modeSwitches.push({ to: roam ? 'roam' : 'spot', fromStep: this.stepName, atMs: this.t0 >= 0 ? Math.round(t - this.t0) : 0 });
    if (pre) return; // the capture builds in the new mode
    const W = this.world, p = this.player;
    const tb = performance.now();
    try {
      W.build(W.snapshot, { x: p.head.x, z: p.head.z, r: g.rules.zoneR }, { doors: W.doorOpen.slice(), roam });
    } catch (e) {
      this.note(`mode rebuild failed: ${e instanceof Error ? e.message : e}`);
    }
    const buildMs = performance.now() - tb;
    W.bakeBudgetMs = BAKE_CARD_MS;
    this.buildX = p.head.x;
    this.buildZ = p.head.z;
    this.makeCard();
    this.cardAt = -1;
    this.spotZone = null;
    this.spotMoved = 0;
    this.rebuilt = false;
    if (this.rec && this.rec.play) { this.rec.play.mode = roam ? 'roam' : 'spot'; this.rec.play.step = 'warm'; this.rec.play.world = this.worldRecord(buildMs); }
    this.step = STEP.WARM;
  }

  /**
   * The systems for the Loop, in the contract order ('input' and 'render' are App's / Loop's).
   * GameSession decides pauses and enemy freezes in `preUpdate`, right after the player and
   * before weapons and enemies run; frozen enemies are stepped with dt = 0.
   */
  systems() {
    const c = this.ctx, game = /** @type {any} */ (this.game), W = this.weapons, watch = this.watch, P = this.player;
    const pre = typeof game.preUpdate === 'function';
    return [
      { name: 'world', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.worldUpdate(dt, t, f, c) },
      { name: 'player', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => {
        P.seatedOverride = W.body.seated; // the BodyEstimator's decision (last frame's): one answer for everyone
        P.update(dt, t, f, c);
        if (pre) game.preUpdate(dt, t, f, c);
      } },
      { name: 'weapons', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => {
        // the watch has the trigger while the right hand points at it or its menu is open (last frame's state)
        W.triggerBlocked = watch.capture || watch.menuOpen;
        W.update(dt, t, f, c);
      } },
      { name: 'enemies', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.enemies.update(game.freezeEnemies ? 0 : dt, t, f, c) },
      { name: 'game', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => this.game.update(dt, t, f, c) },
      { name: 'audio', update: (/** @type {number} */ dt, /** @type {number} */ t, /** @type {XRFrame} */ f) => { if (this.audio) this.audio.update(dt, t, f, c); } },
    ];
  }

  /** The 'ui' system's part of the game: the watch. @param {number} dt @param {number} t @param {XRFrame} f @param {any} c */
  uiUpdate(dt, t, f, c) { this.watch.update(dt, t, f, c); }

  /** @param {string} state XRSession.visibilityState */
  setVisibility(state) { this.game.setVisibility(state); }

  /** Session over: everything idle and hidden, a summary into the record. */
  end() {
    const rec = this.rec;
    if (this.watch.menuOpen) this.watch.closeMenu('end');
    this.weapons.fitHold(null);
    if (rec) {
      const g = this.game, w = this.weapons, e = this.enemies;
      const world = rec.play && rec.play.world;
      if (world && this.world.built) world.report = worldReport(this.world); // again: with the spawn tiers used
      /** @type {any} */ let safety = null;
      try { safety = g.safetyReport(); } catch (err) { safety = { error: String(err) }; } // before stop(), which clears the counts
      /** @type {any} */ let roam = null;
      try {
        const wr = this.world.built ? worldReport(this.world) : null;
        roam = { ...g.roamReport(), mode: g.roam ? 'roam' : 'spot', space: this.spaceName, spaceNote: this.spaceNote,
          drift: this.drift.report(), resets: this.resets.slice(), realigns: this.realigns.slice(), modeSwitches: this.modeSwitches.slice(),
          world: wr && wr.roam ? wr.roam : null, nav: wr && wr.nav ? wr.nav : null, bakeDone: this.world.bakeDone };
      } catch (err) { roam = { error: String(err) }; }
      /** @type {any} */ let grip = null;
      try { grip = w.fitReport(); } catch (err) { grip = { error: String(err) }; }
      rec.play = {
        ...(rec.play || {}), step: this.stepName, phase: g.phaseName, wave: g.wave, kills: g.kills, health: g.health,
        game: { ...g.stats }, weapons: { ...w.stats }, enemies: { ...e.stats }, hudDraws: this.watch.draws, messageUploads: g.panel.uploads,
        safety, roam, grip, gripUrl: this.gripUrl, fitSaves: this.fitSaves.slice(), watch: { ...this.watch.report(), actions: { ...this.watchActions } },
        settings: { ...this.settings, gloves: this.gloves }, storageErrors: this.storageErrors.length ? this.storageErrors.slice() : undefined,
        lighting: this.lighting ? { ...this.lighting, envMap: !!this.envTexture } : null,
      };
    }
    this.game.stop();
    this.enemies.reset();
    this.weapons.reset();
    this.weapons.triggerBlocked = false;
    this.watch.enabled = false;
    this.watch.root.visible = false;
    this.watch.menuRoot.visible = false;
    this.step = STEP.IDLE;
    this.ctx.session = null;
    this.ctx.space = null;
    this.refPlanes = [];
    this._keep.length = 0;
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
   * then) and while realigning (GameSession's "View recentred" message).
   * Cached arrays: no allocation per frame.
   */
  panelLines() {
    if (this.game.spotting) return null;
    switch (this.step) {
      case STEP.CAPTURE: return CAPTURE_LINES;
      case STEP.WARM: case STEP.START: case STEP.REBUILD: return this.builtLines;
      case STEP.GO: return this.rebuilt ? this.builtLines : null;
      default: return null; // IDLE, SPOT (game.spotting), PLAY, REALIGN, REWARM
    }
  }

  /** True once the round runs (GameSession shows its own messages). */
  get playing() { return (this.step === STEP.PLAY || this.step === STEP.REALIGN || this.step === STEP.REWARM) && this.game.phase !== PHASE.IDLE; }
}

/**
 * One localStorage read at load (null on any error).
 * @param {Storage|null} storage @param {string} key
 */
function readKey(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
