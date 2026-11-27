// @ts-check
/**
 * What the learned grid says about the house (v0.5; the learner worker):
 * where Space Setup's walls are contradicted (openings), floors beyond (or
 * at another height than) Space Setup's, walls and furniture tops Space
 * Setup does not have, and how many rooms the walk found. House frame in,
 * house frame out; `overlay.js` turns it into snapshot planes for the world
 * build.
 *
 * Rules (every threshold is a named constant below):
 * - Opening in a Space Setup wall: the head path crosses the wall line there
 *   (walked cells on the wall line AND on both sides of it: people do not
 *   walk through walls), or (no walk) lines of sight crossed it at wall
 *   height in every cell across the wall's thickness, ≥ 0.7 m wide, with
 *   almost no hits. A walked crossing opens at least a door's width (0.8 m).
 *   Spans an open Space Setup door already covers are skipped.
 * - Floor: cells walked, or with ≥ 3 floor hits (observed: walked or ≥ 2); where Space Setup has no
 *   floor, or (≥ 0.5 m² together) where the measured floor is more than 4 cm
 *   off Space Setup's, merged into rectangles of 20 cm blocks with heights on
 *   a 2 cm step. In the world build the smaller floor polygon wins, so the
 *   measured height overrides there.
 * - New wall: runs (house-frame axes, ≥ 0.6 m, ≤ 3 cells thick) of cells with
 *   wall-height hits and few lines of sight through them, away from Space
 *   Setup's walls and from walked cells, near an observed floor.
 * - Furniture top: components of cells with a top 0.3–1.25 m above the floor
 *   (≥ 3 hits), away from Space Setup's volumes and walls, never walked.
 * - Rooms: components of observed floor between walls (Space Setup's, minus
 *   doors and openings, and the learned ones), ≥ 2 m².
 *
 * Pure: no three.js, no DOM. Allocates (a dense window over the grid's
 * bounds): it runs in the worker every few seconds, never in a frame.
 */
import { CELL, CELLS, CHUNK, NO_FLOOR } from './HouseGrid.js';
import { apply, planePoints } from './houseFrame.js';

export const OPEN = Object.freeze({ crossR: 0.25, nearR: 1, freeMin: 6, freeWidth: 0.7, walkWidth: 0.8, step: 0.05, minWalkSpan: 0.2, doorH: 2.03 });
export const FLOOR = Object.freeze({ minHits: 3, offMm: 40, overrideM2: 0.5, block: 2, stepMm: 20, maxRects: 40, minRectM2: 0.16 });
export const WALL = Object.freeze({ minOcc: 3, minRun: 6, ssBand: 0.3, maxThick: 3, height: 2.4, maxWalls: 32 });
export const TOP = Object.freeze({ minW: 3, lo: 0.3, hi: 1.25, minCells: 4, minCellsInSS: 9, pad: 0.12, maxBoxes: 24 });
export const ROOM_MIN_CELLS = 200;

/** @param {string|null} l */
function norm(l) { return l ? l.toLowerCase().trim().replace(/[_-]+/g, ' ') : ''; }

/**
 * Space Setup's geometry in the house frame (walls as segments, doors, floor polygons with a height raster,
 * furniture volumes as oriented rectangles). Build time.
 * @param {{ planes: any[], meshes: any[], scanBase?: { planes: number, meshes: number } }|null} snap
 * @param {ArrayLike<number>} H session → house
 */
