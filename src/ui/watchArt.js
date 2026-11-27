// @ts-check
/**
 * Canvas artwork for the wrist watch (src/ui/Watch.js). No three.js and no
 * DOM: every function draws on a CanvasRenderingContext2D it is handed, so
 * the drawing code also runs against a fake context in Node tests.
 *
 * Styling: a luxury steel dive watch with no brand names or logos (the maker
 * mark is the game's own name). Black lacquer dial, applied lume indices with
 * steel surrounds, white "date wheel" windows, a black ceramic dive bezel with
 * platinum-coloured graduations.
 *
 * Textures:
 * - steel / glass matcaps (256², drawn once);
 * - the FACE atlas (1024×512, drawn once, mipmapped): dial on the left half,
 *   bezel insert on the right half, flat colour patches for the hands in the
 *   dial square's corners (outside the dial circle);
 * - v0.5: the READOUTS (256×128 virtual px at 10 px/mm) and the MENU disc
 *   (512² virtual px = 0.16 m) are no longer canvases redrawn in play: their
 *   glyphs and pieces (paper windows, icons, pill caps) are drawn once at load
 *   into the shared glyph atlas (`registerWatchArt`), and `layoutReadouts` /
 *   `layoutMenu` place them on a GlyphBoard (src/ui/Glyphs.js): no texture
 *   upload during play. The menu disc's background (gradient, minute track)
 *   is a static canvas drawn once (`drawMenuBackground`).
 *
 * Nothing is formatted while laying out: numbers come from cached strings
 * (watchLogic numStr/degStr/mmStr) and labels are constants.
 */
import { numStr, degStr, mmStr, MENU_PX, PAGE, PAGE_ROWS, ROW, isValueRow, rowRect, INFO, WARN, WARN_WORDS } from './watchLogic.js';
import { ALIGN, DIGITS, TEXT_CHARS, hex } from './Glyphs.js';

export const SERIF = '"Noto Serif", "DejaVu Serif", Georgia, "Times New Roman", serif';
export const SANS = 'Roboto, Inter, "Helvetica Neue", Arial, sans-serif';

// ── shared layout ────────────────────────────────────────────────────────────

/** The face atlas: dial square (left), bezel square (right). */
export const FACE = Object.freeze({ w: 1024, h: 512, dial: 512, dialMm: 30, bezelOuter: 0.0201, bezelInner: 0.0157 });

/** Hand colour patches in the face atlas (px rectangles, outside the dial circle). */
export const PATCH = Object.freeze({
  lume: Object.freeze({ x: 8, y: 8, w: 40, h: 40, color: '#f3f1e8' }),
  steel: Object.freeze({ x: 464, y: 8, w: 40, h: 40, color: '#d4d8dd' }),
  dark: Object.freeze({ x: 8, y: 464, w: 40, h: 40, color: '#2a2e33' }),
  red: Object.freeze({ x: 464, y: 464, w: 40, h: 40, color: '#c8322a' }),
});

/**
 * UV centre of a patch (flipY textures: v = 1 − y/H).
 * @param {{ x: number, y: number, w: number, h: number }} p
 * @param {number[]} out
 */
export function patchUV(p, out) {
  out[0] = (p.x + p.w / 2) / FACE.w;
  out[1] = 1 - (p.y + p.h / 2) / FACE.h;
  return out;
}

/**
 * The readout atlas: regions (px) and where each sits on the dial (mm from the
 * centre, +y = 12 o'clock). 10 px per mm.
 */
export const READ = Object.freeze({
  w: 256, h: 128, px: 10,
  health: Object.freeze({ x: 0, y: 0, w: 90, h: 46, cx: 0, cy: 7.1 }),
  ammo: Object.freeze({ x: 92, y: 0, w: 66, h: 52, cx: 8.2, cy: 0 }),
  wave: Object.freeze({ x: 160, y: 0, w: 54, h: 42, cx: -8.2, cy: 0 }),
  mode: Object.freeze({ x: 0, y: 56, w: 150, h: 40, cx: 0, cy: -5.0 }),
  info: Object.freeze({ x: 0, y: 98, w: 200, h: 30, cx: 0, cy: -9.0 }),
});
export const READ_REGIONS = Object.freeze(['health', 'ammo', 'wave', 'mode', 'info']);

// ── colours and fonts ────────────────────────────────────────────────────────

const PAPER = '#f4f3ee';
const INK = '#111214';
const AMBER = '#b36b00';
const RED = '#c0281e';
const LUME = '#eceae0';
const SURROUND = '#c6cacf';
const GRAD = '#e9e5d8';
const F_HEALTH = `700 38px ${SERIF}`;
const F_AMMO = `700 44px ${SERIF}`;
const F_WAVE = `700 32px ${SERIF}`;
const F_MODE = `700 30px ${SANS}`;
const F_GUN = `600 25px ${SANS}`;
const F_INFO = `700 21px ${SANS}`;
const F_MARK = `600 31px ${SERIF}`;
const F_SUB = `500 12px ${SANS}`;
const F_BEZEL = `700 40px ${SERIF}`;
const F_ROW = `600 23px ${SANS}`;
const F_VAL = `600 21px ${SANS}`;
const F_STRIP1 = `600 24px ${SANS}`;
const F_STRIP2 = `500 18px ${SANS}`;
const F_STRIP3 = `500 15px ${SANS}`;
const F_SIGN = `700 30px ${SANS}`;

