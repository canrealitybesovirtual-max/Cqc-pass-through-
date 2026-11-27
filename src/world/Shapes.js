// @ts-check
/**
 * Analytic collision shapes for bullets and line of sight (pure, allocation-free
 * queries): yaw-oriented boxes (wall pieces and furniture) in one Float32Array,
 * floor polygons, ceiling polygons, and fallback floor/ceiling planes so a ray
 * that leaves the mapped area (through a doorway into an unmapped hallway)
 * still hits the real floor or ceiling.
 *
 * Box record (8 floats): cx, cz, c, s, hx, hz, y0, y1 — see geom.js for the frame.
 * `flags[i]` (Uint8) per box: SHAPE_JAMB (a wall piece beside a door opening),
 * SHAPE_WALL, SHAPE_INFERRED (an inferred wall: no wall plane there),
 * SHAPE_LINTEL (above a door). The safety code uses them for walking cues.
 */

import { pointInPolygon } from '../util/geom2d.js';

const BOX_STRIDE = 8;

/** Box flags (`ShapeSet.flags`). */
export const SHAPE_JAMB = 1;
export const SHAPE_WALL = 2;
export const SHAPE_INFERRED = 4;
export const SHAPE_LINTEL = 8;

/** @typedef {{ pts: Float64Array, n: number, y: number, x0: number, x1: number, z0: number, z1: number }} FlatPoly */

// Slab-test result scratch (module level: no allocation per query). The entry
// distance goes through a typed array: a double returned from a call that is
// not inlined is boxed (a heap number per hit).
let hitAxis = 0;
let hitSign = 0;
const ENTRY = new Float64Array(1);

/**
 * Entry of a ray into box `o` (offset into `b`); the distance is left in ENTRY[0].
 * @param {Float32Array} b
 * @param {number} o
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} tmax
 * @returns {number} 1 on entry (t ≥ 0 in ENTRY[0]), -1 for a miss, -2 when the origin is inside
 */
function boxEntry(b, o, ox, oy, oz, dx, dy, dz, tmax) {
  const c = b[o + 2], s = b[o + 3], hx = b[o + 4], hz = b[o + 5];
  const rx = ox - b[o], rz = oz - b[o + 1];
  const lx = rx * c + rz * s, lz = rz * c - rx * s;
  const ldx = dx * c + dz * s, ldz = dz * c - dx * s;
  let tn = -Infinity, tf = tmax, axis = -1, sign = 0;

  if (ldx > -1e-12 && ldx < 1e-12) {
    if (lx < -hx || lx > hx) return -1;
  } else {
    let t1 = (-hx - lx) / ldx, t2 = (hx - lx) / ldx, sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tn) { tn = t1; axis = 0; sign = sg; }
    if (t2 < tf) tf = t2;
    if (tn > tf) return -1;
  }
  const y0 = b[o + 6], y1 = b[o + 7];
  if (dy > -1e-12 && dy < 1e-12) {
    if (oy < y0 || oy > y1) return -1;
  } else {
    let t1 = (y0 - oy) / dy, t2 = (y1 - oy) / dy, sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tn) { tn = t1; axis = 1; sign = sg; }
    if (t2 < tf) tf = t2;
    if (tn > tf) return -1;
  }
  if (ldz > -1e-12 && ldz < 1e-12) {
    if (lz < -hz || lz > hz) return -1;
  } else {
    let t1 = (-hz - lz) / ldz, t2 = (hz - lz) / ldz, sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tn) { tn = t1; axis = 2; sign = sg; }
    if (t2 < tf) tf = t2;
    if (tn > tf) return -1;
  }
  if (tf < 0) return -1;
  if (tn < 0) return -2;
  hitAxis = axis;
  hitSign = sign;
  ENTRY[0] = tn;
  return 1;
}

/**
 * @param {FlatPoly[]} polys
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz
 * @param {number} best
 * @returns {number} 1 when a polygon is hit closer than `best` (its t in ENTRY[0]), else 0
 */
function polyHit(polys, ox, oy, oz, dx, dy, dz, best) {
  let t = Infinity;
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    const ti = (p.y - oy) / dy;
    if (!(ti > 0) || ti >= best || ti >= t) continue;
    const x = ox + dx * ti, z = oz + dz * ti;
    if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
    if (pointInPolygon(p.pts, p.n, x, z)) t = ti;
  }
  if (t === Infinity) return 0;
  ENTRY[0] = t;
  return 1;
}

export class ShapeSet {
  /** @param {number} [maxBoxes] */
  constructor(maxBoxes = 160) {
    this.maxBoxes = maxBoxes;
    this.box = new Float32Array(maxBoxes * BOX_STRIDE);
    /** SHAPE_* bits per box. */
    this.flags = new Uint8Array(maxBoxes);
    /** @type {string[]} surface label per box */
    this.label = new Array(maxBoxes).fill('');
    this.count = 0;
    /** @type {FlatPoly[]} */ this.floors = [];
    /** @type {FlatPoly[]} */ this.ceilings = [];
    /** Fallback planes: the main floor everywhere; the ceiling (NaN = open sky, virtual room). */
    this.floorY0 = 0;
    this.ceilingY = NaN;
    this.dropped = 0;
  }

