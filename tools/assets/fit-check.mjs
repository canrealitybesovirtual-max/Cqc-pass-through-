// Headless render check of the v0.3 gun fit, gloves, holster and sling (dev only).
// Serves the repo root plus the Touch Plus profile meshes from the npm package
// @webxr-input-profiles/assets (dist/profiles) under /ext/, loads fit-check.html in
// Chromium (Playwright, installed globally) and saves one PNG per view.
//   NODE_PATH=$(npm root -g) node tools/assets/fit-check.mjs <outDir> <profilesDir>
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = normalize(join(fileURLToPath(import.meta.url), '../../..'));
const outDir = process.argv[2] || 'fit-check';
const ext = process.argv[3];
if (!ext) { console.error('usage: fit-check.mjs <outDir> <profilesDir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    const base = p.startsWith('/ext/') ? normalize(ext) : root;
    const file = normalize(join(base, p.startsWith('/ext/') ? p.slice(5) : p));
    if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let code = 0;
try {
  await page.goto(`http://localhost:${port}/tools/assets/fit-check.html`);
  await page.waitForFunction(() => window.__ready || window.__failed, null, { timeout: 180000 });
  const failed = await page.evaluate(() => window.__failed);
  if (failed) throw new Error(failed);
  const views = await page.evaluate(() => window.__views);
  const out = {};
  for (const v of views) {
    out[v] = await page.evaluate((n) => window.renderView(n), v);
    writeFileSync(join(outDir, `${v}.png`), await page.locator('canvas').screenshot());
  }
  console.log(JSON.stringify({ views: out, errors }, null, 1));
  if (errors.length) code = 1;
} catch (e) {
  console.error(e, errors);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
