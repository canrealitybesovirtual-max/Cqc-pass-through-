// @ts-check
/**
 * Rigid bodies on the real house: dropped and thrown guns and magazines (pure:
 * no three.js, no DOM; Node-testable with the vendored Rapier). Research spec
 * §5–§7 and the CQC lessons (values and lessons only).
 *
 * - **Load:** `new PhysicsWorld(R)` after `loadRapier()`, `defineKind` for
 *   every item (hulls from the GLBs), then `warmUp()`: a scratch world runs
 *   every collider pair the session meets (hull against cuboid, prism,
 *   one-sided and two-sided trimesh, and hull), CCD, the release queries and
 *   every JS path, so neither the lazy wasm compile (measured 37–52 ms first
 *   contacts) nor a cold JIT ever hits play.
 * - **Statics:** `beginStatic(geo)` then `buildSlice(ms)` each frame until
 *   `ready` (behind the "Get ready" panel or a pause; StaticGeometry.js).
 * - **Step:** fixed h = 1/90 s, `floor((acc += dt) / h)` steps, at most 3 a
 *   frame (a longer hitch is dropped, never caught up), with interpolation
 *   between the last two steps for the display (`readPose`). When nothing is
 *   awake (and nothing was spawned) `step()` does nothing at all: no Rapier
 *   call, no allocation. While something moves, Rapier's wasm glue allocates
 *   about 0.15 KB a step and 0.03 KB per awake-body read (measured; the
 *   project's one exception to the zero-allocation rule, only while items
 *   move), and only awake bodies are read.
 * - **Sleep:** linear speed under 0.05 m/s and angular under 0.35 rad/s for
 *   0.7 s forces sleep (Rapier's own rule leaves things creeping). Only
 *   contacts and our own events (spawn, impulse) wake a body.
 * - **Guards:** every input checked (Guard.js), ids carry a generation,
 *   creations and removals are queued and applied at the start of the next
 *   step (never inside a callback; query callbacks only record), every
 *   Rapier call in a try/catch. A non-finite pose read back is removed and
 *   counted as lost. The first exception switches physics off (`failed`).
 * - **Release:** set-down (zero velocity) or drop / throw (PoseHistory),
 *   penetration-safe placement (free pose → step back through the history
 *   and cast to contact → cast down from above), `gapBelow` for the holster
 *   rule, `nearest` for pick-up (a JS pose cache, no Rapier call).
 * - **Lost-object net** (2 Hz, JS only): an item more than 0.3 m outside every
 *   floor polygon, or below the catch slab, for 10 s is `ST_LOST`; one that
 *   comes to rest on a backstop (fell through the one-sided mesh) is lifted
 *   back on top at once.
 * - **Landing:** the velocity change per frame (`landing(id)`) and the surface
 *   touched (`landSurf(id)`) for the sounds; soft surfaces damp the item.
 */

import { Guard, okVec, okQuat, okArray, makeId, slotOf, genOf, nextGen } from './Guard.js';
import { SURF, ROLE, MATERIAL, STATIC, insideHouse, chunkMesh } from './StaticGeometry.js';
import { ITEMS, LAND, isSetDown } from './ItemRules.js';
import { PoseHistory, Velocity } from './PoseHistory.js';

export const PHYS = Object.freeze({
  gravity: -9.81,
  hz: 90,                 // fixed step 1/90 s
  maxSteps: 3,            // per frame
  solverIters: 4,
  settleLin: 0.05, settleAng: 0.35, settleS: 0.7,   // own sleep rule
  placeLift: 0.15,        // m: cast down from this high above
  placeSkin: 0.002,       // m kept from the contact
  historyS: 0.3,          // s stepped back at most
  historyTests: 8,
  gapProbe: 0.06,         // m cast down for gapBelow
  maxItems: 32,
  ccd: true,
  lostCheckS: 0.5,        // 2 Hz
  linDamp: 0.05, angDamp: 0.1,           // in the air (design)
  softLinDamp: 0.8, softAngDamp: 2.5,    // after touching a bed or couch (design: a duvet swallows the motion)
  maxSpeed: 60,           // m/s read back: beyond is a blow-up (NaN guard)
  touchDist: 0.004,       // m: a contact point this close counts as touching (surface, backstop)
  warmSteps: 100,
});

/** Item states (`state(id)`). */
export const ST_FREE = 0;
export const ST_MOVING = 1;
export const ST_RESTING = 2;
export const ST_LOST = 3;

/** Collision groups (membership << 16 | filter). */
export const G_STATIC = 0x0001;
export const G_ITEM = 0x0002;
export const G_RAG = 0x0004;
const GRP_STATIC = ((G_STATIC << 16) | 0xffff) >>> 0;
const GRP_ITEM = ((G_ITEM << 16) | (G_STATIC | G_ITEM | G_RAG)) >>> 0;
/** A query that sees only static colliders. */
const GRP_Q_STATIC = ((0xffff << 16) | G_STATIC) >>> 0;
const EXCLUDE_DYNAMIC = 4;   // QueryFilterFlags.EXCLUDE_DYNAMIC (also read from R at construction)

/** Release placements (`out.mode`). */
export const PLACE_FREE = 0;
export const PLACE_HISTORY = 1;
export const PLACE_LIFT = 2;
export const PLACE_STUCK = 3;

const P_NONE = 0, P_SPAWN = 1, P_REMOVE = 2;
/** Surface priority for the landing surface: soft > hard > floor > other > ceiling > wall. */
const SURF_PRIO = [2, 3, 0, 1, 5, 4];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @typedef {{ name?: string, hulls: Float32Array[], mass: number, massEmpty?: number, massPerRound?: number,
 *   friction: number, restitution: number, grip: ArrayLike<number>, centre: ArrayLike<number>, half: ArrayLike<number> }} KindDef
 *   hulls: convex point clouds in item space (the body frame); grip: the grip point (pick-up), item space;
 *   centre / half: the item's box (pick-up, placement)
 * @typedef {{ def: KindDef, hulls: Float32Array[], shapes: any[], vol: Float64Array, volSum: number, com: Float64Array, grip: Float64Array,
 *   centre: Float64Array, half: Float64Array }} Kind
 *   hulls: the usable hulls of def.hulls (flat or degenerate ones are skipped)
 */

/** Release result (one reused object per caller). */
export class ReleaseInfo {
  constructor() {
    /** PLACE_* */
    this.mode = 0;
    /** A set-down (velocity zeroed) rather than a drop or throw. */
    this.setDown = false;
    this.lin = 0; this.ang = 0;
    this.lin = 0.5; this.lin = 0; this.ang = 0.5; this.ang = 0;
  }
}

