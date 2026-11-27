# Architecture

Quest 3 mixed-reality tactical FPS. three.js r187 (`WebGLRenderer`, WebGL2) and raw WebXR, plain ES modules, no build step. The full plan is in [PLAN.md](PLAN.md); decisions are in [DECISIONS.md](DECISIONS.md); status is in [FEATURES.md](FEATURES.md).

## Rules every module follows

- **Built from scratch.** The CQC, Blackout and Scanner repos are references for tested numbers and lessons only (PLAN §14). No code is copied.
- **No guessing about the browser.** Every WebXR feature is optional and detected at runtime. A feature counts as done only when it has been verified on the Quest (FEATURES.md).
- **No hitching.**
  - No allocation in per-frame code.
  - Nothing compiles, uploads or decodes mid-play.
  - Storage is written only at session end or pause.
  - Work over 2 ms goes to a worker.
- **Pure logic stays testable.** Modules in `app/Game.js`, `xr/XRSession.js`, `xr/LiveDepth.js`, `debug/PerfMonitor.js`, `debug/Upload.js`, `util/`, `physics/` and the pure parts of `world/`, `weapons/`, `player/`, `enemies/`, `game/`, `fx/` import neither three.js nor the DOM, so `node --test` covers them.
- **The one measured exception (v0.4):** Rapier's wasm glue allocates about 0.15 KB a step and 0.03 KB per awake-body read while an item moves; with every item asleep the step returns before any Rapier call (DECISIONS).

## Runtime (v0.4)

```
index.html ── import map: three → vendor/three/three.module.js, three/addons/ → vendor/three/addons/
  └ src/main.js            boot: optional IWER (?emulate), support check, renderer, App, HomePage, Uploader, preload;
     │                     buildPools hook = decal atlas (worker) + new PlayKit (the whole game, once); physics hook;
     │                     ?emulate fixture / snapshot replay (hydrated: the recorded global mesh decoded)
     ├ core/Preload.js     before Enter: Assets.load → AudioEngine.decodeAll → buildPools → physics → warmUp
     ├ core/Warmup.js      warmUp (pre-XR compile + uploads + draw), warmXR (one XR-frame draw), assertStable
     └ app/App.js          composition root; one XR session at a time; probe-style or play sessions
        ├ app/Game.js      state machine boot → menu → entering → xr → menu (+ pause reasons)
        ├ app/Loop.js      XR frame loop; systems get (dt, t, frame, ctx); timed by PerfMonitor; dt clamp;
        │                  per-frame try/catch; LiveDepth.update + explicit clear + render
        ├ app/Play.js      PlayKit: Ctx, events, world (+ its worker), player, weapons (+ physics), enemies, game, watch,
        │                  look (built at load); per session: capture → worker build → static colliders → XR warm draw
        │                  → card → round; realign (worker) / rewarm on a reset or drift; the watch's actions
        ├ app/Settings.js  pure: URL knobs (grip fit, watch fit) and saved settings (difficulty, ammo line)
        ├ core/Renderer.js WebGL2 context (xrCompatible) + WebGLRenderer + PBR Neutral tone mapping + fixed light set
        │                  + the PMREM room environment (scene.environment; all before the warm-up, never replaced)
        ├ xr/XRSession.js  modes (play = Roam, spot, setup, probe, bounds, reduced, vr), feature lists, attach, spaceNote
        ├ xr/Input.js      controller buttons, grip + ray poses → per-hand state + press edges (allocation-free)
        ├ xr/Lifecycle.js  end, visibilitychange, reference-space reset, input changes
        ├ xr/LiveDepth.js  keeps three's depth texture on this frame's texture; depth diagnostics
        ├ xr/DepthOcclusion.js  soft-edge live-depth occlusion (opt-in, not wired)
        ├ world/           Space Setup snapshot v2 (+ the global mesh, MeshCodec), layout, shapes, nav grid, A*, spawns,
        │                  occluders (boxes + the mesh occluder + v0.4.1 door curtains), unscanned space (NAV_HIDDEN),
        │                  MeshPrep (+ floor heights from the scan) / MeshBVH / WorldStatics, Roam index, Realign;
        │                  the world worker (WorldWorker → world.worker.js → WorldBuild) and the sliced apply (WorldState)
        ├ physics/         Rapier loader, PhysicsWorld (statics in slices, fixed step, sleep, NaN guard, lost net,
        │                  release placement), PoseHistory (throw estimate), ItemRules, ItemShapes, StaticGeometry
        ├ fx/              Look: RoomLight (+ roomLight.worker), GroundShadows, Impacts (+ atlas.worker), PassthroughMatch
        ├ safety/          PauseManager, ObstacleWarnings, RoamSafety (watch cues), SafeSpot + SafetyView (spot mode)
        ├ game/            Player, survival rules, GameSession (ring, tint, messages, Roam rules, menu hooks)
        ├ weapons/, player/  WeaponSystem (both guns, slots, hands, shots, FX), GunFit (grip space), Controls (CQC map),
        │                  holster shell, gloves, mechanism, recoil, body estimate (seated)
        ├ enemies/         EnemyManager (pool, brain, procedural animation, hit capsules, muzzle flash)
        ├ audio/           AudioEngine (voice pool, HRTF, reverb, occlusion)
        ├ ui/              CanvasPanel, Watch (+ watchLogic / watchArt / watchGeometry), HomePage (WristHud: legacy)
        └ debug/           CapabilityLog, Probes, PerfMonitor, Diagnostics, Upload (Supabase), DebugDraw, TestCube, DepthView
```

