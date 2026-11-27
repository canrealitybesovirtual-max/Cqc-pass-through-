// @ts-check
/**
 * Colour matching to the Quest passthrough (research-look §3, R9, R10).
 *
 * One `onBeforeCompile` hook on every OPAQUE lit material (standard, physical,
 * lambert, phong, matcap; never UI materials with `toneMapped: false`, never
 * transparent or additive ones), installed at load BEFORE the warm-up, chained
 * onto any hook already there (WeaponView's part hook, the watch face's) and
 * before DepthOcclusion's (which must come last). After three's tone mapping
 * and output encoding (sRGB) it applies, from ONE shared uniform `uPtm`:
 *   x  grain amplitude: luminance-only noise, time-quantised to 36 Hz (the
 *      passthrough's camera grain rises as the room darkens; noise-free
 *      objects read as stickers);
 *   y  black lift: the passthrough's blacks are lifted; a pure-black polymer
 *      gun reads as a cut-out;
 *   z  saturation: the passthrough is softer and less saturated than 4× MSAA
 *      graphics;
 *   w  grain time step.
 * Values change at runtime (RoomLight), never the program.
 *
 * `contact: true` (the soldiers) adds R10's contact darkening: indirect light
 * × mix(0.55, 1, smoothstep(0, 0.3, height above the object's own origin)),
 * eased on up-facing normals. The origin of a soldier is his floor point, so
 * one program serves every soldier on every floor height with no per-object
 * uniform.
 *
 * Tone mapping (Khronos PBR Neutral) and exposure are set on the renderer in
 * `createRenderer` (src/core/Renderer.js), before any program compiles.
 */

import * as THREE from 'three';

export const PTM_KEY = 'ptm1';
export const PTM_CONTACT_KEY = 'ptm1c';

/** Defaults before RoomLight takes over (estimates; T3 on the headset). */
export const MATCH = Object.freeze({
  saturation: 0.92,
  black: 0.025,
  grain: 0.004,
});

/** The shared uniform (one object: every hooked program reads the same value). */
export const uPtm = { value: new THREE.Vector4(MATCH.grain, MATCH.black, MATCH.saturation, 0) };

/** @type {WeakMap<THREE.Material, Function>} the hook we installed per material */
const installed = new WeakMap();

const FRAG_PARS = '\nuniform vec4 uPtm;\n';
const FRAG_OUT = /* glsl */`
{
  vec3 ptmC = gl_FragColor.rgb;
  float ptmL = dot( ptmC, vec3( 0.2126, 0.7152, 0.0722 ) );
  ptmC = mix( vec3( ptmL ), ptmC, uPtm.z );
  ptmC = uPtm.y + ptmC * ( 1.0 - uPtm.y );
  vec2 ptmP = floor( gl_FragCoord.xy ) + vec2( 47.0, 17.0 ) * uPtm.w;
  float ptmN = fract( 52.9829189 * fract( dot( ptmP, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5;
  gl_FragColor.rgb = clamp( ptmC + ptmN * uPtm.x, 0.0, 1.0 );
}`;
const VERT_CONTACT_PARS = '\nvarying float vPtmH;\n';
const VERT_CONTACT = /* glsl */`
{
  vec4 ptmW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
  ptmW = instanceMatrix * ptmW;
  #endif
  ptmW = modelMatrix * ptmW;
  vPtmH = ptmW.y - modelMatrix[ 3 ].y;
}`;
const FRAG_CONTACT_PARS = '\nvarying float vPtmH;\n';
const FRAG_CONTACT = /* glsl */`
{
  float ptmAo = mix( 0.55, 1.0, smoothstep( 0.0, 0.3, vPtmH ) );
  vec3 ptmNw = inverseTransformDirection( normal, viewMatrix );
  ptmAo = mix( ptmAo, 1.0, clamp( ptmNw.y, 0.0, 1.0 ) * 0.5 );
  reflectedLight.indirectDiffuse *= ptmAo;
  reflectedLight.indirectSpecular *= ptmAo;
}`;

/**
 * Can this material take the hook? Opaque lit materials only.
 * @param {THREE.Material} m
 */
export function matchable(m) {
  const a = /** @type {any} */ (m);
  if (!a || a.toneMapped === false || a.transparent || a.blending !== THREE.NormalBlending) return false;
  if (a.colorWrite === false || a.userData && a.userData.noMatch) return false;
  return !!(a.isMeshStandardMaterial || a.isMeshLambertMaterial || a.isMeshPhongMaterial || a.isMeshMatcapMaterial || a.isMeshToonMaterial);
}

/**
 * Install the passthrough-match hook (idempotent). Call at load, after the
 * material's own hook and before DepthOcclusion and the warm-up.
 * @template {THREE.Material} M
 * @param {M} material
 * @param {{ contact?: boolean }} [opts] contact: R10 contact darkening (standard materials only)
 * @returns {boolean} installed (false: not a matchable material, or a hook we cannot chain)
 */
