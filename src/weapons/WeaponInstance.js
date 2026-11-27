// @ts-check
/**
 * One weapon's mechanism (pure; docs/CONTRACTS.md "Weapons", W1): parallel state machines for
 * the magazine, the chamber, the slide (Glock) or bolt carrier (AKM), the firing mechanism
 * (striker / hammer) with its trigger reset, and the selector.
 *
 * Events in (from WeaponSystem, on input edges): `triggerPull`, `triggerRelease` (or the analog
 * `setTrigger`), `magRelease`, `magInsert(rounds)`, `rackPull(fraction)`, `rackRelease`,
 * `slideRelease`, `selector`; then `update(dt)` once per frame to run the timed parts (firing
 * cycle, spring-driven strokes, the AKM's auto sear).
 *
 * Events out: assignable callbacks, called synchronously with integer or boolean arguments (no
 * payload objects; no doubles either, which V8 would box). They may read the instance but must
 * not call its event methods; queue such reactions for the next frame.
 *   onFire(w)            a round fired; `w.late` = seconds of the current update left after the
 *                        shot (0 when it broke in triggerPull). The bore at this moment is the shot line.
 *   onDry(w)             the striker / hammer fell on an empty chamber (click)
 *   onEject(w, live)     a case (live = false) or an unfired round (live = true) left the port
 *   onLock(w)            the slide stop caught the slide open
 *   onMagOut(w, rounds)  the magazine dropped free with this many rounds
 *   onMagIn(w, rounds)   a magazine seated with this many rounds
 *   onChamber(w, cycled) the slide closed on a freshly fed round; `cycled` = true when the firing
 *                        cycle fed it (no sound or haptic of its own), false after a hand action
 * Extra (not in the contract table, for the view, sounds and haptics):
 *   onReset(w)           the trigger reset click (released past reset with the mechanism cocked)
 *   onRack(w)            a hand pulled the slide / carrier to the rear (rack haptic, rack-back sound)
 *   onHome(w, kind)      the slide / carrier closed after a hand action: HOME_RACK (let go from the
 *                        rear), HOME_RELEASE (slide release pressed), HOME_EASED (ridden home)
 *   onSelector(w, index) the selector moved to `def.modes[index]`
 *
 * Mechanics (both guns):
 * - Fires only when the slide is in battery, the striker / hammer is cocked and the trigger
 *   breaks on a fresh pull. A pull that starts out of battery does nothing until the trigger has
 *   been released and pulled again (disconnector), except on AKM auto (below).
 * - A shot runs the cycle: rearward (`backS`), the case ejects at the rear and the mechanism is
 *   re-cocked, then forward (`homeS`) stripping the next round if a magazine with rounds is seated.
 * - After a dry fire the striker / hammer stays down: the trigger is dead until the slide is moved
 *   back past `cockAt` (Glock: no second strike; AKM: hammer down).
 * - Racking by hand: past `ejectAt` the chamber is emptied (a live round flies out), past `feedAt`
 *   the breech face is behind the magazine, so letting go (or riding the slide forward below
 *   `feedBelow`) strips and chambers the top round. A short pull only press-checks.
 * Glock: the follower of an empty seated magazine lifts the slide stop, so the slide locks open
 *   after the last shot or on a rack with an empty magazine. Releasing the magazine or seating a
 *   new one does not drop the slide; the slide release (or a rack) does, chambering a round if
 *   the new magazine has one. It fires with the magazine out (no magazine safety); then the slide
 *   does not lock (no follower).
 * AKM: no hold-open; the carrier closes on an empty chamber and the next pull clicks. Selector
 *   safe -> auto -> semi (lever order, wrapping to safe). Safe blocks the trigger and stops the
 *   charging handle at `safeLimit`; the lever only swings up to safe with the carrier forward. In
 *   auto, while the trigger is held the auto sear releases the hammer `autoDelayS` after each time
 *   the carrier closes, which sets the 600 rpm rate; that includes letting go of the charging
 *   handle with the trigger held.
 *
 * Ammo is conserved: rounds loaded = shots + live rounds ejected + rounds left in dropped magazines
 * + magazine + chamber. `check()` reports an illegal state; the tests fuzz both.
 *
 * Slide / carrier position (`slidePos`, a fraction of travel) and every flag are plain fields for
 * the view to read each frame. No allocation after construction.
 */

