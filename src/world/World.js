// @ts-check
/**
 * The game world built from the user's Space Setup (CONTRACTS.md "World").
 *
 * WorldCore (pure) holds the layout, shapes, nav grid, spawn finder and the
 * global mesh's BVH and colliders; this class adds the depth-only occluders
 * and a dev overlay, all created at construction (at load) with fixed-capacity
 * buffers, so the warm-up draw compiles their (one) program and allocates
 * their GL buffers; builds only rewrite buffer ranges (`addUpdateRange`:
 * `bufferSubData` of what changed, never a new buffer, never a compile):
 * - `occluder`: the wall pieces and the furniture boxes as boxes (2 cm shrink,
 *   door openings open); once the mesh occluder is complete, the boxes of
 *   furniture the mesh covers are left out;
 * - `meshOccluder`: the processed global mesh (snapshot v2) minus floors,
 *   ceilings, wall faces and door openings, 1 cm inward on hard surfaces, in
 *   tiles nearest the player first; same material (same program), Uint32
 *   index, capacity `maxMeshVerts` / `maxMeshTris`. A synchronous `build()`
 *   writes every tile at once (behind the panel); a worker build
 *   (`buildAsync`) uploads one contiguous range of tiles per frame
 *   (≤ `meshUploadBytes`), the draw range growing behind it;
 * - `overlay`: the dev view of the occluder's box edges, door frames and spawn
 *   pockets (one LineSegments, hidden by default).
 *
 * Integration: `scene.add(...world.warmMeshes())` at load, before the warm-up,
 * and include `world.warmMeshes()` in the warm-up and warmXR object lists.
 * `world.setOverlay(true)` shows the overlay (a visibility flag only: no
 * compile, no upload). For worker builds: `world.attachBuilder(createWorldBuilder(world.config))`
 * at load (WorldWorker.js), then `await world.buildAsync(...)` behind the panel
 * with `world.update()` running every frame (src/world/README.md).
 */

import * as THREE from 'three';
import { WorldCore } from './WorldCore.js';
import { TILE_STRIDE } from './MeshPrep.js';
import { EDGE_VERTS_PER_BOX, OCC_INDICES_PER_BOX, OCC_VERTS_PER_BOX, writeOccluderBoxes, writeOverlayEdges } from './Occluder.js';

export { captureSnapshot, loadFixture, normalizeSnapshot, CaptureGate, hydrateSnapshot, snapshotForCopy } from './Snapshot.js';
export { NavGrid } from './NavGrid.js';
export { PathPlanner, PATH_PENDING, PATH_FAILED } from './PathPlanner.js';
export { DriftWatch, transformSnapshot, pickReferencePlanes, rigidFromPoses, resetTransform } from './Realign.js';
export { createWorldBuilder } from './WorldWorker.js';
export { BUILD } from './WorldCore.js';

/** Mesh occluder capacity (vertices, triangles): 1.2 MB of positions + 1.6 MB of Uint32 indices on the GPU. */
export const MESH_OCC_VERTS = 98304;
export const MESH_OCC_TRIS = 131072;
/** At most this many bytes of mesh occluder data uploaded per frame (one contiguous range of tiles). */
export const MESH_UPLOAD_BYTES = 96 * 1024;

