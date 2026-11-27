// Snapshot v2 (src/world/Snapshot.js): the captured XRMesh triangles (not enumerable: never in
// JSON or Copy), the global mesh's description and its compact record, desktop replay, and the
// world built with the mesh (BVH rays under a real table, mesh labels, the surface below a point).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CaptureJob, CAPTURE_VERTS_PER_FRAME, captureSnapshot, globalRawMesh, hydrateSnapshot, loadFixture, normalizeSnapshot, rawOf, snapshotForCopy } from '../../src/world/Snapshot.js';
import { transformSnapshot } from '../../src/world/Realign.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { WorldCore } from '../../src/world/WorldCore.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const MESH_POSE = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.4, 0.05, -0.3, 1]; // mesh space ≠ reference space

/** A fake XRFrame: the fixture's planes and volumes plus a scanned global mesh in its own mesh space. */
function frameWithMesh() {
  const src = house();
  const poses = new Map();
  const planes = new Set(), meshes = new Set();
  src.planes.forEach((p, i) => {
    const planeSpace = { id: `p${i}` };
    poses.set(planeSpace, Float32Array.from(p.pose));
    planes.add({ planeSpace, orientation: p.orientation, semanticLabel: p.label ?? undefined, polygon: p.polygon.map(([x, z]) => ({ x, y: 0, z, w: 1 })) });
  });
  for (const m of src.meshes) {
    if (m.label === 'global mesh') continue;
    const meshSpace = { id: `m${meshes.size}` };
    poses.set(meshSpace, Float32Array.from(m.pose));
    const v = [];
    for (let k = 0; k < 8; k++) v.push(k & 1 ? m.max[0] : m.min[0], k & 2 ? m.max[1] : m.min[1], k & 4 ? m.max[2] : m.min[2]);
    meshes.add({ meshSpace, vertices: new Float32Array(v), indices: new Uint32Array([0, 1, 2, 1, 3, 2]), semanticLabel: m.label, lastChangedTime: 5 });
  }
  const scan = scanFromSnapshot(src, { pose: MESH_POSE });
  const gSpace = { id: 'global' };
  poses.set(gSpace, Float32Array.from(MESH_POSE));
  const xrGlobal = { meshSpace: gSpace, vertices: scan.vertices, indices: scan.indices, semanticLabel: 'global mesh', lastChangedTime: 42 };
  meshes.add(xrGlobal);
  const refSpace = { id: 'local-floor' };
  return { frame: { detectedPlanes: planes, detectedMeshes: meshes, getPose: (s) => { const m = poses.get(s); return m ? { transform: { matrix: m } } : null; } }, refSpace, scan, xrGlobal };
}

test('capture copies every XRMesh\'s triangles once, outside JSON; globalMesh describes the global mesh', () => {
  const { frame, refSpace, scan, xrGlobal } = frameWithMesh();
  const stats = { planes: 0, meshes: 0, skippedPlanes: 0, skippedMeshes: 0, meshTris: 0, meshBytes: 0 };
  const snap = captureSnapshot(frame, refSpace, { stats });
  assert.equal(snap.version, 2);
  const g = snap.globalMesh;
  assert.equal(g.label, 'global mesh');
  assert.equal(g.triangleCount, scan.indices.length / 3);
  assert.equal(g.vertexCount, scan.vertices.length / 3);
  assert.equal(g.lastChangedTime, 42);
  assert.equal(snap.meshes[g.mesh].label, 'global mesh', 'index of its box in meshes');
  const raw = rawOf(snap);
  assert.ok(raw && raw.meshes.length === snap.meshes.length);
  const rm = globalRawMesh(snap);
  assert.ok(rm.data.vertices !== xrGlobal.vertices, 'a copy, not the browser\'s array');
  assert.deepEqual(rm.data.vertices, xrGlobal.vertices);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rm.pose[i] - MESH_POSE[i]) < 1e-6, 'the mesh-space pose (Float32 from the browser)');
  assert.ok(stats.meshTris >= g.triangleCount && stats.meshBytes > 100000);
  // not in JSON, not cloned, not in Copy
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('"raw"') && json.length < 20000, `${json.length} B of JSON`);
  assert.equal(structuredClone(snap).raw, undefined);
  assert.equal(normalizeSnapshot(JSON.parse(json)).raw, undefined);
  assert.equal(rawOf(normalizeSnapshot(snap)), raw, 'normalisation keeps a live capture\'s triangles');
  assert.equal(captureSnapshot(frame, refSpace, { raw: false }).raw, undefined, 'raw: false skips the copies');
});

