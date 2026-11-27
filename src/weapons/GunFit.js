// @ts-check
/**
 * How each gun sits in the real Quest Touch Plus hand (pure: no three.js, no
 * DOM). Measured in v0.3 research (scratchpad research-fit.md, numbers in
 * gunfit_numbers.json) on the npm `@webxr-input-profiles/assets` 1.0.20
 * meta-quest-touch-plus GLB, whose root is the WebXR grip space.
 *
 * Frame: the RIGHT controller's grip space, metres. −Z runs up the handle
 * toward the thumb, −Y toward the trigger, +X out of the back of the hand.
 * (Left hand: negate x of positions, keep the quaternion.)
 *
 * Default gun root (gun space: origin on the bore at the breech, −Z muzzle,
 * +Y up) in grip space: Rx(−(90° − α)), α = the manifest grip angle
 * (Glock 21.61°, AKM 16.62°), maps the gun's grip axis onto the handle (grip
 * −Z) and gun +X onto +X. The trigger pad lands on the controller's trigger
 * (z −0.022), the grip centre on the handle centre (y +0.001, mean of the two
 * placements), x +0.008 (handle centre +0.010, fist centroid 0).
 * Result: Glock trigger 2.4 mm ahead of the controller trigger, slide top
 * 2.2 cm above the top face; AKM trigger 3.5 mm ahead, back strap flush.
 * The bore is 24.4° (Glock) / 29.2° (AKM) below the IWER aim ray: intended,
 * shots go along the bore.
 *
 * Player nudges (in-headset gun fit, saved per gun):
 * - `pitch` degrees (+ = muzzle up), clamped ±30, about the trigger pad
 *   P = (0, −0.036, −0.022), so the trigger stays under the finger;
 * - `up` m (+ = toward the thumb, grip −Z) and `fwd` m (+ = toward the
 *   muzzle, grip −Y), each clamped ±0.04.
 *   q = Rx(pitch)·q0;  p = P + Rx(pitch)·(p0 − P) + (0, −fwd, −up).
 * `palm` (gun space) = q⁻¹·(−p): the grip origin seen from the gun. It is the
 * recoil pivot and the two-handed aim pivot.
 *
 * Storage (written by the integrator, never from the frame loop):
 * localStorage[FIT_KEY] = serializeFits(fits) = {"v":1,"glock":{pitch,up,fwd},"akm":{...}}.
 */

export const FIT_KEY = 'cqcpt.gunfit.v1';
export const FIT_VERSION = 1;

/** Nudge limits. */
export const FIT_LIMITS = Object.freeze({ pitchDeg: 30, up: 0.04, fwd: 0.04 });

/** Tilt pivot: the controller's trigger pad (grip space). */
export const FIT_PIVOT = Object.freeze([0, -0.036, -0.022]);

/**
 * Default gun root in right grip space: pos [x, y, z], quat [x, y, z, w].
 * @type {Readonly<Record<'glock'|'akm', { pos: readonly number[], quat: readonly number[], gripDeg: number }>>}
 */
export const GRIP_DEFAULT = Object.freeze({
  glock: Object.freeze({ pos: Object.freeze([0.008, -0.0107, -0.0540]), quat: Object.freeze([-0.562006, 0, 0, 0.827133]), gripDeg: 21.61 }),
  akm: Object.freeze({ pos: Object.freeze([0.008, -0.1541, -0.1032]), quat: Object.freeze([-0.597515, 0, 0, 0.801858]), gripDeg: 16.62 }),
});

/**
 * The magazine root (its top, on the insertion axis) in the LEFT grip space.
 * Glock: where it sits in a Glock held with the default fit (mirrored);
 * AKM: Rx(−112.6°), held round its middle with the top up (design, check in the headset).
 */
export const MAG_IN_LEFT = Object.freeze({
  glock: Object.freeze({ pos: Object.freeze([-0.008, 0.0040, -0.0395]), quat: Object.freeze([-0.56201, 0, 0, 0.82713]) }),
  akm: Object.freeze({ pos: Object.freeze([-0.006, -0.0127, -0.1306]), quat: Object.freeze([-0.83195, 0, 0, 0.55484]) }),
});

/**
 * The AKM's support-hand target (gun space): the left grip origin on the
 * handguard. With it the hands' line is within 1° of the bore (the manifest
 * support point, 5 cm higher, tipped the bore 7° down).
 */
export const AKM_SUPPORT_TARGET = Object.freeze([0, -0.060, -0.115]);

/** @typedef {{ pitch: number, up: number, fwd: number }} FitAdj */
/** @typedef {{ glock: FitAdj, akm: FitAdj }} Fits */

/** @returns {FitAdj} */
export function zeroAdj() { return { pitch: 0, up: 0, fwd: 0 }; }

/** @returns {Fits} */
export function defaultFits() { return { glock: zeroAdj(), akm: zeroAdj() }; }

/** @param {number} v @param {number} m */
const clampAbs = (v, m) => (v > m ? m : v < -m ? -m : v);

/**
 * Clamp (and sanitise) an adjustment in place.
 * @param {FitAdj} a
 * @returns {FitAdj} a
 */
export function clampAdj(a) {
  a.pitch = Number.isFinite(a.pitch) ? clampAbs(a.pitch, FIT_LIMITS.pitchDeg) : 0;
  a.up = Number.isFinite(a.up) ? clampAbs(a.up, FIT_LIMITS.up) : 0;
  a.fwd = Number.isFinite(a.fwd) ? clampAbs(a.fwd, FIT_LIMITS.fwd) : 0;
  return a;
}

