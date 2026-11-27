// v0.4 verifier: a real couch. Its Space Setup volume reaches the top of the backrest (the fixture's couch volume
// is 0.85 m high and its couch plane, the seat, is at 0.45 m), so the scanned seat lies ~40 cm under the volume's
// top. ScanSynth scans every piece of furniture as a flat-topped box, which hid this: here the couch is scanned with
// a seat and a backrest. The mesh must still cover it, and the physics backstops must sit under the seat, or a gun
// laid on the seat rests on an invisible slab at backrest height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepMesh, colliderPositions } from '../../src/world/MeshPrep.js';
import { ROLE, SLAB_STRIDE, buildStatics, surfaceTops } from '../../src/world/WorldStatics.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { buildLayout } from '../../src/world/Layout.js';
import { normalizeSnapshot } from '../../src/world/Snapshot.js';
import { loadRapier } from '../../src/physics/Rapier.js';
import { PhysicsWorld, ST_RESTING } from '../../src/physics/PhysicsWorld.js';
import { K_GLOCK } from '../../src/physics/ItemShapes.js';
import { kinds } from './physics.fixtures.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

/**
 * Outward-facing, gridded faces (top and four sides) of a box in a layout box's frame: u along (c, s), v along (−s, c).
 * @param {number[]} V @param {number[]} I @param {{ cx: number, cz: number, c: number, s: number }} F
 * @param {number} u0 @param {number} u1 @param {number} v0 @param {number} v1 @param {number} y0 @param {number} y1
 */
function box(V, I, F, u0, u1, v0, v1, y0, y1, cell = 0.05) {
  const P = (u, v, y) => [F.cx + u * F.c - v * F.s, y, F.cz + u * F.s + v * F.c];
  /** a grid quad from corner o along a (na cells) and b (nb cells); a × b is the outward normal */
  const face = (o, a, b, na, nb) => {
    const base = V.length / 3;
    for (let j = 0; j <= nb; j++) for (let i = 0; i <= na; i++) {
      V.push(o[0] + (a[0] * i) / na + (b[0] * j) / nb, o[1] + (a[1] * i) / na + (b[1] * j) / nb, o[2] + (a[2] * i) / na + (b[2] * j) / nb);
    }
    for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) {
      const k = base + j * (na + 1) + i;
      I.push(k, k + na + 1, k + 1, k + 1, k + na + 1, k + na + 2);
    }
  };
  const n = (len) => Math.max(1, Math.round(len / cell));
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const c000 = P(u0, v0, y0), c100 = P(u1, v0, y0), c010 = P(u0, v1, y0), c001 = P(u0, v0, y1);
  const c101 = P(u1, v0, y1), c011 = P(u0, v1, y1), c111 = P(u1, v1, y1), c110 = P(u1, v1, y0);
  // the handedness of (u, v, y) decides which order faces outward: pick the one whose normal points away from the centre
  const quad = (o, a, b, na, nb, out) => {
    const nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) face(o, a, b, na, nb);
    else face(o, b, a, nb, na);
  };
  const mid = P((u0 + u1) / 2, (v0 + v1) / 2, (y0 + y1) / 2);
  const outOf = (p) => sub(p, mid);
  const du = u1 - u0, dv = v1 - v0, dy = y1 - y0;
  quad(c001, sub(c101, c001), sub(c011, c001), n(du), n(dv), [0, 1, 0]); // top
  quad(c000, sub(c100, c000), sub(c001, c000), n(du), n(dy), outOf(P((u0 + u1) / 2, v0, (y0 + y1) / 2))); // side v0
  quad(c010, sub(c110, c010), sub(c011, c010), n(du), n(dy), outOf(P((u0 + u1) / 2, v1, (y0 + y1) / 2))); // side v1
  quad(c000, sub(c010, c000), sub(c001, c000), n(dv), n(dy), outOf(P(u0, (v0 + v1) / 2, (y0 + y1) / 2))); // side u0
  quad(c100, sub(c110, c100), sub(c101, c100), n(dv), n(dy), outOf(P(u1, (v0 + v1) / 2, (y0 + y1) / 2))); // side u1
  void c111;
}

/** The fixture house with a real couch (seat at the couch plane, backrest up to the volume's top), prepared. */
function realCouch() {
  const full = normalizeSnapshot(house());
  const L = buildLayout(full, { x: 0, z: 0 }, { interiorSlab: 'centred' });
  const k = L.furniture.findIndex((b) => b.label === 'couch');
  const F = L.furniture[k];
  const seatPlane = full.planes.find((p) => p.label === 'couch');
  const seatY = seatPlane ? seatPlane.pose[13] : 0.45;
  const h = house();
  h.meshes = h.meshes.filter((m) => m.label !== 'couch');
  h.planes = h.planes.filter((p) => p.label !== 'couch');
  const s = scanFromSnapshot(normalizeSnapshot(h), {});
  const V = Array.from(s.vertices), I = Array.from(s.indices);
  const hu = F.hx - 0.01, hv = F.hz - 0.01;
  box(V, I, F, -hu, hu, -hv, hv - 0.25, F.y0, seatY); // seat (front)
  box(V, I, F, -hu, hu, hv - 0.25, hv, F.y0, F.y1 - 0.02); // backrest (back)
  const p = prepMesh({ vertices: new Float32Array(V), indices: new Uint32Array(I), pose: s.pose }, L, { start: { x: 0, z: 0 } });
  return { L, k, F, seatY, p, hu, hv };
}

