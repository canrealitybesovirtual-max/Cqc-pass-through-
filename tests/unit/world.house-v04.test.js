// v0.4.1: the user's real house (the v0.4 headset session's Space Setup snapshot v2, with its global mesh:
// tests/fixtures/house-v04-device.json) replayed in Node through the same build the headset ran.
// The user: "it's looking fake how they spawn, see through my walls, and their height".
// - The living room's floor is a 4-point rectangle that also covers the space behind its three doors (the game's
//   room "R6") and a closed corner behind two of its walls ("R3"): v0.4 spawned five of six enemies there, in
//   plain view through the open doors, where the real house has other walls. Now that space is unscanned
//   (NAV_HIDDEN), covered by door curtains, and holds spawns only right behind its doors.
// - Outer wall corners: the slabs met end to end, a 5 × 5 cm hole at every corner (the replay saw enemies
//   through them); outer wall ends now reach 6 cm past the plane's end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateSnapshot, normalizeSnapshot } from '../../src/world/Snapshot.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { NAV_HIDDEN, NAV_POCKET } from '../../src/world/NavGrid.js';
import { scannedSideVote } from '../../src/world/Layout.js';
import { occluderExtents } from '../../src/world/Occluder.js';
import { Brain } from '../../src/enemies/Brain.js';

const START = { x: -0.2256, z: 0.0093 }; // play.world.zone (the bedroom)
const SPAWNS = [[4.58, 10.9], [0.38, 6.5], [6.38, 1.5], [-1.22, 3], [-1.22, 4.5], [-1.22, 6.5]]; // play.world.report.spawn.recent

const snap = await hydrateSnapshot(normalizeSnapshot(JSON.parse(readFileSync(new URL('../fixtures/house-v04-device.json', import.meta.url), 'utf8'))));
const build = (roam = true) => {
  const w = new WorldCore({ roam });
  w.build(snap, START, { roam, mesh: true });
  w.finishBake();
  return w;
};
const W = build();

test('the recorded house builds as on the headset (walls, doors, floors, the mesh)', () => {
  const L = W.layout;
  assert.equal(L.walls.length, 20);
  assert.equal(L.walls.filter((w) => w.inferred).length, 4);
  assert.equal(L.doors.length, 6);
  assert.equal(L.mappedFloors, 2);
  assert.ok(W.stats.meshTris > 23000, `mesh ${W.stats.meshTris}`);
});

test('floor heights: the scanned floor decides; overlapping floor polygons give the smaller (the room\'s own) floor', () => {
  // the living room's plane at −1.510 (its scanned floor triangles agree within 1.5 cm); the bedroom room scan's plane
  // at −1.585 sat 6.7 cm under the scanned floor of its own hall (−1.518): moved there, pockets with it
  assert.ok(Math.abs(W.floorY(3.44, 7.96) + 1.51) < 0.005, `living room ${W.floorY(3.44, 7.96)}`);
  const fix = /** @type {any} */ (W.meshStats).floorFix;
  assert.equal(fix.length, 1);
  assert.equal(fix[0].floor, 1);
  assert.ok(Math.abs(fix[0].from + 1.585) < 0.001 && Math.abs(fix[0].to + 1.518) < 0.004 && fix[0].area > 2, JSON.stringify(fix));
  assert.ok(W.stats.notes.some((n) => /floor 1 moved 6\.\d cm/.test(n)));
  // the whole bedroom and its hall on one height (v0.4: half the bedroom was on the living room's −1.510, the rest
  // on −1.585: an enemy crossing the room rose 7.5 cm in mid-air)
  const ys = new Set();
  for (let x = -1.3; x <= 0.4; x += 0.1) for (let z = -1.3; z <= 1.4; z += 0.1) if (W.roomAt(x, z) === W.roomAt(START.x, START.z)) ys.add(W.floorY(x, z).toFixed(4));
  assert.equal(ys.size, 1, `bedroom floor heights: ${[...ys].join(' ')}`);
  assert.ok(Math.abs(Number([...ys][0]) + 1.518) < 0.004);
  assert.ok(Math.abs(W.floorY(1.19, 1.73) + 1.518) < 0.004, 'hall');
  assert.ok(Math.abs(W.floorY(-0.43, -2.59) + 1.518) < 0.004, 'the bedroom door pocket follows');
  // without the mesh (a synchronous build skips it) the planes stand, and the smaller polygon still wins in the bedroom
  const P = new WorldCore({ roam: true });
  P.build(snap, START, { roam: true, mesh: false });
  assert.ok(Math.abs(P.floorY(-0.2, 1.0) + 1.585) < 0.005 && Math.abs(P.floorY(-0.2, -1.0) + 1.585) < 0.005, 'one bedroom height');
});

