// The automatic diagnostics upload (src/debug/Upload.js): the row, the headers, keepalive by size,
// the pending queue in storage, the retry on the next load, the size cap and the on/off rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Uploader, UPLOAD, UPLOAD_TEXT, shortDevice, uploadEnabled, utf8Length, compactPayload } from '../../src/debug/Upload.js';

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/37.0.0.22.15 SamsungBrowser/4.0 Chrome/157.0.0.0 VR Safari/537.36';

class MemStorage {
  constructor(limit = Infinity) { this.m = new Map(); this.limit = limit; this.writes = 0; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (String(v).length > this.limit) throw new Error('QuotaExceededError'); this.writes++; this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

/** A fetch that answers with `status` (or throws), recording every call. */
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = typeof answer === 'function' ? answer(init, calls.length) : answer;
    if (a instanceof Error) throw a;
    return { status: a };
  };
  f.calls = calls;
  return f;
}

const payload = (n = 10) => ({ app: 'cqc-pass-through', version: 'v0.4', ua: 'x', sessions: [{ mode: 'play', startedAt: 'a', errors: [], spaceSnapshot: { version: 2, planes: [], meshes: [], globalMesh: { triangleCount: 3, data: 'A'.repeat(n) } }, hitches: { total: 1, list: ['h'.repeat(n)] }, recent: { cpuAvg: 1 } }] });

