/**
 * src/ui/Watch.js with the real three r187 (resolve hook, as in
 * game.session.test.js) and a fake 2D canvas: pose on the left wrist, wake,
 * tap / ray to open the menu, menu rows and actions, two-tap confirm, gun-fit
 * page, warnings (haptics + dial icon), redraw limits, warm-up set, fixed
 * program keys and an allocation-free frame.
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
const GRAD = { addColorStop() {} };
function fake2d() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', lineCap: '', lineJoin: '',
    letterSpacing: '0px',
    texts: [],
    fillRect() {}, strokeRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {}, quadraticCurveTo() {}, fill() {}, stroke() {},
    createLinearGradient() { return GRAD; }, createRadialGradient() { return GRAD; },
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
const { Watch, installWatchSounds } = await import('../../src/ui/Watch.js');
const { WATCH, ROW, PAGE, rowRect, MENU_PX, WARN } = await import('../../src/ui/watchLogic.js');
const { RC } = await import('../../src/ui/watchArt.js');
const { resetUploadGate, claimUpload } = await import('../../src/game/UploadGate.js');

const DT = 1 / 72;

function hand() {
  const pulses = [];
  return {
    pulses,
    present: true, hasGrip: true, grip: new Float32Array(16), hasRay: true, ray: new Float32Array(16),
    trigger: 0, triggerDown: false, sy: 0, sx: 0, a: false, b: false,
    source: { gamepad: { hapticActuators: [{ pulse: (v, ms) => { if (REC.on) pulses.push([v, ms]); } }] } },
  };
}

/**
 * The watch-check pose: left forearm across the chest pointing right (+X),
 * palm down (thumb toward the body, +Z). The grip sits at `gp`; IWER's
 * grip-in-ray relation gives the grip rotation.
 */
function checkPose(L, gp = new THREE.Vector3(-0.1, 1.25, -0.3)) {
  const Z = new THREE.Vector3(-1, 0, 0); // ray +Z = −pointing
  const Y = new THREE.Vector3(0, 0, 1);  // thumb side
  const X = new THREE.Vector3().crossVectors(Y, Z);
  const ray = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(gp);
  ray.toArray(L.ray);
  const G = new THREE.Matrix4().fromArray([0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1]);
  new THREE.Matrix4().multiplyMatrices(ray, G).setPosition(gp).toArray(L.grip);
}

/**
 * Right controller pointing straight along −n (into a disc) with the tip at
 * `h` metres in front of point p.
 */
