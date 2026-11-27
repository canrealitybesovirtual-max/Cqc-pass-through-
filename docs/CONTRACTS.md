# Test-slice contracts (v0.2 "first playable")

**Goal:** a first playable test in the user's real house on Quest 3.
- The user draws the Glock from the right hip, or the AKM from over the right shoulder.
- Enemies walk in through real doorways and are hidden by real walls and furniture.
- The player shoots, reloads like a real weapon, and survives waves.
- No hitching. Realism is the priority.

Read first: `CLAUDE.md`, `docs/PLAN.md` (§5, §8–10, §14), `docs/ARCHITECTURE.md`, `docs/DEVICE_LOG.md` (real Quest facts).

## Rules for every module

- **Ownership.** Each builder writes **only its own directories** (see "Ownership" at the end). You may read anything. If you need something from another module, code against the interface in this file. Never edit another module's files.
- **Code style.** Plain ES modules, `// @ts-check`, JSDoc. three.js comes from `import * as THREE from 'three'`. Add-ons come from `'three/addons/…'`, which the import map points at `./vendor/three/addons/` (vendored by the Assets builder).
- **Units and axes.** Metres and seconds. Right-handed, +Y up.
    - World = the XR reference space (`local-floor` in play), with y = 0 at the floor.
    - XR pose matrices are column-major `Float32Array(16)`. Use `matrix.fromArray()`.
- **Zero allocations per frame.**
    - No `new`, closures, array literals, spread, `forEach` or template strings in `update()` paths.
    - Preallocate scratch `Vector3`/`Matrix4` objects at module level or on the instance.
    - Reuse payload objects for events.
- **Nothing may compile a shader or upload a texture after warm-up.** Every material, geometry and texture is created at load. Pools are prebuilt. Never toggle `transparent`, `alphaTest` or `instanceColor` later, and never swap to a material that wasn't warmed up. Call `setColorAt(0, white)` on instanced pools at creation.
- **Light set is fixed:** hemisphere + directional + `gfx.flashLights[0..1]` (point lights, intensity 0 at rest). Only `intensity`, `position` and `color` are animated.
- **No post-processing, no shadows, no transmission materials.** Blob shadows are optional (one instanced pool).
- **Pure logic is testable.** Pure modules (state machines, springs, nav, geometry) must not import three or touch the DOM. Each has `node --test` tests in `tests/unit/<module>.test.js`.
- **Never claim untested device behaviour.** Write "desktop-tested" or "implemented" in notes.

## Shared runtime context

Built by the integration layer and passed to every system:

```js
/** @typedef {Object} Ctx
 * @property {import('three').WebGLRenderer} renderer
 * @property {import('three').Scene} scene
 * @property {import('three').Camera} camera   // renderer.xr.getCamera(): world pose of the head (position/quaternion), valid inside the frame
 * @property {XRSession} session
 * @property {XRReferenceSpace} space
 * @property {import('../src/xr/Input.js').Input} input  // poses + buttons, updated first each frame (see src/xr/Input.js)
 * @property {import('../src/core/Events.js').Events} events
 * @property {AudioEngine} audio
 * @property {World} world
 * @property {Assets} assets
 * @property {{ flashLights: import('three').PointLight[] }} gfx
 * @property {Player} player
 * @property {(ox:number,oy:number,oz:number,dx:number,dy:number,dz:number,max:number,out:Hit,ignoreEnemy?:number)=>boolean} raycast  // world + enemies, nearest
 */
```

Every system implements `update(dt, t, frame, ctx)`, where `dt` is in seconds (clamped to 0.1 s) and `t` in ms. Systems run in this order:

1. input
2. world
3. player
4. weapons
5. enemies
6. game
7. audio
8. ui
9. render

**Hit record**: one reused object.

```js
/** @typedef {{ dist:number, x:number,y:number,z:number, nx:number,ny:number,nz:number,
 *   kind:'world'|'enemy'|'none', surface:string, enemy:number, part:'head'|'neck'|'torso'|'pelvis'|'limb'|'' }} Hit */
```

**Player** (built by the Game builder; read by everyone):

```js
/** @typedef {{ head: import('three').Vector3, forward: import('three').Vector3, // world, updated each frame
 *   torsoTop: import('three').Vector3, torsoBottom: import('three').Vector3, torsoRadius: number, headRadius: number,
 *   health: number, alive: boolean, zone: { x:number, z:number, r:number } }} Player */
```

**Events** (`ctx.events.emit(type, payload)`; payloads are reused objects):

