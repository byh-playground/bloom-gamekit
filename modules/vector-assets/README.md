# Vector assets

## Runtime part atlas comparison

The same example also includes sampled sprite playback. `createVectorSpriteAtlas(meshes, asset, compiledAsset, { clip, expression, sampleIntervalMs, pixelsPerUnit, padding, maxAtlasBytes })` samples an authored SVG clip at the midpoint of each interval and bakes complete poses into an RGBA atlas. For a once clip, the final interval uses the exact authored endpoint so the held final image keeps the terminal pose. The final interval keeps its shorter duration, so playback keeps the authored clip length. It returns a generic sprite definition and texture rather than an SVG-dependent player:

```js
const BAKER = createVectorSpriteAtlas(MESHES, ASSET, COMPILED, {
    clip: 'bounce',
    expression: 'neutral',
    sampleIntervalMs: 100,
    pixelsPerUnit: 1,
    padding: 2,
});
BAKER.bake(); // in an active device frame, before constructing SPRITES
const SPRITES = createSpriteAnimation(MESHES, BAKER.texture, BAKER.definition);
const PLAYER = SPRITES.createPlayer({ clip: 'bounce', startedAtMs: 0 });
PLAYER.draw({ timeMs: displayTimeMs, projection: PROJECTION, matrix: MATRIX });
// Reuse during playback; do not bake in the animation render loop.
SPRITES.dispose(); // the texture is borrowed
BAKER.dispose();
```

Sprite coordinates are pixels; when `pixelsPerUnit` differs from 1, divide the vector-local matrix scale by it. The baker keeps a fixed union of sampled transformed/morphed bounds and encodes the original SVG origin in the sprite pivot, preventing per-frame trim jitter. SVG expressions and opacity are composed into each frame. A private source player samples only during planning/bake and leaves caller players untouched. Identical source-asset/clip/appearance/interval/resolution requests share a reference-counted atlas; changed inputs and context restoration require another bake. Dispose sprite resources before releasing their baker. Unsupported shader surfaces, automatic sketch time morphs, non-scaling strokes and allocation limits return an explicit vector reason with no usable sprite texture.

This is a sampled approximation: animation time selects and holds a complete image. The example exposes the interval and its temporal error bound; it does not claim continuous pose interpolation. Enlarging a baked frame blurs its pixels. Authored per-part morph channels can be baked at sampled times. Automatic sketch morphs depend on absolute display time and cannot be represented by reversing/repeating one clip atlas; these explicitly return timeDependentMorph vector fallback. Arbitrary live overrides, sockets and transitions are not evaluated by the generic sprite player. Use the vector path for those dynamic contracts. Initial planning/bake CPU wall time and texture capacity are separate from steady playback measurements.

**Interactive HTML:** [vector-raster-comparison](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-raster-comparison.html)

By default this example compares **Vector / Full sprite** only. **Advanced options → Part textures** explicitly enables the third path, including its live panel, card, cost column and sequential/accumulated samples. Disabled part textures are not baked or retained; the resource is disposed when turned off. Toggling the option is an explicit preparation/configuration change and rebuilds the finite preparation manifest, while unchanged settings and playback retain the zero image-upload/rebake contract. Enabled paths form part of the measurement condition key, so two/three-path histories never mix and completed prior results stay labelled. The module APIs remain available unchanged.

The accumulated measurement controls repeat balanced full-viewport rounds until stopped: each path receives 30 warmup frames and 60 measured frames at identical display times, alternating forward/reverse order across completed rounds. Stop cancels the incomplete round; resume at unchanged settings appends to its labelled condition. Settings can be changed after stopping; previous conditions remain visible. Resizing, hiding the page, context loss or changed conditions cancel an incomplete round. Exact samples are bounded at 6,000 per path and the five most recently measured conditions; reset clears them and closing/reloading loses history. Percentiles use linear interpolation in sorted samples, not averaged round percentiles. This repeated workload is a comparison tool, not whole-game performance or a crossover study.

The accumulated table separates CPU total (animation update plus render preparation/submission including final flush), CPU submit (a subset), valid asynchronous GPU render duration (including pose pass), and actual RAF intervals (including browser waits and unrelated work). CPU and GPU overlap and must not be added. Each metric reports count, mean, p50/p95/p99/max and strictly greater than 16.7ms reference-budget counts; RAF FPS comes from mean RAF interval, not inverse GPU time. Sampled duration sums measured RAF intervals and excludes setup, warmup, interruptions and query drain. GPU coverage is explicit; missing/unsupported/pending results are absent, not zeroes, and a disjoint round's GPU samples are discarded conservatively. Initial preparation and logical atlas allocation are shown separately. Completed rounds assert no image upload/rebake; numeric pose and instance uploads are separate. Statistics/HUD update between rounds or phases, not every sample. Split live timing remains shared and cannot rank individual paths.

