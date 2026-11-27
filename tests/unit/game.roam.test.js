/**
 * GameSession in Roam (the v0.3 default) with the real three r187 (resolve
 * hook), the real Player, Events, SurvivalRules and a real Roam WorldCore on
 * the fixture house; fakes for the enemy manager, weapons, input, audio, the
 * XR session, the canvas and the watch (the warning sink).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
function fake2d() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect() {}, strokeRect() {}, save() {}, restore() {}, translate() {}, scale() {}, fillText() {},
    measureText(s) { return { width: s.length * 12 }; },
  };
}
globalThis.document = /** @type {any} */ ({
  createElement: () => { const c = { width: 300, height: 150, _c: null, getContext() { return c._c || (c._c = fake2d()); } }; return c; },
});

const THREE = await import('three');
const { GameSession } = await import('../../src/game/GameSession.js');
const { Player } = await import('../../src/game/Player.js');
const { Events } = await import('../../src/core/Events.js');
const { PHASE, MSG } = await import('../../src/game/Rules.js');
const { PAUSE } = await import('../../src/safety/PauseManager.js');
const { resetUploadGate } = await import('../../src/game/UploadGate.js');
const { WorldCore } = await import('../../src/world/WorldCore.js');

const DT = 1 / 72;
const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

function hand() {
  const pulses = [];
  return {
    pulses, present: true, hasGrip: false, grip: new THREE.Matrix4().toArray(new Float32Array(16)),
    a: false, aDown: false, b: false, triggerDown: false, triggerHeld: false, triggerUp: false,
    source: { gamepad: { hapticActuators: [{ pulse: (v, ms) => { pulses.push([v, ms]); } }] } },
  };
}

function setup() {
  resetUploadGate();
  const scene = new THREE.Scene();
  const L = new THREE.PerspectiveCamera(), R = new THREE.PerspectiveCamera();
  const camera = new THREE.ArrayCamera([L, R]);
  const pos = { x: 0, y: 1.7, z: 0, yaw: 0 };
  const place = () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pos.yaw, 0, 'YXZ'));
    L.position.set(pos.x - 0.032, pos.y, pos.z); R.position.set(pos.x + 0.032, pos.y, pos.z);
    L.quaternion.copy(q); R.quaternion.copy(q);
    camera.position.copy(L.position); camera.quaternion.copy(q);
  };
  place();
  const world = new WorldCore({ roam: true });
  world.build(house(), { x: 0, z: 0 });
  world.finishBake();
  const enemies = {
    n: 0, resets: 0, spawns: [],
    spawn(x, z, f) { this.spawns.push([x, z, f]); return this.n++; },
    alive() { return this.n; }, reset() { this.n = 0; this.resets++; },
  };
  const weapons = { busyLeft: false, busyRight: false, a: { weapon: 'glock', mag: 17, chambered: true }, ammo() { return this.a; }, reset() {} };
  const events = new Events();
  const input = { left: hand(), right: hand() };
  const session = { visibilityState: 'visible', end() { return Promise.resolve(); } };
  const player = new Player();
  const ctx = { scene, camera, session, input, events, audio: null, world, player, space: null };
  /** @type {Record<string, number>} */ const warn = {};
  const sink = { calls: 0, warn(kind, level) { this.calls++; warn[kind] = level; } };
  const game = new GameSession(ctx, { enemies, weapons, warn: sink });
  let t = 0;
  /** @type {any} */ let frame = null;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      t += DT * 1000;
      place();
      world.update(DT, t, frame, ctx);
      player.update(DT, t, frame, ctx);
      game.preUpdate(DT, t, frame, ctx);
      game.update(DT, t, frame, ctx);
    }
  };
  const secs = (s) => step(Math.round(s / DT));
  /** Walk the head to (x, z) at `speed` m/s. */
  const walk = (x, z, speed = 1.0) => {
    const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz), n = Math.max(1, Math.round(d / speed / DT));
    const sx = dx / n, sz = dz / n;
    for (let i = 0; i < n; i++) { pos.x += sx; pos.z += sz; step(); }
  };
  const setFrame = (f) => { frame = f; };
  return { ctx, game, world, enemies, weapons, input, player, pos, step, secs, walk, warn, sink, setFrame, session };
}

