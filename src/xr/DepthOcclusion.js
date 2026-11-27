// @ts-check
import * as THREE from 'three';
import { linearParams } from './occlusionMath.js';

/**
 * Soft-edge live-depth occlusion (docs/PLAN.md §5, mode C). Opt-in, standalone,
 * NOT wired into App. Status: implemented; shader maths and compile
 * desktop-tested in headless Chromium (tests/e2e/depth-occlusion.mjs);
 * device test pending (IWER here has no depth data, so only the headset can
 * show whether it looks right).
 *
 * Why: three r187's built-in occlusion (mode B) works on the Quest 3, but it
 * copies the 320×320 sensor depth straight into `gl_FragDepth`, so every edge
 * is a hard 5-pixel stair step. Here each patched material compares its own
 * fragment depth with the sensor depth and fades over a 5–10 cm band, with an
 * optional 4-tap percentage-closer filter across depth texels.
 *
 * ## How it works
 *
 * - `renderer.xr.getDepthTexture()` is an ExternalTexture over the session's
 *   GPU depth: a 2-layer texture array (layer = eye), unsigned-short on Quest.
 *   It is bound to a `sampler2DArray` uniform shared by every patched material.
 * - Eye and UV come from `gl_FragCoord` against the real per-eye XR viewports,
 *   as three's `_occlusion_fragment` does (right eye = x ≥ eye-1 viewport x).
 * - The raw texel is a window-space depth of a projection with the XR camera's
 *   near/far (three forces those to depthNear/depthFar = 0.1 m / Infinity on
 *   Quest), linearised as metres = a / (b − raw) (`occlusionMath.js`).
 * - The fragment's own depth is its view-space z (a varying from mvPosition),
 *   pulled toward the viewer by a per-material bias.
 * - visibility = smoothstep over a band centred on the real surface. Fade mode
 *   multiplies the output (premultiplied for opaque materials, whose alpha the
 *   passthrough compositor then uses; alpha only for straight-alpha blending);
 *   dither mode discards against a 4×4 Bayer threshold instead. Fully hidden
 *   fragments are discarded in both modes.
 * - Mode, tap count, band, bias and on/off are uniforms: switching any of them
 *   never compiles a program. The program key gains one constant suffix.
 *
 * Unverified on device (all LIKELY, none device-verified):
 * - that the Quest compositor treats the layer's alpha as premultiplied
 *   (fade mode on opaque materials relies on it; if faded edges look dark or
 *   haloed, switch to `dither: true`, which writes only alpha 1 or nothing);
 * - that the depth texture handle stays the same all session (three wraps it
 *   once; its own pass would break too if it changed);
 * - what raw value the sensor gives where it sees nothing (raw 0 hides
 *   everything, as in three's pass; `noDataRaw: 0` treats it as far instead).
 *
 * ## Which materials to patch (call `applySoftOcclusion` once, at load)
 *
 * | Object | Patch? | Bias (`OCCLUSION_BIAS`) |
 * |---|---|---|
 * | Enemy body (soldier SkinnedMesh material; SkeletonUtils clones share it) | yes | `enemy` 0.02 (feet on the real floor) |
 * | Enemy rifle | yes | `enemy` |
 * | Enemy muzzle flash (`src/enemies/MuzzleFlash.js`, MeshBasic, transparent) | yes | `fx` 0 |
 * | Spent brass (`WeaponFX` brassMat, instanced MeshStandard) | yes | `brass` 0.05 (lies on the real floor) |
 * | Dropped magazines (`WeaponFX` mag pools) | yes, but ONLY on a clone of the material: today the pools share `view.mag.material` with the held gun | `droppedMag` 0.05 |
 * | Bullet-hole decals (`WeaponFX` decalMat is a ShaderMaterial: add the chunks below) | yes | `decal` 0.05 (sits on the real wall; PLAN §5 asks for ≤ 3 cm plus half the band) |
 * | Blob shadows, other world FX | yes | 0.05 if it lies on a real surface, else 0 |
 * | Held gun, held magazine, holster, player muzzle flash: everything in `fpScene` | **NO**: your own hand would cut holes in the gun (PLAN §5) | — |
 * | Stand-in occluder (`World.occluder`), wrist HUD, panels, safe-zone ring, damage tint, debug draws | **NO** | — |
 *
 * A material is either patched or not, everywhere it is used, so a material
 * shared between an fpScene object and a world object must be split (clone
 * it, re-install any other hook on the clone, then patch the clone).
 *
 * ## Pre-patching at load (no compile later)
 *
 * 1. Build the material (and any `onBeforeCompile` hook of its own, e.g.
 *    WeaponView's `hookPartMaterial`) first. Call `applySoftOcclusion(mat,
 *    { bias })` LAST: it chains the earlier hook and its program key. A hook
 *    installed after it replaces it (check with `isSoftOccluded`).
 * 2. Patch every listed material before `warmUp()` (src/core/Warmup.js), in
 *    every session, whether or not depth sensing was granted. The patched
 *    program then exists from the warm-up on; with the uniform gate off it
 *    renders exactly like the unpatched material.
 * 3. Never patch, unpatch, clone-and-patch or toggle `transparent` later.
 *    Clones made at load must each be patched (they share one program).
 * 4. The controller creates no texture or program: three's depth texture is
 *    external (no upload), and the placeholder is three's empty array texture.
 *    three's own depth mesh is left to draw for `warmFrames` (1) frame after
 *    depth arrives, so its program is compiled then and a later `disable()`
 *    (which shows it again) compiles nothing.
 *
 * ## ShaderMaterial (decals, custom FX)
 *
 * Add the chunks to the shader yourself, then call `applySoftOcclusion`:
 *
 *     // vertex
 *     #include <softocc_pars_vertex>                 // before main()
 *     vec4 mvPosition = modelViewMatrix * ...;       // your view-space position
 *     #include <softocc_vertex>                      // after mvPosition is set
 *     // fragment
 *     #include <softocc_pars_fragment>               // before main()
 *     #include <softocc_fragment_begin>              // first line of main(): may discard
 *     ... gl_FragColor = ...;
 *     #include <softocc_fragment_end>                // after gl_FragColor is final
 *
 * The chunks are registered in `THREE.ShaderChunk` when this module loads.
 *
 * ## Frame loop (integration)
 *
 *     const occ = new DepthOcclusion({ band: 0.08, pcf: true });
 *     occ.enable(renderer);           // e.g. when cfg.softOcclusion and depth is granted
 *     // every XR frame, in the render system, just before renderer.render(scene, camera):
 *     occ.update();
 *     // an fpScene pass that hides three's depth mesh must restore it to
 *     // `occ.threeMeshVisible` (not `true`) afterwards.
 *     occ.disable();                  // three's hard occlusion again, soft gate off
 *
 * With soft occlusion on, three's hard depth mesh is hidden, so UNPATCHED world
 * objects are no longer depth-occluded (the stand-in occluder still works).
 * three still forces near/far to the depth values and skips its own clear for
 * the whole depth session (PLAN §5): neither changes here.
 *
 * Cost: off = one uniform branch per fragment, but the shader contains
 * `discard`, so on Adreno these draws never write LRZ. On = 4 `texelFetch`
 * (1 with `pcf: false`) per fragment of patched materials only; three's
 * full-screen `gl_FragDepth` pass per eye is skipped.
 */

