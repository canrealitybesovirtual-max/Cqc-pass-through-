/**
 * Realign (src/world/Realign.js): reset transforms, moving a snapshot, the
 * drift watch, and WorldCore.realign rebuilding the world in the moved space.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldCore } from '../../src/world/WorldCore.js';
import { captureSnapshot } from '../../src/world/Snapshot.js';
import { DriftWatch, mul4, pickReferencePlanes, resetTransform, rigidFromPoses, rigidInverse, transformSnapshot } from '../../src/world/Realign.js';
import { userHouse } from './world.houses.js';

/** Yaw about +Y then a translation, column-major. @param {number} yaw @param {number} tx @param {number} tz @param {number} [ty] */
function yawT(yaw, tx, tz, ty = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float64Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]);
}
/** @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z */
function apply(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

test('resetTransform: the event gives the new origin in the old space; the result maps old → new', () => {
  const yaw = 0.5, h = yaw / 2;
  const t = { position: { x: 1, y: 0, z: 2 }, orientation: { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) } };
  const m = resetTransform(t);
  assert.ok(m);
  // a point given in the NEW space, seen in the old one: p_old = T · p_new
  const T = rigidInverse(/** @type {Float64Array} */ (m), new Float64Array(16));
  const pNew = [0.5, 1.2, 0.3];
  const pOld = apply(T, ...pNew);
  const back = apply(/** @type {Float64Array} */ (m), ...pOld);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - pNew[i]) < 1e-9);
  // the matrix form gives the same
  const m2 = resetTransform({ matrix: T });
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(/** @type {Float64Array} */ (m2)[i] - /** @type {Float64Array} */ (m)[i]) < 1e-9);
  assert.equal(resetTransform(null), null);
  assert.equal(resetTransform({ matrix: [1, 2] }), null);
});

test('rigidFromPoses recovers a yaw + offset from one plane seen before and after', () => {
  const X = yawT(0.2, 0.7, -0.4, 0.01);
  const old = yawT(1.1, 3, 2);
  const now = mul4(X, old, new Float64Array(16));
  const out = new Float64Array(16);
  const parts = rigidFromPoses(old, now, out);
  assert.ok(Math.abs(parts.dyaw - 0.2) < 1e-9);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(out[i] - X[i]) < 1e-9, `m[${i}]`);
});

test('WorldCore.realign: the world follows the moved space (rooms, walls, raycasts), doors kept, bake restarts', () => {
  const b = userHouse();
  const w = new WorldCore({ roam: true });
  const [px, pz] = b.toWorld(6, 2.8);
  w.build(b.build(), { x: px, z: pz }, { doors: [true, false] });
  w.finishBake();
  const rooms = w.roamIndex.roomCount;
  const [ax, az] = b.toWorld(2, 2.5);
  const cellsBefore = w.roamIndex.roomCells[w.roomAt(ax, az)];
  const hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
  const [dx, dz] = b.dirToWorld(1, 0);
  assert.ok(w.raycast(ax, 1.2, az, dx, 0, dz, 10, hit));
  const before = hit.dist;
  const X = yawT(0.35, 1.5, -2.0);
  w.realign(X);
  assert.equal(w.stats.realigns, 1);
  assert.equal(w.bakeDone, false, 'the Roam bake restarted');
  w.finishBake();
  assert.equal(w.roamIndex.roomCount, rooms);
  assert.equal(w.layout.doors[1].open, false, 'door flags kept');
  const [mx, , mz] = apply(X, ax, 0, az);
  assert.ok(w.roomAt(mx, mz) > 0);
  const cellsA = w.roamIndex.roomCells[w.roomAt(mx, mz)];
  assert.ok(Math.abs(cellsA - cellsBefore) < 0.08 * cellsBefore, `the same room, moved (${cellsBefore} → ${cellsA} cells, re-rasterised at another angle)`);
  const [ddx, , ddz] = apply([X[0], X[1], X[2], 0, X[4], X[5], X[6], 0, X[8], X[9], X[10], 0, 0, 0, 0, 1], dx, 0, dz);
  assert.ok(w.raycast(mx, 1.2, mz, ddx, 0, ddz, 10, hit));
  assert.ok(Math.abs(hit.dist - before) < 0.12, `same wall distance after the move (${before.toFixed(3)} → ${hit.dist.toFixed(3)})`);
  const [sx, , sz] = apply(X, px, 0, pz);
  assert.ok(Math.abs(w.start.x - sx) < 1e-9 && Math.abs(w.start.z - sz) < 1e-9, 'the start moved too');
});

