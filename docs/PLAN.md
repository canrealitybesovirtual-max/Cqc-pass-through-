# Quest 3 MR Tactical FPS: Technical Planning Report

This is a plan only. No code has been written yet. The target is Meta Quest 3, OculusBrowser 157 / Chromium 157, with three.js r187.

**Source tags used in this report**
- **[D]**: your Quest 3 diagnostics from November 2026, plus the House Scanner code. `SC:line` means a line in `/home/user/scanner-/index.html`.
- **[D2]**: lessons from CQC running on the Quest. `CQC:line` means a line in `/home/user/ref/realism-cqc-realism/cqc/index.html`, and `CQC-LOG:line` means a line in that repo's `CLAUDE.md`.
- **[S-x]**: the WebXR spec sources (the GitHub `.bs` files).
- **[three]**: the three.js r187 source.
- **[IWSDK] / [RATK]**: Meta's own web SDK code.
- **[Meta]**: a Meta documentation page that I saw only as a search excerpt. This sandbox blocks developers.meta.com.
- **[3P]**: a third-party report.
- *(design)*: my own choice or estimate. Each one has to be measured on the headset.

## At a glance

- **Built from scratch.** Your old repos are references only: tested numbers and lessons, no copied code (§14).
- **Stack:** three.js r187, `WebGLRenderer`, plain JavaScript modules, no build step, no physics engine. The only dependency is three.js.
- **Mixed reality:** `immersive-ar` passthrough. Rooms come from your Quest's Space Setup plus quick manual tools. There is **no scanning**, because that is what made the old scanner slow.
- **Occlusion:** invisible stand-in walls and furniture hide enemies behind real objects. Live depth is an option to A/B test.
- **Rooms:** each room is saved, anchored and repaired on its own. One bad room never breaks the others.
- **Pistol:** realistic mechanism (trigger break and reset, slide, magazine, recoil springs) in **2 draws per eye**.
- **Enemies:** a 10 cm grid per room plus doorway links. They spawn only on verified floor, out of sight, and always come to you.
- **Safety:** your own safe zone with warnings, and an instant pause when you leave it. You never have to walk through real doors during play.
- **No hitching:**
  - every object is prebuilt and drawn once before play;
  - zero allocations per frame;
  - frame budgets with a 20-minute heat-soak test.
- **Phase 1** sets up the project and a probe session that logs exactly which features your Quest grants.

**Decisions for you:** §15 (repo, language, holster side, pistol model, licences).

---

## 1. Recommended technology stack

| Layer | Choice | Why | Rejected |
|---|---|---|---|
| Renderer | three.js **r187** (`three@0.187.0`, the latest release) using `WebGLRenderer` on WebGL2, with `antialias:true`. That gives 4x MSAA resolved on-tile through `WEBGL_multisampled_render_to_texture` [three]. | The latest release, with current XR fixes. GPU depth occlusion, projection layers and foveation are all built in. The depth occlusion (`WebXRDepthSensing`, a full-screen pass that writes `gl_FragDepth`) has been in `WebGLRenderer` since about r16x. It works the same in r170 and r187; only the texture wrapper changed (`ExternalTexture` in r187). CQC's vendored r170 already has it, so Blackout and CQC could use the same depth path. The scanner's r160 has none of it. | **`WebGPURenderer`**: its r187 `XRManager` (`common/XRManager.js`) has no WebXR depth sensing or occlusion at all [three], and WebGPU inside WebXR is new and UNRELIABLE on Browser 156/157 [Meta]. Its multiview on the WebGL2 fallback backend (`forceWebGL`) exists but is UNTESTED on device. **Babylon**: not three.js. **A-Frame**: built on three.js, but it adds its own ECS/DOM layer, its bundled three version and patches lag r187, and it hides direct `renderer.xr` control. |
| Language | Plain JavaScript ES2022 modules, with **JSDoc types and `// @ts-check`** | It runs unchanged on the Quest, and stack traces in chrome://inspect stay readable. The editor still type-checks, with no compile step. Saved data needs runtime validators anyway (§7). | TypeScript, because it needs a build step. This is open decision 2 in §15. |
| Build | **No build step.** `index.html` uses an import map that points to `vendor/three/`, a pinned copy of r187. | Blackout already works this way (`index.html:9`, an import map pointing at vendored three r170). There are no dev dependencies and no minified bundle to debug. | Vite. Hot reload and minification are not worth a toolchain for about 60 modules. Reconsider only if measured load time is bad. |
| XR | Raw WebXR through `renderer.xr`, with our own `XRSession` module and our own Enter button | three's `ARButton` forces the `'local'` space and adds `dom-overlay`. `XRButton` adds `bounded-floor`, which switched the Quest to a roomscale boundary in VR [three][D2]. | **three's buttons.** **IWSDK**, Meta's ECS framework built on three: used only as **reference code** for depth decoding, scene understanding and anchor retries. |
| Collision | **No physics engine.** We use analytic shapes (wall segments with a height, oriented boxes (OBBs), planes, capsules) and hand-written springs that run in small fixed sub-steps. | Bullets, enemies and safety warnings only need ray, segment and box tests against at most about 200 shapes, which takes under 0.05 ms *(design)*. | Rapier (CQC vendors version 0.14). v1 has no rigid bodies. Spent cases and magazines fly ballistically and bounce off the floor plane (the pattern in Blackout `src/game/effects.js:103`). |
| Navigation | Our own grid per room (0.10 m cells) plus a graph of doorways (portals), built in a worker | A typical room is 2,000–5,000 cells, and the largest allowed room is about 22,500 (§9), so a navmesh isn't needed. | Building a navmesh at runtime: your brief rules it out, and the browser has no API for it. |
| Storage | IndexedDB with a thin wrapper written fresh (the scanner only proved IndexedDB works on your headset), for rooms, player profiles and settings, and diagnostics. localStorage holds only the capability log, which is written once at session start and never from the frame loop. | It gives atomic writes across several stores, one record per room, and a version number for migrations. | Keeping rooms in localStorage: too small, and no atomic writes. |
| Assets | GLB models with **KTX2** textures (UASTC for the gun and normal maps, ETC1S for albedo) and meshopt compression. The loaders come from three's own `examples/jsm`. | Uncompressed RGBA8 textures cost 4 bytes per pixel; ASTC 4×4 costs 1 byte [three KTX2Loader]. | JPEG/PNG textures in shipped assets |
| Audio | Raw Web Audio: one `AudioContext`, a pool of 8 HRTF `PannerNode`s created at unlock, and one `ConvolverNode` whose buffer is set once at load. Every clip is fetched and decoded before Enter (§10). | three's `PositionalAudio` schedules 6 parameter ramps per voice every frame [three]. | One `PositionalAudio` per sound source |
| UI | Menu panels drawn on a `CanvasTexture` (the idea behind the scanner's wrist panel, written fresh). A panel redraws only when a value changes and only while it is visible (§10). Numbers that change are drawn from a digit atlas on instanced quads. WebXR compositor quad layers come only after an A/B test in Phase 8. | The approach ran on your headset. Layers are untested in AR, and `WebGLRenderer` has no helper for them [three]. | DOM overlay |
| Threads | Module workers with a promise-based call wrapper and transferable buffers, written fresh | Workers and transfers already ran on your headset [D]. | SharedArrayBuffer, which needs COOP/COEP headers |
| Tests | Node's built-in `node --test`, a browser test page, IWER (Immersive Web Emulation Runtime: Meta's in-page emulator library, dev-only, loaded with `?emulate` as CQC does, CQC-LOG:86), and replay of data recorded on the headset. Meta's separate Immersive Web Emulator browser extension is optional. | No runtime dependencies | Test frameworks |

**Rules that apply to everything**
- **Dependencies.** The only runtime dependency is three r187, including its own KTX2/basis and meshopt decoders. Controller profile models are stored locally, because CQC loaded them from cdn.jsdelivr.net and so needed internet to enter VR [D2]. Offline asset tools in `tools/` are never shipped.
- **Optional features.** `requiredFeatures` stays empty. Every feature is detected at runtime and has a fallback.
- **Testable logic.** Pure-logic modules never import three.js or touch the DOM, so Node can test them. That covers the weapon state machines, navigation, schema and migrations, the body estimator and the safety rules.
- **Realism budget.** It goes first where the player looks: the pistol, as a hero asset with the full mechanism. Enemies come second. Effects are short and pooled. **A stable frame rate always wins over an effect.**

---

## 2. Quest 3 browser compatibility

**Platform facts**
- **Browser.** The user agent is `OculusBrowser/157.0.0.22.15 … Chrome/157.0.8103.38` [D]. The Quest 3S has the same chip and fewer pixels, so the same budgets apply.
- **Secure context.** WebXR needs HTTPS [S-webxr]. For development, `http://localhost` reached through `adb reverse` should work (the standard Chromium rule; check it in Phase 1).
- **User gesture.** Starting an immersive session needs a user gesture. Any `await` before `requestSession` can use up that gesture: the scanner had to show "Tap again" for this reason (SC:3268-3271, 3301) [D].
  - A retry after a rejection comes after an `await`, so it has lost the gesture too. Every fallback request needs a fresh tap (§3).
  - `navigator.xr.offerSession` (a browser-UI Enter button) is LIKELY to work. Call it **once only**; on Browser 146 a second call raised a "called more than once" error [3P].
- **Data belongs to the origin.** IndexedDB rooms and persistent anchors belong to the site's origin (scheme, host and port). They don't persist in private mode, and clearing site data deletes both [Meta][S-anchors].
  - **So we need one stable production origin from day one.** The dev origin (localhost) keeps its own separate rooms.
- **Permission.** The browser asks a site permission for scene and depth data. Since Browser 36.2 this is a single "Spatial" permission (LIKELY [Meta]).

**Proven on your headset [D]**
- `immersive-ar` with passthrough.
- Granted features: `viewer, local, local-floor, unbounded, anchors, plane-detection, mesh-detection, hand-tracking, depth-sensing`, plus a `webxr` token whose meaning is unknown.
- GPU depth: a 320×320 texture array with 2 layers, `unsigned-short` format, near plane 0.10 m, far plane infinite.
- Anchors: `createAnchor`, `requestPersistentHandle`, and `restorePersistentAnchor` across sessions all work; `deletePersistentAnchor` exists.
- Reference-space `reset` events fire, sometimes with a transform.
- Space Setup planes and meshes arrive with semantic labels, and `initiateRoomCapture` exists.
- Workers and transferable buffers run.
- Heavy work on the main thread dropped the scanner to a median of about 10 fps.

**Never requested on your headset (untested)**
`hit-test`, `layers`, `bounded-floor`, `webgpu`, `body-tracking`, `light-estimation`, foveation and framebuffer scale, the frame-rate API, pausing on `visibilitychange`, gamepad buttons and axes, three's built-in depth occlusion, and how the system boundary behaves in each reference space.

**Browser engine constraints**
- **Two-pass stereo.** `WebGLRenderer` has no multiview in r160–r187 [three], so the CPU pays for every draw call twice.
- **Main thread only.** The XR frame loop runs on the main thread (`XRSession` is exposed on Window only) [S-webxr].
- **WebGPU in WebXR is UNRELIABLE.** Meta's release notes go from "experimental" in Browser 146 to "added" in 156, and sources disagree about its status [Meta].
- **No post-processing.** Foveation applies only to the XR layer's own textures, so any intermediate render target loses it [S-layers][three].
- **Refresh rate.** The default is LIKELY 72 Hz [D2]. 72/80/90/120 Hz are LIKELY available [Meta, native docs]. Always read the list at runtime.
- **Hardware.** No eye tracking (CONFIRMED). The panel is 2064×2208 per eye; native 100 % render scale is 1680×1760 per eye (LIKELY to match the browser) [Meta].

**Reference space** *(design)*
- **Choice, per session mode.**
  - **Setup (mapping) sessions:** `unbounded` when it is granted, otherwise `local-floor`. Walking from room to room is only needed here.
  - **Play sessions:** `local-floor`. They don't request `unbounded` at all. Play is stationary, and the spec tunes `local-floor` for little movement.
- **Why not `unbounded` for play.** Browser 34.2 described `unbounded` as "no longer limited to the guardian boundary" (a hint only). That suggests it might weaken the system boundary during combat. This is untested, so `unbounded` stays out of Play until Phase 1 shows the boundary still appears under it.
- **Switching.** Setup and Play are separate sessions, and going from Setup to Play is one tap. (Swapping the space within a session with `renderer.xr.setReferenceSpace()`, WebXRManager.js:338, is possible but not needed.) All content is room-local and anchored, so it doesn't care which space is active.
- **What `unbounded` costs in Setup, and how we handle it.**
  - The origin may drift, and y = 0 is not guaranteed to be the floor [S-webxr].
  - So all content is stored room-local and pinned to anchors (§7).
  - The floor height comes from the `floor` plane (SC:456), or from touching the floor with a controller.
- **Risk.** One [3P] report says `createAnchor` fails in `unbounded` on Quest 3. The Phase 1 capability log records the result of creating an anchor in each space. Forcing Setup to `local-floor` is a single config flag.
- **Boundary probe (Phase 1, one-off).**
  - A separate session requests `bounded-floor` in AR and logs `boundsGeometry`. It is never part of a normal session, because in VR this feature switched the Quest to a roomscale boundary [D2].
  - Phase 1 also notes whether the system boundary still shows under `unbounded` and under `local-floor`.

---

## 3. Exact WebXR features we can use

Every feature is optional, so the session loses features instead of failing. Unknown optional features are ignored [S-webxr].

**If the request is rejected anyway,** the gesture is already spent.
- Show a "Tap again (reduced features)" button. Its own click requests only `['local-floor']`, and the result is logged.
- Check `isSessionSupported` before the first click, so the Enter button only offers what is possible.

```js
// src/xr/XRSession.js — called synchronously from the Enter button's click handler
const BASE  = ['local-floor','anchors','plane-detection','mesh-detection','hit-test','hand-tracking'];
const MODES = {
  play:   BASE,                                   // stationary play: no 'unbounded' (§2)
  setup:  [...BASE, 'unbounded'],                 // walking room to room while mapping
  probe:  [...BASE, 'unbounded','depth-sensing','layers','body-tracking','light-estimation'], // Phase 1 logging only
  bounds: ['local-floor','bounded-floor'],        // Phase 1 one-off boundary probe; never in play
};
export async function enterMR(renderer, audio, cfg, mode = 'play') {
  audio.unlock();                                   // resume() inside the gesture; nothing awaited before requestSession
  const want = [...MODES[mode]];
  if (mode === 'play' || mode === 'setup') {
    if (cfg.depth) want.push('depth-sensing');      // "Dynamic occlusion" setting; default off; applies from the next session
    if (cfg.bodyTracking) want.push('body-tracking'); // experimental setting; default off
  }
  const s = await navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: want,
    depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] }, // dictionary required with depth [S-depth]
  });
  const f = s.enabledFeatures ?? [];
  const roam = mode !== 'play' && f.includes('unbounded') && cfg.space !== 'local-floor';
  renderer.xr.setReferenceSpaceType(roam ? 'unbounded' : 'local-floor');
  renderer.xr.setFramebufferScaleFactor(cfg.scale); // both setters only work before setSession [three]
  await renderer.xr.setSession(s);
  renderer.xr.setFoveation(cfg.foveation);          // 0.5; three's default 1.0 blurs the edges
  return s;
}
// On rejection the gesture is spent: the caller shows "Tap again (reduced features)",
// whose own click calls requestSession('immersive-ar', { optionalFeatures: ['local-floor'] }).
```