/** Appended to the material's program key; same for every patched material. */
export const SOFT_OCCLUSION_KEY = '|softocc1';

/** Recommended per-material bias (metres the fragment is pulled toward the viewer). */
export const OCCLUSION_BIAS = Object.freeze({ enemy: 0.02, fx: 0, brass: 0.05, droppedMag: 0.05, decal: 0.05, blobShadow: 0.05 });

// ---------------------------------------------------------------------------
// GLSL (mirrors src/xr/occlusionMath.js)

const PARS_VERTEX = /* glsl */ `varying float vOccViewZ;`;

const VERTEX = /* glsl */ `vOccViewZ = - mvPosition.z;`;

const PARS_FRAGMENT = /* glsl */ `
uniform sampler2DArray occDepth; // three's XR depth texture: layer = eye, raw window depth in .r
uniform vec4 occVp0;     // eye-0 viewport (x, y, w, h), framebuffer px
uniform vec4 occVp1;     // eye-1 viewport; x = 1e9 with one view
uniform vec4 occState;   // x on, y dither, z 4-tap PCF, w max metres
uniform vec3 occBand;    // x band (m), y band growth (m per m), z no-data raw (-1 = off)
uniform vec2 occLinear;  // metres = x / ( y - raw )
uniform float occBias;   // per material: metres toward the viewer
varying float vOccViewZ;

float occMetres( float raw ) {
	if ( raw <= occBand.z ) return occState.w;
	return min( occLinear.x / max( occLinear.y - raw, 1e-6 ), occState.w );
}

float occVisAt( ivec3 texel, float fragZ ) {
	float realZ = occMetres( texelFetch( occDepth, texel, 0 ).r );
	float bw = max( occBand.x + occBand.y * realZ, 1e-4 );
	float s = clamp( ( realZ - fragZ ) / bw + 0.5, 0.0, 1.0 );
	return s * s * ( 3.0 - 2.0 * s );
}

float occVisibility() {
	bool right = gl_FragCoord.x >= occVp1.x;
	vec4 vp = right ? occVp1 : occVp0;
	int layer = right ? 1 : 0;
	vec2 uv = ( gl_FragCoord.xy - vp.xy ) / vp.zw;
	ivec2 size = textureSize( occDepth, 0 ).xy;
	ivec2 hi = size - 1;
	float fragZ = vOccViewZ - occBias;
	if ( occState.z > 0.5 ) {
		vec2 p = uv * vec2( size ) - 0.5;
		vec2 i = floor( p );
		vec2 f = p - i;
		ivec2 a = clamp( ivec2( i ), ivec2( 0 ), hi );
		ivec2 b = clamp( ivec2( i ) + 1, ivec2( 0 ), hi );
		float v00 = occVisAt( ivec3( a.x, a.y, layer ), fragZ );
		float v10 = occVisAt( ivec3( b.x, a.y, layer ), fragZ );
		float v01 = occVisAt( ivec3( a.x, b.y, layer ), fragZ );
		float v11 = occVisAt( ivec3( b.x, b.y, layer ), fragZ );
		return mix( mix( v00, v10, f.x ), mix( v01, v11, f.x ), f.y );
	}
	ivec2 n = clamp( ivec2( floor( uv * vec2( size ) ) ), ivec2( 0 ), hi );
	return occVisAt( ivec3( n, layer ), fragZ );
}

int occBayer( ivec2 q ) {
	q = q & 3;
	int r = q.x ^ q.y;
	return ( ( r & 1 ) << 3 ) | ( ( q.y & 1 ) << 2 ) | ( r & 2 ) | ( ( q.y & 2 ) >> 1 );
}
`;

