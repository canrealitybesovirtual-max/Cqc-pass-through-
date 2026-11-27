// @ts-check
/**
 * Pure logic for the wrist watch (src/ui/Watch.js): no three.js, no DOM, so
 * every rule here runs under `node --test` (tests/unit/watch.logic.test.js).
 *
 * Frames and units: metres, seconds. The watch's local frame has +X = 3
 * o'clock, +Y = 12 o'clock and +Z = out of the dial, with the origin at the
 * dial centre. Its pose is built in the LEFT controller's target-ray frame
 * (research-cqc §1): the v0.2 wrist HUD used the grip frame as if +Y ran up
 * the arm, but on Quest Touch Plus the grip frame is the ray frame pitched
 * 45° about X (IWER profile), so its text came out turned 180° (it looked
 * mirrored). In ray axes, a watch worn on the back of the left wrist has:
 *
 *   3 o'clock (local +X) = (0, 0, −1)            toward the fingers
 *   12 o'clock (local +Y) = (−sin t, −cos t, 0)  away from the thumb
 *   dial normal (local +Z) = (−cos t, sin t, 0)  out of the back of the hand,
 *                                               tilted t = 15° toward the eyes
 *   centre = grip origin + normal·out + (0, 0, back)   (4.3 cm out, 9 cm back)
 *
 * In the watch-check pose (forearm across the chest, palm down) that puts 12
 * away from you and 3 toward the hand, like a real watch.
 */

const DEG = Math.PI / 180;

/** Tuned values. CQC-tuned ones are marked (reference values only, no code). */
export const WATCH = Object.freeze({
  /** Where the dial sits (research-cqc C1); every field can be overridden (URL, settings). */
  fit: Object.freeze({ back: 0.090, out: 0.043, tiltDeg: 15, scale: 1 }),
  /** Dial radius at scale 1 (a 41.6 mm case). */
  dialR: 0.0150,
  /** Wake: the dial faces the eyes and is looked at. Sleep has wider limits (hysteresis). */
  wake: Object.freeze({
    onS: 0.12, faceOn: Math.cos(40 * DEG), gazeOn: Math.cos(30 * DEG), maxOn: 0.6,
    offS: 0.35, faceOff: Math.cos(55 * DEG), gazeOff: Math.cos(40 * DEG), maxOff: 0.7,
    /** Minimum gap between two wake ticks on the left hand. */
    buzzGapS: 1.0,
  }),
  /** Touching the dial with the right controller tip (CQC-tuned: tapR 0.03, tapZ 0.022, re-arm 0.04 / 0.045). */
  tap: Object.freeze({ tip: 0.012, r: 0.030, zMin: -0.02, z: 0.022, rearmR: 0.040, rearmZ: 0.045 }),
  /** Pointing at the dial with the right ray: within this radius, up to this far. */
  ray: Object.freeze({ r: 0.022, max: 1.0 }),
  /**
   * The menu disc (CQC terminal values: hover 0.08, press 0.006, re-arm 0.025).
   * Placed at open in the watch's direction from the eye, raised by raiseDeg
   * (kept between downMin° and downMax° below eye level), `dist` from the eye:
   * an easy reading distance that the right hand still reaches. Closes when the
   * head is farther than farM from it.
   */
  menu: Object.freeze({ r: 0.08, px: 512, hoverZ: 0.08, pressZ: 0.006, rearmZ: 0.025, behindZ: -0.04,
    dist: 0.40, raiseDeg: 22, downMin: 10, downMax: 40, farM: 0.9, flashS: 0.14, rayMax: 2.0 }),
  /** Two taps within this many seconds confirm RESTART / EXIT / RESET. */
  confirmS: 3,
  /** Canvas redraws: at most one per this many ms (and one upload per frame across panels). */
  redrawMs: 500,
  /** Gun-fit edit limits and rates (research-fit C: 20°/s, 3 cm/s, dead zone 0.15, cubic response). */
  fitLimits: Object.freeze({ pitchDeg: 20, up: 0.04, fwd: 0.04 }),
  fitRates: Object.freeze({ pitchDegS: 20, mS: 0.03, dead: 0.15, stepDeg: 0.5, stepM: 0.001, tickDeg: 1, tickM: 0.005 }),
});

