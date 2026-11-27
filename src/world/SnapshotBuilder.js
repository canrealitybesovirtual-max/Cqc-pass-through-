// @ts-check
/**
 * Author a SpaceSnapshot in the same format as captureSnapshot, from a plan
 * drawn in "house" coordinates (pure). Used by the unit tests to build
 * synthetic houses, and handy for desktop test rooms.
 *
 * Planes follow the Quest conventions captureSnapshot records: the pose maps
 * plane space to the reference space (column-major), the polygon is in plane
 * space (x, z) with y = the plane normal. Vertical planes: local y = the
 * normal (into the room), local x horizontal, local z down. Ceilings face
 * down. Meshes are boxes; `zUp` writes them with a z-up mesh frame, as some
 * runtimes do, to exercise the general path.
 *
 * A whole-house transform (yaw about +Y, then an offset) maps house
 * coordinates to the reference space, so tests can place a house at any angle.
 */
export class SnapshotBuilder {
  /** @param {{ yaw?: number, ox?: number, oz?: number, space?: string }} [o] */
  constructor({ yaw = 0, ox = 0, oz = 0, space = 'local-floor' } = {}) {
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
    this.yaw = yaw;
    this.ox = ox;
    this.oz = oz;
    this.space = space;
    /** @type {any[]} */ this.planes = [];
    /** @type {any[]} */ this.meshes = [];
  }

  /**
   * House → reference space (rotation about +Y by yaw: x' = c·x + s·z, z' = −s·x + c·z).
   * @param {number} x @param {number} z
   * @returns {[number, number]}
   */
  toWorld(x, z) {
    return [this.c * x + this.s * z + this.ox, -this.s * x + this.c * z + this.oz];
  }

  /** Direction house → reference space. @param {number} x @param {number} z @returns {[number, number]} */
  dirToWorld(x, z) {
    return [this.c * x + this.s * z, -this.s * x + this.c * z];
  }

