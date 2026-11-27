/**
 * GameSession.js and WristHud.js with the real three r187 (resolve hook, as in
 * world.three.test.js), the real Player, Events and SurvivalRules, and fakes
 * for the world, the enemy manager, input, audio, the XR session and the
 * canvas (CanvasPanel draws on a 2D context).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Session } from 'node:inspector/promises';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));

// ── fake canvas ───────────────────────────────────────────────────────────────
const REC = { on: true };
function fake2d() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    texts: [],
    fillRect() {}, strokeRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    fillText(s) { if (REC.on) this.texts.push(s); },
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
const { WristHud } = await import('../../src/ui/WristHud.js');
const { Events } = await import('../../src/core/Events.js');
const { PHASE, RULES } = await import('../../src/game/Rules.js');
const { resetUploadGate } = await import('../../src/game/UploadGate.js');

const DT = 1 / 72;

function hand() {
  const pulses = [];
  return {
    pulses,
    present: true, hasGrip: true, grip: new THREE.Matrix4().toArray(new Float32Array(16)),
    a: false, aDown: false, b: false, triggerDown: false, triggerHeld: false,
    source: { gamepad: { hapticActuators: [{ pulse: (v, ms) => { if (REC.on) pulses.push([v, ms]); } }] } },
  };
}

function setup({ spawnOk = true } = {}) {
  resetUploadGate();
  const scene = new THREE.Scene();
  const L = new THREE.PerspectiveCamera(), R = new THREE.PerspectiveCamera();
  const camera = new THREE.ArrayCamera([L, R]);
  const head = (x, y, z, pitch = 0, yaw = 0) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    L.position.set(x - 0.032, y, z); R.position.set(x + 0.032, y, z);
    L.quaternion.copy(q); R.quaternion.copy(q);
    camera.position.copy(L.position); camera.quaternion.copy(q);
  };
  head(0, 1.7, 0);
  const world = {
    built: true, ok: spawnOk, finds: 0,
    findSpawn(fx, fz, vx, vz, min, out) { this.finds++; if (!this.ok) return false; out.x = fx - 4; out.z = fz + 1; return true; },
    floorY: () => 0, segmentClear: () => true,
  };
  const enemies = {
    n: 0, resets: 0, spawns: [],
    spawn(x, z, f) { this.spawns.push([x, z, f]); return this.n++; },
    alive() { return this.n; }, reset() { this.n = 0; this.resets++; },
  };
  const weapons = { resets: 0, a: { weapon: 'glock', mag: 17, chambered: true }, ammo() { return this.a; }, reset() { this.resets++; } };
  const audio = { plays: [], play(k) { if (REC.on) this.plays.push(k); return 1; } };
  const events = new Events();
  const input = { left: hand(), right: hand() };
  const session = { visibilityState: 'visible', ended: 0, end() { this.ended++; return Promise.resolve(); } };
  const player = new Player();
  const ctx = { scene, camera, session, input, events, audio, world, player };
  const game = new GameSession(ctx, { enemies, weapons });
  const hud = new WristHud(ctx, { game, weapons });
  const seen = [];
  for (const type of ['waveStart', 'waveClear', 'roundOver', 'pause']) events.on(type, (p) => { if (REC.on) seen.push([type, { ...p }]); });
  let t = 0;
  const step = (n = 1, gapMs = 0) => {
    for (let i = 0; i < n; i++) {
      t += DT * 1000 + gapMs;
      player.update(DT, t, null, ctx);
      game.update(DT, t, null, ctx);
      hud.update(DT, t, null, ctx);
    }
  };
  const secs = (s) => step(Math.round(s / DT));
  /** One trigger pull (the Resume press). */
  const pull = () => { input.right.triggerDown = true; step(); input.right.triggerDown = false; };
  return { ctx, game, hud, world, enemies, weapons, audio, events, input, session, player, seen, head, step, secs, scene, pull };
}