/** @typedef {import('./WeaponDefs.js').WeaponDef} WeaponDef */
/** @typedef {import('./WeaponDefs.js').FireMode} FireMode */

export const CHAMBER_EMPTY = 0;
export const CHAMBER_LIVE = 1;
/** A fired case, only between the shot and the rear of the cycle. */
export const CHAMBER_SPENT = 2;

/** Closed and locked: the only state that can fire. */
export const SLIDE_BATTERY = 0;
/** Firing cycle, rearward stroke. */
export const SLIDE_CYCLE = 1;
/** Forward stroke under the recoil spring (after a shot, a rack or a slide release). */
export const SLIDE_FORWARD = 2;
/** In the support hand (rack). */
export const SLIDE_HELD = 3;
/** Held open by the slide stop. */
export const SLIDE_LOCKED = 4;
export const SLIDE_NAMES = Object.freeze(['battery', 'cycle', 'forward', 'held', 'locked']);

/** `onHome` kinds. */
export const HOME_EASED = 0;
export const HOME_RACK = 1;
export const HOME_RELEASE = 2;
/** Internal: the forward stroke of the firing cycle (no onHome). */
const HOME_CYCLE = -1;

/** A pull must move the slide this far (fraction) before the hand takes it. */
const GRAB_EPS = 0.01;
/** Letting go from further back than this slams the slide home; nearer, it was eased. */
const SLAM_MIN = 0.1;
/** Longest interval one update simulates (the loop already clamps to 0.1 s). */
const MAX_DT = 0.25;
/** Transitions per update, a guard; a 0.25 s update needs about 10 at 600 rpm. */
const MAX_STEPS = 64;

const noop = () => {};

/**
 * Whole rounds within [0, cap]; NaN and negatives give 0.
 * @param {number} n @param {number} cap
 */
function clampRounds(n, cap) {
  n = Math.floor(n);
  return n > 0 ? (n < cap ? n : cap) : 0;
}

/**
 * @typedef {Object} WeaponSnapshot  one reused object, refreshed by snapshot()
 * @property {string} weapon     def id
 * @property {number} mag        rounds in the seated magazine, -1 with the magazine out
 * @property {number} chambered  1 with a live round in the chamber, else 0
 * @property {boolean} magSeated
 * @property {FireMode} mode
 * @property {string} slide      one of SLIDE_NAMES
 * @property {boolean} locked    slide locked open
 * @property {boolean} cocked    striker / hammer cocked (false = dead trigger)
 * @property {number} shots      rounds fired since reset
 * @property {number} rev        changes whenever anything above changes (redraw-on-change)
 */

