import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CaptureGate, captureSnapshot, loadFixture, meshBox, normalizeSnapshot } from '../../src/world/Snapshot.js';
import { WorldCore } from '../../src/world/WorldCore.js';

const FIXTURE = new URL('../fixtures/house.json', import.meta.url);
const house = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

/** Column-major rotation about +Y by `yaw`, then about local X by `pitch`, with a translation. */
function poseOf(yaw, pitch, tx, ty, tz) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = Ry(yaw) · Rx(pitch)
  const r00 = cy, r01 = sy * sp, r02 = sy * cp;
  const r10 = 0, r11 = cp, r12 = -sp;
  const r20 = -sy, r21 = cy * sp, r22 = cy * cp;
  return Float32Array.from([r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, tx, ty, tz, 1]);
}

/** A fake XRFrame with the WebXR plane/mesh API shape, built from a stored snapshot. */
function fakeFrameFrom(snap, { nullPoseFor = -1, extraMeshes = [] } = {}) {
  const poses = new Map();
  const planes = new Set();
  snap.planes.forEach((p, i) => {
    const planeSpace = { id: `plane${i}` };
    poses.set(planeSpace, i === nullPoseFor ? null : Float32Array.from(p.pose));
    planes.add({
      planeSpace, orientation: p.orientation, semanticLabel: p.label ?? undefined, lastChangedTime: 1000 + i,
      polygon: p.polygon.map(([x, z]) => ({ x, y: 0, z, w: 1 })),
    });
  });
  const meshes = new Set();
  const addMesh = (label, pose, min, max) => {
    const meshSpace = { id: `mesh${meshes.size}` };
    poses.set(meshSpace, Float32Array.from(pose));
    const v = [];
    for (let k = 0; k < 8; k++) v.push(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
    meshes.add({ meshSpace, vertices: new Float32Array(v), indices: new Uint32Array(36), semanticLabel: label ?? undefined, lastChangedTime: 5 });
  };
  for (const m of snap.meshes) if (m.vertexCount <= 8) addMesh(m.label, m.pose, m.min, m.max);
  for (const m of extraMeshes) addMesh(m.label, m.pose, m.min, m.max);
  const refSpace = { id: 'local-floor' };
  return {
    detectedPlanes: planes,
    detectedMeshes: meshes,
    getPose(space, ref) {
      assert.equal(ref, refSpace);
      const m = poses.get(space);
      return m ? { transform: { matrix: m } } : null;
    },
    refSpace,
  };
}

function worldCorners(pose, min, max) {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? max[0] : min[0], y = k & 2 ? max[1] : min[1], z = k & 4 ? max[2] : min[2];
    out.push([pose[0] * x + pose[4] * y + pose[8] * z + pose[12], pose[1] * x + pose[5] * y + pose[9] * z + pose[13], pose[2] * x + pose[6] * y + pose[10] * z + pose[14]]);
  }
  return out;
}

