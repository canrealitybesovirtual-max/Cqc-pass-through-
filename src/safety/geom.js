// @ts-check
/**
 * Distance queries against the world's analytic boxes (pure: no three.js, no
 * DOM; allocation-free). The box record is the one `world.shapes` keeps
 * (src/world/Shapes.js): 8 floats per box, `cx, cz, c, s, hx, hz, y0, y1`.
 * The box frame: local x = (c, s) and local z = (−s, c) in world x/z, half
 * extents hx / hz, vertical extent y0…y1 (y0 may be −Infinity for furniture
 * extruded down from a top plane).
 *
 * Used by SafeSpot (is there room to play here?) and ObstacleWarnings (is a
 * hand or the head close to a mapped wall or furniture box?).
 */

export const BOX_STRIDE = 8;

/**
 * 3D distance from (x, y, z) to box `o` (0 inside). With `out`, the closest
 * point on (or in) the box is written to out[k], out[k+1], out[k+2].
 * @param {ArrayLike<number>} B box records
 * @param {number} o offset of the record (index × BOX_STRIDE)
 * @param {number} x @param {number} y @param {number} z
 * @param {Float64Array|Float32Array|number[]|null} [out]
 * @param {number} [k] write offset into `out`
 */
export function boxDistance(B, o, x, y, z, out = null, k = 0) {
  const cx = B[o], cz = B[o + 1], c = B[o + 2], s = B[o + 3], hx = B[o + 4], hz = B[o + 5], y0 = B[o + 6], y1 = B[o + 7];
  const rx = x - cx, rz = z - cz;
  const lx = rx * c + rz * s, lz = rz * c - rx * s;
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  const qy = y < y0 ? y0 : y > y1 ? y1 : y;
  if (out) {
    out[k] = cx + qx * c - qz * s;
    out[k + 1] = qy;
    out[k + 2] = cz + qx * s + qz * c;
  }
  const dx = lx - qx, dy = y - qy, dz = lz - qz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Horizontal distance from (x, z) to the footprint of box `o` (0 inside).
 * @param {ArrayLike<number>} B @param {number} o @param {number} x @param {number} z
 */
export function footprintDistance(B, o, x, z) {
  const c = B[o + 2], s = B[o + 3], hx = B[o + 4], hz = B[o + 5];
  const rx = x - B[o], rz = z - B[o + 1];
  let lx = rx * c + rz * s, lz = rz * c - rx * s;
  lx = lx < 0 ? -lx : lx;
  lz = lz < 0 ? -lz : lz;
  const dx = lx > hx ? lx - hx : 0, dz = lz > hz ? lz - hz : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Does the horizontal segment a→b cross the footprint of box `o`, grown by
 * `pad`? (Liang–Barsky in the box frame.)
 * @param {ArrayLike<number>} B @param {number} o
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz
 * @param {number} pad
 */
export function segmentHitsFootprint(B, o, ax, az, bx, bz, pad) {
  const cx = B[o], cz = B[o + 1], c = B[o + 2], s = B[o + 3];
  const hx = B[o + 4] + pad, hz = B[o + 5] + pad;
  const rax = ax - cx, raz = az - cz;
  const lax = rax * c + raz * s, laz = raz * c - rax * s;
  const dX = bx - ax, dZ = bz - az;
  const ldx = dX * c + dZ * s, ldz = dZ * c - dX * s;
  let t0 = 0, t1 = 1;
  // x slab
  if (ldx > -1e-12 && ldx < 1e-12) { if (lax < -hx || lax > hx) return false; }
  else {
    let ta = (-hx - lax) / ldx, tb = (hx - lax) / ldx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  // z slab
  if (ldz > -1e-12 && ldz < 1e-12) { if (laz < -hz || laz > hz) return false; }
  else {
    let ta = (-hz - laz) / ldz, tb = (hz - laz) / ldz;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Nearest box footprint to (x, z) among the boxes that start below `maxY`
 * (things a standing player can bump into or reach: walls, furniture,
 * shelves, low lintels). Writes the box index to `idxOut[0]` when given.
 * @param {{ box: Float32Array, count: number }|null|undefined} shapes world.shapes
 * @param {number} x @param {number} z
 * @param {number} maxY
 * @param {Int32Array|null} [idxOut]
 * @returns {number} metres (Infinity with no boxes)
 */
export function nearestFootprint(shapes, x, z, maxY, idxOut = null) {
  let best = Infinity, bi = -1;
  if (shapes && shapes.box) {
    const B = shapes.box, n = shapes.count;
    for (let i = 0, o = 0; i < n; i++, o += BOX_STRIDE) {
      if (!(B[o + 6] < maxY)) continue;
      const d = footprintDistance(B, o, x, z);
      if (d < best) { best = d; bi = i; }
    }
  }
  if (idxOut) idxOut[0] = bi;
  return best;
}

/**
 * Is the straight walk a→b free of box footprints (starting below `maxY`,
 * grown by `pad`)? A box the start point already touches (within `pad`) is
 * ignored, so a player standing against a wall can still be sent away from it.
 * @param {{ box: Float32Array, count: number }|null|undefined} shapes
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz
 * @param {number} maxY @param {number} pad
 */
export function walkClear(shapes, ax, az, bx, bz, maxY, pad) {
  if (!shapes || !shapes.box) return true;
  const B = shapes.box, n = shapes.count;
  for (let i = 0, o = 0; i < n; i++, o += BOX_STRIDE) {
    if (!(B[o + 6] < maxY)) continue;
    if (footprintDistance(B, o, ax, az) <= pad) continue;
    if (segmentHitsFootprint(B, o, ax, az, bx, bz, pad)) return false;
  }
  return true;
}
