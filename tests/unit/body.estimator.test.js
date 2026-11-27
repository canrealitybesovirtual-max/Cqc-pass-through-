/**
 * BodyEstimator (pure): hip yaw from head and hands, the neck chain, and the
 * holster / pouch / back sockets (PLAN §8, CQC's tested numbers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { BodyEstimator, BODY_EST, qEulerYXZ, qRotate, wrap, smooth } from '../../src/player/BodyEstimator.js';

const DT = 1 / 90;
const q = new Float64Array(4);
const v = new Float64Array(3);
const deg = (r) => (r * 180) / Math.PI;
const EYE = { x: 0, y: 0, z: 0 }, QH = { x: 0, y: 0, z: 0, w: 1 }, HAND = { x: 0, y: 0, z: 0 };
const hand = (x, y, z) => { HAND.x = x; HAND.y = y; HAND.z = z; return HAND; };
const REF = { floorY: 0, standEye: 1.7 };
const ref = (stand = 1.7, floorY = 0) => { REF.standEye = stand; REF.floorY = floorY; return REF; };

/**
 * Head turned about the neck (the atlas stays where it is; the eyes move round
 * it), pitch (+ up) and yaw (0 = facing −Z); `eye` = eye height when level.
 */
function head(e, pitch, yaw, eye = 1.7, x = 0, z = 0) {
  qEulerYXZ(pitch, yaw, 0, q);
  const A = BODY_EST.atlas, s = 1;
  // atlas when level: eye + (0, −0.07, 0.085); eyes = atlas − R·offset
  const ax = x + A[0] * s, ay = eye + A[1] * s, az = z + A[2] * s;
  qRotate(q, A[0] * s, A[1] * s, A[2] * s, v, 0);
  EYE.x = ax - v[0]; EYE.y = ay - v[1]; EYE.z = az - v[2];
  QH.x = q[0]; QH.y = q[1]; QH.z = q[2]; QH.w = q[3];
  e.setHead(EYE, QH);
}
function run(e, n, f, stand = 1.7) {
  for (let i = 0; i < n; i++) { if (f) f(i); e.update(DT, ref(stand)); }
}

