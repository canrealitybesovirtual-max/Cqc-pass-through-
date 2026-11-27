// @ts-check
import { VoicePool } from './VoicePool.js';
import { headPose, quatForward, quatUp } from '../game/head.js';

/**
 * Web Audio engine (CONTRACTS.md "Game, audio, HUD"). No three.js import.
 *
 * Lifecycle:
 *   const audio = new AudioEngine();
 *   await audio.decodeAll(assets.sounds);   // before Enter: every clip decoded
 *   audio.unlock();                          // synchronously inside the Enter click
 *   audio.bind(events);                      // enemyShot / enemyHit sounds
 *   // each frame, as the `audio` system: audio.update(dt, t, frame, ctx)
 *   audio.play('glockShot', x, y, z);        // → voice id or −1
 *
 * Graph (built once, at the first decodeAll() or unlock(), on the same context):
 *   voice: source → gain → lowpass (air + occlusion) → panner → sfx bus ─┐
 *                                      └→ send → room reverb ──→ sfx bus ┤→ compressor → master → out
 *   UI voice: source → gain → ui bus ────────────────────────────────────────────────→ master
 * 24 voices: 8 HRTF panners, 14 equal-power, 2 head-locked UI voices. The HRTF
 * panners exist from the first decode, well before Enter, so Chrome has loaded
 * its HRTF database before the first sound (PLAN §10 "Audio").
 *
 * Per play the only allocation is the AudioBufferSourceNode the browser
 * requires. No decode and no `.buffer` assignment on a convolver ever happen
 * after load. Realism:
 * - distance: inverse law per sound (enemy shots ref 2.5 m, rolloff 0.85, CQC);
 * - air absorption: lowpass 20 kHz × e^(−d / 55 m) (CQC);
 * - occlusion: when the world blocks the line from the head, lowpass 1.1 kHz
 *   and −6 dB (fewer highs through drywall);
 * - speed of sound: the start is delayed by d / 343 m/s;
 * - a synthesized furnished-room response (RT60 0.45 s) on a per-sound send,
 *   without distance attenuation, so far sounds get relatively more room;
 * - a variant is never repeated twice running; rate jitter per sound.
 * Levels are first estimates, not yet checked by ear on the headset.
 */

/**
 * @typedef {{ pri: number, gain: number, ref: number, roll: number, wet: number, jit: number, hrtf: boolean }} SoundCfg
 * pri: steal priority; gain: level at ≤ ref; ref/roll: inverse distance model; wet: reverb send;
 * jit: ± playback-rate jitter; hrtf: prefer an HRTF voice (sounds you must locate).
 */

/** @type {SoundCfg} */
export const SOUND_DEFAULT = Object.freeze({ pri: 2, gain: 0.7, ref: 1, roll: 1, wet: 0.1, jit: 0.04, hrtf: true });

/** @param {number} pri @param {number} gain @param {number} ref @param {number} roll @param {number} wet @param {number} jit @param {boolean} hrtf */
const S = (pri, gain, ref, roll, wet, jit, hrtf) => Object.freeze({ pri, gain, ref, roll, wet, jit, hrtf });

