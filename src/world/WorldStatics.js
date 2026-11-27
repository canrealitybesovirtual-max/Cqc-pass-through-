// @ts-check
/**
 * Static collider geometry for physics (pure data: no three.js, no DOM, no
 * Rapier). Built with the world (in the world worker, or inside a synchronous
 * build) from the layout and the processed global mesh; `world.staticGeometry()`
 * returns it. Role P turns it into Rapier colliders; nothing here calls Rapier.
 *
 * ```
 * StaticGeometry = {
 *   version: 1, source: 'world',
 *   slabs: Float32Array,  slabCount       // SLAB_STRIDE (10) floats per cuboid:
 *       cx, cy, cz, hx, hy, hz, qy, qw, surf, role
 *       // q = (0, qy, 0, qw) rotates the cuboid's local x axis onto the box's (c, 0, s) axis (yaw only);
 *       // surf = MeshPrep SURF class (friction / restitution from MATERIAL); role = ROLE.*
 *   prisms: Float32Array, prismCount      // PRISM_STRIDE (18) floats per triangular prism (convex hull of 6 points):
 *       top triangle a, b, c (x, y, z each), then the same three 0.3 m below (floors) or above (ceilings)
 *   prismSurf: Uint8Array                 // SURF.FLOOR or SURF.CEIL per prism
 *   mesh: null | {                        // the processed global mesh for trimesh colliders (src/physics/PhysicsWorld.js)
 *       vertices: Float32Array,           //   collider positions (soft tops sunk 1.5 cm), tile by tile
 *       indices: Uint32Array,             //   3 per triangle into `vertices`, the triangles of a tile contiguous
 *       chunks: Int32Array,               //   3 per tile: firstTri, triCount, surf (one trimesh each)
 *       surf: Uint8Array, oneSided: boolean, stats }
 *   tiles: Int32Array, tileCount          // TILE_STRIDE (6) per tile: firstTri, triCount, surf, owner, vStart, vCount
 *   tileBounds: Float32Array              // 6 per tile: min x, y, z, max x, y, z
 *   localIndices: Uint32Array             // 3 per triangle, LOCAL to its tile (0 … vCount − 1): a zero-copy trimesh is
 *       // trimesh(mesh.vertices.subarray(3 * vStart, 3 * (vStart + vCount)), localIndices.subarray(3 * firstTri, 3 * (firstTri + triCount)))
 *   oneSided: boolean                     // the orientation is trustworthy: FIX_INTERNAL_EDGES may be used
 *   catchY: number                        // top of the catch slab (unmapped space below a door)
 *   bounds: Float32Array                  // x0, z0, x1, z1 of the house
 *   floorPts: Float64Array, floorOff: Int32Array, floorN: Int32Array, floorCount   // floor polygons (x, z) for the lost-object test
 *   stats: { slabs, backstops, catches, inferredWalls, prisms, tiles, tris, covered, oneSided }
 * }
 * ```
 *
 * Slabs (research-phys spec §4):
 * - every wall piece (door openings are gaps between pieces; a closed door is
 *   solid), inferred walls included (the game treats them as solid too);
 * - furniture the mesh covers: backstops inside the real surface, so nothing
 *   legitimate rests on them: a 4 cm slab with its top 3 cm below the top,
 *   shrunk 3 cm (the space under a table stays open), and for beds, couches and
 *   sofas also the whole volume shrunk 3 cm (ROLE.BACKSTOP);
 * - furniture the mesh does not cover: its volume box (ROLE.SURFACE);
 * - one catch slab 0.5 m thick under the whole house (at least 40 m, the house
 *   + 20 m) with its top 2 mm below the lowest floor (ROLE.CATCH): an item
 *   through a door into unmapped space lands at the real floor height.
 * Floors and ceilings are prisms (ear-clipped polygons extruded 0.3 m).
 */

import { SURF, TILE_STRIDE } from './MeshPrep.js';

export const SLAB_STRIDE = 10;
export const PRISM_STRIDE = 18;
export const ROLE = Object.freeze({ SURFACE: 0, BACKSTOP: 1, CATCH: 2 });
export const STATIC = Object.freeze({
  prismDepth: 0.3, backstopDrop: 0.03, backstopT: 0.04, backstopShrink: 0.03, catchMin: 40, catchPad: 10, catchT: 0.5, catchGap: 0.002,
});
/** Friction / restitution per SURF class (combine: Average friction, Min restitution). Items: polymer 0.6 / 0.15, steel 0.5 / 0.2. */
export const MATERIAL = Object.freeze([
  Object.freeze({ friction: 0.6, restitution: 0.15 }), // OTHER
  Object.freeze({ friction: 0.6, restitution: 0.2 }), // FLOOR
  Object.freeze({ friction: 0.5, restitution: 0.3 }), // WALL
  Object.freeze({ friction: 0.5, restitution: 0.3 }), // CEIL
  Object.freeze({ friction: 0.9, restitution: 0.0 }), // SOFT
  Object.freeze({ friction: 0.5, restitution: 0.25 }), // HARD
]);
export { TILE_STRIDE };

