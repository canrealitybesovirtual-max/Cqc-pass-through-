// @ts-check
// Dev-only render check for the baked assets (driven by tools/assets/render-check.mjs).
// Loads everything through src/core/Assets.js, then renders named views on demand:
// window.renderView(name) -> info. Lights match src/core/Renderer.js.
import * as THREE from 'three';
import { Assets } from '../../src/core/Assets.js';

const W = 1280, H = 800;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setClearColor(0x3a3e46, 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3026, 1.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.6, 1.0, 0.4);
scene.add(hemi, sun);
const camera = new THREE.PerspectiveCamera(22, W / H, 0.01, 50);
const holder = new THREE.Group();
scene.add(holder);

const assets = new Assets({ renderer, base: '../../assets/', transcoderPath: '../../vendor/three/addons/libs/basis/' });
/** @type {any} */ (window).__progress = [];
await assets.load((f, l) => /** @type {any} */ (window).__progress.push([+f.toFixed(3), l]));
const M = assets.manifest;

/** Info about the loaded textures (format chosen by the KTX2 transcoder). */
const texInfo = assets.textures().map((t) => ({ name: t.name, w: t.image?.width, h: t.image?.height, mips: t.mipmaps?.length, format: t.format, compressed: !!(/** @type {any} */ (t).isCompressedTexture), colorSpace: t.colorSpace }));

const PART_COLORS = [0x9a9a9a, 0xe04040, 0x40d040, 0x4070ff, 0xffd020];

/** @param {THREE.Object3D} o */
function clear(o) { while (o.children.length) o.remove(o.children[0]); }

/** @param {THREE.Object3D} obj @param {THREE.Vector3} dir @param {number} [fit] @param {THREE.Vector3} [focus] */
function frame(obj, dir, fit = 1.15, focus) {
  const box = new THREE.Box3().setFromObject(obj);
  const c = focus || box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2;
  const d = (r * fit) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.copy(c).addScaledVector(dir.clone().normalize(), d);
  camera.up.set(0, 1, 0);
  camera.lookAt(c);
  camera.near = d / 50; camera.far = d * 10; camera.updateProjectionMatrix();
}

/** @param {number[]} p @param {number} color @param {number} r */
function dot(p, color, r) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.fromArray(p); m.renderOrder = 10;
  return m;
}
/** @param {number[]} a @param {number[]} dir @param {number} len @param {number} color */
function ray(a, dir, len, color) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3().fromArray(a), new THREE.Vector3().fromArray(a).addScaledVector(new THREE.Vector3().fromArray(dir), len)]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false })); l.renderOrder = 10;
  return l;
}

/** Markers at the manifest points of a weapon (gun space). @param {any} w @param {number} r */
function markers(w, r) {
  const g = new THREE.Group();
  g.add(dot(w.muzzle, 0xff2020, r), ray(w.muzzle, [0, 0, -1], r * 8, 0xff2020));
  g.add(dot(w.ejectionPort, 0xffee00, r), ray(w.ejectionPort, w.ejectDir, r * 8, 0xffee00));
  g.add(dot(w.grip.pos, 0x20ff40, r), ray(w.grip.pos, w.grip.up, r * 10, 0x20ff40), ray(w.grip.pos, w.grip.fwd, r * 6, 0x108020));
  g.add(dot(w.magWell.pos, 0x00e0ff, r), ray(w.magWell.pos, w.magWell.axis, -r * 14, 0x00e0ff));
  g.add(dot(w.slide.rackPoint, 0xff40ff, r));
  g.add(dot(w.trigger.pivot, 0xff9000, r));
  if (w.support) g.add(dot(w.support.pos, 0x4060ff, r));
  g.add(dot(w.sights.rear, 0xffffff, r * 0.7), dot(w.sights.front, 0xffffff, r * 0.7));
  const s = new THREE.Vector3().fromArray(w.sights.front).sub(new THREE.Vector3().fromArray(w.sights.rear)).normalize().toArray();
  g.add(ray(w.sights.rear, s, 1.5, 0xffffff));
  g.add(dot([0, 0, 0], 0x000000, r * 0.6));
  return g;
}

/** Geometry copy with the moving parts displaced (slide back, trigger pulled) and vertex colours by part. @param {THREE.Mesh} gun @param {any} w @param {{ open?: boolean, colors?: boolean }} o */
function posedGun(gun, w, o) {
  const g = gun.geometry.clone();
  const pos = g.attributes.position, part = g.attributes._part;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), piv = new THREE.Vector3().fromArray(w.trigger.pivot);
  const qT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(w.trigger.axis), w.trigger.pullRad);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const p = Math.round(part.getX(i));
    v.fromBufferAttribute(pos, i);
    if (o.open && p === 1) v.addScaledVector(new THREE.Vector3().fromArray(w.slide.axis), w.slide.travel);
    if (o.open && p === 2) v.sub(piv).applyQuaternion(qT).add(piv);
    pos.setXYZ(i, v.x, v.y, v.z);
    c.setHex(PART_COLORS[p] ?? 0xffffff);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  if (o.colors) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = o.colors ? new THREE.MeshLambertMaterial({ vertexColors: true }) : gun.material;
  return new THREE.Mesh(g, mat);
}

