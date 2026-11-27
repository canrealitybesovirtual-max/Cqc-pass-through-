// @ts-check
/**
 * Re-read the baked GLBs with glTF Transform and report what the runtime will
 * get: triangles, draw calls (= primitives), joints, textures (size, format,
 * bytes) and the estimated GPU texture memory on Quest 3.
 *   cd tools/assets && node check.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIO } from './lib/source.mjs';
import { gpuBytes } from './lib/textures.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(repo, 'assets/manifest.json'), 'utf8'));
const io = await getIO();
const MB = (/** @type {number} */ b) => `${(b / 1048576).toFixed(2)} MB`;

/** KTX2 header: size and supercompression / colour model (ETC1S = 163, UASTC = 166). @param {Uint8Array} b */
function ktx2(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = dv.getUint32(20, true), h = dv.getUint32(24, true), levels = dv.getUint32(40, true), scheme = dv.getUint32(44, true);
  const dfdOff = dv.getUint32(48, true);
  const model = dv.getUint8(dfdOff + 12);
  const transfer = dv.getUint8(dfdOff + 14);
  return { w, h, levels, codec: model === 166 ? 'UASTC' : model === 163 ? 'ETC1S' : `model ${model}`, srgb: transfer === 2, zstd: scheme === 2 };
}

let total = 0;
for (const [id, file] of Object.entries(manifest.models)) {
  const path = join(repo, 'assets', /** @type {string} */ (file));
  const doc = await io.read(path);
  const root = doc.getRoot();
  let tris = 0, draws = 0;
  /** @type {Record<string, number>} */
  const perMesh = {};
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const p of mesh.listPrimitives()) {
      const t = (p.getIndices()?.getCount() ?? 0) / 3;
      tris += t; draws++;
      perMesh[node.getName()] = (perMesh[node.getName()] || 0) + t;
    }
  }
  let gpu = 0;
  const tex = root.listTextures().map((t) => {
    const k = ktx2(/** @type {Uint8Array} */ (t.getImage()));
    const bytes = gpuBytes(k.w, k.h, k.codec === 'ETC1S' ? 'color' : 'data');
    gpu += bytes;
    return `${t.getName()} ${k.w}x${k.h} ${k.codec}${k.srgb ? ' sRGB' : ''}${k.zstd ? '+zstd' : ''} ${k.levels} mips ${(/** @type {Uint8Array} */ (t.getImage()).byteLength / 1024).toFixed(0)} KB -> GPU ${MB(bytes)}`;
  });
  const skin = root.listSkins()[0];
  const size = statSync(path).size;
  total += size;
  console.log(`\n${id}: ${file} ${MB(size)}; ${tris} tris in ${draws} draws ${JSON.stringify(perMesh)}; materials ${root.listMaterials().length}${skin ? `; joints ${skin.listJoints().length}` : ''}`);
  console.log(`  extensions: ${root.listExtensionsUsed().map((e) => e.extensionName).join(', ')}`);
  for (const t of tex) console.log(`  ${t}`);
  console.log(`  GPU texture memory (Quest 3: ETC1S -> ETC2 RGB, UASTC -> ASTC 4x4, full mips): ${MB(gpu)}`);
  for (const p of root.listMeshes()[0].listPrimitives()) {
    console.log(`  attributes: ${p.listSemantics().map((s) => { const a = /** @type {any} */ (p.getAttribute(s)); return `${s}:${a.getComponentType()}${a.getNormalized() ? 'n' : ''}`; }).join(' ')}`);
  }
}
let snd = 0;
for (const f of new Set(Object.values(manifest.sounds).flat())) snd += statSync(join(repo, 'assets', /** @type {string} */ (f))).size;
console.log(`\nsounds: ${new Set(Object.values(manifest.sounds).flat()).size} files, ${MB(snd)}; keys ${Object.keys(manifest.sounds).length}`);
console.log(`total: ${MB(total + snd + statSync(join(repo, 'assets/manifest.json')).size)}`);
