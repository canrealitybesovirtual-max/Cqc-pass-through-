import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeapWatch, loafEntry } from '../../src/debug/HeapWatch.js';

test('heap watch: drops of at least 1 MB are logged as GCs with their time; growth and the range are kept', () => {
  const vals = [50, 52, 54, 51.5, 51.9, 40, 41].map((m) => m * 1048576);
  let i = 0, t = 1000;
  const marks = [];
  const h = new HeapWatch({ read: () => vals[i++], now: () => (t += 1000), onDrop: (mb) => marks.push(mb) });
  for (let k = 0; k < vals.length; k++) h.sample();
  const r = h.report();
  assert.equal(r.available, true);
  assert.equal(r.gcDrops, 2);
  assert.deepEqual(r.log.map((e) => [e.t, e.fromMB, e.toMB]), [[3000, 54, 51.5], [5000, 51.9, 40]]);
  assert.deepEqual(marks, [2.5, 11.9]);
  assert.equal(r.minMB, 40);
  assert.equal(r.maxMB, 54);
  assert.equal(r.maxGrowthMBps, 2);
});

test('heap watch: no performance.memory (other browsers) records nothing', () => {
  const h = new HeapWatch({ read: () => undefined });
  h.sample();
  assert.deepEqual(h.report(), { available: false });
});

test('long animation frames: the longest scripts first, with where they came from', () => {
  const e = { startTime: 5200, duration: 83, blockingDuration: 33, renderStart: 5270, styleAndLayoutStart: 5278,
    scripts: [{ duration: 4, invoker: 'TimerHandler:setTimeout', sourceURL: 'http://x/src/app/Play.js', sourceFunctionName: 'writeFits' },
      { duration: 61, invoker: 'FrameRequestCallback', invokerType: 'user-callback', sourceURL: 'http://x/vendor/three/three.module.js', sourceFunctionName: 'onAnimationFrame', sourceCharPosition: 1234 }] };
  const r = loafEntry(e, 5000);
  assert.equal(r.t, 200);
  assert.equal(r.ms, 83);
  assert.equal(r.renderMs, 13);
  assert.equal(r.scripts[0].fn, 'onAnimationFrame');
  assert.equal(r.scripts[0].src, 'three/three.module.js');
  assert.equal(r.scripts[1].ms, 4);
});
