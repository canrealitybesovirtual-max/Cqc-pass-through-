/**
 * SafeSpot (src/safety/SafeSpot.js) on real worlds (WorldCore: the house
 * fixture and synthetic rooms): the clearance rule (r + 0.3), the reach rule
 * (no mapped box within r + 0.8), "which way to step", confirming, and the
 * radius shrinking in a cramped room.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { WorldCore } from '../../src/world/WorldCore.js';
import { MAX_BUCKET, SECTOR_NAMES, SPOT, SPOT_STATUS as ST, STEP_LINES, SafeSpot } from '../../src/safety/SafeSpot.js';
import { segmentHitsFootprint } from '../../src/safety/geom.js';
import { house, room } from './safety.rooms.js';

const DT = 1 / 72;

/** Run the spot choice standing at (x, z) facing (fx, fz) for `s` seconds. */
function stand(S, w, x, z, s = 0.3, { fx = 0, fz = -1, down = false, held = false } = {}) {
  let ok = false;
  const n = Math.max(1, Math.round(s / DT));
  for (let i = 0; i < n && !ok; i++) ok = S.update(DT, w, x, z, fx, fz, down && i === n - 1, held);
  return ok;
}

test('the rules: clear needs clearance ≥ r + 0.3 and no mapped box within r + 0.8', () => {
  const w = room(-3, -3, 3, 3);
  const S = new SafeSpot();
  assert.equal(S.evaluate(w, 0, 0, 0.8), ST.CLEAR, 'centre of a 6 × 6 m room');
  assert.ok(S.lastClearance > 2.5 && S.lastNearest > 2.5);
  // the reach rule: 1.6 m from the west wall face (x = −3) is the limit
  assert.equal(S.evaluate(w, -1.35, 0, 0.8), ST.CLEAR);
  assert.equal(S.evaluate(w, -1.45, 0, 0.8), ST.TIGHT);
  assert.ok(Math.abs(S.lastNearest - 1.55) < 0.02, `nearest ${S.lastNearest}`);
  // the clearance rule: 1.1 m (cell-accurate)
  assert.equal(S.evaluate(w, -1.8, 0, 0.8), ST.TIGHT);
  assert.equal(S.evaluate(w, -2.0, 0, 0.8), ST.BLOCKED);
  // a smaller ring needs less
  assert.equal(S.evaluate(w, -1.5, 0, 0.6), ST.CLEAR);
  // furniture counts for both rules; a high shelf (starting above 2.2 m) does not count for reach
  const f = room(-3, -3, 3, 3, [['table', 0, 0, 0.6, 0.4, 0.75]]);
  assert.equal(S.evaluate(f, 0, 0, 0.8), ST.BLOCKED, 'standing in the table footprint');
  assert.equal(S.evaluate(f, 0, 1.2, 0.8), ST.BLOCKED, 'clearance 0.8 m to the table');
  assert.equal(S.evaluate(f, 0, 1.6, 0.8), ST.TIGHT, 'clearance ok, table within reach');
  // outside every floor
  assert.equal(S.evaluate(w, 9, 9, 0.8), ST.OFFMAP);
  // no map: the virtual room
  const v = new WorldCore();
  v.build(null, { x: 0, z: 0 });
  assert.equal(S.evaluate(v, 0, 0, 0.8), ST.UNMAPPED);
  assert.equal(S.evaluate(null, 0, 0, 0.8), ST.UNMAPPED);
});