test('space behind the real walls is unscanned (NAV_HIDDEN); the rooms the user walked are not', () => {
  for (const [x, z, name] of [[START.x, START.z, 'bedroom (start)'], [1.19, 1.73, 'hall'], [3.44, 7.96, 'living room'], [4.58, 10.9, 'recorded spawn 0']]) {
    assert.equal(W.nav.isHidden(x, z), false, `${name} is scanned`);
    assert.ok(scannedSideVote(W.layout.walls, x, z) > 0, `${name}: the real walls face it`);
  }
  for (const [x, z, name] of [[-1.22, 4.5, 'behind the living room doors'], [6.38, 1.5, 'the closed corner'], [-0.43, -2.59, 'bedroom door pocket'], [5.1, 13.39, 'living room door pocket']]) {
    assert.equal(W.nav.isHidden(x, z), true, `${name} is hidden`);
  }
  assert.equal(W.stats.hiddenRooms, 2);
  assert.ok(W.stats.notes.some((n) => /behind the real walls/.test(n)), W.stats.notes.join(' | '));
  // the stationary build classifies the same way
  const S = build(false);
  assert.equal(S.nav.isHidden(-1.22, 4.5), true);
  assert.equal(S.nav.isHidden(3.44, 7.96), false);
});

test('every open door into unscanned space has a curtain on the far face of its wall', () => {
  const L = W.layout;
  const curtained = new Set(L.curtains.map((c) => /** @type {any} */ (c).door));
  assert.deepEqual([...curtained].sort(), [0, 1, 2, 3, 4, 5], 'the three doors into R6, both pocket doors and the door into the void');
  for (const c of L.curtains) {
    const d = L.doors[/** @type {any} */ (c).door];
    const along = (c.cx - d.cx) * /** @type {any} */ (c).nx + (c.cz - d.cz) * /** @type {any} */ (c).nz;
    assert.ok(along > 0.02 && along < 0.45, `door ${d.id}: curtain ${along.toFixed(3)} m behind the door plane`);
    assert.ok(W.nav.isHidden(c.cx + /** @type {any} */ (c).nx * 0.5, c.cz + /** @type {any} */ (c).nz * 0.5) || W.nav.index(c.cx + /** @type {any} */ (c).nx * 0.5, c.cz + /** @type {any} */ (c).nz * 0.5) < 0
      || (W.nav.flags[W.nav.index(c.cx + /** @type {any} */ (c).nx * 0.5, c.cz + /** @type {any} */ (c).nz * 0.5)] & 1) === 0, `door ${d.id}: hidden side`);
    assert.ok(c.hx >= d.width / 2 + 0.05 && c.y0 <= d.y0 && c.y1 >= d.y1, `door ${d.id}: covers the opening`);
  }
  assert.deepEqual(W.report().hidden, { rooms: 2, curtains: 6, pocketCells: W.stats.hiddenPocketCells });
});

test('curtains stand while the player is in scanned space, and stand down past a curtain or in hidden space', () => {
  const w = build();
  const ctx = { player: { head: { x: 3.0, z: 5.6 }, valid: true } };
  w.update(1 / 72, 1000, null, ctx);
  assert.equal(w.curtainsOn, true, 'living room');
  ctx.player.head.x = -1.2; ctx.player.head.z = 4.5; // walked through the door into the real hallway (unscanned)
  w.update(1 / 72, 1014, null, ctx);
  assert.equal(w.curtainsOn, false, 'in unscanned space');
  ctx.player.head.x = START.x; ctx.player.head.z = START.z;
  w.update(1 / 72, 1028, null, ctx);
  assert.equal(w.curtainsOn, true, 'back in the bedroom');
  const d = w.layout.doors[4], c = /** @type {any} */ (w.layout.curtains.find((k) => /** @type {any} */ (k).door === 4));
  ctx.player.head.x = c.cx + c.nx * 0.05; ctx.player.head.z = c.cz + c.nz * 0.05; // leaning through the bedroom door
  w.update(1 / 72, 1042, null, ctx);
  assert.equal(w.curtainsOn, false, `past door ${d.id}'s curtain`);
});