export class PhysicsWorld {
  /**
   * @param {any} R the initialised Rapier module (loadRapier)
   * @param {{ maxItems?: number, hz?: number, clock?: () => number }} [o]
   */
  constructor(R, o = {}) {
    this.R = R;
    this.clock = o.clock || now;
    this.guard = new Guard();
    this.h = 1 / (o.hz || PHYS.hz);
    this.maxItems = Math.min(250, o.maxItems || PHYS.maxItems);
    this.exclDynamic = R.QueryFilterFlags && R.QueryFilterFlags.EXCLUDE_DYNAMIC ? R.QueryFilterFlags.EXCLUDE_DYNAMIC : EXCLUDE_DYNAMIC;
    this.ruleAvg = R.CoefficientCombineRule ? R.CoefficientCombineRule.Average : 0;
    this.ruleMin = R.CoefficientCombineRule ? R.CoefficientCombineRule.Min : 1;
    /** @type {any} */ this.world = null;
    /** @type {any} */ this.fixed = null;
    try {
      this.world = new R.World({ x: 0, y: PHYS.gravity, z: 0 });
      this.world.timestep = this.h;
      this.world.numSolverIterations = PHYS.solverIters;
      this.fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    } catch (e) { this.guard.fail(e, 'construct'); }

    /** @type {(Kind|null)[]} */ this.kinds = [];
    /** @type {KindDef[]} the definitions (warm-up copies them) */ this.kindDefs = [];

    // ── statics
    /** @type {import('./StaticGeometry.js').StaticGeometry|null} */ this.geo = null;
    /** @type {any[]} */ this.staticCols = [];
    /** v0.6: the previous build's colliders, removed in slices once the new ones exist (the device record:
     * removing ~170 colliders and creating new ones in one frame took 10.4 ms in a wave break). */
    /** @type {any[]} */ this._oldCols = [];
    /** v0.6: the previous complete set still stands and items may step on it while the new one is built. */
    this._oldUsable = false;
    /** handle → surf | role << 4 */ this.staticInfo = new Map();
    this._ready = false;
    this._job = 0;
    this._jobs = 0;
    /** @type {Int32Array|null} */ this._chunks = null;
    /** @type {Uint32Array|null} */ this._chunkIdx = null;
    this._tiles = false;
    this.buildStats = { slabs: 0, prisms: 0, chunks: 0, tris: 0, frames: 0, maxSliceMs: 0, ms: 0, oneSided: false, source: '' };
    this._buildT0 = 0;

    // ── items (slot arrays)
    const n = this.maxItems;
    this.gen = new Uint16Array(n);
    this.st = new Uint8Array(n);
    this.pend = new Uint8Array(n);
    this.kindOf = new Int16Array(n).fill(-1);
    /** @type {any[]} */ this.bodies = new Array(n).fill(null);
    this.cur = new Float64Array(n * 7);
    this.prev = new Float64Array(n * 7);
    this.spawnV = new Float64Array(n * 6);
    this.lv = new Float64Array(n * 3);
    this.mass = new Float64Array(n);
    this.rounds = new Int16Array(n).fill(-1);
    this.still = new Float64Array(n);
    this.outT = new Float64Array(n);
    this.land = new Float64Array(n);
    this.landS = new Uint8Array(n);
    this.needSurf = new Uint8Array(n);
    this.soft = new Uint8Array(n);
    /** Backstop fixes of the item this life (one at most: a backstop that pokes through a sagging scan is a surface). */
    this.fixes = new Uint8Array(n);
    this.dirty = new Uint8Array(n);
    this.seq = new Float64Array(n);
    this._seqN = 0;
    this.awake = 0;
    this.pending = 0;
    this.acc = 0;
    /** Interpolation factor between the last two steps (display). */
    this.alpha = 1;
    this._lostClock = 0;
    this._landAny = false;

    // ── scratch (reused objects handed to Rapier; its glue reads the fields)
    this._tv = { x: 0, y: 0, z: 0 };
    this._tq = { x: 0, y: 0, z: 0, w: 1 };
    this._tw = { x: 0, y: 0, z: 0 };
    this._rv = { x: 0, y: 0, z: 0 };
    this._ra = { x: 0, y: 0, z: 0 };
    this._zero = { x: 0, y: 0, z: 0 };
    this._qp = { x: 0, y: 0, z: 0 };
    this._qr = { x: 0, y: 0, z: 0, w: 1 };
    this._qd = { x: 0, y: 0, z: 0 };
    this._qp2 = { x: 0, y: 0, z: 0 };
    this._rp = new Float64Array(7);
    this._s7 = new Float64Array(7);
    this._vel = new Velocity();
    this._f1 = new Float64Array(1);
    this._pairs = new Float64Array(16);
    this._pairN = 0;
    this._touch = 0;
    this._onPair = (/** @type {any} */ c) => { if (this._pairN < 16) this._pairs[this._pairN++] = c.handle; };
    // touching = a contact point within 4 mm (the manifold also holds speculative points up to the
    // prediction distance, about 2 cm, which would put a gun lying on a lumpy duvet "on" the backstop below)
    this._onManifold = (/** @type {any} */ m) => {
      const n = m.numContacts();
      for (let k = 0; k < n; k++) if (m.contactDist(k) <= PHYS.touchDist) { this._touch = 1; return; }
    };
    this._onHit = (/** @type {any} */ _c) => { this._touch = 1; return false; };

    // ── stats
    this.stats = {
      steps: 0, frames: 0, skipped: 0, dropped: 0, awakeMax: 0,
      spawned: 0, removed: 0, placed: 0, history: 0, lifted: 0, stuck: 0, thrown: 0, setDown: 0,
      insideFixed: 0, lost: 0, rejected: 0,
    };
    this.stepHist = new Uint32Array(64);   // 0.05 ms bins
    this.stepMax = 0;
    this.lastStepMs = 0;
    /** Releases (ring of 40): t, kind, mode, setDown, lin, ang. */
    this.rel = new Float32Array(40 * 6);
    this.relN = 0;
    /** @type {any} the loader's record (loadRapier info), set by the caller */
    this.load = null;
    /** @type {{ ms: number, steps: number, maxStepMs: number, ok: boolean } | null} */
    this.warm = null;
    this.timeS = 0;
  }

  /** The static colliders are complete (items step only then). */
  get ready() { return this._ready && !this.guard.failed; }
  /** Items can step: the statics are built, or the previous complete set stands (v0.6). */
  get usable() { return (this._ready || this._oldUsable) && !this.guard.failed; }
  /** Physics threw: off for the session. */
  get failed() { return this.guard.failed; }

  /** @param {number} hz step rate (default 90) */
  setRate(hz) { if (hz >= 30 && hz <= 240) { this.h = 1 / hz; try { this.world.timestep = this.h; } catch (e) { this.guard.fail(e, 'setRate'); } } }

  // ======================================================================= kinds

