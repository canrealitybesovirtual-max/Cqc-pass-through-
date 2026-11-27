// @ts-check
import * as THREE from 'three';

/**
 * Warm-up: no first-use hitches (docs/PLAN.md §10, docs/CONTRACTS.md "Integration").
 *
 * In r187 `compileAsync` only builds programs. Without KHR_parallel_shader_compile
 * (the Quest 3 has none, DEVICE_LOG p1.0) its promise resolves after a 10 ms
 * timeout and the blocking link wait happens at the first draw; and compiling
 * never uploads textures, vertex/index buffers or skeleton bone textures. So the
 * warm-up is a draw, not just a compile:
 *
 *   1. every object is put in a scene (orphans are attached to `scenes[0]`, which
 *      carries the fixed light set, and detached again afterwards);
 *      `setColorAt(0, white)` primes every InstancedMesh whose `instanceColor` is
 *      null (instanceColor is part of the program key);
 *   2. `renderer.compileAsync` per scene;
 *   3. `renderer.initTexture` for every texture found, one per animation frame and
 *      at least `gapMs` (30 ms, CQC's measured safe rate) apart;
 *   4. one render per scene to the DEFAULT framebuffer (`setRenderTarget(null)`:
 *      toneMapping/outputColorSpace in the program key depend on the target) with
 *      every drawable forced visible (all LOD levels, hidden pool members, empty
 *      instanced pools drawn with count 1) and frustum culling off, then every
 *      flag is restored;
 *   5. `renderer.info.programs.length`, `info.memory.textures` and
 *      `info.memory.geometries` are recorded as the baseline.
 *
 * Inside XR, `warmXR` draws the same set once into the XR framebuffer (call it in
 * the first XR frame, before the frame's own render, while an opaque "Get ready"
 * panel covers the view) and moves the baseline to include what XR itself creates.
 * `assertStable` (dev builds) logs when the counts grow after the baseline.
 *
 * Call `warmUp` AFTER every pool, view and panel exists and after every
 * `onBeforeCompile` / `customProgramCacheKey` is installed: anything created or
 * re-keyed later is not warm. It may be called again (it re-records the baseline).
 *
 * Usage:
 *   const report = await warmUp(renderer, [scene, fpScene], pools, (f, label) => bar(f), { camera });
 *   // in the first XR frame of a play session:
 *   warmXR(renderer, scene, camera, pools);
 *   // dev builds, e.g. once per second or at session end:
 *   const s = assertStable(renderer); if (!s.ok) rec.warmGrowth = { ...s };
 */

/**
 * @typedef {Object} WarmCounts
 * @property {number} programs   renderer.info.programs.length
 * @property {number} textures   renderer.info.memory.textures
 * @property {number} geometries renderer.info.memory.geometries
 */

/**
 * @typedef {Object} WarmReport
 * @property {number} ms          total wall time
 * @property {number} compileMs
 * @property {number} textureMs
 * @property {number} drawMs
 * @property {number} scenes      scenes compiled and drawn
 * @property {number} attached    orphan roots attached for the warm-up (and detached after)
 * @property {number} drawables   meshes, lines, points and sprites drawn
 * @property {number} lods        LOD objects with every level forced visible
 * @property {number} primed      InstancedMeshes given an instanceColor
 * @property {number} textureCount textures passed to initTexture
 * @property {number} skippedTextures textures without data yet (version 0) or render-target textures
 * @property {number} calls       draw calls of the warm draw
 * @property {number} programs    baseline: renderer.info.programs.length
 * @property {number} textures    baseline: renderer.info.memory.textures
 * @property {number} geometries  baseline: renderer.info.memory.geometries
 * @property {WarmCounts} before  the counts before the warm-up
 */

/**
 * @typedef {Object} WarmXRReport
 * @property {string} skipped     '' when the draw ran, else why not
 * @property {number} ms
 * @property {number} drawables
 * @property {number} calls
 * @property {number} attached
 * @property {number} primed
 * @property {WarmCounts} grew    growth over the previous baseline (what the pre-XR warm-up missed, or XR's own resources)
 * @property {number} programs    new baseline
 * @property {number} textures
 * @property {number} geometries
 */

