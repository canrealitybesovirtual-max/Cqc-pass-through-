/**
 * PhysicsWorld with the vendored Rapier on the fixture house (planes-only
 * colliders) and a synthetic scanned bed (oriented lumpy trimesh with
 * FIX_INTERNAL_EDGES and backstops): drops settle at the right height on the
 * bed, table, couch and floor; no tunnelling at 9 m/s; sleep; the fixed step
 * and its cap; interpolation; the NaN guard; deferred removal; penetration-
 * safe placement; the lost-object net; determinism; step cost; and zero
 * allocation while everything rests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { loadRapier } from '../../src/physics/Rapier.js';
import { PhysicsWorld, PHYS, ReleaseInfo, ST_FREE, ST_MOVING, ST_RESTING, ST_LOST, PLACE_FREE, PLACE_HISTORY, PLACE_LIFT } from '../../src/physics/PhysicsWorld.js';
import { PoseHistory } from '../../src/physics/PoseHistory.js';
import { staticFromLayout, SURF, STATIC, ROLE } from '../../src/physics/StaticGeometry.js';
import { K_GLOCK, K_GLOCK_NOMAG, K_AKM, K_MAG9, K_MAG762, MASK_GUNS, MASK_MAGS } from '../../src/physics/ItemShapes.js';
import { kinds, houseWorld, houseStatics, scannedBed, HOUSE } from './physics.fixtures.js';
import { cpuNow } from './cpuclock.js';

const { R } = await loadRapier();
const KINDS = kinds();
const DT = 1 / 72;

/** A physics world with every kind and the fixture house built. */
function world(geo = houseStatics()) {
  const P = new PhysicsWorld(R);
  for (const k of KINDS) assert.ok(P.defineKind(k.kind, k.def), `kind ${k.def.name}`);
  P.beginStatic(geo);
  let n = 0;
  while (!P.buildSlice(4)) assert.ok(++n < 100, 'the build ends');
  assert.ok(P.ready);
  return P;
}
const run = (P, secs, dt = DT) => { let steps = 0; for (let t = 0; t < secs - 1e-9; t += dt) steps += P.step(dt); return steps; };
/** Pose from a position and a rotation about a unit axis. */
const pose = (x, y, z, ax = 0, ay = 1, az = 0, a = 0) => {
  const l = Math.hypot(ax, ay, az) || 1, s = Math.sin(a / 2) / l;
  return Float64Array.of(x, y, z, ax * s, ay * s, az * s, Math.cos(a / 2));
};
let seed = 99;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const randQuatPose = (x, y, z) => {
  let a = rnd() - 0.5, b = rnd() - 0.5, c = rnd() - 0.5, d = rnd() - 0.5;
  const l = Math.hypot(a, b, c, d);
  return Float64Array.of(x, y, z, a / l, b / l, c / l, d / l);
};
/** Lowest point of a kind's hulls at pose p. */
function lowest(kind, p) {
  const def = KINDS.find((k) => k.kind === kind).def;
  const [qx, qy, qz, qw] = [p[3], p[4], p[5], p[6]];
  let lo = Infinity;
  for (const h of def.hulls) for (let i = 0; i < h.length; i += 3) {
    const x = h[i], y = h[i + 1], z = h[i + 2];
    // y component of q · v
    const tx = 2 * (qy * z - qz * y), tz = 2 * (qx * y - qy * x);
    const ry = y + qw * (2 * (qz * x - qx * z)) + (qz * tx - qx * tz);
    if (p[1] + ry < lo) lo = p[1] + ry;
  }
  return lo;
}

const SURFACES = {
  bed: { x: 5.6, z: -1.1, top: 0.55 - STATIC.softSink },
  table: { x: 1.4, z: -1.8, top: 0.75 },
  couch: { x: -1.5, z: -1.5, top: 0.45 - STATIC.softSink },
  floor: { x: 0.3, z: -0.6, top: 0.0 },
};

