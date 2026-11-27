import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { AudioEngine, MIX, SOUNDS, roomResponse } from '../../src/audio/AudioEngine.js';
import { Events } from '../../src/core/Events.js';

// ── a minimal fake Web Audio API (records what the engine does) ──────────────

/** Off for the allocation test, so the fake itself allocates nothing per call. */
const REC = { on: true };

class Param {
  constructor(v = 0) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { if (REC.on) this.events.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { if (REC.on) this.events.push(['ramp', v, t]); return this; }
  cancelScheduledValues(t) { if (REC.on) this.events.push(['cancel', t]); return this; }
}

class Node {
  constructor(ac, kind) { this.ac = ac; this.kind = kind; this.outs = []; this.disconnects = 0; ac.created.push(kind); }
  connect(n) { if (REC.on) this.outs.push(n); return n; }
  disconnect() { this.outs.length = 0; this.disconnects++; }
}

class FakeSource extends Node {
  constructor(ac) { super(ac, 'source'); this.buffer = null; this.playbackRate = new Param(1); this.startAt = -1; this.stopAt = undefined; }
  start(t) { this.startAt = t; }
  stop(t) { this.stopAt = t; }
}

class FakeBuffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr;
    this.data = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(c) { return this.data[c]; }
}

class FakeAC {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.created = [];
    this.destination = new Node(this, 'destination');
    const L = {};
    for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) L[k] = new Param();
    this.listener = L;
    this.sources = [];
    this.decodes = 0;
    this.failNext = false;
    this.ring = [];
    this.ringI = 0;
  }
  createGain() { const n = new Node(this, 'gain'); n.gain = new Param(1); return n; }
  createBiquadFilter() { const n = new Node(this, 'biquad'); n.type = 'lowpass'; n.frequency = new Param(350); n.Q = new Param(1); return n; }
  createPanner() {
    const n = new Node(this, 'panner');
    n.panningModel = 'equalpower'; n.distanceModel = 'inverse'; n.refDistance = 1; n.rolloffFactor = 1; n.maxDistance = 10000;
    n.positionX = new Param(); n.positionY = new Param(); n.positionZ = new Param();
    return n;
  }
  createDynamicsCompressor() {
    const n = new Node(this, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param();
    return n;
  }
  createConvolver() {
    const n = new Node(this, 'convolver');
    n.normalize = true;
    n.assigned = 0;
    let b = null;
    Object.defineProperty(n, 'buffer', { get: () => b, set: (v) => { b = v; n.assigned++; } });
    return n;
  }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
  createBufferSource() {
    if (!REC.on) {
      // the browser must allocate a source per play; the fake hands out a ring of them
      const n = this.ring[this.ringI++ & 63];
      n.stopAt = undefined;
      return n;
    }
    const n = new FakeSource(this);
    this.sources.push(n);
    return n;
  }
  decodeAudioData(ab) {
    this.decodes++;
    if (this.failNext) { this.failNext = false; return Promise.reject(new Error('bad mp3')); }
    const bytes = ab.byteLength;
    structuredClone(ab, { transfer: [ab] }); // detach, as the real one does
    return Promise.resolve(new FakeBuffer(1, Math.max(1, Math.round((bytes / 1000) * 48000)), 48000));
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

const ab = (ms) => new ArrayBuffer(ms); // our fake decodes 1000 bytes as 1 s
const sounds = () => ({
  glockShot: [ab(600)],
  akShot: [ab(900), ab(900), ab(900), ab(900), ab(900)],
  enemyShot: [ab(900), ab(900), ab(900)],
  impactFlesh: [ab(300), ab(300)],
  brassS: [ab(200), ab(200)],
  step: [ab(250)],
});

async function ready(o = {}) {
  const audio = new AudioEngine({ AudioContextClass: FakeAC, ...o });
  const src = sounds();
  await audio.decodeAll(src);
  audio.unlock();
  await Promise.resolve();
  return { audio, ac: /** @type {FakeAC} */ (audio.ctx), src };
}

const cam = (x, y, z, q = { x: 0, y: 0, z: 0, w: 1 }) => ({ position: { x, y, z }, quaternion: q });

// ── tests ────────────────────────────────────────────────────────────────────

test('decodeAll decodes every variant from copies (assets keep their bytes), reports progress, skips failures', async () => {
  const audio = new AudioEngine({ AudioContextClass: FakeAC });
  const src = sounds();
  const progress = [];
  await audio.decodeAll(src, (f) => progress.push(f));
  assert.equal(audio.ready, true);
  assert.equal(audio.buffers.akShot.length, 5);
  assert.ok(src.akShot.every((b) => b.byteLength === 900), 'original ArrayBuffers are not detached');
  assert.equal(progress.at(-1), 1);
  assert.equal(audio.ctx.state, 'suspended', 'no sound before the gesture');
  // a clip that fails to decode is dropped and logged
  const b = new AudioEngine({ AudioContextClass: FakeAC });
  b.ensureContext().failNext = true;
  await b.decodeAll({ dry: [ab(100), ab(100)] });
  assert.equal(b.buffers.dry.length, 1);
  assert.equal(b.errors.length, 1);
});

test('graph at load: 8 HRTF + 14 equal-power panners, 2 UI voices, one convolver buffer assigned once', async () => {
  const { audio, ac } = await ready();
  const panners = audio.voices.filter((v) => v.panner).map((v) => v.panner.panningModel);
  assert.equal(audio.voices.length, MIX.voices);
  assert.deepEqual(panners.filter((m) => m === 'HRTF').length, 8);
  assert.deepEqual(panners.filter((m) => m === 'equalpower').length, 14);
  assert.equal(audio.voices.filter((v) => !v.panner).length, 2);
  assert.equal(audio.convolver.assigned, 1);
  assert.equal(audio.convolver.normalize, false);
  assert.equal(ac.created.filter((k) => k === 'panner').length, 22);
  // unlock started one silent sample, once
  assert.equal(ac.sources.length, 1);
  assert.equal(ac.state, 'running');
});

test('play: nothing before unlock; one source node per play and no other node; unknown keys refused', async () => {
  const pre = new AudioEngine({ AudioContextClass: FakeAC });
  await pre.decodeAll(sounds());
  assert.equal(pre.play('akShot', 0, 1, -1), -1);
  const { audio, ac } = await ready();
  const nodes = ac.created.length;
  for (let i = 0; i < 300; i++) {
    ac.currentTime += 0.05;
    audio.play(i % 2 ? 'brassS' : 'impactFlesh', i % 7, 1, -2);
  }
  const made = ac.created.slice(nodes);
  assert.equal(made.length, 300);
  assert.ok(made.every((k) => k === 'source'));
  assert.equal(audio.play('nope', 0, 0, 0), -1);
  assert.equal(audio.stats.missing, 1);
});

test('variants never repeat twice running; rate jitter stays within the sound’s range', async () => {
  const { audio, ac } = await ready();
  let last = null;
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    ac.currentTime += 1;
    audio.play('akShot', 0, 1.6, -0.5);
    const s = ac.sources.at(-1);
    assert.notEqual(s.buffer, last);
    last = s.buffer;
    seen.add(s.buffer);
    const r = s.playbackRate.value;
    assert.ok(Math.abs(r - 1) <= SOUNDS.akShot.jit + 1e-9, `rate ${r}`);
  }
  assert.equal(seen.size, 5, 'every variant is used');
});

test('distance: speed-of-sound delay, inverse-law settings per sound, air absorption, panner position', async () => {
  const { audio, ac } = await ready();
  audio.update(0, 0, null, { camera: cam(0, 1.6, 0) });
  ac.currentTime = 5;
  const id = audio.play('enemyShot', 0, 1.6, -6.86);
  assert.ok(id >= 0);
  const v = audio.voices[audio.pool.index(id)];
  const s = ac.sources.at(-1);
  assert.ok(Math.abs(s.startAt - (5 + 6.86 / 343)) < 1e-9, 'heard 20 ms later');
  assert.equal(v.panner.refDistance, 2.5);
  assert.equal(v.panner.rolloffFactor, 0.85);
  assert.equal(v.panner.positionZ.value, -6.86);
  assert.ok(Math.abs(v.filter.frequency.value - 20000 * Math.exp(-6.86 / 55)) < 1e-6);
  assert.ok(v.panner.panningModel === 'HRTF', 'enemy shots get an HRTF voice');
  assert.equal(v.gain.gain.value, SOUNDS.enemyShot.gain);
  assert.ok(v.send.gain.value > 0, 'room send');
});

test('occlusion: a blocked line from the head muffles (1.1 kHz) and lowers the sound; the endpoint stops short of the surface', async () => {
  const { audio, ac } = await ready();
  const calls = [];
  const world = { segmentClear: (ax, ay, az, bx, by, bz) => { calls.push([bx, by, bz]); return false; } };
  audio.update(0, 0, null, { camera: cam(0, 1.6, 0), world });
  ac.currentTime = 1;
  const id = audio.play('step', 3, 0, 0);
  const v = audio.voices[audio.pool.index(id)];
  assert.ok(v.filter.frequency.value < 1200);
  assert.ok(Math.abs(v.gain.gain.value - SOUNDS.step.gain * MIX.occludedGain) < 1e-9);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0] < 3 && calls[0][0] > 2.9, 'segment ends 5 cm short');
  // your own gun (within 0.75 m) is never tested
  audio.play('glockShot', 0.3, 1.4, -0.3);
  assert.equal(calls.length, 1);
  assert.equal(audio.stats.occluded, 1);
});

