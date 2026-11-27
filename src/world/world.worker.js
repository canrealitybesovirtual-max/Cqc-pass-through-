// @ts-check
/**
 * The world worker (a module worker: `new Worker(new URL('./world.worker.js',
 * import.meta.url), { type: 'module' })`). Builds the world off the main
 * thread: layout, nav grid, Roam bake, spawns, the global mesh's prep, BVH,
 * occluder tiles and static colliders, and the session record's encoded mesh.
 * The protocol is in WorldBuild.js; the main side is WorldWorker.js.
 */
import { createJobLoop } from './WorldBuild.js';

const scope = /** @type {any} */ (globalThis);
const onMessage = createJobLoop((result, transfer) => scope.postMessage(result, transfer));
scope.addEventListener('message', (/** @type {MessageEvent} */ e) => onMessage(e.data));
