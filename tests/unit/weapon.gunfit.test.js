/**
 * GunFit (pure): the guns fitted to the Touch Plus grip space (research-fit
 * spec A / H).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import {
  computeFit, parseFits, serializeFits, clampAdj, adjFromUrl, rotate, rotateInv, defaultFits,
  GRIP_DEFAULT, FIT_LIMITS, FIT_PIVOT, FIT_KEY, AKM_SUPPORT_TARGET, MAG_IN_LEFT,
} from '../../src/weapons/GunFit.js';

const MANIFEST = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8'));
const TRIGGER_PAD = { glock: [0, -0.040, -0.014], akm: [0, -0.045, 0.133] };

/** gun-space point → grip space with a pose7 */
function toGrip(pose, p) {
  const o = [0, 0, 0];
  rotate([pose[3], pose[4], pose[5], pose[6]], p[0], p[1], p[2], o);
  return [o[0] + pose[0], o[1] + pose[1], o[2] + pose[2]];
}
const near = (a, b, eps, msg) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= eps), `${msg}: ${a.map((v) => v.toFixed(4))} vs ${b}`);
const fit = (id, adj = null) => { const pose = new Float64Array(7), palm = new Float64Array(3); computeFit(id, adj, pose, palm); return { pose, palm }; };

test('defaults: each trigger pad lands on the controller trigger (≤ 1 mm)', () => {
  near(toGrip(fit('glock').pose, TRIGGER_PAD.glock), [0.008, -0.0384, -0.022], 0.001, 'Glock trigger');
  near(toGrip(fit('akm').pose, TRIGGER_PAD.akm), [0.008, -0.0395, -0.022], 0.001, 'AKM trigger');
});

test('defaults: the gun grip axis runs up the handle (grip −Z) and the bore is (0, −0.9297, −0.3683)', () => {
  for (const id of ['glock', 'akm']) {
    const { pose } = fit(id), q = [pose[3], pose[4], pose[5], pose[6]], up = MANIFEST.weapons[id].grip.up, o = [0, 0, 0];
    rotate(q, up[0], up[1], up[2], o);
    near(o, [0, 0, -1], 0.002, `${id} grip axis`);
    const alpha = Math.atan2(-up[2], up[1]) * 180 / Math.PI;
    assert.ok(Math.abs(alpha - GRIP_DEFAULT[id].gripDeg) < 0.05, `${id} grip angle ${alpha}`);
  }
  const o = [0, 0, 0], { pose } = fit('glock');
  rotate([pose[3], pose[4], pose[5], pose[6]], 0, 0, -1, o);
  near(o, [0, -0.9297, -0.3683], 0.0005, 'Glock bore');
});

test('palm round-trips: pose · palm = grip origin; default palms as measured', () => {
  for (const [id, want] of [['glock', [-0.008, -0.0463, 0.0298]], ['akm', [-0.008, -0.0548, 0.1771]]]) {
    for (const adj of [null, { pitch: 12, up: 0.01, fwd: -0.02 }, { pitch: -30, up: -0.04, fwd: 0.04 }]) {
      const { pose, palm } = fit(id, adj);
      near(toGrip(pose, palm), [0, 0, 0], 1e-9, `${id} palm → grip origin`);
    }
    near(Array.from(fit(id).palm), want, 0.0003, `${id} default palm`);
  }
});

test('pitch +10° tilts the bore toward grip −Z (muzzle up) and keeps the pivot fixed', () => {
  const a = fit('glock'), b = fit('glock', { pitch: 10, up: 0, fwd: 0 });
  const boreA = [0, 0, 0], boreB = [0, 0, 0];
  rotate([a.pose[3], a.pose[4], a.pose[5], a.pose[6]], 0, 0, -1, boreA);
  rotate([b.pose[3], b.pose[4], b.pose[5], b.pose[6]], 0, 0, -1, boreB);
  assert.ok(boreB[2] < boreA[2] - 0.1, 'more −Z');
  const ang = Math.acos(boreA[0] * boreB[0] + boreA[1] * boreB[1] + boreA[2] * boreB[2]) * 180 / Math.PI;
  assert.ok(Math.abs(ang - 10) < 1e-6, `10° (${ang})`);
  // the gun point that sat on the pivot stays there
  const pivotGun = [0, 0, 0];
  rotateInv([a.pose[3], a.pose[4], a.pose[5], a.pose[6]], FIT_PIVOT[0] - a.pose[0], FIT_PIVOT[1] - a.pose[1], FIT_PIVOT[2] - a.pose[2], pivotGun);
  near(toGrip(b.pose, pivotGun), Array.from(FIT_PIVOT), 1e-9, 'pivot fixed');
});

