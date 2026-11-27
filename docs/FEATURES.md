# Feature checklist

Each item moves through four statuses: **planned → implemented → desktop-tested → device-verified**. Anything that depends on a LIKELY or UNRELIABLE browser API is not done until it is device-verified on the Quest 3. Phases are defined in [PLAN.md](PLAN.md) §12.

## Phase 1: setup, architecture, renderer, basic session

| Item | Status | Notes |
|---|---|---|
| `index.html` + import map + vendored three r187 | desktop-tested | No build step |
| App state machine (`Game`) | desktop-tested | Node tests |
| Frame loop with per-system timing, dt clamp, try/catch | desktop-tested | IWER e2e |
| Session modes: play, probe, bounds, reduced, vr | desktop-tested | IWER e2e; device test pending. v0.3: play = Roam (requests `unbounded`), plus `spot` |
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
| Survival waves, safe zone ring and pause, B + Y pause, Y restart, hold Y 2 s to exit, wrist-X exit (v0.3: the wrist X is gone; the watch menu exits; the ring is spot mode only) | desktop-tested | Rules and session in Node tests (builder G); e2e: wave 1 starts, exit by holding Y |
| Enemies spawn out of view, walk in through doors, shoot (playerHit), die | desktop-tested | IWER e2e and Node tests (builder E). Difficulty is untuned for the headset: they hit a standing player with nearly every round |
| Glock: draw from the right hip, trigger fires, hit an enemy, A magazine drop, assisted reload (v0.3: hold A 0.8 s with no magazine), let go at the hip to holster | desktop-tested | IWER e2e drives the real controllers (v0.3: aimed along the bore with `weapons.aimRayFor`) |
| AKM: take from over the right shoulder, selector (stick click), full-auto burst | desktop-tested | IWER e2e |
| Pouch reload (left hip), rack, slide release, two-handed AKM, Glock cup | desktop-tested | W2's Node tests with the real Input and WeaponSystem; not in the e2e |
| Combined `ctx.raycast` (world, then enemies up to the world hit) | desktop-tested | e2e: shots hit enemies and walls |
| Audio: decode before Enter, unlock in the Enter click, positional shots, enemy shots, hits | desktop-tested | Headless Chromium (builder G); levels by ear pending |
| Audio: unlock again from the XR `selectstart` / `select` / `squeeze` events when the context is not running; context state logged at start, 1 s and end (`rec.audio`) (v0.2.1) | desktop-tested | IWER e2e: a suspended context runs again after a trigger pull (first event `selectstart`). Whether the Quest Browser treats XR input events as user activation for audio is unverified |
| Wrist HUD (wave, health, kills, ammo) (v0.3: replaced by the watch; `WristHud.js` is no longer used) | desktop-tested | IWER e2e: shown on the left grip. Legibility on device pending |
| Wrist HUD fire mode (SAFE / SEMI / AUTO) on the ammo line (v0.2.1; v0.3: on the watch's dial) | desktop-tested | IWER e2e: SEMI after taking the AKM (it is issued on semi now), then SAFE and AUTO after stick clicks. The mode comes from `weapons.ammo().mode` |
| Play asks for 72 Hz at start (`updateTargetFrameRate(72)` when offered); request result, offered rates, measured rate and the rate at the end in `rec.probes.frameRate` (v0.2.1) | desktop-tested | IWER accepts it. Device pending (the AR default is 90 Hz) |
| Camera near plane 0.02 m in play without depth sensing (0.05 with depth and in probe sessions) (v0.2.1) | desktop-tested | e2e: three's XR camera near = 0.02. Device check pending: the AKM stock should no longer clip through the face |
| Grip fit escape hatch: `?gripPitch=<deg>&gripY=<m>&gripZ=<m>` on both guns, effective values in `rec.play.grip` (v0.2.1; v0.3: applied as a gun fit over the saved one, clamped ±30° / ±0.04 m, never saved) | desktop-tested | e2e page with `gripPitch=10&gripY=0.01&gripZ=-0.02`: both guns tilted 10° in the hand, up 0.01, forward 0.02; nothing written to storage. The holstered gun no longer moves with the fit |
| 60 s timing run starts with wave 1 (replaces the Phase 1 A button, now a weapon button) | implemented | Result in `rec.perfRuns` |
| Draw calls with 4 enemies in view | desktop-tested | v0.3: 36 per frame for both eyes (18 per eye) in IWER with the watch, the holster shell and a glove, the slung AKM hidden; contract limit 60 |
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

## v0.3: whole house, the watch, gun fit (desktop only)

Desktop = headless Chromium with SwiftShader and IWER (`NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs`, 130 checks) plus `npm test`. **Nothing in this section has run on the Quest yet.** The questions for the headset are at the end.

### Whole house (Roam)

| Item | Status | Notes |
|---|---|---|
| Enter MR = Roam: requests `unbounded`, uses it when granted, else `local-floor` with "Whole-house tracking unavailable: the Quest boundary applies" on the page and in `rec.play.roam.spaceNote` (never in the headset) | desktop-tested | IWER grants `unbounded`; the reduced retry shows the note. Whether the Guardian shows, interrupts or fires `visibilitychange` under `unbounded` in the Quest Browser is unknown |
| Enter MR: one spot (`spot`): the v0.2 stationary mode, `local-floor` only, safe-spot ring, rebuild around the spot | desktop-tested | IWER e2e |
| No fixed zone: the card's trigger pull starts the round where you stand (no spot step, no ring, no rebuild); no "Get ready" / "Wave n" text in the view | desktop-tested | IWER e2e |
| World build in Roam: rooms, door graph, interior slabs centred, nav never cropped; edge and door fields baked in slices (4 ms a frame behind the card, 1 ms in play) | desktop-tested | Fixture house: 3 rooms, bake done before the round. Quest build time and bake time (estimated 3.5–5 s at 1 ms) pending |
| Spawns in another room than the player's (`world.spawnRoamFor`, time-sliced) | desktop-tested | IWER e2e: every spawn in room 3 with the player in room 2 |
| Running is a watch warning, not a pause (cue from 0.9 m/s) | desktop-tested | IWER e2e at 1.5 m/s: cue 0.95, no pause. Real walking speeds pending |
| Edge of the mapped floor, walls near the head, tracking: diegetic watch cues (vibration pattern + dial icon); enemies freeze only off the map or with the head inside a box | implemented | RoamSafety and GameSession Node tests (builder R); the edge / obstacle path is not in the e2e. Stairs cue is always 0 (no stair data) |
| Seated: one decision (BodyEstimator, eye height + stillness) for the holster (right thigh), the Player and the walking rules | implemented | Node tests (builders W, R). Kneeling still for 1.5 s also counts as seated |
| Reference-space reset during the round: held pause, enemies back in the queue, `world.realign(transform)` behind the pause, one warm draw, resume protocol; before the round: capture again | desktop-tested | IWER e2e with a synthetic transform (and its inverse): realigned in 3–9 ms on desktop, nothing compiled, the round resumes. The real event's transform on the Quest is unverified |
| Drift watch: 3 Space Setup reference planes checked once a second; over 0.10 m or 2° twice in a row realigns | implemented | DriftWatch Node tests (builder R); IWER has no planes, so the e2e cannot run it. Plane pose stability over 30 min on the Quest pending |
| `rec.play.roam`: speeds, walked metres, cues, rooms visited, spawn searches, resets, realigns, drift, mode switches, world rooms / doors, space and note | desktop-tested | IWER e2e |

### The watch (replaces the wrist HUD)

| Item | Status | Notes |
|---|---|---|
| Steel dive watch on the left wrist: health, rounds + chamber, wave, AKM fire mode, one info line; hands in real time; redraw on change ≤ 2/s through the upload gate | desktop-tested | IWER e2e: SEMI / SAFE / AUTO on the dial. Legibility at 35 cm and the wrist offset on the user's arm pending |
| Wake on a wrist check (dial toward the eyes, head looking at it) | desktop-tested | IWER e2e with a posed controller. Real wrist poses pending |
| Menu: point the right ray at the awake dial + trigger (or touch it with the controller tip); a world-placed disc; the open menu pauses the round; RESUME resumes through the 3-2-1 | desktop-tested | IWER e2e: ray + trigger opens it and no shot fires; touch-to-open is in the watch's Node tests only. While the menu is open, GameSession's pause panel stays hidden (verifier fix: "Pull the trigger to resume" sat half behind the disc); the 3-2-1 panel shows after RESUME |
| RESTART (two taps), DIFFICULTY (enemy preset, saved), MODE (rebuilds the world in the other mode, back to the card), AMMO LINE (saved), EXIT (two taps) | desktop-tested | IWER e2e: RESTART, AMMO LINE saved to `localStorage['cqcpt.settings.v1']`, MODE spot → Roam. DIFFICULTY and EXIT are wired but not driven by the e2e (the watch emits them in its Node tests) |
| The trigger belongs to the watch while pointing at it or with the menu open: no shot, no resume press, no card skip | desktop-tested | e2e (no shot) and WeaponSystem Node test (`triggerBlocked`) |
| Watch tick and alert sounds synthesised before Enter | desktop-tested | IWER e2e: both buffers exist. Levels by ear pending |
| Watch fit on the wrist: `?watchBack`, `?watchOut`, `?watchTilt`, `?watchScale`, `?bracelet=0` | implemented | Settings.js Node tests; no in-headset watch-fit page |

### Gun fit, CQC controls, gloves, lighting

| Item | Status | Notes |
|---|---|---|
| Guns held in grip space (GunFit): Glock trigger on the controller's trigger, bore 24–29° below the aim ray (intended: shots go along the bore) | desktop-tested | Node tests and IWER e2e (shots aimed with `aimRayFor` hit). How it feels in the hand pending |
| In-headset gun fit: watch → GUN FIT draws the chosen gun into the empty right hand (no squeeze needed, game paused), tilt / height / forward with − / + or the right stick, live; SAVE writes the fit per weapon (`localStorage['cqcpt.gunfit.v1']`, from a setTimeout) and logs it (`rec.play.fitSaves`); BACK reverts; after a reload the saved fit is applied | desktop-tested | IWER e2e: +2° saved, back in the holster, reloaded page starts from it (source "saved") |
| CQC face buttons: A / X magazine release, B / Y slide release or AKM fire mode on either hand that is on the gun; hold A 0.8 s with no magazine = assisted reload; Y and B + Y belong to the game only with free hands | desktop-tested | Node tests (builder W); e2e: A drop, second tap no reload, hold A reloads |
| Controls on the "Get ready" card (`CONTROLS_CARD`) and the page's How to play | desktop-tested | IWER e2e reads the card |
| Holster shell at the hip (thigh when seated), anchored by the grip centre; the slung AKM hidden | desktop-tested | Node tests; e2e draws and holsters through it. Legibility when looking down pending |
| Gloved hands inside the gun GLBs (the gun's shader hook, double-sided): right glove while held, left on the AKM handguard; `?gloves=0` | desktop-tested | IWER e2e: glove shown while the Glock (fit mode) and the AKM are held, hidden when holstered. Double-sided since the verifier pass: the pack glove is an open shell, and from the shooter's eye (behind the hand) the culled cuff read as a thin black wing over the grip; now it reads as a glove with a cuff (one more program, compiled in the warm-up: 24). No watch toggle yet; the left AKM glove sits about 4 cm above the real controller and reads as a flat hand beside the handguard from the eye |
| Gun–wall push-back (grip → muzzle ray against the world, one haptic tick) | implemented | Node test (builder W); Space Setup boxes only, no side sweep |
| PMREM room environment before the warm-up (`scene.environment`, intensity 0.55), hemisphere 0.9, sun 1.1; enemy cloth 0.35; `?env=`, `?light=` | desktop-tested | IWER e2e: set before the warm-up, programs flat through play (24 at warm-up). How it looks in passthrough pending |
| Programs, textures and geometries flat after the warm-up through a Roam round (watch menu, fit mode, gloves, realign, mode switch) | desktop-tested | IWER e2e |

### Not in this build

- The user's chosen extras **8 (home defense), 7 (room clearing)**: not built (v0.4 built 10, the automatic upload). The data side for 7 and 8 exists (rooms, door graph, exterior doors); windows are not parsed yet.
- Walkthrough pre-scan, the silent learner, IndexedDB persistence: not built. (Real-surface physics came in v0.4; the scan and the learner in v0.5.)
- A watch toggle for the gloves; a watch-fit page; the pre-scan "rooms found" on the watch.

### Ask in the headset (keep it short)

1. Enter MR: does the Quest boundary still appear when you walk into other rooms? Does the game pause there?
2. Look at your left wrist: does the watch read the right way up? Touch it with the right controller: does the menu open?
3. Watch → GUN FIT: is the slide just above your thumb? Nudge it, SAVE, reload the page: is it kept?
4. Walk briskly: does the watch buzz (no pause)?
5. Looking down: is the holster legible and the AKM gone from view?

## v0.4: real-surface physics, the scanned house in a worker, the look, automatic diagnostics (desktop only)

Desktop = headless Chromium with SwiftShader and IWER (`NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs`, 152 checks) plus `npm test` (621 tests after the verifier pass). **Nothing in this section has run on the Quest yet.** The emulator renders about 4 frames a second, and the physics takes at most 3 steps of 1/90 s a frame, so it runs in slow motion there; every number below is desktop.

### Real-surface physics (Rapier 0.20.0)

| Item | Status | Notes |
|---|---|---|
| Rapier 0.20.0 vendored (`vendor/rapier/`, Apache-2.0, npm integrity + sha256 in `VERSION.txt`), loaded before Enter with its own share of the bar | desktop-tested | e2e: import 28–103 ms, init 26–88 ms; Node test checks the hash |
| Contact warm-up at load (a scratch world: every collider pair, CCD, queries; one-sided and two-sided mesh) | desktop-tested | e2e: 0.7–0.76 s, 245 steps (max 44–47 ms in the warm-up itself); the first drop in play then steps in 0.6 ms max. Quest load time unmeasured (×4 planning factor ≈ 3 s) |
| `physics` system after `weapons`: fixed 1/90 s step, interpolated, at most 3 steps a frame; nothing steps (no Rapier call) while every item sleeps | desktop-tested | e2e: a resting table drop takes 0 steps over 2 s while the skipped-frame count grows; step p50 0.13 ms, p95 0.23–0.28 ms, max 0.6–2 ms (desktop); the system's frame average 0.07 ms |
| Static colliders from the world build: one-sided trimesh tiles (FIX_INTERNAL_EDGES at ≥ 80 % orientation votes), wall slabs, floor / ceiling prisms, backstops, a catch slab; 4 ms slices; the card, the spot round start and the realign wait for them | desktop-tested | e2e (fixture): 20 slabs, 8 prisms, 3 tiles, 1080 triangles, built in one 2.5 ms slice |
| The Glock laid on a table with a still hand settles on top and stays | desktop-tested | e2e: 1.5 cm above the fixture table's top (the gun's breech face on its side), inside the top, 0 mm movement in 2 s |
| Dropped from 0.4 m onto the bed: lands on the soft top (the collider sits 1.5 cm into it) and stays | desktop-tested | e2e on the fixture bed (synthetic scan with ±3 cm lumps): the breech face 0.3 cm above the scanned surface, 0 mm movement in 2 s. "Lies on the bed" on the real Quest mesh pending |
| A throw into a wall: CCD, no tunnelling, rests in the same room, not lost | desktop-tested | e2e: released at 9.1 m/s at the north wall (z = −3): nearest z −2.97, came to rest on the floor 0.7 m back. The emulator's 4 fps cannot produce a real 9 m/s hand (that reads as a tracking jump), so the e2e synthesises the hand's 90 Hz history; the release, the estimate, the flight and the contact are the real ones |
| Pick-up from anywhere (right grip within 0.13 m of the grip, or 0.05 m of the box): the draw blends from where it lies | desktop-tested | e2e: picked up from the table, the bed and the floor |
| Holster rule: muzzle within 60° of the holster axis and no surface within 3 cm below; elsewhere the gun lies in the world; the AKM sling keeps the reach-only rule | desktop-tested | e2e holsters with the muzzle down (a level gun let go at the hip now drops: stricter than v0.3) |
| Magazines (A / X, or let go from the left hand) are physics items with their rounds; left grip within 0.10 m picks one up; let go at the pouch goes back in; a pool of 10 per weapon, out-of-view recycling | desktop-tested (drop) / implemented (pick-up, pouch) | e2e: A drops it into the loose pool; pick-up and pouch are in P's Node tests |
| Landing sounds by surface (the magazine clatter pitched down for guns; cloth on soft surfaces) | implemented | No gun-drop recording exists |
| Contact shadows under lying items | desktop-tested | e2e: the lying gun adds an item shadow |
| Lying items move with the house on a realign (`realignItems` at the realign build's commit) | implemented | Not isolated in the e2e (the realign runs with a magazine on the floor, no check of its new pose) |
| Lost-object net (10 s outside the house returns the item), NaN guard, Rapier panic → v0.3 rules for the session | implemented | P's Node tests; never seen in the e2e (`guard` in `rec.physics`) |
| `?physics=off` (the v0.3 rules) | implemented | Not in the e2e |
| `rec.physics` (load, build, step histogram, items, the last 40 releases, guard) and `rec.physicsLoad` | desktop-tested | e2e |
| Bullets pushing lying items, ragdolls, the optional seat dent, XRPose velocity in the record | planned | |

### The scanned house (snapshot v2, the world worker)

| Item | Status | Notes |
|---|---|---|
| Snapshot v2: the Space Setup meshes' triangles copied once at capture (never in JSON); the global mesh encoded in the record (`cqc-mesh-1`, gzip, base64) | desktop-tested (fixture) | The fixture's 10,932-triangle synthetic scan: 7.8 KB of base64. Real capture: IWER has no meshes; the Quest's global mesh layout, winding and label are unverified |
| Every session build in the world worker (capture, MODE row, spot rebuild, realign); 0.5 ms apply slices, atomic commit, mesh-occluder tiles one range a frame | desktop-tested | e2e: worker 60–85 ms; the main thread's world step at most 0.3 ms during the build (it was a 57 ms synchronous build in v0.3's realigns); all other systems at most 3.4 ms a frame meanwhile |
| Mesh occluder (depth only, the box occluder's program) and the BVH in bullets and sight lines; covered furniture boxes skipped | desktop-tested | e2e: 1080 mesh triangles kept after the crops, 3 tiles; one more draw per eye (42 calls for both eyes with 4 enemies) |
| Copy leaves the encoded mesh out; Download, Share and the upload keep it | desktop-tested | e2e |
| Desktop replay of a recorded house with its mesh (`?emulate&snapshot=` / `&replay`: hydrated) | implemented | Not in the e2e |
| `?worker=0` (build on the main thread, A/B) | implemented | |

### The look

| Item | Status | Notes |
|---|---|---|
| PBR Neutral tone mapping and exposure chosen before any compile; the passthrough-match hook on every opaque lit material; its pools in the warm-up | desktop-tested | e2e: 28–29 programs at warm-up, flat through the round (10 materials matched, 6 tuned) |
| World hits → material impacts (decal from the atlas, puff, sound per real material) | desktop-tested | e2e: the AKM burst into the north wall: 1–4 plaster impacts (the rest hit enemies), 29–68 particles, nothing compiled or uploaded. Wood, fabric, metal, glass from the Space Setup labels: L's Node tests only |
| Room light (per room, by time of day and windows; manual presets saved), contact shadows under enemies and items | implemented / desktop-tested (shadows) | How it looks in passthrough pending. The watch rows (ROOM LIGHT, FLOOR) and the camera toggle are not wired (no UI yet) |
| `?tm=`, `?exposure=`, `?sat=`, `?shadows=0`, `?impacts=0`, `?match=0` | implemented | Load-time A/B switches |

### Automatic diagnostics upload (the user's extra 10)

| Item | Status | Notes |
|---|---|---|
| The last session (compact, with the encoded mesh) to the Supabase table `public.diagnostics` after each saved session and on Copy; `keepalive` up to 64 KB, without it above | desktop-tested (stubbed) | e2e with the request intercepted: the row (app, version, kind, mode, device, payload), the four headers, the probe session (54 KB), the play session (115 KB), Copy (kind `copy`). Node tests cover keepalive by size and a refused keepalive retried without it |
| A failed upload waits in localStorage (at most 3) and goes on the next page load; the page says "Sent ✓" / "Will retry" | desktop-tested | e2e: a 503 → "Will retry", one waiting; the reload sends it and clears it |
| Dev builds and `?emulate` never upload unless `?upload=1` | desktop-tested | Node tests; the e2e's other pages never send |
| The real endpoint | partly verified | The table, its RLS policy (anon INSERT only, `app = 'cqc-pass-through'`) and the row shape: one `kind: 'test'` row inserted as the anon role through the Supabase MCP (row 1). The HTTP path itself could not be tried from the build machine (its proxy refuses the host); the first headset session is the real test. Whether the Quest Browser sends keepalive requests with a CORS preflight is unverified (refused ones are re-sent without keepalive) |

### Verifier pass: hitch audit and realism (desktop, headless)

How it was measured: a scripted ?emulate session (load, Enter, the worker build, card, wave 1, a draw, a drop on the bed, a set-down on the table, a throw, the first round into each material, a kill, an A drop + pouch reload, the watch menu, two realigns) with every system's CPU per frame, every GL compile / texture upload, the JS heap per frame, long animation frames with script attribution, the CDP sampling heap profiler per phase, and a per-method timing drill-down of every slow frame. SwiftShader frames take 40–250 ms, so the frame interval (and the PerfMonitor hitch log) says nothing here; CPU outside the render × 4 (the planning factor) stands in for the Quest.

| Item | Status | Notes |
|---|---|---|
| Nothing compiles or uploads in play | desktop-tested | 0 shader compiles / links and 0 texImage calls from Enter to exit; programs 28, textures 37, geometries 47 flat; only canvas texSubImage (watch, panels) |
| A couch (any furniture whose Space Setup volume rises above its real top) holds a dropped gun on its real seat | desktop-tested (Node) | As built, the couch failed the mesh coverage rule (its seat is ~40 cm under its volume's top, the backrest), so it became a solid box: a Glock dropped on the seat rested at 0.866 m. Now covered from its scan at any height, and its backstops go under the lowest real top it owns: it rests on the seat (Rapier test). ScanSynth's flat-topped furniture hid this; the e2e fixture still cannot show it |
| No contact shadow without its body during a pause | desktop-tested | The watch menu (any pause) hid the soldiers and a dropped magazine under the safety veil but left their blobs on the floor |
| The soldiers' frame code is JIT-warmed at load (`EnemyManager.warmUp`, ~50–70 ms) | desktop-tested | First 60 frames of a soldier: 4.6 → 1.2 ms alive, 5.5 → 0.9 ms dying; 4.4 → 0.5 MB boxed in the first wave's first second |
| The bones' pose copy skips three's Euler sync (`EnemyRig.apply`) | desktop-tested | A warmed soldier's frame: 2.9 KB → 0.04 KB of garbage, about 7× faster |
| Still over budget ×4 (behind a panel or a held pause, by design) | desktop-tested | The XR warm draw (world step 4–10 ms), static collider slices (≤ 4 ms by the clock), the pause panel's first canvas redraw (game 4–7 ms) |
| Still over budget ×4 in play (not fixed) | open | GC pauses of 2–6 ms landing in whichever system runs (the residual garbage: three's uniform uploads, the XR API, Brain / BodyEstimator / Player / Recoil / Handling sites); one 13.7 ms Rapier step at the first bed contact in 1 of 3 runs (a GC in the same frame; ≤ 2.8 ms in the other two); the watch dial's first redraw in play (2.3–2.8 ms); A* steps measured at 0.6–1.5 ms against their 0.35 ms budget (the clock is only read every 64 expansions). The device record (`systemsMs`, `hitches`, `physics.running.stepMs.max`, `enemies.pathMaxStepMs`) is the real test |

### Ask in the headset (keep it short)

See DEVICE_LOG "v0.4: tests to run": lay the Glock on the bed beside you and pick it up; drop it on the bed, a table and the floor; lay the AKM on the couch; throw a magazine at a wall; holster with the muzzle down; does anything stutter while "Reading your room…" shows; does the page say "Sent ✓" after you exit?

## v0.4.1: the user's house replayed: walls, spawns, heights (desktop only)

The user's v0.4 test in their house: "it's looking fake how they spawn, see through my walls, and their height". The session record (`spaceSnapshot` v2 with the global mesh, `play.world.report`, `play.enemies`) is replayed on the desktop through the same build (`tests/fixtures/house-v04-device.json`, `tests/e2e/replay-house.mjs`, also run by `emulate.mjs`, and `tests/unit/world.house-v04.test.js`). Statuses are desktop only; the headset must confirm.

| Item | Status | Notes |
|---|---|---|
| Space behind the real walls is unscanned (`NAV_HIDDEN`) | desktop-tested | The living room's 4-point floor rectangle also covered the space behind its three doors and a closed corner behind two of its walls. v0.4 spawned 5 of 6 enemies there, in plain view through the doors, where the real house has other walls. Rule: a room whose cells see the real wall planes from behind (`scannedSideVote`) and that reaches the map's open edge |
| Door curtains: a depth-only cover on the far face of every open door into unscanned space | desktop-tested | An enemy behind the door is hidden and appears as he steps into the doorway. The curtains stand down while the head is in hidden space or leaning through a door; this is a draw-range change only (no upload, no compile) |
| Spawns come in through real doors | desktop-tested | Unscanned cells can be candidates only within 2.2 m behind a curtained door. They count as hidden while the curtains stand, and the roam search prefers them (+1.5). Replay: 0 of 186 candidates in unscanned space (v0.4: 86 of 269). From the living room, 60 of 60 searches came in through the back door; the other doors are under 5 m of path away, or unreachable (see DEVICE_LOG: the hall is closed off) |
| An enemy in unscanned space never sees, shoots or holds a point there | desktop-tested (Node) | So there is no invisible shooter behind a curtain |
| Wall corners closed in the occluder | desktop-tested | Slabs met end to end and left a 5 × 5 cm hole at each outer corner. The replay saw enemies through them: 8 leaks, up to 147 px at 192². Outer wall ends now reach 6 cm past the plane, and the mesh's wall crop reaches as far. Replay: 0 leaks |
| Occlusion sweep of the recorded house | desktop-tested | 21 viewpoints (the start, plus a grid over bedroom, hall and living room) × every place an enemy can stand, 4 views each. Through real walls: 0 px (v0.4: 601 px). In unscanned space: 0 px (v0.4: 231,193 px). Enemies in plain view are still drawn (4646/4661) |
| Depth precision (near 0.02 m, far 50 m) | checked | 24-bit depth gives under 0.5 mm at 12 m, and an enemy is at least 0.28 m behind a slab. Not a cause. The near plane is unchanged |
| Floor heights from the scan | desktop-tested | The bedroom scan's floor plane (−1.585) sat 6.7 cm under its own hall's scanned floor (−1.518, 2.7 m² of mesh). A floor plane with ≥ 1 m² of scanned floor inside it now moves to that floor (`MeshPrep.calibrateFloors`, noted in the record). Where floor polygons overlap, the smallest wins: v0.4 put half the bedroom on the living room's height, so an enemy rose 7.5 cm mid-room |
| Soldier height 1.70–1.85 m (helmet included), random per spawn | desktop-tested | The model is 1.868 m. Uniform scale about the root: the animator's world ↔ model conversions, the rig, the muzzle and the hit capsules all follow (head shots hit the drawn head). Feet stay planted (< 2 cm slide) and on the floor under him (replay: skinned vertices within 2 cm of the floor). `play.enemies.heightMin/heightMax` |

### Ask in the headset (keep it short)

See DEVICE_LOG "v0.4.1: tests to run".

## v0.5: zero-hitch pass, the walkthrough scan, the house learner (desktop only)

Desktop = headless Chromium with SwiftShader and IWER (`NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs`, 164 checks) plus `npm test` (658 tests). **Nothing in this section has run on the Quest yet.** IWER has no hit-test environment and no real depth: the e2e feeds the depth tap a fake constant-depth texture (the pipeline runs end to end; the geometry is tested in Node), and hit-test sources fail there ("Synthetic Environment Module required").

### Hitch fixes from the v0.4 device record

| Item | Status | Notes |
|---|---|---|
| Hitch entries carry the previous frame (CPU, interval, per-system split), the callback lateness, the next interval, the marker with its age (markers name hitches for 0.5 s); skipped intervals are logged gaps; `rec.perf`: the whole-session interval / CPU histograms, percentiles, per-system averages and peaks, lateness | desktop-tested | PerfMonitor Node tests (incl. allocation-free with a hitch every 50 frames); e2e: `rec.perf` and the hitch log in the saved session |
| Programs / textures / geometries checked once a second in every build; a growth → hitch marker + `rec.growth` | desktop-tested | e2e: flat through the round (32 / 38 / 52) |
| Zero texture uploads in play: the watch dial and menu, GameSession's messages and the play card draw from one glyph atlas uploaded at load (GlyphBoard: instanced quads, one shared program) | desktop-tested | e2e: **0** texture uploads from the round start to the exit (the old build: canvas `texSubImage2D` for the watch and messages); the only texture data left is three's bone matrices of visible soldiers (997 small float updates in the run: skinning). Watch Node tests: no allocation per frame with the boards. Legibility of the glyph text on the device pending |
| Space Setup capture spread over frames (planes, then ≤ 16k mesh vertices a frame); `rec.play.capture.ms`, `maxMs`, `frames` | desktop-tested | Node test: identical snapshot to the one-frame capture; the fixture plays from its file in the e2e, so the live path is Node-only |
| After a build: the card, the look's rebuild, its light snap and the card's layout each in their own frame, then the XR warm draw (step POST) | desktop-tested | Node test of the staging; e2e: the card and warm draw as before |
| JS heap once a second outside the frame loop (GC drops with times, `rec.heap`, marker `gc`); long animation frames ≥ 50 ms with their top 3 scripts | desktop-tested (heap, LoAF parser) / implemented (in the record) | `performance.memory` and LoAF are Chromium APIs; whether the Quest Browser exposes them is a device question |

### The walkthrough scan and the house learner

| Item | Status | Notes |
|---|---|---|
| **Scan house** button; the first play in a house with nothing learned starts with the scan (`?scan=0` never on its own, `?learn=0` off) | desktop-tested | e2e: the first play goes card → scan → (walk) → hold the trigger → built from the scan → the card; later sessions in the same house skip it (the house was loaded) |
| While scanning: nothing in the view but a faint floor tint; the watch shows the rooms found (9 o'clock, blue) and SCAN n% | desktop-tested | e2e: card hidden, tint shown, no message panel, the watch reads "SCAN 2%" |
| Play asks for depth-sensing for the learner only; three never sees it (near plane 0.02 m, its own clear, no occlusion pass) | desktop-tested | e2e: `depthSensing` true, `depthToThree` false, `hasDepthSensing()` false, near 0.02. Whether the Quest prompts again for depth is a device question |
| GPU depth readback (DepthTap): GPU downsample to 40 × 40 blocks per eye with the nearest texel's position, `readPixels` into a freshly specified PIXEL_PACK_BUFFER the frame after, fence, poll, `getBufferSubData`; one GL step a frame on frames under 8 ms; 4 Hz scanning, 1 Hz in play; compiled and drawn at load | desktop-tested | e2e (SwiftShader): 145 readbacks in play, 0 dropped, issue 0.16 ms avg (max 1 ms), `getBufferSubData` 0.35 ms avg (max 1.8 ms), always signalled the next frame. Node: the packing (the shader's CPU mirror) decodes to the surfaces with p50 < 2 mm, p95 < 6 mm (320², asymmetric frusta). Adreno costs, the depth geometry, the no-data value and the row direction are device questions |
| Row-direction calibration against Space Setup (first 8 readbacks; median < 8 cm or depth learning is off for the session) | desktop-tested (Node) | e2e's fake constant depth correctly turns depth learning off ("no points"); real depth is the device's |
| Hit-test rays (controllers, two viewer rays; `['point', 'plane']` in a try, then the default), one source a frame | implemented | IWER cannot emulate hit-test; `rec.play.learn.hitTest` says what the Quest gives |
| Learner worker: sparse 4 × 4 m chunks of 10 cm cells from a fixed pool, fusion (floor heights, tops, wall-height hits, wall-height free space by DDA, walked cells), analysis (openings, floors, walls, furniture tops, rooms) | desktop-tested | Node tests; e2e: the worker loop runs, loads and saves in IndexedDB |
| The learned house in the world build (door planes in conflicting walls, floor planes beyond / at other heights, learned walls and volumes, walked rooms never "unscanned") | desktop-tested | **Replay of your v0.4 house** (`tests/unit/learn.replay.test.js`): without the scan the hall is closed (bedroom, hall and living room are three nav regions); a synthetic depth walk along your path (bedroom → hall → living room) through the walls Space Setup put where you walked finds 2 walked openings, and the world built from it is ONE region; Space Setup's other walls stay; the space behind the living room's doors stays hidden unless walked |
| Persistence: IndexedDB (worker only), compact versioned chunks with CRC (corrupt → quarantined), per-house caps (160 chunks, 4 houses), decay per session, compaction, quota check; saves after the scan, at each wave break and at session end | desktop-tested | Node: **100 simulated sessions**: stored size 89.1 KB at session 20, 89.9 KB at 50, 89.4 KB at 100 (plateau); load + analysis flat (60 → 61 ms); the doorway beyond Space Setup found every session. e2e: saved in IndexedDB (4 chunks, 1.4 KB for the short fixture walk) |
| Silent learner in play: 1 Hz; a changed result built in only in a wave break / after the round with no enemy alive (lights ease, no snap) | desktop-tested (Node) | The e2e's fixture never changes its result in play, so the live window is Node-tested only |
| House frame and id from Space Setup (largest floor plane, yaw only; a hash of floor areas, wall lengths, doors) | desktop-tested (Node) | Whether the Quest's floor plane pose is stable across sessions is the device's (the learned map is then reused) |

### Ask in the headset (keep it short)

See DEVICE_LOG "v0.5: tests to run": Scan house and walk bedroom → hall → living room; is the floor glow the only thing you see; does the watch count rooms; do soldiers now come through the hall; reload: no scan, hall still open; any new permission prompt; any stutter.

## Later phases

These items are planned, as in PLAN §12.

- **Phase 2:** passthrough and controllers
- **Phase 3:** mapping
- **Phase 4:** room database
- **Phase 5:** player, holster and pistol
- **Phase 6:** enemies and navigation
- **Phase 7:** gameplay and audio
- **Phase 8:** optimisation
