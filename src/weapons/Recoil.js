// @ts-check
/**
 * Recoil springs (pure; docs/CONTRACTS.md "Weapons", W1).
 *
 * Three unit-mass damped springs give the held gun's recoil offset in gun space:
 * - `back`  metres along +Z (toward the shooter),
 * - `pitch` radians about +X (positive lifts the muzzle),
 * - `yaw`   radians about +Y (positive swings the muzzle left).
 * The view applies them on top of the hand pose (translate by (0, 0, back), then rotate
 * Rx(pitch) * Ry(yaw), ideally about the grip so the gun pivots in the hand). The camera never
 * moves. Each shot adds a velocity impulse (`fire`); `update` integrates.
 *
 * Integration: semi-implicit Euler in sub-steps of at most 4 ms (a long frame is split, never taken
 * as one big step, which is what made CQC's first spring blow up). Robustness:
 * - dt that is NaN, negative or 0 advances nothing;
 * - a frame at least `settleDt` long (the time for the slowest spring to decay to 1/1000) puts the
 *   springs at rest, which is where they would be anyway, without iterating;
 * - a runaway guard resets the springs if anything leaves a sane range or stops being finite.
 *
 * No allocation after construction.
 */

/** Largest integration sub-step (s). */
export const RECOIL_SUBSTEP = 0.004;
/** Runaway guard: any offset beyond these, or a non-finite value, resets the springs. */
export const RECOIL_MAX_BACK = 0.3;
export const RECOIL_MAX_ROT = 1.5;
/** Below this (offsets in m / rad, speeds per s) the springs are put exactly at rest. */
const REST = 1e-6;

/**
 * Decay rate (1/s) of the slowest mode of x'' = -k x - c x'.
 * @param {number} k @param {number} c
 */
export function springDecayRate(k, c) {
  const disc = c * c - 4 * k;
  return disc < 0 ? c / 2 : (c - Math.sqrt(disc)) / 2;
}

export class Recoil {
  /**
   * @param {Readonly<import('./WeaponDefs.js').RecoilDef>} def
   * @param {number} [seed] xorshift32 seed for the per-shot randomness (fixed in tests)
   */
  constructor(def, seed = (Math.random() * 0x7fffffff) | 0) {
    this.def = def;
    /** xorshift32 state; never 0. */
    this.seed = seed | 0 || 0x2545f491;
    /** Player setting: 1 realistic, 0.5 reduced (PLAN §8). */
    this.scale = 1;
    this.back = 0; this.pitch = 0; this.yaw = 0;
    this.vBack = 0; this.vPitch = 0; this.vYaw = 0;
    /** True while any spring is moving (update is a no-op otherwise). */
    this.active = false;
    /** Runaway-guard trips, for diagnostics. */
    this.trips = 0;
    /** A frame at least this long settles the springs completely (residual < 0.1 %). */
    this.settleDt = Math.log(1000) / Math.min(springDecayRate(def.back.k, def.back.c), springDecayRate(def.rot.k, def.rot.c));
  }

  /**
   * Uniform [0, 1). A private xorshift32 rather than Math.random, which allocates when it
   * refills its cache.
   */
  random() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  /**
   * One shot's impulse: kick and climb times a random 0.9-1.1, yaw uniform in +-yaw plus its bias,
   * all times the two-hand factor and the player's scale. (A shot with the jitter at its mean is
   * push(kick, climb, yawBias) times the same factors.)
   * @param {boolean} [twoHand] the support hand is on the gun
   */
  fire(twoHand = false) {
    const r = this.def;
    const j = r.jitterMin + (r.jitterMax - r.jitterMin) * this.random();
    const s = (twoHand ? r.twoHand : 1) * this.scale;
    const vb = r.kick * j * s, vp = r.climb * j * s, vy = (r.yawBias + (this.random() * 2 - 1) * r.yaw) * s;
    if (!(Number.isFinite(vb) && Number.isFinite(vp) && Number.isFinite(vy))) return;
    this.vBack += vb;
    this.vPitch += vp;
    this.vYaw += vy;
    this.active = true;
  }

  /**
   * Raw velocity impulse (m/s back, rad/s pitch, rad/s yaw), e.g. a flinch when the player is hit.
   * Non-finite inputs are ignored.
   * @param {number} vBack @param {number} vPitch @param {number} vYaw
   */
  push(vBack, vPitch, vYaw) {
    if (!(Number.isFinite(vBack) && Number.isFinite(vPitch) && Number.isFinite(vYaw))) return;
    this.vBack += vBack;
    this.vPitch += vPitch;
    this.vYaw += vYaw;
    this.active = true;
  }

  /** @param {number} dt seconds since the last update */
  update(dt) {
    if (!this.active || !(dt > 0)) return;          // also rejects NaN
    if (dt >= this.settleDt) { this.reset(); return; }
    const n = Math.ceil(dt / RECOIL_SUBSTEP), h = dt / n;
    const kb = this.def.back.k, cb = this.def.back.c, kr = this.def.rot.k, cr = this.def.rot.c;
    let x = this.back, vx = this.vBack, p = this.pitch, vp = this.vPitch, y = this.yaw, vy = this.vYaw;
    for (let i = 0; i < n; i++) {
      vx += (-kb * x - cb * vx) * h; x += vx * h;
      vp += (-kr * p - cr * vp) * h; p += vp * h;
      vy += (-kr * y - cr * vy) * h; y += vy * h;
    }
    // The comparisons are false for NaN, so they also catch non-finite state.
    if (!(Math.abs(x) < RECOIL_MAX_BACK && Math.abs(p) < RECOIL_MAX_ROT && Math.abs(y) < RECOIL_MAX_ROT
      && Math.abs(vx) < 1e3 && Math.abs(vp) < 1e3 && Math.abs(vy) < 1e3)) {
      this.trips++;
      this.reset();
      return;
    }
    if (Math.abs(x) < REST && Math.abs(p) < REST && Math.abs(y) < REST
      && Math.abs(vx) < REST && Math.abs(vp) < REST && Math.abs(vy) < REST) {
      this.reset();
      return;
    }
    this.back = x; this.vBack = vx; this.pitch = p; this.vPitch = vp; this.yaw = y; this.vYaw = vy;
  }

  /** Put the springs at rest (weapon holstered, dropped or switched). */
  reset() {
    this.back = this.pitch = this.yaw = 0;
    this.vBack = this.vPitch = this.vYaw = 0;
    this.active = false;
  }
}
