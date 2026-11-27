// v0.5: the learner's main-thread side (Learner) with the worker loop in-process (LearnClient's inline mode):
// open a house, the head path batched and transferred, analyses, a save, the buffers recycled, nothing
// allocated per frame by the Learner itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Learner, LEARN } from '../../src/learn/Learner.js';
import { createLearnClient } from '../../src/learn/LearnClient.js';
import { HitRays } from '../../src/learn/HitRays.js';

const snap = JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('learner: opens the house in the worker loop, batches the head path, analyses on a timer, saves, recycles its buffers', async () => {
  const client = createLearnClient({ worker: false });
  assert.equal(client.kind, 'inline');
  const L = new Learner({ client, hits: new HitRays() });
  L.begin({ session: /** @type {any} */ ({ enabledFeatures: [] }), space: /** @type {any} */ ({}), liveDepth: null });
  assert.ok(L.open(snap));
  assert.equal(L.state, 'opening');
  for (let k = 0; k < 20 && L.state !== 'open'; k++) await tick();
  assert.equal(L.state, 'open');
  assert.equal(L.hasHouse, false, 'nothing learned yet');
  assert.ok(/^house-/.test(L.frame.id));
  L.setScanning(true);
  const head = { x: 0, y: 1.6, z: 0 };
  let t = 0;
  for (let f = 0; f < 72 * 6; f++) {
    t += 1000 / 72;
    head.x = Math.sin(f / 60) * 1.5; head.z = Math.cos(f / 80) - 0.5;
    L.update(t, /** @type {any} */ ({}), /** @type {any} */ ({}), head, null, { lastCpu: 2 });
    if (f % 9 === 0) await tick(0);
  }
  for (let k = 0; k < 20 && !L.result; k++) await tick();
  const r = L.report();
  assert.ok(r.headSamples >= 50 && r.flushes >= 10 && r.droppedRays === 0, JSON.stringify(r));
  assert.ok(L.result && L.result.observedM2 > 1, 'the walked floor is observed');
  assert.ok(L.free.length >= 1, 'batches came back');
  // a frame near budget skips the learner's work
  const skips = L.gateSkips;
  L.update(t + 1, /** @type {any} */ ({}), /** @type {any} */ ({}), head, null, { lastCpu: LEARN.budgetMs + 1 });
  assert.equal(L.gateSkips, skips + 1);
  L.save('test');
  for (let k = 0; k < 20 && !L.lastSave; k++) await tick();
  assert.ok(L.lastSave && L.lastSave.saved && L.lastSave.chunks > 0, JSON.stringify(L.lastSave));
  const ov = L.overlay();
  assert.ok(ov && Array.isArray(ov.walked) && ov.walked.length > 5);
});

test('learner: a second session in the same house loads what was learned (the same in-process store)', async () => {
  // the inline client keeps its memory store per client: run two "sessions" on one client
  const client = createLearnClient({ worker: false });
  const L = new Learner({ client });
  for (let s = 0; s < 2; s++) {
    L.begin({ session: /** @type {any} */ ({ enabledFeatures: [] }), space: /** @type {any} */ ({}), liveDepth: null });
    L.open(snap);
    for (let k = 0; k < 40 && L.state !== 'open'; k++) await tick();
    if (s === 1) { assert.equal(L.hasHouse, true); assert.ok(L.result, 'the loaded house is analysed at once'); break; }
    let t = 0;
    for (let f = 0; f < 300; f++) { t += 14; L.update(t, /** @type {any} */ ({}), /** @type {any} */ ({}), { x: f / 200, y: 1.6, z: 0 }, null, null); if (f % 20 === 0) await tick(0); }
    await tick(20);
    L.end();
    for (let k = 0; k < 40 && !L.lastSave; k++) await tick();
    assert.ok(L.lastSave && L.lastSave.saved);
  }
});
