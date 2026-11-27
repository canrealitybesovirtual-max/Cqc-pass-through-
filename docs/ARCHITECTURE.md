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
- **Pure logic stays testable.** Modules in `app/Game.js`, `xr/XRSession.js`, `xr/LiveDepth.js`, `debug/PerfMonitor.js`, `util/` and the pure parts of `world/`, `weapons/`, `player/`, `enemies/`, `game/` import neither three.js nor the DOM, so `node --test` covers them.

## Runtime (v0.2)

```
index.html ── import map: three → vendor/three/three.module.js, three/addons/ → vendor/three/addons/
  └ src/main.js            boot: optional IWER (?emulate), support check, renderer, App, HomePage, preload;
     │                     buildPools hook = new PlayKit (the whole game, once); ?emulate fixture / snapshot replay
     ├ core/Preload.js     before Enter: Assets.load → AudioEngine.decodeAll → buildPools → warmUp
     ├ core/Warmup.js      warmUp (pre-XR compile + uploads + draw), warmXR (one XR-frame draw), assertStable
     └ app/App.js          composition root; one XR session at a time; probe-style or play sessions
        ├ app/Game.js      state machine boot → menu → entering → xr → menu (+ pause reasons)
        ├ app/Loop.js      XR frame loop; systems get (dt, t, frame, ctx); timed by PerfMonitor; dt clamp;
        │                  per-frame try/catch; LiveDepth.update + explicit clear + render
        ├ app/Play.js      PlayKit: Ctx, events, world, player, weapons, enemies, game, HUD (built at load);
        │                  per session: capture → build → XR warm draw → round
        ├ core/Renderer.js WebGL2 context (xrCompatible) + WebGLRenderer + fixed light set
        ├ xr/XRSession.js  modes (play, setup, probe, bounds, reduced, vr), feature lists, attach
        ├ xr/Input.js      controller buttons, grip + ray poses → per-hand state + press edges (allocation-free)
        ├ xr/Lifecycle.js  end, visibilitychange, reference-space reset, input changes
        ├ xr/LiveDepth.js  keeps three's depth texture on this frame's texture; depth diagnostics
        ├ xr/DepthOcclusion.js  soft-edge live-depth occlusion (opt-in, not wired)
        ├ world/           Space Setup snapshot, layout, analytic shapes, nav grid, A*, spawns, occluder
        ├ game/            Player, survival rules, GameSession (ring, tint, messages)
        ├ weapons/, player/  WeaponSystem (both guns, slots, hands, shots, FX), mechanism, recoil, body estimate
        ├ enemies/         EnemyManager (pool, brain, procedural animation, hit capsules, muzzle flash)
        ├ audio/           AudioEngine (voice pool, HRTF, reverb, occlusion)
        ├ ui/              CanvasPanel, WristHud, HomePage
        └ debug/           CapabilityLog, Probes, PerfMonitor, Diagnostics, DebugDraw, TestCube, DepthView
```

### Two kinds of session

| | Probe-style (`probe`, `bounds`, `vr`) | Play (`play`, and `reduced`, its fallback request) |
|---|---|---|
| Systems (PerfMonitor names) | `input`, `probe`, `ui`, `render` | `input`, `world`, `player`, `weapons`, `enemies`, `game`, `audio`, `ui`, `render` (CONTRACTS order) |
| Content | test cube, controller rays, hit-test reticle, info panel (34° left of ahead), depth picture (Y) | the game; App's opaque "Get ready" panel with the controls card until the spot step |
| Buttons | A timing run, B rate, X clear, Y depth picture, both grips exit | weapon buttons (A, B, stick, trigger, grips); B + Y pauses; hold Y 2 s or wrist X 1 s exits |
| Timing run | A (60 s) | starts with wave 1 (60 s) |
| Near plane | 0.05 m | 0.02 m without depth sensing (the AKM stock), 0.05 with it |
| Refresh rate | as the browser starts it (B cycles) | asks for 72 Hz at start (`probes.frameRate`) |
| Record extras | `probes.*`, `probes.liveDepth` | `spaceSnapshot`, `play` (capture, world build + report, spot, grip fit, safety report, round summary), `warmXR`, `systemsMs`, `audio` (context state at start, 1 s, end; gesture resumes), `view` |

### Frame order

Each XR frame runs the session's systems in order, each timed separately; `renderer.info` is reset once per frame. The Loop passes the shared Ctx (CONTRACTS "Ctx"; null in probe sessions) as the 4th argument. The `render` step runs `LiveDepth.update` (only when depth was granted), the explicit clear when depth sensing is on, then `renderer.render`.