/** @typedef {CanvasRenderingContext2D} C2D */

// ── matcaps ──────────────────────────────────────────────────────────────────

/**
 * Steel as seen in a softly lit room: bright window light upper left, a dark
 * horizon band, floor bounce below, a faint bright rim (grazing angles).
 * @param {C2D} c @param {number} S size
 */
export function drawSteelMatcap(c, S) {
  c.fillStyle = '#5c6168';
  c.fillRect(0, 0, S, S);
  let g = c.createRadialGradient(S * 0.36, S * 0.3, S * 0.02, S * 0.45, S * 0.45, S * 0.62);
  g.addColorStop(0, '#f7f8fa');
  g.addColorStop(0.16, '#dde1e5');
  g.addColorStop(0.42, '#a3a9b0');
  g.addColorStop(0.7, '#6d737a');
  g.addColorStop(1, '#3b3f45');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  // horizon: a darker band a little below the middle
  g = c.createLinearGradient(0, S * 0.5, 0, S * 0.68);
  g.addColorStop(0, 'rgba(25,28,32,0)');
  g.addColorStop(0.45, 'rgba(25,28,32,0.42)');
  g.addColorStop(1, 'rgba(25,28,32,0)');
  c.fillStyle = g;
  c.fillRect(0, S * 0.5, S, S * 0.18);
  // floor bounce
  g = c.createRadialGradient(S * 0.55, S * 0.98, 0, S * 0.55, S * 0.98, S * 0.4);
  g.addColorStop(0, 'rgba(160,150,138,0.55)');
  g.addColorStop(1, 'rgba(160,150,138,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  // second, cooler window on the right
  g = c.createRadialGradient(S * 0.8, S * 0.36, 0, S * 0.8, S * 0.36, S * 0.16);
  g.addColorStop(0, 'rgba(225,235,245,0.55)');
  g.addColorStop(1, 'rgba(225,235,245,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  // grazing rim
  g = c.createRadialGradient(S / 2, S / 2, S * 0.4, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0.22)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  // specular
  g = c.createRadialGradient(S * 0.32, S * 0.26, 0, S * 0.32, S * 0.26, S * 0.07);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
}

/**
 * Glass reflections only (drawn additively): black where nothing reflects, a
 * soft window streak, a thin rim and a small specular.
 * @param {C2D} c @param {number} S
 */
export function drawGlassMatcap(c, S) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, S, S);
  c.save();
  c.translate(S * 0.36, S * 0.3);
  c.rotate(-0.6);
  c.scale(1, 0.32);
  let g = c.createRadialGradient(0, 0, 0, 0, 0, S * 0.24);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(-S * 0.3, -S * 0.3, S * 0.6, S * 0.6);
  c.restore();
  g = c.createRadialGradient(S / 2, S / 2, S * 0.42, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(200,220,255,0.5)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  g = c.createRadialGradient(S * 0.3, S * 0.24, 0, S * 0.3, S * 0.24, S * 0.035);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
}

// ── the face atlas (static) ──────────────────────────────────────────────────

/**
 * Dial (left 512²), bezel insert (right 512²) and the hand patches.
 * @param {C2D} c a 1024×512 context
 */
export function drawFaceAtlas(c) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, FACE.w, FACE.h);
  drawDial(c);
  drawBezel(c, 512);
  for (const k of /** @type {const} */ (['lume', 'steel', 'dark', 'red'])) {
    const p = PATCH[k];
    c.fillStyle = p.color;
    c.fillRect(p.x - 6, p.y - 6, p.w + 12, p.h + 12);
  }
}

/** px per mm on the dial square */
const DS = FACE.dial / FACE.dialMm;

