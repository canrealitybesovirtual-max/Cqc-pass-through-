/**
 * WeaponSystem with real-surface physics (v0.4): the real three r187, Input,
 * WeaponSystem / WeaponView / WeaponFX, the vendored Rapier, and the fixture
 * house as a real WorldCore (synthetic box guns, as in slots.weapons.test.js).
 *
 * - let go anywhere: the gun lands and stays (floor, table set-down, a throw);
 * - picked up again from where it lies;
 * - the holster rule: near the hip with the muzzle along the holster axis
 *   holsters, a level gun there drops;
 * - magazines: A drops a loose physics magazine that keeps its rounds, the
 *   left hand picks it up and seats it; one let go at the pouch goes back in;
 * - the lost-object net returns a gun 10 s after it left the house;
 * - a physics failure returns lying guns and falls back to the v0.3 rules;
 * - reset clears the world; nothing allocates per frame while items rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Session } from 'node:inspector/promises';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const { WeaponSystem } = await import('../../src/weapons/WeaponSystem.js');
const { Input } = await import('../../src/xr/Input.js');
const { Events } = await import('../../src/core/Events.js');
const { CARRY_SLOT, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP, CARRY_FREE, CARRY_DRAW } = await import('../../src/player/Slots.js');
const { loadRapier } = await import('../../src/physics/Rapier.js');
const { PhysicsWorld, ST_RESTING } = await import('../../src/physics/PhysicsWorld.js');
const { MANIFEST, houseWorld } = await import('./physics.fixtures.js');

const { R: RAPIER } = await loadRapier();
const DT = 1 / 90;

// ── synthetic models (gun space as in the manifest), as in slots.weapons.test.js ─────────
function boxPart(geos, parts, w, h, d, x, y, z, part) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  geos.push(g);
  parts.push(...new Array(g.attributes.position.count).fill(part));
}
function model(id) {
  const M = MANIFEST.weapons[id];
  const geos = [], parts = [];
  boxPart(geos, parts, 0.03, 0.03, Math.abs(M.muzzle[2]) + 0.1, 0, -0.01, M.muzzle[2] / 2 + 0.05, 0);
  boxPart(geos, parts, 0.025, 0.02, 0.15, 0, 0.005, -0.03, 1);
  boxPart(geos, parts, 0.03, 0.1, 0.04, 0, -0.07, M.grip.pos[2], 0);   // grip
  boxPart(geos, parts, 0.006, 0.025, 0.006, M.trigger.pivot[0], M.trigger.pivot[1] - 0.015, M.trigger.pivot[2], 2);
  const pos = [];
  for (const g of geos) pos.push(...g.attributes.position.array);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('_part', new THREE.Float32BufferAttribute(parts, 1));
  gg.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ name: 'gun' });
  const gun = new THREE.Mesh(gg, mat);
  gun.name = 'gun';
  const mg = new THREE.BoxGeometry(0.022, id === 'glock' ? 0.11 : 0.2, 0.03);
  mg.translate(0, id === 'glock' ? -0.055 : -0.1, id === 'glock' ? 0 : -0.03);
  const mag = new THREE.Mesh(mg, mat);
  mag.name = 'mag';
  mag.position.fromArray(M.magLocalSeat);
  const scene = new THREE.Group();
  scene.add(gun, mag);
  return { scene, gun, mag, manifest: M };
}

// ── fake XR input through the real Input ────────────────────────────────────────────
const G = {
  right: new THREE.Matrix4().fromArray([0.99255, 0, 0.12187, 0, -0.08617, 0.70711, 0.70184, 0, -0.08617, -0.70711, 0.70184, 0, 0.004, -0.0159, 0.0496, 1]),
  left: new THREE.Matrix4().fromArray([0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, -0.004, -0.0159, 0.0496, 1]),
};
const GROT = { right: new THREE.Quaternion().setFromRotationMatrix(G.right), left: new THREE.Quaternion().setFromRotationMatrix(G.left) };
function fakeHand(side) {
  const buttons = Array.from({ length: 6 }, () => ({ value: 0, pressed: false }));
  const gripSpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const raySpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const gamepad = { buttons, axes: [0, 0, 0, 0], hapticActuators: [{ pulse: () => null }] };
  const src = { handedness: side, gamepad, gripSpace, targetRaySpace: raySpace, hand: null };
  const ray = new THREE.Matrix4(), grip = new THREE.Matrix4();
  return {
    src,
    /** grip origin at `p`, aim ray orientation `q` */
    pose(p, q) {
      ray.compose(new THREE.Vector3(), q, new THREE.Vector3(1, 1, 1));
      grip.multiplyMatrices(ray, G[side]);
      grip.setPosition(p);
      const off = new THREE.Vector3().setFromMatrixPosition(G[side]).applyQuaternion(q);
      ray.setPosition(p.clone().sub(off));
      ray.toArray(raySpace.pose.transform.matrix);
      grip.toArray(gripSpace.pose.transform.matrix);
    },
    set(i, v) { buttons[i].value = v; buttons[i].pressed = v > 0.5; },
  };
}
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
/** Aim-ray orientation that holds `w` with the gun at `gunQ`: ray = gunQ · fit⁻¹ · G⁻¹. */
const rayFor = (w, gunQ = new THREE.Quaternion()) => gunQ.clone().multiply(w.view.fitQuat.clone().invert()).multiply(GROT.right.clone().invert());
/** Right grip position that puts the gun root at `root` with orientation `gunQ` (grip = root − R·fitPos in grip space). */
const gripFor = (w, root, gunQ) => {
  const gripQ = gunQ.clone().multiply(w.view.fitQuat.clone().invert());
  return root.clone().sub(w.view.fitPos.clone().applyQuaternion(gripQ));
};
/** Left grip + ray orientation that put w's hand magazine root at P with orientation magQ. */
function magHand(w, P, magQ) {
  const lg = magQ.clone().multiply(w.view.magHoldQuat.clone().invert());
  return { p: P.clone().sub(w.view.magHoldPos.clone().applyQuaternion(lg)), q: lg.clone().multiply(GROT.left.clone().invert()) };
}

