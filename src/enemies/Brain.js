// @ts-check
/**
 * Enemy decisions and movement (pure: no three.js; allocation-free after
 * construction). CONTRACTS.md "Enemies" → Brain, with PLAN §9's tested CQC
 * values.
 *
 * - Decisions at 10 Hz per enemy, staggered round-robin; steering, movement
 *   and shot timing every frame.
 * - Each enemy walks (path planner on the world's nav grid) to an engagement
 *   point 3–7 m from the player with line of sight to the player's head or
 *   chest, spread away from his mates' points. No such point: the nearest
 *   reachable one toward the player, re-chosen when he gets there.
 * - Sight: line of sight from his eye (world.segmentClear) inside a 120° cone,
 *   always within 2.2 m. On first sight a reaction time runs before he may
 *   shoot (0.25 s when he only lost you for a moment), and his first shot after
 *   acquiring you never comes before `firstShot` s.
 * - Aim error 0.07 rad on acquiring you, settling over `aimSettle` s to
 *   `aimErr1`; each shot of a burst adds a little; a flinch or a near miss
 *   throws it back.
 * - Difficulty (`DIFFICULTY`, `setDifficulty`): "test" (the default for the
 *   first headset tests: settled error 0.035 rad over 1.6 s, reaction
 *   0.6–1.1 s, first shot ≥ 0.9 s after acquiring, half damage to the player)
 *   or "realistic" (PLAN §9's tested CQC values: 0.012 rad over 0.9 s,
 *   0.45–0.85 s). The owner picks it (a pure option; nothing here reads the URL).
 * - Bursts of 2–4 rounds at 600 rpm, 0.45–1.1 s apart; a 30-round magazine and
 *   a 2.6 s reload. At most two enemies hold a shooter slot at a time; a slot
 *   is given up after 4 s when another enemy is waiting, or when he loses you.
 * - Path finding: the planner gets at most `pathQuota` A* expansions and about
 *   `pathBudgetMs` of each frame (it checks the clock every 64 expansions).
 * - He never fires through a mate (line-of-fire check) and never walks into
 *   one (separation).
 * - Movement never leaves walkable nav cells (x-only / z-only slide, else stop)
 *   and never closes within 2.5 m of the player's head (he backs off instead).
 * - Stuck: < 0.15 m of progress in 0.7 s re-plans the path (twice), then a new
 *   decision (CQC-LOG:1840).
 * - Hearing: a player shot alerts every enemy within 40 m of path; a round
 *   passing within 1 m suppresses him (aim error up, shooting delayed).
 *
 * The owner reads per agent: x, y, z, yaw, vx, vz (root motion), aimX/Y/Z and
 * raise (for the animator), `fire` (a shot this frame), `flinched`, and calls
 * hit()/kill() on damage.
 */

import { Rng, clamp, wrapAngle } from './math.js';

export const AI = Object.freeze({
  thinkHz: 10,
  ringMin: 3.0, ringMax: 7.0, // engagement distance from the player (m)
  keepAway: 2.5, // never closer to the player's head (m)
  walk: 1.25, walkAim: 0.75, // m/s
  accel: 4.0, // m/s²
  turnRate: 3.6, // rad/s
  eye: 1.6, // m above his floor
  cone: Math.cos(Math.PI / 3), // 120° view
  noticeR: 2.2,
  react: [0.45, 0.85], reacquire: 0.25, reacquireWithin: 1.5,
  aimErr0: 0.07, aimErr1: 0.012, aimSettle: 0.9, aimPerShot: 0.008,
  burst: [2, 4], rpm: 600, burstGap: [0.45, 1.1],
  mag: 30, reload: 2.6,
  maxShooters: 2, slotHold: 4.0, slotCooldown: 1.0,
  lostRelease: 0.6, // s without sight before giving up the slot
  repositionNoSight: 2.5, // s at his point without sight → new point
  holdTime: [6, 11], // s at one point before moving on
  stuckWindow: 0.7, stuckDist: 0.15, maxRepaths: 2,
  hearPath: 40, nearMiss: 1.0,
  flinch: 0.35, // s
  samples: 20, // engagement candidates per decision
  spread: 2.0, // m between enemies' points
  separation: 0.8, // m between enemies
  pathQuota: 600, // A* expansions per frame (PLAN §9: measure on Quest)
  pathBudgetMs: 0.35, // … and at most this much of the frame (PLAN cap 0.4 ms)
});

/**
 * Enemy difficulty presets. `react`, `aimErr1`, `aimSettle` and `maxShooters`
 * in AI above are the realistic values (PLAN §9, CQC-tested).
 * - firstShot: s from acquiring the player (line of sight starts) before his
 *   first shot may break, whatever the reaction time;
 * - playerTorso / playerHead: damage of one enemy round to the player (100 hp).
 * @typedef {{ name: string, aimErr1: number, aimSettle: number, react: readonly number[], firstShot: number,
 *   maxShooters: number, playerTorso: number, playerHead: number }} Difficulty
 */
