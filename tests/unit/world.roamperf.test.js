/**
 * Roam performance on a synthetic large house (world.houses.js largeHouse():
 * 250 m², 21 rooms, the rooms of three storeys on one level, 30 doors, 40
 * pieces of furniture, yawed 23°): build time, the sliced bake, memory, and
 * the per-frame costs of walking (player tracking, edge margin, obstacle
 * cues) and spawning (the time-sliced roam search, path estimates).
 *
 * Desktop Node numbers (the Quest is assumed 3–5× slower): loose bounds that
 * catch regressions; the diagnostics print the measurements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldCore } from '../../src/world/WorldCore.js';
import { RoamSafety } from '../../src/safety/RoamSafety.js';
import { ObstacleWarnings, POINT } from '../../src/safety/ObstacleWarnings.js';
import { largeHouse, largeRooms, toHouse } from './world.houses.js';

import { cpuNow, Timer } from './cpuclock.js';

/** Wall clock: the world's own deadlines. The bounds below count time on the CPU only (tests/unit/cpuclock.js). */
const now = () => performance.now();

/** The house's room name at a reference-space point. */
function nameAt(b, x, z) {
  const [hx, hz] = toHouse(b, x, z);
  for (const [n, [x0, z0, x1, z1]] of Object.entries(largeRooms())) if (hx > x0 && hx < x1 && hz > z0 && hz < z1) return n;
  return null;
}

