// @ts-check
import * as THREE from 'three';
import { claimUpload } from '../game/UploadGate.js';
import { GlyphBoard } from './Glyphs.js';
import { uiAtlas } from './uiAtlas.js';
import {
  WATCH, GRIP_IN_RAY, watchOffset, WakeGate, TapGate, PressGate, PRESS, Confirm, handAngles, BezelTurn,
  WarnPlan, WARN, PAGE, ROW, ROW_NAMES, PAGE_ROWS, isValueRow, needsConfirm, MENU_PX, rowRect, hitMenu,
  FitEdit, FIT_FIELD, FIT_WEAPONS, weaponIndex, STATE, stateCode, modeCode, infoCode, INFO, synthTick, synthAlert, menuSpot,
} from './watchLogic.js';
import { drawSteelMatcap, drawGlassMatcap, drawFaceAtlas, drawMenuBackground, layoutReadouts, layoutMenu, FACE, READ, READ_REGIONS, RC } from './watchArt.js';
import { buildSteel, buildFace, buildGlass, buildMenuRim } from './watchGeometry.js';

/**
 * The wrist watch (replaces WristHud): a steel dive watch on the back of the
 * LEFT wrist that is also the game's only menu.
 *
 * - **Dial = STATUS.** 12 o'clock window: health (with a level bar). 3 o'clock
 *   window under the cyclops: rounds in the magazine and a chamber dot. 9
 *   o'clock window: the wave (rooms found while scanning, in blue). Below the
 *   centre: the AKM's fire mode (SAFE amber, SEMI white, AUTO red) or "G17",
 *   then one info line: a warning, the round state, the scan progress, "TAP ·
 *   MENU" while awake with a free right hand, or the kills. Real-time hands
 *   (8 beats/s), and a unidirectional bezel that clicks round at each wave
 *   start so its pip meets the minute hand.
 * - **Wake:** turn the wrist toward the eyes (WakeGate); a faint tick on the
 *   left hand. Only an awake watch takes taps.
 * - **Open the menu:** touch the dial with the right controller's tip, or
 *   point the right ray at it and pull the trigger (right hand empty, or the
 *   game paused). The MENU is a 16 cm disc that opens in the air above the
 *   watch, facing you (world-placed, never head-locked): RESUME, RESTART (two
 *   taps), DIFFICULTY test/realistic, MODE roam/spot, GUN FIT ▸ (pitch,
 *   height, forward: tap − / + or hold the right stick; SAVE, RESET (two
 *   taps), BACK), AMMO LINE on/off, EXIT (two taps). Touch with the tip or
 *   ray + trigger; a highlight follows the pointer (no texture upload).
 * - **Diegetic warnings:** `warn(kind, level)` vibrates the left hand in a
 *   pattern per kind and puts a small icon + word on the dial (no panels).
 *
 * Integrator API:
 *   const watch = new Watch(ctx, { game, weapons, audio, fit, bracelet, onAction });
 *   watch.onAction = (name, value) => { … };   // see ACTIONS below
 *   watch.setStatus({ learn: 0.62, rooms: 4, scanning: true, difficulty: 'test', playMode: 'roam', ammoLine: true });
 *   watch.setFit('glock', pitchDeg, up, fwd);  // saved gun fit (both guns), at load
 *   watch.warn('obstacle', 0.7);               // 0 clears; kinds: run, edge, obstacle, stairs, tracking
 *   installWatchSounds(audio);                 // after audio.decodeAll(), before Enter
 *   loop 'ui' system: watch.update(dt, t, frame, ctx)
 *   watch.capture  // true while the right hand points at / touches the watch or the menu is open: the trigger belongs to the watch
 *
 * ACTIONS (`onAction(name, value)`, called inside the frame: never write storage synchronously there):
 *   'menu' true|false (opened / closed; pause / resume as you see fit), 'resume', 'restart', 'exit',
 *   'difficulty' 'test'|'realistic', 'mode' 'roam'|'spot', 'ammoLine' boolean,
 *   'fitBegin' 'glock'|'akm' (the FIT page shows that gun: put it in the right hand),
 *   'fit' {weapon, pitchDeg, up, fwd} (live; one reused object), 'fitSave' (same object, per changed gun),
 *   'fitEnd' (same object; values are the saved ones after BACK reverted any unsaved edit).
 *
 * Draws: 4 per eye while the watch is in view (steel, face + hands, readouts,
 * glass), +5 while the menu is open. v0.5: NO texture upload in play: the
 * readouts and the menu's rows are glyph boards over the shared UI atlas
 * (src/ui/Glyphs.js, drawn once at load); a change re-lays them out (≤ 2/s
 * each, one board per frame through the shared gate): a few hundred bytes of
 * instanced attributes. The menu disc's background is a static texture.
 * Allocation-free per frame.
 */

const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

/** @typedef {{ health: number, wave: number, kills: number, state: string, weapon: string|null, mag: number, chambered: boolean,
 *   mode: string|null, spares: number, chamberShow: number, learn: number, rooms: number, scanning: boolean,
 *   difficulty: string, playMode: string, ammoLine: boolean, rightBusy: boolean, paused: boolean }} WatchStatus */

