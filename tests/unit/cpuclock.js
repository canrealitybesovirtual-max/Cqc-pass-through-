// @ts-check
/**
 * Timing helpers for the performance bounds in the unit tests.
 *
 * `npm test` runs the test files in parallel, and other jobs share the machine, so the OS keeps a
 * test's thread off the CPU for milliseconds at a time. Wall-clock bounds then fail for reasons the
 * code cannot control (seen with three `npm test` runs at once: "mean slice 2.6–3.8 ms (budget
 * 1 ms)", "a spawn call took 6.5 ms"). The code under test keeps its own wall-clock deadlines (as on
 * the Quest); the bounds use:
 * - `cpuNow()`: this thread's CPU time (ms). The kernel updates it at scheduler ticks (steps of up to
 *   4 ms here), so it is only used over whole loops (a bake, N builds, M frames), never per call;
 * - `Timer`: a single call's wall time counts for a worst-case bound only when this thread was not
 *   switched out meanwhile (its context-switch counts in /proc/thread-self/status did not move). Both
 *   kinds matter: preemption (involuntary), and waiting for V8's parallel GC helpers when a scavenge
 *   lands in the call and the helpers are starved (voluntary: seen as 6–11 ms calls with 0.03–0.3 ms
 *   on the CPU and the heap 4 MB smaller). A call that really takes 6 ms still reads 6 ms whenever
 *   it runs undisturbed.
 * Fallbacks: the process's involuntary switches (no /proc), wall time (older Node).
 */
import { readFileSync } from 'node:fs';

const hasThreadCpu = typeof process !== 'undefined' && typeof process.threadCpuUsage === 'function';
const hasRusage = typeof process !== 'undefined' && typeof process.resourceUsage === 'function';
const STATUS = '/proc/thread-self/status';
const RE_SWITCHES = /^(?:non)?voluntary_ctxt_switches:\s+(\d+)/gm;
/** @returns {number} this thread's voluntary + involuntary context switches */
const threadSwitches = () => {
  let n = 0;
  for (const m of readFileSync(STATUS, 'utf8').matchAll(RE_SWITCHES)) n += +m[1];
  return n;
};
let hasProcStatus = false;
try { hasProcStatus = threadSwitches() >= 0 && /voluntary_ctxt_switches/.test(readFileSync(STATUS, 'utf8')); } catch { hasProcStatus = false; }

/** This thread's CPU time (ms); wall time without `process.threadCpuUsage`. */
export const cpuNow = hasThreadCpu
  ? () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; }
  : () => performance.now();

/** This thread's context switches so far (else the process's involuntary ones; 0 without either). */
export const switches = hasProcStatus ? threadSwitches
  : hasRusage ? () => process.resourceUsage().involuntaryContextSwitches : () => 0;

/** Worst-case wall time of single calls, over the calls that ran without being switched out. */
export class Timer {
  constructor() {
    this.worst = 0;
    this.samples = 0;
    this.skipped = 0;
    this._t = 0;
    this._s = 0;
  }
  start() { this._s = switches(); this._t = performance.now(); }
  /** @returns {number} this call's wall time (ms), counted or not */
  stop() {
    const dt = performance.now() - this._t;
    if (switches() !== this._s) { this.skipped++; return dt; }
    this.samples++;
    if (dt > this.worst) this.worst = dt;
    return dt;
  }
  /** For a diagnostic line. */
  toString() { return `worst ${this.worst.toFixed(3)} ms over ${this.samples} undisturbed calls (${this.skipped} switched out, not counted)`; }
}
