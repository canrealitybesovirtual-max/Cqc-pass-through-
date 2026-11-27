# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-27 | Build from scratch. CQC, Blackout and Scanner are references only. | The old scanner was glitchy and the old guns cost too many draw calls. Repeating their code would repeat their problems. |
| 2026-11-27 | The repository is `canrealitybesovirtual-max/Cqc-pass-through-` | The user's choice |
| 2026-11-27 | All CQC assets (models, sounds) are cleared for use | The user confirmed the licences |
| 2026-11-27 | three.js r187 with `WebGLRenderer` | PLAN §1: depth occlusion is built in. WebGPURenderer's XR has no depth sensing. |
| 2026-11-27 | Plain JavaScript with JSDoc + `@ts-check`, no build step | The user didn't choose, so this uses the plan's recommendation |
| 2026-11-27 | Holster default: right hip | The user didn't choose, so this uses the plan's default. It can be changed in settings (Phase 5). |
| 2026-11-27 | Pistol source shape: CQC M1911, re-baked into the 2-draw layout | Its parts are already split and it is now licensed. G17 stays an option. |
| 2026-11-27 | Hosting: a Render static site from `main` | The user tests on the headset only, so testing needs an HTTPS origin, and it must stay the same origin for anchors and rooms |
| 2026-11-27 | Play sessions use `local-floor` and never request `unbounded` | The system boundary stays untouched during combat (PLAN §2) |
| 2026-11-27 | Depth sensing is off in play by default; probe sessions always request it | Its cost and side effects are measured in Phase 2 first (PLAN §5) |
| 2026-11-27 | three's depth texture is pointed at the current frame's texture before every render (`src/xr/LiveDepth.js`) | three r187 wraps the first frame's texture once. If the Quest hands out a texture per frame, the depth froze at session start and a hand never hid the cube (the user's report from the p1 probe session). A no-op when the browser reuses one texture |
| 2026-11-27 | three's depth quad gets `colorWrite = false` | Its shader writes only `gl_FragDepth`; the colour output was undefined over passthrough. Not part of the program key |
| 2026-11-27 | v0.2 play draws the guns in the main scene (no `fpScene` second pass) | Play has depth sensing off, so real hands cannot cut the gun. The second pass comes with the "Dynamic occlusion" setting |
| 2026-11-27 | In play every controller button belongs to the game; the Phase 1 probes (A timing, B rate, X clear, grips exit) stay in probe sessions. A 60 s timing run starts with wave 1 | A, B, the stick and both grips are weapon controls; hold Y (or the wrist menu) exits |
| 2026-11-27 | EnemyManager applies `enemyHit` from the event bus; WeaponSystem is built without `{ enemies }` | One place applies damage, so a hit is never applied twice |
| 2026-11-27 | The `reduced` retry (play with only `local-floor`) runs the game in a virtual room | It is play's fallback request; it has no Space Setup data |
| 2026-11-27 | v0.2.1: the round starts only after the safe-spot confirmation (`game.pickSpot`); a spot more than 0.25 m from where the world was built rebuilds it there, behind the "Get ready" panel | PLAN §6.2 / gap audit S1: a round could start with a wall inside the ring. The world's nav, spawns and zone belong to the chosen spot |
| 2026-11-27 | v0.2.1: the "Get ready" panel carries a controls card and stays up until a trigger pull (after 1 s) or 8 s | The capture takes about a second; the controls are not discoverable in the headset otherwise |
| 2026-11-27 | v0.2.1: play asks for 72 Hz at start | The AR default is 90 Hz (DEVICE_LOG p1.0); four procedurally animated enemies are unmeasured on the Quest, and 72 Hz gives 13.9 ms a frame |
| 2026-11-27 | v0.2.1: camera near plane 0.02 m in play without depth sensing | The AKM's stock sits 0.27 m behind the grip and clipped through the face at 0.05. Depth sessions keep three's depth-data near plane |
| 2026-11-27 | v0.2.1: Copy exports only the last session; Download / Share keep everything | Twelve sessions plus hitch logs were too large to paste into the chat |
| 2026-11-27 | v0.2.1: the grip fit escape hatch (`?gripPitch`, `?gripY`, `?gripZ`) is applied by PlayKit to the WeaponViews' palm point and `holdPose` | WeaponView's FIT is frozen and has no hook, and `src/weapons/` belongs to another builder. A proper fit setting belongs in WeaponView (Phase 5 calibration) |
| 2026-11-27 | v0.2.1: the card moves on when the trigger is released, not when it is pulled | The card's step runs before `game.preUpdate` in the same frame, so a trigger-down there also confirmed a clear or unmapped spot at once: the spot step was skipped (seen in a virtual room in the emulator) |
