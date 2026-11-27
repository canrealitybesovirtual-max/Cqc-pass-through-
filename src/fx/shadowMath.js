// @ts-check
/**
 * Contact-shadow geometry (pure: no three.js; Node-tested). research-look R1,
 * research-phys §12: a soft blob under every virtual object that touches or
 * nears a real surface, lying in the surface's plane, sized from the object's
 * footprint, fading and widening with height, nudged away from the key light.
 *
 * Inputs and outputs are typed arrays (layouts below), never long lists of
 * numbers: in the per-frame path a call with double arguments that V8 does
 * not inline boxes each one (a heap allocation), so these functions take
 * only arrays and small integers.
 *
 * Shadow record (SH_LEN floats, one per blob):
 *   cx, cy, cz   centre on the surface (world)
 *   nx, ny, nz   surface normal (unit)
 *   ax, ay, az   major axis (unit, in the plane)
 *   a, b         semi-axes (m)
 *   alpha        peak darkening (0..1: the passthrough is multiplied by 1 − alpha)
 *   soft         edge softness (0 hard .. 1 all falloff)
 *   pull         metres the blob is drawn toward the eye (beats lumpy scans and the occluder)
 */

export const SH = Object.freeze({ CX: 0, CY: 1, CZ: 2, NX: 3, NY: 4, NZ: 5, AX: 6, AY: 7, AZ: 8, A: 9, B: 10, ALPHA: 11, SOFT: 12, PULL: 13 });
export const SH_LEN = 14;

/** writeShadow input layout. */
export const W = Object.freeze({
  PX: 0, PY: 1, PZ: 2,        // surface point under the object
  NX: 3, NY: 4, NZ: 5,        // surface normal
  AX: 6, AY: 7, AZ: 8,        // major axis (in the plane)
  A: 9, B: 10,                // semi-axes at contact
  H: 11,                      // height of the object's lowest point above the surface
  ALPHA: 12, SOFT: 13, PULL: 14,
  LX: 15, LY: 16, LZ: 17,     // key light direction (unit, toward the light)
  FADE: 18,                   // height where the blob is gone
});
export const W_LEN = 19;

/** boxFootprint input layout: rotation, half extents, plane normal. */
export const BF = Object.freeze({ QX: 0, QY: 1, QZ: 2, QW: 3, HX: 4, HY: 5, HZ: 6, NX: 7, NY: 8, NZ: 9 });
export const BF_LEN = 10;

/** Tunables (research R1 numbers; the rest design). */
export const SHADOW = Object.freeze({
  fadeH: 0.3,           // m: gone at this height above the surface
  growK: 1.6,           // size × (1 + growK × h)
  lightK: 0.4,          // offset = −L.xz × h × lightK
  // the footprint ellipse is the box's second moment (inscribed in its outline): × 1.45 reaches past
  // the outline, so a soft contact halo shows round the object (the core is under it anyway)
  itemAlpha: 0.62, itemSoftAlpha: 0.7, itemSoft: 0.62, itemSoftSoft: 0.78, itemCover: 1.45,
  // feet and bodies: a little larger than the boot / limb outline, or the object hides the whole blob
  footAlpha: 0.7, footFadeH: 0.25, footA: 0.17, footB: 0.095,
  bodyAlpha: 0.42, bodyA: 0.3, bodyB: 0.2,
  deadAlpha: 0.55, deadSoft: 0.72, deadFadeH: 0.35, deadPad: 1.5,
  heldAlpha: 0.35, heldMaxH: 0.5,
  pullHard: 0.012, pullSoft: 0.03,
  minAlpha: 0.01,
});

