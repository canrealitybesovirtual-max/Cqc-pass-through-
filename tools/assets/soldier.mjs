// @ts-check
/**
 * Soldier bake: the blackout soldier (cm, Sketchfab wrapper nodes) -> metres,
 * feet at y = 0, facing +Z, one SkinnedMesh with a clean joint hierarchy.
 * Joints that carry no weight are removed and the face joints (eyes, lids,
 * brows, jaw: no facial animation in the game) are merged into the head, so
 * the skeleton stays within the PLAN's 64-bone budget. The enemy rifle (a
 * decimated AKM) is parented to the right hand joint.
 */
import {
  add, cross, mat4Compose, mat4Decompose, mat4Invert, mat4Mul, normalize, rot3FromFrames, roundVec, scale, sub, dot,
} from './lib/geom.mjs';
import { readDoc, readMaterials } from './lib/source.mjs';
import { encodeKTX2, gpuBytes, materialMaps, resize } from './lib/textures.mjs';
import { atlasMaterial, finishGLB, meshFrom, newDoc } from './lib/output.mjs';

/** @typedef {[number, number, number]} V3 */

export const SOLDIER_FILE = '/home/user/canrealitybesovirtual-max/blackout-claude/models/soldier.glb';
const FACE = /^(eye_|eyelid_|eyebrow_|jaw_)/;

/** Manifest joint roles -> source joint names. */
const JOINT_MAP = {
  pelvis: 'pelvis_02', spine: ['spine_01_03', 'spine_02_04', 'spine_03_05'], neck: 'neck_01_047', head: 'head_048',
  clavL: 'clavicle_l_06', upperArmL: 'upperarm_l_07', lowerArmL: 'lowerarm_l_08', handL: 'hand_l_09',
  clavR: 'clavicle_r_026', upperArmR: 'upperarm_r_027', lowerArmR: 'lowerarm_r_028', handR: 'hand_r_029',
  thighL: 'thigh_l_058', calfL: 'calf_l_059', footL: 'foot_l_061',
  thighR: 'thigh_r_064', calfR: 'calf_r_065', footR: 'foot_r_067',
};

/**
 * @param {{ cacheDir: string, log: (s: string) => void }} env
 * @param {{ mesh: { pos: Float32Array, nrm: Float32Array, uv: Float32Array, idx: Uint32Array }, base: import('./lib/textures.mjs').Raw, orm: import('./lib/textures.mjs').Raw, grip: { pos: number[], up: number[], fwd: number[] }, support: number[], muzzle: number[] }} rifle
 */
