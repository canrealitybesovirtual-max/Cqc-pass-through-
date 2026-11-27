// @ts-check
/**
 * The learner's whole job, as the worker runs it (v0.5): one house at a
 * time, its grid loaded from the store (in the worker, never on the main
 * thread), depth packets and ray / head batches fused, analyses on request,
 * saves on request (between waves, at session end). Pure: the store is
 * injected (IndexedDB in src/learn/learn.worker.js, memory in tests).
 *
 * Depth rows: which way the depth image's rows run is not documented for the
 * Quest (research F7). The first CALIB_PACKETS packets are decoded both ways
 * and scored against Space Setup's floors and walls; the better one wins if
 * its median distance is under CALIB_MAX_M, else depth learning is off for the
 * session (hit-test rays and the head path still count) and the reason is
 * kept in `stats().depth`.
 */
import { HouseGrid } from './HouseGrid.js';
import { Fuser } from './fuse.js';
import { analyzeHouse, ssGeometry } from './analyze.js';
import { loadHouse, saveHouse, forgetHouse } from './HouseStore.js';
import { decodeSlab, POSE, TAP } from './depthMath.js';
import { apply } from './houseFrame.js';

export const CALIB_PACKETS = 8;
export const CALIB_MAX_M = 0.08;
/** Self-mask: points this close to the head horizontally and below it (the body), or to a controller, are dropped. */
const BODY_R = 0.32, HAND_R = 0.2;
/** Ray batch layout (Float32 per record): kind, ox, oy, oz, px, py, pz, ny (kind 1 = hit-test ray, 2 = head sample). */
export const RAY_STRIDE = 8;

export class LearnCore {
  /** @param {{ store: import('./HouseStore.js').KV, maxChunks?: number, appVersion?: string }} o */
  constructor({ store, maxChunks = 192, appVersion = '' }) {
    this.store = store;
    this.grid = new HouseGrid({ maxChunks });
    this.fuser = new Fuser(this.grid);
    this.appVersion = appVersion;
    /** @type {{ id: string, sig: string, sessions: number }|null} */ this.house = null;
    /** session → house */ this.H = new Float64Array(16);
    /** @type {import('./analyze.js').SSGeometry|null} */ this.ss = null;
    this.pts = new Float32Array(TAP.cols * TAP.rows * TAP.eyes * 3);
    this.origins = new Float32Array(6);
    this.eyeOf = new Uint8Array(TAP.cols * TAP.rows * TAP.eyes);
    this._p = new Float64Array(3);
    this._o = new Float64Array(3);
    this.reset();
  }

  reset() {
    this.packets = 0;
    this.depthPoints = 0;
    this.rays = 0;
    this.walks = 0;
    this.masked = 0;
    /** 'calibrating' | 'rows-up' | 'rows-down' | 'off: …' */
    this.depthMode = 'calibrating';
    this.calib = { up: /** @type {number[]} */ ([]), down: /** @type {number[]} */ ([]), packets: 0, residualM: NaN };
    /** Packets held during calibration (decoded again once the rows are known). @type {{ pix: Uint8Array, pose: Float64Array }[]} */
    this.held = [];
    this.analyses = 0;
    this.analyzeMs = 0;
    this.dirty = false;
    /** @type {import('./analyze.js').ScanResult|null} */ this.last = null;
  }

  /**
   * A new session in a house: its frame and Space Setup's geometry, then its saved grid (if any).
   * @param {{ houseId: string, sig: string, snapshot: any, H: ArrayLike<number> }} o
   */
  async open({ houseId, sig, snapshot, H }) {
    this.reset();
    this.setFrame(H, snapshot);
    const r = await loadHouse(this.store, this.grid, houseId);
    this.house = { id: houseId, sig, sessions: r.sessions + 1 };
    const res = r.loaded ? this.analyze() : null;
    return { ...r, result: res };
  }

  /**
   * The session → house transform (a realign moves the session's coordinates) and Space Setup in it.
   * @param {ArrayLike<number>} H @param {any} [snapshot]
   */
  setFrame(H, snapshot) {
    this.H.set(H);
    if (snapshot) {
      this.ss = ssGeometry(snapshot, this.H);
      this.fuser.setFloorPrior(this.ss.floorAt);
    }
  }

  /**
   * One depth readback. Returns the points fused.
   * @param {Uint8Array} pix @param {Float64Array} pose
   */
  depth(pix, pose) {
    this.packets++;
    if (this.depthMode.startsWith('off')) return 0;
    if (this.depthMode === 'calibrating') {
      this.held.push({ pix: pix.slice(), pose: pose.slice() });
      this.calibrate(pix, pose);
      if (this.depthMode === 'calibrating') return 0;
      let n = 0;
      if (!this.depthMode.startsWith('off')) for (const h of this.held) n += this.fusePacket(h.pix, h.pose);
      this.held.length = 0;
      return n;
    }
    return this.fusePacket(pix, pose);
  }

