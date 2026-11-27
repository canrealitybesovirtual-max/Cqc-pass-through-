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
| Explicit clear with depth on (toggle X) | desktop-tested | Device check: background stays transparent |
| Frame-rate switch (B) | desktop-tested | Device rates pending |
| 60 s timing run with the Phase 1 gate (A) | desktop-tested | Device runs at 72 and 90 Hz pending |
| PerfMonitor: rings, histograms, hitch log, cancelled runs | desktop-tested | Node tests incl. a heap-growth check |
| Long-task observer | implemented | |
| Lifecycle: end, visibility pause, reset logging | desktop-tested | IWER e2e (blur) |
| Exit by holding both grips for 1 s | desktop-tested | IWER e2e |
| In-headset text panel (redraw on change, no mipmaps, tag-along) | desktop-tested | Legibility on device pending |
| Diagnostics: localStorage at session end; copy / download / share | desktop-tested | |
| Render static site (`render.yaml`) | implemented | |
| ARCHITECTURE.md, FEATURES.md, DECISIONS.md, DEVICE_LOG.md | implemented | |

## Test slice (v0.2): preload and warm-up

| Item | Status | Notes |
|---|---|---|
| Import map `three/addons/` → `vendor/three/addons/` | desktop-tested | IWER e2e loads the GLTF, KTX2 and meshopt add-ons |
| Preload before Enter: assets, audio decode, warm-up, with "Loading n%" | desktop-tested | IWER e2e: reaches 100 %, buttons disabled while loading, Enter MR enabled after; device load time pending |
| Load failure: error shown, Enter MR off, probe sessions usable | desktop-tested | IWER e2e with a missing model |
| `warmUp`: orphans attached, instanceColor primed, compile, one upload per frame ≥ 30 ms apart, forced-visible default-framebuffer draw, all flags restored, baseline | desktop-tested | Node tests + IWER e2e (8 programs, 14 textures, 11 geometries for the loaded models + probe scene) |
| `warmXR`: one draw inside the first XR frame, re-baselines | desktop-tested | IWER e2e drives it through a system; not yet wired in App (needs the "Get ready" panel) |
| `assertStable` dev check (programs, textures, geometries after the baseline) | desktop-tested | Node tests; IWER e2e: flat in probe and after warmXR. Device check pending |
| Pools in the warm-up (`buildPools` hook in `main.js`) | planned | Integration wires the weapon views, FX and enemy pools |

## Soft live-depth occlusion (PLAN §5 mode C, opt-in, not wired)

| Item | Status | Notes |
|---|---|---|
| `src/xr/DepthOcclusion.js`: `applySoftOcclusion(material)` patch (MeshBasic, MeshStandard/Physical, ShaderMaterial via `softocc_*` chunks), 5–10 cm fade or Bayer dither, 1-tap or 4-tap PCF, per-material bias | implemented, device test pending | Desktop: `npm test` (maths, patch, controller, no allocation) and `NODE_PATH=$(npm root -g) node tests/e2e/depth-occlusion.mjs` (compile + GPU output vs the maths with fake R32F and DEPTH_COMPONENT16 depth arrays; programs flat). IWER has no depth, so the real look and the compositor's alpha handling are unverified |
| `DepthOcclusion` controller: hides three's hard depth mesh, per-frame uniforms (texture, eye viewports, near/far), `disable()` restores | implemented, device test pending | Which materials to patch, load-time pre-patching and the frame-loop call are in the module header. App wiring is for the integration agent |

## Later phases

These items are planned, as in PLAN §12.

- **Phase 2:** passthrough and controllers
- **Phase 3:** mapping
- **Phase 4:** room database
- **Phase 5:** player, holster and pistol
- **Phase 6:** enemies and navigation
- **Phase 7:** gameplay and audio
- **Phase 8:** optimisation
