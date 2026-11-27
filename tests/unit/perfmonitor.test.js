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
  drive(pm, clock, new Array(2000).fill(13.9));
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  drive(pm, clock, new Array(20000).fill(13.9));
  const grew = process.memoryUsage().heapUsed - before;
  // `drive` itself allocates a little; 20k frames must stay far below 1 KB per frame.
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
