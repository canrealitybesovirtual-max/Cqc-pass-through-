/**
 * World follow-ups (gap audit F6, F7 data side, F8; risks "Space Setup
 * multi-room data" and "Door carving"):
 * - spawn fallback only beyond ±100° of the view; never on virtual floor unless
 *   the whole room is virtual; the tier of every spawn is recorded;
 * - per-door records and an open/closed flag (closed = not carved, solid);
 * - inferred walls on floor edges with no wall plane; spawn pockets behind
 *   doors into unmapped space;
 * - World.report() for the session record;
 * - interior walls inside one large floor polygon: the slab never sits in
 *   front of a surface the player sees;
 * - the synthetic version of the user's layout (2 floors 111 m² + 14.4 m²,
 *   16 walls, 6 doors, tables, beds, couches, shelves).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { ShapeSet } from '../../src/world/Shapes.js';
import { WorldCore, DOOR_CLEARANCE } from '../../src/world/WorldCore.js';
import { NAV_DOOR, NAV_INSIDE, NAV_POCKET, NAV_VIRTUAL, NAV_WALK } from '../../src/world/NavGrid.js';
import { PATH_PENDING } from '../../src/world/PathPlanner.js';
import { EDGE_VERTS_PER_BOX, OVERLAY_COLOR, writeOccluderBoxes, writeOverlayEdges } from '../../src/world/Occluder.js';
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';
import { WALL_T } from '../../src/world/Layout.js';
import { DOORS, ROOMS, roomAt, toHouse, userHouse } from './world.houses.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const hit = () => ({ dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' });
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const COS100 = Math.cos((100 * Math.PI) / 180);

/** Is a point inside any occluder box (convex test on the written triangles)? */
function occluderContains(boxes, p) {
  const pos = new Float32Array(256 * 24), idx = new Uint16Array(256 * 36);
  const n = writeOccluderBoxes(boxes, pos, idx, 256);
  const vx = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  for (let k = 0; k < n; k++) {
    let inside = true;
    for (let t = 0; t < 12 && inside; t++) {
      const [a, b, c] = [0, 1, 2].map((j) => vx(idx[k * 36 + t * 3 + j]));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if ((p[0] - a[0]) * nrm[0] + (p[1] - a[1]) * nrm[1] + (p[2] - a[2]) * nrm[2] > 0) inside = false;
    }
    if (inside) return true;
  }
  return false;
}

/** A* between two points; returns the path as [x, z] pairs or null. */
function path(w, ax, az, bx, bz) {
  const p = w.createPlanner();
  p.request(0, ax, az, bx, bz);
  const out = new Float32Array(256);
  let n;
  while ((n = p.result(0, out)) === PATH_PENDING) p.step(2000);
  if (n < 2) return null;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([out[2 * i], out[2 * i + 1]]);
  return pts;
}

// ---------------------------------------------------------------- spawns (F6)

test('spawn fallback: only beyond ±100° of the view; every find is counted by tier and logged', () => {
  const w = new WorldCore();
  w.build(null, { x: 1, z: 2 }); // virtual open room: nothing hides, so every spawn is the fallback tier
  const out = { x: 0, z: 0 };
  let ok = 0;
  for (let k = 0; k < 30; k++) {
    w.update(0, k * 12000);
    const a = k * 0.7, vx = Math.cos(a), vz = Math.sin(a);
    if (!w.findSpawn(1, 2, vx, vz, 3.5, out)) continue;
    ok++;
    assert.equal(w.spawner.lastTier, 1);
    const dx = out.x - 1, dz = out.z - 2, d = Math.hypot(dx, dz);
    assert.ok((dx * vx + dz * vz) / d <= COS100 + 1e-6, `spawn ${k} at ${Math.round((Math.acos((dx * vx + dz * vz) / d) * 180) / Math.PI)}° from the view`);
  }
  assert.ok(ok >= 25, `${ok} of 30 found`);
  const s = w.report().spawn;
  assert.equal(s.finds.tier1, ok);
  assert.equal(s.finds.none, 30 - ok);
  assert.equal(s.recent.length, 16, 'the last 16 spawns');
  assert.ok(s.recent.every((r) => r.tier === 1));
  assert.ok(s.virtualFallback === false, 'the whole room is virtual: allowed, not a fallback');
  // No view direction: a visible spawn is never allowed.
  const w2 = new WorldCore();
  w2.build(null, { x: 0, z: 0 });
  assert.equal(w2.findSpawn(0, 0, 0, 0, 3, out), false);
  assert.equal(w2.report().spawn.finds.none, 1);
});

