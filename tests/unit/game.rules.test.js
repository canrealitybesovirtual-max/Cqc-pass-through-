import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { MSG, PAUSE, PHASE, RULES, SurvivalRules } from '../../src/game/Rules.js';

/**
 * Bytes the V8 sampling heap profiler attributes to each function of `file`
 * while `fn` runs (16-byte sampling: any steady allocation shows up).
 * @returns {Promise<Record<string, number>>}
 */
async function allocatedIn(file, fn) {
  const s = new Session();
  s.connect();
  await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
  fn();
  const { profile } = await s.post('HeapProfiler.stopSampling');
  s.disconnect();
  const by = {};
  const walk = (n) => {
    if (n.selfSize > 0 && n.callFrame.url.endsWith(file)) by[n.callFrame.functionName] = (by[n.callFrame.functionName] || 0) + n.selfSize;
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  return by;
}

/** A fake host: an enemy pool that spawns on demand, with a log of callbacks. */
function make({ spawnOk = () => true, seed, quiet = false } = {}) {
  const log = [];
  const h = {
    living: 0,
    spawns: 0,
    restarts: 0,
    exits: [],
    pauses: [],
    healths: [],
    spawn() { if (!spawnOk()) return false; h.living++; h.spawns++; return true; },
    alive() { return h.living; },
    waveStart(w, n) { log.push(`start ${w} ${n}`); },
    waveClear(w) { log.push(`clear ${w}`); },
    roundOver(w, k) { log.push(`over ${w} ${k}`); },
    pause(p, r) { h.pauses.push([p, r]); },
    health(v, d) { h.healths.push([v, d]); },
    restart() { h.restarts++; h.living = 0; },
    exit(r) { h.exits.push(r); },
  };
  if (quiet) {
    // records nothing, so the heap test measures the rules alone
    h.waveStart = h.waveClear = h.roundOver = h.pause = h.health = h.exit = () => {};
  }
  const rules = new SurvivalRules(h, { seed });
  return { rules, h, log };
}

/** Run a wave to its end: kill one enemy every 2 s, as they come. */
function fightWave(rules, h, { each } = {}) {
  let t = 0;
  for (let i = 0; i < 72 * 120 && rules.phase === PHASE.WAVE; i++) {
    rules.update(DT, 0, true, false);
    if (each) each();
    t += DT;
    if (t >= 2 && h.living > 0) { t = 0; h.living--; rules.kill(false); }
  }
}

const DT = 1 / 72;
/** Step `s` seconds standing inside the zone, visible, Y up. */
function run(rules, s, { dist = 0, visible = true, y = false, each } = {}) {
  const n = Math.round(s / DT);
  for (let i = 0; i < n; i++) { rules.update(DT, dist, visible, y); if (each) each(i); }
}

/** Kill every living enemy (as the enemyKilled event would). */
function killAll(rules, h) {
  while (h.living > 0) { h.living--; rules.kill(false); }
}

test('get ready, then wave n has 2 + n enemies, at most 4 alive at once', () => {
  const { rules, h, log } = make();
  rules.start();
  assert.equal(rules.phase, PHASE.READY);
  assert.equal(rules.msg, MSG.GET_READY);
  assert.equal(h.restarts, 1);
  run(rules, RULES.readyS - 0.1);
  assert.equal(rules.phase, PHASE.READY);
  run(rules, 0.2);
  assert.equal(rules.phase, PHASE.WAVE);
  assert.deepEqual(log, ['start 1 3']);
  assert.equal(rules.msg, MSG.WAVE);
  assert.equal(rules.msgN, 1);

  for (let wave = 1; wave <= 4; wave++) {
    let maxAlive = 0;
    const each = () => { if (h.living > maxAlive) maxAlive = h.living; };
    run(rules, 25, { each });
    assert.equal(rules.spawned, Math.min(2 + wave, RULES.maxAlive), `wave ${wave}: spawns stop at the cap`);
    fightWave(rules, h, { each });
    assert.equal(rules.spawned, 2 + wave, `wave ${wave} spawned everyone`);
    assert.ok(maxAlive <= RULES.maxAlive, `wave ${wave}: ${maxAlive} alive`);
    assert.equal(rules.phase, PHASE.BREAK, `wave ${wave} cleared`);
    assert.equal(rules.msg, MSG.CLEARED);
    assert.equal(rules.msgN, wave);
    run(rules, RULES.breakS + 0.05);
    assert.equal(rules.wave, wave + 1);
  }
  assert.deepEqual(log.slice(0, 5), ['start 1 3', 'clear 1', 'start 2 4', 'clear 2', 'start 3 5']);
});

test('spawns are paced, first after 1 s, and a failed spawn retries after 0.5 s', () => {
  let ok = false;
  const { rules, h } = make({ spawnOk: () => ok });
  rules.start();
  run(rules, RULES.readyS + 0.05);
  run(rules, RULES.firstSpawnS - 0.1);
  assert.equal(rules.spawnFails, 0);
  run(rules, 0.15);
  assert.equal(rules.spawnFails, 1);
  run(rules, 1.0);
  assert.equal(rules.spawnFails, 3, 'retried every 0.5 s');
  ok = true;
  run(rules, 0.6);
  assert.equal(h.spawns, 1);
  // the next one comes 1.5–3.5 s later
  run(rules, RULES.spawnGapMinS - 0.1);
  assert.equal(h.spawns, 1);
  run(rules, RULES.spawnGapMaxS - RULES.spawnGapMinS + 0.2);
  assert.equal(h.spawns, 2);
});

test('the wave is not clear while a dying body still counts, and kills before the last spawn do not end it', () => {
  const { rules, h } = make();
  rules.start();
  run(rules, RULES.readyS + 0.05);
  run(rules, 2);
  assert.ok(h.spawns >= 1);
  killAll(rules, h);
  rules.update(DT, 0, true, false);
  assert.equal(rules.phase, PHASE.WAVE, 'more to spawn');
  // host still counts a body as alive: spawned − killed caps it
  run(rules, 20);
  assert.equal(rules.spawned, 3);
  const before = h.living;
  for (let i = 0; i < before; i++) rules.kill(false);
  rules.update(DT, 0, true, false);
  assert.equal(rules.phase, PHASE.BREAK, 'cleared from the kill events even if the host count lags');
});

test('damage, heal 25 between waves (capped at 100), death → round over, Y tap restarts', () => {
  const { rules, h, log } = make();
  rules.start();
  run(rules, RULES.readyS + 0.05);
  assert.equal(rules.damage(40), 40);
  assert.equal(rules.health, 60);
  assert.deepEqual(h.healths.at(-1), [60, -40]);
  fightWave(rules, h);
  assert.equal(rules.phase, PHASE.BREAK);
  assert.equal(rules.health, 85, 'healed 25');
  run(rules, RULES.breakS + 0.05);
  rules.damage(10);
  fightWave(rules, h);
  assert.equal(rules.health, 100, 'capped');
  run(rules, RULES.breakS + 0.05);
  assert.equal(rules.wave, 3);
  run(rules, 3);
  h.living--;
  rules.kill(true);
  assert.equal(rules.headshots, 1);
  assert.equal(rules.damage(50), 50);
  assert.equal(rules.damage(80), 50, 'only what was left');
  assert.equal(rules.phase, PHASE.OVER);
  assert.equal(rules.msg, MSG.OVER);
  assert.ok(log.includes(`over 3 ${rules.kills}`), log.join());
  assert.equal(rules.damage(10), 0, 'no damage after death');
  // a long press does not restart; a tap does
  run(rules, 1.0, { y: true });
  run(rules, DT);
  assert.equal(rules.phase, PHASE.OVER);
  run(rules, 0.2, { y: true });
  run(rules, DT);
  assert.equal(rules.phase, PHASE.READY);
  assert.equal(rules.health, 100);
  assert.equal(rules.wave, 0);
  assert.equal(rules.kills, 0);
  assert.equal(h.restarts, 2);
  assert.deepEqual(h.healths.at(-1), [100, 0]);
});

test('Y tap does nothing outside round over; holding Y 2 s exits once, in any phase and while paused', () => {
  const { rules, h } = make();
  rules.start();
  run(rules, RULES.readyS + 0.05);
  run(rules, 0.2, { y: true });
  run(rules, DT);
  assert.equal(rules.phase, PHASE.WAVE);
  assert.deepEqual(h.exits, []);
  run(rules, 1.0, { y: true });
  assert.equal(rules.msg, MSG.EXITING, 'hint while holding');
  run(rules, 1.05, { y: true });
  assert.deepEqual(h.exits, ['holdY']);
  run(rules, 3, { y: true });
  assert.deepEqual(h.exits, ['holdY'], 'once');
  // while paused (outside the zone) it still works after a restart
  const b = make();
  b.rules.start();
  run(b.rules, 0.5, { dist: 2 });
  assert.equal(b.rules.paused, true);
  run(b.rules, 2.05, { dist: 2, y: true });
  assert.deepEqual(b.h.exits, ['holdY']);
});

test('safe zone: head beyond r pauses; resume after 0.5 s inside, then 3-2-1; leaving again restarts it', () => {
  const { rules, h } = make();
  rules.start();
  run(rules, RULES.readyS + 0.05);
  run(rules, 3);
  const spawned = rules.spawned;
  const wave = rules.wave;
  rules.update(DT, 0.79, true, false);
  assert.equal(rules.paused, false, 'inside r');
  rules.update(DT, 0.81, true, false);
  assert.equal(rules.paused, true);
  assert.deepEqual(h.pauses, [[true, PAUSE.ZONE]]);
  assert.equal(rules.msg, MSG.ZONE);
  // nothing advances while paused; damage ignored
  run(rules, 10, { dist: 1.2 });
  assert.equal(rules.spawned, spawned);
  assert.equal(rules.damage(30), 0);
  // hysteresis: on the line still counts as outside
  run(rules, 1, { dist: 0.79 });
  assert.equal(rules.msg, MSG.ZONE);
  // back inside: hold 0.5 s, then the countdown
  run(rules, 0.4, { dist: 0.5 });
  assert.equal(rules.msg, MSG.HOLD);
  run(rules, 0.15, { dist: 0.5 });
  assert.equal(rules.msg, MSG.COUNT);
  assert.equal(rules.msgN, 3);
  run(rules, 1.0, { dist: 0.5 });
  assert.equal(rules.msgN, 2);
  // step out during the countdown: back to "Return to your spot"
  rules.update(DT, 0.9, true, false);
  assert.equal(rules.msg, MSG.ZONE);
  assert.equal(rules.paused, true);
  run(rules, 0.55, { dist: 0.2 });
  run(rules, 2.9, { dist: 0.2 });
  assert.equal(rules.paused, true);
  run(rules, 0.2, { dist: 0.2 });
  assert.equal(rules.paused, false);
  assert.deepEqual(h.pauses, [[true, PAUSE.ZONE], [false, PAUSE.NONE]], 'one pause, one resume');
  assert.equal(rules.wave, wave);
  run(rules, 4);
  assert.ok(rules.spawned > spawned, 'the wave carries on');
});

test('visibility blur pauses; a frame gap (interrupt) pauses and runs the same resume', () => {
  const { rules, h } = make();
  rules.start();
  run(rules, 1);
  run(rules, 2, { visible: false });
  assert.equal(rules.paused, true);
  assert.equal(rules.msg, MSG.PAUSED);
  assert.deepEqual(h.pauses, [[true, PAUSE.HIDDEN]]);
  assert.equal(rules.phase, PHASE.READY, 'the get-ready clock stopped');
  run(rules, RULES.insideS + RULES.countdownS + 0.1);
  assert.equal(rules.paused, false);
  rules.interrupt();
  assert.equal(rules.paused, true);
  assert.equal(h.pauses.length, 3);
  run(rules, RULES.insideS + RULES.countdownS + 0.1);
  assert.equal(rules.paused, false);
  assert.equal(h.pauses.length, 4);
});

test('no pause while round over or idle', () => {
  const { rules, h } = make();
  run(rules, 1, { dist: 5, visible: false });
  assert.equal(rules.paused, false);
  rules.start();
  run(rules, RULES.readyS + 0.05);
  rules.damage(100);
  assert.equal(rules.phase, PHASE.OVER);
  run(rules, 1, { dist: 5 });
  assert.equal(rules.paused, false);
  assert.equal(h.pauses.length, 0);
});

test('seeded: the same seed gives the same spawn times', () => {
  const times = (seed) => {
    const { rules, h } = make({ seed });
    rules.start();
    const out = [];
    let last = 0, t = 0;
    for (let i = 0; i < 72 * 40; i++) {
      rules.update(DT, 0, true, false);
      t += DT;
      if (h.spawns !== last) { last = h.spawns; out.push(t.toFixed(3)); killAll(rules, h); }
    }
    return out.join(',');
  };
  assert.equal(times(7), times(7));
  assert.notEqual(times(7), times(8));
});

test('per-frame paths allocate nothing (sampling heap profiler)', async () => {
  const { rules, h } = make({ quiet: true });
  rules.start();
  let events = 0;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      rules.update(DT, (i % 700) / 500, (i % 5000) > 30, (i % 900) < 20);
      if (h.living > 2) { h.living--; rules.kill(i % 3 === 0); events++; }
      if (i % 20000 === 19999) { rules.damage(100); events++; } // deaths …
      if (i % 20000 === 100) { rules.start(); events++; } // … and restarts
    }
  };
  loop(200000); // warm the JIT on every path (a deopt would box doubles and blame update)
  // best of three: a steady allocation shows every time, a one-off JIT deopt does not
  let by = null, ev = 0;
  for (let r = 0; r < 3; r++) {
    events = 0;
    const b = await allocatedIn('/src/game/Rules.js', () => loop(200000));
    const sum = Object.values(b).reduce((x, y) => x + y, 0);
    if (!by || sum < Object.values(by).reduce((x, y) => x + y, 0)) { by = b; ev = events; }
    if (sum === 0) break;
  }
  events = ev;
  const perFrame = ['update', 'buttonY', 'pauseStep', 'phaseStep', 'refreshMsg', 'living', 'rand', 'clearPause'];
  for (const f of perFrame) assert.equal(by[f] || 0, 0, `${f} allocated ${by[f]} bytes over 200k frames`);
  // V8 may charge a few bytes to the entry of rarely run event functions (kill, startWave): bounded per event
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  assert.ok(total <= 128 * (events + rules.wave + 20), `Rules.js allocated ${total} bytes for ${events} events: ${JSON.stringify(by)}`);
});
