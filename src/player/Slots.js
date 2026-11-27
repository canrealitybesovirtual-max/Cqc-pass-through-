// @ts-check
/**
 * Where the guns ride and how they leave and return (pure; CONTRACTS.md "W2",
 * docs/PLAN.md §8). Numbers are CQC's tested ones (CONFIG.weapons.slotReach,
 * slingAnim: grabReach, holsterTime, arc, draw), values only.
 *
 * - Glock: holster on the right hip. AKM: slung on the back, taken over the
 *   right shoulder. Spare magazines: pouch on the left hip.
 * - Grab: the empty strong hand within 0.13 m of the holstered grip centre
 *   (for the back, 0.15 m of the rifle's grip-to-butt line over the
 *   shoulder), and the squeeze
 *   rises past 0.55, or rose in the last 150 ms when the hand arrives. The gun
 *   settles into the fitted grip in 0.15 s.
 * - Let go within 0.24 m of the slot: the gun travels in along a smooth arc
 *   (0.34 s, 5 cm sideways bow). Anywhere else: it falls for 0.3 s, shrinks
 *   away and grows back in its slot (scale only, never a transparency switch).
 * - Controller pose lost for more than 0.25 s: auto-holster.
 *
 * `Carry` is the per-weapon state machine; `GrabSense` the per-hand squeeze
 * timing and entry ticks; the distance helpers are the grab zones.
 */

export const SLOTS = Object.freeze({
  grabReach: 0.13,
  backLen: 0.27,          // m grip centre → butt of the tucked carry (BodyEstimator.backLen is the live value)
  backReach: 0.15,        // m from that grip-to-butt line over the shoulder (v0.3 research-fit B)
  pouchReach: 0.15,       // m left grip to the pouched magazine's top (CQC pouchReach 0.16 × s)
  slotReach: 0.24,
  armS: 0.15,
  drawS: 0.15,
  holsterS: 0.34,
  bow: 0.05,
  returnDelayS: 0.3,
  shrinkS: 0.1,
  growS: 0.1,
  lostS: 0.25,
  /** Haptics [strength, ms] (PLAN §8 table). */
  tick: Object.freeze([0.08, 10]),
  draw: Object.freeze([0.35, 18]),
  holster: Object.freeze([0.4, 20]),
});

export const CARRY_SLOT = 0;
export const CARRY_DRAW = 1;
export const CARRY_HAND = 2;
export const CARRY_HOLSTER = 3;
export const CARRY_DROP = 4;
export const CARRY_SHRINK = 5;
export const CARRY_GROW = 6;
export const CARRY_NAMES = Object.freeze(['slot', 'draw', 'hand', 'holster', 'drop', 'shrink', 'grow']);

/** `Carry.update` results. */
export const EV_NONE = 0;
/** The draw finished: the gun is in the fitted grip. */
export const EV_IN_HAND = 1;
/** The holster arc arrived: seated in its slot (seat sound). */
export const EV_STOWED = 2;
/** The dropped gun vanished and is now growing back in its slot. */
export const EV_RETURNING = 3;
/** Back in the slot after a return. */
export const EV_RETURNED = 4;

/** @param {number} u */
const easeOut = (u) => 1 - (1 - u) * (1 - u);
/** @param {number} u */
const smoothU = (u) => u * u * (3 - 2 * u);

export class Carry {
  constructor() {
    this.state = CARRY_SLOT;
    /**
     * Seconds in the current state. Born a double (0.5, then 0), so V8 never moves the field from
     * small-integer to double representation mid-play (a map deprecation migrates objects lazily,
     * which allocates).
     */
    this.t = 0.5;
    this.t = 0;
  }

  get inHand() { return this.state === CARRY_DRAW || this.state === CARRY_HAND; }
  get inSlot() { return this.state === CARRY_SLOT || this.state === CARRY_GROW; }
  /** Grabbable from its slot. */
  get grabbable() { return this.state === CARRY_SLOT || this.state === CARRY_GROW; }

  /**
   * Weight of the hand pose (draw) or of the slot pose (holster arc), 0..1, eased.
   * SLOT / GROW: 0 (slot), HAND: 1, DRAW: rises, HOLSTER: progress toward the slot.
   */
  get blend() {
    switch (this.state) {
      case CARRY_DRAW: return easeOut(Math.min(1, this.t / SLOTS.drawS));
      case CARRY_HAND: return 1;
      case CARRY_HOLSTER: return smoothU(Math.min(1, this.t / SLOTS.holsterS));
      default: return 0;
    }
  }

  /** Display scale (shrink and grow on a return). */
  get scale() {
    if (this.state === CARRY_SHRINK) return Math.max(0, 1 - this.t / SLOTS.shrinkS);
    if (this.state === CARRY_GROW) return Math.min(1, this.t / SLOTS.growS);
    return 1;
  }

