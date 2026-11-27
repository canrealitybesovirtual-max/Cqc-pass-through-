// @ts-check
/**
 * Minimal synchronous event bus (pure). Emitters pass a reused payload object;
 * listeners must copy anything they keep. No allocation per emit.
 */
export class Events {
  constructor() {
    /** @type {Map<string, Function[]>} */ this.map = new Map();
  }

  /**
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    let list = this.map.get(type);
    if (!list) { list = []; this.map.set(type, list); }
    list.push(fn);
    return () => { const l = this.map.get(type); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  }

  /**
   * @param {string} type
   * @param {any} [payload]
   */
  emit(type, payload) {
    const list = this.map.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }

  clear() { this.map.clear(); }
}
