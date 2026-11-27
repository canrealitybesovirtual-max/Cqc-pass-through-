// @ts-check
import { VERSION } from '../version.js';
import { Game, S } from './Game.js';
import { Loop } from './Loop.js';
import { MODES, attachSession, errText, featuresFor, requestXR } from '../xr/XRSession.js';
import { Input } from '../xr/Input.js';
import { Lifecycle } from '../xr/Lifecycle.js';
import { PerfMonitor } from '../debug/PerfMonitor.js';
import { collectSession, newRecord } from '../debug/CapabilityLog.js';
import { Probes } from '../debug/Probes.js';
import { DebugDraw } from '../debug/DebugDraw.js';
import { TestCube } from '../debug/TestCube.js';
import { CanvasPanel } from '../ui/CanvasPanel.js';

const SYSTEMS = ['input', 'probe', 'ui', 'render'];

/**
 * Composition root for one page: owns the renderer objects and runs one XR
 * session at a time. Phase 1 content = test cube, probes, info panel.
 */
export class App {
  /**
   * @param {{ gfx: NonNullable<ReturnType<typeof import('../core/Renderer.js').createRenderer>>,
   *   diag: import('../debug/Diagnostics.js').Diagnostics, page: import('../ui/HomePage.js').HomePage }} o
   */
  constructor({ gfx, diag, page }) {
    this.gfx = gfx;
    this.diag = diag;
    this.page = page;
    this.game = new Game();
    this.input = new Input();
    this.draw = new DebugDraw(gfx.scene);
    this.cube = new TestCube(gfx.scene);
    this.panel = new CanvasPanel();
    this.panel.mesh.visible = false;
    gfx.scene.add(this.panel.mesh);
    /** @type {import('../xr/XRSession.js').XRConfig} */
    this.cfg = { depth: false, bodyTracking: false, space: 'auto', scale: 1.0, foveation: 0.5 };
    /** @type {XRSession|null} */ this.session = null;
    /** @type {any} */ this.rec = null;
    /** @type {Probes|null} */ this.probes = null;
    /** @type {PerfMonitor|null} */ this.perf = null;
    /** @type {Loop|null} */ this.loop = null;
    this.panelRev = -1;
    this.lifecycle = new Lifecycle({
      onEnd: () => this.ended(),
      onVisibility: (st) => this.visibility(st),
      onReset: (has) => this.refReset(has),
      onInputs: (a, r) => { this.probes?.refreshHitSources(); this.probes?.event(`inputs +${a} -${r}`); },
    });
    this.observeLongTasks();
  }

  /**
   * Must run synchronously inside the click handler (user gesture).
   * @param {string} mode
   */
  enter(mode) {
    if (this.game.state !== S.MENU || !navigator.xr || !MODES[mode]) return;
    /** @type {Promise<XRSession>} */
    let p;
    try { p = requestXR(navigator.xr, mode, this.cfg); } catch (e) { p = Promise.reject(e); }
    this.game.send('enter', { mode });
    this.page.entering(mode);
    p.then((s) => this.started(s, mode), (e) => this.failed(mode, e));
  }

