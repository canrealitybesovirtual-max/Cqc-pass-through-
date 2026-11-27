/**
 * The pure physics modules: PoseHistory (the throw estimate), ItemRules
 * (release, landing sounds), Guard (ids, input checks), StaticGeometry
 * (planes-only colliders from the fixture house) and ItemShapes (hulls).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PoseHistory, Velocity, HISTORY } from '../../src/physics/PoseHistory.js';
import {
  ITEMS, releaseKind, REL_HOLSTER, REL_PLACE, REL_THROW, isSetDown, landingClass, landingGain,
  LAND_NONE, LAND_CONTACT, LAND_BOUNCE, LAND_HIT, pickScore,
} from '../../src/physics/ItemRules.js';
import { Guard, makeId, slotOf, genOf, nextGen, okVec, okQuat, okArray } from '../../src/physics/Guard.js';
import { staticFromLayout, staticFromWorld, insideHouse, earClip, seatHeight, surfOfLabel, SURF, ROLE, STATIC } from '../../src/physics/StaticGeometry.js';
import { extremePoints, hullsFromBins, hullBounds, GUN_BINS, itemKinds, magMass, K_GLOCK, K_AKM, K_MAG9, K_MAG762, KIND_COUNT } from '../../src/physics/ItemShapes.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { cloud, GLOCK_CLOUD, AKM_CLOUD } from './physics.fixtures.js';

const HOUSE = JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (±${eps})`);

/** Quaternion about a unit axis. */
const qAxis = (x, y, z, a) => [x * Math.sin(a / 2), y * Math.sin(a / 2), z * Math.sin(a / 2), Math.cos(a / 2)];

// ── PoseHistory ──────────────────────────────────────────────────────────────

test('PoseHistory: a straight 4 m/s throw is estimated within 10 %; no spin', () => {
  const h = new PoseHistory(), v = new Velocity();
  for (let i = 0; i < 12; i++) { const t = i / 72; h.pushPQ(t, 0.3 + 4 * t, 1.2, -0.4, 0, 0, 0, 1); }
  assert.ok(h.velocity(0, 0, 0, v));
  near(v.vx, 4, 0.4, 'vx'); near(v.vy, 0, 0.05); near(v.vz, 0, 0.05);
  near(v.ang, 0, 1e-6, 'ang');
  assert.ok(v.n >= 3 && v.n <= 7, `samples in the 70 ms window: ${v.n}`);
  assert.equal(isSetDown(v.lin, v.ang), false);
});

test('PoseHistory: a 15 rad/s flick about the grip gives ω within 10 % and v_com = ω × r', () => {
  const h = new PoseHistory(), v = new Velocity();
  const w = 15;
  for (let i = 0; i < 10; i++) { const t = i / 90, q = qAxis(0, 0, 1, w * t); h.pushPQ(t, 0, 1, 0, q[0], q[1], q[2], q[3]); }
  assert.ok(h.velocity(0, 0.1, 0, v));
  near(v.wz, w, 1.5, 'wz'); near(v.wx, 0, 0.01); near(v.wy, 0, 0.01);
  // com at r = R·(0, 0.1, 0); v = ω × r, |v| = 15 × 0.1
  near(v.lin, w * 0.1, 0.15, 'centre-of-mass speed');
  const a = w * 9 / 90, rx = -0.1 * Math.sin(a), ry = 0.1 * Math.cos(a);
  near(v.vx, -v.wz * ry, 0.05, 'vx = −ω·ry'); near(v.vy, v.wz * rx, 0.05, 'vy = ω·rx');
});

