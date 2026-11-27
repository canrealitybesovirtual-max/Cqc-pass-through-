// @ts-check
/**
 * Enemies (CONTRACTS.md "Enemies"): the `enemies` system.
 *
 *   const enemies = new EnemyManager(assets, scene, 6, { world, light: gfx.flashLights[1], difficulty });  // at load
 *   enemies.bind(events);            // 'shot' (hearing), 'enemyHit' (→ applyHit), 'pause'
 *   // warm-up: draw enemies.warmMeshes() once (or setWarm(true) … setWarm(false))
 *   enemies.spawn(x, z, facing);     // GameSession, from world.findSpawn (its tier is recorded)
 *   enemies.update(dt, t, frame, ctx);
 *   ctx.raycast = world first, then enemies.raycast(…, max = world hit distance, out)
 *
 * Every instance is prebuilt here (EnemyPool: SkeletonUtils clones sharing
 * geometry and materials); spawning only resets, places and shows one. Per
 * enemy: 2 draws (body, rifle) + one shared instanced draw for flashes and one
 * for hit puffs (HitPuff: blood mist and cloth dust where a round strikes).
 *
 * Difficulty (Brain's DIFFICULTY): `opts.difficulty` ('test' | 'realistic');
 * without it, `?difficulty=realistic` in the page URL is read once here, at
 * construction (load); the default is 'test' (gentler aim, slower first shot,
 * half damage) for the first headset tests. `setDifficulty(name)` changes it.
 *
 * Spawns: the tier of each (world.spawner.lastTier when the point came from
 * world.findSpawn: 3 behind a door, 2 hidden in the room, 1 visible behind the
 * player, 4 in view as a last resort, 0 placed directly) is kept per enemy
 * (`tier`) and counted in `stats` (session record).
 *
 * Death falls: the clearest of the shot direction, ±60° and back toward the
 * shooter over 1.2 m of floor (src/enemies/Fall.js), so bodies do not fall
 * through real walls or sofas.
 *
 * Per frame: the brain (10 Hz decisions, staggered; movement and shot timing
 * every frame), shots (muzzle → player capsule, world.segmentClear), then the
 * procedural pose: full rate for enemies within 8 m and in view, otherwise
 * 20 Hz round-robin (the root still moves every frame). Hit capsules follow
 * the rendered pose. Bodies stay 6 s, then go back to the pool.
 *
 * Events out: `enemyShot` { enemy, x, y, z } (AudioEngine plays the shot),
 * `playerHit` { damage (torso 12, head 25 in 'test'; 25 / 50 'realistic'), fromX, fromY, fromZ },
 * `enemyKilled` { enemy, headshot }. Sounds played here: footsteps ('step'),
 * grunts on a hit, the body fall ('fall'), magazine changes, rounds striking
 * near the player ('impactWall').
 *
 * Allocation-free per frame after construction.
 */

import { Animator, ANIM } from './Animator.js';
import { AI, Brain, DIFFICULTY, ST, difficultyFromSearch, resolveDifficulty } from './Brain.js';
import { EnemyPool } from './EnemyPool.js';
import { FALL, FALL_FULL, chooseFall } from './Fall.js';
import { HitPuff } from './HitPuff.js';
import { CapsuleSet, Hitbox, PARTS, PART_HEAD, PART_NECK, rayCapsule, raySphere } from './Hitbox.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { B } from './Rig.js';
import { V3 } from './math.js';

export const ENEMY = Object.freeze({
  health: 100, // CONTRACTS: damage values are against 100 hp (damage TO the player: DIFFICULTY)
  lodNear: 8, // m: full-rate pose within this and in view
  lodHz: 20,
  viewCos: Math.cos(1.0), // ±57°: wider than the Quest's view, so nobody pops at the edge
  missSoundR: 2.5, // m: a miss striking this close to the player is heard
  range: 60,
});

/** @typedef {{ dist: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: string, surface: string, enemy: number, part: string }} Hit */