function setup({ attach = true } = {}) {
  const scene = new THREE.Scene();
  const events = new Events();
  const sounds = [];
  const audio = { play(key, x, y, z, g) { sounds.push({ key, x, y, z, g }); return 1; } };
  const world = houseWorld();
  const L = fakeHand('left'), R = fakeHand('right');
  const session = { inputSources: [L.src, R.src] };
  const frame = { getPose: (space) => space.pose };
  const input = new Input();
  const player = { eye: v3(0, 1.7, -0.6), quat: new THREE.Quaternion(), valid: true, floorY: 0, standEye: 1.7, head: v3(0, 1.7, -0.6), forward: v3(0, 0, -1) };
  const raycast = (ox, oy, oz, dx, dy, dz, max, out) => world.raycast(ox, oy, oz, dx, dy, dz, max, out);
  const ctx = { scene, events, audio, world, raycast, input, player, gfx: { flashLights: [new THREE.PointLight(), new THREE.PointLight()] }, assets: { models: { glock: model('glock'), akm: model('akm') } } };
  const W = new WeaponSystem(ctx);
  const P = new PhysicsWorld(RAPIER);
  if (attach) assert.ok(W.attachPhysics(P));
  let t = 1000;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { t += DT * 1000; input.update(session, frame, {}, DT); W.update(DT, t, frame, ctx); } };
  const Q0 = new THREE.Quaternion();
  L.pose(v3(-0.25, 0.9, -0.85), Q0);
  R.pose(v3(0.25, 0.9, -0.85), Q0);
  step(30);
  if (attach) assert.ok(W.physOn, `the static colliders were built from the world: ${JSON.stringify({ failed: P.failed, ready: P.ready, geo: !!P.geo, g: P.guard.report(), b: P.buildStats })}`);
  return { W, P, ctx, L, R, step, sounds, world };
}
const holsterPoint = (W) => v3(W.body.holster.p[0], W.body.holster.p[1], W.body.holster.p[2]);
const AIM_POS = v3(0.2, 1.4, -1.05);
function drawGlock(S) {
  S.R.pose(holsterPoint(S.W), new THREE.Quaternion());
  S.R.set(1, 1);
  S.step(3);
  S.R.pose(AIM_POS, rayFor(S.W.glock));
  S.step(30);
  assert.equal(S.W.held, S.W.glock);
}
/** The gun lying flat on its right side (bore horizontal along −z). */
const FLAT = new THREE.Quaternion().setFromAxisAngle(v3(0, 0, 1), Math.PI / 2);

