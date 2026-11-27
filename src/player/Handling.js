// @ts-check
/**
 * The hands on the weapon (pure; CONTRACTS.md "W2", PLAN §8 and §14): the
 * magazine well, the rack, the support hand, the draw's trigger gate and the
 * haptics rule. Numbers are CQC's tested ones (values only):
 * - magazine seats within 3 cm laterally, from `window` below to 2.5 cm above
 *   the seat, axis dot over 0.7, and it must leave the well (4.5 cm sideways
 *   or `window` + 3 cm below) before it can seat again; window 0.15 m on
 *   pistols, 0.07 m on rifles (CQC magWindow), last stroke at 0.55 m/s;
 * - rack reach 0.085 m, slips off 0.16 m from the slide line;
 * - the support hand counts within 0.08 m, and steers a rifle only when the
 *   hands are more than 0.12 m apart;
 * - a haptic pulse of 0.4 or more may cut a running weaker pulse; weaker
 *   pulses never cut one (the Quest replaces a running pulse).
 *
 * All positions here are in gun space (metres, +Y up, −Z muzzle).
 */

export const HANDLING = Object.freeze({
  rackReach: 0.085,
  rackSlip: 0.16,
  supportReach: 0.08,
  supportMinSpan: 0.12,
  supportSlip: 0.2,          // m: the left hand left the handguard (design)
  magLateral: 0.03,
  magAbove: 0.025,
  magDot: 0.7,
  magLeaveLateral: 0.045,
  magLeaveBelow: 0.03,
  magLeaveDot: 0.5,          // design: a captured magazine twisted this far out of line comes free
  magHomeAt: 0.012,          // m below the seat: pushed home, the catch takes it (design)
  magSlide: 0.55,
  assistS: 1.2,              // contract: assisted reload for testing
  gateTrigger: 0.3,          // PLAN §8 trigger gate after a draw
  gateSlot: 0.15,
  gateThigh: 0.1,            // m from the estimated thigh line (design)
  gateRay: 1.5,              // m of the bore line checked against the thighs (design)
  knock: 0.4,
});

export const MAG_FREE = 0;
/** Captured by the well: guided along its axis by the hand. */
export const MAG_GUIDED = 1;

/**
 * One magazine against one well. Feed it the magazine top relative to the
 * seat, the well axis and the alignment each frame while the magazine is in
 * the hand; `home` turns true on the frame it is pushed home.
 */
export class MagWell {
  /** @param {number} window capture depth below the seat (m) */
  constructor(window) {
    this.window = window;
    this.state = MAG_FREE;
    /** Signed distance along the axis (negative = below the seat). */
    this.along = 0;
    this.lateral = 0;
    /** Seated this frame. */
    this.home = false;
    /** Just pulled out or let go in the well: must leave it before it can seat again. */
    this.blocked = false;
  }

  reset() { this.state = MAG_FREE; this.home = false; this.blocked = false; this.along = 0; this.lateral = 0; }

  /** The magazine came out of this well (or was taken there): it must leave before seating again. */
  block() { this.blocked = true; this.state = MAG_FREE; }

  /**
   * @param {number} dx @param {number} dy @param {number} dz magazine top − seat (gun space)
   * @param {number} ax @param {number} ay @param {number} az well axis (unit, pointing into the gun)
   * @param {number} dot alignment of the magazine's own axis with the well axis
   * @returns {number} MAG_FREE | MAG_GUIDED
   */
  update(dx, dy, dz, ax, ay, az, dot) {
    const H = HANDLING;
    const along = dx * ax + dy * ay + dz * az;
    const lx = dx - ax * along, ly = dy - ay * along, lz = dz - az * along;
    const lateral = Math.sqrt(lx * lx + ly * ly + lz * lz);
    this.along = along;
    this.lateral = lateral;
    this.home = false;
    const out = lateral > H.magLeaveLateral || along < -(this.window + H.magLeaveBelow) || !(dot >= H.magLeaveDot);
    if (this.blocked) {
      if (out) this.blocked = false;
      return MAG_FREE;
    }
    if (this.state === MAG_GUIDED) {
      if (out) { this.state = MAG_FREE; return MAG_FREE; }
      if (along >= -H.magHomeAt) this.home = true;
      return MAG_GUIDED;
    }
    if (lateral < H.magLateral && along > -this.window && along < H.magAbove && dot > H.magDot) {
      this.state = MAG_GUIDED;
      if (along >= -H.magHomeAt) this.home = true;
    }
    return this.state;
  }
}

