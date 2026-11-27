// @ts-check
/**
 * Room-light matching (research-look R3, R11; maths in roomLightMath.js).
 *
 * Drives ONLY the fixed light set's intensities and colours, the sun's
 * position (the key-light direction), `scene.environmentIntensity` /
 * `environmentRotation` and two shared uniforms (`uPtm` black lift and grain,
 * `uRoomLight` for unlit effects). Never the light count, never a program.
 *
 * Estimates, best available first:
 * - **Camera (opt-in, untested on the Quest).** `requestCamera()` must run
 *   inside a tap on the 2D page (never inside the Enter click: an await there
 *   spends the gesture). A small stream (320 × 240 at 15 fps) plays in a
 *   hidden 2 × 2 px video; every 2 s, from the video's own frame callback
 *   (outside the XR frame), `createImageBitmap(video, 32 × 24)` goes to a
 *   module worker (roomLight.worker.js) that returns ~15 numbers. No pixel is
 *   kept, stored, logged or sent. A sample is skipped while the head turns
 *   fast, looks up at a lamp, or the frame is mostly clipped. If the
 *   synchronous part of a sample costs over 1 ms twice, the camera path turns
 *   itself off (`camera.rejected`).
 * - **Auto per room** (the default): the local time and whether the room has
 *   a window in Space Setup (brighter and cooler by day, warm lamps at night),
 *   the key light from the window.
 * - **Manual per room**: dim / normal / bright × warm / neutral / cool from the
 *   watch (`cycleLevel`, `cycleWarmth`), saved per house and room
 *   (localStorage['cqcpt.roomlight.v1'], written from a setTimeout). With the
 *   camera on, the level acts as a ±20 % trim.
 *
 * Rooms are the world's Roam rooms; a room is remembered by a key that does
 * not depend on the session's coordinates (its area and furniture labels),
 * so a saved preset finds its room again in the next session.
 *
 * `update()` is allocation-free: the room is looked up at 2 Hz, and the
 * target, the smoothing and the light writes run every frame (about a
 * microsecond) so the JIT keeps them compiled (code that runs only on events
 * stays interpreted and boxes its numbers). Camera samples arrive as events
 * (a message from the worker).
 */

import * as THREE from 'three';
import {
  LightSmoother, RL, ST, STATS_LEN, T, TARGET_LEN, LEVELS_LEN, LV, LEVELS, WARMTHS, LEVEL_AUTO, WARM_AUTO, FLOORS, ROOMLIGHT_KEY,
  lightLevels, parseRoomLight, presetTargets, sampleOk, serializeRoomLight, targetsFromStats,
} from './roomLightMath.js';
import { uPtm, grainStep } from './PassthroughMatch.js';
import { uRoomLight } from './Impacts.js';

/** The page's honest note for the camera toggle. */
export const CAMERA_NOTE = 'Match lighting to my room: uses the headset camera to measure your room\'s brightness and colour '
  + 'every 2 seconds. Only about 15 numbers are kept, in memory; no picture is stored, recorded or sent. '
  + 'Experimental: not yet tested on Quest, and the browser may refuse the camera during mixed reality.';

/** Rooms tracked (Roam room ids above this share the last slot). */
export const MAX_ROOMS = 64;
/** Camera level trim per manual level when the camera is on (auto, dim, normal, bright). */
const CAM_TRIM = [1, 0.8, 1, 1.2];
/** Key light: elevation through a window; from above otherwise. */
const WINDOW_ELEV = 0.6; // rad (~35°)

/**
 * The env map's bright "window" panel sits toward −X in Renderer's room scene.
 * The yaw for `scene.environmentRotation.y` that turns it toward the real
 * window direction (wx, wz) (horizontal, toward the window).
 * @param {number} wx @param {number} wz
 */
export function envYawFor(wx, wz) {
  // three samples the environment along R(rotation) · direction: we need R · w = (−1, 0, 0)
  return Math.atan2(wz, -wx);
}

