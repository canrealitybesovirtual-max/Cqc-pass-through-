// @ts-check
/**
 * Guards around every Rapier call (pure: no three.js, no DOM). Research spec
 * "Guard.js" and the CQC lessons (values and lessons only):
 *
 * - One NaN handed to Rapier panics its wasm, and physics then stays dead for
 *   the session. Every input is checked first: finite, |v| < 1e3, sizes over
 *   1 mm, quaternions of about unit length.
 * - A call on a removed body or collider, a double removal, or a JS throw
 *   inside a query callback leaves Rapier "borrowed", and every later call
 *   throws "recursive use". So ids carry a generation number (a stale id is
 *   refused before it reaches Rapier), nothing is created or removed inside a
 *   callback (callbacks only record; the caller acts after the query), and
 *   removals are queued and applied at the start of the next step.
 * - Every Rapier call sits in a try/catch. On the first exception `failed`
 *   is set for the rest of the session and the error is kept for the record;
 *   the game falls back to the old return-to-slot rule. A crash never stops
 *   the game.
 */

/** Largest accepted coordinate or velocity component (m, m/s, rad/s). */
export const LIMIT = 1e3;
/** Smallest accepted size (m). */
export const MIN_SIZE = 0.001;
/** Item ids: low 8 bits the slot, the rest the generation (wraps at 2^15). */
export const SLOT_BITS = 8;
export const SLOT_MASK = (1 << SLOT_BITS) - 1;
const GEN_MASK = 0x7fff;

/**
 * Every component finite and within ±lim.
 * @param {number} x @param {number} y @param {number} z @param {number} [lim]
 */
export function okVec(x, y, z, lim = LIMIT) {
  // NaN fails every comparison, so this is also the finiteness test
  return x > -lim && x < lim && y > -lim && y < lim && z > -lim && z < lim;
}

/**
 * A rotation quaternion: finite, length within 0.7–1.3 (normalised by the caller).
 * @param {number} x @param {number} y @param {number} z @param {number} w
 */
export function okQuat(x, y, z, w) {
  const n = x * x + y * y + z * z + w * w;
  return n > 0.49 && n < 1.69;
}

/**
 * A size (half extent, radius): finite, over 1 mm and under the limit.
 * @param {number} s
 */
export function okSize(s) { return s > MIN_SIZE && s < LIMIT; }

/**
 * Every value of an array finite and within ±lim.
 * @param {ArrayLike<number>} a @param {number} [lim]
 */
export function okArray(a, lim = LIMIT) {
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (!(v > -lim && v < lim)) return false; }
  return true;
}

/**
 * Id from a slot and its generation.
 * @param {number} slot @param {number} gen
 */
export function makeId(slot, gen) { return ((gen & GEN_MASK) << SLOT_BITS) | (slot & SLOT_MASK); }

/** @param {number} id */
export function slotOf(id) { return id & SLOT_MASK; }

/** @param {number} id */
export function genOf(id) { return (id >>> SLOT_BITS) & GEN_MASK; }

/** The next generation after `g` (never 0, so id 0 of a fresh slot is never valid). */
export function nextGen(/** @type {number} */ g) { const n = (g + 1) & GEN_MASK; return n === 0 ? 1 : n; }

/** Session failure state and counters (one per PhysicsWorld). */
export class Guard {
  constructor() {
    /** A Rapier call threw: physics is off for the rest of the session. */
    this.failed = false;
    this.error = '';
    this.where = '';
    /** Inputs refused before they reached Rapier (non-finite, out of range, stale ids). */
    this.rejected = 0;
    /** Bodies whose pose or velocity read back non-finite (removed, counted as lost). */
    this.nan = 0;
    /** Stale or unknown ids handed in. */
    this.stale = 0;
  }

  /**
   * The first exception switches physics off for the session.
   * @param {unknown} e @param {string} where
   */
  fail(e, where) {
    if (this.failed) return;
    this.failed = true;
    const msg = e && typeof e === 'object' && 'message' in e ? String(/** @type {any} */ (e).message) : String(e);
    this.error = msg.slice(0, 240);
    this.where = where;
  }

  /** An input was refused. @returns {false} */
  reject() { this.rejected++; return false; }

  /** JSON-safe summary (allocates; session end). */
  report() {
    return { failed: this.failed, error: this.error || null, where: this.where || null, rejected: this.rejected, nan: this.nan, stale: this.stale };
  }
}