function tipAt(R, p, n, h) {
  const Zc = n.clone().normalize(); // ray +Z = −direction; direction = −n
  const up = Math.abs(Zc.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const Xc = new THREE.Vector3().crossVectors(up, Zc).normalize();
  const Yc = new THREE.Vector3().crossVectors(Zc, Xc);
  const origin = p.clone().addScaledVector(Zc, h + WATCH.tap.tip);
  new THREE.Matrix4().makeBasis(Xc, Yc, Zc).setPosition(origin).toArray(R.ray);
  R.grip.set(R.ray);
}

/** Right ray from `from` aimed at `to`. */
function aim(R, from, to) {
  const d = new THREE.Vector3().subVectors(to, from).normalize();
  const Zc = d.clone().negate();
  const up = Math.abs(Zc.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const Xc = new THREE.Vector3().crossVectors(up, Zc).normalize();
  const Yc = new THREE.Vector3().crossVectors(Zc, Xc);
  new THREE.Matrix4().makeBasis(Xc, Yc, Zc).setPosition(from).toArray(R.ray);
}

function setup(opts = {}) {
  resetUploadGate();
  const scene = new THREE.Scene();
  const L = hand(), R = hand();
  checkPose(L);
  // right hand down at the side, pointing forward, far from everything
  new THREE.Matrix4().makeTranslation(0.3, 0.9, -0.2).toArray(R.ray);
  R.grip.set(R.ray);
  const player = { valid: true, eye: new THREE.Vector3(-0.1, 1.6, 0.0), head: new THREE.Vector3(-0.1, 1.6, 0.0), forward: new THREE.Vector3(0, 0, -1) };
  const ui = [];
  const audio = { ui, playUI(k, g, r) { if (REC.on) ui.push([k, g, r]); return 1; } };
  const weapons = { held: null, a: { weapon: 'glock', mag: 17, chambered: true, mode: 'semi' }, ammo() { return this.a; } };
  const game = { health: 100, wave: 1, kills: 0, paused: false, phaseName: 'wave' };
  const actions = [];
  const ctx = { scene, input: { left: L, right: R }, player };
  const watch = new Watch(ctx, { game, weapons, audio, onAction: (n, v) => { if (REC.on) actions.push([n, v && typeof v === 'object' ? { ...v } : v]); }, ...opts });
  let t = 0;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { t += DT * 1000; watch.update(DT, t, null, ctx); } };
  /** look straight at the watch */
  const look = () => { player.forward.subVectors(watch.o, player.eye).normalize(); };
  return { scene, L, R, player, audio, weapons, game, actions, ctx, watch, step, look, get t() { return t; } };
}

/** Wake the watch: one frame for the pose, then look at it for 0.2 s. */
function wake(S) { S.step(); S.look(); S.step(15); assert.equal(S.watch.wake.awake, true, 'awake'); }

/** Tap the dial with the right tip: from 6 cm above to 1 cm above. */
function tapDial(S) {
  const w = S.watch;
  tipAt(S.R, w.o, w.az, 0.06); S.step();
  tipAt(S.R, w.o, w.az, 0.01); S.step();
}

/** World point of a menu row (index on the page, zone −1/0/+1), and the disc normal. */
function rowPoint(S, index, zone = 0) {
  const w = S.watch, r = rowRect(index, { x0: 0, x1: 0, y0: 0, y1: 0 });
  const px = zone < 0 ? r.x0 + 12 : zone > 0 ? r.x1 - 12 : (r.x0 + r.x1) / 2, py = (r.y0 + r.y1) / 2;
  const s = (2 * WATCH.menu.r) / MENU_PX.size;
  const m = w.menuRoot.matrix;
  const p = new THREE.Vector3((px - MENU_PX.c) * s, (MENU_PX.c - py) * s, 0).applyMatrix4(m);
  const n = new THREE.Vector3().setFromMatrixColumn(m, 2);
  return { p, n };
}

/** Touch a menu row with the tip (3 cm above, then 3 mm above). */
function touchRow(S, index, zone = 0) {
  const { p, n } = rowPoint(S, index, zone);
  tipAt(S.R, p, n, 0.03); S.step();
  tipAt(S.R, p, n, 0.003); S.step();
  tipAt(S.R, p, n, 0.03); S.step();
}

const names = (S) => S.actions.map((a) => a[0]);

test('construction: watch and menu in the scene, 4 + 4 meshes, fixed program keys, static face mipmapped, dynamic canvases not', () => {
  const S = setup();
  const w = S.watch;
  assert.ok(S.scene.children.includes(w.root) && S.scene.children.includes(w.menuRoot));
  assert.deepEqual(w.root.children.map((m) => m.name), ['watch-steel', 'watch-face', 'watch-readouts', 'watch-glass']);
  assert.deepEqual(w.menuRoot.children.map((m) => m.name), ['watch-menu-disc', 'watch-menu-rim',
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => `watch-menu-hi-${i}`), 'watch-menu-hi-zone', 'watch-menu-cursor']);
  assert.ok(w.hiRows.every((h) => h.material === w.hiMat) && w.hiZone.material === w.hiMat, 'one highlight material');
  assert.equal(w.root.visible, false, 'hidden until a left pose arrives');
  assert.equal(w.warmMeshes().length, 2);
  assert.equal(w.textures().length, 5);
  assert.equal(w.faceTex.generateMipmaps, true);
  assert.equal(w.readTex.generateMipmaps, false);
  assert.equal(w.menuTex.generateMipmaps, false);
  assert.equal(w.readMat.transparent, true);
  assert.equal(w.glassMat.transparent, true);
  assert.equal(w.glassMat.blending, THREE.AdditiveBlending);
  assert.equal(w.glassMat.depthWrite, false);
  assert.equal(w.hiMat.transparent, true);
  assert.equal(w.steelMat.vertexColors, true);
  assert.equal(w.faceMat.customProgramCacheKey(), 'cqc-watch-face-1');
  // the face shader hook adds the rotation
  const sh = { uniforms: {}, vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}' };
  w.faceMat.onBeforeCompile(/** @type {any} */ (sh), /** @type {any} */ (null));
  assert.ok(sh.vertexShader.includes('attribute float aPart') && sh.vertexShader.includes('uRot.w'));
  assert.equal(sh.uniforms.uRot, w.uRot, 'the live uniform object');
  // every geometry the rim and the steel share needs a colour attribute (vertexColors)
  assert.ok(w.steel.geometry.getAttribute('color') && w.menuRim.geometry.getAttribute('color'));
  assert.ok(w.face.geometry.getAttribute('aPart'));
  const parts = new Set(w.face.geometry.getAttribute('aPart').array);
  assert.deepEqual([...parts].sort(), [0, 1, 2, 3, 4]);
  // the canvases were drawn once (so the warm-up uploads real content)
  assert.equal(w.draws, 1);
  assert.equal(w.menuDraws, 1);
  // warm-up placement and back
  w.setWarm(true);
  assert.ok(w.root.visible && w.menuRoot.visible && w.hiRows.every((h) => h.visible) && w.hiZone.visible && w.cursor.visible);
  w.setWarm(false);
  assert.ok(!w.root.visible && !w.menuRoot.visible);
  // a size check: the steel stays a few thousand triangles
  const tris = w.steel.geometry.getAttribute('position').count / 3;
  assert.ok(tris < 12000, `${tris} steel triangles`);
});

