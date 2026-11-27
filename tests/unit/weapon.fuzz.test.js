// Weapon mechanism fuzz (src/weapons/WeaponInstance.js): random event orders and frame times
// (NaN, negative, spikes) never reach an illegal state, and ammo is conserved:
// rounds loaded = shots + live rounds ejected + rounds in dropped magazines + magazine + chamber.
// Plus: the hot paths do not allocate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WeaponInstance, CHAMBER_LIVE, CHAMBER_SPENT, SLIDE_BATTERY, SLIDE_CYCLE, SLIDE_LOCKED } from '../../src/weapons/WeaponInstance.js';
import { GLOCK, AKM } from '../../src/weapons/WeaponDefs.js';

/** Seeded uniform [0, 1). */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['pull', 'release', 'setTrigger', 'magRelease', 'magInsert', 'rackPull', 'rackPull', 'rackRelease',
  'slideRelease', 'selector', 'update', 'update', 'update', 'update'];

/**
 * One random session. Returns counters for the coverage check.
 * @param {any} def @param {number} seed @param {number} steps
 */
function session(def, seed, steps) {
  const R = mulberry(seed);
  const w = new WeaponInstance(def, {
    rounds: Math.floor(R() * (def.capacity + 1)),
    chambered: R() < 0.6,
    magSeated: R() < 0.85,
    mode: def.modes[Math.floor(R() * def.modes.length)],
  });
  let loaded = w.rounds(), fires = 0, ejectLive = 0, ejectCase = 0, dropped = 0, inUpdate = false;
  const seen = { fire: 0, dry: 0, lock: 0, liveEject: 0, chamber: 0, reset: 0, autoFire: 0 };
  w.onFire = () => {
    fires++; seen.fire++;
    assert.equal(w.chamber, CHAMBER_SPENT);
    assert.equal(w.slide, SLIDE_CYCLE);
    assert.notEqual(w.mode, 'safe');
    if (inUpdate) { assert.equal(w.mode, 'auto', 'only the auto sear fires from update'); seen.autoFire++; }
  };
  w.onDry = () => { seen.dry++; };
  w.onLock = () => { seen.lock++; assert.equal(def.lockOnEmpty, true); };
  w.onEject = (_w, live) => { if (live) { ejectLive++; seen.liveEject++; } else ejectCase++; };
  w.onMagOut = (_w, n) => { dropped += n; };
  w.onMagIn = (_w, n) => { loaded += n; };
  w.onChamber = () => { seen.chamber++; assert.equal(w.chamber, CHAMBER_LIVE); };
  w.onReset = () => { seen.reset++; };
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const e = Math.floor(R() * NAMES.length);
    let arg = '';
    switch (NAMES[e]) {
      case 'pull': {
        const could = !w.trigHeld && w.mode !== 'safe' && w.slide === SLIDE_BATTERY && w.cocked && w.chamber === CHAMBER_LIVE;
        assert.equal(w.triggerPull(), could, `pull fires exactly when it can (${trace.slice(-20).join(' ')})`);
        break;
      }
      case 'release': w.triggerRelease(); break;
      case 'setTrigger': { const v = R() < 0.1 ? NaN : R(); arg = v.toFixed(2); w.setTrigger(v); break; }
      case 'magRelease': w.magRelease(); break;
      case 'magInsert': { const n = R() < 0.1 ? NaN : Math.floor(R() * (def.capacity + 6)) - 2; arg = String(n); w.magInsert(n); break; }
      case 'rackPull': { const f = R() < 0.05 ? NaN : R() * 1.4 - 0.2; arg = f.toFixed(2); w.rackPull(f); break; }
      case 'rackRelease': w.rackRelease(); break;
      case 'slideRelease': w.slideRelease(); break;
      case 'selector': w.selector(); break;
      default: {
        const u = R();
        const dt = u < 0.04 ? NaN : u < 0.08 ? -0.01 : u < 0.12 ? 0.5 : u < 0.15 ? 2 : u < 0.2 ? 0 : 0.001 + R() * 0.04;
        arg = String(dt);
        inUpdate = true;
        w.update(dt);
        inUpdate = false;
      }
    }
    trace.push(arg ? `${NAMES[e]}(${arg})` : NAMES[e]);
    const where = () => `${def.id} seed ${seed} step ${i}: ${trace.slice(-20).join(' ')}`;
    const err = w.check();
    if (err) assert.fail(`illegal state "${err}" after ${where()}`);
    const accounted = fires + ejectLive + dropped + w.magRounds + (w.chamber === CHAMBER_LIVE ? 1 : 0);
    if (accounted !== loaded) assert.fail(`ammo not conserved: loaded ${loaded}, accounted ${accounted} after ${where()}`);
    assert.equal(w.shots, fires);
    assert.equal(fires - ejectCase, w.chamber === CHAMBER_SPENT ? 1 : 0, `every fired case is ejected (${where()})`);
    if (w.slide === SLIDE_LOCKED) assert.equal(def.lockOnEmpty, true);
  }
  return seen;
}

for (const def of [GLOCK, AKM]) {
  test(`${def.id}: 400 random sessions of 400 events: no illegal state, ammo conserved`, () => {
    const total = { fire: 0, dry: 0, lock: 0, liveEject: 0, chamber: 0, reset: 0, autoFire: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const seen = session(def, seed * 7919 + (def.id === 'akm' ? 1 : 0), 400);
      for (const k in total) total[k] += seen[k];
    }
    // the fuzz must actually reach the interesting transitions
    for (const k of ['fire', 'dry', 'liveEject', 'chamber', 'reset']) assert.ok(total[k] > 50, `${k} reached ${total[k]} times`);
    if (def.lockOnEmpty) assert.ok(total.lock > 50, `lock reached ${total.lock} times`);
    else assert.equal(total.lock, 0);
    if (def.cyclicRpm > 0) assert.ok(total.autoFire > 50, `auto fire reached ${total.autoFire} times`);
  });
}

test('the mechanism does not allocate per frame (fire, cycle, lock, reload, auto)', () => {
  const g = new WeaponInstance(GLOCK), a = new WeaponInstance(AKM, { mode: 'auto' });
  /** One 11 ms frame of scripted play. */
  const frame = (i) => {
    // Glock: a shot every 20 frames; on lock, a fresh magazine and the slide release
    if (i % 20 === 0) g.triggerPull();
    if (i % 20 === 8) g.triggerRelease();
    if (g.slide === SLIDE_LOCKED) { g.magRelease(); g.magInsert(17); g.slideRelease(); }
    // AKM: 1 s bursts; when dry, change magazine and rack
    if (i % 150 === 0) a.triggerPull();
    if (i % 150 === 90) a.triggerRelease();
    if (i % 150 === 100 && a.chamber !== CHAMBER_LIVE) { a.magRelease(); a.magInsert(30); a.rackPull(1); }
    if (i % 150 === 101) a.rackRelease();
    g.update(0.011);
    a.update(0.011);
    g.snapshot();
    a.snapshot();
  };
  for (let i = 0; i < 20000; i++) frame(i);
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200000; i++) frame(i);
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(g.shots > 9000 && a.shots > 9000, `shots ${g.shots} / ${a.shots}`);
  assert.ok(grew < 300_000, `heap grew ${grew} bytes over 200k frames`);
});
