// @ts-check
/**
 * Loose magazines lying in the real house as physics items (pure: no three.js
 * import; it writes the instance matrices of one InstancedMesh per weapon,
 * built and warmed by WeaponFX at load). Research spec §7 "Magazines":
 *
 * - one pool per weapon of 10 (one instanced draw each; instance i ↔ slot i,
 *   a free slot is a zero matrix). Each magazine carries its rounds: a
 *   magazine dropped with 9 rounds and picked up again still has 9;
 * - when a pool is full, the oldest magazine that is out of view is recycled
 *   (more than 70° from the view direction, over 5 m away, or behind a wall),
 *   else the oldest asleep one, else the oldest. Recycling removes its body
 *   and hides its instance: nothing ever pops in front of the player;
 * - landing and bounce sounds by the CQC thresholds (soft surfaces thud
 *   quietly), at most one per magazine every 0.12 s.
 *
 * Per frame `sync` reads only magazines that moved (PhysicsWorld.readPose),
 * so a pool at rest costs a loop over 10 slots and nothing else.
 */

import { ST_LOST, ST_FREE, ST_RESTING } from '../physics/PhysicsWorld.js';
import { ITEMS, landingClass, landingGain, LAND_NONE } from '../physics/ItemRules.js';
import { SURF } from '../physics/StaticGeometry.js';

export const LOOSE = Object.freeze({
  perWeapon: 10,
  viewCos: Math.cos((70 * Math.PI) / 180),
  farM: 5,
});

export class LooseMags {
  /**
   * @param {{ instanceMatrix: { array: ArrayLike<number> & { [i: number]: number }, needsUpdate: boolean }, count: number, visible: boolean }} mesh
   * @param {number} n instances (≤ the mesh's capacity)
   * @param {number} kind PhysicsWorld kind of this magazine
   * @param {string} [sound] hard-surface landing sound key
   */
  constructor(mesh, n, kind, sound = 'magDrop') {
    this.mesh = mesh;
    this.n = n;
    this.kind = kind;
    this.sound = sound;
    this.id = new Int32Array(n).fill(-1);
    this.rounds = new Int16Array(n);
    this.seq = new Float64Array(n);
    this.lastSound = new Float64Array(n).fill(-1);
    this._seq = 0;
    /** Live magazines. */
    this.count = 0;
    /** Distance of the last `nearest` hit (m). */
    this.lastD = Infinity;
    this.recycled = 0;
    this.lost = 0;
    this._p = new Float64Array(7);
    const e = mesh.instanceMatrix.array;
    for (let i = 0; i < n * 16; i++) e[i] = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A free slot for a new magazine; when full, recycles one (see the header).
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} phys
   * @param {{ x: number, y: number, z: number } | null} head @param {{ x: number, y: number, z: number } | null} fwd unit view direction
   * @param {{ segmentClear?: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean } | null} world
   * @returns {number} slot
   */
  room(phys, head, fwd, world) {
    for (let i = 0; i < this.n; i++) if (this.id[i] < 0) return i;
    let out = -1, outSeq = Infinity, rest = -1, restSeq = Infinity, old = 0, oldSeq = Infinity;
    const p = this._p;
    for (let i = 0; i < this.n; i++) {
      const s = this.seq[i];
      if (s < oldSeq) { oldSeq = s; old = i; }
      const id = this.id[i];
      if (phys.state(id) === ST_RESTING && s < restSeq) { restSeq = s; rest = i; }
      if (head && fwd && phys.pose(id, p, 0)) {
        const dx = p[0] - head.x, dy = p[1] - head.y, dz = p[2] - head.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const hidden = d > LOOSE.farM || (d > 1e-6 && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < LOOSE.viewCos)
          || (!!world && typeof world.segmentClear === 'function' && !world.segmentClear(head.x, head.y, head.z, p[0], p[1], p[2]));
        if (hidden && s < outSeq) { outSeq = s; out = i; }
      }
    }
    const i = out >= 0 ? out : rest >= 0 ? rest : old;
    this.drop(phys, i);
    this.recycled++;
    return i;
  }

  /**
   * Track a spawned magazine in `slot` (its instance shows at its pose at once).
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} phys @param {number} slot @param {number} id @param {number} rounds
   */
  add(phys, slot, id, rounds) {
    if (this.id[slot] >= 0) this.drop(phys, slot);
    this.id[slot] = id;
    this.rounds[slot] = rounds;
    this.seq[slot] = ++this._seq;
    this.lastSound[slot] = -1;
    this.count++;
    if (phys.pose(id, this._p, 0)) this._write(slot, this._p);
    this.mesh.count = this.n;
    this.mesh.visible = true;
  }

