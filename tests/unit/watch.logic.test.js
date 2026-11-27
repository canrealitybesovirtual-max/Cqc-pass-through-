/**
 * src/ui/watchLogic.js: the watch's pure rules (orientation basis, wake
 * hysteresis, tap / press gates, two-tap confirm, menu hit-test, gun-fit
 * editing, bezel clicks, hand angles, warning vibration patterns, sounds).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH, GRIP_IN_RAY, watchOffset, WakeGate, TapGate, PressGate, PRESS, Confirm, handAngles, BezelTurn, BEZEL_CLICKS,
  WarnPlan, WARN, warnCode, PAGE, ROW, PAGE_ROWS, hitMenu, rowRect, MENU_PX, isValueRow, needsConfirm,
  FitEdit, FIT_FIELD, weaponIndex, stateCode, STATE, modeCode, infoCode, INFO, synthTick, synthAlert, numStr, degStr, mmStr,
} from '../../src/ui/watchLogic.js';

const DT = 1 / 72;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── small column-major 3×3 helpers ──────────────────────────────────────────
/** column k of a column-major 4×4 */
const col = (m, k) => [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** R·v for a column-major 3×3 given as three column vectors */
const mul = (X, Y, Z, v) => [X[0] * v[0] + Y[0] * v[1] + Z[0] * v[2], X[1] * v[0] + Y[1] * v[1] + Z[1] * v[2], X[2] * v[0] + Y[2] * v[1] + Z[2] * v[2]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };

/**
 * Ray frame in world from a pointing direction and the thumb side
 * (ray −Z = pointing, ray +Y = thumb / top of the controller).
 */
function rayFrame(fwd, top) {
  const Z = norm(fwd.map((x) => -x));
  let Y = top.slice();
  const d = dot(Y, Z);
  Y = norm(Y.map((y, i) => y - d * Z[i]));
  const X = cross(Y, Z);
  return { X, Y, Z };
}

test('basis: right-handed, unit at scale 1, research offset (4.3 cm out, 9 cm back, 15° tilt)', () => {
  const m = watchOffset({}, new Float32Array(16));
  const X = col(m, 0), Y = col(m, 1), Z = col(m, 2);
  assert.ok(close(Math.hypot(...X), 1) && close(Math.hypot(...Y), 1) && close(Math.hypot(...Z), 1));
  assert.ok(close(dot(X, Y), 0) && close(dot(Y, Z), 0) && close(dot(X, Z), 0));
  const c = cross(X, Y);
  assert.ok(close(c[0], Z[0]) && close(c[1], Z[1]) && close(c[2], Z[2]), 'X × Y = Z (no mirror)');
  assert.deepEqual(X.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, -1], '3 o\'clock toward the fingers (ray −Z)');
  const t = (15 * Math.PI) / 180;
  assert.ok(close(m[12], -0.043 * Math.cos(t)) && close(m[13], 0.043 * Math.sin(t)) && close(m[14], 0.09));
  const big = watchOffset({ scale: 1.2, tiltDeg: 0 }, new Float32Array(16));
  assert.ok(close(Math.hypot(...col(big, 0)), 1.2, 1e-6));
  assert.ok(close(big[8], -1.2) && close(big[9], 0));
});

test('orientation: in the watch-check pose (forearm across the chest, palm down) 12 is away from you, 3 toward the hand, the dial faces up', () => {
  // world: +X right, +Y up, viewer at +Z looking −Z and down. Left forearm across the chest pointing right (+X),
  // palm down → the back of the hand up, the thumb toward the body (+Z).
  const R = rayFrame([1, 0, 0], [0, 0, 1]);
  const m = watchOffset({}, new Float32Array(16));
  const three = mul(R.X, R.Y, R.Z, col(m, 0)), twelve = mul(R.X, R.Y, R.Z, col(m, 1)), n = mul(R.X, R.Y, R.Z, col(m, 2));
  assert.ok(three[0] > 0.99, `3 o'clock → +X (toward the hand): ${three}`);
  assert.ok(twelve[2] < -0.9, `12 → −Z (away from the viewer): ${twelve}`);
  assert.ok(n[1] > 0.9, `dial normal up: ${n}`);
  assert.ok(n[2] > 0.2, `tilted toward the viewer: ${n}`);
  // seen from the eye above and behind (+Z, +Y), the text baseline (3 o'clock) runs left → right on screen and 12 points up the screen
  const view = norm([0, -0.8, -0.6]); // looking down and forward
  const right = norm(cross(view, [0, 1, 0]));
  const up = cross(right, view);
  assert.ok(dot(three, right) > 0.95, 'text reads left to right');
  assert.ok(dot(twelve, up) > 0.5, '12 is at the top of the view (not upside down)');
});

