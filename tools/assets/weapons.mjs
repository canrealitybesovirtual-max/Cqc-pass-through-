// @ts-check
/**
 * Weapon bake: source GLB -> gun space, part split, hidden-surface removal,
 * simplification, texture atlas, measured manifest points.
 *
 * Gun space: metres, +Y up, -Z = muzzle, bore axis on -Z, origin on the bore
 * at the breech face, +X = the gun's right (ejection side).
 *
 * Classification rules are written in the SOURCE frame in millimetres (as the
 * models were authored: muzzle +Z, gun right = -X), measured with
 * tools/assets/inspect.mjs.
 */
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  add, bounds, coneDirections, cross, dot, filterTriangles, fitCircle, fitLine, length, mat4Mul, normalize,
  rayTriangle, rot3FromFrames, roundVec, scale, sphereDirections, sub, weldByPosition,
} from './lib/geom.mjs';
import { markVisible, dilateVisible } from './lib/raster.mjs';
import { packScaled, remapUV } from './lib/pack.mjs';
import { concat, readDoc, readMaterials, readPieces } from './lib/source.mjs';
import { weldAndSimplify, simplifySloppy } from './lib/simplify.mjs';
import { composeAtlas, cropUV, encodeKTX2, gpuBytes, materialMaps, pixelWindow, resize, writePNG } from './lib/textures.mjs';
import { atlasMaterial, finishGLB, meshFrom, newDoc } from './lib/output.mjs';

/** @typedef {[number, number, number]} V3 */
/** @typedef {import('./lib/source.mjs').Piece} Piece */
/** @typedef {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }} MeshData */

export const PART = { STATIC: 0, SLIDE: 1, TRIGGER: 2, SELECTOR: 3, CATCH: 4, MAG: 5, DROP: -1 };

const R180 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]; // 180 deg about +Y
/** @param {number} s */
const S = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];

/** Extents of a piece's classification bounds. @param {Piece} p */
const ext = (p) => [p.smax[0] - p.smin[0], p.smax[1] - p.smin[1], p.smax[2] - p.smin[2]];
/** @param {Piece} p @param {number} role @param {string} label */
const set = (p, role, label) => { p.role = role; p.label = label; };

/**
 * @typedef {Object} WeaponDef
 * @property {string} id
 * @property {string} file
 * @property {number | null} scale       source units -> metres (null: from lengthM)
 * @property {number} [lengthM]          real overall length used to scale the model
 * @property {(name: string) => boolean} skip
 * @property {boolean} doubleSidedSource the source materials are double-sided
 * @property {(p: Piece, all: Piece[]) => void} classify
 * @property {number} triBudget          gun + magazine
 * @property {number} res                visibility raster resolution
 * @property {{ x: number, slideTravelMargin: number, ejectDir: V3, palmBelowGuard: number, magAxisTop?: number,
 *   catchAxis: V3, catchTravel: number }} tune
 * @property {string[]} partNames
 */

/** @type {WeaponDef} */
export const GLOCK = {
  id: 'glock',
  file: '/home/user/ref/realism-cqc-realism/cqc/models/g17-glb.glb',
  scale: null,
  lengthM: 0.202, // Glock 17 Gen5 overall length (factory spec 202 mm)
  // spare magazines and the weapon light are not part of the held gun
  skip: (n) => /^mag_full\.001|^mag_empty|^body_low/.test(n),
  doubleSidedSource: true,
  triBudget: 26000,
  res: 1400,
  partNames: ['static', 'slide', 'trigger', 'slideStop', 'magCatch'],
  tune: { x: 0, slideTravelMargin: 0.0015, ejectDir: [1.5, 1.9, 0.8], palmBelowGuard: 0.02, catchAxis: [1, 0, 0], catchTravel: 0.0025 },
  classify(p) {
    const [ex, ey, ez] = ext(p);
    const ax = Math.max(Math.abs(p.smin[0]), Math.abs(p.smax[0]));
    if (p.src.startsWith('g17_gen5_g17_gen5_slide')) {
      if (p.idx.length / 3 > 600 && p.smin[2] < -15 && p.smax[2] > 90 && ax < 9) return set(p, PART.STATIC, 'barrel');
      if (ex < 9.5 && p.smin[1] > 100 && p.smax[1] < 115 && p.smin[2] > 5 && p.smax[2] < 60) return set(p, PART.STATIC, 'recoilSpring');
      if (p.smax[2] < -70 && p.smax[1] > 136) return set(p, PART.SLIDE, 'rearSight');
      if (p.smin[2] > 70 && p.smax[1] > 136) return set(p, PART.SLIDE, 'frontSight');
      return set(p, PART.SLIDE, 'slide');
    }
    if (p.src.startsWith('g17_gen5_g17_gen5_frame')) {
      if (ax <= 3.6 && p.smin[1] >= 73 && p.smax[1] <= 106 && p.smin[2] >= -21 && p.smax[2] <= 1) return set(p, PART.TRIGGER, 'trigger');
      const inner = Math.min(Math.abs(p.smin[0]), Math.abs(p.smax[0]));
      if (Math.sign(p.smin[0]) === Math.sign(p.smax[0]) && inner >= 11 && p.smin[1] >= 72 && p.smax[1] <= 86 && p.smin[2] >= -43 && p.smax[2] <= -29) return set(p, PART.CATCH, 'magCatch');
      if (ex > 30 && p.smin[1] > 105 && p.smax[1] < 113.5 && p.smin[2] > -43 && p.smax[2] < -5) return set(p, PART.SELECTOR, 'slideStop');
      if (ex > 25 && ey < 5 && ez < 5 && p.smin[1] > 99 && p.smax[1] < 106) return set(p, PART.STATIC, 'triggerPin');
      if (p.idx.length / 3 > 3000) return set(p, PART.STATIC, 'frame');
      return set(p, PART.STATIC, 'framePart');
    }
    if (p.src.startsWith('mag_full_')) {
      if (p.smin[1] > 119) return set(p, PART.DROP, 'chamberedRound');
      if (p.idx.length / 3 === 540) return set(p, PART.MAG, ez < 13 ? 'bullet' : 'case');
      if (p.idx.length / 3 === 1284) return set(p, PART.MAG, 'magBody');
      return set(p, PART.MAG, 'magPart');
    }
    set(p, PART.DROP, 'unknown');
  },
};