export function ssGeometry(snap, H) {
  /** @type {{ ax: number, az: number, bx: number, bz: number, y0: number, y1: number, tx: number, tz: number, nx: number, nz: number, len: number }[]} */ const walls = [];
  /** @type {{ cx: number, cz: number, tx: number, tz: number, w: number }[]} */ const doors = [];
  /** @type {{ xs: Float64Array, zs: Float64Array, y: number, area: number }[]} */ const floors = [];
  /** @type {{ cx: number, cz: number, ux: number, uz: number, hx: number, hz: number, y0: number, y1: number }[]} */ const boxes = [];
  const o = [0, 0, 0];
  const nP = snap && snap.scanBase ? snap.scanBase.planes : snap ? snap.planes.length : 0;
  const nM = snap && snap.scanBase ? snap.scanBase.meshes : snap ? snap.meshes.length : 0;
  for (let k = 0; k < nP; k++) {
    const p = /** @type {any} */ (snap).planes[k];
    const l = norm(p.label);
    const W = planePoints(p);
    const n = W.xs.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
    for (let i = 0; i < n; i++) { apply(H, W.xs[i], W.ys[i], W.zs[i], o); xs[i] = o[0]; ys[i] = o[1]; zs[i] = o[2]; }
    if (p.orientation === 'horizontal') {
      if (l !== 'floor') continue;
      let a = 0, y = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) a += xs[j] * zs[i] - xs[i] * zs[j];
      for (let i = 0; i < n; i++) y += ys[i];
      floors.push({ xs, zs, y: y / n, area: Math.abs(a / 2) });
      continue;
    }
    // vertical: the plane's normal (pose y axis) in the house frame
    const m = p.pose;
    let nx = H[0] * m[4] + H[8] * m[6], nz = H[2] * m[4] + H[10] * m[6];
    const hl = Math.hypot(nx, nz);
    if (hl < 0.7) continue;
    nx /= hl; nz /= hl;
    const tx = -nz, tz = nx;
    let u0 = Infinity, u1 = -Infinity, v = 0, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = xs[i] * tx + zs[i] * tz;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      v += xs[i] * nx + zs[i] * nz;
      if (ys[i] < y0) y0 = ys[i];
      if (ys[i] > y1) y1 = ys[i];
    }
    v /= n;
    if (!(u1 - u0 > 0.05)) continue;
    if (l === 'wall' || l === 'wall face') {
      walls.push({ ax: tx * u0 + nx * v, az: tz * u0 + nz * v, bx: tx * u1 + nx * v, bz: tz * u1 + nz * v, y0, y1, tx, tz, nx, nz, len: u1 - u0 });
    } else if (l === 'door' || l === 'door frame' || l === 'doorframe' || l === 'opening') {
      const um = (u0 + u1) / 2;
      doors.push({ cx: tx * um + nx * v, cz: tz * um + nz * v, tx, tz, w: u1 - u0 });
    }
  }
  for (let k = 0; k < nM; k++) {
    const b = /** @type {any} */ (snap).meshes[k];
    const l = norm(b.label);
    if (l === 'global mesh' || l === 'mesh' || l === 'wall' || l === 'floor' || l === 'ceiling') continue;
    const m = b.pose;
    if (Math.abs(b.max[0] - b.min[0]) > 6 || Math.abs(b.max[2] - b.min[2]) > 6) continue; // a room-sized volume is not furniture
    const lx = (b.min[0] + b.max[0]) / 2, ly = (b.min[1] + b.max[1]) / 2, lz = (b.min[2] + b.max[2]) / 2;
    const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12], wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13], wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    apply(H, wx, wy, wz, o);
    const ux0 = H[0] * m[0] + H[8] * m[2], uz0 = H[2] * m[0] + H[10] * m[2], ul = Math.hypot(ux0, uz0) || 1;
    const hy = Math.abs(b.max[1] - b.min[1]) / 2;
    boxes.push({ cx: o[0], cz: o[2], ux: ux0 / ul, uz: uz0 / ul, hx: Math.abs(b.max[0] - b.min[0]) / 2, hz: Math.abs(b.max[2] - b.min[2]) / 2, y0: o[1] - hy, y1: o[1] + hy });
  }
  // floor-height raster (0.2 m): the smallest floor polygon containing the cell centre (the world build's rule)
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const f of floors) for (let i = 0; i < f.xs.length; i++) { x0 = Math.min(x0, f.xs[i]); x1 = Math.max(x1, f.xs[i]); z0 = Math.min(z0, f.zs[i]); z1 = Math.max(z1, f.zs[i]); }
  const R = 0.2;
  const rw = floors.length ? Math.max(1, Math.ceil((x1 - x0) / R)) : 0, rh = floors.length ? Math.max(1, Math.ceil((z1 - z0) / R)) : 0;
  const raster = new Float32Array(rw * rh).fill(NaN);
  const byArea = floors.slice().sort((a, b) => a.area - b.area);
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      const x = x0 + (i + 0.5) * R, z = z0 + (j + 0.5) * R;
      for (const f of byArea) if (inPoly(f.xs, f.zs, x, z)) { raster[j * rw + i] = f.y; break; }
    }
  }
  const floorAt = (/** @type {number} */ x, /** @type {number} */ z) => {
    if (!rw) return NaN;
    const i = Math.floor((x - x0) / R), j = Math.floor((z - z0) / R);
    return i < 0 || j < 0 || i >= rw || j >= rh ? NaN : raster[j * rw + i];
  };
  let ssArea = 0;
  for (const f of floors) ssArea += f.area;
  const floorRef = floors.length ? byArea[byArea.length - 1].y : 0;
  return { walls, doors, floors, boxes, floorAt, ssArea, floorRef };
}