/** Spawn tiers as recorded (Spawner.js): 0 placed directly, 1 visible behind, 2 hidden in the room, 3 behind a door, 4 in view (last resort). */
const TIER_KEYS = Object.freeze(['spawnDirect', 'spawnBehind', 'spawnHiddenRoom', 'spawnHiddenDoor', 'spawnInView']);

/**
 * The page's `?difficulty=` (read once, at load; never in a pure module).
 * @returns {'test'|'realistic'}
 */
function urlDifficulty() {
  try {
    const loc = /** @type {any} */ (globalThis).location;
    return difficultyFromSearch(loc && typeof loc.search === 'string' ? loc.search : '');
  } catch { return difficultyFromSearch(''); }
}

export class EnemyManager {
  /**
   * @param {any} assets Assets after load (assets.models.soldier)
   * @param {import('three').Scene} scene
   * @param {number} [maxEnemies]
   * @param {{ world?: any, planner?: any, light?: import('three').PointLight|null, seed?: number,
   *   difficulty?: string|import('./Brain.js').Difficulty }} [opts] difficulty: 'test' | 'realistic' (default: the URL's, else 'test')
   */
  constructor(assets, scene, maxEnemies = 6, opts = {}) {
    const model = assets.models.soldier;
    if (!model) throw new Error('EnemyManager: assets.models.soldier missing (load assets first)');
    this.max = maxEnemies;
    this.pool = new EnemyPool(model, maxEnemies);
    this.def = this.pool.def;
    const seed = opts.seed ?? 0x51d;
    this.anims = this.pool.rigs.map((_, i) => new Animator(this.def, seed + i * 7919));
    this.capsules = new CapsuleSet(this.def);
    this.hitboxes = this.pool.rigs.map(() => new Hitbox(this.capsules));
    this.brain = new Brain({ maxEnemies, seed });
    this.flash = new MuzzleFlash(scene, maxEnemies);
    this.flash.setLight(opts.light);
    this.puff = new HitPuff(scene, maxEnemies * 3);
    for (const r of this.pool.rigs) scene.add(r.root);
    this.scene = scene;
    /** @type {any} */ this.world = null;
    /** @type {any} */ this.planner = opts.planner || null;
    if (opts.world) this.attachWorld(opts.world, opts.planner);

    // per enemy
    const n = maxEnemies;
    this.health = new Float32Array(n);
    this.lodAcc = new Float32Array(n);
    this.near = new Uint8Array(n);
    this.gruntT = new Float32Array(n);
    this.spawnOrder = new Float64Array(n);
    this.legHit = new Uint8Array(n);
    /** Spawn tier per enemy (see TIER_KEYS). */
    this.tier = new Uint8Array(n);
    this.order = 0;

    // events
    /** @type {any} */ this.events = null;
    /** @type {(() => void)[]} */ this._unsub = [];
    this.paused = false;
    this._onShot = this._onShot.bind(this);
    this._onEnemyHit = this._onEnemyHit.bind(this);
    this._onPause = this._onPause.bind(this);
    this._pShot = { enemy: -1, x: 0, y: 0, z: 0 };
    this._pPlayerHit = { damage: 0, fromX: 0, fromY: 0, fromZ: 0 };
    this._pKilled = { enemy: -1, headshot: false };

    // last raycast hit (applyHit has no hit point)
    this.lastEnemy = -1; this.lastCapsule = -1; this.lastX = 0; this.lastY = 0; this.lastZ = 0;
    /** @type {any} */ this.audio = null;
    // scratch
    this._mp = new V3(); this._md = new V3(); this._v = new V3();
    this._dir = new Float64Array(3);
    this._fall = new Float64Array(3);
    /** @type {Hit} */
    this._hit = { dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, kind: 'none', surface: '', enemy: -1, part: '' };
    this.stats = {
      spawned: 0, killed: 0, shots: 0, hitsOnPlayer: 0, poses: 0, fullPoses: 0,
      /** Difficulty in use ('test' | 'realistic'). */
      difficulty: 'test',
      /** Spawns by tier (Spawner.js), and the last one's. */
      spawnDirect: 0, spawnBehind: 0, spawnHiddenRoom: 0, spawnHiddenDoor: 0, spawnInView: 0, lastSpawnTier: 0,
      /** Hits shown with a puff; deaths that fell away from the shot line (blocked), and those with no clear 1.2 m at all. */
      puffs: 0, fallsTurned: 0, fallsCramped: 0,
    };
    // Path planner timing for the session record (read when the stats are copied).
    Object.defineProperty(this.stats, 'pathTimeouts', { enumerable: true, get: () => (this.planner && this.planner.stats ? this.planner.stats.timeouts | 0 : 0) });
    Object.defineProperty(this.stats, 'pathMaxStepMs', {
      enumerable: true, get: () => (this.planner && this.planner.stats ? Math.round((this.planner.stats.maxStepMs || 0) * 1000) / 1000 : 0),
    });
    /** @type {Readonly<import('./Brain.js').Difficulty>} */
    this.diff = DIFFICULTY.test;
    this.setDifficulty(opts.difficulty !== undefined && opts.difficulty !== null ? opts.difficulty : urlDifficulty());
    this.warm = false;
  }

