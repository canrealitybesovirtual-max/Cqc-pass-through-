/**
 * Player.js (three) and head.js (pure). 'three' resolves to the vendored r187
 * build through a resolve hook, as in world.three.test.js.
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
const { Player, BODY } = await import('../../src/game/Player.js');
const { headPose, quatForward, quatUp } = await import('../../src/game/head.js');

const DT = 1 / 72;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** An XR-like ArrayCamera: two eye cameras 64 mm apart, plus the stale own pose (view 0). */
function xrCam() {
  const L = new THREE.PerspectiveCamera(), R = new THREE.PerspectiveCamera();
  const cam = new THREE.ArrayCamera([L, R]);
  const set = (x, y, z, pitch = 0, yaw = 0) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    L.position.set(x, y, z).addScaledVector(right, -0.032);
    R.position.set(x, y, z).addScaledVector(right, 0.032);
    L.quaternion.copy(q);
    R.quaternion.copy(q);
    cam.position.copy(L.position); // three: view 0 until render()
    cam.quaternion.copy(q);
  };
  return { cam, set };
}

const world = (floor = 0) => ({ built: true, floorY: () => floor });

test('headPose: midpoint of the eye cameras in XR, the camera itself otherwise; no pose = false', () => {
  const { cam, set } = xrCam();
  const out = new Float64Array(7);
  set(1, 1.7, 2);
  assert.equal(headPose(cam, out), true);
  assert.ok(near(out[0], 1) && near(out[1], 1.7) && near(out[2], 2));
  const flat = new THREE.PerspectiveCamera();
  flat.position.set(0.5, 1.2, -1);
  headPose(flat, out);
  assert.deepEqual([out[0], out[1], out[2]], [0.5, 1.2, -1]);
  assert.equal(headPose(new THREE.PerspectiveCamera(), out), false);
});

test('quatForward / quatUp match three', () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 2.1, 0.3, 'YXZ'));
  const o = new Float64Array(6);
  quatForward(q.x, q.y, q.z, q.w, o, 0);
  quatUp(q.x, q.y, q.z, q.w, o, 3);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  for (let i = 0; i < 3; i++) { assert.ok(near(o[i], f.getComponent(i))); assert.ok(near(o[3 + i], u.getComponent(i))); }
});

test('standing: head sphere behind the eyes, torso capsule from neck base to pelvis, scaled by height', () => {
  const p = new Player();
  const { cam, set } = xrCam();
  set(0, 1.7, 0);
  for (let i = 0; i < 120; i++) p.update(DT, i, null, { camera: cam, world: world() });
  assert.ok(p.valid);
  assert.ok(near(p.standEye, 1.7, 1e-3), `calibrated ${p.standEye}`);
  assert.ok(near(p.head.z, BODY.headBack, 1e-6), 'head centre 8.5 cm behind the eyes');
  assert.ok(near(p.head.y, 1.7 + BODY.headUp, 1e-6));
  assert.ok(near(p.forward.z, -1));
  assert.ok(near(p.torsoTop.y, 1.7 - 0.32, 1e-3));
  assert.ok(near(p.torsoBottom.y, 1.7 - 0.68, 1e-3), `pelvis ${p.torsoBottom.y}`);
  assert.ok(near(p.torsoRadius, 0.17, 1e-3));
  assert.equal(p.headRadius, 0.11);
  // a 1.50 m eye height scales the torso
  const s = new Player();
  set(0, 1.5, 0);
  for (let i = 0; i < 120; i++) s.update(DT, i, null, { camera: cam, world: world() });
  assert.ok(near(s.scale, 1.5 / 1.7, 1e-3));
  assert.ok(near(s.torsoBottom.y, 1.5 - 0.68 * s.scale, 1e-3));
});

test('crouching lowers the pelvis (never under 0.3 m); the standing height is not lowered by it', () => {
  const p = new Player();
  const { cam, set } = xrCam();
  set(0, 1.7, 0);
  for (let i = 0; i < 120; i++) p.update(DT, i, null, { camera: cam, world: world() });
  set(0, 1.0, 0);
  for (let i = 0; i < 200; i++) p.update(DT, i, null, { camera: cam, world: world() });
  assert.ok(near(p.standEye, 1.7, 1e-3));
  assert.ok(near(p.torsoBottom.y, 1.0 - 0.6, 1e-3), `pelvis ${p.torsoBottom.y}`);
  set(0, 0.6, 0);
  p.update(DT, 0, null, { camera: cam, world: world() });
  assert.ok(p.torsoBottom.y >= 0.3 - 1e-9);
  assert.ok(p.torsoBottom.y <= p.torsoTop.y);
  // standing up taller later raises the calibration; a floor offset is respected
  const q = new Player();
  set(0, 2.1, 0);
  for (let i = 0; i < 200; i++) q.update(DT, i, null, { camera: cam, world: world(0.4) });
  assert.ok(near(q.eyeHeight, 1.7, 1e-6));
  assert.ok(near(q.standEye, 1.7, 1e-3));
  set(0, 2.4, 0);
  for (let i = 0; i < 300; i++) q.update(DT, i, null, { camera: cam, world: world(0.4) });
  assert.ok(near(q.standEye, BODY.maxEye, 1e-3), 'clamped to 1.98');
});