const SOLID_RE = /\b(bed|couch|sofa)\b/;

/**
 * @typedef {{ vertices: Float32Array, indices: Uint32Array, chunks: Int32Array, surf: Uint8Array, oneSided: boolean, stats: any }} StaticMesh
 * @typedef {{ version: number, source: string, slabs: Float32Array, slabCount: number, prisms: Float32Array, prismCount: number, prismSurf: Uint8Array,
 *   mesh: StaticMesh|null, tiles: Int32Array, tileCount: number, tileBounds: Float32Array, localIndices: Uint32Array,
 *   oneSided: boolean, catchY: number, bounds: Float32Array, floorPts: Float64Array, floorOff: Int32Array, floorN: Int32Array, floorCount: number,
 *   stats: { slabs: number, backstops: number, catches: number, inferredWalls: number, prisms: number, tiles: number, tris: number, covered: number, oneSided: boolean } }} StaticGeometry
 */

/**
 * @param {import('./Layout.js').Layout} L
 * @param {import('./MeshPrep.js').PreppedMesh|null} mesh
 * @param {Float32Array|null} positions colliderPositions(mesh) (tile-local layout)
 * @returns {StaticGeometry}
 */
export function buildStatics(L, mesh, positions) {
  /** @type {number[]} */ const slabs = [];
  const st = { slabs: 0, backstops: 0, catches: 0, inferredWalls: 0, prisms: 0, tiles: 0, tris: 0, covered: 0, oneSided: false };
  /**
   * @param {number} cx @param {number} cz @param {number} c @param {number} s @param {number} hx @param {number} hz
   * @param {number} y0 @param {number} y1 @param {number} surf @param {number} role
   */
  const slab = (cx, cz, c, s, hx, hz, y0, y1, surf, role) => {
    if (!(hx > 0.001 && hz > 0.001 && y1 - y0 > 0.002)) return;
    // rotation about +y by θ maps local x (1, 0, 0) to (cos θ, 0, −sin θ) = (c, 0, s): θ = atan2(−s, c)
    const th = Math.atan2(-s, c);
    slabs.push(cx, (y0 + y1) / 2, cz, hx, (y1 - y0) / 2, hz, Math.sin(th / 2), Math.cos(th / 2), surf, role);
    if (role === ROLE.BACKSTOP) st.backstops++;
    else if (role === ROLE.CATCH) st.catches++;
    st.slabs++;
  };
  for (const b of L.boxes) {
    if (b.kind !== 'wall') continue;
    if (b.source === 'inferred') st.inferredWalls++;
    slab(b.cx, b.cz, b.c, b.s, b.hx, b.hz, b.y0, b.y1, SURF.WALL, ROLE.SURFACE);
  }
  const covered = mesh ? mesh.covered : null;
  const S = STATIC;
  for (let k = 0; k < L.furniture.length; k++) {
    const b = L.furniture[k];
    const soft = SOLID_RE.test(b.label || '');
    const surf = soft ? SURF.SOFT : SURF.HARD;
    if (covered && covered[k]) {
      st.covered++;
      const top = b.y1 - S.backstopDrop;
      slab(b.cx, b.cz, b.c, b.s, b.hx - S.backstopShrink, b.hz - S.backstopShrink, top - S.backstopT, top, surf, ROLE.BACKSTOP);
      if (soft) slab(b.cx, b.cz, b.c, b.s, b.hx - S.backstopShrink, b.hz - S.backstopShrink, b.y0 + S.backstopShrink, b.y1 - S.backstopShrink, surf, ROLE.BACKSTOP);
    } else {
      slab(b.cx, b.cz, b.c, b.s, b.hx, b.hz, b.y0, b.y1, surf, ROLE.SURFACE);
    }
  }
  // catch slab under everything
  const B = L.bounds, bcx = (B.x0 + B.x1) / 2, bcz = (B.z0 + B.z1) / 2;
  const chx = Math.max(S.catchMin, B.x1 - B.x0 + 2 * S.catchPad) / 2, chz = Math.max(S.catchMin, B.z1 - B.z0 + 2 * S.catchPad) / 2;
  let lowest = Infinity;
  for (const f of L.floors) if (!f.virtual && f.y < lowest) lowest = f.y;
  if (lowest === Infinity) lowest = L.floorY0;
  const catchY = lowest - S.catchGap;
  slab(bcx, bcz, 1, 0, chx, chz, catchY - S.catchT, catchY, SURF.FLOOR, ROLE.CATCH);

  // floor and ceiling prisms
  /** @type {number[]} */ const pr = [];
  /** @type {number[]} */ const ps = [];
  const floors = L.floors.filter((f) => L.virtual || !f.virtual);
  for (const f of floors) addPrisms(f.pts, f.n, f.y, -S.prismDepth, pr, ps, SURF.FLOOR);
  for (const c of L.ceilings) addPrisms(c.pts, c.n, c.y, S.prismDepth, pr, ps, SURF.CEIL);
  st.prisms = ps.length;

  const tileCount = mesh ? mesh.tileCount : 0;
  st.tiles = tileCount;
  st.tris = mesh ? mesh.indices.length / 3 : 0;
  st.oneSided = !!(mesh && mesh.stats.oneSided);
  /** @type {StaticMesh|null} */ let sm = null;
  if (mesh && positions && tileCount > 0) {
    // tile-local indices → indices into the whole collider vertex array (P's chunk contract)
    const T = mesh.tiles, LI = mesh.tileIdx, gi = new Uint32Array(LI.length), chunks = new Int32Array(tileCount * 3);
    for (let k = 0; k < tileCount; k++) {
      const o = k * TILE_STRIDE, first = T[o], count = T[o + 1], v0 = T[o + 4];
      for (let i = 3 * first; i < 3 * (first + count); i++) gi[i] = LI[i] + v0;
      chunks[3 * k] = first; chunks[3 * k + 1] = count; chunks[3 * k + 2] = T[o + 2];
    }
    sm = { vertices: positions, indices: gi, chunks, surf: mesh.surf, oneSided: st.oneSided, stats: mesh.stats };
  }
  // floor polygons (x, z) for the lost-object test
  const fl = L.floors;
  let np = 0;
  for (const f of fl) np += f.n;
  const floorPts = new Float64Array(np * 2), floorOff = new Int32Array(fl.length), floorN = new Int32Array(fl.length);
  let off = 0;
  for (let k = 0; k < fl.length; k++) {
    const f = fl[k];
    floorOff[k] = off; floorN[k] = f.n;
    for (let i = 0; i < f.n * 2; i++) floorPts[off * 2 + i] = f.pts[i];
    off += f.n;
  }
  return {
    version: 1, source: 'world',
    slabs: Float32Array.from(slabs), slabCount: slabs.length / SLAB_STRIDE,
    prisms: Float32Array.from(pr), prismCount: ps.length, prismSurf: Uint8Array.from(ps),
    mesh: sm,
    tiles: mesh ? mesh.tiles : new Int32Array(0), tileCount,
    tileBounds: mesh ? mesh.tileBounds : new Float32Array(0),
    localIndices: mesh ? mesh.tileIdx : new Uint32Array(0),
    oneSided: st.oneSided, catchY, bounds: Float32Array.from([B.x0, B.z0, B.x1, B.z1]),
    floorPts, floorOff, floorN, floorCount: fl.length,
    stats: st,
  };
}

