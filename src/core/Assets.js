// @ts-check
/**
 * Asset loader (docs/CONTRACTS.md "Assets"): the baked weapon and soldier
 * GLBs (KTX2 textures, meshopt geometry) and the sound files, all fetched
 * before Enter with one progress bar.
 *
 * three.js and its add-ons are imported lazily inside load(), so the pure
 * helpers below (manifest checks, load plan, progress, sound buffers) import
 * in Node for the unit tests (tests/unit/assets.test.js).
 *
 * Usage:
 *   const assets = new Assets({ renderer });   // the renderer is needed to pick the KTX2 transcode format
 *   await assets.load((f, label) => bar(f, label));
 *   assets.models.glock.gun / .mag / .manifest; assets.sounds.glockShot -> ArrayBuffer[]
 */

/** @typedef {[number, number, number]} V3 */

/**
 * @typedef {Object} WeaponManifest
 * @property {V3} muzzle
 * @property {V3} ejectionPort
 * @property {V3} ejectDir
 * @property {{ pos: V3, up: V3, fwd: V3 }} grip
 * @property {{ pos: V3, axis: V3 }} magWell
 * @property {V3} magLocalSeat
 * @property {{ travel: number, axis: V3, rackPoint: V3 }} slide
 * @property {{ pivot: V3, axis: V3, pullRad: number }} trigger
 * @property {{ pos: V3 }} [support]
 * @property {{ rear: V3, front: V3 }} sights
 * @property {number} tris
 * @property {Object} textures
 * @property {string[]} parts  names of the _part values 0..4
 */

/**
 * @typedef {Object} SoldierManifest
 * @property {number} height
 * @property {Record<string, string | string[]>} joints
 * @property {{ pos: V3, quat: [number, number, number, number] }} rifleInHand  rifle node transform in the hand_r joint's space
 * @property {V3} rifleSupport  left-hand point, rifle space
 * @property {V3} rifleMuzzle   rifle space
 * @property {string} rifleParent
 */

/**
 * @typedef {{ scene: import('three').Group, gun: import('three').Mesh, mag: import('three').Mesh, manifest: WeaponManifest }} WeaponModel
 * @typedef {{ scene: import('three').Group, mesh: import('three').SkinnedMesh, rifle: import('three').Mesh, manifest: SoldierManifest }} SoldierModel
 */