test('orientation: the v0.2 screenshot pose gave text turned 180°; the new basis is upright when the wrist is turned to the eyes', () => {
  // v0.2 basis in grip space: right = −Y, up = +Z (WristHud). Screenshot pose (861af4ee): controller pointing up-left,
  // back of the hand to the eye, thumb toward the middle (research-cqc §1: −179.8°).
  const R = rayFrame([-Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]);
  const G = GRIP_IN_RAY.left;
  const gX = col(G, 0), gY = col(G, 1), gZ = col(G, 2);
  const gripX = mul(R.X, R.Y, R.Z, gX), gripY = mul(R.X, R.Y, R.Z, gY), gripZ = mul(R.X, R.Y, R.Z, gZ);
  const oldRight = gripY.map((v) => -v);
  const oldUp = gripZ;
  // camera looks −Z: screen right +X, up +Y
  const ang = (v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  assert.ok(Math.abs(Math.abs(ang(oldRight)) - 180) < 15, `old baseline angle ${ang(oldRight).toFixed(1)}° (upside down)`);
  void oldUp; void gripX;
  // the new basis in the same pose: the dial faces the viewer (+Z) and 12 points … along the controller (−Y_ray): down
  const m = watchOffset({}, new Float32Array(16));
  const three = mul(R.X, R.Y, R.Z, col(m, 0)), n = mul(R.X, R.Y, R.Z, col(m, 2));
  assert.ok(n[2] > 0.9, 'faces the viewer');
  // like a real watch on a raised forearm: 3 o'clock points along the forearm toward the hand (up-left here),
  // so the text runs up the arm instead of upside down; turning the wrist to the check pose makes it level (previous test)
  assert.ok(three[0] < -0.6 && three[1] > 0.6, `3 o'clock toward the hand: ${three}`);
});

test('GRIP_IN_RAY: the same 45° pitch relation as WeaponSystem (rotation, unit columns)', () => {
  for (const side of ['left', 'right']) {
    const G = GRIP_IN_RAY[side];
    for (let k = 0; k < 3; k++) assert.ok(close(Math.hypot(...col(G, k)), 1, 2e-4), `${side} col ${k}`);
    assert.ok(close(col(G, 1)[1], Math.SQRT1_2, 1e-4), 'grip +Y half up, half back');
  }
});

test('wake: needs 0.12 s facing + looked at within 0.6 m; sleeps after 0.35 s outside wider limits; a glance does not wake', () => {
  const W = new WakeGate();
  const good = [Math.cos(0.2), Math.cos(0.2), 0.35];
  let got = 0;
  for (let i = 0; i < 6; i++) got += W.update(DT, ...good);
  assert.equal(W.awake, false, '6 frames (83 ms) is a glance');
  for (let i = 0; i < 4; i++) got += W.update(DT, ...good);
  assert.equal(W.awake, true);
  assert.equal(got, 1);
  // 45° away: still awake (sleep limit 55°)
  for (let i = 0; i < 72; i++) W.update(DT, Math.cos((45 * Math.PI) / 180), Math.cos(0.3), 0.4);
  assert.equal(W.awake, true, 'hysteresis');
  // turned away for 0.3 s: still awake; 0.4 s: asleep
  for (let i = 0; i < 21; i++) W.update(DT, 0.1, 0.9, 0.4);
  assert.equal(W.awake, true);
  let off = 0;
  for (let i = 0; i < 8; i++) off += W.update(DT, 0.1, 0.9, 0.4);
  assert.equal(W.awake, false);
  assert.equal(off, -1);
  // too far: never wakes
  for (let i = 0; i < 72; i++) W.update(DT, 1, 1, 0.65);
  assert.equal(W.awake, false);
  // NaN distance while awake → sleeps
  for (let i = 0; i < 20; i++) W.update(DT, ...good);
  assert.equal(W.awake, true);
  for (let i = 0; i < 30; i++) W.update(DT, 1, 1, NaN);
  assert.equal(W.awake, false);
});

test('tap gate: fires once on entry from outside, never when the tip starts inside, re-arms only past 4 cm / 4.5 cm', () => {
  const T = new TapGate();
  assert.equal(T.update(0, 0, 0.01, true), false, 'already inside at start: disarmed');
  assert.equal(T.update(0, 0, 0.01, true), false);
  assert.equal(T.update(0, 0, 0.05, true), false, 'leaves (z > 4.5 cm): arms');
  assert.equal(T.update(0, 0, 0.03, true), false, 'z 3 cm: not yet');
  assert.equal(T.update(0.01, 0, 0.02, true), true, 'enters at z 2 cm');
  assert.equal(T.update(0.01, 0, 0.01, true), false, 'once');
  assert.equal(T.update(0.035, 0, 0.03, true), false, 'r 3.5 cm, z 3 cm: still disarmed');
  assert.equal(T.update(0.045, 0, 0.0, true), false, 'r 4.5 cm: arms');
  assert.equal(T.update(0.0, 0, 0.0, false), false, 'disabled (asleep, hand busy)');
  assert.equal(T.update(0.0, 0, 0.0, true), false, 'enabled while resting inside: no tap (it must leave first)');
  assert.equal(T.update(0.0, 0, 0.05, true), false, 'leaves');
  assert.equal(T.update(0.0, 0, 0.0, true), true, 'comes back: tap');
  assert.equal(T.update(0, 0, -0.03, true), false, 'behind the dial');
});

test('press gate (menu): hover under 8 cm, press under 6 mm once, re-arm above 2.5 cm or outside', () => {
  const P = new PressGate();
  assert.equal(P.update(true, 0.0), PRESS.HOVER, 'starts disarmed: hover only');
  assert.equal(P.update(true, 0.03), PRESS.HOVER, 'z 3 cm: arms, hovers');
  assert.equal(P.update(true, 0.1), PRESS.NONE, 'too far to hover');
  assert.equal(P.update(true, 0.01), PRESS.HOVER);
  assert.equal(P.update(true, 0.005), PRESS.PRESS);
  assert.equal(P.update(true, 0.0), PRESS.HOVER, 'held in: no repeat');
  assert.equal(P.update(true, 0.02), PRESS.HOVER, 'z 2 cm: still disarmed');
  assert.equal(P.update(true, 0.004), PRESS.HOVER);
  assert.equal(P.update(false, 0.004), PRESS.NONE, 'outside: arms');
  assert.equal(P.update(true, 0.004), PRESS.PRESS);
  assert.equal(P.update(true, -0.05), PRESS.NONE, 'far behind the disc');
});

test('two-tap confirm: a second tap on the same row within 3 s; another row or a late tap starts over', () => {
  const C = new Confirm();
  assert.equal(C.tap(ROW.EXIT, 10), false);
  assert.equal(C.pending(ROW.EXIT, 11), true);
  assert.equal(C.tap(ROW.EXIT, 12.9), true);
  assert.equal(C.pending(ROW.EXIT, 13), false);
  assert.equal(C.tap(ROW.RESTART, 20), false);
  assert.equal(C.tap(ROW.EXIT, 21), false, 'another row');
  assert.equal(C.tap(ROW.EXIT, 24.5), false, 'late');
  assert.equal(C.tap(ROW.EXIT, 25), true);
  assert.ok(needsConfirm(ROW.RESTART) && needsConfirm(ROW.EXIT) && needsConfirm(ROW.RESET) && !needsConfirm(ROW.RESUME));
});

test('menu layout: 7 rows per page inside the disc, hit-test by row and by − / + zones', () => {
  const r = { x0: 0, x1: 0, y0: 0, y1: 0 };
  for (let i = 0; i < 7; i++) {
    rowRect(i, r);
    for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) {
      assert.ok(Math.hypot(x - MENU_PX.c, y - MENU_PX.c) < MENU_PX.r - 10, `row ${i} corner inside the disc`);
    }
    assert.ok(r.x1 - r.x0 > 220, `row ${i} wide enough (${(r.x1 - r.x0).toFixed(0)} px)`);
  }
  assert.equal(PAGE_ROWS[PAGE.MAIN].length, 7);
  assert.equal(PAGE_ROWS[PAGE.FIT].length, 7);
  const h = { row: -1, index: -1, zone: 0 };
  rowRect(0, r);
  assert.equal(hitMenu(PAGE.MAIN, 256, (r.y0 + r.y1) / 2, h), ROW.RESUME);
  rowRect(6, r);
  assert.equal(hitMenu(PAGE.MAIN, 256, (r.y0 + r.y1) / 2, h), ROW.EXIT);
  assert.equal(hitMenu(PAGE.MAIN, 256, 40, h), -1, 'status strip');
  rowRect(1, r);
  assert.equal(hitMenu(PAGE.FIT, r.x0 + 5, (r.y0 + r.y1) / 2, h), ROW.PITCH);
  assert.equal(h.zone, -1);
  assert.equal(hitMenu(PAGE.FIT, r.x1 - 5, (r.y0 + r.y1) / 2, h), ROW.PITCH);
  assert.equal(h.zone, 1);
  assert.equal(hitMenu(PAGE.FIT, 256, (r.y0 + r.y1) / 2, h), ROW.PITCH);
  assert.equal(h.zone, 0);
  assert.ok(isValueRow(ROW.HEIGHT) && !isValueRow(ROW.SAVE));
});

