/**
 * Roam safety (no fixed zone): running is a warning, not a pause; the edge of
 * the map and obstacles are diegetic cue levels; off the map freezes enemies
 * without a pause; sitting is never a hazard; PauseManager still pauses for
 * tracking and visibility. ObstacleWarnings' Roam thresholds (door jambs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUE, CUE_NAMES, ROAM_SAFETY, RoamSafety } from '../../src/safety/RoamSafety.js';
import { PAUSE, PauseManager } from '../../src/safety/PauseManager.js';
import { OBSTACLE, ObstacleWarnings, POINT } from '../../src/safety/ObstacleWarnings.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { SHAPE_JAMB, SHAPE_WALL } from '../../src/world/Shapes.js';
import { readFileSync } from 'node:fs';

const DT = 1 / 72;
const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

test('cue kinds are the watch warning kinds, in its order', () => {
  assert.deepEqual([...CUE_NAMES], ['run', 'edge', 'obstacle', 'stairs', 'tracking']);
  assert.equal(CUE.TRACKING, 4);
});

test('running: a watch cue from 0.9 m/s (0.25 → 1 at 1.5), off below 0.75, counted; never a pause', () => {
  const rs = new RoamSafety();
  const step = (speed, n = 10) => { for (let i = 0; i < n; i++) rs.update(DT, true, true, 0, 0, speed, 99, 0, false, true, 1); };
  step(0.8);
  assert.equal(rs.cue[CUE.RUN], 0);
  step(0.9);
  assert.ok(Math.abs(rs.cue[CUE.RUN] - ROAM_SAFETY.runMin) < 1e-6);
  step(1.5);
  assert.equal(rs.cue[CUE.RUN], 1);
  step(0.8);
  assert.ok(rs.cue[CUE.RUN] > 0, 'hysteresis: still on at 0.8');
  step(0.7);
  assert.equal(rs.cue[CUE.RUN], 0);
  assert.equal(rs.runWarnings, 1);
  assert.equal(rs.freeze, false);
  // the PauseManager in Roam: running sets `running` but never pauses
  const pm = new PauseManager({ runPause: false });
  let x = 0;
  for (let i = 0; i < 144; i++) { x += 1.6 * DT; pm.setHead(x, 0); pm.update(DT, true); }
  assert.equal(pm.running, true);
  assert.equal(pm.paused, false);
  assert.equal(pm.pauseCounts[6], 0);
  // spot play keeps the pause
  const pm2 = new PauseManager();
  x = 0;
  for (let i = 0; i < 144; i++) { x += 1.6 * DT; pm2.setHead(x, 0); pm2.update(DT, true); }
  assert.equal(pm2.paused, true);
  assert.equal(pm2.cause, PAUSE.RUNNING);
});

test('tracking loss and visibility still pause in Roam', () => {
  const pm = new PauseManager({ runPause: false });
  pm.setHead(0, 0);
  pm.update(DT, true);
  pm.setTracking(false);
  pm.update(DT, true);
  assert.equal(pm.paused, true);
  assert.equal(pm.cause, PAUSE.TRACKING);
  const pm2 = new PauseManager({ runPause: false });
  pm2.setVisible(false);
  pm2.update(DT, true);
  assert.equal(pm2.cause, PAUSE.HIDDEN);
  const rs = new RoamSafety();
  rs.update(DT, true, true, 0, 0, 0, 99, 0, false, false, 1);
  assert.equal(rs.cue[CUE.TRACKING], 1);
});

test('edge of the map: 0 beyond 0.9 m, rising to 1 at 0.35 m, 1 off the map; freeze only 0.3 m beyond it', () => {
  const rs = new RoamSafety();
  const at = (m) => { rs.update(DT, true, true, 0, 0, 0, m, 0, false, true, 1); return rs.cue[CUE.EDGE]; };
  assert.equal(at(2), 0);
  assert.equal(at(0.91), 0);
  assert.ok(at(0.6) > 0.4 && at(0.6) < 0.7);
  assert.equal(at(0.35), 1);
  assert.equal(at(-0.1), 1);
  assert.equal(rs.freeze, false, 'just off the map: a cue, no freeze');
  at(-0.35);
  assert.equal(rs.freeze, true, '0.35 m off: enemies freeze');
  at(-0.25);
  assert.equal(rs.freeze, true, 'hysteresis');
  at(-0.1);
  assert.equal(rs.freeze, false);
  assert.equal(at(99), 0, 'no edge known');
  assert.equal(rs.offMapEvents, 1);
  assert.ok(rs.offMapS > 0);
});

test('seated: no run, edge or obstacle cue, no freeze; counted as seated time', () => {
  const rs = new RoamSafety();
  for (let i = 0; i < 72; i++) rs.update(DT, true, true, 0, 0, 1.4, -1, 0.9, true, true, 2);
  assert.equal(rs.cue[CUE.RUN], 0);
  assert.equal(rs.cue[CUE.EDGE], 0);
  assert.equal(rs.cue[CUE.OBSTACLE], 0);
  assert.equal(rs.freeze, false);
  assert.ok(Math.abs(rs.seatedS - 1) < 1e-6);
  const rep = rs.report();
  assert.ok(rep.seatedS > 0.99);
  assert.deepEqual(rep.roomsVisited, [2]);
});

test('diagnostics: walked metres, speed quantiles, rooms visited; idle outside a round', () => {
  const rs = new RoamSafety();
  let x = 0;
  for (let i = 0; i < 720; i++) { x += 1.0 * DT; rs.update(DT, true, true, x, 0, 1.0, 99, 0, false, true, i < 360 ? 3 : 4); }
  const rep = rs.report();
  assert.ok(Math.abs(rep.walkedM - 10) < 0.05, `walked ${rep.walkedM}`);
  assert.ok(Math.abs(rep.speed.p50 - 1.0) <= 0.05 && Math.abs(rep.speed.p95 - 1.0) <= 0.05);
  assert.deepEqual(rep.roomsVisited, [3, 4]);
  assert.equal(rep.roomChanges, 1);
  rs.update(DT, false, true, x + 5, 0, 1.0, -1, 1, false, true, 4);
  assert.equal(rs.cue[CUE.EDGE], 0, 'no cues outside a round');
  assert.doesNotThrow(() => JSON.stringify(rep));
});

test('ObstacleWarnings Roam: a door jamb at 0.3 m is fine, other boxes warn at 0.35 m; head → cue, not both hands', () => {
  // two boxes: a jamb piece and a plain wall piece, 1 m tall slabs along x
  const box = new Float32Array([0, 0, 1, 0, 0.5, 0.05, 0, 2.5, 0, 5, 1, 0, 0.5, 0.05, 0, 2.5]);
  const shapes = { box, count: 2, flags: new Uint8Array([SHAPE_WALL | SHAPE_JAMB, SHAPE_WALL]) };
  const ow = new ObstacleWarnings({ roam: true });
  ow.setPoint(POINT.HEAD, 0, 1.6, 0.35); // 0.30 m from the jamb's face
  ow.update(DT, shapes, null);
  assert.equal(ow.headNear, false, 'jamb at 0.30 m: no warning');
  assert.equal(ow.headLevel, 0);
  ow.setPoint(POINT.HEAD, 0, 1.6, 0.2); // 0.15 m
  ow.update(DT, shapes, null);
  assert.equal(ow.headNear, true);
  assert.ok(ow.headLevel > 0.3 && ow.headLevel < 0.5);
  assert.equal(ow.pulseHead, true);
  assert.equal(ow.pulseL || ow.pulseR, false, 'Roam: the head does not buzz both hands');
  assert.equal(ow.count, 0, 'no outline in Roam');
  const ow2 = new ObstacleWarnings({ roam: true });
  ow2.setPoint(POINT.HEAD, 0, 1.6, 5.35); // 0.30 m from the plain wall
  ow2.update(DT, shapes, null);
  assert.equal(ow2.headNear, true, 'plain wall at 0.30 m warns');
  // spot play: 0.4 m and both hands
  const ow3 = new ObstacleWarnings();
  ow3.setPoint(POINT.HEAD, 0, 1.6, 0.4);
  ow3.update(DT, shapes, null);
  assert.equal(ow3.headNear, true);
  assert.equal(ow3.pulseL && ow3.pulseR, true);
  assert.equal(OBSTACLE.head, 0.4);
});

test('the real world: shapes carry jamb flags; walking through the fixture door gives no obstacle warning', () => {
  const w = new WorldCore({ roam: true });
  w.build(house(), { x: 0, z: 0 });
  const S = w.shapes;
  let jambs = 0;
  for (let i = 0; i < S.count; i++) if (S.flags[i] & SHAPE_JAMB) jambs++;
  assert.ok(jambs >= 4, `${jambs} jamb pieces`);
  const ow = new ObstacleWarnings({ roam: true });
  let near = 0;
  // living room → bedroom through the 0.85 m door at x 3.0–3.1, z −2.6…−1.75 (centre z −2.175)
  for (let x = 2.0; x <= 4.2; x += 0.02) {
    ow.setPoint(POINT.HEAD, x, 1.65, -2.175);
    ow.update(DT, S, null);
    if (ow.headNear) near++;
  }
  assert.equal(near, 0, 'a centred walk through the door is clean');
});