Split-view live calls cannot be attributed to individual render paths: a later path can flush the previous retained batch, and the last flush happens outside those calls. The split HUD therefore shows shared RAF FPS and directs per-path CPU/GPU comparisons to the sequential benchmark. A single full-viewport path can show live submission including its final flush. This display correction does not change drawing order, batching or quality; a legitimately lower vector CPU submission time remains visible in the sequential results.

The comparison also exposes mesh curve precision: low (2), standard (4) and high (16) `curveSegments`, with `strokeArcDivisions` fixed at 2. These are compiler options, separate from the 64–512px image texture resolution. Selecting a different precision loads/compiles the same SVG through the existing browser loader, then prepares that geometry's atlases; unchanged settings and normal animation frames reuse compiled geometry and prepared images. Standard geometry is already compiled into the preview at build time; an unavailable runtime compilation timing is shown as such rather than zero. The compact trade-off comparison separates actual source vertex/index counts, renderer CPU geometry retention, logical RGBA image storage and shared numeric pose texture allocation. It is a way to inspect and measure your chosen conditions, not a published crossover threshold or a claim that one representation always wins.

The example has separate **Single** quality/zoom and **Crowd** comparison tabs. Crowd population, character size in CSS pixels (the longest viewBox dimension), placement spread and seed are independent. Adding actors preserves existing seeded positions and never shrinks the characters. A smaller placement area increases density and overlap while preserving painter order. Shared live RAF FPS applies to all simultaneously visible paths; it is not an independent per-backend FPS. The sequential comparison uses the same full canvas for each backend, 30 warmup frames and 60 timed frames, and reports actual RAF cadence separately from CPU render/submit and asynchronous GPU p50/p95. GPU duration is not inverted into screen FPS. The repeat comparison requires the supported `transform-repeat` clip with mixed motion disabled; other clips remain available for visual inspection. Preparation is separate and prepared playback must not bake or upload image data. Changed settings, resize, DPR or context restoration invalidate displayed benchmark results. This example work does not change the rendering pipeline or imply a universal performance winner.

The optional `createVectorRasterAtlas(meshes, asset, compiledAsset, options)` bakes the retained source mesh into an RGBA8 render target. Each contiguous run of triangles belonging to a part becomes a padded atlas tile and an ordered quad. Separated runs remain separated. It uses the same player clock, hierarchy, easing, transitions and borrowed pose handle as vector rendering; it does not bake animation frames or evaluate a second animation system.

```js
const ATLAS = createVectorRasterAtlas(MESHES, ASSET, COMPILED, {
    pixelsPerUnit: 1,
    padding: 2,
    maxAtlasBytes: 64 * 1024 * 1024,
});
DEVICE.beginFrame({ width: 800, height: 600 });
MESHES.beginFrame();
ATLAS.bake(); // optional explicit first bake; requires an active device frame
PLAYER.seek(displayTimeMs);
PLAYER.preparePose();
MESHES.preparePoses();
const RESULT = ATLAS.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX });
MESHES.flush();
DEVICE.endFrame();
// RESULT.backend is raster or vector; RESULT.reason explains fallback.
ATLAS.dispose();
```

The atlas borrows the source mesh and players. Dispose it before disposing its source asset or renderer. It owns only its render target and quad mesh. Texture pixels are premultiplied by the existing source-over render pass and sampled with linear filtering; numeric pose textures retain nearest filtering on a separate sampler. Initial bake CPU submission cost, atlas allocation, normal frame uploads and draw counts are reported separately in `atlas.stats` and the example. `gpuTextureBytes` already includes render-target texture storage; do not add `gpuRenderTargetBytes` to it again.

Animation frames reuse the atlas. A changed resolution requires a new atlas. After context restoration, the retained source geometry rebakes the lost render-target contents once. Limits or allocation failures report vector fallback. Fixed pixel resolution introduces sampling and enlargement blur; there is no clip-frame quantization. The default comparison uses an explicit `transform-repeat` fixture: the original Seed Scout geometry and bounce transforms, with a separate repeat clip added for continuous independent-phase measurements. The original once clip remains unchanged. Idle includes an opacity channel and demonstrates explicit part-atlas fallback rather than silently changing translucent triangle composition. The three comparison labels are pure vector (retained mesh plus GPU pose), vector plus part texture (part atlas plus the same GPU pose), and texture (sampled whole-frame sprite). The default sampling interval is 100ms, independently configurable from the render rate.

