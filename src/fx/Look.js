// @ts-check
/**
 * The `look` system (v0.4): what makes virtual objects pass for real in the
 * Quest passthrough, cheaply, at 72 Hz. research-look.md, ranked by realism
 * per cost:
 *
 * 1. Room light (RoomLight.js): the fixed lights, the environment intensity
 *    and rotation, the black lift / grain and the unlit effects' light follow
 *    the room the player is in (auto by time of day and windows, manual per
 *    room from the watch, or the opt-in camera). Intensities and colours only.
 * 2. Grounding (GroundShadows.js): one instanced pool of soft contact shadows
 *    under dropped guns and magazines (on the real bed, table, floor: the
 *    world raycast), enemies' feet and bodies, and a gun held near a surface.
 * 3. Colour (PassthroughMatch.js + Renderer.js): PBR Neutral tone mapping and
 *    exposure chosen before any compile; one hook on every opaque lit
 *    material for saturation, black lift and grain; contact darkening on the
 *    soldiers; per-material roughness / envMapIntensity.
 * 4. Impacts (Impacts.js): decals from a procedural atlas per real material
 *    (plaster, wood, fabric, metal / glass) from the Space Setup labels, a
 *    pooled puff (dust, chips, splinters, foam, feathers, glints) lit by the
 *    room light, and the matching sounds from the existing bank. The enemies'
 *    hit puffs take the room light too, and their muzzle flashes read faint by
 *    day and vivid at night (material colour / opacity: uniforms).
 *
 * Integration (PlayKit; the integrator owns those files):
 *   at load, after every system is built and BEFORE the warm-up:
 *     const atlas = await loadDecalAtlas();                 // a worker; falls back to the main thread
 *     look = new Look({ scene, hemi: gfx.hemi, sun: gfx.sun, storage, atlas });
 *     look.prepareMaterials([scene, ...assetWarmObjects(assets)]);   // hooks + tuning (before DepthOcclusion)
 *     look.attach({ world, enemies, weapons, physics: weapons.phys, audio });
 *     look.warmUp();                                         // JIT warm-up of the shot and frame code (tens of ms)
 *     warm objects += look.warmMeshes(); setWarm(on) → look.setWarm(on)
 *   after each world build (behind the panel): look.onWorldBuilt(world, snapshot); after a realign:
 *     look.onWorldBuilt(world, snapshot, { moved: true }) (clears the decals), then look.snap()
 *   every frame, after `enemies` (poses current) and before `render`: look.update(dt, t, frame, ctx)
 *   WeaponSystem's world-hit branch: look.impact(H, dirX, dirY, dirZ, w.id) instead of
 *     fx.decal(...) + the 'impactWall' sound
 *   restart / session end: look.reset(); rec.play.look = look.report()
 *   watch rows (optional): look.light.cycleLevel() / cycleWarmth() / setFloor(kind)
 *   page toggle (a tap of its own): look.light.requestCamera() / stopCamera(); CAMERA_NOTE is its text
 */

import { GroundShadows } from './GroundShadows.js';
import { Impacts, uRoomLight } from './Impacts.js';
import { RoomLight, CAMERA_NOTE } from './RoomLight.js';
import { matchMaterials, tuneMaterials, uPtm, MATCH } from './PassthroughMatch.js';
import { makeDecalAtlas } from './decalAtlas.js';

export { CAMERA_NOTE };

/**
 * URL A/B switches, read once at load: `?sat=<0.5..1.2>` (saturation),
 * `?shadows=0`, `?impacts=0` (the v0.3 WeaponFX decal stays), `?match=0` (no
 * material hook: compiled programs differ, so it is a load-time choice).
 * @param {string} search location.search
 */
export function lookFromSearch(search) {
  const out = { saturation: MATCH.saturation, shadows: true, impacts: true, match: true };
  try {
    const p = new URLSearchParams(search || '');
    const s = p.has('sat') ? Number(p.get('sat')) : NaN;
    if (Number.isFinite(s)) out.saturation = Math.max(0.5, Math.min(1.2, s));
    if (p.get('shadows') === '0') out.shadows = false;
    if (p.get('impacts') === '0') out.impacts = false;
    if (p.get('match') === '0') out.match = false;
  } catch { /* defaults */ }
  return out;
}