test('drops from 0.4 m in 20 orientations rest on the bed, table, couch and floor at the surface (−0.5 … +1.5 cm), asleep within 2.5 s', () => {
  const P = world();
  const o = new Float64Array(7);
  for (const [name, s] of Object.entries(SURFACES)) {
    for (const kind of name === 'table' || name === 'couch' ? [K_GLOCK, K_MAG9] : [K_GLOCK, K_AKM, K_MAG9, K_MAG762]) {
      for (let k = 0; k < 20; k++) {
        const id = P.spawn(kind, randQuatPose(s.x + (rnd() - 0.5) * 0.1, s.top + 0.4, s.z + (rnd() - 0.5) * 0.1), 0, 0, 0, 0, 0, 0);
        assert.ok(id >= 0);
        let t = 0;
        while (P.state(id) !== ST_RESTING && t < 2.5) { P.step(DT); t += DT; }
        assert.equal(P.state(id), ST_RESTING, `${name} kind ${kind} #${k} asleep within 2.5 s`);
        P.pose(id, o);
        const lo = lowest(kind, o);
        assert.ok(lo > s.top - 0.005 && lo < s.top + 0.015, `${name} kind ${kind} #${k}: lowest point ${lo.toFixed(4)} vs surface ${s.top}`);
        const surf = P.landSurf(id);
        assert.equal(surf, name === 'bed' || name === 'couch' ? SURF.SOFT : name === 'table' ? SURF.HARD : SURF.FLOOR, `${name}: surface class`);
        P.remove(id);
      }
    }
  }
  assert.equal(P.failed, false);
});

test('a gun with its centre of mass beyond the table edge falls off; one with it inside stays', () => {
  const P = world();
  const o = new Float64Array(7);
  const edge = 1.4 + 0.6;   // the table's +x edge
  // lying on its side (rotated 90° about the bore axis), bore along z
  const results = [];
  for (const dx of [-0.05, 0.06]) {
    const p = pose(edge + dx, 0.75 + 0.03, -1.8, 0, 0, 1, Math.PI / 2);
    const id = P.spawn(K_GLOCK, p, 0, 0, 0, 0, 0, 0);
    run(P, 2.5);
    P.pose(id, o);
    results.push(o[1]);
    P.remove(id);
  }
  assert.ok(results[0] > 0.74, `centre 5 cm inside the edge stays on the table: y ${results[0].toFixed(3)}`);
  assert.ok(results[1] < 0.1, `centre 6 cm beyond the edge falls to the floor: y ${results[1].toFixed(3)}`);
});

test('50 throws at 4, 9 and 15 m/s into the walls: nothing tunnels (inside the house, never below the floor)', () => {
  const P = world();
  const B = houseWorld().layout.bounds;
  const o = new Float64Array(7);
  let n = 0;
  for (const v of [4, 9, 15]) {
    for (let k = 0; k < 17; k++, n++) {
      const kind = [K_GLOCK, K_AKM, K_MAG9, K_MAG762][k % 4];
      // toward the solid south (z = 1) and west (x = −2) walls of the living room
      const south = k % 2 === 0, a = (rnd() - 0.5) * 0.8;
      const dx = south ? Math.sin(a) : -Math.cos(a), dz = south ? Math.cos(a) : Math.sin(a);
      const id = P.spawn(kind, randQuatPose(south ? 0.5 : -0.3, 1.2, south ? -0.6 : -0.6), v * dx, 0.5, v * dz, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20);
      run(P, 2.5);
      P.pose(id, o);
      assert.ok(o[0] > B.x0 - 0.05 && o[0] < B.x1 + 0.05 && o[2] > B.z0 - 0.05 && o[2] < B.z1 + 0.05, `throw ${n} at ${v} m/s ends inside: ${o[0].toFixed(2)}, ${o[2].toFixed(2)}`);
      assert.ok(o[1] > -0.02, `throw ${n} never below the floor: y ${o[1].toFixed(3)}`);
      P.remove(id);
    }
  }
  assert.ok(n >= 50);
});

