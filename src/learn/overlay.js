// @ts-check
/**
 * The learned house as Space Setup data (v0.5): a ScanResult (house frame,
 * src/learn/analyze.js) becomes extra snapshot planes and volumes in the
 * session's coordinates, appended after Space Setup's own, so the world
 * build (Layout, nav, Roam, occluders, statics, the worker) needs no second
 * input:
 * - an opening → an open 'door' plane on the wall line (Layout carves it out
 *   of every wall plane it lies on: the walked hall becomes passable);
 * - a floor rectangle → a 'floor' plane at the measured height (the world
 *   build's smallest-polygon rule makes it win where it overlaps Space
 *   Setup's floor);
 * - a learned wall → a 'wall' plane, floor to 2.4 m;
 * - a furniture top → a volume labelled 'learned';
 * - the walked points → `scanWalked` (a room the user walked through is never
 *   taken for unscanned space behind the real walls).
 * `scanBase` records how many planes / volumes are Space Setup's, so a later
 * result replaces the learned part instead of stacking on it, and the
 * house frame is always taken from Space Setup's own floor.
 *
 * Pure: no three.js, no DOM.
 */
import { attachRaw, rawOf } from '../world/Snapshot.js';

/** @param {number} v */
const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0;

/**
 * @param {import('./analyze.js').ScanResult|null} res house frame
 * @param {ArrayLike<number>} inv house → session
 * @returns {{ planes: any[], meshes: any[], walked: number[][], counts: { openings: number, floors: number, walls: number, boxes: number } }}
 */
export function scanOverlay(res, inv) {
  /** @type {any[]} */ const planes = [], meshes = [];
  /** @type {number[][]} */ const walked = [];
  const counts = { openings: 0, floors: 0, walls: 0, boxes: 0 };
  if (!res) return { planes, meshes, walked, counts };
  const c = inv[0], s = inv[2]; // house x axis in session coords (cos, sin of the yaw)
  const toS = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
    [inv[0] * x + inv[4] * y + inv[8] * z + inv[12], inv[1] * x + inv[5] * y + inv[9] * z + inv[13], inv[2] * x + inv[6] * y + inv[10] * z + inv[14]];
  /** a vertical plane along (tx, tz) (house) through (x, y0, z), width w, height h */
  const vertical = (/** @type {string} */ label, /** @type {number} */ x, /** @type {number} */ y0, /** @type {number} */ z,
    /** @type {number} */ tx, /** @type {number} */ tz, /** @type {number} */ w, /** @type {number} */ h) => {
    const o = toS(x, y0, z);
    // the tangent in session coords; pose columns: X = tangent, Y = normal (tz, 0, −tx), Z = up
    const sx = c * tx - s * tz, sz = s * tx + c * tz;
    const nx = sz, nz = -sx;
    planes.push({ label, orientation: 'vertical', pose: [r4(sx), 0, r4(sz), 0, r4(nx), 0, r4(nz), 0, 0, 1, 0, 0, r4(o[0]), r4(o[1]), r4(o[2]), 1],
      polygon: [[r4(-w / 2), 0], [r4(w / 2), 0], [r4(w / 2), r4(h)], [r4(-w / 2), r4(h)]] });
  };
  for (const o of res.openings) { vertical('door', o.cx, o.y0, o.cz, o.tx, o.tz, o.w, o.y1 - o.y0); counts.openings++; }
  for (const w of res.walls) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (L < 0.3) continue;
    vertical('wall', (w.ax + w.bx) / 2, w.y0, (w.az + w.bz) / 2, (w.bx - w.ax) / L, (w.bz - w.az) / L, L, w.y1 - w.y0);
    counts.walls++;
  }
  for (const f of res.floors) {
    const mx = (f.x0 + f.x1) / 2, mz = (f.z0 + f.z1) / 2, o = toS(mx, f.y, mz);
    /** @type {number[][]} */ const poly = [];
    // corners in session coords relative to the centre, in the order the world build reads as positive area
    for (const [x, z] of [[f.x0, f.z0], [f.x1, f.z0], [f.x1, f.z1], [f.x0, f.z1]]) {
      const p = toS(x, f.y, z);
      poly.push([r4(p[0] - o[0]), r4(p[2] - o[2])]);
    }
    planes.push({ label: 'floor', orientation: 'horizontal', pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, r4(o[0]), r4(o[1]), r4(o[2]), 1], polygon: poly });
    counts.floors++;
  }
  for (const b of res.boxes) {
    const hy = (b.y1 - b.y0) / 2, o = toS(b.cx, (b.y0 + b.y1) / 2, b.cz);
    meshes.push({ label: 'learned', pose: [r4(c), 0, r4(s), 0, 0, 1, 0, 0, r4(-s), 0, r4(c), 0, r4(o[0]), r4(o[1]), r4(o[2]), 1],
      min: [r4(-b.hx), r4(-hy), r4(-b.hz)], max: [r4(b.hx), r4(hy), r4(b.hz)], vertexCount: 0 });
    counts.boxes++;
  }
  for (let i = 0; i + 1 < res.walked.length; i += 2) {
    const p = toS(res.walked[i], 0, res.walked[i + 1]);
    walked.push([r4(p[0]), r4(p[2])]);
  }
  return { planes, meshes, walked, counts };
}

/**
 * A snapshot with the learned overlay appended (replacing an earlier one); the captured triangles (`raw`) and
 * the global mesh's description stay shared with the original.
 * @param {any} snap @param {ReturnType<typeof scanOverlay>|null} ov
 */
export function applyScan(snap, ov) {
  if (!snap) return snap;
  const base = baseOf(snap);
  if (!ov || (!ov.planes.length && !ov.meshes.length && !ov.walked.length)) return base;
  /** @type {any} */ const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  out.planes = base.planes.concat(ov.planes);
  out.meshes = base.meshes.concat(ov.meshes);
  out.scanBase = { planes: base.planes.length, meshes: base.meshes.length };
  out.scanWalked = ov.walked;
  const raw = rawOf(snap);
  if (raw) attachRaw(out, raw);
  return out;
}

/**
 * Space Setup's own part of a (possibly merged) snapshot.
 * @param {any} snap
 */
export function baseOf(snap) {
  if (!snap || !snap.scanBase) return snap;
  /** @type {any} */ const out = {};
  for (const k of Object.keys(snap)) if (k !== 'scanBase' && k !== 'scanWalked') out[k] = snap[k];
  out.planes = snap.planes.slice(0, snap.scanBase.planes);
  out.meshes = snap.meshes.slice(0, snap.scanBase.meshes);
  const raw = rawOf(snap);
  if (raw) attachRaw(out, raw);
  return out;
}