test('pose: on the back of the left wrist, 9 cm behind the grip, 4.3 cm out; 12 away from you, 3 toward the hand, facing up', () => {
  const S = setup();
  S.step();
  const w = S.watch;
  assert.equal(w.root.visible, true);
  const gp = new THREE.Vector3(-0.1, 1.25, -0.3);
  const d = w.o.clone().sub(gp);
  assert.ok(Math.abs(d.x + 0.09) < 1e-4, `back along the forearm: ${d.x.toFixed(4)}`);
  assert.ok(Math.abs(d.length() - Math.hypot(0.09, 0.043)) < 1e-4);
  assert.ok(w.az.y > 0.95 && w.az.z > 0.2, `faces up and toward you: ${w.az.toArray().map((v) => v.toFixed(2))}`);
  assert.ok(w.ay.z < -0.9, '12 o\'clock away from you');
  assert.ok(w.ax.x > 0.99, '3 o\'clock toward the hand');
  // without a ray, the grip × inverse(grip-in-ray) gives the same frame
  const o1 = w.o.clone(), z1 = w.az.clone();
  S.L.hasRay = false;
  S.step();
  assert.ok(w.o.distanceTo(o1) < 1e-4 && w.az.distanceTo(z1) < 1e-4, 'grip fallback agrees');
  // no left pose: hidden
  S.L.hasGrip = false;
  S.step();
  assert.equal(w.root.visible, false);
  // the live grip→ray relation is recorded once, 2 s in
  S.L.hasGrip = true; S.L.hasRay = true;
  S.step(150);
  const rep = w.report();
  assert.ok(rep.gripRelL && Math.abs(rep.gripRelL[0] - 0.382) < 0.01, `IWER 45° relation: ${rep.gripRelL}`);
  // scale knob
  w.setWatchFit({ scale: 1.2, out: 0.05 });
  S.step();
  assert.ok(Math.abs(w.o.clone().sub(gp).length() - Math.hypot(0.09, 0.05)) < 1e-4);
});

