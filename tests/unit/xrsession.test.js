import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, MODES, chooseSpace, featuresFor, nextRate, playStyle, requestXR, sessionInit, attachSession, spaceNote } from '../../src/xr/XRSession.js';

test('play is Roam (v0.3 default): asks for unbounded, never bounded-floor; spot is the stationary local-floor session', () => {
  const f = featuresFor('play');
  assert.ok(f.includes('unbounded'));
  assert.ok(!f.includes('bounded-floor'));
  assert.deepEqual(f, [...BASE, 'unbounded']);
  assert.equal(MODES.play.roam, true);
  assert.deepEqual(featuresFor('spot'), [...BASE]);
  assert.equal(MODES.spot.roam, false);
  assert.equal(playStyle('play'), 'roam');
  assert.equal(playStyle('reduced'), 'roam', 'the reduced retry keeps the Roam rules');
  assert.equal(playStyle('spot'), 'spot');
});

test('spaceNote: honest line when Roam ended on local-floor, nothing under unbounded', () => {
  assert.equal(spaceNote('play', 'unbounded'), null);
  assert.match(spaceNote('play', 'local-floor'), /Whole-house tracking unavailable: the Quest boundary applies/);
  assert.match(spaceNote('play', 'local-floor', 'unbounded rejected: NotSupportedError'), /unbounded rejected/);
  assert.match(spaceNote('reduced', 'local-floor'), /boundary applies/);
  assert.equal(spaceNote('spot', 'local-floor'), null);
  assert.equal(spaceNote('probe', 'local-floor'), null);
});

test('bounded-floor only in the bounds probe', () => {
  for (const m of Object.keys(MODES)) assert.equal(featuresFor(m).includes('bounded-floor'), m === 'bounds', m);
});

test('depth and body tracking are opt-in for play/spot/setup only', () => {
  assert.ok(featuresFor('spot', { depth: true }).includes('depth-sensing'));
  assert.ok(!featuresFor('play').includes('depth-sensing'));
  assert.ok(featuresFor('play', { depth: true }).includes('depth-sensing'));
  assert.ok(featuresFor('setup', { bodyTracking: true }).includes('body-tracking'));
  assert.ok(!featuresFor('bounds', { depth: true }).includes('depth-sensing'));
  assert.equal(featuresFor('probe', { depth: true }).filter((x) => x === 'depth-sensing').length, 1);
});

test('depth request carries the required dictionary', () => {
  assert.equal(sessionInit('play').depthSensing, undefined);
  assert.deepEqual(sessionInit('probe').depthSensing, { usagePreference: ['gpu-optimized'], dataFormatPreference: [] });
  assert.equal(sessionInit('play').requiredFeatures, undefined);
});

test('space choice: spot is always local-floor; roaming modes (play included) use unbounded only when granted', () => {
  assert.equal(chooseSpace('spot', ['unbounded', 'local-floor']), 'local-floor');
  assert.equal(chooseSpace('play', ['unbounded', 'local-floor']), 'unbounded');
  assert.equal(chooseSpace('play', ['local-floor']), 'local-floor');
  assert.equal(chooseSpace('setup', ['unbounded', 'local-floor']), 'unbounded');
  assert.equal(chooseSpace('setup', ['local-floor']), 'local-floor');
  assert.equal(chooseSpace('probe', ['unbounded'], { space: 'local-floor' }), 'local-floor');
});

test('requestXR passes mode and init straight to the browser', () => {
  const calls = [];
  const fake = { requestSession: (m, init) => { calls.push([m, init]); return Promise.resolve('s'); } };
  requestXR(/** @type {any} */ (fake), 'vr');
  assert.equal(calls[0][0], 'immersive-vr');
  assert.deepEqual(calls[0][1].optionalFeatures, ['local-floor']);
});

test('attachSession falls back to local-floor when the space is rejected', async () => {
  const log = [];
  const session = {
    enabledFeatures: ['unbounded', 'local-floor'],
    requestReferenceSpace: (t) => (t === 'unbounded' ? Promise.reject(Object.assign(new Error('nope'), { name: 'NotSupportedError' })) : Promise.resolve({})),
  };
  const renderer = { xr: {
    setReferenceSpaceType: (t) => log.push(`space ${t}`),
    setFramebufferScaleFactor: (v) => log.push(`scale ${v}`),
    setFoveation: (v) => log.push(`fov ${v}`),
    setSession: async () => log.push('set'),
  } };
  const r = await attachSession(renderer, /** @type {any} */ (session), 'play');
  assert.equal(r.space, 'local-floor');
  assert.match(r.spaceFallback, /unbounded rejected: NotSupportedError/);
  assert.deepEqual(log, ['space local-floor', 'scale 1', 'fov 0.5', 'set']);
});

test('nextRate cycles through the offered rates', () => {
  assert.equal(nextRate([72, 80, 90, 120], 72), 80);
  assert.equal(nextRate([72, 80, 90, 120], 120), 72);
  assert.equal(nextRate([72, 90], 72.0001), 90);
  assert.equal(nextRate([72], 72), null);
  assert.equal(nextRate([], undefined), null);
});