test('up / fwd move the gun along grip −Z / −Y', () => {
  const a = fit('akm'), b = fit('akm', { pitch: 0, up: 0.02, fwd: 0.01 });
  near([b.pose[0] - a.pose[0], b.pose[1] - a.pose[1], b.pose[2] - a.pose[2]], [0, -0.01, -0.02], 1e-9, 'shift');
});

test('clamps hold (±30°, ±0.04 m) and junk is 0', () => {
  const a = clampAdj({ pitch: 99, up: -1, fwd: NaN });
  assert.deepEqual(a, { pitch: FIT_LIMITS.pitchDeg, up: -FIT_LIMITS.up, fwd: 0 });
  const over = fit('glock', { pitch: 99, up: 1, fwd: -1 }), lim = fit('glock', { pitch: 30, up: 0.04, fwd: -0.04 });
  near(Array.from(over.pose), Array.from(lim.pose), 1e-12, 'clamped pose');
  near(Array.from(fit('glock', { pitch: NaN, up: Infinity, fwd: undefined }).pose), Array.from(fit('glock').pose), 1e-12, 'non-finite = default');
});

test('parse / serialize: round-trip; bad JSON, wrong version and out-of-range values give the defaults', () => {
  const f = defaultFits();
  f.glock = { pitch: -3.5, up: 0.008, fwd: -0.004 };
  f.akm = { pitch: 7.25, up: -0.012, fwd: 0.02 };
  assert.deepEqual(parseFits(serializeFits(f)), f);
  assert.deepEqual(parseFits('{nope'), defaultFits());
  assert.deepEqual(parseFits(null), defaultFits());
  assert.deepEqual(parseFits({ v: 2, glock: { pitch: 5 } }), defaultFits());
  const bad = parseFits(JSON.stringify({ v: 1, glock: { pitch: 31, up: 'x', fwd: 0.01 }, akm: 5 }));
  assert.deepEqual(bad, { glock: { pitch: 0, up: 0, fwd: 0.01 }, akm: { pitch: 0, up: 0, fwd: 0 } });
  assert.equal(FIT_KEY, 'cqcpt.gunfit.v1');
  const s = JSON.parse(serializeFits({ glock: { pitch: 50, up: 0, fwd: 0 }, akm: { pitch: 0, up: 0, fwd: 0 } }));
  assert.equal(s.glock.pitch, 30, 'serialize clamps');
});

test('URL escape hatch maps gripPitch → pitch, gripY → up, gripZ → −fwd', () => {
  assert.deepEqual(adjFromUrl({ pitchDeg: 5, y: 0.01, z: -0.02 }), { pitch: 5, up: 0.01, fwd: 0.02 });
  assert.deepEqual(adjFromUrl({ pitchDeg: 90, y: 0.2, z: 0 }), { pitch: 30, up: 0.04, fwd: -0 });
});

test('AKM support target: the hands line runs within 1.5° of the bore (pitch)', () => {
  const { palm } = fit('akm');
  const dy = AKM_SUPPORT_TARGET[1] - palm[1], dz = AKM_SUPPORT_TARGET[2] - palm[2];
  const ang = Math.abs(Math.atan2(dy, -dz)) * 180 / Math.PI;   // vs gun −Z, in the vertical plane
  assert.ok(ang < 1.5, `hands line ${ang.toFixed(2)}° off the bore`);
});

test('magazine in the left hand: the Glock magazine sits where it does in a held Glock (mirrored)', () => {
  const { pose } = fit('glock');
  const seat = toGrip(pose, MANIFEST.weapons.glock.magLocalSeat);
  near([-seat[0], seat[1], seat[2]], Array.from(MAG_IN_LEFT.glock.pos), 0.002, 'Glock magazine');
});

test('computeFit allocates nothing (sampling heap profiler, GunFit.js frames only)', async () => {
  const pose = new Float64Array(7), palm = new Float64Array(3), adj = { pitch: 3, up: 0.01, fwd: 0 };
  let i = 0;
  const run = (n) => { for (let k = 0; k < n; k++, i++) { adj.pitch = (i % 60) - 30; computeFit(i & 1 ? 'akm' : 'glock', adj, pose, palm); } };
  run(200000);
  let best = Infinity;
  for (let r = 0; r < 8 && best > 0; r++) { // best of up to 8 (early exit): a JIT deopt under load is one-off, a real allocation shows every time
    globalThis.gc?.();
    run(20000);
    const ses = new Session();
    ses.connect();
    await ses.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    run(100000);
    const { profile } = await ses.post('HeapProfiler.stopSampling');
    ses.disconnect();
    let b = 0;
    const walk = (n) => { if (n.callFrame.url.endsWith('/src/weapons/GunFit.js')) b += n.selfSize; for (const c of n.children) walk(c); };
    walk(profile.head);
    best = Math.min(best, b);
  }
  assert.equal(best, 0, `${best} bytes`);
});
