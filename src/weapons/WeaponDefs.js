// @ts-check
/**
 * Weapon definitions (pure data; docs/CONTRACTS.md "Weapons", W1).
 *
 * Two real guns, modelled after their mechanisms:
 * - GLOCK: Glock 17 Gen5, 9x19 mm, striker fired, 17 + 1. The follower of an empty magazine
 *   lifts the slide stop, so the slide locks open after the last round (and on a rack with an
 *   empty magazine). No magazine safety: it fires with the magazine out. No manual safety.
 * - AKM: 7.62x39 mm, hammer fired, 30 + 1, long-stroke gas piston. Selector lever, top to
 *   bottom: safe, auto (AV), semi (OD). No bolt hold-open: after the last round the carrier
 *   closes on an empty chamber. The charging handle is part of the carrier, so it reciprocates
 *   with every shot. On safe the lever also blocks the charging handle after a short travel.
 *   Cyclic rate 600 rpm, set by the carrier cycle plus the hammer-release retarder.
 *
 * Units: metres, seconds, radians, kilograms, m/s. Gun space is the manifest's: +Y up, -Z muzzle,
 * so a positive recoil "back" moves the gun along +Z toward the shooter, positive pitch lifts the
 * muzzle and positive yaw swings it left (rotation about +Y).
 *
 * Slide (Glock) / bolt carrier (AKM) positions are fractions of its travel: 0 = in battery,
 * 1 = fully rearward. The metric travel is in the manifest (`slide.travel`).
 *
 * Values marked *(design)* are reasoned estimates that still need the headset; everything
 * marked CQC is a number tuned and tested in the CQC reference project (values only, no code).
 */

/** @typedef {'safe' | 'semi' | 'auto'} FireMode */
/** @typedef {'head' | 'neck' | 'torso' | 'pelvis' | 'limb'} HitPart */

/**
 * Unit-mass damped spring: x'' = -k x - c x'.
 * @typedef {{ k: number, c: number }} SpringDef
 */

/**
 * Recoil impulses per shot (velocity impulses into the springs) and the springs themselves.
 * @typedef {Object} RecoilDef
 * @property {number} kick      m/s along gun +Z (back)
 * @property {number} climb     rad/s, muzzle up
 * @property {number} yaw       rad/s; each shot's yaw impulse is uniform in [-yaw, +yaw] ...
 * @property {number} yawBias   rad/s ... plus this mean (negative = muzzle right)
 * @property {number} jitterMin per-shot random factor on kick and climb, uniform in [min, max]
 * @property {number} jitterMax
 * @property {number} twoHand   multiplier on all three impulses with the support hand on the gun
 * @property {SpringDef} back
 * @property {SpringDef} rot    pitch and yaw
 */

/**
 * @typedef {Object} SlideDef
 * @property {number} backS     firing cycle: shot to full rear
 * @property {number} homeS     full rear to battery under the recoil spring (shorter strokes take
 *                              proportionally less time)
 * @property {number} ejectAt   a round or case in the chamber is extracted and ejected past this
 * @property {number} feedAt    past this the breech face is behind the magazine's top round, so the
 *                              next forward stroke strips it
 * @property {number} feedBelow riding the slide forward by hand: the stripped round chambers below this
 * @property {number} cockAt    the striker (trigger bar) / hammer is re-cocked past this
 * @property {number} lockPos   where the slide stop holds the slide open (only if `lockOnEmpty`)
 * @property {number} safeLimit furthest travel with the selector on safe (1 = no limit)
 */

/**
 * @typedef {Object} WeaponDef
 * @property {'glock' | 'akm'} id        also the key of `assets.models` and `manifest.weapons`
 * @property {string} name
 * @property {string} caliber
 * @property {'striker' | 'hammer'} action
 * @property {number} capacity           magazine rounds (plus one in the chamber)
 * @property {number} startRounds        magazine rounds when the weapon is issued
 * @property {boolean} startChambered
 * @property {readonly FireMode[]} modes selector positions in lever order (top to bottom)
 * @property {FireMode} startMode
 * @property {readonly number[]} selectorRad lever angle per position, about the selector axis
 * @property {number} cyclicRpm          full-auto rate (0 = semi only)
 * @property {number} autoDelayS         full auto: carrier in battery to hammer release
 *                                       (60 / cyclicRpm - backS - homeS)
 * @property {boolean} lockOnEmpty       an empty magazine's follower lifts the slide stop
 * @property {boolean} hasSlideRelease   a slide-stop lever the thumb can press
 * @property {number} muzzleVelocity     m/s
 * @property {number} bulletMass         kg
 * @property {SlideDef} slide
 * @property {{ break: number, reset: number }} trigger analog trigger value (0..1) that breaks the
 *                                       shot and that must be passed going forward to reset
 * @property {RecoilDef} recoil
 * @property {Readonly<Record<HitPart, number>>} damage  against 100 hp
 * @property {Readonly<Record<string, string>>} sounds   keys of `manifest.sounds`
 */

