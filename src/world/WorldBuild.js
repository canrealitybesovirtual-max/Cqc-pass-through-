// @ts-check
/**
 * The world worker's job (pure: no three.js, no DOM; the worker shim
 * `world.worker.js` and the in-process fallback both run it).
 *
 * Messages in (structured clone; typed arrays transferred):
 * ```
 * { type: 'init', cfg }                       → { type: 'ready', ok, warmMs, error? }
 * { type: 'build', seq, cfg, snapshot, mesh, start, opts, encode }
 *     snapshot: the SpaceSnapshot JSON (no `raw`; `globalMesh.data` only when there are no triangles);
 *     mesh: null | { label, pose: number[16], lastChangedTime, vertices: Float32Array, indices: Uint32Array } (lent: sent back);
 *     opts: { doors, roam, mesh }; encode: also make the session record's copy of the mesh
 *                                             → { type: 'built', seq, ok, error?, state, mesh, record, ms, buildMs, timings }
 * ```
 * The worker's core is built with the main world's capacities (`cfg`), the
 * Roam bake is finished here (the main thread never slices it after a worker
 * build), and `state` is `exportCore(core)` (WorldState.js). Nothing here
 * keeps references to what it sends.
 */

import { WorldCore } from './WorldCore.js';
import { attachRaw, hydrateSnapshot, normalizeSnapshot } from './Snapshot.js';
import { encodeMeshRecord } from './MeshCodec.js';
import { boxOccluderBuffers, overlayBuffers } from './Occluder.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {any} cfg WorldCore constructor options (`world.config`)
 */
export function createJobCore(cfg) {
  return new WorldCore({ ...(cfg || {}), syncMeshMaxTris: Infinity }); // the worker is where big meshes go
}

/**
 * Warm the worker's JIT (its own V8 isolate) with every build path, at load.
 * @param {WorldCore} core
 */
export function warmJob(core) {
  const t0 = now();
  core.warmUp();
  return { warmMs: Math.round((now() - t0) * 10) / 10 };
}

/**
 * Run one build message.
 * @param {WorldCore} core
 * @param {any} msg
 * @returns {Promise<{ result: any, transfer: ArrayBuffer[] }>}
 */
export async function runBuildJob(core, msg) {
  const t0 = now();
  const timings = { decode: 0, build: 0, bake: 0, export: 0, encode: 0 };
  const lent = msg.mesh && msg.mesh.vertices ? msg.mesh : null;
  /** @type {ArrayBuffer[]} */ const transfer = [];
  try {
    let snap = msg.snapshot ? normalizeSnapshot(msg.snapshot) : null;
    let t = now();
    if (snap && lent) {
      const pose = new Float64Array(16);
      for (let i = 0; i < 16; i++) pose[i] = lent.pose && lent.pose.length === 16 ? lent.pose[i] : (i % 5 === 0 ? 1 : 0);
      attachRaw(snap, { token: -1, global: 0, meshes: [{ label: lent.label || 'global mesh', pose, lastChangedTime: lent.lastChangedTime || 0,
        data: { vertices: lent.vertices, indices: lent.indices } }] });
    } else if (snap && msg.opts && msg.opts.mesh !== false && snap.globalMesh && typeof snap.globalMesh.data === 'string') {
      snap = await hydrateSnapshot(snap); // a replayed record: decode it here, not on the main thread
    }
    timings.decode = now() - t;
    t = now();
    core.built = false;
    core.build(snap, msg.start || { x: 0, z: 0 }, msg.opts || {});
    timings.build = now() - t;
    t = now();
    core.finishBake();
    timings.bake = now() - t;
    let record = null;
    if (msg.encode && core.lastPrepped) {
      t = now();
      record = { space: 'reference', ...(await encodeMeshRecord(core.lastPrepped.raw)) };
      timings.encode = now() - t;
    }
    t = now();
    const state = core.exportState();
    // the World's own buffers, when the main side has them (cfg.occluder: its capacities): memcpy there
    const oc = msg.cfg && msg.cfg.occluder;
    if (oc && core.layout) {
      const all = boxOccluderBuffers(core.layout, oc.maxBoxes, false);
      const drop = core.coveredFurniture > 0 ? boxOccluderBuffers(core.layout, oc.maxBoxes, true) : null;
      const overlay = overlayBuffers(core.layout, oc.maxBoxes, oc.maxOverlayVerts);
      state.adopt.occ = { all, drop, overlay };
      for (const x of [all, drop]) if (x) state.transfer.push(/** @type {ArrayBuffer} */ (x.pos.buffer), /** @type {ArrayBuffer} */ (x.idx.buffer), /** @type {ArrayBuffer} */ (x.bounds.buffer));
      state.transfer.push(/** @type {ArrayBuffer} */ (overlay.pos.buffer), /** @type {ArrayBuffer} */ (overlay.col.buffer));
    }
    timings.export = now() - t;
    for (const b of state.transfer) transfer.push(b);
    const { transfer: _x, ...plain } = state;
    if (lent) transfer.push(lent.vertices.buffer, lent.indices.buffer);
    core.lastPrepped = null;
    return {
      result: { type: 'built', seq: msg.seq, ok: true, state: plain, mesh: lent ? { vertices: lent.vertices, indices: lent.indices } : null,
        record, ms: now() - t0, buildMs: timings.build + timings.bake, timings: roundAll(timings) },
      transfer,
    };
  } catch (e) {
    if (lent) transfer.push(lent.vertices.buffer, lent.indices.buffer);
    return {
      result: { type: 'built', seq: msg.seq, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack || ''}`.slice(0, 2000) : String(e),
        mesh: lent ? { vertices: lent.vertices, indices: lent.indices } : null, ms: now() - t0 },
      transfer,
    };
  }
}

/** @param {Record<string, number>} t */
function roundAll(t) {
  /** @type {Record<string, number>} */ const o = {};
  for (const k in t) o[k] = Math.round(t[k] * 10) / 10;
  return o;
}

/**
 * A message loop for one worker (or the in-process builder): messages run one
 * at a time, in order.
 * @param {(result: any, transfer: ArrayBuffer[]) => void} post
 */
export function createJobLoop(post) {
  /** @type {WorldCore|null} */ let core = null;
  let chain = Promise.resolve();
  return (/** @type {any} */ msg) => {
    chain = chain.then(async () => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init') {
        try {
          core = createJobCore(msg.cfg);
          const w = warmJob(core);
          post({ type: 'ready', ok: true, warmMs: w.warmMs }, []);
        } catch (e) {
          post({ type: 'ready', ok: false, error: e instanceof Error ? e.message : String(e) }, []);
        }
        return;
      }
      if (msg.type === 'build') {
        if (!core) core = createJobCore(msg.cfg);
        const { result, transfer } = await runBuildJob(core, msg);
        post(result, transfer);
      }
    });
  };
}
