/**
 * DepthOcclusion.js (the three.js part, no GPU): the onBeforeCompile patch,
 * program-key chaining, idempotency, clone safety, and the per-frame
 * controller against a fake renderer.xr. The GPU side (compile, sampling,
 * eye selection, fade/dither output) is tests/e2e/depth-occlusion.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const {
  applySoftOcclusion, isSoftOccluded, setSoftOcclusionBias, softOcclusionUniforms: U, DepthOcclusion,
  SOFT_OCCLUSION_KEY, SOFT_OCCLUSION_CHUNKS, OCCLUSION_BIAS,
} = await import('../../src/xr/DepthOcclusion.js');

/** A shader object as three passes to onBeforeCompile (r187 ShaderLib sources). */
function shaderFor(lib) {
  const S = THREE.ShaderLib[lib];
  return { vertexShader: S.vertexShader, fragmentShader: S.fragmentShader, uniforms: THREE.UniformsUtils.clone(S.uniforms) };
}

/** Resolve #include like WebGLProgram does (to read the final GLSL). */
function resolve(src) {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const s = THREE.ShaderChunk[name];
    if (s === undefined) throw new Error(`no chunk ${name}`);
    return resolve(s);
  });
}

test('the chunks are registered in THREE.ShaderChunk', () => {
  for (const name of Object.values(SOFT_OCCLUSION_CHUNKS)) assert.equal(typeof THREE.ShaderChunk[name], 'string', name);
  assert.match(THREE.ShaderChunk.softocc_pars_fragment, /uniform sampler2DArray occDepth;/);
  assert.match(THREE.ShaderChunk.softocc_vertex, /vOccViewZ = - mvPosition\.z;/);
});

for (const [Mat, lib] of [[THREE.MeshStandardMaterial, 'standard'], [THREE.MeshBasicMaterial, 'basic'], [THREE.MeshPhysicalMaterial, 'physical']]) {
  test(`${Mat.name}: chunks injected at the right places, shared uniforms bound`, () => {
    const m = applySoftOcclusion(new Mat(), { bias: 0.03 });
    assert.equal(isSoftOccluded(m), true);
    const sh = shaderFor(lib);
    m.onBeforeCompile(sh, /** @type {any} */ (null));
    const vs = sh.vertexShader, fs = sh.fragmentShader;
    assert.ok(vs.indexOf('#include <softocc_pars_vertex>') > vs.indexOf('#include <common>'));
    assert.ok(vs.indexOf('#include <softocc_vertex>') > vs.indexOf('#include <project_vertex>'), 'after mvPosition exists');
    assert.ok(fs.indexOf('#include <softocc_pars_fragment>') > fs.indexOf('#include <common>'));
    const main = fs.indexOf('void main() {');
    const begin = fs.indexOf('#include <softocc_fragment_begin>');
    assert.ok(begin > main && begin > fs.indexOf('#include <clipping_planes_fragment>') && begin < fs.indexOf('#include <opaque_fragment>'), 'begin at the top of main');
    assert.ok(fs.indexOf('#include <softocc_fragment_end>') > fs.indexOf('#include <premultiplied_alpha_fragment>'), 'end after the final colour');
    for (const k of ['occDepth', 'occVp0', 'occVp1', 'occState', 'occBand', 'occLinear']) assert.equal(sh.uniforms[k], U[k], `${k} is the shared object`);
    assert.deepEqual(sh.uniforms.occBias, { value: 0.03 });
    // the resolved GLSL contains every piece once
    const rfs = resolve(fs), rvs = resolve(vs);
    assert.equal(rfs.split('float occVisibility()').length, 2);
    assert.equal(rvs.split('varying float vOccViewZ;').length, 2);
    assert.match(rfs, /gl_FragColor \*= occVis;/);
    assert.equal(m.customProgramCacheKey(), Mat.prototype.onBeforeCompile.toString() + SOFT_OCCLUSION_KEY);
  });
}

test('the program key is constant and shared by every patched material', () => {
  const a = applySoftOcclusion(new THREE.MeshStandardMaterial());
  const b = applySoftOcclusion(new THREE.MeshStandardMaterial({ color: 0xff0000 }), { bias: 0.05 });
  assert.equal(a.customProgramCacheKey(), b.customProgramCacheKey());
  assert.equal(a.customProgramCacheKey(), a.customProgramCacheKey());
  assert.notEqual(a.customProgramCacheKey(), new THREE.MeshStandardMaterial().customProgramCacheKey(), 'differs from unpatched');
});