test('PoseHistory: a set-down with 2 cm/s tremor counts as a place; a tracking jump clears the history; the caps hold', () => {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5);
  const h = new PoseHistory(), v = new Velocity();
  for (let i = 0; i < 20; i++) { const t = i / 72; h.pushPQ(t, 0.02 * t * rnd() * 2, 0.6 + 0.0003 * rnd(), 0.0003 * rnd(), 0, 0, 0, 1); }
  assert.ok(h.velocity(0, 0, 0, v));
  assert.ok(v.lin < ITEMS.setDownLin, `tremor ${v.lin}`);
  assert.ok(isSetDown(v.lin, v.ang));
  assert.equal(releaseKind(1, 1, Infinity, v.lin, v.ang), REL_PLACE);
  // jump: 0.5 rad in one frame
  const q = qAxis(0, 1, 0, 0.5);
  h.pushPQ(21 / 72, 0, 0.6, 0, q[0], q[1], q[2], q[3]);
  assert.equal(h.count, 1);
  assert.equal(h.jumps, 1);
  assert.equal(h.velocity(0, 0, 0, v), false, 'one sample: no estimate');
  assert.equal(v.lin, 0);
  // 0.3 m in one frame is a jump too
  h.pushPQ(22 / 72, 0.3, 0.6, 0, q[0], q[1], q[2], q[3]);
  assert.equal(h.count, 1);
  // caps: 30 m/s and 60 rad/s
  const c = new PoseHistory();
  for (let i = 0; i < 10; i++) { const t = i / 120, r = qAxis(1, 0, 0, 0.4 * i); c.pushPQ(t, 0.2 * i, 0, 0, r[0], r[1], r[2], r[3]); }
  assert.ok(c.velocity(0, 0, 0, v));
  near(v.lin, HISTORY.maxLin, 1e-9, 'linear cap');
  near(v.ang, HISTORY.maxAng, 1e-9, 'angular cap');
});

test('PoseHistory: sample(age) interpolates between samples; a matrix push equals a pose push; NaN is ignored', () => {
  const h = new PoseHistory();
  for (let i = 0; i < 5; i++) h.pushPQ(i * 0.01, i * 0.01, 0, 0, 0, 0, 0, 1);
  const o = new Float64Array(7);
  assert.ok(h.sample(0.015, o));
  near(o[0], 0.025, 1e-9);
  assert.ok(h.sample(1, o));
  near(o[0], 0, 1e-12, 'older than the history: the oldest');
  near(h.span, 0.04, 1e-12);
  h.pushPQ(NaN, 0, 0, 0, 0, 0, 0, 1);
  h.pushPQ(0.05, NaN, 0, 0, 0, 0, 0, 1);
  assert.equal(h.count, 5);
  const m = new PoseHistory(), q = qAxis(0, 1, 0, 0.3);
  const c = Math.cos(0.3), sn = Math.sin(0.3);
  m.push(0, [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, 1, 2, 3, 1]);
  m.sample(0, o);
  near(o[0], 1, 1e-12); near(o[1], 2, 1e-12); near(o[2], 3, 1e-12);
  near(Math.abs(o[4]), Math.abs(q[1]), 1e-9); near(Math.abs(o[6]), Math.abs(q[3]), 1e-9);
});

// ── ItemRules ────────────────────────────────────────────────────────────────

test('ItemRules: holster only near the slot, muzzle within 60°, nothing within 3 cm below; else place or throw', () => {
  assert.equal(releaseKind(0.1, 0.9, Infinity, 2, 2), REL_HOLSTER);
  assert.equal(releaseKind(0.1, 0.9, 0.2, 0.1, 0.1), REL_HOLSTER, 'a surface 20 cm below does not matter');
  assert.equal(releaseKind(0.1, 0.9, 0.02, 0.1, 0.1), REL_PLACE, 'laid on the bed beside the hip: set down');
  assert.equal(releaseKind(0.1, 0.3, Infinity, 0.1, 0.1), REL_PLACE, 'muzzle 73° off the holster axis');
  assert.equal(releaseKind(0.3, 1, Infinity, 0.1, 0.1), REL_PLACE, 'beyond 0.24 m');
  assert.equal(releaseKind(0.3, 1, Infinity, 0.5, 0.1), REL_THROW);
  assert.equal(releaseKind(0.3, 1, Infinity, 0.1, 2.5), REL_THROW);
  assert.equal(releaseKind(NaN, 1, Infinity, 0.1, 0.1), REL_PLACE, 'NaN never holsters');
  assert.equal(isSetDown(NaN, 0), true, 'no estimate: a plain drop with no velocity');
});

test('ItemRules: landing classes by the CQC thresholds, gain rising with the impact; pick-up score', () => {
  assert.equal(landingClass(0.2), LAND_NONE);
  assert.equal(landingClass(0.45), LAND_CONTACT);
  assert.equal(landingClass(0.8), LAND_BOUNCE);
  assert.equal(landingClass(1.1), LAND_HIT);
  assert.equal(landingClass(NaN), LAND_NONE);
  assert.ok(landingGain(0.45) < landingGain(0.8) && landingGain(0.8) < landingGain(2) && landingGain(5) === 1);
  assert.equal(landingGain(0.1), 0);
  assert.equal(pickScore(0.13, 1, 0.13, 0.05), 1);
  assert.equal(pickScore(1, 0.025, 0.13, 0.05), 0.5);
});

