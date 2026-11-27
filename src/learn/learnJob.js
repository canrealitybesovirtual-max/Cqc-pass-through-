// @ts-check
/**
 * The learner worker's message loop (v0.5), shared by the module worker
 * (learn.worker.js) and the in-process fallback (LearnClient's inline mode).
 * One message at a time, in order (an async open / save finishes before the
 * next message is handled). Depth and ray buffers are sent back to the main
 * thread's pools with every reply that used them.
 *
 * In:  open { houseId, sig, snapshot, H } · frame { H, snapshot? } · depth { pix, pose } · rays { buf, n }
 *      analyze · save · forget · stats
 * Out: opened · result · saved · forgot · buf { pix, pose } · rbuf { buf } · stats · error
 */
import { LearnCore } from './LearnCore.js';

/**
 * @param {import('./HouseStore.js').KV} store
 * @param {(msg: any, transfer: ArrayBuffer[]) => void} reply
 * @param {{ appVersion?: string, storeKind?: string }} [o]
 */
export function createLearnLoop(store, reply, { appVersion = '', storeKind = 'memory' } = {}) {
  const core = new LearnCore({ store, appVersion });
  /** @type {any[]} */ const queue = [];
  let busy = false;
  const handle = async (/** @type {any} */ m) => {
    const t0 = performance.now();
    switch (m.type) {
      case 'open': {
        const r = await core.open({ houseId: m.houseId, sig: m.sig, snapshot: m.snapshot, H: m.H });
        reply({ type: 'opened', id: m.id, ...r, storeKind, ms: performance.now() - t0, stats: core.stats() }, []);
        break;
      }
      case 'frame': core.setFrame(m.H, m.snapshot || null); break;
      case 'depth': {
        const pix = new Uint8Array(m.pix), pose = new Float64Array(m.pose);
        let n = 0;
        try { n = core.depth(pix, pose); } catch (e) { reply({ type: 'error', where: 'depth', error: String(e) }, []); }
        reply({ type: 'buf', pix: m.pix, pose: m.pose, n, ms: performance.now() - t0 }, [m.pix, m.pose]);
        break;
      }
      case 'rays': {
        try { core.raysBatch(new Float32Array(m.buf), m.n | 0); } catch (e) { reply({ type: 'error', where: 'rays', error: String(e) }, []); }
        reply({ type: 'rbuf', buf: m.buf, ms: performance.now() - t0 }, [m.buf]);
        break;
      }
      case 'analyze': {
        const result = core.analyze();
        reply({ type: 'result', id: m.id, result, stats: core.stats(), ms: performance.now() - t0 }, []);
        break;
      }
      case 'save': {
        const r = await core.save();
        reply({ type: 'saved', id: m.id, ...r, stats: core.stats() }, []);
        break;
      }
      case 'forget': await core.forget(); reply({ type: 'forgot', id: m.id }, []); break;
      case 'stats': reply({ type: 'stats', id: m.id, stats: core.stats() }, []); break;
      default: break;
    }
  };
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const m = queue.shift();
      try { await handle(m); } catch (e) { reply({ type: 'error', where: m && m.type, id: m && m.id, error: String(e && /** @type {any} */ (e).stack || e).slice(0, 400) }, []); }
    }
    busy = false;
  };
  return (/** @type {any} */ m) => { queue.push(m); pump(); };
}
