# Vector assets

**Public HTML example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

An SVG file is the only authored visual source. `assets/seed-scout.svg` contains paths, paint, strokes, SVG ids, the part hierarchy and pivots, sockets, expression variants, clips, keyframes, easings, and loop mode in one direct JSON `metadata#vector-asset` node. No separately edited visual JSON or raster textures are used.

The same page includes SVG-authored yarn and sketch samples. Stitch layout, hatch pattern, contour wobble, color contrast, and deterministic seed live in each SVG metadata node; the build emits retained vector triangles, never a raster texture. The yarn shell uses SVG-authored linear-gradient stops for the surface and samples those same stops along each generated stitch, edge loop, and fiber vertex, with a scalloped outline generated from the source path's edge metric, two Bézier stitch loops with layered yarn/light passes, edge loops, and deterministically seeded fibers that extend outward from the scalloped edge. The sketch style has two fixed-topology morph targets sampled from absolute display time.

## Build and runtime

The public example compares that exact authored SVG, the compiled triangle topology, and the real GameKit WebGL 1 mesh in three side-by-side views. It fetches the source SVG directly and checks its SHA-256 against the compiled asset before displaying it; the example derives display-only part groups and poses from the same paths and metadata. One set of clip, time, expression, zoom, and pan controls drives all views. Drag any panel to pan; Center restores the shared camera. On narrow portrait screens the panels stack, while landscape viewports keep all three visible.

The per-view counters state their scope: the source panel reports downloaded SVG bytes and shape count; the topology panel reports compiled triangle/edge counts and Canvas 2D draw CPU time; the GameKit panel reports the selected WebGL 1 instancing path, device draw calls, retained mesh bytes, creation/frame upload bytes, GPU buffer allocation, and renderer/asset initialization time. GPU elapsed time is not inferred from CPU timing; this example reports no GPU milliseconds.

Run `npm run vector-assets:compile` to validate and compile the reference SVG. The regular `npm run build` runs the same compiler and emits `dist/vector-assets.js` as a self-contained ESM bundle. It records the source SHA-256, asset schema version, compiler version, and tessellation options in the compiled asset. Three.js `SVGLoader` 0.186.1 is build-only; its paths are converted once to triangle geometry, including compound fills and strokes, and packed into GameKit's 11-float mesh format. The compiler deduplicates only bit-identical complete records into a 16-bit index buffer while preserving triangle order; assets with more than 65,536 distinct records are rejected. Node compilation uses the pinned `@xmldom/xmldom` 0.9.12 DOMParser adapter.

SVG fill triangulation (including gradient fills and yarn outer fills) and stroked path sampling default to 16 subdivisions. The compiler API accepts only the `curveSegments` option as an integer from 4 through 64; omitted means 16, while `null`, fractions, and out-of-range values are rejected. The CLI uses the matching `--curve-segments <integer>` decimal option and rejects duplicate or unknown flags. `ShapeGeometry` uses this value, as does `SVGLoader` path point sampling before stroke tessellation; round stroke joins and end caps keep Three.js's separate 12 arc divisions. Authored sketch morph outlines and yarn stitch paths retain their fixed style subdivisions. Object-bounding-box gradient coordinates are computed at a fixed sampling quality so changing geometry detail does not move gradient endpoints. The compiled asset records the selected value alongside its source hash. For example: `npm run vector-assets:compile -- modules/vector-assets/assets/seed-scout.svg --curve-segments 8 --output seed-scout.compiled.js`. Lower values reduce retained triangle references and initial geometry bytes but can change small curves, so choose against the asset's displayed size and compare actual output.

Compiled `geometry.expressionIndices` lists omit geometry in mutually exclusive expression groups while preserving the source triangle order. Every key must name an authored `metadata.expressions` entry; vector players select only these semantic expression lists automatically. Calling `setPartVisible()` disables that optimization until a later `setExpression()` restores the matching list, preserving explicit visibility behavior.

`geometry.indexVariants` is a separate map for host-selected named triangle ranges such as painter-order runs. Its keys are stable names, its values are `Uint16Array` triangle lists over the same vertex records, and it never changes expression visibility. Names must be unique across `expressionIndices` and `indexVariants`. Both maps pass through `createVectorAsset()` into the retained mesh; `drawMesh({ indexVariant })` selects a named list, while an omitted name draws the base `geometry.indices`. The renderer retains, budgets, restores, and releases both maps' index buffers. This separation lets a host submit authored expression geometry and painter-order ranges without treating a draw-range name such as `paint_0` as an expression.

