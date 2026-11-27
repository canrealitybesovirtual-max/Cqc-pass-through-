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
 * every shader's program key, so lights are never added or removed later.
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

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3026, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.6, 1.0, 0.4);
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

  // Only used outside XR; inside XR three.js drives its own ArrayCamera.
  const camera = new THREE.PerspectiveCamera(70, 1, CAMERA_NEAR, 50);

  return { renderer, scene, camera, gl, canvas, hemi, sun, flashLights };
}
