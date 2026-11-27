/**
 * ObstacleWarnings (src/safety/ObstacleWarnings.js) and the box geometry
 * (src/safety/geom.js) on real worlds: scripted hand and head paths toward
 * mapped walls and furniture (hand 0.25 m, head 0.4 m, 5 cm hysteresis),
 * haptic scheduling, the hand-reach pulse beyond r + 0.7 m, and the outline
 * vertices written for SafetyView's single LineSegments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { OBSTACLE, OUTLINE_VERTS, ObstacleWarnings, POINT, writeOutlines } from '../../src/safety/ObstacleWarnings.js';
import { BOX_STRIDE, boxDistance, footprintDistance, nearestFootprint, segmentHitsFootprint, walkClear } from '../../src/safety/geom.js';
import { houseWorld, room } from './safety.rooms.js';

const DT = 1 / 72;

test('geometry: distances to a yawed box, the closest point, footprint segments', () => {
  // a 1.2 × 0.8 m box at (1, 2), yawed 30°, 0…0.75 m
  const a = Math.PI / 6;
  const B = new Float32Array([1, 2, Math.cos(a), Math.sin(a), 0.6, 0.4, 0, 0.75]);
  const out = new Float64Array(3);
  assert.equal(boxDistance(B, 0, 1, 0.3, 2, out), 0, 'inside');
  // 0.5 m beyond the +x face along the box's own x axis, at table height
  const px = 1 + Math.cos(a) * 1.1, pz = 2 + Math.sin(a) * 1.1;
  assert.ok(Math.abs(boxDistance(B, 0, px, 0.5, pz, out) - 0.5) < 1e-6);
  assert.ok(Math.abs(out[0] - (1 + Math.cos(a) * 0.6)) < 1e-6 && Math.abs(out[2] - (2 + Math.sin(a) * 0.6)) < 1e-6);
  // above the top: vertical distance counts
  assert.ok(Math.abs(boxDistance(B, 0, 1, 1.75, 2) - 1.0) < 1e-6);
  assert.ok(Math.abs(footprintDistance(B, 0, px, pz) - 0.5) < 1e-6);
  // y0 = −Infinity (furniture extruded from a top plane) is fine
  const T = new Float32Array([0, 0, 1, 0, 0.5, 0.5, -Infinity, 0.7]);
  assert.ok(Math.abs(boxDistance(T, 0, 0.8, -5, 0) - 0.3) < 1e-6);
  // segments
  assert.equal(segmentHitsFootprint(B, 0, -1, 2, 3, 2, 0), true, 'through it');
  assert.equal(segmentHitsFootprint(B, 0, -1, 4, 3, 4, 0), false, 'beside it');
  assert.equal(segmentHitsFootprint(B, 0, -1, 2, -0.5, 2, 0), false, 'stops short');
  // shapes-level helpers
  const shapes = { box: new Float32Array([...B, ...T]), count: 2 };
  const idx = new Int32Array(1);
  assert.ok(Math.abs(nearestFootprint(shapes, 0, 1, 2.2, idx) - 0.5) < 1e-6);
  assert.equal(idx[0], 1);
  // only boxes starting below maxY count: with maxY 0 the table-like box (y0 = 0) drops out
  assert.ok(Math.abs(nearestFootprint(shapes, px, pz, 0, idx) - footprintDistance(T, 0, px, pz)) < 1e-6);
  assert.equal(idx[0], 1);
  assert.equal(nearestFootprint(shapes, px, pz, -Infinity, idx), Infinity);
  assert.equal(idx[0], -1);
  assert.equal(walkClear(shapes, -2, 2, 3, 2, 1, 0.1), false);
  assert.equal(walkClear(shapes, 0.55, 0, 3, -3, 1, 0.1), true, 'a box the start touches is ignored');
  assert.equal(BOX_STRIDE, 8);
});

/** Move the right grip along a path; returns per-frame snapshots. */
function handPath(ow, shapes, pts, zone = null) {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  const log = [];
  for (const [x, y, z] of pts) {
    m[12] = x; m[13] = y; m[14] = z;
    ow.setGrip(POINT.RIGHT, m);
    ow.update(DT, shapes, zone);
    log.push({ x, near: ow.near[POINT.RIGHT] === 1, pulse: ow.pulseR, pulseL: ow.pulseL, any: ow.any, count: ow.count, d: ow.dist[POINT.RIGHT] });
  }
  return log;
}

