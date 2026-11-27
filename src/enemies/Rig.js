// @ts-check
/**
 * Rest-pose description of the soldier skeleton (pure; no three.js).
 *
 * Built once at load from the joint list (names, parents, rest local
 * translation and rotation: the GLB's bind pose) and the SoldierManifest. It
 * precomputes everything the procedural animator needs so the per-frame code
 * only multiplies quaternions:
 * - the 22 "core" bones the animator drives (pelvis … feet and toes), their
 *   rest model-space transforms, segment lengths and IK hinge frames;
 * - finger joints (curled round the rifle) and twist joints (share the wrist
 *   and shoulder roll so the skin does not candy-wrap);
 * - rifle points (grip, support, muzzle, butt, the eye point behind the sights).
 *
 * Model space = the soldier GLB's scene root: metres, feet at y = 0, facing +Z,
 * the soldier's left = +X. Bone rest frames follow UE conventions (each bone's
 * local X runs along it; left and right sides are mirrored), so the animator
 * never poses bones in their local axes: it composes rotations in model axes
 * (see Animator.js) and converts with `restModelQ`.
 */

import { Q, V3 } from './math.js';

/** Core bone indices. */
export const B = Object.freeze({
  pelvis: 0, spine1: 1, spine2: 2, spine3: 3, neck: 4, head: 5,
  clavL: 6, upperArmL: 7, lowerArmL: 8, handL: 9,
  clavR: 10, upperArmR: 11, lowerArmR: 12, handR: 13,
  thighL: 14, calfL: 15, footL: 16, ballL: 17,
  thighR: 18, calfR: 19, footR: 20, ballR: 21,
});
export const CORE_COUNT = 22;

/** Manifest joint key per core bone ('spine' entries and toes handled below). */
const CORE_KEYS = ['pelvis', 'spine.0', 'spine.1', 'spine.2', 'neck', 'head', 'clavL', 'upperArmL', 'lowerArmL', 'handL',
  'clavR', 'upperArmR', 'lowerArmR', 'handR', 'thighL', 'calfL', 'footL', 'ballL', 'thighR', 'calfR', 'footR', 'ballR'];

const FINGERS = ['index', 'middle', 'ring', 'pinky', 'thumb'];

/**
 * @typedef {{ name: string, parent: number, t: ArrayLike<number>, q: ArrayLike<number> }} JointDesc
 *   parent = index into the same list, or −1 (child of the model root)
 */

