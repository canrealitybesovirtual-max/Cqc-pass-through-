# Device log (Quest 3)

Add one entry per phase test. Each entry records the build version (shown on the page and on the headset panel), the date, and the results taken from the diagnostics JSON.

## Phase 1: tests to run

1. **Probe session.**
    - Check that the cube shows in passthrough.
    - Hold the trigger at walls in the Space Setup room, then in another room.
    - Put a hand in front of the cube, and toggle explicit clear with X.
    - Exit by holding both grips.
2. **Enter MR (play).** Press A and wait 60 s. Press B, then press A and wait 60 s again. Exit.
3. **Boundary probe.** Look around for 20 s, then exit.
4. In every session, note whether the system boundary appears.
5. Tap **Copy** and paste the JSON into the chat.

## v0.2: tests to run

1. **Probe session: "Hand does not cover the cube" (your report from the p1 build).**
    - Read out the panel's **Depth** line: it says whether depth arrived, whether three's occlusion pass runs, and whether the browser hands out a new depth texture every frame (`rec.probes.liveDepth.textureChanges`). v0.2 keeps three's texture current either way.
    - Hand about 40 cm in front of your face, over the cube: hidden or not?
    - **Y**: the depth picture. Does a hand shape show up in it when you move your hand?
    - **X** twice (clear off, on): black or smeared?
2. **Play.** Two waves at least: Glock from the hip, shots, A reload, pouch reload, rack, AKM from the shoulder (selector, burst, two hands). Note what feels wrong. Exit by holding Y.
3. Tap **Copy** and paste the JSON into the chat. Play records carry `spaceSnapshot` (your house, replayable on desktop), `play.world.report`, `warmXR`, `perfRuns` (the 60 s run from wave 1) and `systemsMs`.

## Entries

### p1.0 · 2026-11-27 · Quest 3, OculusBrowser 157.0.0.22.15 (Chrome 157)

Sessions run: VR test, Boundary probe, Play. The Probe session and the 60 s timing runs were not run yet.

**Device facts (device-verified)**

| Item | Result |
|---|---|
| GPU | Adreno 740 |
| Max texture size | 8192 |
| Layer | `XRProjectionLayer`, 3360×1760 (1680×1760 per eye at scale 1.0); native framebuffer scale 1 |
| Fixed foveation | Read-back 0.5 (works) |
| Offered refresh rates | 72 / 80 / 90 / 120. Switching works. |
| Default refresh rate in AR | **90 Hz**: 89.96 fps measured in the boundary probe without switching |
| `session.frameRate` | **Reads 0 at session start** and lags a switch, so the app measures the rate itself (p1.1) |
| Play (`local-floor`) features | `plane-detection`, `mesh-detection`, `hit-test`, `anchors`, `hand-tracking`. Blend `alpha-blend`. |
| Anchors in `local-floor` | Created in 22 ms; pose after 1 frame |
| Space Setup | **50 planes** (16 wall, 6 door, 10 table, 7 shelf, 3 bed, 2 couch, 2 ceiling, 2 wall art, **2 floor**: 111 m² and 14.4 m²); 25 meshes (largest 35,794 triangles); available 0.36 s after start. **More than one room's data reaches the browser.** |
| Plane `lastChangedTime` | Changes about 3 times per second with no change in plane count. The importer must snapshot on demand, not on every change. |
| Hit-test inside the Space Setup area | 75 % of trigger samples hit; average distance 2.39 m, max 5.14 m |
| `bounded-floor` in AR | Granted; `boundsGeometry` is a 4-point 9.2 × 1.48 m rectangle from the first sample. **Not the real boundary: never use it for safety.** |
| GL extensions | `OVR_multiview2` + `OCULUS_multiview` (with multisample), `WEBGL_multisampled_render_to_texture`, `WEBGL_multi_draw`, ASTC, ETC. **No `KHR_parallel_shader_compile`** (so the warm-up must be a draw), **no GPU timer queries** (GPU time comes from OVR Metrics only). |
| WebGPU | `navigator.gpu` and `XRGPUBinding` exist (not used) |
| `depthUsage` / `depthDataFormat` attributes | Present even when depth was not requested |
| Idle CPU per frame | 0.42–0.47 ms |
| Reference-space reset | One `reset` with a transform about 260 ms after a VR session started |

**Bugs found and fixed in p1.1**

- Holding both grips ended the session inside the frame callback, which caused "XRFrame access outside the callback" errors at every exit. The end is now deferred.
- The miss threshold assumed 72 Hz (the `frameRate` attribute read 0). The rate is now measured, and the switch target comes from the measured rate.
- The depth probe ran without the depth feature (the attributes are present anyway). It is now gated on `enabledFeatures`.
- A "planes" event was logged on every `lastChangedTime` tick (filling the 300-event log). It is now logged only when the count changes, and the ticks are counted.
- The panel uploaded 679 times in 121 s. It is now limited to 2 redraws per second, and 1 per 10 s during timing runs.
