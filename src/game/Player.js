// @ts-check
import * as THREE from 'three';
import { headPose, quatForward, quatUp } from './head.js';

/**
 * The player (CONTRACTS.md "Player"), rebuilt from the head pose every frame
 * as the `player` system. Allocation-free after construction.
 *
 * Fields read by everyone (world space = the XR reference space, metres):
 * - `head`: centre of the head hit sphere, 8.5 cm behind and 2 cm above the
 *   eyes in head space (the eyes sit at the front of the skull); `headRadius`.
 * - `forward`: unit view direction. `flatForward`: horizontal unit heading that
 *   stays stable while looking down (forward + up·(−forward.y), PLAN §8).
 * - `torsoTop` / `torsoBottom` / `torsoRadius`: the torso capsule. The top
 *   hangs below the head (neck base, so the capsule's cap covers the neck and
 *   shoulders); the bottom is the pelvis, which lags the head horizontally
 *   (0.35 s, at most 0.35 m), so peeking round a corner or leaning tilts the
 *   capsule instead of carrying the whole body out. Crouching lowers the pelvis.
 * - `health`, `alive`, `zone`: written by GameSession.
 * - extra: `eye` (eye midpoint), `quat`, `eyeHeight` (above the floor),
 *   `standEye` (calibrated standing eye height), `scale` (standEye / 1.70),
 *   `valid` (a pose has been seen).
 *
 * Proportions are for a 1.70 m eye height (about 1.81 m stature) and scale
 * with the calibrated standing eye height, which is the highest 0.5 s average
 * eye height seen, clamped to 1.45–1.98 m (PLAN §8).
 */
export const BODY = Object.freeze({
  refEye: 1.7,
  minEye: 1.45,
  maxEye: 1.98,
  defaultEye: 1.65,
  /** Seconds of samples before the first standing-height estimate. */
  calibrateS: 1.0,
  eyeSmoothS: 0.5,
  headRadius: 0.11,
  headBack: 0.085,
  headUp: 0.02,
  torsoRadius: 0.17,
  /** Torso capsule top: below the eyes (× scale), and behind the head centre. */
  torsoTopBelowEye: 0.32,
  torsoBack: 0.03,
  /** Standing pelvis below the standing eye height (× scale). */
  pelvisBelowStandEye: 0.68,
  /** Crouched pelvis, below the current eye height (× scale). */
  pelvisBelowEye: 0.6,
  pelvisMinAboveFloor: 0.3,
  hipLagS: 0.35,
  hipMaxOffset: 0.35,
});

export class Player {
  constructor() {
    this.head = new THREE.Vector3(0, BODY.defaultEye, 0);
    this.forward = new THREE.Vector3(0, 0, -1);
    this.flatForward = new THREE.Vector3(0, 0, -1);
    this.torsoTop = new THREE.Vector3(0, BODY.defaultEye - BODY.torsoTopBelowEye, 0);
    this.torsoBottom = new THREE.Vector3(0, BODY.defaultEye - BODY.pelvisBelowStandEye, 0);
    /** @type {number} */ this.torsoRadius = BODY.torsoRadius;
    /** @type {number} */ this.headRadius = BODY.headRadius;
    this.health = 100;
    this.alive = true;
    this.zone = { x: 0, z: 0, r: 0.8 };
    this.eye = new THREE.Vector3(0, BODY.defaultEye, 0);
    this.quat = new THREE.Quaternion();
    this.up = new THREE.Vector3(0, 1, 0);
    this.floorY = 0;
    /** @type {number} */ this.eyeHeight = BODY.defaultEye;
    /** @type {number} */ this.standEye = BODY.defaultEye;
    /** @type {number} */ this.scale = BODY.defaultEye / BODY.refEye;
    this.valid = false;
    this._eyeLP = 0;
    this._samplesS = 0;
    this._calibrated = false;
    this._hipX = 0;
    this._hipZ = 0;
    this._pose = new Float64Array(7);
    this._v = new Float64Array(6);
  }

  /** New session: forget the pose and the height calibration; keep the defaults. */
  reset() {
    this.valid = false;
    this._samplesS = 0;
    this._calibrated = false;
    this.standEye = BODY.defaultEye;
    this.scale = BODY.defaultEye / BODY.refEye;
    this.health = 100;
    this.alive = true;
  }

