/**
 * WeaponSystem + WeaponView + WeaponFX with the real three r187 (resolve hook,
 * as in world.three.test.js), the real Input, Events, WeaponInstance and
 * Recoil, the real assets/manifest.json, and synthetic gun / magazine meshes
 * (box geometry with a `_part` attribute) in place of the GLBs. A fake XR
 * session feeds controller poses and buttons through the real Input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { Session } from 'node:inspector/promises';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const { WeaponSystem, HAPTIC } = await import('../../src/weapons/WeaponSystem.js');
const { PART_KEY, FIT } = await import('../../src/weapons/WeaponView.js');
const { Input } = await import('../../src/xr/Input.js');
const { Events } = await import('../../src/core/Events.js');
const { SLOTS, CARRY_SLOT, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP } = await import('../../src/player/Slots.js');
const { SLIDE_LOCKED } = await import('../../src/weapons/WeaponInstance.js');

const MANIFEST = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8'));
const DT = 1 / 90;
const REC = { on: true };
const EVN = { n: 0 };   // sound + haptic calls (counted without allocating)

// ── synthetic models (gun space as in the manifest) ───────────────────────────
function boxPart(geos, parts, w, h, d, x, y, z, part) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  geos.push(g);
  parts.push(...new Array(g.attributes.position.count).fill(part));
}
function model(id) {
  const M = MANIFEST.weapons[id];
  const geos = [], parts = [];
  boxPart(geos, parts, 0.03, 0.03, Math.abs(M.muzzle[2]) + 0.1, 0, -0.01, M.muzzle[2] / 2 + 0.05, 0);   // frame / receiver
  boxPart(geos, parts, 0.025, 0.02, 0.15, 0, 0.005, -0.03, 1);                                           // slide / carrier
  boxPart(geos, parts, 0.006, 0.025, 0.006, M.trigger.pivot[0], M.trigger.pivot[1] - 0.015, M.trigger.pivot[2], 2);
  boxPart(geos, parts, 0.004, 0.005, 0.03, 0.015, -0.015, 0.0, 3);
  boxPart(geos, parts, 0.006, 0.01, 0.01, 0, -0.045, 0.015, 4);
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
  // gloved hands as the GLB brings them (v0.3): own material, _part on the index tip
  const handMat = new THREE.MeshStandardMaterial({ name: 'hand' });
  for (const n of id === 'akm' ? ['hand_r', 'hand_l'] : ['hand_r']) {
    const hg = new THREE.BoxGeometry(0.04, 0.1, 0.08);
    hg.translate(0, n === 'hand_r' ? -0.07 : -0.03, n === 'hand_r' ? M.grip.pos[2] : -0.13);
    hg.setAttribute('_part', new THREE.Float32BufferAttribute(new Float32Array(hg.attributes.position.count).fill(0).map((_, i) => (i < 4 ? 2 : 0)), 1));
    const h = new THREE.Mesh(hg, handMat);
    h.name = n;
    scene.add(h);
  }
  return { scene, gun, mag, manifest: M };
}

// ── fake XR input through the real Input ──────────────────────────────────────
const G = {
  right: new THREE.Matrix4().fromArray([0.99255, 0, 0.12187, 0, -0.08617, 0.70711, 0.70184, 0, -0.08617, -0.70711, 0.70184, 0, 0.004, -0.0159, 0.0496, 1]),
  left: new THREE.Matrix4().fromArray([0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, -0.004, -0.0159, 0.0496, 1]),
};
function fakeHand(side) {
  const buttons = Array.from({ length: 6 }, () => ({ value: 0, pressed: false }));
  const pulses = [];
  const gripSpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const raySpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const gamepad = { buttons, axes: [0, 0, 0, 0], hapticActuators: [{ pulse: (v, ms) => { EVN.n++; if (REC.on) pulses.push([v, ms]); return null; } }] };
  const src = { handedness: side, gamepad, gripSpace, targetRaySpace: raySpace, hand: null };
  const ray = new THREE.Matrix4(), grip = new THREE.Matrix4();
  return {
    src, buttons, pulses,
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

function setup() {
  const scene = new THREE.Scene();
  const events = new Events();
  const sounds = [];
  const audio = { play(key, x, y, z, g) { EVN.n++; if (REC.on) sounds.push({ key, x, y, z, g }); return 1; } };
  const lights = [new THREE.PointLight(0xffc27a, 0, 4, 2), new THREE.PointLight(0xffc27a, 0, 4, 2)];
  const wallZ = -5;
  const enemy = { on: false, x: 0, y: 0, z: 0, r: 0.12 };
  const world = {
    floorY: () => 0,
    raycast(ox, oy, oz, dx, dy, dz, max, out) {
      if (dz >= 0) return false;
      const t = (wallZ - oz) / dz;
      if (!(t > 0 && t < max)) return false;
      out.dist = t; out.x = ox + dx * t; out.y = oy + dy * t; out.z = wallZ;
      out.nx = 0; out.ny = 0; out.nz = 1; out.kind = 'world'; out.surface = 'wall'; out.enemy = -1; out.part = '';
      return true;
    },
  };
  const raycast = (ox, oy, oz, dx, dy, dz, max, out) => {
    if (enemy.on) {
      const lx = enemy.x - ox, ly = enemy.y - oy, lz = enemy.z - oz, t = lx * dx + ly * dy + lz * dz;
      const d2 = lx * lx + ly * ly + lz * lz - t * t;
      if (t > 0 && d2 < enemy.r * enemy.r) {
        out.dist = t; out.x = ox + dx * t; out.y = oy + dy * t; out.z = oz + dz * t; out.kind = 'enemy'; out.enemy = 3; out.part = 'head'; out.surface = '';
        return true;
      }
    }
    return world.raycast(ox, oy, oz, dx, dy, dz, max, out);
  };
  const L = fakeHand('left'), R = fakeHand('right');
  const session = { inputSources: [L.src, R.src] };
  const frame = { getPose: (space) => space.pose };
  const input = new Input();
  const player = { eye: new THREE.Vector3(0, 1.7, 0), quat: new THREE.Quaternion(), valid: true, floorY: 0, standEye: 1.7 };
  const ctx = { scene, events, audio, world, raycast, input, player, gfx: { flashLights: lights }, assets: { models: { glock: model('glock'), akm: model('akm') } } };
  const W = new WeaponSystem(ctx);
  let t = 1000;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      t += DT * 1000;
      input.update(session, frame, {}, DT);
      W.update(DT, t, frame, ctx);
    }
  };
  // hands resting low in front by default
  const Q0 = new THREE.Quaternion();
  L.pose(new THREE.Vector3(-0.25, 0.9, -0.25), Q0);
  R.pose(new THREE.Vector3(0.25, 0.9, -0.25), Q0);
  step(30);
  return { W, ctx, L, R, step, sounds, events, lights, enemy, now: () => t };
}

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const holsterPoint = (W) => v3(W.body.holster.p[0], W.body.holster.p[1], W.body.holster.p[2]);
const backPoint = (W) => v3(W.body.back.p[0], W.body.back.p[1], W.body.back.p[2]);
const AIM_POS = v3(0.2, 1.4, -0.45);
const GROT = { right: new THREE.Quaternion().setFromRotationMatrix(G.right), left: new THREE.Quaternion().setFromRotationMatrix(G.left) };
/**
 * The aim-ray orientation that holds weapon `w` with the gun at `gunQ` (default: level, bore along −Z):
 * grip = ray · G, gun = grip · fit  ⇒  ray = gunQ · fit⁻¹ · G⁻¹.
 */
