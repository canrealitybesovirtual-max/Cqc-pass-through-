// Allocation checks for the enemy hot paths, in their own file: node --test runs
// each file in its own process, so V8 sees only the real types here (the other
// enemy tests use fake worlds and bad inputs on purpose, which makes calls
// polymorphic and changes what V8 inlines, and so what it boxes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RigDef, jointsFromGltfJson } from '../../src/enemies/Rig.js';
import { Animator } from '../../src/enemies/Animator.js';
import { CapsuleSet, Hitbox } from '../../src/enemies/Hitbox.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { Brain } from '../../src/enemies/Brain.js';

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}
const rig = loadRig();
const DT = 1 / 72;
const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
function player(x = 0, z = 0) {
  return { head: { x, y: 1.65, z }, torsoTop: { x, y: 1.35, z }, torsoBottom: { x, y: 0.97, z }, alive: true };
}
/** A soldier standing at (x, 0, z) facing yaw, posed by the animator, and his capsules. */
function standing(x, z, yaw) {
  const a = new Animator(rig, 3);
  a.reset(x, 0, z, yaw);
  a.aimX = x + Math.sin(yaw) * 6; a.aimY = 1.4; a.aimZ = z + Math.cos(yaw) * 6;
  for (let i = 0; i < 60; i++) a.update(1 / 60);
  const h = new Hitbox(new CapsuleSet(rig));
  h.update(a);
  return { a, h };
}

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

test('per-frame work does not allocate; 10 Hz decisions stay small (house run)', () => {
  const w = new WorldCore({ seed: 9 });
  w.build(house(), { x: 0, z: 0 });
  const brain = new Brain({ maxEnemies: 6, seed: 9 });
  brain.attach(w, w.createPlanner());
  const p = player();
  const out = { x: 0, z: 0 };
  for (let i = 0; i < 4; i++) {
    w.time = i * 20;
    if (w.findSpawn(0, 0, 0, -1, 3.5, out)) brain.spawn(i, out.x, out.z, 0);
  }
  const T = new Float64Array(1); // (a closure variable holding a double would itself allocate)
  const frame = () => { T[0] += DT; w.time = T[0]; brain.update(DT, p); };
  for (let k = 0; k < 72 * 120; k++) frame();
  // with decisions (sight checks, engagement points, paths): V8 may box the numbers it
  // passes into the world's queries when it cannot inline them, so a bound per decision
  let perThink = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const thinks0 = brain.stats.thinks;
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 72 * 30; k++) frame();
    perThink = Math.min(perThink, (process.memoryUsage().heapUsed - before) / (brain.stats.thinks - thinks0));
  }
  assert.ok(perThink < 2000, `${perThink.toFixed(0)} bytes per decision`);
  // per frame: steering, movement on the nav grid, facing, aim, shot timing, slots
  for (const a of brain.agents) a.think = 1e9; // no decisions from here on
  for (let k = 0; k < 72 * 30; k++) frame(); // let V8 settle on the new mix
  // The best of up to 8 reps: until V8's concurrent compiler has re-optimised for the new mix, the
  // interim code boxes doubles (move → Math.sqrt); on a loaded machine (parallel test files, other
  // jobs) that took longer than the settle above and the first 3 reps read 35–49 KB. Allocations in
  // the optimised code show in every rep, so they still fail.
  let grew = Infinity;
  for (let rep = 0; rep < 8 && grew >= 30_000; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 72 * 30; k++) frame();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 30_000, `per-frame work: heap grew ${grew} bytes over 30 s of 4 enemies`);
});

test('raycast does not allocate', () => {
  const { h } = standing(0, 0, 0);
  let i = 0, grew = Infinity, hits = 0;
  const shot = () => {
    const y = 0.2 + (i % 170) * 0.01, x = ((i * 7) % 60 - 30) * 0.01;
    if (h.raycast(x, y, 3, 0, 0, -1, 10) >= 0) hits++;
    i++;
  };
  while (i < 20000) shot();
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let n = 0; n < 100000; n++) shot();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(hits > 1000, 'some rays hit');
  assert.ok(grew < 100_000, `heap grew ${grew} bytes over 100k rays`);
});
