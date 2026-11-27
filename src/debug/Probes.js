// @ts-check
import { pointInPolygon, polygonArea } from '../util/geom2d.js';
import { errText, frameRates, nextRate } from '../xr/XRSession.js';

/**
 * Phase 1 device probes: answers the "untested" list in docs/PLAN.md §2.
 * Everything here reads real browser APIs and records what it saw into the
 * session record; nothing is assumed.
 *
 * Controls (controllers):
 *   right trigger (hold)  hit-test sampling + reticle
 *   A                     60 s frame-timing run at the current rate
 *   B                     next refresh rate
 *   X (left)              toggle explicit clear (depth sessions)
 *   both grips 1 s        end the session
 */

const RUN_MS = 60000;
const MAX_FLOORS = 4;
const MAX_FLOOR_PTS = 64;

/** @typedef {import('./CapabilityLog.js').SessionRecord} SessionRecord */
/** @typedef {{ samples: number, hits: number, sumDist: number, maxDist: number }} HitBucket */

/** @returns {HitBucket} */
const bucket = () => ({ samples: 0, hits: 0, sumDist: 0, maxDist: 0 });

export class Probes {
  /**
   * @param {{ rec: SessionRecord, mode: string, input: import('../xr/Input.js').Input,
   *   draw: import('./DebugDraw.js').DebugDraw, perf: import('./PerfMonitor.js').PerfMonitor,
   *   loop: import('../app/Loop.js').Loop, renderer: any, session: XRSession, space: XRReferenceSpace }} o
   */
  constructor({ rec, mode, input, draw, perf, loop, renderer, session, space }) {
    this.rec = rec;
    this.mode = mode;
    this.input = input;
    this.draw = draw;
    this.perf = perf;
    this.loop = loop;
    this.renderer = renderer;
    this.session = session;
    this.space = space;
    this.enabled = /** @type {string[]} */ (rec.granted.enabledFeatures || []);
    /** Bumped whenever something shown on the HUD changes. */
    this.rev = 1;
    this.t0 = -1;
    this.frameNo = 0;
    this.ended = false;

    // Hit test
    this.hitOk = this.enabled.includes('hit-test') && typeof /** @type {any} */ (session).requestHitTestSource === 'function';
    /** @type {{ left: any, right: any }} */ this.hitSrc = { left: null, right: null };
    /** @type {{ left: XRInputSource|null, right: XRInputSource|null }} */ this.hitFor = { left: null, right: null };
    this.hit = { inside: bucket(), outside: bucket(), unknown: bucket() };
    this.where = 'unknown';

    // Space Setup
    this.floorPolys = Array.from({ length: MAX_FLOORS }, () => new Float32Array(MAX_FLOOR_PTS * 2));
    this.floorN = new Uint8Array(MAX_FLOORS);
    this.floorCount = 0;
    this.planeStamp = -1;
    this.planeCount = 0;
    this.meshCount = 0;
    this.lastFloorUpdate = -1e9;

    // Anchor
    /** @type {'pending'|'creating'|'ok'|'failed'|'unsupported'} */ this.anchorState = 'pending';
    /** @type {XRAnchor|null} */ this.anchor = null;
    this.anchorFrames = 0;

    // Depth / light / body / bounds
    this.depthDone = !this.enabled.includes('depth-sensing'); // the depthUsage attribute exists even without the feature
    this.depthTries = 0;
    /** @type {any} */ this.lightProbe = null;
    this.lightDone = true;
    this.bodyDone = mode !== 'probe' || !this.enabled.includes('body-tracking');
    /** @type {any} */ this.bounded = null;
    this.boundsLastN = -1;
    this.boundsNext = 0;

    // Controls
    this.gripHold = 0;
    this.rateBusy = false;
    this.requestedHz = 0;
    this.requestedAt = 0;
    this.attr2s = false;
    this.stampChanges = 0;

    rec.probes.hitTest = { granted: this.hitOk, buckets: this.hit };
    rec.probes.spaceSetup = { planes: 0, meshes: 0, firstPlanesAtMs: null, summary: null };
    rec.probes.anchor = { state: 'pending' };
    rec.probes.clear = { explicit: loop.explicitClear, toggles: [] };
    rec.probes.frameRate = { attrAtStart: /** @type {any} */ (session).frameRate ?? null, attrAt2s: null, measuredHz: null, switches: [] };
    perf.onRateChange = (hz) => {
      const F = rec.probes.frameRate;
      if (F.measuredHz === null) F.measuredHz = hz;
      const sw = F.switches.at(-1);
      if (sw && sw.measuredAfter === null) sw.measuredAfter = hz;
      if (this.requestedHz && Math.abs(hz - this.requestedHz) < 0.5) this.requestedHz = 0;
      this.event(`measured rate ${hz} Hz`);
    };
  }