test('wake: looking at the turned wrist wakes it (a faint left tick), looking away sleeps it; asleep it ignores taps', () => {
  const S = setup();
  S.step();
  // looking ahead (not at the watch): no wake, a tap does nothing
  S.step(30);
  assert.equal(S.watch.wake.awake, false);
  tapDial(S);
  assert.equal(S.watch.menuOpen, false, 'asleep: no menu');
  S.look();
  S.step(15);
  assert.equal(S.watch.wake.awake, true);
  assert.equal(S.watch.stats.wakes, 1);
  assert.deepEqual(S.L.pulses.at(-1), [0.08, 10]);
  assert.equal(S.watch._n[RC.INFO], 4, 'hint line (TAP · MENU) while awake with a free right hand');
  S.player.forward.set(0, 0, -1);
  S.step(40);
  assert.equal(S.watch.wake.awake, false);
});

test('open: a tap of the right tip on the dial opens the menu (haptics, tick, action), placed above the watch facing the eyes', () => {
  const S = setup();
  wake(S);
  tapDial(S);
  const w = S.watch;
  assert.equal(w.menuOpen, true);
  assert.deepEqual(names(S), ['menu']);
  assert.equal(S.actions[0][1], true);
  assert.deepEqual(S.R.pulses.at(-1), [0.5, 25]);
  assert.ok(S.audio.ui.some((u) => u[0] === 'watchTick'));
  assert.equal(w.capture, true, 'the trigger belongs to the watch while the menu is open');
  const P = w.menuPos;
  assert.ok(P.y - w.o.y > 0.08, 'lifted above the watch');
  assert.ok(Math.abs(P.distanceTo(S.player.eye) - WATCH.menu.dist) < 1e-6, 'at reading distance from the eye');
  const down = Math.asin((S.player.eye.y - P.y) / WATCH.menu.dist) * 180 / Math.PI;
  assert.ok(down >= WATCH.menu.downMin - 1e-6 && down <= WATCH.menu.downMax + 1e-6, `${down.toFixed(1)}° below eye level`);
  const n = new THREE.Vector3().setFromMatrixColumn(w.menuRoot.matrix, 2);
  const toEye = S.player.eye.clone().sub(P).normalize();
  assert.ok(n.dot(toEye) > 0.999, 'faces the eye');
  const x = new THREE.Vector3().setFromMatrixColumn(w.menuRoot.matrix, 0);
  assert.ok(Math.abs(x.y) < 1e-6, 'level (no roll)');
  assert.equal(w.menuRoot.visible, true);
});

test('open: right ray + trigger on the dial; not with a gun in the right hand unless paused; capture while pointing', () => {
  const S = setup();
  wake(S);
  const w = S.watch;
  aim(S.R, w.o.clone().add(new THREE.Vector3(0.12, 0.15, 0.12)), w.o); // from above and to the right
  S.step();
  assert.equal(w.capture, true, 'pointing at the dial: the trigger belongs to the watch');
  S.weapons.held = { carry: { inHand: true } };
  S.R.triggerDown = true; S.step(); S.R.triggerDown = false;
  assert.equal(w.menuOpen, false, 'gun in hand: the trigger fires the gun, not the watch');
  assert.equal(w.capture, false);
  S.game.paused = true;
  S.R.triggerDown = true; S.step(); S.R.triggerDown = false;
  assert.equal(w.menuOpen, true, 'paused: the ray opens it even with a gun in hand');
  assert.equal(w.stats.rays, 1);
});

