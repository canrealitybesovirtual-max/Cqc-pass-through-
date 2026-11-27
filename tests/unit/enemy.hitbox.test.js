// Enemy hit capsules (src/enemies/Hitbox.js): the ray maths, part lookup on the
// real soldier rig (from assets/models/soldier.glb's JSON), and no allocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RigDef, jointsFromGltfJson, B } from '../../src/enemies/Rig.js';
import { Animator } from '../../src/enemies/Animator.js';
import { CapsuleSet, Hitbox, PARTS, rayCapsule, raySphere } from '../../src/enemies/Hitbox.js';

function loadRig() {
  const buf = readFileSync(new URL('../../assets/models/soldier.glb', import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const man = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')).soldier;
  return new RigDef(jointsFromGltfJson(json), man);
}
const rig = loadRig();

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('rayCapsule: side, caps, parallel, miss, inside', () => {
  // vertical capsule from (0,0,0) to (0,1,0), r 0.1
  near(rayCapsule(-1, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), 0.9, 1e-9, 'side hit');
  assert.equal(rayCapsule(-1, 1.2, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), -1, 'passes over the top cap');
  near(rayCapsule(-1, 1.05, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), 1 - Math.sqrt(0.1 * 0.1 - 0.05 * 0.05), 1e-9, 'top cap sphere');
  near(rayCapsule(0, 3, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0.1), 1.9, 1e-9, 'down the axis onto the top cap');
  assert.equal(rayCapsule(-1, 0.5, 0.2, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), -1, 'beside it');
  assert.equal(rayCapsule(0, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), -1, 'origin inside');
  assert.equal(rayCapsule(1, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0.1), -1, 'pointing away');
  near(raySphere(-2, 0, 0, 1, 0, 0, 0, 0, 0, 0.5), 1.5, 1e-9, 'sphere entry');
  assert.equal(raySphere(0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5), 0, 'inside the sphere = 0');
  assert.equal(raySphere(2, 0, 0, 1, 0, 0, 0, 0, 0, 0.5), -1, 'sphere behind');
});

/** A soldier standing at (x, 0, z) facing yaw, posed by the animator. */
function standing(x, z, yaw, raise = 0) {
  const a = new Animator(rig, 3);
  a.reset(x, 0, z, yaw);
  a.aimX = x + Math.sin(yaw) * 6; a.aimY = 1.4; a.aimZ = z + Math.cos(yaw) * 6;
  a.raiseTarget = raise;
  for (let i = 0; i < 60; i++) a.update(1 / 60);
  const h = new Hitbox(new CapsuleSet(rig));
  h.update(a);
  return { a, h };
}

test('parts by height on a standing soldier, from in front', () => {
  const { h } = standing(0, 0, 0); // faces +Z; shoot from +Z toward −Z
  const shoot = (x, y) => { const t = h.raycast(x, y, 3, 0, 0, -1, 10); return t < 0 ? 'miss' : PARTS[h.hitPart]; };
  assert.equal(shoot(0, 1.72), 'head');
  assert.equal(shoot(0, 1.4), 'torso');
  assert.equal(shoot(0, 1.3), 'torso');
  assert.equal(shoot(0, 1.17), 'limb', 'his forearms are in front of the belly at low ready');
  assert.equal(shoot(0, 0.9), 'pelvis');
  assert.equal(shoot(0.12, 0.6), 'limb', 'left thigh');
  assert.equal(shoot(-0.12, 0.3), 'limb', 'right calf');
  assert.equal(shoot(0, 2.0), 'miss', 'over his head');
  assert.equal(shoot(0.5, 1.2), 'miss', 'beside him (rifle at low ready is not a body part)');
  assert.equal(shoot(0, 0.35), 'miss', 'between the legs');
  // the neck from the side, below the jaw
  const tn = h.raycast(-2, 1.585, -0.05, 1, 0, 0, 5);
  assert.ok(tn > 0 && (PARTS[h.hitPart] === 'neck' || PARTS[h.hitPart] === 'head'), `neck from the side: ${PARTS[h.hitPart]}`);
});

test('hit distance, normal and the quick reject', () => {
  const { h } = standing(1, -2, Math.PI / 2); // faces +X
  // from +X, chest height: the chest surface is ~0.15 m in front of the spine
  const t = h.raycast(4, 1.35, -2, -1, 0, 0, 10);
  assert.ok(t > 2.7 && t < 2.95, `chest hit at ${t}`);
  assert.ok(h.nx > 0.7, `normal faces the shooter: ${h.nx}`);
  assert.equal(h.raycast(4, 1.35, -2, -1, 0, 0, 2.5), -1, 'max distance respected');
  assert.equal(h.raycast(4, 1.35, -2, 1, 0, 0, 10), -1, 'pointing away');
  assert.equal(h.raycast(4, 1.35, 0, -1, 0, 0, 10), -1, '2 m to the side');
  h.valid = false;
  assert.equal(h.raycast(4, 1.35, -2, -1, 0, 0, 10), -1, 'invalid hitbox never hits');
});

test('capsules stay within the measured body (rest pose)', () => {
  const { a, h } = standing(0, 0, 0);
  const n = h.set.count;
  let top = -Infinity, bottom = Infinity;
  for (let i = 0; i < n; i++) {
    const r = h.set.radius[i];
    for (const E of [h.a, h.b]) { top = Math.max(top, E[i * 3 + 1] + r); bottom = Math.min(bottom, E[i * 3 + 1] - r); }
  }
  assert.ok(top <= rig.height + 0.03, `top of the head capsule ${top} vs mesh ${rig.height}`);
  assert.ok(bottom >= -0.02, `nothing below the floor: ${bottom}`);
  // head capsule centre near the skull centre (mesh: y 1.59–1.87, z −0.13…0.13)
  const o = 0;
  const cy = (h.a[o + 1] + h.b[o + 1]) / 2 + (rig.restModelP[B.head].y - a.mp[B.head].y); // as if at full height
  assert.ok(cy > 1.68 && cy < 1.8, `head centre ${cy}`);
});
