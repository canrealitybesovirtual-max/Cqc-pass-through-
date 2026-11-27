/**
 * World on tests/fixtures/house.json (reference space = local-floor, metres):
 *   living room x −2…3, z −3…1 (floor y −0.004), player at (0, 0) facing −z;
 *   bedroom x 3.1…6.6, z −3…0 (floor y 0.012), through a 0.85 m door in the
 *   wall x = 3.0…3.1 at z −2.6…−1.75 (door planes seen from both rooms);
 *   hallway door (unmapped beyond) in the north wall z = −3 at x −1.6…−0.7;
 *   couch x −1.95…−1.05, z −2.4…−0.6, 0.85 high; table centre (1.4, −1.8),
 *   1.2 × 0.8 m yawed 10°, 0.75 high; bed x 4.6…6.6, z −1.9…−0.3, 0.55 high.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { WorldCore } from '../../src/world/WorldCore.js';
import { NAV_DOOR, NAV_FURN, NAV_POCKET, NAV_VIRTUAL, NAV_ZONE } from '../../src/world/NavGrid.js';
import { PATH_PENDING } from '../../src/world/PathPlanner.js';
import { OCC_INDICES_PER_BOX, writeOccluderBoxes } from '../../src/world/Occluder.js';
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const hit = () => ({ dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' });
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

let shared;
function world() {
  if (!shared) { shared = new WorldCore(); shared.build(house(), { x: 0, z: 0 }); }
  return shared;
}

test('layout: 2 floors, 8 walls, 3 doors cut into 5 walls, 3 merged furniture boxes', () => {
  const w = world();
  assert.equal(w.virtual, false);
  assert.equal(w.partialVirtual, false);
  assert.equal(w.stats.floors, 2);
  assert.equal(w.stats.walls, 8);
  assert.equal(w.stats.doors, 3);
  assert.equal(w.stats.furniture, 3, 'wall art and the global mesh are ignored');
  const L = w.layout;
  assert.deepEqual(L.doors.map((d) => d.walls), [2, 2, 1], 'each side of the shared wall gets the opening');
  assert.equal(L.walls.filter((x) => x.openings.length).length, 3);
  assert.ok(L.walls.every((x) => x.side === 'edge'), 'every wall sits on a floor edge');
  const labels = L.furniture.map((b) => `${b.label}:${b.source}`).sort();
  assert.deepEqual(labels, ['bed:mesh+plane', 'couch:mesh+plane', 'table:mesh+plane']);
  for (const f of L.floors) assert.ok(f.area > 0, 'floors are CCW');
  // 14 wall pieces (3 walls → 2 jambs + lintel) + 3 furniture boxes, well under the ~80 budget.
  assert.equal(w.shapes.count, 17);
  assert.match(w.describe(), /2 floors, 8 walls, 3 doors, 3 objects/);
});

test('floorY: each room keeps its own floor height; ceilingY per room', () => {
  const w = world();
  assert.ok(near(w.floorY(0, 0), -0.004));
  assert.ok(near(w.floorY(5, -2.5), 0.012));
  const d = w.floorY(3.05, -2.175); // in the door gap: one of the two
  assert.ok(near(d, -0.004) || near(d, 0.012));
  assert.ok(near(w.floorY(50, 50), -0.004), 'off the grid: the main floor');
  assert.ok(near(w.ceilingY(0, 0), 2.5));
  assert.ok(near(w.ceilingY(5, -1), 2.47));
});

test('raycast: walls, door openings, lintels and jambs', () => {
  const w = world();
  const h = hit();
  assert.ok(w.raycast(0, 1.5, 0, 0, 0, -1, 20, h));
  assert.ok(near(h.dist, 3) && near(h.z, -3), 'north wall face');
  assert.deepEqual([h.nx, h.ny, h.nz], [0, 0, 1]);
  assert.equal(h.kind, 'world');
  assert.equal(h.surface, 'wall');
  assert.equal(h.enemy, -1);
  // Hallway door opening: nothing behind it at chest height.
  const m = hit();
  assert.equal(w.raycast(-1.15, 1.0, 0, 0, 0, -1, 20, m), false);
  assert.equal(m.kind, 'none', 'out untouched on a miss');
  // Lintel above the door top (2.03 m), and the jamb beside it.
  assert.ok(w.raycast(-1.15, 2.2, 0, 0, 0, -1, 20, h) && near(h.z, -3) && h.surface === 'wall');
  assert.ok(w.raycast(-0.55, 1.0, 0, 0, 0, -1, 20, h) && near(h.z, -3));
  // Through the bedroom door to the bedroom's far wall.
  assert.ok(w.raycast(0, 1.2, -2.175, 1, 0, 0, 20, h));
  assert.ok(near(h.x, 6.6) && near(h.nx, -1), `x ${h.x}`);
  // Beside the door the shared wall stops the shot at its living-room face.
  assert.ok(w.raycast(0, 1.2, -1.0, 1, 0, 0, 20, h) && near(h.x, 3.0));
  // max distance, and an unnormalised direction gives the same metric distance.
  assert.equal(w.raycast(0, 1.5, 0, 0, 0, -1, 2.9, hit()), false);
  assert.ok(w.raycast(0, 1.5, 0, 0, 0, -5, 20, h) && near(h.dist, 3));
});

test('raycast: furniture (rotated table, couch), floor, ceiling', () => {
  const w = world();
  const h = hit();
  assert.ok(w.raycast(1.4, 2.0, -1.8, 0, -1, 0, 5, h));
  assert.ok(near(h.y, 0.75) && h.surface === 'table' && near(h.ny, 1));
  // The table is yawed 10°: its +z-facing long side has normal (−sin10°, 0, cos10°).
  assert.ok(w.raycast(1.4, 0.5, 0, 0, 0, -1, 5, h) && h.surface === 'table');
  const s = Math.sin((10 * Math.PI) / 180), c = Math.cos((10 * Math.PI) / 180);
  assert.ok(near(h.nx, -s) && near(h.nz, c), `normal ${h.nx} ${h.nz}`);
  assert.ok(near((h.x - 1.4) * -s + (h.z + 1.8) * c, 0.4), 'hit point on the side face');
  assert.ok(w.raycast(0, 0.5, -1.5, -1, 0, 0, 5, h) && h.surface === 'couch' && near(h.x, -1.05));
  // A shot from inside a box ignores that box (mapping error at the muzzle).
  assert.ok(w.raycast(-1.5, 0.5, -1.5, -1, 0, 0, 5, h) && h.surface === 'wall' && near(h.x, -2) && h.nx === 1);
  assert.ok(w.raycast(0, 1.5, 0, 0, -1, 0, 5, h) && h.surface === 'floor' && near(h.y, -0.004) && h.ny === 1);
  assert.ok(w.raycast(5, 1.5, -2.5, 0, -1, 0, 5, h) && near(h.y, 0.012), 'bedroom floor height');
  assert.ok(w.raycast(0, 1.5, 0, 0, 1, 0, 5, h) && h.surface === 'ceiling' && near(h.y, 2.5) && h.ny === -1);
  // Down through the hallway door into the unmapped hallway: the fallback floor plane.
  const dz = -1, dy = -0.45;
  assert.ok(w.raycast(-1.15, 1.0, -2.5, 0, dy, dz, 10, h) && h.surface === 'floor');
  assert.ok(h.z < -3.1 && near(h.y, -0.004), `z ${h.z}`);
});

test('segmentClear: walls block, the door opening and open air do not, low cover blocks low lines', () => {
  const w = world();
  assert.equal(w.segmentClear(0, 1.6, 0, 5, 1.2, -1), false, 'into the bedroom through the wall');
  assert.equal(w.segmentClear(0, 1.6, 0, 4, 1.4, -2.9), true, 'through the door');
  assert.equal(w.segmentClear(4, 1.4, -2.9, 0, 1.6, 0), true, 'symmetric');
  assert.equal(w.segmentClear(1.4, 0.4, -0.5, 1.4, 0.4, -2.7), false, 'through the table at knee height');
  assert.equal(w.segmentClear(1.4, 1.0, -0.5, 1.4, 1.0, -2.7), true, 'over the table');
  assert.equal(w.segmentClear(-1.15, 1.5, -2.5, -1.15, 1.5, -4), true, 'through the hallway door');
  assert.equal(w.segmentClear(-1.15, 2.3, -2.5, -1.15, 2.3, -4), false, 'lintel');
  assert.equal(w.segmentClear(1.4, 0.6, -1.8, 1.4, 1.5, -1.8), false, 'an endpoint inside the table counts as blocked');
});

test('nav: door gaps carved through both wall slabs; the bedroom is one door away', () => {
  const w = world();
  const g = w.nav;
  assert.ok(g.isWalkable(3.05, -2.175), 'door centre');
  assert.ok(g.flags[g.index(3.05, -2.175)] & NAV_DOOR);
  assert.ok(!g.isWalkable(3.05, -1.0), 'inside the wall');
  assert.ok(!g.isWalkable(2.85, -0.5), '0.15 m from the wall face');
  assert.ok(g.isWalkable(2.6, -2.6));
  assert.ok(g.isReachable(4.0, -2.0));
  assert.equal(g.region[g.index(4.0, -2.0)], g.region[g.index(2.6, -2.6)]);
  assert.equal(g.doors[g.index(2.6, -2.6)], 0);
  assert.equal(g.doors[g.index(4.0, -2.0)], 1);
  // The hallway door is carved too; it leads into unmapped space, so a small virtual pocket lies behind it.
  assert.ok(g.flags[g.index(-1.15, -3.2)] & NAV_DOOR);
  assert.ok(g.isReachable(-1.15, -4.0), 'pocket behind the hallway door');
  assert.ok(g.flags[g.index(-1.15, -4.0)] & NAV_POCKET && g.flags[g.index(-1.15, -4.0)] & NAV_VIRTUAL);
  assert.ok(!g.isWalkable(-1.15, -5.4), 'nothing beyond the 2 m pocket');
  assert.ok(!g.isWalkable(-2.4, -4.0), 'nor beside it');
  // Furniture + 0.25 m and the player zone (0.8 + 1.2 m).
  assert.ok(g.flags[g.index(4.4, -1.0)] & NAV_FURN);
  assert.ok(!g.isWalkable(4.4, -1.0), '0.2 m from the bed');
  assert.ok(g.isWalkable(4.22, -1.0), '0.38 m from the bed');
  assert.ok(g.flags[g.index(1.0, -1.0)] & NAV_ZONE);
  assert.ok(!g.isWalkable(1.0, -1.0));
  assert.ok(g.pathDistance(4.0, -2.0) > 4.5 && g.pathDistance(4.0, -2.0) < 6.5);
});

test('A* from the bedroom to the living room goes through the door', () => {
  const w = world();
  const p = w.createPlanner();
  p.request(0, 4.0, -0.6, 2.6, -2.6);
  const out = new Float32Array(64);
  let n;
  while ((n = p.result(0, out)) === PATH_PENDING) p.step(500);
  assert.ok(n >= 3, `points ${n}`);
  let through = false;
  for (let i = 0; i < n; i++) assert.ok(w.nav.isWalkable(out[2 * i], out[2 * i + 1]));
  for (let i = 1; i < n; i++) {
    const ax = out[2 * i - 2], az = out[2 * i - 1], bx = out[2 * i], bz = out[2 * i + 1];
    assert.ok(w.nav.lineWalkable(ax, az, bx, bz));
    if ((ax - 3.05) * (bx - 3.05) <= 0) {
      const z = az + ((3.05 - ax) / (bx - ax)) * (bz - az);
      assert.ok(z > -2.6 && z < -1.75, `crosses the wall at z ${z}`);
      through = true;
    }
  }
  assert.ok(through);
});

test('findSpawn: behind the bedroom door or in the hallway pocket, hidden, reachable, ≥ minDist, varied', () => {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 });
  const out = { x: 0, z: 0 };
  const seen = new Set();
  const p = w.createPlanner();
  let bedroom = 0, pocket = 0;
  for (let k = 0; k < 12; k++) {
    w.update(0, k * 15000); // 15 s apart: the recent-spawn memory has expired
    // Looking straight at the bedroom door.
    assert.ok(w.findSpawn(0, 0, 3, -2.175, 3.5, out), `spawn ${k}`);
    assert.equal(w.spawner.lastTier, 3, 'far side of a door, hidden');
    // v0.4.1: the hallway pocket is hidden by its door curtain (out of sight whatever the sight lines through the door)
    const inPocket = w.nav.isHidden(out.x, out.z);
    assert.ok(out.x > 3.1 || (inPocket && out.z < -3.1), `in the bedroom or behind the hallway door: ${out.x}, ${out.z}`);
    if (inPocket) pocket++; else bedroom++;
    assert.ok(Math.hypot(out.x, out.z) >= 3.5);
    assert.ok(w.nav.isReachable(out.x, out.z));
    const fy = w.floorY(out.x, out.z);
    if (!inPocket) for (const hh of [0.45, 1.1, 1.65]) assert.equal(w.segmentClear(0, -0.004 + 1.6, 0, out.x, fy + hh, out.z), false);
    seen.add(`${out.x.toFixed(2)},${out.z.toFixed(2)}`);
    // An enemy spawned there can walk up to the player (the player zone splits the living room into two
    // regions in this stationary build: the hallway pocket's side reaches the zone from the west)
    const reg = w.nav.region[w.nav.index(out.x, out.z)];
    let gi = -1, gd = Infinity;
    for (let i = 0; i < w.nav.count; i++) {
      if (w.nav.region[i] !== reg || !w.nav.isWalkable(w.nav.centerX(i), w.nav.centerZ(i))) continue;
      const d = Math.hypot(w.nav.centerX(i), w.nav.centerZ(i));
      if (d < gd) { gd = d; gi = i; }
    }
    assert.ok(gi >= 0 && gd < 3.5, `his region reaches the player: ${gd}`);
    p.request(1, out.x, out.z, w.nav.centerX(gi), w.nav.centerZ(gi));
    while (p.pending()) p.step(1000);
    assert.ok(p.result(1, new Float32Array(64)) >= 2);
  }
  assert.ok(seen.size >= 3, `varied: ${[...seen].join(' ')}`);
  assert.ok(bedroom > 0 && pocket > 0, `both doors used: bedroom ${bedroom}, hallway pocket ${pocket}`);
});

test('findSpawn: recent spawns are avoided; impossible distances fail; same seed, same sequence', () => {
  const a = new WorldCore(), b = new WorldCore();
  a.build(house(), { x: 0, z: 0 });
  b.build(house(), { x: 0, z: 0 });
  const o1 = { x: 0, z: 0 }, o2 = { x: 0, z: 0 };
  assert.ok(a.findSpawn(0, 0, 0, -1, 3, o1));
  if (a.findSpawn(0, 0, 0, -1, 3, o2)) assert.ok(Math.hypot(o1.x - o2.x, o1.z - o2.z) >= 1.0, 'not on top of the last one');
  assert.equal(a.findSpawn(0, 0, 0, -1, 30, o1), false);
  assert.equal(a.spawner.lastTier, 0);
  a.build(house(), { x: 0, z: 0 }); // a rebuild restarts the seeded sequence
  const sa = [], sb = [];
  for (let k = 0; k < 5; k++) {
    a.update(0, 100000 + k * 20000); b.update(0, 100000 + k * 20000);
    a.findSpawn(0, 0, 1, -1, 3, o1); b.findSpawn(0, 0, 1, -1, 3, o2);
    sa.push(o1.x, o1.z); sb.push(o2.x, o2.z);
  }
  assert.deepEqual(sa, sb);
});

test('findSpawn and raycast do not allocate (sampling heap profiler, world code only)', async () => {
  const w = world();
  const h = hit(), out = { x: 0, z: 0 };
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      const a = (i % 64) * 0.098;
      w.raycast(0, 1.5, 0, Math.cos(a), -0.2, Math.sin(a), 20, h);
      w.segmentClear(0, 1.6, 0, 4 + (i % 7) * 0.2, 1.2, -2);
      w.floorY(a, -a);
      if ((i & 63) === 0) { w.update(0, i * 1000); w.findSpawn(0, 0, Math.cos(a), Math.sin(a), 3, out); }
    }
  };
  run(100000); // past JIT tiering (interpreted and baseline code box doubles)
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 128 });
  run(50000);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const sites = [];
  const walk = (node) => {
    if (node.selfSize && node.callFrame.url.includes('/src/world/')) { bytes += node.selfSize; sites.push(`${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`); }
    for (const c of node.children) walk(c);
  };
  walk(profile.head);
  assert.ok(bytes < 4096, `world code allocated ~${bytes} bytes in 50,000 rounds at ${sites.join(', ')}`);
});

test('occluder: every wall piece and box, door openings left open, boxes shrunk 2 cm, faces outward', () => {
  const w = world();
  const boxes = w.layout.boxes;
  const pos = new Float32Array(256 * 24), idx = new Uint16Array(256 * 36);
  const n = writeOccluderBoxes(boxes, pos, idx, 256);
  assert.equal(n, boxes.length);
  assert.ok(n * 12 <= 2400, 'triangle budget');
  const vx = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  /** Is a point inside occluder box k (convex: inside all 6 face planes)? */
  const inside = (k, p) => {
    for (let t = 0; t < 12; t++) {
      const [a, b, c] = [0, 1, 2].map((j) => vx(idx[k * 36 + t * 3 + j]));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if ((p[0] - a[0]) * nrm[0] + (p[1] - a[1]) * nrm[1] + (p[2] - a[2]) * nrm[2] > 0) return false;
    }
    return true;
  };
  const anyInside = (p) => { for (let k = 0; k < n; k++) if (inside(k, p)) return true; return false; };
  // Outward faces: each box's centre is behind all of its faces.
  for (let k = 0; k < n; k++) {
    const c = [0, 0, 0];
    for (let i = 0; i < 8; i++) { const p = vx(k * 8 + i); c[0] += p[0] / 8; c[1] += p[1] / 8; c[2] += p[2] / 8; }
    assert.ok(inside(k, c), `box ${k} faces outward`);
  }
  assert.ok(!anyInside([-1.15, 1.0, -3.05]), 'hallway door opening is open');
  assert.ok(!anyInside([3.05, 1.0, -2.175]), 'bedroom door opening is open');
  assert.ok(anyInside([-1.15, 2.2, -3.05]), 'lintel');
  assert.ok(anyInside([0, 1.0, -3.05]), 'wall slab');
  assert.ok(!anyInside([0, 1.0, -3.01]), 'wall face moved 2 cm back');
  assert.ok(!anyInside([-0.69, 1.0, -3.05]), 'jamb pulled 2 cm back from the opening');
  assert.ok(anyInside([-1.5, 0.8, -1.5]), 'couch');
  assert.ok(!anyInside([-1.5, 0.84, -1.5]), 'couch top shrunk 2 cm');
  assert.ok(!anyInside([-1.06, 0.5, -1.5]), 'couch side shrunk 2 cm');
  assert.equal(OCC_INDICES_PER_BOX, 36);
});

