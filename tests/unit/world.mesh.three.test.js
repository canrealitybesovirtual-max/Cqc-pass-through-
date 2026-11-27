/**
 * World.js's mesh occluder (three r187): the processed global mesh as a second depth-only mesh
 * sharing the occluder's material, preallocated, written by ranges (addUpdateRange), uploaded
 * whole by a synchronous build and one range of tiles a frame after a worker build; the boxes
 * of furniture the mesh covers leave the box occluder once the mesh is up.
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
const { World, hydrateSnapshot, normalizeSnapshot } = await import('../../src/world/World.js');
const { InlineBuilder } = await import('../../src/world/WorldWorker.js');
const { TILE_STRIDE } = await import('../../src/world/MeshPrep.js');

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const meshHouse = async () => hydrateSnapshot(normalizeSnapshot(house()));
const tick = () => new Promise((r) => setTimeout(r, 1));

test('the mesh occluder exists from construction: the occluder\'s material, Uint32 index, fixed capacity, drawable for the warm-up', () => {
  const w = new World();
  const m = w.meshOccluder;
  assert.ok(m instanceof THREE.Mesh);
  assert.equal(m.material, w.occluder.material, 'the same material: the same program, nothing new to compile');
  assert.equal(m.renderOrder, -10);
  assert.equal(m.frustumCulled, false);
  assert.equal(m.visible, true);
  assert.equal(m.geometry.drawRange.count, 3, 'a placeholder triangle for the warm-up draw');
  assert.ok(m.geometry.index.array instanceof Uint32Array);
  assert.equal(m.geometry.index.array.length, w.maxMeshTris * 3);
  assert.equal(m.geometry.attributes.position.array.length, w.maxMeshVerts * 3);
  assert.equal(m.geometry.attributes.position.usage, THREE.DynamicDrawUsage);
  assert.ok(w.warmMeshes().includes(m));
  w.warmUp();
  assert.equal(m.visible, true);
  assert.equal(m.geometry.drawRange.count, 3, 'back to the placeholder after warmUp');
});

test('a synchronous build writes every tile in place by ranges; covered furniture leaves the box occluder', async () => {
  const w = new World();
  const geo = w.meshOccluder.geometry, pos = geo.attributes.position, idx = geo.index;
  const posArray = pos.array, idxArray = idx.array, v0 = pos.version;
  w.build(await meshHouse(), { x: 0, z: 0 });
  assert.equal(geo.attributes.position, pos);
  assert.equal(pos.array, posArray, 'no new arrays');
  assert.equal(idx.array, idxArray);
  assert.ok(pos.version > v0, 'marked for upload');
  const T = w.meshTiles, kept = w.report().mesh.kept;
  assert.equal(geo.drawRange.count, kept * 3);
  assert.equal(w.meshTilesUp, T.tileCount);
  // one range per attribute, covering only what was written (bufferSubData, not the whole buffer)
  assert.equal(pos.updateRanges.length, 1);
  assert.deepEqual({ ...pos.updateRanges[0] }, { start: 0, count: T.verts * 3 });
  assert.deepEqual({ ...idx.updateRanges[0] }, { start: 0, count: kept * 3 });
  // indices are tile-local + the tile's vertex start; positions are the occluder positions
  for (let k = 0; k < T.tileCount; k++) {
    const o = k * TILE_STRIDE, first = T.tiles[o], vs = T.tiles[o + 4];
    assert.equal(idx.array[first * 3], T.tileIdx[first * 3] + vs);
  }
  assert.deepEqual(pos.array.subarray(0, T.verts * 3), T.occPos);
  // the bed, couch and table are drawn from the mesh: their boxes are gone from the box occluder
  assert.equal(w.coveredFurniture, 3);
  assert.equal(w.occluderBoxes, w.layout.boxes.length - 3);
  const r = w.report();
  assert.deepEqual(r.meshOccluder, { tiles: T.tileCount, of: T.tileCount, dropped: 0, tris: kept, uploads: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('what the depth occluders hide: enemy legs under the real table show; the top, the walls and the bed still hide', async () => {
  const w = new World();
  w.build(await meshHouse(), { x: 0, z: 0 });
  const box = new World();
  box.build(house(), { x: 0, z: 0 }); // no mesh decoded: boxes only
  for (const m of [w.occluder, w.meshOccluder, box.occluder]) m.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const hits = (objs, a, b) => {
    const d = new THREE.Vector3(...b).sub(new THREE.Vector3(...a));
    rc.set(new THREE.Vector3(...a), d.clone().normalize());
    rc.far = d.length();
    return rc.intersectObjects(objs, false).length;
  };
  const t = w.layout.furniture.find((b) => b.label === 'table');
  const eye = [t.cx - 2.0, 0.42, t.cz], under = [t.cx + 0.2, 0.35, t.cz]; // a low look under the table
  assert.ok(hits([box.occluder], eye, under) > 0, 'boxes: the table volume hid the legs');
  assert.equal(hits([w.occluder, w.meshOccluder], eye, under), 0, 'mesh: seen between the table legs');
  assert.ok(hits([w.occluder, w.meshOccluder], [t.cx, 1.6, t.cz], [t.cx, 0.2, t.cz]) > 0, 'the table top hides what is under it from above');
  assert.ok(hits([w.occluder, w.meshOccluder], [0, 1.5, 0], [5, 1.2, -1]) > 0, 'behind the bedroom wall');
  assert.equal(hits([w.occluder, w.meshOccluder], [0, 1.5, 0], [2.9, 1.2, -2.1]), 0, 'by the door in the living room');
  const bed = w.layout.furniture.find((b) => b.label === 'bed');
  assert.ok(hits([w.occluder, w.meshOccluder], [bed.cx - 1.8, 0.4, bed.cz], [bed.cx + 0.5, 0.3, bed.cz]) > 0, 'the bed hides what is behind it');
});

test('a worker build uploads one range of tiles a frame; the boxes of covered furniture go once the mesh is complete', async () => {
  const w = new World({ meshUploadBytes: 8 * 1024 });
  w.attachBuilder(new InlineBuilder(w.config));
  const geo = w.meshOccluder.geometry, pos = geo.attributes.position, idx = geo.index;
  const posArray = pos.array;
  const snap = await meshHouse();
  let done = false;
  w.buildAsync(snap, { x: 0, z: 0 }).then(() => { done = true; });
  const counts = [];
  let sawFullBoxes = false;
  for (let f = 0; f < 3000 && !done; f++) {
    await tick();
    const before = geo.drawRange.count;
    const trisBefore = w.meshTrisDrawn;
    const wasUpload = w.buildPhase === 4 && w._post > 0; // post step 0 resets the draw range for the new tiles
    w.update(0.0139, f * 13.9, null, null);
    if (w.buildPhase === 4 /* UPLOAD */ || done) {
      counts.push(geo.drawRange.count);
      // never more than one range per attribute pending, and each frame adds at most ~8 KB
      assert.ok(pos.updateRanges.length <= 1 && idx.updateRanges.length <= 1);
      const addedTris = w.meshTrisDrawn - trisBefore;
      assert.ok(addedTris * 12 <= 8 * 1024 + 4096 * 12, `${addedTris} triangles in one frame`);
      if (wasUpload) assert.ok(geo.drawRange.count >= before, 'the draw range only grows (from 0 at the commit)');
      if (!done && w.occluderBoxes === w.layout.boxes.length) sawFullBoxes = true;
    }
  }
  assert.ok(done);
  assert.ok(counts.length >= 3, `${counts.length} upload frames`);
  assert.ok(sawFullBoxes, 'the covered boxes stay in the box occluder while the mesh uploads');
  assert.equal(w.occluderBoxes, w.layout.boxes.length - 3, 'then they go');
  assert.equal(pos.array, posArray);
  // the same result as a synchronous build
  const s = new World();
  s.build(await meshHouse(), { x: 0, z: 0 });
  assert.equal(geo.drawRange.count, s.meshOccluder.geometry.drawRange.count);
  assert.deepEqual(pos.array.subarray(0, s.meshTiles.verts * 3), s.meshOccluder.geometry.attributes.position.array.subarray(0, s.meshTiles.verts * 3));
  assert.deepEqual(idx.array.subarray(0, geo.drawRange.count), s.meshOccluder.geometry.index.array.subarray(0, geo.drawRange.count));
});

test('capacity: tiles that do not fit are left out and their furniture keeps its box; no mesh → boxes only', async () => {
  const w = new World({ maxMeshTris: 400 });
  w.build(await meshHouse(), { x: 0, z: 0 });
  assert.ok(w.meshTilesDropped > 0);
  assert.ok(w.meshTrisDrawn <= 400);
  assert.equal(w.occluderBoxes, w.layout.boxes.length, 'covered boxes kept: the mesh is incomplete');
  assert.ok(w.stats.notes.some((n) => /mesh occluder holds/.test(n)));
  const v = new World();
  v.build(house(), { x: 0, z: 0 });
  assert.equal(v.meshOccluder.visible, false);
  assert.equal(v.meshOccluder.geometry.drawRange.count, 0);
  assert.equal(v.occluderBoxes, v.layout.boxes.length);
  v.build(null, { x: 0, z: 0 });
  assert.equal(v.meshOccluder.visible, false);
});
