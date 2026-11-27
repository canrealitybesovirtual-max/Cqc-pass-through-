// @ts-check
import * as THREE from 'three';
import { OUTLINE_VERTS, OBSTACLE, writeOutlines } from './ObstacleWarnings.js';

/**
 * The safety visuals, all created at construction (so the warm-up compiles
 * them and nothing is created or compiled later):
 * - `outline`: ONE LineSegments with a fixed vertex capacity (4 boxes × 24),
 *   rewritten in place (DynamicDrawUsage, draw range) when ObstacleWarnings'
 *   outline list changes. Always on top (depthTest off), never transparent-
 *   toggled;
 * - `arrow`: one flat floor arrow (3 triangles), for "step this way" before a
 *   round (SafeSpot) and "back to your spot" while paused (replaces a
 *   head-locked panel, gap audit S8). Colour, opacity, pose and scale only;
 * - `veil`: a Group at the origin (identity, never moved). Enemies and effects
 *   are re-parented under it once at load (`adopt`), so hiding them during a
 *   pause is one `visible` flag that their owners never touch. Lights are
 *   never adopted (hiding a light changes every program key).
 */

const COL_HAND = 0xffb02e;
const COL_HEAD = 0xff3b30;
const ARROW_LEN = 0.35;

export const ARROW_COL = Object.freeze({ step: 0xffb02e, back: 0xffffff, ok: 0x4cd964 });

