// @ts-check
// Dev-only render check of the v0.3 gun fit (driven by tools/assets/fit-check.mjs): the real game
// code (createRenderer with its PMREM room light, Assets, WeaponSystem, Input) holds each gun in a
// right controller posed through a fake XR session, with the Quest Touch Plus profile mesh
// (npm @webxr-input-profiles/assets, served under /ext/) drawn at the grip space so the fit can be
// judged against the real controller. window.renderView(name) -> info.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRenderer } from '../../src/core/Renderer.js';
import { Assets } from '../../src/core/Assets.js';
import { WeaponSystem } from '../../src/weapons/WeaponSystem.js';
import { Input } from '../../src/xr/Input.js';
import { Events } from '../../src/core/Events.js';
import { CARRY_HAND } from '../../src/player/Slots.js';

const W = 1280, H = 800;
const gfx = /** @type {NonNullable<ReturnType<typeof createRenderer>>} */ (createRenderer({ dev: true }));
const { renderer, scene } = gfx;
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setClearColor(0x5d6066, 1);   // a dim room standing in for passthrough
document.body.appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(60, W / H, 0.01, 50);

// a floor and a wall behind, so the holster views have a reference
const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0x6e6255, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const assets = new Assets({ renderer, base: '../../assets/', transcoderPath: '../../vendor/three/addons/libs/basis/' });
const loader = new GLTFLoader();
/** @type {any} */
const w = window;
let ctrl = /** @type {Record<string, THREE.Object3D>} */ ({});
try {
  await assets.load();
  for (const side of ['left', 'right']) {
    const g = await loader.loadAsync(`/ext/meta-quest-touch-plus/${side}.glb`);
    g.scene.traverse((/** @type {any} */ o) => { if (o.isMesh) { o.material = new THREE.MeshStandardMaterial({ color: 0xe9e9ea, roughness: 0.55, metalness: 0 }); } });
    ctrl[side] = g.scene;
    scene.add(g.scene);
  }
} catch (e) {
  w.__failed = String(e);
  throw e;
}

// ---- fake XR input through the real Input (grip = ray · G, Meta's IWER Touch Plus matrices)
const G = {
  right: new THREE.Matrix4().fromArray([0.99255, 0, 0.12187, 0, -0.08617, 0.70711, 0.70184, 0, -0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1]),
  left: new THREE.Matrix4().fromArray([0.99255, 0, -0.12187, 0, 0.08617, 0.70711, 0.70184, 0, 0.08617, -0.70711, 0.70184, 0, 0, 0, 0, 1]),
};
const GQ = { right: new THREE.Quaternion().setFromRotationMatrix(G.right), left: new THREE.Quaternion().setFromRotationMatrix(G.left) };
/** @param {'left'|'right'} side */
function fakeHand(side) {
  const buttons = Array.from({ length: 6 }, () => ({ value: 0, pressed: false }));
  const gripSpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const raySpace = { pose: { transform: { matrix: new Float32Array(16) } } };
  const src = { handedness: side, gamepad: { buttons, axes: [0, 0, 0, 0], hapticActuators: [] }, gripSpace, targetRaySpace: raySpace, hand: null };
  return {
    src,
    gripPos: new THREE.Vector3(), gripQ: new THREE.Quaternion(),
    /** grip pose directly */
    grip(/** @type {THREE.Vector3} */ p, /** @type {THREE.Quaternion} */ q) {
      this.gripPos.copy(p); this.gripQ.copy(q);
      const ray = q.clone().multiply(GQ[side].clone().invert());
      new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)).toArray(gripSpace.pose.transform.matrix);
      new THREE.Matrix4().compose(p, ray, new THREE.Vector3(1, 1, 1)).toArray(raySpace.pose.transform.matrix);
      ctrl[side].position.copy(p); ctrl[side].quaternion.copy(q);
    },
    set(/** @type {number} */ i, /** @type {number} */ v) { buttons[i].value = v; buttons[i].pressed = v > 0.5; },
  };
}
const L = fakeHand('left'), R = fakeHand('right');
const session = { inputSources: [L.src, R.src] };
const frame = { getPose: (/** @type {any} */ s) => s.pose };
const input = new Input();
const player = { eye: new THREE.Vector3(0, 1.7, 0), quat: new THREE.Quaternion(), valid: true, floorY: 0, standEye: 1.7 };
const events = new Events();
const ctx = { scene, events, audio: null, world: null, input, player, gfx: { flashLights: gfx.flashLights }, assets, raycast: null };
const weapons = new WeaponSystem(/** @type {any} */ (ctx));
let t = 1000;
function step(n = 1) {
  for (let i = 0; i < n; i++) {
    t += 1000 / 72;
    input.update(/** @type {any} */ (session), /** @type {any} */ (frame), /** @type {any} */ ({}), 1 / 72);
    weapons.update(1 / 72, t, /** @type {any} */ (frame), ctx);
  }
}
const v3 = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => new THREE.Vector3(x, y, z);
const Q0 = new THREE.Quaternion();
L.grip(v3(-0.3, 0.9, -0.1), Q0);
R.grip(v3(0.3, 0.9, -0.1), Q0);
step(40);