| Feature | Status | How to detect it | Fallback |
|---|---|---|---|
| `immersive-ar` with passthrough | CONFIRMED [D] | `navigator.xr?.isSessionSupported('immersive-ar')` | An `immersive-vr` test scene from a fresh tap (Phase 1 diagnostics only; a VR replica mode is out of v1 scope) |
| `environmentBlendMode === 'alpha-blend'` | LIKELY [S-ar] (never logged) | `session.environmentBlendMode` | Clear to alpha 0; keep `scene.background = null`. With depth on, three skips its own clear (§5). |
| Starting the session from a user gesture | CONFIRMED [S-webxr][D] | — | `navigator.xr.offerSession` (LIKELY; call once). Any retry needs a fresh tap. |
| `local-floor` | CONFIRMED [D] | `enabledFeatures.includes('local-floor')` | `local` plus the floor-plane height |
| `unbounded` (Setup sessions only) | CONFIRMED [D]; its origin may drift [S] | `enabledFeatures.includes('unbounded')` | `local-floor` |
| `bounded-floor` / `boundsGeometry` in AR | UNRELIABLE [3P][D2]: Quest 3 developers report it empty at first, then a small simplified square | Phase 1 one-off probe session only: `boundsGeometry.length` | Our own safe zone. Bounds are a hint at most, never used for safety. |
| Reference-space `reset` event (optional transform) | CONFIRMED [D]; three doesn't handle it [three] | `refSpace.addEventListener('reset', …)` | Re-resolve anchors, pause, re-confirm the safe zone |
| `XRPose.emulatedPosition` (tracking lost) | CONFIRMED [S-webxr] | Check every frame | Pause |
| `visibilityState` / `visibilitychange` | CONFIRMED [S]; the exact timing on Quest is UNRELIABLE | `session.visibilityState` | Our wrist pause button |
| `plane-detection` (polygon, orientation, `semanticLabel`) | CONFIRMED [D] | Granted, and `frame.detectedPlanes` exists | Manual mapping; a Space Setup button |
| `mesh-detection` (one global room mesh plus labelled object meshes) | CONFIRMED [D]; the global-vs-object split is LIKELY [IWSDK] | Granted, and `frame.detectedMeshes` exists | Planes plus manually placed boxes |
| A fixed list of semantic labels | UNRELIABLE (floor, wall, ceiling, table and couch were seen [D]) | `semanticLabel ?? null` | Classify by orientation and height |
| `initiateRoomCapture()` | Exists: CONFIRMED [D]. Behaviour: UNRELIABLE (may wipe anchors [IWSDK]) | `typeof session.initiateRoomCapture === 'function'` | Tell the user to run Space Setup in Quest Settings |
| Space Setup data for several rooms in the browser | UNRELIABLE (untested) | Count the floor planes | Map each extra room by hand |
| `hit-test` | LIKELY [S-hit][RATK][3P]; not yet requested on your headset. Whether it works outside the Space Setup room is untested. | Granted, and `session.requestHitTestSource` exists. Phase 1 logs result counts inside and outside the Space Setup room. | Ray against detected planes, then mapped geometry, then the floor plane (floor-based tools, §6.2) |
| `frame.createAnchor` | CONFIRMED [D] | `'anchors'` granted, and `frame.createAnchor` exists | Room-local data plus 2-point re-alignment each session |
| Persistent anchors (request handle, restore, delete) | CONFIRMED [D] | `'requestPersistentHandle' in XRAnchor.prototype` | Re-align from planes, a neighbouring room, or 2 points (§7) |
| `session.persistentAnchors` list | LIKELY [S][RATK] | `'persistentAnchors' in session` | Our own UUID list in IndexedDB |
| Limit of 8 persistent anchors per site | Meta doc says "currently" [Meta]; a claim that the limit is browser-wide is UNRELIABLE [3P] | Catch the rejection | Budget of 6 anchored rooms plus 2 spare |
| `createAnchor` while in `unbounded` | UNRELIABLE (a [3P] failure report vs scanner evidence) | Logged in Phase 1 | `local-floor` |
| GPU depth (`gpu-optimized`, `unsigned-short`, 320²×2 texture array) | CONFIRMED [D] | Granted, and `session.depthUsage` is set | Depth-only stand-in meshes for walls and furniture |
| three r187 automatic depth occlusion | CONFIRMED (source) [three]; the same path exists in r170 | `renderer.xr.hasDepthSensing()` (true once depth data has arrived) | The stand-in meshes |
| CPU depth (`cpu-optimized`) | UNRELIABLE | `session.depthUsage === 'cpu-optimized'` | Not used |
| `pauseDepthSensing`, `matchDepthView:false`, `depthTypeRequest` | UNRELIABLE on Quest [S-depth] | `typeof s.pauseDepthSensing === 'function'` | Start a session without depth |
| `light-estimation` (`session.requestLightProbe()`, `frame.getLightEstimate()`; three's `XREstimatedLight` add-on) | UNRELIABLE (never requested on your headset; no Quest evidence found) | Phase 1 probe: granted, and `requestLightProbe` exists | Manual per-room brightness and colour-temperature calibration (§6.2), or a default per Space Setup room |
| Hand tracking (25 joints) | CONFIRMED [D] | Granted, and `inputSource.hand` exists | Controllers |
| Pinch fires `select` | LIKELY [Meta][D] | `selectstart` arrives from a hand source | Our own thumb-tip to index-tip distance test (1.5/2.5 cm hysteresis, as three's `pinchstart`), read from the joints we already fetch (§10) |
| Fist fires `squeeze` on hands | UNRELIABLE [S-hand: "may"] | — | Our own finger-curl detector |
| Controllers with the xr-standard mapping (analog trigger and grip, A/B/X/Y, stick, thumbrest) | CONFIRMED [S-gp][profile] | `gamepad.mapping === 'xr-standard'` | — |
| Capacitive `touched` (trigger, thumbrest) | LIKELY [D2] | `buttons[i].touched` | Finger pose from the analog value only |
| Left menu button reaching the page | UNRELIABLE | — | Wrist pause button; hold B+Y |
| Controller haptics `pulse(intensity, ms)` | LIKELY (spec says "at risk"; a Meta engineer said Quest supports it; SC:3169) | `gamepad.hapticActuators?.length > 0` | Audio and visual cues |
| Haptics while hand tracking | UNSUPPORTED (hands have no actuator) | — | Louder mechanical sounds |
| Projection layer | CONFIRMED [S-layers][three] | three uses it automatically | `XRWebGLLayer` (three handles this) |
| Quad and cylinder layers | LIKELY [Meta]; untested in AR; no `WebGLRenderer` helper | `enabledFeatures.includes('layers')` (requested in the Phase 1 probe) | Panels on a `CanvasTexture` |
| Fixed foveation | CONFIRMED [S][Meta][three] | Read the layer: `const L = renderer.xr.getBaseLayer(); 'fixedFoveation' in L`, then read `L.fixedFoveation` back after setting it (capability log). `renderer.xr.getFoveation()` only returns three's cached value. | — |
| Framebuffer scale | CONFIRMED (in three it can only be set before the session starts) | — | Uses the next session's value |
| Dynamic resolution (`requestViewportScale`) | UNRELIABLE (three never calls it) | `view.recommendedViewportScale` | Frame-rate and foveation ladder |
| Target frame rate API | API CONFIRMED (Browser 16.4+); the list of rates is LIKELY | `session.supportedFrameRates?.length` | Stay at 72 Hz |
| Multiview | Not in `WebGLRenderer` (r160–r187). `WebGPURenderer` with the WebGL2 backend (`forceWebGL`) has it since r176 (a texture-array projection layer when `OVR_multiview2` exists) [three]: UNTESTED on device, and that renderer has no depth sensing. The flicker [D2] came from CQC's own patch of r170's `WebGLRenderer` (CQC-LOG:1678-1680), not three's path. | Extensions logged, including `framebufferTextureMultisampleMultiviewOVR` | Two-pass stereo |
| WebGPU in WebXR | UNRELIABLE | `'webgpu'` granted | WebGL2 |
| WebXR Space Warp | Exists behind a flag [Meta]; impractical in three | — | Not used |
| Body tracking | UNRELIABLE (Community Group draft, experimental) | Requested only with the experimental setting (and in the Phase 1 probe); `frame.body != null` | Head-and-hands body estimator (§8) |
| Hiding or disabling the Guardian; reading its real polygon | **UNSUPPORTED-IN-BROWSER** (native boundaryless mode only). How the boundary behaves under `unbounded` AR is untested. | Boundary behaviour noted in Phase 1 | Our own safe zone (§6.2) |
| WebXR `camera-access` | UNRELIABLE (rejected per a forum report). `getUserMedia` works (CONFIRMED [D]) but isn't needed. | — | Not used |
| Web Audio / HRTF panners | LIKELY; the CPU cost of HRTF is UNRELIABLE | `window.AudioContext` | Equal-power panning |
| ASTC/ETC compressed textures, `WEBGL_multi_draw` | LIKELY (not logged) | Extensions logged | ETC2 / a loop of draw calls (three does this itself) |
| `KHR_parallel_shader_compile`, GPU timer queries | UNRELIABLE | Extensions logged | The warm-up draw (§10): without the extension, `compileAsync` resolves before linking finishes. OVR Metrics for GPU time. |
| IndexedDB, workers, transferables | CONFIRMED in scanner use [D] | — | — |
| `navigator.storage.persist()` | UNRELIABLE (the grant is heuristic) | Returns a boolean | JSON backup export |
| System keyboard inside an immersive session | UNRELIABLE | — | Our own in-world keyboard plus preset room names |

---

## 4. Limitations of three.js in the browser compared with native Quest development

| Area | Browser three.js | Native has | What we do |
|---|---|---|---|
| Stereo | Two-pass: every draw call costs CPU twice | Multiview | About 100 unique draw calls at most; instancing and batching. Multiview only as a Phase-8 A/B test. |
| Frame synthesis | three has no motion-vector output; WebXR Space Warp is experimental | Application SpaceWarp | Hold real 72/90 Hz with a quality ladder (§10) |
| CPU/GPU clocks | No control | CPU/GPU level APIs | A 20-minute heat soak in every performance gate |
| Scene model | Space Setup planes and meshes, usually one room; no plane IDs that last across sessions [S-planes] | MRUK, multi-room data (up to 15 rooms), Spatial Discovery | Map the other rooms by hand; recognise rooms by their shape |
| Boundary | Can't hide the Guardian or read its real polygon. `bounded-floor` bounds are coarse or empty (UNRELIABLE). | Boundary API, boundaryless mode | Our own safe zone with runtime warnings and pause, with passthrough always visible |
| Anchors | 8 persistent anchors per site, and the browser "MAY delete" them [S][Meta] | — (native limits not researched) | At most 6 anchored rooms, with fallbacks (§7) |
| Threads | The XR loop is main-thread only, and JavaScript garbage collection can pause it | Native threads, no garbage collector | Workers; no allocations in hot loops |
| Shaders and uploads | Compiled at runtime. `compileAsync` only builds programs: textures, vertex buffers and bone textures upload on first draw, and drivers may finish variants then. All of these cause hitches. | Precompiled | A warm-up draw of every pooled object before XR, plus one behind a "Get ready" panel in XR (§10) |
| Skinning | No instanced skinning, and `BatchedMesh` can't skin [three] | — | At most 2 draw calls per enemy, LOD; vertex animation textures as an option |
| Lights | The light count is part of each shader's program key, so adding or removing a light recompiles shaders [three] | — | A fixed set of lights; animate intensity only |
| Depth | 320² resolution, hard edges, lag. three forces the camera near/far to 0.1 / infinite and skips its own clear. | — | Stand-in occluder meshes by default (§5) |
| Body | No hip tracker; feet not tracked [D2] | — | Head-and-hands estimator (§8) |
| UI layers | No `WebGLRenderer` helper | Native compositor layers | Canvas-texture panels |

---

## 5. How to implement passthrough, and how real objects hide virtual enemies

**Passthrough**
1. **Session.** Use `immersive-ar` with blend mode `alpha-blend`, which draws our image over the camera feed (source-over) [S-ar].
   - **Without depth,** three r187 clears the colour buffer to (0,0,0,0) by itself (`WebGLBackground.js:62-71`).
   - **With depth granted,** three skips `background.render()` for the whole session (`WebGLRenderer.js:1735`). That is where its clear and `autoClear` happen, so three clears nothing at all. Two options:
     - rely on the browser's per-frame layer clear, and verify it in Phase 1;
     - or clear explicitly at the top of the frame callback with `renderer.setClearColor(0x000000, 0); renderer.clear()`. *(Design: verify in Phase 1 that three has already bound the XR target at that point.)*
   - Keep `scene.background = null`.
2. **Never cover the whole view with something opaque.** That hides the real room [S-ar].
   - Any full-view tint is at most 0.3 opacity for at most 0.3 s.
   - No black-out or white-out, not even on death.
3. **No post-processing in XR.** It loses foveation and the cheap on-tile MSAA; a separate resolve can add about 3 ms [Meta].
   - Tone mapping and colour grading go into the material shaders.
4. **Muzzle flash and glow.** Write some alpha (about 0.5 × brightness). Purely additive light over passthrough is UNRELIABLE.
   - Virtual light can't light the real room. It lights only virtual objects. Their light level is matched to the room by the per-room lighting calibration (§6.2), or by `light-estimation` if Phase 1 finds it.

**Draw order** *(design)*

| Order | Layer | Contents |
|---|---|---|
| −10 | Occluders | Depth-only stand-in meshes: write depth, no colour |
| 0 | World | Enemies, bullet decals, effects |
| 10 | First person | Gun, magazines, holster: optional second pass on a small `fpScene` |
| 50 | UI | Menus and HUD |

**Occlusion: how real objects hide virtual enemies**

| Mode | How it works | Hides enemies behind | Cost | Status |
|---|---|---|---|---|
| **A. Static stand-ins (always on)** | One merged mesh per room built from the mapped walls, furniture boxes and optionally the ceiling. Material: `MeshBasicMaterial({colorWrite:false, depthWrite:true})`, `renderOrder:-10`. Each box is shrunk 2 cm so enemies touching a surface aren't wrongly cut. | Mapped walls and furniture only | ≤8 draw calls, ≤2.4k triangles, about 0 ms *(design)* | The method is CONFIRMED in three; no colour written means alpha stays 0 over passthrough (LIKELY) |
| **B. Live depth (opt-in "Dynamic occlusion")** | three r187 draws a full-screen pass per eye that writes `gl_FragDepth` from the depth texture before the scene (`WebGLRenderer.js:1714`, `WebXRDepthSensing.js`) [three]. | Everything the sensor sees: people, pets, opened doors, your hands | Writing `gl_FragDepth` turns off early-Z for that pass. On Adreno it may also disable LRZ for the rest of the pass, so the real cost shows in total App GPU time, not in the pass alone. *Design estimate* about 0.3–1 ms. The sensor also costs CPU, power and heat even when the pass is hidden (LIKELY [3P]). | CONFIRMED in source; three-way A/B on device in Phase 2 |
| **C. Soft edges (later)** | A depth test inside the enemy shader sampling `renderer.xr.getDepthTexture()`. Decode `meters = rawValueToMeters·depthNear/(1−d)`, UV = `gl_FragCoord.xy / per-eye viewport`, texture layer = eye index (LIKELY [IWSDK]). Use the real XR viewport size; three's example hard-codes 1680×1760. | Same as B, with a 5–10 cm faded edge | One texture fetch per enemy pixel | UNRELIABLE until checked on device |

The modes combine correctly, because the depth test keeps the nearest value.

**Rules for live depth**
- **Side effects in three.** These last for the whole depth session, whether or not the depth mesh is visible:
  - three sets the camera near/far to the depth values (0.1 m / infinite) (`WebXRManager.js:666`).
  - CQC needed a 0.01 m near plane because recoil pushed the gun inside a 7 cm near clip [D2]. With depth on, the gun must stay more than 10 cm from the eyes.
  - three skips `scene.background` and its own clear (see Passthrough above).
- **Your own hands cutting into the held gun.** With depth on, your real hand and controller would cut holes in the virtual gun. The fix:
  1. **Keep a small `fpScene`** that holds only first-person objects (gun, magazines, holster). It needs the same light types and counts, fog and environment as the main scene, so program keys match; otherwise its materials are unlit. The warm-up compile and draw run on it too (§10). CQC's arms view had its own lights, so the first pickup and the first shot compiled 6 programs (CQC-LOG:1869).
  2. **Draw it in a second `render()` call,** with `autoClear=false` and `clearDepth()` before it.
     - Each `render()` runs `scene.updateMatrixWorld()` and a full projection traversal (`WebGLRenderer.js:1667`). So `fpScene` stays small; never reuse the main scene with a layer mask.
  3. **During that call, hide the depth mesh, with a null check:** `const m = renderer.xr.getDepthSensingMesh(); if (m) m.visible = false;`. It returns null until the first valid depth frame. Invisible objects are skipped (`WebGLRenderer.js:1873`): CONFIRMED in source, LIKELY on device.
  - **Default:** the gun is not occluded. A/B test that against a depth-occluded gun, where real fingers wrap the grip.
  - **Counters:** set `renderer.info.autoReset=false` and call `renderer.info.reset()` once at the start of each frame, so counts cover both passes without growing forever. The second pass is timed as its own PerfMonitor system.
- **Turning it off.**
  - Hiding the mesh stops only the occlusion pass. The near/far forcing, the skipped clear and the sensor's CPU, power and heat cost all remain. `pauseDepthSensing` is UNRELIABLE.
  - Overriding `renderer.xr.getDepthSensingMesh = () => null` does no more than hiding it.
  - Turning depth off completely means a session without `depth-sensing`. So `cfg.depth` defaults to false and is set only by the "Dynamic occlusion" setting, which applies from the next session.
- **Never read depth back to the CPU in the frame loop.** That was the cause of the scanner's 10 fps [D].
- **Log once** whether `normDepthBufferFromNormView` is the identity matrix. three assumes depth is aligned with the eye view.

**Bullet decals**
- Decals sit 3 mm in front of the stand-in surface, with `depthWrite=false` and `polygonOffset`.
- Live depth (noisy, behind the real wall) could hide them. Fix: push the decal up to 3 cm toward the viewer.
- Option (LIKELY): snap the decal to a `hit-test` result along the barrel's line when that result is within 10 cm.

---

## 6. Automatic and manual house mapping

### 6.1 Automatic detection (`SpaceSetupImporter`, replacing the proposed "SpatialScanner")

The browser gives us Meta's Space Setup data, not live scanning [D][S-planes], and in practice that covers one room. Import runs in Setup mode, or once at session start. **Gameplay never reads planes.**

Geometry is re-read only when `lastChangedTime` changes. All the heavy work runs in `mapping.worker`.

1. **Wait for data.** Wait up to 3 s for `detectedPlanes`; Meta says it is empty for the first 2–3 s [Meta].
   - Still empty: the result is "No Space Setup data", which means manual mapping only.
   - The `initiateRoomCapture` button is offered **only manually**, with a warning. It is effectively once per session [S], and Meta's own SDK disabled its automatic call "due to the anchor wiping issue" [IWSDK].
2. **Classify planes.** Convert each plane into the reference space with `getPose(planeSpace)`; if the pose is null, retry for up to 1 s. Classify by label, otherwise by shape:
   - floor: |n.y| > 0.9 and lowest;
   - ceiling: more than 1.8 m above the floor;
   - wall: vertical and more than 1.5 m tall;
   - door and window: by label;
   - furniture tops: by label.
   - Don't trust which way a normal points. Derive "inward" from the floor polygon's winding.
3. **Meshes.**
   - The `global mesh` (the whole-room scan) is copied once to the worker, for clutter detection and an optional occluder.
   - Every other mesh becomes an oriented box: convex hull of its XZ points, then the minimum-area rectangle by rotating calipers, plus its min and max y. The label is kept.
4. **Rooms and floors.** Each floor polygon is one room candidate. Clean it:
   - merge points closer than 1 cm;
   - simplify with Douglas–Peucker at 2 cm;
   - force counter-clockwise winding;
   - reject self-intersections;
   - require an area of 1–200 m².
5. **Walls and doors.**
   - Each wall is fitted as a line segment (PCA). It is snapped to a floor edge if within 5° and 10 cm.
   - Floor edges with no wall get walls marked `inferred`.
   - A `door` plane within 0.2 m of a wall becomes a doorway marked `suggested`. It is not walkable until the user links it.
6. **Furniture.**
   - Mesh boxes are preferred. A plane footprint that overlaps a box (IoU > 0.5) is merged into it.
   - A plane-only object becomes a box from the floor to the plane's height. A couch gets a 0.3 m backrest margin and confidence 0.5.
   - **Every footprint blocks walking**, because the space under a table is unknown.
7. **Room frame and signature.**
   - Origin: the floor centroid. Yaw: the dominant wall direction, from a length-weighted histogram of wall angles.
   - Everything is stored room-local.
   - A signature `{area, polygon, wallCount}` recognises the same room in later sessions: area within 10 % and shape within 0.25 m (Hausdorff distance).
8. **Confirmation is mandatory.** The user sees a card such as "Living room 4.2×5.1 m, 4 walls, 1 door, 3 objects" with Accept, Edit and Ignore. Only accepted elements become `verified` ("never assume a scanned room is accurate").

### 6.2 Manual mapping (`RoomEditor`)

**Where the pointer lands, in priority order**
1. `hit-test` (LIKELY).
2. A ray against detected planes.
3. A ray against geometry we have already mapped.
4. The floor plane at `floorY`, which always works.

**What each tool depends on**
- The rooms that need manual mapping are the ones outside the Space Setup room, and there are no detected planes there by definition.
- Whether hit-test works there is untested. UploadVR reports that Quest hit-test has run on the Depth API since Browser 40.4 [3P], but that is not verified on your headset.
- The floor-plane ray, the only source that always works, can't place a chest-height wall point. So **Walls mode needs hit-test or plane hits.**
- **Automatic switch:** when no surface is hit for 1 s, the editor switches to the floor-junction mode below.
- Phase 1 logs hit-test results inside and outside the Space Setup room, so this is known before Phase 3.

**Floor height (`floorY`)**
- From the floor plane.
- Otherwise from touching the floor with a controller: the minimum grip height over 1 s, minus half the controller's height.
- Otherwise `local-floor` y = 0.

**Placing a point**
- Hold the trigger for 0.2 s. The point is the median of about 15 samples; it is rejected if they spread more than 3 cm. A haptic tick confirms it.
- The reticle colour shows which source produced the point.
- Range is limited to 6 m. The prompt says: **"Stand still; point from where you are."**

**Tools**

| Tool | How it works |
|---|---|
| **Walls (default when surfaces are hit)** | Click 2 points on each wall at chest height. This needs hit-test or plane hits. Neighbouring wall lines are intersected to give the corners, which works even when furniture hides the floor corners. Snapping: to vertices within 5 cm, to 90° (±7°), to detected walls (±5°, 10 cm). B undoes (50 steps). |
| **Floor-junction (guaranteed fallback)** | Chosen automatically when nothing is hit. Point at 2 spots where each wall meets the floor; the ray is intersected with `floorY`. Corner mode (click floor corners) and the 3-click rectangle mode use the same floor ray. The same snapping and undo apply. |
| Ceiling | Point at it, or use a slider (default 2.40 m). |
| Doorway | Click the left jamb, then the right; snaps to the wall within 0.3 m. Height defaults to 2.03 m. Kind is `door` or `opening`; `usuallyOpen` is yes, no or unknown. Warns if narrower than 0.62 m (enemies can't pass). |
| Furniture | Corner A, then corner B, then a depth point. Height comes from hitting the top surface, or a slider. Yaw snaps to the room axes (±5°). Presets: sofa, table, bed, wardrobe, with handles to adjust. |
| Hazards | Polygons with a buffer: stairs 1.0 m; fragile, pet and other 0.5 m. |
| Room lighting | Brightness and colour temperature, adjusted against a reference virtual object; stored per room (`lighting`, §7). Used when `light-estimation` is absent. A Space Setup room gets a default to start from. |
| Safe zone (every session) | "Stand where you want to play, face your main doorway, pull the trigger." Radius 0.5–0.8 m (default 0.6). Stored as `{center, radius, facing}`. At setup it warns if mapped obstacles lie within the radius plus 0.8 m. Runtime behaviour is below. |
| Connecting rooms | Placing a doorway in room B within 0.5 m and ±20° of an unlinked doorway in room A prompts "Link Living room ↔ Hallway?". The link stores the transform between the two rooms (`bFromA`) and its error. Links with more than 0.3 m of error are refused. |
| Re-scan one room | Depends on the kind of room; see "Re-scanning one room" below. |
| Check panel | Polygon is simple; area is in range; doorways lie on walls; furniture is clipped to the floor; a navigation preview colours cells walkable, inflated or blocked; doorway reachability. |
| Naming | Preset names plus our in-world keyboard. |

**Re-scanning one room**
- **Manual room:** re-scanning means re-editing it in the `RoomEditor`: re-trace walls, move handles, delete elements.
- **The current Space Setup room:**
  - Re-import what Space Setup now holds and match old elements (walls within 10° and 0.3 m, furniture IoU > 0.3).
  - Replace matched auto-imported elements and add new ones as `suggested`. **Never touch manual elements.** Increment `revision`.
- **Making a different room the Space Setup room:** run `initiateRoomCapture` while standing in it.
  - **Warning shown first:** this may wipe the origin's anchors, which belong to every room, and may replace the old Space Setup room.
  - **Afterwards:** re-import, then every anchored room runs the §7 restore. A room whose anchor is gone falls back on its own (neighbour chain, then 2-point). Rooms stay independent: one room's failure never blocks another.
  - The old Space Setup room keeps its stored geometry and becomes a manual-only room.

**Safety while mapping**
- Enemies and combat are paused in Setup mode.
- The player walks to another room only in Setup mode, with passthrough clear.
- **Play never requires walking through a real doorway.**

**Safe zone during play** (`safety/SafeZone`, `safety/ObstacleWarnings`; thresholds are *(design)*, r = zone radius)

| Condition | Response |
|---|---|
| Head beyond 0.8 r | Floor ring visible, soft tick sound |
| Head beyond 0.9 r | Ring plus edge highlight; enemies freeze and stop firing |
| Head beyond r, or a crouch or lean that takes it there | **Full pause** (PauseManager trigger "left safe zone"): game time and AI frozen, enemies and effects hidden, passthrough clear, an arrow with "Return to your spot" |
| A hand or controller beyond r + 0.7 m, or within 0.25 m of a mapped wall, furniture box or hazard buffer | Haptic 0.3 / 30 ms (a sound with hands), plus an outline of that surface. It is only as accurate as the map. |
| Head within 0.4 m of a mapped wall, furniture box or hazard buffer | Outline, and enemies freeze |

- **Resume:** the head is back within 0.7 r for 0.5 s, tracking has been fine for 0.4 s, the player presses Resume, then a 3-2-1 countdown with enemies frozen.
- **Safety violation** (the Phase 7 exit criterion; SafeZone logs each one with a timestamp). Any of:
  - game time running while the head is beyond r;
  - game time running while a head or hand is inside a mapped obstacle or hazard buffer;
  - a spawn or enemy shot while paused;
  - an objective or pickup placed outside the zone.
- **Sensor-based warning, where supported (optional, later):** with depth granted, a GPU-only tint of real surfaces within 0.5 m of the hands, drawn in a custom depth shader with no CPU readback. UNRELIABLE until checked on device.

### 6.3 Simplified geometry (`GeometryBuilder`)

**Collision shapes (room-local, 2.5D)**
- **Walls**: segments 0.10 m thick, placed **outside** the floor edge so the inner face matches the real wall. Split around doorways into left, right and lintel pieces.
- **Furniture**: oriented boxes.
- **Floor and ceiling**: analytic planes.
- Bullets test only the current room and the rooms linked to it.

**Fallbacks when scan data is missing**

| Missing | Fallback | Walkable? |
|---|---|---|
| Ceiling | 2.40 m | — |
| Walls | Extruded from the floor edges (`inferred`) | — |
| Floor, but the walls close a loop | Polygon from intersecting the wall lines | Only after the user confirms |
| Floor, and the walls don't close | Convex hull, marked `UNVERIFIED` | **Never** |

**Clutter from the global mesh** (off by default). The worker rasterises the mesh into the room grid; any geometry 0.10–1.8 m high inside the floor becomes `CLUTTER`. The data is a snapshot from when Space Setup ran, so furniture moved since then is wrong.

---

## 7. Saving and restoring multiple rooms

### Storage

IndexedDB database `mrfps`, version 1, with these stores:

| Store | Key | Contents |
|---|---|---|
| `meta` | `'manifest'` | The house manifest (an index only; rebuildable, see Load) |
| `rooms` | `id` | One record per room |
| `connections` | `id` (multi-entry index on `roomIds`) | Links between rooms |
| `roomHistory` | `[roomId, revision]` | The last 5 revisions of each room |
| `quarantine` | auto-increment | Records that failed to load, with the error |
| `navCache` | `roomId` | Optional cached navigation data; always rebuildable |
| `settings` | `id` (`'active'` plus one per profile) | Player profiles: handedness, stance, calibration, holster offsets, comfort and realism settings. Each record has a schema version and a validator. |
| `diagnostics` | auto-increment | Binary blobs from the recorder and the hitch log, flushed only on pause, `visibilitychange` or session end; capped at 20 MB, oldest dropped *(design)* |

The wrapper (new code) has: lazy open, `onversionchange`/`onblocked`, abort-safe single- and multi-store transactions, and a compare-before-write helper (`putIfSame`).

### Schema

These types are documented as JSDoc `@typedef`s in `src/data/schema.js`. All coordinates are room-local metres with y = 0 at the floor.

```ts
type Vec2=[x:number,z:number]; type Pose={p:[number,number,number]; q:[number,number,number,number]};
type Prov={source:'space-setup-plane'|'space-setup-mesh'|'manual'|'hit-test'|'inferred';
           confidence:number; verified:boolean; xrLabel?:string; createdAt:number; updatedAt:number};
HouseManifest {schema:'mrfps.house'; schemaVersion; houseId; name; roomIds:string[]; connectionIds:string[];
  anchorBudget:{max:6,spare:2}; pendingAnchorDeletes:string[]; activeStorey:number; appVersion; createdAt; updatedAt}
RoomRecord {schema:'mrfps.room'; schemaVersion:number;          // map format version
  id:string /*crypto.randomUUID()*/; name; storey; revision:number /*edit version*/;
  status:'draft'|'partial'|'complete'|'quarantined'; createdAt; updatedAt; lastPlayedAt?;
  floor:{polygon:Vec2[] /*CCW ≤64*/; holes:Vec2[][]; prov:Prov};
  bounds:{min:Vec2; max:Vec2; area:number};                  // floor dimensions (derived)
  ceiling:{height:number; prov:Prov};
  walls:WallSeg[]; doorways:Doorway[]; furniture:Obstacle[]; hazards:HazardZone[];
  safeZone?:{center:Vec2; radius:number; facing:number; updatedAt:number}; // last zone used here; one-tap confirm next session
  lighting?:{brightness:number; colorTempK:number; prov:Prov}; // manual calibration (§6.2)
  anchor:AnchorRef|null;
  alignment:{method:'anchor'|'space-setup'|'two-point'|'neighbor-chain'; lastResidual?; lastVerifiedAt?};
  spaceSetupSignature?:{floorArea; floorPolygon:Vec2[]; wallCount; importedAt};
  nav:{cellSize:0.10; useMeshClutter:boolean}; geometryHash:string /*FNV-1a → nav cache key*/;
  extra?:Record<string,unknown> }                              // unknown fields kept (forward-compatible)
WallSeg {id; a:Vec2; b:Vec2; height; thickness; prov}           // wall position + dimensions
Doorway {id; wallId?; center:Vec2; tangent:Vec2; normal:Vec2 /*into room*/; width; height;
  kind:'door'|'opening'; usuallyOpen:'yes'|'no'|'unknown'; connectionId?; prov}
Obstacle {id; label; center:Vec2; half:Vec2; yaw; bottom; top; prov}
HazardZone {id; kind:'stairs'|'fragile'|'pet'|'other'; polygon:Vec2[]; buffer}
AnchorRef {uuid; anchorFromRoom:Pose; createdAt; lastRestoredAt?; restoreFailures; second?:{uuid; anchorFromRoom:Pose}}
Connection {schema:'mrfps.conn'; schemaVersion; id; a:{roomId,doorwayId}; b:{roomId,doorwayId};
  status:'suggested'|'confirmed'|'dormant'; bFromA?:Pose; linkResidual:number; createdAt; updatedAt}
PlayerProfile {schema:'mrfps.profile'; schemaVersion; id; name; handedness:'right'|'left'; stance:'standing'|'seated';
  standEye?:number; seatedEye?:number;
  holster:{mount:'hip'|'thigh'|'chest'|'cross'; side:'right'|'left'; dx; dy; dz; touchOffset?:[number,number,number]};
  comfort:Record<string,number|boolean|string>; realism:Record<string,number|boolean|string>; updatedAt}  // keys in §8
```

### Operations

| Operation | Behaviour |
|---|---|
| **Save** | One read-write transaction over `rooms`, `roomHistory` and `meta`. The old version goes to history; the revision goes up by 1; a new `geometryHash` is computed; history is trimmed. Saves happen only in the editor, menus or pause (debounced 1 s), plus on `visibilitychange` and session end. **Never during combat.** |
| **Load** | **Enumeration:** the loader walks the `rooms` store directly with a cursor; it does not follow `manifest.roomIds`. The manifest is validated like any other record and rebuilt from `rooms` and `connections` when it is invalid or out of sync (the scanner rebuilt its `meta` index the same way, SC:1577-1579). **Per room:** parse, then migrate (a chain of pure `MIGRATIONS[n]` functions), then validate, then try a repair (drop bad elements). If all of that fails, the record goes to `quarantine`. The room graph is built from valid rooms only; links to missing rooms become `dormant`. **One bad room, or a bad manifest, never blocks the others.** |
| Edit / re-scan | The editor works on a copy; committing it is a Save. Re-scanning follows §6.2. |
| **Delete** | Delete the record; set its links to `dormant`; queue its anchor UUID for deletion. Deleting an anchor needs a live session, so the queue is flushed at the next session start. No other room is touched. |
| Incomplete scans | `draft`: no verified floor; not playable; the menu offers "Resume mapping". `partial`: verified floor, inferred walls or ceiling; playable. `complete`: every doorway linked or marked isolated, and alignment is OK. |
| Versioning | IndexedDB `onupgradeneeded` changes the structure (stores and indexes). Each record carries its own `schemaVersion` and is migrated lazily. A record newer than the app opens read-only. The original is kept in history. Settings records follow the same rules. |
| Check | All numbers finite; coordinates within ±30 m; polygon simple with 3–64 points; area 1–200 m²; doorways on the boundary within 0.15 m; IDs unique. |
| Backup | Export and import the whole house as one JSON file. Anchors are removed on import, because they belong to one device and origin. Call `navigator.storage.persist()` once (UNRELIABLE). |

### Restoring each room's position (at session start, all rooms in parallel and independent)

1. **Restore the anchor.** Call `restorePersistentAnchor(uuid)` with a 5 s timeout and retries after 0.25, 0.5, 1, 2 and 5 s [IWSDK]. Then poll for its pose; the scanner waits up to 600 frames (SC:3452).
2. **Cross-check.** Compare with the Space Setup walls by least-squares on wall normals and offsets.
   - A residual under 3 cm is accepted automatically.
   - Under 5 cm the room is `aligned`.
   - Otherwise it is `suspect`.
3. **If the anchor fails** (UUID evicted, site data cleared, private mode): place the room relative to a neighbour through a confirmed link's `bFromA`. The room is then `provisional`. Ghost walls are shown over passthrough; when the user confirms, a new anchor is created.
4. **Otherwise, 2-point re-alignment.** The user marks two stored corners at least 1.5 m apart.
   - The distance between them must match within max(5 cm, 3 %).
   - The room's rotation θ and offset t are computed from the two points; with more points, a least-squares (Kabsch) fit.
   - The thumbstick nudges by ±0.5° and ±1 cm.
   - Confirming creates a new anchor and queues the old one for deletion.
5. **Excluded rooms.** Rooms that are `unaligned`, `provisional` or `tracking-lost` get no spawns, no navigation and no occluders. **The rest of the house keeps working.**

**Room alignment state** (owned by `mapping/RoomManager`, which also holds each room's `worldFromRoom`)

| State | Entered from | Gameplay in the room | Leaves to |
|---|---|---|---|
| `unaligned` | Session start; a failed restore; a `reset` without a transform on an unanchored room; a `suspect` room that failed re-alignment | None: no spawns, navigation or occluders | `aligned` (anchor restored and the cross-check passes, or 2-point confirmed); `provisional` (neighbour chain) |
| `provisional` | Neighbour chain | None until confirmed; ghost walls shown | `aligned` (the user confirms, and a new anchor is created); `unaligned` (the user rejects) |
| `aligned` | Restore with residual under 5 cm; 2-point or provisional confirmed; a `suspect` room recovered | Full | `suspect` (pose jump over 15 cm, or cross-check residual 5 cm or more); `tracking-lost` (pose null for more than 2 s) |
| `suspect` | From `aligned`, as above | Occluders and navigation stay for enemies already inside. No new spawns, and no new paths into the room. | **Space Setup room:** plane refinement with a residual under 5 cm for 2 s → `aligned`. **Other rooms:** once the pose has been steady for 2 s, the next pause or wave break shows ghost walls with a one-tap "Lined up?". Yes → `aligned`; No → 2-point re-alignment → `aligned`. Skipped, or drift over 30 cm → `unaligned`. |
| `tracking-lost` | Pose null for more than 2 s | Enemies hidden, spawns paused | The previous state once the pose has been back and steady for 1 s (`suspect` if it came back more than 15 cm away) |

**Every frame**
- Each room's world pose is `worldFromRoom = worldFromAnchor(t)·anchorFromRoom`. That is at most 8 `getPose` calls *(design: about 0.05 ms)*.
- Poses are cached inside the frame loop, because an `XRFrame` is dead after any `await` (SC:1621).

| Change in a room's pose between frames | Action |
|---|---|
| Under 2 cm and 0.5° | Apply directly |
| Up to 15 cm | Blend over 0.5 s |
| Over 15 cm | Mark `suspect` |
| Pose null for up to 2 s | Keep the last pose |
| Pose null for more than 2 s | `tracking-lost` |

**On a `reset` event**
- Anchored rooms need nothing.
- An unanchored room with a transform T: `worldFromRoom ← inverse(T)·worldFromRoom`. The sign convention must be verified on device; the scanner's own correction is unproven.
- Without a transform: the room becomes `unaligned`.
- Always pause and re-confirm the safe zone.

**Anchor budget**
- One anchor per room, at the floor centroid.
- Rooms longer than 6 m get a second anchor if the budget allows: 1° of yaw error is 8.7 cm at 5 m.
- At most **6 anchored rooms plus 2 spare**. The spares let us create a new anchor before deleting the old one.
- Beyond 6 rooms: place through a neighbour, or re-align with 2 points each session.

---

## 8. Virtual hip holster

There is no hip tracker. Hip yaw and position are **estimated** from the head and the controllers, with a new estimator. Its tuning numbers come from CQC's tested one (CQC:56895-57060, config at 3386-3410); no CQC code is copied.

**Calibration**
- **Standing height.** "Stand tall, look ahead" averages the eye height over 1 s. It is clamped to 1.45–1.98 m. Body scale is `s = eye/1.70`.
  - Measured again after a `reset` or a tracking loss. Saved in the player profile (`settings` store, §7).
- **Seated height (seated mode).** "Sit as you will play, look ahead" averages the eye height over 1 s, clamped to 1.00–1.40 m *(design)*.
  - Body scale comes from the profile's standing height if one was measured, otherwise `s = seatedEye/1.20` *(design)*.
  - While seated, the floor-drift prompts, the crouch logic and crouch-dependent cover are all off.
- **Floor drift (standing only).** Eye height reading 6 cm high for 20 s, or 10 cm low for 60 s, suggests recalibrating (CQC:3366-3371).
- **Optional "touch your holster".** Hold the gun-hand controller where you want the holster and hold the trigger for 1 s. That point is stored as an offset in the hip frame.
  - It is rejected if it is more than 0.45 m from the estimated pelvis horizontally, or outside 0.4–1.2 m above the floor.

**Hip-yaw estimator**
1. **Head direction while looking down.** Flatten `forward + up·sign(pitchDown)`, so looking down at the holster doesn't spin the result. Smoothing goes from 45 ms (looking ahead) to 160 ms (looking down).
2. **Freeze while looking down.** `smoothstep(0.68, 0.90 rad, pitchDown)` blends in a frozen state where the dead zone widens from 0.75 to 2.05 rad and following almost stops.
3. **Dead zone.** The head can turn about ±43° (0.75 rad) before the hips follow. They catch up at a capped speed (5 rad/s, or 1.2 rad/s when frozen), so the holster never jumps.
4. **Hands vote.** Raised controllers held in front pull the hips toward them (the gun hand counts ×1.25).
   - No vote while looking down, or from a hand that is low and reaching for the holster or pouch. That exclusion was a bug fixed in CQC.
5. **Body tracking (experimental, off by default).** Only when the experimental setting is on, which adds `body-tracking` to the session request (§3). If `frame.body` (UNRELIABLE) then gives the hips for more than 1 s, it is blended in at no more than 50 %.

**Holster position**
- The pelvis is estimated through a neck chain from the eyes (CQC:57040-57060).
- Standing holster height is about `eye × 0.577`, which is 0.98 m at a 1.70 m eye height (CQC holster `[0.2,−0.72,0.02]·s`, CQC:3517).
- The body is offset +8 cm forward along the hip heading (CQC-LOG:488). Without it the holster only comes into view at about a 60° nod; with it, at about 45°.
- In the pelvis frame: strong side x = ±0.18·s, y = +0.02·s, z = +0.03·s back; the muzzle is canted 10–15° to the rear.
- **Settings:** height ±15 cm, forward/back ±10 cm, outward ±5 cm; side Right or Left; mount Hip, Thigh, Chest or Cross-draw. Seated mode defaults to thigh or chest, because armrests block the hip.
- The magazine pouch mirrors to the weak side, at the front of the hip.
- The drawn holster pose is smoothed (critically damped, 60–100 ms). **The grab test uses the same smoothed pose, so what you see is what you grab.**

**Drawing and holstering**

| Event | Rule | Haptic / sound |
|---|---|---|
| **Draw** | The empty strong hand is within **0.13 m** (CQC `grabReach`) and either squeeze rises past 0.55 (released below 0.35), or squeeze was already pressed in the last 150 ms when the hand arrived. The gun settles into the fitted grip in **0.15 s**. Any grab within 12 cm of the grip, at any angle, snaps to the fitted grip (CQC `GRIP_SETTLE`, CQC:61974). | 0.35 / 18 ms; kydex release and cloth |
| Trigger gate | The trigger is ignored until it has been seen below 0.3 after the draw, the muzzle is more than 0.15 m from the holster, and it doesn't point at the estimated thighs. | — |
| **Reholster** | Let go within **0.24 m** (CQC `slotReach`, CQC:3519). The gun travels into the holster in **0.34 s** along a smooth arc with 5 cm of sideways bow (CQC:3520). | 0.4 / 20 ms; snap |
| Let go anywhere else | After 0.3 s the gun returns to the holster. It either swaps to a pre-warmed, always-transparent copy of its materials (or dithers with `alphaHash`, set from creation) and fades out, or simply scales down and reappears. It never flips `transparent` on a live material, which would compile a new program mid-game (§10). Nothing ever has to be picked up off the floor. | — |
| Controller pose lost for more than 0.25 s | Auto-holster | — |
| Empty hand enters the grab sphere | One tick on entry, so the holster can be found by feel | 0.08 / 10 ms |

**Hand-tracking mode** (UNRELIABLE for combat; offered as a hands-free mode)
- Grab is a finger curl, held for 3 frames; grab radius 0.16 m.
- Firing is an index-finger curl with large hysteresis (fires above about 1.0 rad, resets below about 0.6 rad).
- If any joint is null, firing is blocked; the gun auto-holsters after 0.5 s.
- There are no haptics on hands, so sounds are louder.
- Controllers are recommended for combat.

**Comfort settings** (Phase 5; stored in the player profile, §7) *(design)*
- **Body:** stance (standing / seated), dominant hand, holster mount and offsets, auto-holster on/off.
- **Weapon:** reload mode (manual / assisted / button), ammo display (off / witness holes / digits), recoil scale (1.0 realistic / 0.5), trigger break point (0.6–0.85).
- **Feedback:** haptic strength, flash and full-view tint intensity, audio levels (master, own gun, enemies).
- **Safety:** safe-zone radius; ring visibility (always / near the edge only); enemy proximity limit (default 2.5 m, can only be raised).
- **Threat:** threat arc (front 180° / 270° / 360°), max active enemies, gore on/off.
- **Seated mode** also sets a zone of about 0.35 m of head movement, enemies only in the front 180°, and no crouch-dependent cover.

---

## 9. How enemies navigate the house

**A grid per room** *(design)*
- Built in a worker, in room-local coordinates, aligned with the room's axes, with **0.10 m cells**.
- At this size a 0.75 m doorway is 7–8 cells, with about 0.36 m of clearance at its centre; an enemy needs 0.28 m (radius 0.25 + 0.03). With CQC's 0.20 m cells (CQC-LOG:2295), doorways quantise badly.
- **Size.** The grid covers the floor plus a 0.5 m margin on each side (for doorway outer points).
  - A 6×5 m room is 3,000 cells; with the margin its grid is 7×6 m = 4,200 cells. That is about 30 KB of cell data (7 B per cell) plus about 85 KB of search buffers (20 B per cell).
  - The largest room the validator accepts (200 m², about 14×14 m) is about 15×15 m with the margin, which is 22,500 cells. That is about 160 KB of cell data, plus about 90 KB per doorway distance field (4 B per cell).
  - The search buffers are allocated once, sized to the largest room, and shared by all rooms (about 450 KB).
  - Bake time grows roughly linearly: about 1–3 ms for a typical room and 5–15 ms for the largest, in the worker.

**Cell flags:** `INSIDE`, `WALL`, `FURN`, `HAZARD`, `PLAYER_ZONE`, `DOOR`, `UNVERIFIED`, `CLUTTER`. Each cell also stores:
- the distance to the nearest blocked cell (exact Euclidean distance transform);
- which enemy sizes can walk there;
- the height of the tallest obstacle, for 2.5D line of sight;
- a connected-region ID.

**What blocks a cell**
- Any furniture footprint (+2 cm), whatever its height.
- Hazards plus their buffer.
- The safe zone plus 1.2 m (configurable).
- Every doorway, unless its link is `confirmed` and `usuallyOpen !== 'no'`. An unlinked doorway never leads into unmapped space.

**Only verified floor is walkable.** A walkable cell is `INSIDE` and verified, or a carved `DOOR` cell, with enough clearance. `UNVERIFIED` cells are never walkable, never a spawn and never a goal.

**When it is rebuilt.** Only after an edit or re-scan, detected by a change in `geometryHash`, and only that room. **Anchor movement never triggers a rebuild**, because everything is room-local.

**Doorway graph and paths**
- **Graph.**
  - **Nodes** are the two sides of each doorway. **Edges inside a room** are grid distances. **Door edges** cost 0.8 m.
  - The graph has at most about 40 nodes and uses plain Dijkstra. A straight-line heuristic in world space isn't safe while room anchors disagree.
  - Rooms that are not aligned, quarantined or on another storey are removed from the graph. A `suspect` room gets no new paths into it.
- **Distance fields.** For each doorway, a distance field is precomputed in the worker (2–4 bytes per cell). Moving to a doorway is then a lookup, with no search during play.
- **Other targets (cover, engagement points): A\* runs in `nav.worker`**, where the grid already lives.
  - The reply arrives 1–2 frames later, which is fine for 10 Hz decisions.
  - Replies are transferred typed arrays, not object graphs, so the main thread does no heavy structured-clone work.
  - The main thread keeps a read-only copy of the flags, clearance and heights, for steering and line of sight.
  - The search itself: reusable typed-array buffers (CQC-LOG:1051/1874); 8-connected with no corner cutting; a cost penalty near walls; other enemies' reserved cells cost 3×; the expansion cap is the room's cell count. The path is smoothed with grid line checks into a pooled `Float32Array`.
- **Main-thread fallback,** if worker latency proves a problem. CQC measured `findPath` in desktop Node at 0.56 ms in open field and 22 ms around a 36 m wall (CQC-LOG:1051), and Quest JS is several times slower.
  - The search state lives in the pooled typed buffers, and the search resumes across frames.
  - Each frame gets an expansion quota: start at about 1,000, then in Phase 6 measure expansions per ms on the Quest and set the quota to ≤0.4 ms.
  - The cap is the room's cell count.
- **Paths across rooms are lazy.** Only the current room's part of the path is planned; the next part is planned on entering the next room.
- **Crossing a doorway uses doorway coordinates.** In room A: `u=(p−cA)·tA`, `v=(p−cA)·nA`. In room B: `pB = cB − u·tB − v·nB`. The visual position is blended over 0.3 s, so a mismatch between two room anchors never makes an enemy teleport.

**Steering and collision**
- **Choosing a velocity.** Each frame the enemy picks one of 13 candidate velocities. The score combines:
  - how far it is from the desired velocity;
  - time to collision with other enemies and with the player's body (a 0.35 m circle; enemies keep at least 1.2 m away);
  - a penalty for being near walls.
- **Wall clamp.** Moving into a blocked cell is tried as x only, then z only, else the enemy stays put. **Enemies can never enter a real wall or furniture.**
- **Doorways.** One enemy at a time passes through a doorway; the others queue 0.6 m before it. After 4 s of waiting, the enemy re-plans through another doorway.
- **Stuck rule** (CQC-LOG:1840): less than 0.15 m of progress in 0.7 s means re-plan, at most twice, then make a new decision.

**Perception**
- **Sight.** A 2.5D grid walk from the enemy's eye to your head and chest: a cell blocks if its obstacle is taller than the ray at that point.
  - It can pass through linked doorways, up to 2 rooms deep.
  - 120° view cone; he always notices you within 2.2 m.
  - Awareness fills up: 0.3 means suspicious, 1.0 means alerted (CQC:3618-3628).
- **Hearing.** Room-to-room path distances are precomputed with Floyd–Warshall. A shot is heard up to about 40 m of path, and each closed door counts as +6 m.
  - Hearing gives a room or a doorway, not your exact position.
- **Behaviour** follows CQC's tested values: patrol, investigate, engage, take cover with peeking, flank, search. Reaction time 0.45–0.85 s; aim error 0.07 rad settling to 0.012 rad over 0.9 s.
  - **Flanking needs a loop in the room graph** (a second doorway into your room). Otherwise he uses the other side of the same doorframe.
  - **At most 2 enemies shoot at once.**
  - **Enemies always come to the player's post.** Nothing in play asks the player to move.

**Spawning**

*Enemies are pooled.* At load, the maximum alive count (12) of enemy instances is prebuilt. Each one gets:
- its `AnimationMixer`, with every `clipAction` already created and played and stopped once;
- its weapon, hit capsules and voice slots.

Each instance and each LOD level is warm-drawn (§10). Spawning is then reset, place and make visible; death returns the instance to the pool. Nothing is cloned, skinned or bound during a fight.

*Checks made in advance, in the worker:*
- verified walkable cell, with clearance at least the radius + 0.10 m;
- open in at least 5 of 8 directions at 0.32 m and 4 of 8 at 0.6 m (CQC-LOG:1838);
- in a connected region that reaches a doorway;
- at least 0.3 m from furniture (never under a table);
- at least 1.0 m from hazards and 1.5 m from stairs;
- on the active storey (stairs are never navigated in v1).

*Checks at spawn time:*
- the room is `aligned` and its anchor is tracked this frame;
- at least 2.5 m horizontally from you (or the comfort setting's proximity limit, if higher) and 4 m of path from the safe-zone edge;
- out of your sight (or outside ±60° of where you're looking), and never visible within 3 m;
- more than 0.8 m from other enemies.

*Preference order:*
1. The room behind a linked doorway, so enemies walk in.
2. Behind cover in the play room.
3. Out of view at the maximum valid distance, with a sound cue.

If nothing passes, nothing spawns, and a reason code is logged.

**Update rates** *(design)*

| Work | Rate |
|---|---|
| Steering; root position | Every frame |
| Perception and decisions | 10 Hz each, staggered round-robin |
| Path searches | In `nav.worker`; main-thread fallback with an expansion quota of ≤0.4 ms per frame |
| Animation (mixer, bones, aim/IK) | Full rate when visible and within 8 m; 20 Hz otherwise, staggered round-robin like perception, so updates never bunch into one frame |

Target: at most 1 ms average and 2 ms in the worst frame on the main thread for mapping, navigation and AI combined, plus at most 1.5 ms for enemy animation and skinning with 8 visible (§10). **Zero allocations per frame.**

---

## 10. Keeping Quest 3 performance

**Budgets.** These are *(design)* targets to validate on the headset. They assume `WebGLRenderer`, two-pass stereo, 4x MSAA, passthrough (the room itself is never rendered), 72 Hz as the floor and 90 Hz when there is headroom.

| Metric | 72 Hz | 90 Hz |
|---|---|---|
| Frame period | 13.9 ms | 11.1 ms |
| Main-thread JS per XR frame (simulation + three submit) | ≤7 ms | ≤5.5 ms |
| …of which mapping, navigation and AI | ≤1 ms average, ≤2 ms peak | same |
| …of which enemy animation + skinning (mixer, bone hierarchy, aim/IK; its own PerfMonitor system) | ≤1.5 ms with 8 visible | ≤1.5 ms with 6 visible |
| GPU time ("App GPU" in OVR Metrics) | Steady-state target ≤10 ms (about 72 %), measured in the worst-case firefight at the end of the 20-minute soak. Hard ceiling 11.5 ms. | Target ≤8 ms, hard ceiling 9 ms. 90 Hz is allowed only when this target holds in that scene. |
| Draw calls in `renderer.info`, both eyes | ≤200 (hard limit 260) | ≤160 |
| Triangles, both eyes | ≤1.2M | ≤800k |
| Enemies visible / alive | ≤8 / ≤12 (default 4 active; pool of 12) | ≤6 / ≤10 |
| Per enemy | LOD0 ≤20k triangles (within 3.5 m), LOD1 ≤6k (within 9 m), LOD2 ≤2k; ≤2 draws; ≤64 bones | same |
| Held gun | ≤30k triangles; 2 draws per eye (one rigid-boned gun mesh plus the magazine, §14); one material; 2048² UASTC textures | same |
| Lights | Hemisphere light or probe, 1 directional light without shadows, ≤2 pooled point/spot lights that always exist (only intensity is animated). `fpScene` has the same set. | same |
| Real-time shadow maps | 0 (one shared instanced mesh of blob shadows) | same |
| GPU texture memory | ≤150 MB (stretch goal 120 MB; CQC reached 208 MB) | same |
| Shader programs | ≤40, all built and warm-drawn before XR (below); `renderer.info.programs.length` flat after warm-up | same |
| Garbage | Game-attributable ≤16 KB per frame, measured once with controllers and once with hands; 0 in hot loops (CQC measured 49–92 KB). Browser wrapper objects (viewer pose, views, depth information, anchor poses) are counted separately. | same |
| Texture uploads during play | ≤1 per frame, canvas panels included, all through one upload queue | same |
| Audio | ≤8 HRTF panners, ≤24 voices | same |
| Particles | One draw per effect type; ≤400 particles | same |
| Framebuffer scale | Starts at 1.0, cap 1.2. CQC hitched at 1.4 with foveation 0.2 [D2]. | same |
| Foveation | Starts at 0.5; rises in 0.25 steps to 1.0 under load | same |

**Warm-up: no first-use hitches**

In r187, `compileAsync` only builds programs (`compile()` traverses the scene and calls `getProgram`, WebGLRenderer.js:1460-1500).
- **Without `KHR_parallel_shader_compile`,** the promise resolves after one 10 ms timeout without waiting for the link (WebGLProgram.js:954). The blocking link wait then happens on the first draw, inside XR.
- **Even with the extension,** compiling does not upload textures, create vertex and index buffers, or build skeleton bone textures (WebGLRenderer.js:2707). Mobile drivers can also finish shader variants on the first real draw.

So the warm-up is a draw, not just a compile:
1. Set `renderer.debug.checkShaderErrors = isDev` before loading. Reading the info logs is a sync wait per shader (CQC-LOG:1628).
2. Build every pool first and add it to the scene:
   - all 12 enemy instances, each with every LOD level;
   - the gun and its parts, magazines, muzzle flash, decals, brass, particles, blob shadows;
   - the UI panels, the ghost-wall material and the fade materials.

   Call `setColorAt(0, white)` on every instanced pool, so `instanceColor` exists before compiling (it is created lazily and is part of the program key, InstancedMesh.js:322, WebGLPrograms.js:214).
3. Call `renderer.compileAsync()` on the main scene and on `fpScene`.
4. Call `renderer.initTexture()` on every texture, one per frame (one upload every 30 ms or so, CQC's measured safe rate, CQC-LOG:1628).
5. Render the warm-up set once to the default framebuffer, before entering XR:
   - Use `setRenderTarget(null)`, never an offscreen target, because `toneMapping` and `outputColorSpace` in the program key depend on the target (WebGLPrograms.js:179-217). (Blackout found that `setRenderTarget(null)` *during* XR gives a black screen, so this step runs only before XR.)
   - Force each LOD level visible in turn.
   - This draw also creates the vertex buffers, index buffers and bone textures.
6. After `setSession`, show an opaque "Get ready" panel for about 1 s and draw the pools once, just behind it, into the XR framebuffer. This catches driver variants against the real framebuffer state, and three's lazily created depth-sensing `ShaderMaterial`.
7. **Pass:** `renderer.info.programs.length`, `info.memory.textures` and `info.memory.geometries` don't grow after warm-up. Dev builds assert this.

**Rules against hitches**
- **Pool everything:** enemies (§9), muzzle flashes, magazines, spent cases, decals, particles, sound voices, path buffers. In CQC, pre-built pools, the texture upload queue and slicing `skinCullTick` together took the worst frame after a kill from 80 ms to 27 ms. That was measured with rendering stubbed, and 27 ms still misses 2 frames at 72 Hz.
- No `new` in per-frame or per-shot code.
- **Nothing may change a program-key property after warm-up.** That covers:
  - the light count;
  - a swap to a material that wasn't warmed;
  - `transparent` (the program's `opaque` flag, WebGLPrograms.js:272), `alphaTest > 0`, `instanceColor`;
  - fog and environment.

  Fades use pre-warmed transparent materials, or `alphaHash` set from creation. Dev builds assert that `renderer.info.programs.length` stays constant.
- **Canvas panels.**
  - A panel redraws only when its value changes and only while it is visible.
  - At most one panel upload per frame, through the shared upload queue.
  - UI textures use `generateMipmaps = false` with `LinearFilter`; three's defaults regenerate mipmaps on every upload (Texture.js:48/257).
  - Static and dynamic canvases are kept separate, and the dynamic ones are small.
  - Numbers that change are drawn from a digit atlas on instanced quads, with no upload.
  - CQC fixed the same pattern of screens redrawing and re-uploading on every kill (CQC-LOG:1627).
- **Audio.**
  - `SoundBank` fetches through a queue (6 at a time, 2 retries) and decodes every clip before Enter.
  - The convolver's buffer is assigned once at load, with an impulse response of ≤1.5–1.8 s. Assigning `ConvolverNode.buffer` partitions and FFTs the response synchronously on the main thread.
  - Nothing is decoded and no `.buffer` is assigned during play.
  - Per-room reverb, if wanted: one convolver per response, built at load and crossfaded, as in CQC's `ROOMAC` (CQC-LOG:306).
  - The 8 panners are created at unlock, so they don't play silence while the HRTF database loads.
- **Hand joints.**
  - `Input.js` never calls `renderer.xr.getHand`: three would then call `getJointPose` for all 25 joints of each hand every frame (WebXRController.js:243).
  - Joints are read with `frame.fillPoses(jointSpaces, refSpace, poses)` into a preallocated `Float32Array(25*16)` when it exists, with `Array.from(hand.values())` cached once per input source.
  - Per-frame code iterates arrays, never Maps or Sets (Map iterators were CQC's top garbage source).
- **No synchronous storage in play:** no `localStorage.setItem`, `JSON.stringify` or IndexedDB write from the frame loop. Diagnostics flush only on pause, `visibilitychange` or session end.
- Physics, AI or mapping work that takes more than 2 ms goes to a worker. **Never wait on a worker synchronously.**
- Wrap the frame loop in try/catch (SC:3442).
- Clamp the frame delta to 0.1 s after a pause. Springs run in 4 ms sub-steps with a runaway reset.
- **No transmission materials** (they add a pass per eye) and **no post-processing**.
- Never read depth back to the CPU.

**Culling and shared materials**
- **Per-object frustum culling.** three's per-object culling stays on everywhere, which needs correct bounds.
- **Skinned enemies.** Each enemy has one bounding sphere around its pelvis, sized from the bones' reach and refreshed per frame. Never use the bind-pose bounds: in CQC, standing bounds made fallen bodies vanish (CQC-LOG:161; `skinCullTick`, CQC-LOG:1625).
- **Instanced pools.** An `InstancedMesh` is culled as a whole by one bounding sphere over all its instances, so a house-wide pool of decals, brass or blob shadows is effectively never culled.
  - Split pools per room (one `InstancedMesh` per room, sharing geometry and material), and call `computeBoundingSphere()` after placing an instance.
  - Or use `BatchedMesh`, which culls each instance (`perObjectFrustumCulled`, on by default).
  - Empty pools are hidden: CQC drew empty instanced meshes (CQC-LOG:1264).
- **Rooms.** Only the current room and rooms adjacent through linked doorways are drawn, with their occluders, decals and enemies. Enemies in hidden rooms still simulate at the AI rate.
- **Shared materials.** One material per asset and look. Pooled enemies share geometry and materials, and per-instance variety comes from instance attributes, not new materials.

**Quality ladder**
- **Start:** 72 Hz, foveation 0.5, scale 1.0.
- **Lower** when there are at least 3 intervals over 1.5× the period within 2 s, or when the CPU callback's p95 is above 75 % of the period. Step down in this order:
  1. refresh rate;
  2. foveation;
  3. effects tier (decal count, smoke);
  4. the dynamic occlusion pass;
  5. framebuffer scale, at the next session (three only applies it before the session starts).
- **Raise, as a probe:**
  - only while calm: no engaged enemy, between waves or paused;
  - only when the CPU p95 is under 55 % of the *new* period and there were 0 misses for 10 s; also use GPU time from `EXT_disjoint_timer_query_webgl2` when the capability log shows it;
  - after switching, roll back if there are 2 or more misses within 3 s, then lock that rate out for 60 s.
- Every ladder change is logged as an event marker.
- **Never degraded:** input sampling, hit detection, enemy logic.

**How we measure**
1. **Capability log at session start.** One JSON, written once before the frame loop starts, kept in localStorage and exportable. It records:
   - the user agent, `enabledFeatures`, `supportedFrameRates`, `frameRate`, `environmentBlendMode`, the session mode and the active reference space;
   - the result of `createAnchor` in that space;
   - the layer (`renderer.xr.getBaseLayer()`): `textureWidth`/`textureHeight`, `getNativeFramebufferScaleFactor`, `'fixedFoveation' in layer` and the value read back after `setFoveation`, `recommendedViewportScale`;
   - `depthUsage`, `depthDataFormat`, the depth texture size, and whether `normDepthBufferFromNormView` is the identity;
   - `light-estimation` granted and `requestLightProbe` present; the bounded-floor probe's `boundsGeometry` length; hit-test result counts inside and outside the Space Setup room;
   - which GL extensions exist: `OVR_multiview2` (and whether it has `framebufferTextureMultisampleMultiviewOVR`), `OCULUS_multiview`, `WEBGL_multisampled_render_to_texture`, `WEBGL_multi_draw`, ASTC, ETC, `KHR_parallel_shader_compile`, `EXT_disjoint_timer_query_webgl2`;
   - `!!navigator.gpu` and whether `XRGPUBinding` exists.
2. **In-app frame recorder** (`debug/PerfMonitor`), allocation-free.
   - **Rings.** Preallocated `Float32Array(4096)` rings record the time between XR frames, the CPU time of the frame callback split per system (including `render` and the `fpScene` pass), draw calls, triangles, and canvas and texture uploads per frame.
   - **Statistics.** A histogram in 0.5 ms bins reports p50, p95, p99 and p99.9. A missed frame is one longer than 1.5× the period. A snapshot every second records the enemy count, foveation, scale, refresh rate, texture and geometry memory, and the number of shader programs.
   - **Hitch log.** The rings wrap after about 57 s at 72 Hz, so a separate append-only log records every interval over 1.5× the period. Each entry holds the timestamp, the per-system split, render calls, the non-frame tasks since the last frame, and event markers (spawn, kill, reload, room enter, ladder change, save).
   - **Work outside the frame callback.** Every non-frame entry point (worker `onmessage`, IndexedDB success, fetch and decode `then`, `setTimeout` and idle callbacks) is wrapped with the same timer, and any over 1 ms is logged with a timestamp. A `PerformanceObserver` watches `longtask`, plus `long-animation-frame` if it is present.
   - **No `performance.memory`.** Chromium quantises it and refreshes it rarely without a flag, so it can't show a GC at a hitch. GC comes from chrome://inspect Performance traces (Minor/Major GC events) and from allocation sampling per test scene.
   - **Storage.** The recorder's own cost is timed as a PerfMonitor system, or it is turned off for perf-gate runs. It is flushed to IndexedDB as binary blobs only on pause, `visibilitychange` or session end, and read through chrome://inspect like CQC's `cqcHitches`.
3. **GPU side.** The OVR Metrics Tool overlay and CSV: FPS, stale frames, App GPU time, CPU/GPU %, clock levels, temperatures. ovrgpuprofiler to tell vertex-bound from fragment-bound (LIKELY [Meta]).
   - Quick test: skip `renderer.render`; if FPS recovers, the cost is GPU or submission. Then drop the scale to 0.8; if that helps, the cost is fill rate.
4. **CPU side.** A chrome://inspect trace with the `xr.debug` category, plus allocation sampling per scene (controllers and hands).
5. **Test scenes:**
   - empty room;
   - 6 enemies at 3 m;
   - 10 enemies at mixed distances, with smoke;
   - worst-case firefight;
   - **a scripted event scene with markers:** enter XR, first spawn wave, first shot, a kill, reload, holster fade, enemies entering through a doorway, pause and resume, a ladder rate switch, exit and re-enter XR.

   Each scene runs 60 s at 72 Hz and at 90 Hz, then a **20-minute heat soak**. Change one URL flag at a time.

   Preconditions, from CQC's protocol (`docs/QUEST3S_PERFORMANCE.md` §2): battery charge over 80 %, room temperature, the same spot, and a cool-down between runs.
6. **Pass criteria:**
   - CPU-callback p99 ≤60 % of the period, with p99.9 reported;
   - missed frames ≤0.5 % and OVR stale frames ≤0.5 %, with no run of 2 or more consecutive misses outside loading;
   - no frame over 2× the period on any gameplay event (event scene);
   - program, texture and geometry counts flat after warm-up;
   - the GPU steady-state target holds in the worst-case firefight at the end of the soak;
   - no clock throttling during the soak.

---

## 11. Proposed project folder structure

**Decision: plain JavaScript ES modules, no build step, an import map, and three r187 vendored locally**

- **Why not TypeScript or Vite.**
  - TypeScript adds a compile step, and Vite adds a dev toolchain.
  - Nothing here needs bundling: the module graph loads once, before XR starts.
  - A no-build page is easier to debug on the Quest, and it matches Blackout's working setup.
  - JSDoc and `@ts-check` give editor type checking. `tsc --noEmit --checkJs` can be added later as a check only.
- **Workers** use relative URLs. They don't depend on the page's import map (the scanner's worker imports three by full URL, SC:2849).
- **Dev loop:**
  - any static server on a fixed port;
  - on the Quest, `adb reverse` to `localhost` plus chrome://inspect;
  - production on one stable HTTPS origin (§15).
- **No service worker in v1.** A cache-first service worker served CQC stale textures. If offline play is wanted later: network-first with versioned file names.

```
Kvartira/
  index.html                  import map, Enter button, boot only
  vendor/three/               r187: build/three.module.js + examples/jsm/{loaders,libs/basis,libs/meshopt,webxr}
  vendor/input-profiles/      local controller models (no CDN at runtime)
  assets/{models,textures,sounds}/  GLB+KTX2, mono audio; assets/LICENSES.md (one line per file)
  src/
    main.js
    app/      Game.js (Boot→Menu→Setup→Play→Pause state machine), Loop.js, Settings.js (profiles, comfort), Events.js
    core/     Renderer.js, SceneLayers.js (main scene + small fpScene with matching lights/fog/env; draw order),
              AssetLoader.js (KTX2, meshopt, warm-up draw), UploadQueue.js, Pool.js, JobQueue.js (time-budgeted slices), WorkerRPC.js
    xr/       XRSession.js (play/setup/probe/bounds modes), Capabilities.js, SpaceManager.js (reference space, reset, world root),
              Input.js (controllers + hands via fillPoses → one action/pose stream), Haptics.js (priority rule),
              DepthOcclusion.js, Lifecycle.js (visibility/end), QualityLadder.js (frame rate, foveation)
    mapping/  SpaceSetupSource.js (live XR | recorded fixture), SpaceSetupImporter.js, RoomEditor.js,
              tools/{Wall,FloorJunction,Corner,Doorway,Furniture,Hazard,Lighting,SafeZone}Tool.js, Pointer.js, RoomValidator.js,
              GeometryBuilder.js, RoomManager.js (runtime alignment states, worldFromRoom), AnchorManager.js, Relocalizer.js, RoomMatcher.js
    data/     schema.js (typedefs + validators), migrations.js, RoomDatabase.js (rooms, manifest rebuild, settings, diagnostics), HouseExport.js
    nav/      CollisionWorld.js, NavGrid.js, RoomGraph.js, PathPlanner.js, Steering.js, LineOfSight.js, SpawnValidator.js
    player/   BodyEstimator.js, Calibration.js (standing + seated), Holster.js, Reach.js (shared grab test), PlayerHitShapes.js
    weapons/  WeaponManager.js (inventory, switching, active weapon), defs/pistol.js, WeaponInstance.js (state machines),
              Trigger.js, Recoil.js, Magazine.js, WeaponView.js, WeaponFX.js (flash, decals, brass), Ballistics.js, AmmoReadout.js
    enemies/  EnemyManager.js, EnemyPool.js (12 prebuilt), EnemyBrain.js, Perception.js, EnemyView.js (skinned + LOD), Spawner.js
    safety/   SafeZone.js (runtime thresholds, violation log), PauseManager.js (all pause triggers), ObstacleWarnings.js
    audio/    AudioEngine.js (unlock, voice/panner pools, convolver), SoundBank.js (fetch queue, decode before Enter)
    ui/       CanvasPanel.js (redraw on change, one upload per frame), DigitAtlas.js, WristPanel.js, Hud.js, Keyboard.js, menus/
    debug/    PerfMonitor.js, CapabilityLog.js, Diagnostics.js (export JSON), Recorder.js (pose and Space Setup traces in
              typed-array rings; flushed to IndexedDB on pause/end), DebugDraw.js
  workers/    mapping.worker.js, nav.worker.js (bake + A*)
  tests/      unit/*.test.js (node --test), browser.html (IndexedDB, workers, loaders, warm-up), fixtures/ (recorded from your Quest)
  tools/      offline asset prep (decimate, KTX2): dev only, never shipped
  docs/       ARCHITECTURE.md, FEATURES.md (checklist), DECISIONS.md, DEVICE_LOG.md
```

**Changes from your proposal**

| Your proposal | Change | Why |
|---|---|---|
| `SpatialScanner` | Renamed `SpaceSetupImporter`, behind a `SpaceSetupSource` interface (live or fixture) | The browser can't scan. A fixture source makes mapping testable on the desktop and in Node. |
| `PassthroughManager` | Merged into `Renderer` and `DepthOcclusion` | Passthrough itself is just `immersive-ar` plus a transparent clear. Occlusion is the real work. |
| `HandTracking` + `ControllerManager` | One `Input` action layer | Gameplay code shouldn't care whether input comes from a controller or a hand. |
| `InteractionManager` | Split by owner: `Input` emits actions; `Holster`, `WeaponInstance` and the UI panels each handle their own grabs and presses, with one shared reach test (`player/Reach.js`) | Each grab has its own rules (draw, rack, magazine, panel); one shared test keeps the distances consistent. |
| `Player`, `PlayerTracking` | Became `player/BodyEstimator`, `Calibration` and `PlayerHitShapes` | There is no hip tracker: "tracking" is an estimate, with its own calibration. |
| `SceneManager` | Became `core/SceneLayers` (main scene, `fpScene`, draw order) plus `app/Game` (mode state machine) | Rendering layers and game modes are separate concerns. |
| `XRManager` | Split into `xr/XRSession`, `SpaceManager`, `Lifecycle` and `Capabilities` | three already provides `renderer.xr`; ours adds session modes, reference spaces, lifecycle and the capability log. |
| `RoomManager` | Kept, in `mapping/`. It owns the runtime room alignment state machine (§7) and each room's `worldFromRoom`. | One owner for unaligned, provisional, aligned, suspect and tracking-lost, and for recovery from suspect. |
| `RoomDatabase` inside `mapping/` | Moved to its own `data/` folder with schema and migrations | Its logic can be tested without XR, and it isolates per-room failures. |
| `navigation/` + `EnemyNavigation` | Merged into `nav/`, which includes `CollisionWorld` | Bullets, enemies, warnings and spawns all share one set of collision shapes. |
| `GuardianManager` | Replaced by `SafeZone` + `ObstacleWarnings` | A web page has no Guardian API. |
| `WeaponManager` | Kept, in `weapons/`. It owns the weapon inventory, switching and the active weapon (v1 holds one pistol). | A modular weapon architecture needs an owner for more than one weapon. |
| `ReloadSystem`, `WeaponAnimations` | Folded into `WeaponInstance` (parallel state machines) and `WeaponView` | Reloading is a state change; the view only follows the state. |
| `MainMenu`, `RoomSetupUI` | Became `ui/menus/` and the `RoomEditor` tools | Menus are canvas panels; room setup is the editor itself. |
| `PerformanceMonitor` in `core/` | Moved to a new `debug/` folder, with the capability log, diagnostics and recorder | Measurement and recording tools live together. |
| — | Added `app/`, `workers/`, `tests/fixtures/`, `docs/` | Game state and pause, threads, replaying data from your house, and the docs your rules require |

---

## 12. Development phases and testing strategy

**Testing has four tiers**
- **T0: Node unit tests** (`node --test`) for pure modules. Table-driven, with fuzzing where it helps. Run before every commit.
- **T1: Browser test page** for IndexedDB, workers, loaders and the warm-up.
- **T2: Desktop emulation.**
  - IWER (Immersive Web Emulation Runtime), loaded in-page with `?emulate`, for the session and input.
  - `?fixture=<name>` replays Space Setup snapshots and pose traces recorded in your house.
  - `?seed=` makes AI runs reproducible.
- **T3: Headset.**
  - chrome://inspect over USB.
  - The in-app Diagnostics export.
  - OVR Metrics.
  - One `DEVICE_LOG.md` entry per phase, with the build hash.

**Rules for every phase**
- The build runs at the end of the phase.
- Each `FEATURES.md` item moves through *planned → implemented → desktop-tested → device-verified*.
- Anything that relies on a LIKELY or UNRELIABLE API isn't "done" until it is device-verified.
- Every phase has a performance gate: idle and phase scenes meet the §10 pass criteria.

### Phase 1: Project setup, architecture, renderer, basic session
- **Deliverable:**
  - `index.html` with the import map and three r187 vendored.
  - The app state machine and the frame loop.
  - `XRSession` with its modes (§3):
    - `play` and `setup`;
    - the logging `probe` session, which requests `local-floor, unbounded, anchors, plane-detection, mesh-detection, hit-test, hand-tracking, depth-sensing, layers, body-tracking, light-estimation`;
    - the one-off `bounds` probe with `bounded-floor`.
  - Fallbacks, each from a fresh tap: "Tap again (reduced features)", and an `immersive-vr` test scene.
  - The capability log, `PerfMonitor` with the hitch log, Diagnostics export, and `Lifecycle` (end leads to a re-enter button; `visibilitychange` and `reset` are logged).
  - A test cube.
  - `ARCHITECTURE.md` and `FEATURES.md`.
- **Desktop:** without WebXR the page shows a clear message and no errors. IWER enters a session. `node --test` runs (smoke tests).
- **Headset:**
  - Enter AR and see passthrough with the cube.
  - Export the capability log for the probe session, for a play session without depth, and for the bounds probe.
  - Point hit-test at walls inside the Space Setup room and in another room, and log the result counts.
  - Note whether the system boundary shows under `unbounded` and under `local-floor`.
  - With depth on, check that the background stays transparent (three skips its clear), with and without the explicit clear.
  - Measure idle frame time at 72 and 90 Hz for 60 s each.
- **Exit:**
  - The log answers the Phase 1 unknowns: blend mode, frame rates, which of `hit-test`, `layers`, `body-tracking` and `light-estimation` are granted, `boundsGeometry`, hit-test outside the Space Setup room, extensions, anchor creation in each space, foveation read-back, and the clear with depth on.
  - Idle CPU-callback p99 ≤60 % of the period, and missed frames ≤0.5 %.
  - Zero console errors.

### Phase 2: Passthrough and controllers
- **Deliverable:**
  - Layered rendering with the small `fpScene` second pass (matching lights, null-checked depth-mesh hide, `info.reset()` per frame).
  - The warm-up pipeline (§10) and the `info.programs` dev assert.
  - Static occluder test: a depth-only box the user places on a real table.
  - Depth occlusion A/B.
  - `Input` (analog trigger and grip, buttons, stick, thumbrest, `touched`), hands through `fillPoses`, `Haptics`.
  - Wrist panel, with the canvas redraw rules and the upload queue.
  - `PauseManager` handling all the CONFIRMED triggers (session visibility, end, null pose or `emulatedPosition`, `reset`, input source lost, hitches over 250 ms), plus the wrist button and B+Y, and the hook for the "left safe zone" trigger (wired up in Phase 3).
  - Audio unlock and resume; panners created at unlock.
  - A debug panel for the quality ladder.
  - A pose-trace recorder (typed-array rings, flushed to IndexedDB on pause or end).
- **Desktop:** IWER button mapping; pause triggers simulated; Node tests for the pause and resume protocol.
- **Headset:**
  - Every button logged.
  - Whether the left menu button reaches the page.
  - How the haptics feel.
  - **Depth cost, as a three-way A/B in OVR Metrics,** including the 20-minute soak with CPU/GPU levels and temperature:
    1. a session without `depth-sensing`;
    2. depth on, mesh hidden;
    3. the occlusion pass on.
  - The same A/B for a session without `plane-detection` and `mesh-detection`.
  - Whether the cube is hidden behind the real table.
  - Edge quality around hands.
- **Exit:**
  - Every CONFIRMED pause trigger pauses within 1 frame, and resume needs the full protocol.
  - The A/B costs are recorded. `cfg.depth` defaults to false unless "Dynamic occlusion" is on (applied from the next session).
  - Program and texture counts stay flat after warm-up.

### Phase 3: Automatic detection and manual room mapping
- **Deliverable:**
  - `SpaceSetupImporter` with the confirmation card.
  - `RoomEditor`: wall, floor-junction, corner and rectangle modes, doorways, furniture, hazards, room lighting, safe zone, undo. Re-scan for each room type (§6.2).
  - `Pointer` with the hit-test fallback chain, automatic switching to floor-junction mode, and floor-touch calibration.
  - `GeometryBuilder` (collision shapes and occluders) and `RoomValidator`.
  - **`SafeZone` runtime and `ObstacleWarnings`:** ring, enemy-freeze hook, the full pause through the PauseManager "left safe zone" trigger, and the violation log (§6.2).
  - Debug JSON export and import of a room, so test work isn't lost before Phase 4.
  - A recorder for Space Setup snapshots, which become fixtures.
- **Desktop:**
  - Fixture replay of your living room.
  - Node tests for polygon cleaning, wall fitting, the fallback table and the checks.
  - Node tests for the safety thresholds on scripted head and hand paths: ring at 0.8 r, enemy freeze at 0.9 r, pause at r, hand and obstacle warnings, resume only through the full protocol.
- **Headset:**
  - Import the Space Setup room.
  - Map a second room by hand, in wall mode if hit-test works there and in floor-junction mode in any case.
  - Compare against a tape measure.
  - Record hit-test accuracy and range, multi-room planes, global-mesh triangle count, and the wall normal convention.
  - Walk out of the safe zone and reach toward a mapped wall.
- **Exit:**
  - A mapped room matches the tape within 5 cm *(design)*, in both wall and floor-junction modes.
  - Mapping a 4-wall room with 1 door and 3 furniture items takes 5 minutes or less.
  - Static occluders visibly hide a virtual box behind a real wall.
  - The safety thresholds fire as specified on the headset.

### Phase 4: Persistent room database and connections
- **Deliverable:**
  - `RoomDatabase` with migrations, quarantine, history, the anchor-delete queue, manifest rebuild, and the `settings` and `diagnostics` stores.
  - Connections between rooms.
  - `RoomManager` (the alignment state machine, including recovery from `suspect`), `AnchorManager` and `Relocalizer` (restore, plane refinement, placement through a neighbour, 2-point re-alignment).
  - `reset` handling.
  - House export and import.
- **Desktop/T1:**
  - Migration chains.
  - A deliberately corrupt room is quarantined while the others load.
  - A corrupt or stale manifest is rebuilt, and every valid room still loads.
  - Deleting a room leaves the others untouched.
  - A record from a newer app version opens read-only.
  - Table tests of every alignment state transition.
- **Headset:**
  - Quit the browser and restart the headset; log restore success and time.
  - Check behaviour at the 6th, 7th and 8th anchor.
  - Check whether `initiateRoomCapture` wipes anchors.
  - Measure drift against a physical marker.
- **Exit:** at least 9 of 10 restores are aligned within 5 cm *(design)*. A failed anchor always leads to a working fallback. No room's failure, nor a bad manifest, affects another room.

### Phase 5: Player, holster, pistol
- **Deliverable:**
  - Calibration (standing and seated), `BodyEstimator`, `Holster`, and the comfort settings (§8) saved in the player profile.
  - `WeaponManager` and the pistol: carry, slide, feed, chamber and trigger state machines; recoil spring; magazine out and in; rack; slide lock and release; button reload.
  - **Ammo counter:** an optional 2-digit readout on the rear of the slide (digit atlas on instanced quads, no uploads) or in the HUD. Default off; also listed in `FEATURES.md`.
  - Muzzle flash, decals and spent cases (pooled and warm-drawn; `setColorAt` primed). The holster fade uses a pre-warmed material.
  - Hitscan against `CollisionWorld`; core pistol sounds (decoded before Enter); layered haptics.
  - Static training targets.
- **Desktop:**
  - Node table tests for every state machine, fuzzed with random event orders (no illegal combinations; ammo is conserved).
  - Spring tests with frame spikes of 0.1, 0.5 and 2 s, and NaN.
  - The estimator replayed on recorded pose traces: holster yaw stable while looking down; no turning toward a reaching hand. The same for seated traces.
- **Headset:**
  - 40 draws without looking, standing and seated.
  - Trigger break, reset and pace.
  - Holster visibility at about a 45° nod.
  - How the recoil looks.
  - Gun pass with and without occlusion.
- **Exit:**
  - At least 38 of 40 blind draws succeed *(design)*.
  - Zero accidental shots while drawing.
  - Trigger press to flash takes no more than 1 frame.
  - No first-use hitch: the first draw, shot, decal, reload and holster fade each stay under 2× the period, and program, texture and geometry counts don't grow after warm-up.

### Phase 6: Enemy spawning, collision, navigation between rooms
- **Deliverable:**
  - Navigation bake in the worker: grid, distance transform, doorway distance fields, spawn candidates. A* in `nav.worker`.
  - `RoomGraph`, `PathPlanner`, `Steering`, `LineOfSight`, `SpawnValidator`.
  - Navigation preview in the editor.
  - `EnemyPool` (12 prebuilt instances with mixers, actions, weapons, capsules and voices, all warm-drawn per LOD level).
  - The enemy model with LOD and hit capsules; health, flinches and death falls checked against the grid.
  - Per-room culling and per-room instanced pools.
  - Movement-only behaviour: patrol and investigate.
- **Desktop:** a seeded simulation of 10,000+ steps on fixture houses:
  - 0 entries into blocked or `UNVERIFIED` cells;
  - 0 spawns in view or within the zone limits;
  - doorway crossings stay continuous;
  - flanking only happens with a graph loop.
- **Headset:**
  - Enemies walk through a real doorway into your room.
  - Visual check that they never clip walls or furniture.
  - 8 enemies within budget.
  - Measure expansions per ms for the main-thread A* fallback.
  - Event-scene frames for the first spawn wave and the first kill.
- **Exit:**
  - The simulation invariants hold.
  - Navigation, AI and mapping stay at or under 1 ms average and 2 ms peak with 8 enemies; animation and skinning at or under 1.5 ms.
  - First-spawn-wave and first-kill frames stay at or under 2× the period.

### Phase 7: Survival gameplay, combat, audio
- **Deliverable:**
  - Waves and survival; enemies shooting with the 2-shooter limit.
  - Your hit shapes and health; cover, peeking and flanking.
  - The full audio engine: voice pool, 8 HRTF panners, convolver reverb (buffer set at load; one convolver per response if per-room reverb is used), low-pass for sounds heard through other rooms and closed doors.
  - HUD, menus and settings (comfort, holster, realism options, built on the Phase 5 settings); "change post" between waves (§13); high scores; training mode.
- **Desktop:** headless seeded waves for balance; audio voice-stealing tests.
- **Headset:** full play sessions; CPU cost of HRTF; one full round with no forced movement.
- **Exit:** a 20-minute session with no frame over 2× the period on any gameplay event, 0 safety violations (as defined in §6.2), and every pause path working.

### Phase 8: Performance optimisation and Quest 3 testing
- **Deliverable:**
  - KTX2 everywhere; LOD tuning.
  - The automatic quality ladder (probe raise with rollback and lockout).
  - Optional A/B tests of multiview and quad layers.
  - The release checklist and the final `DEVICE_LOG.md`.
- **Testing:** the four test scenes and the event scene from §10 at 72 and 90 Hz, the 20-minute soak, and an OVR Metrics CSV for each, all under the §10 preconditions.
- **Exit:** every §10 pass criterion is met in all five scenes, on your Quest 3.

---

## 13. Impossible or unreliable in the browser, with practical alternatives

| What we want | Browser reality | Practical alternative |
|---|---|---|
| Scan the whole house automatically | No API for this; building it from depth readback repeats the scanner's 10 fps problem | Import the Space Setup room, then map the other rooms by hand: wall mode where hit-test works there, floor-junction mode otherwise |
| Space Setup data for several rooms | UNRELIABLE (untested) | The importer already handles any number of floors. Test it in Phase 3. |
| Plane IDs that survive across sessions | Don't exist [S-planes] | Recognise rooms by their shape signature |
| Hide the Guardian boundary, or read its real polygon | UNSUPPORTED-IN-BROWSER | Our own safe zone with runtime warnings and pause (§6.2), hazard zones, and passthrough always on |
| `bounded-floor` play area in AR | UNRELIABLE (coarse or empty on Quest 3 [3P]) | Phase 1 probe only; a hint at most, never used for safety. The safe zone you set yourself. |
| Unlimited persistent anchors | 8 per site (maybe across all sites); may be evicted; lost in private mode or when site data is cleared | At most 6 anchored rooms; placement through a neighbouring room; 2-point re-alignment always available; JSON backup |
| `initiateRoomCapture` as part of the normal flow | May wipe anchors for every room; once per session | A manual button with a warning, then re-import, compare and re-anchor each room independently (§6.2) |
| Real Guardian or wall proximity from the sensor | CPU depth is UNRELIABLE, and readback is too slow | Warnings from the mapped geometry (only as accurate as the map), plus an optional GPU-only depth tint of nearby real surfaces (no readback; UNRELIABLE until checked) |
| Real door open/closed state | Unknown | The user's `usuallyOpen` flag. An optional one-shot depth check at round start (UNRELIABLE). |
| Fine-grained occlusion of enemies by real objects | 320² hard depth, lag | Stand-in meshes always on; live depth opt-in; soft-edge shader later |
| Virtual lighting that matches the real room | `light-estimation` UNRELIABLE on Quest (untested) | Per-room manual brightness and colour temperature (§6.2) |
| Hip or body tracking | No hip tracker; body tracking experimental | Head-and-hands estimator, plus "touch your holster" calibration |
| Accurate trigger with hand tracking | The index finger is often hidden behind the hand | Controllers recommended; hands as a hands-free mode with large hysteresis |
| Haptics with hand tracking | No actuator | Sound and visual cues |
| Menu button to pause | UNRELIABLE | Session blur, the wrist button, holding B+Y |
| Muzzle flash lighting the real room | Impossible | Glow on virtual objects only |
| Additive glow over passthrough | UNRELIABLE | Write alpha; test on device |
| Ragdoll physics | No physics engine (by choice) | Scripted falls toward clear floor cells (CQC `downedFallPick`) |
| Many skinned enemies drawn with instancing | No instanced skinning | ≤2 draws per enemy and LOD; vertex animation textures for more than 6 enemies |
| Artificial locomotion or snap turn in MR | The API works, but it breaks alignment with the real room | **Intentionally absent in MR.** Instead: turn your real body; enemies always come to your post; lean and peek within the safe zone. **"Change post"** between waves: the game pauses and shows the next post's safe zone (posts are set up beforehand in Setup); you choose to walk there with passthrough clear, or stay. A VR replica mode is out of v1 scope. |
| Multiview, Space Warp, WebGPU | UNTESTED (`WebGPURenderer` multiview), UNRELIABLE, or impractical in three | Two-pass rendering within the §10 budgets, plus the quality ladder |
| CPU/GPU level control, eye-tracked foveation | Native only / no eye-tracking hardware | Fixed foveation and the refresh-rate ladder |
| System keyboard in the headset | UNRELIABLE | In-world keyboard and preset names |

---

## 14. Your repos: references only, nothing copied

The House Scanner is glitchy and the old guns cost too many draw calls, so **the game is written from scratch**. The repos are used for only two things:
- numbers that were tuned and tested on your headset;
- mistakes we will not repeat.

No code is copied or ported.

### Mistakes we will not repeat

| Old problem | Where | How the new game avoids it |
|---|---|---|
| Main thread stuck near 10 fps (depth readback plus reconstruction on the main thread) | Scanner | Depth is never read back. Nothing is reconstructed: the map comes from Space Setup plus the manual tools. Heavy work runs in workers with time quotas. |
| Allocations every frame (hand capsules, joint reads) | Scanner (3445, 552-568) | A zero-allocation rule. Joints are read with `fillPoses` into preallocated buffers, and garbage is measured per scene. |
| One giant single-file app; `//` comments silently cutting off one-line statements | Scanner | Small ES modules with normal formatting, and a syntax check before every commit |
| Gun built from many meshes and materials, so many draws | CQC / Blackout guns | 2 draws per eye (see "Pistol" below) |
| Enemy of about 130k triangles and 10–14 draws | CQC `enemy-soldier` | LODs of ≤20k / 6k / 2k triangles, ≤2 draws, 12 prebuilt and pooled |
| 208 MB of GPU textures | CQC | ≤150 MB, all KTX2 |
| First pickup and first shot compiled 6 programs (the arms view had its own lights) | CQC | `fpScene` with matching lights, a warm-up draw, and a dev assert that the program count stays flat |
| Screens redrawn and re-uploaded on every kill | CQC | A panel redraws only when its value changes and only while visible; at most one upload per frame |
| Mid-fight spawns cloned skinned meshes (9–33 ms each) | CQC | All 12 enemies prebuilt before XR |
| Controller models loaded from a CDN, so VR needed internet | CQC | Stored locally |
| A cache-first service worker served stale textures | CQC | No service worker in v1 |
| The multiview patch flickered; framebuffer scale 1.4 hitched | CQC | Two-pass stereo, scale capped at 1.2 |
| `setRenderTarget(null)` during XR gave a black screen | Blackout | The warm-up draw runs only before XR |
| `bounded-floor` switched the Quest to a roomscale boundary | CQC | Requested only in the one-off Phase 1 probe |

### Pistol: built fresh for 2 draws per eye

**Gun and holster**
- **One mesh, one material, one texture set** (2048² UASTC base colour, normal and ORM maps; ≤30k triangles).
- **Moving parts are rigid bones of one small skeleton,** not separate meshes: slide, barrel (for tilt), trigger, hammer, slide stop and magazine catch. The whole gun is **1 draw**.
- **The magazine is the 2nd draw,** because it leaves the gun. Its top rounds are part of its mesh.
- **The holster is a separate object** that shares the gun's material and texture atlas.

**Pooled effects**
- Dropped magazines: one `InstancedMesh`, 1 draw for all of them.
- Spent cases: one `InstancedMesh`.
- Muzzle flash: one pooled quad.

**Cost.** The held gun costs 2 draws per eye, which is 4 in `renderer.info` counting both eyes. These draws are in the `fpScene` pass.

**Where the model comes from.** An offline script in `tools/` re-bakes a source GLB into this layout: your M1911 or G17, or a new model. Only the shape is taken; all runtime code is new.

### Facts already proven on your headset (from the scanner)

These are API behaviours, not code:
- An `XRFrame` is dead after any `await`.
- Any `await` before `requestSession` loses the user gesture.
- A persistent anchor can need up to about 600 frames to report a pose after restore.
- XR pose matrices are `Float32Array`s.
- Raw GL calls need a GL state reset afterwards, or the headset goes black.
- Session globals must be reset on every new session.
- `initiateRoomCapture` exists; workers and transferable buffers work.

### Tested numbers we take from CQC (values, not code)

| Mechanic | Value | Source |
|---|---|---|
| Mechanism states | Chambered, rounds in magazine, slide locked, racked, trigger reset. The slide locks open on empty; slide release; magazine drop. | CQC:25346-25390 |
| Trigger | Analog value smoothed at 40/s for the model only. **Breaks at 0.72, resets below 0.40.** Dry fire clicks plus 0.2 / 12 ms; a quiet reset click. | CQC:27270-27297, 3522 |
| Slide cycle | Back in 15 ms, home in 40 ms. Travel: G17 0.030 m, M1911 0.044 m. M1911 barrel tilt, hammer and slide stop. | CQC:27245, 59893 |
| Recoil | Springs: back k 520 / c 38; pitch and yaw k 300 / c 26, in 4 ms sub-steps. Impulse per shot: G17 kick 0.9, climb 11, yaw 1.6, each × random 0.9–1.1; × 0.55 with two hands. **The camera never moves.** The bullet follows the bore at the moment the trigger breaks. | CQC:27096-27111, 25525-25530 |
| Rack and magazine insert | Rack reach 0.085 m; eject at 90 % of travel; feed back under 35 %. Magazine seats within 3 cm laterally, from 0.15 m below to 2.5 cm above the seat, axis dot product over 0.7; it slides in at 0.55 m/s and must leave the well before it can seat again. | CQC:27216-27226, 27697-27725, 24643 |
| Two-handed grip | Support hand counts within 0.08 m; recoil × 0.55; aim stays with the firing hand. | CQC:61974 |
| Haptics | Shot 1.0 / 45 ms; back in battery 0.3 / 14 ms; rack 0.55; slide home 0.75; magazine catch 0.28. A pulse of 0.4 or more may cut a running pulse; weaker ones never do. | CQC:18446-18461 |
| Muzzle flash; spent cases | Flash 6–7.5 cm for 13–16 ms; light 6 cm ahead of the muzzle. Eject velocity [1.5, 1.9, 0.8] m/s; landing sound only on the first landing. | CQC:19337, 26319 |
| Holster and body estimator | Offsets, dead zones and smoothing as in §8 | CQC:3512-3524, 56895-57060 |
| Enemy AI; damage | Reaction 0.45–0.85 s; aim error 0.07 → 0.012 rad over 0.9 s. Damage: head 400, neck 120, torso 40, pelvis 45, limb 24, against 100 health. | CQC:3618-3628 |

**From Blackout (ideas only):**
- the no-build import-map layout;
- re-deriving the bore from the sight line;
- ballistic spent cases that bounce off the floor.

### Asset candidates (re-baked offline; licences to confirm)

| Asset | Path | Notes |
|---|---|---|
| M1911 pistol | `cqc/models/m1911-glb.glb` | Real size, 9,575 triangles, parts already split, so it is easy to re-bake into the 2-draw layout. **Licence unknown.** |
| G17 pistol | `cqc/models/g17-glb.glb` | CC-BY-4.0 (8sianDude). 73k triangles; needs decimation, a scale of 0.113, and the barrel split out of the slide. |
| Enemy | `cqc/models/enemy-soldier.glb` | About 130k triangles; needs reduction to 20k / 6k / 2k and 2 draws. **Licence not checked.** |
| Pistol sounds | `cqc/sounds/` | Shot, rack, slide release, magazine out, in and tap, dry fire, brass, magazine drop, cloth; about 0.5 MB. **The freesound licences are NOT verified.** |

In MR your real hands are visible through passthrough, so v1 draws the gun only. Virtual hands are optional later.

---

## 15. Open decisions for you

1. **Repository.** Use your empty private `canrealitybesovirtual-max/Kvartira` (the name fits a house game)? I recommend yes.
2. **Language.** JavaScript with JSDoc and `@ts-check`, no build (my recommendation), or TypeScript, which needs a `tsc` or Vite build step?
3. **Hosting origin.** We need one stable HTTPS origin, because the rooms and anchors belong to it. One option is a Render static site, like the scanner's `render.yaml`. Development uses `adb reverse` to localhost on a fixed port.
4. **Holster defaults.** Strong hand and side (right hip?), and the mount: hip, thigh, chest or cross-draw. Seated play defaults to thigh or chest.
5. **Pistol model.** Re-bake the M1911 shape (parts already split, licence unknown), the G17 (CC-BY-4.0, needs more work), or a model you provide? Each becomes the same 2-draw layout (§14).
6. **Licences.** May I use CQC's sounds and models, whose licences are unverified, in the private development build until they are confirmed? Nothing unverified would ship publicly.
7. **Realism defaults.**
   - Ammo counter off (witness holes plus the locked slide); the optional 2-digit counter is built in Phase 5.
   - Manual reload, with a button reload as a fallback.
   - Malfunctions off.
   - Recoil scale 1.0.
   - Default of 4 active enemies, budgeted up to 8.
8. **Optional.** Allow `developers.meta.com` in this session's network settings, so I can read the Meta-doc claims in full (anchor limit, frame rates, layers). The Phase 1 probe session gathers the device facts fresh, so the old scanner isn't needed.

Waiting for your approval before Phase 1.

---

## Review notes

**No issue was rejected outright.** I fixed all 37 issues. Two were accepted with a qualification:

- **Walls mode depends on hit-test (completeness).**
  - The fix is applied in full: the dependency is stated, floor-junction mode is the automatic, guaranteed fallback, and the inside-vs-outside hit-test check moved to Phase 1.
  - One part of the issue's reasoning is not taken: that Quest hit-test is "probably backed by the Space Setup scene model". The research notes cite UploadVR [3P], which says hit-test has run on the Depth API since Browser 40.4. So hit-test stays LIKELY outside the Space Setup room, but untested there.
- **IWER naming.** The research notes themselves call it "Immersive Web Emulator". The issue is right, though: CQC's `?emulate` loads the in-page runtime (CQC-LOG:86, `window.__iwer`), so I fixed it.

**Checked in source during revision:**
- **CQC's vendored three:** the r170 copy contains `WebXRDepthSensing`, `hasDepthSensing` and `getDepthSensingMesh`.
- **three r187:**
  - `common/XRManager.js` has no depth-sensing code.
  - `WebGLRenderer.js:1735` skips `background.render()` whenever `hasDepthSensing()` is true.
  - `WebXRManager.js` has `setReferenceSpace` (line 338) and `getBaseLayer` (line 352).
  - `examples/jsm/webxr/XREstimatedLight.js` exists.
  - `WebXRController.js:243` calls `getJointPose` per joint.
- **CQC's log:**
  - CQC-LOG:1051 gives `findPath` at 0.56 ms in open field and 22 ms around a 36 m wall.
  - CQC-LOG:1625, 1627, 1628 and 1869 confirm the skinned-mesh culling, canvas re-upload, `checkShaderErrors`/`aptRaidWarm` and arms-view-lights lessons cited above.