test('captureSnapshot copies planes and meshes into plain JSON data', () => {
  const src = house();
  const f = fakeFrameFrom(src, { nullPoseFor: 3 });
  const stats = { planes: 0, meshes: 0, skippedPlanes: 0, skippedMeshes: 0 };
  const snap = captureSnapshot(f, f.refSpace, { stats });
  assert.equal(snap.version, 2, 'v2: planes, mesh boxes and (not enumerable) the triangles');
  assert.equal(snap.space, 'local-floor');
  assert.equal(snap.planes.length, src.planes.length - 1);
  assert.equal(stats.skippedPlanes, 1, 'the plane without a pose this frame is skipped');
  assert.equal(snap.meshes.length, 3);
  // Plain arrays, no typed arrays or XR objects; survives JSON.
  assert.ok(Array.isArray(snap.planes[0].pose) && snap.planes[0].pose.length === 16);
  assert.ok(Array.isArray(snap.planes[0].polygon[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.deepEqual(snap.planes[0].polygon, src.planes[0].polygon);
  assert.equal(snap.planes[0].label, 'floor');
  for (const p of snap.planes) assert.ok(p.orientation === 'horizontal' || p.orientation === 'vertical');
});

test('labels may be null; orientation falls back to the pose normal', () => {
  const planeSpace = {};
  const f = {
    detectedPlanes: new Set([{ planeSpace, polygon: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], semanticLabel: '' }]),
    getPose: () => ({ transform: { matrix: poseOf(0, 0, 0, 0, 0) } }),
  };
  const snap = captureSnapshot(f, {});
  assert.equal(snap.planes[0].label, null);
  assert.equal(snap.planes[0].orientation, 'horizontal');
  assert.deepEqual(snap.meshes, []);
  assert.deepEqual(captureSnapshot({}, {}).planes, [], 'no plane-detection: empty snapshot');
});

test('meshes become gravity-aligned boxes whatever their mesh-space orientation', () => {
  // A 1.2 × 0.5 × 0.8 box in a z-up mesh frame (pitch −90°), yawed 30°, at (2, 0.4, −1).
  const pose = poseOf(Math.PI / 6, -Math.PI / 2, 2, 0.4, -1);
  const min = [-0.6, -0.4, -0.25], max = [0.6, 0.4, 0.25]; // local z = up: height 0.5
  const f = fakeFrameFrom({ planes: [], meshes: [] }, { extraMeshes: [{ label: 'table', pose, min, max }] });
  const snap = captureSnapshot(f, f.refSpace);
  const m = snap.meshes[0];
  assert.equal(m.label, 'table');
  assert.equal(m.vertexCount, 8);
  assert.deepEqual([m.pose[4], m.pose[5], m.pose[6]], [0, 1, 0], 'box frame is y-up');
  assert.ok(Math.abs(m.max[1] - m.min[1] - 0.5) < 1e-3, 'height');
  const sizes = [m.max[0] - m.min[0], m.max[2] - m.min[2]].sort();
  assert.ok(Math.abs(sizes[0] - 0.8) < 1e-3 && Math.abs(sizes[1] - 1.2) < 1e-3, `footprint ${sizes}`);
  // The captured box has the same world corners as the source box (as a set).
  const want = worldCorners(pose, min, max).map((p) => p.map((v) => Math.round(v * 100)).join()).sort();
  const got = worldCorners(m.pose, m.min, m.max).map((p) => p.map((v) => Math.round(v * 100)).join()).sort();
  assert.deepEqual(got, want);
});

test('a huge mesh (the global mesh) gets a world-axis box without a hull', () => {
  const n = 7000, v = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { v[3 * i] = Math.cos(i) * 5; v[3 * i + 1] = (i % 25) / 10; v[3 * i + 2] = Math.sin(i) * 3; }
  const m = meshBox('global mesh', poseOf(0, 0, 1, 0, 0), v);
  assert.equal(m.vertexCount, n);
  assert.deepEqual([m.pose[0], m.pose[2]], [1, 0]);
  assert.ok(Math.abs(m.pose[12] - 1) < 0.01 && Math.abs(m.max[0] - 5) < 0.01 && Math.abs(m.max[2] - 3) < 0.01);
});

test('a capture of the fixture house builds the same world as the fixture itself', () => {
  const src = house();
  const f = fakeFrameFrom(src);
  const snap = captureSnapshot(f, f.refSpace);
  const a = new WorldCore(), b = new WorldCore();
  a.build(src, { x: 0, z: 0 });
  b.build(snap, { x: 0, z: 0 });
  assert.equal(b.stats.walls, a.stats.walls);
  assert.equal(b.stats.doors, a.stats.doors);
  assert.equal(b.stats.furniture, a.stats.furniture);
  assert.equal(b.stats.walkable, a.stats.walkable);
  for (let i = 0; i < a.layout.boxes.length; i++) {
    const p = a.layout.boxes[i], q = b.layout.boxes[i];
    for (const k of ['cx', 'cz', 'hx', 'hz', 'y0', 'y1']) assert.ok(Math.abs(p[k] - q[k]) < 2e-3, `box ${i} ${k}: ${p[k]} vs ${q[k]}`);
  }
});

test('normalizeSnapshot validates and drops malformed entries', () => {
  assert.throws(() => normalizeSnapshot(null));
  assert.throws(() => normalizeSnapshot({ version: 3, planes: [] }));
  const s = normalizeSnapshot({
    version: 1,
    planes: [
      { label: 'floor', orientation: 'horizontal', pose: Array(16).fill(0), polygon: [[0, 0], [1, 0], [1, 1]] },
      { label: 'wall', pose: Array(15).fill(0), polygon: [[0, 0], [1, 0], [1, 1]] },
      { label: 'wall', pose: Array(16).fill(0), polygon: [[0, 0], [1, NaN], [1, 1]] },
      { label: 7, pose: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1], polygon: [[0, 0], [1, 0], [1, 1]] },
    ],
    meshes: [{ label: 'bed', pose: Array(16).fill(0), min: [0, 0, 0], max: [1, 1, 1] }, { pose: [] }],
  });
  assert.equal(s.space, 'local-floor');
  assert.equal(s.planes.length, 2);
  assert.equal(s.planes[1].label, null);
  assert.equal(s.planes[1].orientation, 'vertical');
  assert.equal(s.meshes.length, 1);
  assert.equal(s.meshes[0].vertexCount, 0);
});

test('loadFixture fetches and validates a stored snapshot', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => (String(url).endsWith('house.json')
      ? { ok: true, status: 200, json: async () => house() }
      : { ok: false, status: 404, json: async () => ({}) });
    const snap = await loadFixture('./tests/fixtures/house.json');
    assert.equal(snap.planes.length, 19);
    assert.equal(snap.meshes.length, 4);
    await assert.rejects(() => loadFixture('./missing.json'), /404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('CaptureGate: capture once the plane count is stable for 0.5 s, or after 3 s', () => {
  const frame = (n) => ({ detectedPlanes: { size: n } });
  const g = new CaptureGate();
  assert.equal(g.update(frame(0), 0), false);
  assert.equal(g.update(frame(10), 400), false);
  assert.equal(g.update(frame(50), 700), false, 'count changed: wait again');
  assert.equal(g.update(frame(50), 1100), false);
  assert.equal(g.update(frame(50), 1200), true, 'stable for 0.5 s');
  assert.equal(g.update(frame(50), 1300), false, 'fires once');
  const t = new CaptureGate();
  t.update(null, 0);
  assert.equal(t.update(frame(0), 2999), false);
  assert.equal(t.update(frame(0), 3000), true, 'timeout with no planes (virtual room)');
  t.reset();
  assert.equal(t.update(frame(3), 5000), false);
});
