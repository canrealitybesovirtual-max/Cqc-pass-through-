// @ts-check
/**
 * The learner worker (v0.5; a module worker). Loads and saves the learned
 * house in IndexedDB, fuses every depth readback and ray batch, analyses on
 * request. Protocol: learnJob.js; the main side: LearnClient.js.
 */
import { createLearnLoop } from './learnJob.js';
import { MemoryStore } from './HouseStore.js';
import { openIDBStore } from './idbStore.js';

const scope = /** @type {any} */ (globalThis);
/** @type {any[]} */ const early = [];
let onMessage = (/** @type {any} */ m) => { early.push(m); };
scope.addEventListener('message', (/** @type {MessageEvent} */ e) => onMessage(e.data));
(async () => {
  let store = null, kind = 'indexeddb', why = '';
  try { store = await openIDBStore(); } catch (e) { why = String(e); }
  if (!store) { store = new MemoryStore(); kind = 'memory'; }
  const init = early.find((m) => m && m.type === 'init');
  onMessage = createLearnLoop(store, (msg, transfer) => scope.postMessage(msg, transfer), { appVersion: init ? init.appVersion : '', storeKind: kind });
  scope.postMessage({ type: 'ready', storeKind: kind, why }, []);
  for (const m of early) if (m.type !== 'init') onMessage(m);
  early.length = 0;
})();
