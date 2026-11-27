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
 *
 * v0.4.1 (the user's house: enemies seen through the corner where two walls
 * meet): an outer wall end (not a door jamb) reaches WALL_END (6 cm) past the
 * wall plane's end, so the slabs of two walls that meet at a corner overlap
 * (a slab behind its face, or centred on it, left a 5 × 5 cm hole at every
 * outer corner; the replay of the user's house saw enemies through them), and
 * the door curtains (Layout.curtains) are written after the boxes: one draw
 * range covers the boxes, a longer one the curtains too (World.setOccluderRange).
 *
 * `writeOverlayEdges` writes the dev overlay: the same boxes' edges as line
 * segments, plus door frames and spawn pockets (World.overlay).
 */

import { WALL_END } from './Layout.js';

export { WALL_END };
export const OCC_SHRINK = 0.02;
export const OCC_VERTS_PER_BOX = 8;
export const OCC_INDICES_PER_BOX = 36;
/** Dev overlay: 12 edges (24 line vertices) per occluder box; door frames and pockets add 4 edges each. */
export const EDGE_VERTS_PER_BOX = 24;
/** Overlay lines sit this far outside the occluder faces, so they pass the depth test in front of them. */
export const EDGE_GROW = 0.005;
/** Overlay colours (linear RGB). */
export const OVERLAY_COLOR = Object.freeze({
  wall: [0.0, 0.85, 1.0], // wall-plane slab: cyan
  inferred: [1.0, 0.2, 0.9], // inferred wall: magenta
  furniture: [1.0, 0.85, 0.1], // furniture box: yellow
  doorOpen: [0.2, 1.0, 0.3], // open door frame: green
  doorClosed: [1.0, 0.25, 0.2], // closed door frame: red
  pocket: [1.0, 0.5, 0.05], // spawn pocket outline on the floor: orange
  curtain: [0.6, 0.3, 1.0], // door curtain (depth-only cover of a door into unscanned space): violet
});

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
 * @param {number} [start] the first box slot to write (curtains go after the boxes)
 * @returns {number} boxes written (from `start`)
 */
export function writeOccluderBoxes(boxes, pos, idx, maxBoxes, start = 0) {
  let n = start;
  for (const b of boxes) {
    if (n >= maxBoxes) break;
    if (!occluderExtents(b, EXT)) continue;
    const x0 = EXT[0], x1 = EXT[1], y0 = EXT[2], y1 = EXT[3], z0 = EXT[4], z1 = EXT[5];
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
  return n - start;
}

const EXT = new Float64Array(6);

/**
 * The occluder's box in the box frame after the 2 cm shrink: x0, x1, y0, y1, z0, z1.
 * @param {import('./Layout.js').Box} b
 * @param {Float64Array|number[]} e out
 * @returns {boolean} false when the shrunk box is degenerate (not drawn)
 */
export function occluderExtents(b, e) {
  let x0 = -b.hx, x1 = b.hx, z0 = -b.hz, z1 = b.hz, y0 = b.y0, y1 = b.y1;
  if (b.kind === 'wall') {
    if (b.jamb0) x0 += OCC_SHRINK; else x0 -= WALL_END;
    if (b.jamb1) x1 -= OCC_SHRINK; else x1 += WALL_END;
    if (b.face < 0) z0 += OCC_SHRINK;
    else if (b.face > 0) z1 -= OCC_SHRINK;
    else { z0 += OCC_SHRINK; z1 -= OCC_SHRINK; } // centred slab (Roam): both sides face a room
    if (b.lintel) y0 += OCC_SHRINK;
    if (b.sill) y1 -= OCC_SHRINK;
  } else if (b.kind !== 'curtain') {
    x0 += OCC_SHRINK; x1 -= OCC_SHRINK; z0 += OCC_SHRINK; z1 -= OCC_SHRINK; y1 -= OCC_SHRINK;
  }
  e[0] = x0; e[1] = x1; e[2] = y0; e[3] = y1; e[4] = z0; e[5] = z1;
  return !(x1 - x0 < 0.005 || z1 - z0 < 0.005 || y1 - y0 < 0.005);
}

/**
 * Dev overlay (pure): the edges of every box the occluder draws (the same
 * first `maxBoxes`, same shrink, grown EDGE_GROW so the lines sit just in front
 * of the depth surface), each door frame (green open, red closed) and each
 * spawn pocket outline at its floor (+2 cm), as LineSegments vertex pairs with
 * per-vertex colours (OVERLAY_COLOR). Build time only.
 * @param {import('./Layout.js').Layout|null} layout
 * @param {Float32Array} pos capacity maxVerts × 3
 * @param {Float32Array} col capacity maxVerts × 3
 * @param {number} maxBoxes the occluder's box capacity
 * @param {number} maxVerts
 * @returns {number} vertices written (2 per segment)
 */
export function writeOverlayEdges(layout, pos, col, maxBoxes, maxVerts) {
  if (!layout) return 0;
  let v = 0, nb = 0;
  /** @param {number} x @param {number} y @param {number} z @param {readonly number[]} c */
  const put = (x, y, z, c) => {
    const o = v * 3;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
    v++;
  };
  const corner = new Float64Array(24);
  const curtains = layout.curtains || [];
  for (const b of curtains.length ? layout.boxes.concat(curtains) : layout.boxes) {
    if (nb >= maxBoxes) break;
    if (!occluderExtents(b, EXT)) continue;
    nb++;
    if (v + EDGE_VERTS_PER_BOX > maxVerts) break;
    const g = EDGE_GROW;
    const x0 = EXT[0] - g, x1 = EXT[1] + g, y0 = EXT[2] - g, y1 = EXT[3] + g, z0 = EXT[4] - g, z1 = EXT[5] + g;
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? x1 : x0, ly = k & 2 ? y1 : y0, lz = k & 4 ? z1 : z0;
      corner[k * 3] = b.cx + lx * b.c - lz * b.s;
      corner[k * 3 + 1] = ly;
      corner[k * 3 + 2] = b.cz + lx * b.s + lz * b.c;
    }
    const c = b.kind === 'curtain' ? OVERLAY_COLOR.curtain : b.kind !== 'wall' ? OVERLAY_COLOR.furniture : b.source === 'inferred' ? OVERLAY_COLOR.inferred : OVERLAY_COLOR.wall;
    for (let k = 0; k < 8; k++) {
      for (let bit = 1; bit < 8; bit <<= 1) {
        if (k & bit) continue;
        const j = k | bit;
        put(corner[k * 3], corner[k * 3 + 1], corner[k * 3 + 2], c);
        put(corner[j * 3], corner[j * 3 + 1], corner[j * 3 + 2], c);
      }
    }
  }
  /** @param {number[]} q 4 corners x,y,z @param {readonly number[]} c */
  const quad = (q, c) => {
    if (v + 8 > maxVerts) return;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      put(q[k * 3], q[k * 3 + 1], q[k * 3 + 2], c);
      put(q[j * 3], q[j * 3 + 1], q[j * 3 + 2], c);
    }
  };
  for (const d of layout.doors) {
    const h = d.width / 2, ox = d.nx * 0.01, oz = d.nz * 0.01;
    const ax = d.cx - d.tx * h + ox, az = d.cz - d.tz * h + oz, bx = d.cx + d.tx * h + ox, bz = d.cz + d.tz * h + oz;
    quad([ax, d.y0, az, bx, d.y0, bz, bx, d.y1, bz, ax, d.y1, az], d.open ? OVERLAY_COLOR.doorOpen : OVERLAY_COLOR.doorClosed);
  }
  for (const f of layout.floors) {
    if (!f.pocket || f.n !== 4) continue;
    const y = f.y + 0.02, p = f.pts;
    quad([p[0], y, p[1], p[2], y, p[3], p[4], y, p[5], p[6], y, p[7]], OVERLAY_COLOR.pocket);
  }
  return v;
}

