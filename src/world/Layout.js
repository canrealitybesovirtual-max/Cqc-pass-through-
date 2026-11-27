// @ts-check
/**
 * SpaceSnapshot → world layout (pure; no three.js, no DOM). Runs once per
 * session at build time, so it may allocate.
 *
 * What it produces (all in the reference space, metres, +Y up):
 * - floors: cleaned CCW polygons with their own height (floors may differ by a
 *   few cm; Quest gives one polygon per Space Setup room, and one polygon can
 *   cover several real rooms);
 * - ceilings: polygons + one fallback height;
 * - walls: face segments with an inward normal, a height and door openings.
 *   Each wall is a 0.10 m slab placed BEHIND its face (PLAN §6.3), so the
 *   collision face matches the real wall. Which side is "behind" comes from, in
 *   order: the floor polygons (a wall on a floor edge faces that floor's
 *   interior: side 'edge'); sampling which side has floor ('sampled'); for a
 *   wall inside a floor polygon (one Quest floor can span several rooms, and
 *   both sides are floor), the player: if the player can see the wall from
 *   where they stand (2D sight line through other walls, door openings count),
 *   its face points at the player and the slab goes behind it ('player'), so
 *   a slab never sits in front of the surface the player sees (no floating
 *   decals, no enemy cut early). Walls the player cannot see keep the plane
 *   normal ('normal'), corrected by the convention the edge walls show
 *   ('learned': if most edge-wall normals pointed out of the room);
 * - inferred walls (PLAN §6.1 step 5): floor edges that no wall plane covers
 *   (within 12° and 0.3 m) get a wall marked `inferred`, floor to ceiling,
 *   except where the floor continues into another mapped floor (an open
 *   boundary between two Space Setup rooms) or an 'invisible wall face' plane
 *   says the side is open;
 * - doors: vertical door planes matched to every wall they overlap (angle ≤ 20°,
 *   ≤ 0.35 m off the wall, ≥ 50 % of their width on it), inferred walls
 *   included. Each door keeps its record (matched walls and offsets, width,
 *   bottom, walkable, which side has floor, where it leads) and an open flag
 *   (`opts.doorOpen[id]`, default open). An OPEN door cuts an opening in each
 *   matched wall (left/right pieces plus a lintel, and a sill if the door starts
 *   above the floor); a CLOSED door cuts nothing (the wall stays solid for
 *   bullets, sight and the occluder, and the nav grid is not carved);
 * - door pockets: an open walkable door that leads into unmapped space (mapped
 *   floor on one side only) gets a small virtual floor behind it (about
 *   1.8 × 2 m, floor `pocket`), so enemies can spawn out of sight and walk in
 *   through the real doorway;
 * - furniture: yaw-oriented boxes from labelled meshes (Space Setup volumes) and
 *   labelled horizontal planes (tops, extruded down to the floor). A plane that
 *   overlaps a mesh box by > 50 % is merged into it (PLAN §6.1).
 * - boxes: every solid shape (wall pieces first, then furniture), the single
 *   source for raycasts, line of sight, the occluder and the nav grid.
 *
 * No floor (or no snapshot) → a virtual open room centred on the player.
 * A real snapshot whose floors do not contain the player start gets a virtual
 * floor patch around the player, so enemies can still reach them.
 */

import { pointInPolygon } from '../util/geom2d.js';
import { cleanPolygon, convexOverlapArea, distSqToPolygon, rectCorners, rectFromPoints, signedArea } from './geom.js';

/** @typedef {{ version: number, space: string, planes: SnapPlane[], meshes: SnapMesh[], globalMesh?: any }} SpaceSnapshot */
/** @typedef {{ label: string|null, orientation: 'horizontal'|'vertical', pose: number[], polygon: number[][] }} SnapPlane */
/** @typedef {{ label: string|null, pose: number[], min: number[], max: number[], vertexCount: number }} SnapMesh */

/**
 * @typedef {{ id: number, pts: Float64Array, n: number, y: number, area: number, x0: number, x1: number, z0: number, z1: number,
 *   virtual: boolean, pocket: boolean, door: number }} Floor
 *   virtual: no Space Setup data there (the virtual room, the patch around a player off the map, or a door pocket);
 *   pocket: a door pocket (door = its door id, else -1).
 */
/** @typedef {{ pts: Float64Array, n: number, y: number, x0: number, x1: number, z0: number, z1: number }} Ceiling */
/** @typedef {{ u0: number, u1: number, y0: number, y1: number }} Opening */
/** @typedef {'edge'|'sampled'|'player'|'learned'|'normal'} WallSide */
/**
 * @typedef {{ id: number, ax: number, az: number, bx: number, bz: number, tx: number, tz: number, nx: number, nz: number,
 *   len: number, y0: number, y1: number, openings: Opening[], side: WallSide, flipped: boolean, inferred: boolean, centred?: boolean }} Wall
 *   (a→b is the face; n points into the room; the slab lies on the −n side, or centred on the face line when
 *   `centred`; flipped: n is the reverse of the plane normal)
 */
/**
 * @typedef {{ id: number, cx: number, cz: number, tx: number, tz: number, nx: number, nz: number, width: number,
 *   y0: number, y1: number, walls: number, wallIds: number[], offsets: number[], walkable: boolean, open: boolean,
 *   side: 'both'|'front'|'back'|'none', leadsTo: 'mapped'|'unmapped'|'virtual'|'none', pocket: number, passable: boolean, inZone: boolean }} Door
 *   n: the door plane's normal (front = +n); walls/wallIds: matched walls; offsets: door centre to each matched
 *   wall face along that wall's n (m, + = room side); walkable: the frame could pass a person (bottom near the
 *   floor, ≥ 1.5 m tall, ≥ 0.4 m wide); side: which sides of the plane have mapped floor; pocket: the pocket's floor
 *   index (-1 none); passable / inZone: set by WorldCore after the nav bake (an enemy fits through it, floor on
 *   both sides, the player zone ignored / the player zone (r + 1.2 m) covers part of its gap this session).
 */
