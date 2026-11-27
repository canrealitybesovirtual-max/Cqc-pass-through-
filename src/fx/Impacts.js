// @ts-check
/**
 * Bullet strikes on the real house by material (research-look §4 / R5):
 * a decal from the atlas (plaster, wood, fabric, metal / glass), a small
 * pooled puff (gypsum dust and chips, splinters and wood dust, foam and lint,
 * feathers out of a bed, glints off metal and glass) and the matching sounds
 * from the existing bank (impactTable.js has every number).
 *
 * Two instanced draws, both built and warmed at load:
 * - decals: ONE InstancedMesh of 128 quads (FIFO), the atlas texture (made
 *   procedurally, decalAtlas.js), premultiplied, depthWrite off, polygon
 *   offset and a 4 mm pull toward the eye. RGB is albedo × the shared room
 *   light (`uRoomLight`, RoomLight drives it): the black hole core stays
 *   black, the dust ring and the splinters take the room's level and tint.
 * - particles: ONE InstancedMesh of 160 camera-facing quads, simulated on the
 *   CPU (drag, gravity, flutter, a floor stop), shapes drawn in the shader
 *   (soft blob, chip, sliver, feather, glint); written compactly, only the
 *   live range uploaded. Per-instance data rides in the instance matrix
 *   (centre in column 3; size, rotation, alpha, kind, aspect, seed in the
 *   first two columns), so there is no extra attribute. Uploads are whole
 *   fixed buffers (three's update ranges allocate per call).
 *
 * Program keys are fixed at construction (transparent, premultiplied,
 * instanceColor primed). `impact()` is an event (≤ 10 a second at 600 rpm)
 * and allocation-free, as is `update()`.
 *
 * Wiring: WeaponSystem's world-hit branch calls `impacts.impact(hit, dx, dy,
 * dz, weaponId)` (see Look.js); the integrator removes WeaponFX's own decal
 * and 'impactWall' call there.
 */

import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, IMP, PKIND, PK_COUNT, PV_LEN, RECIPES, impactKind, particleVelocity } from './impactTable.js';
import { makeDecalAtlas } from './decalAtlas.js';

export const IMPACT = Object.freeze({
  decalMax: 128,
  particleMax: 160,
  decalLift: 0.002,      // m off the surface
  decalPull: 0.004,      // m toward the eye (shader)
  floorPad: 0.004,       // m: particles stop this far above the floor or table they fall on
  floorFriction: 0.25,   // horizontal speed kept when landing
  fadeIn: 0.04,          // s
  fadeOut: 0.35,         // fraction of life
  maxDt: 0.05,
});

/** The shared room-light multiplier for unlit effects (sRGB; RoomLight writes it). */
export const uRoomLight = { value: new THREE.Vector3(1, 1, 1) };

const DECAL_VERT = /* glsl */`
uniform float uPull;
varying vec2 vUv;
void main() {
  float cell = 0.0;
  #ifdef USE_INSTANCING_COLOR
  cell = instanceColor.r;
  #endif
  vec2 c = vec2( mod( cell, ${ATLAS_COLS}.0 ), floor( cell / ${ATLAS_COLS}.0 ) );
  vUv = ( c + uv ) / vec2( ${ATLAS_COLS}.0, ${ATLAS_ROWS}.0 );
  vec4 p = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  vec4 mv = modelViewMatrix * p;
  float d = length( mv.xyz );
  mv.xyz *= max( 0.0, 1.0 - uPull / max( d, 0.001 ) );
  gl_Position = projectionMatrix * mv;
}`;

