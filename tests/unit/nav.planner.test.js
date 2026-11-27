import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid, NAV_INSIDE, NAV_OBST, NAV_WALK, NAV_WALL } from '../../src/world/NavGrid.js';
import { PathPlanner, PATH_FAILED, PATH_PENDING } from '../../src/world/PathPlanner.js';

const rect = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

/** A 10 × 8 m room with a long wall across it (gap at the top) and a sealed corner room. */
function maze(cap = 65536) {
  const g = new NavGrid(cap);
  g.reset(-0.5, -0.5, 110, 90);
  g.fillPolygon(rect(0, 0, 10, 8), 4, NAV_INSIDE, 0);
  g.fillBox(5, 3, 1, 0, 0.05, 3.2, 0.05, NAV_WALL); // x = 5 from z = -0.2 to 6.2: pass only above z = 6.2
  // A sealed 2.5 × 1.6 m room in the top-right corner (walls on its two open sides).
  g.fillBox(8.75, 6.4, 1, 0, 1.25, 0.05, 0.05, NAV_WALL);
  g.fillBox(7.5, 7.2, 1, 0, 0.05, 0.85, 0.05, NAV_WALL);
  g.computeClearance(NAV_WALL | NAV_OBST);
  g.finalize(0.28, 1, 1);
  return g;
}

function solve(p, id, sx, sz, gx, gz, quota = 1e9) {
  p.request(id, sx, sz, gx, gz);
  let steps = 0;
  const out = new Float32Array(256);
  let n;
  while ((n = p.result(id, out)) === PATH_PENDING) { p.step(quota); steps++; if (steps > 1e6) throw new Error('no progress'); }
  return { n, pts: Array.from(out.subarray(0, Math.max(0, n) * 2)), steps };
}

function pathLength(pts) {
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return L;
}

function assertValidPath(g, pts) {
  for (let i = 0; i < pts.length; i += 2) assert.ok(g.isWalkable(pts[i], pts[i + 1]), `point ${i / 2} walkable`);
  for (let i = 2; i < pts.length; i += 2) assert.ok(g.lineWalkable(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]), `segment ${i / 2} walkable`);
}

test('open field: a straight walkable line is a 2-point path with no search', () => {
  const g = maze();
  const p = new PathPlanner(g);
  const r = solve(p, 0, 1, 1, 4, 5);
  assert.equal(r.n, 2);
  assert.deepEqual(r.pts.map((v) => Math.round(v * 100) / 100), [1, 1, 4, 5]);
  assert.equal(p.stats.direct, 1);
  assert.equal(p.stats.lastExpansions, 0);
});

test('around a wall: valid, smoothed and near the shortest length', () => {
  const g = maze();
  const p = new PathPlanner(g);
  const r = solve(p, 3, 2, 1, 8, 1.8);
  assert.ok(r.n >= 3 && r.n <= 8, `points ${r.n}`);
  assertValidPath(g, r.pts);
  assert.deepEqual([r.pts[0], r.pts[1]].map((v) => Math.round(v * 100) / 100), [2, 1]);
  assert.deepEqual(r.pts.slice(-2).map((v) => Math.round(v * 100) / 100), [8, 1.8]);
  // It must cross x = 5 above the wall end (z > 6.2 + clearance).
  let crossed = false;
  for (let i = 2; i < r.pts.length; i += 2) {
    const [ax, az, bx, bz] = [r.pts[i - 2], r.pts[i - 1], r.pts[i], r.pts[i + 1]];
    if ((ax - 5) * (bx - 5) <= 0) { const t = (5 - ax) / (bx - ax); assert.ok(az + (bz - az) * t > 6.4); crossed = true; }
  }
  assert.ok(crossed);
  // Shortest: up and over the wall end, ≈ hypot(3, 5.5) + hypot(3, 4.7) ≈ 11.8 m.
  const L = pathLength(r.pts);
  assert.ok(L > 11.5 && L < 13.5, `length ${L}`);
});

test('no corner cutting between two diagonal blocked cells', () => {
  const g = new NavGrid(4096);
  g.reset(0, 0, 20, 20);
  for (let i = 0; i < g.count; i++) g.flags[i] = NAV_INSIDE | NAV_WALK;
  g.clr.fill(1);
  g.agentClear = 0.28;
  // A diagonal "wall" of single cells from (0,19) to (19,0): only diagonal gaps between them.
  for (let k = 0; k < 20; k++) g.flags[(19 - k) * 20 + k] = NAV_INSIDE;
  g.labelRegions();
  const a = g.index(0.15, 0.15), b = g.index(1.85, 1.85);
  assert.notEqual(g.region[a], g.region[b], 'a diagonal wall separates the regions');
  const p = new PathPlanner(g);
  const r = solve(p, 0, 0.15, 0.15, 1.85, 1.85);
  assert.equal(r.n, PATH_FAILED);
  assert.equal(p.stats.lastExpansions, 0, 'different regions fail without a search');
});

