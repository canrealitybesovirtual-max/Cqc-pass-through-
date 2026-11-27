/**
 * Synthetic houses for the world tests (a helper module, not a test file).
 *
 * `userHouse()` is shaped like the user's real Space Setup (docs/DEVICE_LOG.md
 * p1.0): 50 planes (2 five-point floors of 111 m² and 14.4 m², 16 walls,
 * 6 doors, 10 tables, 7 shelves, 3 beds, 2 couches, 2 ceilings, 2 wall art)
 * and 25 meshes (22 furniture volumes, a lamp, a plant, the global mesh).
 * One floor polygon covers six rooms split by interior walls whose normals
 * point either way; one room is a sealed closet; a few labels are null; the
 * whole house is yawed 17° in the reference space.
 *
 * House coordinates (x, z), before the yaw:
 *   A x 0–4,  z 0–5      B x 0–4, z 5–8.5     closet x 0–4, z 8.5–10 (sealed)
 *   C x 4–8,  z 0–6      D x 4–8, z 6–10
 *   E x 8–12, z 0–3      F x 8–12 (slanted east edge to (9, 10)), z 3–10
 *   G x 12.1–16.1, z 0–3.6 (the second floor, 1.5 cm higher)
 * Doors: A–C, D–F, A–B, C–D, E–F, E–G (one plane over both edge walls).
 */
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';

export const H1 = 2.6, H2 = 2.55, F2 = 0.015;

/** Room rectangles in house coordinates: [x0, z0, x1, z1]. */
export const ROOMS = {
  A: [0, 0, 4, 5], B: [0, 5, 4, 8.5], closet: [0, 8.5, 4, 10], C: [4, 0, 8, 6], D: [4, 6, 8, 10],
  E: [8, 0, 12, 3], F: [8, 3, 12, 10], G: [12.1, 0, 16.1, 3.6],
};

/** Interior wall planes [ax, az, bx, bz, flip, label] (house coordinates). */
export const INTERIOR = [
  [4, 0, 4, 10, false, 'wall'],
  [8, 0, 8, 10, true, 'wall'],
  [0, 5, 4, 5, false, 'wall'],
  [4, 6, 8, 6, true, 'wall'],
  [8, 3, 12, 3, false, 'wall'],
  [0, 8.5, 4, 8.5, false, null], // sealed closet, unlabelled
  [6, 0, 6, 2.2, false, 'wall'], // a stub: open passage beside it
];

/** Door planes [ax, az, bx, bz] (house coordinates), in snapshot order = door ids. */
export const DOORS = [
  [4, 2, 4, 2.9], // 0: A–C
  [8, 6, 8, 6.9], // 1: D–F
  [1.5, 5, 2.4, 5], // 2: A–B
  [5, 6, 5.85, 6], // 3: C–D
  [10, 3, 10.9, 3], // 4: E–F
  [12.05, 1, 12.05, 1.9], // 5: E–G, between the two floors, one plane over both edge walls
];

/** @param {number} x @param {number} z @returns {string|null} room name in house coordinates */
export function roomAt(x, z) {
  for (const [name, [x0, z0, x1, z1]] of Object.entries(ROOMS)) {
    if (x > x0 && x < x1 && z > z0 && z < z1 && (name !== 'F' || x < 12 - (z - 4) * 0.5 || z < 4)) return name;
  }
  return null;
}

/**
 * @param {{ outward?: boolean }} [o] outward: every wall normal points OUT of its room (a runtime convention to survive)
 */