test('no snapshot, no floor, or a bad snapshot → a virtual open room around the player', () => {
  for (const snap of [null, { version: 1, space: 'local-floor', planes: [], meshes: [] }, { version: 9 }]) {
    const w = new WorldCore();
    w.build(snap, { x: 1, z: 2 });
    assert.equal(w.virtual, true);
    assert.match(w.describe(), /virtual/);
    assert.equal(w.floorY(1, 2), 0);
    const h = hit();
    assert.ok(w.raycast(1, 1.5, 2, 0.3, -1, 0, 5, h) && h.surface === 'floor' && near(h.y, 0));
    assert.equal(w.raycast(1, 1.5, 2, 1, 0, 0, 50, hit()), false, 'no walls');
    assert.equal(w.raycast(1, 1.5, 2, 0, 1, 0, 50, hit()), false, 'open above');
    assert.ok(w.nav.isWalkable(5, 2) && !w.nav.isWalkable(2, 2));
    const out = { x: 0, z: 0 };
    assert.ok(w.findSpawn(1, 2, 0, -1, 4, out));
    assert.equal(w.spawner.lastTier, 1, 'nothing hides: out of view');
    const dx = out.x - 1, dz = out.z - 2, d = Math.hypot(dx, dz);
    assert.ok(d >= 4);
    assert.ok(-dz / d <= Math.cos((100 * Math.PI) / 180) + 1e-6, 'outside ±100° of the view');
  }
  const w = new WorldCore();
  w.build({ version: 9 }, { x: 0, z: 0 });
  assert.ok(w.stats.notes.some((s) => /rejected/.test(s)));
  // Walls but no floor.
  const b = new SnapshotBuilder().wall(0, 0, 4, 0, 0, 2.5);
  w.build(b.build(), { x: 0, z: 0 });
  assert.equal(w.virtual, true);
});

