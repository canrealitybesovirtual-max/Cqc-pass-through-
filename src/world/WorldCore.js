// @ts-check
/**
 * The world without three.js (pure, so Node tests cover all of it): layout,
 * analytic shapes, nav grid and spawn finder. `World.js` adds the occluder mesh.
 *
 * Built once per session (behind the "Get ready" panel) from a SpaceSnapshot;
 * never rebuilt during play. Every query after build is allocation-free.
 */

import { WALL_T, buildLayout, floorHeightAt } from './Layout.js';
import { NAV_DOOR, NAV_FURN, NAV_INSIDE, NAV_OBST, NAV_POCKET, NAV_VIRTUAL, NAV_WALK, NAV_WALL, NAV_ZONE, NavGrid } from './NavGrid.js';
import { PathPlanner } from './PathPlanner.js';
import { ShapeSet } from './Shapes.js';
import { normalizeSnapshot } from './Snapshot.js';
import { SnapshotBuilder } from './SnapshotBuilder.js';
import { SpawnFinder } from './Spawner.js';
import { pointInPolygon } from '../util/geom2d.js';

/** Enemy radius 0.25 m + 0.03 m (PLAN §9). */
export const AGENT_CLEARANCE = 0.28;
/** Clearance needed inside a carved door gap: a 0.6 m frame passes (PLAN §6.2 warns below 0.62 m). */
export const DOOR_CLEARANCE = 0.24;
/** Furniture footprints block walking out to +0.25 m (CONTRACTS). */
export const FURN_INFLATE = 0.25;
/** The player zone blocks walking out to r + 1.2 m (CONTRACTS). */
export const ZONE_EXTRA = 1.2;
export const DEFAULT_ZONE_R = 0.8;
/** Grid margin around the floors (PLAN §9), and how far a door gap is carved either side of the door plane. */
const NAV_MARGIN = 0.5;
const DOOR_DEPTH = 0.35;
/** Wall pieces starting lower than this above the floor block walking (lintels do not). */
const WALL_BLOCK_BELOW = 1.0;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number }} [o]
   */
  constructor({ navCapacity = 65536, maxShapes = 160, seed = 0x2545f491, agentClearance = AGENT_CLEARANCE } = {}) {
    this.nav = new NavGrid(navCapacity);
    this.shapes = new ShapeSet(maxShapes);
    this.spawner = new SpawnFinder({ seed });
    this.agentClearance = agentClearance;
    /** @type {import('./Layout.js').Layout|null} */ this.layout = null;
    this.built = false;
    /** No usable Space Setup floor: a virtual open room around the player. */
    this.virtual = true;
    /** Real snapshot, but the player stood outside its floors: a virtual patch was added. */
    this.partialVirtual = false;
    this.floorYs = new Float32Array(128);
    this.floorY0 = 0;
    this.zone = { x: 0, z: 0, r: DEFAULT_ZONE_R };
    this.time = 0;
    /**
     * Open flag per door id (layout.doors order), as used by the last build.
     * Change with setDoorOpen(id, open), then rebuild().
     * @type {boolean[]}
     */
    this.doorOpen = [];
    /** @type {import('./Layout.js').SpaceSnapshot|null} */ this.snapshot = null;
    this.start = { x: 0, z: 0, r: DEFAULT_ZONE_R };
    this.stats = {
      buildMs: 0, floors: 0, walls: 0, inferredWalls: 0, doors: 0, closedDoors: 0, passableDoors: 0, pockets: 0,
      furniture: 0, shapes: 0, droppedShapes: 0,
      cells: 0, walkable: 0, regions: 0, spawnCandidates: 0, doorSpawnCandidates: 0, pocketSpawnCandidates: 0,
      /** @type {string[]} */ notes: [],
    };
  }

  /**
   * One-time build at session start. `null` (or a snapshot with no floor) gives a
   * virtual open room centred on the player.
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart where the player stands (r = safe-zone radius, default 0.8)
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null }} [opts] doors[id] === false closes that door
   *   (not carved, wall solid); missing = open (every door open by default)
   */
  build(snapshot, playerStart, opts = {}) {
    const t0 = now();
    this.snapshot = snapshot;
    /** @type {string[]} */ const notes = [];
    let snap = null;
    if (snapshot) {
      try { snap = normalizeSnapshot(snapshot); } catch (e) { notes.push(`snapshot rejected: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const sx = playerStart && Number.isFinite(playerStart.x) ? playerStart.x : 0;
    const sz = playerStart && Number.isFinite(playerStart.z) ? playerStart.z : 0;
    const r = playerStart && Number.isFinite(playerStart.r) && /** @type {number} */ (playerStart.r) > 0 ? /** @type {number} */ (playerStart.r) : DEFAULT_ZONE_R;
    this.zone.x = sx;
    this.zone.z = sz;
    this.zone.r = r;
    this.start.x = sx;
    this.start.z = sz;
    this.start.r = r;

    const L = buildLayout(snap, { x: sx, z: sz }, { doorOpen: opts && opts.doors ? opts.doors : null });
    this.doorOpen.length = 0;
    for (const d of L.doors) this.doorOpen.push(d.open);
    for (const n of L.notes) notes.push(n);
    this.layout = L;
    this.virtual = L.virtual;
    this.partialVirtual = L.partialVirtual;
    this.shapes.setFromLayout(L, sx, sz);
    if (this.shapes.dropped) notes.push(`${this.shapes.dropped} far furniture boxes dropped (shape limit ${this.shapes.maxBoxes})`);
    const nf = Math.min(L.floors.length, this.floorYs.length);
    for (let k = 0; k < nf; k++) this.floorYs[k] = L.floors[k].y;
    this.floorY0 = L.floorY0;

    this.bakeNav(L, sx, sz, r, notes);
    this.spawner.build(this.nav, r, { allowVirtual: L.virtual });
    if (this.spawner.virtualFallback) notes.push('no spawn point on mapped floor: virtual floor used');

    const s = this.stats;
    s.floors = L.virtual ? L.floors.length : L.mappedFloors;
    s.walls = L.walls.length;
    s.inferredWalls = L.inferredWalls;
    s.doors = L.doors.length;
    s.closedDoors = 0;
    s.passableDoors = 0;
    for (const d of L.doors) {
      if (!d.open) s.closedDoors++;
      if (d.passable) s.passableDoors++;
    }
    s.pockets = L.pockets;
    s.furniture = L.furniture.length;
    s.shapes = this.shapes.count;
    s.droppedShapes = this.shapes.dropped;
    s.cells = this.nav.count;
    s.walkable = this.nav.walkableCount;
    s.regions = this.nav.regionCount;
    s.spawnCandidates = this.spawner.count;
    s.doorSpawnCandidates = this.spawner.doorCount;
    s.pocketSpawnCandidates = this.spawner.pocketCount;
    s.notes = notes;
    s.buildMs = now() - t0;
    this.built = true;
  }

  /**
   * Open or close one door for the next rebuild() (ids = layout.doors order).
   * Closed = no opening (bullets, sight and the occluder stop at the wall), no
   * nav carve, no pocket. Build-time only (behind the "Get ready" panel).
   * @param {number} id
   * @param {boolean} open
   * @returns {boolean} false for an unknown id
   */
  setDoorOpen(id, open) {
    if (!(id >= 0 && id < this.doorOpen.length)) return false;
    this.doorOpen[id] = !!open;
    return true;
  }

  /**
   * Build again from the last snapshot and player start with the current door
   * flags (after setDoorOpen). The World subclass rewrites the occluder too;
   * run warmXR (or one draw) again before play.
   */
  rebuild() {
    this.build(this.snapshot, this.start, { doors: this.doorOpen.slice() });
  }

  /**
   * Run every build path once on a small synthetic house, so the real build at
   * session start runs on optimised code (a cold build is ~10× slower than a
   * warm one in V8). Call at load, before Enter. Leaves the world unbuilt.
   */
  warmUp() {
    const b = new SnapshotBuilder({ yaw: 0.3 });
    const r1 = [[0, 0], [5, 0], [5, 4], [0, 4]], r2 = [[5.1, 0], [8, 0], [8, 4], [5.1, 4]];
    b.floor(r1, 0).floor(r2, 0.01).ceiling(r1, 2.5).ceiling(r2, 2.5);
    for (const r of [r1, r2]) {
      for (let i = 0; i < 4; i++) {
        if (r === r2 && i === 2) continue; // one edge without a wall plane: inferred
        b.wall(r[i][0], r[i][1], r[(i + 1) % 4][0], r[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
      }
    }
    b.wall(2.5, 0, 2.5, 1.6, 0, 2.5, { flip: true }); // an interior stub (faced to the player)
    b.door(5, 1.5, 5, 2.35, 0, 2.03, { offset: -0.01 }).door(2, 4, 1.1, 4, 0, 2.03).door(6, 4, 6.85, 4, 0, 2.03);
    b.top('table', 2.5, 1.2, 0.6, 0.4, 0.75, 0.2).box('table', 2.5, 1.2, 0.6, 0.4, 0, 0.75, { yaw: 0.2 });
    b.top('bed', 7, 3, 0.9, 0.8, 0.55).box('bed', 7, 3, 0.9, 0.8, 0, 0.55).box(null, 4.5, 3.5, 0.2, 0.3, 0, 1.6, { zUp: true });
    const [x, z] = b.toWorld(1.5, 2);
    const out = { x: 0, z: 0 }, hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
    for (let k = 0; k < 2; k++) {
      this.build(b.build(), { x, z }, { doors: k === 1 ? [true, false] : null });
      this.findSpawn(x, z, 1, 0, 3, out);
      for (let i = 0; i < 64; i++) this.raycast(x, 1.5, z, Math.cos(i), -0.1, Math.sin(i), 20, hit);
      this.report();
    }
    this.build(null, { x: 0, z: 0 });
    this.built = false;
    this.layout = null;
    this.snapshot = null;
  }

  /**
   * @param {import('./Layout.js').Layout} L
   * @param {number} sx @param {number} sz @param {number} r
   * @param {string[]} notes
   */
  bakeNav(L, sx, sz, r, notes) {
    const nav = this.nav, cell = nav.cell;
    const x0 = L.bounds.x0 - NAV_MARGIN, z0 = L.bounds.z0 - NAV_MARGIN;
    let w = Math.ceil((L.bounds.x1 + NAV_MARGIN - x0) / cell), h = Math.ceil((L.bounds.z1 + NAV_MARGIN - z0) / cell);
    let ox = x0, oz = z0;
    if (w * h > nav.capacity) {
      // Keep the 0.10 m cells; crop to the capacity around the player (far rooms don't matter for a fight).
      const k = Math.sqrt(nav.capacity / (w * h));
      const nw = Math.max(1, Math.min(w, Math.floor(w * k))), nh = Math.max(1, Math.min(h, Math.floor(nav.capacity / nw)));
      ox = Math.min(Math.max(sx - (nw * cell) / 2, x0), x0 + (w - nw) * cell);
      oz = Math.min(Math.max(sz - (nh * cell) / 2, z0), z0 + (h - nh) * cell);
      notes.push(`nav grid cropped to ${(nw * cell).toFixed(1)} × ${(nh * cell).toFixed(1)} m around the player`);
      w = nw;
      h = nh;
    }
    nav.reset(ox, oz, w, h);
    for (let k = 0; k < L.floors.length; k++) {
      const f = L.floors[k];
      nav.fillPolygon(f.pts, f.n, NAV_INSIDE | (f.virtual ? NAV_VIRTUAL : 0) | (f.pocket ? NAV_POCKET : 0), k < 127 ? k : -1);
    }
    for (const b of L.boxes) {
      if (b.kind === 'wall') {
        if (b.y0 < floorHeightAt(L.floors, L.floorRef, b.cx, b.cz) + WALL_BLOCK_BELOW) nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, cell * 0.5, NAV_WALL);
      } else if (b.navBlock) {
        nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, 0.02, NAV_OBST);
        nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, FURN_INFLATE, NAV_FURN);
      }
    }
    for (const d of L.doors) {
      if (d.walkable && d.open) nav.fillBox(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH, 0, NAV_DOOR, NAV_WALL);
    }
    nav.computeClearance(NAV_WALL | NAV_OBST);
    nav.fillDisc(sx, sz, r + ZONE_EXTRA, NAV_ZONE);
    nav.finalize(this.agentClearance, sx, sz, Math.min(this.agentClearance, DOOR_CLEARANCE));
    if (nav.startCell < 0) notes.push('no walkable floor near the player: enemies cannot reach you');
    for (const d of L.doors) d.passable = this.doorPassable(L, d);
  }

  /**
   * Can an enemy walk through this door? An open, walkable door whose gap
   * through every matched wall slab holds a walkable cell connected to the
   * player, with walkable floor 0.55–1.05 m out on both sides (so a door into
   * unmapped space is passable only with its pocket).
   * @param {import('./Layout.js').Layout} L
   * @param {import('./Layout.js').Door} d
   */
  doorPassable(L, d) {
    if (!d.walkable || !d.open) return false;
    const nav = this.nav, hw = d.width / 2;
    if (d.wallIds.length === 0 && nav.countInBox(d.cx, d.cz, d.tx, d.tz, hw, 0.1, NAV_DOOR | NAV_WALK, true) === 0) return false;
    for (let k = 0; k < d.wallIds.length; k++) {
      const w = L.walls[d.wallIds[k]];
      const v = -d.offsets[k] - WALL_T / 2; // slab centre, along the wall normal from the door centre
      if (nav.countInBox(d.cx + w.nx * v, d.cz + w.nz * v, d.tx, d.tz, hw, 0.06, NAV_WALK, true) === 0) return false;
    }
    for (let sg = -1; sg <= 1; sg += 2) {
      const x = d.cx + d.nx * 0.8 * sg, z = d.cz + d.nz * 0.8 * sg;
      if (nav.countInBox(x, z, d.tx, d.tz, hw + 0.3, 0.25, NAV_WALK, true) === 0) return false;
    }
    return true;
  }

  /**
   * Nearest world hit (walls, lintels, furniture, floor, ceiling). Writes `out`
   * only on a hit; out.surface is the label ('wall', 'floor', 'table', …).
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {number} max
   * @param {any} out Hit
   */
  raycast(ox, oy, oz, dx, dy, dz, max, out) {
    return this.shapes.raycast(ox, oy, oz, dx, dy, dz, max, out);
  }

  /**
   * Line of sight between two points (walls, lintels, furniture).
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} bx @param {number} by @param {number} bz
   */
  segmentClear(ax, ay, az, bx, by, bz) {
    return this.shapes.segmentClear(ax, ay, az, bx, by, bz);
  }

  /**
   * A spawn point out of the player's view, path-reachable, ≥ minDist away,
   * preferring the far side of a door (see Spawner.js).
   * @param {number} fromX @param {number} fromZ player head
   * @param {number} viewDirX @param {number} viewDirZ horizontal view direction
   * @param {number} minDist
   * @param {{ x: number, z: number }} out
   */
  findSpawn(fromX, fromZ, viewDirX, viewDirZ, minDist, out) {
    return this.spawner.find(this, fromX, fromZ, viewDirX, viewDirZ, minDist, out, this.time);
  }

  /** Floor height under (x, z). @param {number} x @param {number} z */
  floorY(x, z) {
    const i = this.nav.index(x, z);
    if (i < 0) return this.floorY0;
    const f = this.nav.floorIdx[i];
    return f >= 0 ? this.floorYs[f] : this.floorY0;
  }

  /** Ceiling height over (x, z) (NaN in the virtual room). @param {number} x @param {number} z */
  ceilingY(x, z) {
    const c = this.shapes.ceilings;
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pointInPolygon(p.pts, p.n, x, z)) return p.y;
    }
    return this.shapes.ceilingY;
  }

  /**
   * A path planner on this world's grid. Create it at load; it stays valid
   * across rebuilds (a rebuild cancels its searches).
   * @param {ConstructorParameters<typeof PathPlanner>[1]} [opts]
   */
  createPlanner(opts) {
    return new PathPlanner(this.nav, opts);
  }

  /**
   * The world is static (never rebuilt during play); this only tracks time for
   * the spawn memory. Allocation-free.
   * @param {number} dt seconds
   * @param {number} t ms
   * @param {any} [frame] XRFrame (unused)
   * @param {any} [ctx] (unused)
   */
  update(dt, t, frame, ctx) {
    this.time = t * 0.001;
  }

  /** One line for the "Get ready" panel and the session record. */
  describe() {
    const L = this.layout;
    if (!L) return 'world not built';
    if (L.virtual) return 'No Space Setup floor: virtual open room';
    const s = this.stats;
    const extra = (s.inferredWalls ? `, ${s.inferredWalls} inferred` : '') + (s.closedDoors ? `, ${s.closedDoors} closed` : '');
    return `Space: ${s.floors} floor${s.floors === 1 ? '' : 's'}, ${s.walls} walls, ${s.doors} doors, ${s.furniture} objects${extra}${this.partialVirtual ? ' (+ virtual floor around you)' : ''}`;
  }

  /**
   * Compact, JSON-safe description of the last build for the session record
   * (`rec.play.world.report`): floors, walls (side, inferred), doors (matched
   * walls, width, bottom, walkable, passable, open, side, where it leads,
   * pocket), furniture, spawn candidates per tier, nav and build time.
   * Lengths in metres rounded to 1 cm, angles in degrees. Allocates: call it
   * at build time (behind the panel) or at session end, never per frame.
   * Calling it again later also returns the spawn tiers used so far.
   */
  report() {
    const L = this.layout;
    if (!L) return { v: 1, built: false };
    const s = this.stats, nav = this.nav;
    const c2 = (/** @type {number} */ v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 + 0 : null);
    const c3 = (/** @type {number} */ v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 + 0 : null);
    const deg = (/** @type {number} */ c, /** @type {number} */ sn) => Math.round((Math.atan2(sn, c) * 180) / Math.PI) + 0;
    return {
      v: 1,
      built: this.built,
      buildMs: Math.round(s.buildMs * 10) / 10,
      virtual: L.virtual,
      partialVirtual: L.partialVirtual,
      zone: { x: c2(this.zone.x), z: c2(this.zone.z), r: c2(this.zone.r) },
      counts: {
        floors: s.floors, walls: s.walls, inferredWalls: s.inferredWalls, doors: s.doors, closedDoors: s.closedDoors,
        passableDoors: s.passableDoors, pockets: s.pockets, furniture: s.furniture, shapes: s.shapes, droppedShapes: s.droppedShapes,
      },
      floors: L.floors.map((f) => ({
        id: f.id, kind: f.pocket ? 'pocket' : f.virtual ? 'virtual' : 'mapped', area: Math.round(f.area * 10) / 10, y: c3(f.y), pts: f.n,
        ...(f.pocket ? { door: f.door } : {}),
      })),
      ceilingY: c2(L.ceilingY),
      walls: L.walls.map((w) => ({
        id: w.id, a: [c2(w.ax), c2(w.az)], b: [c2(w.bx), c2(w.bz)], len: c2(w.len), y: [c2(w.y0), c2(w.y1)],
        n: [c2(w.nx), c2(w.nz)], side: w.side, flipped: w.flipped, inferred: w.inferred, openings: w.openings.length,
      })),
      doors: L.doors.map((d) => ({
        id: d.id, c: [c2(d.cx), c2(d.cz)], width: c2(d.width), bottom: c2(d.y0 - this.floorY(d.cx, d.cz)), y: [c2(d.y0), c2(d.y1)],
        walls: d.wallIds.slice(), offsets: d.offsets.map(c2), walkable: d.walkable, passable: d.passable, open: d.open,
        side: d.side, leadsTo: d.leadsTo, pocket: d.pocket >= 0,
      })),
      furniture: L.furniture.map((b) => ({
        label: b.label, c: [c2(b.cx), c2(b.cz)], size: [c2(2 * b.hx), c2(2 * b.hz), c2(b.y1 - b.y0)], y: [c2(b.y0), c2(b.y1)],
        yaw: deg(b.c, b.s), source: b.source, blocks: b.navBlock,
      })),
      spawn: this.spawner.report(this, this.zone.x, this.zone.z),
      nav: {
        w: nav.w, h: nav.h, cells: nav.count, walkable: nav.walkableCount, regions: nav.regionCount,
        origin: [c2(nav.ox), c2(nav.oz)], startCell: nav.startCell >= 0,
      },
      notes: s.notes.slice(),
    };
  }
}
