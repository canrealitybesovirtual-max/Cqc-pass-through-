import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, polygonArea } from '../../src/util/geom2d.js';

const square = new Float32Array([0, 0, 4, 0, 4, 3, 0, 3]);
const ell = new Float32Array([0, 0, 4, 0, 4, 1, 1, 1, 1, 3, 0, 3]);

test('point in a 4×3 room', () => {
  assert.ok(pointInPolygon(square, 4, 2, 1.5));
  assert.ok(!pointInPolygon(square, 4, 5, 1));
  assert.ok(!pointInPolygon(square, 4, -0.01, 1));
});

test('concave L-shaped room', () => {
  assert.ok(pointInPolygon(ell, 6, 0.5, 2));
  assert.ok(pointInPolygon(ell, 6, 3, 0.5));
  assert.ok(!pointInPolygon(ell, 6, 3, 2));
});

test('area and winding', () => {
  assert.equal(polygonArea(square, 4), 12);
  const cw = new Float32Array([0, 0, 0, 3, 4, 3, 4, 0]);
  assert.equal(polygonArea(cw, 4), -12);
  assert.equal(Math.abs(polygonArea(ell, 6)), 6);
});