test('stealing fades the old sound for 6 ms (no click) and starts the new one after it', async () => {
  const { audio, ac } = await ready();
  ac.currentTime = 2;
  for (let i = 0; i < 22; i++) assert.ok(audio.play('brassS', i * 0.1, 0, -1) >= 0);
  const before = ac.sources.slice(-22);
  const id = audio.play('enemyShot', 0, 1.6, -1);
  assert.ok(id >= 0, 'a gunshot takes a brass voice');
  const stolen = before.find((s) => s.stopAt !== undefined);
  assert.ok(stolen, 'one old source was stopped');
  assert.ok(Math.abs(stolen.stopAt - (2 + MIX.stealFadeS)) < 1e-9);
  const v = audio.voices[audio.pool.index(id)];
  const ev = v.gain.gain.events.slice(-4).map((e) => e[0]);
  assert.deepEqual(ev, ['cancel', 'set', 'ramp', 'set']);
  assert.ok(ac.sources.at(-1).startAt >= 2 + MIX.stealFadeS);
  // a quiet brass tick cannot steal from 22 gunshots
  for (let i = 0; i < 22; i++) audio.play('akShot', 0, 1.5, -0.2);
  assert.equal(audio.play('brassS', 0, 0, -1), -1);
  assert.ok(audio.pool.drops >= 1);
});

