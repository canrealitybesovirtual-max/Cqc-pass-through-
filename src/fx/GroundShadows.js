// @ts-check
/**
 * Contact shadows: ONE instanced draw for every soft blob that grounds a
 * virtual object on a real surface (research-look R1, research-phys §12; CQC:
 * furniture "floated" until contact shadows were added).
 *
 * Casters (all read, nothing owned):
 * - **Dropped guns and magazines** (`setPhysics(PhysicsWorld)`): every live
 *   item's box footprint, projected into the plane of the real surface under
 *   it (a world raycast straight down: the global mesh, so a gun on the bed
 *   gets its shadow on the duvet, one on the table on the table top). A
 *   resting item's shadow is computed once and then frozen until its pose
 *   changes (no creep, no per-frame ray; CQC lesson: resting things must sleep).
 * - **Enemies** (`setEnemies(EnemyManager)`): one blob per foot (fading as the
 *   foot lifts) and a body ellipse under the pelvis; a body on the floor gets
 *   a blob per body part (from its hit capsules). Their floor is their own
 *   root height: no ray.
 * - **Held guns** (`setWeapons(WeaponSystem)`): within 0.5 m of a real
 *   surface below, a faint blob (a gun held over the table darkens it).
 *
 * Over passthrough a blob is black with alpha `a`: it multiplies the real
 * surface by (1 − a), so it takes the room's own brightness and colour for
 * free. Drawn after the depth-only occluder (renderOrder 1), so a blob under
 * a real couch is hidden by the couch; each blob is drawn a little toward the
 * eye (1.2 cm, 3 cm on soft surfaces) so a lumpy scanned duvet does not cut it.
 *
 * Nothing is created after construction: the material's program key is fixed
 * (transparent, instanceColor primed), the pool is drawn by the warm-up.
 * `update()` is allocation-free: it writes the live instances and uploads the
 * fixed instance buffers whole (no update ranges: three allocates for those).
 */