  /** @returns {boolean} the gun left its slot for the hand */
  grab() {
    if (!this.grabbable) return false;
    this._go(CARRY_DRAW);
    return true;
  }

  /**
   * The hand let go.
   * @param {boolean} nearSlot within `slotReach` of the slot
   * @returns {boolean} the gun was in the hand
   */
  release(nearSlot) {
    if (!this.inHand) return false;
    this._go(nearSlot ? CARRY_HOLSTER : CARRY_DROP);
    return true;
  }

  /** Controller tracking lost too long: back to the holster. */
  lost() { if (this.inHand) this._go(CARRY_HOLSTER); }

  /** Put it in its slot now (new round). */
  stow() { this._go(CARRY_SLOT); }

  /**
   * @param {number} dt
   * @returns {number} EV_*
   */
  update(dt) {
    if (!(dt > 0)) return EV_NONE;
    this.t += dt;
    switch (this.state) {
      case CARRY_DRAW:
        if (this.t >= SLOTS.drawS) { this._go(CARRY_HAND); return EV_IN_HAND; }
        break;
      case CARRY_HOLSTER:
        if (this.t >= SLOTS.holsterS) { this._go(CARRY_SLOT); return EV_STOWED; }
        break;
      case CARRY_DROP:
        if (this.t >= SLOTS.returnDelayS) this._go(CARRY_SHRINK);
        break;
      case CARRY_SHRINK:
        if (this.t >= SLOTS.shrinkS) { this._go(CARRY_GROW); return EV_RETURNING; }
        break;
      case CARRY_GROW:
        if (this.t >= SLOTS.growS) { this._go(CARRY_SLOT); return EV_RETURNED; }
        break;
      default:
        break;
    }
    return EV_NONE;
  }

  /** @param {number} s */
  _go(s) { this.state = s; this.t = 0; }
}

/**
 * Per-hand squeeze timing and grab-zone entry ticks.
 * `update` once per frame with the hand's squeeze edges, then `wantsGrab`.
 */
export class GrabSense {
  constructor() {
    /** Seconds since the squeeze rose while it is still held; Infinity when released. */
    this.sinceDown = Infinity;
    /** Bit per zone the hand is inside (entry ticks). */
    this.inside = 0;
  }

  /**
   * @param {number} dt @param {boolean} squeezeDown rose this frame @param {boolean} squeezeHeld
   */
  update(dt, squeezeDown, squeezeHeld) {
    if (squeezeDown) this.sinceDown = 0;
    else if (squeezeHeld) this.sinceDown += dt > 0 ? dt : 0;
    else this.sinceDown = Infinity;
  }

  /** The squeeze rose this frame or within the last 150 ms and is still held. */
  get wantsGrab() { return this.sinceDown <= SLOTS.armS; }

  /** A grab used the squeeze: the same press never grabs twice. */
  consume() { this.sinceDown = Infinity; }

  /**
   * Track zone `bit`; true on the frame the hand enters it.
   * @param {number} bit @param {boolean} isInside
   */
  enter(bit, isInside) {
    const was = (this.inside & bit) !== 0;
    if (isInside) this.inside |= bit; else this.inside &= ~bit;
    return isInside && !was;
  }
}

/**
 * Distance from p to a.
 * @param {number} px @param {number} py @param {number} pz @param {ArrayLike<number>} a
 */
export function pointDist(px, py, pz, a) {
  return Math.hypot(px - a[0], py - a[1], pz - a[2]);
}

/**
 * Distance from p to the segment a + u·t, t ∈ [0, len] (u a unit vector).
 * @param {number} px @param {number} py @param {number} pz
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} u @param {number} len
 */
export function segmentDist(px, py, pz, a, u, len) {
  const dx = px - a[0], dy = py - a[1], dz = pz - a[2];
  let t = dx * u[0] + dy * u[1] + dz * u[2];
  t = t < 0 ? 0 : t > len ? len : t;
  return Math.hypot(dx - u[0] * t, dy - u[1] * t, dz - u[2] * t);
}

/**
 * Holster arc: lerp from `a` to `b` by `k` (0..1) plus a sideways bow
 * `SLOTS.bow · sin(πk)` along the unit vector `side`; written to out[o..o+2].
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {number} k
 * @param {ArrayLike<number>} side @param {Float64Array|Float32Array|number[]} out @param {number} o
 */
export function arcPoint(a, b, k, side, out, o) {
  const bow = SLOTS.bow * Math.sin(Math.PI * k);
  out[o] = a[0] + (b[0] - a[0]) * k + side[0] * bow;
  out[o + 1] = a[1] + (b[1] - a[1]) * k + side[1] * bow;
  out[o + 2] = a[2] + (b[2] - a[2]) * k + side[2] * bow;
}