  /** Async setup that must not run inside the frame callback. */
  async start() {
    const s = /** @type {any} */ (this.session);
    if (this.mode === 'bounds') {
      try {
        this.bounded = await s.requestReferenceSpace('bounded-floor');
        this.rec.probes.bounds = { space: 'granted', samples: [], maxPoints: 0, points: null };
      } catch (e) {
        this.rec.probes.bounds = { space: `rejected: ${errText(e)}` };
      }
      this.rev++;
    }
    if (this.mode === 'probe' && this.enabled.includes('light-estimation') && typeof s.requestLightProbe === 'function') {
      try {
        this.lightProbe = await s.requestLightProbe();
        this.rec.probes.light = { probe: 'ok', estimate: null };
        this.lightDone = false;
      } catch (e) {
        this.rec.probes.light = { probe: `failed: ${errText(e)}` };
      }
      this.rev++;
    } else if (this.mode === 'probe') {
      this.rec.probes.light = { probe: this.enabled.includes('light-estimation') ? 'requestLightProbe missing' : 'not granted' };
    }
    if (this.mode === 'probe') this.rec.probes.body = { granted: this.enabled.includes('body-tracking'), firstBody: null };
    this.refreshHitSources();
  }

  /** Request a hit-test source per controller (called on inputsourceschange). */
  refreshHitSources() {
    if (!this.hitOk || this.ended) return;
    const srcs = this.session.inputSources;
    for (const side of /** @type {const} */ (['left', 'right'])) {
      let src = null;
      for (let i = 0; i < srcs.length; i++) if (srcs[i].handedness === side && srcs[i].gamepad && !srcs[i].hand) src = srcs[i];
      if (src === this.hitFor[side]) continue;
      if (this.hitSrc[side]) { try { this.hitSrc[side].cancel(); } catch { /* already gone */ } }
      this.hitSrc[side] = null;
      this.hitFor[side] = src;
      if (!src) continue;
      const want = src;
      /** @type {any} */ (this.session).requestHitTestSource({ space: src.targetRaySpace })
        .then((/** @type {any} */ hs) => {
          if (this.ended || this.hitFor[side] !== want) { hs.cancel(); return; }
          this.hitSrc[side] = hs;
        })
        .catch((/** @type {any} */ e) => this.event(`hit-test source ${side} failed: ${errText(e)}`));
    }
  }

