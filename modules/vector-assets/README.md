# Vector assets

**Public HTML example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

An SVG file is the only authored visual source. `assets/seed-scout.svg` contains paths, paint, strokes, SVG ids, the part hierarchy and pivots, sockets, expression variants, clips, keyframes, easings, and loop mode in one direct JSON `metadata#vector-asset` node. No separately edited visual JSON or raster textures are used.

The same page includes SVG-authored yarn and sketch samples. Stitch layout, hatch pattern, contour wobble, color contrast, and deterministic seed live in each SVG metadata node; the build emits retained vector triangles, never a raster texture. The sketch style has two fixed-topology morph targets sampled from absolute display time.

## Build and runtime

The public example compares that exact authored SVG, the compiled triangle topology, and the real GameKit WebGL 1 mesh in three side-by-side views. It fetches the source SVG directly and checks its SHA-256 against the compiled asset before displaying it; the example derives display-only part groups and poses from the same paths and metadata. One set of clip, time, expression, zoom, and pan controls drives all views. Drag any panel to pan; Center restores the shared camera. On narrow portrait screens the panels stack, while landscape viewports keep all three visible.

The per-view counters state their scope: the source panel reports downloaded SVG bytes and shape count; the topology panel reports compiled triangle/edge counts and Canvas 2D draw CPU time; the GameKit panel reports the selected WebGL 1 instancing path, device draw calls, retained mesh bytes, creation/frame upload bytes, GPU buffer allocation, and renderer/asset initialization time. GPU elapsed time is not inferred from CPU timing; this example reports no GPU milliseconds.

Run `npm run vector-assets:compile` to validate and compile the reference SVG. The regular `npm run build` runs the same compiler and emits `dist/vector-assets.js` as a self-contained ESM bundle. It records the source SHA-256, asset schema version, and compiler version in the compiled asset. Three.js `SVGLoader` 0.186.1 is build-only; its paths are converted once to triangle geometry, including compound fills and strokes, and packed into GameKit's existing 11-float mesh format. Node compilation uses the pinned `@xmldom/xmldom` 0.9.12 DOMParser adapter.

The production entry exports only the generic `createVectorAsset(meshRenderer, compiledAsset)` API; it does not bundle the reference character's compiled geometry. The Seed Scout helper is example-only in `examples/seed-scout.js` and is bundled into the standalone HTML preview, not `dist/vector-assets.js`.

The browser runtime uses the existing `MeshRenderer.createMesh` / `drawMesh` / part pose API. `createVectorAsset(meshRenderer, compiledAsset)` owns one retained GPU mesh and `asset.createPlayer()` creates independent clip state. The resource owns the mesh; callers own `MeshRenderer` and `WebGLDevice`. Disposing the asset disposes its players and mesh but leaves the renderer and device alive.

Animation data is evaluated by a paused Anime.js v4.5.0 timeline over plain objects. `player.seek(displayTimeMs)` samples a caller-provided display timestamp; no module animation loop, event callback, or game command runs. Snapshot position interpolation remains the host's responsibility. `transitionTo` preserves deterministic time seeks by blending the previous and next clip trees at that same timestamp. Use existing presentation-events/audio APIs for one-shot presentation effects.

```js
import { WebGLDevice, MeshRenderer } from './rendering.js';
import { createVectorAsset } from './vector-assets.js';
import { compiledAsset } from './character.compiled.js'; // generated from the authored SVG and its metadata

const device = new WebGLDevice(canvas);
const meshes = new MeshRenderer(device);
const asset = createVectorAsset(meshes, compiledAsset);
const actor = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });

// Inside the host render frame, after device.beginFrame() and meshes.beginFrame():
actor.seek(displayTimeMs); // the absolute display time already chosen by the host
actor.draw({ projection });
meshes.flush();

// On owner shutdown:
actor.dispose();
asset.dispose();
meshes.dispose();
device.dispose();
```

Expressions and explicit part visibility are set on the player. Part pivots and socket coordinates are read from SVG metadata. Authored numeric clip fields are `x`, `y`, `rotation` (radians), `scaleX`, `scaleY`, and `opacity`; clip modes are `once`, `repeat`, and `alternate`. Each asset supports at most 16 parts. Geometry is static: topology morphs, SVG filters, gradients, CSS, text, `use`, arbitrary XML, and full SVG rendering are outside this schema. Scripts, `foreignObject`, external references, embedded raster, doctypes, unknown elements/attributes, and unsupported style values fail compilation.

The SVG save round-trip check serializes and reparses the source, then verifies the JSON metadata and every DOM id survive. Editors that remove this metadata or rename ids need an export setting or a different SVG editor.

## Painter-ordered geometry batches

`MeshBuilder.combine([assetA.geometry, assetB.geometry])` concatenates compatible compiled geometries in the supplied order and remaps their part indices. It accepts 11-float mesh data, up to two morph targets, and at most 16 total parts. The result is one retained mesh, uploaded once:

```js
const geometry = MeshBuilder.combine([player.geometry, enemy.geometry, prop.geometry]);
const mesh = meshes.createMesh(geometry);
meshes.drawMesh(mesh, {
  projection,
  parts: [...playerPartPoses, ...enemyPartPoses, ...propPartPoses],
  clips: sharedViewportClip,
});
meshes.flush();
```

The input list defines painter order; the batch never sorts. Each player's `partPoses()` exposes its local transform, authored two-target morph weights, visibility, and opacity. Before combining actors, fold each actor's root matrix into every one of its part transforms and concatenate the pose arrays in the same order as the geometry list. Per-part transforms, morph weights, visibility, and opacity remain independent. A draw has one projection and shared clip planes, so items with different projections or clip regions must be separate ordered batches. Part `color`/white-flash state is not per-part; keep those items in separate draws unless color was authored into the SVG geometry. Build the combined geometry when the group membership/order changes, not per frame. The existing 16-part limit is intentional; the API rejects a larger group rather than silently dropping parts.