  /**
   * Enemy difficulty: 'test' (default for the first headset tests) or
   * 'realistic' (PLAN §9's values). Takes effect at once (the next decision,
   * shot and hit on the player).
   * @param {string|import('./Brain.js').Difficulty|null|undefined} d
   * @returns {string} the name now in use
   */
  setDifficulty(d) {
    this.diff = this.brain.setDifficulty(resolveDifficulty(d));
    this.stats.difficulty = this.diff.name;
    return this.diff.name;
  }

  /**
   * The world to walk and see in (any object with nav, segmentClear, floorY,
   * raycast, createPlanner). Call at load: the path planner's buffers are
   * allocated here.
   * @param {any} world @param {any} [planner]
   */
  attachWorld(world, planner) {
    this.world = world;
    this.planner = planner || this.planner || (world && typeof world.createPlanner === 'function' ? world.createPlanner({ maxRequests: Math.max(16, this.max) }) : null);
    this.brain.attach(world, this.planner);
  }

  /**
   * Subscribe to the event bus. `hits`: apply 'enemyHit' damage here (do not
   * also call applyHit for the same events); `hearing`: player shots alert.
   * @param {any} events @param {{ hits?: boolean, hearing?: boolean }} [o]
   */
  bind(events, { hits = true, hearing = true } = {}) {
    this.unbind();
    this.events = events;
    if (hearing) this._unsub.push(events.on('shot', this._onShot));
    if (hits) this._unsub.push(events.on('enemyHit', this._onEnemyHit));
    this._unsub.push(events.on('pause', this._onPause));
  }

  unbind() {
    for (const u of this._unsub) u();
    this._unsub.length = 0;
  }

  /** @param {{ x: number, y: number, z: number, dx: number, dy: number, dz: number }} p */
  _onShot(p) {
    const l = Math.hypot(p.dx, p.dy, p.dz) || 1;
    this.brain.hearShot(p.x, p.y, p.z, p.dx / l, p.dy / l, p.dz / l);
  }

  /** @param {{ enemy: number, part: string, damage: number, dx: number, dy: number, dz: number }} p */
  _onEnemyHit(p) { this.applyHit(p.enemy, p.part, p.damage, p.dx, p.dy, p.dz); }

  /** @param {{ paused: boolean }} p */
  _onPause(p) { this.paused = !!p.paused; }

  // ─────────────────────────────────────────────────────────── contract API

