// @ts-check
import { PAUSE, PauseManager, RESUME, SAFETY, VIOLATION, pauseIndex } from '../safety/PauseManager.js';

/**
 * Survival rules (pure: no three.js, no DOM, so Node tests drive it with fakes).
 * CONTRACTS.md "Game, audio, HUD" → GameSession.
 *
 *   idle ─start─▶ ready (Get ready, 3 s) ─▶ wave n ─all down─▶ break (5 s, +25 hp) ─▶ wave n+1 …
 *                                             └──── health 0 ────▶ over ──Y tap──▶ ready
 *
 * - Wave n has 2 + n enemies, at most 4 alive at once, spawned one at a time
 *   (1.5–3.5 s apart, seeded) through `host.spawn()`; a failed spawn retries
 *   after 0.5 s.
 * - Pause is orthogonal to the phase and decided by ONE PauseManager
 *   (src/safety/PauseManager.js, `rules.pm`): the head beyond the safe-zone
 *   radius, the session not visible, tracking lost, no controller, an input
 *   source removed, running, a frame gap, a manual pause (B+Y / wrist), a
 *   reference-space reset. While paused nothing advances and damage is
 *   ignored. Resume (PLAN §6.2): every reason gone, the head within 0.7 r for
 *   0.5 s with tracking fine for 0.4 s, a Resume press (`press()`), then a
 *   3-2-1 countdown; a reason coming back restarts that. The `update`
 *   arguments feed the zone and visibility; GameSession feeds the rest into
 *   `rules.pm` before `update`.
 * - Enemies freeze (`freeze`: no new spawns, the enemy system is stepped with
 *   dt = 0) while paused, beyond 0.9 r, or with a mapped obstacle near.
 * - Y: a short tap (< 0.6 s) on round over restarts; holding 2 s exits, in any
 *   phase, paused or not (and during the spot choice, `setup`).
 *
 * The host gets synchronous callbacks; every hot path is allocation-free.
 */

export const PHASE = Object.freeze({ IDLE: 0, READY: 1, WAVE: 2, BREAK: 3, OVER: 4 });
export const PHASE_NAME = Object.freeze(['idle', 'ready', 'wave', 'break', 'over']);

/** Pause reason bits (re-exported from the PauseManager). */
export { PAUSE };

/** What the floating message panel should show (`rules.msg`, `rules.msgN`). */
export const MSG = Object.freeze({
  NONE: 0,
  GET_READY: 1,
  WAVE: 2, // n = wave
  CLEARED: 3, // n = wave
  OVER: 4,
  ZONE: 5, // "Return to your spot"
  PAUSED: 6, // session blurred / hidden
  HOLD: 7, // back inside, waiting 0.5 s
  COUNT: 8, // n = 3, 2, 1
  EXITING: 9, // holding Y
  RESUME: 10, // "Pull the trigger to resume"; n = bit index of the cause
  CENTRE: 11, // back inside, but not yet within 0.7 r
  TRACKING: 12, // tracking lost
  CONTROLLER: 13, // no controller
  RESET: 14, // view recentred, waiting for the world to be realigned
});

export const RULES = Object.freeze({
  maxHealth: 100,
  readyS: 3,
  breakS: 5,
  breakHeal: 25,
  baseEnemies: 2,
  maxAlive: 4,
  firstSpawnS: 1.0,
  spawnGapMinS: 1.5,
  spawnGapMaxS: 3.5,
  spawnRetryS: 0.5,
  zoneR: 0.8,
  /** Back inside means 3 cm inside the edge, so standing on the line does not flicker. */
  zoneHyst: SAFETY.hyst,
  insideS: SAFETY.insideS,
  countdownS: SAFETY.countdownS,
  exitHoldS: 2,
  restartTapS: 0.6,
  /** Holding Y longer than this shows "keep holding to exit". */
  exitHintS: 0.4,
  waveMsgS: 2,
  clearMsgS: 2.5,
});

/**
 * @typedef {Object} RulesHost
 * @property {() => boolean} spawn                 try to spawn one enemy; true when one was placed
 * @property {() => number} alive                  living enemies right now
 * @property {(wave: number, enemies: number) => void} waveStart
 * @property {(wave: number) => void} waveClear
 * @property {(wave: number, kills: number) => void} roundOver
 * @property {(paused: boolean, reason: number) => void} pause   reason = PAUSE bit that started it (NONE on resume)
 * @property {(health: number, delta: number) => void} health
 * @property {() => void} restart                  reset enemies / weapons for a fresh round
 * @property {(reason: string) => void} exit
 */

