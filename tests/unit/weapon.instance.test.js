// Weapon mechanism (src/weapons/WeaponInstance.js): table tests for every transition of the
// Glock 17 Gen5 and the AKM, cycle timing, and 600 rpm auto fire under variable frame times.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WeaponInstance, CHAMBER_EMPTY, CHAMBER_LIVE, CHAMBER_SPENT,
  SLIDE_BATTERY, SLIDE_CYCLE, SLIDE_FORWARD, SLIDE_HELD, SLIDE_LOCKED,
} from '../../src/weapons/WeaponInstance.js';
import { GLOCK, AKM } from '../../src/weapons/WeaponDefs.js';

const HOME = ['eased', 'rack', 'release'];

/** A weapon with every callback logged. */
function rig(def, opts) {
  const w = new WeaponInstance(def, opts);
  const log = [];
  w.onFire = () => log.push('fire');
  w.onDry = () => log.push('dry');
  w.onEject = (_w, live) => log.push(live ? 'eject:live' : 'eject:case');
  w.onLock = () => log.push('lock');
  w.onMagOut = (_w, n) => log.push(`magOut:${n}`);
  w.onMagIn = (_w, n) => log.push(`magIn:${n}`);
  w.onChamber = (_w, cycled) => log.push(cycled ? 'chamber:cycle' : 'chamber');
  w.onReset = () => log.push('reset');
  w.onRack = () => log.push('rack');
  w.onHome = (_w, kind) => log.push(`home:${HOME[kind]}`);
  w.onSelector = (_w, i) => log.push(`sel:${def.modes[i]}`);
  /** Log since the last take. */
  const take = () => log.splice(0, log.length);
  /** Advance `s` seconds in 1 ms frames (plus the remainder). */
  const run = (s) => {
    const n = Math.floor(s / 0.001 + 1e-9);
    for (let i = 0; i < n; i++) w.update(0.001);
    const rest = s - n * 0.001;
    if (rest > 1e-12) w.update(rest);
  };
  const ok = () => assert.equal(w.check(), '');
  return { w, take, run, ok };
}

// ------------------------------------------------------------------ Glock 17 Gen5

test('glock: issued 17 + 1, in battery, cocked, semi', () => {
  const { w, ok } = rig(GLOCK);
  assert.deepEqual({ ...w.snapshot(), rev: 0 }, {
    weapon: 'glock', mag: 17, chambered: 1, magSeated: true, mode: 'semi', slide: 'battery',
    locked: false, cocked: true, shots: 0, rev: 0,
  });
  assert.equal(w.rounds(), 18);
  ok();
});

test('glock: a shot runs the slide back in 15 ms and home in 40 ms, feeding the next round', () => {
  const { w, take, run, ok } = rig(GLOCK);
  assert.equal(w.triggerPull(), true);
  assert.deepEqual(take(), ['fire']);
  assert.equal(w.late, 0);
  assert.equal(w.chamber, CHAMBER_SPENT);
  assert.equal(w.slide, SLIDE_CYCLE);
  ok();
  run(0.0145);
  assert.equal(w.slide, SLIDE_CYCLE);
  assert.ok(w.slidePos > 0.9 && w.slidePos < 1);
  assert.deepEqual(take(), [], 'the case is still in the chamber');
  run(0.001);
  assert.deepEqual(take(), ['eject:case'], 'ejected at the rear, 15 ms after the shot');
  assert.equal(w.slide, SLIDE_FORWARD);
  assert.equal(w.magRounds, 16, 'the next round was stripped as the slide started forward');
  ok();
  run(0.0385);
  assert.equal(w.slide, SLIDE_FORWARD);
  run(0.001);
  assert.equal(w.slide, SLIDE_BATTERY, 'home 55 ms after the shot');
  assert.deepEqual(take(), ['chamber:cycle']);
  assert.deepEqual([w.snapshot().mag, w.snapshot().chambered, w.shots], [16, 1, 1]);
  ok();
});

test('glock: one shot per pull; the reset click on release; then the next pull fires', () => {
  const { w, take, run } = rig(GLOCK);
  w.triggerPull();
  run(0.1);
  assert.equal(w.triggerPull(), false, 'still held: no second shot');
  take();
  w.triggerRelease();
  assert.deepEqual(take(), ['reset']);
  assert.equal(w.triggerPull(), true);
});

