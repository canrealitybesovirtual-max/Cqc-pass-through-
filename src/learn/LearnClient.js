// @ts-check
/**
 * The main thread's side of the learner worker (v0.5). No three.js; no DOM
 * beyond `Worker`. Without a Worker (Node, an old browser) the same loop runs
 * in-process, answering from a macrotask, with memory storage (nothing is
 * kept across reloads then): `kind` says which.
 *
 *   const c = createLearnClient({ appVersion });
 *   c.on('opened', (m) => …); c.post({ type: 'open', … });
 *   c.post({ type: 'depth', pix, pose }, [pix, pose]);   // the buffers come back in a 'buf' reply
 */
import { createLearnLoop } from './learnJob.js';
import { MemoryStore } from './HouseStore.js';

/**
 * @typedef {{ kind: string, ready: boolean, failed: boolean, error: string, storeKind: string,
 *   post(m: any, transfer?: ArrayBuffer[]): void, on(type: string, f: (m: any) => void): void, terminate(): void, received: number }} LearnClient
 */

/** @param {{ appVersion?: string, worker?: boolean }} [o] @returns {LearnClient} */
export function createLearnClient({ appVersion = '', worker = true } = {}) {
  /** @type {Record<string, ((m: any) => void)[]>} */ const handlers = {};
  const c = {
    kind: 'inline', ready: false, failed: false, error: '', storeKind: 'memory', received: 0,
    /** @type {(m: any, transfer?: ArrayBuffer[]) => void} */ post: () => {},
    /** @param {string} type @param {(m: any) => void} f */
    on(type, f) { (handlers[type] || (handlers[type] = [])).push(f); },
    terminate() {},
  };
  const deliver = (/** @type {any} */ m) => {
    c.received++;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') { c.ready = true; c.storeKind = m.storeKind || c.storeKind; }
    if (m.type === 'error') c.error = String(m.error || '').slice(0, 300);
    for (const f of handlers[m.type] || []) { try { f(m); } catch (e) { c.error = String(e); } }
  };
  if (worker && typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./learn.worker.js', import.meta.url), { type: 'module' });
      c.kind = 'worker';
      w.addEventListener('message', (e) => deliver(e.data));
      w.addEventListener('error', (e) => { c.failed = true; c.error = String(e.message || e); });
      c.post = (m, transfer = []) => w.postMessage(m, transfer);
      c.terminate = () => { try { w.terminate(); } catch { /* gone */ } c.failed = true; };
      w.postMessage({ type: 'init', appVersion }, []);
      return c;
    } catch (e) { c.error = `worker: ${e}`; }
  }
  // in-process: the same loop, answered from a macrotask (never inside the caller's frame)
  const loop = createLearnLoop(new MemoryStore(), (m) => setTimeout(() => deliver(m), 0), { appVersion, storeKind: 'memory' });
  c.post = (m, transfer = []) => { const copy = transfer.length ? structuredClone(m, { transfer }) : m; setTimeout(() => loop(copy), 0); };
  c.ready = true;
  return c;
}
