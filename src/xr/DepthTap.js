// @ts-check
import * as THREE from 'three';
import { linearParams } from './occlusionMath.js';
import { EYE, POSE, TAP, TAP_BYTES, TAP_H, TAP_W } from '../learn/depthMath.js';

/**
 * Asynchronous GPU depth readback for the house learner (v0.5, research
 * F3–F5, F11). It never blocks and three never sees the depth:
 * - LiveDepth (`shareWithThree = false`) hides the depth from three, so
 *   three keeps its 0.02 m near plane, its clear and no occlusion pass;
 *   this module asks the binding itself (LiveDepth's original method).
 * - Issue frame: one tiny draw: the depth texture array (both eyes) reduced
 *   on the GPU to 40 × 40 blocks per eye (nearest depth + its texel's place
 *   in the block, src/learn/depthMath.js), into an 80 × 40 RGBA8 target, with
 *   `renderer.xr.enabled` off for that one call and the XR target restored.
 * - Next frame: `readPixels` into a freshly specified PIXEL_PACK_BUFFER
 *   (bufferData each time: Chromium keeps its shadow copy), then a fence.
 *   Reading one frame after the draw means the GPU process never waits.
 * - Later frames: the fence is polled once a frame (`getSyncParameter`, no
 *   wait: WebGL's client wait timeout is 0); once signalled,
 *   `getBufferSubData` into a pooled 12.8 KB buffer, which goes to the
 *   learner worker with its pose block (transferred, and sent back for reuse).
 *   Not signalled within 10 frames: dropped, never waited for.
 * At most one of these GL steps runs in a frame, and only when the caller's
 * gate says the frame has room (the previous frame's CPU under budget).
 * The program and target are compiled and drawn at load (`warmUp`), so play
 * compiles nothing. Allocation-free per frame (the browser's own pose and
 * depth-information objects on issue frames aside).
 */

const VERT = /* glsl */ `
void main() {
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform sampler2DArray uDepth;
uniform vec2 uLin;   // metres = uLin.x / ( uLin.y - raw )
uniform vec2 uSize;  // the depth image (texels)
uniform vec2 uZ;     // valid range (m)
void main() {
	ivec2 o = ivec2( gl_FragCoord.xy );
	int eye = o.x >= ${TAP.cols} ? 1 : 0;
	int bx = o.x - eye * ${TAP.cols};
	int by = o.y;
	ivec2 S = ivec2( uSize );
	int bw = max( 1, S.x / ${TAP.cols} ), bh = max( 1, S.y / ${TAP.rows} );
	int sx = max( 1, bw / 8 ), sy = max( 1, bh / 8 );
	float best = 1e9, zmax = 0.0, cnt = 0.0;
	int bi = 0, bj = 0;
	for ( int j = 0; j < 8; j ++ ) {
		for ( int i = 0; i < 8; i ++ ) {
			ivec2 p = ivec2( bx * bw + i * sx, by * bh + j * sy );
			if ( p.x >= S.x || p.y >= S.y ) continue;
			float raw = texelFetch( uDepth, ivec3( p, eye ), 0 ).r;
			if ( raw <= 0.0 || raw >= 0.999999 ) continue;
			float z = uLin.x / max( uLin.y - raw, 1e-6 );
			if ( z < uZ.x || z > uZ.y ) continue;
			cnt += 1.0;
			if ( z < best ) { best = z; bi = i; bj = j; }
			zmax = max( zmax, z );
		}
	}
	float mm = cnt > 0.0 ? floor( best * 1000.0 + 0.5 ) : 0.0;
	float spread = zmax - best;
	float sc = spread < 0.03 ? 0.0 : spread < 0.15 ? 1.0 : spread < 0.5 ? 2.0 : 3.0;
	float b = cnt > 0.0 ? float( ( bi * 8 + bj ) * 4 ) + sc : 0.0;
	gl_FragColor = vec4( floor( mm / 256.0 ) / 255.0, mod( mm, 256.0 ) / 255.0, b / 255.0, floor( cnt * 255.0 / 64.0 + 0.5 ) / 255.0 );
}`;

export const TAP_STATE = Object.freeze({ IDLE: 0, DRAWN: 1, FENCED: 2 });
/** Fence polls before a readback is dropped. */
export const TAP_MAX_FRAMES = 10;
const POOL = 4;