export class WeaponInstance {
  /**
   * @param {Readonly<WeaponDef>} def
   * @param {{ rounds?: number, chambered?: boolean, mode?: FireMode, magSeated?: boolean }} [opts]
   *   initial load (default: the def's startRounds + 1 chambered, startMode, magazine seated)
   */
  constructor(def, opts = {}) {
    this.def = def;
    this.id = def.id;

    this.magSeated = true;
    this.magRounds = 0;
    /** CHAMBER_EMPTY | CHAMBER_LIVE | CHAMBER_SPENT */
    this.chamber = CHAMBER_EMPTY;

    /** SLIDE_* state */
    this.slide = SLIDE_BATTERY;
    /** Fraction of travel, 0 = in battery, 1 = full rear. */
    this.slidePos = 0;
    /** Where the current forward stroke ends (0, or lockPos when the slide stop is up). */
    this.stopPos = 0;
    this.homeKind = HOME_CYCLE;
    /** The breech face went behind the magazine; the next forward stroke strips a round. */
    this.feedArmed = false;
    /** A round was stripped on this stroke (onChamber when the slide closes on it). */
    this.fedStroke = false;
    /** onRack already sent for this stroke. */
    this.racked = false;

    /** Striker (trigger bar) / hammer cocked. */
    this.cocked = false;
    /** Trigger held past its break point. */
    this.trigHeld = false;
    /** The sear released on the current pull (a reset click is due on release). */
    this.broke = false;

    this.modeIndex = 0;
    /** @type {FireMode} */ this.mode = def.modes[0];
    /** AKM auto: seconds until the auto sear releases the hammer; -1 = not pending. */
    this.autoT = -1;

    /** Analog trigger thresholds for setTrigger (player setting; default from the def). */
    this.breakAt = def.trigger.break;
    this.resetAt = def.trigger.reset;

    this.shots = 0;
    this.rev = 0;
    /** For onFire: seconds of the current update that remain after the shot. */
    this.late = 0;

    /** @type {(w: WeaponInstance) => void} */ this.onFire = noop;
    /** @type {(w: WeaponInstance) => void} */ this.onDry = noop;
    /** @type {(w: WeaponInstance, live: boolean) => void} */ this.onEject = noop;
    /** @type {(w: WeaponInstance) => void} */ this.onLock = noop;
    /** @type {(w: WeaponInstance, rounds: number) => void} */ this.onMagOut = noop;
    /** @type {(w: WeaponInstance, rounds: number) => void} */ this.onMagIn = noop;
    /** @type {(w: WeaponInstance, cycled: boolean) => void} */ this.onChamber = noop;
    /** @type {(w: WeaponInstance) => void} */ this.onReset = noop;
    /** @type {(w: WeaponInstance) => void} */ this.onRack = noop;
    /** @type {(w: WeaponInstance, kind: number) => void} */ this.onHome = noop;
    /** @type {(w: WeaponInstance, index: number) => void} */ this.onSelector = noop;

    /** @type {WeaponSnapshot} */
    this.snap = {
      weapon: def.id, mag: 0, chambered: 0, magSeated: true, mode: def.startMode,
      slide: SLIDE_NAMES[0], locked: false, cocked: false, shots: 0, rev: 0,
    };

    this.reset(opts.rounds ?? def.startRounds, opts.chambered ?? def.startChambered,
      opts.mode ?? def.startMode, opts.magSeated ?? true);
  }

  /**
   * Re-issue the weapon: slide in battery, the mechanism cocked if a round is chambered
   * (decocked on an empty chamber: rack it), no callbacks.
   * @param {number} [rounds] magazine rounds
   * @param {boolean} [chambered]
   * @param {FireMode} [mode] ignored if the weapon has no such mode
   * @param {boolean} [magSeated]
   */
  reset(rounds = this.def.startRounds, chambered = this.def.startChambered, mode = this.def.startMode, magSeated = true) {
    const d = this.def;
    this.magSeated = magSeated;
    this.magRounds = magSeated ? clampRounds(rounds, d.capacity) : 0;
    this.chamber = chambered ? CHAMBER_LIVE : CHAMBER_EMPTY;
    this.slide = SLIDE_BATTERY;
    this.slidePos = 0;
    this.stopPos = 0;
    this.homeKind = HOME_CYCLE;
    this.feedArmed = this.fedStroke = this.racked = false;
    this.cocked = chambered;
    this.trigHeld = this.broke = false;
    const mi = d.modes.indexOf(mode);
    this.modeIndex = mi >= 0 ? mi : d.modes.indexOf(d.startMode);
    this.mode = d.modes[this.modeIndex];
    this.autoT = -1;
    this.shots = 0;
    this.rev++;
  }

  // ---------------------------------------------------------------- events in

  /**
   * The trigger broke (pressed past its break point).
   * @returns {boolean} a round fired
   */
  triggerPull() {
    if (this.trigHeld) return false;
    this.trigHeld = true;
    if (this.mode === 'safe' || this.slide !== SLIDE_BATTERY || !this.cocked) return false;
    this.late = 0;
    return this._release();
  }

  /** The trigger went forward past its reset point. */
  triggerRelease() {
    if (!this.trigHeld) return;
    this.trigHeld = false;
    this.autoT = -1;                       // the trigger sear catches the hammer
    if (this.broke) {
      this.broke = false;
      if (this.cocked) this.onReset(this);
    }
  }

  /**
   * Analog trigger (0..1) with this weapon's break / reset hysteresis; an alternative to calling
   * triggerPull / triggerRelease on input edges.
   * @param {number} value
   * @returns {boolean} a round fired
   */
  setTrigger(value) {
    if (!(value >= 0)) value = 0;
    if (this.trigHeld) {
      if (value < this.resetAt) this.triggerRelease();
      return false;
    }
    return value > this.breakAt ? this.triggerPull() : false;
  }

