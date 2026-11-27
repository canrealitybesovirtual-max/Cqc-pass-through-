// @ts-check
import * as THREE from 'three';

/**
 * Pooled weapon effects (CONTRACTS.md "W2"; numbers from CQC unless marked
 * design). Everything is built at construction, so the warm-up compiles every
 * program; nothing is created, compiled or uploaded later.
 *
 * - Muzzle flash: ONE mesh (a star across the bore plus two crossed plumes
 *   along it), procedural shader, premultiplied output whose alpha is about
 *   0.5 × brightness, so it brightens the passthrough instead of covering it
 *   (PLAN §5). 13–16 ms, 6–7.5 cm on the pistol (CQC). `flashLights[0]` lights
 *   the virtual scene for 15 ms, 6 cm ahead of the muzzle, fading as k².
 * - Spent cases: ONE instanced pool. Ballistic, bounce on `world.floorY`,
 *   the landing sound only on the first landing (CQC), then lie on their side.
 * - Dropped magazines: one instanced pool per weapon (the magazine geometry
 *   and the gun material), ballistic, bounce once or twice and lie flat.
 * - Bullet holes: ONE instanced pool of decals, 3 mm off the hit surface,
 *   depthWrite off with polygon offset (PLAN §5). Per-instance colour carries
 *   the shape parameters (seed, hole size, surface kind), primed with
 *   setColorAt at creation so `instanceColor` is part of the program from the
 *   start.
 * Pools are FIFO rings: the oldest instance is reused when full. Instanced
 * pools are not frustum-culled (one sphere would cover the house) and hidden
 * while empty.
 */

export const FX = Object.freeze({
  gravity: 9.81,
  flashMs: Object.freeze([13, 16]),
  lightMs: 15,
  lightAhead: 0.06,
  brassMax: 48,
  magMax: 6,
  decalMax: 96,
  decalLift: 0.003,
  brassBounce: 0.35, magBounce: 0.2,       // restitution (design)
  floorGrip: 0.55,                         // horizontal speed kept per bounce (design)
  spinKeep: 0.5,
  restSpeed: 0.25,                         // m/s: slower than this on the floor = settle (design)
  settleRate: 14,                          // 1/s turning onto its side
  maxBounces: 5,
  maxDt: 0.05,
});

const FLASH_VERT = /* glsl */`
attribute float kind;
varying vec2 vUv;
varying float vKind;
void main() {
  vUv = uv;
  vKind = kind;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const FLASH_FRAG = /* glsl */`