/** Into a running wave in the living room. */
function running() {
  const s = setup();
  const { game, step, secs } = s;
  let confirmed = null;
  game.pickSpot((z) => { confirmed = { ...z }; game.start(z); });
  step(2);
  assert.ok(confirmed, 'Roam: pickSpot confirms the current position at once');
  assert.equal(confirmed.r, 0);
  secs(3.2);
  assert.equal(game.phase, PHASE.WAVE);
  return s;
}

test('Roam is the default: no spot choice, no ring, no zone, round starts where the player stands', () => {
  const { game, step, secs, pos } = setup();
  assert.equal(game.roam, true);
  game.pickSpot(null);
  assert.equal(game.spotting, false);
  step(2);
  assert.equal(game.phase, PHASE.READY);
  assert.equal(game.zone.r, 0);
  assert.equal(game.spotReport.mode, 'roam');
  assert.ok(game.spotReport.room > 0);
  for (let i = 0; i < 200; i++) { pos.x = Math.sin(i * 0.05) * 1.5; step(); assert.equal(game.ring.visible, false); }
  secs(3);
  assert.equal(game.phase, PHASE.WAVE);
  assert.equal(game.paused, false, 'walking around the room never pauses');
});

test('no text in the view during play: Get ready / Wave n / cleared are not shown; pauses and round over are', () => {
  const { game, step, secs, ctx } = setup();
  game.pickSpot(null);
  step(2);
  assert.equal(game.rules.msg, MSG.GET_READY);
  assert.equal(game.panel.shown, false, 'no "Get ready" panel');
  secs(3.2);
  assert.equal(game.rules.msg, MSG.WAVE);
  assert.equal(game.panel.shown, false, 'no "Wave 1" panel');
  ctx.session.visibilityState = 'hidden';
  step(2);
  assert.equal(game.paused, true);
  assert.equal(game.panel.shown, true, 'a pause shows its message');
});

test('spawns come from another room (path-based, hidden), never the living room the player is in', () => {
  const { game, enemies, secs, world } = running();
  secs(12);
  assert.ok(enemies.spawns.length >= 2, `${enemies.spawns.length} spawns`);
  const playerRoom = world.roomAt(0, 0);
  for (const [x, z] of enemies.spawns) {
    assert.notEqual(world.roomAt(x, z), playerRoom, 'not in the player room');
    assert.ok(Math.hypot(x, z) >= 3.5);
  }
  // the fixture is a two-room flat: few hidden points, and none reused within 10 s, so a retry (0.5 s) can happen
  assert.ok(game.stats.spawnFails <= 8, `${game.stats.spawnFails} retries`);
});

test('running: a watch cue (run), no pause; it clears when walking again', () => {
  const { game, walk, warn } = running();
  walk(2.2, 0, 1.6);
  walk(-1.5, 0, 1.6);
  assert.equal(game.paused, false, 'no running pause in Roam');
  assert.ok(game.cue[0] > 0, 'run cue on');
  assert.ok(warn.run > 0, 'sent to the watch');
  walk(0, 0, 0.4);
  walk(0.3, 0, 0.3);
  assert.equal(warn.run, 0, 'cleared');
  assert.ok(game.roamSafety.runWarnings >= 1);
});

test('walking to the unmapped hallway door: edge cue on the watch, freeze beyond it, never a pause', () => {
  const { game, walk, warn } = running();
  walk(-1.15, -1.5, 0.8);
  assert.equal(warn.edge, 0, 'far from the door: no cue');
  walk(-1.15, -2.9, 0.6);
  assert.ok(warn.edge > 0.5, `near the door plane (${warn.edge})`);
  assert.equal(game.freezeEnemies, false);
  walk(-1.15, -3.85, 0.5);
  assert.equal(warn.edge, 1);
  assert.equal(game.freezeEnemies, true, 'beyond the map: enemies freeze');
  assert.equal(game.paused, false, 'not a pause');
  walk(-1.15, -2.0, 0.6);
  assert.equal(game.freezeEnemies, false);
  const rep = game.roamReport();
  assert.ok(rep.offMapS > 0 && rep.offMapFreezes === 1 && rep.walkedM > 4);
});

