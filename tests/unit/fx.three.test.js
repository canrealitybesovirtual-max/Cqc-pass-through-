/**
 * src/fx with the real three r187 (resolve hook, as in game.session.test.js):
 * the passthrough-match hook (chaining, keys, injected code), the contact
 * shadow pool (items on a table and a bed, frozen when resting, enemies'
 * feet and bodies from the real soldier rig), impacts by material (decals,
 * particles, sounds), RoomLight (presets per room, windows, saved per house,
 * the env yaw), the Look facade, and allocation-free frames.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));

const THREE = await import('three');
const { applyPassthroughMatch, matchMaterials, tuneMaterials, isMatched, uPtm, PTM_KEY, PTM_CONTACT_KEY, grainStep } = await import('../../src/fx/PassthroughMatch.js');
const { GroundShadows, isSoftSurface } = await import('../../src/fx/GroundShadows.js');
const { Impacts, uRoomLight } = await import('../../src/fx/Impacts.js');
const { RoomLight, envYawFor, matchRoom } = await import('../../src/fx/RoomLight.js');
const { Look, lookFromSearch } = await import('../../src/fx/Look.js');
const { toneFromParams, TONE } = await import('../../src/core/Renderer.js');
const { applySoftOcclusion } = await import('../../src/xr/DepthOcclusion.js');
const { IMP, LEVEL_DIM, LEVEL_BRIGHT } = { ...(await import('../../src/fx/impactTable.js')), ...(await import('../../src/fx/roomLightMath.js')) };
const { RigDef, jointsFromGltfJson } = await import('../../src/enemies/Rig.js');
const { Animator } = await import('../../src/enemies/Animator.js');
const { CapsuleSet, Hitbox } = await import('../../src/enemies/Hitbox.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

/** three's own standard shader, as handed to onBeforeCompile. */
function stdShader() {
  const L = THREE.ShaderLib.standard;
  return { uniforms: {}, vertexShader: L.vertexShader, fragmentShader: L.fragmentShader };
}

// ── a small fake house: floor at 0, a table top at 0.75, a bed at 0.55 ──────
const TABLE = { x0: 0.8, x1: 2.0, z0: -2.2, z1: -1.4, y: 0.75 };
const BED = { x0: 4.6, x1: 6.6, z0: -1.9, z1: -0.3, y: 0.55 };
const world = {
  built: true, roamOn: true, rays: 0, playerRoom: 1,
  raycast(ox, oy, oz, dx, dy, dz, max, out) {
    this.rays++;
    if (!(dy < -0.5)) return false; // downward rays only in this fake
    let y = 0, label = 'floor';
    if (ox >= TABLE.x0 && ox <= TABLE.x1 && oz >= TABLE.z0 && oz <= TABLE.z1 && oy >= TABLE.y) { y = TABLE.y; label = 'table'; }
    else if (ox >= BED.x0 && ox <= BED.x1 && oz >= BED.z0 && oz <= BED.z1 && oy >= BED.y) { y = BED.y; label = 'bed'; }
    const t = (oy - y) / -dy;
    if (!(t >= 0 && t <= max)) return false;
    out.dist = t; out.x = ox + dx * t; out.y = y; out.z = oz + dz * t; out.nx = 0; out.ny = 1; out.nz = 0; out.surface = label;
    return true;
  },
  floorY() { return 0; },
  roomAt(x) { return x > 3.05 ? 2 : 1; },
  roamIndex: { roomCount: 2, roomCells: Uint32Array.from([0, 2000, 1050]) },
  nav: { cell: 0.1 },
  layout: { furniture: [{ cx: 1.4, cz: -1.8, label: 'table' }, { cx: -1.5, cz: -1.5, label: 'couch' }, { cx: 5.6, cz: -1.1, label: 'bed' }] },
};

