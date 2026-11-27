// @ts-check
/**
 * Texture atlases: material maps with their factors baked in, cropped to the
 * UV window each material uses, packed into one atlas (base colour, normal,
 * ORM = occlusion/roughness/metalness) and encoded to KTX2 (Basis Universal)
 * with an on-disk cache, because the encoder takes about a minute per 2048
 * map.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';

/** @typedef {{ data: Uint8Array, w: number, h: number }} Raw */
/** @typedef {import('./pack.mjs').Rect} Rect */

const ENCODER_ID = 'ktx2-encoder@0.6.0';

/** @param {Uint8Array} buf @returns {Promise<Raw>} */
export async function decodeRGBA(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w: info.width, h: info.height };
}

/** @param {number} w @param {number} h @param {[number, number, number, number]} rgba @returns {Raw} */
export function solid(w, h, rgba) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { data, w, h };
}

/** @param {Raw} r @param {number} w @param {number} h @returns {Promise<Raw>} */
export async function resize(r, w, h) {
  if (r.w === w && r.h === h) return r;
  const out = await sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.w, height: r.h, channels: 4 } })
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  return { data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), w, h };
}

/**
 * Crop a UV window (glTF UV, origin top-left) and resize it to w x h.
 * @param {Raw} r @param {{ u0: number, v0: number, u1: number, v1: number }} win @param {number} w @param {number} h
 * @returns {Promise<Raw>}
 */
export async function cropUV(r, win, w, h) {
  const left = Math.max(0, Math.floor(win.u0 * r.w)), top = Math.max(0, Math.floor(win.v0 * r.h));
  const right = Math.min(r.w, Math.ceil(win.u1 * r.w)), bottom = Math.min(r.h, Math.ceil(win.v1 * r.h));
  const out = await sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.w, height: r.h, channels: 4 } })
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  return { data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), w, h };
}

/**
 * The window actually cropped by cropUV (pixel-aligned), as UV.
 * @param {{ u0: number, v0: number, u1: number, v1: number }} win @param {number} tw @param {number} th
 */
export function pixelWindow(win, tw, th) {
  const left = Math.max(0, Math.floor(win.u0 * tw)), top = Math.max(0, Math.floor(win.v0 * th));
  const right = Math.min(tw, Math.ceil(win.u1 * tw)), bottom = Math.min(th, Math.ceil(win.v1 * th));
  return { u0: left / tw, v0: top / th, u1: right / tw, v1: bottom / th };
}

/**
 * Base colour, normal and ORM maps of a source material at the base map's
 * size, with the material factors multiplied in (the atlas material uses
 * factors of 1).
 * @param {ReturnType<typeof import('./source.mjs').readMaterials>[number]} m
 */
export async function materialMaps(m) {
  if (!m.base) throw new Error(`material ${m.name}: no base colour texture`);
  const base = await decodeRGBA(m.base.image);
  const { w, h } = base;
  const f = m.baseFactor;
  if (f.some((x, i) => Math.abs(x - 1) > 1e-6 && i < 3)) {
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) base.data[i * 4 + c] = Math.round(base.data[i * 4 + c] * f[c]);
  }
  for (let i = 0; i < w * h; i++) base.data[i * 4 + 3] = 255; // opaque materials only
  const normal = m.normal ? await resize(await decodeRGBA(m.normal.image), w, h) : solid(w, h, [128, 128, 255, 255]);
  if (m.normalScale !== 1) {
    for (let i = 0; i < w * h; i++) {
      const x = ((normal.data[i * 4] / 255) * 2 - 1) * m.normalScale, y = ((normal.data[i * 4 + 1] / 255) * 2 - 1) * m.normalScale;
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      normal.data[i * 4] = Math.round((x * 0.5 + 0.5) * 255); normal.data[i * 4 + 1] = Math.round((y * 0.5 + 0.5) * 255); normal.data[i * 4 + 2] = Math.round((z * 0.5 + 0.5) * 255);
    }
  }
  const mr = m.mr ? await resize(await decodeRGBA(m.mr.image), w, h) : null;
  const occ = m.occ ? (m.mr && m.occ.image === m.mr.image ? mr : await resize(await decodeRGBA(m.occ.image), w, h)) : null;
  const orm = solid(w, h, [255, 255, 255, 255]);
  for (let i = 0; i < w * h; i++) {
    const o = occ ? 255 - (255 - occ.data[i * 4]) * m.occStrength : 255;
    orm.data[i * 4] = Math.round(o);
    orm.data[i * 4 + 1] = Math.round((mr ? mr.data[i * 4 + 1] : 255) * m.roughness);
    orm.data[i * 4 + 2] = Math.round((mr ? mr.data[i * 4 + 2] : 255) * m.metallic);
  }
  return { base, normal, orm, w, h, hasOcclusion: !!occ };
}

