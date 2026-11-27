// @ts-check
/**
 * Visibility by software rasterisation (pure, no dependencies).
 *
 * Each configuration of a model (for example: at rest, slide back, magazine
 * out) is drawn orthographically from many directions into a depth + triangle
 * id buffer. A triangle that never wins a pixel in any view of any
 * configuration cannot be seen from outside the model: it is a hidden
 * internal (springs, pins, the far side of a liner). Seen from an external
 * point, every ray continues to infinity outside the convex hull, so
 * orthographic views from all directions cover every perspective view from
 * outside the model.
 *
 * Counts per triangle: [2t] = pixels won seen from the front, [2t + 1] = seen
 * from the back (only possible for meshes drawn without culling).
 */
import { cross, dot, normalize } from './geom.mjs';

/** @typedef {[number, number, number]} V3 */
/** @typedef {{ pos: Float32Array, idx: Uint32Array, offset?: V3, cull?: boolean }} RasterMesh */

/**
 * @param {RasterMesh[]} meshes one configuration (all drawn together)
 * @param {V3[]} dirs view directions (the direction the viewer looks along)
 * @param {number} res pixels across the bounding-sphere diameter
 * @param {Uint32Array[]} counts per mesh, length 2 * triangles; accumulated in place
 */
export function markVisible(meshes, dirs, res, counts) {
  // bounding sphere (box centre, max distance)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const o = m.offset || [0, 0, 0];
    for (let i = 0; i < m.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const x = m.pos[i + k] + o[k];
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let r2 = 0;
  for (const m of meshes) {
    const o = m.offset || [0, 0, 0];
    for (let i = 0; i < m.pos.length; i += 3) {
      const dx = m.pos[i] + o[0] - c[0], dy = m.pos[i + 1] + o[1] - c[1], dz = m.pos[i + 2] + o[2] - c[2];
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
  }
  const R = Math.sqrt(r2) * 1.01 + 1e-9;
  const pix = (2 * R) / res;

  let totalV = 0, totalT = 0;
  for (const m of meshes) { totalV += m.pos.length / 3; totalT += m.idx.length / 3; }
  const sx = new Float32Array(totalV), sy = new Float32Array(totalV), sz = new Float32Array(totalV);
  const depth = new Float32Array(res * res);
  const ids = new Int32Array(res * res);
  const triMesh = new Int32Array(totalT), triLocal = new Int32Array(totalT);
  {
    let t0 = 0;
    meshes.forEach((m, mi) => { for (let t = 0; t < m.idx.length / 3; t++) { triMesh[t0 + t] = mi; triLocal[t0 + t] = t; } t0 += m.idx.length / 3; });
  }

  for (const w0 of dirs) {
    const w = normalize(w0);
    const u = normalize(Math.abs(w[1]) < 0.95 ? cross(w, [0, 1, 0]) : cross(w, [1, 0, 0]));
    const v = cross(w, u); // u x v = w
    let vi = 0;
    for (const m of meshes) {
      const o = m.offset || [0, 0, 0];
      for (let i = 0; i < m.pos.length; i += 3, vi++) {
        const p = [m.pos[i] + o[0] - c[0], m.pos[i + 1] + o[1] - c[1], m.pos[i + 2] + o[2] - c[2]];
        sx[vi] = dot(p, u) / pix + res / 2;
        sy[vi] = dot(p, v) / pix + res / 2;
        sz[vi] = dot(p, w);
      }
    }
    depth.fill(Infinity);
    ids.fill(-1);
    let vBase = 0, tBase = 0;
    for (const m of meshes) {
      const idx = m.idx;
      for (let t = 0; t < idx.length; t += 3) {
        const a = vBase + idx[t], b = vBase + idx[t + 1], cc = vBase + idx[t + 2];
        const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[cc], y2 = sy[cc];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0) continue;
        const back = area > 0; // normal . w > 0: facing away from the viewer
        if (back && m.cull) continue;
        const id = ((tBase + t / 3) << 1) | (back ? 1 : 0);
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(res - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(res - 1, Math.ceil(Math.max(y0, y1, y2)));
        const inv = 1 / area;
        const z0 = sz[a], z1 = sz[b], z2 = sz[cc];
        for (let py = minY; py <= maxY; py++) {
          const fy = py + 0.5;
          for (let px = minX; px <= maxX; px++) {
            const fx = px + 0.5;
            const w0b = ((x1 - fx) * (y2 - fy) - (x2 - fx) * (y1 - fy)) * inv;
            const w1b = ((x2 - fx) * (y0 - fy) - (x0 - fx) * (y2 - fy)) * inv;
            const w2b = 1 - w0b - w1b;
            if (w0b < 0 || w1b < 0 || w2b < 0) continue;
            const z = w0b * z0 + w1b * z1 + w2b * z2;
            const k = py * res + px;
            if (z < depth[k]) { depth[k] = z; ids[k] = id; }
          }
        }
      }
      vBase += m.pos.length / 3;
      tBase += idx.length / 3;
    }
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (id < 0) continue;
      const g = id >> 1;
      counts[triMesh[g]][triLocal[g] * 2 + (id & 1)]++;
    }
  }
}

/**
 * Grow the visible set by one ring: a triangle is kept when it, or any
 * triangle sharing a (welded) vertex with it, was seen. Protects slivers that
 * are smaller than a pixel in every view from being cut into pinholes.
 * @param {Uint32Array} idx
 * @param {Int32Array} rep welded vertex representative
 * @param {Uint32Array} counts from markVisible (2 per triangle)
 * @returns {Uint8Array} keep (1 = keep)
 */
export function dilateVisible(idx, rep, counts) {
  const nt = idx.length / 3;
  const vertSeen = new Uint8Array(rep.length);
  for (let t = 0; t < nt; t++) {
    if (!counts[t * 2] && !counts[t * 2 + 1]) continue;
    for (let j = 0; j < 3; j++) vertSeen[rep[idx[t * 3 + j]]] = 1;
  }
  const keep = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    keep[t] = counts[t * 2] || counts[t * 2 + 1] || vertSeen[rep[idx[t * 3]]] || vertSeen[rep[idx[t * 3 + 1]]] || vertSeen[rep[idx[t * 3 + 2]]] ? 1 : 0;
  }
  return keep;
}