test('chains an earlier onBeforeCompile hook and its program key (WeaponView-style)', () => {
  const m = new THREE.MeshStandardMaterial();
  let calls = 0;
  m.onBeforeCompile = (shader) => {
    calls++;
    shader.uniforms.uPart = { value: [] };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 uPart[5];')
      .replace('#include <project_vertex>', '// part hook saw project_vertex\n#include <project_vertex>');
  };
  m.customProgramCacheKey = () => 'w2-part';
  applySoftOcclusion(m);
  assert.equal(m.customProgramCacheKey(), 'w2-part' + SOFT_OCCLUSION_KEY);
  const sh = shaderFor('standard');
  m.onBeforeCompile(sh, /** @type {any} */ (null));
  assert.equal(calls, 1);
  assert.ok(sh.uniforms.uPart && sh.uniforms.occDepth === U.occDepth);
  assert.match(sh.vertexShader, /uniform mat4 uPart\[5\];/);
  assert.match(sh.vertexShader, /part hook saw project_vertex/);
  assert.match(sh.vertexShader, /#include <softocc_vertex>/);
});

test('idempotent; a later hook that replaces ours is detected; clones are not patched', () => {
  const m = applySoftOcclusion(new THREE.MeshBasicMaterial(), { bias: 0.01 });
  const hook = m.onBeforeCompile, key = m.customProgramCacheKey();
  applySoftOcclusion(m, { bias: 0.02 });
  assert.equal(m.onBeforeCompile, hook, 'no double wrap');
  assert.equal(m.customProgramCacheKey(), key);
  const sh = shaderFor('basic');
  m.onBeforeCompile(sh, /** @type {any} */ (null));
  assert.equal(sh.vertexShader.split('#include <softocc_vertex>').length, 2, 'injected once');
  assert.equal(sh.uniforms.occBias.value, 0.02, 'second call updates the bias');
  assert.equal(setSoftOcclusionBias(m, 0.04), true);
  assert.equal(sh.uniforms.occBias.value, 0.04, 'bias is a live uniform');

  const c = m.clone(); // Material.copy JSON-copies userData and does not copy hooks
  assert.equal(isSoftOccluded(c), false);
  assert.equal(setSoftOcclusionBias(c, 1), false);

  m.onBeforeCompile = () => {}; // someone hooked it after us
  assert.equal(isSoftOccluded(m), false);
});

test('ShaderMaterial: needs the chunks, then gets the shared uniforms (program key = its source)', () => {
  const vertexShader = `#include <softocc_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  #include <softocc_vertex>
  gl_Position = projectionMatrix * mvPosition;
}`;
  const fragmentShader = `#include <softocc_pars_fragment>
void main() {
  #include <softocc_fragment_begin>
  gl_FragColor = vec4( 1.0 );
  #include <softocc_fragment_end>
}`;
  const m = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uX: { value: 1 } }, transparent: true, premultipliedAlpha: true });
  applySoftOcclusion(m, { bias: OCCLUSION_BIAS.decal });
  assert.equal(isSoftOccluded(m), true);
  assert.equal(m.uniforms.occState, U.occState);
  assert.equal(m.uniforms.occBias.value, 0.05);
  assert.equal(m.uniforms.uX.value, 1, 'own uniforms kept');
  assert.throws(() => applySoftOcclusion(new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' })), /lacks #include <softocc_pars_vertex>/);
  assert.throws(() => applySoftOcclusion(new THREE.RawShaderMaterial({ vertexShader, fragmentShader })), /RawShaderMaterial/);
});

test('unsupported materials throw at load, not at compile', () => {
  for (const m of [new THREE.MeshLambertMaterial(), new THREE.MeshPhongMaterial(), new THREE.SpriteMaterial(), new THREE.PointsMaterial(), new THREE.LineBasicMaterial()]) {
    assert.throws(() => applySoftOcclusion(m), TypeError, m.type);
  }
});

test('a shader without the anchors is left unpatched with one warning', () => {
  const m = applySoftOcclusion(new THREE.MeshBasicMaterial());
  const sh = { vertexShader: 'void main() {}', fragmentShader: 'void main() {}', uniforms: {} };
  const warn = console.warn; const msgs = [];
  console.warn = (s) => msgs.push(s);
  try { m.onBeforeCompile(sh, /** @type {any} */ (null)); m.onBeforeCompile({ ...sh, uniforms: {} }, /** @type {any} */ (null)); } finally { console.warn = warn; }
  assert.equal(sh.vertexShader, 'void main() {}');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /not patched/);
});

// ---------------------------------------------------------------------------
// Controller against a fake renderer.xr

function fakeRenderer() {
  const listeners = new Map();
  const depthMesh = { visible: true };
  const xr = {
    isPresenting: true,
    /** @type {any} */ texture: null,
    meshCalls: 0,
    getDepthTexture() { return this.texture; },
    getDepthSensingMesh() { this.meshCalls++; return this.texture ? depthMesh : null; },
    camera: {
      near: 0.05, far: 50,
      cameras: [{ viewport: new THREE.Vector4(0, 0, 1680, 1760) }, { viewport: new THREE.Vector4(1680, 0, 1680, 1760) }],
    },
    getCamera() { return this.camera; },
    addEventListener(t, f) { listeners.set(t, (listeners.get(t) || new Set()).add(f)); },
    removeEventListener(t, f) { listeners.get(t)?.delete(f); },
    dispatch(t) { for (const f of listeners.get(t) || []) f({ type: t }); },
    listeners,
  };
  return { xr, depthMesh };
}