uniform vec2 uFlash;   // x brightness, y seed
varying vec2 vUv;
varying float vKind;
void main() {
  float uBright = uFlash.x, uSeed = uFlash.y;
  float b;
  if ( vKind < 0.5 ) {
    vec2 c = vUv * 2.0 - 1.0;
    float r = length( c );
    float a = atan( c.y, c.x );
    float prong = 0.3 + 0.7 * pow( abs( cos( a * 2.5 + uSeed ) ), 5.0 );
    b = ( 1.0 - smoothstep( 0.0, prong, r ) ) * 0.8 + ( 1.0 - smoothstep( 0.0, 0.35, r ) );
  } else {
    float x = abs( vUv.x * 2.0 - 1.0 );
    float y = vUv.y;
    float w = 0.12 + 0.88 * sin( 3.14159 * clamp( y * 1.25, 0.0, 1.0 ) ) * ( 1.0 - 0.6 * y );
    b = ( 1.0 - smoothstep( w * 0.25, w, x ) ) * ( 1.0 - y ) * ( 0.8 + 0.2 * sin( y * 19.0 + uSeed * 3.0 ) );
  }
  b = clamp( b, 0.0, 1.0 ) * uBright;
  if ( b < 0.004 ) discard;
  vec3 col = mix( vec3( 1.0, 0.42, 0.1 ), vec3( 1.0, 0.9, 0.62 ), clamp( b * 1.3, 0.0, 1.0 ) );
  gl_FragColor = vec4( col * b, 0.5 * b );
}`;

const DECAL_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vP;
void main() {
  vUv = uv - 0.5;
  vP = vec3( 0.5, 0.2, 0.0 );
  #ifdef USE_INSTANCING_COLOR
  vP = instanceColor;
  #endif
  vec4 p = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

// vP.r = seed, vP.g = hole radius (fraction of the half quad), vP.b = surface kind
// (0 gypsum, 0.5 wood, 0.75 floor, 1 fabric)
const DECAL_FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vP;
void main() {
  float r = length( vUv ) * 2.0;
  float a = atan( vUv.y, vUv.x );
  float s = vP.r * 97.0;
  float wob = 0.1 * sin( a * 5.0 + s ) + 0.07 * sin( a * 9.0 + s * 1.7 ) + 0.05 * sin( a * 17.0 + s * 2.9 );
  float hole = vP.g * ( 1.0 + 0.6 * wob );
  float core = 1.0 - smoothstep( hole * 0.8, hole, r );
  float k = vP.b;
  float ringR = hole * mix( 2.8, 1.5, step( 0.6, k ) ) * ( 1.0 + wob );
  float dust = ( 1.0 - smoothstep( hole, ringR, r ) ) * mix( 0.42, 0.2, step( 0.6, k ) ) * ( 1.0 - step( 0.9, k ) );
  float crack = step( 0.35, k ) * ( 1.0 - step( 0.6, k ) ) * pow( abs( sin( a * 3.0 + s ) ), 40.0 ) * ( 1.0 - smoothstep( hole, hole * 3.5, r ) ) * 0.6;
  vec3 dustCol = k < 0.25 ? vec3( 0.86, 0.84, 0.8 ) : ( k < 0.6 ? vec3( 0.55, 0.42, 0.28 ) : vec3( 0.12, 0.11, 0.1 ) );
  float alpha = max( core * 0.97, max( dust, crack ) );
  if ( alpha < 0.01 ) discard;
  vec3 col = mix( dustCol, vec3( 0.025, 0.02, 0.018 ), max( core, crack ) );
  gl_FragColor = vec4( col * alpha, alpha );
}`;

/** Surface label (world raycast) → decal kind. */
const KIND = Object.freeze({ table: 0.5, shelf: 0.5, door: 0.5, floor: 0.75, couch: 1, bed: 1 });

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _c = new THREE.Color();
const _ZP = new THREE.Vector3(0, 0, 1);
const _ZN = new THREE.Vector3(0, 0, -1);
const _XA = new THREE.Vector3(1, 0, 0);

/**
 * xorshift32 that never boxes a number: the state lives in a Uint32Array and
 * draws are written into `out` (a method returning a double that V8 does not
 * inline allocates a HeapNumber per call; Math.random allocates when it refills).
 */
export class Rng {
  /** @param {number} seed */
  constructor(seed) {
    this.s = new Uint32Array(1);
    this.s[0] = (seed >>> 0) || 0x9e3779b9;
    this.out = new Float64Array(8);
  }

  /**
   * Fill out[0 .. n−1] (n ≤ 8) with uniforms in [0, 1).
   * @param {number} n
   */
  fill(n) {
    const o = this.out;
    let x = this.s[0];
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      x >>>= 0;
      o[i] = x / 4294967296;
    }
    this.s[0] = x;
    return o;
  }
}

/** Pool body states. */
const FREE = 0, FLY = 1, SETTLE = 2, REST = 3;

/**
 * Ballistic bodies drawn by one InstancedMesh.
 */