/**
 * The decal atlas, drawn in a module worker (falls back to the main thread:
 * Node, or a browser without module workers). Await it at load.
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
 */
export function loadDecalAtlas() {
  if (typeof Worker === 'undefined') return Promise.resolve(makeDecalAtlas());
  return new Promise((resolve) => {
    /** @type {Worker|null} */ let w = null;
    const fallback = () => { if (w) w.terminate(); resolve(makeDecalAtlas()); };
    try {
      w = new Worker(new URL('./atlas.worker.js', import.meta.url), { type: 'module' });
      const timer = setTimeout(fallback, 5000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        const d = e.data;
        if (w) w.terminate();
        if (d && d.data instanceof Uint8Array && d.width > 0) resolve({ width: d.width, height: d.height, data: d.data });
        else resolve(makeDecalAtlas());
      };
      w.onerror = () => { clearTimeout(timer); fallback(); };
      w.postMessage(1);
    } catch { fallback(); }
  });
}

export class Look {
  /**
   * @param {{ scene: import('three').Scene, hemi: import('three').HemisphereLight, sun: import('three').DirectionalLight,
   *   storage?: Storage|null, atlas?: { width: number, height: number, data: Uint8Array } | null, search?: string, hour?: number }} o
   */
  constructor(o) {
    this.opts = lookFromSearch(o.search ?? (typeof location !== 'undefined' ? location.search : ''));
    uPtm.value.z = this.opts.saturation;
    this.shadows = new GroundShadows(o.scene);
    this.shadows.enabled = this.opts.shadows;
    this.impacts = new Impacts(o.scene, { atlas: o.atlas || null });
    this.light = new RoomLight({ scene: o.scene, hemi: o.hemi, sun: o.sun, storage: o.storage || null, saturation: this.opts.saturation, hour: o.hour });
    /** @type {{ matched: number, skipped: number, names: string[] } | null} */ this.matchReport = null;
    this.tuned = 0;
    this.warm = false;
    this.warmMs = 0;
    /** @type {any} enemy hit-puff material (MeshBasic: its colour is lit by the room) */ this.puffMat = null;
    /** @type {any} enemy muzzle-flash material (its opacity follows the room level: vivid in the dark, faint by day) */ this.flashMat = null;
  }

  /**
   * At load (after attach, before Enter): run the per-frame and per-shot code
   * enough for the JIT to optimise it, then clear every pool. Tens of ms.
   */
  warmUp() {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.shadows.warmUp();
    this.impacts.warmUp();
    this.warmMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return this.warmMs;
  }

  /** Impacts are drawn here (false: `?impacts=0`, the caller keeps WeaponFX's own decal). */
  get impactsOn() { return this.opts.impacts; }

  /**
   * At load, BEFORE the warm-up (and before DepthOcclusion, which must be the last hook):
   * per-material tuning, then the passthrough-match hook on every opaque lit material.
   * @param {readonly (import('three').Object3D|null|undefined)[]} roots
   */
  prepareMaterials(roots) {
    this.tuned = tuneMaterials(roots);
    this.matchReport = this.opts.match ? matchMaterials(roots) : { matched: 0, skipped: 0, names: [] };
    return { tuned: this.tuned, matched: this.matchReport.matched };
  }

  /**
   * The casters and services (any may be null).
   * @param {{ world?: any, physics?: any, enemies?: any, weapons?: any, audio?: any }} s
   */
  attach(s) {
    if (s.world) { this.shadows.setWorld(s.world); this.impacts.world = s.world; }
    if (s.physics !== undefined) this.shadows.setPhysics(s.physics);
    if (s.enemies) {
      this.shadows.setEnemies(s.enemies);
      // the enemies' unlit effects follow the room light (uniforms only: their colour and opacity)
      this.puffMat = s.enemies.puff && s.enemies.puff.material ? s.enemies.puff.material : null;
      this.flashMat = s.enemies.flash && s.enemies.flash.material ? s.enemies.flash.material : null;
    }
    if (s.weapons) this.shadows.setWeapons(s.weapons);
    if (s.audio) this.impacts.audio = s.audio;
  }