| Event | Payload |
|---|---|
| `shot` | `{ weapon:'glock'\|'akm', x,y,z, dx,dy,dz }` (player fired; enemies hear it) |
| `enemyHit` | `{ enemy, part, damage, x,y,z, dx,dy,dz }` |
| `enemyKilled` | `{ enemy, headshot:boolean }` |
| `playerHit` | `{ damage, fromX, fromY, fromZ }` |
| `enemyShot` | `{ enemy, x,y,z }` (for audio and flash) |
| `pause` | `{ paused:boolean, reason:string }` (the game pauses all simulation when paused) |
| `waveStart` | `{ wave, enemies }` |
| `waveClear` | `{ wave }` |
| `roundOver` | `{ wave, kills }` |

## Assets (builder A)

`src/core/Assets.js`:

```js
export class Assets { async load(onProgress?: (fraction:number, label:string)=>void): Promise<void> }
// after load:
assets.models.glock   // { scene: THREE.Group, gun: THREE.Mesh, mag: THREE.Mesh, manifest: WeaponManifest }
assets.models.akm     // same layout
assets.models.soldier // { scene: THREE.Group, mesh: THREE.SkinnedMesh, rifle: THREE.Mesh, manifest: SoldierManifest }
assets.sounds         // { [key:string]: ArrayBuffer[] }  (variants; AudioEngine decodes them)
assets.manifest       // parsed assets/manifest.json
```

**Files:**
- `assets/models/glock.glb`, `akm.glb`, `soldier.glb`
- `assets/sounds/*.mp3`
- `assets/manifest.json`
- `assets/LICENSES.md` (the user confirmed all CQC assets are licensed for this project)

**Weapon GLB layout (gun space).** Metres. +Y up, **−Z = muzzle direction**, the bore axis runs along −Z, and the origin is on the bore axis at the breech face.
- Mesh node `gun`: every non-detachable part merged into **one primitive, one material**. Base colour, normal and ORM textures are atlased; no texture over 2048.
    - Vertex attribute `_PART` (three: `geometry.attributes._part`, float):
        - 0 = static
        - 1 = slide (Glock) / bolt carrier + charging handle (AKM)
        - 2 = trigger
        - 3 = selector (AKM) / unused
        - 4 = magazine catch
- Mesh node `mag`: the magazine with visible rounds, one primitive, sharing the same atlas material where possible.
- **Triangle budget:** ≤ 30k per weapon including the magazine.

**`WeaponManifest`** (inside `manifest.json` → `weapons.glock` / `weapons.akm`), all in gun space:

```js
{ muzzle:[x,y,z], ejectionPort:[x,y,z], ejectDir:[x,y,z],
  grip:{ pos:[x,y,z], up:[x,y,z], fwd:[x,y,z] },          // palm centre and grip axis (for attaching to the controller)
  magWell:{ pos:[x,y,z], axis:[x,y,z] },                   // seated mag origin and insertion axis (pointing into the gun)
  magLocalSeat:[x,y,z],                                    // mag mesh origin offset when seated
  slide:{ travel:m, axis:[x,y,z], rackPoint:[x,y,z] },     // Glock slide / AKM charging handle
  trigger:{ pivot:[x,y,z], axis:[x,y,z], pullRad:number },
  support?:{ pos:[x,y,z] },                                // AKM handguard grab point
  sights:{ rear:[x,y,z], front:[x,y,z] }, tris:number, textures:{...} }
```

**Soldier GLB.** Metres, feet at y = 0, **facing +Z**, a single SkinnedMesh with one material (the blackout `soldier.glb`, 13.6k triangles, 111 joints, UE-style names `pelvis_02`, `spine_01_03`, `hand_r_029`, …).
- Rifle mesh node `rifle`: a decimated AKM of ≤ 3k triangles, one material.
- `SoldierManifest`:

```js
{ height:m, joints:{ pelvis, spine:[...], neck, head, clavL, upperArmL, lowerArmL, handL, clavR, upperArmR, lowerArmR, handR, thighL, calfL, footL, thighR, calfR, footR },
  rifleInHand:{ pos:[x,y,z], quat:[x,y,z,w] }, rifleSupport:[x,y,z], rifleMuzzle:[x,y,z] }
```

