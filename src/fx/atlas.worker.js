// @ts-check
/**
 * Draws the decal atlas off the main thread at load (decalAtlas.js; about
 * 60–150 ms of maths on desktop) and transfers the pixels back.
 */
import { makeDecalAtlas } from './decalAtlas.js';

self.onmessage = () => {
  const a = makeDecalAtlas();
  /** @type {any} */ (self).postMessage({ width: a.width, height: a.height, cell: a.cell, data: a.data }, [a.data.buffer]);
};