/**
 * IWER `meta-quest-touch-plus` gripOffsetMatrix rotation: the grip frame in
 * the ray frame, column-major (same numbers as WeaponSystem's
 * IWER_GRIP_IN_RAY). Not yet device-verified (Watch records the live relation).
 */
export const GRIP_IN_RAY = Object.freeze({
  left: Object.freeze([0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1]),
  right: Object.freeze([0.99255, 0, 0.12187, 0, -0.08617, 0.70711, 0.70184, 0, -0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1]),
});

/**
 * Where the menu disc opens: in the watch's direction from the eye, raised by
 * `raiseDeg` and kept between `downMin` and `downMax` degrees below eye level,
 * `dist` metres from the eye.
 * @param {number} ex @param {number} ey @param {number} ez eye
 * @param {number} wx @param {number} wy @param {number} wz watch dial centre
 * @param {Float64Array|number[]} out [x, y, z]
 */
export function menuSpot(ex, ey, ez, wx, wy, wz, out) {
  const M = WATCH.menu;
  let dx = wx - ex, dz = wz - ez;
  const dy = wy - ey;
  let h = Math.sqrt(dx * dx + dz * dz);
  if (h < 1e-4) { dx = 0; dz = -1; h = 1; }
  const elev = Math.atan2(dy, h);
  const lo = -M.downMax * DEG, hi = -M.downMin * DEG;
  let e = elev + M.raiseDeg * DEG;
  e = e < lo ? lo : e > hi ? hi : e;
  const c = Math.cos(e) * M.dist;
  out[0] = ex + (dx / h) * c;
  out[1] = ey + Math.sin(e) * M.dist;
  out[2] = ez + (dz / h) * c;
  return out;
}

/**
 * The watch's local frame in ray axes (column-major 4×4, scale included).
 * @param {{ back?: number, out?: number, tiltDeg?: number, scale?: number }} fit
 * @param {Float32Array|number[]} out 16 numbers
 */
export function watchOffset(fit, out) {
  const F = WATCH.fit;
  const back = num(fit.back, F.back), o = num(fit.out, F.out), k = num(fit.scale, F.scale);
  const t = num(fit.tiltDeg, F.tiltDeg) * DEG, c = Math.cos(t), s = Math.sin(t);
  out[0] = 0; out[1] = 0; out[2] = -k; out[3] = 0;          // 3 o'clock
  out[4] = -s * k; out[5] = -c * k; out[6] = 0; out[7] = 0;  // 12 o'clock
  out[8] = -c * k; out[9] = s * k; out[10] = 0; out[11] = 0; // dial normal
  out[12] = -c * o; out[13] = s * o; out[14] = back; out[15] = 1;
  return out;
}

/** @param {unknown} v @param {number} d */
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

// ── wake ─────────────────────────────────────────────────────────────────────

/** Wake when the wrist is turned toward the eyes and looked at; sleep with hysteresis. */
export class WakeGate {
  constructor() {
    this.awake = false;
    this.t = 0;
  }

  reset() { this.awake = false; this.t = 0; }

  /**
   * @param {number} dt seconds
   * @param {number} face cos(dial normal, dial→eye)
   * @param {number} gaze cos(view forward, eye→dial)
   * @param {number} d eye–dial distance (m)
   * @returns {number} +1 woke, −1 slept, 0 no change
   */
  update(dt, face, gaze, d) {
    const W = WATCH.wake;
    if (!this.awake) {
      if (face >= W.faceOn && gaze >= W.gazeOn && d <= W.maxOn) {
        this.t += dt;
        if (this.t >= W.onS) { this.awake = true; this.t = 0; return 1; }
      } else this.t = 0;
    } else if (face < W.faceOff || gaze < W.gazeOff || d > W.maxOff || !(d === d)) {
      this.t += dt;
      if (this.t >= W.offS) { this.awake = false; this.t = 0; return -1; }
    } else this.t = 0;
    return 0;
  }
}

// ── touch gates ──────────────────────────────────────────────────────────────

