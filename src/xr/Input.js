// @ts-check
/**
 * Controller input, read once per XR frame into preallocated state
 * (allocation-free after construction).
 *
 * Per hand: grip pose and target-ray pose as column-major Float32Array(16)
 * in the reference space, analog trigger and squeeze, A/B (X/Y on the left),
 * thumbstick (click + axes), and press/release edges with hysteresis.
 *
 * xr-standard mapping (Quest Touch): buttons 0 trigger, 1 squeeze, 3 stick
 * click, 4 A/X, 5 B/Y; axes 2/3 = stick x/y.
 */

/**
 * @typedef {{ present: boolean, source: XRInputSource|null,
 *   hasGrip: boolean, grip: Float32Array, hasRay: boolean, ray: Float32Array,
 *   trigger: number, squeeze: number, a: boolean, b: boolean, stick: boolean, sx: number, sy: number,
 *   triggerDown: boolean, triggerUp: boolean, squeezeDown: boolean, squeezeUp: boolean,
 *   aDown: boolean, aUp: boolean, bDown: boolean, bUp: boolean, stickDown: boolean,
 *   triggerHeld: boolean, squeezeHeld: boolean, aHeldS: number, bHeldS: number,
 *   _a: boolean, _b: boolean, _stick: boolean }} HandState
 */

/** Trigger break / reset (CQC's tested values) and grip grab / release. */
export const TRIGGER_BREAK = 0.72;
export const TRIGGER_RESET = 0.4;
export const SQUEEZE_GRAB = 0.55;
export const SQUEEZE_RELEASE = 0.35;

/** @returns {HandState} */
function hand() {
  return {
    present: false, source: null,
    hasGrip: false, grip: new Float32Array(16), hasRay: false, ray: new Float32Array(16),
    trigger: 0, squeeze: 0, a: false, b: false, stick: false, sx: 0, sy: 0,
    triggerDown: false, triggerUp: false, squeezeDown: false, squeezeUp: false,
    aDown: false, aUp: false, bDown: false, bUp: false, stickDown: false,
    triggerHeld: false, squeezeHeld: false, aHeldS: 0, bHeldS: 0,
    _a: false, _b: false, _stick: false,
  };
}

export class Input {
  constructor() {
    this.left = hand();
    this.right = hand();
    /** Number of hand-tracking sources seen this frame. */
    this.hands = 0;
  }

  /**
   * @param {XRSession} session
   * @param {XRFrame} [frame] when given (with `space`), grip and ray poses are read
   * @param {XRReferenceSpace|null} [space]
   * @param {number} [dt] seconds, for held-button timers
   */
  update(session, frame, space, dt = 0) {
    const L = this.left, R = this.right;
    L.present = R.present = false;
    L.hasGrip = R.hasGrip = L.hasRay = R.hasRay = false;
    this.hands = 0;
    const srcs = session.inputSources;
    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i];
      if (s.hand) this.hands++;
      const gp = s.gamepad;
      if (!gp || s.hand) continue;
      const h = s.handedness === 'left' ? L : s.handedness === 'right' ? R : null;
      if (!h) continue;
      const b = gp.buttons, ax = gp.axes;
      h.present = true;
      h.source = s;
      h.trigger = b.length > 0 ? b[0].value : 0;
      h.squeeze = b.length > 1 ? b[1].value : 0;
      h.stick = b.length > 3 ? b[3].pressed : false;
      h.a = b.length > 4 ? b[4].pressed : false;
      h.b = b.length > 5 ? b[5].pressed : false;
      h.sx = ax.length > 2 ? ax[2] : 0;
      h.sy = ax.length > 3 ? ax[3] : 0;
      if (frame && space) {
        if (s.gripSpace) {
          const p = frame.getPose(s.gripSpace, space);
          if (p) { h.grip.set(p.transform.matrix); h.hasGrip = true; }
        }
        const r = frame.getPose(s.targetRaySpace, space);
        if (r) { h.ray.set(r.transform.matrix); h.hasRay = true; }
      }
    }
    edges(L, dt);
    edges(R, dt);
  }
}

/**
 * @param {HandState} h
 * @param {number} dt
 */
function edges(h, dt) {
  if (!h.present) { h.trigger = h.squeeze = 0; h.a = h.b = h.stick = false; h.sx = h.sy = 0; h.source = null; }
  const tWas = h.triggerHeld, sWas = h.squeezeHeld;
  h.triggerHeld = h.trigger > TRIGGER_BREAK ? true : h.trigger < TRIGGER_RESET ? false : tWas;
  h.squeezeHeld = h.squeeze > SQUEEZE_GRAB ? true : h.squeeze < SQUEEZE_RELEASE ? false : sWas;
  h.triggerDown = h.triggerHeld && !tWas;
  h.triggerUp = !h.triggerHeld && tWas;
  h.squeezeDown = h.squeezeHeld && !sWas;
  h.squeezeUp = !h.squeezeHeld && sWas;
  h.aDown = h.a && !h._a;
  h.aUp = !h.a && h._a;
  h.bDown = h.b && !h._b;
  h.bUp = !h.b && h._b;
  h.stickDown = h.stick && !h._stick;
  h.aHeldS = h.a ? h.aHeldS + dt : 0;
  h.bHeldS = h.b ? h.bHeldS + dt : 0;
  h._a = h.a;
  h._b = h.b;
  h._stick = h.stick;
}