Morph targets, time-dependent shader surfaces, non-scaling strokes, expressions selecting only part of a paint run and unsupported alpha composition use the vector path. Force-color and depth-write alpha classification also use vector rendering. A texture atlas is an alternative representation, not a promise of faster rendering: compare both paths after warmup and include initial bake cost. The example supports split/A-B views, pause/scrub, clips, expressions, independent phases, population, resolution and zoom. Split-view counters include both submissions; use single-path A-B modes for performance comparison.

## Named fill regions

An authored solid-filled shape can declare `data-paint-region="cheeks"`. The name is independent of rig parts and can be repeated on corresponding shapes in every expression. Up to eight names are supported. Regions must be explicit `path`, `rect`, `circle`, `ellipse`, `polygon`, or `polyline` fills; group inheritance, gradients, and authored yarn/sketch material targets are rejected. UV-textured meshes reject named fill regions explicitly rather than recolouring baked texture pixels. Only fill RGB changes. Strokes, vertex/fill alpha, geometry, sockets, rig transforms and expression visibility stay authored.

```js
const paintRegions = { cheeks: [0.35, 0.6, 0.9] }; // three finite RGB channels in [0,1]
player.draw({ projection, matrix, paintRegions });
player.draw({ projection, matrix }); // original fill colours

// The UI uses the same source and named fills. The input SVG stays unchanged.
const portrait = applySvgPaintRegions(originalSvgRoot, paintRegions);
container.replaceChildren(portrait);
```

Unknown region names, alpha overrides, invalid RGB channels and triangles crossing region ids fail explicitly. `applySvgPaintRegions` returns a clone and changes the same named fills across hidden expressions too. Independent UI palettes cannot contaminate their reusable original. The helper adds no face geometry and preserves every other attribute. Consumers can cache finite portrait variants; the helper does not belong in a render loop.

Compiled geometry keeps its original 11-float records and optional `paintRegions: { names, indices }`, with one `Uint16` region id per unique vertex (`0` means the original material). Fill triangles receive ids and strokes stay at zero. The renderer adds one float to the GPU stream of tagged meshes once at creation/restoration. It shares that mesh and its expression index variants across all player palettes. Changed palettes flush ordered submissions before changing RGB uniforms; no palette recompiles or uploads geometry. Untagged assets keep the existing GPU layout and shader. Compiled region ids require two CPU bytes per vertex. The renderer retains one 12-float packed stream alongside its 11-float source, adding 48 retained CPU bytes and four GPU bytes per tagged vertex relative to an untextured mesh. Context restoration reuses that packed stream. Different palettes can split an adjacent instance batch. Explicit global tint, forceColor and whiteFlash keep their established later-stage behavior.

`npm run test:vector-assets:paint-regions` runs the original SVG/UI-helper/reference-mesh flow in Chromium WebGL. It compares RGB and alpha through expression/motion/clipping/world passes, checks independent palettes and reset, observes zero per-frame geometry uploads, restores the context, and disposes resources. Its SwiftShader pixels verify function, not physical-device performance.

**Public HTML example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

An SVG file is the only authored visual source. `assets/seed-scout.svg` contains paths, paint, strokes, SVG ids, the part hierarchy and pivots, sockets, expression variants, clips, keyframes, easings, and loop mode in one direct JSON `metadata#vector-asset` node. No separately edited visual JSON or raster textures are used. The optional runtime raster atlas below derives its pixels from that same compiled SVG geometry.

The same page includes SVG-authored yarn and sketch samples. Stitch layout, hatch pattern, contour wobble, color contrast, and deterministic seed live in each SVG metadata node; the build emits retained vector triangles, never a raster texture. The yarn shell uses SVG-authored linear-gradient stops for the surface and samples those same stops along each generated stitch, edge loop, and fiber vertex, with a scalloped outline generated from the source path's edge metric, two Bézier stitch loops with layered yarn/light passes, edge loops, and deterministically seeded fibers that extend outward from the scalloped edge. The sketch style has two fixed-topology morph targets sampled from absolute display time.

## Authoring rule: the source file draws the default pose