const rayFor = (w, gunQ = new THREE.Quaternion()) => gunQ.clone().multiply(w.view.fitQuat.clone().invert()).multiply(GROT.right.clone().invert());
/** Left-hand grip position and ray orientation that put w's hand magazine root at P with orientation magQ. */
function magHand(w, P, magQ) {
  const lg = magQ.clone().multiply(w.view.magHoldQuat.clone().invert());
  return { p: P.clone().sub(w.view.magHoldPos.clone().applyQuaternion(lg)), q: lg.clone().multiply(GROT.left.clone().invert()) };
}

/** Draw the Glock and bring it up to aim straight ahead, level (trigger released). */
function drawGlock(S) {
  S.R.pose(holsterPoint(S.W), new THREE.Quaternion());
  S.R.set(1, 1);
  S.step(3);
  S.R.pose(AIM_POS, rayFor(S.W.glock));
  S.step(30);
}
/** One trigger press and release, then wait out the slide's 55 ms cycle. */
function fireOnce(S) {
  S.R.set(0, 1); S.step(1); S.R.set(0, 0); S.step(7);
}

test('guns start in their slots: Glock in its holster shell on the right hip, AKM slung out of sight', () => {
  const S = setup();
  const { W } = S;
  assert.equal(W.glock.carry.state, CARRY_SLOT);
  assert.equal(W.akm.carry.state, CARRY_SLOT);
  const gc = W.glock.view.toWorld(W.glock.view.gripCentre, v3());
  assert.ok(gc.distanceTo(holsterPoint(W)) < 1e-6, 'Glock grip centre on the holster socket');
  assert.ok(gc.x > 0.15 && gc.y > 0.9 && gc.y < 1.1);
  const mz = W.glock.view.toWorld(W.glock.view.muzzle, v3());
  assert.ok(mz.y < gc.y - 0.1, 'holstered muzzle points down');
  const ak = W.akm.view.toWorld(W.akm.view.gripCentre, v3());
  assert.ok(ak.distanceTo(backPoint(W)) < 1e-6 && ak.z > 0.1, 'AKM grip behind the shoulder');
  assert.ok(W.glock.view.root.visible, 'holstered Glock shows');
  assert.equal(W.akm.view.root.visible, false, 'a rifle on your back is out of sight');
  assert.ok(W.holster.visible && W.holster.position.distanceTo(W.glock.view.root.position) < 1e-9 && W.holster.quaternion.angleTo(W.glock.view.root.quaternion) < 1e-9,
    'holster shell at the holstered gun root');
  assert.deepEqual(W.ammo(), { weapon: 'glock', mag: 17, chambered: 1, mode: 'semi' });
  assert.equal(W.ammo(), W.ammo(), 'one reused object');
});

test('palm point = the grip origin in gun space (GunFit defaults); the grip axis runs up the handle', () => {
  const S = setup();
  for (const [w, want] of [[S.W.glock, [-0.008, -0.0463, 0.0298]], [S.W.akm, [-0.008, -0.0548, 0.1771]]]) {
    assert.ok(w.view.palm.distanceTo(v3(...want)) < 3e-4, `${w.id} palm ${w.view.palm.toArray()}`);
    const p = w.view.palm.clone().applyQuaternion(w.view.fitQuat).add(w.view.fitPos);
    assert.ok(p.length() < 1e-9, 'fit · palm = grip origin');
    const up = v3(...w.view.manifest.grip.up).normalize().applyQuaternion(w.view.fitQuat);
    assert.ok(up.distanceTo(v3(0, 0, -1)) < 2e-3, 'grip axis along grip −Z');
  }
});

test('draw: grab within 0.13 m of the holster, tick on entry; 0.15 s into the fitted grip; bore along the aim ray', () => {
  const S = setup();
  const { W, R } = S;
  const H = holsterPoint(W);
  R.pose(H.clone().add(v3(0, 0.12, 0)), new THREE.Quaternion());
  S.step(2);
  assert.ok(R.pulses.some(([v, ms]) => v === SLOTS.tick[0] && ms === SLOTS.tick[1]), 'entry tick');
  R.pulses.length = 0;
  R.pose(H.clone().add(v3(0, 0.2, 0)), new THREE.Quaternion());
  R.set(1, 1);
  S.step(2);
  assert.equal(W.held, null, 'no grab 20 cm away');
  R.set(1, 0); S.step(1);
  R.set(1, 1); S.step(1);
  R.pose(H, new THREE.Quaternion());   // arrives within 150 ms of the squeeze
  S.step(2);
  assert.equal(W.held, W.glock, 'drawn');
  assert.ok(R.pulses.some(([v, ms]) => v === SLOTS.draw[0] && ms === SLOTS.draw[1]), 'draw haptic');
  assert.ok(S.sounds.some((s) => s.key === 'holsterOut'));
  // aim: hand forward, rolled and pitched a little
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.2, 0.05, 'YXZ'));
  R.pose(AIM_POS, q);
  S.step(Math.ceil(SLOTS.drawS / DT) + 2);
  assert.equal(W.glock.carry.state, CARRY_HAND);
  const v = W.glock.view;
  const palm = v.toWorld(v.palm, v3());
  assert.ok(palm.distanceTo(AIM_POS) < 1e-5, `palm at the grip origin (${palm.distanceTo(AIM_POS)})`);
  // held in GRIP space: the bore is the grip frame's (0, −0.9297, −0.3683), 24.4° below the IWER aim ray
  const gripQ = q.clone().multiply(GROT.right);
  const bore = v.dirWorld(v3(0, 0, -1), v3());
  assert.ok(bore.angleTo(v3(0, -0.9297, -0.3683).applyQuaternion(gripQ)) < 1e-3, 'bore from the grip fit');
  const ray = v3(0, 0, -1).applyQuaternion(q);
  const deg = (bore.angleTo(ray) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 24.4) < 0.6, `bore ${deg.toFixed(1)}° off the aim ray`);
  // the trigger pad sits on the controller's trigger (grip (0.008, −0.0384, −0.022))
  const pad = v.toWorld(v3(0, -0.040, -0.014), v3());
  const want = v3(0.008, -0.0384, -0.022).applyQuaternion(gripQ).add(AIM_POS);
  assert.ok(pad.distanceTo(want) < 1e-3, `trigger pad ${pad.distanceTo(want)}`);
});

test('the trigger is gated after the draw until released; a shot goes along the bore and hits the wall', () => {
  const S = setup();
  const { W, R } = S;
  let shot = null, n = 0;
  S.events.on('shot', (p) => { n++; shot = { ...p }; });
  R.set(0, 1);   // finger already on the trigger while drawing
  R.pose(holsterPoint(W), new THREE.Quaternion());
  R.set(1, 1);
  S.step(3);
  R.pose(AIM_POS, rayFor(W.glock));
  S.step(30);
  assert.equal(n, 0, 'no shot with the trigger held through the draw');
  R.set(0, 0); S.step(2);
  R.set(0, 1); S.step(1);
  assert.equal(n, 1, 'fires on a fresh pull');
  const v = W.glock.view;
  const dir = v3(shot.dx, shot.dy, shot.dz);
  assert.ok(dir.angleTo(v3(0, 0, -1)) < 0.004, `shot along the bore (zero + spread): ${dir.angleTo(v3(0, 0, -1))}`);
  assert.ok(Math.abs(shot.z - (AIM_POS.z + v.muzzle.z - v.palm.z)) < 0.01, 'from the muzzle');
  assert.ok(S.sounds.some((s) => s.key === 'glockShot'));
  assert.ok(S.sounds.some((s) => s.key === 'impactWall'));
  assert.equal(W.fx.decals.count, 1, 'one bullet hole');
  assert.ok(R.pulses.some(([a, ms]) => a === HAPTIC.shot[0] && ms === HAPTIC.shot[1]), 'shot haptic 1.0 / 45 ms');
  assert.ok(W.fx.flashMesh.visible, 'muzzle flash this frame');
  assert.ok(S.lights[0].intensity > 0, 'flash light on');
  S.step(3);
  assert.equal(W.fx.flashMesh.visible, false, 'flash gone after 13–16 ms');
  assert.equal(S.lights[0].intensity, 0);
  assert.equal(W.glock.inst.chamber, 1, 'cycled: a new round chambered');
  assert.equal(W.glock.inst.magRounds, 16);
  assert.ok(W.fx.brass.count >= 1, 'a case ejected');
});