  /**
   * Per frame: draw the magazines that moved, play their landing sounds, drop lost ones.
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} phys
   * @param {number} now seconds
   * @param {{ play?: (key: string, x: number, y: number, z: number, gain?: number, rate?: number) => number } | null} audio
   */
  sync(phys, now, audio) {
    if (this.count === 0) return;
    const p = this._p;
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      const id = this.id[i];
      if (id < 0) continue;
      const s = phys.state(id);
      if (s === ST_LOST || s === ST_FREE) { this.drop(phys, i); this.lost++; continue; }
      if (phys.readPose(id, p, 0)) { this._write(i, p); dirty = true; }
      const dv = phys.landing(id);
      if (landingClass(dv) !== LAND_NONE && now - this.lastSound[i] >= ITEMS.soundGapS && audio && audio.play) {
        this.lastSound[i] = now;
        const g = landingGain(dv);
        phys.pose(id, p, 0);
        if (phys.landSurf(id) === SURF.SOFT) audio.play('cloth', p[0], p[1], p[2], 0.35 * g, 1.15);
        else audio.play(this.sound, p[0], p[1], p[2], g, 1);
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The loose magazine nearest to a hand (its box or centre within `reach`): slot, or -1.
   * `lastD` gets its distance.
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} phys
   * @param {number} x @param {number} y @param {number} z @param {number} reach
   */
  nearest(phys, x, y, z, reach) {
    this.lastD = Infinity;
    if (this.count === 0) return -1;
    const kinds = phys.kinds, K = kinds[this.kind];
    if (!K) return -1;
    const p = this._p;
    let best = -1, bestD = reach;
    for (let i = 0; i < this.n; i++) {
      const id = this.id[i];
      if (id < 0 || !phys.pose(id, p, 0)) continue;
      // hand in magazine space: q⁻¹ (h − t)
      const qx = p[3], qy = p[4], qz = p[5], qw = p[6];
      const px = x - p[0], py = y - p[1], pz = z - p[2];
      const tx = 2 * (-qy * pz + qz * py), ty = 2 * (-qz * px + qx * pz), tz = 2 * (-qx * py + qy * px);
      const lx = px + qw * tx + (-qy * tz + qz * ty), ly = py + qw * ty + (-qz * tx + qx * tz), lz = pz + qw * tz + (-qx * ty + qy * tx);
      const c = K.centre, h = K.half;
      let ex = Math.abs(lx - c[0]) - h[0], ey = Math.abs(ly - c[1]) - h[1], ez = Math.abs(lz - c[2]) - h[2];
      ex = ex > 0 ? ex : 0; ey = ey > 0 ? ey : 0; ez = ez > 0 ? ez : 0;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d <= bestD) { bestD = d; best = i; }
    }
    if (best >= 0) this.lastD = bestD;
    return best;
  }

  /**
   * Take a magazine into the hand: its pose into out7, its body removed, its instance hidden.
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} phys @param {number} slot
   * @param {Float64Array} out7
   * @returns {number} its rounds (-1 for an empty slot)
   */
  take(phys, slot, out7) {
    const id = this.id[slot];
    if (id < 0) return -1;
    phys.pose(id, out7, 0);
    const r = this.rounds[slot];
    this.drop(phys, slot);
    return r;
  }

  /**
   * Forget a slot: remove its body (when the physics still works) and hide its instance.
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld|null} phys @param {number} slot
   */
  drop(phys, slot) {
    const id = this.id[slot];
    if (id < 0) return;
    if (phys && !phys.failed) phys.remove(id);
    this.id[slot] = -1;
    this.count--;
    const e = this.mesh.instanceMatrix.array, k = slot * 16;
    for (let j = 0; j < 16; j++) e[k + j] = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.count === 0) this.mesh.visible = false;
  }

  /** Every magazine gone (new round, or the physics failed). @param {import('../physics/PhysicsWorld.js').PhysicsWorld|null} phys */
  clear(phys) { for (let i = 0; i < this.n; i++) this.drop(phys, i); }

  /** @param {number} i @param {Float64Array} p */
  _write(i, p) {
    const e = this.mesh.instanceMatrix.array, k = i * 16;
    const x = p[3], y = p[4], z = p[5], w = p[6];
    const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    e[k] = 1 - (yy + zz); e[k + 1] = xy + wz; e[k + 2] = xz - wy; e[k + 3] = 0;
    e[k + 4] = xy - wz; e[k + 5] = 1 - (xx + zz); e[k + 6] = yz + wx; e[k + 7] = 0;
    e[k + 8] = xz + wy; e[k + 9] = yz - wx; e[k + 10] = 1 - (xx + yy); e[k + 11] = 0;
    e[k + 12] = p[0]; e[k + 13] = p[1]; e[k + 14] = p[2]; e[k + 15] = 1;
  }
}
