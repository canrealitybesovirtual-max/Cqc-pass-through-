// @ts-check
/**
 * Synthetic "global mesh" (pure: no three.js, no DOM): what the Quest's Space
 * Setup scan of a house looks like, made from a SpaceSnapshot's own layout, so
 * the tests, the worker warm-up and the `?emulate` fixture have a mesh that
 * agrees with the planes.
 *
 * What it makes (all from `buildLayout`; reference space, then written in the
 * mesh's own space through `pose`):
 * - every mapped floor polygon as a grid of ~`cell` triangles facing up, and
 *   every ceiling polygon facing down;
 * - every real (not inferred) wall face, facing into its room, with its door
 *   openings left open (the leaf was wherever it was during the scan: open);
 * - furniture: beds and couches with a lumpy / sagging top (±3 cm and a pillow
 *   ridge), tables and desks as a 4 cm top on four legs (the space under them is
 *   open), everything else as a solid box (shelves, storage, screens);
 * - optional unlabelled clutter boxes (a chair, a laundry basket: no Space
 *   Setup volume), triangle noise along the normal (`noise`, 6 mm default).
 *
 * Every patch is wound so its geometric normal (b − a) × (c − a) points to
 * free space. Options to test the orientation fixer: `flip` (every triangle
 * reversed: a scanner with the other convention) and `scramble` (that fraction
 * of triangles reversed at random). `holes` drops that fraction of wall
 * triangles (a patchy scan). `targetTris` picks the cell size for a triangle
 * count. Deterministic for a seed.
 */

import { buildLayout } from './Layout.js';
import { normalizeSnapshot } from './Snapshot.js';
import { pointInPolygon } from '../util/geom2d.js';

export const SCAN = Object.freeze({ cell: 0.165, noise: 0.006, seed: 7, tableTop: 0.04, leg: 0.025 });

const SOFT_RE = /\b(bed|couch|sofa)\b/;
const TABLE_RE = /\b(table|desk)\b/;

/** @param {number} seed */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * @typedef {{ cx: number, cz: number, hx: number, hz: number, h: number, yaw?: number }} Clutter
 * @typedef {{ cell?: number, targetTris?: number, noise?: number, seed?: number, flip?: boolean, scramble?: number,
 *   holes?: number, pose?: ArrayLike<number>, clutter?: Clutter[], start?: { x: number, z: number } }} ScanOptions
 * @typedef {{ label: string, pose: number[], vertices: Float32Array, indices: Uint32Array, lastChangedTime: number,
 *   stats: { tris: number, cell: number, area: number } }} RawMesh
 */

/**
 * A synthetic scan of the house in `snapshot`.
 * @param {any} snapshot a SpaceSnapshot (v1 or v2)
 * @param {ScanOptions} [o]
 * @returns {RawMesh}
 */