test('let go in front: the Glock lands on the floor and stays there (no return), with a landing sound', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(1, 0);
  S.step(1);
  assert.equal(W.glock.carry.state, CARRY_FREE);
  assert.ok(W.glock.physId >= 0);
  S.step(Math.ceil(3 / DT));
  assert.equal(S.P.state(W.glock.physId), ST_RESTING);
  const y = W.glock.view.root.position.y;
  assert.ok(y > 0 && y < 0.06, `on the floor: root y ${y.toFixed(3)}`);
  assert.ok(S.sounds.some((s) => s.key === 'magDrop'), 'a clatter on the hard floor');
  S.step(Math.ceil(12 / DT));
  assert.equal(W.glock.carry.state, CARRY_FREE, 'still lying there after 12 s');
  assert.ok(Math.abs(W.glock.view.root.position.y - y) < 1e-6, 'and has not moved');
  assert.equal(W.glock.view.root.visible, true);
  assert.equal(W.physicsReport().weapons.released, 1);
});

test('pick it up again from the floor: grip within reach + squeeze; the draw blends from where it lay', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(1, 0); S.step(1); S.step(Math.ceil(3 / DT));
  const g = W.glock, gc = g.view.toWorld(g.view.gripCentre, v3());
  const lay = g.view.root.position.clone();
  R.pose(gc.clone().add(v3(0.03, 0.04, 0)), new THREE.Quaternion());
  S.step(2);
  R.set(1, 1);
  S.step(1);
  assert.equal(W.held, g);
  assert.equal(g.carry.state, CARRY_DRAW);
  assert.equal(g.carry.fromWorld, true);
  assert.equal(g.physId, -1, 'its body left the world');
  assert.ok(g.view.root.position.distanceTo(lay) < 0.05, 'starts from where it lay');
  S.step(20);
  assert.equal(g.carry.state, CARRY_HAND);
  assert.equal(W.physicsReport().weapons.pickedUp, 1);
});

test('set down on the table with a still hand: it rests on the table top, not thrown', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock;
  // lower it slowly onto the table (centre 1.4, −1.8, top 0.75), lying flat
  for (let k = 0; k < 60; k++) {
    const root = v3(1.4, 0.95 - k * 0.003, -1.8);
    R.pose(gripFor(g, root, FLAT), rayFor(g, FLAT));
    S.step(1);
  }
  R.set(1, 0);
  S.step(1);
  assert.equal(g.carry.state, CARRY_FREE);
  assert.equal(W.physicsReport().weapons.setDown, 1, 'a set-down');
  S.step(Math.ceil(2.5 / DT));
  const p = g.view.root.position;
  assert.ok(p.y > 0.75 && p.y < 0.82, `on the table top: ${p.y.toFixed(3)}`);
  assert.ok(Math.abs(p.x - 1.4) < 0.1 && Math.abs(p.z + 1.8) < 0.1, 'where it was put');
});

test('a throw: the hand moving at 4 m/s throws the gun across the room', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock;
  for (let k = 0; k < 10; k++) {
    R.pose(v3(-0.6 + k * (4 / 90), 1.3, -1.2), rayFor(g));
    S.step(1);
  }
  const x0 = g.view.root.position.x;
  R.set(1, 0);
  S.step(1);
  assert.equal(g.carry.state, CARRY_FREE);
  assert.equal(W.physicsReport().weapons.thrown, 1);
  S.step(Math.ceil(3 / DT));
  assert.ok(g.view.root.position.x - x0 > 1.0, `flew ${(g.view.root.position.x - x0).toFixed(2)} m`);
  assert.ok(g.view.root.position.y > -0.01);
});

