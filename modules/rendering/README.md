# rendering

## Sprite animation

`createSpriteAnimation(context, region, definition)` is independent of SVG. It takes a `VectorContext` and a live region of the device's shared texture atlas (`device.textureAtlas.allocate`), frames with pixel rectangles inside that region and positive `durationMs`, and named clips with ordered frame indices and `loop: 'loop' | 'once'`. An external sprite sheet and an SVG-generated atlas use the same playback API. Every draw goes through `VectorContext.drawQuads`, so sprites of any region, clip and frame share the draw of the surrounding shapes, glyphs and gradients while blend and clip state are unchanged; no mesh or per-texture state exists to split a batch. The per-run UV and local rectangles select the image and preserve trim/pivot, and the caller's matrix composes with the context transform. Playback does not generate pixels or reorder actors by frame.

```js
const REGION = device.textureAtlas.allocate(80, 40);
device.textureAtlas.upload(REGION, SHEET_CANVAS);
const SPRITES = createSpriteAnimation(CONTEXT, REGION, {
    frames: [
        { x: 2, y: 2, width: 32, height: 32, gutter: 2, durationMs: 120 },
        { x: 38, y: 2, width: 32, height: 32, gutter: 2, durationMs: 80 },
    ],
    clips: { walk: { frames: [0, 1], loop: 'loop' } },
});
const PLAYER = SPRITES.createPlayer({ clip: 'walk', startedAtMs: 0 });
PLAYER.draw({ timeMs: displayTimeMs, matrix: MATRIX });
PLAYER.setPaused(true, displayTimeMs);
PLAYER.seek(150, displayTimeMs); // elapsed clip time, then absolute clock anchor
PLAYER.setRate(2, displayTimeMs); // preserves the current phase
SPRITES.dispose(); // invalidates players; REGION stays with its owner
```

Frame rectangles use logical top-left atlas pixel coordinates. `sourceWidth/sourceHeight` describe the untrimmed viewport; `sourceX/sourceY` place the trimmed rectangle in it. `pivotX/pivotY` are viewport pixel coordinates, with top-left as the default. Transparent gutter is outside the content rectangle and must fit in the texture. Set definition.textureOrigin to top-left (default) for ordinary image uploads or bottom-left for a render target. Texture filtering must match the upload source; render-target producers declare the opposite vertical storage orientation to ordinary image uploads. UVs span the content rectangle without shrinking its pixel footprint.

Players sample an absolute caller clock, select one frame and hold it for its duration. There is no geometric interpolation or crossfade. Before the start time the first frame is held; loop clips wrap at total duration and once clips hold the last frame, including large clock jumps. Pause and speed changes preserve phase at the supplied clock time. Clocks and durations must be finite. Region memory and its initialization cost remain the producer's responsibility; context restore re-uploads retained region sources but render-target producers must rebake their pixels.

## Textures in the vector stream

`MeshRenderer` meshes are untextured. Every textured draw (sprites, baked vector runs, posed parts, glyphs, gradient ramps) is a rectangle in the `VectorRenderer` vertex stream, sampled from the device's one `TEXTURE_2D_ARRAY` (`device.textureAtlas`, see below). `VectorContext.drawQuads({ layer, uvRects, localRects, matrix, color, alpha, whiteFlash, forceColor, filter })` appends rectangles on the current transform and clip; with `pose` (a prepared GPU pose handle) and `parts` the runs also follow that pose part, evaluated in the same vertex shader. `uvRects`/`localRects` hold four floats per run `[offsetX, offsetY, extentX, extentY]`; a negative UV height flips a bottom-up render target. Stream vertices are 80 bytes, six per rectangle.

`WebGLDevice.createTextureArray(width, height, layers, { filter })`, `updateTextureLayer` and `isTextureArray` remain the device primitives under the atlas. Retained layer and region sources are re-uploaded after context restore.

**HTML 실행 프리뷰:** [rendering-texture-array](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering-texture-array.html)

`WebGLDevice.stats.imageTexUploadCount` and `imageTexUploadBytes` accumulate successful CPU/DOM image pixel transfers over the device lifetime; they do not reset at `beginFrame()`. `createTexture()` counts a supplied image or byte plane, and `updateTexture()` counts the uploaded region. Retained image pixels uploaded again after context restoration count again. Empty texture allocation, RGBA32F numeric pose data, render-target allocation and GPU atlas baking, and framebuffer-to-texture copies do not count as image uploads. `clearTextureRegion` zeroing of a released atlas rectangle is counted as `regionClears`, not as an image upload. Compare counter snapshots for a frame delta. The existing `textureUploads`/`textureBytes` counters keep their broader meaning; `gpuTextureBytes` measures live logical texture storage, including render-target color textures, so do not add `gpuRenderTargetBytes` to it as another color allocation.

**HTML 실행 프리뷰:** [rendering-vector](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering-vector.html) · [rendering-texture-array](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering-texture-array.html)

게임·시뮬레이션·보간·DOM 입력과 독립적인 **WebGL 2 제출 kernel**입니다. 게임이 그리는 진입점은 `VectorContext` 하나이며, 도형·path·글자·gradient·아틀라스 이미지가 같은 정점 스트림의 draw call 하나로 나갑니다. Canvas2D 전장 fallback은 없고, WebGL 2가 없는 브라우저에서는 생성이 실패합니다. 카메라(중심·zoom·회전·DPR)는 [camera](../camera/README.md)의 `CameraViewport`가 변환 행렬로 넘깁니다.

```js
import { WebGLDevice, VectorContext } from './rendering.js';
import { CameraViewport } from './camera.js';
const device = new WebGLDevice(canvas);
const ctx = new VectorContext(device);
const camera = new CameraViewport({ width: 720, height: 400, dpr: devicePixelRatio, x: 360, y: 200 });
camera.resizeCanvas(canvas); // backing store = CSS 크기 × DPR
const icon = device.textureAtlas.allocate(32, 32, { filter: 'nearest' });
device.textureAtlas.upload(icon, iconCanvas);
if (ctx.beginFrame({ clearColor: [0.03, 0.05, 0.08, 1] })) {
    camera.applyToContext(ctx);
    ctx.fillStyle = [0, 0, 0, 0.3];
    ctx.beginPath();
    ctx.ellipse(pose.x, pose.y, 16, 5);
    ctx.fill();
    ctx.fillStyle = [0.2, 0.8, 0.6, 1];
    ctx.fillRect(pose.x - 12, pose.y - pose.z - 12, 24, 24);
    ctx.drawRegion(icon, 600, 40, 32, 32);
    ctx.endFrame(); // { drawCalls: 1, ... }
}
```

색은 CSS 문자열이나 straight-alpha `[r,g,b,a]`(각 채널 `[0,1]`)이며, 셰이더 경계에서 premultiplied alpha로 바꿔 ONE/ONE_MINUS_SRC_ALPHA로 합성합니다. **호출 순서가 painter order**이고 렌더러는 재정렬하지 않습니다. y-sort·그림자/body/HUD 순서는 게임이 정합니다.

`drawRegion(region, x, y, width, height, { source })`는 Canvas `drawImage`처럼 왼쪽 위 기준으로 아틀라스 영역을 그립니다. `source: [x, y, width, height]`는 영역 안 일부 픽셀을 고릅니다. `device.textureAtlas.upload(region, source, { x, y })`는 영역보다 작은 바이트·DOM 소스를 영역 안 오프셋에 올려 바뀐 부분만 갱신합니다. 프레임 중 이미 올린 영역을 다시 올리거나 해제하면 그 전에 쌓인 draw를 먼저 제출하므로, 앞선 그림은 이전 픽셀을 유지합니다. 새 영역의 첫 업로드는 제출하지 않아 draw가 나뉘지 않습니다. ImageBitmap은 알파 방식을 검사할 수 없어 거부합니다.

### VectorContext and MeshRenderer on one canvas

`VectorContext.createMesh`/`drawMesh`/`drawVectorAsset` share the context's `MeshRenderer` (`acquireMeshRenderer()`). Mesh draws first submit the vector stream queued before them, so vector paint, meshes and later vector paint keep submission order on the same default framebuffer. Meshes that stay on `MeshRenderer` (morph, opacity channel, shader surfaces, force-color fallbacks) are batch boundaries.

## Mesh depth

### SVG non-scaling strokes

The vector-asset compiler retains `vector-effect="non-scaling-stroke"` as a mesh flag and the stroke's tangent/offset data in its existing 11-float records. The vertex shader expands only the marked straight-line cap vertices after camera, object, and part transforms, in logical CSS pixels; other fills in the same mesh keep their original positions. Draws on the default framebuffer use the canvas client size; draws on an active `WebGLDevice` render target must pass `strokeViewport: [logicalCssWidth, logicalCssHeight]` to `drawMesh()`. Omitting the target viewport throws because the physical target dimensions do not identify the logical CSS size. The compiler's supported shape/cap scope and fail-fast behavior are documented in [vector-assets](../vector-assets/README.md).