test('construction: ring, one tint quad and the message panel exist from the start; transparent from creation', () => {
  const { game, scene, hud } = setup();
  const names = scene.children.map((o) => o.name);
  for (const n of ['game-zone-ring', 'game-damage-tint', 'game-message', 'wrist-hud', 'safety-outline', 'safety-arrow', 'safety-veil']) assert.ok(names.includes(n), n);
  assert.equal(game.ring.material.transparent, true);
  assert.equal(game.tint.material.transparent, true);
  assert.equal(game.tint.material.opacity, 0);
  assert.equal(game.tint.material.depthTest, false);
  assert.equal(game.warmMeshes().length, 5, 'ring, tint, panel + the safety outline and floor arrow');
  assert.equal(hud.warmMeshes().length, 1);
  game.setWarm(true);
  assert.ok(game.warmMeshes().every((m) => m.visible));
  game.setWarm(false);
  assert.ok(game.warmMeshes().every((m) => !m.visible));
  assert.equal(game.textures().length, 2);
  assert.equal(game.tintTex.generateMipmaps, false);
});

test('a round: get ready, waves from findSpawn facing the player, kills clear the wave, events per contract', () => {
  const S = setup();
  const { game, enemies, events, seen, player } = S;
  S.step(2);
  game.start();
  assert.ok(Math.abs(player.zone.x) < 1e-9 && Math.abs(player.zone.z - 0.085) < 1e-9, 'zone where the head is');
  S.step(2);
  assert.equal(game.phaseName, 'ready');
  assert.equal(game.panel.mesh.visible, true);
  assert.deepEqual(game.panel.lines, ['Get ready', 'Stay inside the ring on the floor']);
  assert.equal(game.ring.visible, true, 'the ring shows during get ready');
  S.secs(RULES.readyS + 0.1);
  assert.deepEqual(seen[0], ['waveStart', { wave: 1, enemies: 3 }]);
  assert.deepEqual(game.panel.lines, ['Wave 1']);
  S.secs(12);
  assert.equal(enemies.spawns.length, 3);
  const [x, z, f] = enemies.spawns[0];
  // facing: yaw about +Y with 0 = +Z, pointing at the player
  assert.ok(Math.abs(Math.sin(f) - (player.head.x - x) / Math.hypot(player.head.x - x, player.head.z - z)) < 1e-6);
  for (let i = 0; i < 3; i++) { enemies.n--; events.emit('enemyKilled', { enemy: i, headshot: i === 0 }); }
  S.step(2);
  assert.deepEqual(seen[1], ['waveClear', { wave: 1 }]);
  assert.equal(game.kills, 3);
  assert.equal(game.rules.headshots, 1);
  assert.deepEqual(game.panel.lines, ['Wave 1 cleared', '+25 health']);
  S.secs(RULES.breakS + 0.1);
  assert.deepEqual(seen[2], ['waveStart', { wave: 2, enemies: 4 }]);
});

test('player hits: health and player sync, tint ≤ 0.3 for ≤ 0.3 s, a hit sound and haptics on both hands', () => {
  const S = setup();
  const { game, events, player, audio, input } = S;
  S.step(2);
  game.start();
  S.secs(RULES.readyS + 0.5);
  events.emit('playerHit', { damage: 25, fromX: -4, fromY: 1.5, fromZ: 0 });
  assert.equal(game.health, 75);
  assert.equal(player.health, 75);
  assert.ok(audio.plays.includes('impactFlesh'));
  assert.equal(input.left.pulses.length, 1);
  assert.equal(input.right.pulses.length, 1);
  let maxOp = 0, visibleS = 0;
  for (let i = 0; i < 72; i++) {
    S.step();
    const op = game.tint.material.opacity;
    if (game.tint.visible) { visibleS += DT; maxOp = Math.max(maxOp, op); }
  }
  assert.ok(maxOp > 0.1 && maxOp <= 0.3, `peak ${maxOp}`);
  assert.ok(visibleS <= 0.3 + 1e-9, `visible ${visibleS} s`);
  assert.equal(game.tint.visible, false);
  // the quad sits 15 cm ahead of the eyes, facing them
  events.emit('playerHit', { damage: 50, fromX: 0, fromY: 1.6, fromZ: -5 });
  S.step();
  const d = game.tint.position.distanceTo(player.eye);
  assert.ok(Math.abs(d - 0.15) < 1e-6, `tint at ${d} m`);
  assert.ok(game.tint.material.opacity <= 0.3);
  assert.equal(game.tint.material.transparent, true);
});