test('virtual floor (the patch around a player off the map) is never a spawn point when mapped floor qualifies', () => {
  const w = new WorldCore();
  w.build(house(), { x: -1.15, z: -6 }); // in the unmapped hallway: an 8 m virtual patch around the player
  assert.equal(w.partialVirtual, true);
  const g = w.nav;
  // The patch overlaps the living room: those cells stay mapped (not virtual).
  assert.ok((g.flags[g.index(0, -2)] & NAV_VIRTUAL) === 0, 'living room cell under the patch is mapped');
  assert.ok(g.flags[g.index(-1.15, -4.5)] & NAV_VIRTUAL);
  assert.ok(w.spawner.count > 0);
  for (let c = 0; c < w.spawner.count; c++) {
    const i = g.index(w.spawner.x[c], w.spawner.z[c]);
    assert.equal(g.flags[i] & NAV_VIRTUAL, 0, `candidate ${c} on virtual floor`);
  }
  assert.equal(w.spawner.virtualFallback, false);
  assert.ok(w.spawner.skippedVirtual > 0);
  const out = { x: 0, z: 0 };
  for (let k = 0; k < 10; k++) {
    w.update(0, k * 12000);
    if (w.findSpawn(-1.15, -6, 0, -1, 3.5, out)) assert.equal(g.flags[g.index(out.x, out.z)] & NAV_VIRTUAL, 0);
  }
});

test('no mapped spawn point at all → virtual floor is used, and the report says so', () => {
  // A 1.6 × 1.6 m mapped floor (a closet) and the player 3 m outside it.
  const b = new SnapshotBuilder();
  const f = [[0, 0], [1.6, 0], [1.6, 1.6], [0, 1.6]];
  b.floor(f, 0);
  const w = new WorldCore();
  w.build(b.build(), { x: 4.6, z: 0.8 });
  assert.equal(w.partialVirtual, true);
  assert.equal(w.spawner.virtualFallback, true);
  assert.ok(w.spawner.count > 0);
  assert.ok(w.report().spawn.virtualFallback);
  assert.ok(w.stats.notes.some((n) => /virtual floor used/.test(n)));
});

// ---------------------------------------------------------------- doors (F7 data side)

test('door records: matched walls, offsets, width, bottom, walkable, side, where it leads', () => {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 });
  const [d0, d1, d2] = w.layout.doors;
  assert.deepEqual([d0.id, d1.id, d2.id], [0, 1, 2]);
  assert.equal(d0.wallIds.length, 2, 'the bedroom door cuts both slabs of the shared wall');
  assert.ok(d0.offsets.some((o) => near(o, 0, 0.02)) && d0.offsets.some((o) => near(o, -0.11, 0.02)), `${d0.offsets}`);
  assert.ok(near(d0.width, 0.85, 0.01));
  for (const d of [d0, d1, d2]) {
    assert.equal(d.open, true, 'every door open by default');
    assert.equal(d.walkable, true);
    assert.equal(d.passable, true, `door ${d.id} passable`);
    assert.equal(d.inZone, false);
  }
  assert.equal(d0.leadsTo, 'mapped');
  assert.equal(d0.side, 'both');
  assert.equal(d2.leadsTo, 'unmapped', 'the hallway is not mapped');
  assert.equal(d2.side, 'front', 'mapped floor in front of the plane (the living room)');
  assert.ok(d2.pocket >= 0);
  const r = w.report();
  assert.deepEqual(r.doors[2], {
    id: 2, c: [r.doors[2].c[0], r.doors[2].c[1]], width: 0.9, bottom: 0, y: [0, 2.03], walls: [0], offsets: [0.01],
    walkable: true, passable: true, inZone: false, open: true, side: 'front', leadsTo: 'unmapped', pocket: true, curtain: true,
  });
  assert.equal(r.doors[0].curtain, false, 'the bedroom door joins two scanned rooms: no curtain');
  assert.deepEqual(r.hidden, { rooms: 0, curtains: 1, pocketCells: 0 });
  assert.equal(w.stats.passableDoors, 3);
});

test('a closed door is not carved: the wall stays solid for bullets, sight, the occluder and the nav grid', () => {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 }, { doors: [true, true, false] }); // the hallway door closed
  const L = w.layout;
  assert.equal(L.doors[2].open, false);
  assert.equal(L.doors[2].pocket, -1, 'no pocket behind a closed door');
  assert.equal(L.doors[2].passable, false);
  assert.equal(L.walls[0].openings.length, 0, 'north wall uncut');
  assert.equal(w.stats.closedDoors, 1);
  assert.equal(w.stats.pockets, 0);
  const h = hit();
  assert.ok(w.raycast(-1.15, 1.0, 0, 0, 0, -1, 20, h) && near(h.z, -3) && h.surface === 'wall', 'the shot stops at the closed door');
  assert.equal(w.segmentClear(-1.15, 1.5, -2.5, -1.15, 1.5, -4), false);
  assert.ok(occluderContains(L.boxes, [-1.15, 1.0, -3.05]), 'the occluder is solid across the door');
  assert.equal(w.nav.flags[w.nav.index(-1.15, -3.05)] & NAV_DOOR, 0, 'not carved');
  assert.equal(w.nav.isWalkable(-1.15, -4.0), false);
  assert.deepEqual(w.doorOpen, [true, true, false]);
  assert.match(w.describe(), /3 doors, 3 objects, 1 closed/);
  assert.ok(w.report().doors[2].open === false);
  // Closing both planes of the bedroom door seals the bedroom.
  w.build(house(), { x: 0, z: 0 }, { doors: [false, false] });
  assert.equal(w.nav.isReachable(4.0, -2.0), false, 'bedroom sealed');
  assert.ok(w.raycast(0, 1.2, -2.175, 1, 0, 0, 20, h) && near(h.x, 3.0), 'shot stops at the closed bedroom door');
  for (let c = 0; c < w.spawner.count; c++) assert.ok(w.spawner.x[c] < 3, 'no spawn candidate in the sealed bedroom');
  // setDoorOpen + rebuild reopens it with the same snapshot and start.
  assert.equal(w.setDoorOpen(0, true), true);
  assert.equal(w.setDoorOpen(1, true), true);
  assert.equal(w.setDoorOpen(9, true), false, 'unknown id');
  w.rebuild();
  assert.ok(w.nav.isReachable(4.0, -2.0));
  assert.deepEqual(w.doorOpen, [true, true, true]);
});

