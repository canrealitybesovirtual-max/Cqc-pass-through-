// @ts-check
/**
 * Pure geometry helpers for the offline asset bake (no three.js, no DOM, no
 * dependencies), so they are unit-tested with `node --test`
 * (tests/unit/assets-geom.test.js).
 *
 * Conventions: matrices are column-major `number[16]` like glTF; vectors are
 * `[x, y, z]` arrays; positions are packed xyz `Float32Array`/`Float64Array`.
 */

/** @typedef {[number, number, number]} V3 */

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number[]} a * b
 */
export function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/**
 * General 4x4 inverse (cofactor expansion).
 * @param {ArrayLike<number>} m
 * @returns {number[]}
 */
export function mat4Invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) throw new Error('mat4Invert: singular matrix');
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** @param {ArrayLike<number>} m */
export function mat4Det3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/**
 * Compose translation * rotation(quat xyzw) * uniform/non-uniform scale.
 * @param {ArrayLike<number>} t @param {ArrayLike<number>} q @param {ArrayLike<number>} s
 */
export function mat4Compose(t, q, s) {
  const [x, y, z, w] = Array.from(q);
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * Decompose a matrix without shear into translation, rotation (xyzw) and scale.
 * @param {ArrayLike<number>} m
 * @returns {{ t: V3, q: [number, number, number, number], s: V3 }}
 */
export function mat4Decompose(m) {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (mat4Det3(m) < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  return { t: [m[12], m[13], m[14]], q: quatFromRot3(r), s: [sx, sy, sz] };
}

/**
 * Quaternion (xyzw) from a column-major 3x3 rotation.
 * @param {ArrayLike<number>} r
 * @returns {[number, number, number, number]}
 */
export function quatFromRot3(r) {
  const m11 = r[0], m21 = r[1], m31 = r[2], m12 = r[3], m22 = r[4], m32 = r[5], m13 = r[6], m23 = r[7], m33 = r[8];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  if (w < 0) return [-x / n, -y / n, -z / n, -w / n];
  return [x / n, y / n, z / n, w / n];
}

/**
 * Rotation (column-major 3x3) that maps the orthonormal frame `from` (three
 * column vectors) onto the frame `to`: R = To * From^T.
 * @param {[V3, V3, V3]} from @param {[V3, V3, V3]} to
 */
export function rot3FromFrames(from, to) {
  const r = new Array(9).fill(0);
  for (let c = 0; c < 3; c++) {
    for (let rr = 0; rr < 3; rr++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += to[k][rr] * from[k][c];
      r[c * 3 + rr] = s;
    }
  }
  return r;
}

/** @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z @returns {V3} */
export function xfPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z @returns {V3} */
export function xfDir(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/**
 * Inverse-transpose of the upper 3x3 (for normals), column-major 3x3.
 * @param {ArrayLike<number>} m
 */
export function normalMatrix(m) {
  const inv = mat4Invert(m);
  return [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]];
}

// --- small vector helpers -------------------------------------------------

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {V3} */
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {V3} */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {ArrayLike<number>} a @param {number} s @returns {V3} */
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b @returns {V3} */
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {ArrayLike<number>} a */
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
/** @param {ArrayLike<number>} a @returns {V3} */
export const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Round to a fixed number of decimals (stable manifests).
 * @param {ArrayLike<number>} v @param {number} [d]
 */
export function roundVec(v, d = 5) {
  const k = 10 ** d;
  return Array.from(v, (x) => Math.round(x * k) / k + 0);
}

// --- mesh topology ---------------------------------------------------------

/**
 * Representative vertex for each vertex, merging vertices whose positions are
 * equal after rounding to `eps` (UV and normal seams split vertices; this
 * joins them again for connectivity).
 * @param {ArrayLike<number>} pos packed xyz
 * @param {number} eps
 * @returns {Int32Array}
 */
export function weldByPosition(pos, eps) {
  const n = pos.length / 3;
  const rep = new Int32Array(n);
  /** @type {Map<string, number>} */
  const map = new Map();
  const k = 1 / eps;
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] * k)},${Math.round(pos[i * 3 + 1] * k)},${Math.round(pos[i * 3 + 2] * k)}`;
    const r = map.get(key);
    if (r === undefined) { map.set(key, i); rep[i] = i; } else rep[i] = r;
  }
  return rep;
}

/**
 * Connected components of a triangle list (vertices joined through `rep`).
 * @param {ArrayLike<number>} idx
 * @param {Int32Array} rep from weldByPosition
 * @returns {{ triComp: Int32Array, count: number }}
 */
export function triangleComponents(idx, rep) {
  const n = rep.length;
  const par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  /** @param {number} a */
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(rep[idx[t]]), b = find(rep[idx[t + 1]]), c = find(rep[idx[t + 2]]);
    par[b] = a; par[find(c)] = a;
  }
  const triComp = new Int32Array(idx.length / 3);
  /** @type {Map<number, number>} */
  const ids = new Map();
  for (let t = 0; t < triComp.length; t++) {
    const r = find(rep[idx[t * 3]]);
    let id = ids.get(r);
    if (id === undefined) { id = ids.size; ids.set(r, id); }
    triComp[t] = id;
  }
  return { triComp, count: ids.size };
}

/**
 * Count open (boundary) edges after position welding.
 * @param {ArrayLike<number>} idx @param {Int32Array} rep
 */
export function boundaryEdgeCount(idx, rep) {
  /** @type {Map<string, number>} */
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (let j = 0; j < 3; j++) {
      const a = rep[idx[t + j]], b = rep[idx[t + ((j + 1) % 3)]];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let n = 0;
  for (const v of edges.values()) if (v === 1) n++;
  return n;
}

/**
 * Keep only the listed triangles and drop unused vertices.
 * @param {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }} m
 * @param {(t: number) => boolean} keep
 */
export function filterTriangles(m, keep) {
  const nv = m.pos.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  /** @type {number[]} */
  const out = [];
  let count = 0;
  for (let t = 0; t < m.idx.length / 3; t++) {
    if (!keep(t)) continue;
    for (let j = 0; j < 3; j++) {
      const v = m.idx[t * 3 + j];
      if (remap[v] < 0) remap[v] = count++;
      out.push(remap[v]);
    }
  }
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    pos.set(m.pos.subarray(v * 3, v * 3 + 3), r * 3);
    nrm.set(m.nrm.subarray(v * 3, v * 3 + 3), r * 3);
    uv.set(m.uv.subarray(v * 2, v * 2 + 2), r * 2);
  }
  return { pos, nrm, uv, idx: Uint32Array.from(out) };
}

/**
 * Merge vertices that are identical in position, normal and UV (within the
 * given tolerances) so the simplifier sees shared vertices.
 * @param {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }} m
 * @param {number} [posEps] @param {number} [nrmEps] @param {number} [uvEps]
 */
export function weldExact(m, posEps = 1e-7, nrmEps = 1e-3, uvEps = 1e-5) {
  const nv = m.pos.length / 3;
  /** @type {Map<string, number>} */
  const map = new Map();
  const remap = new Int32Array(nv);
  /** @type {number[]} */
  const keepList = [];
  for (let v = 0; v < nv; v++) {
    const key = `${Math.round(m.pos[v * 3] / posEps)},${Math.round(m.pos[v * 3 + 1] / posEps)},${Math.round(m.pos[v * 3 + 2] / posEps)},` +
      `${Math.round(m.nrm[v * 3] / nrmEps)},${Math.round(m.nrm[v * 3 + 1] / nrmEps)},${Math.round(m.nrm[v * 3 + 2] / nrmEps)},` +
      `${Math.round(m.uv[v * 2] / uvEps)},${Math.round(m.uv[v * 2 + 1] / uvEps)}`;
    const r = map.get(key);
    if (r === undefined) { map.set(key, keepList.length); remap[v] = keepList.length; keepList.push(v); } else remap[v] = r;
  }
  const n = keepList.length;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  keepList.forEach((v, i) => {
    pos.set(m.pos.subarray(v * 3, v * 3 + 3), i * 3);
    nrm.set(m.nrm.subarray(v * 3, v * 3 + 3), i * 3);
    uv.set(m.uv.subarray(v * 2, v * 2 + 2), i * 2);
  });
  const idx = new Uint32Array(m.idx.length);
  /** @type {number[]} */
  const tris = [];
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = remap[m.idx[t]], b = remap[m.idx[t + 1]], c = remap[m.idx[t + 2]];
    if (a === b || b === c || a === c) continue; // collapsed by the weld
    tris.push(a, b, c);
  }
  idx.set(tris);
  return { pos, nrm, uv, idx: idx.slice(0, tris.length) };
}

// --- bounds and fitting ------------------------------------------------------

/**
 * @param {ArrayLike<number>} pos packed xyz
 * @param {ArrayLike<number>} [verts] optional vertex subset
 * @returns {{ min: V3, max: V3 }}
 */
export function bounds(pos, verts) {
  const min = /** @type {V3} */ ([Infinity, Infinity, Infinity]);
  const max = /** @type {V3} */ ([-Infinity, -Infinity, -Infinity]);
  const n = verts ? verts.length : pos.length / 3;
  for (let i = 0; i < n; i++) {
    const v = verts ? verts[i] : i;
    for (let k = 0; k < 3; k++) {
      const x = pos[v * 3 + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return { min, max };
}

/**
 * Least-squares 3D line through points (centroid + principal axis).
 * @param {ArrayLike<number>} pts packed xyz (at least 2 points)
 * @returns {{ point: V3, dir: V3 }}
 */
export function fitLine(pts) {
  const n = pts.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3] - cx, y = pts[i * 3 + 1] - cy, z = pts[i * 3 + 2] - cz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  // power iteration on the covariance matrix
  let d = /** @type {V3} */ ([xx >= yy && xx >= zz ? 1 : 0, yy > xx && yy >= zz ? 1 : 0, zz > xx && zz > yy ? 1 : 0]);
  for (let it = 0; it < 64; it++) {
    d = normalize([xx * d[0] + xy * d[1] + xz * d[2], xy * d[0] + yy * d[1] + yz * d[2], xz * d[0] + yz * d[1] + zz * d[2]]);
  }
  return { point: [cx, cy, cz], dir: d };
}

/**
 * Algebraic (Kasa) circle fit in 2D.
 * @param {ArrayLike<number>} xs @param {ArrayLike<number>} ys
 * @returns {{ cx: number, cy: number, r: number }}
 */
export function fitCircle(xs, ys) {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx, v = ys[i] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const det = suu * svv - suv * suv;
  const uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/**
 * Evenly spread unit directions on the sphere (Fibonacci lattice).
 * @param {number} n
 * @returns {V3[]}
 */
export function sphereDirections(n) {
  /** @type {V3[]} */
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = i * ga;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

/**
 * Directions in a cone around an axis (rings at the given half-angles).
 * @param {V3} axis @param {number[]} angles radians @param {number} perRing
 * @returns {V3[]}
 */
export function coneDirections(axis, angles, perRing) {
  const a = normalize(axis);
  const t = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
  const b = cross(a, t);
  /** @type {V3[]} */
  const out = [a];
  for (const ang of angles) {
    for (let i = 0; i < perRing; i++) {
      const phi = (i / perRing) * Math.PI * 2;
      const s = Math.sin(ang);
      out.push(normalize(add(scale(a, Math.cos(ang)), add(scale(t, s * Math.cos(phi)), scale(b, s * Math.sin(phi))))));
    }
  }
  return out;
}

/**
 * Möller–Trumbore ray/triangle test. Returns the distance along the ray or -1.
 * @param {ArrayLike<number>} o @param {ArrayLike<number>} d
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {ArrayLike<number>} c
 */
export function rayTriangle(o, d, a, b, c) {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return -1;
  const inv = 1 / det;
  const tx = o[0] - a[0], ty = o[1] - a[1], tz = o[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : -1;
}