export class RoomLight {
  /**
   * @param {{ scene: THREE.Scene, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight, storage?: Storage|null,
   *   saturation?: number, hour?: number }} o
   *   hour: the local hour at load (tests); else from the clock
   */
  constructor(o) {
    this.scene = o.scene;
    this.hemi = o.hemi;
    this.sun = o.sun;
    /** @type {Storage|null} */ this.storage = o.storage || null;
    // the normal-room baseline: what Renderer made (with ?env= / ?light= already applied)
    const h = this.hemi, s = this.sun;
    this.base = {
      hemi: h.intensity, sun: s.intensity, env: this.scene.environmentIntensity,
      sky: [h.color.r, h.color.g, h.color.b], ground: [h.groundColor.r, h.groundColor.g, h.groundColor.b], sunColor: [s.color.r, s.color.g, s.color.b],
    };
    this.baseSunDir = new Float64Array(3);
    { const p = s.position, l = Math.hypot(p.x, p.y, p.z) || 1; this.baseSunDir[0] = p.x / l; this.baseSunDir[1] = p.y / l; this.baseSunDir[2] = p.z / l; }
    this.sunDist = Math.hypot(s.position.x, s.position.y, s.position.z) || 1;
    if (Number.isFinite(o.saturation)) uPtm.value.z = /** @type {number} */ (o.saturation);

    this.settings = parseRoomLight(readKey(this.storage, ROOMLIGHT_KEY));
    this.sig = 'default';
    this.smoother = new LightSmoother();
    this.target = new Float64Array(TARGET_LEN);
    this.levels = new Float64Array(LEVELS_LEN);
    // rooms (index = room id, clamped)
    this.roomLevel = new Int8Array(MAX_ROOMS);
    this.roomWarm = new Int8Array(MAX_ROOMS);
    this.roomWindow = new Uint8Array(MAX_ROOMS);
    /** Per room: key light direction toward the light (unit) and the env yaw. */
    this.roomKey = new Float64Array(MAX_ROOMS * 3);
    this.roomYaw = new Float64Array(MAX_ROOMS);
    /** @type {string[]} the session-independent room keys (build time) */
    this.roomKeys = [];
    this.room = -1;
    this.roomClock = 0;
    this.dirty = true;
    /** Current key light direction (toward the light, unit) and env yaw, eased. */
    this.keyDir = new Float64Array(this.baseSunDir);
    this.keyGoal = new Float64Array(this.baseSunDir);
    this.yaw = 0;
    this.yawGoal = 0;
    // local time: one Date at load, advanced by the frame clock (no Date per frame); minutes of the day (an integer)
    this.min0 = Math.round((Number.isFinite(o.hour) ? /** @type {number} */ (o.hour) : localHour()) * 60);
    this.t0 = -1;
    this.minute = this.min0;
    /** The frame time (ms) of this update. */
    this.now = 0;

    // ── camera
    this.camera = {
      on: false, wanted: this.settings.camera, rejected: '', error: '', samples: 0, used: 0, skipped: 0, slow: 0,
      syncMsMax: 0, workerMsMax: 0, lastAt: -1, settings: /** @type {any} */ (null),
    };
    /** @type {MediaStream|null} */ this.stream = null;
    /** @type {HTMLVideoElement|null} */ this.video = null;
    /** @type {Worker|null} */ this.worker = null;
    this.camStats = new Float64Array(STATS_LEN);
    this.camTarget = new Float64Array(TARGET_LEN);
    this.camValid = false;
    this.camAt = -1e9;
    this.camBusy = false;
    this.camLast = -1e9;
    this.camId = 0;
    // head motion ring for gating camera samples (t ms, yaw rate deg/s, pitch deg)
    this.headT = new Float64Array(32); this.headTurn = new Float64Array(32); this.headPitch = new Float64Array(32);
    this.headN = 0;
    this.prevYaw = NaN;
    this.prevT = 0;
    this._onFrame = (/** @type {number} */ now, /** @type {any} */ meta) => this.onVideoFrame(now, meta);
    this._onMessage = (/** @type {MessageEvent} */ e) => this.onWorker(e.data);
    this._save = () => this.save();
    this.saveQueued = false;
    this.stats = { targetsAccepted: 0, roomChanges: 0, saves: 0, saveErrors: 0, retargets: 0 };
    warmMath();
    this.warmSelf();
    this.applyNow();
  }