test('gun fit: stick dead zone and cubic response, clamps, ticks every 1° / 5 mm, taps step 0.5° / 1 mm, save and revert per gun', () => {
  const F = new FitEdit();
  F.set('glock', 2, 0.004, -0.002);
  F.set('akm', -1, 0, 0);
  assert.deepEqual([...F.values(0) && [F.out.weapon, F.out.pitchDeg, F.out.up, F.out.fwd]], ['glock', 2, 0.004, -0.002]);
  assert.equal(F.stick(DT, -0.1), 0, 'dead zone');
  // full up for 1 s: +20°/s on pitch → clamped at +20
  let ticks = 0;
  for (let i = 0; i < 72; i++) if (F.stick(DT, -1) === 2) ticks++;
  assert.ok(close(F.cur[0][0], 20, 1e-6), `clamped at the limit: ${F.cur[0][0]}`);
  assert.ok(ticks >= 17 && ticks <= 18, `a tick per degree (${ticks})`);
  // half deflection is slow (cubic)
  F.field = FIT_FIELD.UP;
  const u0 = F.cur[0][1];
  for (let i = 0; i < 72; i++) F.stick(DT, -0.575);
  const du = F.cur[0][1] - u0;
  assert.ok(du > 0.002 && du < 0.004, `half stick ≈ 1/8 speed: ${du}`);
  // taps
  F.nudge(FIT_FIELD.FWD, 1);
  assert.ok(close(F.cur[0][2], -0.001));
  assert.equal(F.field, FIT_FIELD.FWD);
  F.nudge(FIT_FIELD.PITCH, -1);
  assert.ok(close(F.cur[0][0], 19.5));
  assert.ok(F.dirty(0) && !F.dirty(1));
  // revert: back to the saved values; save keeps
  assert.equal(F.revert(), 1);
  assert.ok(close(F.cur[0][0], 2) && close(F.cur[0][1], 0.004) && close(F.cur[0][2], -0.002));
  F.select('akm');
  F.nudge(FIT_FIELD.PITCH, 1);
  assert.equal(F.save(), 2);
  assert.ok(!F.dirty(1));
  assert.equal(F.values().weapon, 'akm');
  assert.ok(close(F.values().pitchDeg, -0.5));
  F.reset();
  assert.deepEqual([...F.cur[1]], [0, 0, 0]);
  assert.equal(weaponIndex('g17'), 0);
  assert.equal(weaponIndex('rifle'), -1);
  // limits from the table
  F.select(0); F.field = FIT_FIELD.FWD;
  for (let i = 0; i < 72 * 3; i++) F.stick(DT, 1);
  assert.ok(close(F.cur[0][2], -WATCH.fitLimits.fwd));
});