test('glock: let go before the slide is back: no click; a pull out of battery waits for a fresh pull', () => {
  const { w, take, run, ok } = rig(GLOCK);
  w.triggerPull();
  run(0.005);
  w.triggerRelease();                       // before the slide re-cocks the striker
  assert.deepEqual(take(), ['fire']);
  run(0.005);
  assert.equal(w.triggerPull(), false, 'out of battery: the disconnector holds');
  run(0.1);
  assert.equal(w.slide, SLIDE_BATTERY);
  assert.deepEqual(take(), ['eject:case', 'chamber:cycle'], 'closing on a held trigger does not fire');
  w.triggerRelease();
  assert.deepEqual(take(), [], 'no reset click: that pull never broke');
  assert.equal(w.triggerPull(), true);
  ok();
});

test('glock: the last round locks the slide open; the trigger is dead while open', () => {
  const { w, take, run, ok } = rig(GLOCK, { rounds: 0, chambered: true });
  w.triggerPull();
  run(0.1);
  assert.deepEqual(take(), ['fire', 'eject:case', 'lock']);
  assert.equal(w.slide, SLIDE_LOCKED);
  assert.equal(w.slidePos, GLOCK.slide.lockPos);
  assert.equal(w.stopRaised, true);
  assert.deepEqual([w.snapshot().locked, w.snapshot().mag, w.snapshot().chambered], [true, 0, 0]);
  w.triggerRelease();
  assert.deepEqual(take(), ['reset']);
  assert.equal(w.triggerPull(), false);
  assert.deepEqual(take(), [], 'no click with the slide open');
  ok();
});

test('glock: magazine out and in leave a locked slide locked; the slide release chambers', () => {
  const { w, take, run, ok } = rig(GLOCK, { rounds: 0, chambered: true });
  w.triggerPull(); run(0.1); w.triggerRelease(); take();
  assert.equal(w.magRelease(), 0);
  assert.equal(w.slide, SLIDE_LOCKED, 'the magazine release does not drop the slide');
  assert.equal(w.stopRaised, true);
  assert.equal(w.magInsert(17), true);
  assert.equal(w.slide, SLIDE_LOCKED, 'seating a magazine does not drop the slide');
  assert.deepEqual(take(), ['magOut:0', 'magIn:17']);
  ok();
  assert.equal(w.slideRelease(), true);
  run(0.05);
  assert.deepEqual(take(), ['home:release', 'chamber']);
  assert.deepEqual([w.magRounds, w.chamber, w.slide], [16, CHAMBER_LIVE, SLIDE_BATTERY]);
  assert.equal(w.triggerPull(), true);
  ok();
});

test('glock: from lock, a rack (slingshot) chambers too', () => {
  const { w, take, run } = rig(GLOCK, { rounds: 0, chambered: true });
  w.triggerPull(); run(0.1); w.triggerRelease();
  w.magRelease(); w.magInsert(17); take();
  w.rackPull(GLOCK.slide.lockPos);           // the hand meets the slide where it is: nothing yet
  assert.equal(w.slide, SLIDE_LOCKED);
  w.rackPull(1);
  assert.equal(w.slide, SLIDE_HELD);
  w.rackRelease();
  run(0.05);
  assert.deepEqual(take(), ['rack', 'home:rack', 'chamber']);
  assert.deepEqual([w.magRounds, w.chamber], [16, CHAMBER_LIVE]);
});

test('glock: racking with the empty magazine still in locks the slide again', () => {
  const { w, take, run, ok } = rig(GLOCK, { rounds: 0, chambered: true });
  w.triggerPull(); run(0.1); w.triggerRelease(); take();
  w.rackPull(1);
  w.rackRelease();
  run(0.05);
  assert.deepEqual(take(), ['rack', 'lock']);
  assert.equal(w.slide, SLIDE_LOCKED);
  ok();
});

