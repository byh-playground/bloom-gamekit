# rendering

게임·시뮬레이션·보간·DOM 입력과 독립적인 **WebGL 1 2D 제출 kernel**입니다. WebGL 2 전용 기능이나 Canvas2D 전장 fallback은 사용하지 않습니다. 불가능한 브라우저에서는 생성이 실패합니다.

```js
import { Renderer2D } from './rendering.js';
const renderer = new Renderer2D(canvas);
renderer.resize(720, 400, devicePixelRatio); // CSS 크기, 실제 backing store는 DPR 적용
renderer.setCamera({ x: 360, y: 200, zoom: 1, rotation: 0 });
if (renderer.beginFrame([0.03, 0.05, 0.08, 1])) {
  renderer.ellipse(pose.x, pose.y, 16, 5, [0, 0, 0, 0.3]);
  renderer.rect(pose.x, pose.y - pose.z, 24, 24, [0.2, 0.8, 0.6, 1], pose.angle);
  renderer.endFrame();
}
```

## 공개 API와 공간 계약

- `new Renderer2D(canvas, {batchVertices=6144, antialias=true, preserveDrawingBuffer=false})`: context를 독점 소유합니다. 다른 renderer/직접 GL 상태 변경과 공유하지 마세요. `gl`은 진단/readPixels/context-loss 검사에 노출합니다. `preserveDrawingBuffer`는 검사 등 필요한 경우만 사용하세요.
- `resize(cssWidth, cssHeight, dpr=1)`: 양의 유한 수, 실제 backing store는 반올림한 CSS×DPR입니다. CSS 스타일이나 카메라를 바꾸지 않습니다. frame 밖에서 호출하세요. frame 중 resize는 throw합니다. DPR 상한은 게임의 비용 정책입니다. 예제는 2로 제한합니다.
- `setCamera({x,y,zoom,rotation})`: 세계의 카메라 중심, CSS pixel/world unit 확대율, radians 회전입니다. 생략 필드는 유지합니다. 생성 기본값은 초기 canvas 크기의 중심, zoom 1, rotation 0입니다. +x 오른쪽, +y 아래입니다. frame 도중 변경하면 기존 batch를 먼저 제출합니다.
- `worldToScreenInto(x,y,out)`, `screenToWorldInto(x,y,out)`: 재사용 가능한 out의 x/y에 CSS 화면 또는 world 좌표를 기록합니다. 게임의 3D/isometric 투영·높이·카메라 추적은 호출자가 계산합니다.
- `beginFrame(clearRGBA=[0,0,0,0]) → boolean`, `endFrame() → stats`: 명시적 시작/종료입니다. 순서 위반은 throw합니다. context lost 중 beginFrame은 false이므로 frame을 건너뛰세요. rect·triangle·ellipse·line은 texture가 없는 실제 GPU geometry입니다.
- `rect(x,y,width,height,tint=[1,1,1,1],angle=0)`: 중심 기준, 양의 크기, radians 회전.
- `triangle(x0,y0,x1,y1,x2,y2,tint)`: 임의 삼각형.
- `ellipse(x,y,radiusX,radiusY,tint,segments=24)`: 3..256 삼각 fan으로 근사합니다. segments는 게임의 품질/비용 선택입니다.
- `line(x0,y0,x1,y1,width,tint)`: butt-cap 직사각형, 길이 0은 그리지 않습니다.
- `sprite(texture,x,y,width=texture.width,height=texture.height,{angle=0,tint=[1,1,1,1],u0=0,v0=0,u1=1,v1=1})`: 중심 기준 quad. UV는 위/왼쪽 원점, `[0,1]` 범위입니다. atlas 일부를 선택하거나 endpoints를 반대로 주어 뒤집을 수 있습니다. 매 호출 option 객체가 필요하면 재사용하세요.
- `flush()`: 현재 batch를 명시적으로 제출합니다. 보통 endFrame만 호출하면 됩니다.

모든 색은 straight-alpha `[r,g,b,a]`, 각 채널 `[0,1]`입니다. shader/texture 경계에서 premultiplied alpha로 변환하고 ONE/ONE_MINUS_SRC_ALPHA로 합성합니다. 투명 픽셀의 RGB가 bilinear filter에 번지지 않도록 RGBA byte source도 upload 전에 premultiply합니다.

깊이 버퍼·정렬은 없습니다. **호출 순서가 painter order**이며 texture 변경 때문에 투명 객체를 재정렬하지 않습니다. 같은 texture의 연속 도형만 batch로 묶습니다. y-sort·그림자/body/HUD pass는 게임이 정합니다. 예제는 동일 pose의 그림자를 먼저 그리고 body를 y-sort합니다.

## 텍스처·생명주기