test('hand angles: local time, clockwise, seconds in 8 beats per second', () => {
  const o = [0, 0, 0];
  const turn = (a) => -a / (2 * Math.PI);
  handAngles(Date.UTC(2026, 10, 27, 10, 30, 0), 0, o);
  assert.ok(close(turn(o[0]), 10.5 / 12) && close(turn(o[1]), 0.5) && close(turn(o[2]), 0));
  // UTC−5 (getTimezoneOffset = +300): 10:30 UTC is 05:30 local
  handAngles(Date.UTC(2026, 10, 27, 10, 30, 0), 300, o);
  assert.ok(close(turn(o[0]), 5.5 / 12));
  // beats: 0.124 s → still 0; 0.125 s → 1/8 s
  handAngles(Date.UTC(2026, 0, 1, 0, 0, 0) + 124, 0, o);
  assert.equal(turn(o[2]), 0);
  handAngles(Date.UTC(2026, 0, 1, 0, 0, 0) + 125, 0, o);
  assert.ok(close(turn(o[2]), 0.125 / 60));
  assert.ok(o.every((a) => a <= 0), 'clockwise = negative about +Z');
});

test('bezel: counter-clockwise only, whole clicks, pip meets the minute hand, clicks counted for the sound', () => {
  const B = new BezelTurn(0.35);
  assert.equal(B.alignTo(0.25), 90, 'pip from 0 to 15 min: 90 clicks CCW (unidirectional)');
  let n = 0, prev = B.pos, mono = true;
  for (let i = 0; i < 40; i++) { n += B.update(DT); if (B.pos < prev - 1e-9) mono = false; prev = B.pos; }
  assert.equal(n, 90);
  assert.ok(mono, 'never turns back');
  assert.ok(close(B.pipTurn, 0.25));
  assert.equal(B.alignTo(0.25), 0, 'already there');
  assert.equal(B.alignTo(0.2), 6, 'pip from 15 to 12 min: 6 clicks CCW');
  for (let i = 0; i < 40; i++) B.update(DT);
  assert.ok(close(B.pipTurn, 0.2));
  assert.ok(B.pos >= 0 && B.pos < BEZEL_CLICKS, 'kept small');
  // a new target while turning continues from where it is
  B.alignTo(0.5);
  B.update(0.1);
  const mid = B.pos;
  B.alignTo(0.75);
  for (let i = 0; i < 40; i++) B.update(DT);
  assert.ok(close(B.pipTurn, 0.75));
  assert.ok(mid >= 0);
});