  /** @param {Uint8Array} pix @param {Float64Array} pose */
  calibrate(pix, pose) {
    const C = this.calib, ss = this.ss;
    if (!ss || (!ss.walls.length && !ss.floors.length)) { this.depthMode = 'rows-up'; return; }
    for (const down of [false, true]) {
      const n = decodeSlab(pix, pose, this.pts, this.origins, { rowsDown: down });
      const d = [];
      for (let k = 0; k < n; k += 3) {
        apply(this.H, this.pts[3 * k], this.pts[3 * k + 1], this.pts[3 * k + 2], this._p);
        const e = distToSS(ss, this._p[0], this._p[1], this._p[2]);
        if (e === e) d.push(e);
      }
      d.sort((a, b) => a - b);
      if (d.length) (down ? C.down : C.up).push(d[d.length >> 1]);
    }
    C.packets++;
    if (C.packets < CALIB_PACKETS) return;
    const med = (/** @type {number[]} */ a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : Infinity; };
    const up = med(C.up), down = med(C.down);
    C.residualM = Math.min(up, down);
    if (!(C.residualM < CALIB_MAX_M)) this.depthMode = `off: depth ${Number.isFinite(C.residualM) ? `${(C.residualM * 100).toFixed(1)} cm` : 'no points'} off Space Setup`;
    else this.depthMode = up <= down ? 'rows-up' : 'rows-down';
  }

  /** @param {Uint8Array} pix @param {Float64Array} pose */
  fusePacket(pix, pose) {
    const n = decodeSlab(pix, pose, this.pts, this.origins, { rowsDown: this.depthMode === 'rows-down', eyeOf: this.eyeOf });
    const H = this.H, p = this._p, o = this._o, O = this.origins;
    const hx = pose[POSE.HEAD], hy = pose[POSE.HEAD + 1], hz = pose[POSE.HEAD + 2];
    let used = 0;
    for (let k = 0; k < n; k++) {
      const x = this.pts[3 * k], y = this.pts[3 * k + 1], z = this.pts[3 * k + 2];
      // self-mask: the body under the head, the hands
      const dh = Math.hypot(x - hx, z - hz);
      if ((dh < BODY_R && y < hy + 0.1) || near3(pose, POSE.CTRL, x, y, z, HAND_R) || near3(pose, POSE.CTRL + 3, x, y, z, HAND_R)) { this.masked++; continue; }
      const e = this.eyeOf[k];
      apply(H, O[3 * e], O[3 * e + 1], O[3 * e + 2], o);
      apply(H, x, y, z, p);
      this.fuser.addPoint(o[0], o[1], o[2], p[0], p[1], p[2]);
      used++;
    }
    this.depthPoints += used;
    if (used) this.dirty = true;
    return used;
  }

  /**
   * A batch of hit-test rays and head samples (session coordinates; RAY_STRIDE floats each).
   * @param {Float32Array} buf @param {number} count
   */
  raysBatch(buf, count) {
    const H = this.H, p = this._p, o = this._o;
    for (let k = 0; k < count; k++) {
      const b = k * RAY_STRIDE, kind = buf[b];
      apply(H, buf[b + 1], buf[b + 2], buf[b + 3], o);
      if (kind === 2) { this.fuser.addWalk(o[0], o[1], o[2]); this.walks++; continue; }
      if (kind !== 1) continue;
      apply(H, buf[b + 4], buf[b + 5], buf[b + 6], p);
      this.fuser.addPoint(o[0], o[1], o[2], p[0], p[1], p[2], buf[b + 7]);
      this.rays++;
    }
    if (count) this.dirty = true;
  }

  /** Analyse now (the scan's progress, the silent learner's updates). */
  analyze() {
    if (!this.ss) return null;
    const r = analyzeHouse(this.grid, this.ss);
    this.analyses++;
    this.analyzeMs = Math.max(this.analyzeMs, r.ms);
    this.last = r;
    return r;
  }

  /** Save the house (compacted, capped, after a quota check). */
  async save() {
    if (!this.house) return { saved: false, why: 'no house' };
    const r = await saveHouse(this.store, this.grid, { ...this.house, appVersion: this.appVersion });
    if (r.saved) this.dirty = false;
    return r;
  }

  /** Forget this house (the learned map; Space Setup is untouched). */
  async forget() {
    if (!this.house) return;
    await forgetHouse(this.store, this.house.id);
    this.grid.clear();
    this.dirty = false;
  }

  stats() {
    return {
      house: this.house ? this.house.id : null, sessions: this.house ? this.house.sessions : 0, chunks: this.grid.chunkCount, evictions: this.grid.evictions,
      packets: this.packets, depthPoints: this.depthPoints, rays: this.rays, walks: this.walks, masked: this.masked,
      depth: this.depthMode, calibResidualCm: Number.isFinite(this.calib.residualM) ? Math.round(this.calib.residualM * 1000) / 10 : null,
      analyses: this.analyses, analyzeMaxMs: Math.round(this.analyzeMs * 10) / 10, fuse: this.fuser.stats(),
    };
  }
}

/** @param {ArrayLike<number>} pose @param {number} o @param {number} x @param {number} y @param {number} z @param {number} r */
function near3(pose, o, x, y, z, r) {
  const dx = x - pose[o], dy = y - pose[o + 1], dz = z - pose[o + 2];
  return pose[o] === pose[o] && dx * dx + dy * dy + dz * dz < r * r;
}

/**
 * Distance of a house-frame point to Space Setup's floor under it or the nearest wall it is level with (NaN: none
 * within 1 m).
 * @param {import('./analyze.js').SSGeometry} ss @param {number} x @param {number} y @param {number} z
 */
export function distToSS(ss, x, y, z) {
  let best = NaN;
  const f = ss.floorAt(x, z);
  if (f === f) best = Math.abs(y - f);
  for (const w of ss.walls) {
    if (y < w.y0 - 0.1 || y > w.y1 + 0.1) continue;
    const u = (x - w.ax) * w.tx + (z - w.az) * w.tz;
    if (u < 0 || u > w.len) continue;
    const d = Math.abs((x - w.ax) * w.nx + (z - w.az) * w.nz);
    if (d < 1 && !(d >= best)) best = d;
  }
  return best;
}
