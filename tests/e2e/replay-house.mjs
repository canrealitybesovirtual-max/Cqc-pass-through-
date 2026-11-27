// Desktop replay of the user's real house (the v0.4 headset session, tests/fixtures/house-v04-device.json:
// the Space Setup snapshot v2 with its planes, volumes and the encoded global mesh, exactly as recorded on
// the Quest) in headless Chromium, through the real World (worker-free synchronous build with the mesh, the
// same layout, slabs, mesh occluder and door curtains the headset draws).
//
//   NODE_PATH=$(npm root -g) node tests/e2e/replay-house.mjs [--shots <dir>]    exit 0 = all checks passed
//
// What it checks (v0.4.1, the user's "I can see them through my walls"):
// - occlusion sweep: from every viewpoint the player used (the recorded start in the bedroom, and a grid over
//   the rooms the record says they walked: bedroom, hall, living room), eye at floor + 1.55 m, four 90° views,
//   an enemy-sized capsule (r 0.22 m, 1.80 m) on every place an enemy can stand (the nav grid every 0.6 m, every
//   spawn candidate, the six recorded spawns). Each capsule writes one bit with additive blending and no depth
//   write, so capsules never hide each other; the box occluder, the mesh occluder and the door curtains write
//   depth as in the headset. Ground truth, independent of the game's own boxes: a capsule is "behind real
//   walls" when every one of 15 sight lines (5 heights × 3 across) crosses a real Space Setup wall plane outside
//   its door openings (corners joined); it is "in unscanned space" when it stands behind the real walls (the
//   first real wall plane hit in most of 8 directions is seen from its back) or on a door pocket. Either way
//   it must draw ZERO pixels. Capsules in plain view must draw (the sweep sees what it should).
// - the spawn rules on this house: no spawn candidate in unscanned space, every candidate stands where an
//   enemy walks in through a real open door, and the recorded spawn rooms that were unscanned are refused.
// - enemy height: soldiers are scaled to 1.70–1.85 m and stand on the floor plane under them (feet within
//   1 cm of the floor, head at the drawn height, hit capsules scaled with the body).
// With --shots: PNGs of the real soldier from the recorded viewpoints (with and without the occluders).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);

/**
 * Run the replay checks in an existing browser (emulate.mjs calls this), or standalone.
 * @param {any} browser playwright Browser
 * @param {number} port
 * @param {{ shots?: string|null }} [o]
 * @returns {Promise<{ name: string, pass: boolean, info: string }[]>}
 */