/**
 * @typedef {Object} StableResult
 * @property {boolean} checked  a baseline exists for this renderer
 * @property {boolean} ok       no count grew
 * @property {number} programs  growth since the baseline (can be negative)
 * @property {number} textures
 * @property {number} geometries
 */

/**
 * @typedef {{ programs: number, textures: number, geometries: number, ids: Set<number>,
 *   at: string, warned: number, lastP: number, lastT: number, lastG: number }} Baseline
 */

export const WARM_GAP_MS = 30;

const WHITE = new THREE.Color(1, 1, 1);
/** @type {WeakMap<object, Baseline>} */
const baselines = new WeakMap();
/** @type {THREE.PerspectiveCamera|null} */
let fallbackCamera = null;

/** @returns {number} */
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Resolves on the next animation frame. Falls back to a 100 ms timer, so a
 * hidden tab (rAF paused) slows the warm-up down instead of stalling it.
 * @returns {Promise<void>}
 */
export function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

/**
 * The renderer's current counts.
 * @param {any} renderer
 * @returns {WarmCounts}
 */
export function countsOf(renderer) {
  const info = renderer.info;
  return {
    programs: info.programs ? info.programs.length : 0,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
  };
}

/**
 * The last recorded baseline for this renderer, or null.
 * @param {any} renderer
 * @returns {WarmCounts & { at: string }|null}
 */
export function baselineOf(renderer) {
  const b = baselines.get(renderer);
  return b ? { programs: b.programs, textures: b.textures, geometries: b.geometries, at: b.at } : null;
}

/**
 * @param {any} renderer
 * @param {string} at  which step recorded it
 * @returns {Baseline}
 */
function recordBaseline(renderer, at) {
  const c = countsOf(renderer);
  /** @type {Set<number>} */
  const ids = new Set();
  const progs = renderer.info.programs || [];
  for (let i = 0; i < progs.length; i++) ids.add(progs[i].id);
  /** @type {Baseline} */
  const b = { programs: c.programs, textures: c.textures, geometries: c.geometries, ids, at, warned: 0, lastP: 0, lastT: 0, lastG: 0 };
  baselines.set(renderer, b);
  return b;
}

// ---------------------------------------------------------------- the warm set

/**
 * @typedef {Object} WarmSet
 * @property {THREE.Scene[]} scenes
 * @property {THREE.Object3D[]} roots   orphan roots attached for the warm-up
 * @property {THREE.Object3D[]} hosts   the scene each root was attached to
 * @property {THREE.Object3D[]} drawables
 * @property {THREE.LOD[]} lods
 * @property {THREE.Texture[]} textures
 * @property {number} skippedTextures
 * @property {number} primed
 */

/**
 * @param {any} entry
 * @returns {THREE.Scene|null}
 */
const sceneOf = (entry) => (entry && entry.isScene ? entry : entry && entry.scene && entry.scene.isScene ? entry.scene : null);

/**
 * @param {any} o
 * @returns {boolean}
 */
const isDrawable = (o) => !!(o.isMesh || o.isLine || o.isPoints || o.isSprite);

/**
 * @param {any} v
 * @param {Set<THREE.Texture>} into
 */
function addTexture(v, into) {
  if (!v) return;
  if (v.isTexture) { into.add(v); return; }
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) if (v[i] && v[i].isTexture) into.add(v[i]);
}

/**
 * Every texture a material references: its own texture slots (map, normalMap,
 * …, whatever the material type) and ShaderMaterial uniforms.
 * @param {any} mat
 * @param {Set<THREE.Texture>} into
 */
function materialTextures(mat, into) {
  if (!mat) return;
  for (const k of Object.keys(mat)) {
    if (k === 'uniforms' || k === 'userData') continue;
    addTexture(mat[k], into);
  }
  const u = mat.uniforms;
  if (u) for (const k of Object.keys(u)) if (u[k]) addTexture(u[k].value, into);
}

/**
 * Attach orphans, prime instance colours and collect drawables, LODs and textures.
 * @param {THREE.Scene[]} sceneList  mutated: scenes that own an object are appended
 * @param {readonly (THREE.Object3D|null|undefined)[]} objects
 * @param {THREE.Scene|null} host  where orphans go
 * @returns {WarmSet}
 */