export class Watch {
  /**
   * @param {{ scene?: THREE.Scene }|null} ctx
   * @param {{ game?: any, weapons?: any, audio?: any, fit?: { back?: number, out?: number, tiltDeg?: number, scale?: number }|null,
   *   bracelet?: boolean, onAction?: ((name: string, value?: any) => void)|null, alertSound?: boolean }} [o]
   *   `game` (GameSession-like: health, wave, kills, paused, phaseName) and `weapons` (WeaponSystem-like:
   *   ammo(), busyRight or held) are sampled every frame when given; everything else comes from setStatus.
   */
  constructor(ctx, { game = null, weapons = null, audio = null, fit = null, bracelet = true, onAction = null, alertSound = true } = {}) {
    this._rrInit = { x0: 0, x1: 0, y0: 0, y1: 0 };
    this.game = game;
    this.weapons = weapons;
    this.audio = audio;
    this.alertSound = alertSound;
    /** @type {(name: string, value?: any) => void} */
    this.onAction = onAction || (() => {});
    /** Shown at all (the integrator turns it off outside play / setup sessions). */
    this.enabled = true;

    /** @type {WatchStatus} */
    this.status = {
      health: 100, wave: 0, kills: 0, state: '', weapon: null, mag: -1, chambered: false, mode: null, spares: -1, chamberShow: 0,
      learn: -1, rooms: -1, scanning: false, difficulty: 'test', playMode: 'roam', ammoLine: true, rightBusy: false, paused: false,
    };

    // ── textures ───────────────────────────────────────────────────────────
    this.matcap = canvasTexture(256, 256, (c) => drawSteelMatcap(c, 256), false);
    this.glassCap = canvasTexture(256, 256, (c) => drawGlassMatcap(c, 256), false);
    /** Static dial + bezel atlas: drawn once, mipmapped (minified ~5× on the wrist). */
    this.faceTex = canvasTexture(FACE.w, FACE.h, (c) => drawFaceAtlas(c), true);
    /** v0.5: the shared UI glyph atlas (readout and menu glyphs, drawn once) and the menu disc's static background. */
    const ui = uiAtlas();
    this.atlas = ui.atlas;
    this.art = ui.art;
    this.menuBgTex = canvasTexture(MENU_PX.size, MENU_PX.size, (c) => drawMenuBackground(c), false);

    // ── materials (every program-key property fixed here, never toggled) ──
    this.steelMat = new THREE.MeshMatcapMaterial({ matcap: this.matcap, vertexColors: true, side: THREE.DoubleSide });
    this.steelMat.name = 'watch-steel';
    /** Hand / bezel angles: x bezel, y hour, z minute, w second (radians about +Z). */
    this.uRot = { value: new THREE.Vector4() };
    this.faceMat = new THREE.MeshBasicMaterial({ map: this.faceTex, toneMapped: false });
    this.faceMat.name = 'watch-face';
    const uRot = this.uRot;
    this.faceMat.onBeforeCompile = (shader) => {
      shader.uniforms.uRot = uRot;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart;\nuniform vec4 uRot;')
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'float wAng = aPart < 0.5 ? 0.0 : aPart < 1.5 ? uRot.x : aPart < 2.5 ? uRot.y : aPart < 3.5 ? uRot.z : uRot.w;',
          'float wC = cos(wAng), wS = sin(wAng);',
          'transformed.xy = vec2(wC * transformed.x - wS * transformed.y, wS * transformed.x + wC * transformed.y);',
        ].join('\n'));
    };
    this.faceMat.customProgramCacheKey = () => 'cqc-watch-face-1';
    /** The readouts are a glyph board: the shared board material (transparent, fixed key). */
    this.readMat = this.atlas.material;
    this.glassMat = new THREE.MeshMatcapMaterial({ matcap: this.glassCap, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glassMat.name = 'watch-glass';

    // ── the watch ─────────────────────────────────────────────────────────
    this.root = new THREE.Group();
    this.root.name = 'watch';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.steel = mesh(buildSteel({ bracelet }), this.steelMat, 'watch-steel', 0);
    this.face = mesh(buildFace(), this.faceMat, 'watch-face', 0);
    this.readBoard = new GlyphBoard(this.atlas, { capacity: 96, name: 'watch-readouts', renderOrder: 1 });
    this.readouts = this.readBoard.mesh;
    this.readouts.position.z = 0.00012;
    // region px → dial metres: each readout window sits at its own place on the dial (10 px per mm)
    READ_REGIONS.forEach((key, i) => {
      const R = /** @type {any} */ (READ)[key], k = 0.001 / READ.px;
      this.readBoard.setFrame(i, R.cx * 0.001 - (R.x + R.w / 2) * k, R.cy * 0.001 + (R.y + R.h / 2) * k, k);
    });
    this.glass = mesh(buildGlass(), this.glassMat, 'watch-glass', 2);
    this.root.add(this.steel, this.face, this.readouts, this.glass);

    // ── the menu disc ─────────────────────────────────────────────────────
    const MR = WATCH.menu.r;
    this.menuRoot = new THREE.Group();
    this.menuRoot.name = 'watch-menu';
    this.menuRoot.matrixAutoUpdate = false;
    this.menuRoot.visible = false;
    this.menuMat = new THREE.MeshBasicMaterial({ map: this.menuBgTex, toneMapped: false });
    this.menuMat.name = 'watch-menu';
    this.menuDisc = mesh(new THREE.CircleGeometry(MR, 96), this.menuMat, 'watch-menu-disc', 0);
    this.menuRim = mesh(buildMenuRim(MR), this.steelMat, 'watch-menu-rim', 0);
    this.hiMat = new THREE.MeshBasicMaterial({ color: 0x8cffd7, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false });
    this.hiMat.name = 'watch-menu-highlight';
    /** One pill-shaped highlight per row position (the pages share the layout), and a disc for the − / + ends. */
    this.hiRows = /** @type {THREE.Mesh[]} */ ([]);
    for (let i = 0; i < PAGE_ROWS[0].length; i++) {
      const h = mesh(pillGeometry(rowRect(i, this._rrInit)), this.hiMat, `watch-menu-hi-${i}`, 51);
      h.position.z = 0.0008;
      h.visible = false;
      this.hiRows.push(h);
    }
    const S0 = (2 * MR) / MENU_PX.size;
    this.hiZone = mesh(new THREE.CircleGeometry((MENU_PX.rowH / 2 - 3) * S0, 24), this.hiMat, 'watch-menu-hi-zone', 51);
    this.hiZone.position.z = 0.0008;
    this.hiZone.visible = false;
    /** A highlight is showing. */
    this.hiVisible = false;
    this.cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.cursorMat.name = 'watch-menu-cursor';
    this.cursor = mesh(new THREE.CircleGeometry(0.0026, 20), this.cursorMat, 'watch-menu-cursor', 52);
    this.cursor.position.z = 0.0016;
    this.cursor.visible = false;
    /** The menu's rows and strip: a glyph board just above the disc, under the highlights. */
    this.menuBoard = new GlyphBoard(this.atlas, { capacity: 320, name: 'watch-menu-text', renderOrder: 50 });
    this.menuBoard.mesh.position.z = 0.0004;
    this.menuBoard.frame(-MENU_PX.c * S0, MENU_PX.c * S0, S0);
    this.menuRoot.add(this.menuDisc, this.menuRim, ...this.hiRows, this.hiZone, this.cursor, this.menuBoard.mesh);

    if (ctx && ctx.scene) { ctx.scene.add(this.root); ctx.scene.add(this.menuRoot); }

    // ── pose ─────────────────────────────────────────────────────────────
    /** The watch frame in ray axes (scale included). */
    this.offset = new THREE.Matrix4();
    this.fit = { back: WATCH.fit.back, out: WATCH.fit.out, tiltDeg: WATCH.fit.tiltDeg, scale: WATCH.fit.scale };
    this.setWatchFit(fit || {});
    this._g2r = new THREE.Matrix4().fromArray(GRIP_IN_RAY.left).invert();
    this._m = new THREE.Matrix4();
    this._ray = new THREE.Matrix4();
    /** Dial frame in world (unit axes) and origin, refreshed each frame. */
    this.o = new THREE.Vector3();
    this.ax = new THREE.Vector3();
    this.ay = new THREE.Vector3();
    this.az = new THREE.Vector3();
    this.shown = false;
    /** The input hands and the eye of the current frame (references, for haptics and menu placement). */
    /** @type {any} */ this.inL = null;
    /** @type {any} */ this.inR = null;
    /** @type {THREE.Vector3|null} */ this.eyeRef = null;
    this.closeReason = '';

    // ── state ────────────────────────────────────────────────────────────
    this.wake = new WakeGate();
    this.tap = new TapGate();
    this.press = new PressGate();
    this.confirm = new Confirm();
    this.bezel = new BezelTurn();
    this.warns = new WarnPlan();
    this.fitEdit = new FitEdit();
    this.menuOpen = false;
    this.page = PAGE.MAIN;
    /** The trigger and touches belong to the watch this frame (pointing at it, or the menu is open). */
    this.capture = false;
    this.hoverRow = -1;
    this.hoverZone = 0;
    this._hit = { row: -1, index: -1, zone: 0 };
    this._rr = { x0: 0, x1: 0, y0: 0, y1: 0 };
    this._spot = new Float64Array(3);
    this.menuPos = new THREE.Vector3();
    this.flashT = 0;
    this.clock = 0;
    this.lastBuzz = -1e9;
    this.lastAlert = -1e9;
    this._hands = new Float32Array(3);
    this._date = new Date();
    this._tz = this._date.getTimezoneOffset();
    this._tzAt = -1e9;
    this._lastWave = 0;
    this._poseT = 0;
    /** Learned grip→ray relation of the left controller (device check of the 45° IWER value), [x, y, z, w] or null. */
    this.gripRel = new Float64Array(4);
    this.gripRelOk = false;
    this.stats = { wakes: 0, opens: 0, presses: 0, taps: 0, rays: 0, warnPulses: 0, alerts: 0, closes: 0 };
    this.draws = 0;
    this.menuDraws = 0;
    this.lastDraw = -1e9;
    this.lastMenuDraw = -1e9;
    this.dirty = true;
    this.menuDirty = true;
    this._n = new Int32Array(RC.N);
    this._s = new Int32Array(RC.N).fill(-99);
    this._ms = new Int32Array(RC.N).fill(-99);
    this.sample();
    this.encode();
    this.draw();
    this.drawMenuNow();
  }

  // ── integrator API ─────────────────────────────────────────────────────

  /** Everything the warm-up must draw. */
  warmMeshes() { return [this.root, this.menuRoot]; }

  /** Every texture (for the record). */
  textures() { return [this.matcap, this.glassCap, this.faceTex, this.menuBgTex, this.atlas.texture]; }

  /** The strings on the dial / the menu now (tests and reports; allocates). */
  get readTexts() { return this.readBoard.strings(); }
  get menuTexts() { return this.menuBoard.strings(); }

  /** @param {boolean} on show for the warm-up draw (in front of the origin), or hide again */
  setWarm(on) {
    this.root.visible = on;
    this.menuRoot.visible = on;
    for (const h of this.hiRows) h.visible = on;
    this.hiZone.visible = on;
    this.hiVisible = on;
    this.cursor.visible = on;
    if (on) {
      this.root.matrix.makeTranslation(0, 1.5, -0.6);
      this.menuRoot.matrix.makeTranslation(0.2, 1.5, -0.7);
      this.root.matrixWorldNeedsUpdate = true;
      this.menuRoot.matrixWorldNeedsUpdate = true;
    } else this.menuOpen = false;
  }

  /**
   * Values from the integrator. Only the fields present are copied; call it
   * with a reused object (or only when something changes).
   * @param {Partial<WatchStatus>} o
   */
  setStatus(o) {
    if (!o) return;
    const s = this.status;
    if (o.health !== undefined) s.health = +o.health || 0;
    if (o.wave !== undefined) s.wave = o.wave | 0;
    if (o.kills !== undefined) s.kills = o.kills | 0;
    if (o.state !== undefined) s.state = o.state;
    if (o.weapon !== undefined) s.weapon = o.weapon;
    if (o.mag !== undefined) s.mag = o.mag === null ? -1 : o.mag | 0;
    if (o.chambered !== undefined) s.chambered = !!o.chambered;
    if (o.mode !== undefined) s.mode = o.mode;
    if (o.spares !== undefined) s.spares = o.spares === null ? -1 : o.spares | 0;
    if (o.chamberShow !== undefined) s.chamberShow = +o.chamberShow || 0;
    if (o.learn !== undefined) s.learn = o.learn === null ? -1 : +o.learn;
    if (o.rooms !== undefined) s.rooms = o.rooms === null ? -1 : o.rooms | 0;
    if (o.scanning !== undefined) s.scanning = !!o.scanning;
    if (o.difficulty !== undefined) s.difficulty = o.difficulty === 'realistic' ? 'realistic' : 'test';
    if (o.playMode !== undefined) s.playMode = o.playMode === 'spot' ? 'spot' : 'roam';
    if (o.ammoLine !== undefined) s.ammoLine = !!o.ammoLine;
    if (o.rightBusy !== undefined) s.rightBusy = !!o.rightBusy;
    if (o.paused !== undefined) s.paused = !!o.paused;
  }

  /**
   * Saved gun fit for one gun (load time, or after the integrator applied a URL override).
   * @param {string} weapon 'glock'|'akm' @param {number} pitchDeg @param {number} up m @param {number} fwd m
   */
  setFit(weapon, pitchDeg, up, fwd) { this.fitEdit.set(weapon, pitchDeg, up, fwd); this.menuDirty = true; }

  /**
   * Where the watch sits on the wrist (URL / settings). Not per frame.
   * @param {{ back?: number, out?: number, tiltDeg?: number, scale?: number }} f
   */
  setWatchFit(f) {
    const F = this.fit;
    if (f && typeof f.back === 'number' && Number.isFinite(f.back)) F.back = Math.max(0, Math.min(0.2, f.back));
    if (f && typeof f.out === 'number' && Number.isFinite(f.out)) F.out = Math.max(0, Math.min(0.12, f.out));
    if (f && typeof f.tiltDeg === 'number' && Number.isFinite(f.tiltDeg)) F.tiltDeg = Math.max(-60, Math.min(60, f.tiltDeg));
    if (f && typeof f.scale === 'number' && Number.isFinite(f.scale)) F.scale = Math.max(0.7, Math.min(1.6, f.scale));
    watchOffset(F, this.offset.elements);
  }

  /**
   * A diegetic warning: the watch vibrates (left hand) and shows a small icon.
   * @param {string|number} kind 'run' | 'edge' | 'obstacle' | 'stairs' | 'tracking' (or WARN code)
   * @param {number} [level] 0 clears, up to 1 (obstacle: closer = faster ticks)
   */
  warn(kind, level = 1) { return this.warns.set(kind, level); }

  /** Clear every warning. */
  clearWarnings() { this.warns.clear(); }

  /** Open the menu (also from code, e.g. a debug key). */
  openMenu() {
    if (this.menuOpen) return;
    this.menuOpen = true;
    this.page = PAGE.MAIN;
    this.confirm.clear();
    this.press.disarm();
    this.placeMenu();
    this.orientMenu(this.eyeRef);
    this.menuRoot.visible = true;
    this.menuDirty = true;
    this.lastMenuDraw = -1e9;
    this.stats.opens++;
    this.haptic(true, 0.5, 25);
    this.haptic(false, 0.3, 20);
    this.sound(0.9, 1.2);
    this.emit('menu', true);
  }

  /** @param {string} [reason] 'resume' | 'tap' | 'far' | 'restart' | 'exit' | 'code' */
  closeMenu(reason = 'code') {
    if (!this.menuOpen) return;
    if (this.page === PAGE.FIT) this.leaveFit();
    this.menuOpen = false;
    this.menuRoot.visible = false;
    this.hideHighlight();
    this.cursor.visible = false;
    this.hoverRow = -1;
    this.closeReason = reason;
    this.stats.closes++;
    this.tap.disarm();
    this.sound(0.8, 0.85);
    this.emit('menu', false);
  }

  /**
   * Press a menu row by name, as a touch would (tests and the e2e). Opens the menu first.
   * @param {string} name a ROW_NAMES entry ('resume', 'restart', 'fit', 'pitch', …)
   * @param {number} [zone] −1 / +1 for the − / + ends of a value row
   */
  select(name, zone = 0) {
    const row = ROW_NAMES.indexOf(name);
    if (row < 0) return false;
    if (!this.menuOpen) this.openMenu();
    const page = row >= ROW.GUN ? PAGE.FIT : PAGE.MAIN;
    if (page !== this.page) return false;
    this.pressRow(row, zone);
    return true;
  }

  /** For the session record (`rec.play.watch`). */
  report() {
    return {
      fit: { ...this.fit }, ...this.stats, draws: this.draws, menuDraws: this.menuDraws,
      gripRelL: this.gripRelOk ? Array.from(this.gripRel, (v) => Math.round(v * 1e4) / 1e4) : null,
    };
  }

  // ── the frame ───────────────────────────────────────────────────────────

  /**
   * The 'ui' system.
   * @param {number} dt @param {number} t ms (the loop's frame timestamp)
   * @param {XRFrame|null|undefined} _frame
   * @param {{ input?: any, player?: any, camera?: THREE.Camera }} ctx
   */
  update(dt, t, _frame, ctx) {
    this.clock += dt;
    const input = ctx && ctx.input;
    const L = input ? input.left : null, R = input ? input.right : null;
    this.inL = L;
    this.inR = R;
    this.sample();
    this.capture = false;
    const show = this.enabled && !!L && (L.hasGrip || L.hasRay);
    this.shown = show;
    if (show) this.pose(L, dt);
    else { this.root.visible = false; if (this.wake.awake) this.wake.reset(); this._poseT = 0; }
    this.tickTime(dt);
    // the eye
    const p = ctx && ctx.player;
    /** @type {THREE.Vector3|null} */ let eye = null;
    /** @type {THREE.Vector3|null} */ let fwd = null;
    if (p && p.valid !== false && (p.eye || p.head) && p.forward) { eye = p.eye || p.head; fwd = p.forward; }
    else if (ctx && ctx.camera) { eye = ctx.camera.position; fwd = _v.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion); }
    this.eyeRef = eye;
    if (show && eye && fwd) {
      const o = this.o;
      const tx = eye.x - o.x, ty = eye.y - o.y, tz = eye.z - o.z;
      const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const face = d > 1e-4 ? (this.az.x * tx + this.az.y * ty + this.az.z * tz) / d : 0;
      const gaze = d > 1e-4 ? -(fwd.x * tx + fwd.y * ty + fwd.z * tz) / d : 0;
      const w = this.wake.update(dt, face, gaze, d);
      if (w === 1) {
        this.stats.wakes++;
        if (this.clock - this.lastBuzz >= WATCH.wake.buzzGapS) { this.lastBuzz = this.clock; this.haptic(false, 0.08, 10); }
      }
    }
    if (this.menuOpen) this.menuStep(dt, R, eye, show);
    else if (show) this.dialStep(R);
    // warnings: the left hand vibrates
    if (this.warns.update(dt)) {
      this.stats.warnPulses++;
      this.haptic(false, this.warns.amp, this.warns.ms);
      if (this.alertSound && this.warns.level >= 0.9 && this.clock - this.lastAlert >= 4) {
        this.lastAlert = this.clock;
        this.stats.alerts++;
        if (this.audio && typeof this.audio.playUI === 'function') this.audio.playUI('watchAlert', 0.3, 1);
      }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.hiMat.opacity = this.flashT > 0 ? 0.42 : 0.16;
    }
    if (this.status.chamberShow > 0) this.status.chamberShow -= dt;
    // redraws (on change only, ≤ 2/s each, one upload per frame across panels)
    this.encode();
    if (this.dirty && t - this.lastDraw >= WATCH.redrawMs && claimUpload(t)) { this.lastDraw = t; this.draw(); }
    if (this.menuOpen && this.menuDirty && t - this.lastMenuDraw >= WATCH.redrawMs && claimUpload(t)) { this.lastMenuDraw = t; this.drawMenuNow(); }
  }

  /**
   * Dial pose from the left controller: ray rotation (or grip × grip→ray),
   * grip position, times the watch offset.
   * @param {any} L @param {number} dt
   */
  pose(L, dt) {
    const M = this._m;
    if (L.hasRay) M.fromArray(L.ray);
    else M.fromArray(L.grip).multiply(this._g2r);
    if (L.hasGrip) { const e = M.elements, g = L.grip; e[12] = g[12]; e[13] = g[13]; e[14] = g[14]; }
    const W = this.root.matrix;
    W.multiplyMatrices(M, this.offset);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = true;
    const e = W.elements, k = 1 / this.fit.scale;
    this.o.set(e[12], e[13], e[14]);
    this.ax.set(e[0] * k, e[1] * k, e[2] * k);
    this.ay.set(e[4] * k, e[5] * k, e[6] * k);
    this.az.set(e[8] * k, e[9] * k, e[10] * k);
    // once, 2 s into a pose: the live grip→ray relation (IWER says 45° pitch, 7° yaw)
    if (!this.gripRelOk && L.hasRay && L.hasGrip) {
      this._poseT += dt;
      if (this._poseT >= 2) {
        // rel = ray⁻¹ · grip (rotation only)
        this._ray.fromArray(L.ray).setPosition(0, 0, 0).invert();
        this._ray.multiply(this._m.fromArray(L.grip).setPosition(0, 0, 0));
        const q = _q.setFromRotationMatrix(this._ray);
        this.gripRel[0] = q.x; this.gripRel[1] = q.y; this.gripRel[2] = q.z; this.gripRel[3] = q.w;
        this.gripRelOk = true;
      }
    }
  }

  /** Hands from the real local time; the bezel's turn. @param {number} dt */
  tickTime(dt) {
    const now = Date.now();
    if (now - this._tzAt > 60000) { this._tzAt = now; this._date.setTime(now); this._tz = this._date.getTimezoneOffset(); }
    handAngles(now, this._tz, this._hands);
    const clicks = this.bezel.update(dt);
    // the ratchet is heard only while you look at the watch (no sounds from nowhere)
    if (clicks > 0 && this.wake.awake) this.sound(0.3, 1.6);
    const u = this.uRot.value;
    u.set(this.bezel.angle, this._hands[0], this._hands[1], this._hands[2]);
  }

  /** Is the right hand holding something (no taps then, unless paused)? */
  rightBusy() {
    const W = this.weapons;
    if (W) {
      if (typeof W.busyRight === 'boolean') return W.busyRight;
      if (W.held !== undefined) return !!(W.held && (!W.held.carry || W.held.carry.inHand !== false));
    }
    return this.status.rightBusy;
  }

  /** Touch or point at the dial to open the menu. @param {any} R */
  dialStep(R) {
    if (!R || !R.hasRay) { this.tap.update(1, 1, 1, false); return; }
    const can = this.wake.awake && (!this.rightBusy() || this.status.paused);
    const r = R.ray, T = WATCH.tap;
    // fingertip: ray origin a little along the ray
    const tx = r[12] - r[8] * T.tip, ty = r[13] - r[9] * T.tip, tz = r[14] - r[10] * T.tip;
    const dx = tx - this.o.x, dy = ty - this.o.y, dz = tz - this.o.z;
    const lx = dx * this.ax.x + dy * this.ax.y + dz * this.ax.z;
    const ly = dx * this.ay.x + dy * this.ay.y + dz * this.ay.z;
    const lz = dx * this.az.x + dy * this.az.y + dz * this.az.z;
    let open = false;
    if (this.tap.update(lx, ly, lz, can)) { open = true; this.stats.taps++; }
    let near = can && lx * lx + ly * ly < T.r * T.r && lz < 0.06 && lz > T.zMin;
    if (can && !open) {
      // ray: −Z of the right target ray, hitting the dial's front
      const ux = -r[8], uy = -r[9], uz = -r[10];
      const den = ux * this.az.x + uy * this.az.y + uz * this.az.z;
      if (den < -0.15) {
        const s = ((this.o.x - r[12]) * this.az.x + (this.o.y - r[13]) * this.az.y + (this.o.z - r[14]) * this.az.z) / den;
        if (s > 0 && s < WATCH.ray.max) {
          const hx = r[12] + ux * s - this.o.x, hy = r[13] + uy * s - this.o.y, hz = r[14] + uz * s - this.o.z;
          const px = hx * this.ax.x + hy * this.ax.y + hz * this.ax.z, py = hx * this.ay.x + hy * this.ay.y + hz * this.ay.z;
          const rr = WATCH.ray.r * this.fit.scale;
          if (px * px + py * py < rr * rr) {
            near = true;
            if (R.triggerDown) { open = true; this.stats.rays++; }
          }
        }
      }
    }
    this.capture = near || open;
    if (open) this.openMenu();
  }

  /** Place the disc in the watch's direction, raised, at reading distance (world-anchored). */
  placeMenu() {
    const p = this.menuPos, eye = this.eyeRef, o = this.o, a = this._spot;
    if (eye) {
      menuSpot(eye.x, eye.y, eye.z, o.x, o.y, o.z, a);
      p.set(a[0], a[1], a[2]);
    } else p.set(o.x, o.y + 0.15, o.z);
  }

  hideHighlight() {
    if (!this.hiVisible) return;
    for (let i = 0; i < this.hiRows.length; i++) this.hiRows[i].visible = false;
    this.hiZone.visible = false;
    this.hiVisible = false;
  }

  /**
   * Turn the disc to face the eye, level (no roll).
   * @param {THREE.Vector3|null} eye
   */
  orientMenu(eye) {
    const P = this.menuPos;
    if (eye) _z.subVectors(eye, P); else _z.set(0, 0, 1);
    if (_z.lengthSq() < 1e-8) return;
    _z.normalize();
    _x.crossVectors(UP, _z);
    if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
    _x.normalize();
    _y.crossVectors(_z, _x);
    this.menuRoot.matrix.makeBasis(_x, _y, _z).setPosition(P);
    this.menuRoot.matrixWorldNeedsUpdate = true;
  }

  /**
   * The menu is open: face the eye, pointer by tip or ray, presses, stick.
   * @param {number} dt @param {any} R @param {THREE.Vector3|null} eye @param {boolean} show the dial is tracked
   */
  menuStep(dt, R, eye, show) {
    this.capture = true;
    const M = WATCH.menu, P = this.menuPos;
    if (eye && P.distanceTo(eye) > M.farM) { this.closeMenu('far'); return; }
    this.orientMenu(eye);
    if (!R || !R.hasRay) { this.hideHighlight(); this.cursor.visible = false; this.hoverRow = -1; return; }
    const r = R.ray, T = WATCH.tap, e = this.menuRoot.matrix.elements;
    const tx = r[12] - r[8] * T.tip, ty = r[13] - r[9] * T.tip, tz = r[14] - r[10] * T.tip;
    // a face tap on the dial closes the menu (resume)
    if (show) {
      const dx = tx - this.o.x, dy = ty - this.o.y, dz = tz - this.o.z;
      const lx = dx * this.ax.x + dy * this.ax.y + dz * this.ax.z;
      const ly = dx * this.ay.x + dy * this.ay.y + dz * this.ay.z;
      const lz = dx * this.az.x + dy * this.az.y + dz * this.az.z;
      if (this.tap.update(lx, ly, lz, true)) { this.stats.taps++; this.emit('resume', 'tap'); this.closeMenu('tap'); return; }
    }
    // the tip over the disc
    const dx = tx - P.x, dy = ty - P.y, dz = tz - P.z;
    let mx = dx * e[0] + dy * e[1] + dz * e[2];
    let my = dx * e[4] + dy * e[5] + dz * e[6];
    const mz = dx * e[8] + dy * e[9] + dz * e[10];
    const inside = mx * mx + my * my < M.r * M.r;
    const code = this.press.update(inside, mz);
    let pointing = code !== PRESS.NONE;
    let pressed = code === PRESS.PRESS;
    if (!pointing) {
      // the ray onto the disc's plane
      const ux = -r[8], uy = -r[9], uz = -r[10];
      const den = ux * e[8] + uy * e[9] + uz * e[10];
      if (den < -0.1) {
        const s = ((P.x - r[12]) * e[8] + (P.y - r[13]) * e[9] + (P.z - r[14]) * e[10]) / den;
        if (s > 0 && s < M.rayMax) {
          const hx = r[12] + ux * s - P.x, hy = r[13] + uy * s - P.y, hz = r[14] + uz * s - P.z;
          mx = hx * e[0] + hy * e[1] + hz * e[2];
          my = hx * e[4] + hy * e[5] + hz * e[6];
          if (mx * mx + my * my < M.r * M.r) { pointing = true; pressed = !!R.triggerDown; }
        }
      }
    }
    if (pointing) {
      const S = MENU_PX.size / (2 * M.r);
      const px = MENU_PX.c + mx * S, py = MENU_PX.c - my * S;
      const row = hitMenu(this.page, px, py, this._hit);
      this.cursor.visible = true;
      this.cursor.position.set(mx, my, 0.0016);
      if (row !== this.hoverRow || this._hit.zone !== this.hoverZone) {
        if (row >= 0 && row !== this.hoverRow) this.haptic(true, 0.06, 6);
        this.hoverRow = row;
        this.hoverZone = this._hit.zone;
        this.placeHighlight(this._hit.index, this._hit.zone, S);
      }
      if (pressed && row >= 0) this.pressRow(row, this._hit.zone);
    } else {
      this.cursor.visible = false;
      if (this.hoverRow !== -1) { this.hoverRow = -1; this.hideHighlight(); }
    }
    // the right stick edits the selected fit line
    if (this.page === PAGE.FIT) {
      const c = this.fitEdit.stick(dt, R.sy || 0);
      if (c) {
        this.menuDirty = true;
        if (c === 2) this.haptic(true, 0.08, 10);
        this.emit('fit', this.fitEdit.values());
      }
    }
  }

  /**
   * @param {number} index row index on the page (−1 hides) @param {number} zone @param {number} S px per metre
   */
  placeHighlight(index, zone, S) {
    this.hideHighlight();
    if (index < 0) return;
    const rows = PAGE_ROWS[this.page];
    if (isValueRow(rows[index]) && zone !== 0) {
      const r = rowRect(index, this._rr), h = r.y1 - r.y0;
      const x = (zone < 0 ? r.x0 + h / 2 : r.x1 - h / 2) - MENU_PX.c, y = MENU_PX.c - (r.y0 + r.y1) / 2;
      this.hiZone.position.set(x / S, y / S, 0.0008);
      this.hiZone.visible = true;
    } else this.hiRows[index].visible = true;
    this.hiVisible = true;
  }

  /**
   * @param {number} row ROW @param {number} zone
   */
  pressRow(row, zone) {
    this.stats.presses++;
    this.flashT = WATCH.menu.flashS;
    this.hiMat.opacity = 0.42;
    this.haptic(true, 0.45, 18);
    this.sound(0.7, 1);
    this.menuDirty = true;
    if (needsConfirm(row) && !this.confirm.tap(row, this.clock)) return;
    if (!needsConfirm(row)) this.confirm.clear();
    const S = this.status, F = this.fitEdit;
    switch (row) {
      case ROW.RESUME: this.emit('resume', 'menu'); this.closeMenu('resume'); break;
      case ROW.RESTART: this.emit('restart'); this.closeMenu('restart'); break;
      case ROW.EXIT: this.emit('exit', 'watch'); this.closeMenu('exit'); break;
      case ROW.DIFFICULTY:
        S.difficulty = S.difficulty === 'realistic' ? 'test' : 'realistic';
        this.emit('difficulty', S.difficulty);
        break;
      case ROW.MODE:
        S.playMode = S.playMode === 'spot' ? 'roam' : 'spot';
        this.emit('mode', S.playMode);
        break;
      case ROW.AMMO:
        S.ammoLine = !S.ammoLine;
        this.emit('ammoLine', S.ammoLine);
        break;
      case ROW.FIT: {
        this.page = PAGE.FIT;
        const w = weaponIndex(S.weapon || '');
        F.select(w >= 0 ? w : 0);
        F.field = FIT_FIELD.PITCH;
        this.hoverRow = -1;
        this.hideHighlight();
        this.emit('fitBegin', FIT_WEAPONS[F.weapon]);
        break;
      }
      case ROW.GUN:
        F.select(F.weapon === 0 ? 1 : 0);
        this.emit('fitBegin', FIT_WEAPONS[F.weapon]);
        break;
      case ROW.PITCH: case ROW.HEIGHT: case ROW.FORWARD: {
        const field = row - ROW.PITCH;
        F.field = field;
        if (zone !== 0 && F.nudge(field, zone)) this.emit('fit', F.values());
        break;
      }
      case ROW.RESET:
        F.reset();
        this.emit('fit', F.values());
        break;
      case ROW.SAVE: {
        const m = F.save();
        for (let w = 0; w < 2; w++) if (m & (1 << w)) this.emit('fitSave', F.values(w));
        if (!m) this.emit('fitSave', F.values());
        this.emit('fitEnd', F.values());
        this.page = PAGE.MAIN;
        this.hoverRow = -1;
        this.hideHighlight();
        break;
      }
      case ROW.BACK:
        this.leaveFit();
        this.page = PAGE.MAIN;
        this.hoverRow = -1;
        this.hideHighlight();
        break;
      default: break;
    }
  }

  /** Leaving the fit page without SAVE: unsaved edits go back. */
  leaveFit() {
    const F = this.fitEdit;
    const m = F.revert();
    for (let w = 0; w < 2; w++) if (m & (1 << w)) this.emit('fit', F.values(w));
    this.emit('fitEnd', F.values());
    this.page = PAGE.MAIN;
  }

  // ── data → codes → canvas ───────────────────────────────────────────────

  /** Pull values from the game and weapon sources (when given). */
  sample() {
    const s = this.status, g = this.game, W = this.weapons;
    if (g) {
      if (typeof g.health === 'number') s.health = g.health;
      if (typeof g.wave === 'number') s.wave = g.wave;
      if (typeof g.kills === 'number') s.kills = g.kills;
      s.paused = !!g.paused;
      s.state = g.paused ? 'paused' : typeof g.phaseName === 'string' ? g.phaseName : s.state;
    }
    if (W && typeof W.ammo === 'function') {
      const a = W.ammo();
      if (a) {
        s.weapon = a.weapon || null;
        s.mag = typeof a.mag === 'number' && a.mag >= 0 ? a.mag | 0 : -1;
        s.chambered = !!a.chambered;
        s.mode = a.mode !== undefined ? a.mode : (W.held || W.lastHeld) && (W.held || W.lastHeld).inst ? (W.held || W.lastHeld).inst.mode : null;
        if (typeof a.spares === 'number') s.spares = a.spares;
        if (typeof a.chamberShow === 'number' && a.chamberShow > s.chamberShow) s.chamberShow = a.chamberShow;
      }
    }
  }

  /** Encode the status into integer codes; mark dirty on change. */
  encode() {
    const s = this.status, n = this._n;
    const wc = s.weapon === 'glock' ? 1 : s.weapon === 'akm' ? 2 : 0;
    n[RC.HEALTH] = Math.max(0, Math.min(999, Math.ceil(s.health))) | 0;
    n[RC.AMMO_ON] = s.ammoLine && wc ? 1 : 0;
    n[RC.WEAPON] = wc;
    n[RC.MAG] = s.mag;
    n[RC.CHAMBER] = s.chambered || s.chamberShow > 0 ? 1 : 0;
    n[RC.MODE] = wc ? modeCode(s.mode) : 0;
    n[RC.WAVE] = s.wave;
    n[RC.KILLS] = s.kills;
    const st = stateCode(s.state);
    n[RC.STATE] = st;
    const warn = this.warns.pick();
    n[RC.WARN] = warn;
    n[RC.SEVERE] = warn >= 0 && (this.warns.levels[warn] >= 0.75 || warn === WARN.TRACKING) ? 1 : 0;
    n[RC.LEARN] = s.learn >= 0 ? Math.round(Math.min(1, s.learn) * 100) : -1;
    n[RC.ROOMS] = s.rooms;
    n[RC.SCANNING] = s.scanning ? 1 : 0;
    n[RC.SPARES] = s.spares;
    const hint = this.wake.awake && !this.menuOpen && (!this.rightBusy() || s.paused);
    n[RC.INFO] = infoCode(warn, st, s.scanning, hint);
    n[RC.PAGE] = this.page;
    n[RC.DIFF] = s.difficulty === 'realistic' ? 1 : 0;
    n[RC.PLAYMODE] = s.playMode === 'spot' ? 1 : 0;
    n[RC.AMMOLINE] = s.ammoLine ? 1 : 0;
    n[RC.CONFIRM] = this.confirm.pending(this.confirm.key, this.clock) ? this.confirm.key : -1;
    const F = this.fitEdit, c = F.cur[F.weapon];
    n[RC.FIT_W] = F.weapon;
    n[RC.FIT_F] = F.field;
    n[RC.FIT_P] = Math.round(c[0] * 2);
    n[RC.FIT_U] = Math.round(c[1] * 1000);
    n[RC.FIT_FWD] = Math.round(c[2] * 1000);
    // a new wave: the bezel clicks round so its pip meets the minute hand
    if (s.wave !== this._lastWave) {
      if (s.wave > this._lastWave && s.wave > 0) this.bezel.alignTo(-this._hands[1] / (2 * Math.PI));
      this._lastWave = s.wave;
    }
    const d = this._s;
    for (let i = 0; i < RC.N_DIAL; i++) if (d[i] !== n[i]) { this.dirty = true; break; }
    if (this.menuOpen) {
      const m = this._ms;
      for (let i = 0; i < RC.N; i++) if (m[i] !== n[i]) { this.menuDirty = true; break; }
    }
  }

  /** Lay the readouts out again (glyph board: a buffer range, no texture upload). */
  draw() {
    const n = this._n, s = this._s;
    for (let i = 0; i < RC.N; i++) s[i] = n[i];
    layoutReadouts(this.readBoard, this.art, n);
    this.draws++;
    this.dirty = false;
  }

  /** Lay the menu's rows and strip out again (glyph board). */
  drawMenuNow() {
    const n = this._n, m = this._ms;
    for (let i = 0; i < RC.N; i++) m[i] = n[i];
    const F = this.fitEdit, c = F.cur[F.weapon];
    layoutMenu(this.menuBoard, this.art, n, c[0], c[1], c[2]);
    this.menuDraws++;
    this.menuDirty = false;
  }

  // ── feedback ────────────────────────────────────────────────────────────

  /** @param {string} name @param {any} [value] */
  emit(name, value) {
    try { this.onAction(name, value); } catch (e) { if (typeof console !== 'undefined') console.error('[watch] onAction', name, e); }
  }

  /**
   * @param {boolean} right @param {number} v 0..1 @param {number} ms
   */
  haptic(right, v, ms) {
    const h = right ? this.inR : this.inL;
    const s = h && h.source;
    const g = s && s.gamepad;
    const a = g && g.hapticActuators && g.hapticActuators[0];
    if (a && typeof a.pulse === 'function') { try { a.pulse(v, ms); } catch { /* ignore */ } }
  }

  /** @param {number} gain @param {number} rate */
  sound(gain, rate) {
    const A = this.audio;
    if (A && typeof A.playUI === 'function') A.playUI('watchTick', gain, rate);
  }
}

