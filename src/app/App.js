// @ts-check
import { VERSION } from '../version.js';
import { Game, S } from './Game.js';
import { Loop } from './Loop.js';
import { PLAY_SYSTEMS } from './Play.js';
import { MODE_NAME, modeFrom } from '../game/Rules.js';
import { MODES, attachSession, errText, featuresFor, frameRates, playStyle, requestXR, spaceNote } from '../xr/XRSession.js';
import { Input } from '../xr/Input.js';
import { Lifecycle } from '../xr/Lifecycle.js';
import { LiveDepth } from '../xr/LiveDepth.js';
import { PerfMonitor } from '../debug/PerfMonitor.js';
import { HeapWatch, loafEntry } from '../debug/HeapWatch.js';
import { collectSession, newRecord } from '../debug/CapabilityLog.js';
import { Probes } from '../debug/Probes.js';
import { DebugDraw } from '../debug/DebugDraw.js';
import { DepthView } from '../debug/DepthView.js';
import { TestCube } from '../debug/TestCube.js';
import { CanvasPanel } from '../ui/CanvasPanel.js';
import { GlyphPanel } from '../ui/GlyphPanel.js';
import { assertStable } from '../core/Warmup.js';
import { CAMERA_NEAR, PLAY_NEAR } from '../core/Renderer.js';

/** Systems of the probe-style sessions (probe, bounds, vr, setup). */
const PROBE_SYSTEMS = ['input', 'probe', 'ui', 'render'];
/**
 * Modes that run the game: `play` (Roam, the whole house, the default Enter MR),
 * `spot` (the stationary v0.2 mode, the page's second button) and `reduced`
 * (play's fallback request with fewer features; Roam rules on local-floor).
 */
const GAME_MODES = new Set(['play', 'spot', 'reduced']);
/** The probe panel sits this far left of straight ahead, so it never hides the test cube. */
const PROBE_PANEL_YAW = 0.6;
/** Play asks for this refresh rate (the Quest's AR default is 90 Hz, DEVICE_LOG p1.0). */
/** v0.6: the compositor's refresh-rate switch settles within this (ms; logged as gaps). */
const RATE_SETTLE_MS = 400;
const PLAY_HZ = 72;
/** XR input events that count as user activation: the audio context may resume from them. */
const GESTURE_EVENTS = ['selectstart', 'select', 'squeeze'];

/**
 * Composition root for one page: owns the renderer objects and runs one XR
 * session at a time.
 * - Probe-style sessions: test cube, device probes, info panel (Phase 1).
 * - Play (`play` = Roam, `spot`, `reduced`): the game built at load
 *   (`this.play`, a PlayKit from src/app/Play.js, set by main.js once the
 *   preload has built it).
 */