function gather(sceneList, objects, host) {
  /** @type {WarmSet} */
  const set = { scenes: sceneList, roots: [], hosts: [], drawables: [], lods: [], textures: [], skippedTextures: 0, primed: 0 };
  for (const obj of objects || []) {
    if (!obj || !obj.isObject3D) continue;
    let root = obj;
    while (root.parent) root = root.parent;
    if (/** @type {any} */ (root).isScene) {
      if (!sceneList.includes(/** @type {THREE.Scene} */ (root))) sceneList.push(/** @type {THREE.Scene} */ (root));
      continue;
    }
    if (set.roots.includes(root)) continue;
    if (!host) throw new Error('warm-up: objects outside a scene need at least one scene (it carries the light set)');
    host.add(root);
    set.roots.push(root);
    set.hosts.push(host);
  }
  /** @type {Set<THREE.Texture>} */
  const tex = new Set();
  /** @type {Set<THREE.Object3D>} */
  const seen = new Set();
  for (const scene of sceneList) {
    addTexture(scene.background, tex);
    addTexture(scene.environment, tex);
    scene.traverse((o) => {
      if (seen.has(o)) return;
      seen.add(o);
      const a = /** @type {any} */ (o);
      if (a.isLOD) set.lods.push(/** @type {THREE.LOD} */ (o));
      if (!isDrawable(a)) return;
      set.drawables.push(o);
      if (a.isInstancedMesh && a.instanceColor === null && a.instanceMatrix && a.instanceMatrix.count > 0) {
        a.setColorAt(0, WHITE);
        set.primed++;
      }
      const m = a.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) materialTextures(m[i], tex);
      else materialTextures(m, tex);
    });
  }
  for (const t of tex) {
    const a = /** @type {any} */ (t);
    // render-target textures are allocated by their target; a version-0 texture has no data to upload yet
    if (a.isRenderTargetTexture || a.version === 0) { set.skippedTextures++; continue; }
    set.textures.push(t);
  }
  return set;
}

/** @param {WarmSet} set */
function detach(set) {
  for (let i = set.roots.length - 1; i >= 0; i--) set.hosts[i].remove(set.roots[i]);
  set.roots.length = 0;
  set.hosts.length = 0;
}

/**
 * Saved flags for one forced draw, restored in reverse order.
 * @typedef {{ objs: THREE.Object3D[], vis: boolean[], culled: THREE.Object3D[], cull: boolean[],
 *   inst: any[], count: number[], lods: THREE.LOD[], auto: boolean[] }} Forced
 */

/**
 * Make every drawable render: it and its ancestors visible, frustum culling off,
 * empty instanced pools drawn with one instance, LOD auto-switching off (every
 * level is a drawable child and is forced visible itself).
 * @param {WarmSet} set
 * @returns {Forced}
 */
function force(set) {
  /** @type {Forced} */
  const f = { objs: [], vis: [], culled: [], cull: [], inst: [], count: [], lods: [], auto: [] };
  /** @type {Set<THREE.Object3D>} */
  const saved = new Set();
  for (const d of set.drawables) {
    /** @type {THREE.Object3D|null} */
    let o = d;
    while (o && !saved.has(o)) {
      saved.add(o);
      f.objs.push(o);
      f.vis.push(o.visible);
      o.visible = true;
      o = o.parent;
    }
    f.culled.push(d);
    f.cull.push(d.frustumCulled);
    d.frustumCulled = false;
    const a = /** @type {any} */ (d);
    if (a.isInstancedMesh && a.count === 0 && a.instanceMatrix && a.instanceMatrix.count > 0) {
      f.inst.push(a);
      f.count.push(a.count);
      a.count = 1;
    }
  }
  for (const l of set.lods) {
    f.lods.push(l);
    f.auto.push(l.autoUpdate);
    l.autoUpdate = false;
  }
  return f;
}

/** @param {Forced} f */
function restore(f) {
  for (let i = f.lods.length - 1; i >= 0; i--) f.lods[i].autoUpdate = f.auto[i];
  for (let i = f.inst.length - 1; i >= 0; i--) f.inst[i].count = f.count[i];
  for (let i = f.culled.length - 1; i >= 0; i--) f.culled[i].frustumCulled = f.cull[i];
  for (let i = f.objs.length - 1; i >= 0; i--) f.objs[i].visible = f.vis[i];
}