- `createTexture(source,{filter='linear'}) → handle`: origin-clean하고 로딩 완료한 image/canvas 또는 `{width,height,data: Uint8Array|Uint8ClampedArray}` RGBA bytes입니다. nearest/linear, CLAMP_TO_EDGE, mipmap 없음으로 WebGL 1 NPOT를 지원합니다. handle은 해당 renderer만 사용할 수 있습니다.
- byte data는 복사·premultiply해 보관하므로 caller의 이후 변경이 반영되지 않습니다. DOM source는 참조를 보관합니다. context 복구 시 최신 DOM pixels를 다시 올립니다. source를 닫거나 해제하지 마세요. ImageBitmap은 premultiplyAlpha 생성 옵션을 검사할 수 없으므로 명시적으로 거부합니다. byte data 또는 일반 image/canvas를 사용하세요.
- `updateTexture(handle,source)`: 같은 크기로 명시적 재업로드. 기존 batch를 먼저 제출하므로 이전 sprite 호출의 내용은 유지됩니다. 크기를 바꾸려면 새 texture를 만들고 기존 것을 삭제하세요. sprite마다 자동 upload하지 않습니다.
- `deleteTexture(handle) → boolean`: GPU texture와 retained source를 해제합니다. 이미 삭제한 handle은 false. 삭제/다른 renderer handle의 sprite 호출은 throw합니다.
- `state`: ready/lost/failed/disposed. webglcontextlost는 preventDefault 후 현재 frame을 취소합니다. 복구 event에서 shader·buffer·retained texture를 다시 생성합니다. handle identity는 유지합니다. 복구 실패는 failed 및 failure 문자열로 드러나며 게임은 dispose/recreate를 선택합니다.
- `dispose()`: 반복해도 안전하며 context listener·GPU 자원·retained source를 해제합니다. canvas/DOM 노드를 제거하지 않습니다. 그 뒤 draw/create/resize는 지원하지 않습니다.

## 비용·지원 범위

고정 Float32 staging buffer 하나와 같은 크기의 GPU buffer를 재사용합니다. batch capacity나 texture 경계에서 bufferSubData + drawArrays로 제출하며 capacity 때문에 동적으로 전체 buffer를 늘리지 않습니다. 전체 화면 Canvas raster upload는 없습니다. flush마다 작은 TypedArray subarray **view 하나**를 만듭니다. view는 pixels/vertex data를 복사하지 않지만 JS 객체 할당이므로 0-allocation이라고 부르지 않습니다. sprite 기본 옵션과 caller option 생성·ellipse 삼각화 비용도 사라진 것이 아닙니다.

`stats`는 재사용 객체입니다. frame/drawCalls/vertices/uploadedBytes/bufferViews/textureUploads는 실제 제출과 연결되고, totalTextureUploads/bufferAllocations는 수명 누적입니다. textureCount는 caller texture만 셉니다(내부 white texture 제외). stagingBytes는 고정 CPU staging 크기입니다. textureUploads에는 흰 texture와 복구 upload가 포함되며 frame 시작 때 해당 frame counter가 0으로 초기화됩니다. CPU submit 시간은 예제 caller가 측정하며 GPU 완료시간이 아닙니다.

`Renderer2D`는 의도적으로 단순한 primitive 편의 API입니다. path·곡선·clip·group opacity와 사전 생성 glyph 텍스트는 아래 `VectorRenderer`/`GlyphAtlas` 조합을 사용합니다. 자동 asset loading·sprite animation·terrain/fog·scenegraph·game art·기본 3D scene 처리는 여전히 게임 소유입니다. DOM UI 또는 게임별 projection/layer로 조합하세요.

## VectorContext와 재사용 primitive painter

`VectorContext(device,{vectorRenderer,glyphAtlas,onError,initialVertices,maxVertices})`는 게임의 2D draw adapter에서 반복되기 쉬운 paint/state/path 알고리즘을 공개합니다. canvas와 WebGL context, 프레임 자원은 caller가 만들고, 이미 사용하는 `VectorRenderer`와 `GlyphAtlas`를 주입하면 같은 painter queue와 glyph texture를 공유합니다. vector를 생략한 경우에만 context가 VectorRenderer를 만들고 해제합니다. WebGLDevice와 GlyphAtlas는 항상 caller 소유이며 import만으로 DOM·GPU·asset 작업을 하지 않습니다.

```js
import { WebGLDevice, VectorRenderer, VectorContext, PrimitivePainter } from './rendering.js';
const device = new WebGLDevice(canvas, { depth: false, stencil: false });
const vector = new VectorRenderer(device, { glyphAtlas });
const ctx = new VectorContext(device, { vectorRenderer: vector, glyphAtlas, onError: reportRenderError });
const primitive = new PrimitivePainter(ctx, { point: transformArtPoint, alphaMultiplier: () => artAlpha });
if (ctx.beginFrame({ width: canvas.width, height: canvas.height, clearColor: [0, 0, 0, 0] })) {
  ctx.fillStyle = 'rgba(32, 78, 54, .8)'; ctx.beginPath();
  ctx.roundRect(24, 20, 110, 52, 8); ctx.fill();
  ctx.strokeStyle = '#d9f3ad'; ctx.setLineDash([6, 3]); ctx.stroke();
  const glow = ctx.createRadialGradient(80, 100, 0, 80, 100, 18);
  glow.addColorStop(0, '#fff8d0'); glow.addColorStop(1, '#fff8d000');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(80, 100, 18, 0, Math.PI * 2); ctx.fill();
  primitive.circle(80, 100, 12, '#f1f8d7', 12); // 원래 authored fan topology 유지
  ctx.endFrame();
}
```