/**
 * @typedef {{ cx: number, cz: number, c: number, s: number, hx: number, hz: number, y0: number, y1: number,
 *   label: string, kind: 'wall'|'furniture', face: number, jamb0: boolean, jamb1: boolean,
 *   lintel: boolean, sill: boolean, navBlock: boolean, source: string, wall: number, covered?: boolean }} Box
 *   face: for wall pieces, the local-z side (−1/+1) of the real wall face; 0 for furniture.
 *   jamb0/jamb1: the −x / +x end of a wall piece borders a door opening.
 *   source: 'wall' | 'inferred' for wall pieces; 'mesh' | 'plane' | 'mesh+plane' for furniture.
 *   wall: the wall id of a wall piece (-1 for furniture).
 *   covered: furniture the processed global mesh covers (MeshPrep): bullets, sight lines and the occluder use the
 *   mesh there, not the box (the nav grid and the safety cues keep the box).
 */
/**
 * @typedef {{ floors: Floor[], ceilings: Ceiling[], walls: Wall[], doors: Door[], boxes: Box[], furniture: Box[],
 *   floorRef: number, floorY0: number, ceilingY: number, virtual: boolean, partialVirtual: boolean,
 *   bounds: { x0: number, x1: number, z0: number, z1: number }, notes: string[],
 *   mappedFloors: number, inferredWalls: number, pockets: number }} Layout
 */
/**
 * @typedef {{ doorOpen?: ArrayLike<boolean|undefined|null>|null, defaultDoorOpen?: boolean, interiorSlab?: 'player'|'centred' }} LayoutOptions
 *   doorOpen[id]: false = that door is closed (ids = layout.doors order, the snapshot's door planes in order);
 *   missing/undefined = defaultDoorOpen (true: every door open, the first-test default).
 *   interiorSlab: where an interior wall's slab goes (a wall with floor on both sides, side 'normal' / 'learned'):
 *   'player' (default, stationary play): behind the face the player sees from the start; 'centred' (Roam: the
 *   player walks round to both sides): centred on the wall plane, ±WALL_T/2, so either face is at most 5 cm off
 *   the real surface whichever side the player stands on (the walls get `centred: true`, their boxes `face: 0`).
 */

/** Wall slab thickness behind the face (PLAN §6.3). */
export const WALL_T = 0.1;
/** Door ↔ wall matching. */
const DOOR_COS = Math.cos((20 * Math.PI) / 180);
const DOOR_DIST = 0.35;
/** Default ceiling height above the floor when Space Setup has none (PLAN §6.3). */
export const DEFAULT_CEILING = 2.4;
/** Virtual open room side, and the virtual patch around a player outside every floor. */
export const VIRTUAL_ROOM = 12;
export const VIRTUAL_PATCH = 8;
/** Furniture footprints larger than this are not furniture (mislabelled room meshes). */
const MAX_FURN_AREA = 15;
/** Boxes starting lower than this above the floor block walking (an enemy is ~1.8 m tall). */
const NAV_BLOCK_BELOW = 1.9;
/** A wall plane covers a floor edge when within 12° of it and both its ends ≤ 0.3 m off the edge line. */
const COVER_SIN = Math.sin((12 * Math.PI) / 180);
const COVER_DIST = 0.3;
/** Uncovered floor-edge runs shorter than this get no inferred wall (corner slivers). */
export const MIN_INFERRED = 0.15;
/** Probes beyond a floor edge: another mapped floor there = an open boundary, no inferred wall. */
const OPEN_PROBE_1 = 0.15, OPEN_PROBE_2 = 0.3;
/** Probes either side of a door plane for mapped floor. */
const SIDE_PROBE_1 = 0.45, SIDE_PROBE_2 = 0.9;
/** Door pocket: depth behind the door, half-width = max(door/2 + pad, min); a smaller try if it overlaps mapped floor. */
export const POCKET_DEPTH = 2.0;
const POCKET_PAD = 0.45, POCKET_MIN_HALF = 0.9;
const POCKET_DEPTH_SMALL = 1.4, POCKET_PAD_SMALL = 0.2, POCKET_MIN_HALF_SMALL = 0.7;

/**
 * Label → class. Unknown non-empty labels are treated as objects (furniture),
 * because every structural label is listed here.
 * @param {string|null} label
 * @returns {'floor'|'ceiling'|'wall'|'door'|'ignore'|'furniture'|null}
 */
export function classOf(label) {
  if (!label) return null;
  const l = label.toLowerCase().trim().replace(/[_-]+/g, ' ');
  switch (l) {
    case 'floor': return 'floor';
    case 'ceiling': return 'ceiling';
    case 'wall': case 'wall face': return 'wall';
    case 'door': case 'door frame': case 'doorframe': case 'opening': return 'door';
    case 'window': case 'window frame': case 'wall art': case 'invisible wall face': case 'global mesh':
    case 'mesh': case 'unknown':
      return 'ignore';
    default: return 'furniture';
  }
}

/** @param {string|null} label */
function surfaceName(label) {
  return label ? label.toLowerCase().trim().replace(/[_-]+/g, ' ') : 'other';
}

/**
 * @typedef {{ label: string|null, cls: ReturnType<typeof classOf>, horizontal: boolean, pose: number[],
 *   xs: Float64Array, ys: Float64Array, zs: Float64Array, n: number, y: number, area: number, flat: number[],
 *   nx: number, ny: number, nz: number }} WPlane
 */

/**
 * @param {SnapPlane} p
 * @returns {WPlane}
 */
function worldPlane(p) {
  const m = p.pose;
  const n = p.polygon.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  /** @type {number[]} */ const flat = [];
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const px = p.polygon[i][0], pz = p.polygon[i][1]; // plane space, y = 0
    xs[i] = m[0] * px + m[8] * pz + m[12];
    ys[i] = m[1] * px + m[9] * pz + m[13];
    zs[i] = m[2] * px + m[10] * pz + m[14];
    flat.push(xs[i], zs[i]);
    sy += ys[i];
  }
  const nl = Math.hypot(m[4], m[5], m[6]) || 1;
  const horizontal = p.orientation === 'horizontal';
  return {
    label: p.label, cls: classOf(p.label), horizontal, pose: m, xs, ys, zs, n, y: sy / n,
    area: horizontal ? Math.abs(signedArea(flat)) : 0, flat,
    nx: m[4] / nl, ny: m[5] / nl, nz: m[6] / nl,
  };
}

