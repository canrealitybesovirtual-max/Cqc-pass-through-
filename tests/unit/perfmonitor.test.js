import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerfMonitor } from '../../src/debug/PerfMonitor.js';

/** Drive the monitor with a fake clock: frames at `intervals`, each taking `cpu` ms. */
function drive(pm, clock, intervals, cpu = 2, sysSplit = [0.5, 1.5]) {
  let t = clock.t;
  for (const iv of intervals) {
    t += iv;
    clock.now = t;
    pm.beginFrame(t);
    pm.begin(0); clock.now += sysSplit[0]; pm.end(0);
    pm.begin(1); clock.now += sysSplit[1]; pm.end(1);
    clock.now = t + cpu;
    pm.endFrame(10);
  }
  clock.t = t;
}

function make() {
  const clock = { t: 1000, now: 1000 };
  const pm = new PerfMonitor({ systems: ['a', 'render'], now: () => clock.now, capacity: 64, hitchCapacity: 4 });
  pm.setRate(72);
  return { pm, clock };
}

test('first interval after start is skipped; ring fills', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9, 13.9]);
  assert.equal(pm.count, 2);
  const r = pm.recent(10);
  assert.equal(r.frames, 2);
  assert.ok(Math.abs(r.intervalAvg - 13.9) < 0.01);
});

test('missed frames go to the hitch log with marker and per-system split', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9]);
  pm.mark('spawn');
  drive(pm, clock, [30, 13.9]);
  const h = pm.exportHitches();
  assert.equal(h.total, 1);
  assert.equal(h.entries[0].marker, 'spawn');
  assert.equal(h.entries[0].interval, 30);
  assert.equal(h.entries[0].a, 0.5);
  assert.equal(h.entries[0].render, 1.5);
});

test('hitch log keeps the first N and counts the rest', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 40, 40, 40, 40, 40, 40]);
  const h = pm.exportHitches();
  assert.equal(h.total, 6);
  assert.equal(h.kept, 4);
});

test('a clean 60 s run at 72 Hz passes the Phase 1 gate', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9]);
  let result = null;
  pm.onRunComplete = (r) => { result = r; };
  pm.startRun(60000, 'test');
  drive(pm, clock, new Array(4400).fill(1000 / 72), 2);
  assert.ok(result, 'run finished');
  assert.equal(result.missed, 0);
  assert.equal(result.pass, true);
  assert.equal(result.cpu.p99, 2.5); // upper edge of the 2.0–2.5 ms bin
  assert.ok(result.cpuP99PctOfPeriod < 60);
  assert.equal(pm.running, false);
});

test('two consecutive misses fail the run even under 0.5 %', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9]);
  let result = null;
  pm.onRunComplete = (r) => { result = r; };
  pm.startRun(60000, 'test');
  const iv = new Array(4400).fill(1000 / 72);
  iv[100] = 30; iv[101] = 30;
  drive(pm, clock, iv, 2);
  assert.equal(result.missed, 2);
  assert.equal(result.maxConsecutiveMissed, 2);
  assert.ok(result.missedPct < 0.5);
  assert.equal(result.pass, false);
});

test('rate change cancels a run and skips the next interval', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9]);
  pm.startRun(60000, 'x');
  pm.setRate(90);
  assert.equal(pm.running, false);
  assert.match(pm.runLabel, /cancelled: rate changed/);
  const before = pm.count;
  drive(pm, clock, [11.1]);
  assert.equal(pm.count, before);
  assert.ok(Math.abs(pm.periodMs - 11.111) < 0.01);
});

test('hot path does not grow the heap (no per-frame allocation)', () => {
  const { pm, clock } = make();
  const frames = new Array(20000).fill(13.9);
  drive(pm, clock, frames.slice(0, 2000));
  // `drive` itself allocates a little; 20k frames must stay far below 1 KB per frame. The least
  // growth over 3 windows: one window can catch GC or JIT timing under parallel test load.
  let grew = Infinity;
  for (let k = 0; k < 3 && grew >= 2_000_000; k++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    drive(pm, clock, frames);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 2_000_000, `heap grew ${grew} bytes`);
});

test('cancelled runs are reported once', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9]);
  const got = [];
  pm.onRunCancelled = (r) => got.push(r);
  pm.startRun(60000, 'x');
  drive(pm, clock, new Array(72).fill(13.9));
  pm.cancelRun('hidden');
  pm.cancelRun('again');
  assert.equal(got.length, 1);
  assert.equal(got[0].cancelled, 'hidden');
  assert.equal(got[0].elapsedS, 1);
});

test('measured rate replaces the guess and follows a switch', () => {
  const { pm, clock } = make(); // guess 72 Hz
  pm.setRates([72, 80, 90, 120]);
  const changes = [];
  pm.onRateChange = (hz) => changes.push(hz);
  drive(pm, clock, new Array(40).fill(1000 / 90));
  assert.equal(pm.hz, 90, 'first window adopts 90 Hz');
  drive(pm, clock, new Array(36).fill(1000 / 72)); // one window at 72: not yet
  assert.equal(pm.hz, 90);
  drive(pm, clock, new Array(40).fill(1000 / 72));
  assert.equal(pm.hz, 72, 'two windows confirm 72 Hz');
  assert.deepEqual(changes, [90, 72]);
});