test('a hand walking to a wall: near at 0.25 m, one pulse on entry then every 0.6 s, clear beyond 0.30 m', () => {
  const w = room(-3, -3, 3, 3);
  const ow = new ObstacleWarnings();
  // toward the east wall face (x = 3) at 1.2 m, 1 m/s
  const pts = [];
  for (let x = 2.0; x <= 2.9; x += 1 / 72) pts.push([x, 1.2, 0.3]);
  const log = handPath(ow, w.shapes, pts);
  const first = log.findIndex((f) => f.near);
  assert.ok(first > 0);
  assert.ok(log[first].d < OBSTACLE.hand && log[first - 1].d >= OBSTACLE.hand, `near at ${log[first].d}`);
  assert.ok(Math.abs(log[first].d - (3 - log[first].x)) < 1e-4, 'distance to the wall face');
  assert.equal(log[first].pulse, true, 'haptic on entry');
  assert.equal(log[first].pulseL, false, 'only on the hand that is near');
  assert.equal(log[first].any, true, 'enemies freeze');
  assert.equal(log[first].count, 1, 'one outline');
  // staying near: a pulse every 0.6 s
  const stay = [];
  for (let i = 0; i < 72 * 2; i++) stay.push([2.85, 1.2, 0.3]);
  const s = handPath(ow, w.shapes, stay);
  const pulses = s.filter((f) => f.pulse).length;
  assert.equal(pulses, 3, `${pulses} pulses in 2 s`);
  // backing off: still near until beyond 0.30 m (hysteresis), then clear
  const back = [];
  for (let x = 2.85; x >= 2.5; x -= 0.005) back.push([x, 1.2, 0.3]);
  const b = handPath(ow, w.shapes, back);
  const clear = b.findIndex((f) => !f.near);
  assert.ok(b[clear].d >= OBSTACLE.hand + OBSTACLE.hyst - 1e-9 && b[clear - 1].d < OBSTACLE.hand + OBSTACLE.hyst, `clear at ${b[clear].d}`);
  assert.equal(b[clear].count, 0);
  assert.equal(b[clear].any, false);
  // coming back in at 0.27 m: not near yet (enter at 0.25)
  const again = handPath(ow, w.shapes, [[2.73, 1.2, 0.3]]);
  assert.equal(again[0].near, false);
});

