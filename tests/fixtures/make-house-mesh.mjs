// Adds (or refreshes) the synthetic Space Setup global mesh in tests/fixtures/house.json:
//   node tests/fixtures/make-house-mesh.mjs
// The mesh is src/world/ScanSynth.js's scan of the fixture's own planes and volumes (floors,
// ceilings, wall faces with the door openings open, a lumpy bed, a sagging couch, a table on
// legs; 6 mm noise, ~0.165 m triangles), stored the way a session record stores the user's
// real mesh: snapshot v2 `globalMesh` = 'cqc-mesh-1' (2 mm, varint deltas), gzip, base64,
// in the reference space. Deterministic (seed 7), so re-running gives the same bytes.
import { readFileSync, writeFileSync } from 'node:fs';
import { scanFromSnapshot } from '../../src/world/ScanSynth.js';
import { encodeMeshRecord } from '../../src/world/MeshCodec.js';

const url = new URL('./house.json', import.meta.url);
const snap = JSON.parse(readFileSync(url, 'utf8'));
const scan = scanFromSnapshot(snap, { seed: 7 });
const rec = await encodeMeshRecord({ vertices: scan.vertices, indices: scan.indices });
const gi = snap.meshes.findIndex((m) => (m.label || '').toLowerCase() === 'global mesh');
if (gi >= 0) snap.meshes[gi].vertexCount = rec.vertexCount;
snap.version = 2;
snap.globalMesh = { label: 'global mesh', mesh: gi, vertexCount: rec.vertexCount, triangleCount: rec.triangleCount, lastChangedTime: 0, space: 'reference', ...rec };
// keep the one-entry-per-line layout of the file
const line = (o) => JSON.stringify(o);
const text = `{\n  "version": 2,\n  "space": ${line(snap.space)},\n  "planes": [\n${snap.planes.map((p) => `    ${line(p)}`).join(',\n')}\n  ],\n`
  + `  "meshes": [\n${snap.meshes.map((m) => `    ${line(m)}`).join(',\n')}\n  ],\n  "globalMesh": ${line(snap.globalMesh)}\n}\n`;
writeFileSync(url, text);
console.log(`house.json: ${rec.triangleCount} triangles, ${rec.vertexCount} vertices, ${rec.bytes} B gzip, ${rec.data.length} B base64, hash ${rec.hash}`);