test('recoil moves the gun (muzzle up, back) and the springs bring it home', () => {
  const S = setup();
  drawGlock(S);
  const v = S.W.glock.view;
  const before = v.dirWorld(v3(0, 0, -1), v3());
  fireOnce(S);
  S.step(1);
  const after = v.dirWorld(v3(0, 0, -1), v3());
  assert.ok(after.y > before.y + 0.05, `muzzle flips up: ${after.y}`);
  S.step(90);
  const home = v.dirWorld(v3(0, 0, -1), v3());
  assert.ok(home.angleTo(before) < 1e-3, 'settled back on the hand');
  const palm = v.toWorld(v.palm, v3());
  assert.ok(palm.distanceTo(AIM_POS) < 1e-4);
});

test('an enemy hit emits enemyHit with the part damage and the bullet direction', () => {
  const S = setup();
  drawGlock(S);
  const v = S.W.glock.view;
  const mz = v.toWorld(v.muzzle, v3());
  Object.assign(S.enemy, { on: true, x: mz.x, y: mz.y + 0.01, z: -3 });
  let hit = null;
  S.events.on('enemyHit', (p) => { hit = { ...p }; });
  fireOnce(S);
  assert.ok(hit, 'enemyHit emitted');
  assert.equal(hit.enemy, 3);
  assert.equal(hit.part, 'head');
  assert.equal(hit.damage, 400);
  assert.ok(hit.dz < -0.99);
  assert.equal(S.W.fx.decals.count, 0, 'no wall decal for an enemy hit');
});

test('A drops the magazine (pooled, 1.1 m/s, falls to the floor, one landing sound); a tap with none does nothing; hold A 0.8 s = assisted reload', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(4, 1); S.step(1); R.set(4, 0);
  assert.equal(W.glock.inst.magSeated, false);
  assert.ok(R.pulses.some(([a, ms]) => a === HAPTIC.magCatch[0] && ms === HAPTIC.magCatch[1]), 'catch haptic');
  assert.ok(S.sounds.some((s) => s.key === 'glockMagOut'));
  assert.equal(W.fx.mags.glock.count, 1);
  assert.equal(W.glock.view.mag.visible, false);
  S.step(150);
  const P = W.fx.mags.glock.pos;
  assert.ok(P[1] < 0.03 && P[1] > 0, `dropped magazine lies on the floor: y ${P[1]}`);
  assert.equal(S.sounds.filter((s) => s.key === 'magDrop').length, 1, 'landing sound once');
  assert.deepEqual(W.ammo(), { weapon: 'glock', mag: -1, chambered: 1, mode: 'semi' });
  R.set(4, 1); S.step(1); R.set(4, 0);
  S.step(Math.ceil(1.5 / DT));
  assert.equal(W.glock.inst.magSeated, false, 'a second tap no longer reloads (CQC: reloads by hand)');
  R.set(4, 1); S.step(Math.ceil(0.7 / DT));
  assert.equal(W.glock.assistT, -1, 'not before 0.8 s');
  S.step(Math.ceil(0.15 / DT)); R.set(4, 0);
  S.step(Math.floor(0.9 / DT));
  assert.equal(W.glock.inst.magSeated, false, 'not yet');
  assert.ok(W.glock.view.mag.visible === false);
  S.step(Math.ceil(0.25 / DT));
  assert.equal(W.glock.inst.magSeated, true, 'assisted reload done 1.2 s after the hold');
  assert.equal(W.glock.inst.magRounds, 17);
  assert.ok(S.sounds.some((s) => s.key === 'glockMagIn'));
});

test('pouch → magazine in the left hand → aligned and pushed home seats it', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  R.set(4, 1); S.step(1); R.set(4, 0); S.step(2);   // magazine out
  const pouch = v3(W.body.pouch.p[0], W.body.pouch.p[1], W.body.pouch.p[2]);
  L.pose(pouch, new THREE.Quaternion());
  L.set(1, 1);
  S.step(2);
  assert.equal(W.handMag, W.glock, 'fresh magazine in the left hand');
  assert.ok(W.glock.view.handMag.visible);
  assert.ok(L.pulses.some(([a]) => a === HAPTIC.pouch[0]));
  // bring it under the well, aligned with the gun
  const g = W.glock, v = g.view;
  const seatW = v.toWorld(v.magSeat, v3());
  const axisW = v.dirWorld(v.magAxis, v3());
  const q = g.view.root.quaternion.clone();
  const at = (d, off = v3()) => { const h = magHand(g, seatW.clone().addScaledVector(axisW, d).add(off), q); L.pose(h.p, h.q); };
  at(-0.12, v3(0.015, 0, 0));
  S.step(2);
  assert.equal(g.well.state, 1, 'captured by the well 12 cm below, 1.5 cm off');
  assert.equal(g.inst.magSeated, false, 'not seated until pushed');
  for (let d = -0.12; d <= 0.0; d += 0.01) { at(d); S.step(1); }
  assert.equal(g.inst.magSeated, true, 'pushed home');
  assert.equal(g.inst.magRounds, 17);
  assert.equal(W.handMag, null);
  assert.equal(g.view.handMag.visible, false);
  assert.ok(L.pulses.some(([a, ms]) => a === HAPTIC.magIn[0] && ms === HAPTIC.magIn[1]), 'seat haptic in the magazine hand');
  assert.ok(R.pulses.some(([a, ms]) => a === HAPTIC.magInPrimary[0] && ms === HAPTIC.magInPrimary[1]), 'and in the gun hand');
  L.set(1, 0); S.step(1);
  assert.equal(W.fx.mags.glock.count, 1, 'only the first, released magazine is on the floor');
});

test('a magazine let go before it seats falls; one held at the wrong angle never seats', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  R.set(4, 1); S.step(1); R.set(4, 0); S.step(2);
  L.pose(v3(W.body.pouch.p[0], W.body.pouch.p[1], W.body.pouch.p[2]), new THREE.Quaternion());
  L.set(1, 1); S.step(2);
  const g = W.glock, v = g.view;
  const seatW = v.toWorld(v.magSeat, v3()), axisW = v.dirWorld(v.magAxis, v3());
  const crooked = g.view.root.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), 1.0));
  for (let d = -0.12; d <= 0.0; d += 0.01) { const h = magHand(g, seatW.clone().addScaledVector(axisW, d), crooked); L.pose(h.p, h.q); S.step(1); }
  assert.equal(g.inst.magSeated, false, '57° off: never seats');
  L.set(1, 0); S.step(1);
  assert.equal(W.handMag, null);
  assert.equal(W.fx.mags.glock.count, 2, 'the let-go magazine falls too');
});

test('rack: left grip at the slide rear, pull back past 90 %, let go: a round is chambered', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  const g = W.glock, v = g.view;
  // empty the chamber: shoot it dry? simpler: re-issue without a chambered round
  g.inst.reset(17, false);
  const rp = v.toWorld(v.rackLocal(0, v3()), v3());
  const ax = v.dirWorld(v.slideAxis, v3());
  L.pose(rp, new THREE.Quaternion());
  L.set(1, 1);
  S.step(1);
  assert.equal(W.lRole, 1, 'rack grip');
  for (let k = 0; k <= 1.0001; k += 0.1) { L.pose(rp.clone().addScaledVector(ax, k * v.travel), new THREE.Quaternion()); S.step(1); }
  assert.ok(g.inst.slidePos > 0.95, `slide follows the hand: ${g.inst.slidePos}`);
  assert.ok(S.sounds.some((s) => s.key === 'glockRackBack'));
  assert.ok(L.pulses.some(([a, ms]) => a === HAPTIC.rack[0] && ms === HAPTIC.rack[1]), 'rack haptic');
  // the slide part matrix follows: translation along +Z by slidePos · travel
  const U = v.uPart.value;
  assert.ok(Math.abs(U[16 + 14] - g.inst.slidePos * v.travel) < 1e-6);
  L.set(1, 0);
  S.step(10);
  assert.equal(g.inst.chamber, 1, 'chambered');
  assert.equal(g.inst.magRounds, 16);
  assert.ok(S.sounds.some((s) => s.key === 'glockRackFwd'));
  assert.ok(R.pulses.some(([a, ms]) => a === HAPTIC.home[0] && ms === HAPTIC.home[1]), 'slide home knock');
});

