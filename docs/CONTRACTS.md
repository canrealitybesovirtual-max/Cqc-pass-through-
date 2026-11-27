# Test-slice contracts (v0.2 "first playable")

**Goal:** a first playable test in the user's real house on Quest 3.
- The user draws the Glock from the right hip, or the AKM from over the right shoulder.
- Enemies walk in through real doorways and are hidden by real walls and furniture.
- The player shoots, reloads like a real weapon, and survives waves.
- No hitching. Realism is the priority.

Read first: `CLAUDE.md`, `docs/PLAN.md` (§5, §8–10, §14), `docs/ARCHITECTURE.md`, `docs/DEVICE_LOG.md` (real Quest facts).

**v0.3 changes to these contracts** (the user's v0.2 headset test; details in DECISIONS.md and the sections below):
- **Play is Roam** (the whole house) by default: it requests `unbounded` and uses it when granted, else `local-floor` (the Quest boundary then applies; `spaceNote`). There is no fixed safe zone. The stationary v0.2 mode is the page's second button, `spot`.
- **The Watch** (`src/ui/Watch.js`, builder U) replaces `WristHud`: status dial on the left wrist and the game's only menu. Warnings are diegetic (`watch.warn(kind, level)`: vibration + a dial icon); no head-locked panels during play.
- **Guns are held in grip space** (`src/weapons/GunFit.js`); the player's per-gun nudges are saved in `localStorage['cqcpt.gunfit.v1']`. CQC's face-button map (A / X magazine release, B / Y slide release or fire mode, on either hand that is on the gun). Gloved hands come inside the gun GLBs.
- **`scene.environment`** is a PMREM room made in `createRenderer`, before the warm-up, and never replaced.
- **Reference-space resets and drift** realign the world behind a held pause (`src/world/Realign.js`).

**v0.4 changes** (details in DECISIONS.md and the sections below):
- **Real-surface physics** (builder P, `src/physics/`, `vendor/rapier/`): Rapier 0.20.0 for dropped guns and magazines on the scanned house; its own `physics` system after `weapons`. A gun let go away from its slot lies in the world (W2 "Slots" below).
- **Snapshot v2 and the world worker** (builder S, `src/world/README.md`): the global mesh is captured, encoded in the record, prepared in the worker (BVH for bullets and sight lines, the mesh occluder, the static colliders); every session build is `buildAsync` / `realignAsync`.
- **The look** (builder L, `src/fx/`, `src/core/Renderer.js`): room light, contact shadows, impacts per real material, the passthrough colour match; its own `look` system after `game`; `ctx.look`.
- **Automatic diagnostics upload** (builder I, `src/debug/Upload.js`): the user's extra 10.

**v0.4.1 changes** (the user's house replayed; details in DECISIONS.md):
- **World:** `NAV_HIDDEN` (nav flag 2048, `nav.isHidden(x, z)`) marks unscanned space: door pockets, and rooms behind the real walls. `layout.curtains` holds the depth-only door curtains. They are drawn after the boxes in the box occluder while `world.curtainsOn`, which `world.update` sets from `ctx.player.head`. `world.report().hidden` gives `{ rooms, curtains, pocketCells }`, and `doors[].curtain` is reported too. Floor heights come from the scan where it covers them (`meshStats.floorFix`). Where floors overlap, the smallest polygon wins.
- **Enemies:** `ENEMY.heightMin` / `heightMax` (1.70 / 1.85 m). Each spawn sets `Animator.k`, `EnemyRig.setScale(k)` and `Hitbox.k`. `stats.heightMin` / `heightMax` go in the record. The Brain never sees or shoots from `NAV_HIDDEN` cells, and never picks an engagement point there, while `world.curtainsOn`.

**v0.5 changes** (details in DECISIONS.md):
- **Session steps:** CAPTURE → COPY (the capture over frames) → HOUSE (the learner opens the house) → BUILD → POST (one frame each: card, look, snap, layout) → WARM → [SCAN] → START → … `rec.play.capture.ms`, `rec.play.learn`, `rec.play.scanResult`.
- **Learner** (`src/learn/`): `new Learner({ client, tap, hits })`; `begin({ session, space, liveDepth })`, `open(snapshot)`, `update(t, frame, space, head, input, perf)` in the world step, `setScanning`, `analyzeNow`, `save(reason)`, `overlay()`, `setFrame(snapshot)` after a realign, `end()` → `rec.play.learn`. `applyScan(snapshot, overlay)` is the only way learned data reaches the world (`scanBase`, `scanWalked` on the snapshot; `normalizeSnapshot` and `transformSnapshot` keep them).
- **Depth:** play requests `depth-sensing` (App `cfg.learn`); `LiveDepth.shareWithThree` is false in play unless `cfg.depth`; DepthTap reads through `liveDepth._orig`.
- **UI:** `GlyphPanel` (same interface as CanvasPanel: `setLines`, `flush`, `follow`, `mesh`, `lines`, `shown`, `placed`) for GameSession's messages and App's play card (`app.card`); the watch's `readTexts` / `menuTexts` give the strings shown (tests).
- **PerfMonitor:** `lastCpu`, `sessionReport()`, hitch entries with `late`, `prev`, `prevCpu`, `prevInterval`, `next`, `markerAgeMs`, `exportHitches().gaps`.

## Rules for every module

- **Ownership.** Each builder writes **only its own directories** (see "Ownership" at the end). You may read anything. If you need something from another module, code against the interface in this file. Never edit another module's files.
- **Code style.** Plain ES modules, `// @ts-check`, JSDoc. three.js comes from `import * as THREE from 'three'`. Add-ons come from `'three/addons/…'`, which the import map points at `./vendor/three/addons/` (vendored by the Assets builder).
- **Units and axes.** Metres and seconds. Right-handed, +Y up.
    - World = the XR reference space (Roam: `unbounded` when granted, else `local-floor`; spot: `local-floor`). Under `unbounded` the floor is not at y = 0: read `world.floorY(x, z)`.
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
 * @property {BodyEstimator} body   // v0.3: weapons.body (holster sockets, `seated`): one seated decision for everyone
 * @property {(ox:number,oy:number,oz:number,dx:number,dy:number,dz:number,max:number,out:Hit,ignoreEnemy?:number)=>boolean} raycast  // world + enemies, nearest
 * @property {import('../src/fx/Look.js').Look|null} look   // v0.4: world hits → look.impact(hit, dx, dy, dz, weapon) when look.impactsOn
 */
```

Every system implements `update(dt, t, frame, ctx)`, where `dt` is in seconds (clamped to 0.1 s) and `t` in ms. Systems run in this order:

1. input
2. world
3. player
4. weapons
5. physics (v0.4: `weapons.physicsUpdate`)
6. enemies
7. game
8. look (v0.4: `look.update`)
9. audio
10. ui
11. render

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
    - Release within 0.24 m of the holster to holster the gun. Released anywhere else, it returns to its slot after 0.3 s (scale or teleport, never a transparency switch). *(v0.3 rule; with physics off or failed it still applies.)*
    - **v0.4 (physics on):** a gun released away from its slot lies in the world (`CARRY_FREE`): a still hand sets it down, a moving one drops or throws it (PoseHistory: least squares over 70 ms, ω × r, caps 12 m/s and 25 rad/s). The holster takes the Glock only with its muzzle within 60° of the holster's axis and no real surface within 3 cm below; the AKM sling keeps the reach-only rule. The right grip within 0.13 m of a lying gun's grip (or 0.05 m of its box) picks it up from anywhere (the 0.15 s draw blend from where it lies). Magazines dropped with A / X or let go from the left hand are physics items carrying their rounds; the left grip within 0.10 m picks one up; a magazine let go at the pouch goes back in. Only the lost-object net (10 s outside the house) returns an item to its slot (shrink, grow).
- `src/weapons/WeaponSystem.js` (the system that registers): owns both weapons.
    - Right trigger fires using `ctx.raycast` from the muzzle along the bore (the hit uses the bore at the moment the trigger breaks).
    - Hits emit `enemyHit` or world FX.
    - **A** (or **X** with the left hand on the gun) = magazine release (v0.3, CQC): the magazine leaves the well at 1.1 m/s as a pooled ballistic object.
    - **Left grip at the pouch** takes a fresh magazine in the left hand. It seats when within 3 cm laterally, aligned (dot > 0.7), and pushed in.
    - **Rack:** the left grip within 0.085 m of the rack point, pulled back past 90 %.
    - **B** (or **Y** with the left hand on the gun) = Glock slide release; AKM selector (safe → auto → semi).
    - **Right stick click** = AKM selector.
    - **Hold A 0.8 s with no magazine** = assisted reload (1.2 s) for testing (v0.3; a second tap no longer reloads).
    - v0.3: `busyLeft` / `busyRight` (Y and B + Y belong to the game only with free hands), `triggerBlocked` (the watch has the trigger), `fitHold(id|null)` (the watch's GUN FIT page), `setFit(id, {pitch, up, fwd}, source)`, `loadFits`, `fitsJSON`, `fitReport`, `setGloves`, `aimRayFor`.
    - **AKM two-handed:** while the left grip is held near `support`, the aim direction runs from the right grip to the left hand, and recoil is × 0.55.
    - **Haptics** (`hapticActuators[0].pulse`): shot 1.0 / 45 ms; slide home 0.75; magazine catch 0.28; rack 0.55.
    - **Ammo** for the watch: `weaponSystem.ammo()` returns `{ weapon, mag, chambered, mode }`.

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

## Physics (builder P, v0.4): `src/physics/`, `vendor/rapier/`

```js
const r = await weapons.initPhysics({ off })   // Preload, after the pools, before the GPU warm-up: loadRapier, attachPhysics, warmUp
weapons.physExternal = true; weapons.physicsUpdate(dt, ctx)   // the `physics` system (PlayKit)
weapons.realignItems(m)                         // at the commit of a realign build (old → new)
weapons.physicsReport()                         // rec.physics (session end; allocates)
// PhysicsWorld (pure): defineKind, warmUp, beginStatic(geo) + buildSlice(ms) → ready, step(dt), release, placeAt, gapBelow,
//   nearest (JS cache), readPose / pose / readMatrix (interpolated), state(id), landing(id), landSurf(id), transformAll(m), report
```

- The static colliders come from `world.staticGeometry()` (StaticGeometry: slabs, prisms, trimesh tiles, backstops, catch slab) whenever its identity changes, in 4 ms slices.
- Fixed 1/90 s step, interpolated, at most 3 steps a frame; nothing steps (no Rapier call) while every item sleeps; never create or remove bodies inside callbacks (removal is deferred to the next step); a NaN pose or a Rapier panic turns the physics off for the session (Guard) and the items go back to their slots.

## Look (builder L, v0.4): `src/fx/`, `src/core/Renderer.js`

```js
const atlas = await loadDecalAtlas()            // at load (a worker)
const look = new Look({ scene, hemi, sun, storage, atlas })
look.prepareMaterials(roots); look.attach({ world, physics, enemies, weapons, audio }); look.warmUp()   // before the GPU warm-up
look.warmMeshes() / look.setWarm(on)            // in every warm-up list
look.onWorldBuilt(world, snapshot, { moved }); look.snap()   // after each build (moved: after a realign)
look.update(dt, t, frame, ctx)                  // the `look` system
look.impact(hit, dx, dy, dz, weapon)            // WeaponSystem's world hits (when look.impactsOn)
look.reset(); rec.play.look = look.report()     // restart / session end
```

## Game, audio, watch (builders G / R, U): `src/game/`, `src/audio/`, `src/ui/Watch.js`

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
    - Wave n has 2 + n enemies, at most 4 alive at once; spawns come from `world.findSpawn` (Roam: `world.spawnRoamFor`, another room than the player's).
    - 5 s break between waves, which heals 25.
    - Player health 100. On death, a `roundOver` card appears. **Y** = restart.
    - **Roam (v0.3 default):** no zone. Running (≥ 0.9 m/s), the edge of the mapped floor and walls near the head are watch warnings, not pauses; tracking loss, visibility, controllers, frame gaps, B + Y, the watch menu and resets pause.
    - **Safe zone (spot mode):** centred where the player confirmed the spot (v0.2.1; v0.2: where they stood at the start), r = 0.8 m.
        - A floor ring shows near the edge.
        - The head beyond r gives a full pause ("Return to your spot"). Resume after 0.5 s back inside, then a 3-2-1 countdown.
    - Visibility blur also pauses.
    - **Exit** is in the watch menu (EXIT, two taps) or by holding **Y** for 2 s with a free left hand. Both grips are needed for the AKM, so they are not an exit in play.
    - Damage feedback: a red view tint of at most 0.3 opacity for at most 0.3 s, plus a hit sound and a haptic.
- `src/ui/Watch.js` (v0.3, replaces `WristHud`): a steel dive watch on the back of the left wrist (frame from the left target ray).
    - Dial: health, rounds + chamber, wave, AKM fire mode, one info line (a warning, the state, or the kills). Readouts redraw on change only, at most 2 per second, through the shared upload gate.
    - Wake on a wrist check; touch the dial with the right controller (or point + trigger) to open the menu: RESUME, RESTART, DIFFICULTY, MODE, GUN FIT, AMMO LINE, EXIT. `onAction(name, value)` reaches PlayKit; `capture` says when the trigger belongs to the watch.
    - `warn(kind, level)` for run, edge, obstacle, stairs, tracking (GameSession is the sink).
    - `WristHud.js` stays only for its legacy unit test; nothing in the app uses it.
- GameSession's floating messages: spot mode "Get ready", "Wave 2", "Round over — Y to restart"; Roam shows only pauses, round over and exiting.

## Integration (builder I)

- **`index.html`:** add `"three/addons/": "./vendor/three/addons/"` to the import map.
- **Load before Enter:**
    1. On page load, `Assets.load` runs with a progress bar.
    2. The audio is decoded.
    3. All pools are built, `compileAsync` and `initTexture` run on everything, and everything is rendered once to the default framebuffer.
    4. Only then is "Enter MR" enabled.
- **App wiring:** `App.started` for mode `play` creates the Ctx and registers the systems in the order above (`PerfMonitor` system names to match).
    - It captures the Space Setup snapshot, builds the World and starts the GameSession behind a "Get ready" panel (with one draw of the pools behind it).
    - v0.2.1: the panel carries a controls card; then `game.pickSpot` lets the player confirm an open spot with the trigger (the world is rebuilt around it, behind the panel, when it is more than 0.25 m from the build point), and `game.start(zone)` starts the round there.
    - v0.3: modes `play` (Roam), `spot` and `reduced` run the game. Roam: the card's trigger pull starts the round where the player stands (no spot, no rebuild); the Roam bake runs in slices (4 ms a frame behind the card, 1 ms in play). A reset during the round → REALIGN (held pause, enemies back in the queue, `world.realign`) → REWARM (one warm draw) → `game.realigned()`. The DriftWatch checks the Space Setup reference planes once a second.
    - It stores the snapshot in the session record (`rec.spaceSnapshot`), so the user's real house can be replayed on desktop later.
    - The `probe` mode stays as it is.
- **`?emulate`:** loads `tests/fixtures/house.json`. IWER has no scene data.
- **v0.4: automatic diagnostics upload** (`src/debug/Upload.js`, the `Uploader`): App sends every saved session record after it is saved (`setTimeout`, never the frame loop); the page's Copy sends the last session too (kind `copy`). The table, the headers, keepalive, the pending queue and the on/off rules are in ARCHITECTURE.md "Automatic diagnostics upload".
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
| G (game) | `src/game/**`, `src/audio/**`, `src/ui/WristHud.js` (legacy), `tests/unit/game*.test.js`, `tests/unit/audio*.test.js` |
| U (watch, v0.3) | `src/ui/Watch.js`, `src/ui/watch*.js`, `src/ui/HomePage.js`, `tests/unit/watch*.test.js` |
| R (Roam, v0.3) | `src/xr/XRSession.js`, `src/world/**` (Roam, Realign), `src/safety/**`, `src/game/**`, their tests |
| P (physics, v0.4) | `src/physics/**`, `vendor/rapier/**`, `src/weapons/LooseItems.js`, the physics parts of `src/weapons/WeaponSystem.js`, `WeaponFX.js` and `src/player/Slots.js`, `tests/unit/physics*.test.js`, `tests/unit/weapon.physics*.test.js`, `tests/unit/weapon.loose*.test.js`, `tests/unit/slots.physics*.test.js` |
| S (world, v0.4) | as above, plus the world worker (`src/world/world.worker.js`, `WorldWorker.js`, `WorldBuild.js`, `WorldState.js`) and the mesh modules |
| L (look, v0.4) | `src/fx/**`, `src/core/Renderer.js`, `tests/unit/fx*.test.js` |
| I (integration) | everything else (`src/app/**`, `src/main.js`, `index.html`, `src/core/Warmup.js`, `tests/e2e/**`, `docs/**`), plus fixes anywhere after the builders finish (v0.3: `WeaponSystem.triggerBlocked` / `fitHold`, the Spot button in `HomePage`; v0.4: `src/debug/Upload.js`, `WeaponSystem.physExternal` / `physicsUpdate` and the `ctx.look` impact branch, the upload line in `HomePage`, `Preload`'s physics stage) |