/** @typedef {ReturnType<typeof ssGeometry>} SSGeometry */

/** @param {Float64Array} xs @param {Float64Array} zs @param {number} x @param {number} z */
function inPoly(xs, zs, x, z) {
  let c = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if ((zs[i] > z) !== (zs[j] > z) && x < ((xs[j] - xs[i]) * (z - zs[i])) / (zs[j] - zs[i]) + xs[i]) c = !c;
  }
  return c;
}

/**
 * @typedef {{ cx: number, cz: number, tx: number, tz: number, w: number, y0: number, y1: number, walked: boolean, wall: number }} Opening
 * @typedef {{ x0: number, z0: number, x1: number, z1: number, y: number }} FloorRect
 * @typedef {{ ax: number, az: number, bx: number, bz: number, y0: number, y1: number }} LearnedWall
 * @typedef {{ cx: number, cz: number, hx: number, hz: number, y0: number, y1: number }} LearnedBox
 * @typedef {{ v: number, openings: Opening[], floors: FloorRect[], walls: LearnedWall[], boxes: LearnedBox[], walked: number[],
 *   rooms: number, observedM2: number, coverage: number, newFloorM2: number, chunks: number, key: string, ms: number }} ScanResult
 */

/**
 * Analyse the grid against Space Setup.
 * @param {import('./HouseGrid.js').HouseGrid} grid @param {SSGeometry} ss
 * @returns {ScanResult}
 */