test('last round locks the slide; new magazine + B (slide release) chambers', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock;
  for (let i = 0; i < 18; i++) fireOnce(S);
  S.step(10);
  assert.equal(g.inst.slide, SLIDE_LOCKED, 'locked open on the empty magazine');
  const U = g.view.uPart.value;
  assert.ok(U[48 + 13] !== 0 || U[48 + 14] !== 0, 'slide stop part raised');
  R.set(4, 1); S.step(1); R.set(4, 0); S.step(1);   // drop the empty
  R.set(4, 1); S.step(Math.ceil(0.85 / DT)); R.set(4, 0);   // hold A: assisted reload
  S.step(Math.ceil(1.3 / DT));
  assert.equal(g.inst.magSeated, true);
  assert.equal(g.inst.slide, SLIDE_LOCKED, 'still locked after the reload');
  R.set(5, 1); S.step(1); R.set(5, 0); S.step(10);
  assert.equal(g.inst.chamber, 1);
  assert.ok(S.sounds.some((s) => s.key === 'glockSlideRel'));
  assert.ok(R.pulses.some(([a]) => a === HAPTIC.release[0]));
});

test('holster: let go within 0.24 m → 0.34 s arc into the holster; elsewhere → back after 0.3 s', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.pose(holsterPoint(W).add(v3(0.05, 0.1, 0)), new THREE.Quaternion());
  S.step(2);
  R.set(1, 0);
  S.step(1);
  assert.equal(W.glock.carry.state, CARRY_HOLSTER);
  assert.equal(W.held, null);
  S.step(Math.ceil(SLOTS.holsterS / DT) + 1);
  assert.equal(W.glock.carry.state, CARRY_SLOT);
  assert.ok(S.sounds.some((s) => s.key === 'holsterIn'));
  const gc = W.glock.view.toWorld(W.glock.view.gripCentre, v3());
  assert.ok(gc.distanceTo(holsterPoint(W)) < 1e-5);
  // drop it in front
  drawGlock(S);
  R.set(1, 0);
  S.step(1);
  assert.equal(W.glock.carry.state, CARRY_DROP);
  const y0 = W.glock.view.root.position.y;
  S.step(15);
  assert.ok(W.glock.view.root.position.y < y0 - 0.05, 'it falls');
  S.step(Math.ceil(0.5 / DT));
  assert.equal(W.glock.carry.state, CARRY_SLOT, 'back in the holster');
  assert.equal(W.glock.view.root.scale.x, 1);
});

test('lost controller tracking for 0.25 s auto-holsters', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.src.gripSpace.pose = null;   // tracking lost, squeeze still held
  R.src.targetRaySpace.pose = null;
  S.step(Math.ceil(0.2 / DT));
  assert.equal(W.held, W.glock, 'held through a short dropout');
  S.step(Math.ceil(0.1 / DT));
  assert.equal(W.glock.carry.state, CARRY_HOLSTER);
});

test('AKM: over the right shoulder, issued on semi (fires), selector semi → safe → auto, two-handed aim from the right grip to the left hand, 600 rpm', () => {
  const S = setup();
  const { W, L, R } = S;
  let shots = 0;
  S.events.on('shot', () => { shots++; });
  R.pose(backPoint(W).addScaledVector(v3(...W.body.backAxis), 0.15), new THREE.Quaternion());
  R.set(1, 1);
  S.step(3);
  assert.equal(W.held, W.akm, 'AKM taken off the back');
  assert.ok(S.sounds.some((s) => s.key === 'cloth'));
  assert.ok(W.akm.view.root.visible, 'visible once taken');
  R.pose(AIM_POS, rayFor(W.akm));
  S.step(30);
  // issued on semi (gap audit F3: on safe the trigger did nothing and the rifle read as broken)
  assert.equal(W.akm.inst.mode, 'semi');
  assert.deepEqual(W.ammo(), { weapon: 'akm', mag: 30, chambered: 1, mode: 'semi' });
  R.set(0, 1); S.step(12); R.set(0, 0); S.step(12);
  assert.equal(shots, 1, 'semi: one round per pull');
  // stick click: semi → safe (the trigger does nothing), again → auto
  R.set(3, 1); S.step(1); R.set(3, 0); S.step(1);
  assert.equal(W.akm.inst.mode, 'safe');
  assert.equal(W.ammo().mode, 'safe', 'the HUD can show SAFE');
  R.set(0, 1); S.step(3); R.set(0, 0); S.step(2);
  assert.equal(shots, 1, 'on safe');
  R.set(3, 1); S.step(1); R.set(3, 0); S.step(1);
  assert.equal(W.akm.inst.mode, 'auto');
  assert.equal(W.ammo().mode, 'auto');
  assert.ok(R.pulses.some(([a]) => a === HAPTIC.selector[0]));
  // left hand on the handguard support, then swing it 10° to the left: the rifle follows
  const v = W.akm.view;
  const sup = v.toWorld(v.support, v3());
  L.pose(sup, new THREE.Quaternion());
  L.set(1, 1);
  S.step(2);
  assert.equal(W.lRole, 2, 'support grip');
  const span = sup.distanceTo(AIM_POS);
  const dir = v3(-Math.sin(0.17), -0.1, -Math.cos(0.17)).normalize();
  L.pose(AIM_POS.clone().addScaledVector(dir, span), new THREE.Quaternion());
  S.step(3);
  const palmToSup = v.toWorld(v.supportTarget, v3()).sub(v.toWorld(v.palm, v3())).normalize();
  assert.ok(palmToSup.angleTo(dir) < 0.01, `rifle aims along right grip → left hand: ${palmToSup.angleTo(dir)}`);
  // one second of full auto
  const n0 = shots;
  R.set(0, 1);
  S.step(90);
  R.set(0, 0);
  S.step(2);
  assert.ok(shots - n0 >= 9 && shots - n0 <= 11, `600 rpm: ${shots - n0} rounds in 1 s`);
  assert.ok(W.akm.twoHand);
  assert.ok(L.pulses.some(([a]) => a === HAPTIC.shotSupport[0]), 'the support hand feels the shots');
  assert.ok(W.fx.brass.count >= 9);
  S.step(150);
  const B = W.fx.brass;
  let onFloor = 0;
  for (let i = 0; i < B.count; i++) if (B.pos[i * 3 + 1] < 0.02) onFloor++;
  assert.ok(onFloor >= 9, `cases on the floor: ${onFloor}`);
});