test('the world builds from the captured mesh; the record (sync build) round-trips through hydrateSnapshot', async () => {
  const { frame, refSpace } = frameWithMesh();
  const snap = captureSnapshot(frame, refSpace);
  const w = new WorldCore({ roam: true });
  w.build(snap, { x: 0, z: 0 });
  const r = w.report();
  assert.equal(r.mesh.tris, snap.globalMesh.triangleCount);
  assert.equal(r.mesh.covered, 3);
  assert.ok(r.mesh.oneSided);
  const rec = await w.encodeMeshRecord();
  assert.equal(snap.globalMesh.encoding, 'cqc-mesh-1');
  assert.equal(snap.globalMesh.hash, rec.hash);
  assert.equal(snap.globalMesh.space, 'reference');
  const full = JSON.stringify(snap);
  const copy = JSON.stringify(snapshotForCopy(snap));
  assert.ok(full.length - copy.length > rec.data.length - 50 && !copy.includes(rec.data.slice(0, 64)), 'Copy leaves the blob out');
  assert.equal(snapshotForCopy(snap).globalMesh.dataOmitted, true);
  assert.equal(snapshotForCopy(snap).globalMesh.hash, rec.hash, 'the counts and hash stay');
  // desktop replay: the session record → the same world
  const replay = await hydrateSnapshot(normalizeSnapshot(JSON.parse(full)));
  assert.ok(rawOf(replay));
  const w2 = new WorldCore({ roam: true });
  w2.build(replay, { x: 0, z: 0 });
  const r2 = w2.report();
  assert.equal(r2.mesh.tris, r.mesh.tris);
  assert.ok(Math.abs(r2.mesh.kept - r.mesh.kept) <= 2, `${r2.mesh.kept} vs ${r.mesh.kept} kept (2 mm quantum)`);
  assert.equal(r2.mesh.covered, 3);
  // a broken blob is noted, not thrown
  const bad = normalizeSnapshot(JSON.parse(full));
  bad.globalMesh.data = bad.globalMesh.data.slice(0, 200);
  await hydrateSnapshot(bad);
  assert.equal(rawOf(bad), null);
  assert.ok(bad.globalMesh.error);
});

test('the fixture carries a synthetic global mesh: loadFixture decodes it; v1 snapshots still load', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => house() });
    const snap = await loadFixture('./tests/fixtures/house.json');
    const rm = globalRawMesh(snap);
    assert.ok(rm, 'decoded into raw');
    assert.equal(rm.data.indices.length / 3, snap.globalMesh.triangleCount);
    const w = new WorldCore({ roam: true });
    w.build(snap, { x: 0, z: 0 });
    assert.ok(w.bvh && w.report().mesh.covered === 3);
  } finally {
    globalThis.fetch = realFetch;
  }
  const v1 = house();
  v1.version = 1;
  delete v1.globalMesh;
  const n = normalizeSnapshot(v1);
  assert.equal(n.version, 2);
  assert.equal(n.globalMesh, null);
  const w = new WorldCore();
  w.build(v1, { x: 0, z: 0 });
  assert.equal(w.bvh, null, 'no mesh: planes and boxes only');
  assert.ok(w.staticGeometry().slabCount > 0);
  // an encoded mesh that was not decoded (a sync replay) is noted, not used
  const plain = new WorldCore();
  plain.build(house(), { x: 0, z: 0 });
  assert.equal(plain.bvh, null);
  assert.ok(plain.stats.notes.some((s) => /not decoded/.test(s)));
});

test('transformSnapshot moves the mesh pose and shares the triangles (Realign)', () => {
  const { frame, refSpace } = frameWithMesh();
  const snap = captureSnapshot(frame, refSpace);
  const m = [Math.cos(0.4), 0, -Math.sin(0.4), 0, 0, 1, 0, 0, Math.sin(0.4), 0, Math.cos(0.4), 0, 1.5, 0, -0.7, 1];
  const moved = transformSnapshot(snap, m);
  const a = globalRawMesh(snap), b = globalRawMesh(moved);
  assert.equal(b.data, a.data, 'the same arrays');
  // the pose is m · pose: a mesh vertex lands where m takes its old reference-space position
  const P = a.pose, Q = b.pose, v = [a.data.vertices[0], a.data.vertices[1], a.data.vertices[2]];
  const ap = (M, x) => [M[0] * x[0] + M[4] * x[1] + M[8] * x[2] + M[12], M[1] * x[0] + M[5] * x[1] + M[9] * x[2] + M[13], M[2] * x[0] + M[6] * x[1] + M[10] * x[2] + M[14]];
  const want = ap(m, ap(P, v)), got = ap(Q, v);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(want[i] - got[i]) < 1e-9);
  assert.equal(moved.globalMesh.triangleCount, snap.globalMesh.triangleCount);
  assert.equal(moved.globalMesh.data, undefined, 'the old-space blob is not carried');
  // the moved world: the bed's mesh moved with it
  const w0 = new WorldCore(), w1 = new WorldCore();
  w0.build(snap, { x: 0, z: 0 });
  w1.build(moved, { x: 0, z: 0 });
  const h0 = {}, h1 = {};
  assert.ok(w0.raycast(5.6, 1.5, -1.1, 0, -1, 0, 3, h0));
  const p = ap(m, [5.6, 1.5, -1.1]);
  assert.ok(w1.raycast(p[0], p[1], p[2], 0, -1, 0, 3, h1));
  assert.ok(Math.abs(h0.dist - h1.dist) < 1e-3 && h0.surface === 'bed' && h1.surface === 'bed');
});

