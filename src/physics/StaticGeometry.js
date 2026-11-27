// @ts-check
/**
 * The real house as static colliders, as plain data for PhysicsWorld (pure:
 * no three.js, no DOM). Research spec §4 "StaticGeometry".
 *
 * The world builder (S) may provide its own `world.staticGeometry()` (planes
 * plus the processed Space Setup global mesh: oriented trimesh tiles, with
 * furniture backstops inside the real surfaces). Until it does, or when the
 * scan has no mesh, `staticFromLayout` builds the planes-only version from
 * the World's layout (the same walls, doors, floors and furniture boxes the
 * bullets and the occluder use):
 *
 * - floors: every floor polygon (mapped, virtual patch, door pockets)
 *   ear-clipped, each triangle a 0.3 m prism with its top at the floor height;
 * - a catch slab (at least 40 × 40 × 0.5 m) with its top 2 mm under the main
 *   floor, so an item thrown through a door into unmapped space lands at the
 *   real floor height (and the lost-object net returns it after 10 s);
 * - walls: the layout's wall pieces as boxes (open doors stay open, closed
 *   doors solid); ceilings: prisms (a slab when only a height is known);
 * - furniture: beds and couches as their full box, soft (the top 1 cm lower:
 *   a 0.9 kg pistol presses into a duvet about that much; a couch's top is its
 *   seat plane when Space Setup has one under the volume's top, since the
 *   volume includes the backrest and its side is unknown); tables and desks
 *   as a 4 cm top only, so the space under a table stays open; everything
 *   else (shelves, storage, screens) as its full box, hard.
 *
 * With a mesh (`opts.mesh`, a PreppedMesh from the world builder) furniture
 * the mesh covers (40+ upward triangles over at least half its top) turns
 * into backstops inside the real surface: a 4 cm slab 3 cm under each top,
 * the rectangle shrunk 3 cm, and for beds and couches the whole volume shrunk
 * 3 cm. Nothing legitimate ever rests on a backstop; an item that does fell
 * through the one-sided mesh and is lifted back on top.
 *
 * Materials by surface (friction / restitution; combine: average friction,
 * minimum restitution): SOFT 0.9 / 0.0, HARD 0.5 / 0.25, FLOOR 0.6 / 0.2,
 * WALL 0.5 / 0.3, CEIL 0.5 / 0.3, OTHER 0.6 / 0.15.
 */

/** Surface classes (also the mesh's per-triangle `surf`). */
export const SURF = Object.freeze({ OTHER: 0, FLOOR: 1, WALL: 2, CEIL: 3, SOFT: 4, HARD: 5 });
export const SURF_NAMES = Object.freeze(['other', 'floor', 'wall', 'ceiling', 'soft', 'hard']);
/** Slab roles. */
export const ROLE = Object.freeze({ SURFACE: 0, BACKSTOP: 1, CATCH: 2 });

/** [friction, restitution] per SURF. */
export const MATERIAL = Object.freeze([
  Object.freeze([0.6, 0.15]),   // OTHER (unlabelled clutter)
  Object.freeze([0.6, 0.2]),    // FLOOR
  Object.freeze([0.5, 0.3]),    // WALL
  Object.freeze([0.5, 0.3]),    // CEIL
  Object.freeze([0.9, 0.0]),    // SOFT: bed, couch (damped: no bounce)
  Object.freeze([0.5, 0.25]),   // HARD: table, desk, shelf, storage
]);

export const STATIC = Object.freeze({
  slabStride: 10,     // cx, cy, cz, hx, hy, hz, sinHalfYaw, cosHalfYaw, surf, role
  prismStride: 18,    // 6 points: the triangle at the top, then at the bottom
  floorThick: 0.3,
  ceilThick: 0.3,
  catchMin: 40,       // m side of the catch slab (at least; the house + 20 m margin)
  catchThick: 0.5,
  catchDrop: 0.002,   // m under the main floor
  topSlab: 0.04,      // m: a table top
  softSink: 0.01,     // m a soft top is lowered (planes only)
  backInset: 0.03,    // m a backstop sits inside the real surface
  backThick: 0.04,
  coverTris: 40,      // upward mesh triangles that make a furniture top "covered"
  coverArea: 0.5,     // fraction of the top area
  minHalf: 0.005,     // m: thinner boxes are dropped
});

