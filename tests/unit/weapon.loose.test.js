/**
 * LooseItems.js (pure): loose physics magazines in a pool of 10 per weapon.
 * Each keeps its rounds; when the pool is full the oldest one out of view is
 * recycled (else the oldest asleep, else the oldest); instance matrices follow
 * the bodies; landing sounds by surface; take() hands one to the hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRapier } from '../../src/physics/Rapier.js';
import { PhysicsWorld, ST_RESTING } from '../../src/physics/PhysicsWorld.js';
import { K_MAG9 } from '../../src/physics/ItemShapes.js';
import { LooseMags, LOOSE } from '../../src/weapons/LooseItems.js';
import { kinds, houseStatics } from './physics.fixtures.js';

const { R } = await loadRapier();
const DT = 1 / 72;

function setup() {
  const P = new PhysicsWorld(R);
  for (const k of kinds()) P.defineKind(k.kind, k.def);
  P.beginStatic(houseStatics());
  while (!P.buildSlice(4));
  const mesh = { instanceMatrix: { array: new Float32Array(LOOSE.perWeapon * 16).fill(1), needsUpdate: false }, count: 0, visible: false };
  const lm = new LooseMags(mesh, LOOSE.perWeapon, K_MAG9);
  return { P, mesh, lm };
}
const run = (P, lm, secs, audio = null) => { for (let t = 0; t < secs; t += DT) { P.step(DT); lm.sync(P, t, audio); } };
const pose = (x, y, z) => Float64Array.of(x, y, z, 0, 0, 0, 1);

test('a magazine shows at once, follows its body, keeps its rounds, and lands with a sound by surface', () => {
  const { P, mesh, lm } = setup();
  assert.ok(Array.from(mesh.instanceMatrix.array).every((v) => v === 0), 'every free slot is a zero matrix');
  const slot = lm.room(P, null, null, null);
  const id = P.spawn(K_MAG9, pose(0.3, 1.0, -0.6), 0, 0, 0, 0, 0, 0, 11);
  lm.add(P, slot, id, 11);
  assert.equal(mesh.visible, true);
  assert.equal(mesh.count, LOOSE.perWeapon);
  const e = mesh.instanceMatrix.array, k = slot * 16;
  assert.ok(Math.abs(e[k + 13] - 1.0) < 1e-6 && e[k + 15] === 1, 'shown at the spawn pose');
  const sounds = [];
  run(P, lm, 2, { play: (key, x, y, z, g) => { sounds.push({ key, y, g }); return 1; } });
  assert.equal(P.state(id), ST_RESTING);
  assert.ok(e[k + 13] < 0.05, `drawn on the floor: ${e[k + 13]}`);
  assert.ok(sounds.length >= 1 && sounds[0].key === 'magDrop' && sounds[0].g > 0.5, JSON.stringify(sounds));
  assert.ok(sounds.length <= 3, 'not a stream of sounds');
  // on the bed: the quiet cloth thud
  const s2 = lm.room(P, null, null, null);
  lm.add(P, s2, P.spawn(K_MAG9, pose(5.6, 1.0, -1.1), 0, 0, 0, 0, 0, 0, 5), 5);
  const soft = [];
  run(P, lm, 2, { play: (key, x, y, z, g) => { soft.push({ key, g }); return 1; } });
  assert.ok(soft.length >= 1 && soft.every((s) => s.key === 'cloth' && s.g < 0.4), JSON.stringify(soft));
  // into the hand: its rounds, its body gone, its instance hidden
  const o = new Float64Array(7), at = new Float64Array(7);
  P.pose(id, at);
  assert.equal(lm.nearest(P, at[0], at[1] + 0.04, at[2], 0.1), slot);
  assert.ok(lm.lastD < 0.05);
  assert.equal(lm.nearest(P, at[0] + 0.5, at[1], at[2], 0.1), -1, 'out of reach');
  assert.equal(lm.take(P, slot, o), 11);
  assert.ok(Math.abs(o[0] - at[0]) < 1e-9);
  assert.equal(lm.count, 1);
  assert.equal(e[k + 15], 0);
  assert.equal(lm.nearest(P, at[0], at[1] + 0.04, at[2], 0.1), -1);
});

test('a full pool recycles the oldest magazine out of view, else the oldest asleep, else the oldest', () => {
  const { P, lm } = setup();
  const head = { x: 0.5, y: 1.6, z: 0 }, fwd = { x: 0, y: 0, z: -1 };
  // ten magazines: slot 0 and 1 behind the player (out of view), the rest in front
  for (let i = 0; i < LOOSE.perWeapon; i++) {
    const z = i < 2 ? 0.6 : -0.8 - 0.1 * i;
    const s = lm.room(P, head, fwd, null);
    lm.add(P, s, P.spawn(K_MAG9, pose(-1 + 0.2 * i, 0.3, z), 0, 0, 0, 0, 0, 0, i), i);
  }
  run(P, lm, 2);
  assert.equal(lm.count, LOOSE.perWeapon);
  const s = lm.room(P, head, fwd, null);
  assert.equal(s, 0, 'the oldest of the two behind the player');
  assert.equal(lm.recycled, 1);
  lm.add(P, s, P.spawn(K_MAG9, pose(0.2, 0.3, -2.5), 0, 0, 0, 0, 0, 0, 3), 3);
  run(P, lm, 2);
  assert.equal(lm.room(P, head, fwd, null), 1, 'then the other one behind');
  lm.add(P, 1, P.spawn(K_MAG9, pose(0.4, 0.3, -2.5), 0, 0, 0, 0, 0, 0, 3), 3);
  run(P, lm, 2);
  // everything in view now: the oldest asleep one
  assert.equal(lm.room(P, head, fwd, null), 2);
  lm.add(P, 2, P.spawn(K_MAG9, pose(-0.8, 0.3, -2.0), 0, 0, 0, 0, 0, 0, 3), 3);
  run(P, lm, 2);
  // a wall between the head and a magazine counts as out of view (here: slot 7 only)
  const p7 = new Float64Array(7);
  P.pose(lm.id[7], p7);
  const blocked = { segmentClear: (ax, ay, az, bx, by, bz) => Math.hypot(bx - p7[0], bz - p7[2]) > 0.01 };
  assert.equal(lm.room(P, head, fwd, blocked), 7);
  lm.clear(P);
  assert.equal(lm.count, 0);
  assert.equal(lm.mesh.visible, false);
});