/**
 * A tap on a disc from the front: fires once when an armed tip enters the
 * zone (r < R, zMin < z < Z), re-arms once it leaves far enough (r > rearmR
 * or z > rearmZ). Starts disarmed, and a tip that enters while the gate may
 * not fire (asleep, right hand busy) is disarmed too, so a tip already resting
 * on the dial when the watch wakes never fires by itself.
 */
export class TapGate {
  /** @param {{ r: number, zMin: number, z: number, rearmR: number, rearmZ: number }} [o] */
  constructor(o = WATCH.tap) {
    this.R = o.r; this.zMin = o.zMin; this.Z = o.z; this.rearmR = o.rearmR; this.rearmZ = o.rearmZ;
    this.armed = false;
  }

  /**
   * @param {number} x @param {number} y @param {number} z tip in the disc frame (m)
   * @param {boolean} enabled may it fire now
   * @returns {boolean} a tap this frame
   */
  update(x, y, z, enabled) {
    const r = Math.sqrt(x * x + y * y);
    if (!this.armed) {
      if (r > this.rearmR || z > this.rearmZ || !(z === z)) this.armed = true;
      return false;
    }
    const inZone = r < this.R && z > this.zMin && z < this.Z;
    // a tip resting on the dial while it may not fire (asleep, hand busy) must leave and come back
    if (inZone) { this.armed = false; return enabled; }
    return false;
  }

  disarm() { this.armed = false; }
}

/** Menu touch result codes. */
export const PRESS = Object.freeze({ NONE: 0, HOVER: 1, PRESS: 2 });

/**
 * Touch on the menu disc (CQC terminal values): hover while inside and
 * z < hoverZ; press when armed, inside and z < pressZ; re-arm when outside
 * or z > rearmZ. Starts disarmed (a tip that is already pushed in never presses).
 */
export class PressGate {
  /** @param {{ hoverZ: number, pressZ: number, rearmZ: number, behindZ: number }} [o] */
  constructor(o = WATCH.menu) {
    this.hoverZ = o.hoverZ; this.pressZ = o.pressZ; this.rearmZ = o.rearmZ; this.behindZ = o.behindZ;
    this.armed = false;
  }

  /**
   * @param {boolean} inside the tip is over the disc
   * @param {number} z height above the disc (m)
   * @returns {number} PRESS code
   */
  update(inside, z) {
    const near = inside && z < this.hoverZ && z > this.behindZ;
    if (!this.armed) {
      if (!inside || z > this.rearmZ || !(z === z)) this.armed = true;
      return near ? PRESS.HOVER : PRESS.NONE;
    }
    if (near && z < this.pressZ) { this.armed = false; return PRESS.PRESS; }
    return near ? PRESS.HOVER : PRESS.NONE;
  }

  disarm() { this.armed = false; }
}

/** Two taps on the same row within `confirmS` seconds (RESTART, EXIT, RESET). */
export class Confirm {
  /** @param {number} [s] */
  constructor(s = WATCH.confirmS) { this.s = s; this.key = -1; this.until = 0; }

  /**
   * @param {number} key row id @param {number} now seconds
   * @returns {boolean} confirmed (second tap in time)
   */
  tap(key, now) {
    if (this.key === key && now <= this.until) { this.key = -1; return true; }
    this.key = key;
    this.until = now + this.s;
    return false;
  }

  /** @param {number} key @param {number} now */
  pending(key, now) { return this.key === key && now <= this.until; }

  clear() { this.key = -1; }
}

// ── time ─────────────────────────────────────────────────────────────────────

/**
 * Hand angles for the local time, in radians, clockwise = negative (three's
 * rotation about +Z). Seconds sweep in 8 beats per second (CQC: 28,800 vph).
 * @param {number} ms epoch milliseconds (Date.now())
 * @param {number} tzMin Date#getTimezoneOffset() (minutes, UTC − local)
 * @param {Float32Array|number[]} out [hour, minute, second]
 */
export function handAngles(ms, tzMin, out) {
  const local = ms - tzMin * 60000;
  const h = pmod(local / 3600000, 12) / 12;
  const m = pmod(local / 60000, 60) / 60;
  const s = pmod(Math.floor(local / 125) / 8, 60) / 60;
  out[0] = -2 * Math.PI * h;
  out[1] = -2 * Math.PI * m;
  out[2] = -2 * Math.PI * s;
  return out;
}

