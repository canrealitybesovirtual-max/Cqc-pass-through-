// @ts-check
/**
 * The house learner's main-thread side (v0.5). No three.js (the GPU part,
 * src/xr/DepthTap.js, is handed in). Everything heavy happens in the learner
 * worker (src/learn/learnJob.js): this only
 * - opens the house (its frame from Space Setup; the worker loads its saved
 *   grid from IndexedDB),
 * - runs the depth readback pipeline at the scan's rate (4 Hz) or the silent
 *   learner's (1 Hz), one GL step a frame and only on frames with room
 *   (the previous frame's CPU under LEARN.budgetMs),
 * - reads one hit-test source a frame and samples the head 10 times a second
 *   into a preallocated ray batch, flushed to the worker twice a second
 *   (transferred; the worker sends the buffer back),
 * - asks for an analysis (the scan: every 2 s; play: every 10 s) and keeps
 *   the latest result; saving is the worker's (between waves, at session end).
 * Nothing here draws or shows anything; the watch shows the scan's count.
 * Per frame it allocates nothing; a flush or a readback posts one message
 * (≤ 4 per second).
 */
import { houseFrameOf } from './houseFrame.js';
import { RAY_STRIDE } from './LearnCore.js';
import { scanOverlay, baseOf } from './overlay.js';

export const LEARN = Object.freeze({ scanDepthMs: 250, playDepthMs: 1000, scanAnalyzeMs: 2000, playAnalyzeMs: 10000, headMs: 100, flushMs: 500,
  budgetMs: 8, batch: 512, openWaitMs: 4000 });

export class Learner {
  /**
   * @param {{ client: import('./LearnClient.js').LearnClient|null, tap?: import('../xr/DepthTap.js').DepthTap|null, hits?: import('./HitRays.js').HitRays|null }} o
   */
  constructor({ client, tap = null, hits = null }) {
    this.client = client;
    this.tap = tap;
    this.hits = hits;
    /** Ray batches (ArrayBuffers; one is being filled, the others are with the worker or free). */
    /** @type {ArrayBuffer[]} */ this.free = [new ArrayBuffer(LEARN.batch * RAY_STRIDE * 4), new ArrayBuffer(LEARN.batch * RAY_STRIDE * 4), new ArrayBuffer(LEARN.batch * RAY_STRIDE * 4)];
    this.batch = { buf: new Float32Array(/** @type {ArrayBuffer} */ (this.free.pop())), n: 0, cap: LEARN.batch };
    this._hands = new Float32Array(6).fill(NaN);
    this._head = { x: 0, y: 0, z: 0 };
    this._seq = 0;
    /** @type {((r: any) => void)[]} */ this.onResult = [];
    if (client) {
      client.on('opened', (m) => this.opened(m));
      client.on('buf', (m) => { if (this.tap) this.tap.release(m.pix, m.pose); this.workerMs = Math.max(this.workerMs, m.ms || 0); this.fused += m.n || 0; });
      client.on('rbuf', (m) => { if (m.buf && m.buf.byteLength === LEARN.batch * RAY_STRIDE * 4) this.free.push(m.buf); });
      client.on('result', (m) => this.gotResult(m));
      client.on('saved', (m) => { this.lastSave = { saved: m.saved, why: m.why || undefined, chunks: m.chunks, bytes: m.bytes, ms: Math.round(m.ms || 0), reason: this._saveReason, quota: m.quota || undefined }; this.saves++; this.saving = false; });
      client.on('error', (m) => { if (this.errors.length < 10) this.errors.push(`${m.where}: ${m.error}`); });
    }
    if (tap) tap.onPacket = (pix, pose) => this.packet(pix, pose);
    this.reset();
  }

  reset() {
    this.active = false;
    this.scanning = false;
    /** @type {ReturnType<typeof houseFrameOf>} */ this.frame = null;
    this.state = 'idle'; // idle → opening → open (or 'no house frame')
    this.openAt = 0;
    /** @type {any} */ this.openInfo = null;
    /** @type {import('./analyze.js').ScanResult|null} */ this.result = null;
    this.resultSeq = 0;
    /** @type {any} */ this.workerStats = null;
    this.lastHead = -1e9;
    this.lastFlush = -1e9;
    this.lastAnalyze = -1e9;
    this.analyzeInFlight = false;
    this.workerMs = 0;
    this.fused = 0;
    this.headSamples = 0;
    this.flushes = 0;
    this.dropped = 0;
    this.gateSkips = 0;
    this.saves = 0;
    this.saving = false;
    /** @type {any} */ this.lastSave = null;
    this._saveReason = '';
    /** @type {string[]} */ this.errors = [];
    this.batch.n = 0;
  }

