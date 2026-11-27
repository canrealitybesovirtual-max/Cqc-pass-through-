// @ts-check
/**
 * App state machine (pure: no DOM, no three.js, testable in Node).
 *
 * boot ──ready──▶ menu ──enter──▶ entering ──started──▶ xr ──ended──▶ menu
 *                                   └──────failed──────▶ menu
 *
 * Pause is a flag inside `xr`, not a state: the XR session keeps running
 * (the browser still calls the frame loop while the session is visible-blurred).
 */

/** @typedef {'boot'|'menu'|'entering'|'xr'} State */

export const S = Object.freeze({ BOOT: 'boot', MENU: 'menu', ENTERING: 'entering', XR: 'xr' });

/** @type {Record<State, Record<string, State>>} */
const T = {
  boot: { ready: 'menu' },
  menu: { enter: 'entering' },
  entering: { started: 'xr', failed: 'menu' },
  xr: { ended: 'menu' },
};

/** @typedef {(next: State, prev: State, ev: string, data: any) => void} Listener */

export class Game {
  constructor() {
    /** @type {State} */ this.state = S.BOOT;
    /** @type {string|null} */ this.mode = null;
    /** Pause reasons currently active (e.g. 'hidden'). Empty = running. */
    /** @type {Set<string>} */ this.pauseReasons = new Set();
    /** Last rejected events, for diagnostics. */
    /** @type {string[]} */ this.rejected = [];
    /** @type {Listener[]} */ this._listeners = [];
  }

  get paused() { return this.pauseReasons.size > 0; }

  /**
   * @param {string} ev
   * @param {any} [data]
   * @returns {boolean} whether the transition happened
   */
  send(ev, data) {
    const next = T[this.state][ev];
    if (!next) {
      this.rejected.push(`${this.state}:${ev}`);
      if (this.rejected.length > 20) this.rejected.shift();
      return false;
    }
    const prev = this.state;
    this.state = next;
    if (ev === 'enter') this.mode = data && data.mode ? String(data.mode) : null;
    if (next !== S.XR) this.pauseReasons.clear();
    for (let i = 0; i < this._listeners.length; i++) this._listeners[i](next, prev, ev, data);
    return true;
  }

  /**
   * @param {string} reason
   * @param {boolean} on
   * @returns {boolean} whether the paused flag changed
   */
  setPause(reason, on) {
    if (this.state !== S.XR) return false;
    const was = this.paused;
    if (on) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason);
    return was !== this.paused;
  }

  /** @param {Listener} fn */
  on(fn) { this._listeners.push(fn); }
}
