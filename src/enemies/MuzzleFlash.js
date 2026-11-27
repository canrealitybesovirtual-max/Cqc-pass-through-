// @ts-check
/**
 * Enemy muzzle flashes: ONE instanced draw for every enemy flash, plus
 * `gfx.flashLights[1]` at the muzzle of the shooter nearest the player.
 *
 * - Each flash is three quads: a star facing along the bore and two crossed
 *   flames along it (an AK's flash is mostly forward and to the sides of the
 *   brake). Visible ~20 ms (CQC: 13–16 ms; a frame or two at 72–90 Hz).
 * - Over passthrough a flash must write alpha (PLAN §5: about 0.5 × brightness;
 *   purely additive light is unreliable), so the material is normal-blended
 *   with the alpha in the texture. The texture is generated here (no DOM) and
 *   uploaded at warm-up (`textures()`).
 * - Nothing toggles a program-key property: the material is transparent from
 *   creation and instanceColor exists from creation (setColorAt). The mesh is
 *   hidden while no flash is live.
 */

import * as THREE from 'three';

const LIFE = 0.022; // s
const LIGHT_LIFE = 0.03;
const LIGHT_PEAK = 3.0;
const TEX = 64;

/** Procedural flash texture: hot core, soft glow and 6 spikes; alpha ≈ 0.55 × brightness. */
function flashTexture() {
  const data = new Uint8Array(TEX * TEX * 4);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const u = (x + 0.5) / TEX * 2 - 1, v = (y + 0.5) / TEX * 2 - 1;
      const r = Math.hypot(u, v), a = Math.atan2(v, u);
      const spikes = Math.pow(Math.max(0, Math.cos(a * 3)), 12) * Math.max(0, 1 - r) * 0.9;
      const core = Math.exp(-r * r * 18);
      const glow = Math.max(0, 1 - r) ** 2 * 0.55;
      const b = Math.min(1, core + glow + spikes);
      const o = (y * TEX + x) * 4;
      data[o] = 255;
      data[o + 1] = Math.round(255 * (0.62 + 0.38 * core));
      data[o + 2] = Math.round(255 * (0.25 + 0.6 * core));
      data[o + 3] = Math.round(255 * 0.55 * b);
    }
  }
  const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  t.name = 'enemy-muzzle-flash';
  return t;
}

/** Star quad (facing −Z, the bore) and two crossed flame quads along −Z, in muzzle space. */
function flashGeometry() {
  const pos = [], uv = [], idx = [];
  const quad = (/** @type {number[][]} */ p) => {
    const o = pos.length / 3;
    for (const q of p) pos.push(q[0], q[1], q[2]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const s = 0.05; // star half size
  quad([[-s, -s, -0.01], [s, -s, -0.01], [s, s, -0.01], [-s, s, -0.01]]);
  const w = 0.035, l0 = -0.005, l1 = -0.15; // flame: half width, start and end along −Z
  quad([[-w, 0, l0], [w, 0, l0], [w, 0, l1], [-w, 0, l1]]);
  quad([[0, -w, l0], [0, w, l0], [0, w, l1], [0, -w, l1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class MuzzleFlash {
  /**
   * @param {THREE.Scene} scene
   * @param {number} max flashes alive at once (one per enemy)
   */
  constructor(scene, max) {
    this.texture = flashTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      forceSinglePass: true, // a double-sided transparent material is otherwise drawn twice
    });
    this.material.name = 'enemy-muzzle-flash';
    this.mesh = new THREE.InstancedMesh(flashGeometry(), this.material, max);
    this.mesh.name = 'enemy-muzzle-flash';
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // instanceColor exists before the warm-up compile
    this.mesh.frustumCulled = false; // a few cm, a frame or two
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.max = max;
    /** Per slot: age (s, ≥ LIFE = free; Float64: a Float32 fill of LIFE reads back below it, so every slot drew once). */
    this.age = new Float64Array(max).fill(LIFE);
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.qx = new Float32Array(max); this.qy = new Float32Array(max); this.qz = new Float32Array(max); this.qw = new Float32Array(max);
    this.sc = new Float32Array(max);
    /** @type {THREE.PointLight|null} */ this.light = null;
    this.lightAge = LIGHT_LIFE;
    this.lightDist = Infinity;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._z = new THREE.Vector3();
    this._roll = new THREE.Quaternion();
    this.seed = 0x2f6b1;
  }

  /** @param {THREE.PointLight|null|undefined} light */
  setLight(light) { this.light = light || null; }

  rand() {
    let s = this.seed;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.seed = s;
    return s / 4294967296;
  }

  /**
   * A shot from enemy slot i: muzzle (x, y, z), bore direction (unit),
   * `dist` from the player (the nearest shooter gets the light).
   * @param {number} i @param {number} x @param {number} y @param {number} z
   * @param {number} dx @param {number} dy @param {number} dz @param {number} dist
   */
  fire(i, x, y, z, dx, dy, dz, dist) {
    if (i < 0 || i >= this.max) return;
    this.age[i] = 0;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    // rotate local −Z onto the bore, with a random roll
    const q = this._q.setFromUnitVectors(this._z.set(0, 0, -1), this._p.set(dx, dy, dz));
    q.multiply(this._roll.setFromAxisAngle(this._z.set(0, 0, 1), this.rand() * Math.PI * 2));
    this.qx[i] = q.x; this.qy[i] = q.y; this.qz[i] = q.z; this.qw[i] = q.w;
    this.sc[i] = 0.85 + this.rand() * 0.35;
    if (this.light && (this.lightAge >= LIGHT_LIFE || dist <= this.lightDist)) {
      this.lightAge = 0;
      this.lightDist = dist;
      this.light.position.set(x + dx * 0.06, y + dy * 0.06, z + dz * 0.06);
    }
  }

  /** @param {number} dt */
  update(dt) {
    let n = 0;
    const m = this._m, p = this._p, q = this._q, s = this._s;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= LIFE) continue;
      p.set(this.px[i], this.py[i], this.pz[i]);
      q.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
      const k = this.sc[i];
      s.set(k, k, k * (0.9 + 0.3 * (1 - this.age[i] / LIFE)));
      m.compose(p, q, s);
      this.mesh.setMatrixAt(n++, m);
      this.age[i] += dt;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.light) {
      if (this.lightAge < LIGHT_LIFE) {
        this.light.intensity = LIGHT_PEAK * (1 - this.lightAge / LIGHT_LIFE);
        this.lightAge += dt;
      } else if (this.light.intensity !== 0) {
        this.light.intensity = 0;
        this.lightDist = Infinity;
      }
    }
  }

  clear() {
    this.age.fill(LIFE);
    this.mesh.count = 0;
    this.mesh.visible = false;
    if (this.light) this.light.intensity = 0;
    this.lightAge = LIGHT_LIFE;
    this.lightDist = Infinity;
  }

  /** For the warm-up draw: one flash in front of the origin, visible. @param {boolean} on */
  setWarm(on) {
    if (on) {
      this._m.identity();
      this.mesh.setMatrixAt(0, this._m);
      this.mesh.count = 1;
      this.mesh.visible = true;
      this.mesh.instanceMatrix.needsUpdate = true;
    } else this.clear();
  }
}