/**
 * Ear-clip a polygon (flat x, z pairs; either winding) and extrude each
 * triangle by `dy` (negative: down, a floor; positive: up, a ceiling).
 * @param {ArrayLike<number>} pts @param {number} n @param {number} y @param {number} dy
 * @param {number[]} out @param {number[]} surfOut @param {number} surf
 */
function addPrisms(pts, n, y, dy, out, surfOut, surf) {
  const tris = earClip(pts, n);
  for (let k = 0; k < tris.length; k += 3) {
    for (const yy of [y, y + dy]) {
      for (let j = 0; j < 3; j++) out.push(pts[2 * tris[k + j]], yy, pts[2 * tris[k + j] + 1]);
    }
    surfOut.push(surf);
  }
}

/**
 * Ear clipping (O(n²); floor polygons have a handful of points).
 * @param {ArrayLike<number>} pts flat x, z @param {number} n
 * @returns {number[]} triangle vertex indices
 */
export function earClip(pts, n) {
  /** @type {number[]} */ const idx = [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i);
  /** @type {number[]} */ const out = [];
  const X = (/** @type {number} */ i) => pts[2 * i], Z = (/** @type {number} */ i) => pts[2 * i + 1];
  const cross = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c) => (X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a));
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or flat
      let inside = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) { // degenerate leftovers: fan the rest
      for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]);
      return out;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
