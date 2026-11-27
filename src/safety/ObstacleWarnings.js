// @ts-check
/**
 * ObstacleWarnings (pure: no three.js, no DOM; allocation-free per frame):
 * the head and both controllers against every mapped wall piece and
 * furniture box (docs/PLAN.md §6.2 "Safe zone during play", gap audit S2).
 *
 * - A hand (controller grip) within 0.25 m, or the head within 0.4 m, of a
 *   mapped box is "near" (5 cm hysteresis). Each near point:
 *     · asks for a haptic pulse 0.3 / 30 ms on entry and every 0.6 s while it
 *       stays near (a hand pulses its own controller; the head pulses both);
 *     · adds the boxes it is near to the outline list (at most 4, nearest
 *       first) with the closest point, for SafetyView's one LineSegments;
 *     · sets `any`, which freezes enemies (PauseManager.setObstacle).
 * - A hand more than r + 0.7 m from the zone centre (horizontally) also asks
 *   for the haptic (PLAN §6.2), without an outline.
 * - `inside`: the head or a hand inside a mapped box (a safety violation
 *   while game time runs; usually a map error).
 *
 * It is only as accurate as the map. Boxes come from `world.shapes`
 * (`box` Float32Array, 8 floats per box; `label` 'wall' for wall pieces;
 * `flags` SHAPE_* bits when present).
 *
 * Roam (`roam = true`, the default play mode): walking past furniture and
 * through doors is normal, so the head threshold is 0.25 m for door jambs and
 * lintels (an 0.85 m door puts each jamb about 0.42 m from its centre) and
 * 0.35 m otherwise; a head that is near asks for `pulseHead` (GameSession
 * turns it into the watch's obstacle cue) instead of pulsing both hands, and
 * no outline is drawn (diegetic cues only). `level[p]` (0 at the threshold, 1
 * at contact) and `headLevel` / `handLevel` grade how near.
 *
 * `writeOutlines()` turns the outline list into line-segment vertices in a
 * caller-owned Float32Array (furniture: the 12 box edges; a wall: a 1.2 m
 * wide patch of the face nearest the point, with a cross at the closest
 * point), so the geometry is testable in Node too.
 */

import { BOX_STRIDE, boxDistance } from './geom.js';

export const OBSTACLE = Object.freeze({
  hand: 0.25,
  head: 0.4,
  /** Roam: the head near a door jamb or lintel / any other box (m). */
  headJambRoam: 0.25,
  headRoam: 0.35,
  hyst: 0.05,
  pulse: 0.3,
  pulseMs: 30,
  repeatS: 0.6,
  /** A hand beyond r + this from the zone centre pulses (m). */
  reachExtra: 0.7,
  maxOutlines: 4,
  /** Half width of the outlined wall patch (m). */
  wallHalf: 0.6,
  /** Outlined wall / furniture height above the floor at most (m). */
  maxHeight: 2.4,
  /** The outline moves when a closest point moved this far (m). */
  moveEps: 0.03,
});

/** Points: the head, the left grip, the right grip. */
export const POINT = Object.freeze({ HEAD: 0, LEFT: 1, RIGHT: 2 });
/** Line-segment vertices written per outlined box (at most). */
export const OUTLINE_VERTS = 24;

