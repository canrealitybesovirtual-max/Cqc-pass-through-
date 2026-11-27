// End-to-end check in desktop Chromium with Meta's IWER emulator (Quest 3 profile).
// Needs Playwright installed globally (not a project dependency):
//   NODE_PATH=$(npm root -g) node tests/e2e/emulate.mjs
// Exit code 0 = all checks passed. Prints the play session's CPU time per frame and draw calls.
import { createRequire } from 'node:module';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const checks = [];
const ok = (name, cond, info = '') => { checks.push({ name, pass: !!cond, info }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @type {Record<string, any>} */
const report = {};

const server = await serve(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mainContext = await browser.newContext(); // shared with the reload check (same localStorage)
const page = await mainContext.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Every change of the load text, with the session buttons' state at that moment.
await page.addInitScript(() => {
  window.__loadTrace = [];
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('loadText');
    if (!t) return;
    const $ = (id) => document.getElementById(id).disabled;
    new MutationObserver(() => window.__loadTrace.push({ text: t.textContent, play: $('bPlay'), spot: $('bSpot'), probe: $('bProbe'), bounds: $('bBounds'), at: performance.now() }))
      .observe(t, { childList: true, characterData: true, subtree: true });
  });
});

const state = () => page.evaluate(() => window.__app?.game.state);
const waitState = async (s, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await state()) === s) return true; await sleep(100); } return false; };
const waitFor = async (fn, arg, ms = 10000, every = 150) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(every); } return null; };
const button = (hand, id, v) => page.evaluate(([h, b, x]) => window.__iwer.controllers[h].updateButtonValue(b, x), [hand, id, v]);
const press = async (hand, id, holdMs = 150) => { await button(hand, id, 1); await sleep(holdMs); await button(hand, id, 0); await sleep(150); };
/**
 * SwiftShader frames are slow (100–300 ms), and a long frame pauses the round like a real hitch.
 * Resume the way the player does (a trigger pull once the pause allows it), then wait out the countdown.
 * Returns the pause causes seen, for the report.
 */
const resumeIfPaused = async (ms = 20000) => {
  const seen = new Set();
  const t = Date.now();
  while (Date.now() - t < ms) {
    const p = await page.evaluate(() => { const k = window.__app.play; return { paused: k.weapons.paused || k.game.paused, reasons: k.game.rules.reasons }; });
    if (!p.paused) return [...seen];
    seen.add(p.reasons);
    await press('left', 'trigger', 120); // the left trigger: never fires the gun in the right hand
    await sleep(400);
  }
  return [...seen, 'still paused'];
};

/**
 * The "Get ready" card waits for a trigger pull (after 1 s) or 8 s; then the safe-spot step waits
 * for a trigger pull in a clear spot (a 1 s hold in a tight one). Pull the LEFT trigger (it never
 * fires the gun in the right hand). Where the spot is blocked, the headset moves to the suggested
 * step. Returns the spot statuses seen.
 */
const skipCard = async () => {
  const at = await waitFor(() => window.__app.play.stepName === 'start', null, 15000);
  if (!at) return false;
  await sleep(1300);
  await press('left', 'trigger', 150);
  return !!(await waitFor(() => window.__app.play.stepName !== 'start', null, 10000));
};
const confirmSpot = async (ms = 25000) => {
  const seen = [];
  const t = Date.now();
  while (Date.now() - t < ms) {
    const s = await page.evaluate(() => { const k = window.__app.play, S = k.game.spot; return { step: k.stepName, status: k.game.spotStatus, hasStep: S.hasStep, x: S.stepX, z: S.stepZ }; });
    if (s.step !== 'spot') return seen;
    if (!seen.includes(s.status)) seen.push(s.status);
    if (s.status === 'clear' || s.status === 'unmapped') await press('left', 'trigger', 150);
    else if (s.status === 'tight') {
      // hold until it is accepted (1 s of frames), and no longer: the round's 3 s "Get ready" starts then
      await button('left', 'trigger', 1);
      await waitFor(() => window.__app.play.stepName !== 'spot', null, 8000, 100);
      await button('left', 'trigger', 0);
    }
    else if (s.hasStep) { await page.evaluate(([x, z]) => window.__iwer.position.set(x, 1.6, z), [s.x, s.z]); seen.push('moved'); await sleep(800); }
    await sleep(300);
  }
  return seen.concat('timeout');
};

/** Page helpers: move a controller so its GRIP lands on a world point; aim its ray; read the pixel under the cube. */
const installHelpers = () => page.evaluate(async () => {
  const THREE = await import('three');
  window.__CARRY_HAND = (await import('/src/player/Slots.js')).CARRY_HAND;
  const app = window.__app, dev = window.__iwer;
  window.__h = {
    THREE,
    /** IWER moves the target-ray pose; the grip sits at a fixed offset from it. */
    gripTo(side, p) {
      const c = dev.controllers[side], h = app.input[side];
      const ox = h.grip[12] - h.ray[12], oy = h.grip[13] - h.ray[13], oz = h.grip[14] - h.ray[14];
      c.position.set(p[0] - ox, p[1] - oy, p[2] - oz);
    },
    /**
     * Point at `to`: with a gun in the right hand, the BORE (guns are held in grip space, so the aim ray
     * is 24–29° off the bore: WeaponSystem.aimRayFor); otherwise the controller's −Z (aim ray).
     */
    aimAt(side, to) {
      const g = app.input[side].grip;
      const d = new THREE.Vector3(to[0] - g[12], to[1] - g[13], to[2] - g[14]).normalize();
      const q = new THREE.Quaternion();
      if (!(side === 'right' && app.play && app.play.weapons.aimRayFor(d.x, d.y, d.z, q))) q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), d);
      dev.controllers[side].quaternion.set(q.x, q.y, q.z, q.w);
    },
    level(side) { dev.controllers[side].quaternion.set(0, 0, 0, 1); },
    /**
     * A wrist check: the left controller posed so the watch's dial sits 35 cm from the eyes, 50° below
     * the horizon, facing them, and the head looking at it. Returns the dial target.
     */
    checkWatch() {
      const w = app.play.watch, L = app.input.left, eye = app.play.player.eye;
      const rayM = new THREE.Matrix4().fromArray(L.ray), gripM = new THREE.Matrix4().fromArray(L.grip);
      const G = rayM.clone().invert().multiply(gripM); // ray → grip (IWER's fixed offset)
      const Gt = new THREE.Vector3().setFromMatrixPosition(G);
      const off = w.offset, offT = new THREE.Vector3().setFromMatrixPosition(off);
      const nLocal = new THREE.Vector3().setFromMatrixColumn(off, 2).normalize();
      const target = new THREE.Vector3(-0.18, -0.77, -0.62).normalize().multiplyScalar(0.35).add(eye);
      const toEye = eye.clone().sub(target).normalize();
      const f = new THREE.Vector3(1, 0.12, -0.3).normalize(), Z = f.clone().negate();
      const X0 = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), Z).normalize(), Y0 = new THREE.Vector3().crossVectors(Z, X0);
      let best = -2, bestR = null;
      for (let a = 0; a < 360; a += 2) {
        const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        const X = X0.clone().multiplyScalar(c).addScaledVector(Y0, s), Y = Y0.clone().multiplyScalar(c).addScaledVector(X0, -s);
        const R = new THREE.Matrix4().makeBasis(X, Y, Z);
        const d = nLocal.clone().applyMatrix4(R).normalize().dot(toEye);
        if (d > best) { best = d; bestR = R; }
      }
      const q = new THREE.Quaternion().setFromRotationMatrix(bestR);
      const p = target.clone().sub(Gt.clone().add(offT).applyQuaternion(q));
      dev.controllers.left.position.set(p.x, p.y, p.z);
      dev.controllers.left.quaternion.set(q.x, q.y, q.z, q.w);
      const look = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)));
      dev.quaternion.set(look.x, look.y, look.z, look.w);
      return { target: target.toArray(), face: best };
    },
    /** The right controller 20 cm in front of the dial, its aim ray on the dial's centre. */
    pointAtWatch() {
      const w = app.play.watch, o = w.o, n = w.az;
      const p = o.clone().addScaledVector(n, 0.2);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), n.clone().negate());
      dev.controllers.right.position.set(p.x, p.y, p.z);
      dev.controllers.right.quaternion.set(q.x, q.y, q.z, q.w);
    },
    /** Controllers and head back to IWER's defaults. */
    restorePose() {
      const c = dev.controllers;
      c.left.position.set(-0.25, 1.5, -0.4); c.left.quaternion.set(0, 0, 0, 1);
      c.right.position.set(0.25, 1.5, -0.4); c.right.quaternion.set(0, 0, 0, 1);
      dev.quaternion.set(0, 0, 0, 1);
    },
  };
});