/** @param {number} a @param {number} n */
function pmod(a, n) { const r = a % n; return r < 0 ? r + n : r; }

// ── bezel ────────────────────────────────────────────────────────────────────

/** Clicks per turn of the unidirectional bezel. */
export const BEZEL_CLICKS = 120;

/**
 * The dive bezel turns counter-clockwise only, in 1/120-turn clicks. At a
 * wave start it turns so the lume pip meets the minute hand (elapsed time
 * then reads on the bezel), animated over `dur` seconds.
 */
export class BezelTurn {
  constructor(dur = 0.35) {
    this.dur = dur;
    /** Current position in clicks (CCW, may be fractional while turning). */
    this.pos = 0;
    this.from = 0;
    this.to = 0;
    this.t = -1;
    this._heard = 0;
  }

  /**
   * Start turning so the pip points at `minuteFrac` (0 = 12, clockwise).
   * @param {number} minuteFrac 0..1
   * @returns {number} clicks to turn (0 = already there)
   */
  alignTo(minuteFrac) {
    const k = Math.round(pmod(minuteFrac, 1) * BEZEL_CLICKS) % BEZEL_CLICKS;
    const target = (BEZEL_CLICKS - k) % BEZEL_CLICKS;
    // `to` is always a whole click (the last target); a turn in progress continues from where it is
    const delta = pmod(target - pmod(this.to, BEZEL_CLICKS), BEZEL_CLICKS);
    if (delta === 0) return 0;
    this.from = this.pos;
    this.to += delta;
    this.t = 0;
    this._heard = Math.floor(this.from + 1e-6);
    return delta;
  }

  /**
   * @param {number} dt
   * @returns {number} clicks passed this frame (for the click sound)
   */
  update(dt) {
    if (this.t < 0) return 0;
    this.t += dt;
    const u = this.t >= this.dur ? 1 : this.t / this.dur;
    const e = u * u * (3 - 2 * u);
    this.pos = this.from + (this.to - this.from) * e;
    const now = Math.floor(this.pos + 1e-6);
    const n = now - this._heard;
    this._heard = now;
    if (u >= 1) {
      this.t = -1;
      // keep the numbers small
      const wrap = Math.floor(this.to / BEZEL_CLICKS) * BEZEL_CLICKS;
      this.pos -= wrap; this.to -= wrap; this.from -= wrap; this._heard -= wrap;
    }
    return n > 0 ? n : 0;
  }

  /** Bezel rotation about +Z (radians, CCW positive). */
  get angle() { return (2 * Math.PI * this.pos) / BEZEL_CLICKS; }

  /** Where the pip points, clockwise from 12, in turns. */
  get pipTurn() { return pmod(-this.pos, BEZEL_CLICKS) / BEZEL_CLICKS; }
}

// ── warnings (diegetic: the watch vibrates and shows a small icon) ───────────

/** Warning kinds, lowest priority first. */
export const WARN = Object.freeze({ RUN: 0, EDGE: 1, OBSTACLE: 2, STAIRS: 3, TRACKING: 4 });
export const WARN_NAMES = Object.freeze(['run', 'edge', 'obstacle', 'stairs', 'tracking']);
/** Short words for the dial's info line. */
export const WARN_WORDS = Object.freeze(['SLOW', 'EDGE', 'WALL', 'STAIRS', 'TRACK']);
const N_WARN = 5;

/**
 * Pulse patterns on the left (watch) hand: [offset s, amplitude, ms] per
 * pulse, repeated every `period` s. The obstacle period shrinks with the level
 * like a parking sensor; others scale their amplitude with it.
 */