### Two kinds of session

| | Probe-style (`probe`, `bounds`, `vr`) | Play (`play` = Roam, `spot`, and `reduced`, play's fallback request) |
|---|---|---|
| Systems (PerfMonitor names) | `input`, `probe`, `ui`, `render` | `input`, `world`, `player`, `weapons`, `physics`, `enemies`, `game`, `look`, `audio`, `ui`, `render` (CONTRACTS order) |
| Content | test cube, controller rays, hit-test reticle, info panel (34° left of ahead), depth picture (Y) | the game; App's opaque "Get ready" panel with the controls card until the round starts; the watch |
| Buttons | A timing run, B rate, X clear, Y depth picture, both grips exit | weapon buttons (A / X, B / Y on the gun, stick, trigger, grips); B + Y pauses and hold Y 2 s exits (free hands); the watch menu |
| Timing run | A (60 s) | starts with wave 1 (60 s) |
| Near plane | 0.05 m | 0.02 m without depth sensing (the AKM stock), 0.05 with it |
| Refresh rate | as the browser starts it (B cycles) | asks for 72 Hz at start (`probes.frameRate`) |
| Record extras | `probes.*`, `probes.liveDepth` | `spaceSnapshot` (v2, with the encoded global mesh), `play` (mode, capture, world build + report + `async` (the worker build's main-thread cost), start / spot, grip fit v2 + fit saves, watch report + actions, Roam report: speeds, cues, rooms, resets, realigns, drift, spaceNote; settings, lighting, `look`, safety report, round summary), `physicsLoad`, `physics` (build, steps, step times, items, releases, guard), `warmXR`, `systemsMs`, `audio` (context state at start, 1 s, end; gesture resumes), `view` |

### Frame order

Each XR frame runs the session's systems in order, each timed separately; `renderer.info` is reset once per frame. The Loop passes the shared Ctx (CONTRACTS "Ctx"; null in probe sessions) as the 4th argument. The `render` step runs `LiveDepth.update` (only when depth was granted), the explicit clear when depth sensing is on, then `renderer.render`.

In play, the `player` step first copies the BodyEstimator's seated decision into the Player (`seatedOverride`), then runs `player.update` and `game.preUpdate` (GameSession's pause and freeze decisions, through its PauseManager) so they come before `weapons` and `enemies`; `enemies` is stepped with dt = 0 while `game.freezeEnemies` is set. `game.update` then runs in its own step after the enemies. The `weapons` step sets `weapons.triggerBlocked` from the watch's `capture` / `menuOpen` of the previous frame. The `physics` step (v0.4, `weapons.physicsUpdate`) builds new static colliders in 4 ms slices after a world build, takes the fixed 1/90 s steps while anything is awake (none, and no Rapier call, when everything sleeps), runs the lost-object net and the landing sounds, and refreshes the lying guns' display poses. The `look` step (v0.4) runs the room light, the contact shadows and the impacts' particles. The `ui` step runs `watch.update`.

### Play session start

1. The click handler calls `requestXR` synchronously (the user gesture); `audio.unlock()` runs in the same click. During the session the XR `selectstart` / `select` / `squeeze` events (user activation) unlock the audio again whenever its context is not running.
2. When the promise resolves: the `Loop` starts **before** `setSession`, `attachSession` sets space, scale and foveation and calls `setSession`; everything after it is in one try: a start error ends the session and returns to the menu with a record.
3. `PlayKit.begin`: Ctx gets the session and space; the player resets; the capture gate resets. App asks for 72 Hz (`updateTargetFrameRate`, when offered) and sets the near plane.
4. `world` system, frame by frame:
    1. **capture:** once the Space Setup plane count has been stable for 0.5 s (or after 3 s), `captureSnapshot(frame, space, { keep })` copies planes and meshes and keeps the live XRPlanes (`?emulate`: the house fixture). Up to 3 reference planes (largest floor, two non-parallel walls) go to the DriftWatch. The snapshot goes into `rec.spaceSnapshot`.
    2. **build (v0.4):** `world.buildAsync(snapshot, head, { roam })` in the world worker, behind App's opaque "Get ready" panel (step `build`, "Reading your room…"): the layout, the nav grid, the whole Roam bake, the global mesh's prep (weld, orientation, classes, crops, tiles), its BVH, the occluder buffers and the static colliders' geometry. `world.update` copies the result in within 0.5 ms a frame, commits it in one step and streams the mesh occluder's tiles one range a frame; the record gets `play.world.async` (the worker's time, the main thread's longest world step and longest frame of the other systems). Then the card (with the controls), `look.onWorldBuilt` and `look.snap()`. In the same frame as the commit the physics system starts the static colliders (4 ms slices).
    3. **warm:** next frame, every pool is drawn once into the XR framebuffer (`warmXR`, before that frame's render, which clears and draws over it) and the baseline moves to include XR's own resources.
    4. **start:** the card stays up until a trigger pull is released (after 1 s) or 8 s (a pull that belongs to the watch does not count), and until the static colliders are built (at most 8 s more). Moving on at the release means the same pull never also confirms the spot (pickSpot runs before `game.preUpdate` in that frame).
    5. **spot:** `game.pickSpot(cb)`. Roam: the current position is confirmed on the next frame (no ring, no rebuild). Spot mode: App's panel hides; GameSession's ring follows the head (green clear, amber tight, red blocked) with a floor arrow and a message until the trigger confirms a spot (a 1 s hold for a tight one). The callback runs inside `game.preUpdate`, so PlayKit starts the round in the next frame's `world` step.
    6. **rebuild** (spot mode, only when the spot is more than 0.25 m from where the world was built): App's panel shows again and `world.buildAsync(world.snapshot, zone, { doors, force })` runs in the worker; the round starts once it is in place and the static colliders are rebuilt (the panel stays up meanwhile).
    7. **go:** `game.start(zone)`. Roam shows no text in the view (the watch shows the wave); spot mode shows "Get ready", then the waves.
    8. **play:** once a second while not paused, the DriftWatch samples the reference planes (3 `getPose` calls); drift over 0.10 m or 2° on 2 checks in a row starts a realign.
    9. **realign:** after a reference-space `reset` during the round (Lifecycle passes the event; `resetTransform(e.transform)` is old → new) or drift: the game pauses and holds (RESET), living enemies go back into the wave's queue, and `world.realignAsync(m)` rebuilds the world moved (without a transform: from a fresh capture) in the worker behind the pause. At its commit the lying guns and magazines move by the same matrix (`weapons.realignItems`); the static colliders follow; a reset or drift arriving meanwhile queues one more build. **rewarm:** once everything is in place, `look.onWorldBuilt(…, { moved: true })` (decals cleared), one `warmXR` draw, then `game.realigned()` releases the hold (resume protocol). A reset before the round (capture, build, warm, card, spot) captures again silently. `rec.play.roam.resets` / `.realigns` log both.
5. The watch's MODE row rebuilds the world in the other mode behind the card and starts over at step 3. Its other actions go to GameSession (menu = manual pause, RESUME = resume through the 3-2-1, RESTART, EXIT), EnemyManager (DIFFICULTY: the enemy preset), WeaponSystem (GUN FIT: `fitHold`, `setFit` live; SAVE writes `localStorage['cqcpt.gunfit.v1']` from a `setTimeout`) and the settings (`localStorage['cqcpt.settings.v1']`, also from a `setTimeout`).
6. Session end: `game.safetyReport()` and `game.roamReport()` (before `game.stop()`), the world report with the spawn tiers used, `weapons.fitReport()`, `watch.report()`, `look.report()` and the round summary go into `rec.play`, `weapons.physicsReport()` into `rec.physics`; the record is saved, every pool is reset and hidden, and the record is uploaded (below).

Gun fit: WeaponSystem holds the guns in grip space (GunFit). At load PlayKit applies the saved fits (`weapons.loadFits(localStorage['cqcpt.gunfit.v1'])`), then the URL escape hatch (`?gripPitch=<deg>&gripY=<m>&gripZ=<m>`, as `adjFromUrl`, never saved), and gives the effective values to the watch's GUN FIT page. `rec.play.grip` is `weapons.fitReport()` (fitVersion 2, source, edits, per gun pose, the session mean of the learned grip → ray rotation).

Diagnostics: **Copy** takes only the last session (plus app, version, ua, support, preload, pageErrors), compact and without the encoded global mesh, so it can be pasted into a chat; **Download** and **Share** take every kept session. The page shows both sizes.

### Automatic diagnostics upload (v0.4, `src/debug/Upload.js`)

The user's Supabase project `cqc-pass-through` (https://ysxcottwabhpajhcnbqr.supabase.co), table `public.diagnostics`:

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | |
| `created_at` | timestamptz | `now()` |
| `app` | text | `'cqc-pass-through'` (the RLS check) |
| `version` | text | `src/version.js` |
| `kind` | text | `'session'`, `'copy'` (`'test'`: the integration test row) |
| `mode` | text | the session's mode (`play`, `spot`, `probe`, …) |
| `device` | text | a short user agent ("Quest 3 · OculusBrowser 37.0 · Chrome 157") |
| `payload` | jsonb | the compact last session with the encoded global mesh (`Diagnostics.lastPayload`); check `octet_length(payload::text) < 1500000` |

- Row Level Security: the anon role may only INSERT (policy "headset can insert", `with check (app = 'cqc-pass-through')`). The publishable key is public by design. Claude reads the rows with the Supabase MCP `execute_sql`.
- `POST /rest/v1/diagnostics` with `apikey` and `Authorization: Bearer` (the publishable key), `Content-Type: application/json`, `Prefer: return=minimal` (anon may not read the row back).
- When: after a session record is saved (App, from a `setTimeout`, never from the frame loop) and on the page's Copy press. A body of at most 64 KB goes with `keepalive`; a larger one without it (the session has ended, the page is still open); a refused keepalive request is asked again without it.
- Failure: the body waits in `localStorage['cqcpt.upload.v1']` (at most 3, 5 tries each) and goes after the next page load's preload. The page says "Sent ✓" or "Will retry".
- Size: under 1.4 MB of JSON (the mesh blob goes first, then the hitch log; at worst a stub).
- Dev builds (localhost, `?dev`) and `?emulate` never upload unless `?upload=1`; `?upload=0` turns it off.

### Shared runtime context (Ctx)

Built once by PlayKit: `renderer, scene, camera (renderer.xr.getCamera()), session, space, input, events, audio, world, assets, gfx.flashLights, player, body (weapons.body), raycast, look` (v0.4: WeaponSystem sends world hits to `look.impact`). `raycast` is the world first (walls, furniture, floor, ceiling) and then the enemies, limited to the world hit's distance; both write the hit record only on a hit. EnemyManager applies `enemyHit` itself (bound to the event bus), so WeaponSystem gets no `enemies` option.

### Preload and warm-up (before Enter)

1. `main.js` starts `preload()` (`core/Preload.js`) once the support check shows AR or VR. The page shows "Loading n%"; every session button stays disabled until the warm-up has drawn, because its default-framebuffer draw must not overlap XR.
2. `Assets.load` (70 % of the bar), then `AudioEngine.decodeAll` (10 %; the context stays suspended until `audio.unlock()` inside the Enter click), then the `buildPools` hook: the decal atlas (drawn in a worker), then `new PlayKit(...)` builds the world (and runs `world.warmUp()`; the world worker is started and warms its own JIT), the player, WeaponSystem (both guns with their gloves, the holster shell, FX pools, the loose-magazine pools), EnemyManager (6 prebuilt soldiers; cloth `envMapIntensity` 0.35), GameSession, the Watch (and its synthesised tick / alert sounds), and the Look (shadow, decal and puff pools; `prepareMaterials` puts the passthrough-match hook on every opaque lit material; `warmUp` warms its frame and shot code); `setWarm(true)` shows every pool. Then the `physics` hook (5 %): Rapier's import and init, the item kinds, the contact warm-up (`?physics=off` skips it). `scene.environment` (the PMREM room) and the tone mapping already exist from `createRenderer`, so every material compiles with them. Then `warmUp` (15 %), then `setWarm(false)`.
3. `warmUp(renderer, scenes, objects)`: orphans are attached to the main scene (its fixed light set is part of every program key) and `setColorAt(0, white)` primes instanced pools; `compile` per scene (`compileAsync` only when `KHR_parallel_shader_compile` exists, which the Quest lacks); `initTexture` per texture, one per frame and ≥ 30 ms apart; one `render` per scene to the default framebuffer with every drawable, ancestor and LOD level forced visible and culling off; then every flag is restored and the orphans detached. The program, texture and geometry counts become the baseline.
4. Enter MR is enabled only when this succeeded. On failure the page shows the error and keeps the probe sessions usable.
5. The result is `preloaded` (exported by `core/Preload.js`, also `window.__app.preload`): `assets`, `audio`, `warm` (the baseline), `warmed` (the objects drawn), and a summary in the diagnostics JSON (`preload`).
6. Dev builds call `assertStable` once a second during play (after the XR warm draw) and record any growth in `rec.warmGrowth`.

### Live depth (probe sessions; play with the future "Dynamic occlusion" setting)

three r187 draws its occlusion pass (a full-screen quad writing `gl_FragDepth`) when `depth-sensing` is granted with `gpu-optimized` usage and `getDepthInformation` returns a valid texture. It wraps that texture ONCE, on the first valid frame. `LiveDepth` wraps the binding's `getDepthInformation` at session start, sees the depth information three asks for in its own frame setup, and before each render points three's ExternalTexture at this frame's texture (`sourceTexture`; nothing compiles or uploads). It also turns off the quad's colour writes (its shader never writes a colour). It counts valid frames and texture changes for the probe panel and `rec.probes.liveDepth`. The probe's depth picture (`debug/DepthView.js`, warmed at load) draws the same texture as a colour ramp.

### Known three.js r187 behaviours we design around (verified in source)

- With GPU depth sensing granted, three skips `background.render()`, so it clears nothing. `Loop` clears explicitly, and the probe can switch this off to see what the browser does.
- `setReferenceSpaceType` and `setFramebufferScaleFactor` only take effect before `setSession`.
- `getFoveation()` returns three's own cached value. The capability log reads the layer instead.
- `setAnimationLoop` while presenting also starts the window rAF loop, hence the start order above.
- three dispatches a `planesdetected` event object every frame when `frame.detectedPlanes` exists. This is a small amount of garbage inside three.
- `WebXRDepthSensing.init` wraps the first valid depth texture once and never refreshes it (the camera-access path does refresh); its quad's fragment shader writes no colour. See "Live depth".
- The depth quad's `ShaderMaterial` and `PlaneGeometry` are created lazily on the first depth frame, so a probe session compiles one program then (play sessions have no depth). `reset()` at session end drops them without `dispose()`, so the geometry count grows by one per depth session.

## Hosting and testing

- **Production:** a Render static site from `main` (`render.yaml`). It sends `Cache-Control: no-cache` and `Permissions-Policy: xr-spatial-tracking=(self)`. The origin must never change, because rooms and anchors belong to it.
- **Desktop:**
    - `npm test` runs the Node unit tests.
    - `NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs` runs Playwright with IWER: preload (physics, look, the world worker), probe (with fake per-frame depth), a Roam play round (unbounded requested, the worker build, card, start where you stand, spawns in another room, draw, fire, hit, reload, the watch: wake, ray + trigger menu, RESTART, AMMO LINE saved, GUN FIT nudge saved and reloaded; v0.4 physics: the Glock laid on the fixture table, dropped on the bed, thrown at a wall, picked up again, no stepping at rest; gloves while held, AKM fire mode and material impacts, a 1.5 m/s run cue without a pause, a reset with a transform and its realign), the upload (stubbed: the row, the failure → retry on reload, Copy), diagnostics Copy, VR, the reduced retry (Roam rules on local-floor, the boundary note), a one-spot round (with a moved spot and the rebuild, then the watch's MODE row back to Roam), a virtual room, a grip-fit page and a failed load. It prints the play session's CPU per frame and draw calls.
    - `NODE_PATH=$(npm root -g) node tests/e2e/replay-house.mjs [--shots <dir>]` (v0.4.1, also run at the end of `emulate.mjs`) replays the user's real house (`tests/fixtures/house-v04-device.json`, the v0.4 headset session's snapshot with its global mesh) through the real World. It sweeps occlusion from the recorded viewpoints (no enemy pixels through real walls or in unscanned space), checks that spawn candidates come only from right behind doors, and checks that the soldiers' drawn heights and feet sit on the floor.
    - `NODE_PATH=$(npm root -g) node tests/e2e/depth-occlusion.mjs` checks the soft-occlusion shaders on the GPU path.
    - `node tools/serve.mjs` then `http://localhost:8080/?emulate` runs the page in the emulator (the house fixture). `?emulate&snapshot=<url>` plays in a saved snapshot or a diagnostics export (your real house); `?emulate&replay` uses the newest snapshot in this browser's diagnostics.
- **Headset:** open the Render URL in the Quest Browser and follow the on-page tests. Then copy the diagnostics JSON into the chat.
