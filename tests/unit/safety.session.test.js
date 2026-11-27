/**
 * The safety layer wired into GameSession, with the real three r187 (resolve
 * hook, as in game.session.test.js), the real Player, Events, SurvivalRules,
 * PauseManager, SafeSpot, ObstacleWarnings and SafetyView, and the real
 * WorldCore on the house fixture. Fakes: the enemy manager (scene roots), the
 * weapon system's world root, input, audio, the XR session / frame, the canvas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Session } from 'node:inspector/promises';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));

const REC = { on: true };
function fake2d() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect() {}, strokeRect() {}, save() {}, restore() {}, translate() {}, scale() {}, fillText() {},
    measureText(s) { return { width: s.length * 12 }; },
  };
}
globalThis.document = /** @type {any} */ ({
  createElement: () => {
    const c = { width: 300, height: 150, _c: null, getContext() { return c._c || (c._c = fake2d()); } };
    return c;
  },
});

const THREE = await import('three');
const { GameSession } = await import('../../src/game/GameSession.js');
const { Player } = await import('../../src/game/Player.js');
const { Events } = await import('../../src/core/Events.js');
const { PHASE, RULES } = await import('../../src/game/Rules.js');
const { resetUploadGate } = await import('../../src/game/UploadGate.js');
const { SafetyView, arrowGeometry } = await import('../../src/safety/SafetyView.js');
const { ObstacleWarnings, POINT } = await import('../../src/safety/ObstacleWarnings.js');
const { RESUME, VIOLATION } = await import('../../src/safety/PauseManager.js');
const { houseWorld } = await import('./safety.rooms.js');

const DT = 1 / 72;

function hand() {
  const pulses = [];
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[13] = -5; // far below the floor: no obstacle until a test moves it
  return {
    pulses,
    present: true, hasGrip: true, grip: m,
    a: false, aDown: false, b: false, triggerDown: false, triggerHeld: false,
    source: { gamepad: { hapticActuators: [{ pulse: (v, ms) => { if (REC.on) pulses.push([v, ms]); } }] } },
  };
}

function setup({ world = houseWorld() } = {}) {
  resetUploadGate();
  const scene = new THREE.Scene();
  const L = new THREE.PerspectiveCamera(), R = new THREE.PerspectiveCamera();
  const camera = new THREE.ArrayCamera([L, R]);
  /** eyes at (x, y, z), yaw about +Y (0 = facing −z) */
  const head = (x, y, z, yaw = 0) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    L.position.set(x - 0.032, y, z); R.position.set(x + 0.032, y, z);
    L.quaternion.copy(q); R.quaternion.copy(q);
    camera.position.copy(L.position); camera.quaternion.copy(q);
  };
  head(0, 1.7, 0);
  const roots = [new THREE.Group(), new THREE.Group()];
  roots.forEach((r, i) => { r.name = `enemy-${i}`; scene.add(r); });
  const flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  scene.add(flashMesh);
  const enemies = {
    n: 0, resets: 0, spawns: [],
    spawn(x, z, f) { this.spawns.push([x, z, f]); roots[this.n % 2].visible = true; return this.n++; },
    alive() { return this.n; }, reset() { this.n = 0; this.resets++; },
    warmMeshes: () => [...roots, flashMesh],
  };
  const weapons = { worldRoot: new THREE.Group(), resets: 0, reset() { this.resets++; } };
  weapons.worldRoot.name = 'w2-world';
  scene.add(weapons.worldRoot);
  const audio = { plays: [], ui: [], play(k) { if (REC.on) this.plays.push(k); return 1; }, playUI(k) { if (REC.on) this.ui.push(k); return 1; } };
  const events = new Events();
  const input = { left: hand(), right: hand(), hands: 0 };
  const session = { visibilityState: 'visible', end() { return Promise.resolve(); } };
  const player = new Player();
  const ctx = { scene, camera, session, space: null, input, events, audio, world, player };
  const game = new GameSession(ctx, { enemies, weapons });
  const seen = [];
  events.on('pause', (p) => { if (REC.on) seen.push({ ...p }); });
  let t = 0;
  /** @type {any} */ let frame = null;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      t += DT * 1000;
      player.update(DT, t, frame, ctx);
      game.update(DT, t, frame, ctx);
    }
  };
  const secs = (s) => step(Math.round(s / DT));
  const pull = () => { input.right.triggerDown = true; step(); input.right.triggerDown = false; };
  const setFrame = (f) => { frame = f; };
  return { ctx, game, world, enemies, weapons, roots, audio, events, input, session, player, seen, head, step, secs, pull, scene, setFrame };
}