class BodyPool {
  /**
   * @param {THREE.InstancedMesh} mesh
   * @param {number} n
   * @param {'brass'|'mag'} type
   * @param {THREE.Vector3} centre body centre in mesh space (mags: the magazine's middle)
   * @param {THREE.Vector3} half half extents in mesh space (mags) or [r, len/2, r] (cases)
   */
  constructor(mesh, n, type, centre, half) {
    this.mesh = mesh;
    this.n = n;
    this.type = type;
    this.centre = centre;
    this.half = half;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.ang = new Float32Array(n * 3);
    this.scl = new Float32Array(n * 3).fill(1);
    this.rq = new Float32Array(n * 4);       // rest orientation
    this.rh = new Float32Array(n);           // rest / contact height of the centre
    this.state = new Uint8Array(n);
    this.bounces = new Uint8Array(n);
    this.sounded = new Uint8Array(n);
    /** @type {string[]} landing sound key per instance */
    this.sound = new Array(n).fill('');
    this.gain = new Float32Array(n);
    this.next = 0;
    this.count = 0;
    this.dirty = false;
  }

  /** @returns {number} index of the slot to use (oldest when full) */
  take() {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (this.count < this.n) this.count++;
    this.mesh.count = this.count;
    this.mesh.visible = true;
    return i;
  }