test('glock: slide release on an empty magazine closes empty; one click, then a dead trigger until racked', () => {
  const { w, take, run, ok } = rig(GLOCK, { rounds: 0, chambered: true });
  w.triggerPull(); run(0.1); w.triggerRelease(); take();
  w.slideRelease();                          // thumb holds the stop down against the follower
  run(0.05);
  assert.deepEqual(take(), ['home:release']);
  assert.equal(w.slide, SLIDE_BATTERY);
  assert.equal(w.triggerPull(), false);
  assert.deepEqual(take(), ['dry'], 'the striker falls on an empty chamber');
  w.triggerRelease();
  assert.deepEqual(take(), [], 'no reset: the striker is down');
  w.triggerPull(); w.triggerRelease();
  assert.deepEqual(take(), [], 'dead trigger: no second strike');
  w.rackPull(0.2);                           // short of the reset distance
  w.rackRelease(); run(0.02);
  w.triggerPull(); w.triggerRelease();
  assert.deepEqual(take(), ['home:rack'], 'still dead after a 20 % tug');
  w.rackPull(0.3);                           // past the 25 % reset distance
  w.rackRelease(); run(0.02);
  assert.equal(w.cocked, true);
  w.triggerPull();
  assert.deepEqual(take(), ['home:rack', 'dry']);
  ok();
});

test('glock: fires with the magazine out (no magazine safety); no follower, so no lock', () => {
  const { w, take, run, ok } = rig(GLOCK);
  assert.equal(w.magRelease(), 17);
  assert.equal(w.triggerPull(), true);
  run(0.1);
  assert.deepEqual(take(), ['magOut:17', 'fire', 'eject:case']);
  assert.equal(w.slide, SLIDE_BATTERY);
  assert.equal(w.chamber, CHAMBER_EMPTY);
  w.triggerRelease();
  w.triggerPull();
  assert.deepEqual(take(), ['reset', 'dry']);
  ok();
});

test('glock: racking a loaded pistol ejects the live round and feeds the next', () => {
  const { w, take, run, ok } = rig(GLOCK);
  w.rackPull(0.5);
  assert.deepEqual(take(), []);
  w.rackPull(0.95);
  assert.deepEqual(take(), ['eject:live', 'rack']);
  assert.equal(w.chamber, CHAMBER_EMPTY);
  ok();
  w.rackRelease();
  run(0.05);
  assert.deepEqual(take(), ['home:rack', 'chamber']);
  assert.deepEqual([w.magRounds, w.chamber, w.rounds()], [16, CHAMBER_LIVE, 17]);
});

test('glock: a press check (short pull) neither ejects nor feeds', () => {
  const { w, take, run } = rig(GLOCK);
  w.rackPull(0.3);
  assert.equal(w.slide, SLIDE_HELD);
  w.rackRelease();
  run(0.05);
  assert.deepEqual(take(), ['home:rack']);
  assert.deepEqual([w.magRounds, w.chamber], [17, CHAMBER_LIVE]);
  assert.equal(w.triggerPull(), true);
});

test('glock: riding the slide forward chambers below 35 %; racking again ejects that round', () => {
  const { w, take, run, ok } = rig(GLOCK, { chambered: false });
  assert.equal(w.cocked, false, 'issued on an empty chamber the striker is down');
  assert.equal(w.triggerPull(), false);
  w.triggerRelease();
  w.rackPull(1);
  w.rackPull(0.5);
  assert.equal(w.chamber, CHAMBER_EMPTY);
  w.rackPull(0.3);
  assert.equal(w.chamber, CHAMBER_LIVE, 'the breech face pushed the round home');
  assert.equal(w.magRounds, 16);
  w.rackPull(0);
  w.rackRelease();
  assert.equal(w.slide, SLIDE_BATTERY, 'already home: closes at once');
  assert.deepEqual(take(), ['rack', 'home:eased', 'chamber']);
  ok();
  w.rackPull(1);
  assert.deepEqual(take(), ['eject:live', 'rack']);
  w.rackRelease(); run(0.05);
  assert.deepEqual([w.magRounds, w.chamber], [15, CHAMBER_LIVE]);
});

