// @ts-check
/**
 * Enemy hit feedback (gap audit F4): a short puff where a round strikes a
 * soldier, so a hit reads at a glance and not only by the grunt and flinch.
 * ONE instanced draw for every puff.
 *
 * - Each hit: a blood mist and a cloth-dust puff on the entry side (6 cm
 *   toward the shooter, so the body does not hide them) and a spray out of the
 *   far side along the bullet, each a camera-facing quad that swells and
 *   drifts, then shrinks away in 0.24 s (a few frames at 72–90 Hz).
 * - Over passthrough an effect must write alpha (PLAN §5), so the material is
 *   normal-blended with the alpha in the texture; per-instance colour (blood or
 *   dust) through instanceColor. The fade is a scale-down: no per-instance
 *   alpha, no shader hook.
 * - Nothing toggles a program-key property: transparent from creation,
 *   instanceColor exists from creation (setColorAt), the texture is generated
 *   here (no DOM) and drawn by the warm-up (`setWarm`). Allocation-free after
 *   construction; a full pool reuses the oldest slot.
 */

import * as THREE from 'three';

export const PUFF = Object.freeze({
  life: 0.24, // s
  perHit: 3,
  toShooter: 0.06, // m: entry puffs sit this far out of the body toward the shooter
  exit: 0.1, // m: the exit spray starts this far past the hit point
  drag: 7, // 1/s
  rise: 0.25, // m/s² (warm mist drifts up a little against gravity)
});

const TEX = 32;

/** Soft, slightly lumpy blob: white (tinted per instance), alpha ≈ 0.85 at the core. */
function puffTexture() {
  const data = new Uint8Array(TEX * TEX * 4);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const u = (x + 0.5) / TEX * 2 - 1, v = (y + 0.5) / TEX * 2 - 1;
      const r = Math.hypot(u, v), a = Math.atan2(v, u);
      const edge = 0.78 + 0.12 * Math.sin(a * 5 + 0.7) + 0.08 * Math.sin(a * 9 + 2.1);
      const k = Math.max(0, 1 - r / edge);
      const o = (y * TEX + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * 0.85 * k * k * (3 - 2 * k));
    }
  }
  const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  t.name = 'enemy-hit-puff';
  return t;
}

/** Kinds of particle: colour (linear) and size (start → peak, m). */
const KIND_R = new Float32Array([0.30, 0.42, 0.36]);
const KIND_G = new Float32Array([0.02, 0.37, 0.025]);
const KIND_B = new Float32Array([0.02, 0.31, 0.02]);
const KIND_S0 = new Float32Array([0.05, 0.04, 0.04]);
const KIND_S1 = new Float32Array([0.2, 0.15, 0.24]);

