// @ts-check
/**
 * Allocation-free frame recorder (docs/PLAN.md §10 "How we measure").
 *
 * Per XR frame: the interval since the previous XR frame, the CPU time of the
 * frame callback, and that time split per system. Missed frame = interval over
 * 1.5 × the display period. A timed "run" (e.g. 60 s at 72 Hz) fills two
 * histograms (0.5 ms bins) for percentiles. Every missed frame goes to an
 * append-only hitch log with its per-system split and the event marker.
 *
 * v0.5 (the v0.4 device record: 21 hitches with 1–4 ms of CPU each, so the
 * cause was outside our frame callback): every hitch entry also carries
 * - the PREVIOUS frame's CPU, interval and per-system split (a slow frame shows
 *   up as the next interval being long);
 * - the callback lateness (`performance.now()` at beginFrame minus the XR
 *   frame time `t`: how late the browser ran us);
 * - the NEXT interval (filled in by the following frame: a compositor stall
 *   often shows as one long interval then a short one);
 * - the marker with its age (markers stay 0.5 s, so an event a few frames
 *   before the hitch is still named);
 * and the interval skipped after a start / resume / rate change is logged as a
 * gap. A whole-session interval and CPU histogram and per-system sums and
 * peaks are kept for `sessionReport()`. Everything is preallocated: the frame
 * path allocates nothing.
 *
 * Pure: no DOM, no three.js. `now` is injectable for tests.
 */

const BIN_MS = 0.5;
const BINS = 400; // 0–200 ms, last bin = overflow

/** @typedef {{ label: string, hz: number, frames: number, seconds: number,
 *   interval: { p50: number, p95: number, p99: number, p999: number, max: number },
 *   cpu: { p50: number, p95: number, p99: number, p999: number, max: number },
 *   missed: number, missedPct: number, maxConsecutiveMissed: number, over2x: number,
 *   longTasks: number, cpuP99PctOfPeriod: number, pass: boolean }} RunResult */

export class PerfMonitor {
  /**
   * @param {{ systems: string[], capacity?: number, hitchCapacity?: number, now?: () => number }} opts
   */
  constructor({ systems, capacity = 4096, hitchCapacity = 512, now = () => performance.now() }) {
    this.systems = systems.slice();
    this.nSys = systems.length;
    this.now = now;
    this.capacity = capacity;
    // Rings (most recent ~57 s at 72 Hz)
    this.ringInterval = new Float32Array(capacity);
    this.ringCpu = new Float32Array(capacity);
    this.ringSys = new Float32Array(capacity * this.nSys);
    this.ringCalls = new Uint16Array(capacity);
    this.head = 0;
    this.count = 0;
    // Current frame
    this.sysAcc = new Float64Array(this.nSys);
    this.sysStart = new Float64Array(this.nSys);
    this.frameStart = 0;
    this.lastT = -1;
    this.interval = 0;
    this.periodMs = 1000 / 72;
    this.hz = 72;
    // Measured rate: Quest Browser reports session.frameRate = 0 at start and the
    // attribute lags a switch, so the period used for "missed" comes from the
    // median of the last 36 intervals snapped to an offered rate.
    /** @type {number[]} */ this.rates = [72, 80, 90, 120];
    this.medBuf = new Float32Array(36);
    this.medTmp = new Float32Array(36);
    this.medN = 0;
    this.pendingHz = 0;
    this.pendingCount = 0;
    this.measured = false;
    /** @type {((hz: number) => void)|null} */ this.onRateChange = null;
    // Hitch log: HITCH_FIELDS fixed values (t, interval, cpu, late, prevCpu, prevInterval, nextInterval,
    // markerAge), then this frame's split per system, then the previous frame's split per system
    this.hitchStride = HITCH_FIELDS + 2 * this.nSys;
    this.hitchCapacity = hitchCapacity;
    this.hitches = new Float32Array(hitchCapacity * this.hitchStride);
    this.hitchMarker = new Uint16Array(hitchCapacity);
    this.hitchCount = 0; // total ever (the log keeps the first `hitchCapacity`)
    /** Event marker codes; index 0 = none. */
    /** @type {string[]} */ this.markerNames = ['-'];
    /** The current marker and when it was set (`now()` ms): it names hitches for MARKER_MS. */
    this.markCode = 0;
    this.markAt = -1e9;
    /** Index of the hitch entry waiting for its next interval (-1: none). */
    this.pendingNext = -1;
    this.skipNext = true; // first interval after start/resume is not a frame interval
    // the previous frame (for the hitch entries) and this frame's callback lateness
    this.prevCpu = 0;
    this.prevInterval = 0;
    this.prevSys = new Float32Array(this.nSys);
    this.late = 0;
    /** CPU time of the last finished frame (ms): the learner skips its work after a frame near budget. */
    this.lastCpu = 0;
    // Gaps: the intervals skipped after a start, resume or rate change (t, length, marker)
    this.gapCapacity = 64;
    this.gaps = new Float32Array(this.gapCapacity * 2);
    this.gapMarker = new Uint16Array(this.gapCapacity);
    this.gapCount = 0;
    // Whole session: interval and CPU histograms, per-system sums and peaks, late peak
    this.sessHistInterval = new Uint32Array(BINS);
    this.sessHistCpu = new Uint32Array(BINS);
    this.sessSysSum = new Float64Array(this.nSys);
    this.sessSysPeak = new Float32Array(this.nSys);
    this.sessFrames = 0;
    this.sessMissed = 0;
    this.sessLateMax = 0;
    this.sessLateSum = 0;
    // Run state
    this.histInterval = new Uint32Array(BINS);
    this.histCpu = new Uint32Array(BINS);
    this.running = false;
    this.runLabel = '';
    this.runStart = 0;
    this.runDuration = 0;
    this.runFrames = 0;
    this.runMissed = 0;
    this.runConsec = 0;
    this.runMaxConsec = 0;
    this.runOver2x = 0;
    this.runMaxInterval = 0;
    this.runMaxCpu = 0;
    this.runLongTasks = 0;
    /** @type {RunResult|null} */ this.lastResult = null;
    /** @type {((r: RunResult) => void)|null} */ this.onRunComplete = null;
    /** @type {((r: { label: string, cancelled: string, elapsedS: number, incomplete: true }) => void)|null} */ this.onRunCancelled = null;
  }