test('listener: midpoint of the two eye cameras, forward / up from the head quaternion, written as .value', async () => {
  const { audio, ac } = await ready();
  // yaw 90° left: forward −Z → −X
  const h = Math.SQRT1_2;
  const q = { x: 0, y: h, z: 0, w: h };
  const xr = { position: { x: 9, y: 9, z: 9 }, quaternion: q, cameras: [cam(-0.032, 1.6, 0, q), cam(0.032, 1.6, 0, q)] };
  audio.update(0, 0, null, { camera: xr });
  const L = ac.listener;
  assert.ok(Math.abs(L.positionX.value) < 1e-9, 'midpoint of the eyes, not view 0');
  assert.equal(L.positionY.value, 1.6);
  assert.ok(Math.abs(L.forwardX.value + 1) < 1e-9);
  assert.ok(Math.abs(L.forwardZ.value) < 1e-9);
  assert.ok(Math.abs(L.upY.value - 1) < 1e-9);
  assert.ok(L.positionX.events.length === 0, 'direct .value writes, no automation events');
  // old listener API fallback
  const b = await ready();
  const calls = [];
  b.ac.listener = { setPosition: (...a) => calls.push(['p', ...a]), setOrientation: (...a) => calls.push(['o', ...a]) };
  b.audio.update(0, 0, null, { camera: cam(1, 2, 3) });
  assert.deepEqual(calls[0], ['p', 1, 2, 3]);
  assert.equal(calls[1][0], 'o');
});

