// @ts-check
/**
 * Gloved hands for the guns (v0.3 research-fit F), baked offline from the CQC
 * viewmodel rigs (values and design only: the pack meshes are re-posed and
 * re-registered here, no CQC code):
 *
 *   vm-pistol2.glb → Glock: right hand on the grip;
 *   vm-ak.glb      → AKM: right hand on the pistol grip, left hand on the handguard.
 *
 * Per rig:
 * 1. evaluate the skinned arm mesh at t = 0 of its one clip (`allanims`); the
 *    world matrices are taken into the pack gun's own frame (cm, +Z muzzle);
 * 2. register onto OUR gun space with a similarity (scale HAND_SCALE, the
 *    pack hands are 22.5 cm wrist to fingertip, CQC drew them at 0.9 for a
 *    20.2 cm hand): Ry(180°) and the centre of the middle finger's loop round
 *    the grip on the manifest grip centre (middle-finger height);
 * 3. re-pose the index finger (rotations at its three joints, a small grid
 *    search) so its distal pad rests on our trigger blade's front face;
 * 4. keep the hand (wrist-subtree weight ≥ 0.5) plus a 3 cm cuff; the left
 *    hand's finger loop is centred on our handguard;
 * 5. crop the arm texture to the hand's UV window (512², KTX2: base ETC1S
 *    sRGB, normal UASTC, ORM UASTC), one material per gun with the gun's
 *    texture slots, and `_PART` = 2 on the index finger's distal segment (it
 *    follows the trigger blade);
 * 6. write the meshes into the gun's own GLB as nodes `hand_r` (and `hand_l`),
 *    so the existing loader brings them (the gun, magazine and textures are
 *    re-encoded unchanged).
 *
 *   node hands.mjs [--debug <dir>]       (after bake.mjs; also called by it)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDoc, readMaterials, getIO } from './lib/source.mjs';
import { sampleAnimation, worldMatrices, poseSkinned } from './lib/rig.mjs';
import { mat4Invert, mat4Mul, xfPoint } from './lib/geom.mjs';
import { decodeRGBA, cropUV, encodeKTX2, writePNG, solid, resize } from './lib/textures.mjs';
import { atlasMaterial, meshFrom, finishGLB } from './lib/output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const VM = '/home/user/ref/realism-cqc-realism/cqc/models/vm/';

/** cm → m × 0.88 (pack hand 22.5 cm → 19.8 cm). */
export const HAND_SCALE = 0.0088;
/** Texture sizes of the glove maps: base colour, and the normal / ORM maps (smaller: UASTC is 8 bpp). */
const TEX = 512;
const TEXD = 256;
/** Cuff kept above the wrist (pack cm). */
const CUFF = 3.4;

/**
 * Our trigger pads (gun space, the blade's front face at finger height; research-fit A) and
 * the pack rigs.
 */
export const GLOVES = Object.freeze({
  glock: { file: `${VM}vm-pistol2.glb`, gun: 'BPpistol', pad: [0, -0.040, -0.014], left: false },
  akm: { file: `${VM}vm-ak.glb`, gun: 'ak', pad: [0, -0.045, 0.133], left: true },
});

/** @typedef {import('@gltf-transform/core').Node} GNode */

/**
 * @param {Map<GNode, number[]>} M @param {GNode} root @param {number[]} R 4x4 world-space rigid transform
 */
function applyToSubtree(M, root, R) {
  const walk = (/** @type {GNode} */ n) => { const m = M.get(n); if (m) M.set(n, mat4Mul(R, m)); n.listChildren().forEach(walk); };
  walk(root);
}