/** A fake PhysicsWorld with n slots (the fields GroundShadows reads). */
function fakePhys(n = 4) {
  return {
    maxItems: n, st: new Uint8Array(n), cur: new Float64Array(n * 7), kindOf: new Int16Array(n).fill(-1),
    kinds: [{ centre: [0, -0.02, -0.05], half: [0.016, 0.07, 0.1] }],
    put(i, x, y, z, q = [0, 0, 0, 1], st = 2) { this.st[i] = st; this.kindOf[i] = 0; this.cur.set([x, y, z, ...q], i * 7); },
  };
}

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}

/** One soldier standing at (x, 0, z) (real animator and capsules), shaped like EnemyManager. */
function fakeEnemies(x, z) {
  const def = loadRig();
  const an = new Animator(def, 5);
  an.reset(x, 0, z, 0);
  an.aimX = x; an.aimY = 1.4; an.aimZ = z + 6;
  for (let i = 0; i < 60; i++) an.update(1 / 60);
  const capsules = new CapsuleSet(def);
  const hb = new Hitbox(capsules);
  hb.update(an);
  return { max: 1, brain: { agents: [{ active: true, alive: true }] }, anims: [an], hitboxes: [hb], capsules };
}

// ─────────────────────────────────────────────────────────────────────────────

test('tone mapping is chosen at load: neutral by default, URL A/B switches', () => {
  const t = toneFromParams();
  assert.equal(t.name, 'neutral');
  assert.equal(t.mapping, THREE.NeutralToneMapping);
  assert.equal(t.exposure, 1);
  globalThis.location = /** @type {any} */ ({ search: '?tm=agx&exposure=9' });
  try {
    const u = toneFromParams();
    assert.equal(u.mapping, TONE.agx);
    assert.equal(u.exposure, 4, 'clamped');
  } finally { delete globalThis.location; }
});

test('passthrough match: injected after the output encoding, one shared uniform, fixed key', () => {
  const m = new THREE.MeshStandardMaterial({ name: 'x' });
  assert.ok(applyPassthroughMatch(m));
  assert.ok(isMatched(m));
  const s = stdShader();
  m.onBeforeCompile(s, /** @type {any} */ (null));
  assert.equal(s.uniforms.uPtm, uPtm, 'the shared uniform object');
  const fs = s.fragmentShader;
  assert.ok(fs.indexOf('uniform vec4 uPtm;') > 0);
  assert.ok(fs.indexOf('ptmC') > fs.indexOf('#include <colorspace_fragment>'), 'after colorspace');
  assert.ok(fs.indexOf('ptmC') < fs.indexOf('#include <premultiplied_alpha_fragment>'), 'before premultiplied alpha');
  assert.ok(!s.vertexShader.includes('vPtmH'), 'no contact code without contact');
  assert.ok(m.customProgramCacheKey().endsWith('|' + PTM_KEY));
  assert.equal(m.customProgramCacheKey(), m.customProgramCacheKey());
  assert.ok(applyPassthroughMatch(m), 'idempotent');
  const s2 = stdShader();
  m.onBeforeCompile(s2, /** @type {any} */ (null));
  assert.equal(s2.fragmentShader.split('ptmC = mix').length, 2, 'injected once');
  // two plain materials share the key (no extra program)
  const m2 = new THREE.MeshStandardMaterial();
  applyPassthroughMatch(m2);
  assert.equal(m2.customProgramCacheKey(), m.customProgramCacheKey());
  // uniform values change, the key does not
  uPtm.value.set(0.01, 0.05, 0.8, 3);
  assert.equal(m2.customProgramCacheKey(), m.customProgramCacheKey());
  assert.ok(grainStep(1000) >= 0 && grainStep(1000) !== grainStep(1030));
});

