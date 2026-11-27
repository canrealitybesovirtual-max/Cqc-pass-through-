// @ts-check
/**
 * Prebuilt enemy instances (three.js side). Every soldier is cloned at load
 * with SkeletonUtils.clone, so nothing is cloned, skinned or bound during a
 * fight (PLAN §9). Geometry and materials are shared by all instances; each
 * has its own skeleton. Two draws per enemy: the skinned body and the rifle.
 *
 * The rifle is moved from under the right-hand joint to the instance root at
 * build time: the animator solves the right hand onto the rifle's grip (and
 * places the rifle where that hand actually got to), so while he is alive it
 * sits in his hand exactly as the GLB parented it, and when he dies it can
 * leave the hand and fall on its own.
 *
 * Culling: one bounding sphere per body, centred on the pelvis every pose
 * update (never the bind-pose bounds: CQC's standing bounds made fallen bodies
 * vanish).
 */

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { B, CORE_COUNT, RigDef } from './Rig.js';

/** Radius of the culling sphere round the pelvis: head, feet and rifle in any pose. */
export const BODY_RADIUS = 1.25;

/**
 * A three Quaternion's components from {x, y, z, w}, without its onChange hook (the Euler sync).
 * @param {THREE.Quaternion} t @param {{ x: number, y: number, z: number, w: number }} q
 */
function setQ(t, q) {
  const o = /** @type {any} */ (t);
  o._x = q.x; o._y = q.y; o._z = q.z; o._w = q.w;
}

/**
 * Joint list of a skeleton for RigDef (rest = the loaded bind pose).
 * @param {THREE.Skeleton} skeleton
 * @returns {import('./Rig.js').JointDesc[]}
 */
export function jointsFromSkeleton(skeleton) {
  const bones = skeleton.bones;
  return bones.map((b) => ({
    name: b.name,
    parent: bones.indexOf(/** @type {any} */ (b.parent)),
    t: [b.position.x, b.position.y, b.position.z],
    q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
  }));
}

export class EnemyRig {
  /**
   * @param {{ scene: THREE.Group, mesh: THREE.SkinnedMesh, rifle: THREE.Mesh }} model assets.models.soldier
   * @param {RigDef} def
   * @param {number} index
   */
  constructor(model, def, index) {
    const root = /** @type {THREE.Group} */ (cloneSkinned(model.scene));
    root.name = `enemy-${index}`;
    /** @type {THREE.SkinnedMesh|null} */
    let mesh = null;
    root.traverse((o) => { if (!mesh && /** @type {any} */ (o).isSkinnedMesh) mesh = /** @type {any} */ (o); });
    const rifle = /** @type {THREE.Mesh|undefined} */ (root.getObjectByName(model.rifle.name || 'rifle'));
    if (!mesh || !rifle) throw new Error('EnemyRig: clone has no SkinnedMesh or rifle');
    this.root = root;
    /** @type {THREE.SkinnedMesh} */ this.mesh = mesh;
    this.rifle = rifle;
    root.add(rifle); // see the file comment
    rifle.name = `enemy-${index}-rifle`;
    mesh.name = `enemy-${index}-body`;

    const byName = new Map();
    for (const b of mesh.skeleton.bones) byName.set(b.name, b);
    const bone = (/** @type {string} */ n) => {
      const b = byName.get(n);
      if (!b) throw new Error(`EnemyRig: bone ${n} missing in the clone`);
      return b;
    };
    /** @type {THREE.Bone[]} */ this.core = def.names.map(bone);
    /** @type {THREE.Bone[]} */ this.fingers = def.fingers.map((f) => bone(def.joints[f.joint].name));
    /** @type {THREE.Bone[]} */ this.twists = def.twists.map((t) => bone(def.joints[t.joint].name));

    // culling: a sphere that follows the pelvis (in the mesh's space = model space)
    this.sphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), BODY_RADIUS);
    /** @type {any} */ (mesh).boundingSphere = this.sphere;
    mesh.frustumCulled = true;
    rifle.frustumCulled = true;
    root.visible = false;
  }

  /**
   * Root pose in the world: (x, floor y, z), yaw about +Y (0 = facing +Z).
   * @param {number} x @param {number} y @param {number} z @param {number} yaw
   */
  setRoot(x, y, z, yaw) {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, yaw, 0);
  }

  /**
   * Body scale about the root (v0.4.1: each soldier 1.70–1.85 m; the model is 1.868 m). The bones, the
   * skinned body, the rifle and the culling sphere are under the root, so one uniform scale sizes all of
   * them; a scale is a matrix uniform, not part of any program key. At spawn only.
   * @param {number} k
   */
  setScale(k) {
    this.root.scale.set(k, k, k);
  }

  /**
   * Copy a solved pose onto the bones and the rifle.
   * @param {import('./Animator.js').Animator} a
   */
  apply(a) {
    // Quaternion components are written directly (v0.4 verifier): Quaternion.set() also runs three's
    // onChange hook, which re-derives each bone's Euler `rotation` (a matrix and an asin per bone, read
    // by nothing here), and in the browser that call chain boxed about 3 KB of numbers per soldier per
    // frame. The bones' matrices are composed from `quaternion` as before.
    const core = this.core;
    for (let b = 0; b < CORE_COUNT; b++) setQ(core[b].quaternion, a.lq[b]);
    const p = a.pelvisLocal;
    core[B.pelvis].position.set(p.x, p.y, p.z);
    for (let i = 0; i < this.fingers.length; i++) setQ(this.fingers[i].quaternion, a.fingerQ[i]);
    for (let i = 0; i < this.twists.length; i++) setQ(this.twists[i].quaternion, a.twistQ[i]);
    this.rifle.position.set(a.rifleP.x, a.rifleP.y, a.rifleP.z);
    setQ(this.rifle.quaternion, a.rifleQ);
    const pc = a.mp[B.pelvis];
    this.sphere.center.set(pc.x, pc.y, pc.z);
  }
}

export class EnemyPool {
  /**
   * @param {{ scene: THREE.Group, mesh: THREE.SkinnedMesh, rifle: THREE.Mesh, manifest: any }} model assets.models.soldier
   * @param {number} n instances
   */
  constructor(model, n) {
    this.def = new RigDef(jointsFromSkeleton(model.mesh.skeleton), model.manifest);
    /** @type {EnemyRig[]} */
    this.rigs = [];
    for (let i = 0; i < n; i++) this.rigs.push(new EnemyRig(model, this.def, i));
  }
}
