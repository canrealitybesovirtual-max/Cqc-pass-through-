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
 *   after 0.5 s. `host.spawn()` may also return 2 = "still searching" (Roam's
 *   time-sliced spawn search): asked again next frame, not counted as a fail.
 *   `requeue(n)` puts n living enemies back into the wave's queue (a
 *   reference-space realign despawns them).
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

/**
 * v0.6 game modes (the page's Enter MR buttons, `?mode=`):
 * - SURVIVAL: the waves above;
 * - CLEAR (room clearing): one round; the host places every defender at once (`host.spawn(SPAWN_KIND.HIDE)`, one a
 *   call, `host.hides()` of them) in the rooms behind real cover; the house is clear when they are all down
 *   (`host.cleared(seconds)`; the round's time is the score); dying ends it as in survival;
 * - DEFEND (home defense): waves of 3 + n enemies that breach through the house's exterior doors in stacks of 2–3
 *   (`host.spawn(SPAWN_KIND.BREACH, door)`, door = 0 … host.breachDoors() − 1, one door per stack, 0.6–1.1 s
 *   apart inside a stack, 5–9 s between stacks), at most 5 alive.
 */
export const MODE = Object.freeze({ SURVIVAL: 0, CLEAR: 1, DEFEND: 2 });
export const MODE_NAME = Object.freeze(['survival', 'clear', 'defend']);
/** What `host.spawn(kind, door)` is asked for. */
export const SPAWN_KIND = Object.freeze({ ROAM: 0, HIDE: 1, BREACH: 2 });

/**
 * A mode from a name ('survival' | 'clear' | 'defend', any case; also 'waves', 'rooms', 'defense') or a URL query
 * (`?mode=clear`); anything else is SURVIVAL. Pure.
 * @param {string|null|undefined} v
 * @returns {number} MODE
 */
export function modeFrom(v) {
  if (typeof v !== 'string') return MODE.SURVIVAL;
  let k = v.trim().toLowerCase();
  const m = /(?:^|[?&])mode=([^&#]*)/.exec(k);
  if (m) k = m[1];
  else if (k.includes('=')) return MODE.SURVIVAL;
  if (k === 'clear' || k === 'rooms' || k === 'clearing') return MODE.CLEAR;
  if (k === 'defend' || k === 'defense' || k === 'defence' || k === 'home') return MODE.DEFEND;
  return MODE.SURVIVAL;
}
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
  HOUSE_CLEAR: 15, // v0.6 room clearing: n = seconds
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
  // v0.6 modes
  clearMax: 6, // defenders at most (the soldier pool)
  defendBase: 3, defendMaxAlive: 5,
  stack: Object.freeze([2, 3]), stackGapS: Object.freeze([0.6, 1.1]), stackPauseS: Object.freeze([5, 9]),
});

/**
 * @typedef {Object} RulesHost
 * @property {() => boolean|number} spawn          try to spawn one enemy: true / 1 placed, 2 still searching (ask again
 *                                                 next frame), false / 0 failed
 * @property {() => number} alive                  living enemies right now
 * @property {(wave: number, enemies: number) => void} waveStart
 * @property {(wave: number) => void} waveClear
 * @property {(wave: number, kills: number) => void} roundOver
 * @property {(paused: boolean, reason: number) => void} pause   reason = PAUSE bit that started it (NONE on resume)
 * @property {(health: number, delta: number) => void} health
 * @property {() => void} restart                  reset enemies / weapons for a fresh round
 * @property {(reason: string) => void} exit
 * @property {() => number} [hides]               room clearing: defenders the host can place (≤ RULES.clearMax)
 * @property {() => number} [breachDoors]         home defense: exterior doors (0: enemies come as in survival)
 * @property {(seconds: number, kills: number) => void} [cleared]  room clearing: every defender is down
 */