  /**
   * Run retarget and applyNow a couple of thousand times at load: they run
   * only on events in play (a room change, a preset, a camera sample), and
   * code the JIT never optimised boxes every number it touches. Restores the
   * state afterwards.
   */
  warmSelf() {
    for (let i = 0; i < 2000; i++) {
      this.room = i & 3;
      this.roomWindow[i & 3] = i & 1;
      this.retarget();
      this.smoother.dt = 1 / 72;
      this.smoother.step();
      this.dirty = true;
      this.applyNow();
    }
    this.roomWindow.fill(0);
    this.smoother = new LightSmoother();
    this.room = -1;
    this.stats.retargets = 0;
    this.stats.targetsAccepted = 0;
    this.keyDir.set(this.baseSunDir); this.keyGoal.set(this.baseSunDir);
    this.yaw = 0; this.yawGoal = 0;
  }

  // ─────────────────────────────────────────────────────────── house and rooms

  /**
   * After a world build (behind the panel): the house signature, the rooms'
   * keys, windows and key lights, and the saved presets. Allocates (build time).
   * @param {any} world the built World (roamIndex, nav, layout, roomAt)
   * @param {any} [snapshot] the Space Setup snapshot (window planes)
   */
  setHouse(world, snapshot = null) {
    this.roomLevel.fill(LEVEL_AUTO);
    this.roomWarm.fill(WARM_AUTO);
    this.roomWindow.fill(0);
    this.roomYaw.fill(0);
    for (let r = 0; r < MAX_ROOMS; r++) { this.roomKey[r * 3] = this.baseSunDir[0]; this.roomKey[r * 3 + 1] = this.baseSunDir[1]; this.roomKey[r * 3 + 2] = this.baseSunDir[2]; }
    this.roomKeys = [];
    const R = world && world.roamOn ? world.roamIndex : null;
    const L = world && world.layout;
    const nav = world && world.nav;
    // room keys: area (m²) and the furniture labels in it
    const labels = /** @type {string[][]} */ ([]);
    const count = R ? Math.min(R.roomCount | 0, MAX_ROOMS - 1) : 0;
    for (let r = 0; r <= count; r++) labels.push([]);
    if (L && L.furniture) for (const f of L.furniture) {
      const r = clampRoom(world.roomAt(f.cx, f.cz));
      if (r > 0 && r <= count && !labels[r].includes(f.label)) labels[r].push(f.label);
    }
    for (let r = 0; r <= count; r++) {
      const area = R && nav ? R.roomCells[r] * nav.cell * nav.cell : 0;
      this.roomKeys.push(r === 0 ? 'house' : `a${Math.round(area)}|${labels[r].sort().join(',')}`);
    }
    // windows: Space Setup 'window' / 'window frame' planes → their room's key light and env yaw
    const planes = snapshot && Array.isArray(snapshot.planes) ? snapshot.planes : [];
    for (const p of planes) {
      const lab = typeof p.label === 'string' ? p.label.toLowerCase().replace(/[_-]+/g, ' ').trim() : '';
      if ((lab !== 'window' && lab !== 'window frame') || !p.pose || p.pose.length !== 16) continue;
      const m = p.pose, px = m[12], pz = m[14];
      let nx = m[4], nz = m[6];
      const nl = Math.hypot(nx, nz);
      if (!(nl > 0.5)) continue; // not a vertical plane
      nx /= nl; nz /= nl;
      // the room is on one side; the light comes from the window side
      let r = world ? clampRoom(world.roomAt(px + nx * 0.4, pz + nz * 0.4)) : 0, sx = -nx, sz = -nz;
      if (r <= 0 && world) { r = clampRoom(world.roomAt(px - nx * 0.4, pz - nz * 0.4)); sx = nx; sz = nz; }
      if (r <= 0 && R) continue; // Roam: a window beside no room (outside the mapped floor)
      this.roomWindow[r] = 1;
      const ce = Math.cos(WINDOW_ELEV), se = Math.sin(WINDOW_ELEV);
      this.roomKey[r * 3] = sx * ce; this.roomKey[r * 3 + 1] = se; this.roomKey[r * 3 + 2] = sz * ce;
      this.roomYaw[r] = envYawFor(sx, sz);
      if (r === 0) for (let k = 1; k < MAX_ROOMS; k++) { this.roomWindow[k] = 1; this.roomKey[k * 3] = this.roomKey[0]; this.roomKey[k * 3 + 1] = this.roomKey[1]; this.roomKey[k * 3 + 2] = this.roomKey[2]; this.roomYaw[k] = this.roomYaw[0]; }
    }
    // the house: total floor area and wall / door counts (session-independent)
    let floorArea = 0, walls = 0, doors = 0;
    for (const p of planes) {
      const lab = typeof p.label === 'string' ? p.label.toLowerCase() : '';
      if (lab === 'floor' && Array.isArray(p.polygon)) floorArea += polyArea(p.polygon);
      else if (lab === 'wall') walls++;
      else if (lab === 'door') doors++;
    }
    this.sig = planes.length ? `h${Math.round(floorArea / 2) * 2}-${walls}-${doors}` : 'default';
    // saved presets → rooms
    const H = this.settings.houses[this.sig];
    if (H) {
      for (let r = 0; r <= count; r++) {
        const saved = matchRoom(H.rooms, this.roomKeys[r]);
        if (saved) { this.roomLevel[r] = saved[0]; this.roomWarm[r] = saved[1]; }
      }
    }
    this.room = -1;
    this.dirty = true;
  }

