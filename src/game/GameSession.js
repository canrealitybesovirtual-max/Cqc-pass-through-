// @ts-check
import * as THREE from 'three';
import { CanvasPanel } from '../ui/CanvasPanel.js';
import { MSG, PAUSE, PHASE, PHASE_NAME, RULES, SurvivalRules } from './Rules.js';
import { claimUpload } from './UploadGate.js';

/**
 * Survival game session (CONTRACTS.md "Game, audio, HUD"): the `game` system.
 *
 *   const game = new GameSession(ctx, { enemies, weapons });   // at load, before the warm-up
 *   // warm-up: game.warmMeshes() are drawn once (game.setWarm(true) … game.setWarm(false))
 *   game.start();                       // after the Space Setup capture; zone = where the head is now
 *   world.build(snapshot, game.zone);   // (or build first and pass world.zone to start())
 *   // each frame, after enemies: game.update(dt, t, frame, ctx)
 *   game.onExit = (reason) => setTimeout(() => session.end(), 0);   // optional; this is the default
 *
 * Rules live in the pure `SurvivalRules` (Rules.js). This class wires them to
 * the world, the enemy manager, events, audio and haptics, and owns three
 * meshes created at construction (so the warm-up compiles them and nothing is
 * created later):
 * - the safe-zone floor ring (one mesh; amber near the edge, red pulsing
 *   outside, green while resuming);
 * - the damage tint: ONE full-view quad 15 cm ahead of the eyes (beyond the
 *   10 cm depth-sensing near plane), always `transparent`, opacity ≤ 0.3 for
 *   ≤ 0.3 s, stronger at the edges (PLAN §5: never cover the view);
 * - the floating message panel (CanvasPanel, tag-along).
 *
 * Pauses (rules.paused) stop the wave clocks and ignore damage; the `pause`
 * event tells the other systems. Integration may also skip the enemy and
 * weapon updates while `game.paused`. Allocation-free per frame; message lines
 * are prebuilt (the round-over line is built once per death).
 */

const SPAWN_MIN_M = 3.5;
const GAP_PAUSE_MS = 500;
const TINT_S = 0.3;
const TINT_MAX = 0.3;
const TINT_DIST = 0.15;
const RING_IN = 0.025;
const RING_OUT = 0.015;
const COL_AMBER = 0xffb02e;
const COL_RED = 0xff3b30;
const COL_GREEN = 0x4cd964;

/** @type {string[][]} */ const WAVE_LINES = [];
/** @type {string[][]} */ const CLEAR_LINES = [];
for (let n = 0; n < 100; n++) {
  WAVE_LINES.push([`Wave ${n}`]);
  CLEAR_LINES.push([`Wave ${n} cleared`, `+${RULES.breakHeal} health`]);
}
const COUNT_LINES = [['Go'], ['1'], ['2'], ['3']];
const LINES = {
  ready: ['Get ready', 'Stay inside the ring on the floor'],
  zone: ['Return to your spot', 'Paused: step back inside the ring'],
  paused: ['Paused'],
  hold: ['Hold still'],
  exiting: ['Exiting…', 'Keep holding Y'],
};

/**
 * @typedef {Object} GameCtx
 * @property {THREE.Scene} scene
 * @property {any} camera
 * @property {XRSession|null} [session]
 * @property {import('../xr/Input.js').Input} [input]
 * @property {import('../core/Events.js').Events} events
 * @property {import('../audio/AudioEngine.js').AudioEngine} [audio]
 * @property {any} [world]  World: findSpawn, floorY
 * @property {import('./Player.js').Player} player
 */