export async function bakeSoldier(env, rifle) {
  const doc = await readDoc(SOLDIER_FILE);
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  if (!ibm) throw new Error('soldier: no inverse bind matrices');
  const meshNode = root.listNodes().find((n) => n.getSkin());
  if (!meshNode) throw new Error('soldier: no skinned mesh');
  const prim = /** @type {import('@gltf-transform/core').Mesh} */ (meshNode.getMesh()).listPrimitives()[0];
  const A = (/** @type {string} */ s) => { const a = prim.getAttribute(s); if (!a) throw new Error(`soldier: missing ${s}`); return a; };
  const P = A('POSITION'), N = A('NORMAL'), T = A('TANGENT'), UV = A('TEXCOORD_0'), J = A('JOINTS_0'), Wt = A('WEIGHTS_0');
  const nv = P.getCount();

  // vertex positions are in the skeleton's world frame at the bind pose (W * IBM = I for the weighted joints)
  let minY = Infinity, maxY = -Infinity;
  const e = [0, 0, 0, 0];
  for (let i = 0; i < nv; i++) { const p = P.getElement(i, e); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const U = 0.01; // centimetres -> metres
  const byName = new Map(joints.map((j, i) => [j.getName(), i]));
  const wpos = (/** @type {string} */ n) => { const m = joints[/** @type {number} */ (byName.get(n))].getWorldMatrix(); return /** @type {V3} */ ([m[12], m[13], m[14]]); };
  // facing: toes ahead of the ankles, eyes ahead of the head
  const facing = (wpos('ball_l_062')[2] - wpos('foot_l_061')[2]) + (wpos('eye_l_049')[2] - wpos('head_048')[2]);
  const flip = facing < 0;
  const Sx = mat4Mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -minY * U, 0, 1], mat4Compose([0, 0, 0], flip ? [0, 1, 0, 0] : [0, 0, 0, 1], [U, U, U]));
  env.log(`soldier: height ${((maxY - minY) * U).toFixed(3)} m, facing ${flip ? '-Z (turned)' : '+Z'}, ${joints.length} joints`);

  // weighted joints; face joints merge into the head
  const weighted = new Set();
  for (let i = 0; i < nv; i++) { const j = J.getElement(i, [0, 0, 0, 0]), w = Wt.getElement(i, [0, 0, 0, 0]); for (let k = 0; k < 4; k++) if (w[k] > 0) weighted.add(j[k]); }
  const head = /** @type {number} */ (byName.get('head_048'));
  const target = joints.map((j, i) => (FACE.test(j.getName()) ? head : i));
  /** @type {Set<import('@gltf-transform/core').Node>} */
  const keep = new Set();
  const parentOf = new Map();
  for (const j of joints) for (const c of j.listChildren()) parentOf.set(c, j);
  joints.forEach((j, i) => {
    if (target[i] !== i || !weighted.has(i)) return;
    for (let n = j; n && joints.includes(n); n = parentOf.get(n)) keep.add(n);
  });
  const kept = joints.filter((j) => keep.has(j));
  const newIndex = new Map(kept.map((j, i) => [j, i]));
  const remap = joints.map((j, i) => /** @type {number} */ (newIndex.get(joints[target[i]]) ?? newIndex.get(joints[head])));
  env.log(`soldier: ${weighted.size} weighted joints -> ${kept.length} kept (face joints merged into the head, unweighted leaves and IK joints removed)`);
  if (kept.length > 64) throw new Error(`soldier: ${kept.length} joints > 64`);

  // new joint frames: W' = Sx * W * D^-1 (rigid, metres), IBM' = D * IBM * Sx^-1
  const D = [U, 0, 0, 0, 0, U, 0, 0, 0, 0, U, 0, 0, 0, 0, 1];
  const Dinv = mat4Invert(D), SxInv = mat4Invert(Sx);
  const Wn = new Map(kept.map((j) => [j, mat4Mul(mat4Mul(Sx, j.getWorldMatrix()), Dinv)]));
  const ibmNew = new Float32Array(kept.length * 16);
  kept.forEach((j, i) => {
    const old = ibm.getElement(joints.indexOf(j), new Array(16).fill(0));
    ibmNew.set(mat4Mul(mat4Mul(D, old), SxInv), i * 16);
  });

  // vertices
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), tan = new Float32Array(nv * 4), uv = new Float32Array(nv * 2);
  const jo = new Uint16Array(nv * 4), we = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const p = P.getElement(i, [0, 0, 0]);
    pos[i * 3] = Sx[0] * p[0] + Sx[4] * p[1] + Sx[8] * p[2] + Sx[12];
    pos[i * 3 + 1] = Sx[1] * p[0] + Sx[5] * p[1] + Sx[9] * p[2] + Sx[13];
    pos[i * 3 + 2] = Sx[2] * p[0] + Sx[6] * p[1] + Sx[10] * p[2] + Sx[14];
    const n = N.getElement(i, [0, 0, 0]), t = T.getElement(i, [0, 0, 0, 0]);
    const sgn = flip ? -1 : 1;
    nrm[i * 3] = n[0] * sgn; nrm[i * 3 + 1] = n[1]; nrm[i * 3 + 2] = n[2] * sgn;
    tan[i * 4] = t[0] * sgn; tan[i * 4 + 1] = t[1]; tan[i * 4 + 2] = t[2] * sgn; tan[i * 4 + 3] = t[3];
    const u = UV.getElement(i, [0, 0]);
    uv[i * 2] = u[0]; uv[i * 2 + 1] = u[1];
    const j = J.getElement(i, [0, 0, 0, 0]), w = Wt.getElement(i, [0, 0, 0, 0]);
    /** @type {Map<number, number>} */
    const acc = new Map();
    for (let k = 0; k < 4; k++) if (w[k] > 0) acc.set(remap[j[k]], (acc.get(remap[j[k]]) || 0) + w[k]);
    const list = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((a, x) => a + x[1], 0) || 1;
    list.forEach(([jj, ww], k) => { jo[i * 4 + k] = jj; we[i * 4 + k] = ww / sum; });
  }
  const srcIdx = prim.getIndices();
  const idx = Uint32Array.from(/** @type {any} */ (srcIdx).getArray());

  // --- rifle in the right hand -------------------------------------------------
  const wp = (/** @type {string} */ n) => { const m = /** @type {number[]} */ (Wn.get(joints[/** @type {number} */ (byName.get(n))])); return /** @type {V3} */ ([m[12], m[13], m[14]]); };
  const handM = /** @type {number[]} */ (Wn.get(joints[/** @type {number} */ (byName.get(JOINT_MAP.handR))]));
  const hand = /** @type {V3} */ ([handM[12], handM[13], handM[14]]);
  const fW = normalize(sub(wp('middle_01_r_033'), hand)); // fingers
  let kW = normalize(sub(wp('pinky_01_r_036'), wp('index_01_r_030'))); // knuckle line, index -> pinky
  kW = normalize(sub(kW, scale(fW, dot(kW, fW))));
  const nW = cross(fW, kW); // palm normal (out of the palm) for a right hand
  const up = /** @type {V3} */ (rifle.grip.up), kT = /** @type {V3} */ (scale(up, -1)), nT = /** @type {V3} */ ([-1, 0, 0]);
  const fT = cross(kT, nT);
  const Rw = rot3FromFrames([fT, kT, nT], [fW, kW, nW]); // rifle -> world rotation
  // palm centre: 45 % from the wrist to the knuckles, then the palm surface + the grip's half thickness along the palm normal
  const palm = add(add(hand, scale(sub(wp('middle_01_r_033'), hand), 0.45)), scale(nW, 0.024));
  const g = rifle.grip.pos;
  const Rg = [Rw[0] * g[0] + Rw[3] * g[1] + Rw[6] * g[2], Rw[1] * g[0] + Rw[4] * g[1] + Rw[7] * g[2], Rw[2] * g[0] + Rw[5] * g[1] + Rw[8] * g[2]];
  const rifleWorld = [Rw[0], Rw[1], Rw[2], 0, Rw[3], Rw[4], Rw[5], 0, Rw[6], Rw[7], Rw[8], 0, palm[0] - Rg[0], palm[1] - Rg[1], palm[2] - Rg[2], 1];
  const local = mat4Mul(mat4Invert(handM), rifleWorld);
  const lt = mat4Decompose(local);

  // --- write ---------------------------------------------------------------------
  const mats = readMaterials(doc);
  const mm = await materialMaps(mats[0]);
  const base = await encodeKTX2(mm.base, 'color', env.cacheDir);
  const normal = await encodeKTX2(mm.normal, 'normal', env.cacheDir);
  const orm = await encodeKTX2(mm.orm, 'data', env.cacheDir);
  const rBase = await encodeKTX2(await resize(rifle.base, 512, 512), 'color', env.cacheDir);
  const rOrm = await encodeKTX2(await resize(rifle.orm, 256, 256), 'data', env.cacheDir);

  const out = newDoc();
  const mat = atlasMaterial(out, 'soldier', { base, normal, orm, occlusion: false }, { doubleSided: mats[0].doubleSided });
  const rmat = atlasMaterial(out, 'rifle', { base: rBase, orm: rOrm, occlusion: true });
  const scene = out.createScene('soldier');
  out.getRoot().setDefaultScene(scene);
  const nodes = new Map();
  for (const j of kept) nodes.set(j, out.createNode(j.getName()));
  for (const j of kept) {
    const parent = parentOf.get(j);
    const Wj = /** @type {number[]} */ (Wn.get(j));
    const L = parent && keep.has(parent) ? mat4Mul(mat4Invert(/** @type {number[]} */ (Wn.get(parent))), Wj) : Wj;
    const d = mat4Decompose(L);
    const n = nodes.get(j).setTranslation(d.t).setRotation(d.q);
    if (parent && keep.has(parent)) nodes.get(parent).addChild(n); else scene.addChild(n);
  }
  const outSkin = out.createSkin('soldier').setSkeleton(nodes.get(kept[0]))
    .setInverseBindMatrices(out.createAccessor().setType('MAT4').setArray(ibmNew).setBuffer(out.getRoot().listBuffers()[0]));
  for (const j of kept) outSkin.addJoint(nodes.get(j));
  const body = out.createNode('soldier').setMesh(meshFrom(out, 'soldier', { pos, nrm, uv, idx, tangent: tan, joints: jo, weights: we }, mat)).setSkin(outSkin);
  scene.addChild(body);
  const rifleNode = out.createNode('rifle').setMesh(meshFrom(out, 'rifle', rifle.mesh, rmat)).setTranslation(lt.t).setRotation(lt.q);
  nodes.get(joints[/** @type {number} */ (byName.get(JOINT_MAP.handR))]).addChild(rifleNode);
  const glb = await finishGLB(out);

  const keptNames = new Set(kept.map((j) => j.getName()));
  for (const v of Object.values(JOINT_MAP)) for (const n of [v].flat()) if (!keptNames.has(n)) throw new Error(`soldier: joint ${n} was removed`);
  const manifest = {
    height: roundVec([(maxY - minY) * U], 4)[0],
    joints: JOINT_MAP,
    jointCount: kept.length,
    rifleParent: JOINT_MAP.handR,
    rifleInHand: { pos: roundVec(lt.t), quat: roundVec(lt.q, 6) },
    rifleSupport: roundVec(rifle.support),
    rifleMuzzle: roundVec(rifle.muzzle),
    rifleGrip: roundVec(rifle.grip.pos),
    bindPose: 'A-pose; the rifle pose is fitted to the bind-pose right hand (fingers straight)',
    textures: {
      base: { size: [mm.w, mm.h], format: 'KTX2 ETC1S sRGB', bytes: base.byteLength },
      normal: { size: [mm.w, mm.h], format: 'KTX2 UASTC linear', bytes: normal.byteLength },
      orm: { size: [mm.w, mm.h], format: 'KTX2 UASTC linear', bytes: orm.byteLength, channels: 'G roughness, B metalness (no occlusion map)' },
      rifleBase: { size: [512, 512], format: 'KTX2 ETC1S sRGB', bytes: rBase.byteLength },
      rifleOrm: { size: [256, 256], format: 'KTX2 UASTC linear', bytes: rOrm.byteLength },
    },
    tris: idx.length / 3,
    rifleTris: rifle.mesh.idx.length / 3,
  };
  const gpu = gpuBytes(mm.w, mm.h, 'color') + gpuBytes(mm.w, mm.h, 'normal') + gpuBytes(mm.w, mm.h, 'data') + gpuBytes(512, 512, 'color') + gpuBytes(256, 256, 'data');
  const report = { id: 'soldier', tris: idx.length / 3, rifleTris: rifle.mesh.idx.length / 3, draws: 2, joints: kept.length, vertices: nv, glbBytes: glb.byteLength, gpuTextureBytes: gpu };
  return { glb, manifest, report };
}