/** Rotation about a unit axis through point p (column-major 4x4). @param {number[]} p @param {number[]} a @param {number} ang */
function rotAbout(p, a, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, [x, y, z] = a;
  const r = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1], Ti = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1];
  return mat4Mul(T, mat4Mul(r, Ti));
}
const pos = (/** @type {number[]} */ m) => [m[12], m[13], m[14]];
const sub = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (/** @type {number[]} */ a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * One rig, posed and registered. Returns the hands in OUR gun space.
 * @param {'glock'|'akm'} id @param {any} manifest weapons[id] @param {Float32Array} gunPos our gun's positions (handguard measure)
 * @param {(s: string) => void} log
 */
async function poseRig(id, manifest, gunPos, log) {
  const G = GLOVES[id];
  const doc = await readDoc(G.file);
  const nodes = doc.getRoot().listNodes();
  const byPre = (/** @type {string} */ pre) => /** @type {GNode} */ (nodes.find((n) => n.getName().startsWith(pre)));
  const W = worldMatrices(doc, sampleAnimation(doc, 'allanims', 0));
  const gi = mat4Invert(/** @type {number[]} */ (W.get(byPre(G.gun))));
  /** @type {Map<GNode, number[]>} pack gun frame */
  const M = new Map();
  for (const [n, m] of W) M.set(n, mat4Mul(gi, m));
  const s = HAND_SCALE;
  // registration: Ry(180°), scale, middle-finger loop centre → grip centre
  const loop = (/** @type {'R'|'L'} */ side) => {
    const ps = ['middle1', 'middle2', 'middle3'].map((k) => pos(/** @type {number[]} */ (M.get(byPre(`${side}_${k}`)))));
    const tip = byPre(`${side}_middle3`).listChildren()[0];
    ps.push(pos(/** @type {number[]} */ (M.get(tip))));
    return [0, 1, 2].map((k) => ps.reduce((a, p) => a + p[k], 0) / ps.length);
  };
  const cPack = loop('R'), cOurs = manifest.grip.pos;
  const toOurs = (/** @type {number[]} */ p, /** @type {number[]} */ c = cPack, /** @type {number[]} */ o = cOurs) => [-(p[0] - c[0]) * s + o[0], (p[1] - c[1]) * s + o[1], -(p[2] - c[2]) * s + o[2]];
  const toPack = (/** @type {number[]} */ q) => [c0(q, 0), (q[1] - cOurs[1]) / s + cPack[1], -(q[2] - cOurs[2]) / s + cPack[2]];
  const c0 = (/** @type {number[]} */ q, /** @type {number} */ k) => -(q[k] - cOurs[k]) / s + cPack[k];

  // index finger onto the trigger: the distal centreline 0.75 cm (real) in front of the blade face
  const pad = G.pad;
  const target = toPack([pad[0], pad[1], pad[2] - 0.0075]);
  const j1 = byPre('R_point1'), j2 = byPre('R_point2'), j3 = byPre('R_point3'), jt = j3.listChildren()[0];
  const P0 = { p1: pos(/** @type {number[]} */ (M.get(j1))), p2: pos(/** @type {number[]} */ (M.get(j2))), p3: pos(/** @type {number[]} */ (M.get(j3))), pt: pos(/** @type {number[]} */ (M.get(jt))) };
  const nFlex = norm(cross(sub(P0.p2, P0.p1), sub(P0.pt, P0.p1)));
  const nAbd = norm(cross(nFlex, sub(P0.p2, P0.p1)));
  /** @param {number} a1 @param {number} b1 @param {number} a23 */
  const chain = (a1, b1, a23) => {
    const R1 = mat4Mul(rotAbout(P0.p1, nAbd, b1), rotAbout(P0.p1, nFlex, a1));
    const p2 = xfPoint(R1, ...P0.p2), p3a = xfPoint(R1, ...P0.p3), pta = xfPoint(R1, ...P0.pt);
    const n1 = norm(sub(xfPoint(R1, P0.p1[0] + nFlex[0], P0.p1[1] + nFlex[1], P0.p1[2] + nFlex[2]), xfPoint(R1, ...P0.p1)));
    const R2 = rotAbout(p2, n1, a23);
    const p3 = xfPoint(R2, ...p3a), ptb = xfPoint(R2, ...pta);
    const R3 = rotAbout(p3, n1, a23);
    const pt = xfPoint(R3, ...ptb);
    return { R1, R2, R3, mid: [(p3[0] + pt[0]) / 2, (p3[1] + pt[1]) / 2, (p3[2] + pt[2]) / 2] };
  };
  let best = { e: Infinity, a1: 0, b1: 0, a23: 0 };
  const D = Math.PI / 180;
  for (let a1 = -35; a1 <= 35; a1 += 1) for (let b1 = -20; b1 <= 20; b1 += 1) for (let a23 = -40; a23 <= 20; a23 += 2.5) {
    const { mid } = chain(a1 * D, b1 * D, a23 * D);
    const e = Math.hypot(mid[0] - target[0], mid[1] - target[1], mid[2] - target[2]) + 0.002 * (Math.abs(a1) + Math.abs(b1) + Math.abs(a23));
    if (e < best.e) best = { e, a1, b1, a23 };
  }
  const fix = chain(best.a1 * D, best.b1 * D, best.a23 * D);
  applyToSubtree(M, j1, fix.R1);
  applyToSubtree(M, j2, fix.R2);
  applyToSubtree(M, j3, fix.R3);
  const padErr = Math.hypot(...sub(fix.mid, target)) * s * 1000;
  log(`  ${id}: index re-posed (${best.a1}°, ${best.b1}°, ${best.a23}°), distal centre ${padErr.toFixed(1)} mm from the trigger target`);

  // skin with the re-posed matrices
  const skinNode = /** @type {GNode} */ (nodes.find((n) => n.getSkin() && n.getMesh()));
  const P = poseSkinned(skinNode, M);
  const sideSet = (/** @type {string} */ pre) => {
    const root = byPre(pre), set = new Set();
    const walk = (/** @type {GNode} */ n) => { set.add(n); n.listChildren().forEach(walk); };
    walk(root);
    return new Set(P.jointNodes.map((j, i) => (set.has(j) ? i : -1)).filter((i) => i >= 0));
  };
  const mats = readMaterials(doc);
  const mat = mats.find((m) => m.name === (P.material ? P.material.getName() : '')) || mats[0];

  /** @param {'R'|'L'} side */
  const extract = (side) => {
    const hand = sideSet(`${side}_wrist`), arm = sideSet(`${side}_arm`), distal = sideSet(`${side}_point3`);
    const wrist = pos(/** @type {number[]} */ (M.get(byPre(`${side}_wrist`))));
    const n = P.pos.length / 3, keep = new Uint8Array(n), part = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let wh = 0, wa = 0, wd = 0;
      for (let k = 0; k < 4; k++) {
        const j = P.joints[i * 4 + k], w = P.weights[i * 4 + k];
        if (hand.has(j)) wh += w;
        if (arm.has(j)) wa += w;
        if (distal.has(j)) wd += w;
      }
      const d = Math.hypot(P.pos[i * 3] - wrist[0], P.pos[i * 3 + 1] - wrist[1], P.pos[i * 3 + 2] - wrist[2]);
      keep[i] = wh >= 0.5 || (wa >= 0.5 && d < CUFF) ? 1 : 0;
      part[i] = side === 'R' && wd >= 0.5 ? 2 : 0;
    }
    /** @type {number[]} */
    const tri = [];
    for (let t = 0; t < P.idx.length; t += 3) {
      const a = P.idx[t], b = P.idx[t + 1], c = P.idx[t + 2];
      if (keep[a] && keep[b] && keep[c]) tri.push(a, b, c);
    }
    return { tri, part };
  };
  const R = extract('R');
  const L = G.left ? extract('L') : null;
  // the left hand: same rotation and scale, its finger loop centred on our handguard
  let lOff = [0, 0, 0];
  if (L) {
    const lc = toOurs(loop('L'));
    const zc = lc[2];
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < gunPos.length; i += 3) if (Math.abs(gunPos[i + 2] - zc) < 0.01 && Math.abs(gunPos[i]) < 0.03) { y0 = Math.min(y0, gunPos[i + 1]); y1 = Math.max(y1, gunPos[i + 1]); }
    const yc = Number.isFinite(y0) ? (y0 + y1) / 2 : -0.02;
    lOff = [-lc[0], yc - lc[1], 0];
    log(`  ${id}: left finger loop at z ${zc.toFixed(3)} m, handguard y ${y0.toFixed(3)}…${y1.toFixed(3)}, moved by ${lOff.map((v) => (v * 1000).toFixed(1)).join(', ')} mm`);
  }
  return { P, R, L, toOurs, lOff, mat, padErr, best };
}

