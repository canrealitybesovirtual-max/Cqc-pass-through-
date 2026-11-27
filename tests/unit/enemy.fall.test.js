// Death-fall direction (src/enemies/Fall.js) on the real world module built from
// tests/fixtures/house.json: living room x −2…3, z −3…1 (couch x −1.95…−1.05,
// z −2.4…−0.6, 0.85 m high; table at (1.4, −1.8)), bedroom x 3.1…6.6 behind a door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorldCore } from '../../src/world/WorldCore.js';
import { FALL, FALL_FULL, chooseFall, fallScore } from '../../src/enemies/Fall.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const w = new WorldCore();
w.build(house(), { x: 0, z: 0 });

/** Is the whole 1.2 m line along (dx, dz) from (x, z) on floor and clear of walls and furniture? */
function clearFall(x, z, dx, dz) {
  const fy = w.floorY(x, z);
  for (let k = 1; k <= 12; k++) {
    const d = (k / 12) * FALL.len;
    const i = w.nav.index(x + dx * d, z + dz * d);
    if (i < 0 || w.nav.clr[i] < 0.05) return false;
  }
  return w.segmentClear(x, fy + 0.3, z, x + dx * FALL.len, fy + 0.3, z + dz * FALL.len);
}

test('open floor: he falls along the shot (with its scatter)', () => {
  const out = new Float64Array(3);
  const k = chooseFall(w, 0.5, -0.6, 1, 0, 0.2, out);
  assert.equal(k, 0, 'the scattered shot direction is clear');
  assert.ok(Math.abs(Math.atan2(out[1], out[0]) - 0.2) < 1e-9, 'scatter applied');
  assert.equal(out[2], FALL_FULL);
  assert.ok(Math.abs(Math.hypot(out[0], out[1]) - 1) < 1e-9);
});

test('shot toward the couch: he falls the other way, never onto it', () => {
  const out = new Float64Array(3);
  // standing 0.4 m in front of the couch's end, shot from the room toward it (−z)
  const k = chooseFall(w, -1.5, -0.2, 0, -1, 0, out);
  assert.ok(fallScore(w, -1.5, -0.2, 0, 0, -1) < FALL_FULL, 'straight on is blocked by the couch');
  assert.ok(!w.segmentClear(-1.5, 0.3, -0.2, -1.5, 0.3, -1.4), 'the couch is a real obstacle there');
  assert.ok(k >= 2, `turned (candidate ${k})`);
  assert.equal(out[2], FALL_FULL);
  assert.ok(clearFall(-1.5, -0.2, out[0], out[1]), `clear along (${out[0].toFixed(2)}, ${out[1].toFixed(2)})`);
  assert.ok(out[1] > -0.6, 'not onto the couch');
});

test('shot toward a wall half a metre away: he does not fall through it', () => {
  const out = new Float64Array(3);
  for (const [x, z, dx, dz] of [[0, 0.5, 0, 1], [2.5, -1, 1, 0], [-1.4, 0.45, 0.2, 1], [0.6, -2.5, 0, -1]]) {
    chooseFall(w, x, z, dx, dz, 0.3, out);
    assert.equal(out[2], FALL_FULL, `(${x}, ${z}) shot (${dx}, ${dz}): a clear direction was found`);
    assert.ok(clearFall(x, z, out[0], out[1]), `(${x}, ${z}): falls along (${out[0].toFixed(2)}, ${out[1].toFixed(2)})`);
    assert.ok(out[0] * dx + out[1] * dz < 0.9, 'not straight into the wall');
  }
});

test('a tight spot with no clear 1.2 m: the best of the candidates, and no NaN on bad input', () => {
  const out = new Float64Array(3);
  // in the living room's corner (−2, 1), walls 0.35 m away on two sides, the couch's end 1.25 m behind:
  // shot into the wall; back toward the shooter reaches the couch, the sides reach the walls
  const k = chooseFall(w, -1.65, 0.65, 0, 1, 0, out);
  assert.equal(k, 4, 'back toward the shooter: the most floor');
  assert.ok(out[2] > fallScore(w, -1.65, 0.65, 0, 0, 1) && out[2] < FALL_FULL, `score ${out[2]}`);
  assert.ok(Math.abs(out[0]) < 1e-9 && Math.abs(out[1] + 1) < 1e-9);
  // zero or NaN direction, NaN scatter, no world
  for (const [dx, dz, sc] of [[0, 0, 0], [NaN, 1, 0], [1, 0, NaN]]) {
    chooseFall(w, 0.5, -0.6, dx, dz, sc, out);
    assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[1]) && Math.abs(Math.hypot(out[0], out[1]) - 1) < 1e-9, `${dx}, ${dz}, ${sc}`);
  }
  assert.equal(chooseFall(null, 0, 0, 0, 2, 0, out), 0);
  assert.deepEqual([out[0], out[1]], [0, 1]);
});

test('virtual room (no Space Setup): every direction is clear, so the shot direction is kept', () => {
  const v = new WorldCore();
  v.build(null, { x: 0, z: 0 });
  const out = new Float64Array(3);
  assert.equal(chooseFall(v, 3, 1, -1, 0.5, 0.1, out), 0);
  assert.equal(out[2], FALL_FULL);
});

test('choosing a fall does not allocate', () => {
  const out = new Float64Array(3);
  const P = new Float64Array(4);
  let n = 0;
  const run = (m) => { for (let i = 0; i < m; i++) { P[0] = -1.8 + (i % 47) * 0.1; P[1] = -2.8 + (i % 37) * 0.1; n += chooseFall(w, P[0], P[1], Math.cos(i), Math.sin(i), 0.1, out); } };
  run(20000);
  // least growth over 3 windows (one can catch JIT tiering or GC timing under parallel test load)
  let grew = Infinity;
  for (let k = 0; k < 3 && grew / 20000 >= 64; k++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    run(20000);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  // a death is an event, not a frame; still, no objects per call (boxed doubles only)
  assert.ok(grew / 20000 < 64, `${(grew / 20000).toFixed(1)} B per choice`);
  assert.ok(n >= 0);
});