test('sleep: every item rests within 3 s; then step() does nothing (no steps, no Rapier call)', () => {
  const P = world();
  const ids = [];
  ids.push(P.spawn(K_GLOCK, randQuatPose(5.6, 1.0, -1.1), 0.3, 0, 0, 2, 1, 0));
  ids.push(P.spawn(K_AKM, randQuatPose(0.3, 1.1, -0.6), 0, 0, 0.4, 0, 3, 0));
  ids.push(P.spawn(K_MAG9, randQuatPose(1.4, 1.0, -1.8), 0, -1, 0, 5, 0, 0));
  ids.push(P.spawn(K_MAG762, randQuatPose(-1.5, 0.8, -1.5), 0, 0, 0, 0, 0, 0));
  run(P, 3);
  for (const id of ids) assert.equal(P.state(id), ST_RESTING);
  assert.equal(P.awake, 0);
  const s0 = P.stats.steps;
  for (let i = 0; i < 100; i++) assert.equal(P.step(DT), 0);
  assert.equal(P.stats.steps, s0);
  // an impulse wakes one; it settles again
  P.impulse(ids[0], 5.6, 0.6, -1.1, 0.5, 0.8, 0);
  assert.equal(P.state(ids[0]), ST_MOVING);
  run(P, 3);
  assert.equal(P.state(ids[0]), ST_RESTING);
});

test('fixed 1/90 s step: 72 Hz frames take 90 steps a second; a 100 ms hitch takes at most 3; the display interpolates', () => {
  const P = world();
  const id = P.spawn(K_GLOCK, pose(0.3, 2.0, -0.6), 0, 0, 0, 0, 0, 0);
  let steps = 0;
  for (let i = 0; i < 72; i++) steps += P.step(1 / 72);
  assert.ok(steps >= 89 && steps <= 90, `${steps} steps in 72 frames`);
  const d0 = P.stats.dropped;
  assert.equal(P.step(0.1), PHYS.maxSteps, 'capped');
  assert.equal(P.stats.dropped, d0 + 1, 'the rest of the hitch is dropped');
  // interpolation: the display pose lies between the last two steps
  const o = new Float64Array(7);
  P.step(0.004);   // less than a step: no step, alpha grows
  P.pose(id, o);
  const k = (id & 0xff) * 7, y0 = P.prev[k + 1], y1 = P.cur[k + 1];
  assert.ok(P.alpha > 0 && P.alpha < 1, `alpha ${P.alpha}`);
  assert.ok((o[1] - y0) * (o[1] - y1) <= 1e-12, 'between prev and cur');
  assert.ok(Math.abs(o[1] - (y0 + (y1 - y0) * P.alpha)) < 1e-9);
});

test('NaN guard: bad inputs never reach Rapier; a non-finite read-back is removed and counted lost; physics keeps running', () => {
  const P = world();
  assert.equal(P.spawn(K_GLOCK, Float64Array.of(NaN, 1, 0, 0, 0, 0, 1), 0, 0, 0, 0, 0, 0), -1);
  assert.equal(P.spawn(K_GLOCK, pose(0, 1, 0), Infinity, 0, 0, 0, 0, 0), -1);
  assert.equal(P.spawn(K_GLOCK, Float64Array.of(0, 1, 0, 0, 0, 0, 0), 0, 0, 0, 0, 0, 0), -1, 'zero quaternion');
  assert.equal(P.spawn(99, pose(0, 1, 0), 0, 0, 0, 0, 0, 0), -1, 'unknown kind');
  assert.ok(P.guard.rejected >= 4);
  const a = P.spawn(K_GLOCK, pose(0.3, 1.0, -0.6), 0, 0, 0, 0, 0, 0);
  const b = P.spawn(K_MAG9, pose(0.6, 1.0, -0.6), 0, 0, 0, 0, 0, 0);
  P.step(DT);
  P.impulse(a, NaN, 0, 0, 1, 0, 0);
  P.impulse(a, 0, 0, 0, NaN, 0, 0);
  // the body reads back non-finite (as after a solver blow-up)
  const body = P.bodies[a & 0xff];
  body.translation = () => ({ x: NaN, y: 0, z: 0 });
  const nBodies = P.world.bodies.len();
  P.step(DT);
  assert.equal(P.state(a), ST_LOST);
  assert.equal(P.guard.nan, 1);
  assert.equal(P.failed, false);
  P.step(DT);
  assert.equal(P.world.bodies.len(), nBodies - 1, 'removed at the next flush');
  assert.ok(P.state(b) === ST_MOVING || P.state(b) === ST_RESTING, 'the others go on');
  P.remove(a);
  run(P, 2);
  assert.equal(P.state(b), ST_RESTING);
});

