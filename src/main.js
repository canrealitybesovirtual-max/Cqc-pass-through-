// @ts-check
import { VERSION } from './version.js';
import { App } from './app/App.js';
import { createRenderer } from './core/Renderer.js';
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
  page.bind(app, diag, support);
  app.game.send('ready');
  /** @type {any} */ (window).__app = app; // for chrome://inspect
}

boot().catch((e) => {
  const el = document.getElementById('support');
  if (el) { el.textContent = `Startup failed: ${e && e.message ? e.message : e}`; el.className = 'bad'; }
  console.error(e);
});