  /** The floor material of this house ('wood' | 'carpet' | 'tile'). */
  get floor() {
    const H = this.settings.houses[this.sig];
    return H ? H.floor : 'wood';
  }

  /**
   * Set the floor material of this house (saved).
   * @param {string} kind
   */
  setFloor(kind) {
    if (!FLOORS.includes(kind)) return this.floor;
    const H = this.house();
    H.floor = kind;
    this.queueSave();
    return kind;
  }

  /** The current room's preset names. */
  preset() {
    const r = this.room < 0 ? 0 : this.room;
    return { room: r, level: LEVELS[this.roomLevel[r]], warmth: WARMTHS[this.roomWarm[r]], camera: this.camera.on };
  }

  /** Next level for the room the player is in (auto → dim → normal → bright → auto); saved. */
  cycleLevel() {
    const r = this.room < 0 ? 0 : this.room;
    return this.setRoomPreset(r, (this.roomLevel[r] + 1) % LEVELS.length, this.roomWarm[r]);
  }

  /** Next warmth for the room the player is in (auto → warm → neutral → cool → auto); saved. */
  cycleWarmth() {
    const r = this.room < 0 ? 0 : this.room;
    return this.setRoomPreset(r, this.roomLevel[r], (this.roomWarm[r] + 1) % WARMTHS.length);
  }