const SOFT_RE = /\b(bed|beds|couch|sofa|mattress|futon)\b/;
const TOP_RE = /\b(table|desk|counter)\b/;

/**
 * Surface class of a furniture label.
 * @param {string|null|undefined} label
 */
export function surfOfLabel(label) {
  const l = (label || '').toLowerCase();
  return SOFT_RE.test(l) ? SURF.SOFT : SURF.HARD;
}

/**
 * @typedef {{ vertices: Float32Array, indices: Uint32Array, surf?: Uint8Array|null, chunks?: Int32Array|null,
 *   oneSided?: boolean, stats?: any }} PreppedMesh
 *   vertices in the reference space; chunks: [firstTri, triCount, surf] (triangles of a chunk contiguous in indices)
 * @typedef {{ slabs: Float32Array, slabCount: number, prisms: Float32Array, prismCount: number, prismSurf?: Uint8Array,
 *   mesh: PreppedMesh|null, oneSided: boolean, catchY: number, bounds: Float32Array,
 *   floorPts?: Float64Array, floorOff?: Int32Array, floorN?: Int32Array, floorCount?: number, source?: string,
 *   tiles?: Int32Array, tileCount?: number, localIndices?: Uint32Array }} StaticGeometry
 *   bounds: x0, z0, x1, z1; floorPts / floorOff / floorN: the floor polygons (x, z pairs) for the lost-object test;
 *   tiles / tileCount / localIndices: the world builder's zero-copy tile layout (WorldStatics.js: 6 per tile,
 *   firstTri, triCount, surf, owner, vStart, vCount; indices local to the tile)
 */

/**
 * Planes-only static geometry (plus optional mesh) from a World layout.
 * @param {{ floors: any[], ceilings: any[], boxes: any[], floorY0: number, ceilingY: number,
 *   bounds: { x0: number, x1: number, z0: number, z1: number } }} L
 * @param {{ mesh?: PreppedMesh|null, snapshot?: any }} [opts] snapshot: the SpaceSnapshot the layout was built
 *   from (its horizontal planes give a couch's seat height)
 * @returns {StaticGeometry}
 */
