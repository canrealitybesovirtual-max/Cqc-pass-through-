// v0.5: the learner's chunked grid, its fusion rules and its stored form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HouseGrid, CELLS, NO_FLOOR } from '../../src/learn/HouseGrid.js';
import { Fuser } from '../../src/learn/fuse.js';
import { encodeChunk, decodeChunk, loadHouse, saveHouse, MemoryStore, MAX_HOUSE_CHUNKS } from '../../src/learn/HouseStore.js';
import { houseFrameOf, invertRigid, apply } from '../../src/learn/houseFrame.js';

test('grid: sparse 4 m chunks from a fixed pool; the weakest chunk is evicted when full', () => {
  const g = new HouseGrid({ maxChunks: 3 });
  const a = g.cell(0.05, 0.05, true), b = g.cell(4.05, 0.05, true), c = g.cell(-0.05, -0.05, true);
  assert.ok(a >= 0 && b >= 0 && c >= 0);
  assert.equal(g.chunkCount, 3);
  assert.notEqual(Math.floor(a / CELLS), Math.floor(c / CELLS), 'negative coordinates are their own chunk');
  g.walked[a] = 9; g.occ[b] = 3; // chunk of c has no evidence
  g.cell(4.05, 0.05, false); // the chunk being written now is never the one evicted
  const d = g.cell(10, 10, true);
  assert.ok(d >= 0);
  assert.equal(g.chunkCount, 3);
  assert.equal(g.evictions, 1);
  assert.equal(g.cell(-0.05, -0.05, false), -1, 'the empty chunk went');
  assert.equal(g.walked[g.cell(0.05, 0.05, false)], 9, 'the walked one stayed');
});

test('fusion: floor points set the cell floor, wall-height hits occupy, lines of sight free, the head walks', () => {
  const g = new HouseGrid({ maxChunks: 16 });
  const f = new Fuser(g, { floorAt: () => 0 });
  for (let k = 0; k < 10; k++) f.addPoint(0, 1.6, 0, 2.05, 0.012, 0.05); // the floor 2 m ahead (12 mm up)
  const c = g.cell(2.05, 0.05, false);
  assert.equal(g.floor[c], 12);
  assert.equal(g.floorW[c], 10);
  for (let k = 0; k < 5; k++) f.addPoint(0, 1.6, 0, 3.05, 1.2, 0.05); // a wall 3 m ahead at 1.2 m
  const w = g.cell(3.05, 0.05, false);
  assert.equal(g.occ[w], 5);
  // the cells between saw free space at wall height (the ray descends from 1.6 to 1.2: all within 0.5–1.9)
  assert.ok(g.free[g.cell(1.55, 0.05, false)] >= 5 && g.free[g.cell(2.55, 0.05, false)] >= 5);
  assert.equal(g.free[w], 0, 'the hit cell itself is not carved');
  f.addPoint(0, 1.6, 0, 1.05, 0.75, 0.05); // a table top 0.75 m up
  const t = g.cell(1.05, 0.05, false);
  assert.equal(g.top[t], 750);
  f.addWalk(5.0, 1.62, 5.0);
  assert.equal(g.walked[g.cell(5.0, 5.0, false)], 1);
  assert.equal(g.walked[g.cell(5.1, 5.1, false)], 1, '3 × 3 cells');
  assert.ok(Math.abs(f.headFloor) < 1e-9);
});