/**
 * The box occluder's buffers for a layout, made off the main thread (the world
 * worker): positions, Uint16 indices and the bounds of what was written.
 * @param {import('./Layout.js').Layout|null} layout
 * @param {number} maxBoxes
 * @param {boolean} dropCovered leave out the furniture the global mesh covers
 *   n: every box written, curtains included; curtains: how many of the last n are door curtains (v0.4.1)
 * @returns {{ pos: Float32Array, idx: Uint16Array, n: number, curtains: number, bounds: Float32Array, total: number }}
 */
export function boxOccluderBuffers(layout, maxBoxes, dropCovered) {
  const all = layout ? layout.boxes : [];
  const boxes = dropCovered ? all.filter((b) => !b.covered) : all;
  const curtains = layout && layout.curtains ? layout.curtains : [];
  const cap = Math.min(boxes.length + curtains.length, maxBoxes);
  const pos = new Float32Array(cap * OCC_VERTS_PER_BOX * 3), idx = new Uint16Array(cap * OCC_INDICES_PER_BOX);
  const nb = writeOccluderBoxes(boxes, pos, idx, maxBoxes);
  const nc = writeOccluderBoxes(curtains, pos, idx, maxBoxes, nb);
  const n = nb + nc;
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < n * OCC_VERTS_PER_BOX; i++) {
    for (let j = 0; j < 3; j++) {
      const v = pos[i * 3 + j];
      if (v < bounds[j]) bounds[j] = v;
      if (v > bounds[3 + j]) bounds[3 + j] = v;
    }
  }
  return { pos: pos.subarray(0, n * OCC_VERTS_PER_BOX * 3), idx: idx.subarray(0, n * OCC_INDICES_PER_BOX), n, curtains: nc, bounds, total: boxes.length + curtains.length };
}

/**
 * The dev overlay's buffers for a layout (the world worker).
 * @param {import('./Layout.js').Layout|null} layout @param {number} maxBoxes @param {number} maxVerts
 * @returns {{ pos: Float32Array, col: Float32Array, n: number }}
 */
export function overlayBuffers(layout, maxBoxes, maxVerts) {
  const pos = new Float32Array(maxVerts * 3), col = new Float32Array(maxVerts * 3);
  const n = writeOverlayEdges(layout, pos, col, maxBoxes, maxVerts);
  return { pos: pos.slice(0, n * 3), col: col.slice(0, n * 3), n };
}
