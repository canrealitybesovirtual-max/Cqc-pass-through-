// @ts-check
/**
 * PauseManager (pure: no three.js, no DOM; allocation-free per frame): the ONE
 * place that decides when play pauses, when enemies freeze and how play
 * resumes (docs/PLAN.md §6.2 "Safe zone during play" and Phase 2
 * "PauseManager").
 *
 * Pause reasons (bits of `PAUSE`):
 * - level reasons, active while their condition holds:
 *     ZONE        the head beyond the zone radius r (3 cm hysteresis);
 *     HIDDEN      the session is not visible (blurred / hidden);
 *     TRACKING    no viewer pose, or `emulatedPosition` (6DoF tracking lost);
 *     CONTROLLER  no controller present for 0.25 s (put down, hand tracking);
 * - latched reasons, an event that pauses until the resume protocol finishes:
 *     GAP         no frame for more than 250 ms (a hitch, the system menu);
 *     INPUT       a controller input source went away;
 *     RUNNING     horizontal head speed above 1.2 m/s ("no running");
 *     MANUAL      B+Y together, or the wrist button;
 *     RESET       the reference space was reset (recentred). With
 *                 `hold(PAUSE.RESET)` it also blocks the resume until
 *                 `release(PAUSE.RESET)` (after the world is realigned).
 *
 * Resume protocol (PLAN §6.2): every level reason (and every held latch) gone,
 * then the head within 0.7 r for 0.5 s with tracking fine for 0.4 s, then the
 * player presses Resume (`press()`, the trigger), then a 3-2-1 countdown with
 * enemies still frozen but shown. A reason or a new event during any of this
 * starts it over. While paused and not counting down `hidden` is true: enemies
 * and effects are hidden and the view stays clear.
 *
 * Soft zone levels while playing (`zoneLevel`): 1 beyond 0.8 r (ring + one
 * `tick`), 2 beyond 0.9 r (edge highlight, enemies freeze), 3 beyond r (pause).
 * `freeze` = paused, or zone level ≥ 2, or a mapped obstacle near the head or a
 * hand (`setObstacle`).
 *
 * Inputs are set before `update(dt, active)`; `active` = a round is running
 * (pauses only apply then; outside a round the state clears silently).
 *
 * Roam (the default play mode, v0.3): `runPause = false` makes running a
 * warning, not a pause (`running` is still tracked; RoamSafety turns it into
 * a watch cue), and the zone is off (GameSession feeds a zone distance of 0).
 * Tracking loss, visibility, controllers, gaps, manual and reset still pause.
 */

export const PAUSE = Object.freeze({
  NONE: 0,
  ZONE: 1,
  HIDDEN: 2,
  GAP: 4,
  TRACKING: 8,
  CONTROLLER: 16,
  INPUT: 32,
  RUNNING: 64,
  MANUAL: 128,
  RESET: 256,
});

/** Active while their condition holds. */
export const PAUSE_LEVEL = PAUSE.ZONE | PAUSE.HIDDEN | PAUSE.TRACKING | PAUSE.CONTROLLER;
/** Events: latched until the resume protocol completes. */
export const PAUSE_LATCH = PAUSE.GAP | PAUSE.INPUT | PAUSE.RUNNING | PAUSE.MANUAL | PAUSE.RESET;
/** Priority for the reported cause and the message: the first present wins. */
export const PAUSE_ORDER = Object.freeze([
  PAUSE.ZONE, PAUSE.TRACKING, PAUSE.HIDDEN, PAUSE.CONTROLLER, PAUSE.RESET, PAUSE.INPUT, PAUSE.RUNNING, PAUSE.GAP, PAUSE.MANUAL,
]);
/** Names by bit index (pause event `reason`, diagnostics). */
export const PAUSE_NAMES = Object.freeze(['zone', 'hidden', 'gap', 'tracking', 'controller', 'input', 'running', 'manual', 'reset']);