export class SafetyView {
  /** @param {{ maxOutlines?: number }} [o] */
  constructor({ maxOutlines = OBSTACLE.maxOutlines } = {}) {
    this.maxVerts = maxOutlines * OUTLINE_VERTS;
    const pos = new Float32Array(this.maxVerts * 3);
    this.outlinePos = new THREE.BufferAttribute(pos, 3);
    this.outlinePos.setUsage(THREE.DynamicDrawUsage);
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', this.outlinePos);
    og.setDrawRange(0, 0);
    og.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const om = new THREE.LineBasicMaterial({ color: COL_HAND, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
    om.name = 'safety-outline';
    this.outline = new THREE.LineSegments(og, om);
    this.outline.name = 'safety-outline';
    this.outline.renderOrder = 56;
    this.outline.frustumCulled = false;
    this.outline.matrixAutoUpdate = false;
    this.outline.visible = false;
    this.outlineVersion = -1;
    this.outlineVerts = 0;
    /** @type {number} */ this._outlineCol = COL_HAND;

    const am = new THREE.MeshBasicMaterial({ color: ARROW_COL.back, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    am.name = 'safety-arrow';
    this.arrow = new THREE.Mesh(arrowGeometry(), am);
    this.arrow.name = 'safety-arrow';
    this.arrow.renderOrder = 6;
    this.arrow.frustumCulled = false;
    this.arrow.visible = false;
    /** @type {number} */ this._arrowCol = ARROW_COL.back;

    this.veil = new THREE.Group();
    this.veil.name = 'safety-veil';
    /** Objects adopted into the veil. @type {THREE.Object3D[]} */
    this.adopted = [];
    /** @type {string[]} */ this.notes = [];
  }

  /** @param {THREE.Object3D} scene */
  addTo(scene) { scene.add(this.outline, this.arrow, this.veil); }

  /** Meshes for the warm-up draw. */
  warmMeshes() { return [this.outline, this.arrow]; }

  /**
   * Show both for the warm-up draw (one box outline and the arrow in front of
   * the camera), then hide them again.
   * @param {boolean} on @param {any} [cam]
   */
  setWarm(on, cam) {
    if (on) {
      const p = cam && cam.position ? cam.position : { x: 0, y: 1.6, z: 0 };
      const a = /** @type {Float32Array} */ (this.outlinePos.array);
      // a 20 cm square 1 m ahead (-z) of the camera
      const x = p.x, y = p.y, z = p.z - 1, h = 0.1;
      const sq = [x - h, y - h, z, x + h, y - h, z, x + h, y - h, z, x + h, y + h, z, x + h, y + h, z, x - h, y + h, z, x - h, y + h, z, x - h, y - h, z];
      for (let i = 0; i < sq.length; i++) a[i] = sq[i];
      this.outline.geometry.setDrawRange(0, 8);
      this.outlinePos.needsUpdate = true;
      this.outlineVersion = -1;
      this.arrow.position.set(x, y - 0.3, z);
      this.arrow.rotation.set(0, 0, 0);
      this.arrow.scale.set(ARROW_LEN, 1, ARROW_LEN);
      /** @type {THREE.MeshBasicMaterial} */ (this.arrow.material).opacity = 0.9;
    } else {
      this.outline.geometry.setDrawRange(0, 0);
      this.outlineVerts = 0;
      this.outlineVersion = -1;
      /** @type {THREE.MeshBasicMaterial} */ (this.arrow.material).opacity = 0;
    }
    this.outline.visible = on;
    this.arrow.visible = on;
  }

  /**
   * Re-parent enemies and effects under the veil (once, at load). Only
   * objects whose parent is a Scene (or none) are taken, so world transforms
   * are unchanged; anything holding a light is skipped.
   * @param {ArrayLike<THREE.Object3D>|null|undefined} objects
   * @returns {number} adopted
   */
  adopt(objects) {
    if (!objects) return 0;
    let n = 0;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      if (!o || o === this.veil || this.adopted.includes(o)) continue;
      const parent = o.parent;
      if (parent && !(/** @type {any} */ (parent).isScene)) { this.notes.push(`veil: ${o.name || o.type} skipped (parent ${parent.name || parent.type})`); continue; }
      let light = false;
      o.traverse((c) => { if (/** @type {any} */ (c).isLight) light = true; });
      if (light) { this.notes.push(`veil: ${o.name || o.type} skipped (holds a light)`); continue; }
      this.veil.add(o);
      this.adopted.push(o);
      n++;
    }
    return n;
  }

  /** Hide (or show) everything under the veil. @param {boolean} hidden */
  setHidden(hidden) { this.veil.visible = !hidden; }

  get hidden() { return !this.veil.visible; }

  /**
   * Rewrite the outline from ObstacleWarnings when its list changed.
   * @param {import('./ObstacleWarnings.js').ObstacleWarnings} ow
   * @param {{ box: Float32Array, count: number, label?: string[] }|null|undefined} shapes
   * @param {((x: number, z: number) => number)|null} floorY
   */
  updateOutline(ow, shapes, floorY) {
    if (!shapes || ow.count === 0) {
      this.outline.visible = false;
      return;
    }
    if (ow.version !== this.outlineVersion) {
      this.outlineVersion = ow.version;
      const pos = /** @type {Float32Array} */ (this.outlinePos.array);
      this.outlineVerts = writeOutlines(pos, ow, shapes, floorY);
      this.outline.geometry.setDrawRange(0, this.outlineVerts);
      this.outlinePos.needsUpdate = true;
      const col = ow.headNear ? COL_HEAD : COL_HAND;
      if (col !== this._outlineCol) {
        this._outlineCol = col;
        /** @type {THREE.LineBasicMaterial} */ (this.outline.material).color.setHex(col);
      }
    }
    this.outline.visible = this.outlineVerts > 0;
  }

  /**
   * Lay the arrow on the floor: its tail at (x, y, z) pointing along (dx, dz).
   * @param {number} x @param {number} y floor height @param {number} z
   * @param {number} dx @param {number} dz direction (any length > 0)
   * @param {number} color @param {number} opacity
   * @param {number} [len] metres
   */
  showArrow(x, y, z, dx, dz, color, opacity, len = ARROW_LEN) {
    const l = Math.sqrt(dx * dx + dz * dz);
    if (!(l > 1e-6) || !(opacity > 0.01)) { this.hideArrow(); return; }
    const a = this.arrow;
    a.position.set(x, y + 0.012, z);
    a.rotation.set(0, Math.atan2(dx / l, dz / l), 0);
    a.scale.set(len, 1, len);
    const m = /** @type {THREE.MeshBasicMaterial} */ (a.material);
    if (color !== this._arrowCol) { m.color.setHex(color); this._arrowCol = color; }
    m.opacity = opacity;
    a.visible = true;
  }

  hideArrow() { this.arrow.visible = false; }

  /** Session over: nothing shown, the veil open. */
  reset() {
    this.outline.visible = false;
    this.outline.geometry.setDrawRange(0, 0);
    this.outlineVerts = 0;
    this.outlineVersion = -1;
    this.arrow.visible = false;
    this.veil.visible = true;
  }
}

/**
 * A flat arrow on the floor, unit length along local +Z (tail at the origin),
 * facing up (+Y normals, counter-clockwise from above): a shaft and a head.
 */
export function arrowGeometry() {
  const sw = 0.09, hw = 0.25, sl = 0.6;
  // x, y, z
  const P = new Float32Array([
    -sw, 0, 0, sw, 0, 0, sw, 0, sl, -sw, 0, sl, // shaft 0..3
    -hw, 0, sl, hw, 0, sl, 0, 0, 1, // head 4..6
  ]);
  // CCW seen from +Y: (a, b, c) with (b − a) × (c − a) pointing +Y
  const I = [0, 2, 1, 0, 3, 2, 4, 6, 5];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
