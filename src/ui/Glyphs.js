// @ts-check
import * as THREE from 'three';

/**
 * Text and readouts with ZERO texture uploads during play (v0.5).
 *
 * The v0.4 device record still showed canvas texture uploads in play (the
 * watch dial ≤ 2/s, the menu, GameSession's messages): each one is a
 * `texSubImage2D` of up to 1 MB on the GL thread. Now every glyph and every
 * piece of panel art is drawn ONCE at load into one atlas (`GlyphAtlas`,
 * uploaded by the warm-up), and what changes in play is only which atlas
 * rectangles a `GlyphBoard` shows where: a few hundred bytes of instanced
 * attributes (one `bufferSubData` of a preallocated buffer, never a new
 * buffer, never a compile, never a texture upload).
 *
 * - `GlyphAtlas`: fonts (one cell per character, white on transparent, the
 *   advance width measured once) and stamps (any drawing: paper windows, pill
 *   caps, icons, a solid tile for bars and backgrounds), shelf-packed into one
 *   canvas texture (no mipmaps, linear, sRGB).
 * - `GlyphBoard`: one Mesh with an InstancedBufferGeometry (one quad per
 *   glyph or stamp, drawn in order: one draw call), laid out in a virtual
 *   canvas's pixels (y down) mapped onto the board's local plane by `frame()`.
 *   Colours tint the white art per quad (sRGB hex → linear, so the output
 *   matches the colour a canvas would have drawn).
 *
 * One material for every board (`atlas.material`): one program, compiled by
 * the warm-up. Every program-key property is fixed at construction.
 * Layout is allocation-free: strings come from constants or cached number
 * strings, characters are read with charCodeAt.
 */

/** Characters every text font carries (ASCII plus the typography the game's messages use). */
export const TEXT_CHARS = (() => {
  let s = '';
  for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
  return s + '…≤≥§–—→←↑↓↕×‘’“”·°²−±▸◂▶✓└─%';
})();
export const DIGITS = '0123456789-+%. ';
/** Character codes mapped per font (covers every char above; others draw '?'). */
const MAP_N = 0x2800;

const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4); }

/**
 * '#rrggbb' (or 0xrrggbb) → a packed 0xrrggbb number (load time).
 * @param {string|number} c
 */
export function hex(c) {
  if (typeof c === 'number') return c >>> 0;
  const s = c.trim();
  if (s[0] === '#' && s.length === 7) return parseInt(s.slice(1), 16) >>> 0;
  if (s[0] === '#' && s.length === 4) return parseInt(s[1] + s[1] + s[2] + s[2] + s[3] + s[3], 16) >>> 0;
  return 0xffffff;
}

/**
 * @typedef {{ key: string, css: string, px: number, h: number, pad: number, map: Int16Array, rect: Float32Array, adv: Float32Array,
 *   cw: Float32Array, n: number, fallback: number }} Font
 * @typedef {{ key: string, uv: Float32Array, w: number, h: number }} Stamp
 */

export class GlyphAtlas {
  /** @param {{ width?: number, height?: number, pad?: number }} [o] */
  constructor({ width = 2048, height = 1024, pad = 2 } = {}) {
    this.width = width;
    this.height = height;
    this.pad = pad;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    /** @type {Font[]} */ this.fonts = [];
    /** @type {Record<string, number>} */ this.fontIndex = {};
    /** @type {Stamp[]} */ this.stamps = [];
    /** @type {Record<string, number>} */ this.stampIndex = {};
    // shelf packer
    this.sx = 0;
    this.sy = 0;
    this.rowH = 0;
    this.overflow = 0;
    /** @type {string[]} */ this.notes = [];
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.name = 'ui-glyph-atlas';
    /** The one material every board draws with (fixed program key). */
    this.material = boardMaterial(this.texture);
    this.solid = this.addStamp('solid', 4, 4, (c, x, y) => { c.fillStyle = '#ffffff'; c.fillRect(x - 2, y - 2, 8, 8); }, 2);
  }

  /** @param {number} w @param {number} h @returns {{ x: number, y: number }|null} top-left of a free w×h cell */
  _alloc(w, h) {
    if (this.sx + w > this.width) { this.sx = 0; this.sy += this.rowH; this.rowH = 0; }
    if (this.sy + h > this.height || w > this.width) { this.overflow++; return null; }
    const at = { x: this.sx, y: this.sy };
    this.sx += w;
    if (h > this.rowH) this.rowH = h;
    return at;
  }

