/**
 * The large-house budget (the user's top priority: a large house, zero hitches): a synthetic
 * 250 m² house (12 rooms, 3 Space Setup floors, 20 doors, 40 furniture volumes, clutter) with a
 * 120k-triangle global mesh, built in a real worker thread while the main thread runs 72 Hz
 * "frames" of world.update (the copy-in, the commit and the occluder tile uploads).
 *
 * Asserted (desktop, loose bounds for parallel test load): the build finishes in the worker;
 * no single main-thread update over 1 ms (calls not switched out, cpuclock.js); the structured
 * part of the message deserialises in under 1 ms; memory stays bounded; queries stay in µs.
 * Printed: the worker's build time and phases, frames to apply, memory, message sizes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { register } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Timer, cpuNow } from './cpuclock.js';
import { largeHouse, largeScan } from './world.largehouse.js';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const { World, createWorldBuilder } = await import('../../src/world/World.js');
const { WorldCore } = await import('../../src/world/WorldCore.js');

const FRAME_MS = 1000 / 72;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('250 m², 120k-triangle global mesh: built in a worker thread, ≤ 1 ms of main-thread time per frame', async (t) => {
  const { b, snap, clutter } = largeHouse();
  const scan = largeScan(snap, clutter, 120000);
  const tris = scan.indices.length / 3;
  assert.ok(tris > 110000 && tris < 130000, `${tris} triangles`);
  const [px, pz] = b.toWorld(2.5, 2.0);

  const w = new World();
  w.warmUp();
  const nw = new NodeWorker(new URL('./world.workerthread.js', import.meta.url));
  const worker = {
    postMessage: (m, tr) => nw.postMessage(m, tr),
    addEventListener: (type, f) => nw.on(type === 'message' ? 'message' : 'error', (d) => f(type === 'message' ? { data: d } : d)),
    terminate: () => nw.terminate(),
  };
  const builder = createWorldBuilder(w.config, { worker });
  w.attachBuilder(builder);
  try {
    // the worker warms up first (its own JIT), as it would at page load
    for (let i = 0; i < 2000 && !builder.ready; i++) await wait(5);
    assert.ok(builder.ready, `worker warm-up ${builder.error}`);

    const T = new Timer();
    let frames = 0, cpu = 0, done = false, ok = false;
    const t0 = performance.now();
    w.buildAsync(snap, { x: px, z: pz }).then((v) => { done = true; ok = v; });
    const player = { head: { x: px, z: pz }, valid: true };
    while (!done && frames < 20000) {
      await wait(FRAME_MS / 4); // the frame's other work runs elsewhere; the message lands between frames
      const c0 = cpuNow();
      T.start();
      w.update(FRAME_MS / 1000, frames * FRAME_MS, null, { player });
      T.stop();
      cpu += cpuNow() - c0;
      frames++;
    }
    const wallMs = performance.now() - t0;
    assert.ok(done && ok, 'the build finished');
    const r = w.report();
    const mem = w.memoryBytes();
    const applyFrames = w.stats.applyFrames;
    t.diagnostic(`worker: ${w.stats.workerMs.toFixed(0)} ms (build + bake ${w.stats.buildMs.toFixed(0)} ms) for ${tris} triangles, ${r.counts.walls} walls, ${r.counts.doors} doors, ${r.counts.furniture} objects, ${r.roam.rooms} rooms; ${wallMs.toFixed(0)} ms wall clock`);
    t.diagnostic(`mesh: kept ${r.mesh.kept}, covered ${r.mesh.covered}, tiles ${r.mesh.tiles}, up-vote ${r.mesh.upVotePct} %, prep ${r.mesh.prepMs} ms, BVH ${r.mesh.bvhMs} ms (${r.mesh.bvhNodes} nodes, depth ${r.mesh.bvhDepth})`);
    t.diagnostic(`main thread: ${frames} frames, ${applyFrames} applying (copy, commit, ${w.meshTileUploads} tile uploads); update ${T}; mean ${(cpu / frames).toFixed(3)} ms CPU; worst step by phase ${JSON.stringify(r.worker.phaseMs)} ms`);
    t.diagnostic(`memory: nav ${(mem.nav / 1e6).toFixed(1)} MB, roam ${(mem.roam / 1e6).toFixed(1)} MB, BVH ${(mem.bvh / 1e6).toFixed(1)} MB, tiles ${(mem.tiles / 1e6).toFixed(1)} MB, statics ${(mem.statics / 1e6).toFixed(1)} MB, total ${(mem.total / 1e6).toFixed(1)} MB (+ mesh occluder ${((w.maxMeshVerts * 12 + w.maxMeshTris * 12) / 1e6).toFixed(1)} MB preallocated)`);
    assert.ok(T.samples > 10, 'enough undisturbed frames to judge');
    assert.ok(T.worst < 1, `a main-thread update took ${T.worst.toFixed(3)} ms (budget 1 ms)`);
    assert.ok(w.stats.applyMaxMs < 1, `apply step ${w.stats.applyMaxMs} ms`);
    assert.ok(w.stats.workerMs < 10000, `worker build ${w.stats.workerMs} ms`);
    assert.ok(r.mesh.oneSided && r.mesh.covered >= 30, `${r.mesh.covered} covered`);
    assert.equal(r.meshOccluder.tiles, r.meshOccluder.of, 'every tile uploaded');
    assert.equal(r.meshOccluder.dropped, 0, 'the mesh fits the occluder capacity');
    assert.ok(r.roam.rooms >= 12 && r.roam.fieldsReady && r.roam.edgeReady);
    assert.ok(mem.total < 64e6, `${(mem.total / 1e6).toFixed(1)} MB`);
    // the same capture built synchronously (no worker): the mesh is left to the worker, nothing stalls here
    const sync = new WorldCore({ roam: true });
    sync.build(snap, { x: px, z: pz });
    assert.equal(sync.bvh, null);
    assert.ok(sync.stats.notes.some((n) => /left to the worker/.test(n)));

    // the message's structured (non-transferred) part: what the main thread deserialises
    const core = new WorldCore({ roam: true });
    core.build(snap, { x: px, z: pz }, { mesh: true });
    core.finishBake();
    const ex = core.exportState();
    const bytes = v8.serialize(ex.meta);
    let arrays = 0;
    for (const k in ex.arrays) arrays += ex.arrays[k].byteLength;
    const d0 = performance.now();
    for (let i = 0; i < 10; i++) v8.deserialize(bytes);
    const deMs = (performance.now() - d0) / 10;
    t.diagnostic(`message: ${(bytes.length / 1024).toFixed(0)} KB structured (deserialise ${deMs.toFixed(2)} ms), ${(arrays / 1e6).toFixed(2)} MB of copied arrays + ${(ex.transfer.reduce((s, x) => s + x.byteLength, 0) / 1e6).toFixed(1)} MB transferred`);
    assert.ok(deMs < 1, `deserialise ${deMs.toFixed(2)} ms`);

    // queries on the big BVH: µs, CPU time
    const h = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
    let hits = 0;
    const c0 = cpuNow();
    for (let i = 0; i < 20000; i++) {
      const a = i * 0.000731, e = ((i % 17) - 9) * 0.05;
      if (w.raycast(px, 1.5, pz, Math.cos(a), e, Math.sin(a), 30, h)) hits++;
    }
    const us = ((cpuNow() - c0) * 1000) / 20000;
    t.diagnostic(`world.raycast (boxes + 120k-triangle BVH): ${us.toFixed(2)} µs per ray`);
    assert.ok(hits > 19500, `${hits} of 20000 hit (level rays leave through the two open exterior doors)`);
    assert.ok(us < 30, `${us.toFixed(2)} µs per ray`);
  } finally {
    await nw.terminate();
  }
});
