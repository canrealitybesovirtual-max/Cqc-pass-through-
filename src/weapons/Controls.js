// @ts-check
/**
 * The weapon controls (v0.3), CQC's Quest map (bundle project rule: "A/X
 * magazine release and B/Y slide release or fire mode on EITHER hand that is
 * on the gun; empty hands: face buttons do nothing"), as data for the page's
 * "How to play", the "Get ready" card and the watch. Pure: no three.js, no DOM.
 *
 * What WeaponSystem does (the source of truth is its `_operate` / `_left`):
 * - Draw: right grip at the right hip (Glock) or over the right shoulder (AKM,
 *   slung on the back, out of sight). Seated, the Glock rides on the right
 *   thigh. Let go at the holster / shoulder to put it back.
 * - Fire: trigger (break 0.72, reset 0.40).
 * - A (right) or X (left hand on the gun): magazine release; it falls out of
 *   the well at 1.1 m/s plus the gun's motion.
 * - B (right) or Y (left hand on the gun): Glock slide release (when locked
 *   open); AKM fire selector, lever order safe → auto → semi. Right stick
 *   click also works the selector.
 * - Reload: left grip at the left hip takes a full magazine; bring it to the
 *   well and push it home. AKM: a free left hand squeezing the lower part of
 *   the seated magazine strips it into the hand.
 * - Rack: left grip on the slide rear / charging handle (a tick when the hand
 *   is in reach), pull back, let go (from slide lock: slingshot).
 * - Support: left grip on the AKM handguard (two-handed aim), or cupping the
 *   right hand on the Glock.
 * - Test aid only: hold A for 0.8 s with no magazine = assisted reload.
 * - No malfunctions: CQC had no jam mechanic (a tap-rack is just a rack).
 */

/**
 * @typedef {{ id: string, input: string, action: string }} ControlRow
 */

/** @type {ReadonlyArray<Readonly<ControlRow>>} */
export const WEAPON_CONTROLS = Object.freeze(/** @type {ControlRow[]} */ ([
  { id: 'glock', input: 'Right grip at your right hip', action: 'Draw the Glock (seated: on your right thigh)' },
  { id: 'akm', input: 'Right grip over your right shoulder', action: 'Take the AKM off your back' },
  { id: 'stow', input: 'Let go at the hip / shoulder', action: 'Holster the Glock / sling the AKM' },
  { id: 'fire', input: 'Trigger', action: 'Fire' },
  { id: 'magRelease', input: 'A, or X with the left hand on the gun', action: 'Drop the magazine' },
  { id: 'slideOrMode', input: 'B, or Y with the left hand on the gun', action: 'Glock: slide release · AKM: fire mode (safe / auto / semi)' },
  { id: 'selectorAlias', input: 'Right stick click', action: 'AKM fire mode' },
  { id: 'reload', input: 'Left grip at your left hip', action: 'Take a magazine; push it into the well' },
  { id: 'strip', input: 'Left grip on the AKM magazine', action: 'Pull the seated magazine out' },
  { id: 'rack', input: 'Left grip on the slide / charging handle', action: 'Pull back and let go' },
  { id: 'support', input: 'Left grip on the AKM handguard', action: 'Two-handed aim' },
  { id: 'assist', input: 'Hold A 1 s with no magazine', action: 'Assisted reload (test aid)' },
]).map((r) => Object.freeze(r)));

/** The compact card (the "Get ready" panel and the watch): ≤ 46 characters a line. */
export const CONTROLS_CARD = Object.freeze([
  '[How to play]',
  'Glock: right hand on your right hip, squeeze',
  'AKM: right hand over your right shoulder',
  'Fire: trigger',
  'A (or X on the gun): drop the magazine',
  'B (or Y on the gun): slide release / AKM mode',
  'Reload: left grip at left hip, push it in',
  'Rack: left grip on the slide, pull, let go',
]);
