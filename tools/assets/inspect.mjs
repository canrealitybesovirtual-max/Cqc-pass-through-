// @ts-check
/**
 * List the connected pieces of a source weapon with the label and part the
 * classification rules give them, and their bounds in the source frame (mm).
 * Use it when changing the rules in weapons.mjs.
 *   node inspect.mjs glock|akm
 */
import { AKM, GLOCK } from './weapons.mjs';
import { readDoc, readPieces } from './lib/source.mjs';
import { bounds } from './lib/geom.mjs';

const def = process.argv[2] === 'akm' ? AKM : GLOCK;
const doc = await readDoc(def.file);
const S = (/** @type {number} */ s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
let scale = def.scale;
if (scale == null) {
  const probe = readPieces(doc, { frame: S(1), classify: S(1), skip: def.skip });
  const pts = probe.flatMap((p) => Array.from(p.pos));
  const b = bounds(pts);
  scale = /** @type {number} */ (def.lengthM) / (b.max[2] - b.min[2]);
}
const pieces = readPieces(doc, { frame: S(scale), classify: S(scale * 1000), skip: def.skip });
for (const p of pieces) def.classify(p, pieces);
pieces.sort((a, b) => a.src.localeCompare(b.src) || b.idx.length - a.idx.length);
const f = (/** @type {number[]} */ v) => v.map((x) => x.toFixed(1).padStart(7)).join(' ');
console.log(`${def.id}: ${pieces.length} pieces, scale ${scale.toFixed(5)} m/unit (bounds: source frame, mm; muzzle +Z, gun right -X)`);
for (const p of pieces) console.log(`${p.src.slice(0, 28).padEnd(28)} ${String(p.idx.length / 3).padStart(6)}  part ${String(p.role).padStart(2)} ${(p.label || '').padEnd(14)} min ${f(p.smin)}  max ${f(p.smax)}`);
