// Enemy decisions and movement (src/enemies/Brain.js), on the real world module
// built from tests/fixtures/house.json (player at (0, 0) in the living room),
// and in an open field without a world for the timing rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorldCore } from '../../src/world/WorldCore.js';
import { AI, Brain, ST } from '../../src/enemies/Brain.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const DT = 1 / 72;

function player(x = 0, z = 0) {
  return { head: { x, y: 1.65, z }, torsoTop: { x, y: 1.35, z }, torsoBottom: { x, y: 0.97, z }, alive: true };
}

/**
 * Survival-like run on the house: spawns through world.findSpawn every 2 s up
 * to `n`, then `seconds` of play. Returns per-frame invariant counters.
 */
function simulate(seed, n = 4, seconds = 60) {
  const w = new WorldCore({ seed });
  w.build(house(), { x: 0, z: 0 });
  const planner = w.createPlanner();
  const brain = new Brain({ maxEnemies: 6, seed });
  brain.attach(w, planner);
  const p = player();
  const out = { x: 0, z: 0 };
  const r = {
    brain, w, frames: 0, offNav: 0, tooClose: 0, maxShooters: 0, shotsWithoutSlot: 0, shots: 0, minDist: Infinity,
    firstSight: new Float64Array(6).fill(-1), firstShot: new Float64Array(6).fill(-1), lastShot: new Float64Array(6).fill(-1),
    minGap: Infinity, engaged: new Uint8Array(6), spawned: 0, trace: [],
  };
  let t = 0, nextSpawn = 0.5;
  for (let k = 0; k < seconds * 72; k++) {
    t += DT;
    w.update(DT, t * 1000);
    if (r.spawned < n && t >= nextSpawn) {
      nextSpawn = t + 2;
      if (w.findSpawn(p.head.x, p.head.z, 0, -1, 3.5, out)) {
        const i = brain.agents.findIndex((a) => !a.active);
        brain.spawn(i, out.x, out.z, Math.atan2(p.head.x - out.x, p.head.z - out.z));
        r.spawned++;
      }
    }
    brain.update(DT, p);
    r.frames++;
    let shooters = 0;
    for (const a of brain.agents) {
      if (!a.alive) continue;
      if (!w.nav.isWalkable(a.x, a.z)) r.offNav++;
      const d = Math.hypot(a.x - p.head.x, a.z - p.head.z);
      r.minDist = Math.min(r.minDist, d);
      if (d < AI.keepAway - 0.02) r.tooClose++;
      if (a.slot) shooters++;
      if (a.los && r.firstSight[a.i] < 0) r.firstSight[a.i] = t;
      if (a.state === ST.HOLD && a.los && d >= AI.ringMin - 0.2 && d <= AI.ringMax + 0.6) r.engaged[a.i] = 1;
      if (a.fire) {
        r.shots++;
        if (!a.slot) r.shotsWithoutSlot++;
        if (r.firstShot[a.i] < 0) r.firstShot[a.i] = t;
        if (r.lastShot[a.i] >= 0) r.minGap = Math.min(r.minGap, t - r.lastShot[a.i]);
        r.lastShot[a.i] = t;
      }
    }
    r.maxShooters = Math.max(r.maxShooters, shooters, brain.shooters);
    if (k % 72 === 0) r.trace.push(brain.agents.map((a) => `${a.x.toFixed(2)},${a.z.toFixed(2)},${a.state}`).join(' '));
  }
  return r;
}

test('house run: on walkable cells, never within 2.5 m, at most 2 shooters, shots only with a slot', () => {
  for (const seed of [1, 7, 42]) {
    const r = simulate(seed);
    assert.ok(r.spawned >= 3, `seed ${seed}: ${r.spawned} spawned`);
    assert.equal(r.offNav, 0, `seed ${seed}: frames off the nav grid`);
    assert.equal(r.tooClose, 0, `seed ${seed}: closer than ${AI.keepAway} m (min ${r.minDist.toFixed(2)})`);
    assert.ok(r.maxShooters <= AI.maxShooters, `seed ${seed}: ${r.maxShooters} shooters`);
    assert.equal(r.shotsWithoutSlot, 0);
    assert.ok(r.shots > 20, `seed ${seed}: ${r.shots} shots in 60 s`);
    assert.ok(r.minGap >= 60 / AI.rpm - DT - 1e-9, `seed ${seed}: shots ${r.minGap.toFixed(3)} s apart (600 rpm)`);
    for (let i = 0; i < 6; i++) {
      if (r.firstShot[i] < 0) continue;
      const react = r.firstShot[i] - r.firstSight[i];
      assert.ok(react >= AI.react[0] * 0.85 - 2 * DT, `seed ${seed} enemy ${i}: fired ${react.toFixed(2)} s after first sight`);
    }
    const engaged = r.engaged.reduce((s, v) => s + v, 0);
    assert.ok(engaged >= 2, `seed ${seed}: ${engaged} enemies reached an engagement point with sight 3–7 m out`);
  }
});