/**
 * @param {THREE.Camera|undefined} camera
 * @returns {THREE.Camera}
 */
function cameraFor(camera) {
  if (camera) return camera;
  if (!fallbackCamera) fallbackCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);
  return fallbackCamera;
}

// ---------------------------------------------------------------- public API

/**
 * Compile, upload and draw everything once before XR, then record the baseline.
 * Rejects (after restoring every object) if a step throws, or if called while
 * an XR session is presenting.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {readonly (THREE.Scene|{ scene: THREE.Scene })[]} scenes  the first one hosts objects that are not in a scene
 * @param {readonly (THREE.Object3D|null|undefined)[]} objects  pools, views, LOD sets, panels (in a scene or not)
 * @param {(fraction: number, label: string) => void} [onProgress]
 * @param {{ camera?: THREE.Camera, gapMs?: number, frame?: () => Promise<void>, now?: () => number }} [opt]
 *   camera: any camera with the default layer (culling is off for the draw);
 *   frame/now: injectable for tests.
 * @returns {Promise<WarmReport>}
 */
export async function warmUp(renderer, scenes, objects, onProgress, opt = {}) {
  const r = /** @type {any} */ (renderer);
  if (r.xr && r.xr.isPresenting) throw new Error('warmUp must run before XR (a default-framebuffer draw during XR goes black); use warmXR in the session');
  const now = opt.now || clock;
  const frame = opt.frame || nextFrame;
  const gap = opt.gapMs ?? WARM_GAP_MS;
  const camera = cameraFor(opt.camera);
  /** @param {number} f @param {string} label */
  const report = (f, label) => { if (onProgress) onProgress(f < 0 ? 0 : f > 1 ? 1 : f, label); };

  const t0 = now();
  const before = countsOf(r);
  /** @type {THREE.Scene[]} */
  const sceneList = [];
  for (const e of scenes || []) { const s = sceneOf(e); if (s && !sceneList.includes(s)) sceneList.push(s); }
  const set = gather(sceneList, objects, sceneList[0] || null);
  const attached = set.roots.length;
  let compileMs = 0, textureMs = 0, drawMs = 0, calls = 0;
  try {
    // 2. programs
    report(0, 'compile');
    let t = now();
    for (let i = 0; i < sceneList.length; i++) {
      if (typeof r.compileAsync === 'function') await r.compileAsync(sceneList[i], camera);
      else r.compile(sceneList[i], camera);
      report((0.3 * (i + 1)) / sceneList.length, 'compile');
    }
    compileMs = now() - t;

    // 3. textures, one per frame and ≥ gap apart
    t = now();
    let last = -Infinity;
    const n = set.textures.length;
    for (let i = 0; i < n; i++) {
      do { await frame(); } while (now() - last < gap);
      r.initTexture(set.textures[i]);
      last = now();
      report(0.3 + (0.6 * (i + 1)) / n, `texture ${i + 1}/${n}`);
    }
    textureMs = now() - t;

    // 4. one draw to the default framebuffer with everything forced visible
    await frame();
    if (r.xr && r.xr.isPresenting) throw new Error('warmUp: an XR session started during the warm-up; the default-framebuffer draw must run before XR');
    report(0.9, 'draw');
    t = now();
    const prevTarget = r.getRenderTarget();
    const callsBefore = r.info.render.calls;
    const forced = force(set);
    try {
      r.setRenderTarget(null);
      for (const s of sceneList) r.render(s, camera);
    } finally {
      restore(forced);
      r.setRenderTarget(prevTarget);
    }
    calls = r.info.render.calls - callsBefore;
    drawMs = now() - t;
  } finally {
    detach(set);
  }

  // 5. baseline
  const b = recordBaseline(r, 'warmUp');
  report(1, 'done');
  return {
    ms: now() - t0, compileMs, textureMs, drawMs,
    scenes: sceneList.length, attached, drawables: set.drawables.length, lods: set.lods.length,
    primed: set.primed, textureCount: set.textures.length, skippedTextures: set.skippedTextures, calls,
    programs: b.programs, textures: b.textures, geometries: b.geometries, before,
  };
}

