// @ts-check
/**
 * Allocation-free frame recorder (docs/PLAN.md §10 "How we measure").
 *
 * Per XR frame: the interval since the previous XR frame, the CPU time of the
 * frame callback, and that time split per system. Missed frame = interval over
 * 1.5 × the display period. A timed "run" (e.g. 60 s at 72 Hz) fills two
 * histograms (0.5 ms bins) for percentiles. Every missed frame goes to an
 * append-only hitch log with its per-system split and the last event marker.
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
    // Hitch log: t, interval, cpu, then one value per system
    this.hitchStride = 3 + this.nSys;
    this.hitchCapacity = hitchCapacity;
    this.hitches = new Float32Array(hitchCapacity * this.hitchStride);
    this.hitchMarker = new Uint16Array(hitchCapacity);
    this.hitchCount = 0; // total ever (the log keeps the first `hitchCapacity`)
    /** Event marker codes; index 0 = none. */
    /** @type {string[]} */ this.markerNames = ['-'];
    this.pendingMarker = 0;
    this.lastMarker = 0;
    this.skipNext = true; // first interval after start/resume is not a frame interval
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

  /** Register (once) and queue a named event marker for the next hitch entry. */
  mark(name) {
    let code = this.markerNames.indexOf(name);
    if (code < 0) { code = this.markerNames.length; this.markerNames.push(name); }
    this.pendingMarker = code;
  }

  /** Call when frames stop (pause, session end) so the gap isn't counted. */
  resetTiming() { this.skipNext = true; this.lastT = -1; }

  /** @param {number} t XR frame timestamp (ms) */
  beginFrame(t) {
    this.frameStart = this.now();
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
    if (this.pendingMarker) { this.lastMarker = this.pendingMarker; this.pendingMarker = 0; }
    if (this.skipNext || this.interval <= 0) { this.skipNext = false; return; }
    this._measure(this.interval);
    const h = this.head;
    this.ringInterval[h] = this.interval;
    this.ringCpu[h] = cpu;
    for (let i = 0; i < this.nSys; i++) this.ringSys[h * this.nSys + i] = this.sysAcc[i];
    this.ringCalls[h] = drawCalls > 65535 ? 65535 : drawCalls;
    this.head = (h + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;

    const missed = this.interval > 1.5 * this.periodMs;
    if (missed) {
      if (this.hitchCount < this.hitchCapacity) {
        const o = this.hitchCount * this.hitchStride;
        this.hitches[o] = this.lastT;
        this.hitches[o + 1] = this.interval;
        this.hitches[o + 2] = cpu;
        for (let i = 0; i < this.nSys; i++) this.hitches[o + 3 + i] = this.sysAcc[i];
        this.hitchMarker[this.hitchCount] = this.lastMarker;
      }
      this.hitchCount++;
    }
    this.lastMarker = 0;

    if (this.running) {
      this.runFrames++;
      this.histInterval[binOf(this.interval)]++;
      this.histCpu[binOf(cpu)]++;
      if (this.interval > this.runMaxInterval) this.runMaxInterval = this.interval;
      if (cpu > this.runMaxCpu) this.runMaxCpu = cpu;
      if (missed) {
        this.runMissed++;
        this.runConsec++;
        if (this.runConsec > this.runMaxConsec) this.runMaxConsec = this.runConsec;
      } else this.runConsec = 0;
      if (this.interval > 2 * this.periodMs) this.runOver2x++;
      if (this.lastT - this.runStart >= this.runDuration) this._finishRun();
    }
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
    const n = Math.min(this.hitchCount, this.hitchCapacity);
    const out = [];
    for (let k = 0; k < n; k++) {
      const o = k * this.hitchStride;
      /** @type {Record<string, any>} */
      const e = { t: Math.round(this.hitches[o]), interval: round2(this.hitches[o + 1]), cpu: round2(this.hitches[o + 2]) };
      for (let i = 0; i < this.nSys; i++) e[this.systems[i]] = round2(this.hitches[o + 3 + i]);
      e.marker = this.markerNames[this.hitchMarker[k]];
      out.push(e);
    }
    return { total: this.hitchCount, kept: n, entries: out };
  }
}

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