  /**
   * Magazine catch pressed: the magazine drops free.
   * @returns {number} rounds in the dropped magazine, or -1 when none was seated
   */
  magRelease() {
    if (!this.magSeated) return -1;
    const n = this.magRounds;
    this.magSeated = false;
    this.magRounds = 0;
    this.rev++;
    this.onMagOut(this, n);
    return n;
  }

  /**
   * A magazine seated (the view handles alignment, push and the AKM rock-in).
   * @param {number} rounds clamped to [0, capacity]
   * @returns {boolean} false when a magazine is already seated
   */
  magInsert(rounds) {
    if (this.magSeated) return false;
    this.magSeated = true;
    this.magRounds = clampRounds(rounds, this.def.capacity);
    this.rev++;
    this.onMagIn(this, this.magRounds);
    return true;
  }

  /**
   * The support hand holds the slide / charging handle at `fraction` of travel (0 = home,
   * 1 = full rear), measured from the rack point at home. Call it every frame while held. The
   * hand takes a closed slide once it moves it past 1 %, and a locked one once pulled off the stop;
   * a slide in its firing cycle is too fast to catch.
   * @param {number} fraction
   */
  rackPull(fraction) {
    const sd = this.def.slide, s = this.slide;
    let f = fraction > 0 ? (fraction < 1 ? fraction : 1) : 0;          // NaN -> 0
    if (this.mode === 'safe' && f > sd.safeLimit) f = sd.safeLimit;     // the lever blocks the handle
    if (s === SLIDE_BATTERY) {
      if (f <= GRAB_EPS) return;
      this.autoT = -1;
    } else if (s === SLIDE_LOCKED) {
      if (f <= sd.lockPos + GRAB_EPS) return;
    } else if (s !== SLIDE_HELD) {
      return;
    }
    if (s !== SLIDE_HELD) { this.slide = SLIDE_HELD; this.rev++; }
    // Ridden forward over the slide stop while an empty magazine's follower holds it up: caught.
    if (f < sd.lockPos && this.slidePos >= sd.lockPos && this._stopUp()) {
      this.slidePos = sd.lockPos;
      this._lock();
      return;
    }
    this.slidePos = f;
    this._travel();
  }

  /** The support hand let go of the slide / charging handle. */
  rackRelease() {
    if (this.slide !== SLIDE_HELD) return;
    this._forward(this.slidePos > SLAM_MIN ? HOME_RACK : HOME_EASED, false);
  }

  /**
   * Slide-stop lever pressed down (Glock): a locked slide runs home, chambering a round if the
   * magazine has one. The thumb holds the stop down, so it closes even on an empty magazine.
   * @returns {boolean} the slide was released
   */
  slideRelease() {
    if (!this.def.hasSlideRelease || this.slide !== SLIDE_LOCKED) return false;
    this._forward(HOME_RELEASE, true);
    return true;
  }

  /**
   * Move the selector to the next position in lever order (wrapping). Moving up to safe needs the
   * carrier forward of the lever's notch.
   * @returns {boolean} the selector moved
   */
  selector() {
    const modes = this.def.modes, n = modes.length;
    if (n < 2) return false;
    const next = this.modeIndex + 1 < n ? this.modeIndex + 1 : 0;
    if (modes[next] === 'safe' && !this._canSafe()) return false;
    this.modeIndex = next;
    this.mode = modes[next];
    if (this.mode !== 'auto') this.autoT = -1;
    this.rev++;
    this.onSelector(this, next);
    return true;
  }

