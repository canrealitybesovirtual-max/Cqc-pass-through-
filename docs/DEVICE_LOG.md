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

## v0.2.1: tests to run

v0.2.1 adds the safe-spot step, a controls card, 72 Hz, a closer near plane, the fire mode on the wrist and a smaller Copy. Run the v0.2 probe test above first if it was not run yet.

1. **Enter MR.** Read the "Get ready" card (is it legible?), pull the trigger.
2. **Safe spot.** A ring follows you on the floor. Is its colour and the message ("Good spot", "Step … m") right for where you stand? Pull the trigger in a green spot (or hold it 1 s in an amber one).
3. **Play two waves.** Glock from the hip, shots, A reload, pouch reload, rack, AKM from the shoulder (the wrist should say SEMI; stick click → SAFE, again → AUTO), two hands, aim down the AKM sights: does the stock still clip through your face? Do you hear the first shots? Try B + Y (pause) and a trigger pull (resume). Exit by holding Y.
4. If the gun sits at a wrong angle or height in your hand, reload the page with e.g. `?gripPitch=5` or `?gripY=0.01` and say which value felt right.
5. Tap **Copy** (now the last session only) and paste it into the chat. New in the record: `probes.frameRate` (72 Hz request and the measured rate), `audio` (context state at start, after 1 s, at the end), `view.near`, `play.spot`, `play.world.rebuild`, `play.grip`, `play.safety`.

## v0.4: tests to run

v0.4 adds real-surface physics for dropped guns and magazines, the world built in a worker from your Space Setup scan (with its global mesh), the room-matched look and the automatic diagnostics upload. Loading takes longer (the physics warms up before Enter MR is enabled).

1. **Sit on your bed.** Draw the Glock, lay it on the bed beside you and let go: does it lie on the bed (not floating, not sunk)? Pick it up again.
2. **Drop it** from chest height onto the bed, a table and the floor: does each bounce and sound look and sound right?
3. **Lay the AKM on the couch.** Drop a magazine (A) on a table edge; pick it up with the left grip.
4. **Throw a magazine at a wall:** it must never vanish through it.
5. **Holster:** let go at the hip with the muzzle pointing down: does it holster? Level at the hip it now drops (realism).
6. **Fire about 20 rounds** at walls and furniture next to the bed: do the holes, dust and sounds fit the material? Do the cases stay on the bed (silent there, tink on the floor)?
7. **Look:** do the guns, the soldiers and their shadows sit in your room's light, or look pasted on?
8. **Hitches:** did anything stutter while "Reading your room…" showed, or later?
9. Exit. The page should say **Diagnostics upload: Sent ✓** (no Copy needed). If it says **Will retry**, reload the page once.

Records to read (the uploaded row's `payload`): `preload.physics` (import, init, warm-up ms), `sessions[0].play.world.async` (worker ms; the main thread's longest world step and frame while it built), `sessions[0].play.world.report.mesh` (`upVotePct`, `oneSided`, `classes`, label), `sessions[0].physics` (step p95 / max, items, releases, guard), `sessions[0].play.look`, `hitches`, `systemsMs.physics` / `.look`.

Acceptance (research-phys §15): the physics system p95 at or under 1 ms a frame in a fight; collider slices at or under 6 ms; Rapier load at or under 0.6 s before Enter; `upVotePct` at least 80 %; no lying item lost inside furniture; your "it lies on the bed" judgement.

## v0.4.1: tests to run

v0.4.1 fixes what you saw in your house in v0.4 (enemies seen through walls, fake spawns, their height). Play a few waves in Roam as before, in the same rooms.

1. **Through walls:** stand in the living room and in the bedroom. Do you ever see a soldier through a wall or a wall corner?
2. **Spawns:** do soldiers now walk in through a real doorway, out of sight until they reach it? Say if one appears in the open, or "inside" a wall behind an open door.
3. **Height:** do they look like real people now (1.70–1.85 m)? Are their feet on your floor in the bedroom, the hall and the living room (not floating, not sunk)?
4. Exit. The upload goes by itself.

## v0.5: tests to run

v0.5 adds the walkthrough scan (the house is learned and kept on the headset), a fix pass for the hitches in your v0.4 record, and much more detail in the hitch log. The page has a new **Scan house** button; the first **Enter MR** in a house with nothing learned starts with the scan too.