test('the head within 0.4 m of a mapped box: near, both hands pulse; the outline marks the wall patch at the face', () => {
  const w = room(-3, -3, 3, 3);
  const ow = new ObstacleWarnings();
  let firstX = NaN, pulsedBoth = false;
  for (let x = 2.0; x <= 2.8; x += 0.005) {
    ow.setPoint(POINT.HEAD, x, 1.6, -1);
    ow.update(DT, w.shapes);
    if (ow.headNear && firstX !== firstX) { firstX = x; pulsedBoth = ow.pulseL && ow.pulseR; }
  }
  assert.ok(Math.abs(3 - firstX - OBSTACLE.head) < 0.006, `head near at ${3 - firstX} m`);
  assert.equal(pulsedBoth, true);
  assert.equal(ow.count, 1);
  assert.equal(ow.owner[0], POINT.HEAD);
  const pos = new Float32Array(4 * OUTLINE_VERTS * 3);
  const n = writeOutlines(pos, ow, w.shapes, (x, z) => w.floorY(x, z));
  assert.equal(n, 12, 'a wall patch: 4 edges + a cross');
  let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(pos[i * 3] - (3 - 0.005)) < 1e-4, 'on the room side of the east face');
    minZ = Math.min(minZ, pos[i * 3 + 2]); maxZ = Math.max(maxZ, pos[i * 3 + 2]);
    minY = Math.min(minY, pos[i * 3 + 1]); maxY = Math.max(maxY, pos[i * 3 + 1]);
  }
  assert.ok(Math.abs(minZ - (-1 - OBSTACLE.wallHalf)) < 1e-4 && Math.abs(maxZ - (-1 + OBSTACLE.wallHalf)) < 1e-4, `patch z ${minZ}…${maxZ}`);
  assert.ok(Math.abs(minY - w.floorY(2.9, -1)) < 1e-4 && maxY <= w.floorY(2.9, -1) + OBSTACLE.maxHeight + 1e-4);
  // near a corner the patch is clipped to the wall piece
  ow.reset();
  ow.setPoint(POINT.HEAD, 2.8, 1.6, 2.85);
  ow.update(DT, w.shapes);
  assert.equal(ow.count, 2, 'both walls of the corner');
  assert.ok(ow.odist[0] <= ow.odist[1], 'nearest first');
});

test('furniture: the 12 box edges from the floor; the head over a table; inside a box; at most 4 outlines', () => {
  const w = room(-3, -3, 3, 3, [['table', 0, 0, 0.6, 0.4, 0.75], ['shelf', 0, 1.1, 0.4, 0.15, 1.8], ['couch', -1.2, 0, 0.4, 0.9, 0.85]]);
  const ow = new ObstacleWarnings();
  // the right hand low over the table edge
  handPath(ow, w.shapes, [[0.7, 0.85, 0]]);
  assert.equal(ow.count, 1);
  const ti = w.shapes.label.indexOf('table');
  assert.equal(ow.boxes[0], ti);
  const pos = new Float32Array(4 * OUTLINE_VERTS * 3);
  const n = writeOutlines(pos, ow, w.shapes, (x, z) => w.floorY(x, z));
  assert.equal(n, 24, '12 edges');
  const ys = new Set();
  for (let i = 0; i < n; i++) {
    ys.add(Math.round(pos[i * 3 + 1] * 100) / 100);
    assert.ok(Math.abs(Math.abs(pos[i * 3]) - 0.6) < 1e-4 && Math.abs(Math.abs(pos[i * 3 + 2]) - 0.4) < 1e-4, 'on the corners');
  }
  assert.deepEqual([...ys].sort(), [0, 0.75], 'floor to the top');
  // the head bent over the table, 0.35 m above its top (the right hand away from everything)
  ow.setPoint(POINT.HEAD, 0.1, 1.1, 0);
  handPath(ow, w.shapes, [[0.1, 1.5, -2.2]]);
  assert.equal(ow.headNear, true);
  // a hand inside the table box
  handPath(ow, w.shapes, [[0, 0.5, 0]]);
  assert.equal(ow.inside, true);
  // the hand between table, shelf and couch, the head near the shelf, the left hand near the couch
  ow.setPoint(POINT.HEAD, 0.2, 1.4, 0.75);
  const m = new Float32Array(16);
  m[12] = -0.7; m[13] = 0.8; m[14] = 0.5;
  ow.setGrip(POINT.LEFT, m);
  handPath(ow, w.shapes, [[0.1, 0.9, 0.55]]);
  assert.ok(ow.count >= 3 && ow.count <= OBSTACLE.maxOutlines, `${ow.count} outlines`);
  const set = new Set(Array.from(ow.boxes.slice(0, ow.count)));
  assert.equal(set.size, ow.count, 'distinct boxes');
  const v = writeOutlines(pos, ow, w.shapes, (x, z) => w.floorY(x, z));
  assert.ok(v <= pos.length / 3);
  // no map, or no points: nothing
  ow.reset();
  ow.clearPoint(POINT.HEAD); ow.clearPoint(POINT.LEFT); ow.clearPoint(POINT.RIGHT);
  ow.update(DT, w.shapes);
  assert.equal(ow.any, false);
  ow.setPoint(POINT.HEAD, 0, 0.5, 0);
  ow.update(DT, null);
  assert.equal(ow.any, false);
  assert.equal(ow.inside, false);
});

