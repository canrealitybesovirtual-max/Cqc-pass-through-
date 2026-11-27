// @ts-check
import * as THREE from 'three';
import { FACE, PATCH, patchUV, READ, READ_REGIONS } from './watchArt.js';

/**
 * Geometry for the wrist watch (built once at load; nothing here runs per
 * frame). Watch-local frame: +X = 3 o'clock, +Y = 12, +Z out of the dial,
 * origin at the dial centre, metres at scale 1 (41.6 mm case, 30 mm dial).
 *
 * Four meshes, one draw each:
 * - `steel`: case, bezel, coin edge, lugs, crown and guards, centre pin and
 *   (optionally) the bracelet, merged, with a brightness vertex colour
 *   (polished 1.0, brushed 0.82) for a matcap material;
 * - `face`: dial disc + bezel insert ring + all three hands, merged, with an
 *   `aPart` attribute (0 static, 1 bezel, 2 hour, 3 minute, 4 second) that a
 *   vertex hook rotates by uniform angles (no buffer uploads while running);
 * - `readouts`: five quads mapped into the readout atlas (windows and lines);
 * - `glass`: the flat crystal and the cyclops magnifier.
 */

const MM = 0.001;
const POLISHED = 1.0;
const BRUSHED = 0.82;

/**
 * @typedef {{ geo: THREE.BufferGeometry, tone?: number, part?: number, uv?: number[] }} Piece
 */

/**
 * Merge pieces into one non-indexed geometry.
 * @param {Piece[]} pieces
 * @param {{ normal?: boolean, color?: boolean, uv?: boolean, part?: boolean }} want
 */
export function mergePieces(pieces, want) {
  let n = 0;
  /** @type {THREE.BufferGeometry[]} */
  const flat = [];
  for (const p of pieces) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (want.normal && !g.getAttribute('normal')) g.computeVertexNormals();
    flat.push(g);
    n += g.getAttribute('position').count;
  }
  const pos = new Float32Array(n * 3);
  const nor = want.normal ? new Float32Array(n * 3) : null;
  const col = want.color ? new Float32Array(n * 3) : null;
  const uv = want.uv ? new Float32Array(n * 2) : null;
  const part = want.part ? new Float32Array(n) : null;
  let o = 0;
  for (let i = 0; i < flat.length; i++) {
    const g = flat[i], p = pieces[i];
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), U = g.getAttribute('uv');
    const c = P.count;
    for (let k = 0; k < c; k++) {
      const j = o + k;
      pos[j * 3] = P.getX(k); pos[j * 3 + 1] = P.getY(k); pos[j * 3 + 2] = P.getZ(k);
      if (nor && N) { nor[j * 3] = N.getX(k); nor[j * 3 + 1] = N.getY(k); nor[j * 3 + 2] = N.getZ(k); }
      if (col) { const t = p.tone ?? 1; col[j * 3] = col[j * 3 + 1] = col[j * 3 + 2] = t; }
      if (uv) {
        if (p.uv) { uv[j * 2] = p.uv[0]; uv[j * 2 + 1] = p.uv[1]; } else if (U) { uv[j * 2] = U.getX(k); uv[j * 2 + 1] = U.getY(k); }
      }
      if (part) part[j] = p.part ?? 0;
    }
    o += c;
    if (g !== p.geo) g.dispose();
    p.geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (part) out.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * @param {THREE.BufferGeometry} g
 * @param {number} x @param {number} y @param {number} z
 * @param {number} [rx] @param {number} [ry] @param {number} [rz]
 * @param {number} [sx] @param {number} [sy] @param {number} [sz]
 */
function place(g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}

/**
 * A lathe around +Z from an (r, z) profile.
 * @param {number[][]} prof @param {number} seg
 */
