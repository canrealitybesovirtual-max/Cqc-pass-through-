// Weapon definitions (src/weapons/WeaponDefs.js): the contract's numbers and internal consistency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOCK, AKM, WEAPON_DEFS, DAMAGE_HP, getDef, validateDef, autoInterval } from '../../src/weapons/WeaponDefs.js';
import { SOUND_KEYS, WEAPON_IDS } from '../../src/core/Assets.js';

test('both definitions pass their own consistency checks', () => {
  assert.deepEqual(validateDef(GLOCK), []);
  assert.deepEqual(validateDef(AKM), []);
});

test('rounds and fire modes (contract)', () => {
  assert.equal(GLOCK.capacity, 17); assert.equal(GLOCK.startRounds, 17); assert.equal(GLOCK.startChambered, true);
  assert.equal(AKM.capacity, 30); assert.equal(AKM.startRounds, 30); assert.equal(AKM.startChambered, true);
  assert.deepEqual(GLOCK.modes, ['semi']);
  assert.deepEqual(AKM.modes, ['safe', 'auto', 'semi'], 'real AKM lever order, top to bottom');
  assert.equal(AKM.cyclicRpm, 600);
  assert.ok(Math.abs(autoInterval(AKM) - 0.1) < 1e-12);
  assert.equal(autoInterval(GLOCK), Infinity);
  assert.ok(Math.abs(AKM.slide.backS + AKM.slide.homeS + AKM.autoDelayS - 0.1) < 1e-12, 'the cycle sets 600 rpm');
});

test('mechanism facts: Glock slide stop, AKM no hold-open', () => {
  assert.equal(GLOCK.lockOnEmpty, true); assert.equal(GLOCK.hasSlideRelease, true);
  assert.equal(AKM.lockOnEmpty, false); assert.equal(AKM.hasSlideRelease, false);
  assert.equal(GLOCK.action, 'striker'); assert.equal(AKM.action, 'hammer');
  assert.ok(AKM.slide.feedAt > GLOCK.slide.feedAt, 'the AKM rack needs fuller travel');
  assert.ok(AKM.slide.safeLimit < AKM.slide.cockAt, 'on safe the handle cannot cock, eject or feed');
});

test('slide timings and trigger (CQC numbers)', () => {
  assert.equal(GLOCK.slide.backS, 0.015);
  assert.equal(GLOCK.slide.homeS, 0.040);
  assert.equal(GLOCK.slide.ejectAt, 0.9);
  assert.equal(GLOCK.slide.feedBelow, 0.35);
  assert.equal(GLOCK.trigger.break, 0.72);
  assert.equal(GLOCK.trigger.reset, 0.40);
});

test('G17 recoil is exactly the CQC-tuned set', () => {
  const r = GLOCK.recoil;
  assert.deepEqual([r.kick, r.climb, r.yaw, r.yawBias], [0.9, 11, 1.6, 0]);
  assert.deepEqual([r.jitterMin, r.jitterMax, r.twoHand], [0.9, 1.1, 0.55]);
  assert.deepEqual(r.back, { k: 520, c: 38 });
  assert.deepEqual(r.rot, { k: 300, c: 26 });
});

test('AKM recoil is stronger than the 9 mm on every axis', () => {
  const a = AKM.recoil, g = GLOCK.recoil;
  assert.ok(a.kick > g.kick && a.climb > g.climb && a.yaw > g.yaw);
  assert.ok(a.yawBias < 0, 'drifts right');
  assert.equal(a.twoHand, 0.55);
});

test('damage against 100 hp; AKM x 1.6', () => {
  assert.equal(DAMAGE_HP, 100);
  assert.deepEqual({ ...GLOCK.damage }, { head: 400, neck: 120, torso: 40, pelvis: 45, limb: 24 });
  for (const p of ['head', 'neck', 'torso', 'pelvis', 'limb']) {
    assert.ok(Math.abs(AKM.damage[p] - 1.6 * GLOCK.damage[p]) < 1e-9, p);
  }
});

test('ballistics: muzzle velocities of the real loads', () => {
  assert.ok(GLOCK.muzzleVelocity > 340 && GLOCK.muzzleVelocity < 380);
  assert.ok(AKM.muzzleVelocity > 700 && AKM.muzzleVelocity < 735);
  assert.ok(AKM.bulletMass * AKM.muzzleVelocity > 1.8 * GLOCK.bulletMass * GLOCK.muzzleVelocity);
});

test('manifest keys: model ids and sound keys exist in the asset contract', () => {
  for (const d of [GLOCK, AKM]) {
    assert.ok(WEAPON_IDS.includes(d.id), d.id);
    for (const [role, key] of Object.entries(d.sounds)) assert.ok(SOUND_KEYS.includes(key), `${d.id}.sounds.${role} = ${key}`);
  }
  assert.deepEqual(Object.keys(WEAPON_DEFS).sort(), [...WEAPON_IDS].sort());
  assert.equal(getDef('akm'), AKM);
  assert.throws(() => getDef('m4'), /unknown weapon/);
});

test('definitions are deeply frozen', () => {
  assert.ok(Object.isFrozen(GLOCK) && Object.isFrozen(GLOCK.recoil.back) && Object.isFrozen(AKM.modes) && Object.isFrozen(AKM.damage));
  assert.throws(() => { 'use strict'; /** @type {any} */ (GLOCK).capacity = 33; });
});

test('validateDef catches broken definitions', () => {
  const broken = structuredClone(AKM);
  broken.slide.ejectAt = 0.99;           // after the feed point: double feed
  broken.autoDelayS = 0.05;              // no longer 600 rpm
  broken.slide.safeLimit = 0.5;          // safe would let the carrier cock the hammer
  broken.recoil.back.k = 1e6;            // too stiff for the sub-step
  const errs = validateDef(broken);
  for (const want of ['ejectAt <= feedAt', 'backS + homeS + autoDelayS', 'on safe', 'too stiff']) {
    assert.ok(errs.some((e) => e.includes(want)), `expected an error about "${want}": ${errs.join(' | ')}`);
  }
});
