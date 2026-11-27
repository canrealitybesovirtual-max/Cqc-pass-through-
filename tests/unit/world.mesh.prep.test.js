// The global mesh → the game's processed mesh (src/world/MeshPrep.js) and the static collider
// geometry for physics (src/world/WorldStatics.js), on ScanSynth's scan of tests/fixtures/house.json
// (living room x −2…3, z −3…1 with a couch and a table on legs; bedroom x 3.1…6.6 with a bed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MESH, SURF, TILE_STRIDE, colliderPositions, occluderPositions, pickGlobalMesh, prepMesh } from '../../src/world/MeshPrep.js';
import { PRISM_STRIDE, ROLE, SLAB_STRIDE, buildStatics, earClip } from '../../src/world/WorldStatics.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { buildLayout } from '../../src/world/Layout.js';
import { normalizeSnapshot } from '../../src/world/Snapshot.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const snap = normalizeSnapshot(house());
const L = buildLayout(snap, { x: 0, z: 0 }, { interiorSlab: 'centred' });
const furn = (label) => L.furniture.findIndex((b) => b.label === label);
const prep = (o = {}) => {
  const s = scanFromSnapshot(snap, o);
  return prepMesh({ vertices: s.vertices, indices: s.indices, pose: s.pose }, L, { start: { x: 0, z: 0 } });
};
const base = prep();

/** Kept triangles as cyclic-canonical keys (winding kept) at quantised positions. */
function triKeys(p) {
  const V = p.vertices, I = p.indices, out = new Map();
  const q = (v) => `${Math.round(V[3 * v] * 1e3)},${Math.round(V[3 * v + 1] * 1e3)},${Math.round(V[3 * v + 2] * 1e3)}`;
  for (let t = 0; t < I.length / 3; t++) {
    const k = [q(I[3 * t]), q(I[3 * t + 1]), q(I[3 * t + 2])];
    const set = [...k].sort().join('|');
    let m = 0;
    for (let j = 1; j < 3; j++) if (k[j] < k[m]) m = j;
    out.set(set, `${k[m]}>${k[(m + 1) % 3]}>${k[(m + 2) % 3]}`);
  }
  return out;
}
function agreement(a, b) {
  const A = triKeys(a), B = triKeys(b);
  let same = 0;
  for (const [k, v] of A) if (B.get(k) === v) same++;
  return { same, total: A.size, matched: [...A.keys()].filter((k) => B.has(k)).length };
}

test('orientation: a reversed scan and a 30 % scrambled one come out wound like the true one', () => {
  assert.equal(base.stats.upVotePct, 100);
  assert.equal(base.stats.oneSided, true);
  assert.equal(base.stats.flippedPct, 0, 'a correct scan is left alone');
  const flipped = prep({ flip: true });
  assert.equal(flipped.stats.flippedPct, 100, 'every triangle reversed back');
  const a = agreement(base, flipped);
  assert.equal(a.matched, a.total);
  assert.equal(a.same, a.total, 'identical winding after the fix');
  const scr = prep({ scramble: 0.3 }); // same seed: the same positions, 30 % of the triangles reversed
  const b = agreement(base, scr);
  // ScanSynth's patches are separate grids, so a patch with no reference triangle (a table leg's
  // inner face) keeps its seed triangle's random winding; a real scan is one continuous surface
  assert.ok(b.same >= 0.95 * b.total, `${b.same} / ${b.total} kept triangles wound right after a 30 % scramble`);
  // every furniture top faces up (what an item rests on, one-sided)
  const V = scr.vertices, I = scr.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const f = scr.owner[t];
    if (f < 0) continue;
    const a = 3 * I[3 * t], b2 = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const cy = (V[a + 1] + V[b2 + 1] + V[c + 1]) / 3;
    const ux = V[b2] - V[a], uy = V[b2 + 1] - V[a + 1], uz = V[b2 + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n);
    if (Math.abs(n[1] / l) > 0.9 && cy > L.furniture[f].y1 - 0.025) assert.ok(n[1] > 0, `top triangle ${t} of ${L.furniture[f].label} faces down`);
  }
  assert.ok(scr.stats.upVotePct >= 99, `${scr.stats.upVotePct} %`);
  for (const p of [flipped, scr]) assert.deepEqual(p.stats.cropped, base.stats.cropped, 'classification does not depend on the delivered winding');
});

