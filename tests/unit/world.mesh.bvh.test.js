// The flat typed-array BVH over the global mesh (src/world/MeshBVH.js): exact against brute
// force, segment tests that agree with rays, zero allocation per query, transferable buffers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MeshBVH } from '../../src/world/MeshBVH.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { cpuNow } from './cpuclock.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const scan = scanFromSnapshot(house(), { clutter: [{ cx: 0.2, cz: -2.2, hx: 0.25, hz: 0.25, h: 0.9 }] });
const bvh = new MeshBVH().build(scan.vertices, scan.indices);

/** Möller–Trumbore over every triangle (both faces). */
function brute(V, I, ox, oy, oz, dx, dy, dz, max) {
  let best = max, bt = -1;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2], e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const sx = ox - V[a], sy = oy - V[a + 1], sz = oz - V[a + 2];
    const u = (sx * px + sy * py + sz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (tt > 0 && tt < best) { best = tt; bt = t; }
  }
  return bt < 0 ? -1 : best;
}

let seed = 9;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const hit = () => ({ dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' });

test('2,000 random rays match brute force within 1e-5 m; normals face the ray origin', () => {
  const out = hit();
  let hits = 0;
  for (let i = 0; i < 2000; i++) {
    const ox = -1.8 + rnd() * 8, oy = 0.1 + rnd() * 2.2, oz = -2.9 + rnd() * 3.8;
    let dx = rnd() - 0.5, dy = rnd() - 0.5, dz = rnd() - 0.5;
    const l = Math.hypot(dx, dy, dz);
    dx /= l; dy /= l; dz /= l;
    const want = brute(scan.vertices, scan.indices, ox, oy, oz, dx, dy, dz, 30);
    const got = bvh.raycast(ox, oy, oz, dx, dy, dz, 30, out);
    assert.equal(got, want >= 0, `ray ${i}`);
    if (got) {
      hits++;
      assert.ok(Math.abs(out.dist - want) < 1e-5, `ray ${i}: ${out.dist} vs ${want}`);
      assert.ok(out.nx * dx + out.ny * dy + out.nz * dz <= 1e-9, 'normal toward the origin');
      assert.ok(Math.abs(Math.hypot(out.nx, out.ny, out.nz) - 1) < 1e-5);
      assert.ok(bvh.lastTri >= 0 && bvh.lastTri < bvh.triCount);
    }
  }
  assert.ok(hits > 1500, `${hits} hits inside a closed house`);
  assert.ok(bvh.depth < 40, `depth ${bvh.depth}`);
});

test('segmentClear agrees with raycast; max distance is honoured; a miss writes nothing', () => {
  const out = hit();
  for (let i = 0; i < 1000; i++) {
    const ax = -1.8 + rnd() * 8, ay = 0.1 + rnd() * 2.2, az = -2.9 + rnd() * 3.8;
    const bx = -1.8 + rnd() * 8, by = 0.1 + rnd() * 2.2, bz = -2.9 + rnd() * 3.8;
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    const blocked = bvh.raycast(ax, ay, az, bx - ax, by - ay, bz - az, L - 2e-3, out) && out.dist > 1e-3;
    assert.equal(bvh.segmentClear(ax, ay, az, bx, by, bz), !blocked, `segment ${i}`);
  }
  const o2 = hit();
  o2.dist = 123;
  assert.equal(bvh.raycast(0.5, 1.2, -1, 1, 0, 0, 0.01, o2), false, 'nothing within 1 cm');
  assert.equal(o2.dist, 123);
  assert.equal(new MeshBVH().raycast(0, 0, 0, 1, 0, 0, 10, o2), false, 'an empty BVH hits nothing');
  assert.equal(new MeshBVH().segmentClear(0, 0, 0, 1, 0, 0), true);
});

test('queries allocate no objects (50k rays + 50k segments) and cost a few µs (CPU time)', () => {
  const out = hit();
  const P = new Float64Array(6);
  const run = (n) => {
    let h = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 0.000631, e = ((i % 17) - 8) * 0.05;
      P[0] = 0.5 + (i % 7) * 0.1; P[1] = 1.4; P[2] = -1 + (i % 5) * 0.1;
      if (bvh.raycast(P[0], P[1], P[2], Math.cos(a), e, Math.sin(a), 30, out)) h++;
      if (!bvh.segmentClear(P[0], P[1], P[2], P[0] + Math.cos(a) * 3, P[1] - 0.5, P[2] + Math.sin(a) * 3)) h++;
    }
    return h;
  };
  run(20000);
  // best of up to 8 reps (CPU-clock / GC-timing noise under parallel test load); no objects per
  // query: at most the doubles a test call site boxes (the project's convention, cf. enemy.fall)
  let grew = Infinity;
  for (let k = 0; k < 8 && grew / 100000 >= 16; k++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    run(50000);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew / 100000 < 16, `${(grew / 100000).toFixed(2)} B per query over 50k rays + 50k segments`);
  const c0 = cpuNow();
  run(50000);
  const us = ((cpuNow() - c0) * 1000) / 100000;
  assert.ok(us < 20, `${us.toFixed(2)} µs per query`);
});

test('toBuffers / fromBuffers wrap the same arrays (transfer, no copy) and answer identically', () => {
  const b = bvh.toBuffers();
  const clone = structuredClone(b); // what a worker → main transfer delivers
  const w = MeshBVH.fromBuffers(clone);
  assert.equal(w.nodeCount, bvh.nodeCount);
  assert.equal(w.triCount, bvh.triCount);
  const a = MeshBVH.fromBuffers(b);
  assert.equal(a.tri, bvh.tri, 'wrapped, not copied');
  const o1 = hit(), o2 = hit();
  for (let i = 0; i < 300; i++) {
    const ang = i * 0.021;
    assert.equal(w.raycast(1, 1, -1, Math.cos(ang), -0.2, Math.sin(ang), 20, o1), bvh.raycast(1, 1, -1, Math.cos(ang), -0.2, Math.sin(ang), 20, o2));
    assert.equal(o1.dist, o2.dist);
  }
  assert.ok(bvh.bytes() > 0 && bvh.bytes() < 64 * bvh.triCount, `${bvh.bytes()} B for ${bvh.triCount} triangles`);
});
