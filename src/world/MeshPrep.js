// @ts-check
/**
 * The Space Setup global mesh → the game's processed mesh (pure: no three.js,
 * no DOM). Runs in the world worker (or inside a synchronous build) once per
 * build; allocates freely.
 *
 * Steps (`prepMesh`):
 * 1. **Transform and weld.** Mesh space → reference space with the captured
 *    pose; vertices within 1 mm merged; degenerate triangles dropped. The
 *    welded mesh is also what the session record stores (`raw`), so a desktop
 *    replay runs exactly this pipeline again.
 * 2. **Orient** (normals toward free space). The Quest mesh's winding is not
 *    documented, and Rapier's FIX_INTERNAL_EDGES makes a trimesh one-sided
 *    (the research bench: a body hitting a back face passes through), so:
 *    - each edge-connected component is made consistently wound (a breadth-
 *      first walk over manifold edges);
 *    - reference triangles vote, area-weighted, per component: near a floor →
 *      up; near a ceiling → down; on a real wall face → into its room (the
 *      wall's normal); a furniture top (within 3 cm of the Space Setup volume's
 *      top) → up; a furniture side → out of the volume;
 *    - a component with a decisive vote (|vote| ≥ 20 % of its reference area)
 *      follows it; otherwise, a component that encloses volume follows its
 *      centroid vote (outward); otherwise the whole mesh's convention (the
 *      sum of all votes) decides.
 *    `stats.upVotePct` is the reference area that agrees afterwards;
 *    `stats.oneSided` (≥ 80 %) tells physics whether a one-sided trimesh is safe.
 * 3. **Classify** each triangle (`SURF`): inside a furniture volume (inflated
 *    4 cm) → SOFT (bed, couch, sofa) or HARD (everything else), `owner` = the
 *    furniture index (layout.furniture order); else FLOOR / CEIL within 3 / 5 cm
 *    of the floor / ceiling and facing it; else WALL when coplanar (within 6 cm,
 *    |n · wall n| > 0.9) with a real wall face; else OTHER (unlabelled clutter:
 *    a chair, a basket, a wall Space Setup has no plane for).
 * 4. **Crop**: floors, ceilings and wall-coplanar triangles are dropped (the
 *    floor prisms, ceiling prisms and wall slabs replace them in physics, and
 *    the box occluder has the walls), and so is every triangle inside an open
 *    door's opening (± width/2 − 2 cm, its height, ± 0.35 m deep): the leaf
 *    was wherever it was during the scan.
 * 5. **Coverage**: a furniture volume is `covered` when it owns ≥ 40 kept
 *    triangles and its up-facing triangles (any height 15 cm or more over its
 *    base: a couch's seat lies well under its volume's top, the backrest)
 *    cover ≥ 50 % of its footprint. Covered
 *    furniture is drawn and hit through the mesh (the shape set and the box
 *    occluder drop its box); uncovered furniture keeps its box.
 * 6. **Tiles**: one tile per furniture owner (no seam across a table top),
 *    everything else in 1.5 m × 1.5 m tiles per class; at most 4096 triangles
 *    per tile; nearest to the build start first. Each tile has its own
 *    contiguous vertex range (`tileVerts` → global vertex) and local indices
 *    (`tileIdx`), so one tile is one contiguous upload for the occluder and one
 *    trimesh (subarray views, no copy) for physics.
 */

import { floorHeightAt } from './Layout.js';
import { pointInPolygon } from '../util/geom2d.js';

export const MESH = Object.freeze({
  weld: 0.001,
  minTriArea: 1e-7,
  floorBand: 0.03,
  ceilBand: 0.05,
  wallBand: 0.06,
  /** A wall face votes for orientation only this close (a furniture back 5 cm off the wall faces the wall). */
  wallRefBand: 0.03,
  wallCos: 0.9,
  horizCos: 0.9,
  doorDepth: 0.35,
  doorJamb: 0.02,
  labelPad: 0.04,
  /** Furniture tops: up to this far below the volume's top votes "up"; lumps up to topAbove above it still belong to it. */
  topBand: 0.03,
  topAbove: 0.1,
  sideBand: 0.03,
  /** Decisive component vote (share of its reference area). */
  decisive: 0.2,
  /** Centroid vote decisive share (closed blobs). */
  centroidDecisive: 0.3,
  oneSidedPct: 80,
  softSink: 0.015,
  occShrink: 0.01,
  tileSize: 1.5,
  maxTileTris: 4096,
  coverMinTris: 40,
  coverTopFrac: 0.5,
  /** Up-facing owned surface counts toward coverage from this far above the volume's base (any height above it: a couch's
   *  seat is ~40 cm under its volume's top, which is the backrest; v0.4 verifier). */
  coverAbove: 0.15,
  maxTris: 262144,
});

