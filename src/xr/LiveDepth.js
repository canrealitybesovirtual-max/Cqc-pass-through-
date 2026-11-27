// @ts-check
/**
 * Live GPU depth for three r187's built-in occlusion (docs/PLAN.md §5, mode B):
 * keeps three's depth texture pointing at THIS frame's depth, and records what
 * the browser hands out, so a failed "does your hand hide the cube?" test can
 * be explained from the diagnostics JSON.
 *
 * Why (three r187, verified in source):
 * - `WebXRDepthSensing.init` wraps the depth `WebGLTexture` of the FIRST valid
 *   frame in an ExternalTexture (`if (this.texture === null)`) and never updates
 *   it. The depth-sensing spec builds a new opaque texture per
 *   `getDepthInformation` call, valid only inside that frame's callback. If the
 *   Quest Browser hands out a different texture object per frame (a swapchain),
 *   three keeps sampling the first one: the depth is frozen at session start, so
 *   a hand moved in later never hides anything. three's camera-access path does
 *   refresh its texture every frame (`cameraTex.sourceTexture = …`); the depth
 *   path does not. Here `sourceTexture` is set to the current frame's texture
 *   before the render, so both three's pass and any soft-occlusion material
 *   (`src/xr/DepthOcclusion.js`, same ExternalTexture) read live depth. When the
 *   browser reuses one texture this is a no-op, and `changes` stays 0.
 * - three's full-screen depth quad (a ShaderMaterial) writes only
 *   `gl_FragDepth`; its colour output is never written, so with colour writes
 *   on, every pixel gets an undefined colour over passthrough. Its
 *   `colorWrite` is switched off (not part of the program key: no compile).
 *
 * How: at session start the XRWebGLBinding's `getDepthInformation` is wrapped
 * (one closure per session) so the depth information three asks for in its own
 * frame setup (views[0], before our frame callback) is seen without a second
 * call. `update()` runs every frame just before `renderer.render`.
 *
 * Status: implemented; desktop-tested in IWER with fake per-frame depth
 * textures (tests/e2e/emulate.mjs). Whether the Quest hands out per-frame
 * textures, and whether its depth map contains your hands, are device
 * questions: the probe's Depth line and `rec.probes.liveDepth` answer them.
 * Allocation-free per frame (the browser's own wrapper objects aside).
 */
export class LiveDepth {
  constructor() {
    /** Set sourceTexture to the current frame's texture (false = three's stock behaviour, for A/B tests). */
    this.refresh = true;
    this._reset();
  }

  _reset() {
    /** depth-sensing granted with gpu-optimized usage and an XRWebGLBinding: three's pass can run */
    this.active = false;
    this.granted = false;
    /** @type {string|null} */ this.usage = null;
    /** @type {string|null} */ this.dataFormat = null;
    /** @type {string} why it is not active ('' when active) */
    this.why = '';
    this.frames = 0;
    /** frames where three's call returned nothing / an invalid result / valid depth */
    this.noInfo = 0;
    this.invalid = 0;
    this.valid = 0;
    this.firstValidFrame = -1;
    /** valid frames whose texture object differed from the one three samples (then refreshed) */
    this.changes = 0;
    this.same = 0;
    this.width = 0;
    this.height = 0;
    this.near = NaN;
    this.far = NaN;
    this.nearFarChanges = 0;
    /** three's depth quad exists and is drawn (hasDepthSensing) */
    this.threePass = false;
    this.colorWriteOff = false;
    /** @type {any} */ this._last = null;
    /** @type {any} */ this._binding = null;
    /** @type {Function|null} */ this._orig = null;
  }

