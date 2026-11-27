// Recoil springs (src/weapons/Recoil.js): accuracy, frame spikes, NaN, the runaway guard, and the
// recoil figures documented in src/weapons/WeaponDefs.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Recoil, RECOIL_SUBSTEP, RECOIL_MAX_BACK, RECOIL_MAX_ROT, springDecayRate } from '../../src/weapons/Recoil.js';
import { GLOCK, AKM } from '../../src/weapons/WeaponDefs.js';

const SEED = 12345;
/** A shot with the jitter at its mean (x 1.0) and the yaw at its bias. */
function meanShot(r, def, twoHand = false) {
  const R = def.recoil, f = twoHand ? R.twoHand : 1;
  r.push(R.kick * f, R.climb * f, R.yawBias * f);
}
const finite = (r) => [r.back, r.pitch, r.yaw, r.vBack, r.vPitch, r.vYaw].every(Number.isFinite);
const inBounds = (r) => Math.abs(r.back) < RECOIL_MAX_BACK && Math.abs(r.pitch) < RECOIL_MAX_ROT && Math.abs(r.yaw) < RECOIL_MAX_ROT;

/** Single-shot peaks, settle time and the full-auto mean from 1 ms steps. */
function measure(def, twoHand) {
  const r = new Recoil(def.recoil, SEED);
  meanShot(r, def, twoHand);
  let back = 0, pitch = 0, pitchT = 0, settle = 0;
  for (let i = 1; i <= 1000; i++) {
    r.update(0.001);
    if (r.back > back) back = r.back;
    if (r.pitch > pitch) { pitch = r.pitch; pitchT = i / 1000; }
    if (Math.abs(r.pitch) > 0.02 * pitch) settle = i / 1000;
  }
  const a = new Recoil(def.recoil, SEED);
  let sum = 0, yaw = 0, n = 0;
  for (let k = 0; k < 30; k++) {
    meanShot(a, def, twoHand);
    for (let i = 0; i < 100; i++) {
      a.update(0.001);
      if (k >= 10) { sum += a.pitch; yaw += a.yaw; n++; }
    }
  }
  return { back, pitch, pitchT, settle, autoMean: sum / n, autoYaw: yaw / n };
}

test('integrator matches the analytic damped oscillator (Glock pitch, single impulse)', () => {
  const { k, c } = GLOCK.recoil.rot, v0 = GLOCK.recoil.climb;
  const w0 = Math.sqrt(k), z = c / (2 * w0), wd = w0 * Math.sqrt(1 - z * z);
  const exact = (t) => (v0 / wd) * Math.exp(-z * w0 * t) * Math.sin(wd * t);
  const r = new Recoil(GLOCK.recoil, SEED);
  meanShot(r, GLOCK);
  let t = 0, maxErr = 0;
  for (let i = 0; i < 90; i++) {                 // 90 Hz frames for 1 s
    r.update(1 / 90); t += 1 / 90;
    maxErr = Math.max(maxErr, Math.abs(r.pitch - exact(t)));
  }
  const tPeak = Math.atan2(wd, z * w0) / wd;
  // CQC tuned its numbers on this integrator (semi-implicit Euler, <= 4 ms steps), so it is kept
  // even though it runs ~9 % behind the exact solution around the peak; it must stay close.
  assert.ok(maxErr < 0.12 * exact(tPeak), `max error ${maxErr} rad vs peak ${exact(tPeak)}`);
});

test('frame-rate independent: 72, 90 and 120 Hz agree', () => {
  const at = (hz) => {
    const r = new Recoil(AKM.recoil, SEED);
    meanShot(r, AKM);
    const n = Math.round(0.25 * hz);
    for (let i = 0; i < n; i++) r.update(1 / hz);
    return r;
  };
  const a = at(72), b = at(90), c = at(120);
  for (const key of ['back', 'pitch', 'yaw']) {
    assert.ok(Math.abs(a[key] - c[key]) < 1e-3, `${key}: 72 Hz ${a[key]} vs 120 Hz ${c[key]}`);
    assert.ok(Math.abs(b[key] - c[key]) < 1e-3, `${key}: 90 Hz ${b[key]} vs 120 Hz ${c[key]}`);
  }
});

