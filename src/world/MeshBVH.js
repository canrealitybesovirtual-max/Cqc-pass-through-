// @ts-check
/**
 * Bounding-volume hierarchy over a triangle mesh in flat typed arrays (pure:
 * no three.js, no DOM). Built in the world worker; the main thread wraps the
 * transferred buffers (`fromBuffers`, no copy) and answers ray and segment
 * queries allocation-free (2–3 µs per long ray on desktop for a 27k-triangle
 * house, the research bench; Rapier's ray took 5.4 µs and allocated).
 *
 * Storage (node i; the root is 0):
 * - `box[6i…6i+5]`: min x, y, z, max x, y, z (Float32);
 * - `node[2i]`: leaf → first triangle; inner → right child index;
 *   `node[2i+1]`: leaf → triangle count (> 0); inner → 0x80000000 | left child << 2 | split axis.
 * Triangles are stored in leaf order as a soup (`tri`: 9 floats each, no index
 * indirection) with a per-triangle class (`surf`, MeshPrep SURF) and furniture
 * owner (`owner`, −1 none). Leaves hold ≤ 4 triangles; splits are binned SAH
 * (12 bins) on the centroids.
 *
 * Queries hit both faces (bullets and sight lines do not care about winding),
 * return the geometric normal facing the ray origin, and leave the hit's
 * triangle (leaf order) in `lastTri`.
 */

const LEAF_MAX = 4;
const BINS = 12;
const INNER = 0x80000000;
const STACK = 96;
const EPS = 1e-9;

export class MeshBVH {
  constructor() {
    this.nodeCount = 0;
    this.triCount = 0;
    /** @type {Float32Array} */ this.box = new Float32Array(0);
    /** @type {Uint32Array} */ this.node = new Uint32Array(0);
    /** @type {Float32Array} */ this.tri = new Float32Array(0);
    /** @type {Uint8Array} */ this.surf = new Uint8Array(0);
    /** @type {Int16Array} */ this.owner = new Int16Array(0);
    /** Traversal stack (fixed: no allocation per query). */
    this.stack = new Int32Array(STACK);
    /** The last hit's triangle (leaf order), −1 after a miss. */
    this.lastTri = -1;
    /** Scratch for the hit distance (a double kept in a typed array is never boxed). */
    this._t = new Float64Array(1);
    /** The ray handed to trace(): ox, oy, oz, dx, dy, dz, max (doubles passed to a call that is not inlined are boxed). */
    this._ray = new Float64Array(7);
    this.depth = 0;
  }