test('seeded runs are deterministic', () => {
  const a = simulate(5, 3, 20), b = simulate(5, 3, 20);
  assert.equal(a.shots, b.shots);
  assert.deepEqual(a.trace, b.trace);
});

/** Open field, no world: everyone sees the player. */
function field(n, seed = 3) {
  const brain = new Brain({ maxEnemies: 6, seed });
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const x = Math.sin(ang) * 5, z = Math.cos(ang) * 5;
    brain.spawn(i, x, z, Math.atan2(-x, -z));
  }
  return brain;
}

test('reaction 0.45–0.85 s, aim error 0.07 → 0.012 rad over 0.9 s', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const brain = field(1, seed);
    const a = brain.agents[0];
    const p = player();
    let t = 0, sight = -1, first = -1;
    let errAtSight = 0, errLate = 1;
    for (let k = 0; k < 72 * 3 && first < 0; k++) {
      t += DT;
      brain.update(DT, p);
      if (a.los && sight < 0) { sight = t; errAtSight = a.aimErr; }
      if (sight >= 0 && t - sight > 0.92 && first < 0) errLate = Math.min(errLate, a.aimErr);
      if (a.fire) first = t;
    }
    assert.ok(sight >= 0 && first > 0, `seed ${seed}: saw and fired`);
    const react = first - sight;
    // the reaction clock starts at the decision; the rifle mount (0.32 s) overlaps it
    assert.ok(react >= AI.react[0] - DT && react <= AI.react[1] + 0.12, `seed ${seed}: reaction ${react.toFixed(3)} s`);
    assert.ok(Math.abs(errAtSight - AI.aimErr0) < 0.005, `aim error on sight ${errAtSight}`);
    if (errLate < 1) assert.ok(errLate < AI.aimErr1 + 0.003, `aim error after 0.9 s: ${errLate}`);
  }
});

test('bursts of 2–4 at 600 rpm, 30-round magazine and a reload', () => {
  const brain = field(1, 11);
  const a = brain.agents[0];
  const p = player();
  const times = [];
  let reloads = 0;
  for (let k = 0; k < 72 * 30; k++) {
    brain.update(DT, p);
    if (a.fire) times.push(k * DT);
    if (a.reloadStart) reloads++;
  }
  assert.ok(times.length > 30, `${times.length} shots in 30 s`);
  assert.ok(reloads >= 1, 'reloaded after 30 rounds');
  const bursts = [];
  let cur = 1;
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g < 0.2) { cur++; assert.ok(Math.abs(g - 0.1) <= DT + 1e-9, `in-burst gap ${g.toFixed(3)}`); } else { bursts.push(cur); cur = 1; }
  }
  bursts.push(cur);
  const full = bursts.slice(0, -1);
  assert.ok(full.every((b) => b >= 1 && b <= AI.burst[1]), `burst sizes ${full.join(',')}`);
  assert.ok(full.filter((b) => b >= AI.burst[0]).length >= full.length * 0.8, `mostly 2–4: ${full.join(',')}`);
});

test('five enemies on the player: never more than two shooting at once', () => {
  const brain = field(5, 21);
  const p = player();
  const lastFire = new Float64Array(6).fill(-10);
  let worst = 0, total = 0;
  const shooters = new Set();
  for (let k = 0; k < 72 * 20; k++) {
    const t = k * DT;
    brain.update(DT, p);
    for (const a of brain.agents) if (a.fire) { lastFire[a.i] = t; total++; shooters.add(a.i); }
    let active = 0;
    for (let i = 0; i < 6; i++) if (t - lastFire[i] < 0.11) active++;
    worst = Math.max(worst, active);
  }
  assert.ok(total > 40, `${total} shots`);
  assert.ok(worst <= 2, `${worst} enemies firing within one 600 rpm interval`);
  assert.ok(shooters.size >= 3, `the slot rotates: ${shooters.size} different shooters`);
});