try {
  // ---- Without WebXR: clear message, no errors
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('support').textContent !== 'Checking WebXR…');
  const noXr = await page.textContent('#support');
  ok('no-WebXR message', /not available|not supported/i.test(noXr), noXr);
  ok('no-WebXR: buttons disabled', await page.evaluate(() => document.getElementById('bPlay').disabled));
  ok('no-WebXR: game files not downloaded', await page.evaluate(() => window.__app?.preload?.state === 'idle'));

  // ---- With the emulator
  await page.goto(`http://localhost:${port}/?emulate`);
  await page.waitForFunction(() => window.__app?.game.state === 'menu', null, { timeout: 15000 });
  ok('emulator: AR supported', (await page.textContent('#support')) === 'Mixed reality is supported.', await page.textContent('#support'));

  // ---- Preload before Enter: assets, audio decode, the whole game built, warm-up
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__app?.preload?.state), null, { timeout: 120000 });
  const pre = await page.evaluate(() => {
    const a = window.__app, p = a.preload, m = p.assets && p.assets.models, k = a.play;
    const warmed = new Set(p.warmed);
    return { state: p.state, error: p.error, progress: p.progress, history: p.history, warm: p.warm, times: p.times, warnings: p.warnings,
      text: document.getElementById('loadText').textContent, bar: document.getElementById('loadBar').value,
      play: document.getElementById('bPlay').disabled, spot: document.getElementById('bSpot').disabled, probe: document.getElementById('bProbe').disabled,
      sounds: p.audio ? Object.keys(p.audio.buffers).length : 0, models: m ? Object.keys(m) : [],
      detached: !!m && ['glock', 'akm', 'soldier'].every((x) => m[x].scene.parent === null),
      kit: !!k && k.stepName === 'idle',
      poolsWarmed: !!k && warmed.has(k.world.occluder) && warmed.has(k.world.overlay) && k.enemies.pool.rigs.every((r) => warmed.has(r.root)) && warmed.has(k.weapons.glock.view.root)
        && warmed.has(k.weapons.akm.view.root) && warmed.has(k.weapons.holster) && warmed.has(k.game.tint) && warmed.has(k.watch.root) && warmed.has(k.watch.menuRoot),
      poolsRestored: !!k && k.enemies.pool.rigs.every((r) => !r.root.visible) && !k.weapons.glock.view.root.visible && !k.game.tint.visible && !k.watch.root.visible && !k.watch.menuRoot.visible,
      gloves: !!k && ['glock', 'akm'].map((id) => { const v = k.weapons[id].view; return { id, right: !!v.handR, left: !!v.handL, inGun: !!v.handR && v.root.getObjectById(v.handR.id) === v.handR, shown: !!v.handR && v.handR.visible,
        sameProgram: !!v.handR && v.handR.material.customProgramCacheKey && v.handR.material.customProgramCacheKey() === v.gun.material.customProgramCacheKey(),
        doubleSided: !!v.handR && v.handR.material.side === 2 && (!v.handL || v.handL.material.side === 2) }; }),
      env: { set: !!a.gfx.scene.environment, same: a.gfx.scene.environment === a.gfx.envTexture, intensity: a.gfx.scene.environmentIntensity, lighting: a.gfx.lighting,
        cloth: k && k.enemies.pool.rigs[0] ? k.enemies.pool.rigs[0].mesh.material.envMapIntensity : null },
      watchSounds: !!k && k.watchSounds && !!p.audio.buffers.watchTick && !!p.audio.buffers.watchAlert,
      diag: JSON.parse(a.diag.json()).preload, trace: window.__loadTrace,
      grip: k && { ...k.gripReport } };
  });
  ok('preload: ready', pre.state === 'ready', pre.error || `${pre.times.totalMs} ms (assets ${pre.times.assetsMs}, audio ${pre.times.audioMs}, pools ${pre.times.poolsMs}, warm-up ${pre.times.warmMs})`);
  const pcts = pre.history.map((h) => h.pct);
  ok('preload: progress reaches 100 %', pre.progress === 1 && pcts.at(-1) === 100 && pre.bar === 1 && pcts.every((v, i) => i === 0 || v >= pcts[i - 1]),
    `${pcts.length} steps: ${pcts.slice(0, 6).join(',')}…${pcts.at(-1)}`);
  const during = pre.trace.filter((e) => /^Loading \d+%$/.test(e.text) && e.text !== 'Loading 100%');
  ok('preload: "Loading n%" shown with Enter MR (both buttons) and Probe disabled', during.length > 0 && during.every((e) => e.play && e.spot && e.probe && e.bounds),
    `${during.length} updates, e.g. ${during.slice(0, 3).map((e) => e.text).join(' | ')}`);
  ok('preload: Enter MR (whole house) and Enter MR: one spot enabled only after the warm-up', !pre.play && !pre.spot && !pre.probe && /^Ready/.test(pre.text)
    && pre.trace.filter((e) => !e.play || !e.spot).every((e) => /^Ready/.test(e.text)), pre.text);
  ok('preload: models and sounds loaded', pre.models.length === 3 && pre.sounds >= 20, `models ${pre.models.join(',')}; ${pre.sounds} sound keys; ${pre.warnings.join('; ')}`);
  ok('preload: the game is built at load (world, weapons, enemy pool, session, watch)', pre.kit);
  ok('preload: every pool (and the holster, the watch and its menu) is in the warm-up draw, then hidden again', pre.poolsWarmed && pre.poolsRestored);
  ok('preload: gloved hands come inside both gun GLBs (children of the gun root, the gun\'s shader hook, double-sided: the open glove shell), hidden until held',
    pre.gloves.every((g) => g.right && g.inGun && !g.shown && g.sameProgram && g.doubleSided) && pre.gloves.find((g) => g.id === 'akm').left, JSON.stringify(pre.gloves));
  ok('preload: the room environment map is set before the warm-up (PMREM), enemy cloth dimmed', pre.env.set && pre.env.same && pre.env.intensity > 0 && pre.env.cloth === 0.35,
    JSON.stringify(pre.env));
  ok('preload: the watch\'s tick and alert sounds are made before Enter', pre.watchSounds);
  ok('preload: programs count recorded', pre.warm && pre.warm.programs > 0 && pre.warm.textures > 0 && pre.warm.geometries > 0 && pre.diag && pre.diag.warm.programs === pre.warm.programs,
    pre.warm && `${pre.warm.programs} programs, ${pre.warm.textures} textures, ${pre.warm.geometries} geometries; ${pre.warm.drawables} drawables, ${pre.warm.calls} calls, ${pre.warm.textureCount} uploads`);
  ok('preload: asset scenes detached again', pre.detached);
  ok('preload: no grip fit saved or in the URL: the default fit on both guns', pre.grip && pre.grip.fitVersion === 2 && pre.grip.source === 'default'
    && ['glock', 'akm'].every((id) => pre.grip[id].pitch === 0 && pre.grip[id].up === 0 && pre.grip[id].fwd === 0), pre.grip && JSON.stringify({ glock: pre.grip.glock.pos, akm: pre.grip.akm.pos }));
  report.preload = { ...pre.times, programs: pre.warm.programs, textures: pre.warm.textures, geometries: pre.warm.geometries, drawables: pre.warm.drawables };

  // Fake GPU depth (IWER has none): XRWebGLBinding.getDepthInformation returns, while on, one of two
  // R32F 2-layer textures, a DIFFERENT texture object for "far room" and "hand at 0.4 m", the way a
  // browser handing out a texture per frame would. Installed before the probe session starts.
  await page.evaluate(() => {
    const app = window.__app, gl = app.gfx.gl, N = 16;
    const mk = (z) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, N, N, 2);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, N, N, 2, gl.RED, gl.FLOAT, new Float32Array(N * N * 2).fill(1 - 0.1 / z));
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, p, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      return t;
    };
    const tex = { far: mk(5), hand: mk(0.4) };
    app.gfx.renderer.resetState();
    const F = window.__fakeDepth = { on: false, mode: 'far', calls: 0 };
    const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const proto = XRWebGLBinding.prototype, orig = proto.getDepthInformation;
    proto.getDepthInformation = function (view) {
      if (!F.on) return orig.call(this, view);
      F.calls++;
      return { isValid: true, texture: tex[F.mode], width: N, height: N, depthNear: 0.1, depthFar: Infinity, rawValueToMeters: 0,
        normDepthBufferFromNormView: { matrix: I }, textureType: 'texture-array', imageIndex: view.eye === 'right' ? 1 : 0 };
    };
  });

  // ---- Probe session
  await page.click('#bProbe');
  ok('probe: entered xr', await waitState('xr'));
  await sleep(4000);
  await installHelpers();
  const p1 = await page.evaluate(() => {
    const a = window.__app, T = window.__h.THREE, cam = a.gfx.renderer.xr.getCamera();
    // the panel must not sit between the eyes and the cube (the hand test looks at the cube)
    const d = a.cube.mesh.position.clone().sub(cam.position);
    const ray = new T.Raycaster(cam.position.clone(), d.clone().normalize(), 0, d.length());
    const blocks = ray.intersectObject(a.panel.mesh, false).length;
    return { frames: a.loop.frames, lines: a.probes.lines(), rec: a.rec, uploads: a.panel.uploads, calls: a.gfx.renderer.info.render.calls,
      programs: a.gfx.renderer.info.programs.length, cube: a.cube.mesh.visible, panel: a.panel.mesh.visible, blocks };
  });
  ok('probe: frames running', p1.frames > 60, `${p1.frames} frames`);
  ok('probe: capability log', Array.isArray(p1.rec.granted.enabledFeatures) && p1.rec.granted.enabledFeatures.length > 0, p1.rec.granted.enabledFeatures.join(','));
  ok('probe: space chosen', ['unbounded', 'local-floor'].includes(p1.rec.granted.referenceSpace), p1.rec.granted.referenceSpace);
  ok('probe: layer logged', !!p1.rec.layer.type, JSON.stringify(p1.rec.layer));
  ok('probe: gl extensions logged', p1.rec.gl.extensions && 'OVR_multiview2' in p1.rec.gl.extensions);
  ok('probe: anchor probe finished', p1.rec.probes.anchor.state !== 'pending', p1.rec.probes.anchor.state);
  ok('probe: cube and panel visible', p1.cube && p1.panel);
  ok('probe: the panel does not hide the cube', p1.blocks === 0, `${p1.blocks} panel hits on the eye→cube line`);
  ok('probe: panel uploads limited', p1.uploads <= 8, `${p1.uploads} uploads in ~4 s`);
  ok('probe: HUD lines', p1.lines.length >= 8, p1.lines.join(' | '));
  const st1 = await page.evaluate(async () => { const m = await import('/src/core/Warmup.js'); return { ...m.assertStable(window.__app.gfx.renderer, () => {}), base: m.baselineOf(window.__app.gfx.renderer) }; });
  ok('probe: programs flat after warm-up', st1.checked && st1.programs <= 0 && p1.programs === pre.warm.programs,
    `${p1.programs} programs in XR vs ${pre.warm.programs} at warm-up; textures ${st1.textures >= 0 ? '+' : ''}${st1.textures}, geometries ${st1.geometries >= 0 ? '+' : ''}${st1.geometries}`);

  // ---- The user's report "Hand does not cover the cube": live depth must follow the CURRENT frame's texture.
  // The pixel under the cube's centre is read right after each render (left eye).
  await page.evaluate(() => {
    const a = window.__app, r = a.gfx.renderer, gl = a.gfx.gl, T = window.__h.THREE, v = new T.Vector3(), buf = new Uint8Array(16);
    const orig = r.render.bind(r);
    window.__px = null;
    r.render = function (scene, camera) {
      orig(scene, camera);
      const c0 = r.xr.isPresenting ? r.xr.getCamera().cameras[0] : null;
      if (!c0 || !a.cube.placed) return;
      v.copy(a.cube.mesh.position).project(c0);
      const x = Math.floor(c0.viewport.x + ((v.x + 1) / 2) * c0.viewport.z), y = Math.floor(c0.viewport.y + ((v.y + 1) / 2) * c0.viewport.w);
      gl.readPixels(x, y, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let alpha = 0;
      for (let i = 3; i < 16; i += 4) alpha = Math.max(alpha, buf[i]);
      window.__px = { x, y, rgba: Array.from(buf.subarray(0, 4)), alpha };
    };
    window.__restoreRender = () => { r.render = orig; };
  });
  const px = () => page.evaluate(() => window.__px);
  const depthState = () => page.evaluate(() => { const a = window.__app, L = a.liveDepth; return { has: a.gfx.renderer.xr.hasDepthSensing(), active: L.active, valid: L.valid, changes: L.changes, line: L.line(), quad: a.gfx.renderer.xr.getDepthSensingMesh()?.material.colorWrite }; });
  await page.evaluate(() => { window.__fakeDepth.on = true; window.__fakeDepth.mode = 'far'; });
  await sleep(1500);
  const dFar = { px: await px(), d: await depthState() };
  ok('depth: three\'s occlusion pass runs with the fake depth', dFar.d.has && dFar.d.active && dFar.d.valid > 10 && dFar.d.quad === false, `${dFar.d.line}; depth quad colorWrite ${dFar.d.quad}`);
  ok('depth: room 5 m away, the cube (1.2 m) is visible', dFar.px && dFar.px.alpha > 200, JSON.stringify(dFar.px));
  await page.evaluate(() => { window.__fakeDepth.mode = 'hand'; });
  await sleep(800);
  const dHand = { px: await px(), d: await depthState() };
  ok('depth: a hand at 0.4 m (a new depth texture) covers the cube', dHand.px && dHand.px.alpha === 0 && dHand.d.changes > 0, `${JSON.stringify(dHand.px)}; ${dHand.d.line}`);
  // three r187's stock behaviour (no refresh): it keeps the texture it wrapped, so the view never follows the depth
  await page.evaluate(() => { window.__app.liveDepth.refresh = false; window.__fakeDepth.mode = 'far'; });
  await sleep(800);
  const dStale = await px();
  ok('depth: without the refresh (three r187 as shipped) the depth is stale: the hand "stays"', dStale && dStale.alpha === 0, `${JSON.stringify(dStale)} after the hand moved away`);
  await page.evaluate(() => { window.__app.liveDepth.refresh = true; });
  await sleep(800);
  const dBack = await px();
  ok('depth: with the refresh the cube shows again when the hand moves away', dBack && dBack.alpha > 200, JSON.stringify(dBack));
  await press('left', 'y-button');
  await sleep(500);
  const dv = await page.evaluate(() => { const a = window.__app; return { on: a.depthView.on, vis: a.depthView.mesh.visible, line: a.probes.lines().find((l) => /Depth/.test(l)), programs: a.gfx.renderer.info.programs.length }; });
  ok('depth: Y shows the depth picture', dv.on && dv.vis, dv.line);
  ok('depth: only three\'s lazily made depth quad compiled (picture warmed at load)', dv.programs <= pre.warm.programs + 1, `${dv.programs} programs vs ${pre.warm.programs} at warm-up`);
  await press('left', 'y-button');
  await page.evaluate(() => { window.__fakeDepth.on = false; window.__restoreRender(); });

  // Short timing run through the real button path is 60 s; use a 2 s run via the API to check the plumbing.
  await page.evaluate(() => window.__app.perf.startRun(2000, 'e2e 2 s'));
  await sleep(3000);
  const run = await page.evaluate(() => window.__app.rec.perfRuns[0]);
  ok('probe: timing run completes', run && run.frames > 20 && typeof run.cpu.p99 === 'number', run ? `${run.frames} frames, cpu p99 ${run.cpu.p99} ms, interval p99 ${run.interval.p99}` : 'none');

  // Buttons: A starts a run, X toggles clear, B tries a rate switch
  await press('right', 'a-button');
  ok('probe: A starts a 60 s run', await page.evaluate(() => window.__app.perf.running));
  await press('left', 'x-button');
  ok('probe: X toggles explicit clear', await page.evaluate(() => window.__app.loop.explicitClear === false));
  await press('left', 'x-button');
  await press('right', 'b-button');
  await sleep(500);
  const ev = await page.evaluate(() => window.__app.rec.events.map((e) => e.msg));
  ok('probe: B rate switch logged', ev.some((m) => /rate/.test(m)), ev.filter((m) => /rate/.test(m)).join('; '));

  // Visibility change pauses and cancels the run
  await page.evaluate(() => window.__iwer.updateVisibilityState('visible-blurred'));
  await sleep(400);
  const vis = await page.evaluate(() => ({ paused: window.__app.game.paused, running: window.__app.perf.running }));
  ok('probe: blur pauses and cancels the run', vis.paused && !vis.running, JSON.stringify(vis));
  await page.evaluate(() => window.__iwer.updateVisibilityState('visible'));
  await sleep(300);

  // Exit with both grips for > 1 s
  await page.evaluate(() => { window.__iwer.controllers.left.updateButtonValue('squeeze', 1); window.__iwer.controllers.right.updateButtonValue('squeeze', 1); });
  await sleep(1600);
  await page.evaluate(() => { window.__iwer.controllers.left.updateButtonValue('squeeze', 0); window.__iwer.controllers.right.updateButtonValue('squeeze', 0); });
  ok('probe: both grips end the session', await waitState('menu', 4000));
  const d1 = await page.evaluate(() => JSON.parse(window.__app.diag.json()));
  const last = d1.sessions.at(-1);
  ok('probe: session saved to diagnostics', last && last.mode === 'probe' && last.endedAt, last && last.endedAt);
  ok('probe: live-depth summary saved', last && last.probes.liveDepth && last.probes.liveDepth.textureChanges > 0, last && JSON.stringify(last.probes.liveDepth));
  ok('probe: incomplete 60 s run recorded', last.perfRuns.some((r) => r.incomplete || /cancelled/.test(r.label)), JSON.stringify(last.perfRuns.map((r) => r.label)));
  ok('probe: hitch log exported', last.hitches && typeof last.hitches.total === 'number', last.hitches && `${last.hitches.total} hitches`);
  ok('diagnostics persisted', await page.evaluate(() => !!localStorage.getItem('cqcpt.diag.v1')));
  ok('summary shown', /probe/.test(await page.textContent('#summary')));
  // IWER's controllers back to their default poses for the play session
  await page.evaluate(() => { const c = window.__iwer.controllers; c.left.position.set(-0.25, 1.5, -0.4); c.right.position.set(0.25, 1.5, -0.4); c.left.quaternion.set(0, 0, 0, 1); c.right.quaternion.set(0, 0, 0, 1); });

  // ---- Play session (?emulate plays in the two-room house fixture)
  // Counts before play: the probe's fake depth made three compile its lazily created depth quad
  // (one program, one geometry); play must add nothing on top.
  const before = await page.evaluate(() => { const r = window.__app.gfx.renderer; return { programs: r.info.programs.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries }; });
  await page.click('#bPlay');
  ok('play: entered xr', await waitState('xr'));
  // SwiftShader frames take 100–300 ms (the headset: 11 ms), and the round pauses on any frame gap
  // over 250 ms like a real hitch. The player and game systems (GameSession's pause decisions run
  // after the player) see a clock whose steps are capped at 200 ms, so the emulator's slowness is not
  // taken for hitches; everything else runs on real time.
  await page.evaluate(() => {
    let vt = 0, last = -1;
    const clock = (t) => { if (t !== last) { vt = last < 0 ? t : vt + Math.min(t - last, 200); last = t; } return vt; };
    for (const name of ['player', 'game']) {
      const sys = window.__app.loop.systems.find((x) => x.name === name), orig = sys.update;
      sys.update = (dt, t, f, c) => orig(dt, clock(t), f, c);
    }
  });
  // The "Get ready" card (world built behind it) with the controls; in Roam a trigger pull starts the round where you stand
  const card = await waitFor(() => { const a = window.__app, k = a.play; return k.stepName === 'start' && { lines: a.panel.lines.slice(), visible: a.panel.mesh.visible }; }, null, 15000);
  ok('play: the "Get ready" card shows the CQC controls after the build', card && card.visible && card.lines[0] === 'Get ready' && card.lines.includes('[How to play]')
    && card.lines.some((l) => /Exit: hold Y/.test(l)) && card.lines.some((l) => /A \(or X on the gun\): drop the magazine/.test(l)) && card.lines.some((l) => /B \(or Y on the gun\)/.test(l))
    && card.lines.some((l) => /watch/.test(l)) && card.lines.at(-1) === 'Pull the trigger to start', card && card.lines.join(' | '));
  const skipped = await skipCard();
  const ready = await waitFor(() => window.__app.play.stepName === 'play', null, 15000);
  const g0 = await page.evaluate(() => {
    const a = window.__app, k = a.play, rec = a.rec, g = k.game;
    return { space: rec.granted.referenceSpace, req: rec.requested, systems: a.perf.systems, loop: a.loop.systems.map((s) => s.name), play: rec.play, warmXR: rec.warmXR,
      snap: rec.spaceSnapshot && { planes: rec.spaceSnapshot.planes.length, meshes: rec.spaceSnapshot.meshes.length }, world: k.world.describe(), virtual: k.world.virtual,
      phase: g.phaseName, roam: g.roam, worldRoam: k.world.roamOn, rooms: k.world.stats.rooms, spotting: g.spotting, ring: g.ring.visible, msg: g.panel.mesh.visible ? g.panel.lines : null,
      programs: a.gfx.renderer.info.programs.length, zone: { ...k.player.zone }, head: { x: k.player.head.x, z: k.player.head.z }, view: rec.view,
      xrNear: a.gfx.renderer.xr.getCamera().near, appPanel: a.panel.mesh.visible, watchOn: k.watch.enabled, sink: g.warnSink === k.watch };
  });
  ok('play: whole house by default: `unbounded` requested (IWER grants it) and the Roam rules', g0.req.includes('unbounded') && ['unbounded', 'local-floor'].includes(g0.space) && g0.roam && g0.worldRoam
    && g0.play.mode === 'roam', `${g0.space}; ${g0.req.join(',')}; ${g0.rooms} rooms`);
  report.space = g0.space;
  ok('play: systems in the contract order', g0.loop.join(',') === 'input,world,player,weapons,enemies,game,audio,ui' && g0.systems.join(',') === 'input,world,player,weapons,enemies,game,audio,ui,render', g0.systems.join(' → '));
  ok('play: Space Setup snapshot captured (house fixture) and stored in the session record', !!ready && g0.snap && g0.snap.planes === 19 && g0.snap.meshes === 4 && g0.play.source === 'fixture',
    g0.snap && `${g0.snap.planes} planes, ${g0.snap.meshes} meshes`);
  ok('play: world built from it behind the Get ready panel (Roam: rooms found)', !g0.virtual && /2 floors/.test(g0.world) && g0.play.world.buildMs >= 0 && g0.play.world.mode === 'roam' && g0.rooms >= 2,
    `${g0.world}; build ${g0.play.world.buildMs} ms`);
  ok('play: one XR warm draw of every pool, nothing new compiled', g0.warmXR && !g0.warmXR.skipped && g0.warmXR.programs === before.programs && g0.programs === before.programs,
    g0.warmXR && `${g0.warmXR.drawables} drawables, ${g0.warmXR.calls} calls, ${g0.warmXR.ms} ms; ${g0.programs} programs (before play ${before.programs}, warm-up ${pre.warm.programs})`);
  ok('play (Roam): the card\'s trigger pull starts the round where you stand: no spot step, no ring, no zone, no text in the view', skipped && !!ready && ['ready', 'wave'].includes(g0.phase)
    && !g0.spotting && !g0.ring && g0.msg === null && !g0.appPanel && g0.zone.r === 0 && g0.play.spot && g0.play.spot.mode === 'roam' && g0.play.spot.rebuilt === false && g0.watchOn && g0.sink,
    `${g0.phase}; msg ${JSON.stringify(g0.msg)}; ${JSON.stringify(g0.play.spot)}; card up ${g0.play.cardMs} ms`);
  ok('play: near plane 0.02 m without depth sensing', g0.view && g0.view.near === 0.02 && !g0.view.depthSensing && Math.abs(g0.xrNear - 0.02) < 1e-9, JSON.stringify(g0.view));
  const fr = await waitFor(() => { const F = window.__app.rec.probes.frameRate; return F && F.request !== 'pending' && { ...F }; }, null, 5000);
  ok('play: 72 Hz requested (updateTargetFrameRate), logged with the measured rate', fr && fr.target === 72 && fr.request === 'ok' && fr.offered.includes(72),
    fr && `${fr.request}; offered ${fr.offered.join('/')}; attr after ${fr.attrAfter}; measured ${fr.measuredHz}`);
  // Audio: context state at start and 1 s later; an XR 'select' resumes a suspended context
  const au0 = await waitFor(() => { const A = window.__app.rec.audio; return A && A.at1s !== null && { ...A }; }, null, 5000);
  ok('play: audio context state logged at session start and 1 s later', au0 && typeof au0.atStart === 'string' && typeof au0.at1s === 'string', au0 && `${au0.atStart} → ${au0.at1s}`);
  await page.evaluate(async () => { const au = window.__app.play.audio; au._resumeAt = Infinity; await au.ctx.suspend(); });
  await press('right', 'trigger', 150); // empty right hand: only the XR select events
  const au1 = await waitFor(() => { const au = window.__app.play.audio, A = window.__app.rec.audio; return A.gestureResumes > 0 && au.state === 'running' && { ...A, state: au.state }; }, null, 4000);
  await page.evaluate(() => { window.__app.play.audio._resumeAt = 0; });
  ok('play: an XR select resumes a suspended audio context', !!au1, au1 && `first ${au1.firstGesture}, ${au1.gestureResumes} resumes, now ${au1.state}`);
  await installHelpers();

  // Wave 1: enemies spawn out of view and walk in
  const spawned = await waitFor(() => { const k = window.__app.play; return k.game.wave >= 1 && k.enemies.stats.spawned > 0; }, null, 12000);
  const e0 = await page.evaluate(() => { const k = window.__app.play, a = k.enemies.brain.agents.find((x) => x.active); return a && { x: a.x, z: a.z, walk: k.world.nav.isWalkable(a.x, a.z), d: Math.hypot(a.x - k.player.head.x, a.z - k.player.head.z) }; });
  ok('play: wave 1 starts and an enemy spawns on walkable floor, away from the player', !!spawned && e0 && e0.walk && e0.d >= 2.5, e0 && `at (${e0.x.toFixed(2)}, ${e0.z.toFixed(2)}), ${e0.d.toFixed(1)} m away`);
  const runInfo = await page.evaluate(() => ({ running: window.__app.perf.running, label: window.__app.perf.runLabel }));
  ok('play: a 60 s timing run starts with wave 1', runInfo.running && runInfo.label === 'play wave 1', JSON.stringify(runInfo));
  await sleep(1500);
  const e1 = await page.evaluate(() => { const k = window.__app.play, a = k.enemies.brain.agents.find((x) => x.active); return a && { x: a.x, z: a.z, poses: k.enemies.stats.poses }; });
  const moved = e0 && e1 ? Math.hypot(e1.x - e0.x, e1.z - e0.z) : 0;
  ok('play: the enemy walks (and is posed)', moved > 0.3 && e1.poses > 5, `${moved.toFixed(2)} m in 1.5 s, ${e1 && e1.poses} poses`);

  // Draw the Glock: right grip on the holster (right hip), squeeze
  const hol = await page.evaluate(() => Array.from(window.__app.play.weapons.body.holster.p));
  for (let i = 0; i < 3; i++) { await page.evaluate((p) => window.__h.gripTo('right', p), hol); await sleep(200); }
  await button('right', 'squeeze', 1);
  const drew = await waitFor(() => window.__app.play.weapons.held?.id === 'glock', null, 3000);
  ok('play: right grip at the right hip draws the Glock', !!drew, `holster at (${hol.map((v) => v.toFixed(2)).join(', ')})`);
  await page.evaluate(() => window.__h.gripTo('right', [0.18, 1.36, -0.38]));
  await sleep(700);

  // Fire with the trigger at an enemy in line of sight
  const shots0 = await page.evaluate(() => ({ ...window.__app.play.weapons.stats }));
  let hits = 0, tries = 0;
  /** @type {string[]} */ const evs = [];
  await page.evaluate(() => { const E = window.__app.play.events; window.__ev = []; for (const t of ['shot', 'enemyHit', 'enemyKilled', 'playerHit']) E.on(t, () => window.__ev.push(t)); });
  await page.evaluate(() => { window.__pdmg = []; window.__app.play.events.on('playerHit', (p) => window.__pdmg.push(p.damage)); });
  while (hits === 0 && tries < 6) {
    const tgt = await waitFor(() => {
      const k = window.__app.play, e = k.player.eye;
      for (const a of k.enemies.brain.agents) if (a.active && a.alive && k.world.segmentClear(e.x, e.y, e.z, a.x, a.y + 1.25, a.z)) return [a.x, a.y + 1.2, a.z];
      return null;
    }, null, 15000, 100);
    if (!tgt) break;
    tries++;
    await page.evaluate((t) => window.__h.aimAt('right', t), tgt);
    await sleep(250);
    await page.evaluate(() => { const k = window.__app.play, a = k.enemies.brain.agents.find((x) => x.active && x.alive); if (a) window.__h.aimAt('right', [a.x, a.y + 1.2, a.z]); });
    await sleep(150);
    const causes = await resumeIfPaused();
    if (causes.length) report.pausesResumed = (report.pausesResumed || []).concat(causes);
    await press('right', 'trigger', 200);
    await sleep(250);
    hits = await page.evaluate((h0) => window.__app.play.weapons.stats.enemyHits - h0, shots0.enemyHits);
  }
  // the enemies need a moment to see the player, settle their aim and fire (more so when the first shot hit at once)
  for (let i = 0; i < 8 && !(await page.evaluate(() => window.__app.play.enemies.stats.shots > 0)); i++) {
    const c = await resumeIfPaused();
    if (c.length) report.pausesResumed = (report.pausesResumed || []).concat(c);
    await sleep(800);
  }
  const w1 = await page.evaluate(() => { const k = window.__app.play; return { stats: { ...k.weapons.stats }, en: { ...k.enemies.stats }, mag: k.weapons.glock.inst.magRounds, ev: window.__ev.slice(), phase: k.game.phaseName, health: k.game.health }; });
  ok('play: the trigger fires the Glock (rounds leave the magazine)', w1.stats.shots > shots0.shots && w1.mag < 17, `${w1.stats.shots} shots, ${w1.mag} left in the magazine`);
  ok('play: a shot hits an enemy (enemyHit → EnemyManager)', hits > 0 && w1.ev.includes('enemyHit'), `${hits} enemy hits in ${tries} aimed shots; events ${[...new Set(w1.ev)].join(', ')}; killed ${w1.en.killed}`);
  ok('play: enemies shoot back (playerHit → health)', w1.en.shots > 0, `${w1.en.shots} enemy shots, ${w1.en.hitsOnPlayer} hit; health ${w1.health}, phase ${w1.phase}`);
  report.combat = { playerShots: w1.stats.shots, enemyHits: w1.stats.enemyHits, kills: w1.en.killed, enemyShots: w1.en.shots, hitsOnPlayer: w1.en.hitsOnPlayer, health: w1.health };
  // Enemy follow-ups: the "test" difficulty, spawn tiers, hit puffs (gap audit F1, F4, F6)
  const efx = await page.evaluate(() => {
    const k = window.__app.play, W = k.world, rep = W.report();
    return { rec: rep.spawn.recent, search: rep.spawn.roamSearch, rooms: W.stats.rooms, dmg: window.__pdmg.slice(), diff: k.enemies.brain.diff.name,
      puffWarm: new Set(window.__app.preload.warmed).has(k.enemies.puff.mesh), puffs: k.enemies.puff.spawned };
  });
  const efe = w1.en, tiered = efe.spawnBehind + efe.spawnHiddenRoom + efe.spawnHiddenDoor + efe.spawnInView;
  ok('play: enemies on the "test" difficulty by default (torso 10, head 20)', efe.difficulty === 'test' && efx.diff === 'test' && efx.dmg.every((d) => d === 10 || d === 20),
    `${efe.difficulty}; rounds on the player ${efx.dmg.join(', ') || 'none yet'}`);
  ok('play: every spawn came from the world spawner with its tier', efe.spawned > 0 && tiered === efe.spawned && efe.spawnDirect === 0 && efe.lastSpawnTier >= 1 && efx.rec.length >= Math.min(efe.spawned, 16),
    `${efe.spawned} spawns: behind ${efe.spawnBehind}, room ${efe.spawnHiddenRoom}, door ${efe.spawnHiddenDoor}, in view ${efe.spawnInView}`);
  ok('play (Roam): enemies spawn in another room than the player\'s (hidden, through the house)', efx.rooms >= 2 && efx.rec.length > 0 && efx.rec.every((r) => r.room > 0 && r.playerRoom > 0 && r.room !== r.playerRoom),
    `${efx.rooms} rooms; ${efx.rec.map((r) => `room ${r.room} (player in ${r.playerRoom}, tier ${r.tier})`).join(', ')}; search ${JSON.stringify(efx.search)}`);
  report.spawns = efx.rec;
  ok('play: a hit on an enemy shows a pooled puff (warmed at load)', efx.puffWarm && efe.puffs >= hits && efx.puffs === efe.puffs, `${efe.puffs} puffs for ${hits} hits`);
  report.enemies = { difficulty: efe.difficulty, spawnTiers: { behind: efe.spawnBehind, room: efe.spawnHiddenRoom, door: efe.spawnHiddenDoor, inView: efe.spawnInView }, puffs: efe.puffs, pathMaxStepMs: efe.pathMaxStepMs, pathTimeouts: efe.pathTimeouts };

  // Magazine release (A): the magazine drops; holding A 0.8 s with no magazine = assisted reload (1.2 s; test aid)
  await page.evaluate(() => window.__h.level('right'));
  await sleep(200);
  await press('right', 'a-button');
  await sleep(400);
  const m1 = await page.evaluate(() => { const w = window.__app.play.weapons; return { seated: w.glock.inst.magSeated, dropped: w.fx.magPools.reduce((n, B) => n + B.count, 0) }; });
  ok('play: A releases the magazine; it drops as a pooled object', !m1.seated && m1.dropped > 0, JSON.stringify(m1));
  await press('right', 'a-button', 150);
  const tapNoReload = await page.evaluate(() => { const w = window.__app.play.weapons; return !w.glock.inst.magSeated && w.glock.assistT < 0; });
  await press('right', 'a-button', 3500); // 0.8 s of game time (dt is clamped to 0.1 s per slow emulator frame)
  const reloaded = await waitFor(() => { const w = window.__app.play.weapons; return w.glock.inst.magSeated && w.glock.inst.magRounds === 17; }, null, 6000);
  ok('play: a second A tap does not reload; holding A with the magazine out = assisted reload (17 rounds)', tapNoReload && !!reloaded, await page.evaluate(() => JSON.stringify({ reloads: window.__app.play.weapons.stats.reloads, rounds: window.__app.play.weapons.glock.inst.magRounds })));

  // Holster the Glock (let go at the hip), then take the AKM from over the right shoulder
  const hol2 = await page.evaluate(() => Array.from(window.__app.play.weapons.body.holster.p));
  for (let i = 0; i < 3; i++) { await page.evaluate((p) => window.__h.gripTo('right', p), hol2); await sleep(150); }
  await button('right', 'squeeze', 0);
  const holstered = await waitFor(() => { const w = window.__app.play.weapons; return w.held === null && w.glock.carry.inSlot; }, null, 3000);
  ok('play: letting go at the hip holsters the Glock', !!holstered);
  const gloveOff = await waitFor(() => { const w = window.__app.play.weapons; return w.glock.carry.inSlot && !w.glock.view.handR.visible; }, null, 3000);
  ok('play: the glove is hidden once the gun is holstered', !!gloveOff);

  // ---- The watch: wake on a wrist check, open the menu with the right ray + trigger, a setting, the gun-fit page
  const wk = await page.evaluate(() => window.__h.checkWatch());
  const awake = await waitFor(() => window.__app.play.watch.wake.awake, null, 6000);
  const wk2 = await page.evaluate(() => { const w = window.__app.play.watch; return { shown: w.root.visible, wakes: w.stats.wakes, info: w._s[9] }; });
  ok('watch: a wrist check (dial toward the eyes, head looking at it) wakes the watch', !!awake && wk2.shown && wk2.wakes >= 1, `face cos ${wk.face.toFixed(3)}; ${JSON.stringify(wk2)}`);
  await page.evaluate(() => window.__h.pointAtWatch());
  const pointed = await waitFor(() => window.__app.play.watch.capture, null, 4000);
  const firedBefore = await page.evaluate(() => window.__app.play.weapons.stats.shots);
  await press('right', 'trigger', 300);
  const opened = await waitFor(() => { const k = window.__app.play; return k.watch.menuOpen && k.game.menuOpen && { phase: k.game.phaseName, paused: k.game.paused, menu: k.watch.menuRoot.visible }; }, null, 4000);
  ok('watch: pointing the right ray at the awake dial captures the trigger; a pull opens the menu (a live round pauses)', !!pointed && !!opened && opened.menu
    && (opened.paused || opened.phase === 'over') && (await page.evaluate((n) => window.__app.play.weapons.stats.shots === n, firedBefore)), `pointed ${!!pointed}; ${JSON.stringify(opened)}`);
  await page.evaluate(() => window.__h.restorePose());
  // RESTART (two taps): a fresh round. From here the e2e keeps the player alive (test aid: a death ends the round, and an
  // ended round has nothing to pause, cue or requeue)
  await page.evaluate(() => { window.__app.play.game.rules.damage = () => 0; });
  await page.evaluate(() => { const w = window.__app.play.watch; w.select('restart'); w.select('restart'); });
  const restarted = await waitFor(() => { const k = window.__app.play; return !k.watch.menuOpen && ['ready', 'wave'].includes(k.game.phaseName) && k.game.health === 100 && { phase: k.game.phaseName, wave: k.game.wave }; }, null, 4000);
  ok('watch: RESTART (two taps) starts a fresh round and closes the menu', !!restarted, JSON.stringify(restarted));
  // AMMO LINE off → saved after the frame (setTimeout) → on again
  const ammo0 = await page.evaluate(() => window.__app.play.watch.status.ammoLine);
  await page.evaluate(() => window.__app.play.watch.select('ammo'));
  const ammoSaved = await waitFor(() => { const s = localStorage.getItem('cqcpt.settings.v1'); return s && JSON.parse(s).ammoLine === false && s; }, null, 3000);
  await page.evaluate(() => window.__app.play.watch.select('ammo'));
  const ammoBack = await waitFor(() => { const s = localStorage.getItem('cqcpt.settings.v1'); return s && JSON.parse(s).ammoLine === true; }, null, 3000);
  ok('watch: a menu action (AMMO LINE) reaches the game and is saved outside the frame loop', ammo0 === true && !!ammoSaved && !!ammoBack, ammoSaved || 'not saved');
  const menuPause = await page.evaluate(() => { const k = window.__app.play; return { open: k.watch.menuOpen, paused: k.game.paused, latched: k.game.rules.pm.latched }; });
  ok('watch: the open menu pauses the round (manual pause)', menuPause.open && menuPause.paused && (menuPause.latched & 128) !== 0, JSON.stringify(menuPause));
  // GUN FIT: the page puts the Glock in the empty right hand (no squeeze needed), the gloves show, + pitch × 4 = +2°, SAVE
  await page.evaluate(() => window.__app.play.watch.select('fit'));
  const fitIn = await waitFor(() => { const k = window.__app.play, w = k.weapons; return w.held === w.glock && w.fitHolding === 'glock' && w.glock.carry.state === window.__CARRY_HAND
    && { page: k.watch.page, glove: w.glock.view.handR.visible, paused: k.game.paused }; }, null, 5000);
  ok('gun fit: the watch\'s GUN FIT page draws the Glock into the empty right hand (game still paused)', !!fitIn && fitIn.page === 1 && fitIn.paused, JSON.stringify(fitIn));
  ok('gloves: the right glove shows while the Glock is held', !!fitIn && fitIn.glove);
  const fit0 = await page.evaluate(() => window.__app.play.weapons.getFit('glock'));
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.__app.play.watch.select('pitch', 1));
  const fitLive = await page.evaluate(() => { const w = window.__app.play.weapons; return { fit: w.getFit('glock'), source: w.fitSource, quat: w.glock.view.fitQuat.toArray() }; });
  ok('gun fit: + nudges are applied live to the held gun (pitch +2°)', Math.abs(fitLive.fit.pitch - (fit0.pitch + 2)) < 1e-9 && fitLive.source === 'edit', JSON.stringify(fitLive));
  await page.evaluate(() => window.__app.play.watch.select('save'));
  const fitSaved = await waitFor(() => { const s = localStorage.getItem('cqcpt.gunfit.v1'); return s && JSON.parse(s).glock && JSON.parse(s).glock.pitch === 2 && s; }, null, 3000);
  const fitOut = await waitFor(() => { const k = window.__app.play, w = k.weapons; return w.fitHolding === null && w.held === null && k.watch.page === 0 && { saves: k.fitSaves.slice() }; }, null, 5000);
  ok('gun fit: SAVE writes the fit per weapon to localStorage (after the frame), logs it, and the Glock goes back to the holster', !!fitSaved && !!fitOut
    && fitOut.saves.some((f) => f.weapon === 'glock' && f.pitch === 2 && f.saved), `${fitSaved}; ${fitOut && JSON.stringify(fitOut.saves)}`);
  await page.evaluate(() => window.__app.play.watch.select('resume'));
  const resumed = await waitFor(() => { const k = window.__app.play; return !k.watch.menuOpen && !k.game.menuOpen; }, null, 3000);
  const causesW = await resumeIfPaused();
  ok('watch: RESUME closes the menu and the round resumes (3-2-1, no trigger pull needed)', !!resumed && !causesW.includes('still paused'), causesW.join(','));
  await waitFor(() => { const w = window.__app.play.weapons; return w.glock.carry.inSlot; }, null, 3000);
  const back = await page.evaluate(() => { const B = window.__app.play.weapons.body; return [0, 1, 2].map((i) => B.back.p[i] + B.backAxis[i] * 0.08); });
  for (let i = 0; i < 3; i++) { await page.evaluate((p) => window.__h.gripTo('right', p), back); await sleep(200); }
  await button('right', 'squeeze', 1);
  const akm = await waitFor(() => window.__app.play.weapons.held?.id === 'akm', null, 3000);
  ok('play: right grip over the right shoulder takes the AKM', !!akm, `back slot at (${back.map((v) => v.toFixed(2)).join(', ')})`);
  const akmGlove = await waitFor(() => { const w = window.__app.play.weapons; return w.akm.carry.state === window.__CARRY_HAND && w.akm.view.handR.visible && !w.glock.view.handR.visible; }, null, 4000);
  ok('gloves: the right glove shows on the AKM in the hand (and not on the holstered Glock)', !!akmGlove);
  await page.evaluate(() => window.__h.gripTo('right', [0.16, 1.4, -0.35]));
  await sleep(700);
  // the AKM is issued on semi (WeaponDefs); the stick click goes semi → safe → auto (held across a
  // few slow emulator frames, so each click is seen)
  const akmModes = [await page.evaluate(() => window.__app.play.weapons.akm.inst.mode)];
  const hudSemi = await waitFor(() => window.__app.play.watch._s[5] === 2, null, 4000);
  await press('right', 'thumbstick', 400);
  akmModes.push(await page.evaluate(() => window.__app.play.weapons.akm.inst.mode));
  const hudSafe = await waitFor(() => window.__app.play.watch._s[5] === 1, null, 4000);
  await press('right', 'thumbstick', 400);
  const mode = await page.evaluate(() => window.__app.play.weapons.akm.inst.mode);
  akmModes.push(mode);
  ok('play: right stick click cycles the AKM selector (semi → safe → auto)', akmModes.join() === 'semi,safe,auto', akmModes.join(' → '));
  const hudAuto = await waitFor(() => window.__app.play.watch._s[5] === 3, null, 4000);
  ok('play: the watch shows the AKM fire mode (SEMI, SAFE, AUTO)', !!hudSemi && !!hudSafe && !!hudAuto);
  await page.evaluate(() => window.__h.aimAt('right', [0.16, 1.3, -5]));
  await waitFor(() => { const w = window.__app.play.weapons; return w.akm.carry.state === window.__CARRY_HAND && w.akm.gate.open; }, null, 8000);
  const causes2 = await resumeIfPaused();
  if (causes2.length) report.pausesResumed = (report.pausesResumed || []).concat(causes2);
  const a0 = await page.evaluate(() => window.__app.play.weapons.stats.shots);
  await press('right', 'trigger', 700);
  const a1 = await page.evaluate(() => { const k = window.__app.play, w = k.weapons; return { shots: w.stats.shots, mag: w.akm.inst.magRounds,
    why: { paused: w.paused, game: k.game.phaseName, gamePaused: k.game.paused, carry: w.akm.carry.state, gate: w.akm.gate.open, mode: w.akm.inst.mode, held: w.held && w.held.id } }; });
  ok('play: AKM full auto fires a burst while the trigger is held', a1.shots - a0 >= 3, `${a1.shots - a0} rounds in 0.7 s; ${a1.mag} left${a1.shots - a0 >= 3 ? '' : `; ${JSON.stringify(a1.why)}`}`);

  // A 4-enemy scene in view: draw calls (both eyes, IWER renders two passes like the Quest)
  await page.evaluate(() => {
    const k = window.__app.play;
    k.enemies.reset();
    for (const [x, z] of [[-1.2, -2.6], [-0.4, -3.1], [0.4, -3.1], [1.2, -2.6]]) k.enemies.spawn(x, z, Math.atan2(-x, -z));
    const r = window.__app.gfx.renderer, orig = r.render.bind(r);
    window.__calls = [];
    r.render = function (s, c) { orig(s, c); if (window.__calls.length < 400) window.__calls.push(r.info.render.calls); };
    window.__restoreRender = () => { r.render = orig; };
  });
  await sleep(2500);
  const dc = await page.evaluate(() => {
    const a = window.__app, k = a.play, c = window.__calls.slice(-30);
    window.__restoreRender();
    return { max: Math.max(...c), avg: c.reduce((s, v) => s + v, 0) / c.length, alive: k.enemies.alive(), shown: k.enemies.pool.rigs.filter((r) => r.root.visible).length,
      tris: a.gfx.renderer.info.render.triangles };
  });
  ok('play: draw calls ≤ 60 with 4 enemies (both eyes)', dc.alive >= 4 && dc.max <= 60, `max ${dc.max}, avg ${dc.avg.toFixed(1)} per frame (${(dc.max / 2).toFixed(0)} per eye); ${dc.alive} alive, ${dc.shown} rigs shown`);
  report.drawCalls = { maxBothEyes: dc.max, avgBothEyes: +dc.avg.toFixed(1), perEyeMax: dc.max / 2, enemies: dc.alive };

  // A kill with the round flying into the north wall (z = −3): he falls toward open floor, a puff shows (gap audit F4, F5)
  const fall = await page.evaluate(() => {
    const k = window.__app.play, E = k.enemies;
    let bi = -1, bd = Infinity;
    for (const a of E.brain.agents) if (a.active && a.alive && Math.abs(a.x - 0.4) < bd) { bd = Math.abs(a.x - 0.4); bi = a.i; }
    if (bi < 0) return null;
    const a = E.brain.agents[bi], p0 = E.stats.puffs;
    E.applyHit(bi, 'head', 400, 0, -0.05, -1);
    const F = Array.from(E._fall);
    return { i: bi, x: a.x, z: a.z, dead: !a.alive, fx: F[0], fz: F[1], score: F[2], puffs: E.stats.puffs - p0, puffShown: E.puff.live > 0 };
  });
  const causes3 = await resumeIfPaused(); // (a paused round freezes the enemies, falls included)
  if (causes3.length) report.pausesResumed = (report.pausesResumed || []).concat(causes3);
  const landed = fall && await waitFor((i) => window.__app.play.enemies.anims[i].landed, fall.i, 10000);
  const fell = fall && await page.evaluate((i) => { const k = window.__app.play, an = k.enemies.anims[i]; return { landed: an.landed, deathT: +an.deathT.toFixed(2), paused: k.game.paused }; }, fall.i);
  ok('play: a body falls toward open floor, not into the wall behind it', !!fall && fall.dead && fall.fz > -0.5 && fall.score >= 8 && !!landed,
    fall && `at (${fall.x.toFixed(2)}, ${fall.z.toFixed(2)}), falls along (${fall.fx.toFixed(2)}, ${fall.fz.toFixed(2)}), score ${fall.score}; ${JSON.stringify(fell)}`);
  ok('play: the killing hit showed a puff', !!fall && fall.puffs === 1 && fall.puffShown);

  // ---- Roam: running is a watch warning, not a pause. The head is moved at 1.5 m/s (by the loop's dt) along an open line.
  const runLine = await page.evaluate(() => {
    const k = window.__app.play, W = k.world, h = k.player.head;
    for (const L of [2.4, 1.8]) for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      let ok = true;
      for (let s = 0; s <= L + 0.4 && ok; s += 0.1) { const x = h.x + dx * s, z = h.z + dz * s; ok = W.nav.clearance(x, z) >= 0.55 && W.edgeMargin(x, z) >= 0.6; }
      if (ok) return { x: h.x, z: h.z, dx, dz, L };
    }
    return null;
  });
  if (runLine) {
    await page.evaluate((R) => {
      const a = window.__app, k = a.play, sys = a.loop.systems.find((x) => x.name === 'world'), orig = sys.update, dev = window.__iwer;
      const M = window.__run = { s: 0, maxCue: 0, maxSpeed: 0, runPaused: false, pausedAny: false, done: false, warn: 0 };
      sys.update = (dt, t, f, c) => {
        if (!M.done) {
          M.s = Math.min(R.L, M.s + 1.5 * dt);
          dev.position.set(R.x + R.dx * M.s, 1.6, R.z + R.dz * M.s);
          if (M.s >= R.L) M.done = true;
        }
        const g = k.game;
        M.maxCue = Math.max(M.maxCue, g.cue[0]);
        M.maxSpeed = Math.max(M.maxSpeed, k.player.speed);
        M.warn = Math.max(M.warn, k.watch.warns.levels[0]);
        if (g.paused) { M.pausedAny = true; if (g.rules.reasons & (1 << 6)) M.runPaused = true; }
        orig(dt, t, f, c);
      };
      window.__restoreWorld = () => { sys.update = orig; };
    }, runLine);
    await waitFor(() => window.__run.done, null, 15000);
    await sleep(600);
    const run = await page.evaluate(() => { window.__restoreWorld(); return { ...window.__run }; });
    ok('roam: walking fast (1.5 m/s) raises the watch\'s run cue and never pauses for running', run.maxSpeed > 1.0 && run.maxCue > 0 && run.warn > 0 && !run.runPaused,
      `peak speed ${run.maxSpeed.toFixed(2)} m/s, cue ${run.maxCue.toFixed(2)}, watch level ${run.warn.toFixed(2)}, ${run.s.toFixed(1)} m${run.pausedAny ? ' (another pause came up)' : ''}`);
    await page.evaluate((R) => window.__iwer.position.set(R.x, 1.6, R.z), runLine);
    await sleep(800);
    const c4 = await resumeIfPaused();
    if (c4.length) report.pausesResumed = (report.pausesResumed || []).concat(c4);
  } else ok('roam: walking fast (1.5 m/s) raises the watch\'s run cue and never pauses for running', false, 'no open 1.8 m line from the head');

  // ---- Roam: a reference-space reset with a transform during the round: hold, enemies back in the queue, the world moved and
  // rebuilt behind the pause, one warm draw, the hold released; then the inverse reset puts it back
  const rs0 = await page.evaluate(() => { const k = window.__app.play, r = window.__app.gfx.renderer; return { realigns: k.world.stats.realigns, programs: r.info.programs.length, alive: k.enemies.alive() }; });
  const T = await page.evaluate(() => {
    const THREE = window.__h.THREE, m = new THREE.Matrix4().compose(new THREE.Vector3(0.4, 0, -0.3), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.1), new THREE.Vector3(1, 1, 1));
    window.__T = m;
    window.__app.refReset({ transform: { matrix: m.toArray() } });
    const k = window.__app.play;
    return { step: k.stepName, paused: k.game.paused, held: (k.game.rules.pm.held & 256) !== 0, alive: k.enemies.alive() };
  });
  const realigned = await waitFor(() => { const k = window.__app.play; return k.stepName === 'play' && k.realigns.length >= 1 && { ...k.realigns[0], realignsWorld: k.world.stats.realigns }; }, null, 10000);
  const rs1 = await page.evaluate(() => { const k = window.__app.play, r = window.__app.gfx.renderer; return { programs: r.info.programs.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries,
    errors: window.__app.rec.errors.slice(0, 3), paused: k.game.paused }; });
  ok('roam: a reset with a transform pauses and holds, puts the enemies back in the queue, realigns the world behind the pause (nothing compiled)',
    T.step === 'realign' && T.paused && T.held && T.alive === 0 && !!realigned && realigned.cause === 'reset' && realigned.transform && realigned.realignsWorld === rs0.realigns + 1
    && rs1.programs === rs0.programs && rs1.errors.length === 0, `${JSON.stringify(T)}; ${JSON.stringify(realigned)}; programs ${rs1.programs} (before ${rs0.programs}); ${rs1.errors.join(' | ')}`);
  await page.evaluate(() => window.__app.refReset({ transform: { matrix: window.__T.clone().invert().toArray() } }));
  await waitFor(() => { const k = window.__app.play; return k.stepName === 'play' && k.realigns.length >= 2; }, null, 10000);
  const c5 = await resumeIfPaused();
  if (c5.length) report.pausesResumed = (report.pausesResumed || []).concat(c5);
  const back2 = await page.evaluate(() => ({ phase: window.__app.play.game.phaseName, paused: window.__app.play.game.paused }));
  ok('roam: after the realign the round resumes (trigger pull, 3-2-1)', !back2.paused && ['wave', 'break', 'ready'].includes(back2.phase), JSON.stringify(back2));

  // No program, texture or geometry created after the warm-up
  const st2 = await page.evaluate(async () => { const m = await import('/src/core/Warmup.js'); const r = window.__app.gfx.renderer; return { ...m.assertStable(r, () => {}), programs: r.info.programs.length, tex: r.info.memory.textures, geo: r.info.memory.geometries, growth: window.__app.rec.warmGrowth || null }; });
  ok('play: renderer.info.programs flat through the whole round', st2.checked && st2.ok && st2.programs === before.programs && st2.tex === before.textures && st2.geo === before.geometries && !st2.growth,
    `${st2.programs} programs, ${st2.tex} textures, ${st2.geo} geometries (before play ${before.programs}/${before.textures}/${before.geometries})`);

  // CPU time per frame (PerfMonitor: the frame callback, per system) and the wrist HUD
  const perf = await page.evaluate(() => { const a = window.__app; return { recent: a.perf.recent(120), sys: a.perf.systemAverages(120), shown: a.play.watch.shown, hudDraws: a.play.watch.draws, menuDraws: a.play.watch.menuDraws, loopErrors: a.loop.errors, errors: a.rec.errors.slice(0, 5) }; });
  ok('play: no errors in the frame loop', perf.loopErrors === 0 && perf.errors.length === 0, perf.errors.join(' | '));
  ok('play: the watch follows the left controller and redraws on change', perf.shown && perf.hudDraws > 0 && perf.menuDraws > 0, `${perf.hudDraws} dial redraws, ${perf.menuDraws} menu redraws`);
  report.cpu = { framesSampled: perf.recent.frames, cpuAvgMs: perf.recent.cpuAvg, intervalAvgMs: perf.recent.intervalAvg, fps: perf.recent.fps, perSystemAvgMs: perf.sys };

  // Exit: hold Y for 2 s (the game ends the session from a timeout, never inside the frame callback)
  await page.evaluate(() => { window.__iwer.controllers.right.updateButtonValue('squeeze', 0); window.__iwer.controllers.right.updateButtonValue('trigger', 0); });
  await button('left', 'y-button', 1);
  const exited = await waitState('menu', 20000); // 2 s of game time: dt is clamped to 0.1 s per (slow) emulator frame
  await button('left', 'y-button', 0);
  ok('play: holding Y exits', exited);
  const d2 = await page.evaluate(() => JSON.parse(window.__app.diag.json()));
  const pl = d2.sessions.at(-1);
  ok('play: session saved with the snapshot and the round summary', pl && pl.mode === 'play' && pl.spaceSnapshot && pl.spaceSnapshot.planes.length === 19 && pl.play && pl.play.weapons && pl.play.enemies && pl.systemsMs,
    pl && pl.play && `wave ${pl.play.wave}, ${pl.play.kills} kills, phase ${pl.play.phase}; ${JSON.stringify(pl.play.weapons)}`);
  ok('play: no XR-frame errors at exit', !consoleErrors.some((e) => /outside the callback/i.test(e)));
  ok('play: record has the safety report (Roam start), audio states, rate and near plane',
    pl && pl.play.safety && pl.play.safety.mode === 'roam' && pl.play.safety.spot && pl.play.safety.spot.mode === 'roam'
      && pl.audio && pl.audio.at1s && pl.probes.frameRate.request === 'ok' && 'hzAtEnd' in pl.probes.frameRate && pl.view.near === 0.02 && pl.play.world.report && pl.play.world.report.spawn,
    pl && pl.play.safety && `start ${JSON.stringify(pl.play.safety.spot)}; pauses ${JSON.stringify(pl.play.safety.pauses)}; audio ${pl.audio.atStart}→${pl.audio.at1s}→${pl.audio.atEnd}; ${pl.probes.frameRate.hzAtEnd} Hz at end`);
  const R = pl && pl.play;
  ok('play: record has the grip fit (v2: the saved nudge, the learned grip→ray relation), the fit saves, the watch and its actions',
    R && R.grip && R.grip.fitVersion === 2 && R.grip.glock.pitch === 2 && R.grip.rayRel && R.grip.rayRel.right && R.fitSaves.some((f) => f.weapon === 'glock' && f.pitch === 2 && f.saved)
      && R.watch && R.watch.opens >= 1 && R.watch.wakes >= 1 && R.watch.actions.fitSave >= 1 && R.watch.actions.ammoLine === 2 && R.watch.actions.restart === 1 && R.hudDraws > 0,
    R && `grip ${JSON.stringify({ source: R.grip.source, glock: R.grip.glock.pitch, rayRel: R.grip.rayRel.right })}; watch ${JSON.stringify(R.watch)}`);
  ok('play: record has the Roam report (speeds, cues, rooms), the resets and realigns, the drift watch, the lighting',
    R && R.roam && R.roam.mode === 'roam' && R.roam.resets.length === 2 && R.roam.realigns.length === 2 && R.roam.drift && R.roam.world && R.roam.world.rooms >= 2
      && R.lighting && R.lighting.envMap && R.settings && R.settings.gloves === true && (report.space === 'unbounded' ? R.roam.spaceNote === null : /Whole-house tracking unavailable/.test(R.roam.spaceNote || '')),
    R && R.roam && `${JSON.stringify({ space: R.roam.space, note: R.roam.spaceNote, realigns: R.roam.realigns, drift: R.roam.drift, lighting: R.lighting })}`);

  // ---- A reload (same browser profile): the saved gun fit and settings come back at load, before the warm-up
  const re = await mainContext.newPage();
  await re.goto(`http://localhost:${port}/?emulate`);
  await re.waitForFunction(() => ['ready', 'failed'].includes(window.__app?.preload?.state), null, { timeout: 120000 });
  const reFit = await re.evaluate(() => { const k = window.__app.play; return { fit: k.weapons.getFit('glock'), akm: k.weapons.getFit('akm'), source: k.gripReport.source, watchFit: Array.from(k.watch.fitEdit.cur[0]),
    settings: k.settings, diff: k.enemies.diff.name }; });
  ok('gun fit: after a reload the saved Glock fit is applied (source "saved") and the watch\'s fit page starts from it', reFit.fit.pitch === 2 && reFit.akm.pitch === 0 && reFit.source === 'saved'
    && reFit.watchFit[0] === 2 && reFit.settings.ammoLine === true && reFit.diff === 'test', JSON.stringify(reFit));
  await re.close();

  // Diagnostics: Copy takes only the last session (Download / Share keep everything), sizes shown
  const cp = await page.evaluate(() => {
    const d = window.__app.diag, c = JSON.parse(d.lastJson());
    return { sessions: c.sessions.length, kept: c.sessionsKept, keys: Object.keys(c), last: c.sessions[0] && c.sessions[0].mode, copyLen: d.lastJson().length, allLen: d.json().length,
      allSessions: JSON.parse(d.json()).sessions.length, size: document.getElementById('diagSize').textContent };
  });
  ok('diagnostics: Copy exports only the last session (+ app, version, ua, support, preload, pageErrors)', cp.sessions === 1 && cp.last === 'play' && cp.kept === cp.allSessions && cp.kept >= 2
    && ['app', 'version', 'ua', 'support', 'preload', 'pageErrors'].every((k) => cp.keys.includes(k)) && cp.copyLen < cp.allLen,
    `copy ${(cp.copyLen / 1024).toFixed(0)} KB, all ${(cp.allLen / 1024).toFixed(0)} KB (${cp.allSessions} sessions)`);
  ok('diagnostics: export sizes shown on the page', /^Copy: the last session \(\d+ KB\)\. Download \/ Share: all \d+ kept sessions \(\d+ KB\)\.$/.test(cp.size), cp.size);
  await page.click('#bCopy');
  const copyMsg = await waitFor(() => { const t = document.getElementById('msg').textContent; return /\d+ KB/.test(t) && t; }, null, 4000);
  ok('diagnostics: Copy says what it copied and its size', !!copyMsg && /last session/.test(copyMsg), copyMsg);

  // ---- VR test scene
  await page.click('#bVR');
  ok('vr: entered xr', await waitState('xr'));
  await sleep(1000);
  ok('vr: grid visible', await page.evaluate(() => window.__app.cube.grid.visible));
  await page.evaluate(() => window.__app.session.end());
  ok('vr: ended', await waitState('menu'));

  // ---- Rejected request offers the reduced retry (fresh tap); reduced runs the game too (Roam rules on local-floor)
  await page.evaluate(() => {
    const orig = navigator.xr.requestSession.bind(navigator.xr);
    let once = true;
    navigator.xr.requestSession = (m, init) => { if (once) { once = false; return Promise.reject(Object.assign(new Error('test rejection'), { name: 'NotSupportedError' })); } return orig(m, init); };
  });
  await page.click('#bPlay');
  await sleep(500);
  ok('reject: back to menu with retry button', (await state()) === 'menu' && !(await page.evaluate(() => document.getElementById('bRetry').hidden)));
  await page.click('#bRetry');
  ok('reduced: entered xr', await waitState('xr'));
  const red = await page.evaluate(() => window.__app.rec.requested);
  ok('reduced: only local-floor requested', JSON.stringify(red) === '["local-floor"]', JSON.stringify(red));
  const redCard = await skipCard();
  const redPlay = await waitFor(() => { const k = window.__app.play; return k.stepName === 'play' && { roam: k.game.roam, note: k.spaceNote, page: document.getElementById('msg').textContent }; }, null, 10000);
  ok('reduced: the game runs with the Roam rules; the page (never the headset) says the Quest boundary applies', redCard && !!redPlay && redPlay.roam
    && /Whole-house tracking unavailable.*boundary applies/.test(redPlay.note || '') && /boundary applies/.test(redPlay.page), redPlay && `${redPlay.note} | page: ${redPlay.page}`);
  await page.evaluate(() => window.__app.session.end());
  await waitState('menu');
  await page.evaluate(() => window.__iwer.position.set(0, 1.6, 0));

  // ---- Enter MR: one spot (the stationary v0.2 mode): local-floor, the safe-spot step; a spot 0.5 m away rebuilds the world
  const spBefore = await page.evaluate(() => { const r = window.__app.gfx.renderer; return { programs: r.info.programs.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries }; });
  await page.click('#bSpot');
  ok('spot: entered xr', await waitState('xr'));
  const spReq = await page.evaluate(() => ({ req: window.__app.rec.requested, mode: window.__app.rec.mode, roam: window.__app.play.game.roam, worldRoam: null }));
  ok('spot: local-floor, no unbounded request, spot rules', !spReq.req.includes('unbounded') && spReq.req.includes('local-floor') && spReq.mode === 'spot' && spReq.roam === false, JSON.stringify(spReq));
  const spCard = await skipCard();
  const spSpot = await waitFor(() => {
    const a = window.__app, k = a.play, g = k.game;
    return k.stepName === 'spot' && g.panel.mesh.visible && { status: g.spotStatus, spotting: g.spotting, appPanel: a.panel.mesh.visible, lines: k.panelLines(), ring: g.ring.visible,
      msg: g.panel.lines.slice(), skipped: a.rec.play.cardSkipped, worldRoam: k.world.roamOn };
  }, null, 10000);
  ok('spot: a trigger pull moves on to the safe spot: App panel hidden, ring and spot message shown (world built in spot mode)', spCard && spSpot && spSpot.spotting && !spSpot.appPanel
    && spSpot.lines === null && spSpot.ring && spSpot.skipped && spSpot.worldRoam === false, spSpot && `${spSpot.status}; "${spSpot.msg.join(' / ')}"`);
  const tgt = await page.evaluate(async () => {
    const { SafeSpot } = await import('/src/safety/SafeSpot.js');
    const k = window.__app.play, h = k.player.head, S = new SafeSpot();
    let tight = null;
    for (const d of [0.5, 0.7, 0.9, 1.2, 1.6, 2.0]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
        const st = S.evaluate(k.world, x, z, k.game.spot.r);
        if (st === 1 || st === 5) return { x, z, st, d, from: [h.x, h.z] };
        if (st === 2 && !tight) tight = { x, z, st, d, from: [h.x, h.z] };
      }
    }
    return tight; // a "tight" spot is confirmed by holding the trigger
  });
  if (tgt) {
    await page.evaluate(() => {
      const a = window.__app, k = a.play, orig = k.rebuildForSpot.bind(k);
      k.rebuildForSpot = (t) => { window.__rb = { panel: a.panel.mesh.visible, first: a.panel.lines[0] }; orig(t); };
    });
    await page.evaluate(([x, z]) => window.__iwer.position.set(x, 1.6, z), [tgt.x, tgt.z]);
    await sleep(1000);
  }
  const spSeen = await confirmSpot();
  report.spot = spSeen;
  const spPlay = await waitFor(() => window.__app.play.stepName === 'play', null, 10000);
  const rb = await page.evaluate(() => {
    const a = window.__app, k = a.play, r = a.gfx.renderer, W = a.rec.play.world, g = k.game;
    return { rebuild: W.rebuild || null, spot: a.rec.play.spot, zone: { ...k.world.zone }, gameZone: { ...g.zone }, hook: window.__rb || null, phase: g.phaseName, msg: g.panel.mesh.visible ? g.panel.lines.slice() : null,
      programs: r.info.programs.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries, errors: a.rec.errors.slice(0, 3), appPanel: a.panel.mesh.visible };
  });
  ok('spot: the trigger in a good spot starts the round there ("Get ready", zone at the spot)', !!spPlay && rb.phase === 'ready' && rb.msg && rb.msg[0] === 'Get ready' && !rb.appPanel
    && rb.spot && rb.spot.mode === 'spot' && rb.gameZone.r > 0, `${rb.phase}; ${rb.msg && rb.msg.join(' / ')}; spot ${spSeen.join('→')}; ${JSON.stringify(rb.spot)}`);
  ok('spot: a spot 0.5 m away rebuilds the world there, behind the Get ready panel', !!tgt && rb.rebuild && rb.rebuild.movedM > 0.25 && rb.spot.rebuilt
    && Math.hypot(rb.zone.x - tgt.x, rb.zone.z - tgt.z) < 0.15 && Math.hypot(rb.gameZone.x - rb.zone.x, rb.gameZone.z - rb.zone.z) < 1e-6 && rb.hook && rb.hook.panel && rb.hook.first === 'Get ready',
    tgt ? `moved ${rb.rebuild && rb.rebuild.movedM} m (status ${tgt.st}); rebuild ${rb.rebuild && rb.rebuild.buildMs} ms; zone (${rb.zone.x.toFixed(2)}, ${rb.zone.z.toFixed(2)})` : 'no clear spot found');
  ok('spot: nothing compiled or created by the rebuild', rb.programs === spBefore.programs && rb.textures === spBefore.textures && rb.geometries === spBefore.geometries && rb.errors.length === 0,
    `${rb.programs}/${rb.textures}/${rb.geometries} (before ${spBefore.programs}/${spBefore.textures}/${spBefore.geometries}) ${rb.errors.join(' | ')}`);
  // the watch's MODE row: whole house now (the world is rebuilt in Roam behind the card, the round starts over)
  await page.evaluate(() => window.__app.play.watch.select('mode'));
  const toRoam = await waitFor(() => { const k = window.__app.play; return k.stepName === 'start' && k.game.roam && k.world.roamOn && !k.watch.menuOpen && { switches: k.modeSwitches.slice(), rooms: k.world.stats.rooms }; }, null, 8000);
  ok('spot: the watch\'s MODE row switches to the whole house (world rebuilt in Roam, back to the card)', !!toRoam && toRoam.switches.length === 1 && toRoam.switches[0].to === 'roam' && toRoam.rooms >= 2,
    JSON.stringify(toRoam));
  await page.evaluate(() => window.__app.session.end());
  await waitState('menu');
  await page.evaluate(() => window.__iwer.position.set(0, 1.6, 0));

  // ---- No Space Setup data (a virtual room, where every spot is "unmapped"), one-spot mode: the trigger pull that
  // dismisses the card must not also confirm the spot (the card's step runs before game.preUpdate in
  // the same frame, so it moves on at the release); a second pull then starts the round there.
  await page.evaluate(() => { const k = window.__app.play; window.__fixture0 = k.fixture; k.fixture = { version: 1, space: 'local-floor', planes: [], meshes: [] }; });
  await page.click('#bSpot');
  const vIn = await waitState('xr');
  const vCard = vIn && await skipCard();
  await sleep(700);
  const vSpot = await page.evaluate(() => { const k = window.__app.play; return { step: k.stepName, spotting: k.game.spotting, status: k.game.spotStatus, virtual: k.world.virtual, spot: window.__app.rec.play.spot || null }; });
  ok('virtual room: the card\'s trigger pull leads to the spot step, it does not confirm the spot too', vCard && vSpot.virtual && vSpot.step === 'spot' && vSpot.spotting && vSpot.status === 'unmapped' && !vSpot.spot,
    JSON.stringify(vSpot));
  await press('left', 'trigger', 150);
  const vPlay = await waitFor(() => { const a = window.__app, k = a.play; return k.stepName === 'play' && { spot: a.rec.play.spot, phase: k.game.phaseName }; }, null, 8000);
  ok('virtual room: a second trigger pull confirms the unmapped spot and starts the round', !!vPlay && vPlay.spot && vPlay.spot.rebuilt === false && ['ready', 'wave'].includes(vPlay.phase),
    vPlay && JSON.stringify(vPlay));
  await page.evaluate(() => { window.__app.play.fixture = window.__fixture0; window.__app.session.end(); });
  await waitState('menu');

  const errs = consoleErrors.filter((e) => !/test rejection/.test(e));
  ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' || '));

  // ---- Grip fit escape hatch (fresh page): ?gripPitch=10&gripY=0.01&gripZ=-0.02 on both guns, as a gun fit (never saved)
  const gp = await browser.newPage();
  await gp.goto(`http://localhost:${port}/?emulate&gripPitch=10&gripY=0.01&gripZ=-0.02`);
  await gp.waitForFunction(() => ['ready', 'failed'].includes(window.__app?.preload?.state), null, { timeout: 120000 });
  const gf = await gp.evaluate(async () => {
    const THREE = await import('three');
    const { computeFit } = await import('/src/weapons/GunFit.js');
    const k = window.__app.play, out = {};
    for (const id of ['glock', 'akm']) {
      const p7 = new Float64Array(7), p3 = new Float64Array(3);
      computeFit(id, null, p7, p3);
      const q0 = new THREE.Quaternion(p7[3], p7[4], p7[5], p7[6]), q = k.weapons[id].view.fitQuat;
      // bore (−Z) pitch in grip space, default vs URL fit
      const b0 = new THREE.Vector3(0, 0, -1).applyQuaternion(q0), b1 = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      out[id] = { fit: k.weapons.getFit(id), dDeg: (b0.angleTo(b1) * 180) / Math.PI };
    }
    return { rep: k.gripReport, out, stored: localStorage.getItem('cqcpt.gunfit.v1') };
  });
  ok('grip fit: URL values applied to both guns as a gun fit (pitch 10°, up 0.01 m, forward 0.02 m) and reported, never saved', gf.rep.source === 'url'
    && ['glock', 'akm'].every((id) => gf.out[id].fit.pitch === 10 && Math.abs(gf.out[id].fit.up - 0.01) < 1e-9 && Math.abs(gf.out[id].fit.fwd - 0.02) < 1e-9) && gf.stored === null,
    JSON.stringify(gf.out));
  ok('grip fit: the gun is tilted 10° in the hand', ['glock', 'akm'].every((id) => Math.abs(gf.out[id].dDeg - 10) < 0.05), ['glock', 'akm'].map((id) => `${id} ${gf.out[id].dDeg.toFixed(2)}°`).join(', '));
  await gp.close();

  // ---- A failed load says why and keeps the probe sessions usable (fresh page, one model missing)
  const bad = await browser.newPage();
  await bad.route('**/assets/models/akm.glb', (r) => r.fulfill({ status: 404, body: 'not found' }));
  await bad.goto(`http://localhost:${port}/?emulate`);
  await bad.waitForFunction(() => ['ready', 'failed'].includes(window.__app?.preload?.state), null, { timeout: 60000 });
  const fail = await bad.evaluate(() => ({ state: window.__app.preload.state, text: document.getElementById('loadText').textContent,
    play: document.getElementById('bPlay').disabled, probe: document.getElementById('bProbe').disabled, assets: window.__app.preload.assets }));
  ok('preload failure: error shown, Enter MR off, Probe usable', fail.state === 'failed' && /failed/i.test(fail.text) && /akm/.test(fail.text) && fail.play && !fail.probe && fail.assets === null, fail.text);
  await bad.click('#bProbe');
  ok('preload failure: probe still enters XR', await bad.waitForFunction(() => window.__app.game.state === 'xr', null, { timeout: 8000 }).then(() => true, () => false));
  await bad.evaluate(() => window.__app.session && window.__app.session.end());
  await bad.close();
} catch (e) {
  ok('test script crashed', false, e.stack);
} finally {
  await browser.close();
  server.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  — ${c.info}` : ''}`);
}
console.log('\nPlay session numbers (desktop Chromium + SwiftShader + IWER; not the headset):');
console.log(JSON.stringify(report, null, 1));
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
