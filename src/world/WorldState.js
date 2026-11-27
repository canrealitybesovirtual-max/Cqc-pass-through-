// @ts-check
/**
 * A built WorldCore's state as transferable typed arrays plus a small
 * structured-clone-safe `meta` object, and the main thread's time-sliced copy
 * of it into the world's preallocated arrays (pure: no three.js, no DOM).
 *
 * The world worker builds its own WorldCore (same capacities), finishes the
 * Roam bake there, and `exportCore` copies what a query needs:
 * - nav grid arrays (the first `count` cells), its scalars;
 * - shape set boxes and flags (`count`), labels and floor / ceiling polygons;
 * - spawn candidates and the spawner's reset state;
 * - the Roam index (rooms, door graph, door fields, edge field in `nav.edge`);
 * - the layout, stats and build flags (meta);
 * - the mesh BVH, the occluder tiles and the static collider geometry
 *   (adopted on the main thread: no copy, the transferred buffers are used).
 * `CopyJob` then moves the arrays into the main thread's own (other modules
 * hold references to them: never replaced) in slices of `chunk` elements,
 * checking the clock between slices, and `commitCore` sets the scalars and
 * references in one step.
 *
 * Every array listed in ARRAYS must exist on both sides with at least the
 * exported length (the same capacities: `coreConfig` → the worker).
 */

/** [key, object path, property, length rule] — length: 'count' (nav cells), 'shapes', 'spawn', 'all', 'region', 'fields'. */
const ARRAYS = /** @type {const} */ ([
  ['nav.flags', 'nav', 'flags', 'count'], ['nav.clr', 'nav', 'clr', 'count'], ['nav.region', 'nav', 'region', 'count'],
  ['nav.pathDist', 'nav', 'pathDist', 'count'], ['nav.doors', 'nav', 'doors', 'count'], ['nav.floorIdx', 'nav', 'floorIdx', 'count'],
  ['nav.room', 'nav', 'room', 'count'], ['nav.edge', 'nav', 'edge', 'count'], ['nav.reach', 'nav', 'reach', 'region'],
  ['shapes.box', 'shapes', 'box', 'shapes8'], ['shapes.flags', 'shapes', 'flags', 'shapes'],
  ['spawn.x', 'spawner', 'x', 'spawn'], ['spawn.z', 'spawner', 'z', 'spawn'], ['spawn.cell', 'spawner', 'cell', 'spawn'],
  ['spawn.room', 'spawner', 'room', 'spawn'], ['spawn.path', 'spawner', 'path', 'spawn'], ['spawn.door', 'spawner', 'door', 'spawn'],
  ['spawn.pocket', 'spawner', 'pocket', 'spawn'], ['spawn.recent', 'spawner', 'recent', 'all'], ['spawn.finds', 'spawner', 'finds', 'all'],
  ['spawn.log', 'spawner', 'log', 'all'], ['spawn.lastRooms', 'spawner', 'lastRooms', 'all'],
  ['roam.roomCells', 'roamIndex', 'roomCells', 'all'], ['roam.roomCx', 'roamIndex', 'roomCx', 'all'], ['roam.roomCz', 'roamIndex', 'roomCz', 'all'],
  ['roam.roomFlags', 'roamIndex', 'roomFlags', 'all'], ['roam.doorX', 'roamIndex', 'doorX', 'all'], ['roam.doorZ', 'roamIndex', 'doorZ', 'all'],
  ['roam.doorHalf', 'roamIndex', 'doorHalf', 'all'], ['roam.doorRoomA', 'roamIndex', 'doorRoomA', 'all'], ['roam.doorRoomB', 'roamIndex', 'doorRoomB', 'all'],
  ['roam.doorExterior', 'roamIndex', 'doorExterior', 'all'], ['roam.doorField', 'roamIndex', 'doorField', 'all'],
  ['roam.roomDoorStart', 'roamIndex', 'roomDoorStart', 'all'], ['roam.roomDoorList', 'roamIndex', 'roomDoorList', 'all'],
  ['world.floorYs', '', 'floorYs', 'all'],
]);