export class ObstacleWarnings {
  /** @param {{ maxOutlines?: number, roam?: boolean }} [o] */
  constructor({ maxOutlines = OBSTACLE.maxOutlines, roam = false } = {}) {
    this.max = maxOutlines;
    /** Roam thresholds and cues (see the header). */
    this.roam = roam;
    /** Nearness per point: 0 at the threshold … 1 touching. */
    this.level = new Float64Array(3);
    this.headLevel = 0;
    this.handLevel = 0;
    /** The head is near (Roam: the watch's obstacle cue; spot play also pulses both hands). */
    this.pulseHead = false;
    // points
    this.px = new Float64Array(3);
    this.py = new Float64Array(3);
    this.pz = new Float64Array(3);
    this.valid = new Uint8Array(3);
    /** Nearest box distance per point (Infinity = none). */
    this.dist = new Float64Array(3).fill(Infinity);
    this.nearBox = new Int32Array(3).fill(-1);
    /** Near state per point (with hysteresis). */
    this.near = new Uint8Array(3);
    this.repeatT = new Float64Array(3);
    this.reachOut = new Uint8Array(3);
    this.reachT = new Float64Array(3);
    // candidates this frame (3 points × max)
    const cn = 3 * maxOutlines;
    this.cBox = new Int32Array(cn);
    this.cPt = new Uint8Array(cn);
    this.cDist = new Float64Array(cn);
    this.cXYZ = new Float64Array(cn * 3);
    this.cN = 0;
    this._q = new Float64Array(3);
    // outputs
    this.any = false;
    this.headNear = false;
    this.inside = false;
    this.pulseL = false;
    this.pulseR = false;
    /** Outlined boxes this frame, nearest first. */
    this.count = 0;
    this.boxes = new Int32Array(maxOutlines);
    /** Which point each outline belongs to (POINT). */
    this.owner = new Uint8Array(maxOutlines);
    this.odist = new Float64Array(maxOutlines);
    /** Closest point on the box, and the point that is near it. */
    this.closest = new Float64Array(maxOutlines * 3);
    this.query = new Float64Array(maxOutlines * 3);
    this._prevBoxes = new Int32Array(maxOutlines).fill(-1);
    this._prevClosest = new Float64Array(maxOutlines * 3);
    this._prevCount = 0;
    /** Bumped whenever the outline set or a closest point moved: rewrite the geometry. */
    this.version = 0;
    this.warnings = 0;
  }