`MeshRenderer.drawMesh(mesh, { viewProjection, worldMatrix, matrix, clips, depth, depthTest, depthWrite, depthFunc })` also supports a 3D world pass. `viewProjection` and the affine `worldMatrix` are column-major 4×4 matrices; `matrix` remains the optional 2D per-draw transform and is composed into world space. Do not pass `projection` with this mode. Convex clip polygons stay in transformed world XY coordinates, so one world clip can be reused unchanged by actors with different transforms. The mesh and Yarn shader-surface paths use the same clip planes. Clipped non-scaling strokes convert their screen-expanded positions back through the inverse view-projection before evaluating those world-space planes.

`MeshRenderer.drawMesh(mesh, { projection, depth, depthTest, depthWrite, depthFunc })` gives a mesh instance an explicit normalized device depth in `[-1, 1]`. `depthTest` and `depthWrite` default to `false`, preserving the painter-ordered 2D behavior. Request the depth buffer with `new WebGLDevice(canvas, { depth: true })`. `depthFunc` accepts the device's `never`, `less`, `equal`, `lequal`, `greater`, `notequal`, `gequal`, or `always` functions and defaults to `lequal`.

Each `drawMesh()` call can carry a different depth while adjacent calls using the same mesh and depth policy still share the instanced draw. `parts` entries may also supply `depth` in `[-1, 1]`; it is added to that instance's depth. Their sum must remain in `[-1, 1]`. Depth-policy changes split a pending batch so one draw never mixes depth-test/write settings. The renderer does not sort transparent geometry; submit it in the required painter order and normally set `depthWrite: false` for translucent overlays.

The mesh pass writes a clip-space Z value and reasserts depth test/write state for each draw. A following vector stream flush disables depth testing and depth writes before drawing its next ordered pass. A Canvas2D context and a WebGL context cannot both be acquired on one canvas: callers currently drawing a field entirely with Canvas2D need a separate canvas/composition layer or a field-wide move to GameKit WebGL before they can insert meshes into that field's painter order.

When drawMesh() uses depthWrite: true with `depthWriteAlphaThreshold`, it enables depth writes only for contiguous triangles whose three effective vertex alpha values are positive and meet the threshold. Effective alpha includes vertex alpha (unless forceColor replaces it), draw alpha, color alpha, and the opacity of each referenced part. Indexed expression variants are classified in their selected index order. The renderer submits each contiguous run in its original vertex/index order; it never moves opaque triangles ahead of translucent triangles. A mesh that needs several runs is emitted per instance to preserve painter order; one-run meshes retain adjacent instancing. Repeated classifications are reused in a bounded per-mesh cache. Omitting the threshold keeps the existing mesh-wide depthWrite boolean behavior.

### Linear gradients and retained clip contours

`VectorContext.createLinearGradient(x0,y0,x1,y1)` preserves the endpoints and stop data. The gradient captures the current affine transform when created; `addColorStop(offset,color)` keeps the supplied offset/color pairs, including duplicate offsets in insertion order. `fill()` and `stroke()` sample the gradient along its authored vector. The implementation rasterizes a premultiplied 1024×1 RGBA ramp on first use and after stop edits. A gradient supports up to 32 stops; a context retains at most 64 distinct gradient textures in one frame and evicts textures that were not used in the current frame. Gradient paints are supported for vector fills and strokes; text and `fillTriangleFan()` require a solid color.

```js
const gradient = ctx.createLinearGradient(12, 18, 72, 18);
gradient.addColorStop(0, '#ed5445');
gradient.addColorStop(0.35, 'rgba(248, 198, 72, .7)');
gradient.addColorStop(1, '#344cda');
ctx.fillStyle = gradient;
ctx.beginPath();
ctx.roundRect(12, 18, 60, 28, 5);
ctx.fill();
```

`VectorContext.createClipPath(flatXY,{rule})` creates a retained, single-contour clip outside an active frame. The flat input keeps its authored point sequence; triangulation happens once at creation, then the mask triangles are retained and reuploaded after context restoration. The contour may have at most 256 points and must be simple, non-self-intersecting, non-degenerate, and contain no consecutive duplicate points. Current retained clips do not accept holes or multiple contours. At most 64 clip handles and 16 MiB of retained triangle data may be live; a tessellated mask may contain up to 16,384 triangles.

```js
const eggClip = ctx.createClipPath(new Float32Array([18, 12, 82, 12, 92, 44, 82, 78, 18, 78, 8, 44])); // create outside beginFrame()
ctx.beginFrame();
ctx.clipPath(eggClip, { transform: [1, 0, 0, 1, 4, 0] });
ctx.drawMesh(eggMesh);
ctx.endFrame();
ctx.deleteClipPath(eggClip); // only after it is removed from every saved clip stack
```

`clipPath()` intersects the current clip using the active stencil attachment. It fails explicitly if the default framebuffer or active render target has no stencil buffer; it does not approximate a retained concave contour. Up to 255 stencil clips may nest. Stencil state is restored through `save()/restore()`, offscreen opacity groups, context loss, and normal painter-order transitions. Deleting a handle still referenced by an active, saved, or group clip stack throws.

The immediate `clip()` path accepts one convex contour at a time, with at most 1,024 authored points. It remains on the existing convex clipping path while the combined edge planes fit the device limit; excess convex contours use a fan-triangulated stencil mask. Concave or multi-contour input must use `createClipPath()` and `clipPath()`.

### Safe batching for mixed-alpha depth runs

`MeshRenderer` and `VectorContext` default `safeAlphaRunBatching` to `true`; pass `false` to preserve the previous per-instance submission path. It applies only when `depthWriteAlphaThreshold` creates multiple contiguous runs and the device supports instancing. A conservative screen-space bound is built from retained per-part bounds and the current part/morph/object transforms. A new instance batches only when its expanded bound is disjoint from the union bound of the current candidate group, which guarantees disjointness from every earlier instance with constant-time overlap checks. A 1.5-pixel guard covers raster edge/sample coverage. No command crosses an explicit painter boundary, and an overlapping bound, incompatible run pattern, non-affine projection, or non-scaling-stroke mesh ends the candidate batch and preserves the old draw order.

The bounds are computed from per-part ranges retained at mesh creation; the renderer does not rescan or tessellate triangles each frame. `stats()` distinguishes actual `draws` from `instances` and reports `alphaRunSafeBatches`, `alphaRunBatchedInstances`, `alphaRunDrawsSaved`, `alphaRunSafeRunDraws`, `alphaRunImmediateRunDraws`, `alphaRunOverlapBoundaries`, `alphaRunSignatureBoundaries`, `alphaRunUnbatchableBounds`, `alphaRunImmediateInstances`, `flushReasons`, and `drawDispatchReasons`. Flush reasons count queue boundaries; dispatch reasons classify every `device.draw()` issued by this renderer, so their total equals `draws`. These are submission counters, not GPU timing measurements.

`npm run test:rendering:vector-gradient-clip` covers gradient pixels at 47px and 74px, a 160-point concave clip through vectors/meshes/groups, limits, context restoration, and disposal. `npm run test:rendering:alpha-run-batching` compares fixed overlapping and disjoint mixed-alpha units against the original per-unit painter order using browser `readPixels`; it is a correctness test, not a performance benchmark.

## 공유 텍스처 atlas 배열

`device.textureAtlas`(`TextureAtlasArray`, 옵션 `new WebGLDevice(canvas,{ textureAtlas:{width=2048,height=1024,layers=2,gutter=1} })`)는 작은 이미지를 한 `TEXTURE_2D_ARRAY`의 영역(region)으로 나눠 담는 장치 단위 단일 원본입니다. `allocate(w,h,{filter})`는 `{layer,x,y,width,height,uvRect,filter}`를 돌려주고 `upload(region,source,{premultiplied,extendEdges})`가 픽셀을 씁니다(`extendEdges`는 바이트 소스의 가장자리를 gutter로 복제해 CLAMP_TO_EDGE처럼 보이게 함). `release(region)`은 픽셀을 지우고 같은 크기 요청에 재사용하며, 마지막 region을 풀면 배열도 삭제됩니다. 영역 업로드는 `Device.updateTextureRegion`이 원본을 보관해 컨텍스트 복구 때 다시 올립니다. `filter:'nearest'` region은 배열의 하드웨어 필터가 하나뿐이므로 셰이더가 texel 중심으로 맞춥니다.

`VectorRenderer`의 흰 texel, `VectorContext`의 gradient ramp, `GlyphAtlas` 페이지가 모두 이 배열의 region입니다. 정점은 layer·gradient 종류(없음/선형/radial/radial 빈 영역)·white flash·nearest 여부·radial 파라미터·ramp 사각형을 담아(정점당 80바이트), 같은 blend·clip 상태의 fill, 선형·radial gradient, 글리프가 한 draw로 제출됩니다. 배치를 끊는 것은 blend 전환, stencil clip 변경, 반투명 group(render target을 다른 sampler로 합성)뿐입니다. `drawGlyphQuad(region, x, y, w, h, uv, color)`의 `uv`는 배열 좌표이고 `GlyphAtlas`가 callback에 주는 `texture`는 `region`으로 바뀌었습니다. gradient 객체의 `texture`도 `region`입니다.

