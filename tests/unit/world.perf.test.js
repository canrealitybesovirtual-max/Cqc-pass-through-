/**
 * A synthetic house shaped like the user's real Space Setup (docs/DEVICE_LOG.md):
 * 50 planes (2 five-point floors of 111 m² and 14.4 m², 16 walls, 6 doors,
 * 10 tables, 7 shelves, 3 beds, 2 couches, 2 ceilings, 2 wall art) and 25 meshes
 * (22 furniture volumes, a lamp, a plant, the global mesh). One floor polygon
 * covers six rooms split by interior walls; one room is a sealed closet; a
 * few labels are null; the whole house is yawed 17° in the reference space.
 *
 * Measures build time, raycasts and A* expansions per ms in Node (desktop),
 * as a reference for the on-device quota (PLAN §9: ≤ 0.4 ms of A* per frame).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldCore } from '../../src/world/WorldCore.js';
import { NAV_WALK } from '../../src/world/NavGrid.js';
import { userHouse } from './world.houses.js';

const F2 = 0.015;
const bigHouse = () => userHouse();

const now = () => performance.now();

test('111 m² multi-room house: layout, connectivity through doors, sealed closet', (t) => {
  const b = bigHouse();
  const snap = b.build();
  assert.equal(snap.planes.length, 50);
  assert.equal(snap.meshes.length, 25);
  const w = new WorldCore();
  const [px, pz] = b.toWorld(6.0, 2.8);
  w.build(snap, { x: px, z: pz });
  assert.equal(w.stats.floors, 2);
  assert.equal(w.stats.walls, 16);
  assert.equal(w.stats.doors, 6);
  assert.equal(w.stats.furniture, 24, '22 objects (planes merged into their volumes) + lamp + plant');
  assert.equal(w.layout.doors[5].walls, 2, 'the door between the floors cuts both edge walls');
  assert.ok(w.stats.shapes <= 80, `shapes ${w.stats.shapes}`);
  const g = w.nav;
  const at = (x, z) => { const [wx, wz] = b.toWorld(x, z); return g.index(wx, wz); };
  const rooms = { A: [2, 2.5], B: [3, 7.5], C: [5.5, 5.5], D: [6, 7], E: [11, 1.5], F: [10, 6.5], G: [13.5, 1.5] };
  const want = { A: 1, B: 2, C: 0, D: 1, E: 3, F: 2, G: 4 };
  for (const [name, [x, z]] of Object.entries(rooms)) {
    const i = at(x, z);
    assert.ok(g.flags[i] & NAV_WALK, `room ${name} walkable`);
    assert.ok(g.pathDist[i] < Infinity, `room ${name} reachable`);
    assert.equal(g.doors[i], want[name], `room ${name}: doors crossed`);
  }
  const closet = at(2, 9.25);
  assert.ok(g.flags[closet] & NAV_WALK);
  assert.equal(g.pathDist[closet], Infinity, 'the sealed closet is unreachable');
  assert.ok(Math.abs(w.floorY(...b.toWorld(13.5, 1.5)) - F2) < 1e-3, 'second floor height');
  t.diagnostic(`build ${w.stats.buildMs.toFixed(1)} ms (first build, cold JIT): ${g.w}×${g.h} = ${g.count} cells, ${g.walkableCount} walkable, ${w.stats.shapes} shapes, ${w.stats.spawnCandidates} spawn candidates`);

  // Spawn: from the player looking at the A–C door, the best spawn is hidden behind a door.
  const out = { x: 0, z: 0 };
  const [vx, vz] = b.dirToWorld(-1, 0);
  for (let k = 0; k < 20; k++) {
    w.update(0, k * 11000);
    assert.ok(w.findSpawn(px, pz, vx, vz, 4, out));
    assert.equal(w.spawner.lastTier, 3);
    assert.ok(w.nav.isReachable(out.x, out.z));
    assert.ok(Math.hypot(out.x - px, out.z - pz) >= 4);
  }
});

test('performance in Node: build, raycasts, spawn queries and A* expansions per ms', (t) => {
  const b = bigHouse();
  const snap = b.build();
  const w = new WorldCore();
  const [px, pz] = b.toWorld(6.0, 2.8);
  for (let k = 0; k < 3; k++) w.build(snap, { x: px, z: pz }); // warm the JIT
  const t0 = now();
  const N = 10;
  for (let k = 0; k < N; k++) w.build(snap, { x: px, z: pz });
  const buildMs = (now() - t0) / N;

  const hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
  let hits = 0;
  const R = 100000;
  const t1 = now();
  for (let i = 0; i < R; i++) {
    const a = i * 0.000631, e = ((i % 17) - 8) * 0.05;
    if (w.raycast(px, 1.5, pz, Math.cos(a), e, Math.sin(a), 30, hit)) hits++;
  }
  const rayUs = ((now() - t1) * 1000) / R;
  assert.equal(hits, R, 'every ray in a closed house hits something');

  const t2 = now();
  const out = { x: 0, z: 0 };
  const S = 200;
  for (let i = 0; i < S; i++) { w.update(0, i * 11000); w.findSpawn(px, pz, Math.cos(i), Math.sin(i), 4, out); }
  const spawnUs = ((now() - t2) * 1000) / S;

  // A*: random reachable pairs, sliced at 1000 expansions per step like a frame quota.
  const g = w.nav, p = w.createPlanner();
  // Pairs within the largest region (the player zone can split a room into regions an enemy can't cross).
  const byRegion = new Map();
  for (let i = 0; i < g.count; i++) {
    if (!(g.flags[i] & NAV_WALK) || g.pathDist[i] === Infinity) continue;
    if (!byRegion.has(g.region[i])) byRegion.set(g.region[i], []);
    byRegion.get(g.region[i]).push(i);
  }
  const cells = [...byRegion.values()].sort((a, b) => b.length - a.length)[0];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pair = () => [cells[Math.floor(rnd() * cells.length)], cells[Math.floor(rnd() * cells.length)]];
  const outPath = new Float32Array(128);
  const runSearches = (n) => {
    let steps = 0, maxStep = 0, found = 0;
    for (let k = 0; k < n; k++) {
      const [s, e] = pair();
      p.request(0, g.centerX(s), g.centerZ(s), g.centerX(e), g.centerZ(e));
      while (p.pending()) { const ts = now(); p.step(1000); maxStep = Math.max(maxStep, now() - ts); steps++; }
      if (p.result(0, outPath) >= 2) found++;
    }
    return { steps, maxStep, found };
  };
  runSearches(50); // warm
  const e0 = p.stats.expansions, d0 = p.stats.direct;
  const t3 = now();
  const r = runSearches(400);
  const ms = now() - t3;
  const expansions = p.stats.expansions - e0;
  assert.equal(r.found, 400, 'every reachable pair has a path');
  const perMs = expansions / ms;
  t.diagnostic(`build ${buildMs.toFixed(2)} ms warm (${g.count} cells); raycast ${rayUs.toFixed(2)} µs; findSpawn ${spawnUs.toFixed(1)} µs`);
  t.diagnostic(`A*: ${expansions} expansions in ${ms.toFixed(1)} ms = ${Math.round(perMs)} expansions/ms; ${p.stats.direct - d0} of 400 direct; worst 1000-expansion step ${r.maxStep.toFixed(2)} ms`);
  // Loose bounds (desktop Node), to catch regressions rather than to measure the Quest.
  assert.ok(buildMs < 150, `build ${buildMs} ms`);
  assert.ok(rayUs < 20, `raycast ${rayUs} µs`);
  assert.ok(spawnUs < 2000, `findSpawn ${spawnUs} µs`);
  assert.ok(perMs > 500, `A* ${perMs} expansions/ms`);
});
