// @ts-check
/**
 * A skinned glTF rig evaluated at one moment of one animation, on the CPU
 * (offline bake only): node TRS from the animation channels at time `t`,
 * world matrices, and the skinned positions / normals of a mesh
 * (glTF skinning: v' = Σ w · world(joint) · inverseBind · v; the mesh node's
 * own transform is ignored, as the spec says).
 */
import { mat4Compose, mat4Mul, normalMatrix } from './geom.mjs';

/**
 * @typedef {import('@gltf-transform/core').Document} Document
 * @typedef {import('@gltf-transform/core').Node} GNode
 * @typedef {{ t?: number[], r?: number[], s?: number[] }} TRS
 */

/**
 * Node TRS overrides from an animation at time t (seconds; clamped to its keys).
 * LINEAR / STEP / CUBICSPLINE samplers; rotations are slerped.
 * @param {Document} doc @param {string|null} name animation name (null: the first)
 * @param {number} t
 * @returns {Map<GNode, TRS>}
 */
export function sampleAnimation(doc, name, t) {
  /** @type {Map<GNode, TRS>} */
  const out = new Map();
  const anims = doc.getRoot().listAnimations();
  const anim = name ? anims.find((a) => a.getName() === name) : anims[0];
  if (!anim) return out;
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode(), path = ch.getTargetPath(), smp = ch.getSampler();
    if (!node || !smp || !path || path === 'weights') continue;
    const input = /** @type {Float32Array} */ (smp.getInput()?.getArray()), output = /** @type {Float32Array} */ (smp.getOutput()?.getArray());
    if (!input || !output || !input.length) continue;
    const n = path === 'rotation' ? 4 : 3, cubic = smp.getInterpolation() === 'CUBICSPLINE';
    const stride = cubic ? n * 3 : n, off = cubic ? n : 0;
    const at = (/** @type {number} */ k) => Array.from(output.subarray(k * stride + off, k * stride + off + n));
    let v;
    if (t <= input[0]) v = at(0);
    else if (t >= input[input.length - 1]) v = at(input.length - 1);
    else {
      let k = 0;
      while (input[k + 1] < t) k++;
      const u = (t - input[k]) / (input[k + 1] - input[k]);
      const a = at(k), b = at(k + 1);
      if (smp.getInterpolation() === 'STEP') v = a;
      else if (n === 4) v = slerp(a, b, u);
      else v = a.map((x, i) => x + (b[i] - x) * u);
    }
    const o = out.get(node) || {};
    if (path === 'translation') o.t = v; else if (path === 'rotation') o.r = v; else if (path === 'scale') o.s = v;
    out.set(node, o);
  }
  return out;
}

/** @param {number[]} a @param {number[]} b @param {number} u */
function slerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((x) => -x) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((x, i) => x + (bb[i] - x) * u), l = Math.hypot(...r);
    return r.map((x) => x / l);
  }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
  return a.map((x, i) => x * wa + bb[i] * wb);
}

/**
 * World matrices of every node in the default scene, with TRS overrides.
 * @param {Document} doc @param {Map<GNode, TRS>} trs
 * @returns {Map<GNode, number[]>}
 */
export function worldMatrices(doc, trs) {
  /** @type {Map<GNode, number[]>} */
  const out = new Map();
  /** @param {GNode} n @param {number[]} parent */
  const walk = (n, parent) => {
    const o = trs.get(n) || {};
    const local = mat4Compose(o.t || n.getTranslation(), o.r || n.getRotation(), o.s || n.getScale());
    const w = mat4Mul(parent, local);
    out.set(n, w);
    for (const c of n.listChildren()) walk(c, w);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const n of scene.listChildren()) walk(n, I);
  return out;
}

/**
 * The skinned mesh of `node` posed with the world matrices.
 * @param {GNode} node a node with a mesh and a skin
 * @param {Map<GNode, number[]>} world
 * @returns {{ pos: Float64Array, nrm: Float64Array, uv: Float32Array, idx: Uint32Array, joints: Uint16Array, weights: Float32Array,
 *   jointNodes: GNode[], material: import('@gltf-transform/core').Material | null }}
 */
export function poseSkinned(node, world) {
  const mesh = node.getMesh(), skin = node.getSkin();
  if (!mesh || !skin) throw new Error(`${node.getName()}: no skinned mesh`);
  const prim = mesh.listPrimitives()[0];
  const P = /** @type {any} */ (prim.getAttribute('POSITION')), N = /** @type {any} */ (prim.getAttribute('NORMAL'));
  const UV = /** @type {any} */ (prim.getAttribute('TEXCOORD_0')), J = /** @type {any} */ (prim.getAttribute('JOINTS_0'));
  const Wt = /** @type {any} */ (prim.getAttribute('WEIGHTS_0')), IX = prim.getIndices();
  const joints = skin.listJoints(), ibm = /** @type {any} */ (skin.getInverseBindMatrices());
  const jm = joints.map((j, i) => mat4Mul(/** @type {number[]} */ (world.get(j)), ibm ? ibm.getElement(i, []) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const jn = jm.map((m) => normalMatrix(m));
  const n = P.getCount();
  const pos = new Float64Array(n * 3), nrm = new Float64Array(n * 3), uv = new Float32Array(n * 2);
  const jo = new Uint16Array(n * 4), we = new Float32Array(n * 4);
  const p = [0, 0, 0], q = [0, 0, 0], ja = [0, 0, 0, 0], wa = [0, 0, 0, 0], t2 = [0, 0];
  for (let i = 0; i < n; i++) {
    P.getElement(i, p); N.getElement(i, q); J.getElement(i, ja); Wt.getElement(i, wa); UV.getElement(i, t2);
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, ws = 0;
    for (let k = 0; k < 4; k++) {
      const w = wa[k];
      if (!(w > 0)) continue;
      const m = jm[ja[k]], r = jn[ja[k]];
      x += w * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
      y += w * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
      z += w * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
      nx += w * (r[0] * q[0] + r[3] * q[1] + r[6] * q[2]);
      ny += w * (r[1] * q[0] + r[4] * q[1] + r[7] * q[2]);
      nz += w * (r[2] * q[0] + r[5] * q[1] + r[8] * q[2]);
      ws += w;
    }
    if (ws > 0) { x /= ws; y /= ws; z /= ws; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    nrm[i * 3] = nx / nl; nrm[i * 3 + 1] = ny / nl; nrm[i * 3 + 2] = nz / nl;
    uv[i * 2] = t2[0]; uv[i * 2 + 1] = t2[1];
    for (let k = 0; k < 4; k++) { jo[i * 4 + k] = ja[k]; we[i * 4 + k] = wa[k]; }
  }
  const idx = IX ? Uint32Array.from(/** @type {any} */ (IX.getArray())) : Uint32Array.from({ length: n }, (_, i) => i);
  return { pos, nrm, uv, idx, joints: jo, weights: we, jointNodes: joints, material: prim.getMaterial() };
}