1. **Scan.** Tap **Scan house**. Read the card, pull the trigger. Walk bedroom → hall → living room (the path from v0.4), slowly, looking at walls, doorways and furniture. Glance at your watch: does the 9 o'clock window count rooms (blue) and the bottom line say SCAN n%? Is the faint blue floor glow under you the only thing you see? Hold the trigger 2 s to finish.
2. **The hall.** Play a few waves. Do soldiers now come through the hall into the bedroom (v0.4: they could not reach it)? Any wall that is not there, or a doorway that is now blocked?
3. **Kept.** Exit, reload the page, Enter MR: it should go straight to the card (no scan), and the hall should still be open.
4. **Permission.** Did the headset ask for a new permission when you entered (the game now asks for depth, for the scan only)?
5. **Hitches.** Did anything stutter while scanning, when the card came up after the scan, or between waves?
6. Exit. The upload goes by itself.

Records to read: `sessions[0].play.learn` (house id, loaded / saved chunks and bytes, the depth tap: `issued`, `packets`, `drops`, `issueMs`, `getMs`, `framesToSignal`, `depth.width/height/textureType/nIdentity/ownGeometry`; `core.depth` = which way the depth rows run, `calibResidualCm`; `hitTest`: `created`, `entityTypes`, `hitRate`; `result`: openings, walked openings, floors, rooms, coverage), `sessions[0].play.scanResult`, `sessions[0].view` (`depthSensing`, `depthToThree` must be false, `near` 0.02), `sessions[0].perf` (whole-session interval histogram, per-system peaks, callback lateness), `sessions[0].hitches.entries[]` (now with `late`, `prev`, `prevCpu`, `next`, `markerAgeMs`) and `.gaps`, `sessions[0].heap` (GC drops with times), `sessions[0].probes.longAnimationFrames.entries` (which script made a long frame), `sessions[0].growth` (programs / textures / geometries growing in play), `play.capture.ms` / `.frames`.

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

### v0.4 · 2026-11-27 · Quest 3, Roam in the user's house (240 s, realistic difficulty)

The user: "it's looking fake how they spawn, see through my walls, and their height". The session record is replayed on desktop (`tests/fixtures/house-v04-device.json`, `tests/e2e/replay-house.mjs`).

**What the record shows (device facts)**

| Item | Result |
|---|---|
| Space | `unbounded` granted. Floors at y −1.51 (living room scan, 111 m², a 4-point rectangle) and −1.585 (bedroom scan, 14.4 m²). The global mesh covers the living room and the hall only (23.4k triangles kept; wall-face triangles cropped: 5,679) |
| Layout | 20 walls (4 inferred on the rectangle's edges), 6 doors, 8 interior walls with a centred slab, 2 door pockets, 7 nav rooms |
| Spawns | All 6 were tier 3 (`spawnHiddenDoor`, the roam search). 5 of 6 stood in space Space Setup never scanned: 4 behind the living room's doors (the rectangle's area outside its walls) and 1 in a closed corner behind two living-room walls (no door: it could never reach you). 18 path time-outs, 0 hits on you |
| Floors | The bedroom scan's floor plane is 6.7 cm under the scanned floor of its own hall (−1.518). The living room's rectangle overlapped half the bedroom and gave it −1.51 there. Enemies stood on two heights in one room |

**Found on desktop (replay of this record) and fixed in v0.4.1**

- **Seen through walls, through open doors:** the floor rectangle made the space behind the living room's doors "mapped floor". Enemies spawned there, in view through the doorway, where your house has other walls. That space is now unscanned (`NAV_HIDDEN`). Each open door into it has a depth-only curtain on the far face of the wall, and spawns there only right behind a door. Replay: 231,193 px → 0 px of enemy in unscanned space from 21 of your positions.
- **Seen through walls, at corners:** wall slabs ended exactly at the wall plane's ends, leaving a 5 × 5 cm hole at every outer corner. Replay: 8 leaks (up to 147 px at 192 px) → 0. Outer wall ends now reach 6 cm further.
- **Depth precision** (near 0.02 m, far 50 m, 24-bit): under 0.5 mm at 12 m. Not a cause.
- **Height:** the model is 1.868 m (helmet included). Soldiers are now 1.70–1.85 m, random per spawn, with feet, rifle and hit capsules scaled together. Floors come from the scan where the mesh covers them: the bedroom scan's floor moved from −1.585 to −1.518. Where floors overlap, the smaller polygon (the room's own) wins.

**Still open (seen in the record, not fixed in v0.4.1)**

The two room scans' walls close the hall off in both directions. The record says you walked bedroom → hall → living room, but the nav has no way through: the living room scan's wall at the hall's north end, and the bedroom scan's walls on the hall's east and south sides, stand where you walked. Enemies cannot reach the bedroom or the hall, and their slabs may hide enemies behind real openings. Re-drawing the rooms in Space Setup would show whether the scan or the game is wrong.
