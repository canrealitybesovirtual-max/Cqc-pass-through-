// Allocation checks for Roam's per-frame paths, in their own file (node --test
// runs each file in its own process, so V8 sees only the real types here):
// player tracking, the edge margin, path estimates, the time-sliced spawn
// search, obstacle cues and RoamSafety, walking a large house. Run with
// --expose-gc (npm test does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldCore } from '../../src/world/WorldCore.js';
import { IN, RoamSafety } from '../../src/safety/RoamSafety.js';
import { ObstacleWarnings, POINT } from '../../src/safety/ObstacleWarnings.js';
import { DriftWatch, pickReferencePlanes } from '../../src/world/Realign.js';
import { largeHouse } from './world.houses.js';

test('Roam per-frame work does not allocate (walk the corridor and rooms: tracking, edge, obstacles, cues, paths)', () => {
  const b = largeHouse();
  const snap = b.build();
  const w = new WorldCore({ roam: true });
  w.warmUp();
  const [px, pz] = b.toWorld(12.5, 5);
  w.build(snap, { x: px, z: pz });
  w.finishBake();
  const ow = new ObstacleWarnings({ roam: true }), rs = new RoamSafety();
  const ctx = { player: { head: { x: px, z: pz }, valid: true } };
  const route = new Float64Array(2 * 4000);
  for (let i = 0; i < 4000; i++) {
    const u = i / 4000;
    // along the corridor and back, dipping into the rooms on either side
    const hx = 1.5 + 22 * (u < 0.5 ? 2 * u : 2 - 2 * u), hz = 5 + 2.6 * Math.sin(u * 40);
    const [x, z] = b.toWorld(hx, hz);
    route[2 * i] = x; route[2 * i + 1] = z;
  }
  let t = 0, k = 0;
  const frame = () => {
    const i = k % 4000;
    const x = route[2 * i], z = route[2 * i + 1];
    t += 14;
    ctx.player.head.x = x; ctx.player.head.z = z;
    w.update(1 / 72, t, null, ctx);
    const m = w.edgeMargin(x, z);
    ow.setPoint(POINT.HEAD, x, 1.65, z);
    ow.update(1 / 72, w.shapes, null);
    const I = rs.input;
    I[IN.DT] = 1 / 72; I[IN.X] = x; I[IN.Z] = z; I[IN.SPEED] = 1.1; I[IN.MARGIN] = m; I[IN.OBSTACLE] = ow.headLevel;
    rs.step(true, true, false, true, w.playerRoom);
    w.nav.pathDistance(x + 3, z);
    k++;
  };
  for (let n = 0; n < 12000; n++) frame(); // warm every path (searches start, end, restart)
  let grew = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 20000; n++) frame();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  // One object per frame would be > 400 KB here. What remains is V8 boxing a few doubles when the
  // head enters a new 10 cm cell (the room / anchor lookup: about 150 B per cell, measured 9 B per frame).
  assert.ok(grew < 300_000, `heap grew ${grew} bytes over 20k frames`);
  assert.ok(w.roamIndex.trackCount > 1000, 'the head crossed many cells');
});

test('a drift check (once a second in play) allocates little', () => {
  const b = largeHouse();
  const snap = b.build();
  const dw = new DriftWatch();
  const refs = pickReferencePlanes(snap);
  dw.setReference(snap, refs);
  const pose = new Float64Array(16);
  const check = () => { for (let r = 0; r < dw.refs; r++) { for (let q = 0; q < 16; q++) pose[q] = snap.planes[refs[r]].pose[q]; dw.sample(r, pose); } dw.evaluate(); };
  for (let n = 0; n < 5000; n++) check();
  let grew = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 10000; n++) check();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew / 10000 < 64, `${(grew / 10000).toFixed(1)} B per check`);
});

test('a spawn search costs little memory even when it runs every frame (the visibility rays box a few doubles)', () => {
  const b = largeHouse();
  const w = new WorldCore({ roam: true });
  w.warmUp();
  const [px, pz] = b.toWorld(12.5, 5);
  w.build(b.build(), { x: px, z: pz });
  w.finishBake();
  const pl = { head: { x: px, z: pz }, vel: { x: 0, z: 0 }, flatForward: { x: 1, z: 0 } };
  const out = { x: 0, z: 0 };
  let k = 0;
  const frame = () => { const x = px + Math.sin(k * 0.01) * 10, z = pz; pl.head.x = x; pl.head.z = z; w.update(0, k * 14 * 40, null, null); w.spawnRoamFor(pl, out); k++; };
  for (let n = 0; n < 4000; n++) frame();
  let grew = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 10000; n++) frame();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew / 10000 < 400, `${(grew / 10000).toFixed(1)} B per search call`);
  assert.ok(w.spawner.roamStats.found > 1000, `${w.spawner.roamStats.found} spawns found`);
});
