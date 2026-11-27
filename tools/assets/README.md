# Asset bake (offline)

Re-bakes the weapon and enemy models and copies the sounds into `assets/` in the layout `docs/CONTRACTS.md` defines. Not part of the runtime.

```
cd tools/assets
npm install            # glTF Transform, meshoptimizer, sharp, ktx2-encoder (node_modules is gitignored)
node bake.mjs          # assets/models/*.glb, assets/sounds/*.mp3, assets/manifest.json
node check.mjs         # re-reads the GLBs: triangles, draws, textures, GPU memory
node inspect.mjs glock # source pieces with their labels (for editing the rules in weapons.mjs)
NODE_PATH=$(npm root -g) node render-check.mjs <outDir>   # headless Chromium screenshots (from the repo root)
```

The first bake encodes nine KTX2 maps (about a minute each for 2048 maps). The results are cached in `.cache/` by content hash, so a re-bake with unchanged textures takes about 4 minutes (the hidden-surface pass).

## What the bake does

**Weapons** (`weapons.mjs`):
1. Reads the source GLB and splits every primitive into connected pieces. Rules (source frame, mm) label each piece and give it a part: 0 static, 1 slide / carrier, 2 trigger, 3 slide stop (Glock) / selector (AKM), 4 magazine catch, or magazine.
2. **Gun space:** the bore axis comes from circles fitted to the barrel's vertex rings (muzzle crown, bore, chamber). The origin is the chamber mouth on that axis, with −Z toward the muzzle. The Glock is scaled to its factory length (202 mm); the AKM is already in metres.
3. **Measurements** (full-resolution geometry): the points in the manifest. See "Manifest" below.
4. **Hidden-surface removal:** the gun is rasterised orthographically from 280+ directions in five configurations: at rest, slide back, magazine out, both, and the magazine alone. Triangles that never win a pixel are removed, plus a one-ring margin. For the Glock's double-sided source, triangles seen from behind get a flipped twin.
5. **Simplification** (meshoptimizer, absolute error, UV and normal seams kept): one error bound for the whole gun, bisected to the triangle budget. Barely visible parts (springs, rounds behind the witness holes) get a larger bound.
6. **Atlas:** each material's maps, with factors baked in, are cropped to the UV window it uses and packed (skyline) into one atlas. Base colour is 2048² KTX2 ETC1S (sRGB). Normal is 2048² KTX2 UASTC + RDO + Zstd. ORM is 1024² KTX2 UASTC (R occlusion, G roughness, B metalness).
7. **Output:** a `gun` mesh (one primitive, float `_PART`) and a `mag` mesh (origin at the magazine's top on its insertion axis; its node sits at `magLocalSeat`). They share one material. The file uses EXT_meshopt_compression, quantised normals and UVs, and float positions.

**Soldier** (`soldier.mjs`): converted from centimetres to metres, with the feet at y = 0 and facing +Z. Unweighted and IK joints are removed, and the face joints are merged into the head (111 → 62 joints). The specular extension, which only held default values, is dropped. The rifle is the AKM from step 4 with the magazine seated, small parts dropped and seams relaxed, at ≤ 3k triangles. It uses the AKM atlas at 512² and is fitted to the right hand from the bind-pose hand joints.

**Sounds** (`sounds.mjs`): the files are picked by name and from the CQC log, not by ear. The steps are derived from CC0 / CC BY impacts (no footstep recording exists).

## Manifest notes (gun space)

- `grip.pos`: the centre of the grip section, on its axis, 15 mm below the bottom of the trigger guard (middle-finger height). `up` is the grip axis; `fwd` is perpendicular to it, toward the muzzle.
- `magWell.pos` = `magLocalSeat`: the magazine mesh origin when seated. `axis` is the insertion direction into the gun (for the AKM, the top 45 mm of its curved body).
- `slide.travel`: the breech face must pass behind the top round's case head, plus 1.5 mm (Glock) or 3 mm (AKM) of overtravel. `rackPoint`: the rear of the slide (Glock), or the charging-handle knob (AKM).
- `trigger.pivot`: the pin through the trigger. `axis` [−1, 0, 0]: a positive angle moves the blade rearwards. `pullRad` = trigger travel at the finger ÷ the pivot-to-finger radius. The travel is 12.5 mm (Glock spec) or 6 mm (AKM, an estimate), capped at 0.45 / 0.3 rad. The models' trigger slots are closed, so the stop can't be found by collision.
- `ejectionPort`: half a case length ahead of the breech face, on the outer right side. `ejectDir` is tuned, not measured: the Glock's is CQC's tested case velocity [1.5, 1.9, 0.8].
- `sights`: the top of the rear sight (Glock: ears; AKM: the notch end of the leaf) and of the front post, on the centre plane.
- Extras that are not in the contract: `parts` (part names), `bore.radius`, `magCatch {pos, axis, travel}`, `slideStop` (Glock part 3) or `selector` (AKM part 3), and `textures`.