test('death: roundOver with wave and kills, card "Round over — Y to restart"; a Y tap restarts everything', () => {
  const S = setup();
  const { game, events, seen, input, enemies, weapons, player } = S;
  S.step(2);
  game.start();
  S.secs(RULES.readyS + 3);
  events.emit('enemyKilled', { enemy: 0, headshot: false });
  enemies.n--;
  events.emit('playerHit', { damage: 60, fromX: 1, fromY: 1, fromZ: 1 });
  events.emit('playerHit', { damage: 60, fromX: 1, fromY: 1, fromZ: 1 });
  assert.equal(player.alive, false);
  assert.equal(game.phase, PHASE.OVER);
  assert.deepEqual(seen.at(-1), ['roundOver', { wave: 1, kills: 1 }]);
  S.step();
  assert.deepEqual(game.panel.lines, ['Round over — Y to restart', 'Wave 1 · 1 kill']);
  S.secs(1);
  assert.equal(game.phase, PHASE.OVER, 'stays');
  input.left.b = true;
  S.secs(0.2);
  input.left.b = false;
  S.step();
  assert.equal(game.phase, PHASE.READY);
  assert.equal(player.alive, true);
  assert.equal(player.health, 100);
  assert.equal(enemies.resets, 2);
  assert.equal(weapons.resets, 2);
});

test('safe zone: leaving pauses ("Return to your spot", red ring), back in → 0.5 s → trigger → 3-2-1 → resume', () => {
  const S = setup();
  const { game, seen, head } = S;
  S.step(2);
  game.start();
  S.secs(RULES.readyS + 2);
  head(0.95, 1.7, 0);
  S.step(2);
  assert.equal(game.paused, true);
  assert.deepEqual(seen.at(-1), ['pause', { paused: true, reason: 'zone' }]);
  assert.deepEqual(game.panel.lines, ['Return to your spot', 'Paused: step back inside the ring']);
  assert.equal(game.ring.material.color.getHex(), 0xff3b30);
  assert.ok(game.ring.visible);
  head(0, 1.7, 0);
  S.secs(0.6);
  assert.deepEqual(game.panel.lines, ['Pull the trigger to resume', 'You left your spot']);
  S.secs(1);
  assert.equal(game.paused, true, 'no resume without the trigger (PLAN §6.2)');
  S.pull();
  assert.deepEqual(game.panel.lines, ['3']);
  S.secs(1.0);
  assert.deepEqual(game.panel.lines, ['2']);
  S.secs(2.1);
  assert.equal(game.paused, false);
  assert.deepEqual(seen.at(-1), ['pause', { paused: false, reason: '' }]);
});

test('visibility blur and a frame gap both pause; Lifecycle visibility works too', () => {
  const S = setup();
  const { game, seen, session } = S;
  S.step(2);
  game.start();
  S.secs(1);
  session.visibilityState = 'visible-blurred';
  S.step();
  assert.equal(game.paused, true);
  assert.deepEqual(seen.at(-1), ['pause', { paused: true, reason: 'hidden' }]);
  assert.deepEqual(game.panel.lines, ['Paused']);
  session.visibilityState = 'visible';
  S.secs(0.6);
  S.pull();
  S.secs(3.1);
  assert.equal(game.paused, false);
  S.step(1, 2000); // no frames for 2 s (headset off)
  assert.equal(game.paused, true);
  assert.deepEqual(seen.at(-1), ['pause', { paused: true, reason: 'gap' }]);
  S.secs(0.6);
  S.pull();
  S.secs(3.1);
  assert.equal(game.paused, false);
  game.setVisibility('hidden');
  S.step();
  assert.equal(game.paused, true);
  game.setVisibility('visible');
  S.secs(0.6);
  S.pull();
  S.secs(3.1);
  assert.equal(game.paused, false);
});

