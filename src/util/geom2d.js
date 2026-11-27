// @ts-check
/** Small 2D helpers on flat [x0,z0,x1,z1,…] arrays. Pure; allocation-free. */

/**
 * Even–odd point-in-polygon test.
 * @param {ArrayLike<number>} poly flat x,z pairs
 * @param {number} n number of points used from `poly`
 * @param {number} x
 * @param {number} z
 */
export function pointInPolygon(poly, n, x, z) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], zi = poly[2 * i + 1];
    const xj = poly[2 * j], zj = poly[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Signed area (positive = counter-clockwise in x/z with z pointing "up" on paper).
 * @param {ArrayLike<number>} poly
 * @param {number} n
 */
export function polygonArea(poly, n) {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
  return a / 2;
}
