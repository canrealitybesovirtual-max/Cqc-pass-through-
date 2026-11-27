// @ts-check
/**
 * The game world built from the user's Space Setup (CONTRACTS.md "World").
 *
 * WorldCore (pure) holds the layout, shapes, nav grid and spawn finder; this
 * class adds the ONE merged depth-only occluder mesh. The mesh, its material
 * and fixed-capacity buffers exist from construction (at load), so the warm-up
 * draw compiles its program and uploads its buffers; build() only rewrites the
 * buffer contents and the draw range.
 *
 * Integration: `scene.add(world.occluder)` at load, before the warm-up.
 */

import * as THREE from 'three';
import { WorldCore } from './WorldCore.js';
import { OCC_INDICES_PER_BOX, OCC_VERTS_PER_BOX, writeOccluderBoxes } from './Occluder.js';

export { captureSnapshot, loadFixture, normalizeSnapshot, CaptureGate } from './Snapshot.js';
export { NavGrid } from './NavGrid.js';
export { PathPlanner, PATH_PENDING, PATH_FAILED } from './PathPlanner.js';

export class World extends WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number, maxOccluderBoxes?: number }} [o]
   */
  constructor(o = {}) {
    super(o);
    this.maxOccluderBoxes = o.maxOccluderBoxes ?? 256;
    const pos = new Float32Array(this.maxOccluderBoxes * OCC_VERTS_PER_BOX * 3);
    const idx = new Uint16Array(this.maxOccluderBoxes * OCC_INDICES_PER_BOX);
    const geo = new THREE.BufferGeometry();
    this.occPos = new THREE.BufferAttribute(pos, 3);
    this.occIdx = new THREE.BufferAttribute(idx, 1);
    geo.setAttribute('position', this.occPos);
    geo.setIndex(this.occIdx);
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
    mat.name = 'world-occluder';
    /** Depth-only stand-ins for real walls and furniture: hides enemies behind them. */
    this.occluder = new THREE.Mesh(geo, mat);
    this.occluder.name = 'world-occluder';
    this.occluder.renderOrder = -10;
    this.occluder.frustumCulled = false; // spans the house; also keeps the pre-build warm-up draw
    this.occluder.matrixAutoUpdate = false;
    this.occluderBoxes = 0;
    this.placeholder();
  }

  /**
   * Until a real build: one degenerate box far below the floor, visible, so the
   * warm-up draw compiles the occluder's program and uploads its buffers.
   */
  placeholder() {
    const pos = /** @type {Float32Array} */ (this.occPos.array), idx = /** @type {Uint16Array} */ (this.occIdx.array);
    for (let i = 0; i < OCC_VERTS_PER_BOX; i++) { pos[i * 3] = 0; pos[i * 3 + 1] = -100; pos[i * 3 + 2] = 0; }
    for (let i = 0; i < OCC_INDICES_PER_BOX; i++) idx[i] = i % OCC_VERTS_PER_BOX;
    this.occluder.geometry.setDrawRange(0, OCC_INDICES_PER_BOX);
    this.occPos.needsUpdate = true;
    this.occIdx.needsUpdate = true;
    this.occluder.visible = true;
    this.occluderBoxes = 0;
  }

  /** WorldCore.warmUp, then back to the drawable placeholder. */
  warmUp() {
    super.warmUp();
    this.placeholder();
  }

  /**
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart
   */
  build(snapshot, playerStart) {
    super.build(snapshot, playerStart);
    const boxes = this.layout ? this.layout.boxes : [];
    const pos = /** @type {Float32Array} */ (this.occPos.array), idx = /** @type {Uint16Array} */ (this.occIdx.array);
    const n = writeOccluderBoxes(boxes, pos, idx, this.maxOccluderBoxes);
    if (boxes.length > n) this.stats.notes.push(`occluder holds ${n} of ${boxes.length} boxes`);
    this.occluderBoxes = n;
    const geo = this.occluder.geometry;
    geo.setDrawRange(0, n * OCC_INDICES_PER_BOX);
    this.occPos.needsUpdate = true;
    this.occIdx.needsUpdate = true;
    this.occluder.visible = n > 0;
    if (n > 0) {
      // Bounds over the written vertices only (the buffer tail holds stale data).
      const box = geo.boundingBox || (geo.boundingBox = new THREE.Box3());
      box.makeEmpty();
      const v = new THREE.Vector3();
      for (let i = 0; i < n * OCC_VERTS_PER_BOX; i++) box.expandByPoint(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      const sphere = geo.boundingSphere || (geo.boundingSphere = new THREE.Sphere());
      box.getBoundingSphere(sphere);
    }
  }
}
