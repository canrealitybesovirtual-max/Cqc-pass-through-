// Pure helpers of the offline asset bake (tools/assets/lib): geometry, atlas
// packing and the visibility rasteriser. No dependencies needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mat4Mul, mat4Invert, mat4Compose, mat4Decompose, quatFromRot3, rot3FromFrames, xfPoint, weldByPosition, triangleComponents,
  boundaryEdgeCount, filterTriangles, weldExact, fitLine, fitCircle, sphereDirections, rayTriangle, cross, normalize,
} from '../../tools/assets/lib/geom.mjs';
import { skylinePack, packScaled, remapUV } from '../../tools/assets/lib/pack.mjs';
import { markVisible, dilateVisible } from '../../tools/assets/lib/raster.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** Unit cube as 12 triangles (outward winding) with optional offset and size. */
function cube(cx = 0, cy = 0, cz = 0, s = 1) {
  const h = s / 2;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const pos = new Float32Array(v.flatMap(([x, y, z]) => [x + cx, y + cy, z + cz]));
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const idx = new Uint32Array(faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  return { pos, idx };
}

test('mat4 compose / decompose / invert round trip', () => {
  const q = normalize([0.2, -0.5, 0.3]);
  const ang = 0.7;
  const quat = [q[0] * Math.sin(ang / 2), q[1] * Math.sin(ang / 2), q[2] * Math.sin(ang / 2), Math.cos(ang / 2)];
  const m = mat4Compose([1, 2, 3], quat, [2, 2, 2]);
  const d = mat4Decompose(m);
  d.t.forEach((x, i) => near(x, [1, 2, 3][i], 1e-12));
  d.s.forEach((x) => near(x, 2, 1e-12));
  d.q.forEach((x, i) => near(x, quat[i], 1e-9));
  const id = mat4Mul(m, mat4Invert(m));
  id.forEach((x, i) => near(x, i % 5 === 0 ? 1 : 0, 1e-12));
  const p = xfPoint(m, 1, 0, 0);
  assert.equal(p.length, 3);
});

test('rot3FromFrames maps one frame onto another; quatFromRot3 of identity', () => {
  const from = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const to = [[0, 0, -1], [0, 1, 0], [1, 0, 0]]; // 90 deg about +Y
  const r = rot3FromFrames(from, to);
  // column 0 of r = image of +X
  near(r[0], 0); near(r[1], 0); near(r[2], -1);
  const q = quatFromRot3([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(q.map((x) => Math.round(x * 1e9) / 1e9), [0, 0, 0, 1]);
});

test('weld + components split separate cubes and find closed meshes', () => {
  const a = cube(0, 0, 0), b = cube(3, 0, 0);
  const pos = new Float32Array([...a.pos, ...b.pos]);
  const idx = new Uint32Array([...a.idx, ...Array.from(b.idx, (i) => i + 8)]);
  const rep = weldByPosition(pos, 1e-6);
  const { triComp, count } = triangleComponents(idx, rep);
  assert.equal(count, 2);
  assert.equal(new Set(triComp.slice(0, 12)).size, 1);
  assert.notEqual(triComp[0], triComp[12]);
  assert.equal(boundaryEdgeCount(idx, rep), 0);
  assert.equal(boundaryEdgeCount(idx.slice(0, 33), rep), 3); // one triangle removed -> a 3-edge hole
});

test('weldExact merges duplicated vertices and drops collapsed triangles', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0]);
  const m = weldExact({ pos, nrm, uv, idx: new Uint32Array([0, 1, 2, 2, 3, 0, 1, 3, 2]) });
  assert.equal(m.pos.length / 3, 3);
  assert.equal(m.idx.length, 6); // the 1-3-2 triangle collapsed (1 and 3 are the same vertex)
  const f = filterTriangles(m, (t) => t === 0);
  assert.equal(f.idx.length, 3);
});

test('fitLine and fitCircle recover known shapes', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push(1 + i * 0.1, 2 + i * 0.2, -i * 0.3);
  const l = fitLine(new Float32Array(pts));
  const d = normalize([0.1, 0.2, -0.3]);
  near(Math.abs(l.dir[0] * d[0] + l.dir[1] * d[1] + l.dir[2] * d[2]), 1, 1e-6);
  const xs = [], ys = [];
  for (let i = 0; i < 24; i++) { xs.push(0.004 + 0.0046 * Math.cos(i / 24 * 6.283)); ys.push(0.125 + 0.0046 * Math.sin(i / 24 * 6.283)); }
  const c = fitCircle(xs, ys);
  near(c.cx, 0.004, 1e-9); near(c.cy, 0.125, 1e-9); near(c.r, 0.0046, 1e-9);
});