export class SurvivalRules {
  /**
   * @param {RulesHost} host
   * @param {{ seed?: number, zoneR?: number, requirePress?: boolean, runPause?: boolean }} [o] requirePress: false skips
   *   the Resume press (tools only); runPause: false = running is a warning, not a pause (Roam)
   */
  constructor(host, { seed = 0x9e3779b9, zoneR = RULES.zoneR, requirePress = true, runPause = true, mode = MODE.SURVIVAL } = {}) {
    this.host = host;
    /** @type {number} MODE (change between rounds: setMode) */ this.mode = mode;
    /** Seconds of play this round (not paused): room clearing's score. */
    this.roundS = 0;
    /** Room clearing: the house was cleared (the round is over, nobody died); its time. */
    this.cleared = false;
    this.clearS = 0;
    // home defense: the stack being sent
    this.stackLeft = 0;
    this.stackDoor = 0;
    /** Waves held off (home defense) / survived. */
    this.wavesHeld = 0;
    this.breachCount = 0;
    /** The mode this wave actually runs (room clearing falls back to survival where there is nothing to clear). */
    this.roundMode = mode;
    this.seed = seed >>> 0 || 1;
    this.rng = this.seed;
    /** Every pause decision: PauseManager (feed its inputs before update). */
    this.pm = new PauseManager({ zoneR, requirePress, runPause });
    /** Frames a spawn search has been pending (diagnostics). */
    this.spawnPendingFrames = 0;
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

  /** @param {number} m MODE (takes effect at the next start) */
  setMode(m) { this.mode = m === MODE.CLEAR || m === MODE.DEFEND ? m : MODE.SURVIVAL; }

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
    this.roundS = 0; this.cleared = false; this.clearS = 0; this.stackLeft = 0; this.wavesHeld = 0;
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

  /**
   * Put `n` living enemies back into this wave's queue (they were despawned
   * without a kill, e.g. by a realign). They spawn again as usual.
   * @param {number} n
   */
  requeue(n) {
    if (!(n > 0) || this.phase !== PHASE.WAVE) return;
    this.spawned = Math.max(this.killedWave, this.spawned - Math.floor(n));
    if (this.spawnT > RULES.firstSpawnS) this.spawnT = RULES.firstSpawnS;
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
      if (this.timedT <= 0 && this.timedMsg !== MSG.OVER && this.timedMsg !== MSG.HOUSE_CLEAR) this.timedMsg = MSG.NONE;
    }
    switch (this.phase) {
      case PHASE.READY:
      case PHASE.BREAK:
        this.phaseT -= dt;
        if (this.phaseT <= 0) this.startWave();
        break;
      case PHASE.WAVE: {
        this.roundS += dt;
        const M = this.roundMode, maxAlive = M === MODE.CLEAR ? RULES.clearMax : M === MODE.DEFEND ? RULES.defendMaxAlive : RULES.maxAlive;
        // frozen (beyond 0.9 r, or an obstacle near): no new enemies
        if (this.spawned < this.total && this.living() < maxAlive && !this.pm.freeze) {
          this.spawnT -= dt;
          if (this.spawnT <= 0) {
            if (this.pm.paused) this.pm.violation(VIOLATION.SPAWN);
            if (M === MODE.DEFEND && this.stackLeft <= 0) this.newStack();
            const got = M === MODE.CLEAR ? this.host.spawn(SPAWN_KIND.HIDE, 0)
              : M === MODE.DEFEND && this.breachCount > 0 ? this.host.spawn(SPAWN_KIND.BREACH, this.stackDoor) : this.host.spawn(SPAWN_KIND.ROAM, 0);
            if (got === 2) {
              this.spawnPendingFrames++;
              this.spawnT = 0; // still searching: ask again next frame
            } else if (got === true || got === 1) {
              this.spawned++;
              if (M === MODE.CLEAR) this.spawnT = 0; // the whole house at once
              else if (M === MODE.DEFEND) {
                this.stackLeft--;
                const g = this.stackLeft > 0 ? RULES.stackGapS : RULES.stackPauseS;
                this.spawnT = g[0] + (g[1] - g[0]) * this.rand();
              } else this.spawnT = RULES.spawnGapMinS + (RULES.spawnGapMaxS - RULES.spawnGapMinS) * this.rand();
            } else {
              this.spawnFails++;
              this.spawnT = RULES.spawnRetryS;
              // room clearing: a hide that cannot be placed is dropped (the house has fewer defenders)
              if (M === MODE.CLEAR && this.spawnFails > 3 * RULES.clearMax) this.total = this.spawned;
            }
          }
        }
        if (this.spawned >= this.total && this.living() === 0) {
          if (M === MODE.CLEAR) this.houseCleared();
          else this.clearWave();
        }
        break;
      }
      default:
        break;
    }
  }

  startWave() {
    this.wave++;
    let M = this.mode;
    this.total = M === MODE.CLEAR ? Math.max(0, Math.min(RULES.clearMax, this.host.hides ? this.host.hides() | 0 : 0))
      : M === MODE.DEFEND ? RULES.defendBase + this.wave : RULES.baseEnemies + this.wave;
    // a house with no room to clear (one room, the spot mode): survival waves instead
    if (M === MODE.CLEAR && this.total === 0) { M = MODE.SURVIVAL; this.total = RULES.baseEnemies + this.wave; }
    this.roundMode = M;
    this.breachCount = M === MODE.DEFEND && this.host.breachDoors ? this.host.breachDoors() | 0 : 0;
    this.stackLeft = 0;
    this.spawned = 0;
    this.killedWave = 0;
    this.spawnT = M === MODE.CLEAR ? 0 : RULES.firstSpawnS;
    this.phase = PHASE.WAVE;
    this.show(MSG.WAVE, this.wave, RULES.waveMsgS);
    this.host.waveStart(this.wave, this.total);
  }

  /** Home defense: the next stack (2–3, or what is left) and its door. */
  newStack() {
    const S = RULES.stack, left = this.total - this.spawned;
    const n = S[0] + Math.floor(this.rand() * (S[1] - S[0] + 1));
    this.stackLeft = n < left ? n : left;
    this.stackDoor = this.breachCount > 0 ? Math.floor(this.rand() * this.breachCount) % this.breachCount : 0;
  }

  /** Room clearing: every defender is down. */
  houseCleared() {
    this.cleared = true;
    this.clearS = this.roundS;
    this.phase = PHASE.OVER;
    this.clearPause();
    this.show(MSG.HOUSE_CLEAR, Math.round(this.clearS), Infinity);
    this.refreshMsg();
    if (this.host.cleared) this.host.cleared(this.clearS, this.kills);
  }

  clearWave() {
    this.wavesHeld = this.wave;
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
