// Soft live-depth occlusion (src/xr/DepthOcclusion.js) on a real WebGL2 GPU
// path in headless Chromium (SwiftShader). IWER has no depth data, so this
// stands in for the headset: fake 2-layer depth textures, two side-by-side
// "eye" viewports, and the GPU output compared pixel by pixel with the pure
// maths in src/xr/occlusionMath.js.
//
//   NODE_PATH=$(npm root -g) node tests/e2e/depth-occlusion.mjs      exit 0 = all checks passed
//
// Checks: every patched variant compiles and links (MeshStandard with the
// fixed light set, skinned, instanced + instanceColor, chained hook,
// MeshPhysical, MeshBasic opaque/transparent, ShaderMaterial with the chunks);
// eye/layer selection; fade, dither, 1-tap and 4-tap PCF output; bias, band
// growth, no-data and finite-far linearisation; three's ExternalTexture path
// (an R32F texture array like IWER's and a DEPTH_COMPONENT16 array like the
// Quest's unsigned-short depth); program and texture counts flat across every
// mode switch after the warm-up.
import { createRequire } from 'node:module';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const checks = [];
const ok = (name, cond, info = '') => { checks.push({ name, pass: !!cond, info }); };

const server = await serve(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.route('**/__depth-occlusion.html', (route) => route.fulfill({
  contentType: 'text/html',
  body: '<!doctype html><html><head><meta charset="utf-8"><script type="importmap">{ "imports": { "three": "/vendor/three/three.module.js" } }</script></head><body></body></html>',
}));

try {
  await page.goto(`http://localhost:${port}/__depth-occlusion.html`);
  const res = await page.evaluate(runInPage);
  for (const c of res.checks) ok(c.name, c.pass, c.info);
} catch (e) {
  ok('page run', false, String(e && e.stack || e));
} finally {
  ok('no console errors or warnings', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  await browser.close();
  server.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  (${c.info})` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------
// Runs inside the page.
async function runInPage() {
  const THREE = await import('three');
  const D = await import('/src/xr/DepthOcclusion.js');
  const M = await import('/src/xr/occlusionMath.js');
  const out = [];
  const check = (name, pass, info = '') => out.push({ name, pass: !!pass, info: String(info) });

  const W = 64, H = 32, DW = 16, DH = 8; // per-eye framebuffer px; depth texels per layer (4 px per texel)
  const canvas = document.createElement('canvas');
  canvas.width = 2 * W; canvas.height = H;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
  if (!gl) { check('WebGL2 context', false); return { checks: out }; }
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.debug.checkShaderErrors = true;
  const shaderErrors = [];
  renderer.debug.onShaderError = (g, program, vs, fs) => {
    shaderErrors.push(`${g.getProgramInfoLog(program)} ${g.getShaderInfoLog(vs)} ${g.getShaderInfoLog(fs)}`.slice(0, 600));
  };
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  const rt = new THREE.WebGLRenderTarget(2 * W, H, { depthBuffer: true });
  const buf = new Uint8Array(2 * W * H * 4);
  const cam = new THREE.PerspectiveCamera(90, W / H, 0.05, 100);

  // --- the scene used for pixel checks: one big plane at a known view depth
  const scene = new THREE.Scene();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400));
  scene.add(plane);
  const setPlane = (z, material) => { plane.position.set(0, 0, -z); plane.material = material; plane.updateMatrixWorld(); };

  const matOpaque = D.applySoftOcclusion(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const matTransp = D.applySoftOcclusion(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
  const shaderMat = D.applySoftOcclusion(new THREE.ShaderMaterial({
    vertexShader: `#include <softocc_pars_vertex>
void main() {
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	#include <softocc_vertex>
	gl_Position = projectionMatrix * mvPosition;
}`,
    fragmentShader: `#include <softocc_pars_fragment>
void main() {
	#include <softocc_fragment_begin>
	gl_FragColor = vec4( 0.6 ); // premultiplied
	#include <softocc_fragment_end>
}`,
    transparent: true, premultipliedAlpha: true, depthWrite: false,
  }), { bias: 0 });

  // --- the compile set: every variant the game would patch, in a lit scene
  const lit = new THREE.Scene();
  lit.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3026, 1.6), new THREE.DirectionalLight(0xffffff, 1.4));
  for (let i = 0; i < 2; i++) { const l = new THREE.PointLight(0xffc27a, 0, 4, 2); lit.add(l); }
  const std = D.applySoftOcclusion(new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5 }), { bias: D.OCCLUSION_BIAS.enemy });
  const phys = D.applySoftOcclusion(new THREE.MeshPhysicalMaterial({ color: 0x888888, clearcoat: 0.5 }));
  const brass = D.applySoftOcclusion(new THREE.MeshStandardMaterial({ color: 0xc9a24f, metalness: 0.6, roughness: 0.38 }), { bias: D.OCCLUSION_BIAS.brass });
  const flash = D.applySoftOcclusion(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  const hooked = new THREE.MeshStandardMaterial({ color: 0x444444 });
  hooked.onBeforeCompile = (shader) => { // WeaponView-style part hook, installed first
    shader.uniforms.uPart = { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uPart[5];')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = ( uPart[ 0 ] * vec4( transformed, 1.0 ) ).xyz;');
  };
  hooked.customProgramCacheKey = () => 'w2-part';
  D.applySoftOcclusion(hooked, { bias: D.OCCLUSION_BIAS.droppedMag });
  const unpatched = new THREE.MeshStandardMaterial({ color: 0x00ff00 });

  const box = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const skinGeo = box.clone();
  const n = skinGeo.attributes.position.count;
  skinGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  const sw = new Float32Array(n * 4); for (let i = 0; i < n; i++) sw[i * 4] = 1;
  skinGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const bone = new THREE.Bone();
  const skinned = new THREE.SkinnedMesh(skinGeo, std);
  skinned.add(bone);
  skinned.bind(new THREE.Skeleton([bone]));
  const inst = new THREE.InstancedMesh(box, brass, 4);
  inst.setColorAt(0, new THREE.Color(1, 1, 1));
  const instFlash = new THREE.InstancedMesh(box, flash, 2);
  instFlash.setColorAt(0, new THREE.Color(1, 1, 1));
  const objs = [new THREE.Mesh(box, std), skinned, inst, instFlash, new THREE.Mesh(box, phys), new THREE.Mesh(box, hooked), new THREE.Mesh(box, unpatched),
    new THREE.Mesh(box, matOpaque), new THREE.Mesh(box, matTransp), new THREE.Mesh(box, shaderMat)];
  objs.forEach((o, i) => { o.position.set((i % 5) * 0.25 - 0.5, i < 5 ? 0.15 : -0.15, -1); o.frustumCulled = false; lit.add(o); });
  const litCam = new THREE.PerspectiveCamera(70, 2, 0.05, 50);

  // --- depth sources
  const near = 0.1;
  const LCG = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  /** @param {(layer:number, tx:number, ty:number) => number} raw */
  function makeDataTex(raw) {
    const data = new Float32Array(DW * DH * 2);
    for (let l = 0; l < 2; l++) for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) data[(l * DH + y) * DW + x] = raw(l, x, y);
    const t = new THREE.DataArrayTexture(data, DW, DH, 2);
    t.format = THREE.RedFormat; t.type = THREE.FloatType;
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return { tex: t, data };
  }
  function setData(dt, raw) {
    for (let l = 0; l < 2; l++) for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) dt.data[(l * DH + y) * DW + x] = raw(l, x, y);
    dt.tex.needsUpdate = true;
  }
  /** IWER-like: a raw GL R32F texture array wrapped in three's ExternalTexture (as WebXRDepthSensing does). */
  function makeExternalR32F(raw) {
    const data = new Float32Array(DW * DH * 2);
    for (let l = 0; l < 2; l++) for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) data[(l * DH + y) * DW + x] = raw(l, x, y);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, DW, DH, 2);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, DW, DH, 2, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    renderer.resetState();
    return new THREE.ExternalTexture(t);
  }
  /** Quest-like: DEPTH_COMPONENT16 texture array, each layer drawn with gl_FragDepth = 1 − near / z(texel). */
  function makeExternalDepth16() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, DW, DH, 2);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){ vec2 q = vec2( ( gl_VertexID << 1 ) & 2, gl_VertexID & 2 ); gl_Position = vec4( q * 2.0 - 1.0, 0.0, 1.0 ); }'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; uniform float uLayer;
void main(){ vec2 t = floor( gl_FragCoord.xy ); float z = 0.8 + 0.12 * t.x + 0.05 * t.y + 0.3 * uLayer; gl_FragDepth = 1.0 - ${near.toFixed(3)} / z; }`));
    gl.linkProgram(p);
    const linked = gl.getProgramParameter(p, gl.LINK_STATUS);
    const fb = gl.createFramebuffer();
    const vao = gl.createVertexArray();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindVertexArray(vao);
    gl.useProgram(p);
    gl.viewport(0, 0, DW, DH);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    let complete = true;
    for (let l = 0; l < 2; l++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, t, 0, l);
      complete = complete && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.uniform1f(gl.getUniformLocation(p, 'uLayer'), l);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.deleteFramebuffer(fb); gl.deleteVertexArray(vao); gl.deleteProgram(p);
    renderer.resetState();
    const zAt = (l, x, y) => 0.8 + 0.12 * x + 0.05 * y + 0.3 * l;
    const raw = (l, x, y) => Math.round((1 - near / zAt(l, x, y)) * 65535) / 65535;
    return { tex: new THREE.ExternalTexture(t), raw, ok: linked && complete, info: `linked ${linked}, fbo complete ${complete}, err 0x${gl.getError().toString(16)}` };
  }

  // --- the controller drives the uniforms, as in the game (test-depth mode: no XR)
  const occ = new D.DepthOcclusion({ band: 0.08, pcf: false }).enable(renderer);
  occ.setViewports(0, 0, W, H, W, 0, W, H).setDepthRange(near, Infinity);

  const vp0 = [0, 0, W, H], vp1 = [W, 0, W, H];
  /** @param {{ zf:number, bias:number, band:number, growth:number, pcf:boolean, dither:boolean, on:boolean, far:number, max:number, noData:number }} c */
  function reference(c, rawFn) {
    const lin = M.linearParams(near, c.far, { a: 0, b: 0 });
    const e = { eye: 0, u: 0, v: 0 }, nt = { x: 0, y: 0 }, bt = { x0: 0, y0: 0, x1: 0, y1: 0, fx: 0, fy: 0 };
    const vis = new Float32Array(2 * W * H);
    for (let py = 0; py < H; py++) for (let px = 0; px < 2 * W; px++) {
      if (!c.on) { vis[py * 2 * W + px] = 1; continue; }
      M.eyeUv(px + 0.5, py + 0.5, vp0, vp1, e);
      const fz = c.zf - c.bias;
      const at = (tx, ty) => M.visibility(M.rawToMetres(rawFn(e.eye, tx, ty), lin.a, lin.b, c.max, c.noData), fz, c.band, c.growth);
      let v;
      if (c.pcf) { M.bilinearTexels(e.u, e.v, DW, DH, bt); v = M.pcf(at(bt.x0, bt.y0), at(bt.x1, bt.y0), at(bt.x0, bt.y1), at(bt.x1, bt.y1), bt.fx, bt.fy); }
      else { M.nearestTexel(e.u, e.v, DW, DH, nt); v = at(nt.x, nt.y); }
      if (c.dither) v = v < M.ditherThreshold(px, py) ? 0 : 1;
      else if (v < M.VIS_DISCARD) v = 0;
      vis[py * 2 * W + px] = v;
    }
    return vis;
  }
  const BASE = { zf: 1.5, bias: 0, band: 0.08, growth: 0, pcf: false, dither: false, on: true, far: Infinity, max: 50, noData: -1 };

  /** Render both eyes and return the RGBA bytes. */
  function renderEyes(s = scene, camera = cam) {
    renderer.setRenderTarget(rt);
    renderer.clear();
    for (let eye = 0; eye < 2; eye++) {
      rt.viewport.set(eye * W, 0, W, H);
      renderer.setRenderTarget(rt);
      renderer.render(s, camera);
    }
    renderer.readRenderTargetPixels(rt, 0, 0, 2 * W, H, buf);
    renderer.setRenderTarget(null);
    return buf;
  }
  /** Configure, run the controller's per-frame update twice (warm frame + live), render, compare. */
  function run(name, c, tex, rawFn, material = matOpaque, scale = 1, channel = 3) {
    occ.configure({ band: c.band, bandGrowth: c.growth, pcf: c.pcf, dither: c.dither, maxMetres: c.max, noDataRaw: c.noData });
    occ.setDepthRange(near, c.far);
    D.setSoftOcclusionBias(material, c.bias);
    occ.setTestDepth(c.on ? tex : null);
    occ.update(); const live = occ.update();
    setPlane(c.zf, material);
    renderEyes();
    const ref = reference(c, rawFn);
    let maxErr = 0, bad = 0, partial = 0, worst = '';
    for (let i = 0; i < 2 * W * H; i++) {
      const got = buf[i * 4 + channel] / 255, want = ref[i] * scale;
      const err = Math.abs(got - want);
      if (got > 0.02 && got < scale - 0.02) partial++;
      if (err > maxErr) { maxErr = err; worst = `px ${i % (2 * W)},${Math.floor(i / (2 * W))} got ${got.toFixed(3)} want ${want.toFixed(3)}`; }
      if (err > 2.5 / 255) bad++;
    }
    const allowed = c.dither ? Math.ceil(0.01 * 2 * W * H) : 0; // dither: ties at a threshold may flip a pixel
    check(name, live === c.on && bad <= allowed, `max err ${maxErr.toFixed(4)} (${worst}), ${bad} px off, ${partial} partial px`);
    return { partial, maxErr, bad };
  }

  // ---------------- warm-up: compile and draw everything once (gate off), then baseline
  const stepRaw = (l, x) => (l === 0 ? (x < DW / 2 ? M.metresToRaw(1.0, near, Infinity) : 1) : M.metresToRaw(2.0, near, Infinity));
  const dataTex = makeDataTex(stepRaw);
  occ.setTestDepth(dataTex.tex); occ.update(); occ.update(); // live once so the Data texture is uploaded in the warm-up
  renderer.setRenderTarget(rt); renderer.clear();
  renderer.render(lit, litCam);
  for (const m of [matOpaque, matTransp, shaderMat]) { setPlane(1.5, m); renderEyes(); }
  occ.setTestDepth(null); occ.update();
  renderer.setRenderTarget(rt); renderer.render(lit, litCam); renderer.setRenderTarget(null);
  const programs0 = renderer.info.programs.length, textures0 = renderer.info.memory.textures;

  check('patched shaders compile and link (no shader errors)', shaderErrors.length === 0, shaderErrors.join(' || ') || `${programs0} programs`);
  const progs = renderer.info.programs;
  const runnable = progs.every((p) => !p.diagnostics || p.diagnostics.runnable);
  check('every program runnable', runnable, progs.map((p) => p.name).join(', '));
  const fsSrc = progs.map((p) => gl.getShaderSource(p.fragmentShader) || '');
  const vsSrc = progs.map((p) => gl.getShaderSource(p.vertexShader) || '');
  const withOcc = fsSrc.filter((s) => s.includes('float occVisibility()')).length;
  // standard, skinned standard, instanced standard, instanced basic, physical, hooked, basic opaque, basic transparent, shader material
  check('soft occlusion compiled into each patched variant', withOcc >= 8, `${withOcc} of ${progs.length} programs`);
  const hookedIdx = vsSrc.findIndex((s) => s.includes('uniform mat4 uPart[5];'));
  check('chained hook: one program has both the part hook and the occlusion code', hookedIdx >= 0 && fsSrc[hookedIdx].includes('occVisibility') && vsSrc[hookedIdx].includes('vOccViewZ = - mvPosition.z;'));
  check('skinned + instanced variants patched', vsSrc.some((s) => s.includes('USE_SKINNING') && s.includes('vOccViewZ')) && vsSrc.some((s) => s.includes('USE_INSTANCING_COLOR') && s.includes('vOccViewZ')));
  check('unpatched material compiled without the occlusion code', fsSrc.some((s) => !s.includes('occVisibility') && s.includes('#define STANDARD')));

  // ---------------- pixel checks
  // Gate off: plane fully drawn
  run('gate off: everything visible', { ...BASE, on: false }, dataTex.tex, stepRaw);
  // Eye/layer selection: layer 0 has a wall at 1 m on its left half, layer 1 a wall at 2 m; plane at 1.5 m
  const sel = reference(BASE, stepRaw);
  run('nearest fade: eye 0 hidden left / visible right, eye 1 visible (layer = eye)', BASE, dataTex.tex, stepRaw);
  renderEyes();
  const a = (x, y) => buf[(y * 2 * W + x) * 4 + 3];
  check('eye selection at the viewport split', a(2, 16) === 0 && a(W - 3, 16) === 255 && a(W + 2, 16) === 255 && a(2 * W - 3, 16) === 255 && sel[16 * 2 * W + 2] === 0,
    `eye0 left ${a(2, 16)}, eye0 right ${a(W - 3, 16)}, eye1 left ${a(W + 2, 16)}, eye1 right ${a(2 * W - 3, 16)}`);
  const hardEdge = run('nearest: hard edge (no partial pixels without a band overlap)', BASE, dataTex.tex, stepRaw);
  const softEdge = run('4-tap PCF: soft edge across the depth texel', { ...BASE, pcf: true }, dataTex.tex, stepRaw);
  check('PCF softens the stair step', hardEdge.partial === 0 && softEdge.partial >= 2 * H, `partial px: nearest ${hardEdge.partial}, pcf ${softEdge.partial}`);

  // Fade band: fragment 2 cm behind a 1.0 m surface → 15.6 %
  const flat = (z) => () => M.metresToRaw(z, near, Infinity);
  setData(dataTex, flat(1.0));
  run('fade band: 2 cm behind the surface = 0.156', { ...BASE, zf: 1.02 }, dataTex.tex, flat(1.0));
  run('fade band: 2 cm in front = 0.844', { ...BASE, zf: 0.98 }, dataTex.tex, flat(1.0));
  run('bias 0.05 lifts a decal on the wall to fully visible', { ...BASE, zf: 1.0, bias: 0.05 }, dataTex.tex, flat(1.0));

  // Noisy depth field: many partial values, all modes
  const rnd = LCG(7);
  const noise = new Float32Array(DW * DH * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = M.metresToRaw(1.2 + 0.6 * rnd(), near, Infinity);
  noise[3] = 1; noise[DW * DH + 5] = 0; noise[20] = 0; // nothing seen, and raw-0 texels
  const noiseRaw = (l, x, y) => noise[(l * DH + y) * DW + x];
  setData(dataTex, noiseRaw);
  const wide = { ...BASE, band: 0.3 };
  run('noise, nearest fade', wide, dataTex.tex, noiseRaw);
  run('noise, PCF fade', { ...wide, pcf: true }, dataTex.tex, noiseRaw);
  run('noise, PCF dither', { ...wide, pcf: true, dither: true }, dataTex.tex, noiseRaw);
  run('noise, nearest dither', { ...wide, dither: true }, dataTex.tex, noiseRaw);
  run('noise, band growth 0.1 m/m + bias', { ...wide, pcf: true, growth: 0.1, bias: 0.03 }, dataTex.tex, noiseRaw);
  run('noise, raw 0 treated as no data', { ...wide, pcf: true, noData: 0 }, dataTex.tex, noiseRaw);
  run('transparent MeshBasic: alpha = opacity · vis', { ...wide, pcf: true }, dataTex.tex, noiseRaw, matTransp, 0.5, 3);
  run('transparent MeshBasic: colour = opacity · vis (straight alpha blend)', { ...wide, pcf: true }, dataTex.tex, noiseRaw, matTransp, 0.5, 0);
  run('opaque: colour premultiplied by vis', { ...wide, pcf: true }, dataTex.tex, noiseRaw, matOpaque, 1, 0);
  run('ShaderMaterial (premultiplied) with the chunks', { ...wide, pcf: true }, dataTex.tex, noiseRaw, shaderMat, 0.6, 3);

  // Finite far plane
  const finRaw = (l, x, y) => M.metresToRaw(1.2 + 0.04 * x + 0.03 * y + 0.2 * l, near, 20);
  setData(dataTex, finRaw);
  run('finite far (20 m) linearisation', { ...wide, far: 20, pcf: true }, dataTex.tex, finRaw);

  // three's ExternalTexture path (what renderer.xr.getDepthTexture() returns)
  const extRaw = (l, x, y) => Math.fround(M.metresToRaw(1.1 + 0.05 * x + 0.04 * y + 0.15 * l, near, Infinity));
  const ext = makeExternalR32F(extRaw);
  run('ExternalTexture R32F array (IWER-like), PCF', { ...wide, pcf: true }, ext, extRaw);
  run('ExternalTexture R32F array, nearest', wide, ext, extRaw);
  const d16 = makeExternalDepth16();
  check('DEPTH_COMPONENT16 texture array set up', d16.ok, d16.info);
  if (d16.ok) {
    run('ExternalTexture DEPTH_COMPONENT16 array (Quest-like unsigned-short), PCF', { ...wide, zf: 1.4, pcf: true }, d16.tex, d16.raw);
    run('ExternalTexture DEPTH_COMPONENT16 array, nearest', { ...wide, zf: 1.4 }, d16.tex, d16.raw);
  }

  // ---------------- nothing compiled or uploaded after the warm-up
  occ.setTestDepth(null); occ.update();
  renderer.setRenderTarget(rt); renderer.render(lit, litCam); renderer.setRenderTarget(null);
  check('programs flat after the warm-up across every mode switch', renderer.info.programs.length === programs0, `${programs0} → ${renderer.info.programs.length}`);
  check('textures flat (the external depth is never uploaded by three)', renderer.info.memory.textures === textures0, `${textures0} → ${renderer.info.memory.textures}`);
  check('GL error state clean', gl.getError() === gl.NO_ERROR);
  occ.disable();
  return { checks: out };
}