const NAV_SCALARS = ['cell', 'inv', 'w', 'h', 'count', 'ox', 'oz', 'roomCount', 'edgeReady', 'agentClear', 'doorClear', 'walkableCount', 'regionCount', 'startCell'];
const SPAWN_SCALARS = ['count', 'doorCount', 'pocketCount', 'virtualFallback', 'skippedVirtual', 'roam', 'roomsWithCandidates', 'rng', 'recentHead',
  'failStreak', 'lastTier', 'lastX', 'lastZ', 'lastEvals', 'logHead', 'logCount'];
const ROAM_SCALARS = ['roomCount', 'doorCount', 'fieldSlots', 'fieldsDone', 'fieldsSkipped', 'task', 'phase', 'pos', 'door', 'built', 'edgeReady',
  'fieldsReady', 'bakeMs', 'bakeSlices', 'maxSliceMs', 'edgeCells'];
const WORLD_SCALARS = ['virtual', 'partialVirtual', 'floorY0', 'roamOn', 'coveredFurniture'];

/** @param {any} core @param {string} path */
const objOf = (core, path) => (path ? core[path] : core);

/**
 * @param {any} core @param {string} rule @param {ArrayLike<number>} arr
 */
function lengthOf(core, rule, arr) {
  switch (rule) {
    case 'count': return core.nav.count;
    case 'region': return Math.min(arr.length, core.nav.regionCount + 1);
    case 'shapes': return core.shapes.count;
    case 'shapes8': return core.shapes.count * 8;
    case 'spawn': return core.spawner.count;
    default: return arr.length;
  }
}

/**
 * @param {any} o @param {readonly string[]} keys
 */