// ── Guard ────────────────────────────────────────────────────────────────────

test('Guard: ids carry a generation; inputs are checked (NaN, range, quaternion length); the first failure sticks', () => {
  const id = makeId(5, 7);
  assert.equal(slotOf(id), 5); assert.equal(genOf(id), 7);
  assert.notEqual(makeId(5, nextGen(7)), id);
  assert.equal(nextGen(0x7fff), 1, 'wraps past 0');
  assert.equal(okVec(1, 2, 3), true);
  assert.equal(okVec(NaN, 0, 0), false);
  assert.equal(okVec(0, Infinity, 0), false);
  assert.equal(okVec(0, 0, 2e3), false);
  assert.equal(okQuat(0, 0, 0, 1), true);
  assert.equal(okQuat(0, 0, 0, 0), false);
  assert.equal(okQuat(NaN, 0, 0, 1), false);
  assert.equal(okArray([1, 2, NaN]), false);
  const g = new Guard();
  g.fail(new Error('recursive use of an object'), 'step');
  g.fail(new Error('second'), 'flush');
  assert.equal(g.failed, true);
  assert.equal(g.where, 'step');
  assert.match(g.error, /recursive use/);
  assert.equal(g.report().failed, true);
});

// ── StaticGeometry ───────────────────────────────────────────────────────────

test('StaticGeometry from the fixture house: walls, floor prisms, catch slab, a table top only, the couch at its seat, the bed soft', () => {
  const W = new WorldCore({ roam: true });
  W.build(HOUSE, { x: 0, z: -1 });
  const L = W.layout;
  const g = staticFromLayout(L, { snapshot: HOUSE });
  const S = STATIC.slabStride, slabs = [];
  for (let i = 0; i < g.slabCount; i++) slabs.push(Array.from(g.slabs.subarray(i * S, i * S + S)));
  const walls = L.boxes.filter((b) => b.kind === 'wall').length;
  assert.equal(slabs.filter((s) => s[8] === SURF.WALL).length, walls, 'one slab per wall piece');
  const catchS = slabs.filter((s) => s[9] === ROLE.CATCH);
  assert.equal(catchS.length, 1);
  near(catchS[0][1] + catchS[0][4], L.floorY0 - STATIC.catchDrop, 1e-5, 'catch top 2 mm under the floor');
  assert.ok(catchS[0][3] >= 20 && catchS[0][5] >= 20, 'at least 40 m');
  near(g.catchY, L.floorY0 - STATIC.catchDrop, 1e-9);
  const top = (s) => s[1] + s[4], byCentre = (x, z) => slabs.find((s) => Math.hypot(s[0] - x, s[2] - z) < 0.05 && s[8] !== SURF.WALL && s[9] === ROLE.SURFACE);
  const table = byCentre(1.4, -1.8), couch = byCentre(-1.5, -1.5), bed = byCentre(5.6, -1.1);
  assert.ok(table && couch && bed, 'one slab per piece of furniture');
  assert.equal(table[8], SURF.HARD);
  near(top(table), 0.75, 0.005, 'table top');
  near(table[4], STATIC.topSlab / 2, 1e-6, 'only the 4 cm top: the space under the table stays open');
  assert.equal(couch[8], SURF.SOFT);
  near(top(couch), 0.45 - STATIC.softSink, 0.005, 'couch at its seat plane (the volume reaches the backrest)');
  assert.equal(bed[8], SURF.SOFT);
  near(top(bed), 0.55 - STATIC.softSink, 0.01, 'bed top, pressed 1 cm');
  assert.ok(g.prismCount >= 4, `floor and ceiling prisms: ${g.prismCount}`);
  assert.ok(g.prismSurf.includes(SURF.FLOOR) && g.prismSurf.includes(SURF.CEIL));
  for (let i = 0; i < g.prismCount; i++) {
    const p = g.prisms.subarray(i * 18, i * 18 + 18);
    near(Math.abs(p[1] - p[10]), 0.3, 1e-5, 'prisms 0.3 m thick');
  }
  // the house test of the lost-object net
  assert.equal(insideHouse(g, 0, -1, 0.3), true);
  assert.equal(insideHouse(g, 5, -1.5, 0.3), true, 'the bedroom');
  assert.equal(insideHouse(g, 0, 1.2, 0.3), true, '0.2 m beyond the wall: within the pad');
  assert.equal(insideHouse(g, 0, 2.5, 0.3), false, '1.5 m outside');
  assert.equal(seatHeight(HOUSE, L.furniture.find((b) => b.label === 'couch')), 0.45);
  assert.equal(surfOfLabel('Sofa'), SURF.SOFT);
  assert.equal(surfOfLabel('desk'), SURF.HARD);
  // staticFromWorld works with this world whatever its mesh support
  const gw = staticFromWorld(W);
  assert.ok(gw && gw.slabCount > 0 && gw.prismCount > 0);
  assert.equal(staticFromWorld(null), null);
});