test('menu: touch RESUME → resume + close; RESTART and EXIT need two taps within 3 s (TAP AGAIN)', () => {
  const S = setup();
  wake(S);
  tapDial(S);
  S.step(40); // let the menu settle and redraw
  touchRow(S, 0);
  assert.deepEqual(names(S), ['menu', 'resume', 'menu']);
  assert.equal(S.watch.menuOpen, false);
  // EXIT: one tap is not enough
  S.actions.length = 0;
  S.watch.openMenu();
  S.step(40);
  touchRow(S, 6);
  assert.equal(S.watch.menuOpen, true);
  assert.equal(S.watch._n[RC.CONFIRM], ROW.EXIT, 'the row shows TAP AGAIN');
  S.step(40);
  assert.ok(S.watch.menuCtx.texts.includes('TAP AGAIN'));
  touchRow(S, 6);
  assert.deepEqual(names(S), ['menu', 'exit', 'menu']);
  // RESTART with a 4 s gap: not confirmed
  S.actions.length = 0;
  S.watch.openMenu();
  S.step(5);
  touchRow(S, 1);
  S.step(72 * 4);
  assert.equal(S.watch._n[RC.CONFIRM], -1, 'expired');
  touchRow(S, 1);
  assert.ok(!names(S).includes('restart'));
  touchRow(S, 1);
  assert.ok(names(S).includes('restart'));
});

test('menu: ray + trigger presses rows; DIFFICULTY, MODE and AMMO LINE toggle with actions; a hover highlights without a texture upload', () => {
  const S = setup();
  wake(S);
  tapDial(S);
  S.step(40);
  const w = S.watch;
  const draws = w.menuDraws;
  const from = new THREE.Vector3(0.2, 1.3, -0.05);
  aim(S.R, from, rowPoint(S, 2).p);
  S.step(3);
  assert.equal(w.hoverRow, ROW.DIFFICULTY);
  assert.equal(w.hiRows[2].visible, true, 'the DIFFICULTY pill');
  assert.equal(w.hiRows.filter((h) => h.visible).length, 1);
  assert.equal(w.cursor.visible, true);
  assert.equal(w.menuDraws, draws, 'hover: no redraw');
  S.R.triggerDown = true; S.step(); S.R.triggerDown = false;
  assert.deepEqual(S.actions.at(-1), ['difficulty', 'realistic']);
  assert.ok(w.hiMat.opacity > 0.4, 'press flash');
  aim(S.R, from, rowPoint(S, 3).p);
  S.step();
  S.R.triggerDown = true; S.step(); S.R.triggerDown = false;
  assert.deepEqual(S.actions.at(-1), ['mode', 'spot']);
  aim(S.R, from, rowPoint(S, 5).p);
  S.step();
  S.R.triggerDown = true; S.step(); S.R.triggerDown = false;
  assert.deepEqual(S.actions.at(-1), ['ammoLine', false]);
  S.step(40);
  assert.equal(w._n[RC.AMMO_ON], 0, 'the dial hides the ammo window');
  assert.ok(w.menuCtx.texts.includes('REALISTIC') && w.menuCtx.texts.includes('SPOT') && w.menuCtx.texts.includes('OFF'));
  // setStatus from the integrator (saved settings)
  w.setStatus({ difficulty: 'test', playMode: 'roam', ammoLine: true });
  S.step(40);
  assert.ok(w.menuCtx.texts.includes('TEST') && w.menuCtx.texts.includes('ROAM'));
});