export class SurvivalRules {
  /**
   * @param {RulesHost} host
   * @param {{ seed?: number, zoneR?: number, requirePress?: boolean }} [o] requirePress: false skips the Resume press (tools only)
   */
  constructor(host, { seed = 0x9e3779b9, zoneR = RULES.zoneR, requirePress = true } = {}) {
    this.host = host;
    this.seed = seed >>> 0 || 1;
    this.rng = this.seed;
    /** Every pause decision: PauseManager (feed its inputs before update). */
    this.pm = new PauseManager({ zoneR, requirePress });
    /** @type {number} PHASE */ this.phase = PHASE.IDLE;
    /** @type {number} */ this.health = RULES.maxHealth;
    this.wave = 0;
    this.kills = 0;
    this.headshots = 0;
    /** This wave: total, spawned, killed. */
    this.total = 0;
    this.spawned = 0;
    this.killedWave = 0;
    this.spawnT = 0;
    this.spawnFails = 0;
    /** READY / BREAK countdown (s). */
    this.phaseT = 0;
    /** A setup step runs while idle (the spot choice): holding Y exits then too. */
    this.setup = false;
    // Y button
    this.yHeldS = 0;
    this.yWas = false;
    this.exitDone = false;
    // messages: the timed one, and the effective one after pause / exit overrides
    /** @type {number} */ this.timedMsg = MSG.NONE;
    this.timedN = 0;
    this.timedT = 0;
    /** @type {number} MSG */ this.msg = MSG.NONE;
    this.msgN = 0;
  }

  get zoneR() { return this.pm.zoneR; }
  set zoneR(r) { this.pm.zoneR = r; }
  get paused() { return this.pm.paused; }
  /** Level pause reasons right now (PAUSE bits). */
  get reasons() { return this.pm.reasons; }
  /** Enemies frozen (paused, beyond 0.9 r, or an obstacle near). */
  get freeze() { return this.pm.freeze; }
  /** Enemies and effects hidden (paused, not counting down). */
  get hidden() { return this.pm.hidden; }
  get countN() { return this.pm.countN; }
  get countT() { return this.pm.countT; }

  /** A fresh round: full health, wave 0, "Get ready". Also used for restart. */
  start() {
    this.host.restart();
    this.rng = this.seed;
    this.phase = PHASE.READY;
    this.phaseT = RULES.readyS;
    this.health = RULES.maxHealth;
    this.wave = this.kills = this.headshots = 0;
    this.total = this.spawned = this.killedWave = 0;
    this.spawnFails = 0;
    this.exitDone = false;
    this.yHeldS = 0;
    this.clearPause();
    this.show(MSG.GET_READY, 0, RULES.readyS);
    this.host.health(this.health, 0);
    this.refreshMsg();
  }

  /** Back to idle (session over). */
  stop() {
    this.clearPause();
    this.phase = PHASE.IDLE;
    this.show(MSG.NONE, 0, 0);
    this.refreshMsg();
  }

  get active() { return this.phase === PHASE.READY || this.phase === PHASE.WAVE || this.phase === PHASE.BREAK; }

  /**
   * One frame.
   * @param {number} dt seconds
   * @param {number} zoneDist horizontal distance of the head from the zone centre (m)
   * @param {boolean} visible session visible (not blurred / hidden)
   * @param {boolean} yPressed Y button state
   */
  update(dt, zoneDist, visible, yPressed) {
    if (!(dt >= 0)) dt = 0;
    this.buttonY(dt, yPressed);
    const pm = this.pm;
    pm.setZone(zoneDist);
    pm.setVisible(visible);
    // Reasons are tracked in every phase but only pause an active round.
    if (pm.update(dt, this.active)) this.host.pause(pm.paused, pm.paused ? pm.cause : PAUSE.NONE);
    if (this.phase === PHASE.IDLE) { this.refreshMsg(); return; }
    if (!pm.paused) this.phaseStep(dt);
    this.refreshMsg();
  }

  /**
   * Pause now for an event (PAUSE.MANUAL, RESET, GAP, INPUT, RUNNING); the
   * normal resume protocol follows.
   * @param {number} bit
   * @returns {boolean} true when this started a pause
   */
  pauseNow(bit) {
    if (!this.active) return false;
    const started = this.pm.trigger(bit);
    if (started) this.host.pause(true, bit);
    this.refreshMsg();
    return started;
  }

  /** Frames stopped for a while (headset off, the system menu, a hitch): pause now. */
  interrupt() { this.pauseNow(PAUSE.GAP); }

  /** The Resume press (a trigger pull); counts only while "Pull the trigger to resume" shows. */
  press() { this.pm.press(); }

  /** Keep `bit` (e.g. PAUSE.RESET) blocking the resume until `release(bit)`. @param {number} bit */
  hold(bit) { this.pm.hold(bit); }

  /** @param {number} bit */
  release(bit) { this.pm.release(bit); }

  /**
   * Player damage. Ignored while paused or outside a round.
   * @param {number} n
   * @returns {number} damage applied
   */
  damage(n) {
    if (!(n > 0) || this.paused || !this.active) return 0;
    const before = this.health;
    this.health = Math.max(0, before - n);
    const d = before - this.health;
    this.host.health(this.health, -d);
    if (this.health <= 0) this.die();
    return d;
  }

