// @ts-check
/**
 * Build-time geometry on the horizontal x/z plane (pure; no three.js, no DOM).
 *
 * Conventions (shared by the whole world module):
 * - Polygons are flat [x0,z0, x1,z1, …] arrays. "Counter-clockwise" means a
 *   positive shoelace area with (x, z) read as (X, Y), the same sign as
 *   `polygonArea` in src/util/geom2d.js. The interior of a CCW polygon lies to
 *   the left of each edge, i.e. along (-ez, ex) for an edge direction (ex, ez).
 * - An oriented box ("OBB") is yaw-only: centre (cx, cz), unit axis 1 = (c, s),
 *   axis 2 = (-s, c), half-extents hx along axis 1 and hz along axis 2.
 *   World = centre + lx·axis1 + lz·axis2. With +Y up, (axis1, up, axis2) is a
 *   right-handed frame, which is what a rotation about Y by yaw = atan2(-s, c)
 *   gives in three.js.
 *
 * These functions run once per world build, so they may allocate.
 */

/** @typedef {{ cx: number, cz: number, c: number, s: number, hx: number, hz: number }} Rect */

/** @returns {Rect} */
export function rect() {
  return { cx: 0, cz: 0, c: 1, s: 0, hx: 0, hz: 0 };
}

/**
 * Convex hull (Andrew's monotone chain). Writes hull point indices in CCW order.
 * Collinear points are dropped.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} zs
 * @param {number} n
 * @param {Int32Array} out capacity ≥ n + 1
 * @returns {number} hull size
 */
export function convexHull(xs, zs, n, out) {
  if (n <= 2) {
    for (let i = 0; i < n; i++) out[i] = i;
    return n;
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => xs[a] - xs[b] || zs[a] - zs[b]);
  /** @param {number} o @param {number} a @param {number} b */
  const cross = (o, a, b) => (xs[a] - xs[o]) * (zs[b] - zs[o]) - (zs[a] - zs[o]) * (xs[b] - xs[o]);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = idx[i];
    while (k >= 2 && cross(out[k - 2], out[k - 1], p) <= 1e-12) k--;
    out[k++] = p;
  }
  for (let i = n - 2, lower = k + 1; i >= 0; i--) {
    const p = idx[i];
    while (k >= lower && cross(out[k - 2], out[k - 1], p) <= 1e-12) k--;
    out[k++] = p;
  }
  return Math.max(1, k - 1);
}

/**
 * Minimum-area enclosing rectangle of a convex hull (one of the rectangle's
 * sides is collinear with a hull edge, so trying every edge is exact).
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} zs
 * @param {Int32Array} hull CCW hull indices
 * @param {number} m hull size
 * @param {Rect} out
 * @returns {Rect}
 */
export function minAreaRect(xs, zs, hull, m, out) {
  if (m === 0) { out.cx = out.cz = 0; out.c = 1; out.s = 0; out.hx = out.hz = 0; return out; }
  if (m === 1) { out.cx = xs[hull[0]]; out.cz = zs[hull[0]]; out.c = 1; out.s = 0; out.hx = out.hz = 0; return out; }
  let best = Infinity;
  for (let e = 0; e < m; e++) {
    const a = hull[e], b = hull[(e + 1) % m];
    let ux = xs[b] - xs[a], uz = zs[b] - zs[a];
    const len = Math.hypot(ux, uz);
    if (len < 1e-9) continue;
    ux /= len; uz /= len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < m; i++) {
      const p = hull[i];
      const dx = xs[p] - xs[a], dz = zs[p] - zs[a];
      const u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best - 1e-12) {
      best = area;
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      out.cx = xs[a] + um * ux - vm * uz;
      out.cz = zs[a] + um * uz + vm * ux;
      out.c = ux;
      out.s = uz;
      out.hx = (u1 - u0) / 2;
      out.hz = (v1 - v0) / 2;
    }
  }
  if (best === Infinity) { out.cx = xs[hull[0]]; out.cz = zs[hull[0]]; out.c = 1; out.s = 0; out.hx = out.hz = 0; }
  return canonicalRect(out);
}

/**
 * Same rectangle, described with the long side on axis 1 and c ≥ 0, so equal
 * boxes compare equal whatever hull edge produced them.
 * @param {Rect} r
 */
export function canonicalRect(r) {
  if (r.hz > r.hx) {
    const t = r.hx; r.hx = r.hz; r.hz = t;
    const c = r.c; r.c = -r.s; r.s = c; // axis 1 := old axis 2
  }
  if (r.c < 0 || (r.c === 0 && r.s < 0)) { r.c = -r.c; r.s = -r.s; }
  return r;
}

/**
 * Oriented minimum-area rectangle around points (hull + rotating calipers).
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} zs
 * @param {number} n
 * @param {Rect} [out]
 */
export function rectFromPoints(xs, zs, n, out = rect()) {
  const hull = new Int32Array(n + 1);
  const m = convexHull(xs, zs, n, hull);
  return minAreaRect(xs, zs, hull, m, out);
}

