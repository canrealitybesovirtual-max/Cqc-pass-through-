// Assets: pure helpers of src/core/Assets.js and the baked files in assets/
// (manifest against the contract, GLB structure read without three.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateManifest, planLoad, soundBuffers, ProgressTracker, fetchBytes, runLimited, SOUND_KEYS, WEAPON_IDS,
} from '../../src/core/Assets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assetsDir = join(root, 'assets');
const manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8'));

/** Parse a GLB: JSON chunk + BIN chunk. */
function readGlb(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'glTF');
  assert.equal(b.readUInt32LE(4), 2);
  const jsonLen = b.readUInt32LE(12);
  assert.equal(b.toString('ascii', 16, 20), 'JSON');
  const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const bin = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
  return { json, bin };
}
/** Width / height from a KTX2 header. */
function ktx2Size(buf) {
  assert.equal(buf.toString('latin1', 1, 7), 'KTX 20');
  return [buf.readUInt32LE(20), buf.readUInt32LE(24)];
}
const triCount = (gltf, prim) => gltf.accessors[prim.indices].count / 3;
const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-3;

test('baked manifest matches the contract', () => {
  assert.deepEqual(validateManifest(manifest), []);
});

test('validateManifest reports missing pieces', () => {
  const bad = structuredClone(manifest);
  delete bad.weapons.glock.grip;
  bad.sounds.step = [];
  const errs = validateManifest(bad);
  assert.ok(errs.some((e) => e.includes('glock.grip')));
  assert.ok(errs.some((e) => e.includes('sounds.step')));
  assert.deepEqual(validateManifest(null), ['manifest is not an object']);
});

test('every listed file exists with the recorded size; total under 12 MB', () => {
  let total = 0;
  for (const [file, bytes] of Object.entries(manifest.bytes)) {
    const s = statSync(join(assetsDir, file)).size;
    assert.equal(s, bytes, file);
    total += s;
  }
  for (const f of [...Object.values(manifest.models), ...Object.values(manifest.sounds).flat()]) assert.ok(f in manifest.bytes, `${f} has a size`);
  assert.ok(total < 12 * 1024 * 1024, `total ${total}`);
});

for (const id of WEAPON_IDS) {
  test(`${id}.glb: one 'gun' primitive with _PART, one 'mag' primitive, one material, KTX2 <= 2048, <= 30k tris`, () => {
    const { json, bin } = readGlb(join(assetsDir, manifest.models[id]));
    for (const ext of ['EXT_meshopt_compression', 'KHR_texture_basisu', 'KHR_mesh_quantization']) assert.ok(json.extensionsRequired.includes(ext), ext);
    const node = (n) => json.nodes.find((x) => x.name === n);
    const gun = json.meshes[node('gun').mesh], mag = json.meshes[node('mag').mesh];
    assert.equal(gun.primitives.length, 1);
    assert.equal(mag.primitives.length, 1);
    assert.equal(json.materials.length, 1);
    assert.equal(gun.primitives[0].material, mag.primitives[0].material);
    const part = json.accessors[gun.primitives[0].attributes._PART];
    assert.equal(part.type, 'SCALAR');
    assert.equal(part.componentType, 5126, '_PART is float');
    const tris = triCount(json, gun.primitives[0]) + triCount(json, mag.primitives[0]);
    assert.ok(tris <= 30000, `${tris} tris`);
    assert.equal(tris, manifest.weapons[id].tris);
    assert.ok(!node('gun').translation && !node('gun').rotation && !node('gun').scale, 'gun node at identity');
    assert.deepEqual(node('mag').translation.map((x) => +x.toFixed(5)), manifest.weapons[id].magLocalSeat);
    assert.equal(json.images.length, 3);
    for (const img of json.images) {
      assert.equal(img.mimeType, 'image/ktx2');
      const bv = json.bufferViews[img.bufferView];
      const [w, h] = ktx2Size(Buffer.from(bin.buffer, bin.byteOffset + (bv.byteOffset || 0), bv.byteLength));
      assert.ok(w <= 2048 && h <= 2048, `${w}x${h}`);
    }
    // gun space: the gun sits around the origin, muzzle at -Z
    const pos = json.accessors[gun.primitives[0].attributes.POSITION];
    assert.equal(pos.componentType, 5126, 'float positions (no dequantisation transform)');
    assert.ok(pos.min[2] <= manifest.weapons[id].muzzle[2] + 1e-4);
  });

  test(`${id} manifest points are consistent with gun space`, () => {
    const w = manifest.weapons[id];
    assert.ok(Math.hypot(w.muzzle[0], w.muzzle[1]) < 1e-6, 'muzzle on the bore');
    assert.ok(w.muzzle[2] < -0.1, 'muzzle ahead of the breech');
    assert.ok(unit(w.grip.up) && unit(w.grip.fwd) && unit(w.magWell.axis) && unit(w.ejectDir) && unit(w.trigger.axis));
    assert.ok(Math.abs(w.grip.up.reduce((a, x, i) => a + x * w.grip.fwd[i], 0)) < 1e-3, 'grip fwd is perpendicular to up');
    assert.ok(w.grip.up[1] > 0.8 && w.grip.fwd[2] < -0.8);
    assert.ok(w.grip.pos[1] < -0.04 && w.grip.pos[2] > 0, 'grip below and behind the breech');
    assert.ok(w.magWell.axis[1] > 0.8, 'magazine goes in upwards');
    assert.ok(w.trigger.pivot[1] < 0 && w.trigger.pullRad > 0.1 && w.trigger.pullRad < 0.7);
    assert.ok(w.sights.rear[1] > 0.005 && w.sights.front[1] > 0.005 && w.sights.front[2] < w.sights.rear[2]);
    assert.ok(w.ejectDir[0] > 0.5, 'ejects to the right');
    assert.ok(w.ejectionPort[0] > 0.005);
    assert.deepEqual(w.slide.axis, [0, 0, 1]);
    const [lo, hi] = id === 'glock' ? [0.028, 0.042] : [0.06, 0.13];
    assert.ok(w.slide.travel > lo && w.slide.travel < hi, `travel ${w.slide.travel}`);
    if (id === 'akm') assert.ok(w.support.pos[2] < -0.05 && w.support.pos[2] > w.muzzle[2] && w.support.pos[1] < 0, 'support on the handguard, under the bore');
  });
}