test('a long frame is sub-stepped, not taken as one step', () => {
  // One 0.1 s update must equal 25 updates of 4 ms (the sub-step) exactly.
  const a = new Recoil(GLOCK.recoil, SEED), b = new Recoil(GLOCK.recoil, SEED);
  a.fire(); b.fire();
  a.update(0.1);
  for (let i = 0; i < 25; i++) b.update(RECOIL_SUBSTEP);
  assert.ok(Math.abs(a.pitch - b.pitch) < 1e-12 && Math.abs(a.back - b.back) < 1e-12);
  assert.ok(a.pitch !== 0);
});

for (const def of [GLOCK, AKM]) {
  test(`${def.id}: stable under 0.1 / 0.5 / 2 s frame spikes`, () => {
    for (const spike of [0.1, 0.5, 2]) {
      // a spike right after a shot, then full auto (a shot every 100 ms, 11 ms frames) with a
      // spike every tenth frame
      const r = new Recoil(def.recoil, SEED);
      r.fire(false);
      r.update(spike);
      assert.ok(finite(r) && inBounds(r), `spike ${spike}: ${r.pitch}`);
      let t = 0, next = 0;
      for (let i = 0; i < 400; i++) {
        if (t >= next) { r.fire(i % 50 < 25); next = t + 0.1; }
        const dt = i % 10 === 9 ? spike : 0.011;
        r.update(dt);
        t += dt;
        assert.ok(finite(r) && inBounds(r), `spike ${spike} frame ${i}: pitch ${r.pitch}`);
      }
      assert.equal(r.trips, 0, 'the runaway guard never trips on real input');
      for (let i = 0; i < 200; i++) r.update(0.011);
      assert.equal(r.active, false, 'settles to rest');
      assert.equal(r.pitch, 0);
    }
  });

  test(`${def.id}: a 0.5 s spike lands where 1 ms steps land; 2 s puts the springs at rest`, () => {
    const ref = new Recoil(def.recoil, SEED), r = new Recoil(def.recoil, SEED);
    meanShot(ref, def); meanShot(r, def);
    for (let i = 0; i < 500; i++) ref.update(0.001);
    r.update(0.5);
    const peak = measure(def, false).pitch;
    assert.ok(Math.abs(r.pitch - ref.pitch) < 1e-3 * peak && Math.abs(r.back - ref.back) < 1e-4);
    const s = new Recoil(def.recoil, SEED);
    s.fire();
    s.update(2);
    assert.equal(s.active, false);
    assert.deepEqual([s.back, s.pitch, s.yaw, s.vBack, s.vPitch, s.vYaw], [0, 0, 0, 0, 0, 0]);
    // the shortcut is honest: by settleDt the slowest spring has decayed to 1/1000
    assert.ok(Math.exp(-Math.min(springDecayRate(def.recoil.back.k, def.recoil.back.c), springDecayRate(def.recoil.rot.k, def.recoil.rot.c)) * s.settleDt) <= 1.0001e-3);
    assert.ok(s.settleDt < 0.6);
  });
}

test('NaN and junk input never poison the state', () => {
  const r = new Recoil(GLOCK.recoil, SEED);
  r.fire();
  r.update(0.02);
  const before = [r.back, r.pitch, r.yaw];
  for (const dt of [NaN, -1, 0, -Infinity]) r.update(dt);
  assert.deepEqual([r.back, r.pitch, r.yaw], before, 'NaN / negative / zero dt advance nothing');
  r.push(NaN, 1, 1);
  r.push(1, Infinity, 0);
  r.scale = NaN;
  r.fire();
  assert.ok(finite(r), 'non-finite impulses are ignored');
  r.scale = 1;
  r.update(Infinity);
  assert.equal(r.active, false, 'an infinite frame settles');
  assert.ok(finite(r));
  // a zero or junk seed still gives a working generator
  for (const seed of [0, NaN, -1, 2 ** 40]) {
    const z = new Recoil(GLOCK.recoil, seed);
    const u = z.random();
    assert.ok(u >= 0 && u < 1 && z.random() !== u, `seed ${seed}`);
  }
});

