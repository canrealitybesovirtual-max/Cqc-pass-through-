// @ts-check
/**
 * Reading source GLBs into flat "pieces": one connected component of one
 * primitive, with positions/normals already in the target frame.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { bounds, mat4Det3, mat4Mul, normalMatrix, triangleComponents, weldByPosition } from './geom.mjs';

/** @typedef {[number, number, number]} V3 */

/**
 * @typedef {Object} Piece
 * @property {string} src     source mesh/node name
 * @property {number} comp    component index inside the source primitive
 * @property {number} mat     source material index
 * @property {Float32Array} pos
 * @property {Float32Array} nrm
 * @property {Float32Array} uv
 * @property {Uint32Array} idx
 * @property {V3} smin        bounds in the classification frame (source world, mm)
 * @property {V3} smax
 * @property {number} role    0..4 gun part, 5 = magazine, -1 = dropped
 * @property {string} [label] what the piece is (for the bake log)
 */

let io = /** @type {NodeIO | null} */ (null);

export async function getIO() {
  if (io) return io;
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  return io;
}

/** @param {string} file */
export async function readDoc(file) {
  return (await getIO()).read(file);
}

/**
 * Material table of a source document: images and factors.
 * @param {import('@gltf-transform/core').Document} doc
 */
export function readMaterials(doc) {
  return doc.getRoot().listMaterials().map((m) => {
    const tex = (/** @type {import('@gltf-transform/core').Texture | null} */ t) => (t ? { image: t.getImage(), mime: t.getMimeType(), size: t.getSize() } : null);
    return {
      name: m.getName(),
      base: tex(m.getBaseColorTexture()),
      normal: tex(m.getNormalTexture()),
      mr: tex(m.getMetallicRoughnessTexture()),
      occ: tex(m.getOcclusionTexture()),
      baseFactor: m.getBaseColorFactor(),
      metallic: m.getMetallicFactor(),
      roughness: m.getRoughnessFactor(),
      occStrength: m.getOcclusionStrength(),
      normalScale: m.getNormalScale(),
      doubleSided: m.getDoubleSided(),
    };
  });
}

/**
 * Split every mesh primitive of the document into connected pieces.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{ frame: number[], classify: number[], skip?: (nodeName: string) => boolean, weldEps?: number }} opt
 *   frame: matrix applied after each node's world matrix (target frame, metres)
 *   classify: matrix applied after the world matrix for the piece bounds used by the rules (mm)
 * @returns {Piece[]}
 */
export function readPieces(doc, opt) {
  const root = doc.getRoot();
  const mats = root.listMaterials();
  /** @type {Piece[]} */
  const out = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getSkin()) continue;
    const name = node.getName() || mesh.getName();
    if (opt.skip && opt.skip(name)) continue;
    const W = node.getWorldMatrix();
    const M = mat4Mul(opt.frame, W);
    const C = mat4Mul(opt.classify, W);
    const N = normalMatrix(M);
    const flip = mat4Det3(M) < 0;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) throw new Error(`${name}: only TRIANGLES are supported`);
      const P = prim.getAttribute('POSITION'), Nr = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0');
      if (!P || !Nr || !T) throw new Error(`${name}: POSITION, NORMAL and TEXCOORD_0 are required`);
      const n = P.getCount();
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), cpos = new Float64Array(n * 3);
      const e = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const p = P.getElement(i, e);
        const x = p[0], y = p[1], z = p[2];
        pos[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
        pos[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
        pos[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        cpos[i * 3] = C[0] * x + C[4] * y + C[8] * z + C[12];
        cpos[i * 3 + 1] = C[1] * x + C[5] * y + C[9] * z + C[13];
        cpos[i * 3 + 2] = C[2] * x + C[6] * y + C[10] * z + C[14];
        const q = Nr.getElement(i, e);
        let nx = N[0] * q[0] + N[3] * q[1] + N[6] * q[2], ny = N[1] * q[0] + N[4] * q[1] + N[7] * q[2], nz = N[2] * q[0] + N[5] * q[1] + N[8] * q[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
        const t = T.getElement(i, e);
        uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1];
      }
      const srcIdx = prim.getIndices();
      const idx = srcIdx ? Uint32Array.from(srcIdx.getArray() || []) : Uint32Array.from({ length: n }, (_, i) => i);
      if (flip) for (let t = 0; t < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a; }
      const rep = weldByPosition(pos, opt.weldEps ?? 1e-6);
      const { triComp, count } = triangleComponents(idx, rep);
      const mat = mats.indexOf(/** @type {any} */ (prim.getMaterial()));
      for (let c = 0; c < count; c++) {
        const remap = new Int32Array(n).fill(-1);
        /** @type {number[]} */
        const tri = [];
        /** @type {number[]} */
        const verts = [];
        for (let t = 0; t < triComp.length; t++) {
          if (triComp[t] !== c) continue;
          for (let j = 0; j < 3; j++) {
            const v = idx[t * 3 + j];
            if (remap[v] < 0) { remap[v] = verts.length; verts.push(v); }
            tri.push(remap[v]);
          }
        }
        const k = verts.length;
        const p2 = new Float32Array(k * 3), n2 = new Float32Array(k * 3), u2 = new Float32Array(k * 2);
        verts.forEach((v, i) => {
          p2.set(pos.subarray(v * 3, v * 3 + 3), i * 3);
          n2.set(nrm.subarray(v * 3, v * 3 + 3), i * 3);
          u2.set(uv.subarray(v * 2, v * 2 + 2), i * 2);
        });
        const cb = bounds(cpos, verts);
        out.push({ src: name, comp: c, mat, pos: p2, nrm: n2, uv: u2, idx: Uint32Array.from(tri), smin: cb.min, smax: cb.max, role: -1 });
      }
    }
  }
  return out;
}

/**
 * Concatenate pieces into one indexed mesh (with an optional per-vertex part id).
 * @param {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array, part?: number }[]} list
 */
export function concat(list) {
  let nv = 0, ni = 0;
  for (const p of list) { nv += p.pos.length / 3; ni += p.idx.length; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), part = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of list) {
    const n = p.pos.length / 3;
    pos.set(p.pos, ov * 3); nrm.set(p.nrm, ov * 3); uv.set(p.uv, ov * 2);
    part.fill(p.part ?? 0, ov, ov + n);
    for (let i = 0; i < p.idx.length; i++) idx[oi + i] = p.idx[i] + ov;
    ov += n; oi += p.idx.length;
  }
  return { pos, nrm, uv, idx, part };
}