import * as THREE from 'three';
import { SH, SH_LEN, SHADOW, W, W_LEN, BF_LEN, boxFootprint, capsuleFloor, writeShadow } from './shadowMath.js';
import { B } from '../enemies/Rig.js';
import { K_MAG9, K_MAG762 } from '../physics/ItemShapes.js';

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vP;
void main() {
  vUv = uv * 2.0 - 1.0;
  vP = vec3( 0.5, 0.5, 0.01 );
  #ifdef USE_INSTANCING_COLOR
  vP = instanceColor;
  #endif
  vec4 p = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  vec4 mv = modelViewMatrix * p;
  float d = length( mv.xyz );
  mv.xyz *= max( 0.0, 1.0 - vP.z / max( d, 0.001 ) );
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vP;
void main() {
  float r = length( vUv );
  float inner = ( 1.0 - vP.y ) * 0.92;
  float k = 1.0 - smoothstep( inner, 1.0, r );
  float a = vP.x * k * ( 0.7 + 0.3 * k );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
}`;

/** Labels whose surfaces are soft (beds, couches): softer, slightly darker blobs, a bigger pull. */
export function isSoftSurface(/** @type {string} */ s) {
  switch (s) {
    case 'bed': case 'couch': case 'sofa': case 'soft': case 'armchair': case 'mattress': case 'pillow': case 'ottoman': return true;
    default: return false;
  }
}

/** Physics item states (PhysicsWorld ST_*). */
const ST_FREE = 0, ST_MOVING = 1, ST_RESTING = 2;
/** WeaponSystem carry state "in the hand" (Slots.js CARRY_HAND). */
const CARRY_HAND = 2;
/**
 * Is this object drawn: its own and every ancestor's `visible`? A pause hides
 * the enemies and the loose magazines under GameSession's safety veil; their
 * blobs must go with them (v0.4 verifier: they floated on the floor).
 * @param {any} o
 */
function shown(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

export class GroundShadows {
  /**
   * @param {THREE.Object3D} parent where the pool lives (the scene)
   * @param {{ capacity?: number }} [o]
   */
  constructor(parent, o = {}) {
    const cap = this.capacity = o.capacity ?? 96;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // lies in XZ, normal +Y (the instance's Y axis = the surface normal)
    this.material = new THREE.ShaderMaterial({
      name: 'fx-ground-shadow',
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, cap);
    this.mesh.name = 'fx-ground-shadows';
    this.mesh.setColorAt(0, new THREE.Color(0, 0, 0)); // instanceColor exists before the warm-up compile
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /** @type {THREE.InstancedBufferAttribute} */ (this.mesh.instanceColor).setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.visible = false;
    parent.add(this.mesh);

    /** Records of this frame (SH_LEN each). */
    this.rec = new Float64Array(cap * SH_LEN);
    this.n = 0;
    /** Key light direction (unit, toward the light); Look copies the sun's here. */
    this.light = new Float64Array([0.27, 0.9, 0.34]);
    this.enabled = true;

    // ── sources
    /** @type {any} */ this.phys = null;
    /** @type {any} */ this.enemies = null;
    /** @type {any} */ this.weapons = null;
    /** @type {any} */ this.world = null;
    // physics item cache (per slot): pose, surface, footprint (computed when the pose changes)
    this.maxItems = 0;
    /** @type {Float64Array} */ this.itemPose = new Float64Array(0);
    /** @type {Float64Array} */ this.itemRec = new Float64Array(0);
    /** @type {Uint8Array} 0 none, 1 valid record, 2 invisible (too high / no surface) */ this.itemOk = new Uint8Array(0);
    /** @type {Int16Array} */ this.itemKind = new Int16Array(0);
    // enemy capsule indices
    this.footCaps = new Int16Array([-1, -1]);
    /** @type {Int16Array} the capsules a body on the floor casts */ this.deadCaps = new Int16Array(0);
    // held guns: local box (centre, half) per weapon
    this.heldBox = new Float64Array(12);
    // held guns: the surface under each, re-cast at 36 Hz near a surface, 6 Hz far from one
    this.heldPlane = new Float64Array(2 * 8); // x, y, z, nx, ny, nz, soft, valid
    this.heldClock = new Float64Array(2);
    // scratch (typed arrays: no double crosses a call boundary in the frame path)
    this._w = new Float64Array(W_LEN);
    this._bf = new Float64Array(BF_LEN);
    this._f = new Float64Array(6);
    this._c = new Float64Array(7);
    this._cp = new Float64Array(2);
    /** Surface point and normal for boxOnSurface. */
    this._sp = new Float64Array(6);
    /** castBox input: centre xyz, rotation xyzw, half xyz, max drop, alpha hard / soft, soft hard / soft, fade height. */
    this._box = new Float64Array(16);
    /** @type {any} */
    this._hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' };
    this.stats = { maxLive: 0, rays: 0, frozen: 0 };
  }

  /** @param {any} world anything with raycast(ox,oy,oz,dx,dy,dz,max,out) (the World) */
  setWorld(world) { this.world = world || null; this.invalidate(); }

  /**
   * Dropped items: a PhysicsWorld (its slot arrays `st`, `cur`, `kindOf` and kinds' `centre` / `half` are read; nothing is called).
   * @param {any} phys
   */
  setPhysics(phys) {
    this.phys = phys || null;
    const n = phys ? phys.maxItems | 0 : 0;
    if (n !== this.maxItems) {
      this.maxItems = n;
      this.itemPose = new Float64Array(n * 7).fill(NaN);
      this.itemRec = new Float64Array(n * SH_LEN);
      this.itemOk = new Uint8Array(n);
      this.itemKind = new Int16Array(n).fill(-1);
    }
    this.invalidate();
  }

  /**
   * Enemies: an EnemyManager (brain agents, animators, hit capsules).
   * @param {any} enemies
   */
  setEnemies(enemies) {
    this.enemies = enemies || null;
    if (!enemies || !enemies.capsules) return;
    const C = enemies.capsules, list = [];
    const want = [B.head, B.spine3, B.spine1, B.pelvis, B.thighL, B.calfL, B.thighR, B.calfR, B.upperArmL, B.upperArmR];
    this.footCaps[0] = this.footCaps[1] = -1;
    for (let i = 0; i < C.count; i++) {
      const b = C.bone[i];
      if (b === B.footL) this.footCaps[0] = i;
      if (b === B.footR) this.footCaps[1] = i;
      // one capsule per wanted bone (the first: spine3 also has the shoulder bar, which is wider than useful)
      if (want.includes(b) && !list.some((j) => C.bone[j] === b)) list.push(i);
    }
    this.deadCaps = Int16Array.from(list);
  }

  /**
   * Held guns: a WeaponSystem (`weapons[i].carry.state`, `.view.root`, `.view.gun`).
   * @param {any} weapons
   */
  setWeapons(weapons) {
    this.weapons = weapons || null;
    if (!weapons || !Array.isArray(weapons.weapons)) return;
    const box = new THREE.Box3();
    for (let i = 0; i < weapons.weapons.length && i < 2; i++) {
      const g = weapons.weapons[i].view && weapons.weapons[i].view.gun;
      const geo = g && g.geometry;
      if (!geo) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      box.copy(geo.boundingBox);
      const o = i * 6;
      this.heldBox[o] = (box.min.x + box.max.x) / 2; this.heldBox[o + 1] = (box.min.y + box.max.y) / 2; this.heldBox[o + 2] = (box.min.z + box.max.z) / 2;
      this.heldBox[o + 3] = (box.max.x - box.min.x) / 2; this.heldBox[o + 4] = (box.max.y - box.min.y) / 2; this.heldBox[o + 5] = (box.max.z - box.min.z) / 2;
    }
  }

  /** Forget every frozen item shadow (a world rebuild or realign moved the surfaces). */
  invalidate() {
    this.itemPose.fill(NaN);
    this.itemOk.fill(0);
  }

  /** Hide everything (session end). */
  clear() {
    this.n = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.invalidate();
  }

  /**
   * One frame: gather every caster's blob, write the instances.
   * @param {number} _dt @param {number} _t @param {any} _frame @param {any} [ctx]
   */
  update(_dt, _t, _frame, ctx) {
    if (ctx && ctx.world && ctx.world !== this.world) this.setWorld(ctx.world);
    this.n = 0;
    if (this.enabled) {
      if (this.phys && this.world) this.gatherItems();
      if (this.enemies) this.gatherEnemies();
      if (this.weapons && this.world) this.gatherHeld(_dt);
    }
    this.flush();
  }

  /** Reserve the next record; -1 when full. */
  next() { return this.n < this.capacity ? this.n * SH_LEN : -1; }

  // ─────────────────────────────────────────────────────────── items

  gatherItems() {
    const P = this.phys, st = P.st, cur = P.cur, kinds = P.kinds, kindOf = P.kindOf, n = Math.min(this.maxItems, st.length);
    const C = this.itemPose, R = this.itemRec;
    // paused: the loose magazines are hidden under the veil (the lying guns stay in view)
    const Wp = this.weapons, magsHidden = !!(Wp && Wp.worldRoot && !shown(Wp.worldRoot));
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s !== ST_MOVING && s !== ST_RESTING) { this.itemOk[i] = 0; continue; }
      if (magsHidden && (kindOf[i] === K_MAG9 || kindOf[i] === K_MAG762)) continue; // (its frozen record is kept)
      const k = i * 7;
      let same = s === ST_RESTING && this.itemOk[i] !== 0 && this.itemKind[i] === kindOf[i];
      if (same) for (let j = 0; j < 7; j++) if (C[k + j] !== cur[k + j]) { same = false; break; }
      if (!same) {
        for (let j = 0; j < 7; j++) C[k + j] = cur[k + j];
        this.itemKind[i] = kindOf[i];
        const K = kinds[kindOf[i]];
        this.itemOk[i] = K && this.itemShadow(cur, k, K.centre, K.half, R, i * SH_LEN) ? 1 : 2;
      } else this.stats.frozen++;
      if (this.itemOk[i] !== 1) continue;
      const o = this.next();
      if (o < 0) return;
      for (let j = 0; j < SH_LEN; j++) this.rec[o + j] = R[i * SH_LEN + j];
      this.n++;
    }
  }

  /**
   * Shadow of one box-shaped item at pose p[k..k+6] (x, y, z, qx, qy, qz, qw).
   * @param {ArrayLike<number>} p @param {number} k @param {ArrayLike<number>} centre @param {ArrayLike<number>} half
   * @param {Float64Array} out @param {number} o
   */
  itemShadow(p, k, centre, half, out, o) {
    const qx = p[k + 3], qy = p[k + 4], qz = p[k + 5], qw = p[k + 6];
    if (!Number.isFinite(qx + qy + qz + qw + p[k] + p[k + 1] + p[k + 2])) return false;
    const X = this._box;
    // world centre of the box = position + q · centre
    rotate(qx, qy, qz, qw, centre[0], centre[1], centre[2], X);
    X[0] += p[k]; X[1] += p[k + 1]; X[2] += p[k + 2];
    X[3] = qx; X[4] = qy; X[5] = qz; X[6] = qw;
    X[7] = half[0]; X[8] = half[1]; X[9] = half[2];
    X[10] = 1.6; X[11] = SHADOW.itemAlpha; X[12] = SHADOW.itemSoftAlpha; X[13] = SHADOW.itemSoft; X[14] = SHADOW.itemSoftSoft; X[15] = SHADOW.fadeH;
    const H = this._hit;
    this.stats.rays++;
    if (!this.world.raycast(X[0], X[1], X[2], 0, -1, 0, X[10], H)) return false;
    const S = this._sp;
    S[0] = H.x; S[1] = H.y; S[2] = H.z; S[3] = H.nx; S[4] = H.ny; S[5] = H.nz;
    return this.boxOnSurface(isSoftSurface(H.surface), out, o);
  }

  /**
   * The footprint of the box in `_box` on the surface point and normal in `_sp`.
   * @param {boolean} soft @param {Float64Array} out @param {number} o
   */
  boxOnSurface(soft, out, o) {
    const X = this._box, Wv = this._w, Q = this._bf, S = this._sp;
    const px = S[0], py = S[1], pz = S[2];
    let nx = S[3], ny = S[4], nz = S[5];
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny < 0.35) return false; // a steep face: no blob (it would stand on edge)
    Q[0] = X[3]; Q[1] = X[4]; Q[2] = X[5]; Q[3] = X[6]; Q[4] = X[7]; Q[5] = X[8]; Q[6] = X[9]; Q[7] = nx; Q[8] = ny; Q[9] = nz;
    const F = boxFootprint(Q, this._f);
    Wv[W.PX] = px; Wv[W.PY] = py; Wv[W.PZ] = pz;
    Wv[W.NX] = nx; Wv[W.NY] = ny; Wv[W.NZ] = nz;
    Wv[W.AX] = F[0]; Wv[W.AY] = F[1]; Wv[W.AZ] = F[2];
    Wv[W.A] = F[3] * SHADOW.itemCover; Wv[W.B] = F[4] * SHADOW.itemCover + 0.004;
    // height of the lowest point above the surface, along the normal
    Wv[W.H] = (X[0] - px) * nx + (X[1] - py) * ny + (X[2] - pz) * nz - F[5];
    Wv[W.ALPHA] = soft ? X[12] : X[11];
    Wv[W.SOFT] = soft ? X[14] : X[13];
    Wv[W.PULL] = soft ? SHADOW.pullSoft : SHADOW.pullHard;
    Wv[W.LX] = this.light[0]; Wv[W.LY] = this.light[1]; Wv[W.LZ] = this.light[2];
    Wv[W.FADE] = X[15];
    return writeShadow(out, o, Wv);
  }

  // ─────────────────────────────────────────────────────────── enemies

  gatherEnemies() {
    const E = this.enemies, ag = E.brain && E.brain.agents;
    if (!ag) return;
    const L = this.light, cs = E.capsules, Wv = this._w, cp = this._cp;
    Wv[W.NX] = 0; Wv[W.NY] = 1; Wv[W.NZ] = 0; Wv[W.AY] = 0;
    Wv[W.LX] = L[0]; Wv[W.LY] = L[1]; Wv[W.LZ] = L[2];
    Wv[W.PULL] = SHADOW.pullHard;
    const rigs = E.pool && E.pool.rigs ? E.pool.rigs : null;
    for (let i = 0; i < E.max; i++) {
      const a = ag[i];
      if (!a.active) continue;
      if (rigs !== null && rigs[i] && !shown(rigs[i].root)) continue; // hidden (the pause veil): no blob without a body
      const an = E.anims[i], hb = E.hitboxes[i];
      if (!hb || !hb.valid) continue;
      cp[1] = an.rootY;
      Wv[W.PY] = an.rootY;
      if (!an.dead) {
        for (let f = 0; f < 2; f++) {
          const ci = this.footCaps[f];
          if (ci < 0) continue;
          const o = this.next();
          if (o < 0) return;
          cp[0] = cs.radius[ci] * hb.k;
          const C = capsuleFloor(hb.a, hb.b, ci * 3, cp, this._c);
          Wv[W.PX] = C[0]; Wv[W.PZ] = C[1]; Wv[W.AX] = C[2]; Wv[W.AZ] = C[3];
          Wv[W.A] = C[4] > SHADOW.footA ? C[4] : SHADOW.footA; Wv[W.B] = SHADOW.footB; Wv[W.H] = C[6];
          Wv[W.ALPHA] = SHADOW.footAlpha; Wv[W.SOFT] = 0.55; Wv[W.FADE] = SHADOW.footFadeH;
          if (writeShadow(this.rec, o, Wv)) this.n++;
        }
        const o = this.next();
        if (o < 0) return;
        Wv[W.PX] = hb.cx; Wv[W.PZ] = hb.cz;
        Wv[W.AX] = Math.cos(an.rootYaw); Wv[W.AZ] = -Math.sin(an.rootYaw);
        Wv[W.A] = SHADOW.bodyA; Wv[W.B] = SHADOW.bodyB; Wv[W.H] = 0;
        Wv[W.ALPHA] = SHADOW.bodyAlpha; Wv[W.SOFT] = 0.88; Wv[W.FADE] = SHADOW.fadeH;
        if (writeShadow(this.rec, o, Wv)) this.n++;
      } else {
        const D = this.deadCaps;
        Wv[W.ALPHA] = SHADOW.deadAlpha; Wv[W.SOFT] = SHADOW.deadSoft; Wv[W.FADE] = SHADOW.deadFadeH;
        for (let j = 0; j < D.length; j++) {
          const ci = D[j];
          const o = this.next();
          if (o < 0) return;
          cp[0] = cs.radius[ci] * hb.k;
          const C = capsuleFloor(hb.a, hb.b, ci * 3, cp, this._c);
          Wv[W.PX] = C[0]; Wv[W.PZ] = C[1]; Wv[W.AX] = C[2]; Wv[W.AZ] = C[3];
          Wv[W.A] = C[4]; Wv[W.B] = C[5]; Wv[W.H] = C[6];
          if (writeShadow(this.rec, o, Wv)) this.n++;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────── held guns

  /** @param {number} dt */
  gatherHeld(dt) {
    const Wp = this.weapons.weapons;
    if (!Wp) return;
    for (let i = 0; i < Wp.length && i < 2; i++) {
      const w = Wp[i];
      const P = this.heldPlane, pb = i * 8;
      if (!w.carry || w.carry.state !== CARRY_HAND || !w.view || !w.view.root.visible) { P[pb + 7] = 0; this.heldClock[i] = 0; continue; }
      const r = w.view.root, q = r.quaternion, X = this._box, b = i * 6;
      rotate(q.x, q.y, q.z, q.w, this.heldBox[b], this.heldBox[b + 1], this.heldBox[b + 2], X);
      X[0] += r.position.x; X[1] += r.position.y; X[2] += r.position.z;
      X[3] = q.x; X[4] = q.y; X[5] = q.z; X[6] = q.w;
      X[7] = this.heldBox[b + 3]; X[8] = this.heldBox[b + 4]; X[9] = this.heldBox[b + 5];
      X[10] = SHADOW.heldMaxH + 0.4; X[11] = SHADOW.heldAlpha; X[12] = SHADOW.heldAlpha; X[13] = 0.8; X[14] = 0.85; X[15] = SHADOW.heldMaxH;
      // the surface below: re-cast at 36 Hz while a surface is near, 6 Hz otherwise
      this.heldClock[i] -= dt > 0 ? dt : 0;
      if (this.heldClock[i] <= 0) {
        const H = this._hit;
        this.stats.rays++;
        if (this.world.raycast(X[0], X[1], X[2], 0, -1, 0, X[10], H)) {
          P[pb] = H.x; P[pb + 1] = H.y; P[pb + 2] = H.z; P[pb + 3] = H.nx; P[pb + 4] = H.ny; P[pb + 5] = H.nz;
          P[pb + 6] = isSoftSurface(H.surface) ? 1 : 0; P[pb + 7] = 1;
        } else P[pb + 7] = 0;
        this.heldClock[i] = P[pb + 7] && X[1] - P[pb + 1] < SHADOW.heldMaxH + 0.3 ? 1 / 36 : 1 / 6;
      }
      if (!P[pb + 7]) continue;
      const o = this.next();
      if (o < 0) return;
      // the plane stays; the point under the gun follows it every frame
      const nx = P[pb + 3], ny = P[pb + 4], nz = P[pb + 5];
      const dd = (X[0] - P[pb]) * nx + (X[1] - P[pb + 1]) * ny + (X[2] - P[pb + 2]) * nz;
      const S = this._sp;
      S[0] = X[0] - nx * dd; S[1] = X[1] - ny * dd; S[2] = X[2] - nz * dd; S[3] = nx; S[4] = ny; S[5] = nz;
      if (this.boxOnSurface(P[pb + 6] === 1, this.rec, o)) this.n++;
    }
  }

  // ─────────────────────────────────────────────────────────── instances

  /** Write the records into the instance buffers (only the live range). */
  flush() {
    const n = this.n, mesh = this.mesh;
    if (n === 0) {
      if (mesh.visible) { mesh.count = 0; mesh.visible = false; }
      return;
    }
    const M = mesh.instanceMatrix.array, Cc = /** @type {THREE.InstancedBufferAttribute} */ (mesh.instanceColor), C = Cc.array, R = this.rec;
    for (let i = 0; i < n; i++) {
      const o = i * SH_LEN, m = i * 16, c = i * 3;
      const nx = R[o + SH.NX], ny = R[o + SH.NY], nz = R[o + SH.NZ];
      const ax = R[o + SH.AX], ay = R[o + SH.AY], az = R[o + SH.AZ];
      // minor axis = major × n: (major, n, minor) is a right-handed basis (a mirrored one would flip the
      // quad's winding and cull it)
      const bx = ay * nz - az * ny, by = az * nx - ax * nz, bz = ax * ny - ay * nx;
      const A = R[o + SH.A] * 2, Bm = R[o + SH.B] * 2;
      M[m] = ax * A; M[m + 1] = ay * A; M[m + 2] = az * A; M[m + 3] = 0;
      M[m + 4] = nx; M[m + 5] = ny; M[m + 6] = nz; M[m + 7] = 0;
      M[m + 8] = bx * Bm; M[m + 9] = by * Bm; M[m + 10] = bz * Bm; M[m + 11] = 0;
      M[m + 12] = R[o + SH.CX] + nx * 0.003; M[m + 13] = R[o + SH.CY] + ny * 0.003; M[m + 14] = R[o + SH.CZ] + nz * 0.003; M[m + 15] = 1;
      C[c] = R[o + SH.ALPHA]; C[c + 1] = R[o + SH.SOFT]; C[c + 2] = R[o + SH.PULL];
    }
    mesh.count = n;
    mesh.visible = true;
    // whole-buffer uploads (6 KB + 1 KB): three's update ranges allocate (a range object per add, a
    // sort closure per upload), a plain bufferSubData of the fixed array does not
    mesh.instanceMatrix.needsUpdate = true;
    Cc.needsUpdate = true;
    if (n > this.stats.maxLive) this.stats.maxLive = n;
  }

  /**
   * Warm-up: one blob in front of (x, y, z), visible; off: cleared.
   * @param {boolean} on @param {number} [x] @param {number} [y] @param {number} [z]
   */
  setWarm(on, x = 0, y = 0, z = -2) {
    if (!on) { this.clear(); return; }
    const Wv = this._w;
    Wv.fill(0);
    Wv[W.PX] = x; Wv[W.PY] = y; Wv[W.PZ] = z; Wv[W.NY] = 1; Wv[W.AX] = 1; Wv[W.A] = 0.2; Wv[W.B] = 0.1;
    Wv[W.ALPHA] = 0.5; Wv[W.SOFT] = 0.5; Wv[W.PULL] = 0.01; Wv[W.LY] = 1; Wv[W.FADE] = 0.3;
    this.n = writeShadow(this.rec, 0, Wv) ? 1 : 0;
    this.flush();
  }

  /**
   * Run the blob maths and the instance writes a few thousand times at load
   * (the JIT optimises them before play), then clear.
   */
  warmUp() {
    const Q = this._bf, Wv = this._w, F = this._f, C = this._c, cp = this._cp;
    const A = new Float64Array(3), Bv = new Float64Array([0.3, 0.1, 0.2]);
    for (let i = 0; i < 3000; i++) {
      const a = i * 0.01;
      Q[0] = Math.sin(a) * 0.5; Q[1] = 0.5; Q[2] = 0.1; Q[3] = Math.cos(a); Q[4] = 0.02; Q[5] = 0.07; Q[6] = 0.1; Q[7] = 0; Q[8] = 1; Q[9] = 0;
      boxFootprint(Q, F);
      cp[0] = 0.09; cp[1] = 0;
      capsuleFloor(A, Bv, 0, cp, C);
      Wv[W.PX] = a; Wv[W.PY] = 0; Wv[W.PZ] = -2; Wv[W.NX] = 0; Wv[W.NY] = 1; Wv[W.NZ] = 0; Wv[W.AX] = F[0]; Wv[W.AY] = F[1]; Wv[W.AZ] = F[2];
      Wv[W.A] = F[3]; Wv[W.B] = F[4]; Wv[W.H] = (i % 30) * 0.01; Wv[W.ALPHA] = 0.5; Wv[W.SOFT] = 0.5; Wv[W.PULL] = 0.01;
      Wv[W.LX] = 0.3; Wv[W.LY] = 0.9; Wv[W.LZ] = 0.3; Wv[W.FADE] = 0.3;
      const o = (i % this.capacity) * SH_LEN;
      writeShadow(this.rec, o, Wv);
      if (i % 30 === 0) { this.n = Math.min(this.capacity, 1 + (i % this.capacity)); this.flush(); }
    }
    this.clear();
    this.stats.maxLive = 0; this.stats.rays = 0; this.stats.frozen = 0;
  }

  report() {
    return { capacity: this.capacity, maxLive: this.stats.maxLive, rays: this.stats.rays, frozen: this.stats.frozen };
  }
}

/**
 * v rotated by the unit quaternion q, into out[0..2].
 * @param {number} qx @param {number} qy @param {number} qz @param {number} qw
 * @param {number} vx @param {number} vy @param {number} vz @param {Float64Array} out
 */
function rotate(qx, qy, qz, qw, vx, vy, vz, out) {
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}