/** Health every damage number is scaled against. */
export const DAMAGE_HP = 100;

/** Damage per hit part for the 9 mm (CQC, against 100 hp). */
const DAMAGE_9MM = { head: 400, neck: 120, torso: 40, pelvis: 45, limb: 24 };
/** 7.62x39 mm against the same body: 1.6 x the 9 mm (contract). */
const AKM_DAMAGE_SCALE = 1.6;

/** @param {number} x */
const milli = (x) => Math.round(x * 1000) / 1000;
/** @param {Record<HitPart, number>} d @param {number} s */
const scaleDamage = (d, s) => ({
  head: milli(d.head * s), neck: milli(d.neck * s), torso: milli(d.torso * s), pelvis: milli(d.pelvis * s), limb: milli(d.limb * s),
});

/**
 * Glock 17 Gen5.
 * - Trigger breaks at 0.72 and resets below 0.40 (CQC; the same values as `xr/Input.js`). The
 *   Glock reset is short and tactile: `onReset` is its click.
 * - Slide cycle back 15 ms, home 40 ms (CQC). Eject at 90 % of travel and feed under 35 % when
 *   riding the slide forward (CQC rack numbers). The slide stop holds the slide at about 28 of its
 *   30 mm travel (0.93) *(design)*; the trigger bar and striker reset after about a quarter of the
 *   travel (0.25 ~ 7.5 mm), so a short tug resets a dead trigger *(design)*.
 * - Recoil exactly as tuned in CQC: kick 0.9 m/s, climb 11 rad/s, yaw +-1.6 rad/s, x 0.9-1.1,
 *   x 0.55 with two hands; springs back k 520 / c 38, pitch and yaw k 300 / c 26. Single shot,
 *   one hand: about 16 mm back and 0.27 rad (16 deg) of muzzle flip, settled in ~0.4 s.
 * - 124 gr (8.0 g) NATO ball at about 360 m/s from the 114 mm barrel.
 * @type {Readonly<WeaponDef>}
 */
export const GLOCK = deepFreeze({
  id: 'glock',
  name: 'Glock 17 Gen5',
  caliber: '9x19mm',
  action: 'striker',
  capacity: 17,
  startRounds: 17,
  startChambered: true,
  modes: ['semi'],
  startMode: 'semi',
  selectorRad: [0],
  cyclicRpm: 0,
  autoDelayS: 0,
  lockOnEmpty: true,
  hasSlideRelease: true,
  muzzleVelocity: 360,
  bulletMass: 0.0080,
  slide: { backS: 0.015, homeS: 0.040, ejectAt: 0.9, feedAt: 0.9, feedBelow: 0.35, cockAt: 0.25, lockPos: 0.93, safeLimit: 1 },
  trigger: { break: 0.72, reset: 0.40 },
  recoil: {
    kick: 0.9, climb: 11, yaw: 1.6, yawBias: 0, jitterMin: 0.9, jitterMax: 1.1, twoHand: 0.55,
    back: { k: 520, c: 38 }, rot: { k: 300, c: 26 },
  },
  damage: DAMAGE_9MM,
  sounds: {
    shot: 'glockShot', dry: 'dry', reset: 'dryReset', magOut: 'glockMagOut', magIn: 'glockMagIn',
    rackBack: 'glockRackBack', rackFwd: 'glockRackFwd', slideRelease: 'glockSlideRel', brass: 'brassS',
  },
});

