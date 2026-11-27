// @ts-check
import * as THREE from 'three';
import { CanvasPanel } from './CanvasPanel.js';
import { claimUpload } from '../game/UploadGate.js';
import { PHASE } from '../game/Rules.js';

/**
 * A small watch-like panel on the back of the left wrist (CONTRACTS.md
 * "WristHud"), placed from `ctx.input.left.grip` every frame.
 *
 * Shows wave, health, kills and an ammo line (toggle, on by default for the
 * test). Look at the wrist to use it: X taps toggle the ammo line, holding X
 * for 1 s exits (the wrist menu exit). Redraws only when a value changes, at
 * most twice a second, and only through the shared one-upload-per-frame gate.
 * Drawing uses cached strings only (no per-frame allocation).
 *
 * WebXR grip space: −Z runs along the fist toward the thumb, +X out of the
 * back of the RIGHT hand, so the back of the LEFT hand faces −X, and +Y runs
 * toward the elbow. A watch face there reads with its right edge toward the
 * fingers (−Y) and its top along +Z. The offset is a first estimate for Quest
 * Touch controllers, not yet checked on the headset.
 *
 *   const hud = new WristHud(ctx, { game, weapons });   // at load; hud.warmMeshes() for the warm-up
 *   // `ui` system: hud.update(dt, t, frame, ctx)
 */

export const WRIST = Object.freeze({
  width: 320,
  height: 200,
  worldWidth: 0.1,
  /** Panel centre in grip space: toward the elbow, out of the back of the left hand. */
  offset: Object.freeze([-0.045, 0.085, 0.0]),
  redrawMs: 500,
  /** Looking at it: panel faces the eyes within 45°, the gaze is within 30° of it, ≤ 0.65 m away. */
  faceCos: Math.cos((45 * Math.PI) / 180),
  gazeCos: Math.cos((30 * Math.PI) / 180),
  lookMaxM: 0.65,
  tapS: 0.4,
  exitHoldS: 1.0,
});

/** Cached number strings (no allocation while drawing). */
const NUM = /** @type {string[]} */ ([]);
for (let i = 0; i < 1000; i++) NUM.push(String(i));
/** @param {number} n */
const num = (n) => NUM[n < 0 ? 0 : n > 999 ? 999 : n | 0];

const FONT_BIG = '600 44px system-ui, sans-serif';
const FONT_MID = '500 32px system-ui, sans-serif';
const FONT_SMALL = '500 22px system-ui, sans-serif';
const C_BG = '#0b1016';
const C_EDGE = '#2a3a4a';
const C_TEXT = '#e8f0f6';
const C_DIM = '#8fa3b6';
const C_WARN = '#ffc061';
const C_BAD = '#ff5a4f';
const C_OK = '#7ee29b';