test('deferred removal: the id dies at once, the body goes at the next step; stale ids are ignored; a removed spawn never exists', () => {
  const P = world();
  const ids = [0, 1, 2].map((i) => P.spawn(K_MAG9, pose(0.3 + i * 0.2, 0.5, -0.6), 0, 0, 0, 0, 0, 0));
  P.step(DT);
  const n0 = P.world.bodies.len();
  P.remove(ids[1]);
  assert.equal(P.state(ids[1]), ST_FREE);
  assert.equal(P.world.bodies.len(), n0, 'still in Rapier until the next step');
  P.remove(ids[1]);   // double removal: harmless
  P.impulse(ids[1], 0, 0, 0, 1, 0, 0);
  assert.equal(P.readPose(ids[1], new Float64Array(7)), false);
  P.step(DT);
  assert.equal(P.world.bodies.len(), n0 - 1);
  // the slot is reused with a new generation: the old id stays dead
  const c = P.spawn(K_MAG9, pose(1, 0.5, -0.6), 0, 0, 0, 0, 0, 0);
  assert.equal(c & 0xff, ids[1] & 0xff);
  assert.notEqual(c, ids[1]);
  assert.equal(P.state(ids[1]), ST_FREE);
  assert.ok(P.guard.stale >= 2);
  // removed before its first step: never created
  const d = P.spawn(K_MAG9, pose(1.2, 0.5, -0.6), 0, 0, 0, 0, 0, 0);
  P.remove(d);
  const n1 = P.world.bodies.len();
  P.step(DT);
  assert.equal(P.world.bodies.len(), n1 + 1, 'only c was created');
  P.clear();
  P.step(DT);
  assert.equal(P.world.bodies.len(), 1, 'only the fixed body is left');
});

