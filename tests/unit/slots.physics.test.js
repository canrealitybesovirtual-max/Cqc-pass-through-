/**
 * Slots.js with real-surface physics (v0.4): let go anywhere → the gun lies in
 * the world and stays (CARRY_FREE) until picked up again (the draw blends from
 * where it lay) or the lost-object net returns it (shrink, grow, slot); the
 * v0.3 timed return stays when physics is off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Carry, SLOTS, CARRY_SLOT, CARRY_DRAW, CARRY_HAND, CARRY_HOLSTER, CARRY_DROP, CARRY_SHRINK, CARRY_GROW, CARRY_FREE, CARRY_NAMES,
  EV_NONE, EV_IN_HAND, EV_RETURNING, EV_RETURNED,
} from '../../src/player/Slots.js';

const DT = 1 / 90;
const runCarry = (c, secs) => { const ev = []; for (let t = 0; t < secs; t += DT) { const e = c.update(DT); if (e !== EV_NONE) ev.push(e); } return ev; };
const inHand = () => { const c = new Carry(); c.grab(); runCarry(c, 0.2); assert.equal(c.state, CARRY_HAND); return c; };

test('let go away from the slot with physics: it lies in the world and stays (no timed return)', () => {
  const c = inHand();
  assert.ok(c.release(false, true));
  assert.equal(c.state, CARRY_FREE);
  assert.equal(CARRY_NAMES[CARRY_FREE], 'free');
  assert.ok(c.inWorld && !c.inHand && !c.inSlot && !c.grabbable);
  assert.equal(c.scale, 1);
  assert.deepEqual(runCarry(c, 30), [], 'still there after 30 s');
  assert.equal(c.state, CARRY_FREE);
  assert.equal(c.grab(), false, 'not grabbable from its slot: it is not there');
});

test('picked up from where it lies: the 0.15 s draw blend starts from the world pose', () => {
  const c = inHand();
  c.release(false, true);
  runCarry(c, 1);
  assert.ok(c.grabFromWorld());
  assert.equal(c.state, CARRY_DRAW);
  assert.equal(c.fromWorld, true);
  assert.deepEqual(runCarry(c, 0.2), [EV_IN_HAND]);
  assert.equal(c.state, CARRY_HAND);
  assert.equal(c.grabFromWorld(), false, 'only from the world');
  // a draw from the slot clears the flag
  c.release(true); runCarry(c, 0.5);
  assert.equal(c.state, CARRY_SLOT);
  c.grab();
  assert.equal(c.fromWorld, false);
});

test('the lost-object net: shrink where it lies, grow back in the slot; near the slot it still holsters', () => {
  const c = inHand();
  c.release(false, true);
  c.returnLost();
  assert.equal(c.state, CARRY_SHRINK);
  assert.deepEqual(runCarry(c, 0.4), [EV_RETURNING, EV_RETURNED]);
  assert.equal(c.state, CARRY_SLOT);
  const d = inHand();
  d.release(true, true);
  assert.equal(d.state, CARRY_HOLSTER, 'holstering wins over a free release');
  d.returnLost();
  assert.equal(d.state, CARRY_HOLSTER, 'returnLost only applies to an item in the world');
});

test('without physics the v0.3 rule stays: falls 0.3 s, shrinks, grows back; stow from the world puts it in the slot', () => {
  const c = inHand();
  c.release(false);
  assert.equal(c.state, CARRY_DROP);
  runCarry(c, SLOTS.returnDelayS + SLOTS.shrinkS + SLOTS.growS + 0.05);
  assert.equal(c.state, CARRY_SLOT);
  const d = inHand();
  d.release(false, true);
  d.stow();
  assert.equal(d.state, CARRY_SLOT);
  assert.equal(d.state === CARRY_GROW, false);
});