export class WristHud {
  /**
   * @param {{ scene: THREE.Scene }} ctx
   * @param {{ game?: { wave: number, health: number, kills: number, paused: boolean, phase: number, requestExit?: (r: string) => void } | null,
   *   weapons?: { ammo?: () => { weapon: string|null, mag: number|null, chambered: boolean|number } } | null, showAmmo?: boolean }} [o]
   */
  constructor(ctx, { game = null, weapons = null, showAmmo = true } = {}) {
    this.game = game;
    this.weapons = weapons;
    this.showAmmo = showAmmo;
    this.panel = new CanvasPanel({ width: WRIST.width, height: WRIST.height, worldWidth: WRIST.worldWidth });
    const m = this.panel.mesh;
    m.name = 'wrist-hud';
    m.matrixAutoUpdate = false;
    m.visible = false;
    if (ctx && ctx.scene) ctx.scene.add(m);
    // panel basis in grip space: right = −Y, up = +Z, normal = −X
    this.offset = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0),
    ).setPosition(WRIST.offset[0], WRIST.offset[1], WRIST.offset[2]);
    this._grip = new THREE.Matrix4();
    this.looking = false;
    this._xT = -1;
    this.lastDraw = -1e9;
    this.draws = 0;
    // last drawn state, and the state now
    this._s = new Int32Array(10).fill(-9);
    this._n = new Int32Array(10);
    this.dirty = true;
    this.draw(); // initial content, so the warm-up uploads a real texture
  }

  warmMeshes() { return [this.panel.mesh]; }

  /** @param {boolean} on */
  setWarm(on) {
    const m = this.panel.mesh;
    m.visible = on;
    if (on) { m.matrix.identity(); m.matrix.setPosition(0, 1.5, -0.6); m.matrixWorldNeedsUpdate = true; }
  }

  /**
   * @param {number} dt @param {number} t
   * @param {XRFrame|null|undefined} _frame
   * @param {{ input?: import('../xr/Input.js').Input, player?: any }} ctx
   */
  update(dt, t, _frame, ctx) {
    const mesh = this.panel.mesh;
    const L = ctx.input ? ctx.input.left : null;
    const g = this.game;
    if (!L || !L.hasGrip || (g && g.phase === PHASE.IDLE)) {
      mesh.visible = false;
      this.looking = false;
      this._xT = -1;
      return;
    }
    const M = mesh.matrix;
    M.multiplyMatrices(this._grip.fromArray(L.grip), this.offset);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;

    this.looking = this.lookTest(M, ctx.player);
    this.buttons(dt, L);
    this.sample();
    if (this.dirty && t - this.lastDraw >= WRIST.redrawMs && claimUpload(t)) {
      this.lastDraw = t;
      this.draw();
    }
  }

  /**
   * @param {THREE.Matrix4} M panel world matrix
   * @param {any} p player (eye, forward)
   */
  lookTest(M, p) {
    if (!p || p.valid === false || !p.forward) return false;
    const e = M.elements;
    const eye = p.eye || p.head;
    const tx = eye.x - e[12], ty = eye.y - e[13], tz = eye.z - e[14];
    const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (!(d > 1e-3) || d > WRIST.lookMaxM) return false;
    // panel normal = its +Z column
    const face = (e[8] * tx + e[9] * ty + e[10] * tz) / d;
    const f = p.forward;
    const gaze = -(f.x * tx + f.y * ty + f.z * tz) / d;
    return face > WRIST.faceCos && gaze > WRIST.gazeCos;
  }

  /** X while looking: tap = ammo line on/off, hold 1 s = exit. @param {import('../xr/Input.js').HandState} L @param {number} dt */
  buttons(dt, L) {
    if (L.aDown && this.looking) this._xT = 0;
    if (this._xT < 0) return;
    if (!this.looking) { this._xT = -1; return; }
    if (L.a) {
      this._xT += dt;
      if (this._xT >= WRIST.exitHoldS) {
        this._xT = -1;
        const g = this.game;
        if (g && typeof g.requestExit === 'function') g.requestExit('wrist');
      }
    } else {
      if (this._xT < WRIST.tapS) this.showAmmo = !this.showAmmo;
      this._xT = -1;
    }
  }

  /** Read the values; mark dirty when any differs from what is drawn. */
  sample() {
    const n = this._n, g = this.game;
    n[0] = g ? g.wave | 0 : 0;
    n[1] = g ? Math.ceil(g.health) | 0 : 100;
    n[2] = g ? g.kills | 0 : 0;
    n[3] = g ? (g.phase === PHASE.OVER ? 2 : g.paused ? 1 : g.phase === PHASE.BREAK ? 3 : 0) : 0;
    let wc = 0, mag = -1, ch = 0;
    const W = this.weapons;
    if (this.showAmmo && W && typeof W.ammo === 'function') {
      const a = W.ammo();
      if (a) {
        wc = a.weapon === 'glock' ? 1 : a.weapon === 'akm' ? 2 : 0;
        mag = typeof a.mag === 'number' && a.mag >= 0 ? a.mag | 0 : -1;
        ch = a.chambered ? 1 : 0;
      }
    }
    n[4] = this.showAmmo ? 1 : 0;
    n[5] = wc;
    n[6] = mag;
    n[7] = ch;
    n[8] = this.looking ? 1 : 0;
    n[9] = this._xT >= WRIST.tapS ? 1 : 0;
    const s = this._s;
    for (let i = 0; i < 10; i++) if (s[i] !== n[i]) { this.dirty = true; break; }
  }

  /** Draw the current values and queue one upload. */
  draw() {
    const n = this._n, s = this._s;
    for (let i = 0; i < 10; i++) s[i] = n[i];
    const P = this.panel, c = P.ctx, W = P.canvas.width, H = P.canvas.height;
    c.fillStyle = C_BG;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = C_EDGE;
    c.lineWidth = 4;
    c.strokeRect(2, 2, W - 4, H - 4);
    c.textBaseline = 'alphabetic';
    // row 1: wave, health
    c.textAlign = 'left';
    c.font = FONT_SMALL;
    c.fillStyle = C_DIM;
    c.fillText('WAVE', 18, 30);
    c.textAlign = 'right';
    c.fillText('HEALTH', W - 18, 30);
    c.font = FONT_BIG;
    c.textAlign = 'left';
    c.fillStyle = C_TEXT;
    c.fillText(num(n[0]), 18, 74);
    const h = n[1];
    c.textAlign = 'right';
    c.fillStyle = h >= 60 ? C_TEXT : h >= 30 ? C_WARN : C_BAD;
    c.fillText(num(h), W - 18, 74);
    // row 2: kills, state
    c.font = FONT_MID;
    c.textAlign = 'left';
    c.fillStyle = C_DIM;
    c.fillText('KILLS', 18, 116);
    c.fillStyle = C_TEXT;
    c.fillText(num(n[2]), 118, 116);
    c.textAlign = 'right';
    c.font = FONT_SMALL;
    const st = n[3];
    if (st !== 0) {
      c.fillStyle = st === 2 ? C_BAD : st === 1 ? C_WARN : C_OK;
      c.fillText(st === 2 ? 'DOWN' : st === 1 ? 'PAUSED' : 'BREAK', W - 18, 114);
    }
    // row 3: ammo
    c.font = FONT_MID;
    if (n[4]) {
      c.textAlign = 'left';
      c.fillStyle = C_DIM;
      c.fillText(n[5] === 1 ? 'G17' : n[5] === 2 ? 'AKM' : '—', 18, 156);
      if (n[5] !== 0) {
        c.textAlign = 'right';
        c.fillStyle = n[6] < 0 ? C_WARN : C_TEXT;
        c.fillText(n[6] < 0 ? '--' : num(n[6]), W - 64, 156);
        c.textAlign = 'left';
        c.fillStyle = n[7] ? C_TEXT : C_DIM;
        c.fillText(n[7] ? '+1' : '+0', W - 62, 156);
      }
    }
    // row 4: wrist menu hint while looking
    if (n[8]) {
      c.font = FONT_SMALL;
      c.textAlign = 'left';
      c.fillStyle = n[9] ? C_BAD : C_DIM;
      c.fillText(n[9] ? 'Keep holding X to exit' : 'X: ammo line · hold X: exit', 18, 188);
    }
    P.texture.needsUpdate = true;
    P.uploads++;
    this.draws++;
    this.dirty = false;
  }
}
