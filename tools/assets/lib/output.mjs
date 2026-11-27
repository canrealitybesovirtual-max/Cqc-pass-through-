// @ts-check
/**
 * Writing baked GLBs: one shared atlas material, KTX2 textures
 * (KHR_texture_basisu), EXT_meshopt_compression, quantised normals / UVs /
 * skin weights. Positions stay float32 so the node transforms are identity
 * and the vertex data is directly in gun / body space.
 */
import { Document, TextureInfo } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { getIO } from './source.mjs';

/** @typedef {{ base: Uint8Array, normal?: Uint8Array, orm?: Uint8Array, occlusion?: boolean }} TextureSet */

/** @param {Document} doc */
export function newDoc() {
  const d = new Document();
  d.createBuffer('data');
  return d;
}

/**
 * @param {Document} doc @param {string} name @param {TextureSet} tex
 * @param {{ doubleSided?: boolean }} [opt]
 */
export function atlasMaterial(doc, name, tex, opt = {}) {
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  const mk = (/** @type {string} */ n, /** @type {Uint8Array} */ img) => doc.createTexture(n).setImage(img).setMimeType('image/ktx2');
  const mat = doc.createMaterial(name).setMetallicFactor(1).setRoughnessFactor(1).setDoubleSided(!!opt.doubleSided);
  /** @param {TextureInfo | null} ti */
  const clamp = (ti) => {
    if (!ti) return;
    ti.setWrapS(TextureInfo.WrapMode.CLAMP_TO_EDGE).setWrapT(TextureInfo.WrapMode.CLAMP_TO_EDGE)
      .setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR).setMagFilter(TextureInfo.MagFilter.LINEAR);
  };
  mat.setBaseColorTexture(mk(`${name}_base`, tex.base)); clamp(mat.getBaseColorTextureInfo());
  if (tex.normal) { mat.setNormalTexture(mk(`${name}_normal`, tex.normal)); clamp(mat.getNormalTextureInfo()); }
  if (tex.orm) {
    const orm = mk(`${name}_orm`, tex.orm);
    mat.setMetallicRoughnessTexture(orm); clamp(mat.getMetallicRoughnessTextureInfo());
    if (tex.occlusion) { mat.setOcclusionTexture(orm); clamp(mat.getOcclusionTextureInfo()); }
  }
  return mat;
}

/**
 * @param {Document} doc @param {string} name
 * @param {{ pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array, part?: Float32Array, tangent?: Float32Array, joints?: Uint16Array, weights?: Float32Array }} m
 * @param {import('@gltf-transform/core').Material} mat
 */
export function meshFrom(doc, name, m, mat) {
  const buf = doc.getRoot().listBuffers()[0];
  const acc = (/** @type {string} */ type, /** @type {ArrayLike<number>} */ arr) => doc.createAccessor().setType(/** @type {any} */ (type)).setArray(/** @type {any} */ (arr)).setBuffer(buf);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', m.pos))
    .setAttribute('NORMAL', acc('VEC3', m.nrm))
    .setAttribute('TEXCOORD_0', acc('VEC2', m.uv))
    .setMaterial(mat);
  if (m.part) prim.setAttribute('_PART', acc('SCALAR', m.part));
  if (m.tangent) prim.setAttribute('TANGENT', acc('VEC4', m.tangent));
  if (m.joints) prim.setAttribute('JOINTS_0', acc('VEC4', m.joints));
  if (m.weights) prim.setAttribute('WEIGHTS_0', acc('VEC4', m.weights));
  const vcount = m.pos.length / 3;
  prim.setIndices(acc('SCALAR', vcount > 65535 ? m.idx : Uint16Array.from(m.idx)));
  return doc.createMesh(name).addPrimitive(prim);
}

/**
 * Optimise and write a GLB. Returns its bytes.
 * @param {Document} doc
 */
export async function finishGLB(doc) {
  await MeshoptEncoder.ready;
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(NORMAL|TANGENT|TEXCOORD_0|WEIGHTS_0)$/, quantizeNormal: 12, quantizeTexcoord: 16, quantizeWeight: 16, normalizeWeights: true }),
  );
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const io = await getIO();
  return io.writeBinary(doc);
}