/** @type {Readonly<Record<string, SoundCfg>>} */
export const SOUNDS = Object.freeze({
  // your own gun, at the gun: equal-power is enough, keep HRTF for enemies
  glockShot: S(5, 1.0, 1.5, 1, 0.3, 0.03, false),
  akShot: S(5, 1.0, 1.5, 1, 0.32, 0.03, false),
  dry: S(4, 0.7, 0.5, 1, 0.04, 0.04, false),
  dryReset: S(4, 0.45, 0.5, 1, 0.03, 0.04, false),
  glockMagOut: S(4, 0.75, 0.6, 1, 0.08, 0.04, false),
  glockMagIn: S(4, 0.8, 0.6, 1, 0.08, 0.04, false),
  glockRackBack: S(4, 0.8, 0.6, 1, 0.08, 0.04, false),
  glockRackFwd: S(4, 0.85, 0.6, 1, 0.08, 0.04, false),
  glockSlideRel: S(4, 0.85, 0.6, 1, 0.08, 0.04, false),
  akMagOut: S(4, 0.8, 0.6, 1, 0.08, 0.04, false),
  akMagIn: S(4, 0.85, 0.6, 1, 0.08, 0.04, false),
  akRackBack: S(4, 0.85, 0.6, 1, 0.08, 0.04, false),
  akRackFwd: S(4, 0.9, 0.6, 1, 0.08, 0.04, false),
  brassS: S(1, 0.45, 0.8, 1.2, 0.06, 0.08, false),
  brassM: S(1, 0.5, 0.8, 1.2, 0.06, 0.08, false),
  magDrop: S(2, 0.6, 1, 1, 0.08, 0.06, false),
  holsterIn: S(3, 0.6, 0.6, 1, 0.04, 0.05, false),
  holsterOut: S(3, 0.6, 0.6, 1, 0.04, 0.05, false),
  cloth: S(1, 0.35, 0.6, 1, 0.03, 0.06, false),
  // things you must locate: HRTF first
  enemyShot: S(5, 0.85, 2.5, 0.85, 0.38, 0.04, true),
  impactWall: S(2, 0.7, 1, 1, 0.15, 0.06, true),
  impactFlesh: S(3, 0.8, 1, 1, 0.1, 0.06, true),
  grunt: S(3, 0.75, 1.2, 1, 0.12, 0.05, true),
  fall: S(3, 0.9, 1.5, 1, 0.15, 0.06, true),
  step: S(2, 0.5, 1, 1.3, 0.06, 0.08, true),
});

export const MIX = Object.freeze({
  voices: 24,
  hrtf: 8,
  uiVoices: 2,
  airM: 55,
  occludedHz: 1100,
  occludedGain: 0.5,
  /** Heard through a wall, relatively more of the sound arrives as room sound. */
  occludedWetK: 1.2,
  /** No occlusion test this close (your own gun and body). */
  occlusionMinM: 0.75,
  speedOfSound: 343,
  stealFadeS: 0.006,
  rt60: 0.45,
  irS: 0.6,
  comp: Object.freeze({ threshold: -10, knee: 8, ratio: 6, attack: 0.002, release: 0.15 }),
  masterGain: 0.9,
  sfxGain: 1,
  uiGain: 0.6,
  decodeConcurrency: 6,
});

/**
 * @typedef {{ gain: GainNode, filter: BiquadFilterNode|null, panner: PannerNode|null, send: GainNode|null,
 *   src: AudioBufferSourceNode|null }} Voice
 */

export class AudioEngine {
  /**
   * @param {{ AudioContextClass?: any, reverb?: boolean, occlusion?: boolean, seed?: number,
   *   voices?: number, hrtf?: number, ui?: number }} [o]
   */
  constructor(o = {}) {
    const g = /** @type {any} */ (globalThis);
    this.AC = o.AudioContextClass || g.AudioContext || g.webkitAudioContext || null;
    this.reverb = o.reverb !== false;
    this.occlusion = o.occlusion !== false;
    this.pool = new VoicePool(o.voices ?? MIX.voices, o.hrtf ?? MIX.hrtf, o.ui ?? MIX.uiVoices);
    /** @type {AudioContext|null} */ this.ctx = null;
    /** @type {Voice[]} */ this.voices = [];
    /** @type {Record<string, AudioBuffer[]>} */ this.buffers = {};
    /** @type {Record<string, number>} last variant per key */ this.last = {};
    this.unlocked = false;
    this.decoded = false;
    /** @type {GainNode|null} */ this.master = null;
    /** @type {GainNode|null} */ this.sfx = null;
    /** @type {GainNode|null} */ this.uiBus = null;
    /** @type {ConvolverNode|null} */ this.convolver = null;
    /** @type {{ segmentClear: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean } | null} */
    this.world = null;
    // listener (world), updated each frame
    this.lx = 0; this.ly = 1.6; this.lz = 0;
    this._pose = new Float64Array(7);
    this._dir = new Float64Array(6);
    this._resumeAt = 0;
    this.rng = (o.seed ?? 0x6d2b79f5) >>> 0 || 1;
    /** @type {string[]} */ this.errors = [];
    /** Diagnostics; steals and drops are counted by the pool (`pool.steals`, `pool.drops`). */
    this.stats = { plays: 0, missing: 0, occluded: 0 };
    /** @type {(() => void)[]} */ this._unsub = [];
    this._onEnemyShot = this._onEnemyShot.bind(this);
    this._onEnemyHit = this._onEnemyHit.bind(this);
  }

