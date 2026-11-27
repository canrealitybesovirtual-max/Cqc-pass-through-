/**
 * v0.4 verifier: a pause hides the enemies and the loose magazines under
 * GameSession's safety veil; their contact shadows must go with them (the
 * headless watch-menu screenshot showed dark blobs on the floor where the
 * soldiers and a dropped magazine had been). Lying guns stay in view, and
 * keep their shadow. Real three r187 (resolve hook, as in fx.three.test.js).
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
const { GroundShadows } = await import('../../src/fx/GroundShadows.js');
const { RigDef, jointsFromGltfJson } = await import('../../src/enemies/Rig.js');
const { Animator } = await import('../../src/enemies/Animator.js');
const { CapsuleSet, Hitbox } = await import('../../src/enemies/Hitbox.js');
const { K_GLOCK, K_MAG9 } = await import('../../src/physics/ItemShapes.js');

/** Floor at y 0 everywhere (downward rays only). */
const world = {
  built: true,
  raycast(ox, oy, oz, dx, dy, dz, max, out) {
    if (!(dy < -0.5)) return false;
    const t = oy / -dy;
    if (!(t >= 0 && t <= max)) return false;
    out.dist = t; out.x = ox + dx * t; out.y = 0; out.z = oz + dz * t; out.nx = 0; out.ny = 1; out.nz = 0; out.surface = 'floor';
    return true;
  },
  floorY() { return 0; },
};

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}

test('contact shadows: a paused round (the veil hidden) shows no enemy or loose-magazine blob; a lying gun keeps its own', () => {
  const scene = new THREE.Scene();
  const veil = new THREE.Group();
  scene.add(veil);
  // one standing soldier, shaped like EnemyManager (its rig root under the veil)
  const def = loadRig();
  const an = new Animator(def, 5);
  an.reset(2, 0, 1, 0);
  for (let i = 0; i < 60; i++) an.update(1 / 60);
  const hb = new Hitbox(new CapsuleSet(def));
  hb.update(an);
  const root = new THREE.Group();
  veil.add(root);
  const enemies = { max: 1, brain: { agents: [{ active: true, alive: true }] }, anims: [an], hitboxes: [hb], capsules: hb.set || new CapsuleSet(def), pool: { rigs: [{ root }] } };
  // a fake physics world: a lying Glock and a loose magazine on the floor; the magazine pool lives under the veil
  const kinds = [];
  kinds[K_GLOCK] = { centre: [0, -0.02, -0.05], half: [0.016, 0.07, 0.1] };
  kinds[K_MAG9] = { centre: [0, -0.06, 0], half: [0.012, 0.065, 0.016] };
  const P = { maxItems: 4, st: new Uint8Array(4), cur: new Float64Array(28), kindOf: new Int16Array(4).fill(-1), kinds };
  P.st[0] = 2; P.kindOf[0] = K_GLOCK; P.cur.set([0, 0.03, 0, 0, 0, 0, 1], 0);
  P.st[1] = 2; P.kindOf[1] = K_MAG9; P.cur.set([0.5, 0.08, 0, 0, 0, 0, 1], 7);
  const worldRoot = new THREE.Group();
  veil.add(worldRoot);
  const S = new GroundShadows(scene);
  S.setWorld(world);
  S.setPhysics(P);
  S.setEnemies(enemies);
  S.weapons = { worldRoot, weapons: [] };

  S.update(1 / 72, 0, null, null);
  const all = S.mesh.count;
  assert.equal(all, 5, `two feet + body, the gun and the magazine (${all})`);

  veil.visible = false; // GameSession: paused, threats hidden
  S.update(1 / 72, 14, null, null);
  assert.equal(S.mesh.count, 1, `paused: only the lying gun keeps its blob (${S.mesh.count})`);

  veil.visible = true;
  S.update(1 / 72, 28, null, null);
  assert.equal(S.mesh.count, all, 'resumed: every blob is back (the magazine\'s frozen record reused)');
});