export async function runHouseReplay(browser, port, o = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.route('**/__replay-house.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta charset="utf-8"><script type="importmap">{ "imports": { "three": "/vendor/three/three.module.js", "three/addons/": "/vendor/three/addons/" } }</script></head><body style="margin:0;background:#000"></body></html>',
  }));
  /** @type {{ name: string, pass: boolean, info: string }[]} */
  const out = [];
  try {
    await page.goto(`http://localhost:${port}/__replay-house.html`);
    const res = await page.evaluate(replayInPage, { shots: !!o.shots });
    for (const c of res.checks) out.push(c);
    if (o.shots && res.shots) {
      mkdirSync(o.shots, { recursive: true });
      for (const s of res.shots) writeFileSync(`${o.shots}/${s.name}.png`, Buffer.from(s.png.split(',')[1], 'base64'));
      writeFileSync(`${o.shots}/sweep.json`, JSON.stringify(res.sweep, null, 1));
    }
  } catch (e) {
    out.push({ name: 'replay: page run', pass: false, info: String(e && /** @type {any} */ (e).stack || e).slice(0, 800) });
  } finally {
    out.push({ name: 'replay: no console errors', pass: errors.length === 0, info: errors.slice(0, 3).join(' | ') });
    await page.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs inside the page.
async function replayInPage(opts) {
  const THREE = await import('three');
  const { World, hydrateSnapshot, normalizeSnapshot } = await import('/src/world/World.js');
  const { NAV_WALK, NAV_POCKET, NAV_VIRTUAL } = await import('/src/world/NavGrid.js');
  /** @type {{ name: string, pass: boolean, info: string }[]} */
  const checks = [];
  const check = (name, pass, info = '') => checks.push({ name: `replay: ${name}`, pass: !!pass, info: String(info) });

  const json = await (await fetch('/tests/fixtures/house-v04-device.json')).json();
  const snap = await hydrateSnapshot(normalizeSnapshot(json));
  // the recorded session: Roam, unbounded, start in the bedroom (play.world.zone), spawns (play.world.report.spawn.recent)
  const START = { x: -0.2256, z: 0.0093 };
  const SPAWNS = [[4.58, 10.9], [0.38, 6.5], [6.38, 1.5], [-1.22, 3], [-1.22, 4.5], [-1.22, 6.5]];
  const world = new World({ roam: true });
  world.build(snap, START, { roam: true, mesh: true });
  world.finishBake();
  const L = world.layout, nav = world.nav;
  check('the house builds from the recorded snapshot with its global mesh', world.built && world.meshTrisDrawn > 20000 && L.walls.length === 20,
    `walls ${L.walls.length}, mesh tris ${world.meshTrisDrawn}`);

  // ── ground truth (Space Setup wall planes, not the game's slabs) ──
  const real = L.walls.filter((w) => !w.inferred);
  // a wall end that meets another wall's end (within 15 cm) is extended 6 cm: corners are solid
  const ext = real.map((w) => {
    let e0 = 0, e1 = 0;
    for (const v of real) {
      if (v === w) continue;
      for (const [px, pz] of [[v.ax, v.az], [v.bx, v.bz]]) {
        if (Math.hypot(px - w.ax, pz - w.az) < 0.15) e0 = 0.06;
        if (Math.hypot(px - w.bx, pz - w.bz) < 0.15) e1 = 0.06;
      }
      // a T-junction: this end lies on the other wall's face
      const u0 = (w.ax - v.ax) * v.tx + (w.az - v.az) * v.tz, d0 = (w.ax - v.ax) * v.nx + (w.az - v.az) * v.nz;
      if (u0 > -0.05 && u0 < v.len + 0.05 && Math.abs(d0) < 0.15) e0 = 0.06;
      const u1 = (w.bx - v.ax) * v.tx + (w.bz - v.az) * v.tz, d1 = (w.bx - v.ax) * v.nx + (w.bz - v.az) * v.nz;
      if (u1 > -0.05 && u1 < v.len + 0.05 && Math.abs(d1) < 0.15) e1 = 0.06;
    }
    return { e0, e1 };
  });
  // does the segment eye → p cross real wall k's plane rectangle outside its openings (3 cm margin at opening edges)?
  const crossesWall = (k, ex, ey, ez, px, py, pz) => {
    const w = real[k];
    const da = (ex - w.ax) * w.nx + (ez - w.az) * w.nz, db = (px - w.ax) * w.nx + (pz - w.az) * w.nz;
    if ((da > 0) === (db > 0) || da === db) return false;
    const t = da / (da - db);
    const x = ex + (px - ex) * t, y = ey + (py - ey) * t, z = ez + (pz - ez) * t;
    const u = (x - w.ax) * w.tx + (z - w.az) * w.tz;
    if (u < -ext[k].e0 || u > w.len + ext[k].e1 || y < w.y0 - 0.02 || y > w.y1 + 0.02) return false;
    for (const op of w.openings) if (u > op.u0 - 0.03 && u < op.u1 + 0.03 && y > op.y0 - 0.03 && y < op.y1 + 0.03) return false;
    return true;
  };
  const blockedByWalls = (ex, ey, ez, px, py, pz) => { for (let k = 0; k < real.length; k++) if (crossesWall(k, ex, ey, ez, px, py, pz)) return true; return false; };
  const HS = [0.15, 0.5, 0.9, 1.3, 1.7];
  const behindWalls = (ex, ey, ez, x, z, fy) => {
    const d = Math.hypot(x - ex, z - ez) || 1, ax = -(z - ez) / d, az = (x - ex) / d;
    for (const h of HS) for (const s of [-0.22, 0, 0.22]) if (!blockedByWalls(ex, ey, ez, x + ax * s, fy + h, z + az * s)) return false;
    return true;
  };
  // unscanned: on a pocket / virtual floor, or behind the real walls (first real wall hit from its back in most directions)
  const firstWallSide = (x, z, dx, dz) => {
    let best = Infinity, side = 0;
    for (const w of real) {
      const qx = w.bx - w.ax, qz = w.bz - w.az, den = dx * qz - dz * qx;
      if (Math.abs(den) < 1e-9) continue;
      const wx = w.ax - x, wz = w.az - z, t = (wx * qz - wz * qx) / den, u = (wx * dz - wz * dx) / den;
      if (t <= 0 || u < 0 || u > 1 || t >= best) continue;
      best = t;
      side = (x - w.ax) * w.nx + (z - w.az) * w.nz > 0 ? 1 : -1;
    }
    return side;
  };
  const unscanned = (x, z) => {
    const i = nav.index(x, z);
    if (i >= 0 && (nav.flags[i] & (NAV_POCKET | NAV_VIRTUAL)) !== 0) return true;
    let front = 0, back = 0;
    for (let k = 0; k < 8; k++) {
      const s = firstWallSide(x, z, Math.cos(k * Math.PI / 4 + 0.1), Math.sin(k * Math.PI / 4 + 0.1));
      if (s > 0) front++; else if (s < 0) back++;
    }
    return back > front;
  };
  const nearDoor = (x, z) => L.doors.some((d) => Math.abs((x - d.cx) * d.tx + (z - d.cz) * d.tz) < d.width / 2 + 0.3 && Math.abs((x - d.cx) * d.nx + (z - d.cz) * d.nz) < 0.6);

  // ── where enemies can stand ──
  /** @type {{ x: number, z: number, kind: string }[]} */
  const P = [];
  const step = Math.max(1, Math.round(0.6 / nav.cell));
  for (let iz = 0; iz < nav.h; iz += step) {
    for (let ix = 0; ix < nav.w; ix += step) {
      const i = iz * nav.w + ix;
      if ((nav.flags[i] & NAV_WALK) !== 0) P.push({ x: nav.centerX(i), z: nav.centerZ(i), kind: 'nav' });
    }
  }
  for (let k = 0; k < world.spawner.count; k++) P.push({ x: world.spawner.x[k], z: world.spawner.z[k], kind: 'candidate' });
  for (const [x, z] of SPAWNS) P.push({ x, z, kind: 'recorded' });
  for (const p of P) { p.fy = world.floorY(p.x, p.z); p.unscanned = unscanned(p.x, p.z) && !nearDoor(p.x, p.z); }

  // ── the player's viewpoints: the recorded start, and a grid over the rooms walked (bedroom, hall, living room) ──
  const anchors = [[START.x, START.z], [1.19, 1.73], [3.44, 7.96]];
  const rooms = new Set(anchors.map(([x, z]) => world.roomAt(x, z)).filter((r) => r > 0));
  /** @type {{ x: number, z: number, y: number }[]} */
  const views = [{ x: START.x, z: START.z, y: world.floorY(START.x, START.z) + 1.55 }];
  const vs = Math.round(1.4 / nav.cell);
  for (let iz = 0; iz < nav.h; iz += vs) {
    for (let ix = 0; ix < nav.w; ix += vs) {
      const i = iz * nav.w + ix;
      if (!rooms.has(nav.room[i]) || (nav.flags[i] & NAV_WALK) === 0) continue;
      const x = nav.centerX(i), z = nav.centerZ(i);
      views.push({ x, z, y: world.floorY(x, z) + 1.55 });
    }
  }

  // ── renderer ──
  const S = 192;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  const rt = new THREE.WebGLRenderTarget(S, S, { depthBuffer: true });
  const scene = new THREE.Scene();
  for (const m of world.warmMeshes()) { m.updateMatrix(); scene.add(m); }
  // 92° faces overlap their neighbours, and the outer EDGE pixels of each face are not counted: a one-pixel
  // rasterisation crack at the frustum's side planes (SwiftShader) is not a hole in the occluders
  const cam = new THREE.PerspectiveCamera(92, 1, 0.02, 50); // the play near plane (0.02 m) and far (50 m)
  const EDGE = 2;
  const capGeo = new THREE.CapsuleGeometry(0.22, 1.36, 4, 10);
  const BITS = 24;
  const proxies = [];
  for (let b = 0; b < BITS; b++) {
    const ch = b >> 3, v = (1 << (b & 7)) / 255;
    const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false });
    mat.color.setRGB(ch === 0 ? v : 0, ch === 1 ? v : 0, ch === 2 ? v : 0, THREE.LinearSRGBColorSpace);
    const m = new THREE.Mesh(capGeo, mat);
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
    proxies.push(m);
  }
  const px = new Uint8Array(S * S * 4);
  const counts = new Uint32Array(BITS);
  // ── the sweep ──
  const leaks = [];
  let hiddenPairs = 0, unscannedPairs = 0, visibleDrawn = 0, visiblePairs = 0;
  for (let vi = 0; vi < views.length; vi++) {
    const V = views[vi];
    // the batch's truth first: only capsules 3.5 m+ away (spawns never come closer) or anything hidden
    const list = [];
    for (const p of P) {
      const d = Math.hypot(p.x - V.x, p.z - V.z);
      if (d < 0.6) continue;
      const hidden = behindWalls(V.x, V.y, V.z, p.x, p.z, p.fy);
      list.push({ p, hidden, d });
    }
    const pix = new Uint32Array(list.length);
    for (let b0 = 0; b0 < list.length; b0 += BITS) {
      const n = Math.min(BITS, list.length - b0);
      for (let b = 0; b < BITS; b++) {
        proxies[b].visible = b < n;
        if (b < n) { const p = list[b0 + b].p; proxies[b].position.set(p.x, p.fy + 0.9, p.z); }
      }
      for (let f = 0; f < 4; f++) {
        cam.position.set(V.x, V.y, V.z);
        cam.rotation.set(0, f * Math.PI / 2, 0);
        cam.updateMatrixWorld();
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(scene, cam);
        renderer.readRenderTargetPixels(rt, 0, 0, S, S, px);
        counts.fill(0);
        for (let i = 0; i < S * S; i++) {
          const ix = i % S, iy = (i - ix) / S;
          if (ix < EDGE || iy < EDGE || ix >= S - EDGE || iy >= S - EDGE) continue;
          const o = i * 4, bits = px[o] | (px[o + 1] << 8) | (px[o + 2] << 16);
          if (bits === 0) continue;
          for (let b = 0; b < n; b++) if (bits & (1 << b)) counts[b]++;
        }
        for (let b = 0; b < n; b++) pix[b0 + b] += counts[b];
      }
    }
    for (let k = 0; k < list.length; k++) {
      const { p, hidden, d } = list[k];
      if (hidden || p.unscanned) {
        if (hidden) hiddenPairs++; else unscannedPairs++;
        if (pix[k] > 0) leaks.push({ view: [+V.x.toFixed(2), +V.z.toFixed(2)], at: [+p.x.toFixed(2), +p.z.toFixed(2)], kind: p.kind, why: hidden ? 'wall' : 'unscanned', px: pix[k], d: +d.toFixed(1) });
      } else if (d > 1.5 && world.roomAt(p.x, p.z) === world.roomAt(V.x, V.z) && world.roomAt(p.x, p.z) > 0) {
        visiblePairs++;
        if (pix[k] > 0) visibleDrawn++;
      }
    }
  }
  for (const m of proxies) m.visible = false;
  const wallLeaks = leaks.filter((l) => l.why === 'wall'), unscannedLeaks = leaks.filter((l) => l.why === 'unscanned');
  const sum = (a) => a.reduce((s, l) => s + l.px, 0);
  const worst = (a) => a.slice().sort((x, y) => y.px - x.px).slice(0, 4).map((l) => `${l.kind} (${l.at}) from (${l.view}) ${l.px} px`).join('; ');
  check(`no enemy pixels through real walls (${views.length} viewpoints × ${P.length} places, ${hiddenPairs} hidden pairs)`, wallLeaks.length === 0,
    `${wallLeaks.length} leaks, ${sum(wallLeaks)} px: ${worst(wallLeaks)}`);
  check(`no enemy pixels in unscanned space beyond the walls or doors (${unscannedPairs} pairs)`, unscannedLeaks.length === 0,
    `${unscannedLeaks.length} leaks, ${sum(unscannedLeaks)} px: ${worst(unscannedLeaks)}`);
  check('the sweep sees enemies in plain view (same room, ≥ 1.5 m)', visiblePairs > 50 && visibleDrawn >= 0.95 * visiblePairs, `${visibleDrawn}/${visiblePairs}`);

  // ── spawns on this house ──
  let badCand = 0;
  for (let k = 0; k < world.spawner.count; k++) if (unscanned(world.spawner.x[k], world.spawner.z[k]) && !world.spawner.pocket[k]) badCand++;
  check('no spawn candidate in unscanned space (pockets behind doors excepted)', badCand === 0 && world.spawner.count > 0, `${badCand} of ${world.spawner.count}`);
  const sweep = { views: views.length, places: P.length, hiddenPairs, unscannedPairs, wallLeaks: wallLeaks.length, wallLeakPx: sum(wallLeaks),
    unscannedLeaks: unscannedLeaks.length, unscannedLeakPx: sum(unscannedLeaks), visiblePairs, visibleDrawn,
    leaks: wallLeaks.concat(unscannedLeaks.slice().sort((x, y) => y.px - x.px).slice(0, 200)),
    recordedSpawns: SPAWNS.map(([x, z]) => ({ x, z, room: world.roomAt(x, z), unscanned: unscanned(x, z) })), notes: L.notes };

  // ── the real soldier: height and feet on the floor (always), screenshots (--shots) ──
  /** @type {{ name: string, png: string }[]} */
  const shots = [];
  const { Assets } = await import('/src/core/Assets.js');
  const { EnemyManager, ENEMY } = await import('/src/enemies/EnemyManager.js');
  const vr = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  vr.setSize(640, 480);
  vr.outputColorSpace = THREE.SRGBColorSpace;
  const assets = await new Assets({ renderer: vr, base: '/assets/' }).load();
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x30343a);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2), new THREE.DirectionalLight(0xffffff, 1.5));
  for (const m of world.warmMeshes()) sc.add(m);
  const enemies = new EnemyManager(assets, sc, 6, { world, seed: 7 });
  {
    const fails = [];
    const spots = [[3.2, 6.0], [4.4, 6.6], [5.6, 6.0], [3.0, 9.0], [START.x, START.z + 0.6], [2.2, 1.0]];
    for (let r = 0; r < 3; r++) {
      enemies.reset();
      for (const [x, z] of spots) enemies.spawn(x, z, 0.3);
      enemies.update(1 / 72, 0, null, null);
      for (let i = 0; i < spots.length; i++) {
        const rig = enemies.pool.rigs[i];
        rig.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(rig.mesh, true); // the skinned vertices as drawn
        const ag = enemies.brain.agents[i], fy = world.floorY(ag.x, ag.z), h = enemies.height ? enemies.height[i] : enemies.def.height; // where he stands (snapped off the bed)
        const low = box.min.y - fy, top = box.max.y - fy;
        if (!(h >= (ENEMY.heightMin || 1.7) && h <= (ENEMY.heightMax || 1.85)) || Math.abs(low) > 0.02 || top > h + 0.01 || top < h - 0.08) {
          fails.push(`(${ag.x.toFixed(2)}, ${ag.z.toFixed(2)}) height ${h.toFixed(3)}: drawn ${low.toFixed(3)}…${top.toFixed(3)} m over the floor ${fy.toFixed(3)}`);
        }
        const hb = enemies.hitboxes[i];
        if (!(Math.abs(hb.k - h / enemies.def.height) < 1e-5)) fails.push(`hit capsules not scaled (${hb.k})`);
      }
    }
    check(`soldiers ${ENEMY.heightMin || 1.7}–${ENEMY.heightMax || 1.85} m, feet on the floor plane under them (bedroom −1.518 from its scan, living room −1.510)`, fails.length === 0, fails.slice(0, 3).join('; '));
    enemies.reset();
  }
  if (opts.shots) {
    // the passthrough stand-in: the occluder's walls drawn faint grey where they are visible (depth-tested),
    // the door curtains faint violet; enemies hidden by them are hidden in the headset too
    const occGeo = world.occluder.geometry;
    const part = (start, count, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', occGeo.attributes.position);
      g.setIndex(occGeo.index);
      g.setDrawRange(start, count);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: true }));
      m.renderOrder = 50;
      m.frustumCulled = false;
      sc.add(m);
      return m;
    };
    part(0, world.occluderBoxes * 36, 0x8a9098, 0.22);
    if (world.curtainBoxes) part(world.occluderBoxes * 36, world.curtainBoxes * 36, 0xa070ff, 0.28);
    const vc = new THREE.PerspectiveCamera(90, 4 / 3, 0.02, 50);
    const shot = (name, eye, at) => {
      vc.position.set(eye[0], eye[1], eye[2]);
      vc.lookAt(at[0], at[1], at[2]);
      vc.updateMatrixWorld();
      world.overlay.visible = false;
      vr.render(sc, vc);
      shots.push({ name, png: vr.domElement.toDataURL('image/png') });
    };
    const fy = (x, z) => world.floorY(x, z);
    // the recorded spawns behind the living room's doors, seen from the living room
    const living = [3.0, fy(3.0, 5.6) + 1.55, 5.6];
    for (const [x, z] of [[-1.22, 3], [-1.22, 4.5], [-1.22, 6.5]]) enemies.spawn(x, z, Math.PI / 2);
    enemies.update(1 / 72, 0, null, null);
    shot('1-living-room-to-recorded-spawns-behind-the-doors', living, [-1.22, fy(-1.22, 4.5) + 1.0, 4.5]);
    enemies.reset();
    // one enemy half through the double door (in the doorway), from the living room
    const d5 = world.layout.doors[5];
    enemies.spawn(d5.cx - d5.nx * 0.05 * Math.sign(d5.nx), d5.cz, Math.PI / 2);
    enemies.update(1 / 72, 0, null, null);
    shot('2-living-room-enemy-in-the-doorway', living, [d5.cx, fy(d5.cx, d5.cz) + 1.0, d5.cz]);
    enemies.reset();
    // the closed corner behind two living room walls, and the living room from the bedroom start
    enemies.spawn(4.58, 10.9, Math.PI);
    enemies.spawn(6.38, 1.5, -Math.PI / 2);
    enemies.update(1 / 72, 0, null, null);
    shot('3-bedroom-start-toward-living-room', [START.x, fy(START.x, START.z) + 1.55, START.z], [4.58, fy(4.58, 10.9) + 1.0, 10.9]);
    shot('4-living-room-toward-closed-corner', [4.5, fy(4.5, 5.0) + 1.55, 5.0], [6.38, fy(6.38, 1.5) + 1.0, 1.5]);
    enemies.reset();
    // a wall corner seen obliquely with an enemy right behind it (the corner hole of v0.4)
    enemies.spawn(-0.12, 2.45, 0);
    enemies.update(1 / 72, 0, null, null);
    shot('5-living-room-corner-toward-hall', [2.98, fy(2.98, 5.8) + 1.55, 5.8], [-0.12, fy(-0.12, 2.45) + 1.0, 2.45]);
    enemies.reset();
    // sanity: soldiers in the open in the living room (drawn, heights)
    enemies.spawn(4.0, 6.0, -Math.PI / 2);
    enemies.spawn(4.6, 7.2, -Math.PI / 2);
    enemies.spawn(4.2, 8.4, -Math.PI / 2);
    enemies.update(1 / 72, 0, null, null);
    shot('6-living-room-open-view', [1.9, fy(1.9, 6.0) + 1.55, 6.0], [4.2, fy(4.0, 6.0) + 1.0, 7.0]);
    enemies.reset();
  }
  vr.dispose();
  renderer.dispose();
  return { checks, sweep, shots };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() || '')) {
  const { chromium } = require('playwright');
  const i = process.argv.indexOf('--shots');
  const shots = i > 0 ? process.argv[i + 1] : null;
  const server = await serve(0);
  const port = /** @type {any} */ (server.address()).port;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let checks = [];
  try { checks = await runHouseReplay(browser, port, { shots }); } finally { await browser.close(); server.close(); }
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? `  (${c.info})` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
