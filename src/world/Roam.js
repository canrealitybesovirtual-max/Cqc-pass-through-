// @ts-check
/**
 * Whole-house index for Roam, the default play mode (pure: no three.js, no
 * DOM). Built on a finalized NavGrid after every world build:
 *
 * - **Rooms** (synchronous, at build): `nav.labelRooms` splits the floor at
 *   wall slabs and door gaps; rooms under 1 m² get id 0. Per room: cells,
 *   area, centre, and whether it is a door pocket or virtual floor.
 * - **Door graph** (synchronous): for each door, the rooms 0.45–0.9 m out on
 *   either side (`doorRoomA` = the +n side, `doorRoomB`), whether it leads
 *   outside the mapped house (`doorExterior`: into a pocket or unmapped space,
 *   e.g. a front door), and a room → doors list (`roomDoorStart` / `roomDoorList`, CSR).
 * - **Door distance fields** (baked in slices): for each open walkable door, a
 *   Dijkstra over enemy-walkable cells (8-connected, no corner cutting) from the
 *   door centre, stored as Uint16 centimetres (65535 = unreachable, rounded up
 *   so an estimate is never shorter than the true path). One pool, grown at
 *   build time only.
 * - **Edge margin** (baked in slices): a signed geodesic distance to the open
 *   edge of the mapped floor, in metres, into `nav.edge`: + on the map, − off
 *   it. "Map" = a mapped floor, a door gap, a real wall slab, or within 0.25 m
 *   of a real wall (off-floor slivers along a wall are not an edge); real wall
 *   slabs block the propagation (an edge behind a real wall is not near), so
 *   only inferred walls (no wall plane), open sides and unmapped space behind
 *   doors count as edges.
 *
 * Per frame (allocation-free): `trackPlayer(x, z)` finds the player's room(s)
 * (both rooms while standing in a door gap) and an anchor cell (the nearest
 * walkable cell in those rooms within 1 m: the head is often over a cell an
 * enemy could not stand on), and `pathFromPlayerCell(i)` estimates the path
 * from the player to cell i as min over the doors of the player's rooms of
 * field_k[anchor] + field_k[i] (+ the head-to-anchor distance). Every path out
 * of a room passes one of its doors, so for a cell in another room this is
 * the shortest path constrained through that door (never shorter than the
 * true path; the research bench measured a 0.06 m mean over-estimate). For a
 * cell in the player's own room it is the straight-line distance.
 *
 * Bake cost: about 0.85 ms per door field and 1–2 ms per edge pass on desktop
 * for a 111 m² house (3–5× on the Quest), so `step(budgetMs)` runs the queue
 * in slices from `world.update` (1 ms a frame by default); `finish()` runs it
 * all (tests, or behind an opaque panel). Until a field is ready its queries
 * fall back (edge margin 99 = no edge known; path = the build-start field).
 */

import { NAV_DOOR, NAV_INSIDE, NAV_IWALL, NAV_POCKET, NAV_SHIELD, NAV_VIRTUAL, NAV_WALK, NAV_WALL } from './NavGrid.js';

export const ROAM = Object.freeze({
  /** Rooms smaller than this get no id (m²). */
  minRoomM2: 1.0,
  maxRooms: 512,
  maxDoors: 128,
  /** Door fields at most (memory: 2 B per cell each); further doors get none and are noted. */
  maxFields: 64,
  /** Doors per player room list (both rooms of a door gap together). */
  maxPlayerDoors: 64,
  /** The anchor cell is searched within this radius of the head (m). */
  anchorR: 1.0,
  /** Door → room probes along ±n from the door centre (m). */
  doorProbes: Object.freeze([0.45, 0.65, 0.9]),
  /** Default bake budget per frame (ms). */
  bakeBudgetMs: 1.0,
  /** Heap pops / cells between clock reads in a timed slice. */
  clockEvery: 256,
  /** Unreachable in a Uint16 door field. */
  far: 65535,
  /** Shield around real walls (matches WorldCore's NAV_SHIELD inflate, m). */
  shield: 0.25,
});

