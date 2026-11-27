// @ts-check
/**
 * Player settings that come from the page URL or localStorage (pure: no
 * three.js, no DOM; the caller passes URLSearchParams and the stored string).
 * Read once at load; written by PlayKit from a setTimeout, never from the
 * frame loop. Gun fits have their own key and parser (src/weapons/GunFit.js).
 */

/** Settings the watch changes (difficulty, the ammo line). */
export const SETTINGS_KEY = 'cqcpt.settings.v1';

/** Grip fit escape hatch limits (?gripPitch=<deg>&gripY=<m>&gripZ=<m>); WeaponSystem clamps again (±30°, ±0.04 m). */
const GRIP_MAX_DEG = 30;
const GRIP_MAX_M = 0.08;

/**
 * Grip fit override from the page URL, for both guns (applied as a gun fit,
 * GunFit.adjFromUrl; never saved):
 * - `gripPitch` (degrees, + = muzzle up) → pitch;
 * - `gripY` (metres, + = gun higher in the hand) → up;
 * - `gripZ` (metres, + = gun back toward you) → −forward.
 * Anything not a number counts as 0.
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

/**
 * The watch's place on the wrist from the URL (`?watchBack=`, `?watchOut=`
 * in metres, `?watchTilt=` degrees, `?watchScale=`); null without any. The
 * Watch clamps the values.
 * @param {URLSearchParams} params
 * @returns {{ back?: number, out?: number, tiltDeg?: number, scale?: number }|null}
 */
export function watchFitFromParams(params) {
  /** @type {Record<string, number>} */ const out = {};
  for (const [k, name] of [['watchBack', 'back'], ['watchOut', 'out'], ['watchTilt', 'tiltDeg'], ['watchScale', 'scale']]) {
    const raw = params.get(k);
    const v = raw === null || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(v)) out[name] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Saved settings (junk = defaults: 'test' difficulty, ammo line on).
 * @param {unknown} json the stored string
 * @returns {{ difficulty: 'test'|'realistic', ammoLine: boolean }}
 */
export function parseSettings(json) {
  /** @type {any} */ let o = null;
  try { o = typeof json === 'string' ? JSON.parse(json) : null; } catch { o = null; }
  if (!o || typeof o !== 'object') o = null;
  return {
    difficulty: o && o.difficulty === 'realistic' ? 'realistic' : 'test',
    ammoLine: !(o && o.ammoLine === false),
  };
}

/**
 * @param {{ difficulty: string, ammoLine: boolean }} s
 * @returns {string}
 */
export function serializeSettings(s) {
  return JSON.stringify({ v: 1, difficulty: s.difficulty === 'realistic' ? 'realistic' : 'test', ammoLine: s.ammoLine !== false });
}