function lathe(prof, seg) {
  const pts = prof.map(([r, z]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Steel: case, bezel and its coin edge, lugs, crown with guards, centre pin, bracelet.
 * @param {{ bracelet?: boolean }} [o]
 */
export function buildSteel({ bracelet = true } = {}) {
  /** @type {Piece[]} */
  const P = [];
  // case: flat back, rounded flank, top shoulder under the bezel
  P.push({ geo: lathe([[0.0002, -0.0064], [0.0178, -0.0064], [0.0192, -0.0061], [0.0203, -0.0053], [0.0208, -0.0042],
    [0.0208, -0.0006], [0.0205, 0.0004]], 72), tone: BRUSHED });
  // inner flange from the dial up to the insert
  P.push({ geo: lathe([[0.0150, -0.0001], [0.0153, 0.0006], [0.0156, 0.0029], [0.0158, 0.0034]], 72), tone: POLISHED });
  // outer bezel edge
  P.push({ geo: lathe([[0.0200, 0.0035], [0.0205, 0.0038], [0.0209, 0.0034], [0.0210, 0.0013], [0.0207, 0.0007], [0.0203, 0.0004]], 96), tone: POLISHED });
  // coin edge: 120 flutes
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    P.push({ geo: place(new THREE.BoxGeometry(0.00052, 0.0006, 0.0020), Math.cos(a) * 0.02105, Math.sin(a) * 0.02105, 0.0023, 0, 0, a), tone: BRUSHED });
  }
  // lugs (tips curve down toward the wrist)
  for (const sy of [1, -1]) {
    for (const sx of [1, -1]) {
      P.push({ geo: place(new THREE.BoxGeometry(0.0034, 0.0072, 0.0040), sx * 0.0119, sy * 0.0226, -0.0035, -sy * 0.2, 0, 0), tone: BRUSHED });
      // polished bevel on the lug's outer top edge
      P.push({ geo: place(new THREE.BoxGeometry(0.0009, 0.0070, 0.0008), sx * 0.0134, sy * 0.0226, -0.0013, -sy * 0.2, 0, 0), tone: POLISHED });
    }
  }
  // crown at 3 o'clock with flutes, its tube, and the crown guards
  P.push({ geo: place(new THREE.CylinderGeometry(0.0018, 0.0018, 0.0012, 16), 0.0212, 0, -0.0027, 0, 0, -Math.PI / 2), tone: POLISHED });
  P.push({ geo: place(new THREE.CylinderGeometry(0.0029, 0.0029, 0.0032, 32), 0.0234, 0, -0.0027, 0, 0, -Math.PI / 2), tone: POLISHED });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    P.push({ geo: place(new THREE.BoxGeometry(0.0028, 0.0005, 0.0005), 0.0234, Math.cos(a) * 0.0030, -0.0027 + Math.sin(a) * 0.0030, a, 0, 0), tone: BRUSHED });
  }
  P.push({ geo: place(new THREE.CylinderGeometry(0.0029, 0.0029, 0.0004, 32), 0.0252, 0, -0.0027, 0, 0, -Math.PI / 2), tone: POLISHED });
  for (const sy of [1, -1]) {
    P.push({ geo: place(new THREE.BoxGeometry(0.0030, 0.0026, 0.0042), 0.0218, sy * 0.0044, -0.0028, 0, 0, sy * 0.15), tone: BRUSHED });
  }
  // centre pin over the hands
  P.push({ geo: place(new THREE.CylinderGeometry(0.0007, 0.0007, 0.0004, 16), 0, 0, 0.00095, Math.PI / 2, 0, 0), tone: POLISHED });
  if (bracelet) braceletPieces(P);
  const g = mergePieces(P, { normal: true, color: true });
  g.name = 'watch-steel';
  return g;
}

/**
 * Three-piece links (brushed outer, polished centre) curling down round the
 * wrist from each pair of lugs, five links a side, ending at the wrist's sides.
 * @param {Piece[]} P
 */
function braceletPieces(P) {
  const pitch = 0.0072, len = pitch - 0.0005, thick = 0.0026;
  for (const side of [1, -1]) {
    let y = 0.0262, z = -0.0049;
    for (let i = 0; i < 5; i++) {
      const beta = (20 + 17 * i) * (Math.PI / 180);
      const dy = Math.cos(beta) * side, dz = -Math.sin(beta);
      const cy = y + dy * pitch * 0.5, cz = z + dz * pitch * 0.5;
      const rx = side * -beta;
      P.push({ geo: place(new THREE.BoxGeometry(0.0064, len, thick), 0.0067, cy, cz, rx, 0, 0), tone: BRUSHED });
      P.push({ geo: place(new THREE.BoxGeometry(0.0064, len, thick), -0.0067, cy, cz, rx, 0, 0), tone: BRUSHED });
      P.push({ geo: place(new THREE.BoxGeometry(0.0066, len * 0.96, thick * 1.08), 0, cy, cz, rx, 0, 0), tone: POLISHED });
      y += dy * pitch;
      z += dz * pitch;
    }
  }
}

/**
 * Dial + bezel insert + hands (one draw). UVs point into the face atlas.
 */
export function buildFace() {
  /** @type {Piece[]} */
  const P = [];
  const dialR = 0.0150;
  const dial = new THREE.CircleGeometry(dialR, 96);
  remapUV(dial, (x, y, out) => { out[0] = (x / dialR + 1) / 4; out[1] = (y / dialR + 1) / 2; });
  P.push({ geo: dial, part: 0 });
  const ro = FACE.bezelOuter, ri = FACE.bezelInner;
  const ring = new THREE.RingGeometry(ri, ro, 120, 1);
  remapUV(ring, (x, y, out) => { out[0] = 0.5 + (x / ro + 1) / 4; out[1] = (y / ro + 1) / 2; });
  ring.translate(0, 0, 0.0034);
  P.push({ geo: ring, part: 1 });
  handPieces(P);
  const g = mergePieces(P, { uv: true, part: true });
  g.name = 'watch-face';
  return g;
}

/**
 * @param {THREE.BufferGeometry} g
 * @param {(x: number, y: number, out: number[]) => void} f
 */
function remapUV(g, f) {
  const P = g.getAttribute('position'), U = g.getAttribute('uv');
  const o = [0, 0];
  for (let i = 0; i < P.count; i++) { f(P.getX(i), P.getY(i), o); U.setXY(i, o[0], o[1]); }
}

/**
 * Hands in mm, pointing +Y: hour (baton + ring with a lume disc and three
 * spokes + tip), minute (sword with a lume inlay), seconds (needle, lume dot,
 * counterweight). Polished steel edges, lume fills.
 * @param {Piece[]} P
 */
function handPieces(P) {
  const lume = patchUV(PATCH.lume, [0, 0]), steel = patchUV(PATCH.steel, [0, 0]), dark = patchUV(PATCH.dark, [0, 0]);
  /** @param {number[][]} pts mm @param {number} z m @param {number[]} uv @param {number} part */
  const poly = (pts, z, uv, part) => {
    const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x * MM, y * MM)));
    const g = new THREE.ShapeGeometry(s);
    g.translate(0, 0, z);
    P.push({ geo: g, uv, part });
  };
  /** @param {number} r mm @param {number} x @param {number} y @param {number} z @param {number[]} uv @param {number} part */
  const disc = (r, x, y, z, uv, part) => {
    const g = new THREE.CircleGeometry(r * MM, 24);
    g.translate(x * MM, y * MM, z);
    P.push({ geo: g, uv, part });
  };
  /** @param {number} r0 @param {number} r1 @param {number} x @param {number} y @param {number} z @param {number[]} uv @param {number} part */
  const ring = (r0, r1, x, y, z, uv, part) => {
    const g = new THREE.RingGeometry(r0 * MM, r1 * MM, 28, 1);
    g.translate(x * MM, y * MM, z);
    P.push({ geo: g, uv, part });
  };
  // hour (part 2)
  const H = 2, zh = 0.00030;
  poly([[-0.75, -1.8], [0.75, -1.8], [0.75, 4.6], [-0.75, 4.6]], zh, steel, H);
  poly([[-0.42, 0.4], [0.42, 0.4], [0.42, 4.3], [-0.42, 4.3]], zh + 0.00002, lume, H);
  ring(1.25, 2.05, 0, 6.4, zh, steel, H);
  disc(1.28, 0, 6.4, zh + 0.00001, lume, H);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
    const w = 0.17, L = 1.3;
    // a thin bar from the ring centre outward (rotated rectangle)
    const pts = [[-w, 0], [w, 0], [w, L], [-w, L]].map(([x, y]) => [x * c + y * s, -x * s + y * c + 6.4]);
    poly(pts, zh + 0.00003, steel, H);
  }
  poly([[-0.55, 8.2], [0.55, 8.2], [0.82, 8.5], [0, 10.0], [-0.82, 8.5]], zh, steel, H);
  // minute (part 3)
  const Mi = 3, zm = 0.00050;
  poly([[-0.55, -2.6], [0.55, -2.6], [0.66, 10.8], [0, 12.7], [-0.66, 10.8]], zm, steel, Mi);
  poly([[-0.3, 1.0], [0.3, 1.0], [0.38, 10.6], [0, 11.9], [-0.38, 10.6]], zm + 0.00002, lume, Mi);
  // seconds (part 4)
  const S = 4, zs = 0.00070;
  poly([[-0.17, -3.9], [0.17, -3.9], [0.13, 13.6], [-0.13, 13.6]], zs, steel, S);
  disc(1.0, 0, 9.6, zs, steel, S);
  disc(0.74, 0, 9.6, zs + 0.00002, lume, S);
  disc(0.85, 0, -2.6, zs, steel, S);
  disc(0.55, 0, -2.6, zs + 0.00002, dark, S);
}