/**
 * @param {Floor[]} floors
 * @param {number} x @param {number} z
 */
function insideFloors(floors, x, z) {
  for (const f of floors) {
    if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 && pointInPolygon(f.pts, f.n, x, z)) return true;
  }
  return false;
}

/**
 * Height of the floor under (x, z): the containing floor, else the nearest one.
 * @param {Floor[]} floors
 * @param {number} fallback
 * @param {number} x @param {number} z
 */
export function floorHeightAt(floors, fallback, x, z) {
  let best = Infinity, y = fallback;
  for (const f of floors) {
    if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 && pointInPolygon(f.pts, f.n, x, z)) return f.y;
    const d = distSqToPolygon(f.pts, f.n, x, z);
    if (d < best) { best = d; y = f.y; }
  }
  return y;
}

/**
 * @param {number[]} flat cleaned CCW polygon
 * @param {number} y
 * @param {boolean} virtual
 * @returns {Floor}
 */
function makeFloor(flat, y, virtual) {
  const n = flat.length / 2;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = flat[2 * i], z = flat[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { id: -1, pts: Float64Array.from(flat), n, y, area: signedArea(flat), x0, x1, z0, z1, virtual, pocket: false, door: -1 };
}

/**
 * Inside any of the floors that pass `filter` (0 = all, 1 = mapped only, 2 = virtual only)?
 * @param {Floor[]} floors @param {number} x @param {number} z @param {number} filter
 * @param {Floor|null} [skip]
 */
function insideKind(floors, x, z, filter, skip = null) {
  for (const f of floors) {
    if (f === skip || (filter === 1 && f.virtual) || (filter === 2 && !f.virtual)) continue;
    if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 && pointInPolygon(f.pts, f.n, x, z)) return true;
  }
  return false;
}

/**
 * Ceiling height over (x, z), NaN when no ceiling polygon covers it.
 * @param {Ceiling[]} ceilings @param {number} x @param {number} z
 */
function ceilingAt(ceilings, x, z) {
  for (const c of ceilings) {
    if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1 && pointInPolygon(c.pts, c.n, x, z)) return c.y;
  }
  return NaN;
}

/**
 * @param {number} cx @param {number} cz @param {number} side @param {number} y
 */
function squareFloor(cx, cz, side, y) {
  const h = side / 2;
  return makeFloor([cx - h, cz - h, cx + h, cz - h, cx + h, cz + h, cx - h, cz + h], y, true);
}

/**
 * @param {SpaceSnapshot|null} snapshot already normalized (see normalizeSnapshot)
 * @param {{ x: number, z: number }} start player start (reference space)
 * @param {LayoutOptions} [opts]
 * @returns {Layout}
 */