  /** @param {number} i POINT @param {number} x @param {number} y @param {number} z */
  setPoint(i, x, y, z) {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.valid[i] = 1;
    } else this.valid[i] = 0;
  }

  /** @param {number} i POINT */
  clearPoint(i) { this.valid[i] = 0; }

  /**
   * A controller grip pose (column-major 4×4, as Input keeps it), or null.
   * @param {number} i POINT.LEFT / POINT.RIGHT
   * @param {ArrayLike<number>|null} m
   */
  setGrip(i, m) {
    if (m) this.setPoint(i, m[12], m[13], m[14]);
    else this.valid[i] = 0;
  }

  reset() {
    this.near.fill(0);
    this.reachOut.fill(0);
    this.repeatT.fill(0);
    this.reachT.fill(0);
    this.dist.fill(Infinity);
    this.nearBox.fill(-1);
    this.any = this.headNear = this.inside = this.pulseL = this.pulseR = this.pulseHead = false;
    this.level.fill(0);
    this.headLevel = this.handLevel = 0;
    this.count = 0;
    this._prevCount = 0;
    this._prevBoxes.fill(-1);
    this.version++;
  }

  /**
   * One frame.
   * @param {number} dt
   * @param {{ box: Float32Array, count: number }|null|undefined} shapes world.shapes (null: no map)
   * @param {{ x: number, z: number, r: number }|null} [zone] for the hand-reach pulse
   */
  update(dt, shapes, zone = null) {
    if (!(dt >= 0)) dt = 0;
    this.pulseL = this.pulseR = this.pulseHead = false;
    this.inside = false;
    this.cN = 0;
    const B = shapes && shapes.box ? shapes.box : null;
    const n = B && shapes ? shapes.count : 0;
    const F = shapes && /** @type {any} */ (shapes).flags ? /** @type {Uint8Array} */ (/** @type {any} */ (shapes).flags) : null;
    const roam = this.roam;
    let any = false;
    for (let p = 0; p < 3; p++) {
      if (!this.valid[p]) { this.near[p] = 0; this.dist[p] = Infinity; this.nearBox[p] = -1; this.reachOut[p] = 0; this.level[p] = 0; continue; }
      const head = p === POINT.HEAD;
      const th0 = head ? (roam ? OBSTACLE.headRoam : OBSTACLE.head) : OBSTACLE.hand;
      const x = this.px[p], y = this.py[p], z = this.pz[p];
      // nearest box by its margin to that box's own threshold (Roam: jambs and lintels are allowed closer)
      let best = Infinity, bi = -1, bestE = Infinity, bestTh = th0;
      for (let i = 0, o = 0; i < n; i++, o += BOX_STRIDE) {
        const d = boxDistance(/** @type {Float32Array} */ (B), o, x, y, z, this._q, 0);
        const th = head && roam && F && (F[i] & 9) !== 0 ? OBSTACLE.headJambRoam : th0; // SHAPE_JAMB | SHAPE_LINTEL
        const e = d - th;
        if (d < best) { best = d; bi = i; }
        if (e < bestE) { bestE = e; bestTh = th; }
        if (e < OBSTACLE.hyst) this.addCandidate(i, p, d);
      }
      this.dist[p] = best;
      this.nearBox[p] = bi;
      if (best <= 0) this.inside = true;
      const was = this.near[p] === 1;
      const now = was ? bestE < OBSTACLE.hyst : bestE < 0;
      this.near[p] = now ? 1 : 0;
      const lv = now ? 1 - (bestE + bestTh) / bestTh : 0;
      this.level[p] = lv < 0 ? 0 : lv > 1 ? 1 : lv;
      if (now) {
        any = true;
        if (!was) { this.repeatT[p] = 0; this.warnings++; this.ask(p); }
        else {
          this.repeatT[p] += dt;
          if (this.repeatT[p] >= OBSTACLE.repeatS) { this.repeatT[p] = 0; this.ask(p); }
        }
      }
      // hand far outside the zone
      if (p !== POINT.HEAD && zone && zone.r > 0) {
        const dx = x - zone.x, dz = z - zone.z;
        const lim = zone.r + OBSTACLE.reachExtra;
        const d2 = Math.sqrt(dx * dx + dz * dz);
        const wasOut = this.reachOut[p] === 1;
        const out = wasOut ? d2 > lim - OBSTACLE.hyst : d2 > lim;
        this.reachOut[p] = out ? 1 : 0;
        if (out) {
          if (!wasOut) { this.reachT[p] = 0; this.ask(p); }
          else {
            this.reachT[p] += dt;
            if (this.reachT[p] >= OBSTACLE.repeatS) { this.reachT[p] = 0; this.ask(p); }
          }
        }
      } else this.reachOut[p] = 0;
    }
    this.any = any;
    this.headNear = this.near[POINT.HEAD] === 1;
    this.headLevel = this.level[POINT.HEAD];
    this.handLevel = this.level[POINT.LEFT] > this.level[POINT.RIGHT] ? this.level[POINT.LEFT] : this.level[POINT.RIGHT];
    if (roam) { this.count = 0; return; } // Roam: diegetic cues only, no outline
    this.pickOutlines();
  }

  /** @param {boolean} on Roam thresholds and cues */
  setRoam(on) {
    if (this.roam === !!on) return;
    this.roam = !!on;
    this.reset();
  }

  /** @param {number} p */
  ask(p) {
    if (p === POINT.LEFT) this.pulseL = true;
    else if (p === POINT.RIGHT) this.pulseR = true;
    else {
      this.pulseHead = true;
      if (!this.roam) { this.pulseL = true; this.pulseR = true; }
    }
  }

  /** @param {number} box @param {number} p @param {number} d */
  addCandidate(box, p, d) {
    if (this.cN >= this.cBox.length) {
      // full: replace the farthest if this one is nearer
      let w = 0;
      for (let i = 1; i < this.cN; i++) if (this.cDist[i] > this.cDist[w]) w = i;
      if (this.cDist[w] <= d) return;
      this.writeCandidate(w, box, p, d);
      return;
    }
    this.writeCandidate(this.cN++, box, p, d);
  }

  /** @param {number} k @param {number} box @param {number} p @param {number} d */
  writeCandidate(k, box, p, d) {
    this.cBox[k] = box;
    this.cPt[k] = p;
    this.cDist[k] = d;
    this.cXYZ[k * 3] = this._q[0];
    this.cXYZ[k * 3 + 1] = this._q[1];
    this.cXYZ[k * 3 + 2] = this._q[2];
  }

  /** The nearest distinct boxes of the points that are near (nearest first). */
  pickOutlines() {
    let m = 0;
    const max = this.max;
    // selection by repeated minimum (cN ≤ 12)
    while (m < max) {
      let bi = -1;
      for (let i = 0; i < this.cN; i++) {
        if (!this.near[this.cPt[i]]) continue;
        if (bi < 0 || this.cDist[i] < this.cDist[bi]) bi = i;
      }
      if (bi < 0) break;
      const box = this.cBox[bi];
      let dup = false;
      for (let j = 0; j < m; j++) if (this.boxes[j] === box) { dup = true; break; }
      if (!dup) {
        this.boxes[m] = box;
        this.owner[m] = this.cPt[bi];
        this.odist[m] = this.cDist[bi];
        const p = this.cPt[bi];
        for (let a = 0; a < 3; a++) this.closest[m * 3 + a] = this.cXYZ[bi * 3 + a];
        this.query[m * 3] = this.px[p];
        this.query[m * 3 + 1] = this.py[p];
        this.query[m * 3 + 2] = this.pz[p];
        m++;
      }
      this.consume(bi);
    }
    this.count = m;
    // changed?
    let changed = m !== this._prevCount;
    const eps2 = OBSTACLE.moveEps * OBSTACLE.moveEps;
    for (let j = 0; j < m && !changed; j++) {
      if (this.boxes[j] !== this._prevBoxes[j]) { changed = true; break; }
      const dx = this.closest[j * 3] - this._prevClosest[j * 3];
      const dy = this.closest[j * 3 + 1] - this._prevClosest[j * 3 + 1];
      const dz = this.closest[j * 3 + 2] - this._prevClosest[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > eps2) changed = true;
    }
    if (changed) {
      this.version++;
      this._prevCount = m;
      for (let j = 0; j < m; j++) {
        this._prevBoxes[j] = this.boxes[j];
        this._prevClosest[j * 3] = this.closest[j * 3];
        this._prevClosest[j * 3 + 1] = this.closest[j * 3 + 1];
        this._prevClosest[j * 3 + 2] = this.closest[j * 3 + 2];
      }
    }
  }

  /** Drop candidate k from further selection. @param {number} k */
  consume(k) {
    const last = --this.cN;
    if (k !== last) {
      this.cBox[k] = this.cBox[last];
      this.cPt[k] = this.cPt[last];
      this.cDist[k] = this.cDist[last];
      this.cXYZ[k * 3] = this.cXYZ[last * 3];
      this.cXYZ[k * 3 + 1] = this.cXYZ[last * 3 + 1];
      this.cXYZ[k * 3 + 2] = this.cXYZ[last * 3 + 2];
    }
  }
}

