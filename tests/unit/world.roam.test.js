/**
 * Roam (whole-house play, the v0.3 default): the world build without a player
 * zone, centred interior slabs, the never-cropped grid, rooms, the door graph,
 * door distance fields, the edge margin, the sliced bake, the roam spawn
 * search, the skipped "spot" rebuild, and the realign rebuild.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorldCore, NAV_CAPACITY } from '../../src/world/WorldCore.js';
import { NAV_WALK, NAV_ZONE } from '../../src/world/NavGrid.js';
import { WALL_T } from '../../src/world/Layout.js';
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';
import { roomAt, toHouse, userHouse, largeHouse, largeRooms } from './world.houses.js';
import { cpuNow, Timer } from './cpuclock.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

/** The userHouse() built in Roam with the player in room C, baked. */
function roamUser() {
  const b = userHouse();
  const w = new WorldCore({ roam: true });
  const [px, pz] = b.toWorld(6.0, 2.8);
  w.build(b.build(), { x: px, z: pz });
  w.finishBake();
  return { b, w, px, pz };
}

const CENTRES = { A: [2, 2.5], B: [3, 7.5], C: [5.5, 4.5], D: [6, 7.5], E: [10.5, 1.5], F: [10, 6.5], G: [13.5, 1.5], closet: [2, 9.25] };

test('Roam build: no player zone, r = 0, 8 rooms (closet sealed: no doors), door graph matches the plan', () => {
  const { b, w } = roamUser();
  assert.equal(w.roamOn, true);
  assert.equal(w.zone.r, 0);
  const g = w.nav;
  let zoneCells = 0;
  for (let i = 0; i < g.count; i++) if (g.flags[i] & NAV_ZONE) zoneCells++;
  assert.equal(zoneCells, 0, 'no NAV_ZONE cell anywhere');
  const R = w.roamIndex;
  assert.equal(R.roomCount, 8);
  /** @type {Record<string, number>} */ const id = {};
  for (const [n, [x, z]] of Object.entries(CENTRES)) id[n] = w.roomAt(...b.toWorld(x, z));
  assert.equal(new Set(Object.values(id)).size, 8, `distinct rooms ${JSON.stringify(id)}`);
  assert.ok(Object.values(id).every((r) => r > 0));
  const closet = id.closet;
  assert.equal(R.roomDoorStart[closet + 1] - R.roomDoorStart[closet], 0, 'the closet has no door');
  // doors (house plan): 0 A–C, 1 D–F, 2 A–B, 3 C–D, 4 E–F, 5 E–G
  const want = [['A', 'C'], ['D', 'F'], ['A', 'B'], ['C', 'D'], ['E', 'F'], ['E', 'G']];
  for (let k = 0; k < 6; k++) {
    const got = [R.doorRoomA[k], R.doorRoomB[k]].sort();
    const exp = want[k].map((n) => id[n]).sort();
    assert.deepEqual(got, exp, `door ${k}`);
    assert.equal(R.doorExterior[k], 0, `door ${k} is inside the house`);
    assert.ok(R.doorField[k] >= 0, `door ${k} has a field`);
  }
  assert.equal(R.fieldsReady, true);
  assert.equal(R.edgeReady, true);
  const rep = w.report();
  assert.equal(rep.mode, 'roam');
  assert.equal(rep.roam.rooms, 8);
  assert.equal(rep.roam.doorFields, 6);
  assert.doesNotThrow(() => JSON.stringify(rep));
});

test('interior wall slabs are centred on their plane (±WALL_T/2), edge walls stay behind the face', () => {
  const { w } = roamUser();
  const L = w.layout;
  const centred = L.walls.filter((x) => x.centred);
  assert.equal(centred.length, 7, 'the 7 interior wall planes');
  for (const b of L.boxes) {
    if (b.kind !== 'wall') continue;
    const wall = L.walls[b.wall];
    const d = (b.cx - wall.ax) * wall.nx + (b.cz - wall.az) * wall.nz; // box centre along n from the face line
    if (wall.centred) {
      assert.ok(Math.abs(d) < 1e-6, `centred slab centre on the plane (${d})`);
      assert.equal(b.face, 0);
    } else assert.ok(Math.abs(d + WALL_T / 2) < 1e-6, `edge slab behind the face (${d})`);
    assert.ok(Math.abs(b.hz - WALL_T / 2) < 1e-9);
  }
  // either side of an interior wall the face is ≤ 5 cm from the real surface: raycast from both sides
  const hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
  const b = userHouse();
  for (const [hx, dir] of [[3.0, 1], [5.0, -1]]) { // the x = 4 wall from room A and from room C
    const [ox, oz] = b.toWorld(hx, 3.5), [dx, dz] = b.dirToWorld(dir, 0);
    assert.ok(w.raycast(ox, 1.2, oz, dx, 0, dz, 5, hit));
    assert.ok(Math.abs(hit.dist - 1.0) <= WALL_T / 2 + 1e-6, `face ${hit.dist.toFixed(3)} m vs the real 1.0 m`);
  }
});