test('the mesh pose is applied: a scan delivered in a yawed, offset mesh space lands in the reference space', () => {
  const posed = prep({ pose: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.4, 0.05, -0.3, 1] });
  const a = agreement(base, posed);
  assert.equal(a.matched, a.total, 'same triangles at the same reference-space positions (1 mm)');
  assert.equal(a.same, a.total);
});

test('classes, owners and crops: floors, ceilings and wall faces dropped; bed and couch SOFT, the table HARD', () => {
  const s = base.stats;
  assert.ok(s.cropped.floor > 1000 && s.cropped.ceiling > 1000 && s.cropped.wall > 3000, JSON.stringify(s.cropped));
  assert.equal(s.keptTris, base.indices.length / 3);
  assert.equal(s.keptTris + s.cropped.floor + s.cropped.ceiling + s.cropped.wall + s.cropped.door + s.degenerate, s.rawTris);
  const bed = furn('bed'), couch = furn('couch'), table = furn('table');
  assert.ok(bed >= 0 && couch >= 0 && table >= 0);
  const count = (f, surf) => { let n = 0; for (let t = 0; t < base.surf.length; t++) if (base.owner[t] === f && base.surf[t] === surf) n++; return n; };
  assert.ok(count(bed, SURF.SOFT) > 100 && count(couch, SURF.SOFT) > 100 && count(table, SURF.HARD) > 100);
  assert.equal(count(bed, SURF.HARD) + count(couch, SURF.HARD) + count(table, SURF.SOFT), 0);
  // nothing kept lies flat on the floor or on a wall face
  const V = base.vertices, I = base.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const cy = (V[a + 1] + V[b + 1] + V[c + 1]) / 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const ny = (uz * vx - ux * vz) / Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    assert.ok(!(ny > 0.95 && cy < 0.04), `triangle ${t} lies on the floor`);
  }
  assert.equal(pickGlobalMesh([{ label: 'table', indices: new Uint32Array(30) }, { label: 'Global_Mesh', indices: new Uint32Array(30) }]), 1);
  assert.equal(pickGlobalMesh([{ label: null, indices: new Uint32Array(3 * 6000) }, { label: 'bed', indices: new Uint32Array(36) }]), 0);
  assert.equal(pickGlobalMesh([{ label: 'bed', indices: new Uint32Array(36) }]), -1);
});

test('open door openings are emptied (a scanned leaf or clutter in the opening is cropped)', () => {
  const d = L.doors.find((x) => x.open && x.walkable);
  assert.ok(d, 'the fixture has an open walkable door');
  // a 0.5 m "leaf" blob standing in the opening
  const p = prep({ clutter: [{ cx: d.cx, cz: d.cz, hx: 0.2, hz: 0.06, h: 1.9, yaw: Math.atan2(d.tz, d.tx) }] });
  assert.ok(p.stats.cropped.door > 10, `cropped ${p.stats.cropped.door}`);
  const V = p.vertices, I = p.indices;
  for (let t = 0; t < I.length / 3; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < 3; j++) { cx += V[3 * I[3 * t + j]] / 3; cy += V[3 * I[3 * t + j] + 1] / 3; cz += V[3 * I[3 * t + j] + 2] / 3; }
    const u = (cx - d.cx) * d.tx + (cz - d.cz) * d.tz, w = (cx - d.cx) * d.nx + (cz - d.cz) * d.nz;
    assert.ok(!(Math.abs(u) < d.width / 2 - 0.03 && Math.abs(w) < 0.3 && cy > d.y0 + 0.05 && cy < d.y1 - 0.02), `kept triangle ${t} in the door opening`);
  }
});

