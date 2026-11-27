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

import { WALL_T, buildLayout, floorHeightAt, scannedSideVote } from './Layout.js';
import { NAV_DOOR, NAV_FURN, NAV_HIDDEN, NAV_INSIDE, NAV_IWALL, NAV_OBST, NAV_POCKET, NAV_SHIELD, NAV_VIRTUAL, NAV_WALK, NAV_WALL, NAV_ZONE, NavGrid } from './NavGrid.js';
import { ROAM, RoamIndex } from './Roam.js';
import { PathPlanner } from './PathPlanner.js';
import { ShapeSet } from './Shapes.js';
import { normalizeSnapshot } from './Snapshot.js';
import { SnapshotBuilder } from './SnapshotBuilder.js';
import { SpawnFinder } from './Spawner.js';
import { transformPointXZ, transformSnapshot } from './Realign.js';
import { pointInPolygon } from '../util/geom2d.js';
import { MeshBVH } from './MeshBVH.js';
import { SURF_NAME, colliderPositions, occluderPositions, prepMesh } from './MeshPrep.js';
import { buildStatics } from './WorldStatics.js';
import { attachRaw, globalRawMesh, rawOf } from './Snapshot.js';
import { scanFromSnapshot } from './ScanSynth.js';
import { CopyJob, commitScalars, exportCore } from './WorldState.js';

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

/**
 * v0.4.1 unscanned space and door curtains:
 * - a room is behind the real walls when its cells' scanned-side votes sum below zero (up to `voteCells` cells
 *   sampled per room); its cells and every pocket cell get NAV_HIDDEN;
 * - hidden cells within `pocketR` of a curtained door, on its far side, may hold a spawn (NAV_POCKET);
 * - a curtain is a 2 cm depth-only box on the far face of the door's wall, `curtainPad` wider than the
 *   door each side (into the jambs) and up into the lintel;
 * - the curtains stand down while the player's head is in hidden space or within `pastFront` of a curtain's
 *   plane (leaning through the door): at most `maxCurtains`.
 */
export const HIDDEN = Object.freeze({ voteCells: 48, pocketR: 2.2, curtainPad: 0.06, curtainT: 0.02, pastFront: 0.12, pastSide: 0.4, maxCurtains: 32 });
/** Floats per curtain in `curtainData`: centre x, z, hidden-side normal x, z, along x, z, half width. */
const CURTAIN_STRIDE = 7;

/** Async build phases (`world.buildPhase`). */
export const BUILD = Object.freeze({ IDLE: 0, WORKING: 1, COPY: 2, COMMIT: 3, UPLOAD: 4 });
/** The main thread's share of a frame for applying a worker build (ms): the copy slices stop here. */
export const APPLY_BUDGET_MS = 0.5;
/** A worker build that has not answered after this long is built here instead (behind the panel). */
export const BUILD_TIMEOUT_MS = 8000;
/**
 * Global mesh triangles a synchronous build may process on the calling thread (about 60 ms on
 * desktop for the fixture's 11k; a real 36k-triangle Quest scan would stall the XR frame loop for
 * hundreds of ms): bigger meshes are skipped there (noted) and built by the worker (buildAsync).
 */
export const SYNC_MESH_MAX_TRIS = 20000;

