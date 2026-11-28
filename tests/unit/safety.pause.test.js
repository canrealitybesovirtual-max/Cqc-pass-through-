/**
 * PauseManager (src/safety/PauseManager.js): every pause trigger on scripted
 * head paths, the soft zone levels (ring 0.8 r, freeze 0.9 r, pause r) and the
 * full resume protocol of PLAN §6.2 (0.5 s within 0.7 r, tracking fine 0.4 s,
 * the Resume press, 3-2-1 with enemies shown but frozen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import {
  PAUSE, PAUSE_LATCH, PAUSE_LEVEL, PauseManager, RESUME, SAFETY, VIOLATION, firstReason, pauseIndex, pauseName,
} from '../../src/safety/PauseManager.js';

const DT = 1 / 72;
const R = 0.8;

/** A manager in a running round, settled. */
function running(o) {
  const pm = new PauseManager({ zoneR: R, ...o });
  pm.setHead(0, 0);
  for (let i = 0; i < 10; i++) pm.update(DT, true);
  assert.equal(pm.paused, false);
  return pm;
}

/** Step `s` seconds; `each(pm, i)` sets inputs before every update. Returns the updates that changed `paused`. */
function run(pm, s, each) {
  const n = Math.round(s / DT);
  let changes = 0;
  for (let i = 0; i < n; i++) {
    if (each) each(pm, i);
    if (pm.update(DT, true)) changes++;
  }
  return changes;
}

/** Hold the head at horizontal distance d from the zone centre (on +x). */
const at = (d) => (pm) => { pm.setZone(d); pm.setHead(d, 0); };

/** Complete the resume protocol from a cleared pause; returns seconds to READY. */
function resume(pm, d = 0.2) {
  let t = 0;
  while (pm.state !== RESUME.READY && t < 10) { at(d)(pm); pm.update(DT, true); t += DT; }
  assert.equal(pm.state, RESUME.READY, 'waiting for the press');
  pm.press();
  at(d)(pm);
  pm.update(DT, true);
  assert.equal(pm.state, RESUME.COUNT);
  run(pm, SAFETY.countdownS + 0.05, at(d));
  assert.equal(pm.paused, false, 'resumed');
  return t;
}

test('names, priorities and bit sets', () => {
  assert.equal(pauseName(PAUSE.ZONE), 'zone');
  assert.equal(pauseName(PAUSE.RESET), 'reset');
  assert.equal(pauseName(0), '');
  assert.equal(pauseIndex(PAUSE.MANUAL), 7);
  assert.equal(PAUSE_LEVEL & PAUSE_LATCH, 0);
  assert.equal(PAUSE_LEVEL | PAUSE_LATCH, 511, 'every bit is a level or a latch');
  assert.equal(firstReason(PAUSE.MANUAL | PAUSE.ZONE | PAUSE.HIDDEN), PAUSE.ZONE);
  assert.equal(firstReason(PAUSE.GAP | PAUSE.TRACKING), PAUSE.TRACKING);
});

test('zone levels on a walk outward: ring + one tick at 0.8 r, freeze at 0.9 r, pause beyond r (3 cm hysteresis)', () => {
  const pm = running();
  let ticks = 0;
  const path = [];
  for (let d = 0; d <= 0.84; d += 0.005) path.push(d);
  /** first distance each level was reached */
  const first = {};
  for (const d of path) {
    at(d)(pm);
    pm.update(DT, true);
    if (pm.tick) ticks++;
    const lv = pm.zoneLevel;
    if (!(lv in first)) first[lv] = d;
    if (pm.paused) break;
  }
  assert.ok(first[1] > 0.8 * R && first[1] <= 0.8 * R + 0.006, `ring at ${first[1]}`);
  assert.ok(first[2] > 0.9 * R && first[2] <= 0.9 * R + 0.006, `freeze at ${first[2]}`);
  assert.ok(first[3] > R && first[3] <= R + 0.006, `pause at ${first[3]}`);
  assert.equal(ticks, 1, 'one soft tick');
  assert.equal(pm.paused, true);
  assert.equal(pm.cause, PAUSE.ZONE);
  assert.equal(pm.hidden, true, 'enemies and effects hidden');
  assert.equal(pm.freeze, true);

  // at 0.9 r and not paused: frozen, not paused
  const b = running();
  run(b, 0.2, at(0.75));
  assert.equal(b.paused, false);
  assert.equal(b.zoneLevel, 2);
  assert.equal(b.freeze, true, 'enemies freeze beyond 0.9 r');
  assert.equal(b.hidden, false);
  run(b, 0.2, at(0.705)); // inside 0.9 r but within the 3 cm band: still frozen
  assert.equal(b.freeze, true);
  run(b, 0.2, at(0.65));
  assert.equal(b.freeze, false);
  assert.equal(b.zoneLevel, 1);
  // hysteresis on r: back to 0.79 m is still outside
  const c = running();
  run(c, 0.1, at(0.81));
  run(c, 0.5, at(0.79));
  assert.ok(c.reasons & PAUSE.ZONE, 'on the line still counts as outside');
  run(c, 0.05, at(0.76));
  assert.equal(c.reasons & PAUSE.ZONE, 0);
  assert.equal(c.paused, true, 'still paused: the resume protocol has not run');
});