test('door-field path estimate: never shorter than the true path, mean over-estimate < 0.15 m', () => {
  const { b, w } = roamUser();
  const R = w.roamIndex, g = w.nav;
  let n = 0, sum = 0, worst = 0;
  for (const [name, [x, z]] of Object.entries(CENTRES)) {
    if (name === 'closet') continue;
    const [hx, hz] = b.toWorld(x, z);
    R.trackPlayer(hx, hz);
    assert.ok(R.pAnchor >= 0, `${name}: anchor`);
    g.pathField(hx, hz); // the exact field from the same start (overwrites the build-start fallback)
    for (let i = 0; i < g.count; i++) {
      if (!(g.flags[i] & NAV_WALK) || g.room[i] === 0 || R.isPlayerRoom(g.room[i])) continue;
      const ex = g.pathDist[i];
      if (ex === Infinity) continue;
      const est = R.pathFromPlayerCell(i);
      assert.ok(est >= ex - 1e-4, `${name}: estimate ${est} under the true ${ex}`);
      n++;
      sum += est - ex;
      worst = Math.max(worst, est - ex);
    }
  }
  assert.ok(n > 10000, `${n} cells compared`);
  assert.ok(sum / n < 0.15, `mean over-estimate ${(sum / n).toFixed(3)} m (worst ${worst.toFixed(2)})`);
});

test('pathDistance follows the player in Roam (hearing, spawns): through doors, straight in the own room', () => {
  const { b, w } = roamUser();
  const [ax, az] = b.toWorld(2, 2.5), [cx, cz] = b.toWorld(6.0, 5.2);
  w.update(0, 0, null, { player: { head: { x: ax, z: az } } });
  const own = w.nav.pathDistance(...b.toWorld(3, 1));
  assert.ok(Math.abs(own - Math.hypot(1, 1.5)) < 0.1, `own room: straight line to the cell centre (${own})`);
  const toC = w.nav.pathDistance(cx, cz);
  w.update(0, 16, null, { player: { head: { x: cx, z: cz } } });
  const back = w.nav.pathDistance(ax, az);
  assert.ok(toC > Math.hypot(3.5, 2) && toC < 8, `A → C through the door (${toC})`);
  assert.ok(Math.abs(toC - back) < 0.3, `symmetric enough (${toC} / ${back})`);
  assert.equal(w.nav.pathDistance(...b.toWorld(2, 9.25)), Infinity, 'the sealed closet');
});

test('roam spawns from every room centre: never in the player room, ≥ 3.5 m, 5–30 m of path, hidden, no fails', () => {
  const { b, w } = roamUser();
  const out = { x: 0, z: 0 };
  let t = 0;
  for (const [name, [x, z]] of Object.entries(CENTRES)) {
    if (name === 'closet') continue;
    const [hx, hz] = b.toWorld(x, z);
    for (let k = 0; k < 8; k++) {
      t += 11000;
      w.update(0, t, null, { player: { head: { x: hx, z: hz } } });
      let r = 2, frames = 0;
      while (r === 2 && frames++ < 20) r = w.spawnRoam(hx, hz, 0, 0, 1, 0, out);
      assert.equal(r, 1, `${name} #${k}: found`);
      const sr = roomAt(...toHouse(b, out.x, out.z));
      assert.notEqual(sr, name, `${name}: not in the player's room`);
      assert.notEqual(sr, 'closet');
      assert.ok(Math.hypot(out.x - hx, out.z - hz) >= 3.5);
      const p = w.pathFromPlayer(out.x, out.z);
      assert.ok(p >= 5 && p <= 30, `${name}: path ${p}`);
      assert.ok(!w.spawner.visible(w, w.floorY(hx, hz) + 1.6, hx, hz, out.x, out.z, Math.hypot(out.x - hx, out.z - hz)), 'hidden');
      assert.equal(w.spawner.lastTier, 3);
    }
  }
  const rep = w.report().spawn;
  assert.equal(rep.roam, true);
  assert.ok(rep.recent.every((e) => e.room > 0 && e.playerRoom > 0 && e.room !== e.playerRoom));
});