test('gun fit page: enters with the held gun, − / + taps and the right stick edit live, SAVE emits per changed gun, BACK reverts', () => {
  const S = setup();
  S.watch.setFit('glock', 1.5, 0.002, 0);
  S.watch.setFit('akm', 0, 0, 0);
  S.weapons.a.weapon = 'akm';
  wake(S);
  tapDial(S);
  S.step(5);
  touchRow(S, 4); // GUN FIT ▸
  const w = S.watch;
  assert.equal(w.page, PAGE.FIT);
  assert.deepEqual(S.actions.at(-1), ['fitBegin', 'akm']);
  S.step(40);
  assert.ok(w.menuCtx.texts.includes('GUN FIT · AKM'));
  touchRow(S, 1, 1); // PITCH +
  assert.deepEqual(S.actions.at(-1), ['fit', { weapon: 'akm', pitchDeg: 0.5, up: 0, fwd: 0 }]);
  { // hovering the + end lights the end disc, not the whole pill
    const { p, n } = rowPoint(S, 1, 1);
    tipAt(S.R, p, n, 0.02); S.step();
    assert.equal(w.hiZone.visible, true);
    assert.equal(w.hiRows.some((h) => h.visible), false);
    tipAt(S.R, p, n, 0.2); S.step();
  }
  touchRow(S, 2, 0); // select HEIGHT
  // hold the right stick up for 0.5 s
  S.R.sy = -1;
  const before = S.actions.length;
  S.step(36);
  S.R.sy = 0;
  const fits = S.actions.slice(before).filter((a) => a[0] === 'fit');
  assert.ok(fits.length > 30, 'live updates while the stick moves');
  assert.ok(Math.abs(fits.at(-1)[1].up - 0.015) < 0.001, `3 cm/s × 0.5 s: ${fits.at(-1)[1].up}`);
  assert.ok(S.R.pulses.some((p) => p[0] === 0.08 && p[1] === 10), 'a tick every 5 mm');
  // switch to the Glock (keeps the AKM's unsaved edit), then BACK: both revert
  touchRow(S, 0); // GUN
  assert.deepEqual(S.actions.at(-1), ['fitBegin', 'glock']);
  touchRow(S, 1, -1); // Glock PITCH −
  S.actions.length = 0;
  touchRow(S, 6); // BACK
  assert.deepEqual(S.actions.map((a) => a[0]), ['fit', 'fit', 'fitEnd']);
  assert.deepEqual(S.actions[0][1], { weapon: 'glock', pitchDeg: 1.5, up: 0.002, fwd: 0 });
  assert.deepEqual(S.actions[1][1], { weapon: 'akm', pitchDeg: 0, up: 0, fwd: 0 });
  assert.equal(w.page, PAGE.MAIN);
  // again, and SAVE
  touchRow(S, 4);
  touchRow(S, 3, 1); // FORWARD + on the AKM (the held gun)
  S.actions.length = 0;
  touchRow(S, 4); // SAVE
  assert.deepEqual(S.actions.map((a) => a[0]), ['fitSave', 'fitEnd']);
  assert.deepEqual(S.actions[0][1], { weapon: 'akm', pitchDeg: 0, up: 0, fwd: 0.001 });
  // closing the menu from the fit page reverts unsaved edits too
  touchRow(S, 4);
  touchRow(S, 1, 1);
  S.actions.length = 0;
  w.closeMenu('far');
  assert.deepEqual(S.actions.map((a) => a[0]), ['fit', 'fitEnd', 'menu']);
  assert.equal(S.actions[0][1].pitchDeg, 0);
});

test('menu closes when you walk away (0.9 m) or tap the watch again; the select() helper presses rows by name', () => {
  const S = setup();
  wake(S);
  tapDial(S);
  S.step(5);
  // tap the dial again: resume + close
  tipAt(S.R, S.watch.o, S.watch.az, 0.06); S.step();
  tipAt(S.R, S.watch.o, S.watch.az, 0.01); S.step();
  assert.equal(S.watch.menuOpen, false);
  assert.deepEqual(names(S), ['menu', 'resume', 'menu']);
  S.watch.openMenu();
  S.player.eye.set(1.5, 1.6, 0);
  S.step();
  assert.equal(S.watch.menuOpen, false);
  assert.equal(S.watch.closeReason, 'far');
  S.actions.length = 0;
  assert.equal(S.watch.select('ammo'), true);
  assert.deepEqual(S.actions.map((a) => a[0]), ['menu', 'ammoLine']);
  assert.equal(S.watch.select('pitch', 1), false, 'not on the main page');
  assert.equal(S.watch.select('nonsense'), false);
});