**Sounds** (`manifest.sounds`, key → file list): `glockShot`, `akShot`, `dry`, `dryReset`, `glockMagOut`, `glockMagIn`, `glockRackBack`, `glockRackFwd`, `glockSlideRel`, `akMagOut`, `akMagIn`, `akRackBack`, `akRackFwd`, `brassS`, `brassM`, `holsterIn`, `holsterOut`, `cloth`, `enemyShot`, `impactWall`, `impactFlesh`, `grunt`, `fall`, `step`. Each file is mono, ≤ 1.5 s where possible.

## World (builder S): `src/world/`

```js
export function captureSnapshot(frame, space): SpaceSnapshot   // from frame.detectedPlanes (+ detectedMeshes bbox); pure data, no XR refs
export async function loadFixture(url): Promise<SpaceSnapshot>
export class World {
  build(snapshot: SpaceSnapshot|null, playerStart:{x:number,z:number}): void   // one-time, at session start behind the "Get ready" panel; null → virtual open room
  raycast(ox,oy,oz, dx,dy,dz, max, out: Hit): boolean   // walls, furniture boxes, floor, ceiling; out.surface = label
  segmentClear(ax,ay,az, bx,by,bz): boolean             // line of sight
  occluder: THREE.Mesh          // ONE merged depth-only mesh (colorWrite false, depthWrite true, renderOrder -10), boxes shrunk 2 cm, door openings left open
  nav: NavGrid                  // 0.10 m cells; walkable = verified floor, minus walls (door gaps carved), furniture footprints (+0.25 m), player zone (r + 1.2 m)
  findSpawn(fromX, fromZ, viewDirX, viewDirZ, minDist, out:{x,z}): boolean  // out of view, path-reachable, prefers the far side of a door
  floorY(x,z): number
  update(dt, t, frame, ctx): void
}
// SpaceSnapshot = { version:1, space:string, planes:[{label:string|null, orientation:'horizontal'|'vertical', pose:number[16], polygon:[[x,z],...]}],
//   meshes:[{label:string|null, pose:number[16], min:[x,y,z], max:[x,y,z], vertexCount:number}] }
export class NavGrid { /* pure */ isWalkable(x,z), clearance(x,z) }
export class PathPlanner { /* pure, time-sliced A*: */ request(id, sx,sz, gx,gz): void; step(maxExpansions): void; result(id, outPath: Float32Array): number /* points, or -1 pending, -2 failed */ }
```

- `tests/fixtures/house.json` is a two-room house: a 5 × 4 m living room and a 3.5 × 3 m bedroom joined by a 0.85 m door. It has a sofa, a table, a bed, and a second door to a hallway. The player starts in the living room. It uses the same format as `captureSnapshot`, so a real capture can replace it.
- On Quest, plane `lastChangedTime` changes about 3 times per second, so capture once (when the plane count has been stable for 0.5 s, or after 3 s) and never rebuild during play.

## Weapons (builders W1 core + W2 view and interaction): `src/weapons/`, `src/player/`

**W1 (pure).**
- `WeaponDefs.js`: glock and akm.
    - Rounds: 17+1 and 30+1.
    - Fire modes: semi; and safe/semi/auto at 600 rpm.
    - Recoil impulses and springs:

        | Weapon | Kick | Climb | Yaw | Springs |
        |---|---|---|---|---|
        | G17 | 0.9 | 11 | 1.6 | back k 520 / c 38; pitch and yaw k 300 / c 26; 4 ms sub-steps; random 0.9–1.1; × 0.55 with two hands |
        | AKM | stronger | stronger | stronger | tuned to a 7.62 rifle |

    - Damage at 100 hp: head 400, neck 120, torso 40, pelvis 45, limb 24 (AKM × 1.6).
    - Muzzle velocity, slide timings (back 15 ms, home 40 ms), and manifest keys.
- `WeaponInstance.js`: parallel state machines.
    - States: chambered, rounds in magazine, magazine seated / out, slide locked open on empty, racked, trigger reset, fire-mode selector.
    - Events in: `triggerPull` / `triggerRelease` / `magRelease` / `magInsert(rounds)` / `rackPull(fraction)` / `rackRelease` / `slideRelease` / `selector`.
    - Events out (callbacks): `onFire`, `onDry`, `onEject`, `onLock`, `onMagOut`, `onMagIn`, `onChamber`.
- `Recoil.js`: spring integrator. It outputs the gun-space offset (back, pitch, yaw) that the view applies to the gun. The camera never moves.
- **Tests:** fuzzed random event orders (ammo is conserved, no illegal states), and springs under 0.1 / 0.5 / 2 s frame spikes and NaN.