test('a hit flinches (no fire for a moment), a near miss suppresses, a shot alerts', () => {
  const brain = field(1, 31);
  const a = brain.agents[0];
  const p = player();
  let k = 0;
  while (!a.fire && k++ < 72 * 3) brain.update(DT, p);
  assert.ok(a.fire, 'firing');
  brain.hit(0, 1);
  let quiet = 0;
  do { brain.update(DT, p); quiet++; } while (!a.fire && quiet < 72 * 2);
  quiet--;
  assert.ok(quiet * DT >= AI.flinch * 0.9, `quiet for ${(quiet * DT).toFixed(2)} s after the hit`);
  // a round passing 0.3 m from his chest (from the player toward him)
  const errBefore = a.aimErr;
  const dx = a.x - 0.3, dz = a.z, l = Math.hypot(dx, dz);
  brain.hearShot(0, 1.3, 0, dx / l, 0, dz / l);
  assert.ok(a.suppressT > 0, 'suppressed');
  assert.ok(a.aimErr > errBefore, 'aim error up');
  // hearing: a fresh enemy far away is alerted
  const b2 = field(2, 32);
  b2.agents[1].aware = false;
  b2.hearShot(0, 1.3, 0, 0, 0, -1);
  assert.ok(b2.agents[1].aware, 'heard the shot');
});

test('stuck: re-plans twice, then picks a new point', () => {
  // fake world: walkable for x < 1 only; the planner always returns a straight path to x = 3
  const nav = {
    isWalkable: (x) => x < 1, pathDistance: () => 5, index: () => 0, region: new Uint16Array(1),
    nearestWalkable: () => 0, centerX: () => 0.5, centerZ: () => 0, clearance: () => 1, clr: new Float32Array(1),
  };
  const world = { nav, segmentClear: () => false, floorY: () => 0 };
  const requests = [];
  const planner = {
    request: (id, sx, sz, gx, gz) => requests.push([sx, sz, gx, gz]),
    step: () => 0,
    result: (id, out) => { out[0] = 0; out[1] = 0; out[2] = 3; out[3] = 0; return 2; },
    cancel: () => {},
  };
  const brain = new Brain({ maxEnemies: 1, seed: 1 });
  brain.attach(world, planner);
  brain.spawn(0, 0, 0, Math.PI / 2);
  const a = brain.agents[0];
  // pretend he chose a goal behind the wall
  a.hasGoal = true; a.goalX = 3; a.goalZ = 0; a.state = ST.MOVE; a.pathWait = true;
  const p = player(0, 10);
  const goals0 = brain.stats.goals;
  for (let k = 0; k < 72 * 4; k++) brain.update(DT, p);
  assert.ok(a.x < 1, `never through the wall (x ${a.x.toFixed(2)})`);
  assert.ok(brain.stats.repaths >= AI.maxRepaths, `${brain.stats.repaths} re-plans`);
  assert.ok(brain.stats.goals > goals0, 'then a new decision');
});

test('never fires through a mate', () => {
  const brain = new Brain({ maxEnemies: 2, seed: 4 });
  brain.spawn(0, 0, 6, Math.PI); // shooter, 6 m out
  brain.spawn(1, 0, 3.2, Math.PI); // mate right in his line, 3.2 m out
  const p = player();
  let shots0 = 0;
  for (let k = 0; k < 72 * 4; k++) {
    brain.update(DT, p);
    brain.agents[1].x = 0; brain.agents[1].z = 3.2; // the mate holds still in the line
    brain.agents[0].x = 0; brain.agents[0].z = 6;
    if (brain.agents[0].fire) shots0++;
  }
  assert.equal(shots0, 0, 'the shooter behind held fire');
  assert.ok(brain.stats.blocked > 0);
  assert.ok(brain.agents[0].blockedT > 0 || brain.agents[0].state === ST.MOVE, 'and wants to move');
});