/**
 * Add the watch's synthesised sounds to the AudioEngine's banks ('watchTick',
 * 'watchAlert'). Call once after `audio.decodeAll()` (the context exists),
 * before Enter; nothing is decoded or created in play.
 * @param {any} audio AudioEngine
 * @returns {boolean} installed
 */
export function installWatchSounds(audio) {
  const ac = audio && audio.ctx;
  if (!ac || !audio.buffers || typeof ac.createBuffer !== 'function') return false;
  /** @param {Float32Array} d */
  const mk = (d) => { const b = ac.createBuffer(1, d.length, ac.sampleRate); b.getChannelData(0).set(d); return b; };
  audio.buffers.watchTick = [mk(synthTick(ac.sampleRate))];
  audio.buffers.watchAlert = [mk(synthAlert(ac.sampleRate))];
  return true;
}

/**
 * A row's pill (rounded ends) in disc-local metres, from its canvas rectangle.
 * @param {{ x0: number, x1: number, y0: number, y1: number }} r
 */
function pillGeometry(r) {
  const s = (2 * WATCH.menu.r) / MENU_PX.size, c = MENU_PX.c;
  const x0 = (r.x0 - c) * s, x1 = (r.x1 - c) * s, y0 = (c - r.y1) * s, y1 = (c - r.y0) * s, rad = (y1 - y0) / 2;
  const sh = new THREE.Shape();
  sh.moveTo(x0 + rad, y0);
  sh.lineTo(x1 - rad, y0);
  sh.absarc(x1 - rad, y0 + rad, rad, -Math.PI / 2, Math.PI / 2, false);
  sh.lineTo(x0 + rad, y1);
  sh.absarc(x0 + rad, y0 + rad, rad, Math.PI / 2, Math.PI * 1.5, false);
  const g = new THREE.ShapeGeometry(sh, 12);
  g.computeBoundingSphere();
  return g;
}

/**
 * @param {THREE.BufferGeometry} g @param {THREE.Material} m @param {string} name @param {number} order
 */
function mesh(g, m, name, order) {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  o.renderOrder = order;
  return o;
}

/**
 * @param {number} w @param {number} h
 * @param {((c: CanvasRenderingContext2D) => void)|null} draw
 * @param {boolean} mips static texture with mipmaps (drawn once) or a dynamic one without
 */
function canvasTexture(w, h, draw, mips) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  if (draw) draw(/** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')));
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (mips) t.anisotropy = 4;
  return t;
}

export { WARN, PAGE, ROW, ROW_NAMES, STATE, INFO };
