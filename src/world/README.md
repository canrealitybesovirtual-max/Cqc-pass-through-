# src/world: the Space Setup house as a game world

Owner: builder S. Everything here is pure (no three.js, no DOM) except `World.js`, so it runs in Node tests and in the world worker. Statuses follow FEATURES.md. Everything below is **desktop-tested** (Node 22, headless Chromium 153 with a real module worker for the protocol); none of it is device-verified.

## What v0.4 adds (snapshot v2, the worker build, the global mesh)

| File | What it does |
|---|---|
| `Snapshot.js` | **v2.** `captureSnapshot` also copies every XRMesh's `vertices` / `indices` / `semanticLabel` / pose once (one memcpy each, behind the panel) into the non-enumerable `snap.raw`. That data is never in JSON, never structured-cloned and never in Copy. `snap.globalMesh` describes the global mesh. `normalizeSnapshot` accepts v1 and v2 and keeps `raw`. `hydrateSnapshot` decodes a recorded mesh back into `raw` (async). `snapshotForCopy` drops the blob. `loadFixture` hydrates. |
| `MeshCodec.js` | The record's encoding: `cqc-mesh-1` at a 2 mm quantum, with per-axis delta zigzag varints. It is then gzipped (CompressionStream), base64-encoded and given an FNV-1a hash. |
| `MeshPrep.js` | Prepares the raw global mesh in 6 steps: (1) weld and drop degenerate triangles; (2) **orient** it (normals toward free space: consistent winding per component, then floor/ceiling/wall/furniture votes); (3) classify triangles as SOFT, HARD, FLOOR, WALL, CEIL or OTHER; (4) crop floors, ceilings, wall faces and open door openings; (5) find which furniture the mesh covers; (6) cut it into tiles. Also provides `occluderPositions` (1 cm inward on hard surfaces) and `colliderPositions` (soft tops 1.5 cm lower). |
| `MeshBVH.js` | A flat typed-array BVH (binned SAH, ≤ 4 triangles per leaf, triangle soup in leaf order). `raycast` and `segmentClear` hit both faces and allocate nothing. `toBuffers` / `fromBuffers` transfer it without copying. |
| `WorldStatics.js` | Static collider geometry for physics (role P): see below. |
| `ScanSynth.js` | A synthetic global mesh made from a snapshot's own layout. Used by the tests, the warm-up and the fixture. |
| `WorldState.js` | Exports a built core as typed arrays plus a small `meta`. `CopyJob` copies it into the main world's preallocated arrays in time slices; `commitScalars` then switches the world over in one step. |
| `WorldBuild.js` | The worker's job: the build, the whole Roam bake, mesh prep, BVH, occluder buffers, statics, and the gzip record. It also holds the in-order message loop. |
| `world.worker.js` | The module worker shim. |
| `WorldWorker.js` | The main side: `createWorldBuilder(world.config)` returns a module worker, or `InlineBuilder` (the same job in-process, with structuredClone transfers) when a page has no `Worker`. |
| `World.js` | Adds `meshOccluder`, a second depth-only mesh that shares the occluder's material, so no new program. It has preallocated buffers (98,304 vertices, 131,072 triangles, Uint32), takes nearest tiles first, and writes by ranges (`addUpdateRange`). Once the mesh is complete, the box occluder drops the furniture the mesh covers. |
| `tests/fixtures/house.json` | Now v2, with a synthetic global mesh: 10,932 triangles, 7.6 KB base64. Regenerate it with `node tests/fixtures/make-house-mesh.mjs`. |

## Wiring for integration (builder I)

These are not wired yet: Play.js still calls the synchronous `world.build`. Until that changes, the synchronous path leaves meshes over `SYNC_MESH_MAX_TRIS` (20,000) to the worker and builds those houses with planes and boxes only, with a note. This means a real 36k-triangle capture never stalls the frame loop. The fixture (11k triangles) still goes through the synchronous path in `?emulate`, taking about 80 ms behind the card.

1. **At load** (PlayKit, after `world.warmUp()`):
    ```js
    world.attachBuilder(createWorldBuilder(world.config));
    ```
    The worker warms its own JIT, which takes about 150 ms in Chromium. `builder.ready` and `builder.warmMs` are available for the record.