In play, the `player` step also runs `game.preUpdate` (GameSession's pause and freeze decisions, through its PauseManager) so they come before `weapons` and `enemies`; `enemies` is stepped with dt = 0 while `game.freezeEnemies` is set. `game.update` then runs in its own step after the enemies.

### Play session start

1. The click handler calls `requestXR` synchronously (the user gesture); `audio.unlock()` runs in the same click. During the session the XR `selectstart` / `select` / `squeeze` events (user activation) unlock the audio again whenever its context is not running.
2. When the promise resolves: the `Loop` starts **before** `setSession`, `attachSession` sets space, scale and foveation and calls `setSession`; everything after it is in one try: a start error ends the session and returns to the menu with a record.
3. `PlayKit.begin`: Ctx gets the session and space; the player resets; the capture gate resets. App asks for 72 Hz (`updateTargetFrameRate`, when offered) and sets the near plane.
4. `world` system, frame by frame:
    1. **capture:** once the Space Setup plane count has been stable for 0.5 s (or after 3 s), `captureSnapshot(frame, space)` copies planes and meshes (`?emulate`: the house fixture). The snapshot goes into `rec.spaceSnapshot`.
    2. **build:** `world.build(snapshot, head)` once, synchronously, behind App's opaque "Get ready" panel (which carries the controls card).
    3. **warm:** next frame, every pool is drawn once into the XR framebuffer (`warmXR`, before that frame's render, which clears and draws over it) and the baseline moves to include XR's own resources.
    4. **start:** the card stays up until a trigger pull is released (after 1 s) or 8 s. Moving on at the release means the same pull never also confirms the spot (pickSpot runs before `game.preUpdate` in that frame).
    5. **spot:** `game.pickSpot(cb)`: App's panel hides; GameSession's ring follows the head (green clear, amber tight, red blocked) with a floor arrow and a message until the trigger confirms a spot (a 1 s hold for a tight one). The callback runs inside `game.preUpdate`, so PlayKit starts the round in the next frame's `world` step.
    6. **rebuild** (only when the spot is more than 0.25 m from where the world was built): App's panel shows again, the next frame runs `world.build(world.snapshot, zone, { doors })` and draws with the panel up (uploading the occluder's rewritten buffers).
    7. **go:** `game.start(zone)`; GameSession shows "Get ready", then the waves.
5. Session end: `game.safetyReport()` (before `game.stop()`), the world report with the spawn tiers used and the round summary go into `rec.play`, the record is saved, every pool is reset and hidden.

The grip fit escape hatch (`?gripPitch=<deg>&gripY=<m>&gripZ=<m>`) is applied once at load by PlayKit (WeaponView's `FIT` is frozen and has no hook): each view's palm point moves by −(0, y, z), and for a pitch the view's `holdPose` turns the aim-ray orientation about the gun's X axis first. The effective values are in `rec.play.grip`.

Diagnostics: **Copy** takes only the last session (plus app, version, ua, support, preload, pageErrors), compact, so it can be pasted into a chat; **Download** and **Share** take every kept session. The page shows both sizes.

### Shared runtime context (Ctx)

Built once by PlayKit: `renderer, scene, camera (renderer.xr.getCamera()), session, space, input, events, audio, world, assets, gfx.flashLights, player, raycast`. `raycast` is the world first (walls, furniture, floor, ceiling) and then the enemies, limited to the world hit's distance; both write the hit record only on a hit. EnemyManager applies `enemyHit` itself (bound to the event bus), so WeaponSystem gets no `enemies` option.

### Preload and warm-up (before Enter)

1. `main.js` starts `preload()` (`core/Preload.js`) once the support check shows AR or VR. The page shows "Loading n%"; every session button stays disabled until the warm-up has drawn, because its default-framebuffer draw must not overlap XR.
2. `Assets.load` (75 % of the bar), then `AudioEngine.decodeAll` (10 %; the context stays suspended until `audio.unlock()` inside the Enter click), then the `buildPools` hook: `new PlayKit(...)` builds the world (and runs `world.warmUp()` so the session's build runs on optimised code), the player, WeaponSystem (both guns, FX pools), EnemyManager (6 prebuilt soldiers), GameSession, WristHud; `setWarm(true)` shows every pool. Then `warmUp` (15 %), then `setWarm(false)`.
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
    - `NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs` runs Playwright with IWER: preload, probe (with fake per-frame depth), a play round (card, safe spot, draw, fire, hit, reload, AKM, wrist fire mode), diagnostics Copy, VR, the reduced retry (with a moved spot and the rebuild), a grip-fit page and a failed load. It prints the play session's CPU per frame and draw calls.
    - `NODE_PATH=$(npm root -g) node tests/e2e/depth-occlusion.mjs` checks the soft-occlusion shaders on the GPU path.
    - `node tools/serve.mjs` then `http://localhost:8080/?emulate` runs the page in the emulator (the house fixture). `?emulate&snapshot=<url>` plays in a saved snapshot or a diagnostics export (your real house); `?emulate&replay` uses the newest snapshot in this browser's diagnostics.
- **Headset:** open the Render URL in the Quest Browser and follow the on-page tests. Then copy the diagnostics JSON into the chat.