  /**
   * @param {number} dt
   * @param {number} _t
   * @param {XRFrame|null|undefined} _frame
   * @param {{ camera: any, world?: { built?: boolean, floorY: (x: number, z: number) => number } | null }} ctx
   */
  update(dt, _t, _frame, ctx) {
    const cam = ctx.camera;
    if (!cam) return;
    const P = this._pose;
    if (!headPose(cam, P)) return;
    const first = !this.valid;
    this.valid = true;
    this.eye.set(P[0], P[1], P[2]);
    this.quat.set(P[3], P[4], P[5], P[6]);
    const v = this._v;
    quatForward(P[3], P[4], P[5], P[6], v, 0);
    quatUp(P[3], P[4], P[5], P[6], v, 3);
    this.forward.set(v[0], v[1], v[2]);
    this.up.set(v[3], v[4], v[5]);

    // Heading: while looking down the head's up vector points where the body faces.
    let fx = v[0] + v[3] * -v[1], fz = v[2] + v[5] * -v[1];
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) { fx /= fl; fz /= fl; this.flatForward.set(fx, 0, fz); }
    else { fx = this.flatForward.x; fz = this.flatForward.z; }

    const w = ctx.world;
    const floor = w && w.built !== false && typeof w.floorY === 'function' ? w.floorY(P[0], P[2]) : 0;
    this.floorY = Number.isFinite(floor) ? floor : 0;
    const eyeH = P[1] - this.floorY;
    this.eyeHeight = eyeH;
    this.calibrate(dt, eyeH, first);
    const s = this.scale;

    // Head sphere centre: head-space (0, up, back) rotated into the world.
    const hb = BODY.headBack, hu = BODY.headUp;
    // q · (0, hu, hb) = up·hu − forward·hb (forward is −Z in head space)
    this.head.set(P[0] + v[3] * hu - v[0] * hb, P[1] + v[4] * hu - v[1] * hb, P[2] + v[5] * hu - v[2] * hb);

    const tx = this.head.x - fx * BODY.torsoBack, tz = this.head.z - fz * BODY.torsoBack;
    const minY = this.floorY + BODY.pelvisMinAboveFloor;
    this.torsoTop.set(tx, Math.max(minY, P[1] - BODY.torsoTopBelowEye * s), tz);

    // Pelvis: lags the shoulders horizontally, capped, so a lean tilts the capsule.
    if (first) { this._hipX = tx; this._hipZ = tz; }
    else {
      const k = dt > 0 ? 1 - Math.exp(-dt / BODY.hipLagS) : 0;
      this._hipX += (tx - this._hipX) * k;
      this._hipZ += (tz - this._hipZ) * k;
    }
    let ox = this._hipX - tx, oz = this._hipZ - tz;
    const ol = Math.hypot(ox, oz), maxO = BODY.hipMaxOffset * s;
    if (ol > maxO) { ox *= maxO / ol; oz *= maxO / ol; this._hipX = tx + ox; this._hipZ = tz + oz; }
    const stand = this.floorY + this.standEye - BODY.pelvisBelowStandEye * s;
    const crouch = P[1] - BODY.pelvisBelowEye * s;
    const py = Math.max(minY, Math.min(stand, crouch));
    this.torsoBottom.set(this._hipX, Math.min(py, this.torsoTop.y), this._hipZ);
    this.torsoRadius = BODY.torsoRadius * s;
  }

  /**
   * Standing eye height = the highest 0.5 s average seen (after 1 s of samples).
   * @param {number} dt @param {number} eyeH @param {boolean} first
   */
  calibrate(dt, eyeH, first) {
    if (!Number.isFinite(eyeH)) return;
    if (first) this._eyeLP = eyeH;
    else if (dt > 0) this._eyeLP += (eyeH - this._eyeLP) * (1 - Math.exp(-dt / BODY.eyeSmoothS));
    this._samplesS += dt;
    if (this._samplesS < BODY.calibrateS) return;
    const lp = Math.min(BODY.maxEye, Math.max(BODY.minEye, this._eyeLP));
    if (!this._calibrated) { this._calibrated = true; this.standEye = lp; }
    else if (lp > this.standEye) this.standEye = lp;
    this.scale = this.standEye / BODY.refEye;
  }
}