export class GameSession {
  /**
   * @param {GameCtx} ctx
   * @param {{ enemies?: { spawn: (x: number, z: number, facing: number) => number, alive: () => number, reset: () => void } | null,
   *   weapons?: { ammo?: () => any, reset?: () => void } | null, seed?: number, ringMode?: 'edge'|'always' }} [o]
   */
  constructor(ctx, { enemies = null, weapons = null, seed, ringMode = 'edge' } = {}) {
    this.ctx = ctx;
    this.enemies = enemies;
    this.weapons = weapons;
    this.ringMode = ringMode;
    /** @type {((reason: string) => void) | null} */ this.onExit = null;
    this.exiting = false;
    this.exitReason = '';
    this.hiddenFlag = false;
    this.lastT = -1;
    /** Safe zone (also mirrored into ctx.player.zone at start). */
    /** @type {{ x: number, z: number, r: number }} */
    this.zone = { x: 0, z: 0, r: RULES.zoneR };
    this.stats = { hits: 0, damage: 0, spawnFails: 0 };
    this._spawnAt = { x: 0, z: 0 };

    const host = {
      spawn: () => this._spawn(),
      alive: () => (this.enemies ? this.enemies.alive() : 0),
      waveStart: (/** @type {number} */ w, /** @type {number} */ n) => this._waveStart(w, n),
      waveClear: (/** @type {number} */ w) => this._waveClear(w),
      roundOver: (/** @type {number} */ w, /** @type {number} */ k) => this._roundOver(w, k),
      pause: (/** @type {boolean} */ p, /** @type {number} */ r) => this._pause(p, r),
      health: (/** @type {number} */ h) => this._health(h),
      restart: () => this._restart(),
      exit: (/** @type {string} */ r) => this.requestExit(r),
    };
    this.rules = new SurvivalRules(host, { seed });

    // event payloads (reused)
    this._pWave = { wave: 0, enemies: 0 };
    this._pClear = { wave: 0 };
    this._pOver = { wave: 0, kills: 0 };
    this._pPause = { paused: false, reason: '' };

    // ── meshes, all created now ──
    const ringMat = new THREE.MeshBasicMaterial({ color: COL_AMBER, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    ringMat.name = 'game-zone-ring';
    const ringGeo = new THREE.RingGeometry(RULES.zoneR - RING_IN, RULES.zoneR + RING_OUT, 128, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.name = 'game-zone-ring';
    this.ring.renderOrder = 5;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this._ringCol = COL_AMBER;

    this.tintTex = radialAlpha(64);
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0xb00000, transparent: true, opacity: 0, alphaMap: this.tintTex,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    tintMat.name = 'game-damage-tint';
    this.tint = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), tintMat);
    this.tint.name = 'game-damage-tint';
    this.tint.renderOrder = 60;
    this.tint.frustumCulled = false;
    this.tint.visible = false;
    this._tintT = 0;
    this._tintPeak = 0;

    this.panel = new CanvasPanel({ width: 512, height: 128, worldWidth: 0.42 });
    this.panel.mesh.name = 'game-message';
    this.panel.mesh.visible = false;
    this._msgKey = -1;
    /** @type {string[]} */ this._overLines = ['Round over — Y to restart'];
    this._view = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

    if (ctx.scene) ctx.scene.add(this.ring, this.tint, this.panel.mesh);

    this._onPlayerHit = this._onPlayerHit.bind(this);
    this._onEnemyKilled = this._onEnemyKilled.bind(this);
    this._endSession = this._endSession.bind(this);
    /** @type {(() => void)[]} */
    this._unsub = ctx.events ? [ctx.events.on('playerHit', this._onPlayerHit), ctx.events.on('enemyKilled', this._onEnemyKilled)] : [];
  }

  get phase() { return this.rules.phase; }
  get phaseName() { return PHASE_NAME[this.rules.phase]; }
  get paused() { return this.rules.paused; }
  get wave() { return this.rules.wave; }
  get kills() { return this.rules.kills; }
  get health() { return this.rules.health; }

  /** Meshes for the warm-up draw (compiled and drawn once before XR). */
  warmMeshes() { return [this.ring, this.tint, this.panel.mesh]; }

  /** Textures for `renderer.initTexture`. */
  textures() { return [this.tintTex, this.panel.texture]; }

  /**
   * Show every mesh for the warm-up draw, then hide them again. Opacity and
   * visibility are not part of the program key; `transparent` never changes.
   * @param {boolean} on
   */
  setWarm(on) {
    this.ring.visible = on;
    this.tint.visible = on;
    this.panel.mesh.visible = on;
    if (on) {
      const cam = this.ctx.camera;
      if (cam) {
        // in front of the warm-up camera, so the draw really happens
        this.tint.position.copy(cam.position);
        this.tint.quaternion.copy(cam.quaternion);
        this.tint.translateZ(-TINT_DIST);
        this.panel.mesh.position.copy(cam.position);
        this.panel.mesh.quaternion.copy(cam.quaternion);
        this.panel.mesh.translateZ(-0.8);
      }
    } else {
      this._msgKey = -1;
      this.panel.placed = false;
    }
  }

  /**
   * Start a round. The safe zone is centred where the head is now (or `zone`).
   * @param {{ x: number, z: number, r?: number }} [zone]
   */
  start(zone) {
    const p = this.ctx.player;
    const r = zone && zone.r && zone.r > 0 ? zone.r : RULES.zoneR;
    const x = zone ? zone.x : p && p.valid !== false ? p.head.x : 0;
    const z = zone ? zone.z : p && p.valid !== false ? p.head.z : 0;
    this.zone.x = Number.isFinite(x) ? x : 0;
    this.zone.z = Number.isFinite(z) ? z : 0;
    this.zone.r = r;
    if (p) { p.zone.x = this.zone.x; p.zone.z = this.zone.z; p.zone.r = r; }
    const k = r / RULES.zoneR;
    this.ring.scale.set(k, 1, k);
    this.rules.zoneR = r;
    this.exiting = false;
    this.exitReason = '';
    this.lastT = -1;
    this._msgKey = -1;
    this.rules.start();
  }

  /** End of session: idle, everything hidden, events kept (dispose() drops them). */
  stop() {
    this.rules.stop();
    this.ring.visible = false;
    this.tint.visible = false;
    this.panel.mesh.visible = false;
    this._tintT = 0;
    this._msgKey = -1;
  }

  dispose() {
    this.stop();
    for (let i = 0; i < this._unsub.length; i++) this._unsub[i]();
    this._unsub.length = 0;
  }

  /** From the XR lifecycle (`visibilitychange`). @param {string} state */
  setVisibility(state) { this.hiddenFlag = state !== 'visible'; }

  /** The reference space was reset (recentred): pause and run the resume countdown. */
  onReferenceReset() { this.rules.interrupt(); }

  /**
   * Leave the session (wrist menu or holding Y). Calls `onExit` once; by
   * default ends the XR session from a timeout, never inside the frame
   * callback (DEVICE_LOG p1.1).
   * @param {string} reason
   */
  requestExit(reason) {
    if (this.exiting) return;
    this.exiting = true;
    this.exitReason = reason;
    if (this.onExit) this.onExit(reason);
    else if (this.ctx.session) setTimeout(this._endSession, 0);
  }

  _endSession() {
    const s = this.ctx.session;
    if (s) s.end().catch(() => {});
  }

  /**
   * @param {number} dt @param {number} t
   * @param {XRFrame|null|undefined} _frame
   * @param {GameCtx} ctx
   */
  update(dt, t, _frame, ctx) {
    const R = this.rules;
    const p = ctx.player;
    if (this.lastT >= 0 && t - this.lastT > GAP_PAUSE_MS) R.interrupt();
    this.lastT = t;
    const s = ctx.session;
    const vs = s ? s.visibilityState : 'visible';
    const visible = !this.hiddenFlag && (vs === undefined || vs === 'visible');
    let dist = 0;
    if (p && p.valid !== false) {
      const dx = p.head.x - this.zone.x, dz = p.head.z - this.zone.z;
      dist = Math.sqrt(dx * dx + dz * dz);
    }
    const y = ctx.input ? ctx.input.left.b : false;
    R.update(dt, dist, visible, y);
    this.stats.spawnFails = R.spawnFails;
    this.updateRing(t, dist, ctx);
    this.updateTint(dt, p);
    this.updateMessage(dt, t, p);
  }

  // ── visuals ──────────────────────────────────────────────────────────────

  /** @param {number} t @param {number} dist @param {GameCtx} ctx */
  updateRing(t, dist, ctx) {
    const R = this.rules;
    const ring = this.ring;
    if (R.phase === PHASE.IDLE) { ring.visible = false; return; }
    const r = this.zone.r;
    let op, col;
    if (R.paused && (R.reasons & PAUSE.ZONE)) {
      col = COL_RED;
      op = 0.65 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.008));
    } else if (R.paused) {
      col = COL_GREEN;
      op = 0.8;
    } else {
      col = COL_AMBER;
      const k = smoothstep(0.5 * r, 0.95 * r, dist);
      op = this.ringMode === 'always' ? 0.3 + 0.6 * k : 0.85 * k;
      if (R.phase === PHASE.READY && op < 0.6) op = 0.6; // "Stay inside the ring": show where it is
    }
    const mat = /** @type {THREE.MeshBasicMaterial} */ (ring.material);
    if (col !== this._ringCol) { mat.color.setHex(col); this._ringCol = col; }
    mat.opacity = op;
    const w = ctx.world;
    const fy = w && typeof w.floorY === 'function' ? w.floorY(this.zone.x, this.zone.z) : 0;
    ring.position.set(this.zone.x, (Number.isFinite(fy) ? fy : 0) + 0.005, this.zone.z);
    ring.visible = op > 0.01;
  }

  /** @param {number} dt @param {import('./Player.js').Player} p */
  updateTint(dt, p) {
    const tint = this.tint;
    if (this._tintT <= 0 || !p) { tint.visible = false; return; }
    this._tintT -= dt;
    const k = this._tintT > 0 ? this._tintT / TINT_S : 0;
    const op = this._tintPeak * k;
    /** @type {THREE.MeshBasicMaterial} */ (tint.material).opacity = op;
    if (op <= 0.003) { tint.visible = false; return; }
    const e = p.eye || p.head, f = p.forward;
    tint.position.set(e.x + f.x * TINT_DIST, e.y + f.y * TINT_DIST, e.z + f.z * TINT_DIST);
    if (p.quat) tint.quaternion.copy(p.quat);
    tint.visible = true;
  }

  /** @param {number} dt @param {number} t @param {import('./Player.js').Player} p */
  updateMessage(dt, t, p) {
    const R = this.rules;
    const panel = this.panel;
    const key = R.msg * 1000 + R.msgN;
    if (key !== this._msgKey) {
      this._msgKey = key;
      const lines = this.linesFor(R.msg, R.msgN);
      if (lines) {
        panel.setLines(lines);
        if (!panel.mesh.visible) panel.placed = false;
        panel.mesh.visible = true;
      } else {
        panel.mesh.visible = false;
        panel.placed = false;
      }
    }
    if (!panel.mesh.visible) return;
    if (p && p.valid !== false && p.quat) {
      const v = this._view;
      v.position.copy(p.eye || p.head);
      v.quaternion.copy(p.quat);
      panel.follow(/** @type {any} */ (v), dt);
    } else if (this.ctx.camera) panel.follow(this.ctx.camera, dt);
    if (panel.dirty && claimUpload(t)) panel.flush();
  }

  /** @param {number} m @param {number} n @returns {string[]|null} */
  linesFor(m, n) {
    switch (m) {
      case MSG.GET_READY: return LINES.ready;
      case MSG.WAVE: return n < WAVE_LINES.length ? WAVE_LINES[n] : [`Wave ${n}`];
      case MSG.CLEARED: return n < CLEAR_LINES.length ? CLEAR_LINES[n] : [`Wave ${n} cleared`];
      case MSG.OVER: return this._overLines;
      case MSG.ZONE: return LINES.zone;
      case MSG.PAUSED: return LINES.paused;
      case MSG.HOLD: return LINES.hold;
      case MSG.COUNT: return COUNT_LINES[n > 3 ? 3 : n < 0 ? 0 : n];
      case MSG.EXITING: return LINES.exiting;
      default: return null;
    }
  }

  // ── rules host ───────────────────────────────────────────────────────────

  _spawn() {
    const w = this.ctx.world, e = this.enemies, p = this.ctx.player;
    if (!w || !e || !p || typeof w.findSpawn !== 'function') return false;
    const f = p.flatForward || p.forward;
    const o = this._spawnAt;
    if (!w.findSpawn(p.head.x, p.head.z, f.x, f.z, SPAWN_MIN_M, o)) return false;
    // facing as a yaw about +Y, 0 = +Z (the soldier GLB faces +Z): toward the player
    const facing = Math.atan2(p.head.x - o.x, p.head.z - o.z);
    return e.spawn(o.x, o.z, facing) >= 0;
  }

  /** @param {number} w @param {number} n */
  _waveStart(w, n) {
    this._pWave.wave = w;
    this._pWave.enemies = n;
    this.ctx.events.emit('waveStart', this._pWave);
  }

  /** @param {number} w */
  _waveClear(w) {
    this._pClear.wave = w;
    this.ctx.events.emit('waveClear', this._pClear);
  }

  /** @param {number} w @param {number} k */
  _roundOver(w, k) {
    const p = this.ctx.player;
    if (p) { p.health = 0; p.alive = false; }
    // built once per death (not per frame)
    this._overLines = ['Round over — Y to restart', `Wave ${w} · ${k} ${k === 1 ? 'kill' : 'kills'}`];
    this._msgKey = -1;
    this._pOver.wave = w;
    this._pOver.kills = k;
    this.ctx.events.emit('roundOver', this._pOver);
  }

  /** @param {boolean} paused @param {number} reason */
  _pause(paused, reason) {
    this._pPause.paused = paused;
    this._pPause.reason = reason === PAUSE.ZONE ? 'zone' : reason === PAUSE.HIDDEN ? 'hidden' : '';
    this.ctx.events.emit('pause', this._pPause);
  }

  /** @param {number} h */
  _health(h) {
    const p = this.ctx.player;
    if (!p) return;
    p.health = h;
    p.alive = h > 0;
  }

  _restart() {
    if (this.enemies) this.enemies.reset();
    if (this.weapons && typeof this.weapons.reset === 'function') this.weapons.reset();
    this._tintT = 0;
    this.tint.visible = false;
    const p = this.ctx.player;
    if (p) { p.health = RULES.maxHealth; p.alive = true; }
  }

  // ── events ───────────────────────────────────────────────────────────────

  /** @param {{ damage: number, fromX: number, fromY: number, fromZ: number }} e */
  _onPlayerHit(e) {
    const d = this.rules.damage(e.damage);
    if (d <= 0) return;
    this.stats.hits++;
    this.stats.damage += d;
    // view tint: ≤ 0.3 opacity, ≤ 0.3 s; a second hit raises it, never stacks past the cap
    const peak = Math.min(TINT_MAX, 0.1 + 0.004 * d);
    this._tintPeak = this._tintT > 0 ? Math.max(peak, this._tintPeak * (this._tintT / TINT_S)) : peak;
    this._tintT = TINT_S;
    const p = this.ctx.player;
    const audio = this.ctx.audio;
    if (p && audio) {
      // the impact on your body, on the side the round came from
      const T = p.torsoTop;
      let dx = e.fromX - T.x, dy = e.fromY - T.y, dz = e.fromZ - T.z;
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l > 1e-3) { dx /= l; dy /= l; dz /= l; } else { dx = dy = dz = 0; }
      audio.play('impactFlesh', T.x + dx * 0.18, T.y + dy * 0.18, T.z + dz * 0.18, 0.8 + d * 0.004);
    }
    const inp = this.ctx.input;
    if (inp) {
      const v = Math.min(1, 0.5 + d / 100), ms = Math.min(110, 50 + d);
      pulse(inp.left.source, v, ms);
      pulse(inp.right.source, v, ms);
    }
  }

  /** @param {{ headshot: boolean }} e */
  _onEnemyKilled(e) { this.rules.kill(!!(e && e.headshot)); }
}

/**
 * @param {XRInputSource|null} src @param {number} v @param {number} ms
 */
function pulse(src, v, ms) {
  const gp = src && src.gamepad;
  const h = gp && /** @type {any} */ (gp).hapticActuators;
  const a = h && h.length > 0 ? h[0] : null;
  if (a && typeof a.pulse === 'function') {
    try { a.pulse(v, ms); } catch { /* not supported */ }
  }
}

/** @param {number} a @param {number} b @param {number} x */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Alpha mask for the damage tint: 0.45 in the centre rising to 1 at the edges,
 * so the middle of the view stays clearest. A DataTexture (no canvas, no mips).
 * @param {number} n
 */
function radialAlpha(n) {
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1, y = ((j + 0.5) / n) * 2 - 1;
      const r = Math.min(1, Math.sqrt(x * x + y * y) / Math.SQRT2 * 1.25);
      const a = 0.45 + 0.55 * smoothstep(0.25, 1, r);
      const k = (j * n + i) * 4;
      const b = Math.round(a * 255);
      data[k] = data[k + 1] = data[k + 2] = data[k + 3] = b;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'game-damage-tint-alpha';
  return tex;
}