test('part matrices: trigger blade swings back, Glock slide stop front rises, AKM selector front drops on semi', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const g = W.glock.view;
  R.set(0, 0.6); S.step(20);   // partly pressed (below the break)
  const m = new THREE.Matrix4().fromArray(g.uPart.value, 32);
  const blade = g.trig.pivot.clone().add(v3(0, -0.015, 0));
  const moved = blade.clone().applyMatrix4(m);
  assert.ok(moved.z > blade.z + 0.002, 'trigger blade moves toward the shooter');
  R.set(0, 0); S.step(20);
  // slide stop
  const p3 = g.p3;
  const front = p3.pivot.clone().add(v3(0, 0, -0.012));
  const lifted = front.clone().applyMatrix4(new THREE.Matrix4().makeRotationAxis(p3.axis, p3.lift).setPosition(
    p3.pivot.clone().sub(p3.pivot.clone().applyMatrix4(new THREE.Matrix4().makeRotationAxis(p3.axis, p3.lift))),
  ));
  assert.ok(lifted.y > front.y, 'slide stop lift raises its front');
  // AKM selector angles from the manifest: semi lowers the lever front
  const a = W.akm.view.p3;
  const lever = a.pivot.clone().add(v3(0, 0, -0.05));
  const r = new THREE.Matrix4().makeRotationAxis(a.axis, a.angles.semi);
  const low = lever.clone().sub(a.pivot).applyMatrix4(r).add(a.pivot);
  assert.ok(low.y < lever.y, 'semi is below safe');
});

test('shader hook: one program key, uPart[5] keyed on _part, magazines get a zero _part', () => {
  const S = setup();
  for (const w of S.W.weapons) {
    const mat = w.view.material;
    assert.equal(mat.customProgramCacheKey(), PART_KEY);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(shader, null);
    assert.equal(shader.uniforms.uPart, w.view.uPart);
    assert.ok(shader.vertexShader.includes('uniform mat4 uPart[ 5 ];'));
    assert.ok(shader.vertexShader.includes('attribute float _part;'));
    assert.ok(shader.vertexShader.includes('transformed = ( wPartM * vec4( transformed, 1.0 ) ).xyz;'));
    assert.ok(shader.vertexShader.includes('objectNormal = mat3( wPartM ) * objectNormal;'));
    assert.ok(shader.vertexShader.indexOf('wPartM = uPart') < shader.vertexShader.indexOf('transformed = ( wPartM'), 'declared before use');
    assert.ok(w.view.mag.geometry.attributes._part, 'magazine geometry has _part');
    assert.equal(w.view.uPart.value.length, 80);
  }
});

test('warm-up: every mesh visible and drawn, pools primed; restored after; no program-key property changes', () => {
  const S = setup();
  const { W } = S;
  const meshes = W.warmMeshes();
  assert.ok(meshes.length >= 8);
  const mats = [];
  for (const o of meshes) o.traverse((m) => { if (m.material) mats.push(m.material); });
  const key = () => mats.map((m) => [m.transparent, m.alphaTest, m.depthWrite, m.premultipliedAlpha, m.version].join());
  const before = key();
  W.setWarm(true);
  for (const o of meshes) o.traverse((m) => { if (m.isMesh) { assert.ok(m.visible || !m.parent?.visible, m.name); assert.equal(m.frustumCulled, false, m.name); } });
  assert.ok(W.fx.brass.mesh.count >= 1 && W.fx.decals.count >= 1 && W.fx.mags.akm.mesh.count >= 1);
  for (const o of meshes) if (o.isInstancedMesh) assert.ok(o.instanceColor, `${o.name}: instanceColor primed`);
  W.setWarm(false);
  assert.equal(W.fx.brass.mesh.visible, false);
  assert.equal(W.fx.decals.visible, false);
  assert.equal(W.glock.view.handMag.visible, false);
  assert.equal(W.glock.view.gun.frustumCulled, true);
  assert.deepEqual(key(), before);
  assert.deepEqual(W.textures(), []);
});

test('pause blocks firing but the gun still follows the hand', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  let n = 0;
  S.events.on('shot', () => { n++; });
  S.events.emit('pause', { paused: true, reason: 'zone' });
  fireOnce(S);
  assert.equal(n, 0);
  R.pose(AIM_POS.clone().add(v3(0, 0.1, 0)), new THREE.Quaternion());
  S.step(2);
  const palm = W.glock.view.toWorld(W.glock.view.palm, v3());
  assert.ok(Math.abs(palm.y - AIM_POS.y - 0.1) < 1e-5);
  S.events.emit('pause', { paused: false, reason: '' });
  fireOnce(S);
  assert.equal(n, 1);
});

test('triggerBlocked (the watch has the trigger): no shot while set; the gun still follows the hand', () => {
  const S = setup();
  const { W } = S;
  drawGlock(S);
  let n = 0;
  S.events.on('shot', () => { n++; });
  W.triggerBlocked = true;
  fireOnce(S);
  assert.equal(n, 0);
  W.triggerBlocked = false;
  fireOnce(S);
  assert.equal(n, 1);
});

test('fitHold (the watch\'s GUN FIT page): draws into the empty hand and keeps it without the squeeze; switches guns; null puts it back', () => {
  const S = setup();
  const { W, R } = S;
  R.pose(AIM_POS, new THREE.Quaternion());
  S.step(2);
  assert.equal(W.held, null);
  W.fitHold('glock');
  assert.equal(W.held, W.glock);
  assert.equal(W.fitHolding, 'glock');
  S.step(60); // no squeeze: it stays in the hand
  assert.equal(W.held, W.glock);
  assert.equal(W.glock.carry.state, CARRY_HAND);
  assert.equal(W.glock.view.handR.visible, true, 'the glove shows');
  W.fitHold('akm'); // the gun the mode drew goes back, the AKM comes
  S.step(2);
  assert.equal(W.held, W.akm);
  assert.equal(W.fitHolding, 'akm');
  assert.equal(W.glock.carry.inHand, false);
  W.fitHold(null);
  S.step(1);
  assert.equal(W.held, null);
  assert.equal(W.fitHolding, null);
  S.step(90);
  assert.equal(W.akm.carry.state, CARRY_SLOT, 'back on the back, not dropped');
  assert.equal(W.glock.carry.state, CARRY_SLOT);
});

test('fitHold keeps a gun the player drew (and a squeezed grip keeps it after the fit page)', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  W.fitHold('akm'); // the player's own Glock stays; the fit page edits the AKM's numbers
  assert.equal(W.held, W.glock);
  assert.equal(W.fitHolding, 'glock');
  R.set(1, 0);
  S.step(10); // released, but the fit mode holds it
  assert.equal(W.held, W.glock);
  R.set(1, 1);
  S.step(2);
  W.fitHold(null); // squeezed: stays in the hand
  S.step(5);
  assert.equal(W.held, W.glock);
  R.set(1, 0);
  S.step(5); // normal let-go away from the hip: dropped, it returns by itself
  assert.equal(W.held, null);
});

test('reset re-issues both guns and clears the effects; a gun in the hand stays there', () => {
  const S = setup();
  const { W } = S;
  drawGlock(S);
  fireOnce(S); fireOnce(S);
  S.step(5);
  W.reset();
  assert.equal(W.held, W.glock);
  assert.equal(W.glock.inst.magRounds, 17);
  assert.equal(W.fx.decals.count, 0);
  assert.equal(W.fx.brass.count, 0);
  assert.equal(W.akm.carry.state, CARRY_SLOT);
});