  /**
   * @param {number} dt
   * @param {number} t
   * @param {XRFrame} frame
   */
  update(dt, t, frame) {
    if (this.t0 < 0) this.t0 = t;
    const ms = t - this.t0;
    this.frameNo++;
    const f = /** @type {any} */ (frame);
    const inp = this.input;

    if (!this.attr2s && ms > 2000) {
      this.attr2s = true;
      this.rec.probes.frameRate.attrAt2s = /** @type {any} */ (this.session).frameRate ?? null;
      if (this.rec.probes.frameRate.measuredHz === null && this.perf.measured) this.rec.probes.frameRate.measuredHz = this.perf.hz;
    }

    if (this.requestedHz && performance.now() - this.requestedAt > 3000) {
      this.event(`rate still ${this.perf.measured ? this.perf.hz : '?'} Hz 3 s after requesting ${this.requestedHz}`);
      this.requestedHz = 0;
    }

    // ---- controls
    if (inp.right.aDown) this.toggleRun();
    if (inp.right.bDown) this.cycleRate();
    if (inp.left.aDown) this.toggleClear();
    if (inp.left.squeeze > 0.8 && inp.right.squeeze > 0.8) {
      this.gripHold += dt;
      if (this.gripHold > 1 && !this.ended) {
        this.ended = true;
        this.event('exit by both grips');
        // Never end inside the frame callback: Quest ends synchronously and the XRFrame
        // (still used by three.js after this callback) becomes invalid.
        setTimeout(() => this.session.end().catch(() => {}), 0);
        return;
      }
    } else this.gripHold = 0;

    // ---- controller rays (aiming aid)
    this.ray(f, 'left', 0);
    this.ray(f, 'right', 1);

    // ---- where am I (inside a Space Setup floor?)
    if (ms - this.lastFloorUpdate > 2000) { this.updateFloors(f); this.lastFloorUpdate = ms; }
    const cam = this.renderer.xr.getCamera();
    let where = 'unknown';
    if (this.floorCount > 0) {
      where = 'outside';
      for (let i = 0; i < this.floorCount; i++) if (pointInPolygon(this.floorPolys[i], this.floorN[i], cam.position.x, cam.position.z)) where = 'inside';
    }
    if (where !== this.where) { this.where = where; this.rev++; }

    // ---- hit-test sampling while a trigger is held
    let shown = false;
    if (this.hitOk) {
      shown = this.sampleHit(f, 'right') || shown;
      shown = this.sampleHit(f, 'left') || shown;
    }
    if (!shown) this.draw.hideReticle();

    // ---- Space Setup planes and meshes (cheap check every 30 frames)
    if (this.frameNo % 30 === 0) this.checkPlanes(f, ms);
    if (this.frameNo % 60 === 0) this.checkMeshes(f);

    // ---- anchor creation in the active space, 1 s in
    if (this.anchorState === 'pending' && ms > 1000) this.createAnchor(f);
    if (this.anchorState === 'ok' && this.anchor) this.trackAnchor(f);

    // ---- depth information (once)
    if (!this.depthDone) this.readDepth(f);

    // ---- light estimate (first one)
    if (!this.lightDone && this.frameNo % 30 === 0) this.readLight(f, ms);

    // ---- body tracking (first frame with a body)
    if (!this.bodyDone && this.frameNo % 30 === 0) {
      if (f.body) { this.rec.probes.body.firstBody = { atMs: Math.round(ms), joints: f.body.size ?? null }; this.bodyDone = true; this.rev++; }
      else if (ms > 20000) this.bodyDone = true;
    }

    // ---- bounded-floor geometry over time
    if (this.bounded && ms >= this.boundsNext && ms < 20000) { this.sampleBounds(ms); this.boundsNext = ms + 500; }

    // ---- live HUD values once per second (every 10 s during a run, to keep the measurement clean)
    const every = this.perf.running ? 10000 : 1000;
    if (Math.floor(ms / every) !== Math.floor((ms - dt * 1000) / every)) this.rev++;
  }

  /**
   * @param {any} f
   * @param {'left'|'right'} side
   * @param {number} idx
   */
  ray(f, side, idx) {
    const h = this.input[side];
    if (!h.present || !h.source) { this.draw.hideRay(idx); return; }
    const p = f.getPose(h.source.targetRaySpace, this.space);
    if (p) this.draw.setRay(idx, p.transform.matrix, h.trigger > 0.5); else this.draw.hideRay(idx);
  }

  /**
   * @param {any} f
   * @param {'left'|'right'} side
   * @returns {boolean} whether a reticle was shown
   */
  sampleHit(f, side) {
    const hs = this.hitSrc[side];
    const h = this.input[side];
    if (!hs || !h.present || h.trigger < 0.5) return false;
    const b = this.hit[/** @type {'inside'|'outside'|'unknown'} */ (this.where)];
    b.samples++;
    const res = f.getHitTestResults(hs);
    if (!res.length) return false;
    const pose = res[0].getPose(this.space);
    if (!pose) return false;
    b.hits++;
    const o = f.getPose(h.source.targetRaySpace, this.space);
    if (o) {
      const a = o.transform.position, c = pose.transform.position;
      const d = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
      b.sumDist += d;
      if (d > b.maxDist) b.maxDist = d;
    }
    this.draw.setReticle(pose.transform.matrix);
    if (b.samples % 36 === 0) this.rev++;
    return true;
  }