test('player outside every mapped floor → a virtual patch joins them to the house', () => {
  const w = new WorldCore();
  w.build(house(), { x: -1.15, z: -6 }); // in the unmapped hallway, 3 m beyond its door
  assert.equal(w.virtual, false);
  assert.equal(w.partialVirtual, true);
  assert.ok(w.nav.isReachable(-1.15, -3.6) || w.nav.isReachable(0, -4.5));
  assert.ok(w.nav.isReachable(2.6, -2.6), 'the living room connects through the hallway door');
  assert.match(w.describe(), /virtual floor/);
});

test('labels may be null: floor, walls and objects are classified by shape', () => {
  const b = new SnapshotBuilder();
  const room = [[0, 0], [4, 0], [4, 5], [0, 5]];
  b.floor(room, 0.01, null).ceiling(room, 2.45, null);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = room[i], [bx, bz] = room[(i + 1) % 4];
    b.wall(ax, az, bx, bz, 0.01, 2.45, { label: null, flip: i % 2 === 1 }); // half the normals point outward
  }
  b.top(null, 2, 4, 0.5, 0.3, 0.72); // an unlabelled desk top
  b.box(null, 3.3, 1, 0.3, 0.3, 0.01, 1.2); // an unlabelled cabinet volume
  const w = new WorldCore();
  w.build(b.build(), { x: 1, z: 1 });
  assert.equal(w.stats.floors, 1);
  assert.equal(w.stats.walls, 4);
  assert.equal(w.stats.furniture, 2);
  assert.ok(w.layout.furniture.every((f) => f.label === 'other'));
  assert.ok(near(w.ceilingY(2, 2), 2.45));
  // Wrong-way normals are fixed from the floor: every wall's slab lies outside the room.
  const h = hit();
  for (const [dx, dz, wx, wz] of [[1, 0, 4, null], [-1, 0, 0, null], [0, 1, null, 5], [0, -1, null, 0]]) {
    assert.ok(w.raycast(2, 1.5, 2.5, dx, 0, dz, 10, h));
    if (wx !== null) assert.ok(near(h.x, wx), `x ${h.x}`);
    if (wz !== null) assert.ok(near(h.z, wz), `z ${h.z}`);
    assert.ok(near(h.nx, -dx) && near(h.nz, -dz));
  }
});