/**
 * AKM.
 * - Cyclic 600 rpm = 100 ms a round: carrier back 35 ms, home 55 ms *(design split)*, then the
 *   AKM's hammer-release retarder holds the hammer 10 ms after the carrier closes (it exists to
 *   stop bolt bounce and is what steadies the rate). The rate is therefore an outcome of the
 *   cycle, as on the real rifle: with the trigger held the auto sear trips each time the carrier
 *   closes, including after you let go of the charging handle.
 * - A rack needs (nearly) full travel: eject and feed at 95 % *(design)*. The hammer is cocked by
 *   the carrier at about 45 % *(design)*. On safe the lever stops the charging handle at 15 %:
 *   enough to glimpse the chamber, not to eject or cock *(design)*.
 * - The trigger resets nearer the front than the Glock's (0.35) *(design)*.
 * - Selector angles from CQC's AKM (0 / -0.17 / -0.34 rad for safe / auto / semi).
 * - 57-N-231 ball, 7.9 g at about 715 m/s from the 415 mm barrel.
 *
 * Recoil (derived; to be judged on the headset):
 * - Free recoil, from bullet plus powder-gas momentum (gas at ~1.7 x muzzle velocity):
 *     9x19:     8.0 g x 360 m/s + 0.4 g x ~630 m/s  ~ 3.1 N s into a 0.9 kg pistol -> ~3.5 m/s, ~5.4 J
 *     7.62x39:  7.9 g x 715 m/s + 1.6 g x ~1200 m/s ~ 7.6 N s into a 3.9 kg loaded AKM -> ~1.9 m/s, ~7.4 J
 *   About 2.4 x the momentum and 1.4 x the energy, delivered into a heavier gun that a shoulder and
 *   a support hand normally brace. The springs model the hand-and-gun system per unit mass (as
 *   CQC tuned it on the pistol), so the AKM gets larger impulses and springs of a braced rifle.
 * - Back: kick 1.2 m/s (1.33 x the Glock's; well under the momentum ratio, because a 4 x heavier
 *   gun takes it) into a stiffer, near-critically damped stock-on-shoulder spring, k 650 / c 48
 *   (w0 25.5 rad/s, zeta 0.94): a short shove of ~17 mm one-handed / ~10 mm braced, no bounce
 *   (Glock ~16 / ~9 mm).
 * - Climb: the bore sits above the shoulder pivot (dropped stock) and the heavy carrier slams
 *   back high on the receiver, so the AKM rises more than the pistol flips. Climb 18 rad/s into
 *   pitch k 480 / c 38 (w0 21.9 rad/s, zeta 0.87): a single shot lifts the muzzle ~0.32 rad
 *   one-handed / ~0.18 rad braced (Glock 0.27 / 0.15), and the braced rifle's stiffer spring brings
 *   it back in ~0.25 s (Glock ~0.4 s). At 10 rounds a second the shots stack: the mean rise settles
 *   at about climb x rate / k = 0.36 rad one-handed, 0.20 rad (11 deg) braced, within 3-4 rounds.
 *   The shooter has to drive the muzzle down, as on the real rifle.
 * - Yaw: +-2.0 rad/s with a -0.6 rad/s bias: AK-pattern rifles drift up and right for a
 *   right-handed shooter, and the slant compensator reduces that but does not remove it. In auto
 *   the bias settles at ~0.012 rad (0.7 deg) right one-handed.
 * - Two hands: x 0.55 (contract).
 * (tests/unit/recoil.test.js measures these figures from the integrator.)
 * @type {Readonly<WeaponDef>}
 */
export const AKM = deepFreeze({
  id: 'akm',
  name: 'AKM',
  caliber: '7.62x39mm',
  action: 'hammer',
  capacity: 30,
  startRounds: 30,
  startChambered: true,
  modes: ['safe', 'auto', 'semi'],
  startMode: 'safe',
  selectorRad: [0, -0.17, -0.34],
  cyclicRpm: 600,
  autoDelayS: 0.010,
  lockOnEmpty: false,
  hasSlideRelease: false,
  muzzleVelocity: 715,
  bulletMass: 0.0079,
  slide: { backS: 0.035, homeS: 0.055, ejectAt: 0.95, feedAt: 0.95, feedBelow: 0.35, cockAt: 0.45, lockPos: 1, safeLimit: 0.15 },
  trigger: { break: 0.72, reset: 0.35 },
  recoil: {
    kick: 1.2, climb: 18, yaw: 2.0, yawBias: -0.6, jitterMin: 0.9, jitterMax: 1.1, twoHand: 0.55,
    back: { k: 650, c: 48 }, rot: { k: 480, c: 38 },
  },
  damage: scaleDamage(DAMAGE_9MM, AKM_DAMAGE_SCALE),
  sounds: {
    shot: 'akShot', dry: 'dry', reset: 'dryReset', magOut: 'akMagOut', magIn: 'akMagIn',
    rackBack: 'akRackBack', rackFwd: 'akRackFwd', slideRelease: 'akRackFwd', brass: 'brassM',
  },
});

