// World builds in the world worker (src/world/WorldBuild.js, WorldWorker.js, WorldState.js):
// the same world as a synchronous build, the mesh arrays lent and returned, superseded requests,
// fallbacks, the previous world answering until the commit, and a real worker thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { WorldCore, BUILD } from '../../src/world/WorldCore.js';
import { InlineBuilder, createWorldBuilder } from '../../src/world/WorldWorker.js';
import { hydrateSnapshot, normalizeSnapshot, globalRawMesh } from '../../src/world/Snapshot.js';
import { Timer } from './cpuclock.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const meshHouse = async () => hydrateSnapshot(normalizeSnapshot(house()));
const tick = () => new Promise((r) => setTimeout(r, 1));

/** Drive world.update like frames until the promise settles; returns the per-update timer. */
async function pump(w, p, ctx = null, maxFrames = 4000) {
  let done = false, value;
  p.then((v) => { done = true; value = v; });
  const T = new Timer();
  for (let f = 0; f < maxFrames && !done; f++) {
    await tick();
    T.start();
    w.update(0.0139, f * 13.9, null, ctx);
    T.stop();
  }
  await tick();
  assert.ok(done, 'the build finished');
  return { value, T };
}

/** Node worker_threads Worker → the browser Worker shape WorkerBuilder expects. */
function nodeWorker() {
  const nw = new NodeWorker(new URL('./world.workerthread.js', import.meta.url));
  return {
    nw,
    postMessage: (m, t) => nw.postMessage(m, t),
    addEventListener: (type, f) => nw.on(type === 'message' ? 'message' : 'error', (d) => f(type === 'message' ? { data: d } : d)),
    terminate: () => nw.terminate(),
  };
}

function sameWorld(a, b, label) {
  const ra = a.report(), rb = b.report();
  for (const k of ['counts', 'floors', 'walls', 'doors', 'furniture', 'nav', 'mode', 'virtual', 'zone', 'spawn', 'statics']) {
    assert.deepEqual(rb[k], ra[k], `${label}: report.${k}`);
  }
  if (ra.mesh) for (const k of ['tris', 'kept', 'cropped', 'classes', 'upVotePct', 'oneSided', 'covered', 'tiles', 'bvhNodes']) assert.deepEqual(rb.mesh[k], ra.mesh[k], `${label}: mesh.${k}`);
  if (ra.roam) for (const k of ['rooms', 'roomList', 'doors', 'doorFields', 'fieldsReady', 'edgeReady', 'edgeCells']) assert.deepEqual(rb.roam[k], ra.roam[k], `${label}: roam.${k}`);
  const n = a.nav.count;
  assert.equal(b.nav.count, n);
  for (const k of ['flags', 'clr', 'region', 'pathDist', 'doors', 'floorIdx', 'room', ...(a.nav.edgeReady ? ['edge'] : [])]) {
    const x = a.nav[k], y = b.nav[k];
    for (let i = 0; i < n; i++) if (!(x[i] === y[i] || (x[i] !== x[i] && y[i] !== y[i]))) assert.fail(`${label}: nav.${k}[${i}] ${x[i]} vs ${y[i]}`);
  }
  assert.deepEqual(b.shapes.box.subarray(0, b.shapes.count * 8), a.shapes.box.subarray(0, a.shapes.count * 8));
  assert.equal(b.shapes.rayCount, a.shapes.rayCount);
  const ha = {}, hb = {};
  for (let i = 0; i < 1500; i++) {
    const ang = i * 0.0137, e = ((i % 23) - 11) * 0.06, ox = -1.5 + (i % 9) * 0.8, oz = -2.6 + (i % 5) * 0.7;
    const A = a.raycast(ox, 1.1, oz, Math.cos(ang), e, Math.sin(ang), 20, ha), B = b.raycast(ox, 1.1, oz, Math.cos(ang), e, Math.sin(ang), 20, hb);
    assert.equal(B, A, `${label}: ray ${i}`);
    if (A) { assert.equal(hb.dist, ha.dist); assert.equal(hb.surface, ha.surface); }
    assert.equal(b.segmentClear(ox, 0.4, oz, ox + Math.cos(ang) * 3, 1.2, oz + Math.sin(ang) * 3), a.segmentClear(ox, 0.4, oz, ox + Math.cos(ang) * 3, 1.2, oz + Math.sin(ang) * 3));
  }
}

test('an in-process worker build gives exactly the synchronous world (Roam and spot); the main thread never spends 1 ms', async () => {
  for (const roam of [true, false]) {
    const snap = await meshHouse();
    const a = new WorldCore({ roam });
    a.build(snap, { x: 0.2, z: -0.5 });
    a.finishBake();
    const b = new WorldCore({ roam });
    b.attachBuilder(new InlineBuilder(b.config));
    const { value, T } = await pump(b, b.buildAsync(snap, { x: 0.2, z: -0.5 }));
    assert.equal(value, true);
    assert.equal(b.busy, false);
    assert.equal(b.stats.workerBuilds, 1);
    assert.equal(b.bakeDone, true, 'the Roam bake ran in the worker');
    assert.equal(b.snapshot, snap, 'the world keeps the caller\'s snapshot object');
    sameWorld(a, b, roam ? 'roam' : 'spot');
    // spawns and paths from a tracked player: the same answers
    const pl = { head: { x: 0.2, z: -0.5 }, vel: { x: 0, z: 0 }, flatForward: { x: 1, z: 0 }, valid: true };
    a.update(0.014, 0, null, { player: pl });
    b.update(0.014, 0, null, { player: pl });
    for (let i = 0; i < 40; i++) {
      const x = -1.5 + (i % 8) * 1.0, z = -2.7 + (i % 4) * 0.9;
      assert.equal(b.pathFromPlayer(x, z), a.pathFromPlayer(x, z));
      assert.equal(b.edgeMargin(x, z), a.edgeMargin(x, z));
      assert.equal(b.floorY(x, z), a.floorY(x, z));
    }
    const oa = { x: 0, z: 0 }, ob = { x: 0, z: 0 };
    for (let i = 0; i < 6; i++) {
      const ra = roam ? a.spawnRoamFor(pl, oa) : (a.findSpawn(0.2, -0.5, 1, 0, 3, oa) ? 1 : 0);
      const rb = roam ? b.spawnRoamFor(pl, ob) : (b.findSpawn(0.2, -0.5, 1, 0, 3, ob) ? 1 : 0);
      assert.equal(rb, ra);
      if (ra === 1) assert.deepEqual(ob, oa);
    }
    assert.ok(T.worst < 1, `main-thread update ${T}`);
    assert.ok(b.stats.applyMaxMs < 1, `apply step ${b.stats.applyMaxMs} ms`);
  }
});