test('noisy intervals that match no offered rate change nothing', () => {
  const { pm, clock } = make();
  pm.setRates([72, 90]);
  drive(pm, clock, new Array(100).fill(21));
  assert.equal(pm.hz, 72);
  assert.equal(pm.measured, false);
});

test('a measured 13.9 ms frame at 72 Hz is not a miss, but at a wrong 120 Hz guess it would be', () => {
  const { pm, clock } = make();
  pm.setRates([72, 80, 90, 120]);
  pm.setRate(120); // wrong guess, like a lagging frameRate attribute
  drive(pm, clock, new Array(80).fill(1000 / 72));
  assert.equal(pm.hz, 72);
  const before = pm.hitchCount;
  drive(pm, clock, new Array(100).fill(1000 / 72));
  assert.equal(pm.hitchCount, before, 'no false misses once measured');
});

test('systemAverages: per-system mean and max, and draw calls, over the last frames', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9, 13.9, 13.9], 2, [0.5, 1.5]);
  drive(pm, clock, [13.9], 4, [1.0, 2.5]);
  const s = pm.systemAverages(4);
  assert.equal(s.a, 0.63); // (0.5 · 3 + 1.0) / 4
  assert.equal(s.aMax, 1);
  assert.equal(s.render, 1.75);
  assert.equal(s.renderMax, 2.5);
  assert.equal(s.drawCalls, 10);
  assert.equal(s.drawCallsMax, 10);
  assert.deepEqual(new PerfMonitor({ systems: ['x'] }).systemAverages(10), { x: 0, xMax: 0, drawCalls: 0, drawCallsMax: 0 });
});

test('v0.5 hitch entries: previous frame (CPU, interval, split), callback lateness, next interval, marker age', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9], 3, [0.7, 2.1]);
  pm.mark('build');
  // a frame whose callback started 4 ms after its XR time, then a long interval, then a short one
  let t = clock.t + 200; // 200 ms later: the marker is still within its 0.5 s
  clock.now = t + 4;
  pm.beginFrame(t);
  pm.begin(0); clock.now += 0.5; pm.end(0);
  pm.begin(1); clock.now += 1.5; pm.end(1);
  pm.endFrame(10);
  clock.t = t;
  drive(pm, clock, [9]);
  const e = pm.exportHitches().entries[0];
  assert.equal(e.interval, 200);
  assert.equal(e.late, 4);
  assert.equal(e.prevCpu, 3);
  assert.equal(e.prevInterval, 13.9);
  assert.deepEqual(e.prev, { a: 0.7, render: 2.1 });
  assert.equal(e.next, 9);
  assert.equal(e.marker, 'build');
  assert.ok(e.markerAgeMs >= 195 && e.markerAgeMs <= 205, String(e.markerAgeMs));
  // a marker older than 0.5 s names nothing
  drive(pm, clock, new Array(40).fill(13.9));
  drive(pm, clock, [40]);
  const e2 = pm.exportHitches().entries[1];
  assert.equal(e2.marker, '-');
  assert.equal(e2.markerAgeMs, null);
});

test('v0.5: the interval skipped after a resume is logged as a gap; the whole-session histogram and per-system peaks', () => {
  const { pm, clock } = make();
  drive(pm, clock, [13.9, 13.9, 13.9]);
  pm.mark('resume');
  pm.resetTiming();
  drive(pm, clock, [13.9]); // lastT reset: no interval
  pm.resetTiming();
  pm.lastT = clock.t; // a resume where the timestamps continue: the skipped interval is known
  drive(pm, clock, [850]);
  const h = pm.exportHitches();
  assert.equal(h.total, 0, 'a gap is not a hitch');
  assert.ok(h.gaps.total >= 1 && h.gaps.entries.some((g) => g.ms === 850 && g.marker === 'resume'), JSON.stringify(h.gaps));
  drive(pm, clock, [13.9, 13.9, 30], 2, [0.5, 1.5]);
  const r = pm.sessionReport();
  assert.equal(r.frames, 2 + 3);
  assert.equal(r.missed, 1);
  assert.deepEqual(r.systems.a, { avg: 0.5, peak: 0.5 });
  assert.ok(r.interval.hist.some(([ms, n]) => ms === 30.5 && n === 1), JSON.stringify(r.interval.hist));
  assert.ok(r.interval.p50 === 14, String(r.interval.p50));
});

test('v0.5: the session counters and the hitch details allocate nothing per frame', () => {
  const { pm, clock } = make();
  const frames = new Array(20000).fill(13.9);
  for (let i = 0; i < frames.length; i += 50) frames[i] = 40; // a hitch every 50 frames (the log fills, then counts)
  drive(pm, clock, frames.slice(0, 2000));
  let grew = Infinity;
  for (let k = 0; k < 3 && grew >= 2_000_000; k++) {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    pm.mark('x');
    drive(pm, clock, frames);
    grew = Math.min(grew, process.memoryUsage().heapUsed - before);
  }
  assert.ok(grew < 2_000_000, `heap grew ${grew} bytes`);
});