  /**
   * @param {number} room @param {number} level LEVEL_* @param {number} warmth WARM_*
   */
  setRoomPreset(room, level, warmth) {
    const r = clampRoom(room);
    this.roomLevel[r] = level >= 0 && level < LEVELS.length ? level : LEVEL_AUTO;
    this.roomWarm[r] = warmth >= 0 && warmth < WARMTHS.length ? warmth : WARM_AUTO;
    const H = this.house(), key = this.roomKeys[r] || `r${r}`;
    if (this.roomLevel[r] === LEVEL_AUTO && this.roomWarm[r] === WARM_AUTO) delete H.rooms[key];
    else H.rooms[key] = [this.roomLevel[r], this.roomWarm[r]];
    this.dirty = true;
    this.queueSave();
    return this.preset();
  }

  house() {
    let H = this.settings.houses[this.sig];
    if (!H) { H = { t: 0, floor: 'wood', rooms: {} }; this.settings.houses[this.sig] = H; }
    H.t = Date.now();
    return H;
  }

  queueSave() {
    if (this.saveQueued || !this.storage) return;
    this.saveQueued = true;
    setTimeout(this._save, 0); // never from the frame loop itself
  }

  save() {
    this.saveQueued = false;
    if (!this.storage) return;
    try { this.storage.setItem(ROOMLIGHT_KEY, serializeRoomLight(/** @type {any} */ (this.settings))); this.stats.saves++; } catch { this.stats.saveErrors++; }
  }

  // ─────────────────────────────────────────────────────────── per frame

  /**
   * @param {number} dt0 s @param {number} t ms @param {any} _frame @param {any} [ctx] { world, player, camera }
   */
  update(dt0, t, _frame, ctx) {
    const dt = dt0 > 0 ? (dt0 < 0.25 ? dt0 : 0.25) : 0; // NaN, negative or a long stall: no step
    this.now = t;
    if (this.t0 < 0) this.t0 = t;
    this.minute = Number.isFinite(t) ? (this.min0 + (t - this.t0) / 60000) | 0 : this.minute;
    // head motion for the camera gate
    const cam = ctx && ctx.camera;
    if (cam && this.camera.on) this.trackHead(cam.quaternion);
    // the player's room, 2 Hz
    this.roomClock -= dt;
    if (this.roomClock <= 0 || this.dirty) {
      this.roomClock = 0.5;
      const w = ctx && ctx.world, p = ctx && ctx.player;
      let r = 0;
      if (w && w.built) {
        r = w.roamOn ? w.playerRoom | 0 : 0;
        if (r <= 0 && p && p.head && typeof w.roomAt === 'function') r = w.roomAt(p.head.x, p.head.z) | 0;
      }
      r = clampRoom(r);
      if (r !== this.room) { if (this.room >= 0) this.stats.roomChanges++; this.room = r; this.dirty = true; }
    }
    // Every frame on purpose (about a microsecond): code that runs only on events stays unoptimised
    // and boxes every number it touches; hot code is compiled and allocation-free. The smoother's
    // dead band ignores an unchanged target.
    this.retarget();
    const sm = this.smoother;
    sm.dt = dt;
    if (sm.step()) this.dirty = true;
    // key light and env yaw ease (τ 2 s), only while they move
    const K = this.keyDir, G = this.keyGoal;
    const ex = G[0] - K[0], ey = G[1] - K[1], ez = G[2] - K[2];
    let dy = this.yawGoal - this.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
    if (ex * ex + ey * ey + ez * ez > 1e-8 || dy * dy > 1e-8) {
      const k = 1 - Math.exp(-dt / 2);
      K[0] += ex * k; K[1] += ey * k; K[2] += ez * k;
      const kl = Math.sqrt(K[0] * K[0] + K[1] * K[1] + K[2] * K[2]) || 1;
      K[0] /= kl; K[1] /= kl; K[2] /= kl;
      this.yaw += dy * k;
      this.dirty = true;
    }
    this.applyNow(); // every frame, for the same reason (twenty field writes)
    const step = Math.floor(t / 27.78) % 997;
    if (uPtm.value.x > 0) uPtm.value.w = step; // the grain's 36 Hz time step
  }