  /** @param {any} f */
  updateFloors(f) {
    const planes = f.detectedPlanes;
    if (!planes || !planes.size) return;
    let k = 0;
    planes.forEach((/** @type {any} */ p) => {
      if (k >= MAX_FLOORS || p.orientation !== 'horizontal') return;
      if (p.semanticLabel && p.semanticLabel !== 'floor') return;
      const pose = f.getPose(p.planeSpace, this.space);
      if (!pose) return;
      const m = pose.transform.matrix;
      const poly = p.polygon;
      const n = Math.min(poly.length, MAX_FLOOR_PTS);
      const out = this.floorPolys[k];
      for (let i = 0; i < n; i++) {
        const x = poly[i].x, z = poly[i].z; // plane space: y is the normal
        out[2 * i] = m[0] * x + m[8] * z + m[12];
        out[2 * i + 1] = m[2] * x + m[10] * z + m[14];
      }
      this.floorN[k] = n;
      k++;
    });
    this.floorCount = k;
  }

  /**
   * @param {any} f
   * @param {number} ms
   */
  checkPlanes(f, ms) {
    const planes = f.detectedPlanes;
    const ss = this.rec.probes.spaceSetup;
    if (!planes) { if (ss.summary === null) { ss.summary = 'frame.detectedPlanes missing'; this.rev++; } return; }
    let stamp = 0;
    planes.forEach((/** @type {any} */ p) => { if (p.lastChangedTime > stamp) stamp = p.lastChangedTime; });
    if (planes.size === 0 && ms > 3000 && ss.summary === null) { ss.summary = 'no Space Setup data after 3 s'; this.rev++; }
    if (planes.size === this.planeCount && stamp === this.planeStamp) return;
    if (stamp !== this.planeStamp && this.planeStamp >= 0) { this.stampChanges++; ss.lastChangedTimeUpdates = this.stampChanges; }
    this.planeStamp = stamp;
    if (planes.size === this.planeCount) return; // only poses/timestamps moved: no rebuild, no log
    this.planeCount = planes.size;
    if (planes.size && ss.firstPlanesAtMs === null) ss.firstPlanesAtMs = Math.round(ms);
    /** @type {Record<string, number>} */ const labels = {};
    /** @type {any[]} */ const floors = [];
    let horiz = 0, vert = 0;
    planes.forEach((/** @type {any} */ p) => {
      const l = p.semanticLabel || '(none)';
      labels[l] = (labels[l] || 0) + 1;
      if (p.orientation === 'horizontal') horiz++; else vert++;
      if (p.orientation === 'horizontal' && (!p.semanticLabel || p.semanticLabel === 'floor')) {
        const flat = new Float32Array(p.polygon.length * 2);
        for (let i = 0; i < p.polygon.length; i++) { flat[2 * i] = p.polygon[i].x; flat[2 * i + 1] = p.polygon[i].z; }
        floors.push({ label: p.semanticLabel || null, points: p.polygon.length, areaM2: Math.round(Math.abs(polygonArea(flat, p.polygon.length)) * 10) / 10 });
      }
    });
    ss.planes = planes.size;
    ss.summary = { labels, horizontal: horiz, vertical: vert, floors };
    this.updateFloors(f);
    this.event(`planes: ${planes.size}`);
  }

  /** @param {any} f */
  checkMeshes(f) {
    const meshes = f.detectedMeshes;
    if (!meshes || meshes.size === this.meshCount) return;
    this.meshCount = meshes.size;
    /** @type {Record<string, number>} */ const labels = {};
    let maxTris = 0, maxVerts = 0;
    meshes.forEach((/** @type {any} */ m) => {
      const l = m.semanticLabel || '(none)';
      labels[l] = (labels[l] || 0) + 1;
      const tris = m.indices ? m.indices.length / 3 : 0;
      if (tris > maxTris) { maxTris = tris; maxVerts = m.vertices ? m.vertices.length / 3 : 0; }
    });
    const ss = this.rec.probes.spaceSetup;
    ss.meshes = meshes.size;
    ss.meshLabels = labels;
    ss.largestMesh = { triangles: maxTris, vertices: maxVerts };
    this.rev++;
  }