test('passthrough match: contact darkening for the soldier, chained hooks, DepthOcclusion after it', () => {
  const m = new THREE.MeshStandardMaterial({ name: 'soldier' });
  let prevRan = 0;
  m.onBeforeCompile = (sh) => { prevRan++; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float _part;'); };
  m.customProgramCacheKey = () => 'w2-part5';
  assert.ok(applyPassthroughMatch(m, { contact: true }));
  assert.equal(m.customProgramCacheKey(), 'w2-part5|' + PTM_CONTACT_KEY);
  applySoftOcclusion(m);
  const s = stdShader();
  m.onBeforeCompile(s, /** @type {any} */ (null));
  assert.equal(prevRan, 1, 'the earlier hook still runs');
  assert.ok(s.vertexShader.includes('attribute float _part;'), 'its code is kept');
  assert.ok(s.vertexShader.includes('vPtmH = ptmW.y - modelMatrix[ 3 ].y;'));
  assert.ok(s.fragmentShader.indexOf('reflectedLight.indirectDiffuse *= ptmAo') > s.fragmentShader.indexOf('#include <aomap_fragment>'));
  assert.ok(s.fragmentShader.includes('ptmC'), 'colour match too');
  assert.ok(/softocc/i.test(s.fragmentShader) || /uSoftOcc|softOcc/.test(s.fragmentShader), 'DepthOcclusion injected as well');
});

test('passthrough match: UI, transparent, additive and depth-only materials are left alone', () => {
  assert.equal(applyPassthroughMatch(new THREE.MeshBasicMaterial({ toneMapped: false })), false);
  assert.equal(applyPassthroughMatch(new THREE.MeshBasicMaterial()), false, 'unlit');
  assert.equal(applyPassthroughMatch(new THREE.MeshStandardMaterial({ transparent: true })), false);
  assert.equal(applyPassthroughMatch(new THREE.MeshMatcapMaterial({ blending: THREE.AdditiveBlending })), false);
  assert.equal(applyPassthroughMatch(new THREE.MeshStandardMaterial({ colorWrite: false })), false);
  assert.ok(applyPassthroughMatch(new THREE.MeshMatcapMaterial()), 'the watch steel (matcap) is matched');
  const g = new THREE.Group();
  const shared = new THREE.MeshStandardMaterial({ name: 'gun' });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), shared), new THREE.Mesh(new THREE.BoxGeometry(), shared),
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ toneMapped: false })),
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'soldier', roughness: 0.4 })));
  const r = matchMaterials([g, null]);
  assert.equal(r.matched, 2);
  assert.equal(r.skipped, 1);
  assert.equal(tuneMaterials([g]), 2);
  assert.equal(shared.envMapIntensity, 0.9);
  const sold = /** @type {any} */ (g.children[3]).material;
  assert.equal(sold.envMapIntensity, 0.35);
  assert.equal(sold.roughness, 0.7, 'cloth: no sheen');
  assert.ok(sold.customProgramCacheKey().endsWith(PTM_CONTACT_KEY), 'the soldier gets contact darkening');
});