/**
 * Blit tiles into an atlas and extend each tile's edge pixels `pad` pixels
 * outwards (so filtering and the first mip levels never pick up a neighbour).
 * @param {number} W @param {number} H @param {[number, number, number, number]} fill
 * @param {{ rect: Rect, raw: Raw }[]} tiles @param {number} pad
 * @returns {Raw}
 */
export function composeAtlas(W, H, fill, tiles, pad) {
  const out = solid(W, H, fill);
  for (const { rect, raw } of tiles) {
    if (raw.w !== rect.w || raw.h !== rect.h) throw new Error('tile size mismatch');
    for (let y = -pad; y < rect.h + pad; y++) {
      const ay = rect.y + y;
      if (ay < 0 || ay >= H) continue;
      const sy = Math.min(rect.h - 1, Math.max(0, y));
      for (let x = -pad; x < rect.w + pad; x++) {
        const ax = rect.x + x;
        if (ax < 0 || ax >= W) continue;
        const sx = Math.min(rect.w - 1, Math.max(0, x));
        const si = (sy * rect.w + sx) * 4, di = (ay * W + ax) * 4;
        out.data[di] = raw.data[si]; out.data[di + 1] = raw.data[si + 1]; out.data[di + 2] = raw.data[si + 2]; out.data[di + 3] = raw.data[si + 3];
      }
    }
  }
  return out;
}

/**
 * @typedef {'color' | 'normal' | 'data'} MapKind
 * color: sRGB base colour, ETC1S (transcodes to ETC2 RGB on Quest)
 * normal: linear UASTC + RDO + Zstandard (ASTC 4x4 on Quest)
 * data: linear UASTC (ORM; ASTC 4x4 on Quest)
 */

/** @param {MapKind} kind */
function encodeOptions(kind) {
  if (kind === 'color') return { isUASTC: false, qualityLevel: 255, compressionLevel: 3, isPerceptual: true, isSetKTX2SRGBTransferFunc: true };
  return { isUASTC: true, uastcLDRQualityLevel: 2, enableRDO: true, rdoQualityLevel: 1.0, needSupercompression: true, isNormalMap: kind === 'normal', isPerceptual: false, isSetKTX2SRGBTransferFunc: false };
}

/**
 * Encode RGBA pixels to KTX2 with full mip chain; cached by content hash.
 * @param {Raw} raw @param {MapKind} kind @param {string} cacheDir
 * @returns {Promise<Uint8Array>}
 */
export async function encodeKTX2(raw, kind, cacheDir) {
  const opts = { ...encodeOptions(kind), generateMipmap: true, isKTX2File: true };
  const key = createHash('sha256').update(ENCODER_ID).update(JSON.stringify(opts)).update(`${raw.w}x${raw.h}`).update(raw.data).digest('hex').slice(0, 32);
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${key}.ktx2`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  const out = await encodeToKTX2(raw.data, { ...opts, imageDecoder: async () => ({ width: raw.w, height: raw.h, data: raw.data }) });
  writeFileSync(file, out);
  return out;
}

/** @param {Raw} raw @param {string} file */
export async function writePNG(raw, file) {
  await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), { raw: { width: raw.w, height: raw.h, channels: 4 } }).png().toFile(file);
}

/**
 * GPU bytes of a texture with a full mip chain in the format three's
 * KTX2Loader picks on Quest 3 (ETC1S -> ETC2 RGB 4 bpp, UASTC -> ASTC 4x4 8 bpp).
 * @param {number} w @param {number} h @param {MapKind} kind
 */
export function gpuBytes(w, h, kind) {
  const bpp = kind === 'color' ? 4 : 8;
  let total = 0;
  for (let lw = w, lh = h; ; lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) {
    total += Math.ceil(lw / 4) * Math.ceil(lh / 4) * 16 * (bpp / 8);
    if (lw === 1 && lh === 1) break;
  }
  return total;
}
