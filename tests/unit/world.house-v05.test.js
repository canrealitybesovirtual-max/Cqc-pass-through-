// v0.6: the user's real house from the v0.5 headset session (tests/fixtures/house-v05-device.json: the Space Setup
// snapshot v2 with its global mesh, plus the learned overlay rebuilt from the session's world report: 9 learned
// walls, the 2 walked openings, 4 learned boxes; the 4 small learned floors and the walked points are not in the v0.5
// record) replayed in Node through the same build the headset ran.
// - The record's 18 "path timeouts": frames whose 0.35 ms budget cut a long A* search (it resumed the next frame);
//   the searches through the doors expanded up to ~3,000 cells. Weighted A* with the door fields as landmarks.
// - Cover, room clearing's defenders and home defense's breach doors on this house.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateSnapshot, normalizeSnapshot } from '../../src/world/Snapshot.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { NAV_HIDDEN, NAV_WALK } from '../../src/world/NavGrid.js';
import { CoverIndex, breachDoors, breachSpawn, planHides } from '../../src/world/Cover.js';
import { PathPlanner } from '../../src/world/PathPlanner.js';
import { AI, Brain, ST, PATH_H_WEIGHT } from '../../src/enemies/Brain.js';


const FX = JSON.parse(readFileSync(new URL('../fixtures/house-v05-device.json', import.meta.url), 'utf8'));
const START = FX._session.start;
const snap = await hydrateSnapshot(normalizeSnapshot(FX));
const W = new WorldCore({ roam: true });
W.build(snap, START, { roam: true, mesh: true });
W.finishBake();

test('the recorded house (with the learned overlay) builds as on the headset', () => {
  const E = FX._session.expect;
  assert.equal(W.layout.walls.length, E.walls);
  assert.equal(W.layout.doors.length, E.doors);
  assert.equal(W.stats.rooms, E.rooms);
  assert.equal(W.stats.hiddenRooms, E.hiddenRooms);
  // the 4 small learned floors are missing from the record: within 2 %
  assert.ok(Math.abs(W.stats.walkable - E.walkable) / E.walkable < 0.02, `walkable ${W.stats.walkable}`);
  assert.ok(W.roamIndex.fieldsReady);
});

test('path searches: weighted A* with the door-field landmarks needs ~5× fewer expansions; paths no longer', () => {
  const nav = W.nav, sp = W.spawner, out = new Float32Array(128);
  const goals = [];
  for (let i = 0; i < nav.count; i += 97) if (nav.flags[i] & NAV_WALK) goals.push([nav.centerX(i), nav.centerZ(i)]);
  const len = (n) => { let L = 0; for (let i = 1; i < n; i++) L += Math.hypot(out[2 * i] - out[2 * i - 2], out[2 * i + 1] - out[2 * i - 1]); return L; };
  const runAll = (hWeight, landmarks) => {
    const src = nav.pathSource;
    if (!landmarks) nav.pathSource = null;
    const P = new PathPlanner(nav, { hWeight, clock: () => 0 });
    const ex = [], L = [];
    let multi = 0;
    for (let c = 0; c < sp.count; c += 3) for (let g = 0; g < goals.length; g += 7) {
      P.request(0, sp.x[c], sp.z[c], goals[g][0], goals[g][1]);
      const e0 = P.stats.expansions;
      let f = 0, n = -1;
      while (n === -1 && f < 50) { f++; P.step(AI.pathQuota); n = P.result(0, out); }
      if (n > 0) { ex.push(P.stats.expansions - e0); L.push(len(n)); if (f > 1) multi++; }
    }
    nav.pathSource = src;
    ex.sort((a, b) => a - b);
    return { p95: ex[Math.floor(0.95 * (ex.length - 1))], multi, n: ex.length, len: L.reduce((a, b) => a + b, 0) };
  };
  const old = runAll(1, false), now = runAll(PATH_H_WEIGHT, true);
  assert.equal(now.n, old.n, 'the same goals are reached');
  assert.ok(old.p95 > 2000, `v0.5 p95 ${old.p95}`);
  assert.ok(now.p95 < old.p95 / 3.5, `p95 expansions ${old.p95} → ${now.p95}`);
  assert.ok(now.multi < old.multi / 6, `searches over one frame's quota ${old.multi} → ${now.multi}`);
  assert.ok(now.len <= old.len * 1.01, `total path ${old.len.toFixed(1)} → ${now.len.toFixed(1)} m`);
});