const PATTERN = Object.freeze([
  Object.freeze({ period: 1.6, pulses: Object.freeze([0, 0.45, 25, 0.14, 0.45, 25]) }),          // run: da-da
  Object.freeze({ period: 2.2, pulses: Object.freeze([0, 0.35, 18, 0.11, 0.35, 18, 0.22, 0.35, 18]) }), // edge: da-da-da
  Object.freeze({ period: 1.2, pulses: Object.freeze([0, 1, 14]) }),                               // obstacle: ticks
  Object.freeze({ period: 2.0, pulses: Object.freeze([0, 0.6, 60, 0.25, 0.6, 60]) }),             // stairs: two long
  Object.freeze({ period: 3.0, pulses: Object.freeze([0, 0.7, 90]) }),                             // tracking: one long
]);

/** @param {string|number} kind */
export function warnCode(kind) {
  if (typeof kind === 'number') return kind >= 0 && kind < N_WARN ? kind | 0 : -1;
  switch (kind) {
    case 'run': case 'running': return WARN.RUN;
    case 'edge': return WARN.EDGE;
    case 'obstacle': case 'wall': return WARN.OBSTACLE;
    case 'stairs': return WARN.STAIRS;
    case 'tracking': return WARN.TRACKING;
    default: return -1;
  }
}

/**
 * Active warnings and their vibration schedule. One pattern plays at a time:
 * the highest-priority active kind. Allocation-free.
 */
export class WarnPlan {
  constructor() {
    this.levels = new Float32Array(N_WARN);
    this.top = -1;
    this.t = 0;
    this.i = 0;
    /** The pulse due this frame (amplitude 0..1, ms). */
    this.amp = 0;
    this.ms = 0;
  }

  /** @param {string|number} kind @param {number} level 0 clears, up to 1 */
  set(kind, level) {
    const k = warnCode(kind);
    if (k < 0) return false;
    this.levels[k] = level > 0 ? (level > 1 ? 1 : level) : 0;
    return true;
  }

  clear() { this.levels.fill(0); this.top = -1; }

  /** The highest-priority active kind, or −1. */
  pick() {
    for (let k = N_WARN - 1; k >= 0; k--) if (this.levels[k] > 0) return k;
    return -1;
  }

  /** Level of the top warning (0 when none). */
  get level() { return this.top >= 0 ? this.levels[this.top] : 0; }

  /**
   * @param {number} dt
   * @returns {boolean} a pulse is due now (see `amp`, `ms`)
   */
  update(dt) {
    this.amp = 0;
    this.ms = 0;
    const k = this.pick();
    if (k !== this.top) { this.top = k; this.t = 0; this.i = 0; }
    if (k < 0) return false;
    const P = PATTERN[k], L = this.levels[k];
    const period = k === WARN.OBSTACLE ? Math.max(0.25, 1.2 - 0.95 * L) : P.period;
    const p = P.pulses;
    let due = false;
    if (this.i * 3 < p.length && this.t >= p[this.i * 3]) {
      const a = p[this.i * 3 + 1];
      this.amp = k === WARN.OBSTACLE ? 0.2 + 0.5 * L : a * (0.5 + 0.5 * L);
      this.ms = p[this.i * 3 + 2];
      this.i++;
      due = true;
    }
    this.t += dt;
    if (this.t >= period) { this.t -= period; this.i = 0; }
    return due;
  }
}

// ── menu layout (canvas pixels on the 512 px disc; 512 px = 0.16 m) ─────────

export const PAGE = Object.freeze({ MAIN: 0, FIT: 1 });

/** Row ids (stable numbers for the confirm gate and tests). */
export const ROW = Object.freeze({
  RESUME: 0, RESTART: 1, DIFFICULTY: 2, MODE: 3, FIT: 4, AMMO: 5, EXIT: 6,
  GUN: 7, PITCH: 8, HEIGHT: 9, FORWARD: 10, SAVE: 11, RESET: 12, BACK: 13,
});
export const ROW_NAMES = Object.freeze(['resume', 'restart', 'difficulty', 'mode', 'fit', 'ammo', 'exit',
  'gun', 'pitch', 'height', 'forward', 'save', 'reset', 'back']);
