// @ts-check
/**
 * RoamSafety (pure: no three.js, no DOM; allocation-free per frame): the
 * walking-safety cues for Roam, the default play mode, where there is no
 * fixed safe zone and nothing UI-like may sit in the view.
 *
 * Every cue is diegetic: a level 0…1 per kind in `cue` (the watch's warning
 * kinds, WARN order: run, edge, obstacle, stairs, tracking), which GameSession
 * hands to the watch (`watch.warn(kind, level)`: a vibration pattern on the
 * left hand and a small word on the dial). Nothing here pauses:
 * - **run**: low-passed head speed ≥ 0.9 m/s (off below 0.75) → 0.25 rising to
 *   1 at 1.5 m/s. A warning, never a pause (the user walks the house).
 * - **edge**: the signed margin to the open edge of the mapped floor
 *   (world.edgeMargin: inferred walls, open sides, unmapped space behind a
 *   door; real walls are not an edge) below 0.9 m → rising to 1 at 0.35 m, 1
 *   off the map. 3 cm hysteresis.
 * - **obstacle**: the head's ObstacleWarnings level (a mapped wall or box
 *   close to the head), passed in.
 * - **tracking**: 1 while tracking is lost (PauseManager pauses for it too).
 * - **stairs**: reserved (no stair data yet), always 0.
 *
 * `freeze`: the head more than 0.3 m beyond the mapped floor (released at
 * 0.2 m): enemies stop and no new ones spawn, because nothing is known about
 * the real walls there (a round must never be fought through an unmapped
 * wall). Not a pause: no panel, the view stays clear.
 *
 * Seated (the player sat down: bed, couch): no run, edge or obstacle cue and
 * no off-map freeze; sitting is never treated as a hazard.
 *
 * Diagnostics: walked metres, a speed histogram (p50 / p95 / max while
 * walking), run warnings, time off the map and freezes, time near the edge,
 * obstacle cue time per minute, seated time, rooms visited.
 */

export const ROAM_SAFETY = Object.freeze({
  runWarn: 0.9,
  runOff: 0.75,
  runFull: 1.5,
  runMin: 0.25,
  edgeWarn: 0.9,
  edgeFull: 0.35,
  hyst: 0.03,
  offMapFreeze: -0.3,
  offMapRelease: -0.2,
  /** A single-frame head move longer than this is a tracking jump, not walking (m). */
  jumpM: 0.25,
  speedBinW: 0.05,
  speedBins: 64,
  maxRooms: 512,
});

/** Slots of `RoamSafety.input` (the per-frame doubles, written by the caller before `step`). */
export const IN = Object.freeze({ DT: 0, X: 1, Z: 2, SPEED: 3, MARGIN: 4, OBSTACLE: 5 });

/** Cue kinds (the watch's WARN order). */
export const CUE = Object.freeze({ RUN: 0, EDGE: 1, OBSTACLE: 2, STAIRS: 3, TRACKING: 4 });
export const CUE_NAMES = Object.freeze(['run', 'edge', 'obstacle', 'stairs', 'tracking']);

export class RoamSafety {
  constructor() {
    /** Cue levels, CUE order. */
    this.cue = new Float32Array(CUE_NAMES.length);
    /** Per-frame inputs (IN slots), for `step`. */
    this.input = new Float64Array(6);
    this.freeze = false;
    this.offMap = false;
    this.running = false;
    this._edgeOn = false;
    this._lastX = 0;
    this._lastZ = 0;
    this._has = false;
    // ── stats (resetStats) ──
    this.hist = new Float64Array(ROAM_SAFETY.speedBins);
    this.rooms = new Uint8Array(ROAM_SAFETY.maxRooms);
    this.walkedM = 0;
    this.timeS = 0;
    this.walkS = 0;
    this.maxSpeed = 0;
    this.runWarnings = 0;
    this.runS = 0;
    this.offMapS = 0;
    this.offMapEvents = 0;
    this.edgeS = 0;
    this.edgeWarnings = 0;
    this.obstacleS = 0;
    this.seatedS = 0;
    this.roomChanges = 0;
    /** @type {number} */ this.lastRoom = 0;
  }

  /** A new round: cues off (stats kept). */
  reset() {
    this.cue.fill(0);
    this.freeze = false;
    this.offMap = false;
    this.running = false;
    this._edgeOn = false;
    this._has = false;
  }

  /** New session: clear the diagnostics. */
  resetStats() {
    this.walkedM = 0;
    this.timeS = 0;
    this.walkS = 0;
    this.maxSpeed = 0;
    this.runWarnings = 0;
    this.runS = 0;
    this.offMapS = 0;
    this.offMapEvents = 0;
    this.edgeS = 0;
    this.edgeWarnings = 0;
    this.obstacleS = 0;
    this.seatedS = 0;
    this.roomChanges = 0;
    this.lastRoom = 0;
    this.hist.fill(0);
    this.rooms.fill(0);
  }