  /**
   * Define an item kind (at load). Hull volumes and the centre of mass come from Rapier.
   * @param {number} kind 0..30 @param {KindDef} def
   * @returns {boolean}
   */
  defineKind(kind, def) {
    if (!(kind >= 0 && kind < 31) || !def || !def.hulls || !def.hulls.length || !(def.mass > 0)) return this.guard.reject();
    const R = this.R;
    try {
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, -1000, 0));
      /** @type {Float32Array[]} */ const hulls = [];
      /** @type {number[]} */ const vols = [];
      /** @type {any[]} */ const shapes = [];
      for (let i = 0; i < def.hulls.length; i++) {
        const h = def.hulls[i];
        if (!(h.length >= 12) || !okArray(h, 10)) continue;
        const desc = R.ColliderDesc.convexHull(h);
        if (!desc) continue;   // flat or degenerate: skipped
        const c = this.world.createCollider(desc.setDensity(1), body);
        const v = c.mass();
        if (!(v > 1e-9)) continue;
        hulls.push(h);
        vols.push(v);
        shapes.push(new R.ConvexPolyhedron(h));
      }
      if (!hulls.length) { this.world.removeRigidBody(body); return this.guard.reject(); }
      const vol = Float64Array.from(vols);
      body.recomputeMassPropertiesFromColliders();
      const lc = body.localCom();
      const com = Float64Array.of(lc.x, lc.y, lc.z);
      this.world.removeRigidBody(body);
      let volSum = 0;
      for (let i = 0; i < vol.length; i++) volSum += vol[i];
      if (!(volSum > 0)) return this.guard.reject();
      this.kinds[kind] = {
        def, hulls, shapes, vol, volSum, com,
        grip: Float64Array.from(def.grip), centre: Float64Array.from(def.centre), half: Float64Array.from(def.half),
      };
      this.kindDefs[kind] = def;
      return true;
    } catch (e) { this.guard.fail(e, 'defineKind'); return false; }
  }

  // ======================================================================= statics

  /**
   * Start (re)building the static colliders: the old ones go now, the new ones in `buildSlice`.
   * Items freeze (no steps) until it is done, then wake; v0.6: with `keepOld` (a rebuild of the same house in
   * the same coordinates: a learned rebuild in a wave break) they keep stepping on the previous complete set,
   * which stands until the new one exists.
   * @param {import('./StaticGeometry.js').StaticGeometry|null} geo
   * @param {boolean} [keepOld]
   */
  beginStatic(geo, keepOld = false) {
    if (this.guard.failed) return;
    // the old colliders stay until the new ones exist (no steps meanwhile), then go in slices (removeSlice)
    this._oldUsable = !!keepOld && (this._ready || this._oldUsable) && !!geo;
    for (let i = 0; i < this.staticCols.length; i++) this._oldCols.push(this.staticCols[i]);
    this.staticCols.length = 0;
    this.geo = geo;
    this._ready = false;
    this._job = 0;
    this._chunks = null;
    this._chunkIdx = null;
    const B = this.buildStats;
    B.slabs = B.prisms = B.chunks = B.tris = B.frames = 0;
    B.maxSliceMs = 0; B.ms = 0; B.oneSided = false; B.source = geo ? geo.source || 'world' : 'none';
    this._buildT0 = 0;
    if (!geo) {
      this._jobs = 0;
      try { for (const c of this._oldCols) { this.staticInfo.delete(c.handle); this.world.removeCollider(c, false); } } catch (e) { this.guard.fail(e, 'beginStatic'); }
      this._oldCols.length = 0;
      return;
    }
    const m = geo.mesh;
    this._tiles = false;
    if (m && m.vertices && m.indices && m.indices.length >= 3) {
      // the world builder's tile layout (zero-copy: vertices tile by tile, indices local to the tile)
      if (geo.tiles && geo.localIndices && (geo.tileCount || 0) > 0 && geo.localIndices.length === m.indices.length) {
        this._tiles = true; this._chunks = geo.tiles; this._chunkIdx = geo.localIndices;
      } else if (m.chunks && m.chunks.length >= 3) { this._chunks = m.chunks; this._chunkIdx = m.indices; }
      else { const c = chunkMesh(m); this._chunks = c.chunks; this._chunkIdx = c.indices; }
      B.oneSided = geo.oneSided !== false && m.oneSided !== false;
    }
    const nChunks = this._chunks ? (this._tiles ? /** @type {number} */ (geo.tileCount) : this._chunks.length / 3) : 0;
    this._jobs = geo.slabCount + geo.prismCount + nChunks;
  }

  /**
   * Create static colliders for up to `budgetMs` (at least one). Behind the panel: 4–6 ms a frame.
   * @param {number} budgetMs
   * @returns {boolean} every collider exists (and the queries see them)
   */
  buildSlice(budgetMs) {
    if (this.guard.failed) return false;
    if (this._ready) return true;
    const g = this.geo;
    if (!g) return false;
    const t0 = this.clock();
    if (this._buildT0 === 0) this._buildT0 = t0;
    const W = this.world, B = this.buildStats;
    try {
      do {
        if (this._job >= this._jobs) break;
        const j = this._job++;
        if (j < g.slabCount) this._slab(g.slabs, j);
        else if (j < g.slabCount + g.prismCount) this._prism(g, j - g.slabCount);
        else this._chunk(/** @type {any} */ (g.mesh), j - g.slabCount - g.prismCount);
      } while (this.clock() - t0 < budgetMs);
      B.frames++;
      const ms = this.clock() - t0;
      if (ms > B.maxSliceMs) B.maxSliceMs = ms;
      if (this._job < this._jobs) return false;
      // v0.6: then the previous build's colliders, in slices of the same budget
      if (this._oldCols.length) {
        do {
          const c = this._oldCols.pop();
          this.staticInfo.delete(c.handle);
          W.removeCollider(c, false);
        } while (this._oldCols.length && this.clock() - t0 < budgetMs);
        const ms2 = this.clock() - t0;
        if (ms2 > B.maxSliceMs) B.maxSliceMs = ms2;
        if (this._oldCols.length) return false;
      }
      // the scene queries see new colliders only after a step: one step now (items wake below)
      W.step();
      this.stats.steps++;
      this._ready = true;
      this._oldUsable = false;
      B.ms = this.clock() - this._buildT0;
      this._wakeAll();
      return true;
    } catch (e) { this.guard.fail(e, 'buildSlice'); return false; }
  }

  /** @param {Float32Array} S @param {number} j */
  _slab(S, j) {
    const o = j * STATIC.slabStride, R = this.R;
    const hx = S[o + 3], hy = S[o + 4], hz = S[o + 5], surf = S[o + 8] | 0, role = S[o + 9] | 0;
    if (!okVec(S[o], S[o + 1], S[o + 2], 1e4) || !(hx > 0.001 && hy > 0.001 && hz > 0.001) || !(hx < 1e4 && hy < 1e4 && hz < 1e4)) { this.guard.reject(); return; }
    this._qr.x = 0; this._qr.y = S[o + 6]; this._qr.z = 0; this._qr.w = S[o + 7];
    const mat = MATERIAL[surf] || MATERIAL[0];
    const d = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(S[o], S[o + 1], S[o + 2]).setRotation(this._qr);
    this._static(d, mat, surf, role);
    this.buildStats.slabs++;
  }

  /** @param {import('./StaticGeometry.js').StaticGeometry} g @param {number} j */
  _prism(g, j) {
    const pts = g.prisms.subarray(j * STATIC.prismStride, (j + 1) * STATIC.prismStride);
    if (!okArray(pts, 1e4)) { this.guard.reject(); return; }
    const d = this.R.ColliderDesc.convexHull(pts);
    if (!d) return;   // degenerate (flat) triangle
    const surf = g.prismSurf && j < g.prismSurf.length ? g.prismSurf[j] : SURF.FLOOR;
    this._static(d, MATERIAL[surf] || MATERIAL[0], surf, ROLE.SURFACE);
    this.buildStats.prisms++;
  }

  /** @param {import('./StaticGeometry.js').PreppedMesh} m @param {number} k */
  _chunk(m, k) {
    const C = /** @type {Int32Array} */ (this._chunks), I = /** @type {Uint32Array} */ (this._chunkIdx), V = m.vertices;
    if (this._tiles) {
      // TILE_STRIDE 6: firstTri, triCount, surf, owner, vStart, vCount (WorldStatics.js)
      const o = k * 6, first = C[o], count = C[o + 1], surf = C[o + 2], v0 = C[o + 4], nv = C[o + 5];
      if (!(count > 0 && nv >= 3)) return;
      const verts = V.subarray(3 * v0, 3 * (v0 + nv)), idx = I.subarray(3 * first, 3 * (first + count));
      if (!okArray(verts, 1e4)) { this.guard.reject(); return; }
      this._trimesh(verts, idx, surf, count);
      return;
    }
    const first = C[k * 3], count = C[k * 3 + 1], surf = C[k * 3 + 2];
    if (!(count > 0)) return;
    // compact vertices for this chunk
    const map = new Map();
    /** @type {number[]} */ const vs = [];
    const idx = new Uint32Array(count * 3);
    for (let t = 0; t < count * 3; t++) {
      const vi = I[first * 3 + t];
      let ni = map.get(vi);
      if (ni === undefined) { ni = vs.length / 3; map.set(vi, ni); vs.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]); }
      idx[t] = ni;
    }
    const verts = Float32Array.from(vs);
    if (!okArray(verts, 1e4)) { this.guard.reject(); return; }
    this._trimesh(verts, idx, surf, count);
  }

  /**
   * One trimesh tile: FIX_INTERNAL_EDGES (smooth slides over the tessellation) only when the mesh is
   * reliably oriented, since the flag makes it one-sided (the backstops catch what passes).
   * @param {Float32Array} verts @param {Uint32Array} idx @param {number} surf @param {number} count
   */
  _trimesh(verts, idx, surf, count) {
    const flags = this.buildStats.oneSided && this.R.TriMeshFlags ? this.R.TriMeshFlags.FIX_INTERNAL_EDGES : undefined;
    const d = flags === undefined ? this.R.ColliderDesc.trimesh(verts, idx) : this.R.ColliderDesc.trimesh(verts, idx, flags);
    this._static(d, MATERIAL[surf] || MATERIAL[0], surf, ROLE.SURFACE);
    this.buildStats.chunks++;
    this.buildStats.tris += count;
  }

  /**
   * @param {any} desc @param {readonly number[]} mat @param {number} surf @param {number} role
   */
  _static(desc, mat, surf, role) {
    desc.setFriction(mat[0]).setRestitution(mat[1]).setFrictionCombineRule(this.ruleAvg).setRestitutionCombineRule(this.ruleMin)
      .setCollisionGroups(GRP_STATIC);
    const c = this.world.createCollider(desc, this.fixed);
    this.staticCols.push(c);
    this.staticInfo.set(c.handle, (surf & 15) | (role << 4));
  }

  /** Wake every live item (the statics changed). */
  _wakeAll() {
    for (let i = 0; i < this.maxItems; i++) {
      const b = this.bodies[i];
      if (!b || this.pend[i] === P_REMOVE) continue;
      const s = this.st[i];
      if (s === ST_RESTING) { this.st[i] = ST_MOVING; this.awake++; }
      if (s === ST_RESTING || s === ST_MOVING) { b.wakeUp(); this.still[i] = 0; }
    }
  }

  // ======================================================================= items

  /**
   * Queue a new item (created at the start of the next step). Allocation-free here.
   * @param {number} kind
   * @param {ArrayLike<number>} p7 px, py, pz, qx, qy, qz, qw
   * @param {number} vx @param {number} vy @param {number} vz centre-of-mass velocity
   * @param {number} wx @param {number} wy @param {number} wz angular velocity
   * @param {number} [rounds] carried (magazines), -1 none
   * @returns {number} id, or -1 (refused or full)
   */
  spawn(kind, p7, vx, vy, vz, wx, wy, wz, rounds = -1) {
    if (this.guard.failed) return -1;
    const K = this.kinds[kind];
    if (!K) { this.guard.reject(); return -1; }
    if (!okVec(p7[0], p7[1], p7[2], 1e4) || !okQuat(p7[3], p7[4], p7[5], p7[6]) || !okVec(vx, vy, vz, 100) || !okVec(wx, wy, wz, 200)) { this.guard.reject(); this.stats.rejected++; return -1; }
    let i = -1;
    for (let k = 0; k < this.maxItems; k++) if (this.st[k] === ST_FREE && this.pend[k] === P_NONE) { i = k; break; }
    if (i < 0) return -1;
    const ql = Math.sqrt(p7[3] * p7[3] + p7[4] * p7[4] + p7[5] * p7[5] + p7[6] * p7[6]);
    const o = i * 7, C = this.cur, P = this.prev;
    C[o] = p7[0]; C[o + 1] = p7[1]; C[o + 2] = p7[2];
    C[o + 3] = p7[3] / ql; C[o + 4] = p7[4] / ql; C[o + 5] = p7[5] / ql; C[o + 6] = p7[6] / ql;
    for (let k = 0; k < 7; k++) P[o + k] = C[o + k];
    const S = this.spawnV;
    S[i * 6] = vx; S[i * 6 + 1] = vy; S[i * 6 + 2] = vz; S[i * 6 + 3] = wx; S[i * 6 + 4] = wy; S[i * 6 + 5] = wz;
    this.lv[i * 3] = vx; this.lv[i * 3 + 1] = vy; this.lv[i * 3 + 2] = vz;
    const def = K.def;
    this.mass[i] = rounds >= 0 && def.massEmpty !== undefined && def.massPerRound !== undefined ? def.massEmpty + def.massPerRound * rounds : def.mass;
    this.rounds[i] = rounds;
    this.kindOf[i] = kind;
    this.gen[i] = nextGen(this.gen[i]);
    this.st[i] = ST_MOVING;
    this.pend[i] = P_SPAWN;
    this.pending++;
    this.still[i] = 0;
    this.outT[i] = 0;
    this.land[i] = 0;
    this.landS[i] = SURF.OTHER;
    this.soft[i] = 0;
    this.fixes[i] = 0;
    this.dirty[i] = 1;
    this.seq[i] = ++this._seqN;
    this.awake++;
    this.stats.spawned++;
    return makeId(i, this.gen[i]);
  }

  /**
   * Remove an item. The id is invalid at once; the body goes at the start of the next step.
   * @param {number} id
   */
  remove(id) {
    const i = this._slot(id);
    if (i < 0) return;
    if (this.st[i] === ST_MOVING) this.awake--;
    this.st[i] = ST_FREE;
    this.gen[i] = nextGen(this.gen[i]);
    if (this.pend[i] === P_SPAWN) { this.pend[i] = P_NONE; this.pending--; }
    else if (this.bodies[i] && this.pend[i] !== P_REMOVE) { this.pend[i] = P_REMOVE; this.pending++; }
    this.kindOf[i] = -1;
    this.stats.removed++;
  }

  /** Remove every item (new round). */
  clear() { for (let i = 0; i < this.maxItems; i++) if (this.st[i] !== ST_FREE) this.remove(makeId(i, this.gen[i])); }

  /** @param {number} id @returns {number} slot, or -1 for a stale / unknown id */
  _slot(id) {
    if (!(id >= 0)) return -1;
    const i = slotOf(id);
    if (i >= this.maxItems || this.st[i] === ST_FREE || this.gen[i] !== genOf(id)) { this.guard.stale++; return -1; }
    return i;
  }

  /** Apply the queued creations and removals (start of a step; never inside a callback). */
  _flush() {
    if (this.pending === 0) return;
    const R = this.R, W = this.world;
    for (let i = 0; i < this.maxItems; i++) {
      const p = this.pend[i];
      if (p === P_NONE) continue;
      this.pend[i] = P_NONE;
      this.pending--;
      if (p === P_REMOVE) {
        const b = this.bodies[i];
        this.bodies[i] = null;
        if (b) W.removeRigidBody(b);
        continue;
      }
      // spawn
      const K = this.kinds[this.kindOf[i]];
      if (!K) { this.st[i] = ST_FREE; this.awake--; continue; }
      const o = i * 7, C = this.cur, S = this.spawnV;
      this._qr.x = C[o + 3]; this._qr.y = C[o + 4]; this._qr.z = C[o + 5]; this._qr.w = C[o + 6];
      this._tw.x = S[i * 6 + 3]; this._tw.y = S[i * 6 + 4]; this._tw.z = S[i * 6 + 5];
      const bd = R.RigidBodyDesc.dynamic().setTranslation(C[o], C[o + 1], C[o + 2]).setRotation(this._qr)
        .setLinvel(S[i * 6], S[i * 6 + 1], S[i * 6 + 2]).setAngvel(this._tw)
        .setCcdEnabled(PHYS.ccd).setCanSleep(true).setLinearDamping(PHYS.linDamp).setAngularDamping(PHYS.angDamp);
      const b = W.createRigidBody(bd);
      const def = K.def, m = this.mass[i];
      for (let k = 0; k < K.hulls.length; k++) {
        const d = R.ColliderDesc.convexHull(K.hulls[k]);
        if (!d) continue;
        d.setMass(m * K.vol[k] / K.volSum).setFriction(def.friction).setRestitution(def.restitution)
          .setFrictionCombineRule(this.ruleAvg).setRestitutionCombineRule(this.ruleMin).setCollisionGroups(GRP_ITEM);
        W.createCollider(d, b);
      }
      this.bodies[i] = b;
    }
  }

  /**
   * One frame: queued creations / removals, the lost-object net (2 Hz), then
   * fixed steps while anything is awake. Allocation-free when everything rests.
   * @param {number} dt seconds
   * @returns {number} steps taken
   */
  step(dt) {
    if (this.guard.failed) return 0;
    if (!(dt > 0)) dt = 0; else if (dt > 0.25) dt = 0.25;
    this.timeS += dt;
    this.stats.frames++;
    if (this._landAny) { this.land.fill(0); this._landAny = false; }
    if (!this._ready && !this._oldUsable) return 0;
    try { this._flush(); } catch (e) { this.guard.fail(e, 'flush'); return 0; }
    this._lostClock += dt;
    if (this._lostClock >= PHYS.lostCheckS) { this._checkLost(this._lostClock); this._lostClock = 0; }
    if (this.awake <= 0) { this.awake = 0; this.acc = 0; this.alpha = 1; this.stats.skipped++; return 0; }
    const h = this.h;
    let acc = this.acc + dt, n = Math.floor(acc / h + 1e-9);
    if (n > PHYS.maxSteps) { n = PHYS.maxSteps; acc = n * h; this.stats.dropped++; }
    const t0 = this.clock();
    let done = 0;
    try {
      for (let k = 0; k < n; k++) {
        this._savePrev();
        this.world.step();
        done++;
        this._afterStep();
        if (this.awake <= 0) break;
      }
      this._afterFrame();
    } catch (e) { this.guard.fail(e, 'step'); return done; }
    this.stats.steps += done;
    if (this.awake <= 0) { this.awake = 0; acc = 0; this.alpha = 1; }
    else { acc -= n * h; if (acc < 0) acc = 0; this.alpha = acc / h; }
    this.acc = acc;
    if (this.awake > this.stats.awakeMax) this.stats.awakeMax = this.awake;
    const ms = this.clock() - t0;
    this.lastStepMs = ms;
    if (done > 0) {
      const per = ms / done, bin = Math.min(63, Math.floor(per / 0.05));
      this.stepHist[bin] += done;
      if (per > this.stepMax) this.stepMax = per;
    }
    return done;
  }

  _savePrev() {
    const C = this.cur, P = this.prev;
    for (let i = 0; i < this.maxItems; i++) {
      if (this.st[i] !== ST_MOVING) continue;
      const o = i * 7;
      for (let k = 0; k < 7; k++) P[o + k] = C[o + k];
    }
  }

  /** Read the awake bodies after one world step: pose, velocity change, own sleep rule, NaN guard. */
  _afterStep() {
    const h = this.h, C = this.cur, LV = this.lv, gdv = PHYS.gravity * h;
    for (let i = 0; i < this.maxItems; i++) {
      const s = this.st[i], b = this.bodies[i];
      if (!b || this.pend[i] !== P_NONE) continue;
      if (s === ST_RESTING) {
        if (!b.isSleeping()) { this.st[i] = ST_MOVING; this.awake++; this.still[i] = 0; }   // woken by a contact
        continue;
      }
      if (s !== ST_MOVING) continue;
      const o = i * 7;
      const t = b.translation(this._tv), q = b.rotation(this._tq);
      const lv = b.linvel(this._rv);
      const vx = lv.x, vy = lv.y, vz = lv.z;
      const av = b.angvel(this._ra);
      const wx = av.x, wy = av.y, wz = av.z;
      if (!okVec(t.x, t.y, t.z, 1e4) || !okQuat(q.x, q.y, q.z, q.w) || !okVec(vx, vy, vz, PHYS.maxSpeed) || !okVec(wx, wy, wz, 1e3)) {
        this.guard.nan++;
        this.st[i] = ST_LOST;
        this.awake--;
        this.pend[i] = P_REMOVE;   // the body goes at the next flush; the caller sees ST_LOST
        this.pending++;
        continue;
      }
      C[o] = t.x; C[o + 1] = t.y; C[o + 2] = t.z; C[o + 3] = q.x; C[o + 4] = q.y; C[o + 5] = q.z; C[o + 6] = q.w;
      this.dirty[i] = 1;
      // velocity change beyond gravity's (the landing / bounce cue)
      const dx = vx - LV[i * 3], dy = vy - LV[i * 3 + 1] - gdv, dz = vz - LV[i * 3 + 2];
      const dv = Math.sqrt(dx * dx + dy * dy + dz * dz);
      LV[i * 3] = vx; LV[i * 3 + 1] = vy; LV[i * 3 + 2] = vz;
      if (dv > this.land[i]) { this.land[i] = dv; this._landAny = true; }
      if (dv >= LAND.contactDv) this.needSurf[i] = 1;
      // own sleep rule
      const lin2 = vx * vx + vy * vy + vz * vz, ang2 = wx * wx + wy * wy + wz * wz;
      if (b.isSleeping()) { this._rest(i, false); continue; }
      if (lin2 < PHYS.settleLin * PHYS.settleLin && ang2 < PHYS.settleAng * PHYS.settleAng) {
        this.still[i] += h;
        if (this.still[i] >= PHYS.settleS) this._rest(i, true);
      } else this.still[i] = 0;
    }
  }

  /**
   * Came to rest: sleep (forced), snap the interpolation, check for a backstop.
   * @param {number} i @param {boolean} force
   */
  _rest(i, force) {
    const b = this.bodies[i];
    if (force && b) b.sleep();
    this.st[i] = ST_RESTING;
    this.awake--;
    this.still[i] = 0;
    this.lv[i * 3] = this.lv[i * 3 + 1] = this.lv[i * 3 + 2] = 0;
    const o = i * 7;
    for (let k = 0; k < 7; k++) this.prev[o + k] = this.cur[o + k];
    this.dirty[i] = 1;
    this.needSurf[i] = 2;   // 2 = resolve the surface and check for a backstop
  }

  /** After the frame's steps: contact surfaces (sounds, soft damping) and backstop fixes. Event-time only. */
  _afterFrame() {
    for (let i = 0; i < this.maxItems; i++) {
      const need = this.needSurf[i];
      if (!need) continue;
      this.needSurf[i] = 0;
      const b = this.bodies[i];
      if (!b || this.pend[i] !== P_NONE || this.st[i] === ST_LOST || this.st[i] === ST_FREE) continue;
      const info = this._contactInfo(b);
      // on a backstop only when nothing real holds it too (a gun in a duvet trough touches both)
      const surf = info & 15, backstop = (info & 256) !== 0 && (info & 1024) === 0;
      if (info >= 0 && (info & 512)) this.landS[i] = surf;
      if (surf === SURF.SOFT && (info & 512) && !this.soft[i]) {
        this.soft[i] = 1;
        b.setLinearDamping(PHYS.softLinDamp);
        b.setAngularDamping(PHYS.softAngDamp);
      }
      if (need === 2 && backstop && this.fixes[i] === 0) this._fixInside(i);
    }
  }

  /**
   * The touched static surface of a body: surf | 256 when a backstop is touched | 512 when any static
   * is | 1024 when a real surface (not a backstop) is. Query callbacks only record handles; the work
   * happens after.
   * @param {any} b
   */
  _contactInfo(b) {
    const W = this.world;
    let best = -1, bestP = -1, back = 0, any = 0, real = 0;
    const nc = b.numColliders();
    for (let k = 0; k < nc; k++) {
      const c = b.collider(k);
      this._pairN = 0;
      W.contactPairsWith(c, this._onPair);
      const n = this._pairN;
      for (let j = 0; j < n; j++) {
        const hnd = this._pairs[j];
        const inf = this.staticInfo.get(hnd);
        if (inf === undefined) continue;
        const other = W.getCollider(hnd);
        if (!other) continue;
        this._touch = 0;
        W.contactPair(c, other, this._onManifold);
        if (!this._touch) continue;
        any = 512;
        const surf = inf & 15, role = inf >> 4;
        if (role === ROLE.BACKSTOP) back = 256; else real = 1024;
        const p = SURF_PRIO[surf] ?? 0;
        if (p > bestP) { bestP = p; best = surf; }
      }
    }
    return best < 0 ? (back | any | real) : (best | back | any | real);
  }

  /**
   * An item at rest on a backstop fell through the one-sided mesh: lift it back on top (a cast down
   * from above the furniture top), or count it lost.
   * @param {number} i
   */
  _fixInside(i) {
    this.fixes[i]++;
    const o = i * 7, P = this._rp;
    for (let k = 0; k < 7; k++) P[k] = this.cur[o + k];
    const K = this.kinds[this.kindOf[i]];
    if (!K) return;
    const lift = STATIC.backInset + STATIC.backThick + PHYS.placeLift;
    if (this._liftPlace(K, P, lift)) {
      const b = this.bodies[i];
      this._tv.x = P[0]; this._tv.y = P[1]; this._tv.z = P[2];
      b.setTranslation(this._tv, true);
      b.setLinvel(this._zero, true);
      b.setAngvel(this._zero, true);
      for (let k = 0; k < 7; k++) this.cur[o + k] = this.prev[o + k] = P[k];
      this.st[i] = ST_MOVING;
      this.awake++;
      this.dirty[i] = 1;
      this.stats.insideFixed++;
    } else {
      this.outT[i] = ITEMS.lostS;   // could not be fixed: lost now
      this.st[i] = ST_LOST;
      this.stats.lost++;
    }
  }

  /**
   * The lost-object net (JS only, no Rapier call): outside the house (0.3 m beyond every floor
   * polygon) or under the catch slab for 10 s → ST_LOST.
   * @param {number} dt
   */
  _checkLost(dt) {
    const g = this.geo;
    if (!g) return;
    const C = this.cur, below = g.catchY - ITEMS.belowCatch;
    for (let i = 0; i < this.maxItems; i++) {
      const s = this.st[i];
      if (s !== ST_MOVING && s !== ST_RESTING) continue;
      const o = i * 7, x = C[o], y = C[o + 1], z = C[o + 2];
      const out = !(y > below) || !insideHouse(g, x, z, ITEMS.outsidePad);
      if (!out) { this.outT[i] = 0; continue; }
      this.outT[i] += dt;
      if (this.outT[i] >= ITEMS.lostS) {
        if (s === ST_MOVING) this.awake--;
        this.st[i] = ST_LOST;
        this.stats.lost++;
        const b = this.bodies[i];
        if (b) b.sleep();
      }
    }
  }

  // ======================================================================= release

  /**
   * Release an item from the hand: set-down or drop / throw (history velocity), penetration-safe
   * placement, then spawn. Event-time (a few Rapier queries).
   * @param {number} kind
   * @param {ArrayLike<number>} p7 release pose
   * @param {import('./PoseHistory.js').PoseHistory|null} hist recent poses of the item in the hand
   * @param {ReleaseInfo} out
   * @param {number} [rounds]
   * @returns {number} id or -1
   */
  release(kind, p7, hist, out, rounds = -1) {
    out.mode = PLACE_STUCK; out.setDown = true; out.lin = 0; out.ang = 0;
    if (this.guard.failed || (!this._ready && !this._oldUsable)) return -1;
    const K = this.kinds[kind];
    if (!K) return -1;
    const V = this._vel;
    let ok = false;
    try { ok = !!hist && hist.velocity(K.com[0], K.com[1], K.com[2], V); } catch { ok = false; }
    if (!ok) V.zero();
    out.lin = V.lin; out.ang = V.ang;
    const setDown = isSetDown(V.lin, V.ang);
    out.setDown = setDown;
    const P = this._rp;
    for (let k = 0; k < 7; k++) P[k] = p7[k];
    let mode = PLACE_STUCK;
    try { mode = this._place(K, P, hist); } catch (e) { this.guard.fail(e, 'release'); return -1; }
    out.mode = mode;
    const id = setDown ? this.spawn(kind, P, 0, 0, 0, 0, 0, 0, rounds) : this.spawn(kind, P, V.vx, V.vy, V.vz, V.wx, V.wy, V.wz, rounds);
    if (id >= 0) {
      const S = this.stats;
      if (setDown) S.setDown++; else S.thrown++;
      if (mode === PLACE_FREE) S.placed++; else if (mode === PLACE_HISTORY) S.history++; else if (mode === PLACE_LIFT) S.lifted++; else S.stuck++;
      const r = this.rel, j = (this.relN % 40) * 6;
      r[j] = this.timeS; r[j + 1] = kind; r[j + 2] = mode; r[j + 3] = setDown ? 1 : 0; r[j + 4] = V.lin; r[j + 5] = V.ang;
      this.relN++;
    }
    return id;
  }

  /**
   * Penetration-safe placement of a pose with no hand history (a magazine leaving the well): a pose
   * overlapping a static collider is moved onto it by a cast down from above. Event-time.
   * @param {number} kind @param {Float64Array|number[]} p7 (in place)
   * @returns {number} PLACE_*
   */
  placeAt(kind, p7) {
    if (this.guard.failed || (!this._ready && !this._oldUsable)) return PLACE_STUCK;
    const K = this.kinds[kind];
    if (!K || !okVec(p7[0], p7[1], p7[2], 1e4) || !okQuat(p7[3], p7[4], p7[5], p7[6])) return PLACE_STUCK;
    try {
      const P = this._rp;
      for (let k = 0; k < 7; k++) P[k] = p7[k];
      const m = this._place(K, P, null);
      for (let k = 0; k < 7; k++) p7[k] = P[k];
      return m;
    } catch (e) { this.guard.fail(e, 'placeAt'); return PLACE_STUCK; }
  }

  /**
   * Penetration-safe placement of pose P (in place).
   * @param {Kind} K @param {Float64Array} P
   * @param {import('./PoseHistory.js').PoseHistory|null} hist
   * @returns {number} PLACE_*
   */
  _place(K, P, hist) {
    if (!this._overlaps(K, P[0], P[1], P[2], P)) return PLACE_FREE;
    // step back through the history to the newest free position (release orientation), then cast to contact
    if (hist && hist.count > 1) {
      const S7 = this._s7, span = hist.span;
      for (let k = 1; k <= PHYS.historyTests; k++) {
        const age = (k * PHYS.historyS) / PHYS.historyTests;
        if (age > span + 1e-6 && k > 1) break;
        hist.sample(age, S7);
        if (this._overlaps(K, S7[0], S7[1], S7[2], P)) continue;
        const dx = P[0] - S7[0], dy = P[1] - S7[1], dz = P[2] - S7[2];
        const toi = this._castMin(K, S7[0], S7[1], S7[2], P, dx, dy, dz, 1);
        const u = toi < 1 ? toi : 1;
        P[0] = S7[0] + dx * u; P[1] = S7[1] + dy * u; P[2] = S7[2] + dz * u;
        return PLACE_HISTORY;
      }
    }
    return this._liftPlace(K, P, PHYS.placeLift) ? PLACE_LIFT : PLACE_STUCK;
  }

  /**
   * Cast straight down from `lift` (then 2× and 3.3×) above P onto the first surface.
   * @param {Kind} K @param {Float64Array} P @param {number} lift
   * @returns {boolean} placed (P moved)
   */
  _liftPlace(K, P, lift) {
    for (let k = 0; k < 3; k++) {
      const up = lift * (k === 0 ? 1 : k === 1 ? 2 : 3.3);
      const sy = P[1] + up;
      if (this._overlaps(K, P[0], sy, P[2], P)) continue;
      const toi = this._castMin(K, P[0], sy, P[2], P, 0, -1, 0, up + 0.05);
      if (toi < up + 0.05) { P[1] = sy - toi; return true; }
    }
    return false;
  }

  /**
   * Does the item (kind K at position x, y, z with P's orientation) overlap a static collider?
   * @param {Kind} K @param {number} x @param {number} y @param {number} z @param {ArrayLike<number>} P
   */
  _overlaps(K, x, y, z, P) {
    const W = this.world, pos = this._qp, rot = this._qr;
    pos.x = x; pos.y = y; pos.z = z;
    rot.x = P[3]; rot.y = P[4]; rot.z = P[5]; rot.w = P[6];
    for (let k = 0; k < K.shapes.length; k++) {
      if (W.intersectionWithShape(pos, rot, K.shapes[k], this.exclDynamic, GRP_Q_STATIC)) return true;
    }
    return false;
  }

  /**
   * Smallest time of impact of the item's hulls moving by (dx, dy, dz) per unit time, up to maxToi
   * (stops `placeSkin` short of the contact). Infinity for no hit.
   * @param {Kind} K @param {number} x @param {number} y @param {number} z @param {ArrayLike<number>} P orientation
   * @param {number} dx @param {number} dy @param {number} dz @param {number} maxToi
   */
  _castMin(K, x, y, z, P, dx, dy, dz, maxToi) {
    const W = this.world, pos = this._qp2, rot = this._qr, vel = this._qd;
    pos.x = x; pos.y = y; pos.z = z;
    rot.x = P[3]; rot.y = P[4]; rot.z = P[5]; rot.w = P[6];
    vel.x = dx; vel.y = dy; vel.z = dz;
    let best = Infinity;
    for (let k = 0; k < K.shapes.length; k++) {
      const hit = W.castShape(pos, rot, vel, K.shapes[k], PHYS.placeSkin, maxToi, true, this.exclDynamic, GRP_Q_STATIC);
      if (hit && hit.time_of_impact < best) best = hit.time_of_impact;
    }
    vel.x = vel.y = vel.z = 0;
    return best;
  }

  /**
   * Distance from the item at pose p7 down to the nearest static surface, within 6 cm (0 when it
   * already touches or overlaps one; Infinity when none). For the holster rule.
   * @param {number} kind @param {ArrayLike<number>} p7
   */
  gapBelow(kind, p7) {
    if (this.guard.failed || (!this._ready && !this._oldUsable)) return Infinity;
    const K = this.kinds[kind];
    if (!K || !okVec(p7[0], p7[1], p7[2], 1e4) || !okQuat(p7[3], p7[4], p7[5], p7[6])) return Infinity;
    try {
      if (this._overlaps(K, p7[0], p7[1], p7[2], p7)) return 0;
      const toi = this._castMin(K, p7[0], p7[1], p7[2], p7, 0, -1, 0, PHYS.gapProbe);
      return toi <= PHYS.gapProbe ? toi : Infinity;
    } catch (e) { this.guard.fail(e, 'gapBelow'); return Infinity; }
  }

  /**
   * A momentum change on an item (a bullet hitting a dropped gun: 9 mm 2.9 kg·m/s, 7.62×39 5.6).
   * @param {number} id @param {number} px @param {number} py @param {number} pz world point
   * @param {number} ix @param {number} iy @param {number} iz impulse (kg·m/s)
   */
  impulse(id, px, py, pz, ix, iy, iz) {
    const i = this._slot(id);
    if (i < 0 || !okVec(px, py, pz, 1e4) || !okVec(ix, iy, iz, 50)) return;
    const b = this.bodies[i];
    if (!b || this.pend[i] !== P_NONE) return;
    try {
      this._tv.x = ix; this._tv.y = iy; this._tv.z = iz;
      this._qp.x = px; this._qp.y = py; this._qp.z = pz;
      b.applyImpulseAtPoint(this._tv, this._qp, true);
      if (this.st[i] === ST_RESTING) { this.st[i] = ST_MOVING; this.awake++; this.still[i] = 0; }
    } catch (e) { this.guard.fail(e, 'impulse'); }
  }

  // ======================================================================= reads

  /** @param {number} id @returns {number} ST_* (ST_FREE for a stale id) */
  state(id) {
    if (!(id >= 0)) return ST_FREE;
    const i = slotOf(id);
    if (i >= this.maxItems || this.gen[i] !== genOf(id)) return ST_FREE;
    return this.st[i];
  }

  /** @param {number} id */
  kindOfId(id) { const i = this._slot(id); return i < 0 ? -1 : this.kindOf[i]; }

  /** @param {number} id rounds carried, -1 none */
  roundsOf(id) { const i = this._slot(id); return i < 0 ? -1 : this.rounds[i]; }

  /** Velocity change this frame (m/s): the landing / bounce cue. @param {number} id */
  landing(id) {
    if (!(id >= 0)) return 0;
    const i = slotOf(id);
    return i < this.maxItems && this.gen[i] === genOf(id) ? this.land[i] : 0;
  }

  /** The static surface the item last touched (SURF.*). @param {number} id */
  landSurf(id) {
    if (!(id >= 0)) return SURF.OTHER;
    const i = slotOf(id);
    return i < this.maxItems && this.gen[i] === genOf(id) ? this.landS[i] : SURF.OTHER;
  }

  /** Spawn order (the oldest has the lowest). @param {number} id */
  age(id) { const i = this._slot(id); return i < 0 ? 0 : this.seq[i]; }

  /**
   * Display pose (interpolated between the last two steps) into out[o..o+6], only when it
   * changed since the last call (moving, or just came to rest). Allocation-free, no Rapier call.
   * @param {number} id @param {Float64Array|Float32Array|number[]} out @param {number} [o]
   * @returns {boolean} written
   */
  readPose(id, out, o = 0) {
    if (!(id >= 0)) return false;
    const i = slotOf(id);
    if (i >= this.maxItems || this.gen[i] !== genOf(id) || this.st[i] === ST_FREE) return false;
    if (this.st[i] !== ST_MOVING && !this.dirty[i]) return false;
    this.dirty[i] = 0;
    this._interp(i, this.st[i] === ST_MOVING ? this.alpha : 1, out, o);
    return true;
  }

  /**
   * Display pose, always written. @param {number} id @param {Float64Array|Float32Array|number[]} out @param {number} [o]
   * @returns {boolean} false for a stale id
   */
  pose(id, out, o = 0) {
    if (!(id >= 0)) return false;
    const i = slotOf(id);
    if (i >= this.maxItems || this.gen[i] !== genOf(id) || this.st[i] === ST_FREE) return false;
    this._interp(i, this.st[i] === ST_MOVING ? this.alpha : 1, out, o);
    return true;
  }

  /**
   * Column-major 4×4 of the display pose (only when changed; see readPose).
   * @param {number} id @param {Float32Array|Float64Array} out @param {number} [o]
   */
  readMatrix(id, out, o = 0) {
    const p = this._s7;
    if (!this.readPose(id, p, 0)) return false;
    const x = p[3], y = p[4], z = p[5], w = p[6];
    const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[o] = 1 - (yy + zz); out[o + 1] = xy + wz; out[o + 2] = xz - wy; out[o + 3] = 0;
    out[o + 4] = xy - wz; out[o + 5] = 1 - (xx + zz); out[o + 6] = yz + wx; out[o + 7] = 0;
    out[o + 8] = xz + wy; out[o + 9] = yz - wx; out[o + 10] = 1 - (xx + yy); out[o + 11] = 0;
    out[o + 12] = p[0]; out[o + 13] = p[1]; out[o + 14] = p[2]; out[o + 15] = 1;
    return true;
  }

  /**
   * @param {number} i @param {number} a @param {Float64Array|Float32Array|number[]} out @param {number} o
   */
  _interp(i, a, out, o) {
    const C = this.cur, P = this.prev, k = i * 7;
    if (a >= 1) { for (let j = 0; j < 7; j++) out[o + j] = C[k + j]; return; }
    out[o] = P[k] + (C[k] - P[k]) * a;
    out[o + 1] = P[k + 1] + (C[k + 1] - P[k + 1]) * a;
    out[o + 2] = P[k + 2] + (C[k + 2] - P[k + 2]) * a;
    let bx = C[k + 3], by = C[k + 4], bz = C[k + 5], bw = C[k + 6];
    const ax = P[k + 3], ay = P[k + 4], az = P[k + 5], aw = P[k + 6];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x = ax + (bx - ax) * a, y = ay + (by - ay) * a, z = az + (bz - az) * a, w = aw + (bw - aw) * a;
    const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    out[o + 3] = x / l; out[o + 4] = y / l; out[o + 5] = z / l; out[o + 6] = w / l;
  }

  /**
   * The item in reach of a hand: its grip point within `gripReach`, or its box within `boxReach`;
   * the nearest wins. A JS pose cache: no Rapier call, allocation-free.
   * @param {number} x @param {number} y @param {number} z hand (grip origin)
   * @param {number} gripReach @param {number} boxReach
   * @param {number} kindMask bit per kind
   * @returns {number} id or -1
   */
  nearest(x, y, z, gripReach, boxReach, kindMask) {
    let best = -1, bestS = 1;
    const C = this.cur;
    for (let i = 0; i < this.maxItems; i++) {
      const s = this.st[i];
      if (s !== ST_MOVING && s !== ST_RESTING) continue;
      const kd = this.kindOf[i];
      if (kd < 0 || !((kindMask >>> kd) & 1)) continue;
      const K = this.kinds[kd];
      if (!K) continue;
      const o = i * 7;
      const qx = C[o + 3], qy = C[o + 4], qz = C[o + 5], qw = C[o + 6];
      // hand in item space: r = q⁻¹ (p − t)
      const px = x - C[o], py = y - C[o + 1], pz = z - C[o + 2];
      const tx = 2 * (-qy * pz + qz * py), ty = 2 * (-qz * px + qx * pz), tz = 2 * (-qx * py + qy * px);
      const lx = px + qw * tx + (-qy * tz + qz * ty), ly = py + qw * ty + (-qz * tx + qx * tz), lz = pz + qw * tz + (-qx * ty + qy * tx);
      const g = K.grip, gx = lx - g[0], gy = ly - g[1], gz = lz - g[2];
      const dGrip = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const c = K.centre, hh = K.half;
      let ex = Math.abs(lx - c[0]) - hh[0], ey = Math.abs(ly - c[1]) - hh[1], ez = Math.abs(lz - c[2]) - hh[2];
      ex = ex > 0 ? ex : 0; ey = ey > 0 ? ey : 0; ez = ez > 0 ? ez : 0;
      const dBox = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const a = dGrip / gripReach, b = boxReach > 0 ? dBox / boxReach : Infinity, sc = a < b ? a : b;
      if (sc <= bestS) { bestS = sc; best = i; }
    }
    return best < 0 ? -1 : makeId(best, this.gen[best]);
  }

  /**
   * Move every item by a rigid transform (a reference-space realign moved the world: old → new,
   * column-major). Behind the realign pause; the statics are rebuilt after it.
   * @param {ArrayLike<number>} m
   */
  transformAll(m) {
    if (this.guard.failed || !okArray(m, 1e5)) return;
    // rotation as a quaternion (Shepperd)
    const m00 = m[0], m10 = m[1], m20 = m[2], m01 = m[4], m11 = m[5], m21 = m[6], m02 = m[8], m12 = m[9], m22 = m[10];
    const tr = m00 + m11 + m22;
    let rx = 0, ry = 0, rz = 0, rw = 1;
    if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); rw = 0.25 / s; rx = (m21 - m12) * s; ry = (m02 - m20) * s; rz = (m10 - m01) * s; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); rw = (m21 - m12) / s; rx = 0.25 * s; ry = (m01 + m10) / s; rz = (m02 + m20) / s; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); rw = (m02 - m20) / s; rx = (m01 + m10) / s; ry = 0.25 * s; rz = (m12 + m21) / s; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); rw = (m10 - m01) / s; rx = (m02 + m20) / s; ry = (m12 + m21) / s; rz = 0.25 * s; }
    const C = this.cur;
    try {
      for (let i = 0; i < this.maxItems; i++) {
        const s = this.st[i];
        if (s !== ST_MOVING && s !== ST_RESTING) continue;
        const o = i * 7, x = C[o], y = C[o + 1], z = C[o + 2];
        C[o] = m00 * x + m01 * y + m02 * z + m[12];
        C[o + 1] = m10 * x + m11 * y + m12 * z + m[13];
        C[o + 2] = m20 * x + m21 * y + m22 * z + m[14];
        const qx = C[o + 3], qy = C[o + 4], qz = C[o + 5], qw = C[o + 6];
        C[o + 3] = rw * qx + rx * qw + ry * qz - rz * qy;
        C[o + 4] = rw * qy - rx * qz + ry * qw + rz * qx;
        C[o + 5] = rw * qz + rx * qy - ry * qx + rz * qw;
        C[o + 6] = rw * qw - rx * qx - ry * qy - rz * qz;
        for (let k = 0; k < 7; k++) this.prev[o + k] = C[o + k];
        this.dirty[i] = 1;
        const b = this.bodies[i];
        if (b && this.pend[i] === P_NONE) {
          this._tv.x = C[o]; this._tv.y = C[o + 1]; this._tv.z = C[o + 2];
          this._tq.x = C[o + 3]; this._tq.y = C[o + 4]; this._tq.z = C[o + 5]; this._tq.w = C[o + 6];
          b.setTranslation(this._tv, false);
          b.setRotation(this._tq, false);
        }
      }
    } catch (e) { this.guard.fail(e, 'transformAll'); }
  }

  // ======================================================================= warm-up and record

  /**
   * At load, after every defineKind: a scratch world runs every contact pair, query and JS path
   * the session meets (two passes: one-sided and two-sided mesh), then is freed. Removes the
   * measured 37–52 ms first-contact steps. Returns its own timing.
   * @returns {{ ms: number, steps: number, maxStepMs: number, ok: boolean }}
   */
  warmUp() {
    const t0 = this.clock();
    let steps = 0, maxStepMs = 0, ok = !this.guard.failed;
    for (const oneSided of [true, false]) {
      if (!ok) break;
      const W = new PhysicsWorld(this.R, { maxItems: this.maxItems, clock: this.clock });
      try {
        for (let k = 0; k < this.kindDefs.length; k++) if (this.kindDefs[k]) W.defineKind(k, this.kindDefs[k]);
        W.beginStatic(warmGeometry(oneSided));
        while (!W.buildSlice(1000)) { if (W.failed) break; }
        const r = warmScenario(W, oneSided);
        steps += r.steps;
        if (r.maxStepMs > maxStepMs) maxStepMs = r.maxStepMs;
        if (W.failed) ok = false;
      } catch { ok = false; }
      W.dispose();
    }
    this.warm = { ms: Math.round((this.clock() - t0) * 10) / 10, steps, maxStepMs: Math.round(maxStepMs * 100) / 100, ok };
    return this.warm;
  }

  /** `rec.physics` (allocates; session end). */
  report() {
    const H = this.stepHist;
    let total = 0;
    for (let i = 0; i < H.length; i++) total += H[i];
    const q = (/** @type {number} */ p) => {
      if (!total) return 0;
      let acc = 0;
      for (let i = 0; i < H.length; i++) { acc += H[i]; if (acc >= p * total) return Math.round((i + 0.5) * 0.05 * 1000) / 1000; }
      return 3.2;
    };
    const releases = [];
    const n = Math.min(40, this.relN);
    for (let k = 0; k < n; k++) {
      const j = ((this.relN - n + k) % 40) * 6, r = this.rel;
      releases.push({ t: Math.round(r[j] * 10) / 10, kind: r[j + 1], mode: r[j + 2], setDown: r[j + 3] > 0, lin: Math.round(r[j + 4] * 100) / 100, ang: Math.round(r[j + 5] * 100) / 100 });
    }
    const B = this.buildStats;
    return {
      rapier: this.R && typeof this.R.version === 'function' ? this.R.version() : null,
      load: this.load, warm: this.warm,
      build: { slabs: B.slabs, prisms: B.prisms, chunks: B.chunks, tris: B.tris, frames: B.frames, maxSliceMs: Math.round(B.maxSliceMs * 100) / 100, ms: Math.round(B.ms * 10) / 10, oneSided: B.oneSided, source: B.source, ready: this._ready },
      running: { rateHz: Math.round(1 / this.h), steps: this.stats.steps, frames: this.stats.frames, skippedFrames: this.stats.skipped, droppedTime: this.stats.dropped, awakeMax: this.stats.awakeMax, stepMs: { p50: q(0.5), p95: q(0.95), max: Math.round(this.stepMax * 1000) / 1000 } },
      items: { spawned: this.stats.spawned, removed: this.stats.removed, setDown: this.stats.setDown, thrown: this.stats.thrown, placed: this.stats.placed, historyPlaced: this.stats.history, lifted: this.stats.lifted, stuck: this.stats.stuck, insideFixed: this.stats.insideFixed, lost: this.stats.lost },
      releases,
      guard: this.guard.report(),
    };
  }

  dispose() {
    try { if (this.world) this.world.free(); } catch { /* already gone */ }
    this.world = null;
    this.fixed = null;
    this.staticCols.length = 0;
    this._oldCols.length = 0;
    this.bodies.fill(null);
    this._ready = false;
  }
}

