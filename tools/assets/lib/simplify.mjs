// @ts-check
/**
 * meshoptimizer simplification of pieces with an absolute error bound
 * (metres). UV and normal seams are preserved by meshopt (it never collapses
 * across attribute discontinuities); open borders can be locked.
 */
import { MeshoptSimplifier } from 'meshoptimizer';
import { filterTriangles, weldExact } from './geom.mjs';

/** @typedef {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }} MeshData */

export const ready = MeshoptSimplifier.ready;

/**
 * Simplify one mesh to an absolute geometric error.
 * @param {MeshData} m (already welded)
 * @param {number} error metres
 * @param {{ lockBorder?: boolean, targetRatio?: number }} [opt]
 * @returns {MeshData}
 */
export function simplifyAbs(m, error, opt = {}) {
  const tris = m.idx.length / 3;
  if (tris < 8 || error <= 0) return m;
  /** @type {import('meshoptimizer').SimplifierFlags[]} */
  const flags = ['ErrorAbsolute'];
  if (opt.lockBorder) flags.push('LockBorder');
  const target = Math.max(3, Math.floor(m.idx.length * (opt.targetRatio ?? 0)) - (Math.floor(m.idx.length * (opt.targetRatio ?? 0)) % 3));
  const [idx] = MeshoptSimplifier.simplify(m.idx, m.pos, 3, target, error, flags);
  return compact({ ...m, idx: Uint32Array.from(idx) });
}

/**
 * Topology-free simplification (for distant LODs): reaches a triangle target
 * by clustering, ignoring seams. Used only when the regular simplifier stalls.
 * @param {MeshData} m @param {number} targetTris
 */
export function simplifySloppy(m, targetTris) {
  const [idx] = MeshoptSimplifier.simplifySloppy(m.idx, m.pos, 3, null, targetTris * 3, 1);
  return compact({ ...m, idx: Uint32Array.from(idx) });
}

/**
 * Drop vertices no longer referenced.
 * @param {MeshData} m
 */
export function compact(m) {
  return filterTriangles(m, () => true);
}

/**
 * Weld then simplify, keeping the result only if it is smaller.
 * @param {MeshData} m @param {number} error @param {{ lockBorder?: boolean }} [opt]
 */
export function weldAndSimplify(m, error, opt = {}) {
  const w = weldExact(m);
  const s = simplifyAbs(w, error, opt);
  return s.idx.length < w.idx.length ? s : w;
}