export function buildLayout(snapshot, start, opts = {}) {
  /** @type {string[]} */ const notes = [];
  const planes = snapshot ? snapshot.planes.map(worldPlane) : [];
  const doorOpen = opts.doorOpen || null;
  const defaultOpen = opts.defaultDoorOpen !== false;

  // ---- Floors
  /** @type {WPlane[]} */ let floorPlanes = planes.filter((p) => p.horizontal && p.cls === 'floor');
  if (floorPlanes.length) {
    // Unlabelled planes at a labelled floor's height are floor too (labels may be null).
    for (const p of planes) {
      if (p.horizontal && p.cls === null && p.area >= 1 && floorPlanes.some((f) => Math.abs(f.y - p.y) < 0.08)) floorPlanes.push(p);
    }
  } else {
    const cands = planes.filter((p) => p.horizontal && p.cls === null && p.area >= 1);
    if (cands.length) {
      const low = Math.min(...cands.map((p) => p.y));
      floorPlanes = cands.filter((p) => p.y < low + 0.1);
      notes.push('floor from unlabelled planes');
    }
  }
  /** @type {Floor[]} */ const floors = [];
  for (const p of floorPlanes) {
    const flat = cleanPolygon(p.flat);
    if (flat.length < 6 || signedArea(flat) < 0.5) continue;
    addFloor(floors, makeFloor(flat, p.y, false));
  }

  if (!floors.length) {
    if (snapshot) notes.push(snapshot.planes.length ? 'no floor in Space Setup: virtual room' : 'no Space Setup data: virtual room');
    return virtualLayout(start, notes);
  }
  const mappedFloors = floors.length;

  const floorRef = Math.min(...floors.map((f) => f.y));
  let main = floors[0];
  for (const f of floors) if (f.area > main.area) main = f;
  const floorY0 = main.y;
  const fy = (/** @type {number} */ x, /** @type {number} */ z) => floorHeightAt(floors, floorRef, x, z);
  const used = new Set(floorPlanes);

  // ---- Ceilings
  /** @type {Ceiling[]} */ const ceilings = [];
  for (const p of planes) {
    if (!p.horizontal || used.has(p)) continue;
    const isCeil = p.cls === 'ceiling' || (p.cls === null && p.y > floorRef + 1.8 && p.area >= 1);
    if (!isCeil) continue;
    used.add(p);
    const flat = cleanPolygon(p.flat);
    if (flat.length < 6) continue;
    const f = makeFloor(flat, p.y, false);
    ceilings.push({ pts: f.pts, n: f.n, y: f.y, x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1 });
  }
  const ceilingY = ceilings.length ? Math.max(...ceilings.map((c) => c.y)) : floorRef + DEFAULT_CEILING;
  if (!ceilings.length) notes.push(`no ceiling: ${DEFAULT_CEILING} m assumed`);

  // ---- Walls (wall planes)
  /** @type {Wall[]} */ const walls = [];
  /** @type {{ ax: number, az: number, bx: number, bz: number }[]} */ const openSides = [];
  for (const p of planes) {
    if (p.horizontal || used.has(p)) continue;
    if (surfaceName(p.label) === 'invisible wall face') {
      // Space Setup's marker for an open side of a room: never infer a wall along it.
      const sp = planeSpan(p);
      if (sp) openSides.push(sp);
      continue;
    }
    let isWall = p.cls === 'wall';
    if (p.cls === null) {
      const y0 = Math.min(...p.ys), y1 = Math.max(...p.ys);
      isWall = y1 - y0 >= 1.5 && y0 < floorRef + 0.4;
    }
    if (!isWall) continue;
    const w = makeWall(p, floors, fy, walls.length);
    if (w) { walls.push(w); used.add(p); }
  }
  // Walls we could not resolve from the floors follow the normal convention the resolved ones show.
  const resolved = walls.filter((x) => x.side !== 'normal');
  if (resolved.length >= 2 && 2 * resolved.filter((x) => x.flipped).length > resolved.length) {
    for (const x of walls) if (x.side === 'normal') { flipWall(x); x.side = 'learned'; }
    notes.push('wall normals point out of the rooms: interior walls flipped to match');
  }

  // ---- Inferred walls on floor edges no wall plane covers (PLAN §6.1 step 5)
  const inferredWalls = inferWalls(floors, walls, openSides, ceilings, ceilingY, notes);

  // ---- Doors (vertical door planes overlapping walls); open ones cut openings
  /** @type {Door[]} */ const doors = [];
  for (const p of planes) {
    if (p.horizontal || used.has(p) || p.cls !== 'door') continue;
    used.add(p);
    const d = makeDoor(p, fy, doors.length);
    if (!d) continue;
    const flag = doorOpen && d.id < doorOpen.length ? doorOpen[d.id] : undefined;
    d.open = flag === undefined || flag === null ? defaultOpen : !!flag;
    for (const w of walls) {
      if (Math.abs(d.nx * w.nx + d.nz * w.nz) < DOOR_COS) continue;
      if (Math.abs((d.cx - w.ax) * w.nx + (d.cz - w.az) * w.nz) > DOOR_DIST) continue;
      const h = d.width / 2;
      const p0 = (d.cx - d.tx * h - w.ax) * w.tx + (d.cz - d.tz * h - w.az) * w.tz;
      const p1 = (d.cx + d.tx * h - w.ax) * w.tx + (d.cz + d.tz * h - w.az) * w.tz;
      const lo = Math.max(0, Math.min(p0, p1)), hi = Math.min(w.len, Math.max(p0, p1));
      if (hi - lo < 0.5 * d.width) continue;
      if (d.open) w.openings.push({ u0: lo, u1: hi, y0: d.y0, y1: d.y1 });
      d.walls++;
      d.wallIds.push(w.id);
    }
    doors.push(d);
  }
  const closed = doors.filter((d) => !d.open).length;
  if (closed) notes.push(`${closed} door(s) closed: not carved, wall solid`);

  // ---- Interior walls (no floor edge, floor on both sides): the face the player sees is the face,
  // or (Roam: the player walks round them) the slab is centred on the plane
  if (opts.interiorSlab === 'centred') {
    let nc = 0;
    for (const w of walls) {
      if (w.inferred || (w.side !== 'normal' && w.side !== 'learned')) continue;
      w.centred = true;
      nc++;
    }
    if (nc) notes.push(`${nc} interior wall(s) with a centred slab (Roam)`);
  } else {
    const byPlayer = resolveFromPlayer(walls, start.x, start.z);
    if (byPlayer) notes.push(`${byPlayer} interior wall(s) faced to the player`);
  }
  for (const w of walls) mergeOpenings(w);
  for (const d of doors) {
    for (const id of d.wallIds) {
      const w = walls[id];
      d.offsets.push((d.cx - w.ax) * w.nx + (d.cz - w.az) * w.nz);
    }
  }

  // ---- Solid boxes: wall pieces
  /** @type {Box[]} */ const boxes = [];
  for (const w of walls) wallPieces(w, boxes);

  // ---- Furniture
  const furniture = makeFurniture(planes, used, snapshot ? snapshot.meshes : [], fy, notes);
  for (const b of furniture) boxes.push(b);

  // ---- Player outside every mapped floor: virtual patch so enemies can reach them.
  let partialVirtual = false;
  const sx = start.x, sz = start.z;
  if (!insideFloors(floors, sx, sz) && Math.min(...floors.map((f) => distSqToPolygon(f.pts, f.n, sx, sz))) > 0.3 * 0.3) {
    addFloor(floors, squareFloor(sx, sz, VIRTUAL_PATCH, fy(sx, sz)));
    partialVirtual = true;
    notes.push('player outside the mapped floor: virtual floor patch added');
  }

  // ---- Where each door leads; pockets behind open doors into unmapped space
  for (const d of doors) doorSides(d, floors);
  let pockets = 0;
  for (const d of doors) {
    if (d.leadsTo !== 'unmapped' || !d.open || !d.walkable || d.walls === 0) continue;
    const pf = makePocket(d, walls, floors, fy(d.cx, d.cz));
    if (!pf) { notes.push(`door ${d.id}: no room for a spawn pocket behind it`); continue; }
    d.pocket = addFloor(floors, pf);
    pockets++;
  }
  if (pockets) notes.push(`${pockets} spawn pocket(s) behind doors into unmapped space`);

  // ---- Bounds (floors and pockets, plus door surroundings that reach past them)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const f of floors) {
    x0 = Math.min(x0, f.x0); x1 = Math.max(x1, f.x1); z0 = Math.min(z0, f.z0); z1 = Math.max(z1, f.z1);
  }
  for (const d of doors) {
    const r = d.width / 2 + 0.5;
    x0 = Math.min(x0, d.cx - r); x1 = Math.max(x1, d.cx + r); z0 = Math.min(z0, d.cz - r); z1 = Math.max(z1, d.cz + r);
  }

  return {
    floors, ceilings, walls, doors, boxes, furniture, floorRef, floorY0, ceilingY,
    virtual: false, partialVirtual, bounds: { x0, x1, z0, z1 }, notes,
    mappedFloors, inferredWalls, pockets,
  };
}

/**
 * @param {{ x: number, z: number }} start
 * @param {string[]} notes
 * @returns {Layout}
 */
function virtualLayout(start, notes) {
  const f = squareFloor(start.x, start.z, VIRTUAL_ROOM, 0);
  f.id = 0;
  return {
    floors: [f], ceilings: [], walls: [], doors: [], boxes: [], furniture: [],
    floorRef: 0, floorY0: 0, ceilingY: NaN, virtual: true, partialVirtual: false,
    bounds: { x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1 }, notes,
    mappedFloors: 0, inferredWalls: 0, pockets: 0,
  };
}