test('door gaps: clearance is exact whatever the yaw, so a 0.62 m frame passes and a 0.5 m one does not', () => {
  const make = (yaw, wd, off) => {
    const b = new SnapshotBuilder({ yaw });
    const r1 = [[0, 0], [5, 0], [5, 4], [0, 4]], r2 = [[5.1, 0], [9, 0], [9, 4], [5.1, 4]];
    b.floor(r1, 0).floor(r2, 0).ceiling(r1, 2.5).ceiling(r2, 2.5);
    for (const r of [r1, r2]) for (let i = 0; i < 4; i++) b.wall(r[i][0], r[i][1], r[(i + 1) % 4][0], r[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
    b.door(5, 2 + off, 5, 2 + off + wd, 0, 2.03);
    const w = new WorldCore();
    const [x, z] = b.toWorld(1, 2);
    w.build(b.build(), { x, z });
    const [rx, rz] = b.toWorld(7.5, 2);
    return { d: w.layout.doors[0], reach: w.nav.isReachable(rx, rz) };
  };
  for (const yaw of [0, 0.37, 0.785, 1.2]) {
    for (const off of [0, 0.03, 0.05, 0.07]) {
      const ok = make(yaw, 0.62, off);
      assert.ok(ok.d.passable && ok.reach, `0.62 m door at yaw ${yaw}, offset ${off}`);
      const no = make(yaw, 0.5, off);
      assert.ok(!no.d.passable && !no.reach || yaw === 0 && off === 0, `0.5 m door at yaw ${yaw}, offset ${off}`);
    }
  }
  assert.equal(DOOR_CLEARANCE, 0.24);
});

// ---------------------------------------------------------------- inferred walls and pockets (F8)

test('inferred walls: a floor edge with no wall plane gets one (door cut into it); open boundaries stay open', () => {
  const b = new SnapshotBuilder({ yaw: 0.2 });
  const a = [[0, 0], [5, 0], [5, 4], [0, 4]];
  const k = [[5, 0], [8, 0], [8, 4], [5, 4]]; // a second floor right next to A, no wall between (open plan)
  b.floor(a, 0).floor(k, 0.01).ceiling(a, 2.5).ceiling(k, 2.45);
  b.wall(0, 0, 5, 0, 0, 2.5, { extend: 0.05 }).wall(0, 4, 0, 0, 0, 2.5, { extend: 0.05 }); // A: south and west only
  b.wall(5, 0, 8, 0, 0, 2.45, { extend: 0.05 }).wall(8, 0, 8, 4, 0, 2.45, { extend: 0.05 }); // K: south and east
  b.vertical('invisible wall face', 8, 4, 5, 4, 0, 2.45); // K's north side is open (Space Setup says so)
  b.door(2, 4, 2.9, 4, 0, 2.03); // a door in A's missing north wall
  const w = new WorldCore();
  const [px, pz] = b.toWorld(1.5, 1.5);
  w.build(b.build(), { x: px, z: pz });
  const L = w.layout;
  const inferred = L.walls.filter((x) => x.inferred);
  assert.equal(inferred.length, 1, `inferred: ${inferred.map((x) => x.len.toFixed(2))}`);
  const iw = inferred[0];
  assert.equal(iw.side, 'edge');
  assert.ok(near(iw.len, 5, 0.06), `along A's north edge: ${iw.len}`);
  assert.ok(near(iw.y1, 2.5), 'up to the ceiling');
  assert.equal(iw.openings.length, 1, 'the door is cut into the inferred wall');
  assert.equal(L.doors[0].wallIds[0], iw.id);
  assert.equal(w.stats.inferredWalls, 1);
  assert.ok(L.boxes.some((x) => x.source === 'inferred'));
  // From inside A: the inferred wall face is at z = 4 with its slab behind; the door is open.
  const [dx, dz] = b.dirToWorld(0, 1);
  const h = hit();
  const [ox, oz] = b.toWorld(1, 1);
  assert.ok(w.raycast(ox, 1.2, oz, dx, 0, dz, 20, h) && near(h.dist, 3, 0.01), `inferred wall face: ${h.dist}`);
  const [qx, qz] = b.toWorld(2.45, 1);
  assert.equal(w.raycast(qx, 1.2, qz, dx, 0, dz, 20, hit()), false, 'through the door into unmapped space');
  // A → K is open floor (no inferred wall on the shared edge), K's north is open too.
  const [ax, az] = b.toWorld(4.5, 2), [kx, kz] = b.toWorld(6.5, 2);
  assert.ok(w.segmentClear(ax, 1.5, az, kx, 1.5, kz), 'open plan between the floors');
  assert.ok(w.nav.isReachable(kx, kz));
  assert.equal(w.nav.doors[w.nav.index(kx, kz)], 0, 'no door crossed');
  const [nx, nz] = b.toWorld(6.5, 3.5), [n2x, n2z] = b.toWorld(6.5, 5);
  assert.ok(w.segmentClear(nx, 1.5, nz, n2x, 1.5, n2z), 'invisible wall face: no inferred wall');
  assert.match(w.describe(), /1 inferred/);
  // No ceiling: an inferred wall is 2.4 m tall.
  const b2 = new SnapshotBuilder();
  b2.floor(a, 0).wall(0, 0, 5, 0, 0, 2.5).wall(5, 0, 5, 4, 0, 2.5).wall(5, 4, 0, 4, 0, 2.5);
  const w2 = new WorldCore();
  w2.build(b2.build(), { x: 2, z: 2 });
  const iw2 = w2.layout.walls.filter((x) => x.inferred);
  assert.equal(iw2.length, 1);
  assert.ok(near(iw2[0].y1, 2.4) && near(iw2[0].ax, 0) && near(iw2[0].len, 4), JSON.stringify(iw2[0]));
});

test('pockets: a door into unmapped space gets a small virtual floor behind it; enemies spawn there and walk in', () => {
  const w = new WorldCore();
  // From (2, 0.5) the pocket is hidden by the north wall (from (0, 0) it is in plain view through the door).
  w.build(house(), { x: 2, z: 0.5 });
  const L = w.layout, g = w.nav;
  const pf = L.floors[L.doors[2].pocket];
  assert.ok(pf.pocket && pf.virtual && pf.door === 2);
  assert.ok(pf.area > 3 && pf.area < 4.5, `pocket ${pf.area} m²`);
  assert.ok(pf.z1 < -2.95 && pf.z0 > -5.2, 'behind the north wall, at most ~2 m deep');
  assert.equal(L.pockets, 1);
  assert.ok(w.spawner.pocketCount >= 1 && w.spawner.pocketCount <= 3, `${w.spawner.pocketCount} pocket candidates`);
  // Spawns: some from the pocket (hidden, behind a door), the rest in the bedroom.
  const out = { x: 0, z: 0 };
  let inPocket = 0, inBedroom = 0;
  for (let k = 0; k < 40; k++) {
    w.update(0, k * 11000);
    assert.ok(w.findSpawn(2, 0.5, -1, -1, 3.5, out));
    assert.equal(w.spawner.lastTier, 3);
    const f = g.flags[g.index(out.x, out.z)];
    if (f & NAV_POCKET) inPocket++;
    else if (out.x > 3.1) inBedroom++;
  }
  // From here the bedroom is in view through its door, so the hidden pocket delivers most enemies.
  assert.ok(inPocket >= 20, `pocket ${inPocket}, bedroom ${inBedroom}`);
  const fromStart = w.report().spawn;
  // (the bedroom's candidates are within 3.5 m of this spot: never used; one pocket cell shows through the door)
  const fs0 = fromStart.fromStart;
  assert.ok(fromStart.pocket >= 1 && fs0.tier3 >= 1 && fs0.tier3 + fs0.tier2 + fs0.visible + fs0.tooNear === fromStart.candidates, JSON.stringify(fs0));
  // From the pocket to the living room: through the hallway door.
  const p = path(w, -1.15, -4.3, 1.0, -2.6);
  assert.ok(p, 'path from the pocket');
  let crossed = false;
  for (let i = 1; i < p.length; i++) {
    const [ax, az] = p[i - 1], [bx, bz] = p[i];
    if ((az + 3.05) * (bz + 3.05) <= 0) {
      const x = ax + ((-3.05 - az) / (bz - az)) * (bx - ax);
      assert.ok(x > -1.6 && x < -0.7, `crosses the north wall at x ${x}`);
      crossed = true;
    }
  }
  assert.ok(crossed);
  // A door into mapped space gets none; a door whose far side is mapped 1 m out has no room for one.
  const b = new SnapshotBuilder();
  const r = [[0, 0], [5, 0], [5, 4], [0, 4]];
  b.floor(r, 0).floor([[0, 5], [5, 5], [5, 8], [0, 8]], 0);
  for (let i = 0; i < 4; i++) b.wall(r[i][0], r[i][1], r[(i + 1) % 4][0], r[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
  b.door(2, 4, 2.9, 4, 0, 2.03);
  const w2 = new WorldCore();
  w2.build(b.build(), { x: 1, z: 1 });
  assert.equal(w2.layout.doors[0].leadsTo, 'unmapped');
  assert.equal(w2.layout.doors[0].pocket, -1);
  assert.ok(w2.stats.notes.some((n) => /no room for a spawn pocket/.test(n)));
});

// ---------------------------------------------------------------- interior walls (risk "Space Setup multi-room data")

test('an interior wall inside one floor polygon: its slab never sits in front of the face the player sees', () => {
  // One 8 × 4 m floor; an interior wall at x = 4 whose plane normal points AWAY from the player (into room B).
  const make = (flip, px) => {
    const b = new SnapshotBuilder();
    const f = [[0, 0], [8, 0], [8, 4], [0, 4]];
    b.floor(f, 0);
    for (let i = 0; i < 4; i++) b.wall(f[i][0], f[i][1], f[(i + 1) % 4][0], f[(i + 1) % 4][1], 0, 2.5);
    b.wall(4, 0, 4, 4, 0, 2.5, { flip }); // flip = false: normal −x; true: +x
    const w = new WorldCore();
    w.build(b.build(), { x: px, z: 2 });
    return w;
  };
  for (const flip of [false, true]) {
    for (const px of [1.5, 6.5]) {
      const w = make(flip, px);
      const inner = w.layout.walls[4];
      assert.equal(inner.side, 'player');
      const h = hit();
      const dir = px < 4 ? 1 : -1;
      assert.ok(w.raycast(px, 1.5, 2, dir, 0, 0, 10, h), 'hits the wall');
      assert.ok(near(h.x, 4, 1e-3), `player at x ${px}, normal ${flip ? '+x' : '−x'}: face at x = 4 (hit ${h.x})`);
      assert.ok(w.raycast(8 - px, 1.5, 2, -dir, 0, 0, 10, h) && near(h.x, 4 + dir * WALL_T, 1e-3), `the slab is on the far side (${h.x})`);
    }
  }
});

test('interior walls the player cannot see keep the normal convention (normal / learned)', () => {
  // Three rooms in one polygon: A | B | C, walls at x = 4 and x = 8; the player in A sees only the x = 4 wall.
  for (const outward of [false, true]) {
    const b = new SnapshotBuilder();
    const f = [[0, 0], [12, 0], [12, 4], [0, 4]];
    b.floor(f, 0);
    for (let i = 0; i < 4; i++) b.wall(f[i][0], f[i][1], f[(i + 1) % 4][0], f[(i + 1) % 4][1], 0, 2.5, { flip: outward });
    b.wall(4, 0, 4, 4, 0, 2.5, { flip: outward }).wall(8, 0, 8, 4, 0, 2.5, { flip: outward });
    const w = new WorldCore();
    w.build(b.build(), { x: 1, z: 2 });
    const [w4, w8] = w.layout.walls.slice(4);
    assert.equal(w4.side, 'player');
    assert.equal(w8.side, outward ? 'learned' : 'normal');
    assert.ok(near(w8.nx, -1), 'normal toward room B as the convention says');
  }
});

// ---------------------------------------------------------------- the user's layout

/**
 * Every wall-plane face the player can see from (sx, sz) (sight blocked by
 * every OTHER box, door openings open) must have the player in front of it:
 * then its slab lies behind the face, never between the player and the real
 * surface.
 */
function slabsInFrontOfPlayer(w, sx, sz) {
  const L = w.layout;
  const bad = [];
  let seen = 0;
  const eyeY = w.floorY(sx, sz) + 1.5;
  for (const wl of L.walls) {
    const others = new ShapeSet(256);
    others.setFromLayout({ ...L, boxes: L.boxes.filter((b) => b.wall !== wl.id) });
    const dp = (sx - wl.ax) * wl.nx + (sz - wl.az) * wl.nz;
    if (Math.abs(dp) < 0.05) continue; // edge-on (the player stands on its line): only its end is seen
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      if (wl.openings.some((o) => t * wl.len > o.u0 - 0.05 && t * wl.len < o.u1 + 0.05)) continue; // a door: no slab there
      let px = wl.ax + (wl.bx - wl.ax) * t, pz = wl.az + (wl.bz - wl.az) * t;
      const py = w.floorY(px, pz) + 1.2;
      const dl = Math.hypot(sx - px, sz - pz);
      px += ((sx - px) / dl) * 0.02;
      pz += ((sz - pz) / dl) * 0.02;
      if (!others.segmentClear(sx, eyeY, sz, px, py, pz)) continue;
      seen++;
      if (dp < 0) bad.push(`wall ${wl.id} (${wl.side}) t ${t}: slab on the player's side`);
    }
  }
  return { bad, seen };
}

test("the user's layout (2 floors 111 m² + 14.4 m², 16 walls, 6 doors): carving, wall sides, spawns in several rooms, build time", (t) => {
  for (const outward of [false, true]) {
    const b = userHouse({ outward });
    const snap = b.build();
    assert.equal(snap.planes.length, 50);
    assert.equal(snap.meshes.length, 25);
    const w = new WorldCore();
    const [px, pz] = b.toWorld(6.0, 2.8);
    w.build(snap, { x: px, z: pz });
    const L = w.layout, s = w.stats;
    assert.deepEqual([s.floors, s.walls, s.inferredWalls, s.doors, s.closedDoors, s.pockets, s.furniture], [2, 16, 0, 6, 0, 0, 24]);
    assert.ok(Math.abs(L.floors[0].area - 111) < 0.5 && Math.abs(L.floors[1].area - 14.4) < 0.1, 'floor areas');
    assert.ok(L.walls.slice(0, 9).every((x) => x.side === 'edge'), 'perimeter walls sit on floor edges');
    assert.ok(L.walls.slice(9).every((x) => x.side !== 'edge' && x.side !== 'sampled'), 'interior walls: floor on both sides');
    assert.ok(L.walls.filter((x) => x.side === 'player').length >= 3, 'the walls the player sees are faced to the player');

    // Sane carving: every door matched, cut and passable; door 5 cuts both edge walls between the floors.
    assert.equal(L.doors[5].walls, 2);
    for (const d of L.doors) {
      assert.ok(d.walls >= 1 && d.open && d.walkable && d.passable, `door ${d.id}: ${JSON.stringify({ walls: d.walls, passable: d.passable })}`);
      assert.equal(d.leadsTo, 'mapped');
      for (const id of d.wallIds) assert.ok(L.walls[id].openings.length >= 1, `door ${d.id} cut into wall ${id}`);
      assert.ok(near(d.width, Math.hypot(DOORS[d.id][2] - DOORS[d.id][0], DOORS[d.id][3] - DOORS[d.id][1]), 0.01));
      // A shot through the door centre crosses the wall line; 0.3 m beside the jamb it stops at the wall.
      const h = hit();
      for (const sg of [1, -1]) {
        const ox = d.cx + d.nx * 0.6 * sg, oz = d.cz + d.nz * 0.6 * sg, fy = w.floorY(ox, oz);
        const got = w.raycast(ox, fy + 1.2, oz, -d.nx * sg, 0, -d.nz * sg, 20, h);
        assert.ok(!got || h.dist > 0.8, `door ${d.id}: open to sight (${got ? h.dist.toFixed(2) : 'no hit'})`);
        const jx = ox + d.tx * (d.width / 2 + 0.3), jz = oz + d.tz * (d.width / 2 + 0.3);
        assert.ok(w.raycast(jx, fy + 1.2, jz, -d.nx * sg, 0, -d.nz * sg, 1.0, h) && h.surface === 'wall', `door ${d.id}: wall beside it`);
      }
      assert.ok(!occluderContains(L.boxes, [d.cx, d.y0 + 1.0, d.cz]), `door ${d.id}: occluder open`);
      assert.ok(w.nav.flags[w.nav.index(d.cx, d.cz)] & NAV_DOOR, `door ${d.id}: carved`);
    }

    // Slabs never in front of what the player sees, from a start in several rooms.
    for (const [rx, rz] of [[6.0, 2.8], [2, 2.5], [10.5, 1.5], [13.5, 1.2], [6.5, 8]]) {
      const [sx, sz] = b.toWorld(rx, rz);
      const v = new WorldCore();
      v.build(snap, { x: sx, z: sz });
      const r = slabsInFrontOfPlayer(v, sx, sz);
      assert.deepEqual(r.bad, [], `start (${rx}, ${rz}), normals ${outward ? 'outward' : 'inward'}`);
      assert.ok(r.seen >= 8, `start (${rx}, ${rz}): ${r.seen} face points seen`);
    }

    // Spawn candidates in several rooms, never in the sealed closet or on virtual floor.
    const rooms = new Map();
    for (let c = 0; c < w.spawner.count; c++) {
      const [hx, hz] = toHouse(b, w.spawner.x[c], w.spawner.z[c]);
      const name = roomAt(hx, hz);
      rooms.set(name, (rooms.get(name) || 0) + 1);
      assert.equal(w.nav.flags[w.nav.index(w.spawner.x[c], w.spawner.z[c])] & NAV_VIRTUAL, 0);
    }
    assert.ok(!rooms.has('closet'));
    const withCands = [...rooms.entries()].filter(([n, k]) => n && k >= 4).map(([n]) => n).sort();
    assert.ok(withCands.length >= 5, `rooms with spawn candidates: ${withCands.join(' ')}`);
    const rep = w.report();
    assert.equal(rep.spawn.candidates, w.spawner.count);
    assert.ok(rep.spawn.fromStart.tier3 >= 50, `hidden behind a door from the start: ${rep.spawn.fromStart.tier3}`);
    // Spawns over a session come from several rooms, all hidden behind a door.
    const out = { x: 0, z: 0 };
    const spawnRooms = new Set();
    const [vx, vz] = b.dirToWorld(-1, 0);
    for (let k = 0; k < 40; k++) {
      w.update(0, k * 11000);
      assert.ok(w.findSpawn(px, pz, vx, vz, 4, out));
      assert.equal(w.spawner.lastTier, 3);
      spawnRooms.add(roomAt(...toHouse(b, out.x, out.z)));
    }
    assert.ok(spawnRooms.size >= 3, `spawn rooms: ${[...spawnRooms].join(' ')}`);
    assert.equal(w.report().spawn.finds.tier3, 40);

    // Closing the A–C door (id 0) cuts off A and B (B's only door leads to A).
    assert.ok(w.setDoorOpen(0, false));
    w.rebuild();
    for (const name of ['A', 'B']) {
      const [cx, cz] = ROOMS[name];
      const [x, z] = b.toWorld(cx + 2, cz + 1.5);
      assert.equal(w.nav.isReachable(x, z), false, `room ${name} sealed`);
    }
    for (let c = 0; c < w.spawner.count; c++) {
      const n = roomAt(...toHouse(b, w.spawner.x[c], w.spawner.z[c]));
      assert.ok(n !== 'A' && n !== 'B', 'no spawn candidate behind the closed door');
    }
    w.setDoorOpen(0, true);
    w.rebuild();
  }

  // Build time: cold (first build in a fresh process is JIT-cold anyway) and warm after warmUp().
  const b = userHouse();
  const snap = b.build();
  const [px, pz] = b.toWorld(6.0, 2.8);
  const w = new WorldCore();
  w.warmUp();
  const t0 = performance.now();
  const N = 5;
  for (let k = 0; k < N; k++) w.build(snap, { x: px, z: pz });
  const warm = (performance.now() - t0) / N;
  t.diagnostic(`user layout build ${warm.toFixed(2)} ms warm (stats.buildMs ${w.stats.buildMs.toFixed(2)}), ${w.nav.count} cells, ${w.spawner.count} spawn candidates`);
  assert.ok(warm < 150, `build ${warm} ms (desktop Node bound)`);
  assert.ok(w.stats.buildMs > 0 && w.report().buildMs === Math.round(w.stats.buildMs * 10) / 10);
});

// ---------------------------------------------------------------- report and overlay

test('World.report(): compact, JSON-safe, everything the session record needs', () => {
  const b = userHouse();
  const w = new WorldCore();
  const [px, pz] = b.toWorld(6.0, 2.8);
  w.build(b.build(), { x: px, z: pz });
  const r = w.report();
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, 'no NaN, no undefined, no typed arrays');
  const bytes = JSON.stringify(r).length;
  assert.ok(bytes < 16000, `${bytes} bytes`);
  assert.equal(r.v, 1);
  assert.equal(r.floors.length, 2);
  assert.ok(r.floors.every((f) => f.kind === 'mapped' && f.area > 14));
  assert.equal(r.walls.length, 16);
  for (const x of r.walls) {
    assert.ok(['edge', 'sampled', 'player', 'learned', 'normal'].includes(x.side));
    assert.equal(typeof x.inferred, 'boolean');
    assert.equal(x.a.length, 2);
  }
  assert.equal(r.doors.length, 6);
  for (const d of r.doors) for (const k of ['walls', 'offsets', 'width', 'bottom', 'walkable', 'passable', 'open', 'side', 'leadsTo', 'pocket']) assert.ok(k in d, k);
  assert.equal(r.furniture.length, 24);
  assert.ok(r.furniture.every((f) => typeof f.label === 'string' && f.size.length === 3));
  assert.ok(r.furniture.some((f) => f.label === 'bed') && r.furniture.some((f) => f.label === 'couch'));
  assert.ok(r.spawn.candidates > 50);
  assert.ok(r.spawn.byFloor.length === 2 && r.spawn.byFloor[1] > 0, 'candidates on both floors');
  assert.ok(r.nav.cells > 0 && r.nav.startCell);
  assert.ok(typeof r.buildMs === 'number');
  assert.deepEqual(new WorldCore().report(), { v: 1, built: false });
  // Virtual room: still JSON-safe (ceiling NaN → null).
  const v = new WorldCore();
  v.build(null, { x: 0, z: 0 });
  const rv = v.report();
  assert.equal(rv.ceilingY, null);
  assert.deepEqual(JSON.parse(JSON.stringify(rv)), rv);
});

test('dev overlay edges (pure): every occluder box, door frames by state, pockets; same boxes as the occluder', () => {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 }, { doors: [true, false] });
  const L = w.layout;
  const max = 256 * EDGE_VERTS_PER_BOX + 512;
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3);
  const n = writeOverlayEdges(L, pos, col, 256, max);
  assert.equal(L.curtains.length, 1, 'the open hallway door into unmapped space has a curtain (v0.4.1)');
  const nb = L.boxes.length + L.curtains.length;
  assert.equal(n, nb * EDGE_VERTS_PER_BOX + L.doors.length * 8 + L.pockets * 8);
  assert.equal(n % 2, 0);
  const colorAt = (i) => [col[3 * i], col[3 * i + 1], col[3 * i + 2]].map((v) => Math.round(v * 100) / 100);
  const doorStart = nb * EDGE_VERTS_PER_BOX;
  assert.deepEqual(colorAt(doorStart - 1), OVERLAY_COLOR.curtain.map((v) => Math.round(v * 100) / 100), 'curtain edges last');
  assert.deepEqual(colorAt(doorStart), OVERLAY_COLOR.doorOpen.map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(colorAt(doorStart + 8), OVERLAY_COLOR.doorClosed.map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(colorAt(n - 1), OVERLAY_COLOR.pocket.map((v) => Math.round(v * 100) / 100));
  // Each box contributes 12 axis-aligned (in its frame) edges whose ends lie just outside the occluder box.
  for (let i = 0; i < doorStart; i += 2) {
    const len = Math.hypot(pos[3 * i] - pos[3 * i + 3], pos[3 * i + 1] - pos[3 * i + 4], pos[3 * i + 2] - pos[3 * i + 5]);
    assert.ok(len > 0.004, 'no zero-length edge');
  }
  // Capacity is respected.
  assert.ok(writeOverlayEdges(L, pos, col, 256, 30) <= 30);
  assert.equal(writeOverlayEdges(null, pos, col, 256, max), 0);
});

test('findSpawn with its tier log, raycast and floorY allocate nothing in world code (sampling heap profiler)', async () => {
  const w = new WorldCore();
  w.build(userHouse().build(), { x: 0, z: 0 });
  const out = { x: 0, z: 0 }, h = hit();
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      w.update(0, i * 400);
      w.findSpawn(0, 0, Math.cos(i), Math.sin(i), 3, out);
      w.raycast(0, 1.5, 0, Math.cos(i), -0.1, Math.sin(i), 20, h);
      w.floorY(out.x, out.z);
    }
  };
  run(20000); // past JIT tiering: interpreted and baseline code box doubles
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 128 });
  run(10000);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const sites = [];
  const walk = (node) => {
    if (node.selfSize && node.callFrame.url.includes('/src/world/')) {
      bytes += node.selfSize;
      sites.push(`${node.callFrame.functionName}:${node.callFrame.lineNumber + 1}`);
    }
    for (const c of node.children) walk(c);
  };
  walk(profile.head);
  assert.ok(bytes < 2048, `world code allocated ~${bytes} bytes in 10,000 rounds at ${sites.join(', ')}`);
  assert.equal(w.spawner.finds.reduce((a, b) => a + b, 0), 30000);
  assert.ok((NAV_INSIDE | NAV_WALK) > 0);
});