  /**
   * One frame from `input` (IN slots: dt, head x, z, speed, edge margin,
   * obstacle level): the per-frame form (no doubles passed as arguments, so
   * V8 boxes nothing).
   * @param {boolean} active @param {boolean} valid @param {boolean} seated @param {boolean} trackingOk
   * @param {number} room
   */
  step(active, valid, seated, trackingOk, room) {
    const I = this.input;
    let dt = I[0];
    const x = I[1], z = I[2], speed = I[3], margin = I[4], obstacle = I[5];
    if (!(dt >= 0)) dt = 0;
    const C = this.cue, S = ROAM_SAFETY;
    if (!active || !valid) {
      C[CUE.RUN] = C[CUE.EDGE] = C[CUE.OBSTACLE] = C[CUE.STAIRS] = 0;
      C[CUE.TRACKING] = active && !trackingOk ? 1 : 0;
      this.freeze = false;
      this.running = false;
      this._edgeOn = false;
      this._has = valid;
      this._lastX = x;
      this._lastZ = z;
      return;
    }
    // walked distance (tracking jumps ignored)
    if (this._has) {
      const dx = x - this._lastX, dz = z - this._lastZ, m = Math.sqrt(dx * dx + dz * dz);
      if (m <= S.jumpM) this.walkedM += m;
    }
    this._has = true;
    this._lastX = x;
    this._lastZ = z;
    this.timeS += dt;
    if (room > 0 && room < this.rooms.length) {
      if (!this.rooms[room]) this.rooms[room] = 1;
      if (room !== this.lastRoom) { if (this.lastRoom) this.roomChanges++; this.lastRoom = room; }
    }
    if (seated) {
      this.seatedS += dt;
      C[CUE.RUN] = C[CUE.EDGE] = C[CUE.OBSTACLE] = C[CUE.STAIRS] = 0;
      C[CUE.TRACKING] = trackingOk ? 0 : 1;
      this.freeze = false;
      this.offMap = false;
      this.running = false;
      this._edgeOn = false;
      return;
    }
    // speed stats
    const sp = speed > 0 ? speed : 0;
    if (sp > 0.15) {
      this.walkS += dt;
      let b = Math.floor(sp / S.speedBinW);
      if (b >= S.speedBins) b = S.speedBins - 1;
      this.hist[b] += dt;
    }
    if (sp > this.maxSpeed) this.maxSpeed = sp;
    // run: a warning only
    const run = this.running ? sp > S.runOff : sp >= S.runWarn;
    if (run && !this.running) this.runWarnings++;
    this.running = run;
    if (run) this.runS += dt;
    let rl = (sp - S.runWarn) / (S.runFull - S.runWarn);
    rl = rl < S.runMin ? S.runMin : rl > 1 ? 1 : rl;
    C[CUE.RUN] = run ? rl : 0;
    // edge of the map
    const m = margin === margin ? margin : 99;
    const on = this._edgeOn ? m < S.edgeWarn + S.hyst : m < S.edgeWarn;
    if (on && !this._edgeOn) this.edgeWarnings++;
    this._edgeOn = on;
    let el = (S.edgeWarn - m) / (S.edgeWarn - S.edgeFull);
    el = m <= S.edgeFull ? 1 : el < 0 ? 0 : el > 1 ? 1 : el;
    C[CUE.EDGE] = on ? el : 0;
    if (on) this.edgeS += dt;
    const off = this.freeze ? m < S.offMapRelease : m < S.offMapFreeze;
    if (off && !this.freeze) this.offMapEvents++;
    this.freeze = off;
    this.offMap = m < 0;
    if (this.offMap) this.offMapS += dt;
    // obstacle near the head
    const ob = obstacle > 0 ? (obstacle > 1 ? 1 : obstacle) : 0;
    C[CUE.OBSTACLE] = ob;
    if (ob > 0) this.obstacleS += dt;
    C[CUE.STAIRS] = 0;
    C[CUE.TRACKING] = trackingOk ? 0 : 1;
  }

  /**
   * One frame.
   * @param {number} dt seconds
   * @param {boolean} active a round is running (cues and the freeze apply)
   * @param {boolean} valid the head pose is valid
   * @param {number} x @param {number} z head
   * @param {number} speed low-passed horizontal head speed (m/s)
   * @param {number} margin world.edgeMargin at the head (m; 99 = no edge known)
   * @param {number} obstacle the head's obstacle level 0…1
   * @param {boolean} seated
   * @param {boolean} trackingOk
   * @param {number} room the player's room id (0 = unknown)
   */
  update(dt, active, valid, x, z, speed, margin, obstacle, seated, trackingOk, room) {
    const I = this.input;
    I[0] = dt; I[1] = x; I[2] = z; I[3] = speed; I[4] = margin; I[5] = obstacle;
    this.step(active, valid, seated, trackingOk, room);
  }

  /** Speed at quantile q of the walking time (m/s). @param {number} q */
  speedQuantile(q) {
    const H = this.hist, tot = this.walkS;
    if (!(tot > 0)) return 0;
    let acc = 0;
    for (let b = 0; b < H.length; b++) {
      acc += H[b];
      if (acc >= q * tot) return (b + 0.5) * ROAM_SAFETY.speedBinW;
    }
    return (H.length - 0.5) * ROAM_SAFETY.speedBinW;
  }

  /** Session-record summary (allocates). */
  report() {
    const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
    /** @type {number[]} */ const visited = [];
    for (let r = 1; r < this.rooms.length; r++) if (this.rooms[r]) visited.push(r);
    const min = this.timeS / 60;
    return {
      timeS: r2(this.timeS), walkedM: r2(this.walkedM), walkS: r2(this.walkS),
      speed: { p50: r2(this.speedQuantile(0.5)), p95: r2(this.speedQuantile(0.95)), max: r2(this.maxSpeed) },
      runWarnings: this.runWarnings, runS: r2(this.runS),
      edgeWarnings: this.edgeWarnings, edgeS: r2(this.edgeS), offMapS: r2(this.offMapS), offMapFreezes: this.offMapEvents,
      obstacleCueS: r2(this.obstacleS), obstacleCuePerMin: min > 0 ? r2(this.obstacleS / min) : 0,
      seatedS: r2(this.seatedS), roomsVisited: visited, roomChanges: this.roomChanges,
    };
  }
}