2. **Capture → build:** replace `world.build(snap, start, { roam })` with:
    ```js
    world.buildAsync(snap, start, { roam })
    ```
    It returns a Promise that resolves to true when everything is in place. Keep calling `world.update(dt, t, frame, ctx)` every frame: it applies the result within `applyBudgetMs` (0.5 ms) a frame. Until the commit every query answers from the previous world; after it, the occluder tiles stream in, one range a frame. Move to STEP.WARM once the promise has resolved and `!world.busy`; the card is already up for at least 1 s.
3. **Realign:** `world.realignAsync(m)` or `world.realignAsync(null, freshSnapshot)` behind the held pause, then REWARM once it resolves.
4. **Mode switch, spot rebuild, door flags:** `world.buildAsync(world.snapshot, start, { doors, roam, force: true })`, or `world.rebuildAsync()`.
5. **Session record:** `rec.spaceSnapshot = snap` as today. After a worker build, `snap.globalMesh` gains the encoded mesh (`data`, 40–90 KB of base64 for a real scan; 81 KB for the 119k-triangle test house). **Copy must use `snapshotForCopy(rec.spaceSnapshot)`**. Download and Share keep everything.
6. **Replay** (`?emulate&snapshot=` / `&replay`): `normalizeSnapshot(json)` keeps `globalMesh.data`, and the worker decodes it. For a synchronous build, `await hydrateSnapshot(snap)` first.
7. **Warm-up lists:** `world.warmMeshes()` is now `[occluder, meshOccluder, overlay]`. PlayKit already adds and draws them all. A play frame gains one draw call per view (e2e: 38 for both eyes, previously 36).
8. **`rec.play.world`:** `world.report()` gains:
    - `mesh` (tris, kept, cropped, classes, upVotePct, oneSided, covered, tiles, prepMs, bvhMs);
    - `statics`;
    - `worker` (builds, ms, applyFrames, applyMaxMs, phaseMs);
    - `meshOccluder` (tiles uploaded, dropped).

   `world.memoryBytes()` gains bvh, tiles and statics.
9. Bump `src/version.js`, and add the DECISIONS rows (the snapshot v2 record, the world worker, the mesh occluder, the BVH in bullets and sight lines).

## Queries (the main thread; allocation-free)

- `world.raycast(...)` and `world.segmentClear(...)` test the shape set (walls, uncovered furniture, floors and ceilings) **plus the BVH**, nearest wins. Boxes of covered furniture are skipped for rays and sight lines (`ShapeSet.rayCount`; they are stored last), so a shot or a sight line passes under a real table.
- `out.surface` is the owning furniture's label (`'bed'`, `'table'`, …), else `'other'` (unlabelled clutter). The nav grid and the safety cues keep every box.
- `world.surfaceBelow(x, y, z, maxDown, out)` gives the surface under a point: `{ y, nx, ny, nz, surface, dist }`. It is for contact shadows, brass and drop sounds.
- `world.bvh` (MeshBVH or null) and `world.meshLabel(tri)` are there for direct use. A query costs about 1–3 µs (2.8 µs for boxes plus a 119k-triangle BVH, desktop).

## Static colliders for physics (builder P)

`world.staticGeometry()` returns the same object until the next build. It returns null before a build. `src/physics/StaticGeometry.js` `staticFromWorld` already prefers it.

```
{ version: 1, source: 'world',
  slabs (10 floats each: cx, cy, cz, hx, hy, hz, qy, qw, surf, role), slabCount,
  prisms (18 floats each: top triangle, then 0.3 m below for floors / above for ceilings), prismCount, prismSurf,
  mesh: null | { vertices, indices, chunks (3 per tile: firstTri, triCount, surf), surf, oneSided, stats },
  tiles (6 per tile: firstTri, triCount, surf, owner, vStart, vCount), tileCount, tileBounds (6 per tile), localIndices,
  oneSided, catchY, bounds [x0, z0, x1, z1], floorPts / floorOff / floorN / floorCount, stats }
```