export function analyzeHouse(grid, ss) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  /** @type {ScanResult} */
  const res = { v: 1, openings: [], floors: [], walls: [], boxes: [], walked: [], rooms: 0, observedM2: 0, coverage: 0, newFloorM2: 0, chunks: grid.chunkCount, key: '', ms: 0 };
  const b = grid.cellBounds();
  if (!b) { res.key = 'empty'; return res; }
  // a dense window over the used chunks (plus a margin of nothing): index (gz − gz0) · W + (gx − gx0)
  const gx0 = b[0], gz0 = b[1], W = b[2] - b[0], Hh = b[3] - b[1];
  const N = W * Hh;
  const floor = new Int16Array(N).fill(NO_FLOOR), fw = new Uint8Array(N), top = new Int16Array(N).fill(NO_FLOOR), tw = new Uint8Array(N);
  const occ = new Uint8Array(N), free = new Uint8Array(N), walked = new Uint8Array(N);
  for (let s = 0; s < grid.maxChunks; s++) {
    if (!grid.used[s]) continue;
    const ox = grid.cx[s] * CHUNK - gx0, oz = grid.cz[s] * CHUNK - gz0, a = s * CELLS;
    for (let j = 0; j < CHUNK; j++) {
      const row = (oz + j) * W + ox, src = a + j * CHUNK;
      for (let i = 0; i < CHUNK; i++) {
        const d = row + i, c = src + i;
        floor[d] = grid.floor[c]; fw[d] = grid.floorW[c]; top[d] = grid.top[c]; tw[d] = grid.topW[c];
        occ[d] = grid.occ[c]; free[d] = grid.free[c]; walked[d] = grid.walked[c];
      }
    }
  }
  const cx = (/** @type {number} */ i) => (gx0 + (i % W) + 0.5) * CELL;
  const cz = (/** @type {number} */ i) => (gz0 + Math.floor(i / W) + 0.5) * CELL;
  const idx = (/** @type {number} */ x, /** @type {number} */ z) => {
    const i = Math.floor(x / CELL) - gx0, j = Math.floor(z / CELL) - gz0;
    return i < 0 || j < 0 || i >= W || j >= Hh ? -1 : j * W + i;
  };
  /** any walked cell within r (m) of (x, z) */
  const walkedNear = (/** @type {number} */ x, /** @type {number} */ z, /** @type {number} */ r) => {
    const k = Math.ceil(r / CELL);
    const i0 = Math.floor(x / CELL) - gx0, j0 = Math.floor(z / CELL) - gz0;
    for (let j = j0 - k; j <= j0 + k; j++) {
      if (j < 0 || j >= Hh) continue;
      for (let i = i0 - k; i <= i0 + k; i++) {
        if (i < 0 || i >= W) continue;
        if (walked[j * W + i] && Math.hypot((gx0 + i + 0.5) * CELL - x, (gz0 + j + 0.5) * CELL - z) <= r + 0.071) return true;
      }
    }
    return false;
  };
  const seeThrough = (/** @type {number} */ x, /** @type {number} */ z) => {
    const c = idx(x, z);
    return c >= 0 && free[c] >= OPEN.freeMin && occ[c] * 4 <= free[c];
  };
  /** the measured floor near a cell (the cell, else its 8 neighbours), else Space Setup's, else the reference */
  const floorNear = (/** @type {number} */ x, /** @type {number} */ z) => {
    const c = idx(x, z);
    if (c >= 0 && fw[c] >= 2) return floor[c] / 1000;
    if (c >= 0) {
      let s = 0, n = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const i = (c % W) + di, j = Math.floor(c / W) + dj;
        if (i < 0 || j < 0 || i >= W || j >= Hh) continue;
        const d = j * W + i;
        if (fw[d] >= 2) { s += floor[d]; n++; }
      }
      if (n) return s / n / 1000;
    }
    const p = ss.floorAt(x, z);
    return p === p ? p : ss.floorRef;
  };

  // ── openings in Space Setup's walls ──
  const S = OPEN.step;
  for (let wi = 0; wi < ss.walls.length; wi++) {
    const w = ss.walls[wi];
    const n = Math.floor(w.len / S);
    if (n < 2) continue;
    const pass = new Uint8Array(n); // 1 seen through, 2 walked across
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) * S, x = w.ax + w.tx * u, z = w.az + w.tz * u;
      const R = OPEN.crossR;
      if (walkedNear(x, z, 0.15) && walkedNear(x + w.nx * R, z + w.nz * R, 0.15) && walkedNear(x - w.nx * R, z - w.nz * R, 0.15)) pass[k] = 2;
      else if (seeThrough(x, z) && seeThrough(x + w.nx * 0.1, z + w.nz * 0.1) && seeThrough(x - w.nx * 0.1, z - w.nz * 0.1)) pass[k] = 1;
    }
    let k = 0;
    while (k < n) {
      if (!pass[k]) { k++; continue; }
      let e = k, walk = false;
      while (e < n && pass[e]) { if (pass[e] === 2) walk = true; e++; }
      const L = (e - k) * S;
      const ok = walk ? L >= OPEN.minWalkSpan : L >= OPEN.freeWidth;
      if (ok) {
        let u0 = k * S, u1 = e * S;
        if (walk && u1 - u0 < OPEN.walkWidth) { const m = (u0 + u1) / 2; u0 = m - OPEN.walkWidth / 2; u1 = m + OPEN.walkWidth / 2; }
        u0 = Math.max(0.02, u0); u1 = Math.min(w.len - 0.02, u1);
        const um = (u0 + u1) / 2, x = w.ax + w.tx * um, z = w.az + w.tz * um;
        // an open Space Setup door already there?
        let covered = false;
        for (const d of ss.doors) {
          const off = Math.abs((d.cx - w.ax) * w.nx + (d.cz - w.az) * w.nz);
          if (off > 0.3 || Math.abs(d.tx * w.tx + d.tz * w.tz) < 0.9) continue;
          const du = (d.cx - w.ax) * w.tx + (d.cz - w.az) * w.tz;
          const lo = Math.max(u0, du - d.w / 2), hi = Math.min(u1, du + d.w / 2);
          if (hi - lo > 0.5 * (u1 - u0)) { covered = true; break; }
        }
        if (!covered && u1 - u0 > 0.15) {
          const y0 = Math.min(floorNear(x + w.nx * 0.3, z + w.nz * 0.3), floorNear(x - w.nx * 0.3, z - w.nz * 0.3));
          res.openings.push({ cx: x, cz: z, tx: w.tx, tz: w.tz, w: u1 - u0, y0, y1: y0 + OPEN.doorH, walked: walk, wall: wi });
        }
      }
      k = e;
    }
  }

  // ── observed floor and where it adds to / overrides Space Setup ──
  const observed = new Uint8Array(N);
  const cand = new Int16Array(N).fill(NO_FLOOR); // candidate floor height (mm) where a learned floor is due
  let nObs = 0, nInSS = 0;
  for (let i = 0; i < N; i++) {
    if (!(walked[i] || fw[i] >= 2)) continue;
    observed[i] = 1;
    nObs++;
    const x = cx(i), z = cz(i);
    const p = ss.floorAt(x, z);
    if (p === p) nInSS++;
    if (!(walked[i] || fw[i] >= FLOOR.minHits)) continue;
    const h = fw[i] >= 2 ? floor[i] : Math.round(floorNear(x, z) * 1000);
    if (!(p === p)) cand[i] = h;
    else if (fw[i] >= FLOOR.minHits && Math.abs(floor[i] - p * 1000) > FLOOR.offMm) cand[i] = floor[i];
  }
  res.observedM2 = nObs * CELL * CELL;
  res.coverage = ss.ssArea > 0 ? Math.min(1, (nInSS * CELL * CELL) / ss.ssArea) : nObs > 0 ? 1 : 0;
  res.floors = floorRects(cand, W, Hh, gx0, gz0, ss);
  for (const f of res.floors) res.newFloorM2 += (f.x1 - f.x0) * (f.z1 - f.z0);

  // ── new walls (outside Space Setup's walls, not walked, near an observed floor) ──
  const wallC = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (occ[i] < WALL.minOcc || occ[i] < 2 * free[i] + 2 || walked[i]) continue;
    const x = cx(i), z = cz(i);
    if (nearSSWall(ss, x, z, WALL.ssBand)) continue;
    if (!nearObserved(observed, W, Hh, i, 4)) continue;
    wallC[i] = 1;
  }
  res.walls = wallRuns(wallC, walked, W, Hh, gx0, gz0, floorNear);

  // ── furniture tops ──
  const topC = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (tw[i] < TOP.minW || walked[i] || top[i] === NO_FLOOR) continue;
    const x = cx(i), z = cz(i), f = floorNear(x, z), h = top[i] / 1000 - f;
    if (h < TOP.lo || h > TOP.hi) continue;
    if (inSSBox(ss, x, z, TOP.pad) || nearSSWall(ss, x, z, 0.15)) continue;
    topC[i] = 1;
  }
  res.boxes = topBoxes(topC, top, W, Hh, gx0, gz0, ss, floorNear);

  // ── walked points (every 0.3 m) for the world build's unscanned-space rule ──
  for (let j = 0; j < Hh; j += 3) for (let i = 0; i < W; i += 3) {
    let any = false;
    for (let dj = 0; dj < 3 && !any; dj++) for (let di = 0; di < 3 && !any; di++) if (j + dj < Hh && i + di < W && walked[(j + dj) * W + i + di]) any = true;
    if (any && res.walked.length < 1200) res.walked.push(Math.round((gx0 + i + 1.5) * CELL * 1000) / 1000, Math.round((gz0 + j + 1.5) * CELL * 1000) / 1000);
  }

  // ── rooms: observed floor between walls ──
  res.rooms = countRooms(observed, W, Hh, gx0, gz0, ss, res);
  res.key = resultKey(res);
  res.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return res;
}