  /** @param {boolean} headshot */
  kill(headshot) {
    if (!this.active) return;
    this.kills++;
    if (headshot) this.headshots++;
    if (this.phase === PHASE.WAVE) this.killedWave++;
  }

  /** Living enemies of this wave: the host's count, capped by spawned − killed. */
  living() {
    const a = this.host.alive();
    const b = this.spawned - this.killedWave;
    const n = a < b ? a : b;
    return n > 0 ? n : 0;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** @param {number} dt @param {boolean} y */
  buttonY(dt, y) {
    if (y) {
      this.yHeldS += dt;
      if (!this.exitDone && this.yHeldS >= RULES.exitHoldS && (this.phase !== PHASE.IDLE || this.setup)) {
        this.exitDone = true;
        this.host.exit('holdY');
      }
    } else {
      if (this.yWas && this.yHeldS < RULES.restartTapS && this.phase === PHASE.OVER) this.start();
      this.yHeldS = 0;
    }
    this.yWas = y;
  }

  clearPause() { this.pm.reset(); }

  /** @param {number} dt */
  phaseStep(dt) {
    if (this.timedT > 0) {
      this.timedT -= dt;
      if (this.timedT <= 0 && this.timedMsg !== MSG.OVER) this.timedMsg = MSG.NONE;
    }
    switch (this.phase) {
      case PHASE.READY:
      case PHASE.BREAK:
        this.phaseT -= dt;
        if (this.phaseT <= 0) this.startWave();
        break;
      case PHASE.WAVE: {
        // frozen (beyond 0.9 r, or an obstacle near): no new enemies
        if (this.spawned < this.total && this.living() < RULES.maxAlive && !this.pm.freeze) {
          this.spawnT -= dt;
          if (this.spawnT <= 0) {
            if (this.pm.paused) this.pm.violation(VIOLATION.SPAWN);
            if (this.host.spawn()) {
              this.spawned++;
              this.spawnT = RULES.spawnGapMinS + (RULES.spawnGapMaxS - RULES.spawnGapMinS) * this.rand();
            } else {
              this.spawnFails++;
              this.spawnT = RULES.spawnRetryS;
            }
          }
        }
        if (this.spawned >= this.total && this.living() === 0) this.clearWave();
        break;
      }
      default:
        break;
    }
  }

  startWave() {
    this.wave++;
    this.total = RULES.baseEnemies + this.wave;
    this.spawned = 0;
    this.killedWave = 0;
    this.spawnT = RULES.firstSpawnS;
    this.phase = PHASE.WAVE;
    this.show(MSG.WAVE, this.wave, RULES.waveMsgS);
    this.host.waveStart(this.wave, this.total);
  }

  clearWave() {
    this.phase = PHASE.BREAK;
    this.phaseT = RULES.breakS;
    this.host.waveClear(this.wave);
    const before = this.health;
    this.health = Math.min(RULES.maxHealth, before + RULES.breakHeal);
    if (this.health !== before) this.host.health(this.health, this.health - before);
    this.show(MSG.CLEARED, this.wave, RULES.clearMsgS);
  }

  die() {
    this.phase = PHASE.OVER;
    this.clearPause();
    this.show(MSG.OVER, this.wave, Infinity);
    this.refreshMsg();
    this.host.roundOver(this.wave, this.kills);
  }

  /** @param {number} code @param {number} n @param {number} seconds */
  show(code, n, seconds) {
    this.timedMsg = code;
    this.timedN = n;
    this.timedT = seconds;
  }

  /** The effective message: exit hold > pause states > the timed message. */
  refreshMsg() {
    let m = this.timedMsg, n = this.timedN;
    if (this.phase === PHASE.IDLE) { m = MSG.NONE; n = 0; }
    const pm = this.pm;
    if (pm.paused) {
      n = 0;
      const lv = pm.reasons, held = pm.latched & pm.held;
      if (lv & PAUSE.ZONE) m = MSG.ZONE;
      else if (lv & PAUSE.TRACKING) m = MSG.TRACKING;
      else if (lv & PAUSE.HIDDEN) m = MSG.PAUSED;
      else if (lv & PAUSE.CONTROLLER) m = MSG.CONTROLLER;
      else if (held & PAUSE.RESET) m = MSG.RESET;
      else if (pm.state === RESUME.COUNT) { m = MSG.COUNT; n = pm.countN; }
      else if (pm.state === RESUME.READY) { m = MSG.RESUME; n = pauseIndex(pm.cause); }
      else if (!pm.innerIn) m = MSG.CENTRE;
      else m = MSG.HOLD;
    }
    if (this.yHeldS >= RULES.exitHintS && !this.exitDone && (this.phase !== PHASE.IDLE || this.setup)) { m = MSG.EXITING; n = 0; }
    this.msg = m;
    this.msgN = n;
  }

  /** xorshift32 in [0, 1). */
  rand() {
    let x = this.rng;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng = x || 1;
    return x / 4294967296;
  }
}