**W2 (three).**
- `WeaponView.js`: places the gun in the right hand.
    - The grip pose comes from the manifest grip plus a tuned grip-angle offset to the Quest Touch grip space. CQC tuned this; look its numbers up in `/home/user/ref/realism-cqc-realism` as reference.
    - Part motion uses an `onBeforeCompile` vertex hook with `uniform mat4 uPart[5]` selected by `_part`, plus a `customProgramCacheKey`, warmed up at load.
- `WeaponFX.js`: pooled muzzle flash (a quad written with alpha about 0.5 × brightness, plus `flashLights[0]` for 15 ms), instanced brass (ballistic, floor bounce, landing sound once), instanced bullet-hole decals on world hits.
- `src/player/BodyEstimator.js` (pure): hip yaw and position from the head and hands, per PLAN §8 (dead zone, freeze when looking down).
- `src/player/Slots.js`:
    - Glock holster on the right hip.
    - AKM on the back, grabbed over the right shoulder.
    - Magazine pouch on the left hip.
    - Grab with the grip within 0.13 m.
    - Release within 0.24 m of the holster to holster the gun. Released anywhere else, it returns to its slot after 0.3 s (scale or teleport, never a transparency switch).
- `src/weapons/WeaponSystem.js` (the system that registers): owns both weapons.
    - Right trigger fires using `ctx.raycast` from the muzzle along the bore (the hit uses the bore at the moment the trigger breaks).
    - Hits emit `enemyHit` or world FX.
    - **A** = magazine release: the magazine drops as a pooled ballistic object.
    - **Left grip at the pouch** takes a fresh magazine in the left hand. It seats when within 3 cm laterally, aligned (dot > 0.7), and pushed in.
    - **Rack:** the left grip within 0.085 m of the rack point, pulled back past 90 %.
    - **B** = slide release.
    - **Right stick click** = AKM selector.
    - **Second A press with the magazine out** = assisted reload (1.2 s) for testing.
    - **AKM two-handed:** while the left grip is held near `support`, the aim direction runs from the right grip to the left hand, and recoil is × 0.55.
    - **Haptics** (`hapticActuators[0].pulse`): shot 1.0 / 45 ms; slide home 0.75; magazine catch 0.28; rack 0.55.
    - **Ammo** for the HUD: `weaponSystem.ammo()` returns `{ weapon, mag, chambered }`.

## Enemies (builder E): `src/enemies/`

```js
export class EnemyManager {
  constructor(assets, scene, maxEnemies = 6)   // prebuilds ALL instances (SkeletonUtils.clone of the soldier) at load; nothing cloned later
  spawn(x, z, facing): number|-1
  update(dt, t, frame, ctx): void
  raycast(ox,oy,oz, dx,dy,dz, max, out:Hit): boolean   // per-part capsules from bone positions (head, neck, torso, pelvis, 4 limbs)
  applyHit(enemy, part, damage, dirX,dirY,dirZ): void
  alive(): number; reset(): void
  warmMeshes(): THREE.Object3D[]   // for the warm-up draw
}
```

- **Animation is procedural** (the GLB has no clips). Layers on the bones:
    1. **Locomotion:** a walk cycle scaled by speed (hips, knees, ankles, pelvis bob and sway).
    2. **Rifle hold:** aim, low ready, and two-bone IK of the left hand to `rifleSupport`.
    3. **Upper-body aim:** spread over the spine bones.
    4. **Hit reaction:** an additive spring.
    5. **Death:** a scripted fall away from the shot onto the floor (the floor plane only). The body stays 6 s, then is hidden and returned to the pool.
    - The bounding sphere follows the pelvis; never use the bind-pose bounds.
- **Brain** (10 Hz, staggered):
    - Spawn → path to an engagement point 3–7 m from the player with line of sight.
    - Reaction 0.45–0.85 s before shooting.
    - Bursts of 2–4 rounds at 600 rpm.
    - Aim error 0.07 rad, settling to 0.012 rad over 0.9 s.
    - At most 2 enemies shoot at once.
    - Enemies never go within 2.5 m of the player and never leave walkable cells.
    - Re-path on stuck (< 0.15 m in 0.7 s).
    - Damaged enemies flinch. Head hits are deadly.
- **Enemy shots** use `ctx.world.segmentClear` and the player capsule (`ctx.player`). They emit `playerHit` (torso 25, head 50) and `enemyShot`.
- **Draw calls:** at most 2 per enemy (body + rifle). Animate bones fully when within 8 m and visible; otherwise at 20 Hz, round-robin.

## Game, audio, HUD (builder G): `src/game/`, `src/audio/`, `src/ui/WristHud.js`