/** The five readout quads (transparent, above the dial, under the hands). */
export function buildReadouts() {
  /** @type {Piece[]} */
  const P = [];
  for (const k of READ_REGIONS) {
    const R = /** @type {{ x: number, y: number, w: number, h: number, cx: number, cy: number }} */ (/** @type {any} */ (READ)[k]);
    const g = new THREE.PlaneGeometry((R.w / READ.px) * MM, (R.h / READ.px) * MM);
    remapUV(g, (x, y, out) => {
      const u = x / ((R.w / READ.px) * MM) + 0.5, v = y / ((R.h / READ.px) * MM) + 0.5;
      out[0] = (R.x + u * R.w) / READ.w;
      out[1] = 1 - (R.y + (1 - v) * R.h) / READ.h;
    });
    g.translate(R.cx * MM, R.cy * MM, 0.00012);
    P.push({ geo: g });
  }
  const g = mergePieces(P, { uv: true });
  g.name = 'watch-readouts';
  return g;
}

/** Flat crystal + cyclops (reflections only, drawn additively). */
export function buildGlass() {
  /** @type {Piece[]} */
  const P = [];
  const crystal = new THREE.CircleGeometry(0.0157, 72);
  crystal.translate(0, 0, 0.0031);
  P.push({ geo: crystal });
  const dome = new THREE.SphereGeometry(1, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  dome.scale(0.0042, 0.0034, 0.0014);
  dome.translate(READ.ammo.cx * MM, 0, 0.0031);
  P.push({ geo: dome });
  const g = mergePieces(P, { normal: true });
  g.name = 'watch-glass';
  return g;
}

/**
 * The menu disc's steel rim (rounded profile) with a brightness colour.
 * @param {number} r inner radius
 */
export function buildMenuRim(r) {
  const g = mergePieces([{ geo: lathe([[r - 0.0004, 0.0001], [r + 0.0012, 0.0026], [r + 0.0045, 0.0030], [r + 0.0062, 0.0008], [r + 0.0060, -0.0004]], 128), tone: POLISHED }],
    { normal: true, color: true });
  g.name = 'watch-menu-rim';
  return g;
}
