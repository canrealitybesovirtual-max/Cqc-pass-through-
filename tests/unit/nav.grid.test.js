import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NavGrid, NAV_DOOR, NAV_FURN, NAV_INSIDE, NAV_OBST, NAV_WALK, NAV_WALL, NAV_ZONE,
} from '../../src/world/NavGrid.js';

/**
 * Bake a grid by hand, the way WorldCore does: floor polygons, wall boxes
 * (+ half a cell), furniture (+2 cm obstacle, +0.25 m footprint), door carve,
 * distance transform, zone, finalize.
 */
function bake({ floors, walls = [], furniture = [], doors = [], start = [0, 0], zoneR = 0, w, h, ox = 0, oz = 0, cap = 65536 }) {
  const g = new NavGrid(cap);
  g.reset(ox, oz, w, h);
  floors.forEach((f, k) => g.fillPolygon(f, f.length / 2, NAV_INSIDE, k));
  for (const b of walls) g.fillBox(b.cx, b.cz, b.c ?? 1, b.s ?? 0, b.hx, b.hz, g.cell / 2, NAV_WALL);
  for (const b of furniture) {
    g.fillBox(b.cx, b.cz, b.c ?? 1, b.s ?? 0, b.hx, b.hz, 0.02, NAV_OBST);
    g.fillBox(b.cx, b.cz, b.c ?? 1, b.s ?? 0, b.hx, b.hz, 0.25, NAV_FURN);
  }
  for (const d of doors) g.fillBox(d.cx, d.cz, d.c ?? 1, d.s ?? 0, d.hx, d.hz, 0, NAV_DOOR, NAV_WALL);
  g.computeClearance(NAV_WALL | NAV_OBST);
  if (zoneR > 0) g.fillDisc(start[0], start[1], zoneR, NAV_ZONE);
  g.finalize(0.28, start[0], start[1]);
  return g;
}

const rect = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

test('a 4 × 3 m room: inside cells, clearance from the walls, walkable shrunk by the agent clearance', () => {
  const g = bake({ floors: [rect(0, 0, 4, 3)], w: 50, h: 40, ox: -0.5, oz: -0.5, start: [2, 1.5] });
  let inside = 0;
  for (let i = 0; i < g.count; i++) if (g.flags[i] & NAV_INSIDE) inside++;
  assert.equal(inside, 40 * 30);
  // Clearance at the room centre: 1.5 m to the nearest edge (z = 0 or 3), minus quantisation.
  assert.ok(Math.abs(g.clearance(2.05, 1.55) - 1.45) < 0.06, `clearance ${g.clearance(2.05, 1.55)}`);
  assert.ok(Math.abs(g.clearance(0.55, 1.55) - 0.5) < 0.06);
  assert.ok(g.isWalkable(2, 1.5));
  assert.ok(g.isWalkable(0.35, 1.5)); // 0.35 m from the wall ≥ 0.28
  assert.ok(!g.isWalkable(0.15, 1.5)); // 0.15 m: the body would touch the wall
  assert.ok(!g.isWalkable(-0.2, 1.5)); // off the floor
  assert.ok(!g.isWalkable(100, 100)); // off the grid
  assert.equal(g.clearance(100, 100), 0);
  assert.equal(g.regionCount, 1);
});

test('distance transform is exact (matches brute force on random obstacles)', () => {
  const g = new NavGrid(4096);
  g.reset(0, 0, 37, 23);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  g.fillPolygon(rect(0.05, 0.05, 3.65, 2.25), 4, NAV_INSIDE, 0);
  const obst = [];
  for (let i = 0; i < 60; i++) {
    const k = Math.floor(rnd() * g.count);
    g.flags[k] |= NAV_OBST;
  }
  for (let i = 0; i < g.count; i++) if ((g.flags[i] & NAV_INSIDE) === 0 || g.flags[i] & NAV_OBST) obst.push(i);
  g.computeClearance(NAV_OBST);
  for (let i = 0; i < g.count; i++) {
    const ix = i % g.w, iz = Math.floor(i / g.w);
    let best = Infinity;
    for (const o of obst) {
      const dx = (o % g.w) - ix, dz = Math.floor(o / g.w) - iz;
      best = Math.min(best, dx * dx + dz * dz);
    }
    const want = best === 0 ? 0 : Math.sqrt(best) * 0.1 - 0.05;
    assert.ok(Math.abs(g.clr[i] - want) < 1e-5, `cell ${i}: ${g.clr[i]} vs ${want}`);
  }
});

