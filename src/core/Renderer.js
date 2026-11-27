// @ts-check
import * as THREE from 'three';

/** Camera near plane (m): probe and depth sessions, and the desktop view. */
export const CAMERA_NEAR = 0.05;
/**
 * Near plane in play sessions without depth sensing (m): the AKM's stock sits
 * up to 0.27 m behind the grip and clipped through the face at 0.05 when
 * aiming. With depth sensing on, three takes the near plane from the depth
 * data instead, so depth sessions keep CAMERA_NEAR.
 */
export const PLAY_NEAR = 0.02;

/**
 * WebGL2 renderer for XR. We create the context ourselves with
 * `xrCompatible: true`, so three.js skips `makeXRCompatible()` (a context
 * restart) after the session is granted.
 *
 * Fixed light set from the start (docs/PLAN.md §10): the light count is part of
 * every shader's program key, so lights are never added or removed later. The
 * same holds for `scene.environment` (v0.3: a PMREM room, made here before
 * the warm-up and never replaced).
 *
 * @param {{ dev: boolean }} opts
 */
export function createRenderer({ dev }) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
    xrCompatible: true,
  });
  if (!gl) return null;

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.debug.checkShaderErrors = dev; // reading shader logs is a sync stall per program
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0); // alpha 0 = passthrough shows through
  renderer.info.autoReset = false; // reset once per frame by the Loop

  const scene = new THREE.Scene();
  scene.background = null;

  const L = lightingFromParams();
  const hemi = new THREE.HemisphereLight(LIGHTING.hemiSky, LIGHTING.hemiGround, LIGHTING.hemi * L.light);
  const sun = new THREE.DirectionalLight(LIGHTING.sunColor, LIGHTING.sun * L.light);
  sun.position.fromArray(LIGHTING.sunPos);
  // Two pooled point lights for muzzle flashes (player + nearest enemy). They always
  // exist with intensity 0 so the light count (part of every program key) never changes.
  /** @type {THREE.PointLight[]} */
  const flashLights = [0, 1].map(() => {
    const l = new THREE.PointLight(0xffc27a, 0, 4, 2);
    l.castShadow = false;
    scene.add(l);
    return l;
  });
  scene.add(hemi, sun);

  // Image-based light, made ONCE here, before any material compiles: scene.environment is part of
  // every MeshStandardMaterial's program key, so it is never set to null or swapped later (only
  // scene.environmentIntensity, a uniform, may change).
  const envTexture = makeRoomEnvironment(renderer);
  scene.environment = envTexture;
  scene.environmentIntensity = LIGHTING.envIntensity * L.env;

  // Only used outside XR; inside XR three.js drives its own ArrayCamera.
  const camera = new THREE.PerspectiveCamera(70, 1, CAMERA_NEAR, 50);

  return { renderer, scene, camera, gl, canvas, hemi, sun, flashLights, envTexture, lighting: { env: scene.environmentIntensity, hemi: hemi.intensity, sun: sun.intensity } };
}

/**
 * v0.3 lighting (research-fit E). Without an environment a metal's diffuse is
 * × (1 − metalness) ≈ 0.2, so the guns rendered black with one smeared sun
 * highlight. A small PMREM of a lit room gives them reflections; the direct
 * lights come down to keep the total level. Runtime-tunable (uniforms only).
 */
export const LIGHTING = Object.freeze({
  envIntensity: 0.55,
  envSigma: 0.04,
  hemi: 0.9, hemiSky: 0xf3efe8, hemiGround: 0x2c2722,
  sun: 1.1, sunColor: 0xfff0dc, sunPos: Object.freeze([0.3, 1.0, 0.6]),
});

/**
 * Dev overrides `?env=<scale>` (environment intensity × scale, 0 = off) and
 * `?light=<scale>` (hemisphere and sun × scale). Clamped 0–4.
 * @returns {{ env: number, light: number }}
 */
export function lightingFromParams() {
  let env = 1, light = 1;
  try {
    const p = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    /** @param {string} k @param {number} d */
    const num = (k, d) => { const v = p.has(k) ? Number(p.get(k)) : NaN; return Number.isFinite(v) ? Math.max(0, Math.min(4, v)) : d; };
    env = num('env', 1);
    light = num('light', 1);
  } catch { /* no location */ }
  return { env, light };
}

/**
 * A small lit room baked into a PMREM (our own scene: a neutral shell, a
 * ceiling panel, a window and a warm lamp, so metal shows soft highlights and
 * a believable horizon). The scene is thrown away after the bake; the cube
 * render target (256² per face, ~4 MB) stays for the session.
 * @param {THREE.WebGLRenderer} renderer
 * @returns {THREE.Texture}
 */
export function makeRoomEnvironment(renderer) {
  const env = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1);
  /** @type {THREE.Material[]} */
  const mats = [];
  /**
   * @param {number} hex @param {number} k HDR scale @param {number[]} p @param {number[]} sc
   */
  const add = (hex, k, p, sc) => {
    const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    m.color.setHex(hex).multiplyScalar(k);
    mats.push(m);
    const mesh = new THREE.Mesh(box, m);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.scale.set(sc[0], sc[1], sc[2]);
    env.add(mesh);
  };
  // shell: 7 × 3 × 7 m, darker warm floor, light ceiling, neutral walls
  add(0x5d5146, 0.55, [0, -1.5, 0], [7, 0.05, 7]);
  add(0xe9e5dd, 0.85, [0, 1.5, 0], [7, 0.05, 7]);
  add(0xb7b0a4, 0.62, [3.5, 0, 0], [0.05, 3, 7]);
  add(0xb7b0a4, 0.62, [-3.5, 0, 0], [0.05, 3, 7]);
  add(0xaea89c, 0.58, [0, 0, 3.5], [7, 3, 0.05]);
  add(0xaea89c, 0.58, [0, 0, -3.5], [7, 3, 0.05]);
  // emitters
  add(0xffffff, 9, [0, 1.45, 0.3], [2.2, 0.04, 1.1]);        // ceiling panel
  add(0xdfe8ff, 6, [-3.44, 0.35, -0.8], [0.04, 1.5, 2.2]);   // window
  add(0xffd2a0, 5, [2.4, -0.7, 2.4], [0.45, 0.7, 0.45]);     // floor lamp
  add(0xfff4e6, 2.5, [3.44, 0.5, -1.8], [0.04, 0.9, 0.9]);   // fill
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, LIGHTING.envSigma);
  pm.dispose();
  box.dispose();
  for (const m of mats) m.dispose();
  rt.texture.name = 'room-env';
  return rt.texture;
}