test('controller: gate stays off until depth has been seen for warmFrames; three mesh hidden after', () => {
  const { xr, depthMesh } = fakeRenderer();
  const occ = new DepthOcclusion().enable(/** @type {any} */ ({ xr }));
  assert.equal(occ.update(), false, 'no depth texture yet');
  assert.equal(U.occState.value.x, 0);

  xr.texture = { isExternalTexture: true };
  assert.equal(occ.update(), false, 'frame 1 with depth: three draws its own mesh once (warm) and sets near/far');
  assert.equal(depthMesh.visible, true);
  assert.equal(U.occState.value.x, 0);
  xr.camera.near = 0.1; xr.camera.far = Infinity; // what three's updateCamera does in that frame's render

  assert.equal(occ.update(), true, 'frame 2: soft live');
  assert.equal(occ.active, true);
  assert.equal(U.occState.value.x, 1);
  assert.equal(depthMesh.visible, false, 'hard occlusion hidden');
  assert.equal(occ.threeMeshVisible, false);
  assert.equal(U.occDepth.value, xr.texture);
  assert.deepEqual(U.occVp0.value.toArray(), [0, 0, 1680, 1760]);
  assert.deepEqual(U.occVp1.value.toArray(), [1680, 0, 1680, 1760]);
  assert.deepEqual(U.occLinear.value.toArray(), [0.1, 1], 'infinite far: a = near, b = 1');

  depthMesh.visible = true; // e.g. an fpScene pass restored it to true
  occ.update();
  assert.equal(depthMesh.visible, false, 'hidden again every frame');

  occ.disable();
  assert.equal(depthMesh.visible, true, 'disable restores three\'s hard occlusion');
  assert.equal(U.occState.value.x, 0);
  assert.equal(U.occDepth.value, null);
  assert.equal(occ.update(), false, 'disabled: update is a no-op');
  assert.equal(xr.listeners.get('sessionend').size, 0, 'listeners removed');
});

test('controller: one view, finite far, lost depth and session end', () => {
  const { xr, depthMesh } = fakeRenderer();
  xr.texture = { isExternalTexture: true };
  xr.camera.cameras.length = 1;
  xr.camera.near = 0.1; xr.camera.far = 20;
  const occ = new DepthOcclusion({ warmFrames: 0 }).enable(/** @type {any} */ ({ xr }));
  assert.equal(occ.update(), true);
  assert.equal(U.occVp1.value.x, 1e9, 'one view: never the right eye');
  const k = 20 / 19.9;
  assert.ok(Math.abs(U.occLinear.value.x - 0.1 * k) < 1e-6 && Math.abs(U.occLinear.value.y - k) < 1e-6);

  xr.texture = null; // depth lost
  assert.equal(occ.update(), false);
  assert.equal(U.occState.value.x, 0);
  xr.texture = { isExternalTexture: true };
  occ.update();
  assert.equal(U.occState.value.x, 1);

  xr.dispatch('sessionend');
  assert.equal(U.occState.value.x, 0);
  assert.equal(U.occDepth.value, null, 'no stale WebGLTexture bound after the session');
  assert.equal(occ.threeMeshVisible, true, 'three dropped its mesh; nothing to restore');
  xr.isPresenting = false;
  assert.equal(occ.update(), false, 'not presenting');
  void depthMesh;
  occ.disable();
});

test('controller: options are uniforms; overrides for desktop tests', () => {
  const { xr } = fakeRenderer();
  const occ = new DepthOcclusion({ band: 0.06, bandGrowth: 0.01, dither: true, pcf: false, maxMetres: 30, noDataRaw: 0 });
  assert.deepEqual(U.occBand.value.toArray(), [0.06, 0.01, 0]);
  assert.deepEqual(U.occState.value.toArray(), [0, 1, 0, 30]);
  occ.configure({ dither: false, pcf: true });
  assert.deepEqual(U.occState.value.toArray(), [0, 0, 1, 30]);

  const fake = { isDataArrayTexture: true };
  occ.enable(/** @type {any} */ ({ xr })).setTestDepth(/** @type {any} */ (fake)).setViewports(0, 0, 64, 32, 64, 0, 64, 32).setDepthRange(0.1, Infinity);
  xr.isPresenting = false;
  occ.update(); // warm frame
  assert.equal(occ.update(), true, 'test depth works without XR');
  assert.equal(U.occDepth.value, fake);
  assert.equal(xr.meshCalls, 0, 'three\'s mesh untouched in test mode');
  assert.deepEqual(U.occVp1.value.toArray(), [64, 0, 64, 32]);
  occ.disable();
  occ.configure({ band: 0.08, bandGrowth: 0, dither: false, pcf: true, maxMetres: 50, noDataRaw: -1 });
});

test('controller: update() does not allocate', () => {
  const { xr } = fakeRenderer();
  xr.texture = { isExternalTexture: true };
  xr.camera.near = 0.1; xr.camera.far = Infinity;
  const occ = new DepthOcclusion().enable(/** @type {any} */ ({ xr }));
  for (let i = 0; i < 1000; i++) occ.update();
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) occ.update();
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 1_000_000, `heap grew ${grew} bytes over 200k updates`);
  occ.disable();
});