/** Wait for the prompt, pull, count down. */
function resume(S) {
  for (let i = 0; i < 72 * 3 && S.game.rules.pm.state !== RESUME.READY; i++) S.step();
  assert.equal(S.game.rules.pm.state, RESUME.READY, `state ${S.game.rules.pm.state}`);
  S.pull();
  S.secs(RULES.countdownS + 0.1);
  assert.equal(S.game.paused, false);
}

/** A round at the house's best spot (the couch and table are within reach everywhere). */
function playing(S) {
  S.head(0.3, 1.7, -0.385);
  S.step(2);
  S.game.start({ x: 0.3, z: -0.3, r: 0.8 });
  S.secs(RULES.readyS + 0.2);
  assert.equal(S.game.phase, PHASE.WAVE);
}

test('SafetyView: fixed outline buffer, an up-facing arrow, the veil adopts scene children but never lights', () => {
  const v = new SafetyView();
  const scene = new THREE.Scene();
  v.addTo(scene);
  assert.deepEqual(v.warmMeshes().map((m) => m.name), ['safety-outline', 'safety-arrow']);
  assert.equal(v.outline.material.transparent, true);
  assert.equal(v.outline.material.depthTest, false);
  const arr = v.outlinePos.array;
  assert.equal(arr.length, 4 * 24 * 3);
  // the arrow: up-facing triangles, FrontSide, unit length along +Z
  const g = arrowGeometry();
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) assert.ok(n.getY(i) > 0.99);
  assert.equal(v.arrow.material.side, THREE.FrontSide);
  g.computeBoundingBox();
  assert.ok(Math.abs(g.boundingBox.max.z - 1) < 1e-6 && Math.abs(g.boundingBox.min.z) < 1e-6);
  v.showArrow(1, 0, 2, 1, 0, 0xffffff, 0.8, 0.35);
  v.arrow.updateMatrixWorld();
  const tip = new THREE.Vector3(0, 0, 1).applyMatrix4(v.arrow.matrixWorld);
  assert.ok(Math.abs(tip.x - 1.35) < 1e-6 && Math.abs(tip.z - 2) < 1e-6, `tip ${tip.toArray()}`);
  assert.ok(tip.y > 0.005 && tip.y < 0.02, 'just above the floor');
  v.showArrow(1, 0, 2, 0, 0, 0xffffff, 0.8);
  assert.equal(v.arrow.visible, false, 'no direction: hidden');
  // warm: both drawn, then hidden
  v.setWarm(true, { position: new THREE.Vector3(0, 1.6, 0) });
  assert.ok(v.outline.visible && v.arrow.visible && v.outline.geometry.drawRange.count > 0);
  v.setWarm(false);
  assert.ok(!v.outline.visible && !v.arrow.visible);
  // the veil
  const a = new THREE.Group(), b = new THREE.Group(), inner = new THREE.Group(), lit = new THREE.Group();
  scene.add(a, b, lit);
  a.add(inner);
  lit.add(new THREE.PointLight());
  assert.equal(v.adopt([a, b, inner, lit, a]), 2);
  assert.equal(a.parent, v.veil);
  assert.equal(inner.parent, a, 'not a scene child: left where it is');
  assert.equal(lit.parent, scene, 'holds a light: never hidden (program keys)');
  assert.equal(v.notes.length, 2);
  v.setHidden(true);
  assert.equal(v.veil.visible, false);
  assert.equal(a.visible, true, 'owners keep their own flags');
  v.reset();
  assert.equal(v.veil.visible, true);
  // outline rewrites only on a new version; the same attribute object, never reallocated
  const ow = new ObstacleWarnings();
  const w = houseWorld();
  ow.setPoint(POINT.HEAD, 0.3, 1.6, 0.7);
  ow.update(DT, w.shapes);
  const attr = v.outlinePos;
  const ver0 = attr.version;
  v.updateOutline(ow, w.shapes, (x, z) => w.floorY(x, z));
  assert.equal(v.outline.visible, true);
  assert.equal(v.outline.geometry.drawRange.count, 12, 'the south wall patch');
  assert.equal(attr.version, ver0 + 1);
  ow.update(DT, w.shapes);
  v.updateOutline(ow, w.shapes, (x, z) => w.floorY(x, z));
  assert.equal(attr.version, ver0 + 1, 'unchanged: no upload');
  assert.equal(v.outlinePos, attr);
  assert.equal(attr.array, arr);
});