  reset() {
    this.state.fill(FREE);
    this.next = 0;
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** @param {number} i */
  write(i) {
    const p = this.pos, q = this.quat, o = i * 3, o4 = i * 4;
    _q.set(q[o4], q[o4 + 1], q[o4 + 2], q[o4 + 3]);
    _s.set(this.scl[o], this.scl[o + 1], this.scl[o + 2]);
    // instance origin = centre − R·(S·centreLocal)
    _v.set(this.centre.x * _s.x, this.centre.y * _s.y, this.centre.z * _s.z).applyQuaternion(_q);
    _p.set(p[o] - _v.x, p[o + 1] - _v.y, p[o + 2] - _v.z);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.dirty = true;
  }

  /**
   * @param {number} dt
   * @param {{ floorY: (x: number, z: number) => number } | null} world
   * @param {{ play?: (key: string, x: number, y: number, z: number, gain?: number, rate?: number) => number } | null} audio
   * @param {number} bounce
   */
  update(dt, world, audio, bounce) {
    const P = this.pos, V = this.vel, Q = this.quat, W = this.ang, st = this.state;
    for (let i = 0; i < this.count; i++) {
      const s = st[i];
      if (s === FREE || s === REST) continue;
      const o = i * 3, o4 = i * 4;
      if (s === SETTLE) {
        _q.set(Q[o4], Q[o4 + 1], Q[o4 + 2], Q[o4 + 3]);
        _q2.set(this.rq[o4], this.rq[o4 + 1], this.rq[o4 + 2], this.rq[o4 + 3]);
        _q.slerp(_q2, 1 - Math.exp(-FX.settleRate * dt));
        Q[o4] = _q.x; Q[o4 + 1] = _q.y; Q[o4 + 2] = _q.z; Q[o4 + 3] = _q.w;
        const fy = world ? world.floorY(P[o], P[o + 2]) : 0;
        P[o + 1] += ((Number.isFinite(fy) ? fy : 0) + this.rh[i] - P[o + 1]) * (1 - Math.exp(-FX.settleRate * dt));
        if (_q.angleTo(_q2) < 0.01) st[i] = REST;
        this.write(i);
        continue;
      }
      V[o + 1] -= FX.gravity * dt;
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      // q += ½ (0, ω) q dt
      const wx = W[o], wy = W[o + 1], wz = W[o + 2];
      let qx = Q[o4], qy = Q[o4 + 1], qz = Q[o4 + 2], qw = Q[o4 + 3];
      const h = 0.5 * dt;
      const nx = qx + h * (wx * qw + wy * qz - wz * qy);
      const ny = qy + h * (wy * qw + wz * qx - wx * qz);
      const nz = qz + h * (wz * qw + wx * qy - wy * qx);
      const nw = qw - h * (wx * qx + wy * qy + wz * qz);
      const ql = Math.hypot(nx, ny, nz, nw) || 1;
      qx = nx / ql; qy = ny / ql; qz = nz / ql; qw = nw / ql;
      Q[o4] = qx; Q[o4 + 1] = qy; Q[o4 + 2] = qz; Q[o4 + 3] = qw;
      let fy = world ? world.floorY(P[o], P[o + 2]) : 0;
      if (!Number.isFinite(fy)) fy = 0;
      const contact = this.rh[i] * 0.8;
      if (P[o + 1] < fy + contact) {
        P[o + 1] = fy + contact;
        if (V[o + 1] < 0) {
          if (!this.sounded[i]) {
            this.sounded[i] = 1;
            if (audio && audio.play && this.sound[i]) audio.play(this.sound[i], P[o], P[o + 1], P[o + 2], this.gain[i], 0.92 + 0.16 * ((i * 0.618034) % 1));
          }
          V[o + 1] = -V[o + 1] * bounce;
          V[o] *= FX.floorGrip; V[o + 2] *= FX.floorGrip;
          W[o] *= FX.spinKeep; W[o + 1] *= FX.spinKeep; W[o + 2] *= FX.spinKeep;
          this.bounces[i]++;
        }
        if (Math.hypot(V[o], V[o + 1], V[o + 2]) < FX.restSpeed || this.bounces[i] >= FX.maxBounces) this._settle(i);
      }
      this.write(i);
    }
    if (this.dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.dirty = false; }
  }

  /**
   * Turn onto the side nearest to how it lies now.
   * @param {number} i
   */
  _settle(i) {
    const o4 = i * 4, Q = this.quat;
    _q.set(Q[o4], Q[o4 + 1], Q[o4 + 2], Q[o4 + 3]);
    if (this.type === 'brass') {
      // case axis (local Y) horizontal
      _v.set(0, 1, 0).applyQuaternion(_q);
      _p.set(_v.x, 0, _v.z);
      if (_p.lengthSq() < 1e-6) _p.set(1, 0, 0);
      _p.normalize();
      _q2.setFromUnitVectors(_v, _p).multiply(_q);
    } else {
      // magazine on one flat side: local X vertical
      _v.set(1, 0, 0).applyQuaternion(_q);
      _p.set(0, _v.y >= 0 ? 1 : -1, 0);
      _q2.setFromUnitVectors(_v, _p).multiply(_q);
    }
    this.rq[o4] = _q2.x; this.rq[o4 + 1] = _q2.y; this.rq[o4 + 2] = _q2.z; this.rq[o4 + 3] = _q2.w;
    this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    this.state[i] = SETTLE;
  }
}

export class WeaponFX {
  /**
   * @param {{ worldRoot: THREE.Object3D, fpRoot: THREE.Object3D, light?: THREE.PointLight | null,
   *   views: Record<string, import('./WeaponView.js').WeaponView> }} o
   */
  constructor({ worldRoot, fpRoot, light = null, views }) {
    this.light = light;
    if (light) light.intensity = 0;
    this.rng = new Rng(0x9e3779b9);

    // --- muzzle flash
    const fg = new THREE.BufferGeometry();
    const P = [], U = [], K = [], I = [];
    const quad = (/** @type {number[][]} */ c, /** @type {number} */ k) => {
      const b = P.length / 3;
      for (const v of c) P.push(v[0], v[1], v[2]);
      U.push(0, 0, 1, 0, 1, 1, 0, 1);
      K.push(k, k, k, k);
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    quad([[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]], 0);           // star, across the bore
    quad([[-0.35, 0, 0], [0.35, 0, 0], [0.35, 0, -1.6], [-0.35, 0, -1.6]], 1);           // plume, horizontal
    quad([[0, -0.35, 0], [0, 0.35, 0], [0, 0.35, -1.6], [0, -0.35, -1.6]], 1);           // plume, vertical
    fg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    fg.setAttribute('kind', new THREE.Float32BufferAttribute(K, 1));
    fg.setIndex(I);
    fg.computeBoundingSphere();
    this.flashMat = new THREE.ShaderMaterial({
      name: 'w2-flash', vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG,
      // one vec2 (a number uniform's `value` would box a double on every write)
      uniforms: { uFlash: { value: new THREE.Vector2(1, 0) } },
      transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.flashMesh = new THREE.Mesh(fg, this.flashMat);
    this.flashMesh.name = 'w2-flash';
    this.flashMesh.renderOrder = 11;
    this.flashMesh.visible = false;
    this.flashMesh.frustumCulled = false;
    fpRoot.add(this.flashMesh);
    /** @type {import('./WeaponView.js').WeaponView | null} */
    this.flashView = null;
    this.flashEnd = 0;
    this.flashDur = 0.015;
    this.flashSize = 0.06;
    this.flashRoll = 0;
    this.lightEnd = 0;
    this.lightI = 0;

    // --- spent cases (unit cylinder, scaled per instance)
    const cg = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
    this.brassMat = new THREE.MeshStandardMaterial({ name: 'w2-brass', color: 0xc9a24f, metalness: 0.6, roughness: 0.38 });
    const brassMesh = new THREE.InstancedMesh(cg, this.brassMat, FX.brassMax);
    brassMesh.name = 'w2-brass';
    this.brass = new BodyPool(prime(brassMesh), FX.brassMax, 'brass', new THREE.Vector3(), new THREE.Vector3(1, 0.5, 1));
    worldRoot.add(brassMesh);

    // --- dropped magazines, one pool per weapon
    /** @type {Record<string, BodyPool>} */
    this.mags = {};
    /** @type {BodyPool[]} the same pools as an array (per-frame loops never iterate object keys) */
    this.magPools = [];
    for (const id of Object.keys(views)) {
      const v = views[id];
      const mm = new THREE.InstancedMesh(v.mag.geometry, /** @type {THREE.Material} */ (v.mag.material), FX.magMax);
      mm.name = `w2-${id}-mags`;
      const pool = new BodyPool(prime(mm), FX.magMax, 'mag', v.magCentre.clone(), v.magHalf.clone());
      this.mags[id] = pool;
      this.magPools.push(pool);
      worldRoot.add(mm);
    }

    // --- bullet holes
    this.decalMat = new THREE.ShaderMaterial({
      name: 'w2-decal', vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.decals = /** @type {THREE.InstancedMesh} */ (prime(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.decalMat, FX.decalMax)));
    this.decals.name = 'w2-decals';
    this.decals.renderOrder = 1;
    worldRoot.add(this.decals);
    this.decalNext = 0;
    this.decalCount = 0;

    this._warm = false;
    this._warmCounts = new Array(1 + this.magPools.length).fill(0);
  }

  /**
   * A muzzle flash at the view's muzzle (it follows the gun for its life).
   * @param {import('./WeaponView.js').WeaponView} view
   * @param {number} now seconds
   */
  flash(view, now) {
    const f = view.fit, r = this.rng.fill(5), ms = FX.flashMs[0] + (FX.flashMs[1] - FX.flashMs[0]) * r[0];
    this.flashView = view;
    this.flashDur = ms / 1000;
    this.flashEnd = now + this.flashDur;
    this.flashSize = f.flash[0] + (f.flash[1] - f.flash[0]) * r[1];
    this.flashRoll = r[2] * Math.PI * 2;
    this.flashMat.uniforms.uFlash.value.set(0.85 + 0.15 * r[3], r[4] * 6.283);
    this.lightEnd = now + FX.lightMs / 1000;
    this.lightI = f.flashLight;
  }

  /**
   * A spent case or a live round leaving the port.
   * @param {number} px @param {number} py @param {number} pz world
   * @param {number} vx @param {number} vy @param {number} vz m/s
   * @param {THREE.Quaternion} gunQuat for the case's starting orientation
   * @param {readonly number[]} caseRL [radius, length]
   * @param {string} sound landing sound key
   */
  eject(px, py, pz, vx, vy, vz, gunQuat, caseRL, sound) {
    const B = this.brass, i = B.take(), o = i * 3, o4 = i * 4;
    B.pos[o] = px; B.pos[o + 1] = py; B.pos[o + 2] = pz;
    B.vel[o] = vx; B.vel[o + 1] = vy; B.vel[o + 2] = vz;
    // case axis (cylinder Y) along the bore, as it sat in the chamber; it tumbles out of the port
    _q.setFromAxisAngle(_XA, Math.PI / 2);
    _q2.copy(gunQuat).multiply(_q);
    B.quat[o4] = _q2.x; B.quat[o4 + 1] = _q2.y; B.quat[o4 + 2] = _q2.z; B.quat[o4 + 3] = _q2.w;
    const r = this.rng.fill(4), spin = 18 + 14 * r[0];
    _v.set(r[1] - 0.5, r[2] - 0.5, 1).normalize().applyQuaternion(gunQuat).multiplyScalar(spin);
    B.ang[o] = _v.x; B.ang[o + 1] = _v.y; B.ang[o + 2] = _v.z;
    B.scl[o] = caseRL[0]; B.scl[o + 1] = caseRL[1]; B.scl[o + 2] = caseRL[0];
    B.rh[i] = caseRL[0];
    B.state[i] = FLY; B.bounces[i] = 0; B.sounded[i] = 0;
    B.sound[i] = sound; B.gain[i] = 0.6 + 0.3 * r[3];
    B.write(i);
  }

  /**
   * A magazine falls free.
   * @param {string} id weapon id
   * @param {THREE.Vector3} topPos magazine origin (top) in the world
   * @param {THREE.Quaternion} q its orientation
   * @param {THREE.Vector3} vel m/s
   * @param {number} [spin] rad/s tumble
   */
  dropMag(id, topPos, q, vel, spin = 2) {
    const B = this.mags[id];
    if (!B) return;
    const i = B.take(), o = i * 3, o4 = i * 4;
    _v.copy(B.centre).applyQuaternion(q).add(topPos);   // centre in the world
    B.pos[o] = _v.x; B.pos[o + 1] = _v.y; B.pos[o + 2] = _v.z;
    B.vel[o] = vel.x; B.vel[o + 1] = vel.y; B.vel[o + 2] = vel.z;
    B.quat[o4] = q.x; B.quat[o4 + 1] = q.y; B.quat[o4 + 2] = q.z; B.quat[o4 + 3] = q.w;
    const r = this.rng.fill(4);
    _v.set(r[0] - 0.5, r[1] - 0.5, r[2] - 0.5).normalize().multiplyScalar(spin * (0.5 + r[3]));
    B.ang[o] = _v.x; B.ang[o + 1] = _v.y; B.ang[o + 2] = _v.z;
    B.rh[i] = Math.min(B.half.x, B.half.y, B.half.z);
    B.state[i] = FLY; B.bounces[i] = 0; B.sounded[i] = 0;
    B.sound[i] = 'magDrop'; B.gain[i] = 0.9;
    B.write(i);
  }

  /**
   * A bullet hole on a world surface.
   * @param {{ x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string }} hit
   * @param {number} size quad size (m) @param {number} hole hole radius (m)
   */
  decal(hit, size, hole) {
    const D = this.decals, i = this.decalNext;
    this.decalNext = (i + 1) % FX.decalMax;
    if (this.decalCount < FX.decalMax) this.decalCount++;
    _v.set(hit.nx, hit.ny, hit.nz);
    if (!(_v.lengthSq() > 1e-8)) _v.set(0, 0, 1);
    _v.normalize();
    _q.setFromUnitVectors(_ZP, _v);
    const r = this.rng.fill(4);
    _q2.setFromAxisAngle(_ZP, r[0] * Math.PI * 2);
    _q.multiply(_q2);
    _p.set(hit.x + _v.x * FX.decalLift, hit.y + _v.y * FX.decalLift, hit.z + _v.z * FX.decalLift);
    const s = size * (0.9 + 0.2 * r[1]);
    _s.set(s, s, s);
    _m.compose(_p, _q, _s);
    D.setMatrixAt(i, _m);
    const k = /** @type {Record<string, number>} */ (KIND)[hit.surface];
    _c.setRGB(r[2], (hole / (s / 2)) * (0.9 + 0.2 * r[3]), k === undefined ? 0 : k);
    D.setColorAt(i, _c);
    D.instanceMatrix.needsUpdate = true;
    if (D.instanceColor) D.instanceColor.needsUpdate = true;
    D.count = this.decalCount;
    D.visible = true;
  }

  /**
   * @param {number} dt @param {number} now seconds
   * @param {{ world?: any, audio?: any }} ctx
   */
  update(dt, now, ctx) {
    if (this._warm) return;
    const step = dt > FX.maxDt ? FX.maxDt : dt;
    // flash follows the gun while it lives
    const v = this.flashView;
    if (v && now < this.flashEnd) {
      const m = this.flashMesh;
      v.toWorld(v.muzzle, m.position);
      _q.setFromAxisAngle(_ZP, this.flashRoll);
      m.quaternion.copy(v.quat).multiply(_q);
      m.scale.setScalar(this.flashSize);
      m.visible = true;
    } else {
      this.flashMesh.visible = false;
      this.flashView = now < this.lightEnd ? v : null;
    }
    const L = this.light;
    if (L) {
      if (now < this.lightEnd && this.flashView) {
        const k = (this.lightEnd - now) / (FX.lightMs / 1000);
        const fv = this.flashView;
        fv.toWorld(fv.muzzle, L.position);
        fv.dirWorld(_ZN, _v);
        L.position.addScaledVector(_v, FX.lightAhead);
        L.intensity = this.lightI * k * k;
      } else if (L.intensity !== 0) L.intensity = 0;
    }
    if (step > 0) {
      const world = ctx.world || null, audio = ctx.audio || null;
      this.brass.update(step, world, audio, FX.brassBounce);
      for (let i = 0; i < this.magPools.length; i++) this.magPools[i].update(step, world, audio, FX.magBounce);
    }
  }

  /** Meshes for the warm-up draw. */
  warmMeshes() {
    /** @type {THREE.Object3D[]} */
    const out = [this.flashMesh, this.brass.mesh, this.decals];
    for (const B of this.magPools) out.push(B.mesh);
    return out;
  }

  /**
   * Show every pool (one instance each) for the warm-up draw, then restore.
   * @param {boolean} on
   */
  setWarm(on) {
    const pools = [this.brass, ...this.magPools];
    if (on && !this._warm) {
      this._warm = true;
      pools.forEach((B, i) => { this._warmCounts[i] = B.count; B.mesh.count = Math.max(1, B.count); B.mesh.visible = true; });
      this.decals.count = Math.max(1, this.decalCount);
      this.decals.visible = true;
      this.flashMesh.visible = true;
    } else if (!on && this._warm) {
      this._warm = false;
      pools.forEach((B, i) => { B.mesh.count = this._warmCounts[i]; B.mesh.visible = B.count > 0; });
      this.decals.count = this.decalCount;
      this.decals.visible = this.decalCount > 0;
      this.flashMesh.visible = false;
    }
  }

  /** Clear every pool (new round). */
  reset() {
    this.brass.reset();
    for (const B of this.magPools) B.reset();
    this.decalNext = 0;
    this.decalCount = 0;
    this.decals.count = 0;
    this.decals.visible = false;
    this.flashMesh.visible = false;
    this.flashView = null;
    this.flashEnd = this.lightEnd = 0;
    if (this.light) this.light.intensity = 0;
  }
}

/**
 * Instanced pool at creation: instanceColor primed (setColorAt), empty, not frustum-culled.
 * @param {THREE.InstancedMesh} m
 */
function prime(m) {
  m.setColorAt(0, _c.setRGB(1, 1, 1));
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (m.instanceColor) m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.castShadow = false;
  m.receiveShadow = false;
  m.count = 0;
  m.visible = false;
  return m;
}

