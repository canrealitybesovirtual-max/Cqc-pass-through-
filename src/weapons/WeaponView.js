// @ts-check
import * as THREE from 'three';
import { computeFit, MAG_IN_LEFT, AKM_SUPPORT_TARGET } from './GunFit.js';

/**
 * One weapon's view (CONTRACTS.md "W2"): the baked gun mesh in the hand, its
 * moving parts, the seated magazine and the magazine in the support hand.
 *
 * Hold (v0.3, research-fit A): the gun is fitted to the real Touch Plus
 * hand in GRIP space, not to the aim ray (v0.2 copied CQC's ray hold, which
 * only works behind a drawn glove: in passthrough the gun pointed 24–29° up
 * along the handle and sat above the controller). `GunFit.computeFit` gives
 * the gun root in grip space (grip axis along the handle, trigger on the
 * controller's trigger) plus the player's nudges; `setFit` takes it.
 * `palm` = the grip origin in gun space: the recoil and two-handed pivot.
 * Shots go along the bore (`shotDir`). Slots anchor the manifest grip centre
 * (`gripCentre`), so a fit change never moves a holstered gun. The camera
 * never moves.
 *
 * Part motion: ONE draw for the whole gun. Its material gets an
 * `onBeforeCompile` vertex hook with `uniform mat4 uPart[5]`, picked per
 * vertex by the baked `_part` attribute (0 static, 1 slide / carrier,
 * 2 trigger, 3 Glock slide stop / AKM selector, 4 magazine catch), and a
 * constant `customProgramCacheKey`, so both guns (and the magazines, which
 * get an all-zero `_part`) share one program, built at the warm-up.
 * Matrices are gun space (metres, +Y up, −Z muzzle) and written into one
 * Float32Array(80) per gun, so a frame uploads them without allocating.
 */

/** Per-weapon tuning (gun space; CQC values unless marked design). The hold itself is GunFit's. */
export const FIT = Object.freeze({
  glock: Object.freeze({
    /** m: the bullet path crosses the sight line here (CQC pistol zero 15 m) */
    zero: 15,
    /** mechanical dispersion, radius of a uniform disc (rad) (CQC spread) */
    spread: 0.0016,
    /** magazine capture depth below the seat (CQC magWindow) */
    magWindow: 0.15,
    /** AK-style rock-in angle (rad); 0 = straight insertion */
    rock: 0,
    flash: Object.freeze([0.06, 0.075]),   // m flash size (CQC)
    flashLight: 24,                         // cd (CQC flashLight)
    brassSpeed: 2.55,                       // m/s (CQC ejectVel [1.5, 1.9, 0.8])
    caseRL: Object.freeze([0.0049, 0.0192]),   // 9x19 case radius, length
    decal: 0.04,                            // m decal quad
    hole: 0.0045,                           // m hole radius
  }),
  akm: Object.freeze({
    zero: 25,
    spread: 0.0019,
    magWindow: 0.07,
    rock: 0.3,                                // rad: front lug in first, then rocked back (design)
    flash: Object.freeze([0.10, 0.13]),
    flashLight: 26,
    brassSpeed: 3.1,                          // m/s (CQC ejectVel [2.8, 1.2, -0.3])
    caseRL: Object.freeze([0.0056, 0.0386]),  // 7.62x39 case
    decal: 0.045,
    hole: 0.004,
  }),
});

/** The program key every hooked material shares. */
export const PART_KEY = 'w2-part5';

/**
 * Add the uPart vertex hook to a standard material (in place).
 * @param {THREE.Material} mat
 * @param {{ value: Float32Array }} uniform
 */
export function hookPartMaterial(mat, uniform) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPart = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _part;\nuniform mat4 uPart[ 5 ];')
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nmat4 wPartM = uPart[ int( _part + 0.5 ) ];\nobjectNormal = mat3( wPartM ) * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = ( wPartM * vec4( transformed, 1.0 ) ).xyz;');
  };
  mat.customProgramCacheKey = () => PART_KEY;
}

const IDENT = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);