test('dial readouts: health, ammo, chamber, fire mode, wave, kills; scan progress and rooms; ≤ 2 redraws per second', () => {
  const S = setup();
  S.weapons.a = { weapon: 'akm', mag: 23, chambered: true, mode: 'auto', spares: 4 };
  S.step(40);
  const w = S.watch, n = w._s;
  assert.deepEqual([n[RC.HEALTH], n[RC.WEAPON], n[RC.MAG], n[RC.CHAMBER], n[RC.MODE], n[RC.WAVE]], [100, 2, 23, 1, 3, 1]);
  const texts = w.readCtx.texts;
  for (const s of ['100', '23', 'AUTO', '1']) assert.ok(texts.includes(s), s);
  S.weapons.a = { weapon: 'akm', mag: null, chambered: false, mode: 'safe' };
  S.step(40);
  assert.ok(texts.includes('--') && texts.includes('SAFE'));
  // scanning: rooms in the 9 o'clock window, progress on the info line
  w.setStatus({ scanning: true, rooms: 4, learn: 0.62 });
  S.game.phaseName = 'ready';
  S.game.phaseName = 'spot';
  S.step(40);
  assert.ok(texts.includes('4') && texts.includes('SCAN 62%'));
  // the redraw limit: a value changing every frame for 3 s
  const d0 = w.draws;
  for (let i = 0; i < 72 * 3; i++) { S.game.kills = i; S.step(); }
  const per = (w.draws - d0) / 3;
  assert.ok(per <= 2.05 && per >= 1.5, `${per.toFixed(2)} redraws per second`);
  // the shared upload gate: another panel took this frame's upload → the watch waits
  w.setStatus({ scanning: false });
  S.step(80); // drawn, and 500 ms passed since
  S.game.kills = 999;
  const d1 = w.draws;
  const tNext = S.t + DT * 1000;
  assert.equal(claimUpload(tNext), true);
  S.step();
  assert.equal(w.draws, d1, 'no second upload in the same frame');
  S.step();
  assert.equal(w.draws, d1 + 1);
});

test('wave start: the bezel clicks round so its pip meets the minute hand (ratchet heard only while looking)', () => {
  const S = setup();
  S.step(30);
  S.audio.ui.length = 0;
  S.game.wave = 2;
  S.step(40);
  assert.ok(!S.audio.ui.some((u) => u[2] === 1.6), 'not looking: silent');
  assert.ok(S.watch.bezel.pos > 0 || S.watch.bezel.pipTurn >= 0);
  wake(S);
  // put the pip half a turn from the minute hand, so the next wave must turn it
  const B = S.watch.bezel, k = Math.round((-S.watch._hands[1] / (2 * Math.PI)) * 120) % 120;
  B.pos = B.from = B.to = ((120 - k) % 120 + 60) % 120;
  S.audio.ui.length = 0;
  S.game.wave = 3;
  S.step(40);
  const minute = -S.watch._hands[1] / (2 * Math.PI);
  const pip = S.watch.bezel.pipTurn;
  const diff = Math.abs(((pip - minute + 1.5) % 1) - 0.5);
  assert.ok(diff <= 1 / 120 + 1e-3, `pip ${pip.toFixed(3)} vs minute ${minute.toFixed(3)}`);
  assert.ok(S.audio.ui.some((u) => u[0] === 'watchTick' && u[2] === 1.6), 'bezel clicks');
  assert.equal(S.watch.uRot.value.x, S.watch.bezel.angle);
});

test('warnings: the left hand vibrates in the kind\'s pattern, the dial shows the icon word, tracking is severe; clear stops', () => {
  const S = setup();
  S.step(5);
  S.L.pulses.length = 0;
  assert.equal(S.watch.warn('obstacle', 1), true);
  S.step(72 * 2);
  assert.ok(S.L.pulses.length >= 6, `${S.L.pulses.length} pulses in 2 s`);
  S.step(40);
  assert.equal(S.watch._s[RC.WARN], WARN.OBSTACLE);
  assert.equal(S.watch._s[RC.SEVERE], 1);
  assert.ok(S.watch.readCtx.texts.includes('WALL'));
  assert.ok(S.audio.ui.some((u) => u[0] === 'watchAlert'), 'a quiet alert at full level');
  S.watch.warn('run', 0.5);
  S.watch.warn('obstacle', 0);
  S.step(40);
  assert.ok(S.watch.readCtx.texts.includes('SLOW'));
  S.watch.clearWarnings();
  S.L.pulses.length = 0;
  S.step(72 * 2);
  assert.equal(S.L.pulses.length, 0);
  assert.equal(S.watch._s[RC.WARN], -1);
  // no alert sound when turned off
  const quiet = setup({ alertSound: false });
  quiet.watch.warn('tracking', 1);
  quiet.step(72 * 4);
  assert.ok(!quiet.audio.ui.some((u) => u[0] === 'watchAlert'));
  assert.ok(quiet.L.pulses.length >= 1);
});