test('grip fit: setFit nudges the held gun about the trigger pad; the holstered gun never moves; save / load / report', () => {
  const S = setup();
  const { W, R } = S;
  const holstered = W.glock.view.root.position.clone();
  W.setFit('glock', { pitch: 10, up: 0.01, fwd: 0 }, 'edit');
  S.step(1);
  assert.ok(W.glock.view.root.position.distanceTo(holstered) < 1e-9, 'slots anchor the grip centre, not the palm');
  drawGlock(S);
  const v = W.glock.view;
  assert.ok(v.toWorld(v.palm, v3()).distanceTo(AIM_POS) < 1e-5, 'palm still at the grip origin');
  const bore = v.dirWorld(v3(0, 0, -1), v3());
  // rayFor() was made with the nudged fit, so the gun is level: nudge = the same hand pose 10° muzzle-up
  W.setFit('glock', { pitch: 0, up: 0.01, fwd: 0 }, 'edit');
  S.step(2);
  const bore0 = v.dirWorld(v3(0, 0, -1), v3());
  assert.ok(Math.abs((bore.angleTo(bore0) * 180) / Math.PI - 10) < 0.05 && bore.y > bore0.y, 'pitch +10° = muzzle up 10°');
  assert.deepEqual(W.getFit('glock'), { pitch: 0, up: 0.01, fwd: 0 });
  const clamped = W.setFit('akm', { pitch: 45, up: -0.2, fwd: 0.01 }, 'edit');
  assert.deepEqual({ ...clamped }, { pitch: 30, up: -0.04, fwd: 0.01 });
  const json = W.fitsJSON();
  const S2 = setup();
  assert.equal(S2.W.loadFits(json), true);
  assert.equal(S2.W.fitSource, 'saved');
  assert.deepEqual(S2.W.getFit('akm'), { pitch: 30, up: -0.04, fwd: 0.01 });
  assert.ok(S2.W.akm.view.fitPos.distanceTo(W.akm.view.fitPos) < 1e-9);
  assert.equal(S2.W.loadFits('{garbage'), false);
  assert.equal(S2.W.fitSource, 'default');
  const rep = W.fitReport();
  assert.equal(rep.fitVersion, 2);
  assert.equal(rep.source, 'edit');
  assert.equal(rep.edits, 3);
  assert.equal(rep.glock.quat.length, 4);
  assert.ok(rep.rayRel.right && Math.abs(rep.rayRel.right.rayPitchDeg - 45) < 0.5 && Math.abs(rep.rayRel.right.rayYawDeg) > 6,
    `learned grip → ray: ${JSON.stringify(rep.rayRel.right)}`);
  R.set(1, 0); S.step(1);
});

test('CQC face buttons: X / Y work with the left hand on the gun; B on the AKM is the selector; free-hand X / Y do nothing', () => {
  const S = setup();
  const { W, L, R } = S;
  R.pose(backPoint(W).addScaledVector(v3(...W.body.backAxis), 0.1), new THREE.Quaternion());
  R.set(1, 1); S.step(3);
  R.pose(AIM_POS, rayFor(W.akm)); S.step(30);
  const a = W.akm;
  assert.equal(a.inst.mode, 'semi');
  // free left hand: X / Y belong to the game, not the gun
  L.set(5, 1); S.step(1); L.set(5, 0); S.step(1);
  L.set(4, 1); S.step(1); L.set(4, 0); S.step(1);
  assert.equal(a.inst.mode, 'semi');
  assert.equal(a.inst.magSeated, true);
  assert.equal(W.onGunLeft, false);
  // B on the AKM: selector (it has no slide release)
  R.set(5, 1); S.step(1); R.set(5, 0); S.step(1);
  assert.equal(a.inst.mode, 'safe');
  // left hand on the handguard: Y = selector, X = magazine release
  L.pose(a.view.toWorld(a.view.support, v3()), new THREE.Quaternion());
  L.set(1, 1); S.step(2);
  assert.equal(W.onGunLeft, true);
  assert.equal(W.busyLeft, true);
  assert.equal(W.busyRight, true);
  L.set(5, 1); S.step(1); L.set(5, 0); S.step(1);
  assert.equal(a.inst.mode, 'auto', 'Y on the gun works the selector');
  L.pulses.length = 0;
  L.set(4, 1); S.step(1); L.set(4, 0); S.step(1);
  assert.equal(a.inst.magSeated, false, 'X on the gun drops the magazine');
  assert.ok(L.pulses.some(([v, ms]) => v === HAPTIC.magCatch[0] && ms === HAPTIC.magCatch[1]), 'catch felt in the pressing hand');
  assert.equal(W.fx.mags.akm.count, 1);
  // the magazine leaves the well at 1.1 m/s (CQC) plus the gun's motion (still here)
  const V = W.fx.mags.akm.vel;
  const sp = Math.hypot(V[0], V[1], V[2]);
  assert.ok(sp > 1.0 && sp < 1.3, `drop speed ${sp}`);
});

test('B on the Glock releases a locked slide only; the right stick still works the AKM selector', () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  R.set(5, 1); S.step(1); R.set(5, 0); S.step(5);
  assert.equal(W.glock.inst.chamber, 1, 'nothing happens on a closed slide');
  assert.equal(W.glock.inst.mode, 'semi');
});

test('AKM magazine strip: a free left hand squeezing the lower 75 % of the seated magazine takes it with its rounds; it must leave the well first', () => {
  const S = setup();
  const { W, L, R } = S;
  R.pose(backPoint(W).addScaledVector(v3(...W.body.backAxis), 0.1), new THREE.Quaternion());
  R.set(1, 1); S.step(3);
  R.pose(AIM_POS, rayFor(W.akm)); S.step(30);
  const a = W.akm, v = a.view;
  R.set(0, 1); S.step(1); R.set(0, 0); S.step(8);   // one shot: 29 + 1
  assert.equal(a.inst.magRounds, 29);
  const low = v.toWorld(v3(v.magCentre.x + v.mag.position.x, v.magCentre.y - v.magHalf.y * 0.5 + v.mag.position.y, v.magCentre.z + v.mag.position.z + v.magHalf.z + 0.03), v3());
  L.pose(low, new THREE.Quaternion());
  L.pulses.length = 0;
  L.set(1, 1); S.step(2);
  assert.equal(a.inst.magSeated, false, 'stripped');
  assert.equal(W.handMag, a);
  assert.equal(W.handMagRounds, 29, 'with its rounds');
  assert.equal(W.fx.mags.akm.count, 0, 'into the hand, not onto the floor');
  assert.ok(L.pulses.some(([x, ms]) => x === HAPTIC.strip[0] && ms === HAPTIC.strip[1]));
  assert.ok(S.sounds.some((s) => s.key === 'akMagOut'));
  S.step(10);
  assert.ok(v.handMag.visible);
  assert.equal(a.inst.magSeated, false, 'not re-seated in the same grab');
  // squeezing at the top of the magazine (near the well) is not a strip
  const S2 = setup();
  S2.R.pose(backPoint(S2.W).addScaledVector(v3(...S2.W.body.backAxis), 0.1), new THREE.Quaternion());
  S2.R.set(1, 1); S2.step(3); S2.R.pose(AIM_POS, rayFor(S2.W.akm)); S2.step(30);
  const v2 = S2.W.akm.view;
  S2.L.pose(v2.toWorld(v3(0, v2.magCentre.y + v2.magHalf.y + v2.mag.position.y + 0.04, v2.mag.position.z), v3()), new THREE.Quaternion());
  S2.L.set(1, 1); S2.step(2);
  assert.equal(S2.W.akm.inst.magSeated, true, 'top of the magazine: no strip');
});

test('rack reach: AKM 0.10 m (Glock 0.085), +0.02 unchambered or locked; a tick when a free hand comes into reach', () => {
  const S = setup();
  const { W, L, R } = S;
  drawGlock(S);
  const g = W.glock, v = g.view;
  const rp = v.toWorld(v.rackLocal(0, v3()), v3());
  const side = v.dirWorld(v3(1, 0, 0), v3());
  L.pose(rp.clone().addScaledVector(side, 0.095), new THREE.Quaternion());
  L.pulses.length = 0;
  S.step(2);
  assert.equal(L.pulses.length, 0, '9.5 cm: out of the Glock reach');
  g.inst.reset(17, false);   // unchambered: +2 cm
  S.step(2);
  assert.ok(L.pulses.some(([x, ms]) => x === HAPTIC.rackHover[0] && ms === HAPTIC.rackHover[1]), 'hover tick');
  const n = L.pulses.length;
  S.step(5);
  assert.equal(L.pulses.length, n, 'one tick per entry');
  L.set(1, 1); S.step(1);
  assert.equal(W.lRole, 1, 'rack grip at 9.5 cm with an empty chamber');
  L.set(1, 0); S.step(2);
  assert.equal(W._rackReach(W.akm), 0.10);
});