/**
 * The warm-up's scratch house: a floor prism pair, a wall, a table top, a bed box, a backstop, the
 * catch slab and a lumpy 1 × 1 m mesh patch on a box (every static collider type).
 * @param {boolean} oneSided
 * @returns {import('./StaticGeometry.js').StaticGeometry}
 */
export function warmGeometry(oneSided) {
  const slabs = [
    0, 1.25, -2.05, 2, 1.25, 0.05, 0, 1, SURF.WALL, ROLE.SURFACE,      // wall
    -1, 0.73, 0, 0.5, 0.02, 0.3, 0, 1, SURF.HARD, ROLE.SURFACE,        // table top
    1, 0.27, 0, 0.9, 0.27, 0.7, 0, 1, SURF.SOFT, ROLE.SURFACE,         // bed
    -1, 0.4, 1.2, 0.3, 0.02, 0.3, 0, 1, SURF.HARD, ROLE.BACKSTOP,      // a backstop
    0, -0.252, 0, 20, 0.25, 20, 0, 1, SURF.FLOOR, ROLE.CATCH,          // catch slab
  ];
  const prisms = [];
  for (const tri of [[-2, -2, 2, -2, 2, 2], [-2, -2, 2, 2, -2, 2]]) {
    for (const y of [0, -0.3]) for (let k = 0; k < 3; k++) prisms.push(tri[k * 2], y, tri[k * 2 + 1]);
  }
  // mesh: a lumpy top (oriented up) at y 0.5 over x ∈ [-1.5, -0.5], z ∈ [0.7, 1.7], and one wall face
  const V = [], I = [], n = 8;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) V.push(-1.5 + i / n, 0.5 + 0.02 * Math.sin(i * 1.7) * Math.sin(j * 1.3), 0.7 + j / n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; I.push(a, c, b, b, c, d); }
  const base = V.length / 3;
  V.push(1.9, 0, -1, 1.9, 0, 1, 1.9, 1.5, 1, 1.9, 1.5, -1);
  I.push(base, base + 2, base + 1, base, base + 3, base + 2);
  const vertices = Float32Array.from(V), indices = Uint32Array.from(I);
  const surf = new Uint8Array(indices.length / 3).fill(SURF.HARD);
  return {
    slabs: Float32Array.from(slabs), slabCount: slabs.length / STATIC.slabStride,
    prisms: Float32Array.from(prisms), prismCount: prisms.length / STATIC.prismStride, prismSurf: Uint8Array.of(SURF.FLOOR, SURF.FLOOR),
    mesh: { vertices, indices, surf, chunks: null, oneSided },
    oneSided, catchY: -0.002, bounds: Float32Array.of(-2, -2, 2, 2),
    floorPts: Float64Array.of(-2, -2, 2, -2, 2, 2, -2, 2), floorOff: Int32Array.of(0), floorN: Int32Array.of(4), floorCount: 1, source: 'warm',
  };
}