export class DepthTap {
  /** @param {any} renderer three WebGLRenderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());
    this.target = new THREE.WebGLRenderTarget(TAP_W, TAP_H, {
      depthBuffer: false, stencilBuffer: false, format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.target.texture.name = 'depth-tap';
    /** Our own handle on the session's depth texture (three's stays null: it never sees the depth). */
    this.ext = new THREE.ExternalTexture(null);
    this.material = new THREE.ShaderMaterial({
      name: 'depth-tap',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uDepth: { value: this.ext }, uLin: { value: new THREE.Vector2(0.1, 1) }, uSize: { value: new THREE.Vector2(320, 320) }, uZ: { value: new THREE.Vector2(TAP.zMin, TAP.zMax) } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(g, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    /** @type {WebGLBuffer|null} */ this.pbo = null;
    /** @type {WebGLSync|null} */ this.sync = null;
    /** Pooled buffers: pixels and pose blocks, sent to the worker and returned. */
    /** @type {ArrayBuffer[]} */ this.pixPool = [];
    /** @type {ArrayBuffer[]} */ this.posePool = [];
    for (let i = 0; i < POOL; i++) { this.pixPool.push(new ArrayBuffer(TAP_BYTES)); this.posePool.push(new ArrayBuffer(POSE.LEN * 8)); }
    /** The pose block of the readback in flight. */
    this.pose = new Float64Array(POSE.LEN);
    this._lin = { a: 0.1, b: 1 };
    /** @type {((pix: ArrayBuffer, pose: ArrayBuffer) => void)|null} */ this.onPacket = null;
    this.state = TAP_STATE.IDLE;
    this.waited = 0;
    this.lastIssue = -1e9;
    /** Issue every this many ms (the scan: 250, play: 1000). */
    this.intervalMs = 1000;
    this.enabled = false;
    this.why = 'not attached';
    /** @type {any} */ this._binding = null;
    /** @type {Function|null} */ this._get = null;
    this.warmed = false;
    this.resetStats();
  }

  resetStats() {
    this.issued = 0;
    this.packets = 0;
    this.drops = 0;
    this.noDepth = 0;
    this.skippedGate = 0;
    this.issueMaxMs = 0; this.readMaxMs = 0; this.getMaxMs = 0; this.pollMaxMs = 0;
    this.issueSumMs = 0; this.getSumMs = 0;
    this.signalFrames = new Uint16Array(TAP_MAX_FRAMES + 2);
    this.width = 0; this.height = 0; this.textureType = ''; this.nIdentity = true; this.ownGeometry = false;
  }

  /**
   * At load, before the warm-up baseline: compile and draw the downsample into its target once (no depth bound:
   * three's empty array texture), and run one whole PBO + fence + getBufferSubData cycle (load time: waited for).
   */
  warmUp() {
    const r = this.renderer, gl = this.gl;
    const prev = r.getRenderTarget();
    const xr = r.xr.enabled;
    r.xr.enabled = false;
    try {
      r.setRenderTarget(this.target);
      r.render(this.scene, this.camera);
      this.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, TAP_BYTES, gl.STREAM_READ);
      gl.readPixels(0, 0, TAP_W, TAP_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.finish();
      if (s) { gl.getSyncParameter(s, gl.SYNC_STATUS); gl.deleteSync(s); }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(this.pixPool[0]));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.warmed = true;
    } finally {
      r.setRenderTarget(prev);
      r.xr.enabled = xr;
    }
  }

  /**
   * A session starts: readbacks run only with depth-sensing granted (gpu-optimized) and LiveDepth's binding.
   * @param {XRSession} session @param {import('./LiveDepth.js').LiveDepth} live
   */
  attach(session, live) {
    this.detach();
    this.resetStats();
    const s = /** @type {any} */ (session);
    const enabled = s && s.enabledFeatures ? Array.from(s.enabledFeatures) : [];
    if (!enabled.includes('depth-sensing')) { this.why = 'depth-sensing not granted'; return; }
    if (!live || !live.active || !live._binding || !live._orig) { this.why = live && live.why ? `live depth: ${live.why}` : 'no depth binding'; return; }
    if (!this.warmed || !this.pbo) { this.why = 'not warmed at load'; return; }
    this._binding = live._binding;
    this._get = live._orig;
    this.enabled = true;
    this.why = '';
  }

  detach() {
    const gl = this.gl;
    if (this.sync) { try { gl.deleteSync(this.sync); } catch { /* lost */ } this.sync = null; }
    this.state = TAP_STATE.IDLE;
    this.enabled = false;
    this._binding = null;
    this._get = null;
    this.ext.sourceTexture = null;
  }

  /** A buffer pair back from the worker. @param {ArrayBuffer} pix @param {ArrayBuffer} pose */
  release(pix, pose) {
    if (pix && pix.byteLength === TAP_BYTES && this.pixPool.length < POOL) this.pixPool.push(pix);
    if (pose && pose.byteLength === POSE.LEN * 8 && this.posePool.length < POOL) this.posePool.push(pose);
  }

  /**
   * One frame of the pipeline (inside the frame callback, before render).
   * @param {number} t frame time (ms) @param {XRFrame} frame @param {XRReferenceSpace} space
   * @param {boolean} room the frame has room for GL work (the previous frame's CPU under budget)
   * @param {{ x: number, y: number, z: number }|null} head @param {Float32Array|null} hands left xyz, right xyz (NaN: none)
   * @returns {boolean} true when it did GL work this frame
   */
  step(t, frame, space, room, head, hands) {
    if (!this.enabled) return false;
    if (this.state === TAP_STATE.FENCED) return this.poll();
    if (!room) { if (this.state !== TAP_STATE.IDLE || t - this.lastIssue >= this.intervalMs) this.skippedGate++; return false; }
    if (this.state === TAP_STATE.DRAWN) { this.read(); return true; }
    if (t - this.lastIssue < this.intervalMs || !this.pixPool.length || !this.posePool.length) return false;
    return this.issue(t, frame, space, head, hands);
  }

  /**
   * @param {number} t @param {XRFrame} frame @param {XRReferenceSpace} space
   * @param {{ x: number, y: number, z: number }|null} head @param {Float32Array|null} hands
   */
  issue(t, frame, space, head, hands) {
    const t0 = performance.now();
    this.lastIssue = t;
    const vp = frame.getViewerPose(space);
    if (!vp || vp.emulatedPosition) { this.noDepth++; return false; }
    const views = vp.views, P = this.pose, get = /** @type {Function} */ (this._get);
    let tex = null, near = 0.1, far = Infinity, W = 0, H = 0, eyes = 0;
    for (let e = 0; e < 2 && e < views.length; e++) {
      const view = views[e];
      let d = null;
      try { d = get.call(this._binding, view); } catch { d = null; }
      if (!d || d.isValid === false || !d.texture) break;
      if (e === 0) {
        tex = d.texture; near = d.depthNear; far = d.depthFar; W = d.width | 0; H = d.height | 0;
        this.textureType = d.textureType || '';
      } else if (d.texture !== tex) break;
      const o = e * EYE.LEN;
      // the depth's own view geometry when the browser gives it, else the view's
      const pm = d.projectionMatrix || view.projectionMatrix, tm = (d.transform || view.transform).matrix;
      if (d.projectionMatrix || d.transform) this.ownGeometry = true;
      for (let i = 0; i < 16; i++) { P[o + EYE.P + i] = pm[i]; P[o + EYE.M + i] = tm[i]; }
      const nm = d.normDepthBufferFromNormView ? d.normDepthBufferFromNormView.matrix : null;
      for (let i = 0; i < 16; i++) P[o + EYE.N + i] = nm ? nm[i] : (i % 5 === 0 ? 1 : 0);
      if (nm && (nm[0] !== 1 || nm[5] !== 1 || nm[12] !== 0 || nm[13] !== 0)) this.nIdentity = false;
      P[o + EYE.NEAR] = d.depthNear; P[o + EYE.FAR] = d.depthFar; P[o + EYE.W] = d.width; P[o + EYE.H] = d.height;
      eyes = e + 1;
    }
    if (!tex || !(W > 0 && H > 0) || (this.textureType && this.textureType !== 'texture-array')) { this.noDepth++; return false; }
    P[POSE.EYES] = eyes;
    P[POSE.T] = t;
    P[POSE.HEAD] = head ? head.x : NaN; P[POSE.HEAD + 1] = head ? head.y : NaN; P[POSE.HEAD + 2] = head ? head.z : NaN;
    for (let i = 0; i < 6; i++) P[POSE.CTRL + i] = hands ? hands[i] : NaN;
    this.width = W; this.height = H;
    // the draw: three's XR target is restored after it; xr off for this one call (our camera, our target)
    this.ext.sourceTexture = tex;
    const u = this.material.uniforms;
    linearParams(near, far, this._lin);
    u.uLin.value.set(this._lin.a, this._lin.b);
    u.uSize.value.set(W, H);
    const r = this.renderer, prev = r.getRenderTarget(), xr = r.xr.enabled;
    r.xr.enabled = false;
    try {
      r.setRenderTarget(this.target);
      r.render(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prev);
      r.xr.enabled = xr;
    }
    this.ext.sourceTexture = null; // valid only inside this frame
    this.state = TAP_STATE.DRAWN;
    this.issued++;
    const ms = performance.now() - t0;
    this.issueSumMs += ms;
    if (ms > this.issueMaxMs) this.issueMaxMs = ms;
    return true;
  }

  /** The frame after the draw: readPixels into the freshly specified pack buffer, then a fence. */
  read() {
    const t0 = performance.now(), r = this.renderer, gl = this.gl, prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, TAP_BYTES, gl.STREAM_READ);
    gl.readPixels(0, 0, TAP_W, TAP_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.state = this.sync ? TAP_STATE.FENCED : TAP_STATE.IDLE;
    this.waited = 0;
    const ms = performance.now() - t0;
    if (ms > this.readMaxMs) this.readMaxMs = ms;
  }

  /** Poll the fence (no wait); once signalled, copy out and hand the packet over. */
  poll() {
    const gl = this.gl, t0 = performance.now();
    const st = gl.getSyncParameter(/** @type {WebGLSync} */ (this.sync), gl.SYNC_STATUS);
    this.waited++;
    if (st !== gl.SIGNALED) {
      const pm = performance.now() - t0;
      if (pm > this.pollMaxMs) this.pollMaxMs = pm;
      if (this.waited > TAP_MAX_FRAMES) {
        gl.deleteSync(/** @type {WebGLSync} */ (this.sync));
        this.sync = null;
        this.state = TAP_STATE.IDLE;
        this.drops++;
      }
      return false;
    }
    gl.deleteSync(/** @type {WebGLSync} */ (this.sync));
    this.sync = null;
    this.state = TAP_STATE.IDLE;
    const pix = /** @type {ArrayBuffer} */ (this.pixPool.pop()), pose = /** @type {ArrayBuffer} */ (this.posePool.pop());
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(pix));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    new Float64Array(pose).set(this.pose);
    const ms = performance.now() - t0;
    this.getSumMs += ms;
    if (ms > this.getMaxMs) this.getMaxMs = ms;
    this.signalFrames[Math.min(this.waited, this.signalFrames.length - 1)]++;
    this.packets++;
    if (this.onPacket) this.onPacket(pix, pose); else this.release(pix, pose);
    return true;
  }

  /** JSON-safe summary (session end). */
  report() {
    const sf = {};
    for (let i = 0; i < this.signalFrames.length; i++) if (this.signalFrames[i]) /** @type {any} */ (sf)[i] = this.signalFrames[i];
    return {
      enabled: this.enabled || this.issued > 0, // v0.6: the report is read after detach(); a session that read depth says so
      why: this.why || undefined, warmed: this.warmed, issued: this.issued, packets: this.packets, drops: this.drops,
      noDepth: this.noDepth, skippedGate: this.skippedGate, intervalMs: this.intervalMs,
      issueMs: { avg: this.issued ? r2(this.issueSumMs / this.issued) : 0, max: r2(this.issueMaxMs) }, readMaxMs: r2(this.readMaxMs),
      getMs: { avg: this.packets ? r2(this.getSumMs / this.packets) : 0, max: r2(this.getMaxMs) }, pollMaxMs: r2(this.pollMaxMs),
      framesToSignal: sf, depth: { width: this.width, height: this.height, textureType: this.textureType, nIdentity: this.nIdentity, ownGeometry: this.ownGeometry },
    };
  }
}

/** @param {number} v */
function r2(v) { return Math.round(v * 100) / 100; }