  /** @param {any} f */
  createAnchor(f) {
    const A = this.rec.probes.anchor;
    A.space = this.rec.granted.referenceSpace;
    if (!this.enabled.includes('anchors') || typeof f.createAnchor !== 'function') {
      this.anchorState = 'unsupported';
      A.state = 'unsupported';
      this.rev++;
      return;
    }
    this.anchorState = 'creating';
    const t0 = performance.now();
    let p;
    try { p = f.createAnchor(new XRRigidTransform(), this.space); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then((/** @type {any} */ a) => {
      A.resolveMs = Math.round(performance.now() - t0);
      if (!a) throw new Error('createAnchor resolved without an anchor');
      if (this.ended) { a.delete?.(); return; }
      this.anchor = a;
      this.anchorState = 'ok';
      A.state = 'created';
      this.rev++;
    }).catch((/** @type {any} */ e) => {
      this.anchorState = 'failed';
      A.state = `failed: ${errText(e)}`;
      this.rev++;
    });
  }

  /** @param {any} f */
  trackAnchor(f) {
    const A = this.rec.probes.anchor;
    this.anchorFrames++;
    const pose = this.anchor ? f.getPose(this.anchor.anchorSpace, this.space) : null;
    if (pose || this.anchorFrames > 600) {
      A.state = pose ? 'ok' : 'no pose after 600 frames';
      A.framesToPose = this.anchorFrames;
      try { this.anchor?.delete(); } catch { /* ignore */ }
      this.anchor = null;
      this.anchorState = pose ? 'ok' : 'failed';
      this.rev++;
    }
  }

  /** @param {any} f */
  readDepth(f) {
    this.depthTries++;
    if (this.depthTries > 600) { this.rec.probes.depth = { state: 'no valid depth after 600 frames' }; this.depthDone = true; this.rev++; return; }
    const vp = f.getViewerPose(this.space);
    if (!vp) return;
    let di = null;
    try { di = this.renderer.xr.getBinding().getDepthInformation(vp.views[0]); } catch (e) {
      this.rec.probes.depth = { state: `getDepthInformation threw: ${errText(e)}` };
      this.depthDone = true;
      this.rev++;
      return;
    }
    if (!di || di.isValid === false) return;
    const m = di.normDepthBufferFromNormView && di.normDepthBufferFromNormView.matrix;
    let identity = null;
    if (m) { identity = true; for (let i = 0; i < 16; i++) if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-4) identity = false; }
    this.rec.probes.depth = {
      state: 'ok',
      atFrame: this.depthTries,
      width: di.width ?? null,
      height: di.height ?? null,
      textureType: di.textureType ?? null,
      imageIndex: di.imageIndex ?? null,
      rawValueToMeters: di.rawValueToMeters ?? null,
      depthNear: di.depthNear ?? null,
      depthFar: di.depthFar === Infinity ? 'Infinity' : di.depthFar ?? null,
      normDepthBufferFromNormViewIdentity: identity,
      threeHasDepthSensing: this.renderer.xr.hasDepthSensing(),
    };
    this.depthDone = true;
    this.rev++;
  }

  /**
   * @param {any} f
   * @param {number} ms
   */
  readLight(f, ms) {
    let est = null;
    try { est = f.getLightEstimate(this.lightProbe); } catch (e) { this.rec.probes.light.estimate = `threw: ${errText(e)}`; this.lightDone = true; return; }
    if (est) {
      const i = est.primaryLightIntensity, d = est.primaryLightDirection;
      this.rec.probes.light.estimate = {
        atMs: Math.round(ms),
        intensity: i ? [i.x, i.y, i.z].map((v) => Math.round(v * 1000) / 1000) : null,
        direction: d ? [d.x, d.y, d.z].map((v) => Math.round(v * 1000) / 1000) : null,
        shCoefficients: est.sphericalHarmonicsCoefficients ? est.sphericalHarmonicsCoefficients.length : null,
      };
      this.lightDone = true;
      this.rev++;
    } else if (ms > 20000) { this.rec.probes.light.estimate = 'none in 20 s'; this.lightDone = true; this.rev++; }
  }