test('runaway guard: corrupted or absurd state is reset, not integrated', () => {
  const r = new Recoil(AKM.recoil, SEED);
  r.fire();
  r.vPitch = NaN;
  r.update(0.011);
  assert.ok(finite(r) && r.pitch === 0 && r.trips === 1);
  for (let i = 0; i < 500; i++) r.fire();   // 500 shots with no frame between them
  r.update(0.011);
  assert.ok(finite(r) && inBounds(r));
  assert.equal(r.trips, 2);
});

test('two hands scale every impulse by 0.55; the scale setting multiplies', () => {
  const one = new Recoil(GLOCK.recoil, SEED), two = new Recoil(GLOCK.recoil, SEED), half = new Recoil(GLOCK.recoil, SEED);
  half.scale = 0.5;
  one.fire(false); two.fire(true); half.fire(false);           // same seed: same random draws
  assert.ok(Math.abs(two.vPitch / one.vPitch - 0.55) < 1e-12 && Math.abs(two.vBack / one.vBack - 0.55) < 1e-12);
  assert.ok(Math.abs(half.vPitch / one.vPitch - 0.5) < 1e-12);
});

test('per-shot impulses: kick and climb x 0.9-1.1, yaw within +-yaw around its bias', () => {
  for (const def of [GLOCK, AKM]) {
    const R = def.recoil, gen = new Recoil(R, 3);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const r = new Recoil(R, gen.random() * 2 ** 31);
      r.fire(false);
      lo = Math.min(lo, r.vPitch); hi = Math.max(hi, r.vPitch);
      assert.ok(r.vBack >= R.kick * 0.9 - 1e-12 && r.vBack <= R.kick * 1.1 + 1e-12);
      assert.ok(r.vPitch >= R.climb * 0.9 - 1e-12 && r.vPitch <= R.climb * 1.1 + 1e-12);
      assert.ok(Math.abs(r.vYaw - R.yawBias) <= R.yaw + 1e-12);
      assert.ok(r.vPitch > 0, 'the muzzle always climbs');
    }
    assert.ok(lo < R.climb * 0.91 && hi > R.climb * 1.09, 'the jitter covers its range');
  }
});

test('documented figures: the Glock flips, the AKM rises more and stacks in auto', () => {
  const g1 = measure(GLOCK, false), g2 = measure(GLOCK, true), a1 = measure(AKM, false), a2 = measure(AKM, true);
  const near = (x, want, tol, what) => assert.ok(Math.abs(x - want) <= tol, `${what}: ${x} (want ${want} +- ${tol})`);
  // Glock 17, CQC springs: ~16 mm back, ~0.27 rad flip one-handed, settled in ~0.4 s
  near(g1.back, 0.016, 0.002, 'glock back'); near(g1.pitch, 0.27, 0.02, 'glock pitch');
  near(g2.pitch, 0.15, 0.015, 'glock pitch two hands'); near(g1.settle, 0.4, 0.06, 'glock settle');
  // AKM: a bigger single-shot rise, a quicker return, and ~0.2 rad mean climb braced in auto
  near(a1.back, 0.017, 0.002, 'akm back'); near(a2.back, 0.0095, 0.0015, 'akm back braced');
  near(a1.pitch, 0.32, 0.02, 'akm pitch'); near(a2.pitch, 0.18, 0.015, 'akm pitch braced');
  assert.ok(a1.pitch > 1.1 * g1.pitch && a2.pitch > 1.1 * g2.pitch, '7.62x39 rises more than 9 mm');
  assert.ok(a1.settle < g1.settle, 'the braced rifle springs back faster');
  near(a1.autoMean, 0.36, 0.03, 'akm auto mean'); near(a2.autoMean, 0.2, 0.02, 'akm auto mean braced');
  assert.ok(a1.autoMean > a1.pitch, 'in auto the rise stacks above a single shot');
  assert.ok(a1.autoYaw < -0.008 && a1.autoYaw > -0.02, `akm drifts right in auto: ${a1.autoYaw}`);
  assert.equal(g1.autoYaw, 0, 'the Glock has no yaw bias');
});

test('fire and update do not allocate', () => {
  const r = new Recoil(AKM.recoil, 5);
  for (let i = 0; i < 2000; i++) { r.fire((i & 1) === 1); r.update(0.011); }
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) { if (i % 9 === 0) r.fire((i & 1) === 1); r.update(0.011); }
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 200_000, `heap grew ${grew} bytes over 200k updates and 22k shots`);
});