  /**
   * @param {XRSession} session
   * @param {string} mode
   */
  async started(session, mode) {
    const r = this.gfx.renderer;
    const rec = newRecord({ mode, version: VERSION, requested: featuresFor(mode, this.cfg) });
    this.rec = rec;
    this.session = session;
    const perf = new PerfMonitor({ systems: SYSTEMS });
    this.perf = perf;
    const loop = new Loop({ renderer: r, scene: this.gfx.scene, camera: this.gfx.camera, perf, onError: (m) => this.error(m) });
    this.loop = loop;
    loop.start(); // before setSession, see Loop
    let att;
    let endedEarly = false;
    const early = () => { endedEarly = true; };
    session.addEventListener('end', early);
    try {
      att = await attachSession(r, session, mode, this.cfg);
      if (endedEarly) throw new Error('session ended while starting');
    } catch (e) {
      session.removeEventListener('end', early);
      loop.stop();
      rec.errors.push(`attach: ${errText(e)}`);
      rec.endedAt = new Date().toISOString();
      this.diag.addSession(rec);
      this.session = null;
      this.rec = null;
      this.perf = null;
      this.loop = null;
      try { await session.end(); } catch { /* already ended */ }
      this.game.send('failed');
      this.page.failed(mode, e, false);
      return;
    }
    session.removeEventListener('end', early);
    collectSession(rec, session, r, this.gfx.gl, att);
    const space = r.xr.getReferenceSpace();
    this.lifecycle.attach(session, space);
    perf.setRate(/** @type {any} */ (session).frameRate || 72);

    const probes = new Probes({ rec, mode, input: this.input, draw: this.draw, perf, loop, renderer: r, session, space });
    this.probes = probes;
    perf.onRunComplete = (res) => { rec.perfRuns.push(res); probes.event(`run done ${res.label}: ${res.pass ? 'PASS' : 'FAIL'}`); };
    perf.onRunCancelled = (res) => { rec.perfRuns.push(res); probes.event(`run cancelled: ${res.cancelled}`); };

    const cam = r.xr.getCamera();
    this.cube.reset(mode === 'vr');
    this.panel.placed = false;
    this.panel.mesh.visible = true;
    this.panelRev = -1;
    loop.add({ name: 'input', update: () => this.input.update(session) });
    loop.add({ name: 'probe', update: (dt, t, f) => { probes.update(dt, t, f); this.cube.update(cam, dt); } });
    loop.add({
      name: 'ui',
      update: (dt) => {
        if (probes.rev !== this.panelRev) { this.panelRev = probes.rev; this.panel.setLines(probes.lines()); }
        this.panel.follow(cam, dt);
        this.panel.flush();
      },
    });
    this.game.send('started');
    this.page.inXR(mode);
    probes.start().catch((e) => this.error(`probe start: ${errText(e)}`));
  }

  /**
   * @param {string} mode
   * @param {unknown} e
   */
  failed(mode, e) {
    const rec = newRecord({ mode, version: VERSION, requested: featuresFor(mode, this.cfg) });
    rec.errors.push(`requestSession: ${errText(e)}`);
    rec.endedAt = rec.startedAt;
    this.diag.addSession(rec);
    this.game.send('failed');
    // The gesture is spent: a retry needs a fresh tap, with fewer features.
    this.page.failed(mode, e, MODES[mode].sessionMode === 'immersive-ar' && mode !== 'reduced');
  }

  ended() {
    const rec = this.rec;
    this.loop?.stop();
    this.lifecycle.detach();
    this.probes?.stop();
    if (rec && this.perf && this.loop) {
      rec.endedAt = new Date().toISOString();
      rec.hitches = this.perf.exportHitches();
      rec.frames = this.loop.frames;
      rec.loopErrors = this.loop.errors;
      rec.panelUploads = this.panel.uploads;
      rec.recent = this.perf.recent(72);
      this.perf.cancelRun('session ended');
      this.diag.addSession(rec);
    }
    this.draw.hideAll();
    this.panel.mesh.visible = false;
    this.cube.mesh.visible = false;
    this.cube.grid.visible = false;
    this.session = null;
    this.probes = null;
    this.perf = null;
    this.loop = null;
    this.game.send('ended');
    this.page.ended(rec);
  }

  /** @param {string} st */
  visibility(st) {
    const hidden = st !== 'visible';
    this.game.setPause('hidden', hidden);
    this.perf?.mark(`visibility ${st}`);
    this.perf?.resetTiming();
    if (hidden) this.perf?.cancelRun(st);
    this.probes?.event(`visibility ${st}`);
  }

  /** @param {boolean} hasTransform */
  refReset(hasTransform) {
    this.perf?.mark('reset');
    if (this.rec) this.rec.probes.resets = (this.rec.probes.resets || 0) + 1;
    this.probes?.event(`reference space reset (transform: ${hasTransform ? 'yes' : 'no'})`);
  }

  /** @param {string} msg */
  error(msg) {
    if (this.rec && this.rec.errors.length < 50) this.rec.errors.push(msg);
    this.diag.pageError(msg);
    console.error(msg);
  }

  observeLongTasks() {
    const types = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes || [] : [];
    for (const type of ['longtask', 'long-animation-frame']) {
      if (!types.includes(type)) continue;
      new PerformanceObserver((list) => {
        const rec = this.rec;
        for (const e of list.getEntries()) {
          if (type === 'longtask') this.perf?.noteLongTask();
          if (!rec || !this.session) continue;
          const k = type === 'longtask' ? 'longTasks' : 'longAnimationFrames';
          const o = rec.probes[k] || (rec.probes[k] = { count: 0, maxMs: 0 });
          o.count++;
          if (e.duration > o.maxMs) o.maxMs = Math.round(e.duration);
        }
      }).observe({ type, buffered: false });
    }
  }
}
