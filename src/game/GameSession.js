// @ts-check
import * as THREE from 'three';
import { CanvasPanel } from '../ui/CanvasPanel.js';
import { MSG, PAUSE, PHASE, PHASE_NAME, RULES, SurvivalRules } from './Rules.js';
import { claimUpload } from './UploadGate.js';
import { PAUSE_NAMES, SAFETY, VIOLATION, VIOLATION_NAMES, pauseName } from '../safety/PauseManager.js';
import { OBSTACLE, ObstacleWarnings, POINT } from '../safety/ObstacleWarnings.js';
import { SPOT_STATUS, SPOT_STATUS_NAMES, STEP_LINES, SafeSpot } from '../safety/SafeSpot.js';
import { ARROW_COL, SafetyView } from '../safety/SafetyView.js';

/**
 * Survival game session (CONTRACTS.md "Game, audio, HUD"): the `game` system.
 *
 *   const game = new GameSession(ctx, { enemies, weapons });   // at load, before the warm-up
 *   // warm-up: game.warmMeshes() are drawn once (game.setWarm(true) … game.setWarm(false))
 *   game.pickSpot((zone) => { … world.build(snapshot, zone) if it moved …; game.start(zone); });
 *   //   (or game.start(zone) directly: no spot check)
 *   // each frame: game.preUpdate(dt, t, frame, ctx) right after player.update (pause and
 *   //   freeze decisions before weapons and enemies run), then
 *   //   enemies.update(game.freezeEnemies ? 0 : dt, …), and after enemies game.update(dt, t, frame, ctx)
 *   //   (update() runs preUpdate itself when it was not called this frame)
 *   game.onExit = (reason) => setTimeout(() => session.end(), 0);   // optional; this is the default
 *
 * Rules live in the pure `SurvivalRules` (Rules.js). This class wires them to
 * the world, the enemy manager, events, audio and haptics, and owns three
 * meshes created at construction (so the warm-up compiles them and nothing is
 * created later):
 * - the safe-zone floor ring (one mesh; amber near the edge, red pulsing
 *   outside, green while resuming);
 * - the damage tint: ONE full-view quad 15 cm ahead of the eyes (beyond the
 *   10 cm depth-sensing near plane), always `transparent`, opacity ≤ 0.3 for
 *   ≤ 0.3 s, stronger at the edges (PLAN §5: never cover the view);
 * - the floating message panel (CanvasPanel, tag-along).
 *
 * Safety (src/safety/, gap audit S1–S8):
 * - every pause goes through the rules' PauseManager (`rules.pm`): the zone,
 *   visibility, a frame gap > 250 ms, tracking (viewer pose null or
 *   `emulatedPosition`), no controller for 0.25 s, a controller removed, head
 *   speed > 1.2 m/s, B+Y (or `pauseNow()` from the wrist), a reference-space
 *   reset. Resume: 0.5 s within 0.7 r, tracking fine 0.4 s, a trigger pull,
 *   3-2-1. While paused (not counting down) enemies and effects are hidden
 *   (the SafetyView veil), the tint is off and the panel only shows while
 *   the head is still; a floor arrow points back to the spot;
 * - ObstacleWarnings: a hand within 0.25 m or the head within 0.4 m of a
 *   mapped box → haptic 0.3 / 30 ms, an outline of that box or wall patch,
 *   and enemies freeze (`freezeEnemies`), as they do beyond 0.9 r;
 * - SafeSpot (`pickSpot`): before the round, the ring follows the head
 *   (green clear, amber tight, red blocked) with a floor arrow and "Step back
 *   0.6 m" on the panel until the spot is confirmed with the trigger.
 *
 * Pauses (rules.paused) stop the wave clocks and ignore damage; the `pause`
 * event tells the other systems. Allocation-free per frame; message lines
 * are prebuilt (the round-over line is built once per death).
 */

const SPAWN_MIN_M = 3.5;
const GAP_PAUSE_MS = SAFETY.gapMs;
const TINT_S = 0.3;
const TINT_MAX = 0.3;
const TINT_DIST = 0.15;
const RING_IN = 0.025;
const RING_OUT = 0.015;
const COL_AMBER = 0xffb02e;
const COL_RED = 0xff3b30;
const COL_GREEN = 0x4cd964;
const COL_WHITE = 0xffffff;
/** Spot ring colour by SPOT_STATUS. */
const SPOT_COL = [COL_WHITE, COL_GREEN, COL_AMBER, COL_RED, COL_RED, COL_WHITE];
/** Spot messages change at most this often while walking (s). */
const SPOT_MSG_S = 0.25;

/** @type {string[][]} */ const WAVE_LINES = [];
/** @type {string[][]} */ const CLEAR_LINES = [];
for (let n = 0; n < 100; n++) {
  WAVE_LINES.push([`Wave ${n}`]);
  CLEAR_LINES.push([`Wave ${n} cleared`, `+${RULES.breakHeal} health`]);
}
const COUNT_LINES = [['Go'], ['1'], ['2'], ['3']];
const LINES = {
  ready: ['Get ready', 'Stay inside the ring on the floor'],
  zone: ['Return to your spot', 'Paused: step back inside the ring'],
  paused: ['Paused'],
  hold: ['Hold still'],
  exiting: ['Exiting…', 'Keep holding Y'],
  centre: ['Step to the middle of the ring'],
  tracking: ['Tracking lost', 'Stand still and look around slowly'],
  controller: ['Controllers not found', 'Pick up both controllers'],
  reset: ['View recentred', 'Re-reading your room…'],
};
/** Second line of "Pull the trigger to resume", by the cause's bit index (PAUSE_NAMES order). */
const CAUSE_LINES = ['You left your spot', 'The view was hidden', 'The game stalled', 'Tracking was lost',
  'Controllers were lost', 'A controller disconnected', 'No running: stay on your spot', 'You paused the game', 'The view was recentred'];