export const PAGE_ROWS = Object.freeze([
  Object.freeze([ROW.RESUME, ROW.RESTART, ROW.DIFFICULTY, ROW.MODE, ROW.FIT, ROW.AMMO, ROW.EXIT]),
  Object.freeze([ROW.GUN, ROW.PITCH, ROW.HEIGHT, ROW.FORWARD, ROW.SAVE, ROW.RESET, ROW.BACK]),
]);
/** Rows with − / + zones at their ends. */
export const isValueRow = (/** @type {number} */ row) => row === ROW.PITCH || row === ROW.HEIGHT || row === ROW.FORWARD;
/** Rows that need a second tap within `confirmS`. */
export const needsConfirm = (/** @type {number} */ row) => row === ROW.RESTART || row === ROW.EXIT || row === ROW.RESET;

export const MENU_PX = Object.freeze({ size: 512, c: 256, r: 256, inner: 230, rowY0: 128, rowPitch: 46, rowH: 40, pad: 14 });

/**
 * A row's pill in canvas px: the widest rectangle inside the inner radius at
 * the row's outer edge, minus a margin.
 * @param {number} i row index on the page (0..6)
 * @param {{ x0: number, x1: number, y0: number, y1: number }} out
 */
export function rowRect(i, out) {
  const M = MENU_PX;
  const y0 = M.rowY0 + i * M.rowPitch, y1 = y0 + M.rowH;
  const dy = Math.max(Math.abs(y0 - M.c), Math.abs(y1 - M.c));
  const half = Math.sqrt(Math.max(0, M.inner * M.inner - dy * dy)) - M.pad;
  out.x0 = M.c - half; out.x1 = M.c + half; out.y0 = y0; out.y1 = y1;
  return out;
}

const _r = { x0: 0, x1: 0, y0: 0, y1: 0 };

/**
 * Which row is under a canvas point.
 * @param {number} page PAGE
 * @param {number} px @param {number} py canvas px (y down)
 * @param {{ row: number, index: number, zone: number }} out zone −1 = minus end, +1 = plus end, 0 = middle
 * @returns {number} row id or −1
 */
export function hitMenu(page, px, py, out) {
  out.row = -1; out.index = -1; out.zone = 0;
  const rows = PAGE_ROWS[page] || PAGE_ROWS[0];
  for (let i = 0; i < rows.length; i++) {
    rowRect(i, _r);
    if (py < _r.y0 - 3 || py > _r.y1 + 3 || px < _r.x0 || px > _r.x1) continue;
    out.row = rows[i];
    out.index = i;
    if (isValueRow(rows[i])) {
      const w = _r.x1 - _r.x0;
      out.zone = px < _r.x0 + w * 0.28 ? -1 : px > _r.x1 - w * 0.28 ? 1 : 0;
    }
    return out.row;
  }
  return -1;
}

// ── gun fit edit (the FIT page) ──────────────────────────────────────────────

export const FIT_WEAPONS = Object.freeze(['glock', 'akm']);
/** Fields in edit order: pitch (deg), height (m, + = up), forward (m, + = toward the muzzle). */
export const FIT_FIELD = Object.freeze({ PITCH: 0, UP: 1, FWD: 2 });

/**
 * Gun-fit values per weapon, edited live by the right stick or − / + taps;
 * SAVE keeps them, BACK reverts to the last saved. Allocation-free after
 * construction; `out` is the one reused object handed to `onAction`.
 */
export class FitEdit {
  constructor() {
    /** Current values [pitchDeg, up, fwd] per weapon. */
    this.cur = [new Float64Array(3), new Float64Array(3)];
    /** Last saved (or set from outside) per weapon. */
    this.saved = [new Float64Array(3), new Float64Array(3)];
    this.weapon = 0;
    /** The field the stick edits (FIT_FIELD). */
    this.field = FIT_FIELD.PITCH;
    this.out = { weapon: 'glock', pitchDeg: 0, up: 0, fwd: 0 };
    this._tick = new Float64Array(3);
  }

  /**
   * Values from outside (settings): both current and saved.
   * @param {string|number} weapon @param {number} pitchDeg @param {number} up @param {number} fwd
   */
  set(weapon, pitchDeg, up, fwd) {
    const w = weaponIndex(weapon);
    if (w < 0) return false;
    const c = this.cur[w], s = this.saved[w];
    c[0] = s[0] = clamp(num(pitchDeg, 0), WATCH.fitLimits.pitchDeg);
    c[1] = s[1] = clamp(num(up, 0), WATCH.fitLimits.up);
    c[2] = s[2] = clamp(num(fwd, 0), WATCH.fitLimits.fwd);
    return true;
  }