export function staticFromLayout(L, opts = {}) {
  const S = STATIC;
  const mesh = opts.mesh && opts.mesh.vertices && opts.mesh.indices && opts.mesh.indices.length >= 3 ? opts.mesh : null;
  /** @type {number[]} */ const slabs = [];
  /** @type {number[]} */ const prisms = [];
  /** @type {number[]} */ const prismSurf = [];
  const slab = (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ cz, /** @type {number} */ hx, /** @type {number} */ hy,
    /** @type {number} */ hz, /** @type {number} */ c, /** @type {number} */ s, /** @type {number} */ surf, /** @type {number} */ role) => {
    if (!(hx > S.minHalf && hy > S.minHalf && hz > S.minHalf)) return;
    if (!Number.isFinite(cx + cy + cz + hx + hy + hz + c + s)) return;
    // box frame (geom.js): local x = (c, s), local z = (−s, c) in world x, z → rotation about +Y by atan2(−s, c)
    const th = Math.atan2(-s, c);
    slabs.push(cx, cy, cz, hx, hy, hz, Math.sin(th / 2), Math.cos(th / 2), surf, role);
  };
  // floors and ceilings
  for (const f of L.floors || []) addPrisms(prisms, prismSurf, f.pts, f.n, f.y, -S.floorThick, SURF.FLOOR);
  const ceilings = L.ceilings || [];
  for (const c of ceilings) addPrisms(prisms, prismSurf, c.pts, c.n, c.y, S.ceilThick, SURF.CEIL);
  const B = L.bounds || { x0: -6, x1: 6, z0: -6, z1: 6 };
  const bcx = (B.x0 + B.x1) / 2, bcz = (B.z0 + B.z1) / 2;
  const hxB = Math.max(S.catchMin, B.x1 - B.x0 + 20) / 2, hzB = Math.max(S.catchMin, B.z1 - B.z0 + 20) / 2;
  const floorY0 = Number.isFinite(L.floorY0) ? L.floorY0 : 0;
  if (!ceilings.length && Number.isFinite(L.ceilingY)) slab(bcx, L.ceilingY + S.ceilThick / 2, bcz, (B.x1 - B.x0) / 2 + 1, S.ceilThick / 2, (B.z1 - B.z0) / 2 + 1, 1, 0, SURF.CEIL, ROLE.SURFACE);
  const catchY = floorY0 - S.catchDrop;
  slab(bcx, catchY - S.catchThick / 2, bcz, hxB, S.catchThick / 2, hzB, 1, 0, SURF.FLOOR, ROLE.CATCH);
  // walls and furniture
  for (const b of L.boxes || []) {
    const h = (b.y1 - b.y0) / 2;
    if (!(h > S.minHalf)) continue;
    if (b.kind === 'wall') { slab(b.cx, (b.y0 + b.y1) / 2, b.cz, b.hx, h, b.hz, b.c, b.s, SURF.WALL, ROLE.SURFACE); continue; }
    const surf = surfOfLabel(b.label), top = TOP_RE.test(String(b.label || '').toLowerCase());
    const covered = mesh ? meshCovers(mesh, b) : false;
    if (covered) {
      const hx = b.hx - S.backInset, hz = b.hz - S.backInset;
      slab(b.cx, b.y1 - S.backInset - S.backThick / 2, b.cz, hx, S.backThick / 2, hz, b.c, b.s, surf, ROLE.BACKSTOP);
      if (surf === SURF.SOFT) slab(b.cx, (b.y0 + b.y1) / 2, b.cz, hx, h - S.backInset, hz, b.c, b.s, surf, ROLE.BACKSTOP);
      continue;
    }
    if (surf === SURF.SOFT) {
      const seat = opts.snapshot ? seatHeight(opts.snapshot, b) : NaN;
      const y1 = (seat === seat ? seat : b.y1) - S.softSink;
      slab(b.cx, (b.y0 + y1) / 2, b.cz, b.hx, (y1 - b.y0) / 2, b.hz, b.c, b.s, surf, ROLE.SURFACE);
    } else if (top && b.y1 - b.y0 > 3 * S.topSlab) {
      slab(b.cx, b.y1 - S.topSlab / 2, b.cz, b.hx, S.topSlab / 2, b.hz, b.c, b.s, surf, ROLE.SURFACE);
    } else {
      slab(b.cx, (b.y0 + b.y1) / 2, b.cz, b.hx, h, b.hz, b.c, b.s, surf, ROLE.SURFACE);
    }
  }
  // floor polygons for the lost-object test
  const fl = L.floors || [];
  let np = 0;
  for (const f of fl) np += f.n;
  const floorPts = new Float64Array(np * 2), floorOff = new Int32Array(fl.length), floorN = new Int32Array(fl.length);
  let o = 0;
  fl.forEach((f, k) => { floorOff[k] = o; floorN[k] = f.n; for (let i = 0; i < f.n * 2; i++) floorPts[o * 2 + i] = f.pts[i]; o += f.n; });
  return {
    slabs: Float32Array.from(slabs), slabCount: slabs.length / S.slabStride,
    prisms: Float32Array.from(prisms), prismCount: prisms.length / S.prismStride, prismSurf: Uint8Array.from(prismSurf),
    mesh, oneSided: mesh ? mesh.oneSided !== false : false, catchY,
    bounds: Float32Array.from([B.x0, B.z0, B.x1, B.z1]),
    floorPts, floorOff, floorN, floorCount: fl.length, source: mesh ? 'layout+mesh' : 'layout',
  };
}