/** Resume protocol states. */
export const RESUME = Object.freeze({ RUN: 0, BLOCKED: 1, WAIT: 2, READY: 3, COUNT: 4 });
export const RESUME_NAMES = Object.freeze(['run', 'blocked', 'wait', 'ready', 'count']);

/** Safety violations (PLAN §6.2; the Phase 7 exit criterion is zero). */
export const VIOLATION = Object.freeze({ OUTSIDE: 0, OBSTACLE: 1, SHOT: 2, SPAWN: 3 });
export const VIOLATION_NAMES = Object.freeze(['timeOutsideZone', 'timeInsideObstacle', 'enemyShotWhilePaused', 'spawnWhilePaused']);

/** Thresholds (design values, PLAN §6.2 / Phase 2). */
export const SAFETY = Object.freeze({
  /** Back inside means 3 cm inside the edge, so standing on a line does not flicker. */
  hyst: 0.03,
  ringK: 0.8,
  freezeK: 0.9,
  resumeK: 0.7,
  insideS: 0.5,
  trackOkS: 0.4,
  countdownS: 3,
  noControllerS: 0.25,
  gapMs: 250,
  runSpeed: 1.2,
  /** Head-speed low-pass time constant (s). */
  speedTau: 0.15,
  /** "Running" ends below this fraction of runSpeed (hysteresis). */
  runOffK: 0.8,
  /** A single-frame head move faster than this (m/s) or longer than jumpM is a tracking jump, not running. */
  jumpSpeed: 5,
  jumpM: 0.25,
});

const LOG_N = 32;

/** Index of the lowest set bit (−1 for 0). @param {number} bit */
export function pauseIndex(bit) {
  return bit ? 31 - Math.clz32(bit & -bit) : -1;
}

/** @param {number} bit @returns {string} '' for NONE */
export function pauseName(bit) {
  const i = pauseIndex(bit);
  return i >= 0 && i < PAUSE_NAMES.length ? PAUSE_NAMES[i] : '';
}

/** The highest-priority reason present in `bits` (0 = none). @param {number} bits */
export function firstReason(bits) {
  for (let i = 0; i < PAUSE_ORDER.length; i++) if (bits & PAUSE_ORDER[i]) return PAUSE_ORDER[i];
  return 0;
}

export class PauseManager {
  /** @param {{ zoneR?: number, requirePress?: boolean, runPause?: boolean }} [o] */
  constructor({ zoneR = 0.8, requirePress = true, runPause = true } = {}) {
    this.zoneR = zoneR;
    /** Running (> 1.2 m/s) pauses (spot play); false = only `running` is set (Roam: a warning). */
    this.runPause = runPause;
    /** Head speed above the run threshold right now (with hysteresis). */
    this.running = false;
    /** The Resume press is part of the protocol (PLAN §6.2); false skips it (tools only). */
    this.requirePress = requirePress;
    // ── inputs ──
    this.zoneDist = 0;
    this.visible = true;
    this.trackingOk = true;
    this.ctlL = true;
    this.ctlR = true;
    this.headX = 0;
    this.headZ = 0;
    this.headValid = false;
    this.obstacle = false;
    this.obstacleInside = false;
    this.pressed = false;
    // ── state ──
    this.active = false;
    this.paused = false;
    /** RESUME state. @type {number} */
    this.state = RESUME.RUN;
    /** The reason that started this pause (a PAUSE bit). @type {number} */
    this.cause = 0;
    /** Level reasons right now. */
    this.reasons = 0;
    /** Latched events since the pause began. */
    this.latched = 0;
    /** Latches that block the resume until released. */
    this.held = 0;
    /** Events raised since the last update (start a pause / restart the protocol). */
    this.fresh = 0;
    this.changed = false;
    this.hidden = false;
    this.freeze = false;
    this.zoneOut = false;
    this.zoneLevel = 0;
    this._l1 = false;
    this._l2 = false;
    /** Head within 0.7 r (with hysteresis). */
    this.innerIn = true;
    /** True for the one update the head crossed 0.8 r outward while playing. */
    this.tick = false;
    this._tickArmed = true;
    this.insideT = 0;
    /** Seconds of good tracking (pose present, not emulated). */
    this.trackT = 1e9;
    this.noCtlT = 0;
    this._prevL = false;
    this._prevR = false;
    this.speed = 0;
    this._fast = false;
    this._lastX = 0;
    this._lastZ = 0;
    this._hasLast = false;
    this._skipSpeed = false;
    /** Countdown left (s), −1 when not counting. */
    this.countT = -1;
    this.countN = 0;
    this.time = 0;
    // ── diagnostics (fixed size) ──
    /** Pauses started, per reason bit index. */
    this.pauseCounts = new Uint32Array(PAUSE_NAMES.length);
    this.violationCounts = new Uint32Array(VIOLATION_NAMES.length);
    this.logKind = new Uint8Array(LOG_N);
    this.logT = new Float64Array(LOG_N);
    this.logN = 0;
    this._lastViolT = -1e9;
  }

