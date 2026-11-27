// @ts-check
/**
 * IndexedDB behind the learner's KV interface (v0.5; used inside the learner
 * worker only: the main thread never touches storage). One database
 * `cqcpt-learn`, one object store `kv`; values are ArrayBuffers (chunks) or
 * small objects (house records, the index). The quota comes from
 * `navigator.storage.estimate()` where the worker has it.
 */
const DB = 'cqcpt-learn', STORE = 'kv', VERSION = 1;

/** @returns {Promise<import('./HouseStore.js').KV|null>} null when IndexedDB is not there or cannot open */
export async function openIDBStore() {
  const idb = /** @type {any} */ (globalThis).indexedDB;
  if (!idb) return null;
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const r = idb.open(DB, VERSION);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('indexedDB blocked'));
  });
  const run = (/** @type {IDBTransactionMode} */ mode, /** @type {(s: IDBObjectStore) => IDBRequest} */ f) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), req = f(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return {
    async get(k) { const v = await run('readonly', (s) => s.get(k)); return v instanceof ArrayBuffer ? new Uint8Array(v) : v; },
    async put(k, v) { await run('readwrite', (s) => s.put(v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v, k)); },
    async del(k) { await run('readwrite', (s) => s.delete(k)); },
    async estimate() {
      const st = /** @type {any} */ (globalThis).navigator && /** @type {any} */ (globalThis).navigator.storage;
      return st && typeof st.estimate === 'function' ? st.estimate() : null;
    },
  };
}
