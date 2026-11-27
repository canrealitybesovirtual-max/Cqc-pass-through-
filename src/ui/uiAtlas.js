// @ts-check
import { GlyphAtlas } from './Glyphs.js';
import { registerWatchArt } from './watchArt.js';

/**
 * The one glyph atlas of the game's UI (v0.5): the watch's dial and menu
 * fonts and pieces, and the message / card panels' fonts. Built on first use
 * (at load: PlayKit, App), uploaded by the warm-up with the watch's meshes,
 * never redrawn. Every GlyphBoard shares its material (one program).
 */
/** @type {{ atlas: GlyphAtlas, art: import('./watchArt.js').WatchArt, panel: { head: number, body: number } }|null} */
let ui = null;

/** The shared UI atlas, created on the first call. */
export function uiAtlas() {
  if (ui) return ui;
  const atlas = new GlyphAtlas({ width: 2048, height: 1024 });
  const art = registerWatchArt(atlas);
  const panel = { head: atlas.addFont('p.head', '600 33px system-ui, sans-serif'), body: atlas.addFont('p.body', '28px system-ui, sans-serif') };
  if (atlas.overflow) atlas.notes.push(`atlas overflow: ${atlas.overflow} cells did not fit`);
  ui = { atlas, art, panel };
  return ui;
}
