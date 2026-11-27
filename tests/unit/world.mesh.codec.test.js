// The session record's mesh encoding (src/world/MeshCodec.js): 2 mm quantum, per-axis delta
// zigzag varints, gzip (CompressionStream), base64; FNV-1a hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMesh, decodeMeshRecord, encodeMesh, encodeMeshRecord, fromBase64, meshHash, toBase64, MESH_QUANTUM } from '../../src/world/MeshCodec.js';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';

const house = () => JSON.parse(readFileSync(new URL('../fixtures/house.json', import.meta.url), 'utf8'));

test('encode → decode: every vertex within 1 mm (2 mm quantum), indices and the triangle attribute exact', () => {
  const scan = scanFromSnapshot(house(), { seed: 3 });
  const tri8 = new Uint8Array(scan.indices.length / 3).map((_, i) => i % 6);
  const bytes = encodeMesh({ vertices: scan.vertices, indices: scan.indices, tri8 });
  const d = decodeMesh(bytes);
  assert.equal(d.vertices.length, scan.vertices.length);
  assert.deepEqual(d.indices, scan.indices);
  assert.deepEqual(d.tri8, tri8);
  let worst = 0;
  for (let i = 0; i < d.vertices.length; i++) worst = Math.max(worst, Math.abs(d.vertices[i] - scan.vertices[i]));
  assert.ok(worst <= MESH_QUANTUM / 2 + 1e-6, `worst error ${worst} m`);
  // compact before gzip: under 8 bytes per triangle (12 floats + 3 indices would be 24+)
  assert.ok(bytes.length < (scan.indices.length / 3) * 8, `${bytes.length} B for ${scan.indices.length / 3} triangles`);
  assert.equal(meshHash(bytes), meshHash(encodeMesh({ vertices: scan.vertices, indices: scan.indices, tri8 })), 'deterministic');
  assert.match(meshHash(bytes), /^[0-9a-f]{8}$/);
});

test('record: gzip + base64, JSON-safe, hash-checked; the fixture mesh is a few KB', async () => {
  const scan = scanFromSnapshot(house());
  const rec = await encodeMeshRecord({ vertices: scan.vertices, indices: scan.indices });
  assert.equal(rec.encoding, 'cqc-mesh-1');
  assert.equal(rec.compression, 'gzip');
  assert.equal(rec.triangleCount, scan.indices.length / 3);
  assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
  assert.ok(rec.data.length < 20000, `${rec.data.length} B base64 for ${rec.triangleCount} triangles`);
  const d = await decodeMeshRecord(rec);
  assert.deepEqual(d.indices, scan.indices);
  // a flipped bit fails the hash; garbage fails the stream checks
  const bad = { ...rec, hash: (parseInt(rec.hash, 16) ^ 1).toString(16).padStart(8, '0') };
  await assert.rejects(() => decodeMeshRecord(bad), /hash/);
  await assert.rejects(() => decodeMeshRecord({ ...rec, data: toBase64(new Uint8Array([1, 2, 3, 4])) }));
  assert.throws(() => decodeMesh(new Uint8Array(40)), /cqc-mesh-1/);
  assert.throws(() => decodeMesh(encodeMesh({ vertices: scan.vertices, indices: scan.indices }).slice(0, 100)), /truncated/);
});

test('base64 round trip for any length; empty mesh round trip', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 1000, 12289]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
    assert.deepEqual(fromBase64(toBase64(b)), b, `length ${n}`);
  }
  const e = decodeMesh(encodeMesh({ vertices: new Float32Array(0), indices: new Uint32Array(0) }));
  assert.equal(e.vertices.length, 0);
  assert.equal(e.indices.length, 0);
});