/** @param {Floor[]} floors @param {Floor} f @returns {number} its id */
function addFloor(floors, f) {
  f.id = floors.length;
  floors.push(f);
  return f.id;
}

/**
 * Horizontal extent of a vertical plane as a segment.
 * @param {WPlane} p
 * @returns {{ ax: number, az: number, bx: number, bz: number }|null}
 */
function planeSpan(p) {
  const hl = Math.hypot(p.nx, p.nz);
  if (hl < 0.7) return null;
  const tx = -p.nz / hl, tz = p.nx / hl;
  const ox = p.pose[12], oz = p.pose[14];
  let u0 = Infinity, u1 = -Infinity;
  for (let i = 0; i < p.n; i++) {
    const u = (p.xs[i] - ox) * tx + (p.zs[i] - oz) * tz;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
  }
  if (!(u1 - u0 > 0.05)) return null;
  return { ax: ox + tx * u0, az: oz + tz * u0, bx: ox + tx * u1, bz: oz + tz * u1 };
}

/**
 * PLAN §6.1 step 5: every mapped floor edge (or part of one) that no wall plane
 * covers becomes a wall marked `inferred`: its face on the edge, facing the
 * floor, floor to ceiling. Parts where the floor continues into another mapped
 * floor (an open boundary between two Space Setup rooms) or that an 'invisible
 * wall face' plane covers stay open.
 * @param {Floor[]} floors mapped floors only (called before any virtual floor is added)
 * @param {Wall[]} walls wall-plane walls; inferred ones are appended
 * @param {{ ax: number, az: number, bx: number, bz: number }[]} openSides
 * @param {Ceiling[]} ceilings
 * @param {number} ceilingY
 * @param {string[]} notes
 * @returns {number} walls added
 */
function inferWalls(floors, walls, openSides, ceilings, ceilingY, notes) {
  /** @type {number[]} */ const cover = [];
  for (const w of walls) cover.push(w.ax, w.az, w.bx, w.bz);
  for (const o of openSides) cover.push(o.ax, o.az, o.bx, o.bz);
  let added = 0, open = 0;
  for (const f of floors) {
    for (let i = 0, j = f.n - 1; i < f.n; j = i++) {
      const x0 = f.pts[2 * j], z0 = f.pts[2 * j + 1], x1 = f.pts[2 * i], z1 = f.pts[2 * i + 1];
      const el = Math.hypot(x1 - x0, z1 - z0);
      if (el < MIN_INFERRED) continue;
      const ex = (x1 - x0) / el, ez = (z1 - z0) / el;
      /** @type {number[]} */ const cov = [];
      for (let k = 0; k < cover.length; k += 4) {
        const ax = cover[k], az = cover[k + 1], bx = cover[k + 2], bz = cover[k + 3];
        const sl = Math.hypot(bx - ax, bz - az);
        if (sl < 1e-6 || Math.abs(ex * (bz - az) - ez * (bx - ax)) / sl > COVER_SIN) continue;
        if (Math.abs((ax - x0) * -ez + (az - z0) * ex) > COVER_DIST || Math.abs((bx - x0) * -ez + (bz - z0) * ex) > COVER_DIST) continue;
        const ua = (ax - x0) * ex + (az - z0) * ez, ub = (bx - x0) * ex + (bz - z0) * ez;
        const lo = Math.max(0, Math.min(ua, ub)), hi = Math.min(el, Math.max(ua, ub));
        if (hi > lo) cov.push(lo, hi);
      }
      // Uncovered gaps along the edge.
      /** @type {number[][]} */ const ivs = [];
      for (let k = 0; k < cov.length; k += 2) ivs.push([cov[k], cov[k + 1]]);
      ivs.sort((a, b) => a[0] - b[0]);
      /** @type {number[]} */ const gaps = [];
      let cur = 0;
      for (const [lo, hi] of ivs) {
        if (lo > cur) gaps.push(cur, lo);
        if (hi > cur) cur = hi;
      }
      if (cur < el) gaps.push(cur, el);
      for (let k = 0; k < gaps.length; k += 2) {
        const g0 = gaps[k], g1 = gaps[k + 1];
        if (g1 - g0 < MIN_INFERRED) continue;
        // Split the gap into closed runs (no other mapped floor just beyond the edge).
        const ns = Math.max(1, Math.ceil((g1 - g0) / 0.1));
        let run0 = -1;
        for (let s = 0; s <= ns; s++) {
          let closedHere = false;
          if (s < ns) {
            const u = g0 + ((s + 0.5) / ns) * (g1 - g0);
            const px = x0 + ex * u, pz = z0 + ez * u;
            const ox = ez, oz = -ex; // outward (CCW floor: interior on the left)
            closedHere = !insideKind(floors, px + ox * OPEN_PROBE_1, pz + oz * OPEN_PROBE_1, 1, f)
              && !insideKind(floors, px + ox * OPEN_PROBE_2, pz + oz * OPEN_PROBE_2, 1, f);
          }
          if (closedHere && run0 < 0) run0 = s;
          if (!closedHere && run0 >= 0) {
            const r0 = g0 + (run0 / ns) * (g1 - g0), r1 = g0 + (s / ns) * (g1 - g0);
            if (r1 - r0 >= MIN_INFERRED) {
              const ax = x0 + ex * r0, az = z0 + ez * r0, bx = x0 + ex * r1, bz = z0 + ez * r1;
              const nx = -ez, nz = ex;
              let y1 = ceilingAt(ceilings, (ax + bx) / 2 + nx * 0.3, (az + bz) / 2 + nz * 0.3);
              if (!(y1 === y1)) y1 = ceilings.length ? ceilingY : f.y + DEFAULT_CEILING;
              walls.push({
                id: walls.length, ax, az, bx, bz, tx: ex, tz: ez, nx, nz, len: r1 - r0, y0: f.y, y1,
                openings: [], side: 'edge', flipped: false, inferred: true,
              });
              added++;
            }
            run0 = -1;
          }
          if (!closedHere && s < ns) open++;
        }
      }
    }
  }
  if (added) notes.push(`${added} inferred wall(s) on floor edges without a wall plane`);
  if (open) notes.push(`floor edges left open where another floor continues (${(open * 0.1).toFixed(1)} m approx.)`);
  return added;
}