  /**
   * Run the timed mechanics. Leftover time carries across transitions, so the cyclic rate is
   * exact whatever the frame times.
   * @param {number} dt seconds (NaN, 0 or negative: nothing happens; capped at 0.25 s)
   */
  update(dt) {
    if (!(dt > 0)) return;
    let left = dt < MAX_DT ? dt : MAX_DT;
    const sd = this.def.slide;
    for (let i = 0; i < MAX_STEPS && left > 0; i++) {
      const s = this.slide;
      if (s === SLIDE_CYCLE) {
        const need = (1 - this.slidePos) * sd.backS;
        if (left < need) {
          const pos = this.slidePos + left / sd.backS;
          this.slidePos = pos < 1 ? pos : 1;           // rounding never overshoots the rear
          left = 0;
        } else { left -= need; this._atRear(); }
      } else if (s === SLIDE_FORWARD) {
        const need = (this.slidePos - this.stopPos) * sd.homeS;
        if (left < need) {
          const pos = this.slidePos - left / sd.homeS;
          this.slidePos = pos > this.stopPos ? pos : this.stopPos;
          left = 0;
        } else { left -= need; this._arrive(); }
      } else if (s === SLIDE_BATTERY && this.autoT >= 0) {
        if (left < this.autoT) { this.autoT -= left; left = 0; } else {
          left -= this.autoT;
          this.autoT = -1;
          this.late = left;
          this._release();                             // the auto sear lets the hammer go
        }
      } else {
        left = 0;
      }
    }
  }

  // ---------------------------------------------------------------- state for the HUD and view

  /** The HUD's view of the weapon (one reused object). */
  snapshot() {
    const o = this.snap;
    o.mag = this.magSeated ? this.magRounds : -1;
    o.chambered = this.chamber === CHAMBER_LIVE ? 1 : 0;
    o.magSeated = this.magSeated;
    o.mode = this.mode;
    o.slide = SLIDE_NAMES[this.slide];
    o.locked = this.slide === SLIDE_LOCKED;
    o.cocked = this.cocked;
    o.shots = this.shots;
    o.rev = this.rev;
    return o;
  }

  /** Live rounds in the gun (magazine + chamber). */
  rounds() { return this.magRounds + (this.chamber === CHAMBER_LIVE ? 1 : 0); }

  get inBattery() { return this.slide === SLIDE_BATTERY; }
  get locked() { return this.slide === SLIDE_LOCKED; }
  /** Glock slide-stop lever up (view part 3): locked, or pushed up by an empty follower at the rear. */
  get stopRaised() {
    return this.slide === SLIDE_LOCKED || (this.slidePos >= this.def.slide.lockPos && this._stopUp());
  }
  /** Selector lever angle (rad) for the view. */
  get selectorRad() { return this.def.selectorRad[this.modeIndex]; }

  /**
   * Invariants (tests, dev asserts).
   * @returns {string} '' when the state is legal, else what is wrong
   */
  check() {
    const d = this.def, sd = d.slide, s = this.slide, p = this.slidePos;
    if (!(Number.isInteger(this.magRounds) && this.magRounds >= 0 && this.magRounds <= d.capacity)) return 'magazine rounds out of range';
    if (!this.magSeated && this.magRounds !== 0) return 'rounds counted in a magazine that is out';
    if (this.chamber !== CHAMBER_EMPTY && this.chamber !== CHAMBER_LIVE && this.chamber !== CHAMBER_SPENT) return 'chamber state';
    if (this.chamber === CHAMBER_SPENT && s !== SLIDE_CYCLE) return 'fired case outside the firing cycle';
    if (!(p >= 0 && p <= 1)) return 'slide position out of range';
    if (s === SLIDE_BATTERY && p !== 0) return 'in battery but not closed';
    if (s === SLIDE_BATTERY && this.feedArmed) return 'closed with a feed pending';
    if (this.feedArmed && this.chamber !== CHAMBER_EMPTY) return 'feed pending with the chamber occupied (double feed)';
    if (s === SLIDE_LOCKED && !(d.lockOnEmpty && p === sd.lockPos && this.feedArmed)) return 'locked open on a gun without a slide stop, or off the stop';
    if (s === SLIDE_FORWARD && !(this.stopPos <= p)) return 'forward stroke past its stop';
    if (s < SLIDE_BATTERY || s > SLIDE_LOCKED) return 'slide state';
    if (d.modes[this.modeIndex] !== this.mode) return 'selector';
    if (this.mode === 'safe' && s !== SLIDE_BATTERY && s !== SLIDE_LOCKED && p > sd.safeLimit) return 'carrier past the safe lever';
    if (this.autoT >= 0 && !(this.mode === 'auto' && this.trigHeld && this.cocked && s === SLIDE_BATTERY)) return 'auto sear pending without auto, trigger, hammer or battery';
    if (this.broke && !this.trigHeld) return 'sear broke without a held trigger';
    return '';
  }