test('warnings: highest priority plays, patterns per kind, obstacle ticks speed up with the level, clear stops', () => {
  const W = new WarnPlan();
  assert.equal(W.update(DT), false);
  assert.ok(W.set('run', 1));
  assert.equal(W.set('nonsense', 1), false);
  let pulses = 0;
  for (let i = 0; i < 72 * 3.2; i++) if (W.update(DT)) pulses++;
  assert.equal(pulses, 4, 'run: da-da every 1.6 s → 2 patterns in 3.2 s');
  W.set('tracking', 1);
  assert.equal(W.pick(), WARN.TRACKING);
  pulses = 0;
  let ms = 0;
  for (let i = 0; i < 72 * 3; i++) if (W.update(DT)) { pulses++; ms = W.ms; }
  assert.equal(pulses, 1, 'tracking: one long pulse every 3 s');
  assert.equal(ms, 90);
  W.clear();
  W.set(WARN.OBSTACLE, 0.2);
  let slow = 0;
  for (let i = 0; i < 72 * 4; i++) if (W.update(DT)) slow++;
  W.set('obstacle', 1);
  let fast = 0, amp = 0;
  for (let i = 0; i < 72 * 4; i++) if (W.update(DT)) { fast++; amp = W.amp; }
  assert.ok(fast > slow * 3, `closer = faster (${slow} → ${fast} in 4 s)`);
  assert.ok(amp > 0.6);
  W.set('obstacle', 0);
  assert.equal(W.pick(), -1);
  assert.equal(warnCode('wall'), WARN.OBSTACLE);
  assert.equal(warnCode(9), -1);
});