/** Both weapons by id. */
export const WEAPON_DEFS = deepFreeze({ glock: GLOCK, akm: AKM });

/**
 * @param {string} id
 * @returns {Readonly<WeaponDef>}
 */
export function getDef(id) {
  const d = /** @type {Record<string, Readonly<WeaponDef>>} */ (WEAPON_DEFS)[id];
  if (!d) throw new Error(`unknown weapon '${id}'`);
  return d;
}

/**
 * Seconds between full-auto rounds (Infinity for a semi-only gun).
 * @param {Readonly<WeaponDef>} def
 */
export const autoInterval = (def) => (def.cyclicRpm > 0 ? 60 / def.cyclicRpm : Infinity);

/**
 * Consistency checks for a definition (used by the tests and by any new weapon added later).
 * @param {Readonly<WeaponDef>} d
 * @returns {string[]} problems; empty when the definition is usable
 */
export function validateDef(d) {
  /** @type {string[]} */ const errs = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ msg) => { if (!ok) errs.push(`${d.id}: ${msg}`); };
  const s = d.slide, r = d.recoil;
  need(Number.isInteger(d.capacity) && d.capacity > 0, 'capacity must be a positive integer');
  need(Number.isInteger(d.startRounds) && d.startRounds >= 0 && d.startRounds <= d.capacity, 'startRounds within capacity');
  need(d.modes.length > 0 && d.modes.includes(d.startMode), 'startMode must be one of modes');
  need(d.selectorRad.length === d.modes.length, 'one selector angle per mode');
  need(d.modes.includes('auto') === d.cyclicRpm > 0, 'auto mode iff cyclicRpm > 0');
  need(s.backS > 0 && s.homeS > 0, 'slide times must be positive');
  if (d.cyclicRpm > 0) {
    need(d.autoDelayS >= 0, 'autoDelayS >= 0');
    need(Math.abs(s.backS + s.homeS + d.autoDelayS - 60 / d.cyclicRpm) < 1e-9, 'backS + homeS + autoDelayS must equal 60 / cyclicRpm');
  }
  need(s.cockAt > 0 && s.cockAt <= s.ejectAt, '0 < cockAt <= ejectAt');
  need(s.ejectAt <= s.feedAt && s.feedAt <= 1, 'ejectAt <= feedAt <= 1 (a round must leave before the next one feeds)');
  need(s.feedBelow > 0 && s.feedBelow < s.feedAt, '0 < feedBelow < feedAt');
  need(!d.lockOnEmpty || (s.lockPos >= s.feedAt && s.lockPos <= 1), 'lockPos within [feedAt, 1]: a locked slide is behind the magazine');
  need(!d.hasSlideRelease || d.lockOnEmpty, 'a slide release needs a slide stop');
  need(s.safeLimit > 0 && s.safeLimit <= 1, 'safeLimit within (0, 1]');
  need(!d.modes.includes('safe') || s.safeLimit < s.cockAt, 'on safe the charging handle must not reach the cock, eject or feed points');
  need(d.trigger.reset > 0 && d.trigger.reset < d.trigger.break && d.trigger.break < 1, '0 < trigger.reset < trigger.break < 1');
  need(r.kick > 0 && r.climb > 0 && r.yaw >= 0, 'recoil impulses must be positive');
  need(r.jitterMin > 0 && r.jitterMin <= r.jitterMax, 'recoil jitter range');
  need(r.twoHand > 0 && r.twoHand <= 1, 'twoHand within (0, 1]');
  for (const sp of [r.back, r.rot]) {
    need(sp.k > 0 && sp.c > 0, 'springs need k > 0 and c > 0');
    // semi-implicit Euler at the 4 ms sub-step: keep w0 h well inside the stable range
    need(Math.sqrt(sp.k) * 0.004 < 0.5 && sp.c * 0.004 < 0.5, 'spring too stiff for 4 ms sub-steps');
  }
  need(d.muzzleVelocity > 0 && d.bulletMass > 0, 'ballistics');
  for (const p of /** @type {HitPart[]} */ (['head', 'neck', 'torso', 'pelvis', 'limb'])) need(d.damage[p] > 0, `damage.${p}`);
  return errs;
}

/**
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