test('spawns: no candidate in unscanned space except right behind a door; the recorded unscanned spawns are refused', () => {
  const S = W.spawner, nav = W.nav;
  let behindDoor = 0;
  for (let k = 0; k < S.count; k++) {
    const i = nav.index(S.x[k], S.z[k]);
    if ((nav.flags[i] & NAV_HIDDEN) === 0) continue;
    assert.ok((nav.flags[i] & NAV_POCKET) !== 0, `candidate ${k} (${S.x[k].toFixed(2)}, ${S.z[k].toFixed(2)}) hidden but not behind a door`);
    behindDoor++;
  }
  assert.ok(behindDoor >= 6, `door spawns: ${behindDoor}`);
  // (−1.22, 3) is 2 m behind the hall-side door (1): right behind a door, a door spawn may stand there
  for (const [x, z] of [[6.38, 1.5], [-1.22, 4.5], [-1.22, 6.5]]) {
    const i = nav.index(x, z);
    assert.ok((nav.flags[i] & NAV_HIDDEN) !== 0 && (nav.flags[i] & NAV_POCKET) === 0, `(${x}, ${z}): unscanned, away from a door`);
    for (let k = 0; k < S.count; k++) assert.ok(Math.hypot(S.x[k] - x, S.z[k] - z) > 0.6, `no candidate near the recorded spawn (${x}, ${z})`);
  }
  // a door spawn is out of sight while the curtains stand, whatever the sight lines through the door say
  let k = -1;
  for (let j = 0; j < S.count; j++) if (S.pocket[j] && W.roomAt(S.x[j], S.z[j]) === W.roomAt(-1.22, 4.5)) { k = j; break; }
  assert.ok(k >= 0, 'a door spawn behind the living room doors');
  const ey = W.floorY(3.0, 5.6) + 1.6, d = Math.hypot(S.x[k] - 3.0, S.z[k] - 5.6);
  assert.equal(S.visible(W, ey, 3.0, 5.6, S.x[k], S.z[k], d), false);
});

test('the roam search brings enemies in through the doors, from where the player cannot see them', () => {
  const w = build();
  const out = { x: 0, z: 0 };
  let found = 0, door = 0;
  const ctx = { player: { head: { x: 3.0, z: 6.0 }, valid: true } };
  for (let s = 0; s < 40; s++) {
    w.update(1 / 72, 20000 * s, null, ctx);
    let r = 2, guard = 0;
    while (r === 2 && guard++ < 200) r = w.spawnRoam(3.0, 6.0, 0, 0, -1, 0, out);
    if (r !== 1) continue;
    found++;
    const i = w.nav.index(out.x, out.z);
    assert.ok((w.nav.flags[i] & NAV_HIDDEN) === 0 || (w.nav.flags[i] & NAV_POCKET) !== 0, `spawn ${s} (${out.x.toFixed(2)}, ${out.z.toFixed(2)})`);
    if ((w.nav.flags[i] & NAV_POCKET) !== 0) door++;
  }
  assert.ok(found >= 20, `found ${found}`);
  assert.ok(door >= found * 0.5, `most come from behind a door: ${door} of ${found}`);
});