  /**
   * A font: every character of `chars` in white, measured once.
   * @param {string} key @param {string} css canvas font, e.g. '700 38px serif' @param {string} [chars]
   * @returns {number} the font index
   */
  addFont(key, css, chars = TEXT_CHARS) {
    if (key in this.fontIndex) return this.fontIndex[key];
    const m = /(\d+(?:\.\d+)?)px/.exec(css);
    const px = m ? Number(m[1]) : 20;
    const pad = this.pad + 1;
    const h = Math.ceil(px * 1.35) + 2 * pad;
    const n = chars.length;
    /** @type {Font} */
    const F = { key, css, px, h, pad, map: new Int16Array(MAP_N).fill(-1), rect: new Float32Array(n * 4), adv: new Float32Array(n), cw: new Float32Array(n), n, fallback: 0 };
    const c = this.ctx;
    c.save();
    c.font = css;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    for (let i = 0; i < n; i++) {
      const ch = chars[i];
      const code = ch.charCodeAt(0);
      let adv = 0;
      try { adv = c.measureText(ch).width; } catch { adv = px * 0.6; }
      if (!(adv >= 0)) adv = px * 0.6;
      // the cell: the advance plus a margin for overhangs (italic tails, ink past the advance)
      const cw = Math.ceil(adv + px * 0.12) + 2 * pad;
      const at = this._alloc(cw, h);
      F.adv[i] = adv;
      F.cw[i] = cw;
      if (at) {
        try { c.fillText(ch, at.x + pad, at.y + h / 2); } catch { /* a fake canvas */ }
        F.rect[4 * i] = at.x / this.width;
        F.rect[4 * i + 1] = 1 - (at.y + h) / this.height; // flipY: v grows up
        F.rect[4 * i + 2] = cw / this.width;
        F.rect[4 * i + 3] = h / this.height;
      }
      if (code < MAP_N) F.map[code] = i;
      if (ch === '?') F.fallback = i;
    }
    c.restore();
    const idx = this.fonts.length;
    this.fonts.push(F);
    this.fontIndex[key] = idx;
    return idx;
  }

  /**
   * A stamp: any drawing in a w×h cell (draw at (x, y) = the cell's top-left, inside the padding).
   * Stretched stamps (the solid tile) sample their inner part only, so no neighbour bleeds in.
   * @param {string} key @param {number} w @param {number} h
   * @param {(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void} draw
   * @param {number} [inset] px trimmed from each side of the sampled rectangle
   * @returns {number} the stamp index
   */
  addStamp(key, w, h, draw, inset = 0) {
    if (key in this.stampIndex) return this.stampIndex[key];
    const p = this.pad;
    const at = this._alloc(Math.ceil(w) + 2 * p, Math.ceil(h) + 2 * p);
    const uv = new Float32Array(4);
    if (at) {
      const c = this.ctx;
      c.save();
      try { draw(c, at.x + p, at.y + p, w, h); } catch (e) { this.notes.push(`stamp ${key}: ${e instanceof Error ? e.message : e}`); }
      c.restore();
      uv[0] = (at.x + p + inset) / this.width;
      uv[1] = 1 - (at.y + p + h - inset) / this.height;
      uv[2] = (w - 2 * inset) / this.width;
      uv[3] = (h - 2 * inset) / this.height;
    }
    const idx = this.stamps.length;
    this.stamps.push({ key, uv, w, h });
    this.stampIndex[key] = idx;
    return idx;
  }

  /**
   * Width of a string in a font (px at the font's own size). Allocation-free.
   * @param {number} f @param {string} s
   */
  measure(f, s) {
    const F = this.fonts[f];
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      const g = code < MAP_N ? F.map[code] : -1;
      w += F.adv[g >= 0 ? g : F.fallback];
    }
    return w;
  }

  /** Pixels in use (for the record). */
  usedRows() { return this.sy + this.rowH; }
}

/**
 * The shared board material: MeshBasicMaterial (map = the atlas, per-quad colour) with the quad placement
 * in the vertex shader. Fixed program key.
 * @param {THREE.Texture} tex
 */