/**
 * Rack fraction of travel from the hand's position along the slide axis.
 * @param {number} along hand position along the slide axis (m, gun space)
 * @param {number} offset `along` at the grab minus the slide offset then (m)
 * @param {number} travel slide travel (m)
 */
export function rackFraction(along, offset, travel) {
  const f = (along - offset) / travel;
  return f > 0 ? (f < 1 ? f : 1) : 0;
}

/**
 * The draw's trigger gate (PLAN §8): after a draw the trigger is ignored until
 * it has been seen below 0.3, the muzzle is more than 0.15 m from the slot,
 * and the bore does not point at the estimated thighs.
 */
export class TriggerGate {
  constructor() { this.open = true; this.low = false; }

  /** A draw started: close the gate. */
  arm() { this.open = false; this.low = false; }

  /**
   * @param {number} trigger analog 0..1
   * @param {number} muzzleToSlot m
   * @param {boolean} atThigh the bore line passes the thighs
   * @returns {boolean} open
   */
  update(trigger, muzzleToSlot, atThigh) {
    if (this.open) return true;
    if (trigger < HANDLING.gateTrigger) this.low = true;
    if (this.low && muzzleToSlot > HANDLING.gateSlot && !atThigh) this.open = true;
    return this.open;
  }
}

/**
 * Shortest distance between the segment o + d·t (t ∈ [0, len], d unit) and
 * the segment a–b.
 * @param {number} ox @param {number} oy @param {number} oz
 * @param {number} dx @param {number} dy @param {number} dz @param {number} len
 * @param {ArrayLike<number>} s segment points [ax, ay, az, bx, by, bz] at offset `o`
 * @param {number} o
 */
export function segSegDist(ox, oy, oz, dx, dy, dz, len, s, o) {
  const ax = s[o], ay = s[o + 1], az = s[o + 2];
  const ex = s[o + 3] - ax, ey = s[o + 4] - ay, ez = s[o + 5] - az;
  const ux = dx * len, uy = dy * len, uz = dz * len;
  const rx = ox - ax, ry = oy - ay, rz = oz - az;
  const a = ux * ux + uy * uy + uz * uz, e = ex * ex + ey * ey + ez * ez, f = ex * rx + ey * ry + ez * rz;
  let t, u;
  if (a < 1e-12 && e < 1e-12) { t = 0; u = 0; } else if (a < 1e-12) { t = 0; u = clamp01(f / e); } else {
    const c = ux * rx + uy * ry + uz * rz;
    if (e < 1e-12) { u = 0; t = clamp01(-c / a); } else {
      const b = ux * ex + uy * ey + uz * ez, den = a * e - b * b;
      t = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      u = (b * t + f) / e;
      if (u < 0) { u = 0; t = clamp01(-c / a); } else if (u > 1) { u = 1; t = clamp01((b - c) / a); }
    }
  }
  const px = ox + ux * t - (ax + ex * u), py = oy + uy * t - (ay + ey * u), pz = oz + uz * t - (az + ez * u);
  return Math.sqrt(px * px + py * py + pz * pz);
}

/** @param {number} x */
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * Does the bore line point at either estimated thigh?
 * @param {number} ox @param {number} oy @param {number} oz muzzle
 * @param {number} dx @param {number} dy @param {number} dz bore (unit)
 * @param {ArrayLike<number>} thighs hip L, knee L, hip R, knee R (BodyEstimator.thighs)
 */
export function boreAtThighs(ox, oy, oz, dx, dy, dz, thighs) {
  const H = HANDLING;
  return segSegDist(ox, oy, oz, dx, dy, dz, H.gateRay, thighs, 0) < H.gateThigh
    || segSegDist(ox, oy, oz, dx, dy, dz, H.gateRay, thighs, 6) < H.gateThigh;
}

/**
 * Haptics rule per hand: a knock (≥ 0.4) cuts only a weaker running pulse; a
 * tick (< 0.4) never cuts a running pulse.
 */
export class HapticGate {
  constructor() { this.until = 0; this.level = 0; }

  /**
   * @param {number} now seconds
   * @param {number} strength 0..1
   * @param {number} ms
   * @returns {boolean} the pulse may play now
   */
  allow(now, strength, ms) {
    if (!(strength > 0) || !(ms > 0)) return false;
    if (now < this.until && (strength < HANDLING.knock || this.level >= strength)) return false;
    this.until = now + ms / 1000;
    this.level = strength;
    return true;
  }

  reset() { this.until = 0; this.level = 0; }
}