  /**
   * @param {import('./Layout.js').Layout} layout
   * @param {number} [px] player x: if there are too many boxes, the farthest furniture is dropped
   * @param {number} [pz]
   */
  setFromLayout(layout, px = 0, pz = 0) {
    let boxes = layout.boxes;
    this.dropped = 0;
    if (boxes.length > this.maxBoxes) {
      const walls = boxes.filter((b) => b.kind === 'wall');
      const furn = boxes.filter((b) => b.kind !== 'wall')
        .sort((a, b) => Math.hypot(a.cx - px, a.cz - pz) - Math.hypot(b.cx - px, b.cz - pz));
      boxes = walls.concat(furn).slice(0, this.maxBoxes);
      this.dropped = layout.boxes.length - boxes.length;
    }
    const B = this.box;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i], o = i * BOX_STRIDE;
      B[o] = b.cx; B[o + 1] = b.cz; B[o + 2] = b.c; B[o + 3] = b.s;
      B[o + 4] = b.hx; B[o + 5] = b.hz; B[o + 6] = b.y0; B[o + 7] = b.y1;
      this.label[i] = b.label;
      this.flags[i] = (b.kind === 'wall' ? SHAPE_WALL : 0) | (b.jamb0 || b.jamb1 ? SHAPE_JAMB : 0)
        | (b.source === 'inferred' ? SHAPE_INFERRED : 0) | (b.lintel ? SHAPE_LINTEL : 0);
    }
    this.count = boxes.length;
    this.floors = layout.floors.map((f) => ({ pts: f.pts, n: f.n, y: f.y, x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1 }));
    this.ceilings = layout.ceilings.slice();
    this.floorY0 = layout.floorY0;
    this.ceilingY = layout.ceilingY;
  }

  /**
   * Nearest hit along a ray within `max` metres. Writes `out` only on a hit.
   * Boxes that contain the origin are ignored (a mapping error must not
   * swallow the shot at the muzzle).
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz direction (normalised here)
   * @param {number} max
   * @param {any} out Hit
   * @returns {boolean}
   */
  raycast(ox, oy, oz, dx, dy, dz, max, out) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9) || !(max > 0)) return false;
    dx /= len; dy /= len; dz /= len;
    let best = max, bi = -1, axis = 0, sign = 0;
    const B = this.box;
    for (let i = 0, o = 0; i < this.count; i++, o += BOX_STRIDE) {
      if (boxEntry(B, o, ox, oy, oz, dx, dy, dz, best) === 1 && ENTRY[0] < best) { best = ENTRY[0]; bi = i; axis = hitAxis; sign = hitSign; }
    }
    /** -1 box, 1 floor, 2 ceiling */
    let kind = bi >= 0 ? -1 : 0;
    if (dy < -1e-9) {
      let t = polyHit(this.floors, ox, oy, oz, dx, dy, dz, best) === 1 ? ENTRY[0] : Infinity;
      if (t === Infinity) { const tf = (this.floorY0 - oy) / dy; if (tf > 0 && tf < best) t = tf; }
      if (t < best) { best = t; kind = 1; }
    } else if (dy > 1e-9) {
      let t = polyHit(this.ceilings, ox, oy, oz, dx, dy, dz, best) === 1 ? ENTRY[0] : Infinity;
      if (t === Infinity && this.ceilingY === this.ceilingY) { const tc = (this.ceilingY - oy) / dy; if (tc > 0 && tc < best) t = tc; }
      if (t < best) { best = t; kind = 2; }
    }
    if (kind === 0) return false;
    out.dist = best;
    out.x = ox + dx * best;
    out.y = oy + dy * best;
    out.z = oz + dz * best;
    out.kind = 'world';
    out.enemy = -1;
    out.part = '';
    if (kind === 1) { out.nx = 0; out.ny = 1; out.nz = 0; out.surface = 'floor'; return true; }
    if (kind === 2) { out.nx = 0; out.ny = -1; out.nz = 0; out.surface = 'ceiling'; return true; }
    const o = bi * BOX_STRIDE, c = B[o + 2], s = B[o + 3];
    if (axis === 0) { out.nx = c * sign; out.ny = 0; out.nz = s * sign; }
    else if (axis === 1) { out.nx = 0; out.ny = sign; out.nz = 0; }
    else { out.nx = -s * sign; out.ny = 0; out.nz = c * sign; }
    out.surface = this.label[bi];
    return true;
  }

  /**
   * Line of sight: true when no box (wall piece, lintel, furniture) touches the
   * segment a→b. Symmetric; an endpoint inside a box counts as blocked.
   * Floor and ceiling are not tested.
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} bx @param {number} by @param {number} bz
   */
  segmentClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const B = this.box;
    for (let i = 0, o = 0; i < this.count; i++, o += BOX_STRIDE) {
      if (boxEntry(B, o, ax, ay, az, dx, dy, dz, 1) !== -1) return false;
    }
    return true;
  }

  /**
   * Is the point inside any box (inflated by `pad`)?
   * @param {number} x @param {number} y @param {number} z
   * @param {number} [pad]
   */
  pointInside(x, y, z, pad = 0) {
    const B = this.box;
    for (let i = 0, o = 0; i < this.count; i++, o += BOX_STRIDE) {
      if (y < B[o + 6] - pad || y > B[o + 7] + pad) continue;
      const rx = x - B[o], rz = z - B[o + 1], c = B[o + 2], s = B[o + 3];
      const lx = rx * c + rz * s, lz = rz * c - rx * s;
      if (lx >= -B[o + 4] - pad && lx <= B[o + 4] + pad && lz >= -B[o + 5] - pad && lz <= B[o + 5] + pad) return true;
    }
    return false;
  }
}
