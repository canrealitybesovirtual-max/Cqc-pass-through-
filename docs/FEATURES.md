# Feature checklist

Each item moves through four statuses: **planned → implemented → desktop-tested → device-verified**. Anything that depends on a LIKELY or UNRELIABLE browser API is not done until it is device-verified on the Quest 3. Phases are defined in [PLAN.md](PLAN.md) §12.

## Phase 1: setup, architecture, renderer, basic session

| Item | Status | Notes |
|---|---|---|
| `index.html` + import map + vendored three r187 | desktop-tested | No build step |
| App state machine (`Game`) | desktop-tested | Node tests |
| Frame loop with per-system timing, dt clamp, try/catch | desktop-tested | IWER e2e |
| Session modes: play, probe, bounds, reduced, vr | desktop-tested | IWER e2e; device test pending |
| Session mode: setup | implemented | Used from Phase 3 (mapping) |
| Reference-space fallback to `local-floor` | desktop-tested | Node test with fake session |
| "Tap again (reduced features)" after a rejection | desktop-tested | IWER e2e |
| `immersive-vr` test scene | desktop-tested | IWER e2e |
| Capability log (features, blend, rates, layer, foveation read-back, GL extensions) | desktop-tested | Device values pending |
| Probe: Space Setup planes and meshes summary | implemented | IWER has no scene data; device test pending |
| Probe: anchor creation in the active space | desktop-tested | Device test pending (both spaces) |
| Probe: hit-test inside vs outside the Space Setup room | implemented | Device test pending |
| Probe: depth information (size, near, alignment matrix) | implemented | Device test pending |
| Probe: light estimation, body tracking | implemented | Device test pending |
| Probe: bounded-floor geometry over 20 s | implemented | Device test pending |
| Explicit clear with depth on (toggle X, probe) | desktop-tested | Device check: background stays transparent. three's depth quad no longer writes colour (v0.2), so clear off now shows what the browser does |
| Frame-rate switch (B, probe) | desktop-tested | Device rates pending. In play B is the slide release |
| 60 s timing run with the Phase 1 gate (A, probe) | desktop-tested | Device runs at 72 and 90 Hz pending. In play the run starts with wave 1 |
| PerfMonitor: rings, histograms, hitch log, cancelled runs | desktop-tested | Node tests incl. a heap-growth check |
| Long-task observer | implemented | |
| Lifecycle: end, visibility pause, reset logging | desktop-tested | IWER e2e (blur) |
| Exit by holding both grips for 1 s (probe sessions) | desktop-tested | IWER e2e. Play exits by holding Y (the AKM needs both grips) |
| In-headset text panel (redraw on change, no mipmaps, tag-along) | desktop-tested | Legibility on device pending |
| Diagnostics: localStorage at session end; copy / download / share | desktop-tested | |
| Diagnostics Copy = the last session only (plus app, version, ua, support, preload, pageErrors), compact; Download / Share keep every session; both sizes on the page and in the Copy message (v0.2.1) | desktop-tested | IWER e2e: after a probe and a play session, Copy 80 KB vs all 238 KB |
| Render static site (`render.yaml`) | implemented | |
| ARCHITECTURE.md, FEATURES.md, DECISIONS.md, DEVICE_LOG.md | implemented | |

## Test slice (v0.2): first playable

Desktop means headless Chromium with SwiftShader and Meta's IWER emulator (`NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs`), plus `npm test`. Nothing in this section has run on the Quest yet.

### Load and warm-up

| Item | Status | Notes |
|---|---|---|
| Import map `three/addons/` → `vendor/three/addons/` | desktop-tested | IWER e2e loads the GLTF, KTX2 and meshopt add-ons and SkeletonUtils |
| Preload before Enter: assets, audio decode, the whole game built, warm-up, with "Loading n%" | desktop-tested | IWER e2e: reaches 100 %; every session button disabled while loading; Enter MR enabled only after the warm-up draw. Device load time pending |
| The game built once at load (`src/app/Play.js`): world + occluder, player, both guns + FX pools, 6-soldier pool, game session, wrist HUD | desktop-tested | IWER e2e: every pool is in the warm-up draw, then hidden again |
| Load failure: error shown, Enter MR off, probe sessions usable | desktop-tested | IWER e2e with a missing model |
| `warmUp`: compile, one upload per frame ≥ 30 ms apart, forced-visible default-framebuffer draw, flags restored, baseline | desktop-tested | 19 programs, 25 textures, 25 geometries, 42 drawables in IWER at v0.2.1 (the count moves as modules add meshes); the world's occluder and dev overlay both come from `world.warmMeshes()` |
| `warmXR`: one draw of every pool inside the first XR frames of a play session, behind the opaque "Get ready" panel | desktop-tested | IWER e2e: 41 drawables, 0 new programs |
| Programs, textures and geometries flat through a play round | desktop-tested | IWER e2e (draw, fire, hits, reload, AKM burst, 4 enemies). Dev builds check once a second and record growth in `rec.warmGrowth`. Device check pending |