export function applyPassthroughMatch(material, opts = {}) {
  if (!matchable(material)) return false;
  const prevMine = installed.get(material);
  if (prevMine && material.onBeforeCompile === prevMine) return true;
  const m = /** @type {any} */ (material);
  const contact = !!opts.contact && !!m.isMeshStandardMaterial;
  const prevHook = material.onBeforeCompile;
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  const prevSrc = prevHook.toString();
  const key = contact ? PTM_CONTACT_KEY : PTM_KEY;
  /** @this {THREE.Material} @param {any} shader @param {THREE.WebGLRenderer} renderer */
  const hook = function (shader, renderer) {
    prevHook.call(this, shader, renderer);
    shader.uniforms.uPtm = uPtm;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>' + FRAG_PARS + (contact ? FRAG_CONTACT_PARS : ''));
    if (contact) fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>' + FRAG_CONTACT);
    // after the output encoding (sRGB), before fog / premultiplied alpha / dithering
    fs = fs.replace('#include <colorspace_fragment>', '#include <colorspace_fragment>' + FRAG_OUT);
    shader.fragmentShader = fs;
    if (contact) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>' + VERT_CONTACT_PARS)
        .replace('#include <project_vertex>', '#include <project_vertex>' + VERT_CONTACT);
    }
  };
  material.onBeforeCompile = hook;
  /** @this {THREE.Material} */
  material.customProgramCacheKey = function () {
    return (ownKey ? ownKey.call(this) : prevSrc) + '|' + key;
  };
  installed.set(material, hook);
  material.needsUpdate = true;
  return true;
}

/** True while our hook is the material's hook (a later assignment would replace it). @param {THREE.Material} m */
export function isMatched(m) {
  const h = installed.get(m);
  return !!h && m.onBeforeCompile === h;
}

/**
 * Hook every matchable material under the roots (each material once).
 * `contactNames`: material names that get contact darkening (the soldier).
 * @param {readonly (THREE.Object3D|null|undefined)[]} roots
 * @param {{ contactNames?: readonly string[] }} [opts]
 * @returns {{ matched: number, skipped: number, names: string[] }}
 */
export function matchMaterials(roots, opts = {}) {
  const contact = new Set(opts.contactNames || ['soldier']);
  /** @type {Set<THREE.Material>} */ const seen = new Set();
  const out = { matched: 0, skipped: 0, names: /** @type {string[]} */ ([]) };
  for (const root of roots) {
    if (!root) continue;
    root.traverse((o) => {
      const mm = /** @type {any} */ (o).material;
      if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        if (applyPassthroughMatch(m, { contact: contact.has(m.name) })) { out.matched++; out.names.push(m.name || m.type); } else out.skipped++;
      }
    });
  }
  return out;
}

/**
 * Per-material response to the room (uniforms only: roughness, metalness,
 * envMapIntensity; set at load, never a program change). By material name;
 * names not listed are left as built.
 *   soldier (cloth): no sheen in a lamp-lit room (CQC: cloth looked shiny at 1);
 *   rifle (enemy AK, painted steel and wood): a little reflection;
 *   gun (the player's guns and magazines, ORM-textured): reflections carry the metal;
 *   hand (gloves): leather and nylon, dull;
 *   holster (polymer), w2-brass (cases): as built.
 * @type {Readonly<Record<string, Readonly<{ env?: number, roughMin?: number }>>>}
 */
export const MATERIAL_TUNING = Object.freeze({
  soldier: Object.freeze({ env: 0.35, roughMin: 0.7 }),
  rifle: Object.freeze({ env: 0.6 }),
  gun: Object.freeze({ env: 0.9 }),
  hand: Object.freeze({ env: 0.45, roughMin: 0.65 }),
});

/**
 * Apply MATERIAL_TUNING under the roots (each material once).
 * @param {readonly (THREE.Object3D|null|undefined)[]} roots
 * @returns {number} materials tuned
 */
export function tuneMaterials(roots) {
  /** @type {Set<THREE.Material>} */ const seen = new Set();
  let n = 0;
  for (const root of roots) {
    if (!root) continue;
    root.traverse((o) => {
      const mm = /** @type {any} */ (o).material;
      if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const t = MATERIAL_TUNING[m.name];
        if (!t || !m.isMeshStandardMaterial) continue;
        if (t.env !== undefined) m.envMapIntensity = t.env;
        if (t.roughMin !== undefined && m.roughness < t.roughMin) m.roughness = t.roughMin;
        n++;
      }
    });
  }
  return n;
}

/**
 * The grain's time step (36 Hz) from the frame time.
 * @param {number} tMs
 */
export function grainStep(tMs) {
  return Math.floor(tMs / 27.78) % 997;
}