  /** Choose the target for the current room: the camera's (fresh), else the preset / auto. */
  retarget() {
    const r = this.room < 0 ? 0 : this.room;
    const T0 = this.target;
    if (this.camera.on && this.camValid && this.now - this.camAt < 10000) {
      for (let i = 0; i < TARGET_LEN; i++) T0[i] = this.camTarget[i];
      T0[T.E] *= CAM_TRIM[this.roomLevel[r]] || 1;
    } else presetTargets(this.roomLevel[r], this.roomWarm[r], this.minute, this.roomWindow[r] === 1, T0);
    if (this.smoother.setTarget(T0)) { this.stats.targetsAccepted++; this.stats.retargets++; }
    this.keyGoal[0] = this.roomKey[r * 3]; this.keyGoal[1] = this.roomKey[r * 3 + 1]; this.keyGoal[2] = this.roomKey[r * 3 + 2];
    this.yawGoal = this.roomYaw[r];
  }

  /** Jump to the current targets (behind the "Get ready" panel). */
  snap() {
    this.smoother.snap();
    for (let i = 0; i < 3; i++) this.keyDir[i] = this.keyGoal[i];
    this.yaw = this.yawGoal;
    this.applyNow();
  }

  /** Write the lights and uniforms from the smoothed value (field writes only: no call takes a double). */
  applyNow() {
    const v = this.smoother.primed ? this.smoother.value : presetTargets(LEVEL_AUTO, WARM_AUTO, this.minute, false, this.target);
    const lv = lightLevels(this.base, v, this.levels);
    const h = this.hemi, s = this.sun, hc = h.color, hg = h.groundColor, sc = s.color, sp = s.position, K = this.keyDir, d = this.sunDist;
    h.intensity = lv[LV.HEMI];
    hc.r = lv[LV.SKY]; hc.g = lv[LV.SKY + 1]; hc.b = lv[LV.SKY + 2];
    hg.r = lv[LV.GROUND]; hg.g = lv[LV.GROUND + 1]; hg.b = lv[LV.GROUND + 2];
    s.intensity = lv[LV.SUN];
    sc.r = lv[LV.SUNC]; sc.g = lv[LV.SUNC + 1]; sc.b = lv[LV.SUNC + 2];
    sp.x = K[0] * d; sp.y = K[1] * d; sp.z = K[2] * d;
    this.scene.environmentIntensity = lv[LV.ENV];
    const er = this.scene.environmentRotation;
    if (er.y !== this.yaw) er.y = this.yaw;
    const rl = uRoomLight.value;
    rl.x = lv[LV.ROOM]; rl.y = lv[LV.ROOM + 1]; rl.z = lv[LV.ROOM + 2];
    uPtm.value.x = lv[LV.GRAIN];
    uPtm.value.y = lv[LV.BLACK];
    this.dirty = false;
  }

  // ─────────────────────────────────────────────────────────── camera (opt-in)