test('codes: state names, fire modes, info-line priority', () => {
  assert.equal(stateCode('over'), STATE.DOWN);
  assert.equal(stateCode('spot'), STATE.SPOT);
  assert.equal(stateCode(undefined), STATE.NONE);
  assert.deepEqual(['safe', 'semi', 'auto', null].map(modeCode), [1, 2, 3, 0]);
  assert.equal(infoCode(WARN.RUN, STATE.PAUSED, true, true), INFO.WARN);
  assert.equal(infoCode(-1, STATE.PAUSED, true, true), INFO.STATE);
  assert.equal(infoCode(-1, STATE.WAVE, true, true), INFO.SCAN);
  assert.equal(infoCode(-1, STATE.WAVE, false, true), INFO.HINT);
  assert.equal(infoCode(-1, STATE.WAVE, false, false), INFO.KILLS);
  assert.equal(infoCode(-1, STATE.NONE, false, false), INFO.NONE);
});

test('sounds: a 20 ms decaying square tick and two quiet beeps, within ±1', () => {
  const t = synthTick(48000);
  assert.equal(t.length, 960);
  assert.ok(t.every((v) => Math.abs(v) <= 0.35 + 1e-6));
  assert.ok(Math.abs(t[100]) > Math.abs(t[900]), 'decays');
  const a = synthAlert(48000);
  assert.ok(a.length > 48000 * 0.2 && a.every((v) => Math.abs(v) <= 0.23));
  const mid = Math.round(48000 * 0.11);
  assert.equal(a[mid], 0, 'silent gap between the beeps');
});

test('cached strings: numbers, degrees, millimetres', () => {
  assert.equal(numStr(17), '17');
  assert.equal(numStr(-3), '0');
  assert.equal(numStr(5000), '999');
  assert.equal(degStr(2.3), '+2.5°');
  assert.equal(degStr(-0.2), '0.0°');
  assert.equal(degStr(-7), '−7.0°');
  assert.equal(mmStr(0.0034), '+3 mm');
  assert.equal(mmStr(-0.0121), '−12 mm');
  assert.equal(degStr(2.3), degStr(2.4), 'same cached instance');
});

test('menu spot: in the watch\'s direction, raised, at reading distance, never above eye level or too low', async () => {
  const { menuSpot } = await import('../../src/ui/watchLogic.js');
  const o = [0, 0, 0];
  const M = WATCH.menu;
  const deg = (p) => (Math.asin((1.6 - p[1]) / M.dist) * 180) / Math.PI;
  // watch 35 cm away, 50° down, to the left-front
  menuSpot(0, 1.6, 0, -0.1, 1.6 - 0.27, -0.2, o);
  assert.ok(close(Math.hypot(o[0], o[1] - 1.6, o[2]), M.dist));
  assert.ok(close(deg(o), 50 - M.raiseDeg, 0.5), `${deg(o)}° down`);
  assert.ok(o[0] < 0 && o[2] < 0 && close(o[0] / o[2], 0.5, 1e-6), 'same direction');
  // a watch held at eye level: the disc stays below the line of sight
  menuSpot(0, 1.6, 0, 0, 1.62, -0.3, o);
  assert.ok(close(deg(o), M.downMin, 1e-6));
  // a watch straight below the eye: a defined direction, at most downMax
  menuSpot(0, 1.6, 0, 0, 1.0, 0, o);
  assert.ok(Number.isFinite(o[0]) && deg(o) <= M.downMax + 1e-6);
});