// ---------------------------------------------------------------- spawns: 3.5 m floor, in-view last resort, tier per find

test('spawns are never within 3.5 m of the player, whatever minDist asks', () => {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 });
  const out = { x: 0, z: 0 };
  let found = 0;
  for (let k = 0; k < 40; k++) {
    w.update(0, k * 11000);
    const a = k * 0.9;
    if (!w.findSpawn(0, 0, Math.cos(a), Math.sin(a), 1.0, out)) continue;
    found++;
    assert.ok(Math.hypot(out.x, out.z) >= 3.5 - 1e-6, `spawn ${k} ${Math.hypot(out.x, out.z).toFixed(2)} m away`);
    assert.equal(w.spawner.lastX, out.x);
    assert.equal(w.spawner.lastZ, out.z);
    assert.ok(w.spawner.lastTier >= 1 && w.spawner.lastTier <= 4);
  }
  assert.ok(found >= 30, `${found} of 40`);
  assert.equal(w.findSpawn(0, 0, 1, 0, 30, out), false);
  assert.ok(Number.isNaN(w.spawner.lastX) && w.spawner.lastTier === 0, 'a failed find clears the last point');
});

test('in view (±100°) only as a last resort: after 4 empty finds in a row, the most peripheral point, then the wait starts again', () => {
  // one bare 7 × 6 m room, the player in a corner facing into it: every candidate is in view
  const r = [[0, 0], [7, 0], [7, 6], [0, 6]];
  const b = new SnapshotBuilder();
  b.floor(r, 0).ceiling(r, 2.5);
  for (let i = 0; i < 4; i++) b.wall(r[i][0], r[i][1], r[(i + 1) % 4][0], r[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
  const w = new WorldCore();
  w.build(b.build(), { x: 0.7, z: 0.7 });
  assert.ok(w.spawner.count > 10 && w.report().spawn.fromStart.visible === w.spawner.count, 'nothing hides');
  const out = { x: 0, z: 0 };
  const vx = Math.SQRT1_2, vz = Math.SQRT1_2;
  const angle = () => (Math.acos(((out.x - 0.7) * vx + (out.z - 0.7) * vz) / Math.hypot(out.x - 0.7, out.z - 0.7)) * 180) / Math.PI;
  /** @type {boolean[]} */ const got = [];
  for (let k = 0; k < 10; k++) {
    w.update(0, k * 11000);
    got.push(w.findSpawn(0.7, 0.7, vx, vz, 3.5, out));
    if (got[k]) {
      assert.equal(w.spawner.lastTier, 4, 'the in-view tier');
      assert.ok(Math.hypot(out.x - 0.7, out.z - 0.7) >= 3.5);
      assert.ok(angle() > 40, `as far from the view direction as the room allows: ${angle().toFixed(0)}°`);
    }
  }
  assert.deepEqual(got, [false, false, false, true, false, false, false, true, false, false], 'every 4th try');
  const s = w.report().spawn;
  assert.equal(s.finds.inView, 2);
  assert.equal(s.finds.none, 8);
  assert.ok(s.recent.every((e) => e.tier === 4));
  // turned round: a visible point behind (tier 1) at once, and the streak is cleared
  assert.ok(w.findSpawn(0.7, 0.7, -1, 0, 3.5, out) || w.findSpawn(0.7, 0.7, -vx, -vz, 3.5, out));
  assert.equal(w.spawner.failStreak, 0);
  // a hidden point always wins over the last resort
  const h = new WorldCore();
  h.build(house(), { x: 0, z: 0 });
  for (let k = 0; k < 8; k++) {
    h.update(0, k * 11000);
    if (h.findSpawn(0, 0, 3, -2.175, 3.5, out)) assert.notEqual(h.spawner.lastTier, 4);
  }
});
