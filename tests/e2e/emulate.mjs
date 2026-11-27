// End-to-end check in desktop Chromium with Meta's IWER emulator (Quest 3 profile).
// Needs Playwright installed globally (not a project dependency):  node tests/e2e/emulate.mjs
// Exit code 0 = all checks passed.
import { createRequire } from 'node:module';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const checks = [];
const ok = (name, cond, info = '') => { checks.push({ name, pass: !!cond, info }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const state = () => page.evaluate(() => window.__app?.game.state);
const waitState = async (s, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await state()) === s) return true; await sleep(100); } return false; };
const press = async (hand, id, holdMs = 150) => {
  await page.evaluate(([h, b]) => window.__iwer.controllers[h].updateButtonValue(b, 1), [hand, id]);
  await sleep(holdMs);
  await page.evaluate(([h, b]) => window.__iwer.controllers[h].updateButtonValue(b, 0), [hand, id]);
  await sleep(150);
};

try {
  // Without WebXR: clear message, no errors
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('support').textContent !== 'Checking WebXR…');
  const noXr = await page.textContent('#support');
  ok('no-WebXR message', /not available|not supported/i.test(noXr), noXr);
  ok('no-WebXR: buttons disabled', await page.evaluate(() => document.getElementById('bPlay').disabled));

  // With the emulator
  await page.goto(`http://localhost:${port}/?emulate`);
  await page.waitForFunction(() => window.__app?.game.state === 'menu', null, { timeout: 15000 });
  ok('emulator: AR supported', (await page.textContent('#support')) === 'Mixed reality is supported.', await page.textContent('#support'));

  // ---- Probe session
  await page.click('#bProbe');
  ok('probe: entered xr', await waitState('xr'));
  await sleep(4000);
  const p1 = await page.evaluate(() => {
    const a = window.__app;
    return { frames: a.loop.frames, lines: a.probes.lines(), rec: a.rec, uploads: a.panel.uploads, calls: a.gfx.renderer.info.render.calls,
      programs: a.gfx.renderer.info.programs.length, cube: a.cube.mesh.visible, panel: a.panel.mesh.visible };
  });
  ok('probe: frames running', p1.frames > 60, `${p1.frames} frames`);
  ok('probe: capability log', Array.isArray(p1.rec.granted.enabledFeatures) && p1.rec.granted.enabledFeatures.length > 0, p1.rec.granted.enabledFeatures.join(','));
  ok('probe: space chosen', ['unbounded', 'local-floor'].includes(p1.rec.granted.referenceSpace), p1.rec.granted.referenceSpace);
  ok('probe: layer logged', !!p1.rec.layer.type, JSON.stringify(p1.rec.layer));
  ok('probe: gl extensions logged', p1.rec.gl.extensions && 'OVR_multiview2' in p1.rec.gl.extensions);
  ok('probe: anchor probe finished', p1.rec.probes.anchor.state !== 'pending', p1.rec.probes.anchor.state);
  ok('probe: cube and panel visible', p1.cube && p1.panel);
  ok('probe: panel uploads limited', p1.uploads <= 8, `${p1.uploads} uploads in ~4 s`);
  ok('probe: HUD lines', p1.lines.length >= 8, p1.lines.join(' | '));

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
  ok('probe: incomplete 60 s run recorded', last.perfRuns.some((r) => r.incomplete || /cancelled/.test(r.label)), JSON.stringify(last.perfRuns.map((r) => r.label)));
  ok('probe: hitch log exported', last.hitches && typeof last.hitches.total === 'number', last.hitches && `${last.hitches.total} hitches`);
  ok('diagnostics persisted', await page.evaluate(() => !!localStorage.getItem('cqcpt.diag.v1')));
  ok('summary shown', /probe/.test(await page.textContent('#summary')));

  // ---- Play session, then VR test scene
  await page.click('#bPlay');
  ok('play: entered xr', await waitState('xr'));
  await sleep(1500);
  const play = await page.evaluate(() => ({ space: window.__app.rec.granted.referenceSpace, req: window.__app.rec.requested }));
  ok('play: local-floor and no unbounded request', play.space === 'local-floor' && !play.req.includes('unbounded'), JSON.stringify(play));
  await page.evaluate(() => window.__app.session.end());
  ok('play: ended', await waitState('menu'));

  await page.click('#bVR');
  ok('vr: entered xr', await waitState('xr'));
  await sleep(1000);
  ok('vr: grid visible', await page.evaluate(() => window.__app.cube.grid.visible));
  await page.evaluate(() => window.__app.session.end());
  ok('vr: ended', await waitState('menu'));

  // ---- Rejected request offers the reduced retry (fresh tap)
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
  await page.evaluate(() => window.__app.session.end());
  await waitState('menu');

  const errs = consoleErrors.filter((e) => !/test rejection/.test(e));
  ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' || '));
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
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