/**
 * Draw the warm set once inside XR: call it in the first XR frame of a play
 * session (inside the frame callback, before the frame's own render), while an
 * opaque "Get ready" panel covers the view. The frame's own render then clears
 * and draws over it, so nothing of this draw is ever presented. Catches driver
 * variants against the real XR framebuffer and three's lazily created XR
 * resources; then moves the baseline to the counts after this draw.
 *
 * Runs only inside an XR frame (`renderer.xr.getFrame()`); elsewhere during XR
 * it does nothing and says why. Outside XR it draws to the default framebuffer.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene  hosts objects that are not in a scene
 * @param {THREE.Camera} camera  the scene camera (three substitutes the XR camera)
 * @param {readonly (THREE.Object3D|null|undefined)[]} [objects]
 * @param {{ now?: () => number }} [opt]
 * @returns {WarmXRReport}
 */
export function warmXR(renderer, scene, camera, objects = [], opt = {}) {
  const r = /** @type {any} */ (renderer);
  const now = opt.now || clock;
  const t0 = now();
  const prev = baselines.get(r) || null;
  const zero = { programs: 0, textures: 0, geometries: 0 };
  if (r.xr && r.xr.isPresenting && typeof r.xr.getFrame === 'function' && !r.xr.getFrame()) {
    const c = countsOf(r);
    return { skipped: 'outside the XR frame callback', ms: 0, drawables: 0, calls: 0, attached: 0, primed: 0, grew: zero, ...c };
  }
  const before = countsOf(r);
  const sceneList = [scene];
  const set = gather(sceneList, objects, scene);
  const attached = set.roots.length;
  const callsBefore = r.info.render.calls;
  try {
    const forced = force(set);
    try {
      for (const s of sceneList) r.render(s, camera);
    } finally {
      restore(forced);
    }
  } finally {
    detach(set);
  }
  const calls = r.info.render.calls - callsBefore;
  const ref = prev || before;
  const b = recordBaseline(r, 'warmXR');
  return {
    skipped: '', ms: now() - t0, drawables: set.drawables.length, calls, attached, primed: set.primed,
    grew: { programs: b.programs - ref.programs, textures: b.textures - ref.textures, geometries: b.geometries - ref.geometries },
    programs: b.programs, textures: b.textures, geometries: b.geometries,
  };
}

/** @type {StableResult} */
const stable = { checked: false, ok: true, programs: 0, textures: 0, geometries: 0 };

/**
 * Dev builds: have programs, textures or geometries grown since the baseline?
 * Logs once per distinct growth (with the names of the new programs), so it can
 * run every second. Allocation-free while nothing grows; returns a reused object.
 * @param {THREE.WebGLRenderer} renderer
 * @param {(msg: string) => void} [log]  default console.warn
 * @returns {StableResult}
 */
export function assertStable(renderer, log) {
  const r = /** @type {any} */ (renderer);
  const b = baselines.get(r);
  if (!b) {
    stable.checked = false; stable.ok = true; stable.programs = 0; stable.textures = 0; stable.geometries = 0;
    return stable;
  }
  const info = r.info;
  const dp = (info.programs ? info.programs.length : 0) - b.programs;
  const dt = info.memory.textures - b.textures;
  const dg = info.memory.geometries - b.geometries;
  stable.checked = true;
  stable.programs = dp;
  stable.textures = dt;
  stable.geometries = dg;
  stable.ok = dp <= 0 && dt <= 0 && dg <= 0;
  if (!stable.ok && (dp !== b.lastP || dt !== b.lastT || dg !== b.lastG)) {
    b.lastP = dp; b.lastT = dt; b.lastG = dg;
    b.warned++;
    /** @type {string[]} */
    const names = [];
    const progs = info.programs || [];
    for (let i = 0; i < progs.length; i++) if (!b.ids.has(progs[i].id)) names.push(progs[i].name || `#${progs[i].id}`);
    const msg = `[warm-up] grew after the ${b.at} baseline: programs ${sign(dp)}, textures ${sign(dt)}, geometries ${sign(dg)}`
      + (names.length ? ` (new programs: ${names.join(', ')})` : '');
    (log || console.warn)(msg);
  }
  return stable;
}

/** @param {number} n */
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