test('a rotated house: walls, a door and a z-up mesh at 30° yaw', () => {
  const b = new SnapshotBuilder({ yaw: Math.PI / 6, ox: 1.5, oz: -0.5 });
  b.floor([[0, 0], [5, 0], [5, 4], [0, 4]], 0).floor([[5.12, 0], [8, 0], [8, 4], [5.12, 4]], 0.02);
  b.wall(0, 0, 5, 0, 0, 2.5).wall(5, 0, 5, 4, 0, 2.5).wall(5, 4, 0, 4, 0, 2.5).wall(0, 4, 0, 0, 0, 2.5);
  b.wall(8, 4, 5.12, 4, 0.02, 2.5).wall(5.12, 4, 5.12, 0, 0.02, 2.5, { flip: true }).wall(5.12, 0, 8, 0, 0.02, 2.5).wall(8, 0, 8, 4, 0.02, 2.5);
  b.door(5, 1.5, 5, 2.4, 0, 2.03, { offset: -0.02 }); // 0.9 m, 2 cm in front of the wall, inside the room
  b.box('shelf', 2, 3.5, 0.6, 0.2, 0, 1.8, { yaw: 0.2, zUp: true });
  const w = new WorldCore();
  const [px, pz] = b.toWorld(1.5, 1.5);
  w.build(b.build(), { x: px, z: pz });
  assert.equal(w.stats.doors, 1);
  assert.equal(w.layout.doors[0].walls, 2, 'cut into both slabs of the shared wall');
  assert.equal(w.stats.furniture, 1);
  const sh = w.layout.furniture[0];
  assert.ok(near(sh.y1, 1.8) && near(sh.hx, 0.6) && near(sh.hz, 0.2));
  // Through the door into room 2, along the house +x axis.
  const [dx, dz] = b.dirToWorld(1, 0);
  const [ox, oz] = b.toWorld(1, 1.95);
  const h = hit();
  assert.ok(w.raycast(ox, 1.2, oz, dx, 0, dz, 20, h));
  assert.ok(near(h.dist, 7), `through the door to the far wall: ${h.dist}`);
  assert.ok(near(h.nx, -dx) && near(h.nz, -dz));
  const [qx, qz] = b.toWorld(1, 0.8);
  assert.ok(w.raycast(qx, 1.2, qz, dx, 0, dz, 20, h) && near(h.dist, 4), 'beside the door: the wall');
  const [rx, rz] = b.toWorld(7, 2);
  assert.ok(w.nav.isReachable(rx, rz));
  assert.equal(w.nav.doors[w.nav.index(rx, rz)], 1);
});

