// @ts-check
/**
 * The world without three.js (pure, so Node tests cover all of it): layout,
 * analytic shapes, nav grid and spawn finder. `World.js` adds the occluder mesh.
 *
 * Built once per session (behind the "Get ready" panel) from a SpaceSnapshot;
 * never rebuilt during play (a reference-space realign rebuilds behind a
 * pause). Every query after build is allocation-free.
 *
 * Two build modes (`build(…, { roam })`, default `this.roam`):
 * - **Roam** (whole house, the default play mode in v0.3; `World` defaults to
 *   it): no player zone in the nav grid, interior wall slabs centred on their
 *   plane, the grid never cropped (a house larger than the capacity at 0.10 m
 *   gets coarser cells), rooms + door graph + door distance fields + the edge
 *   margin (`RoamIndex`, baked in slices by `update()` within `bakeBudgetMs`,
 *   or at once with `finishBake()`), spawn candidates in every room, and a
 *   time-sliced spawn search from the player's current position
 *   (`spawnRoam`). `nav.pathDistance` then answers from the player's
 *   position, which `update()` tracks from `ctx.player.head`.
 * - **Spot** (stationary, the v0.2 mode): the player zone (r + 1.2 m) is
 *   blocked, interior walls face the start point, spawns need 4 m of path
 *   beyond the zone edge.
 */