test('glock: an empty magazine catches a slide ridden forward', () => {
  const { w, take, ok } = rig(GLOCK, { rounds: 0, chambered: false });
  w.rackPull(1);
  w.rackPull(0.5);
  assert.equal(w.slide, SLIDE_LOCKED);
  assert.equal(w.slidePos, GLOCK.slide.lockPos);
  assert.deepEqual(take(), ['rack', 'lock']);
  w.rackRelease();
  assert.equal(w.slide, SLIDE_LOCKED, 'letting go of a locked slide changes nothing');
  ok();
  // a stroke that stops short of the notch (0.91 < lockPos) cannot lock
  const b = rig(GLOCK, { rounds: 0, chambered: false });
  b.w.rackPull(0.91); b.w.rackRelease(); b.run(0.05);
  assert.equal(b.w.slide, SLIDE_BATTERY);
});

test('glock: a slide in its firing cycle cannot be grabbed; a closed one needs a real pull', () => {
  const { w, run } = rig(GLOCK);
  w.rackPull(0.005);
  assert.equal(w.slide, SLIDE_BATTERY, 'a hand resting on the slide does not move it');
  w.triggerPull();
  w.rackPull(1);
  assert.equal(w.slide, SLIDE_CYCLE);
  run(0.1);
  assert.equal(w.slide, SLIDE_BATTERY);
  w.rackRelease();
  assert.equal(w.slide, SLIDE_BATTERY);
});

test('glock: magazine edge cases', () => {
  const { w, take } = rig(GLOCK);
  assert.equal(w.magInsert(17), false, 'a magazine is already seated');
  assert.equal(w.magRelease(), 17);
  assert.equal(w.magRelease(), -1);
  for (const [n, want] of [[99, 17], [-3, 0], [NaN, 0], [5.7, 5], [Infinity, 17]]) {
    assert.equal(w.magInsert(n), true);
    assert.equal(w.magRounds, want, `magInsert(${n})`);
    w.magRelease();
  }
  assert.equal(w.snapshot().mag, -1);
  assert.equal(take().length, 11);
});

test('glock: +1 in the chamber: topping off holds 18', () => {
  const { w, run } = rig(GLOCK);
  w.triggerPull(); run(0.1); w.triggerRelease();
  w.magRelease();
  w.magInsert(17);
  assert.equal(w.rounds(), 18);
  assert.deepEqual([w.snapshot().mag, w.snapshot().chambered], [17, 1]);
});

test('glock: no selector or safety; the slide release only acts on a locked slide', () => {
  const { w, take } = rig(GLOCK);
  assert.equal(w.selector(), false);
  assert.equal(w.mode, 'semi');
  assert.equal(w.slideRelease(), false);
  assert.deepEqual(take(), []);
  assert.equal(w.selectorRad, 0);
});

test('glock: analog trigger with break 0.72 / reset 0.40 hysteresis', () => {
  const { w, take, run } = rig(GLOCK);
  assert.equal(w.setTrigger(0.7), false);
  assert.equal(w.setTrigger(0.73), true);
  run(0.1);
  w.setTrigger(0.5);
  assert.equal(w.trigHeld, true, 'above the reset point: not reset yet');
  assert.equal(w.setTrigger(0.8), false);
  w.setTrigger(0.39);
  assert.equal(w.trigHeld, false);
  assert.equal(w.setTrigger(0.73), true);
  assert.deepEqual(take(), ['fire', 'eject:case', 'chamber:cycle', 'reset', 'fire']);
  run(0.1);
  w.setTrigger(NaN);
  assert.equal(w.trigHeld, false, 'NaN reads as a released trigger');
  w.breakAt = 0.6;                           // player setting
  assert.equal(w.setTrigger(0.65), true);
});

test('glock: reset() re-issues the weapon', () => {
  const { w, run } = rig(GLOCK);
  w.triggerPull(); run(0.003);
  w.reset(10, false);
  assert.deepEqual([w.magRounds, w.chamber, w.slide, w.cocked, w.trigHeld, w.shots], [10, CHAMBER_EMPTY, SLIDE_BATTERY, false, false, 0]);
  assert.equal(w.check(), '');
});

// ------------------------------------------------------------------ AKM

test('akm: issued on safe with 30 + 1; selector safe -> auto -> semi -> safe', () => {
  const { w, take, ok } = rig(AKM);
  assert.deepEqual([w.mode, w.magRounds, w.chamber, w.cocked], ['safe', 30, CHAMBER_LIVE, true]);
  assert.equal(w.selectorRad, 0);
  assert.equal(w.selector(), true); assert.equal(w.selectorRad, AKM.selectorRad[1]);
  assert.equal(w.selector(), true); assert.equal(w.selectorRad, AKM.selectorRad[2]);
  assert.equal(w.selector(), true);
  assert.deepEqual(take(), ['sel:auto', 'sel:semi', 'sel:safe']);
  ok();
});

