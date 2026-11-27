/**
 * Slots.js and Handling.js (pure): carry state machine, grab timing, grab
 * zones, the magazine well, rack fraction, the draw's trigger gate, thigh
 * check and the haptics rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Carry, GrabSense, SLOTS, pointDist, segmentDist, arcPoint,
  CARRY_SLOT, CARRY_DRAW, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP, CARRY_SHRINK, CARRY_GROW,
  EV_NONE, EV_IN_HAND, EV_STOWED, EV_RETURNING, EV_RETURNED,
} from '../../src/player/Slots.js';
import {
  HANDLING, MagWell, MAG_FREE, MAG_GUIDED, rackFraction, TriggerGate, segSegDist, boreAtThighs, HapticGate,
} from '../../src/player/Handling.js';

const DT = 1 / 90;
/** Run until `pred` or `max` s; returns the events seen. */
function runCarry(c, secs) {
  const ev = [];
  for (let t = 0; t < secs; t += DT) { const e = c.update(DT); if (e !== EV_NONE) ev.push(e); }
  return ev;
}

test('draw: slot → 0.15 s blend → hand', () => {
  const c = new Carry();
  assert.equal(c.state, CARRY_SLOT);
  assert.ok(c.grabbable && c.inSlot && !c.inHand);
  assert.equal(c.blend, 0);
  assert.ok(c.grab());
  assert.equal(c.state, CARRY_DRAW);
  assert.ok(c.inHand && !c.grabbable);
  c.update(0.05);
  assert.ok(c.blend > 0.3 && c.blend < 1, `eased blend ${c.blend}`);
  assert.deepEqual(runCarry(c, 0.12), [EV_IN_HAND]);
  assert.equal(c.state, CARRY_HAND);
  assert.equal(c.blend, 1);
  assert.equal(c.grab(), false, 'cannot grab a gun already in the hand');
});

test('let go near the slot: 0.34 s arc into the slot', () => {
  const c = new Carry();
  c.grab(); runCarry(c, 0.2);
  assert.ok(c.release(true));
  assert.equal(c.state, CARRY_HOLSTER);
  assert.equal(c.inHand, false);
  c.update(SLOTS.holsterS / 2);
  assert.ok(Math.abs(c.blend - 0.5) < 1e-9, 'smoothstep midpoint');
  const ev = runCarry(c, 0.2);
  assert.deepEqual(ev, [EV_STOWED]);
  assert.equal(c.state, CARRY_SLOT);
});

test('let go elsewhere: falls 0.3 s, shrinks, grows back in the slot (scale only)', () => {
  const c = new Carry();
  c.grab(); runCarry(c, 0.2);
  c.release(false);
  assert.equal(c.state, CARRY_DROP);
  assert.equal(c.scale, 1);
  runCarry(c, SLOTS.returnDelayS - 0.02);
  assert.equal(c.state, CARRY_DROP, 'still falling at 0.28 s');
  while (c.state === CARRY_DROP) c.update(0.001);
  assert.equal(c.state, CARRY_SHRINK);
  c.update(SLOTS.shrinkS / 2);
  assert.ok(c.scale > 0.3 && c.scale < 0.7);
  const ev = runCarry(c, 0.3);
  assert.deepEqual(ev, [EV_RETURNING, EV_RETURNED]);
  assert.equal(c.state, CARRY_SLOT);
  assert.equal(c.scale, 1);
});

test('grabbing it while it grows back in the slot works; lost tracking auto-holsters', () => {
  const c = new Carry();
  c.grab(); runCarry(c, 0.2); c.release(false);
  for (let t = 0; t < 0.45 && c.state !== CARRY_GROW; t += DT) c.update(DT);
  assert.equal(c.state, CARRY_GROW);
  assert.ok(c.grab());
  runCarry(c, 0.2);
  c.lost();
  assert.equal(c.state, CARRY_HOLSTER);
  c.stow();
  assert.equal(c.state, CARRY_SLOT);
  assert.equal(c.update(NaN), EV_NONE);
});

test('grab timing: squeeze now, or squeezed within 150 ms before arriving; one grab per press', () => {
  const g = new GrabSense();
  g.update(DT, true, true);
  assert.ok(g.wantsGrab, 'squeeze rose this frame');
  for (let t = 0; t < 0.14; t += DT) g.update(DT, false, true);
  assert.ok(g.wantsGrab, 'still armed at 140 ms');
  for (let t = 0; t < 0.03; t += DT) g.update(DT, false, true);
  assert.equal(g.wantsGrab, false, 'a fist held longer does not grab on arrival');
  g.update(DT, false, false);
  g.update(DT, true, true);
  assert.ok(g.wantsGrab);
  g.consume();
  assert.equal(g.wantsGrab, false, 'consumed');
});