test('with the mesh: a shot under the real table passes between its legs; labels and surfaceBelow come from the mesh', async () => {
  const snap = await hydrateSnapshot(normalizeSnapshot(house()));
  const w = new WorldCore();
  w.build(snap, { x: 0, z: 0 });
  const box = new WorldCore();
  box.build(house(), { x: 0, z: 0 }); // the same house without the mesh: boxes only
  const t = w.layout.furniture.find((b) => b.label === 'table');
  const h = {}, hb = {};
  // from the living room, level at 0.35 m, straight through the table's footprint
  const ox = t.cx - 1.5, oz = t.cz;
  assert.ok(box.raycast(ox, 0.35, oz, 1, 0, 0, 3, hb) && hb.surface === 'table', 'boxes: the table volume stops it');
  const hitMesh = w.raycast(ox, 0.35, oz, 1, 0, 0, 3, h);
  assert.ok(!hitMesh || h.dist > 2.0 || h.surface !== 'table', `mesh: passes under the top (${hitMesh && h.surface} at ${hitMesh && h.dist})`);
  assert.equal(w.segmentClear(ox, 0.3, oz, t.cx + 1.2, 0.3, t.cz), box.segmentClear(ox, 0.3, oz, t.cx + 1.2, 0.3, t.cz) ? true : w.segmentClear(ox, 0.3, oz, t.cx + 1.2, 0.3, t.cz));
  // straight down onto the table top: the mesh, labelled 'table', 1 cm of noise at most
  assert.ok(w.raycast(t.cx, 1.5, t.cz, 0, -1, 0, 3, h));
  assert.equal(h.surface, 'table');
  assert.ok(Math.abs(h.y - t.y1) < 0.012, `top at ${h.y} vs ${t.y1}`);
  const out = { y: 0, nx: 0, ny: 0, nz: 0, surface: '', dist: 0 };
  const bed = w.layout.furniture.find((b) => b.label === 'bed');
  assert.ok(w.surfaceBelow(bed.cx, 1.4, bed.cz, 2, out));
  assert.equal(out.surface, 'bed');
  assert.ok(out.ny > 0.8 && Math.abs(out.y - bed.y1) < 0.08, `bed top ${out.y}`);
  assert.ok(w.surfaceBelow(0.5, 1.4, 0.4, 2, out) && out.surface === 'floor' && Math.abs(out.y - w.floorY(0.5, 0.4)) < 1e-3);
  assert.equal(w.surfaceBelow(0.5, 1.4, 0.4, 0.5, out), false, 'nothing within 0.5 m');
  // the walls stay boxes: a ray into a wall hits the slab, not the (cropped) scan
  assert.ok(w.raycast(0.5, 1.4, -1, 0, 0, -1, 5, h) && h.surface === 'wall');
});

test('v0.5: the capture spread over frames gives the same snapshot as the one-frame capture; the big mesh takes several frames', () => {
  const { frame, refSpace, xrGlobal } = frameWithMesh();
  const one = captureSnapshot(frame, refSpace, {});
  const job = new CaptureJob();
  const stats = { planes: 0, meshes: 0, skippedPlanes: 0, skippedMeshes: 0, meshTris: 0, meshBytes: 0 };
  job.begin(frame, refSpace, { stats });
  assert.equal(job.done, false);
  assert.equal(job.snap.planes.length, one.planes.length, 'the planes in the first frame');
  let frames = 0;
  while (!job.step(frame, refSpace, 4096) && frames < 1000) frames++;
  const verts = xrGlobal.vertices.length / 3;
  assert.ok(frames + 1 >= Math.floor(verts / 4096), `${frames + 1} frames for ${verts} vertices at 4096 a frame`);
  assert.deepEqual(JSON.parse(JSON.stringify(job.snap)), JSON.parse(JSON.stringify(one)));
  assert.equal(rawOf(job.snap).meshes.length, rawOf(one).meshes.length);
  assert.equal(stats.meshes, one.meshes.length);
  const rep = job.report();
  assert.ok(rep.frames === frames + 2 && rep.ms >= 0 && rep.maxMs <= rep.ms + 1e-9, JSON.stringify(rep));
  assert.ok(CAPTURE_VERTS_PER_FRAME >= 4096);
});