- path/state API는 CSS hex/rgb(a)/hsl(a)/named paint, alpha, affine transform, curve, arc/ellipse/rect/roundRect, fill/stroke, dash, clip, scoped color, silhouette/group, prebaked atlas text의 metrics와 그리기를 제공합니다. `filter`는 `none`과 게임 white-flash 값 `brightness(0) invert(1)`을 지원하며 save/restore에 포함됩니다. 흰색 변환은 강제색을 결정한 뒤 RGB만 흰색으로 바꾸고 alpha는 보존합니다.
- `createRadialGradient(x0,y0,r0,x1,y1,r1)`는 concentric circle만 지원하고, creation transform과 sorted color stops를 보존합니다. `addColorStop()`의 premultiplied 256×1 ramp를 frame 안 첫 fill 때 upload하고, 같은 gradient 객체의 후속 fill은 동일 handle을 재사용합니다. 추가한 stop은 같은 handle에 update합니다. 모든 gradient texture와 raster byte는 `endFrame()`에서 공용 queue를 flush한 뒤 해제되고, `stats().activeGradientTextureCount`는 frame 밖에서 0입니다. filter white-flash, forceColor, globalAlpha와 clip/group 안에서도 alpha와 painter order를 유지합니다. 비동심 원과 singular transform은 오류로 명시합니다.
- `fillTriangleFan(points,paint)`는 caller가 정의한 fan topology를 삼각형 재분할 없이 공통 clip/group 경로로 제출하고, `VectorRenderer` private method를 호출하지 않습니다. `PrimitivePainter(target,{point,alphaMultiplier})`는 WebGL `VectorContext`와 caller가 전달한 native Canvas2D paint target 양쪽에 `poly/tri/quad/regularPolygon/circle/hex/line/fan`을 제공합니다. target 쪽에서는 하나의 path fill로 원래 fan을 그리고, `point(x,y)` hook은 caller의 authored facing만 반영합니다. UI thumbnail은 기존의 명시적인 native Canvas2D target을 전달할 수 있습니다. world draw는 WebGLContext가 담당합니다.
- `withGroupOpacity(opacity,callback,bounds)`는 그룹 opacity를 딱 한 번 합성하고 callback 안에서 globalAlpha를 1로 둔 뒤 원래 상태를 복구합니다. `withSilhouette(color,width,paint,radius)`는 opacity-bounded group 안에서 강제색 offset fan과 중심 pass를 그리고, forceColor를 복구한 뒤 원래 body를 한 번 더 그립니다. 기존 clip/filter와 draw order를 보존합니다.
- Stroke 폭은 기존 게임 adapter와 같이 변환 행렬 basis 중 큰 크기에 맞춰 조정합니다. dash 길이와 phase는 변환된 path 공간에 적용합니다. 공통 vector stroke는 butt/round/square cap, miter/round/bevel join을 그리며 miter 길이는 `miterLimit`으로 제한합니다. clip 호출 하나에는 contour 하나를 받습니다. path hole은 clip 대신 `fill(rule)`로 처리합니다.
- `beginFrame({width,height,clearColor})`와 `endFrame()`은 caller 소유 `WebGLDevice` 프레임을 감쌉니다. begin이 false이면 context loss 등으로 해당 프레임을 건너뜁니다. `stats()`는 실제 device draw/vertex/upload counter, GPU buffer/target byte와 개수, vector staging byte를 보고합니다. `dispose()`는 이 context가 생성한 VectorRenderer, gradient texture, static vertex buffer만 해제하며 device나 주입받은 atlas/renderer는 해제하지 않습니다. static vertex 데이터는 context 복구 후 다시 upload합니다. `onError(error,details)`는 caller callback이며 프레임 오류는 다시 throw됩니다.
- `createStaticMesh(vertices,{strideFloats})`는 재사용할 CPU vertex를 보관하고 device buffer에 upload합니다. `drawStaticMesh(mesh,{pipeline,projection,uniforms,textures,blend,depth})`는 caller draw 전에 공통 painter queue를 flush합니다. shader/material, projection uniform, depth/stencil 설정, pass 순서와 mesh geometry는 caller가 공급합니다. generic context는 terrain 정책을 정하지 않습니다.
- radial gradient는 fill이 있는 frame 동안 gradient 객체당 256×1 RGBA ramp 1KiB와 GPU texture 1KiB를 사용합니다. 같은 frame의 repeated fill은 한 texture를 재사용하며 stop 추가는 그 handle만 update합니다. `endFrame()`에서 submit 뒤 GPU handle과 CPU ramp를 evict하므로 frame을 거쳐 계속 생성되는 gradient 객체를 context가 강하게 보관하지 않습니다. texture sampling으로 각 fragment의 반경을 계산합니다.
- `PrimitivePainter`는 authored fan을 Canvas2D target에서 한 번의 path fill로 제출하고, WebGL target에서는 원래 fan 삼각형을 공용 vector buffer에 queue합니다. 실제 game-shaped browser helper에서 WebGL 26 draw calls / 1,170 vertices / 37,440 uploaded vertex bytes, 19,456 texture upload bytes, vector staging/GPU buffer 각 8KiB, opacity target 16KiB를 관찰했습니다. CPU submit은 한 SwiftShader scene 표본에서 13.2ms였고 GPU 완료시간은 아닙니다. UI Canvas2D primitive 두 개의 CPU submit은 0.7ms, 40×40 RGBA reference와 pixel 차이 0이며 해당 paint target의 GPU upload는 0입니다.
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
- 내부 `MeshRenderer(device,{maxMeshes=512,maxMeshBytes=33554432,maxInstances=2048})`는 같은 mesh·projection·clip의 **인접 호출만** 합칩니다. 게임의 y-sort를 바꾸거나 다른 메시를 재정렬하지 않습니다. 직접 사용할 때 `drawMesh(mesh,{matrix,projection,morph,color,forceColor,alpha,whiteFlash,clips})`와 `flush()`를 호출하고 외부 pass 전 flush 책임을 집니다. clip은 기존 vector와 같은 convex half-plane 교집합이며, edge plane 상한은 `min(32, MAX_FRAGMENT_UNIFORM_VECTORS-2)`입니다. 넘으면 명시적으로 거부하고 clip을 무시하지 않습니다.
- ANGLE_instanced_arrays 지원 시 static geometry + 64-byte/instance 값만 올립니다. 미지원 시 **같은 retained GPU geometry**를 instance uniform별로 제출하며 도형을 다시 만들지 않습니다. 이 경로는 draw call을 합치지 않습니다. 정렬·서로 다른 part·벡터 text·opacity target 경계는 batch를 끊으므로 모든 유닛이 한 draw call이라는 보장은 없습니다.
- mesh clip은 fragment half-plane discard입니다. 벡터의 CPU 삼각형 clip과 내부/외부는 같지만, 직접 MSAA target의 회전 clip 경계는 sample coverage가 달라질 수 있습니다. 따라서 해당 경계를 pixel-exact parity로 주장하지 않습니다. 정수 pixel의 축 정렬 opacity bounds와 일반 authored mesh 실루엣은 별도로 실제 화면에서 확인합니다.
- partIndex는 FLOAT attribute 하나이며 두 morph를 vec4 하나에 담아 vertex/instance attribute 총8개(WebGL1 최소 보장)를 사용합니다. part uniform은 최대48vec4 + projection/instance 값이며 최소 vertex uniform128vec4 안에 들어갑니다. shader는 partCount(1..16)·morphCount(0..2)·clip 유무에 따라 첫 제출 때 생성해 보관합니다(최대96개, 실제 pipelineCount 계측). 사용하지 않는 조각 배열·변형·fragment clip 경로를 컴파일하지 않습니다. 단일 part의 transform/morph/visibility는 CPU에서 instance 값에 한 번 합쳐 vertex별 part 연산을 없앱니다. 불투명 direct group은 GPU pass 변경이 아니므로 인접한 유닛 batch를 끊지 않으며, 실제 opacity target 경계는 반드시 flush합니다. 초기 shader compile·program 보관과 균일하지 않은 part pose의 uniform 갱신 및 shader 변형 연산은 추가 비용이므로 geometry upload 감소를 FPS 개선으로 환산하지 않습니다.
- `partUniformBytesSubmitted`는 draw마다 제출한 part pose uniform 데이터 길이이며 vertex/instance buffer upload와 별개입니다(실제 GPU 버스 전송량 측정은 아님). default instance CPU staging128KiB에 plane/part scratch 최대1,152 bytes가 추가되며 `stagingBytes`는 둘을 포함합니다. 순간적인 queue projection/part 값 복사와 caller의 pose 배열 할당은 별도입니다.
- 기본 최대 retained vertex payload는 CPU 32MiB + GPU 32MiB이며 instance staging CPU 128KiB와 지원 시 GPU 128KiB가 추가됩니다. 실제 GPU allocation은 device counter를 확인합니다. 초기 build/upload·shader compile·캐시 miss는 cold 비용이고, 게임이 종류/스타일별 bounded cache와 eviction을 소유합니다. SDK는 살아 있는 handle을 임의로 지우지 않고 예산 초과를 거부합니다. createMesh는 caller geometry를 복사해 보관하고 복구 시 한 번 재업로드합니다. 삭제는 해당 pending draw를 먼저 제출하고 자원을 해제합니다. dispose는 잔여 queue를 버리고 모든 메시와 listener를 해제합니다.
- `ctx.stats().mesh`는 실제 mesh draw/instance 수, 프레임별 geometry/instance upload bytes, meshCount, retainedBytes, stagingBytes, instanced, state/failure를 보고합니다. `device.stats.vertices`는 실제 instance 수를 포함한 제출 vertex 수이지 retained 고유 vertex 수가 아닙니다. 재사용은 GPU geometry·픽셀 fill 비용을 없애는 것이 아니라 반복 CPU 생성과 geometry upload를 줄입니다. 측정 전 FPS 개선을 단정하지 않습니다.