test('contact shadows: a gun resting on the table, frozen; one in the air fades; one on the bed is softer', () => {
  const scene = new THREE.Scene();
  const S = new GroundShadows(scene);
  const P = fakePhys(4);
  S.setWorld(world);
  S.setPhysics(P);
  P.put(0, 1.4, TABLE.y + 0.016, -1.8, [Math.SQRT1_2 * 0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)]); // lying on its side
  S.update(1 / 72, 0, null, null);
  assert.equal(S.mesh.count, 1);
  assert.ok(S.mesh.visible);
  const M = S.mesh.instanceMatrix.array;
  near(M[13], TABLE.y + 0.003, 1e-6, 'on the table top (+3 mm)');
  near(M[4], 0, 1e-9, 'Y axis = the table normal'); near(M[5], 1, 1e-9, 'normal y');
  const C = /** @type {any} */ (S.mesh.instanceColor).array;
  assert.ok(C[0] > 0.4, `contact alpha ${C[0]}`);
  // resting: no more rays
  const rays = S.stats.rays;
  for (let i = 0; i < 100; i++) S.update(1 / 72, i * 14, null, null);
  assert.equal(S.stats.rays, rays, 'frozen while it rests');
  assert.equal(S.mesh.count, 1);
  // it moves: a ray per frame again
  P.put(0, 1.4, TABLE.y + 0.5, -1.8, [0, 0, 0, 1], 1);
  S.update(1 / 72, 0, null, null);
  assert.equal(S.stats.rays, rays + 1);
  assert.equal(S.mesh.count, 0, '0.5 m above the table: no blob');
  P.put(0, 1.4, TABLE.y + 0.25, -1.8, [0, 0, 0, 1], 1);
  S.update(1 / 72, 0, null, null);
  assert.equal(S.mesh.count, 1);
  assert.ok(C[0] < 0.4 && C[0] > 0.01, `fading in the air: ${C[0]}`);
  // on the bed: softer, more pull
  P.put(1, 5.5, BED.y + 0.02, -1.0);
  S.update(1 / 72, 0, null, null);
  assert.equal(S.mesh.count, 2);
  near(M[16 + 13], BED.y + 0.003, 1e-6, 'on the bed');
  assert.ok(C[3 + 1] > 0.6 && C[3 + 2] > 0.02, 'soft and pulled toward the eye');
  assert.ok(isSoftSurface('bed') && isSoftSurface('couch') && !isSoftSurface('table'));
  // gone
  P.st[0] = 0; P.st[1] = 3;
  S.update(1 / 72, 0, null, null);
  assert.equal(S.mesh.count, 0);
  assert.equal(S.mesh.visible, false);
});

test('contact shadows: a standing soldier gets two feet and a body blob; a body on the floor gets its parts', () => {
  const scene = new THREE.Scene();
  const S = new GroundShadows(scene);
  const E = fakeEnemies(2, 1);
  S.setEnemies(E);
  assert.ok(S.footCaps[0] >= 0 && S.footCaps[1] >= 0);
  assert.ok(S.deadCaps.length >= 8);
  S.update(1 / 72, 0, null, null);
  assert.equal(S.mesh.count, 3, 'two feet and the body');
  const M = S.mesh.instanceMatrix.array;
  for (let i = 0; i < 3; i++) {
    near(M[i * 16 + 13], 0.003, 1e-6, `blob ${i} on his floor`);
    assert.ok(Math.hypot(M[i * 16 + 12] - 2, M[i * 16 + 14] - 1) < 0.6, `blob ${i} under him`);
  }
  // dead and lying
  const an = E.anims[0];
  an.die(0, 1, false);
  for (let i = 0; i < 300; i++) an.update(1 / 60);
  E.hitboxes[0].update(an);
  S.update(1 / 72, 0, null, null);
  assert.ok(S.mesh.count >= 6, `a body casts per part (${S.mesh.count})`);
});

test('contact shadows: update allocates nothing', () => {
  const scene = new THREE.Scene();
  const S = new GroundShadows(scene);
  const P = fakePhys(8);
  S.setWorld(world);
  S.setPhysics(P);
  S.setEnemies(fakeEnemies(2, 1));
  P.put(0, 1.4, TABLE.y + 0.016, -1.8);
  P.put(1, 0, 0.3, 0, [0, 0, 0, 1], 1);
  const frame = (i) => { P.cur[7 + 1] = 0.2 + (i % 50) * 0.002; S.update(1 / 72, i * 14, null, null); };
  for (let i = 0; i < 3000; i++) frame(i);
  let grew = Infinity;
  for (let rep = 0; rep < 4 && grew > 50_000; rep++) {
    globalThis.gc?.();
    const b = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) frame(i);
    grew = Math.min(grew, process.memoryUsage().heapUsed - b);
  }
  assert.ok(grew < 50_000, `heap grew ${grew} B over 20k frames`);
});

