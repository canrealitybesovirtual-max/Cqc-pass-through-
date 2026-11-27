// src/fx/shadowMath.js: box footprints on a plane, the blob record (height
// fade, growth, key-light offset), and body capsules on the floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SH, SH_LEN, SHADOW, W_LEN, BF_LEN, boxFootprint as bf, writeShadow as ws, capsuleFloor as cf, smoothstep } from '../../src/fx/shadowMath.js';

// the functions take typed arrays (no doubles across calls in the frame path); these wrap the old argument lists
const BQ = new Float64Array(BF_LEN), WI = new Float64Array(W_LEN), CP = new Float64Array(2);
/** @returns {Float64Array} */
const boxFootprint = (qx, qy, qz, qw, hx, hy, hz, nx, ny, nz, out) => { BQ.set([qx, qy, qz, qw, hx, hy, hz, nx, ny, nz]); return bf(BQ, out); };
const writeShadow = (out, o, px, py, pz, nx, ny, nz, ax, ay, az, a, b, h, alpha, soft, pull, lx, ly, lz, fadeH) => {
  WI.set([px, py, pz, nx, ny, nz, ax, ay, az, a, b, h, alpha, soft, pull, lx, ly, lz, fadeH]);
  return ws(out, o, WI);
};
const capsuleFloor = (ax, ay, az, bx, by, bz, r, floorY, out) => { CP[0] = r; CP[1] = floorY; return cf([ax, ay, az], [bx, by, bz], 0, CP, out); };

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);
/** Quaternion about an axis. */
const quat = (ax, ay, az, ang) => { const s = Math.sin(ang / 2), l = Math.hypot(ax, ay, az); return [ax / l * s, ay / l * s, az / l * s, Math.cos(ang / 2)]; };

test('a box lying flat on the floor: its own extents', () => {
  const out = new Float64Array(6);
  boxFootprint(0, 0, 0, 1, 0.1, 0.02, 0.03, 0, 1, 0, out);
  near(out[3], 0.1, 1e-9, 'semi-major = hx');
  near(out[4], 0.03, 1e-9, 'semi-minor = hz');
  near(Math.abs(out[0]), 1, 1e-9, 'major along x');
  near(out[5], 0.02, 1e-9, 'half thickness = hy');
});

test('turned 90° about +Y, the major axis follows', () => {
  const out = new Float64Array(6);
  const q = quat(0, 1, 0, Math.PI / 2);
  boxFootprint(q[0], q[1], q[2], q[3], 0.1, 0.02, 0.03, 0, 1, 0, out);
  near(out[3], 0.1, 1e-9, 'semi-major');
  near(Math.abs(out[2]), 1, 1e-9, 'major along z now');
  near(out[1], 0, 1e-9, 'in the plane');
});

test('a gun stood on its grip (rolled 90° about its length): thin footprint, tall', () => {
  const out = new Float64Array(6);
  const q = quat(1, 0, 0, Math.PI / 2);
  boxFootprint(q[0], q[1], q[2], q[3], 0.1, 0.02, 0.06, 0, 1, 0, out);
  near(out[3], 0.1, 1e-9, 'length stays');
  near(out[4], 0.02, 1e-9, 'the old thickness is the width');
  near(out[5], 0.06, 1e-9, 'the old width is the height');
});

test('a tilted plane: the major axis lies in it, eigen-axes are orthogonal', () => {
  const out = new Float64Array(6);
  const n = [0.3, 0.9, 0.2], l = Math.hypot(...n);
  const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l;
  const q = quat(0.2, 1, 0.4, 0.8);
  boxFootprint(q[0], q[1], q[2], q[3], 0.12, 0.03, 0.05, nx, ny, nz, out);
  near(out[0] * nx + out[1] * ny + out[2] * nz, 0, 1e-9, 'major ⟂ normal');
  near(Math.hypot(out[0], out[1], out[2]), 1, 1e-9, 'unit');
  assert.ok(out[3] >= out[4] && out[4] > 0);
  assert.ok(out[3] <= Math.hypot(0.12, 0.03, 0.05) + 1e-9, 'never more than the box diagonal');
});

test('writeShadow: contact, fading with height, gone above fadeH, away from the light', () => {
  const R = new Float64Array(SH_LEN * 2);
  assert.ok(writeShadow(R, 0, 1, 0, 2, 0, 1, 0, 1, 0, 0, 0.1, 0.04, 0, 0.5, 0.5, 0.01, 0.5, 0.8, 0, SHADOW.fadeH));
  near(R[SH.ALPHA], 0.5, 1e-9, 'full alpha at contact');
  near(R[SH.CX], 1, 1e-9, 'no offset at contact');
  near(R[SH.A], 0.1, 1e-9, 'no growth at contact');
  assert.ok(writeShadow(R, SH_LEN, 1, 0, 2, 0, 1, 0, 1, 0, 0, 0.1, 0.04, 0.15, 0.5, 0.5, 0.01, 0.5, 0.8, 0, SHADOW.fadeH));
  const o = SH_LEN;
  assert.ok(R[o + SH.ALPHA] < 0.5 && R[o + SH.ALPHA] > 0.05, 'fades with height');
  assert.ok(R[o + SH.A] > 0.1, 'grows with height');
  assert.ok(R[o + SH.CX] < 1, 'falls away from a light on +x');
  near(R[o + SH.CY], 0, 1e-12, 'stays in the plane (horizontal offset only)');
  assert.ok(R[o + SH.SOFT] > 0.5, 'softer when higher');
  assert.equal(writeShadow(R, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0.1, 0.04, SHADOW.fadeH + 0.01, 0.5, 0.5, 0.01, 0, 1, 0, SHADOW.fadeH), false);
  assert.equal(writeShadow(R, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0.04, 0, 0.5, 0.5, 0.01, 0, 1, 0, SHADOW.fadeH), false, 'empty footprint');
  assert.ok(writeShadow(R, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0.1, 0.04, -0.02, 0.5, 0.5, 0.01, 0, 1, 0, SHADOW.fadeH), 'sunk a little: full contact');
});

test('capsuleFloor: a thigh lying on the floor', () => {
  const out = new Float64Array(7);
  capsuleFloor(0, 0.1, 0, 0.4, 0.12, 0.3, 0.09, 0, out);
  near(out[0], 0.2, 1e-9, 'centre x'); near(out[1], 0.15, 1e-9, 'centre z');
  near(Math.hypot(out[2], out[3]), 1, 1e-9, 'unit direction');
  near(out[4], 0.25 + 0.09 * SHADOW.deadPad, 1e-9, 'half length + padded radius');
  assert.ok(out[5] > 0.09, 'wider than the limb: the blob shows round it');
  near(out[6], 0.01, 1e-9, 'lowest point above the floor');
  capsuleFloor(0, 0.5, 0, 0, 1.5, 0, 0.1, 0, out);
  assert.equal(out[2], 1, 'vertical capsule: any axis');
  assert.ok(smoothstep(0, 1, 0.5) === 0.5 && smoothstep(0, 1, -1) === 0 && smoothstep(0, 1, 2) === 1);
});
