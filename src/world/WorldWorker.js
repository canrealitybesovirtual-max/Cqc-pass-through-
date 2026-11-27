// @ts-check
/**
 * The main thread's side of the world worker (pure: no three.js, no DOM
 * beyond `Worker`, which it only uses when the page has it).
 *
 * ```js
 * const builder = createWorldBuilder(world.config);   // at load (spawns + warms the worker)
 * world.attachBuilder(builder);
 * // behind the panel: await world.buildAsync(snapshot, start, { roam })   (world.update() applies it)
 * ```
 * `createWorldBuilder` uses a module worker when the page can make one, else
 * the same job in-process (`InlineBuilder`: no thread, but the same protocol,
 * and the same transfers through structuredClone), so the world never needs
 * to know which. A worker that fails (an error event, a failed init) sets
 * `failed`: the world then builds synchronously and notes why.
 */
import { createJobLoop } from './WorldBuild.js';

/**
 * @typedef {{ post(msg: any, transfer: ArrayBuffer[]): void, onResult: ((r: any) => void)|null, failed: boolean,
 *   ready: boolean, warmMs: number, error: string, kind: string, terminate(): void }} WorldBuilder
 */

export class WorkerBuilder {
  /**
   * @param {any} worker a Worker (or anything with postMessage, addEventListener / onmessage, terminate)
   * @param {any} cfg the world's config (capacities)
   */
  constructor(worker, cfg) {
    this.worker = worker;
    this.kind = 'worker';
    /** @type {((r: any) => void)|null} */ this.onResult = null;
    this.failed = false;
    this.ready = false;
    this.warmMs = 0;
    this.error = '';
    this.messages = 0;
    const onMsg = (/** @type {any} */ e) => this.receive(e && 'data' in e ? e.data : e);
    const onErr = (/** @type {any} */ e) => { this.failed = true; this.error = String((e && (e.message || e.error)) || e); };
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.addEventListener('messageerror', onErr);
    } else {
      worker.onmessage = onMsg;
      worker.onerror = onErr;
    }
    worker.postMessage({ type: 'init', cfg });
  }

  /** @param {any} r */
  receive(r) {
    this.messages++;
    if (!r || typeof r !== 'object') return;
    if (r.type === 'ready') {
      this.ready = !!r.ok;
      this.warmMs = r.warmMs || 0;
      if (!r.ok) { this.failed = true; this.error = r.error || 'init failed'; }
      return;
    }
    if (r.type === 'built' && this.onResult) this.onResult(r);
  }

  /** @param {any} msg @param {ArrayBuffer[]} transfer */
  post(msg, transfer) {
    this.worker.postMessage(msg, transfer);
  }

  terminate() {
    try { this.worker.terminate(); } catch { /* gone */ }
    this.failed = true;
  }
}

/**
 * The job in-process, answered from a macrotask (never inside the caller's
 * frame). Messages go through structuredClone with their transfer list, so
 * lent arrays are detached exactly as with a worker.
 */
export class InlineBuilder {
  /** @param {any} cfg */
  constructor(cfg) {
    this.kind = 'inline';
    /** @type {((r: any) => void)|null} */ this.onResult = null;
    this.failed = false;
    this.ready = false;
    this.warmMs = 0;
    this.error = '';
    const clone = typeof structuredClone === 'function' ? structuredClone : (/** @type {any} */ v) => v;
    this.loop = createJobLoop((result, transfer) => {
      const r = clone(result, { transfer });
      setTimeout(() => {
        if (r.type === 'ready') { this.ready = !!r.ok; this.warmMs = r.warmMs || 0; if (!r.ok) { this.failed = true; this.error = r.error; } return; }
        if (this.onResult) this.onResult(r);
      }, 0);
    });
    this.loop({ type: 'init', cfg });
  }

  /** @param {any} msg @param {ArrayBuffer[]} transfer */
  post(msg, transfer) {
    const clone = typeof structuredClone === 'function' ? structuredClone : (/** @type {any} */ v) => v;
    const m = clone(msg, { transfer });
    setTimeout(() => this.loop(m), 0);
  }

  terminate() { this.failed = true; }
}

/**
 * The best builder this page can have: a module worker, else in-process.
 * @param {any} cfg `world.config`
 * @param {{ url?: string|URL, inline?: boolean, worker?: any }} [o] url: the worker script (default:
 *   ./world.worker.js next to this module); worker: an existing worker-like object (tests)
 * @returns {WorldBuilder}
 */
export function createWorldBuilder(cfg, o = {}) {
  if (o.worker) return new WorkerBuilder(o.worker, cfg);
  if (!o.inline && typeof Worker === 'function') {
    try {
      const url = o.url || new URL('./world.worker.js', import.meta.url);
      return new WorkerBuilder(new Worker(url, { type: 'module', name: 'world' }), cfg);
    } catch { /* module workers unavailable: in-process */ }
  }
  return new InlineBuilder(cfg);
}