test('confirming: clear and unmapped with a trigger pull; tight only by holding 1 s; blocked never', () => {
  const w = room(-3, -3, 3, 3, [['table', 0, 0, 0.6, 0.4, 0.75]]);
  const S = new SafeSpot();
  S.begin(0.8);
  assert.equal(stand(S, w, 0, 1.2, 1, { held: true, down: true }), false, 'blocked: the trigger does nothing');
  assert.equal(S.status, ST.BLOCKED);
  assert.equal(stand(S, w, 0, 1.6, 0.3, { down: true }), false, 'tight: a pull is not enough');
  assert.equal(S.status, ST.TIGHT);
  assert.equal(stand(S, w, 0, 1.6, SPOT.acceptTightS - 0.1, { held: true }), false);
  assert.equal(stand(S, w, 0, 1.6, 0.15, { held: true }), true, 'held 1 s: accepted');
  assert.equal(S.confirmed, true);
  assert.equal(S.x, 0);
  assert.equal(S.z, 1.6);
  assert.equal(S.update(DT, w, 0, 1.6, 0, -1, true, true), false, 'once');

  const c = room(-3, -3, 3, 3);
  S.begin(0.8);
  assert.equal(stand(S, c, 0, 0, 0.2), false);
  assert.equal(S.update(DT, c, 0.1, -0.2, 1, 0, true, false), true, 'clear: one pull');
  assert.ok(Math.abs(S.facing - Math.PI / 2) < 1e-9, 'facing +x as a yaw (0 = +z)');
  const v = new WorldCore();
  v.build(null, { x: 0, z: 0 });
  S.begin(0.8);
  assert.equal(S.update(DT, v, 0, 0, 0, -1, false, false), false);
  assert.equal(S.status, ST.UNMAPPED);
  assert.equal(S.update(DT, v, 0, 0, 0, -1, true, false), true);
});

test('which way to step: from against a wall, toward the nearest clear spot, relative to the heading', () => {
  const w = room(-3, -3, 3, 3);
  const S = new SafeSpot();
  S.begin(0.8);
  // 0.5 m from the west wall, facing −z: the open room is to the right (+x)
  stand(S, w, -2.5, 0, 0.3);
  assert.equal(S.status, ST.BLOCKED);
  assert.equal(S.hasStep, true);
  assert.equal(SECTOR_NAMES[S.sector], 'right');
  assert.equal(S.evaluate(w, S.stepX, S.stepZ, S.r), ST.CLEAR, 'the suggestion is a clear spot');
  assert.ok(S.stepDist > 1.0 && S.stepDist < 1.4, `step ${S.stepDist}`);
  assert.equal(STEP_LINES[S.sector][S.bucket], `Step right ${(S.bucket / 10).toFixed(1)} m`);
  // facing +x instead: the same spot is forward
  stand(S, w, -2.5, 0, 0.1, { fx: 1, fz: 0 });
  assert.equal(SECTOR_NAMES[S.sector], 'forward');
  // facing +z: it is to the left
  stand(S, w, -2.5, 0, 0.1, { fx: 0, fz: 1 });
  assert.equal(SECTOR_NAMES[S.sector], 'left');
  // walk along the arrow: it gets shorter and ends clear (no step)
  let x = -2.5, steps = 0;
  while (S.status !== ST.CLEAR && steps < 400) {
    stand(S, w, x, 0, DT);
    if (S.hasStep) x += Math.sign(S.stepX - x) * 0.6 * DT;
    steps++;
  }
  assert.equal(S.status, ST.CLEAR, `clear after ${(steps * DT).toFixed(1)} s at x ${x.toFixed(2)}`);
  assert.equal(S.hasStep, false);
  // a corner: the step goes diagonally out of it
  S.begin(0.8);
  stand(S, w, 2.6, 2.6, 0.3);
  assert.equal(S.status, ST.BLOCKED);
  assert.equal(SECTOR_NAMES[S.sector], 'forward and left', 'facing −z from the +x +z corner: the room is ahead and to the left');
});