## VectorContext와 재사용 primitive painter

`VectorContext(device,{vectorRenderer,glyphAtlas,onError,initialVertices,maxVertices})`는 게임의 2D draw adapter에서 반복되기 쉬운 paint/state/path 알고리즘을 공개합니다. canvas와 WebGL context, 프레임 자원은 caller가 만들고, 이미 사용하는 `VectorRenderer`와 `GlyphAtlas`를 주입하면 같은 painter queue와 glyph texture를 공유합니다. vector를 생략한 경우에만 context가 VectorRenderer를 만들고 해제합니다. WebGLDevice와 GlyphAtlas는 항상 caller 소유이며 import만으로 DOM·GPU·asset 작업을 하지 않습니다.

```js
import { WebGLDevice, VectorRenderer, VectorContext, PrimitivePainter } from './rendering.js';
const device = new WebGLDevice(canvas, { depth: false, stencil: false });
const vector = new VectorRenderer(device, { glyphAtlas });
const ctx = new VectorContext(device, { vectorRenderer: vector, glyphAtlas, onError: reportRenderError });
const primitive = new PrimitivePainter(ctx, { point: transformArtPoint, alphaMultiplier: () => artAlpha });
if (ctx.beginFrame({ width: canvas.width, height: canvas.height, clearColor: [0, 0, 0, 0] })) {
    ctx.fillStyle = 'rgba(32, 78, 54, .8)';
    ctx.beginPath();
    ctx.roundRect(24, 20, 110, 52, 8);
    ctx.fill();
    ctx.strokeStyle = '#d9f3ad';
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    const glow = ctx.createRadialGradient(80, 100, 0, 80, 100, 18);
    glow.addColorStop(0, '#fff8d0');
    glow.addColorStop(1, '#fff8d000');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(80, 100, 18, 0, Math.PI * 2);
    ctx.fill();
    primitive.circle(80, 100, 12, '#f1f8d7', 12); // 원래 authored fan topology 유지
    primitive.ellipse(40, 100, 16, 6, 'rgba(0,0,0,.4)', 24); // 중심, 반지름 x/y, 색, 분할 수, 회전
    primitive.box(120, 100, 40, 4, '#44e5ff'); // 중심 기준 사각형(왼쪽 위 기준인 fillRect와 다름), 마지막 인자는 회전
    ctx.endFrame();
}
```

- path/state API는 CSS hex/rgb(a)/hsl(a)/named paint, alpha, affine transform, curve, arc/ellipse/rect/roundRect, fill/stroke, dash, clip, scoped color, silhouette/group, prebaked atlas text의 metrics와 그리기를 제공합니다. `filter`는 `none`과 게임 white-flash 값 `brightness(0) invert(1)`을 지원하며 save/restore에 포함됩니다. `globalCompositeOperation`은 `source-over`(기본)와 가산 `lighter`만 지원하고 다른 값은 `RangeError`입니다. 단순 도형 painter와 vector path/stroke/text에 같은 모드가 적용되고 save/restore에 포함됩니다. 프리미얼티플라이드 색을 ONE/ONE으로 더하므로 `lighter`의 glow는 alpha만큼 더해지고 1에서 포화합니다. 모드는 frame을 넘어 유지되므로(globalAlpha처럼) caller가 필요한 범위에서 복원합니다. 정적 mesh·pose 그리기는 이 값을 따르지 않고 자체 `blend`를 씁니다. 흰색 변환은 강제색을 결정한 뒤 RGB만 흰색으로 바꾸고 alpha는 보존합니다.
- `createRadialGradient(x0,y0,r0,x1,y1,r1)`는 두 원의 중심과 반지름, 생성 시 transform, 정렬된 color stop을 보존합니다. Fragment shader가 Canvas의 두 원뿔(cone) 매개변수를 계산해 기존 premultiplied 256x1 ramp를 샘플링합니다. 같은 원 두 개는 아무것도 그리지 않고 cone 바깥 fragment는 버려 이전 paint를 유지합니다. 좌표는 유한수, 반지름은 0 이상이어야 하며 singular 생성 transform은 제출 시 명시적으로 오류가 납니다. Gradient texture 재사용, stop 수정 시 queue flush, alpha, painter order, endFrame 정리는 기존 계약을 따릅니다. [Canvas radial-gradient construction](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-createradialgradient)과 실제 픽셀 검증은 `npm run test:rendering:vector-gradient-clip`에서 47px 및 74px 크기로 확인합니다.

- `fillTriangleFan(points,paint)`는 caller가 정의한 fan topology를 삼각형 재분할 없이 공통 clip/group 경로로 제출하고, `VectorRenderer` private method를 호출하지 않습니다. `PrimitivePainter(target,{point,alphaMultiplier})`는 WebGL `VectorContext`와 caller가 전달한 native Canvas2D paint target 양쪽에 `poly/tri/quad/regularPolygon/circle/hex/line/fan`을 제공합니다. target 쪽에서는 하나의 path fill로 원래 fan을 그리고, `point(x,y)` hook은 caller의 authored facing만 반영합니다. UI thumbnail은 기존의 명시적인 native Canvas2D target을 전달할 수 있습니다. world draw는 WebGLContext가 담당합니다.
- `withGroupOpacity(opacity,callback,bounds)`는 그룹 opacity를 딱 한 번 합성하고 callback 안에서 globalAlpha를 1로 둔 뒤 원래 상태를 복구합니다. `withSilhouette(color,width,paint,radius)`는 opacity-bounded group 안에서 강제색 offset fan과 중심 pass를 그리고, forceColor를 복구한 뒤 원래 body를 한 번 더 그립니다. 기존 clip/filter와 draw order를 보존합니다.
- `drawMeshSilhouette(mesh,{transform,morph,parts,color,width,radius,outlineScale})`는 silhouette와 본체를 painter order대로 제출합니다. `outlineScale`을 생략하면 기존 8방향·중심 outline 9개와 body를 쓰며, `outlineScale >= 1`이면 변환 중심 기준으로 확장한 outline 1개와 body 1개를 씁니다. 두 경로 모두 색/forceColor, 현재 및 local transform, morph/parts, clip, white-flash, globalAlpha와 group opacity를 캡처합니다. ANGLE WebGL1에서 확장 경로는 2 instance/128 bytes, 기본 경로는 10 instance/640 bytes이며, uniform fallback도 각각 2회/10회 draw합니다. 확장 경로는 silhouette callback과 pixel-identical하지 않은 모양 근사이므로 필요한 게임 아트에서만 명시하고 실제 화면을 확인하세요. 임의 path/vector callback에는 generic `withSilhouette`을 그대로 사용합니다.
- Stroke 폭은 기존 게임 adapter와 같이 변환 행렬 basis 중 큰 크기에 맞춰 조정합니다. dash 길이와 phase는 변환된 path 공간에 적용합니다. 공통 vector stroke는 butt/round/square cap, miter/round/bevel join을 그리며 miter 길이는 `miterLimit`으로 제한합니다. clip 호출 하나에는 contour 하나를 받습니다. path hole은 clip 대신 `fill(rule)`로 처리합니다.
- `beginFrame({width,height,clearColor})`와 `endFrame()`은 caller 소유 `WebGLDevice` 프레임을 감쌉니다. begin이 false이면 context loss 등으로 해당 프레임을 건너뜁니다. `stats()`는 실제 device draw/vertex/upload counter, GPU buffer/target byte와 개수, vector staging byte를 보고합니다. `dispose()`는 이 context가 생성한 VectorRenderer, gradient texture, static vertex buffer만 해제하며 device나 주입받은 atlas/renderer는 해제하지 않습니다. static vertex 데이터는 context 복구 후 다시 upload합니다. `onError(error,details)`는 caller callback이며 프레임 오류는 다시 throw됩니다.
- `createStaticMesh(vertices,{strideFloats})`는 재사용할 CPU vertex를 보관하고 device buffer에 upload합니다. `drawStaticMesh(mesh,{pipeline,projection,uniforms,textures,blend,depth})`는 caller draw 전에 공통 painter queue를 flush합니다. shader/material, projection uniform, depth/stencil 설정, pass 순서와 mesh geometry는 caller가 공급합니다. generic context는 terrain 정책을 정하지 않습니다.
- radial gradient는 fill이 있는 frame 동안 gradient 객체당 256×1 RGBA ramp 1KiB와 GPU texture 1KiB를 사용합니다. 같은 frame의 repeated fill은 한 texture를 재사용하며 stop 추가는 그 handle만 update합니다. `endFrame()`에서 submit 뒤 GPU handle과 CPU ramp를 evict하므로 frame을 거쳐 계속 생성되는 gradient 객체를 context가 강하게 보관하지 않습니다. texture sampling으로 각 fragment의 반경을 계산합니다.
- `PrimitivePainter`는 authored fan을 Canvas2D target에서 한 번의 path fill로 제출하고, WebGL target에서는 원래 fan 삼각형을 공용 vector buffer에 queue합니다. 배치 변경 전 실제 game-shaped browser helper에서 WebGL 26 draw calls / 1,170 vertices / 37,440 uploaded vertex bytes, 19,456 texture upload bytes, vector staging/GPU buffer 각 8KiB, opacity target 16KiB를 관찰했습니다. CPU submit은 한 SwiftShader scene 표본에서 13.2ms였고 GPU 완료시간은 아닙니다. UI Canvas2D primitive 두 개의 CPU submit은 0.7ms, 40×40 RGBA reference와 pixel 차이 0이며 해당 paint target의 GPU upload는 0입니다.
- 같은 helper가 새 gradient 객체 16개를 4 frame에 걸쳐 만들고 frame당 반복 fill/stop update를 확인합니다. `activeGradientTextureCount`는 각 endFrame에서 0으로 돌아오고, GPU textureCount는 같은 2개 baseline에 머뭅니다(내부 white texture와 재사용 opacity target). 각 ramp는 1KiB의 transient CPU bytes이며 texture stop update는 같은 frame 안에서 texture identity를 유지합니다. 이 제한된 SwiftShader fixture는 게임 전후 FPS 비교가 아닙니다.
- world Canvas2D fallback, 숨겨진 raster canvas, CPU readback, runtime text rasterization, font metric/kerning 변경은 없습니다. PrimitivePainter의 native target은 caller가 건넨 canvas의 draw API에 직접 path를 내보내며 숨겨진 canvas나 GPU staging을 만들지 않습니다. CSS named color는 browser document가 있을 때만 일시적인 DOM style element로 해석하며, 문서가 없어도 모듈을 import할 수 있습니다.