export class RigDef {
  /**
   * @param {JointDesc[]} joints the whole skeleton, any order
   * @param {any} manifest SoldierManifest (assets/manifest.json → soldier)
   */
  constructor(joints, manifest) {
    this.joints = joints;
    this.manifest = manifest;
    const byName = new Map();
    joints.forEach((j, i) => byName.set(j.name, i));
    /** @param {string} n */
    const need = (n) => {
      const i = byName.get(n);
      if (i === undefined) throw new Error(`RigDef: joint '${n}' not found`);
      return i;
    };
    const J = manifest.joints;
    const childOf = (/** @type {number} */ p, /** @type {(n: string) => boolean} */ f) => joints.findIndex((j) => j.parent === p && f(j.name));

    // rest model transforms of every joint (parents resolved recursively)
    const n = joints.length;
    /** @type {Q[]} */ this.jointModelQ = new Array(n);
    /** @type {V3[]} */ this.jointModelP = new Array(n);
    const done = new Uint8Array(n);
    const solve = (/** @type {number} */ i) => {
      if (done[i]) return;
      const j = joints[i];
      const lq = new Q(j.q[0], j.q[1], j.q[2], j.q[3]).normalize(), lt = new V3(j.t[0], j.t[1], j.t[2]);
      if (j.parent < 0) { this.jointModelQ[i] = lq; this.jointModelP[i] = lt; }
      else {
        solve(j.parent);
        const pq = this.jointModelQ[j.parent], pp = this.jointModelP[j.parent];
        this.jointModelQ[i] = new Q().mul(pq, lq);
        this.jointModelP[i] = lt.applyQ(pq).add(pp);
      }
      done[i] = 1;
    };
    for (let i = 0; i < n; i++) solve(i);

    // core bones
    /** @type {number[]} */ this.jointIndex = [];
    for (let k = 0; k < CORE_COUNT; k++) {
      const key = CORE_KEYS[k];
      let ji;
      if (key.startsWith('spine.')) ji = need(J.spine[Number(key.slice(6))]);
      else if (key === 'ballL' || key === 'ballR') {
        const foot = need(J[key === 'ballL' ? 'footL' : 'footR']);
        ji = childOf(foot, (nm) => !/twist/i.test(nm));
        if (ji < 0) throw new Error(`RigDef: no toe joint under ${joints[foot].name}`);
      } else ji = need(J[key]);
      this.jointIndex.push(ji);
    }
    if (J.spine.length !== 3) throw new Error('RigDef: expected 3 spine joints');
    /** Core parent (core index), −1 for the pelvis. */
    this.parent = this.jointIndex.map((ji) => this.jointIndex.indexOf(joints[ji].parent));
    for (let k = 1; k < CORE_COUNT; k++) if (this.parent[k] < 0) throw new Error(`RigDef: parent of ${joints[this.jointIndex[k]].name} is not a core bone`);
    const pj = joints[this.jointIndex[B.pelvis]].parent;
    /** Model transform of the pelvis's parent (fixed: root joints are never animated). */
    this.baseQ = pj >= 0 ? this.jointModelQ[pj] : new Q();
    this.baseP = pj >= 0 ? this.jointModelP[pj] : new V3();

    this.names = this.jointIndex.map((ji) => joints[ji].name);
    this.restLocalT = this.jointIndex.map((ji) => new V3(joints[ji].t[0], joints[ji].t[1], joints[ji].t[2]));
    this.restLocalQ = this.jointIndex.map((ji) => new Q(joints[ji].q[0], joints[ji].q[1], joints[ji].q[2], joints[ji].q[3]).normalize());
    this.restModelQ = this.jointIndex.map((ji) => this.jointModelQ[ji]);
    this.restModelP = this.jointIndex.map((ji) => this.jointModelP[ji]);

    const P = this.restModelP;
    const dist = (/** @type {number} */ a, /** @type {number} */ b) => P[a].distanceTo(P[b]);
    this.len = {
      upperArm: dist(B.upperArmL, B.lowerArmL), foreArm: dist(B.lowerArmL, B.handL),
      thigh: dist(B.thighL, B.calfL), calf: dist(B.calfL, B.footL),
    };
    /** Rest pelvis height and the ankle height above the floor. */
    this.pelvisY = P[B.pelvis].y;
    this.ankleY = (P[B.footL].y + P[B.footR].y) / 2;
    this.hipHalfWidth = Math.abs(P[B.thighL].x - P[B.thighR].x) / 2;
    /** Ball (toe joint) relative to the ankle in a yaw-aligned foot frame (+Z forward). */
    this.ballOffset = new V3().subVectors(P[B.ballL], P[B.footL]);
    this.ballOffset.x = 0;

    // IK rest frames. Arms: the rest elbow bend defines the hinge. Legs: the rest
    // knees are almost straight, so the hinge is the lateral axis (+X).
    /** @param {number} u @param {number} l */
    const axis = (u, l) => new V3().subVectors(P[l], P[u]).normalize();
    /** @type {{ upper: number, lower: number, end: number, axisU: V3, axisL: V3, hinge: V3, a: number, b: number }[]} */
    this.chains = [];
    for (const [u, l, e, leg] of /** @type {[number, number, number, boolean][]} */ ([
      [B.upperArmL, B.lowerArmL, B.handL, false], [B.upperArmR, B.lowerArmR, B.handR, false],
      [B.thighL, B.calfL, B.footL, true], [B.thighR, B.calfR, B.footR, true]])) {
      const axisU = axis(u, l), axisL = axis(l, e);
      const hinge = leg ? new V3(1, 0, 0).rejectFrom(axisU).normalize() : new V3().cross(axisU, axisL).normalize();
      this.chains.push({ upper: u, lower: l, end: e, axisU, axisL, hinge, a: dist(u, l), b: dist(l, e) });
    }

    // fingers: three joints each under both hands; curl = rotation about the joint's local Z
    /** @type {{ joint: number, hand: number, finger: number, seg: number, restQ: Q }[]} */
    this.fingers = [];
    for (let h = 0; h < 2; h++) {
      const hand = this.jointIndex[h === 0 ? B.handL : B.handR];
      for (let f = 0; f < FINGERS.length; f++) {
        let j = childOf(hand, (nm) => nm.toLowerCase().startsWith(FINGERS[f]));
        for (let seg = 0; seg < 3 && j >= 0; seg++) {
          const jd = joints[j];
          this.fingers.push({ joint: j, hand: h, finger: f, seg, restQ: new Q(jd.q[0], jd.q[1], jd.q[2], jd.q[3]).normalize() });
          j = childOf(j, () => true);
        }
      }
    }

    // twist joints (children of upper arm, forearm, thigh, calf whose name says twist)
    /** @type {{ joint: number, bone: number, distal: number, k: number, restQ: Q }[]} */
    this.twists = [];
    for (const [bone, distal, k] of /** @type {[number, number, number][]} */ ([
      [B.upperArmL, B.upperArmL, -0.5], [B.upperArmR, B.upperArmR, -0.5], [B.lowerArmL, B.handL, 0.5], [B.lowerArmR, B.handR, 0.5],
      [B.thighL, B.thighL, -0.5], [B.thighR, B.thighR, -0.5], [B.calfL, B.footL, 0.5], [B.calfR, B.footR, 0.5]])) {
      const j = childOf(this.jointIndex[bone], (nm) => /twist/i.test(nm));
      if (j < 0) continue;
      const jd = joints[j];
      this.twists.push({ joint: j, bone, distal, k, restQ: new Q(jd.q[0], jd.q[1], jd.q[2], jd.q[3]).normalize() });
    }

    // rifle (rifle space = AKM gun space: −Z muzzle, +Y up, origin at the breech face)
    const rih = manifest.rifleInHand;
    this.rifle = {
      inHandP: new V3(rih.pos[0], rih.pos[1], rih.pos[2]),
      inHandQ: new Q(rih.quat[0], rih.quat[1], rih.quat[2], rih.quat[3]).normalize(),
      support: new V3(manifest.rifleSupport[0], manifest.rifleSupport[1], manifest.rifleSupport[2]),
      muzzle: new V3(manifest.rifleMuzzle[0], manifest.rifleMuzzle[1], manifest.rifleMuzzle[2]),
      /** Butt plate centre (the baked AKM: stock end at z 0.455, plate y −0.095…0). */
      butt: new V3(0, -0.045, 0.45),
      /** The shooter's eye behind the sights: on the comb, 5.5 cm over the bore. */
      eye: new V3(0, 0.058, 0.25),
    };
    /** Rest model transform of the rifle (= hand_r rest ∘ rifleInHand). */
    const hq = this.restModelQ[B.handR], hp = this.restModelP[B.handR];
    this.rifleRestQ = new Q().mul(hq, this.rifle.inHandQ);
    this.rifleRestP = new V3().copy(this.rifle.inHandP).applyQ(hq).add(hp);

    /** Rest ankle z (the ankle sits behind the hips' plumb line). */
    this.ankleZ = (P[B.footL].z + P[B.footR].z) / 2;
    /** Rest finger direction (wrist → middle knuckle) and palm normal per hand [left, right]. */
    /** @type {V3[]} */ this.handF = [];
    /** @type {V3[]} */ this.handN = [];
    for (let h = 0; h < 2; h++) {
      const wrist = P[h === 0 ? B.handL : B.handR];
      const pick = (/** @type {number} */ finger) => this.fingers.find((f) => f.hand === h && f.finger === finger && f.seg === 0);
      const mid = pick(1), idx = pick(0), pin = pick(3);
      if (!mid || !idx || !pin) throw new Error('RigDef: hand without index, middle and pinky joints');
      const F = new V3().subVectors(this.jointModelP[mid.joint], wrist).normalize();
      const S = new V3().subVectors(this.jointModelP[idx.joint], this.jointModelP[pin.joint]).normalize();
      // palm normal: for the left hand F × S points out of the palm; the right hand is mirrored
      const N = new V3().cross(F, S).normalize();
      if (h === 1) N.scale(-1);
      this.handF.push(F);
      this.handN.push(N.rejectFrom(F).normalize());
    }

    // eyes: the right eye relative to the head joint, in the rest model frame
    this.height = manifest.height || 1.87;
    this.eyeR = new V3(-0.032, this.height - 0.135, 0.085).sub(P[B.head]);
    this.eyeL = new V3(0.032, this.height - 0.135, 0.085).sub(P[B.head]);
  }
}

/**
 * Joint list from a GLB's JSON (nodes of its first skin), for Node tests and tools.
 * @param {any} gltf parsed glTF JSON
 * @returns {JointDesc[]}
 */
export function jointsFromGltfJson(gltf) {
  const skin = gltf.skins[0];
  const nodes = gltf.nodes;
  const ids = skin.joints;
  const parentOf = new Map();
  nodes.forEach((nd, i) => (nd.children || []).forEach((c) => parentOf.set(c, i)));
  return ids.map((/** @type {number} */ id) => {
    const nd = nodes[id];
    const p = parentOf.get(id);
    return { name: nd.name, parent: p === undefined ? -1 : ids.indexOf(p), t: nd.translation || [0, 0, 0], q: nd.rotation || [0, 0, 0, 1] };
  });
}
