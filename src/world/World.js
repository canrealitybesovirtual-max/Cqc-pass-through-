// @ts-check
/**
 * The game world built from the user's Space Setup (CONTRACTS.md "World").
 *
 * WorldCore (pure) holds the layout, shapes, nav grid and spawn finder; this
 * class adds the ONE merged depth-only occluder mesh and a dev overlay (ONE
 * LineSegments of the occluder's box edges, door frames and spawn pockets,
 * hidden by default). Both meshes, their materials and fixed-capacity buffers
 * exist from construction (at load), so the warm-up draw compiles their
 * programs and uploads their buffers; build() only rewrites the buffer
 * contents and the draw ranges (uploaded by the next draw: warmXR after build).
 *
 * Integration: `scene.add(...world.warmMeshes())` at load, before the warm-up,
 * and include `world.warmMeshes()` in the warm-up and warmXR object lists.
 * `world.setOverlay(true)` shows the overlay (a visibility flag only: no
 * compile, no upload).
 */

import * as THREE from 'three';
import { WorldCore } from './WorldCore.js';
import { EDGE_VERTS_PER_BOX, OCC_INDICES_PER_BOX, OCC_VERTS_PER_BOX, writeOccluderBoxes, writeOverlayEdges } from './Occluder.js';

export { captureSnapshot, loadFixture, normalizeSnapshot, CaptureGate } from './Snapshot.js';
export { NavGrid } from './NavGrid.js';
export { PathPlanner, PATH_PENDING, PATH_FAILED } from './PathPlanner.js';
export { DriftWatch, transformSnapshot, pickReferencePlanes, rigidFromPoses, resetTransform } from './Realign.js';

export class World extends WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number, maxOccluderBoxes?: number,
   *   roam?: boolean, bakeBudgetMs?: number, spawnBudgetMs?: number }} [o]
   *   roam defaults to true here: Roam (the whole house) is the default play mode (v0.3)
   */
  constructor(o = {}) {
    super({ roam: true, ...o });
    this.maxOccluderBoxes = o.maxOccluderBoxes ?? 512;
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

    // Dev overlay: occluder edges (cyan walls, magenta inferred walls, yellow furniture),
    // door frames (green open, red closed), spawn pockets (orange). Hidden by default.
    this.maxOverlayVerts = this.maxOccluderBoxes * EDGE_VERTS_PER_BOX + 64 * 8;
    const ovGeo = new THREE.BufferGeometry();
    this.ovPos = new THREE.BufferAttribute(new Float32Array(this.maxOverlayVerts * 3), 3);
    this.ovCol = new THREE.BufferAttribute(new Float32Array(this.maxOverlayVerts * 3), 3);
    ovGeo.setAttribute('position', this.ovPos);
    ovGeo.setAttribute('color', this.ovCol);
    const ovMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, depthWrite: false, toneMapped: false });
    ovMat.name = 'world-overlay';
    /** Dev overlay of the occluder (one LineSegments, hidden unless setOverlay(true)). */
    this.overlay = new THREE.LineSegments(ovGeo, ovMat);
    this.overlay.name = 'world-overlay';
    this.overlay.renderOrder = 1; // after the occluder (−10): lines behind a real wall are hidden like enemies
    this.overlay.frustumCulled = false;
    this.overlay.matrixAutoUpdate = false;
    this.overlay.visible = false;
    this.overlayOn = false;
    this.overlayVerts = 0;
    this.placeholder();
  }

  /** Every mesh the world draws, for the warm-up (load) and warmXR (after build). */
  warmMeshes() {
    return [this.occluder, this.overlay];
  }

  /**
   * Show or hide the dev overlay. Only a visibility flag: nothing compiles or uploads.
   * @param {boolean} on
   */
  setOverlay(on) {
    this.overlayOn = !!on;
    this.overlay.visible = this.overlayOn && this.overlayVerts > 0;
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
    const op = /** @type {Float32Array} */ (this.ovPos.array);
    op[0] = 0; op[1] = -100; op[2] = 0; op[3] = 0.01; op[4] = -100; op[5] = 0;
    this.overlay.geometry.setDrawRange(0, 2);
    this.ovPos.needsUpdate = true;
    this.ovCol.needsUpdate = true;
    this.overlayVerts = 0;
    this.overlay.visible = false;
  }

  /** WorldCore.warmUp, then back to the drawable placeholder. */
  warmUp() {
    super.warmUp();
    this.placeholder();
  }

  /**
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null, roam?: boolean }} [opts] see WorldCore.build
   * @returns {boolean} false when a Roam build was skipped (nothing rewritten, nothing to upload)
   */
  build(snapshot, playerStart, opts) {
    if (!super.build(snapshot, playerStart, opts)) return false;
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
    // Dev overlay (same boxes), uploaded by the next draw of it (warmXR after build).
    const nv = writeOverlayEdges(this.layout, /** @type {Float32Array} */ (this.ovPos.array), /** @type {Float32Array} */ (this.ovCol.array),
      this.maxOccluderBoxes, this.maxOverlayVerts);
    this.overlayVerts = nv;
    this.overlay.geometry.setDrawRange(0, nv);
    this.ovPos.needsUpdate = true;
    this.ovCol.needsUpdate = true;
    this.overlay.visible = this.overlayOn && nv > 0;
    return true;
  }

  /** WorldCore.report plus the meshes' fill. */
  report() {
    return { ...super.report(), occluderBoxes: this.occluderBoxes, overlaySegments: this.overlayVerts / 2 };
  }
}
