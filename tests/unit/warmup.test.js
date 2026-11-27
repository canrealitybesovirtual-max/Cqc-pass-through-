/**
 * src/core/Warmup.js with real three r187 objects and a recording fake
 * renderer: orphans attached and detached, instance colours primed before the
 * compile, one texture upload per frame ≥ 30 ms apart, one forced-visible draw
 * to the default framebuffer, every flag restored (also on errors), baselines
 * and the dev growth check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const { warmUp, warmXR, assertStable, baselineOf, countsOf, WARM_GAP_MS } = await import('../../src/core/Warmup.js');

/** A renderer that records what the warm-up asks of it and counts programs/geometries like three does. */
function fakeRenderer({ parallel = false, throwOnRender = false } = {}) {
  const log = [];
  let nextId = 1;
  const mats = new Set(), geos = new Set();
  const r = {
    log,
    info: { programs: [], memory: { textures: 0, geometries: 0 }, render: { calls: 0 } },
    xr: { isPresenting: false, frame: null, getFrame() { return this.frame; } },
    extensions: { has: (n) => parallel && n === 'KHR_parallel_shader_compile' },
    target: 'previous-target',
    getRenderTarget() { return this.target; },
    setRenderTarget(t) { this.target = t; },
    compile(scene) { log.push({ op: 'compile', scene, children: [...scene.children] }); this.program(scene, false); return new Set(); },
    compileAsync(scene) { log.push({ op: 'compileAsync', scene }); this.program(scene, false); return Promise.resolve(scene); },
    initTexture(t) { log.push({ op: 'tex', t, at: this.now }); this.info.memory.textures++; },
    render(scene) {
      if (throwOnRender) throw new Error('driver lost');
      const drawn = [];
      // what three's projectObject would draw: visible chain, LOD auto-switching, frustum culling (camera sees nothing here)
      scene.traverseVisible((o) => { if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.frustumCulled === false) drawn.push(o); });
      const lods = [];
      scene.traverse((o) => { if (o.isLOD) lods.push(o.autoUpdate); });
      log.push({ op: 'render', scene, target: this.target, drawn, lods, counts: drawn.map((o) => o.count) });
      this.info.render.calls += drawn.filter((o) => !o.isInstancedMesh || o.count > 0).length;
      this.program(scene, true);
    },
    program(scene, draw) {
      scene.traverse((o) => {
        if (!o.material) return;
        if (!mats.has(o.material)) { mats.add(o.material); this.info.programs.push({ id: nextId++, name: o.material.type }); }
        if (draw && !geos.has(o.geometry)) { geos.add(o.geometry); this.info.memory.geometries++; }
      });
    },
    now: 0,
  };
  return r;
}

/** Fake clock: each animation frame is 16.7 ms. */
function frames(r) {
  return { now: () => r.now, frame: async () => { r.now += 16.7; } };
}

function world() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(), new THREE.DirectionalLight());
  const shared = new THREE.Texture({ width: 4, height: 4 }); shared.needsUpdate = true;
  const own = new THREE.Texture({ width: 4, height: 4 }); own.needsUpdate = true;
  const uniformTex = new THREE.DataTexture(new Uint8Array(16), 2, 2); uniformTex.needsUpdate = true;
  const pending = new THREE.Texture(); // version 0: no data yet
  const rt = new THREE.WebGLRenderTarget(4, 4);

  const hiddenInScene = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: shared, normalMap: own }));
  hiddenInScene.visible = false;
  scene.add(hiddenInScene);

  // an orphan pool: hidden group, an empty instanced pool without instanceColor, a culled mesh
  const pool = new THREE.Group();
  pool.visible = false;
  const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: shared }), 8);
  inst.count = 0;
  const culled = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.ShaderMaterial({ uniforms: { tMap: { value: uniformTex }, tRT: { value: rt.texture }, tPending: { value: pending } } }));
  pool.add(inst, culled);

  // an orphan LOD with three levels; only one is visible at a time
  const lod = new THREE.LOD();
  const levels = [0, 4, 9].map((d) => { const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()); lod.addLevel(m, d); return m; });
  levels[1].visible = false; levels[2].visible = false;

  return { scene, pool, inst, culled, lod, levels, hiddenInScene, textures: { shared, own, uniformTex, pending, rt } };
}