test('gun–wall push-back: the bore never passes through a wall; the gun slides back along it with one tick, and returns', async () => {
  const S = setup();
  const { W, R } = S;
  drawGlock(S);
  const v = W.glock.view;
  const free = v.root.position.clone();
  // walk the hand up to the wall at z = −5: the palm 6 cm from it
  R.pulses.length = 0;
  const near = v3(AIM_POS.x, AIM_POS.y, -5 + 0.06);
  R.pose(near, rayFor(W.glock));
  S.step(3);
  const mz = v.toWorld(v.muzzle, v3());
  assert.ok(mz.z >= -5 + 0.019, `muzzle stays 2 cm off the wall: z ${mz.z}`);
  assert.ok(W.glock.wallPush > 0.05, `slid back ${W.glock.wallPush}`);
  const back = v.dirWorld(v3(0, 0, 1), v3());
  const expect = near.clone().sub(v.palm.clone().applyQuaternion(v.root.quaternion)).addScaledVector(back, W.glock.wallPush);
  assert.ok(v.root.position.distanceTo(expect) < 1e-4, 'along the bore');
  assert.equal(R.pulses.filter(([x, ms]) => x === HAPTIC.wall[0] && ms === HAPTIC.wall[1]).length, 1, 'one haptic tick');
  S.step(10);
  assert.equal(R.pulses.filter(([x]) => x === HAPTIC.wall[0]).length, 1, 'no repeat while touching');
  // allocation-free while pushing
  REC.on = false;
  let i = 0;
  const run = (n) => { for (let k = 0; k < n; k++, i++) { near.z = -5 + 0.05 + 0.03 * Math.sin(i * 0.1); R.pose(near, rayFor(W.glock)); S.step(1); } };
  near.z = -5 + 0.06;
  const rq = rayFor(W.glock);
  const run2 = (n) => { for (let k = 0; k < n; k++, i++) { near.z = -5 + 0.05 + 0.03 * Math.sin(i * 0.1); R.pose(near, rq); S.step(1); } };
  run2(2000);
  const { bytes, by } = await sampled(() => run2(4000));
  REC.on = true;
  assert.equal(bytes, 0, JSON.stringify(by));
  void run;
  // away from the wall it slides forward again
  R.pose(AIM_POS, rayFor(W.glock));
  S.step(60);
  assert.ok(W.glock.wallPush < 1e-4 && v.root.position.distanceTo(free) < 1e-3, 'back in the hand');
});

test('seated: the holster (and its shell) move onto the right thigh; the slung AKM stays reachable over the shoulder', () => {
  const S = setup();
  const { W, R, ctx } = S;
  const standing = holsterPoint(W);
  ctx.player.eye.y = 1.2;
  S.step(Math.ceil(1.6 / DT));
  assert.equal(W.body.seated, true);
  S.step(Math.ceil(0.5 / DT));
  const seated = holsterPoint(W);
  assert.ok(seated.y < standing.y - 0.3 && seated.z < standing.z - 0.05, `thigh socket ${seated.toArray()} vs hip ${standing.toArray()}`);
  const mzDir = W.glock.view.dirWorld(v3(0, 0, -1), v3());
  assert.ok(mzDir.z < -0.9, 'muzzle toward the knee');
  assert.ok(W.holster.position.distanceTo(W.glock.view.root.position) < 1e-9);
  R.pose(holsterPoint(W), new THREE.Quaternion()); R.set(1, 1); S.step(3);
  assert.equal(W.held, W.glock, 'drawn from the thigh');
  assert.ok(W.holster.visible, 'the empty holster stays');
  assert.equal(W.fitReport().seated, true);
  W.setStance('standing'); S.step(Math.ceil(0.5 / DT));
  assert.equal(W.body.seated, false);
});

test('gloves: the right one while held, the left one with the left hand on the AKM handguard; shared program key; off on request', () => {
  const S = setup();
  const { W, L, R } = S;
  const g = W.glock.view, a = W.akm.view;
  assert.ok(g.handR && a.handR && a.handL && !g.handL, 'hands taken from the GLB scenes');
  assert.equal(g.handR.parent, g.root, 'child of the gun root (moves with recoil)');
  assert.equal(g.handR.material.customProgramCacheKey(), PART_KEY, 'same program key as the gun');
  for (const h of [g.handR, a.handR, a.handL]) assert.equal(h.material.side, THREE.DoubleSide, 'double-sided from load: the glove shell is open at the cuff');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  g.handR.material.onBeforeCompile(shader, null);
  assert.equal(shader.uniforms.uPart, g.uPart, 'the index tip follows the trigger part');
  assert.equal(g.handR.visible, false, 'holstered: no glove');
  drawGlock(S);
  assert.equal(g.handR.visible, true, 'held: glove');
  W.setGloves(false); S.step(1);
  assert.equal(g.handR.visible, false, 'gloves off');
  W.setGloves(true); S.step(1);
  R.set(1, 0); S.step(40);
  assert.equal(g.handR.visible, false, 'let go: no glove');
  R.pose(backPoint(W).addScaledVector(v3(...W.body.backAxis), 0.1), new THREE.Quaternion());
  R.set(1, 1); S.step(3);
  R.pose(AIM_POS, rayFor(W.akm)); S.step(30);
  assert.equal(a.handR.visible, true);
  assert.equal(a.handL.visible, false, 'no left glove without the support hand');
  assert.equal(W.supportGlove, false, 'support glove off by default until re-posed');
  W.supportGlove = true;
  L.pose(a.toWorld(a.support, v3()), new THREE.Quaternion()); L.set(1, 1); S.step(3);
  assert.equal(a.handL.visible, true, 'left glove on the handguard');
  L.set(1, 0); S.step(2);
  assert.equal(a.handL.visible, false);
  // aimRayFor: the e2e driver's way to point the held bore
  const q = new THREE.Quaternion(), dir = v3(0.1, 0.2, -1).normalize();
  assert.ok(W.aimRayFor(dir.x, dir.y, dir.z, q));
  R.pose(AIM_POS, q); S.step(3);
  assert.ok(a.dirWorld(v3(0, 0, -1), v3()).angleTo(dir) < 1e-3, 'bore along the asked direction');
  const up = a.dirWorld(v3(0, 1, 0), v3());
  assert.ok(Math.abs(up.x) < 0.02, 'upright (no cant)');
});

const PROFILED = ['/src/weapons/WeaponSystem.js', '/src/weapons/WeaponView.js', '/src/weapons/WeaponFX.js', '/src/player/BodyEstimator.js', '/src/player/Slots.js', '/src/player/Handling.js'];

/**
 * Bytes allocated in the W2 files while `run` runs: the best of up to 5 sampled runs, because V8's
 * own one-off work (feedback vectors, inline-cache and map transitions, re-optimisation) is
 * charged to whatever function is running; a real per-frame allocation shows in every run.
 */
async function sampled(run) {
  let best = Infinity, by = null, events = 0;
  for (let r = 0; r < 5 && best > 0; r++) {
    globalThis.gc?.();
    // after a GC, code that embedded objects of earlier tests is deoptimised lazily; let it
    // re-optimise before sampling, so only steady-state per-frame allocations count
    if (r > 0) run();
    const ses = new Session();
    ses.connect();
    await ses.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    const e0 = EVN.n;
    run();
    const ev = EVN.n - e0;
    const { profile } = await ses.post('HeapProfiler.stopSampling');
    ses.disconnect();
    const b = {};
    const walk = (n, path) => {
      const u = n.callFrame.url;
      const here = `${u.split('/').pop()}:${n.callFrame.functionName}:${n.callFrame.lineNumber + 1}`;
      if (n.selfSize > 0 && PROFILED.some((f) => u.endsWith(f))) {
        const k = process.env.W2_ALLOC_PATH ? `${path.slice(-3).join('<')}<${here}` : here;
        b[k] = (b[k] || 0) + n.selfSize;
      }
      for (const c of n.children) walk(c, process.env.W2_ALLOC_PATH ? path.concat(here) : path);
    };
    walk(profile.head, []);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; events = ev; }
  }
  return { bytes: best, by, events };
}