/** pathFromPlayerCm: unreachable. */
export const PATH_FAR = 0x3fffffff;

/** Room flags. */
export const ROOM_POCKET = 1;
export const ROOM_VIRTUAL = 2;

/** Bake tasks, in order. */
const T_IDLE = 0, T_EDGE_IN = 1, T_EDGE_OUT = 2, T_DOORS = 3, T_DONE = 4;
/** Phases of one sliced Dijkstra. */
const P_SEED = 0, P_RUN = 1, P_OUT = 2;
/** Passability modes of the shared Dijkstra. */
const M_WALK = 0, M_IN = 1, M_OUT = 2;

const SQRT2 = Math.SQRT2;
const NDX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NDZ = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);
const defaultClock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

/**
 * "On the map" for the edge field.
 * @param {number} f flags
 */
function isMap(f) {
  return ((f & NAV_INSIDE) !== 0 && (f & NAV_VIRTUAL) === 0) || (f & (NAV_DOOR | NAV_SHIELD)) !== 0
    || ((f & NAV_WALL) !== 0 && (f & NAV_IWALL) === 0);
}

/** A real wall slab (blocks the edge propagation). @param {number} f */
function isBarrier(f) {
  return (f & NAV_WALL) !== 0 && (f & NAV_IWALL) === 0 && (f & NAV_DOOR) === 0;
}

/**
 * Can the Dijkstra enter a cell with flags f in this mode?
 * @param {number} mode @param {number} f
 */
function enters(mode, f) {
  if (mode === M_WALK) return (f & NAV_WALK) !== 0;
  return mode === M_IN ? isMap(f) : !isMap(f);
}

export class RoamIndex {
  /**
   * @param {import('./NavGrid.js').NavGrid} nav built at load; the index keeps its arrays for the page's lifetime
   * @param {{ maxRooms?: number, maxDoors?: number, clock?: () => number }} [o]
   */
  constructor(nav, { maxRooms = ROAM.maxRooms, maxDoors = ROAM.maxDoors, clock = defaultClock } = {}) {
    this.nav = nav;
    this.clock = clock;
    this.maxRooms = maxRooms;
    this.maxDoors = maxDoors;
    // rooms
    this.roomCount = 0;
    this.roomCells = new Uint32Array(maxRooms);
    this.roomCx = new Float32Array(maxRooms);
    this.roomCz = new Float32Array(maxRooms);
    this.roomFlags = new Uint8Array(maxRooms);
    // doors
    this.doorCount = 0;
    this.doorX = new Float32Array(maxDoors);
    this.doorZ = new Float32Array(maxDoors);
    this.doorHalf = new Float32Array(maxDoors);
    this.doorRoomA = new Uint16Array(maxDoors);
    this.doorRoomB = new Uint16Array(maxDoors);
    this.doorExterior = new Uint8Array(maxDoors);
    /** Door field slot per door (−1: closed, not walkable, or no seed cell). */
    this.doorField = new Int16Array(maxDoors).fill(-1);
    this.roomDoorStart = new Int32Array(maxRooms + 1);
    this.roomDoorList = new Int16Array(maxDoors * 2);
    // fields
    this.fields = new Uint16Array(0);
    this.fieldSlots = 0;
    this.fieldsDone = 0;
    /** Open walkable doors beyond ROAM.maxFields (no field: paths through them are not estimated). */
    this.fieldsSkipped = 0;
    /** Working distances of the running Dijkstra (m). */
    this.work = new Float32Array(nav.capacity);
    // bake state
    this.task = T_IDLE;
    this.phase = P_SEED;
    this.pos = 0;
    this.door = 0;
    this.built = false;
    this.edgeReady = false;
    this.fieldsReady = false;
    this.bakeMs = 0;
    this.bakeSlices = 0;
    this.maxSliceMs = 0;
    this.edgeCells = 0;
    // player
    this.px = 0;
    this.pz = 0;
    this.pCell = -2;
    this.pRoomA = 0;
    this.pRoomB = 0;
    this.lastRoom = 0;
    this.pDoor = -1;
    this.pAnchor = -1;
    this.pAnchorD = 0;
    this.pDoors = new Int16Array(ROAM.maxPlayerDoors);
    this.pDoorN = 0;
    this.trackCount = 0;
  }

