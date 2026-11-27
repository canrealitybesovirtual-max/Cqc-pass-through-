// v0.5: PlayKit's new session steps on a stub kit (the real methods, fake collaborators): the post-build
// frames (one action each), the walkthrough scan (card, tint, the watch's count, the finishing hold, the save,
// the build from the scan) and the silent learner's window (a changed result is built in only in a wave break
// with no enemy alive, never mid-fight).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
const addons = new URL('../../vendor/three/addons/', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s === 'three') return { url: ${JSON.stringify(threeUrl)}, shortCircuit: true };
   if (s.startsWith('three/addons/')) return { url: ${JSON.stringify(addons)} + s.slice(13), shortCircuit: true }; return next(s, c); }`,
));
globalThis.document = /** @type {any} */ ({ createElement: () => ({ width: 1, height: 1, getContext: () => new Proxy({}, {
  get: (t, k) => (k === 'measureText' ? (s) => ({ width: s.length * 10 }) : k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } }) }) });

const { PlayKit, STEP, SCAN_LINES, SCAN_HOLD_S } = await import('../../src/app/Play.js');
const { PHASE } = await import('../../src/game/Rules.js');

function stub() {
  const calls = [];
  const hand = () => ({ triggerHeld: false, triggerUp: false });
  const k = Object.create(PlayKit.prototype);
  Object.assign(k, {
    step: STEP.IDLE, t0: 0, perf: null, rec: { play: {} }, snapshot: { planes: [], meshes: [] }, builtLines: ['Get ready', 'x'],
    post: { stage: 0, next: STEP.WARM, kind: '', lines: null },
    scanS: { on: false, t0: 0, cardUp: false, hold: 0, finishing: false, finishAt: 0, finishSeq: 0, seenSeq: -1, ms: 0 },
    _scanStatus: { scanning: true, rooms: 0, learn: 0 }, scanDone: false, learnWindow: false, learnBuilds: [], appliedKey: '',
    _bq: { active: false, done: false, ok: false, kind: '', seq: 0, t0: 0, frames: 0, worldMaxMs: 0, sysMaxMs: 0, waitMs: 0 }, _buildSeq: 0,
    ctx: { input: { left: hand(), right: hand() } }, player: { valid: true, head: { x: 1, y: 1.6, z: 2 } },
    game: { roam: true, rules: { zoneR: 0 }, phase: PHASE.WAVE, spotting: false },
    enemies: { alive: () => 0 },
    world: { busy: false, snapshot: { planes: [], meshes: [] }, start: { x: 0, z: 0 }, floorY: () => 0, bakeBudgetMs: 0, stats: { workerMs: 0, workerBuilds: 0, applyFrames: 0, applyMaxMs: 0, applyPhaseMs: {} },
      buildAsync: (s) => { calls.push(['build', s]); return Promise.resolve(true); } },
    builder: null,
    look: { onWorldBuilt: () => calls.push(['look']), snap: () => calls.push(['snap']) },
    watch: { capture: false, menuOpen: false, setStatus: (o) => calls.push(['watch', { ...o }]), haptic: () => calls.push(['haptic']) },
    scanTint: { shown: false, show(on) { this.shown = on; }, update() {} },
    learner: { result: null, resultSeq: 0, state: 'open', scanning: false, setScanning(on) { this.scanning = on; }, analyzeNow() { calls.push(['analyze']); return true; },
      save: (r) => { calls.push(['save', r]); return true; }, overlay: () => null, report: () => ({ result: null }) },
  });
  k.makeCard = () => calls.push(['card']);
  return { k, calls };
}

test('post-build: the card, the look\'s rebuild, its light snap and the card layout each get a frame, then the next step', () => {
  const { k, calls } = stub();
  k.postStart(STEP.WARM, 'capture');
  assert.equal(k.step, STEP.POST);
  const seen = [];
  for (let f = 0; f < 6 && k.step === STEP.POST; f++) { const n = calls.length; k.postStep(); seen.push(calls.slice(n).map((c) => c[0]).join('+') || (k.step === STEP.POST ? 'layout' : 'next')); }
  assert.deepEqual(seen, ['card', 'look', 'snap', 'layout', 'next']);
  assert.equal(k.step, STEP.WARM);
  assert.deepEqual(k.post.lines, k.builtLines);
  // a learned rebuild in play: no card, no snap (the lights ease), back to PLAY; no panel meanwhile
  const s2 = stub();
  s2.k.postStart(STEP.PLAY, 'learn');
  assert.equal(s2.k.panelLines(), null);
  while (s2.k.step === STEP.POST) s2.k.postStep();
  assert.deepEqual(s2.calls.map((c) => c[0]), ['look']);
  assert.equal(s2.k.step, STEP.PLAY);
});

test('scan: a card, then only the tint and the watch; the rooms count follows the results; a 1.5 s hold finishes, saves, builds from the scan', async () => {
  const { k, calls } = stub();
  let t = 1000;
  k.scanBegin(t);
  assert.equal(k.step, STEP.SCAN);
  assert.equal(k.panelLines(), SCAN_LINES);
  assert.ok(k.scanTint.shown && k.learner.scanning);
  // the card drops on a trigger release after 1 s
  k.ctx.input.left.triggerUp = true; t += 1200; k.scanStep(1 / 72, t); k.ctx.input.left.triggerUp = false;
  assert.equal(k.panelLines(), null, 'nothing in the view while scanning');
  k.learner.result = { rooms: 3, coverage: 0.4, key: 'k1' }; k.learner.resultSeq = 1;
  k.scanStep(1 / 72, t += 14);
  const w = calls.filter((c) => c[0] === 'watch').at(-1)[1];
  assert.deepEqual([w.scanning, w.rooms, w.learn], [true, 3, 0.4]);
  // hold the trigger
  k.ctx.input.right.triggerHeld = true;
  for (let f = 0; f < Math.ceil(SCAN_HOLD_S * 72) + 2; f++) k.scanStep(1 / 72, t += 1000 / 72);
  assert.ok(k.scanS.finishing && calls.some((c) => c[0] === 'analyze') && calls.some((c) => c[0] === 'haptic'));
  k.ctx.input.right.triggerHeld = false;
  k.learner.resultSeq = 2; // the final result came in
  k.scanStep(1 / 72, t += 14);
  assert.ok(k.scanDone && !k.scanTint.shown && !k.learner.scanning);
  assert.deepEqual(calls.filter((c) => c[0] === 'save').map((c) => c[1]), ['scan']);
  assert.equal(k.step, STEP.BUILD);
  assert.equal(k._bq.kind, 'scan');
  assert.equal(k.appliedKey, 'k1');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.some((c) => c[0] === 'build'));
});

test('silent learner: a changed result is built in only in a wave break with nobody alive; the window always saves', async () => {
  const { k, calls } = stub();
  k.step = STEP.PLAY;
  k.learner.result = { key: 'k2' };
  k.appliedKey = 'k1';
  // mid-fight: the window saves, never builds
  k.learnWindow = true;
  k.learnStep(5000);
  assert.deepEqual(calls.map((c) => c[0]), ['save']);
  assert.equal(k._bq.active, false);
  // a wave break with an enemy still alive: no build
  k.game.phase = PHASE.BREAK;
  k.enemies.alive = () => 1;
  k.learnWindow = true;
  k.learnStep(6000);
  assert.equal(k._bq.active, false);
  // nobody alive: built (worker), then the post frames back to PLAY
  k.enemies.alive = () => 0;
  k.learnWindow = true;
  k.learnStep(7000);
  assert.ok(k._bq.active && k._bq.kind === 'learn' && k.appliedKey === 'k2');
  await new Promise((r) => setTimeout(r, 0));
  k.learnStep(7100);
  assert.equal(k.step, STEP.POST);
  assert.equal(k.learnBuilds.length, 1);
  while (k.step === STEP.POST) k.postStep();
  assert.equal(k.step, STEP.PLAY);
  // the same result again: nothing to build
  k.learnWindow = true;
  const n = calls.filter((c) => c[0] === 'build').length;
  k.learnStep(9000);
  assert.equal(calls.filter((c) => c[0] === 'build').length, n);
});