const RESUME_LINES = CAUSE_LINES.map((c) => ['Pull the trigger to resume', c]);
const SPOT_LINES = {
  clear: ['Good spot', 'Pull the trigger to start'],
  clearSmall: ['Good spot (small space: smaller ring)', 'Pull the trigger to start'],
  tight: ['Something is within arm’s reach', 'Hold the trigger to play here anyway'],
  blocked: ['Too close to a wall or furniture', 'Move to a more open spot'],
  offmap: ['You are outside the mapped room', 'Walk back into it'],
  unmapped: ['No room map here', 'Check the space around you, then pull the trigger'],
};
/** Second line under "Step … m", by SPOT_STATUS. */
const SPOT_REASON = ['', '', 'Something is within arm’s reach', 'Too close to a wall or furniture', 'You are outside the mapped room', ''];

/**
 * @typedef {Object} GameCtx
 * @property {THREE.Scene} scene
 * @property {any} camera
 * @property {XRSession|null} [session]
 * @property {XRReferenceSpace|null} [space]  for the tracking check (viewer pose / emulatedPosition)
 * @property {import('../xr/Input.js').Input} [input]
 * @property {import('../core/Events.js').Events} events
 * @property {import('../audio/AudioEngine.js').AudioEngine} [audio]
 * @property {any} [world]  World: findSpawn, floorY, nav (clearance), shapes (boxes)
 * @property {import('./Player.js').Player} player
 */