test('impacts: plaster, couch, bed, table and the floor setting; decals ring; particles die; sounds from the bank', () => {
  const scene = new THREE.Scene();
  const played = [];
  const audio = { play: (k, x, y, z, g, r) => { played.push([k, g, r]); return 1; } };
  const I = new Impacts(scene, { decalMax: 8, particleMax: 40 });
  I.world = world;
  I.audio = audio;
  const hit = { x: 0, y: 1.2, z: -3, nx: 0, ny: 0, nz: 1, surface: 'wall' };
  assert.equal(I.impact(hit, 0, 0, -1), IMP.PLASTER);
  assert.equal(I.decals.count, 1);
  assert.ok(I.decals.visible);
  assert.equal(played[0][0], 'impactWall');
  const M = I.decals.instanceMatrix.array;
  near(M[8], 0, 1e-9, 'decal Z axis = the wall normal'); near(M[10], 1, 1e-9, 'normal z');
  near(M[14], -3 + 0.002, 1e-6, 'lifted 2 mm');
  const size = Math.hypot(M[0], M[1], M[2]);
  assert.ok(size >= 0.05 && size <= 0.075, `plaster decal ${size} m`);
  assert.ok(I.live > 0);
  I.update(1 / 72, 0, null, null);
  assert.ok(I.parts.visible && I.parts.count > 0);
  hit.surface = 'couch'; hit.nx = 0; hit.ny = 1; hit.nz = 0; hit.y = 0.45;
  assert.equal(I.impact(hit, 0, -0.7, -0.7), IMP.COUCH);
  assert.equal(played.at(-2)[0], 'impactFlesh');
  hit.surface = 'bed';
  assert.equal(I.impact(hit, 0, -1, 0), IMP.BED);
  hit.surface = 'table';
  assert.equal(I.impact(hit, 0, -1, 0, 'akm'), IMP.WOOD);
  hit.surface = 'floor'; hit.y = 0;
  I.floorKind = 'carpet';
  assert.equal(I.impact(hit, 0, -1, 0), IMP.FLOOR_CARPET);
  // a normal facing away from the shooter is flipped
  assert.equal(I.impact({ x: 0, y: 1, z: -3, nx: 0, ny: 0, nz: -1, surface: 'wall' }, 0, 0, -1), IMP.PLASTER);
  near(I.decals.instanceMatrix.array[5 * 16 + 10], 1, 1e-9, 'flipped toward the shooter');
  // the ring wraps
  for (let i = 0; i < 10; i++) I.impact({ x: i * 0.1, y: 1, z: -3, nx: 0, ny: 0, nz: 1, surface: 'wall' }, 0, 0, -1);
  assert.equal(I.decals.count, 8);
  assert.equal(I.impact({ x: NaN, y: 1, z: -3, nx: 0, ny: 0, nz: 1, surface: 'wall' }, 0, 0, -1), -1);
  // particles fall, stop at the floor and die within their life (feathers ≤ 4 s)
  let minY = Infinity;
  for (let f = 0; f < 72 * 5; f++) {
    I.update(1 / 72, f * 14, null, null);
    for (let i = 0; i < I.particleMax; i++) if (I.age[i] >= 0 && I.age[i] < I.life[i] && I.py[i] < minY) minY = I.py[i];
  }
  assert.ok(minY >= 0, `nothing sinks through the floor (${minY})`);
  assert.equal(I.live, 0);
  assert.equal(I.parts.visible, false);
  const rep = I.report();
  assert.equal(rep.byKind.plaster, 12);
  assert.equal(JSON.parse(JSON.stringify(rep)).floor, 'carpet');
  I.clear();
  assert.equal(I.decals.count, 0);
});