  /** @param {number} ms */
  sampleBounds(ms) {
    const g = this.bounded.boundsGeometry;
    const n = g ? g.length : 0;
    const B = this.rec.probes.bounds;
    if (n !== this.boundsLastN) {
      this.boundsLastN = n;
      B.samples.push({ atMs: Math.round(ms), points: n });
      if (n > B.maxPoints) {
        B.maxPoints = n;
        B.points = Array.from(g, (/** @type {any} */ p) => [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100]);
      }
      this.rev++;
    }
  }

  toggleRun() {
    if (this.perf.running) return;
    if (this.requestedHz) { this.event(`wait: switching to ${this.requestedHz} Hz`); return; }
    this.perf.startRun(RUN_MS, `${Math.round(this.perf.hz)} Hz ${this.mode}`);
    this.perf.mark('run start');
    this.event(`run start ${Math.round(this.perf.hz)} Hz`);
  }

  cycleRate() {
    const s = /** @type {any} */ (this.session);
    const rates = frameRates(this.session);
    // The frameRate attribute reads 0 at start on Quest and lags a switch: use the measured rate.
    const next = nextRate(rates, this.perf.hz);
    if (next === null || this.rateBusy || typeof s.updateTargetFrameRate !== 'function') { this.event('rate switch unavailable'); return; }
    this.rateBusy = true;
    this.requestedHz = next;
    this.requestedAt = performance.now();
    this.perf.mark('rate switch');
    const sw = { requested: next, from: this.perf.hz, attrAfter: null, measuredAfter: null };
    const F = this.rec.probes.frameRate;
    if (F.switches.length < 30) F.switches.push(sw);
    s.updateTargetFrameRate(next).then(() => {
      sw.attrAfter = s.frameRate ?? null;
      this.event(`rate requested ${next} Hz`);
    }).catch((/** @type {any} */ e) => { this.requestedHz = 0; this.event(`rate ${next} failed: ${errText(e)}`); })
      .finally(() => { this.rateBusy = false; });
  }

  toggleClear() {
    this.loop.explicitClear = !this.loop.explicitClear;
    this.rec.probes.clear.explicit = this.loop.explicitClear;
    this.rec.probes.clear.toggles.push({ atMs: Math.round(performance.now()), explicit: this.loop.explicitClear });
    this.event(`explicit clear ${this.loop.explicitClear ? 'on' : 'off'}`);
  }

  /** @param {string} msg */
  event(msg) {
    if (this.rec.events.length < 300) this.rec.events.push({ atMs: this.t0 >= 0 ? Math.round(performance.now() - this.t0) : 0, msg });
    this.rev++;
  }

  stop() {
    this.ended = true;
    for (const side of /** @type {const} */ (['left', 'right'])) {
      try { this.hitSrc[side]?.cancel(); } catch { /* session gone */ }
      this.hitSrc[side] = null;
    }
    try { this.anchor?.delete(); } catch { /* ignore */ }
    this.anchor = null;
    const H = this.hit;
    for (const k of /** @type {const} */ (['inside', 'outside', 'unknown'])) {
      const b = H[k];
      /** @type {any} */ (b).avgDist = b.hits ? Math.round((b.sumDist / b.hits) * 100) / 100 : null;
      /** @type {any} */ (b).hitRate = b.samples ? Math.round((100 * b.hits) / b.samples) : null;
      b.maxDist = Math.round(b.maxDist * 100) / 100;
    }
  }