test('outer wall corners are closed in the occluder (no slit where two walls meet)', () => {
  const L = W.layout, E = new Float64Array(6);
  const boxes = L.boxes.filter((b) => b.kind === 'wall').map((b) => { occluderExtents(b, E); return { b, e: Array.from(E) }; });
  /** does the segment p → q pass through any wall piece of the occluder? (slab test in each box frame) */
  const hits = (p, q) => boxes.some(({ b, e }) => {
    const tr = (v) => { const dx = v[0] - b.cx, dz = v[2] - b.cz; return [dx * b.c + dz * b.s, v[1], -dx * b.s + dz * b.c]; };
    const a = tr(p), c = tr(q), lo = [e[0], e[2], e[4]], hi = [e[1], e[3], e[5]];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      const d = c[k] - a[k];
      if (Math.abs(d) < 1e-12) { if (a[k] < lo[k] || a[k] > hi[k]) return false; continue; }
      let u = (lo[k] - a[k]) / d, v = (hi[k] - a[k]) / d;
      if (u > v) [u, v] = [v, u];
      t0 = Math.max(t0, u); t1 = Math.min(t1, v);
      if (t0 > t1) return false;
    }
    return true;
  });
  const real = L.walls.filter((w) => !w.inferred);
  let corners = 0;
  for (const a of real) {
    for (const b of real) {
      if (a.id >= b.id || Math.abs(a.tx * b.tx + a.tz * b.tz) > 0.7) continue; // corners only (not collinear pieces)
      for (const [px, pz] of [[a.ax, a.az], [a.bx, a.bz]]) {
        if (Math.hypot(px - b.ax, pz - b.az) > 0.12 && Math.hypot(px - b.bx, pz - b.bz) > 0.12) continue;
        corners++;
        // through the corner from in front of both faces to behind both: the walls are in the way, so is the occluder
        let bx = a.nx + b.nx, bz = a.nz + b.nz;
        const bl = Math.hypot(bx, bz);
        bx /= bl; bz /= bl;
        for (const y of [Math.max(a.y0, b.y0) + 0.5, Math.max(a.y0, b.y0) + 1.5]) {
          for (const off of [-0.03, -0.015, 0, 0.015, 0.03]) {
            const ox = -bz * off, oz = bx * off;
            const p = [px + bx * 0.7 + ox, y, pz + bz * 0.7 + oz], q = [px - bx * 0.7 + ox, y, pz - bz * 0.7 + oz];
            assert.ok(hits(p, q), `corner of walls ${a.id}/${b.id} at (${px.toFixed(2)}, ${pz.toFixed(2)}), height ${y.toFixed(2)}, offset ${off}`);
          }
        }
      }
    }
  }
  assert.ok(corners >= 8, `corners checked: ${corners}`);
});

test('an enemy in unscanned space behind a curtain never sees or shoots the player; out in the room he does', () => {
  const w = build();
  w.curtainsOn = true;
  const brain = new Brain({ maxEnemies: 2, seed: 3, difficulty: 'realistic' });
  brain.attach(w, null);
  // the player in the living room, looking at the double door; the enemy 1.5 m behind it, in the open line of the door
  const head = { x: 3.0, y: w.floorY(3.0, 5.4) + 1.6, z: 5.4 };
  const player = { head, torsoTop: { x: 3.0, y: head.y - 0.25, z: 5.4 }, torsoBottom: { x: 3.0, y: head.y - 0.75, z: 5.4 }, alive: true };
  const d = w.layout.doors[5];
  const sg = (3.0 - d.cx) * d.nx + (5.4 - d.cz) * d.nz > 0 ? -1 : 1;
  const ex = d.cx + d.nx * sg * 1.2, ez = d.cz + d.nz * sg * 1.2;
  assert.ok(w.nav.isHidden(ex, ez), 'he stands in unscanned space');
  assert.ok(w.segmentClear(ex, w.floorY(ex, ez) + 1.6, ez, head.x, head.y, head.z), 'the line through the open door is clear');
  brain.spawn(0, ex, ez, Math.atan2(3.0 - ex, 5.4 - ez));
  const a = brain.agents[0];
  a.state = 2; a.hasGoal = true; a.goalX = ex; a.goalZ = ez; // hold there
  let fired = 0;
  const face = Math.atan2(3.0 - ex, 5.4 - ez);
  for (let f = 0; f < 72 * 4; f++) { brain.update(1 / 72, player); a.x = ex; a.z = ez; a.yaw = face; if (a.fire) fired++; }
  assert.equal(a.los, false, 'no sight from behind the curtain');
  assert.equal(fired, 0, 'no shots from behind the curtain');
  w.curtainsOn = false; // the player walked into the hallway: the curtains stand down, he is seen and sees
  for (let f = 0; f < 72 * 4; f++) { brain.update(1 / 72, player); a.x = ex; a.z = ez; a.yaw = face; }
  assert.equal(a.los, true);
});

test('a house closed by real walls has no unscanned room, whichever way its interior wall planes face', async () => {
  const { userHouse } = await import('./world.houses.js');
  for (const outward of [false, true]) {
    const b = userHouse({ outward });
    const w = new WorldCore({ roam: true });
    const [px, pz] = b.toWorld(6.0, 2.8);
    w.build(b.build(), { x: px, z: pz });
    assert.equal(w.stats.hiddenRooms, 0, `outward ${outward}`);
  }
  const fx = new WorldCore({ roam: true });
  fx.build(JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8')), { x: 0, z: 0 });
  assert.equal(fx.stats.hiddenRooms, 0);
  assert.equal(fx.layout.curtains.length, 1, 'the fixture: one curtain, in the hallway door (unmapped behind it)');
});
