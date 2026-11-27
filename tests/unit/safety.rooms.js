/**
 * Worlds for the safety tests (a helper module, not a test file): the house
 * fixture and synthetic rectangular rooms, built with the real WorldCore.
 */
import { readFileSync } from 'node:fs';
import { WorldCore } from '../../src/world/WorldCore.js';
import { SnapshotBuilder } from '../../src/world/SnapshotBuilder.js';

export const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

/** The house fixture, built with the player at (0, 0). */
export function houseWorld() {
  const w = new WorldCore();
  w.build(house(), { x: 0, z: 0 });
  return w;
}

/**
 * A rectangular room x0…x1 × z0…z1 with 2.5 m walls (faces on the floor
 * edge) and optional furniture [label, cx, cz, hx, hz, height].
 * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {Array<[string, number, number, number, number, number]>} [furniture]
 * @param {{ x: number, z: number }|null} [start]
 */
export function room(x0, z0, x1, z1, furniture = [], start = null) {
  const b = new SnapshotBuilder();
  const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  b.floor(pts, 0).ceiling(pts, 2.5);
  for (let i = 0; i < 4; i++) b.wall(pts[i][0], pts[i][1], pts[(i + 1) % 4][0], pts[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
  for (const [label, cx, cz, hx, hz, h] of furniture) b.top(label, cx, cz, hx, hz, h).box(label, cx, cz, hx, hz, 0, h);
  const w = new WorldCore();
  w.build(b.build(), start || { x: (x0 + x1) / 2, z: (z0 + z1) / 2 });
  return w;
}