test('DriftWatch: reference planes, no trigger under 0.10 m / 2°, a realign after 2 checks over, correction ≈ the drift', () => {
  const b = userHouse();
  const snap = b.build();
  const refs = pickReferencePlanes(snap);
  assert.equal(refs.length, 3);
  assert.equal(snap.planes[refs[0]].label, 'floor');
  assert.equal(snap.planes[refs[1]].orientation, 'vertical');
  const dw = new DriftWatch();
  dw.setReference(snap, refs);
  assert.equal(dw.refs, 3);
  assert.equal(dw.due(0), true);
  const tmp = new Float64Array(16);
  /** @param {Float64Array} X */
  const sampleAll = (X) => { for (let r = 0; r < 3; r++) dw.sample(r, mul4(X, snap.planes[refs[r]].pose, tmp)); return dw.evaluate(); };
  // small: 0.1° (a plane origin 16 m away moves 3 cm by the turn) + 3 cm
  assert.equal(sampleAll(yawT(0.002, 0.03, 0.01)), false, 'small drift');
  assert.equal(sampleAll(yawT(0.002, 0.03, 0.01)), false);
  const X = yawT(0.0, 0.18, -0.05);
  assert.equal(sampleAll(X), false, 'first check over: wait for a second');
  assert.equal(sampleAll(X), true, 'second check over: realign');
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(dw.correction[i] - X[i]) < 1e-5, `correction[${i}]`);
  const rep = dw.report();
  assert.equal(rep.triggers, 1);
  assert.ok(rep.maxM > 0.18);
  dw.rebase();
  assert.equal(sampleAll(X), false, 'after the rebase the drifted poses are the reference');
  // check() with a fake frame: getPose per plane (a missing pose is counted, not a drift)
  const planes = refs.map((i) => ({ planeSpace: { i } }));
  const frame = { getPose: (/** @type {any} */ sp) => (sp.i === refs[0] ? null : { transform: { matrix: snap.planes[sp.i].pose } }) };
  assert.equal(dw.check(frame, {}, planes, 10), false);
  assert.ok(dw.stats.missing > 0);
  assert.equal(dw.due(10.5), false);
  assert.equal(dw.due(11), true);
});

test('transformSnapshot moves every pose and keeps polygons; captureSnapshot keeps the live planes in order', () => {
  const snap = userHouse().build();
  const X = yawT(1.0, 2, 3);
  const moved = transformSnapshot(snap, X, 'unbounded');
  assert.equal(moved.space, 'unbounded');
  assert.equal(moved.planes.length, snap.planes.length);
  assert.equal(moved.meshes.length, snap.meshes.length);
  const p0 = snap.planes[0].pose, q0 = moved.planes[0].pose;
  const e = apply(X, p0[12], p0[13], p0[14]);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(q0[12 + i] - e[i]) < 1e-5);
  assert.deepEqual(moved.planes[3].polygon, snap.planes[3].polygon);
  // capture: keep[i] is the XRPlane of snap.planes[i] (planes without a pose are skipped in both)
  const mk = (label, ok) => ({ semanticLabel: label, orientation: 'horizontal', planeSpace: { ok }, polygon: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] });
  const pl = [mk('floor', true), mk('table', false), mk('ceiling', true)];
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const frame = { detectedPlanes: new Set(pl), detectedMeshes: new Set(), getPose: (/** @type {any} */ s) => (s.ok ? { transform: { matrix: id } } : null) };
  const keep = [];
  const cap = captureSnapshot(frame, {}, { keep });
  assert.equal(cap.planes.length, 2);
  assert.equal(keep.length, 2);
  assert.equal(keep[0], pl[0]);
  assert.equal(keep[1], pl[2]);
});
