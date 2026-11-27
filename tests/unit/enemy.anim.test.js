// Procedural enemy animation (src/enemies/Animator.js, Rig.js) on the real
// soldier skeleton read from assets/models/soldier.glb's JSON chunk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RigDef, jointsFromGltfJson, B, CORE_COUNT } from '../../src/enemies/Rig.js';
import { Animator } from '../../src/enemies/Animator.js';
import { Q, V3 } from '../../src/enemies/math.js';

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}
const rig = loadRig();
const DT = 1 / 72;

test('rig: 22 core bones, chains, fingers, twists from the manifest joints', () => {
  assert.equal(rig.names.length, CORE_COUNT);
  assert.equal(rig.names[B.pelvis], 'pelvis_02');
  assert.equal(rig.names[B.ballL], 'ball_l_062');
  assert.equal(rig.fingers.length, 30);
  assert.equal(rig.twists.length, 8);
  assert.ok(Math.abs(rig.len.upperArm - 0.3034) < 1e-3 && Math.abs(rig.len.thigh - 0.4257) < 1e-3);
  assert.ok(Math.abs(rig.pelvisY - 0.973) < 1e-3 && Math.abs(rig.ankleY - 0.14) < 1e-3);
});

test('FK with identity deltas reproduces the bind pose exactly', () => {
  const a = new Animator(rig, 1);
  a.mq[B.pelvis].copy(rig.restModelQ[B.pelvis]);
  a.mp[B.pelvis].copy(rig.restModelP[B.pelvis]);
  const I = new Q();
  let err = 0;
  for (let b = 1; b < CORE_COUNT; b++) {
    a.fkDelta(b, I);
    err = Math.max(err, a.mp[b].distanceTo(rig.restModelP[b]), 1 - Math.abs(a.mq[b].dot(rig.restModelQ[b])));
  }
  a.writeLocals();
  for (let b = 0; b < CORE_COUNT; b++) err = Math.max(err, 1 - Math.abs(a.lq[b].dot(rig.restLocalQ[b])));
  err = Math.max(err, a.pelvisLocal.distanceTo(rig.restLocalT[B.pelvis]));
  assert.ok(err < 1e-9, `rest error ${err}`);
});

/** World position of a model point. */
const world = (a, m) => a.toWorld(m, new V3());

test('standing: feet on the floor, hands on the rifle', () => {
  for (const raise of [0, 1]) {
    const a = new Animator(rig, 2);
    a.reset(1, 0.2, -3, 0.7);
    a.aimX = 1 + Math.sin(0.7) * 6; a.aimY = 1.6; a.aimZ = -3 + Math.cos(0.7) * 6;
    a.raiseTarget = raise;
    for (let i = 0; i < 90; i++) a.update(DT);
    for (const f of [B.footL, B.footR]) assert.ok(Math.abs(a.mp[f].y - rig.ankleY) < 0.005, `ankle ${f} at ${a.mp[f].y}`);
    // right hand exactly on the grip (the rifle is placed from the hand)
    const R = rig.rifle;
    const grip = new V3().copy(R.inHandP).applyQ(new Q().mulConj(a.rifleQ, R.inHandQ)).scale(-1).add(a.rifleP);
    assert.ok(grip.distanceTo(a.mp[B.handR]) < 1e-6, 'right hand holds the grip');
    // left wrist at the handguard: the palm is under the support point, the wrist
    // 7 cm from it (this model's arms are short: up to 3 cm more at low ready)
    const sup = new V3().copy(R.support).applyQ(a.rifleQ).add(a.rifleP);
    const dl = sup.distanceTo(a.mp[B.handL]);
    assert.ok(dl > 0.06 && dl < 0.105, `left wrist ${dl.toFixed(3)} m from the support point (raise ${raise})`);
    // nothing below the floor, head at a standing height
    assert.ok(a.mp[B.head].y > 1.5 && a.mp[B.head].y < 1.7, `head at ${a.mp[B.head].y}`);
  }
});

test('aimed: the bore points at the target', () => {
  for (const [tx, ty, tz] of [[0, 1.5, 6], [2, 2.5, 4], [-3, 0.8, 5]]) {
    const a = new Animator(rig, 4);
    a.reset(0, 0, 0, Math.atan2(tx, tz));
    a.aimX = tx; a.aimY = ty; a.aimZ = tz;
    a.raiseTarget = 1;
    for (let i = 0; i < 120; i++) a.update(DT);
    const p = new V3(), d = new V3();
    a.muzzle(p, d);
    const want = new V3(tx - p.x, ty - p.y, tz - p.z).normalize();
    const ang = Math.acos(Math.min(1, d.dot(want)));
    assert.ok(ang < 0.03, `bore off by ${ang.toFixed(3)} rad at (${tx}, ${ty}, ${tz})`);
    // the sight line runs from the eye: the eye is behind and above the bore
    assert.ok(a._eye.y > p.y - 0.1, 'rifle at eye level');
  }
});

