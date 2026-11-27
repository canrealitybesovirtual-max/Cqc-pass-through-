/**
 * occlusionMath.js: depth linearisation, the fade band, eye/UV selection,
 * texel lookups, the PCF blend and the Bayer dither (the GLSL mirrors these;
 * tests/e2e/depth-occlusion.mjs checks the GPU against them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearParams, rawToMetres, metresToRaw, smooth01, visibility, eyeUv, nearestTexel, bilinearTexels, pcf,
  bayer4, ditherThreshold, LIN_EPS, BAND_MIN,
} from '../../src/xr/occlusionMath.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);

test('infinite far (Quest: near 0.1, far Infinity): a = near, b = 1, z = n / (1 − raw)', () => {
  const L = linearParams(0.1, Infinity, { a: 0, b: 0 });
  assert.deepEqual(L, { a: 0.1, b: 1 });
  for (const z of [0.1, 0.25, 0.5, 1, 2, 3.7, 5, 10]) {
    const raw = metresToRaw(z, 0.1, Infinity);
    near(raw, 1 - 0.1 / z, 1e-12, 'IWER encoding 1 − near/z');
    near(rawToMetres(raw, L.a, L.b, 1e9), z, 1e-9 * z, `round trip ${z} m`);
  }
  assert.equal(metresToRaw(0.1, 0.1, Infinity), 0, 'the near plane is raw 0');
});

test('finite far matches the GL perspective depth (glDepthRange 0..1)', () => {
  const n = 0.05, f = 50, L = linearParams(n, f, { a: 0, b: 0 });
  for (const z of [0.05, 0.3, 1, 2.5, 7, 49.9]) {
    // window depth of a view-space point at −z through three's makePerspective with near n, far f
    const ndc = ((f + n) / (f - n) * z - (2 * f * n) / (f - n)) / z; // (P·v).z / (P·v).w
    const raw = 0.5 * ndc + 0.5;
    near(metresToRaw(z, n, f), raw, 1e-12, `encode ${z}`);
    near(rawToMetres(raw, L.a, L.b, 1e9), z, 1e-9 * z, `decode ${z}`);
  }
  near(rawToMetres(1, L.a, L.b, 1e9), f, 1e-9, 'raw 1 = the far plane');
});

test('degenerate ranges fall back to an infinite far plane', () => {
  for (const far of [NaN, 0.1, 0.05, -1]) assert.deepEqual(linearParams(0.1, far, { a: 0, b: 0 }), { a: 0.1, b: 1 }, String(far));
});

test('raw 1 (nothing seen) clamps to maxMetres; no-data threshold is opt-in', () => {
  assert.equal(rawToMetres(1, 0.1, 1, 50), 50);
  assert.equal(rawToMetres(1.0000001, 0.1, 1, 50), 50, 'past 1 still clamps (den floored at LIN_EPS)');
  assert.ok(0.1 / LIN_EPS > 50);
  near(rawToMetres(0, 0.1, 1, 50), 0.1, 1e-12, 'raw 0 = near plane, as three reads it (hides everything)');
  assert.equal(rawToMetres(0, 0.1, 1, 50, 0), 50, 'noDataRaw 0: raw 0 = no data');
  assert.equal(rawToMetres(0.5, 0.1, 1, 50, 0), 0.2, 'values above the threshold decode normally');
});

test('16-bit quantisation stays under 4 mm at 5 m (the band is 80 mm)', () => {
  const L = linearParams(0.1, Infinity, { a: 0, b: 0 });
  for (const z of [1, 3, 5]) {
    const q = Math.round(metresToRaw(z, 0.1, Infinity) * 65535) / 65535;
    assert.ok(Math.abs(rawToMetres(q, L.a, L.b, 100) - z) < 0.004, `${z} m`);
  }
});

test('smooth01 is GLSL smoothstep(0,1,t) with the clamp', () => {
  assert.equal(smooth01(-1), 0);
  assert.equal(smooth01(0), 0);
  assert.equal(smooth01(0.5), 0.5);
  assert.equal(smooth01(1), 1);
  assert.equal(smooth01(2), 1);
  near(smooth01(0.25), 0.15625, 1e-12);
});

test('visibility: 50 % at the real surface, full band/2 in front, hidden band/2 behind', () => {
  const band = 0.08;
  assert.equal(visibility(2, 2, band, 0), 0.5);
  assert.equal(visibility(2, 2 - 0.04, band, 0), 1, 'band/2 in front');
  assert.equal(visibility(2, 2 + 0.04, band, 0), 0, 'band/2 behind');
  assert.equal(visibility(2, 1, band, 0), 1);
  assert.equal(visibility(2, 3, band, 0), 0);
  near(visibility(1, 1.02, band, 0), 0.15625, 1e-12, '2 cm behind');
  near(visibility(1, 0.98, band, 0), 0.84375, 1e-12, '2 cm in front');
  // monotonic in the fragment depth
  let last = 2;
  for (let z = 0.9; z <= 1.1; z += 0.001) { const v = visibility(1, z, band, 0); assert.ok(v <= last + 1e-12); last = v; }
});

test('visibility: a bias pulls the fragment toward the viewer (decals on real walls)', () => {
  // a decal exactly on the wall: without bias it is half hidden; with 0.05 (OCCLUSION_BIAS.decal) fully visible
  assert.equal(visibility(2.5, 2.5, 0.08, 0), 0.5);
  assert.equal(visibility(2.5, 2.5 - 0.05, 0.08, 0), 1);
});

test('visibility: band growth widens the band with depth; a zero band is floored', () => {
  const at = (real) => visibility(real, real + 0.04, 0.08, 0.02); // 4 cm behind the surface
  assert.equal(visibility(1, 1.04, 0.08, 0), 0, 'fixed band: hidden');
  assert.ok(at(1) > 0 && at(5) > at(1), 'wider band at 5 m keeps some visibility');
  assert.equal(visibility(1, 1 + BAND_MIN, 0, 0), 0, 'band 0 → BAND_MIN: a hard edge, no NaN');
  assert.equal(visibility(1, 1 - BAND_MIN, 0, 0), 1);
  assert.ok(Number.isFinite(visibility(1, 1, 0, -10)));
});

test('eyeUv: right eye from x ≥ the eye-1 viewport, as three does (side by side)', () => {
  const vp0 = [0, 0, 1680, 1760], vp1 = [1680, 0, 1680, 1760], o = { eye: -1, u: 0, v: 0 };
  eyeUv(0.5, 0.5, vp0, vp1, o);
  assert.equal(o.eye, 0); near(o.u, 0.5 / 1680, 1e-12); near(o.v, 0.5 / 1760, 1e-12);
  eyeUv(1679.5, 880, vp0, vp1, o);
  assert.equal(o.eye, 0); near(o.u, 1679.5 / 1680, 1e-12); near(o.v, 0.5, 1e-12);
  eyeUv(1680.5, 880, vp0, vp1, o);
  assert.equal(o.eye, 1); near(o.u, 0.5 / 1680, 1e-12);
  eyeUv(3359.5, 1759.5, vp0, vp1, o);
  assert.equal(o.eye, 1); near(o.u, 1679.5 / 1680, 1e-12); near(o.v, 1759.5 / 1760, 1e-12);
  // three's own test: coord.x = x / width0 ≥ 1 → layer 1, u = coord.x − 1
  for (const x of [10.5, 1679.5, 1680.5, 2500.5]) {
    eyeUv(x, 0.5, vp0, vp1, o);
    const cx = x / 1680;
    assert.equal(o.eye, cx >= 1 ? 1 : 0);
    near(o.u, cx >= 1 ? cx - 1 : cx, 1e-12);
  }
  // one view: x1 = 1e9 → always eye 0
  eyeUv(5000, 1, vp0, [1e9, 0, 1, 1], o);
  assert.equal(o.eye, 0);
});

test('nearestTexel: floor(uv · size), clamped to the edge (NEAREST sampling)', () => {
  const o = { x: -1, y: -1 };
  assert.deepEqual(nearestTexel(0, 0, 320, 320, o), { x: 0, y: 0 });
  assert.deepEqual(nearestTexel(0.5, 0.5, 320, 320, o), { x: 160, y: 160 });
  assert.deepEqual(nearestTexel(0.999999, 1, 320, 320, o), { x: 319, y: 319 });
  assert.deepEqual(nearestTexel(-0.2, 1.3, 320, 320, o), { x: 0, y: 319 });
});

test('bilinearTexels: texel centres at (i + 0.5) / size, clamp to edge', () => {
  const o = { x0: 0, y0: 0, x1: 0, y1: 0, fx: 0, fy: 0 };
  bilinearTexels(0.5 / 16, 0.5 / 8, 16, 8, o); // exactly on texel (0, 0)
  assert.deepEqual([o.x0, o.x1, o.y0, o.y1, o.fx, o.fy], [0, 1, 0, 1, 0, 0]);
  bilinearTexels(1 / 16, 1 / 8, 16, 8, o); // half way between texels 0 and 1
  assert.deepEqual([o.x0, o.x1, o.y0, o.y1, o.fx, o.fy], [0, 1, 0, 1, 0.5, 0.5]);
  bilinearTexels(0, 0, 16, 8, o); // left edge: both taps clamp to 0
  assert.deepEqual([o.x0, o.x1, o.y0, o.y1], [0, 0, 0, 0]);
  bilinearTexels(1, 1, 16, 8, o); // right edge
  assert.deepEqual([o.x0, o.x1, o.y0, o.y1], [15, 15, 7, 7]);
});

test('pcf blends visibilities, so a big depth step still gives a soft edge', () => {
  assert.equal(pcf(0, 1, 0, 1, 0.25, 0.7), 0.25);
  assert.equal(pcf(1, 1, 1, 1, 0.3, 0.3), 1);
  assert.equal(pcf(0, 0, 1, 1, 0.5, 0.25), 0.25);
  // wall at 1 m, far wall at 4 m, fragment at 2 m: per-texel vis 0 and 1 → linear ramp across the texel
  const v0 = visibility(1, 2, 0.08, 0), v1 = visibility(4, 2, 0.08, 0);
  for (let f = 0; f <= 1; f += 0.125) assert.equal(pcf(v0, v1, v0, v1, f, 0.5), f);
});

test('bayer4 is the 4×4 ordered-dither matrix; thresholds cover (0,1) evenly', () => {
  const M = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.equal(bayer4(x, y), M[y & 3][x & 3], `${x},${y}`);
  const seen = new Set();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.add(bayer4(x, y));
  assert.equal(seen.size, 16);
  // coverage of a 4×4 block = round(vis · 16)
  for (const vis of [0, 0.1, 0.25, 0.5, 0.74, 1]) {
    let kept = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (vis >= ditherThreshold(x, y)) kept++;
    assert.equal(kept, Math.round(vis * 16), `vis ${vis}`);
  }
});
