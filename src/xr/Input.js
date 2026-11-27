// @ts-check
/**
 * Minimal controller reader for Phase 1 (Phase 2 grows this into the full
 * action layer: analog curves, `touched`, thumbrest, hands via fillPoses).
 *
 * Reads the xr-standard gamepad of each hand once per frame into preallocated
 * state and computes press edges. Allocation-free.
 */

/**
 * @typedef {{ present: boolean, source: XRInputSource|null, trigger: number, squeeze: number,
 *   a: boolean, b: boolean, aDown: boolean, bDown: boolean, triggerDown: boolean,
 *   _a: boolean, _b: boolean, _t: boolean }} HandState
 */

/** @returns {HandState} */
function hand() {
  return { present: false, source: null, trigger: 0, squeeze: 0, a: false, b: false, aDown: false, bDown: false, triggerDown: false, _a: false, _b: false, _t: false };
}

export class Input {
  constructor() {
    this.left = hand();
    this.right = hand();
    /** Number of hand-tracking sources seen this frame. */
    this.hands = 0;
  }

  /** @param {XRSession} session */
  update(session) {
    const L = this.left, R = this.right;
    L.present = R.present = false;
    this.hands = 0;
    const srcs = session.inputSources;
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i];
      if (s.hand) this.hands++;
      const gp = s.gamepad;
      if (!gp || s.hand) continue;
      const h = s.handedness === 'left' ? L : s.handedness === 'right' ? R : null;
      if (!h) continue;
      const b = gp.buttons;
      h.present = true;
      h.source = s;
      h.trigger = b.length > 0 ? b[0].value : 0;
      h.squeeze = b.length > 1 ? b[1].value : 0;
      h.a = b.length > 4 ? b[4].pressed : false; // A on right, X on left
      h.b = b.length > 5 ? b[5].pressed : false; // B on right, Y on left
    }
    edges(L);
    edges(R);
  }
}

/** @param {HandState} h */
function edges(h) {
  if (!h.present) { h.trigger = h.squeeze = 0; h.a = h.b = false; h.source = null; }
  const t = h.trigger > 0.72; // CQC's tested break point
  const tReset = h.trigger < 0.4;
  h.aDown = h.a && !h._a;
  h.bDown = h.b && !h._b;
  h.triggerDown = t && !h._t;
  h._a = h.a;
  h._b = h.b;
  h._t = t ? true : tReset ? false : h._t;
}