export function scanFromSnapshot(snapshot, o = {}) {
  const snap = normalizeSnapshot(snapshot);
  const L = buildLayout(snap, o.start || { x: 0, z: 0 }, { interiorSlab: 'centred' });
  /** @type {Patch[]} */ const patches = [];
  collect(L, patches, o.clutter || []);
  let area = 0;
  for (const p of patches) area += p.lu * p.lv * p.keepFrac;
  let cell = o.targetTris ? Math.sqrt((2 * area) / o.targetTris) : (o.cell ?? SCAN.cell);
  const noise = o.noise ?? SCAN.noise;
  /** @type {number[]} */ let V = [];
  /** @type {number[]} */ let I = [];
  let R = rng(o.seed ?? SCAN.seed);
  for (const p of patches) emit(p, cell, noise, R, V, I, o.holes && p.wall ? o.holes : 0);
  if (o.targetTris && Math.abs(I.length / 3 - o.targetTris) > 0.05 * o.targetTris) {
    // one correction pass: grids round their cell counts, so the area estimate is only close
    cell *= Math.sqrt(I.length / 3 / o.targetTris);
    V = []; I = [];
    R = rng(o.seed ?? SCAN.seed);
    for (const p of patches) emit(p, cell, noise, R, V, I, o.holes && p.wall ? o.holes : 0);
  }
  const R2 = R;
  // compact: drop unreferenced grid vertices
  const used = new Int32Array(V.length / 3).fill(-1);
  let nv = 0;
  for (let k = 0; k < I.length; k++) if (used[I[k]] < 0) used[I[k]] = nv++;
  const vertices = new Float32Array(nv * 3);
  const pose = o.pose ? Array.from(o.pose) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inv = rigidInverse(pose);
  for (let i = 0; i < used.length; i++) {
    const j = used[i];
    if (j < 0) continue;
    const x = V[3 * i], y = V[3 * i + 1], z = V[3 * i + 2];
    vertices[3 * j] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
    vertices[3 * j + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
    vertices[3 * j + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  }
  const indices = new Uint32Array(I.length);
  const scramble = o.scramble || 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = used[I[t]], b = used[I[t + 1]], c = used[I[t + 2]];
    const rev = (o.flip ? 1 : 0) ^ (scramble > 0 && R2() < scramble ? 1 : 0);
    indices[t] = a;
    indices[t + 1] = rev ? c : b;
    indices[t + 2] = rev ? b : c;
  }
  return { label: 'global mesh', pose, vertices, indices, lastChangedTime: 0, stats: { tris: indices.length / 3, cell, area } };
}

/**
 * @typedef {{ o: number[], u: number[], lu: number, v: number[], lv: number, n: number[], keep: ((a: number, b: number) => boolean)|null,
 *   h: ((a: number, b: number) => number)|null, keepFrac: number, wall: boolean }} Patch
 */

/**
 * The patches of the house (reference space).
 * @param {import('./Layout.js').Layout} L @param {Patch[]} out @param {Clutter[]} clutter
 */
function collect(L, out, clutter) {
  if (L.virtual) return;
  for (const f of L.floors) {
    if (f.virtual) continue;
    const w = f.x1 - f.x0, d = f.z1 - f.z0;
    const keep = (/** @type {number} */ a, /** @type {number} */ b) => pointInPolygon(f.pts, f.n, f.x0 + a * w, f.z0 + b * d);
    // u = +x, v = +z: u × v = −y, so the up normal flips the winding (emit handles it)
    out.push({ o: [f.x0, f.y, f.z0], u: [1, 0, 0], lu: w, v: [0, 0, 1], lv: d, n: [0, 1, 0], keep, h: null, keepFrac: Math.min(1, f.area / (w * d)), wall: false });
  }
  for (const c of L.ceilings) {
    const w = c.x1 - c.x0, d = c.z1 - c.z0;
    const keep = (/** @type {number} */ a, /** @type {number} */ b) => pointInPolygon(c.pts, c.n, c.x0 + a * w, c.z0 + b * d);
    out.push({ o: [c.x0, c.y, c.z0], u: [1, 0, 0], lu: w, v: [0, 0, 1], lv: d, n: [0, -1, 0], keep, h: null, keepFrac: 0.95, wall: false });
  }
  for (const w of L.walls) {
    if (w.inferred) continue;
    const H = w.y1 - w.y0, len = w.len, ops = w.openings;
    const keep = ops.length
      ? (/** @type {number} */ a, /** @type {number} */ b) => {
        const u = a * len, y = w.y0 + b * H;
        for (const op of ops) if (u > op.u0 && u < op.u1 && y > op.y0 && y < op.y1) return false;
        return true;
      }
      : null;
    out.push({ o: [w.ax, w.y0, w.az], u: [w.tx, 0, w.tz], lu: len, v: [0, 1, 0], lv: H, n: [w.nx, 0, w.nz], keep, h: null, keepFrac: 0.9, wall: true });
  }
  for (const b of L.furniture) {
    const lab = b.label || '';
    if (TABLE_RE.test(lab) && b.y1 - b.y0 > 0.3) table(b, out);
    else box(b.cx, b.cz, b.c, b.s, b.hx, b.hz, b.y0, b.y1, out, SOFT_RE.test(lab) ? (lab.includes('bed') ? bedTop : sagTop) : null);
  }
  for (const k of clutter) {
    const c = Math.cos(k.yaw || 0), s = Math.sin(k.yaw || 0);
    box(k.cx, k.cz, c, s, k.hx, k.hz, floorAt(L, k.cx, k.cz), floorAt(L, k.cx, k.cz) + k.h, out, null);
  }
  // A furniture side flush with a wall (within 6 cm) is out of the scanner's sight: drop it.
  const walls = L.walls.filter((w) => !w.inferred);
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i];
    if (p.wall || Math.abs(p.n[1]) > 0.5) continue;
    const x = p.o[0] + (p.u[0] * p.lu + p.v[0] * p.lv) / 2, z = p.o[2] + (p.u[2] * p.lu + p.v[2] * p.lv) / 2;
    for (const w of walls) {
      if (Math.abs(p.n[0] * w.nx + p.n[2] * w.nz) < 0.9) continue;
      const rx = x - w.ax, rz = z - w.az, u = rx * w.tx + rz * w.tz;
      if (u < 0 || u > w.len || Math.abs(rx * w.nx + rz * w.nz) > 0.06) continue;
      out.splice(i, 1);
      break;
    }
  }
}

/** @param {import('./Layout.js').Layout} L @param {number} x @param {number} z */
function floorAt(L, x, z) {
  for (const f of L.floors) if (pointInPolygon(f.pts, f.n, x, z)) return f.y;
  return L.floorY0;
}

/** Lumpy duvet with a pillow ridge at the head end. @param {number} a @param {number} b */
function bedTop(a, b) {
  return 0.03 * Math.sin(a * 7.1) * Math.sin(b * 5.3) + (b > 0.85 ? 0.06 * Math.sin(((b - 0.85) / 0.15) * Math.PI) : 0);
}
/** A sagging couch seat. @param {number} a @param {number} b */
function sagTop(a, b) {
  return -0.025 * Math.sin(a * Math.PI) * Math.sin(b * Math.PI);
}