  // ── inputs (call before update) ─────────────────────────────────────────

  /** Horizontal distance of the head from the zone centre (m). @param {number} d */
  setZone(d) { this.zoneDist = Number.isFinite(d) ? d : 0; }

  /** @param {boolean} v session visible (not blurred / hidden) */
  setVisible(v) { this.visible = !!v; }

  /** @param {boolean} ok viewer pose present and not `emulatedPosition` */
  setTracking(ok) { this.trackingOk = !!ok; }

  /** @param {boolean} left @param {boolean} right controller sources present */
  setControllers(left, right) { this.ctlL = !!left; this.ctlR = !!right; }

  /** Head position for the "no running" rule. @param {number} x @param {number} z */
  setHead(x, z) {
    this.headX = x;
    this.headZ = z;
    this.headValid = Number.isFinite(x) && Number.isFinite(z);
  }

  /**
   * @param {boolean} near a mapped wall / furniture box within the warning distance of the head or a hand
   * @param {boolean} [inside] the head or a hand inside a mapped box
   */
  setObstacle(near, inside = false) { this.obstacle = !!near; this.obstacleInside = !!inside; }

  /** The Resume press (a trigger pull); counts only while waiting for it. */
  press() { this.pressed = true; }

  /**
   * An event that pauses at once (MANUAL, RESET, GAP, INPUT, RUNNING).
   * @param {number} bit PAUSE latch bit
   * @returns {boolean} true when this started a pause
   */
  trigger(bit) {
    if (!this.active || !(bit & PAUSE_LATCH)) return false;
    this.latched |= bit;
    if (bit === PAUSE.RESET) { this._skipSpeed = true; this._hasLast = false; }
    if (!this.paused) {
      this.startPause(bit);
      return true;
    }
    // a hitch while already paused changes nothing (nothing runs); any other event starts the resume over
    if (bit !== PAUSE.GAP) this.restartProtocol();
    return false;
  }

  /** Keep a latch blocking the resume until `release(bit)`. @param {number} bit */
  hold(bit) { this.held |= bit & PAUSE_LATCH; }

  /** @param {number} bit */
  release(bit) { this.held &= ~bit; }

  /** A new round (or the end of one): running, nothing latched. */
  reset() {
    this.paused = false;
    this.state = RESUME.RUN;
    this.cause = 0;
    this.latched = 0;
    this.held = 0;
    this.fresh = 0;
    this.hidden = false;
    this.freeze = false;
    this.insideT = 0;
    this.countT = -1;
    this.countN = 0;
    this.pressed = false;
    this.zoneOut = false;
    this.zoneLevel = 0;
    this._l1 = this._l2 = false;
    this.innerIn = true;
    this._tickArmed = true;
    this.speed = 0;
    this._fast = false;
    this._hasLast = false;
  }