### Play session

| Item | Status | Notes |
|---|---|---|
| Ctx and systems in the contract order (input → world → player → weapons → enemies → game → audio → ui → render), PerfMonitor names to match | desktop-tested | IWER e2e |
| Space Setup capture once (plane count stable 0.5 s, or 3 s) → `captureSnapshot` → `rec.spaceSnapshot` | implemented | Capture code Node-tested by the world builder; IWER has no scene data, so `?emulate` plays in `tests/fixtures/house.json`. Device test pending |
| World build at session start (walls, doors, furniture boxes, nav grid, spawns, depth-only occluder) behind "Get ready" | desktop-tested | Fixture house in IWER (5 ms build on desktop). Real-house build time on Quest pending. `rec.play.world.report` lists what was built |
| Desktop replay of a captured house: `?emulate&snapshot=<url>` (a snapshot or a diagnostics export) or `?emulate&replay` | implemented | Not in the e2e |
| GameSession's pause and freeze decisions before weapons and enemies (`game.preUpdate` in the player step; enemies stepped with dt = 0 while `freezeEnemies`) | desktop-tested | IWER e2e |
| "Get ready" card with the controls (Glock, AKM, fire, selector, reload, rack, slide release, pause, exit) on App's panel; stays up until a trigger pull is released (after 1 s) or 8 s (v0.2.1); that pull never also confirms the spot | desktop-tested | IWER e2e. Legibility (10 lines on a 0.56 m panel at 0.8 m) on device pending |
| Safe-spot step before the round (`game.pickSpot`): ring follows the head, green / amber / red, floor arrow, "Step … m"; trigger confirms (1 s hold when tight); App's panel hidden meanwhile (v0.2.1) | desktop-tested | IWER e2e: the fixture's start point is blocked, the step suggestion leads to a tight spot, the hold confirms it, the round starts there. `rec.play.spot`, `rec.play.safety.spot` |
| World rebuilt around a spot more than 0.25 m from where it was built, behind the "Get ready" panel (v0.2.1) | desktop-tested | IWER e2e (reduced): 0.51 m move, 2 ms rebuild on desktop, no new programs, textures or geometries; `rec.play.world.rebuild`. Quest build time pending |
| `rec.play.safety` (pauses, violations, obstacle warnings, spot report) at session end (v0.2.1) | desktop-tested | IWER e2e |
| Survival waves, safe zone ring and pause, B + Y pause, Y restart, hold Y 2 s to exit, wrist-X exit | desktop-tested | Rules and session in Node tests (builder G); e2e: wave 1 starts, exit by holding Y |
| Enemies spawn out of view, walk in through doors, shoot (playerHit), die | desktop-tested | IWER e2e and Node tests (builder E). Difficulty is untuned for the headset: they hit a standing player with nearly every round |
| Glock: draw from the right hip, trigger fires, hit an enemy, A magazine drop, A again = assisted reload, let go at the hip to holster | desktop-tested | IWER e2e drives the real controllers |
| AKM: take from over the right shoulder, selector (stick click), full-auto burst | desktop-tested | IWER e2e |
| Pouch reload (left hip), rack, slide release, two-handed AKM, Glock cup | desktop-tested | W2's Node tests with the real Input and WeaponSystem; not in the e2e |
| Combined `ctx.raycast` (world, then enemies up to the world hit) | desktop-tested | e2e: shots hit enemies and walls |
| Audio: decode before Enter, unlock in the Enter click, positional shots, enemy shots, hits | desktop-tested | Headless Chromium (builder G); levels by ear pending |
| Audio: unlock again from the XR `selectstart` / `select` / `squeeze` events when the context is not running; context state logged at start, 1 s and end (`rec.audio`) (v0.2.1) | desktop-tested | IWER e2e: a suspended context runs again after a trigger pull (first event `selectstart`). Whether the Quest Browser treats XR input events as user activation for audio is unverified |
| Wrist HUD (wave, health, kills, ammo) | desktop-tested | IWER e2e: shown on the left grip. Legibility on device pending |
| Wrist HUD fire mode (SAFE / SEMI / AUTO) on the ammo line (v0.2.1) | desktop-tested | IWER e2e: SEMI after taking the AKM (it is issued on semi now), then SAFE and AUTO after stick clicks. The mode comes from `weapons.ammo().mode` |
| Play asks for 72 Hz at start (`updateTargetFrameRate(72)` when offered); request result, offered rates, measured rate and the rate at the end in `rec.probes.frameRate` (v0.2.1) | desktop-tested | IWER accepts it. Device pending (the AR default is 90 Hz) |
| Camera near plane 0.02 m in play without depth sensing (0.05 with depth and in probe sessions) (v0.2.1) | desktop-tested | e2e: three's XR camera near = 0.02. Device check pending: the AKM stock should no longer clip through the face |
| Grip fit escape hatch: `?gripPitch=<deg>&gripY=<m>&gripZ=<m>` on both guns, clamped ±30° / ±0.08 m, effective values in `rec.play.grip` (v0.2.1) | desktop-tested | e2e page with `gripPitch=10&gripY=0.01&gripZ=-0.02`: both guns pitched 10° about the palm point, palm points moved. Applied at the PlayKit level (WeaponView's FIT is frozen): the holstered gun shifts by the same Y / Z. No in-headset adjustment yet |
| 60 s timing run starts with wave 1 (replaces the Phase 1 A button, now a weapon button) | implemented | Result in `rec.perfRuns` |
| Draw calls with 4 enemies in view | desktop-tested | 34 per frame for both eyes (17 per eye) in IWER; contract limit 60 |
| CPU per frame | desktop-tested | 1.7–2.2 ms average on desktop for the whole frame callback (render 1.2, enemies 0.4–0.6, weapons 0.2–0.3); Quest numbers come from `rec.perfRuns` and `rec.systemsMs` |
| First-person second pass (`fpScene`) for depth sessions | planned | Play has depth sensing off (DECISIONS), so the gun is drawn in the main scene |
| "Dynamic occlusion" setting for play (`cfg.depth`) | planned | |
| Page: short "How to play" (safe spot, draw, fire, selector, reload, rack, slide release, pause, exit, grip-fit URL) and a small "Probe tools" section (v0.2.1) | implemented | |

### Live depth and the probe cube ("Hand does not cover the cube")

| Item | Status | Notes |
|---|---|---|
| Keep three's depth texture current every frame (`src/xr/LiveDepth.js`) | desktop-tested, device test pending | three r187 wraps the first frame's depth texture once. With a browser that hands out a new texture per frame, the depth froze at session start, so a hand moved in later never hid the cube. IWER e2e with fake per-frame textures: with the refresh a hand at 0.4 m hides the cube and the cube shows again when it moves away; without it (three as shipped) the hand "stays". Whether the Quest hands out per-frame textures is answered by the probe's Depth line and `rec.probes.liveDepth.textureChanges` |
| three's depth quad writes depth only (`colorWrite` off) | desktop-tested | Its shader never writes a colour, so with colour writes on every pixel got an undefined colour |
| Probe: live Depth line (texture size, three pass on/off, texture per frame), `rec.probes.liveDepth` | desktop-tested | |
| Probe: depth picture on Y (colour by distance, left eye) | desktop-tested, device test pending | Shows whether the sensor's depth contains your hand at all |
| Probe panel 34° left of straight ahead (it used to sit between the eyes and the cube) | desktop-tested | e2e: the eye-to-cube line misses the panel |
| Probe panel hides while you walk (> 0.35 m/s) in roaming sessions | implemented | |
| "Hands only" line when controllers are put down | implemented | |
| Cube and panel re-placed after a reference-space reset; no placement from the previous session's pose | implemented | |

### Soft live-depth occlusion (PLAN §5 mode C, opt-in, not wired)

| Item | Status | Notes |
|---|---|---|
| `src/xr/DepthOcclusion.js`: `applySoftOcclusion(material)` patch (MeshBasic, MeshStandard/Physical, ShaderMaterial via `softocc_*` chunks), 5–10 cm fade or Bayer dither, 1-tap or 4-tap PCF, per-material bias | implemented, device test pending | Desktop: `npm test` and `NODE_PATH=$(npm root -g) node tests/e2e/depth-occlusion.mjs`. Reads the same ExternalTexture that LiveDepth keeps current |
| `DepthOcclusion` controller | implemented, device test pending | Not wired in App |

### Robustness (Phase 1 review follow-ups)

| Item | Status | Notes |
|---|---|---|
| Depth attributes read only through a try (Chromium throws without the feature) | desktop-tested | LiveDepth: Node test with a throwing getter; CapabilityLog: same guard, not unit-tested |
| Everything after `attachSession` guarded: a start error ends the session and returns to the menu with a record | implemented | |
| Console errors and page errors kept in the diagnostics across reloads | implemented | |

## Later phases

These items are planned, as in PLAN §12.

- **Phase 2:** passthrough and controllers
- **Phase 3:** mapping
- **Phase 4:** room database
- **Phase 5:** player, holster and pistol
- **Phase 6:** enemies and navigation
- **Phase 7:** gameplay and audio
- **Phase 8:** optimisation
