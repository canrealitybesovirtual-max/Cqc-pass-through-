/**
 * The weapon controls as data (src/weapons/Controls.js): CQC's Quest map, for the page, the card and the watch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_CONTROLS, CONTROLS_CARD } from '../../src/weapons/Controls.js';

test('controls: unique ids; the CQC face-button map (A / X magazine, B / Y slide or mode) and the hold-A test aid', () => {
  const ids = WEAPON_CONTROLS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const by = Object.fromEntries(WEAPON_CONTROLS.map((c) => [c.id, c]));
  assert.match(by.magRelease.input, /^A, or X/);
  assert.match(by.slideOrMode.input, /^B, or Y/);
  assert.match(by.slideOrMode.action, /slide release/);
  assert.match(by.slideOrMode.action, /fire mode/);
  assert.match(by.assist.input, /Hold A/);
  for (const c of WEAPON_CONTROLS) assert.ok(c.input && c.action && Object.isFrozen(c), c.id);
});

test('controls card: a dim title line and short lines (≤ 46 characters) for the panel and the watch', () => {
  assert.equal(CONTROLS_CARD[0][0], '[');
  for (const l of CONTROLS_CARD) assert.ok(l.length <= 46, `${l.length}: ${l}`);
  assert.ok(Object.isFrozen(CONTROLS_CARD));
});
