# Vector assets

**Public HTML example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

An SVG file is the only authored visual source. `assets/seed-scout.svg` contains paths, paint, strokes, SVG ids, the part hierarchy and pivots, sockets, expression variants, clips, keyframes, easings, and loop mode in one direct JSON `metadata#vector-asset` node. No separately edited visual JSON or raster textures are used.

The same page includes SVG-authored yarn and sketch samples. Stitch layout, hatch pattern, contour wobble, color contrast, and deterministic seed live in each SVG metadata node; the build emits retained vector triangles, never a raster texture. The yarn shell uses SVG-authored linear-gradient stops for the surface and samples those same stops along each generated stitch, edge loop, and fiber vertex, with a scalloped outline generated from the source path's edge metric, two Bézier stitch loops with layered yarn/light passes, edge loops, and deterministically seeded fibers that extend outward from the scalloped edge. The sketch style has two fixed-topology morph targets sampled from absolute display time.

## Build and runtime

The public example compares that exact authored SVG, the compiled triangle topology, and the real GameKit WebGL 1 mesh in three side-by-side views. It fetches the source SVG directly and checks its SHA-256 against the compiled asset before displaying it; the example derives display-only part groups and poses from the same paths and metadata. One set of clip, time, expression, zoom, and pan controls drives all views. Drag any panel to pan; Center restores the shared camera. On narrow portrait screens the panels stack, while landscape viewports keep all three visible.

The per-view counters state their scope: the source panel reports downloaded SVG bytes and shape count; the topology panel reports compiled triangle/edge counts and Canvas 2D draw CPU time; the GameKit panel reports the selected WebGL 1 instancing path, device draw calls, retained mesh bytes, creation/frame upload bytes, GPU buffer allocation, and renderer/asset initialization time. GPU elapsed time is not inferred from CPU timing; this example reports no GPU milliseconds.

Run `npm run vector-assets:compile` to validate and compile the reference SVG. The regular `npm run build` emits `dist/vector-assets.js` for retained rendering and a separate, self-contained `dist/vector-assets-loader.js` for browser startup compilation. The loader bundle contains the pinned Three.js `SVGLoader` 0.186.1, `@xmldom/xmldom` 0.9.12, and the shared compiler core, but no authored SVGs or sample geometry. The browser and Node paths use that same core and record the source SHA-256, asset schema version, compiler version, and tessellation options in the compiled asset. SVG paths are converted once to triangle geometry, including compound fills and strokes, and packed into GameKit's 11-float mesh format. The compiler deduplicates only bit-identical complete records into a 16-bit index buffer while preserving triangle order; assets with more than 65,536 distinct records are rejected.

For games that ship original SVG resources, compile them once during startup instead of checking in generated geometry. `createVectorAssetLoader()` fetches and compiles source bytes using Web Crypto SHA-256 and returns a retained-geometry descriptor that can be passed to `createVectorAsset()`. Identical concurrent requests share one fetch/compile promise; completed results use a bounded least-recently-used cache (64 entries by default), and compilation or network errors reject the load. Supplying `expectedSha256` verifies the exact original bytes before parsing or caching. `maxBytes` can lower the 512 KiB source ceiling for a particular resource. Debug-only `sourcePaths` are omitted by default and can be requested with `includeSourcePaths: true`.

```js
import { createVectorAssetLoader } from './vector-assets-loader.js';
import { createVectorAsset } from './vector-assets.js';

const loader = createVectorAssetLoader({ maxEntries: 8 });
const [compiledScout] = await Promise.all([
    loader.load('/assets/scout.svg', {
        sourcePath: 'assets/scout.svg',
        expectedSha256: '...64 lowercase hex characters...',
        maxBytes: 256 * 1024,
    }),
]);
const scout = createVectorAsset(meshes, compiledScout);
const actor = scout.createPlayer({ clip: 'idle', startedAtMs: 0 });
// In the render loop, seek and draw the already-compiled actor.
// On owner shutdown, dispose the actor, asset, loader, meshes and device.
```

`loader.load(url, { sourcePath, expectedSha256, maxBytes, curveSegments, strokeArcDivisions, includeSourcePaths, normalizeCenteredViewBox })` returns a promise. The cache key includes the URL, source path, expected digest, source limit, curve quality, stroke arc quality, viewport-normalization mode, and debug-data choice; distinct compilation contracts never share a cached result. The public `VECTOR_ASSET_QUALITY_PRESETS` constant is available from both `vector-assets.js` and `vector-assets-loader.js`; use `standard` (4 curve segments / 2 stroke arc divisions) for most assets or `smallAsset` (2 / 2) for small assets. Both presets and their option objects are frozen. `normalizeCenteredViewBox: true` is an opt-in compiler mode for sources authored in centered local coordinates with legacy root viewport dimensions or empty `{}` clip poses. It verifies and hashes the exact fetched bytes first, then normalizes only the in-memory compiler input: root width/height come from the viewBox size, its compiler viewBox starts at zero, and only empty no-op pose entries are dropped. The returned `viewBox`, painted geometry, pivots, sockets, and nonempty clip transforms remain in the original authored coordinate space. No shipped SVG is rewritten. Set `maxEntries: 0` to disable completed-result caching while keeping same-key in-flight deduplication. Call `loader.clear()` to drop completed entries or `loader.dispose()` during owner shutdown.