const FRAGMENT_BEGIN = /* glsl */ `
float occVis = 1.0;
if ( occState.x > 0.5 ) {
	occVis = occVisibility();
	if ( occState.y > 0.5 ) {
		if ( occVis < ( float( occBayer( ivec2( gl_FragCoord.xy ) ) ) + 0.5 ) / 16.0 ) discard;
		occVis = 1.0;
	} else if ( occVis < 0.004 ) {
		discard;
	}
}
`;

const FRAGMENT_END = /* glsl */ `
#if defined( OPAQUE ) || defined( PREMULTIPLIED_ALPHA )
	gl_FragColor *= occVis;
#else
	gl_FragColor.a *= occVis;
#endif
`;

THREE.ShaderChunk.softocc_pars_vertex = PARS_VERTEX;
THREE.ShaderChunk.softocc_vertex = VERTEX;
THREE.ShaderChunk.softocc_pars_fragment = PARS_FRAGMENT;
THREE.ShaderChunk.softocc_fragment_begin = FRAGMENT_BEGIN;
THREE.ShaderChunk.softocc_fragment_end = FRAGMENT_END;

/** The chunk names, for ShaderMaterial authors and tests. */
export const SOFT_OCCLUSION_CHUNKS = Object.freeze({
  parsVertex: 'softocc_pars_vertex', vertex: 'softocc_vertex',
  parsFragment: 'softocc_pars_fragment', fragmentBegin: 'softocc_fragment_begin', fragmentEnd: 'softocc_fragment_end',
});

// Where the chunks go in three's own mesh shaders (each occurs once in
// meshbasic and meshphysical, r187). Ours go right after them, so other
// hooks that search for the same include lines still find them.
const V_ANCHORS = [['#include <common>', '#include <softocc_pars_vertex>'], ['#include <project_vertex>', '#include <softocc_vertex>']];
const F_ANCHORS = [['#include <common>', '#include <softocc_pars_fragment>'], ['#include <clipping_planes_fragment>', '#include <softocc_fragment_begin>'],
  ['#include <premultiplied_alpha_fragment>', '#include <softocc_fragment_end>']];

// ---------------------------------------------------------------------------
// Shared uniforms (one set for every patched material; the controller writes them)