test('StaticGeometry: ear clipping covers an L-shaped floor exactly, either winding', () => {
  const L = [0, 0, 4, 0, 4, 2, 2, 2, 2, 4, 0, 4];
  const area = (pts, tris) => { let a = 0; for (let t = 0; t < tris.length; t += 3) { const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]]; a += Math.abs((pts[j * 2] - pts[i * 2]) * (pts[k * 2 + 1] - pts[i * 2 + 1]) - (pts[j * 2 + 1] - pts[i * 2 + 1]) * (pts[k * 2] - pts[i * 2])) / 2; } return a; };
  const t1 = earClip(L, 6);
  assert.equal(t1.length, 12);
  near(area(L, t1), 12, 1e-9);
  const R = []; for (let i = 5; i >= 0; i--) R.push(L[i * 2], L[i * 2 + 1]);
  const t2 = earClip(R, 6);
  assert.equal(t2.length, 12);
  near(area(R, t2), 12, 1e-9);
});

// ── ItemShapes ───────────────────────────────────────────────────────────────

test('ItemShapes: 26-direction extreme points; the gun bins give 3 Glock and 5 AKM hulls; kinds and masses', () => {
  const cube = cloud([[0, 0, 0, 1, 1, 1]]);
  const e = /** @type {Float32Array} */ (extremePoints(cube, [-1, -1, -1, 2, 2, 2]));
  assert.ok(e && e.length / 3 >= 8 && e.length / 3 <= 26, `${e.length / 3} points`);
  for (let i = 0; i < e.length; i++) assert.ok(e[i] === 0 || e[i] === 1 || Math.abs(e[i] - 1 / 3) < 1e-6 || Math.abs(e[i] - 2 / 3) < 1e-6);
  assert.equal(extremePoints(cube, [5, 5, 5, 6, 6, 6]), null, 'an empty bin');
  assert.equal(hullsFromBins(GLOCK_CLOUD, GUN_BINS.glock).length, 3);
  assert.equal(hullsFromBins(AKM_CLOUD, GUN_BINS.akm).length, 5);
  const b = hullBounds(hullsFromBins(GLOCK_CLOUD, GUN_BINS.glock));
  near(b.half[1], (0.013 + 0.117) / 2, 1e-6);
  const mag = cloud([[-0.011, -0.117, -0.015, 0.011, 0.004, 0.058]]);
  const ak = cloud([[-0.015, -0.1, -0.03, 0.015, -0.001, 0.037], [-0.015, -0.2, -0.116, 0.015, -0.09, -0.02]]);
  const kinds = itemKinds({
    glock: { gun: GLOCK_CLOUD, mag, magSeat: [0, -0.0081, 0.019], grip: [0, -0.0727, 0.044] },
    akm: { gun: AKM_CLOUD, mag: ak, magSeat: [0, -0.0043, 0.0473], grip: [0, -0.0773, 0.1885] },
  });
  assert.equal(kinds.length, KIND_COUNT);
  const by = Object.fromEntries(kinds.map((k) => [k.kind, k.def]));
  assert.equal(by[K_GLOCK].mass, 0.905);
  assert.equal(by[K_AKM].mass, 3.6);
  assert.equal(by[K_AKM].hulls.length, 7, 'the AKM with its curved magazine: 5 + 2 hulls');
  assert.equal(by[K_MAG762].hulls.length, 2);
  near(magMass('glock', 17), 0.075 + 17 * 0.0081, 1e-12);
  near(by[K_MAG9].massEmpty + by[K_MAG9].massPerRound * 17, by[K_MAG9].mass, 1e-12);
});