export class GameSession {
  /**
   * @param {GameCtx} ctx
   * @param {{ enemies?: { spawn: (x: number, z: number, facing: number) => number, alive: () => number, reset: () => void, warmMeshes?: () => THREE.Object3D[] } | null,
   *   weapons?: { ammo?: () => any, reset?: () => void, worldRoot?: THREE.Object3D } | null, seed?: number, ringMode?: 'edge'|'always',
   *   hideThreats?: boolean, hide?: THREE.Object3D[], gapMs?: number }} [o]
   *   hideThreats (default true): re-parent `enemies.warmMeshes()` and `weapons.worldRoot` (brass, dropped
   *   magazines, decals) under the safety veil, so a pause hides them; `hide`: more objects to hide.
   *   gapMs: a frame gap longer than this pauses (default 250 ms, PLAN Phase 2; the desktop emulator's
   *   software-rendered frames take 100–300 ms, so ?emulate should raise it, e.g. 1500).
   */
  constructor(ctx, { enemies = null, weapons = null, seed, ringMode = 'edge', hideThreats = true, hide = [], gapMs = GAP_PAUSE_MS } = {}) {
    this.ctx = ctx;
    this.enemies = enemies;
    this.weapons = weapons;
    this.ringMode = ringMode;
    /** @type {((reason: string) => void) | null} */ this.onExit = null;
    this.exiting = false;
    this.exitReason = '';
    this.hiddenFlag = false;
    this.lastT = -1;
    /** A frame gap longer than this (ms) pauses the round. */
    this.gapMs = gapMs;
    /** Safe zone (also mirrored into ctx.player.zone at start). */
    /** @type {{ x: number, z: number, r: number }} */
    this.zone = { x: 0, z: 0, r: RULES.zoneR };
    this.stats = { hits: 0, damage: 0, spawnFails: 0, pauses: 0, violations: 0, obstacleWarnings: 0 };
    this._spawnAt = { x: 0, z: 0 };
    // safety
    this.obstacles = new ObstacleWarnings();
    this.spot = new SafeSpot({ r: RULES.zoneR });
    this.view = new SafetyView();
    /** Choosing the spot (before a round): the rules are idle. */
    this.spotting = false;
    /** @type {((zone: { x: number, z: number, r: number, facing: number }) => void) | null} */ this._onSpot = null;
    /** @type {{ x: number, z: number, r: number, facing: number }} */
    this._spotZone = { x: 0, z: 0, r: RULES.zoneR, facing: 0 };
    /** How the zone of this round was judged (built once per start). @type {any} */ this.spotReport = null;
    /** @type {string[]} */ this._spotLines = ['', ''];
    this._spotKey = -1;
    this._spotMsgT = 0;
    this._preT = Number.NaN;
    this._byWas = false;
    this._dist = 0;
    /** @type {any} */ this._world = null;
    this._floorY = (/** @type {number} */ x, /** @type {number} */ z) => {
      const w = this._world;
      const y = w && typeof w.floorY === 'function' ? w.floorY(x, z) : 0;
      return Number.isFinite(y) ? y : 0;
    };

    const host = {
      spawn: () => this._spawn(),
      alive: () => (this.enemies ? this.enemies.alive() : 0),
      waveStart: (/** @type {number} */ w, /** @type {number} */ n) => this._waveStart(w, n),
      waveClear: (/** @type {number} */ w) => this._waveClear(w),
      roundOver: (/** @type {number} */ w, /** @type {number} */ k) => this._roundOver(w, k),
      pause: (/** @type {boolean} */ p, /** @type {number} */ r) => this._pause(p, r),
      health: (/** @type {number} */ h) => this._health(h),
      restart: () => this._restart(),
      exit: (/** @type {string} */ r) => this.requestExit(r),
    };
    this.rules = new SurvivalRules(host, { seed });

    // event payloads (reused)
    this._pWave = { wave: 0, enemies: 0 };
    this._pClear = { wave: 0 };
    this._pOver = { wave: 0, kills: 0 };
    this._pPause = { paused: false, reason: '' };

    // ── meshes, all created now ──
    const ringMat = new THREE.MeshBasicMaterial({ color: COL_AMBER, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    ringMat.name = 'game-zone-ring';
    const ringGeo = new THREE.RingGeometry(RULES.zoneR - RING_IN, RULES.zoneR + RING_OUT, 128, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.name = 'game-zone-ring';
    this.ring.renderOrder = 5;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this._ringCol = COL_AMBER;

    this.tintTex = radialAlpha(64);
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0xb00000, transparent: true, opacity: 0, alphaMap: this.tintTex,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    tintMat.name = 'game-damage-tint';
    this.tint = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), tintMat);
    this.tint.name = 'game-damage-tint';
    this.tint.renderOrder = 60;
    this.tint.frustumCulled = false;
    this.tint.visible = false;
    this._tintT = 0;
    this._tintPeak = 0;

    this.panel = new CanvasPanel({ width: 512, height: 128, worldWidth: 0.42 });
    this.panel.mesh.name = 'game-message';
    this.panel.mesh.visible = false;
    // hidden while the head moves (walking back to the spot): never cover the view while moving (S8)
    this.panel.autoHide = true;
    this.panel.shown = false;
    this._msgKey = -1;
    /** @type {string[]} */ this._overLines = ['Round over — Y to restart'];
    this._view = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

    if (ctx.scene) {
      ctx.scene.add(this.ring, this.tint, this.panel.mesh);
      this.view.addTo(ctx.scene);
      if (hideThreats) {
        if (enemies && typeof enemies.warmMeshes === 'function') this.view.adopt(enemies.warmMeshes());
        if (weapons && weapons.worldRoot) this.view.adopt([weapons.worldRoot]);
      }
      if (hide && hide.length) this.view.adopt(hide);
    }

    this._onPlayerHit = this._onPlayerHit.bind(this);
    this._onEnemyKilled = this._onEnemyKilled.bind(this);
    this._onEnemyShot = this._onEnemyShot.bind(this);
    this._endSession = this._endSession.bind(this);
    /** @type {(() => void)[]} */
    this._unsub = ctx.events ? [ctx.events.on('playerHit', this._onPlayerHit), ctx.events.on('enemyKilled', this._onEnemyKilled),
      ctx.events.on('enemyShot', this._onEnemyShot)] : [];
  }

  get phase() { return this.rules.phase; }
  get phaseName() { return this.spotting ? 'spot' : PHASE_NAME[this.rules.phase]; }
  get paused() { return this.rules.paused; }
  /** Step the enemy system with dt = 0 while true (paused, beyond 0.9 r, an obstacle near). */
  get freezeEnemies() { return this.rules.freeze; }
  /** Enemies and effects hidden (paused, not counting down). */
  get threatsHidden() { return this.rules.phase !== PHASE.IDLE && this.rules.hidden; }
  /** The spot status name while choosing ('clear', 'tight', 'blocked', 'offmap', 'unmapped'). */
  get spotStatus() { return SPOT_STATUS_NAMES[this.spot.status]; }
  get wave() { return this.rules.wave; }
  get kills() { return this.rules.kills; }
  get health() { return this.rules.health; }

  /** Meshes for the warm-up draw (compiled and drawn once before XR): ring, tint, panel, outline, arrow. */
  warmMeshes() { return [this.ring, this.tint, this.panel.mesh, ...this.view.warmMeshes()]; }

  /** Textures for `renderer.initTexture`. */
  textures() { return [this.tintTex, this.panel.texture]; }

  /**
   * Show every mesh for the warm-up draw, then hide them again. Opacity and
   * visibility are not part of the program key; `transparent` never changes.
   * @param {boolean} on
   */
  setWarm(on) {
    this.ring.visible = on;
    this.tint.visible = on;
    this.panel.mesh.visible = on;
    if (on) {
      const cam = this.ctx.camera;
      if (cam) {
        // in front of the warm-up camera, so the draw really happens
        this.tint.position.copy(cam.position);
        this.tint.quaternion.copy(cam.quaternion);
        this.tint.translateZ(-TINT_DIST);
        this.panel.mesh.position.copy(cam.position);
        this.panel.mesh.quaternion.copy(cam.quaternion);
        this.panel.mesh.translateZ(-0.8);
      }
    } else {
      this._msgKey = -1;
      this.panel.placed = false;
    }
    this.view.setWarm(on, this.ctx.camera);
  }

  /**
   * Start a round. The safe zone is centred where the head is now (or `zone`).
   * @param {{ x: number, z: number, r?: number }} [zone]
   */
  start(zone) {
    const p = this.ctx.player;
    const r = zone && zone.r && zone.r > 0 ? zone.r : RULES.zoneR;
    const x = zone ? zone.x : p && p.valid !== false ? p.head.x : 0;
    const z = zone ? zone.z : p && p.valid !== false ? p.head.z : 0;
    this.zone.x = Number.isFinite(x) ? x : 0;
    this.zone.z = Number.isFinite(z) ? z : 0;
    this.zone.r = r;
    if (p) { p.zone.x = this.zone.x; p.zone.z = this.zone.z; p.zone.r = r; }
    const k = r / RULES.zoneR;
    this.ring.scale.set(k, 1, k);
    this.rules.zoneR = r;
    this.exiting = false;
    this.exitReason = '';
    this.lastT = -1;
    this._msgKey = -1;
    this.spotting = false;
    this.spot.stop();
    this.rules.setup = false;
    this.obstacles.reset();
    this.view.reset();
    this.panel.restart();
    this.panel.shown = false;
    // how good is this spot? (diagnostics; once per start)
    const st = this.spot.evaluate(this.ctx.world, this.zone.x, this.zone.z, r);
    this.spotReport = {
      status: SPOT_STATUS_NAMES[st], r, x: round2(this.zone.x), z: round2(this.zone.z),
      clearance: round2(this.spot.lastClearance), nearest: round2(this.spot.lastNearest),
      chosen: !!(zone && zone === this._spotZone), facing: zone && zone === this._spotZone ? round2(this._spotZone.facing) : null,
    };
    this.rules.start();
  }

  /**
   * Before a round: the player chooses where to stand (SafeSpot, PLAN §6.2).
   * The ring follows the head, coloured by the spot's status, with a floor
   * arrow and "Step back 0.6 m" while it is not clear; the trigger confirms
   * (hold it 1 s for a spot with something within arm's reach). Then
   * `onConfirm(zone)` runs (the integrator rebuilds the world around the zone
   * if it moved, then calls `game.start(zone)`), or without a callback the
   * round starts at once. Holding Y exits as in play.
   * @param {((zone: { x: number, z: number, r: number, facing: number }) => void) | null} [onConfirm]
   * @param {number} [r] zone radius (0.5–0.8 m; shrinks by itself in a cramped room, not below 0.5)
   */
  pickSpot(onConfirm = null, r = RULES.zoneR) {
    this.rules.stop();
    this.spotting = true;
    this._onSpot = onConfirm;
    this.spot.begin(r);
    this.rules.setup = true;
    this.exiting = false;
    this.exitReason = '';
    this.lastT = -1;
    this._msgKey = -1;
    this._spotKey = -1;
    this._spotMsgT = 0;
    this.obstacles.reset();
    this.view.reset();
    this.panel.restart();
    this.panel.shown = false;
  }

  /** Pause now (the wrist button; B+Y does the same). @param {string} [_reason] */
  pauseNow(_reason = 'wrist') { return this.rules.pauseNow(PAUSE.MANUAL); }

  /** End of session: idle, everything hidden, events kept (dispose() drops them). */
  stop() {
    this.rules.stop();
    this.spotting = false;
    this.spot.stop();
    this.rules.setup = false;
    this._onSpot = null;
    this.ring.visible = false;
    this.tint.visible = false;
    this.panel.mesh.visible = false;
    this.panel.shown = false;
    this._tintT = 0;
    this._msgKey = -1;
    this.obstacles.reset();
    this.view.reset();
    this.rules.pm.resetStats();
    this.obstacles.warnings = 0;
  }

  /**
   * Safety summary for the session record (allocates: call at session end,
   * before stop()).
   */
  safetyReport() {
    const pm = this.rules.pm;
    /** @type {Record<string, number>} */ const pauses = {};
    for (let i = 0; i < PAUSE_NAMES.length; i++) if (pm.pauseCounts[i]) pauses[PAUSE_NAMES[i]] = pm.pauseCounts[i];
    /** @type {Record<string, number>} */ const violations = {};
    for (let i = 0; i < VIOLATION_NAMES.length; i++) if (pm.violationCounts[i]) violations[VIOLATION_NAMES[i]] = pm.violationCounts[i];
    const log = [];
    const n = Math.min(pm.logN, pm.logKind.length);
    for (let k = pm.logN - n; k < pm.logN; k++) {
      const i = k % pm.logKind.length;
      log.push({ kind: VIOLATION_NAMES[pm.logKind[i]], t: Math.round(pm.logT[i] * 100) / 100 });
    }
    return {
      pauses, violations, log, obstacleWarnings: this.obstacles.warnings, spot: this.spotReport,
      veil: { adopted: this.view.adopted.length, notes: this.view.notes.slice(0, 10) },
    };
  }

  dispose() {
    this.stop();
    for (let i = 0; i < this._unsub.length; i++) this._unsub[i]();
    this._unsub.length = 0;
  }

  /** From the XR lifecycle (`visibilitychange`). @param {string} state */
  setVisibility(state) { this.hiddenFlag = state !== 'visible'; }

  /**
   * The reference space was reset (recentred): pause, then the normal resume
   * protocol (the trigger pull re-confirms the spot). With `{ hold: true }`
   * the pause also waits for `realigned()` (after the integrator re-captured
   * and rebuilt the world in the new coordinates). While choosing the spot,
   * the search starts over.
   * @param {{ hold?: boolean }} [o]
   */
  onReferenceReset(o) {
    if (this.spotting) { this.spot.restartSweep(); return; }
    this.rules.pauseNow(PAUSE.RESET);
    if (o && o.hold) this.rules.hold(PAUSE.RESET);
  }

  /**
   * The world was realigned after a reset: release the hold (and move the
   * zone, when given, e.g. to the old spot in the new coordinates).
   * @param {{ x: number, z: number, r?: number }} [zone]
   */
  realigned(zone) {
    if (zone && Number.isFinite(zone.x) && Number.isFinite(zone.z)) {
      this.zone.x = zone.x;
      this.zone.z = zone.z;
      const p = this.ctx.player;
      if (p) { p.zone.x = zone.x; p.zone.z = zone.z; }
    }
    this.rules.release(PAUSE.RESET);
  }

  /**
   * Leave the session (wrist menu or holding Y). Calls `onExit` once; by
   * default ends the XR session from a timeout, never inside the frame
   * callback (DEVICE_LOG p1.1).
   * @param {string} reason
   */
  requestExit(reason) {
    if (this.exiting) return;
    this.exiting = true;
    this.exitReason = reason;
    if (this.onExit) this.onExit(reason);
    else if (this.ctx.session) setTimeout(this._endSession, 0);
  }

  _endSession() {
    const s = this.ctx.session;
    if (s) s.end().catch(() => {});
  }

  /**
   * Safety and rules for this frame: every pause reason, obstacle warnings,
   * the spot choice, then the rules (spawns, pause events). Call it right
   * after player.update so the pause / freeze decisions come before the
   * weapons and enemies run; update() calls it when it was not called this
   * frame (same `t`).
   * @param {number} dt @param {number} t
   * @param {XRFrame|null|undefined} frame
   * @param {GameCtx} ctx
   */
  preUpdate(dt, t, frame, ctx) {
    if (t === this._preT) return;
    this._preT = t;
    const R = this.rules, pm = R.pm;
    const p = ctx.player;
    if (this.lastT >= 0 && t - this.lastT > this.gapMs) R.interrupt();
    this.lastT = t;
    const s = ctx.session;
    const vs = s ? s.visibilityState : 'visible';
    const visible = !this.hiddenFlag && (vs === undefined || vs === 'visible');
    pm.setTracking(trackingOk(frame, ctx));
    const inp = ctx.input;
    const L = inp ? inp.left : null, Rh = inp ? inp.right : null;
    pm.setControllers(L ? !!L.present : true, Rh ? !!Rh.present : true);
    const pv = !!p && p.valid !== false;
    let dist = 0;
    if (pv) {
      const dx = p.head.x - this.zone.x, dz = p.head.z - this.zone.z;
      dist = Math.sqrt(dx * dx + dz * dz);
      pm.setHead(p.head.x, p.head.z);
    } else pm.setHead(Number.NaN, Number.NaN);
    this._dist = dist;

    // buttons: Y (exit / restart), B+Y (pause), a trigger pull (resume / confirm the spot)
    const y = L ? !!L.b : false;
    const by = !!(L && Rh && L.b && Rh.b);
    if (by && !this._byWas) R.pauseNow(PAUSE.MANUAL);
    this._byWas = by;
    const trigDown = !!((L && L.triggerDown) || (Rh && Rh.triggerDown));
    const trigHeld = !!((L && L.triggerHeld) || (Rh && Rh.triggerHeld));
    if (trigDown) R.press();

    // mapped walls and furniture near the head or a hand
    const w = ctx.world;
    this._world = w || null;
    const shapes = w && w.built !== false && w.shapes ? w.shapes : null;
    const ob = this.obstacles;
    const live = this.spotting || R.phase !== PHASE.IDLE;
    if (pv) ob.setPoint(POINT.HEAD, p.head.x, p.head.y, p.head.z); else ob.clearPoint(POINT.HEAD);
    ob.setGrip(POINT.LEFT, L && L.hasGrip ? L.grip : null);
    ob.setGrip(POINT.RIGHT, Rh && Rh.hasGrip ? Rh.grip : null);
    ob.update(dt, live ? shapes : null, R.active ? this.zone : null);
    pm.setObstacle(R.active && ob.any, R.active && ob.inside);
    if (live) {
      if (ob.pulseL && L) pulse(L.source, OBSTACLE.pulse, OBSTACLE.pulseMs);
      if (ob.pulseR && Rh) pulse(Rh.source, OBSTACLE.pulse, OBSTACLE.pulseMs);
    }

    R.setup = this.spotting;
    if (this.spotting && pv) this.spotStep(dt, p, w, trigDown, trigHeld);

    R.update(dt, dist, visible, y);
    if (pm.tick) this.tick();
    const st = this.stats;
    st.spawnFails = R.spawnFails;
    st.pauses = pm.pauseCounts[0] + pm.pauseCounts[1] + pm.pauseCounts[2] + pm.pauseCounts[3] + pm.pauseCounts[4]
      + pm.pauseCounts[5] + pm.pauseCounts[6] + pm.pauseCounts[7] + pm.pauseCounts[8];
    st.violations = pm.violationCounts[0] + pm.violationCounts[1] + pm.violationCounts[2] + pm.violationCounts[3];
    st.obstacleWarnings = ob.warnings;
  }

  /**
   * @param {number} dt @param {number} t
   * @param {XRFrame|null|undefined} frame
   * @param {GameCtx} ctx
   */
  update(dt, t, frame, ctx) {
    this.preUpdate(dt, t, frame, ctx);
    const p = ctx.player;
    this.updateRing(t, this._dist, ctx);
    this.updateTint(dt, p);
    this.updateSafety(t, p);
    this.updateMessage(dt, t, p);
  }

  /**
   * @param {number} dt @param {import('./Player.js').Player} p @param {any} w
   * @param {boolean} down @param {boolean} held
   */
  spotStep(dt, p, w, down, held) {
    const f = p.flatForward || p.forward;
    const S = this.spot;
    if (!S.update(dt, w, p.head.x, p.head.z, f.x, f.z, down, held)) return;
    this.spotting = false;
    this.rules.setup = false;
    const z = this._spotZone;
    z.x = S.x; z.z = S.z; z.r = S.r; z.facing = S.facing;
    const cb = this._onSpot;
    this._onSpot = null;
    if (cb) cb(z);
    else this.start(z);
  }

  /** The soft tick when the head crosses 0.8 r. */
  tick() {
    const a = /** @type {any} */ (this.ctx.audio);
    if (a && typeof a.playUI === 'function') a.playUI('dryReset', 0.5);
  }

  // ── visuals ──────────────────────────────────────────────────────────────

  /** @param {number} t @param {number} dist @param {GameCtx} ctx */
  updateRing(t, dist, ctx) {
    const R = this.rules;
    const ring = this.ring;
    const mat = /** @type {THREE.MeshBasicMaterial} */ (ring.material);
    if (this.spotting) {
      // the ring the round would get, under the player, coloured by the spot's status
      const p = ctx.player;
      if (!p || p.valid === false) { ring.visible = false; return; }
      const col = SPOT_COL[this.spot.status] || COL_WHITE;
      if (col !== this._ringCol) { mat.color.setHex(col); this._ringCol = col; }
      mat.opacity = 0.8;
      const k = this.spot.r / RULES.zoneR;
      ring.scale.set(k, 1, k);
      ring.position.set(p.head.x, this._floorY(p.head.x, p.head.z) + 0.005, p.head.z);
      ring.visible = true;
      return;
    }
    if (R.phase === PHASE.IDLE) { ring.visible = false; return; }
    const r = this.zone.r;
    let op, col;
    if (R.paused && (R.reasons & PAUSE.ZONE)) {
      col = COL_RED;
      op = 0.65 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.008));
    } else if (R.paused) {
      col = COL_GREEN;
      op = 0.8;
    } else if (R.pm.zoneLevel >= 2) {
      // beyond 0.9 r: edge highlight (enemies are frozen)
      col = COL_RED;
      op = 0.9;
    } else {
      col = COL_AMBER;
      const k = smoothstep(0.5 * r, 0.95 * r, dist);
      op = this.ringMode === 'always' ? 0.3 + 0.6 * k : 0.85 * k;
      if (R.phase === PHASE.READY && op < 0.6) op = 0.6; // "Stay inside the ring": show where it is
    }
    if (col !== this._ringCol) { mat.color.setHex(col); this._ringCol = col; }
    mat.opacity = op;
    ring.position.set(this.zone.x, this._floorY(this.zone.x, this.zone.z) + 0.005, this.zone.z);
    ring.visible = op > 0.01;
  }

  /**
   * The veil (enemies and effects hidden while paused), the obstacle outline
   * and the floor arrow.
   * @param {number} t @param {import('./Player.js').Player} p
   */
  updateSafety(t, p) {
    const R = this.rules, pm = R.pm, v = this.view;
    v.setHidden(this.threatsHidden);
    const w = this._world;
    v.updateOutline(this.obstacles, w && w.built !== false ? w.shapes : null, this._floorY);
    const pv = !!p && p.valid !== false;
    if (!pv) { v.hideArrow(); return; }
    const hx = p.head.x, hz = p.head.z;
    const fy = this._floorY(hx, hz);
    const slide = 0.06 * ((t * 0.0012) % 1);
    if (this.spotting) {
      const S = this.spot;
      if (!S.hasStep) { v.hideArrow(); return; }
      const dx = S.stepX - hx, dz = S.stepZ - hz, l = Math.sqrt(dx * dx + dz * dz);
      const a = Math.min(0.25, l * 0.4) + slide;
      v.showArrow(hx + (dx / l) * a, fy, hz + (dz / l) * a, dx, dz, ARROW_COL.step, 0.9);
      return;
    }
    const back = R.active && (R.paused ? (R.reasons & PAUSE.ZONE) !== 0 || !pm.innerIn : pm.zoneLevel >= 2);
    if (!back) { v.hideArrow(); return; }
    const dx = this.zone.x - hx, dz = this.zone.z - hz, l = Math.sqrt(dx * dx + dz * dz);
    if (!(l > 0.05)) { v.hideArrow(); return; }
    const a = Math.min(0.3, l * 0.3) + slide;
    const op = 0.65 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.008));
    v.showArrow(hx + (dx / l) * a, fy, hz + (dz / l) * a, dx, dz, ARROW_COL.back, op);
  }

  /** @param {number} dt @param {import('./Player.js').Player} p */
  updateTint(dt, p) {
    const tint = this.tint;
    if (this.threatsHidden) this._tintT = 0; // paused: the view stays clear
    if (this._tintT <= 0 || !p) { tint.visible = false; return; }
    this._tintT -= dt;
    const k = this._tintT > 0 ? this._tintT / TINT_S : 0;
    const op = this._tintPeak * k;
    /** @type {THREE.MeshBasicMaterial} */ (tint.material).opacity = op;
    if (op <= 0.003) { tint.visible = false; return; }
    const e = p.eye || p.head, f = p.forward;
    tint.position.set(e.x + f.x * TINT_DIST, e.y + f.y * TINT_DIST, e.z + f.z * TINT_DIST);
    if (p.quat) tint.quaternion.copy(p.quat);
    tint.visible = true;
  }

  /** @param {number} dt @param {number} t @param {import('./Player.js').Player} p */
  updateMessage(dt, t, p) {
    const R = this.rules;
    const panel = this.panel;
    const spot = this.spotting && R.msg !== MSG.EXITING;
    const key = spot ? this.spotKey(dt) : R.msg * 1000 + R.msgN;
    if (key !== this._msgKey) {
      this._msgKey = key;
      const lines = spot ? this.spotLines() : this.linesFor(R.msg, R.msgN);
      if (lines) {
        panel.setLines(lines);
        if (!panel.shown) { panel.placed = false; panel.shown = true; }
      } else {
        panel.shown = false;
        panel.mesh.visible = false;
        panel.placed = false;
      }
    }
    if (!panel.shown) return;
    // follow() also hides the panel while the head moves (autoHide)
    if (p && p.valid !== false && p.quat) {
      const v = this._view;
      v.position.copy(p.eye || p.head);
      v.quaternion.copy(p.quat);
      panel.follow(/** @type {any} */ (v), dt);
    } else if (this.ctx.camera) panel.follow(this.ctx.camera, dt);
    if (panel.dirty && panel.mesh.visible && claimUpload(t)) panel.flush();
  }

  /**
   * The spot message key; distance changes are rate-limited (walking), status
   * changes are immediate.
   * @param {number} dt
   */
  spotKey(dt) {
    const S = this.spot;
    this._spotMsgT += dt;
    const small = S.r < S.r0 - 1e-6 ? 1 : 0;
    const k = 1e6 + S.status * 1e5 + small * 1e4 + (S.hasStep ? 1e3 + S.sector * 100 + S.bucket : 0);
    if (k !== this._spotKey) {
      const statusChanged = Math.floor(k / 1e4) !== Math.floor(this._spotKey / 1e4) || (k >= 0 && (k % 1e4 >= 1e3) !== (this._spotKey % 1e4 >= 1e3));
      if (this._spotKey < 0 || statusChanged || this._spotMsgT >= SPOT_MSG_S) {
        this._spotKey = k;
        this._spotMsgT = 0;
      }
    }
    return this._spotKey;
  }

  /** Lines for the spot choice (one reused array for "Step … m"). @returns {string[]|null} */
  spotLines() {
    const S = this.spot;
    switch (S.status) {
      case SPOT_STATUS.UNMAPPED: return SPOT_LINES.unmapped;
      case SPOT_STATUS.CLEAR: return S.r < S.r0 - 1e-6 ? SPOT_LINES.clearSmall : SPOT_LINES.clear;
      case SPOT_STATUS.NONE: return null;
      default: break;
    }
    if (S.hasStep) {
      const L = this._spotLines;
      L[0] = STEP_LINES[S.sector][S.bucket];
      L[1] = SPOT_REASON[S.status];
      return L;
    }
    if (S.status === SPOT_STATUS.TIGHT) return SPOT_LINES.tight;
    if (S.status === SPOT_STATUS.OFFMAP) return SPOT_LINES.offmap;
    return SPOT_LINES.blocked;
  }

  /** @param {number} m @param {number} n @returns {string[]|null} */
  linesFor(m, n) {
    switch (m) {
      case MSG.GET_READY: return LINES.ready;
      case MSG.WAVE: return n < WAVE_LINES.length ? WAVE_LINES[n] : [`Wave ${n}`];
      case MSG.CLEARED: return n < CLEAR_LINES.length ? CLEAR_LINES[n] : [`Wave ${n} cleared`];
      case MSG.OVER: return this._overLines;
      case MSG.ZONE: return LINES.zone;
      case MSG.PAUSED: return LINES.paused;
      case MSG.HOLD: return LINES.hold;
      case MSG.COUNT: return COUNT_LINES[n > 3 ? 3 : n < 0 ? 0 : n];
      case MSG.EXITING: return LINES.exiting;
      case MSG.RESUME: return n >= 0 && n < RESUME_LINES.length ? RESUME_LINES[n] : RESUME_LINES[0];
      case MSG.CENTRE: return LINES.centre;
      case MSG.TRACKING: return LINES.tracking;
      case MSG.CONTROLLER: return LINES.controller;
      case MSG.RESET: return LINES.reset;
      default: return null;
    }
  }

  // ── rules host ───────────────────────────────────────────────────────────

  _spawn() {
    const w = this.ctx.world, e = this.enemies, p = this.ctx.player;
    if (!w || !e || !p || typeof w.findSpawn !== 'function') return false;
    const f = p.flatForward || p.forward;
    const o = this._spawnAt;
    if (!w.findSpawn(p.head.x, p.head.z, f.x, f.z, SPAWN_MIN_M, o)) return false;
    // facing as a yaw about +Y, 0 = +Z (the soldier GLB faces +Z): toward the player
    const facing = Math.atan2(p.head.x - o.x, p.head.z - o.z);
    return e.spawn(o.x, o.z, facing) >= 0;
  }

  /** @param {number} w @param {number} n */
  _waveStart(w, n) {
    this._pWave.wave = w;
    this._pWave.enemies = n;
    this.ctx.events.emit('waveStart', this._pWave);
  }

  /** @param {number} w */
  _waveClear(w) {
    this._pClear.wave = w;
    this.ctx.events.emit('waveClear', this._pClear);
  }

  /** @param {number} w @param {number} k */
  _roundOver(w, k) {
    const p = this.ctx.player;
    if (p) { p.health = 0; p.alive = false; }
    // built once per death (not per frame)
    this._overLines = ['Round over — Y to restart', `Wave ${w} · ${k} ${k === 1 ? 'kill' : 'kills'}`];
    this._msgKey = -1;
    this._pOver.wave = w;
    this._pOver.kills = k;
    this.ctx.events.emit('roundOver', this._pOver);
  }

  /** @param {boolean} paused @param {number} reason */
  _pause(paused, reason) {
    this._pPause.paused = paused;
    this._pPause.reason = paused ? pauseName(reason) : '';
    this.ctx.events.emit('pause', this._pPause);
    if (paused) {
      // a buzz on both hands, so a pause is felt even when not looking at the floor
      const inp = this.ctx.input;
      if (inp) { pulse(inp.left.source, 0.5, 60); pulse(inp.right.source, 0.5, 60); }
    }
  }

  /** @param {number} h */
  _health(h) {
    const p = this.ctx.player;
    if (!p) return;
    p.health = h;
    p.alive = h > 0;
  }

  _restart() {
    if (this.enemies) this.enemies.reset();
    if (this.weapons && typeof this.weapons.reset === 'function') this.weapons.reset();
    this._tintT = 0;
    this.tint.visible = false;
    const p = this.ctx.player;
    if (p) { p.health = RULES.maxHealth; p.alive = true; }
  }

  // ── events ───────────────────────────────────────────────────────────────

  /** @param {{ damage: number, fromX: number, fromY: number, fromZ: number }} e */
  _onPlayerHit(e) {
    const d = this.rules.damage(e.damage);
    if (d <= 0) return;
    this.stats.hits++;
    this.stats.damage += d;
    // view tint: ≤ 0.3 opacity, ≤ 0.3 s; a second hit raises it, never stacks past the cap
    const peak = Math.min(TINT_MAX, 0.1 + 0.004 * d);
    this._tintPeak = this._tintT > 0 ? Math.max(peak, this._tintPeak * (this._tintT / TINT_S)) : peak;
    this._tintT = TINT_S;
    const p = this.ctx.player;
    const audio = this.ctx.audio;
    if (p && audio) {
      // the impact on your body, on the side the round came from
      const T = p.torsoTop;
      let dx = e.fromX - T.x, dy = e.fromY - T.y, dz = e.fromZ - T.z;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l > 1e-3) { dx /= l; dy /= l; dz /= l; } else { dx = dy = dz = 0; }
      audio.play('impactFlesh', T.x + dx * 0.18, T.y + dy * 0.18, T.z + dz * 0.18, 0.8 + d * 0.004);
    }
    const inp = this.ctx.input;
    if (inp) {
      const v = Math.min(1, 0.5 + d / 100), ms = Math.min(110, 50 + d);
      pulse(inp.left.source, v, ms);
      pulse(inp.right.source, v, ms);
    }
  }

  /** @param {{ headshot: boolean }} e */
  _onEnemyKilled(e) { this.rules.kill(!!(e && e.headshot)); }

  /** An enemy shot while paused is a safety violation (PLAN §6.2). */
  _onEnemyShot() { if (this.rules.paused) this.rules.pm.violation(VIOLATION.SHOT); }
}