export const SURF = Object.freeze({ OTHER: 0, FLOOR: 1, WALL: 2, CEIL: 3, SOFT: 4, HARD: 5 });
/** Hit labels per class (`world.raycast` writes a furniture triangle's owner label instead). */
export const SURF_NAME = Object.freeze(['other', 'floor', 'wall', 'ceiling', 'soft', 'hard']);
/** Tile record: first triangle, triangle count, class, owner (−1), first tile-local vertex, vertex count. */
export const TILE_STRIDE = 6;

const SOFT_RE = /\b(bed|couch|sofa)\b/;

/**
 * @typedef {{ vertices: ArrayLike<number>, indices: ArrayLike<number>, pose?: ArrayLike<number>|null }} RawMeshInput
 * @typedef {{ rawTris: number, rawVerts: number, weldedVerts: number, degenerate: number, truncated: number, keptTris: number,
 *   cropped: { floor: number, ceiling: number, wall: number, door: number }, classes: number[], flippedByClass: number[], components: number,
 *   decidedByVote: number, decidedByCentroid: number, decidedByConvention: number, upVotePct: number, flippedPct: number,
 *   oneSided: boolean, covered: number, tiles: number, tileVerts: number, softSinkVerts: number, ms: number,
 *   phaseMs: { weld: number, orient: number, classify: number, tiles: number } }} MeshStats
 * @typedef {{ vertices: Float32Array, indices: Uint32Array, surf: Uint8Array, owner: Int16Array,
 *   tiles: Int32Array, tileBounds: Float32Array, tileCount: number, tileVerts: Uint32Array, tileIdx: Uint32Array,
 *   sink: Uint8Array, shrink: Uint8Array, vnormal: Float32Array, covered: Uint8Array, raw: { vertices: Float32Array, indices: Uint32Array },
 *   stats: MeshStats }} PreppedMesh
 *   vertices: welded, reference space, the real surface (every vertex of the welded mesh; kept triangles index them);
 *   indices / surf / owner: kept triangles in tile order; sink: vertices that sink by softSink for physics (soft tops);
 *   shrink: vertices the occluder moves 1 cm inward (hard and other surfaces); vnormal: area-weighted unit normal per vertex
 */

/**
 * Pick the global mesh among captured meshes: label 'global mesh', else the
 * largest with more than 5,000 triangles.
 * @param {{ label: string|null, indices?: ArrayLike<number>|null, vertices?: ArrayLike<number>|null }[]} meshes
 * @returns {number} index or −1
 */
export function pickGlobalMesh(meshes) {
  let best = -1, bestTris = 5000;
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const l = m && typeof m.label === 'string' ? m.label.toLowerCase().trim().replace(/[_-]+/g, ' ') : '';
    const tris = m && m.indices ? Math.floor(m.indices.length / 3) : 0;
    if (l === 'global mesh' && tris > 0) return i;
    if (tris > bestTris) { bestTris = tris; best = i; }
  }
  return best;
}

/**
 * @param {RawMeshInput} raw
 * @param {import('./Layout.js').Layout} layout
 * @param {{ start?: { x: number, z: number } }} [opts]
 * @param {typeof MESH} [o]
 * @returns {PreppedMesh}
 */