  /** The bake is running (fields not all ready). */
  get baking() { return this.task !== T_IDLE && this.task !== T_DONE; }

  /**
   * Index a freshly finalized grid (synchronous part: rooms and the door
   * graph), then queue the sliced bake (edge field, door fields).
   * @param {{ doors: { cx: number, cz: number, nx: number, nz: number, width: number, walkable: boolean, open: boolean, leadsTo: string }[] }} layout
   */
  build(layout) {
    const nav = this.nav, n = nav.count, cell = nav.cell;
    const minCells = Math.max(1, Math.round(ROAM.minRoomM2 / (cell * cell)));
    const rooms = nav.labelRooms(minCells, this.maxRooms);
    this.roomCount = rooms;
    const RC = this.roomCells, RX = this.roomCx, RZ = this.roomCz, RF = this.roomFlags;
    RC.fill(0); RX.fill(0); RZ.fill(0); RF.fill(0);
    for (let i = 0; i < n; i++) {
      const r = nav.room[i];
      if (r === 0) continue;
      RC[r]++;
      RX[r] += nav.centerX(i);
      RZ[r] += nav.centerZ(i);
      const f = nav.flags[i];
      if (f & NAV_POCKET) RF[r] |= ROOM_POCKET;
      if (f & NAV_VIRTUAL) RF[r] |= ROOM_VIRTUAL;
    }
    for (let r = 1; r <= rooms; r++) if (RC[r] > 0) { RX[r] /= RC[r]; RZ[r] /= RC[r]; }

    // doors → rooms
    const D = layout.doors;
    const nd = Math.min(D.length, this.maxDoors);
    this.doorCount = nd;
    this.doorField.fill(-1);
    this.fieldsSkipped = 0;
    let slots = 0;
    for (let k = 0; k < nd; k++) {
      const d = D[k];
      this.doorX[k] = d.cx;
      this.doorZ[k] = d.cz;
      this.doorHalf[k] = d.width / 2;
      this.doorRoomA[k] = this.probeRoom(d.cx, d.cz, d.nx, d.nz);
      this.doorRoomB[k] = this.probeRoom(d.cx, d.cz, -d.nx, -d.nz);
      const ra = this.doorRoomA[k], rb = this.doorRoomB[k];
      this.doorExterior[k] = d.leadsTo !== 'mapped' || ra === 0 || rb === 0 || ((RF[ra] | RF[rb]) & ROOM_VIRTUAL) !== 0 ? 1 : 0;
      if (d.open && d.walkable && slots < ROAM.maxFields && nav.nearestWalkable(d.cx, d.cz, 0.45) >= 0) this.doorField[k] = slots++;
      else if (d.open && d.walkable && slots >= ROAM.maxFields) this.fieldsSkipped++;
    }
    // room → doors (CSR)
    const S = this.roomDoorStart, L = this.roomDoorList;
    S.fill(0);
    for (let k = 0; k < nd; k++) {
      const a = this.doorRoomA[k], b = this.doorRoomB[k];
      if (a) S[a + 1]++;
      if (b && b !== a) S[b + 1]++;
    }
    for (let r = 0; r < this.maxRooms; r++) S[r + 1] += S[r];
    const fill = this.work; // borrowed as a per-room cursor (build time)
    for (let r = 0; r <= rooms; r++) fill[r] = S[r];
    for (let k = 0; k < nd; k++) {
      const a = this.doorRoomA[k], b = this.doorRoomB[k];
      if (a) L[fill[a]++] = k;
      if (b && b !== a) L[fill[b]++] = k;
    }
    // field pool (grown at build time only)
    this.fieldSlots = slots;
    if (this.fields.length < slots * n) this.fields = new Uint16Array(slots * n);
    this.fieldsDone = 0;
    // bake queue
    this.task = T_EDGE_IN;
    this.phase = P_SEED;
    this.pos = 0;
    this.door = 0;
    this.edgeReady = false;
    this.fieldsReady = false;
    nav.edgeReady = false;
    this.bakeMs = 0;
    this.bakeSlices = 0;
    this.maxSliceMs = 0;
    this.edgeCells = 0;
    this.pCell = -2;
    this.pRoomA = this.pRoomB = this.lastRoom = 0;
    this.pDoor = -1;
    this.pAnchor = -1;
    this.pDoorN = 0;
    this.built = true;
  }