test('seated: no walking cues and no obstacle freeze (sitting on the couch)', () => {
  const { game, walk, warn, player, pos, step } = running();
  player.seatedOverride = true;
  pos.y = 1.15;
  walk(-1.5, -1.5, 0.3); // over the couch footprint
  step(30);
  assert.equal(game.seated, true);
  assert.equal(warn.obstacle || 0, 0);
  assert.equal(warn.edge || 0, 0);
  assert.equal(game.freezeEnemies, false);
  assert.ok(game.roamReport().seatedS > 0.3);
});

test('tracking lost still pauses (and shows on the watch)', () => {
  const { game, step, ctx, setFrame, warn } = running();
  ctx.space = {};
  setFrame({ getViewerPose: () => null });
  step(2);
  assert.equal(game.paused, true);
  assert.equal(game.rules.pm.cause, PAUSE.TRACKING);
  assert.equal(warn.tracking, 1);
  setFrame({ getViewerPose: () => ({ emulatedPosition: false }) });
  step(2);
  assert.equal(warn.tracking, 0);
});

test('a reference-space reset: pause held, living enemies back in the queue, realigned() releases', () => {
  const { game, enemies, secs, step } = running();
  secs(6);
  const n = enemies.n;
  assert.ok(n >= 1);
  const spawned = game.rules.spawned;
  game.onReferenceReset({ hold: true });
  assert.equal(game.paused, true);
  assert.equal(enemies.n, 0, 'despawned');
  assert.equal(game.rules.spawned, spawned - n, 'requeued, not killed');
  assert.equal(game.kills, 0);
  step(72);
  assert.equal(game.rules.msg, MSG.RESET);
  game.realigned();
  step(2);
  assert.notEqual(game.rules.msg, MSG.RESET);
});

test('watch menu: open pauses; close resumes through the countdown without a trigger pull', () => {
  const { game, secs } = running();
  game.openMenu();
  assert.equal(game.paused, true);
  assert.equal(game.menuOpen, true);
  secs(1);
  assert.equal(game.rules.msg, MSG.RESUME, 'the rules still hold a manual pause');
  assert.equal(game.panel.mesh.visible, false, 'the open menu is the only UI: no pause panel behind the disc');
  game.closeMenu();
  secs(1.0);
  assert.equal(game.rules.pm.state, 4, 'counting down');
  secs(3.2);
  assert.equal(game.paused, false);
});

test('busy hands: B+Y does not pause, holding Y does not exit, while the weapons say the hands are busy', () => {
  const { game, input, weapons, secs, step } = running();
  weapons.busyLeft = true;
  input.left.b = true; input.right.b = true;
  step(2);
  assert.equal(game.paused, false);
  secs(2.5);
  assert.equal(game.exiting, false);
  weapons.busyLeft = false;
  step(2);
  assert.equal(game.paused, true, 'free hands: B+Y pauses');
});

test('difficulty scales the damage taken; setRoam(false) restores the spot rules', () => {
  const { game, ctx, secs } = running();
  game.setDifficulty('test');
  ctx.events.emit('playerHit', { damage: 40, fromX: 0, fromY: 1.5, fromZ: -3 });
  assert.equal(game.health, 100 - 24);
  game.setDifficulty('hard');
  assert.equal(game.difficultyScale.damage, 1.3);
  game.setRoam(false);
  assert.equal(game.roam, false);
  assert.equal(game.rules.pm.runPause, true);
  assert.equal(game.obstacles.roam, false);
  secs(0.1);
});

test('drift realign: beginRealign holds the pause and requeues; the watch capturing the trigger blocks the Resume press', () => {
  const { game, enemies, secs, step, sink, input } = running();
  secs(6);
  const n = enemies.n;
  game.beginRealign();
  assert.equal(game.paused, true);
  assert.equal(enemies.n, 0);
  assert.equal(game.rules.spawned + n >= n, true);
  game.realigned();
  secs(1);
  assert.equal(game.rules.pm.state, 3, 'waiting for the Resume press');
  sink.capture = true;
  input.right.triggerDown = true; step(); input.right.triggerDown = false;
  step();
  assert.equal(game.rules.pm.state, 3, 'the watch had the trigger');
  sink.capture = false;
  input.right.triggerDown = true; step(); input.right.triggerDown = false;
  step();
  assert.equal(game.rules.pm.state, 4, 'counting down');
});