  /** Decoded and the graph exists. */
  get ready() { return !!this.ctx && this.decoded; }

  /** Create the context (suspended until unlock) and the whole node graph, once. */
  ensureContext() {
    if (this.ctx || !this.AC) return this.ctx;
    try {
      this.ctx = new this.AC({ latencyHint: 'interactive' });
    } catch (e) {
      this.errors.push(`AudioContext: ${e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e}`);
      this.ctx = null;
      return null;
    }
    this.buildGraph(/** @type {AudioContext} */ (this.ctx));
    return this.ctx;
  }

  /** @param {AudioContext} ac */
  buildGraph(ac) {
    const master = ac.createGain();
    master.gain.value = MIX.masterGain;
    master.connect(ac.destination);
    const comp = ac.createDynamicsCompressor();
    const C = MIX.comp;
    comp.threshold.value = C.threshold;
    comp.knee.value = C.knee;
    comp.ratio.value = C.ratio;
    comp.attack.value = C.attack;
    comp.release.value = C.release;
    comp.connect(master);
    const sfx = ac.createGain();
    sfx.gain.value = MIX.sfxGain;
    sfx.connect(comp);
    const uiBus = ac.createGain();
    uiBus.gain.value = MIX.uiGain;
    uiBus.connect(master);
    this.master = master;
    this.sfx = sfx;
    this.uiBus = uiBus;
    /** @type {ConvolverNode|null} */
    let conv = null;
    if (this.reverb) {
      try {
        conv = ac.createConvolver();
        conv.normalize = false;
        conv.buffer = roomResponse(ac, MIX.irS, MIX.rt60, () => this.rand()); // the only convolver buffer, at load
        conv.connect(sfx);
      } catch (e) {
        this.errors.push(`reverb: ${e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e}`);
        conv = null;
      }
    }
    this.convolver = conv;
    const P = this.pool;
    for (let i = 0; i < P.n; i++) {
      const gain = ac.createGain();
      gain.gain.value = 0;
      if (i >= P.spatialEnd) {
        gain.connect(uiBus);
        this.voices.push({ gain, filter: null, panner: null, send: null, src: null });
        continue;
      }
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      filter.Q.value = 0.707;
      const panner = ac.createPanner();
      panner.panningModel = i < P.hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.rolloffFactor = 1;
      panner.maxDistance = 10000;
      gain.connect(filter);
      filter.connect(panner);
      panner.connect(sfx);
      /** @type {GainNode|null} */
      let send = null;
      if (conv) {
        send = ac.createGain();
        send.gain.value = 0;
        filter.connect(send);
        send.connect(conv);
      }
      this.voices.push({ gain, filter, panner, send, src: null });
    }
  }