test('walking: planted feet never slide, steps alternate, cadence by speed', () => {
  for (const speed of [0.6, 1.25]) {
    const a = new Animator(rig, 5);
    a.reset(0, 0, 0, 0);
    let x = 0, t = 0, last = -1, steps = 0, alt = true, minAnkle = Infinity, maxSlide = 0;
    const prev = [new V3(), new V3()], was = [true, true];
    const times = [];
    for (let i = 0; i < 72 * 5; i++) {
      t += DT; x += speed * DT;
      a.rootX = 0; a.rootZ = x; a.vx = 0; a.vz = speed;
      a.aimX = 0; a.aimY = 1; a.aimZ = x + 6;
      a.update(DT);
      for (let f = 0; f < 2; f++) {
        const ft = a.feet[f];
        const p = new V3(ft.px, 0, ft.pz);
        if (ft.planted && was[f] && i > 0) maxSlide = Math.max(maxSlide, p.distanceTo(prev[f]));
        prev[f].copy(p);
        was[f] = ft.planted;
        if (a.stepEvents & (1 << f)) {
          steps++;
          if (f === last) alt = false;
          last = f;
          times.push(t);
        }
      }
      minAnkle = Math.min(minAnkle, a.mp[B.footL].y, a.mp[B.footR].y);
    }
    assert.ok(maxSlide < 1e-9, `a planted foot moved ${maxSlide} m`);
    assert.ok(alt, 'feet alternate');
    const period = (times[times.length - 1] - times[2]) / (times.length - 3);
    const expected = Math.min(0.7, Math.max(0.34, (0.3 + 0.26 * speed) / speed));
    assert.ok(Math.abs(period - expected) < 0.05, `step period ${period.toFixed(3)} s at ${speed} m/s (expected ${expected.toFixed(3)})`);
    assert.ok(steps >= 6, `${steps} steps`);
    assert.ok(minAnkle > rig.ankleY - 0.06, `ankle never sinks: ${minAnkle}`);
    // the feet keep up with the body
    const mid = (a.feet[0].pz + a.feet[1].pz) / 2;
    assert.ok(Math.abs(mid - x) < 0.6, `feet ${mid.toFixed(2)} vs body ${x.toFixed(2)}`);
  }
});

test('turning on the spot steps the feet round, then they settle', () => {
  const a = new Animator(rig, 6);
  a.reset(0, 0, 0, 0);
  let steps = 0;
  for (let i = 0; i < 72 * 3; i++) {
    a.rootYaw = Math.min(1, i / 72) * 1.6;
    a.aimX = Math.sin(a.rootYaw) * 5; a.aimZ = Math.cos(a.rootYaw) * 5;
    a.update(DT);
    if (a.stepEvents) steps++;
  }
  assert.ok(steps >= 3, `${steps} steps to turn 92°`);
  assert.equal(a.gaitOn, false, 'gait stops when the feet are back under him');
  for (const ft of a.feet) {
    const d = Math.abs(((ft.yaw - 1.6 + Math.PI) % (2 * Math.PI)) - Math.PI);
    assert.ok(d < 0.35, `foot yaw ${ft.yaw.toFixed(2)} follows the body`);
  }
});

/** Lowest body point (head, chest, hips) minus its radius, world y. */
function lowest(a) {
  const P = a.mp;
  return Math.min(P[B.head].y - 0.08, P[B.spine3].y - 0.13, P[B.pelvis].y - 0.11) + a.rootY;
}

test('death: falls away from the shot and ends lying ON the floor', () => {
  const cases = [[0, -1, false], [0, 1, false], [1, 0.2, false], [-0.7, -0.7, false], [0, -1, true], [0.3, 1, true]];
  for (let k = 0; k < cases.length; k++) {
    const [dx, dz, head] = cases[k];
    const a = new Animator(rig, 10 + k);
    a.reset(2, 0.05, 1, 0.4);
    a.aimX = 2 + Math.sin(0.4) * 5; a.aimY = 1.4; a.aimZ = 1 + Math.cos(0.4) * 5;
    a.raiseTarget = 1;
    for (let i = 0; i < 60; i++) a.update(DT);
    const p0 = world(a, a.mp[B.pelvis]);
    a.die(dx, dz, head);
    let minLow = Infinity, landedAt = -1;
    for (let i = 0; i < 72 * 3.5; i++) {
      a.update(DT);
      minLow = Math.min(minLow, lowest(a));
      if (a.landEvent) landedAt = i * DT;
    }
    const tag = `case ${k} (${dx}, ${dz}${head ? ', head' : ''})`;
    assert.ok(a.landed && a.settled, `${tag}: landed and settled`);
    assert.ok(landedAt > 0.4 && landedAt < 1.6, `${tag}: hits the floor after ${landedAt.toFixed(2)} s`);
    assert.ok(minLow > 0.05 - 0.012, `${tag}: never through the floor (${(minLow - 0.05).toFixed(3)})`);
    const low = lowest(a) - 0.05;
    assert.ok(Math.abs(low) < 0.02, `${tag}: rests on the floor (lowest point ${low.toFixed(3)} m above it)`);
    assert.ok(a.mp[B.head].y < 0.4 && a.mp[B.spine3].y < 0.4, `${tag}: lying (head ${a.mp[B.head].y.toFixed(2)})`);
    const p1 = world(a, a.mp[B.pelvis]);
    const l = Math.hypot(dx, dz);
    assert.ok(((p1.x - p0.x) * dx + (p1.z - p0.z) * dz) / l > 0.05, `${tag}: the hips moved with the shot`);
    // the rifle lies on the floor
    const R = rig.rifle;
    for (const pt of [R.muzzle, R.butt]) {
      const w = world(a, new V3().copy(pt).applyQ(a.rifleQ).add(a.rifleP));
      assert.ok(w.y > 0.05 - 0.005 && w.y < 0.05 + 0.2, `${tag}: rifle on the floor (${w.y.toFixed(3)})`);
    }
  }
});

