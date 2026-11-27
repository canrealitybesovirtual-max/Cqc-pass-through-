// src/fx/roomLightMath.js: camera frame stats, the target mapping, presets
// (auto by time of day and windows, manual), smoothing, light levels and the
// saved per-house settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RL, ST, STATS_LEN, T, TARGET_LEN, LV, LEVELS_LEN, LEVEL_AUTO, LEVEL_DIM, LEVEL_NORMAL, LEVEL_BRIGHT, WARM_AUTO, WARM_WARM, WARM_NEUTRAL, WARM_COOL,
  SRGB_TO_LINEAR, linearToSrgb, frameStats, sampleOk, targetsFromStats, daylight, presetTargets, lightLevels, LightSmoother,
  parseRoomLight, serializeRoomLight, roomPreset, setRoomPreset, defaultRoomLight, MAX_HOUSES,
} from '../../src/fx/roomLightMath.js';

const W = 32, H = 24;
/** @param {(x: number, y: number) => number[]} f rgb bytes per pixel */
function frame(f) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = f(x, y), o = (y * W + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
  return d;
}
const stats = () => new Float64Array(STATS_LEN);
const hist = new Uint32Array(256);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

test('sRGB tables round-trip', () => {
  for (const b of [0, 10, 50, 118, 200, 255]) near(linearToSrgb(SRGB_TO_LINEAR[b]) * 255, b, 0.01, `byte ${b}`);
  assert.equal(linearToSrgb(-1), 0);
  assert.equal(linearToSrgb(2), 1);
  assert.equal(linearToSrgb(NaN), 0);
});

test('frameStats: a uniform grey frame', () => {
  const s = frameStats(frame(() => [118, 118, 118]), W, H, stats(), hist);
  const lin = SRGB_TO_LINEAR[118];
  near(s[ST.Y], lin, 1e-6, 'mean Y');
  near(s[ST.R], lin, 1e-6, 'mean R');
  near(s[ST.P5], lin, 0.01, 'p5');
  near(s[ST.P50], lin, 0.01, 'p50');
  near(s[ST.P95], lin, 0.01, 'p95');
  assert.equal(s[ST.CLIPPED], 0);
  assert.equal(s[ST.VALID], 1);
  assert.equal(s[ST.N], W * H);
});

test('frameStats: a bright lamp in the top right, clipped pixels, black pixels', () => {
  const s = frameStats(frame((x, y) => (x >= 24 && y < 6 ? [255, 250, 230] : x < 4 ? [0, 0, 0] : [90, 80, 70])), W, H, stats(), hist);
  assert.ok(s[ST.CLIPPED] > 0.05 && s[ST.CLIPPED] < 0.08, `clipped ${s[ST.CLIPPED]}`);
  assert.ok(s[ST.CU] > 0.75 && s[ST.CV] < 0.3, `bright centroid ${s[ST.CU]}, ${s[ST.CV]}`);
  // the colour mean leaves out the clipped and the black pixels: it is the wall's colour
  near(s[ST.R], SRGB_TO_LINEAR[90], 1e-6, 'mean R excludes clipped / black');
  assert.ok(s[ST.P5] < 0.01, 'p5 sees the black strip');
  assert.ok(s[ST.P95] > s[ST.P50]);
});

test('frameStats: garbage in → invalid, never NaN', () => {
  const s = frameStats(new Uint8Array(10), W, H, stats(), hist);
  assert.equal(s[ST.VALID], 0);
  for (let i = 0; i < STATS_LEN; i++) assert.ok(Number.isFinite(s[i]));
  const k = frameStats(frame(() => [0, 0, 0]), W, H, stats(), hist);
  assert.equal(k[ST.VALID], 0, 'an all-black frame (lens covered) is not used');
});

test('targetsFromStats: a dim warm room vs a bright cool one', () => {
  const t = new Float64Array(TARGET_LEN);
  const dim = frameStats(frame((x) => (x > 28 ? [200, 150, 90] : [60, 48, 34])), W, H, stats(), hist);
  assert.ok(targetsFromStats(dim, 1, t));
  assert.ok(t[T.E] < 0.6, `dim E ${t[T.E]}`);
  assert.ok(t[T.WR] > t[T.WB], 'warm: red over blue');
  assert.ok(t[T.GRAIN] > 0, 'grain in a dim room');
  const dimE = t[T.E];
  const bright = frameStats(frame((x) => (x > 28 ? [230, 240, 255] : [170, 178, 190])), W, H, stats(), hist);
  assert.ok(targetsFromStats(bright, 1, t));
  assert.ok(t[T.E] > dimE * 2, `bright E ${t[T.E]}`);
  assert.ok(t[T.WB] > t[T.WR], 'cool: blue over red');
  assert.equal(t[T.GRAIN], 0, 'no grain in a bright room');
  for (const c of [T.WR, T.WG, T.WB]) assert.ok(t[c] > 0.8 && t[c] < 1.2, `wb channel within the clamp: ${t[c]}`);
  // luminance-normalised white balance
  near(0.2126 * t[T.WR] + 0.7152 * t[T.WG] + 0.0722 * t[T.WB], 1, 1e-9, 'wb luminance');
  // trim
  const mid = frameStats(frame(() => [100, 100, 100]), W, H, stats(), hist);
  targetsFromStats(mid, 1.3, t);
  const trimmed = t[T.E];
  targetsFromStats(mid, 1, t);
  near(trimmed / t[T.E], 1.3, 1e-9, 'trim scales the level');
  assert.equal(targetsFromStats(stats(), 1, t), false, 'invalid stats are refused');
});