test('akm: safe blocks the trigger and stops the charging handle at 15 %', () => {
  const { w, take, run, ok } = rig(AKM);
  assert.equal(w.triggerPull(), false);
  w.triggerRelease();
  w.rackPull(1);
  assert.equal(w.slidePos, AKM.slide.safeLimit);
  ok();
  w.rackRelease();
  run(0.05);
  assert.deepEqual(take(), ['home:rack'], 'a glimpse of the chamber: nothing ejected, nothing fed');
  assert.deepEqual([w.magRounds, w.chamber], [30, CHAMBER_LIVE]);
});

test('akm: the lever only swings up to safe with the carrier forward', () => {
  const { w, take, run, ok } = rig(AKM, { mode: 'semi' });
  w.rackPull(0.5);
  assert.equal(w.selector(), false, 'the charging handle is in the way');
  assert.equal(w.mode, 'semi');
  w.rackPull(0.1);
  assert.equal(w.selector(), true);
  assert.equal(w.mode, 'safe');
  w.rackPull(1);
  assert.equal(w.slidePos, AKM.slide.safeLimit);
  ok();
  w.rackRelease(); run(0.05);
  w.selector(); w.selector();               // safe -> auto -> semi
  take();
  w.triggerPull();
  assert.equal(w.selector(), false, 'not while the carrier cycles');
  run(0.2);
  assert.equal(w.selector(), true);
  ok();
});

test('akm semi: carrier back in 35 ms, home in 55 ms; one round per pull; reset on release', () => {
  const { w, take, run, ok } = rig(AKM, { mode: 'semi' });
  assert.equal(w.triggerPull(), true);
  run(0.0345);
  assert.deepEqual(take(), ['fire']);
  run(0.001);
  assert.deepEqual(take(), ['eject:case']);
  run(0.0535);
  assert.equal(w.slide, SLIDE_FORWARD);
  run(0.001);
  assert.equal(w.slide, SLIDE_BATTERY);
  assert.deepEqual(take(), ['chamber:cycle']);
  run(0.5);
  assert.deepEqual(take(), [], 'semi: the disconnector holds the hammer');
  w.triggerRelease();
  assert.deepEqual(take(), ['reset']);
  assert.equal(w.triggerPull(), true);
  ok();
});

test('akm: no hold-open: the carrier closes on an empty chamber and the next pull clicks', () => {
  const { w, take, run, ok } = rig(AKM, { rounds: 0, chambered: true, mode: 'semi' });
  w.triggerPull();
  run(0.2);
  assert.deepEqual(take(), ['fire', 'eject:case']);
  assert.equal(w.slide, SLIDE_BATTERY);
  assert.equal(w.locked, false);
  w.triggerRelease();
  w.triggerPull();
  assert.deepEqual(take(), ['reset', 'dry']);
  w.triggerRelease();
  w.triggerPull();
  assert.deepEqual(take(), [], 'hammer down: nothing');
  assert.equal(w.slideRelease(), false, 'no slide release on an AKM');
  ok();
});

test('akm auto: 600 rpm under variable frame times; 31 rounds, then the hammer clicks on empty', () => {
  for (const seed of [1, 2, 3]) {
    const { w } = rig(AKM, { mode: 'auto' });
    let s = seed, t = 0;
    const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
    const shots = [];
    let dry = -1;
    w.onFire = () => shots.push(t + frameDt - w.late);
    w.onDry = () => { dry = t + frameDt; };
    let frameDt = 0;
    w.triggerPull();                         // at t = 0
    while (t < 3.6) {
      frameDt = rand() < 0.05 ? 0.1 : 0.004 + rand() * 0.03;   // 4-34 ms frames and 100 ms hitches
      w.update(frameDt);
      t += frameDt;
      assert.equal(w.check(), '');
    }
    assert.equal(shots.length, 31, `seed ${seed}`);
    for (let i = 0; i < shots.length; i++) assert.ok(Math.abs(shots[i] - 0.1 * i) < 1e-9, `shot ${i} at ${shots[i]}`);
    assert.ok(dry > 3.1 - 1e-9 && dry < 3.1 + 0.1 + 1e-9, `click after the last round: ${dry}`);
    assert.deepEqual([w.magRounds, w.chamber, w.cocked, w.shots], [0, CHAMBER_EMPTY, false, 31]);
  }
});