  /** @param {number[]} rates offered refresh rates */
  setRates(rates) { if (rates.length) this.rates = rates.slice(); }

  /** Initial guess; the measured rate replaces it within about a second. */
  /** @param {number} hz */
  setRate(hz) {
    if (!(hz > 0) || Math.abs(hz - this.hz) < 0.5) return;
    this.hz = hz;
    this.periodMs = 1000 / hz;
    this.skipNext = true;
    this.cancelRun('rate changed');
  }

  /** Offered rate matching a median interval within 6 %, else 0. */
  /** @param {number} med */
  _snap(med) {
    for (let i = 0; i < this.rates.length; i++) {
      const p = 1000 / this.rates[i];
      if (Math.abs(med - p) < 0.06 * p) return this.rates[i];
    }
    return 0;
  }

  /** @param {number} interval */
  _measure(interval) {
    this.medBuf[this.medN++] = interval;
    if (this.medN < this.medBuf.length) return;
    this.medN = 0;
    const a = this.medTmp;
    a.set(this.medBuf);
    for (let i = 1; i < a.length; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
    const hz = this._snap(a[a.length >> 1]);
    if (!hz) return;
    if (Math.abs(hz - this.hz) < 0.5) { this.pendingHz = 0; this.pendingCount = 0; this.measured = true; return; }
    if (hz === this.pendingHz) this.pendingCount++; else { this.pendingHz = hz; this.pendingCount = 1; }
    // A new rate must hold for two windows (or one, before the first measurement).
    if (this.pendingCount >= 2 || !this.measured) {
      this.pendingHz = 0;
      this.pendingCount = 0;
      this.measured = true;
      this.setRate(hz);
      if (this.onRateChange) this.onRateChange(hz);
    }
  }

  /**
   * Register (once; a new name allocates its entry) and set a named event marker: hitch entries within
   * MARKER_MS after it carry it, with its age.
   * @param {string} name
   */
  mark(name) {
    let code = this.markerNames.indexOf(name);
    if (code < 0) {
      if (this.markerNames.length >= 65535) return;
      code = this.markerNames.length;
      this.markerNames.push(name);
    }
    this.markCode = code;
    this.markAt = this.now();
  }

  /** Call when frames stop (pause, session end) so the gap isn't counted. */
  resetTiming() { this.skipNext = true; this.lastT = -1; }

  /** @param {number} t XR frame timestamp (ms) */
  beginFrame(t) {
    this.frameStart = this.now();
    this.late = this.frameStart - t;
    this.interval = this.lastT >= 0 ? t - this.lastT : 0;
    this.lastT = t;
    for (let i = 0; i < this.nSys; i++) this.sysAcc[i] = 0;
  }

  /** @param {number} i system index */
  begin(i) { this.sysStart[i] = this.now(); }
  /** @param {number} i system index */
  end(i) { this.sysAcc[i] += this.now() - this.sysStart[i]; }

  /** @param {number} drawCalls */
  endFrame(drawCalls = 0) {
    const cpu = this.now() - this.frameStart;
    const iv = this.interval;
    this.lastCpu = cpu;
    // the hitch entry of the previous frame gets this interval as its "next"
    if (this.pendingNext >= 0) {
      if (iv > 0 && !this.skipNext) this.hitches[this.pendingNext * this.hitchStride + 6] = iv;
      this.pendingNext = -1;
    }
    if (this.skipNext || iv <= 0) {
      if (this.skipNext && iv > 0) this._gap(iv);
      this.skipNext = false;
      this._keepPrev(cpu, 0);
      return;
    }
    this._measure(iv);
    const h = this.head;
    this.ringInterval[h] = iv;
    this.ringCpu[h] = cpu;
    for (let i = 0; i < this.nSys; i++) this.ringSys[h * this.nSys + i] = this.sysAcc[i];
    this.ringCalls[h] = drawCalls > 65535 ? 65535 : drawCalls;
    this.head = (h + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;

    // whole session
    this.sessFrames++;
    this.sessHistInterval[binOf(iv)]++;
    this.sessHistCpu[binOf(cpu)]++;
    for (let i = 0; i < this.nSys; i++) {
      const v = this.sysAcc[i];
      this.sessSysSum[i] += v;
      if (v > this.sessSysPeak[i]) this.sessSysPeak[i] = v;
    }
    const late = this.late > 0 ? this.late : 0;
    this.sessLateSum += late;
    if (late > this.sessLateMax) this.sessLateMax = late;

    const missed = iv > 1.5 * this.periodMs;
    if (missed) {
      this.sessMissed++;
      if (this.hitchCount < this.hitchCapacity) {
        const k = this.hitchCount, o = k * this.hitchStride, H = this.hitches, n = this.nSys;
        H[o] = this.lastT;
        H[o + 1] = iv;
        H[o + 2] = cpu;
        H[o + 3] = this.late;
        H[o + 4] = this.prevCpu;
        H[o + 5] = this.prevInterval;
        H[o + 6] = -1; // the next interval: the following frame fills it in
        const age = this.frameStart - this.markAt;
        if (this.markCode && age <= MARKER_MS) {
          this.hitchMarker[k] = this.markCode;
          H[o + 7] = age > 0 ? age : 0;
        } else {
          this.hitchMarker[k] = 0;
          H[o + 7] = -1;
        }
        for (let i = 0; i < n; i++) {
          H[o + HITCH_FIELDS + i] = this.sysAcc[i];
          H[o + HITCH_FIELDS + n + i] = this.prevSys[i];
        }
        this.pendingNext = k;
      }
      this.hitchCount++;
    }

    if (this.running) {
      this.runFrames++;
      this.histInterval[binOf(iv)]++;
      this.histCpu[binOf(cpu)]++;
      if (iv > this.runMaxInterval) this.runMaxInterval = iv;
      if (cpu > this.runMaxCpu) this.runMaxCpu = cpu;
      if (missed) {
        this.runMissed++;
        this.runConsec++;
        if (this.runConsec > this.runMaxConsec) this.runMaxConsec = this.runConsec;
      } else this.runConsec = 0;
      if (iv > 2 * this.periodMs) this.runOver2x++;
      if (this.lastT - this.runStart >= this.runDuration) this._finishRun();
    }
    this._keepPrev(cpu, iv);
  }

  /** This frame becomes the "previous frame" of the next hitch entry. @param {number} cpu @param {number} iv */
  _keepPrev(cpu, iv) {
    this.prevCpu = cpu;
    this.prevInterval = iv;
    for (let i = 0; i < this.nSys; i++) this.prevSys[i] = this.sysAcc[i];
  }

  /** A skipped interval (after a start, resume or rate change): logged, never counted as a frame. @param {number} iv */
  _gap(iv) {
    if (this.gapCount < this.gapCapacity) {
      const o = this.gapCount * 2;
      this.gaps[o] = this.lastT;
      this.gaps[o + 1] = iv;
      // a marker set during the gap (or just before it) names it
      this.gapMarker[this.gapCount] = this.frameStart - this.markAt <= iv + MARKER_MS ? this.markCode : 0;
    }
    this.gapCount++;
  }

  /** Count a long task (from a PerformanceObserver) into the active run. */
  noteLongTask() { if (this.running) this.runLongTasks++; }

  /**
   * @param {number} durationMs
   * @param {string} label
   */
  startRun(durationMs, label) {
    this.histInterval.fill(0);
    this.histCpu.fill(0);
    this.running = true;
    this.runLabel = label;
    this.runStart = this.lastT;
    this.runDuration = durationMs;
    this.runFrames = this.runMissed = this.runConsec = this.runMaxConsec = this.runOver2x = this.runLongTasks = 0;
    this.runMaxInterval = this.runMaxCpu = 0;
  }

  /** @param {string} why */
  cancelRun(why) {
    if (!this.running) return;
    const elapsedS = Math.round(this.runElapsed());
    this.running = false;
    this.runLabel += ` (cancelled: ${why})`;
    if (this.onRunCancelled) this.onRunCancelled({ label: this.runLabel, cancelled: why, elapsedS, incomplete: true });
  }

  /** Seconds elapsed in the active run. */
  runElapsed() { return this.running ? Math.max(0, (this.lastT - this.runStart) / 1000) : 0; }

  _finishRun() {
    this.running = false;
    const n = this.runFrames;
    const p = this.periodMs;
    const cpuP99 = pct(this.histCpu, n, 0.99);
    /** @type {RunResult} */
    const r = {
      label: this.runLabel,
      hz: this.hz,
      frames: n,
      seconds: round2(this.runDuration / 1000),
      interval: { p50: pct(this.histInterval, n, 0.5), p95: pct(this.histInterval, n, 0.95), p99: pct(this.histInterval, n, 0.99), p999: pct(this.histInterval, n, 0.999), max: round2(this.runMaxInterval) },
      cpu: { p50: pct(this.histCpu, n, 0.5), p95: pct(this.histCpu, n, 0.95), p99: cpuP99, p999: pct(this.histCpu, n, 0.999), max: round2(this.runMaxCpu) },
      missed: this.runMissed,
      missedPct: n ? round2((100 * this.runMissed) / n) : 0,
      maxConsecutiveMissed: this.runMaxConsec,
      over2x: this.runOver2x,
      longTasks: this.runLongTasks,
      cpuP99PctOfPeriod: round2((100 * cpuP99) / p),
      pass: false,
    };
    // Phase 1 idle gate: CPU p99 ≤ 60 % of the period, missed ≤ 0.5 %, no double misses.
    r.pass = n > 0 && r.cpuP99PctOfPeriod <= 60 && r.missedPct <= 0.5 && r.maxConsecutiveMissed < 2;
    this.lastResult = r;
    if (this.onRunComplete) this.onRunComplete(r);
  }

  /** Recent averages from the ring (for the live HUD). */
  recent(frames = 72) {
    const n = Math.min(frames, this.count);
    let si = 0, sc = 0, mx = 0;
    for (let k = 1; k <= n; k++) {
      const h = (this.head - k + this.capacity) % this.capacity;
      si += this.ringInterval[h];
      sc += this.ringCpu[h];
      if (this.ringInterval[h] > mx) mx = this.ringInterval[h];
    }
    return { frames: n, intervalAvg: n ? round2(si / n) : 0, cpuAvg: n ? round2(sc / n) : 0, intervalMax: round2(mx), fps: si > 0 ? round2((1000 * n) / si) : 0 };
  }

  /**
   * Average and max CPU ms per system, and draw calls, over the last `frames`
   * frames (called outside the frame loop).
   * @param {number} [frames]
   * @returns {Record<string, number>}
   */
  systemAverages(frames = 72) {
    const n = Math.min(frames, this.count);
    /** @type {Record<string, number>} */
    const out = {};
    for (let i = 0; i < this.nSys; i++) {
      let sum = 0, max = 0;
      for (let k = 1; k <= n; k++) {
        const v = this.ringSys[((this.head - k + this.capacity) % this.capacity) * this.nSys + i];
        sum += v;
        if (v > max) max = v;
      }
      out[this.systems[i]] = n ? round2(sum / n) : 0;
      out[`${this.systems[i]}Max`] = round2(max);
    }
    let calls = 0, callsMax = 0;
    for (let k = 1; k <= n; k++) {
      const c = this.ringCalls[(this.head - k + this.capacity) % this.capacity];
      calls += c;
      if (c > callsMax) callsMax = c;
    }
    out.drawCalls = n ? round2(calls / n) : 0;
    out.drawCallsMax = callsMax;
    return out;
  }

  /** Plain-object export of the hitch log (called outside the frame loop). */
  exportHitches() {
    const n = Math.min(this.hitchCount, this.hitchCapacity), S = this.nSys;
    const out = [];
    for (let k = 0; k < n; k++) {
      const o = k * this.hitchStride, H = this.hitches;
      /** @type {Record<string, any>} */
      const e = { t: Math.round(H[o]), interval: round2(H[o + 1]), cpu: round2(H[o + 2]), late: round2(H[o + 3]),
        prevCpu: round2(H[o + 4]), prevInterval: round2(H[o + 5]), next: H[o + 6] >= 0 ? round2(H[o + 6]) : null };
      for (let i = 0; i < S; i++) e[this.systems[i]] = round2(H[o + HITCH_FIELDS + i]);
      /** @type {Record<string, number>} */ const prev = {};
      for (let i = 0; i < S; i++) { const v = round2(H[o + HITCH_FIELDS + S + i]); if (v > 0) prev[this.systems[i]] = v; }
      e.prev = prev;
      e.marker = this.markerNames[this.hitchMarker[k]];
      e.markerAgeMs = H[o + 7] >= 0 ? Math.round(H[o + 7]) : null;
      out.push(e);
    }
    const gaps = [];
    const g = Math.min(this.gapCount, this.gapCapacity);
    for (let k = 0; k < g; k++) gaps.push({ t: Math.round(this.gaps[2 * k]), ms: round2(this.gaps[2 * k + 1]), marker: this.markerNames[this.gapMarker[k]] });
    return { total: this.hitchCount, kept: n, entries: out, gaps: { total: this.gapCount, entries: gaps } };
  }

  /**
   * The whole session (called outside the frame loop): interval and CPU percentiles and the non-empty
   * histogram bins ([upper edge ms, frames]), per-system average and peak, callback lateness, missed frames.
   */
  sessionReport() {
    const n = this.sessFrames;
    /** @param {Uint32Array} h */
    const bins = (h) => { const a = []; for (let b = 0; b < h.length; b++) if (h[b]) a.push([round2((b + 1) * BIN_MS), h[b]]); return a; };
    /** @type {Record<string, { avg: number, peak: number }>} */ const systems = {};
    for (let i = 0; i < this.nSys; i++) systems[this.systems[i]] = { avg: n ? round2(this.sessSysSum[i] / n) : 0, peak: round2(this.sessSysPeak[i]) };
    const H = this.sessHistInterval, C = this.sessHistCpu;
    return {
      frames: n, missed: this.sessMissed, missedPct: n ? round2((100 * this.sessMissed) / n) : 0, hz: this.hz,
      interval: { p50: pct(H, n, 0.5), p95: pct(H, n, 0.95), p99: pct(H, n, 0.99), p999: pct(H, n, 0.999), hist: bins(H) },
      cpu: { p50: pct(C, n, 0.5), p95: pct(C, n, 0.95), p99: pct(C, n, 0.99), p999: pct(C, n, 0.999), hist: bins(C) },
      lateMs: { avg: n ? round2(this.sessLateSum / n) : 0, max: round2(this.sessLateMax) },
      systems, gaps: this.gapCount, markers: this.markerNames.length - 1,
    };
  }
}

/** Fixed values at the start of each hitch entry (see the constructor). */
const HITCH_FIELDS = 8;
/** A marker names hitches this long after it was set (ms). */
export const MARKER_MS = 500;

/** @param {number} ms */
function binOf(ms) {
  const b = Math.floor(ms / BIN_MS);
  return b < 0 ? 0 : b >= BINS ? BINS - 1 : b;
}

/**
 * Percentile from a histogram: the upper edge of the bin holding the q-th sample.
 * @param {Uint32Array} hist
 * @param {number} n
 * @param {number} q
 */
function pct(hist, n, q) {
  if (!n) return 0;
  const target = Math.ceil(q * n);
  let acc = 0;
  for (let b = 0; b < hist.length; b++) {
    acc += hist[b];
    if (acc >= target) return round2((b + 1) * BIN_MS);
  }
  return round2(hist.length * BIN_MS);
}

/** @param {number} v */
function round2(v) { return Math.round(v * 100) / 100; }