test('storage: chunks round-trip exactly; a corrupt chunk is quarantined and the rest loads', async () => {
  const g = new HouseGrid({ maxChunks: 8 });
  const f = new Fuser(g, { floorAt: () => 0 });
  for (let k = 0; k < 200; k++) f.addPoint(0, 1.6, 0, Math.cos(k) * 3, 0.0, Math.sin(k) * 3);
  for (let k = 0; k < 50; k++) f.addWalk(k * 0.2 - 5, 1.6, 0.3);
  const s0 = [...g.map.values()][0];
  const enc = encodeChunk(g, s0);
  const g2 = new HouseGrid({ maxChunks: 8 });
  const s1 = decodeChunk(g2, enc);
  for (const k of ['floor', 'floorW', 'top', 'topW', 'occ', 'free', 'walked']) {
    for (let i = 0; i < CELLS; i++) {
      const a = g[k][s0 * CELLS + i], b = g2[k][s1 * CELLS + i];
      const empty = !(g.floorW[s0 * CELLS + i] || g.topW[s0 * CELLS + i] || g.occ[s0 * CELLS + i] || g.free[s0 * CELLS + i] || g.walked[s0 * CELLS + i]);
      if (empty) continue;
      assert.equal(b, (k === 'floor' && !g.floorW[s0 * CELLS + i]) || (k === 'top' && !g.topW[s0 * CELLS + i]) ? NO_FLOOR : a, `${k}[${i}]`);
    }
  }
  const bad = enc.slice(); bad[bad.length - 1] ^= 0xff;
  assert.throws(() => decodeChunk(new HouseGrid({ maxChunks: 2 }), bad), /crc/);
  // whole house through a store, one chunk corrupted
  const store = new MemoryStore();
  const r = await saveHouse(store, g, { id: 'house-1', sig: 's', sessions: 1 });
  assert.ok(r.saved && r.chunks >= 3, JSON.stringify(r));
  const key = [...store.m.keys()].find((k) => k.startsWith('c:house-1:'));
  const v = store.m.get(key); v[30] ^= 0x55;
  const g3 = new HouseGrid({ maxChunks: 8 });
  const L = await loadHouse(store, g3, 'house-1');
  assert.equal(L.quarantined, 1);
  assert.equal(L.chunks, r.chunks - 1);
  assert.ok(L.loaded);
  assert.ok([...store.m.keys()].some((k) => k.startsWith('q:house-1:')), 'quarantine record kept');
  assert.ok(![...store.m.keys()].includes(key), 'the corrupt chunk is gone');
});

test('storage: the quota is checked before writing; per-house and per-chunk caps hold', async () => {
  const g = new HouseGrid({ maxChunks: 4 });
  const f = new Fuser(g, { floorAt: () => 0 });
  for (let k = 0; k < 400; k++) f.addWalk(k * 0.05, 1.6, 0);
  const store = new MemoryStore();
  store.quota = 1000;
  const r = await saveHouse(store, g, { id: 'h', sig: 's', sessions: 1 });
  assert.equal(r.saved, false);
  assert.equal(r.why, 'storage quota');
  assert.equal(store.m.size, 0, 'nothing written');
  assert.ok(MAX_HOUSE_CHUNKS <= 160);
});

test('house frame: the largest floor plane, yaw only; the id survives float noise and the frame is the same physical frame', () => {
  const floor = (yaw, x, z, w, d) => ({ label: 'floor', orientation: 'horizontal',
    pose: [Math.cos(yaw), 0, Math.sin(yaw), 0, 0, 1, 0, 0, -Math.sin(yaw), 0, Math.cos(yaw), 0, x, -1.5, z, 1], polygon: [[-w, -d], [w, -d], [w, d], [-w, d]] });
  const wall = (x) => ({ label: 'wall', orientation: 'vertical', pose: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, -0.2, 0, 1], polygon: [[-2, -1.3], [2, -1.3], [2, 1.3], [-2, 1.3]] });
  const a = houseFrameOf({ planes: [floor(0.3, 1, 2, 3, 2), floor(0.3, 5, 2, 1, 1), wall(0), wall(3)] });
  const b = houseFrameOf({ planes: [floor(0.3 + 1e-5, 1 + 1e-4, 2, 3.0001, 2), floor(0.3, 5, 2, 1, 1), wall(0), wall(3)] });
  assert.ok(a && b);
  assert.equal(a.id, b.id);
  // the same session point in house coordinates, then back
  const p = apply(a.m, 2, -1, 3, [0, 0, 0]);
  const q = apply(a.inv, p[0], p[1], p[2], [0, 0, 0]);
  assert.ok(Math.hypot(q[0] - 2, q[1] + 1, q[2] - 3) < 1e-9);
  const I = invertRigid(a.inv, new Float64Array(16));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(I[i] - a.m[i]) < 1e-12);
  // a session that started 2 m further on and turned 40°: the same physical point maps to the same house point
  const yaw = 0.7, cs = Math.cos(yaw), sn = Math.sin(yaw);
  const move = (x, z) => [cs * x + sn * z + 2, -sn * x + cs * z - 1];
  const fl = (y0, x, z) => { const [mx, mz] = move(x, z); return floor(0.3 - yaw, mx, mz, 3, 2); };
  const c = houseFrameOf({ planes: [fl(0, 1, 2), floor(0, 99, 99, 1, 1), wall(0), wall(3)] });
  const [sx, sz] = move(2, 3);
  const pc = apply(c.m, sx, -1, sz, [0, 0, 0]);
  assert.ok(Math.hypot(pc[0] - p[0], pc[2] - p[2]) < 1e-6, `${pc} vs ${p}`);
  assert.equal(houseFrameOf({ planes: [wall(0)] }), null);
});