test('a suggested walk never crosses furniture, and the house fixture start gets a usable spot', () => {
  const w = room(-3, -3, 3, 3, [['table', 0, 0, 0.6, 0.4, 0.75]]);
  const S = new SafeSpot();
  S.begin(0.8);
  stand(S, w, 0, 0.9, 0.3); // south of the table, too close
  assert.equal(S.status, ST.BLOCKED);
  assert.equal(S.hasStep, true);
  const t = w.shapes.box, ti = w.shapes.label.indexOf('table');
  assert.ok(ti >= 0);
  assert.equal(segmentHitsFootprint(t, ti * 8, 0, 0.9, S.stepX, S.stepZ, 0.05), false, 'not through the table');

  // the fixture: the player starts 1 m from the south wall, the couch and table within reach everywhere
  const h = new WorldCore();
  h.build(house(), { x: 0, z: 0 });
  S.begin(0.8);
  stand(S, h, 0, 0, 0.3);
  assert.equal(S.status, ST.BLOCKED, 'clearance 0.95 m < 1.1 m');
  assert.equal(S.hasStep, true);
  const target = S.evaluate(h, S.stepX, S.stepZ, S.r);
  assert.ok(target === ST.TIGHT || target === ST.CLEAR, 'a usable spot');
  assert.ok(S.stepDist < 1.0, `${S.stepDist} m`);
  // there: usable; hold the trigger to accept it
  const px = S.stepX, pz = S.stepZ;
  stand(S, h, px, pz, 0.3);
  assert.equal(S.status, ST.TIGHT);
  assert.equal(stand(S, h, px, pz, 1.1, { held: true }), true);
  assert.equal(S.x, px);
  assert.equal(S.z, pz);
});

test('a cramped room: the ring shrinks (not below 0.5 m) until a spot works', () => {
  // 2 m wide: the clearance in the middle is ~0.95 m < r + 0.3 = 1.1
  const w = room(0, 0, 2, 6);
  const S = new SafeSpot();
  S.begin(0.8);
  stand(S, w, 1, 3, 0.05);
  assert.equal(S.status, ST.BLOCKED);
  stand(S, w, 1, 3, 2);
  assert.ok(S.r < 0.8 && S.r >= SPOT.minR, `r ${S.r}`);
  // usable here, or a short step to a usable spot
  if (S.status !== ST.TIGHT && S.status !== ST.CLEAR) {
    assert.equal(S.hasStep, true, `status ${S.status} at r ${S.r} and no step`);
    const st = S.evaluate(w, S.stepX, S.stepZ, S.r);
    assert.ok(st === ST.TIGHT || st === ST.CLEAR);
    assert.ok(S.stepDist < 0.5);
  }
  // a closet: never below 0.5 m
  const c = room(0, 0, 1, 1);
  S.begin(0.8);
  stand(S, c, 0.5, 0.5, 3);
  assert.equal(S.r, SPOT.minR);
  assert.equal(S.status, ST.BLOCKED);
});

test('step lines are prebuilt for every sector and distance', () => {
  assert.equal(STEP_LINES.length, 8);
  for (const row of STEP_LINES) assert.equal(row.length, MAX_BUCKET + 1);
  assert.equal(STEP_LINES[4][6], 'Step back 0.6 m');
  assert.equal(STEP_LINES[1][30], 'Step forward and right 3.0 m');
});

test('per-frame update allocates nothing (sampling heap profiler)', async () => {
  const h = new WorldCore();
  h.build(house(), { x: 0, z: 0 });
  const S = new SafeSpot();
  S.begin(0.8);
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      const a = i * 0.002;
      S.update(DT, h, 0.4 * Math.cos(a), -0.3 + 0.4 * Math.sin(a), Math.sin(a), -Math.cos(a), false, (i % 300) < 50);
    }
  };
  loop(20000);
  let best = Infinity, by = null;
  for (let r = 0; r < 3 && best > 0; r++) {
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(20000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const files = ['/src/safety/SafeSpot.js', '/src/safety/geom.js', '/src/world/NavGrid.js'];
    const walk = (n) => {
      if (n.selfSize > 0 && files.some((f) => n.callFrame.url.endsWith(f))) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  assert.ok(S.evaluations > 100000, 'the search ran');
  assert.equal(best, 0, JSON.stringify(by));
});
