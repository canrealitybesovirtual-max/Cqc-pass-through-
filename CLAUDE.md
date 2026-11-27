# CQC Pass-Through: project rules

This is a Quest 3 mixed-reality tactical FPS built with three.js r187 and WebXR. It uses plain ES modules and has no build step.

- **Read first:**
    - `docs/PLAN.md` (the approved plan)
    - `docs/ARCHITECTURE.md`
    - `docs/FEATURES.md`
    - `docs/DECISIONS.md`
- **Work one phase at a time** (PLAN §12). After each stage:
    - the build must run;
    - `npm test` and `node tests/e2e/emulate.mjs` must pass (Playwright is global: `NODE_PATH=$(npm root -g)`);
    - FEATURES.md must be updated.
- **Built from scratch.** The CQC, Blackout and Scanner repos are references only, for tested numbers and lessons. Never copy their code.
- **Never claim an untested browser API works.** Statuses are planned → implemented → desktop-tested → device-verified. Only the user's headset diagnostics can make something device-verified.
- **No hitching:**
    - zero allocations per frame;
    - no shader compile, texture upload or audio decode mid-play;
    - no storage writes from the frame loop;
    - nothing changes a program-key property after warm-up;
    - work over 2 ms goes to a worker.
- **Pure-logic modules never import three.js or the DOM**, so they are testable in Node.
- **Bump `src/version.js`** on every runtime change, because the user identifies builds by it.
- **The user tests only on the headset** (no PC). Ask only for in-headset tests, and keep replies short.