/** @param {C2D} c */
function drawDial(c) {
  const cx = 256, cy = 256;
  // black lacquer
  let g = c.createRadialGradient(cx, cy - 34, 8, cx, cy, 256);
  g.addColorStop(0, '#202328');
  g.addColorStop(0.55, '#0f1113');
  g.addColorStop(1, '#060708');
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, 256, 0, Math.PI * 2);
  c.fill();
  // minute track
  c.strokeStyle = '#d3d6d9';
  c.lineCap = 'butt';
  for (let m = 0; m < 60; m++) {
    const a = (m / 60) * Math.PI * 2, s = Math.sin(a), co = Math.cos(a);
    const five = m % 5 === 0;
    const r0 = five ? 232 : 239, r1 = 249;
    c.lineWidth = five ? 3.4 : 2;
    c.beginPath();
    c.moveTo(cx + s * r0, cy - co * r0);
    c.lineTo(cx + s * r1, cy - co * r1);
    c.stroke();
  }
  // window frames (polished steel), drawn before the indices
  frame(c, READ.health);
  frame(c, READ.ammo);
  frame(c, READ.wave);
  // applied indices: lume in a steel surround with a small shadow
  for (let h = 1; h < 12; h++) {
    if (h === 3 || h === 6 || h === 9) continue;
    const a = (h / 12) * Math.PI * 2;
    const x = cx + Math.sin(a) * 212, y = cy - Math.cos(a) * 212;
    applied(c, () => { c.beginPath(); c.arc(x, y, 15, 0, Math.PI * 2); });
  }
  // batons at 6 and 9
  baton(c, cx, cy, Math.PI, 190, 236, 21);
  baton(c, cx, cy, Math.PI * 1.5, 200, 236, 19);
  // inverted triangle at 12
  applied(c, () => {
    c.beginPath();
    c.moveTo(cx - 19, cy - 238);
    c.lineTo(cx + 19, cy - 238);
    c.lineTo(cx, cy - 200);
    c.closePath();
  });
  // maker mark (the game's own; no watch brand)
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.fillStyle = '#f1efe8';
  c.font = F_MARK;
  spaced(c, 4);
  c.fillText('CQC', cx, cy - 2.75 * DS);
  c.font = F_SUB;
  spaced(c, 2);
  c.fillStyle = '#cfcabd';
  c.fillText('PASS-THROUGH', cx, cy - 1.75 * DS);
  spaced(c, 0);
}

/** @param {C2D} c @param {number} px letter spacing */
function spaced(c, px) {
  const a = /** @type {any} */ (c);
  if ('letterSpacing' in a) a.letterSpacing = px ? `${px}px` : '0px';
}

/**
 * Polished steel frame round a readout window (the readout quad covers the inside).
 * @param {C2D} c @param {{ w: number, h: number, cx: number, cy: number }} R
 */
function frame(c, R) {
  const w = (R.w / READ.px) * DS, h = (R.h / READ.px) * DS;
  const x = 256 + R.cx * DS - w / 2, y = 256 - R.cy * DS - h / 2;
  const f = 0.42 * DS;
  const g = c.createLinearGradient(x, y - f, x, y + h + f);
  g.addColorStop(0, '#f2f4f6');
  g.addColorStop(0.5, '#9aa0a7');
  g.addColorStop(1, '#e1e4e7');
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fillRect(x - f + 2, y - f + 2, w + 2 * f, h + 2 * f);
  c.fillStyle = g;
  c.fillRect(x - f, y - f, w + 2 * f, h + 2 * f);
  c.fillStyle = PAPER;
  c.fillRect(x, y, w, h);
}

/**
 * @param {C2D} c @param {() => void} path
 */
function applied(c, path) {
  c.save();
  c.translate(1.6, 1.8);
  path();
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fill();
  c.restore();
  path();
  c.fillStyle = LUME;
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = SURROUND;
  c.stroke();
}

/**
 * @param {C2D} c @param {number} cx @param {number} cy @param {number} a angle clockwise from 12
 * @param {number} r0 @param {number} r1 @param {number} w
 */
function baton(c, cx, cy, a, r0, r1, w) {
  c.save();
  c.translate(cx, cy);
  c.rotate(a);
  applied(c, () => { c.beginPath(); c.rect(-w / 2, -r1, w, r1 - r0); });
  c.restore();
}

/**
 * Black ceramic insert: triangle with a lume pip at 0, numerals every 10,
 * minute bars for the first 15 minutes, 5-minute bars elsewhere. Numerals'
 * tops point outward (the 30 reads upside down, like a real bezel).
 * @param {C2D} c @param {number} ox x of the bezel square
 */