test('construction adopts the enemies and the weapons world root; a pause hides them, the countdown shows them', () => {
  const S = setup();
  const { game, roots, weapons } = S;
  assert.equal(roots[0].parent, game.view.veil);
  assert.equal(weapons.worldRoot.parent, game.view.veil);
  playing(S);
  game.pauseNow('wrist');
  S.step();
  assert.deepEqual(S.seen.at(-1), { paused: true, reason: 'manual' });
  assert.equal(game.view.veil.visible, false, 'enemies and effects hidden');
  assert.equal(game.freezeEnemies, true);
  assert.equal(game.tint.visible, false);
  // the buzz on both hands at the start of a pause
  assert.ok(S.input.left.pulses.some(([v, ms]) => v === 0.5 && ms === 60));
  for (let i = 0; i < 72 * 2 && game.rules.pm.state !== RESUME.READY; i++) S.step();
  assert.deepEqual(game.panel.lines, ['Pull the trigger to resume', 'You paused the game']);
  S.pull();
  assert.equal(game.view.veil.visible, true, 'the countdown shows them, frozen');
  assert.equal(game.freezeEnemies, true);
  assert.equal(game.paused, true);
  S.secs(RULES.countdownS + 0.1);
  assert.equal(game.paused, false);
  assert.equal(game.freezeEnemies, false);
  assert.equal(game.view.veil.visible, true);
  game.stop();
  assert.equal(game.view.veil.visible, true);
});

test('pickSpot on the house: blocked at the start → arrow and "Step …" → walk there → tight → hold the trigger → onConfirm(zone)', () => {
  const S = setup();
  const { game, input } = S;
  S.step(2);
  /** @type {any[]} */ const zones = [];
  game.pickSpot((z) => zones.push({ ...z }));
  S.secs(0.3);
  assert.equal(game.phaseName, 'spot');
  assert.equal(game.spotStatus, 'blocked');
  assert.equal(game.ring.visible, true);
  assert.equal(game.ring.material.color.getHex(), 0xff3b30, 'red ring under the player');
  assert.equal(game.view.arrow.visible, true, 'a floor arrow');
  const lines = game.panel.lines;
  assert.match(lines[0], /^Step (forward|back|left|right)/);
  assert.equal(lines[1], 'Too close to a wall or furniture');
  // the trigger does nothing here
  S.pull();
  input.right.triggerHeld = true;
  S.secs(1.2);
  input.right.triggerHeld = false;
  assert.equal(zones.length, 0);
  // follow the arrow
  const sp = game.spot;
  let guard = 0;
  // until the spot is usable and no roomier one is suggested
  while ((game.spotStatus !== 'tight' && game.spotStatus !== 'clear') || sp.hasStep) {
    assert.ok(guard++ < 600, 'arrived');
    const p = S.player.head;
    const dx = sp.stepX - p.x, dz = sp.stepZ - p.z, l = Math.hypot(dx, dz);
    if (sp.hasStep && l > 0.01) {
      const e = S.player.eye;
      S.head(e.x + (dx / l) * 0.5 * DT, 1.7, e.z + (dz / l) * 0.5 * DT);
    }
    S.step();
  }
  assert.equal(game.spotStatus, 'tight', 'the couch / table within reach everywhere in this room');
  assert.equal(game.ring.material.color.getHex(), 0xffb02e, 'amber');
  S.secs(0.6);
  assert.deepEqual(game.panel.lines, ['Something is within arm’s reach', 'Hold the trigger to play here anyway']);
  input.right.triggerHeld = true;
  S.secs(1.1);
  input.right.triggerHeld = false;
  assert.equal(zones.length, 1);
  const z = zones[0];
  assert.ok(Math.abs(z.x - S.player.head.x) < 1e-9 && Math.abs(z.z - S.player.head.z) < 1e-9, 'where the player stands');
  assert.equal(z.r, 0.8);
  assert.equal(game.spotting, false);
  // the integrator rebuilds the world around the zone if it moved, then starts
  game.start(game._spotZone);
  assert.equal(game.phase, PHASE.READY);
  assert.equal(game.spotReport.status, 'tight');
  assert.equal(game.spotReport.chosen, true);
  assert.equal(game.view.arrow.visible, false);
});

