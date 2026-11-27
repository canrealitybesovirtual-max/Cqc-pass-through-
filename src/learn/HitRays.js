// @ts-check
/**
 * Hit-test rays for the house learner (v0.5, research F2, F10). No three.js.
 *
 * Sources are created once per session (asynchronously) and never mid-play:
 * one per controller target ray and two from the viewer (straight ahead a
 * little down, and the floor ahead), each asking for `entityTypes:
 * ['point', 'plane']` inside a try (Chromium's enum has no 'mesh'; the
 * member sits behind a runtime flag and may be ignored), falling back to the
 * default (planes only). One source is read per frame, round robin, and only
 * on frames with room; each hit becomes a ray record (origin, point, the
 * surface normal's y) in a preallocated batch that the Learner flushes to the
 * worker. A miss is unknown space, never free space. Whether hit-test adds
 * anything beyond Space Setup's planes is the device's question: the report
 * counts hits and how far they are from the sources.
 * Allocation-free per frame except the browser's own result objects.
 */
import { RAY_STRIDE } from './LearnCore.js';

export class HitRays {
  constructor() {
    /** @type {any[]} */ this.sources = [];
    /** @type {string[]} */ this.kinds = [];
    /** @type {any[]} */ this.spaces = [];
    this.next = 0;
    this.session = null;
    this.reset();
  }

  reset() {
    this.created = 0;
    this.failed = 0;
    this.entityTypes = 'untried';
    this.reads = 0;
    this.hits = 0;
    this.misses = 0;
    this.maxDist = 0;
    this.sumDist = 0;
    /** @type {string[]} */ this.errors = [];
  }

  /**
   * Create the sources (call once at session start; the promises resolve later).
   * @param {XRSession} session @param {XRReferenceSpace} space
   */
  begin(session, space) {
    this.end();
    this.reset();
    const s = /** @type {any} */ (session);
    this.session = s;
    if (!s || typeof s.requestHitTestSource !== 'function') { this.errors.push('no hit-test'); return; }
    const enabled = s.enabledFeatures ? Array.from(s.enabledFeatures) : [];
    if (!enabled.includes('hit-test')) { this.errors.push('hit-test not granted'); return; }
    void space;
    for (const src of Array.from(s.inputSources || [])) {
      const a = /** @type {any} */ (src);
      if (a && a.targetRaySpace && a.targetRayMode === 'tracked-pointer') this.add(a.targetRaySpace, `ctrl-${a.handedness || '?'}`, null);
    }
    const Ray = /** @type {any} */ (globalThis).XRRay;
    s.requestReferenceSpace('viewer').then((/** @type {any} */ viewer) => {
      if (this.session !== s) return;
      let ahead = null, floor = null;
      try {
        if (typeof Ray === 'function') {
          ahead = new Ray({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -0.26, z: -0.97, w: 0 });
          floor = new Ray({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -0.64, z: -0.77, w: 0 });
        }
      } catch (e) { this.errors.push(`XRRay: ${e}`); }
      this.add(viewer, 'viewer-ahead', ahead);
      if (floor) this.add(viewer, 'viewer-floor', floor);
    }, (/** @type {unknown} */ e) => { this.errors.push(`viewer space: ${e}`); });
  }

  /**
   * One source, ['point', 'plane'] first, the default after.
   * @param {any} space @param {string} kind @param {any} offsetRay
   */
  add(space, kind, offsetRay) {
    const s = this.session;
    if (!s) return;
    const base = offsetRay ? { space, offsetRay } : { space };
    const done = (/** @type {any} */ src, /** @type {string} */ how) => {
      if (this.session !== s) { try { src.cancel(); } catch { /* gone */ } return; }
      this.sources.push(src);
      this.kinds.push(kind);
      this.spaces.push(space);
      this.created++;
      if (this.entityTypes === 'untried' || how === 'point+plane') this.entityTypes = how;
    };
    const plain = () => {
      try { s.requestHitTestSource(base).then((/** @type {any} */ src) => done(src, 'default'), (/** @type {unknown} */ e) => { this.failed++; this.errors.push(`${kind}: ${e}`); }); }
      catch (e) { this.failed++; this.errors.push(`${kind}: ${e}`); }
    };
    try {
      s.requestHitTestSource({ ...base, entityTypes: ['point', 'plane'] }).then((/** @type {any} */ src) => done(src, 'point+plane'), () => plain());
    } catch { plain(); }
  }

  /**
   * Read one source (round robin) into the batch.
   * @param {XRFrame} frame @param {XRReferenceSpace} space
   * @param {{ buf: Float32Array, n: number, cap: number }} batch @param {{ x: number, y: number, z: number }|null} head
   * @returns {boolean} a hit was added
   */
  step(frame, space, batch, head) {
    const N = this.sources.length;
    if (!N || batch.n >= batch.cap) return false;
    const k = this.next % N;
    this.next = (k + 1) % N;
    this.reads++;
    let res = null;
    try { res = /** @type {any} */ (frame).getHitTestResults(this.sources[k]); } catch { res = null; }
    if (!res || !res.length) { this.misses++; return false; }
    const hp = res[0].getPose(space);
    if (!hp) { this.misses++; return false; }
    // the ray's origin: the controller's target ray, or the head for the viewer rays
    let ox = NaN, oy = NaN, oz = NaN;
    if (this.kinds[k].startsWith('ctrl')) {
      const op = frame.getPose(this.spaces[k], space);
      if (op) { const m = op.transform.matrix; ox = m[12]; oy = m[13]; oz = m[14]; }
    } else if (head) { ox = head.x; oy = head.y; oz = head.z; }
    if (!(ox === ox)) { this.misses++; return false; }
    const m = hp.transform.matrix, b = batch.n * RAY_STRIDE, B = batch.buf;
    B[b] = 1; B[b + 1] = ox; B[b + 2] = oy; B[b + 3] = oz; B[b + 4] = m[12]; B[b + 5] = m[13]; B[b + 6] = m[14]; B[b + 7] = m[5];
    batch.n++;
    this.hits++;
    const d = Math.hypot(m[12] - ox, m[13] - oy, m[14] - oz);
    this.sumDist += d;
    if (d > this.maxDist) this.maxDist = d;
    return true;
  }

  /** Cancel the sources (session end). */
  end() {
    for (const s of this.sources) { try { s.cancel(); } catch { /* gone */ } }
    this.sources.length = 0;
    this.kinds.length = 0;
    this.spaces.length = 0;
    this.session = null;
  }

  report() {
    return { sources: this.kinds.slice(), created: this.created, failed: this.failed, entityTypes: this.entityTypes, reads: this.reads, hits: this.hits,
      misses: this.misses, hitRate: this.reads ? Math.round((100 * this.hits) / this.reads) : 0, avgDistM: this.hits ? Math.round((this.sumDist / this.hits) * 100) / 100 : 0,
      maxDistM: Math.round(this.maxDist * 100) / 100, errors: this.errors.slice(0, 6) };
  }
}