const _q = new Float64Array(4);
const _v = new Float64Array(3);

/**
 * Gun root pose in grip space, and the palm point in gun space, for an
 * adjustment. Allocation-free.
 * @param {'glock'|'akm'} id
 * @param {{ pitch: number, up: number, fwd: number } | null} adj null = defaults
 * @param {Float64Array|Float32Array|number[]} outPose7 [px, py, pz, qx, qy, qz, qw]
 * @param {Float64Array|Float32Array|number[]} outPalm3 [x, y, z] gun space
 */
export function computeFit(id, adj, outPose7, outPalm3) {
  const D = GRIP_DEFAULT[id] || GRIP_DEFAULT.glock;
  const L = FIT_LIMITS;
  const pitchDeg = adj && Number.isFinite(adj.pitch) ? clampAbs(adj.pitch, L.pitchDeg) : 0;
  const up = adj && Number.isFinite(adj.up) ? clampAbs(adj.up, L.up) : 0;
  const fwd = adj && Number.isFinite(adj.fwd) ? clampAbs(adj.fwd, L.fwd) : 0;
  const a = (pitchDeg * Math.PI) / 360, s = Math.sin(a), c = Math.cos(a);   // Rx(pitch) = (s, 0, 0, c)
  // q = Rx(pitch) · q0
  const q0 = D.quat, bx = q0[0], by = q0[1], bz = q0[2], bw = q0[3];
  _q[0] = s * bw + c * bx;
  _q[1] = c * by - s * bz;
  _q[2] = c * bz + s * by;
  _q[3] = c * bw - s * bx;
  const qn = 1 / Math.sqrt(_q[0] * _q[0] + _q[1] * _q[1] + _q[2] * _q[2] + _q[3] * _q[3]);
  _q[0] *= qn; _q[1] *= qn; _q[2] *= qn; _q[3] *= qn;
  // p = P + Rx(pitch)·(p0 − P) + (0, −fwd, −up)
  const P = FIT_PIVOT, p0 = D.pos;
  const dx = p0[0] - P[0], dy = p0[1] - P[1], dz = p0[2] - P[2];
  const c2 = Math.cos(2 * a), s2 = Math.sin(2 * a);
  const px = P[0] + dx;
  const py = P[1] + c2 * dy - s2 * dz - fwd;
  const pz = P[2] + s2 * dy + c2 * dz - up;
  outPose7[0] = px; outPose7[1] = py; outPose7[2] = pz;
  outPose7[3] = _q[0]; outPose7[4] = _q[1]; outPose7[5] = _q[2]; outPose7[6] = _q[3];
  // palm = q⁻¹ · (−p)
  rotateInv(_q, -px, -py, -pz, _v);
  outPalm3[0] = _v[0]; outPalm3[1] = _v[1]; outPalm3[2] = _v[2];
}

/**
 * out = q⁻¹ · v (q unit, [x, y, z, w]).
 * @param {ArrayLike<number>} q @param {number} x @param {number} y @param {number} z
 * @param {Float64Array|Float32Array|number[]} out
 */
export function rotateInv(q, x, y, z, out) {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

/**
 * out = q · v.
 * @param {ArrayLike<number>} q @param {number} x @param {number} y @param {number} z
 * @param {Float64Array|Float32Array|number[]} out
 */
export function rotate(q, x, y, z, out) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

/**
 * Read saved fits (a JSON string or an already parsed object). Anything
 * missing, of the wrong version, not finite or outside the limits falls back
 * to the default (0) for that value. Never throws.
 * @param {unknown} json
 * @returns {Fits}
 */
export function parseFits(json) {
  const out = defaultFits();
  /** @type {any} */
  let o = json;
  if (typeof json === 'string') { try { o = JSON.parse(json); } catch { return out; } }
  if (!o || typeof o !== 'object' || o.v !== FIT_VERSION) return out;
  for (const id of /** @type {const} */ (['glock', 'akm'])) {
    const g = o[id];
    if (!g || typeof g !== 'object') continue;
    const L = FIT_LIMITS;
    /** @param {any} v @param {number} m */
    const ok = (v, m) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= m ? v : 0);
    out[id].pitch = ok(g.pitch, L.pitchDeg);
    out[id].up = ok(g.up, L.up);
    out[id].fwd = ok(g.fwd, L.fwd);
  }
  return out;
}

/** @param {number} v */
const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * @param {Fits} fits
 * @returns {string} JSON for localStorage[FIT_KEY]
 */
export function serializeFits(fits) {
  /** @param {FitAdj} a */
  const one = (a) => {
    const c = clampAdj({ pitch: a ? a.pitch : 0, up: a ? a.up : 0, fwd: a ? a.fwd : 0 });
    return { pitch: Math.round(c.pitch * 100) / 100, up: r4(c.up), fwd: r4(c.fwd) };
  };
  return JSON.stringify({ v: FIT_VERSION, glock: one(fits.glock), akm: one(fits.akm) });
}

/**
 * The URL escape hatch (?gripPitch=<deg>&gripY=<m>&gripZ=<m>) as a fit:
 * gripPitch → pitch, gripY → up, gripZ → −fwd (gripZ was + = back toward
 * you). Same value for both guns; never saved.
 * @param {{ pitchDeg?: number, y?: number, z?: number }} p
 * @returns {FitAdj}
 */
export function adjFromUrl(p) {
  return clampAdj({ pitch: p.pitchDeg || 0, up: p.y || 0, fwd: -(p.z || 0) });
}