test('pickSpot without a callback starts the round; holding Y exits during the choice', () => {
  const S = setup();
  S.step(2);
  S.game.pickSpot();
  S.head(0.3, 1.7, -0.385);
  S.secs(0.3);
  S.input.right.triggerHeld = true;
  S.secs(1.1);
  S.input.right.triggerHeld = false;
  S.step();
  assert.equal(S.game.phase, PHASE.READY);
  const B = setup();
  const reasons = [];
  B.game.onExit = (r) => reasons.push(r);
  B.step(2);
  B.game.pickSpot();
  B.input.left.b = true;
  B.secs(1);
  assert.deepEqual(B.game.panel.lines, ['Exiting…', 'Keep holding Y']);
  B.secs(1.1);
  assert.deepEqual(reasons, ['holdY']);
});

test('obstacle warnings in play: a hand near the wall pulses 0.3 / 30 ms, outlines it, freezes enemies, holds spawns', () => {
  const S = setup();
  const { game, input } = S;
  playing(S);
  const spawned = game.rules.spawned;
  // the right hand 0.2 m from the south wall face (z = 1), still inside r + 0.7 of the zone
  input.right.grip[12] = 0.3; input.right.grip[13] = 1.2; input.right.grip[14] = 0.8;
  S.step();
  assert.deepEqual(input.right.pulses.at(-1), [0.3, 30]);
  assert.equal(game.view.outline.visible, true);
  assert.equal(game.freezeEnemies, true);
  assert.equal(game.paused, false, 'a freeze, not a pause');
  S.secs(5);
  assert.equal(game.rules.spawned, spawned, 'no new enemies while frozen');
  assert.ok(input.right.pulses.filter(([v]) => v === 0.3).length >= 8, 'repeats while near');
  input.right.grip[14] = 0.3;
  S.step();
  assert.equal(game.freezeEnemies, false);
  assert.equal(game.view.outline.visible, false);
  S.secs(4);
  assert.ok(game.rules.spawned > spawned, 'spawning resumes');
  assert.ok(game.stats.obstacleWarnings >= 1);
});

