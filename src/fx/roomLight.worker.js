// @ts-check
/**
 * Room-light camera worker (module worker; RoomLight.js starts it only after
 * the player turned camera matching on). Receives a 32 × 24 ImageBitmap,
 * reduces it to the stats record (roomLightMath.frameStats) and returns ~15
 * numbers. The bitmap is closed at once; no pixel leaves this worker.
 */
import { frameStats, STATS_LEN } from './roomLightMath.js';

const W = 32, H = 24;
/** @type {OffscreenCanvas|null} */ let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D|null} */ let g = null;
const hist = new Uint32Array(256);

self.onmessage = (/** @type {MessageEvent} */ e) => {
  const d = e.data || {};
  const t0 = performance.now();
  const bmp = /** @type {ImageBitmap|undefined} */ (d.bmp);
  const stats = new Float64Array(STATS_LEN);
  try {
    if (!bmp) throw new Error('no bitmap');
    if (!canvas) { canvas = new OffscreenCanvas(W, H); g = /** @type {any} */ (canvas.getContext('2d', { willReadFrequently: true })); }
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    frameStats(g.getImageData(0, 0, W, H).data, W, H, stats, hist);
  } catch {
    try { if (bmp) bmp.close(); } catch { /* closed */ }
    stats.fill(0);
  }
  /** @type {any} */ (self).postMessage({ id: d.id, capture: d.capture, stats, ms: performance.now() - t0 }, [stats.buffer]);
};