/**
 * Every item kind through every contact and every JS path, on a scratch world. The first (full)
 * pass drops each kind onto every static type and throws it into the wall; the second (light) pass
 * only drops each kind onto the mesh patch (the two-sided trimesh). wasm compiles a function on its
 * first call and tiers up in the background, so a few dozen contacts per pair are enough.
 * @param {PhysicsWorld} W @param {boolean} full
 * @returns {{ steps: number, maxStepMs: number }}
 */
function warmScenario(W, full) {
  const ids = [];
  const p = new Float64Array(7), out = new ReleaseInfo();
  const q = Math.SQRT1_2;
  // floor prism, table slab, bed box, backstop, mesh patch
  const spots = full ? [[0.2, 0.4, 0.3], [-1, 1.0, 0], [1, 0.9, 0.2], [-1, 0.9, 1.2], [-1.2, 0.8, 1.0]] : [[-1.2, 0.8, 1.0]];
  let s = 0;
  for (let k = 0; k < W.kinds.length; k++) {
    if (!W.kinds[k]) continue;
    for (const sp of spots) {
      p[0] = sp[0] + 0.07 * (s % 3); p[1] = sp[1]; p[2] = sp[2]; p[3] = 0; p[4] = Math.sin(s); p[5] = 0; p[6] = Math.cos(s);
      ids.push(W.spawn(k, p, 0.2, 0, -0.1, 1, 2, 0.5, 10));
      s++;
    }
    // a throw into the wall (CCD) that lands among the others (item against item)
    if (full && k % 2 === 0) {
      p[0] = 0.5; p[1] = 1.2; p[2] = -1; p[3] = q; p[4] = 0; p[5] = 0; p[6] = q;
      ids.push(W.spawn(k, p, 0, 1, -9, 10, 0, 0, -1));
    }
  }
  let steps = 0, maxStepMs = 0;
  const frame = (/** @type {number} */ dt) => {
    const t0 = W.clock();
    steps += W.step(dt);
    const ms = W.clock() - t0;
    if (ms > maxStepMs) maxStepMs = ms;
  };
  const n = full ? PHYS.warmSteps : PHYS.warmSteps >> 1;
  for (let f = 0; f < n; f++) frame(f === 40 ? 0.1 : 1 / 72);
  // reads, pick-up, impulses, landing
  const o7 = new Float64Array(7), m16 = new Float32Array(16);
  for (const id of ids) {
    W.readPose(id, o7, 0); W.pose(id, o7, 0); W.readMatrix(id, m16, 0); W.landing(id); W.landSurf(id); W.state(id); W.roundsOf(id); W.age(id);
    W.nearest(o7[0], o7[1], o7[2], 0.13, 0.05, 0x7fffffff);
  }
  if (ids.length) W.impulse(ids[0], 0.2, 0.3, 0.3, 0.5, 0.5, 0);
  // releases: free, history step-back (into the bed), lift (deep in the bed), set-down; gapBelow
  const H = new PoseHistory();
  for (let k = 0; k < W.kinds.length; k++) {
    if (!W.kinds[k]) continue;
    H.reset();
    for (let f = 0; f < 20; f++) H.pushPQ(f / 72, 1, 0.9 - f * 0.02, 0, 0, 0, 0, 1);
    p[0] = 1; p[1] = 0.52; p[2] = 0; p[3] = 0; p[4] = 0; p[5] = 0; p[6] = 1;
    ids.push(W.release(k, p, H, out, 5));
    p[1] = 0.3;
    ids.push(W.release(k, p, null, out, -1));
    p[0] = 0; p[1] = 1.2; p[2] = 0.5;
    ids.push(W.release(k, p, H, out, -1));
    W.gapBelow(k, p);
    p[1] = 0.03;
    W.gapBelow(k, p);
  }
  for (let f = 0; f < (full ? 40 : 15); f++) frame(1 / 90);
  // lost-object net, transform, removal
  W.transformAll([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.01, 0, 0, 1]);
  W._checkLost(0.5);
  for (const id of ids) W.remove(id);
  frame(1 / 72);
  W.report();
  return { steps, maxStepMs };
}