test('soft tops sink 1.5 cm for physics; the occluder keeps soft surfaces and moves hard ones 1 cm inward', () => {
  const col = colliderPositions(base), occ = occluderPositions(base);
  const V = base.vertices;
  let sunk = 0, hardIn = 0;
  for (let k = 0; k < base.tileVerts.length; k++) {
    const v = base.tileVerts[k];
    const dy = V[3 * v + 1] - col[3 * k + 1];
    if (base.sink[v]) { assert.ok(Math.abs(dy - MESH.softSink) < 1e-6); sunk++; } else assert.equal(dy, 0);
    const d = Math.hypot(occ[3 * k] - V[3 * v], occ[3 * k + 1] - V[3 * v + 1], occ[3 * k + 2] - V[3 * v + 2]);
    if (base.shrink[v]) {
      assert.ok(Math.abs(d - MESH.occShrink) < 1e-5, `hard vertex moved ${d}`);
      // inward: against the vertex normal (normals face free space)
      const dot = (occ[3 * k] - V[3 * v]) * base.vnormal[3 * v] + (occ[3 * k + 1] - V[3 * v + 1]) * base.vnormal[3 * v + 1] + (occ[3 * k + 2] - V[3 * v + 2]) * base.vnormal[3 * v + 2];
      assert.ok(dot < 0);
      hardIn++;
    } else assert.equal(d, 0, 'soft vertices are not moved');
  }
  assert.ok(sunk > 100 && hardIn > 100, `${sunk} sunk, ${hardIn} shrunk`);
  // the table top (hard, facing up) moves down 1 cm in the occluder
  const t = L.furniture[furn('table')];
  let found = 0;
  for (let k = 0; k < base.tileVerts.length; k++) {
    const v = base.tileVerts[k];
    if (Math.abs(V[3 * v + 1] - t.y1) < 0.007 && Math.hypot(V[3 * v] - t.cx, V[3 * v + 2] - t.cz) < 0.2 && base.vnormal[3 * v + 1] > 0.99) {
      assert.ok(Math.abs(occ[3 * k + 1] - (V[3 * v + 1] - 0.01)) < 1e-4);
      found++;
    }
  }
  assert.ok(found > 0);
});

test('tiles: contiguous, tile-local vertices and indices, nearest first, capped', () => {
  const T = base.tiles, n = base.tileCount;
  assert.ok(n >= 3, 'one tile per covered furniture owner at least');
  let next = 0, vnext = 0, prevD = -1;
  for (let k = 0; k < n; k++) {
    const o = k * TILE_STRIDE, first = T[o], count = T[o + 1], vs = T[o + 4], vc = T[o + 5];
    assert.equal(first, next, 'tiles are contiguous in triangle order');
    assert.equal(vs, vnext, 'and in the tile-local vertex layout');
    assert.ok(count > 0 && count <= MESH.maxTileTris);
    for (let i = 3 * first; i < 3 * (first + count); i++) {
      assert.ok(base.tileIdx[i] < vc);
      assert.equal(base.tileVerts[vs + base.tileIdx[i]], base.indices[i], 'local index → the same global vertex');
    }
    for (let t = first; t < first + count; t++) assert.equal(base.owner[t], T[o + 3], 'one owner per tile');
    const B = base.tileBounds, d = Math.hypot((B[6 * k] + B[6 * k + 3]) / 2, (B[6 * k + 2] + B[6 * k + 5]) / 2);
    assert.ok(d >= prevD - 1e-6, 'nearest to the start first');
    prevD = d;
    next = first + count;
    vnext = vs + vc;
  }
  assert.equal(next, base.indices.length / 3);
  assert.equal(vnext, base.tileVerts.length);
});

test('coverage: the scanned bed, couch and table are covered; a sparse scan leaves the bed and couch uncovered', () => {
  assert.deepEqual(Array.from(base.covered), [1, 1, 1]);
  const sparse = prep({ cell: 0.9 });
  assert.equal(sparse.covered[furn('couch')], 0, 'a 0.9 m scan leaves the couch under 40 triangles');
  assert.equal(sparse.covered[furn('bed')], 0);
  assert.equal(sparse.covered[furn('table')], 1, 'the table on its four legs still has 44 triangles over a whole top');
});

test('weld and degenerate triangles; a soup with no references is not trusted one-sided', () => {
  // two triangles sharing an edge written with duplicated vertices, one zero-area triangle
  const v = new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1, /**/ 1, 1, 0, 0, 1, 1, 1, 1, 1, /**/ 2, 1, 2, 2, 1, 2, 2, 1, 2]);
  const p = prepMesh({ vertices: v, indices: new Uint32Array([0, 1, 2, 3, 5, 4, 6, 7, 8]) }, buildLayout(null, { x: 0, z: 0 }));
  assert.equal(p.stats.weldedVerts, 5, 'shared corners merged, the zero-area triangle collapsed to one vertex');
  assert.equal(p.stats.degenerate, 1);
  assert.equal(p.stats.components, 1, 'one connected patch');
  assert.equal(p.stats.oneSided, false, 'no floor, wall or furniture reference: two-sided colliders');
});