test('a walking player: never within 3.5 m of where the head will be in 1 s; a door gap counts as both rooms', () => {
  const { b, w } = roamUser();
  const out = { x: 0, z: 0 };
  // standing in the A–C door gap (x = 4, z 2–2.9): neither A nor C
  const [dx, dz] = b.toWorld(4.0, 2.45);
  w.update(0, 1000, null, { player: { head: { x: dx, z: dz } } });
  const R = w.roamIndex;
  assert.ok(R.pDoor === 0, 'in door 0');
  for (let k = 0; k < 10; k++) {
    w.update(0, 12000 * (k + 1), null, null);
    let r = 2;
    while (r === 2) r = w.spawnRoam(dx, dz, 0, 0, 1, 0, out);
    assert.equal(r, 1);
    const sr = roomAt(...toHouse(b, out.x, out.z));
    assert.ok(sr !== 'A' && sr !== 'C', `door gap: spawned in ${sr}`);
  }
  // walking from C toward D at 1.4 m/s: the predicted head (1 s ahead) is kept 3.5 m clear too
  const [hx, hz] = b.toWorld(5.5, 4.5), [vx, vz] = b.dirToWorld(0, 1.4);
  for (let k = 0; k < 10; k++) {
    w.update(0, 200000 + 12000 * k, null, { player: { head: { x: hx, z: hz } } });
    let r = 2;
    while (r === 2) r = w.spawnRoam(hx, hz, vx, vz, 0, 1, out);
    if (r !== 1) continue;
    assert.ok(Math.hypot(out.x - (hx + vx), out.z - (hz + vz)) >= 3.5);
  }
});

test('edge margin: real walls are not an edge; an inferred wall and an unmapped doorway are; negative off the map', () => {
  // the fixture house: fully walled except the hallway door (unmapped beyond: a pocket)
  const w = new WorldCore({ roam: true });
  w.build(house(), { x: 0, z: 0 });
  assert.equal(w.edgeMargin(0, 0), 99, 'unknown until baked');
  w.finishBake();
  assert.ok(w.edgeMargin(0, 0) > 3, `middle of the living room (${w.edgeMargin(0, 0)})`);
  assert.ok(w.edgeMargin(2.8, 0.8) > 3, 'a corner between two real walls is far from any edge');
  const atDoor = w.edgeMargin(-1.15, -3.0);
  assert.ok(atDoor > 0.2 && atDoor < 0.45, `the hallway door plane (${atDoor})`);
  assert.ok(w.edgeMargin(-1.15, -3.8) < -0.2, 'inside the pocket beyond it: off the map');
  const R = w.roamIndex;
  assert.equal(R.doorExterior[2], 1, 'the hallway door leads out of the mapped house');
  // a room without a wall plane on its x = 5 side: an inferred wall, an open edge
  const sb = new SnapshotBuilder();
  const pts = [[0, 0], [5, 0], [5, 4], [0, 4]];
  sb.floor(pts, 0).ceiling(pts, 2.5);
  sb.wall(0, 0, 5, 0, 0, 2.5, { extend: 0.05 }).wall(5, 4, 0, 4, 0, 2.5, { extend: 0.05 }).wall(0, 4, 0, 0, 0, 2.5, { extend: 0.05 });
  const w2 = new WorldCore({ roam: true });
  w2.build(sb.build(), { x: 2, z: 2 });
  w2.finishBake();
  assert.ok(Math.abs(w2.edgeMargin(2.5, 2) - 2.5) < 0.1, `2.5 m from the open side (${w2.edgeMargin(2.5, 2)})`);
  assert.ok(Math.abs(w2.edgeMargin(4.5, 2) - 0.5) < 0.1);
  assert.ok(w2.edgeMargin(0.15, 2) > 4.5, 'next to the real wall opposite');
  assert.ok(w2.edgeMargin(5.3, 2) < -0.2, 'beyond the open side');
  // a virtual room (no Space Setup): no edge at all
  const w3 = new WorldCore({ roam: true });
  w3.build(null, { x: 0, z: 0 });
  w3.finishBake();
  assert.equal(w3.edgeMargin(0, 0), 99);
  assert.equal(w3.edgeMargin(5, 5), 99);
});

