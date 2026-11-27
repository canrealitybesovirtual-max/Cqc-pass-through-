/**
 * v0.4 verifier: EnemyManager.warmUp() (the soldiers' JIT warm-up at load) runs the real per-frame
 * code (Animator at both rates, alive and both deaths, the pose copy, the hit capsules and their
 * raycast) on one spare rig and leaves it as it found it: reset, hidden, hitbox invalid.
 * EnemyManager needs the skinned soldier from the GLB, so the method runs on a stand-in with the
 * real Animator and Hitbox (three and its addons resolved to the vendored r187).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
const addonsUrl = new URL('../../vendor/three/addons/', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) {
    if (s === 'three') return { url: ${JSON.stringify(threeUrl)}, shortCircuit: true };
    if (s.startsWith('three/addons/')) return { url: ${JSON.stringify(addonsUrl)} + s.slice(13), shortCircuit: true };
    return next(s, c);
  }`,
));

const { EnemyManager } = await import('../../src/enemies/EnemyManager.js');
const { RigDef, jointsFromGltfJson } = await import('../../src/enemies/Rig.js');
const { Animator } = await import('../../src/enemies/Animator.js');
const { CapsuleSet, Hitbox } = await import('../../src/enemies/Hitbox.js');

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}

test('enemy warm-up: walks, aims, dies both ways through the real frame code, then leaves the spare rig reset and hidden', () => {
  const def = loadRig();
  const caps = new CapsuleSet(def);
  const n = 3;
  const anims = [], hitboxes = [], rigs = [];
  for (let i = 0; i < n; i++) {
    anims.push(new Animator(def, 7 + i));
    hitboxes.push(new Hitbox(caps));
    rigs.push({ applied: 0, deadSeen: 0, root: { visible: false }, apply(an) { this.applied++; if (an.dead) this.deadSeen++; }, setRoot() {} });
  }
  let rays = 0;
  const hb = hitboxes[n - 1], ray = hb.raycast.bind(hb);
  hb.raycast = (...a) => { rays++; return ray(...a); };
  const fake = { max: n, anims, hitboxes, pool: { rigs } };
  const ms = EnemyManager.prototype.warmUp.call(fake, 120);
  assert.ok(ms >= 0 && Number.isFinite(ms), `ms ${ms}`);
  const r = rigs[n - 1], an = anims[n - 1];
  assert.ok(r.applied >= 120 + 2 * 60, `pose copies ${r.applied}`);
  assert.ok(r.deadSeen >= 2 * 60, `death frames ${r.deadSeen}`);
  assert.ok(rays >= 2 * (120 + 120), `hit-capsule rays ${rays}`);
  // left as found: standing at the origin, not dead, hitbox invalid, hidden; the other rigs untouched
  assert.equal(an.dead, false);
  assert.equal(an.rootX, 0);
  assert.equal(an.rootZ, 0);
  assert.equal(hb.valid, false);
  assert.equal(r.root.visible, false);
  for (let i = 0; i < n - 1; i++) assert.equal(rigs[i].applied, 0);
  // a rig that was visible (the GPU warm-up's row) stays visible
  r.root.visible = true;
  EnemyManager.prototype.warmUp.call(fake, 40);
  assert.equal(r.root.visible, true);
});
