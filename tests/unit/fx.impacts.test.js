// src/fx/impactTable.js and src/fx/decalAtlas.js: surfaces → impact kinds,
// recipes (cells, sounds from the existing bank), particle velocities, and the
// procedural decal atlas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IMP, IMP_NAMES, RECIPES, PKIND, PK_COUNT, ATLAS_CELLS, ATLAS_COLS, ATLAS_ROWS, CELL, PV_LEN, impactKind, particleVelocity, particleCount,
} from '../../src/fx/impactTable.js';
import { makeDecalAtlas, ATLAS_CELL_PX } from '../../src/fx/decalAtlas.js';

const manifest = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8'));

test('surface labels → impact kinds', () => {
  const cases = {
    wall: IMP.PLASTER, 'wall face': IMP.PLASTER, other: IMP.PLASTER, '': IMP.PLASTER, ceiling: IMP.CEILING, door: IMP.DOOR,
    table: IMP.WOOD, shelf: IMP.WOOD, storage: IMP.WOOD, hard: IMP.WOOD, desk: IMP.WOOD,
    couch: IMP.COUCH, sofa: IMP.COUCH, soft: IMP.COUCH, bed: IMP.BED,
    screen: IMP.METAL, lamp: IMP.METAL, 'wall art': IMP.GLASS, 'window frame': IMP.GLASS, window: IMP.GLASS,
    plant: IMP.WOOD, 'some new label': IMP.WOOD,
  };
  for (const [label, kind] of Object.entries(cases)) assert.equal(impactKind(label), kind, label);
  assert.equal(impactKind('floor'), IMP.FLOOR_WOOD);
  assert.equal(impactKind('floor', 'carpet'), IMP.FLOOR_CARPET);
  assert.equal(impactKind('floor', 'tile'), IMP.FLOOR_TILE);
  assert.equal(impactKind('floor', 'lava'), IMP.FLOOR_WOOD);
});

test('every recipe is complete and uses only sounds in the bank', () => {
  assert.equal(RECIPES.length, IMP_NAMES.length);
  for (let k = 0; k < RECIPES.length; k++) {
    const r = RECIPES[k];
    assert.equal(r.name, IMP_NAMES[k]);
    assert.ok(r.cells.length > 0);
    for (const c of r.cells) assert.ok(c >= 0 && c < ATLAS_CELLS, `${r.name} cell ${c}`);
    assert.ok(r.size0 > 0.01 && r.size1 >= r.size0 && r.size1 < 0.2, `${r.name} decal size`);
    assert.ok(r.sounds.length >= 1 && r.sounds.length <= 2, `${r.name}: one or two voices`);
    for (const [key, gain, rate] of r.sounds) {
      assert.ok(Array.isArray(manifest.sounds[key]) && manifest.sounds[key].length > 0, `${r.name}: sound ${key} is in the bank`);
      assert.ok(gain > 0 && gain <= 1 && rate >= 0.5 && rate <= 1.5, `${r.name}: ${key} gain / rate`);
    }
    for (const [pk, count, s0, s1, spread] of r.parts) {
      assert.ok(pk >= 0 && pk < PK_COUNT && count > 0 && count <= 8 && s1 >= s0 && s0 > 0 && spread >= 0 && spread <= 1, `${r.name} part`);
    }
    assert.ok(particleCount(k, true) <= 16, `${r.name}: at most 16 particles a rifle hit (pool 160 at 10 hits / s)`);
  }
  // the CQC lessons: fabric makes no ring and a soft thud, a bed feathers, wood splinters, plaster dusts
  assert.ok(RECIPES[IMP.BED].parts.some((p) => p[0] === 5), 'feathers out of a bed');
  assert.ok(RECIPES[IMP.WOOD].parts.some((p) => p[0] === 2), 'splinters off wood');
  assert.ok(RECIPES[IMP.PLASTER].parts.some((p) => p[0] === 0), 'gypsum dust');
  assert.equal(RECIPES[IMP.COUCH].sounds[0][0], 'impactFlesh', 'a soft thump, not a crack');
  assert.ok(RECIPES[IMP.COUCH].size1 < RECIPES[IMP.PLASTER].size0, 'fabric: a small tear, no paper ring');
  assert.equal(PKIND.length, PK_COUNT);
});