### VectorRenderer와 prebaked GlyphAtlas

`VectorRenderer`는 같은 canvas를 소유한 `WebGLDevice` 위에서 path tessellation·transform·clip·painter-order stream·textured glyph 제출을 제공합니다. 프레임·projection·정렬과 그림 내용은 caller가 소유합니다. 불투명 draw는 재사용 geometry buffer에 직접 제출합니다. CPU/GPU vertex storage는 기본 4096 vertices(각 128 KiB)에서 시작해 필요할 때 2배로 자라며 기본 상한은 262144 vertices(각 최대 8 MiB)입니다. `beginGroup(opacity,bounds)`는 불투명 기본값 `1`이면 target 없이 직접 경로를 유지하고, 반투명 그룹은 canvas-screen bounds의 RGBA target에 그린 뒤 한 번 합성합니다. 생략한 bounds는 viewport 전체입니다. target은 중첩 깊이별로 보관되고 필요한 크기의 다음 power-of-two 버킷으로 할당되어 작아지는 bounds와 인접한 크기에서는 재사용됩니다. bounds보다 바깥의 입력은 잘립니다. `stats.gpuRenderTargetBytes`로 실제 target byte 수를 확인하세요.

```js
import { WebGLDevice, VectorRenderer, FontAssetLoader } from './rendering.js';
const device = new WebGLDevice(canvas, { alpha: true, depth: false, stencil: false });
const font = new FontAssetLoader(device, pinnedFontSource, { onProgress: showFontProgress });
const atlas = await font.ready;
const vector = new VectorRenderer(device, { glyphAtlas: atlas });
device.beginFrame({ clearColor: [0, 0, 0, 0] });
vector.beginGroup(0.5, { x: 80, y: 60, width: 240, height: 160 });
vector.polygon([[90, 80], [200, 80], [170, 170], [100, 150]], [1, 0.2, 0.1, 1]);
vector.endGroup();
vector.beginPath(); vector.moveTo(80, 200); vector.quadraticCurveTo(160, 130, 240, 200);
vector.stroke([0.3, 0.9, 0.6, 1], 3);
vector.fillText('label', 200, 250, { fontSize: 18, align: 'center', baseline: 'alphabetic', color: [1, 1, 1, 1] });
vector.flush(); device.endFrame();
```