  /** @param {string|number} weapon */
  select(weapon) { const w = weaponIndex(weapon); if (w >= 0) this.weapon = w; return this.weapon; }

  /** Is the weapon's current value different from the saved one? @param {number} w */
  dirty(w) {
    const c = this.cur[w], s = this.saved[w];
    return c[0] !== s[0] || c[1] !== s[1] || c[2] !== s[2];
  }

  /**
   * Right stick on the selected field. Dead zone, then a cubic response.
   * @param {number} dt @param {number} sy stick y (−1 = pushed up)
   * @returns {number} 0 no change, 1 changed, 2 changed and crossed a tick step (haptic)
   */
  stick(dt, sy) {
    const R = WATCH.fitRates;
    const v = -sy, a = Math.abs(v);
    if (!(a > R.dead)) return 0;
    const u = (a - R.dead) / (1 - R.dead);
    const resp = Math.sign(v) * u * u * u;
    const f = this.field;
    const rate = f === FIT_FIELD.PITCH ? R.pitchDegS : R.mS;
    return this.add(f, resp * rate * dt);
  }

  /**
   * One − / + tap: 0.5° or 1 mm.
   * @param {number} field FIT_FIELD @param {number} dir −1 / +1
   */
  nudge(field, dir) {
    const R = WATCH.fitRates;
    this.field = field;
    return this.add(field, dir * (field === FIT_FIELD.PITCH ? R.stepDeg : R.stepM));
  }

  /**
   * @param {number} field @param {number} d
   * @returns {number} see stick()
   */
  add(field, d) {
    const L = WATCH.fitLimits, R = WATCH.fitRates;
    const c = this.cur[this.weapon];
    const lim = field === FIT_FIELD.PITCH ? L.pitchDeg : field === FIT_FIELD.UP ? L.up : L.fwd;
    const before = c[field];
    const after = clamp(before + d, lim);
    if (after === before) return 0;
    c[field] = Math.round(after * 1e6) / 1e6;
    const step = field === FIT_FIELD.PITCH ? R.tickDeg : R.tickM;
    return Math.floor(before / step + 1e-9) !== Math.floor(c[field] / step + 1e-9) ? 2 : 1;
  }

  /** Current weapon back to zero (live; SAVE keeps it). */
  reset() { this.cur[this.weapon].fill(0); }

  /** Keep the current values of both weapons. @returns {number} bitmask of weapons that changed */
  save() {
    let m = 0;
    for (let w = 0; w < 2; w++) { if (this.dirty(w)) m |= 1 << w; this.saved[w].set(this.cur[w]); }
    return m;
  }

  /** Back to the saved values. @returns {number} bitmask of weapons that changed */
  revert() {
    let m = 0;
    for (let w = 0; w < 2; w++) { if (this.dirty(w)) m |= 1 << w; this.cur[w].set(this.saved[w]); }
    return m;
  }

  /** Fill and return the reused `out` for a weapon (default: the selected one). @param {number} [w] */
  values(w = this.weapon) {
    const c = this.cur[w], o = this.out;
    o.weapon = FIT_WEAPONS[w];
    o.pitchDeg = c[0];
    o.up = c[1];
    o.fwd = c[2];
    return o;
  }
}

/** @param {string|number} w */
export function weaponIndex(w) {
  if (w === 0 || w === 'glock' || w === 'g17') return 0;
  if (w === 1 || w === 'akm') return 1;
  return -1;
}

/** @param {number} v @param {number} lim */
function clamp(v, lim) { return v > lim ? lim : v < -lim ? -lim : v; }

// ── status codes (what the dial shows) ───────────────────────────────────────

/** Round state codes on the dial. */
export const STATE = Object.freeze({ NONE: 0, READY: 1, WAVE: 2, BREAK: 3, PAUSED: 4, DOWN: 5, SCAN: 6, SPOT: 7 });