test('the per-frame path allocates nothing: held two-handed AKM, aim sway, flying cases and magazines (sampling heap profiler)', async () => {
  const S = setup();
  const { W, L, R } = S;
  REC.on = false;
  const Q0 = new THREE.Quaternion(), q = new THREE.Quaternion(), e = new THREE.Euler(), tmp = v3(), vel = v3(0.5, 1.5, 0.3);
  R.pose(backPoint(W), Q0); R.set(1, 1); S.step(3);
  R.pose(AIM_POS, Q0); S.step(20);
  L.pose(W.akm.view.toWorld(W.akm.view.support, tmp), Q0); L.set(1, 1); S.step(2);
  assert.equal(W.lRole, 2);
  let i = 0;
  const run = (n) => {
    for (let k = 0; k < n; k++, i++) {
      e.set(0.05 * Math.sin(i * 0.05), 0.2 * Math.sin(i * 0.013), 0.03 * Math.sin(i * 0.07));
      q.setFromEuler(e);
      R.pose(AIM_POS, q);
      W.akm.view.toWorld(W.akm.view.support, tmp);
      L.pose(tmp, Q0);
      if (i % 30 === 0) W.fx.eject(0.2, 1.3, -0.4, 1, 1.5, 0.2, W.akm.view.root.quaternion, FIT.akm.caseRL, '');   // silent cases
      if (i % 200 === 0) { W.fx.dropMag('akm', tmp, Q0, vel, 2); W.fx.mags.akm.sound.fill(''); }
      S.step(1);
    }
  };
  run(4000);
  const { bytes, by } = await sampled(() => run(6000));
  assert.equal(bytes, 0, JSON.stringify(by));
  // empty hands roaming near (not into) the grab zones, and the one-handed Glock
  R.pose(backPoint(W), Q0); S.step(2); R.set(1, 0); L.set(1, 0); S.step(60);
  assert.equal(W.held, null);
  const roam = (n) => {
    for (let k = 0; k < n; k++, i++) {
      const a = i * 0.02;
      R.pose(tmp.set(0.3 + 0.1 * Math.sin(a), 1.1 + 0.25 * Math.sin(a * 0.7), -0.45 + 0.08 * Math.cos(a)), Q0);
      L.pose(tmp.set(-0.35 - 0.1 * Math.sin(a), 1.25 + 0.1 * Math.cos(a), -0.3), Q0);
      S.step(1);
    }
  };
  roam(3000);
  const empty = await sampled(() => roam(6000));
  assert.equal(empty.bytes, 0, JSON.stringify(empty.by));
  R.pose(holsterPoint(W), Q0); R.set(1, 1); S.step(3);
  assert.equal(W.held, W.glock);
  const aim = (n) => {
    for (let k = 0; k < n; k++, i++) {
      e.set(0.05 * Math.sin(i * 0.05), 0.2 * Math.sin(i * 0.013), 0);
      R.pose(AIM_POS, q.setFromEuler(e));
      S.step(1);
    }
  };
  aim(3000);
  const one = await sampled(() => aim(6000));
  REC.on = true;
  assert.equal(one.bytes, 0, JSON.stringify(one.by));
});

test('a full handling cycle allocates only the boxed numbers handed to the audio and haptics APIs', async () => {
  const S = setup();
  const { W, L, R } = S;
  REC.on = false;
  const Q0 = new THREE.Quaternion(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const tmp = v3(), tmp2 = v3(), lq = new THREE.Quaternion();
  const pouch = () => tmp.set(W.body.pouch.p[0], W.body.pouch.p[1], W.body.pouch.p[2]);
  let i = 0;
  // One 1200-frame cycle: AKM two-handed auto bursts, magazine drop, pouch, guided seat, rack,
  // back onto the shoulder; draw the Glock, shoot, drop its magazine, assisted reload, holster.
  const frame = () => {
    const c = i % 1200;
    e.set(0.05 * Math.sin(i * 0.05), 0.2 * Math.sin(i * 0.013), 0);
    q.setFromEuler(e);
    if (c < 5) { R.pose(backPoint(W), Q0); R.set(1, 1); L.set(1, 0); }
    else if (c < 600) {
      R.pose(AIM_POS, q);
      const w = W.akm, v = w.view;
      if ((c === 30 || c === 34) && w.inst.mode !== 'auto') R.set(3, 1); // issued on semi: semi → safe → auto
      if (c === 31 || c === 35) R.set(3, 0);
      if (c >= 40 && c < 300) { v.toWorld(v.support, tmp2); L.pose(tmp2, Q0); L.set(1, 1); R.set(0, (c % 90) < 60 ? 1 : 0); }
      if (c === 300) { R.set(0, 0); L.set(1, 0); R.set(4, 1); }
      if (c === 301) R.set(4, 0);
      if (c >= 310 && c < 320) { L.pose(pouch(), Q0); L.set(1, c >= 312 ? 1 : 0); }
      if (c >= 320 && c < 400) {
        const d = -0.06 + (c - 320) * 0.001;
        v.toWorld(v.magSeat, tmp2).addScaledVector(v.dirWorld(v.magAxis, tmp), d);
        lq.copy(v.root.quaternion);
        const h = magHand(w, tmp2, lq);
        L.pose(h.p, h.q);
      }
      if (c >= 400 && c < 420) { v.toWorld(v.rackLocal(0, tmp), tmp2); L.pose(tmp2, Q0); L.set(1, c >= 402 ? 1 : 0); }
      if (c >= 420 && c < 440) { v.toWorld(v.rackLocal((c - 420) / 19, tmp), tmp2); L.pose(tmp2, Q0); }
      if (c === 440) L.set(1, 0);
      if (c >= 500 && c < 560) R.pose(backPoint(W), q);
      if (c === 560) R.set(1, 0);
    } else if (c < 620) { R.pose(holsterPoint(W), Q0); R.set(1, c >= 605 ? 1 : 0); }
    else if (c < 1150) {
      R.pose(AIM_POS, q);
      if (c >= 650 && c < 900) R.set(0, (c % 12) < 2 ? 1 : 0);
      if (c === 900 || c === 910) R.set(4, 1);
      if (c === 901 || c === 990) R.set(4, 0);   // tap: drop; hold 0.9 s: assisted reload
      if (c >= 1080 && c < 1150) R.pose(holsterPoint(W), Q0);
    } else if (c === 1150) R.set(1, 0);
    if (c === 1199) { W.akm.inst.reset(30, true, 'auto'); W.glock.inst.reset(); }
    S.step(1);
    i++;
  };
  for (let k = 0; k < 3600; k++) frame();
  assert.ok(W.stats.shots > 100 && W.stats.draws >= 4 && W.stats.reloads >= 3, JSON.stringify(W.stats));
  assert.ok(W.fx.mags.akm.count > 0 && W.fx.mags.glock.count > 0 && W.fx.decals.count > 0 && W.fx.brass.count > 0);
  const { bytes, by, events } = await sampled(() => { for (let k = 0; k < 4800; k++) frame(); });
  REC.on = true;
  assert.ok(events > 200, `${events} sound / haptic calls`);
  // at most four boxed numbers (x, y, z, gain / strength, ms) per call into AudioEngine.play or pulse()
  assert.ok(bytes <= events * 64, `${bytes} B for ${events} API calls: ${JSON.stringify(by)}`);
});