test('entry ticks fire once per entry and per zone', () => {
  const g = new GrabSense();
  assert.equal(g.enter(1, false), false);
  assert.equal(g.enter(1, true), true);
  assert.equal(g.enter(1, true), false);
  assert.equal(g.enter(2, true), true, 'another zone');
  assert.equal(g.enter(1, false), false);
  assert.equal(g.enter(1, true), true, 're-entry ticks again');
});

test('grab zones: point and capsule distances; holster arc bow', () => {
  assert.ok(Math.abs(pointDist(0.1, 0, 0, [0, 0, 0]) - 0.1) < 1e-12);
  const a = [0, 1, 0], u = [0, 1, 0];
  assert.ok(Math.abs(segmentDist(0.1, 1.1, 0, a, u, 0.2) - 0.1) < 1e-12, 'beside the segment');
  assert.ok(Math.abs(segmentDist(0, 1.5, 0, a, u, 0.2) - 0.3) < 1e-12, 'past its end');
  assert.ok(Math.abs(segmentDist(0, 0.9, 0, a, u, 0.2) - 0.1) < 1e-12, 'before its start');
  const out = [0, 0, 0];
  arcPoint([0, 0, 0], [1, 0, 0], 0.5, [0, 0, 1], out, 0);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-12 && Math.abs(out[2] - SLOTS.bow) < 1e-12, 'bow peaks mid-way');
  arcPoint([0, 0, 0], [1, 0, 0], 1, [0, 0, 1], out, 0);
  assert.ok(Math.abs(out[0] - 1) < 1e-12 && Math.abs(out[2]) < 1e-12, 'ends on the slot');
});

test('magazine well: capture window, guided push, home', () => {
  const W = new MagWell(0.15), ax = 0, ay = 1, az = 0;
  // 10 cm below, 2 cm off: captured (pistol window 0.15)
  assert.equal(W.update(0.02, -0.10, 0, ax, ay, az, 0.95), MAG_GUIDED);
  assert.equal(W.home, false);
  assert.ok(Math.abs(W.along + 0.1) < 1e-12 && Math.abs(W.lateral - 0.02) < 1e-12);
  // pushed up (still a little off-line)
  W.update(0.03, -0.05, 0, ax, ay, az, 0.9);
  assert.equal(W.state, MAG_GUIDED);
  W.update(0.03, -0.011, 0, ax, ay, az, 0.9);
  assert.ok(W.home, 'pushed home within 12 mm of the seat');
});

test('magazine well: rejected outside 3 cm, too far below, misaligned; leaving frees it', () => {
  const W = new MagWell(0.07);
  assert.equal(W.update(0.031, -0.02, 0, 0, 1, 0, 1), MAG_FREE, 'too far sideways');
  assert.equal(W.update(0, -0.08, 0, 0, 1, 0, 1), MAG_FREE, 'below a rifle window');
  assert.equal(W.update(0, 0.03, 0, 0, 1, 0, 1), MAG_FREE, 'above the seat');
  assert.equal(W.update(0, -0.02, 0, 0, 1, 0, 0.69), MAG_FREE, 'dot 0.69');
  assert.equal(W.update(0, -0.02, 0, 0, 1, 0, 0.71), MAG_GUIDED);
  assert.equal(W.update(0.05, -0.02, 0, 0, 1, 0, 0.9), MAG_FREE, 'pulled 5 cm sideways: free');
  assert.equal(W.update(0, -0.02, 0, 0, 1, 0, 0.9), MAG_GUIDED, 'can re-enter');
  W.block();
  assert.equal(W.update(0, -0.02, 0, 0, 1, 0, 0.9), MAG_FREE, 'blocked until it leaves');
  W.update(0, -0.2, 0, 0, 1, 0, 0.9);
  assert.equal(W.blocked, false);
  assert.equal(W.update(0, -0.02, 0, 0, 1, 0, 0.9), MAG_GUIDED);
});

test('magazine well: tilted well axis (Glock) measures along the axis', () => {
  const W = new MagWell(0.15), a = [0, 0.94716, -0.32075];
  const d = -0.06;
  assert.equal(W.update(a[0] * d, a[1] * d, a[2] * d, a[0], a[1], a[2], 0.99), MAG_GUIDED);
  assert.ok(Math.abs(W.along - d) < 1e-5 && W.lateral < 1e-5);
});

