// @ts-check
import { Assets } from './Assets.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { warmUp } from './Warmup.js';

/**
 * Everything that must happen before "Enter MR" is enabled (CONTRACTS.md
 * "Integration" → "Load before Enter"), with one progress bar:
 *   1. Assets.load: GLBs (KTX2 + meshopt) and sound files;
 *   2. AudioEngine.decodeAll: every clip decoded (the context stays suspended
 *      until `audio.unlock()` inside the Enter click);
 *   3. `buildPools(assets, audio)`: the integration layer builds every pool,
 *      view and panel here and returns the objects to warm;
 *   4. `physics()` (v0.4): Rapier's import and init, the item kinds and the
 *      contact warm-up (a scratch world runs every collider pair, CCD and query
 *      once, so the first drop in play does not pay for it). Its result is in
 *      `physics`; a failure only means the v0.3 rules (it never fails the load);
 *   5. warmUp: compile, texture uploads and one default-framebuffer draw of the
 *      loaded meshes plus those objects; the baseline counts are recorded.
 *
 * The result lives in the exported `preloaded` record (also `window.__app.preload`),
 * so App can take `preloaded.assets` / `preloaded.audio` when a play session starts.
 *
 * A failure never throws out of `preload()`: `state` becomes 'failed' and `error`
 * says why (the page then keeps the probe sessions usable). Audio problems do not
 * fail the load (the game can run silent); they are listed in `warnings`.
 */

/** Shares of the progress bar (downloads dominate on the headset's Wi-Fi). */
export const SHARES = Object.freeze({ assets: 0.7, audio: 0.1, physics: 0.05, warm: 0.15 });

/**
 * @typedef {Object} Preloaded
 * @property {'idle'|'loading'|'ready'|'failed'} state
 * @property {number} progress  0..1, only moves forward
 * @property {string} label     what is loading now
 * @property {Assets|null} assets  set once loaded
 * @property {AudioEngine|null} audio  set once decoded (suspended until unlock)
 * @property {import('./Warmup.js').WarmReport|null} warm  programs / textures / geometries baseline and timings
 * @property {import('three').Object3D[]} warmed  everything the warm-up drew (asset scenes + pools)
 * @property {string} error
 * @property {string[]} warnings
 * @property {any} physics  the physics load step's result ({ ok, off?, load: { version, importMs, initMs }, warm, error? }), null when not run
 * @property {{ assetsMs: number, audioMs: number, poolsMs: number, physicsMs: number, warmMs: number, totalMs: number }} times
 * @property {{ pct: number, label: string, ms: number }[]} history  one entry per whole percent
 * @property {Promise<Preloaded>|null} done
 */

/** @type {Preloaded} */
export const preloaded = {
  state: 'idle',
  progress: 0,
  label: '',
  assets: null,
  audio: null,
  warm: null,
  warmed: [],
  error: '',
  warnings: [],
  physics: null,
  times: { assetsMs: 0, audioMs: 0, poolsMs: 0, physicsMs: 0, warmMs: 0, totalMs: 0 },
  history: [],
  done: null,
};

/**
 * The loaded models' scenes (not in any scene yet; the warm-up attaches them
 * to the main scene for its draw and detaches them again).
 * @param {Assets} assets
 * @returns {import('three').Object3D[]}
 */
export function assetWarmObjects(assets) {
  const m = assets.models;
  /** @type {import('three').Object3D[]} */
  const out = [];
  for (const k of /** @type {const} */ (['glock', 'akm', 'soldier'])) { const x = m[k]; if (x && x.scene) out.push(x.scene); }
  return out;
}

/**
 * Start the preload once; later calls return the same promise.
 * @param {{ renderer: import('three').WebGLRenderer, scene: import('three').Scene, camera: import('three').Camera,
 *   scenes?: import('three').Scene[],
 *   onProgress?: (fraction: number, label: string) => void,
 *   buildPools?: (assets: Assets, audio: AudioEngine) => (import('three').Object3D[] | Promise<import('three').Object3D[]>),
 *   physics?: () => (any | Promise<any>),
 *   assets?: Assets, audio?: AudioEngine }} o
 *   scenes: extra scenes to compile (e.g. fpScene); physics: the physics load step (after buildPools, before the
 *   warm-up); assets/audio: injectable instances.
 * @returns {Promise<Preloaded>}
 */
export function preload(o) {
  if (!preloaded.done) preloaded.done = run(o);
  return preloaded.done;
}

/** @returns {number} */
const clock = () => performance.now();

/**
 * @param {Parameters<typeof preload>[0]} o
 * @returns {Promise<Preloaded>}
 */
