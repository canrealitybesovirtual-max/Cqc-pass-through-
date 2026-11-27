// A Node worker_threads stand-in for src/world/world.worker.js (a helper, not a test file): the
// same job loop (src/world/WorldBuild.js), with `parentPort` where the browser has `self`.
import { parentPort } from 'node:worker_threads';
import { createJobLoop } from '../../src/world/WorldBuild.js';

const loop = createJobLoop((result, transfer) => parentPort.postMessage(result, transfer));
parentPort.on('message', (m) => loop(m));