- `src/audio/AudioEngine.js`:
    - `unlock()` is called inside the Enter click.
    - `async decodeAll(assets.sounds)` runs before Enter.
    - `play(key, x,y,z, gain=1, rate=1)` picks a random variant and returns a voice id.
    - `playUI(key)`.
    - Pools: 24 voices, 8 HRTF `PannerNode`s created at unlock, equal-power panning beyond that.
    - The listener is updated from `ctx.camera` each frame.
    - No decode or allocation per play. Reuse source nodes where possible; creating an `AudioBufferSourceNode` per play is acceptable (the browser requires it), but nothing else.
- `src/game/Player.js`: the `Player` object updated from the camera.
- `src/game/GameSession.js`: survival waves.
    - Wave n has 2 + n enemies, at most 4 alive at once; spawns come from `world.findSpawn`.
    - 5 s break between waves, which heals 25.
    - Player health 100. On death, a `roundOver` card appears. **Y** = restart.
    - **Safe zone:** centred where the player stood at the start, r = 0.8 m.
        - A floor ring shows near the edge.
        - The head beyond r gives a full pause ("Return to your spot"). Resume after 0.5 s back inside, then a 3-2-1 countdown.
    - Visibility blur also pauses.
    - **Exit** is in the wrist menu or by holding **Y** for 2 s. Both grips are needed for the AKM, so they are not an exit in play.
    - Damage feedback: a red view tint of at most 0.3 opacity for at most 0.3 s, plus a hit sound and a haptic.
- `src/ui/WristHud.js`: a small canvas panel on the left wrist (taken from the left grip pose).
    - Shows wave, health, kills and an ammo line (toggle, default on for the test).
    - Redraws only on change, at most 2 per second.
    - Also floating messages: "Get ready", "Wave 2", "Round over — Y to restart".

## Integration (builder I)

- **`index.html`:** add `"three/addons/": "./vendor/three/addons/"` to the import map.
- **Load before Enter:**
    1. On page load, `Assets.load` runs with a progress bar.
    2. The audio is decoded.
    3. All pools are built, `compileAsync` and `initTexture` run on everything, and everything is rendered once to the default framebuffer.
    4. Only then is "Enter MR" enabled.
- **App wiring:** `App.started` for mode `play` creates the Ctx and registers the systems in the order above (`PerfMonitor` system names to match).
    - It captures the Space Setup snapshot, builds the World and starts the GameSession behind a "Get ready" panel (with one draw of the pools behind it).
    - It stores the snapshot in the session record (`rec.spaceSnapshot`), so the user's real house can be replayed on desktop later.
    - The `probe` mode stays as it is.
- **`?emulate`:** loads `tests/fixtures/house.json`. IWER has no scene data.
- **End-to-end check:** extend `tests/e2e/emulate.mjs`.
    - Play starts; enemies spawn and walk; firing with the trigger hits; reload; exit.
    - No console errors.
    - `renderer.info.programs.length` is flat after warm-up.
    - Draw calls ≤ 60 in a 4-enemy scene.
- Update FEATURES.md, ARCHITECTURE.md and the page instructions.

## Ownership

| Builder | Writes only |
|---|---|
| A (assets) | `tools/assets/**`, `assets/**`, `vendor/three/addons/**`, `src/core/Assets.js`, `tests/unit/assets*.test.js` |
| S (world) | `src/world/**`, `tests/fixtures/house.json`, `tests/unit/world*.test.js`, `tests/unit/nav*.test.js` |
| W1 (weapon core) | `src/weapons/WeaponDefs.js`, `src/weapons/WeaponInstance.js`, `src/weapons/Recoil.js`, `tests/unit/weapon*.test.js`, `tests/unit/recoil*.test.js` |
| W2 (weapon view) | `src/weapons/WeaponView.js`, `src/weapons/WeaponFX.js`, `src/weapons/WeaponSystem.js`, `src/player/**`, `tests/unit/body*.test.js`, `tests/unit/slots*.test.js` |
| E (enemies) | `src/enemies/**`, `tests/unit/enemy*.test.js` |
| G (game) | `src/game/**`, `src/audio/**`, `src/ui/WristHud.js`, `tests/unit/game*.test.js`, `tests/unit/audio*.test.js` |
| I (integration) | everything else (`src/app/**`, `src/main.js`, `index.html`, `src/core/Warmup.js`, `tests/e2e/**`, `docs/**`), plus fixes anywhere after the builders finish |
