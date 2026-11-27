// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDepth } from '../../src/xr/LiveDepth.js';

/** The browser's binding: the method lives on the prototype, as on a real XRWebGLBinding. */
class FakeBinding {
  constructor() { this.calls = 0; /** @type {any} */ this.info = null; }
  /** @param {any} _view */
  getDepthInformation(_view) { this.calls++; return this.info; }
}

/** A fake three.js renderer: just the XR calls LiveDepth uses. */
function fakeRenderer() {
  const binding = new FakeBinding();
  /** @type {any} */
  const ext = { sourceTexture: null };
  /** @type {any} */
  const mesh = { visible: true, material: { colorWrite: true } };
  const state = { hasTexture: false };
  const renderer = {
    xr: {
      getBinding: () => binding,
      getDepthTexture: () => (state.hasTexture ? ext : null),
      getDepthSensingMesh: () => (state.hasTexture ? mesh : null),
    },
  };
  return { renderer, binding, ext, mesh, state };
}

/** @param {Partial<{ enabledFeatures: string[], depthUsage: string|null, depthDataFormat: string }>} o */
const session = (o) => /** @type {any} */ ({ enabledFeatures: ['local-floor', 'depth-sensing'], depthUsage: 'gpu-optimized', depthDataFormat: 'unsigned-short', ...o });

/** three's own frame setup: ask for views[0], wrap the first valid texture once (r187 WebXRDepthSensing.init). */
function threeFrame(/** @type {ReturnType<typeof fakeRenderer>} */ f) {
  const d = f.binding.getDepthInformation({ eye: 'left' });
  if (d && d.isValid && d.texture && !f.state.hasTexture) { f.state.hasTexture = true; f.ext.sourceTexture = d.texture; }
}

test('LiveDepth: inactive without depth-sensing, or with cpu-optimized usage, and says why', () => {
  globalThis.XRWebGLBinding = /** @type {any} */ (function XRWebGLBinding() {});
  const L = new LiveDepth();
  const f = fakeRenderer();
  L.attach(f.renderer, session({ enabledFeatures: ['local-floor'] }));
  assert.equal(L.active, false);
  assert.match(L.why, /not granted/);
  L.attach(f.renderer, session({ depthUsage: 'cpu-optimized' }));
  assert.equal(L.active, false);
  assert.match(L.why, /cpu-optimized/);
  // a getter that throws (Chromium without the feature) never escapes
  const s = session({});
  Object.defineProperty(s, 'depthUsage', { get() { throw new Error('InvalidStateError'); } });
  L.attach(f.renderer, s);
  assert.equal(L.active, false);
  assert.match(L.why, /threw/);
  L.update(f.renderer); // no-op while inactive
  assert.equal(L.frames, 0);
});

test('LiveDepth: follows a new depth texture every frame (three r187 keeps the first one)', () => {
  globalThis.XRWebGLBinding = /** @type {any} */ (function XRWebGLBinding() {});
  const L = new LiveDepth();
  const f = fakeRenderer();
  L.attach(f.renderer, session({}));
  assert.equal(L.active, true);
  // no data yet
  f.binding.info = null;
  threeFrame(f); L.update(f.renderer);
  f.binding.info = { isValid: false, texture: null };
  threeFrame(f); L.update(f.renderer);
  assert.deepEqual([L.frames, L.noInfo, L.invalid, L.valid], [2, 1, 1, 0]);
  assert.match(L.line(), /no valid depth yet/);
  // a swapchain of three textures
  const tex = [{ id: 0 }, { id: 1 }, { id: 2 }];
  for (let i = 0; i < 9; i++) {
    f.binding.info = { isValid: true, texture: tex[i % 3], width: 320, height: 320, depthNear: 0.1, depthFar: Infinity };
    threeFrame(f);
    L.update(f.renderer);
    assert.equal(f.ext.sourceTexture, tex[i % 3], `frame ${i}: three samples this frame's texture`);
  }
  assert.equal(L.valid, 9);
  assert.equal(L.firstValidFrame, 3);
  assert.equal(L.changes, 8); // the first valid frame is the texture three wrapped itself
  assert.equal(f.mesh.material.colorWrite, false, "three's depth quad writes depth only");
  assert.equal(L.threePass, true);
  assert.match(L.line(), /320×320 · three pass ON · new texture each frame ×8 \(refreshed\)/);
  const s = L.summary();
  assert.equal(s.depthFar, 'Infinity');
  assert.equal(s.depthNear, 0.1);
  assert.equal(s.textureChanges, 8);
  assert.equal(JSON.parse(JSON.stringify(s)).width, 320);
});

test('LiveDepth: one texture for the whole session is left alone; refresh off = three as shipped', () => {
  globalThis.XRWebGLBinding = /** @type {any} */ (function XRWebGLBinding() {});
  const L = new LiveDepth();
  const f = fakeRenderer();
  L.attach(f.renderer, session({}));
  const t = { id: 'same' };
  for (let i = 0; i < 5; i++) { f.binding.info = { isValid: true, texture: t, width: 8, height: 8, depthNear: 0.1, depthFar: Infinity }; threeFrame(f); L.update(f.renderer); }
  assert.equal(L.changes, 0);
  assert.equal(L.same, 5);
  assert.match(L.line(), /same texture each frame/);
  L.refresh = false;
  const t2 = { id: 'next' };
  f.binding.info = { isValid: true, texture: t2, width: 8, height: 8, depthNear: 0.1, depthFar: Infinity };
  threeFrame(f); L.update(f.renderer);
  assert.equal(f.ext.sourceTexture, t, 'not refreshed: three keeps the old texture');
  assert.equal(L.changes, 1);
  assert.match(L.line(), /NOT refreshed/);
});

test('LiveDepth: detach restores the binding and keeps the refresh setting', () => {
  globalThis.XRWebGLBinding = /** @type {any} */ (function XRWebGLBinding() {});
  const L = new LiveDepth();
  const f = fakeRenderer();
  L.attach(f.renderer, session({}));
  assert.notEqual(f.binding.getDepthInformation, FakeBinding.prototype.getDepthInformation, 'wrapped');
  f.binding.info = { isValid: true, texture: {}, width: 1, height: 1, depthNear: 0.1, depthFar: 10 };
  assert.equal(f.binding.getDepthInformation(null), f.binding.info, 'the wrapper returns what the browser returned');
  assert.equal(f.binding.calls, 1);
  L.refresh = false;
  L.detach();
  assert.equal(f.binding.getDepthInformation, FakeBinding.prototype.getDepthInformation, "the browser's own method again");
  assert.equal(L.active, false);
  assert.equal(L.refresh, false);
});

test('LiveDepth.update does not allocate', () => {
  globalThis.XRWebGLBinding = /** @type {any} */ (function XRWebGLBinding() {});
  const L = new LiveDepth();
  const f = fakeRenderer();
  L.attach(f.renderer, session({}));
  const infos = [0, 1].map((i) => ({ isValid: true, texture: { id: i }, width: 8, height: 8, depthNear: 0.1, depthFar: Infinity }));
  const run = (/** @type {number} */ n) => { for (let i = 0; i < n; i++) { f.binding.info = infos[i & 1]; f.binding.getDepthInformation(null); L.update(f.renderer); } };
  run(20000);
  const gc = /** @type {any} */ (globalThis).gc;
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    if (gc) gc();
    const h0 = process.memoryUsage().heapUsed;
    run(100000);
    best = Math.min(best, process.memoryUsage().heapUsed - h0);
  }
  assert.ok(best < 64 * 1024, `heap grew ${best} B over 100k frames`);
});