test('a hand beyond r + 0.7 m from the zone centre pulses (no outline); the house fixture couch and doorway jamb', () => {
  const w = room(-3, -3, 3, 3);
  const ow = new ObstacleWarnings();
  const zone = { x: 0, z: 0, r: 0.8 };
  const pts = [];
  for (let x = 1.0; x <= 1.7; x += 0.01) pts.push([x, 1.2, 0]);
  const log = handPath(ow, w.shapes, pts, zone);
  const first = log.findIndex((f) => f.pulse);
  assert.ok(Math.abs(pts[first][0] - 1.5) < 0.011, `pulse at ${pts[first][0]}`);
  assert.equal(log[first].count, 0);
  assert.equal(log[first].any, false, 'no freeze for reach alone');

  const h = houseWorld();
  // the left hand reaching to the couch arm (couch x −1.95…−1.05): 0.2 m from its +x side
  const hw = new ObstacleWarnings();
  const m = new Float32Array(16);
  m[12] = -0.85; m[13] = 0.6; m[14] = -1.5;
  hw.setGrip(POINT.LEFT, m);
  hw.update(DT, h.shapes);
  assert.equal(hw.near[POINT.LEFT], 1);
  assert.equal(h.shapes.label[hw.boxes[0]], 'couch');
  assert.equal(hw.pulseL, true);
  // a hand in the hallway doorway gap (x −1.6…−0.7 in the wall z = −3) is near a jamb, not the gap
  hw.reset();
  m[12] = -1.15; m[13] = 1.0; m[14] = -3.0;
  hw.setGrip(POINT.LEFT, m);
  hw.update(DT, h.shapes);
  assert.equal(hw.near[POINT.LEFT], 0, 'the opening itself is free');
  m[12] = -0.8;
  hw.setGrip(POINT.LEFT, m);
  hw.update(DT, h.shapes);
  assert.equal(hw.near[POINT.LEFT], 1, 'the jamb');
});

test('per-frame update allocates nothing (sampling heap profiler)', async () => {
  const h = houseWorld();
  const ow = new ObstacleWarnings();
  const zone = { x: 0, z: 0, r: 0.8 };
  const m = new Float32Array(16), pos = new Float32Array(4 * OUTLINE_VERTS * 3);
  const fy = (x, z) => h.floorY(x, z);
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      const a = i * 0.01;
      ow.setPoint(POINT.HEAD, 0.5 * Math.cos(a), 1.2 + 0.4 * Math.sin(a * 0.3), 0.6 + 0.4 * Math.sin(a));
      m[12] = 0.8 * Math.cos(a * 1.3); m[13] = 1.0; m[14] = 0.5 + 0.6 * Math.sin(a * 1.3);
      ow.setGrip(POINT.RIGHT, m);
      m[12] = -1.0 + 0.2 * Math.sin(a); m[14] = -1.0;
      ow.setGrip(POINT.LEFT, m);
      ow.update(DT, h.shapes, zone);
      if (ow.count) writeOutlines(pos, ow, h.shapes, fy);
    }
  };
  loop(120000); // warm every branch; a deopted frame boxes doubles in the interpreter
  let best = Infinity, by = null;
  for (let r = 0; r < 5 && best > 0; r++) {
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(30000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && (u.endsWith('/src/safety/ObstacleWarnings.js') || u.endsWith('/src/safety/geom.js'))) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  assert.ok(ow.warnings > 10, `the paths did reach obstacles (${ow.warnings})`);
  assert.equal(best, 0, JSON.stringify(by));
});