export function userHouse({ outward = false } = {}) {
  const b = new SnapshotBuilder({ yaw: (17 * Math.PI) / 180, ox: -3, oz: 2 });
  const f1 = [[0, 0], [12, 0], [12, 4], [9, 10], [0, 10]];
  const f2 = [[12.1, 0], [16.1, 0], [16.1, 3.6], [14, 3.6], [12.1, 3.6]];
  b.floor(f1, 0).floor(f2, F2).ceiling(f1, H1).ceiling(f2, H2);
  // Perimeter walls (CCW floors: the left normal points in), 10 cm past each corner.
  for (let i = 0; i < 5; i++) { const [ax, az] = f1[i], [bx, bz] = f1[(i + 1) % 5]; b.wall(ax, az, bx, bz, 0, H1, { extend: 0.1, flip: outward }); }
  b.wall(12.1, 0, 16.1, 0, F2, H2, { extend: 0.1, flip: outward }).wall(16.1, 0, 16.1, 3.6, F2, H2, { extend: 0.1, flip: outward })
    .wall(16.1, 3.6, 12.1, 3.6, F2, H2, { extend: 0.1, flip: outward }).wall(12.1, 3.6, 12.1, 0, F2, H2, { extend: 0.1, flip: outward });
  for (const [ax, az, bx, bz, flip, label] of INTERIOR) b.wall(ax, az, bx, bz, 0, H1, { flip: flip !== outward, label });
  for (const [ax, az, bx, bz] of DOORS) b.door(ax, az, bx, bz, 0, 2.03);
  b.vertical('wall art', 0, 2, 0, 3, 1.2, 1.9).vertical('wall art', 9, 0, 10, 0, 1.3, 1.8);
  // Furniture: a top plane + a volume for each (some yawed, some labels null).
  const furn = [
    ['couch', 0.5, 1.5, 0.45, 1.0, 0.85, 0], ['table', 2.6, 3.8, 0.5, 0.3, 0.74, 0.2], ['table', 0.5, 4.4, 0.25, 0.25, 0.5, 0],
    ['shelf', 3.1, 0.25, 0.6, 0.2, 1.9, 0], ['bed', 0.85, 7.4, 0.8, 1.0, 0.55, 0], ['shelf', 3.72, 7.6, 0.22, 0.6, 1.6, 0],
    ['table', 3.3, 5.6, 0.4, 0.25, 0.72, 0.1], ['couch', 7.1, 0.5, 0.8, 0.45, 0.8, 0], ['table', 5.0, 4.0, 0.6, 0.4, 0.75, -0.25],
    ['table', 7.0, 3.5, 0.4, 0.4, 0.7, 0], ['shelf', 4.25, 4.75, 0.2, 0.75, 1.8, 0], ['bed', 7.07, 8.87, 0.87, 1.07, 0.6, 0],
    ['table', 5.0, 8.5, 0.5, 0.35, 0.75, 0.3], ['shelf', 4.25, 8.75, 0.2, 0.75, 2.0, 0], ['table', 10, 1.2, 0.5, 0.3, 0.76, 0],
    ['shelf', 8.7, 0.25, 0.6, 0.2, 1.2, 0], ['table', 9.5, 5.0, 0.6, 0.4, 0.75, 0.15], ['table', 9.0, 8.0, 0.4, 0.3, 0.7, 0],
    ['shelf', 8.25, 8.25, 0.2, 0.75, 1.9, 0], ['bed', 15.22, 1.05, 0.82, 1.0, 0.55, 0], ['table', 13.2, 3.0, 0.4, 0.25, 0.72, 0],
    ['shelf', 12.35, 3.0, 0.2, 0.5, 1.5, 0],
  ];
  furn.forEach(([label, cx, cz, hx, hz, h, yaw], i) => {
    b.top(i === 6 ? null : label, cx, cz, hx, hz, h, yaw);
    b.box(i === 5 ? null : label, cx, cz, hx, hz, 0, h, { yaw, zUp: i % 4 === 1 });
  });
  b.box('lamp', 3.6, 4.6, 0.15, 0.15, 0, 1.6).box('plant', 11.4, 2.5, 0.15, 0.15, 0, 0.9);
  b.box('global mesh', 8, 5, 8.2, 5.1, 0, H1, { vertexCount: 35794 * 3 });
  return b;
}

/**
 * House coordinates of a reference-space point (inverse of SnapshotBuilder.toWorld).
 * @param {SnapshotBuilder} b @param {number} x @param {number} z @returns {[number, number]}
 */
