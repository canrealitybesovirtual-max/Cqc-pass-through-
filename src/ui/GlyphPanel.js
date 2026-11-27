// @ts-check
import { TagAlong } from './CanvasPanel.js';
import { ALIGN, GlyphBoard, hex } from './Glyphs.js';
import { uiAtlas } from './uiAtlas.js';

const C_BG = hex('#10161d'), C_EDGE = hex('#2f4256');
const C_HEAD = hex('#ffffff'), C_OK = hex('#7ee29b'), C_WARN = hex('#ffc061'), C_DIM = hex('#9fb3c8'), C_TEXT = hex('#dfe7ef');

/**
 * The message / card panel of play sessions (v0.5): the CanvasPanel's look
 * (dark card, thin edge, a bright first line, ✓ / ! / [ lines coloured) laid
 * out from the shared glyph atlas, so a new message is a buffer update of a
 * few KB and never a texture upload (GameSession's pause and round messages,
 * App's "Get ready" card). Same tag-along placement as CanvasPanel.
 *
 *   panel.setLines(lines); if (panel.dirty && panel.mesh.visible) panel.flush();
 */
export class GlyphPanel extends TagAlong {
  /** @param {{ width?: number, height?: number, worldWidth?: number, capacity?: number, name?: string }} [o] */
  constructor({ width = 1024, height = 640, worldWidth = 0.56, capacity = 1400, name = 'glyph-panel' } = {}) {
    const ui = uiAtlas();
    const board = new GlyphBoard(ui.atlas, { capacity, name, renderOrder: 50 });
    super(board.mesh);
    this.ui = ui;
    this.board = board;
    this.width = width;
    this.height = height;
    const k = worldWidth / width;
    board.frame((-width / 2) * k, (height / 2) * k, k);
    /** The atlas (shared, uploaded at load; never updated in play). */
    this.texture = ui.atlas.texture;
    /** @type {string[]} */ this.lines = [];
    this.dirty = false;
    /** Texture uploads (always 0: the record field CanvasPanel had). */
    this.uploads = 0;
    /** Layouts written (each one small buffer update). */
    this.layouts = 0;
  }

  /** @param {string[]} lines */
  setLines(lines) {
    const L = this.lines;
    if (lines === L) return;
    if (lines.length === L.length) {
      let same = true;
      for (let i = 0; i < L.length; i++) if (lines[i] !== L[i]) { same = false; break; }
      if (same) { this.lines = lines; return; }
    }
    this.lines = lines;
    this.dirty = true;
  }

  /** Lay the card out (only when its text changed and it is visible). Returns true when laid out. */
  flush() {
    if (!this.dirty || !this.mesh.visible) return false;
    const B = this.board, W = this.width, H = this.height, P = this.ui.panel;
    B.begin();
    B.fill(0, 0, W, H, C_BG);
    B.fill(0, 0, W, 4, C_EDGE);
    B.fill(0, H - 4, W, 4, C_EDGE);
    B.fill(0, 4, 4, H - 8, C_EDGE);
    B.fill(W - 4, 4, 4, H - 8, C_EDGE);
    const n = this.lines.length;
    const lh = Math.min(46, (H - 40) / Math.max(1, n));
    for (let i = 0; i < n; i++) {
      const s = this.lines[i];
      const head = i === 0;
      const c0 = s.charCodeAt(0);
      const col = head ? C_HEAD : c0 === 0x2713 ? C_OK : c0 === 33 ? C_WARN : c0 === 91 ? C_DIM : C_TEXT;
      const px = Math.round(lh * (head ? 0.72 : 0.6));
      const pct = Math.round((100 * px) / (head ? 33 : 28));
      B.text(head ? P.head : P.body, s, 24, Math.round(20 + lh * 0.8 + i * lh - lh * 0.25), ALIGN.LEFT, col, W - 48, pct);
    }
    B.end();
    this.dirty = false;
    this.layouts++;
    return true;
  }
}