/**
 * A wall the floors could not place (side 'normal' or 'learned': floor on both
 * sides) that the player can see from the start: its face is turned to the
 * player, so the slab goes BEHIND the surface the player looks at.
 * @param {Wall[]} walls
 * @param {number} sx @param {number} sz player start
 * @returns {number} walls set to side 'player'
 */
function resolveFromPlayer(walls, sx, sz) {
  let n = 0;
  for (const w of walls) {
    if (w.inferred || (w.side !== 'normal' && w.side !== 'learned')) continue;
    const dp = (sx - w.ax) * w.nx + (sz - w.az) * w.nz;
    if (Math.abs(dp) < 0.05 || !seenFrom(walls, w, sx, sz)) continue;
    if (dp < 0) flipWall(w);
    w.side = 'player';
    n++;
  }
  return n;
}

/**
 * Is any of 9 points along `w` in 2D sight of (sx, sz)? Other walls block,
 * except inside their (open) door openings.
 * @param {Wall[]} walls @param {Wall} w @param {number} sx @param {number} sz
 */
function seenFrom(walls, w, sx, sz) {
  for (let k = 0; k < 9; k++) {
    const t = (k + 0.5) / 9;
    let px = w.ax + (w.bx - w.ax) * t, pz = w.az + (w.bz - w.az) * t;
    const dx = sx - px, dz = sz - pz, dl = Math.hypot(dx, dz);
    if (dl < 0.05) continue;
    px += (dx / dl) * 0.03;
    pz += (dz / dl) * 0.03;
    let blocked = false;
    for (const v of walls) {
      if (v !== w && crossesSolid(v, sx, sz, px, pz)) { blocked = true; break; }
    }
    if (!blocked) return true;
  }
  return false;
}

/**
 * Does segment a→b cross wall v's face line outside its openings?
 * @param {Wall} v @param {number} ax @param {number} az @param {number} bx @param {number} bz
 */
function crossesSolid(v, ax, az, bx, bz) {
  const rx = bx - ax, rz = bz - az, qx = v.bx - v.ax, qz = v.bz - v.az;
  const den = rx * qz - rz * qx;
  if (den > -1e-12 && den < 1e-12) return false;
  const wx = v.ax - ax, wz = v.az - az;
  const t = (wx * qz - wz * qx) / den, u = (wx * rz - wz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  const uu = u * v.len;
  for (const o of v.openings) if (uu > o.u0 && uu < o.u1) return false;
  return true;
}

/**
 * Which sides of a door plane have floor, and where the door leads.
 * @param {Door} d @param {Floor[]} floors
 */
function doorSides(d, floors) {
  /** @param {number} sg 2 = mapped floor, 1 = virtual floor, 0 = none */
  const probe = (sg) => {
    let v = 0;
    for (const r of [SIDE_PROBE_1, SIDE_PROBE_2]) {
      const x = d.cx + d.nx * r * sg, z = d.cz + d.nz * r * sg;
      if (insideKind(floors, x, z, 1)) return 2;
      if (insideKind(floors, x, z, 2)) v = 1;
    }
    return v;
  };
  const f = probe(1), b = probe(-1);
  d.side = f === 2 && b === 2 ? 'both' : f === 2 ? 'front' : b === 2 ? 'back' : 'none';
  d.leadsTo = f === 2 && b === 2 ? 'mapped' : f + b === 3 ? 'virtual' : f === 2 || b === 2 ? 'unmapped' : 'none';
}

/**
 * A small virtual floor behind a door into unmapped space (the side without
 * mapped floor), starting at the far face of the wall it is cut into. Tries a
 * smaller pocket if the first one would overlap mapped floor; null if both do.
 * @param {Door} d @param {Wall[]} walls @param {Floor[]} floors @param {number} y
 * @returns {Floor|null}
 */
function makePocket(d, walls, floors, y) {
  const sg = d.side === 'front' ? -1 : 1; // toward the side without floor
  const ox = d.nx * sg, oz = d.nz * sg;
  // Start at the door plane, or at a matched wall face that lies farther out.
  let near = 0.03;
  for (let k = 0; k < d.wallIds.length; k++) {
    const w = walls[d.wallIds[k]];
    const faceOut = -d.offsets[k] * (w.nx * ox + w.nz * oz);
    if (faceOut > near) near = faceOut;
  }
  near = Math.min(near, 0.4);
  for (const [depth, pad, minHalf] of [[POCKET_DEPTH, POCKET_PAD, POCKET_MIN_HALF], [POCKET_DEPTH_SMALL, POCKET_PAD_SMALL, POCKET_MIN_HALF_SMALL]]) {
    const hw = Math.max(d.width / 2 + pad, minHalf);
    let hitsMapped = false;
    for (let a = 0; a <= 4 && !hitsMapped; a++) {
      for (let b = 0; b <= 4; b++) {
        const u = -hw + (2 * hw * a) / 4, v = near + 0.05 + ((depth - 0.05) * b) / 4;
        if (insideKind(floors, d.cx + d.tx * u + ox * v, d.cz + d.tz * u + oz * v, 1)) { hitsMapped = true; break; }
      }
    }
    if (hitsMapped) continue;
    /** @type {number[]} */ const flat = [];
    for (const [u, v] of [[-hw, near], [hw, near], [hw, near + depth], [-hw, near + depth]]) {
      flat.push(d.cx + d.tx * u + ox * v, d.cz + d.tz * u + oz * v);
    }
    if (signedArea(flat) < 0) {
      for (let i = 0; i < 2; i++) {
        const j = 3 - i;
        const tx = flat[2 * i], tz = flat[2 * i + 1];
        flat[2 * i] = flat[2 * j]; flat[2 * i + 1] = flat[2 * j + 1];
        flat[2 * j] = tx; flat[2 * j + 1] = tz;
      }
    }
    const f = makeFloor(flat, y, true);
    f.pocket = true;
    f.door = d.id;
    return f;
  }
  return null;
}

/**
 * @param {WPlane} p
 * @param {Floor[]} floors
 * @param {(x: number, z: number) => number} fy
 * @param {number} id
 * @returns {Wall|null}
 */
function makeWall(p, floors, fy, id) {
  let nx = p.nx, nz = p.nz;
  const hl = Math.hypot(nx, nz);
  if (hl < 0.7) return null; // tilted, not a wall
  nx /= hl; nz /= hl;
  let tx = -nz, tz = nx;
  const ox = p.pose[12], oz = p.pose[14];
  let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.n; i++) {
    const u = (p.xs[i] - ox) * tx + (p.zs[i] - oz) * tz;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (p.ys[i] < y0) y0 = p.ys[i];
    if (p.ys[i] > y1) y1 = p.ys[i];
  }
  const len = u1 - u0;
  if (len < 0.1 || y1 - y0 < 0.3) return null;
  let ax = ox + tx * u0, az = oz + tz * u0, bx = ox + tx * u1, bz = oz + tz * u1;

  // Which side is the room? 1) a floor edge under this wall, 2) floor coverage, 3) the normal.
  /** @type {WallSide} */ let side = 'normal';
  let flip = false;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  let bestD = 0.15;
  for (const f of floors) {
    for (let i = 0, j = f.n - 1; i < f.n; j = i++) {
      const ex0 = f.pts[2 * j], ez0 = f.pts[2 * j + 1], ex1 = f.pts[2 * i], ez1 = f.pts[2 * i + 1];
      const el = Math.hypot(ex1 - ex0, ez1 - ez0);
      if (el < 0.05) continue;
      const ex = (ex1 - ex0) / el, ez = (ez1 - ez0) / el;
      if (Math.abs(ex * nx + ez * nz) > 0.14) continue; // not parallel (> 8°)
      const d = Math.abs((mx - ex0) * -ez + (mz - ez0) * ex);
      if (d >= bestD) continue;
      const pa = (ax - ex0) * ex + (az - ez0) * ez, pb = (bx - ex0) * ex + (bz - ez0) * ez;
      const ov = Math.min(el, Math.max(pa, pb)) - Math.max(0, Math.min(pa, pb));
      if (ov < 0.3 * Math.min(el, len)) continue;
      bestD = d;
      side = 'edge';
      flip = -ez * nx + ex * nz < 0; // CCW floor: interior is left of the edge, along (-ez, ex)
    }
  }
  if (side === 'normal') {
    let front = 0, back = 0;
    for (let k = 0; k < 5; k++) {
      const t = (k + 0.5) / 5;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      if (insideFloors(floors, px + nx * 0.25, pz + nz * 0.25)) front++;
      if (insideFloors(floors, px - nx * 0.25, pz - nz * 0.25)) back++;
    }
    if (front !== back && (front === 0 || back === 0 || Math.max(front, back) >= 2 * Math.min(front, back))) {
      side = 'sampled';
      flip = back > front;
    }
  }
  if (flip) {
    nx = -nx; nz = -nz;
    const t1 = ax; ax = bx; bx = t1;
    const t2 = az; az = bz; bz = t2;
  }
  tx = (bx - ax) / len; tz = (bz - az) / len;
  const f0 = fy(mx + nx * 0.25, mz + nz * 0.25);
  if (y0 < f0 + 0.3) y0 = Math.min(y0, f0);
  return { id, ax, az, bx, bz, tx, tz, nx, nz, len, y0, y1, openings: [], side, flipped: flip, inferred: false };
}