/** @param {SSGeometry} ss @param {number} x @param {number} z @param {number} r */
function nearSSWall(ss, x, z, r) {
  for (const w of ss.walls) {
    const u = (x - w.ax) * w.tx + (z - w.az) * w.tz;
    if (u < -r || u > w.len + r) continue;
    if (Math.abs((x - w.ax) * w.nx + (z - w.az) * w.nz) <= r) return true;
  }
  return false;
}

/** @param {SSGeometry} ss @param {number} x @param {number} z @param {number} pad */
function inSSBox(ss, x, z, pad) {
  for (const b of ss.boxes) {
    const dx = x - b.cx, dz = z - b.cz;
    const u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux;
    if (Math.abs(u) <= b.hx + pad && Math.abs(v) <= b.hz + pad) return true;
  }
  return false;
}

/** @param {Uint8Array} obs @param {number} W @param {number} H @param {number} i @param {number} r cells */
function nearObserved(obs, W, H, i, r) {
  const x = i % W, z = (i - x) / W;
  for (let j = Math.max(0, z - r); j <= Math.min(H - 1, z + r); j++) for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (obs[j * W + k]) return true;
  return false;
}

/**
 * Candidate floor cells → rectangles of 20 cm blocks on a 2 cm height step (greedy), small ones dropped,
 * overrides inside Space Setup's floors kept only when they add up to ≥ 0.5 m² at one height.
 * @param {Int16Array} cand @param {number} W @param {number} H @param {number} gx0 @param {number} gz0 @param {SSGeometry} ss
 * @returns {FloorRect[]}
 */
