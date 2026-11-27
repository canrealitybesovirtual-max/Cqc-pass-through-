/**
 * src/app/Settings.js: URL knobs and saved settings (pure; no three.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_KEY, gripFitFromParams, watchFitFromParams, parseSettings, serializeSettings } from '../../src/app/Settings.js';
import { adjFromUrl } from '../../src/weapons/GunFit.js';

test('settings key is versioned and distinct from the gun-fit key', () => {
  assert.equal(SETTINGS_KEY, 'cqcpt.settings.v1');
  assert.notEqual(SETTINGS_KEY, 'cqcpt.gunfit.v1');
});

test('parseSettings: junk gives the defaults (test difficulty, ammo line on); round-trips', () => {
  for (const j of [null, undefined, '', '{', 'null', '42', '[]', '{"difficulty":"insane","ammoLine":"no"}']) {
    assert.deepEqual(parseSettings(j), { difficulty: 'test', ammoLine: true }, String(j));
  }
  const s = { difficulty: /** @type {const} */ ('realistic'), ammoLine: false };
  assert.deepEqual(parseSettings(serializeSettings(s)), s);
  assert.deepEqual(parseSettings(serializeSettings({ difficulty: 'test', ammoLine: true })), { difficulty: 'test', ammoLine: true });
});

test('gripFitFromParams: clamps, ignores junk, says where it came from; adjFromUrl maps gripZ to −forward', () => {
  assert.deepEqual(gripFitFromParams(new URLSearchParams('')), { pitchDeg: 0, y: 0, z: 0, source: 'default' });
  const g = gripFitFromParams(new URLSearchParams('gripPitch=45&gripY=0.01&gripZ=-0.02'));
  assert.deepEqual(g, { pitchDeg: 30, y: 0.01, z: -0.02, source: 'url' });
  assert.deepEqual(gripFitFromParams(new URLSearchParams('gripPitch=abc')), { pitchDeg: 0, y: 0, z: 0, source: 'url' });
  const a = adjFromUrl(g);
  assert.equal(a.pitch, 30);
  assert.equal(a.up, 0.01);
  assert.equal(a.fwd, 0.02);
});

test('watchFitFromParams: only the knobs given, numbers only; null without any', () => {
  assert.equal(watchFitFromParams(new URLSearchParams('')), null);
  assert.equal(watchFitFromParams(new URLSearchParams('watchBack=&watchTilt=x')), null);
  assert.deepEqual(watchFitFromParams(new URLSearchParams('watchBack=0.1&watchScale=1.1')), { back: 0.1, scale: 1.1 });
  assert.deepEqual(watchFitFromParams(new URLSearchParams('watchOut=0.05&watchTilt=-10')), { out: 0.05, tiltDeg: -10 });
});