/** @param {number[]} a */
const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class WeaponView {
  /**
   * @param {'glock'|'akm'} id
   * @param {{ gun: THREE.Mesh, mag: THREE.Mesh, manifest: any }} model assets.models[id] (its meshes are taken over)
   */
  constructor(id, model) {
    this.id = id;
    /** @type {any} */
    this.fit = FIT[id];
    const M = this.manifest = model.manifest;

    this.root = new THREE.Group();
    this.root.name = `w2-${id}`;
    this.gun = model.gun;
    this.gun.removeFromParent();
    this.gun.position.set(0, 0, 0);
    this.gun.quaternion.identity();
    this.root.add(this.gun);
    this.mag = model.mag;
    this.mag.removeFromParent();
    this.magSeat = vec(M.magLocalSeat);
    this.mag.position.copy(this.magSeat);
    this.mag.quaternion.identity();
    this.root.add(this.mag);
    /** The magazine in the support hand: same geometry and material, world space. */
    this.handMag = new THREE.Mesh(this.mag.geometry, this.mag.material);
    this.handMag.name = `w2-${id}-handmag`;
    this.handMag.visible = false;
    for (const m of [this.gun, this.mag, this.handMag]) { m.renderOrder = 10; m.castShadow = false; m.receiveShadow = false; }

    // Part motion: the gun material (shared with its magazine) gets the hook; magazines read part 0.
    this.uPart = { value: new Float32Array(80) };
    for (let i = 0; i < 5; i++) IDENT.toArray(this.uPart.value, i * 16);
    this.material = /** @type {THREE.MeshStandardMaterial} */ (this.gun.material);
    hookPartMaterial(this.material, this.uPart);
    if (this.mag.material !== this.material) hookPartMaterial(/** @type {THREE.Material} */ (this.mag.material), this.uPart);
    // Gloved hands (v0.3, tools/assets/hands.mjs): meshes `hand_r` / `hand_l` in the gun GLB, in gun
    // space. Children of the root, so they move with the gun (recoil included); the index finger's
    // distal segment has _part 2 and follows the trigger blade. Same texture slots and shader hook
    // as the gun (double-sided, below). Shown only while the gun is held (the left one with the left hand on the handguard).
    /** @type {THREE.Mesh | null} */
    this.handR = takeMesh(model, 'hand_r');
    /** @type {THREE.Mesh | null} */
    this.handL = takeMesh(model, 'hand_l');
    for (const h of [this.handR, this.handL]) {
      if (!h) continue;
      this.root.add(h);
      h.visible = false;
      h.renderOrder = 10;
      const hm = /** @type {THREE.MeshStandardMaterial} */ (h.material);
      if (!hm.onBeforeCompile || hm.customProgramCacheKey() !== PART_KEY) {
        hookPartMaterial(hm, this.uPart);
        hm.envMapIntensity = 0.45;   // cloth and leather: no shine (CQC: cloth looked shiny at 1)
      }
      // Both sides: the pack glove is an open shell (a viewmodel is only ever seen from the side), so
      // from the shooter's eye, behind the hand, the culled cuff and palm read as a thin black wing
      // over the grip (v0.3 verifier screenshots). Set here, before the warm-up compiles it (one
      // program for both gloves; nothing changes it later).
      hm.side = THREE.DoubleSide;
      if (!h.geometry.attributes._part) h.geometry.setAttribute('_part', new THREE.BufferAttribute(new Float32Array(h.geometry.attributes.position.count), 1));
    }
    const mg = this.mag.geometry;
    if (!mg.attributes._part) mg.setAttribute('_part', new THREE.BufferAttribute(new Float32Array(mg.attributes.position.count), 1));
    // The slide / carrier and trigger move up to ~7 cm in the shader: widen the cull sphere.
    const gg = this.gun.geometry;
    if (!gg.boundingSphere) gg.computeBoundingSphere();
    if (gg.boundingSphere) gg.boundingSphere.radius += 0.08;
    if (!mg.boundingBox) mg.computeBoundingBox();
    /** Magazine centre (mag space), for its ballistics once dropped. */
    this.magCentre = new THREE.Vector3();
    if (mg.boundingBox) mg.boundingBox.getCenter(this.magCentre);
    this.magHalf = new THREE.Vector3();
    if (mg.boundingBox) mg.boundingBox.getSize(this.magHalf).multiplyScalar(0.5);

    // Hold in grip space (GunFit): gun root pose in the right grip frame, and the palm point.
    /** Gun root in grip space. */
    this.fitPos = new THREE.Vector3();
    this.fitQuat = new THREE.Quaternion();
    /** Palm point (gun space): the controller's grip origin sits here. */
    this.palm = new THREE.Vector3();
    this._pose7 = new Float64Array(7);
    this._palm3 = new Float64Array(3);
    computeFit(id, null, this._pose7, this._palm3);
    this.setFit(this._pose7, this._palm3);
    /** Manifest grip centre (gun space): the point the holster and the sling anchor. */
    this.gripCentre = vec(M.grip.pos);
    this.muzzle = vec(M.muzzle);
    this.port = vec(M.ejectionPort);
    this.ejectDir = vec(M.ejectDir).normalize();
    this.slideAxis = vec(M.slide.axis).normalize();
    this.travel = M.slide.travel;
    this.rackPoint = vec(M.slide.rackPoint);
    this.magAxis = vec(M.magWell.axis).normalize();
    this.support = M.support ? vec(M.support.pos) : null;
    /** Where the left grip origin sits on the handguard (two-handed aim); the manifest point stays the grab zone. */
    this.supportTarget = this.support ? (id === 'akm' ? vec(/** @type {number[]} */ (/** @type {unknown} */ (AKM_SUPPORT_TARGET))) : this.support.clone()) : null;
    const sY = M.sights ? M.sights.front[1] : 0;
    /** Shot line in gun space: from the breech, crossing the sight line at the zero distance. */
    this.shotDir = new THREE.Vector3(0, sY, -this.fit.zero).normalize();
    // AK rock-in: pivot on the front lug of the magazine's top.
    this.lug = new THREE.Vector3(0, 0, 0);
    {
      const p = /** @type {THREE.BufferAttribute} */ (mg.attributes.position);
      let zMin = 0;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > -0.02 && p.getZ(i) < zMin) zMin = p.getZ(i);
      this.lug.set(0, 0, zMin);
    }
    // Magazine in the free (left) hand, in left grip space (GunFit.MAG_IN_LEFT).
    const MH = MAG_IN_LEFT[id];
    this.magHoldPos = new THREE.Vector3().fromArray(/** @type {number[]} */ (/** @type {unknown} */ (MH.pos)));
    this.magHoldQuat = new THREE.Quaternion().fromArray(/** @type {number[]} */ (/** @type {unknown} */ (MH.quat))).normalize();

    // Parts (gun space): 1 slides along the slide axis, 2 turns about the trigger pin,
    // 3 turns about the slide-stop / selector pin, 4 slides along the catch axis.
    this.slide = new Shift(this.slideAxis);
    this.trig = new Pivot(vec(M.trigger.pivot), vec(M.trigger.axis).normalize());
    this.trigPull = M.trigger.pullRad;
    /** @type {(Pivot & { angles: Record<string, number>, lift: number }) | null} */
    this.p3 = null;
    if (M.slideStop) {
      const pivot = vec(M.slideStop.pivot), axis = vec(M.slideStop.axis).normalize();
      // The manifest says the front rises into the slide notch; pick the sign that does that.
      const s = this._lifts(pivot, axis, 1) ? 1 : -1;
      this.p3 = Object.assign(new Pivot(pivot, axis), { angles: {}, lift: s * M.slideStop.liftRad });
    } else if (M.selector) {
      const S = M.selector;
      this.p3 = Object.assign(new Pivot(vec(S.pivot), vec(S.axis).normalize()), { angles: { safe: S.safe, auto: S.auto, semi: S.semi }, lift: 0 });
    }
    this.catch = new Shift(M.magCatch ? vec(M.magCatch.axis).normalize() : new THREE.Vector3(1, 0, 0));
    this.catchTravel = M.magCatch ? M.magCatch.travel : 0;

    // Smoothed part state (the model only; the mechanism is WeaponInstance).
    this.trigVis = 0;
    this.p3Vis = 0;
    this.catchVis = 0;
    /** Seated magazine pushed this far out along the well (m; seating stroke, assisted reload). */
    this.magOut = 0;

    // Current world pose of the gun root (gun-space origin = breech, on the bore).
    this.pos = this.root.position;
    this.quat = this.root.quaternion;
  }

  /**
   * Does a rotation by `sign` about the axis at the pivot lift a point 1 cm in front of it?
   * @param {THREE.Vector3} pivot @param {THREE.Vector3} axis @param {number} sign
   */
  _lifts(pivot, axis, sign) {
    _m.makeRotationAxis(axis, 0.1 * sign);
    _v.set(0, 0, -0.01).applyMatrix4(_m);
    return _v.y > 0;
  }

  // ------------------------------------------------------------------ poses

  /**
   * Take a grip fit (GunFit.computeFit output). Allocation-free.
   * @param {ArrayLike<number>} pose7 gun root in right grip space [px, py, pz, qx, qy, qz, qw]
   * @param {ArrayLike<number>} palm3 grip origin in gun space
   */
  setFit(pose7, palm3) {
    this.fitPos.set(pose7[0], pose7[1], pose7[2]);
    this.fitQuat.set(pose7[3], pose7[4], pose7[5], pose7[6]).normalize();
    this.palm.set(palm3[0], palm3[1], palm3[2]);
  }

  /**
   * Gun root from the right controller's GRIP pose and the fit.
   * @param {THREE.Vector3} gripPos @param {THREE.Quaternion} gripQuat grip-space orientation
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  holdPose(gripPos, gripQuat, outPos, outQuat) {
    outPos.copy(this.fitPos).applyQuaternion(gripQuat).add(gripPos);
    outQuat.copy(gripQuat).multiply(this.fitQuat);
  }

  /**
   * Gun root from a slot frame: the grip centre at `anchor`, gun orientation `q`.
   * @param {THREE.Vector3} anchor @param {THREE.Quaternion} q
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  slotPose(anchor, q, outPos, outQuat) {
    outQuat.copy(q);
    outPos.copy(this.gripCentre).negate().applyQuaternion(q).add(anchor);
  }

  /**
   * Recoil on top of a gun-root pose, turning about the palm point: back along
   * gun +Z, then Rx(pitch)·Ry(yaw) (Recoil.js conventions).
   * @param {THREE.Vector3} pos @param {THREE.Quaternion} quat base pose
   * @param {number} back @param {number} pitch @param {number} yaw
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat (may alias the base)
   */
  applyRecoil(pos, quat, back, pitch, yaw, outPos, outQuat) {
    // palm in the world, plus the back offset in gun space
    _v.copy(this.palm).applyQuaternion(quat).add(pos);
    _v2.set(0, 0, back).applyQuaternion(quat);
    _v.add(_v2);
    _q.setFromAxisAngle(_X, pitch);
    _q2.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    _q.multiply(_q2);
    outQuat.copy(quat).multiply(_q);
    outPos.copy(this.palm).negate().applyQuaternion(outQuat).add(_v);
  }

  /**
   * Place the root (and so the gun and its seated magazine).
   * @param {THREE.Vector3} pos @param {THREE.Quaternion} quat @param {number} [scale]
   */
  setPose(pos, quat, scale = 1) {
    if (pos !== this.root.position) this.root.position.copy(pos);
    if (quat !== this.root.quaternion) this.root.quaternion.copy(quat);
    this.root.scale.setScalar(scale > 1e-3 ? scale : 1e-3);
  }

  /**
   * Gun-space point to world, with the current root pose.
   * @param {THREE.Vector3} local @param {THREE.Vector3} out
   */
  toWorld(local, out) { return out.copy(local).applyQuaternion(this.root.quaternion).add(this.root.position); }

  /**
   * Gun-space direction to world.
   * @param {THREE.Vector3} local @param {THREE.Vector3} out
   */
  dirWorld(local, out) { return out.copy(local).applyQuaternion(this.root.quaternion); }

  /**
   * World point into the gun space of a given root pose.
   * @param {THREE.Vector3} world @param {THREE.Vector3} pos @param {THREE.Quaternion} quat @param {THREE.Vector3} out
   */
  toLocal(world, pos, quat, out) {
    _q.copy(quat).invert();
    return out.copy(world).sub(pos).applyQuaternion(_q);
  }

  /**
   * Aim a two-handed rifle: turn the hold (as little as possible, about the
   * palm) so the palm-to-support-target line runs from the firing grip to the
   * support grip.
   * @param {THREE.Quaternion} quat hold orientation (in / out)
   * @param {THREE.Vector3} gripPos firing grip @param {THREE.Vector3} supportPos support grip
   * @param {THREE.Vector3} outPos gun root
   * @returns {boolean} turned (hands far enough apart)
   */
  aimTwoHanded(quat, gripPos, supportPos, outPos, minSpan = 0.12) {
    if (!this.support) return false;
    _v2.subVectors(supportPos, gripPos);
    const span = _v2.length();
    if (!(span > minSpan)) return false;
    _v2.multiplyScalar(1 / span);
    _v.subVectors(/** @type {THREE.Vector3} */ (this.supportTarget), this.palm).normalize().applyQuaternion(quat);
    _q.setFromUnitVectors(_v, _v2);
    quat.premultiply(_q);
    outPos.copy(this.palm).negate().applyQuaternion(quat).add(gripPos);
    return true;
  }

  /**
   * The magazine in the free (left) hand, from its GRIP pose.
   * @param {THREE.Vector3} gripPos @param {THREE.Quaternion} gripQuat
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  handMagPose(gripPos, gripQuat, outPos, outQuat) {
    outQuat.copy(gripQuat).multiply(this.magHoldQuat);
    outPos.copy(this.magHoldPos).applyQuaternion(gripQuat).add(gripPos);
  }

  /**
   * A magazine captured by the well, `along` m from the seat (≤ 0 below), in gun space.
   * AK magazines hook the front lug and rock back over the last 5 cm.
   * @param {number} along @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat gun space
   */
  guidedMagLocal(along, outPos, outQuat) {
    const d = along < 0 ? along : 0;
    outPos.copy(this.magSeat).addScaledVector(this.magAxis, d);
    const a = this.fit.rock * smooth01(-d / 0.05);
    if (a > 0) {
      outQuat.setFromAxisAngle(_X, a);
      // rotate about the front lug: p' = lug + R (p - lug), here p = origin
      _v.copy(this.lug).negate().applyQuaternion(outQuat).add(this.lug);
      outPos.add(_v);
    } else outQuat.identity();
  }

  /**
   * Gun-space pose to world with a root pose.
   * @param {THREE.Vector3} lp @param {THREE.Quaternion} lq
   * @param {THREE.Vector3} pos @param {THREE.Quaternion} quat
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  localToWorldPose(lp, lq, pos, quat, outPos, outQuat) {
    outPos.copy(lp).applyQuaternion(quat).add(pos);
    outQuat.copy(quat).multiply(lq);
  }

  // ------------------------------------------------------------------ parts

  /**
   * Write this frame's part matrices.
   * @param {number} dt
   * @param {{ slidePos: number, stopRaised: boolean, mode: string }} w WeaponInstance
   * @param {number} trigger analog value of the finger (0 when not held)
   * @param {boolean} catchDown magazine catch pressed
   */
  updateParts(dt, w, trigger, catchDown) {
    const k40 = 1 - Math.exp(-40 * (dt > 0 ? dt : 0)), k25 = 1 - Math.exp(-25 * (dt > 0 ? dt : 0));
    this.trigVis += ((trigger > 0 ? (trigger < 1 ? trigger : 1) : 0) - this.trigVis) * k40;
    this.catchVis += ((catchDown ? 1 : 0) - this.catchVis) * k40;
    const P = this.p3;
    let a3 = 0;
    if (P) a3 = P.lift ? (w.stopRaised ? P.lift : 0) : (P.angles[w.mode] || 0);
    this.p3Vis += (a3 - this.p3Vis) * (P && P.lift ? k40 : k25);
    const U = this.uPart.value;
    this.slide.d = w.slidePos * this.travel;
    writeShift(U, 16, this.slide);
    this.trig.angle = this.trigVis * this.trigPull;
    writePivot(U, 32, this.trig);
    if (P) { P.angle = this.p3Vis; writePivot(U, 48, P); }
    this.catch.d = this.catchVis * this.catchTravel;
    writeShift(U, 64, this.catch);
    // seated magazine (pushed out along the well while it slides home)
    const mp = this.mag.position, ms = this.magSeat, ma = this.magAxis, mo = this.magOut;
    mp.x = ms.x - ma.x * mo; mp.y = ms.y - ma.y * mo; mp.z = ms.z - ma.z * mo;
  }

  /**
   * Rack point at the current slide position (gun space).
   * @param {number} slidePos fraction of travel @param {THREE.Vector3} out
   */
  rackLocal(slidePos, out) { return out.copy(this.rackPoint).addScaledVector(this.slideAxis, slidePos * this.travel); }
}

