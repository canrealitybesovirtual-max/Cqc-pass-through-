// @ts-check
/**
 * Occluder geometry (pure): every wall piece and furniture box as one merged,
 * indexed, position-only triangle list for the depth-only stand-in mesh
 * (PLAN §5 mode A). Door openings are already gaps between wall pieces.
 *
 * Shrinking, so an enemy touching a real surface is never wrongly cut:
 * - furniture: 2 cm off every side and off the top;
 * - walls: the room-facing side moves 2 cm back into the slab, a jamb end 2 cm
 *   back from its door opening, a lintel's underside 2 cm up, a sill's top 2 cm
 *   down. Outer wall ends are not shrunk, so corners stay closed.
 */

export const OCC_SHRINK = 0.02;
export const OCC_VERTS_PER_BOX = 8;
export const OCC_INDICES_PER_BOX = 36;

/** Outward CCW faces of a box with corners k = x | y<<1 | z<<2 (bit set = max side). */
const FACES = [
  0, 4, 6, 0, 6, 2, // -x
  1, 3, 7, 1, 7, 5, // +x
  0, 1, 5, 0, 5, 4, // -y
  2, 6, 7, 2, 7, 3, // +y
  0, 2, 3, 0, 3, 1, // -z
  4, 5, 7, 4, 7, 6, // +z
];

/**
 * @param {import('./Layout.js').Box[]} boxes
 * @param {Float32Array} pos capacity maxBoxes × 8 × 3
 * @param {Uint16Array|Uint32Array} idx capacity maxBoxes × 36
 * @param {number} maxBoxes
 * @returns {number} boxes written
 */
export function writeOccluderBoxes(boxes, pos, idx, maxBoxes) {
  let n = 0;
  for (const b of boxes) {
    if (n >= maxBoxes) break;
    let x0 = -b.hx, x1 = b.hx, z0 = -b.hz, z1 = b.hz, y0 = b.y0, y1 = b.y1;
    if (b.kind === 'wall') {
      if (b.jamb0) x0 += OCC_SHRINK;
      if (b.jamb1) x1 -= OCC_SHRINK;
      if (b.face < 0) z0 += OCC_SHRINK; else z1 -= OCC_SHRINK;
      if (b.lintel) y0 += OCC_SHRINK;
      if (b.sill) y1 -= OCC_SHRINK;
    } else {
      x0 += OCC_SHRINK; x1 -= OCC_SHRINK; z0 += OCC_SHRINK; z1 -= OCC_SHRINK; y1 -= OCC_SHRINK;
    }
    if (x1 - x0 < 0.005 || z1 - z0 < 0.005 || y1 - y0 < 0.005) continue;
    const c = b.c, s = b.s, v = n * OCC_VERTS_PER_BOX;
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? x1 : x0, ly = k & 2 ? y1 : y0, lz = k & 4 ? z1 : z0;
      const o = (v + k) * 3;
      pos[o] = b.cx + lx * c - lz * s;
      pos[o + 1] = ly;
      pos[o + 2] = b.cz + lx * s + lz * c;
    }
    const io = n * OCC_INDICES_PER_BOX;
    for (let k = 0; k < 36; k++) idx[io + k] = v + FACES[k];
    n++;
  }
  return n;
}
