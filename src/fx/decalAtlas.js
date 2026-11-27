// @ts-check
/**
 * The bullet-hole decal atlas, drawn procedurally at load (pure: no three.js,
 * no DOM; Node-tested). 4 × 2 cells (impactTable.js CELL): plaster A / B,
 * wood A / B, fabric A / B, metal, glass. Premultiplied RGBA bytes: RGB is the
 * albedo (lit by the room light in the shader), A the coverage. The hole cores
 * are near-black with high alpha, so over passthrough they darken the real
 * wall by the room's own light (research-look §2 "Compositing").
 *
 * Cell space: u, v in [−1, 1] with the decal's half size at r = 1. Everything
 * fades to zero alpha before r = 0.97, and each cell keeps a 3-pixel empty
 * gutter, so mipmaps never bleed one cell into the next.
 *
 * Built once at load (about 130 k pixel evaluations, tens of ms), before the
 * warm-up uploads it.
 */

import { ATLAS_COLS, ATLAS_ROWS, CELL } from './impactTable.js';

export const ATLAS_CELL_PX = 128;

/** Integer hash → [0, 1). @param {number} x @param {number} y @param {number} s */
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise. @param {number} x @param {number} y @param {number} s */
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Two-octave fractal noise in [0, 1). @param {number} x @param {number} y @param {number} s */
function fbm(x, y, s) {
  return (vnoise(x, y, s) * 0.65 + vnoise(x * 2.03, y * 2.03, s + 17) * 0.35);
}