  /**
   * Place a soldier at (x, z) facing `facing` (yaw about +Y, 0 = +Z).
   * `tier`: the spawn tier (Spawner.js); omitted, it is the world spawner's
   * last find when (x, z) is that point, else 0 (placed directly).
   * @param {number} x @param {number} z @param {number} facing @param {number} [tier]
   * @returns {number} enemy index, or −1 when the pool is full
   */
  spawn(x, z, facing, tier = -1) {
    let i = -1;
    for (let k = 0; k < this.max; k++) if (!this.brain.agents[k].active) { i = k; break; }
    if (i < 0) {
      // all slots used: recycle the oldest body still lying there
      let oldest = Infinity;
      for (let k = 0; k < this.max; k++) {
        const a = this.brain.agents[k];
        if (!a.alive && this.spawnOrder[k] < oldest) { oldest = this.spawnOrder[k]; i = k; }
      }
      if (i < 0) return -1;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return -1;
    let tr = tier;
    if (!(tr >= 0 && tr < TIER_KEYS.length)) {
      const sp = this.world && this.world.spawner;
      tr = sp && sp.lastTier > 0 && sp.lastX === x && sp.lastZ === z ? sp.lastTier | 0 : 0;
      if (!(tr >= 0 && tr < TIER_KEYS.length)) tr = 0;
    }
    this.tier[i] = tr;
    /** @type {any} */ (this.stats)[TIER_KEYS[tr]]++;
    this.stats.lastSpawnTier = tr;
    this.brain.spawn(i, x, z, Number.isFinite(facing) ? facing : 0);
    const a = this.brain.agents[i];
    this.health[i] = ENEMY.health;
    this.legHit[i] = 0;
    this.gruntT[i] = 0;
    this.spawnOrder[i] = ++this.order;
    this.lodAcc[i] = (i / this.max) / ENEMY.lodHz;
    const an = this.anims[i];
    an.reset(a.x, a.y, a.z, a.yaw);
    const rig = this.pool.rigs[i];
    rig.apply(an);
    rig.setRoot(a.x, a.y, a.z, a.yaw);
    rig.root.visible = true;
    this.hitboxes[i].update(an);
    this.stats.spawned++;
    return i;
  }

  /**
   * @param {number} dt seconds @param {number} t ms @param {any} frame
   * @param {any} ctx { world, player, events, audio, gfx, … }
   */
  update(dt, t, frame, ctx) {
    if (ctx) {
      if (ctx.events && ctx.events !== this.events) this.bind(ctx.events);
      if (ctx.world && ctx.world !== this.world) this.attachWorld(ctx.world);
      this.audio = ctx.audio || null;
      if (ctx.gfx && ctx.gfx.flashLights && !this.flash.light) this.flash.setLight(ctx.gfx.flashLights[1]);
    }
    if (this.warm) return;
    const player = ctx && ctx.player;
    if (player && player.head) { const E = this.puff.eye, h = player.head; E[0] = h.x; E[1] = h.y; E[2] = h.z; } // the puffs face the eye
    if (this.paused || !(dt > 0)) { this.flash.update(0); this.puff.update(0); return; }
    if (player) this.brain.update(dt, player);
    const ag = this.brain.agents;
    // shots
    if (player) for (let i = 0; i < this.max; i++) if (ag[i].fire) this.fireShot(i, player);
    // poses
    const ph = player ? player.head : null, pf = player ? player.forward : null;
    for (let i = 0; i < this.max; i++) {
      const a = ag[i];
      if (!a.active) continue;
      const an = this.anims[i], rig = this.pool.rigs[i];
      if (a.alive) {
        an.rootX = a.x; an.rootY = a.y; an.rootZ = a.z; an.rootYaw = a.yaw;
        an.vx = a.vx; an.vz = a.vz;
        an.aimX = a.aimX; an.aimY = a.aimY; an.aimZ = a.aimZ;
        an.raiseTarget = a.raise;
        if (a.reloadStart) this.sound('akMagOut', i, 1.0, 0.8);
        if (a.reloadT > 0 && a.reloadT < 0.9 && a.reloadT + dt >= 0.9) this.sound('akMagIn', i, 1.0, 0.8);
        if (a.flinchT > 0) an.raiseTarget = 0.6;
      }
      // level of detail
      let full = false;
      if (ph) {
        const dx = a.x - ph.x, dz = a.z - ph.z, d = Math.hypot(dx, dz);
        full = d < ENEMY.lodNear && (!pf || d < 1.5 || (dx * pf.x + (a.y + 1 - ph.y) * pf.y + dz * pf.z) > ENEMY.viewCos * Math.hypot(dx, a.y + 1 - ph.y, dz));
      }
      this.near[i] = full ? 1 : 0;
      this.lodAcc[i] += dt;
      if (full || this.lodAcc[i] >= 1 / ENEMY.lodHz || an.dead && !an.settled && this.lodAcc[i] >= 1 / 45) {
        an.update(this.lodAcc[i]);
        this.lodAcc[i] = 0;
        rig.apply(an);
        this.stats.poses++;
        if (full) this.stats.fullPoses++;
        if (an.stepEvents) this.footsteps(i, an);
        if (an.landEvent) this.sound('fall', i, 1, 0.3);
      }
      rig.setRoot(an.rootX, an.rootY, an.rootZ, an.rootYaw);
      this.hitboxes[i].update(an);
      // bodies go back to the pool
      if (!a.alive && a.deadT >= ANIM.holdS) {
        a.active = false;
        a.state = ST.IDLE;
        rig.root.visible = false;
        this.hitboxes[i].valid = false;
      }
    }
    this.flash.update(dt);
    this.puff.update(dt);
  }

  /**
   * Nearest enemy hit (living or a body still on the floor). Writes `out` only
   * on a hit: kind 'enemy', surface 'flesh', enemy index, part.
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {number} max
   * @param {Hit} out
   * @param {number} [ignoreEnemy]
   */
  raycast(ox, oy, oz, dx, dy, dz, max, out, ignoreEnemy = -1) {
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 1e-9) || !(max > 0)) return false;
    dx /= l; dy /= l; dz /= l;
    let best = max, bi = -1, bc = -1;
    for (let i = 0; i < this.max; i++) {
      if (i === ignoreEnemy || !this.brain.agents[i].active) continue;
      const h = this.hitboxes[i];
      const t = h.raycast(ox, oy, oz, dx, dy, dz, best);
      if (t >= 0 && t < best) { best = t; bi = i; bc = h.hitIndex; }
    }
    if (bi < 0) return false;
    const h = this.hitboxes[bi]; // holds the normal of its own (winning) test
    out.dist = best;
    out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best;
    out.nx = h.nx; out.ny = h.ny; out.nz = h.nz;
    out.kind = 'enemy';
    out.surface = 'flesh';
    out.enemy = bi;
    out.part = PARTS[this.capsules.part[bc]];
    this.lastEnemy = bi; this.lastCapsule = bc;
    this.lastX = out.x; this.lastY = out.y; this.lastZ = out.z;
    return true;
  }

  /**
   * Damage from the player. Head and neck hits kill; otherwise health
   * (100) runs down, with a flinch. (dirX, dirY, dirZ) = bullet travel.
   * Every hit (a body on the floor too) shows a puff where the round struck.
   * @param {number} enemy @param {string} part @param {number} damage
   * @param {number} dirX @param {number} dirY @param {number} dirZ
   */
  applyHit(enemy, part, damage, dirX, dirY, dirZ) {
    if (!(enemy >= 0 && enemy < this.max)) return;
    const a = this.brain.agents[enemy];
    if (!a.active) return;
    const an = this.anims[enemy];
    const fromRay = this.lastEnemy === enemy;
    const hx = fromRay ? this.lastX : a.x, hy = fromRay ? this.lastY : a.y + 1.3, hz = fromRay ? this.lastZ : a.z;
    // without the ray's hit point the puff starts at his centre line: further out, so the body does not hide it
    this.puff.spawn(hx, hy, hz, dirX, dirY, dirZ, fromRay ? 0.06 : 0.25);
    this.stats.puffs++;
    if (!a.alive) { this.lastEnemy = -1; return; }
    const dmg = Number.isFinite(damage) && damage > 0 ? damage : 0;
    this.health[enemy] -= dmg;
    const k = dmg / 40;
    if (fromRay && this.hitboxes[enemy].isLeg(this.lastCapsule)) this.legHit[enemy] = 1;
    this.lastEnemy = -1;
    if (part === PARTS[PART_HEAD] || part === PARTS[PART_NECK] || this.health[enemy] <= 0) {
      this.brain.kill(enemy);
      an.hit(dirX, dirY, dirZ, hx, hy, hz, part, k);
      if (this.world && this.world.nav) {
        // the clearest way down: never into a real wall or sofa (the scatter is part of the choice)
        const F = this._fall;
        const c = chooseFall(this.world, a.x, a.z, dirX, dirZ, (an.rng.next() - 0.5) * FALL.scatter, F);
        if (c >= 2) this.stats.fallsTurned++;
        if (F[2] < FALL_FULL) this.stats.fallsCramped++;
        an.die(F[0], F[1], part === 'head', 0);
      } else an.die(dirX, dirZ, part === 'head');
      this.stats.killed++;
      if (part !== 'head' && part !== 'neck') this.sound('grunt', enemy, 0.9, 1.5);
      if (this.events) {
        this._pKilled.enemy = enemy;
        this._pKilled.headshot = part === 'head';
        this.events.emit('enemyKilled', this._pKilled);
      }
      return;
    }
    an.hit(dirX, dirY, dirZ, hx, hy, hz, part, k);
    this.brain.hit(enemy, k);
    if (this.legHit[enemy]) a.speedK = 0.6;
    if (this.gruntT[enemy] <= this.brain.time) { this.sound('grunt', enemy, 0.85, 1.5); this.gruntT[enemy] = this.brain.time + 0.8; }
  }

  /** Living enemies (bodies on the floor do not count). */
  alive() { return this.brain.living(); }

  /** Everyone back to the pool (restart). */
  reset() {
    this.brain.reset();
    for (let i = 0; i < this.max; i++) {
      this.pool.rigs[i].root.visible = false;
      this.hitboxes[i].valid = false;
    }
    this.flash.clear();
    this.puff.clear();
    this.lastEnemy = -1;
  }

  /** Every object the warm-up must draw (all instances, rifles, the flash and hit-puff pools). */
  warmMeshes() {
    /** @type {import('three').Object3D[]} */
    const list = [];
    for (const r of this.pool.rigs) list.push(r.root);
    list.push(this.flash.mesh, this.puff.mesh);
    return list;
  }

  /** Textures to upload at warm-up (the generated flash and puff; the soldier's come from Assets). */
  textures() { return [this.flash.texture, this.puff.texture]; }

  /**
   * Warm-up: show every instance standing in a row round (x, y, z), not
   * frustum-culled, plus one flash, so one draw compiles the programs, uploads
   * the buffers and builds each skeleton's bone texture. setWarm(false)
   * restores culling and hides whoever is not in play.
   * @param {boolean} on @param {number} [x] @param {number} [y] @param {number} [z]
   */
  setWarm(on, x = 0, y = 0, z = -3) {
    this.warm = on;
    for (let i = 0; i < this.max; i++) {
      const r = this.pool.rigs[i], an = this.anims[i];
      r.mesh.frustumCulled = !on;
      r.rifle.frustumCulled = !on;
      if (on) {
        an.reset(x + (i - (this.max - 1) / 2), y, z, Math.PI);
        r.apply(an);
        r.setRoot(an.rootX, an.rootY, an.rootZ, an.rootYaw);
        r.root.visible = true;
      } else r.root.visible = this.brain.agents[i].active;
    }
    this.flash.setWarm(on);
    this.puff.setWarm(on, x, y + 1.3, z);
  }

  // ─────────────────────────────────────────────────────────── internals

  /**
   * Enemy i fires one round: from his muzzle toward the player's chest within
   * his current aim error; the player's head sphere and torso capsule are the
   * targets, and the world must be clear up to the hit.
   * @param {number} i @param {any} player
   */
  fireShot(i, player) {
    const a = this.brain.agents[i], an = this.anims[i];
    const mp = this._mp, md = this._md;
    an.muzzle(mp, md);
    let dx = a.aimX - mp.x, dy = a.aimY - mp.y, dz = a.aimZ - mp.z;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const d = this._dir;
    this.brain.scatter(dx, dy, dz, a.aimErr, d);
    dx = d[0]; dy = d[1]; dz = d[2];
    this.stats.shots++;
    an.recoil();
    // the player
    let best = Infinity, dmg = 0;
    if (player.alive !== false) {
      const h = player.head, hr = player.headRadius || 0.11;
      const th = raySphere(mp.x, mp.y, mp.z, dx, dy, dz, h.x, h.y, h.z, hr);
      if (th > 0 && th < best) { best = th; dmg = this.diff.playerHead; }
      const tb = player.torsoBottom, tt = player.torsoTop, tr = player.torsoRadius || 0.17;
      const tc = rayCapsule(mp.x, mp.y, mp.z, dx, dy, dz, tb.x, tb.y, tb.z, tt.x, tt.y, tt.z, tr);
      if (tc >= 0 && tc < best) { best = tc; dmg = this.diff.playerTorso; }
    }
    const w = this.world;
    if (dmg > 0 && w && typeof w.segmentClear === 'function' && !w.segmentClear(mp.x, mp.y, mp.z, mp.x + dx * best, mp.y + dy * best, mp.z + dz * best)) dmg = 0;
    if (dmg > 0) {
      this.stats.hitsOnPlayer++;
      if (this.events) {
        const p = this._pPlayerHit;
        p.damage = dmg; p.fromX = mp.x; p.fromY = mp.y; p.fromZ = mp.z;
        this.events.emit('playerHit', p);
      }
    } else if (w && typeof w.raycast === 'function' && player.head) {
      // a miss: heard where it strikes if that is close to the player
      const hit = this._hit;
      if (w.raycast(mp.x, mp.y, mp.z, dx, dy, dz, ENEMY.range, hit)) {
        const h = player.head, ex = hit.x - h.x, ey = hit.y - h.y, ez = hit.z - h.z;
        if (ex * ex + ey * ey + ez * ez < ENEMY.missSoundR * ENEMY.missSoundR && this.audio) this.audio.play('impactWall', hit.x, hit.y, hit.z, 0.8);
      }
    }
    if (this.events) {
      const p = this._pShot;
      p.enemy = i; p.x = mp.x; p.y = mp.y; p.z = mp.z;
      this.events.emit('enemyShot', p);
    }
    const ph = player.head;
    const dist = ph ? Math.hypot(mp.x - ph.x, mp.y - ph.y, mp.z - ph.z) : 0;
    this.flash.fire(i, mp.x, mp.y, mp.z, md.x, md.y, md.z, dist);
  }

  /** @param {number} i @param {Animator} an */
  footsteps(i, an) {
    if (!this.audio) return;
    for (let f = 0; f < 2; f++) {
      if (!(an.stepEvents & (1 << f))) continue;
      const ft = an.feet[f];
      this.audio.play('step', ft.px, an.rootY + 0.02, ft.pz, an.stepGain);
    }
  }

  /**
   * A sound at enemy i (chest height).
   * @param {string} key @param {number} i @param {number} gain @param {number} y above his floor
   */
  sound(key, i, gain, y) {
    if (!this.audio) return;
    const a = this.brain.agents[i], an = this.anims[i];
    const p = an.mp[B.pelvis];
    const v = this._v.copy(p);
    an.toWorld(v, v);
    this.audio.play(key, v.x, a.y + y, v.z, gain);
  }
}

export { AI, ANIM };