test('release: free in the air, stepped back through the history when released 3 cm inside the bed, lifted without a history; set-down has no velocity', () => {
  const P = world();
  const out = new ReleaseInfo(), o = new Float64Array(7);
  const top = SURFACES.bed.top;
  // a hand coming down onto the bed and pushing the gun 3 cm in
  const h = new PoseHistory();
  const flat = pose(5.6, 0, -1.1, 0, 0, 1, Math.PI / 2);   // lying on its side: 1.6 cm half thickness
  const half = 0.016;
  for (let i = 0; i < 20; i++) h.pushPQ(i / 72, 5.6, top + half + 0.25 - i * 0.0145, -1.1, flat[3], flat[4], flat[5], flat[6]);
  const inside = Float64Array.from(flat); inside[1] = top + half - 0.03;
  const a = P.release(K_GLOCK_NOMAG, inside, h, out, -1);
  assert.equal(out.mode, PLACE_HISTORY);
  assert.ok(a >= 0);
  P.pose(a, o);
  let lo = lowest(K_GLOCK_NOMAG, o);
  assert.ok(lo > top - 0.002 && lo < top + 0.015, `placed on top: lowest ${lo.toFixed(4)} vs ${top}`);
  run(P, 2.5);
  P.pose(a, o);
  lo = lowest(K_GLOCK_NOMAG, o);
  assert.ok(lo > top - 0.005 && lo < top + 0.015, `rests on the bed, not sunk: ${lo.toFixed(4)}`);
  // no history, 4 cm deep: lifted from above
  inside[0] = 5.2; inside[1] = top + half - 0.04;
  const b = P.release(K_GLOCK_NOMAG, inside, null, out, -1);
  assert.equal(out.mode, PLACE_LIFT);
  assert.equal(out.setDown, true, 'no history: no velocity');
  P.pose(b, o);
  assert.ok(lowest(K_GLOCK_NOMAG, o) > top - 0.002);
  // free in the air, thrown: keeps the hand's velocity
  const t = new PoseHistory();
  for (let i = 0; i < 10; i++) t.pushPQ(i / 72, 0.3 + (4 * i) / 72, 1.2, -0.6, 0, 0, 0, 1);
  const c = P.release(K_MAG9, pose(0.3 + 4 * 9 / 72, 1.2, -0.6), t, out, 12);
  assert.equal(out.mode, PLACE_FREE);
  assert.equal(out.setDown, false);
  assert.ok(Math.abs(out.lin - 4) < 0.5, `thrown at ${out.lin}`);
  assert.equal(P.roundsOf(c), 12, 'a magazine keeps its rounds');
  // gapBelow: a gun 2 cm over the table sees it, one 20 cm over does not
  const g = pose(1.4, 0.75 + half + 0.02, -1.8, 0, 0, 1, Math.PI / 2);
  const gap = P.gapBelow(K_GLOCK_NOMAG, g);
  assert.ok(gap > 0.012 && gap < 0.03, `gap ${gap}`);
  g[1] = 0.95;
  assert.equal(P.gapBelow(K_GLOCK_NOMAG, g), Infinity);
  assert.equal(P.stats.history, 1);
  assert.equal(P.stats.lifted, 1);
});

test('scanned bed (oriented lumpy trimesh, FIX_INTERNAL_EDGES, backstops): drops rest on the lumps; a release inside is placed on top; one under the mesh is lifted back', () => {
  const bed = scannedBed();
  const W = houseWorld();
  const geo = staticFromLayout(W.layout, { snapshot: HOUSE, mesh: { vertices: bed.vertices, indices: bed.indices, oneSided: true } });
  const S = STATIC.slabStride;
  let back = 0;
  for (let i = 0; i < geo.slabCount; i++) if (geo.slabs[i * S + 9] === ROLE.BACKSTOP) back++;
  assert.equal(back, 2, 'the covered bed: top slab and volume become backstops');
  const P = world(geo);
  assert.equal(P.buildStats.oneSided, true);
  assert.ok(P.buildStats.chunks >= 2 && P.buildStats.tris === bed.indices.length / 3);
  const o = new Float64Array(7);
  for (let k = 0; k < 10; k++) {
    const x = bed.cx + (rnd() - 0.5) * 1.2, z = bed.cz + (rnd() - 0.5) * 0.9;
    const id = P.spawn(K_GLOCK, randQuatPose(x, 1.0, z), 0, 0, 0, 0, 0, 0);
    run(P, 2.5);
    assert.equal(P.state(id), ST_RESTING);
    P.pose(id, o);
    const lo = lowest(K_GLOCK, o), s = bed.surface(o[0], o[2]);
    assert.ok(lo > s - 0.03 && lo < s + 0.03, `#${k}: lowest ${lo.toFixed(3)} on the lumpy top near ${s.toFixed(3)}`);
    assert.ok(lo > bed.top - 0.03 - 0.005, 'never on the backstop');
    P.remove(id);
  }
  // released 3 cm inside the mesh with a history from above: on top
  const out = new ReleaseInfo(), h = new PoseHistory();
  const x = 5.5, z = -1.0, s = bed.surface(x, z), flat = pose(x, 0, z, 0, 0, 1, Math.PI / 2);
  for (let i = 0; i < 20; i++) h.pushPQ(i / 72, x, s + 0.3 - i * 0.016, z, flat[3], flat[4], flat[5], flat[6]);
  const inside = Float64Array.from(flat); inside[1] = s + 0.016 - 0.03;
  const a = P.release(K_GLOCK_NOMAG, inside, h, out, -1);
  run(P, 2.5);
  P.pose(a, o);
  assert.ok(lowest(K_GLOCK_NOMAG, o) > s - 0.025, `placed on top, not sunk: ${lowest(K_GLOCK_NOMAG, o).toFixed(3)} vs ${s.toFixed(3)}`);
  P.remove(a);
  // dropped between the one-sided top and the backstop (as if it fell through): lifted back on top
  const fixed0 = P.stats.insideFixed;
  const c = P.spawn(K_GLOCK_NOMAG, pose(5.6, bed.top - STATIC.backInset + 0.016 + 0.003, -1.1, 0, 0, 1, Math.PI / 2), 0, 0, 0, 0, 0, 0);
  run(P, 3);
  P.pose(c, o);
  assert.equal(P.stats.insideFixed, fixed0 + 1, 'resting on the backstop was noticed');
  assert.ok(lowest(K_GLOCK_NOMAG, o) > bed.surface(o[0], o[2]) - 0.025, `back on top: ${o[1].toFixed(3)}`);
  assert.equal(P.state(c), ST_RESTING);
});

