import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoicePool } from '../../src/audio/VoicePool.js';

const make = () => new VoicePool(24, 8, 2);

test('layout: 8 HRTF, 14 equal-power, 2 UI; bad layouts are refused', () => {
  const p = make();
  assert.equal(p.hrtf, 8);
  assert.equal(p.spatialEnd, 22);
  assert.throws(() => new VoicePool(4, 3, 2));
  assert.throws(() => new VoicePool(65, 8, 2));
});

test('free voices come from the preferred tier first, then the other tier', () => {
  const p = make();
  const now = 1;
  const a = p.pick(now, 3, 1, true);
  assert.ok(a >= 0 && a < 8, 'HRTF voice for a sound to locate');
  p.assign(a, now, now + 1, 3, 1);
  const b = p.pick(now, 4, 1, false);
  assert.ok(b >= 8 && b < 22, 'equal-power voice for your own gun');
  // fill the 8 HRTF voices: the 9th HRTF-preferring sound takes an equal-power voice
  for (let i = 0; i < 8; i++) p.assign(i, now, now + 1, 3, 1);
  const c = p.pick(now, 3, 1, true);
  assert.ok(c >= 8 && c < 22);
  assert.equal(p.lastStolen, false);
  // UI voices are never handed to spatial sounds
  for (let i = 0; i < 22; i++) p.assign(i, now, now + 1, 3, 1);
  const d = p.pick(now, 0, 0.01, true);
  assert.equal(d, -1, 'nothing quieter to steal');
});

test('stealing: lower priority first, then the quieter / more finished sound; never a more important one', () => {
  const p = make();
  const now = 10;
  for (let i = 0; i < 22; i++) p.assign(i, now, now + 2, 3, 0.5);
  p.assign(5, now - 1.9, now + 0.1, 1, 0.9); // brass, nearly done
  p.assign(12, now, now + 2, 1, 0.2); // quiet brass, fresh
  // a gunshot steals the quietest low-priority voice (12: 0.2 × 1.0 < 0.9 × ~0.29)
  let v = p.pick(now, 5, 1, true);
  assert.equal(v, 12);
  assert.equal(p.lastStolen, true);
  p.assign(12, now, now + 1, 5, 1);
  v = p.pick(now, 5, 1, true);
  assert.equal(v, 5, 'then the nearly finished one');
  p.assign(5, now, now + 1, 5, 1);
  // a step (priority 2) cannot steal from priority 3+
  assert.equal(p.pick(now, 2, 5, true), -1);
  assert.equal(p.drops, 1);
  // same priority: only if the new sound is more audible than what is left of the old
  assert.equal(p.pick(now, 3, 0.05, true), -1);
  const w = p.pick(now, 3, 0.6, true);
  assert.ok(w >= 0);
  assert.equal(p.pri[w], 3);
  assert.equal(p.steals, 3);
});

test('voices free themselves when their sound ends; ids are generation-tagged', () => {
  const p = make();
  const a = p.pick(0, 3, 1, true);
  const id = p.assign(a, 0, 0.5, 3, 1);
  assert.equal(p.index(id), a);
  assert.equal(p.busy(a, 0.4), true);
  assert.equal(p.busy(a, 0.5), false);
  assert.equal(p.busyCount(0.4), 1);
  const id2 = p.assign(a, 1, 1.5, 3, 1);
  assert.notEqual(id2, id);
  assert.equal(p.index(id), -1, 'stale id');
  assert.equal(p.index(id2), a);
  p.release(a, 1.2);
  assert.equal(p.busy(a, 1.2), false);
  assert.equal(p.index(id2), -1);
  assert.equal(p.index(-1), -1);
});

test('UI voices: free first, else the oldest', () => {
  const p = make();
  const a = p.pickUI(0);
  assert.equal(a, 22);
  p.assign(a, 0, 5, 9, 1);
  const b = p.pickUI(0.1);
  assert.equal(b, 23);
  p.assign(b, 0.1, 5, 9, 1);
  assert.equal(p.pickUI(0.2), 22);
  assert.equal(p.lastStolen, true);
});

test('a firefight: 200 shots and impacts in 2 s never exceed the pool and keep the loudest', () => {
  const p = make();
  let t = 0, dropped = 0;
  for (let k = 0; k < 200; k++) {
    t += 0.01;
    const pri = k % 4 === 0 ? 5 : k % 4 === 1 ? 2 : k % 4 === 2 ? 1 : 3;
    const aud = 0.1 + ((k * 37) % 10) / 10;
    const v = p.pick(t, pri, aud, k % 2 === 0);
    if (v < 0) { dropped++; continue; }
    p.assign(v, t, t + 0.8, pri, aud);
  }
  assert.ok(p.busyCount(t) <= 22);
  assert.ok(dropped > 0, 'low-priority sounds were dropped');
  let shots = 0;
  for (let i = 0; i < 22; i++) if (p.busy(i, t) && p.pri[i] === 5) shots++;
  assert.ok(shots >= 10, `${shots} gunshots still playing`);
});