test('the holster rule: at the hip with the muzzle along the holster it holsters; held level there it drops', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock;
  // level, muzzle forward, grip at the holster: not a holstering motion
  const level = new THREE.Quaternion();
  const anchorFor = (q) => {
    // gun root such that the grip centre sits on the holster point
    const root = holsterPoint(W).sub(g.view.gripCentre.clone().applyQuaternion(q));
    return gripFor(g, root, q);
  };
  for (let k = 0; k < 20; k++) { R.pose(anchorFor(level), rayFor(g, level)); S.step(1); }
  R.set(1, 0);
  S.step(1);
  assert.equal(g.carry.state, CARRY_FREE, 'muzzle 90° off the holster axis: let go, it falls');
  S.step(Math.ceil(2.5 / DT));
  // pick it up and bring it back muzzle-down along the holster axis
  const gc = g.view.toWorld(g.view.gripCentre, v3());
  R.pose(gc, new THREE.Quaternion()); S.step(2); R.set(1, 1); S.step(25);
  assert.equal(W.held, g);
  const hq = g.slotQ.clone();
  for (let k = 0; k < 20; k++) { R.pose(anchorFor(hq), rayFor(g, hq)); S.step(1); }
  R.set(1, 0);
  S.step(1);
  assert.equal(g.carry.state, CARRY_HOLSTER, 'muzzle along the holster: holstered');
  S.step(40);
  assert.equal(g.carry.state, CARRY_SLOT);
  assert.equal(W.physicsReport().weapons.holstered, 1);
});

test('the AKM goes back over the shoulder whatever its angle; let go in front it lands and stays', () => {
  const S = setup();
  const { W, R } = S;
  const back = () => v3(W.body.back.p[0], W.body.back.p[1], W.body.back.p[2]);
  R.pose(back(), new THREE.Quaternion()); S.step(2); R.set(1, 1); S.step(25);
  assert.equal(W.held, W.akm);
  R.pose(AIM_POS, rayFor(W.akm)); S.step(20);
  R.pose(back(), new THREE.Quaternion()); S.step(10);
  R.set(1, 0); S.step(1);
  assert.equal(W.akm.carry.state, CARRY_HOLSTER, 'slung');
  S.step(40);
  assert.equal(W.akm.carry.state, CARRY_SLOT);
  R.pose(back(), new THREE.Quaternion()); S.step(2); R.set(1, 1); S.step(25);
  R.pose(AIM_POS, rayFor(W.akm)); S.step(20);
  R.set(1, 0); S.step(1);
  assert.equal(W.akm.carry.state, CARRY_FREE);
  S.step(Math.ceil(3 / DT));
  const y = W.akm.view.root.position.y;
  assert.ok(y > 0 && y < 0.15, `the rifle lies on the floor: ${y.toFixed(3)}`);
});

test('magazines: A drops a loose magazine that keeps its rounds; the left hand picks it up and seats it', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  const g = W.glock;
  R.set(0, 1); S.step(1); R.set(0, 0); S.step(8);   // one shot: 16 in the magazine
  assert.equal(g.inst.magRounds, 16);
  R.set(4, 1); S.step(1); R.set(4, 0);
  assert.equal(g.inst.magSeated, false);
  const lm = W.looseMags.glock;
  assert.equal(lm.count, 1, 'a loose physics magazine');
  assert.equal(W.fx.mags.glock.count, 0, 'not the ballistic pool');
  assert.equal(W.fx.loose.glock.visible, true);
  S.step(Math.ceil(2.5 / DT));
  const id = lm.id[0];
  assert.equal(S.P.state(id), ST_RESTING);
  const o = new Float64Array(7);
  S.P.pose(id, o);
  assert.ok(o[1] < 0.06, `on the floor: ${o[1].toFixed(3)}`);
  assert.equal(S.P.roundsOf(id), 16);
  // the left hand to it, squeeze
  L.pose(v3(o[0], o[1] + 0.04, o[2]), new THREE.Quaternion());
  S.step(2);
  L.set(1, 1);
  S.step(2);
  assert.equal(W.handMag, g, 'in the left hand');
  assert.equal(W.handMagRounds, 16);
  assert.equal(lm.count, 0);
  // seat it
  const v = g.view, seatW = v.toWorld(v.magSeat, v3()), axisW = v.dirWorld(v.magAxis, v3()), q = v.root.quaternion.clone();
  for (let d = -0.12; d <= 0.0; d += 0.01) { const h = magHand(g, seatW.clone().addScaledVector(axisW, d), q); L.pose(h.p, h.q); S.step(1); }
  assert.equal(g.inst.magSeated, true);
  assert.equal(g.inst.magRounds, 16, 'the same 16 rounds');
  L.set(1, 0); S.step(1);
  assert.equal(W.physicsReport().weapons.magsPicked, 1);
});