  /**
   * Build from an indexed mesh (worker or build time; allocates).
   * @param {Float32Array} vertices x,y,z
   * @param {Uint32Array} indices 3 per triangle
   * @param {Uint8Array|null} [surf] per triangle
   * @param {Int16Array|null} [owner] per triangle
   * @returns {this}
   */
  build(vertices, indices, surf = null, owner = null) {
    const n = Math.floor(indices.length / 3);
    this.triCount = n;
    const cen = new Float32Array(n * 3), tb = new Float32Array(n * 6);
    for (let t = 0; t < n; t++) {
      const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        const va = vertices[a + k], vb = vertices[b + k], vc = vertices[c + k];
        const lo = va < vb ? (va < vc ? va : vc) : (vb < vc ? vb : vc);
        const hi = va > vb ? (va > vc ? va : vc) : (vb > vc ? vb : vc);
        tb[6 * t + k] = lo;
        tb[6 * t + 3 + k] = hi;
        cen[3 * t + k] = (va + vb + vc) / 3;
      }
    }
    const order = new Uint32Array(n);
    for (let t = 0; t < n; t++) order[t] = t;
    const maxNodes = Math.max(1, 2 * n);
    const box = new Float32Array(maxNodes * 6), node = new Uint32Array(maxNodes * 2);
    // iterative build: stack of (node, start, end)
    const st = new Int32Array(256 * 3);
    let sp = 0, count = 1, maxDepth = 0;
    const depthOf = new Uint16Array(maxNodes);
    st[0] = 0; st[1] = 0; st[2] = n; sp = 1;
    const binCnt = new Int32Array(BINS), binBox = new Float32Array(BINS * 6);
    const rightArea = new Float64Array(BINS), rightCnt = new Int32Array(BINS);
    while (sp > 0) {
      sp--;
      const ni = st[3 * sp], s = st[3 * sp + 1], e = st[3 * sp + 2];
      // node bounds and centroid bounds
      let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let k = s; k < e; k++) {
        const t = order[k], o = 6 * t;
        if (tb[o] < bx0) bx0 = tb[o];
        if (tb[o + 1] < by0) by0 = tb[o + 1];
        if (tb[o + 2] < bz0) bz0 = tb[o + 2];
        if (tb[o + 3] > bx1) bx1 = tb[o + 3];
        if (tb[o + 4] > by1) by1 = tb[o + 4];
        if (tb[o + 5] > bz1) bz1 = tb[o + 5];
        const x = cen[3 * t], y = cen[3 * t + 1], z = cen[3 * t + 2];
        if (x < cx0) cx0 = x;
        if (x > cx1) cx1 = x;
        if (y < cy0) cy0 = y;
        if (y > cy1) cy1 = y;
        if (z < cz0) cz0 = z;
        if (z > cz1) cz1 = z;
      }
      const bo = 6 * ni;
      box[bo] = bx0; box[bo + 1] = by0; box[bo + 2] = bz0; box[bo + 3] = bx1; box[bo + 4] = by1; box[bo + 5] = bz1;
      const cnt = e - s;
      const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
      let axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const ext = axis === 0 ? ex : axis === 1 ? ey : ez;
      if (cnt <= LEAF_MAX || ext < 1e-7) {
        node[2 * ni] = s;
        node[2 * ni + 1] = cnt;
        continue;
      }
      // binned SAH along the longest centroid axis
      const lo = axis === 0 ? cx0 : axis === 1 ? cy0 : cz0;
      const scale = BINS / ext;
      binCnt.fill(0);
      for (let b = 0; b < BINS; b++) {
        binBox[6 * b] = binBox[6 * b + 1] = binBox[6 * b + 2] = Infinity;
        binBox[6 * b + 3] = binBox[6 * b + 4] = binBox[6 * b + 5] = -Infinity;
      }
      for (let k = s; k < e; k++) {
        const t = order[k];
        let b = Math.floor((cen[3 * t + axis] - lo) * scale);
        if (b >= BINS) b = BINS - 1;
        if (b < 0) b = 0;
        binCnt[b]++;
        const o = 6 * t, q = 6 * b;
        for (let j = 0; j < 3; j++) {
          if (tb[o + j] < binBox[q + j]) binBox[q + j] = tb[o + j];
          if (tb[o + 3 + j] > binBox[q + 3 + j]) binBox[q + 3 + j] = tb[o + 3 + j];
        }
      }
      // sweep from the right
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const q = 6 * b;
        if (binCnt[b]) {
          if (binBox[q] < rx0) rx0 = binBox[q];
          if (binBox[q + 1] < ry0) ry0 = binBox[q + 1];
          if (binBox[q + 2] < rz0) rz0 = binBox[q + 2];
          if (binBox[q + 3] > rx1) rx1 = binBox[q + 3];
          if (binBox[q + 4] > ry1) ry1 = binBox[q + 4];
          if (binBox[q + 5] > rz1) rz1 = binBox[q + 5];
        }
        rc += binCnt[b];
        rightCnt[b] = rc;
        rightArea[b] = rc ? area(rx1 - rx0, ry1 - ry0, rz1 - rz0) : 0;
      }
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
      let bestCost = Infinity, bestSplit = -1;
      for (let b = 0; b < BINS - 1; b++) {
        const q = 6 * b;
        if (binCnt[b]) {
          if (binBox[q] < lx0) lx0 = binBox[q];
          if (binBox[q + 1] < ly0) ly0 = binBox[q + 1];
          if (binBox[q + 2] < lz0) lz0 = binBox[q + 2];
          if (binBox[q + 3] > lx1) lx1 = binBox[q + 3];
          if (binBox[q + 4] > ly1) ly1 = binBox[q + 4];
          if (binBox[q + 5] > lz1) lz1 = binBox[q + 5];
        }
        lc += binCnt[b];
        if (lc === 0 || rightCnt[b + 1] === 0) continue;
        const cost = lc * area(lx1 - lx0, ly1 - ly0, lz1 - lz0) + rightCnt[b + 1] * rightArea[b + 1];
        if (cost < bestCost) { bestCost = cost; bestSplit = b; }
      }
      let mid;
      if (bestSplit < 0) {
        mid = (s + e) >> 1; // every centroid in one bin: split the list
      } else {
        // partition: centroid bin ≤ bestSplit to the left
        let i = s, j = e - 1;
        while (i <= j) {
          const t = order[i];
          let b = Math.floor((cen[3 * t + axis] - lo) * scale);
          if (b >= BINS) b = BINS - 1;
          if (b <= bestSplit) i++;
          else { order[i] = order[j]; order[j] = t; j--; }
        }
        mid = i;
        if (mid === s || mid === e) mid = (s + e) >> 1;
      }
      const left = count++, right = count++;
      node[2 * ni] = right;
      node[2 * ni + 1] = INNER | axis | (left << 2);
      const d = depthOf[ni] + 1;
      depthOf[left] = d; depthOf[right] = d;
      if (d > maxDepth) maxDepth = d;
      if (sp + 2 > 256) throw new Error('MeshBVH: build stack overflow');
      st[3 * sp] = right; st[3 * sp + 1] = mid; st[3 * sp + 2] = e; sp++;
      st[3 * sp] = left; st[3 * sp + 1] = s; st[3 * sp + 2] = mid; sp++;
    }
    this.depth = maxDepth;
    if (maxDepth + 2 > STACK) throw new Error(`MeshBVH: depth ${maxDepth} exceeds the query stack`);
    this.nodeCount = count;
    this.box = box.slice(0, count * 6);
    this.node = node.slice(0, count * 2);
    // triangle soup in leaf order
    const T = new Float32Array(n * 9), S = new Uint8Array(n), O = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      const t = order[k];
      for (let v = 0; v < 3; v++) {
        const src = indices[3 * t + v] * 3, dst = 9 * k + 3 * v;
        T[dst] = vertices[src]; T[dst + 1] = vertices[src + 1]; T[dst + 2] = vertices[src + 2];
      }
      S[k] = surf ? surf[t] : 0;
      O[k] = owner ? owner[t] : -1;
    }
    this.tri = T;
    this.surf = S;
    this.owner = O;
    return this;
  }

  /** The buffers to transfer (exact sizes). */
  toBuffers() {
    return { nodeCount: this.nodeCount, triCount: this.triCount, depth: this.depth, box: this.box, node: this.node, tri: this.tri, surf: this.surf, owner: this.owner };
  }

  /**
   * Wrap transferred buffers (no copy).
   * @param {{ nodeCount: number, triCount: number, depth?: number, box: Float32Array, node: Uint32Array, tri: Float32Array, surf: Uint8Array, owner: Int16Array }} b
   */
  static fromBuffers(b) {
    const m = new MeshBVH();
    m.nodeCount = b.nodeCount;
    m.triCount = b.triCount;
    m.depth = b.depth || 0;
    m.box = b.box;
    m.node = b.node;
    m.tri = b.tri;
    m.surf = b.surf;
    m.owner = b.owner;
    return m;
  }

  /** Bytes held. */
  bytes() {
    return this.box.byteLength + this.node.byteLength + this.tri.byteLength + this.surf.byteLength + this.owner.byteLength;
  }

  /**
   * Nearest hit along a ray within `max` m (both faces). Writes `out` only on
   * a hit (dist, x, y, z, nx, ny, nz facing the origin); the triangle is left
   * in `lastTri` (its class in `surf[lastTri]`, owner in `owner[lastTri]`).
   * Allocation-free.
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz direction (normalised here)
   * @param {number} max
   * @param {any} out
   * @returns {boolean}
   */
  raycast(ox, oy, oz, dx, dy, dz, max, out) {
    this.lastTri = -1;
    if (this.triCount === 0) return false;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-12) || !(max > 0)) return false;
    dx /= len; dy /= len; dz /= len;
    const R = this._ray;
    R[0] = ox; R[1] = oy; R[2] = oz; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = max;
    const best = this.trace(false);
    if (best < 0) return false;
    const t = this._t[0], T = this.tri, o = 9 * best;
    const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
    const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    out.dist = t;
    out.x = ox + dx * t;
    out.y = oy + dy * t;
    out.z = oz + dz * t;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.kind = 'world';
    out.enemy = -1;
    out.part = '';
    this.lastTri = best;
    return true;
  }

  /**
   * True when no triangle touches the open segment a→b (endpoints within
   * 1 mm are not counted). Allocation-free.
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} bx @param {number} by @param {number} bz
   */
  segmentClear(ax, ay, az, bx, by, bz) {
    if (this.triCount === 0) return true;
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 2e-3)) return true;
    dx /= len; dy /= len; dz /= len;
    const R = this._ray;
    R[0] = ax + dx * 1e-3; R[1] = ay + dy * 1e-3; R[2] = az + dz * 1e-3; R[3] = dx; R[4] = dy; R[5] = dz; R[6] = len - 2e-3;
    return this.trace(true) < 0;
  }

  /**
   * The traversal: nearest hit (or any hit with `any`) along the unit ray in
   * `_ray` (origin, direction, max).
   * @param {boolean} any
   * @returns {number} triangle (leaf order) or −1; the distance in this._t[0]
   */
  trace(any) {
    const B = this.box, N = this.node, T = this.tri, S = this.stack, R = this._ray;
    const ox = R[0], oy = R[1], oz = R[2], dx = R[3], dy = R[4], dz = R[5], max = R[6];
    const ix = 1 / (Math.abs(dx) > EPS ? dx : dx >= 0 ? EPS : -EPS);
    const iy = 1 / (Math.abs(dy) > EPS ? dy : dy >= 0 ? EPS : -EPS);
    const iz = 1 / (Math.abs(dz) > EPS ? dz : dz >= 0 ? EPS : -EPS);
    let best = max, bestTri = -1, sp = 0;
    S[sp++] = 0;
    while (sp > 0) {
      const ni = S[--sp];
      const o = 6 * ni;
      // slab test
      let t0 = (B[o] - ox) * ix, t1 = (B[o + 3] - ox) * ix;
      let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
      t0 = (B[o + 1] - oy) * iy; t1 = (B[o + 4] - oy) * iy;
      let a = t0 < t1 ? t0 : t1, b = t0 < t1 ? t1 : t0;
      if (a > tn) tn = a;
      if (b < tf) tf = b;
      t0 = (B[o + 2] - oz) * iz; t1 = (B[o + 5] - oz) * iz;
      a = t0 < t1 ? t0 : t1; b = t0 < t1 ? t1 : t0;
      if (a > tn) tn = a;
      if (b < tf) tf = b;
      if (tn > tf || tf < 0 || tn > best) continue;
      const d1 = N[2 * ni + 1];
      if (d1 & INNER) {
        const axis = d1 & 3, left = (d1 & 0x7fffffff) >>> 2, right = N[2 * ni];
        // near child last on the stack (popped first)
        const neg = axis === 0 ? dx < 0 : axis === 1 ? dy < 0 : dz < 0;
        if (neg) { S[sp++] = left; S[sp++] = right; }
        else { S[sp++] = right; S[sp++] = left; }
        continue;
      }
      const first = N[2 * ni], end = first + d1;
      for (let k = first; k < end; k++) {
        const q = 9 * k;
        const vx = T[q], vy = T[q + 1], vz = T[q + 2];
        const e1x = T[q + 3] - vx, e1y = T[q + 4] - vy, e1z = T[q + 5] - vz;
        const e2x = T[q + 6] - vx, e2y = T[q + 7] - vy, e2z = T[q + 8] - vz;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - vx, sy = oy - vy, sz = oz - vz;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 0 && t < best) {
          best = t;
          bestTri = k;
          if (any) { this._t[0] = t; return k; }
        }
      }
    }
    this._t[0] = best;
    return bestTri;
  }
}

/** Half surface area of a box (SAH weight). @param {number} x @param {number} y @param {number} z */
function area(x, y, z) {
  return x * y + y * z + z * x;
}