test('interior walls the player sees are faced to the player, whatever the normal convention', () => {
  // One floor polygon over two rooms; every wall normal points OUT of its room (the opposite of the builder default).
  const make = (outward) => {
    const b = new SnapshotBuilder();
    const f = [[0, 0], [8, 0], [8, 4], [0, 4]];
    b.floor(f, 0);
    for (let i = 0; i < 4; i++) b.wall(f[i][0], f[i][1], f[(i + 1) % 4][0], f[(i + 1) % 4][1], 0, 2.5, { flip: outward });
    // Room A's east wall face at x = 4 (room A is x < 4): a→b upward has its left normal along −x (into A).
    b.wall(4, 0, 4, 4, 0, 2.5, { flip: outward });
    const w = new WorldCore();
    w.build(b.build(), { x: 1, z: 2 });
    return w;
  };
  for (const outward of [false, true]) {
    const w = make(outward);
    const inner = w.layout.walls[4];
    assert.equal(inner.side, 'player', 'the player in room A sees it: faced to the player');
    const h = hit();
    assert.ok(w.raycast(2, 1.5, 2, 1, 0, 0, 10, h) && near(h.x, 4.0), `from room A the face is at x = 4 (${h.x})`);
    assert.ok(w.raycast(6, 1.5, 2, -1, 0, 0, 10, h) && near(h.x, 4.1), `the slab is behind it (${h.x})`);
    assert.ok(w.layout.walls.slice(0, 4).every((x) => x.side === 'edge' && x.flipped === outward));
  }
});