test('warmUp: orphans in a scene, instanceColor primed, compile, uploads, one forced draw to the default framebuffer, all restored', async () => {
  const r = fakeRenderer();
  const w = world();
  const progress = [];
  const rep = await warmUp(/** @type {any} */ (r), [w.scene], [w.pool, w.lod, w.levels[2]], (f, label) => progress.push([f, label]), frames(r));

  // compile ran with the orphans attached and instanceColor already present (it is part of the program key)
  const c = r.log.find((e) => e.op === 'compile');
  assert.ok(c && c.children.includes(w.pool) && c.children.includes(w.lod), 'orphans attached to the scene for the compile');
  assert.ok(w.inst.instanceColor, 'setColorAt(0, white) primed the pool');
  assert.deepEqual([...w.inst.instanceColor.array.slice(0, 3)], [1, 1, 1]);
  assert.equal(rep.primed, 1);

  // textures: each unique one once, render-target and data-less textures skipped, ≥ 30 ms apart, one per frame
  const tex = r.log.filter((e) => e.op === 'tex');
  assert.deepEqual(new Set(tex.map((e) => e.t)), new Set([w.textures.shared, w.textures.own, w.textures.uniformTex]));
  assert.equal(tex.length, 3);
  assert.equal(rep.textureCount, 3);
  assert.equal(rep.skippedTextures, 2);
  for (let i = 1; i < tex.length; i++) assert.ok(tex[i].at - tex[i - 1].at >= WARM_GAP_MS, `upload gap ${tex[i].at - tex[i - 1].at} ms`);
  assert.ok(r.log.findIndex((e) => e.op === 'tex') > r.log.findIndex((e) => e.op === 'compile'), 'uploads after the compile');

  // the draw: default framebuffer, every drawable (hidden ones, all LOD levels, the empty pool with 1 instance)
  const d = r.log.filter((e) => e.op === 'render');
  assert.equal(d.length, 1, 'one draw per scene');
  assert.equal(d[0].target, null, 'setRenderTarget(null) for the draw');
  for (const o of [w.hiddenInScene, w.inst, w.culled, ...w.levels]) assert.ok(d[0].drawn.includes(o), `${o.type} drawn`);
  assert.deepEqual(d[0].lods, [false], 'LOD auto-switching off during the draw');
  assert.equal(d[0].counts[d[0].drawn.indexOf(w.inst)], 1, 'empty pool drawn with one instance');
  assert.equal(rep.drawables, 6);
  assert.equal(rep.attached, 2);

  // restored
  assert.equal(w.pool.parent, null);
  assert.equal(w.lod.parent, null);
  assert.equal(w.pool.visible, false);
  assert.equal(w.hiddenInScene.visible, false);
  assert.deepEqual(w.levels.map((m) => m.visible), [true, false, false]);
  assert.equal(w.inst.count, 0);
  assert.equal(w.culled.frustumCulled, true);
  assert.equal(w.lod.autoUpdate, true);
  assert.equal(r.target, 'previous-target');
  assert.equal(w.scene.children.length, 3);

  // baseline and progress
  assert.deepEqual(baselineOf(r), { ...countsOf(r), at: 'warmUp' });
  assert.equal(rep.programs, r.info.programs.length);
  assert.ok(rep.programs > 0 && rep.textures === 3 && rep.geometries > 0);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0], 'progress only moves forward');
  assert.deepEqual(progress.at(-1), [1, 'done']);
});

test('warmUp: compileAsync when the parallel-compile extension exists; scenes that own an object are added', async () => {
  const r = fakeRenderer({ parallel: true });
  const a = world(), fp = new THREE.Scene();
  const gun = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  fp.add(gun);
  const rep = await warmUp(/** @type {any} */ (r), [{ scene: a.scene }], [gun], undefined, frames(r));
  assert.deepEqual(r.log.filter((e) => e.op === 'compileAsync').map((e) => e.scene), [a.scene, fp]);
  assert.equal(r.log.filter((e) => e.op === 'compile').length, 0);
  assert.deepEqual(r.log.filter((e) => e.op === 'render').map((e) => e.scene), [a.scene, fp]);
  assert.equal(rep.scenes, 2);
  assert.equal(gun.parent, fp, 'an object already in a scene stays where it is');
});