/**
 * Pack one hand's kept triangles into a compact mesh in our gun space, with UVs remapped to the crop window.
 * @param {any} P @param {{ tri: number[], part: Float32Array }} H @param {(p: number[]) => number[]} toOurs @param {number[]} off
 * @param {{ u0: number, v0: number, u1: number, v1: number }} win
 */
function packHand(P, H, toOurs, off, win) {
  const remap = new Map();
  /** @type {number[]} */ const pos = [], nrm = [], uv = [], part = [];
  /** @type {number[]} */ const idx = [];
  for (const v of H.tri) {
    let k = remap.get(v);
    if (k === undefined) {
      k = remap.size;
      remap.set(v, k);
      const p = toOurs([P.pos[v * 3], P.pos[v * 3 + 1], P.pos[v * 3 + 2]]);
      pos.push(p[0] + off[0], p[1] + off[1], p[2] + off[2]);
      nrm.push(-P.nrm[v * 3], P.nrm[v * 3 + 1], -P.nrm[v * 3 + 2]);
      uv.push((P.uv[v * 2] - win.u0) / (win.u1 - win.u0), (P.uv[v * 2 + 1] - win.v0) / (win.v1 - win.v0));
      part.push(H.part[v]);
    }
    idx.push(k);
  }
  // Ry(180°) keeps handedness (a rotation), so the winding stays
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx: Uint32Array.from(idx), part: Float32Array.from(part) };
}