  /**
   * Decode every clip before Enter. Each ArrayBuffer is copied first because
   * decodeAudioData detaches what it is given, so `assets.sounds` stays intact.
   * @param {Record<string, (ArrayBuffer|AudioBuffer)[]>} sounds
   * @param {(fraction: number, key: string) => void} [onProgress]
   */
  async decodeAll(sounds, onProgress) {
    const ac = this.ensureContext();
    if (!ac) return;
    /** @type {{ key: string, i: number, data: ArrayBuffer|AudioBuffer }[]} */
    const jobs = [];
    for (const key of Object.keys(sounds || {})) {
      const list = sounds[key] || [];
      /** @type {(AudioBuffer|null)[]} */
      const slots = new Array(list.length).fill(null);
      this.buffers[key] = /** @type {any} */ (slots);
      for (let i = 0; i < list.length; i++) jobs.push({ key, i, data: list[i] });
    }
    let next = 0, done = 0;
    const total = jobs.length;
    const worker = async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        try {
          const d = /** @type {any} */ (j.data);
          const buf = d && typeof d.getChannelData === 'function' ? d : await ac.decodeAudioData(d.slice(0));
          /** @type {any} */ (this.buffers[j.key])[j.i] = buf;
        } catch (e) {
          this.errors.push(`decode ${j.key}[${j.i}]: ${e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e}`);
        }
        done++;
        if (onProgress) onProgress(done / total, j.key);
      }
    };
    const n = Math.min(MIX.decodeConcurrency, jobs.length);
    const workers = [];
    for (let k = 0; k < n; k++) workers.push(worker());
    await Promise.all(workers);
    for (const key of Object.keys(this.buffers)) {
      this.buffers[key] = this.buffers[key].filter(Boolean);
      this.last[key] = -1;
    }
    this.decoded = true;
  }

  /**
   * Call synchronously inside the Enter click (user gesture): resumes the
   * context and starts one silent sample so the output is really open.
   */
  unlock() {
    const ac = this.ensureContext();
    if (!ac) return;
    try {
      if (ac.state !== 'running') ac.resume().catch(() => {});
      const b = ac.createBuffer(1, 1, ac.sampleRate);
      const s = ac.createBufferSource();
      s.buffer = b;
      s.connect(/** @type {GainNode} */ (this.master));
      s.start(0);
    } catch (e) {
      this.errors.push(`unlock: ${e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : e}`);
    }
    this.unlocked = true;
  }

  /**
   * Subscribe the event-driven sounds: `enemyShot` → 'enemyShot' at the muzzle,
   * `enemyHit` → 'impactFlesh' at the wound (louder with damage). Other modules
   * must not play these two for the same events.
   * @param {import('../core/Events.js').Events} events
   * @param {{ enemyShot?: boolean, enemyHit?: boolean }} [o]
   */
  bind(events, { enemyShot = true, enemyHit = true } = {}) {
    this.unbind();
    if (enemyShot) this._unsub.push(events.on('enemyShot', this._onEnemyShot));
    if (enemyHit) this._unsub.push(events.on('enemyHit', this._onEnemyHit));
  }

  unbind() {
    for (let i = 0; i < this._unsub.length; i++) this._unsub[i]();
    this._unsub.length = 0;
  }

  /** @param {{ x: number, y: number, z: number }} p */
  _onEnemyShot(p) { this.play('enemyShot', p.x, p.y, p.z); }

  /** @param {{ x: number, y: number, z: number, damage: number }} p */
  _onEnemyHit(p) {
    const d = p.damage > 0 ? (p.damage < 100 ? p.damage : 100) : 0;
    this.play('impactFlesh', p.x, p.y, p.z, 0.7 + d * 0.003);
  }

  /**
   * A positional sound. Picks a variant (never the same twice running) and a
   * voice (stealing by priority and audibility).
   * @param {string} key
   * @param {number} x @param {number} y @param {number} z world position
   * @param {number} [gain]
   * @param {number} [rate]
   * @returns {number} voice id, or −1 (not ready, unknown key, or dropped)
   */
  play(key, x, y, z, gain = 1, rate = 1) {
    const ac = this.ctx;
    if (!ac || !this.unlocked || ac.state !== 'running') return -1;
    const bank = this.buffers[key];
    if (!bank || bank.length === 0) { this.stats.missing++; return -1; }
    const c = SOUNDS[key] || SOUND_DEFAULT;
    const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let occl = false;
    const w = this.world;
    if (this.occlusion && w && d > MIX.occlusionMinM) {
      // end 5 cm short of the source: an impact point lies on the surface it hit
      const k = 0.05 / d;
      occl = !w.segmentClear(this.lx, this.ly, this.lz, x - dx * k, y - dy * k, z - dz * k);
      if (occl) this.stats.occluded++;
    }
    const g = gain * c.gain * (occl ? MIX.occludedGain : 1);
    const att = c.ref / (c.ref + c.roll * (Math.max(d, c.ref) - c.ref));
    const aud = g * att;
    const now = ac.currentTime;
    const P = this.pool;
    const i = P.pick(now, c.pri, aud, c.hrtf);
    if (i < 0) return -1;
    const v = this.voices[i];
    const t0 = this.take(v, now, P.lastStolen);
    const buf = bank[this.variant(key, bank.length)];
    let r = rate * (1 + c.jit * (2 * this.rand() - 1));
    if (!(r > 0.05)) r = 0.05;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    src.connect(v.gain);
    const startAt = t0 + d / MIX.speedOfSound;
    src.start(startAt);
    v.src = src;
    const gp = v.gain.gain;
    gp.setValueAtTime(g, t0);
    /** @type {BiquadFilterNode} */ (v.filter).frequency.value = (occl ? MIX.occludedHz : 20000) * Math.exp(-d / MIX.airM);
    const pn = /** @type {PannerNode} */ (v.panner);
    pn.refDistance = c.ref;
    pn.rolloffFactor = c.roll;
    setPos(pn, x, y, z);
    // The send taps after the voice gain (so it already carries g) and before the
    // panner (no inverse-law loss): the room level stays nearly constant with
    // distance while the direct sound falls, easing to half for far sources.
    if (v.send) v.send.gain.value = c.wet * (0.5 + 0.5 * att) * (occl ? MIX.occludedWetK : 1);
    this.stats.plays++;
    return P.assign(i, now, startAt + buf.duration / r, c.pri, aud);
  }

  /**
   * A head-locked sound (menus, prompts).
   * @param {string} key
   * @param {number} [gain]
   * @param {number} [rate]
   */
  playUI(key, gain = 1, rate = 1) {
    const ac = this.ctx;
    if (!ac || !this.unlocked || ac.state !== 'running') return -1;
    const bank = this.buffers[key];
    if (!bank || bank.length === 0) { this.stats.missing++; return -1; }
    const P = this.pool;
    const i = P.pickUI(ac.currentTime);
    if (i < 0) return -1;
    const now = ac.currentTime;
    const v = this.voices[i];
    const t0 = this.take(v, now, P.lastStolen);
    const buf = bank[this.variant(key, bank.length)];
    const r = rate > 0.05 ? rate : 0.05;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    src.connect(v.gain);
    src.start(t0);
    v.src = src;
    v.gain.gain.setValueAtTime(gain, t0);
    this.stats.plays++;
    return P.assign(i, now, t0 + buf.duration / r, 9, gain);
  }

  /**
   * Move a playing positional sound (a moving source).
   * @param {number} id @param {number} x @param {number} y @param {number} z
   */
  move(id, x, y, z) {
    const i = this.pool.index(id);
    if (i < 0) return false;
    const pn = this.voices[i].panner;
    if (!pn) return false;
    setPos(pn, x, y, z);
    return true;
  }

  /** Fade out and free a voice. @param {number} id */
  stop(id) {
    const ac = this.ctx;
    const i = this.pool.index(id);
    if (!ac || i < 0) return false;
    const now = ac.currentTime;
    this.take(this.voices[i], now, this.pool.busy(i, now));
    this.pool.release(i, now);
    return true;
  }

  /**
   * Volume levels (0..1+).
   * @param {{ master?: number, sfx?: number, ui?: number }} o
   */
  setVolume({ master, sfx, ui }) {
    if (this.master && master !== undefined) this.master.gain.value = master;
    if (this.sfx && sfx !== undefined) this.sfx.gain.value = sfx;
    if (this.uiBus && ui !== undefined) this.uiBus.gain.value = ui;
  }

  /** Suspend the output (session hidden) or resume it. @param {boolean} on */
  setSuspended(on) {
    const ac = this.ctx;
    if (!ac) return;
    if (on && ac.state === 'running') ac.suspend().catch(() => {});
    else if (!on && this.unlocked && ac.state !== 'running') ac.resume().catch(() => {});
  }

  /**
   * The `audio` system: the listener follows the head (ctx.camera), and the
   * world is kept for the occlusion test. Allocation-free.
   * @param {number} _dt @param {number} t
   * @param {XRFrame|null|undefined} _frame
   * @param {{ camera?: any, world?: any }} ctx
   */
  update(_dt, t, _frame, ctx) {
    const ac = this.ctx;
    if (!ac) return;
    this.world = ctx.world && typeof ctx.world.segmentClear === 'function' ? ctx.world : null;
    if (this.unlocked && ac.state === 'suspended' && t >= this._resumeAt) {
      // the browser may suspend the context while the session is hidden
      this._resumeAt = t + 1000;
      ac.resume().catch(() => {});
    }
    const cam = ctx.camera;
    if (!cam) return;
    const P = this._pose, D = this._dir;
    if (!headPose(cam, P)) return;
    quatForward(P[3], P[4], P[5], P[6], D, 0);
    quatUp(P[3], P[4], P[5], P[6], D, 3);
    this.lx = P[0]; this.ly = P[1]; this.lz = P[2];
    const L = /** @type {any} */ (ac.listener);
    if (L.positionX) {
      L.positionX.value = P[0]; L.positionY.value = P[1]; L.positionZ.value = P[2];
      L.forwardX.value = D[0]; L.forwardY.value = D[1]; L.forwardZ.value = D[2];
      L.upX.value = D[3]; L.upY.value = D[4]; L.upZ.value = D[5];
    } else if (L.setPosition) {
      L.setPosition(P[0], P[1], P[2]);
      L.setOrientation(D[0], D[1], D[2], D[3], D[4], D[5]);
    }
  }

  /** Busy voices right now (diagnostics). */
  busyVoices() { return this.ctx ? this.pool.busyCount(this.ctx.currentTime) : 0; }

  dispose() {
    this.unbind();
    const ac = this.ctx;
    this.ctx = null;
    this.voices.length = 0;
    if (ac) ac.close().catch(() => {});
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Free a voice for a new sound. A sound still playing is faded out over 6 ms
   * (no click) and the new one starts after the fade.
   * @param {Voice} v @param {number} now @param {boolean} playing
   * @returns {number} earliest start for the new sound
   */
  take(v, now, playing) {
    const gp = v.gain.gain;
    gp.cancelScheduledValues(now);
    const old = v.src;
    v.src = null;
    if (!old) return now;
    if (!playing) { old.disconnect(); return now; }
    const end = now + MIX.stealFadeS;
    gp.setValueAtTime(gp.value, now);
    gp.linearRampToValueAtTime(0, end);
    try { old.stop(end); } catch { /* already stopped */ }
    return end;
  }

  /** @param {string} key @param {number} n */
  variant(key, n) {
    if (n <= 1) { this.last[key] = 0; return 0; }
    const last = this.last[key];
    let j;
    if (last >= 0 && last < n) {
      j = Math.floor(this.rand() * (n - 1));
      if (j >= last) j++;
    } else j = Math.floor(this.rand() * n);
    if (j >= n) j = n - 1;
    this.last[key] = j;
    return j;
  }

  /** xorshift32 in [0, 1). */
  rand() {
    let x = this.rng;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng = x || 1;
    return x / 4294967296;
  }
}

