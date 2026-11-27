// v0.5: the walkthrough scan on the user's real house (the v0.4 headset session's Space Setup snapshot,
// tests/fixtures/house-v04-device.json). Space Setup's two room scans close the hall off in both directions
// (DEVICE_LOG v0.4: "the living room scan's wall at the hall's north end, and the bedroom scan's walls on the
// hall's east and south sides, stand where you walked"; play.roam.roomsVisited [2, 4, 5]). A synthetic depth walk
// along that path (bedroom → hall → living room) through a "real" house that has doorways where the user walked
// is fused, analysed and merged into the snapshot; the world built from it must let enemies walk bedroom → hall →
// living room, keep Space Setup's other walls, and keep the unscanned space behind the real walls hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateSnapshot, normalizeSnapshot } from '../../src/world/Snapshot.js';
import { WorldCore } from '../../src/world/WorldCore.js';
import { NAV_HIDDEN } from '../../src/world/NavGrid.js';
import { houseFrameOf, apply } from '../../src/learn/houseFrame.js';
import { HouseGrid } from '../../src/learn/HouseGrid.js';
import { Fuser } from '../../src/learn/fuse.js';
import { analyzeHouse, ssGeometry } from '../../src/learn/analyze.js';
import { applyScan, scanOverlay } from '../../src/learn/overlay.js';

const START = { x: -0.2256, z: 0.0093 };
const HALL = { x: 1.3, z: 1.7 };
const LIVING = { x: 3.44, z: 7.96 };
/** The walk (session coordinates, the recorded session's space): bedroom → through the hall's south wall → hall → its north wall → living room. */
const PATH = [[-0.23, 0.01], [0.6, -0.5], [1.15, -0.4], [1.2, 0.8], [1.3, 2.0], [1.25, 2.9], [1.3, 3.6], [2.2, 3.7], [3.0, 5.6], [3.44, 7.96]];

const snap = await hydrateSnapshot(normalizeSnapshot(JSON.parse(readFileSync(new URL('../fixtures/house-v04-device.json', import.meta.url), 'utf8'))));
const build = (s) => { const w = new WorldCore({ roam: true }); w.build(s, START, { roam: true, mesh: false }); w.finishBake(); return w; };
const region = (w, p) => { const i = w.nav.index(p.x, p.z); return i >= 0 ? w.nav.region[i] : -1; };

/** Points along the path every `step` m. */
function walkPoints(step) {
  const out = [];
  for (let k = 0; k + 1 < PATH.length; k++) {
    const [ax, az] = PATH[k], [bx, bz] = PATH[k + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i < n; i++) out.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  }
  out.push(PATH[PATH.length - 1]);
  return out;
}

/**
 * The "real" house for the synthetic depth: Space Setup's wall planes, with a 0.9 m doorway wherever the walk
 * crosses one (the user walked through: the real house has an opening there), the floor under the head and a
 * ceiling 2.5 m up. Returns a raycaster (session coordinates).
 */
function realHouse(w0) {
  const walls = w0.layout.walls.filter((w) => !w.inferred).map((w) => ({ ...w, gaps: w.openings.map((o) => [o.u0, o.u1]) }));
  const pts = walkPoints(0.05);
  for (const w of walls) {
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
      const da = (ax - w.ax) * w.nx + (az - w.az) * w.nz, db = (bx - w.ax) * w.nx + (bz - w.az) * w.nz;
      if ((da > 0) === (db > 0)) continue;
      const t = da / (da - db), x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const u = (x - w.ax) * w.tx + (z - w.az) * w.tz;
      if (u < -0.05 || u > w.len + 0.05) continue;
      w.gaps.push([u - 0.45, u + 0.45]);
    }
  }
  return (ox, oy, oz, dx, dy, dz, floorY) => {
    let best = 6;
    if (dy < -1e-6) best = Math.min(best, (floorY - oy) / dy);
    if (dy > 1e-6) best = Math.min(best, (floorY + 2.5 - oy) / dy);
    for (const w of walls) {
      const den = dx * w.nx + dz * w.nz;
      if (Math.abs(den) < 1e-6) continue;
      const t = ((w.ax - ox) * w.nx + (w.az - oz) * w.nz) / den;
      if (!(t > 0.05 && t < best)) continue;
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t, u = (x - w.ax) * w.tx + (z - w.az) * w.tz;
      if (u < 0 || u > w.len || y < w.y0 || y > w.y1) continue;
      if (w.gaps.some((g) => u > g[0] && u < g[1] && y < floorY + 2.03)) continue;
      best = t;
    }
    return best;
  };
}