async function run(o) {
  const P = preloaded;
  P.state = 'loading';
  const t0 = clock();
  /** @param {number} f @param {string} label */
  const report = (f, label) => {
    if (P.state !== 'loading') return; // late callbacks of fetches still in flight after a failure
    if (!(f >= P.progress)) f = P.progress; // forward only (also catches NaN)
    if (f > 1) f = 1;
    P.progress = f;
    P.label = label;
    const pct = Math.floor(f * 100);
    const last = P.history.length ? P.history[P.history.length - 1].pct : -1;
    if (pct !== last) P.history.push({ pct, label, ms: Math.round(clock() - t0) });
    if (o.onProgress) o.onProgress(f, label);
  };
  let stage = 'assets';
  try {
    report(0, 'manifest');
    const assets = o.assets || new Assets({ renderer: o.renderer });
    let t = clock();
    await assets.load((f, label) => report(f * SHARES.assets, label));
    P.times.assetsMs = Math.round(clock() - t);

    stage = 'audio';
    t = clock();
    const audio = o.audio || new AudioEngine();
    try {
      await audio.decodeAll(assets.sounds, (f, key) => report(SHARES.assets + f * SHARES.audio, `sound ${key}`));
    } catch (e) {
      P.warnings.push(`audio decode: ${msg(e)}`);
    }
    for (const w of audio.errors) P.warnings.push(`audio: ${w}`);
    if (!audio.ready) P.warnings.push('audio: no AudioContext; the game runs silent');
    P.times.audioMs = Math.round(clock() - t);
    report(SHARES.assets + SHARES.audio, 'sounds decoded');

    stage = 'pools';
    t = clock();
    const pools = o.buildPools ? await o.buildPools(assets, audio) : [];
    P.times.poolsMs = Math.round(clock() - t);
    const objects = [...assetWarmObjects(assets), ...(pools || [])];

    if (o.physics) {
      stage = 'physics';
      const pb = SHARES.assets + SHARES.audio;
      report(pb, 'physics');
      await yieldFrame(); // the bar shows "physics" before the (synchronous) contact warm-up runs
      t = clock();
      try {
        P.physics = await o.physics();
      } catch (e) {
        P.physics = { ok: false, error: msg(e) };
      }
      if (P.physics && !P.physics.ok && !P.physics.off) P.warnings.push(`physics: ${P.physics.error || 'unavailable'} (dropped guns return to their slots)`);
      P.times.physicsMs = Math.round(clock() - t);
      report(pb + SHARES.physics, 'physics ready');
    }

    stage = 'warm-up';
    t = clock();
    const base = SHARES.assets + SHARES.audio + SHARES.physics;
    const scenes = [o.scene, ...(o.scenes || [])];
    P.warm = await warmUp(o.renderer, scenes, objects, (f, label) => report(base + f * SHARES.warm, `warm-up: ${label}`), { camera: o.camera });
    P.times.warmMs = Math.round(clock() - t);
    P.warmed = objects;
    P.assets = assets;
    P.audio = audio;
    P.times.totalMs = Math.round(clock() - t0);
    report(1, 'ready');
    P.state = 'ready';
  } catch (e) {
    P.error = `${stage}: ${msg(e)}`;
    P.times.totalMs = Math.round(clock() - t0);
    P.state = 'failed';
    console.warn(`preload failed (${P.error})`, e);
  }
  return P;
}

/**
 * A small JSON-safe summary for the diagnostics export.
 * @param {Preloaded} [P]
 */
export function preloadSummary(P = preloaded) {
  const w = P.warm;
  return {
    state: P.state,
    error: P.error || undefined,
    warnings: P.warnings.length ? P.warnings.slice(0, 20) : undefined,
    times: { ...P.times },
    physics: P.physics || undefined,
    warm: w ? {
      programs: w.programs, textures: w.textures, geometries: w.geometries, before: w.before,
      drawables: w.drawables, lods: w.lods, primed: w.primed, textureCount: w.textureCount, skippedTextures: w.skippedTextures, calls: w.calls,
      compileMs: Math.round(w.compileMs), textureMs: Math.round(w.textureMs), drawMs: Math.round(w.drawMs),
    } : undefined,
  };
}

/** One animation frame (or 50 ms when rAF is paused), so the page can paint. @returns {Promise<void>} */
function yieldFrame() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    setTimeout(go, 50);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
  });
}

/** @param {unknown} e */
function msg(e) { return e && typeof e === 'object' && 'message' in e ? String(/** @type {any} */ (e).message) : String(e); }
