// @ts-check
/**
 * Once a second, OUTSIDE the frame loop (a setInterval), the JS heap in use
 * (`performance.memory.usedJSHeapSize`, Chromium only; absent elsewhere): a
 * drop of at least `dropBytes` is a garbage collection, logged with its time
 * so a hitch at the same moment can be matched to it (v0.5, from the v0.4
 * device record where the hitches had 1–4 ms of CPU: the cause was outside
 * our callback). The sample allocates nothing but the browser's own read;
 * a drop pushes one small object (event time, at most `cap`).
 *
 * Pure: the reader and the clock are injected (Node tests).
 */
export class HeapWatch {
  /**
   * @param {{ read?: () => number|undefined|null, now?: () => number, dropBytes?: number, cap?: number,
   *   onDrop?: ((dropMB: number) => void)|null }} [o]
   */
  constructor({ read, now, dropBytes = 1 << 20, cap = 60, onDrop = null } = {}) {
    this.read = read || (() => {
      const m = /** @type {any} */ (typeof performance !== 'undefined' ? performance : null);
      return m && m.memory ? m.memory.usedJSHeapSize : null;
    });
    this.now = now || (() => performance.now());
    this.dropBytes = dropBytes;
    this.cap = cap;
    this.onDrop = onDrop;
    this.reset();
  }

  reset() {
    this.t0 = -1;
    this.last = -1;
    this.samples = 0;
    this.available = false;
    this.min = Infinity;
    this.max = 0;
    this.drops = 0;
    this.droppedBytes = 0;
    /** @type {{ t: number, fromMB: number, toMB: number }[]} */ this.log = [];
    /** Largest growth between two samples (bytes/s): the allocation rate the GC has to clean up. */
    this.maxGrowth = 0;
  }

  /** One sample (call from a 1 s timer, never from the frame loop). */
  sample() {
    let v = null;
    try { v = this.read(); } catch { v = null; }
    if (typeof v !== 'number' || !(v > 0)) return;
    const t = this.now();
    if (this.t0 < 0) this.t0 = t;
    this.available = true;
    this.samples++;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.last > 0) {
      const d = v - this.last;
      if (-d >= this.dropBytes) {
        this.drops++;
        this.droppedBytes -= d;
        if (this.log.length < this.cap) this.log.push({ t: Math.round(t - this.t0), fromMB: mb(this.last), toMB: mb(v) });
        if (this.onDrop) this.onDrop(mb(-d));
      } else if (d > this.maxGrowth) this.maxGrowth = d;
    }
    this.last = v;
  }

  /** JSON-safe summary for the session record. */
  report() {
    if (!this.available) return { available: false };
    // v0.6: the v0.5 device record read 73.05 MB in all 202 samples: the browser buckets the value (no precise
    // memory info), so the GC log is blind there; say so instead of reporting "0 GCs"
    const frozen = this.samples >= 30 && this.max === this.min;
    return { available: true, quantized: frozen, samples: this.samples, minMB: mb(this.min), maxMB: mb(this.max), lastMB: mb(this.last),
      gcDrops: this.drops, droppedMB: mb(this.droppedBytes), maxGrowthMBps: mb(this.maxGrowth), log: this.log.slice() };
  }
}

/** @param {number} b bytes */
function mb(b) { return Math.round((b / 1048576) * 100) / 100; }

/**
 * Long-animation-frame script attribution (Chromium's LoAF API): the entry's
 * scripts sorted by duration, the top `n`, JSON-safe. Event time only.
 * @param {any} e a PerformanceLongAnimationFrameTiming
 * @param {number} t0 the session start (performance.now() ms)
 * @param {number} [n]
 */
export function loafEntry(e, t0, n = 3) {
  const scripts = Array.isArray(e && e.scripts) ? e.scripts.slice() : [];
  scripts.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  return {
    t: Math.round((e.startTime || 0) - t0), ms: Math.round(e.duration || 0), blockingMs: Math.round(e.blockingDuration || 0),
    renderMs: e.renderStart ? Math.round((e.startTime || 0) + (e.duration || 0) - e.renderStart) : null,
    styleLayoutMs: e.styleAndLayoutStart ? Math.round((e.startTime || 0) + (e.duration || 0) - e.styleAndLayoutStart) : null,
    scripts: scripts.slice(0, n).map((s) => ({
      ms: Math.round(s.duration || 0), invoker: String(s.invoker || '').slice(0, 80), type: s.invokerType || '',
      fn: String(s.sourceFunctionName || '').slice(0, 60), src: String(s.sourceURL || '').split('/').slice(-2).join('/').slice(0, 80),
      at: s.sourceCharPosition ?? null, layoutMs: Math.round(s.forcedStyleAndLayoutDuration || 0),
    })),
  };
}