/** The walkthrough: head every 0.25 m, a fan of depth rays (24 yaw × 6 pitch), fused in the house frame. */
function scanWalk(w0, frame) {
  const grid = new HouseGrid({ maxChunks: 64 });
  const ss = ssGeometry(snap, frame.m);
  const fuser = new Fuser(grid, { floorAt: ss.floorAt });
  const cast = realHouse(w0);
  const o = [0, 0, 0], p = [0, 0, 0];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const [x, z] of walkPoints(0.25)) {
    const fy = w0.floorY(x, z), hy = fy + 1.62;
    apply(frame.m, x, hy, z, o);
    fuser.addWalk(o[0], o[1], o[2]);
    for (let a = 0; a < 24; a++) {
      for (const pitch of [-0.9, -0.6, -0.35, -0.15, 0.05, 0.2]) {
        const yaw = (a / 24) * Math.PI * 2 + rnd() * 0.2, cp = Math.cos(pitch);
        const dx = Math.cos(yaw) * cp, dy = Math.sin(pitch), dz = Math.sin(yaw) * cp;
        const t = cast(x, hy, z, dx, dy, dz, fy);
        if (!(t < 5.9)) continue;
        const e = (rnd() - 0.5) * 0.01;
        apply(frame.m, x + dx * (t + e), hy + dy * (t + e), z + dz * (t + e), p);
        fuser.addPoint(o[0], o[1], o[2], p[0], p[1], p[2]);
      }
    }
  }
  return { grid, ss, fuser };
}

test('without the scan: Space Setup closes the hall off (the v0.4 replay)', () => {
  const w = build(snap);
  const b = region(w, START), h = region(w, HALL), l = region(w, LIVING);
  assert.ok(b > 0 && h > 0 && l > 0, `regions ${b} ${h} ${l}`);
  assert.ok(b !== h && h !== l, `bedroom ${b}, hall ${h}, living room ${l}: the hall is closed`);
});

test('the walkthrough scan opens the hall where the user walked; the world built from it is connected', () => {
  const frame = houseFrameOf(snap);
  assert.ok(frame && /^house-[0-9a-f]{8}$/.test(frame.id), JSON.stringify(frame && frame.sig));
  const w0 = build(snap);
  const { grid, ss, fuser } = scanWalk(w0, frame);
  const st = fuser.stats();
  assert.ok(st.points > 4000 && st.floorHits > 1000 && st.freeCells > 50000, JSON.stringify(st));
  const res = analyzeHouse(grid, ss);
  const walkedOpenings = res.openings.filter((o) => o.walked);
  assert.ok(walkedOpenings.length >= 2, `openings ${JSON.stringify(res.openings.map((o) => [o.cx.toFixed(2), o.cz.toFixed(2), o.w.toFixed(2), o.walked]))}`);
  assert.ok(res.openings.every((o) => o.w >= 0.75 && o.w <= 2.5), 'door-sized');
  assert.ok(res.rooms >= 1 && res.ms < 2000, `rooms ${res.rooms}, ${res.ms.toFixed(0)} ms`);
  const ov = scanOverlay(res, frame.inv);
  const merged = applyScan(snap, ov);
  assert.equal(merged.scanBase.planes, snap.planes.length);
  assert.ok(merged.scanWalked.length > 20);
  const w = build(merged);
  const b = region(w, START), h = region(w, HALL), l = region(w, LIVING);
  assert.ok(b > 0 && b === h && h === l, `after the scan: bedroom ${b}, hall ${h}, living room ${l}; ${w.stats.notes.join(' | ')}`);
  // Space Setup's walls stay (only cut where the user walked)
  assert.ok(w.layout.walls.filter((x) => !x.inferred).length >= w0.layout.walls.filter((x) => !x.inferred).length);
  // the rooms walked are scanned; the space behind the real walls the walk never reached stays hidden
  for (const p of [START, HALL, LIVING]) assert.equal(w.nav.isHidden(p.x, p.z), false);
  assert.equal(w.nav.isHidden(-1.22, 4.5), true, 'behind the living room doors');
  // the merged snapshot replaces (not stacks) on a second application
  const again = applyScan(merged, ov);
  assert.equal(again.planes.length, merged.planes.length);
  // and a realign carries the learned part
  assert.ok(houseFrameOf(merged).id === frame.id, 'the house id comes from Space Setup only');
});

test('a room the walk went into is scanned space: the hallway behind the living room doors is no longer hidden', () => {
  const frame = houseFrameOf(snap);
  const w0 = build(snap);
  assert.equal(w0.nav.isHidden(-1.22, 4.5), true, 'hidden before (v0.4.1 rule)');
  // walked points only (the head path through door 5 into the hallway and along it)
  const walked = [];
  for (const [ax, az, bx, bz] of [[3.0, 5.0], [1.0, 5.0], [-1.0, 4.8], [-1.2, 3.5]].flatMap((p, i, a) => (i ? [[...a[i - 1], ...p]] : []))) {
    for (let k = 0; k <= 10; k++) walked.push(ax + ((bx - ax) * k) / 10, az + ((bz - az) * k) / 10);
  }
  const house = [];
  const o = [0, 0, 0];
  for (let i = 0; i < walked.length; i += 2) { apply(frame.m, walked[i], 0, walked[i + 1], o); house.push(o[0], o[2]); }
  const res = { v: 1, openings: [], floors: [], walls: [], boxes: [], walked: house, rooms: 1, observedM2: 0, coverage: 0, newFloorM2: 0, chunks: 0, key: '', ms: 0 };
  const w = build(applyScan(snap, scanOverlay(res, frame.inv)));
  assert.equal(w.nav.isHidden(-1.22, 4.5), false, 'walked: scanned');
  assert.equal(w.nav.isHidden(6.38, 1.5), true, 'the closed corner nobody walked stays hidden');
});