test('soldier.glb: one skinned mesh, <= 64 joints, rifle (<= 3k tris) on the right hand', () => {
  const { json } = readGlb(join(assetsDir, manifest.models.soldier));
  assert.equal(json.skins.length, 1);
  const skin = json.skins[0];
  assert.ok(skin.joints.length <= 64, `${skin.joints.length} joints`);
  const byName = (n) => json.nodes.findIndex((x) => x.name === n);
  const body = json.nodes.find((x) => x.skin === 0);
  assert.equal(json.meshes[body.mesh].primitives.length, 1);
  const handR = byName(manifest.soldier.joints.handR);
  assert.ok(skin.joints.includes(handR));
  const rifle = byName('rifle');
  assert.ok(json.nodes[handR].children.includes(rifle), 'rifle is a child of hand_r');
  const rprims = json.meshes[json.nodes[rifle].mesh].primitives;
  assert.equal(rprims.length, 1);
  assert.ok(triCount(json, rprims[0]) <= 3000);
  assert.deepEqual(json.nodes[rifle].translation.map((x) => +x.toFixed(5)), manifest.soldier.rifleInHand.pos);
  for (const n of Object.values(manifest.soldier.joints).flat()) assert.ok(skin.joints.includes(byName(n)), n);
  const pos = json.accessors[json.meshes[body.mesh].primitives[0].attributes.POSITION];
  assert.ok(Math.abs(pos.min[1]) < 1e-3, 'feet at y = 0');
  assert.ok(Math.abs(pos.max[1] - manifest.soldier.height) < 1e-3);
  assert.ok(!json.extensionsUsed.includes('KHR_materials_specular'));
});

test('planLoad fetches each sound file once and sums the bytes', () => {
  const plan = planLoad(manifest);
  assert.deepEqual(plan.models.map((m) => m.id), ['glock', 'akm', 'soldier']);
  const listed = Object.values(manifest.sounds).flat();
  assert.equal(plan.sounds.length, new Set(listed).size);
  assert.ok(plan.sounds.length < listed.length, 'enemyShot reuses the AK takes');
  const sum = plan.models.reduce((a, m) => a + m.bytes, 0) + plan.sounds.reduce((a, s) => a + s.bytes, 0);
  assert.equal(plan.totalBytes, sum);
  for (const k of SOUND_KEYS) assert.ok(plan.soundKeys[k].length > 0, k);
});

test('soundBuffers gives every use after the first its own copy', () => {
  const a = new Uint8Array([1, 2, 3]).buffer, b = new Uint8Array([4]).buffer;
  const out = soundBuffers({ x: ['a', 'b'], y: ['a'] }, new Map([['a', a], ['b', b]]));
  assert.equal(out.x[0], a);
  assert.notEqual(out.y[0], a);
  assert.deepEqual([...new Uint8Array(out.y[0])], [1, 2, 3]);
  assert.throws(() => soundBuffers({ z: ['missing'] }, new Map()), /missing/);
});

test('ProgressTracker is monotonic and reaches 1', () => {
  const seen = [];
  const p = new ProgressTracker(100, 2, (f, l) => seen.push([f, l]));
  p.bytes(60, 'a'); p.bytes(-20, 'retry'); p.bytes(60, 'a'); p.step('parse 1'); p.step('parse 2'); p.emit('done');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0]);
  assert.equal(seen.at(-1)[0], 1);
});

test('fetchBytes streams chunks, retries 5xx and fails fast on 404', async () => {
  const body = (chunks) => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); } }));
  let n = 0;
  const flaky = async () => (n++ === 0 ? new Response('busy', { status: 503 }) : body([[1, 2], [3]]));
  let counted = 0;
  const buf = await fetchBytes('x', (k) => { counted += k; }, { fetch: flaky });
  assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3]);
  assert.equal(counted, 3);
  let calls = 0;
  await assert.rejects(fetchBytes('missing', () => {}, { fetch: async () => { calls++; return new Response('no', { status: 404 }); } }), /404/);
  assert.equal(calls, 1);
});

test('runLimited keeps at most `limit` jobs in flight and keeps order', async () => {
  let live = 0, peak = 0;
  const jobs = Array.from({ length: 10 }, (_, i) => async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; return i; });
  assert.deepEqual(await runLimited(jobs, 3), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(peak <= 3);
});