export const WEAPON_IDS = /** @type {const} */ (['glock', 'akm']);
export const SOUND_KEYS = /** @type {const} */ ([
  'glockShot', 'akShot', 'dry', 'dryReset', 'glockMagOut', 'glockMagIn', 'glockRackBack', 'glockRackFwd', 'glockSlideRel',
  'akMagOut', 'akMagIn', 'akRackBack', 'akRackFwd', 'brassS', 'brassM', 'holsterIn', 'holsterOut', 'cloth', 'enemyShot',
  'impactWall', 'impactFlesh', 'grunt', 'fall', 'step',
]);
const SOLDIER_JOINTS = ['pelvis', 'spine', 'neck', 'head', 'clavL', 'upperArmL', 'lowerArmL', 'handL', 'clavR', 'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'calfL', 'footL', 'thighR', 'calfR', 'footR'];

/** @param {unknown} v @param {number} n */
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Check a parsed manifest against the contract. Returns a list of problems
 * (empty = valid).
 * @param {any} m
 * @returns {string[]}
 */
export function validateManifest(m) {
  /** @type {string[]} */
  const errs = [];
  /** @param {boolean} ok @param {string} what */
  const need = (ok, what) => { if (!ok) errs.push(what); };
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  need(m.version === 1, 'version must be 1');
  for (const id of [...WEAPON_IDS, 'soldier']) need(typeof m.models?.[id] === 'string', `models.${id} missing`);
  for (const id of WEAPON_IDS) {
    const w = m.weapons?.[id];
    if (!w) { errs.push(`weapons.${id} missing`); continue; }
    for (const k of ['muzzle', 'ejectionPort', 'ejectDir', 'magLocalSeat']) need(isVec(w[k], 3), `weapons.${id}.${k} must be [x,y,z]`);
    need(isVec(w.grip?.pos, 3) && isVec(w.grip?.up, 3) && isVec(w.grip?.fwd, 3), `weapons.${id}.grip {pos,up,fwd}`);
    need(isVec(w.magWell?.pos, 3) && isVec(w.magWell?.axis, 3), `weapons.${id}.magWell {pos,axis}`);
    need(typeof w.slide?.travel === 'number' && w.slide.travel > 0 && isVec(w.slide?.axis, 3) && isVec(w.slide?.rackPoint, 3), `weapons.${id}.slide {travel,axis,rackPoint}`);
    need(isVec(w.trigger?.pivot, 3) && isVec(w.trigger?.axis, 3) && typeof w.trigger?.pullRad === 'number', `weapons.${id}.trigger {pivot,axis,pullRad}`);
    need(isVec(w.sights?.rear, 3) && isVec(w.sights?.front, 3), `weapons.${id}.sights {rear,front}`);
    need(typeof w.tris === 'number' && w.tris > 0 && w.tris <= 30000, `weapons.${id}.tris within 30k`);
    need(typeof w.textures === 'object', `weapons.${id}.textures`);
    need(w.muzzle?.[2] < 0, `weapons.${id}.muzzle must be at -Z`);
  }
  need(isVec(m.weapons?.akm?.support?.pos, 3), 'weapons.akm.support.pos');
  const s = m.soldier;
  if (!s) errs.push('soldier missing');
  else {
    need(typeof s.height === 'number' && s.height > 1 && s.height < 2.2, 'soldier.height (m)');
    for (const j of SOLDIER_JOINTS) need(j === 'spine' ? Array.isArray(s.joints?.spine) && s.joints.spine.length > 0 : typeof s.joints?.[j] === 'string', `soldier.joints.${j}`);
    need(isVec(s.rifleInHand?.pos, 3) && isVec(s.rifleInHand?.quat, 4), 'soldier.rifleInHand {pos,quat}');
    need(isVec(s.rifleSupport, 3) && isVec(s.rifleMuzzle, 3), 'soldier.rifleSupport / rifleMuzzle');
  }
  for (const k of SOUND_KEYS) need(Array.isArray(m.sounds?.[k]) && m.sounds[k].length > 0 && m.sounds[k].every((/** @type {unknown} */ f) => typeof f === 'string'), `sounds.${k}`);
  return errs;
}

/**
 * What to fetch: the three models and every distinct sound file once.
 * @param {any} m manifest
 * @returns {{ models: { id: string, url: string, bytes: number }[], sounds: { url: string, bytes: number }[], soundKeys: Record<string, string[]>, totalBytes: number }}
 */
export function planLoad(m) {
  const size = (/** @type {string} */ u) => (m.bytes && typeof m.bytes[u] === 'number' ? m.bytes[u] : 20000);
  const models = [...WEAPON_IDS, 'soldier'].map((id) => ({ id, url: m.models[id], bytes: size(m.models[id]) }));
  /** @type {Map<string, number>} */
  const uniq = new Map();
  /** @type {Record<string, string[]>} */
  const soundKeys = {};
  for (const [key, files] of Object.entries(m.sounds || {})) {
    soundKeys[key] = /** @type {string[]} */ (files);
    for (const f of /** @type {string[]} */ (files)) if (!uniq.has(f)) uniq.set(f, size(f));
  }
  const sounds = [...uniq.entries()].map(([url, bytes]) => ({ url, bytes }));
  const totalBytes = models.reduce((a, x) => a + x.bytes, 0) + sounds.reduce((a, x) => a + x.bytes, 0);
  return { models, sounds, soundKeys, totalBytes };
}

/**
 * Sound buffers per key. A file used by several keys (enemy and player AK
 * shots) gets its own copy for every use after the first, because
 * decodeAudioData detaches the ArrayBuffer it is given.
 * @param {Record<string, string[]>} soundKeys
 * @param {Map<string, ArrayBuffer>} byUrl
 * @returns {Record<string, ArrayBuffer[]>}
 */
export function soundBuffers(soundKeys, byUrl) {
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Record<string, ArrayBuffer[]>} */
  const out = {};
  for (const [key, files] of Object.entries(soundKeys)) {
    out[key] = files.map((f) => {
      const buf = byUrl.get(f);
      if (!buf) throw new Error(`sound ${f} was not loaded`);
      if (used.has(f)) return buf.slice(0);
      used.add(f);
      return buf;
    });
  }
  return out;
}

