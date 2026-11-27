// @ts-check
/**
 * At most one canvas-panel texture upload per frame across the game's panels
 * (docs/PLAN.md §10 "Canvas panels"). Pure; the frame is identified by the
 * loop's timestamp `t`, which every system receives unchanged within a frame.
 *
 *   if (claimUpload(t)) { draw(); texture.needsUpdate = true; }   // else retry next frame
 */

const gate = { t: Number.NaN, used: 0, perFrame: 1 };

/**
 * @param {number} t frame timestamp (ms)
 * @returns {boolean} true when this caller may upload this frame
 */
export function claimUpload(t) {
  if (t !== gate.t) { gate.t = t; gate.used = 0; }
  if (gate.used >= gate.perFrame) return false;
  gate.used++;
  return true;
}

/** For tests and session starts. */
export function resetUploadGate() {
  gate.t = Number.NaN;
  gate.used = 0;
}