export const DIFFICULTY = Object.freeze({
  /** First headset tests: you can see the fight and survive a mistake. */
  test: /** @type {Readonly<Difficulty>} */ (Object.freeze({
    // v0.2.1 headset test: the v0.2 values killed a standing player ~8 s after contact.
    name: 'test', aimErr1: 0.05, aimSettle: 2.5, react: Object.freeze([0.8, 1.4]), firstShot: 1.5, maxShooters: 1,
    playerTorso: 10, playerHead: 20,
  })),
  /** PLAN §9's tested CQC values: nearly every settled round hits at 5 m. */
  realistic: /** @type {Readonly<Difficulty>} */ (Object.freeze({
    name: 'realistic', aimErr1: AI.aimErr1, aimSettle: AI.aimSettle, react: Object.freeze([AI.react[0], AI.react[1]]), firstShot: 0,
    maxShooters: AI.maxShooters, playerTorso: 25, playerHead: 50,
  })),
});
export const DEFAULT_DIFFICULTY = 'test';

/**
 * A difficulty preset from a name ('test' | 'realistic', any case) or a preset
 * object; anything else gives the default ('test').
 * @param {string|Difficulty|null|undefined} d
 * @returns {Readonly<Difficulty>}
 */
export function resolveDifficulty(d) {
  if (d && typeof d === 'object' && typeof d.aimErr1 === 'number' && typeof d.name === 'string') return d;
  const k = typeof d === 'string' ? d.trim().toLowerCase() : '';
  return k === 'realistic' ? DIFFICULTY.realistic : k === 'test' ? DIFFICULTY.test : DIFFICULTY[DEFAULT_DIFFICULTY];
}

/**
 * The difficulty named by a URL query string (`?difficulty=realistic`), else
 * the default. Pure: the caller passes `location.search`.
 * @param {string|null|undefined} search
 * @returns {'test'|'realistic'}
 */
