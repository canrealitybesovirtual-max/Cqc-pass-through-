// @ts-check
import { frameRates } from '../xr/XRSession.js';

/**
 * One record per XR session: what was asked, what was granted, and every probe
 * result. Built once at session start (outside the frame loop); probes add
 * fields as they finish. Saved to localStorage only when the session ends.
 */

/** Extensions the plan cares about (docs/PLAN.md §10). */
const EXTS = ['OVR_multiview2', 'OCULUS_multiview', 'WEBGL_multisampled_render_to_texture', 'WEBGL_multi_draw',
  'WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc', 'KHR_parallel_shader_compile', 'EXT_disjoint_timer_query_webgl2',
  'EXT_texture_filter_anisotropic', 'OES_texture_float_linear'];

/**
 * @param {{ mode: string, version: string, requested: string[] }} o
 */
export function newRecord({ mode, version, requested }) {
  return {
    version,
    mode,
    startedAt: new Date().toISOString(),
    endedAt: /** @type {string|null} */ (null),
    requested,
    /** @type {Record<string, any>} */ granted: {},
    /** @type {Record<string, any>} */ layer: {},
    /** @type {Record<string, any>} */ gl: {},
    /** @type {Record<string, any>} */ probes: {},
    /** @type {any[]} */ perfRuns: [],
    /** @type {any[]} */ events: [],
    /** @type {any} */ hitches: null,
    /** @type {string[]} */ errors: [],
  };
}

/** @typedef {ReturnType<typeof newRecord>} SessionRecord */

/**
 * @param {SessionRecord} rec
 * @param {XRSession} session
 * @param {any} renderer
 * @param {WebGL2RenderingContext} gl
 * @param {{ space: string, enabled: string[], spaceFallback: string|null }} att
 */
export function collectSession(rec, session, renderer, gl, att) {
  const s = /** @type {any} */ (session);
  const g = rec.granted;
  g.enabledFeatures = att.enabled;
  g.missing = rec.requested.filter((f) => !att.enabled.includes(f));
  g.referenceSpace = att.space;
  g.spaceFallback = att.spaceFallback;
  g.environmentBlendMode = s.environmentBlendMode ?? null;
  g.interactionMode = s.interactionMode ?? null;
  g.visibilityState = s.visibilityState ?? null;
  g.supportedFrameRates = frameRates(session);
  g.frameRate = s.frameRate ?? null;
  const depthOn = att.enabled.includes('depth-sensing');
  g.depthUsage = depthOn ? s.depthUsage ?? null : null;
  g.depthDataFormat = depthOn ? s.depthDataFormat ?? null : null;
  g.depthType = depthOn ? s.depthType ?? null : null;
  g.depthAttributesWithoutFeature = !depthOn && s.depthUsage != null; // Quest exposes them regardless
  g.initiateRoomCapture = typeof s.initiateRoomCapture === 'function';
  g.persistentAnchors = 'persistentAnchors' in s;
  g.requestLightProbe = typeof s.requestLightProbe === 'function';
  g.pauseDepthSensing = typeof s.pauseDepthSensing === 'function';
  g.requestHitTestSource = typeof s.requestHitTestSource === 'function';
  g.updateTargetFrameRate = typeof s.updateTargetFrameRate === 'function';
  g.persistentHandleApi = typeof XRAnchor !== 'undefined' && 'requestPersistentHandle' in XRAnchor.prototype;

  // Layer three.js created (projection layer if XRWebGLBinding supports it)
  const L = renderer.xr.getBaseLayer();
  const lay = rec.layer;
  if (L) {
    lay.type = L.constructor ? L.constructor.name : typeof L;
    lay.textureWidth = L.textureWidth ?? L.framebufferWidth ?? null;
    lay.textureHeight = L.textureHeight ?? L.framebufferHeight ?? null;
    lay.hasFixedFoveation = 'fixedFoveation' in L;
    lay.fixedFoveationRead = 'fixedFoveation' in L ? L.fixedFoveation : null; // read back after three set 0.5
    lay.ignoreDepthValues = L.ignoreDepthValues ?? null;
  }
  try {
    lay.nativeFramebufferScale = typeof XRWebGLLayer !== 'undefined' && XRWebGLLayer.getNativeFramebufferScaleFactor
      ? XRWebGLLayer.getNativeFramebufferScaleFactor(session) : null;
  } catch (e) { lay.nativeFramebufferScale = `error ${e}`; }

  // GL
  const all = gl.getSupportedExtensions() || [];
  rec.gl.extensions = Object.fromEntries(EXTS.map((n) => [n, all.includes(n)]));
  const om = all.includes('OCULUS_multiview') ? gl.getExtension('OCULUS_multiview') : null;
  rec.gl.oculusMultisampleMultiview = !!(om && 'framebufferTextureMultisampleMultiviewOVR' in om);
  rec.gl.allExtensions = all;
  rec.gl.renderer = glRenderer(gl);
  rec.gl.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  rec.gl.contextAttributes = gl.getContextAttributes();
  rec.gl.webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  rec.gl.xrGpuBinding = typeof globalThis !== 'undefined' && 'XRGPUBinding' in globalThis;
}

/** @param {WebGL2RenderingContext} gl */
function glRenderer(gl) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? `${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)} | ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}` : gl.getParameter(gl.RENDERER);
}

/**
 * Pre-session support check (runs at boot, not inside a click).
 * @param {XRSystem|undefined} xr
 */
export async function checkSupport(xr) {
  /** @type {Record<string, any>} */
  const out = { webxr: !!xr, ar: false, vr: false, offerSession: false, secureContext: globalThis.isSecureContext === true };
  if (!xr) return out;
  out.offerSession = typeof /** @type {any} */ (xr).offerSession === 'function';
  try { out.ar = await xr.isSessionSupported('immersive-ar'); } catch (e) { out.arError = String(e); }
  try { out.vr = await xr.isSessionSupported('immersive-vr'); } catch (e) { out.vrError = String(e); }
  return out;
}
