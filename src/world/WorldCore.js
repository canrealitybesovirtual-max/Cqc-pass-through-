// @ts-check
/**
 * The world without three.js (pure, so Node tests cover all of it): layout,
 * analytic shapes, nav grid and spawn finder. `World.js` adds the occluder mesh.
 *
 * Built once per session (behind the "Get ready" panel) from a SpaceSnapshot;
 * never rebuilt during play. Every query after build is allocation-free.
 */

import { buildLayout, floorHeightAt } from './Layout.js';
import { NAV_DOOR, NAV_FURN, NAV_INSIDE, NAV_OBST, NAV_VIRTUAL, NAV_WALL, NAV_ZONE, NavGrid } from './NavGrid.js';
import { PathPlanner } from './PathPlanner.js';
import { ShapeSet } from './Shapes.js';
import { normalizeSnapshot } from './Snapshot.js';
import { SnapshotBuilder } from './SnapshotBuilder.js';
import { SpawnFinder } from './Spawner.js';
import { pointInPolygon } from '../util/geom2d.js';

/** Enemy radius 0.25 m + 0.03 m (PLAN §9). */
export const AGENT_CLEARANCE = 0.28;
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
    this.stats = {
      buildMs: 0, floors: 0, walls: 0, doors: 0, furniture: 0, shapes: 0, droppedShapes: 0,
      cells: 0, walkable: 0, regions: 0, spawnCandidates: 0, doorSpawnCandidates: 0,
      /** @type {string[]} */ notes: [],
    };
  }

  /**
   * One-time build at session start. `null` (or a snapshot with no floor) gives a
   * virtual open room centred on the player.
   * @param {import('./Layout.js').SpaceSnapshot|null} snapshot
   * @param {{ x: number, z: number, r?: number }} playerStart where the player stands (r = safe-zone radius, default 0.8)
   */
  build(snapshot, playerStart) {
    const t0 = now();
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

    const L = buildLayout(snap, { x: sx, z: sz });
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
    this.spawner.build(this.nav, r);

    const s = this.stats;
    s.floors = L.floors.length;
    s.walls = L.walls.length;
    s.doors = L.doors.length;
    s.furniture = L.furniture.length;
    s.shapes = this.shapes.count;
    s.droppedShapes = this.shapes.dropped;
    s.cells = this.nav.count;
    s.walkable = this.nav.walkableCount;
    s.regions = this.nav.regionCount;
    s.spawnCandidates = this.spawner.count;
    s.doorSpawnCandidates = this.spawner.doorCount;
    s.notes = notes;
    s.buildMs = now() - t0;
    this.built = true;
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
    for (const r of [r1, r2]) for (let i = 0; i < 4; i++) b.wall(r[i][0], r[i][1], r[(i + 1) % 4][0], r[(i + 1) % 4][1], 0, 2.5, { extend: 0.05 });
    b.door(5, 1.5, 5, 2.35, 0, 2.03, { offset: -0.01 }).door(2, 4, 1.1, 4, 0, 2.03);
    b.top('table', 2.5, 1.2, 0.6, 0.4, 0.75, 0.2).box('table', 2.5, 1.2, 0.6, 0.4, 0, 0.75, { yaw: 0.2 });
    b.top('bed', 7, 3, 0.9, 0.8, 0.55).box('bed', 7, 3, 0.9, 0.8, 0, 0.55).box(null, 4.5, 3.5, 0.2, 0.3, 0, 1.6, { zUp: true });
    const [x, z] = b.toWorld(1.5, 2);
    const out = { x: 0, z: 0 }, hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: '', surface: '', enemy: -1, part: '' };
    for (let k = 0; k < 2; k++) {
      this.build(b.build(), { x, z });
      this.findSpawn(x, z, 1, 0, 3, out);
      for (let i = 0; i < 64; i++) this.raycast(x, 1.5, z, Math.cos(i), -0.1, Math.sin(i), 20, hit);
    }
    this.build(null, { x: 0, z: 0 });
    this.built = false;
    this.layout = null;
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
      nav.fillPolygon(f.pts, f.n, NAV_INSIDE | (f.virtual ? NAV_VIRTUAL : 0), k < 127 ? k : -1);
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
      if (d.walkable) nav.fillBox(d.cx, d.cz, d.tx, d.tz, d.width / 2, DOOR_DEPTH, 0, NAV_DOOR, NAV_WALL);
    }
    nav.computeClearance(NAV_WALL | NAV_OBST);
    nav.fillDisc(sx, sz, r + ZONE_EXTRA, NAV_ZONE);
    nav.finalize(this.agentClearance, sx, sz);
    if (nav.startCell < 0) notes.push('no walkable floor near the player: enemies cannot reach you');
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
    return `Space: ${s.floors} floor${s.floors === 1 ? '' : 's'}, ${s.walls} walls, ${s.doors} doors, ${s.furniture} objects${this.partialVirtual ? ' (+ virtual floor around you)' : ''}`;
  }
}