function boardMaterial(tex) {
  const m = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  m.name = 'ui-glyph-board';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 iRect;\nattribute vec4 iUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = iUv.xy + position.xy * iUv.zw;\n#endif')
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3( iRect.xy + position.xy * iRect.zw, 0.0 );');
  };
  m.customProgramCacheKey = () => 'cqc-glyph-board-1';
  return m;
}

/** The unit quad every board instances (corners 0..1). */
let _quad = /** @type {THREE.BufferGeometry|null} */ (null);
function quad() {
  if (_quad) return _quad;
  const g = new THREE.BufferGeometry();
  const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  _quad = g;
  return g;
}

/** Text alignment for GlyphBoard.text. */
export const ALIGN = Object.freeze({ LEFT: 0, CENTER: 1, RIGHT: 2 });

export class GlyphBoard {
  /**
   * @param {GlyphAtlas} atlas
   * @param {{ capacity?: number, name?: string, renderOrder?: number }} [o]
   */
  constructor(atlas, { capacity = 128, name = 'glyph-board', renderOrder = 0 } = {}) {
    this.atlas = atlas;
    this.capacity = capacity;
    const g = new THREE.InstancedBufferGeometry();
    const q = quad();
    g.setAttribute('position', q.getAttribute('position'));
    g.setAttribute('uv', q.getAttribute('uv'));
    g.setIndex(q.getIndex());
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.uvs = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const a of [this.rect, this.uvs, this.col]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iRect', this.rect);
    g.setAttribute('iUv', this.uvs);
    g.setAttribute('color', this.col);
    g.instanceCount = 0;
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, atlas.material);
    this.mesh.name = name;
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.n = 0;
    /** Quads that did not fit (a layout bug: counted, never thrown). */
    this.dropped = 0;
    /**
     * px → local mappings (ox, oy, kx, ky each): local x = ox + px·kx, y = oy − py·ky. Set once (frame / setFrame);
     * layouts switch with useFrame(i), so no double crosses a call in the layout code (V8 boxes double
     * arguments of calls it does not inline: an allocation per call).
     */
    this.frames = new Float64Array(4 * 8);
    this.ox = 0; this.oy = 0; this.kx = 0.001; this.ky = 0.001;
    /** The strings laid out since begin() (references to constants: no allocation), for tests and reports. */
    this.strs = new Array(64).fill('');
    this.ns = 0;
    /** Layouts written (each one buffer update of the used range). */
    this.layouts = 0;
  }

  /** Start a new layout. */
  begin() { this.n = 0; this.ns = 0; }

  /**
   * Set mapping i (load time) and use it.
   * @param {number} i @param {number} ox @param {number} oy @param {number} kx @param {number} [ky]
   */
  setFrame(i, ox, oy, kx, ky = kx) {
    const F = this.frames, o = 4 * i;
    F[o] = ox; F[o + 1] = oy; F[o + 2] = kx; F[o + 3] = ky;
    this.useFrame(i);
  }

  /** Mapping 0, set and used (a board with one mapping). @param {number} ox @param {number} oy @param {number} kx @param {number} [ky] */
  frame(ox, oy, kx, ky = kx) { this.setFrame(0, ox, oy, kx, ky); }

  /** Lay out in mapping i from here on. @param {number} i */
  useFrame(i) {
    const F = this.frames, o = 4 * i;
    this.ox = F[o]; this.oy = F[o + 1]; this.kx = F[o + 2]; this.ky = F[o + 3];
  }

  /**
   * One quad (internal: atlas rectangle u0, v0, du, dv; px x, y top-left, w × h).
   * @param {number} u0 @param {number} v0 @param {number} du @param {number} dv
   * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} rgb 0xrrggbb
   */
  _q(u0, v0, du, dv, x, y, w, h, rgb) {
    const k = this.n;
    if (k >= this.capacity) { this.dropped++; return; }
    this.n = k + 1;
    const o = 4 * k, R = this.rect.array, U = this.uvs.array, C = this.col.array;
    R[o] = this.ox + x * this.kx;
    R[o + 1] = this.oy - (y + h) * this.ky;
    R[o + 2] = w * this.kx;
    R[o + 3] = h * this.ky;
    U[o] = u0; U[o + 1] = v0; U[o + 2] = du; U[o + 3] = dv;
    C[o] = SRGB[(rgb >> 16) & 255];
    C[o + 1] = SRGB[(rgb >> 8) & 255];
    C[o + 2] = SRGB[rgb & 255];
    C[o + 3] = 1;
  }

  /**
   * A stamp at px (x, y) top-left, w × h px (stretched), tinted (white keeps the stamp's own colours).
   * Integer px arguments (see `frames`).
   * @param {number} s stamp index @param {number} x @param {number} y @param {number} w @param {number} h @param {number} [rgb]
   */
  stamp(s, x, y, w, h, rgb = 0xffffff) {
    const S = this.atlas.stamps[s];
    if (!S) return;
    const u = S.uv;
    this._q(u[0], u[1], u[2], u[3], x, y, w, h, rgb);
  }

  /**
   * A stamp in three horizontal slices: its left `cap` px and right `cap` px unstretched (caps of a pill),
   * its middle column stretched across the rest. Integer px arguments.
   * @param {number} s @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} cap @param {number} rgb
   */
  slice3(s, x0, y0, x1, y1, cap, rgb) {
    const S = this.atlas.stamps[s];
    if (!S) return;
    const u = S.uv, fc = cap / S.w, h = y1 - y0, mid = x1 - x0 - 2 * cap;
    this._q(u[0], u[1], u[2] * fc, u[3], x0, y0, cap, h, rgb);
    if (mid > 0) this._q(u[0] + u[2] * 0.49, u[1], u[2] * 0.02, u[3], x0 + cap, y0, mid, h, rgb);
    this._q(u[0] + u[2] * (1 - fc), u[1], u[2] * fc, u[3], x1 - cap, y0, cap, h, rgb);
  }

  /** A filled rectangle (the solid stamp, stretched). Integer px. @param {number} x @param {number} y @param {number} w @param {number} h @param {number} rgb */
  fill(x, y, w, h, rgb) { if (w > 0 && h > 0) this.stamp(this.atlas.solid, x, y, w, h, rgb); }

  /**
   * A line of text, vertically centred on y (canvas 'middle'), aligned at x, squeezed horizontally to `maxW`
   * when wider (like the canvas fit), at `pct` % of the font's size. Integer arguments.
   * @param {number} f font index @param {string} s @param {number} x @param {number} y @param {number} align ALIGN
   * @param {number} rgb @param {number} [maxW] @param {number} [pct]
   * @returns {number} the drawn width (px, rounded)
   */
  text(f, s, x, y, align, rgb, maxW = 0, pct = 100) {
    const A = this.atlas, F = A.fonts[f];
    if (!F || !s) return 0;
    if (this.ns < this.strs.length) this.strs[this.ns++] = s;
    const scale = pct / 100;
    let w = A.measure(f, s) * scale;
    let sx = scale;
    if (maxW > 0 && w > maxW) { sx = (scale * maxW) / w; w = maxW; }
    let pen = align === ALIGN.CENTER ? x - w / 2 : align === ALIGN.RIGHT ? x - w : x;
    const h = F.h * scale, top = y - h / 2, pad = F.pad;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      let g = code < MAP_N ? F.map[code] : -1;
      if (g < 0) g = F.fallback;
      if (code !== 32) {
        const o = 4 * g, r = F.rect;
        this._q(r[o], r[o + 1], r[o + 2], r[o + 3], pen - pad * sx, top, F.cw[g] * sx, h, rgb);
      }
      pen += F.adv[g] * sx;
    }
    return Math.round(w);
  }

  /** Width of a string in a font at `pct` % size (px, rounded). @param {number} f @param {string} s @param {number} [pct] */
  measure(f, s, pct = 100) { return Math.round((this.atlas.measure(f, s) * pct) / 100); }

  /**
   * Finish the layout: the three attributes go up in this frame's draw (one bufferSubData each of the whole,
   * preallocated array: a few KB; three's update ranges would allocate a range object per call).
   */
  end() {
    const n = this.n;
    if (n > 0) { this.rect.needsUpdate = true; this.uvs.needsUpdate = true; this.col.needsUpdate = true; }
    this.geometry.instanceCount = n;
    this.layouts++;
  }

  /** The strings of the current layout (allocates: tests and reports only). */
  strings() { return this.strs.slice(0, this.ns); }
}
