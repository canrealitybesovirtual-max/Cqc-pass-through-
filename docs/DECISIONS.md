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