test('exit: holding Y 2 s calls onExit once (default: ends the session from a timeout, not inside the frame)', async () => {
  const S = setup();
  const { game, input, session } = S;
  S.step(2);
  game.start();
  input.left.b = true;
  S.secs(1);
  assert.deepEqual(game.panel.lines, ['Exiting…', 'Keep holding Y']);
  S.secs(1.1);
  assert.equal(game.exitReason, 'holdY');
  assert.equal(session.ended, 0, 'not inside the frame callback');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(session.ended, 1);
  S.secs(3);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(session.ended, 1, 'once');
  const B = setup();
  const reasons = [];
  B.game.onExit = (r) => reasons.push(r);
  B.game.start();
  B.game.requestExit('wrist');
  B.game.requestExit('wrist');
  assert.deepEqual(reasons, ['wrist']);
});

test('panels: at most one texture upload per frame across the message panel and the wrist HUD', () => {
  const S = setup();
  const { game, hud, events } = S;
  S.step(2);
  game.start();
  const tex = [game.panel.texture, hud.panel.texture];
  let last = tex.map((x) => x.version);
  let maxPerFrame = 0, total = 0;
  for (let i = 0; i < 72 * 20; i++) {
    if (i % 50 === 0) events.emit('playerHit', { damage: 1, fromX: 0, fromY: 1, fromZ: -3 });
    S.step();
    const v = tex.map((x) => x.version);
    const n = (v[0] - last[0]) + (v[1] - last[1]);
    maxPerFrame = Math.max(maxPerFrame, n);
    total += n;
    last = v;
  }
  assert.equal(maxPerFrame, 1);
  assert.ok(total > 3, 'they did redraw');
  // the HUD redraws at most twice per second
  assert.ok(hud.draws <= 2 * 20 + 2, `${hud.draws} HUD draws in 20 s`);
});

test('wrist HUD: on the left grip, shows wave / health / kills / ammo; look + X tap toggles ammo, hold X 1 s exits', () => {
  const S = setup();
  const { game, hud, input, head, weapons } = S;
  const reasons = [];
  game.onExit = (r) => reasons.push(r);
  S.step(2);
  game.start();
  S.secs(1);
  assert.equal(hud.panel.mesh.visible, true);
  // grip at (0.1, 1.2, −0.3): the panel sits at the grip-space offset
  const g = new THREE.Matrix4().makeTranslation(0.1, 1.2, -0.3);
  input.left.grip.set(g.elements);
  S.step();
  S.scene.updateMatrixWorld(); // as render() does
  const p = new THREE.Vector3().setFromMatrixPosition(hud.panel.mesh.matrixWorld);
  assert.ok(Math.abs(p.x - (0.1 - 0.045)) < 1e-6 && Math.abs(p.y - (1.2 + 0.085)) < 1e-6, p.toArray().join());
  // the face points out of the back of the left hand (−X in grip space)
  const n = new THREE.Vector3().setFromMatrixColumn(hud.panel.mesh.matrixWorld, 2);
  assert.ok(Math.abs(n.x + 1) < 1e-6);
  S.secs(0.6);
  const texts = hud.panel.ctx.texts;
  assert.ok(texts.includes('G17') && texts.includes('17') && texts.includes('+1'), texts.slice(-12).join('|'));
  assert.ok(texts.includes('100'));
  // look at it: eyes at −X of the panel, gaze toward it
  head(p.x - 0.35, p.y, p.z, 0, -Math.PI / 2);
  S.step(2);
  assert.equal(hud.looking, true);
  input.left.a = true; input.left.aDown = true;
  S.step(); input.left.aDown = false;
  S.secs(0.1);
  input.left.a = false;
  S.step();
  assert.equal(hud.showAmmo, false);
  input.left.a = true; input.left.aDown = true;
  S.step(); input.left.aDown = false;
  S.secs(1.05);
  assert.deepEqual(reasons, ['wrist']);
  input.left.a = false;
  // not looking: X does nothing
  head(0, 1.7, 0);
  S.step(2);
  assert.equal(hud.looking, false);
  input.left.a = true; input.left.aDown = true;
  S.step(); input.left.aDown = false;
  input.left.a = false;
  S.step();
  assert.equal(hud.showAmmo, false);
  // no grip pose: hidden
  input.left.hasGrip = false;
  S.step();
  assert.equal(hud.panel.mesh.visible, false);
  weapons.a.mag = -1;
});