test('large house (250 m², 21 rooms, 30 doors): build, bake, memory, per-frame walking and spawn costs', (t) => {
  const b = largeHouse();
  const snap = b.build();
  const w = new WorldCore({ roam: true, bakeBudgetMs: 1 });
  w.warmUp();
  const [px, pz] = b.toWorld(12.5, 5);
  for (let k = 0; k < 3; k++) { w.built = false; w.build(snap, { x: px, z: pz }); w.finishBake(); } // warm the JIT
  // build (synchronous part, behind the panel)
  const N = 5;
  let buildMs = 0;
  for (let k = 0; k < N; k++) { w.built = false; const c0 = cpuNow(); w.build(snap, { x: px, z: pz }); buildMs += cpuNow() - c0; w.finishBake(); }
  buildMs /= N;
  // sliced bake through world.update
  w.built = false;
  w.build(snap, { x: px, z: pz });
  const R = w.roamIndex;
  let frames = 0;
  const tb = now(), cb = cpuNow();
  while (!w.bakeDone && frames < 10000) { w.update(1 / 72, frames * 14, null, null); frames++; }
  const bakeWall = now() - tb, bakeCpu = cpuNow() - cb;
  assert.ok(w.bakeDone);
  assert.equal(w.stats.doors, 30);
  assert.equal(R.roomCount, 21);
  assert.equal(R.fieldSlots, 30);
  assert.ok(!w.stats.notes.some((n) => /cropped|dropped/.test(n)), `nothing cropped or dropped: ${w.stats.notes}`);
  const mem = w.memoryBytes();
  const planner = w.nav.capacity * 36;
  t.diagnostic(`grid ${w.nav.w}×${w.nav.h} = ${w.nav.count} cells (${(w.nav.count / w.nav.capacity * 100).toFixed(0)} % of ${w.nav.capacity}), ${w.shapes.count} boxes, ${w.spawner.count} spawn candidates in ${w.spawner.roomsWithCandidates} rooms`);
  t.diagnostic(`build ${buildMs.toFixed(1)} ms on the CPU (warm, synchronous); bake ${bakeCpu.toFixed(1)} ms on the CPU in ${frames} frames (${R.bakeMs.toFixed(1)} ms of slices, ${bakeWall.toFixed(0)} ms wall), mean slice ${(bakeCpu / R.bakeSlices).toFixed(2)} ms on the CPU (${(R.bakeMs / R.bakeSlices).toFixed(2)} wall), worst ${R.maxSliceMs.toFixed(2)} ms wall`);
  t.diagnostic(`memory: nav ${(mem.nav / 1048576).toFixed(1)} MB, roam index ${(mem.roam / 1048576).toFixed(1)} MB (door fields ${(R.fields.byteLength / 1048576).toFixed(1)} MB), + planner ≈ ${(planner / 1048576).toFixed(1)} MB`);
  assert.ok(buildMs < 120, `build ${buildMs} ms`);
  assert.ok(bakeCpu < 600, `bake ${bakeCpu} ms on the CPU`);
  assert.ok(bakeCpu / R.bakeSlices < 2, `slices stay near the 1 ms budget: ${(bakeCpu / R.bakeSlices).toFixed(2)} ms on the CPU per slice`);
  assert.ok(mem.total + planner < 32 * 1048576, `memory ${mem.total + planner} B`);

  // per-frame walking: tracking, edge margin, obstacle cues, roam safety along the corridor and into rooms
  const ow = new ObstacleWarnings({ roam: true }), rs = new RoamSafety();
  const route = [[1.2, 5], [24, 5], [23.75, 3], [23.75, 1.5], [21.25, 1.9], [21.25, 5], [12.5, 5], [11.25, 7.5]];
  /** @type {number[]} */ const pts = [];
  for (let k = 0; k + 1 < route.length; k++) {
    const [ax, az] = route[k], [bx, bz] = route[k + 1], d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / (1.2 / 72));
    for (let i = 0; i < n; i++) pts.push(...b.toWorld(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n));
  }
  const ctx = { player: { head: { x: 0, z: 0 }, valid: true } };
  let walkMs = 0, worstFrame = 0, edgeCued = 0;
  const M = pts.length / 2;
  for (let rep = 0; rep < 2; rep++) {
    const c0 = cpuNow();
    for (let i = 0; i < M; i++) {
      const x = pts[2 * i], z = pts[2 * i + 1];
      const t0 = now();
      ctx.player.head.x = x; ctx.player.head.z = z;
      w.update(1 / 72, i * 14, null, ctx);
      const m = w.edgeMargin(x, z);
      ow.setPoint(POINT.HEAD, x, 1.65, z);
      ow.update(1 / 72, w.shapes, null);
      rs.update(1 / 72, true, true, x, z, 1.2, m, ow.headLevel, false, true, w.playerRoom);
      const dt = now() - t0;
      if (rep === 1) { if (dt > worstFrame) worstFrame = dt; if (rs.cue[1] > 0) edgeCued++; }
    }
    if (rep === 1) walkMs = cpuNow() - c0;
  }
  const perFrameUs = (walkMs / M) * 1000;
  t.diagnostic(`walking ${M} frames (${rs.report().walkedM.toFixed(1)} m, ${rs.report().roomsVisited.length} rooms): ${perFrameUs.toFixed(1)} µs per frame on the CPU (tracking + edge + obstacles over ${w.shapes.count} boxes + cues), worst ${worstFrame.toFixed(3)} ms wall`);
  assert.equal(edgeCued, 0, 'a fully walled house has no map edge');
  assert.ok(perFrameUs < 200, `walking costs ${perFrameUs} µs per frame`);

  // spawns from every room: per-call cost of the time-sliced search, frames needed, results valid
  const out = { x: 0, z: 0 };
  let calls = 0, callMs = 0, found = 0, frameMax = 0, tt = 1e6;
  const call = new Timer(), cs = cpuNow();
  for (const [name, [x0, z0, x1, z1]] of Object.entries(largeRooms())) {
    const [hx, hz] = b.toWorld((x0 + x1) / 2, (z0 + z1) / 2);
    for (let k = 0; k < 6; k++) {
      tt += 11000;
      ctx.player.head.x = hx; ctx.player.head.z = hz;
      w.update(1 / 72, tt, null, ctx);
      let r = 2, f = 0;
      while (r === 2 && f < 30) {
        call.start();
        r = w.spawnRoam(hx, hz, 0, 0, 1, 0, out);
        call.stop();
        calls++; f++;
      }
      if (f > frameMax) frameMax = f;
      assert.equal(r, 1, `${name}: a spawn`);
      found++;
      assert.notEqual(nameAt(b, out.x, out.z), name, `${name}: never in the player's room`);
      const p = w.pathFromPlayer(out.x, out.z);
      assert.ok(p >= 5 && p <= 30, `${name}: path ${p}`);
    }
  }
  callMs = cpuNow() - cs; // the whole loop on the CPU: the spawn calls plus the room and path checks (an upper bound)
  // path estimate cost
  const cells = w.nav.count;
  let acc = 0;
  const t2 = cpuNow();
  for (let i = 0; i < 200000; i++) acc += R.pathFromPlayerCell((i * 7919) % cells) < Infinity ? 1 : 0;
  const pathNs = ((cpuNow() - t2) * 1e6) / 200000;
  t.diagnostic(`spawn: ${found} spawns from 21 rooms, ${calls} calls, mean ${(callMs / calls).toFixed(3)} ms on the CPU (loop incl. checks), ${call}, at most ${frameMax} frames per spawn; path estimate ${pathNs.toFixed(0)} ns (${acc > 0 ? 'reachable' : ''})`);
  assert.ok(call.worst < 5, `a spawn call took ${call.worst} ms (budget 0.5 ms; desktop noise allowed): ${call}`);
  assert.ok(callMs / calls < 1, `mean spawn call ${callMs / calls} ms`);
  assert.ok(pathNs < 2000, `path estimate ${pathNs} ns`);
});