/**
 * @param {WPlane} p
 * @param {(x: number, z: number) => number} fy
 * @param {number} id
 * @returns {Door|null}
 */
function makeDoor(p, fy, id) {
  let nx = p.nx, nz = p.nz;
  const hl = Math.hypot(nx, nz);
  if (hl < 0.7) return null;
  nx /= hl; nz /= hl;
  const tx = -nz, tz = nx;
  const ox = p.pose[12], oz = p.pose[14];
  let u0 = Infinity, u1 = -Infinity, v = 0, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.n; i++) {
    const u = (p.xs[i] - ox) * tx + (p.zs[i] - oz) * tz;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    v += (p.xs[i] - ox) * nx + (p.zs[i] - oz) * nz;
    if (p.ys[i] < y0) y0 = p.ys[i];
    if (p.ys[i] > y1) y1 = p.ys[i];
  }
  v /= p.n;
  const width = u1 - u0;
  if (width < 0.2 || y1 - y0 < 0.5) return null;
  const um = (u0 + u1) / 2;
  const cx = ox + tx * um + nx * v, cz = oz + tz * um + nz * v;
  const f = fy(cx, cz);
  if (y0 < f + 0.3) y0 = Math.min(y0, f);
  const walkable = y0 < f + 0.25 && y1 - y0 >= 1.5 && width >= 0.4;
  return {
    id, cx, cz, tx, tz, nx, nz, width, y0, y1, walls: 0, wallIds: [], offsets: [], walkable, open: true,
    side: 'none', leadsTo: 'none', pocket: -1, passable: false, inZone: false,
  };
}

/**
 * Swap a wall's face direction (the slab moves to the other side of the face).
 * Openings are mirrored (they are measured from a).
 * @param {Wall} w
 */
function flipWall(w) {
  const ax = w.ax, az = w.az;
  w.ax = w.bx; w.az = w.bz; w.bx = ax; w.bz = az;
  w.nx = -w.nx; w.nz = -w.nz; w.tx = -w.tx; w.tz = -w.tz;
  w.flipped = !w.flipped;
  for (const o of w.openings) {
    const u0 = o.u0;
    o.u0 = w.len - o.u1;
    o.u1 = w.len - u0;
  }
}

/** @param {Wall} w */
function mergeOpenings(w) {
  const o = w.openings.sort((a, b) => a.u0 - b.u0);
  /** @type {Opening[]} */ const out = [];
  for (const q of o) {
    const last = out[out.length - 1];
    if (last && q.u0 <= last.u1 + 0.02) {
      last.u1 = Math.max(last.u1, q.u1);
      last.y0 = Math.min(last.y0, q.y0);
      last.y1 = Math.max(last.y1, q.y1);
    } else out.push({ ...q });
  }
  w.openings = out;
}

/**
 * Split a wall around its openings into solid slabs behind the face.
 * @param {Wall} w
 * @param {Box[]} out
 */