test('impacts: frames allocate nothing; a hit allocates only at the sound call', () => {
  const scene = new THREE.Scene();
  const I = new Impacts(scene);
  I.world = world;
  I.audio = { play: () => 1 };
  const t0 = performance.now();
  I.warmUp();
  const warmMs = performance.now() - t0;
  assert.ok(warmMs < 400, `warm-up ${warmMs.toFixed(1)} ms`);
  assert.equal(I.decals.count, 0, 'the warm-up leaves nothing behind');
  assert.equal(I.stats.impacts, 0);
  const hit = { x: 0, y: 1.2, z: -3, nx: 0, ny: 0, nz: 1, surface: 'wall' };
  const labels = ['wall', 'couch', 'bed', 'table', 'screen', 'wall art', 'floor', 'ceiling', 'door'];
  let k = 0;
  const shoot = () => { hit.surface = labels[k++ % labels.length]; I.impact(hit, 0, 0, -1, k % 2 ? 'akm' : 'glock'); };
  // frames with particles flying (a burst every 0.4 s keeps the pool busy)
  const frame = (i) => { if (i % 29 === 0) shoot(); I.update(1 / 72, i * 14, null, null); };
  for (let i = 0; i < 5000; i++) frame(i);
  let grew = Infinity;
  for (let rep = 0; rep < 6 && grew > 60_000; rep++) {
    globalThis.gc?.();
    const b = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) frame(i);
    grew = Math.min(grew, process.memoryUsage().heapUsed - b);
  }
  assert.ok(grew < 60_000, `heap grew ${grew} B over 20k frames with ~690 hits`);
  // hits alone (the audio call takes doubles: the one boundary that may box)
  let per = Infinity;
  for (let rep = 0; rep < 6 && per > 120; rep++) {
    globalThis.gc?.();
    const b = process.memoryUsage().heapUsed;
    for (let i = 0; i < 3000; i++) shoot();
    per = Math.min(per, (process.memoryUsage().heapUsed - b) / 3000);
  }
  assert.ok(per < 120, `${per.toFixed(1)} B per hit`);
});

test('room light: auto per room with a window, manual presets saved per house and found again next session', async () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const mk = () => {
    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xf3efe8, 0x2c2722, 0.9);
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.1);
    sun.position.set(0.3, 1, 0.6);
    scene.environmentIntensity = 0.55;
    return { scene, hemi, sun, rl: new RoomLight({ scene, hemi, sun, storage, hour: 13 }) };
  };
  const snapshot = {
    planes: [
      { label: 'floor', orientation: 'horizontal', pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], polygon: [[-2, -3], [3, -3], [3, 1], [-2, 1]] },
      { label: 'wall', orientation: 'vertical', pose: new Array(16).fill(0), polygon: [] },
      // a window on the bedroom's far wall (x = 6.6), its normal pointing into the room (−x)
      { label: 'window frame', orientation: 'vertical', pose: [0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 6.6, 1.4, -1.5, 1], polygon: [] },
    ],
  };
  const A = mk();
  A.rl.setHouse(world, snapshot);
  assert.equal(A.rl.roomWindow[2], 1, 'the bedroom has the window');
  assert.equal(A.rl.roomWindow[1], 0);
  assert.ok(A.rl.roomKey[2 * 3] > 0.5, 'its key light comes from +x (the window)');
  const ctx = { world, player: { head: { x: 0, y: 1.6, z: 0 } }, camera: null };
  world.playerRoom = 1;
  for (let i = 0; i < 400; i++) A.rl.update(1 / 72, i * 14, null, ctx);
  const livingHemi = A.hemi.intensity;
  world.playerRoom = 2;
  for (let i = 0; i < 72 * 12; i++) A.rl.update(1 / 72, 6000 + i * 14, null, ctx);
  assert.ok(A.hemi.intensity > livingHemi, `the room with a window is brighter by day (${A.hemi.intensity} vs ${livingHemi})`);
  assert.ok(A.sun.position.x > 0, 'the sun moved toward the window');
  const dYaw = Math.atan2(Math.sin(A.scene.environmentRotation.y - envYawFor(1, 0)), Math.cos(A.scene.environmentRotation.y - envYawFor(1, 0)));
  near(dYaw, 0, 0.05, 'env window panel turned toward the real window');
  // manual: dim the bedroom, bright the living room
  A.rl.cycleLevel(); // auto → dim (bedroom)
  assert.equal(A.rl.preset().level, 'dim');
  world.playerRoom = 1;
  A.rl.update(1 / 72, 20000, null, ctx);
  A.rl.setRoomPreset(1, LEVEL_BRIGHT, 3);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.get('cqcpt.roomlight.v1'), 'saved from a setTimeout');
  // next session: the room ids swap (another flood-fill order); the presets follow the rooms
  const B = mk();
  const swapped = { ...world, roomAt: (x) => (x > 3.05 ? 1 : 2), roamIndex: { roomCount: 2, roomCells: Uint32Array.from([0, 1050, 2000]) } };
  B.rl.setHouse(swapped, snapshot);
  assert.equal(B.rl.roomLevel[1], LEVEL_DIM, 'the bedroom (now id 1) is still dim');
  assert.equal(B.rl.roomLevel[2], LEVEL_BRIGHT, 'the living room (now id 2) is still bright');
  assert.ok(matchRoom({ 'a20|couch,table': [1, 1] }, 'a22|couch,table'), 'area within 3 m²');
  assert.equal(matchRoom({ 'a20|couch,table': [1, 1] }, 'a20|bed'), null);
  // levels only: the light count and program-relevant state never change
  assert.equal(A.scene.children.length, 0);
  const rep = JSON.parse(JSON.stringify(A.rl.report()));
  assert.equal(rep.rooms, 3);
  assert.equal(rep.camera.on, false);
});