test('lost-object net: an item outside the house (on the catch slab beyond a door) is lost after 10 s; one inside never', () => {
  const P = world();
  const out = P.spawn(K_MAG9, pose(0, 0.5, 4.0), 0, 0, 0, 0, 0, 0);   // 3 m beyond the south wall
  const inside = P.spawn(K_MAG9, pose(0.3, 0.5, -0.6), 0, 0, 0, 0, 0, 0);
  run(P, 9.4);
  assert.equal(P.state(out), ST_RESTING, 'not before 10 s');
  run(P, 1.2);
  assert.equal(P.state(out), ST_LOST);
  assert.equal(P.state(inside), ST_RESTING);
  assert.equal(P.stats.lost, 1);
});

test('determinism: the same releases give bit-identical poses', () => {
  const poses = [];
  for (let r = 0; r < 2; r++) {
    const P = world();
    seed = 4242;
    const ids = [];
    for (let k = 0; k < 6; k++) ids.push(P.spawn([K_GLOCK, K_AKM, K_MAG9][k % 3], randQuatPose(0.3 + k * 0.3, 1.2, -0.6), rnd() - 0.5, 0, rnd() - 0.5, rnd() * 4, rnd() * 4, 0));
    run(P, 2);
    const o = new Float64Array(7), all = [];
    for (const id of ids) { P.pose(id, o); all.push(...o); }
    poses.push(all);
    P.dispose();
  }
  assert.deepEqual(poses[0], poses[1]);
});

test('landing: a magazine dropped 1 m onto the floor reports one landing (≥ 1.1 m/s) on the floor; on the bed it is soft and damped', () => {
  const P = world();
  const id = P.spawn(K_MAG9, pose(0.3, 1.0, -0.6), 0, 0, 0, 0, 0, 0);
  let maxDv = 0, hits = 0, prev = 0;
  for (let i = 0; i < 150; i++) {
    P.step(DT);
    const dv = P.landing(id);
    if (dv >= 1.1 && prev < 1.1) hits++;
    prev = dv;
    if (dv > maxDv) maxDv = dv;
  }
  assert.ok(maxDv >= 1.1, `impact ${maxDv}`);
  assert.ok(hits >= 1 && hits <= 2, `landings ${hits}`);
  assert.equal(P.landSurf(id), SURF.FLOOR);
  const b = P.spawn(K_MAG9, pose(5.6, 1.0, -1.1), 0, 0, 0, 0, 0, 0);
  run(P, 1.5);
  assert.equal(P.landSurf(b), SURF.SOFT);
  assert.equal(P.soft[b & 0xff], 1);
  assert.ok(Math.abs(P.bodies[b & 0xff].angularDamping() - PHYS.softAngDamp) < 1e-6);
});