/**
 * Four corners of a rectangle, CCW, as a flat [x,z,…] array.
 * @param {Rect} r
 * @param {number} [inflate]
 * @returns {number[]}
 */
export function rectCorners(r, inflate = 0) {
  const hx = r.hx + inflate, hz = r.hz + inflate;
  const ax = r.c * hx, az = r.s * hx; // axis 1 · hx
  const bx = -r.s * hz, bz = r.c * hz; // axis 2 · hz
  return [
    r.cx - ax - bx, r.cz - az - bz,
    r.cx + ax - bx, r.cz + az - bz,
    r.cx + ax + bx, r.cz + az + bz,
    r.cx - ax + bx, r.cz - az + bz,
  ];
}

/**
 * Area of the intersection of two convex polygons (Sutherland–Hodgman).
 * Both must be CCW.
 * @param {number[]} a flat x,z
 * @param {number[]} b flat x,z (clip polygon)
 */
export function convexOverlapArea(a, b) {
  let poly = a.slice();
  const nb = b.length / 2;
  for (let e = 0; e < nb && poly.length >= 6; e++) {
    const x1 = b[2 * e], z1 = b[2 * e + 1];
    const x2 = b[(2 * e + 2) % b.length], z2 = b[(2 * e + 3) % b.length];
    const ex = x2 - x1, ez = z2 - z1;
    /** @type {number[]} */ const next = [];
    const np = poly.length / 2;
    for (let i = 0; i < np; i++) {
      const px = poly[2 * i], pz = poly[2 * i + 1];
      const j = (i + 1) % np;
      const qx = poly[2 * j], qz = poly[2 * j + 1];
      const sp = ex * (pz - z1) - ez * (px - x1); // ≥ 0: left of the clip edge (inside)
      const sq = ex * (qz - z1) - ez * (qx - x1);
      if (sp >= 0) next.push(px, pz);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push(px + (qx - px) * t, pz + (qz - pz) * t);
      }
    }
    poly = next;
  }
  return poly.length >= 6 ? Math.abs(signedArea(poly)) : 0;
}

/**
 * Shoelace area of a flat polygon (positive = CCW).
 * @param {ArrayLike<number>} p
 * @param {number} [n] points (default p.length / 2)
 */
export function signedArea(p, n = p.length / 2) {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
  return a / 2;
}

/**
 * Squared distance from a point to a segment.
 * @param {number} px @param {number} pz
 * @param {number} ax @param {number} az
 * @param {number} bx @param {number} bz
 */
export function distSqToSegment(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const l2 = ex * ex + ez * ez;
  let t = l2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ex * t - px, dz = az + ez * t - pz;
  return dx * dx + dz * dz;
}

/**
 * Squared distance from a point to a polygon's boundary.
 * @param {ArrayLike<number>} poly
 * @param {number} n
 * @param {number} x @param {number} z
 */
export function distSqToPolygon(poly, n, x, z) {
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distSqToSegment(x, z, poly[2 * j], poly[2 * j + 1], poly[2 * i], poly[2 * i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Clean a floor polygon: drop points closer than `eps` to the previous one and
 * points collinear with their neighbours, and force CCW winding.
 * @param {number[]} flat x,z pairs
 * @param {number} [eps] metres
 * @returns {number[]}
 */
export function cleanPolygon(flat, eps = 0.01) {
  /** @type {number[]} */ let p = [];
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const x = flat[2 * i], z = flat[2 * i + 1];
    const k = p.length;
    if (k >= 2 && Math.hypot(x - p[k - 2], z - p[k - 1]) < eps) continue;
    p.push(x, z);
  }
  while (p.length >= 6 && Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]) < eps) p.length -= 2;
  // Drop collinear points (cross product of the neighbouring edges ≈ 0).
  let changed = true;
  while (changed && p.length > 6) {
    changed = false;
    const m = p.length / 2;
    for (let i = 0; i < m; i++) {
      const a = (i + m - 1) % m, b = (i + 1) % m;
      const ax = p[2 * a], az = p[2 * a + 1], x = p[2 * i], z = p[2 * i + 1], bx = p[2 * b], bz = p[2 * b + 1];
      const l1 = Math.hypot(x - ax, z - az), l2 = Math.hypot(bx - x, bz - z);
      const cr = ((x - ax) * (bz - z) - (z - az) * (bx - x)) / (l1 * l2 || 1);
      if (Math.abs(cr) < 1e-3 && (x - ax) * (bx - x) + (z - az) * (bz - z) > 0) {
        p.splice(2 * i, 2);
        changed = true;
        break;
      }
    }
  }
  if (signedArea(p) < 0) {
    /** @type {number[]} */ const r = [];
    for (let i = p.length / 2 - 1; i >= 0; i--) r.push(p[2 * i], p[2 * i + 1]);
    p = r;
  }
  return p;
}
