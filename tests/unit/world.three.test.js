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

test('dev overlay: one LineSegments built at construction, hidden by default, filled in place by build', () => {
  const w = new World();
  const o = w.overlay;
  assert.ok(o instanceof THREE.LineSegments);
  assert.ok(o.material instanceof THREE.LineBasicMaterial);
  assert.equal(o.material.vertexColors, true);
  assert.equal(o.material.depthTest, true);
  assert.equal(o.material.depthWrite, false);
  assert.equal(o.visible, false, 'hidden by default');
  assert.equal(o.frustumCulled, false);
  assert.ok(o.renderOrder > w.occluder.renderOrder, 'drawn after the occluder: lines behind real walls are hidden');
  assert.equal(o.geometry.drawRange.count, 2, 'a placeholder segment for the warm-up draw');
  const wm = w.warmMeshes();
  assert.equal(wm.length, 3);
  assert.ok(wm[0] === w.occluder && wm[1] === w.meshOccluder && wm[2] === o, 'occluder, mesh occluder, overlay');
  const { geometry, material } = o;
  const pos = geometry.attributes.position, col = geometry.attributes.color;
  const v0 = pos.version;
  w.build(house(), { x: 0, z: 0 }, { doors: [true, true, false] });
  assert.equal(o.geometry, geometry);
  assert.equal(o.material, material);
  assert.equal(geometry.attributes.position, pos);
  assert.equal(geometry.attributes.color, col);
  assert.ok(pos.version > v0, 'marked for upload (the warmXR draw after build uploads it)');
  const L = w.layout;
  assert.equal(w.overlayVerts, L.boxes.length * 24 + L.doors.length * 8 + L.pockets * 8);
  assert.equal(geometry.drawRange.count, w.overlayVerts);
  assert.equal(o.visible, false, 'still hidden after build');
  w.setOverlay(true);
  assert.equal(o.visible, true);
  assert.equal(o.material, material, 'toggling is a visibility flag only');
  // A virtual room has no occluder edges: nothing to show.
  w.build(null, { x: 0, z: 0 });
  assert.equal(geometry.drawRange.count, 0);
  assert.equal(o.visible, false);
  w.build(house(), { x: 0, z: 0 });
  assert.equal(o.visible, true, 'the overlay setting survives a rebuild');
  w.setOverlay(false);
  assert.equal(o.visible, false);
  const r = w.report();
  assert.equal(r.occluderBoxes, w.occluderBoxes);
  assert.equal(r.overlaySegments, w.overlayVerts / 2);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('a closed door in World: the occluder has no hole there; rebuild() rewrites the same buffers', () => {
  const w = new World();
  w.build(house(), { x: 0, z: 0 });
  const m = w.occluder;
  const geo = m.geometry, pos = geo.attributes.position;
  m.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const through = () => {
    rc.set(new THREE.Vector3(-1.15, 1.0, 0), new THREE.Vector3(0, 0, -1));
    rc.far = 4;
    return rc.intersectObject(m).length === 0;
  };
  assert.ok(through(), 'open hallway door: no occluder in the opening');
  assert.ok(w.setDoorOpen(2, false));
  w.rebuild();
  assert.equal(m.geometry, geo);
  assert.equal(geo.attributes.position, pos);
  assert.equal(through(), false, 'closed: the wall occludes across the door');
  assert.equal(w.stats.closedDoors, 1);
});