The production entry exports only the generic `createVectorAsset(meshRenderer, compiledAsset)` API; it does not bundle the reference character's compiled geometry. The Seed Scout helper is example-only in `examples/seed-scout.js` and is bundled into the standalone HTML preview, not `dist/vector-assets.js`.

The browser runtime uses the existing `MeshRenderer.createMesh` / `drawMesh` / part pose API. `createVectorAsset(meshRenderer, compiledAsset)` owns one retained GPU mesh and `asset.createPlayer()` creates independent clip state. The resource owns its vertex and index buffers; callers own `MeshRenderer` and `WebGLDevice`. Disposing the asset disposes its players and both buffers but leaves the renderer and device alive.

`vector-effect="non-scaling-stroke"` is supported for a single straight SVG `<line>` with a visible solid stroke and `stroke-linecap="butt"`, `"square"`, or `"round"`. The numeric `stroke-width` is interpreted as CSS pixels. SVG paths, polylines, polygons, zero-length lines, unknown `vector-effect` values, and assets with vertex morph targets fail compilation; they never fall back to the ordinary scaling stroke. A single line has no join, so join and miter behavior do not apply to this supported shape. This scope keeps the authored line centerline and its cap triangles in the same static 11-float mesh; the vertex shader expands only the line vertices after part, object, and camera transforms, leaving any ordinary fills in that mesh unchanged. It does not tessellate or upload geometry per frame. Rotation and non-uniform scale affect the line direction but not its CSS-pixel width.

On the default framebuffer the renderer takes the logical viewport from `canvas.clientWidth` and `clientHeight`, so device-pixel ratio does not change stroke width. When drawing to a render target, pass `strokeViewport: [logicalCssWidth, logicalCssHeight]` to `MeshRenderer.drawMesh()` or the vector player's `draw()` call; the host must provide the CSS-sized viewport represented by the offscreen image. Omitting it on an active render target throws. The ordinary alpha, painter order, depth, clipping, retained-buffer restore, and disposal paths remain in use; clipping evaluates the expanded screen-space edge after converting it back through the projection.

```svg
<line x1="20" y1="50" x2="80" y2="50" fill="none"
      stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"
      vector-effect="non-scaling-stroke" />
```

The compiler/render regression fixture is `tests/non-scaling-stroke.svg`. The browser test measures actual WebGL pixels at multiple CSS viewport sizes, DPRs, camera zoom, and an animated part transform. SVG 2 defines this effect in host/viewport coordinates; Chromium's SVG painter likewise resets to the host transform before painting the stroke ([SVG 2](https://www.w3.org/TR/SVG2/painting.html#VectorEffectProperty), [Chromium `SVGShapePainter`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/svg_shape_painter.cc)).

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

Expressions and explicit part visibility are set on the player. Part pivots and socket coordinates are read from SVG metadata. Authored numeric clip fields are `x`, `y`, `rotation` (radians), `scaleX`, `scaleY`, and `opacity`; clip modes are `once`, `repeat`, and `alternate`. Each asset supports at most 16 parts. Geometry remains static; authored clips transform parts and select expression variants without topology morphing. SVG paint support includes solid fills/strokes and a restricted linear-gradient contract: direct root `<defs><linearGradient>` elements with explicit stops, `pad` spread, object-bounding-box or unitless user-space coordinates, and internal `fill="url(#id)"` references. Gradient stops are split into retained triangles and compiled to vertex RGBA; the GPU does not sample a texture. Generated yarn stroke triangles are split at the same stop boundaries, then each stitch, edge-loop, and fiber vertex samples the authored gradient before its metadata tint is applied. `gradientTransform`, inherited gradients, radial gradients, CSS, text, `use`, arbitrary XML, and full SVG rendering are outside this schema. Scripts, `foreignObject`, external references, embedded raster, doctypes, unknown elements/attributes, and unsupported style values fail compilation. The yarn generator tessellates curved strokes into static triangles and is parameter-driven rather than pixel-identical to another renderer's raster output.

`player.draw({ projection, depth, depthTest, depthWrite, depthFunc })` forwards explicit clip-space depth to `MeshRenderer`. Depth is `[-1,1]`; depth testing and writing default off, so regular 2D assets retain painter-order behavior. The context must have a depth buffer for a depth-tested pass. Transparent actors are still submitted in host painter order; this API does not sort or change scene policy.

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