function wallPieces(w, out) {
  const c = w.tx, s = w.tz; // axis 1 along the wall; axis 2 = (-s, c) = -n (into the slab)
  const hz = WALL_T / 2;
  const off = w.centred ? 0 : hz; // slab centre behind the face (or on it)
  /**
   * @param {number} ua @param {number} ub @param {number} y0 @param {number} y1
   * @param {boolean} j0 @param {boolean} j1 @param {boolean} lintel @param {boolean} sill
   */
  const piece = (ua, ub, y0, y1, j0, j1, lintel, sill) => {
    if (ub - ua < 0.01 || y1 - y0 < 0.01) return;
    const um = (ua + ub) / 2;
    out.push({
      cx: w.ax + c * um - w.nx * off, cz: w.az + s * um - w.nz * off, c, s,
      hx: (ub - ua) / 2, hz, y0, y1, label: 'wall', kind: 'wall', face: w.centred ? 0 : -1,
      jamb0: j0, jamb1: j1, lintel, sill, navBlock: false, source: w.inferred ? 'inferred' : 'wall', wall: w.id,
    });
  };
  let cur = 0, prevJamb = false;
  for (const o of w.openings) {
    piece(cur, o.u0, w.y0, w.y1, prevJamb, true, false, false);
    if (w.y1 - o.y1 > 0.02) piece(o.u0, o.u1, o.y1, w.y1, false, false, true, false);
    if (o.y0 - w.y0 > 0.05) piece(o.u0, o.u1, w.y0, o.y0, false, false, false, true);
    cur = o.u1;
    prevJamb = true;
  }
  piece(cur, w.len, w.y0, w.y1, prevJamb, false, false, false);
}

/**
 * @param {WPlane[]} planes
 * @param {Set<WPlane>} used
 * @param {SnapMesh[]} meshes
 * @param {(x: number, z: number) => number} fy
 * @param {string[]} notes
 * @returns {Box[]}
 */
function makeFurniture(planes, used, meshes, fy, notes) {
  /** @type {(Box & { area: number, corners: number[] })[]} */ const fromMesh = [];
  /** @type {(Box & { area: number, corners: number[] })[]} */ const fromPlane = [];
  const xs = new Float64Array(8), zs = new Float64Array(8);

  for (const m of meshes) {
    const cls = classOf(m.label);
    if (cls !== 'furniture' && cls !== null) continue;
    const P = m.pose;
    let y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const lx = k & 1 ? m.max[0] : m.min[0], ly = k & 2 ? m.max[1] : m.min[1], lz = k & 4 ? m.max[2] : m.min[2];
      xs[k] = P[0] * lx + P[4] * ly + P[8] * lz + P[12];
      const y = P[1] * lx + P[5] * ly + P[9] * lz + P[13];
      zs[k] = P[2] * lx + P[6] * ly + P[10] * lz + P[14];
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const r = rectFromPoints(xs, zs, 8);
    const area = 4 * r.hx * r.hz;
    if (area > MAX_FURN_AREA || area < 0.01 || y1 - y0 < 0.05) continue;
    if (cls === null && (y1 - y0 > 2.6 || y1 - y0 < 0.1)) continue;
    fromMesh.push(furnBox(r, y0, y1, m.label, 'mesh', fy, area));
  }

  for (const p of planes) {
    if (!p.horizontal || used.has(p)) continue;
    if (p.cls !== 'furniture' && p.cls !== null) continue;
    if (p.area < 0.02 || p.area > MAX_FURN_AREA) continue;
    const r = rectFromPoints(p.xs, p.zs, p.n);
    const f = fy(r.cx, r.cz);
    if (p.y < f + 0.08 || p.y > f + 2.2) continue; // rugs, or above head height
    fromPlane.push(furnBox(r, -Infinity, p.y, p.label, 'plane', fy, 4 * r.hx * r.hz));
  }

  // Planes on top of a mesh box are the same object (PLAN §6.1: IoU > 0.5 → merge).
  /** @type {(Box & { area: number, corners: number[] })[]} */ const planeOnly = [];
  for (const pb of fromPlane) {
    let merged = false;
    for (const mb of fromMesh) {
      const ov = convexOverlapArea(pb.corners, mb.corners);
      if (ov > 0.5 * Math.min(pb.area, mb.area)) {
        if (pb.y1 > mb.y1) mb.y1 = pb.y1;
        if (mb.label === 'other' && pb.label !== 'other') mb.label = pb.label;
        mb.source = 'mesh+plane';
        merged = true;
        break;
      }
    }
    if (merged) continue;
    // Shelves report one plane per level: overlapping plane boxes are one object.
    for (const q of planeOnly) {
      const ov = convexOverlapArea(pb.corners, q.corners);
      if (ov > 0.5 * Math.min(pb.area, q.area)) {
        if (pb.area > q.area) { q.cx = pb.cx; q.cz = pb.cz; q.c = pb.c; q.s = pb.s; q.hx = pb.hx; q.hz = pb.hz; q.area = pb.area; q.corners = pb.corners; }
        q.y1 = Math.max(q.y1, pb.y1);
        merged = true;
        break;
      }
    }
    if (!merged) planeOnly.push(pb);
  }
  if (planeOnly.length) notes.push(`${planeOnly.length} object(s) from planes only`);
  const all = fromMesh.concat(planeOnly);
  for (const b of all) b.navBlock = b.y0 < fy(b.cx, b.cz) + NAV_BLOCK_BELOW;
  return all.map(({ area, corners, ...b }) => b);
}

/**
 * @param {import('./geom.js').Rect} r
 * @param {number} y0 bottom (−Infinity = down to the floor)
 * @param {number} y1 top
 * @param {string|null} label
 * @param {string} source
 * @param {(x: number, z: number) => number} fy
 * @param {number} area
 */
function furnBox(r, y0, y1, label, source, fy, area) {
  const f = fy(r.cx, r.cz);
  if (y0 < f + 0.25) y0 = f; // resting on the floor (or a small gap): extend down to it
  return {
    cx: r.cx, cz: r.cz, c: r.c, s: r.s, hx: r.hx, hz: r.hz, y0, y1, label: surfaceName(label), kind: /** @type {'furniture'} */ ('furniture'),
    face: 0, jamb0: false, jamb1: false, lintel: false, sill: false, navBlock: true, source, wall: -1, area, corners: rectCorners(r),
  };
}