/** A part that turns `angle` rad about the unit `axis` through `pivot` (gun space). */
export class Pivot {
  /** @param {THREE.Vector3} pivot @param {THREE.Vector3} axis */
  constructor(pivot, axis) { this.pivot = pivot; this.axis = axis; this.angle = 0; }
}

/** A part that slides `d` m along the unit `axis` (gun space). */
export class Shift {
  /** @param {THREE.Vector3} axis */
  constructor(axis) { this.axis = axis; this.d = 0; }
}

/**
 * Write T(p) · R(axis, angle) · T(−p), column-major, at U[o .. o+15]. The
 * numbers stay inside (descriptor in, nothing returned), so nothing is boxed.
 * @param {Float32Array} U @param {number} o @param {Pivot} P
 */
export function writePivot(U, o, P) {
  const a = P.axis, x = a.x, y = a.y, z = a.z, c = Math.cos(P.angle), s = Math.sin(P.angle), t = 1 - c;
  const r00 = t * x * x + c, r01 = t * x * y - s * z, r02 = t * x * z + s * y;
  const r10 = t * x * y + s * z, r11 = t * y * y + c, r12 = t * y * z - s * x;
  const r20 = t * x * z - s * y, r21 = t * y * z + s * x, r22 = t * z * z + c;
  const p = P.pivot, px = p.x, py = p.y, pz = p.z;
  U[o] = r00; U[o + 1] = r10; U[o + 2] = r20; U[o + 3] = 0;
  U[o + 4] = r01; U[o + 5] = r11; U[o + 6] = r21; U[o + 7] = 0;
  U[o + 8] = r02; U[o + 9] = r12; U[o + 10] = r22; U[o + 11] = 0;
  U[o + 12] = px - (r00 * px + r01 * py + r02 * pz);
  U[o + 13] = py - (r10 * px + r11 * py + r12 * pz);
  U[o + 14] = pz - (r20 * px + r21 * py + r22 * pz);
  U[o + 15] = 1;
}