test('targetsFromStats: E and the black lift stay in range', () => {
  const t = new Float64Array(TARGET_LEN);
  const s = frameStats(frame(() => [255, 254, 254]), W, H, stats(), hist);
  s[ST.VALID] = 1;
  targetsFromStats(s, 1, t);
  assert.ok(t[T.E] <= RL.eMax && t[T.BLACK] <= RL.blackMax && t[T.KEY] >= 0.5 && t[T.KEY] <= 1.5);
});

test('sampleOk gates fast turns, looking up, clipped frames', () => {
  assert.ok(sampleOk(5, 0, 0.01));
  assert.ok(!sampleOk(60, 0, 0.01));
  assert.ok(!sampleOk(-60, 0, 0.01));
  assert.ok(!sampleOk(5, 50, 0.01));
  assert.ok(!sampleOk(5, 0, 0.5));
});

test('daylight by hour', () => {
  assert.equal(daylight(12 * 60), 1);
  assert.equal(daylight(2 * 60), 0);
  assert.equal(daylight(23 * 60), 0);
  assert.ok(daylight(450) > 0 && daylight(450) < 1);
  assert.ok(daylight(1110) > 0 && daylight(1110) < 1);
  assert.equal(daylight(36 * 60), 1, 'wraps');
  assert.equal(daylight(NaN), 1, 'unknown time: midday');
});

test('presetTargets: auto by time and window, manual levels and warmth', () => {
  const t = new Float64Array(TARGET_LEN);
  presetTargets(LEVEL_AUTO, WARM_AUTO, 780, true, t);
  const dayWin = Float64Array.from(t);
  presetTargets(LEVEL_AUTO, WARM_AUTO, 1320, true, t);
  const night = Float64Array.from(t);
  presetTargets(LEVEL_AUTO, WARM_AUTO, 780, false, t);
  const dayNoWin = Float64Array.from(t);
  assert.ok(dayWin[T.E] > night[T.E], 'a room with a window is brighter by day');
  assert.ok(dayWin[T.E] > dayNoWin[T.E], 'than a room without one');
  assert.ok(night[T.WR] > night[T.WB], 'night: warm lamps');
  assert.ok(dayWin[T.WB] > dayWin[T.WR], 'day with a window: cool');
  assert.ok(night[T.BLACK] > dayWin[T.BLACK], 'dimmer → more lifted blacks');
  assert.ok(dayWin[T.KEY] > dayNoWin[T.KEY], 'a window gives a stronger key');
  presetTargets(LEVEL_DIM, WARM_WARM, 780, true, t);
  assert.ok(t[T.E] < 0.7 && t[T.WR] > t[T.WB]);
  presetTargets(LEVEL_BRIGHT, WARM_COOL, 120, false, t);
  assert.ok(t[T.E] > 1.2 && t[T.WB] > t[T.WR]);
  presetTargets(LEVEL_NORMAL, WARM_NEUTRAL, 120, false, t);
  near(t[T.E], 1, 1e-9, 'normal');
  near(t[T.WR], 1, 1e-9, 'neutral r'); near(t[T.WB], 1, 1e-9, 'neutral b');
  presetTargets(99, -5, NaN, false, t);
  for (let i = 0; i < TARGET_LEN; i++) assert.ok(Number.isFinite(t[i]), `out of range inputs → defaults (${i})`);
});

test('lightLevels: a normal neutral room is the baseline', () => {
  const base = { hemi: 0.9, sun: 1.1, env: 0.55, sky: [0.9, 0.86, 0.8], ground: [0.02, 0.02, 0.016], sunColor: [1, 0.87, 0.72] };
  const t = new Float64Array(TARGET_LEN), out = new Float64Array(LEVELS_LEN);
  presetTargets(LEVEL_NORMAL, WARM_NEUTRAL, 720, false, t);
  t[T.KEY] = 1;
  lightLevels(base, t, out);
  near(out[LV.HEMI], 0.9, 1e-9, 'hemi'); near(out[LV.SUN], 1.1, 1e-9, 'sun'); near(out[LV.ENV], 0.55, 1e-9, 'env');
  near(out[LV.SKY], 0.9, 1e-9, 'sky r'); near(out[LV.SUNC + 2], 0.72, 1e-9, 'sun b');
  for (let c = 0; c < 3; c++) near(out[LV.ROOM + c], 1, 1e-9, 'room light 1 in a normal room');
  t[T.E] = 0.5;
  lightLevels(base, t, out);
  near(out[LV.HEMI], 0.45, 1e-9, 'half');
  assert.ok(out[LV.ROOM] < 1 && out[LV.ROOM] > 0.5, `room light at half level, perceptual: ${out[LV.ROOM]}`);
});