/**
 * Progress over a known byte total (downloads) plus a parse phase.
 * Fractions only move forward and stay within [0, 1].
 */
export class ProgressTracker {
  /**
   * @param {number} totalBytes
   * @param {number} parseSteps
   * @param {(fraction: number, label: string) => void} [cb]
   * @param {number} [downloadShare] share of the bar for downloads
   */
  constructor(totalBytes, parseSteps, cb, downloadShare = 0.85) {
    this.total = Math.max(1, totalBytes);
    this.loaded = 0;
    this.steps = Math.max(1, parseSteps);
    this.done = 0;
    this.cb = cb;
    this.share = downloadShare;
    this.last = 0;
  }

  /** @param {number} n @param {string} label */
  bytes(n, label) { this.loaded += n; this.emit(label); }

  /** @param {string} label */
  step(label) { this.done++; this.emit(label); }

  /** @param {string} label */
  emit(label) {
    const f = this.share * Math.min(1, this.loaded / this.total) + (1 - this.share) * Math.min(1, this.done / this.steps);
    this.last = Math.max(this.last, Math.min(1, f));
    if (this.cb) this.cb(this.last, label);
  }
}

/**
 * Fetch a file as an ArrayBuffer, reporting bytes as they arrive; retries
 * network failures and 5xx responses.
 * @param {string} url
 * @param {(n: number) => void} onBytes
 * @param {{ fetch?: typeof fetch, retries?: number }} [opt]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchBytes(url, onBytes, opt = {}) {
  const f = opt.fetch || fetch;
  const retries = opt.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let got = 0;
    try {
      const res = await f(url);
      if (!res.ok) {
        const err = new Error(`${url}: HTTP ${res.status}`);
        if (res.status < 500) throw Object.assign(err, { fatal: true });
        throw err;
      }
      const body = res.body;
      if (!body || typeof body.getReader !== 'function') {
        const buf = await res.arrayBuffer();
        onBytes(buf.byteLength);
        return buf;
      }
      const reader = body.getReader();
      /** @type {Uint8Array[]} */
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        onBytes(value.byteLength);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.byteLength; }
      return out.buffer;
    } catch (e) {
      if (got) onBytes(-got); // the retry re-counts this file from zero
      if (/** @type {any} */ (e).fatal || attempt >= retries) throw e;
    }
  }
}

/**
 * Run async jobs with at most `limit` in flight.
 * @template T
 * @param {(() => Promise<T>)[]} jobs @param {number} limit
 * @returns {Promise<T[]>}
 */