  /** HUD text, rebuilt only when `rev` changes. */
  lines() {
    const r = this.rec, g = r.granted, P = r.probes, s = /** @type {any} */ (this.session);
    const short = { 'local-floor': 'floor', 'plane-detection': 'planes', 'mesh-detection': 'meshes', 'hand-tracking': 'hands', 'depth-sensing': 'depth', 'light-estimation': 'light', 'body-tracking': 'body', 'bounded-floor': 'bounded' };
    const nm = (/** @type {string} */ f) => /** @type {any} */ (short)[f] || f;
    const out = [`CQC Pass-Through ${r.version} · ${r.mode}`];
    out.push(`Space ${g.referenceSpace} · blend ${g.environmentBlendMode} · ${this.perf.measured ? `${this.perf.hz} Hz` : 'measuring Hz'}${this.requestedHz ? ` → ${this.requestedHz}` : ''} [${(g.supportedFrameRates || []).join('/')}]`);
    out.push(`Granted: ${(g.enabledFeatures || []).filter((/** @type {string} */ f) => f !== 'viewer' && f !== 'local').map(nm).join(' ')}`);
    if (g.missing && g.missing.length) out.push(`! Not granted: ${g.missing.map(nm).join(' ')}`);
    const ss = P.spaceSetup;
    out.push(ss.planes ? `✓ Space Setup: ${ss.planes} planes, ${ss.meshes} meshes · you are ${this.where.toUpperCase()}` : `• Space Setup: ${typeof ss.summary === 'string' ? ss.summary : 'waiting…'}`);
    const A = P.anchor;
    out.push(`${A.state === 'ok' ? '✓' : A.state === 'pending' || A.state === 'created' ? '•' : '!'} Anchor in ${g.referenceSpace}: ${A.state}${A.framesToPose ? ` (pose after ${A.framesToPose} frames)` : ''}`);
    if (r.mode === 'probe') {
      const D = P.depth;
      const dOn = (g.enabledFeatures || []).includes('depth-sensing');
      out.push(D ? `${D.state === 'ok' ? '✓' : '!'} Depth: ${D.state === 'ok' ? `${D.width}×${D.height} near ${D.depthNear} · clear ${this.loop.explicitClear ? 'ON' : 'OFF'} [X]` : D.state}` : `• Depth: ${dOn ? 'waiting…' : 'not granted'}`);
      const L = P.light, B = P.body;
      out.push(`• Light: ${L ? (L.estimate ? (typeof L.estimate === 'string' ? L.estimate : 'estimate ✓') : L.probe) : '-'} · Body: ${B ? (B.firstBody ? `✓ ${B.firstBody.joints} joints` : B.granted ? 'waiting…' : 'not granted') : '-'}`);
    }
    if (r.mode === 'bounds') {
      const B = P.bounds;
      out.push(`• Bounds: ${B ? (B.space === 'granted' ? `${B.maxPoints} points max (${B.samples.length} changes)` : B.space) : 'waiting…'}`);
    }
    if (this.hitOk) {
      const fmt = (/** @type {HitBucket} */ b) => `${b.hits}/${b.samples}`;
      out.push(`• Hit-test [hold trigger at walls]: inside ${fmt(this.hit.inside)} · outside ${fmt(this.hit.outside)}${this.floorCount ? '' : ` · no room ${fmt(this.hit.unknown)}`}`);
    } else out.push('! Hit-test: not granted');
    const rc = this.perf.recent(72);
    out.push(`Frame ${rc.intervalAvg} ms (${rc.fps} fps) · CPU ${rc.cpuAvg} ms · max ${rc.intervalMax} ms`);
    const L = this.perf.lastResult;
    if (this.perf.running) out.push(`• Timing run: ${Math.floor(this.perf.runElapsed())}/60 s at ${Math.round(this.perf.hz)} Hz — stay still`);
    else if (L) out.push(`${L.pass ? '✓' : '!'} Last run ${L.label}: CPU p99 ${L.cpu.p99} ms (${L.cpuP99PctOfPeriod}%) · missed ${L.missedPct}% · ${L.pass ? 'PASS' : 'FAIL'}`);
    else out.push('• Timing run: press A (60 s)');
    out.push(`[A] 60 s timing  [B] next rate  [X] clear  [both grips 1 s] exit`);
    return out;
  }
}