/** Gun orientation: yaw, then pitch (upright). @param {number} yaw @param {number} pitch */
const gunQ = (yaw, pitch) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

/** Hold `id` with its grip at `pos` and the gun at `q` (draws it first if needed). */
function hold(/** @type {'glock'|'akm'} */ id, /** @type {THREE.Vector3} */ pos, /** @type {THREE.Quaternion} */ q) {
  const wpn = weapons[id];
  if (weapons.held !== wpn) {
    if (weapons.held) { R.set(1, 0); step(30); }
    const B = weapons.body;
    const at = id === 'glock' ? v3(B.holster.p[0], B.holster.p[1], B.holster.p[2]) : v3(B.back.p[0], B.back.p[1], B.back.p[2]).addScaledVector(v3(B.backAxis[0], B.backAxis[1], B.backAxis[2]), 0.1);
    R.grip(at, Q0); step(2); R.set(1, 1); step(3);
  }
  const gq = q.clone().multiply(wpn.view.fitQuat.clone().invert());   // grip = gun · fit⁻¹
  R.grip(pos, gq);
  step(30);
  return wpn;
}

/** Point the camera. */
function look(/** @type {THREE.Vector3} */ from, /** @type {THREE.Vector3} */ at, fov = 60) {
  camera.fov = fov; camera.near = 0.01; camera.updateProjectionMatrix();
  camera.position.copy(from); camera.up.set(0, 1, 0); camera.lookAt(at);
}

function info() {
  const out = { held: weapons.held && weapons.held.id, gloves: [] , glockVisible: weapons.glock.view.root.visible, akmVisible: weapons.akm.view.root.visible,
    holster: weapons.holster.visible, seated: weapons.body.seated, programs: renderer.info.programs?.length };
  for (const k of ['glock', 'akm']) { const v = weapons[k].view; out.gloves.push(`${k}: r ${!!v.handR && v.handR.visible} l ${!!v.handL && v.handL.visible}`); }
  return out;
}