test('sliced bake: world.update runs it within the budget; spawns wait for the door fields', () => {
  const b = largeHouse();
  const w = new WorldCore({ roam: true, bakeBudgetMs: 1 });
  w.warmUp();
  const [px, pz] = b.toWorld(12, 5);
  w.build(b.build(), { x: px, z: pz });
  assert.equal(w.bakeDone, false);
  const out = { x: 0, z: 0 };
  assert.equal(w.spawnRoam(px, pz, 0, 0, 1, 0, out), 2, 'pending while the fields bake');
  // the bake keeps its wall-clock deadline; the bounds count only time on the CPU (tests/unit/cpuclock.js)
  let frames = 0;
  const slice = new Timer(), c0 = cpuNow();
  while (!w.bakeDone && frames < 5000) { slice.start(); w.update(1 / 72, frames * 14, null, null); slice.stop(); frames++; }
  const cpuMs = cpuNow() - c0;
  assert.ok(w.bakeDone, 'done');
  assert.ok(frames > 2, `in slices (${frames})`);
  const R = w.roamIndex, mean = cpuMs / R.bakeSlices;
  assert.ok(mean < 2, `mean slice ${mean.toFixed(2)} ms on the CPU (budget 1 ms; wall ${(R.bakeMs / R.bakeSlices).toFixed(2)} ms)`);
  assert.ok(slice.worst < 30, `slices: ${slice} (wall incl. switched out ${R.maxSliceMs.toFixed(2)} ms; the first big build still JIT-compiles)`);
  assert.equal(w.roamIndex.fieldSlots, 30);
});

test('capacity: a house larger than 1,310 m² gets coarser cells, never a crop; 21 rooms, 30 doors in the large house', () => {
  const big = new SnapshotBuilder();
  const pts = [[0, 0], [42, 0], [42, 40], [0, 40]];
  big.floor(pts, 0).ceiling(pts, 2.5);
  for (let i = 0; i < 4; i++) big.wall(pts[i][0], pts[i][1], pts[(i + 1) % 4][0], pts[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
  const w = new WorldCore({ roam: true });
  w.build(big.build(), { x: 20, z: 20 });
  assert.equal(w.nav.capacity, NAV_CAPACITY);
  assert.ok(w.nav.cell > 0.1 && w.nav.cell <= 0.25, `cell ${w.nav.cell}`);
  assert.ok(!w.stats.notes.some((n) => /cropped/.test(n)), 'never cropped');
  assert.ok(w.nav.isWalkable(1, 1) && w.nav.isWalkable(41, 39), 'both far corners are on the grid');
  const L = largeHouse();
  const w2 = new WorldCore({ roam: true });
  w2.build(L.build(), { x: L.toWorld(12, 5)[0], z: L.toWorld(12, 5)[1] });
  w2.finishBake();
  assert.equal(w2.nav.cell, 0.1);
  assert.equal(w2.stats.doors, 30);
  assert.equal(w2.stats.passableDoors, 30);
  assert.equal(w2.roamIndex.roomCount, 21);
  const R = largeRooms();
  for (const [name, [x0, z0, x1, z1]] of Object.entries(R)) {
    assert.ok(w2.roomAt(...L.toWorld((x0 + x1) / 2, (z0 + z1) / 2)) > 0, `${name} has a room id`);
  }
});

test('Roam rebuild for a moved start is skipped (same snapshot and doors); a door change or spot mode rebuilds', () => {
  const b = userHouse();
  const snap = b.build();
  const w = new WorldCore({ roam: true });
  const [ax, az] = b.toWorld(6, 2.8), [bx, bz] = b.toWorld(2, 2.5);
  assert.equal(w.build(snap, { x: ax, z: az }), true);
  const v = w.nav.version;
  assert.equal(w.build(snap, { x: bx, z: bz }, { doors: w.doorOpen.slice() }), false, 'skipped');
  assert.equal(w.nav.version, v);
  assert.equal(w.start.x, bx);
  assert.equal(w.stats.skippedBuilds, 1);
  assert.equal(w.build(snap, { x: bx, z: bz }, { doors: [false] }), true, 'door 0 closed: rebuilt');
  assert.equal(w.layout.doors[0].open, false);
  assert.equal(w.build(snap, { x: bx, z: bz }, { roam: false }), true, 'spot build');
  assert.equal(w.roamOn, false);
  assert.equal(w.roamIndex.built, false);
  assert.equal(w.edgeMargin(bx, bz), 99);
  assert.equal(w.zone.r, 0.8);
});

test('warmUp runs the Roam paths and leaves the world unbuilt', () => {
  const w = new WorldCore({ roam: true });
  w.warmUp();
  assert.equal(w.built, false);
  const { b } = roamUser();
  w.build(b.build(), { x: 0, z: 0 });
  assert.equal(w.roamOn, true);
});