- Paths use pixel coordinates in the device backing viewport. `moveTo`/`lineTo`, quadratic/cubic Bezier sampling, `closePath`, `fill` (`nonzero`/`evenodd`), `stroke(width)`, `polygon`, affine transforms, save/restore, and nested rectangular clips are supported. Curves default to 12/16 segments and accept an explicit 2..256 segment count. Fills use scanline trapezoid tessellation over flattened contours; inputs should be finite, non-self-intersecting contours. It supports holes with even-odd winding, not self-intersection repair.
- `beginGroup(opacity,bounds)` bounds are in the renderer's pixel coordinate space. A target is bucketed to power-of-two dimensions and reused by depth; content is clipped to requested viewport intersection. Worst-case allocation may approach 4× requested area due to independent width/height buckets. Target texture memory is RGBA8 (`4 × allocated width × allocated height` bytes per nesting depth); there is no CPU readback. Targets are color-only; game depth/stencil passes remain separate. Allocation and clear bandwidth are additional costs and target creation is a cold path.
- `GlyphAtlas(device,{width,height,data,glyphs,unitsPerEm,ascent,descent,filter,missingGlyph,replacement})` takes retained top-left-origin RGBA bytes and code-point-keyed metrics `{x,y,width,height,advance,bearingX,bearingY}`. Metrics are atlas pixels plus font-relative units. It uploads once and performs no runtime Canvas2D measurement/rasterization, crop, or pixel readback. `measureText` reports width/ascent/descent. `fillText` and `strokeText` accept `fontSize`, `align` (`left|center|right`), `baseline` (`top|hanging|middle|alphabetic|ideographic|bottom`), and RGBA color. The default missing-glyph mode throws; `skip` and explicit replacement are opt-in. Text draw calls batch adjacent glyphs from the same atlas.
- `FontAssetLoader(device,{url,version,sha256,bytes},{signal,onProgress})` fetches a caller-selected asset over CORS, checks the exact byte count and SHA-256 before parsing, validates its schema and decoded mask hashes, then resolves `ready` to a `GlyphAtlas`. Its states are `loading`, `ready`, `error`, `cancelled`, and `disposed`; progress phases are `download`, `verify`, `decode`, `ready`, `error`, `cancelled`, and `disposed`. Supply an explicit immutable URL/version/hash/byte tuple. `cancel()` stops that loader from becoming ready; a shared in-flight fetch continues for other consumers and may complete into the browser's HTTP cache. `dispose()` releases its per-device atlas lease; the last lease deletes the GPU texture and retained pixels. Failed loads are removed from the in-memory cache so a later loader can retry. Identical version/hash pairs share one in-flight fetch and CPU decode within the current JavaScript realm; identical pairs on one `WebGLDevice` also share one atlas texture by reference count. Other tabs, browser processes, origins, and top-site partitions depend on browser HTTP cache policy and are not promised to share bytes. This API does not write CacheStorage.
- The published `noto-sans-kr-700-v1` asset covers exactly its versioned 750-codepoint inventory (including 585 Hangul syllables); it does not claim full Korean or Unicode coverage. Missing codepoints throw by default. A caller chooses its asset and handles a missing glyph explicitly; expanding or replacing the inventory requires a new asset version, new SHA-256/byte metadata, and a manifest update. The font program is not downloaded. The Noto Sans KR OFL license and inventory/generator provenance are stored alongside the prebaked mask and metrics.
- `VectorRenderer.flush()` submits queued glyph vertices at frame boundaries or before switching to another texture. `dispose()` releases its pipeline, stream buffer, white texture, and group targets. Dispose `GlyphAtlas` separately. The shared `WebGLDevice` remains caller-owned.