function pick(o, keys) {
  /** @type {Record<string, any>} */ const out = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

/**
 * Copy a built core's state out (the worker; allocates).
 * @param {import('./WorldCore.js').WorldCore} core
 * @returns {{ meta: any, arrays: Record<string, ArrayBufferView>, adopt: any, transfer: ArrayBuffer[] }}
 */
export function exportCore(core) {
  const c = /** @type {any} */ (core);
  /** @type {Record<string, ArrayBufferView>} */ const arrays = {};
  /** @type {ArrayBuffer[]} */ const transfer = [];
  for (const [key, path, prop, rule] of ARRAYS) {
    const src = objOf(c, path)[prop];
    const n = lengthOf(c, rule, src);
    const a = src.slice(0, n);
    if (key === 'nav.edge' && !c.nav.edgeReady) a.fill(0); // no edge field this build: stale cells mean nothing
    arrays[key] = a;
    transfer.push(a.buffer);
  }
  const R = c.roamIndex, nav = c.nav;
  const fields = R.fields.slice(0, R.fieldSlots * nav.count);
  transfer.push(fields.buffer);
  /** @type {any} */ const adopt = { fields, bvh: null, tiles: null, statics: null, occ: null };
  if (c.bvh) {
    const b = c.bvh.toBuffers();
    adopt.bvh = b;
    transfer.push(b.box.buffer, b.node.buffer, b.tri.buffer, b.surf.buffer, b.owner.buffer);
  }
  if (c.meshTiles) {
    const t = c.meshTiles;
    adopt.tiles = t;
    pushBuffers(transfer, [t.tiles, t.tileBounds, t.tileIdx, t.occIdx, t.occPos]);
  }
  if (c.statics) {
    const g = c.statics;
    adopt.statics = g;
    pushBuffers(transfer, [g.slabs, g.prisms, g.prismSurf, g.tiles, g.tileBounds, g.localIndices, g.bounds, g.floorPts, g.floorOff, g.floorN]);
    if (g.mesh) pushBuffers(transfer, [g.mesh.vertices, g.mesh.indices, g.mesh.chunks, g.mesh.surf]);
  }
  const sh = c.shapes;
  const meta = {
    nav: pick(nav, NAV_SCALARS),
    shapes: { count: sh.count, floorY0: sh.floorY0, ceilingY: sh.ceilingY, dropped: sh.dropped, skipCovered: sh.skipCovered, coveredCount: sh.coveredCount,
      label: sh.label.slice(0, sh.count), floors: sh.floors, ceilings: sh.ceilings },
    spawn: pick(c.spawner, SPAWN_SCALARS),
    roam: pick(R, ROAM_SCALARS),
    world: { ...pick(c, WORLD_SCALARS), zone: { ...c.zone }, start: { ...c.start }, doorOpen: c.doorOpen.slice(), stats: c.stats, layout: c.layout,
      meshStats: c.meshStats },
  };
  return { meta, arrays, adopt, transfer };
}

/**
 * @param {ArrayBuffer[]} out @param {(ArrayBufferView|null|undefined)[]} views
 */
function pushBuffers(out, views) {
  for (const v of views) if (v && v.buffer && !out.includes(/** @type {ArrayBuffer} */ (v.buffer))) out.push(/** @type {ArrayBuffer} */ (v.buffer));
}

/**
 * The main thread's time-sliced copy of exported arrays into a core's own.
 * Allocation-free per step (the job list is made once, in `begin`).
 */
export class CopyJob {
  /** @param {number} [chunk] elements per slice */
  constructor(chunk = 16384) {
    this.chunk = chunk;
    /** @type {{ dst: any, src: any, n: number }[]} */ this.jobs = [];
    this.k = 0;
    this.pos = 0;
    this.bytes = 0;
    this.slices = 0;
  }

  /**
   * @param {any} core @param {Record<string, ArrayBufferView>} arrays
   * @returns {string|null} an error (a capacity mismatch) or null
   */
  begin(core, arrays) {
    this.jobs.length = 0;
    this.k = 0;
    this.pos = 0;
    this.bytes = 0;
    this.slices = 0;
    for (const [key, path, prop] of ARRAYS) {
      const src = /** @type {any} */ (arrays[key]);
      const dst = objOf(core, path)[prop];
      if (!src) return `world state: ${key} missing`;
      if (src.length > dst.length) return `world state: ${key} ${src.length} > capacity ${dst.length}`;
      this.jobs.push({ dst, src, n: src.length });
      this.bytes += src.byteLength;
    }
    return null;
  }

  get done() { return this.k >= this.jobs.length; }

  /**
   * Copy until `deadline` (clock ms), at least one slice.
   * @param {() => number} clock @param {number} deadline
   * @returns {boolean} done
   */
  step(clock, deadline) {
    const J = this.jobs;
    do {
      if (this.k >= J.length) return true;
      const j = J[this.k];
      const end = Math.min(j.n, this.pos + this.chunk);
      if (end > this.pos) j.dst.set(j.src.subarray(this.pos, end), this.pos);
      this.pos = end;
      if (end >= j.n) { this.k++; this.pos = 0; }
      this.slices++;
    } while (this.k < J.length && clock() < deadline);
    return this.k >= J.length;
  }
}

/**
 * Set the scalars and references (one step, after the copy).
 * @param {any} core @param {any} meta
 */
export function commitScalars(core, meta) {
  Object.assign(core.nav, meta.nav);
  const sh = core.shapes, m = meta.shapes;
  sh.count = m.count; sh.floorY0 = m.floorY0; sh.ceilingY = m.ceilingY; sh.dropped = m.dropped; sh.coveredCount = m.coveredCount;
  sh.setSkipCovered(m.skipCovered);
  for (let i = 0; i < m.count; i++) sh.label[i] = m.label[i];
  sh.floors = m.floors;
  sh.ceilings = m.ceilings;
  Object.assign(core.spawner, meta.spawn);
  core.spawner.rsActive = false;
  Object.assign(core.roamIndex, meta.roam);
  const w = meta.world;
  for (const k of WORLD_SCALARS) core[k] = w[k];
  core.zone.x = w.zone.x; core.zone.z = w.zone.z; core.zone.r = w.zone.r;
  core.start.x = w.start.x; core.start.z = w.start.z; core.start.r = w.start.r;
  core.doorOpen.length = 0;
  for (const d of w.doorOpen) core.doorOpen.push(d);
  core.stats = w.stats;
  core.layout = w.layout;
  core.meshStats = w.meshStats || null;
}