test('LightSmoother: brightens faster than it darkens, colour slowest, dead band, NaN refused', () => {
  const s = new LightSmoother();
  const t = new Float64Array(TARGET_LEN);
  presetTargets(LEVEL_NORMAL, WARM_NEUTRAL, 720, false, t);
  assert.ok(s.setTarget(t));
  near(s.value[T.E], 1, 1e-9, 'primed at once');
  // up to 2: after 1 s (τ 1) the log distance is e⁻¹ of the start
  t[T.E] = 2;
  assert.ok(s.setTarget(t));
  for (let i = 0; i < 72; i++) s.update(1 / 72);
  near(Math.log(2 / s.value[T.E]), Math.log(2) * Math.exp(-1), 0.01, 'τ up 1 s');
  // back down: τ 2.5 s, so after 1 s it is further from the goal than the rise was
  const up = s.value[T.E];
  t[T.E] = 1;
  s.setTarget(t);
  for (let i = 0; i < 72; i++) s.update(1 / 72);
  near(Math.log(s.value[T.E] / 1), Math.log(up) * Math.exp(-1 / 2.5), 0.01, 'τ down 2.5 s');
  // dead band
  const before = s.accepted;
  t[T.E] = 1.02;
  assert.equal(s.setTarget(t), false, 'a 2 % change is ignored');
  assert.equal(s.accepted, before);
  t[T.E] = NaN;
  assert.equal(s.setTarget(t), false);
  // colour is slower than level
  t[T.E] = 1; t[T.WR] = 1.1;
  s.setTarget(t);
  s.snap();
  t[T.E] = 2; t[T.WR] = 0.9;
  s.setTarget(t);
  for (let i = 0; i < 72; i++) s.update(1 / 72);
  const eDone = Math.log(s.value[T.E]) / Math.log(2), wDone = (1.1 - s.value[T.WR]) / 0.2;
  assert.ok(eDone > wDone * 2, `level ${eDone} vs colour ${wDone}`);
  // big dt is clamped, never overshoots
  s.update(100);
  assert.ok(s.value[T.E] <= 2 + 1e-9);
});

test('LightSmoother.update allocates nothing', () => {
  const s = new LightSmoother();
  const t = new Float64Array(TARGET_LEN);
  presetTargets(LEVEL_AUTO, WARM_AUTO, 720, true, t);
  s.setTarget(t);
  for (let i = 0; i < 20000; i++) s.update(1 / 72);
  globalThis.gc?.();
  const b = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) { s.update(1 / 72); if (i % 5000 === 0) { t[T.E] = 0.5 + (i % 3) * 0.5; s.setTarget(t); } }
  const grew = process.memoryUsage().heapUsed - b;
  assert.ok(grew < 200_000, `heap grew ${grew} B over 100k updates`);
});

test('saved settings: parse is robust, presets round-trip, houses capped', () => {
  for (const bad of [null, '', '{', '[]', '{"v":2}', 'x'.repeat(70000), '{"v":1,"houses":{"h":{"rooms":{"1":[9,9],"x<script>":[1,1],"2":[1]}}}}']) {
    const s = parseRoomLight(bad);
    assert.equal(s.v, 1);
    for (const h of Object.values(s.houses)) assert.deepEqual(h.rooms, {});
  }
  const s = defaultRoomLight();
  setRoomPreset(s, 'h110-16-6', 3, LEVEL_DIM, WARM_WARM, 1000);
  setRoomPreset(s, 'h110-16-6', 4, LEVEL_AUTO, WARM_AUTO, 1001);
  const back = parseRoomLight(serializeRoomLight(s));
  const out = [0, 0];
  assert.deepEqual(roomPreset(back, 'h110-16-6', 3, out), [LEVEL_DIM, WARM_WARM]);
  assert.deepEqual(roomPreset(back, 'h110-16-6', 4, out), [LEVEL_AUTO, WARM_AUTO], 'auto/auto is not stored');
  assert.deepEqual(roomPreset(back, 'other', 3, out), [LEVEL_AUTO, WARM_AUTO]);
  for (let i = 0; i < MAX_HOUSES + 5; i++) setRoomPreset(s, `h${i}`, 1, LEVEL_BRIGHT, WARM_COOL, 2000 + i);
  const capped = parseRoomLight(serializeRoomLight(s));
  assert.equal(Object.keys(capped.houses).length, MAX_HOUSES);
  assert.ok(capped.houses[`h${MAX_HOUSES + 4}`], 'the newest house is kept');
});