test('room light: env yaw maps the env window panel onto the real window', () => {
  for (const [wx, wz] of [[1, 0], [0, 1], [-1, 0], [0.6, -0.8]]) {
    const yaw = envYawFor(wx, wz);
    // three samples the env along transpose(R) · worldDir: the panel (env −x) appears at R · (−1, 0, 0)
    const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, yaw, 0));
    const v = new THREE.Vector3(-1, 0, 0).applyMatrix4(R);
    near(v.x, wx, 1e-9, `x for ${wx},${wz}`);
    near(v.z, wz, 1e-9, `z for ${wx},${wz}`);
  }
});

test('room light: camera off in Node (no API), worker stats used only when the head was still', async () => {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9), sun = new THREE.DirectionalLight(0xffffff, 1.1);
  const rl = new RoomLight({ scene, hemi, sun, hour: 12 });
  const r = await rl.requestCamera();
  assert.equal(r.ok, false);
  assert.equal(rl.camera.on, false);
  // pretend it is on: a still head, a dim frame's stats → used; a fast turn → skipped
  rl.camera.on = true;
  const q = new THREE.Quaternion();
  for (let i = 0; i < 20; i++) { rl.now = i * 14; rl.trackHead(q); }
  const stats = new Float64Array(15);
  stats.set([0.03, 0.025, 0.018, 0.004, 0.03, 0.08, 0.1, 0.08, 0.05, 0.01, 0.5, 0.5, 0.03, 700, 1]);
  rl.onWorker({ id: 1, capture: 250, stats, ms: 0.2 });
  assert.equal(rl.camera.used, 1);
  assert.ok(rl.camValid && rl.camTarget[0] < 0.5, 'a dim camera frame → a dim target');
  const turn = new THREE.Quaternion();
  for (let i = 0; i < 20; i++) { rl.now = 1000 + i * 14; rl.trackHead(turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 0.05)); }
  rl.onWorker({ id: 2, capture: 1200, stats, ms: 0.2 });
  assert.equal(rl.camera.skipped, 1, 'skipped while turning (≈ 200°/s)');
  rl.update(1 / 72, 2000, null, { world: null, player: null, camera: null });
  assert.ok(rl.smoother.goal[0] < 0.5, 'the camera target wins over the preset');
  rl.stopCamera();
  assert.equal(rl.camera.on, false);
});