export function toHouse(b, x, z) {
  const dx = x - b.ox, dz = z - b.oz;
  return [b.c * dx - b.s * dz, b.s * dx + b.c * dz];
}

/**
 * A large synthetic house for the Roam tests (a whole house walked in one
 * session): 250 m² on one level with the rooms of a three-storey house. A
 * 25 × 10 m footprint, a 1.6 m corridor along the middle (z 4.2–5.8), ten
 * 2.5 × 4.2 m rooms either side, each with a door onto the corridor (20) and
 * five connecting doors per side between neighbours (10): 30 doors, 21 rooms,
 * two pieces of furniture per room. One floor polygon covers it all (as Quest
 * does when one Space Setup room spans several real rooms), so every interior
 * wall has floor on both sides. Yawed 23° in the reference space.
 * Door ids: 0–9 south rooms → corridor, 10–19 north rooms → corridor, 20–24
 * south connecting doors (on x = 2.5, 7.5, …), 25–29 north connecting doors.
 */
export function largeHouse({ yaw = (23 * Math.PI) / 180 } = {}) {
  const b = new SnapshotBuilder({ yaw, ox: 4, oz: -6 });
  const W = 25, D = 10, H = 2.6, c0 = 4.2, c1 = 5.8, rw = 2.5;
  const f = [[0, 0], [W, 0], [W, D], [0, D]];
  b.floor(f, 0).ceiling(f, H);
  for (let i = 0; i < 4; i++) { const [ax, az] = f[i], [bx, bz] = f[(i + 1) % 4]; b.wall(ax, az, bx, bz, 0, H, { extend: 0.1 }); }
  b.wall(0, c0, W, c0, 0, H, {}).wall(W, c1, 0, c1, 0, H, {});
  for (let k = 1; k < 10; k++) {
    b.wall(k * rw, 0, k * rw, c0, 0, H, { flip: k % 2 === 0 });
    b.wall(k * rw, D, k * rw, c1, 0, H, { flip: k % 2 === 1 });
  }
  for (let k = 0; k < 10; k++) b.door(k * rw + 0.8, c0, k * rw + 1.65, c0, 0, 2.03);
  for (let k = 0; k < 10; k++) b.door(k * rw + 0.8, c1, k * rw + 1.65, c1, 0, 2.03);
  for (let k = 1; k < 10; k += 2) b.door(k * rw, 1.5, k * rw, 2.35, 0, 2.03);
  for (let k = 1; k < 10; k += 2) b.door(k * rw, 7.6, k * rw, 8.45, 0, 2.03);
  for (let k = 0; k < 10; k++) {
    const x = k * rw;
    b.top('bed', x + 1.25, 0.95, 0.45, 0.9, 0.55).box('bed', x + 1.25, 0.95, 0.45, 0.9, 0, 0.55);
    b.top('shelf', x + 2.25, 3.4, 0.18, 0.5, 1.8).box('shelf', x + 2.25, 3.4, 0.18, 0.5, 0, 1.8);
    b.top('table', x + 1.25, 9.0, 0.5, 0.35, 0.75).box('table', x + 1.25, 9.0, 0.5, 0.35, 0, 0.75);
    b.top('shelf', x + 0.25, 6.6, 0.18, 0.5, 1.8).box('shelf', x + 0.25, 6.6, 0.18, 0.5, 0, 1.8);
  }
  return b;
}

/** Room rectangles of largeHouse() in house coordinates: S0…S9, N0…N9, corridor. */
export function largeRooms() {
  /** @type {Record<string, number[]>} */ const r = { corridor: [0, 4.2, 25, 5.8] };
  for (let k = 0; k < 10; k++) { r[`S${k}`] = [k * 2.5, 0, k * 2.5 + 2.5, 4.2]; r[`N${k}`] = [k * 2.5, 5.8, k * 2.5 + 2.5, 10]; }
  return r;
}