test('resume protocol: within 0.7 r for 0.5 s, then the press, then 3-2-1 shown but frozen; each condition gates', () => {
  const pm = running();
  run(pm, 0.1, at(1.0));
  assert.equal(pm.paused, true);
  // back inside r but beyond 0.7 r: waits forever ("step to the middle")
  run(pm, 5, at(0.62));
  assert.equal(pm.state, RESUME.WAIT);
  assert.equal(pm.innerIn, false);
  assert.equal(pm.paused, true);
  pm.press(); // not waiting for it: ignored
  run(pm, 0.1, at(0.62));
  assert.equal(pm.state, RESUME.WAIT);
  // within 0.7 r: 0.5 s
  run(pm, 0.48, at(0.5));
  assert.equal(pm.state, RESUME.WAIT, 'not yet 0.5 s');
  run(pm, 0.04, at(0.5));
  assert.equal(pm.state, RESUME.READY);
  assert.equal(pm.hidden, true, 'still hidden while waiting for the press');
  // drifting out of 0.7 r (beyond the 3 cm band) goes back to waiting
  run(pm, 0.1, at(0.6));
  assert.equal(pm.state, RESUME.WAIT);
  run(pm, 0.52, at(0.3));
  assert.equal(pm.state, RESUME.READY);
  // a press held from before does not count: the press is an edge, consumed per update
  run(pm, 2, at(0.3));
  assert.equal(pm.state, RESUME.READY, 'no press, no resume');
  pm.press();
  at(0.3)(pm);
  pm.update(DT, true);
  assert.equal(pm.state, RESUME.COUNT);
  assert.equal(pm.paused, true);
  assert.equal(pm.hidden, false, 'the countdown shows the enemies …');
  assert.equal(pm.freeze, true, '… frozen');
  const seen = new Set();
  let changes = 0;
  for (let i = 0; i < Math.round((SAFETY.countdownS - 0.02) / DT); i++) {
    at(0.3)(pm);
    if (pm.update(DT, true)) changes++;
    seen.add(pm.countN);
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
  assert.equal(pm.paused, true);
  assert.equal(changes, 0);
  changes = run(pm, 0.05, at(0.3));
  assert.equal(changes, 1, 'one resume');
  assert.equal(pm.paused, false);
  assert.equal(pm.state, RESUME.RUN);
  assert.equal(pm.latched, 0);
  assert.equal(pm.freeze, false);
});

test('a reason during the countdown restarts the protocol from the start', () => {
  const pm = running();
  pm.trigger(PAUSE.MANUAL);
  let t = 0;
  while (pm.state !== RESUME.READY && t < 5) { at(0.2)(pm); pm.update(DT, true); t += DT; }
  pm.press();
  run(pm, 1.2, at(0.2));
  assert.equal(pm.state, RESUME.COUNT);
  // stepping out during the countdown
  run(pm, 0.05, at(0.9));
  assert.equal(pm.state, RESUME.BLOCKED);
  assert.equal(pm.hidden, true);
  // a blur during the countdown
  const b = running();
  b.trigger(PAUSE.MANUAL);
  while (b.state !== RESUME.READY) { at(0.2)(b); b.update(DT, true); }
  b.press();
  run(b, 1, at(0.2));
  b.setVisible(false);
  run(b, DT, at(0.2));
  assert.equal(b.state, RESUME.BLOCKED);
  b.setVisible(true);
  const back = resume(b);
  assert.ok(back >= SAFETY.insideS - 1e-9, 'the full 0.5 s again');
});

test('every confirmed trigger pauses within one frame, each with its cause', () => {
  const cases = [
    ['zone', (pm) => at(0.85)(pm), PAUSE.ZONE],
    ['hidden', (pm) => pm.setVisible(false), PAUSE.HIDDEN],
    ['tracking: no pose or emulatedPosition', (pm) => pm.setTracking(false), PAUSE.TRACKING],
    ['input source removed', (pm) => pm.setControllers(true, false), PAUSE.INPUT],
  ];
  for (const [name, set, bit] of cases) {
    const pm = running();
    set(pm);
    assert.equal(pm.update(DT, true), true, name);
    assert.equal(pm.paused, true, name);
    assert.equal(pm.cause, bit, name);
  }
  for (const bit of [PAUSE.MANUAL, PAUSE.RESET, PAUSE.GAP]) {
    const pm = running();
    assert.equal(pm.trigger(bit), true, pauseName(bit));
    assert.equal(pm.paused, true);
    assert.equal(pm.cause, bit);
    assert.equal(pm.trigger(bit), false, 'already paused');
  }
  // not in a round: nothing pauses
  const idle = new PauseManager();
  idle.setVisible(false);
  idle.update(DT, false);
  assert.equal(idle.paused, false);
  assert.equal(idle.trigger(PAUSE.MANUAL), false);
});

test('no controller for 0.25 s pauses; a removed controller pauses at once; both resume through the protocol', () => {
  // never had a controller (e.g. hand tracking from the start)
  const pm = new PauseManager({ zoneR: R });
  pm.setControllers(false, false);
  pm.setHead(0, 0);
  run(pm, 0.23);
  assert.equal(pm.paused, false, 'not before 0.25 s');
  run(pm, 0.04);
  assert.equal(pm.paused, true);
  assert.equal(pm.cause, PAUSE.CONTROLLER);
  run(pm, 3);
  assert.equal(pm.state, RESUME.BLOCKED, 'blocked while no controller');
  pm.setControllers(true, true);
  resume(pm);

  // removal while playing (the Quest switching to hands): immediate
  const b = running();
  b.setControllers(false, false);
  b.update(DT, true);
  assert.equal(b.paused, true);
  assert.equal(b.cause, PAUSE.INPUT);
  run(b, 0.3);
  assert.ok(b.reasons & PAUSE.CONTROLLER, 'then the level reason holds it');
  b.setControllers(true, true);
  resume(b);
  // one controller gone (battery): pauses; playable again with the other after the protocol
  const c = running();
  c.setControllers(true, false);
  c.update(DT, true);
  assert.equal(c.cause, PAUSE.INPUT);
  resume(c);
});

test('tracking lost pauses at once and resume needs it fine again; a blip during the wait restarts the wait', () => {
  const pm = running();
  pm.setTracking(false);
  pm.update(DT, true);
  assert.equal(pm.cause, PAUSE.TRACKING);
  run(pm, 2, at(0.1));
  assert.equal(pm.state, RESUME.BLOCKED);
  pm.setTracking(true);
  run(pm, 0.3, at(0.1));
  assert.equal(pm.state, RESUME.WAIT);
  pm.setTracking(false);
  run(pm, DT, at(0.1));
  pm.setTracking(true);
  run(pm, 0.45, at(0.1));
  assert.equal(pm.state, RESUME.WAIT, 'the blip restarted the 0.5 s');
  run(pm, 0.07, at(0.1));
  assert.equal(pm.state, RESUME.READY);
  assert.ok(pm.trackT >= SAFETY.trackOkS);
});

test('no running: head speed above 1.2 m/s pauses; walking, turning and tracking jumps do not', () => {
  /** walk along +x at v m/s for s seconds (the zone is far, so only speed matters) */
  const walk = (pm, v, s, x0 = 0) => {
    let x = x0, paused = -1;
    const n = Math.round(s / DT);
    for (let i = 0; i < n; i++) {
      x += v * DT;
      pm.setHead(x, 0);
      pm.setZone(0);
      pm.update(DT, true);
      if (pm.paused && paused < 0) paused = (i + 1) * DT;
    }
    return paused;
  };
  const a = running();
  assert.equal(walk(a, 1.0, 3), -1, '1.0 m/s is fine');
  assert.ok(a.speed > 0.95 && a.speed < 1.05, `speed ${a.speed}`);
  const b = running();
  const t = walk(b, 1.6, 2);
  assert.ok(t > 0 && t < 0.35, `paused after ${t} s`);
  assert.equal(b.cause, PAUSE.RUNNING);
  // a short burst (a quick lean) of 0.1 s at 2 m/s does not reach 1.2 m/s after the low-pass
  const c = running();
  assert.equal(walk(c, 2.0, 0.1), -1);
  // a tracking jump of 0.5 m in one frame is not running
  const d = running();
  d.setHead(0.5, 0);
  d.update(DT, true);
  d.setHead(1.0, 0);
  d.update(DT, true);
  assert.equal(d.paused, false);
  assert.ok(d.speed < 0.1);
  // running during the countdown sends it back
  const e = running();
  e.trigger(PAUSE.MANUAL);
  while (e.state !== RESUME.READY) { at(0.2)(e); e.update(DT, true); }
  e.press();
  at(0.2)(e);
  e.update(DT, true);
  assert.equal(e.state, RESUME.COUNT);
  // fast steps on the spot: back and forth along x
  let x = 0.2;
  for (let i = 0; i < 40; i++) { x += (i % 20 < 10 ? 1 : -1) * 1.8 * DT; e.setHead(x, 0); e.setZone(Math.abs(x)); e.update(DT, true); }
  assert.notEqual(e.state, RESUME.COUNT, 'running restarted the protocol');
  assert.ok(e.latched & PAUSE.RUNNING);
});

test('manual pause (B+Y / wrist) and a frame gap: latched, cleared only by the full protocol', () => {
  for (const bit of [PAUSE.MANUAL, PAUSE.GAP]) {
    const pm = running();
    pm.trigger(bit);
    run(pm, 5, at(0.1));
    assert.equal(pm.state, RESUME.READY, 'nothing blocks a latch: waiting for the press');
    assert.equal(pm.paused, true);
    resume(pm, 0.1);
    assert.equal(pm.latched, 0);
  }
});

test('reference-space reset: pauses; with hold() it waits for release() (the world realigned), then the protocol', () => {
  const pm = running();
  pm.trigger(PAUSE.RESET);
  pm.hold(PAUSE.RESET);
  run(pm, 4, at(0.1));
  assert.equal(pm.state, RESUME.BLOCKED, 'held');
  pm.release(PAUSE.RESET);
  resume(pm, 0.1);
  // without hold: the normal protocol
  const b = running();
  b.trigger(PAUSE.RESET);
  resume(b, 0.1);
  // the reset jump in head position never counts as running
  const c = running();
  c.setHead(0, 0);
  c.update(DT, true);
  c.trigger(PAUSE.RESET);
  c.setHead(0.2, 0); // within jumpM, but a reset
  c.update(DT, true);
  assert.ok(c.speed < 0.5, `speed ${c.speed}`);
});

test('obstacles freeze without pausing; the round ending clears everything silently', () => {
  const pm = running();
  pm.setObstacle(true);
  pm.update(DT, true);
  assert.equal(pm.freeze, true);
  assert.equal(pm.paused, false);
  pm.setObstacle(false);
  pm.update(DT, true);
  assert.equal(pm.freeze, false);
  pm.trigger(PAUSE.MANUAL);
  pm.hold(PAUSE.RESET);
  assert.equal(pm.update(DT, false), false, 'no event when the round ends');
  assert.equal(pm.paused, false);
  assert.equal(pm.held, 0);
  assert.equal(pm.freeze, false);
});

test('violations: game time with the head inside a mapped box, an enemy shot while paused; a fixed log', () => {
  const pm = running();
  pm.setObstacle(true, true);
  run(pm, 0.1);
  assert.ok(pm.violationCounts[VIOLATION.OBSTACLE] >= 7);
  pm.setObstacle(false, false);
  pm.trigger(PAUSE.MANUAL);
  pm.setObstacle(true, true);
  const before = pm.violationCounts[VIOLATION.OBSTACLE];
  run(pm, 0.1);
  assert.equal(pm.violationCounts[VIOLATION.OBSTACLE], before, 'not while paused');
  pm.violation(VIOLATION.SHOT);
  assert.equal(pm.violationCounts[VIOLATION.SHOT], 1);
  for (let i = 0; i < 100; i++) pm.violation(VIOLATION.SPAWN, i);
  // v0.6: a run of frames of one kind is one entry (the obstacle stay, then the shot, then 100 spawns 1 s apart)
  assert.equal(pm.logN, 1 + 1 + 100);
  for (let i = 0; i < 10; i++) pm.violation(VIOLATION.SPAWN, 99.5 + i * 0.01);
  assert.equal(pm.logN, 102, 'frames of the same stay are not logged again');
  assert.equal(pm.logKind.length, 32, 'the log ring is fixed');
  // the head beyond r with game time running cannot happen: it pauses in the same update
  const b = running();
  run(b, 2, (m, i) => at(i % 2 ? 1.5 : 0)(m));
  assert.equal(b.violationCounts[VIOLATION.OUTSIDE], 0);
  b.resetStats();
  assert.equal(b.violations, 0);
});

test('requirePress: false skips the press (tools only)', () => {
  const pm = running({ requirePress: false });
  pm.trigger(PAUSE.MANUAL);
  run(pm, SAFETY.insideS + 0.05, at(0));
  assert.equal(pm.state, RESUME.COUNT);
  run(pm, SAFETY.countdownS + 0.05, at(0));
  assert.equal(pm.paused, false);
});

test('per-frame update allocates nothing (sampling heap profiler)', async () => {
  const pm = running();
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      const d = (i % 900) / 600;
      pm.setZone(d);
      pm.setHead(d, (i % 50) * 0.001);
      pm.setVisible(i % 3000 > 20);
      pm.setTracking(i % 4000 > 15);
      pm.setControllers(i % 5000 > 10, true);
      pm.setObstacle(i % 700 < 30, i % 7000 < 3);
      if (i % 41 === 0) pm.press();
      if (i % 2500 === 7) pm.trigger(PAUSE.MANUAL);
      pm.update(DT, i % 20000 > 5);
    }
  };
  loop(200000);
  // per-frame paths must allocate nothing; rarely run event paths (a pause starting, a round
  // ending) may be charged a few interpreter bytes by V8, bounded per event (as in game.rules.test.js)
  const perFrame = ['update', 'speedStep', 'zoneStep', 'resumeStep', 'setZone', 'setHead', 'setVisible', 'setTracking', 'setControllers', 'setObstacle', 'press'];
  let best = null, worst = Infinity;
  for (let r = 0; r < 8 && worst > 0; r++) { // best of up to 8 (early exit): a JIT deopt under load is one-off, a real allocation shows every time
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(200000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const by = {};
    const walk = (n) => {
      if (n.selfSize > 0 && n.callFrame.url.endsWith('/src/safety/PauseManager.js')) by[n.callFrame.functionName] = (by[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const hot = perFrame.reduce((a, f) => a + (by[f] || 0), 0);
    if (hot < worst) { worst = hot; best = by; }
  }
  assert.equal(worst, 0, JSON.stringify(best));
  const total = Object.values(best).reduce((a, b) => a + b, 0);
  // events in 200k frames: ~80 manual pauses, ~10 round ends, resumes
  assert.ok(total <= 128 * 200, `event paths allocated ${total} bytes: ${JSON.stringify(best)}`);
});

test('a frame gap while already paused does not restart the resume (slow frames cannot keep it paused)', () => {
  const pm = running();
  pm.trigger(PAUSE.MANUAL);
  let t = 0;
  while (pm.state !== RESUME.READY && t < 5) {
    if (Math.round(t / DT) % 10 === 0) pm.trigger(PAUSE.GAP); // a hitch every 10 frames
    at(0.1)(pm);
    pm.update(DT, true);
    t += DT;
  }
  assert.equal(pm.state, RESUME.READY);
  assert.ok(t < SAFETY.insideS + 0.05, `ready after ${t} s`);
  pm.press();
  for (let i = 0; i < Math.round((SAFETY.countdownS + 0.05) / DT); i++) { if (i % 10 === 0) pm.trigger(PAUSE.GAP); at(0.1)(pm); pm.update(DT, true); }
  assert.equal(pm.paused, false);
  // a manual pause while paused still starts the resume over
  const b = running();
  b.trigger(PAUSE.GAP);
  run(b, 0.4, at(0.1));
  b.trigger(PAUSE.MANUAL);
  assert.equal(b.state, RESUME.BLOCKED);
});
