/**
 * A large synthetic house for the performance tests (a helper module, not a
 * test file): 250 m² of mapped floor in a 20 × 12.5 m footprint, 12 rooms in
 * a 4 × 3 grid (5 × 4.17 m each) on 3 Space Setup floor polygons (one per
 * row, so each floor spans 4 rooms split by interior wall planes), every room
 * joined to its neighbours by 0.85 m doors, 2 exterior doors; a bed, a couch,
 * a table and a shelf in most rooms, plus unlabelled clutter; yawed 23° in the
 * reference space. `largeScan(snap, tris)` is its global mesh (ScanSynth).
 */
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { attachRaw } from '../../src/world/Snapshot.js';

export const LARGE = Object.freeze({ W: 20, D: 12.5, cols: 4, rows: 3, H: 2.6 });

/** @returns {{ b: SnapshotBuilder, snap: any, clutter: any[] }} */
export function largeHouse() {
  const { W, D, cols, rows, H } = LARGE;
  const b = new SnapshotBuilder({ yaw: (23 * Math.PI) / 180, ox: 1.2, oz: -0.7 });
  const cw = W / cols, ch = D / rows;
  for (let r = 0; r < rows; r++) {
    const z0 = r * ch, z1 = (r + 1) * ch;
    const pts = [[0, z0], [W, z0], [W, z1], [0, z1]];
    b.floor(pts, r * 0.004).ceiling(pts, H);
  }
  // exterior walls (CCW: normals into the house), with two exterior doors
  b.wall(0, 0, W, 0, 0, H, { extend: 0.05 }).wall(W, 0, W, D, 0, H, { extend: 0.05 }).wall(W, D, 0, D, 0, H, { extend: 0.05 }).wall(0, D, 0, 0, 0, H, { extend: 0.05 });
  b.door(2, 0, 2.95, 0, 0, 2.03).door(W, 6, W, 6.95, 0, 2.03);
  // interior walls between columns and rows, a door in each room-to-room span
  for (let c = 1; c < cols; c++) {
    const x = c * cw;
    b.wall(x, 0, x, D, 0, H);
    for (let r = 0; r < rows; r++) { const zc = (r + 0.5) * ch; b.door(x, zc - 0.425, x, zc + 0.425, 0, 2.03); }
  }
  for (let r = 1; r < rows; r++) {
    const z = r * ch;
    b.wall(W, z, 0, z, 0, H);
    for (let c = 0; c < cols; c++) { const xc = (c + 0.5) * cw; b.door(xc + 0.425, z, xc - 0.425, z, 0, 2.03); }
  }
  /** @type {any[]} */ const clutter = [];
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw, z0 = r * ch;
      if (k % 3 !== 2) b.top('bed', x0 + 1.25, z0 + 1.3, 0.8, 1.0, 0.55).box('bed', x0 + 1.25, z0 + 1.3, 0.8, 1.0, 0, 0.55);
      if (k % 2 === 0) b.box('couch', x0 + 3.6, z0 + 0.8, 0.9, 0.42, 0, 0.85).top('couch', x0 + 3.6, z0 + 0.8, 0.9, 0.42, 0.45);
      b.top('table', x0 + 3.4, z0 + 2.8, 0.55, 0.4, 0.75, 0.1).box('table', x0 + 3.4, z0 + 2.8, 0.55, 0.4, 0, 0.75, { yaw: 0.1 });
      if (k % 2 === 1) b.box('shelf', x0 + 0.5, z0 + 3.7, 0.4, 0.18, 0, 1.8);
      clutter.push({ cx: x0 + 2.4, cz: z0 + 2.9, hx: 0.22, hz: 0.22, h: 0.9, yaw: 0.3 * k });
      k++;
    }
  }
  return { b, snap: b.build(), clutter };
}

/**
 * The house's global mesh (~`tris` triangles), attached to the snapshot as a
 * live capture would (`snap.raw`), in a mesh space offset from the reference space.
 * @param {any} snap @param {any[]} clutter @param {number} tris
 */
export function largeScan(snap, clutter, tris = 120000) {
  const pose = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0.4, 0.02, -0.3, 1]; // yaw 90° + offset: mesh space ≠ reference space
  const scan = scanFromSnapshot(snap, { targetTris: tris, clutter, seed: 11, pose });
  const P = Float64Array.from(pose);
  attachRaw(snap, { token: 77, global: 0, meshes: [{ label: 'global mesh', pose: P, lastChangedTime: 0, data: { vertices: scan.vertices, indices: scan.indices } }] });
  snap.globalMesh = { label: 'global mesh', mesh: -1, vertexCount: scan.vertices.length / 3, triangleCount: scan.indices.length / 3, lastChangedTime: 0 };
  return scan;
}
