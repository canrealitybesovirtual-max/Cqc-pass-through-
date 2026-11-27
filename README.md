# CQC Pass-Through

A mixed-reality tactical FPS for Meta Quest 3, played in your real house through passthrough. It is built with three.js and WebXR and runs in the Quest Browser.

**Status:** v0.4: survival waves through your whole Space Setup house (Roam) with a Glock and an AKM held in the controller's grip, CQC's reload controls, gloved hands and a dive-watch menu on the left wrist. v0.4 adds real-surface physics (lay a gun on your bed or table, throw a magazine, pick them up again), the Space Setup scan built in a worker (its global mesh for bullets, occlusion and colliders), a look matched to the room, and automatic diagnostics upload. v0.2 was played on the headset; v0.3 and v0.4 are desktop-tested in the emulator only. A probe session measures what your Quest's browser supports. See [docs/FEATURES.md](docs/FEATURES.md).

- **Play:** open the site in the Quest Browser and tap **Enter MR** (the whole house), or **Enter MR: one spot** (stationary).
- **Develop:**
    - `node tools/serve.mjs`, then open `http://localhost:8080/?emulate` (Meta's IWER emulator).
    - `npm test` runs the unit tests.
    - `NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs` runs the emulated end-to-end check (needs Playwright).
- **Docs:** [plan](docs/PLAN.md) · [architecture](docs/ARCHITECTURE.md) · [decisions](docs/DECISIONS.md) · [device log](docs/DEVICE_LOG.md)

Third-party code: three.js r187 (MIT), Rapier 0.20.0 (`@dimforge/rapier3d-compat`, Apache-2.0) and IWER 2.8.0 (MIT, dev only), all in `vendor/`.