export function prepMesh(raw, layout, opts = {}, o = MESH) {
  const t0 = now();
  const L = layout;
  const st = /** @type {MeshStats} */ ({
    rawTris: Math.floor(raw.indices.length / 3), rawVerts: Math.floor(raw.vertices.length / 3), weldedVerts: 0, degenerate: 0, truncated: 0,
    keptTris: 0, cropped: { floor: 0, ceiling: 0, wall: 0, door: 0 }, classes: [0, 0, 0, 0, 0, 0], flippedByClass: [0, 0, 0, 0, 0, 0], components: 0,
    decidedByVote: 0, decidedByCentroid: 0, decidedByConvention: 0, upVotePct: 0, flippedPct: 0, oneSided: false,
    covered: 0, tiles: 0, tileVerts: 0, softSinkVerts: 0, ms: 0, phaseMs: { weld: 0, orient: 0, classify: 0, tiles: 0 },
  });

  // ── 1. transform + weld ───────────────────────────────────────────────
  const { V, map, nv } = weld(raw, o.weld);
  st.weldedVerts = nv;
  const I0 = raw.indices;
  let m = Math.floor(I0.length / 3);
  const tri = new Uint32Array(Math.min(m, o.maxTris) * 3);
  let nt = 0;
  for (let t = 0; t < m; t++) {
    const a = map[I0[3 * t]], b = map[I0[3 * t + 1]], c = map[I0[3 * t + 2]];
    if (a === b || b === c || a === c || a < 0 || b < 0 || c < 0) { st.degenerate++; continue; }
    if (triArea(V, a, b, c) < o.minTriArea) { st.degenerate++; continue; }
    if (nt >= o.maxTris) { st.truncated++; continue; }
    tri[3 * nt] = a; tri[3 * nt + 1] = b; tri[3 * nt + 2] = c;
    nt++;
  }
  m = nt;
  const deliveredIdx = tri.slice(0, 3 * m); // welded, as delivered: the session record's mesh
  const rawIdx = tri.subarray(0, 3 * m); // oriented in place below
  const rawVerts = V.slice(0, nv * 3);

  // per-triangle geometry (as delivered)
  const N = new Float32Array(3 * m), A = new Float32Array(m), C = new Float32Array(3 * m);
  for (let t = 0; t < m; t++) geomOf(V, rawIdx, t, N, A, C);
  let tp = now();
  st.phaseMs.weld = tp - t0;

  // ── 2. orient ─────────────────────────────────────────────────────────
  const flip = orient(V, nv, rawIdx, m, N, A, C, L, o, st);
  st.phaseMs.orient = now() - tp;
  tp = now();
  for (let t = 0; t < m; t++) {
    if (!flip[t]) continue;
    const b = rawIdx[3 * t + 1];
    rawIdx[3 * t + 1] = rawIdx[3 * t + 2];
    rawIdx[3 * t + 2] = b;
    N[3 * t] = -N[3 * t]; N[3 * t + 1] = -N[3 * t + 1]; N[3 * t + 2] = -N[3 * t + 2];
  }

  // ── 3–4. classify + crop ──────────────────────────────────────────────
  const surf = new Uint8Array(m), owner = new Int16Array(m).fill(-1), keep = new Uint8Array(m);
  const furn = L.furniture, nf = furn.length;
  const softF = new Uint8Array(nf);
  for (let k = 0; k < nf; k++) softF[k] = SOFT_RE.test(furn[k].label || '') ? 1 : 0;
  const ownTris = new Int32Array(nf), ownTop = new Float64Array(nf);
  const walls = L.walls.filter((w) => !w.inferred);
  const doors = L.doors.filter((d) => d.open);
  for (let t = 0; t < m; t++) {
    const cx = C[3 * t], cy = C[3 * t + 1], cz = C[3 * t + 2];
    const nx = N[3 * t], ny = N[3 * t + 1], nz = N[3 * t + 2];
    /** @type {number} */ let s = SURF.OTHER;
    let crop = 0, f = -1;
    if (ny > o.horizCos && Math.abs(cy - floorHeightAt(L.floors, L.floorRef, cx, cz)) < o.floorBand) {
      s = SURF.FLOOR; crop = 1; // also under a table or a bed: the floor, not the furniture
    } else if (ny < -o.horizCos && nearCeiling(L, cx, cy, cz, o.ceilBand)) {
      s = SURF.CEIL; crop = 2;
    } else if (Math.abs(ny) < 0.3 && onWall(walls, cx, cy, cz, nx, nz, o)) {
      s = SURF.WALL; crop = 3; // also the back of a couch against the wall: the slab is there
    } else if ((f = ownerOf(furn, cx, cy, cz, o)) >= 0) {
      s = softF[f] ? SURF.SOFT : SURF.HARD;
      owner[t] = f;
    }
    if (!crop && inDoor(doors, cx, cy, cz, o)) crop = 4;
    surf[t] = s;
    st.classes[s]++;
    if (flip[t]) st.flippedByClass[s]++;
    if (crop === 1) st.cropped.floor++;
    else if (crop === 2) st.cropped.ceiling++;
    else if (crop === 3) st.cropped.wall++;
    else if (crop === 4) st.cropped.door++;
    if (crop) continue;
    keep[t] = 1;
    if (f >= 0) {
      ownTris[f]++;
      if (ny > 0.7 && cy >= furn[f].y0 + o.coverAbove) ownTop[f] += A[t] * ny;
    }
  }

  st.phaseMs.classify = now() - tp;
  tp = now();

  // ── 5. coverage ──────────────────────────────────────────────────────
  const covered = new Uint8Array(nf);
  for (let k = 0; k < nf; k++) {
    const b = furn[k];
    if (ownTris[k] >= o.coverMinTris && ownTop[k] >= o.coverTopFrac * 4 * b.hx * b.hz) { covered[k] = 1; st.covered++; }
  }

  // ── 6. tiles ─────────────────────────────────────────────────────────
  let kept = 0;
  for (let t = 0; t < m; t++) kept += keep[t];
  st.keptTris = kept;
  const sx = opts.start && Number.isFinite(opts.start.x) ? opts.start.x : 0, sz = opts.start && Number.isFinite(opts.start.z) ? opts.start.z : 0;
  const tiles = makeTiles(m, keep, surf, owner, C, rawIdx, nv, V, sx, sz, o);
  st.tiles = tiles.tileCount;
  st.tileVerts = tiles.tileVerts.length;

  // per-vertex flags over kept triangles: sink (soft tops), shrink (hard / other), area-weighted normals
  const sink = new Uint8Array(nv), soft = new Uint8Array(nv), hard = new Uint8Array(nv), vn = new Float32Array(nv * 3);
  for (let t = 0; t < m; t++) {
    if (!keep[t]) continue;
    const s = surf[t], ny = N[3 * t + 1];
    for (let j = 0; j < 3; j++) {
      const v = rawIdx[3 * t + j];
      vn[3 * v] += N[3 * t] * A[t]; vn[3 * v + 1] += ny * A[t]; vn[3 * v + 2] += N[3 * t + 2] * A[t];
      if (s === SURF.SOFT) { soft[v] = 1; if (ny > 0.7) sink[v] = 1; } else hard[v] = 1;
    }
  }
  const shrink = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = vn[3 * v], y = vn[3 * v + 1], z = vn[3 * v + 2], l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0) { vn[3 * v] = x / l; vn[3 * v + 1] = y / l; vn[3 * v + 2] = z / l; }
    if (hard[v] && !soft[v]) shrink[v] = 1;
    if (sink[v]) st.softSinkVerts++;
  }

  st.phaseMs.tiles = now() - tp;
  for (const k of /** @type {const} */ (['weld', 'orient', 'classify', 'tiles'])) st.phaseMs[k] = Math.round(st.phaseMs[k] * 10) / 10;
  st.ms = Math.round((now() - t0) * 10) / 10;
  return {
    vertices: rawVerts, indices: tiles.indices, surf: tiles.surf, owner: tiles.owner,
    tiles: tiles.tiles, tileBounds: tiles.bounds, tileCount: tiles.tileCount, tileVerts: tiles.tileVerts, tileIdx: tiles.tileIdx,
    sink, shrink, vnormal: vn, covered, raw: { vertices: rawVerts, indices: deliveredIdx }, stats: st,
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Transform to the reference space and weld within `eps` (a hash on the
 * quantised position).
 * @param {RawMeshInput} raw @param {number} eps
 */
function weld(raw, eps) {
  const src = raw.vertices, n = Math.floor(src.length / 3);
  const P = raw.pose && raw.pose.length === 16 ? raw.pose : null;
  const V = new Float32Array(n * 3);
  const map = new Int32Array(n).fill(-1);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  const inv = 1 / eps;
  let nv = 0;
  for (let i = 0; i < n; i++) {
    let x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
    if (P) {
      const a = x, b = y, c = z;
      x = P[0] * a + P[4] * b + P[8] * c + P[12];
      y = P[1] * a + P[5] * b + P[9] * c + P[13];
      z = P[2] * a + P[6] * b + P[10] * c + P[14];
    }
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    const ix = Math.round(x * inv), iy = Math.round(y * inv), iz = Math.round(z * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) {
        table[h] = nv;
        qx[nv] = ix; qy[nv] = iy; qz[nv] = iz;
        V[3 * nv] = x; V[3 * nv + 1] = y; V[3 * nv + 2] = z;
        map[i] = nv++;
        break;
      }
      if (qx[e] === ix && qy[e] === iy && qz[e] === iz) { map[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  return { V, map, nv };
}

/** @param {Float32Array} V @param {number} a @param {number} b @param {number} c */
function triArea(V, a, b, c) {
  const ux = V[3 * b] - V[3 * a], uy = V[3 * b + 1] - V[3 * a + 1], uz = V[3 * b + 2] - V[3 * a + 2];
  const vx = V[3 * c] - V[3 * a], vy = V[3 * c + 1] - V[3 * a + 1], vz = V[3 * c + 2] - V[3 * a + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

/**
 * Unit normal, area and centroid of triangle t.
 * @param {Float32Array} V @param {Uint32Array} I @param {number} t
 * @param {Float32Array} N @param {Float32Array} A @param {Float32Array} C
 */
function geomOf(V, I, t, N, A, C) {
  const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  N[3 * t] = x / l; N[3 * t + 1] = y / l; N[3 * t + 2] = z / l;
  A[t] = 0.5 * l;
  C[3 * t] = (V[a] + V[b] + V[c]) / 3;
  C[3 * t + 1] = (V[a + 1] + V[b + 1] + V[c + 1]) / 3;
  C[3 * t + 2] = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
}

/**
 * Furniture volume (inflated) holding a point, −1 if none. Lumps up to
 * `topAbove` over the volume's top still belong to it (a pillow ridge).
 * @param {import('./Layout.js').Box[]} furn @param {number} x @param {number} y @param {number} z @param {typeof MESH} o
 */
function ownerOf(furn, x, y, z, o) {
  const pad = o.labelPad;
  for (let k = 0; k < furn.length; k++) {
    const b = furn[k];
    if (y < b.y0 - pad || y > b.y1 + o.topAbove) continue;
    const rx = x - b.cx, rz = z - b.cz;
    const lx = rx * b.c + rz * b.s, lz = rz * b.c - rx * b.s;
    if (lx >= -b.hx - pad && lx <= b.hx + pad && lz >= -b.hz - pad && lz <= b.hz + pad) return k;
  }
  return -1;
}

/** @param {import('./Layout.js').Layout} L @param {number} x @param {number} y @param {number} z @param {number} band */
function nearCeiling(L, x, y, z, band) {
  for (const c of L.ceilings) {
    if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1 && pointInPolygon(c.pts, c.n, x, z)) return Math.abs(y - c.y) < band;
  }
  return L.ceilingY === L.ceilingY && Math.abs(y - L.ceilingY) < band;
}

/**
 * On a real wall face (within wallBand, coplanar)?
 * @param {import('./Layout.js').Wall[]} walls
 * @param {number} x @param {number} y @param {number} z @param {number} nx @param {number} nz @param {typeof MESH} o
 */
function onWall(walls, x, y, z, nx, nz, o) {
  return wallAt(walls, x, y, z, nx, nz, o, o.wallBand) >= 0;
}

/**
 * The real wall whose face a vertical triangle lies on, −1 if none.
 * @param {import('./Layout.js').Wall[]} walls
 * @param {number} x @param {number} y @param {number} z @param {number} nx @param {number} nz @param {typeof MESH} o
 * @param {number} band
 */
function wallAt(walls, x, y, z, nx, nz, o, band) {
  for (let k = 0; k < walls.length; k++) {
    const w = walls[k];
    if (y < w.y0 - 0.1 || y > w.y1 + 0.1) continue;
    if (Math.abs(nx * w.nx + nz * w.nz) < o.wallCos) continue;
    const rx = x - w.ax, rz = z - w.az;
    const u = rx * w.tx + rz * w.tz, d = rx * w.nx + rz * w.nz;
    if (u < -0.1 || u > w.len + 0.1 || Math.abs(d) > band) continue;
    return k;
  }
  return -1;
}

/**
 * Inside an open door's opening?
 * @param {import('./Layout.js').Door[]} doors @param {number} x @param {number} y @param {number} z @param {typeof MESH} o
 */
function inDoor(doors, x, y, z, o) {
  for (let k = 0; k < doors.length; k++) {
    const d = doors[k];
    if (y <= d.y0 + 0.02 || y >= d.y1) continue;
    const rx = x - d.cx, rz = z - d.cz;
    const u = rx * d.tx + rz * d.tz, w = rx * d.nx + rz * d.nz;
    if (Math.abs(u) < d.width / 2 - o.doorJamb && Math.abs(w) < o.doorDepth) return true;
  }
  return false;
}

/**
 * Consistent winding per edge-connected component, then one flip decision per
 * component (see the header). Returns the per-triangle flip flags.
 * @param {Float32Array} V @param {number} nv @param {Uint32Array} I @param {number} m
 * @param {Float32Array} N @param {Float32Array} A @param {Float32Array} C
 * @param {import('./Layout.js').Layout} L @param {typeof MESH} o @param {MeshStats} st
 */
function orient(V, nv, I, m, N, A, C, L, o, st) {
  // vertex → triangles (CSR)
  const vs = new Int32Array(nv + 1);
  for (let k = 0; k < 3 * m; k++) vs[I[k] + 1]++;
  for (let v = 0; v < nv; v++) vs[v + 1] += vs[v];
  const vl = new Int32Array(3 * m), fill = vs.slice(0, nv);
  for (let t = 0; t < m; t++) for (let j = 0; j < 3; j++) vl[fill[I[3 * t + j]]++] = t;

  const flip = new Uint8Array(m), comp = new Int32Array(m).fill(-1);
  const queue = new Int32Array(m);
  let nc = 0;
  /** Does triangle n (as delivered) contain the directed edge u → v? */
  const hasDir = (/** @type {number} */ n, /** @type {number} */ u, /** @type {number} */ v) => {
    const p = I[3 * n], q = I[3 * n + 1], r = I[3 * n + 2];
    return (p === u && q === v) || (q === u && r === v) || (r === u && p === v);
  };
  for (let seed = 0; seed < m; seed++) {
    if (comp[seed] >= 0) continue;
    const c = nc++;
    comp[seed] = c;
    let qh = 0, qt = 0;
    queue[qt++] = seed;
    while (qh < qt) {
      const t = queue[qh++];
      const a = I[3 * t], b = I[3 * t + 1], cc = I[3 * t + 2];
      for (let e = 0; e < 3; e++) {
        // t's effective directed edge u → v
        let u = e === 0 ? a : e === 1 ? b : cc, v = e === 0 ? b : e === 1 ? cc : a;
        if (flip[t]) { const x = u; u = v; v = x; }
        // the triangles sharing {u, v}
        let other = -1, count = 0;
        for (let k = vs[u]; k < vs[u + 1]; k++) {
          const n = vl[k];
          if (n === t) continue;
          const p = I[3 * n], q = I[3 * n + 1], r = I[3 * n + 2];
          if (p === v || q === v || r === v) { other = n; count++; }
        }
        if (count !== 1 || comp[other] >= 0) continue;
        comp[other] = c;
        flip[other] = hasDir(other, u, v) ? 1 : 0; // the same direction → reverse it
        queue[qt++] = other;
      }
    }
  }
  st.components = nc;

  // votes per component (in the BFS orientation)
  const vote = new Float64Array(nc), refA = new Float64Array(nc), cen = new Float64Array(nc * 4);
  const ref = new Int8Array(m); // +1: the effective normal agrees with its reference, −1 disagrees, 0 none
  const furn = L.furniture, walls = L.walls.filter((w) => !w.inferred);
  for (let t = 0; t < m; t++) {
    const s = flip[t] ? -1 : 1;
    const nx = N[3 * t] * s, ny = N[3 * t + 1] * s, nz = N[3 * t + 2] * s;
    const x = C[3 * t], y = C[3 * t + 1], z = C[3 * t + 2];
    const c = comp[t];
    cen[4 * c] += x * A[t]; cen[4 * c + 1] += y * A[t]; cen[4 * c + 2] += z * A[t]; cen[4 * c + 3] += A[t];
    let dx = 0, dy = 0, dz = 0;
    if (Math.abs(ny) > o.horizCos) {
      if (Math.abs(y - floorHeightAt(L.floors, L.floorRef, x, z)) < o.floorBand) dy = 1;
      else if (nearCeiling(L, x, y, z, o.ceilBand)) dy = -1;
      else {
        const f = ownerOf(furn, x, y, z, o);
        if (f >= 0 && y >= furn[f].y1 - o.topBand) dy = 1;
      }
    } else if (Math.abs(ny) < 0.3) {
      const w = wallAt(walls, x, y, z, nx, nz, o, o.wallRefBand);
      if (w >= 0) { dx = walls[w].nx; dz = walls[w].nz; }
      else {
        const f = ownerOf(furn, x, y, z, o);
        if (f >= 0) {
          const b = furn[f], rx = x - b.cx, rz = z - b.cz;
          const lx = rx * b.c + rz * b.s, lz = rz * b.c - rx * b.s;
          const ax = nx * b.c + nz * b.s, az = nz * b.c - nx * b.s; // normal in the box frame
          if (Math.abs(ax) > 0.9 && Math.abs(lx) > b.hx - o.sideBand) { const sg = lx > 0 ? 1 : -1; dx = b.c * sg; dz = b.s * sg; }
          else if (Math.abs(az) > 0.9 && Math.abs(lz) > b.hz - o.sideBand) { const sg = lz > 0 ? 1 : -1; dx = -b.s * sg; dz = b.c * sg; }
        }
      }
    }
    if (dx === 0 && dy === 0 && dz === 0) continue;
    const agree = nx * dx + ny * dy + nz * dz > 0 ? 1 : -1;
    ref[t] = agree;
    vote[c] += agree * A[t];
    refA[c] += A[t];
  }
  // centroid votes (outward from the component's area centroid)
  const cv = new Float64Array(nc), cw = new Float64Array(nc);
  for (let c = 0; c < nc; c++) if (cen[4 * c + 3] > 0) { cen[4 * c] /= cen[4 * c + 3]; cen[4 * c + 1] /= cen[4 * c + 3]; cen[4 * c + 2] /= cen[4 * c + 3]; }
  for (let t = 0; t < m; t++) {
    const c = comp[t];
    if (refA[c] > 0 && Math.abs(vote[c]) >= o.decisive * refA[c]) continue; // decided already
    const s = flip[t] ? -1 : 1;
    const rx = C[3 * t] - cen[4 * c], ry = C[3 * t + 1] - cen[4 * c + 1], rz = C[3 * t + 2] - cen[4 * c + 2];
    const d = (N[3 * t] * rx + N[3 * t + 1] * ry + N[3 * t + 2] * rz) * s;
    cv[c] += d * A[t];
    cw[c] += Math.sqrt(rx * rx + ry * ry + rz * rz) * A[t];
  }
  let G = 0;
  for (let c = 0; c < nc; c++) G += vote[c];
  const flipC = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) {
    if (refA[c] > 0 && Math.abs(vote[c]) >= o.decisive * refA[c]) { flipC[c] = vote[c] < 0 ? 1 : 0; st.decidedByVote++; }
    else if (cw[c] > 0 && Math.abs(cv[c]) >= o.centroidDecisive * cw[c]) { flipC[c] = cv[c] < 0 ? 1 : 0; st.decidedByCentroid++; }
    else { flipC[c] = G < 0 ? 1 : 0; st.decidedByConvention++; }
  }
  let agreeA = 0, totalA = 0, flipped = 0;
  for (let t = 0; t < m; t++) {
    if (flipC[comp[t]]) flip[t] ^= 1;
    if (flip[t]) flipped++;
    if (ref[t] !== 0) {
      totalA += A[t];
      const r = flipC[comp[t]] ? -ref[t] : ref[t];
      if (r > 0) agreeA += A[t];
    }
  }
  st.upVotePct = totalA > 0 ? Math.round((agreeA / totalA) * 1000) / 10 : 0;
  st.flippedPct = m > 0 ? Math.round((flipped / m) * 1000) / 10 : 0;
  st.oneSided = totalA > 0 && st.upVotePct >= o.oneSidedPct;
  return flip;
}

/**
 * Group the kept triangles into tiles, nearest to (sx, sz) first, each with its
 * own contiguous tile-local vertex range.
 * @param {number} m @param {Uint8Array} keep @param {Uint8Array} surf @param {Int16Array} owner @param {Float32Array} C
 * @param {Uint32Array} I @param {number} nv @param {Float32Array} V @param {number} sx @param {number} sz @param {typeof MESH} o
 */
function makeTiles(m, keep, surf, owner, C, I, nv, V, sx, sz, o) {
  /** @type {Map<number, number[]>} */ const groups = new Map();
  const ownerCount = new Map();
  for (let t = 0; t < m; t++) if (keep[t] && owner[t] >= 0) ownerCount.set(owner[t], (ownerCount.get(owner[t]) || 0) + 1);
  const ts = o.tileSize;
  for (let t = 0; t < m; t++) {
    if (!keep[t]) continue;
    const gx = Math.floor(C[3 * t] / ts) + 4096, gz = Math.floor(C[3 * t + 2] / ts) + 4096;
    const f = owner[t];
    let key;
    if (f >= 0 && (ownerCount.get(f) || 0) <= o.maxTileTris) key = -1 - f;
    else key = ((gx * 8192 + gz) * 8 + surf[t]) * 4096 + (f >= 0 ? f + 1 : 0);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(t);
  }
  // split oversized groups along their longer axis
  /** @type {number[][]} */ const list = [];
  for (const g of groups.values()) splitGroup(g, C, o.maxTileTris, list);
  // order: nearest tile centre to the start first
  const info = list.map((g) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const t of g) {
      for (let j = 0; j < 3; j++) {
        const v = 3 * I[3 * t + j];
        if (V[v] < x0) x0 = V[v];
        if (V[v] > x1) x1 = V[v];
        if (V[v + 1] < y0) y0 = V[v + 1];
        if (V[v + 1] > y1) y1 = V[v + 1];
        if (V[v + 2] < z0) z0 = V[v + 2];
        if (V[v + 2] > z1) z1 = V[v + 2];
      }
    }
    const cx = (x0 + x1) / 2 - sx, cz = (z0 + z1) / 2 - sz;
    return { g, b: [x0, y0, z0, x1, y1, z1], d: cx * cx + cz * cz };
  });
  info.sort((a, b) => a.d - b.d);
  const n = info.length;
  let kept = 0;
  for (const e of info) kept += e.g.length;
  const tiles = new Int32Array(n * TILE_STRIDE), bounds = new Float32Array(n * 6);
  const indices = new Uint32Array(kept * 3), tileIdx = new Uint32Array(kept * 3);
  const surfOut = new Uint8Array(kept), ownerOut = new Int16Array(kept);
  const stamp = new Int32Array(nv).fill(-1), local = new Int32Array(nv);
  /** @type {number[]} */ const tv = [];
  let p = 0;
  for (let k = 0; k < n; k++) {
    const { g, b } = info[k];
    const vStart = tv.length;
    const first = p;
    for (const t of g) {
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j];
        if (stamp[v] !== k) { stamp[v] = k; local[v] = tv.length - vStart; tv.push(v); }
        indices[3 * p + j] = v;
        tileIdx[3 * p + j] = local[v];
      }
      surfOut[p] = surf[t];
      ownerOut[p] = owner[t];
      p++;
    }
    const o6 = k * TILE_STRIDE;
    tiles[o6] = first; tiles[o6 + 1] = g.length; tiles[o6 + 2] = surf[g[0]]; tiles[o6 + 3] = owner[g[0]];
    tiles[o6 + 4] = vStart; tiles[o6 + 5] = tv.length - vStart;
    for (let j = 0; j < 6; j++) bounds[6 * k + j] = b[j];
  }
  return { tiles, bounds, tileCount: n, indices, tileIdx, surf: surfOut, owner: ownerOut, tileVerts: Uint32Array.from(tv) };
}