function drawBezel(c, ox) {
  const cx = ox + 256, cy = 256, R = 256, r = 256 * (FACE.bezelInner / FACE.bezelOuter);
  let g = c.createRadialGradient(cx - 60, cy - 90, 20, cx, cy, R);
  g.addColorStop(0, '#22252a');
  g.addColorStop(0.7, '#0c0d0f');
  g.addColorStop(1, '#050506');
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.arc(cx, cy, r - 4, 0, Math.PI * 2, true);
  c.fill('evenodd');
  c.fillStyle = GRAD;
  c.strokeStyle = GRAD;
  const mid = (R + r) / 2;
  for (let m = 1; m < 60; m++) {
    const a = (m / 60) * Math.PI * 2;
    if (m % 10 === 0) {
      c.save();
      c.translate(cx + Math.sin(a) * (mid + 1), cy - Math.cos(a) * (mid + 1));
      c.rotate(a);
      c.font = F_BEZEL;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(numStr(m), 0, 2);
      c.restore();
    } else if (m < 15 || m % 5 === 0) {
      const big = m % 5 === 0;
      c.save();
      c.translate(cx, cy);
      c.rotate(a);
      c.fillRect(big ? -4 : -2, -(R - 6), big ? 8 : 4, big ? 30 : 20);
      c.restore();
    }
  }
  // 0: inverted triangle with a lume pip
  c.beginPath();
  c.moveTo(cx - 22, cy - (R - 5));
  c.lineTo(cx + 22, cy - (R - 5));
  c.lineTo(cx, cy - (r + 6));
  c.closePath();
  c.fill();
  c.beginPath();
  c.arc(cx, cy - (R - 21), 8.5, 0, Math.PI * 2);
  c.fillStyle = '#9ea3a8';
  c.fill();
  c.beginPath();
  c.arc(cx, cy - (R - 21), 6.5, 0, Math.PI * 2);
  c.fillStyle = LUME;
  c.fill();
  g = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  g.addColorStop(0, 'rgba(255,255,255,0.07)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.arc(cx, cy, r, 0, Math.PI * 2, true);
  c.fill('evenodd');
}

// ── readouts (dynamic) ───────────────────────────────────────────────────────

/**
 * Codes the readouts are drawn from (an Int32Array, see Watch.js):
 */
export const RC = Object.freeze({
  HEALTH: 0, AMMO_ON: 1, WEAPON: 2, MAG: 3, CHAMBER: 4, MODE: 5, WAVE: 6, KILLS: 7, STATE: 8, INFO: 9,
  WARN: 10, SEVERE: 11, LEARN: 12, ROOMS: 13, SCANNING: 14, SPARES: 15,
  // menu-only
  PAGE: 16, DIFF: 17, PLAYMODE: 18, AMMOLINE: 19, CONFIRM: 20, FIT_W: 21, FIT_F: 22, FIT_P: 23, FIT_U: 24, FIT_FWD: 25,
  N_DIAL: 16, N: 26,
});

const MODE_WORD = ['', 'SAFE', 'SEMI', 'AUTO'];
const MODE_COLOR = ['#e8e6de', '#ffc061', '#ecebe4', '#ff4a36'];
const STATE_WORD = ['', 'READY', '', 'BREAK', 'PAUSED', 'DOWN', 'SCAN', 'SPOT'];
const STATE_COLOR = ['#cfcabd', '#8fd3ff', '#cfcabd', '#7ee29b', '#ffc061', '#ff5a4f', '#8fd3ff', '#8fd3ff'];
const MODE_RGB = MODE_COLOR.map(hex);
const STATE_RGB = STATE_COLOR.map(hex);
const PCT = /** @type {string[]} */ ([]);
for (let i = 0; i <= 100; i++) PCT.push(`SCAN ${i}%`);

/**
 * The glyph-atlas entries of the watch (fonts and stamps), registered once at load. Returns the indices the
 * layouts use. Fonts carry only the characters they print (the dial's big numerals: digits).
 * @param {import('./Glyphs.js').GlyphAtlas} A
 */
export function registerWatchArt(A) {
  const f = {
    health: A.addFont('w.health', F_HEALTH, DIGITS), ammo: A.addFont('w.ammo', F_AMMO, DIGITS), wave: A.addFont('w.wave', F_WAVE, DIGITS),
    mode: A.addFont('w.mode', F_MODE, 'SAFEMIUTO '), gun: A.addFont('w.gun', F_GUN, 'G17AKM '), info: A.addFont('w.info', F_INFO, TEXT_CHARS),
    row: A.addFont('m.row', F_ROW, TEXT_CHARS), val: A.addFont('m.val', F_VAL, TEXT_CHARS), s1: A.addFont('m.s1', F_STRIP1, TEXT_CHARS),
    s2: A.addFont('m.s2', F_STRIP2, TEXT_CHARS), s3: A.addFont('m.s3', F_STRIP3, TEXT_CHARS), sign: A.addFont('m.sign', F_SIGN, '−+ '),
  };
  /** @type {Record<string, number>} */ const paperOf = {};
  for (const k of ['health', 'ammo', 'wave']) {
    const R = /** @type {any} */ (READ)[k];
    paperOf[k] = A.addStamp(`w.paper.${k}`, R.w, R.h, (c, x, y) => paper(c, { x, y, w: R.w, h: R.h }));
  }
  const dot = A.addStamp('w.dot', 11, 11, (c, x, y) => { c.beginPath(); c.arc(x + 5.5, y + 5.5, 4.5, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill(); });
  const ring = A.addStamp('w.ring', 11, 11, (c, x, y) => { c.beginPath(); c.arc(x + 5.5, y + 5.5, 4.5, 0, Math.PI * 2); c.lineWidth = 1.5; c.strokeStyle = '#ffffff'; c.stroke(); });
  /** @type {number[]} */ const icons = [];
  for (let k = 0; k < WARN_WORDS.length; k++) icons.push(A.addStamp(`w.warn.${k}`, 28, 28, (c, x, y) => warnIcon(c, k, x + 14, y + 14, '#ffffff')));
  // menu pills: the dark body and the outline (white, tinted per row), 3-slice (caps + a stretched middle)
  const H = MENU_PX.rowH, PW = 2 * H + 8;
  const body = A.addStamp('m.pill.body', PW, H, (c, x, y) => pillPath(c, x, y, x + PW, y + H, '#171b20', '', 0));
  const line2 = A.addStamp('m.pill.l2', PW, H, (c, x, y) => pillPath(c, x + 1, y + 1, x + PW - 1, y + H - 1, '', '#ffffff', 2));
  const line3 = A.addStamp('m.pill.l3', PW, H, (c, x, y) => pillPath(c, x + 1.5, y + 1.5, x + PW - 1.5, y + H - 1.5, '', '#ffffff', 3));
  return { f, paper: paperOf, dot, ring, icons, pill: { body, line2, line3, w: PW, h: H } };
}

/** @typedef {ReturnType<typeof registerWatchArt>} WatchArt */

const C_INK = hex(INK), C_AMBER = hex(AMBER), C_RED = hex(RED);
const C_BAR = hex('#2f8a4c'), C_CHAMBER = hex('#1a7a3c'), C_RING = hex('#8a8d90'), C_GUN = hex('#d7d4cb');
const C_SCAN = hex('#1d4f91'), C_WARN = hex('#ffb347'), C_SEVERE = hex('#ff5a4f'), C_PCT = hex('#8fd3ff'), C_HINT = hex('#9db3c6');
const C_KILLS = hex('#ecebe4'), C_KILLS2 = hex('#bdb8aa');

/**
 * The dial's readouts on a glyph board (virtual 256×128 px, regions mapped onto the dial by the caller's
 * `frame` per region): health on a white wheel with a level bar, rounds + chamber dot, the wave (rooms found
 * while scanning, blue), the fire mode, one info line. Allocation-free.
 * @param {import('./Glyphs.js').GlyphBoard} B the board, with mapping i (B.setFrame) placing READ_REGIONS[i] on the dial
 * @param {WatchArt} W @param {Int32Array} n codes (RC)
 */
export function layoutReadouts(B, W, n) {
  B.begin();
  const F = W.f;
  // 12 o'clock: health on a white wheel, with a level bar
  let R = READ.health;
  B.useFrame(0);
  B.stamp(W.paper.health, R.x, R.y, R.w, R.h);
  const h = n[RC.HEALTH];
  const hc = h >= 60 ? C_INK : h >= 30 ? C_AMBER : C_RED;
  B.text(F.health, numStr(h), R.x + (R.w >> 1), R.y + (R.h >> 1) - 1, ALIGN.CENTER, hc);
  const bw = (((R.w - 16) * Math.max(0, Math.min(100, h))) / 100) | 0;
  B.fill(R.x + 8, R.y + R.h - 6, bw, 3, h >= 60 ? C_BAR : hc);
  // 3 o'clock, under the cyclops: rounds in the magazine (+ the chamber dot)
  R = READ.ammo;
  B.useFrame(1);
  B.stamp(W.paper.ammo, R.x, R.y, R.w, R.h);
  if (n[RC.AMMO_ON] && n[RC.WEAPON]) {
    const mag = n[RC.MAG];
    B.text(F.ammo, mag < 0 ? '--' : numStr(mag), R.x + (R.w >> 1) - 4, R.y + (R.h >> 1) + 1, ALIGN.CENTER, mag < 0 ? C_AMBER : mag === 0 ? C_RED : C_INK);
    if (n[RC.CHAMBER]) B.stamp(W.dot, R.x + R.w - 13, R.y + R.h - 15, 11, 11, C_CHAMBER);
    else B.stamp(W.ring, R.x + R.w - 13, R.y + R.h - 15, 11, 11, C_RING);
  }
  // 9 o'clock: wave number, or rooms found while scanning (blue)
  R = READ.wave;
  B.useFrame(2);
  B.stamp(W.paper.wave, R.x, R.y, R.w, R.h);
  const scanning = n[RC.SCANNING] !== 0;
  const wv = scanning ? n[RC.ROOMS] : n[RC.WAVE];
  if (wv > 0) B.text(F.wave, numStr(wv), R.x + (R.w >> 1), R.y + (R.h >> 1) + 1, ALIGN.CENTER, scanning ? C_SCAN : C_INK);
  // 6 o'clock upper: fire mode (AKM) or the pistol's name
  R = READ.mode;
  B.useFrame(3);
  const wc = n[RC.WEAPON];
  if (n[RC.AMMO_ON] && wc) {
    const md = n[RC.MODE];
    if (wc === 2 && md) B.text(F.mode, MODE_WORD[md], R.x + (R.w >> 1), R.y + (R.h >> 1) + 1, ALIGN.CENTER, MODE_RGB[md]);
    else B.text(F.gun, wc === 1 ? 'G17' : 'AKM', R.x + (R.w >> 1), R.y + (R.h >> 1) + 1, ALIGN.CENTER, C_GUN);
  }
  // 6 o'clock lower: one line of info (warning > state > scan > hint > kills)
  R = READ.info;
  B.useFrame(4);
  const cxI = R.x + (R.w >> 1), cyI = R.y + (R.h >> 1) + 1;
  const info = n[RC.INFO];
  if (info === INFO.WARN) {
    const k = n[RC.WARN];
    const col = n[RC.SEVERE] ? C_SEVERE : C_WARN;
    if (k >= 0 && k < W.icons.length) B.stamp(W.icons[k], cxI - 46 - 14, cyI - 14, 28, 28, col);
    B.text(F.info, WARN_WORDS[k] || '', cxI - 30, cyI, ALIGN.LEFT, col, 86);
  } else if (info === INFO.STATE) {
    const st = n[RC.STATE];
    B.text(F.info, STATE_WORD[st], cxI, cyI, ALIGN.CENTER, STATE_RGB[st], 110);
  } else if (info === INFO.SCAN) {
    B.text(F.info, PCT[Math.max(0, Math.min(100, n[RC.LEARN]))], cxI, cyI, ALIGN.CENTER, C_PCT, 110);
  } else if (info === INFO.HINT) {
    B.text(F.info, 'TAP · MENU', cxI, cyI, ALIGN.CENTER, C_HINT, 110);
  } else if (info === INFO.KILLS) {
    const a = numStr(n[RC.KILLS]);
    const wa = B.measure(F.info, a), wb = B.measure(F.info, ' KILLS');
    const x0 = cxI - ((wa + wb) >> 1);
    B.text(F.info, a, x0, cyI, ALIGN.LEFT, C_KILLS);
    B.text(F.info, ' KILLS', x0 + wa, cyI, ALIGN.LEFT, C_KILLS2);
  }
  B.end();
}

/**
 * A date-wheel window: off-white paper with a shadow under the frame's top edge.
 * @param {C2D} c @param {{ x: number, y: number, w: number, h: number }} R
 */
function paper(c, R) {
  c.fillStyle = PAPER;
  c.fillRect(R.x, R.y, R.w, R.h);
  const g = c.createLinearGradient(0, R.y, 0, R.y + 7);
  g.addColorStop(0, 'rgba(0,0,0,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(R.x, R.y, R.w, 7);
}

/**
 * Small pictograms for the warnings (about 22 px).
 * @param {C2D} c @param {number} k WARN @param {number} x centre @param {number} y centre @param {string} col
 */
export function warnIcon(c, k, x, y, col) {
  c.save();
  c.translate(x, y);
  c.strokeStyle = col;
  c.fillStyle = col;
  c.lineWidth = 2.6;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.beginPath();
  if (k === WARN.RUN) { // two chevrons: slow down
    c.moveTo(-8, -8); c.lineTo(-1, 0); c.lineTo(-8, 8);
    c.moveTo(1, -8); c.lineTo(8, 0); c.lineTo(1, 8);
    c.stroke();
  } else if (k === WARN.EDGE) { // a dashed line with an arrow onto it
    c.moveTo(6, -10); c.lineTo(6, -5); c.moveTo(6, -1); c.lineTo(6, 3); c.moveTo(6, 7); c.lineTo(6, 11);
    c.moveTo(-9, 0); c.lineTo(1, 0); c.moveTo(-3, -4); c.lineTo(1, 0); c.lineTo(-3, 4);
    c.stroke();
  } else if (k === WARN.OBSTACLE) { // warning triangle
    c.moveTo(0, -10); c.lineTo(10, 8); c.lineTo(-10, 8); c.closePath();
    c.stroke();
    c.fillRect(-1.3, -4, 2.6, 7);
    c.fillRect(-1.3, 4.6, 2.6, 2.4);
  } else if (k === WARN.STAIRS) { // steps going down
    c.moveTo(-10, -8); c.lineTo(-4, -8); c.lineTo(-4, -2); c.lineTo(2, -2); c.lineTo(2, 4); c.lineTo(8, 4); c.lineTo(8, 10);
    c.stroke();
  } else { // tracking lost: an eye with a slash
    c.moveTo(-10, 0); c.quadraticCurveTo(0, -10, 10, 0); c.quadraticCurveTo(0, 10, -10, 0);
    c.moveTo(-8, 8); c.lineTo(8, -8);
    c.stroke();
  }
  c.restore();
}

// ── menu disc (dynamic) ──────────────────────────────────────────────────────

const ROW_LABEL = ['RESUME', 'RESTART', 'DIFFICULTY', 'MODE', 'GUN FIT', 'AMMO LINE', 'EXIT',
  'GUN', 'PITCH', 'HEIGHT', 'FORWARD', 'SAVE', 'RESET', 'BACK'];
const ROW_COLOR = ['#9ff0c8', '#e8edf2', '#e8edf2', '#e8edf2', '#e8edf2', '#e8edf2', '#ffb0a0',
  '#e8edf2', '#e8edf2', '#e8edf2', '#e8edf2', '#9ff0c8', '#e8edf2', '#e8edf2'];
const ROW_RGB = ROW_COLOR.map(hex);
const _rr = { x0: 0, x1: 0, y0: 0, y1: 0 };

/**
 * The menu disc's static background (drawn once at load: never redrawn): the gradient disc and the minute track.
 * @param {C2D} c 512² context
 */
export function drawMenuBackground(c) {
  const M = MENU_PX, cx = M.c;
  c.fillStyle = '#000';
  c.fillRect(0, 0, M.size, M.size);
  const g = c.createRadialGradient(cx, cx - 60, 10, cx, cx, M.r);
  g.addColorStop(0, '#1d2025');
  g.addColorStop(0.7, '#0d0f12');
  g.addColorStop(1, '#07080a');
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cx, M.r, 0, Math.PI * 2);
  c.fill();
  // minute track round the edge
  c.strokeStyle = '#59606a';
  for (let m = 0; m < 60; m++) {
    const a = (m / 60) * Math.PI * 2, s = Math.sin(a), co = Math.cos(a);
    const r0 = m % 5 === 0 ? 236 : 241;
    c.lineWidth = m % 5 === 0 ? 3 : 1.5;
    c.beginPath();
    c.moveTo(cx + s * r0, cx - co * r0);
    c.lineTo(cx + s * 249, cx - co * 249);
    c.stroke();
  }
}

const C_STRIP = hex('#ecebe4'), C_LABEL = hex('#9db3c6'), C_SEP = hex('#59606a'), C_SIGN = hex('#e8edf2'), C_VLABEL = hex('#c5ccd4');
const C_VAL = hex('#9ff0c8'), C_PEND = hex('#ff8466'), C_ACTIVE = hex('#8cffd7'), C_PILL = hex('#343c46');
const C_HL = hex('#ffc061');

/**
 * The menu disc's dynamic part on a glyph board (virtual 512² px; the background is the static disc):
 * a status strip at the top, then seven pill rows. Allocation-free.
 * @param {import('./Glyphs.js').GlyphBoard} B @param {WatchArt} W @param {Int32Array} n codes (RC, menu entries included)
 * @param {number} fitPitchDeg @param {number} fitUp @param {number} fitFwd the selected gun's fit values
 */
export function layoutMenu(B, W, n, fitPitchDeg, fitUp, fitFwd) {
  const M = MENU_PX, cx = M.c, F = W.f;
  B.begin();
  const page = n[RC.PAGE];
  if (page === PAGE.FIT) {
    B.text(F.s1, n[RC.FIT_W] === 1 ? 'GUN FIT · AKM' : 'GUN FIT · GLOCK', cx, 74, ALIGN.CENTER, C_STRIP);
    B.text(F.s2, 'right stick ↕ adjusts the green line', cx, 104, ALIGN.CENTER, C_LABEL);
  } else strip(B, F, n);
  const rows = PAGE_ROWS[page] || PAGE_ROWS[0];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    rowRect(i, _rr);
    const pending = n[RC.CONFIRM] === row;
    const active = page === PAGE.FIT && isValueRow(row) && n[RC.FIT_F] === row - ROW.PITCH;
    pill(B, W, _rr, pending ? C_PEND : active ? C_ACTIVE : C_PILL, pending || active ? 3 : 2);
    const ym = ((_rr.y0 + _rr.y1) >> 1) + 1;
    if (isValueRow(row)) {
      B.text(F.sign, '−', _rr.x0 + 26, ym, ALIGN.CENTER, C_SIGN);
      B.text(F.sign, '+', _rr.x1 - 26, ym, ALIGN.CENTER, C_SIGN);
      B.text(F.row, ROW_LABEL[row], cx - 6, ym, ALIGN.RIGHT, C_VLABEL);
      B.text(F.row, row === ROW.PITCH ? degStr(fitPitchDeg) : row === ROW.HEIGHT ? mmStr(fitUp) : mmStr(fitFwd), cx + 8, ym, ALIGN.LEFT, C_VAL);
      continue;
    }
    B.text(F.row, pending ? 'TAP AGAIN' : ROW_LABEL[row], _rr.x0 + 20, ym, ALIGN.LEFT, pending ? C_PEND : ROW_RGB[row]);
    const v = rowValue(row, n);
    if (v) B.text(F.val, v, _rr.x1 - 20, ym, ALIGN.RIGHT, C_VAL);
  }
  B.end();
}

/**
 * @param {number} row @param {Int32Array} n
 * @returns {string}
 */
function rowValue(row, n) {
  switch (row) {
    case ROW.DIFFICULTY: return n[RC.DIFF] ? 'REALISTIC' : 'TEST';
    case ROW.MODE: return n[RC.PLAYMODE] ? 'SPOT' : 'ROAM';
    case ROW.FIT: return '▸';
    case ROW.AMMO: return n[RC.AMMOLINE] ? 'ON' : 'OFF';
    case ROW.GUN: return n[RC.FIT_W] === 1 ? 'AKM' : 'GLOCK';
    case ROW.BACK: return '◂';
    case ROW.RESUME: return '▶';
    default: return '';
  }
}

/**
 * Status strip: "HEALTH 100 · 17+1 SEMI" and "WAVE 3 · 12 KILLS" (+ the house line when learning).
 * @param {import('./Glyphs.js').GlyphBoard} B @param {WatchArt['f']} F @param {Int32Array} n
 */
function strip(B, F, n) {
  const cx = MENU_PX.c;
  runReset();
  const h = n[RC.HEALTH];
  runAdd('HEALTH ', C_LABEL);
  runAdd(numStr(h), h >= 60 ? C_STRIP : h >= 30 ? C_HL : C_SEVERE);
  if (n[RC.WEAPON]) {
    runAdd('  ·  ', C_SEP);
    const mag = n[RC.MAG];
    runAdd(mag < 0 ? '--' : numStr(mag), mag < 0 ? C_HL : C_STRIP);
    runAdd(n[RC.CHAMBER] ? '+1' : '+0', C_LABEL);
    const md = n[RC.MODE];
    if (n[RC.WEAPON] === 2 && md) { runAdd(' ', 0); runAdd(MODE_WORD[md], MODE_RGB[md]); }
  }
  runDraw(B, F.s1, cx, 70);
  runReset();
  runAdd('WAVE ', C_LABEL);
  runAdd(numStr(n[RC.WAVE]), C_STRIP);
  runAdd('  ·  ', C_SEP);
  runAdd(numStr(n[RC.KILLS]), C_STRIP);
  runAdd(' KILLS', C_LABEL);
  if (n[RC.SPARES] >= 0) {
    runAdd('  ·  ', C_SEP);
    runAdd(numStr(n[RC.SPARES]), C_STRIP);
    runAdd(' MAGS', C_LABEL);
  }
  runDraw(B, F.s2, cx, 97);
  if (n[RC.LEARN] >= 0 || n[RC.ROOMS] >= 0) {
    runReset();
    runAdd('HOUSE ', C_LABEL);
    if (n[RC.LEARN] >= 0) { runAdd(numStr(n[RC.LEARN]), C_PCT); runAdd('%', C_PCT); }
    if (n[RC.ROOMS] >= 0) { runAdd('  ·  ', C_SEP); runAdd(numStr(n[RC.ROOMS]), C_PCT); runAdd(' ROOMS', C_LABEL); }
    runDraw(B, F.s3, cx, 116);
  }
}

// A run of coloured strings laid out centred as one line (fixed scratch, no arrays per layout).
const RUN_S = /** @type {string[]} */ (new Array(16).fill(''));
const RUN_C = new Int32Array(16);
let runN = 0;
function runReset() { runN = 0; }
/** @param {string} s @param {number} col */
function runAdd(s, col) { if (runN < 16) { RUN_S[runN] = s; RUN_C[runN] = col; runN++; } }
/** @param {import('./Glyphs.js').GlyphBoard} B @param {number} f @param {number} cx @param {number} y */
function runDraw(B, f, cx, y) {
  let w = 0;
  for (let i = 0; i < runN; i++) w += B.measure(f, RUN_S[i]);
  let x = cx - (w >> 1);
  for (let i = 0; i < runN; i++) x += B.text(f, RUN_S[i], x, y, ALIGN.LEFT, RUN_C[i]);
}

/**
 * A row's pill: the dark body and the outline, each as caps + a stretched middle.
 * @param {import('./Glyphs.js').GlyphBoard} B @param {WatchArt} W @param {{ x0: number, x1: number, y0: number, y1: number }} r
 * @param {number} stroke @param {number} lw
 */
function pill(B, W, r, stroke, lw) {
  const P = W.pill, cap = ((r.y1 - r.y0) >> 1) + 2;
  B.slice3(P.body, r.x0, r.y0, r.x1, r.y1, cap, 0xffffff);
  B.slice3(lw >= 3 ? P.line3 : P.line2, r.x0, r.y0, r.x1, r.y1, cap, stroke);
}

/**
 * A pill path filled and / or stroked (atlas drawing, load time).
 * @param {C2D} c @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {string} fill @param {string} stroke @param {number} lw
 */
function pillPath(c, x0, y0, x1, y1, fill, stroke, lw) {
  const rad = (y1 - y0) / 2;
  c.beginPath();
  c.moveTo(x0 + rad, y0);
  c.lineTo(x1 - rad, y0);
  c.arc(x1 - rad, y0 + rad, rad, -Math.PI / 2, Math.PI / 2);
  c.lineTo(x0 + rad, y1);
  c.arc(x0 + rad, y0 + rad, rad, Math.PI / 2, Math.PI * 1.5);
  c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.lineWidth = lw; c.strokeStyle = stroke; c.stroke(); }
}

/** Every string the dial and menu can print (tests check there is no brand name). */
export const ALL_LABELS = Object.freeze([...ROW_LABEL, ...MODE_WORD, ...STATE_WORD, ...WARN_WORDS, 'CQC', 'PASS-THROUGH',
  'TAP AGAIN', 'TAP · MENU', 'G17', 'AKM', 'GLOCK', 'REALISTIC', 'TEST', 'ROAM', 'SPOT', 'ON', 'OFF', 'HEALTH ', 'WAVE ', ' KILLS', ' MAGS',
  'HOUSE ', ' ROOMS', 'GUN FIT · AKM', 'GUN FIT · GLOCK', 'right stick ↕ adjusts the green line']);
