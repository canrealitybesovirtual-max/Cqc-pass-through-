// @ts-check
import * as THREE from 'three';

/**
 * One weapon's view (CONTRACTS.md "W2"): the baked gun mesh in the hand, its
 * moving parts, the seated magazine and the magazine in the support hand.
 *
 * Hold (CQC's tested setup, values only): the gun's palm point sits at the
 * controller's grip-space origin and the bore runs parallel to the
 * controller's aim ray (target-ray orientation), with `aimPitch` 0 and
 * `offset` 0 (CQC CONFIG.weapons.aimPitch / holdOffset, both left at 0 after
 * headset tests). The palm point is on the manifest grip axis where the bore
 * is `boreAbove` over it: 6.0 cm on the Glock, 8.8 cm on rifles (CQC: the gun
 * root is the palm, the bore 6.0 / 8.8 cm above it). Recoil turns the gun
 * about that palm point. The camera never moves.
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

/** Per-weapon fit (gun space; CQC values unless marked design). */
export const FIT = Object.freeze({
  /** rad added about the gun's X axis to the aim-ray orientation (CQC aimPitch, tested 0) */
  aimPitch: 0,
  /** m, in the hand frame (x right, y up, z back) (CQC holdOffset, tested 0) */
  offset: Object.freeze([0, 0, 0]),
  glock: Object.freeze({
    boreAbove: 0.060,
    /** m: the bullet path crosses the sight line here (CQC pistol zero 15 m) */
    zero: 15,
    /** mechanical dispersion, radius of a uniform disc (rad) (CQC spread) */
    spread: 0.0016,
    /** magazine capture depth below the seat (CQC magWindow) */
    magWindow: 0.15,
    /** magazine held "as it sits in the grip" (CQC pistol hold): null = at the seat of a gun held in that hand */
    magHold: null,
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
    boreAbove: 0.088,
    zero: 25,
    spread: 0.0019,
    magWindow: 0.07,
    magHold: Object.freeze({ pos: Object.freeze([0, 0.0927, -0.013]), rotX: -0.3 }),   // CQC smg hold: round its middle, top up
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

    // Gun-space reference points.
    const up = vec(M.grip.up).normalize(), gp = vec(M.grip.pos);
    const t = (-this.fit.boreAbove - gp.y) / (Math.abs(up.y) > 1e-3 ? up.y : 1);
    /** Palm point: the controller's grip origin sits here. */
    this.palm = gp.clone().addScaledVector(up, t);
    this.muzzle = vec(M.muzzle);
    this.port = vec(M.ejectionPort);
    this.ejectDir = vec(M.ejectDir).normalize();
    this.slideAxis = vec(M.slide.axis).normalize();
    this.travel = M.slide.travel;
    this.rackPoint = vec(M.slide.rackPoint);
    this.magAxis = vec(M.magWell.axis).normalize();
    this.support = M.support ? vec(M.support.pos) : null;
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
    // Magazine in the free hand, relative to the hand frame.
    this.magHoldPos = new THREE.Vector3();
    this.magHoldQuat = new THREE.Quaternion();
    if (this.fit.magHold) {
      this.magHoldPos.fromArray(this.fit.magHold.pos);
      this.magHoldQuat.setFromAxisAngle(_X, this.fit.magHold.rotX);
    } else {
      this.magHoldPos.copy(this.magSeat).sub(this.palm);
    }

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
   * Gun root from the hand: palm at the grip origin, bore along the aim ray.
   * @param {THREE.Vector3} gripPos @param {THREE.Quaternion} handQuat aim-ray orientation
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  holdPose(gripPos, handQuat, outPos, outQuat) {
    outQuat.copy(handQuat);
    if (FIT.aimPitch) outQuat.multiply(_q.setFromAxisAngle(_X, FIT.aimPitch));
    const o = FIT.offset;
    _v.set(o[0], o[1], o[2]).applyQuaternion(handQuat);
    outPos.copy(this.palm).negate().applyQuaternion(outQuat).add(_v).add(gripPos);
  }

  /**
   * Gun root from a slot frame: palm at `palmPos`, gun orientation `q`.
   * @param {THREE.Vector3} palmPos @param {THREE.Quaternion} q
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  slotPose(palmPos, q, outPos, outQuat) {
    outQuat.copy(q);
    outPos.copy(this.palm).negate().applyQuaternion(q).add(palmPos);
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
   * Aim a two-handed rifle: turn the hold (as little as possible) so the
   * palm-to-support line runs from the firing grip to the support grip.
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
    _v.subVectors(this.support, this.palm).normalize().applyQuaternion(quat);
    _q.setFromUnitVectors(_v, _v2);
    quat.premultiply(_q);
    const o = FIT.offset;
    _v.set(o[0], o[1], o[2]).applyQuaternion(quat);
    outPos.copy(this.palm).negate().applyQuaternion(quat).add(_v).add(gripPos);
    return true;
  }

  /**
   * The magazine in a free hand (hand frame as for a held gun).
   * @param {THREE.Vector3} gripPos @param {THREE.Quaternion} handQuat
   * @param {THREE.Vector3} outPos @param {THREE.Quaternion} outQuat
   */
  handMagPose(gripPos, handQuat, outPos, outQuat) {
    outQuat.copy(handQuat).multiply(this.magHoldQuat);
    outPos.copy(this.magHoldPos).applyQuaternion(handQuat).add(gripPos);
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

/** @param {number} x */
function smooth01(x) { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); }
