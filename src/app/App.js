// @ts-check
import { VERSION } from '../version.js';
import { Game, S } from './Game.js';
import { Loop } from './Loop.js';
import { PLAY_SYSTEMS } from './Play.js';
import { MODES, attachSession, errText, featuresFor, frameRates, requestXR } from '../xr/XRSession.js';
import { Input } from '../xr/Input.js';
import { Lifecycle } from '../xr/Lifecycle.js';
import { LiveDepth } from '../xr/LiveDepth.js';
import { PerfMonitor } from '../debug/PerfMonitor.js';
import { collectSession, newRecord } from '../debug/CapabilityLog.js';
import { Probes } from '../debug/Probes.js';
import { DebugDraw } from '../debug/DebugDraw.js';
import { DepthView } from '../debug/DepthView.js';
import { TestCube } from '../debug/TestCube.js';
import { CanvasPanel } from '../ui/CanvasPanel.js';
import { assertStable } from '../core/Warmup.js';
import { CAMERA_NEAR, PLAY_NEAR } from '../core/Renderer.js';

/** Systems of the probe-style sessions (probe, bounds, vr, setup). */
const PROBE_SYSTEMS = ['input', 'probe', 'ui', 'render'];
/** Modes that run the game (`reduced` is play's fallback request with fewer features). */
const GAME_MODES = new Set(['play', 'reduced']);
/** The probe panel sits this far left of straight ahead, so it never hides the test cube. */
const PROBE_PANEL_YAW = 0.6;
/** Play asks for this refresh rate (the Quest's AR default is 90 Hz, DEVICE_LOG p1.0). */
const PLAY_HZ = 72;
/** XR input events that count as user activation: the audio context may resume from them. */
const GESTURE_EVENTS = ['selectstart', 'select', 'squeeze'];

/**
 * Composition root for one page: owns the renderer objects and runs one XR
 * session at a time.
 * - Probe-style sessions: test cube, device probes, info panel (Phase 1).
 * - Play (`play`, `reduced`): the game built at load (`this.play`, a PlayKit
 *   from src/app/Play.js, set by main.js once the preload has built it).
 */
export class App {
  /**
   * @param {{ gfx: NonNullable<ReturnType<typeof import('../core/Renderer.js').createRenderer>>,
   *   diag: import('../debug/Diagnostics.js').Diagnostics, page: import('../ui/HomePage.js').HomePage, dev?: boolean }} o
   */
  constructor({ gfx, diag, page, dev = false }) {
    this.gfx = gfx;
    this.diag = diag;
    this.page = page;
    this.dev = dev;
    this.game = new Game();
    this.input = new Input();
    this.draw = new DebugDraw(gfx.scene);
    this.cube = new TestCube(gfx.scene);
    this.depthView = new DepthView(gfx.scene);
    this.liveDepth = new LiveDepth();
    this.panel = new CanvasPanel();
    this.panel.mesh.visible = false;
    gfx.scene.add(this.panel.mesh);
    /** @type {import('./Play.js').PlayKit|null} built at load by main.js (null until then, or when the preload failed) */
    this.play = null;
    /** @type {any} the preload record (src/core/Preload.js) */
    this.preload = null;
    /** @type {import('../xr/XRSession.js').XRConfig} */
    this.cfg = { depth: false, bodyTracking: false, space: 'auto', scale: 1.0, foveation: 0.5 };
    /** @type {XRSession|null} */ this.session = null;
    /** @type {string} */ this.mode = '';
    /** @type {any} */ this.rec = null;
    /** @type {Probes|null} */ this.probes = null;
    /** @type {PerfMonitor|null} */ this.perf = null;
    /** @type {Loop|null} */ this.loop = null;
    this.panelRev = -1;
    this.panelAt = -1e9;
    this.stableAt = -1e9;
    this.warmGrowth = 0;
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
    p.then((s) => this.started(s, mode).catch((e) => this.error(`start: ${errText(e)}`)), (e) => this.failed(mode, e));
  }