test('helpers: wrap and the falling smoothstep', () => {
  assert.ok(Math.abs(wrap(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrap(3 * Math.PI) + Math.PI) < 1e-9);
  assert.equal(wrap(NaN), 0);
  assert.equal(smooth(0.6, 0.4, 0.3), 1);
  assert.equal(smooth(0.6, 0.4, 0.7), 0);
  assert.equal(smooth(0, 1, 0.5), 0.5);
});

test('standing, looking ahead: pelvis and holster where CQC put them (eye 1.70 m)', () => {
  const e = new BodyEstimator();
  head(e, 0, 0);
  run(e, 90);
  assert.ok(e.valid);
  // pelvis about 0.93 m (CQC rest pelvis 0.935), centred under the head
  assert.ok(Math.abs(e.pelvis[1] - 0.925) < 0.02, `pelvis y ${e.pelvis[1]}`);
  assert.ok(Math.abs(e.pelvis[0]) < 1e-6);
  // holster palm point: 21 cm to the right, ~1.02 m up (CQC SLOT_HOLSTER mid ride)
  const H = e.holster.p;
  assert.ok(Math.abs(H[0] - 0.212) < 0.005, `holster x ${H[0]}`);
  assert.ok(Math.abs(H[1] - 1.02) < 0.02, `holster y ${H[1]}`);
  // muzzle down and canted 12° to the rear, slide top facing forward
  qRotate(e.holster.q, 0, 0, -1, v, 0);
  assert.ok(v[1] < -0.95 && v[2] > 0.15, `holster muzzle ${[...v]}`);
  assert.ok(Math.abs(Math.atan2(v[2], -v[1]) - BODY_EST.holsterCant) < 0.01);
  qRotate(e.holster.q, 0, 1, 0, v, 0);
  assert.ok(v[2] < -0.9, 'slide top faces forward');
  // pouch: weak side, front of the hip, just above the belt
  const Pp = e.pouch.p;
  assert.ok(Pp[0] < -0.12 && Pp[2] < -0.03 && Pp[1] > 0.98 && Pp[1] < 1.1, `pouch ${[...Pp]}`);
  // rifle on the back: behind and to the right of the neck, muzzle down-left, butt up-right
  const B = e.back.p;
  assert.ok(B[0] > 0.1 && B[2] > 0.1 && B[1] > 1.3 && B[1] < 1.55, `back ${[...B]}`);
  qRotate(e.back.q, 0, 0, -1, v, 0);
  assert.ok(v[0] < -0.3 && v[1] < -0.8, 'rifle muzzle down to the left');
  assert.ok(e.backAxis[1] > 0.8 && e.backAxis[0] > 0.3, 'grip-to-butt axis up over the right shoulder');
  // thighs below the hips
  const T = e.thighs;
  assert.ok(T[1] > T[4] + 0.3 && T[7] > T[10] + 0.3 && T[0] < 0 && T[6] > 0);
});

test('the body scales with the calibrated standing height', () => {
  const tall = new BodyEstimator(), short = new BodyEstimator();
  head(tall, 0, 0, 1.9); run(tall, 60, null, 1.9);
  head(short, 0, 0, 1.5); run(short, 60, null, 1.5);
  // holster height ≈ eye × 0.6, offset ∝ scale
  assert.ok(Math.abs(tall.holster.p[1] / 1.9 - short.holster.p[1] / 1.5) < 0.01);
  assert.ok(Math.abs(tall.holster.p[0] / short.holster.p[0] - 1.9 / 1.5) < 0.01);
});

test('dead zone: a 30° head turn leaves the hips; a 90° turn brings them round at a capped rate', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 30);
  head(e, 0, 0.52);
  run(e, 20);
  // inside the dead zone the hips only settle back under the head at CQC's 0.7/s
  assert.ok(Math.abs(e.yaw) < 0.1, `hips after 0.22 s of a 30° turn: ${deg(e.yaw)}°`);
  const e2 = new BodyEstimator();
  head(e2, 0, 0); run(e2, 30);
  head(e2, 0, Math.PI / 2);
  run(e2, 9);   // 0.1 s: at most 5 rad/s past the dead zone
  assert.ok(e2.yaw <= 0.1 * 5 + 0.05, `capped catch-up ${e2.yaw}`);
  run(e2, 36);
  assert.ok(Math.PI / 2 - e2.yaw <= BODY_EST.dead + 0.02, `within the dead zone after 0.5 s: ${e2.yaw}`);
  run(e2, 900);
  assert.ok(Math.abs(e2.yaw - Math.PI / 2) < 0.03, 'settles under the head when still');
});

test('looking down at the holster: neck turns and tracking jitter do not move the hips', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 60);
  head(e, -1.05, 0); run(e, 90);   // look down at the belt and hold
  let maxYaw = 0, maxHolster = 0;
  const h0 = [...e.holster.p];
  run(e, 900, (i) => {
    const t = i * DT;
    head(e, -1.05 + 0.02 * Math.sin(t * 37), 0.52 * Math.sin(t * 3));   // 60° down, ±30° neck turn, jitter
    maxYaw = Math.max(maxYaw, Math.abs(e.yaw));
    maxHolster = Math.max(maxHolster, Math.hypot(e.holster.p[0] - h0[0], e.holster.p[2] - h0[2]));
  });
  assert.ok(e.freeze > 0.9, `frozen ${e.freeze}`);
  assert.ok(maxYaw < 0.08, `hip yaw ${deg(maxYaw)}° (CQC: 1.8° after the fix)`);
  assert.ok(maxHolster < 0.03, `holster moved ${maxHolster} m horizontally`);
});

test('looking past straight down does not flip the heading', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 60);
  for (const p of [-1.4, -1.55, -1.65, -1.75]) { head(e, p, 0); run(e, 30); }
  assert.ok(Math.abs(e.yaw) < 0.1, `yaw ${e.yaw}`);
});