test('pick-up: nearest by grip point or box, by kind mask; transformAll moves the items with a realign', () => {
  const P = world();
  const g = P.spawn(K_GLOCK, pose(0.3, 0.02, -0.6, 0, 0, 1, Math.PI / 2), 0, 0, 0, 0, 0, 0);
  const m = P.spawn(K_MAG9, pose(0.6, 0.02, -0.6, 0, 0, 1, Math.PI / 2), 0, 0, 0, 0, 0, 0);
  run(P, 1.5);
  const o = new Float64Array(7);
  P.pose(g, o);
  assert.equal(P.nearest(o[0], o[1] + 0.03, o[2] + 0.04, 0.13, 0.05, MASK_GUNS), g);
  assert.equal(P.nearest(o[0], o[1] + 0.03, o[2] + 0.04, 0.13, 0.05, MASK_MAGS), -1, 'masked out');
  assert.equal(P.nearest(o[0] + 1, o[1], o[2], 0.13, 0.05, MASK_GUNS), -1, 'out of reach');
  P.pose(m, o);
  assert.equal(P.nearest(o[0], o[1] + 0.02, o[2], 0.10, 0.10, MASK_MAGS), m);
  // a realign: +1 m in x and a quarter turn about y
  const c = 0, s = 1;
  P.pose(g, o);
  const x0 = o[0], z0 = o[2];
  P.transformAll([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 1, 0, 0, 1]);
  P.pose(g, o);
  assert.ok(Math.abs(o[0] - (c * x0 + s * z0 + 1)) < 1e-9 && Math.abs(o[2] - (-s * x0 + c * z0)) < 1e-9);
});

test('warm-up: a scratch world runs every pair and path, then is freed; the real world is untouched', () => {
  const P = new PhysicsWorld(R);
  for (const k of KINDS) P.defineKind(k.kind, k.def);
  const r = P.warmUp();
  assert.equal(r.ok, true);
  assert.ok(r.steps > 200, `${r.steps} steps`);
  assert.equal(P.ready, false, 'no statics yet in the real world');
  assert.equal(P.world.bodies.len(), 1, 'only the fixed body');
  assert.equal(P.stats.spawned, 0);
  assert.ok(P.report().warm.ok);
});

test('step cost (CPU): three drops under 0.3 ms a step on average; at rest under 0.02 ms a frame', () => {
  const P = world();
  // warm this world's JIT with a first round
  for (let r = 0; r < 2; r++) {
    const ids = [P.spawn(K_GLOCK, randQuatPose(5.6, 1.0, -1.1), 0, 0, 0, 1, 1, 0), P.spawn(K_AKM, randQuatPose(0.3, 1.0, -0.6), 0, 0, 0, 0, 1, 1), P.spawn(K_MAG9, randQuatPose(1.4, 1.1, -1.8), 0, 0, 0, 2, 0, 0)];
    const s0 = P.stats.steps, c0 = cpuNow();
    run(P, 2);
    const per = (cpuNow() - c0) / Math.max(1, P.stats.steps - s0);
    if (r === 1) assert.ok(per < 0.3, `three drops: ${per.toFixed(3)} ms a step`);
    if (r === 0) for (const id of ids) P.remove(id);
  }
  run(P, 2);
  assert.equal(P.awake, 0);
  const c1 = cpuNow();
  for (let i = 0; i < 20000; i++) P.step(DT);
  const rest = (cpuNow() - c1) / 20000;
  assert.ok(rest < 0.02, `at rest: ${rest.toFixed(4)} ms a frame`);
});