  /** The learner can run (a worker client exists). */
  get available() { return !!this.client && !this.client.failed; }

  /**
   * A play session starts: the depth tap and the hit-test sources attach (both optional).
   * @param {{ session: XRSession, space: XRReferenceSpace, liveDepth: any }} o
   */
  begin({ session, space, liveDepth }) {
    this.reset();
    this.active = this.available;
    if (!this.active) return;
    if (this.tap) { this.tap.attach(session, liveDepth); this.tap.intervalMs = LEARN.playDepthMs; }
    if (this.hits) this.hits.begin(session, space);
  }

  /**
   * The house of this snapshot (Space Setup's own planes decide): the worker loads what it learned there.
   * @param {any} snapshot
   */
  open(snapshot) {
    if (!this.active || !this.client) return false;
    const base = baseOf(snapshot);
    this.frame = houseFrameOf(base);
    if (!this.frame) { this.state = 'no house frame'; return false; }
    this.state = 'opening';
    this.openAt = performance.now();
    this.client.post({ type: 'open', id: ++this._seq, houseId: this.frame.id, sig: this.frame.sig, snapshot: { planes: base.planes, meshes: base.meshes }, H: this.frame.m });
    return true;
  }

  /** @param {any} m */
  opened(m) {
    if (this.state !== 'opening') return;
    this.state = 'open';
    this.openInfo = { loaded: !!m.loaded, chunks: m.chunks, quarantined: m.quarantined, bytes: m.bytes, sessions: m.sessions, loadMs: Math.round(m.ms || 0),
      why: m.why || undefined, store: m.storeKind, waitMs: Math.round(performance.now() - this.openAt) };
    if (m.result) { this.result = m.result; this.resultSeq++; }
    this.workerStats = m.stats || null;
  }

  /** Waited long enough for the worker's open (ms since it was asked). */
  openTimedOut() { return this.state === 'opening' && performance.now() - this.openAt > LEARN.openWaitMs; }

  /** A saved house was found (and loaded) for this Space Setup. */
  get hasHouse() { return !!(this.openInfo && this.openInfo.loaded); }

  /** The walkthrough scan (fast rates) or the silent learner. @param {boolean} on */
  setScanning(on) {
    this.scanning = on;
    if (this.tap) this.tap.intervalMs = on ? LEARN.scanDepthMs : LEARN.playDepthMs;
  }

  /**
   * After a realign: the session's coordinates moved; the house frame follows Space Setup's planes.
   * @param {any} snapshot
   */
  setFrame(snapshot) {
    if (!this.active || !this.client || this.state !== 'open') return;
    const base = baseOf(snapshot), f = houseFrameOf(base);
    if (!f) return;
    this.frame = f;
    this.client.post({ type: 'frame', H: f.m, snapshot: { planes: base.planes, meshes: base.meshes } });
  }

  /**
   * Every frame (the play 'world' step, before render).
   * @param {number} t @param {XRFrame} frame @param {XRReferenceSpace} space
   * @param {{ x: number, y: number, z: number }|null} head @param {any} input the Input (controller positions for the self-mask)
   * @param {{ lastCpu: number }|null} perf
   */
  update(t, frame, space, head, input, perf) {
    if (!this.active || this.state !== 'open') return;
    const room = !perf || perf.lastCpu < LEARN.budgetMs;
    if (!room) this.gateSkips++;
    if (head) { this._head.x = head.x; this._head.y = head.y; this._head.z = head.z; }
    const H = this._hands;
    if (input) {
      for (let k = 0; k < 2; k++) {
        const h = k ? input.right : input.left;
        if (h && h.present && h.hasGrip) { H[3 * k] = h.grip[12]; H[3 * k + 1] = h.grip[13]; H[3 * k + 2] = h.grip[14]; } else { H[3 * k] = NaN; H[3 * k + 1] = NaN; H[3 * k + 2] = NaN; }
      }
    }
    // the GPU readback (at most one GL step this frame)
    let gl = false;
    if (this.tap) gl = this.tap.step(t, frame, space, room, head ? this._head : null, H);
    // a hit-test ray (not on a frame that already did GL work)
    if (this.hits && room && !gl) this.hits.step(frame, space, this.batch, head ? this._head : null);
    // the head path
    if (head && t - this.lastHead >= LEARN.headMs && this.batch.n < this.batch.cap) {
      this.lastHead = t;
      const B = this.batch.buf, b = this.batch.n * RAY_STRIDE;
      B[b] = 2; B[b + 1] = head.x; B[b + 2] = head.y; B[b + 3] = head.z; B[b + 4] = 0; B[b + 5] = 0; B[b + 6] = 0; B[b + 7] = 0;
      this.batch.n++;
      this.headSamples++;
    }
    if (this.batch.n && (t - this.lastFlush >= LEARN.flushMs || this.batch.n >= this.batch.cap - 8)) this.flush(t);
    const every = this.scanning ? LEARN.scanAnalyzeMs : LEARN.playAnalyzeMs;
    if (!this.analyzeInFlight && t - this.lastAnalyze >= every) this.analyzeNow(t);
  }