/**
 * Static geometry for a built World: the world builder's own `staticGeometry()` (WorldStatics.js)
 * when it carries the processed global mesh (oriented trimesh tiles, backstops inside the covered
 * furniture), else the planes-only version from its layout (tables as their top only, a couch at
 * its seat plane, soft tops 1 cm lower: the plain volume boxes would close the space under a table
 * and put a couch's top at its backrest), with `world.physicsMesh` (a PreppedMesh) when a world
 * exposes one that way. Allocates: call it at build time, behind the "Get ready" panel or a pause.
 * @param {any} world
 * @returns {StaticGeometry|null}
 */
export function staticFromWorld(world) {
  if (!world) return null;
  if (typeof world.staticGeometry === 'function') {
    const g = world.staticGeometry();
    if (g && g.slabs && g.mesh && g.mesh.indices && g.mesh.indices.length >= 3) return g;
  }
  if (!world.layout) return null;
  return staticFromLayout(world.layout, { mesh: world.physicsMesh || null, snapshot: world.snapshot || null });
}

/**
 * The highest labelled horizontal Space Setup plane inside a furniture box, below its top (a couch's
 * seat under the volume that includes the backrest). NaN when there is none.
 * @param {any} snapshot SpaceSnapshot (planes: label, orientation, pose, polygon)
 * @param {{ cx: number, cz: number, c: number, s: number, hx: number, hz: number, y0: number, y1: number }} b
 */
export function seatHeight(snapshot, b) {
  const planes = snapshot && Array.isArray(snapshot.planes) ? snapshot.planes : null;
  if (!planes) return NaN;
  let best = NaN;
  for (const p of planes) {
    if (!p || p.orientation !== 'horizontal' || !Array.isArray(p.pose) && !(p.pose && p.pose.length === 16)) continue;
    const l = String(p.label || '').toLowerCase();
    if (!l || l === 'floor' || l === 'ceiling') continue;
    const m = p.pose, poly = p.polygon;
    if (!poly || !poly.length) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const q of poly) { sx += m[0] * q[0] + m[8] * q[1] + m[12]; sy += m[1] * q[0] + m[9] * q[1] + m[13]; sz += m[2] * q[0] + m[10] * q[1] + m[14]; }
    const n = poly.length, x = sx / n - b.cx, y = sy / n, z = sz / n - b.cz;
    if (!Number.isFinite(x + y + z)) continue;
    const lx = x * b.c + z * b.s, lz = z * b.c - x * b.s;
    if (Math.abs(lx) > b.hx + 0.1 || Math.abs(lz) > b.hz + 0.1) continue;
    if (!(y > b.y0 + 0.1 && y < b.y1 - 0.04)) continue;
    if (!(y <= best)) best = y;
  }
  return best;
}

/**
 * Is (x, z) on the mapped house: inside a floor polygon or within `pad` of one? Without
 * floor polygons: inside the bounds grown by `pad`. Allocation-free.
 * @param {StaticGeometry} g @param {number} x @param {number} z @param {number} pad
 */