test('cover: points beside real furniture and door frames, on walkable scanned floor, each with a walkable peek', () => {
  const C = new CoverIndex();
  C.build(W);
  assert.ok(C.count >= 15, `cover points ${C.count}`);
  assert.ok(C.stats.furniture >= 10 && C.stats.jambs >= 4, JSON.stringify(C.stats));
  const nav = W.nav;
  for (let i = 0; i < C.count; i++) {
    const c = nav.index(C.x[i], C.z[i]);
    assert.ok((nav.flags[c] & NAV_WALK) && !(nav.flags[c] & NAV_HIDDEN), `point ${i}`);
    assert.ok(nav.isWalkable(C.px[i], C.pz[i]), `peek ${i}`);
    assert.ok(Math.hypot(C.dx[i], C.dz[i]) > 0.99);
  }
  assert.equal(C.version, nav.version);
});

test('room clearing: defenders wait in the rooms the player is not in, apart, at cover, facing a door', () => {
  const C = new CoverIndex();
  C.build(W);
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const H = planHides(W, C, START.x, START.z, 6, rand);
  assert.ok(H.length >= 2, `defenders ${H.length}`);
  const pr = W.roomAt(START.x, START.z);
  for (const h of H) {
    assert.notEqual(h.room, pr);
    assert.equal(W.roomAt(h.x, h.z), h.room);
    assert.ok(Math.hypot(h.x - START.x, h.z - START.z) > 2);
    for (const o of H) if (o !== h) assert.ok(Math.hypot(h.x - o.x, h.z - o.z) >= 1.5);
  }
  assert.ok(new Set(H.map((h) => h.room)).size >= 2, 'more than one room is held');
});

test('home defense: breach doors lead out of the mapped house; breach spawns stand hidden behind them, never near the player', () => {
  const D = breachDoors(W);
  assert.ok(D.length >= 1);
  const R = W.roamIndex, out = { x: 0, z: 0 };
  let found = 0;
  for (const k of D) {
    assert.equal(R.doorExterior[k], 1);
    for (let i = 0; i < 10; i++) {
      if (!breachSpawn(W, k, START.x, START.z, out, i / 10)) break;
      found++;
      assert.ok(Math.hypot(out.x - R.doorX[k], out.z - R.doorZ[k]) <= 2.81);
      assert.ok(Math.hypot(out.x - START.x, out.z - START.z) >= 3.5);
      assert.ok(W.nav.isWalkable(out.x, out.z));
    }
  }
  assert.ok(found > 0);
});

/** A brain on this house with the planner the game uses, the player standing at (x, z). */
function brainRun(seed, setup, step, seconds) {
  const planner = W.createPlanner({ clock: () => 0, hWeight: PATH_H_WEIGHT });
  const brain = new Brain({ maxEnemies: 6, seed, difficulty: 'realistic' });
  brain.attach(W, planner);
  const p = { head: { x: 0, y: 0, z: 0 }, torsoTop: { x: 0, y: 0, z: 0 }, torsoBottom: { x: 0, y: 0, z: 0 }, alive: true };
  const place = (x, z) => {
    const fy = W.floorY(x, z);
    p.head.x = x; p.head.y = fy + 1.6; p.head.z = z;
    p.torsoTop.x = x; p.torsoTop.y = fy + 1.4; p.torsoTop.z = z;
    p.torsoBottom.x = x; p.torsoBottom.y = fy + 0.9; p.torsoBottom.z = z;
  };
  place(START.x, START.z);
  brain.update(0, p);
  brain.cover.build(W); // (in play it is built in slices over the first frames)
  setup(brain, place);
  for (let k = 0; k < seconds * 72; k++) {
    step(brain, k / 72, place);
    W.update(1 / 72, k * 14);
    brain.update(1 / 72, p);
  }
  return brain;
}

