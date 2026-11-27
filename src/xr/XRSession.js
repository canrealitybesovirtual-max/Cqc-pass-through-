// @ts-check
/**
 * Session modes and the session request. Pure except `requestXR`/`attachSession`,
 * which take the browser objects as arguments (so Node tests can pass fakes).
 *
 * Rules (docs/PLAN.md §2–3):
 * - Every feature is optional; `requiredFeatures` stays empty.
 * - `requestXR` must be called synchronously from a click handler: any `await`
 *   before it can use up the user gesture.
 * - Play never uses `unbounded` (stationary play, system boundary untouched).
 * - `bounded-floor` is requested only by the one-off `bounds` probe.
 */

export const BASE = Object.freeze(['local-floor', 'anchors', 'plane-detection', 'mesh-detection', 'hit-test', 'hand-tracking']);

/**
 * @typedef {{ sessionMode: 'immersive-ar'|'immersive-vr', features: readonly string[], roam: boolean, userOptions: boolean, label: string }} ModeDef
 */

/** @type {Readonly<Record<string, ModeDef>>} */
export const MODES = Object.freeze({
  play: { sessionMode: 'immersive-ar', features: BASE, roam: false, userOptions: true, label: 'Play' },
  setup: { sessionMode: 'immersive-ar', features: [...BASE, 'unbounded'], roam: true, userOptions: true, label: 'Setup' },
  probe: { sessionMode: 'immersive-ar', features: [...BASE, 'unbounded', 'depth-sensing', 'layers', 'body-tracking', 'light-estimation'], roam: true, userOptions: false, label: 'Probe' },
  bounds: { sessionMode: 'immersive-ar', features: ['local-floor', 'bounded-floor'], roam: false, userOptions: false, label: 'Boundary probe' },
  reduced: { sessionMode: 'immersive-ar', features: ['local-floor'], roam: false, userOptions: false, label: 'Reduced' },
  vr: { sessionMode: 'immersive-vr', features: ['local-floor'], roam: false, userOptions: false, label: 'VR test' },
});

/**
 * @typedef {{ depth?: boolean, bodyTracking?: boolean, space?: 'auto'|'local-floor', scale?: number, foveation?: number }} XRConfig
 */

/**
 * @param {string} mode
 * @param {XRConfig} [cfg]
 * @returns {string[]}
 */
export function featuresFor(mode, cfg = {}) {
  const m = MODES[mode];
  if (!m) throw new Error(`unknown mode ${mode}`);
  const f = [...m.features];
  if (m.userOptions && cfg.depth && !f.includes('depth-sensing')) f.push('depth-sensing');
  if (m.userOptions && cfg.bodyTracking && !f.includes('body-tracking')) f.push('body-tracking');
  return f;
}

/**
 * @param {string} mode
 * @param {XRConfig} [cfg]
 */
export function sessionInit(mode, cfg = {}) {
  const optionalFeatures = featuresFor(mode, cfg);
  /** @type {any} */
  const init = { optionalFeatures };
  // The depth-sensing spec requires this dictionary whenever the feature is requested.
  if (optionalFeatures.includes('depth-sensing')) {
    init.depthSensing = { usagePreference: ['gpu-optimized'], dataFormatPreference: [] };
  }
  return init;
}

/**
 * Reference space for a mode, given what the browser granted.
 * @param {string} mode
 * @param {readonly string[]} enabled
 * @param {XRConfig} [cfg]
 * @returns {'unbounded'|'local-floor'}
 */
export function chooseSpace(mode, enabled, cfg = {}) {
  const m = MODES[mode];
  return m && m.roam && enabled.includes('unbounded') && cfg.space !== 'local-floor' ? 'unbounded' : 'local-floor';
}

/**
 * Call synchronously from the click handler. Returns the browser's promise.
 * @param {XRSystem} xr
 * @param {string} mode
 * @param {XRConfig} [cfg]
 * @returns {Promise<XRSession>}
 */
export function requestXR(xr, mode, cfg = {}) {
  return xr.requestSession(MODES[mode].sessionMode, sessionInit(mode, cfg));
}

/**
 * Hand the session to three.js. Space, scale and foveation must be set before
 * `setSession` (three ignores the first two afterwards).
 * @param {any} renderer three.js WebGLRenderer
 * @param {XRSession} session
 * @param {string} mode
 * @param {XRConfig} [cfg]
 * @returns {Promise<{ space: string, enabled: string[], spaceFallback: string|null }>}
 */
export async function attachSession(renderer, session, mode, cfg = {}) {
  const enabled = Array.from(/** @type {any} */ (session).enabledFeatures ?? []);
  let space = chooseSpace(mode, enabled, cfg);
  /** @type {string|null} */
  let spaceFallback = null;
  // Probe the space first: if three's own request failed inside setSession it
  // would leave the session half-attached.
  try {
    await session.requestReferenceSpace(/** @type {XRReferenceSpaceType} */ (space));
  } catch (e) {
    spaceFallback = `${space} rejected: ${errText(e)}`;
    space = 'local-floor';
  }
  renderer.xr.setReferenceSpaceType(space);
  renderer.xr.setFramebufferScaleFactor(cfg.scale ?? 1.0);
  renderer.xr.setFoveation(cfg.foveation ?? 0.5); // three's default 1.0 blurs the edges
  await renderer.xr.setSession(session);
  return { space, enabled, spaceFallback };
}

/**
 * Rates the browser offers, sorted ascending; [] if the API is missing.
 * @param {XRSession} session
 * @returns {number[]}
 */
export function frameRates(session) {
  const r = /** @type {any} */ (session).supportedFrameRates;
  return r && r.length ? Array.from(/** @type {ArrayLike<number>} */ (r)).sort((a, b) => a - b) : [];
}

/**
 * Next rate in the list after `current` (wraps). Null when nothing to switch to.
 * @param {number[]} rates
 * @param {number|undefined} current
 */
export function nextRate(rates, current) {
  if (rates.length < 2) return null;
  const i = rates.findIndex((r) => Math.abs(r - (current ?? 0)) < 0.5);
  return rates[(i + 1) % rates.length];
}

/** @param {unknown} e */
export function errText(e) {
  if (e && typeof e === 'object' && 'name' in e) return `${/** @type {any} */ (e).name}: ${/** @type {any} */ (e).message}`;
  return String(e);
}
