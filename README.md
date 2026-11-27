# CQC Pass-Through

A mixed-reality tactical FPS for Meta Quest 3, played in your real house through passthrough. It is built with three.js and WebXR and runs in the Quest Browser.

**Status:** Phase 1. The project is set up, and a probe session measures what your Quest's browser supports. See [docs/FEATURES.md](docs/FEATURES.md).

- **Play:** open the site in the Quest Browser and tap **Enter MR**.
- **Develop:**
    - `node tools/serve.mjs`, then open `http://localhost:8080/?emulate` (Meta's IWER emulator).
    - `npm test` runs the unit tests.
    - `NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs` runs the emulated end-to-end check (needs Playwright).
- **Docs:** [plan](docs/PLAN.md) · [architecture](docs/ARCHITECTURE.md) · [decisions](docs/DECISIONS.md) · [device log](docs/DEVICE_LOG.md)

Third-party code: three.js r187 (MIT) and IWER 2.8.0 (MIT, dev only), both in `vendor/`.