test('unreachable goal (sealed room) fails at once; a goal in a wall snaps to the nearest walkable cell', () => {
  const g = maze();
  const p = new PathPlanner(g);
  assert.ok(g.isWalkable(8.75, 7.2));
  assert.equal(solve(p, 1, 1, 1, 8.75, 7.2).n, PATH_FAILED);
  assert.equal(p.stats.lastExpansions, 0);
  assert.equal(p.result(9, new Float32Array(8)), PATH_FAILED, 'never requested');
  const r = solve(p, 2, 1, 1, 5.0, 7.0); // inside the clearance band of nothing: walkable
  assert.ok(r.n >= 2);
  const s = solve(p, 2, 2, 2, 5.0, 3.0); // goal inside the wall: snapped within 1 m
  assert.ok(s.n >= 2);
  const gx = s.pts[s.pts.length - 2], gz = s.pts[s.pts.length - 1];
  assert.ok(g.isWalkable(gx, gz) && Math.hypot(gx - 5, gz - 3) <= 1.0);
});

test('time slicing: the same path whether solved at once or 25 expansions per step', () => {
  const g = maze();
  const once = solve(new PathPlanner(g), 0, 2, 1, 8, 1.8);
  const p = new PathPlanner(g);
  p.request(0, 2, 1, 8, 1.8);
  const out = new Float32Array(256);
  let steps = 0, total = 0;
  while (p.result(0, out) === PATH_PENDING) {
    const n = p.step(25);
    assert.ok(n <= 25);
    total += n;
    steps++;
  }
  assert.ok(steps > 10, `steps ${steps}`);
  const n = p.result(0, out);
  assert.equal(n, once.n);
  assert.deepEqual(Array.from(out.subarray(0, n * 2)), once.pts);
  assert.equal(total, p.stats.lastExpansions);
});

test('requests queue FIFO; re-requesting an id restarts it; cancel drops it', () => {
  const g = maze();
  const p = new PathPlanner(g, { maxRequests: 4 });
  p.request(0, 2, 1, 8, 1.8);
  p.request(1, 2, 2, 8, 2.5);
  p.request(2, 1, 1, 3, 1); // direct
  p.request(3, 2, 3, 8, 3);
  assert.equal(p.pending(), 4);
  p.cancel(3);
  p.step(50);
  assert.equal(p.result(0, new Float32Array(64)), PATH_PENDING, 'first in line still searching');
  assert.equal(p.result(2, new Float32Array(64)), PATH_PENDING, 'later ones wait');
  p.request(0, 2, 1.2, 8, 1.8); // restart 0: goes to the back
  for (let i = 0; i < 1000 && p.pending(); i++) p.step(200);
  assert.equal(p.pending(), 0);
  for (const id of [0, 1, 2]) assert.ok(p.result(id, new Float32Array(64)) >= 2, `id ${id}`);
  assert.equal(p.result(3, new Float32Array(64)), PATH_FAILED, 'cancelled');
  const out = new Float32Array(64);
  p.result(0, out);
  assert.ok(Math.abs(out[1] - 1.2) < 1e-6, 'the restarted request used the new start');
  assert.equal(p.result(2, out), 2);
});

test('a rebuilt grid invalidates pending searches and results', () => {
  const g = maze();
  const p = new PathPlanner(g);
  p.request(0, 2, 1, 8, 1.8);
  p.request(1, 1, 1, 2, 2);
  p.step(10);
  g.reset(-0.5, -0.5, 110, 90);
  assert.equal(p.result(0, new Float32Array(8)), PATH_FAILED);
  assert.equal(p.result(1, new Float32Array(8)), PATH_FAILED);
  assert.equal(p.pending(), 0);
});

test('a short output buffer gets the first points; maxPoints truncation is counted', () => {
  const g = maze();
  const p = new PathPlanner(g, { maxPoints: 2 });
  const r = solve(p, 0, 2, 1, 8, 1.8);
  assert.equal(r.n, 2);
  assert.equal(p.stats.truncated, 1);
  const q = new PathPlanner(g);
  q.request(0, 2, 1, 8, 1.8);
  while (q.pending()) q.step(1000);
  const small = new Float32Array(4);
  assert.equal(q.result(0, small), 2);
});

test('the search loop does not allocate per expansion', () => {
  const g = maze();
  const p = new PathPlanner(g);
  const out = new Float32Array(128);
  const goals = [[8, 1.8], [8.5, 3], [9, 5.5], [7, 2.2]];
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      const q = goals[i & 3];
      p.request(i & 15, 2 + (i % 3) * 0.5, 1 + (i % 5) * 0.4, q[0], q[1]);
      while (p.pending()) p.step(400);
      p.result(i & 15, out);
    }
  };
  run(300);
  globalThis.gc?.();
  const e0 = p.stats.expansions;
  const before = process.memoryUsage().heapUsed;
  run(2000);
  const grew = process.memoryUsage().heapUsed - before;
  const expansions = p.stats.expansions - e0;
  assert.ok(expansions > 1e6, `expansions ${expansions}`);
  // A per-expansion object would cost ≥ 16 B each; V8 may box a few doubles per search in calls.
  assert.ok(grew / expansions < 0.5, `heap grew ${grew} B over ${expansions} expansions`);
  assert.ok(grew / 2000 < 1024, `heap grew ${grew / 2000} B per search`);
});