test('zone: tick at 0.8 r, edge highlight + freeze at 0.9 r, pause beyond r with the return arrow and no panel while walking', () => {
  const S = setup();
  const { game, audio } = S;
  playing(S);
  const walkTo = (x, z, v = 0.5) => {
    for (let i = 0; i < 400; i++) {
      const e = S.player.eye;
      const dx = x - e.x, dz = z - e.z, l = Math.hypot(dx, dz);
      if (l < v * DT) break;
      S.head(e.x + (dx / l) * v * DT, 1.7, e.z + (dz / l) * v * DT);
      S.step();
    }
  };
  // eyes 8.5 cm ahead of the head centre (facing −z): head z = eye z + 0.085; zone centre (0.3, −0.3)
  walkTo(0.3 + 0.67, -0.385);
  assert.ok(audio.ui.includes('dryReset'), 'the soft tick');
  assert.equal(game.freezeEnemies, false);
  walkTo(0.3 + 0.75, -0.385);
  assert.equal(game.freezeEnemies, true, 'beyond 0.9 r');
  assert.equal(game.ring.material.color.getHex(), 0xff3b30);
  assert.equal(game.view.arrow.visible, true, 'the arrow back starts at the edge');
  assert.equal(game.paused, false);
  walkTo(0.3 + 0.95, -0.385);
  assert.equal(game.paused, true);
  assert.deepEqual(S.seen.at(-1), { paused: true, reason: 'zone' });
  assert.equal(game.panel.mesh.visible, false, 'no head-locked panel while walking');
  // the arrow points back to the spot
  game.view.arrow.updateMatrixWorld();
  const tail = new THREE.Vector3(0, 0, 0).applyMatrix4(game.view.arrow.matrixWorld);
  const tip = new THREE.Vector3(0, 0, 1).applyMatrix4(game.view.arrow.matrixWorld);
  assert.ok(tip.x < tail.x, 'toward the centre (−x)');
  S.secs(0.8); // standing still: the panel shows
  assert.equal(game.panel.mesh.visible, true);
  assert.deepEqual(game.panel.lines, ['Return to your spot', 'Paused: step back inside the ring']);
  walkTo(0.3, -0.385);
  S.secs(0.6);
  assert.deepEqual(game.panel.lines, ['Pull the trigger to resume', 'You left your spot']);
  assert.equal(game.view.arrow.visible, false);
  resume(S);
});

test('B+Y pauses; a controller removed pauses; hands only (no controller) pauses; tracking lost pauses', () => {
  const a = setup();
  playing(a);
  a.input.left.b = true; a.input.right.b = true;
  a.step();
  assert.deepEqual(a.seen.at(-1), { paused: true, reason: 'manual' });
  a.input.left.b = false; a.input.right.b = false;
  resume(a);

  const b = setup();
  playing(b);
  b.input.right.present = false;
  b.step();
  assert.deepEqual(b.seen.at(-1), { paused: true, reason: 'input' });
  b.input.left.present = false;
  b.secs(0.5);
  assert.deepEqual(b.game.panel.lines, ['Controllers not found', 'Pick up both controllers']);
  b.input.left.present = b.input.right.present = true;
  resume(b);

  const c = setup();
  playing(c);
  c.ctx.space = /** @type {any} */ ({});
  let pose = { emulatedPosition: false };
  c.setFrame({ getViewerPose: () => pose });
  c.step(5);
  assert.equal(c.game.paused, false);
  pose = { emulatedPosition: true };
  c.step();
  assert.deepEqual(c.seen.at(-1), { paused: true, reason: 'tracking' });
  c.secs(0.5);
  assert.deepEqual(c.game.panel.lines, ['Tracking lost', 'Stand still and look around slowly']);
  pose = null;
  c.secs(1);
  assert.equal(c.game.rules.pm.state, RESUME.BLOCKED);
  pose = { emulatedPosition: false };
  resume(c);
});

test('no running: fast steps on the spot pause; a hitch over 250 ms pauses; enemy shots while paused are violations', () => {
  const S = setup();
  playing(S);
  for (let i = 0; i < 72; i++) {
    const x = 0.3 + 0.25 * Math.sin(i * DT * 7); // ±0.25 m at up to 1.75 m/s
    S.head(x, 1.7, -0.385);
    S.step();
    if (S.game.paused) break;
  }
  assert.deepEqual(S.seen.at(-1), { paused: true, reason: 'running' });
  S.head(0.3, 1.7, -0.385);
  for (let i = 0; i < 72 * 2 && S.game.rules.pm.state !== RESUME.READY; i++) S.step();
  assert.deepEqual(S.game.panel.lines, ['Pull the trigger to resume', 'No running: stay on your spot']);
  S.events.emit('enemyShot', { enemy: 0, x: 0, y: 1, z: 0 });
  assert.equal(S.game.rules.pm.violationCounts[VIOLATION.SHOT], 1);
  S.pull();
  S.secs(RULES.countdownS + 0.1);
  assert.equal(S.game.paused, false);
  // a 300 ms hitch
  const t0 = S.seen.length;
  S.game.update(DT, 1e9, null, S.ctx); // far-future timestamp: a gap
  assert.equal(S.seen.length, t0 + 1);
  assert.equal(S.seen.at(-1).reason, 'gap');
  const rep = S.game.safetyReport();
  assert.deepEqual(rep.pauses, { gap: 1, running: 1 });
  assert.deepEqual(rep.violations, { enemyShotWhilePaused: 1 });
  assert.equal(rep.log.length, 1);
  assert.equal(rep.spot.status, 'tight');
  assert.equal(rep.veil.adopted, 4);
});

