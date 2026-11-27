/**
 * Enemy hit puffs (src/enemies/HitPuff.js) with the real three r187 classes:
 * one instanced draw, everything a program depends on fixed at construction,
 * camera-facing quads that live 0.24 s, a bounded pool, no allocation per frame.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const { HitPuff, PUFF } = await import('../../src/enemies/HitPuff.js');

const DT = 1 / 72;

test('built for the warm-up: transparent from creation, instanceColor present, hidden at rest', () => {
  const scene = new THREE.Scene();
  const p = new HitPuff(scene, 18);
  assert.ok(scene.children.includes(p.mesh));
  assert.ok(p.mesh.isInstancedMesh && p.mesh.instanceColor, 'instanceColor exists before the compile');
  const m = p.material;
  assert.equal(m.transparent, true);
  assert.equal(m.depthWrite, false);
  assert.equal(m.map, p.texture);
  assert.ok(p.texture.image.data.length === 32 * 32 * 4 && p.texture.needsUpdate !== false);
  assert.equal(p.mesh.visible, false);
  assert.equal(p.mesh.count, 0);
  // the texture writes alpha (over passthrough), soft at the edge
  const d = p.texture.image.data, at = (x, y) => d[(y * 32 + x) * 4 + 3];
  assert.ok(at(16, 16) > 180 && at(0, 0) === 0 && at(31, 16) < 20);
  p.setWarm(true);
  assert.ok(p.mesh.visible && p.mesh.count === 1, 'one drawn for the warm-up');
  p.setWarm(false);
  assert.ok(!p.mesh.visible && p.mesh.count === 0);
});

test('a hit: blood and dust on the shooter side, a spray out of the back, facing the eye; gone after 0.24 s', () => {
  const scene = new THREE.Scene();
  const p = new HitPuff(scene, 18);
  p.eye.set([0, 1.6, 0]);
  const v0 = p.material.version;
  // shooter at the origin, round travelling +x, hits a soldier's chest at (4, 1.3, 0)
  p.spawn(4, 1.3, 0, 1, 0, 0);
  assert.equal(p.live, PUFF.perHit);
  p.update(DT);
  assert.equal(p.mesh.count, 3);
  assert.ok(p.mesh.visible);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const zAxis = new THREE.Vector3(), toEye = new THREE.Vector3();
  let before = 0, behind = 0;
  for (let i = 0; i < 3; i++) {
    p.mesh.getMatrixAt(i, m);
    m.decompose(pos, q, s);
    assert.ok(s.x > 0.02 && s.x < 0.35 && Math.abs(s.x - s.y) < 1e-6, `size ${s.x}`);
    zAxis.set(0, 0, 1).applyQuaternion(q);
    toEye.set(0, 1.6, 0).sub(pos).normalize();
    assert.ok(zAxis.dot(toEye) > 0.999, 'the quad faces the eye');
    if (pos.x < 4) before++; else behind++;
  }
  assert.equal(before, 2, 'entry puffs out of the body toward the shooter');
  assert.equal(behind, 1, 'exit spray past the hit');
  // colours: dark red blood mist and a lighter dust
  const c = new THREE.Color();
  p.mesh.getColorAt(0, c);
  assert.ok(c.r > c.g * 3, 'blood');
  p.mesh.getColorAt(1, c);
  assert.ok(Math.abs(c.r - c.g) < 0.1 && c.r > 0.2, 'dust');
  let frames = 1;
  while (p.mesh.visible && frames < 100) { p.update(DT); frames++; }
  assert.ok(frames * DT >= PUFF.life - DT && frames * DT <= PUFF.life + 2 * DT, `${(frames * DT).toFixed(3)} s`);
  assert.equal(p.live, 0);
  assert.equal(p.material.version, v0, 'nothing on the material changed');
  assert.equal(p.material.transparent, true);
});

test('paused (dt 0) puffs hold; bad input is ignored; a full pool reuses the oldest', () => {
  const scene = new THREE.Scene();
  const p = new HitPuff(scene, 6);
  p.eye.set([0, 1.6, 3]);
  p.spawn(1, 1, 1, 0, 0, -1);
  p.update(DT);
  const a0 = p.age[0];
  for (let k = 0; k < 50; k++) p.update(0);
  assert.equal(p.age[0], a0, 'frozen while paused');
  assert.ok(p.mesh.visible);
  p.spawn(NaN, 1, 1, 0, 0, -1);
  assert.equal(p.live, 3);
  p.spawn(1, 1, 1, 0, 0, 0); // no direction: still a puff
  p.spawn(2, 1, 1, 1, 0, 0);
  assert.ok(p.live <= 6);
  p.update(DT);
  assert.ok(p.mesh.count <= 6);
  for (let i = 0; i < 6; i++) { p.mesh.getMatrixAt(i, new THREE.Matrix4()); }
  const m = new THREE.Matrix4();
  for (let i = 0; i < p.mesh.count; i++) { p.mesh.getMatrixAt(i, m); for (const e of m.elements) assert.ok(Number.isFinite(e)); }
  p.clear();
  assert.ok(!p.mesh.visible && p.live === 0);
});

test('the per-frame update does not allocate; a hit allocates at most a little', () => {
  const scene = new THREE.Scene();
  const p = new HitPuff(scene, 18);
  let i = 0;
  // hits are events (a few a second in play), allowed to allocate a little like the animator's
  // hit() and die(): until V8 optimises spawn() every double it computes is boxed (~3.5 KB a
  // hit in the interpreter, nothing once optimised); never objects, arrays or closures
  const hit = () => p.spawn(3 + (i++ % 7) * 0.1, 1.2, -2, 1, -0.1, 0.2);
  for (let k = 0; k < 200; k++) hit();
  // the least of three windows: one can catch V8 compiling spawn() (code space counts in heapUsed)
  let perHit = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const b0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 500; k++) hit();
    perHit = Math.min(perHit, (process.memoryUsage().heapUsed - b0) / 500);
  }
  assert.ok(perHit < 8192, `${perHit.toFixed(0)} B per hit`);
  // frames (a new hit whenever the last one has gone, so there is always something to draw),
  // once V8 has optimised both
  const frame = () => { if (p.live === 0) hit(); p.update(DT); };
  for (let k = 0; k < 60000; k++) frame();
  let grew = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let k = 0; k < 20000; k++) frame();
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 60_000, `heap grew ${grew} B over 20k frames (about 1200 hits)`);
});