/** @param {unknown} s a state name (GameSession.phaseName or the integrator's) */
export function stateCode(s) {
  switch (s) {
    case 'ready': return STATE.READY;
    case 'wave': return STATE.WAVE;
    case 'break': return STATE.BREAK;
    case 'paused': return STATE.PAUSED;
    case 'over': case 'down': return STATE.DOWN;
    case 'scan': return STATE.SCAN;
    case 'spot': return STATE.SPOT;
    default: return STATE.NONE;
  }
}

/** Fire mode codes: 0 none, 1 SAFE, 2 SEMI, 3 AUTO. @param {unknown} m */
export function modeCode(m) { return m === 'safe' ? 1 : m === 'semi' ? 2 : m === 'auto' ? 3 : 0; }

/** What the dial's bottom line shows, in priority order. */
export const INFO = Object.freeze({ NONE: 0, WARN: 1, STATE: 2, SCAN: 3, HINT: 4, KILLS: 5 });

/**
 * @param {number} warn top warning kind or −1
 * @param {number} state STATE
 * @param {boolean} scanning
 * @param {boolean} hint awake with a free right hand
 */
export function infoCode(warn, state, scanning, hint) {
  if (warn >= 0) return INFO.WARN;
  if (state === STATE.PAUSED || state === STATE.DOWN || state === STATE.BREAK || state === STATE.READY) return INFO.STATE;
  if (scanning) return INFO.SCAN;
  if (hint) return INFO.HINT;
  if (state === STATE.WAVE) return INFO.KILLS;
  return INFO.NONE;
}

// ── tick sound (synthesised once at load) ────────────────────────────────────

/**
 * A short square-wave watch tick: f falling to 0.92 f with an exponential
 * decay (research-cqc C5). Pure, for AudioBuffer channel data.
 * @param {number} sampleRate @param {number} [freq] @param {number} [ms] @param {number} [peak]
 * @returns {Float32Array}
 */
export function synthTick(sampleRate, freq = 2000, ms = 20, peak = 0.35) {
  const n = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = freq * (1 - 0.08 * u);
    ph += f / sampleRate;
    const sq = (ph % 1) < 0.5 ? 1 : -1;
    const env = Math.exp(-5 * u) * (i < 24 ? i / 24 : 1);
    out[i] = sq * env * peak;
  }
  return out;
}

/**
 * Two soft beeps (a dive computer's alarm, kept quiet): sine at `freq`,
 * 70 ms each, 90 ms apart.
 * @param {number} sampleRate @param {number} [freq] @param {number} [peak]
 */
export function synthAlert(sampleRate, freq = 2900, peak = 0.22) {
  const beep = 0.07, gap = 0.09;
  const n = Math.round(sampleRate * (beep * 2 + gap));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const local = t < beep ? t : t >= beep + gap ? t - beep - gap : -1;
    if (local < 0) continue;
    const a = Math.min(1, local / 0.006, (beep - local) / 0.012);
    out[i] = Math.sin(2 * Math.PI * freq * t) * a * peak;
  }
  return out;
}

// ── number strings (cached: nothing is formatted while drawing) ─────────────

const NUMS = /** @type {string[]} */ ([]);
for (let i = 0; i < 1000; i++) NUMS.push(String(i));
/** Integer 0..999 as a cached string. @param {number} n */
export const numStr = (n) => NUMS[n < 0 ? 0 : n > 999 ? 999 : n | 0];

const DEG_STR = /** @type {string[]} */ ([]);
for (let i = -80; i <= 80; i++) DEG_STR.push(`${i > 0 ? '+' : i < 0 ? '−' : ''}${(Math.abs(i) / 2).toFixed(1)}°`);
/** Degrees rounded to 0.5°, ±40°. @param {number} d */
export const degStr = (d) => DEG_STR[Math.max(-80, Math.min(80, Math.round(d * 2))) + 80];

const MM_STR = /** @type {string[]} */ ([]);
for (let i = -80; i <= 80; i++) MM_STR.push(`${i > 0 ? '+' : i < 0 ? '−' : ''}${Math.abs(i)} mm`);
/** Metres as whole millimetres, ±80 mm. @param {number} m */
export const mmStr = (m) => MM_STR[Math.max(-80, Math.min(80, Math.round(m * 1000))) + 80];