export class HitPuff {
  /**
   * @param {THREE.Scene} scene
   * @param {number} [max] particles alive at once (3 per hit)
   */
  constructor(scene, max = 18) {
    this.texture = puffTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      forceSinglePass: true,
    });
    this.material.name = 'enemy-hit-puff';
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geo, this.material, max);
    this.mesh.name = 'enemy-hit-puff';
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // instanceColor exists before the warm-up compile
    this.mesh.frustumCulled = false; // small, short, near an enemy
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.max = max;
    /** Per slot: age (≥ life = free; Float64 so the fill compares equal to PUFF.life), position, velocity, kind, size. */
    this.age = new Float64Array(max).fill(PUFF.life);
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.size = new Float32Array(max);
    this.live = 0;
    /** Puffs spawned (hits shown) since construction. */
    this.spawned = 0;
    /** The eye the quads face (world): the owner copies the player's head here each frame. */
    this.eye = new Float64Array([0, 1.6, 0]);
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    /** xorshift32 state (a Uint32Array: a uint32 above 2^30 in a plain field would be a heap number). */
    this.seed = new Uint32Array([0x7a3c1]);
    /** Scratch: jitter in ±0.25 (J), sizes (S) and one particle's position and velocity (T). */
    this.J = new Float64Array(10);
    this.S = new Float64Array(3);
    this.T = new Float64Array(6);
  }

  /** Fill J with jitter in ±0.25 and S with size factors in 0.85…1.2 (no doubles returned or passed). */
  roll() {
    const st = this.seed, J = this.J, S = this.S;
    let s = st[0];
    for (let k = 0; k < 13; k++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const r = s / 4294967296;
      if (k < 10) J[k] = (r - 0.5) * 0.5; else S[k - 10] = 0.85 + r * 0.35;
    }
    st[0] = s;
  }

  /** A free slot, or the oldest one. */
  slot() {
    let oldest = 0, oa = -1;
    for (let i = 0; i < this.max; i++) {
      const a = this.age[i];
      if (a >= PUFF.life) return i;
      if (a > oa) { oa = a; oldest = i; }
    }
    return oldest;
  }

  /**
   * One particle of `kind` (0 blood mist, 1 cloth dust, 2 exit spray) at T[0..2]
   * moving T[3..5], size factor S[sk].
   * @param {number} kind @param {number} sk
   */
  place(kind, sk) {
    const i = this.slot(), T = this.T;
    if (this.age[i] < PUFF.life) this.live--;
    this.age[i] = 0;
    this.kind[i] = kind;
    this.px[i] = T[0]; this.py[i] = T[1]; this.pz[i] = T[2];
    this.vx[i] = T[3]; this.vy[i] = T[4]; this.vz[i] = T[5];
    this.size[i] = this.S[sk];
    this.live++;
  }

  /**
   * A round struck a soldier at (x, y, z) travelling along (dx, dy, dz).
   * Allocation-free (an event, a few per second at most).
   * @param {number} x @param {number} y @param {number} z
   * @param {number} dx @param {number} dy @param {number} dz bullet travel (any length)
   * @param {number} [out] m to move the entry puffs toward the shooter (default PUFF.toShooter)
   */
  spawn(x, y, z, dx, dy, dz, out = PUFF.toShooter) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 1e-9)) { dx = 0; dy = 0; dz = -1; l = 1; }
    dx /= l; dy /= l; dz /= l;
    const o = Number.isFinite(out) ? out : PUFF.toShooter;
    const ex = x - dx * o, ey = y - dy * o, ez = z - dz * o;
    this.roll();
    const J = this.J, T = this.T;
    // entry: blood mist back toward the shooter, cloth dust a little wider
    T[0] = ex; T[1] = ey; T[2] = ez;
    T[3] = -dx * 0.35 + J[0]; T[4] = -dy * 0.35 + J[1] * 0.6 + 0.1; T[5] = -dz * 0.35 + J[2];
    this.place(0, 0);
    T[0] = ex + J[3] * 0.06; T[1] = ey + J[4] * 0.06; T[2] = ez + J[5] * 0.06;
    T[3] = -dx * 0.55 + J[6] * 1.4; T[4] = -dy * 0.55 + J[7] + 0.15; T[5] = -dz * 0.55 + J[8] * 1.4;
    this.place(1, 1);
    // exit: a spray out of the far side
    T[0] = x + dx * PUFF.exit; T[1] = y + dy * PUFF.exit; T[2] = z + dz * PUFF.exit;
    T[3] = dx * 1.1 + J[9]; T[4] = dy * 1.1 + J[0] * 0.6; T[5] = dz * 1.1 + J[3];
    this.place(2, 2);
    this.spawned++;
  }

  /**
   * Age, drift and draw, each quad facing the eye (`eye`: the player's head,
   * set by the owner each frame). Writes the instance buffers directly (no
   * three.js calls in the loop: nothing to box or allocate).
   * @param {number} dt seconds (0: paused, nothing moves)
   */
  update(dt) {
    const mesh = this.mesh;
    if (this.live <= 0) {
      if (mesh.visible) { mesh.count = 0; mesh.visible = false; }
      return;
    }
    const L = PUFF.life, E = this.eye, hx = E[0], hy = E[1], hz = E[2];
    const M = mesh.instanceMatrix.array, C = /** @type {THREE.InstancedBufferAttribute} */ (mesh.instanceColor).array;
    const step = dt > 0 ? dt : 0;
    const drag = step > 0 ? Math.exp(-PUFF.drag * step) : 1;
    let n = 0, live = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= L) continue;
      const a = this.age[i] + step;
      this.age[i] = a;
      if (a >= L) continue;
      live++;
      if (step > 0) {
        this.px[i] += this.vx[i] * step; this.py[i] += this.vy[i] * step; this.pz[i] += this.vz[i] * step;
        this.vx[i] *= drag; this.vy[i] = this.vy[i] * drag + PUFF.rise * step; this.vz[i] *= drag;
      }
      const k = this.kind[i], u = a / L;
      // swell fast, then shrink away over the last 40 %
      const g = u < 0.6 ? 1 - u / 0.6 : 0;
      const grow = 1 - g * g;
      const fade = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
      const sz = (KIND_S0[k] + (KIND_S1[k] - KIND_S0[k]) * grow) * fade * this.size[i];
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      // basis: Z toward the eye, X = up × Z, Y = Z × X (the quad's face is +Z)
      let zx = hx - x, zy = hy - y, zz = hz - z;
      let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
      if (l < 1e-6) { zx = 0; zy = 0; zz = 1; l = 1; }
      zx /= l; zy /= l; zz /= l;
      let xx = zz, xz = -zx; // (0, 1, 0) × Z
      l = Math.sqrt(xx * xx + xz * xz);
      if (l < 1e-6) { xx = 1; xz = 0; l = 1; }
      xx /= l; xz /= l;
      const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
      const o = n * 16;
      M[o] = xx * sz; M[o + 1] = 0; M[o + 2] = xz * sz; M[o + 3] = 0;
      M[o + 4] = yx * sz; M[o + 5] = yy * sz; M[o + 6] = yz * sz; M[o + 7] = 0;
      M[o + 8] = zx * sz; M[o + 9] = zy * sz; M[o + 10] = zz * sz; M[o + 11] = 0;
      M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
      const c = n * 3;
      C[c] = KIND_R[k]; C[c + 1] = KIND_G[k]; C[c + 2] = KIND_B[k];
      n++;
    }
    this.live = live;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      /** @type {THREE.InstancedBufferAttribute} */ (mesh.instanceColor).needsUpdate = true;
    }
  }

  clear() {
    this.age.fill(PUFF.life);
    this.live = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /**
   * For the warm-up draw: one puff at (x, y, z), visible (and its texture
   * uploaded by that draw); off: cleared.
   * @param {boolean} on @param {number} [x] @param {number} [y] @param {number} [z]
   */
  setWarm(on, x = 0, y = 1.3, z = -3) {
    if (on) {
      this._m.makeScale(0.2, 0.2, 0.2).setPosition(x, y, z);
      this.mesh.setMatrixAt(0, this._m);
      this.mesh.setColorAt(0, this._c.setRGB(1, 1, 1));
      this.mesh.count = 1;
      this.mesh.visible = true;
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    } else this.clear();
  }
}