test('shortDevice: Quest, desktop and empty user agents', () => {
  assert.equal(shortDevice(QUEST_UA), 'Quest 3 · OculusBrowser 37.0 · Chrome 157');
  assert.equal(shortDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36'), 'HeadlessChrome 153');
  assert.equal(shortDevice(''), 'unknown');
  assert.ok(shortDevice('x'.repeat(500)).length <= 120);
});

test('uploadEnabled: production only, unless ?upload=1; ?upload=0 never', () => {
  const P = (s) => new URLSearchParams(s);
  assert.equal(uploadEnabled(false, P('')), true);
  assert.equal(uploadEnabled(true, P('')), false, 'dev builds never upload');
  assert.equal(uploadEnabled(false, P('emulate')), false, '?emulate never uploads');
  assert.equal(uploadEnabled(true, P('emulate&upload=1')), true, '?upload=1 opts in');
  assert.equal(uploadEnabled(false, P('upload=0')), false);
});

test('utf8Length matches the encoded byte length', () => {
  for (const s of ['', 'abc', 'Sent ✓', 'é', '😀 x', JSON.stringify(payload(100))]) assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'), s);
});

test('compactPayload: small payloads unchanged; the mesh goes first, then the hitches, at worst a stub; the input is never changed', () => {
  const small = payload(10);
  assert.deepEqual(compactPayload(small, 1e6).trimmed, []);
  assert.equal(compactPayload(small, 1e6).payload, small);
  const big = payload(5000);
  const before = JSON.stringify(big);
  const a = compactPayload(big, 7000);
  assert.deepEqual(a.trimmed, ['mesh']);
  assert.equal(a.payload.sessions[0].spaceSnapshot.globalMesh.data, undefined);
  assert.equal(a.payload.sessions[0].spaceSnapshot.globalMesh.dataOmitted, true);
  assert.ok(a.bytes <= 7000);
  const b = compactPayload(big, 2000);
  assert.deepEqual(b.trimmed, ['mesh', 'hitches']);
  assert.equal(b.payload.sessions[0].hitches, undefined);
  const c = compactPayload(big, 100);
  assert.deepEqual(c.trimmed, ['mesh', 'hitches', 'all']);
  assert.equal(c.payload.truncated, true);
  assert.equal(c.payload.sessions[0].mode, 'play');
  assert.equal(JSON.stringify(big), before, 'the record itself is untouched');
});

test('send: one POST with the row, the PostgREST headers and keepalive for a small body', async () => {
  const f = fakeFetch(201);
  const seen = [];
  const U = new Uploader({ fetch: f, storage: new MemStorage(), version: 'v0.4', ua: QUEST_UA, onStatus: (s) => seen.push(s) });
  const r = await U.send('session', 'play', payload(10));
  assert.equal(r.ok, true);
  assert.equal(r.status, 201);
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://ysxcottwabhpajhcnbqr.supabase.co/rest/v1/diagnostics');
  assert.equal(init.method, 'POST');
  assert.equal(init.keepalive, true);
  assert.equal(init.headers.apikey, UPLOAD.key);
  assert.equal(init.headers.Authorization, `Bearer ${UPLOAD.key}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Prefer, 'return=minimal');
  assert.deepEqual(Object.keys(body).sort(), ['app', 'device', 'kind', 'mode', 'payload', 'version']);
  assert.equal(body.app, 'cqc-pass-through');
  assert.equal(body.version, 'v0.4');
  assert.equal(body.kind, 'session');
  assert.equal(body.mode, 'play');
  assert.equal(body.device, 'Quest 3 · OculusBrowser 37.0 · Chrome 157');
  assert.equal(body.payload.sessions[0].spaceSnapshot.globalMesh.data.length, 10, 'the compact mesh encoding is in the payload');
  assert.deepEqual(seen.map((s) => s.state), ['sending', 'sent']);
  assert.equal(seen.at(-1).text, 'Sent ✓');
  assert.equal(U.state, 'sent');
});

test('send: a body over 64 KB goes without keepalive', async () => {
  const f = fakeFetch(201);
  const U = new Uploader({ fetch: f, storage: new MemStorage(), version: 'v0.4' });
  const r = await U.send('session', 'play', payload(80 * 1024));
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].init.keepalive, false);
  assert.ok(r.bytes > UPLOAD.keepaliveMax);
});

test('send: a refused keepalive request is asked again without keepalive', async () => {
  const f = fakeFetch((init) => (init.keepalive ? new TypeError('Failed to fetch') : 201));
  const U = new Uploader({ fetch: f, storage: new MemStorage(), version: 'v0.4' });
  const r = await U.send('copy', 'play', payload(10));
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((c) => c.init.keepalive), [true, false]);
  assert.match(r.error, /keepalive refused/);
});

test('failure: the body waits in storage (at most 3, oldest dropped); "Will retry"; a test row is never kept', async () => {
  const st = new MemStorage();
  const seen = [];
  const U = new Uploader({ fetch: fakeFetch(503), storage: st, version: 'v0.4', onStatus: (s) => seen.push(s) });
  for (let i = 0; i < 4; i++) await U.send('session', `m${i}`, payload(10));
  const list = JSON.parse(st.getItem(UPLOAD.pendingKey));
  assert.equal(list.length, UPLOAD.maxPending);
  assert.deepEqual(list.map((p) => p.mode), ['m1', 'm2', 'm3']);
  assert.equal(seen.at(-1).state, 'retry');
  assert.equal(seen.at(-1).text, UPLOAD_TEXT.retry);
  assert.equal(seen.at(-1).text, 'Will retry');
  assert.match(seen.at(-1).detail, /HTTP 503/);
  await U.send('test', 'test', { tiny: true });
  assert.equal(JSON.parse(st.getItem(UPLOAD.pendingKey)).length, 3, 'kind test is not queued');
  const net = new Uploader({ fetch: fakeFetch(new TypeError('offline')), storage: new MemStorage(), version: 'v0.4' });
  const r = await net.send('session', 'play', payload(80 * 1024));
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(net.pending().length, 1);
});

test('retryPending (next page load): sends what waits, clears it, says "Sent ✓"; keeps failures up to maxTries', async () => {
  const st = new MemStorage();
  await new Uploader({ fetch: fakeFetch(500), storage: st, version: 'v0.4' }).send('session', 'play', payload(10));
  await new Uploader({ fetch: fakeFetch(500), storage: st, version: 'v0.4' }).send('copy', 'play', payload(10));
  const f = fakeFetch(201);
  const seen = [];
  const U = new Uploader({ fetch: f, storage: st, version: 'v0.4', onStatus: (s) => seen.push(s) });
  const r = await U.retryPending();
  assert.deepEqual(r, { sent: 2, kept: 0 });
  assert.deepEqual(f.calls.map((c) => c.body.kind), ['session', 'copy']);
  assert.equal(st.getItem(UPLOAD.pendingKey), null);
  assert.equal(seen.at(-1).text, 'Sent ✓');
  // failing again: tries count up, dropped at maxTries
  await new Uploader({ fetch: fakeFetch(500), storage: st, version: 'v0.4' }).send('session', 'play', payload(10));
  const bad = new Uploader({ fetch: fakeFetch(500), storage: st, version: 'v0.4' });
  for (let i = 0; i < UPLOAD.maxTries; i++) await bad.retryPending();
  assert.equal(bad.pending().length, 0, 'dropped after maxTries attempts');
});

test('disabled (dev, ?emulate): nothing is sent, nothing is stored', async () => {
  const f = fakeFetch(201);
  const st = new MemStorage();
  const U = new Uploader({ enabled: false, fetch: f, storage: st });
  const r = await U.send('session', 'play', payload(10));
  assert.equal(r.skipped, 'off');
  assert.deepEqual(await U.retryPending(), { sent: 0, kept: 0 });
  assert.equal(f.calls.length, 0);
  assert.equal(st.writes, 0);
  assert.equal(U.state, 'off');
});

test('storage quota: only the newest waiting upload is kept', async () => {
  const st = new MemStorage(3000);
  const U = new Uploader({ fetch: fakeFetch(503), storage: st, version: 'v0.4' });
  await U.send('session', 'a', payload(800));
  await U.send('session', 'b', payload(800));
  const list = U.pending();
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, 'b');
});
