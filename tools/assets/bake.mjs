// @ts-check
/**
 * Offline asset bake (re-runnable): writes assets/models/{glock,akm,soldier}.glb,
 * assets/sounds/*.mp3 and assets/manifest.json per docs/CONTRACTS.md. The gun
 * GLBs then get the gloved hands (hands.mjs; `node hands.mjs` alone re-does
 * only that step on the baked GLBs).
 *
 *   cd tools/assets && npm install && node bake.mjs [--debug <dir>]
 *
 * KTX2 encodes are cached in tools/assets/.cache (a first run takes several
 * minutes; later runs reuse identical textures).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AKM, GLOCK, bakeWeapon, rifleMesh } from './weapons.mjs';
import { bakeSoldier } from './soldier.mjs';
import { bakeSounds } from './sounds.mjs';
import { ready as simplifierReady } from './lib/simplify.mjs';
import { bakeHands } from './hands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const outDir = join(repo, 'assets');
const args = process.argv.slice(2);
const debugDir = args.includes('--debug') ? args[args.indexOf('--debug') + 1] : undefined;
const env = { cacheDir: join(here, '.cache'), debugDir, log: (/** @type {string} */ s) => console.log(s) };
const RIFLE_TRIS = 3000;

async function main() {
  await simplifierReady;
  mkdirSync(join(outDir, 'models'), { recursive: true });
  if (debugDir) mkdirSync(debugDir, { recursive: true });
  /** @type {Record<string, number>} */
  const bytes = {};
  const reports = [];

  const glock = await bakeWeapon(GLOCK, env);
  writeFileSync(join(outDir, 'models/glock.glb'), glock.glb);
  bytes['models/glock.glb'] = glock.glb.byteLength;
  reports.push(glock.report);

  const akm = await bakeWeapon(AKM, env);
  writeFileSync(join(outDir, 'models/akm.glb'), akm.glb);
  bytes['models/akm.glb'] = akm.glb.byteLength;
  reports.push(akm.report);

  const rifle = rifleMesh(akm.rifleSource, RIFLE_TRIS);
  env.log(`rifle: ${rifle.idx.length / 3} tris`);
  const soldier = await bakeSoldier(env, {
    mesh: rifle, base: akm.atlas.raw.base, orm: akm.atlas.raw.orm,
    grip: akm.manifest.grip, support: akm.manifest.support.pos, muzzle: akm.manifest.muzzle,
  });
  writeFileSync(join(outDir, 'models/soldier.glb'), soldier.glb);
  bytes['models/soldier.glb'] = soldier.glb.byteLength;
  reports.push(soldier.report);

  const snd = bakeSounds(join(outDir, 'sounds'));
  Object.assign(bytes, snd.bytes);

  const manifest = {
    version: 1,
    generator: 'tools/assets/bake.mjs',
    space: 'metres; weapons: +Y up, -Z muzzle, origin on the bore at the breech face, +X right; soldier: feet at y = 0, facing +Z',
    models: { glock: 'models/glock.glb', akm: 'models/akm.glb', soldier: 'models/soldier.glb' },
    textures: 'KTX2 (KHR_texture_basisu): load with KTX2Loader, transcoder in vendor/three/addons/libs/basis/',
    geometry: 'EXT_meshopt_compression + KHR_mesh_quantization (normals, UVs, weights); positions float32',
    weapons: { glock: glock.manifest, akm: akm.manifest },
    soldier: soldier.manifest,
    sounds: snd.sounds,
    bytes,
  };
  // v0.3: gloved hands from the CQC viewmodels, written into the gun GLBs (hands.mjs)
  await bakeHands(env, manifest);
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  console.log('\nreport');
  for (const r of reports) console.log(JSON.stringify(r));
  console.log(`total assets ${(total / 1048576).toFixed(2)} MB (${Object.keys(bytes).length} files)`);
  if (total >= 12 * 1048576) throw new Error('assets exceed 12 MB');
}

main().catch((e) => { console.error(e); process.exit(1); });