test('leaning out: the pelvis lags (at most 0.35 m), then follows; looking down keeps the heading', () => {
  const p = new Player();
  const { cam, set } = xrCam();
  set(0, 1.7, 0);
  for (let i = 0; i < 120; i++) p.update(DT, i, null, { camera: cam, world: world() });
  set(0.45, 1.65, 0); // a quick lean to the right
  p.update(DT, 0, null, { camera: cam, world: world() });
  const off = p.torsoTop.x - p.torsoBottom.x;
  assert.ok(off > 0.3 && off <= 0.35 + 1e-9, `pelvis offset ${off}`);
  for (let i = 0; i < 200; i++) p.update(DT, i, null, { camera: cam, world: world() });
  assert.ok(Math.abs(p.torsoTop.x - p.torsoBottom.x) < 0.01, 'caught up');
  // look straight down while facing +X (yaw −90°): the heading stays +X
  set(0, 1.7, 0, -Math.PI / 2 + 0.001, -Math.PI / 2);
  p.update(DT, 0, null, { camera: cam, world: world() });
  assert.ok(near(p.flatForward.x, 1, 1e-3) && near(p.flatForward.z, 0, 1e-3), `${p.flatForward.toArray()}`);
  assert.ok(p.forward.y < -0.99);
});

test('update allocates nothing (sampling heap profiler)', async () => {
  const p = new Player();
  const { cam, set } = xrCam();
  const w = world();
  const ctx = { camera: cam, world: w };
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      const k = i % 400;
      cam.cameras[0].position.set(k * 0.001, 1.6 + (k % 50) * 0.002, 0);
      cam.cameras[1].position.set(k * 0.001 + 0.064, 1.6 + (k % 50) * 0.002, 0);
      p.update(DT, i, null, ctx);
    }
  };
  set(0, 1.7, 0);
  loop(100000);
  let best = Infinity, by = null;
  for (let r = 0; r < 8 && best > 0; r++) { // best of up to 8 (early exit): a JIT deopt under load is one-off, a real allocation shows every time
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(100000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && (u.endsWith('/src/game/Player.js') || u.endsWith('/src/game/head.js'))) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  assert.equal(best, 0, JSON.stringify(by));
});

test('Roam: horizontal velocity (low-passed), seated detection with hold and hysteresis, override, recalibration on a new world', () => {
  const { cam, set } = xrCam();
  const p = new Player();
  const w = { built: true, floorY: () => 0, nav: { version: 1 } };
  const ctx = { camera: cam, world: w };
  let x = 0;
  for (let i = 0; i < 144; i++) { x += 1.0 * DT; set(x, 1.7, 0); p.update(DT, i * 14, null, ctx); }
  assert.ok(near(p.vel.x, 1.0, 0.02) && near(p.vel.z, 0, 1e-6), `vel ${p.vel.x}`);
  assert.ok(near(p.speed, 1.0, 0.02));
  // a tracking jump is not walking
  set(x + 2, 1.7, 0); p.update(DT, 3000, null, ctx);
  assert.ok(p.speed < 1.05);
  for (let i = 0; i < 144; i++) { set(x + 2, 1.7, 0); p.update(DT, 4000 + i * 14, null, ctx); }
  assert.ok(p.speed < 0.05);
  assert.equal(p.seated, false);
  // sit down (eye 1.7 → 1.15): seated after 1.5 s
  for (let i = 0; i < 72; i++) { set(x + 2, 1.15, 0); p.update(DT, 7000 + i * 14, null, ctx); }
  assert.equal(p.seated, false, 'not yet (1 s)');
  for (let i = 0; i < 50; i++) { set(x + 2, 1.15, 0); p.update(DT, 8100 + i * 14, null, ctx); }
  assert.equal(p.seated, true);
  // a crouch to pick something up (looking hard down) does not sit
  const p2 = new Player();
  for (let i = 0; i < 144; i++) { set(0, 1.7, 0); p2.update(DT, i * 14, null, ctx); }
  for (let i = 0; i < 216; i++) { set(0, 1.15, 0, -1.2); p2.update(DT, 3000 + i * 14, null, ctx); }
  assert.equal(p2.seated, false);
  // stand up: 0.4 s
  for (let i = 0; i < 36; i++) { set(x + 2, 1.68, 0); p.update(DT, 9000 + i * 14, null, ctx); }
  assert.equal(p.seated, false);
  // the integrator's decision wins
  p.seatedOverride = true;
  set(x + 2, 1.7, 0); p.update(DT, 10000, null, ctx);
  assert.equal(p.seated, true);
  p.seatedOverride = null;
  // a new world (unbounded: the floor arrives with the first build) restarts the height calibration
  const before = p.standEye;
  w.floorY = () => -0.2;
  w.nav.version = 2;
  for (let i = 0; i < 144; i++) { set(x + 2, 1.5, 0); p.update(DT, 11000 + i * 14, null, ctx); }
  assert.ok(near(p.standEye, 1.7, 0.02), `recalibrated ${before} → ${p.standEye}`);
});