function floorRects(cand, W, H, gx0, gz0, ss) {
  const B = FLOOR.block, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  const bin = new Int32Array(bw * bh).fill(-1e9);
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    let s = 0, n = 0;
    for (let dj = 0; dj < B; dj++) for (let di = 0; di < B; di++) {
      const x = i * B + di, z = j * B + dj;
      if (x >= W || z >= H) continue;
      const v = cand[z * W + x];
      if (v !== NO_FLOOR) { s += v; n++; }
    }
    if (n >= 2) bin[j * bw + i] = Math.round(s / n / FLOOR.stepMm);
  }
  /** @type {FloorRect[]} */ const out = [];
  const used = new Uint8Array(bw * bh);
  const M = B * CELL;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const k = j * bw + i;
      if (used[k] || bin[k] === -1e9) continue;
      const h = bin[k];
      let i1 = i;
      while (i1 + 1 < bw && !used[j * bw + i1 + 1] && bin[j * bw + i1 + 1] === h) i1++;
      let j1 = j;
      for (;;) {
        if (j1 + 1 >= bh) break;
        let ok = true;
        for (let x = i; x <= i1; x++) { const q = (j1 + 1) * bw + x; if (used[q] || bin[q] !== h) { ok = false; break; } }
        if (!ok) break;
        j1++;
      }
      for (let z = j; z <= j1; z++) for (let x = i; x <= i1; x++) used[z * bw + x] = 1;
      out.push({ x0: (gx0 + i * B) * CELL, z0: (gz0 + j * B) * CELL, x1: (gx0 + (i1 + 1) * B) * CELL, z1: (gz0 + (j1 + 1) * B) * CELL, y: (h * FLOOR.stepMm) / 1000 });
    }
  }
  // drop slivers; inside Space Setup's floors keep only height groups of ≥ 0.5 m²
  const inSS = (/** @type {FloorRect} */ r) => { const p = ss.floorAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2); return p === p; };
  /** @type {Map<number, number>} */ const ssArea = new Map();
  for (const r of out) if (inSS(r)) { const k = Math.round(r.y * 50); ssArea.set(k, (ssArea.get(k) || 0) + (r.x1 - r.x0) * (r.z1 - r.z0)); }
  let rects = out.filter((r) => (r.x1 - r.x0) * (r.z1 - r.z0) >= FLOOR.minRectM2 - 1e-9 && (!inSS(r) || (ssArea.get(Math.round(r.y * 50)) || 0) >= FLOOR.overrideM2));
  rects.sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
  if (rects.length > FLOOR.maxRects) rects = rects.slice(0, FLOOR.maxRects);
  for (const r of rects) { r.x0 = rnd(r.x0); r.z0 = rnd(r.z0); r.x1 = rnd(r.x1); r.z1 = rnd(r.z1); r.y = rnd(r.y); }
  return rects;
}

/**
 * Wall runs along the house frame's axes: rows (and columns) of wall cells, gaps of one cell bridged, merged
 * across up to 3 neighbouring rows; never across walked cells.
 * @param {Uint8Array} C @param {Uint8Array} walked @param {number} W @param {number} H @param {number} gx0 @param {number} gz0
 * @param {(x: number, z: number) => number} floorNear
 * @returns {LearnedWall[]}
 */