/** @param {'glock' | 'akm'} id @param {string} view */
function weaponView(id, view) {
  const m = assets.models[id];
  if (!m) throw new Error(id);
  const w = m.manifest;
  const r = id === 'glock' ? 0.0018 : 0.004;
  const root = new THREE.Group();
  holder.add(root);
  const right = new THREE.Vector3(1, 0, 0);
  if (view === 'right' || view === 'left' || view === 'top' || view === 'front34' || view === 'rear34' || view === 'below') {
    root.add(m.scene);
    const dirs = { right, left: new THREE.Vector3(-1, 0, 0), top: new THREE.Vector3(0.001, 1, 0), front34: new THREE.Vector3(-0.8, 0.5, -1), rear34: new THREE.Vector3(0.7, 0.45, 1), below: new THREE.Vector3(0.6, -0.8, -0.3) };
    frame(root, /** @type {any} */ (dirs)[view]);
  } else if (view === 'albedo') {
    const g = m.scene.clone(true);
    g.traverse((/** @type {any} */ o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ map: o.material.map }); });
    root.add(g);
    frame(root, right);
  } else if (view === 'parts' || view === 'open') {
    root.add(posedGun(m.gun, w, { open: view === 'open', colors: view === 'parts' }));
    const mag = m.mag.clone();
    if (view === 'open') mag.position.addScaledVector(new THREE.Vector3().fromArray(w.magWell.axis), -0.09);
    else mag.material = new THREE.MeshLambertMaterial({ color: 0xb050ff });
    root.add(mag);
    frame(root, right);
  } else if (view === 'markers') {
    const g = m.scene.clone(true);
    g.traverse((/** @type {any} */ o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.45; o.material.depthWrite = false; } });
    root.add(g, markers(w, r));
    frame(root, right);
  } else if (view === 'muzzle') {
    root.add(m.scene);
    frame(root, new THREE.Vector3(0.05, 0.02, -1), 0.5, new THREE.Vector3().fromArray(w.muzzle));
  } else if (view === 'sights') {
    root.add(m.scene);
    const eye = new THREE.Vector3().fromArray(w.sights.rear).add(new THREE.Vector3(0, 0, id === 'glock' ? 0.3 : 0.25));
    camera.position.copy(eye); camera.up.set(0, 1, 0); camera.lookAt(new THREE.Vector3().fromArray(w.sights.front));
    camera.fov = 8; camera.near = 0.01; camera.far = 10; camera.updateProjectionMatrix();
  } else throw new Error(`view ${view}`);
  return { tris: w.tris };
}

/** @param {string} view */
function soldierView(view) {
  const s = assets.models.soldier;
  if (!s) throw new Error('soldier');
  const root = new THREE.Group();
  holder.add(root);
  root.add(s.scene);
  s.scene.updateMatrixWorld(true);
  if (view === 'front') frame(root, new THREE.Vector3(0, 0.1, 1), 0.75);
  else if (view === 'side') frame(root, new THREE.Vector3(1, 0.1, 0), 0.75);
  else if (view === 'back') frame(root, new THREE.Vector3(0, 0.2, -1), 0.75);
  else if (view === 'hand') {
    const hand = /** @type {THREE.Object3D} */ (s.scene.getObjectByName(s.manifest.joints.handR));
    const p = hand.getWorldPosition(new THREE.Vector3());
    camera.position.copy(p).add(new THREE.Vector3(-0.35, 0.35, 0.9)); camera.lookAt(p);
    camera.fov = 40; camera.near = 0.01; camera.far = 20; camera.updateProjectionMatrix();
  } else throw new Error(`view ${view}`);
  const box = new THREE.Box3().setFromObject(s.mesh, true);
  return { bindBox: [box.min.toArray(), box.max.toArray()], bones: s.mesh.skeleton.bones.length };
}

/** @param {string} name */
function renderView(name) {
  clear(holder);
  camera.fov = 22;
  const [what, view] = name.split('-');
  const info = what === 'soldier' ? soldierView(view) : weaponView(/** @type {'glock' | 'akm'} */ (what), view);
  renderer.render(scene, camera);
  return { ...info, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length };
}

/** Bone names and the rifle pose, for the report. */
function soldierInfo() {
  const s = /** @type {any} */ (assets.models.soldier);
  const rifle = s.rifle;
  return {
    bones: s.mesh.skeleton.bones.length,
    rifleParent: rifle.parent?.name,
    riflePos: rifle.position.toArray().map((/** @type {number} */ x) => +x.toFixed(4)),
    rifleTris: rifle.geometry.index.count / 3,
    bodyTris: s.mesh.geometry.index.count / 3,
    material: s.mesh.material.type,
    jointsFound: Object.values(s.manifest.joints).flat().every((n) => !!s.scene.getObjectByName(n)),
  };
}

/** @type {any} */ (window).renderView = renderView;
/** @type {any} */ (window).__report = {
  textures: texInfo, soldier: soldierInfo(),
  weapons: Object.fromEntries(['glock', 'akm'].map((id) => {
    const m = /** @type {any} */ (assets.models)[id];
    return [id, { gunTris: m.gun.geometry.index.count / 3, magTris: m.mag.geometry.index.count / 3, partValues: [...new Set(m.gun.geometry.attributes._part.array)].sort(), material: m.gun.material.type, magPos: m.mag.position.toArray() }];
  })),
  sounds: Object.fromEntries(Object.entries(assets.sounds).map(([k, v]) => [k, v.map((b) => b.byteLength)])),
};
/** @type {any} */ (window).__ready = true;
