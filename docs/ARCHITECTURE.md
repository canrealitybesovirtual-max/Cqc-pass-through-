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
- **Pure logic stays testable.** Modules in `app/Game.js`, `xr/XRSession.js`, `debug/PerfMonitor.js` and `util/` import neither three.js nor the DOM, so `node --test` covers them.

## Phase 1 runtime

```
index.html ── import map: three → vendor/three/three.module.js, three/addons/ → vendor/three/addons/
  └ src/main.js            boot: optional IWER (?emulate), support check, renderer, App, HomePage, preload
     ├ core/Preload.js     before Enter: Assets.load → AudioEngine.decodeAll → buildPools hook → warmUp
     ├ core/Warmup.js      warmUp (pre-XR compile + uploads + draw), warmXR (one XR-frame draw), assertStable
     └ app/App.js          composition root; one XR session at a time
        ├ app/Game.js      state machine boot → menu → entering → xr → menu (+ pause reasons)
        ├ app/Loop.js      XR frame loop; systems timed by PerfMonitor; dt clamp; per-frame try/catch
        ├ core/Renderer.js WebGL2 context (xrCompatible) + WebGLRenderer + fixed light set
        ├ xr/XRSession.js  modes (play, setup, probe, bounds, reduced, vr), feature lists, attach
        ├ xr/Input.js      controller buttons → per-hand state + press edges (allocation-free)
        ├ xr/Lifecycle.js  end, visibilitychange, reference-space reset, input changes
        ├ debug/CapabilityLog.js  what was asked and granted; layer; GL extensions
        ├ debug/Probes.js  device probes: Space Setup, anchors, hit-test, depth, light, body, bounds,
        │                  frame-rate switch, 60 s timing runs, explicit-clear toggle, grip exit
        ├ debug/PerfMonitor.js    rings, histograms, hitch log, run gate
        ├ debug/Diagnostics.js    localStorage (at session end) + copy / download / share JSON
        ├ debug/DebugDraw.js      controller rays, hit-test reticle
        ├ debug/TestCube.js       world-locked test cube (+ grid in VR)
        ├ ui/CanvasPanel.js       in-headset text panel: redraw on change, no mipmaps, tag-along
        └ ui/HomePage.js          2D page: load bar, start buttons, retry, diagnostics summary
```

### Frame order

Each XR frame runs these systems in order, each timed separately:

1. `input`
2. `probe`: probes, then the test cube
3. `ui`: rebuilds the panel text only when `probes.rev` changes; follow; flush
4. `render`: an explicit clear when depth sensing is on, then `renderer.render`

Each system is timed separately, and `renderer.info` is reset once per frame.

### Session start

1. The click handler calls `requestXR` synchronously, so the user gesture is kept.
2. When the promise resolves:
    1. The `Loop` starts **before** `setSession`, because three.js stops its window rAF loop on `sessionstart`. The loop ignores calls without an `XRFrame`.
    2. `attachSession` requests the reference space first, falling back to `local-floor`.
    3. It then sets the space, scale and foveation, and calls `setSession`.
3. The capability log is collected, and the lifecycle listeners and probes are attached.

### Preload and warm-up (before Enter)

1. `main.js` starts `preload()` (`core/Preload.js`) once the support check shows AR or VR. The page shows "Loading n%"; every session button stays disabled until the warm-up has drawn, because its default-framebuffer draw must not overlap XR.
2. `Assets.load` (75 % of the bar), then `AudioEngine.decodeAll` (10 %; the context stays suspended until `audio.unlock()` inside the Enter click, which `HomePage.onEnter` does for play modes), then the `buildPools(assets, audio)` hook, then `warmUp` (15 %).
3. `warmUp(renderer, scenes, objects)`: orphans are attached to the main scene (its fixed light set is part of every program key) and `setColorAt(0, white)` primes instanced pools; `compile` per scene (`compileAsync` only when `KHR_parallel_shader_compile` exists, which the Quest lacks); `initTexture` per texture, one per frame and ≥ 30 ms apart; one `render` per scene to the default framebuffer with every drawable, ancestor and LOD level forced visible and culling off; then every flag is restored and the orphans detached. The program, texture and geometry counts become the baseline.
4. Enter MR is enabled only when this succeeded. On failure the page shows the error and keeps the probe sessions usable.
5. The result is `preloaded` (exported by `core/Preload.js`, also `window.__app.preload`): `assets`, `audio`, `warm` (the baseline), `warmed` (the objects drawn), and a summary in the diagnostics JSON (`preload`).
6. In a play session App calls `warmXR(renderer, scene, camera, pools)` inside the first XR frame (before the frame's render, behind the opaque "Get ready" panel) and `assertStable(renderer)` in dev builds.

### Known three.js r187 behaviours we design around (verified in source)

- With GPU depth sensing granted, three skips `background.render()`, so it clears nothing. `Loop` clears explicitly, and the probe can switch this off to see what the browser does.
- `setReferenceSpaceType` and `setFramebufferScaleFactor` only take effect before `setSession`.
- `getFoveation()` returns three's own cached value. The capability log reads the layer instead.
- `setAnimationLoop` while presenting also starts the window rAF loop, hence the start order above.
- three dispatches a `planesdetected` event object every frame when `frame.detectedPlanes` exists. This is a small amount of garbage inside three.

## Hosting and testing

- **Production:** a Render static site from `main` (`render.yaml`). It sends `Cache-Control: no-cache` and `Permissions-Policy: xr-spatial-tracking=(self)`. The origin must never change, because rooms and anchors belong to it.
- **Desktop:**
    - `npm test` runs the Node unit tests.
    - `node tests/e2e/emulate.mjs` runs Playwright with IWER.
    - `node tools/serve.mjs` then `http://localhost:8080/?emulate` runs the page in the emulator.
- **Headset:** open the Render URL in the Quest Browser and follow the on-page Phase 1 tests. Then copy the diagnostics JSON into the chat.