Static mesh는 별도 GPU vertex buffer와 caller 소유 shader pipeline을 사용합니다. VectorRenderer stream에 더해지는 GPU memory이며 `deleteStaticMesh()` 또는 `dispose()`로 해제됩니다.

### 재사용 MeshBuilder / MeshRenderer

같은 authored 도형을 여러 객체·프레임에서 그릴 때 `MeshBuilder`로 한 번 만들고 `VectorContext.createMesh()`로 GPU에 보관합니다. `PrimitivePainter`는 builder에도 직접 그립니다. 이미지·Canvas2D raster·시뮬레이션 상태·내부 시계는 사용하지 않습니다.

```js
const shape = new MeshBuilder();
new PrimitivePainter(shape).circle(0, 0, 12, '#a8c991', 10);
const mesh = ctx.createMesh(shape.build()); // cold path, 프레임 밖에서도 가능
ctx.beginFrame();
for (const pose of depthSortedPoses) {
    ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, pose.x, pose.y] });
}
ctx.endFrame();
ctx.deleteMesh(mesh);
```

- `MeshBuilder({maxVertices=262144})`는 local-space `fillTriangleFan(points,paint)`와 `globalAlpha`를 받습니다. `build({morphs=[]})`의 최대 두 target은 같은 삼각형·색 순서여야 하며 다른 위치만 허용합니다. 결과의 vertex stride는 position2 + RGBA4 + 두 position delta2 + part index1, 44 bytes입니다. 애니메이션 시각을 양자화하거나 프레임별 메시를 만들지 않고 `drawMesh(mesh,{morph:[weight0,weight1]})`로 연속 변형합니다. 회전·날개 같은 비선형 동작의 분할과 값은 게임 아트가 정의합니다.
- `MeshBuilder.combine([partGeometry,...])`는 최대16개의 single-part geometry를 **삼각형 순서 그대로 한 GPU 메시**로 합칩니다. `drawMesh(mesh,{parts:[{transform,morph,visible},...]})`에 각 part의 local affine·두 morph weight·표시 여부를 전달합니다. 생략한 part 값은 identity/0/visible이며 배열 길이는 partCount와 같아야 합니다. part morph에 draw-level morph가 더해지고, part transform 다음에 instance/context transform이 적용됩니다. visibility는 강제색 뒤 alpha에 적용해 outline에서도 숨긴 조각이 보이지 않습니다. 한 메시의 파트를 별도 draw로 쪼개거나 silhouette 반복 사이에 끼워 넣지 않습니다. part pose 값이 다르면 batch를 끊으며 전달된 배열을 나중에 바꿔도 이미 queue한 값은 바뀌지 않습니다.
- `VectorContext.createMesh(data)` / `drawMesh(mesh,{transform,morph})` / `deleteMesh(mesh)`는 이 context의 handle만 받습니다. 선택적 local affine transform은 현재 context transform과 합성합니다. globalAlpha·forceColor·white-flash·clip·opacity group을 캡처하며, 벡터 path/text/static mesh와 섞어도 호출 순서를 유지합니다. 외부 pass나 readPixels 전에 `ctx.flush()`를 사용합니다. `ctx.vector.flush()`는 vector 소유 queue만 제출하므로 mesh를 포함하는 프레임 경계로 사용하지 않습니다.
- 기본 `drawMeshSilhouette` 경로는 같은 retained mesh pose의 10개 color/transform instance를 한 번에 append해 callback 반복과 per-instance submit을 없애지만 instance 업로드와 overdraw는 유지합니다. 선택적 `outlineScale` 경로는 outline용 복제 mesh를 한 번만 내어 instance 업로드와 overdraw를 줄이는 대신 기존 8방향 외곽선과 픽셀 모양이 달라집니다. 색상·순서·재사용 handle 및 context 복구는 `tests/mesh.browser.mjs`의 실제 WebGL E2E에서 검사합니다.
- MeshRenderer의 part transform/morph 유한값 검증은 입력 배열을 직접 순회하고, 생략된 morph/clip 상태는 불변 기본값을 공유합니다. 따라서 part마다 `Array.from` 검증 복사본과 `[0,0]` morph 배열을 만들지 않지만, 값 검증·part packing·instance 업로드 비용은 남습니다.
- 내부 `MeshRenderer(device,{maxMeshes=512,maxMeshBytes=33554432,maxInstances=2048})`는 같은 mesh·projection·clip의 **인접 호출만** 합칩니다. 게임의 y-sort를 바꾸거나 다른 메시를 재정렬하지 않습니다. 직접 사용할 때 `drawMesh(mesh,{matrix,projection,morph,color,forceColor,alpha,whiteFlash,clips})`와 `flush()`를 호출하고 외부 pass 전 flush 책임을 집니다. clip은 기존 vector와 같은 convex half-plane 교집합이며, edge plane 상한은 `min(32, MAX_FRAGMENT_UNIFORM_VECTORS-2)`입니다. 넘으면 명시적으로 거부하고 clip을 무시하지 않습니다.
- WebGL 2 core instancing은 static geometry와 64-byte instance 값을 사용합니다. 호환되는 연속 제출만 합치며 서로 다른 재질·표정 index buffer·벡터 paint·opacity target 경계는 유지합니다. 모든 유닛이 한 draw라는 보장은 없습니다.
- mesh clip은 fragment half-plane discard입니다. 벡터의 CPU 삼각형 clip과 내부/외부는 같지만, 직접 MSAA target의 회전 clip 경계는 sample coverage가 달라질 수 있습니다. 따라서 해당 경계를 pixel-exact parity로 주장하지 않습니다. 정수 pixel의 축 정렬 opacity bounds와 일반 authored mesh 실루엣은 별도로 실제 화면에서 확인합니다.
- partIndex는 FLOAT attribute 하나이며 두 morph를 vec4 하나에 담아 vertex/instance attribute 총8개(WebGL1 최소 보장)를 사용합니다. part uniform은 최대48vec4 + projection/instance 값이며 최소 vertex uniform128vec4 안에 들어갑니다. shader는 partCount(1..16)·morphCount(0..2)·clip 유무에 따라 첫 제출 때 생성해 보관합니다(최대96개, 실제 pipelineCount 계측). 사용하지 않는 조각 배열·변형·fragment clip 경로를 컴파일하지 않습니다. 단일 part의 transform/morph/visibility는 CPU에서 instance 값에 한 번 합쳐 vertex별 part 연산을 없앱니다. 불투명 direct group은 GPU pass 변경이 아니므로 인접한 유닛 batch를 끊지 않으며, 실제 opacity target 경계는 반드시 flush합니다. 초기 shader compile·program 보관과 균일하지 않은 part pose의 uniform 갱신 및 shader 변형 연산은 추가 비용이므로 geometry upload 감소를 FPS 개선으로 환산하지 않습니다.
- `partUniformBytesSubmitted`는 draw마다 제출한 part pose uniform 데이터 길이이며 vertex/instance buffer upload와 별개입니다(실제 GPU 버스 전송량 측정은 아님). default instance CPU staging128KiB에 plane/part scratch 최대1,152 bytes가 추가되며 `stagingBytes`는 둘을 포함합니다. 순간적인 queue projection/part 값 복사와 caller의 pose 배열 할당은 별도입니다.
- 기본 최대 retained vertex payload는 CPU 32MiB + GPU 32MiB이며 instance staging CPU 128KiB와 지원 시 GPU 128KiB가 추가됩니다. 실제 GPU allocation은 device counter를 확인합니다. 초기 build/upload·shader compile·캐시 miss는 cold 비용이고, 게임이 종류/스타일별 bounded cache와 eviction을 소유합니다. SDK는 살아 있는 handle을 임의로 지우지 않고 예산 초과를 거부합니다. createMesh는 caller geometry를 복사해 보관하고 복구 시 한 번 재업로드합니다. 삭제는 해당 pending draw를 먼저 제출하고 자원을 해제합니다. dispose는 잔여 queue를 버리고 모든 메시와 listener를 해제합니다.
- `ctx.stats().mesh`는 실제 mesh draw/instance 수, 프레임별 geometry/instance upload bytes, meshCount, retainedBytes, stagingBytes, instanced, state/failure를 보고합니다. `device.stats.vertices`는 실제 instance 수를 포함한 제출 vertex 수이지 retained 고유 vertex 수가 아닙니다. 재사용은 GPU geometry·픽셀 fill 비용을 없애는 것이 아니라 반복 CPU 생성과 geometry upload를 줄입니다. 측정 전 FPS 개선을 단정하지 않습니다.

