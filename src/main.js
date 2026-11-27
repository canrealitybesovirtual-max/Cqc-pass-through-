// @ts-check
import { VERSION } from './version.js';
import { App } from './app/App.js';
import { createRenderer } from './core/Renderer.js';
import { preload, preloaded, preloadSummary } from './core/Preload.js';
import { checkSupport } from './debug/CapabilityLog.js';
import { Diagnostics } from './debug/Diagnostics.js';
import { Uploader, uploadEnabled } from './debug/Upload.js';
import { HomePage } from './ui/HomePage.js';
import { PlayKit, gripFitFromParams, watchFitFromParams } from './app/Play.js';
import { loadFixture, normalizeSnapshot, hydrateSnapshot } from './world/World.js';
import { loadDecalAtlas } from './fx/Look.js';

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
  /** @type {Storage|null} */ let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  // v0.4: automatic diagnostics upload (the user's Supabase project): at session end and on Copy; failures retry on the next
  // load. Dev builds and ?emulate never upload unless ?upload=1.
  const upload = new Uploader({ enabled: uploadEnabled(dev, params), storage, version: VERSION, ua: navigator.userAgent,
    onStatus: (s) => page.uploadStatus(s) });
  /** @type {any} */ (window).__upload = upload;
  if (!upload.enabled) page.uploadStatus({ state: 'off', text: 'Automatic upload off (dev build or emulator)', detail: '' });
  page.onCopy = () => {
    if (!upload.enabled) return;
    /** @type {any} */ (diag.data).upload = upload.report();
    upload.send('copy', diag.lastMode(), diag.lastPayload());
  };

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
  const app = new App({ gfx, diag, page, dev, upload });
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

  if (!willLoad) { upload.retryPending(); return; } // nothing to enter: do not download the game files
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
      // the decal atlas (bullet holes per real material) is drawn in a worker; uploaded by the warm-up
      const atlas = await loadDecalAtlas();
      // ?gripPitch=<deg>&gripY=<m>&gripZ=<m>: the grip fit escape hatch (both guns, over the saved fit, never saved; rec.play.grip);
      // ?gloves=0: no gloved hands; ?watchBack/Out/Tilt/Scale, ?bracelet=0: the watch on the wrist; ?worker=0: the world
      // builds on this thread (A/B only)
      const kit = new PlayKit({ gfx, assets, audio, input: app.input, fixture, grip: gripFitFromParams(params),
        gloves: params.get('gloves') !== '0', watchFit: watchFitFromParams(params), bracelet: params.get('bracelet') !== '0',
        difficultyFromUrl: params.has('difficulty'), storage, atlas, worldWorker: params.get('worker') !== '0' });
      app.play = kit;
      kit.setWarm(true); // every pool shown (and culling off) for the warm-up draw
      return kit.warmObjects();
    },
    // v0.4: Rapier import + init, the item kinds and the contact warm-up, before the GPU warm-up (?physics=off: the v0.3 rules)
    physics: () => (app.play ? app.play.initPhysics({ off: params.get('physics') === 'off' }) : null),
  });
  upload.retryPending(); // uploads that failed last time (after the load: they never compete with the downloads)
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
  // hydrate: a recorded global mesh (snapshot v2) is decoded back into triangles (the worker would decode it too)
  if (params.has('replay')) {
    const snap = newest(diag.data);
    if (snap) return hydrateSnapshot(normalizeSnapshot(snap));
  }
  const url = params.get('snapshot');
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`snapshot ${url}: HTTP ${res.status}`);
    const json = await res.json();
    return hydrateSnapshot(normalizeSnapshot(json && json.planes ? json : newest(json)));
  }
  return loadFixture('./tests/fixtures/house.json');
}

boot().catch((e) => {
  const el = document.getElementById('support');
  if (el) { el.textContent = `Startup failed: ${e && e.message ? e.message : e}`; el.className = 'bad'; }
  console.error(e);
});