  /**
   * After a world build or realign (behind the panel): rooms, windows, saved presets,
   * the floor material; frozen item shadows recomputed. `moved` (a realign: the
   * world's coordinates changed): the decals are cleared too, or they would float.
   * @param {any} world @param {any} [snapshot] @param {{ moved?: boolean }} [opts]
   */
  onWorldBuilt(world, snapshot = null, opts = {}) {
    this.light.setHouse(world, snapshot);
    this.impacts.floorKind = this.light.floor;
    this.shadows.setWorld(world);
    if (opts && opts.moved) this.impacts.clear();
  }

  /**
   * A round struck the world (WeaponSystem's world-hit branch).
   * @param {{ x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string }} hit
   * @param {number} dx @param {number} dy @param {number} dz @param {string} [weapon]
   */
  impact(hit, dx, dy, dz, weapon) {
    return this.opts.impacts ? this.impacts.impact(hit, dx, dy, dz, weapon) : -1;
  }

  /** Floor material of this house ('wood' | 'carpet' | 'tile'), saved per house. @param {string} kind */
  setFloor(kind) {
    const k = this.light.setFloor(kind);
    this.impacts.floorKind = k;
    return k;
  }

  /**
   * @param {number} dt @param {number} t @param {any} frame @param {any} ctx
   */
  update(dt, t, frame, ctx) {
    if (this.warm) return;
    this.light.update(dt, t, frame, ctx);
    const K = this.light.keyDir, L = this.shadows.light;
    L[0] = K[0]; L[1] = K[1]; L[2] = K[2];
    const R = uRoomLight.value;
    if (this.puffMat) {
      // linear working space: the sRGB room multiplier squared is close enough (and allocation-free)
      const c = this.puffMat.color;
      c.r = R.x * R.x; c.g = R.y * R.y; c.b = R.z * R.z;
    }
    if (this.flashMat) {
      // research R12: a flash reads faint in daylight, vivid at night
      const e = this.light.smoother.primed ? this.light.smoother.value[0] : 1;
      const k = 0.72 / (e > 0.3 ? e : 0.3);
      this.flashMat.opacity = k < 0.45 ? 0.45 : k > 1 ? 1 : k;
    }
    this.shadows.update(dt, t, frame, ctx);
    this.impacts.update(dt, t, frame, ctx);
  }

  /** Behind the "Get ready" panel: the lights jump to the room instead of easing. */
  snap() { this.light.snap(); }

  /** A restart or session end: decals and particles cleared, shadows hidden. */
  reset() {
    this.impacts.clear();
    this.shadows.clear();
  }

  /** Every object the warm-up must draw. */
  warmMeshes() { return [this.shadows.mesh, this.impacts.decals, this.impacts.parts]; }

  /** Textures the warm-up uploads (the decal atlas). */
  textures() { return this.impacts.textures(); }

  /**
   * Show one instance of every pool for the warm-up draw (or clear them after).
   * @param {boolean} on @param {number} [x] @param {number} [y] @param {number} [z]
   */
  setWarm(on, x = 0, y = 0, z = -2) {
    this.warm = on;
    this.shadows.setWarm(on, x, y, z);
    this.impacts.setWarm(on, x, y + 1.4, z);
  }

  /** JSON-safe summary for the session record (`rec.play.look`). */
  report() {
    return {
      opts: this.opts, tuned: this.tuned, matched: this.matchReport ? this.matchReport.matched : 0, warmMs: Math.round(this.warmMs * 10) / 10,
      light: this.light.report(), shadows: this.shadows.report(), impacts: this.impacts.report(),
    };
  }
}
