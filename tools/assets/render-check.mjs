// Headless render check of the baked assets: loads tools/assets/check.html in
// Chromium (Playwright, installed globally), renders every check view and
// saves a PNG per view, then prints the loader report.
//   NODE_PATH=$(npm root -g) node tools/assets/render-check.mjs <outDir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const outDir = process.argv[2] || 'assets-check';
mkdirSync(outDir, { recursive: true });
const VIEWS = [
  ...['glock', 'akm'].flatMap((w) => ['right', 'left', 'front34', 'rear34', 'top', 'below', 'albedo', 'parts', 'open', 'markers', 'muzzle', 'sights'].map((v) => `${w}-${v}`)),
  'soldier-front', 'soldier-side', 'soldier-back', 'soldier-hand',
];

const server = await serve(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let code = 0;
try {
  await page.goto(`http://localhost:${port}/tools/assets/check.html`);
  await page.waitForFunction(() => window.__ready || window.__failed, null, { timeout: 120000 });
  const report = await page.evaluate(() => window.__report);
  const progress = await page.evaluate(() => window.__progress);
  const views = {};
  for (const v of VIEWS) {
    views[v] = await page.evaluate((name) => window.renderView(name), v);
    const png = await page.locator('canvas').screenshot();
    writeFileSync(join(outDir, `${v}.png`), png);
  }
  const monotonic = progress.every((p, i) => i === 0 || p[0] >= progress[i - 1][0]);
  console.log(JSON.stringify({ report, views, progress: { steps: progress.length, last: progress[progress.length - 1], monotonic }, errors }, null, 1));
  if (errors.some((e) => !e.startsWith('warning'))) code = 1;
} catch (e) {
  console.error(e, errors);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