/**
 * Write the outline line segments (pairs of vertices) for the current
 * outline list into `pos` (x, y, z per vertex).
 * @param {Float32Array} pos capacity ≥ ow.max × OUTLINE_VERTS × 3
 * @param {ObstacleWarnings} ow
 * @param {{ box: Float32Array, count: number, label?: string[] }} shapes
 * @param {((x: number, z: number) => number)|null} floorY
 * @returns {number} vertices written
 */
export function writeOutlines(pos, ow, shapes, floorY) {
  let v = 0;
  const cap = Math.floor(pos.length / 3);
  for (let j = 0; j < ow.count; j++) {
    if (v + OUTLINE_VERTS > cap) break;
    const b = ow.boxes[j];
    if (b < 0 || b >= shapes.count) continue;
    const o = b * BOX_STRIDE;
    const B = shapes.box;
    const fy = floorY ? floorY(B[o], B[o + 1]) : 0;
    const isWall = !!(shapes.label && shapes.label[b] === 'wall');
    if (isWall) v = writeWallPatch(pos, v, B, o, ow.query[j * 3], ow.query[j * 3 + 1], ow.query[j * 3 + 2], fy);
    else v = writeBoxEdges(pos, v, B, o, fy);
  }
  return v;
}

/**
 * @param {Float32Array} pos @param {number} v @param {number} x @param {number} y @param {number} z
 */
function put(pos, v, x, y, z) {
  const k = v * 3;
  pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
  return v + 1;
}

/**
 * The 12 edges of a furniture box (bottom clamped to the floor). 24 vertices.
 * @param {Float32Array} pos @param {number} v @param {ArrayLike<number>} B @param {number} o @param {number} fy
 */
