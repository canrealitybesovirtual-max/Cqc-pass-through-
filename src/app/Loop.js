// @ts-check
/**
 * The XR frame loop. Each system is timed separately by the PerfMonitor;
 * `render` is the last system. The delta is clamped to 0.1 s so a pause or a
 * hitch never makes simulation jump. An exception in one frame is logged
 * (once per distinct message) and never stops the loop.
 */

/** @typedef {{ name: string, update: (dt: number, t: number, frame: XRFrame, ctx: any) => void }} System */

export class Loop {
  /**
   * Start the loop BEFORE `renderer.xr.setSession`: three.js stops its window
   * rAF loop on 'sessionstart', so the callback then runs only from XR frames.
   * @param {{ renderer: any, scene: any, camera: any, perf: import('../debug/PerfMonitor.js').PerfMonitor,
   *   onError: (msg: string) => void, ctx?: any, liveDepth?: import('../xr/LiveDepth.js').LiveDepth|null }} o
   *   ctx: the shared runtime context passed to every system (CONTRACTS "Ctx"; null in probe sessions);
   *   liveDepth: keeps three's depth texture current, updated just before each render.
   */
  constructor({ renderer, scene, camera, perf, onError, ctx = null, liveDepth = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.perf = perf;
    this.onError = onError;
    this.ctx = ctx;
    this.liveDepth = liveDepth;
    /** @type {System[]} */ this.systems = [];
    /** @type {number[]} */ this.sysIdx = [];
    this.renderIdx = perf.systems.indexOf('render');
    this.lastT = -1;
    this.frames = 0;
    this.errors = 0;
    /** @type {Set<string>} */ this.seen = new Set();
    /**
     * With depth sensing three.js skips its own clear for the whole session
     * (docs/PLAN.md §5), so we clear explicitly; the probe can turn it off to
     * check whether the browser clears for us.
     */
    this.explicitClear = true;
    this.active = false;
    this._frame = this._frame.bind(this);
  }

  /** @param {System} s */
  add(s) {
    const i = this.perf.systems.indexOf(s.name);
    if (i < 0) throw new Error(`system ${s.name} not registered in PerfMonitor`);
    this.systems.push(s);
    this.sysIdx.push(i);
  }

  start() {
    this.lastT = -1;
    this.active = true;
    this.perf.resetTiming();
    this.renderer.setAnimationLoop(this._frame);
  }

  stop() {
    this.active = false;
    this.renderer.setAnimationLoop(null);
    this.systems.length = 0;
    this.sysIdx.length = 0;
  }

  /**
   * @param {number} t
   * @param {XRFrame} frame
   */
  _frame(t, frame) {
    // three.js also drives this callback from window rAF before the session starts and
    // after it ends (no XRFrame then). Only XR frames are simulated, rendered and timed.
    if (!frame || !this.active) return;
    const p = this.perf;
    p.beginFrame(t);
    let dt = this.lastT < 0 ? 0 : (t - this.lastT) / 1000;
    if (!(dt >= 0)) dt = 0;
    else if (dt > 0.1) dt = 0.1;
    this.lastT = t;
    this.frames++;
    const r = this.renderer;
    r.info.reset();
    for (let i = 0; i < this.systems.length; i++) {
      if (!this.active) return; // session ended during this frame: the XRFrame is dead
      p.begin(this.sysIdx[i]);
      try { this.systems[i].update(dt, t, frame, this.ctx); } catch (e) { this.fail(this.systems[i].name, e); }
      p.end(this.sysIdx[i]);
    }
    if (!this.active) return;
    p.begin(this.renderIdx);
    try {
      if (this.liveDepth !== null) this.liveDepth.update(r);
      if (this.explicitClear && r.xr.isPresenting && r.xr.hasDepthSensing()) r.clear();
      r.render(this.scene, this.camera);
    } catch (e) { this.fail('render', e); }
    p.end(this.renderIdx);
    p.endFrame(r.info.render.calls);
  }

  /**
   * @param {string} where
   * @param {unknown} e
   */
  fail(where, e) {
    this.errors++;
    const msg = `${where}: ${e && typeof e === 'object' && 'message' in e ? /** @type {any} */ (e).message : String(e)}`;
    if (this.seen.has(msg) || this.seen.size > 20) return;
    this.seen.add(msg);
    this.onError(msg);
  }
}