export class WorldCore {
  /**
   * @param {{ navCapacity?: number, maxShapes?: number, seed?: number, agentClearance?: number, roam?: boolean,
   *   bakeBudgetMs?: number, spawnBudgetMs?: number, clock?: () => number, mesh?: boolean, syncMeshMaxTris?: number }} [o]
   *   mesh: use the snapshot's global mesh (default true); syncMeshMaxTris: see SYNC_MESH_MAX_TRIS
   *   roam: the default build mode (WorldCore: false, the stationary build; World: true);
   *   bakeBudgetMs: Roam bake per update() (ms); spawnBudgetMs: roam spawn search per spawnRoam() call (ms)
   */
  constructor({ navCapacity = NAV_CAPACITY, maxShapes = 512, seed = 0x2545f491, agentClearance = AGENT_CLEARANCE, roam = false,
    bakeBudgetMs = ROAM.bakeBudgetMs, spawnBudgetMs = SPAWN_BUDGET_MS, clock = now, mesh = true, syncMeshMaxTris = SYNC_MESH_MAX_TRIS } = {}) {
    /** The constructor options a worker core needs to match this one (capacities, seed). */
    this.config = { navCapacity, maxShapes, seed, agentClearance, roam, mesh };
    /**
     * A synchronous build() (this thread) processes a global mesh only up to this many triangles
     * (the fixture, the warm-up); a real capture is the worker's job (buildAsync). opts.mesh === true forces it.
     */
    this.syncMeshMaxTris = syncMeshMaxTris;
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
    /**
     * v0.4.1: the door curtains stand (the player is in scanned space): enemies in NAV_HIDDEN cells are not
     * drawn, cannot be seen by the spawner's test and never engage. False while the player's head is in hidden
     * space or leaning through a curtained door (`trackCurtains`, every frame).
     */
    this.curtainsOn = true;
    /** Curtain planes for trackCurtains (CURTAIN_STRIDE floats each) and their count. */
    this.curtainData = new Float64Array(HIDDEN.maxCurtains * CURTAIN_STRIDE);
    this.curtainCount = 0;
    /** trackCurtains' head (x, z), the nav cell it last decided in, and its limits (−pastFront, pastSide). */
    this._curtainP = new Float64Array(2);
    this._curtainCell = -2;
    this._curtainK = Float64Array.of(-HIDDEN.pastFront, HIDDEN.pastSide);
    /** Rooms the last build found behind the real walls (unscanned). */
    this.hiddenRooms = 0;
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
      rooms: 0, cell: 0.1, builds: 0, skippedBuilds: 0, realigns: 0, hiddenRooms: 0, curtains: 0, hiddenPocketCells: 0,
      meshTris: 0, meshMs: 0, bvhMs: 0, workerBuilds: 0, workerMs: 0, applyFrames: 0, applyMaxMs: 0,
      /** Worst main-thread step per apply phase (ms). */
      applyPhaseMs: { copy: 0, commit: 0, upload: 0 },
      /** @type {string[]} */ notes: [],
    };
    // ── the global mesh (snapshot v2) ──
    /** Use the snapshot's global mesh (BVH, mesh occluder, trimesh colliders) when it has one. */
    this.useMesh = mesh;
    /** Ray and segment queries over the processed global mesh (null: planes and boxes only). @type {MeshBVH|null} */
    this.bvh = null;
    /** MeshPrep stats of the last build's mesh (null: none). @type {any} */
    this.meshStats = null;
    /**
     * The occluder's mesh tiles (World uploads them): tiles (TILE_STRIDE), tileBounds, tileCount, tileIdx (local),
     * occPos (tile-local positions, 1 cm inward on hard surfaces). @type {any}
     */
    this.meshTiles = null;
    /** Static collider geometry for physics (WorldStatics.js; see staticGeometry()). @type {import('./WorldStatics.js').StaticGeometry|null} */
    this.statics = null;
    /** Furniture boxes the mesh covers (their box is not used for rays, sight or the occluder). */
    this.coveredFurniture = 0;
    /** The last synchronous build's processed mesh (for encodeMeshRecord); a worker build encodes there. @type {any} */
    this.lastPrepped = null;
    // ── async (worker) builds ──
    /** @type {any} */ this.builder = null;
    /** @type {any} */ this.occAdopt = null;
    /** @type {number} */ this.buildPhase = BUILD.IDLE;
    this.applyBudgetMs = APPLY_BUDGET_MS;
    this.buildTimeoutMs = BUILD_TIMEOUT_MS;
    this._seq = 0;
    /** @type {any} */ this._pending = null;
    /** @type {any} */ this._incoming = null;
    /** A request waiting for the one in flight. @type {any} */ this._next = null;
    this._copy = new CopyJob();
    /** Hit scratch for surfaceBelow. */
    this._hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
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
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null, roam?: boolean, mesh?: boolean }} [opts] doors[id] === false closes that door
   *   (not carved, wall solid); missing = open (every door open by default). roam: build mode (default this.roam);
   *   mesh: false = planes and boxes only, true = the global mesh whatever its size (default: up to syncMeshMaxTris)
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
    this.buildMesh(snap, L, sx, sz, notes, opts && opts.mesh === false ? 0 : opts && opts.mesh === true ? 2 : 1);
    this.shapes.setFromLayout(L, sx, sz);
    this.shapes.setSkipCovered(this.bvh !== null);
    if (this.shapes.dropped) notes.push(`${this.shapes.dropped} far furniture boxes dropped (shape limit ${this.shapes.maxBoxes})`);
    const nf = Math.min(L.floors.length, this.floorYs.length);
    for (let k = 0; k < nf; k++) this.floorYs[k] = L.floors[k].y;
    this.floorY0 = L.floorY0;

    this.bakeNav(L, sx, sz, r, notes, roam);
    this.markHidden(L, notes);
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
    s.hiddenRooms = this.hiddenRooms;
    s.curtains = L.curtains ? L.curtains.length : 0;
    s.spawnCandidates = this.spawner.count;
    s.doorSpawnCandidates = this.spawner.doorCount;
    s.pocketSpawnCandidates = this.spawner.pocketCount;
    s.rooms = roam ? this.roamIndex.roomCount : 0;
    s.cell = this.nav.cell;
    s.builds++;
    s.notes = notes;
    s.buildMs = now() - t0;
    this.indexCurtains();
    this.built = true;
    return true;
  }

  /**
   * v0.4.1, after the nav bake: unscanned space and the door curtains.
   * 1. Pocket cells are hidden. Every room (4-connected floor component between walls and doors) votes with
   *    up to HIDDEN.voteCells of its cells (`scannedSideVote`: is the first real wall plane met in 8 directions
   *    seen from its front or its back?); a room seen from behind the real walls that also reaches the map's
   *    open edge (an inferred wall, or no floor and no real wall) is unscanned: NAV_HIDDEN.
   *    (The user's house: the living room's 4-point floor rectangle also covered the space behind its three
   *    doors and a closed corner behind two of its walls; v0.4 spawned five of six enemies there, in plain view
   *    through the doors, where the real house has other walls.)
   * 2. Each open door with scanned floor on one side and hidden (or no) floor on the other gets a curtain on the
   *    far face of its wall (`layout.curtains`), and the hidden cells within HIDDEN.pocketR of it on that side may
   *    hold a spawn (NAV_POCKET): an enemy there is out of sight until he walks in through the real door.
   * Build time (allocates).
   * @param {import('./Layout.js').Layout} L @param {string[]} notes
   */
  markHidden(L, notes) {
    const nav = this.nav, n = nav.count, fl = nav.flags;
    /** @type {import('./Layout.js').Box[]} */ const curtains = [];
    L.curtains = curtains;
    this.hiddenRooms = 0;
    for (let i = 0; i < n; i++) if ((fl[i] & NAV_POCKET) !== 0) fl[i] |= NAV_HIDDEN;
    let realWalls = 0;
    for (const w of L.walls) if (!w.inferred) realWalls++;
    if (L.virtual || realWalls < 3) return;
    const minCells = Math.max(1, Math.round(ROAM.minRoomM2 / (nav.cell * nav.cell)));
    const rooms = nav.labelRooms(minCells, this.roamIndex.maxRooms);
    if (rooms > 0) {
      const room = nav.room, cnt = new Int32Array(rooms + 1), seen = new Int32Array(rooms + 1), vote = new Int32Array(rooms + 1);
      for (let i = 0; i < n; i++) if (room[i]) cnt[room[i]]++;
      for (let i = 0; i < n; i++) {
        const r = room[i];
        if (!r || (fl[i] & NAV_VIRTUAL) !== 0) continue;
        const stride = Math.max(1, Math.floor(cnt[r] / HIDDEN.voteCells));
        if (seen[r]++ % stride !== 0) continue;
        vote[r] += scannedSideVote(L.walls, nav.centerX(i), nav.centerZ(i));
      }
      // ... and reaches the map's open edge (an inferred wall, or off the floor with no real wall near): the space
      // between the scanned walls and the floor polygon's edge. A room closed by real walls alone is never hidden,
      // whichever way its interior walls face (one wall plane between two scanned rooms faces only one of them).
      const edge = new Uint8Array(rooms + 1), w = nav.w, h = nav.h;
      const open = (/** @type {number} */ j) => (fl[j] & NAV_IWALL) !== 0 || (fl[j] & (NAV_INSIDE | NAV_SHIELD | NAV_WALL)) === 0;
      for (let i = 0; i < n; i++) {
        const r = room[i];
        if (!r || edge[r] || vote[r] >= 0) continue;
        const ix = i % w, iz = (i - ix) / w;
        if ((ix > 0 && open(i - 1)) || (ix < w - 1 && open(i + 1)) || (iz > 0 && open(i - w)) || (iz < h - 1 && open(i + w))) edge[r] = 1;
      }
      // v0.5: a room the walkthrough scan walked through (3 or more walked points in it) is scanned space
      const walkedIn = new Int32Array(rooms + 1);
      const W = /** @type {any} */ (L).scanWalked;
      if (Array.isArray(W)) for (const q of W) { const i = nav.index(q[0], q[1]); if (i >= 0 && room[i]) walkedIn[room[i]]++; }
      const hid = new Uint8Array(rooms + 1);
      for (let r = 1; r <= rooms; r++) if (vote[r] < 0 && edge[r] && walkedIn[r] < 3) { hid[r] = 1; this.hiddenRooms++; }
      if (this.hiddenRooms) for (let i = 0; i < n; i++) if (hid[room[i]]) fl[i] |= NAV_HIDDEN;
    }
    // where a probe point stands: 2 scanned floor, 1 hidden floor, 0 no floor
    const status = (/** @type {number} */ x, /** @type {number} */ z) => {
      const i = nav.index(x, z);
      if (i < 0 || (fl[i] & NAV_INSIDE) === 0) return 0;
      return (fl[i] & NAV_HIDDEN) !== 0 ? 1 : 2;
    };
    const side = (/** @type {import('./Layout.js').Door} */ d, /** @type {number} */ sg) => {
      let best = 0;
      for (const r of [0.45, 0.7, 0.95]) {
        const st = status(d.cx + d.nx * r * sg, d.cz + d.nz * r * sg);
        if (st === 2) return 2;
        if (st === 1) best = 1;
      }
      return best;
    };
    let pockets = 0;
    for (const d of L.doors) {
      if (!d.open || d.walls === 0 || curtains.length >= HIDDEN.maxCurtains) continue;
      const f = side(d, 1), b = side(d, -1);
      if ((f === 2) === (b === 2)) continue; // scanned on both sides, or on neither
      const sg = f === 2 ? -1 : 1, hx = d.nx * sg, hz = d.nz * sg;
      // the far face of the door's wall slab(s), measured from the door centre toward the hidden side
      let far = 0.03, top = d.y1;
      for (let k = 0; k < d.wallIds.length; k++) {
        const w = L.walls[d.wallIds[k]], off = d.offsets[k];
        const s0 = w.centred ? -WALL_T / 2 - off : -WALL_T - off, s1 = w.centred ? WALL_T / 2 - off : -off;
        const kk = w.nx * hx + w.nz * hz >= 0 ? 1 : -1;
        far = Math.max(far, kk * s0, kk * s1);
        top = Math.max(top, w.y1);
      }
      if (far > 0.4) far = 0.4;
      const t = HIDDEN.curtainT / 2, half = d.width / 2 + HIDDEN.curtainPad;
      curtains.push({
        cx: d.cx + hx * (far + t), cz: d.cz + hz * (far + t), c: d.tx, s: d.tz, hx: half, hz: t,
        y0: d.y0 - 0.02, y1: Math.max(d.y1, Math.min(d.y1 + HIDDEN.curtainPad, top)), label: 'curtain', kind: 'curtain', face: 0,
        jamb0: false, jamb1: false, lintel: false, sill: false, navBlock: false, source: 'curtain', wall: -1,
        nx: hx, nz: hz, door: d.id,
      });
      // spawn room right behind it: hidden floor within pocketR, on the far side
      if (b === 1 || f === 1) {
        const R = HIDDEN.pocketR, R2 = R * R;
        const ix0 = Math.max(0, Math.floor((d.cx - R - nav.ox) * nav.inv)), ix1 = Math.min(nav.w - 1, Math.floor((d.cx + R - nav.ox) * nav.inv));
        const iz0 = Math.max(0, Math.floor((d.cz - R - nav.oz) * nav.inv)), iz1 = Math.min(nav.h - 1, Math.floor((d.cz + R - nav.oz) * nav.inv));
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const i = iz * nav.w + ix;
            if ((fl[i] & (NAV_HIDDEN | NAV_INSIDE)) !== (NAV_HIDDEN | NAV_INSIDE) || (fl[i] & NAV_POCKET) !== 0) continue;
            const dx = nav.centerX(i) - d.cx, dz = nav.centerZ(i) - d.cz;
            if (dx * dx + dz * dz > R2 || dx * hx + dz * hz < far + 0.2) continue;
            fl[i] |= NAV_POCKET;
            pockets++;
          }
        }
      }
    }
    if (this.hiddenRooms) notes.push(`${this.hiddenRooms} room(s) behind the real walls: unscanned, hidden (spawns only next to their doors)`);
    if (curtains.length) notes.push(`${curtains.length} door curtain(s): enemies beyond a door into unscanned space stay hidden until they walk through`);
    this.stats.hiddenPocketCells = pockets;
  }

  /** The curtains' planes for trackCurtains (build and commit; allocation-free). */
  indexCurtains() {
    const C = this.layout && this.layout.curtains ? this.layout.curtains : [], D = this.curtainData;
    const m = Math.min(C.length, HIDDEN.maxCurtains);
    for (let k = 0; k < m; k++) {
      const c = /** @type {any} */ (C[k]), o = k * CURTAIN_STRIDE;
      D[o] = c.cx; D[o + 1] = c.cz; D[o + 2] = c.nx; D[o + 3] = c.nz; D[o + 4] = c.c; D[o + 5] = c.s; D[o + 6] = c.hx;
    }
    this.curtainCount = m;
    this.curtainsOn = true;
    this._curtainCell = -2;
  }

  /**
   * Curtains on or off for the player's head (allocation-free; the planes are looked at only when the head
   * enters another nav cell): off while the head stands on a hidden cell, or has reached a curtain's plane
   * (within HIDDEN.pastFront of it, inside its width + pastSide): from there a curtain would hide the scanned
   * room the player looks back into.
   * @param {{ x: number, z: number }} h
   */
  trackCurtains(h) {
    const P = this._curtainP;
    P[0] = h.x; P[1] = h.z;
    this.curtainStep();
  }

  /** trackCurtains' work on `_curtainP`. */
  curtainStep() {
    if (this.curtainCount === 0) { this.curtainsOn = true; return; }
    const nav = this.nav, P = this._curtainP, x = P[0], z = P[1];
    const ix = Math.floor((x - nav.ox) * nav.inv), iz = Math.floor((z - nav.oz) * nav.inv);
    const inGrid = ix >= 0 && iz >= 0 && ix < nav.w && iz < nav.h;
    const i = inGrid ? iz * nav.w + ix : -1;
    if (i === this._curtainCell) return;
    this._curtainCell = i;
    let on = !(i >= 0 && (nav.flags[i] & NAV_HIDDEN) !== 0);
    const D = this.curtainData, front = this._curtainK[0], sideK = this._curtainK[1];
    for (let k = 0; k < this.curtainCount && on; k++) {
      const o = k * CURTAIN_STRIDE, dx = x - D[o], dz = z - D[o + 1];
      const along = dx * D[o + 2] + dz * D[o + 3], lat = dx * D[o + 4] + dz * D[o + 5];
      if (along > front && along < 3 && (lat < 0 ? -lat : lat) < D[o + 6] + sideK) on = false;
    }
    this.curtainsOn = on;
  }

  /**
   * The global mesh step of a build (snapshot v2): prep (orient, classify,
   * crop, tiles), the BVH, the occluder tiles, the static colliders; the
   * covered furniture boxes are marked on the layout. Without a mesh: planes
   * and boxes only (statics from the layout). Allocates (build time).
   * @param {any} snap normalized snapshot (its `raw` carries the triangles)
   * @param {import('./Layout.js').Layout} L @param {number} sx @param {number} sz @param {string[]} notes
   * @param {number} want 0 no mesh, 1 the mesh within syncMeshMaxTris, 2 the mesh whatever its size
   */
  buildMesh(snap, L, sx, sz, notes, want) {
    this.bvh = null;
    this.meshTiles = null;
    this.meshStats = null;
    this.lastPrepped = null;
    this.coveredFurniture = 0;
    let raw = want && this.useMesh && snap && !L.virtual ? globalRawMesh(snap) : null;
    if (snap && snap.globalMesh && want && this.useMesh && !raw && !L.virtual) {
      notes.push(rawOf(snap) ? 'global mesh lent to the worker: built without it' : 'global mesh not decoded (no triangles): planes and boxes only');
    }
    if (raw && want === 1 && raw.data.indices.length / 3 > this.syncMeshMaxTris) {
      notes.push(`global mesh (${raw.data.indices.length / 3} triangles) left to the worker: a synchronous build here uses planes and boxes only`);
      raw = null;
    }
    if (!raw) {
      this.statics = buildStatics(L, null, null);
      this.stats.meshTris = 0;
      return;
    }
    const t0 = now();
    const p = prepMesh({ vertices: raw.data.vertices, indices: raw.data.indices, pose: raw.pose }, L, { start: { x: sx, z: sz } });
    const t1 = now();
    for (let k = 0; k < L.furniture.length; k++) {
      L.furniture[k].covered = p.covered[k] === 1;
      if (p.covered[k]) this.coveredFurniture++;
    }
    if (p.indices.length >= 3) this.bvh = new MeshBVH().build(p.vertices, p.indices, p.surf, p.owner);
    const t2 = now();
    this.statics = buildStatics(L, p, colliderPositions(p));
    // occIdx: tile-local + the tile's vertex start (the occluder's index buffer as is: uploads are memcpy)
    const occIdx = this.statics.mesh ? this.statics.mesh.indices : p.tileIdx;
    this.meshTiles = { tiles: p.tiles, tileBounds: p.tileBounds, tileCount: p.tileCount, tileIdx: p.tileIdx, occIdx, occPos: occluderPositions(p), verts: p.tileVerts.length };
    this.meshStats = { ...p.stats, bvhMs: Math.round((t2 - t1) * 10) / 10, bvhNodes: this.bvh ? this.bvh.nodeCount : 0, bvhDepth: this.bvh ? this.bvh.depth : 0 };
    this.lastPrepped = p;
    this.stats.meshTris = p.indices.length / 3;
    this.stats.meshMs = Math.round((t1 - t0) * 10) / 10;
    this.stats.bvhMs = this.meshStats.bvhMs;
    for (const f of /** @type {any} */ (p.stats).floorFix || []) {
      notes.push(`floor ${f.floor} moved ${Math.round((f.to - f.from) * 1000) / 10} cm to its scanned surface (${f.to}, ${f.area} m² of scan)`);
    }
    if (!p.stats.oneSided) notes.push(`global mesh orientation uncertain (${p.stats.upVotePct} % agree): two-sided colliders`);
    if (p.stats.truncated) notes.push(`global mesh truncated: ${p.stats.truncated} triangles over the cap`);
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

  // ── worker builds (async, time-sliced on the main thread) ───────────────

  /**
   * Build in the world worker from now on (WorldWorker.js `createWorldBuilder`);
   * null: build here (synchronously) again.
   * @param {any} builder `{ post(msg, transfer), onResult, failed }`
   */
  attachBuilder(builder) {
    this.builder = builder || null;
    if (builder) builder.onResult = (/** @type {any} */ r) => this.onBuildResult(r);
  }

  /** A worker build is in flight, being copied in or uploading (queries see the previous world until the commit). */
  get busy() { return this.buildPhase !== BUILD.IDLE || this._next !== null && this._next !== undefined; }

  /**
   * `build` in the world worker: the layout, nav grid, Roam bake (all of it),
   * spawn candidates, the mesh prep, BVH, occluder tiles and static colliders
   * run there; `update()` then copies the result into this world's own arrays
   * within `applyBudgetMs` a frame (0.5 ms), commits it in one step (the world
   * switches over atomically: until then every query answers from the previous
   * build), and World uploads the occluder tiles at most one range a frame.
   * The promise resolves true when everything is in place (false: superseded or
   * skipped). Without a worker (or after it failed) this is `build()`.
   * The snapshot's mesh arrays are lent to the worker meanwhile (transferred
   * there and back): a second request waits for them.
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart
   * @param {{ doors?: ArrayLike<boolean|undefined|null>|null, roam?: boolean, mesh?: boolean, force?: boolean }} [opts]
   *   force: never skip (a rebuild or realign)
   * @returns {Promise<boolean>}
   */
  buildAsync(snapshot, playerStart, opts = {}) {
    return new Promise((resolve) => {
      const req = { snapshot, start: { x: playerStart ? +playerStart.x : 0, z: playerStart ? +playerStart.z : 0, r: playerStart && playerStart.r !== undefined ? +playerStart.r : undefined },
        opts: { doors: opts.doors ? Array.from(opts.doors) : null, roam: typeof opts.roam === 'boolean' ? opts.roam : this.roam, mesh: opts.mesh !== false }, force: !!opts.force, resolve };
      if (this.buildPhase !== BUILD.IDLE) {
        if (this._next) this._next.resolve(false);
        this._next = req;
        return;
      }
      this.startRequest(req);
    });
  }

  /** rebuild() in the worker (door flags changed). @returns {Promise<boolean>} */
  rebuildAsync() {
    return this.buildAsync(this.snapshot, this.start, { doors: this.doorOpen.slice(), roam: this.roamOn, force: true });
  }

  /**
   * realign() in the worker (behind the held pause): the stored snapshot and
   * start moved by m (old → new), or a fresh capture.
   * @param {ArrayLike<number>|null} m @param {import('./Layout.js').SpaceSnapshot|null} [snapshot]
   * @returns {Promise<boolean>}
   */
  realignAsync(m, snapshot = null) {
    const st = { x: this.start.x, z: this.start.z, r: this.start.r };
    if (m) transformPointXZ(m, st);
    const snap = snapshot || (this.snapshot && m ? transformSnapshot(this.snapshot, m) : this.snapshot);
    this.stats.realigns++;
    return this.buildAsync(snap, st, { doors: snapshot ? null : this.doorOpen.slice(), roam: this.roamOn, force: true });
  }

  /** @param {any} req */
  startRequest(req) {
    const { snapshot, start, opts } = req;
    if (!req.force && opts.roam && this.canSkip(snapshot, opts.doors, start.x, start.z)) {
      req.resolve(this.build(snapshot, start, opts));
      return;
    }
    const B = this.builder;
    if (!B || B.failed) {
      if (req.force) this.built = false; // never skipped
      req.resolve(this.build(snapshot, start, opts));
      return;
    }
    const seq = ++this._seq;
    const raw = opts.mesh && this.useMesh ? globalRawMesh(snapshot) : null;
    /** @type {ArrayBuffer[]} */ const transfer = [];
    /** @type {any} */ let mesh = null;
    if (raw) {
      const d = raw.data;
      // own buffers only (a view into a larger buffer would detach its neighbours)
      if (d.vertices.byteOffset !== 0 || d.vertices.byteLength !== d.vertices.buffer.byteLength) d.vertices = d.vertices.slice();
      if (d.indices.byteOffset !== 0 || d.indices.byteLength !== d.indices.buffer.byteLength) d.indices = d.indices.slice();
      mesh = { label: raw.label, pose: Array.from(raw.pose), lastChangedTime: raw.lastChangedTime, vertices: d.vertices, indices: d.indices };
      transfer.push(/** @type {ArrayBuffer} */ (d.vertices.buffer), /** @type {ArrayBuffer} */ (d.indices.buffer));
    }
    const gm = snapshot && /** @type {any} */ (snapshot).globalMesh;
    let snapMsg = snapshot;
    if (gm && raw && typeof gm.data === 'string') { const { data, ...meta } = gm; snapMsg = { ...snapshot, globalMesh: meta }; }
    const msg = { type: 'build', seq, cfg: this.config, snapshot: snapMsg, mesh, start, opts, encode: !!(raw && gm && typeof gm.data !== 'string') };
    this._pending = { ...req, seq, t0: this.clock(), lent: raw ? raw.data : null };
    this._incoming = null;
    this.buildPhase = BUILD.WORKING;
    try {
      B.post(msg, transfer);
    } catch (e) {
      this.restoreLent(this._pending, mesh);
      this.buildFallback(`worker post failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * The worker's answer (outside the frame loop: a message event). Only
   * stores it; `update()` applies it.
   * @param {any} r
   */
  onBuildResult(r) {
    const P = this._pending;
    if (!P || !r || r.seq !== P.seq) return;
    this.restoreLent(P, r.mesh);
    this._incoming = r;
  }

  /**
   * Give the lent mesh arrays back to the snapshot's holder.
   * @param {any} P @param {any} mesh
   */
  restoreLent(P, mesh) {
    if (!P || !P.lent || !mesh || !mesh.vertices || !mesh.indices) return;
    P.lent.vertices = mesh.vertices;
    P.lent.indices = mesh.indices;
    P.lent = null;
  }

  /**
   * One step of the async build (from update()): wait, copy (within the
   * budget), commit, upload (World), done.
   * @param {number} t
   */
  buildStep(t) {
    const P = this._pending;
    if (!P) { this.buildPhase = BUILD.IDLE; this.startNext(); return; }
    const c0 = this.clock();
    switch (this.buildPhase) {
      case BUILD.WORKING: {
        const r = this._incoming;
        if (!r) {
          if (c0 - P.t0 > this.buildTimeoutMs) {
            if (this.builder) this.builder.failed = true;
            this.buildFallback(`world worker did not answer in ${this.buildTimeoutMs} ms`);
          }
          return;
        }
        if (!r.ok) { this.buildFallback(`world worker failed: ${r.error || 'unknown'}`); return; }
        if (this._next) { this.finishBuild(false); return; } // superseded: a newer request is waiting
        const err = this._copy.begin(this, r.state.arrays);
        if (err) { this.buildFallback(err); return; }
        this.buildPhase = BUILD.COPY;
        return;
      }
      case BUILD.COPY: {
        if (this._copy.step(this.clock, c0 + this.applyBudgetMs)) this.buildPhase = BUILD.COMMIT;
        this.noteApply(c0, 'copy');
        return;
      }
      case BUILD.COMMIT: {
        this.commitBuild(P, this._incoming);
        this.buildPhase = this.afterCommit() ? BUILD.UPLOAD : BUILD.IDLE;
        this.noteApply(c0, 'commit');
        if (this.buildPhase === BUILD.IDLE) this.finishBuild(true);
        return;
      }
      case BUILD.UPLOAD: {
        const done = this.uploadStep();
        this.noteApply(c0, 'upload');
        if (done) { this.buildPhase = BUILD.IDLE; this.finishBuild(true); }
        return;
      }
      default:
    }
  }

  /** @param {number} c0 @param {'copy'|'commit'|'upload'} phase */
  noteApply(c0, phase) {
    const ms = this.clock() - c0;
    const S = this.stats;
    S.applyFrames++;
    if (ms > S.applyMaxMs) S.applyMaxMs = Math.round(ms * 1000) / 1000;
    if (ms > S.applyPhaseMs[phase]) S.applyPhaseMs[phase] = Math.round(ms * 1000) / 1000;
  }

  /** @param {boolean} ok */
  finishBuild(ok) {
    const P = this._pending;
    this._pending = null;
    this._incoming = null;
    this.buildPhase = BUILD.IDLE;
    if (P) P.resolve(ok);
    this.startNext();
  }

  startNext() {
    const n = this._next;
    if (!n) return;
    this._next = null;
    this.startRequest(n);
  }

  /**
   * The worker failed or timed out: build here instead (behind the same panel
   * or pause the caller holds; a hitch, noted in the stats).
   * @param {string} why
   */
  buildFallback(why) {
    const P = this._pending;
    this._pending = null;
    this._incoming = null;
    this.buildPhase = BUILD.IDLE;
    if (!P) return;
    this.built = false;
    const ok = this.build(P.snapshot, P.start, P.opts);
    this.stats.notes.push(why + ': built on the main thread');
    P.resolve(ok);
    this.startNext();
  }

  /**
   * Switch to the copied build: scalars, layout, adopted buffers (BVH,
   * occluder tiles, statics, door fields). One step, after the copy.
   * @param {any} P the request @param {any} r the worker's result
   */
  commitBuild(P, r) {
    const s0 = this.stats;
    const keep = { builds: s0.builds, skippedBuilds: s0.skippedBuilds, realigns: s0.realigns, workerBuilds: s0.workerBuilds, applyFrames: s0.applyFrames,
      applyMaxMs: s0.applyMaxMs, applyPhaseMs: s0.applyPhaseMs };
    const st = r.state;
    commitScalars(this, st.meta);
    this.indexCurtains();
    Object.assign(this.stats, keep);
    this.stats.builds++;
    this.stats.workerBuilds++;
    this.stats.workerMs = r.ms;
    this.stats.buildMs = r.buildMs;
    const R = this.roamIndex;
    if (st.adopt.fields && st.adopt.fields.length >= R.fields.length) R.fields = st.adopt.fields;
    else if (st.adopt.fields) R.fields.set(st.adopt.fields);
    R.pCell = -2; R.pRoomA = R.pRoomB = R.lastRoom = 0; R.pDoor = -1; R.pAnchor = -1; R.pDoorN = 0;
    if (!this.roamOn) R.clear();
    this.nav.version++;
    this.nav.pathSource = this.roamOn ? R : null;
    this.bvh = st.adopt.bvh ? MeshBVH.fromBuffers(st.adopt.bvh) : null;
    this.meshTiles = st.adopt.tiles || null;
    this.statics = st.adopt.statics || null;
    /** The World's occluder buffers made in the worker (box occluder with / without covered furniture, overlay). */
    this.occAdopt = st.adopt.occ || null;
    this.lastPrepped = null;
    this.snapshot = P.snapshot;
    this.skipped = false;
    this.roamFailStreak = 0;
    this.built = true;
    const gm = P.snapshot && P.snapshot.globalMesh;
    if (r.record && gm && typeof gm === 'object') Object.assign(gm, r.record); // the session record's copy of the mesh
  }

  /** After a commit: the subclass's own buffers (World: occluders). @returns {boolean} an upload phase follows */
  afterCommit() { return false; }

  /** One upload step (World). @returns {boolean} done */
  uploadStep() { return true; }

  /**
   * This world's state as transferable arrays + meta (the worker's export; allocates).
   */
  exportState() {
    return exportCore(this);
  }

  /**
   * The session record's copy of the last synchronous build's global mesh
   * (async: gzip). A worker build fills `snapshot.globalMesh` by itself.
   * @returns {Promise<any|null>}
   */
  async encodeMeshRecord() {
    const p = this.lastPrepped, snap = this.snapshot;
    if (!p) return null;
    const { encodeMeshRecord } = await import('./MeshCodec.js');
    const rec = { space: 'reference', ...(await encodeMeshRecord(p.raw)) };
    if (snap && /** @type {any} */ (snap).globalMesh) Object.assign(/** @type {any} */ (snap).globalMesh, rec);
    return rec;
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
    // the same house with a synthetic scan (the mesh paths: prep, BVH, statics, mesh rays)
    const snapM = b.build();
    const scan = scanFromSnapshot(snapM, { cell: 0.3, clutter: [{ cx: 2.5, cz: 3.2, hx: 0.25, hz: 0.25, h: 0.9 }] });
    const ident = new Float64Array(16);
    ident[0] = ident[5] = ident[10] = ident[15] = 1;
    attachRaw(snapM, { token: 0, global: 0, meshes: [{ label: 'global mesh', pose: ident, lastChangedTime: 0, data: { vertices: scan.vertices, indices: scan.indices } }] });
    const below = { y: 0, nx: 0, ny: 0, nz: 0, surface: '', dist: 0 };
    for (let k = 0; k < 4; k++) {
      const roam = k >= 2;
      this.built = false;
      this.build(roam ? snapM : snap, { x, z }, { doors: k === 1 ? [true, false] : null, roam });
      if (roam) {
        this.finishBake();
        this.roamIndex.trackPlayer(x, z);
        this.edgeMargin(x, z);
        for (let i = 0; i < 4; i++) this.spawnRoam(x + i * 0.3, z, 0.4, 0, 1, 0, out);
        const pl = { head: { x, z }, vel: { x: 0.3, z: 0 }, flatForward: { x: 1, z: 0 } };
        for (let i = 0; i < 4; i++) { pl.head.x = x - i * 0.3; this.spawnRoamFor(pl, out); this.update(0.014, i * 14, null, { player: pl }); }
      }
      this.findSpawn(x, z, 1, 0, 3, out);
      for (let i = 0; i < 64; i++) {
        this.raycast(x, 1.5, z, Math.cos(i), -0.1 - (i & 3) * 0.2, Math.sin(i), 20, hit);
        this.segmentClear(x, 1.5, z, x + Math.cos(i) * 4, 0.6, z + Math.sin(i) * 4);
        this.surfaceBelow(x + Math.cos(i), 1.2, z + Math.sin(i), 2, below);
      }
      this.staticGeometry();
      this.report();
    }
    // the worker path's main-thread half: export → sliced copy → commit → the subclass's uploads
    // (into this same world), a few rounds so the first real one does not run cold
    for (let round = 0; round < 4; round++) {
      const ex = this.exportState();
      const req = { snapshot: snapM, start: { x, z }, opts: {}, resolve: () => {}, seq: 0, lent: null };
      if (this._copy.begin(this, ex.arrays)) break;
      while (!this._copy.step(this.clock, this.clock() + 0.2));
      this.commitBuild(req, { state: { meta: ex.meta, arrays: ex.arrays, adopt: ex.adopt }, ms: 0, buildMs: 0, record: null });
      for (let i = 0; i < 16; i++) this.raycast(x, 1.0, z, Math.cos(i), -0.3, Math.sin(i), 20, hit);
      this.afterCommit();
      while (!this.uploadStep());
    }
    this.stats.applyFrames = 0;
    this.stats.applyMaxMs = 0;
    this.stats.applyPhaseMs = { copy: 0, commit: 0, upload: 0 };
    this.stats.workerBuilds = 0;
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
    // Mapped floors first; virtual floors (patch, pockets) only where no mapped floor is. Where floors overlap
    // the smallest claims the cell (v0.4.1: the living room's 111 m² rectangle reached over half the bedroom and
    // its hall, so enemies there stood on the living room's plane, 7.5 cm off the bedroom's; floorHeightAt agrees).
    const order = L.floors.map((_, k) => k).sort((a, b) => L.floors[a].area - L.floors[b].area || a - b);
    for (let pass = 0; pass < 2; pass++) {
      for (const k of order) {
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
    const hit = this.shapes.raycast(ox, oy, oz, dx, dy, dz, max, out);
    const B = this.bvh;
    if (B === null) return hit;
    // the mesh (furniture the scan covers, unlabelled clutter) within the box hit's distance
    if (B.raycast(ox, oy, oz, dx, dy, dz, hit ? out.dist : max, out)) {
      out.surface = this.meshLabel(B.lastTri);
      return true;
    }
    return hit;
  }

  /**
   * Line of sight between two points (walls, lintels, furniture; the global mesh when present).
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} bx @param {number} by @param {number} bz
   */
  segmentClear(ax, ay, az, bx, by, bz) {
    return this.shapes.segmentClear(ax, ay, az, bx, by, bz) && (this.bvh === null || this.bvh.segmentClear(ax, ay, az, bx, by, bz));
  }

  /**
   * The hit label of a mesh triangle (BVH leaf order): its furniture's label
   * ('bed', 'table', …), else its class ('other' for unlabelled clutter).
   * @param {number} tri
   */
  meshLabel(tri) {
    const B = this.bvh;
    if (B === null || tri < 0) return 'other';
    const f = B.owner[tri];
    const L = this.layout;
    if (f >= 0 && L !== null && f < L.furniture.length) return L.furniture[f].label;
    return SURF_NAME[B.surf[tri]] || 'other';
  }

  /**
   * The surface under a point: a ray straight down at most `maxDown` m (walls,
   * furniture boxes, the floor, the mesh). Allocation-free; writes `out` only
   * on a hit: y, the normal, the label and the drop (`dist`).
   * @param {number} x @param {number} y @param {number} z @param {number} maxDown
   * @param {{ y: number, nx: number, ny: number, nz: number, surface: string, dist: number }} out
   */
  surfaceBelow(x, y, z, maxDown, out) {
    const h = this._hit;
    if (!this.raycast(x, y, z, 0, -1, 0, maxDown, h)) return false;
    out.y = h.y; out.nx = h.nx; out.ny = h.ny; out.nz = h.nz; out.surface = h.surface; out.dist = h.dist;
    return true;
  }

  /**
   * Static collider geometry for physics (see WorldStatics.js): wall slabs,
   * furniture surfaces or backstops, a catch slab, floor / ceiling prisms and
   * the oriented global mesh as trimesh tiles. Built with the world (worker or
   * synchronous build); the same object until the next build. Null before a build.
   * @returns {import('./WorldStatics.js').StaticGeometry|null}
   */
  staticGeometry() {
    return this.built ? this.statics : null;
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
    if (this.buildPhase !== BUILD.IDLE) this.buildStep(t);
    if (!this.built || this.buildPhase === BUILD.COPY) return;
    const p = ctx && ctx.player;
    if (p && p.valid !== false) this.trackCurtains(p.head);
    if (!this.roamOn) return;
    const R = this.roamIndex;
    if (R.baking) R.step(this.bakeBudgetMs);
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
        curtain: !!(L.curtains && L.curtains.some((c) => /** @type {any} */ (c).door === d.id)),
      })),
      hidden: { rooms: s.hiddenRooms || 0, curtains: L.curtains ? L.curtains.length : 0, pocketCells: s.hiddenPocketCells || 0 },
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
      mesh: this.meshStats ? {
        tris: this.meshStats.rawTris, kept: this.meshStats.keptTris, cropped: { ...this.meshStats.cropped }, classes: this.meshStats.classes.slice(),
        upVotePct: this.meshStats.upVotePct, flippedPct: this.meshStats.flippedPct, oneSided: this.meshStats.oneSided,
        components: this.meshStats.components, covered: this.coveredFurniture, tiles: this.meshStats.tiles,
        prepMs: this.meshStats.ms, bvhMs: this.meshStats.bvhMs, bvhNodes: this.meshStats.bvhNodes, bvhDepth: this.meshStats.bvhDepth,
      } : null,
      statics: this.statics ? { ...this.statics.stats } : null,
      worker: { builds: s.workerBuilds, ms: Math.round(s.workerMs * 10) / 10, applyFrames: s.applyFrames, applyMaxMs: s.applyMaxMs, phaseMs: { ...s.applyPhaseMs } },
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
    const bvh = this.bvh ? this.bvh.bytes() : 0;
    const T = this.meshTiles;
    const tiles = T ? T.tiles.byteLength + T.tileBounds.byteLength + T.tileIdx.byteLength + T.occPos.byteLength : 0;
    const G = this.statics;
    const statics = G ? G.slabs.byteLength + G.prisms.byteLength + G.floorPts.byteLength
      + (G.mesh ? G.mesh.vertices.byteLength + G.mesh.indices.byteLength + G.mesh.chunks.byteLength : 0) : 0;
    const total = navB + this.roamIndex.bytes() + this.shapes.box.byteLength + bvh + tiles + statics;
    return { nav: navB, roam: this.roamIndex.bytes(), shapes: this.shapes.box.byteLength, bvh, tiles, statics, total };
  }
}
