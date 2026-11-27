// @ts-check
/**
 * Release, pick-up, lost-object and landing-sound rules for items in the real
 * house (pure: no three.js, no DOM). Research spec §7 and §12; the drop-sound
 * thresholds are CQC's tested ones (values only).
 *
 * Release decides in this order:
 * 1. Holster (or sling / pouch), only when all of these hold:
 *    - the grip is within 0.24 m of its slot;
 *    - the muzzle is within 60° of the slot's axis (dot > 0.5; the caller
 *      passes 1 where the axis does not matter: the AKM over the shoulder,
 *      a magazine at the pouch);
 *    - there is no real surface within 3 cm below it (a castShape down), so
 *      a gun laid flat on the bed beside your hip is set down, not holstered
 *      (the seated-on-the-bed case).
 * 2. Place: the hand moves under 0.35 m/s and 2 rad/s. The velocity is
 *    zeroed, so hand tremor gives no jitter.
 * 3. Otherwise a drop or a throw with the PoseHistory velocity.
 */

export const ITEMS = Object.freeze({
  slotReach: 0.24,      // m grip to slot: may holster
  holsterDot: 0.5,      // muzzle within 60° of the slot axis
  surfaceGap: 0.03,     // m: a surface this close below means "set down", not "holster"
  setDownLin: 0.35,     // m/s
  setDownAng: 2.0,      // rad/s
  pickReach: 0.13,      // m right grip to a lying gun's grip point
  pickHull: 0.05,       // m right grip to a lying gun's box
  magReach: 0.10,       // m left grip to a loose magazine (centre or box)
  pouchReach: 0.15,     // m: a magazine let go this close to the pouch goes back in it
  lostS: 10,            // s outside the world before an item returns to its slot
  outsidePad: 0.3,      // m beyond every floor polygon counts as outside
  belowCatch: 0.5,      // m under the catch slab top counts as outside
  soundGapS: 0.12,      // s between two landing sounds of one item
});

/** Release outcomes. */
export const REL_HOLSTER = 0;
export const REL_PLACE = 1;
export const REL_THROW = 2;

/**
 * @param {number} distToSlot m grip to slot
 * @param {number} muzzleDot muzzle · slot axis (1 when the axis does not matter)
 * @param {number} gapBelow m to the nearest surface below (Infinity: none within reach)
 * @param {number} lin m/s centre-of-mass speed of the hand estimate
 * @param {number} ang rad/s
 * @returns {number} REL_HOLSTER | REL_PLACE | REL_THROW
 */
export function releaseKind(distToSlot, muzzleDot, gapBelow, lin, ang) {
  if (distToSlot <= ITEMS.slotReach && muzzleDot > ITEMS.holsterDot && !(gapBelow <= ITEMS.surfaceGap)) return REL_HOLSTER;
  if (isSetDown(lin, ang)) return REL_PLACE;
  return REL_THROW;
}

/**
 * The hand was nearly still: a set-down, released with zero velocity.
 * @param {number} lin @param {number} ang
 */
export function isSetDown(lin, ang) { return !(lin >= ITEMS.setDownLin) && !(ang >= ITEMS.setDownAng); }

/** Drop-sound thresholds (CQC: contact 0.4 m/s velocity change, bounce 0.5–1.1, landing 1.1+). */
export const LAND = Object.freeze({ contactDv: 0.4, bounceDv: 0.5, landDv: 1.1 });

export const LAND_NONE = 0;
export const LAND_CONTACT = 1;
export const LAND_BOUNCE = 2;
export const LAND_HIT = 3;

/**
 * Class of a velocity change (m/s) for the sound.
 * @param {number} dv
 * @returns {number} LAND_NONE | LAND_CONTACT | LAND_BOUNCE | LAND_HIT
 */
export function landingClass(dv) {
  if (!(dv >= LAND.contactDv)) return LAND_NONE;
  if (dv < LAND.bounceDv) return LAND_CONTACT;
  if (dv < LAND.landDv) return LAND_BOUNCE;
  return LAND_HIT;
}

/**
 * Gain of a landing sound: quiet for a contact, rising with the impact, full from 3 m/s.
 * @param {number} dv
 */
export function landingGain(dv) {
  const c = landingClass(dv);
  if (c === LAND_NONE) return 0;
  if (c === LAND_CONTACT) return 0.12;
  const g = 0.25 + 0.75 * (dv - LAND.bounceDv) / (3 - LAND.bounceDv);
  return g > 1 ? 1 : g;
}

/**
 * Pick-up score of an item (≤ 1 = in reach; lower is nearer): the grip point within
 * `gripReach`, or the item's box within `boxReach`.
 * @param {number} dGrip m to the grip point @param {number} dBox m to the box (0 inside)
 * @param {number} gripReach @param {number} boxReach
 */
export function pickScore(dGrip, dBox, gripReach, boxReach) {
  const a = dGrip / gripReach, b = boxReach > 0 ? dBox / boxReach : Infinity;
  return a < b ? a : b;
}