/** @param {number} a @param {number} b @param {number} x */
export function smoothstep(a, b, x) {
  const t = (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Footprint of an oriented box on a plane: the box's second moment projected
 * onto the plane, as an ellipse (semi-axes from its eigenvalues), plus the
 * box's half thickness along the normal (how far its lowest point sits below
 * its centre).
 * @param {Float64Array} q BF layout (rotation unit, half extents in item space, plane normal unit)
 * @param {Float64Array} out [ax, ay, az, a, b, halfThickness]
 * @returns {Float64Array} out
 */
export function boxFootprint(q, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3], hx = q[4], hy = q[5], hz = q[6], nx = q[7], ny = q[8], nz = q[9];
  // rotation matrix columns (item axes in world)
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const c0x = 1 - (yy + zz), c0y = xy + wz, c0z = xz - wy;
  const c1x = xy - wz, c1y = 1 - (xx + zz), c1z = yz + wx;
  const c2x = xz + wy, c2y = yz - wx, c2z = 1 - (xx + yy);
  // a tangent basis (t, u) of the plane
  let tx, ty, tz;
  if (Math.abs(ny) < 0.9) { tx = -nz; ty = 0; tz = nx; } else { tx = 1 - nx * nx; ty = -nx * ny; tz = -nx * nz; }
  let l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= l; ty /= l; tz /= l;
  const ux = ny * tz - nz * ty, uy = nz * tx - nx * tz, uz = nx * ty - ny * tx;
  // projected axes in (t, u), scaled by the half extents
  const p0t = (c0x * tx + c0y * ty + c0z * tz) * hx, p0u = (c0x * ux + c0y * uy + c0z * uz) * hx;
  const p1t = (c1x * tx + c1y * ty + c1z * tz) * hy, p1u = (c1x * ux + c1y * uy + c1z * uz) * hy;
  const p2t = (c2x * tx + c2y * ty + c2z * tz) * hz, p2u = (c2x * ux + c2y * uy + c2z * uz) * hz;
  const m00 = p0t * p0t + p1t * p1t + p2t * p2t;
  const m11 = p0u * p0u + p1u * p1u + p2u * p2u;
  const m01 = p0t * p0u + p1t * p1u + p2t * p2u;
  // eigen decomposition of the symmetric 2 × 2
  const tr = m00 + m11, det = m00 * m11 - m01 * m01;
  const d2 = tr * tr * 0.25 - det;
  const disc = Math.sqrt(d2 > 0 ? d2 : 0);
  const l1 = tr * 0.5 + disc, l2r = tr * 0.5 - disc, l2 = l2r > 0 ? l2r : 0;
  let et, eu;
  if (Math.abs(m01) > 1e-12) { et = l1 - m11; eu = m01; } else if (m00 >= m11) { et = 1; eu = 0; } else { et = 0; eu = 1; }
  l = Math.sqrt(et * et + eu * eu) || 1;
  et /= l; eu /= l;
  out[0] = tx * et + ux * eu; out[1] = ty * et + uy * eu; out[2] = tz * et + uz * eu;
  out[3] = Math.sqrt(l1);
  out[4] = Math.sqrt(l2);
  out[5] = Math.abs(c0x * nx + c0y * ny + c0z * nz) * hx + Math.abs(c1x * nx + c1y * ny + c1z * nz) * hy + Math.abs(c2x * nx + c2y * ny + c2z * nz) * hz;
  return out;
}

/**
 * Fill one shadow record from the W input: applies the height fade, growth
 * and the key-light offset.
 * @param {Float64Array} out record array @param {number} o offset (multiple of SH_LEN)
 * @param {Float64Array} s W layout
 * @returns {boolean} false when the blob is invisible (too high or too faint; out untouched)
 */
export function writeShadow(out, o, s) {
  const h = s[11] > 0 ? s[11] : 0, fadeH = s[18], a = s[9], b = s[10];
  const fade = smoothstep(0, fadeH, h);
  const al = s[12] * (1 - fade);
  if (!(al > SHADOW.minAlpha) || !(a > 0) || !(b > 0)) return false;
  const nx = s[3], ny = s[4], nz = s[5];
  const g = 1 + SHADOW.growK * h;
  // key light: the shadow falls away from the light, in the plane
  const lx = s[15], ly = s[16], lz = s[17];
  const ld = lx * nx + ly * ny + lz * nz;
  const k = -SHADOW.lightK * h;
  out[o] = s[0] + (lx - nx * ld) * k; out[o + 1] = s[1] + (ly - ny * ld) * k; out[o + 2] = s[2] + (lz - nz * ld) * k;
  out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz;
  out[o + 6] = s[6]; out[o + 7] = s[7]; out[o + 8] = s[8];
  out[o + 9] = a * g; out[o + 10] = b * g;
  out[o + 11] = al;
  const sf = s[13] + (1 - s[13]) * fade * 0.6;
  out[o + 12] = sf > 1 ? 1 : sf;
  out[o + 13] = s[14];
  return true;
}

/**
 * A capsule lying near the floor (a body part) as a blob: the segment
 * projected onto the floor plane (+Y), padded by its radius.
 * @param {ArrayLike<number>} A @param {ArrayLike<number>} B capsule end arrays (x, y, z per capsule)
 * @param {number} c offset of this capsule's ends (3 × index)
 * @param {Float64Array} p [radius, floorY]
 * @param {Float64Array} out [cx, cz, dirX, dirZ, semiMajor, semiMinor, height]
 * @returns {Float64Array} out
 */
export function capsuleFloor(A, B, c, p, out) {
  const ax = A[c], ay = A[c + 1], az = A[c + 2], bx = B[c], by = B[c + 1], bz = B[c + 2], r = p[0];
  const dx = bx - ax, dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  out[0] = (ax + bx) * 0.5;
  out[1] = (az + bz) * 0.5;
  if (len > 1e-6) { out[2] = dx / len; out[3] = dz / len; } else { out[2] = 1; out[3] = 0; }
  out[4] = len * 0.5 + r * SHADOW.deadPad;
  out[5] = r * SHADOW.deadPad * 1.1;
  out[6] = (ay < by ? ay : by) - r - p[1];
  return out;
}
