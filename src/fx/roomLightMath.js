// @ts-check
/**
 * Room-light matching, pure maths (no three.js, no DOM; Node-tested, and the
 * camera worker imports it). research-look §1 / R3, R9, R11.
 *
 * Three ways to estimate the room, best first; every one ends in the same
 * TARGET record, which only ever drives the FIXED light set's intensities and
 * colours (never the light count), the environment intensity and the shared
 * passthrough-match uniform (black lift, grain):
 *
 * 1. **Camera (opt-in).** A tiny camera frame (32 × 24) is reduced in a worker
 *    to ~15 numbers (`frameStats`); `targetsFromStats` maps them. The Quest's
 *    camera stream is auto-exposed and white-balanced like the passthrough the
 *    player sees, so its mean level and tint describe what the passthrough
 *    LOOKS like (which is what the virtual objects must match), not the
 *    absolute lux. Untested on the Quest (research T2/T3).
 * 2. **Auto per room** (no camera): local time of day and whether the room has a
 *    window in Space Setup (`presetTargets(LEVEL_AUTO, WARM_AUTO, …)`).
 * 3. **Manual per room**: dim / normal / bright × warm / neutral / cool, saved
 *    per house and room (`parseRoomLight` / `serializeRoomLight`).
 *
 * `LightSmoother` eases toward a target in log space (brightening faster than
 * darkening, colour slowest) with a 4 % dead band, so lights never pump.
 * Everything here is allocation-free after construction (typed-array outputs).
 */

/** Tunables (estimates to check on the headset are marked T3). */
export const RL = Object.freeze({
  /** Mean linear luminance of an auto-exposed camera frame of a normally lit room (T3). */
  yRef: 0.16,
  eMin: 0.3, eMax: 1.8,
  /** White balance: each channel within ±15 % of the mean. */
  wbClamp: 0.15,
  /** Black lift = blackK × sRGB(p5), at most blackMax (research R3/R9). */
  blackK: 0.8, blackMax: 0.1,
  /** Grain amplitude = grainK × (grainRefY / Y − 1), 0..grainMax (research R9). */
  grainK: 0.012, grainRefY: 0.18, grainMax: 0.03,
  /** Pixels darker than this (linear) are left out of the colour means; brighter than `clip` count as clipped. */
  nearBlack: 0.004, clip: 0.95,
  /** Smoothing (s): brightening, darkening, colour, black / grain / key. */
  tauUp: 1.0, tauDown: 2.5, tauColour: 6, tauMisc: 2.5,
  /** Target changes smaller than this (relative) are ignored. */
  deadBand: 0.04,
  /** Camera samples are skipped while the head turns faster, looks further up, or too much is clipped. */
  maxTurnDegS: 30, maxPitchUpDeg: 35, maxClipped: 0.2,
  /** Camera sample period (ms). */
  sampleMs: 2000,
});

/** frameStats output layout. */
export const ST = Object.freeze({
  R: 0, G: 1, B: 2,            // mean linear RGB (clipped and near-black pixels left out)
  P5: 3, P50: 4, P95: 5,       // luminance percentiles (linear)
  TR: 6, TG: 7, TB: 8,         // mean linear RGB of the brightest 10 %
  CLIPPED: 9,                  // fraction of clipped pixels
  CU: 10, CV: 11,              // centroid of the brightest 10 % (0..1, image u right, v down)
  Y: 12,                       // mean linear luminance of every pixel
  N: 13,                       // pixels in the colour means
  VALID: 14,
});
export const STATS_LEN = 15;

/** Target record layout (what every estimate produces). */
export const T = Object.freeze({
  E: 0,                        // room level relative to a normal room (1)
  WR: 1, WG: 2, WB: 3,         // white balance (luminance-normalised, ≈ 1)
  BLACK: 4,                    // black lift (sRGB, 0..0.1)
  GRAIN: 5,                    // grain amplitude (sRGB, 0..0.03)
  KEY: 6,                      // key (directional) strength relative to normal (0.5..1.5)
});
export const TARGET_LEN = 7;

/** Light levels layout (`lightLevels`). */
export const LV = Object.freeze({
  HEMI: 0, SUN: 1, ENV: 2,
  SKY: 3, GROUND: 6, SUNC: 9,  // linear RGB triples
  ROOM: 12,                    // sRGB multiplier for unlit effects (decals, puffs, dust): E·w encoded
  BLACK: 15, GRAIN: 16,
});
export const LEVELS_LEN = 17;