export class World extends WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number, maxOccluderBoxes?: number,
   *   roam?: boolean, bakeBudgetMs?: number, spawnBudgetMs?: number, mesh?: boolean, maxMeshVerts?: number, maxMeshTris?: number,
   *   meshUploadBytes?: number }} [o]
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
    /** v0.4.1: door curtains written after the boxes (drawn while `curtainsOn`), and the box count now drawn. */
    this.curtainBoxes = 0;
    this._occDrawn = 0;

    // The global mesh as a depth-only occluder (the same material: no new program).
    this.maxMeshVerts = o.maxMeshVerts ?? MESH_OCC_VERTS;
    this.maxMeshTris = o.maxMeshTris ?? MESH_OCC_TRIS;
    this.meshUploadBytes = o.meshUploadBytes ?? MESH_UPLOAD_BYTES;
    const mgeo = new THREE.BufferGeometry();
    this.meshPos = new THREE.BufferAttribute(new Float32Array(this.maxMeshVerts * 3), 3);
    this.meshIdx = new THREE.BufferAttribute(new Uint32Array(this.maxMeshTris * 3), 1);
    this.meshPos.setUsage(THREE.DynamicDrawUsage);
    this.meshIdx.setUsage(THREE.DynamicDrawUsage);
    mgeo.setAttribute('position', this.meshPos);
    mgeo.setIndex(this.meshIdx);
    /** The processed Space Setup global mesh, depth only (real furniture shapes, clutter). */
    this.meshOccluder = new THREE.Mesh(mgeo, mat);
    this.meshOccluder.name = 'world-mesh-occluder';
    this.meshOccluder.renderOrder = -10;
    this.meshOccluder.frustumCulled = false;
    this.meshOccluder.matrixAutoUpdate = false;
    /** Mesh occluder state: tiles uploaded / to upload, triangles drawn. */
    this.meshTilesUp = 0;
    this.meshTilesTotal = 0;
    this.meshTrisDrawn = 0;
    this.meshTileUploads = 0;
    /** Tiles that did not fit the capacity (their furniture keeps its box). */
    this.meshTilesDropped = 0;
    /** Post-commit step of a worker build (uploadStep). */
    this._post = 0;

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
    /** The worker makes the box occluder and overlay buffers for these capacities (main thread: memcpy). */
    /** @type {any} */ (this.config).occluder = { maxBoxes: this.maxOccluderBoxes, maxOverlayVerts: this.maxOverlayVerts };
    this.placeholder();
  }

  /** Every mesh the world draws, for the warm-up (load) and warmXR (after build). */
  warmMeshes() {
    return [this.occluder, this.meshOccluder, this.overlay];
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
   * Until a real build: one degenerate box (and triangle) far below the floor,
   * visible, so the warm-up draw compiles the occluder's program and uploads
   * the whole of each buffer (its GL size never changes after that).
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
    this.curtainBoxes = 0;
    this._occDrawn = 1;
    const mp = /** @type {Float32Array} */ (this.meshPos.array), mi = /** @type {Uint32Array} */ (this.meshIdx.array);
    mp[0] = 0; mp[1] = -100; mp[2] = 0; mp[3] = 0.01; mp[4] = -100; mp[5] = 0; mp[6] = 0; mp[7] = -100; mp[8] = 0.01;
    mi[0] = 0; mi[1] = 1; mi[2] = 2;
    this.meshOccluder.geometry.setDrawRange(0, 3);
    this.meshPos.needsUpdate = true;
    this.meshIdx.needsUpdate = true;
    this.meshOccluder.visible = true;
    this.meshTilesUp = this.meshTilesTotal = this.meshTrisDrawn = 0;
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
   * Synchronous build (behind the "Get ready" panel): everything, both
   * occluders written at once (uploaded by the next draw: warmXR after build).
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null, roam?: boolean, mesh?: boolean }} [opts] see WorldCore.build
   * @returns {boolean} false when a Roam build was skipped (nothing rewritten, nothing to upload)
   */
  build(snapshot, playerStart, opts) {
    if (!super.build(snapshot, playerStart, opts)) return false;
    this.beginMeshOccluder();
    while (!this.uploadMeshRange(Infinity));
    this.writeBoxes(this.meshTilesDropped === 0);
    this.writeOverlay();
    return true;
  }

  /**
   * Worker build committed: the occluders follow over the next frames, one
   * piece a frame (each well under the 1 ms budget): the boxes (covered
   * furniture kept until the mesh is up), the dev overlay, the mesh tiles (one
   * range a frame), then the boxes without the covered furniture.
   */
  afterCommit() {
    this._post = 0;
    return true;
  }

  /** One frame's piece of the post-commit work (worker builds). @returns {boolean} done */
  uploadStep() {
    const A = this.occAdopt;
    switch (this._post) {
      case 0:
        this.beginMeshOccluder();
        if (A) this.copyBoxes(A.all); else this.writeBoxes(false);
        this._post = 1;
        return false;
      case 1:
        if (A) this.copyOverlay(A.overlay); else this.writeOverlay();
        this._post = 2;
        return false;
      case 2:
        if (!this.uploadMeshRange(this.meshUploadBytes, this.clock() + this.applyBudgetMs)) return false;
        this._post = 3;
        if (this.coveredFurniture > 0 && this.meshTilesDropped === 0) return false;
        return true;
      default:
        if (A && A.drop) this.copyBoxes(A.drop); else this.writeBoxes(true);
        this.occAdopt = null;
        return true;
    }
  }

  /**
   * The box occluder from buffers the worker made (memcpy + one range).
   * @param {{ pos: Float32Array, idx: Uint16Array, n: number, curtains?: number, bounds: Float32Array, total: number }} B
   */
  copyBoxes(B) {
    const n = B.n;
    /** @type {Float32Array} */ (this.occPos.array).set(B.pos);
    /** @type {Uint16Array} */ (this.occIdx.array).set(B.idx);
    if (B.total > n) this.stats.notes.push(`occluder holds ${n} of ${B.total} boxes`);
    this.curtainBoxes = B.curtains || 0;
    this.occluderBoxes = n - this.curtainBoxes;
    const geo = this.occluder.geometry;
    this.setOccluderRange();
    if (n > 0) {
      addRange(this.occPos, 0, n * OCC_VERTS_PER_BOX * 3);
      addRange(this.occIdx, 0, n * OCC_INDICES_PER_BOX);
      this.occPos.needsUpdate = true;
      this.occIdx.needsUpdate = true;
      const box = geo.boundingBox || (geo.boundingBox = new THREE.Box3());
      box.min.set(B.bounds[0], B.bounds[1], B.bounds[2]);
      box.max.set(B.bounds[3], B.bounds[4], B.bounds[5]);
      const sphere = geo.boundingSphere || (geo.boundingSphere = new THREE.Sphere());
      box.getBoundingSphere(sphere);
    }
    this.occluder.visible = n > 0;
  }

  /** The dev overlay from the worker's buffers. @param {{ pos: Float32Array, col: Float32Array, n: number }} O */
  copyOverlay(O) {
    const nv = O.n;
    /** @type {Float32Array} */ (this.ovPos.array).set(O.pos);
    /** @type {Float32Array} */ (this.ovCol.array).set(O.col);
    this.overlayVerts = nv;
    this.overlay.geometry.setDrawRange(0, nv);
    if (nv > 0) {
      addRange(this.ovPos, 0, nv * 3);
      addRange(this.ovCol, 0, nv * 3);
      this.ovPos.needsUpdate = true;
      this.ovCol.needsUpdate = true;
    }
    this.overlay.visible = this.overlayOn && nv > 0;
  }

  /** Reset the mesh occluder for the current build's tiles (nothing drawn until uploaded). */
  beginMeshOccluder() {
    const T = this.meshTiles;
    this.meshTilesUp = 0;
    this.meshTrisDrawn = 0;
    this.meshTileUploads = 0;
    this.meshTilesDropped = 0;
    let n = T ? T.tileCount : 0;
    if (T) {
      // the prefix of tiles (nearest first) that fits the capacity
      for (let k = 0; k < T.tileCount; k++) {
        const o = k * TILE_STRIDE;
        if (T.tiles[o + 4] + T.tiles[o + 5] > this.maxMeshVerts || T.tiles[o] + T.tiles[o + 1] > this.maxMeshTris) { n = k; break; }
      }
      this.meshTilesDropped = T.tileCount - n;
      if (this.meshTilesDropped) this.stats.notes.push(`mesh occluder holds ${n} of ${T.tileCount} tiles (capacity)`);
    }
    this.meshTilesTotal = n;
    this.meshOccluder.geometry.setDrawRange(0, 0);
    this.meshOccluder.visible = n > 0;
  }

  /**
   * Upload the next contiguous range of tiles (at least one tile, at most
   * `maxBytes` unless a single tile is larger, and no further tile after the
   * clock passes `deadline`).
   * @param {number} maxBytes
   * @param {number} [deadline] clock ms
   * @returns {boolean} every tile is up
   */
  uploadMeshRange(maxBytes, deadline = Infinity) {
    const T = this.meshTiles;
    if (!T || this.meshTilesUp >= this.meshTilesTotal) return true;
    const tiles = T.tiles, src = T.occPos, gi = T.occIdx;
    const P = /** @type {Float32Array} */ (this.meshPos.array), I = /** @type {Uint32Array} */ (this.meshIdx.array);
    const k0 = this.meshTilesUp;
    let k = k0, bytes = 0;
    const v0 = tiles[k0 * TILE_STRIDE + 4], t0 = tiles[k0 * TILE_STRIDE];
    while (k < this.meshTilesTotal) {
      const o = k * TILE_STRIDE, first = tiles[o], count = tiles[o + 1], vs = tiles[o + 4], vc = tiles[o + 5];
      const b = vc * 12 + count * 12;
      if (k > k0 && (bytes + b > maxBytes || this.clock() > deadline)) break;
      P.set(src.subarray(vs * 3, (vs + vc) * 3), vs * 3);
      I.set(gi.subarray(first * 3, (first + count) * 3), first * 3);
      bytes += b;
      k++;
    }
    const last = (k - 1) * TILE_STRIDE;
    const v1 = tiles[last + 4] + tiles[last + 5], t1 = tiles[last] + tiles[last + 1];
    addRange(this.meshPos, v0 * 3, (v1 - v0) * 3);
    addRange(this.meshIdx, t0 * 3, (t1 - t0) * 3);
    this.meshPos.needsUpdate = true;
    this.meshIdx.needsUpdate = true;
    this.meshTilesUp = k;
    this.meshTrisDrawn = t1;
    this.meshTileUploads++;
    this.meshOccluder.geometry.setDrawRange(0, t1 * 3);
    return k >= this.meshTilesTotal;
  }

  /**
   * The box occluder from the layout.
   * @param {boolean} dropCovered leave out the furniture the mesh covers (once the mesh occluder is complete)
   */
  writeBoxes(dropCovered) {
    const all = this.layout ? this.layout.boxes : [];
    const boxes = dropCovered && this.coveredFurniture > 0 ? all.filter((b) => !b.covered) : all;
    const curtains = this.layout && this.layout.curtains ? this.layout.curtains : [];
    const pos = /** @type {Float32Array} */ (this.occPos.array), idx = /** @type {Uint16Array} */ (this.occIdx.array);
    const nb = writeOccluderBoxes(boxes, pos, idx, this.maxOccluderBoxes);
    const nc = writeOccluderBoxes(curtains, pos, idx, this.maxOccluderBoxes, nb);
    const n = nb + nc;
    if (boxes.length + curtains.length > n) this.stats.notes.push(`occluder holds ${n} of ${boxes.length + curtains.length} boxes`);
    this.occluderBoxes = nb;
    this.curtainBoxes = nc;
    const geo = this.occluder.geometry;
    this.setOccluderRange();
    if (n > 0) {
      addRange(this.occPos, 0, n * OCC_VERTS_PER_BOX * 3);
      addRange(this.occIdx, 0, n * OCC_INDICES_PER_BOX);
      this.occPos.needsUpdate = true;
      this.occIdx.needsUpdate = true;
      // Bounds over the written vertices only (the buffer tail holds stale data).
      const box = geo.boundingBox || (geo.boundingBox = new THREE.Box3());
      box.makeEmpty();
      const v = new THREE.Vector3();
      for (let i = 0; i < n * OCC_VERTS_PER_BOX; i++) box.expandByPoint(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      const sphere = geo.boundingSphere || (geo.boundingSphere = new THREE.Sphere());
      box.getBoundingSphere(sphere);
    }
    this.occluder.visible = n > 0;
  }

  /** The dev overlay (same boxes), uploaded by the next draw of it. */
  writeOverlay() {
    const nv = writeOverlayEdges(this.layout, /** @type {Float32Array} */ (this.ovPos.array), /** @type {Float32Array} */ (this.ovCol.array),
      this.maxOccluderBoxes, this.maxOverlayVerts);
    this.overlayVerts = nv;
    this.overlay.geometry.setDrawRange(0, nv);
    if (nv > 0) {
      addRange(this.ovPos, 0, nv * 3);
      addRange(this.ovCol, 0, nv * 3);
    }
    this.ovPos.needsUpdate = true;
    this.ovCol.needsUpdate = true;
    this.overlay.visible = this.overlayOn && nv > 0;
  }

  /**
   * The box occluder's draw range: the boxes, plus the door curtains while they stand (`curtainsOn`).
   * A range change only (no upload, no compile); allocation-free.
   */
  setOccluderRange() {
    const n = this.occluderBoxes + (this.curtainsOn ? this.curtainBoxes : 0);
    if (n === this._occDrawn) return;
    this._occDrawn = n;
    this.occluder.geometry.setDrawRange(0, n * OCC_INDICES_PER_BOX);
  }

  /**
   * WorldCore.update (Roam bake, player tracking, curtains on / off for the head), then the curtains' draw range.
   * @param {number} dt @param {number} t @param {any} [frame] @param {any} [ctx]
   */
  update(dt, t, frame, ctx) {
    super.update(dt, t, frame, ctx);
    if (this.curtainBoxes > 0) this.setOccluderRange();
  }

  /** WorldCore.report plus the meshes' fill. */
  report() {
    return { ...super.report(), occluderBoxes: this.occluderBoxes, curtainBoxes: this.curtainBoxes, overlaySegments: this.overlayVerts / 2,
      meshOccluder: { tiles: this.meshTilesUp, of: this.meshTilesTotal, dropped: this.meshTilesDropped, tris: this.meshTrisDrawn, uploads: this.meshTileUploads } };
  }
}

/**
 * Mark a range for upload: extends the pending range when contiguous (several
 * writes before one draw), else adds one.
 * @param {THREE.BufferAttribute} attr @param {number} start @param {number} count
 */
function addRange(attr, start, count) {
  if (count <= 0) return;
  const R = /** @type {{ start: number, count: number }[]} */ (attr.updateRanges);
  for (let i = 0; i < R.length; i++) {
    const r = R[i];
    if (start >= r.start && start <= r.start + r.count) {
      const end = Math.max(r.start + r.count, start + count);
      r.count = end - r.start;
      return;
    }
  }
  attr.addUpdateRange(start, count);
}