test('cancel and re-request without stepping never grows the queue', () => {
  const g = maze();
  const p = new PathPlanner(g, { maxRequests: 2 });
  for (let i = 0; i < 100; i++) { p.request(0, 2, 1, 8, 1.8); p.cancel(0); p.request(1, 1, 1, 3, 1); }
  p.request(0, 2, 1, 8, 1.8);
  assert.ok(p.qLen <= 2, `queue ${p.qLen}`);
  while (p.pending()) p.step(1000);
  assert.ok(p.result(0, new Float32Array(64)) >= 3);
  assert.equal(p.result(1, new Float32Array(64)), 2);
});

test('time budget: the clock is read every 64 expansions and a step stops once over maxMs; the path is unchanged', () => {
  const g = maze();
  const ref = new PathPlanner(g);
  const once = solve(ref, 0, 2, 1, 8, 1.8);
  const total = ref.stats.lastExpansions;
  assert.ok(total > 600, `the maze search needs ${total} expansions (more than one frame's quota)`);
  // Each clock read advances fake time by 0.1 ms.
  let now = 0, reads = 0;
  const p = new PathPlanner(g, { clock: () => { reads++; now += 0.1; return now; } });
  assert.equal(p.step(600, 0.35), 0);
  assert.equal(reads, 0, 'an idle planner never reads the clock');
  p.request(0, 2, 1, 8, 1.8);
  // t0, then reads after 64, 128, 192 (0.3 ms) and 256 (0.4 ms ≥ 0.35): stop at 256 of 600
  assert.equal(p.step(600, 0.35), 4 * 64);
  assert.equal(p.stats.timeouts, 1);
  assert.ok(Math.abs(p.stats.maxStepMs - 0.5) < 1e-9, `longest step ${p.stats.maxStepMs} ms (incl. the closing read)`);
  // without a budget the same planner runs the full quota
  const n0 = p.stats.expansions;
  assert.equal(p.step(100), 100);
  assert.equal(p.stats.expansions - n0, 100);
  // a very slow CPU: every chunk takes 1 ms, so each step does exactly one chunk (progress is never 0)
  const slow = new PathPlanner(g, { clock: () => { now += 1; return now; } });
  slow.request(0, 2, 1, 8, 1.8);
  const out = new Float32Array(256);
  let steps = 0;
  while (slow.result(0, out) === PATH_PENDING) {
    const n = slow.step(600, 0.35);
    assert.ok(n >= 1 && n <= 64, `${n} expansions in a 1 ms chunk`);
    if (++steps > 1e4) throw new Error('no progress');
  }
  assert.ok(steps >= Math.floor(total / 64), `${steps} steps of ≤ 64`);
  const n = slow.result(0, out);
  assert.equal(n, once.n);
  assert.deepEqual(Array.from(out.subarray(0, n * 2)), once.pts, 'time slicing never changes the path');
  // a frozen clock: only the expansion cap applies
  const frozen = new PathPlanner(g, { clock: () => 5 });
  frozen.request(0, 2, 1, 8, 1.8);
  assert.equal(frozen.step(300, 0.35), 300);
  assert.equal(frozen.stats.timeouts, 0);
});

test('a timed step with the real clock stays near its budget (warm code; most steps)', () => {
  const g = maze();
  const p = new PathPlanner(g);
  const goals = [[8, 1.8], [8.5, 3], [9, 5.5], [7, 2.2]];
  const run = (n, timed, times) => {
    for (let i = 0; i < n; i++) {
      const q = goals[i & 3];
      p.request(i & 15, 2 + (i % 3) * 0.5, 1 + (i % 5) * 0.4, q[0], q[1]);
      while (p.pending()) {
        const t0 = performance.now();
        if (timed) p.step(1e6, 0.35); else p.step(1e6);
        if (times) times.push(performance.now() - t0);
      }
    }
  };
  run(200, false, null); // optimised code first (a cold search is interpreted)
  run(20, true, null);
  const times = [];
  run(60, true, times);
  times.sort((a, b) => a - b);
  const p90 = times[Math.floor(times.length * 0.9)];
  assert.ok(times.length > 60, `${times.length} timed steps`);
  // a step overruns by at most one 64-expansion chunk; the slack is for a loaded parallel test run
  assert.ok(p90 < 2, `90 % of timed steps under ${p90.toFixed(3)} ms`);
  assert.ok(p.stats.timeouts > 0, 'the budget cut some steps');
});