export const softOcclusionUniforms = {
  /** @type {{ value: THREE.Texture | null }} null = three's empty array texture */
  occDepth: { value: null },
  occVp0: { value: new THREE.Vector4(0, 0, 1, 1) },
  occVp1: { value: new THREE.Vector4(1e9, 0, 1, 1) },
  occState: { value: new THREE.Vector4(0, 0, 1, 50) },
  occBand: { value: new THREE.Vector3(0.08, 0, -1) },
  occLinear: { value: new THREE.Vector2(0.1, 1) },
};

/**
 * @typedef {Object} PatchRecord
 * @property {{ value: number }} bias
 * @property {Function | null} hook the onBeforeCompile we installed (null for ShaderMaterial)
 */

/** @type {WeakMap<THREE.Material, PatchRecord>} (not userData: Material.copy JSON-copies userData into clones) */
const patched = new WeakMap();

/**
 * @param {{ vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: any }> }} shader
 * @param {{ value: number }} bias
 */
function inject(shader, bias) {
  for (const [a] of V_ANCHORS) if (!shader.vertexShader.includes(a)) { warnOnce(`vertex shader has no "${a}"`); return; }
  for (const [a] of F_ANCHORS) if (!shader.fragmentShader.includes(a)) { warnOnce(`fragment shader has no "${a}"`); return; }
  let vs = shader.vertexShader, fs = shader.fragmentShader;
  for (const [a, c] of V_ANCHORS) vs = vs.replace(a, `${a}\n${c}`);
  for (const [a, c] of F_ANCHORS) fs = fs.replace(a, `${a}\n${c}`);
  shader.vertexShader = vs;
  shader.fragmentShader = fs;
  addUniforms(shader.uniforms, bias);
}

/** @param {Record<string, { value: any }>} uniforms @param {{ value: number }} bias */
function addUniforms(uniforms, bias) {
  const U = softOcclusionUniforms;
  uniforms.occDepth = U.occDepth;
  uniforms.occVp0 = U.occVp0;
  uniforms.occVp1 = U.occVp1;
  uniforms.occState = U.occState;
  uniforms.occBand = U.occBand;
  uniforms.occLinear = U.occLinear;
  uniforms.occBias = bias;
}

/** @type {Set<string>} */
const warned = new Set();
/** @param {string} msg */
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`DepthOcclusion: not patched (${msg}); the material renders without soft occlusion`);
}

/**
 * Patch a material for soft live-depth occlusion. Call once per material, at
 * load, AFTER any other onBeforeCompile hook and BEFORE the warm-up. Idempotent.
 *
 * Supported: MeshBasicMaterial, MeshStandardMaterial (and MeshPhysicalMaterial),
 * and ShaderMaterial whose shaders already contain the `softocc_*` chunks.
 *
 * @template {THREE.Material} M
 * @param {M} material
 * @param {{ bias?: number }} [opts] bias: metres the fragment is pulled toward
 *   the viewer before the comparison (OCCLUSION_BIAS); a uniform, changeable later
 * @returns {M}
 */
export function applySoftOcclusion(material, opts = {}) {
  const bias = opts.bias ?? 0;
  const prev = patched.get(material);
  if (prev && (prev.hook === null || material.onBeforeCompile === prev.hook)) { prev.bias.value = bias; return material; }
  const m = /** @type {any} */ (material);
  const biasU = { value: bias };

  if (m.isShaderMaterial) {
    if (m.isRawShaderMaterial) throw new TypeError('applySoftOcclusion: RawShaderMaterial is not supported (no OPAQUE / PREMULTIPLIED_ALPHA defines)');
    const C = SOFT_OCCLUSION_CHUNKS;
    const need = [[m.vertexShader, C.parsVertex], [m.vertexShader, C.vertex], [m.fragmentShader, C.parsFragment],
      [m.fragmentShader, C.fragmentBegin], [m.fragmentShader, C.fragmentEnd]];
    for (const [src, name] of need) {
      if (!new RegExp(`^[ \\t]*#include +<${name}>`, 'm').test(src)) throw new Error(`applySoftOcclusion: ShaderMaterial "${m.name}" lacks #include <${name}>`);
    }
    addUniforms(m.uniforms, biasU);
    patched.set(material, { bias: biasU, hook: null });
    material.needsUpdate = true;
    return material;
  }

  if (!(m.isMeshBasicMaterial || m.isMeshStandardMaterial)) {
    throw new TypeError(`applySoftOcclusion: ${m.type} is not supported (MeshBasicMaterial, MeshStandardMaterial, or a ShaderMaterial with the softocc chunks)`);
  }

  const prevHook = material.onBeforeCompile;
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  const prevHookSrc = prevHook.toString(); // what three's default key would have returned
  /** @this {THREE.Material} @param {any} shader @param {THREE.WebGLRenderer} renderer */
  const hook = function (shader, renderer) {
    inject(shader, biasU); // first: the anchors are still three's own include lines
    prevHook.call(this, shader, renderer);
  };
  material.onBeforeCompile = hook;
  /** @this {THREE.Material} */
  material.customProgramCacheKey = function () {
    return (ownKey ? ownKey.call(this) : prevHookSrc) + SOFT_OCCLUSION_KEY;
  };
  patched.set(material, { bias: biasU, hook });
  material.needsUpdate = true;
  return material;
}