test('materials never change program-key state during play', () => {
  const S = setup();
  const { game, events, head } = S;
  const mats = [game.ring.material, game.tint.material, game.panel.mesh.material, game.view.outline.material, game.view.arrow.material];
  const before = mats.map((m) => [m.version, m.transparent, m.alphaTest, m.depthTest]);
  S.step(2);
  game.start();
  for (let i = 0; i < 72 * 30; i++) {
    if (i % 90 === 0) events.emit('playerHit', { damage: 5, fromX: 0, fromY: 1, fromZ: -3 });
    if (i === 900) head(1.2, 1.7, 0);
    if (i === 1000) head(0, 1.7, 0);
    S.step();
  }
  assert.deepEqual(mats.map((m) => [m.version, m.transparent, m.alphaTest, m.depthTest]), before);
  assert.deepEqual([game.ring.material, game.tint.material, game.panel.mesh.material, game.view.outline.material, game.view.arrow.material], mats, 'same material objects');
});

test('per-frame game + HUD + player paths allocate nothing (sampling heap profiler)', async () => {
  const S = setup();
  const { game, events, enemies } = S;
  S.step(2);
  game.start();
  S.secs(RULES.readyS + 12); // wave 1 fully spawned: a steady fight
  REC.on = false;
  const hit = { damage: 0.01, fromX: 0, fromY: 1, fromZ: -3 };
  let cycle = 0;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      if (i % 200 === 0) events.emit('playerHit', hit); // tint fades, HUD redraws, ring
      if (i % 3000 === 0) { S.head(0.9, 1.7, 0); cycle++; } // zone pause …
      if (i % 3000 === 300) S.head(0, 1.7, 0); // … and resume
      if (i % 3000 === 400) { S.input.right.triggerDown = true; S.step(); S.input.right.triggerDown = false; } // the Resume press
      S.step();
      if (game.health < 50) { game.rules.health = 100; }
    }
  };
  // long enough for TurboFan to finish optimising preUpdate even while the other test files run in parallel
  // (until then its frames run in the interpreter, which boxes doubles)
  loop(60000);
  assert.equal(game.phase, PHASE.WAVE);
  assert.ok(enemies.n > 0 && cycle > 0);
  let best = Infinity, by = null;
  for (let r = 0; r < 5 && best > 0; r++) {
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(30000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const files = ['/src/game/GameSession.js', '/src/ui/WristHud.js', '/src/game/Rules.js', '/src/game/Player.js', '/src/game/head.js', '/src/game/UploadGate.js',
      '/src/safety/PauseManager.js', '/src/safety/ObstacleWarnings.js', '/src/safety/SafeSpot.js', '/src/safety/SafetyView.js', '/src/safety/geom.js'];
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && files.some((f) => u.endsWith(f))) b[n.callFrame.functionName] = (b[n.callFrame.functionName] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  REC.on = true;
  assert.equal(best, 0, JSON.stringify(by));
});