test('warmUp refuses to run during XR and restores everything when a step throws', async () => {
  const r = fakeRenderer();
  r.xr.isPresenting = true;
  const w = world();
  await assert.rejects(warmUp(/** @type {any} */ (r), [w.scene], [w.pool], undefined, frames(r)), /before XR/);
  assert.equal(w.pool.parent, null);

  const r2 = fakeRenderer({ throwOnRender: true });
  await assert.rejects(warmUp(/** @type {any} */ (r2), [w.scene], [w.pool, w.lod], undefined, frames(r2)), /driver lost/);
  assert.equal(w.pool.parent, null);
  assert.equal(w.lod.parent, null);
  assert.equal(w.pool.visible, false);
  assert.equal(w.inst.count, 0);
  assert.equal(w.culled.frustumCulled, true);
  assert.equal(w.lod.autoUpdate, true);
  assert.equal(r2.target, 'previous-target');
  assert.equal(baselineOf(r2), null, 'no baseline from a failed warm-up');

  await assert.rejects(warmUp(/** @type {any} */ (fakeRenderer()), [], [w.pool], undefined, frames(r2)), /need at least one scene/);
});

test('assertStable: flat after the warm-up; growth is logged once per change with the new program names', async () => {
  const r = fakeRenderer();
  assert.equal(assertStable(/** @type {any} */ (r), () => assert.fail('no baseline, no log')).checked, false);
  const w = world();
  await warmUp(/** @type {any} */ (r), [w.scene], [w.pool], undefined, frames(r));
  const logs = [];
  const log = (m) => logs.push(m);
  const s1 = assertStable(/** @type {any} */ (r), log);
  assert.equal(s1.ok, true);
  assert.equal(s1.checked, true);
  assert.equal(logs.length, 0);

  // a material nobody warmed shows up in play
  const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhongMaterial());
  w.scene.add(late);
  late.frustumCulled = false;
  r.render(w.scene);
  const s2 = assertStable(/** @type {any} */ (r), log);
  assert.equal(s2, s1, 'the same result object every call (no allocation)');
  assert.equal(s2.ok, false);
  assert.equal(s2.programs, 1);
  assert.equal(s2.geometries, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /programs \+1, textures 0, geometries \+1 \(new programs: MeshPhongMaterial\)/);
  assertStable(/** @type {any} */ (r), log);
  assert.equal(logs.length, 1, 'the same growth is not logged again');
  r.initTexture(new THREE.Texture());
  assertStable(/** @type {any} */ (r), log);
  assert.equal(logs.length, 2, 'new growth is logged');
});

test('warmXR: skipped outside the XR frame; inside it draws once, reports growth and moves the baseline', async () => {
  const r = fakeRenderer();
  const w = world();
  await warmUp(/** @type {any} */ (r), [w.scene], [w.lod], undefined, frames(r));
  const base = baselineOf(r);
  r.xr.isPresenting = true;
  const camera = new THREE.PerspectiveCamera();
  const skip = warmXR(/** @type {any} */ (r), w.scene, camera, [w.pool]);
  assert.match(skip.skipped, /outside/);
  assert.equal(r.log.filter((e) => e.op === 'render').length, 1, 'no draw outside the frame');
  assert.equal(w.pool.parent, null);

  r.xr.frame = {};
  const rep = warmXR(/** @type {any} */ (r), w.scene, camera, [w.pool]);
  assert.equal(rep.skipped, '');
  const d = r.log.filter((e) => e.op === 'render').at(-1);
  assert.equal(d.target, 'previous-target', 'draws into the current (XR) target');
  for (const o of [w.inst, w.culled, w.hiddenInScene]) assert.ok(d.drawn.includes(o));
  assert.equal(rep.attached, 1);
  assert.equal(w.pool.parent, null, 'detached again');
  assert.equal(w.pool.visible, false);
  // the pool was not in the pre-XR warm-up: its programs and geometries show up as growth
  assert.ok(rep.grew.programs > 0 && rep.grew.geometries > 0, JSON.stringify(rep.grew));
  assert.equal(rep.programs, base.programs + rep.grew.programs);
  assert.equal(baselineOf(r).at, 'warmXR');
  assert.equal(assertStable(/** @type {any} */ (r), () => assert.fail('flat after warmXR')).ok, true);
});