test('akm auto: letting go stops the burst; the trigger sear catches the hammer', () => {
  const { w, take, run } = rig(AKM, { mode: 'auto' });
  w.triggerPull();
  run(0.35);
  w.triggerRelease();
  run(0.5);
  const l = take();
  assert.equal(l.filter((e) => e === 'fire').length, 4, 'shots at 0, 100, 200, 300 ms');
  assert.ok(l.includes('reset'));
  assert.deepEqual([w.magRounds, w.chamber], [26, CHAMBER_LIVE]);
  assert.equal(w.triggerPull(), true, 'a fresh pull fires at once');
});

test('akm: a pull while the carrier cycles fires when it closes in auto, not in semi', () => {
  // auto: shots at 0, then 100 ms (the held trigger meets the closing carrier) and 200 ms
  for (const [mode, want] of [['auto', 3], ['semi', 1]]) {
    const { w, take, run } = rig(AKM, { mode });
    w.triggerPull();
    run(0.02);
    w.triggerRelease();
    w.triggerPull();                         // out of battery
    run(0.2);
    assert.equal(take().filter((e) => e === 'fire').length, want, mode);
  }
});

test('akm auto: letting the charging handle go with the trigger held fires as it closes', () => {
  const { w, take, run, ok } = rig(AKM, { mode: 'auto', chambered: false });
  assert.equal(w.triggerPull(), false, 'hammer down on an empty chamber');
  w.rackPull(1);
  w.rackRelease();
  run(AKM.slide.homeS - 0.001);
  assert.deepEqual(take(), ['rack']);
  run(0.002);
  assert.deepEqual(take(), ['home:rack', 'chamber'], 'closed; the auto sear trips');
  run(AKM.autoDelayS - 0.002);
  assert.deepEqual(take(), []);
  run(0.002);
  assert.deepEqual(take(), ['fire'], 'after the retarder delay');
  ok();
});

test('akm: a rack needs full travel', () => {
  const { w, take, run } = rig(AKM, { mode: 'semi' });
  w.rackPull(0.93);
  assert.deepEqual(take(), [], '93 %: the round is still in the chamber');
  w.rackPull(0.96);
  assert.deepEqual(take(), ['eject:live', 'rack']);
  w.rackRelease(); run(0.1);
  assert.deepEqual(take(), ['home:rack', 'chamber']);
  assert.deepEqual([w.magRounds, w.chamber], [29, CHAMBER_LIVE]);
  const b = rig(AKM, { mode: 'semi', chambered: false });
  b.w.rackPull(0.9); b.w.rackRelease(); b.run(0.1);
  assert.equal(b.w.chamber, CHAMBER_EMPTY, 'a short rack does not pick up a round');
  assert.equal(b.w.cocked, true, 'but it did cock the hammer');
});

test('akm: the charging handle reciprocates with every shot', () => {
  const { w } = rig(AKM, { mode: 'auto' });
  w.triggerPull();
  let maxPos = 0, closed = 0, prev = 0;
  for (let i = 0; i < 1000; i++) {
    w.update(0.001);
    maxPos = Math.max(maxPos, w.slidePos);
    if (prev > 0 && w.slidePos === 0) closed++;
    prev = w.slidePos;
  }
  assert.ok(maxPos > 0.97, `full travel: ${maxPos}`);
  assert.equal(closed, 10, 'the carrier closed after each of 10 shots in a second');
});

test('akm: magazine change and reload', () => {
  const { w, take, run, ok } = rig(AKM, { mode: 'semi', rounds: 3, chambered: false });
  assert.equal(w.magRelease(), 3);
  assert.equal(w.magInsert(30), true);
  w.rackPull(1); w.rackRelease(); run(0.1);
  assert.deepEqual(take(), ['magOut:3', 'magIn:30', 'rack', 'home:rack', 'chamber']);
  assert.equal(w.rounds(), 30);
  ok();
});
