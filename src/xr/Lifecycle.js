// @ts-check
/**
 * Session lifecycle events → callbacks: end, visibility change, reference-space
 * reset, input sources changed. three.js does not handle `reset` itself.
 */
export class Lifecycle {
  /**
   * @param {{ onEnd: () => void, onVisibility: (state: string) => void,
   *   onReset: (e: { transform?: XRRigidTransform|null }|null) => void, onInputs: (added: number, removed: number) => void }} cb
   *   onReset gets the XRReferenceSpaceEvent itself (its `transform`: the new origin in the old space, or null)
   */
  constructor(cb) {
    this.cb = cb;
    /** @type {XRSession|null} */ this.session = null;
    /** @type {XRReferenceSpace|null} */ this.space = null;
    this._end = () => this.cb.onEnd();
    this._vis = () => this.session && this.cb.onVisibility(this.session.visibilityState);
    this._reset = (/** @type {any} */ e) => this.cb.onReset(e || null);
    this._inputs = (/** @type {any} */ e) => this.cb.onInputs(e.added ? e.added.length : 0, e.removed ? e.removed.length : 0);
  }

  /**
   * @param {XRSession} session
   * @param {XRReferenceSpace|null} space
   */
  attach(session, space) {
    this.detach();
    this.session = session;
    this.space = space;
    session.addEventListener('end', this._end);
    session.addEventListener('visibilitychange', this._vis);
    session.addEventListener('inputsourceschange', this._inputs);
    if (space) space.addEventListener('reset', this._reset);
  }

  detach() {
    if (this.session) {
      this.session.removeEventListener('end', this._end);
      this.session.removeEventListener('visibilitychange', this._vis);
      this.session.removeEventListener('inputsourceschange', this._inputs);
    }
    if (this.space) this.space.removeEventListener('reset', this._reset);
    this.session = null;
    this.space = null;
  }
}