**Slabs**
- Every wall piece (door openings are gaps; a closed door is solid), inferred walls included.
- Furniture the mesh covers gets backstops inside the real surface (ROLE.BACKSTOP):
    - a 4 cm slab with its top 3 cm under the top, the rectangle shrunk 3 cm (the space under a table stays open);
    - for beds, couches and sofas, also the whole volume shrunk 3 cm.
- Uncovered furniture is its box (ROLE.SURFACE).
- One catch slab (ROLE.CATCH): at least 40 m, or the house + 20 m. Its top is 2 mm under the lowest floor.
- `q = (0, qy, 0, qw)` rotates the cuboid's local x onto the box axis `(c, 0, s)`.

**Mesh**
- `mesh.vertices` are collider positions: soft tops sunk 1.5 cm, the real surface elsewhere. Each tile is contiguous in triangles and in vertices.
- The `chunks` contract is what PhysicsWorld already consumes.
- A zero-copy trimesh per tile:
    ```js
    ColliderDesc.trimesh(mesh.vertices.subarray(3 * vStart, 3 * (vStart + vCount)),
      localIndices.subarray(3 * firstTri, 3 * (firstTri + triCount)), oneSided ? FIX_INTERNAL_EDGES : 0)
    ```
- Tiles are 1.5 m, or one per furniture owner (no seam across a table top), ≤ 4,096 triangles each.
- Floors, ceilings, wall faces and door openings are not in the mesh: the prisms and slabs replace them.

**Orientation**
- `oneSided` is true when at least 80 % of the reference area agrees after orientation (`stats.upVotePct`). Only then is FIX_INTERNAL_EDGES safe; otherwise build two-sided trimeshes.

`MATERIAL` (friction / restitution) per SURF class:

| SURF class | Friction | Restitution |
|---|---|---|
| OTHER | 0.6 | 0.15 |
| FLOOR | 0.6 | 0.2 |
| WALL | 0.5 | 0.3 |
| CEIL | 0.5 | 0.3 |
| SOFT | 0.9 | 0.0 |
| HARD | 0.5 | 0.25 |

These match the physics spec.

## Budgets measured (desktop; Quest planning factor ×4, unverified)

`tests/unit/world.largehouse.perf.test.js` uses a 250 m², 12-room house with a 119k-triangle mesh, built in a real worker thread. Each line below is one quantity.

- **Worker time:** about 0.4–0.5 s in all:
    - prep 130–250 ms;
    - BVH 60–100 ms;
    - Roam bake 25–70 ms;
    - encode 35–50 ms.
- **Main-thread time:** worst `world.update` 0.5–0.75 ms in one frame (copy, commit, five tile uploads, the box and overlay copies). Every step is bounded by a deadline or by memcpy.
- **Message:** 29 KB structured, deserialised in 0.2 ms; 1 MB of copied arrays and 5 MB transferred.
- **Memory:** 10.9 MB in the world. The mesh occluder adds 2.8 MB, preallocated.
- **Record size:** 81 KB of base64.

## Open on the device

- The Quest global mesh's winding and label. The vote handles either; `stats.upVotePct` and `flippedByClass` say what happened.
- Its accuracy against the planes. The bands are 3 cm (floor), 5 cm (ceiling) and 6 cm (wall).
- The worker's real speed, and whether CompressionStream exists in the Quest's worker scope (it falls back to `compression: 'none'`).

## Tests

| Test file | What it covers |
|---|---|
| `world.mesh.codec` | The record encoding. |
| `world.mesh.bvh` | The BVH against brute force, zero allocation, transfer. |
| `world.mesh.prep` | Orientation from reversed and scrambled scans, the pose, classes, crops, door openings, soft sink and shrink, tiles, coverage, statics in P's contract, ear clipping. |
| `world.snapshot2` | Capture outside JSON, the record round trip, the fixture, v1, Realign carrying the mesh, rays under the table, `surfaceBelow`. |
| `world.worker` | Worker builds equal synchronous builds (Roam and spot); lent arrays; supersede; failure and timeout fallbacks; a real worker thread. |
| `world.mesh.three` | The mesh occluder, ranges, per-frame uploads, capacity, the box fallback. |
| `world.largehouse.perf` | The large-house budgets above. |