export function difficultyFromSearch(search) {
  if (typeof search !== 'string' || !search) return DEFAULT_DIFFICULTY;
  const m = /(?:^|[?&])difficulty=([^&#]*)/i.exec(search);
  if (!m) return DEFAULT_DIFFICULTY;
  let v = m[1];
  try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep it raw */ }
  return /** @type {'test'|'realistic'} */ (resolveDifficulty(v).name);
}

export const ST = Object.freeze({ IDLE: 0, MOVE: 1, HOLD: 2, DEAD: 3 });

// World queries take their numbers from a typed array: a double passed to a
// function V8 does not inline is boxed (allocated), and these wrappers are small
// enough for the world's query to be inlined into them.
/** @param {WorldLike} w @param {Float64Array} P [ax, ay, az, bx, by, bz] */
function clearLine(w, P) { return w.segmentClear(P[0], P[1], P[2], P[3], P[4], P[5]); }
/** @param {import('../world/NavGrid.js').NavGrid} nav @param {Float64Array} P [x, z] */
function walkable(nav, P) { return nav.isWalkable(P[0], P[1]); }
/** @param {WorldLike} w @param {Float64Array} P [x, z] → P[2] = floor y */
function floorAt(w, P) { P[2] = w.floorY(P[0], P[1]); }
/** Next random number into R[i] (a returned double would be boxed). @param {Rng} rng @param {Float64Array} R @param {number} i */
function rand(rng, R, i) { R[i] = rng.next(); }
/**
 * Snap (P[0], P[1]) onto a walkable cell within 0.5 m. P[3] = cell or −1,
 * P[4] = its region, P[5] = its clearance (m).
 * @param {import('../world/NavGrid.js').NavGrid} nav @param {Float64Array} P
 */
function snapWalkable(nav, P) {
  let c = nav.index(P[0], P[1]);
  if (c < 0 || !nav.isWalkable(P[0], P[1])) {
    c = nav.nearestWalkable(P[0], P[1], 0.5);
    if (c >= 0) { P[0] = nav.centerX(c); P[1] = nav.centerZ(c); }
  }
  P[3] = c;
  P[4] = c >= 0 ? nav.region[c] : 0;
  P[5] = c >= 0 ? nav.clr[c] : 0;
}

const PATH_PTS = 64;

export class Agent {
  /** @param {number} i */
  constructor(i) {
    this.i = i;
    this.active = false;
    this.alive = false;
    /** @type {number} */ this.state = ST.IDLE;
    this.health = 100;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.vx = 0; this.vz = 0;
    this.cell = -1;
    // goal and path
    this.hasGoal = false; this.goalX = 0; this.goalZ = 0; this.goalLos = false; this.holdT = 0; this.holdFor = 8;
    this.path = new Float32Array(PATH_PTS * 2); this.pathN = 0; this.pathI = 0; this.pathWait = false; this.pathFails = 0;
    this.progT = 0; this.progX = 0; this.progZ = 0; this.repaths = 0;
    this.think = 0;
    // perception
    this.los = false; this.losT = 0; this.lostAt = -1e9; this.aware = false; this.alertT = -1e9;
    /** Brain time when he last acquired the player (line of sight began). */
    this.acqT = -1e9;
    /** Last line-of-sight query: where he and the player were, and the answer. */
    this.seeX = 1e9; this.seeZ = 1e9; this.seePX = 1e9; this.seePY = 1e9; this.seePZ = 1e9; this.seeOK = false;
    this.reactT = -1;
    // aim and fire
    /** @type {number} */ this.aimErr = AI.aimErr0;
    this.aimT = 0; this.raise = 0; this.raiseNow = 0;
    this.aimX = 0; this.aimY = 1.4; this.aimZ = 0;
    this.slot = false; this.slotT = 0; this.slotCool = 0;
    this.burstLeft = 0; this.shotT = 0; this.gapT = 0; this.mag = AI.mag; this.reloadT = 0;
    this.blockedT = 0;
    this.flinchT = 0; this.suppressT = 0;
    /** Walking speed factor (0.6 once a leg is hit). */
    this.speedK = 1;
    /** Outputs for this frame. */
    this.fire = false;
    this.reloadStart = false;
    this.shots = 0;
    this.deadT = 0;
  }
}

/**
 * @typedef {{ x: number, y: number, z: number }} P3
 * @typedef {{ head: P3, torsoTop: P3, torsoBottom: P3, alive?: boolean }} PlayerLike
 * @typedef {{ nav: import('../world/NavGrid.js').NavGrid,
 *   segmentClear: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean,
 *   floorY: (x: number, z: number) => number }} WorldLike
 * @typedef {{ request: (id: number, sx: number, sz: number, gx: number, gz: number) => void,
 *   step: (n: number, maxMs?: number) => number, result: (id: number, out: Float32Array) => number, cancel: (id: number) => void }} PlannerLike
 */

export class Brain {
  /**
   * @param {{ maxEnemies?: number, seed?: number, difficulty?: string|Difficulty }} [o] difficulty: see DIFFICULTY (default 'test')
   */
  constructor({ maxEnemies = 6, seed = 0x5eed, difficulty = DEFAULT_DIFFICULTY } = {}) {
    this.n = maxEnemies;
    /** @type {Readonly<Difficulty>} */
    this.diff = resolveDifficulty(difficulty);
    /** @type {Agent[]} */
    this.agents = [];
    for (let i = 0; i < maxEnemies; i++) this.agents.push(new Agent(i));
    this.rng = new Rng(seed);
    /** @type {WorldLike|null} */ this.world = null;
    /** @type {PlannerLike|null} */ this.planner = null;
    this.time = 0;
    this.shooters = 0;
    this.waiting = 0;
    /** When a shooter slot was last given up: the next taker waits one 600 rpm cycle. */
    this.slotFreedAt = -1e9;
    // player (copied each frame)
    this.px = 0; this.py = 1.6; this.pz = 0; // head
    this.cx = 0; this.cy = 1.2; this.cz = 0; // chest
    this.palive = true;
    this.stats = { thinks: 0, goals: 0, goalFails: 0, repaths: 0, shots: 0, blocked: 0 };
    /** Scratch for world queries (see clearLine) and random numbers. */
    this.Q = new Float64Array(6);
    this.S = new Float64Array(6);
    this.R = new Float64Array(4);
  }

  /**
   * @param {WorldLike|null} world @param {PlannerLike|null} planner
   */
  attach(world, planner) {
    this.world = world;
    this.planner = planner;
  }

  /**
   * Change the difficulty (between rounds or live: the next decision and
   * shot use it).
   * @param {string|Difficulty|null|undefined} d
   * @returns {Readonly<Difficulty>} the preset now in use
   */
  setDifficulty(d) {
    this.diff = resolveDifficulty(d);
    return this.diff;
  }

  reset() {
    for (const a of this.agents) this.release(a, true);
    this.shooters = 0;
  }

  /**
   * Place agent i (already chosen free by the owner).
   * @param {number} i @param {number} x @param {number} z @param {number} yaw
   */
  spawn(i, x, z, yaw) {
    const a = this.agents[i];
    const nav = this.world ? this.world.nav : null;
    if (nav && !nav.isWalkable(x, z)) {
      const c = nav.nearestWalkable(x, z, 1.0);
      if (c >= 0) { x = nav.centerX(c); z = nav.centerZ(c); }
    }
    a.active = true; a.alive = true; a.state = ST.MOVE; a.health = 100;
    a.x = x; a.z = z; a.y = this.world ? this.world.floorY(x, z) : 0; a.yaw = yaw;
    a.vx = a.vz = 0;
    a.hasGoal = false; a.pathN = 0; a.pathI = 0; a.pathWait = false; a.pathFails = 0; a.holdT = 0;
    a.progT = 0; a.progX = x; a.progZ = z; a.repaths = 0;
    a.think = (i / this.n) / AI.thinkHz; // staggered
    a.los = false; a.losT = 0; a.lostAt = -1e9; a.aware = false; a.alertT = -1e9; a.reactT = -1; a.acqT = -1e9;
    a.seeX = 1e9; a.seeOK = false;
    a.aimErr = AI.aimErr0; a.aimT = 0; a.raise = 0; a.raiseNow = 0;
    a.aimX = x + Math.sin(yaw) * 5; a.aimY = a.y + 1.4; a.aimZ = z + Math.cos(yaw) * 5;
    a.slot = false; a.slotT = 0; a.slotCool = 0;
    a.burstLeft = 0; a.shotT = 0; a.gapT = 0; a.mag = AI.mag; a.reloadT = 0; a.blockedT = 0;
    a.flinchT = 0; a.suppressT = 0; a.speedK = 1; a.fire = false; a.reloadStart = false; a.shots = 0; a.deadT = 0;
  }

  /** @param {Agent} a @param {boolean} [deactivate] */
  release(a, deactivate = false) {
    if (a.slot) { a.slot = false; this.shooters--; this.slotFreedAt = this.time; }
    if (this.planner) this.planner.cancel(a.i);
    a.pathWait = false;
    a.burstLeft = 0;
    a.fire = false;
    if (deactivate) { a.active = false; a.alive = false; a.state = ST.IDLE; }
  }

  /**
   * Damage taken (health already applied by the owner).
   * @param {number} i @param {number} k strength (≈ damage / 40)
   */
  hit(i, k) {
    const a = this.agents[i];
    if (!a.alive) return;
    a.flinchT = AI.flinch * clamp(0.6 + 0.4 * k, 0.6, 1.5);
    a.burstLeft = 0;
    a.gapT = Math.max(a.gapT, 0.35);
    a.aimErr += 0.05 * clamp(k, 0.3, 1.5);
    a.aimT = 0;
    a.aware = true;
    a.alertT = this.time;
  }

  /** @param {number} i */
  kill(i) {
    const a = this.agents[i];
    if (!a.alive) return;
    this.release(a);
    a.alive = false;
    a.state = ST.DEAD;
    a.vx = a.vz = 0;
    a.deadT = 0;
  }

  /**
   * A player shot: everyone within hearing is alerted; a round passing close is
   * suppressing.
   * @param {number} x @param {number} y @param {number} z origin
   * @param {number} dx @param {number} dy @param {number} dz unit direction
   */
  hearShot(x, y, z, dx, dy, dz) {
    const nav = this.world ? this.world.nav : null;
    for (let i = 0; i < this.n; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const pd = nav ? nav.pathDistance(a.x, a.z) : 0;
      if (!(pd <= AI.hearPath) && Math.sqrt((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z)) > AI.hearPath * 0.5) continue;
      a.aware = true;
      a.alertT = this.time;
      // near miss: closest approach of the round to his chest
      const rx = a.x - x, ry = a.y + 1.3 - y, rz = a.z - z;
      const t = rx * dx + ry * dy + rz * dz;
      if (t <= 0) continue;
      const qx = rx - dx * t, qy = ry - dy * t, qz = rz - dz * t;
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (d < AI.nearMiss && d > 0.2) {
        const k = 1 - d / AI.nearMiss;
        a.suppressT = Math.max(a.suppressT, 0.6 * k);
        a.aimErr += 0.04 * k;
        if (a.burstLeft > 0 && k > 0.5) a.burstLeft = 0;
      }
    }
  }

  /**
   * @param {number} dt seconds
   * @param {PlayerLike} player
   */
  update(dt, player) {
    this.time += dt;
    const h = player.head, tt = player.torsoTop, tb = player.torsoBottom;
    this.px = h.x; this.py = h.y; this.pz = h.z;
    this.cx = tb.x + (tt.x - tb.x) * 0.6; this.cy = tb.y + (tt.y - tb.y) * 0.6; this.cz = tb.z + (tt.z - tb.z) * 0.6;
    this.palive = player.alive !== false;
    if (this.planner) this.planner.step(AI.pathQuota, AI.pathBudgetMs);
    // waiting shooters (for slot fairness)
    let w = 0;
    for (let i = 0; i < this.n; i++) { const a = this.agents[i]; if (a.alive && a.los && !a.slot && a.reactT <= 0) w++; }
    this.waiting = w;
    for (let i = 0; i < this.n; i++) {
      const a = this.agents[i];
      a.fire = false;
      a.reloadStart = false;
      if (!a.active) continue;
      if (!a.alive) { a.deadT += dt; continue; }
      a.think -= dt;
      if (a.think <= 0) { a.think += 1 / AI.thinkHz; if (a.think < 0) a.think = 0; this.decide(a); }
      this.move(a, dt);
      this.shoot(a, dt);
    }
  }

  // ─────────────────────────────────────────────────────────── decisions (10 Hz)

  /** @param {Agent} a */
  decide(a) {
    this.stats.thinks++;
    const w = this.world;
    const ex = a.x, ey = a.y + AI.eye, ez = a.z;
    const dx = this.px - ex, dz = this.pz - ez, dist = Math.sqrt(dx * dx + dz * dz);
    // sight: cone + line of sight to the head or the chest
    let see = false;
    if (this.palive) {
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      const inCone = dist < AI.noticeR || (dx * fx + dz * fz) > AI.cone * dist;
      if (inCone && w) {
        // the world is static: the last answer holds while neither of them moved 3 cm
        const mx = ex - a.seeX, mz = ez - a.seeZ, qx = this.px - a.seePX, qy = this.py - a.seePY, qz = this.pz - a.seePZ;
        if (mx * mx + mz * mz < 0.0009 && qx * qx + qy * qy + qz * qz < 0.0009) see = a.seeOK;
        else {
          const Q = this.Q;
          Q[0] = ex; Q[1] = ey; Q[2] = ez; Q[3] = this.px; Q[4] = this.py; Q[5] = this.pz;
          see = clearLine(w, Q);
          if (!see) { Q[3] = this.cx; Q[4] = this.cy; Q[5] = this.cz; see = clearLine(w, Q); }
          a.seeX = ex; a.seeZ = ez; a.seePX = this.px; a.seePY = this.py; a.seePZ = this.pz; a.seeOK = see;
        }
      } else if (inCone) see = true;
    }
    if (see && !a.los) {
      a.los = true;
      a.losT = 0;
      a.acqT = this.time;
      a.aimT = 0;
      a.aimErr = Math.max(a.aimErr, AI.aimErr0);
      const quick = this.time - a.lostAt < AI.reacquireWithin;
      rand(this.rng, this.R, 0);
      const rc = this.diff.react;
      a.reactT = quick ? AI.reacquire : (rc[0] + (rc[1] - rc[0]) * this.R[0]) * (this.time - a.alertT < 5 ? 0.85 : 1);
      a.aware = true;
    } else if (!see && a.los) {
      a.los = false;
      a.lostAt = this.time;
    }
    // path results
    if (a.pathWait && this.planner) {
      const n = this.planner.result(a.i, a.path);
      if (n > 0) { a.pathWait = false; a.pathN = n; a.pathI = 1; a.pathFails = 0; a.state = ST.MOVE; }
      else if (n === -2) {
        a.pathWait = false; a.pathN = 0; a.hasGoal = false; a.pathFails++;
        this.stats.goalFails++;
      }
    }
    // goal management
    const atGoal = a.hasGoal && Math.sqrt((a.goalX - a.x) * (a.goalX - a.x) + (a.goalZ - a.z) * (a.goalZ - a.z)) < 0.35;
    let need = !a.hasGoal && a.pathFails < 4;
    if (a.hasGoal && a.state === ST.HOLD) {
      if (!a.los && this.time - a.lostAt > AI.repositionNoSight) need = true;
      if (a.holdT > a.holdFor && !a.slot) need = true;
      if (a.blockedT > 1.0) need = true;
    }
    if (a.repaths > AI.maxRepaths) { need = true; a.repaths = 0; }
    if (need) this.chooseGoal(a);
    else if (atGoal && a.state === ST.MOVE) { a.state = ST.HOLD; a.holdT = 0; a.pathN = 0; }
    // no goal and planning keeps failing: hold here and fight from where he stands
    if (!a.hasGoal && a.pathFails >= 4) a.state = ST.HOLD;
  }

  /**
   * Pick an engagement point and request a path to it.
   * @param {Agent} a
   */
  chooseGoal(a) {
    const w = this.world;
    if (!w) return;
    const nav = w.nav, R = this.R, S = this.S, Q = this.Q, rng = this.rng;
    S[0] = a.x; S[1] = a.z;
    snapWalkable(nav, S);
    const region = S[3] >= 0 ? S[4] : 0;
    let best = -Infinity, bx = 0, bz = 0, bestLos = false;
    rand(rng, R, 0);
    const base = R[0] * Math.PI * 2;
    const N = AI.samples;
    for (let k = 0; k < N; k++) {
      rand(rng, R, 0); rand(rng, R, 1); rand(rng, R, 2);
      const ang = base + (k / N) * Math.PI * 2 + (R[0] - 0.5) * 0.25;
      const r = AI.ringMin + 0.2 + R[1] * (AI.ringMax - AI.ringMin - 0.4);
      S[0] = this.px + Math.sin(ang) * r; S[1] = this.pz + Math.cos(ang) * r;
      snapWalkable(nav, S);
      if (S[3] < 0 || (region && S[4] !== region)) continue;
      const x = S[0], z = S[1];
      const dp = Math.sqrt((x - this.px) * (x - this.px) + (z - this.pz) * (z - this.pz));
      if (dp < AI.ringMin || dp > AI.ringMax + 0.5) continue;
      Q[0] = x; Q[1] = z;
      floorAt(w, Q);
      Q[1] = Q[2] + AI.eye - 0.05; Q[0] = x; Q[2] = z; Q[3] = this.px; Q[4] = this.py; Q[5] = this.pz;
      let los = clearLine(w, Q);
      if (!los) { Q[3] = this.cx; Q[4] = this.cy; Q[5] = this.cz; los = clearLine(w, Q); }
      // score: sight first; then not far from where he is; spread from mates; mid distances; a wall or furniture close by
      const da = Math.sqrt((x - a.x) * (x - a.x) + (z - a.z) * (z - a.z));
      const off = dp - 4.5;
      let sc = (los ? 10 : 0) - da * 0.5 - (off < 0 ? -off : off) * 0.4 + R[2] * 0.6;
      if (S[5] < 0.6) sc += 0.4;
      for (let j = 0; j < this.n; j++) {
        const o = this.agents[j];
        if (j === a.i || !o.alive) continue;
        const gx = o.hasGoal ? o.goalX : o.x, gz = o.hasGoal ? o.goalZ : o.z;
        const dd = Math.sqrt((x - gx) * (x - gx) + (z - gz) * (z - gz));
        if (dd < AI.spread) sc -= (AI.spread - dd) * 6;
      }
      if (sc > best) { best = sc; bx = x; bz = z; bestLos = los; }
    }
    if (best === -Infinity) {
      // nothing on the ring: walk toward the player as far as the nav allows
      const c = nav.nearestWalkable(this.px + (a.x - this.px) * 0.3, this.pz + (a.z - this.pz) * 0.3, 3.0);
      if (c < 0 || (region && nav.region[c] !== region)) { a.hasGoal = false; a.pathFails++; this.stats.goalFails++; return; }
      bx = nav.centerX(c); bz = nav.centerZ(c); bestLos = false;
    }
    a.hasGoal = true;
    a.goalX = bx; a.goalZ = bz; a.goalLos = bestLos;
    a.holdT = 0;
    rand(rng, R, 0);
    a.holdFor = AI.holdTime[0] + (AI.holdTime[1] - AI.holdTime[0]) * R[0];
    a.blockedT = 0;
    a.state = ST.MOVE;
    a.pathN = 0;
    a.progT = 0; a.progX = a.x; a.progZ = a.z;
    this.stats.goals++;
    if (this.planner) { this.planner.request(a.i, a.x, a.z, bx, bz); a.pathWait = true; }
    else { a.path[0] = a.x; a.path[1] = a.z; a.path[2] = bx; a.path[3] = bz; a.pathN = 2; a.pathI = 1; }
  }

  // ─────────────────────────────────────────────────────────── movement (per frame)

  /** @param {Agent} a @param {number} dt */
  move(a, dt) {
    const w = this.world;
    let tvx = 0, tvz = 0;
    const toPx = this.px - a.x, toPz = this.pz - a.z, pd = Math.sqrt(toPx * toPx + toPz * toPz);
    const engaged = a.aware && (a.los || pd < 6);
    // follow the path
    if (a.state === ST.MOVE && a.pathN > 1 && a.flinchT <= 0) {
      let tx = a.path[a.pathI * 2], tz = a.path[a.pathI * 2 + 1];
      let d = Math.sqrt((tx - a.x) * (tx - a.x) + (tz - a.z) * (tz - a.z));
      while (d < 0.25 && a.pathI < a.pathN - 1) {
        a.pathI++;
        tx = a.path[a.pathI * 2]; tz = a.path[a.pathI * 2 + 1];
        d = Math.sqrt((tx - a.x) * (tx - a.x) + (tz - a.z) * (tz - a.z));
      }
      const last = a.pathI >= a.pathN - 1;
      if (last && d < 0.12) { a.state = ST.HOLD; a.holdT = 0; a.pathN = 0; }
      else if (d > 1e-4) {
        let sp = (engaged && a.los ? AI.walkAim : AI.walk) * a.speedK;
        if (last) sp = Math.min(sp, 0.35 + d * 1.6);
        tvx = (tx - a.x) / d * sp; tvz = (tz - a.z) / d * sp;
      }
    }
    if (a.state === ST.HOLD) a.holdT += dt;
    // mates: keep apart
    for (let j = 0; j < this.n; j++) {
      const o = this.agents[j];
      if (j === a.i || !o.alive) continue;
      const ox = a.x - o.x, oz = a.z - o.z, od = Math.sqrt(ox * ox + oz * oz);
      if (od < AI.separation && od > 1e-4) { const k = (AI.separation - od) / AI.separation * 1.2; tvx += ox / od * k; tvz += oz / od * k; }
    }
    // the player: never closer than keepAway; back off if he comes in
    if (pd > 1e-4) {
      const ux = toPx / pd, uz = toPz / pd;
      const toward = tvx * ux + tvz * uz;
      if (pd < AI.keepAway + 0.3 && toward > 0) { tvx -= ux * toward; tvz -= uz * toward; }
      if (pd < AI.keepAway) { tvx -= ux * 0.8; tvz -= uz * 0.8; }
    }
    if (a.flinchT > 0) { tvx *= 0.2; tvz *= 0.2; }
    // accelerate toward the wanted velocity
    const dvx = tvx - a.vx, dvz = tvz - a.vz, dv = Math.sqrt(dvx * dvx + dvz * dvz), mx = AI.accel * dt;
    if (dv > mx) { a.vx += dvx / dv * mx; a.vz += dvz / dv * mx; } else { a.vx = tvx; a.vz = tvz; }
    // move, never off walkable cells, never within keepAway (x and z first, then each alone)
    if (a.vx !== 0 || a.vz !== 0) {
      const nx = a.x + a.vx * dt, nz = a.z + a.vz * dt;
      const nav = w ? w.nav : null, Q = this.Q, keep = AI.keepAway;
      const ex0 = a.x - this.px, ez0 = a.z - this.pz, d0 = ex0 * ex0 + ez0 * ez0;
      let moved = false;
      for (let tryk = 0; tryk < 3 && !moved; tryk++) {
        const tx = tryk === 2 ? a.x : nx, tz = tryk === 1 ? a.z : nz;
        const ex = tx - this.px, ez = tz - this.pz, d1 = ex * ex + ez * ez;
        if (d1 < keep * keep && d1 < d0) continue;
        if (nav) { Q[0] = tx; Q[1] = tz; if (!walkable(nav, Q)) continue; }
        a.x = tx; a.z = tz;
        if (tryk === 1) a.vz = 0; else if (tryk === 2) a.vx = 0;
        moved = true;
      }
      if (!moved) { a.vx = 0; a.vz = 0; }
      if (w) {
        Q[0] = a.x; Q[1] = a.z;
        floorAt(w, Q);
        const k = dt * 12;
        a.y += (Q[2] - a.y) * (k < 1 ? k : 1);
      }
    }
    // stuck: wants to move, makes no progress
    if (a.state === ST.MOVE && a.pathN > 1) {
      a.progT += dt;
      if (a.progT >= AI.stuckWindow) {
        if (Math.sqrt((a.x - a.progX) * (a.x - a.progX) + (a.z - a.progZ) * (a.z - a.progZ)) < AI.stuckDist && a.flinchT <= 0) {
          a.repaths++;
          this.stats.repaths++;
          if (this.planner && a.hasGoal) { this.planner.request(a.i, a.x, a.z, a.goalX, a.goalZ); a.pathWait = true; a.pathN = 0; }
        }
        a.progT = 0; a.progX = a.x; a.progZ = a.z;
      }
    } else { a.progT = 0; a.progX = a.x; a.progZ = a.z; }
    // facing: the player when engaged, else where he walks
    let want = a.yaw;
    const sp = Math.sqrt(a.vx * a.vx + a.vz * a.vz);
    if (engaged && pd > 1e-3) want = Math.atan2(toPx, toPz);
    else if (sp > 0.2) want = Math.atan2(a.vx, a.vz);
    else if (a.state === ST.MOVE && a.pathN > 1) want = Math.atan2(a.path[a.pathI * 2] - a.x, a.path[a.pathI * 2 + 1] - a.z);
    const dy = wrapAngle(want - a.yaw), mt = AI.turnRate * dt;
    a.yaw = wrapAngle(a.yaw + clamp(dy, -mt, mt));
    // rifle: up when he sees you (or has you close), down otherwise; aim point
    a.raise = engaged && a.reloadT <= 0 && (a.los || pd < 4) ? 1 : 0;
    const rr = dt / 0.32;
    a.raiseNow = a.raiseNow < a.raise ? Math.min(a.raise, a.raiseNow + rr) : Math.max(a.raise, a.raiseNow - rr * 0.8);
    if (engaged) { a.aimX = this.cx; a.aimY = this.cy; a.aimZ = this.cz; }
    else {
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      a.aimX = a.x + fx * 4; a.aimY = a.y + 1.0; a.aimZ = a.z + fz * 4;
    }
  }

  // ─────────────────────────────────────────────────────────── shooting (per frame)

  /** @param {Agent} a @param {number} dt */
  shoot(a, dt) {
    if (a.flinchT > 0) a.flinchT -= dt;
    if (a.suppressT > 0) a.suppressT -= dt;
    if (a.slotCool > 0) a.slotCool -= dt;
    if (a.gapT > 0) a.gapT -= dt;
    if (a.los) a.losT += dt;
    if (a.reloadT > 0) {
      a.reloadT -= dt;
      if (a.reloadT <= 0) { a.reloadT = 0; a.mag = AI.mag; }
    }
    if (a.los && a.reactT > 0) a.reactT -= dt;
    const D = this.diff;
    // aim settles while he has you in sight
    if (a.los) {
      a.aimT += dt;
      const settle = AI.aimErr0 + (D.aimErr1 - AI.aimErr0) * Math.min(1, a.aimT / D.aimSettle);
      // extra error (flinch, near miss, recoil) decays toward the settling curve
      a.aimErr = settle + Math.max(0, a.aimErr - settle) * Math.exp(-dt / 0.5);
    }
    // the slot
    if (a.slot) {
      a.slotT += dt;
      const lost = !a.los && this.time - a.lostAt > AI.lostRelease;
      if (lost || a.reloadT > 0 || (a.slotT > AI.slotHold && this.waiting > 0 && a.burstLeft === 0) || !this.palive) {
        a.slot = false; this.shooters--; a.slotCool = AI.slotCooldown; a.burstLeft = 0;
        this.slotFreedAt = this.time;
      }
    }
    const facing = Math.abs(wrapAngle(Math.atan2(this.px - a.x, this.pz - a.z) - a.yaw)) < 0.35;
    // the first shot after acquiring you never breaks before D.firstShot
    const ready = a.los && this.palive && a.reactT <= 0 && this.time - a.acqT >= D.firstShot && a.flinchT <= 0 && a.suppressT <= 0 && a.reloadT <= 0 && a.raiseNow >= 0.95 && facing;
    if (ready && !a.slot && a.slotCool <= 0 && this.shooters < D.maxShooters && this.time - this.slotFreedAt > 0.15) { a.slot = true; a.slotT = 0; this.shooters++; }
    if (!a.slot || !ready) { if (!ready) a.burstLeft = 0; return; }
    if (a.burstLeft === 0) {
      if (a.gapT > 0) return;
      rand(this.rng, this.R, 0);
      a.burstLeft = AI.burst[0] + Math.floor(this.R[0] * (AI.burst[1] - AI.burst[0] + 1));
      a.shotT = 0;
    }
    a.shotT -= dt;
    if (a.shotT > 0) return;
    // line of fire: never through a mate
    if (this.mateInLine(a)) {
      a.blockedT += dt;
      a.burstLeft = 0;
      a.gapT = 0.3;
      this.stats.blocked++;
      return;
    }
    a.blockedT = 0;
    a.fire = true;
    a.shots++;
    this.stats.shots++;
    a.shotT += 60 / AI.rpm;
    if (a.shotT < 0) a.shotT = 0;
    a.burstLeft--;
    a.mag--;
    a.aimErr += AI.aimPerShot;
    if (a.burstLeft === 0) { rand(this.rng, this.R, 0); a.gapT = AI.burstGap[0] + (AI.burstGap[1] - AI.burstGap[0]) * this.R[0]; }
    if (a.mag <= 0) { a.reloadT = AI.reload; a.reloadStart = true; a.burstLeft = 0; }
  }

  /** A mate standing within 0.45 m of the line from him to the player's chest. @param {Agent} a */
  mateInLine(a) {
    const sx = a.x, sz = a.z, lx = this.cx - sx, lz = this.cz - sz, L2 = lx * lx + lz * lz;
    if (L2 < 1e-6) return false;
    for (let j = 0; j < this.n; j++) {
      const o = this.agents[j];
      if (j === a.i || !o.alive) continue;
      const t = ((o.x - sx) * lx + (o.z - sz) * lz) / L2;
      if (t <= 0.02 || t >= 1) continue;
      const qx = sx + lx * t - o.x, qz = sz + lz * t - o.z;
      if (qx * qx + qz * qz < 0.45 * 0.45) return true;
    }
    return false;
  }

  /**
   * Random direction within `err` rad of the unit direction (dx, dy, dz),
   * uniform over the cone's disk. Writes out[0..2].
   * @param {number} dx @param {number} dy @param {number} dz @param {number} err
   * @param {Float64Array} out
   */
  scatter(dx, dy, dz, err, out) {
    // basis perpendicular to d
    let ux = -dz, uy = 0, uz = dx;
    let ul = Math.sqrt(ux * ux + uz * uz);
    if (ul < 1e-6) { ux = 1; uz = 0; ul = 1; }
    ux /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const r = Math.sqrt(this.rng.next()) * Math.tan(err), th = this.rng.next() * Math.PI * 2;
    const a = Math.cos(th) * r, b = Math.sin(th) * r;
    const ox = dx + ux * a + vx * b, oy = dy + uy * a + vy * b, oz = dz + uz * a + vz * b;
    const l = Math.sqrt(ox * ox + oy * oy + oz * oz);
    out[0] = ox / l; out[1] = oy / l; out[2] = oz / l;
  }

  /** Living agents. */
  living() {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.agents[i].alive) n++;
    return n;
  }
}
