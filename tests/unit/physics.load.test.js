/**
 * The vendored Rapier (vendor/rapier): exactly @dimforge/rapier3d-compat 0.20.0
 * (sha256 of rapier.mjs as published, the npm integrity recorded), its
 * Apache-2.0 licence, and the loader: imports in Node, init well under 0.5 s,
 * the promise cached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpuNow } from './cpuclock.js';

const dir = new URL('../../vendor/rapier/', import.meta.url);
const SHA256 = '09a000bee2ad827608780cf8821258cadc243aaeb8881ab3e769de73f945eee0';
const INTEGRITY = 'sha512-X4W9pJBdGRX5CO3c/gUNjBFEFG2fn4nYxp9k8STdBDaLa0/w5XTW2ArpayS+9jGFojTi3uFSOWAElCd4rkpekA==';

test('vendor/rapier: rapier.mjs is 0.20.0 as published (sha256, size), with its licence and version note', () => {
  const buf = readFileSync(new URL('rapier.mjs', dir));
  assert.equal(buf.length, 2857590);
  assert.equal(createHash('sha256').update(buf).digest('hex'), SHA256);
  const note = readFileSync(new URL('VERSION.txt', dir), 'utf8');
  assert.match(note, /0\.20\.0/);
  assert.ok(note.includes(SHA256) && note.includes(INTEGRITY), 'VERSION.txt records the sha256 and the npm integrity');
  const lic = readFileSync(new URL('LICENSE', dir), 'utf8');
  assert.match(lic, /Apache License\s+Version 2\.0/);
  assert.ok(statSync(new URL('LICENSE', dir)).size > 10000);
  // no network imports in the compat build (the wasm is inline)
  assert.equal(/import\s*\(?\s*["']https?:/.test(buf.toString('latin1')), false);
});

test('loadRapier: imports the vendored module, init under 500 ms of CPU, version 0.20.0, cached', async () => {
  const { loadRapier, RAPIER_VERSION } = await import('../../src/physics/Rapier.js');
  const c0 = cpuNow();
  const a = await loadRapier();
  const ms = cpuNow() - c0;
  assert.equal(RAPIER_VERSION, '0.20.0');
  assert.equal(a.info.version, '0.20.0');
  assert.ok(ms < 500, `import + init took ${ms.toFixed(0)} ms of CPU`);
  assert.ok(a.info.importMs >= 0 && a.info.initMs >= 0);
  const b = await loadRapier();
  assert.equal(b, a, 'the same module and record');
  // a world works
  const w = new a.R.World({ x: 0, y: -9.81, z: 0 });
  const body = w.createRigidBody(a.R.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
  w.createCollider(a.R.ColliderDesc.ball(0.1), body);
  for (let i = 0; i < 10; i++) w.step();
  assert.ok(body.translation().y < 1);
  w.free();
});