  /** No edge field for this build (a virtual room: nothing is mapped, so there is no edge). */
  skipEdge() {
    if (this.task === T_EDGE_IN || this.task === T_EDGE_OUT) {
      this.task = T_DOORS;
      this.door = 0;
      this.phase = P_SEED;
      this.pos = 0;
    }
    this.edgeReady = false;
    this.nav.edgeReady = false;
  }

  /** Forget the world (a build in another mode). */
  clear() {
    this.built = false;
    this.task = T_IDLE;
    this.roomCount = 0;
    this.doorCount = 0;
    this.fieldSlots = 0;
    this.edgeReady = false;
    this.fieldsReady = false;
    this.pAnchor = -1;
    this.pDoorN = 0;
  }

  /**
   * The room 0.45–0.9 m out from a door centre along (dx, dz), else 0.
   * @param {number} x @param {number} z @param {number} dx @param {number} dz
   */
  probeRoom(x, z, dx, dz) {
    const nav = this.nav, P = ROAM.doorProbes;
    for (let k = 0; k < P.length; k++) {
      const px = x + dx * P[k], pz = z + dz * P[k];
      const r = nav.roomAt(px, pz);
      if (r) return r;
      // a sliver cell: look one cell around
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const q = nav.roomAt(px + a * nav.cell, pz + b * nav.cell);
          if (q) return q;
        }
      }
    }
    return 0;
  }

  // ── bake ────────────────────────────────────────────────────────────────

  /**
   * Run the bake for about `budgetMs` (the clock is read every 256 cells).
   * @param {number} [budgetMs]
   * @returns {boolean} true when everything is baked
   */
  step(budgetMs = ROAM.bakeBudgetMs) {
    if (!this.baking) return this.task === T_DONE;
    const t0 = this.clock();
    const end = t0 + budgetMs;
    while (this.baking) {
      if (!this.slice(end)) break;
    }
    const ms = this.clock() - t0;
    this.bakeMs += ms;
    this.bakeSlices++;
    if (ms > this.maxSliceMs) this.maxSliceMs = ms;
    return this.task === T_DONE;
  }

  /** Bake everything now (tests; behind an opaque panel). */
  finish() {
    while (this.baking) this.step(1e9);
  }

  /**
   * One unit of work; false when the time is up.
   * @param {number} end clock deadline
   */
  slice(end) {
    const task = this.task;
    if (task === T_EDGE_IN || task === T_EDGE_OUT) {
      const mode = task === T_EDGE_IN ? M_IN : M_OUT;
      if (!this.dijkstra(mode, -1, end)) return false;
      if (task === T_EDGE_IN) { this.task = T_EDGE_OUT; this.phase = P_SEED; this.pos = 0; return true; }
      this.edgeReady = true;
      this.nav.edgeReady = true;
      this.task = T_DOORS;
      this.door = 0;
      this.phase = P_SEED;
      this.pos = 0;
      return true;
    }
    if (task === T_DOORS) {
      while (this.door < this.doorCount && this.doorField[this.door] < 0) this.door++;
      if (this.door >= this.doorCount) { this.fieldsReady = true; this.task = T_DONE; return true; }
      if (!this.dijkstra(M_WALK, this.door, end)) return false;
      this.fieldsDone++;
      this.door++;
      this.phase = P_SEED;
      this.pos = 0;
      return true;
    }
    return true;
  }

  /**
   * The shared sliced Dijkstra (resumes from this.phase / this.pos).
   * - M_WALK: from door `door`'s centre over walkable cells → its Uint16 field (cm, rounded up);
   * - M_IN: from the off-map cells next to the map, over map cells (real walls block) → + margin;
   * - M_OUT: from the map cells next to the off-map, over off-map cells → − margin.
   * @param {number} mode @param {number} door @param {number} end clock deadline
   * @returns {boolean} true when this field is complete
   */
  dijkstra(mode, door, end) {
    const nav = this.nav, n = nav.count, w = nav.w, h = nav.h, fl = nav.flags, cell = nav.cell;
    const dist = this.work, heap = nav.heap, every = ROAM.clockEvery;
    if (this.phase === P_SEED) {
      if (this.pos === 0) heap.clear();
      if (mode === M_WALK) {
        dist.fill(Infinity, 0, n);
        const s = nav.nearestWalkable(this.doorX[door], this.doorZ[door], 0.45);
        if (s >= 0) {
          dist[s] = 0;
          heap.push(s, 0);
        }
        this.phase = P_RUN;
        this.pos = 0;
      } else {
        // seeds: cells of the other kind with a 4-neighbour of this kind that is not a real wall
        let i = this.pos;
        if (i === 0) dist.fill(Infinity, 0, n);
        for (; i < n; i++) {
          if ((i & (every * 4 - 1)) === 0 && i > this.pos && this.clock() >= end) { this.pos = i; return false; }
          const f = fl[i];
          if (enters(mode, f)) continue; // a seed is a cell we do NOT propagate into
          const ix = i % w, iz = (i - ix) / w;
          let near = false;
          if (ix > 0 && enters(mode, fl[i - 1]) && !isBarrier(fl[i - 1])) near = true;
          else if (ix < w - 1 && enters(mode, fl[i + 1]) && !isBarrier(fl[i + 1])) near = true;
          else if (iz > 0 && enters(mode, fl[i - w]) && !isBarrier(fl[i - w])) near = true;
          else if (iz < h - 1 && enters(mode, fl[i + w]) && !isBarrier(fl[i + w])) near = true;
          if (near) { dist[i] = 0; heap.push(i, 0); }
        }
        this.phase = P_RUN;
        this.pos = 0;
      }
    }
    if (this.phase === P_RUN) {
      let pops = 0;
      for (;;) {
        if (++pops >= every) {
          pops = 0;
          if (this.clock() >= end) return false;
        }
        const i = heap.pop();
        if (i < 0) break;
        const fi = fl[i];
        // a real wall cell gets a distance but passes nothing on (edge modes)
        if (mode !== M_WALK && dist[i] > 0 && isBarrier(fi)) continue;
        const ix = i % w, iz = (i - ix) / w, di = dist[i];
        for (let k = 0; k < 8; k++) {
          const jx = ix + NDX[k], jz = iz + NDZ[k];
          if (jx < 0 || jz < 0 || jx >= w || jz >= h) continue;
          const j = jz * w + jx;
          const fj = fl[j];
          if (!enters(mode, fj)) continue;
          if (k >= 4) {
            const a = fl[iz * w + jx], b = fl[jz * w + ix];
            if (!enters(mode, a) || !enters(mode, b)) continue;
            if (mode !== M_WALK && (isBarrier(a) || isBarrier(b))) continue;
          }
          const nd = di + (k >= 4 ? SQRT2 : 1) * cell;
          if (nd < dist[j]) {
            dist[j] = nd;
            heap.push(j, nd);
          }
        }
      }
      this.phase = P_OUT;
      this.pos = 0;
    }
    // P_OUT: write the result
    let i = this.pos;
    if (mode === M_WALK) {
      const F = this.fields, o = this.doorField[door] * n, far = ROAM.far;
      for (; i < n; i++) {
        if ((i & (every * 16 - 1)) === 0 && i > this.pos && this.clock() >= end) { this.pos = i; return false; }
        const d = dist[i];
        F[o + i] = d < 655.0 ? Math.ceil(d * 100 - 1e-6) : far;
      }
    } else {
      const E = nav.edge, half = cell * 0.5;
      for (; i < n; i++) {
        if ((i & (every * 16 - 1)) === 0 && i > this.pos && this.clock() >= end) { this.pos = i; return false; }
        const f = fl[i];
        const mine = mode === M_IN ? isMap(f) : !isMap(f);
        if (!mine) continue;
        const d = dist[i];
        const m = d === Infinity ? 99 : d - half > 0 ? d - half : 0;
        E[i] = mode === M_IN ? m : -(m > half ? m : half);
        if (mode === M_OUT) this.edgeCells++;
      }
    }
    this.pos = 0;
    return true;
  }

  // ── per frame ───────────────────────────────────────────────────────────

  /**
   * Where the player is: room(s), the door gap they stand in, the anchor cell
   * and the doors of their room(s). Cheap when the head stays in its cell.
   * Allocation-free.
   * @param {number} x @param {number} z head
   */
  trackPlayer(x, z) {
    this.px = x;
    this.pz = z;
    this.trackStep();
  }

  /**
   * trackPlayer from a head object (reads its fields: no doubles passed as
   * arguments, so V8 boxes nothing per frame).
   * @param {{ x: number, z: number }} head
   */
  track(head) {
    this.px = head.x;
    this.pz = head.z;
    this.trackStep();
  }

  /** trackPlayer's work on (px, pz). */
  trackStep() {
    const x = this.px, z = this.pz;
    if (!this.built || !(x === x) || !(z === z)) return;
    const nav = this.nav;
    const i = nav.index(x, z);
    if (i === this.pCell) {
      const a = this.pAnchor;
      if (a >= 0) {
        const ax = a % nav.w, dx = nav.ox + (ax + 0.5) * nav.cell - x, dz = nav.oz + ((a - ax) / nav.w + 0.5) * nav.cell - z;
        this.pAnchorD = Math.sqrt(dx * dx + dz * dz);
      }
      return;
    }
    this.pCell = i;
    this.trackCount++;
    let ra = 0, rb = 0, door = -1;
    if (i >= 0) {
      ra = nav.room[i];
      if (ra === 0 && (nav.flags[i] & NAV_DOOR) !== 0) {
        door = this.doorAtPlayer();
        if (door >= 0) { ra = this.doorRoomA[door]; rb = this.doorRoomB[door]; }
      }
      if (ra === 0 && rb === 0) {
        // on a wall slab or a sliver: the nearest room cell within 0.3 m (3 cells)
        const c = nearestRoomCell(nav, i, 3);
        if (c >= 0) ra = nav.room[c];
      }
    }
    if (ra === 0 && rb === 0) ra = this.lastRoom; // off the map: where they were last
    if (ra !== 0) this.lastRoom = ra;
    this.pRoomA = ra;
    this.pRoomB = rb;
    this.pDoor = door;
    // anchor: the nearest walkable cell in those rooms (or a door gap); the point goes through
    // the grid's query fields (computed doubles passed as arguments would be boxed by V8)
    nav.qx = x;
    nav.qz = z;
    let a = nav.nearestWalkableInRoomsQ(ROAM.anchorR, ra, rb, door >= 0);
    if (a < 0) a = nav.nearestWalkable(x, z, ROAM.anchorR);
    this.pAnchor = a;
    if (a >= 0) {
      const ax = a % nav.w, dx = nav.ox + (ax + 0.5) * nav.cell - x, dz = nav.oz + ((a - ax) / nav.w + 0.5) * nav.cell - z;
      this.pAnchorD = Math.sqrt(dx * dx + dz * dz);
    }
    // doors of the player's rooms (deduplicated)
    let m = 0;
    const P = this.pDoors, S = this.roomDoorStart, L = this.roomDoorList;
    for (let pass = 0; pass < 2; pass++) {
      const r = pass === 0 ? ra : rb;
      if (r === 0 || (pass === 1 && r === ra)) continue;
      for (let q = S[r]; q < S[r + 1] && m < P.length; q++) {
        const k = L[q];
        let dup = false;
        for (let u = 0; u < m; u++) if (P[u] === k) { dup = true; break; }
        if (!dup) P[m++] = k;
      }
    }
    if (door >= 0 && m < P.length) {
      let dup = false;
      for (let u = 0; u < m; u++) if (P[u] === door) { dup = true; break; }
      if (!dup) P[m++] = door;
    }
    this.pDoorN = m;
  }

  /**
   * The door whose gap contains (x, z): nearest centre within half its width + 0.5 m.
   * @param {number} x @param {number} z
   * @returns {number} door id or −1
   */
  doorAt(x, z) {
    this.px = x;
    this.pz = z;
    return this.doorAtPlayer();
  }

  /** doorAt for the tracked head (px, pz). @returns {number} */
  doorAtPlayer() {
    const x = this.px, z = this.pz;
    let best = -1, bestD = Infinity;
    for (let k = 0; k < this.doorCount; k++) {
      const dx = this.doorX[k] - x, dz = this.doorZ[k] - z;
      const d = dx * dx + dz * dz, lim = this.doorHalf[k] + 0.5;
      if (d < bestD && d <= lim * lim) { bestD = d; best = k; }
    }
    return best;
  }

  /** Is room r one of the player's rooms now? @param {number} r */
  isPlayerRoom(r) {
    return r !== 0 && (r === this.pRoomA || r === this.pRoomB);
  }

  /**
   * Path length (m) from the player (as tracked) to cell i. Straight line in
   * the player's own room(s); through the doors of the player's room(s)
   * otherwise; Infinity when no door leads there. Before the door fields are
   * baked (or before the player was tracked): the build-start field.
   * @param {number} i cell index
   */
  pathFromPlayerCell(i) {
    const cm = this.pathFromPlayerCm(i);
    if (cm === PATH_FAR) return Infinity;
    if (cm < 0) return this.nav.pathDist[i];
    return cm * 0.01;
  }

  /**
   * pathFromPlayerCell in whole centimetres, rounded up (an integer, so a hot
   * loop gets it back without V8 boxing a double): PATH_FAR when unreachable,
   * −1 when the fields are not ready (use the build-start field).
   * Allocation-free.
   * @param {number} i cell index
   */
  pathFromPlayerCm(i) {
    const nav = this.nav;
    if (i < 0 || i >= nav.count) return PATH_FAR;
    if (!this.fieldsReady || this.pAnchor < 0) return -1;
    const r = nav.room[i];
    if (r !== 0 && (r === this.pRoomA || r === this.pRoomB)) {
      const ix = i % nav.w;
      const dx = nav.ox + (ix + 0.5) * nav.cell - this.px, dz = nav.oz + ((i - ix) / nav.w + 0.5) * nav.cell - this.pz;
      return Math.ceil(Math.sqrt(dx * dx + dz * dz) * 100) | 0;
    }
    const F = this.fields, n = nav.count, a = this.pAnchor, far = ROAM.far;
    let best = 0x7fffffff;
    for (let u = 0; u < this.pDoorN; u++) {
      const slot = this.doorField[this.pDoors[u]];
      if (slot < 0) continue;
      const o = slot * n;
      const fa = F[o + a];
      if (fa === far) continue;
      const fb = F[o + i];
      if (fb === far) continue;
      const s = fa + fb;
      if (s < best) best = s;
    }
    if (best === 0x7fffffff) return PATH_FAR;
    return (best + Math.ceil(this.pAnchorD * 100)) | 0;
  }

  /**
   * Path (m) from door k's centre to cell i (its field), Infinity when unreachable or not baked.
   * @param {number} k @param {number} i
   */
  doorDistance(k, i) {
    if (k < 0 || k >= this.doorCount || i < 0 || i >= this.nav.count) return Infinity;
    const slot = this.doorField[k];
    if (slot < 0 || !this.fieldIndexDone(k)) return Infinity;
    const v = this.fields[slot * this.nav.count + i];
    return v === ROAM.far ? Infinity : v * 0.01;
  }

  /** Has door k's field been written in this bake? @param {number} k */
  fieldIndexDone(k) {
    if (this.fieldsReady) return true;
    return this.task === T_DOORS && k < this.door;
  }

  /** Bytes held by the index (fields pool + working array + per-room/door tables). */
  bytes() {
    return this.fields.byteLength + this.work.byteLength + this.maxRooms * 13 + this.maxDoors * 22 + this.roomDoorStart.byteLength + this.roomDoorList.byteLength;
  }

  /**
   * JSON-safe summary for the session record (allocates: build time / session end).
   */
  report() {
    const nav = this.nav, a2 = nav.cell * nav.cell;
    /** @type {{ id: number, area: number, c: number[], pocket: boolean, virtual: boolean, doors: number }[]} */ const rooms = [];
    for (let r = 1; r <= this.roomCount; r++) {
      rooms.push({
        id: r, area: Math.round(this.roomCells[r] * a2 * 10) / 10, c: [Math.round(this.roomCx[r] * 100) / 100, Math.round(this.roomCz[r] * 100) / 100],
        pocket: (this.roomFlags[r] & ROOM_POCKET) !== 0, virtual: (this.roomFlags[r] & ROOM_VIRTUAL) !== 0,
        doors: this.roomDoorStart[r + 1] - this.roomDoorStart[r],
      });
    }
    /** @type {{ id: number, rooms: number[], exterior: boolean, field: boolean }[]} */ const doors = [];
    for (let k = 0; k < this.doorCount; k++) {
      doors.push({ id: k, rooms: [this.doorRoomA[k], this.doorRoomB[k]], exterior: this.doorExterior[k] === 1, field: this.doorField[k] >= 0 });
    }
    return {
      rooms: this.roomCount, roomList: rooms, doors, doorFields: this.fieldSlots, fieldsSkipped: this.fieldsSkipped, fieldsReady: this.fieldsReady, edgeReady: this.edgeReady,
      edgeCells: this.edgeCells, bakeMs: Math.round(this.bakeMs * 10) / 10, bakeSlices: this.bakeSlices, maxSliceMs: Math.round(this.maxSliceMs * 100) / 100,
      bytes: this.bytes(),
    };
  }
}

/**
 * Nearest cell with a room id within R cells of cell i (square search, in cells).
 * @param {import('./NavGrid.js').NavGrid} nav @param {number} i @param {number} R
 */
function nearestRoomCell(nav, i, R) {
  const ix0 = i % nav.w, iz0 = (i - ix0) / nav.w;
  let best = -1, bestD = Infinity;
  for (let dz = -R; dz <= R; dz++) {
    const iz = iz0 + dz;
    if (iz < 0 || iz >= nav.h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const ix = ix0 + dx;
      if (ix < 0 || ix >= nav.w) continue;
      const i = iz * nav.w + ix;
      if (nav.room[i] === 0) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}