test('the mesh arrays are lent to the worker and come back; queries answer from the previous world until the commit', async () => {
  const snap = await meshHouse();
  const w = new WorldCore({ roam: true });
  w.attachBuilder(new InlineBuilder(w.config));
  await pump(w, w.buildAsync(snap, { x: 0, z: 0 }));
  const rm = globalRawMesh(snap);
  const n = rm.data.indices.length;
  const h0 = {};
  assert.ok(w.raycast(5.6, 1.5, -1.1, 0, -1, 0, 3, h0) && h0.surface === 'bed');
  const p = w.rebuildAsync();
  assert.equal(w.buildPhase, BUILD.WORKING);
  assert.equal(rm.data.indices.length, 0, 'detached while the worker has them');
  assert.equal(globalRawMesh(snap), null);
  const h1 = {};
  assert.ok(w.raycast(5.6, 1.5, -1.1, 0, -1, 0, 3, h1) && h1.dist === h0.dist, 'the previous world still answers');
  assert.ok(w.built);
  const { value } = await pump(w, p);
  assert.equal(value, true);
  assert.equal(rm.data.indices.length, n, 'given back');
  assert.ok(w.report().mesh && w.report().mesh.tris === n / 3, 'the rebuild used the mesh');
  assert.equal(w.stats.workerBuilds, 2);
});

test('a newer request supersedes an older one; failures and timeouts build on the main thread instead', async () => {
  const snap = await meshHouse();
  const w = new WorldCore({ roam: true });
  w.attachBuilder(new InlineBuilder(w.config));
  const p1 = w.buildAsync(snap, { x: 0, z: 0 });
  const p2 = w.buildAsync(snap, { x: 4.5, z: -1.5 }, { force: true });
  const p3 = w.buildAsync(snap, { x: 1.0, z: -1.0 }, { force: true });
  let r2;
  p2.then((v) => { r2 = v; });
  const { value: v3 } = await pump(w, p3);
  assert.equal(await p1, false, 'superseded while in flight');
  assert.equal(r2, false, 'replaced while waiting');
  assert.equal(v3, true);
  assert.equal(w.start.x, 1.0);
  assert.ok(globalRawMesh(snap), 'the arrays are home again');
  // a worker that fails: the world builds here and says why
  const failing = { failed: false, onResult: null, post(msg) { setTimeout(() => this.onResult({ type: 'built', seq: msg.seq, ok: false, error: 'boom', mesh: msg.mesh }), 0); } };
  const f = new WorldCore({ roam: true });
  f.attachBuilder(failing);
  const { value: vf } = await pump(f, f.buildAsync(snap, { x: 0, z: 0 }));
  assert.equal(vf, true);
  assert.ok(f.built && f.bvh, 'built synchronously, with the mesh (the arrays came back with the failure)');
  assert.ok(f.stats.notes.some((s) => /boom.*main thread/.test(s)), f.stats.notes.join('; '));
  // a worker that never answers
  const silent = { failed: false, onResult: null, post() {} };
  const s = new WorldCore({ roam: true });
  s.attachBuilder(silent);
  s.buildTimeoutMs = 30;
  const { value: vs } = await pump(s, s.buildAsync(await meshHouse(), { x: 0, z: 0 }));
  assert.equal(vs, true);
  assert.equal(silent.failed, true, 'marked failed: later builds go straight to the main thread');
  assert.ok(s.stats.notes.some((n) => /did not answer/.test(n)));
  // no builder at all: buildAsync is build
  const plain = new WorldCore({ roam: true });
  assert.equal(await plain.buildAsync(snap, { x: 0, z: 0 }), true);
  assert.ok(plain.built);
  assert.equal(await plain.buildAsync(snap, { x: 0.3, z: 0 }), false, 'Roam: only the start moved, skipped');
});

test('a real worker thread builds the world (protocol, transfers, warm-up in the worker)', async () => {
  const snap = await meshHouse();
  const w = new WorldCore({ roam: true });
  const wk = nodeWorker();
  const builder = createWorldBuilder(w.config, { worker: wk });
  w.attachBuilder(builder);
  try {
    const { value, T } = await pump(w, w.buildAsync(snap, { x: 0, z: 0 }), null, 20000);
    assert.equal(value, true);
    assert.equal(builder.kind, 'worker');
    assert.ok(builder.ready && builder.warmMs > 0, 'warmed in the worker');
    const a = new WorldCore({ roam: true });
    a.build(snap, { x: 0, z: 0 });
    a.finishBake();
    sameWorld(a, w, 'thread');
    assert.ok(T.worst < 1, `main-thread update ${T}`);
    assert.ok(w.stats.workerMs > 0);
  } finally {
    await wk.nw.terminate();
  }
});