test('a wall splits two rooms; a carved 0.85 m door joins them; a 0.5 m door is too narrow', () => {
  const floors = [rect(0, 0, 4, 3), rect(4.1, 0, 7, 3)];
  const wall = { cx: 4.05, cz: 1.5, hx: 0.05, hz: 1.6 };
  const opts = { floors, w: 80, h: 40, ox: -0.5, oz: -0.5, start: [1, 1.5] };
  const closed = bake({ ...opts, walls: [wall] });
  assert.ok(closed.isWalkable(1, 1.5) && closed.isWalkable(6, 1.5));
  assert.notEqual(closed.region[closed.index(1, 1.5)], closed.region[closed.index(6, 1.5)]);
  assert.ok(!closed.isReachable(6, 1.5));
  assert.equal(closed.pathDistance(6, 1.5), Infinity);

  // Wall pieces around a door at z ∈ [1.0, 1.85], carved ±0.35 m across the wall.
  const pieces = (z0, z1) => [{ cx: 4.05, cz: (-0.1 + z0) / 2, hx: 0.05, hz: (z0 + 0.1) / 2 }, { cx: 4.05, cz: (z1 + 3.1) / 2, hx: 0.05, hz: (3.1 - z1) / 2 }];
  const open = bake({ ...opts, walls: pieces(1.0, 1.85), doors: [{ cx: 4.05, cz: 1.425, hx: 0.35, hz: 0.425 }] });
  assert.equal(open.region[open.index(1, 1.5)], open.region[open.index(6, 1.5)]);
  assert.ok(open.isReachable(6, 1.5));
  assert.ok(open.flags[open.index(4.05, 1.425)] & NAV_DOOR);
  assert.ok(open.isWalkable(4.05, 1.425), 'door centre walkable');
  assert.ok(open.clearance(4.05, 1.425) >= 0.33, `door clearance ${open.clearance(4.05, 1.425)}`);
  assert.equal(open.doors[open.index(1, 1.5)], 0);
  assert.equal(open.doors[open.index(6, 1.5)], 1, 'the second room is one door away');
  const pd = open.pathDistance(6, 1.5);
  assert.ok(pd > 5 && pd < 5.4, `path distance ${pd}`);

  const narrow = bake({ ...opts, walls: pieces(1.2, 1.7), doors: [{ cx: 4.05, cz: 1.45, hx: 0.35, hz: 0.25 }] });
  assert.notEqual(narrow.region[narrow.index(1, 1.5)], narrow.region[narrow.index(6, 1.5)]);
});

test('furniture blocks its footprint + 0.25 m; the player zone blocks r + 1.2 m', () => {
  const g = bake({
    floors: [rect(0, 0, 6, 6)], w: 70, h: 70, ox: -0.5, oz: -0.5, start: [1.5, 1.5], zoneR: 2.0,
    furniture: [{ cx: 4, cz: 4, c: Math.cos(0.4), s: Math.sin(0.4), hx: 0.6, hz: 0.4 }],
  });
  assert.ok(g.flags[g.index(4, 4)] & NAV_FURN);
  assert.ok(!g.isWalkable(4, 4));
  // 0.2 m off the long side (axis 2 = (-sin, cos)): blocked; 0.4 m off: free.
  const ax = -Math.sin(0.4), az = Math.cos(0.4);
  assert.ok(!g.isWalkable(4 + ax * 0.6, 4 + az * 0.6));
  assert.ok(g.isWalkable(4 + ax * 0.8, 4 + az * 0.8));
  assert.ok(g.flags[g.index(1.5, 1.5)] & NAV_ZONE);
  assert.ok(!g.isWalkable(1.5, 1.5));
  assert.ok(!g.isWalkable(2.9, 1.5)); // 1.4 m from the start
  assert.ok(g.isWalkable(3.6, 1.5)); // 2.1 m
  // The path field runs through the zone: reachable cells just outside it are close.
  assert.ok(g.pathDistance(3.6, 1.5) < 2.4, `path ${g.pathDistance(3.6, 1.5)}`); // 2.1 m straight + grid steps
  assert.ok(g.isReachable(3.6, 1.5));
});