export const LEVELS = Object.freeze(['auto', 'dim', 'normal', 'bright']);
export const WARMTHS = Object.freeze(['auto', 'warm', 'neutral', 'cool']);
export const LEVEL_AUTO = 0, LEVEL_DIM = 1, LEVEL_NORMAL = 2, LEVEL_BRIGHT = 3;
export const WARM_AUTO = 0, WARM_WARM = 1, WARM_NEUTRAL = 2, WARM_COOL = 3;
const LEVEL_E = [1, 0.62, 1, 1.32];
/** White balance of a warm lamp, neutral, cool daylight (linear multipliers before normalising). */
const WB = [[1, 1, 1], [1.1, 1.0, 0.84], [1, 1, 1], [0.94, 1.0, 1.1]];
/**
 * The automatic guess at night: lamps are warm, but the passthrough's own
 * white balance takes out part of it, so only about half the manual "warm".
 */
const WB_AUTO_NIGHT = [1.05, 1.0, 0.91];

/** sRGB byte → linear (exact IEC 61966-2-1). */
export const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** @param {number} x linear 0..1 @returns {number} sRGB 0..1 */
export function linearToSrgb(x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** @param {number} x @param {number} a @param {number} b */
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Reduce one small RGBA frame (sRGB bytes, e.g. 32 × 24) to the stats record.
 * Percentiles come from a 256-bin histogram of the sRGB luma byte (Rec. 709
 * weights on the bytes, then linearised), which is plenty at this size.
 * @param {ArrayLike<number>} rgba
 * @param {number} w @param {number} h
 * @param {Float64Array} out STATS_LEN
 * @param {Uint32Array} hist 256 bins (scratch)
 * @returns {Float64Array} out
 */
export function frameStats(rgba, w, h, out, hist) {
  const n = w * h;
  out.fill(0);
  if (!(n > 0) || rgba.length < n * 4) return out;
  hist.fill(0);
  const L = SRGB_TO_LINEAR;
  let sr = 0, sg = 0, sb = 0, used = 0, clipped = 0, sy = 0;
  const clipB = Math.round(linearToSrgb(RL.clip) * 255);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r8 = rgba[o], g8 = rgba[o + 1], b8 = rgba[o + 2];
    const l8 = (54 * r8 + 183 * g8 + 19 * b8 + 128) >> 8;
    hist[l8 > 255 ? 255 : l8]++;
    const r = L[r8], g = L[g8], b = L[b8];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sy += y;
    if (r8 >= clipB || g8 >= clipB || b8 >= clipB) { clipped++; continue; }
    if (y < RL.nearBlack) continue;
    sr += r; sg += g; sb += b; used++;
  }
  // percentiles
  const k5 = n * 0.05, k50 = n * 0.5, k90 = n * 0.9, k95 = n * 0.95;
  let acc = 0, p5 = -1, p50 = -1, p90 = -1, p95 = -1;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (p5 < 0 && acc > k5) p5 = b;
    if (p50 < 0 && acc > k50) p50 = b;
    if (p90 < 0 && acc > k90) p90 = b;
    if (p95 < 0 && acc > k95) { p95 = b; break; }
  }
  if (p95 < 0) p95 = 255;
  if (p90 < 0) p90 = p95;
  // ties: when a flat wall fills the p90 bin, the brightest pixels are the ones above it
  let above = 0;
  for (let b = p90 + 1; b < 256; b++) above += hist[b];
  const cut = above >= n * 0.01 && above < n * 0.1 ? p90 + 1 : p90;
  // the brightest 10 %: mean colour and centroid
  let tr = 0, tg = 0, tb = 0, tn = 0, cu = 0, cv = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r8 = rgba[o], g8 = rgba[o + 1], b8 = rgba[o + 2];
    const l8 = (54 * r8 + 183 * g8 + 19 * b8 + 128) >> 8;
    if (l8 < cut) continue;
    tr += L[r8]; tg += L[g8]; tb += L[b8]; tn++;
    cu += ((i % w) + 0.5) / w; cv += (((i / w) | 0) + 0.5) / h;
  }
  out[ST.R] = used > 0 ? sr / used : 0;
  out[ST.G] = used > 0 ? sg / used : 0;
  out[ST.B] = used > 0 ? sb / used : 0;
  out[ST.P5] = L[p5 < 0 ? 0 : p5];
  out[ST.P50] = L[p50 < 0 ? 0 : p50];
  out[ST.P95] = L[p95];
  out[ST.TR] = tn > 0 ? tr / tn : 0;
  out[ST.TG] = tn > 0 ? tg / tn : 0;
  out[ST.TB] = tn > 0 ? tb / tn : 0;
  out[ST.CLIPPED] = clipped / n;
  out[ST.CU] = tn > 0 ? cu / tn : 0.5;
  out[ST.CV] = tn > 0 ? cv / tn : 0.5;
  out[ST.Y] = sy / n;
  out[ST.N] = used;
  out[ST.VALID] = used >= n * 0.25 ? 1 : 0;
  return out;
}