/**
 * True when the material is patched and its hook is still installed (a hook
 * assigned after applySoftOcclusion replaces it; use this in a load-time assert).
 * @param {THREE.Material} material
 */
export function isSoftOccluded(material) {
  const r = patched.get(material);
  return !!r && (r.hook === null || material.onBeforeCompile === r.hook);
}

/**
 * Change a patched material's bias (a uniform: no recompile). Not per frame.
 * @param {THREE.Material} material
 * @param {number} metres
 */
export function setSoftOcclusionBias(material, metres) {
  const r = patched.get(material);
  if (r) r.bias.value = metres;
  return !!r;
}

// ---------------------------------------------------------------------------
// Controller

/**
 * @typedef {Object} SoftOcclusionOptions
 * @property {number} band        fade band width in metres, centred on the real surface (default 0.08)
 * @property {number} bandGrowth  extra band per metre of depth, for sensor noise at range (default 0)
 * @property {boolean} dither     ordered-dither discard instead of the alpha fade (default false)
 * @property {boolean} pcf        4-tap percentage-closer filter; false = 1 tap like three (default true)
 * @property {number} maxMetres   depth clamp ("no surface" stays far; default 50)
 * @property {number} noDataRaw   raw ≤ this counts as no data; −1 = off, as three (default −1)
 * @property {number} warmFrames  frames with depth before soft takes over (three's own mesh draws then; default 1)
 */

/** @type {SoftOcclusionOptions} */
const DEFAULTS = { band: 0.08, bandGrowth: 0, dither: false, pcf: true, maxMetres: 50, noDataRaw: -1, warmFrames: 1 };

/**
 * Drives the shared uniforms once per frame and hides three's hard occlusion
 * mesh while soft occlusion is live. One instance per renderer (the uniforms
 * are shared module state). Allocation-free after construction.
 */
export class DepthOcclusion {
  /** @param {Partial<SoftOcclusionOptions>} [opts] */
  constructor(opts = {}) {
    this.uniforms = softOcclusionUniforms;
    /** @type {SoftOcclusionOptions} */
    this.options = { ...DEFAULTS };
    /** @type {THREE.WebGLRenderer | null} */
    this.renderer = null;
    /** enable() called (and not disabled since). */
    this.enabled = false;
    /** The soft path was live in the last update(). */
    this.active = false;
    /** Consecutive updates with a depth texture. */
    this.framesWithDepth = 0;
    /** @type {THREE.Object3D | null} three's depth mesh while we keep it hidden */
    this._hidden = null;
    this._lin = { a: 0.1, b: 1 };
    this._manualViewports = false;
    this._manualRange = false;
    /** @type {THREE.Texture | null} */
    this._testDepth = null;
    this._onSession = () => this._reset();
    this.configure(opts);
  }

  /**
   * Set options (uniform writes only: never compiles). Not for the frame loop.
   * @param {Partial<SoftOcclusionOptions>} opts
   */
  configure(opts) {
    const o = Object.assign(this.options, opts);
    const U = this.uniforms;
    U.occBand.value.set(o.band, o.bandGrowth, o.noDataRaw);
    U.occState.value.y = o.dither ? 1 : 0;
    U.occState.value.z = o.pcf ? 1 : 0;
    U.occState.value.w = o.maxMetres;
    return this;
  }

  /** What an fpScene pass should restore three's depth mesh to. */
  get threeMeshVisible() {
    return this._hidden === null;
  }