function wallRuns(C, walked, W, H, gx0, gz0, floorNear) {
  /** @type {{ a: number, b: number, c: number, horiz: boolean, n: number }[]} */ const runs = [];
  for (let pass = 0; pass < 2; pass++) {
    const horiz = pass === 0, A = horiz ? H : W, Bn = horiz ? W : H;
    for (let r = 0; r < A; r++) {
      let s = -1, gap = 0, last = -1;
      for (let q = 0; q <= Bn; q++) {
        const on = q < Bn && C[horiz ? r * W + q : q * W + r] === 1;
        if (on) { if (s < 0) s = q; last = q; gap = 0; continue; }
        if (s >= 0 && q < Bn && gap === 0 && !walked[horiz ? r * W + q : q * W + r]) { gap = 1; continue; }
        if (s >= 0 && last - s + 1 >= WALL.minRun) runs.push({ a: s, b: last + 1, c: r, horiz, n: 1 });
        s = -1; gap = 0;
      }
    }
  }
  // merge parallel runs in neighbouring rows that overlap most of the shorter one
  /** @type {{ a: number, b: number, c0: number, c1: number, horiz: boolean }[]} */ const bands = [];
  runs.sort((p, q) => (p.horiz === q.horiz ? p.c - q.c : p.horiz ? -1 : 1));
  for (const r of runs) {
    let merged = false;
    for (const b of bands) {
      if (b.horiz !== r.horiz || r.c > b.c1 + 1 || r.c - b.c0 >= WALL.maxThick) continue;
      const ov = Math.min(b.b, r.b) - Math.max(b.a, r.a);
      if (ov < 0.6 * Math.min(b.b - b.a, r.b - r.a)) continue;
      b.a = Math.min(b.a, r.a); b.b = Math.max(b.b, r.b); b.c1 = Math.max(b.c1, r.c);
      merged = true;
      break;
    }
    if (!merged) bands.push({ a: r.a, b: r.b, c0: r.c, c1: r.c, horiz: r.horiz });
  }
  /** @type {LearnedWall[]} */ const out = [];
  for (const b of bands) {
    const mid = (b.c0 + b.c1 + 1) / 2;
    let ax, az, bx, bz;
    if (b.horiz) { ax = (gx0 + b.a) * CELL; bx = (gx0 + b.b) * CELL; az = bz = (gz0 + mid) * CELL; }
    else { az = (gz0 + b.a) * CELL; bz = (gz0 + b.b) * CELL; ax = bx = (gx0 + mid) * CELL; }
    const y0 = floorNear((ax + bx) / 2, (az + bz) / 2);
    out.push({ ax: rnd(ax), az: rnd(az), bx: rnd(bx), bz: rnd(bz), y0: rnd(y0), y1: rnd(y0 + WALL.height) });
    if (out.length >= WALL.maxWalls) break;
  }
  return out;
}

/**
 * @param {Uint8Array} C @param {Int16Array} top @param {number} W @param {number} H @param {number} gx0 @param {number} gz0
 * @param {SSGeometry} ss @param {(x: number, z: number) => number} floorNear
 * @returns {LearnedBox[]}
 */
function topBoxes(C, top, W, H, gx0, gz0, ss, floorNear) {
  const seen = new Uint8Array(W * H), q = new Int32Array(W * H);
  /** @type {LearnedBox[]} */ const out = [];
  for (let s = 0; s < W * H; s++) {
    if (!C[s] || seen[s]) continue;
    let n = 0, h = 0, t = 0, i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1, sum = 0;
    q[t++] = s; seen[s] = 1;
    while (h < t) {
      const c = q[h++], i = c % W, j = (c - i) / W;
      n++; sum += top[c];
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, z = j + dj;
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        const d = z * W + x;
        if (C[d] && !seen[d]) { seen[d] = 1; q[t++] = d; }
      }
    }
    const x0 = (gx0 + i0) * CELL, x1 = (gx0 + i1 + 1) * CELL, z0 = (gz0 + j0) * CELL, z1 = (gz0 + j1 + 1) * CELL;
    const inside = ss.floorAt((x0 + x1) / 2, (z0 + z1) / 2) === ss.floorAt((x0 + x1) / 2, (z0 + z1) / 2);
    if (n < (inside ? TOP.minCellsInSS : TOP.minCells)) continue;
    const y1 = sum / n / 1000, y0 = floorNear((x0 + x1) / 2, (z0 + z1) / 2);
    out.push({ cx: rnd((x0 + x1) / 2), cz: rnd((z0 + z1) / 2), hx: rnd((x1 - x0) / 2), hz: rnd((z1 - z0) / 2), y0: rnd(y0), y1: rnd(y1) });
    if (out.length >= TOP.maxBoxes) break;
  }
  return out;
}