/** @type {WeaponDef} */
export const AKM = {
  id: 'akm',
  file: '/home/user/ref/realism-cqc-realism/cqc/models/akmn-glb.glb',
  scale: 1, // authored in metres (overall length 0.889 m with the slant brake)
  skip: () => false,
  doubleSidedSource: false,
  triBudget: 28000,
  res: 2400,
  partNames: ['static', 'carrier', 'trigger', 'selector', 'magCatch'],
  tune: { x: 0, slideTravelMargin: 0.003, ejectDir: [0.85, 0.35, -0.4], palmBelowGuard: 0.02, magAxisTop: 0.045, catchAxis: [0, 0, -1], catchTravel: 0.004 },
  classify(p, all) {
    const [ex, , ez] = ext(p);
    const tris = p.idx.length / 3;
    switch (p.src) {
      case 'body~0':
        if (p.smin[2] < -70 && p.smax[2] > 330 && ex < 25) return set(p, PART.STATIC, 'barrel');
        if (ex <= 6.5 && p.smin[2] > 300 && p.smax[2] < 316 && p.smax[1] > 133) return set(p, PART.STATIC, 'frontSight');
        if (p.smin[2] > 318) return set(p, PART.STATIC, 'muzzleDevice');
        return set(p, PART.STATIC, 'barrelPart');
      case 'body~1':
        if (p.smin[1] < -40 && p.smax[2] < -220) return set(p, PART.STATIC, 'grip');
        if (p.smin[1] > 128 && p.smax[1] < 137 && p.smin[2] < -70 && p.smax[2] > -25 && ex < 23) return set(p, PART.STATIC, 'rearSight');
        if (ex < 13 && p.smin[1] > 104 && p.smax[1] < 118 && ez > 100) return set(p, PART.STATIC, 'recoilSpring');
        if (tris === Math.max(...all.filter((q) => q.src === p.src).map((q) => q.idx.length / 3)) && p.smin[1] > 100) return set(p, PART.STATIC, 'recoilSpring');
        return set(p, PART.STATIC, p.smin[1] < 48 && p.smax[1] > 85 ? 'receiver' : 'receiverPart');
      case 'body~2': return set(p, PART.STATIC, 'stock');
      case 'body~3': return set(p, PART.STATIC, p.smin[1] < 55 && tris > 1000 ? 'handguardLower' : 'handguard');
      case 'body~4': return set(p, PART.STATIC, 'dustCover');
      case 'catch~0': return set(p, PART.CATCH, 'magCatch');
      case 'ch~0': return set(p, PART.SLIDE, ex > 40 ? 'carrier' : 'bolt');
      case 'sel~0': return set(p, PART.SELECTOR, ex > 25 ? 'selectorAxle' : 'selector');
      case 'trig~0': return set(p, PART.TRIGGER, 'trigger');
      case 'mag~0': return set(p, PART.MAG, tris > 3000 ? 'magBody' : 'magPart');
      case 'rounds~0': return set(p, PART.MAG, 'round');
      default: return set(p, PART.DROP, 'unknown');
    }
  },
};

// --- helpers ---------------------------------------------------------------

/** @param {Piece[]} ps @param {string} label */
const byLabel = (ps, label) => ps.filter((p) => p.label === label);

/** All vertex positions of pieces, packed. @param {Piece[]} ps */
function points(ps) {
  let n = 0;
  for (const p of ps) n += p.pos.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of ps) { out.set(p.pos, o); o += p.pos.length; }
  return out;
}

/** @param {Float32Array} pts @param {(x: number, y: number, z: number) => boolean} f */
function filterPts(pts, f) {
  /** @type {number[]} */
  const o = [];
  for (let i = 0; i < pts.length; i += 3) if (f(pts[i], pts[i + 1], pts[i + 2])) o.push(pts[i], pts[i + 1], pts[i + 2]);
  return Float32Array.from(o);
}

/**
 * Apply a rigid transform (column-major 4x4) to pieces in place.
 * @param {Piece[]} ps @param {number[]} M
 */