test('zero allocation while everything rests: 20,000 frames of step() and readPose() (sampling heap profiler)', async () => {
  const P = world();
  const ids = [P.spawn(K_GLOCK, randQuatPose(5.6, 1.0, -1.1), 0, 0, 0, 0, 0, 0), P.spawn(K_MAG9, randQuatPose(0.3, 1.0, -0.6), 0, 0, 0, 0, 0, 0)];
  run(P, 3);
  assert.equal(P.awake, 0);
  const o = new Float64Array(7), m = new Float32Array(16);
  const loop = (n) => { for (let i = 0; i < n; i++) { P.step(DT); for (const id of ids) { P.readPose(id, o, 0); P.readMatrix(id, m, 0); P.landing(id); P.state(id); } P.nearest(0.3, 0.1, -0.6, 0.13, 0.05, MASK_MAGS); } };
  loop(5000);
  let best = Infinity, by = null;
  for (let r = 0; r < 5 && best > 0; r++) {
    globalThis.gc?.();
    loop(2000);
    const ses = new Session();
    ses.connect();
    await ses.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(20000);
    const { profile } = await ses.post('HeapProfiler.stopSampling');
    ses.disconnect();
    const b = {};
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && (u.endsWith('/src/physics/PhysicsWorld.js') || u.endsWith('/vendor/rapier/rapier.mjs') || u.endsWith('/src/physics/StaticGeometry.js'))) {
        const k = `${u.split('/').pop()}:${n.callFrame.functionName}:${n.callFrame.lineNumber + 1}`;
        b[k] = (b[k] || 0) + n.selfSize;
      }
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  assert.equal(best, 0, JSON.stringify(by));
});

test('v0.6 rebuild: the old static colliders stay until the new ones exist, then go in slices; a rested gun stays put', () => {
  const P = world();
  const n0 = P.staticCols.length, total0 = P.world.colliders.len();
  // a rebuild of the same house: old and new stand together until the new build is complete
  let calls = 0;
  P.beginStatic(houseStatics());
  assert.equal(P.ready, false);
  assert.ok(P._oldCols.length === n0 && P.staticCols.length === 0);
  let both = false;
  while (!P.buildSlice(0.05)) { calls++; if (P._oldCols.length && P.staticCols.length === n0) both = true; assert.ok(calls < 10000); }
  assert.ok(both, 'there was a frame with the new set complete and the old one not yet removed');
  assert.ok(calls > 1, 'the removal took its own slices');
  assert.equal(P._oldCols.length, 0);
  assert.equal(P.staticCols.length, n0);
  assert.equal(P.world.colliders.len(), total0, 'no collider leaked');
  assert.equal(P.staticInfo.size, n0, 'the surface table holds the new set only');
});

test('v0.6 learned rebuild (keepOld): items keep stepping on the previous set while the new one is built', () => {
  const P = world();
  const out = new Float64Array(7);
  P.beginStatic(houseStatics(), true);
  assert.equal(P.ready, false);
  assert.equal(P.usable, true);
  // a gun dropped onto the table mid-rebuild lands on it (the old table still stands)
  const T = HOUSE.planes.find((p) => p.label === 'table');
  const ty = T.pose[13];
  const id = P.spawn(K_GLOCK, pose(T.pose[12], ty + 0.3, T.pose[14], 0, 0, 1, Math.PI / 2), 0, 0, 0, 0, 0, 0);
  assert.ok(id >= 0);
  for (let t = 0; t < 4 && P.state(id) !== ST_RESTING; t += DT) { P.step(DT); P.buildSlice(0.02); }
  P.pose(id, out, 0);
  assert.ok(out[1] > ty - 0.01 && out[1] < ty + 0.06, `on the table at ${out[1].toFixed(3)} (top ${ty})`);
  // without keepOld (a realign) nothing steps until the new set exists
  const Q = world();
  Q.beginStatic(houseStatics());
  assert.equal(Q.usable, false);
  assert.equal(Q.step(DT), 0);
});