const DECAL_FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform vec3 uRoomLight;
varying vec2 vUv;
void main() {
  vec4 t = texture2D( uAtlas, vUv );
  if ( t.a < 0.01 ) discard;
  gl_FragColor = vec4( t.rgb * uRoomLight, t.a );
}`;

// particle data in the instance matrix (column-major):
//   [0] size  [1] rotation  [2] alpha  [3] kind
//   [4] aspect  [5] seed  [6] age / life  [7] unused
//   [12..14] centre
const PART_VERT = /* glsl */`
varying vec2 vUv;
varying vec4 vD;
void main() {
  mat4 m = mat4( 1.0 );
  #ifdef USE_INSTANCING
  m = instanceMatrix;
  #endif
  float size = m[0][0], rot = m[0][1], aspect = m[1][0];
  vD = vec4( m[0][2], m[0][3], m[1][1], m[1][2] ); // alpha, kind, seed, age
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4( m[3].xyz, 1.0 );
  float cr = cos( rot ), sr = sin( rot );
  vec2 q = position.xy * vec2( aspect, 1.0 ) * size;
  mv.xy += vec2( cr * q.x - sr * q.y, sr * q.x + cr * q.y );
  gl_Position = projectionMatrix * mv;
}`;

// colours (albedo, sRGB) and shapes per kind, from impactTable.PKIND
const kindColours = PKIND.map((k) => `vec3( ${k.rgb.map((v) => v.toFixed(3)).join(', ')} )`);
const PART_FRAG = /* glsl */`
uniform vec3 uRoomLight;
varying vec2 vUv;
varying vec4 vD;
vec3 kindColour( float k ) {
  ${kindColours.map((c, i) => `if ( k < ${i}.5 ) return ${c};`).join('\n  ')}
  return vec3( 1.0 );
}
void main() {
  float k = vD.y, seed = vD.z;
  vec2 p = vUv;
  float r = length( p );
  float a;
  int shape = int( ${PKIND.map((k, i) => `(abs( k - ${i}.0 ) < 0.5 ? ${k.shape}.0 : 0.0)`).join(' + ')} + 0.5 );
  if ( shape == 0 ) {
    // soft lumpy blob
    float ang = atan( p.y, p.x );
    float edge = 0.75 + 0.12 * sin( ang * 5.0 + seed * 6.3 ) + 0.08 * sin( ang * 9.0 + seed * 2.1 );
    float t = max( 0.0, 1.0 - r / edge );
    a = t * t * ( 3.0 - 2.0 * t );
  } else if ( shape == 1 ) {
    // a hard chip: an irregular lump
    float ang = atan( p.y, p.x );
    float edge = 0.72 + 0.14 * sin( ang * 3.0 + seed * 6.3 ) + 0.08 * sin( ang * 5.0 + seed * 11.0 );
    a = 1.0 - smoothstep( edge - 0.12, edge, r );
  } else if ( shape == 2 ) {
    // a sliver: long, tapered
    float w = 0.55 * ( 1.0 - abs( p.x ) );
    a = ( 1.0 - smoothstep( w - 0.2, w, abs( p.y ) ) ) * ( 1.0 - smoothstep( 0.85, 1.0, abs( p.x ) ) );
  } else if ( shape == 3 ) {
    // a feather: a shaft and a soft vane
    float vane = ( 1.0 - smoothstep( 0.35, 0.9, abs( p.y ) / ( 1.0 - p.x * p.x + 0.05 ) ) ) * ( 1.0 - smoothstep( 0.8, 1.0, abs( p.x ) ) );
    float shaft = 1.0 - smoothstep( 0.03, 0.09, abs( p.y ) );
    a = max( vane * 0.75, shaft * ( 1.0 - smoothstep( 0.9, 1.0, abs( p.x ) ) ) );
  } else {
    // a glint: a small four-point star
    float s = max( 1.0 - smoothstep( 0.0, 0.12, abs( p.x ) ) - r * 0.9, 1.0 - smoothstep( 0.0, 0.12, abs( p.y ) ) - r * 0.9 );
    a = max( s, 1.0 - smoothstep( 0.0, 0.35, r ) );
  }
  a *= vD.x;
  if ( a < 0.01 ) discard;
  vec3 c = kindColour( k ) * uRoomLight;
  gl_FragColor = vec4( min( c, vec3( 1.0 ) ) * a, a );
}`;

export class Impacts {
  /**
   * @param {THREE.Object3D} parent the scene
   * @param {{ atlas?: { width: number, height: number, data: Uint8Array } | null, decalMax?: number, particleMax?: number, seed?: number }} [o]
   *   atlas: a prebuilt atlas (e.g. made in a worker); else drawn here (tens of ms, at load)
   */
  constructor(parent, o = {}) {
    const A = o.atlas || makeDecalAtlas();
    this.atlas = new THREE.DataTexture(A.data, A.width, A.height, THREE.RGBAFormat);
    this.atlas.colorSpace = THREE.NoColorSpace; // the shader writes output values directly
    this.atlas.generateMipmaps = true;
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    this.atlas.premultiplyAlpha = false; // already premultiplied
    this.atlas.flipY = false;
    this.atlas.needsUpdate = true;
    this.atlas.name = 'fx-decal-atlas';

    // ── decals
    const dmax = this.decalMax = o.decalMax ?? IMPACT.decalMax;
    this.decalMat = new THREE.ShaderMaterial({
      name: 'fx-decal',
      vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG,
      uniforms: { uAtlas: { value: this.atlas }, uRoomLight, uPull: { value: IMPACT.decalPull } },
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.decalMat, dmax);
    this.decals.name = 'fx-decals';
    this.decals.setColorAt(0, new THREE.Color(0, 0, 0));
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 2;
    this.decals.count = 0;
    this.decals.visible = false;
    // every slot starts as a zero matrix (nothing drawn until written)
    this.decals.instanceMatrix.array.fill(0);
    parent.add(this.decals);
    this.decalNext = 0;
    this.decalCount = 0;

    // ── particles
    const pmax = this.particleMax = o.particleMax ?? IMPACT.particleMax;
    this.partMat = new THREE.ShaderMaterial({
      name: 'fx-impact-particles',
      vertexShader: PART_VERT, fragmentShader: PART_FRAG,
      uniforms: { uRoomLight },
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.parts = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.partMat, pmax);
    this.parts.name = 'fx-impact-particles';
    this.parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.parts.frustumCulled = false;
    this.parts.renderOrder = 3;
    this.parts.count = 0;
    this.parts.visible = false;
    parent.add(this.parts);
    // per particle (SoA)
    this.age = new Float64Array(pmax).fill(1e9);
    this.life = new Float64Array(pmax).fill(1);
    this.px = new Float64Array(pmax); this.py = new Float64Array(pmax); this.pz = new Float64Array(pmax);
    this.vx = new Float64Array(pmax); this.vy = new Float64Array(pmax); this.vz = new Float64Array(pmax);
    this.size = new Float64Array(pmax); this.rot = new Float64Array(pmax); this.spin = new Float64Array(pmax);
    this.floor = new Float64Array(pmax);
    this.kind = new Uint8Array(pmax);
    this.seed = new Float64Array(pmax);
    this.landed = new Uint8Array(pmax);
    this.live = 0;
    this.partNext = 0;

    /** Floor material for floor hits ('wood' | 'carpet' | 'tile'): a per-house setting. */
    this.floorKind = 'wood';
    /** @type {any} */ this.world = null;
    /** @type {any} */ this.audio = null;
    /** Eye (world): particles that would spawn right in the face are skipped. */
    this.eye = new Float64Array([0, 1.6, 0]);
    this.rng = new Uint32Array([o.seed ?? 0x9e3779b9]);
    /** Random numbers for one impact (roll()): no double is returned from a call. */
    this.R = new Float64Array(64);
    this.ri = 0;
    /** The strike: x, y, z, nx, ny, nz, dx, dy, dz, floor y. */
    this.H = new Float64Array(10);
    /** One particle to spawn: x, y, z, vx, vy, vz, floor y, delay. */
    this.S = new Float64Array(8);
    this._pv = new Float64Array(PV_LEN);
    this._v = new Float64Array(3);
    /** Impacts per kind (IMP order) and totals. */
    this.counts = new Uint32Array(RECIPES.length);
    this.stats = { impacts: 0, decals: 0, particles: 0, sounds: 0, maxLive: 0 };
  }

  /** Refill R with uniforms in [0, 1) (xorshift32) and restart the cursor. */
  roll() {
    const st = this.rng, R = this.R;
    let x = st[0];
    for (let i = 0; i < R.length; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      R[i] = x / 4294967296;
    }
    st[0] = x;
    this.ri = 0;
  }

  /** The cursor of the next random number in R (refilled when used up). */
  r() {
    if (this.ri >= this.R.length) this.roll();
    return this.ri++;
  }

  /**
   * A round struck the world. `hit` is the CONTRACTS hit record (x, y, z,
   * nx, ny, nz, surface); (dx, dy, dz) the bullet's travel.
   * @param {{ x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string }} hit
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {string} [weapon] 'glock' | 'akm'
   * @returns {number} the impact kind (IMP.*), or −1 (bad input)
   */
  impact(hit, dx, dy, dz, weapon = 'glock') {
    const H = this.H;
    H[0] = hit.x; H[1] = hit.y; H[2] = hit.z;
    if (!Number.isFinite(H[0] + H[1] + H[2])) return -1;
    H[6] = dx; H[7] = dy; H[8] = dz;
    H[3] = hit.nx; H[4] = hit.ny; H[5] = hit.nz;
    const kind = impactKind(hit.surface || '', this.floorKind);
    this.strike(kind, weapon === 'akm');
    if (this.audio) {
      const R = RECIPES[kind];
      for (let i = 0; i < R.sounds.length; i++) {
        const snd = R.sounds[i];
        if (this.audio.play(snd[0], H[0], H[1], H[2], snd[1], snd[2]) >= 0) this.stats.sounds++;
      }
    }
    return kind;
  }

  /**
   * Normalise the strike in H, then the decal and the burst.
   * @param {number} kind IMP.* @param {boolean} rifle
   */
  strike(kind, rifle) {
    const H = this.H;
    let nx = H[3], ny = H[4], nz = H[5], dx = H[6], dy = H[7], dz = H[8];
    let dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dl > 1e-6)) { dx = -nx; dy = -ny; dz = -nz; dl = Math.sqrt(dx * dx + dy * dy + dz * dz); if (!(dl > 1e-6)) { dx = 0; dy = 0; dz = -1; dl = 1; } }
    dx /= dl; dy /= dl; dz /= dl;
    let l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 1e-6)) { nx = -dx; ny = -dy; nz = -dz; l = 1; }
    nx /= l; ny /= l; nz /= l;
    // the normal faces the shooter
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    H[3] = nx; H[4] = ny; H[5] = nz; H[6] = dx; H[7] = dy; H[8] = dz;
    // what the bits fall onto: the hit surface when it faces up (a table top), else the floor below
    let fy = this.world && typeof this.world.floorY === 'function' ? this.world.floorY(H[0], H[2]) : H[1] - 1.5;
    if (!Number.isFinite(fy) || fy > H[1]) fy = H[1] - 1.5;
    if (ny > 0.7) fy = H[1];
    H[9] = fy;
    const R = RECIPES[kind];
    this.counts[kind]++;
    this.stats.impacts++;
    this.roll();
    this.decal(R);
    this.burst(R, rifle);
  }

  /**
   * One decal in the FIFO ring at the strike in H, lying in the surface (random roll).
   * @param {import('./impactTable.js').Recipe} R
   */
  decal(R) {
    const H = this.H, U = this.R;
    const i = this.decalNext;
    this.decalNext = (i + 1) % this.decalMax;
    if (this.decalCount < this.decalMax) this.decalCount++;
    const size = R.size0 + (R.size1 - R.size0) * U[this.r()];
    const cell = R.cells[(U[this.r()] * R.cells.length) | 0];
    const nx = H[3], ny = H[4], nz = H[5];
    // basis: Z = normal (the plane's face), X / Y in the plane, rolled at random
    let xx, xy, xz;
    if (Math.abs(ny) < 0.9) { xx = nz; xy = 0; xz = -nx; } else { xx = 0; xy = -nz; xz = ny; } // up × n, or x × n
    const xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = ny * xz - nz * xy, yy = nz * xx - nx * xz, yz = nx * xy - ny * xx;
    const a = U[this.r()] * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const M = this.decals.instanceMatrix.array, o = i * 16;
    M[o] = (xx * c + yx * s) * size; M[o + 1] = (xy * c + yy * s) * size; M[o + 2] = (xz * c + yz * s) * size; M[o + 3] = 0;
    M[o + 4] = (yx * c - xx * s) * size; M[o + 5] = (yy * c - xy * s) * size; M[o + 6] = (yz * c - xz * s) * size; M[o + 7] = 0;
    M[o + 8] = nx; M[o + 9] = ny; M[o + 10] = nz; M[o + 11] = 0;
    M[o + 12] = H[0] + nx * IMPACT.decalLift; M[o + 13] = H[1] + ny * IMPACT.decalLift; M[o + 14] = H[2] + nz * IMPACT.decalLift; M[o + 15] = 1;
    const C = /** @type {THREE.InstancedBufferAttribute} */ (this.decals.instanceColor);
    C.array[i * 3] = cell;
    // whole-buffer upload (8 KB, at the event): three's update ranges allocate
    this.decals.instanceMatrix.needsUpdate = true;
    C.needsUpdate = true;
    this.decals.count = this.decalCount;
    this.decals.visible = true;
    this.stats.decals++;
  }

  /**
   * The puff: every part of the recipe from the strike in H.
   * @param {import('./impactTable.js').Recipe} R @param {boolean} rifle
   */
  burst(R, rifle) {
    const H = this.H, U = this.R, P = this._pv, V = this._v, S = this.S;
    P[0] = H[3]; P[1] = H[4]; P[2] = H[5]; P[3] = H[6]; P[4] = H[7]; P[5] = H[8];
    S[6] = H[9];
    for (let p = 0; p < R.parts.length; p++) {
      const part = R.parts[p];
      const k = part[0];
      const count = rifle ? Math.round(part[1] * 1.3) : part[1];
      for (let j = 0; j < count; j++) {
        P[6] = U[this.r()]; P[7] = U[this.r()]; P[8] = U[this.r()];
        P[9] = part[2] + (part[3] - part[2]) * U[this.r()]; P[10] = part[4];
        particleVelocity(P, V);
        S[0] = H[0] + H[3] * 0.01; S[1] = H[1] + H[4] * 0.01; S[2] = H[2] + H[5] * 0.01;
        S[3] = V[0]; S[4] = V[1]; S[5] = V[2]; S[7] = 0;
        this.spawn(k);
      }
    }
    // ceiling: a little dust keeps trickling down
    for (let j = 0; j < R.trickle; j++) {
      S[0] = H[0] + (U[this.r()] - 0.5) * 0.04; S[1] = H[1] - 0.01; S[2] = H[2] + (U[this.r()] - 0.5) * 0.04;
      S[3] = (U[this.r()] - 0.5) * 0.1; S[4] = -0.3 - 0.4 * U[this.r()]; S[5] = (U[this.r()] - 0.5) * 0.1;
      S[7] = 0.3 * (j + 1); // starts a little later
      this.spawn(0);
    }
  }

  /**
   * One particle of kind k from the S scratch (oldest slot reused when full).
   * @param {number} k
   */
  spawn(k) {
    const K = PKIND[k], S = this.S, U = this.R;
    const i = this.partNext;
    this.partNext = (i + 1) % this.particleMax;
    if (!(this.age[i] < this.life[i])) this.live++;
    this.age[i] = -S[7];
    this.life[i] = K.life0 + (K.life1 - K.life0) * U[this.r()];
    this.px[i] = S[0]; this.py[i] = S[1]; this.pz[i] = S[2];
    this.vx[i] = S[3]; this.vy[i] = S[4]; this.vz[i] = S[5];
    this.size[i] = K.s0 + (K.s1 - K.s0) * U[this.r()];
    this.rot[i] = U[this.r()] * Math.PI * 2;
    this.spin[i] = (U[this.r()] * 2 - 1) * K.spin;
    this.floor[i] = S[6];
    this.kind[i] = k;
    this.seed[i] = U[this.r()];
    this.landed[i] = 0;
    this.stats.particles++;
  }

  /**
   * Step the particles and write the live ones (compact) for the draw.
   * @param {number} dt @param {number} _t @param {any} _frame @param {any} [ctx]
   */
  update(dt, _t, _frame, ctx) {
    if (ctx) {
      if (ctx.world && ctx.world !== this.world) this.world = ctx.world;
      if (ctx.audio && ctx.audio !== this.audio) this.audio = ctx.audio;
      const h = ctx.player && ctx.player.head;
      if (h) { this.eye[0] = h.x; this.eye[1] = h.y; this.eye[2] = h.z; }
    }
    const mesh = this.parts;
    if (this.live <= 0) {
      if (mesh.visible) { mesh.count = 0; mesh.visible = false; }
      return;
    }
    const step = dt > 0 ? (dt > IMPACT.maxDt ? IMPACT.maxDt : dt) : 0;
    const M = mesh.instanceMatrix.array, N = this.particleMax;
    let n = 0, live = 0;
    for (let i = 0; i < N; i++) {
      const life = this.life[i];
      let a = this.age[i];
      if (!(a < life)) continue;
      a += step;
      this.age[i] = a;
      if (!(a < life)) continue;
      live++;
      if (a < 0) continue; // a trickle particle that has not started
      const K = PKIND[this.kind[i]];
      if (step > 0) {
        if (!this.landed[i]) {
          const dr = Math.exp(-K.drag * step);
          this.vx[i] *= dr; this.vz[i] *= dr;
          this.vy[i] = this.vy[i] * dr - K.g * step;
          let fx = 0, fz = 0;
          if (K.flutter > 0) {
            const ph = a * (5 + 3 * this.seed[i]) + this.seed[i] * 6.28;
            fx = Math.sin(ph) * K.flutter; fz = Math.cos(ph * 0.7) * K.flutter;
          }
          this.px[i] += (this.vx[i] + fx) * step; this.py[i] += this.vy[i] * step; this.pz[i] += (this.vz[i] + fz) * step;
          this.rot[i] += this.spin[i] * step;
          const stop = this.floor[i] + IMPACT.floorPad + this.size[i] * 0.25;
          if (this.py[i] < stop && this.vy[i] < 0) {
            this.py[i] = stop;
            // chips and slivers settle; dust and feathers just stop sinking
            if (K.shape === 1 || K.shape === 2 || K.shape === 3) { this.landed[i] = 1; this.vx[i] *= IMPACT.floorFriction; this.vz[i] *= IMPACT.floorFriction; }
            this.vy[i] = 0;
          }
        }
        if (K.grow > 0) this.size[i] *= 1 + K.grow * step;
      }
      const u = a / life;
      let al = K.alpha;
      if (a < IMPACT.fadeIn) al *= a / IMPACT.fadeIn;
      if (u > 1 - IMPACT.fadeOut) al *= (1 - u) / IMPACT.fadeOut;
      if (K.shape === 4) al *= 0.6 + 0.4 * Math.sin(a * 90 + this.seed[i] * 20); // glints flicker
      const o = n * 16;
      M[o] = this.size[i]; M[o + 1] = this.rot[i]; M[o + 2] = al; M[o + 3] = this.kind[i];
      M[o + 4] = K.aspect; M[o + 5] = this.seed[i]; M[o + 6] = u; M[o + 7] = 0;
      M[o + 8] = 0; M[o + 9] = 0; M[o + 10] = 0; M[o + 11] = 0;
      M[o + 12] = this.px[i]; M[o + 13] = this.py[i]; M[o + 14] = this.pz[i]; M[o + 15] = 1;
      n++;
    }
    this.live = live;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) mesh.instanceMatrix.needsUpdate = true; // whole buffer (10 KB, only while particles live)
    if (n > this.stats.maxLive) this.stats.maxLive = n;
  }

  /** Remove every decal and particle (a new round; a realign moved the walls). */
  clear() {
    this.decals.instanceMatrix.array.fill(0);
    this.decals.instanceMatrix.needsUpdate = true; // one 8 KB upload, at an event (restart / realign)
    this.decals.count = 0;
    this.decals.visible = false;
    this.decalNext = 0;
    this.decalCount = 0;
    this.age.fill(1e9);
    this.live = 0;
    this.parts.count = 0;
    this.parts.visible = false;
  }

  /**
   * Warm-up: one decal and one particle of every kind in front of (x, y, z); off: cleared.
   * @param {boolean} on @param {number} [x] @param {number} [y] @param {number} [z]
   */
  setWarm(on, x = 0, y = 1.4, z = -2) {
    if (!on) { this.clear(); return; }
    const H = this.H, S = this.S;
    H[0] = x; H[1] = y; H[2] = z; H[3] = 0; H[4] = 0; H[5] = 1;
    this.roll();
    this.decal(RECIPES[IMP.PLASTER]);
    for (let k = 0; k < PK_COUNT; k++) {
      S[0] = x + 0.05 * k; S[1] = y; S[2] = z; S[3] = 0; S[4] = 0; S[5] = 0; S[6] = y - 2; S[7] = 0;
      this.spawn(k);
    }
    this.update(0.001, 0, null, null);
  }

  /**
   * Run every impact kind and a few hundred particle frames at load, then
   * clear: the JIT has optimised the strike and particle code before the first
   * real shot (cold code boxes every number it touches). No sound, no world.
   */
  warmUp() {
    const audio = this.audio, world = this.world;
    this.audio = null; this.world = null;
    const H = this.H;
    for (let i = 0; i < 400; i++) {
      H[0] = (i % 13) * 0.1; H[1] = 1 + (i % 7) * 0.1; H[2] = -2; H[3] = 0; H[4] = (i & 1) ? 1 : 0; H[5] = (i & 1) ? 0 : 1;
      H[6] = 0; H[7] = (i & 1) ? -1 : 0; H[8] = (i & 1) ? 0 : -1;
      this.strike(i % RECIPES.length, (i & 2) !== 0);
      this.update(1 / 72, i * 14, null, null);
    }
    for (let i = 0; i < 400; i++) this.update(1 / 72, i * 14, null, null);
    this.clear();
    this.counts.fill(0);
    this.stats.impacts = this.stats.decals = this.stats.particles = this.stats.sounds = this.stats.maxLive = 0;
    this.audio = audio; this.world = world;
  }

  /** Textures the warm-up must upload. */
  textures() { return [this.atlas]; }

  report() {
    /** @type {Record<string, number>} */ const by = {};
    for (let i = 0; i < RECIPES.length; i++) if (this.counts[i]) by[RECIPES[i].name] = this.counts[i];
    return { ...this.stats, byKind: by, floor: this.floorKind };
  }
}