import { WALL_T, buildLayout, floorHeightAt } from './Layout.js';
import { NAV_DOOR, NAV_FURN, NAV_INSIDE, NAV_IWALL, NAV_OBST, NAV_POCKET, NAV_SHIELD, NAV_VIRTUAL, NAV_WALK, NAV_WALL, NAV_ZONE, NavGrid } from './NavGrid.js';
import { ROAM, RoamIndex } from './Roam.js';
import { PathPlanner } from './PathPlanner.js';
import { ShapeSet } from './Shapes.js';
import { normalizeSnapshot } from './Snapshot.js';
import { SnapshotBuilder } from './SnapshotBuilder.js';
import { SpawnFinder } from './Spawner.js';
import { transformPointXZ, transformSnapshot } from './Realign.js';
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
/** Nav capacity: 131,072 cells = a 1,310 m² bounding box at 0.10 m (larger houses get coarser cells, never a crop). */
export const NAV_CAPACITY = 131072;
/** Coarsest cell a huge house may get (m). */
const MAX_CELL = 0.25;
/** Spawn: the roam search's share of a frame (ms). */
export const SPAWN_BUDGET_MS = 0.5;
/** After this many roam searches in a row found nothing, one frame-capped classic find() is tried. */
const ROAM_FALLBACK_AFTER = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number, roam?: boolean,
   *   bakeBudgetMs?: number, spawnBudgetMs?: number, clock?: () => number }} [o]
   *   roam: the default build mode (WorldCore: false, the stationary build; World: true);
   *   bakeBudgetMs: Roam bake per update() (ms); spawnBudgetMs: roam spawn search per spawnRoam() call (ms)
   */
  constructor({ navCapacity = NAV_CAPACITY, maxShapes = 512, seed = 0x2545f491, agentClearance = AGENT_CLEARANCE, roam = false,
    bakeBudgetMs = ROAM.bakeBudgetMs, spawnBudgetMs = SPAWN_BUDGET_MS, clock = now } = {}) {
    this.nav = new NavGrid(navCapacity);
    this.shapes = new ShapeSet(maxShapes);
    this.spawner = new SpawnFinder({ seed });
    this.agentClearance = agentClearance;
    /** Default build mode: Roam (whole house) or the stationary spot build. */
    this.roam = roam;
    /** The last build was a Roam build. */
    this.roamOn = false;
    /** Rooms, door graph, door fields, edge margin, player tracking (Roam builds). */
    this.roamIndex = new RoamIndex(this.nav, { clock });
    this.bakeBudgetMs = bakeBudgetMs;
    this.spawnBudgetMs = spawnBudgetMs;
    this.clock = clock;
    /** Roam searches in a row that found nothing. */
    this.roamFailStreak = 0;
    /** spawnRoam's inputs: head x, z, velocity x, z, view x, z. */
    this._spawnIn = new Float64Array(6);
    /** The last build was skipped (Roam, same snapshot and doors, only the start moved). */
    this.skipped = false;
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
      rooms: 0, cell: 0.1, builds: 0, skippedBuilds: 0, realigns: 0,
      /** @type {string[]} */ notes: [],
    };
  }

  /**
   * One-time build at session start. `null` (or a snapshot with no floor) gives a
   * virtual open room centred on the player.
   *
   * In Roam, a build with the same snapshot object, the same door flags and a
   * start that moved (the integrator's "rebuild around the confirmed spot")
   * changes nothing that depends on the start, so it only moves `start` and
   * returns false (unless the old or new start is off the mapped floor, where
   * the virtual patch around the player matters).
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart where the player stands (r = safe-zone radius, default 0.8; Roam: 0)
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null, roam?: boolean }} [opts] doors[id] === false closes that door
   *   (not carved, wall solid); missing = open (every door open by default). roam: build mode (default this.roam)
   * @returns {boolean} true when the world was (re)built
   */
  build(snapshot, playerStart, opts = {}) {
    const t0 = now();
    const roam = opts && typeof opts.roam === 'boolean' ? opts.roam : this.roam;
    const sx = playerStart && Number.isFinite(playerStart.x) ? playerStart.x : 0;
    const sz = playerStart && Number.isFinite(playerStart.z) ? playerStart.z : 0;
    if (roam && this.canSkip(snapshot, opts && opts.doors ? opts.doors : null, sx, sz)) {
      this.start.x = sx;
      this.start.z = sz;
      this.zone.x = sx;
      this.zone.z = sz;
      this.skipped = true;
      this.stats.skippedBuilds++;
      return false;
    }
    this.skipped = false;
    this.snapshot = snapshot;
    /** @type {string[]} */ const notes = [];
    let snap = null;
    if (snapshot) {
      try { snap = normalizeSnapshot(snapshot); } catch (e) { notes.push(`snapshot rejected: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const r = roam ? 0 : playerStart && Number.isFinite(playerStart.r) && /** @type {number} */ (playerStart.r) > 0 ? /** @type {number} */ (playerStart.r) : DEFAULT_ZONE_R;
    this.zone.x = sx;
    this.zone.z = sz;
    this.zone.r = r;
    this.start.x = sx;
    this.start.z = sz;
    this.start.r = r;
    this.roamOn = roam;
    this.roamFailStreak = 0;

    const L = buildLayout(snap, { x: sx, z: sz }, { doorOpen: opts && opts.doors ? opts.doors : null, interiorSlab: roam ? 'centred' : 'player' });
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

    this.bakeNav(L, sx, sz, r, notes, roam);
    if (roam) {
      this.roamIndex.build(L);
      if (L.virtual) this.roamIndex.skipEdge(); // a virtual room has no map edge
      this.nav.pathSource = this.roamIndex;
      this.spawner.buildRoam(this.nav);
    } else {
      this.roamIndex.clear();
      this.spawner.build(this.nav, r, { allowVirtual: L.virtual });
    }
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
    s.rooms = roam ? this.roamIndex.roomCount : 0;
    s.cell = this.nav.cell;
    s.builds++;
    s.notes = notes;
    s.buildMs = now() - t0;
    this.built = true;
    return true;
  }

  /**
   * Roam: can a build with these inputs keep the current world?
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {ArrayLike<boolean|undefined|null>|null} doors
   * @param {number} sx @param {number} sz
   */
  canSkip(snapshot, doors, sx, sz) {
    if (!this.built || !this.roamOn || !this.layout || snapshot !== this.snapshot || this.partialVirtual || this.virtual) return false;
    const L = this.layout;
    for (let k = 0; k < L.doors.length; k++) {
      const f = doors && k < doors.length ? doors[k] : undefined;
      const open = f === undefined || f === null ? true : !!f;
      if (open !== this.doorOpen[k]) return false;
    }
    if (doors && doors.length > L.doors.length) return false;
    const i = this.nav.index(sx, sz);
    return i >= 0 && (this.nav.flags[i] & (NAV_INSIDE | NAV_VIRTUAL)) === NAV_INSIDE;
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
    this.built = false; // never skipped
    this.build(this.snapshot, this.start, { doors: this.doorOpen.slice(), roam: this.roamOn });
  }

  /**
   * Rebuild in a moved reference space (after a reset or drift; Realign.js):
   * the stored snapshot and the start are moved by `m` (old → new space) and
   * the world is rebuilt in the same mode with the same doors. With a fresh
   * capture in the new space (`snapshot`), that is used instead (door flags
   * then reset to open: door ids follow the capture order). Behind a pause
   * (allocates; the World subclass rewrites the occluder: draw it once before
   * play resumes). The Roam bake restarts in slices.
   * @param {ArrayLike<number>|null} m old → new (column-major 4×4), or null with a fresh snapshot
   * @param {import('./Layout.js').SpaceSnapshot|null} [snapshot]
   * @returns {boolean} built
   */
  realign(m, snapshot = null) {
    const st = { x: this.start.x, z: this.start.z, r: this.start.r };
    if (m) transformPointXZ(m, st);
    const snap = snapshot || (this.snapshot && m ? transformSnapshot(this.snapshot, m) : this.snapshot);
    const doors = snapshot ? null : this.doorOpen.slice();
    this.built = false;
    this.build(snap, st, { doors, roam: this.roamOn });
    this.stats.realigns++;
    return true;
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
    const snap = b.build();
    for (let k = 0; k < 4; k++) {
      const roam = k >= 2;
      this.built = false;
      this.build(snap, { x, z }, { doors: k === 1 ? [true, false] : null, roam });
      if (roam) {
        this.finishBake();
        this.roamIndex.trackPlayer(x, z);
        this.edgeMargin(x, z);
        for (let i = 0; i < 4; i++) this.spawnRoam(x + i * 0.3, z, 0.4, 0, 1, 0, out);
        const pl = { head: { x, z }, vel: { x: 0.3, z: 0 }, flatForward: { x: 1, z: 0 } };
        for (let i = 0; i < 4; i++) { pl.head.x = x - i * 0.3; this.spawnRoamFor(pl, out); this.update(0.014, i * 14, null, { player: pl }); }
      }
      this.findSpawn(x, z, 1, 0, 3, out);
      for (let i = 0; i < 64; i++) this.raycast(x, 1.5, z, Math.cos(i), -0.1, Math.sin(i), 20, hit);
      this.report();
    }
    this.build(null, { x: 0, z: 0 }, { roam: false });
    this.built = false;
    this.layout = null;
    this.snapshot = null;
  }

  /**
   * @param {import('./Layout.js').Layout} L
   * @param {number} sx @param {number} sz @param {number} r
   * @param {string[]} notes
   * @param {boolean} [roam]
   */
  bakeNav(L, sx, sz, r, notes, roam = false) {
    const nav = this.nav;
    const x0 = L.bounds.x0 - NAV_MARGIN, z0 = L.bounds.z0 - NAV_MARGIN;
    const spanX = L.bounds.x1 + NAV_MARGIN - x0, spanZ = L.bounds.z1 + NAV_MARGIN - z0;
    // Never crop (the player walks the whole house): a house too large for the capacity gets coarser cells.
    let cell = nav.baseCell;
    let w = Math.ceil(spanX / cell), h = Math.ceil(spanZ / cell);
    while (w * h > nav.capacity && cell < MAX_CELL) {
      cell = Math.min(MAX_CELL, Math.ceil(cell * Math.sqrt((w * h) / nav.capacity) * 1000 + 0.5) / 1000);
      w = Math.ceil(spanX / cell);
      h = Math.ceil(spanZ / cell);
    }
    if (w * h > nav.capacity) {
      // beyond even the coarsest cells (a > 8,000 m² box): keep the part around the player
      const k = Math.sqrt(nav.capacity / (w * h));
      const nw = Math.max(1, Math.min(w, Math.floor(w * k))), nh = Math.max(1, Math.min(h, Math.floor(nav.capacity / nw)));
      const ox = Math.min(Math.max(sx - (nw * cell) / 2, x0), x0 + (w - nw) * cell);
      const oz = Math.min(Math.max(sz - (nh * cell) / 2, z0), z0 + (h - nh) * cell);
      notes.push(`nav grid cropped to ${(nw * cell).toFixed(1)} × ${(nh * cell).toFixed(1)} m around the player (house too large)`);
      nav.reset(ox, oz, nw, nh, cell);
    } else {
      if (cell > nav.baseCell) notes.push(`nav cells ${(cell * 100).toFixed(1)} cm for a ${spanX.toFixed(1)} × ${spanZ.toFixed(1)} m house (capacity ${nav.capacity})`);
      nav.reset(x0, z0, w, h, cell);
    }
    // Mapped floors first; virtual floors (patch, pockets) only where no mapped floor is.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < L.floors.length; k++) {
        const f = L.floors[k];
        if (f.virtual !== (pass === 1)) continue;
        nav.fillPolygon(f.pts, f.n, NAV_INSIDE | (f.virtual ? NAV_VIRTUAL : 0) | (f.pocket ? NAV_POCKET : 0), k < 127 ? k : -1, f.virtual);
      }
    }
    for (const b of L.boxes) {
      if (b.kind === 'wall') {
        if (b.y0 < floorHeightAt(L.floors, L.floorRef, b.cx, b.cz) + WALL_BLOCK_BELOW) {
          const inferred = b.source === 'inferred';
          nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, cell * 0.5, NAV_WALL | (inferred ? NAV_IWALL : 0));
          // off-floor cells this close to a REAL wall are behind it, not an open edge (Roam's edge margin)
          if (!inferred) nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, ROAM.shield, NAV_SHIELD);
        }
      } else if (b.navBlock) {
        nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, 0.02, NAV_OBST);
        nav.fillBox(b.cx, b.cz, b.c, b.s, b.hx, b.hz, FURN_INFLATE, NAV_FURN);
      }
    }
    for (const d of L.doors) {
      if (d.walkable && d.open) nav.fillBox(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH, 0, NAV_DOOR, NAV_WALL);
    }
    nav.computeClearance(NAV_WALL | NAV_OBST);
    for (const d of L.doors) {
      if (!d.walkable || !d.open) continue;
      // Each matched wall's slab, in door-local z (−(p − centre)·n): face at offset·σ, back 0.10 m beyond.
      /** @type {number[]} */ const bands = [];
      for (let k = 0; k < d.wallIds.length; k++) {
        const w = L.walls[d.wallIds[k]];
        const sg = w.nx * d.nx + w.nz * d.nz >= 0 ? 1 : -1;
        const lo = w.centred ? d.offsets[k] - WALL_T / 2 : d.offsets[k], hi = lo + WALL_T;
        const a = lo * sg, b = hi * sg;
        bands.push(Math.min(a, b), Math.max(a, b));
      }
      if (!bands.length) bands.push(-DOOR_DEPTH, DOOR_DEPTH);
      nav.refineDoorClearance(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH, bands);
    }
    if (!roam) nav.fillDisc(sx, sz, r + ZONE_EXTRA, NAV_ZONE); // Roam: no zone (the player walks)
    nav.finalize(this.agentClearance, sx, sz, Math.min(this.agentClearance, DOOR_CLEARANCE));
    if (nav.startCell < 0 && !roam) notes.push('no walkable floor near the player: enemies cannot reach you');
    for (const d of L.doors) {
      d.passable = this.doorPassable(L, d);
      d.inZone = !roam && nav.countInBox(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH, NAV_ZONE, 0) > 0;
    }
  }

  /**
   * Can an enemy walk through this door (whatever the player zone)? An open,
   * walkable door with a connected chain of cells an enemy fits in, from
   * 0.55 m in front of it to 0.55 m behind it (so a door into unmapped space
   * is passable only with its pocket).
   * @param {import('./Layout.js').Layout} L
   * @param {import('./Layout.js').Door} d
   */
  doorPassable(L, d) {
    if (!d.walkable || !d.open) return false;
    return this.nav.doorConnects(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH);
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
    if (!this.roamOn) return this.spawner.find(this, fromX, fromZ, viewDirX, viewDirZ, minDist, out, this.time);
    this.roamIndex.trackPlayer(fromX, fromZ); // Roam: tiers and paths relative to where the player is now
    return this.spawner.find(this, fromX, fromZ, viewDirX, viewDirZ, minDist, out, this.time, this.roamIndex);
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
   * Time for the spawn memory; in Roam also the bake slice (within
   * `bakeBudgetMs`, until done) and the player tracking (`ctx.player.head`,
   * last frame's pose: the world system runs before the player system).
   * Allocation-free.
   * @param {number} dt seconds
   * @param {number} t ms
   * @param {any} [frame] XRFrame (unused)
   * @param {{ player?: { head: { x: number, z: number }, valid?: boolean } }|null} [ctx]
   */
  update(dt, t, frame, ctx) {
    this.time = t * 0.001;
    if (!this.roamOn || !this.built) return;
    const R = this.roamIndex;
    if (R.baking) R.step(this.bakeBudgetMs);
    const p = ctx && ctx.player;
    if (p && p.valid !== false) R.track(p.head);
  }

  // ── Roam queries (allocation-free) ───────────────────────────────────────

  /** The Roam bake (edge margin, door fields) is complete (true for a spot build). */
  get bakeDone() { return !this.roamOn || !this.roamIndex.baking; }

  /** Run the rest of the Roam bake now (tests; behind an opaque panel). */
  finishBake() { if (this.roamOn) this.roamIndex.finish(); }

  /**
   * Signed margin to the open edge of the mapped floor (m): + on the map, −
   * off it (see RoamIndex). 99 when unknown (not baked yet, spot build, a
   * virtual room).
   * @param {number} x @param {number} z
   */
  edgeMargin(x, z) {
    return this.roamOn ? this.nav.edgeMargin(x, z) : 99;
  }

  /** Room id at (x, z) (0 = none; spot builds have no rooms). @param {number} x @param {number} z */
  roomAt(x, z) {
    return this.roamOn ? this.nav.roomAt(x, z) : 0;
  }

  /** The player's room as tracked (0 = unknown). */
  get playerRoom() { return this.roamOn ? this.roamIndex.pRoomA : 0; }

  /**
   * Path length (m) from the player to (x, z): Roam from the tracked
   * position, spot from the build start.
   * @param {number} x @param {number} z
   */
  pathFromPlayer(x, z) {
    return this.nav.pathDistance(x, z);
  }

  /**
   * Roam spawn point (CONTRACTS findSpawn, for a walking player): resumes the
   * time-sliced search for at most `spawnBudgetMs` per call. Never in the
   * player's room(s), ≥ 3.5 m from the head and from the head in 1 s
   * (velocity), 5–30 m of path through the doors, hidden from the eyes. When
   * three searches in a row find nothing (a one-room house, everything in
   * view), one classic find() (tiers 3 → 2 → 1 → in-view last resort, by room)
   * is tried. In a spot build this is findSpawn.
   * @param {number} hx @param {number} hz head
   * @param {number} vx @param {number} vz horizontal head velocity (m/s)
   * @param {number} fx @param {number} fz horizontal view direction
   * @param {{ x: number, z: number }} out
   * @returns {number} 1 found (out written), 2 still searching (call again next frame), 0 nothing this time
   */
  spawnRoam(hx, hz, vx, vz, fx, fz, out) {
    const A = this._spawnIn;
    A[0] = hx; A[1] = hz; A[2] = vx; A[3] = vz; A[4] = fx; A[5] = fz;
    return this.spawnRoamStep(out);
  }

  /**
   * spawnRoam for a player object (head, vel, flatForward or forward): the
   * per-frame form, reading fields so no doubles are passed (nothing boxed).
   * @param {{ head: { x: number, z: number }, vel?: { x: number, z: number }, flatForward?: { x: number, z: number }, forward?: { x: number, z: number } }} p
   * @param {{ x: number, z: number }} out
   * @returns {number} 1 found, 2 still searching, 0 nothing this time
   */
  spawnRoamFor(p, out) {
    const A = this._spawnIn, v = p.vel, f = p.flatForward || p.forward;
    A[0] = p.head.x; A[1] = p.head.z;
    A[2] = v ? v.x : 0; A[3] = v ? v.z : 0;
    A[4] = f ? f.x : 0; A[5] = f ? f.z : 0;
    return this.spawnRoamStep(out);
  }

  /** @param {{ x: number, z: number }} out @returns {number} */
  spawnRoamStep(out) {
    const A = this._spawnIn;
    if (!this.roamOn) return this.findSpawn(A[0], A[1], A[4], A[5], 3.5, out) ? 1 : 0;
    const R = this.roamIndex, S = this.spawner;
    if (!R.fieldsReady) return 2; // the door fields are still baking (the first second of a session)
    R.px = A[0]; R.pz = A[1];
    R.trackStep();
    const aim = S.aim;
    aim[0] = A[0]; aim[1] = A[1]; aim[2] = A[2]; aim[3] = A[3];
    if (!S.rsActive) S.beginRoam(this, this.time);
    else S.aimRoam(this);
    S.rsDeadline = this.clock() + this.spawnBudgetMs;
    const r = S.stepRoam(this, R, this.clock, out);
    if (r === 1) { this.roamFailStreak = 0; return 1; }
    if (r === 2) return 2;
    this.roamFailStreak++;
    if (this.roamFailStreak < ROAM_FALLBACK_AFTER && S.roomsWithCandidates >= 2) return 0;
    const cap = S.evalCap;
    S.evalCap = 32; // bounded: this runs inside one frame
    const ok = S.find(this, A[0], A[1], A[4], A[5], S.hardMin, out, this.time, R);
    S.evalCap = cap;
    if (ok) this.roamFailStreak = 0;
    return ok ? 1 : 0;
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
        walls: d.wallIds.slice(), offsets: d.offsets.map(c2), walkable: d.walkable, passable: d.passable, inZone: d.inZone, open: d.open,
        side: d.side, leadsTo: d.leadsTo, pocket: d.pocket >= 0,
      })),
      furniture: L.furniture.map((b) => ({
        label: b.label, c: [c2(b.cx), c2(b.cz)], size: [c2(2 * b.hx), c2(2 * b.hz), c2(b.y1 - b.y0)], y: [c2(b.y0), c2(b.y1)],
        yaw: deg(b.c, b.s), source: b.source, blocks: b.navBlock,
      })),
      spawn: this.spawner.report(this, this.zone.x, this.zone.z),
      nav: {
        w: nav.w, h: nav.h, cells: nav.count, walkable: nav.walkableCount, regions: nav.regionCount, cell: nav.cell,
        capacity: nav.capacity, capacityUsed: Math.round((nav.count / nav.capacity) * 1000) / 1000,
        origin: [c2(nav.ox), c2(nav.oz)], startCell: nav.startCell >= 0,
      },
      mode: this.roamOn ? 'roam' : 'spot',
      roam: this.roamOn ? { ...this.roamIndex.report(), centredWalls: L.walls.filter((w) => w.centred).length, skippedBuilds: s.skippedBuilds } : null,
      notes: s.notes.slice(),
    };
  }

  /**
   * Bytes of the world's preallocated per-cell arrays (nav grid, its heap,
   * Roam index; a planner built on this grid adds about 36 B per cell).
   */
  memoryBytes() {
    const n = this.nav;
    const navB = n.flags.byteLength + n.clr.byteLength + n.region.byteLength + n.pathDist.byteLength + n.doors.byteLength
      + n.floorIdx.byteLength + n.room.byteLength + n.edge.byteLength + n._queue.byteLength + (n._tmp ? n._tmp.byteLength : 0)
      + n.heap.items.byteLength + n.heap.keys.byteLength + n.heap.pos.byteLength + n.reach.byteLength;
    return { nav: navB, roam: this.roamIndex.bytes(), shapes: this.shapes.box.byteLength, total: navB + this.roamIndex.bytes() + this.shapes.box.byteLength };
  }
}