export function insideHouse(g, x, z, pad) {
  const n = g.floorCount || 0;
  if (!n || !g.floorPts || !g.floorOff || !g.floorN) {
    const b = g.bounds;
    return x >= b[0] - pad && x <= b[2] + pad && z >= b[1] - pad && z <= b[3] + pad;
  }
  const P = g.floorPts, pad2 = pad * pad;
  for (let k = 0; k < n; k++) {
    const o = g.floorOff[k], m = g.floorN[k];
    let inside = false, best = Infinity;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = P[(o + i) * 2], zi = P[(o + i) * 2 + 1], xj = P[(o + j) * 2], zj = P[(o + j) * 2 + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      const ex = xj - xi, ez = zj - zi, l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? ((x - xi) * ex + (z - zi) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (xi + ex * t), dz = z - (zi + ez * t), d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    if (inside || best <= pad2) return true;
  }
  return false;
}

/**
 * Ear-clip a polygon (x, z pairs, either winding) and add one prism per triangle.
 * @param {number[]} out @param {number[]} outSurf
 * @param {ArrayLike<number>} pts @param {number} n @param {number} y
 * @param {number} thick signed: negative extrudes down (floor), positive up (ceiling)
 * @param {number} surf
 */
function addPrisms(out, outSurf, pts, n, y, thick, surf) {
  if (!(n >= 3) || !Number.isFinite(y)) return;
  const tris = earClip(pts, n);
  for (let t = 0; t < tris.length; t += 3) {
    for (const yy of [y, y + thick]) {
      for (let k = 0; k < 3; k++) { const i = tris[t + k]; out.push(pts[i * 2], yy, pts[i * 2 + 1]); }
    }
    outSurf.push(surf);
  }
}

/**
 * Ear clipping of a simple polygon (x, z pairs). Returns vertex indices, 3 per triangle.
 * @param {ArrayLike<number>} pts @param {number} n
 * @returns {number[]}
 */
export function earClip(pts, n) {
  /** @type {number[]} */ const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  const sg = area >= 0 ? 1 : -1;
  /** @type {number[]} */ const out = [];
  const X = (/** @type {number} */ i) => pts[i * 2], Z = (/** @type {number} */ i) => pts[i * 2 + 1];
  const cross = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c) => ((X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a))) * sg;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue;   // reflex or flat
      let empty = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { empty = false; break; }
      }
      if (!empty) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate leftovers (collinear runs): drop one flat vertex, or fan the rest
      let dropped = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
        if (Math.abs(cross(a, b, c)) <= 1e-12) { idx.splice(k, 1); dropped = true; break; }
      }
      if (!dropped) { for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]); return out; }
    }
  }
  if (idx.length === 3 && Math.abs(cross(idx[0], idx[1], idx[2])) > 1e-12) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * Does the mesh cover this furniture box's top (40+ upward triangles near the top, over half its area)?
 * @param {PreppedMesh} m @param {{ cx: number, cz: number, c: number, s: number, hx: number, hz: number, y1: number }} b
 */
export function meshCovers(m, b) {
  const V = m.vertices, I = m.indices;
  let n = 0, area = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3;
    const cy = (V[a + 1] + V[bb + 1] + V[c + 1]) / 3;
    if (Math.abs(cy - b.y1) > 0.08) continue;
    const ux = V[bb] - V[a], uy = V[bb + 1] - V[a + 1], uz = V[bb + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 0) || ny / l < 0.7) continue;
    const cx = (V[a] + V[bb] + V[c]) / 3 - b.cx, cz = (V[a + 2] + V[bb + 2] + V[c + 2]) / 3 - b.cz;
    const lx = cx * b.c + cz * b.s, lz = cz * b.c - cx * b.s;
    if (Math.abs(lx) > b.hx + 0.04 || Math.abs(lz) > b.hz + 0.04) continue;
    n++;
    area += l / 2;
  }
  return n >= STATIC.coverTris && area >= STATIC.coverArea * 4 * b.hx * b.hz;
}

/**
 * Chunks for a mesh that has none: 1.5 m tiles by triangle centroid and surface class. Returns a
 * reordered index buffer (each chunk's triangles contiguous) and the chunk table.
 * @param {PreppedMesh} m @param {number} [tile]
 * @returns {{ indices: Uint32Array, chunks: Int32Array }}
 */
export function chunkMesh(m, tile = 1.5) {
  const V = m.vertices, I = m.indices, nt = Math.floor(I.length / 3);
  /** @type {Map<string, number[]>} */ const groups = new Map();
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const cx = (V[a] + V[b] + V[c]) / 3, cz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
    const s = m.surf ? m.surf[t] : SURF.OTHER;
    const key = `${Math.floor(cx / tile)},${Math.floor(cz / tile)},${s}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(t);
  }
  const indices = new Uint32Array(nt * 3), chunks = new Int32Array(groups.size * 3);
  let o = 0, k = 0;
  for (const [key, g] of groups) {
    chunks[k * 3] = o; chunks[k * 3 + 1] = g.length; chunks[k * 3 + 2] = +key.split(',')[2];
    for (const t of g) { indices[o * 3] = I[t * 3]; indices[o * 3 + 1] = I[t * 3 + 1]; indices[o * 3 + 2] = I[t * 3 + 2]; o++; }
    k++;
  }
  return { indices, chunks };
}