  /** @param {THREE.WebGLRenderer} renderer */
  enable(renderer) {
    if (this.renderer !== null && this.renderer !== renderer) this.disable();
    if (!this.enabled) {
      renderer.xr.addEventListener('sessionstart', this._onSession);
      renderer.xr.addEventListener('sessionend', this._onSession);
    }
    this.renderer = renderer;
    this.enabled = true;
    this.framesWithDepth = 0;
    return this;
  }

  /** Soft gate off; three's hard occlusion mesh shown again (if we hid it). */
  disable() {
    this._setOn(false);
    if (this._hidden !== null) { this._hidden.visible = true; this._hidden = null; }
    this.uniforms.occDepth.value = null;
    if (this.enabled && this.renderer !== null) {
      this.renderer.xr.removeEventListener('sessionstart', this._onSession);
      this.renderer.xr.removeEventListener('sessionend', this._onSession);
    }
    this.enabled = false;
    this.framesWithDepth = 0;
    return this;
  }

  /**
   * Once per frame, before `renderer.render` of the main scene. Allocation-free.
   * @returns {boolean} soft occlusion is live this frame
   */
  update() {
    const r = this.renderer;
    if (!this.enabled || r === null) return false;
    const xr = r.xr;
    const test = this._testDepth;
    const tex = test !== null ? test : xr.isPresenting === true ? xr.getDepthTexture() : null;
    if (tex === null) {
      this.framesWithDepth = 0;
      return this._setOn(false);
    }
    if (this.framesWithDepth < 0x3fffffff) this.framesWithDepth++;
    if (this.framesWithDepth <= this.options.warmFrames) return this._setOn(false);

    const U = this.uniforms;
    if (test === null) {
      const mesh = xr.getDepthSensingMesh(); // null until three has a depth texture
      if (mesh !== null && mesh.visible === true) { mesh.visible = false; this._hidden = mesh; }
      const cam = xr.getCamera();
      if (!this._manualViewports) {
        const cams = cam.cameras;
        if (cams.length > 0) U.occVp0.value.copy(cams[0].viewport);
        if (cams.length > 1) U.occVp1.value.copy(cams[1].viewport);
        else U.occVp1.value.set(1e9, 0, 1, 1);
      }
      // three set these to depthNear/depthFar in last frame's updateCamera (hence warmFrames ≥ 1)
      if (!this._manualRange) this._setRange(cam.near, cam.far);
    }
    U.occDepth.value = tex;
    return this._setOn(true);
  }

  /**
   * Override the per-eye viewports (desktop tests). Pass x1 = 1e9 for one view.
   * @param {number} x0 @param {number} y0 @param {number} w0 @param {number} h0
   * @param {number} x1 @param {number} y1 @param {number} w1 @param {number} h1
   */
  setViewports(x0, y0, w0, h0, x1, y1, w1, h1) {
    this._manualViewports = true;
    this.uniforms.occVp0.value.set(x0, y0, w0, h0);
    this.uniforms.occVp1.value.set(x1, y1, w1, h1);
    return this;
  }

  /**
   * Override the near/far used to linearise the raw depth (device experiments,
   * e.g. with the probe's logged depthNear/depthFar). far may be Infinity.
   * @param {number} near @param {number} far
   */
  setDepthRange(near, far) {
    this._manualRange = true;
    this._setRange(near, far);
    return this;
  }

  /**
   * Desktop tests only: use this texture as the depth (a 2-layer
   * DataArrayTexture or ExternalTexture) without an XR session; three's mesh
   * and the XR camera are not touched. null = back to the XR depth.
   * @param {THREE.Texture | null} texture
   */
  setTestDepth(texture) {
    this._testDepth = texture;
    this.framesWithDepth = 0;
    return this;
  }

  /** Back to the XR camera's viewports and near/far. */
  clearOverrides() {
    this._manualViewports = false;
    this._manualRange = false;
    return this;
  }

  /** @param {number} near @param {number} far */
  _setRange(near, far) {
    linearParams(near, far, this._lin);
    this.uniforms.occLinear.value.set(this._lin.a, this._lin.b);
  }

  /** @param {boolean} on */
  _setOn(on) {
    this.uniforms.occState.value.x = on ? 1 : 0;
    this.active = on;
    return on;
  }

  /** Session start or end: three drops its depth texture and mesh. */
  _reset() {
    this._setOn(false);
    this._hidden = null;
    this.uniforms.occDepth.value = null;
    this.framesWithDepth = 0;
  }
}