/**
 * Is a camera sample usable? (Turning fast smears the frame and the exposure
 * lags; looking up at a ceiling lamp or a frame mostly clipped says little
 * about the room.)
 * @param {number} turnDegS head yaw rate @param {number} pitchDeg + up @param {number} clippedFrac
 */
export function sampleOk(turnDegS, pitchDeg, clippedFrac) {
  return Math.abs(turnDegS) <= RL.maxTurnDegS && pitchDeg <= RL.maxPitchUpDeg && clippedFrac <= RL.maxClipped;
}

/**
 * Normalise a white balance in place: channels within ±wbClamp of their mean,
 * then luminance 1.
 * @param {Float64Array} out @param {number} o offset of r, g, b
 */
function normaliseWB(out, o) {
  let m = (out[o] + out[o + 1] + out[o + 2]) / 3;
  if (!(m > 1e-9)) { out[o] = out[o + 1] = out[o + 2] = 1; return; }
  for (let c = 0; c < 3; c++) out[o + c] = clamp(out[o + c] / m, 1 - RL.wbClamp, 1 + RL.wbClamp);
  m = 0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2];
  for (let c = 0; c < 3; c++) out[o + c] /= m;
}

/**
 * Camera stats → target. `trim` is the player's per-room brightness trim (1 =
 * none; ±30 %).
 * @param {Float64Array} s STATS
 * @param {number} trim
 * @param {Float64Array} out TARGET_LEN
 * @returns {boolean} false when the stats are not valid (out untouched)
 */
export function targetsFromStats(s, trim, out) {
  if (!(s[ST.VALID] > 0)) return false;
  const y = s[ST.Y];
  const k = Number.isFinite(trim) ? clamp(trim, 0.7, 1.3) : 1;
  out[T.E] = clamp((y / RL.yRef) * k, RL.eMin, RL.eMax);
  // white balance: half grey world, half the brightest 10 % (the light sources and what they hit)
  const gm = (s[ST.R] + s[ST.G] + s[ST.B]) / 3 || 1, tm = (s[ST.TR] + s[ST.TG] + s[ST.TB]) / 3 || gm;
  out[T.WR] = 0.5 * s[ST.R] / gm + 0.5 * (s[ST.TR] || s[ST.R]) / tm;
  out[T.WG] = 0.5 * s[ST.G] / gm + 0.5 * (s[ST.TG] || s[ST.G]) / tm;
  out[T.WB] = 0.5 * s[ST.B] / gm + 0.5 * (s[ST.TB] || s[ST.B]) / tm;
  normaliseWB(out, T.WR);
  out[T.BLACK] = clamp(RL.blackK * linearToSrgb(s[ST.P5]), 0, RL.blackMax);
  out[T.GRAIN] = clamp(RL.grainK * (RL.grainRefY / Math.max(y, 0.01) - 1), 0, RL.grainMax);
  // contrast between the bright and the median part: a lamp or a window gives a strong key
  const c = s[ST.P95] / Math.max(s[ST.P50], 1e-4);
  out[T.KEY] = clamp(0.5 + 0.25 * Math.log2(Math.max(c, 1)), 0.5, 1.5);
  return true;
}