/**
 * @param {number[]} g triangles @param {Float32Array} C @param {number} max @param {number[][]} out
 */
function splitGroup(g, C, max, out) {
  if (g.length <= max) { out.push(g); return; }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const t of g) {
    const x = C[3 * t], z = C[3 * t + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const ax = x1 - x0 >= z1 - z0 ? 0 : 2;
  g.sort((a, b) => C[3 * a + ax] - C[3 * b + ax]);
  const h = g.length >> 1;
  splitGroup(g.slice(0, h), C, max, out);
  splitGroup(g.slice(h), C, max, out);
}

/**
 * Occluder positions in the tile-local layout: the real surface moved 1 cm
 * inward (against the vertex normal) on hard and unlabelled surfaces, not at
 * all on soft ones (a gun lying in the duvet keeps its bottom hidden).
 * @param {PreppedMesh} p @param {Float32Array} [out] capacity ≥ tileVerts × 3
 * @param {number} [shrinkM]
 */
export function occluderPositions(p, out, shrinkM = MESH.occShrink) {
  const n = p.tileVerts.length;
  const o = out || new Float32Array(n * 3);
  const V = p.vertices, N = p.vnormal, S = p.shrink;
  for (let k = 0; k < n; k++) {
    const v = p.tileVerts[k], d = S[v] ? shrinkM : 0;
    o[3 * k] = V[3 * v] - N[3 * v] * d;
    o[3 * k + 1] = V[3 * v + 1] - N[3 * v + 1] * d;
    o[3 * k + 2] = V[3 * v + 2] - N[3 * v + 2] * d;
  }
  return o;
}

/**
 * Collider positions in the tile-local layout: soft tops 1.5 cm lower (a real
 * gun sinks into a duvet), everything else the real surface.
 * @param {PreppedMesh} p @param {Float32Array} [out] @param {number} [sinkM]
 */
export function colliderPositions(p, out, sinkM = MESH.softSink) {
  const n = p.tileVerts.length;
  const o = out || new Float32Array(n * 3);
  const V = p.vertices, K = p.sink;
  for (let k = 0; k < n; k++) {
    const v = p.tileVerts[k];
    o[3 * k] = V[3 * v];
    o[3 * k + 1] = V[3 * v + 1] - (K[v] ? sinkM : 0);
    o[3 * k + 2] = V[3 * v + 2];
  }
  return o;
}
