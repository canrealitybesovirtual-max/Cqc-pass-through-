// v0.4.1, the user: "their height". The soldier model is 1.868 m (helmet and boots included); every enemy now
// gets a height of 1.70–1.85 m at spawn, applied as one scale about his root: the animator converts world ↔
// model through it (feet, aim point, hit point, muzzle), the hit capsules scale with it, and his feet stay on
// the floor under him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RigDef, jointsFromGltfJson, B } from '../../src/enemies/Rig.js';
import { Animator } from '../../src/enemies/Animator.js';
import { CapsuleSet, Hitbox } from '../../src/enemies/Hitbox.js';
import { Brain } from '../../src/enemies/Brain.js';
import { V3, Rng } from '../../src/enemies/math.js';
import { register } from 'node:module';

// EnemyManager pulls in three (EnemyPool): resolve it to the vendored r187, as enemy.warmup.test.js does
const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
const addonsUrl = new URL('../../vendor/three/addons/', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) {
    if (s === 'three') return { url: ${JSON.stringify(threeUrl)}, shortCircuit: true };
    if (s.startsWith('three/addons/')) return { url: ${JSON.stringify(addonsUrl)} + s.slice(13), shortCircuit: true };
    return next(s, c);
  }`,
));
const { EnemyManager, ENEMY } = await import('../../src/enemies/EnemyManager.js');

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}
const def = loadRig();
const FLOOR = -1.51; // the user's living room floor (unbounded space: the floor is below the origin)

/** world y of the top of the head capsule and the lowest foot capsule point */
function extents(hb, caps) {
  let top = -Infinity, low = Infinity;
  for (let i = 0; i < caps.count; i++) {
    const r = caps.radius[i] * hb.k;
    for (const E of [hb.a, hb.b]) {
      top = Math.max(top, E[i * 3 + 1] + r);
      low = Math.min(low, E[i * 3 + 1] - r);
    }
  }
  return { top, low };
}

test('a scaled soldier stands on the floor: ankles at k × ankle height, the head at k × the model head', () => {
  const caps = new CapsuleSet(def);
  const ref = new Animator(def, 5), an = new Animator(def, 5);
  const k = 1.75 / def.height;
  an.k = k;
  ref.reset(2, FLOOR, 3, 0.4);
  an.reset(2, FLOOR, 3, 0.4);
  for (let f = 0; f < 72; f++) { ref.update(1 / 72); an.update(1 / 72); }
  const v = new V3(), w = new V3();
  for (const b of [B.head, B.pelvis, B.footL, B.footR, B.handR]) {
    an.toWorld(an.mp[b], v);
    ref.toWorld(ref.mp[b], w);
    assert.ok(Math.abs((v.y - FLOOR) - k * (w.y - FLOOR)) < 0.005, `bone ${b}: ${(v.y - FLOOR).toFixed(3)} vs ${(k * (w.y - FLOOR)).toFixed(3)}`);
  }
  for (const b of [B.footL, B.footR]) {
    an.toWorld(an.mp[b], v);
    assert.ok(Math.abs(v.y - FLOOR - k * def.ankleY) < 0.01, `ankle ${(v.y - FLOOR).toFixed(3)} m over the floor`);
  }
  const hb = new Hitbox(caps), hr = new Hitbox(caps);
  hb.update(an); hr.update(ref);
  assert.equal(hb.k, k);
  const e = extents(hb, caps), er = extents(hr, caps);
  assert.ok(Math.abs((e.top - FLOOR) - k * (er.top - FLOOR)) < 0.01, `head capsule top ${(e.top - FLOOR).toFixed(3)}`);
  assert.ok(e.top - FLOOR > 1.6 && e.top - FLOOR < 1.76, `standing head ${(e.top - FLOOR).toFixed(3)} m (1.75 m soldier, knees soft)`);
  assert.ok(Math.abs(e.low - FLOOR) < 0.04, `feet on the floor: ${(e.low - FLOOR).toFixed(3)}`);
  // the head is hit where it is drawn: a ray at the scaled head height hits the head capsule
  an.toWorld(an.mp[B.head], v);
  const t = hb.raycast(v.x + 4, v.y + 0.06 * k, v.z, -1, 0, 0, 10);
  assert.ok(t > 0 && hb.hitPart === 0, `head hit ${t} part ${hb.hitPart}`);
  // and the unscaled head height above it now misses (he is 12 cm shorter)
  ref.toWorld(ref.mp[B.head], w);
  assert.equal(hb.raycast(w.x + 4, w.y + 0.1 + 0.06, w.z, -1, 0, 0, 10) > 0 && hb.hitPart === 0, false);
});

test('a scaled soldier walks with planted feet that never slide (world ↔ model through k)', () => {
  const an = new Animator(def, 9);
  an.k = 1.7 / def.height;
  an.reset(0, FLOOR, 0, 0);
  const v = new V3();
  /** @type {(number[]|null)[]} */ const plant = [null, null];
  let maxSlide = 0, steps = 0;
  for (let f = 0; f < 72 * 4; f++) {
    an.vx = 0.6 * Math.sin(f / 90); an.vz = 0.9;
    an.rootX += an.vx / 72; an.rootZ += an.vz / 72;
    an.rootYaw = Math.atan2(an.vx, an.vz);
    an.update(1 / 72);
    for (let ft = 0; ft < 2; ft++) {
      const F = an.feet[ft];
      an.toWorld(an.mp[ft === 0 ? B.ballL : B.ballR], v);
      if (F.planted && F.landT > 0.15 && an.footPitch[ft] === 0) {
        if (!plant[ft]) { plant[ft] = [v.x, v.z]; steps++; }
        else maxSlide = Math.max(maxSlide, Math.hypot(v.x - plant[ft][0], v.z - plant[ft][1]));
      } else plant[ft] = null;
    }
  }
  assert.ok(steps > 6, `steps ${steps}`);
  assert.ok(maxSlide < 0.02, `planted feet slide ${maxSlide.toFixed(3)} m`);
});

test('EnemyManager.spawn: every soldier 1.70–1.85 m, varied, the rig, animator and capsules on the same scale', () => {
  assert.equal(ENEMY.heightMin, 1.7);
  assert.equal(ENEMY.heightMax, 1.85);
  const n = 6, caps = new CapsuleSet(def);
  const rigs = [];
  for (let i = 0; i < n; i++) rigs.push({ k: 1, root: { visible: false }, apply() {}, setScale(k) { this.k = k; }, setRoot() {} });
  const world = { nav: null, floorY: () => FLOOR };
  const brain = new Brain({ maxEnemies: n, seed: 1 });
  brain.attach(world, null);
  const fake = Object.assign(Object.create(EnemyManager.prototype), {
    max: n, brain, world, def, pool: { rigs }, anims: rigs.map((_, i) => new Animator(def, 3 + i)), hitboxes: rigs.map(() => new Hitbox(caps)),
    tier: new Uint8Array(n), health: new Float32Array(n), legHit: new Uint8Array(n), gruntT: new Float32Array(n), spawnOrder: new Float64Array(n),
    lodAcc: new Float32Array(n), order: 0, height: new Float32Array(n), scale: new Float32Array(n), sizeRng: new Rng(77),
    stats: { spawned: 0, spawnDirect: 0, spawnBehind: 0, spawnHiddenRoom: 0, spawnHiddenDoor: 0, spawnInView: 0, lastSpawnTier: 0, heightMin: 0, heightMax: 0 },
  });
  const seen = new Set();
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < n; i++) {
      fake.brain.agents[i].active = false;
      const e = fake.spawn(i * 1.5, 2, 0);
      assert.equal(e, i);
      const h = fake.height[e], k = fake.scale[e];
      assert.ok(h >= 1.7 && h <= 1.85, `height ${h}`);
      assert.ok(Math.abs(k - h / def.height) < 1e-6);
      assert.ok(Math.abs(rigs[e].k - k) < 1e-6, 'the rig is scaled');
      assert.equal(fake.anims[e].k, rigs[e].k, 'the animator converts through the same scale');
      assert.equal(fake.anims[e].rootY, FLOOR, 'his root (feet) on the floor under him');
      assert.equal(fake.hitboxes[e].k, rigs[e].k, 'the hit capsules follow');
      seen.add(Math.round(h * 100));
    }
  }
  assert.ok(seen.size >= 8, `varied heights: ${[...seen].join(' ')}`);
  assert.ok(fake.stats.heightMin >= 1.7 && fake.stats.heightMax <= 1.85 && fake.stats.heightMax - fake.stats.heightMin > 0.08);
});