/** @type {Record<string, () => void>} */
const VIEWS = {
  // Glock in the hand: grip 45 cm ahead, 25 cm below and 12 cm right of the eyes, level
  'glock-side': () => { hold('glock', v3(0.12, 1.42, -0.42), gunQ(0, 0)); look(v3(-0.45, 1.46, -0.40), v3(0.12, 1.40, -0.44), 30); },
  'glock-side-bare': () => { weapons.setGloves(false); hold('glock', v3(0.12, 1.42, -0.42), gunQ(0, 0)); step(1); look(v3(-0.45, 1.46, -0.40), v3(0.12, 1.40, -0.44), 30); weapons.setGloves(true); },
  'glock-eye': () => { hold('glock', v3(0.12, 1.42, -0.42), gunQ(0.05, 0.02)); look(v3(0, 1.66, 0), v3(0.1, 1.42, -0.5), 50); },
  'glock-eye-bare': () => { weapons.setGloves(false); hold('glock', v3(0.12, 1.42, -0.42), gunQ(0.05, 0.02)); step(1); look(v3(0, 1.66, 0), v3(0.1, 1.42, -0.5), 50); weapons.setGloves(true); },
  'glock-trigger-left': () => { hold('glock', v3(0.12, 1.42, -0.42), gunQ(0, 0)); look(v3(-0.25, 1.40, -0.46), v3(0.12, 1.39, -0.46), 16); },
  'glock-trigger-under': () => { hold('glock', v3(0.12, 1.42, -0.42), gunQ(0, 0)); look(v3(0.05, 1.05, -0.62), v3(0.12, 1.39, -0.46), 22); },
  'akm-trigger-left': () => { akm(); look(v3(-0.25, 1.38, -0.30), v3(0.15, 1.38, -0.32), 18); },
  'glock-front34': () => { hold('glock', v3(0.12, 1.42, -0.42), gunQ(0, 0)); look(v3(0.45, 1.6, -0.85), v3(0.12, 1.42, -0.48), 30); },
  // AKM two-handed: right grip 22 cm ahead of the right shoulder, the left hand on the handguard
  'akm-side': () => { akm(); look(v3(-0.75, 1.5, -0.45), v3(0.1, 1.42, -0.5), 35); },
  'akm-side-bare': () => { weapons.setGloves(false); akm(); step(1); look(v3(-0.75, 1.5, -0.45), v3(0.1, 1.42, -0.5), 35); weapons.setGloves(true); },
  'akm-eye': () => { akm(); look(v3(0.0, 1.6, 0.0), v3(0.1, 1.42, -0.55), 60); },
  'akm-eye-bare': () => { weapons.setGloves(false); akm(); step(1); look(v3(0.0, 1.6, 0.0), v3(0.1, 1.42, -0.55), 60); weapons.setGloves(true); },
  // holster / sling looking down (standing; then seated)
  'down-standing': () => { unhold(); head(1.7, -1.15); step(90); eyeCam(); },
  'down-standing-45': () => { unhold(); head(1.7, -0.8); step(90); eyeCam(); },
  'down-seated': () => { unhold(); head(1.2, -0.2); step(200); head(1.2, -1.0); step(60); eyeCam(); },
  'third-standing': () => { unhold(); head(1.7, -0.2); step(90); look(v3(0.9, 1.4, -0.9), v3(0.1, 1.0, 0.05), 40); },
  'third-seated': () => { unhold(); head(1.2, -0.2); step(200); look(v3(0.9, 1.0, -0.9), v3(0.1, 0.6, 0.0), 40); },
};

function akm() {
  const q = gunQ(0.03, 0.0);
  const wpn = hold('akm', v3(0.15, 1.40, -0.30), q);
  // the left grip on the support target, gripped like the right (mirrored): grip = gun · Rx(+73.4°)
  const v = wpn.view, sup = v.toWorld(v.supportTarget, v3(0, 0, 0));
  L.grip(sup, q.clone().multiply(v.fitQuat.clone().invert()));
  step(2); L.set(1, 1); step(10);
  const sup2 = v.toWorld(v.supportTarget, v3(0, 0, 0));
  L.grip(sup2, v.root.quaternion.clone().multiply(v.fitQuat.clone().invert()));
  step(10);
}
function unhold() {
  L.set(1, 0); R.set(1, 0); step(40);
  L.grip(v3(-0.25, 0.85, -0.05), Q0); R.grip(v3(0.25, 0.85, -0.05), Q0); step(5);
}
/** @param {number} eye @param {number} pitch */
function head(eye, pitch) { player.eye.set(0, eye, 0); player.standEye = 1.7; player.quat.setFromEuler(new THREE.Euler(pitch, 0, 0, 'YXZ')); }
function eyeCam() {
  camera.fov = 90; camera.near = 0.02; camera.updateProjectionMatrix();
  camera.position.copy(player.eye); camera.quaternion.copy(player.quat);
}

w.renderView = (/** @type {string} */ name) => {
  const f = VIEWS[name];
  if (!f) return { error: `no view ${name}` };
  f();
  camera.updateMatrixWorld();
  renderer.render(scene, camera);
  return { name, ...info() };
};
w.__views = Object.keys(VIEWS);
w.__ready = true;
void CARRY_HAND;