test('hands vote: raised hands to one side turn the hips; a hand at the belt does not', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 60);
  // both controllers raised in front, 40° to the right (aiming), head straight
  const a = -0.7, d = 0.45;
  run(e, 180, () => {
    e.setHand(0, true, hand(-Math.sin(a) * d - 0.05, 1.45, -Math.cos(a) * d), false);
    e.setHand(1, true, hand(-Math.sin(a) * d + 0.05, 1.45, -Math.cos(a) * d), true);
  });
  assert.ok(e.yaw < -0.2, `hips turn toward the aiming hands: ${deg(e.yaw)}°`);
  // reaching low to the holster (right hip) while looking ahead: no vote
  const f = new BodyEstimator();
  head(f, 0, 0); run(f, 60);
  run(f, 180, () => { f.setHand(1, true, hand(0.3, 0.95, -0.1), false); f.setHand(0, false, null, false); });
  assert.ok(Math.abs(f.yaw) < 0.02, `a reaching hand moved the hips ${deg(f.yaw)}°`);
});

test('crouching lowers the holster with the pelvis; never below the floor margin', () => {
  const e = new BodyEstimator();
  head(e, 0, 0, 1.7); run(e, 60);
  const stand = e.holster.p[1];
  head(e, 0, 0, 1.1); run(e, 120);
  assert.ok(e.holster.p[1] < stand - 0.4, `crouched holster ${e.holster.p[1]} vs ${stand}`);
  head(e, 0, 0, 0.2); run(e, 120);
  assert.ok(e.pelvis[1] >= BODY_EST.pelvisMinAboveFloor - 1e-9);
});

test('the sockets are smoothed (critically damped, ~60–100 ms)', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 60);
  const x0 = e.holster.p[0];
  head(e, 0, 0, 1.7, 0.2, 0);   // the player steps 20 cm right
  e.update(DT, ref());
  assert.ok(e.holster.p[0] - x0 < 0.05, 'no jump in one frame');
  run(e, 7);   // ~80 ms
  const moved = e.holster.p[0] - x0;
  assert.ok(moved > 0.08 && moved < 0.19, `smoothed follow ${moved}`);
  run(e, 60);
  assert.ok(Math.abs(e.holster.p[0] - x0 - 0.2) < 0.005);
});

test('bad input never poisons the state', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 30);
  e.setHead({ x: NaN, y: 1.7, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
  e.update(DT, ref());
  e.setHand(1, true, hand(NaN, 1, 1), true);
  head(e, 0, 0);
  e.update(NaN, { floorY: NaN, standEye: NaN });
  e.update(5, ref());
  run(e, 10);
  for (const a of [e.pelvis, e.holster.p, e.holster.q, e.pouch.p, e.back.p, e.back.q, e.thighs]) {
    for (const x of a) assert.ok(Number.isFinite(x));
  }
  assert.ok(Number.isFinite(e.yaw + e.chestYaw + e.yawS));
});

test('reset forgets the body until the next head pose', () => {
  const e = new BodyEstimator();
  head(e, 0, 0); run(e, 10);
  e.reset();
  assert.equal(e.valid, false);
  e.update(DT, ref());
  assert.equal(e.valid, false, 'no head pose since the reset');
  head(e, 0, 1.0); e.update(DT, ref());
  assert.ok(e.valid && Math.abs(e.yaw - 1.0) < 1e-6, 'snaps to the new heading');
});

test('update does not allocate (sampling heap profiler)', async () => {
  const e = new BodyEstimator();
  head(e, 0, 0);
  const step = (i) => { head(e, -0.5 * Math.sin(i * 0.01), Math.sin(i * 0.003)); e.setHand(1, true, hand(0.2, 1.3, -0.4), true); e.update(DT, ref()); };
  for (let i = 0; i < 20000; i++) step(i);
  let best = Infinity, by = null;
  for (let r = 0; r < 3 && best > 0; r++) {
    const ses = new Session();
    ses.connect();
    await ses.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    for (let i = 0; i < 40000; i++) step(i);
    const { profile } = await ses.post('HeapProfiler.stopSampling');
    ses.disconnect();
    const b = {};
    const walk = (n) => {
      if (n.selfSize > 0 && n.callFrame.url.endsWith('/src/player/BodyEstimator.js')) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  assert.equal(best, 0, JSON.stringify(by));
});