SVG fill triangulation (including gradient fills and yarn outer fills) and stroked path sampling default to `VECTOR_ASSET_QUALITY_PRESETS.standard`: 4 curve segments and 2 stroke arc divisions. The compiler API accepts `curveSegments` and `strokeArcDivisions` as integers from 1 through 64; omitted values use the corresponding standard preset, while `null`, fractions, and out-of-range values are rejected. The frozen `smallAsset` preset uses 2 / 2. Callers that need the previous detail can continue to pass `{ curveSegments: 16, strokeArcDivisions: 12 }` explicitly. The opt-in `normalizeCenteredViewBox: true` mode described above applies to both Node and browser compiler APIs. The CLI uses the matching `--curve-segments <integer>` and `--stroke-arc-divisions <integer>` decimal options and rejects duplicate or unknown flags. `ShapeGeometry` uses `curveSegments`, as does `SVGLoader` path point sampling before stroke tessellation. Authored sketch morph outlines and yarn stitch paths retain their fixed style subdivisions. Object-bounding-box gradient coordinates are computed at a fixed sampling quality so changing geometry detail does not move gradient endpoints. The compiled asset records selected compiler options alongside its source hash. For example: `npm run vector-assets:compile -- modules/vector-assets/assets/seed-scout.svg --curve-segments 3 --stroke-arc-divisions 2 --output seed-scout.compiled.js`. Lower values reduce retained triangle references and initial geometry bytes but can degenerate some shapes; the compiler reports when a source has no complete triangles at the selected tessellation. Compare actual output at the intended display size.

Compiled `geometry.expressionIndices` lists omit geometry in mutually exclusive expression groups while preserving the source triangle order. Every key must name an authored `metadata.expressions` entry; vector players select only these semantic expression lists automatically. Calling `setPartVisible()` disables that optimization until a later `setExpression()` restores the matching list, preserving explicit visibility behavior.

`geometry.indexVariants` is a separate map for host-selected named triangle ranges such as painter-order runs. Its keys are stable names, its values are `Uint16Array` triangle lists over the same vertex records, and it never changes expression visibility. Names must be unique across `expressionIndices` and `indexVariants`. Both maps pass through `createVectorAsset()` into the retained mesh; `drawMesh({ indexVariant })` selects a named list, while an omitted name draws the base `geometry.indices`. The renderer retains, budgets, restores, and releases both maps' index buffers. This separation lets a host submit authored expression geometry and painter-order ranges without treating a draw-range name such as `paint_0` as an expression.

The production entry exports the generic `createVectorAsset(meshRenderer, compiledAsset)` API and the shared `VECTOR_ASSET_QUALITY_PRESETS` constant; it does not bundle the reference character's compiled geometry. The Seed Scout helper is example-only in `examples/seed-scout.js` and is bundled into the standalone HTML preview, not `dist/vector-assets.js`.

The browser runtime uses the existing `MeshRenderer.createMesh` / `drawMesh` / part pose API. `createVectorAsset(meshRenderer, compiledAsset, { surfaceRenderer })` owns one retained GPU mesh and, when present, each SVG shader-backed surface; `asset.createPlayer()` creates independent clip state. Pass a `YarnSurfaceRenderer` when the compiled geometry contains `shaderSurfaces`. The resource owns its vertex, index, and surface buffers; callers own the renderers and `WebGLDevice`. Disposing the asset disposes its players and retained geometry but leaves the renderer and device alive.

`vector-effect="non-scaling-stroke"` is supported for a single straight SVG `<line>` with a visible solid stroke and `stroke-linecap="butt"`, `"square"`, or `"round"`. The numeric `stroke-width` is interpreted as CSS pixels. SVG paths, polylines, polygons, zero-length lines, unknown `vector-effect` values, and assets with vertex morph targets fail compilation; they never fall back to the ordinary scaling stroke. A single line has no join, so join and miter behavior do not apply to this supported shape. This scope keeps the authored line centerline and its cap triangles in the same static 11-float mesh; the vertex shader expands only the line vertices after part, object, and camera transforms, leaving any ordinary fills in that mesh unchanged. It does not tessellate or upload geometry per frame. Rotation and non-uniform scale affect the line direction but not its CSS-pixel width.