/** @param {number} a @param {number} b @param {number} x */
function sstep(a, b, x) {
  const t = (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Angular noise round the centre (seamless in the angle). @param {number} ang @param {number} k @param {number} s */
function ring(ang, k, s) {
  return fbm(Math.cos(ang) * k + 5, Math.sin(ang) * k + 5, s);
}

/**
 * Composite a layer over the current pixel (straight colour).
 * @param {Float64Array} p [r, g, b, a] @param {number} r @param {number} g @param {number} b @param {number} a
 */
function over(p, r, g, b, a) {
  if (!(a > 0)) return;
  const k = a > 1 ? 1 : a;
  const na = k + p[3] * (1 - k);
  if (na <= 0) return;
  p[0] = (r * k + p[0] * p[3] * (1 - k)) / na;
  p[1] = (g * k + p[1] * p[3] * (1 - k)) / na;
  p[2] = (b * k + p[2] * p[3] * (1 - k)) / na;
  p[3] = na;
}

/**
 * Plaster: a dark hole, exposed gypsum and torn paper round it, a fine dust halo.
 * @param {number} u @param {number} v @param {number} s seed @param {boolean} big @param {Float64Array} p
 */
function plaster(u, v, s, big, p) {
  const r = Math.hypot(u, v), ang = Math.atan2(v, u);
  const hole = (big ? 0.17 : 0.13) * (0.85 + 0.35 * ring(ang, 2.5, s));
  const crater = (big ? 0.5 : 0.38) * (0.7 + 0.6 * ring(ang, 3.2, s + 3));
  // dust halo: speckles fading out
  const speck = fbm(u * 22, v * 22, s + 7);
  const halo = 0.32 * Math.pow(Math.max(0, 1 - r / 0.95), 1.6) * sstep(0.45, 0.8, speck);
  over(p, 0.9, 0.89, 0.86, halo);
  // torn paper flaps at the crater edge
  const flap = (1 - sstep(crater * 0.92, crater * 1.08, r)) * sstep(0.35, 0.6, fbm(u * 9, v * 9, s + 11));
  over(p, 0.97, 0.96, 0.94, flap * 0.85);
  // exposed gypsum (rough, a little grey) inside the crater
  const gyp = 1 - sstep(crater * 0.8, crater * 0.95, r);
  const shade = 0.78 + 0.16 * fbm(u * 14, v * 14, s + 13);
  over(p, shade, shade * 0.985, shade * 0.95, gyp * 0.9);
  // radial hairline cracks (variant B)
  if (big) {
    const n = 7, a = ((ang / (Math.PI * 2)) * n + 0.5 * hash(3, 9, s)) % 1;
    const line = Math.max(0, 1 - Math.abs(a - 0.5) * n * 9 / (r + 0.2));
    const len = 0.45 + 0.4 * hash(Math.floor((ang / (Math.PI * 2)) * n + 7), 1, s);
    over(p, 0.25, 0.24, 0.23, line * (1 - sstep(len * 0.7, len, r)) * sstep(hole, hole * 1.4, r) * 0.6);
  }
  // the hole: dark, with a grey inner wall
  const core = 1 - sstep(hole * 0.75, hole, r);
  over(p, 0.18, 0.17, 0.16, (1 - sstep(hole, hole * 1.25, r)) * 0.7);
  over(p, 0.025, 0.023, 0.02, core * 0.98);
}

/**
 * Wood: a splintered hole, raw wood slivers along the grain, a faint brown dust.
 * @param {number} u @param {number} v @param {number} s @param {number} grain grain angle @param {Float64Array} p
 */
function wood(u, v, s, grain, p) {
  const c = Math.cos(grain), sn = Math.sin(grain);
  const gu = u * c + v * sn, gv = -u * sn + v * c; // grain along gu
  const r = Math.hypot(u, v), ang = Math.atan2(v, u);
  const hole = 0.17 * (0.85 + 0.3 * ring(ang, 2.2, s));
  const dust = 0.22 * Math.pow(Math.max(0, 1 - r / 0.8), 1.5) * sstep(0.4, 0.75, fbm(u * 18, v * 18, s + 5));
  over(p, 0.5, 0.39, 0.27, dust);
  // raw wood torn up along the grain: a lens, long along gu, ragged
  const lens = Math.hypot(gu / 0.62, gv / 0.2) * (0.8 + 0.4 * fbm(gu * 8, gv * 30, s + 2));
  const raw = 1 - sstep(0.75, 1.0, lens);
  const fib = 0.82 + 0.18 * fbm(gu * 3, gv * 60, s + 9);
  over(p, 0.8 * fib, 0.64 * fib, 0.44 * fib, raw * 0.92);
  // slivers sticking out past the lens
  const sl = sstep(0.62, 0.8, fbm(gu * 2.5, gv * 26, s + 21)) * (1 - sstep(0.55, 0.85, Math.abs(gu))) * (1 - sstep(0.1, 0.32, Math.abs(gv)));
  over(p, 0.74, 0.58, 0.39, sl * 0.85);
  // dark split along the grain through the hole
  const split = (1 - sstep(0.008, 0.03, Math.abs(gv + 0.02 * (fbm(gu * 6, 1, s) - 0.5)))) * (1 - sstep(0.3, 0.5, Math.abs(gu)));
  over(p, 0.12, 0.08, 0.05, split * 0.8);
  over(p, 0.2, 0.14, 0.09, (1 - sstep(hole, hole * 1.3, r)) * 0.7);
  over(p, 0.03, 0.022, 0.015, (1 - sstep(hole * 0.75, hole, r)) * 0.98);
}

/**
 * Fabric: a small dark tear with frayed fibres and stuffing showing, no ring.
 * @param {number} u @param {number} v @param {number} s @param {boolean} long @param {Float64Array} p
 */
function fabric(u, v, s, long, p) {
  const r = Math.hypot(u * (long ? 0.7 : 1), v), ang = Math.atan2(v, u);
  const tear = 0.36 * (0.75 + 0.5 * ring(ang, 3, s));
  // frayed fibres: thin radial strands just outside the tear
  const n = 23, a = ((ang / (Math.PI * 2)) * n) % 1;
  const strand = Math.max(0, 1 - Math.abs(a - 0.5) * 8) * (1 - sstep(tear, tear * (1.35 + 0.4 * hash(Math.floor((ang / (Math.PI * 2)) * n + 50), 2, s)), r));
  over(p, 0.36, 0.34, 0.31, strand * 0.55);
  // a slight darkening of the cloth round the hole (soot, compressed weave)
  over(p, 0.2, 0.19, 0.18, 0.28 * (1 - sstep(tear, tear * 1.9, r)));
  // stuffing / foam inside the tear
  // a few flecks of stuffing / foam showing in the tear, off centre
  const stuff = sstep(tear * 0.25, tear * 0.4, r) * (1 - sstep(tear * 0.55, tear * 0.7, r)) * sstep(0.6, 0.75, fbm(u * 16, v * 16, s + 4));
  over(p, 0.8, 0.78, 0.7, stuff * 0.75);
  // the dark hole between
  const holeA = (1 - sstep(tear * 0.8, tear, r)) * (1 - stuff * 0.85);
  over(p, 0.03, 0.028, 0.026, holeA * 0.96);
}

/**
 * Metal: a punched hole with a bright bare-metal ring and a dark scorch.
 * @param {number} u @param {number} v @param {number} s @param {Float64Array} p
 */
function metal(u, v, s, p) {
  const r = Math.hypot(u, v), ang = Math.atan2(v, u);
  const hole = 0.21 * (0.92 + 0.15 * ring(ang, 2, s));
  const scorch = 0.42 * (1 - sstep(hole * 1.4, 0.75 * (0.8 + 0.4 * ring(ang, 2.6, s + 2)), r));
  over(p, 0.12, 0.115, 0.11, scorch);
  // bare metal ring where the paint flaked off
  const ringR = hole * (1.45 + 0.35 * ring(ang, 4, s + 5));
  const bare = (1 - sstep(ringR * 0.92, ringR, r)) * sstep(hole * 0.95, hole * 1.05, r);
  const sh = 0.78 + 0.2 * fbm(u * 20, v * 20, s + 8);
  over(p, sh, sh, sh * 1.02, bare * 0.92);
  // the petals of the punched hole
  over(p, 0.35, 0.35, 0.36, (1 - sstep(hole, hole * 1.12, r)) * 0.8);
  over(p, 0.02, 0.02, 0.022, (1 - sstep(hole * 0.78, hole * 0.95, r)) * 0.98);
}

/**
 * Glass: a star crack: a tiny hole, a frosted crush ring, radial cracks and
 * two broken concentric arcs (thin, light, lit by the room).
 * @param {number} u @param {number} v @param {number} s @param {Float64Array} p
 */
function glass(u, v, s, p) {
  const r = Math.hypot(u, v), ang = Math.atan2(v, u);
  const n = 11;
  const fa = (ang / (Math.PI * 2) + 1) * n;
  const k = Math.floor(fa);
  // each radial crack has its own angle jitter and length
  let best = 1;
  for (let j = -1; j <= 1; j++) {
    const kk = k + j;
    const ca = (kk + 0.5 + (hash(kk & 1023, 3, s) - 0.5) * 0.7) / n * Math.PI * 2;
    const len = 0.45 + 0.5 * hash(kk & 1023, 4, s);
    // distance from the crack ray (perpendicular), only along its length
    const along = u * Math.cos(ca) + v * Math.sin(ca);
    const perp = Math.abs(-u * Math.sin(ca) + v * Math.cos(ca));
    if (along > 0 && along < len) {
      const w = 0.006 + 0.012 * (1 - along / len);
      const d = perp / w;
      if (d < best) best = d;
    }
  }
  const crack = Math.max(0, 1 - best) * sstep(0.06, 0.1, r);
  // concentric arcs, broken
  let arcs = 0;
  for (let i = 0; i < 2; i++) {
    const R = i === 0 ? 0.3 : 0.58;
    const on = sstep(0.45, 0.6, fbm(Math.cos(ang) * 3 + i * 7, Math.sin(ang) * 3, s + 30 + i));
    arcs = Math.max(arcs, Math.max(0, 1 - Math.abs(r - R * (0.95 + 0.1 * ring(ang, 3, s + i))) / 0.008) * on);
  }
  over(p, 0.95, 0.96, 0.97, Math.max(crack, arcs) * 0.8);
  // frosted crush ring
  const crush = (1 - sstep(0.1, 0.16, r * (0.9 + 0.2 * ring(ang, 5, s + 9))));
  over(p, 0.9, 0.92, 0.93, crush * 0.75);
  over(p, 0.05, 0.05, 0.055, (1 - sstep(0.035, 0.05, r)) * 0.95);
}

/**
 * Draw the atlas.
 * @param {number} [cellPx] cell size (default 128)
 * @returns {{ width: number, height: number, cell: number, data: Uint8Array }}
 */
export function makeDecalAtlas(cellPx = ATLAS_CELL_PX) {
  const W = cellPx * ATLAS_COLS, H = cellPx * ATLAS_ROWS;
  const data = new Uint8Array(W * H * 4);
  const p = new Float64Array(4);
  const gutter = 3;
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const cx = (cell % ATLAS_COLS) * cellPx, cy = Math.floor(cell / ATLAS_COLS) * cellPx;
    for (let y = gutter; y < cellPx - gutter; y++) {
      for (let x = gutter; x < cellPx - gutter; x++) {
        const u = ((x + 0.5) / cellPx) * 2 - 1, v = ((y + 0.5) / cellPx) * 2 - 1;
        if (u * u + v * v >= 0.97 * 0.97) continue;
        p[0] = p[1] = p[2] = p[3] = 0;
        switch (cell) {
          case CELL.PLASTER_A: plaster(u, v, 11, false, p); break;
          case CELL.PLASTER_B: plaster(u, v, 23, true, p); break;
          case CELL.WOOD_A: wood(u, v, 31, 0.15, p); break;
          case CELL.WOOD_B: wood(u, v, 47, -0.25, p); break;
          case CELL.FABRIC_A: fabric(u, v, 53, false, p); break;
          case CELL.FABRIC_B: fabric(u, v, 67, true, p); break;
          case CELL.METAL: metal(u, v, 71, p); break;
          default: glass(u, v, 89, p); break;
        }
        // fade the outer rim so nothing reaches the cell edge
        const r = Math.sqrt(u * u + v * v);
        const a = p[3] * (1 - sstep(0.88, 0.97, r));
        const o = ((cy + y) * W + cx + x) * 4;
        data[o] = Math.round(Math.min(1, p[0]) * a * 255);
        data[o + 1] = Math.round(Math.min(1, p[1]) * a * 255);
        data[o + 2] = Math.round(Math.min(1, p[2]) * a * 255);
        data[o + 3] = Math.round(a * 255);
      }
    }
  }
  return { width: W, height: H, cell: cellPx, data };
}
