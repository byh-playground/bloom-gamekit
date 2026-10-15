# Vector assets

**Public HTML example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

An SVG file is the only authored visual source. `assets/seed-scout.svg` contains paths, paint, strokes, SVG ids, the part hierarchy and pivots, sockets, expression variants, clips, keyframes, easings, and loop mode in one direct JSON `metadata#vector-asset` node. No separately edited visual JSON or raster textures are used.

## Build and runtime

The public example compares that exact authored SVG, the compiled triangle topology, and the real GameKit WebGL 1 mesh in three side-by-side views. It fetches the source SVG directly and checks its SHA-256 against the compiled asset before displaying it; the example derives display-only part groups and poses from the same paths and metadata. One set of clip, time, expression, zoom, and pan controls drives all views. Drag any panel to pan; Center restores the shared camera. On narrow portrait screens the panels stack, while landscape viewports keep all three visible.

The per-view counters state their scope: the source panel reports downloaded SVG bytes and shape count; the topology panel reports compiled triangle/edge counts and Canvas 2D draw CPU time; the GameKit panel reports the selected WebGL 1 instancing path, device draw calls, retained mesh bytes, creation/frame upload bytes, GPU buffer allocation, and renderer/asset initialization time. GPU elapsed time is not inferred from CPU timing; this example reports no GPU milliseconds.

Run `npm run vector-assets:compile` to validate and compile the reference SVG. The regular `npm run build` runs the same compiler and emits `dist/vector-assets.js` as a self-contained ESM bundle. It records the source SHA-256, asset schema version, and compiler version in the compiled asset. Three.js `SVGLoader` 0.186.1 is build-only; its paths are converted once to triangle geometry, including compound fills and strokes, and packed into GameKit's existing 11-float mesh format. Node compilation uses the pinned `@xmldom/xmldom` 0.9.12 DOMParser adapter.

The browser runtime uses the existing `MeshRenderer.createMesh` / `drawMesh` / part pose API. `createSeedScout(meshRenderer)` owns one retained GPU mesh and `asset.createPlayer()` creates independent clip state. The resource owns the mesh; callers own `MeshRenderer` and `WebGLDevice`. Disposing the asset disposes its players and mesh but leaves the renderer and device alive.

Animation data is evaluated by a paused Anime.js v4.5.0 timeline over plain objects. `player.seek(displayTimeMs)` samples a caller-provided display timestamp; no module animation loop, event callback, or game command runs. Snapshot position interpolation remains the host's responsibility. `transitionTo` preserves deterministic time seeks by blending the previous and next clip trees at that same timestamp. Use existing presentation-events/audio APIs for one-shot presentation effects.

```js
import { WebGLDevice, MeshRenderer } from './rendering.js';
import { createSeedScout } from './vector-assets.js';

const device = new WebGLDevice(canvas);
const meshes = new MeshRenderer(device);
const asset = createSeedScout(meshes);
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