  /**
   * Turn on camera matching. Call ONLY from a tap on the 2D page (a user
   * gesture of its own), never inside the Enter click. Resolves with the
   * outcome; nothing throws.
   * @returns {Promise<{ ok: boolean, note: string }>}
   */
  async requestCamera() {
    const C = this.camera;
    if (C.on) return { ok: true, note: 'camera already on' };
    C.rejected = ''; C.error = '';
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function' || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      C.error = 'this browser has no camera, worker or ImageBitmap API';
      return { ok: false, note: C.error };
    }
    try {
      this.stream = await md.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } });
      const tr = this.stream.getVideoTracks()[0];
      C.settings = tr && typeof tr.getSettings === 'function' ? tr.getSettings() : null;
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      v.srcObject = this.stream;
      document.body.appendChild(v);
      await v.play();
      this.video = v;
      this.worker = new Worker(new URL('./roomLight.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = this._onMessage;
      this.worker.onerror = () => { C.error = 'worker failed'; this.stopCamera('worker failed'); };
      C.on = true;
      this.setCameraWanted(true);
      this.schedule();
      return { ok: true, note: 'camera on' };
    } catch (e) {
      C.error = e && typeof e === 'object' && 'name' in e ? String(/** @type {any} */ (e).name) : String(e);
      this.stopCamera('');
      return { ok: false, note: `camera refused (${C.error})` };
    }
  }

  /** Turn camera matching off (also the page's toggle). @param {string} [why] */
  stopCamera(why = 'off') {
    const C = this.camera;
    C.on = false;
    if (why && why !== 'off') C.rejected = why;
    this.camValid = false;
    if (this.stream) { for (const tr of this.stream.getTracks()) tr.stop(); this.stream = null; }
    if (this.video) { this.video.srcObject = null; this.video.remove(); this.video = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (why === 'off') this.setCameraWanted(false);
    this.dirty = true;
  }

  /** @param {boolean} on */
  setCameraWanted(on) {
    this.camera.wanted = on;
    if (this.settings.camera !== on) { this.settings.camera = on; this.queueSave(); }
  }

  schedule() {
    const v = /** @type {any} */ (this.video);
    if (!v || !this.camera.on) return;
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(this._onFrame);
    else setTimeout(() => this.onVideoFrame(performance.now(), null), 250);
  }

  /**
   * The video's frame callback (outside the XR frame): every 2 s, a 32 × 24
   * bitmap to the worker. Times the synchronous part.
   * @param {number} now @param {any} meta
   */
  onVideoFrame(now, meta) {
    const C = this.camera;
    if (!C.on || !this.video) return;
    if (!this.camBusy && now - this.camLast >= RL.sampleMs) {
      this.camLast = now;
      this.camBusy = true;
      const capture = meta && Number.isFinite(meta.captureTime) ? meta.captureTime : now;
      const id = ++this.camId;
      const t0 = performance.now();
      createImageBitmap(this.video, { resizeWidth: 32, resizeHeight: 24, resizeQuality: 'low' }).then((bmp) => {
        if (!this.worker) { bmp.close(); this.camBusy = false; return; }
        this.worker.postMessage({ id, capture, bmp }, [bmp]);
      }, () => { this.camBusy = false; C.skipped++; });
      const ms = performance.now() - t0;
      if (ms > C.syncMsMax) C.syncMsMax = ms;
      if (ms > 1) { C.slow++; if (C.slow >= 2) { this.stopCamera('the camera sample cost over 1 ms on the main thread'); return; } }
    }
    this.schedule();
  }

  /**
   * A worker result: gate by the head motion at capture time, map, keep.
   * @param {{ id: number, capture: number, stats: Float64Array, ms: number } | null} d
   */
  onWorker(d) {
    this.camBusy = false;
    const C = this.camera;
    if (!d || !d.stats || d.stats.length < STATS_LEN) { C.skipped++; return; }
    C.samples++;
    if (d.ms > C.workerMsMax) C.workerMsMax = d.ms;
    for (let i = 0; i < STATS_LEN; i++) this.camStats[i] = d.stats[i];
    let turn = 0, pitch = 0, best = Infinity;
    for (let i = 0; i < Math.min(this.headN, 32); i++) {
      const e = Math.abs(this.headT[i] - d.capture);
      if (e < best) { best = e; turn = this.headTurn[i]; pitch = this.headPitch[i]; }
    }
    if (!sampleOk(turn, pitch, this.camStats[ST.CLIPPED]) || !targetsFromStats(this.camStats, 1, this.camTarget)) { C.skipped++; return; }
    C.used++;
    C.lastAt = d.capture;
    this.camValid = true;
    this.camAt = d.capture;
    this.roomClock = 0; // retarget on the next frame
  }

  /**
   * Head yaw rate and pitch ring (for pairing samples with their capture time), at `this.now`.
   * @param {{ x: number, y: number, z: number, w: number }} q
   */
  trackHead(q) {
    const t = this.now;
    // forward = q · (0, 0, −1)
    const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const yaw = Math.atan2(fx, -fz) * 57.29578, pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * 57.29578;
    let rate = 0;
    if (Number.isFinite(this.prevYaw) && t > this.prevT) {
      let d = yaw - this.prevYaw;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      rate = d / ((t - this.prevT) / 1000);
    }
    this.prevYaw = yaw; this.prevT = t;
    const i = this.headN++ % 32;
    this.headT[i] = t; this.headTurn[i] = rate; this.headPitch[i] = pitch;
  }

  /** JSON-safe summary (session end). */
  report() {
    const v = this.smoother.value, C = this.camera;
    const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
    return {
      sig: this.sig, room: this.room, rooms: this.roomKeys.length, windows: Array.from(this.roomWindow).reduce((a, b) => a + b, 0),
      preset: this.preset(), floor: this.floor,
      value: { E: r3(v[T.E]), w: [r3(v[T.WR]), r3(v[T.WG]), r3(v[T.WB])], black: r3(v[T.BLACK]), grain: r3(v[T.GRAIN]), key: r3(v[T.KEY]) },
      lights: { hemi: r3(this.hemi.intensity), sun: r3(this.sun.intensity), env: r3(this.scene.environmentIntensity) },
      camera: { on: C.on, wanted: C.wanted, rejected: C.rejected, error: C.error, samples: C.samples, used: C.used, skipped: C.skipped,
        syncMsMax: r3(C.syncMsMax), workerMsMax: r3(C.workerMsMax), settings: C.settings },
      ...this.stats,
    };
  }
}