test('sphereDirections are unit and spread over both hemispheres', () => {
  const d = sphereDirections(100);
  assert.equal(d.length, 100);
  for (const v of d) near(Math.hypot(...v), 1, 1e-9);
  assert.ok(d.some((v) => v[1] > 0.9) && d.some((v) => v[1] < -0.9));
});

test('rayTriangle hits and misses', () => {
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0];
  near(rayTriangle([0.2, 0.2, 1], [0, 0, -1], a, b, c), 1, 1e-12);
  assert.equal(rayTriangle([0.8, 0.8, 1], [0, 0, -1], a, b, c), -1);
  assert.equal(rayTriangle([0.2, 0.2, 1], [0, 0, 1], a, b, c), -1);
  assert.deepEqual(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
});

test('skylinePack places non-overlapping rects inside the bin', () => {
  const sizes = [{ w: 1024, h: 1024 }, { w: 1024, h: 1024 }, { w: 1024, h: 512 }, { w: 512, h: 512 }];
  const r = skylinePack(sizes, 2048, 2048);
  assert.ok(r);
  for (let i = 0; i < r.length; i++) {
    assert.ok(r[i].x >= 0 && r[i].y >= 0 && r[i].x + r[i].w <= 2048 && r[i].y + r[i].h <= 2048);
    for (let j = i + 1; j < r.length; j++) {
      const o = r[i].x < r[j].x + r[j].w && r[j].x < r[i].x + r[i].w && r[i].y < r[j].y + r[j].h && r[j].y < r[i].y + r[i].h;
      assert.ok(!o, `rects ${i} and ${j} overlap`);
    }
  }
  assert.equal(skylinePack([{ w: 3000, h: 10 }], 2048, 2048), null);
});

test('packScaled shrinks tiles to fit, with padding and 4-pixel alignment', () => {
  const sizes = Array.from({ length: 5 }, () => ({ w: 1024, h: 1024 }));
  const p = packScaled(sizes, 2048, 2048, 4);
  assert.ok(p && p.scale < 1 && p.scale > 0.6);
  for (const r of p.rects) { assert.equal(r.w % 4, 0); assert.equal(r.h % 4, 0); assert.ok(r.x >= 4 && r.y >= 4); }
  const one = packScaled([{ w: 1000, h: 1000 }], 2048, 2048, 4);
  assert.equal(one?.scale, 1);
  const [u, v] = remapUV(0.5, 0.25, { u0: 0, v0: 0, u1: 1, v1: 1 }, { x: 1024, y: 0, w: 1024, h: 1024 }, 2048, 2048);
  near(u, 0.75); near(v, 0.125);
});

test('markVisible: a cube inside a bigger cube is hidden; dilation keeps neighbours of seen triangles', () => {
  const outer = cube(0, 0, 0, 2), inner = cube(0, 0, 0, 0.5);
  const counts = [new Uint32Array(24), new Uint32Array(24)];
  markVisible([{ ...outer, cull: true }, { ...inner, cull: true }], sphereDirections(40), 128, counts);
  const seen = (c, t) => c[t * 2] + c[t * 2 + 1] > 0;
  assert.ok(Array.from({ length: 12 }, (_, t) => seen(counts[0], t)).every(Boolean), 'every outer face seen');
  assert.ok(Array.from({ length: 12 }, (_, t) => !seen(counts[1], t)).every(Boolean), 'inner cube hidden');
  // open the outer cube's +Z face (triangles 2, 3): the inner cube's +Z side becomes visible
  const open = { pos: outer.pos, idx: outer.idx.filter((_, i) => Math.floor(i / 3) !== 2 && Math.floor(i / 3) !== 3), cull: true };
  const c2 = [new Uint32Array(20), new Uint32Array(24)];
  markVisible([open, { ...inner, cull: true }], sphereDirections(60), 128, c2);
  assert.ok(seen(c2[1], 2) || seen(c2[1], 3), 'inner +Z face visible through the opening');
  const keep = dilateVisible(inner.idx, weldByPosition(inner.pos, 1e-6), c2[1]);
  assert.ok(keep.reduce((a, b) => a + b, 0) > 2);
});