  /**
   * Horizontal polygon plane (floor, ceiling or a furniture top).
   * @param {string|null} label
   * @param {number[][]} pts house x,z
   * @param {number} y
   * @param {{ down?: boolean }} [o]
   */
  horizontal(label, pts, y, { down = false } = {}) {
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cz += p[1]; }
    cx /= pts.length; cz /= pts.length;
    const [wx, wz] = this.toWorld(cx, cz);
    // Plane x/z axes = the house axes in the reference space; ceilings flip y and z.
    const ax = this.dirToWorld(1, 0), az = this.dirToWorld(0, 1);
    const f = down ? -1 : 1;
    const pose = [ax[0], 0, ax[1], 0, 0, f, 0, 0, f * az[0], 0, f * az[1], 0, wx, y, wz, 1];
    const polygon = pts.map((p) => [p[0] - cx, f * (p[1] - cz)]);
    this.planes.push({ label, orientation: 'horizontal', pose, polygon });
    return this;
  }

  /** @param {number[][]} pts @param {number} y @param {string|null} [label] */
  floor(pts, y, label = 'floor') {
    return this.horizontal(label, pts, y);
  }

  /** @param {number[][]} pts @param {number} y @param {string|null} [label] */
  ceiling(pts, y, label = 'ceiling') {
    return this.horizontal(label, pts, y, { down: true });
  }

  /**
   * Vertical rectangle a→b (house coords) from y0 to y1. The normal points to
   * the left of a→b (CCW room: into the room), or to the right with `flip`.
   * @param {string|null} label
   * @param {number} ax @param {number} az @param {number} bx @param {number} bz
   * @param {number} y0 @param {number} y1
   * @param {{ flip?: boolean, offset?: number }} [o] offset: shift along the normal (m)
   */
  vertical(label, ax, az, bx, bz, y0, y1, { flip = false, offset = 0 } = {}) {
    const len = Math.hypot(bx - ax, bz - az);
    const ex = (bx - ax) / len, ez = (bz - az) / len;
    let nx = -ez, nz = ex; // left of a→b
    if (flip) { nx = -nx; nz = -nz; }
    const [wnx, wnz] = this.dirToWorld(nx, nz);
    const tx = wnz, tz = -wnx; // local x = up × n
    const [cx, cz] = this.toWorld((ax + bx) / 2 + nx * offset, (az + bz) / 2 + nz * offset);
    const h = y1 - y0;
    const pose = [tx, 0, tz, 0, wnx, 0, wnz, 0, 0, -1, 0, 0, cx, (y0 + y1) / 2, cz, 1];
    const polygon = [[-len / 2, -h / 2], [len / 2, -h / 2], [len / 2, h / 2], [-len / 2, h / 2]];
    this.planes.push({ label, orientation: 'vertical', pose, polygon });
    return this;
  }

  /**
   * @param {number} ax @param {number} az @param {number} bx @param {number} bz
   * @param {number} y0 @param {number} y1
   * @param {{ flip?: boolean, label?: string|null, extend?: number }} [o] extend: lengthen both ends (m)
   */
  wall(ax, az, bx, bz, y0, y1, { flip = false, label = 'wall', extend = 0 } = {}) {
    if (extend) {
      const len = Math.hypot(bx - ax, bz - az), ex = (bx - ax) / len, ez = (bz - az) / len;
      ax -= ex * extend; az -= ez * extend; bx += ex * extend; bz += ez * extend;
    }
    return this.vertical(label, ax, az, bx, bz, y0, y1, { flip });
  }

  /**
   * @param {number} ax @param {number} az @param {number} bx @param {number} bz
   * @param {number} y0 @param {number} y1
   * @param {{ flip?: boolean, offset?: number, label?: string|null }} [o]
   */
  door(ax, az, bx, bz, y0, y1, { flip = false, offset = 0, label = 'door' } = {}) {
    return this.vertical(label, ax, az, bx, bz, y0, y1, { flip, offset });
  }

  /**
   * Furniture top plane (a rectangle, yaw in house coords).
   * @param {string|null} label
   * @param {number} cx @param {number} cz @param {number} hx @param {number} hz
   * @param {number} y @param {number} [yaw]
   */
  top(label, cx, cz, hx, hz, y, yaw = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    /** @type {number[][]} */ const pts = [];
    for (const [u, v] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]]) pts.push([cx + c * u - s * v, cz + s * u + c * v]);
    return this.horizontal(label, pts, y);
  }

  /**
   * Furniture volume mesh (a box; yaw in house coords, axis 1 = (cos, sin)).
   * @param {string|null} label
   * @param {number} cx @param {number} cz @param {number} hx @param {number} hz
   * @param {number} y0 @param {number} y1
   * @param {{ yaw?: number, zUp?: boolean, vertexCount?: number }} [o]
   */
  box(label, cx, cz, hx, hz, y0, y1, { yaw = 0, zUp = false, vertexCount = 8 } = {}) {
    const [wx, wz] = this.toWorld(cx, cz);
    const [ax, az] = this.dirToWorld(Math.cos(yaw), Math.sin(yaw)); // axis 1
    const bx = -az, bz = ax; // axis 2
    const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2;
    // zUp: local z = up, local x = axis 1, local y = up × x … = −axis 2 (right-handed).
    const pose = zUp
      ? [ax, 0, az, 0, -bx, 0, -bz, 0, 0, 1, 0, 0, wx, cy, wz, 1]
      : [ax, 0, az, 0, 0, 1, 0, 0, bx, 0, bz, 0, wx, cy, wz, 1];
    const min = zUp ? [-hx, -hz, -hy] : [-hx, -hy, -hz];
    const max = zUp ? [hx, hz, hy] : [hx, hy, hz];
    this.meshes.push({ label, pose, min, max, vertexCount });
    return this;
  }

  /** @returns {import('./Layout.js').SpaceSnapshot} */
  build() {
    return JSON.parse(JSON.stringify({ version: 1, space: this.space, planes: this.planes, meshes: this.meshes }));
  }
}
