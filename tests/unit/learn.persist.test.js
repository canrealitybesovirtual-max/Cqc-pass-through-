// v0.5: the self-learning house across reloads: 100 simulated sessions of learning (load in the "worker",
// a walk with depth points and hit-test rays, analyses, a save) in one house. The stored size must reach a
// plateau under the caps, and the load + analysis time must stay flat as the evidence accumulates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearnCore, RAY_STRIDE } from '../../src/learn/LearnCore.js';
import { MemoryStore, MAX_HOUSE_CHUNKS } from '../../src/learn/HouseStore.js';
import { CELLS } from '../../src/learn/HouseGrid.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// a 3-room house, 12 × 8 m: Space Setup knows the first two rooms; the third (x 8..12) is beyond it
const wallP = (ax, az, bx, bz) => {
  const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
  return { label: 'wall', orientation: 'vertical', pose: [tx, 0, tz, 0, tz, 0, -tx, 0, 0, 1, 0, 0, (ax + bx) / 2, 0, (az + bz) / 2, 1], polygon: [[-L / 2, 0], [L / 2, 0], [L / 2, 2.4], [-L / 2, 2.4]] };
};
const snapshot = {
  planes: [
    { label: 'floor', orientation: 'horizontal', pose: I, polygon: [[0, 0], [8, 0], [8, 8], [0, 8]] },
    wallP(0, 0, 8, 0), wallP(0, 8, 8, 8), wallP(0, 0, 0, 8), wallP(8, 0, 8, 8), wallP(4, 0, 4, 3.5), wallP(4, 4.5, 4, 8),
  ],
  meshes: [],
};
// the real house: the wall at x = 8 has a doorway at z 3.5..4.5; the third room is closed at x = 12
const walls = [[0, 0, 12, 0], [0, 8, 12, 8], [0, 0, 0, 8], [12, 0, 12, 8], [4, 0, 4, 3.5], [4, 4.5, 4, 8], [8, 0, 8, 3.5], [8, 4.5, 8, 8]];
function cast(ox, oy, oz, dx, dy, dz) {
  let t = 8;
  if (dy < 0) t = Math.min(t, -oy / dy);
  if (dy > 0) t = Math.min(t, (2.5 - oy) / dy);
  for (const [ax, az, bx, bz] of walls) {
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const s = ((ax - ox) * ez - (az - oz) * ex) / den, u = ((ax - ox) * dz - (az - oz) * dx) / den;
    if (s > 0.05 && s < t && u >= 0 && u <= 1 && oy + dy * s < 2.4) t = s;
  }
  return t;
}

/** One session: a walk through all three rooms (jittered by the seed), rays from the head, some noise. */
function session(core, seed) {
  let r = seed * 9301 + 49297;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  const path = [[1, 1], [3, 2], [3.5, 4], [4.6, 4], [6, 5], [7.5, 4], [8.6, 4], [10, 2], [11, 6], [6, 6.5], [2, 6]];
  const buf = new Float32Array(4096 * RAY_STRIDE);
  let n = 0;
  const flush = () => { core.raysBatch(buf, n); n = 0; };
  for (let k = 0; k + 1 < path.length; k++) {
    const [ax, az] = path[k], [bx, bz] = path[k + 1], L = Math.hypot(bx - ax, bz - az), steps = Math.ceil(L / 0.2);
    for (let i = 0; i < steps; i++) {
      const x = ax + ((bx - ax) * i) / steps + (rnd() - 0.5) * 0.3, z = az + ((bz - az) * i) / steps + (rnd() - 0.5) * 0.3, y = 1.62;
      let b = n * RAY_STRIDE; buf[b] = 2; buf[b + 1] = x; buf[b + 2] = y; buf[b + 3] = z; n++;
      for (let a = 0; a < 40; a++) {
        const yaw = rnd() * Math.PI * 2, pitch = -1.1 + rnd() * 1.3, cp = Math.cos(pitch);
        const dx = Math.cos(yaw) * cp, dy = Math.sin(pitch), dz = Math.sin(yaw) * cp, t = cast(x, y, z, dx, dy, dz);
        if (t >= 8) continue;
        b = n * RAY_STRIDE;
        buf[b] = 1; buf[b + 1] = x; buf[b + 2] = y; buf[b + 3] = z;
        buf[b + 4] = x + dx * t; buf[b + 5] = y + dy * t + (rnd() - 0.5) * 0.008; buf[b + 6] = z + dz * t; buf[b + 7] = NaN;
        if (++n >= 4096) flush();
      }
    }
  }
  // noise: a few stray points far away (reflections, a pet), different every session
  for (let k = 0; k < 30; k++) {
    const b = n * RAY_STRIDE;
    buf[b] = 1; buf[b + 1] = 2; buf[b + 2] = 1.6; buf[b + 3] = 2;
    buf[b + 4] = 20 + rnd() * 200; buf[b + 5] = rnd() * 2; buf[b + 6] = -50 + rnd() * 100; buf[b + 7] = NaN;
    if (++n >= 4096) flush();
  }
  flush();
}

test('100 sessions of learning: the stored size plateaus under the caps; load and analysis stay flat; the house stays right', async (t) => {
  const store = new MemoryStore();
  const sizes = [], loadMs = [], anMs = [], doors = [];
  for (let s = 1; s <= 100; s++) {
    const core = new LearnCore({ store, maxChunks: 192 }); // a fresh worker per page load
    const t0 = performance.now();
    const o = await core.open({ houseId: 'house-test', sig: 'sig', snapshot, H: I });
    loadMs.push(performance.now() - t0);
    if (s > 1) assert.ok(o.loaded && o.quarantined === 0, `session ${s}: ${JSON.stringify({ ...o, result: undefined })}`);
    session(core, s);
    const t1 = performance.now();
    const r = core.analyze();
    anMs.push(performance.now() - t1);
    doors.push(r.openings.filter((x) => Math.abs(x.cx - 8) < 0.2 && x.cz > 3.3 && x.cz < 4.7).length);
    const sv = await core.save();
    assert.ok(sv.saved, JSON.stringify(sv));
    sizes.push(store.bytes('c:'));
  }
  const max = Math.max(...sizes);
  assert.ok(max <= MAX_HOUSE_CHUNKS * (218 + CELLS * 9), 'under the hard cap');
  assert.ok(sizes[99] <= sizes[19] * 1.25 + 4096, `plateau: session 20 ${sizes[19]} B, 50 ${sizes[49]} B, 100 ${sizes[99]} B`);
  assert.ok(sizes[99] < 400 * 1024, `${(sizes[99] / 1024).toFixed(0)} KB`);
  const avg = (a, i, j) => a.slice(i, j).reduce((x, y) => x + y, 0) / (j - i);
  const early = avg(loadMs, 5, 15) + avg(anMs, 5, 15), late = avg(loadMs, 90, 100) + avg(anMs, 90, 100);
  assert.ok(late <= early * 2 + 5, `load + analysis: sessions 6–15 ${early.toFixed(1)} ms, 91–100 ${late.toFixed(1)} ms`);
  t.diagnostic(`stored: s20 ${sizes[19]} B, s50 ${sizes[49]} B, s100 ${sizes[99]} B; load+analysis ${early.toFixed(1)} → ${late.toFixed(1)} ms`);
  // the doorway into the room Space Setup does not know is found every session from the 2nd on
  assert.ok(doors.slice(1).every((d) => d >= 1), `doorway found: ${doors.join('')}`);
  // the store holds one house record, its chunks and the index; nothing quarantined
  assert.ok(![...store.m.keys()].some((k) => k.startsWith('q:')));
});
