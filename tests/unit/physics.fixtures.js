/**
 * Shared fixtures for the physics tests (not a test file itself): item point
 * clouds shaped like the baked GLBs (the vertex profile along the bore, in
 * gun space), the fixture house as a World, its planes-only static geometry,
 * and a synthetic scanned bed (an oriented, lumpy trimesh).
 */
import { readFileSync } from 'node:fs';
import { WorldCore } from '../../src/world/WorldCore.js';
import { staticFromLayout } from '../../src/physics/StaticGeometry.js';
import { itemKinds } from '../../src/physics/ItemShapes.js';

export const HOUSE = JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));
export const MANIFEST = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8'));

/**
 * A point cloud of boxes (a 4 × 4 × 4 grid of points each), like a mesh's vertices.
 * @param {number[][]} boxes [x0, y0, z0, x1, y1, z1]
 */
export function cloud(boxes) {
  const p = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) for (let k = 0; k <= 3; k++) p.push(x0 + (x1 - x0) * i / 3, y0 + (y1 - y0) * j / 3, z0 + (z1 - z0) * k / 3);
  }
  return Float32Array.from(p);
}

/** Gun space, from the baked GLBs' profile (slide, guard, grip / barrel, handguard, receiver, grip, stock). */
export const GLOCK_CLOUD = cloud([[-0.0125, -0.028, -0.116, 0.0125, 0.013, 0.086], [-0.014, -0.058, -0.056, 0.014, -0.02, 0.0], [-0.016, -0.117, 0.01, 0.016, -0.02, 0.086]]);
export const AKM_CLOUD = cloud([[-0.009, -0.017, -0.432, 0.009, 0.053, -0.24], [-0.023, -0.035, -0.24, 0.023, 0.05, 0.06], [-0.03, -0.073, 0.06, 0.025, 0.038, 0.21], [-0.022, -0.141, 0.16, 0.019, -0.06, 0.25], [-0.02, -0.095, 0.26, 0.018, 0.004, 0.457]]);
/** Magazine space (origin at the top). */
export const MAG9_CLOUD = cloud([[-0.011, -0.117, -0.015, 0.011, 0.004, 0.058]]);
export const MAG762_CLOUD = cloud([[-0.015, -0.1, -0.03, 0.015, -0.001, 0.037], [-0.015, -0.2, -0.116, 0.015, -0.09, -0.02]]);

/** The six item kinds (PhysicsWorld.defineKind inputs). */
export function kinds() {
  return itemKinds({
    glock: { gun: GLOCK_CLOUD, mag: MAG9_CLOUD, magSeat: MANIFEST.weapons.glock.magLocalSeat, grip: MANIFEST.weapons.glock.grip.pos },
    akm: { gun: AKM_CLOUD, mag: MAG762_CLOUD, magSeat: MANIFEST.weapons.akm.magLocalSeat, grip: MANIFEST.weapons.akm.grip.pos },
  });
}

/** The fixture house built as a Roam world, player in the living room. */
export function houseWorld() {
  const W = new WorldCore({ roam: true });
  W.build(HOUSE, { x: 0, z: -1 });
  return W;
}

/** Planes-only static geometry of the fixture house (deterministic whatever the world's mesh support). */
export function houseStatics(W = houseWorld()) {
  return staticFromLayout(W.layout, { snapshot: HOUSE });
}

/**
 * A scanned bed over the fixture bed (centre 5.6, −1.1, 2.0 × 1.6 m, top 0.55): an oriented grid
 * (normals to free space) with ±2 cm lumps on top and four sides down to the floor.
 * @param {{ cell?: number, lump?: number, flip?: boolean }} [o]
 */
export function scannedBed({ cell = 0.165, lump = 0.02, flip = false } = {}) {
  const V = [], I = [];
  const cx = 5.6, cz = -1.1, hx = 1.0, hz = 0.8, top = 0.55, y0 = 0.01;
  const surf = (x, z) => top + lump * Math.sin(x * 7.1) * Math.sin(z * 5.3);
  // patch: origin o, axes u (lu), v (lv), height function, wound so (u × v) is the normal
  const patch = (o, u, lu, v, lv, h) => {
    const nu = Math.max(1, Math.round(lu / cell)), nv = Math.max(1, Math.round(lv / cell)), base = V.length / 3;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const a = (i / nu) * lu, b = (j / nv) * lv;
      const x = o[0] + u[0] * a + v[0] * b, z = o[2] + u[2] * a + v[2] * b;
      const y = h ? h(x, z) : o[1] + u[1] * a + v[1] * b;
      V.push(x, y, z);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const k = base + j * (nu + 1) + i, a = k, b = k + 1, c = k + nu + 1, d = k + nu + 2;
      if (!flip) I.push(a, b, c, b, d, c); else I.push(a, c, b, b, c, d);
    }
  };
  // every patch wound so u × v points to free space
  const H = top - y0;
  patch([cx - hx, top, cz - hz], [0, 0, 1], 2 * hz, [1, 0, 0], 2 * hx, surf);   // top: z × x = +y
  patch([cx - hx, y0, cz - hz], [0, 1, 0], H, [1, 0, 0], 2 * hx, null);         // −z side: y × x = −z
  patch([cx - hx, y0, cz + hz], [1, 0, 0], 2 * hx, [0, 1, 0], H, null);         // +z side: x × y = +z
  patch([cx - hx, y0, cz - hz], [0, 0, 1], 2 * hz, [0, 1, 0], H, null);         // −x side: z × y = −x
  patch([cx + hx, y0, cz - hz], [0, 1, 0], H, [0, 0, 1], 2 * hz, null);         // +x side: y × z = +x
  const idx = Uint32Array.from(I);
  return { vertices: Float32Array.from(V), indices: idx, surface: surf, top, cx, cz, hx, hz };
}