/**
 * A solid box's top and four sides (no bottom: it stands on the floor).
 * @param {number} cx @param {number} cz @param {number} c @param {number} s @param {number} hx @param {number} hz
 * @param {number} y0 @param {number} y1 @param {Patch[]} out @param {((a: number, b: number) => number)|null} top
 * @param {boolean} [noTop] a table leg: its top is under the table top (no scanner sees it)
 */
function box(cx, cz, c, s, hx, hz, y0, y1, out, top, noTop = false) {
  const ax = [c, 0, s], az = [-s, 0, c], H = y1 - y0;
  const corner = (/** @type {number} */ lx, /** @type {number} */ ly, /** @type {number} */ lz) => [cx + lx * c - lz * s, ly, cz + lx * s + lz * c];
  if (!noTop) out.push({ o: corner(-hx, y1, -hz), u: ax, lu: 2 * hx, v: az, lv: 2 * hz, n: [0, 1, 0], keep: null, h: top, keepFrac: 1, wall: false });
  out.push({ o: corner(-hx, y0, -hz), u: ax, lu: 2 * hx, v: [0, 1, 0], lv: H, n: [s, 0, -c], keep: null, h: null, keepFrac: 1, wall: false });
  out.push({ o: corner(-hx, y0, hz), u: ax, lu: 2 * hx, v: [0, 1, 0], lv: H, n: [-s, 0, c], keep: null, h: null, keepFrac: 1, wall: false });
  out.push({ o: corner(-hx, y0, -hz), u: az, lu: 2 * hz, v: [0, 1, 0], lv: H, n: [-c, 0, -s], keep: null, h: null, keepFrac: 1, wall: false });
  out.push({ o: corner(hx, y0, -hz), u: az, lu: 2 * hz, v: [0, 1, 0], lv: H, n: [c, 0, s], keep: null, h: null, keepFrac: 1, wall: false });
}

/**
 * A table: a 4 cm top (top face, underside, edges) on four legs; open underneath.
 * @param {import('./Layout.js').Box} b @param {Patch[]} out
 */
function table(b, out) {
  const t = SCAN.tableTop, g = SCAN.leg;
  box(b.cx, b.cz, b.c, b.s, b.hx, b.hz, b.y1 - t, b.y1, out, null);
  const ax = [b.c, 0, b.s], az = [-b.s, 0, b.c];
  const under = [b.cx - b.hx * b.c + b.hz * b.s, b.y1 - t, b.cz - b.hx * b.s - b.hz * b.c];
  out.push({ o: under, u: ax, lu: 2 * b.hx, v: az, lv: 2 * b.hz, n: [0, -1, 0], keep: null, h: null, keepFrac: 1, wall: false });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * (b.hx - 2 * g), lz = sz * (b.hz - 2 * g);
      box(b.cx + lx * b.c - lz * b.s, b.cz + lx * b.s + lz * b.c, b.c, b.s, g, g, b.y0, b.y1 - t, out, null, true);
    }
  }
}

/**
 * A patch as a grid of triangles wound toward `n`, with noise along `n`.
 * @param {Patch} p @param {number} cell @param {number} noise @param {() => number} R
 * @param {number[]} V @param {number[]} I @param {number} holes
 */
function emit(p, cell, noise, R, V, I, holes) {
  const nu = Math.max(1, Math.round(p.lu / cell)), nv = Math.max(1, Math.round(p.lv / cell));
  const base = V.length / 3;
  const { o, u, v, n } = p;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const a = i / nu, b = j / nv;
      const hh = (p.h ? p.h(a, b) : 0) + (R() - 0.5) * 2 * noise;
      V.push(o[0] + u[0] * p.lu * a + v[0] * p.lv * b + n[0] * hh,
        o[1] + u[1] * p.lu * a + v[1] * p.lv * b + n[1] * hh,
        o[2] + u[2] * p.lu * a + v[2] * p.lv * b + n[2] * hh);
    }
  }
  // (k, k+1, k+nu+1) has normal u × v; flip when that disagrees with n
  const cx = u[1] * v[2] - u[2] * v[1], cy = u[2] * v[0] - u[0] * v[2], cz = u[0] * v[1] - u[1] * v[0];
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (p.keep && !p.keep((i + 0.5) / nu, (j + 0.5) / nv)) continue;
      if (holes > 0 && R() < holes) continue;
      const k = base + j * (nu + 1) + i, a = k, b = k + 1, c = k + nu + 1, d = k + nu + 2;
      if (!flip) I.push(a, b, c, b, d, c);
      else I.push(a, c, b, b, c, d);
    }
  }
}

/** Inverse of a rigid column-major 4×4. @param {ArrayLike<number>} m */
function rigidInverse(m) {
  const r = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[j * 4 + i] = m[i * 4 + j];
  for (let i = 0; i < 3; i++) r[12 + i] = -(r[i] * m[12] + r[4 + i] * m[13] + r[8 + i] * m[14]);
  r[15] = 1;
  return r;
}