test('a magazine let go at the pouch goes back in; let go elsewhere it is a loose magazine', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  const pouch = () => v3(W.body.pouch.p[0], W.body.pouch.p[1], W.body.pouch.p[2]);
  L.pose(pouch(), new THREE.Quaternion()); L.set(1, 1); S.step(2);
  assert.equal(W.handMag, W.glock);
  L.set(1, 0); S.step(1);
  assert.equal(W.handMag, null);
  assert.equal(W.looseMags.glock.count, 0, 'back into the pouch');
  assert.equal(W.physicsReport().weapons.magsPouched, 1);
  L.pose(pouch(), new THREE.Quaternion()); L.set(1, 1); S.step(2);
  for (let k = 0; k < 10; k++) { L.pose(v3(-0.3, 1.2, -1.0), new THREE.Quaternion()); S.step(1); }
  L.set(1, 0); S.step(1);
  assert.equal(W.looseMags.glock.count, 1);
  assert.equal(S.P.roundsOf(W.looseMags.glock.id[0]), 17);
  void R;
});

test('the lost-object net: a gun dropped outside the house returns to its holster after 10 s', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock;
  for (let k = 0; k < 10; k++) { R.pose(v3(0.3, 1.2, 4.0), rayFor(g)); S.step(1); }   // 3 m beyond the south wall
  R.set(1, 0); S.step(1);
  assert.equal(g.carry.state, CARRY_FREE);
  S.step(Math.ceil(9 / DT));
  assert.equal(g.carry.state, CARRY_FREE, 'not before 10 s');
  S.step(Math.ceil(1.6 / DT));
  assert.notEqual(g.carry.state, CARRY_FREE);
  S.step(30);
  assert.equal(g.carry.state, CARRY_SLOT, 'back in the holster');
  assert.equal(W.physicsReport().weapons.lostReturns, 1);
});

test('a physics failure returns lying guns to their slots and falls back to the v0.3 rules; without physics nothing changes', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(1, 0); S.step(1);
  assert.equal(W.glock.carry.state, CARRY_FREE);
  S.P.guard.fail(new Error('recursive use of an object detected'), 'test');
  S.step(40);
  assert.equal(W.glock.carry.state, CARRY_SLOT, 'returned');
  drawGlock(S);
  R.set(1, 0); S.step(1);
  assert.equal(W.glock.carry.state, CARRY_DROP, 'the v0.3 timed return');
  const N = setup({ attach: false });
  drawGlock(N);
  N.R.set(1, 0); N.step(1);
  assert.equal(N.W.glock.carry.state, CARRY_DROP);
  assert.deepEqual(N.W.physicsReport(), { attached: false });
});

test('reset clears the lying guns and loose magazines; the AKM can be drawn while the Glock lies on the floor', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(4, 1); S.step(1); R.set(4, 0);
  R.set(1, 0); S.step(1);
  S.step(60);
  assert.equal(W.glock.carry.state, CARRY_FREE);
  assert.equal(W.looseMags.glock.count, 1);
  R.pose(v3(W.body.back.p[0], W.body.back.p[1], W.body.back.p[2]), new THREE.Quaternion());
  S.step(2); R.set(1, 1); S.step(25);
  assert.equal(W.held, W.akm);
  W.reset();
  S.step(2);
  assert.equal(W.glock.carry.state, CARRY_SLOT);
  assert.equal(W.glock.physId, -1);
  assert.equal(W.looseMags.glock.count, 0);
  assert.equal(W.fx.loose.glock.visible, false);
  assert.equal(W.held, W.akm, 'the gun in the hand stays');
});

