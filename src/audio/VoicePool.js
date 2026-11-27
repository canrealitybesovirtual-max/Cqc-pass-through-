// @ts-check
/**
 * Voice allocation for the audio engine (pure: no Web Audio, testable in Node).
 *
 * Layout of `n` voices: [0, hrtf) are HRTF-panned, [hrtf, n − ui) equal-power,
 * the last `ui` are head-locked UI voices with no panner.
 *
 * Choosing a spatial voice for a new sound (priority p, audibility a = gain ×
 * distance attenuation at the listener):
 *   1. a free voice in the preferred tier (HRTF for sounds you must locate:
 *      enemies, impacts; equal-power for your own gun and body);
 *   2. a free voice in the other spatial tier;
 *   3. steal the busy spatial voice with the lowest keep score, if that score
 *      is below the new sound's; otherwise the new sound is dropped.
 * keep score = priority × 1000 + audibility × (0.25 + 0.75 × fraction left):
 * priority always wins; within a priority the quieter, more finished sound
 * goes first.
 */

export class VoicePool {
  /**
   * @param {number} n total voices
   * @param {number} hrtf leading HRTF voices
   * @param {number} ui trailing UI voices
   */
  constructor(n, hrtf, ui) {
    if (!(n > 0) || n > 64 || hrtf < 0 || ui < 0 || hrtf + ui > n) throw new Error('bad voice layout');
    this.n = n;
    this.hrtf = hrtf;
    this.ui = ui;
    this.spatialEnd = n - ui;
    this.start = new Float64Array(n);
    /** Time the voice's sound ends (s, context clock); ≤ now = free. */
    this.end = new Float64Array(n);
    this.pri = new Float32Array(n);
    this.aud = new Float32Array(n);
    this.gen = new Uint32Array(n);
    this.ids = new Int32Array(n).fill(-1);
    this.steals = 0;
    this.drops = 0;
    this.lastStolen = false;
  }

  /** @param {number} i @param {number} now */
  busy(i, now) { return this.end[i] > now; }

  /** @param {number} now */
  busyCount(now) {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.end[i] > now) c++;
    return c;
  }

  /**
   * Keep score of a busy voice.
   * @param {number} i @param {number} now
   */
  keep(i, now) {
    const len = this.end[i] - this.start[i];
    const left = len > 0 ? Math.min(1, Math.max(0, (this.end[i] - now) / len)) : 0;
    return this.pri[i] * 1000 + this.aud[i] * (0.25 + 0.75 * left);
  }

  /**
   * @param {number} now
   * @param {number} priority
   * @param {number} audibility
   * @param {boolean} preferHrtf
   * @returns {number} voice index, or −1 (dropped)
   */
  pick(now, priority, audibility, preferHrtf) {
    this.lastStolen = false;
    const h = this.hrtf, e = this.spatialEnd;
    const a0 = preferHrtf ? 0 : h, a1 = preferHrtf ? h : e;
    const b0 = preferHrtf ? h : 0, b1 = preferHrtf ? e : h;
    for (let i = a0; i < a1; i++) if (this.end[i] <= now) return i;
    for (let i = b0; i < b1; i++) if (this.end[i] <= now) return i;
    let best = -1, bestK = Infinity;
    for (let i = 0; i < e; i++) {
      const k = this.keep(i, now);
      if (k < bestK) { bestK = k; best = i; }
    }
    if (best >= 0 && bestK < priority * 1000 + audibility) {
      this.steals++;
      this.lastStolen = true;
      return best;
    }
    this.drops++;
    return -1;
  }

  /**
   * A UI voice: a free one, else the oldest.
   * @param {number} now
   */
  pickUI(now) {
    this.lastStolen = false;
    if (this.ui === 0) return -1;
    let oldest = this.spatialEnd, t = Infinity;
    for (let i = this.spatialEnd; i < this.n; i++) {
      if (this.end[i] <= now) return i;
      if (this.start[i] < t) { t = this.start[i]; oldest = i; }
    }
    this.steals++;
    this.lastStolen = true;
    return oldest;
  }

  /**
   * Mark voice `i` as playing; returns its id (index + generation, so a stale id
   * never controls the voice's next sound).
   * @param {number} i @param {number} now @param {number} end
   * @param {number} priority @param {number} audibility
   */
  assign(i, now, end, priority, audibility) {
    this.start[i] = now;
    this.end[i] = end > now ? end : now + 1e-3;
    this.pri[i] = priority;
    this.aud[i] = audibility;
    this.gen[i] = (this.gen[i] + 1) & 0xffffff;
    const id = this.gen[i] * 64 + i;
    this.ids[i] = id;
    return id;
  }

  /** @param {number} id @returns {number} voice index, or −1 when the id is stale */
  index(id) {
    if (!(id >= 0)) return -1;
    const i = id % 64;
    return i < this.n && this.ids[i] === id ? i : -1;
  }

  /** @param {number} i @param {number} now */
  release(i, now) {
    if (this.end[i] > now) this.end[i] = now;
    this.ids[i] = -1;
  }
}