  // ---------------------------------------------------------------- internals

  /** The follower of an empty seated magazine pushes the slide stop up (Glock). */
  _stopUp() { return this.def.lockOnEmpty && this.magSeated && this.magRounds === 0; }

  /** The AKM lever can swing up to safe only with the charging handle forward of its notch. */
  _canSafe() {
    return (this.slide === SLIDE_BATTERY || this.slide === SLIDE_HELD) && this.slidePos <= this.def.slide.safeLimit;
  }

  /** The sear lets go: the striker / hammer falls (`late` set by the caller). */
  _release() {
    this.cocked = false;
    this.broke = true;
    this.rev++;
    if (this.chamber === CHAMBER_LIVE) {
      this.chamber = CHAMBER_SPENT;
      this.shots++;
      this.slide = SLIDE_CYCLE;
      this.slidePos = 0;
      this.onFire(this);
      return true;
    }
    this.onDry(this);
    return false;
  }

  /** Thresholds crossed while the hand holds the slide at slidePos. */
  _travel() {
    const sd = this.def.slide, p = this.slidePos;
    if (p >= sd.cockAt && !this.cocked) { this.cocked = true; this.rev++; }
    if (p >= sd.ejectAt && this.chamber !== CHAMBER_EMPTY) {
      const live = this.chamber === CHAMBER_LIVE;
      this.chamber = CHAMBER_EMPTY;
      this.fedStroke = false;
      this.rev++;
      this.onEject(this, live);
    }
    if (p >= sd.feedAt) {
      this.feedArmed = true;
      if (!this.racked) { this.racked = true; this.onRack(this); }
    } else if (this.feedArmed && p < sd.feedBelow) {
      this._strip();                       // ridden forward: the breech face pushes the round home
    }
  }

  /** Firing cycle at full rear: eject the case, re-cock, start forward. */
  _atRear() {
    this.slidePos = 1;
    this.cocked = true;
    this.feedArmed = true;
    if (this.chamber !== CHAMBER_EMPTY) {
      const live = this.chamber === CHAMBER_LIVE;
      this.chamber = CHAMBER_EMPTY;
      this.onEject(this, live);
    }
    this._forward(HOME_CYCLE, false);
  }

  /**
   * Start a spring-driven forward stroke from slidePos.
   * @param {number} kind HOME_* (or HOME_CYCLE)
   * @param {boolean} thumbDown the slide stop is held down (slide release)
   */
  _forward(kind, thumbDown) {
    const sd = this.def.slide;
    this.racked = false;
    this.homeKind = kind;
    if (!thumbDown && this.slidePos >= sd.lockPos && this._stopUp()) {
      this.stopPos = sd.lockPos;
    } else {
      this.stopPos = 0;
      if (this.feedArmed) this._strip();
    }
    this.slide = SLIDE_FORWARD;
    this.rev++;
    if (this.slidePos <= this.stopPos) this._arrive();
  }

  /** The breech face passes the magazine going forward: strip the top round if there is one. */
  _strip() {
    this.feedArmed = false;
    this.racked = false;
    if (this.chamber === CHAMBER_EMPTY && this.magSeated && this.magRounds > 0) {
      this.magRounds--;
      this.chamber = CHAMBER_LIVE;
      this.fedStroke = true;
      this.rev++;
    }
  }

  /** The forward stroke reached its stop: battery, or the slide stop. */
  _arrive() {
    this.slidePos = this.stopPos;
    if (this.stopPos > 0) { this._lock(); return; }
    this.slide = SLIDE_BATTERY;
    this.rev++;
    const kind = this.homeKind, fed = this.fedStroke && this.chamber === CHAMBER_LIVE;
    this.homeKind = HOME_CYCLE;
    this.fedStroke = false;
    if (this.mode === 'auto' && this.trigHeld && this.cocked) this.autoT = this.def.autoDelayS;
    if (kind !== HOME_CYCLE) this.onHome(this, kind);
    if (fed) this.onChamber(this, kind === HOME_CYCLE);
  }

  _lock() {
    this.slide = SLIDE_LOCKED;
    this.homeKind = HOME_CYCLE;
    this.fedStroke = false;
    this.racked = false;
    this.rev++;
    this.onLock(this);
  }
}