### VectorRenderer와 prebaked GlyphAtlas

`VectorRenderer`는 같은 canvas를 소유한 `WebGLDevice` 위에서 path tessellation·transform·clip·painter-order stream·textured glyph 제출을 제공합니다. 프레임·projection·정렬과 그림 내용은 caller가 소유합니다. 인접한 fill·stroke·fan·glyph는 texture/radial/white-flash 상태가 같으면 재사용 geometry buffer에 순서대로 누적합니다. transform·clip·색은 각 vertex를 만들 때 반영되므로 과거 geometry를 변경하거나 재정렬하지 않습니다. texture 상태 변경, group 경계, capacity, 명시적 flush에서 제출합니다. CPU/GPU vertex storage는 기본 4096 vertices(각 128 KiB)에서 시작해 필요할 때 2배로 자라며 기본 상한은 262144 vertices(각 최대 8 MiB)이며 device.maxBufferBytes가 더 작으면 그 안으로 제한합니다. 상한은 한 batch의 저장 한도이고, 초과 geometry는 삼각형 경계에서 제출한 뒤 계속 처리합니다. 긴 인접 stream은 과거의 경로별 즉시 제출보다 staging high-water가 커질 수 있으므로 작은 상한으로 메모리/호출 수를 조절하세요. `beginGroup(opacity,bounds)`는 불투명 기본값 `1`이면 target 없이 직접 경로를 유지하고, 반투명 그룹은 canvas-screen bounds의 RGBA target에 그린 뒤 한 번 합성합니다. 생략한 bounds는 viewport 전체입니다. target은 중첩 깊이별로 보관되고 필요한 크기의 다음 power-of-two 버킷으로 할당되어 작아지는 bounds와 인접한 크기에서는 재사용됩니다. bounds보다 바깥의 입력은 잘립니다. `stats.gpuRenderTargetBytes`로 실제 target byte 수를 확인하세요.

```js
import { WebGLDevice, VectorRenderer, FontAssetLoader } from './rendering.js';
const device = new WebGLDevice(canvas, { alpha: true, depth: false, stencil: false });
const font = new FontAssetLoader(device, pinnedFontSource, { onProgress: showFontProgress });
const atlas = await font.ready;
const vector = new VectorRenderer(device, { glyphAtlas: atlas });
device.beginFrame({ clearColor: [0, 0, 0, 0] });
vector.beginGroup(0.5, { x: 80, y: 60, width: 240, height: 160 });
vector.polygon(
    [
        [90, 80],
        [200, 80],
        [170, 170],
        [100, 150],
    ],
    [1, 0.2, 0.1, 1],
);
vector.endGroup();
vector.beginPath();
vector.moveTo(80, 200);
vector.quadraticCurveTo(160, 130, 240, 200);
vector.stroke([0.3, 0.9, 0.6, 1], 3);
vector.fillText('label', 200, 250, { fontSize: 18, align: 'center', baseline: 'alphabetic', color: [1, 1, 1, 1] });
vector.flush();
device.endFrame();
```

- Paths use pixel coordinates in the device backing viewport. `moveTo`/`lineTo`, quadratic/cubic Bezier sampling, `closePath`, `fill` (`nonzero`/`evenodd`), `stroke(width)`, `polygon`, affine transforms, save/restore, and nested rectangular clips are supported. Curves default to 12/16 segments and accept an explicit 2..256 segment count. Fills use scanline trapezoid tessellation over flattened contours; inputs should be finite, non-self-intersecting contours. It supports holes with even-odd winding, not self-intersection repair.
- `beginGroup(opacity,bounds)` bounds are in the renderer's pixel coordinate space. A target is bucketed to power-of-two dimensions and reused by depth; content is clipped to requested viewport intersection. Worst-case allocation may approach 4× requested area due to independent width/height buckets. Target texture memory is RGBA8 (`4 × allocated width × allocated height` bytes per nesting depth); there is no CPU readback. Targets are color-only; game depth/stencil passes remain separate. Allocation and clear bandwidth are additional costs and target creation is a cold path.
- `GlyphAtlas(device,{width,height,data,glyphs,unitsPerEm,ascent,descent,filter,missingGlyph,replacement})` takes retained top-left-origin RGBA bytes and code-point-keyed metrics `{x,y,width,height,advance,bearingX,bearingY}`. Metrics are atlas pixels plus font-relative units. It uploads once and performs no runtime Canvas2D measurement/rasterization, crop, or pixel readback. `measureText` reports width/ascent/descent. `fillText` and `strokeText` accept `fontSize`, `align` (`left|center|right`), `baseline` (`top|hanging|middle|alphabetic|ideographic|bottom`), and RGBA color. The default missing-glyph mode throws; `skip` and explicit replacement are opt-in. Text draw calls batch adjacent glyphs from the same atlas.
- `FontAssetLoader(device,{url,version,sha256,bytes},{signal,onProgress})` fetches a caller-selected asset over CORS, checks the exact byte count and SHA-256 before parsing, validates its schema and decoded mask hashes, then resolves `ready` to a `GlyphAtlas`. Its states are `loading`, `ready`, `error`, `cancelled`, and `disposed`; progress phases are `download`, `verify`, `decode`, `ready`, `error`, `cancelled`, and `disposed`. Supply an explicit immutable URL/version/hash/byte tuple. `cancel()` stops that loader from becoming ready; a shared in-flight fetch continues for other consumers and may complete into the browser's HTTP cache. `dispose()` releases its per-device atlas lease; the last lease deletes the GPU texture and retained pixels. Failed loads are removed from the in-memory cache so a later loader can retry. Identical version/hash pairs share one in-flight fetch and CPU decode within the current JavaScript realm; identical pairs on one `WebGLDevice` also share one atlas texture by reference count. Other tabs, browser processes, origins, and top-site partitions depend on browser HTTP cache policy and are not promised to share bytes. This API does not write CacheStorage.
- The published `noto-sans-kr-700-v1` asset covers exactly its versioned 750-codepoint inventory (including 585 Hangul syllables); it does not claim full Korean or Unicode coverage. Missing codepoints throw by default. A caller chooses its asset and handles a missing glyph explicitly; expanding or replacing the inventory requires a new asset version, new SHA-256/byte metadata, and a manifest update. The font program is not downloaded. The Noto Sans KR OFL license and inventory/generator provenance are stored alongside the prebaked mask and metrics.
- `VectorRenderer.flush()` submits all queued path/fan/glyph vertices. Direct users must flush before device.endFrame(), pixel readback, device.clear(), texture update/delete, or another renderer/device pass. VectorContext handles its own frame and mesh/gradient boundaries. `dispose()` releases its pipeline, stream buffer, white texture, and group targets. Dispose `GlyphAtlas` separately. The shared `WebGLDevice` remains caller-owned.

The [native rendering example](./examples/vector/index.html) demonstrates polygon/curve/text/clip/group composition. The browser E2E reads actual WebGL pixels for alpha 128, fill holes, clipping, glyphs, nested opacity, bounded target allocation and target restoration. This validates the reference Chromium WebGL1/SwiftShader path, not mobile GPU performance. Path flattening, scanline tessellation, clip-polygon intersections, geometric glyph outlines, staging growth, uploaded vertex bytes and render-target clears add CPU/GPU work; the example reports CPU submission time (not GPU completion) and counters for its one small scene, not a device-wide benchmark.