/**
 * UV window (with a small margin) of the kept vertices of the given hands.
 * @param {any} P @param {{ tri: number[] }[]} hands
 */
function uvWindow(P, hands) {
  let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
  for (const H of hands) for (const v of H.tri) { const u = P.uv[v * 2], w = P.uv[v * 2 + 1]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, w); v1 = Math.max(v1, w); }
  const m = 4 / 1024;
  return { u0: Math.max(0, u0 - m), v0: Math.max(0, v0 - m), u1: Math.min(1, u1 + m), v1: Math.min(1, v1 + m) };
}

/**
 * The glove maps cropped to a UV window: base (sRGB), normal, ORM (R occlusion, G roughness, B metalness).
 * @param {any} m readMaterials entry @param {{ u0: number, v0: number, u1: number, v1: number }} win
 */
async function gloveMaps(m, win) {
  const base = await cropUV(await decodeRGBA(m.base.image), win, TEX, TEX);
  for (let i = 0; i < TEX * TEX; i++) base.data[i * 4 + 3] = 255;
  const normal = m.normal ? await cropUV(await decodeRGBA(m.normal.image), win, TEXD, TEXD) : solid(TEXD, TEXD, [128, 128, 255, 255]);
  const mr = m.mr ? await cropUV(await decodeRGBA(m.mr.image), win, TEXD, TEXD) : null;
  const occ = m.occ ? (m.mr && m.occ.image === m.mr.image ? mr : await cropUV(await decodeRGBA(m.occ.image), win, TEXD, TEXD)) : null;
  const orm = solid(TEXD, TEXD, [255, 255, 255, 255]);
  for (let i = 0; i < TEXD * TEXD; i++) {
    orm.data[i * 4] = occ ? Math.round(255 - (255 - occ.data[i * 4]) * m.occStrength) : 255;
    orm.data[i * 4 + 1] = Math.round((mr ? mr.data[i * 4 + 1] : 255) * m.roughness);
    orm.data[i * 4 + 2] = Math.round((mr ? mr.data[i * 4 + 2] : 255) * m.metallic);
  }
  void resize;
  return { base, normal, orm };
}

/**
 * Add the gloves to one baked gun GLB (in place). Returns the manifest entry.
 * @param {'glock'|'akm'} id @param {string} glbFile @param {any} manifest weapons[id]
 * @param {{ cacheDir: string, debugDir?: string, log: (s: string) => void }} env
 */