test('lineWalkable follows the cells and never cuts a corner', () => {
  const g = new NavGrid(1024);
  g.reset(0, 0, 10, 10);
  for (let i = 0; i < g.count; i++) g.flags[i] = NAV_INSIDE | NAV_WALK;
  assert.ok(g.lineWalkable(0.05, 0.05, 0.95, 0.95));
  // Block (5, 4) and (4, 5): the exact diagonal through their shared corner must fail.
  g.flags[4 * 10 + 5] = NAV_INSIDE;
  g.flags[5 * 10 + 4] = NAV_INSIDE;
  assert.ok(!g.lineWalkable(0.05, 0.05, 0.95, 0.95));
  // A line that passes beside them is fine.
  assert.ok(g.lineWalkable(0.05, 0.25, 0.25, 0.95));
  // Blocked endpoint / outside.
  assert.ok(!g.lineWalkable(0.05, 0.05, 0.45, 0.55));
  assert.ok(!g.lineWalkable(0.05, 0.05, 1.5, 0.05));
});

test('nearestWalkable returns the closest walkable cell within the radius', () => {
  const g = new NavGrid(1024);
  g.reset(0, 0, 20, 20);
  g.flags[3 * 20 + 15] = NAV_WALK; // centre (1.55, 0.35)
  g.flags[18 * 20 + 2] = NAV_WALK; // centre (0.25, 1.85)
  assert.equal(g.nearestWalkable(1.4, 0.3, 0.5), 3 * 20 + 15);
  assert.equal(g.nearestWalkable(0.3, 1.6, 0.5), 18 * 20 + 2);
  assert.equal(g.nearestWalkable(1.0, 1.0, 0.3), -1);
  assert.equal(g.nearestWalkable(1.0, 1.0, 1.0), 3 * 20 + 15); // 0.85 m vs 1.13 m
  const i = g.nearestWalkable(1.0, 0.9, 1.0);
  const d = Math.hypot(g.centerX(i) - 1.0, g.centerZ(i) - 0.9);
  assert.ok(d < 0.9, `nearest at ${d}`);
});

test('reset rejects grids over capacity and bumps the version', () => {
  const g = new NavGrid(100);
  const v = g.version;
  g.reset(0, 0, 10, 10);
  assert.equal(g.version, v + 1);
  assert.throws(() => g.reset(0, 0, 11, 10));
});

test('queries do not allocate', () => {
  const g = bake({ floors: [rect(0, 0, 6, 6)], w: 70, h: 70, ox: -0.5, oz: -0.5, start: [1, 1] });
  let acc = 0;
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      const x = (i % 97) * 0.06, z = (i % 89) * 0.065;
      if (g.isWalkable(x, z)) acc++;
      acc += g.clearance(x, z);
      if (g.lineWalkable(0.5, 0.5, x, z)) acc++;
      acc += g.nearestWalkable(x, z, 0.5);
    }
  };
  run(20000);
  // least growth over 3 windows: one window can catch JIT tiering or GC timing under parallel test load
  let grew = Infinity;
  for (let k = 0; k < 3 && grew >= 1_000_000; k++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    run(100000);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 1_000_000, `heap grew ${grew} bytes`);
  assert.ok(acc > 0);
  assert.equal(NAV_WALK, 64);
});