export class App {
  /**
   * @param {{ gfx: NonNullable<ReturnType<typeof import('../core/Renderer.js').createRenderer>>,
   *   diag: import('../debug/Diagnostics.js').Diagnostics, page: import('../ui/HomePage.js').HomePage, dev?: boolean,
   *   upload?: import('../debug/Upload.js').Uploader|null }} o
   *   upload: the automatic diagnostics upload (v0.4): every saved session record is sent after it is saved
   */
  constructor({ gfx, diag, page, dev = false, upload = null }) {
    this.gfx = gfx;
    this.diag = diag;
    this.page = page;
    this.dev = dev;
    this.upload = upload;
    this.game = new Game();
    this.input = new Input();
    this.draw = new DebugDraw(gfx.scene);
    this.cube = new TestCube(gfx.scene);
    this.depthView = new DepthView(gfx.scene);
    this.liveDepth = new LiveDepth();
    /** The probe sessions' text panel (a canvas: its lines carry live numbers). */
    this.panel = new CanvasPanel();
    this.panel.mesh.visible = false;
    gfx.scene.add(this.panel.mesh);
    /** v0.5: play's opaque "Get ready" card, laid out from the glyph atlas (no texture upload after a build). */
    this.card = new GlyphPanel({ name: 'play-card' });
    this.card.mesh.visible = false;
    gfx.scene.add(this.card.mesh);
    /** @type {import('./Play.js').PlayKit|null} built at load by main.js (null until then, or when the preload failed) */
    this.play = null;
    /** @type {any} the preload record (src/core/Preload.js) */
    this.preload = null;
    /** @type {import('../xr/XRSession.js').XRConfig} */
    this.cfg = { depth: false, bodyTracking: false, space: 'auto', scale: 1.0, foveation: 0.5, learn: true };
    /** v0.5: the next play session starts with the walkthrough scan (the page's Scan house button). */
    this.scanNext = false;
    /** v0.6: the game mode of the next play session ('survival' | 'clear' | 'defend'): the page's buttons set it. */
    this.gameMode = 'survival';
    /** `?mode=` (desktop tests): the mode of every play session, whichever button. */
    this.urlMode = typeof location !== 'undefined' && /[?&]mode=/.test(location.search) ? MODE_NAME[modeFrom(location.search)] : '';
    /** v0.5: the first play in a house with nothing learned starts with the scan (`?scan=0`: never on its own). */
    this.autoScan = true;
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
    /** v0.5: the JS heap once a second outside the frame loop (GC drops with their times, `rec.heap`). */
    this.heap = new HeapWatch({ onDrop: () => this.perf?.mark('gc') });
    /** @type {any} */ this._heapTimer = null;
    this.sessionT0 = 0;
    this.lifecycle = new Lifecycle({
      onEnd: () => this.ended(),
      onVisibility: (st) => this.visibility(st),
      onReset: (e) => this.refReset(e),
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
    /** The honest line when Roam could not get `unbounded` (the Quest boundary applies): record and page only, never in the headset. */
    const note = kit ? spaceNote(mode, att.space, att.spaceFallback) : null;
    // Everything after attach is guarded: a bug here must never leave a live
    // session with no lifecycle, no record and the menu stuck in 'entering'.
    try {
      collectSession(rec, session, r, this.gfx.gl, att);
      // Play: near plane 0.02 m (the AKM's stock clipped the face at 0.05). three passes camera.near to the
      // session's depthNear; with the depth handed to it, it would use the depth data's own values. v0.5: play
      // asks for depth-sensing for the house learner, which reads it itself (DepthTap): three never sees it
      // unless dynamic occlusion is on (cfg.depth), so the near plane, the clear and the frame stay as without.
      const depthOn = att.enabled.includes('depth-sensing');
      const share = !kit || !!this.cfg.depth;
      this.liveDepth.shareWithThree = share;
      const near = kit && !(depthOn && share) ? PLAY_NEAR : CAMERA_NEAR;
      this.gfx.camera.near = near;
      this.gfx.camera.updateProjectionMatrix();
      /** @type {any} */ (rec).view = { near, depthSensing: depthOn, depthToThree: depthOn && share };
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
      this.sessionT0 = performance.now();
      this.startHeapWatch();
      loop.add({ name: 'input', update: (dt, t, f) => this.input.update(session, f, space, dt) });
      if (kit) this.startPlay(kit, session, space, rec, perf, loop, cam, { roam: playStyle(mode) === 'roam', spaceName: att.space, spaceNote: note });
      else this.startProbe(session, space, mode, rec, perf, loop, cam);
    } catch (e) {
      this.abort(session, rec, `start: ${errText(e)}`, e);
      return;
    }
    this.game.send('started');
    this.page.inXR(mode, !!kit, note, kit ? playStyle(mode) : '');
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
        this.stableCheck(t);
      },
    });
  }

  /**
   * Play session: the game built at load, in the contract's system order.
   * @param {import('./Play.js').PlayKit} kit @param {XRSession} session @param {XRReferenceSpace} space @param {any} rec
   * @param {PerfMonitor} perf @param {Loop} loop @param {any} cam
   * @param {{ roam: boolean, spaceName: string, spaceNote: string|null }} how Roam or spot rules; the space in use; the boundary note
   */
  startPlay(kit, session, space, rec, perf, loop, cam, how) {
    this.cube.reset(false);
    this.draw.hideAll();
    this.panel.mesh.visible = false; // the probe panel: not in play (the card is the glyph panel)
    this.card.restart();
    this.card.yawOffset = 0;
    this.card.autoHide = false;
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
        s.updateTargetFrameRate(PLAY_HZ).then(() => { F.request = 'ok'; F.attrAfter = s.frameRate ?? null; perf.mark(`rate ${PLAY_HZ}`); perf.settle(RATE_SETTLE_MS); },
          (/** @type {unknown} */ e) => { F.request = `failed: ${errText(e)}`; });
      } catch (e) { F.request = `threw: ${errText(e)}`; }
    } else F.request = rates.length ? `${PLAY_HZ} Hz not offered (${rates.join('/')})` : 'no frame-rate API';
    this.watchAudio(kit, session, rec);
    const scan = this.scanNext ? 'explicit' : this.autoScan ? 'auto' : 'off';
    this.scanNext = false;
    const gameMode = this.urlMode || this.gameMode;
    this.gameMode = 'survival';
    kit.begin({ session, space, rec, perf, warmed: this.preload ? this.preload.warmed : [], ...how, scan, liveDepth: this.liveDepth, gameMode });
    for (const s of kit.systems()) loop.add(s);
    loop.add({
      name: 'ui',
      update: (dt, t, f, c) => {
        kit.uiUpdate(dt, t, f, c); // the watch
        // App's opaque "Get ready" card until the round starts, then GameSession's messages
        const lines = kit.panelLines(), card = this.card;
        if (lines) {
          // shown again (the rebuild after the spot step): placed afresh in front of the eyes
          if (!card.mesh.visible) { card.mesh.visible = true; card.placed = false; }
          if (lines !== card.lines) card.setLines(/** @type {string[]} */ (lines));
          card.follow(cam, dt);
          card.flush();
        } else if (card.mesh.visible) card.mesh.visible = false;
        if (kit.playing) this.stableCheck(t); // against the baseline of this session's XR warm draw
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
   * Every build (v0.5; dev only before): once a second, have programs, textures or geometries grown since the
   * warm-up baseline? Allocation-free while flat (assertStable reuses its result); a growth is an event: a
   * hitch-log marker and an entry in `rec.growth` (at most 20), and `rec.warmGrowth` keeps the latest counts.
   * @param {number} t
   */
  stableCheck(t) {
    if (t - this.stableAt < 1000) return;
    this.stableAt = t;
    const st = assertStable(this.gfx.renderer, this.dev ? undefined : () => {});
    if (st.ok || !this.rec) return;
    const w = this.rec.warmGrowth;
    if (w && w.programs === st.programs && w.textures === st.textures && w.geometries === st.geometries) { w.checks++; return; }
    this.warmGrowth++;
    this.rec.warmGrowth = { programs: st.programs, textures: st.textures, geometries: st.geometries, checks: this.warmGrowth };
    this.perf?.mark(`grew p${st.programs} t${st.textures} g${st.geometries}`);
    const g = this.rec.growth || (this.rec.growth = []);
    if (g.length < 20) g.push({ t: Math.round(performance.now() - this.sessionT0), programs: st.programs, textures: st.textures, geometries: st.geometries,
      step: this.play && this.play.rec === this.rec ? this.play.stepName : this.mode });
  }

  /** The heap sample timer (1 s, outside the frame loop) for this session. */
  startHeapWatch() {
    this.stopHeapWatch();
    this.heap.reset();
    this.heap.sample();
    this._heapTimer = setInterval(() => this.heap.sample(), 1000);
  }

  stopHeapWatch() {
    if (this._heapTimer !== null) { clearInterval(this._heapTimer); this._heapTimer = null; }
  }

  /**
   * The session could not be set up: record why, end it, back to the menu.
   * @param {XRSession} session @param {any} rec @param {string} why @param {unknown} e
   */
  abort(session, rec, why, e) {
    this.stopHeapWatch();
    this.loop?.stop();
    this.lifecycle.detach();
    this.liveDepth.detach();
    rec.errors.push(why);
    rec.endedAt = new Date().toISOString();
    this.diag.addSession(rec);
    this.sendUpload(rec);
    this.session = null;
    this.rec = null;
    this.perf = null;
    this.loop = null;
    this.probes = null;
    this.panel.mesh.visible = false;
    this.card.mesh.visible = false;
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
    this.sendUpload(rec);
    this.game.send('failed');
    // The gesture is spent: a retry needs a fresh tap, with fewer features.
    this.page.failed(mode, e, MODES[mode].sessionMode === 'immersive-ar' && mode !== 'reduced');
  }

  ended() {
    const rec = this.rec;
    this.stopHeapWatch();
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
      rec.panelUploads = this.panel.uploads + this.card.uploads; // v0.5: the play card uploads nothing (glyph atlas)
      rec.cardLayouts = this.card.layouts;
      rec.recent = this.perf.recent(72);
      rec.systemsMs = this.perf.systemAverages(this.perf.count);
      rec.perf = this.perf.sessionReport(); // v0.5: whole-session interval / CPU histograms, per-system averages and peaks, lateness
      this.heap.sample();
      rec.heap = this.heap.report();
      rec.probes.liveDepth = this.liveDepth.summary();
      if (rec.probes.frameRate && 'hzAtEnd' in rec.probes.frameRate) rec.probes.frameRate.hzAtEnd = this.perf.measured ? this.perf.hz : null;
      if (rec.audio && 'atStart' in rec.audio) rec.audio.atEnd = this.play && this.play.audio ? /** @type {any} */ (this.play.audio).state : null;
      this.perf.cancelRun('session ended');
    }
    if (wasPlay && kit) kit.end(); // writes rec.play before the record is saved
    if (rec && this.perf) { this.diag.addSession(rec); this.sendUpload(rec); }
    this.liveDepth.detach();
    this.draw.hideAll();
    this.panel.mesh.visible = false;
    this.card.mesh.visible = false;
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

  /**
   * The automatic diagnostics upload of a record just saved: after this task (the session has ended; never
   * from the frame loop). The payload is the compact last session with the encoded global mesh.
   * @param {any} rec
   */
  sendUpload(rec) {
    const up = this.upload;
    if (!up || !up.enabled || !rec) return;
    setTimeout(() => {
      /** @type {any} */ (this.diag.data).upload = up.report();
      up.send('session', String(rec.mode || ''), this.diag.lastPayload()).catch(() => { /* never throws */ });
    }, 0);
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

  /**
   * The reference space was reset (Lifecycle passes the XRReferenceSpaceEvent):
   * logged; play realigns the world (PlayKit.onReferenceReset).
   * @param {{ transform?: any }|null} e
   */
  refReset(e) {
    const hasTransform = !!(e && e.transform);
    this.perf?.mark('reset');
    if (this.rec) this.rec.probes.resets = (this.rec.probes.resets || 0) + 1;
    this.probes?.event(`reference space reset (transform: ${hasTransform ? 'yes' : 'no'})`);
    if (hasTransform) {
      // the world moved under us: place the cube and the panel again from the new pose
      this.cube.placed = false;
      this.panel.placed = false;
      this.card.placed = false;
    }
    if (this.play && this.play.rec === this.rec) this.play.onReferenceReset(e);
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
          // v0.5: which scripts made a long animation frame (≥ 50 ms), at most 30 per session
          if (type === 'long-animation-frame' && e.duration >= 50) {
            const L = o.entries || (o.entries = []);
            if (L.length < 30) L.push(loafEntry(e, this.sessionT0));
          }
        }
      }).observe({ type, buffered: false });
    }
  }
}