/**
 * Rooms: 4-connected components of observed floor, blocked where Space Setup's walls (outside their doors and
 * the openings found) and the learned walls run.
 * @param {Uint8Array} obs @param {number} W @param {number} H @param {number} gx0 @param {number} gz0 @param {SSGeometry} ss @param {ScanResult} res
 */
function countRooms(obs, W, H, gx0, gz0, ss, res) {
  const block = new Uint8Array(W * H);
  const mark = (/** @type {number} */ ax, /** @type {number} */ az, /** @type {number} */ bx, /** @type {number} */ bz, /** @type {(u: number) => boolean} */ open) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 0.05);
    for (let k = 0; k <= n; k++) {
      const u = (k / n) * L;
      if (open(u)) continue;
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
      const i = Math.floor(x / CELL) - gx0, j = Math.floor(z / CELL) - gz0;
      if (i >= 0 && j >= 0 && i < W && j < H) block[j * W + i] = 1;
    }
  };
  for (let wi = 0; wi < ss.walls.length; wi++) {
    const w = ss.walls[wi];
    /** @type {[number, number][]} */ const gaps = [];
    for (const d of ss.doors) {
      if (Math.abs((d.cx - w.ax) * w.nx + (d.cz - w.az) * w.nz) > 0.3 || Math.abs(d.tx * w.tx + d.tz * w.tz) < 0.9) continue;
      const du = (d.cx - w.ax) * w.tx + (d.cz - w.az) * w.tz;
      gaps.push([du - d.w / 2, du + d.w / 2]);
    }
    for (const o of res.openings) if (o.wall === wi) { const du = (o.cx - w.ax) * w.tx + (o.cz - w.az) * w.tz; gaps.push([du - o.w / 2, du + o.w / 2]); }
    mark(w.ax, w.az, w.bx, w.bz, (u) => gaps.some((g) => u > g[0] && u < g[1]));
  }
  for (const w of res.walls) mark(w.ax, w.az, w.bx, w.bz, () => false);
  const seen = new Uint8Array(W * H), q = new Int32Array(W * H);
  let rooms = 0;
  for (let s = 0; s < W * H; s++) {
    if (!obs[s] || seen[s] || block[s]) continue;
    let h = 0, t = 0;
    q[t++] = s; seen[s] = 1;
    while (h < t) {
      const c = q[h++], i = c % W;
      const nb = [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, c - W, c + W];
      for (const d of nb) if (d >= 0 && d < W * H && obs[d] && !seen[d] && !block[d]) { seen[d] = 1; q[t++] = d; }
    }
    if (t >= ROOM_MIN_CELLS) rooms++;
  }
  return rooms;
}

/** A short key of what the result would change in the world (same key: nothing to apply). @param {ScanResult} r */
export function resultKey(r) {
  const p = [];
  for (const o of r.openings) p.push(`o${Math.round(o.cx * 5)},${Math.round(o.cz * 5)},${Math.round(o.w * 5)}`);
  for (const f of r.floors) p.push(`f${Math.round(f.x0 * 5)},${Math.round(f.z0 * 5)},${Math.round(f.x1 * 5)},${Math.round(f.z1 * 5)},${Math.round(f.y * 50)}`);
  for (const w of r.walls) p.push(`w${Math.round(w.ax * 5)},${Math.round(w.az * 5)},${Math.round(w.bx * 5)},${Math.round(w.bz * 5)}`);
  for (const b of r.boxes) p.push(`b${Math.round(b.cx * 5)},${Math.round(b.cz * 5)},${Math.round(b.y1 * 20)}`);
  p.sort();
  let h = 0x811c9dc5;
  const s = p.join(';');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${p.length}:${(h >>> 0).toString(16)}`;
}

/** @param {number} v */
function rnd(v) { return Math.round(v * 1000) / 1000 + 0; }