  /**
   * @param {XRSession} session
   * @param {string} mode
   */
  async started(session, mode) {
    const r = this.gfx.renderer;
    const rec = newRecord({ mode, version: VERSION, requested: featuresFor(mode, this.cfg) });
    const kit = GAME_MODES.has(mode) ? this.play : null;
    if (GAME_MODES.has(mode) && !kit) rec.errors.push('play: the game was not built at load (preload failed?); running the probe scene');
    this.rec = rec;
    this.session = session;
    this.mode = mode;
    const perf = new PerfMonitor({ systems: kit ? [...PLAY_SYSTEMS] : PROBE_SYSTEMS });
    this.perf = perf;
    const loop = new Loop({ renderer: r, scene: this.gfx.scene, camera: this.gfx.camera, perf, onError: (m) => this.error(m),
      ctx: kit ? kit.ctx : null, liveDepth: this.liveDepth });
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
      this.abort(session, rec, `attach: ${errText(e)}`, e);
      return;
    }
    session.removeEventListener('end', early);
    // Everything after attach is guarded: a bug here must never leave a live
    // session with no lifecycle, no record and the menu stuck in 'entering'.
    try {
      collectSession(rec, session, r, this.gfx.gl, att);
      // Play without depth sensing: near plane 0.02 m (the AKM's stock clipped the face at 0.05). three
      // passes camera.near to the session's depthNear; with depth on it uses the depth data's own values.
      const depthOn = att.enabled.includes('depth-sensing');
      const near = kit && !depthOn ? PLAY_NEAR : CAMERA_NEAR;
      this.gfx.camera.near = near;
      this.gfx.camera.updateProjectionMatrix();
      /** @type {any} */ (rec).view = { near, depthSensing: depthOn };
      const space = r.xr.getReferenceSpace();
      this.lifecycle.attach(session, space);
      perf.setRates(frameRates(session));
      perf.setRate(/** @type {any} */ (session).frameRate || 72); // guess; PerfMonitor measures the real rate
      perf.onRunComplete = (res) => { rec.perfRuns.push(res); this.probes?.event(`run done ${res.label}: ${res.pass ? 'PASS' : 'FAIL'}`); };
      perf.onRunCancelled = (res) => { rec.perfRuns.push(res); this.probes?.event(`run cancelled: ${res.cancelled}`); };
      this.liveDepth.attach(r, session);
      const cam = r.xr.getCamera();
      // three keeps the last session's head pose until the first viewer pose: forget it,
      // so nothing is placed from a stale pose (TestCube and the panel wait for a real one).
      cam.position.set(0, 0, 0);
      this.panel.restart();
      this.panel.mesh.visible = true;
      this.panelRev = -1;
      this.panelAt = -1e9;
      this.stableAt = -1e9;
      this.warmGrowth = 0;
      loop.add({ name: 'input', update: (dt, t, f) => this.input.update(session, f, space, dt) });
      if (kit) this.startPlay(kit, session, space, rec, perf, loop, cam);
      else this.startProbe(session, space, mode, rec, perf, loop, cam);
    } catch (e) {
      this.abort(session, rec, `start: ${errText(e)}`, e);
      return;
    }
    this.game.send('started');
    this.page.inXR(mode, !!kit);
    if (this.probes) this.probes.start().catch((e) => this.error(`probe start: ${errText(e)}`));
  }

  /**
   * Probe-style session: cube, probes, info panel.
   * @param {XRSession} session @param {XRReferenceSpace} space @param {string} mode @param {any} rec
   * @param {PerfMonitor} perf @param {Loop} loop @param {any} cam
   */
  startProbe(session, space, mode, rec, perf, loop, cam) {
    const r = this.gfx.renderer;
    const probes = new Probes({ rec, mode, input: this.input, draw: this.draw, perf, loop, renderer: r, session, space,
      liveDepth: this.liveDepth, depthView: mode === 'probe' ? this.depthView : null });
    this.probes = probes;
    this.cube.reset(mode === 'vr');
    this.panel.yawOffset = PROBE_PANEL_YAW;
    this.panel.autoHide = MODES[mode].roam; // walking between rooms: never cover the path
    loop.add({ name: 'probe', update: (dt, t, f) => { probes.update(dt, t, f); this.cube.update(cam, dt); this.depthView.update(r, cam.near, cam.far); } });
    loop.add({
      name: 'ui',
      update: (dt, t) => {
        // At most 2 redraws/s, and one per 10 s during a timing run, so the panel never pollutes the measurement.
        if (probes.rev !== this.panelRev && t - this.panelAt >= (perf.running ? 10000 : 500)) {
          this.panelRev = probes.rev;
          this.panelAt = t;
          this.panel.setLines(probes.lines());
        }
        this.panel.follow(cam, dt);
        this.panel.flush();
        this.devCheck(t);
      },
    });
  }

  /**
   * Play session: the game built at load, in the contract's system order.
   * @param {import('./Play.js').PlayKit} kit @param {XRSession} session @param {XRReferenceSpace} space @param {any} rec
   * @param {PerfMonitor} perf @param {Loop} loop @param {any} cam
   */
  startPlay(kit, session, space, rec, perf, loop, cam) {
    this.cube.reset(false);
    this.draw.hideAll();
    this.panel.yawOffset = 0;
    this.panel.autoHide = false;
    const s = /** @type {any} */ (session);
    const rates = frameRates(session);
    /** @type {any} */
    const F = rec.probes.frameRate = { attrAtStart: s.frameRate ?? null, offered: rates, target: null, request: '', attrAfter: null,
      measuredHz: null, changes: [], hzAtEnd: null };
    perf.onRateChange = (hz) => {
      if (F.measuredHz === null) F.measuredHz = hz;
      if (F.changes.length < 20) F.changes.push(hz);
    };
    // 72 Hz for play (90 is the AR default): 13.9 ms a frame instead of 11.1. PerfMonitor measures what we get.
    if (rates.includes(PLAY_HZ) && typeof s.updateTargetFrameRate === 'function') {
      F.target = PLAY_HZ;
      F.request = 'pending';
      try {
        s.updateTargetFrameRate(PLAY_HZ).then(() => { F.request = 'ok'; F.attrAfter = s.frameRate ?? null; perf.mark(`rate ${PLAY_HZ}`); },
          (/** @type {unknown} */ e) => { F.request = `failed: ${errText(e)}`; });
      } catch (e) { F.request = `threw: ${errText(e)}`; }
    } else F.request = rates.length ? `${PLAY_HZ} Hz not offered (${rates.join('/')})` : 'no frame-rate API';
    this.watchAudio(kit, session, rec);
    kit.begin({ session, space, rec, perf, warmed: this.preload ? this.preload.warmed : [] });
    for (const s of kit.systems()) loop.add(s);
    loop.add({
      name: 'ui',
      update: (dt, t, f, c) => {
        kit.hud.update(dt, t, f, c);
        // App's opaque "Get ready" panel until the round starts, then GameSession's messages
        const lines = kit.panelLines();
        if (lines) {
          // shown again (the rebuild after the spot step): placed afresh in front of the eyes
          if (!this.panel.mesh.visible) { this.panel.mesh.visible = true; this.panel.placed = false; }
          if (lines !== this.panel.lines) this.panel.setLines(/** @type {string[]} */ (lines));
          this.panel.follow(cam, dt);
          this.panel.flush();
        } else if (this.panel.mesh.visible) this.panel.mesh.visible = false;
        if (kit.playing) this.devCheck(t); // against the baseline of this session's XR warm draw
      },
    });
  }

  /**
   * Audio in play: the context state at session start and 1 s later, and a
   * resume from the XR session's input events (user activation in the WebXR
   * spec) whenever the context is not running. Event-driven only.
   * @param {import('./Play.js').PlayKit} kit @param {XRSession} session @param {any} rec
   */
  watchAudio(kit, session, rec) {
    const audio = /** @type {any} */ (kit.audio);
    if (!audio) { rec.audio = { atStart: 'no audio engine' }; return; }
    /** @type {{ atStart: string, at1s: string|null, unlocked: boolean, gestureResumes: number, firstGesture: string|null, afterGesture: string|null, errors: number }} */
    const A = { atStart: audio.state, at1s: null, unlocked: !!audio.unlocked, gestureResumes: 0, firstGesture: null, afterGesture: null, errors: audio.errors.length };
    rec.audio = A;
    const onGesture = (/** @type {Event} */ e) => {
      if (this.session !== session || !audio.gestureResume()) return;
      A.gestureResumes++;
      if (!A.firstGesture) A.firstGesture = e.type;
      setTimeout(() => { A.afterGesture = audio.state; }, 250);
    };
    for (const type of GESTURE_EVENTS) session.addEventListener(type, onGesture);
    setTimeout(() => { if (this.rec === rec) { A.at1s = audio.state; A.unlocked = !!audio.unlocked; } }, 1000);
  }

  /**
   * Dev builds: once a second, have programs, textures or geometries grown since the warm-up baseline?
   * @param {number} t
   */
  devCheck(t) {
    if (!this.dev || t - this.stableAt < 1000) return;
    this.stableAt = t;
    const st = assertStable(this.gfx.renderer);
    if (!st.ok && this.rec) {
      this.warmGrowth++;
      this.rec.warmGrowth = { programs: st.programs, textures: st.textures, geometries: st.geometries, checks: this.warmGrowth };
    }
  }

  /**
   * The session could not be set up: record why, end it, back to the menu.
   * @param {XRSession} session @param {any} rec @param {string} why @param {unknown} e
   */
  abort(session, rec, why, e) {
    this.loop?.stop();
    this.lifecycle.detach();
    this.liveDepth.detach();
    rec.errors.push(why);
    rec.endedAt = new Date().toISOString();
    this.diag.addSession(rec);
    this.session = null;
    this.rec = null;
    this.perf = null;
    this.loop = null;
    this.probes = null;
    this.panel.mesh.visible = false;
    console.error(why, e);
    session.end().catch(() => { /* already ended */ });
    this.game.send('failed');
    this.page.failed(this.mode || 'session', e, false);
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
    const kit = this.play;
    const wasPlay = !!(kit && kit.rec && kit.rec === rec);
    if (rec && this.perf && this.loop) {
      rec.endedAt = new Date().toISOString();
      rec.hitches = this.perf.exportHitches();
      rec.frames = this.loop.frames;
      rec.loopErrors = this.loop.errors;
      rec.panelUploads = this.panel.uploads;
      rec.recent = this.perf.recent(72);
      rec.systemsMs = this.perf.systemAverages(this.perf.count);
      rec.probes.liveDepth = this.liveDepth.summary();
      if (rec.probes.frameRate && 'hzAtEnd' in rec.probes.frameRate) rec.probes.frameRate.hzAtEnd = this.perf.measured ? this.perf.hz : null;
      if (rec.audio && 'atStart' in rec.audio) rec.audio.atEnd = this.play && this.play.audio ? /** @type {any} */ (this.play.audio).state : null;
      this.perf.cancelRun('session ended');
    }
    if (wasPlay && kit) kit.end(); // writes rec.play before the record is saved
    if (rec && this.perf) this.diag.addSession(rec);
    this.liveDepth.detach();
    this.draw.hideAll();
    this.panel.mesh.visible = false;
    this.cube.mesh.visible = false;
    this.cube.grid.visible = false;
    this.depthView.toggle(false, this.gfx.camera);
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
    if (this.play && this.play.rec === this.rec) this.play.setVisibility(st);
  }

  /** @param {boolean} hasTransform */
  refReset(hasTransform) {
    this.perf?.mark('reset');
    if (this.rec) this.rec.probes.resets = (this.rec.probes.resets || 0) + 1;
    this.probes?.event(`reference space reset (transform: ${hasTransform ? 'yes' : 'no'})`);
    if (hasTransform) {
      // the world moved under us: place the cube and the panel again from the new pose
      this.cube.placed = false;
      this.panel.placed = false;
    }
    if (this.play && this.play.rec === this.rec) this.play.onReferenceReset();
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