test('statics: wall slabs, backstops under covered tops, the catch slab, floor prisms, P\'s chunk contract', () => {
  const g = buildStatics(L, base, colliderPositions(base));
  const walls = L.boxes.filter((b) => b.kind === 'wall').length;
  const roles = [0, 0, 0];
  for (let i = 0; i < g.slabCount; i++) roles[g.slabs[i * SLAB_STRIDE + 9]]++;
  // bed and couch: top backstop + volume backstop; table: top backstop
  assert.equal(roles[ROLE.BACKSTOP], 5);
  assert.equal(roles[ROLE.CATCH], 1);
  assert.equal(roles[ROLE.SURFACE], walls);
  // the table's backstop: 4 cm thick, top 3 cm under the real top, 3 cm in from each side
  const t = L.furniture[furn('table')];
  let tb = null;
  for (let i = 0; i < g.slabCount; i++) {
    const o = i * SLAB_STRIDE;
    if (g.slabs[o + 9] === ROLE.BACKSTOP && Math.hypot(g.slabs[o] - t.cx, g.slabs[o + 2] - t.cz) < 1e-4) tb = g.slabs.subarray(o, o + SLAB_STRIDE);
  }
  assert.ok(tb);
  assert.ok(Math.abs(tb[1] + tb[4] - (t.y1 - 0.03)) < 1e-5 && Math.abs(2 * tb[4] - 0.04) < 1e-5 && Math.abs(tb[3] - (t.hx - 0.03)) < 1e-5);
  // q = (0, qy, 0, qw) rotates local x onto the box axis (c, 0, s)
  const qy = tb[6], qw = tb[7];
  const rx = 1 - 2 * qy * qy, rz = -2 * qw * qy; // R·(1,0,0) for a rotation about y
  assert.ok(Math.abs(rx - t.c) < 1e-5 && Math.abs(rz - t.s) < 1e-5, `${rx},${rz} vs ${t.c},${t.s}`);
  // the catch slab: 2 mm under the lowest floor, at least 40 m
  const ci = Array.from({ length: g.slabCount }, (_, i) => i).find((i) => g.slabs[i * SLAB_STRIDE + 9] === ROLE.CATCH);
  const c = g.slabs.subarray(ci * SLAB_STRIDE, (ci + 1) * SLAB_STRIDE);
  const lowest = Math.min(...L.floors.filter((f) => !f.virtual).map((f) => f.y));
  assert.ok(Math.abs(c[1] + c[4] - (lowest - 0.002)) < 1e-5 && 2 * c[3] >= 40 && 2 * c[5] >= 40);
  assert.ok(Math.abs(g.catchY - (c[1] + c[4])) < 1e-6);
  // floor prisms: ear-clipped floors, 0.3 m deep
  assert.ok(g.prismCount >= 4);
  assert.equal(g.prisms.length, g.prismCount * PRISM_STRIDE);
  assert.ok(Math.abs(g.prisms[1] - g.prisms[10] - 0.3) < 1e-6, 'top 0.3 m above the bottom');
  // the mesh, in P's contract: chunks [firstTri, triCount, surf], indices into mesh.vertices
  assert.ok(g.mesh && g.oneSided);
  assert.equal(g.mesh.chunks.length, g.tileCount * 3);
  for (let k = 0; k < g.tileCount; k++) {
    const o = k * TILE_STRIDE, first = g.tiles[o], count = g.tiles[o + 1], vs = g.tiles[o + 4];
    assert.equal(g.mesh.chunks[3 * k], first);
    assert.equal(g.mesh.chunks[3 * k + 1], count);
    for (let i = 3 * first; i < 3 * (first + count); i++) assert.equal(g.mesh.indices[i], g.localIndices[i] + vs);
  }
  assert.equal(g.floorCount, L.floors.length);
  // planes only (no mesh): furniture boxes are surfaces, no backstops
  const p = buildStatics(L, null, null);
  assert.equal(p.mesh, null);
  let back = 0;
  for (let i = 0; i < p.slabCount; i++) if (p.slabs[i * SLAB_STRIDE + 9] === ROLE.BACKSTOP) back++;
  assert.equal(back, 0);
  assert.equal(p.slabCount, walls + L.furniture.length + 1);
  // ear clipping: an L-shaped (concave) floor → 4 triangles covering its area
  const Lp = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
  const tris = earClip(Lp, 6);
  assert.equal(tris.length, 12);
  let area = 0;
  for (let k = 0; k < tris.length; k += 3) {
    const [a, b, d] = [tris[k], tris[k + 1], tris[k + 2]];
    area += Math.abs((Lp[2 * b] - Lp[2 * a]) * (Lp[2 * d + 1] - Lp[2 * a + 1]) - (Lp[2 * b + 1] - Lp[2 * a + 1]) * (Lp[2 * d] - Lp[2 * a])) / 2;
  }
  assert.ok(Math.abs(area - 3) < 1e-9);
});