An SVG that a plain viewer, `<img>`, or an editor opens must show the same pose the runtime starts in. Every part that `metadata.expressions[defaultExpression].hide` lists carries `display="none"` on its SVG node, and no other node may carry it. Parts the default expression shows, or does not mention, stay visible, matching how the player applies expressions. The compiler rejects an asset that breaks either direction, naming the part, so a file that overlaps every expression or draws a hidden variant cannot ship.

`display="none"` is the only `display` value the schema accepts. It marks the default pose in the source file only: the compiler removes it from its in-memory input, so every expression variant still compiles to the same geometry and the runtime decides visibility. The source SHA-256 covers the attribute, so adding it to an existing asset changes its hash. Game UI that shows a species outside the WebGL scene (icons, portraits, collection pages) can therefore reference the original file directly instead of re-deriving the pose from metadata. Idle-clip start opacities are not part of this rule.

## Build and runtime

The public example compares that exact authored SVG, the compiled triangle topology, and the real GameKit WebGL 2 mesh in three side-by-side views. It fetches the source SVG directly and checks its SHA-256 against the compiled asset before displaying it; the example derives display-only part groups and poses from the same paths and metadata. One set of clip, time, expression, zoom, and pan controls drives all views. Drag any panel to pan; Center restores the shared camera. On narrow portrait screens the panels stack, while landscape viewports keep all three visible.

The per-view counters state their scope: the source panel reports downloaded SVG bytes and shape count; the topology panel reports compiled triangle/edge counts and Canvas 2D draw CPU time; the GameKit panel reports the selected WebGL 2 instancing path, device draw calls, retained mesh bytes, creation/frame upload bytes, GPU buffer allocation, and renderer/asset initialization time. GPU elapsed time is not inferred from CPU timing; this example reports no GPU milliseconds.

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

`player.draw({ excludeParts })` accepts a caller-owned reusable `Set` of known part IDs and treats those parts as invisible for that call only. It does not change the player's expression or explicit visibility, so the same resolved pose can serve the outline and body passes. Excluded mesh ranges and shader surfaces are skipped in their existing painter order; remaining ranges, alpha, clipping, and batching behavior stay intact. A non-`Set` value or unknown part ID throws before draw submission. The Set is read directly and never copied; construct it outside the render loop and reuse it.

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

## Pose preparation and CPU queries (v0.17)

`createVectorSpriteAtlas(meshes, asset, compiled, { clip, expression, sampleIntervalMs, pixelsPerUnit, paintRegions })` accepts the same explicit named RGB replacements as `player.draw({ paintRegions })`. The baker validates and captures the values when the atlas is created. Equivalent values share the cache regardless of object key order; distinct values produce distinct textures. Caller mutation cannot change a deferred bake or context-restoration bake. Reset with `null` or `{}` uses the original fills. Alpha, stroke, expression and authored pose remain source-owned. Each palette consumes its own atlas image bytes: hosts must budget and prepare a finite manifest before playback, not create new combinations in their render loop.

Player의 play/seek/transitionTo 시간선은 backend와 독립적입니다. 일반 clip은 원본 채널의 Float32 숫자 프로그램을 GPU에서 평가하고, CPU getSocket/getPartPose는 같은 배치의 Float64 채널로 해당 부위와 조상만 샘플링합니다. partPoses는 전체 CPU pose를 lazy로 계산해 독립 복사본을 반환합니다. 전환 중에는 원래 Anime.js CPU 평가를 사용하며 source/target/중첩/되감기 의미를 보존합니다. 종료된 전환은 GPU 경로로 돌아갈 수 있습니다. CPU 평가·부분 조회 횟수/시간은 player.poseMetrics로 확인합니다.

player.preparePose({excludeParts})와 MeshRenderer.preparePoses()를 actor 제출 전에 호출하면 여러 독립 위상을 한 준비 단계에서 평가할 수 있습니다. 이후 VectorContext.drawVectorAsset(player,options)는 앞선 paint와 순서를 보존합니다. excludeParts는 해당 부위만 숨기며 부모를 제외했다고 자식까지 숨기지 않습니다. setPartVisible의 부모 가시성 전파와 별개입니다. dispose는 소유 pose row를 반환하며 애플리케이션 ID를 GPU 행 번호로 사용하지 않습니다.

고정 브라우저 시나리오는 npm run test:vector-assets:gpu-poses로 실행합니다. test-results/gpu-poses.json에 사전에 고정한 픽셀/포즈 허용 기준, 차이가 난 픽셀 위치, GPU/CPU 사용량, 복구·dispose 결과를 기록합니다. 물리 모바일 검증을 대신하지 않습니다.