test('reference-space reset: pauses; with hold it waits for realigned(); preUpdate + update run the rules once per frame', () => {
  const S = setup();
  const { game } = S;
  playing(S);
  game.onReferenceReset({ hold: true });
  assert.deepEqual(S.seen.at(-1), { paused: true, reason: 'reset' });
  S.secs(3);
  assert.deepEqual(game.panel.lines, ['View recentred', 'Re-reading your room…']);
  assert.equal(game.rules.pm.state, RESUME.BLOCKED);
  game.realigned({ x: 0.3, z: -0.3 });
  S.secs(0.6);
  assert.deepEqual(game.panel.lines, ['Pull the trigger to resume', 'The view was recentred']);
  S.pull();
  S.secs(RULES.countdownS + 0.1);
  assert.equal(game.paused, false);
  // preUpdate early in the frame, update later with the same t: the rules step once
  let calls = 0;
  const orig = game.rules.update.bind(game.rules);
  game.rules.update = (...a) => { calls++; return orig(...a); };
  const t = 5e8;
  game.lastT = -1;
  game.preUpdate(DT, t, null, S.ctx);
  game.update(DT, t, null, S.ctx);
  assert.equal(calls, 1);
  game.rules.update = orig;
});

test('per-frame game + safety paths allocate nothing with a real world, obstacles near and pauses (sampling heap profiler)', async () => {
  const S = setup();
  const { game, input } = S;
  playing(S);
  REC.on = false;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      const k = i % 1200;
      // hand sweeps toward the wall and back; head walks out of the zone and back; a manual pause
      input.right.grip[12] = 0.3; input.right.grip[13] = 1.2; input.right.grip[14] = 0.5 + 0.35 * Math.sin(i * 0.02);
      if (k === 100) S.head(1.3, 1.7, -0.385);
      if (k === 300) S.head(0.3, 1.7, -0.385);
      if (k === 400 || k === 900) { input.right.triggerDown = true; }
      if (k === 401 || k === 901) { input.right.triggerDown = false; }
      if (k === 700) { input.left.b = true; input.right.b = true; }
      if (k === 705) { input.left.b = false; input.right.b = false; }
      S.step();
      if (game.health < 50) game.rules.health = 100;
    }
  };
  // warm every path (33 pause / resume / obstacle cycles): until the rare branches have stable
  // type feedback, a deopted frame runs in the interpreter, which boxes doubles
  loop(40000);
  assert.ok(game.stats.pauses > 3 && game.stats.obstacleWarnings > 3);
  let best = Infinity, by = null;
  for (let r = 0; r < 5 && best > 0; r++) {
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(12000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const files = ['/src/game/GameSession.js', '/src/game/Rules.js', '/src/game/Player.js', '/src/game/head.js',
      '/src/safety/PauseManager.js', '/src/safety/ObstacleWarnings.js', '/src/safety/SafeSpot.js', '/src/safety/SafetyView.js', '/src/safety/geom.js'];
    // rarely run event paths (a pause starting or ending) may be charged interpreter bytes; per-frame ones never
    const rare = new Set(['startPause', 'finishResume', 'restartProtocol', 'startCount', 'reset', 'trigger', 'pauseNow', '_pause', 'interrupt']);
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && files.some((f) => u.endsWith(f)) && !rare.has(n.callFrame.functionName)) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  REC.on = true;
  assert.equal(best, 0, JSON.stringify(by));
});
