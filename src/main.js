// @ts-check
import { VERSION } from './version.js';
import { App } from './app/App.js';
import { createRenderer } from './core/Renderer.js';
import { preload, preloaded, preloadSummary } from './core/Preload.js';
import { checkSupport } from './debug/CapabilityLog.js';
import { Diagnostics } from './debug/Diagnostics.js';
import { HomePage } from './ui/HomePage.js';
import { PlayKit, gripFitFromParams, watchFitFromParams } from './app/Play.js';
import { loadFixture, normalizeSnapshot } from './world/World.js';

const params = new URLSearchParams(location.search);
const dev = params.has('dev') || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

async function boot() {
  const page = new HomePage(VERSION);
  const diag = new Diagnostics({ version: VERSION });
  window.addEventListener('error', (e) => diag.pageError(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => diag.pageError(`unhandled: ${e.reason}`));
  // Console errors (three.js, the browser, the app) reach the diagnostics JSON too: the user has no console.
  const consoleError = console.error.bind(console);
  let inError = false;
  console.error = (...a) => {
    consoleError(...a);
    if (inError) return;
    inError = true;
    try { diag.pageError(`[console] ${a.map((x) => (x && x.message ? x.message : String(x))).join(' ').slice(0, 300)}`); } finally { inError = false; }
  };
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
  const app = new App({ gfx, diag, page, dev });
  // Loaded assets, decoded audio and the warm-up baseline: `preloaded` (src/core/Preload.js) for App,
  // `window.__app.preload` for chrome://inspect and the e2e.
  /** @type {any} */ (app).preload = preloaded;
  const willLoad = !!(support.ar || support.vr);
  if (willLoad) page.loading(0, 'starting'); // session buttons wait for the warm-up (it must finish before XR)
  page.bind(app, diag, support);
  // The audio context resumes inside the Enter click (user gesture); harmless when App unlocks it too.
  page.onEnter = (mode) => { if ((mode === 'play' || mode === 'spot' || mode === 'reduced') && preloaded.audio) preloaded.audio.unlock(); };
  app.game.send('ready');
  /** @type {any} */ (window).__app = app; // for chrome://inspect

  if (!willLoad) return; // nothing to enter: do not download the game files
  const p = await preload({
    renderer: gfx.renderer,
    scene: gfx.scene,
    camera: gfx.camera,
    onProgress: (f, label) => page.loading(f, label),
    // The whole game is built here, once: world (occluder + dev overlay: world.warmMeshes()), player, weapons (views, gloves,
    // holster, FX pools), enemy pool, game session (ring, tint, messages), the watch (and its sounds). The warm-up then
    // compiles, uploads and draws all of it (with scene.environment, the PMREM room made in createRenderer) before
    // Enter MR is enabled; nothing is built or re-keyed after this.
    buildPools: async (assets, audio) => {
      const fixture = await fixtureFor(diag);
      // ?gripPitch=<deg>&gripY=<m>&gripZ=<m>: the grip fit escape hatch (both guns, over the saved fit, never saved; rec.play.grip);
      // ?gloves=0: no gloved hands; ?watchBack/Out/Tilt/Scale, ?bracelet=0: the watch on the wrist
      /** @type {Storage|null} */ let storage = null;
      try { storage = window.localStorage; } catch { storage = null; }
      const kit = new PlayKit({ gfx, assets, audio, input: app.input, fixture, grip: gripFitFromParams(params),
        gloves: params.get('gloves') !== '0', watchFit: watchFitFromParams(params), bracelet: params.get('bracelet') !== '0',
        difficultyFromUrl: params.has('difficulty'), storage });
      app.play = kit;
      kit.setWarm(true); // every pool shown (and culling off) for the warm-up draw
      return kit.warmObjects();
    },
  });
  if (app.play) app.play.setWarm(false);
  /** @type {any} */ (diag.data).preload = preloadSummary(p);
  if (p.state === 'ready') {
    page.loaded(p);
    if (dev && p.warm) console.info(`[warm-up] ${p.warm.programs} programs, ${p.warm.textures} textures, ${p.warm.geometries} geometries; ${p.warm.drawables} drawables in ${p.warm.calls} calls; total ${p.times.totalMs} ms`);
  } else {
    page.loadFailed(p.error);
    diag.pageError(`preload: ${p.error}`);
  }
}

/**
 * A Space Setup snapshot to play in instead of the live capture (desktop only):
 * - `?emulate`: the two-room house fixture (IWER has no scene data);
 * - `?emulate&snapshot=<url>`: a saved snapshot, or a diagnostics export (its
 *   newest session with a `spaceSnapshot`), e.g. your real house from the headset;
 * - `?emulate&replay`: the newest `spaceSnapshot` in this browser's diagnostics.
 * @param {Diagnostics} diag
 * @returns {Promise<any>}
 */
async function fixtureFor(diag) {
  if (!params.has('emulate')) return null;
  /** @param {any} d */
  const newest = (d) => { const s = (d && d.sessions) || []; for (let i = s.length - 1; i >= 0; i--) if (s[i].spaceSnapshot) return s[i].spaceSnapshot; return null; };
  if (params.has('replay')) {
    const snap = newest(diag.data);
    if (snap) return normalizeSnapshot(snap);
  }
  const url = params.get('snapshot');
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`snapshot ${url}: HTTP ${res.status}`);
    const json = await res.json();
    return normalizeSnapshot(json && json.planes ? json : newest(json));
  }
  return loadFixture('./tests/fixtures/house.json');
}

boot().catch((e) => {
  const el = document.getElementById('support');
  if (el) { el.textContent = `Startup failed: ${e && e.message ? e.message : e}`; el.className = 'bad'; }
  console.error(e);
});
