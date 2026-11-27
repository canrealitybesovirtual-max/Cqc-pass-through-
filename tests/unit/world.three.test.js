/**
 * World.js (the three.js part): the single depth-only occluder mesh. The page
 * maps 'three' with an import map; here a resolve hook maps it to the vendored
 * build, so the real three r187 classes are used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

const threeUrl = new URL('../../vendor/three/three.module.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(threeUrl)}, shortCircuit: true } : next(s, c); }`,
));
const THREE = await import('three');
const { World, captureSnapshot, loadFixture, NavGrid, PathPlanner, CaptureGate } = await import('../../src/world/World.js');

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

test('module exports the contract surface', () => {
  for (const f of [captureSnapshot, loadFixture]) assert.equal(typeof f, 'function');
  for (const C of [World, NavGrid, PathPlanner, CaptureGate]) assert.equal(typeof C, 'function');
  const w = new World();
  for (const m of ['build', 'raycast', 'segmentClear', 'findSpawn', 'floorY', 'update']) assert.equal(typeof w[m], 'function', m);
  assert.ok(w.nav instanceof NavGrid);
});

test('the occluder exists from construction: depth-only, renderOrder −10, drawable for the warm-up', () => {
  const w = new World();
  const m = w.occluder;
  assert.ok(m instanceof THREE.Mesh);
  assert.ok(m.material instanceof THREE.MeshBasicMaterial);
  assert.equal(m.material.colorWrite, false);
  assert.equal(m.material.depthWrite, true);
  assert.equal(m.material.depthTest, true);
  assert.equal(m.material.transparent, false);
  assert.equal(m.renderOrder, -10);
  assert.equal(m.frustumCulled, false);
  assert.equal(m.visible, true);
  assert.equal(m.geometry.drawRange.count, 36, 'one placeholder box before build');
  assert.ok(m.geometry.index.array instanceof Uint16Array);
});

test('build fills the same buffers (no new geometry, material or attribute)', () => {
  const w = new World();
  const { geometry, material } = w.occluder;
  const pos = geometry.attributes.position, idx = geometry.index;
  const posArray = pos.array, v0 = pos.version, i0 = idx.version;
  w.build(house(), { x: 0, z: 0 });
  assert.equal(w.occluder.geometry, geometry);
  assert.equal(w.occluder.material, material);
  assert.equal(geometry.attributes.position, pos);
  assert.equal(pos.array, posArray);
  assert.ok(pos.version > v0 && idx.version > i0, 'marked for upload');
  assert.equal(w.occluderBoxes, w.layout.boxes.length);
  assert.equal(geometry.drawRange.count, w.occluderBoxes * 36);
  assert.ok(w.occluderBoxes * 12 <= 2400, 'triangle budget (PLAN §5: ≤ 2.4k)');
  // Bounds cover the house and nothing more.
  const bb = geometry.boundingBox;
  assert.ok(bb.min.x > -2.2 && bb.max.x < 6.8 && bb.min.z > -3.3 && bb.max.z < 1.2, `${bb.min.toArray()} ${bb.max.toArray()}`);
  assert.ok(geometry.boundingSphere.radius > 4);
  // A virtual room has nothing to occlude.
  w.build(null, { x: 0, z: 0 });
  assert.equal(w.occluder.visible, false);
  assert.equal(geometry.drawRange.count, 0);
  w.build(house(), { x: 0, z: 0 });
  assert.equal(w.occluder.visible, true);
});

test('the occluder hides what is behind a wall and not what is in the doorway (CPU raycast on the mesh)', () => {
  const w = new World();
  w.build(house(), { x: 0, z: 0 });
  const m = w.occluder;
  m.updateMatrixWorld(true);
  // Restrict the raycast to the written vertices (three's raycast honours drawRange).
  const rc = new THREE.Raycaster();
  const from = new THREE.Vector3(0, 1.5, 0);
  const hitsTo = (x, y, z) => {
    const d = new THREE.Vector3(x, y, z).sub(from);
    rc.set(from, d.clone().normalize());
    rc.far = d.length();
    return rc.intersectObject(m).length;
  };
  assert.ok(hitsTo(5, 1.2, -1) > 0, 'enemy in the bedroom, behind the wall: occluded');
  assert.equal(hitsTo(2.9, 1.2, -2.1), 0, 'enemy standing in the living room by the door: visible');
  assert.equal(hitsTo(4.0, 1.4, -2.9), 0, 'enemy seen through the door opening: visible');
  assert.ok(hitsTo(1.4, 0.4, -2.6) > 0, 'legs behind the table: occluded');
  assert.equal(hitsTo(1.4, 1.2, -2.6), 0, 'chest above the table: visible');
});

test('warmUp runs every build path and leaves the world unbuilt', () => {
  const w = new World();
  w.warmUp();
  assert.equal(w.built, false);
  assert.equal(w.occluder.visible, true, 'still drawable for the warm-up draw');
  assert.equal(w.occluder.geometry.drawRange.count, 36);
  w.build(house(), { x: 0, z: 0 });
  assert.equal(w.built, true);
  assert.equal(w.stats.walls, 8);
});