test('brass with a world BVH: each case bounces off what it hits and lies on it (the table with a tink, the bed with a quiet thud)', () => {
  const S = setup({ attach: false });
  const { W } = S;
  const sounds = [];
  const audio = { play(key, x, y, z, g) { sounds.push({ key, x, g }); return 1; } };
  // a table top (0.75) for x < 1 and a bed (0.55) beyond, as the mesh BVH would answer through world.raycast
  const world = {
    bvh: {}, floorY: () => 0,
    raycast(ox, oy, oz, dx, dy, dz, max, out) {
      if (!(dy < -1e-9)) return false;
      const top = ox < 1 ? 0.75 : 0.55, t = (top - oy) / dy;
      if (!(t >= 0 && t <= max)) return false;
      out.dist = t; out.x = ox + dx * t; out.y = top; out.z = oz + dz * t; out.nx = 0; out.ny = 1; out.nz = 0;
      out.surface = ox < 1 ? 'table' : 'bed';
      return true;
    },
  };
  const r = 0.0049;
  W.fx.eject(0.5, 1.0, 0, 0.3, 0.5, 0, new THREE.Quaternion(), [r, 0.0192], 'brassS');
  W.fx.eject(1.5, 1.0, 0, 0.3, 0.5, 0, new THREE.Quaternion(), [r, 0.0192], 'brassS');
  for (let i = 0; i < 270; i++) W.fx.update(1 / 90, i / 90, { world, audio });
  const P = W.fx.brass.pos;
  assert.ok(Math.abs(P[1] - (0.75 + r)) < 0.003, `on the table: ${P[1].toFixed(4)}`);
  assert.ok(Math.abs(P[4] - (0.55 + r)) < 0.003, `on the bed: ${P[4].toFixed(4)}`);
  assert.equal(W.fx.brass.state[0], 3, 'at rest');
  assert.ok(sounds.some((s) => s.key === 'brassS' && s.x < 1), 'a tink on the table');
  assert.ok(sounds.some((s) => s.key === 'cloth' && s.x > 1 && s.g <= 0.15), 'a quiet thud on the bed');
  assert.equal(sounds.filter((s) => s.key === 'brassS' && s.x > 1).length, 0, 'no tink on the bed');
});

const PROFILED = ['/src/weapons/WeaponSystem.js', '/src/weapons/WeaponFX.js', '/src/weapons/LooseItems.js', '/src/player/Slots.js', '/src/physics/PhysicsWorld.js', '/src/physics/StaticGeometry.js', '/vendor/rapier/rapier.mjs'];

test('no allocation per frame while the dropped gun and magazines rest (hands roaming, sampling heap profiler)', async () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  R.set(4, 1); S.step(1); R.set(4, 0); S.step(2);
  R.set(1, 0); S.step(1);
  L.pose(v3(W.body.pouch.p[0], W.body.pouch.p[1], W.body.pouch.p[2]), new THREE.Quaternion()); L.set(1, 1); S.step(2);
  L.pose(v3(-0.4, 1.0, -1.2), new THREE.Quaternion()); S.step(5); L.set(1, 0); S.step(1);
  S.step(Math.ceil(4 / DT));
  assert.equal(S.P.awake, 0, 'everything rests');
  assert.equal(W.looseMags.glock.count, 2);
  const tmp = v3(), Q0 = new THREE.Quaternion();
  let i = 0;
  const roam = (n) => {
    for (let k = 0; k < n; k++, i++) {
      const a = i * 0.02;
      R.pose(tmp.set(0.3 + 0.1 * Math.sin(a), 1.2 + 0.2 * Math.sin(a * 0.7), -1.0), Q0);
      L.pose(tmp.set(-0.35, 1.25 + 0.1 * Math.cos(a), -0.9), Q0);
      S.step(1);
    }
  };
  roam(3000);
  let best = Infinity, by = null;
  for (let r = 0; r < 5 && best > 0; r++) {
    globalThis.gc?.();
    if (r > 0) roam(500);
    const ses = new Session();
    ses.connect();
    await ses.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    roam(5000);
    const { profile } = await ses.post('HeapProfiler.stopSampling');
    ses.disconnect();
    const b = {};
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && PROFILED.some((f) => u.endsWith(f))) {
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