export function writeBoxEdges(pos, v, B, o, fy) {
  const cx = B[o], cz = B[o + 1], c = B[o + 2], s = B[o + 3], hx = B[o + 4], hz = B[o + 5];
  const y0 = Math.max(B[o + 6], fy), y1 = Math.min(B[o + 7], y0 + OBSTACLE.maxHeight);
  // corners (local ±hx, ±hz): x = cx + lx·c − lz·s, z = cz + lx·s + lz·c
  const ax = hx * c, az = hx * s, bx = -hz * s, bz = hz * c;
  const x0 = cx - ax - bx, z0 = cz - az - bz;
  const x1 = cx + ax - bx, z1 = cz + az - bz;
  const x2 = cx + ax + bx, z2 = cz + az + bz;
  const x3 = cx - ax + bx, z3 = cz - az + bz;
  for (let k = 0; k < 2; k++) {
    const y = k === 0 ? y0 : y1;
    v = put(pos, v, x0, y, z0); v = put(pos, v, x1, y, z1);
    v = put(pos, v, x1, y, z1); v = put(pos, v, x2, y, z2);
    v = put(pos, v, x2, y, z2); v = put(pos, v, x3, y, z3);
    v = put(pos, v, x3, y, z3); v = put(pos, v, x0, y, z0);
  }
  v = put(pos, v, x0, y0, z0); v = put(pos, v, x0, y1, z0);
  v = put(pos, v, x1, y0, z1); v = put(pos, v, x1, y1, z1);
  v = put(pos, v, x2, y0, z2); v = put(pos, v, x2, y1, z2);
  v = put(pos, v, x3, y0, z3); v = put(pos, v, x3, y1, z3);
  return v;
}

/**
 * A wall piece: a patch of the face on the near side, up to 1.2 m wide
 * around the closest point, floor to 2.4 m (or the piece's own extent, e.g.
 * a lintel), plus a cross through the closest point. 12 vertices.
 * @param {Float32Array} pos @param {number} v @param {ArrayLike<number>} B @param {number} o
 * @param {number} qx @param {number} qy @param {number} qz the near point (head or hand)
 * @param {number} fy floor height
 */
export function writeWallPatch(pos, v, B, o, qx, qy, qz, fy) {
  const cx = B[o], cz = B[o + 1], c = B[o + 2], s = B[o + 3], hx = B[o + 4], hz = B[o + 5];
  const rx = qx - cx, rz = qz - cz;
  const lx = rx * c + rz * s, lz = rz * c - rx * s;
  // long axis u, thin axis w (both as local unit vectors in world x/z)
  const longX = hx >= hz;
  const ux = longX ? c : -s, uz = longX ? s : c;
  const wx = longX ? -s : c, wz = longX ? c : s;
  const hl = longX ? hx : hz, ht = longX ? hz : hx;
  const lu = longX ? lx : lz, lw = longX ? lz : lx;
  const side = lw < 0 ? -1 : 1;
  const off = side * (ht + 0.005);
  const mid = lu < -hl ? -hl : lu > hl ? hl : lu;
  const u0 = Math.max(-hl, mid - OBSTACLE.wallHalf), u1 = Math.min(hl, mid + OBSTACLE.wallHalf);
  const yb = Math.max(B[o + 6], fy), yt = Math.min(B[o + 7], yb + OBSTACLE.maxHeight);
  const ym = qy < yb ? yb : qy > yt ? yt : qy;
  const px = cx + wx * off, pz = cz + wz * off;
  const ax = px + ux * u0, az = pz + uz * u0;
  const bx = px + ux * u1, bz = pz + uz * u1;
  const mx = px + ux * mid, mz = pz + uz * mid;
  v = put(pos, v, ax, yb, az); v = put(pos, v, bx, yb, bz);
  v = put(pos, v, bx, yb, bz); v = put(pos, v, bx, yt, bz);
  v = put(pos, v, bx, yt, bz); v = put(pos, v, ax, yt, az);
  v = put(pos, v, ax, yt, az); v = put(pos, v, ax, yb, az);
  v = put(pos, v, ax, ym, az); v = put(pos, v, bx, ym, bz);
  v = put(pos, v, mx, yb, mz); v = put(pos, v, mx, yt, mz);
  return v;
}