function transformPieces(ps, M) {
  for (const p of ps) {
    for (let i = 0; i < p.pos.length; i += 3) {
      const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
      p.pos[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
      p.pos[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      p.pos[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      const a = p.nrm[i], b = p.nrm[i + 1], c = p.nrm[i + 2];
      p.nrm[i] = M[0] * a + M[4] * b + M[8] * c;
      p.nrm[i + 1] = M[1] * a + M[5] * b + M[9] * c;
      p.nrm[i + 2] = M[2] * a + M[6] * b + M[10] * c;
    }
  }
}

/**
 * Circular vertex rings of a barrel: vertices grouped by z (rings of a
 * cylinder share a z), each group split by radius, and a circle fitted to
 * every group that is round to within 0.05 mm.
 * @param {Float32Array} pts
 * @returns {{ z: number, cx: number, cy: number, r: number, n: number }[]}
 */
export function barrelRings(pts) {
  const order = [];
  for (let i = 0; i < pts.length / 3; i++) order.push(i);
  order.sort((a, b) => pts[a * 3 + 2] - pts[b * 3 + 2]);
  /** @type {number[][]} */
  const groups = [];
  let cur = /** @type {number[]} */ ([]);
  for (const i of order) {
    if (cur.length && pts[i * 3 + 2] - pts[cur[cur.length - 1] * 3 + 2] > 0.0001) { groups.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) groups.push(cur);
  const rings = [];
  for (const g of groups) {
    if (g.length < 8) continue;
    const c0 = fitCircle(g.map((i) => pts[i * 3]), g.map((i) => pts[i * 3 + 1]));
    // split concentric rings by radius about the provisional centre
    const byR = g.map((i) => ({ i, r: Math.hypot(pts[i * 3] - c0.cx, pts[i * 3 + 1] - c0.cy) })).sort((a, b) => a.r - b.r);
    /** @type {number[][]} */
    const sub = [];
    let s = /** @type {number[]} */ ([]);
    let last = -1;
    for (const { i, r } of byR) { if (s.length && r - last > 0.0003) { sub.push(s); s = []; } s.push(i); last = r; }
    if (s.length) sub.push(s);
    for (const q of sub) {
      if (q.length < 8) continue;
      const xs = q.map((i) => pts[i * 3]), ys = q.map((i) => pts[i * 3 + 1]);
      const c = fitCircle(xs, ys);
      let rms = 0;
      for (let k = 0; k < xs.length; k++) { const d = Math.hypot(xs[k] - c.cx, ys[k] - c.cy) - c.r; rms += d * d; }
      rms = Math.sqrt(rms / xs.length);
      // a full ring: points all round the circle, not an arc
      let ang = 0;
      for (let k = 0; k < xs.length; k++) ang += Math.atan2(ys[k] - c.cy, xs[k] - c.cx) > 0 ? 1 : -1;
      if (rms < 0.00005 && c.r > 0.002 && c.r < 0.012 && Math.abs(ang) < 0.5 * xs.length) {
        rings.push({ z: q.reduce((a, i) => a + pts[i * 3 + 2], 0) / q.length, cx: c.cx, cy: c.cy, r: c.r, n: q.length });
      }
    }
  }
  return rings;
}

/**
 * Bore axis from the barrel geometry: circles fitted to its vertex rings
 * (muzzle crown, bore, chamber, outer tube), a robust median centre, then a
 * least-squares line through the ring centres when they span enough length.
 * Returns the axis as x(z), y(z) in the pre-frame (muzzle -Z).
 * @param {Piece[]} barrel
 */
export function measureBore(barrel) {
  const pts = points(barrel);
  const b = bounds(pts);
  const z0 = b.min[2], z1 = b.max[2];
  const rings = barrelRings(pts);
  if (rings.length < 2) throw new Error('measureBore: too few round barrel rings');
  const cz = rings.map((r) => r.z), cx = rings.map((r) => r.cx), cy = rings.map((r) => r.cy), rr = rings.map((r) => r.r);
  // robust: drop sections whose centre is > 0.3 mm from the median, then fit lines
  const med = (/** @type {number[]} */ a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const mx = med(cx), my = med(cy);
  const keep = cz.map((_, i) => Math.hypot(cx[i] - mx, cy[i] - my) < 0.0003);
  const zs = cz.filter((_, i) => keep[i]), xs = cx.filter((_, i) => keep[i]), ys = cy.filter((_, i) => keep[i]);
  const fit = (/** @type {number[]} */ v) => {
    const n = zs.length;
    const mz = zs.reduce((a, q) => a + q, 0) / n, mv = v.reduce((a, q) => a + q, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (zs[i] - mz) * (v[i] - mv); den += (zs[i] - mz) ** 2; }
    const k = den ? num / den : 0;
    return { k, c: mv - k * mz };
  };
  const span = Math.max(...zs) - Math.min(...zs);
  // too short a span cannot resolve a tilt: take the axis parallel to z through the median centre
  const fx = span > 0.03 ? fit(xs) : { k: 0, c: med(xs) }, fy = span > 0.03 ? fit(ys) : { k: 0, c: med(ys) };
  // breech face: the rear end of the barrel near the axis (the chamber mouth), not a lug further back
  let zb = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const ax = fx.k * pts[i + 2] + fx.c, ay = fy.k * pts[i + 2] + fy.c;
    if (Math.hypot(pts[i] - ax, pts[i + 1] - ay) < 0.007) zb = Math.max(zb, pts[i + 2]);
  }
  return { fx, fy, zMuzzleEnd: z0, zBreechEnd: Number.isFinite(zb) ? zb : z1, sections: zs.length, span, radius: Math.min(...rr) };
}

/**
 * Distance from points moving along `dir` (or rotating) to the first obstacle
 * triangle; returns the minimum over points (Infinity when nothing is hit).
 * @param {V3[]} origins @param {(o: V3) => V3} dirOf
 * @param {Piece[]} obstacles @param {(hit: V3) => boolean} [accept]
 */
function clearance(origins, dirOf, obstacles, accept = () => true) {
  let best = Infinity;
  for (const o of origins) {
    const d = dirOf(o);
    for (const p of obstacles) {
      for (let t = 0; t < p.idx.length; t += 3) {
        const a = p.pos.subarray(p.idx[t] * 3, p.idx[t] * 3 + 3), b = p.pos.subarray(p.idx[t + 1] * 3, p.idx[t + 1] * 3 + 3), c = p.pos.subarray(p.idx[t + 2] * 3, p.idx[t + 2] * 3 + 3);
        const dist = rayTriangle(o, d, a, b, c);
        if (dist > 0.0003 && dist < best && accept(add(o, scale(d, dist)))) best = dist;
      }
    }
  }
  return best;
}

/** Highest vertex of pieces near the centre plane: returns its y and the mean z of the top vertices. @param {Piece[]} ps @param {number} [halfWidth] */
function sightTop(ps, halfWidth = 0.0035) {
  const pts = filterPts(points(ps), (x) => Math.abs(x) <= halfWidth);
  let top = -Infinity;
  for (let i = 1; i < pts.length; i += 3) top = Math.max(top, pts[i]);
  let zs = 0, n = 0;
  for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] > top - 0.0003) { zs += pts[i + 2]; n++; }
  return { y: top, z: zs / n };
}

// --- the bake ----------------------------------------------------------------

/**
 * @param {WeaponDef} def
 * @param {{ cacheDir: string, debugDir?: string, log: (s: string) => void }} env
 */
export async function bakeWeapon(def, env) {
  const log = env.log;
  const doc = await readDoc(def.file);
  const mats = readMaterials(doc);

  // 1. scale: from the factory overall length when the source units are arbitrary
  let s = def.scale;
  if (s == null) {
    const probe = readPieces(doc, { frame: R180, classify: S(1), skip: def.skip });
    const b = bounds(points(probe));
    s = /** @type {number} */ (def.lengthM) / (b.max[2] - b.min[2]);
  }
  /** @type {Piece[]} */
  let pieces = readPieces(doc, { frame: mat4Mul(R180, S(s)), classify: S(s * 1000), skip: def.skip });
  for (const p of pieces) def.classify(p, pieces);
  pieces = pieces.filter((p) => p.role !== PART.DROP);
  log(`${def.id}: scale ${s.toFixed(5)} m/unit, ${pieces.length} pieces, ${pieces.reduce((a, p) => a + p.idx.length / 3, 0)} tris after drops`);

  // 2. bore axis from the barrel geometry, then move the origin to the breech face on the bore
  const bore = measureBore(byLabel(pieces, 'barrel'));
  const zb = bore.zBreechEnd;
  const tilt = Math.atan(Math.hypot(bore.fx.k, bore.fy.k));
  const o = [bore.fx.k * zb + bore.fx.c, bore.fy.k * zb + bore.fy.c, zb];
  // rotation that takes the measured bore direction (towards the muzzle) onto -Z, keeping +Y up
  const dBore = normalize([-bore.fx.k, -bore.fy.k, -1]);
  const xAxis = normalize(cross([0, 1, 0], [-dBore[0], -dBore[1], -dBore[2]]));
  const yAxis = cross([-dBore[0], -dBore[1], -dBore[2]], xAxis);
  const R = rot3FromFrames([xAxis, yAxis, /** @type {V3} */ ([-dBore[0], -dBore[1], -dBore[2]])], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  const Ro = [R[0] * o[0] + R[3] * o[1] + R[6] * o[2], R[1] * o[0] + R[4] * o[1] + R[7] * o[2], R[2] * o[0] + R[5] * o[1] + R[8] * o[2]];
  const G = [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, -Ro[0], -Ro[1], -Ro[2], 1];
  transformPieces(pieces, G);
  log(`${def.id}: bore from ${bore.sections} barrel sections, radius ${(bore.radius * 1000).toFixed(2)} mm, tilt ${(tilt * 180 / Math.PI).toFixed(3)} deg; breech at source z ${(zb * 1000).toFixed(1)} mm`);

  // 3. measurements on the full-resolution geometry (internals still present)
  const M = measure(def, pieces);

  // 4. hidden-surface removal over the configurations the player can see
  const removed = removeHidden(def, pieces, M.slide.travel);
  log(`${def.id}: hidden-surface removal took out ${removed.removed} tris (${removed.pieces} whole pieces), added ${removed.backAdded} back faces`);
  pieces = removed.kept;

  // 5. UV unwrap of wrapped (repeat) UVs, then atlas windows per material
  for (const p of pieces) Object.assign(p, unwrapUV(p));
  const rifleSource = pieces.map((p) => ({ ...p })); // pre-simplification, for the enemy rifle

  // 6. simplification to the budget (same absolute error for every piece)
  const simplified = simplifyToBudget(pieces, def.triBudget, 5e-5, 6e-4);
  log(`${def.id}: simplified at ${(simplified.error * 1000).toFixed(3)} mm -> ${simplified.tris} tris`);
  pieces = simplified.pieces;

  // 7. atlas
  const atlas = await buildAtlas(def.id, mats, [...pieces, ...rifleSource], env, { maxW: 2048, maxH: 2048 });
  for (const p of pieces) atlas.remap(p);
  for (const p of rifleSource) atlas.remap(p);

  // 8. meshes
  const gunPieces = pieces.filter((p) => p.role >= 0 && p.role <= 4);
  const magPieces = pieces.filter((p) => p.role === PART.MAG);
  const gun = concat(gunPieces.map((p) => ({ ...p, part: p.role })));
  const mag = concat(magPieces);
  const seat = M.magWell.pos;
  for (let i = 0; i < mag.pos.length; i += 3) { mag.pos[i] -= seat[0]; mag.pos[i + 1] -= seat[1]; mag.pos[i + 2] -= seat[2]; }

  const out = newDoc();
  const mat = atlasMaterial(out, 'gun', { base: atlas.ktx.base, normal: atlas.ktx.normal, orm: atlas.ktx.orm, occlusion: true });
  const scene = out.createScene(def.id);
  out.getRoot().setDefaultScene(scene);
  scene.addChild(out.createNode('gun').setMesh(meshFrom(out, 'gun', gun, mat)));
  scene.addChild(out.createNode('mag').setMesh(meshFrom(out, 'mag', { pos: mag.pos, nrm: mag.nrm, uv: mag.uv, idx: mag.idx }, mat)).setTranslation(seat));
  const glb = await finishGLB(out);

  const gunTris = gun.idx.length / 3, magTris = mag.idx.length / 3;
  const textures = atlas.info;
  const manifest = {
    ...M.manifest,
    tris: gunTris + magTris,
    parts: def.partNames,
    textures,
  };
  const report = {
    id: def.id, gunTris, magTris, tris: gunTris + magTris, draws: 2, vertices: gun.pos.length / 3 + mag.pos.length / 3,
    glbBytes: glb.byteLength, gpuTextureBytes: atlas.gpuBytes, atlasScale: atlas.scale, simplifyError: simplified.error,
    partTris: def.partNames.map((n, i) => [n, gunPieces.filter((p) => p.role === i).reduce((a, p) => a + p.idx.length / 3, 0)]),
  };
  return { glb, manifest, report, rifleSource, atlas, measured: M };
}

/**
 * Manifest points (gun space).
 * @param {WeaponDef} def @param {Piece[]} ps
 */
function measure(def, ps) {
  const isAk = def.id === 'akm';
  const statics = ps.filter((p) => p.role === PART.STATIC);
  const slide = ps.filter((p) => p.role === PART.SLIDE);
  const trigger = ps.filter((p) => p.role === PART.TRIGGER);
  const mags = ps.filter((p) => p.role === PART.MAG);

  // muzzle: the most forward point of the barrel / muzzle device around the bore exit
  const near = filterPts(points(statics), (x, y) => Math.hypot(x, y) < 0.006);
  let zm = Infinity;
  for (let i = 2; i < near.length; i += 3) zm = Math.min(zm, near[i]);
  const muzzle = /** @type {V3} */ ([0, 0, zm]);

  // magazine: insertion axis from slab centres of the body, origin at its top along the axis
  const body = byLabel(mags, 'magBody');
  const bodyPts = points(body);
  const bb = bounds(bodyPts);
  const yTop = bb.max[1], yLow = def.tune.magAxisTop ? yTop - def.tune.magAxisTop : bb.min[1] + 0.012;
  /** @type {number[]} */
  const centres = [];
  for (let y = yLow; y < yTop - 0.006; y += 0.003) {
    const sl = filterPts(bodyPts, (_x, yy) => yy >= y && yy < y + 0.003);
    if (sl.length < 9) continue;
    const b = bounds(sl);
    centres.push((b.min[0] + b.max[0]) / 2, y + 0.0015, (b.min[2] + b.max[2]) / 2);
  }
  const ml = fitLine(Float32Array.from(centres));
  let magAxis = ml.dir[1] < 0 ? scale(ml.dir, -1) : ml.dir;
  magAxis = normalize([0, magAxis[1], magAxis[2]]); // the well is on the centre plane
  let proj = -Infinity;
  for (let i = 0; i < bodyPts.length; i += 3) proj = Math.max(proj, dot(sub([bodyPts[i], bodyPts[i + 1], bodyPts[i + 2]], ml.point), magAxis));
  const magOrigin = add([0, ml.point[1], ml.point[2]], scale(magAxis, proj));

  // trigger pivot: the pin through the trigger (a part long in X inside the trigger's box)
  const tb = bounds(points(trigger));
  const pins = statics.filter((p) => {
    const b = bounds(p.pos), e = sub(b.max, b.min);
    const c = scale(add(b.min, b.max), 0.5);
    return e[0] > 2.5 * Math.max(e[1], e[2]) && e[0] > 0.01 &&
      c[1] > tb.min[1] - 0.002 && c[1] < tb.max[1] + 0.002 && c[2] > tb.min[2] - 0.002 && c[2] < tb.max[2] + 0.002;
  });
  let pivot;
  if (pins.length) {
    pins.sort((a, b) => bounds(b.pos).max[1] - bounds(a.pos).max[1]);
    const pb = bounds(pins[0].pos);
    pivot = /** @type {V3} */ ([0, (pb.min[1] + pb.max[1]) / 2, (pb.min[2] + pb.max[2]) / 2]);
  } else {
    pivot = /** @type {V3} */ ([0, tb.max[1] - 0.003, (tb.min[2] + tb.max[2]) / 2]);
  }
  // pull: how far the blade can rotate rearwards before it meets the frame (90 % of it)
  const axis = /** @type {V3} */ ([-1, 0, 0]);
  /** @type {V3[]} */
  const blade = [];
  for (const p of trigger) for (let i = 0; i < p.pos.length; i += 3) if (p.pos[i + 1] < pivot[1] - 0.008) blade.push([p.pos[i], p.pos[i + 1], p.pos[i + 2]]);
  const rotDir = (/** @type {V3} */ q) => normalize(cross(axis, sub(q, pivot)));
  const guardAndGrip = statics.filter((p) => !/Pin|Spring/.test(p.label || ''));
  let minAngle = Infinity;
  for (const q of blade.filter((_, i) => i % 3 === 0)) {
    const r = Math.hypot(q[1] - pivot[1], q[2] - pivot[2]);
    const d = clearance([q], rotDir, guardAndGrip, (h) => h[1] < pivot[1] - 0.004);
    if (d < Infinity) minAngle = Math.min(minAngle, d / r);
  }
  const pullRad = Math.min(0.6, Math.max(0.12, Number.isFinite(minAngle) ? 0.9 * minAngle : 0.35));

  // trigger guard bottom: lowest static point directly under the trigger
  const under = filterPts(points(statics), (x, y, z) => Math.abs(x) < 0.005 && y < tb.min[1] && z > tb.min[2] && z < tb.max[2]);
  let guardBottom = Infinity;
  for (let i = 1; i < under.length; i += 3) guardBottom = Math.min(guardBottom, under[i]);
  if (!Number.isFinite(guardBottom)) guardBottom = tb.min[1] - 0.008;

  // grip axis: Glock = slab centres of the frame below the guard; AKM = principal axis of the pistol grip
  let gripLine;
  if (isAk) {
    gripLine = fitLine(points(byLabel(statics, 'grip')));
  } else {
    const frame = points(byLabel(statics, 'frame'));
    const fb = bounds(frame);
    /** @type {number[]} */
    const gc = [];
    for (let y = fb.min[1] + 0.012; y < guardBottom - 0.004; y += 0.003) {
      const sl = filterPts(frame, (x, yy) => yy >= y && yy < y + 0.003 && Math.abs(x) < 0.02);
      if (sl.length < 9) continue;
      const b = bounds(sl);
      gc.push(0, y + 0.0015, (b.min[2] + b.max[2]) / 2);
    }
    gripLine = fitLine(Float32Array.from(gc));
  }
  let up = gripLine.dir[1] < 0 ? scale(gripLine.dir, -1) : gripLine.dir;
  up = normalize([0, up[1], up[2]]);
  const palmY = guardBottom - def.tune.palmBelowGuard;
  const tGrip = (palmY - gripLine.point[1]) / up[1];
  const gripPos = add([0, gripLine.point[1], gripLine.point[2]], scale(up, tGrip));
  const fwd = normalize(sub([0, 0, -1], scale(up, dot([0, 0, -1], up))));

  // slide / carrier travel: the breech face must pass the rear of the top round (+ overtravel)
  const rounds = mags.filter((p) => /round|case/.test(p.label || ''));
  let topRound = rounds[0];
  for (const r of rounds) if (bounds(r.pos).max[1] > bounds(topRound.pos).max[1]) topRound = r;
  const topY = bounds(topRound.pos).max[1];
  let caseHead = -Infinity;
  for (const r of rounds) { const b = bounds(r.pos); if (b.max[1] > topY - 0.003) caseHead = Math.max(caseHead, b.max[2]); }
  const travel = caseHead + def.tune.slideTravelMargin;

  // rack point: Glock = rear of the slide (serrations), AKM = the charging-handle knob
  const sp = points(slide);
  const sb = bounds(sp);
  let rackPoint;
  if (isAk) {
    const recv = bounds(points(byLabel(statics, 'receiver')));
    const knob = filterPts(sp, (x) => x > recv.max[0] + 0.004);
    const kb = bounds(knob);
    rackPoint = scale(add(kb.min, kb.max), 0.5);
  } else {
    rackPoint = [0, sb.max[1] * 0.45, sb.max[2] - 0.012];
  }

  // ejection port: where the case sits when the extractor pulls it out (half a case ahead of the breech face)
  const caseLen = isAk ? 0.0388 : 0.01915; // 7.62x39 / 9x19 case lengths
  const portZ = -caseLen / 2, portY = isAk ? 0.004 : 0.004;
  const side = filterPts(points(isAk ? [...byLabel(statics, 'receiver'), ...byLabel(statics, 'dustCover')] : slide), (_x, y, z) => Math.abs(y - portY) < 0.004 && Math.abs(z - portZ) < 0.006);
  const portX = bounds(side).max[0];
  const ejectionPort = /** @type {V3} */ ([portX, portY, portZ]);

  // sights
  const rearPieces = byLabel(isAk ? statics : slide, 'rearSight');
  const frontPieces = byLabel(isAk ? statics : slide, 'frontSight');
  let rear;
  if (isAk) {
    // the notch is at the rear end of the leaf
    const leaf = points(rearPieces);
    const lb = bounds(leaf);
    const rearEnd = filterPts(leaf, (x, _y, z) => z > lb.max[2] - 0.004 && Math.abs(x) < 0.004);
    rear = /** @type {V3} */ ([0, bounds(rearEnd).max[1], lb.max[2] - 0.002]);
  } else {
    const t = sightTop(rearPieces, 0.01);
    rear = /** @type {V3} */ ([0, t.y, t.z]);
  }
  const ft = sightTop(frontPieces);
  const front = /** @type {V3} */ ([0, ft.y, ft.z]);

  // support hand (AKM): centre of the lower handguard's section at mid-length
  let support;
  if (isAk) {
    const hg = points(byLabel(statics, 'handguardLower'));
    const hb = bounds(hg);
    const zMid = (hb.min[2] + hb.max[2]) / 2;
    const sl = bounds(filterPts(hg, (_x, _y, z) => Math.abs(z - zMid) < 0.005));
    support = { pos: roundVec([0, (sl.min[1] + sl.max[1]) / 2, zMid]) };
  }

  // extras for the moving parts that the contract leaves to the view
  const extra = {};
  const p3 = ps.filter((p) => p.role === PART.SELECTOR);
  if (p3.length) {
    if (isAk) {
      const axle = bounds(points(byLabel(p3, 'selectorAxle')));
      extra.selector = { pivot: roundVec([0, (axle.min[1] + axle.max[1]) / 2, (axle.min[2] + axle.max[2]) / 2]), axis: [-1, 0, 0], safe: 0, auto: 0.33, semi: 0.66, note: 'positive angles move the lever down (safe -> auto -> semi); angles are typical values, not measured' };
    } else {
      const b = bounds(points(p3));
      extra.slideStop = { pivot: roundVec([0, (b.min[1] + b.max[1]) / 2, b.max[2] - 0.002]), axis: [-1, 0, 0], liftRad: 0.06, note: 'part 3; rotates about its rear pin so the front rises into the slide notch when the slide locks open' };
    }
  }
  const catchB = bounds(points(ps.filter((p) => p.role === PART.CATCH)));
  extra.magCatch = { pos: roundVec(scale(add(catchB.min, catchB.max), 0.5)), axis: def.tune.catchAxis, travel: def.tune.catchTravel };

  const manifest = {
    muzzle: roundVec(muzzle),
    ejectionPort: roundVec(ejectionPort),
    ejectDir: roundVec(normalize(def.tune.ejectDir)),
    grip: { pos: roundVec(gripPos), up: roundVec(up), fwd: roundVec(fwd) },
    magWell: { pos: roundVec(magOrigin), axis: roundVec(magAxis) },
    magLocalSeat: roundVec(magOrigin),
    slide: { travel: roundVec([travel])[0], axis: [0, 0, 1], rackPoint: roundVec(rackPoint) },
    trigger: { pivot: roundVec(pivot), axis, pullRad: roundVec([pullRad], 3)[0] },
    ...(support ? { support } : {}),
    sights: { rear: roundVec(rear), front: roundVec(front) },
    bore: { radius: roundVec([measureBoreRadius(def)], 5)[0] },
    ...extra,
  };
  return {
    manifest, magWell: { pos: magOrigin, axis: magAxis }, slide: { travel },
    debug: { guardBottom, palmY, caseHead, minAngle, pins: pins.map((p) => p.label) },
  };
}

/** @param {WeaponDef} def */
function measureBoreRadius(def) {
  return def.id === 'akm' ? 0.00762 / 2 : 0.009 / 2; // calibre (the rifling in the models is not resolved finely enough to measure)
}

/**
 * @param {WeaponDef} def @param {Piece[]} pieces @param {number} travel
 */
function removeHidden(def, pieces, travel) {
  const counts = pieces.map((p) => new Uint32Array((p.idx.length / 3) * 2));
  const bodyDirs = sphereDirections(def.id === 'akm' ? 200 : 240);
  const dirs = [
    ...bodyDirs,
    ...coneDirections([0, 0, 1], [0.015, 0.04, 0.09], 8), // looking down the bore from the muzzle
    ...coneDirections([0, 0, -1], [0.015, 0.04, 0.09], 8),
    ...coneDirections([0, 1, 0], [0.05, 0.15, 0.3], 8), // up into the magazine well
  ];
  const cull = !def.doubleSidedSource;
  /** @param {(p: Piece) => boolean} include @param {(p: Piece) => (V3 | undefined)} off */
  const config = (include, off) => {
    const list = pieces.map((p, i) => ({ p, i })).filter(({ p }) => include(p));
    markVisible(list.map(({ p }) => ({ pos: p.pos, idx: p.idx, offset: off(p), cull })), dirs, def.res, list.map(({ i }) => counts[i]));
  };
  const back = (/** @type {Piece} */ p) => (p.role === PART.SLIDE ? /** @type {V3} */ ([0, 0, travel]) : undefined);
  config((p) => p.role >= 0, () => undefined); // at rest
  config((p) => p.role >= 0, back); // slide / carrier back
  config((p) => p.role >= 0 && p.role !== PART.MAG, () => undefined); // magazine out
  config((p) => p.role >= 0 && p.role !== PART.MAG, back); // locked open, magazine out
  config((p) => p.role === PART.MAG, () => undefined); // magazine alone

  /** @type {Piece[]} */
  const kept = [];
  let removed = 0, whole = 0, backAdded = 0;
  pieces.forEach((p, i) => {
    const rep = weldByPosition(p.pos, 1e-6);
    const keep = dilateVisible(p.idx, rep, counts[i]);
    const nt = p.idx.length / 3;
    let k = 0;
    for (let t = 0; t < nt; t++) k += keep[t];
    removed += nt - k;
    if (!k) { whole++; return; }
    const f = filterTriangles(p, (t) => keep[t] === 1);
    kept.push({ ...p, ...f, cut: k < nt });
    if (def.doubleSidedSource) {
      // triangles seen from behind in a double-sided source get a flipped twin (the bake is single-sided)
      const bt = [];
      for (let t = 0; t < nt; t++) if (counts[i][t * 2 + 1] >= 3) bt.push(t);
      if (bt.length) {
        const sel = new Set(bt);
        const b = filterTriangles(p, (t) => sel.has(t));
        for (let j = 0; j < b.idx.length; j += 3) { const a = b.idx[j + 1]; b.idx[j + 1] = b.idx[j + 2]; b.idx[j + 2] = a; }
        for (let j = 0; j < b.nrm.length; j++) b.nrm[j] = -b.nrm[j];
        kept.push({ ...p, ...b, label: `${p.label}:back`, cut: true });
        backAdded += bt.length;
      }
    }
  });
  return { kept, removed, pieces: whole, backAdded };
}

/**
 * Bring wrapped (repeat) UVs of each triangle back into [0, 1] by an integer
 * shift; vertices shared by triangles with different shifts are split.
 * @param {MeshData} p
 * @returns {MeshData}
 */
export function unwrapUV(p) {
  const nt = p.idx.length / 3;
  /** @type {Map<string, number>} */
  const map = new Map();
  /** @type {number[]} */
  const pos = [], nrm = [], uv = [];
  const idx = new Uint32Array(p.idx.length);
  for (let t = 0; t < nt; t++) {
    let mu = Infinity, mv = Infinity;
    for (let j = 0; j < 3; j++) { const v = p.idx[t * 3 + j]; mu = Math.min(mu, p.uv[v * 2]); mv = Math.min(mv, p.uv[v * 2 + 1]); }
    const su = Math.floor(mu + 1e-6), sv = Math.floor(mv + 1e-6);
    for (let j = 0; j < 3; j++) {
      const v = p.idx[t * 3 + j];
      const key = `${v}:${su}:${sv}`;
      let n = map.get(key);
      if (n === undefined) {
        n = pos.length / 3;
        map.set(key, n);
        pos.push(p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]);
        nrm.push(p.nrm[v * 3], p.nrm[v * 3 + 1], p.nrm[v * 3 + 2]);
        uv.push(p.uv[v * 2] - su, p.uv[v * 2 + 1] - sv);
      }
      idx[t * 3 + j] = n;
    }
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx };
}

/**
 * Simplify every piece at one absolute error; bisect the error so the total
 * fits the budget (never below errMin).
 * @param {(Piece & { cut?: boolean })[]} pieces @param {number} budget @param {number} errMin @param {number} errMax
 */
export function simplifyToBudget(pieces, budget, errMin, errMax) {
  const run = (/** @type {number} */ e) => pieces.map((p) => ({ ...p, ...weldAndSimplify(p, e, { lockBorder: !!p.cut }) }));
  const count = (/** @type {{ idx: Uint32Array }[]} */ ps) => ps.reduce((a, p) => a + p.idx.length / 3, 0);
  let best = run(errMin), e = errMin;
  if (count(best) > budget) {
    let lo = errMin, hi = errMax;
    let hiRun = run(hi);
    if (count(hiRun) > budget) throw new Error(`simplify: ${count(hiRun)} tris at ${errMax} m, budget ${budget}`);
    for (let i = 0; i < 14; i++) {
      const mid = Math.sqrt(lo * hi);
      const r = run(mid);
      if (count(r) > budget) lo = mid; else { hi = mid; hiRun = r; }
    }
    best = hiRun; e = hi;
  }
  return { pieces: best.filter((p) => p.idx.length >= 3), error: e, tris: count(best) };
}

/**
 * Build the atlas for all materials used by the pieces; returns the KTX2 maps
 * and a function that remaps a piece's UVs into the atlas.
 * @param {string} id @param {ReturnType<typeof readMaterials>} mats @param {Piece[]} pieces
 * @param {{ cacheDir: string, debugDir?: string, log: (s: string) => void }} env
 * @param {{ maxW: number, maxH: number }} size
 */
export async function buildAtlas(id, mats, pieces, env, size) {
  const used = [...new Set(pieces.map((p) => p.mat))].sort((a, b) => a - b);
  const maps = new Map();
  for (const m of used) maps.set(m, await materialMaps(mats[m]));
  // UV window per material (pixel aligned, 2 px margin)
  const wins = new Map();
  for (const m of used) {
    let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
    for (const p of pieces) {
      if (p.mat !== m) continue;
      for (let i = 0; i < p.idx.length; i++) {
        const v = p.idx[i];
        u0 = Math.min(u0, p.uv[v * 2]); u1 = Math.max(u1, p.uv[v * 2]);
        v0 = Math.min(v0, p.uv[v * 2 + 1]); v1 = Math.max(v1, p.uv[v * 2 + 1]);
      }
    }
    const { w, h } = maps.get(m);
    const mu = 2 / w, mv = 2 / h;
    wins.set(m, pixelWindow({ u0: Math.max(0, u0 - mu), v0: Math.max(0, v0 - mv), u1: Math.min(1, u1 + mu), v1: Math.min(1, v1 + mv) }, w, h));
  }
  const sizes = used.map((m) => { const { w, h } = maps.get(m), win = wins.get(m); return { w: (win.u1 - win.u0) * w, h: (win.v1 - win.v0) * h }; });
  const pad = 4;
  // choose the smallest atlas that keeps (almost) the best scale
  const candidates = [[size.maxW, size.maxH], [size.maxW, (size.maxH * 3) / 4], [size.maxW, size.maxH / 2]];
  const packs = candidates.map(([W, H]) => ({ W, H, pack: packScaled(sizes, W, H, pad, { maxScale: 1, align: 4 }) })).filter((c) => c.pack);
  const bestScale = Math.max(...packs.map((c) => /** @type {any} */ (c.pack).scale));
  const choice = packs.filter((c) => /** @type {any} */ (c.pack).scale >= 0.97 * bestScale).sort((a, b) => a.W * a.H - b.W * b.H)[0];
  const { W, H } = choice;
  const rects = /** @type {any} */ (choice.pack).rects;
  const rectOf = new Map(used.map((m, i) => [m, rects[i]]));

  const tiles = { base: [], normal: [], orm: [] };
  for (const m of used) {
    const mm = maps.get(m), win = wins.get(m), r = rectOf.get(m);
    tiles.base.push({ rect: r, raw: await cropUV(mm.base, win, r.w, r.h) });
    tiles.normal.push({ rect: r, raw: await cropUV(mm.normal, win, r.w, r.h) });
    tiles.orm.push({ rect: r, raw: await cropUV(mm.orm, win, r.w, r.h) });
  }
  const base = composeAtlas(W, H, [96, 96, 96, 255], tiles.base, pad);
  const normal = composeAtlas(W, H, [128, 128, 255, 255], tiles.normal, pad);
  const ormFull = composeAtlas(W, H, [255, 200, 0, 255], tiles.orm, pad);
  const orm = await resize(ormFull, W / 2, H / 2); // roughness / AO / metal at half resolution
  if (env.debugDir) {
    await writePNG(base, `${env.debugDir}/${id}_base.png`);
    await writePNG(normal, `${env.debugDir}/${id}_normal.png`);
    await writePNG(orm, `${env.debugDir}/${id}_orm.png`);
  }
  env.log(`${id}: atlas ${W}x${H} (ORM ${W / 2}x${H / 2}), tile scale ${choice.pack?.scale.toFixed(3)}, ${used.length} materials; encoding KTX2...`);
  const ktx = {
    base: await encodeKTX2(base, 'color', env.cacheDir),
    normal: await encodeKTX2(normal, 'normal', env.cacheDir),
    orm: await encodeKTX2(orm, 'data', env.cacheDir),
  };
  const gpu = gpuBytes(W, H, 'color') + gpuBytes(W, H, 'normal') + gpuBytes(W / 2, H / 2, 'data');
  /** @param {MeshData & { mat: number }} p */
  const remap = (p) => {
    const win = wins.get(p.mat), r = rectOf.get(p.mat);
    for (let i = 0; i < p.uv.length; i += 2) {
      const [u, v] = remapUV(p.uv[i], p.uv[i + 1], win, r, W, H);
      p.uv[i] = u; p.uv[i + 1] = v;
    }
  };
  const info = {
    base: { size: [W, H], format: 'KTX2 ETC1S sRGB', bytes: ktx.base.byteLength },
    normal: { size: [W, H], format: 'KTX2 UASTC linear', bytes: ktx.normal.byteLength },
    orm: { size: [W / 2, H / 2], format: 'KTX2 UASTC linear', bytes: ktx.orm.byteLength, channels: 'R occlusion, G roughness, B metalness' },
    gpuBytes: gpu,
  };
  return { ktx, raw: { base, orm }, remap, info, gpuBytes: gpu, scale: /** @type {any} */ (choice.pack).scale, W, H };
}

/**
 * The enemy rifle: the whole AKM (magazine seated), small parts dropped,
 * simplified to the triangle budget, one material with a small atlas.
 * @param {(Piece & { cut?: boolean })[]} src pieces in gun space (UVs already in the AKM atlas)
 * @param {number} budget
 */
export function rifleMesh(src, budget) {
  const big = src.filter((p) => {
    const b = bounds(p.pos);
    return length(sub(b.max, b.min)) > 0.014 && !/:back$/.test(p.label || '') && !/Spring|bolt$/.test(p.label || '');
  });
  let r = simplifyToBudget(big.map((p) => ({ ...p, cut: false })), budget, 2e-4, 2e-2);
  return concat(r.pieces);
}

export { MeshoptSimplifier };