test('rack fraction follows the hand and clamps', () => {
  assert.equal(rackFraction(0.05, 0.05, 0.0358), 0);
  assert.ok(Math.abs(rackFraction(0.05 + 0.0358 * 0.9, 0.05, 0.0358) - 0.9) < 1e-12);
  assert.equal(rackFraction(0.2, 0.05, 0.0358), 1);
  assert.equal(rackFraction(-1, 0.05, 0.0358), 0);
  assert.equal(rackFraction(NaN, 0, 1), 0);
});

test('trigger gate: closed after a draw until the trigger was low, the muzzle cleared the slot and it is off the thighs', () => {
  const g = new TriggerGate();
  assert.ok(g.update(1, 0, true), 'open when not armed');
  g.arm();
  assert.equal(g.update(0.9, 0.5, false), false, 'trigger held through the draw');
  assert.equal(g.update(0.1, 0.1, false), false, 'trigger low, muzzle still at the holster');
  assert.equal(g.update(0.9, 0.3, true), false, 'cleared but pointing at a thigh');
  assert.equal(g.update(0.9, 0.3, false), true, 'then opens (trigger was seen low)');
  assert.equal(g.update(0.9, 0.0, true), true, 'stays open');
});

test('bore-at-thigh check', () => {
  const thighs = [-0.09, 0.93, 0, -0.09, 0.5, -0.05, 0.09, 0.93, 0, 0.09, 0.5, -0.05];
  // muzzle by the right hip pointing straight down along the right thigh
  assert.ok(boreAtThighs({ x: 0.12, y: 1.0, z: 0 }, { x: 0, y: -1, z: 0 }, thighs));
  // pointing forward from chest height
  assert.equal(boreAtThighs({ x: 0.12, y: 1.3, z: -0.3 }, { x: 0, y: 0, z: -1 }, thighs), false);
  // segment distance basics
  assert.ok(Math.abs(segSegDist(0, 0, 0, 1, 0, 0, 1, [0.5, 1, -1, 0.5, 1, 1], 0) - 1) < 1e-9);
  assert.ok(Math.abs(segSegDist(0, 0, 0, 1, 0, 0, 1, [2, 0, 0, 3, 0, 0], 0) - 1) < 1e-9, 'end to end');
});

test('haptics: knocks cut weaker pulses, ticks never cut a running pulse', () => {
  const h = new HapticGate();
  assert.ok(h.allow(0, 1.0, 45));
  assert.equal(h.allow(0.01, 0.28, 12), false, 'catch tick during the shot buzz');
  assert.equal(h.allow(0.02, 0.75, 26), false, 'a weaker knock does not cut a stronger one');
  assert.ok(h.allow(0.05, 0.28, 12), 'after it ended');
  assert.ok(h.allow(0.055, 0.55, 22), 'a knock cuts a weaker running tick');
  assert.equal(h.allow(0.06, 0, 10), false);
  h.reset();
  assert.ok(h.allow(0.06, 0.08, 10));
});

test('handling numbers are the contract / CQC values', () => {
  assert.equal(HANDLING.rackReach, 0.085);
  assert.equal(HANDLING.magLateral, 0.03);
  assert.equal(HANDLING.magDot, 0.7);
  assert.equal(HANDLING.assistS, 1.2);
  assert.equal(SLOTS.grabReach, 0.13);
  assert.equal(SLOTS.slotReach, 0.24);
  assert.equal(SLOTS.returnDelayS, 0.3);
  assert.equal(SLOTS.holsterS, 0.34);
  assert.equal(SLOTS.drawS, 0.15);
});

test('carry states never allocate', () => {
  const c = new Carry(), g = new GrabSense(), W = new MagWell(0.15), gate = new TriggerGate(), h = new HapticGate();
  const step = (i) => {
    if (c.grabbable) c.grab(); else if (c.state === CARRY_HAND) c.release(i % 2 === 0);
    c.update(DT); g.update(DT, i % 7 === 0, i % 7 < 3); g.enter(1, i % 5 < 2);
    W.update(0.01, -0.05 + (i % 10) * 0.005, 0, 0, 1, 0, 0.9);
    if (W.home) W.reset();
    gate.update(i % 3 / 3, 0.3, false); if (i % 100 === 0) gate.arm();
    h.allow(i * DT, 0.3, 14);
  };
  for (let i = 0; i < 20000; i++) step(i);
  let grew = Infinity;
  for (let r = 0; r < 4; r++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 50000; i++) step(i);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 64_000, `heap grew ${grew} bytes`);
  void CARRY_DRAW; void CARRY_HOLSTER; void CARRY_DROP; void CARRY_SHRINK;
});