  /** Clear the diagnostics (new session). */
  resetStats() {
    this.pauseCounts.fill(0);
    this.violationCounts.fill(0);
    this.logN = 0;
  }

  /**
   * Log a safety violation (fixed ring of the last 32).
   * @param {number} kind VIOLATION
   * @param {number} [t] seconds (defaults to the manager's own clock)
   */
  violation(kind, t = this.time) {
    if (kind < 0 || kind >= this.violationCounts.length) return;
    this.violationCounts[kind]++;
    // v0.6: a run of frames of the same kind is one log entry (the v0.5 record logged 32 frames of one 0.5 s stay)
    if (this.logN > 0) {
      const j = (this.logN - 1) % LOG_N;
      if (this.logKind[j] === kind && t - this._lastViolT < 1) { this._lastViolT = t; return; }
    }
    this._lastViolT = t;
    const i = this.logN % LOG_N;
    this.logKind[i] = kind;
    this.logT[i] = t;
    this.logN++;
  }

  /** Total violations logged. */
  get violations() {
    let n = 0;
    for (let i = 0; i < this.violationCounts.length; i++) n += this.violationCounts[i];
    return n;
  }

  /**
   * One frame.
   * @param {number} dt seconds
   * @param {boolean} active a round is running (pauses apply)
   * @returns {boolean} true when `paused` changed in this update
   */
  update(dt, active) {
    if (!(dt >= 0)) dt = 0;
    this.time += dt;
    this.changed = false;
    this.tick = false;
    this.active = active;

    this.trackT = this.trackingOk ? this.trackT + dt : 0;
    const anyCtl = this.ctlL || this.ctlR;
    this.noCtlT = anyCtl ? 0 : this.noCtlT + dt;
    const removed = (this._prevL && !this.ctlL) || (this._prevR && !this.ctlR);
    this._prevL = this.ctlL;
    this._prevR = this.ctlR;
    this.speedStep(dt);
    this.zoneStep();

    let lv = 0;
    if (this.zoneOut) lv |= PAUSE.ZONE;
    if (!this.visible) lv |= PAUSE.HIDDEN;
    if (!this.trackingOk) lv |= PAUSE.TRACKING;
    if (this.noCtlT >= SAFETY.noControllerS) lv |= PAUSE.CONTROLLER;
    this.reasons = lv;

    if (!active) {
      if (this.paused || this.latched || this.held) this.reset();
      this.fresh = 0;
      this.pressed = false;
      this.freeze = false;
      this.hidden = false;
      return false;
    }

    if (removed) this.raise(PAUSE.INPUT);
    // running: each rise above 1.2 m/s is an event (it restarts a resume in progress too)
    const fast = this.trackingOk && (this._fast ? this.speed > SAFETY.runSpeed * SAFETY.runOffK : this.speed > SAFETY.runSpeed);
    if (fast && !this._fast && this.runPause) this.raise(PAUSE.RUNNING);
    this._fast = fast;
    this.running = fast;
    const fresh = this.fresh;
    this.fresh = 0;

    if (!this.paused) {
      const start = lv | fresh;
      if (start) this.startPause(firstReason(start));
      else if (this.zoneLevel >= 1 && this._tickArmed) this.tick = true;
    } else if (fresh) {
      this.restartProtocol();
    }
    this._tickArmed = this.zoneLevel === 0;
    if (this.paused) this.resumeStep(dt, lv | (this.latched & this.held));

    this.freeze = this.paused || this.zoneLevel >= 2 || this.obstacle;
    this.hidden = this.paused && this.state !== RESUME.COUNT;
    if (!this.paused) {
      if (this.zoneDist > this.zoneR) this.violation(VIOLATION.OUTSIDE);
      if (this.obstacleInside) this.violation(VIOLATION.OBSTACLE);
    }
    this.pressed = false;
    return this.changed;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Record an event detected inside update. @param {number} bit */
  raise(bit) {
    this.fresh |= bit;
    this.latched |= bit;
  }

  /** @param {number} bit */
  startPause(bit) {
    this.paused = true;
    this.cause = bit;
    this.state = RESUME.BLOCKED;
    this.insideT = 0;
    this.countT = -1;
    this.countN = 0;
    this.hidden = true;
    this.freeze = true;
    this.changed = true;
    if (bit & PAUSE_LATCH) this.latched |= bit;
    const i = pauseIndex(bit);
    if (i >= 0 && i < this.pauseCounts.length) this.pauseCounts[i]++;
  }

  restartProtocol() {
    if (this.state === RESUME.BLOCKED) return; // already reset (runs every frame while blocked)
    this.state = RESUME.BLOCKED;
    this.insideT = 0;
    this.countT = -1;
    this.countN = 0;
    this.hidden = true;
  }

  /** @param {number} dt @param {number} blockers */
  resumeStep(dt, blockers) {
    if (blockers) { this.restartProtocol(); return; }
    switch (this.state) {
      case RESUME.BLOCKED:
        this.state = RESUME.WAIT;
        this.insideT = 0;
      // falls through: this frame already counts
      case RESUME.WAIT:
        this.insideT = this.innerIn ? this.insideT + dt : 0;
        if (this.insideT >= SAFETY.insideS && this.trackT >= SAFETY.trackOkS) {
          if (this.requirePress) this.state = RESUME.READY;
          else this.startCount();
        }
        break;
      case RESUME.READY:
        if (!this.innerIn) { this.state = RESUME.WAIT; this.insideT = 0; break; }
        if (this.pressed) this.startCount();
        break;
      case RESUME.COUNT:
        this.countT -= dt;
        if (this.countT <= 0) this.finishResume();
        else this.countN = Math.ceil(this.countT - 1e-6); // 2.0000000000000036 s left shows 2
        break;
      default:
        break;
    }
  }

  startCount() {
    this.state = RESUME.COUNT;
    this.countT = SAFETY.countdownS;
    this.countN = Math.ceil(this.countT);
  }

  finishResume() {
    this.paused = false;
    this.state = RESUME.RUN;
    this.cause = 0;
    this.latched = 0;
    this.held = 0;
    this.countT = -1;
    this.countN = 0;
    this.insideT = 0;
    this.changed = true;
  }

  zoneStep() {
    const r = this.zoneR, d = this.zoneDist, h = SAFETY.hyst;
    this.zoneOut = this.zoneOut ? d > r - h : d > r;
    const r2 = r * SAFETY.freezeK, r1 = r * SAFETY.ringK, ri = r * SAFETY.resumeK;
    this._l2 = this._l2 ? d > r2 - h : d > r2;
    this._l1 = this._l1 ? d > r1 - h : d > r1;
    this.zoneLevel = this.zoneOut ? 3 : this._l2 ? 2 : this._l1 ? 1 : 0;
    this.innerIn = this.innerIn ? d <= ri + h : d <= ri;
  }

  /** Low-passed horizontal head speed; single-frame jumps are tracking, not running. @param {number} dt */
  speedStep(dt) {
    if (!this.headValid) { this._hasLast = false; return; }
    const x = this.headX, z = this.headZ;
    if (this._hasLast && !this._skipSpeed && dt > 0 && dt <= 0.1) {
      const dx = x - this._lastX, dz = z - this._lastZ;
      const m = Math.sqrt(dx * dx + dz * dz);
      const v = m / dt;
      if (m <= SAFETY.jumpM && v <= SAFETY.jumpSpeed) this.speed += (v - this.speed) * (1 - Math.exp(-dt / SAFETY.speedTau));
    }
    this._skipSpeed = false;
    this._lastX = x;
    this._lastZ = z;
    this._hasLast = true;
  }
}
