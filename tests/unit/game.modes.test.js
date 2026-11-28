// v0.6 game modes (src/game/Rules.js): room clearing (every defender placed at once, the house clear when they are
// all down, the time scored) and home defense (waves breaching through the exterior doors in stacks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE, MSG, PHASE, RULES, SPAWN_KIND, SurvivalRules, modeFrom } from '../../src/game/Rules.js';

const DT = 1 / 72;

/** A fake host: an enemy pool that spawns on demand and logs each spawn's kind and door. */
function make(mode, { hides = 4, doors = 2 } = {}) {
  const h = {
    living: 0, spawns: [], cleared: null, overs: [],
    spawn(kind, door) { h.spawns.push({ kind, door, t: r.roundS }); h.living++; return true; },
    alive() { return h.living; },
    hides() { return hides; },
    breachDoors() { return doors; },
    cleared(s, k) { h.cleared = { s, k }; },
    waveStart() {}, waveClear() {}, roundOver(w, k) { h.overs.push([w, k]); }, pause() {}, health() {}, restart() {}, exit() {},
  };
  const r = new SurvivalRules(h, { seed: 7, runPause: false, mode });
  r.pm.setTracking(true); r.pm.setControllers(true, true);
  return { r, h };
}
const run = (r, s) => { for (let t = 0; t < s; t += DT) r.update(DT, 0, true, false); };
const killOne = (r, h) => { h.living--; r.kill(false); };

test('modeFrom: names, URL queries, defaults', () => {
  assert.equal(modeFrom('clear'), MODE.CLEAR);
  assert.equal(modeFrom('Defend'), MODE.DEFEND);
  assert.equal(modeFrom('?x=1&mode=defense'), MODE.DEFEND);
  assert.equal(modeFrom('?mode=rooms'), MODE.CLEAR);
  assert.equal(modeFrom('?difficulty=realistic'), MODE.SURVIVAL);
  assert.equal(modeFrom(''), MODE.SURVIVAL);
  assert.equal(modeFrom(null), MODE.SURVIVAL);
});

test('room clearing: every defender is placed at the start, hidden; the house is clear when all are down; the time is the score', () => {
  const { r, h } = make(MODE.CLEAR, { hides: 4 });
  r.start();
  run(r, RULES.readyS + 0.2);
  assert.equal(r.phase, PHASE.WAVE);
  assert.equal(h.spawns.length, 4, 'all four in the first frames');
  assert.ok(h.spawns.every((s) => s.kind === SPAWN_KIND.HIDE));
  assert.ok(h.spawns.at(-1).t < 0.2, 'placed within a few frames');
  run(r, 10);
  for (let i = 0; i < 3; i++) killOne(r, h);
  run(r, 5);
  assert.equal(r.phase, PHASE.WAVE, 'one is still alive');
  killOne(r, h);
  run(r, 0.1);
  assert.equal(r.phase, PHASE.OVER);
  assert.equal(r.cleared, true);
  assert.ok(Math.abs(h.cleared.s - 15.2) < 0.3, `time ${h.cleared.s}`);
  assert.equal(h.cleared.k, 4);
  assert.equal(r.msg, MSG.HOUSE_CLEAR);
  run(r, 30);
  assert.equal(r.msg, MSG.HOUSE_CLEAR, 'the result stays up until a restart');
  r.start();
  assert.equal(r.cleared, false);
  assert.equal(r.roundS, 0);
});

test('room clearing in a house with nothing to clear runs survival waves instead', () => {
  const { r, h } = make(MODE.CLEAR, { hides: 0 });
  r.start();
  run(r, RULES.readyS + 4);
  assert.equal(r.phase, PHASE.WAVE);
  assert.ok(h.spawns.length >= 1 && h.spawns.every((s) => s.kind === SPAWN_KIND.ROAM));
  assert.equal(r.total, RULES.baseEnemies + 1);
});

test('room clearing: the soldier pool caps the defenders', () => {
  const { r, h } = make(MODE.CLEAR, { hides: 11 });
  r.start();
  run(r, RULES.readyS + 1);
  assert.equal(h.spawns.length, RULES.clearMax);
});

test('home defense: stacks of 2–3 through one exterior door each, close together, pauses between stacks, at most 5 alive', () => {
  const { r, h } = make(MODE.DEFEND, { doors: 3 });
  r.start();
  run(r, RULES.readyS + 0.05);
  assert.equal(r.total, RULES.defendBase + 1);
  let maxAlive = 0;
  for (let t = 0; t < 60 && r.phase === PHASE.WAVE; t += DT) { r.update(DT, 0, true, false); maxAlive = Math.max(maxAlive, h.living); }
  assert.equal(h.spawns.length, 4);
  assert.ok(h.spawns.every((s) => s.kind === SPAWN_KIND.BREACH && s.door >= 0 && s.door < 3));
  // group into stacks by gap
  const stacks = [[h.spawns[0]]];
  for (let i = 1; i < h.spawns.length; i++) {
    const gap = h.spawns[i].t - h.spawns[i - 1].t;
    if (gap <= RULES.stackGapS[1] + 0.05) stacks.at(-1).push(h.spawns[i]);
    else { assert.ok(gap >= RULES.stackPauseS[0] - 0.05, `gap ${gap}`); stacks.push([h.spawns[i]]); }
  }
  for (const s of stacks) {
    assert.ok(s.length >= 1 && s.length <= 3);
    assert.ok(s.every((q) => q.door === s[0].door), 'one door per stack');
  }
  assert.ok(stacks[0].length >= 2);
  assert.ok(maxAlive <= RULES.defendMaxAlive);
  // the wave is held when everyone is down; the next one is bigger
  while (h.living) killOne(r, h);
  run(r, 0.1);
  assert.equal(r.phase, PHASE.BREAK);
  assert.equal(r.wavesHeld, 1);
  run(r, RULES.breakS + 0.1);
  assert.equal(r.total, RULES.defendBase + 2);
});

test('home defense with no exterior door: enemies come as in survival', () => {
  const { r, h } = make(MODE.DEFEND, { doors: 0 });
  r.start();
  run(r, RULES.readyS + 2);
  assert.ok(h.spawns.length >= 1 && h.spawns.every((s) => s.kind === SPAWN_KIND.ROAM));
});
