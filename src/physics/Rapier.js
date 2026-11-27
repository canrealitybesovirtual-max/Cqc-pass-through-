// @ts-check
/**
 * Loads the vendored Rapier 0.20.0 (`vendor/rapier/rapier.mjs`, the compat
 * build: its wasm is inlined as base64, so there is no network fetch and no
 * import-map entry). Relative import, so the same file works in the browser
 * and in Node tests. Pure: no three.js, no DOM.
 *
 * Call once at load, before Enter (a Preload step): import 13–21 ms and
 * `init()` 80–100 ms on the desktop (research; about ×4 planned on the
 * Quest, so ~0.4 s before Enter). The promise is cached: later calls return
 * the same module.
 *
 * The first contacts after `init()` still compile wasm functions lazily
 * (measured 37–52 ms single steps): `PhysicsWorld.warmUp()` must run at
 * load too, after the item kinds are defined.
 */

export const RAPIER_VERSION = '0.20.0';

/** @type {Promise<{ R: any, info: { version: string, importMs: number, initMs: number } }> | null} */
let loading = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Import and initialise Rapier (cached).
 * @returns {Promise<{ R: any, info: { version: string, importMs: number, initMs: number } }>}
 */
export function loadRapier() {
  if (!loading) {
    loading = (async () => {
      const t0 = now();
      const mod = await import('../../vendor/rapier/rapier.mjs');
      const R = /** @type {any} */ (mod).default || mod;
      const t1 = now();
      await R.init();
      const t2 = now();
      const version = typeof R.version === 'function' ? String(R.version()) : 'unknown';
      return { R, info: { version, importMs: Math.round((t1 - t0) * 10) / 10, initMs: Math.round((t2 - t1) * 10) / 10 } };
    })();
    // a failed load may be retried (the page stays usable without physics)
    loading.catch(() => { loading = null; });
  }
  return loading;
}
