// @ts-check
/**
 * Sound selection for the contract keys (docs/CONTRACTS.md "Sounds").
 *
 * Chosen from the file names and the CQC dev log (its cut_user_sfx section
 * labels each take from onsets / envelope / spectrum), not by ear:
 *  - pistol1 = department64 small-room pistol shot; ak1-5 = indoor-range AK.
 *  - glk* = Glock 17 reloads (kno-sfx): mag out = release + slide out, mag in =
 *    push + catch, rack back / forward, slide release = single slam.
 *  - ak* = AK magazine out (rock-out rattle) / in (tick + snap), handle back / home.
 *  - dry1-8 = dry-fire clicks; dryReset1-4 = trigger reset ticks.
 *  - brassS = small cases (10.6-13 kHz ring, 9 mm); brassR = rifle cases (6.4 kHz).
 *  - pickup1-9 = hand grabs (holster draw / re-holster stand-ins: there is no
 *    holster recording); cloth1-7 = heavy-coat strides.
 *  - impPla = plaster wall hits (house walls), impFle = flesh hits.
 *  - grunt1-7 voices, fall = body fall.
 *  - step: no footstep recording exists in CQC or Blackout (both synthesise
 *    steps), so short soft impacts are derived here (CC0 Kenney "Impact Sounds",
 *    CC BY 4.0 Oculus Audio Pack canvas case drop): mono, low-passed.
 * Every CQC file is already mono, 44.1 kHz, <= 1.3 s.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CQC = '/home/user/ref/realism-cqc-realism/cqc/sounds';
const range = (/** @type {string} */ p, /** @type {number} */ a, /** @type {number} */ b) => Array.from({ length: b - a + 1 }, (_, i) => `${p}${a + i}`);

/** key -> CQC file stems */
export const SOUND_MAP = {
  glockShot: ['pistol1'],
  akShot: range('ak', 1, 5),
  dry: range('dry', 1, 8),
  dryReset: range('dryReset', 1, 4),
  glockMagOut: range('glkMagOut', 1, 2),
  glockMagIn: range('glkMagIn', 1, 2),
  glockRackBack: range('glkRackBack', 1, 2),
  glockRackFwd: range('glkRackFwd', 1, 2),
  glockSlideRel: ['glkSlideRel'],
  akMagOut: range('akMagOut', 1, 3),
  akMagIn: ['akMagIn1'],
  akRackBack: range('akRackBack', 1, 4),
  akRackFwd: range('akRackFwd', 1, 4),
  brassS: range('brassS', 1, 5),
  brassM: range('brassR', 1, 4),
  holsterIn: ['pickup2', 'pickup4', 'pickup6', 'pickup8'],
  holsterOut: ['pickup1', 'pickup3', 'pickup5', 'pickup7', 'pickup9'],
  cloth: range('cloth', 1, 7),
  enemyShot: range('ak', 1, 5),
  impactWall: range('impPla', 1, 5),
  impactFlesh: range('impFle', 1, 5),
  grunt: range('grunt', 1, 7),
  fall: ['fall'],
  step: ['step1', 'step2', 'step3'],
  // extra (not in the contract list): a magazine hitting the floor
  magDrop: range('magDrop', 1, 3),
};

/** Derived footstep takes: [output stem, source, ffmpeg audio filter]. */
const DERIVED = [
  ['step1', `${CQC}/src/impact/kenney/impact_soft_medium_001.ogg`, 'lowpass=f=2200,afade=t=out:st=0.14:d=0.04'],
  ['step2', `${CQC}/src/impact/oculus/OBJBag_CanvasCaseDrop_OS_01.ogg`, 'atrim=0:0.28,lowpass=f=1800,afade=t=out:st=0.2:d=0.08'],
  ['step3', `${CQC}/src/impact/kenney/impact_generic_light_000.ogg`, 'lowpass=f=1500,volume=0.8,afade=t=out:st=0.1:d=0.04'],
];

/**
 * Copy / derive the files into assets/sounds; returns manifest.sounds and sizes.
 * @param {string} outDir
 */
export function bakeSounds(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [stem, src, af] of DERIVED) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '44100', '-af', af, '-c:a', 'libmp3lame', '-b:a', '128k', join(outDir, `${stem}.mp3`)]);
  }
  /** @type {Record<string, string[]>} */
  const sounds = {};
  /** @type {Record<string, number>} */
  const bytes = {};
  for (const [key, stems] of Object.entries(SOUND_MAP)) {
    sounds[key] = stems.map((s) => {
      const file = `${s}.mp3`;
      const dst = join(outDir, file);
      if (!s.startsWith('step')) {
        const src = join(CQC, file);
        if (!existsSync(src)) throw new Error(`sound ${src} missing`);
        copyFileSync(src, dst);
      }
      bytes[`sounds/${file}`] = statSync(dst).size;
      return `sounds/${file}`;
    });
  }
  return { sounds, bytes };
}