/** @param {number} r */
function clampRoom(r) { return r > 0 ? (r < MAX_ROOMS ? r | 0 : MAX_ROOMS - 1) : 0; }

/** Shoelace area of [[x, z], …]. @param {number[][]} poly */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

/**
 * A saved room for a key: the same key, else the same furniture labels with
 * an area within 3 m².
 * @param {Record<string, [number, number]>} rooms @param {string} key
 * @returns {[number, number] | null}
 */
export function matchRoom(rooms, key) {
  if (!key) return null;
  if (rooms[key]) return rooms[key];
  const m = /^a(\d+)\|(.*)$/.exec(key);
  if (!m) return null;
  const area = +m[1], labs = m[2];
  let best = null, bd = 3.5;
  for (const k of Object.keys(rooms)) {
    const n = /^a(\d+)\|(.*)$/.exec(k);
    if (!n || n[2] !== labs) continue;
    const d = Math.abs(+n[1] - area);
    if (d < bd) { bd = d; best = rooms[k]; }
  }
  return best;
}

/** @param {Storage|null} s @param {string} k */
function readKey(s, k) { try { return s ? s.getItem(k) : null; } catch { return null; } }

function localHour() {
  try { const d = new Date(); return d.getHours() + d.getMinutes() / 60; } catch { return 12; }
}

/**
 * Run the room-light maths a few thousand times at load, so the JIT has
 * optimised it before play (it runs only on events then, and unoptimised code
 * boxes every intermediate number).
 */
function warmMath() {
  const sm = new LightSmoother(), t = new Float64Array(TARGET_LEN), lv = new Float64Array(LEVELS_LEN);
  const base = { hemi: 1, sun: 1, env: 1, sky: [1, 1, 1], ground: [0.1, 0.1, 0.1], sunColor: [1, 1, 1] };
  for (let i = 0; i < 3000; i++) {
    presetTargets(i & 3, (i >> 2) & 3, (i * 7) % 1440, (i & 1) === 1, t);
    sm.setTarget(t);
    sm.dt = 1 / 72;
    sm.step();
    lightLevels(base, sm.value, lv);
  }
}