test('particle velocity: out of the surface, toward the shooter, within the speed range', () => {
  const out = new Float64Array(3), P = new Float64Array(PV_LEN);
  const pv = (...a) => { P.set(a); return particleVelocity(P, out); };
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x80000000; };
  for (let i = 0; i < 2000; i++) {
    // random normal and a bullet coming into it
    let nx = rnd() - 0.5, ny = rnd() - 0.5, nz = rnd() - 0.5;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    let dx = -nx + (rnd() - 0.5), dy = -ny + (rnd() - 0.5), dz = -nz + (rnd() - 0.5);
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    if (dx * nx + dy * ny + dz * nz > -0.05) continue;
    const speed = 0.5 + rnd() * 2, spread = rnd();
    pv(nx, ny, nz, dx, dy, dz, rnd(), rnd(), rnd(), speed, spread);
    const v = Math.hypot(out[0], out[1], out[2]);
    assert.ok(Number.isFinite(v) && v > 0);
    assert.ok(out[0] * nx + out[1] * ny + out[2] * nz > 0, 'never into the surface');
    assert.ok(v <= speed * 1.35 && v >= speed * 0.69 * 0.05, `speed ${v} for ${speed}`);
  }
  // spread 0: straight along the bounce direction (the normal tilted back toward the shooter)
  pv(0, 0, 1, 0, 0, -1, 0.5, 0.5, 0.5, 1, 0);
  assert.ok(Math.abs(out[0]) < 1e-9 && Math.abs(out[1]) < 1e-9 && out[2] > 0.9);
  pv(0, 0, 1, 0.6, 0, -0.8, 0.5, 0.5, 0.5, 1, 0);
  assert.ok(out[0] < 0, 'spall comes back along the shot (against its sideways travel)');
});

test('decal atlas: size, premultiplied, dark opaque hole cores, empty gutters, deterministic', () => {
  const A = makeDecalAtlas();
  assert.equal(A.width, ATLAS_CELL_PX * ATLAS_COLS);
  assert.equal(A.height, ATLAS_CELL_PX * ATLAS_ROWS);
  assert.equal(A.data.length, A.width * A.height * 4);
  const d = A.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > d[i + 3] + 1 || d[i + 1] > d[i + 3] + 1 || d[i + 2] > d[i + 3] + 1) assert.fail(`not premultiplied at ${i / 4}`);
  }
  for (let c = 0; c < ATLAS_CELLS; c++) {
    const cx = (c % ATLAS_COLS) * A.cell, cy = Math.floor(c / ATLAS_COLS) * A.cell;
    // the hole core (a 6 × 6 px patch at the centre): opaque and dark on average
    // (glass: a 2 × 2 px pinhole inside its frosted crush ring)
    const h = c === CELL.GLASS ? 1 : 3;
    let ca = 0, cl = 0;
    for (let y = -h; y < h; y++) for (let x = -h; x < h; x++) {
      const o = ((cy + A.cell / 2 + y) * A.width + cx + A.cell / 2 + x) * 4;
      ca += d[o + 3]; cl += (d[o] + d[o + 1] + d[o + 2]) / 3;
    }
    ca /= 4 * h * h; cl /= 4 * h * h;
    assert.ok(ca > 200, `cell ${c}: the hole core is opaque (${ca})`);
    assert.ok(cl < 60, `cell ${c}: and dark (${cl})`);
    // the 3-pixel gutter round each cell and the corners are empty
    for (let k = 0; k < A.cell; k++) {
      for (const [x, y] of [[k, 0], [k, A.cell - 1], [0, k], [A.cell - 1, k], [k, 2], [2, k]]) {
        assert.equal(d[((cy + y) * A.width + cx + x) * 4 + 3], 0, `cell ${c} gutter at ${x},${y}`);
      }
    }
    // there is more than the hole: a ring, splinters, fibres or cracks with some coverage
    let covered = 0;
    for (let y = 0; y < A.cell; y++) for (let x = 0; x < A.cell; x++) if (d[((cy + y) * A.width + cx + x) * 4 + 3] > 20) covered++;
    assert.ok(covered > A.cell * A.cell * 0.03, `cell ${c} coverage ${covered}`);
  }
  // the glass cell is mostly light cracks (lit by the room), not a dark blot
  const gc = CELL.GLASS, gx = (gc % ATLAS_COLS) * A.cell, gy = Math.floor(gc / ATLAS_COLS) * A.cell;
  let light = 0, dark = 0;
  for (let y = 0; y < A.cell; y++) for (let x = 0; x < A.cell; x++) {
    const o = ((gy + y) * A.width + gx + x) * 4;
    if (d[o + 3] < 40) continue;
    if (d[o] / d[o + 3] > 0.7) light++; else dark++;
  }
  assert.ok(light > dark, `glass: light ${light} vs dark ${dark}`);
  const B = makeDecalAtlas();
  assert.deepEqual(Buffer.from(B.data), Buffer.from(A.data), 'deterministic');
});