test('physics: a Glock dropped 0.4 m onto the real couch\'s seat comes to rest on the seat, not on a slab at backrest height', async () => {
  const { L, F, seatY, p, hv } = realCouch();
  const g = buildStatics(L, p, colliderPositions(p));
  const { R } = await loadRapier();
  const P = new PhysicsWorld(R);
  for (const kd of kinds()) assert.ok(P.defineKind(kd.kind, kd.def));
  P.beginStatic(g);
  let n = 0;
  while (!P.buildSlice(4)) assert.ok(++n < 200, 'the build ends');
  // over the middle of the seat (v = the seat's centre in the couch's frame)
  const v = (-hv + hv - 0.25) / 2, x = F.cx - v * F.s, z = F.cz + v * F.c;
  const id = P.spawn(K_GLOCK, Float64Array.of(x, seatY + 0.4, z, 0, 0, 0.7071068, 0.7071068), 0, 0, 0, 0, 0, 0);
  assert.ok(id >= 0);
  for (let t = 0; t < 4 && P.state(id) !== ST_RESTING; t += 1 / 72) P.step(1 / 72);
  const out = new Float64Array(7);
  P.pose(id, out, 0);
  assert.equal(P.state(id), ST_RESTING, "it comes to rest");
  assert.ok(out[1] > seatY - 0.04 && out[1] < seatY + 0.08, `at y ${out[1].toFixed(3)}: on the seat (${seatY}), not at the volume's top (${F.y1.toFixed(3)})`);
});

test('a real couch (seat 40 cm under its volume\'s top, the backrest): covered by the mesh, backstops under the seat', () => {
  const full = normalizeSnapshot(house());
  const L = buildLayout(full, { x: 0, z: 0 }, { interiorSlab: 'centred' });
  const k = L.furniture.findIndex((b) => b.label === 'couch');
  assert.ok(k >= 0);
  const F = L.furniture[k];
  const seatPlane = full.planes.find((p) => p.label === 'couch');
  const seatY = seatPlane ? seatPlane.pose[13] : 0.45;
  assert.ok(F.y1 - seatY > 0.3, `the fixture's couch volume (top ${F.y1}) reaches well above its seat plane (${seatY})`);
  // the house scanned without the couch, plus a couch with a seat and a backrest
  const h = house();
  h.meshes = h.meshes.filter((m) => m.label !== 'couch');
  h.planes = h.planes.filter((p) => p.label !== 'couch');
  const s = scanFromSnapshot(normalizeSnapshot(h), {});
  const V = Array.from(s.vertices), I = Array.from(s.indices);
  const hu = F.hx - 0.01, hv = F.hz - 0.01;
  box(V, I, F, -hu, hu, -hv, hv - 0.25, F.y0, seatY); // seat (front)
  box(V, I, F, -hu, hu, hv - 0.25, hv, F.y0, F.y1 - 0.02); // backrest (back)
  const p = prepMesh({ vertices: new Float32Array(V), indices: new Uint32Array(I), pose: s.pose }, L, { start: { x: 0, z: 0 } });
  assert.equal(p.covered[k], 1, 'the mesh covers the couch (its seat counts, not only what is near the volume\'s top)');
  const tops = surfaceTops(L, p);
  assert.ok(Math.abs(tops[k] - seatY) < 0.02, `lowest real top ${tops[k]} ≈ the seat ${seatY}`);
  const g = buildStatics(L, p, colliderPositions(p));
  let n = 0, highest = -Infinity;
  for (let i = 0; i < g.slabCount; i++) {
    const o = i * SLAB_STRIDE;
    if (Math.hypot(g.slabs[o] - F.cx, g.slabs[o + 2] - F.cz) > 1e-4) continue;
    assert.equal(g.slabs[o + 9], ROLE.BACKSTOP, 'a covered couch has backstops, not a surface box');
    n++;
    highest = Math.max(highest, g.slabs[o + 1] + g.slabs[o + 4]);
  }
  assert.equal(n, 2, 'the top backstop and the volume backstop');
  assert.ok(highest <= seatY - 0.025, `backstops top out at ${highest.toFixed(3)} m, under the seat (${seatY}); the volume's top is ${F.y1.toFixed(3)}`);
  // the flat fixture furniture: 3 cm under the volume's top (the table), or under its sagging scan (the bed, the couch)
  const base = normalizeSnapshot(house());
  const sb = scanFromSnapshot(base, {});
  const pb = prepMesh({ vertices: sb.vertices, indices: sb.indices, pose: sb.pose }, L, { start: { x: 0, z: 0 } });
  const tb = surfaceTops(L, pb);
  const gb = buildStatics(L, pb, colliderPositions(pb));
  for (const label of ['table', 'bed', 'couch']) {
    const j = L.furniture.findIndex((b) => b.label === label), B = L.furniture[j];
    for (let i = 0; i < gb.slabCount; i++) {
      const o = i * SLAB_STRIDE;
      if (gb.slabs[o + 9] !== ROLE.BACKSTOP || Math.hypot(gb.slabs[o] - B.cx, gb.slabs[o + 2] - B.cz) > 1e-4) continue;
      const top = gb.slabs[o + 1] + gb.slabs[o + 4];
      // (a scan within topKeep = 1 cm of the volume's top leaves the backstop where it was)
      assert.ok(top <= Math.min(B.y1, tb[j] + 0.01) - 0.029, `${label}: backstop top ${top.toFixed(3)} under min(volume ${B.y1.toFixed(3)}, scan ${tb[j].toFixed(3)}) − 3 cm`);
    }
  }
});
