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

지원하지 않는 기능: arbitrary canvas paths·곡선·clip/stencil·filter·blend mode 확장·text rasterization·자동 atlas·sprite animation·terrain/fog·scenegraph·3D/depth·game art·asset loader. DOM UI 또는 게임별 layer/투영으로 조합하세요. 이 모듈이 기존 게임 renderer 전체를 대체했다고 주장하지 않습니다.

요구 근거는 [Budmori 88c93e7](https://github.com/byh-playground/budmori-io/blob/88c93e713d6bc2b4f081c24a99e536d497a5799b/index.html)의 geometry stream·명시적 texture invalidation·painter order와 [Rally f6037f0](https://github.com/byh-playground/rally-frontier/blob/f6037f05e0ff2163fc11cf0f770e2bc071eaa291/index.html)의 game-owned projection·presentation-only buffer입니다. 해당 게임 코드를 변경하거나 통째로 복사하지 않았습니다. 통합 검사는 [실제 브라우저 E2E](../../tests/browser.e2e.mjs)를 보세요.