  /** @param {number} t */
  flush(t) {
    this.lastFlush = t;
    const next = this.free.pop();
    if (!next) { this.dropped += this.batch.n; this.batch.n = 0; return; } // the worker still has both: drop this batch
    const buf = /** @type {ArrayBuffer} */ (this.batch.buf.buffer);
    if (this.client) this.client.post({ type: 'rays', buf, n: this.batch.n }, [buf]);
    this.flushes++;
    this.batch.buf = new Float32Array(next);
    this.batch.n = 0;
  }

  /** @param {ArrayBuffer} pix @param {ArrayBuffer} pose */
  packet(pix, pose) {
    if (!this.client || !this.active) { if (this.tap) this.tap.release(pix, pose); return; }
    this.client.post({ type: 'depth', pix, pose }, [pix, pose]);
  }

  /** Ask the worker for an analysis now. @param {number} [t] */
  analyzeNow(t = performance.now()) {
    if (!this.client || this.state !== 'open') return false;
    this.lastAnalyze = t;
    this.analyzeInFlight = true;
    this.client.post({ type: 'analyze', id: ++this._seq });
    return true;
  }

  /** @param {any} m */
  gotResult(m) {
    this.analyzeInFlight = false;
    if (!m.result) return;
    this.result = m.result;
    this.resultSeq++;
    this.workerStats = m.stats || this.workerStats;
    for (const f of this.onResult) f(m.result);
  }

  /** Save (the worker writes; never from the frame loop: this only posts). @param {string} reason */
  save(reason) {
    if (!this.client || this.state !== 'open' || this.saving) return false;
    this.saving = true;
    this._saveReason = reason;
    this.client.post({ type: 'save', id: ++this._seq });
    return true;
  }

  /** The latest result as snapshot planes in this session's coordinates (null: nothing learned yet). */
  overlay() {
    if (!this.result || !this.frame) return null;
    return scanOverlay(this.result, this.frame.inv);
  }

  /** Session over: sources cancelled, the tap detached, the last batch and a save go to the worker. */
  end() {
    if (this.active && this.state === 'open') {
      if (this.batch.n) this.flush(Infinity);
      this.save('session end');
    }
    if (this.tap) this.tap.detach();
    if (this.hits) this.hits.end();
    const rep = this.report();
    this.active = false;
    return rep;
  }

  /** JSON-safe summary for `rec.play.learn`. */
  report() {
    const r = this.result;
    return {
      available: this.available, worker: this.client ? this.client.kind : 'none', store: this.client ? this.client.storeKind : null, state: this.state,
      house: this.frame ? this.frame.id : null, open: this.openInfo, scanning: this.scanning,
      result: r ? { openings: r.openings.length, walkedOpenings: r.openings.filter((o) => o.walked).length, floors: r.floors.length, newFloorM2: Math.round(r.newFloorM2 * 10) / 10,
        walls: r.walls.length, boxes: r.boxes.length, rooms: r.rooms, observedM2: Math.round(r.observedM2 * 10) / 10, coverage: Math.round(r.coverage * 100) / 100,
        chunks: r.chunks, analyzeMs: Math.round(r.ms * 10) / 10, key: r.key } : null,
      results: this.resultSeq, headSamples: this.headSamples, flushes: this.flushes, droppedRays: this.dropped, gateSkips: this.gateSkips, fused: this.fused,
      workerMaxMs: Math.round(this.workerMs * 10) / 10, saves: this.saves, lastSave: this.lastSave, core: this.workerStats,
      depth: this.tap ? this.tap.report() : null, hitTest: this.hits ? this.hits.report() : null, errors: this.errors.length ? this.errors.slice() : undefined,
    };
  }
}