On the default framebuffer the renderer takes the logical viewport from `canvas.clientWidth` and `clientHeight`, so device-pixel ratio does not change stroke width. When drawing to a render target, pass `strokeViewport: [logicalCssWidth, logicalCssHeight]` to `MeshRenderer.drawMesh()` or the vector player's `draw()` call; the host must provide the CSS-sized viewport represented by the offscreen image. Omitting it on an active render target throws. The ordinary alpha, painter order, depth, clipping, retained-buffer restore, and disposal paths remain in use; clipping evaluates the expanded screen-space edge after converting it back through the projection.

```svg
<line x1="20" y1="50" x2="80" y2="50" fill="none"
      stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"
      vector-effect="non-scaling-stroke" />
```

The compiler/render regression fixture is `tests/non-scaling-stroke.svg`. The browser test measures actual WebGL pixels at multiple CSS viewport sizes, DPRs, camera zoom, and an animated part transform. SVG 2 defines this effect in host/viewport coordinates; Chromium's SVG painter likewise resets to the host transform before painting the stroke ([SVG 2](https://www.w3.org/TR/SVG2/painting.html#VectorEffectProperty), [Chromium `SVGShapePainter`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/svg_shape_painter.cc)).

Animation data is evaluated by a paused Anime.js v4.5.0 timeline over plain objects. `player.seek(displayTimeMs)` samples a caller-provided display timestamp; no module animation loop, event callback, or game command runs. Snapshot position interpolation remains the host's responsibility. `transitionTo` preserves deterministic time seeks by blending the previous and next clip trees at that same timestamp while the transition is active. Before its start, only the source tree is sampled; at and after its end, only the target clip is sampled. Completed transition history remains retained so seeking backward can reproduce earlier poses; repeated transitions therefore still grow retained playback-tree memory, which is separate from the avoided per-frame sampling work. Use existing presentation-events/audio APIs for one-shot presentation effects.

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

Expressions and explicit part visibility are set on the player. Part pivots and socket coordinates are read from SVG metadata. Authored numeric clip fields are `x`, `y`, `rotation` (radians), `scaleX`, `scaleY`, and `opacity`; clip modes are `once`, `repeat`, and `alternate`. Each asset supports at most 16 parts. Geometry remains static; authored clips transform parts and select expression variants without topology morphing. SVG paint support includes solid fills/strokes and a restricted linear-gradient contract: direct root `<defs><linearGradient>` elements with explicit stops, `pad` spread, object-bounding-box or unitless user-space coordinates, and internal `fill="url(#id)"` references. Gradient stops are split into retained triangles and compiled to vertex RGBA; the GPU does not sample a texture. Generated yarn stroke triangles are split at the same stop boundaries, then each stitch, edge-loop, and fiber vertex samples the authored gradient before its metadata tint is applied. `gradientTransform`, inherited gradients, radial gradients, CSS, text, `use`, arbitrary XML, and full SVG rendering are outside this schema. Scripts, `foreignObject`, external references, embedded raster, doctypes, unknown elements/attributes, and unsupported style values fail compilation. The yarn generator tessellates curved strokes into static triangles and is parameter-driven rather than pixel-identical to another renderer's raster output.

`player.draw({ projection, depth, depthTest, depthWrite, depthFunc })` forwards explicit clip-space depth to `MeshRenderer`. Depth is `[-1,1]`; depth testing and writing default off, so regular 2D assets retain painter-order behavior. For 3D placement, pass both `viewProjection` (column-major 4×4) and an affine `worldMatrix` (column-major 4×4); the player's 2D `matrix` and authored part transforms are composed into that world transform. Do not also pass `projection`. Convex `clips` remain in world XY coordinates, shared unchanged by differently transformed actors and shader surfaces. For assets containing shader surfaces, the runtime validates the shared clip list against `surfaceRenderer.maxClipPlanes` before submitting any painter-order draw; exceeding this stricter renderer limit throws without partially drawing the asset. A depth-tested pass needs a depth attachment. Transparent actors are still submitted in host painter order; this API does not sort or change scene policy. The shader-backed SVG surface currently supports one simple contour per surface; holes and multiple contours are outside the retained shader-surface schema.

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

The browser fixture reports shared-pose actors separately from independently phased idle/bounce clips and neutral/happy/surprised expressions. It checks 100 and 400 distinct multi-part poses, one draw per distinct pose, zero per-frame geometry upload, same-time rollback seek, and records CPU submission and GPU timer availability without imposing a hardware-specific timing threshold. The shared-pose one-draw case is not used as a proxy for independently animated actors.