test('hit reactions and recoil spring back; bad input never yields NaN', () => {
  const a = new Animator(rig, 20);
  a.reset(0, 0, 0, 0);
  a.raiseTarget = 1;
  for (let i = 0; i < 150; i++) a.update(DT);
  const head0 = a.mp[B.head].z;
  a.hit(0, 0, -1, 0, 1.4, 0.1, 'torso', 1);
  let moved = 0;
  for (let i = 0; i < 20; i++) { a.update(DT); moved = Math.min(moved, a.mp[B.head].z - head0); }
  assert.ok(moved < -0.02, `the shot pushes him back (${moved.toFixed(3)} m)`);
  for (let i = 0; i < 72; i++) a.update(DT);
  assert.ok(Math.abs(a.mp[B.head].z - head0) < 0.01, 'and he recovers');
  for (let i = 0; i < 30; i++) { a.recoil(); a.update(0.1); }
  a.update(NaN); a.update(-1); a.update(5);
  a.aimX = NaN;
  a.update(DT);
  a.aimX = 3;
  for (let i = 0; i < 200; i++) a.update(DT);
  for (let b = 0; b < CORE_COUNT; b++) {
    const q = a.lq[b];
    assert.ok(Number.isFinite(q.x + q.y + q.z + q.w), `bone ${b} finite`);
  }
  assert.ok(Number.isFinite(a.rifleP.x + a.rifleP.y + a.rifleP.z));
});

test('update does not allocate (walk, turn, aim, fall, lie)', () => {
  // Events (reset, recoil, hit, die) are allowed to allocate a little; frames are not.
  // So every code path is warmed with events first, then only frames are measured.
  const a = new Animator(rig, 30);
  let i = 0;
  const frame = () => {
    const ph = i % 2400;
    const sp = ph < 900 ? 1.2 : 0;
    a.rootZ += sp * DT; a.vz = sp; a.rootYaw = ph < 1200 ? 0 : 0.6;
    a.aimX = 1; a.aimY = 1.4; a.aimZ = a.rootZ + 5;
    a.raiseTarget = ph > 400 ? 1 : 0;
    a.dt = DT;
    a.tick();
    i++;
  };
  for (let c = 0; c < 6; c++) {
    a.reset(0, 0, 0, 0);
    for (let k = 0; k < 1700; k++) { if (k % 60 === 0) a.recoil(); if (k === 1500) a.hit(0, 0, -1, 0, 1.3, 0, 'torso', 1); frame(); }
    a.die(0.3, -1, false);
    for (let k = 0; k < 400; k++) frame();
  }
  // alive: least growth over three windows of 30k frames
  let grew = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    a.reset(0, 0, 0, 0);
    i = 0;
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 30000; n++) frame();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  // No object, array or closure is created per frame (one V3 per update would be
  // > 1 MB here). V8 may still box a double now and then, depending on how it
  // tiered the code (measured 0–7 B per update in Node 22), so the bar is 10 B.
  assert.ok(grew < 300_000, `heap grew ${grew} bytes over 30k alive updates`);
  // dying and lying: 20 falls of 300 frames, the die() calls outside the measurement
  let dead = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    let sum = 0;
    globalThis.gc?.();
    for (let f = 0; f < 20; f++) {
      a.reset(0, 0, 0, 0);
      a.die((f % 5) - 2, -1, f % 3 === 0);
      const before = process.memoryUsage().heapUsed;
      for (let n = 0; n < 300; n++) frame();
      const d = process.memoryUsage().heapUsed - before;
      if (d > 0) sum += d;
    }
    dead = Math.min(dead, sum);
  }
  assert.ok(dead < 60_000, `heap grew ${dead} bytes over 6k dying / lying updates`);
});