/**
 * @param {PannerNode} p @param {number} x @param {number} y @param {number} z
 */
function setPos(p, x, y, z) {
  const a = /** @type {any} */ (p);
  if (a.positionX) { a.positionX.value = x; a.positionY.value = y; a.positionZ.value = z; }
  else a.setPosition(x, y, z);
}

/**
 * A furnished-room impulse response, made once at load: 4 ms pre-delay, five
 * early reflections, then decorrelated stereo noise decaying to −60 dB at
 * `rt60`, with highs dying faster (a one-pole lowpass closing over the tail).
 * Normalised to unit energy per channel, so a send of 0.3 is about −10 dB of
 * room against the direct sound at the reference distance.
 * @param {BaseAudioContext} ac
 * @param {number} seconds
 * @param {number} rt60
 * @param {() => number} rand
 */
export function roomResponse(ac, seconds, rt60, rand) {
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const buf = ac.createBuffer(2, n, sr);
  const pre = Math.round(0.004 * sr);
  const taps = [0.0035, 0.0068, 0.0102, 0.0141, 0.0197];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const a = 0.12 + 0.73 * Math.exp(-t / 0.12);
      lp += a * (rand() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.907755 * t) / rt60);
    }
    for (let k = 0; k < taps.length; k++) {
      const i = pre + Math.round((taps[k] + ch * 0.0009 * (k + 1)) * sr);
      if (i < n) d[i] += (k % 2 ? -1 : 1) * 0.55 * Math.pow(0.78, k);
    }
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const s = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < n; i++) d[i] *= s;
  }
  return buf;
}
