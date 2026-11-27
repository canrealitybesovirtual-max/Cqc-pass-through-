// @ts-check
import { VERSION } from './version.js';
import { App } from './app/App.js';
import { createRenderer } from './core/Renderer.js';
import { preload, preloaded, preloadSummary } from './core/Preload.js';
import { checkSupport } from './debug/CapabilityLog.js';
import { Diagnostics } from './debug/Diagnostics.js';
import { HomePage } from './ui/HomePage.js';

const params = new URLSearchParams(location.search);
const dev = params.has('dev') || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

async function boot() {
  const page = new HomePage(VERSION);
  const diag = new Diagnostics({ version: VERSION });
  window.addEventListener('error', (e) => diag.pageError(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => diag.pageError(`unhandled: ${e.reason}`));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') diag.save(); });

  if (params.has('emulate')) {
    // Dev only: Meta's in-page WebXR emulator (IWER) with a Quest 3 profile.
    try {
      const m = await import('../vendor/iwer/iwer.module.min.js');
      const device = new m.XRDevice(m.metaQuest3);
      device.installRuntime({ forceInstall: true }); // desktop Chrome has its own navigator.xr
      /** @type {any} */ (window).__iwer = device;
      page.note('Emulator (IWER, Quest 3 profile) active.');
    } catch (e) {
      page.note(`Emulator failed to load: ${e}`);
    }
  }

  const support = await checkSupport(navigator.xr);
  diag.data.support = support;
  const gfx = createRenderer({ dev });
  if (!gfx) { page.unsupported('WebGL2 is not available on this browser.'); return; }
  const app = new App({ gfx, diag, page });
  // Loaded assets, decoded audio and the warm-up baseline: `preloaded` (src/core/Preload.js) for App,
  // `window.__app.preload` for chrome://inspect and the e2e.
  /** @type {any} */ (app).preload = preloaded;
  const willLoad = !!(support.ar || support.vr);
  if (willLoad) page.loading(0, 'starting'); // session buttons wait for the warm-up (it must finish before XR)
  page.bind(app, diag, support);
  // The audio context resumes inside the Enter click (user gesture); harmless when App unlocks it too.
  page.onEnter = (mode) => { if ((mode === 'play' || mode === 'reduced') && preloaded.audio) preloaded.audio.unlock(); };
  app.game.send('ready');
  /** @type {any} */ (window).__app = app; // for chrome://inspect

  if (!willLoad) return; // nothing to enter: do not download the game files
  const p = await preload({
    renderer: gfx.renderer,
    scene: gfx.scene,
    camera: gfx.camera,
    onProgress: (f, label) => page.loading(f, label),
    // Integration: build every pool here (weapon views + FX, the enemy pool's warmMeshes(), HUD and
    // "Get ready" panels, fade materials) and return the objects, so the warm-up draws them before
    // Enter MR is enabled. Anything built or re-keyed (onBeforeCompile) after this is not warm.
    buildPools: undefined,
  });
  /** @type {any} */ (diag.data).preload = preloadSummary(p);
  if (p.state === 'ready') {
    page.loaded(p);
    if (dev && p.warm) console.info(`[warm-up] ${p.warm.programs} programs, ${p.warm.textures} textures, ${p.warm.geometries} geometries; ${p.warm.drawables} drawables in ${p.warm.calls} calls; total ${p.times.totalMs} ms`);
  } else {
    page.loadFailed(p.error);
    diag.pageError(`preload: ${p.error}`);
  }
}

boot().catch((e) => {
  const el = document.getElementById('support');
  if (el) { el.textContent = `Startup failed: ${e && e.message ? e.message : e}`; el.className = 'bad'; }
  console.error(e);
});