test('no brand names on the watch: every label is generic', async () => {
  const { ALL_LABELS } = await import('../../src/ui/watchArt.js');
  const banned = /rolex|oyster|submariner|omega|seamaster|tudor|breitling|seiko|patek|audemars|cartier|swiss|coronet|crown logo/i;
  for (const s of ALL_LABELS) assert.ok(!banned.test(s), s);
  const S = setup();
  S.step(40);
  for (const s of [...S.watch.readCtx.texts, ...S.watch.menuCtx.texts]) assert.ok(!banned.test(s), s);
  const face = setup().watch.faceTex.image.getContext('2d').texts;
  assert.ok(face.includes('CQC'), 'the game\'s own maker mark');
  for (const s of face) assert.ok(!banned.test(s), s);
});

test('sounds: installWatchSounds adds the tick and alert banks to an AudioEngine-like object', () => {
  const made = [];
  const ac = { sampleRate: 48000, createBuffer(ch, n, sr) { const d = new Float32Array(n); made.push(n); return { getChannelData: () => d, length: n, sampleRate: sr }; } };
  const audio = { ctx: ac, buffers: {} };
  assert.equal(installWatchSounds(audio), true);
  assert.equal(audio.buffers.watchTick.length, 1);
  assert.equal(audio.buffers.watchAlert.length, 1);
  assert.equal(installWatchSounds({ ctx: null, buffers: {} }), false);
});

test('allocation-free frame: pose, wake, menu hover and presses, stick, warnings and redraws', async () => {
  REC.on = false;
  const S = setup();
  wake(S);
  const w = S.watch;
  const from = new THREE.Vector3(0.2, 1.3, -0.05);
  w.warn('obstacle', 0.6);
  let k = 0;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      k++;
      if (k % 900 === 0) { tipAt(S.R, w.o, w.az, 0.06); S.step(); tipAt(S.R, w.o, w.az, 0.01); } // open
      if (k % 900 === 300 && w.menuOpen) aim(S.R, from, rowPoint(S, 2).p); // hover DIFFICULTY (aim() allocates in the test)
      if (k % 900 === 400) S.R.triggerDown = true; // press
      if (k % 900 === 401) S.R.triggerDown = false;
      if (k % 900 === 600) w.closeMenu('code');
      if (k % 50 === 0) S.game.kills = (S.game.kills + 1) % 500;
      S.step();
    }
  };
  // long enough for TurboFan to optimise update() even while the other test files run in parallel
  // (interpreted frames box doubles, which the sampler would count)
  loop(90000);
  assert.ok(w.stats.opens > 10 && w.stats.presses > 10 && w.draws > 50, JSON.stringify(w.stats));
  let best = Infinity, by = null;
  for (let r = 0; r < 6 && best > 0; r++) {
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(18000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const b = {};
    const files = ['/src/ui/Watch.js', '/src/ui/watchLogic.js', '/src/ui/watchArt.js'];
    const walk = (n) => {
      const u = n.callFrame.url;
      const key = `${n.callFrame.functionName}@${n.callFrame.lineNumber}`;
      if (n.selfSize > 0 && files.some((f) => u.endsWith(f))) b[key] = (b[key] || 0) + n.selfSize;
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(b).reduce((x, y) => x + y, 0);
    if (t < best) { best = t; by = b; }
  }
  REC.on = true;
  assert.equal(best, 0, JSON.stringify(by));
});