export async function runLimited(jobs, limit) {
  /** @type {T[]} */
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

export class Assets {
  /**
   * @param {{ renderer?: import('three').WebGLRenderer, base?: string, transcoderPath?: string, fetch?: typeof fetch }} [opt]
   *   base: folder of manifest.json (default './assets/'); transcoderPath: Basis transcoder folder.
   */
  constructor(opt = {}) {
    this.renderer = opt.renderer || null;
    this.base = opt.base ?? './assets/';
    this.transcoderPath = opt.transcoderPath ?? './vendor/three/addons/libs/basis/';
    this.fetch = opt.fetch;
    /** @type {{ glock?: WeaponModel, akm?: WeaponModel, soldier?: SoldierModel }} */
    this.models = {};
    /** @type {Record<string, ArrayBuffer[]>} */
    this.sounds = {};
    /** @type {any} */
    this.manifest = null;
    this.loaded = false;
  }

  /**
   * Fetch and parse everything. Rejects with a readable message on a missing
   * file or a manifest that does not match the contract.
   * @param {(fraction: number, label: string) => void} [onProgress]
   */
  async load(onProgress) {
    if (!this.renderer) throw new Error('Assets: pass { renderer } (KTX2 textures need it to pick a GPU format)');
    const opt = { fetch: this.fetch };
    const manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(`${this.base}manifest.json`, () => {}, opt)));
    const errs = validateManifest(manifest);
    if (errs.length) throw new Error(`assets/manifest.json: ${errs.join('; ')}`);
    this.manifest = manifest;
    const plan = planLoad(manifest);
    const progress = new ProgressTracker(plan.totalBytes, plan.models.length, onProgress);
    progress.emit('manifest');

    const [{ GLTFLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/KTX2Loader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]);
    const ktx2 = new KTX2Loader().setTranscoderPath(this.transcoderPath).detectSupport(this.renderer);
    const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

    try {
      const files = [...plan.models.map((x) => x.url), ...plan.sounds.map((x) => x.url)];
      const bufs = await runLimited(files.map((u) => () => fetchBytes(`${this.base}${u}`, (n) => progress.bytes(n, u), opt)), 6);
      /** @type {Map<string, ArrayBuffer>} */
      const byUrl = new Map(files.map((u, i) => [u, bufs[i]]));

      for (const { id, url } of plan.models) {
        const res = await gltf.parseAsync(/** @type {ArrayBuffer} */ (byUrl.get(url)), `${this.base}${url.replace(/[^/]*$/, '')}`);
        const scene = /** @type {import('three').Group} */ (res.scene);
        scene.name = id;
        if (id === 'soldier') {
          /** @type {any} */
          let mesh = null;
          scene.traverse((o) => { if (!mesh && /** @type {any} */ (o).isSkinnedMesh) mesh = o; });
          const rifle = scene.getObjectByName('rifle');
          if (!mesh || !rifle || !(/** @type {any} */ (rifle).isMesh)) throw new Error(`${url}: expected a SkinnedMesh and a 'rifle' mesh`);
          this.models.soldier = { scene, mesh, rifle: /** @type {any} */ (rifle), manifest: manifest.soldier };
        } else {
          const gun = /** @type {any} */ (scene.getObjectByName('gun'));
          const mag = /** @type {any} */ (scene.getObjectByName('mag'));
          if (!gun?.isMesh || !mag?.isMesh) throw new Error(`${url}: expected meshes 'gun' and 'mag'`);
          if (!gun.geometry.attributes._part) throw new Error(`${url}: 'gun' has no _part attribute`);
          /** @type {any} */ (this.models)[id] = { scene, gun, mag, manifest: manifest.weapons[id] };
        }
        progress.step(url);
      }
      this.sounds = soundBuffers(plan.soundKeys, byUrl);
    } finally {
      ktx2.dispose(); // transcoder workers are not needed after load
    }
    this.loaded = true;
    progress.emit('done');
    return this;
  }

  /**
   * Every texture of every model, once (for renderer.initTexture in the warm-up).
   * @returns {import('three').Texture[]}
   */
  textures() {
    /** @type {Set<any>} */
    const set = new Set();
    for (const m of Object.values(this.models)) {
      m.scene.traverse((/** @type {any} */ o) => {
        if (!o.material) return;
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (mat[k]) set.add(mat[k]);
        }
      });
    }
    return [...set];
  }
}