test('room clearing: hidden defenders keep still until they see the player, then fight from cover without leaving their room', () => {
  let H = [];
  const moved = [];
  const b = brainRun(5, (brain) => {
    let s = 9;
    H = planHides(W, brain.cover, START.x, START.z, 6, () => { s = (s * 69069 + 1) >>> 0; return s / 4294967296; });
    H.forEach((h, i) => { brain.spawn(i, h.x, h.z, h.yaw); brain.setAmbush(i, h.room, h.cover); });
  }, (brain, t) => {
    // the player stays in the bedroom for 5 s: nobody moves
    if (t > 0 && t < 5) for (let i = 0; i < H.length; i++) moved[i] = Math.max(moved[i] || 0, Math.hypot(brain.agents[i].x - H[i].x, brain.agents[i].z - H[i].z));
  }, 5);
  assert.ok(H.length >= 2);
  for (let i = 0; i < H.length; i++) {
    assert.ok(moved[i] < 0.05, `defender ${i} moved ${moved[i]} m while the player was away`);
    assert.equal(b.agents[i].aware, false);
    assert.equal(b.agents[i].fire, false);
  }
  // now the player walks into the first defender's room, 3.5 m from him with a clear line
  const nav = W.nav;
  let target = null, who = -1;
  for (let i = 0; i < H.length && !target; i++) {
    const h = H[i];
    for (let r = 2.8; r <= 6 && !target; r += 0.3) for (let a = 0; a < 36 && !target; a++) {
      const x = h.x + Math.sin(a / 36 * Math.PI * 2 + h.yaw) * r, z = h.z + Math.cos(a / 36 * Math.PI * 2 + h.yaw) * r;
      if (nav.isWalkable(x, z) && W.roomAt(x, z) === h.room && W.segmentClear(h.x, W.floorY(h.x, h.z) + 1.6, h.z, x, W.floorY(x, z) + 1.4, z)) { target = { x, z }; who = i; }
    }
  }
  assert.ok(target, 'a place in his room in his sight');
  let shots = 0, left = 0, aware = 0;
  brainRun(5, (brain, place) => {
    H.forEach((q, i) => { brain.spawn(i, q.x, q.z, q.yaw); brain.setAmbush(i, q.room, q.cover); });
    place(target.x, target.z);
  }, (brain) => {
    for (let i = 0; i < H.length; i++) {
      const a = brain.agents[i];
      if (a.fire) shots++;
      if (W.roomAt(a.x, a.z) !== H[i].room && W.roomAt(a.x, a.z) !== 0) left++;
    }
    if (brain.agents[who].aware) aware = 1;
  }, 8);
  assert.equal(aware, 1, 'he saw the player come in');
  assert.ok(shots > 0, 'and fired');
  assert.equal(left, 0, 'no defender left his room');
});

test('a hit staggers him along the round; walls still stop him', () => {
  let x0 = 0, z0 = 0;
  const b = brainRun(2, (brain) => {
    const C = brain.cover;
    // somewhere open in the living room
    const nav = W.nav;
    let c = -1;
    for (let i = 0; i < nav.count && c < 0; i++) if ((nav.flags[i] & NAV_WALK) && nav.clr[i] > 1.0) c = i;
    assert.ok(c >= 0 && C.count > 0);
    x0 = nav.centerX(c); z0 = nav.centerZ(c);
    brain.spawn(0, x0, z0, 0);
    brain.hit(0, 1, 1, 0);
  }, () => {}, 0.5);
  const a = b.agents[0];
  assert.ok(a.x - x0 > 0.08, `pushed ${(a.x - x0).toFixed(3)} m along +x`);
  assert.ok(W.nav.isWalkable(a.x, a.z));
  assert.ok(b.stats.staggers === 1);
});

test('survival on this house: men take real cover and peek; one advances while the others hold', () => {
  const b = brainRun(11, (brain) => {
    const sp = W.spawner;
    let k = 0;
    for (let c = 0; c < sp.count && k < 4; c += 37) { brain.spawn(k++, sp.x[c], sp.z[c], 0); }
  }, () => {}, 40);
  assert.ok(b.stats.coverGoals > 0, JSON.stringify(b.stats));
  assert.ok(b.stats.deferred > 0, 'someone waited for a mate to finish his move');
  for (const a of b.agents) if (a.alive) assert.ok(W.nav.isWalkable(a.x, a.z));
  assert.ok(b.agents.every((a) => !a.alive || a.state !== ST.DEAD));
});