/**
 * Write the translation axis · d, column-major, at U[o .. o+15].
 * @param {Float32Array} U @param {number} o @param {Shift} S
 */
export function writeShift(U, o, S) {
  const a = S.axis, d = S.d;
  U[o] = 1; U[o + 1] = 0; U[o + 2] = 0; U[o + 3] = 0;
  U[o + 4] = 0; U[o + 5] = 1; U[o + 6] = 0; U[o + 7] = 0;
  U[o + 8] = 0; U[o + 9] = 0; U[o + 10] = 1; U[o + 11] = 0;
  U[o + 12] = a.x * d; U[o + 13] = a.y * d; U[o + 14] = a.z * d; U[o + 15] = 1;
}

/**
 * Take a named mesh out of a loaded model's scene (null when the GLB has none).
 * @param {{ scene?: THREE.Object3D }} model @param {string} name
 * @returns {THREE.Mesh | null}
 */
function takeMesh(model, name) {
  const o = model.scene ? model.scene.getObjectByName(name) : null;
  if (!o || !(/** @type {any} */ (o).isMesh)) return null;
  const m = /** @type {THREE.Mesh} */ (o);
  m.removeFromParent();
  m.position.set(0, 0, 0);
  m.quaternion.identity();
  m.scale.set(1, 1, 1);
  return m;
}

/** @param {number} x */
function smooth01(x) { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); }
