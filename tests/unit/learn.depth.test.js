// v0.5: the GPU depth downsample's packing (CPU mirror of DepthTap's shader) and the worker's unprojection:
// a Quest-like 320² two-layer depth image of a known room, asymmetric per-eye projections, decoded back to
// points within a few millimetres (research F5); the row-direction calibration against Space Setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBlocks, decodeSlab, renderDepth, EYE, POSE, TAP } from '../../src/learn/depthMath.js';
import { LearnCore } from '../../src/learn/LearnCore.js';
import { MemoryStore } from '../../src/learn/HouseStore.js';

/** A pose block: eyes 3.2 cm either side of (0, 1.6, 0), looking along −Z pitched down `pitch`, asymmetric frusta. */
function poseBlock(W, H, pitch = -0.35, yaw = 0) {
  const pose = new Float64Array(POSE.LEN);
  for (let eye = 0; eye < 2; eye++) {
    const e = eye * EYE.LEN, s = eye ? 1 : -1;
    // projection: left/right asymmetric (inner half-angle smaller), near 0.1
    const l = -Math.tan(eye ? 0.7 : 0.9) * 0.1, r = Math.tan(eye ? 0.9 : 0.7) * 0.1, b = -Math.tan(0.85) * 0.1, t = Math.tan(0.75) * 0.1, n = 0.1;
    const P = [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -1, -1, 0, 0, -2 * n, 0];
    for (let i = 0; i < 16; i++) pose[e + EYE.P + i] = P[i];
    // view transform: yaw about Y, then pitch about X, at the eye
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const X = [cy, 0, -sy], Y = [sy * sp, cp, cy * sp], Z = [sy * cp, -sp, cy * cp];
    const M = [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, s * 0.032 * cy, 1.6, -s * 0.032 * sy, 1];
    for (let i = 0; i < 16; i++) pose[e + EYE.M + i] = M[i];
    pose[e + EYE.N] = 1; pose[e + EYE.N + 5] = 1; pose[e + EYE.N + 10] = 1; pose[e + EYE.N + 15] = 1;
    pose[e + EYE.NEAR] = 0.1; pose[e + EYE.FAR] = Infinity; pose[e + EYE.W] = W; pose[e + EYE.H] = H;
  }
  pose[POSE.HEAD] = 0; pose[POSE.HEAD + 1] = 1.6; pose[POSE.HEAD + 2] = 0;
  pose[POSE.EYES] = 2;
  for (let i = 0; i < 6; i++) pose[POSE.CTRL + i] = NaN;
  return pose;
}

/** A room: floor y = 0, a wall at z = −3, a wall at x = 2, a box top at y = 0.75 (x −1..0, z −2..−1.2). */
function room(ox, oy, oz, dx, dy, dz) {
  let t = Infinity;
  if (dy < 0) t = Math.min(t, -oy / dy);
  if (dz < 0) t = Math.min(t, (-3 - oz) / dz);
  if (dx > 0) t = Math.min(t, (2 - ox) / dx);
  if (dy < 0) { const tb = (0.75 - oy) / dy, x = ox + dx * tb, z = oz + dz * tb; if (x > -1 && x < 0 && z > -2 && z < -1.2 && tb < t) t = tb; }
  return t;
}
const truth = (x, y, z) => Math.min(Math.abs(y), Math.abs(z + 3), Math.abs(x - 2), (x > -1 && x < 0 && z > -2 && z < -1.2) ? Math.abs(y - 0.75) : Infinity);

test('depth: packed nearest-texel blocks decode back to the surfaces within millimetres (both eyes)', () => {
  const W = 320, H = 320, pose = poseBlock(W, H);
  const raw = renderDepth(pose, W, H, room);
  const pix = packBlocks(raw, W, H, 0.1, Infinity);
  assert.equal(pix.length, TAP.cols * TAP.eyes * TAP.rows * 4);
  const pts = new Float32Array(TAP.cols * TAP.rows * 2 * 3), org = new Float32Array(6);
  const n = decodeSlab(pix, pose, pts, org);
  assert.ok(n > 2500, `${n} points`);
  const err = [];
  for (let k = 0; k < n; k++) err.push(truth(pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]));
  err.sort((a, b) => a - b);
  const p50 = err[n >> 1], p95 = err[Math.floor(n * 0.95)];
  assert.ok(p50 < 0.002 && p95 < 0.006, `p50 ${(p50 * 1000).toFixed(2)} mm, p95 ${(p95 * 1000).toFixed(2)} mm`);
  assert.ok(Math.abs(org[0] + 0.032) < 1e-6 && Math.abs(org[3] - 0.032) < 1e-6, 'eye origins');
  // the other row convention puts the same points off the surfaces (what the calibration tells apart)
  const m = decodeSlab(pix, pose, pts, org, { rowsDown: true });
  const bad = [];
  for (let k = 0; k < m; k++) bad.push(truth(pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]));
  bad.sort((a, b) => a - b);
  assert.ok(bad[m >> 1] > 0.05, `flipped rows median ${bad[m >> 1].toFixed(3)} m`);
});

test('depth: a lower resolution (160²) and the no-data value (raw 0) work; invalid blocks are skipped', () => {
  const W = 160, H = 160, pose = poseBlock(W, H, -0.1);
  const raw = renderDepth(pose, W, H, (ox, oy, oz, dx, dy, dz) => (dz < 0 && dy < 0.2 ? room(ox, oy, oz, dx, dy, dz) : Infinity));
  const pix = packBlocks(raw, W, H, 0.1, Infinity);
  const pts = new Float32Array(TAP.cols * TAP.rows * 6), org = new Float32Array(6);
  const n = decodeSlab(pix, pose, pts, org);
  let worst = 0;
  for (let k = 0; k < n; k++) worst = Math.max(worst, truth(pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]));
  assert.ok(n > 500 && worst < 0.02, `${n} points, worst ${(worst * 1000).toFixed(1)} mm`);
});

test('learner: the first packets calibrate the row direction against Space Setup, then depth points fuse', async () => {
  const W = 320, H = 320;
  const core = new LearnCore({ store: new MemoryStore() });
  const fl = { label: 'floor', orientation: 'horizontal', pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], polygon: [[-3, -4], [3, -4], [3, 3], [-3, 3]] };
  const wl = { label: 'wall', orientation: 'vertical', pose: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1.2, -3, 1], polygon: [[-3, -1.2], [3, -1.2], [3, 1.2], [-3, 1.2]] };
  const snapshot = { planes: [fl, wl], meshes: [] };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const o = await core.open({ houseId: 'h', sig: 's', snapshot, H: I });
  assert.equal(o.loaded, false);
  let fused = 0;
  for (let k = 0; k < 10; k++) {
    const pose = poseBlock(W, H, -0.35, (k - 5) * 0.1);
    fused += core.depth(packBlocks(renderDepth(pose, W, H, room), W, H, 0.1, Infinity), pose);
  }
  const st = core.stats();
  assert.equal(st.depth, 'rows-up');
  assert.ok(st.calibResidualCm < 1, JSON.stringify(st));
  assert.ok(fused > 10000 && st.fuse.floorHits > 3000, JSON.stringify(st.fuse));
  const r = core.analyze();
  assert.ok(r && r.observedM2 > 2, JSON.stringify(r && { obs: r.observedM2 }));
});