/**
 * Tracking for the pause rule: the viewer pose exists and is not emulated
 * (6DoF lost). Without a frame (tests, desktop warm-up) tracking counts as fine.
 * @param {XRFrame|null|undefined} frame @param {GameCtx} ctx
 */
function trackingOk(frame, ctx) {
  const sp = ctx.space;
  if (!frame || !sp || typeof frame.getViewerPose !== 'function') return true;
  let vp = null;
  try { vp = frame.getViewerPose(sp); } catch { return true; }
  return !!vp && !vp.emulatedPosition;
}

/** @param {number} x */
function round2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; }

/**
 * @param {XRInputSource|null} src @param {number} v @param {number} ms
 */
function pulse(src, v, ms) {
  const gp = src && src.gamepad;
  const h = gp && /** @type {any} */ (gp).hapticActuators;
  const a = h && h.length > 0 ? h[0] : null;
  if (a && typeof a.pulse === 'function') {
    try { a.pulse(v, ms); } catch { /* not supported */ }
  }
}

/** @param {number} a @param {number} b @param {number} x */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Alpha mask for the damage tint: 0.45 in the centre rising to 1 at the edges,
 * so the middle of the view stays clearest. A DataTexture (no canvas, no mips).
 * @param {number} n
 */
function radialAlpha(n) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1, y = ((j + 0.5) / n) * 2 - 1;
      const r = Math.min(1, Math.sqrt(x * x + y * y) / Math.SQRT2 * 1.25);
      const a = 0.45 + 0.55 * smoothstep(0.25, 1, r);
      const k = (j * n + i) * 4;
      const b = Math.round(a * 255);
      data[k] = data[k + 1] = data[k + 2] = data[k + 3] = b;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'game-damage-tint-alpha';
  return tex;
}
