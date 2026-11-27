// @ts-check
/**
 * Texture atlas packing (pure, no dependencies): skyline bottom-left packing
 * of rectangles with a uniform scale found by bisection.
 */

/** @typedef {{ w: number, h: number }} Size */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * Pack rectangles (already in final pixel size, padding included) into a
 * W x H bin. Returns placements in input order, or null if they do not fit.
 * @param {Size[]} sizes
 * @param {number} W @param {number} H
 * @returns {Rect[] | null}
 */
export function skylinePack(sizes, W, H) {
  /** @type {{ x: number, y: number, w: number }[]} */
  let sky = [{ x: 0, y: 0, w: W }];
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
  /** @type {(Rect | null)[]} */
  const out = sizes.map(() => null);
  for (const i of order) {
    const { w, h } = sizes[i];
    if (w > W || h > H) return null;
    let best = -1, bestY = Infinity, bestX = Infinity;
    for (let s = 0; s < sky.length; s++) {
      const x = sky[s].x;
      if (x + w > W) break;
      // max height of the skyline under [x, x + w)
      let y = 0, rem = w, k = s;
      while (rem > 0 && k < sky.length) { y = Math.max(y, sky[k].y); rem -= sky[k].w; k++; }
      if (rem > 0) continue;
      if (y + h <= H && (y < bestY || (y === bestY && x < bestX))) { best = s; bestY = y; bestX = x; }
    }
    if (best < 0) return null;
    out[i] = { x: bestX, y: bestY, w, h };
    // update the skyline: replace the covered span with one segment at bestY + h
    /** @type {{ x: number, y: number, w: number }[]} */
    const next = [];
    const x0 = bestX, x1 = bestX + w;
    for (const seg of sky) {
      const s0 = seg.x, s1 = seg.x + seg.w;
      if (s1 <= x0 || s0 >= x1) { next.push(seg); continue; }
      if (s0 < x0) next.push({ x: s0, y: seg.y, w: x0 - s0 });
      if (s1 > x1) next.push({ x: x1, y: seg.y, w: s1 - x1 });
    }
    next.push({ x: x0, y: bestY + h, w });
    next.sort((a, b) => a.x - b.x);
    // merge neighbours at the same height
    sky = [];
    for (const seg of next) {
      const last = sky[sky.length - 1];
      if (last && last.y === seg.y && last.x + last.w === seg.x) last.w += seg.w; else sky.push({ ...seg });
    }
  }
  return /** @type {Rect[]} */ (out);
}

/**
 * Largest uniform scale (<= maxScale) at which the tiles, each grown by `pad`
 * pixels on every side, fit into W x H. Tile sizes are rounded to multiples of
 * `align` pixels (block-compressed formats work in 4x4 blocks).
 * @param {Size[]} sizes unscaled tile sizes
 * @param {number} W @param {number} H @param {number} pad
 * @param {{ maxScale?: number, align?: number }} [opt]
 * @returns {{ scale: number, rects: Rect[] } | null} rects = inner (unpadded) tile rectangles
 */
export function packScaled(sizes, W, H, pad, opt = {}) {
  const maxScale = opt.maxScale ?? 1, align = opt.align ?? 4;
  /** @param {number} s */
  const tryScale = (s) => {
    const inner = sizes.map((z) => ({ w: Math.max(align, Math.floor((z.w * s) / align) * align), h: Math.max(align, Math.floor((z.h * s) / align) * align) }));
    const placed = skylinePack(inner.map((z) => ({ w: z.w + 2 * pad, h: z.h + 2 * pad })), W, H);
    if (!placed) return null;
    return placed.map((p, i) => ({ x: p.x + pad, y: p.y + pad, w: inner[i].w, h: inner[i].h }));
  };
  let rects = tryScale(maxScale);
  if (rects) return { scale: maxScale, rects };
  let lo = 0, hi = maxScale;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    if (tryScale(mid)) lo = mid; else hi = mid;
  }
  if (lo <= 0) return null;
  rects = tryScale(lo);
  return rects ? { scale: lo, rects } : null;
}

/**
 * Map a UV inside a tile's source window [u0,u1]x[v0,v1] to atlas UV.
 * glTF UV (0,0) is the top-left of the image, so no flip is involved.
 * @param {number} u @param {number} v
 * @param {{ u0: number, v0: number, u1: number, v1: number }} win
 * @param {Rect} rect @param {number} W @param {number} H
 * @returns {[number, number]}
 */
export function remapUV(u, v, win, rect, W, H) {
  const fu = (u - win.u0) / (win.u1 - win.u0), fv = (v - win.v0) / (win.v1 - win.v0);
  return [(rect.x + fu * rect.w) / W, (rect.y + fv * rect.h) / H];
}