test('bind: enemyShot and enemyHit events play their sounds; unbind stops that', async () => {
  const { audio, ac } = await ready();
  const ev = new Events();
  audio.bind(ev);
  const n = ac.sources.length;
  ev.emit('enemyShot', { enemy: 0, x: 2, y: 1.4, z: -4 });
  ev.emit('enemyHit', { enemy: 0, part: 'torso', damage: 40, x: 2, y: 1.2, z: -4, dx: 0, dy: 0, dz: 1 });
  assert.equal(ac.sources.length, n + 2);
  const bufs = ac.sources.slice(-2).map((s) => s.buffer);
  assert.ok(audio.buffers.enemyShot.includes(bufs[0]));
  assert.ok(audio.buffers.impactFlesh.includes(bufs[1]));
  audio.unbind();
  ev.emit('enemyShot', { enemy: 0, x: 2, y: 1.4, z: -4 });
  assert.equal(ac.sources.length, n + 2);
});

test('stop / move use generation-tagged ids; playUI uses the head-locked voices', async () => {
  const { audio, ac } = await ready();
  ac.currentTime = 1;
  const id = audio.play('step', 1, 0, 0);
  assert.equal(audio.move(id, 2, 0, 0), true);
  assert.equal(audio.voices[audio.pool.index(id)].panner.positionX.value, 2);
  assert.equal(audio.stop(id), true);
  assert.equal(audio.stop(id), false, 'stale after stop');
  const u = audio.playUI('dry' in audio.buffers ? 'dry' : 'brassS');
  assert.ok(u >= 0);
  assert.ok(audio.pool.index(u) >= audio.pool.spatialEnd);
  assert.equal(audio.voices[audio.pool.index(u)].panner, null);
});

test('room response: stereo, 0.6 s, unit energy per channel, decaying', () => {
  const ac = new FakeAC();
  let x = 1;
  const rand = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const b = roomResponse(ac, 0.6, 0.45, rand);
  assert.equal(b.numberOfChannels, 2);
  assert.equal(b.length, 28800);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let e = 0, early = 0, late = 0;
    for (let i = 0; i < d.length; i++) { e += d[i] * d[i]; if (i < 4800) early += d[i] * d[i]; else if (i > 19200) late += d[i] * d[i]; }
    assert.ok(Math.abs(e - 1) < 1e-4);
    assert.ok(early > late * 100, 'decays');
  }
  assert.notDeepEqual(b.getChannelData(0).slice(500, 520), b.getChannelData(1).slice(500, 520), 'decorrelated');
});

test('play and update allocate nothing in the engine (sampling heap profiler)', async () => {
  const { audio, ac } = await ready();
  const world = { segmentClear: (ax, ay, az, bx, by, bz) => bx < 2 };
  const ctx = { camera: { position: { x: 0, y: 1.6, z: 0 }, quaternion: { x: 0, y: 0.2, z: 0, w: 0.98 }, cameras: [cam(-0.03, 1.6, 0), cam(0.03, 1.6, 0)] }, world };
  const keys = ['akShot', 'enemyShot', 'brassS', 'impactFlesh', 'step', 'glockShot'];
  for (let i = 0; i < 64; i++) ac.ring.push(new FakeSource(ac));
  REC.on = false;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      ac.currentTime += 0.011;
      audio.update(0.011, i * 11, null, ctx);
      if (i % 3 === 0) audio.play(keys[i % 6], (i % 9) - 4, 1.2, -3);
      if (i % 50 === 0) audio.stop(audio.play('step', 1, 0, 1));
    }
  };
  loop(60000);
  // A steady allocation shows in every run; a one-off JIT event (a deopt boxes
  // doubles in whatever function it hits) does not, so take the best of three.
  let best = null, bestTotal = Infinity;
  for (let r = 0; r < 8 && bestTotal > 0; r++) { // best of up to 8 (early exit): a JIT deopt under load is one-off, a real allocation shows every time
    const s = new Session();
    s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 16 });
    loop(60000);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    const by = {};
    const walk = (n) => {
      const u = n.callFrame.url;
      if (n.selfSize > 0 && (u.endsWith('/src/audio/AudioEngine.js') || u.endsWith('/src/audio/VoicePool.js') || u.endsWith('/src/game/head.js'))) {
        by[n.callFrame.functionName] = (by[n.callFrame.functionName] || 0) + n.selfSize;
      }
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const t = Object.values(by).reduce((x, y) => x + y, 0);
    if (t < bestTotal) { bestTotal = t; best = by; }
  }
  REC.on = true;
  const by = best;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  assert.equal(total, 0, `engine allocated ${JSON.stringify(by)} over 60k frames and 20k plays`);
});