요구 근거는 [Budmori 88c93e7](https://github.com/byh-playground/budmori-io/blob/88c93e713d6bc2b4f081c24a99e536d497a5799b/index.html)의 geometry stream·명시적 texture invalidation·painter order와 [Rally f6037f0](https://github.com/byh-playground/rally-frontier/blob/f6037f05e0ff2163fc11cf0f770e2bc071eaa291/index.html)의 game-owned projection·presentation-only buffer입니다. 해당 게임 코드를 변경하거나 통째로 복사하지 않았습니다. 통합 검사는 [실제 브라우저 E2E](../../project/tests/browser.e2e.mjs)를 보세요.

## WebGLDevice: 게임이 만든 geometry/pass를 제출하는 공통 GPU core

Budmori의 FPV11 texture/gradient/white-mask stream과 Rally의 xyz/depth·alpha-cutoff·두 fog texture·frame composition을 같은 GPU 자원 경계로 처리합니다. `WebGLDevice`는 canvas의 WebGL 2 context를 소유하는 낮은 수준 API이고, 게임은 그 위의 `VectorContext`로 그립니다.

게임에 남는 것: path/curve tessellation, art/text atlas 내용과 갱신 version, GLSL material 정의, fog 판단, 카메라/projection, pass 순서와 depth/stencil 정책. 공통 core가 소유하는 것: context·shader compile/link·attribute/uniform binding·GPU buffer/texture 생성과 upload·draw state·실제 draw call·context 복구·dispose. shader 정의만 바꿔 다양한 게임을 지원하며 Canvas2D 전장 fallback은 없습니다.

```js
import { WebGLDevice } from './rendering.js';
const device = new WebGLDevice(canvas, { depth: true, stencil: true });
const pipeline = device.createPipeline({
    vertex: gameVertexShader,
    fragment: gameFragmentShader,
    stride: 28, // bytes: xyz + rgba
    attributes: [
        { name: 'a', size: 3, offset: 0 },
        { name: 'ac', size: 4, offset: 12 },
    ],
    uniforms: { r: '2f' },
});
const buffer = device.createVertexBuffer({ capacityBytes: 28 * 16384 });
if (device.beginFrame({ width: canvas.width, height: canvas.height })) {
    device.uploadVertices(buffer, gameGeometry.view());
    device.draw({
        pipeline,
        buffer,
        first: 0,
        count: gameGeometry.length / 7,
        uniforms: { r: [canvas.width, canvas.height] },
        blend: 'straight-alpha',
        depth: { func: 'lequal', write: true },
    });
    device.endFrame();
}
```

### 생성·자원 계약

- `new WebGLDevice(canvas,{alpha=false,antialias=true,depth=true,stencil=true,preserveDrawingBuffer=false,powerPreference='default',failIfMajorPerformanceCaveat=false,checkGLErrors=false,maxTextures=8,maxBufferBytes=134217728})`. WebGL 2 전용이며 canvas의 GPU 자원을 소유합니다. `gl`은 읽기 진단/상수/context-loss 테스트용입니다. 직접 GL state 변경은 지원하지 않습니다. `maxTextures`는 실제 fragment texture unit 한도 이하로 정해지고 `maxTextureSize`도 공개합니다.
- `powerPreference`는 `default`/`low-power`/`high-performance`만, `failIfMajorPerformanceCaveat`는 boolean만 허용하며 context 생성 전에 검사합니다. 두 값을 `getContext('webgl', options)`에 그대로 전달합니다. GPU 선택은 브라우저의 hint 처리이며 특정 GPU나 성능을 보장하지 않습니다.
- `checkGLErrors`는 boolean 개발 진단 옵션입니다(기본 false). 반복 `updateTexture`/`copyFrameToTexture`에서 동기식 `gl.getError()` polling은 true일 때만 합니다. 새 texture allocation과 첫 RGB copy storage 전환, shader compile/link 검사는 항상 유지합니다. CPU 인자·크기·범위 검증도 유지합니다. production에서는 드라이버 오류를 매 호출마다 즉시 보고하지 않으며 진단/테스트는 이 옵션 또는 명시적 프레임 경계 검사를 사용하세요. 오류 검사는 GPU 완료 대기를 유발할 수 있으므로 측정 시 옵션을 기록합니다.
- `createPipeline({vertex,fragment,stride,attributes,uniforms})`: GLSL ES 1.00 shader 문자열, 4-byte 정렬 stride(4..252), FLOAT attribute `{name,size:1..4,offset}`. uniform descriptor는 `1f/2f/3f/4f/1i/2i/3i/4i/1iv/1fv/2fv/3fv/4fv/matrix3fv/matrix4fv`입니다. sampler는 1i 또는 1iv로 texture unit을 정합니다. 예: array 첫 위치 이름 `u_tex[0]`. 최적화로 사라진 attribute/uniform은 건너뜁니다. shader compile/link 실패는 throw하고 임시 GPU 자원을 해제합니다.
- `createVertexBuffer({capacityBytes=0})`, `uploadVertices(handle,Float32Array)`: caller view를 동기 upload하며 다른 CPU arena에 복사하거나 붙잡지 않습니다. 필요할 때만 GPU capacity를 두 배씩 늘리며 maxBufferBytes 초과는 거부합니다. 마지막 upload의 used bytes 밖 draw는 거부합니다. `deleteVertexBuffer`, `deletePipeline`은 반복해도 false를 반환하는 명시적 해제입니다.
- `createTexture(fullSource,{format='rgba',premultiplied=false,filter='linear'})`: source는 image/canvas 또는 `{width,height,data}`. rgba data는 4채널, luminance data는 1채널의 byte 배열입니다. data:null은 비어 있는 GPU texture로 frame composition 등에 사용합니다. NPOT·nearest/linear·CLAMP_TO_EDGE를 지원합니다. raw rgba 기본값은 straight alpha이며 CPU에서 한 번 premultiply합니다. 이미 premultiplied인 gradient bytes에는 true를 명시하세요. DOM source는 rgba/default alpha 옵션만 사용합니다. ImageBitmap은 거부합니다.
- `updateTexture(handle,fullSource,{x=0,y=0,width=handle.width,height=handle.height})`: 크기가 같은 **전체 source**와 변경 region을 전달합니다. GPU에는 region만 texSubImage2D로 갱신하지만 복구 원본은 전체 source입니다. raw bytes는 복사하여 보존하고 DOM은 참조를 보존합니다. DOM atlas crop에는 자산 region 전용 작은 Canvas2D를 재사용하며 전장 frame을 rasterize하지 않습니다. 원본이 resize되면 새 handle을 만들고 이전 것을 삭제하세요.
- `copyFrameToTexture(handle,{x=0,y=0})`: 현재 resolved framebuffer에서 RGBA texture 전체 크기만큼 GPU copy합니다. 좌표는 WebGL framebuffer의 아래/왼쪽 기준입니다. CPU world-canvas upload가 아닙니다. alpha:false context에서는 RGB copy 호환성에 맞게 첫 copy 때 RGB storage로 전환합니다(이후 같은 크기는 재사용). copy texture를 다시 updateTexture하면 전체 source로 storage를 재구성합니다. copy 후 복구 원본은 blank가 되므로 복구 후 새 frame에서 다시 copy하세요. 이전 texel은 시뮬레이션 상태가 아닙니다.
- `deleteTexture(handle)`: texture와 retained source를 해제합니다. update/delete는 즉시 적용되므로 그 전에 끝난 draw에는 영향을 주지 않습니다. 텍스처 내용은 draw 제출 순서에서 결정됩니다.

### 프레임·draw state

- `beginFrame({width=canvas.width,height=canvas.height,clearColor=[0,0,0,0],clearDepth=1,clearStencil=0}) → boolean`: width/height는 **backing pixels**입니다. 게임이 CSS/DPR/projection을 정합니다. 각 frame의 draw/upload counter를 초기화합니다. context lost일 때 false이므로 해당 frame을 건너뜁니다.
- `clear({color?,depth?,stencil?})`: 지정한 attachment만 지웁니다. clip chain을 다시 만들 때 clear({stencil:0})를 사용하세요. clear는 해당 write mask를 열고 scissor를 끕니다. 이후 draw는 모든 pass state를 다시 설정합니다.
- `draw({pipeline,buffer,first=0,count,uniforms={},textures=[],blend='source-over',depth=false,stencil=false,colorMask=[true,true,true,true],filter?})`: TRIANGLES만 제출합니다. first/count는 vertex 단위이며 index buffer는 아직 없습니다. uniform 값은 scalar·array·typed array이고 matrix는 column-major/transpose=false입니다. texture 배열의 index가 sampler unit입니다. filter override는 해당 draw의 모든 texture에 적용되며 생략하면 resource 기본값을 다시 적용합니다.
- blend: source-over(premultiplied ONE/ONE_MINUS_SRC_ALPHA), straight-alpha(SRC_ALPHA/ONE_MINUS_SRC_ALPHA, Rally 기존 출력 보존), copy, lighter, source-in, destination-in, false. shader output alpha 형식에 맞게 게임이 정합니다. straight-alpha는 alpha 채널도 같은 factor로 계산합니다.
- depth: false 또는 `{func='lequal',write=true}`. func는 never/less/equal/lequal/greater/notequal/gequal/always. true depth가 없는 context에 요청하면 throw합니다.
- stencil: false 또는 `{func='always',ref=0,mask=255,writeMask=255,fail='keep',zfail='keep',pass='keep'}`. func는 depth와 같은 enum; operation은 keep/zero/replace/increment/decrement/invert/increment-wrap/decrement-wrap. 각 draw는 state를 완전히 지정하므로 클립·silhouette·다음 color pass 사이에 숨은 상태 의존이 없습니다. stencil 없는 context에 요청하면 throw합니다.
- `createRenderTarget(width,height,{filter='linear'})`: 검증된 RGBA8 color texture/FBO를 만들며 반환 handle은 `draw({textures:[target]})`에 사용할 수 있습니다. active frame에서 `bindRenderTarget(target)` / `unbindRenderTarget(target)`은 framebuffer와 viewport를 LIFO로 저장·복구합니다. target은 nesting, context loss/restore, disposal에 참여하고 현재 바인딩된 target을 sampler에 전달하면 throw합니다. target은 WebGL 2 color-only이며 depth/stencil attachment가 없습니다. `deleteRenderTarget`로 명시 해제합니다. `stats.gpuRenderTargetBytes`와 `renderTargetCount`는 현재 GPU 할당량을 나타냅니다.
- cull/dither/scissor는 매 draw 꺼집니다. draw는 정렬·게임 loop·카메라·시뮬레이션 tick을 소유하지 않습니다.
- `endFrame() → stats`, `dispose()`와 state ready/lost/failed/disposed, failure 문자열. context 복구에서 pipeline·texture handle identity를 보존하며 GPU 자원을 재생성합니다. **dynamic vertex buffer는 빈 상태로 복구하므로 게임이 다음 frame의 geometry를 다시 upload해야 합니다.** DOM source는 복구 때의 현재 pixels를 사용하므로 살아 있는 로딩 완료 source를 유지하세요.

`stats`는 재사용 객체이며 frame/drawCalls/vertices/bufferUploads/bufferBytes/textureUploads/textureBytes/frameCopies는 프레임 값입니다. bufferAllocations/restores는 누적, gpuBufferBytes/gpuRenderTargetBytes/pipelineCount/bufferCount/textureCount/renderTargetCount는 현재 자원량입니다. 초기 texture 생성과 frame 밖 upload는 다음 beginFrame에서 프레임 counter가 초기화됩니다. draw option 객체·uniform entries·attribute set 작업과 region copy에는 CPU 비용/작은 할당이 있으며 0-allocation 주장이 아닙니다. shader compile과 texture creation은 cold path로 두세요.

### 고정 font asset 배포

`modules/rendering/assets/fonts/` owns the prebaked data, explicit codepoint inventory, generator, provenance, metrics, and license. `npm run build` copies the fixed asset list into `dist/assets/fonts/`; canonical `manifest.json` schema 2 lists each asset's fixed path, version, byte count, and SHA-256 alongside every existing JavaScript bundle. The verifier rejects path/schema deviations and validates bytes before publication. The main-only publisher updates those listed files and preserves existing dist files and history. Fetch the asset from a commit-pinned URL such as `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/assets/fonts/noto-sans-kr-700-v1.json`; do not use a branch-latest URL or assume GitHub Raw has a browser CORS contract. The module validates CORS response, byte length, outer SHA-256, PackBits length, and both packed/raw mask SHA-256 values before creating a texture.

The browser's network cache is origin/top-site partitioned and browser-managed. The module's fetch/decode cache is limited to one JavaScript realm, and its GPU atlas cache is limited to a `WebGLDevice`; neither guarantees cross-tab or cross-origin sharing. A first offline visit needs network access. A revisit may load from the browser's HTTP cache when that cache retains the immutable response; applications must treat fetch/cache failure as a load error and offer retry. Context restoration uses the retained texture source owned by `WebGLDevice`.

[device browser 회귀](./tests/device.browser.mjs)는 실제 built ESM과 Chromium/WebGL에서 depth LEQUAL/GREATER, stencil write/read/clear, FPV11 두 texture·radial·white mask, straight/premultiplied alpha, 부분 atlas update, NPOT luminance fog, GPU frame copy, bounded buffer 재사용, context 복구 및 해제를 검증합니다. 게임 전체 parity는 각 migration의 게임 E2E가 별도로 확인해야 합니다.

### 벡터 제출 비용 측정 (2026-10-10)

기준 `812a6e2`와 변경 소스를 Node 24의 recording device에서 비교했습니다. 4 frame × (200 rect fill + 5 stroke + 20 gradient fill + white-flash + 반투명 group), 중간 stop 변경 1회에서 draw/upload 호출은 각각 917→21입니다. 업로드 geometry 자체와 순서·projection·clip 결과·제출 시점의 texture bytes는 동일했고 CPU staging은 양쪽 128KiB였습니다. 낮은 batch 한도 7 vertices 경계도 확인했습니다. gradient raster 생성 5회와 gradient texture 생성 4회는 양쪽 동일하며 frame 간 보관 캐시는 추가하지 않았습니다.

이는 실제 GL 호출·GPU 실행을 포함하지 않는 제한된 비용 표본이며 FPS 개선 주장에 사용하지 않습니다. 실제 Chromium/WebGL E2E에는 batching/capacity/painter order, gradient stop 변경·context loss 시나리오를 반영했지만 이 환경의 Chromium socket 권한 제한으로 실행하지 못했습니다. 실기기/GPU 검증은 남아 있습니다. silhouette topology·인스턴스 구조 재작성과 frame 간 gradient 캐시는 현재 소비자에서 추가 이익이 확인되지 않아 포함하지 않았습니다.

## Indexed retained geometry

`WebGLDevice.createIndexBuffer()` and `uploadIndices(handle, Uint16Array)` own WebGL 2 element buffers. `MeshRenderer.createMesh()` accepts complete expanded triangles or a `Uint16Array` of triangle indices over its 11-float vertex records; indexed meshes submit with `drawElements` or the matching ANGLE instanced call. The retained byte budget, context restoration, and disposal include both buffers. `MeshBuilder.combine()` remaps and preserves indexed inputs while retaining painter order.

`MeshRenderer.createMesh()` accepts two separate name-to-`Uint16Array` maps over the same vertex records: `expressionIndices` for semantic expression variants and `indexVariants` for generic host-selected triangle ranges. Keys must be stable names and cannot appear in both maps. `drawMesh(mesh,{indexVariant:name})` selects a list from either map; without a name it draws the base `indices` list (or expanded triangles). Each selected list replaces that draw's base list; the host submits multiple ranges in painter order and flushes at boundaries such as shader-surface draws. The renderer does not sort or transform the lists. Both maps' buffers are retained, included in the byte budget, restored after context loss, and released with the mesh. The legacy `expressionIndices` field remains supported by `MeshRenderer.createMesh()`; vector assets validate it against `metadata.expressions` and auto-select only authored expression names.

`MeshBuilder.combine()` remaps and preserves semantic `expressionIndices`, contributing each source's base triangles when that source has no matching expression key. It rejects non-empty `indexVariants`: flattening painter-order ranges from multiple assets would require their host-level paint schedules and could reorder interleaved draws. Submit those assets as separate ordered draws instead of silently dropping or regrouping their ranges.

## Ordered submission and batching

`MeshRenderer.drawMesh()` appends an ordered instance to its pending batch; call `flush()` at a real painter-order boundary or before ending the frame, rather than after every actor. Adjacent submissions batch only while the mesh, projection, clip, and (for multi-part meshes) packed part pose match. Root transforms and instance colors may vary inside that batch. A different mesh or part pose closes the batch because part poses are currently shared uniforms. Repeated outline offsets with the same mesh and pose can be submitted consecutively and flushed once. Vector paint that genuinely alternates with mesh draws around each actor is a painter-order boundary; the renderer does not merge those calls by changing layering.

## Shader yarn and sketch surfaces

`YarnSurfaceRenderer` is an opt-in WebGL 2 material path for SVG-authored filled surfaces. It keeps the triangulated fill in local vector coordinates and evaluates yarn stitches, edge loops, fibers, sketch hatching, and animated sketch echoes in fragment shaders. The only extra retained geometry is a fixed strip following the closed SVG contour; changing `stitchWidth`, `stitchHeight`, `fiberSpacing`, or `fiberMax` does not add vertices. It creates no per-stitch or per-fiber triangles and no artwork texture (the first yarn surface creates one shared 256x256 stitch distance field, identical for every asset, which `dispose()` releases and the device restores after a lost context).

The source compiler supplies a complete triangle list with six floats per vertex (`x, y, r, g, b, a`), one closed contour as flat `x, y` pairs, the original SVG style object, and optional per-contour RGBA values for gradient fills. Edge colors default to the mean fill color. Style values remain authored in the SVG metadata and invalid or incomplete styles throw; this renderer does not silently fall back to tessellated effect triangles.

```js
import { YarnSurfaceRenderer } from './rendering.js';

const surfaces = new YarnSurfaceRenderer(device);
const surface = surfaces.createSurface({
    fillVertices, // Float32Array, non-indexed triangles, x/y/rgba
    outline, // Float32Array, closed local-space contour x/y pairs
    edgeColors, // optional Float32Array, one RGBA per contour point
    style: svgMetadata.styles.find((style) => style.kind === 'yarn'),
});

// Keep this call at the styled SVG path's painter-order position.
// transform composes the actor matrix and the animated part pose.
const clip = ctx.createClipPath(authoredConcaveContour);
ctx.save();
ctx.clipPath(clip); // retained stencil clip; requires an active stencil attachment
surfaces.drawSurface(surface, {
    projection,
    transform: partMatrix,
    clips,
    alpha,
    color,
    stencilRef: ctx.stencilRef, // pass the active VectorContext stencil depth
});
ctx.restore();
surfaces.deleteSurface(surface);
surfaces.dispose();
```

Yarn metadata accepts the SVG `kind`, `seed`, stitch, edge, and fiber fields used by the vector-assets schema. Sketch metadata accepts the SVG `kind`, `seed`, `periodMs`, echo, and hatch fields. Yarn cells and edge fibers are deterministic from the authored seed. Sketch time is the caller's absolute `timeMs`; the renderer owns no clock. A fill and its contour strip are separate ordered draws. The host still decides where each surface appears between eyes, outlines, and other SVG paths; this API never sorts.

Coordinates, stitch dimensions, and fiber dimensions are in source-vector units and follow the supplied object/part transform, including rotation and non-uniform scale. CSS size affects pixel sampling and DPR affects backing resolution; neither changes the authored local-space material scale. Pass `clips` as convex polygons in transformed world coordinates; exceeding the device's fragment-uniform clip-plane limit throws. For a retained concave clip, use `VectorContext.createClipPath()` / `clipPath()` and pass its active `stencilRef` to every `drawSurface()` call in that painter-order scope. The renderer applies the same explicit `EQUAL` stencil test to both fill and edge draws, validates that the current framebuffer has a stencil attachment, and disables stencil on calls with `stencilRef: null`. No contour approximation is used. `VectorContext` rebuilds its retained clip stack after context restoration; resume the frame through that context before submitting Yarn. Depth and blending use explicit `WebGLDevice` state. The edge-strip join uses a bounded four-width miter. These are filled surface effects, not SVG stroke caps/joins, and SVG outline strokes remain on the existing vector-asset path.

`YarnSurfaceRenderer.drawSurface()` accepts `stencilRef: null` (default) or an integer in `[0,255]`; a non-null value requires the active default framebuffer or render target to have stencil. Convex `clips` and stencil clipping intersect. This option adds no mesh batching path and does not change `MeshRenderer` compatibility or painter ordering.

The API is additive: existing `MeshRenderer` meshes, old compiled assets, static yarn/sketch triangle assets, and ordinary SVG strokes keep their existing behavior until a consumer opts into the new material and passes its authored surface data. The focused validation is `npm run test:rendering:yarn-shader`; it checks density-invariant geometry and real Chromium/WebGL pixels at 47 and 74 CSS px, clipping, and context restoration. It is a correctness check, not an FPS or CPU benchmark.

## CPU geometry diagnostic counters (0.11.5)

WebGLDevice.stats exposes frame-local numeric counters, reset by beginFrame(): vectorFlushCalls (explicit VectorRenderer.flush calls),
vectorSubmissions (nonempty vector buffer submissions), pathTessellations (actual fill/radial-fill tessellator calls),
pathStrokeBuilds (stroke geometry builds), and meshCreates (successful retained mesh creation).
Existing drawCalls, bufferUploads and bufferBytes count actual device submissions. These counts do not measure GPU completion.
MeshRenderer has no per-frame geometry rebuild API: geometryUploads measures retained creation/restoration, not instance buffer uploads.
Use FrameMetrics from debug-tools to retain selected numbers with the same frame's CPU stage observations; no profiler is installed automatically.

## Analytic primitives in the vector stream

VectorContext emits eligible simple shapes as analytic primitive vertices (mode 5 in the stream): full circles and ellipses, rectangle fills and eligible strokes, and one-segment strokes. The fragment shader evaluates the shape's distance function, so no contour points are tessellated. Each primitive captures its transform, paint color and alpha, stroke width, and cap or join, and joins the same draw as the surrounding fills, gradients, glyphs and sprites.

After initialization the fast path samples no full-ellipse path points; it builds path geometry only when a fallback or a later path command needs the original contour. Per-frame vertex bytes appear in the context's `uploadedBytes`.

Fast paths retain Canvas path transforms, effective alpha, convex clips, stencil clips, and submission order. Partial arcs, compound paths, holes, rounded rectangles and dashed strokes use the path tessellator, still in the same stream. VectorContext restores and releases the stream with the context. The integrated `npm run test:browser` scenario checks real Chromium/WebGL pixels, the single draw call and warm-frame tessellation counters. This correctness check does not measure GPU completion or mobile performance.

## Authored animation pose data (v0.17)

WebGL 2가 기본이며 ANGLE 확장 유무와 관계없이 core instancing을 사용합니다. 기존 GLSL ES 100 shader 입력은 ES 300으로 정규화하고 native ES 300도 허용합니다. shader·VAO·buffer·texture는 context 복구와 dispose의 동일 소유권을 따릅니다.

Source 해제는 새 texture를 할당하지 않습니다. 남은 프로그램의 offset은 유지하고 여유 공간은 다음 source 등록 때 압축하며, 마지막 source 해제 시 전체 프로그램 texture를 반환합니다. 압축·atlas 증설은 새 데이터 할당에 성공한 뒤 교체합니다. 업로드 실패 시 row의 dirty 상태를 유지하고 context 복구 때 필요한 state/base/CPU pose 데이터를 다시 올립니다.

- createDataTexture(width,height,{data=null})와 updateDataTexture(handle,Float32Array,{x,y,width,height}): nearest RGBA32F 숫자 데이터입니다. CPU 원본을 보존해 context restore 후 다시 만듭니다. 그림 asset API가 아닙니다.
- createRenderTarget(width,height,{format:'rgba32f',filter:'nearest'}): float 렌더 타깃입니다. floatRenderTargetsSupported와 isRenderTargetAvailable(handle)로 지원·복구 가능 여부를 확인합니다. EXT_color_buffer_float가 필요하며, 해당 target의 복구 실패가 일반 WebGL 2 렌더링을 중단시키지는 않습니다. 애니메이션 pose 계산은 이 타깃을 쓰지 않습니다.
- new MeshRenderer(device,{poseBackend:'auto'|'cpu'|'uniform'}): auto는 정점 셰이더 평가를 시도하고 명시적 CPU pose fallback을 유지합니다. cpu는 같은 atlas/instancing에 CPU pose를 올리는 진단 경로, uniform은 기존 CPU pose uniform 참조 경로입니다.
- player.preparePose({excludeParts})로 표시 상태를 준비하고 meshes.preparePoses()로 모아 평가합니다. 보이지 않는 pose 준비만 source별로 묶으며 visible mesh/alpha/paint를 재정렬하지 않습니다. 준비하지 않은 player.draw도 동작하지만 뒤늦은 개별 준비는 같은 행을 이미 쓴 배치를 먼저 제출하게 만들 수 있습니다.
- context.drawVectorAsset(player,options)는 앞선 analytic primitive와 vector paint를 먼저 제출하고 player.draw를 호출합니다. 같은 mesh run 자체를 actor마다 강제로 flush하지 않습니다. 몸체→얼굴 overlay→다음 actor 순서는 그대로입니다. 직접 player.draw를 호출하는 소비자는 이전 renderer의 순서 경계를 책임집니다.
- meshes.poseStats(): GPU/CPU/uniform draw instance 수, CPU fallback 비율/이유, state/base/CPU pose upload byte, atlas/프로그램 할당 byte를 보고합니다. prepare 호출 횟수와 실제 draw 사용량은 다릅니다.

서로 다른 행을 가진 같은 mesh의 연속 제출은 u_parts 변경으로 분리되지 않습니다.

GPU pose는 별도 계산 패스가 없습니다. 키프레임(program)은 데이터 텍스처에 한 번 올리고, 인스턴스마다 상태 한 행(클립 헤더, 클립 시간, 반복 방식, 길이, morph, 숨김 파트 비트마스크, program 오프셋)과 파트 오버라이드 행만 갱신합니다. 정점 셰이더가 그 세 텍스처(program, state, overrides)를 읽어 부모 계층 행렬·이징·투명도를 같은 draw 안에서 계산하므로 pose 계산 때문에 draw가 늘지 않습니다. 정점마다 같은 파트 계산을 반복하는 비용은 GPU ALU 시간으로 옮겨지며, 이 환경의 SwiftShader로는 GPU 시간을 재지 못합니다. 표정 index buffer·shader surface·paint·clip·stencil·depth state 경계는 유지합니다. 깊이 쓰기 alpha 분류처럼 CPU 삼각형 분석이 필요한 일반 draw API는 기존 parts 경로를 사용합니다. GPU pose atlas handle과 alpha depth 분류 옵션을 함께 넘기는 것은 지원하지 않습니다. 기존 vector asset draw API에는 해당 alpha 분류 옵션이 없습니다.

숫자 프로그램은 원본 SVG 채널을 공유합니다. translation/rotation/nonuniform scale/opacity, pivot·부모 계층, 표정/가시성·부위 제외·base pose·morph를 유지합니다. 미지원 easing/매우 긴 채널과 진행 중 중첩 전환은 CPU pose atlas, SVG shader surface/drawOrder는 기존 CPU 제출 경로를 사용합니다. 완료된 전환은 시계를 초기화하지 않고 GPU 경로로 복귀합니다. GPU readback은 제품 루프에서 사용하지 않습니다.