  /**
   * At session start, after `renderer.xr.setSession`.
   * @param {any} renderer three.js WebGLRenderer
   * @param {XRSession} session
   */
  attach(renderer, session) {
    this.detach();
    const s = /** @type {any} */ (session);
    const enabled = s.enabledFeatures ? Array.from(s.enabledFeatures) : [];
    this.granted = enabled.includes('depth-sensing');
    if (!this.granted) { this.why = 'depth-sensing not granted'; return; }
    // Chromium throws InvalidStateError on these when depth is not enabled; guard anyway.
    try { this.usage = s.depthUsage ?? null; } catch (e) { this.usage = null; this.why = `depthUsage threw: ${e}`; return; }
    try { this.dataFormat = s.depthDataFormat ?? null; } catch { this.dataFormat = null; }
    if (this.usage !== 'gpu-optimized') { this.why = `depthUsage is ${this.usage} (three needs gpu-optimized)`; return; }
    if (typeof XRWebGLBinding === 'undefined') { this.why = 'no XRWebGLBinding'; return; }
    let binding = null;
    try { binding = renderer.xr.getBinding(); } catch (e) { this.why = `getBinding threw: ${e}`; return; }
    const orig = binding && binding.getDepthInformation;
    if (typeof orig !== 'function') { this.why = 'XRWebGLBinding.getDepthInformation missing'; return; }
    const self = this;
    /** @this {any} @param {XRView} view */
    binding.getDepthInformation = function (view) {
      const d = orig.call(this, view);
      self._last = d;
      return d;
    };
    this._binding = binding;
    this._orig = orig;
    this.active = true;
    this.why = '';
  }

  /**
   * Every XR frame, inside the frame callback, just before `renderer.render`.
   * @param {any} renderer
   */
  update(renderer) {
    if (!this.active) return;
    const d = this._last;
    this._last = null;
    this.frames++;
    if (d === null || d === undefined) { this.noInfo++; return; }
    if (d.isValid === false || !d.texture) { this.invalid++; return; }
    this.valid++;
    if (this.firstValidFrame < 0) {
      this.firstValidFrame = this.frames;
      this.width = d.width | 0;
      this.height = d.height | 0;
    }
    if (d.depthNear !== this.near || d.depthFar !== this.far) {
      if (this.valid > 1) this.nearFarChanges++;
      this.near = d.depthNear;
      this.far = d.depthFar;
    }
    const xr = renderer.xr;
    const ext = xr.getDepthTexture();
    if (ext !== null) {
      if (ext.sourceTexture !== d.texture) {
        this.changes++;
        if (this.refresh) ext.sourceTexture = d.texture;
      } else this.same++;
    }
    const mesh = xr.getDepthSensingMesh();
    this.threePass = mesh !== null && mesh.visible === true;
    if (mesh !== null && mesh.material.colorWrite === true) {
      mesh.material.colorWrite = false;
      this.colorWriteOff = true;
    }
  }

  /** Back to the browser's own method (the binding dies with the session anyway). */
  detach() {
    if (this._binding !== null && this._orig !== null) {
      try { delete this._binding.getDepthInformation; } catch { /* sealed: leave it */ }
    }
    const refresh = this.refresh;
    this._reset();
    this.refresh = refresh;
  }

  /** One line for the probe panel. */
  line() {
    if (!this.active) return `Depth: off (${this.why || 'not requested'})`;
    if (this.valid === 0) return `Depth: granted, no valid depth yet (${this.frames} frames, ${this.noInfo} empty, ${this.invalid} invalid)`;
    const live = this.changes > 0 ? `new texture each frame ×${this.changes}${this.refresh ? ' (refreshed)' : ' (NOT refreshed)'}` : 'same texture each frame';
    return `Depth ${this.width}×${this.height} · three pass ${this.threePass ? 'ON' : 'off'} · ${live}`;
  }

  /** JSON-safe summary for the session record. */
  summary() {
    return {
      active: this.active, granted: this.granted, usage: this.usage, dataFormat: this.dataFormat, why: this.why || undefined,
      frames: this.frames, valid: this.valid, invalid: this.invalid, noInfo: this.noInfo, firstValidFrame: this.firstValidFrame,
      textureChanges: this.changes, textureSame: this.same, refresh: this.refresh,
      width: this.width, height: this.height,
      depthNear: Number.isFinite(this.near) ? this.near : this.near === Infinity ? 'Infinity' : null,
      depthFar: Number.isFinite(this.far) ? this.far : this.far === Infinity ? 'Infinity' : null,
      nearFarChanges: this.nearFarChanges, threePass: this.threePass, quadColorWriteOff: this.colorWriteOff,
    };
  }
}