test('room light: bad frame times never reach the lights', () => {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9), sun = new THREE.DirectionalLight(0xffffff, 1.1);
  const rl = new RoomLight({ scene, hemi, sun, hour: 12 });
  const snapshot = { planes: [{ label: 'window', pose: [0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 6.6, 1.4, -1.5, 1] }] };
  rl.setHouse(world, snapshot);
  world.playerRoom = 2;
  const ctx = { world, player: { head: { x: 5, y: 1.6, z: -1 } }, camera: null };
  for (const dt of [NaN, -1, Infinity, 1 / 72, 1e9, 0]) rl.update(dt, dt === Infinity ? NaN : 100, null, ctx);
  for (const v of [hemi.intensity, sun.intensity, sun.position.x, sun.position.y, sun.position.z, hemi.color.r, scene.environmentIntensity, scene.environmentRotation.y, uPtm.value.x, uPtm.value.y, uRoomLight.value.x]) {
    assert.ok(Number.isFinite(v), `finite (${v})`);
  }
  world.playerRoom = 1;
});

test('room light: update allocates nothing', () => {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9), sun = new THREE.DirectionalLight(0xffffff, 1.1);
  const rl = new RoomLight({ scene, hemi, sun, hour: 12 });
  rl.setHouse(world, null);
  const ctx = { world, player: { head: { x: 0, y: 1.6, z: 0 } }, camera: null };
  const frame = (i) => { world.playerRoom = (i / 400 | 0) % 2 + 1; rl.update(1 / 72, i * 14, null, ctx); };
  for (let i = 0; i < 5000; i++) frame(i);
  let grew = Infinity;
  for (let rep = 0; rep < 4 && grew > 50_000; rep++) {
    globalThis.gc?.();
    const b = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) frame(i);
    grew = Math.min(grew, process.memoryUsage().heapUsed - b);
  }
  assert.ok(grew < 50_000, `heap grew ${grew} B over 20k frames`);
});

test('Look: pools for the warm-up, URL switches, the facade routes impacts, a JSON report', () => {
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9), sun = new THREE.DirectionalLight(0xffffff, 1.1);
  const look = new Look({ scene, hemi, sun, search: '?sat=0.85', hour: 20 });
  assert.equal(uPtm.value.z, 0.85);
  const w = look.warmMeshes();
  assert.equal(w.length, 3);
  for (const m of w) assert.equal(m.parent, scene);
  assert.equal(look.textures().length, 1);
  look.setWarm(true);
  for (const m of w) assert.ok(m.visible && /** @type {any} */ (m).count >= 1, `${m.name} drawn by the warm-up`);
  look.setWarm(false);
  for (const m of w) assert.equal(m.visible, false);
  look.attach({ world, physics: fakePhys(2), enemies: null, weapons: null, audio: { play: () => 1 } });
  look.onWorldBuilt(world, null);
  assert.equal(look.impact({ x: 0, y: 1, z: -3, nx: 0, ny: 0, nz: 1, surface: 'door' }, 0, 0, -1, 'glock'), IMP.DOOR);
  look.update(1 / 72, 0, null, { world, player: { head: { x: 0, y: 1.6, z: 0 } }, camera: null });
  assert.ok(uRoomLight.value.x > 0 && uRoomLight.value.x < 1.5);
  assert.equal(look.setFloor('tile'), 'tile');
  assert.equal(look.impacts.floorKind, 'tile');
  const rep = JSON.parse(JSON.stringify(look.report()));
  assert.equal(rep.impacts.byKind.door, 1);
  look.reset();
  assert.equal(look.impacts.decals.count, 0);
  assert.deepEqual(lookFromSearch('?shadows=0&impacts=0&match=0&sat=3'), { saturation: 1.2, shadows: false, impacts: false, match: false });
  const off = new Look({ scene, hemi, sun, search: '?impacts=0' });
  assert.equal(off.impact({ x: 0, y: 1, z: -3, nx: 0, ny: 0, nz: 1, surface: 'wall' }, 0, 0, -1), -1);
  uPtm.value.z = 0.92;
});