/** @param {number} a @param {number} b @param {number} x */
function ss(a, b, x) {
  const t = (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Daylight factor by the local time: 1 between 9:00 and 17:00, 0 between
 * 20:00 and 6:00, a smooth ramp in between.
 * @param {number} minute minute of the day (0..1439; wraps)
 */
export function daylight(minute) {
  const h = Number.isFinite(minute) ? ((((minute / 60) % 24) + 24) % 24) : 12;
  return h < 12 ? ss(6, 9, h) : 1 - ss(17, 20, h);
}

/**
 * The no-camera estimate for a room: a manual level / warmth, or the automatic
 * guess from the local time and a window in the room (rooms with a window are
 * brighter and cooler by day; at night every room is lamp-lit and warm).
 * @param {number} level LEVEL_* @param {number} warmth WARM_*
 * @param {number} minute local minute of the day (an integer: no double crosses the call)
 * @param {boolean} hasWindow
 * @param {Float64Array} out TARGET_LEN
 * @returns {Float64Array} out
 */
export function presetTargets(level, warmth, minute, hasWindow, out) {
  const d = daylight(minute);
  const lv = level >= 0 && level < LEVEL_E.length ? level : LEVEL_AUTO;
  const wm = warmth >= 0 && warmth < WB.length ? warmth : WARM_AUTO;
  // the passthrough is auto-exposed: a lamp-lit room does not look much darker than daylight,
  // it looks warmer and noisier; a window by day adds a little level and a stronger key
  const eAuto = hasWindow ? 0.9 + 0.25 * d : 0.92 + 0.08 * d;
  const E = lv === LEVEL_AUTO ? eAuto : LEVEL_E[lv];
  out[T.E] = clamp(E, RL.eMin, RL.eMax);
  if (wm === WARM_AUTO) {
    // night: warm lamps; day: neutral-warm without a window, a little cool with one
    const day = hasWindow ? WB[WARM_COOL] : WB[WARM_NEUTRAL];
    const night = WB_AUTO_NIGHT;
    const kd = hasWindow ? d : d * 0.6;
    out[T.WR] = night[0] + (day[0] - night[0]) * kd;
    out[T.WG] = night[1] + (day[1] - night[1]) * kd;
    out[T.WB] = night[2] + (day[2] - night[2]) * kd;
  } else {
    out[T.WR] = WB[wm][0]; out[T.WG] = WB[wm][1]; out[T.WB] = WB[wm][2];
  }
  normaliseWB(out, T.WR);
  // a dim room's passthrough has lifted, noisy blacks
  const inv = 1 / out[T.E];
  out[T.BLACK] = clamp(0.02 + 0.025 * (inv - 1), 0.01, 0.06);
  out[T.GRAIN] = clamp(0.012 * (inv - 1), 0, 0.02);
  out[T.KEY] = hasWindow ? 0.9 + 0.3 * d : 0.9;
  return out;
}

/**
 * Map a (smoothed) target onto the fixed lights, relative to the renderer's
 * normal-room baseline.
 * @param {{ hemi: number, sun: number, env: number, sky: ArrayLike<number>, ground: ArrayLike<number>, sunColor: ArrayLike<number> }} base
 *   intensities and linear colours of the baseline (Renderer LIGHTING)
 * @param {Float64Array} t TARGET
 * @param {Float64Array} out LEVELS_LEN
 * @returns {Float64Array} out
 */
export function lightLevels(base, t, out) {
  const e0 = t[T.E], k0 = t[T.KEY];
  const E = e0 > RL.eMin ? (e0 < RL.eMax ? e0 : RL.eMax) : RL.eMin, key = k0 > 0.5 ? (k0 < 1.5 ? k0 : 1.5) : 0.5;
  const wr = t[T.WR], wg = t[T.WG], wb = t[T.WB];
  out[LV.HEMI] = base.hemi * E;
  out[LV.SUN] = base.sun * E * key;
  out[LV.ENV] = base.env * E;
  out[LV.SKY] = base.sky[0] * wr; out[LV.SKY + 1] = base.sky[1] * wg; out[LV.SKY + 2] = base.sky[2] * wb;
  out[LV.GROUND] = base.ground[0] * wr; out[LV.GROUND + 1] = base.ground[1] * wg; out[LV.GROUND + 2] = base.ground[2] * wb;
  out[LV.SUNC] = base.sunColor[0] * wr; out[LV.SUNC + 1] = base.sunColor[1] * wg; out[LV.SUNC + 2] = base.sunColor[2] * wb;
  // unlit effects (dust, paper, splinters, feathers) are albedo × this, written as output (sRGB) values:
  // the sRGB of a mid-grey card (0.2 linear) under this light, relative to a normal room
  // (written out: this runs per frame while the lights ease, and helper calls would box their numbers)
  for (let c = 0; c < 3; c++) {
    let x = E * (c === 0 ? wr : c === 1 ? wg : wb) * 0.2;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    out[LV.ROOM + c] = (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) / SRGB_02;
  }
  const bl = t[T.BLACK], gr = t[T.GRAIN];
  out[LV.BLACK] = bl > 0 ? (bl < RL.blackMax ? bl : RL.blackMax) : 0;
  out[LV.GRAIN] = gr > 0 ? (gr < RL.grainMax ? gr : RL.grainMax) : 0;
  return out;
}

/** sRGB of 0.2 linear. */
const SRGB_02 = 1.055 * Math.pow(0.2, 1 / 2.4) - 0.055;

/**
 * Eases a target record: E in log space (τ up 1 s, down 2.5 s), white balance
 * τ 6 s, the rest τ 2.5 s; a new target within the 4 % dead band of the last
 * accepted one is ignored. Allocation-free.
 */
export class LightSmoother {
  constructor() {
    this.value = new Float64Array(TARGET_LEN);
    this.goal = new Float64Array(TARGET_LEN);
    this.primed = false;
    /** Accepted target changes (stats). */
    this.accepted = 0;
    /** The step for step() (s). */
    this.dt = 0.5;
    this.dt = 0;
  }

  /**
   * Offer a new target; returns true when it was accepted (outside the dead band).
   * @param {Float64Array} t
   */
  setTarget(t) {
    for (let i = 0; i < TARGET_LEN; i++) if (!Number.isFinite(t[i])) return false;
    const g = this.goal;
    if (this.primed) {
      let big = Math.abs(Math.log(Math.max(t[T.E], 1e-3) / Math.max(g[T.E], 1e-3))) > RL.deadBand;
      for (let c = T.WR; c <= T.WB && !big; c++) if (Math.abs(t[c] - g[c]) > RL.deadBand * 0.5) big = true;
      if (!big && Math.abs(t[T.BLACK] - g[T.BLACK]) < 0.004 && Math.abs(t[T.GRAIN] - g[T.GRAIN]) < 0.002 && Math.abs(t[T.KEY] - g[T.KEY]) < RL.deadBand) return false;
    }
    for (let i = 0; i < TARGET_LEN; i++) g[i] = t[i];
    if (!this.primed) { for (let i = 0; i < TARGET_LEN; i++) this.value[i] = t[i]; this.primed = true; }
    this.accepted++;
    return true;
  }

  /** Jump to the goal (behind the panel at session start). */
  snap() { for (let i = 0; i < TARGET_LEN; i++) this.value[i] = this.goal[i]; }

  /**
   * @param {number} dt s
   * @returns {boolean} the value changed noticeably (> 0.1 %)
   */
  update(dt) {
    this.dt = dt;
    return this.step();
  }

  /** update() with the step in `this.dt` (the frame path: no double crosses the call). */
  step() {
    const dt = this.dt;
    if (!this.primed || !(dt > 0)) return false;
    const v = this.value, g = this.goal;
    const d = dt > 0.25 ? 0.25 : dt;
    let moved = false;
    // E in log space
    const le = Math.log(Math.max(v[T.E], 1e-3)), lg = Math.log(Math.max(g[T.E], 1e-3));
    const tau = lg > le ? RL.tauUp : RL.tauDown;
    const ne = Math.exp(lg + (le - lg) * Math.exp(-d / tau));
    if (Math.abs(ne - v[T.E]) > v[T.E] * 1e-3) moved = true;
    v[T.E] = ne;
    const kc = Math.exp(-d / RL.tauColour), km = Math.exp(-d / RL.tauMisc);
    for (let i = 1; i < TARGET_LEN; i++) {
      const k = i <= T.WB ? kc : km;
      const nv = g[i] + (v[i] - g[i]) * k;
      if (Math.abs(nv - v[i]) > 1e-3 * (Math.abs(v[i]) + 0.01)) moved = true;
      v[i] = nv;
    }
    return moved;
  }
}

// ─────────────────────────────────────────────────────────── saved settings

export const ROOMLIGHT_KEY = 'cqcpt.roomlight.v1';
/** Houses kept in the saved settings (the oldest is dropped). */
export const MAX_HOUSES = 8;
export const FLOORS = Object.freeze(['wood', 'carpet', 'tile']);

/**
 * @typedef {{ v: 1, camera: boolean, houses: Record<string, { t: number, floor: string, rooms: Record<string, [number, number]> }> }} RoomLightSettings
 *   rooms: room key (RoomLight: 'a<m²>|<labels>', session-independent) or id → [LEVEL_*, WARM_*]; t: last use (ms since epoch) for the cap
 */

/** @returns {RoomLightSettings} */
export function defaultRoomLight() { return { v: 1, camera: false, houses: {} }; }

/**
 * Parse saved settings (never throws; anything invalid is dropped).
 * @param {string|null|undefined} json
 * @returns {RoomLightSettings}
 */
export function parseRoomLight(json) {
  const out = defaultRoomLight();
  if (typeof json !== 'string' || json.length === 0 || json.length > 65536) return out;
  /** @type {any} */ let o;
  try { o = JSON.parse(json); } catch { return out; }
  if (!o || typeof o !== 'object' || o.v !== 1) return out;
  out.camera = o.camera === true;
  const H = o.houses && typeof o.houses === 'object' ? o.houses : {};
  for (const sig of Object.keys(H).slice(0, MAX_HOUSES * 2)) {
    const h = H[sig];
    if (!h || typeof h !== 'object' || typeof sig !== 'string' || sig.length > 64) continue;
    /** @type {Record<string, [number, number]>} */ const rooms = {};
    const R = h.rooms && typeof h.rooms === 'object' ? h.rooms : {};
    for (const id of Object.keys(R).slice(0, 64)) {
      const r = R[id];
      if (!Array.isArray(r) || r.length !== 2) continue;
      const lv = r[0] | 0, wm = r[1] | 0;
      if (lv < 0 || lv >= LEVELS.length || wm < 0 || wm >= WARMTHS.length) continue;
      if (!/^[a-z0-9|, ]{1,128}$/i.test(id)) continue; // a room key (RoomLight: area and furniture labels) or an id
      rooms[id] = [lv, wm];
    }
    out.houses[sig] = { t: Number.isFinite(h.t) ? h.t : 0, floor: FLOORS.includes(h.floor) ? h.floor : 'wood', rooms };
  }
  capHouses(out);
  return out;
}

/** @param {RoomLightSettings} s */
function capHouses(s) {
  const keys = Object.keys(s.houses);
  if (keys.length <= MAX_HOUSES) return;
  keys.sort((a, b) => s.houses[b].t - s.houses[a].t);
  for (const k of keys.slice(MAX_HOUSES)) delete s.houses[k];
}

/** @param {RoomLightSettings} s */
export function serializeRoomLight(s) {
  capHouses(s);
  return JSON.stringify(s);
}

/**
 * The saved preset of a room ([LEVEL_AUTO, WARM_AUTO] when none).
 * @param {RoomLightSettings} s @param {string} sig @param {number} room
 * @param {Int32Array|number[]} out [level, warmth]
 */
export function roomPreset(s, sig, room, out) {
  const h = s.houses[sig];
  const r = h ? h.rooms[String(room)] : undefined;
  out[0] = r ? r[0] : LEVEL_AUTO;
  out[1] = r ? r[1] : WARM_AUTO;
  return out;
}

/**
 * Set a room's preset (event time, not per frame). Auto/auto removes the entry.
 * @param {RoomLightSettings} s @param {string} sig @param {number} room @param {number} level @param {number} warmth @param {number} now
 */
export function setRoomPreset(s, sig, room, level, warmth, now) {
  let h = s.houses[sig];
  if (!h) { h = { t: now, floor: 'wood', rooms: {} }; s.houses[sig] = h; }
  h.t = now;
  const lv = level >= 0 && level < LEVELS.length ? level | 0 : LEVEL_AUTO;
  const wm = warmth >= 0 && warmth < WARMTHS.length ? warmth | 0 : WARM_AUTO;
  if (lv === LEVEL_AUTO && wm === WARM_AUTO) delete h.rooms[String(room)];
  else h.rooms[String(room)] = [lv, wm];
  capHouses(s);
}