The [native rendering example](./examples/vector/index.html) demonstrates polygon/curve/text/clip/group composition. The browser E2E reads actual WebGL pixels for alpha 128, fill holes, clipping, glyphs, nested opacity, bounded target allocation and target restoration. This validates the reference Chromium WebGL1/SwiftShader path, not mobile GPU performance. Path flattening, scanline tessellation, clip-polygon intersections, geometric glyph outlines, staging growth, uploaded vertex bytes and render-target clears add CPU/GPU work; the example reports CPU submission time (not GPU completion) and counters for its one small scene, not a device-wide benchmark.

요구 근거는 [Budmori 88c93e7](https://github.com/byh-playground/budmori-io/blob/88c93e713d6bc2b4f081c24a99e536d497a5799b/index.html)의 geometry stream·명시적 texture invalidation·painter order와 [Rally f6037f0](https://github.com/byh-playground/rally-frontier/blob/f6037f05e0ff2163fc11cf0f770e2bc071eaa291/index.html)의 game-owned projection·presentation-only buffer입니다. 해당 게임 코드를 변경하거나 통째로 복사하지 않았습니다. 통합 검사는 [실제 브라우저 E2E](../../tests/browser.e2e.mjs)를 보세요.

## WebGLDevice: 게임이 만든 geometry/pass를 제출하는 공통 GPU core

Budmori의 FPV11 texture/gradient/white-mask stream과 Rally의 xyz/depth·alpha-cutoff·두 fog texture·frame composition을 같은 GPU 자원 경계로 처리합니다. 기존 `Renderer2D` 편의 API는 유지됩니다. `WebGLDevice`는 별도 canvas/context를 소유하는 낮은 수준 API이며 두 renderer를 같은 context에서 섞지 않습니다.

게임에 남는 것: path/curve tessellation, art/text atlas 내용과 갱신 version, GLSL material 정의, fog 판단, 카메라/projection, pass 순서와 depth/stencil 정책. 공통 core가 소유하는 것: context·shader compile/link·attribute/uniform binding·GPU buffer/texture 생성과 upload·draw state·실제 draw call·context 복구·dispose. shader 정의만 바꿔 다양한 게임을 지원하며 Canvas2D 전장 fallback은 없습니다.

```js
import { WebGLDevice } from './rendering.js';
const device = new WebGLDevice(canvas, { depth: true, stencil: true });
const pipeline = device.createPipeline({
  vertex: gameVertexShader, fragment: gameFragmentShader,
  stride: 28, // bytes: xyz + rgba
  attributes: [{ name: 'a', size: 3, offset: 0 }, { name: 'ac', size: 4, offset: 12 }],
  uniforms: { r: '2f' },
});
const buffer = device.createVertexBuffer({ capacityBytes: 28 * 16384 });
if (device.beginFrame({ width: canvas.width, height: canvas.height })) {
  device.uploadVertices(buffer, gameGeometry.view());
  device.draw({ pipeline, buffer, first: 0, count: gameGeometry.length / 7,
    uniforms: { r: [canvas.width, canvas.height] }, blend: 'straight-alpha',
    depth: { func: 'lequal', write: true } });
  device.endFrame();
}
```

### 생성·자원 계약

- `new WebGLDevice(canvas,{alpha=false,antialias=true,depth=true,stencil=true,preserveDrawingBuffer=false,powerPreference='default',failIfMajorPerformanceCaveat=false,checkGLErrors=false,maxTextures=8,maxBufferBytes=134217728})`. WebGL 1 전용이며 canvas를 독점 소유합니다. `gl`은 읽기 진단/상수/context-loss 테스트용입니다. 직접 GL state 변경은 지원하지 않습니다. `maxTextures`는 실제 fragment texture unit 한도 이하로 정해지고 `maxTextureSize`도 공개합니다.
- `powerPreference`는 `default`/`low-power`/`high-performance`만, `failIfMajorPerformanceCaveat`는 boolean만 허용하며 context 생성 전에 검사합니다. 두 값을 `getContext('webgl', options)`에 그대로 전달합니다. GPU 선택은 브라우저의 hint 처리이며 특정 GPU나 성능을 보장하지 않습니다.
- `checkGLErrors`는 boolean 개발 진단 옵션입니다(기본 false). 반복 `updateTexture`/`copyFrameToTexture`에서 동기식 `gl.getError()` polling은 true일 때만 합니다. 새 texture allocation과 첫 RGB copy storage 전환, shader compile/link 검사는 항상 유지합니다. CPU 인자·크기·범위 검증도 유지합니다. production에서는 드라이버 오류를 매 호출마다 즉시 보고하지 않으며 진단/테스트는 이 옵션 또는 명시적 프레임 경계 검사를 사용하세요. 오류 검사는 GPU 완료 대기를 유발할 수 있으므로 측정 시 옵션을 기록합니다.
- `createPipeline({vertex,fragment,stride,attributes,uniforms})`: GLSL ES 1.00 shader 문자열, 4-byte 정렬 stride(4..252), FLOAT attribute `{name,size:1..4,offset}`. uniform descriptor는 `1f/2f/3f/4f/1i/2i/3i/4i/1iv/1fv/2fv/3fv/4fv/matrix3fv/matrix4fv`입니다. sampler는 1i 또는 1iv로 texture unit을 정합니다. 예: array 첫 위치 이름 `u_tex[0]`. 최적화로 사라진 attribute/uniform은 건너뜁니다. shader compile/link 실패는 throw하고 임시 GPU 자원을 해제합니다.
- `createVertexBuffer({capacityBytes=0})`, `uploadVertices(handle,Float32Array)`: caller view를 동기 upload하며 다른 CPU arena에 복사하거나 붙잡지 않습니다. 필요할 때만 GPU capacity를 두 배씩 늘리며 maxBufferBytes 초과는 거부합니다. 마지막 upload의 used bytes 밖 draw는 거부합니다. `deleteVertexBuffer`, `deletePipeline`은 반복해도 false를 반환하는 명시적 해제입니다.
- `createTexture(fullSource,{format='rgba',premultiplied=false,filter='linear'})`: source는 image/canvas 또는 `{width,height,data}`. rgba data는 4채널, luminance data는 1채널의 byte 배열입니다. data:null은 비어 있는 GPU texture로 frame composition 등에 사용합니다. NPOT·nearest/linear·CLAMP_TO_EDGE를 지원합니다. raw rgba 기본값은 straight alpha이며 CPU에서 한 번 premultiply합니다. 이미 premultiplied인 gradient bytes에는 true를 명시하세요. DOM source는 rgba/default alpha 옵션만 사용합니다. ImageBitmap은 거부합니다.
- `updateTexture(handle,fullSource,{x=0,y=0,width=handle.width,height=handle.height})`: 크기가 같은 **전체 source**와 변경 region을 전달합니다. GPU에는 region만 texSubImage2D로 갱신하지만 복구 원본은 전체 source입니다. raw bytes는 복사하여 보존하고 DOM은 참조를 보존합니다. DOM atlas crop에는 자산 region 전용 작은 Canvas2D를 재사용하며 전장 frame을 rasterize하지 않습니다. 원본이 resize되면 새 handle을 만들고 이전 것을 삭제하세요.
- `copyFrameToTexture(handle,{x=0,y=0})`: 현재 resolved framebuffer에서 RGBA texture 전체 크기만큼 GPU copy합니다. 좌표는 WebGL framebuffer의 아래/왼쪽 기준입니다. CPU world-canvas upload가 아닙니다. alpha:false context에서는 WebGL 1의 copy 호환성에 맞게 첫 copy 때 RGB storage로 전환합니다(이후 같은 크기는 재사용). copy texture를 다시 updateTexture하면 전체 source로 storage를 재구성합니다. copy 후 복구 원본은 blank가 되므로 복구 후 새 frame에서 다시 copy하세요. 이전 texel은 시뮬레이션 상태가 아닙니다.
- `deleteTexture(handle)`: texture와 retained source를 해제합니다. update/delete는 즉시 적용되므로 그 전에 끝난 draw에는 영향을 주지 않습니다. 텍스처 내용은 draw 제출 순서에서 결정됩니다.

### 프레임·draw state

- `beginFrame({width=canvas.width,height=canvas.height,clearColor=[0,0,0,0],clearDepth=1,clearStencil=0}) → boolean`: width/height는 **backing pixels**입니다. 게임이 CSS/DPR/projection을 정합니다. 각 frame의 draw/upload counter를 초기화합니다. context lost일 때 false이므로 해당 frame을 건너뜁니다.
- `clear({color?,depth?,stencil?})`: 지정한 attachment만 지웁니다. clip chain을 다시 만들 때 clear({stencil:0})를 사용하세요. clear는 해당 write mask를 열고 scissor를 끕니다. 이후 draw는 모든 pass state를 다시 설정합니다.
- `draw({pipeline,buffer,first=0,count,uniforms={},textures=[],blend='source-over',depth=false,stencil=false,colorMask=[true,true,true,true],filter?})`: TRIANGLES만 제출합니다. first/count는 vertex 단위이며 index buffer는 아직 없습니다. uniform 값은 scalar·array·typed array이고 matrix는 column-major/transpose=false입니다. texture 배열의 index가 sampler unit입니다. filter override는 해당 draw의 모든 texture에 적용되며 생략하면 resource 기본값을 다시 적용합니다.
- blend: source-over(premultiplied ONE/ONE_MINUS_SRC_ALPHA), straight-alpha(SRC_ALPHA/ONE_MINUS_SRC_ALPHA, Rally 기존 출력 보존), copy, lighter, source-in, destination-in, false. shader output alpha 형식에 맞게 게임이 정합니다. straight-alpha는 alpha 채널도 같은 factor로 계산합니다.
- depth: false 또는 `{func='lequal',write=true}`. func는 never/less/equal/lequal/greater/notequal/gequal/always. true depth가 없는 context에 요청하면 throw합니다.
- stencil: false 또는 `{func='always',ref=0,mask=255,writeMask=255,fail='keep',zfail='keep',pass='keep'}`. func는 depth와 같은 enum; operation은 keep/zero/replace/increment/decrement/invert/increment-wrap/decrement-wrap. 각 draw는 state를 완전히 지정하므로 클립·silhouette·다음 color pass 사이에 숨은 상태 의존이 없습니다. stencil 없는 context에 요청하면 throw합니다.
- `createRenderTarget(width,height,{filter='linear'})`: 검증된 RGBA8 color texture/FBO를 만들며 반환 handle은 `draw({textures:[target]})`에 사용할 수 있습니다. active frame에서 `bindRenderTarget(target)` / `unbindRenderTarget(target)`은 framebuffer와 viewport를 LIFO로 저장·복구합니다. target은 nesting, context loss/restore, disposal에 참여하고 현재 바인딩된 target을 sampler에 전달하면 throw합니다. target은 WebGL 1 color-only이며 depth/stencil attachment가 없습니다. `deleteRenderTarget`로 명시 해제합니다. `stats.gpuRenderTargetBytes`와 `renderTargetCount`는 현재 GPU 할당량을 나타냅니다.
- cull/dither/scissor는 매 draw 꺼집니다. draw는 정렬·게임 loop·카메라·시뮬레이션 tick을 소유하지 않습니다.
- `endFrame() → stats`, `dispose()`와 state ready/lost/failed/disposed, failure 문자열. context 복구에서 pipeline·texture handle identity를 보존하며 GPU 자원을 재생성합니다. **dynamic vertex buffer는 빈 상태로 복구하므로 게임이 다음 frame의 geometry를 다시 upload해야 합니다.** DOM source는 복구 때의 현재 pixels를 사용하므로 살아 있는 로딩 완료 source를 유지하세요.

`stats`는 재사용 객체이며 frame/drawCalls/vertices/bufferUploads/bufferBytes/textureUploads/textureBytes/frameCopies는 프레임 값입니다. bufferAllocations/restores는 누적, gpuBufferBytes/gpuRenderTargetBytes/pipelineCount/bufferCount/textureCount/renderTargetCount는 현재 자원량입니다. 초기 texture 생성과 frame 밖 upload는 다음 beginFrame에서 프레임 counter가 초기화됩니다. draw option 객체·uniform entries·attribute set 작업과 region copy에는 CPU 비용/작은 할당이 있으며 0-allocation 주장이 아닙니다. shader compile과 texture creation은 cold path로 두세요.

### 고정 font asset 배포

`modules/rendering/assets/fonts/` owns the prebaked data, explicit codepoint inventory, generator, provenance, metrics, and license. `npm run build` copies the fixed asset list into `dist/assets/fonts/`; canonical `manifest.json` schema 2 lists each asset's fixed path, version, byte count, and SHA-256 alongside every existing JavaScript bundle. The verifier rejects path/schema deviations and validates bytes before publication. The main-only publisher updates those listed files and preserves existing dist files and history. Fetch the asset from a commit-pinned URL such as `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/assets/fonts/noto-sans-kr-700-v1.json`; do not use a branch-latest URL or assume GitHub Raw has a browser CORS contract. The module validates CORS response, byte length, outer SHA-256, PackBits length, and both packed/raw mask SHA-256 values before creating a texture.

The browser's network cache is origin/top-site partitioned and browser-managed. The module's fetch/decode cache is limited to one JavaScript realm, and its GPU atlas cache is limited to a `WebGLDevice`; neither guarantees cross-tab or cross-origin sharing. A first offline visit needs network access. A revisit may load from the browser's HTTP cache when that cache retains the immutable response; applications must treat fetch/cache failure as a load error and offer retry. Context restoration uses the retained texture source owned by `WebGLDevice`.

[device browser 회귀](./tests/device.browser.mjs)는 실제 built ESM과 Chromium/WebGL에서 depth LEQUAL/GREATER, stencil write/read/clear, FPV11 두 texture·radial·white mask, straight/premultiplied alpha, 부분 atlas update, NPOT luminance fog, GPU frame copy, bounded buffer 재사용, context 복구 및 해제를 검증합니다. 게임 전체 parity는 각 migration의 게임 E2E가 별도로 확인해야 합니다.