export async function addHands(id, glbFile, manifest, env) {
  const io = await getIO();
  const doc = await io.read(glbFile);
  const root = doc.getRoot(), scene = root.getDefaultScene() || root.listScenes()[0];
  // drop an earlier bake's hands
  for (const n of root.listNodes()) {
    if (!/^hand_[rl]$/.test(n.getName())) continue;
    const mesh = n.getMesh();
    n.dispose();
    if (mesh) { for (const p of mesh.listPrimitives()) { for (const a of p.listAttributes()) a.dispose(); p.getIndices()?.dispose(); } mesh.dispose(); }
  }
  for (const m of root.listMaterials()) if (m.getName() === 'hand') {
    for (const t of [m.getBaseColorTexture(), m.getNormalTexture(), m.getMetallicRoughnessTexture(), m.getOcclusionTexture()]) if (t) t.dispose();
    m.dispose();
  }
  const gunNode = root.listNodes().find((n) => n.getName() === 'gun');
  const gunPos = /** @type {Float32Array} */ (gunNode?.getMesh()?.listPrimitives()[0].getAttribute('POSITION')?.getArray());

  const rig = await poseRig(id, manifest, gunPos, env.log);
  const hands = rig.L ? [rig.R, rig.L] : [rig.R];
  const win = uvWindow(rig.P, hands);
  const maps = await gloveMaps(rig.mat, win);
  if (env.debugDir) {
    mkdirSync(env.debugDir, { recursive: true });
    await writePNG(maps.base, join(env.debugDir, `${id}-hand-base.png`));
  }
  const ktx = {
    base: await encodeKTX2(maps.base, 'color', env.cacheDir),
    normal: await encodeKTX2(maps.normal, 'normal', env.cacheDir),
    orm: await encodeKTX2(maps.orm, 'data', env.cacheDir),
  };
  const mat = atlasMaterial(doc, 'hand', { base: ktx.base, normal: ktx.normal, orm: ktx.orm, occlusion: true });
  /** @type {Record<string, any>} */
  const entry = { tris: 0, textures: { size: [TEX, TEXD, TEXD], bytes: ktx.base.byteLength + ktx.normal.byteLength + ktx.orm.byteLength }, scale: HAND_SCALE,
    indexPose: [rig.best.a1, rig.best.b1, rig.best.a23], indexPadErrMm: Math.round(rig.padErr * 10) / 10, nodes: [] };
  const r = packHand(rig.P, rig.R, rig.toOurs, [0, 0, 0], win);
  const nr = doc.createNode('hand_r').setMesh(meshFrom(doc, 'hand_r', r, mat));
  scene.addChild(nr);
  entry.nodes.push('hand_r');
  entry.tris += r.idx.length / 3;
  if (rig.L) {
    const l = packHand(rig.P, rig.L, rig.toOurs, rig.lOff, win);
    const nl = doc.createNode('hand_l').setMesh(meshFrom(doc, 'hand_l', l, mat));
    scene.addChild(nl);
    entry.nodes.push('hand_l');
    entry.tris += l.idx.length / 3;
  }
  const glb = await finishGLB(doc);
  writeFileSync(glbFile, glb);
  entry.bytesGLB = glb.byteLength;
  env.log(`  ${id}: ${entry.nodes.join(' + ')}, ${entry.tris} tris, textures ${(entry.textures.bytes / 1024).toFixed(0)} KB, ${(glb.byteLength / 1024).toFixed(0)} KB GLB`);
  return entry;
}

/**
 * Add gloves to both gun GLBs and record them in the manifest (weapons[id].hands, bytes).
 * @param {{ cacheDir: string, debugDir?: string, log: (s: string) => void }} env
 * @param {any} manifest parsed manifest.json (updated in place)
 */
export async function bakeHands(env, manifest) {
  for (const id of /** @type {const} */ (['glock', 'akm'])) {
    const file = join(repo, 'assets', manifest.models[id]);
    const e = await addHands(id, file, manifest.weapons[id], env);
    manifest.weapons[id].hands = { nodes: e.nodes, tris: e.tris, scale: e.scale, texture: e.textures, indexPose: e.indexPose, indexPadErrMm: e.indexPadErrMm,
      source: `CQC ${id === 'glock' ? 'vm-pistol2' : 'vm-ak'}.glb, allanims t = 0 (tools/assets/hands.mjs)` };
    if (manifest.bytes) manifest.bytes[manifest.models[id]] = e.bytesGLB;
  }
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : undefined;
  const env = { cacheDir: join(here, '.cache'), debugDir, log: (/** @type {string} */ s) => console.log(s) };
  const mfile = join(repo, 'assets', 'manifest.json');
  const manifest = JSON.parse(readFileSync(mfile, 'utf8'));
  bakeHands(env, manifest).then((m) => {
    writeFileSync(mfile, `${JSON.stringify(m, null, 2)}\n`);
    console.log('hands baked');
  }).catch((e) => { console.error(e); process.exit(1); });
}
