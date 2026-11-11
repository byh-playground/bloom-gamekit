# rendering

## 언제 쓰나

- WebGL 2로 많은 도형·스프라이트·벡터 메시를 **적은 draw로** 그리고 싶을 때(`WebGLDevice` + `VectorContext` + `PrimitivePainter`).
- 공유 텍스처 아틀라스·스프라이트 애니메이션(`createSpriteAnimation`)·재질·그라디언트를 쓰고, context loss 뒤 자원을 복구하고 싶을 때.

## 쓰는 모양

```js
// yarn-mayhem/src/main.js (줄임)
const device = new WebGLDevice(canvas, { alpha: true, antialias: true, depth: false, stencil: false });
const context = new VectorContext(device, {
    mesh: { maxMeshes: 8, maxMeshBytes: 16 * 1024 * 1024, maxInstances: 2048 },
});
const shapes = new PrimitivePainter(context);
// 프레임마다
if (!context.beginFrame({ clearColor: [0, 0, 0, 0] })) return;
camera.applyToContext(context);
// shapes·drawVectorActor로 제출
const renderingStats = context.endFrame();
```

## 쓰지 말아야 할 때

| 이런 일                     | 대신                                            |
| --------------------------- | ----------------------------------------------- |
| 3D 장면                     | three.js 등 3D 엔진                             |
| 게임 정렬·시간선·권위 상태  | 넣지 않습니다. 완성된 pose를 받아 제출만 합니다 |
| SVG를 캐릭터·애니메이션으로 | [vector-assets](../vector-assets/README.md)     |
| 투영·카메라                 | [camera](../camera/README.md)                   |

## GPU 포즈 수치 정밀도

키프레임의 sine easing과 부품 회전은 같은 `poseSinCos`를 사용합니다. GLSL ES 3.00 §4.5.1은 내장 삼각함수의 정밀도를 보장하지 않습니다([원문](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)). Chromium SwiftShader에서는 그 오차가 SVG pivot을 거쳐 CPU 기준 부품 행렬과 약 0.037 단위 차이로 커졌습니다. 각도를 `[-π/2, π/2]`로 줄이고 sine 11차·cosine 12차 다항식으로 계산해 직접 GPU 평가와 GPU 행렬 캐시에 같은 계산을 적용합니다. CPU의 Float64 조회·시계·키프레임 계약은 그대로입니다.

`run-gpu-poses.browser.mjs`는 같은 고정 장면의 CPU/GPU 픽셀과 함께 GPU 행렬 캐시를 직접 읽어 CPU 부품 행렬과 0.001 SVG 단위 이내인지 확인합니다. Float32 GPU 계산이므로 모든 크기·각도에서 CPU와 비트 단위로 같다는 보장은 아닙니다. 다항식 계산 비용이 추가되며 기기별 GPU 성능은 별도 측정 대상입니다.

## 스프라이트 애니메이션

`createSpriteAnimation(context, region, definition)`은 SVG와 무관합니다. `VectorContext`, 장치의 공유 텍스처 아틀라스에서 살아 있는 영역(`device.textureAtlas.allocate`), 그 영역 안의 픽셀 사각형과 양수 `durationMs`를 가진 프레임, 순서가 있는 프레임 인덱스와 `loop: 'loop' | 'once'`를 가진 이름 붙은 clip을 받습니다. 외부 스프라이트 시트와 SVG로 만든 아틀라스는 같은 재생 API를 씁니다. 모든 draw는 `VectorContext.drawQuads`를 거치므로, 어떤 영역·clip·프레임의 스프라이트든 blend와 clip 상태가 그대로인 한 주변의 도형·글리프·그라디언트와 같은 draw를 공유합니다. 배치를 쪼갤 mesh나 텍스처별 상태가 없습니다. run마다 둔 UV와 로컬 사각형이 이미지를 고르고 trim/pivot을 보존하며, 호출자의 행렬은 context 변환과 합성됩니다. 재생은 픽셀을 만들지 않고 프레임에 따라 actor 순서를 바꾸지도 않습니다.

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
const ACTOR = SPRITES.createActor({ clip: 'walk', startedAtMs: 0 });
ACTOR.draw({ timeMs: displayTimeMs, matrix: MATRIX }); // returns the actor's draw sample record, rewritten by the next draw
const SAMPLE = {};
ACTOR.sampleInto(displayTimeMs, SAMPLE); // writes clip, frameIndex, frame, elapsedMs, finished into SAMPLE
ACTOR.setPaused(true, displayTimeMs);
ACTOR.seek(150, displayTimeMs); // elapsed clip time, then absolute clock anchor
ACTOR.setRate(2, displayTimeMs); // preserves the current phase
SPRITES.dispose(); // invalidates actors; REGION stays with its owner
```

프레임 사각형은 논리적인 왼쪽 위 기준 아틀라스 픽셀 좌표를 씁니다. `sourceWidth/sourceHeight`는 trim 전 뷰포트를 나타내고, `sourceX/sourceY`는 그 안에서 trim된 사각형의 위치를 정합니다. `pivotX/pivotY`는 뷰포트 픽셀 좌표이며 기본값은 왼쪽 위입니다. 투명 gutter는 내용 사각형 밖에 있어야 하고 텍스처 안에 들어가야 합니다. definition.textureOrigin은 일반 이미지 업로드에는 top-left(기본값), render target에는 bottom-left로 지정합니다. 텍스처 필터링은 업로드 원본과 맞아야 하고, render target을 만드는 쪽은 일반 이미지 업로드와 반대인 세로 저장 방향을 선언합니다. UV는 내용 사각형을 덮되 픽셀 점유 크기를 줄이지 않습니다.

Actor는 호출자가 주는 절대 시계를 샘플링해 프레임 하나를 고르고 그 duration 동안 유지합니다. `sampleInto(timeMs, out)`는 고른 프레임을 호출자가 가진 레코드에 쓰고 그 레코드를 반환하므로, 프레임마다 샘플링해도 할당이 없습니다. `draw()`는 actor마다 레코드 하나와 quad 제출 레코드 하나를 재사용합니다. 기하 보간이나 crossfade는 없습니다. 시작 시각 이전에는 첫 프레임을 유지하고, loop clip은 전체 duration에서 되감기며, once clip은 시계가 크게 건너뛰어도 마지막 프레임을 유지합니다. 일시정지와 속도 변경은 넘겨 준 시계 시각의 위상을 보존합니다. 시계와 duration은 유한해야 합니다. 영역 메모리와 초기화 비용은 계속 생산자의 책임입니다. context 복원은 보관 중인 영역 원본을 다시 올리지만, render target 생산자는 픽셀을 다시 구워야 합니다.

## 독립 스프라이트 부품의 GPU 포즈

`compilePoseChannels({parts, clips})`는 아트워크와 무관한 2D 부품 키프레임을 `MeshRenderer.createPoseSource`가 받는 숫자 프로그램으로 컴파일합니다. SVG나 이미지 데이터를 불러오지 않습니다. `parts`는 `{id, parent, pivot:[x,y]}` 항목 1~16개이며, `parent`는 다른 부품 id 또는 `null`입니다. 이름 붙은 clip마다 양수 `durationMs`, `loop`(`once`, `repeat`, `alternate`), 0..durationMs를 덮는 순서 있는 키프레임이 있고, 키프레임의 `parts`는 부품 id를 `x`, `y`, `rotation`, `scaleX`, `scaleY`, `opacity` 중 일부에 대응시킵니다. easing은 `linear`, `inOutSine`, `outQuad`입니다. 지원하지 않는 easing·정밀도·구간 한도는 그 clip을 이유와 함께 `supported:false`로 표시하며, `preparePose`는 그 clip이나 쓸 수 없는 GPU 포즈 백엔드에 `null`을 반환합니다. GPU 스프라이트가 필수인 소비자는 결과를 확인하고 실패를 드러내야 합니다. rig마다 한 번 컴파일하고, 반환된 프로그램은 수정하지 않은 채 보관하며, 모든 인스턴스는 원본보다 먼저 dispose합니다.

```js
const program = compilePoseChannels({
    parts: [
        { id: 'body', parent: null, pivot: [0, 0] },
        { id: 'arm', parent: 'body', pivot: [12, 8] },
    ],
    clips: {
        wave: {
            durationMs: 500,
            loop: 'repeat',
            keyframes: [
                { timeMs: 0, parts: { arm: { rotation: -0.3 } } },
                { timeMs: 500, parts: { arm: { rotation: 0.3 } } },
            ],
        },
    },
});
const meshes = context.acquireMeshRenderer();
const source = meshes.createPoseSource(program);
const actor = meshes.createPoseInstance(source);
const defaults = program.partIds.map(() => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 }));
const pose = meshes.preparePose(actor, {
    clipName: 'wave',
    elapsedMs: displayTimeMs,
    basePoses: defaults,
    visible: defaults.map(() => true),
    morph: [0, 0],
});
if (!pose) throw new Error('GPU sprite pose unavailable');
context.preparePoses(); // prepare every actor first, then flush pose updates once
context.drawQuads({ layer: region.layer, filter: region.filter, uvRects, localRects, parts, pose, matrix });
// On shutdown: meshes.deletePoseInstance(actor); meshes.deletePoseSource(source).
```

`uvRects`와 `localRects`는 Float32Array quad이고, `parts`는 quad마다 숫자 프로그램 부품 인덱스를 줍니다. UV 사각형은 공유 아틀라스의 실제 크기와 업로드된 영역의 원점을 쓰며, 원본 이미지의 raw 픽셀이 아닙니다. 아틀라스 할당, draw 순서, 깊이, actor 수명은 호출자가 소유합니다. 모든 actor 갱신 뒤에 `context.preparePoses()`를 부르면 actor마다 포즈 경계가 생기지 않으며, 제출한 뒤에 포즈를 바꾸면 쌓인 작업이 flush될 수 있습니다. 지원되는 GPU 포즈는 작성된 채널을 GPU에서 평가하지만, quad마다 프레임당 84바이트 정점 6개를 여전히 stage하므로 군중의 CPU 제출·업로드 비용은 측정해야 합니다.

`drawQuads({depthWriteAlphaThreshold})`는 선택적으로, **깊이 기록이 켜져 있을 때만** 최종 alpha가 넘겨 준 0..1 문턱 이하인 픽셀을 버립니다. 기본값 0은 기존 투명 픽셀 동작을 유지합니다. 문턱은 quad마다 적용되며 그것만으로 배치를 쪼개지 않습니다. 버려진 fragment는 색과 깊이가 모두 사라지므로 값이 클수록 antialias된 가장자리가 깎입니다. 겹친 스프라이트, 지형, 이미지 품질을 확인한 뒤에 고릅니다. 깊이 기록이 꺼져 있으면 문턱은 효과가 없고 반투명 픽셀은 평소처럼 blend됩니다.

## 순서 있는 native mesh와 atlas quad

`new VectorContext(device, { mesh: { orderedMeshQuads: true } })`는 깊이 기록이 없는 일반 2D 보관 mesh와 그 뒤를 잇는 clip·pose 없는 아틀라스 quad를 순서 있는 배치로 묶도록 선택합니다. 투영·clip·stencil·깊이 정책·blend가 같으면 서로 다른 geometry와 이미지 영역이 draw 하나를 공유합니다. 반투명 몸체 뒤에 얼굴이 오는 순서를 포함해 제출 순서는 보존되며, 렌더러는 게임 actor를 정렬하지 않습니다. 이 옵션의 기본값은 `false`이고, mesh/quad에 텍스처 유닛 6개, 일반 벡터 paint가 배치에 합류하면 7개가 필요합니다. 깊이를 기록하는 불투명 몸체는 native instanced 경로를 유지하며, 이미지 quad만 있는 시퀀스는 기존 벡터 스트림을 유지합니다.

Mesh 정점은 숫자 텍스처에 한 번만 보관됩니다. 배치는 compact한 `[geometryVertex, command]` 참조(각 8바이트)와 16비트 인덱스(각 2바이트)를 인덱싱하며, native mesh가 공유 정점을 재사용하는 방식을 보존합니다. 캡처된 몸체 command는 각 272바이트, 이미지 또는 벡터 스타일 command는 각 128바이트입니다. 세 정점 모두 같은 스타일인 일반 벡터 삼각형은 순서 있는 스트림에 합류합니다. 좌표/UV는 정점당 16바이트로 숫자 텍스처에 들어가고, 연속한 삼각형은 캡처된 색/paint/radial/사각형/깊이 command 하나를 공유합니다. native fragment 구현을 그대로 공유하므로 analytic primitive, gradient, glyph, 기하 clip된 paint는 coverage와 샘플링을 유지합니다. 정점마다 스타일이 다른 삼각형은 native 벡터 경로를 유지합니다. command는 변환, 색, alpha, morph, paint 영역, 깊이를 캡처합니다. GPU 키프레임은 기존 프로그램/상태/override 데이터를 유지합니다. float render target을 쓸 수 있으면 이 opt-in 경로는 먼저 변경된 부품을 작은 숫자 행렬 target으로 평가해 native mesh와 순서 있는 mesh의 정점이 공유하게 합니다. 그 기능이 없으면 직접 GPU 키프레임 프로그램을 쓰며, CPU 평가로 대체하지 않습니다. Mesh 색은 보간 전에 premultiplied 처리하고 이미지는 기존 premultiplied 텍셀 계약을 씁니다.

제한된 LRU가 순서 있는 chunk마다 참조/인덱스 topology와 숫자 command 텍스처를 보관합니다. 바뀌지 않은 topology는 다시 올리지 않고, 바뀐 변환과 포즈는 command와 포즈 행만 갱신합니다. 각 chunk는 자기 자원을 소유하므로 대기 중인 다른 chunk의 데이터를 덮어쓰지 않습니다. 참조/인덱스 버퍼와 숫자 텍스처 행은 2의 거듭제곱 용량을 예약하고 사용 길이가 바뀌면 그 용량을 재사용하며, 비교에는 사용 길이가 포함됩니다. 예산 계산에는 실제로 예약한 용량이 들어갑니다. 용량 때문에 나눌 때도 완전한 삼각형과 모든 포즈 상태를 보존합니다. 캐시된 CPU/GPU topology 저장소는 `mesh.maxMeshBytes`의 두 배로 제한되고, 보관 중인 숫자 geometry는 그 옵션의 두 배로 따로 제한됩니다. 기존 `mesh.maxInstances`가 command/인덱스 staging 한도를 정합니다. 숫자 geometry는 래스터 몸체 아틀라스가 아닙니다.

깊이를 기록하는 mesh, 재질, non-scaling stroke, 3D 변환, 일반 다중 부품 CPU 포즈, alpha 깊이 분류, 실루엣 색 접두, 포즈가 있는 이미지 quad, clip된 일반 이미지 quad는 각 기능의 native 렌더러를 쓰며, 그 전에 순서 있는 배치를 먼저 제출합니다. 일반 이미지 clip은 기하 clip과 antialias coverage를 유지합니다. 호환되는 path paint는 대기 중인 순서 있는 run에 합류할 수 있습니다. 오프스크린 paint, 포즈가 있는 paint, target/stencil/자원 변경은 run의 경계가 됩니다. 변환/paint의 `save/restore`만으로는 draw가 강제되지 않습니다. 포즈/아틀라스 변경은 공유 데이터를 바꾸기 전에 앞선 command를 flush하며, context 손실은 대기 중인 작업을 버리고 복원은 캐시된 GPU 버퍼 내용을 무효화합니다.

`context.stats().mesh.ordered`는 draw, command, 삼각형, 실제 command/참조/인덱스 업로드 바이트, topology 재사용, 보관 중인 바이트 예산을 보고합니다. draw call이 줄었다는 것만으로 프레임이 빨라졌다고 증명되지 않으므로, 장치의 전체 업로드 카운터와 CPU/GPU 시간과 함께 측정합니다. geometry 순서가 바뀌는 프레임은 topology를 다시 올릴 수 있고, 캐시는 CPU/GPU 메모리를 추가로 보관합니다.

## 벡터 스트림의 텍스처

`MeshRenderer`의 mesh에는 텍스처가 없습니다. 텍스처가 있는 모든 draw(스프라이트, 구운 벡터 run, 포즈가 있는 부품, 글리프, 그라디언트 ramp)는 `VectorRenderer` 정점 스트림의 사각형이며, 장치의 `TEXTURE_2D_ARRAY` 하나(`device.textureAtlas`, 아래 참고)에서 샘플링합니다. `VectorContext.drawQuads({ layer, uvRects, localRects, matrix, color, alpha, whiteFlash, forceColor, filter })`는 현재 변환과 clip 위에 사각형을 추가하고, `pose`(준비된 GPU 포즈 핸들)와 `parts`를 주면 run이 같은 정점 셰이더에서 평가되는 그 포즈 부품도 따라갑니다. `uvRects`/`localRects`는 run마다 float 4개 `[offsetX, offsetY, extentX, extentY]`를 담으며, UV 높이가 음수이면 아래에서 위로 저장된 render target을 뒤집습니다. 스트림 정점은 84바이트이고 사각형 하나에 6개입니다.

`WebGLDevice.createTextureArray(width, height, layers, { filter })`, `updateTextureLayer`, `isTextureArray`는 아틀라스 밑에 남아 있는 장치 primitive입니다. 보관 중인 layer와 영역 원본은 context 복원 뒤 다시 올립니다.

**HTML 실행 프리뷰:** [rendering](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering.html) — 벡터, 아틀라스, 재질, 그라디언트(클립 경로 포함), 표정([face](../face/README.md) 모듈이 아틀라스에 굽는 얼굴)이 탭으로 나뉩니다. 탭 주소는 `#vector`, `#atlas`, `#materials`, `#paint`, `#face`입니다.

`WebGLDevice.stats.imageTexUploadCount`와 `imageTexUploadBytes`는 성공한 CPU/DOM 이미지 픽셀 전송을 장치 수명 동안 누적하며 `beginFrame()`에서 초기화되지 않습니다. `createTexture()`는 넘겨 준 이미지나 바이트 plane을 세고, `updateTexture()`는 올린 영역을 셉니다. context 복원 뒤 다시 올린 보관 이미지 픽셀도 다시 셉니다. 빈 텍스처 할당, RGBA32F 숫자 포즈 데이터, render target 할당, GPU 아틀라스 bake, framebuffer-to-texture 복사는 이미지 업로드로 세지 않습니다. 해제된 아틀라스 사각형을 `clearTextureRegion`으로 0으로 채우는 일은 이미지 업로드가 아니라 `regionClears`로 셉니다. 프레임 단위 변화량은 카운터 스냅샷을 비교해 얻습니다. 기존 `textureUploads`/`textureBytes` 카운터는 더 넓은 의미를 유지합니다. `gpuTextureBytes`는 render target 색 텍스처를 포함해 살아 있는 논리 텍스처 저장소를 측정하므로, 색 할당을 따로 더하듯 `gpuRenderTargetBytes`를 더하지 않습니다.

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

### 한 canvas의 VectorContext와 MeshRenderer

`VectorContext.createMesh`/`drawMesh`/`drawVectorActor`는 context의 `MeshRenderer`(`acquireMeshRenderer()`)를 공유하며, yarn과 sketch 표면은 그 mesh의 재질입니다. Mesh draw는 앞서 쌓인 벡터 스트림을 먼저 제출하므로, 벡터 paint, mesh, 이어지는 벡터 paint가 같은 기본 framebuffer에서 제출 순서를 유지합니다. `MeshRenderer`에 남는 mesh(morph, opacity 채널, 셰이더 표면, force-color fallback)는 배치 경계입니다.

## 벡터·이미지 깊이와 배치

`VectorContext.depth`는 `[-1, 1]` clip-space 깊이이며 기본값은 `0`입니다. `depthTest`·`depthWrite`는 기본 `false`, `depthFunc`는 기본 `lequal`이고 MeshRenderer와 같은 8개 비교 함수를 받습니다. `save()/restore()`가 네 상태를 보존하며 `beginFrame()`은 기본값으로 초기화합니다. `VectorRenderer`를 직접 쓰는 경우에도 같은 상태를 사용할 수 있지만 프레임 초기화는 호출자가 소유합니다.

```js
ctx.beginFrame();
ctx.depthTest = true;
ctx.depthWrite = true;
ctx.depth = -0.5;
ctx.fillRect(20, 20, 40, 40); // 가까운 물체를 먼저 제출
ctx.depth = 0.5;
ctx.fillRect(30, 30, 40, 40); // 겹친 부분은 깊이 검사에서 제외, 같은 stream draw
ctx.depthWrite = false;
ctx.depth = -0.5;
ctx.drawRegion(faceRegion, 25, 25, 20, 20); // 투명 얼굴 사각형은 깊이를 덮지 않음
ctx.endFrame();
```

깊이는 각 정점에 담으므로 깊이만 바뀌는 path·analytic primitive·gradient·glyph·일반/posed quad는 같은 배치에 남습니다. 깊이 검사·기록·비교 함수가 달라지면 이전 배치를 제출합니다. `drawMesh()`와 `drawVectorActor()`도 context 깊이 상태를 따르며, actor options의 명시값이 우선합니다. 렌더러는 물체를 정렬하지 않습니다. 병종·메시별 제출 순서와 투명 물체의 painter order는 호출자가 소유합니다.

깊이 검사나 기록을 켜면 활성 framebuffer에 깊이 attachment가 필요합니다. 기본 canvas는 `new WebGLDevice(canvas, { depth: true })`로 만듭니다. 현재 render target은 깊이 attachment가 없으므로 깊이를 요청한 stream draw는 오류입니다. `beginGroup(opacity < 1)`도 깊이 검사·기록을 먼저 꺼야 하며, 불투명 direct group은 기존 깊이 상태를 유지합니다. depth-write stream은 최종 alpha가 0인 fragment를 버려 투명한 이미지 여백이 뒤 물체를 가리지 않게 합니다. 부분 투명도는 여전히 색 합성 순서가 필요하므로 보통 깊이 기록을 끄고 뒤에서 앞으로 제출합니다.

## Mesh depth

### SVG non-scaling stroke

vector-asset 컴파일러는 `vector-effect="non-scaling-stroke"`를 mesh 플래그로, stroke의 접선/오프셋 데이터를 기존 11-float 레코드에 보존합니다. 정점 셰이더는 카메라·객체·부품 변환 뒤에 표시된 직선 cap 정점만 논리 CSS 픽셀로 확장하며, 같은 mesh의 다른 fill은 원래 위치를 유지합니다. 기본 framebuffer의 draw는 canvas client 크기를 쓰고, 활성 `WebGLDevice` render target의 draw는 `drawMesh()`에 `strokeViewport: [logicalCssWidth, logicalCssHeight]`를 넘겨야 합니다. target의 물리 크기로는 논리 CSS 크기를 알 수 없으므로 target 뷰포트를 빠뜨리면 예외가 납니다. 컴파일러가 지원하는 도형/cap 범위와 fail-fast 동작은 [vector-assets](../vector-assets/README.md)에 있습니다.

`MeshRenderer.drawMesh(mesh, { viewProjection, worldMatrix, matrix, clips, depth, depthTest, depthWrite, depthFunc })`는 3D 월드 pass도 지원합니다. `viewProjection`과 affine `worldMatrix`는 column-major 4×4 행렬이고, `matrix`는 월드 공간에 합성되는 선택적 2D draw별 변환으로 남습니다. 이 모드에서는 `projection`을 넘기지 않습니다. 볼록 clip 다각형은 변환된 월드 XY 좌표에 머물러, 월드 clip 하나를 변환이 다른 actor들이 그대로 재사용할 수 있습니다. mesh와 Yarn 셰이더 표면 경로는 같은 clip 평면을 씁니다. clip된 non-scaling stroke는 화면에서 확장한 위치를 역 view-projection으로 되돌린 뒤 그 월드 공간 평면을 평가합니다.

`MeshRenderer.drawMesh(mesh, { projection, depth, depthTest, depthWrite, depthFunc })`는 mesh 인스턴스에 `[-1, 1]` 범위의 명시적 정규화 장치 깊이를 줍니다. `depthTest`와 `depthWrite`의 기본값은 `false`이며 painter 순서의 2D 동작을 유지합니다. 깊이 버퍼는 `new WebGLDevice(canvas, { depth: true })`로 요청합니다. `depthFunc`는 장치의 `never`, `less`, `equal`, `lequal`, `greater`, `notequal`, `gequal`, `always` 함수를 받고 기본값은 `lequal`입니다.

`drawMesh()` 호출마다 다른 깊이를 줄 수 있고, 같은 mesh와 깊이 정책을 쓰는 인접한 호출은 여전히 instanced draw를 공유합니다. `parts` 항목도 `[-1, 1]` 범위의 `depth`를 줄 수 있으며 이는 그 인스턴스의 깊이에 더해집니다. 합은 `[-1, 1]` 안에 있어야 합니다. 깊이 정책이 바뀌면 대기 중인 배치를 쪼개므로 draw 하나가 깊이 검사/기록 설정을 섞지 않습니다. 렌더러는 투명 geometry를 정렬하지 않습니다. 필요한 painter 순서로 제출하고, 반투명 overlay에는 보통 `depthWrite: false`를 지정합니다.

Mesh pass는 clip 공간 Z 값을 기록하고 draw마다 깊이 검사/기록 상태를 다시 지정합니다. 뒤따르는 벡터 스트림 flush는 캡처해 둔 context 깊이 정책을 다시 지정하며, 그 기본값은 깊이 검사와 기록을 끄는 것입니다. 한 canvas에서 Canvas2D context와 WebGL context를 둘 다 얻을 수는 없습니다. 지금 필드 전체를 Canvas2D로 그리는 호출자는 mesh를 그 필드의 painter 순서에 끼워 넣기 전에 별도의 canvas/합성 계층을 두거나 필드 전체를 GameKit WebGL로 옮겨야 합니다.

drawMesh()가 `depthWriteAlphaThreshold`와 함께 depthWrite: true를 쓰면, 유효한 정점 alpha 세 개가 모두 양수이고 문턱 이상인 연속 삼각형에 대해서만 깊이 기록을 켭니다. 유효 alpha에는 정점 alpha(forceColor가 대체하지 않는 한), draw alpha, 색 alpha, 참조하는 각 부품의 opacity가 포함됩니다. 인덱스가 있는 expression 변형은 선택된 인덱스 순서로 분류합니다. 렌더러는 연속한 run마다 원래의 정점/인덱스 순서대로 제출하며, 불투명 삼각형을 반투명 삼각형보다 앞으로 옮기지 않습니다. run이 여러 개 필요한 mesh는 painter 순서를 보존하도록 인스턴스마다 따로 내보내고, run이 하나인 mesh는 인접 instancing을 유지합니다. 반복되는 분류는 mesh마다 제한된 캐시에서 재사용합니다. 문턱을 생략하면 기존의 mesh 전체 depthWrite 불리언 동작을 유지합니다.

### 선형 그라디언트와 보관 clip 윤곽

`VectorContext.createLinearGradient(x0,y0,x1,y1)`는 끝점과 stop 데이터를 보존합니다. 그라디언트는 만들 때의 현재 affine 변환을 캡처하고, `addColorStop(offset,color)`는 넘겨 준 offset/color 쌍을 그대로 보관하며 같은 offset이 중복되면 넣은 순서를 유지합니다. `fill()`과 `stroke()`는 작성된 벡터를 따라 그라디언트를 샘플링합니다. 구현은 한 stop 집합을 처음 쓸 때와 stop을 고친 뒤에 premultiplied 1024×1 RGBA ramp를 래스터화합니다. ramp는 stop을 키로 하므로, 매 프레임 같은 stop으로 그라디언트를 다시 만들어도 보관된 ramp를 재사용하며 래스터화나 업로드를 하지 않습니다. 그라디언트는 stop을 최대 32개 지원하고, context는 서로 다른 ramp를 최대 64개 보관하며 현재 프레임에서 쓰지 않은 ramp를 제거합니다. 그라디언트 paint는 벡터 fill과 stroke에서 지원하고, 텍스트와 `fillTriangleFan()`은 단색이어야 합니다.

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

`VectorContext.createClipPath(flatXY,{rule})`는 활성 프레임 밖에서 보관되는 단일 윤곽 clip을 만듭니다. 평탄한 입력은 작성된 점 순서를 유지하고, 삼각분할은 만들 때 한 번 일어나며, mask 삼각형은 보관되었다가 context 복원 뒤 다시 올라갑니다. 윤곽은 점이 최대 256개이고, 단순하며 자기 교차가 없고 퇴화하지 않아야 하며, 연속된 중복 점이 없어야 합니다. 지금의 보관 clip은 구멍이나 여러 윤곽을 받지 않습니다. 살아 있는 clip 핸들은 최대 64개, 보관 삼각형 데이터는 최대 16 MiB이며, 분할된 mask는 삼각형을 최대 16,384개 가질 수 있습니다.

```js
const eggClip = ctx.createClipPath(new Float32Array([18, 12, 82, 12, 92, 44, 82, 78, 18, 78, 8, 44])); // create outside beginFrame()
ctx.beginFrame();
ctx.clipPath(eggClip, { transform: [1, 0, 0, 1, 4, 0] });
ctx.drawMesh(eggMesh);
ctx.endFrame();
ctx.deleteClipPath(eggClip); // only after it is removed from every saved clip stack
```

`clipPath()`는 활성 stencil attachment로 현재 clip과 교집합을 구합니다. 기본 framebuffer나 활성 render target에 stencil 버퍼가 없으면 명시적으로 실패하며, 보관된 오목 윤곽을 근사하지 않습니다. stencil clip은 최대 255개까지 중첩할 수 있습니다. stencil 상태는 `save()/restore()`, 오프스크린 opacity group, context 손실, 일반적인 painter 순서 전환을 거쳐 복원됩니다. 활성·저장된·group clip 스택이 아직 참조하는 핸들을 삭제하면 예외가 납니다.

즉시 `clip()` 경로는 한 번에 볼록 윤곽 하나를 받으며 작성된 점은 최대 1,024개입니다. 합쳐진 edge plane이 장치 한도에 들어가는 동안은 기존 볼록 clip 경로에 머무르고, 초과하는 볼록 윤곽은 fan으로 삼각분할한 stencil mask를 씁니다. 오목하거나 윤곽이 여러 개인 입력은 `createClipPath()`와 `clipPath()`를 써야 합니다.

### 혼합 alpha 깊이 run의 안전한 배치

`MeshRenderer`와 `VectorContext`는 `safeAlphaRunBatching`의 기본값이 `true`이며, 이전의 인스턴스별 제출 경로를 유지하려면 `false`를 넘깁니다. 이 옵션은 `depthWriteAlphaThreshold`가 연속 run을 여러 개 만들고 장치가 instancing을 지원할 때만 적용됩니다. 보관된 부품별 bound와 현재 부품/morph/객체 변환으로 보수적인 화면 공간 bound를 만듭니다. 새 인스턴스는 확장된 bound가 현재 후보 그룹의 합집합 bound와 겹치지 않을 때만 배치에 들어가며, 이는 상수 시간 겹침 검사로 앞선 모든 인스턴스와 겹치지 않음을 보장합니다. 1.5픽셀 guard가 래스터 가장자리/샘플 coverage를 덮습니다. 어떤 command도 명시적 painter 경계를 넘지 않고, bound가 겹치거나 run 패턴이 맞지 않거나 투영이 affine이 아니거나 mesh에 non-scaling stroke가 있으면 후보 배치를 끝내고 이전 draw 순서를 보존합니다.

Bound는 mesh를 만들 때 보관한 부품별 범위에서 계산하며, 렌더러는 프레임마다 삼각형을 다시 훑거나 분할하지 않습니다. `stats()`는 실제 `draws`와 `instances`를 구분하고 `alphaRunSafeBatches`, `alphaRunBatchedInstances`, `alphaRunDrawsSaved`, `alphaRunSafeRunDraws`, `alphaRunImmediateRunDraws`, `alphaRunOverlapBoundaries`, `alphaRunSignatureBoundaries`, `alphaRunUnbatchableBounds`, `alphaRunImmediateInstances`, `flushReasons`, `drawDispatchReasons`를 보고합니다. flush 이유는 queue 경계를 세고, dispatch 이유는 이 렌더러가 낸 모든 `device.draw()`를 분류하므로 합계가 `draws`와 같습니다. 이 값들은 제출 카운터이며 GPU 시간 측정이 아닙니다.

`npm run test:rendering:vector-gradient-clip`은 47px와 74px의 그라디언트 픽셀, 벡터/mesh/group을 거치는 160점 오목 clip, 한도, context 복원, 해제를 검사합니다. `npm run test:rendering:alpha-run-batching`은 고정된 겹침/비겹침 혼합 alpha 유닛을 브라우저 `readPixels`로 원래의 유닛별 painter 순서와 비교하며, 정확성 시험이지 성능 벤치마크가 아닙니다.

## 공유 텍스처 atlas 배열

`device.textureAtlas`(`TextureAtlasArray`, 옵션 `new WebGLDevice(canvas,{ textureAtlas:{width=2048,height=1024,layers=2,gutter=1} })`)는 작은 이미지를 한 `TEXTURE_2D_ARRAY`의 영역(region)으로 나눠 담는 장치 단위 단일 원본입니다. `estimateTextureAtlasLayers(regions,{width,height,gutter})`는 실제 할당 순서의 `{width,height}` 목록을 GPU 생성 없이 동일한 선반 배치로 계산해 필요한 초기 레이어 수를 반환합니다. 초기 할당 목록은 중간 해제·재사용을 반영하지 않으므로 실제보다 보수적으로 산정할 수 있습니다. `VECTOR_RENDERER_ATLAS_REGIONS`는 VectorRenderer 하나가 생성할 때 선점하는 영역 목록이며 실제 할당도 같은 원본을 씁니다. 목록에 없는 글리프나 동적 gradient의 공간은 별도로 여유를 둬야 하며 기기 레이어 한도도 확인해야 합니다. `allocate(w,h,{filter})`는 `{layer,x,y,width,height,uvRect,filter}`를 돌려주고 `upload(region,source,{premultiplied,extendEdges})`가 픽셀을 씁니다(`extendEdges`는 바이트 소스의 가장자리를 gutter로 복제해 CLAMP_TO_EDGE처럼 보이게 함). `release(region)`은 픽셀을 지우고 같은 크기 요청에 재사용하며, 마지막 region을 풀면 배열도 삭제됩니다. 영역 업로드는 `Device.updateTextureRegion`이 원본을 보관해 컨텍스트 복구 때 다시 올립니다. `filter:'nearest'` region은 배열의 하드웨어 필터가 하나뿐이므로 셰이더가 texel 중심으로 맞춥니다.

`VectorRenderer`의 흰 texel, `VectorContext`의 gradient ramp, `GlyphAtlas` 페이지가 모두 이 배열의 region입니다. 정점은 layer·gradient 종류(없음/선형/radial/radial 빈 영역)·white flash·nearest 여부·radial 파라미터·ramp 사각형·깊이를 담아(정점당 84바이트), 같은 blend·clip 상태의 fill, 선형·radial gradient, 글리프가 한 draw로 제출됩니다. 배치를 끊는 것은 blend 전환, stencil clip 변경, 반투명 group(render target을 다른 sampler로 합성)뿐입니다. `drawGlyphQuad(region, x, y, w, h, uv, color)`의 `uv`는 배열 좌표이고 `GlyphAtlas`가 callback에 주는 `texture`는 `region`으로 바뀌었습니다. gradient 객체의 `texture`도 `region`입니다.

## VectorContext와 재사용 primitive painter

`VectorContext(device,{glyphAtlas,onError,initialVertices,maxVertices,safeAlphaRunBatching,mesh})`는 게임의 2D draw adapter에서 반복되기 쉬운 paint/state/path 알고리즘을 공개합니다. canvas와 WebGL context, 프레임 자원은 caller가 만들고, context가 `VectorRenderer`, 첫 사용 때 만드는 `MeshRenderer`를 소유하고 `dispose()`에서 해제합니다. 렌더러를 따로 만들어 주입하거나 `context.meshRenderer`에 대입하지 않습니다. 메시 한도는 `mesh:{maxMeshes,maxMeshBytes,maxInstances,poseBackend}` 옵션으로 넘깁니다. WebGLDevice와 GlyphAtlas는 항상 caller 소유이며 import만으로 DOM·GPU·asset 작업을 하지 않습니다.

```js
import { WebGLDevice, VectorContext, PrimitivePainter } from './rendering.js';
const device = new WebGLDevice(canvas, { depth: false, stencil: false });
const ctx = new VectorContext(device, { glyphAtlas, onError: reportRenderError });
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
- `drawVectorActorSilhouette(actor,{matrix,color,width,radius,outlineScale,...drawVectorActor 옵션})`는 액터의 외곽선과 본체를 `drawMeshSilhouette`와 같은 규칙(8방향·`outlineScale`, 그룹 opacity 한 번)으로 한 번의 순서 있는 인스턴스 draw로 제출합니다. `outlineExpression`을 주면 외곽선 복사본만 그 표정으로, 본체는 액터의 현재 표정으로 그립니다(외곽선 전용 표정을 SVG에 따로 둔 에셋용, 순서 있는 draw 두 번이며 `setPartVisible` 덮어쓰기와는 함께 못 씁니다). 액터를 외곽선 오프셋마다 따로 그리지 않고, 카메라(context 변환)는 같은 합성을 따르며 월드 모드는 지원하지 않습니다.
- `context.preparePoses()`는 준비된 액터 포즈를 제출 전에 한 번에 평가합니다(렌더러를 직접 얻지 않아도 됩니다). 포즈 통계는 `context.stats().mesh.poses`입니다.
- `drawMeshSilhouette(mesh,{transform,morph,parts,color,width,radius,outlineScale})`는 silhouette와 본체를 painter order대로 제출합니다. `outlineScale`을 생략하면 기존 8방향·중심 outline 9개와 body를 쓰며, `outlineScale >= 1`이면 변환 중심 기준으로 확장한 outline 1개와 body 1개를 씁니다. 두 경로 모두 색/forceColor, 현재 및 local transform, morph/parts, clip, white-flash, globalAlpha와 group opacity를 캡처합니다. ANGLE WebGL1에서 확장 경로는 2 instance/128 bytes, 기본 경로는 10 instance/640 bytes이며, uniform fallback도 각각 2회/10회 draw합니다. 확장 경로는 silhouette callback과 pixel-identical하지 않은 모양 근사이므로 필요한 게임 아트에서만 명시하고 실제 화면을 확인하세요. 임의 path/vector callback에는 generic `withSilhouette`을 그대로 사용합니다.
- Stroke 폭은 기존 게임 adapter와 같이 변환 행렬 basis 중 큰 크기에 맞춰 조정합니다. dash 길이와 phase는 변환된 path 공간에 적용합니다. 공통 vector stroke는 butt/round/square cap, miter/round/bevel join을 그리며 miter 길이는 `miterLimit`으로 제한합니다. clip 호출 하나에는 contour 하나를 받습니다. path hole은 clip 대신 `fill(rule)`로 처리합니다.
- `beginFrame({width,height,clearColor})`와 `endFrame()`은 caller 소유 `WebGLDevice` 프레임을 감쌉니다. begin이 false이면 context loss 등으로 해당 프레임을 건너뜁니다. `stats()`는 실제 device draw/vertex/upload counter, GPU buffer/target byte와 개수, vector staging byte를 보고합니다. `dispose()`는 이 context가 생성한 VectorRenderer, gradient texture, static vertex buffer만 해제하며 device나 주입받은 atlas/renderer는 해제하지 않습니다. static vertex 데이터는 context 복구 후 다시 upload합니다. `onError(error,details)`는 caller callback이며 프레임 오류는 다시 throw됩니다.
- `createStaticMesh(vertices,{strideFloats})`는 재사용할 CPU vertex를 보관하고 device buffer에 upload합니다. `drawStaticMesh(mesh,{pipeline,projection,uniforms,textures,blend,depth})`는 caller draw 전에 공통 painter queue를 flush합니다. shader/material, projection uniform, depth/stencil 설정, pass 순서와 mesh geometry는 caller가 공급합니다. generic context는 terrain 정책을 정하지 않습니다.
- radial gradient는 fill이 있는 frame 동안 gradient 객체당 256×1 RGBA ramp 1KiB와 GPU texture 1KiB를 사용합니다. 같은 stop의 gradient는 객체가 달라도 ramp texture 하나를 공유하고, stop을 바꾸면 새 stop의 ramp를 찾거나 만듭니다. `endFrame()`은 gradient 객체와의 연결만 지우고 ramp texture는 context가 보관하므로(최대 64개, 오래 안 쓴 것부터 제거) frame을 거쳐 계속 생성되는 gradient 객체를 강하게 보관하지 않으면서 같은 stop은 다시 올리지 않습니다. texture sampling으로 각 fragment의 반경을 계산합니다.
- `PrimitivePainter`는 authored fan을 Canvas2D target에서 한 번의 path fill로 제출하고, WebGL target에서는 원래 fan 삼각형을 공용 vector buffer에 queue합니다. 배치 변경 전 실제 game-shaped browser helper에서 WebGL 26 draw calls / 1,170 vertices / 37,440 uploaded vertex bytes, 19,456 texture upload bytes, vector staging/GPU buffer 각 8KiB, opacity target 16KiB를 관찰했습니다. CPU submit은 한 SwiftShader scene 표본에서 13.2ms였고 GPU 완료시간은 아닙니다. UI Canvas2D primitive 두 개의 CPU submit은 0.7ms, 40×40 RGBA reference와 pixel 차이 0이며 해당 paint target의 GPU upload는 0입니다.
- 같은 helper가 새 gradient 객체 16개를 4 frame에 걸쳐 만들고 frame당 반복 fill/stop update를 확인합니다. `activeGradientTextureCount`(그 frame의 gradient 객체 수)는 각 endFrame에서 0으로 돌아오고, `retainedGradientRampCount`는 보관 중인 ramp 수이며, GPU textureCount는 같은 2개 baseline에 머뭅니다(내부 white texture와 재사용 opacity target). 각 ramp는 1KiB의 transient CPU bytes이며 texture stop update는 같은 frame 안에서 texture identity를 유지합니다. 이 제한된 SwiftShader fixture는 게임 전후 FPS 비교가 아닙니다.
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

`VectorRenderer`는 같은 canvas를 소유한 `WebGLDevice` 위에서 path tessellation·transform·clip·painter-order stream·textured glyph 제출을 제공합니다. 프레임·projection·정렬과 그림 내용은 caller가 소유합니다. 인접한 fill·stroke·fan·glyph는 texture/radial/white-flash 상태가 같으면 재사용 geometry buffer에 순서대로 누적합니다. transform·clip·색은 각 vertex를 만들 때 반영되므로 과거 geometry를 변경하거나 재정렬하지 않습니다. texture 상태 변경, group 경계, capacity, 명시적 flush에서 제출합니다. CPU/GPU vertex storage는 기본 4096 vertices(각 336 KiB)에서 시작해 필요할 때 2배로 자라며 기본 상한은 262144 vertices(각 최대 21 MiB)이며 device.maxBufferBytes가 더 작으면 그 안으로 제한합니다. 상한은 한 batch의 저장 한도이고, 초과 geometry는 삼각형 경계에서 제출한 뒤 계속 처리합니다. 긴 인접 stream은 과거의 경로별 즉시 제출보다 staging high-water가 커질 수 있으므로 작은 상한으로 메모리/호출 수를 조절하세요. `beginGroup(opacity,bounds)`는 불투명 기본값 `1`이면 target 없이 직접 경로를 유지하고, 반투명 그룹은 canvas-screen bounds의 RGBA target에 그린 뒤 한 번 합성합니다. 생략한 bounds는 viewport 전체입니다. target은 중첩 깊이별로 보관되고 필요한 크기의 다음 power-of-two 버킷으로 할당되어 작아지는 bounds와 인접한 크기에서는 재사용됩니다. bounds보다 바깥의 입력은 잘립니다. `stats.gpuRenderTargetBytes`로 실제 target byte 수를 확인하세요.

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

- 경로는 장치 backing viewport의 픽셀 좌표를 씁니다. `moveTo`/`lineTo`, 2차/3차 Bezier 샘플링, `closePath`, `fill`(`nonzero`/`evenodd`), `stroke(width)`, `polygon`, affine 변환, save/restore, 중첩된 사각형 clip을 지원합니다. 곡선은 기본 12/16개 구간이며 2..256 범위의 구간 수를 명시할 수 있습니다. fill은 평탄화한 윤곽에 scanline 사다리꼴 삼각분할을 쓰므로, 입력은 유한하고 자기 교차가 없는 윤곽이어야 합니다. even-odd 감김으로 구멍을 지원하며 자기 교차 복구는 지원하지 않습니다.
- `beginGroup(opacity,bounds)`의 bounds는 렌더러의 픽셀 좌표 공간입니다. target은 2의 거듭제곱 크기로 버킷화되어 깊이별로 재사용되고, 내용은 요청한 viewport와의 교집합으로 clip됩니다. 너비와 높이 버킷이 독립이므로 최악의 할당은 요청 면적의 4배에 가까울 수 있습니다. target 텍스처 메모리는 RGBA8(중첩 깊이마다 `4 × 할당 너비 × 할당 높이` 바이트)이고 CPU readback은 없습니다. target은 색 전용이며 게임의 깊이/stencil pass는 따로 남습니다. 할당과 clear 대역폭은 추가 비용이고 target 생성은 cold path입니다.
- `GlyphAtlas(device,{width,height,data,glyphs,unitsPerEm,ascent,descent,filter,missingGlyph,replacement})`는 보관된 왼쪽 위 원점 RGBA 바이트와 코드 포인트를 키로 하는 metric `{x,y,width,height,advance,bearingX,bearingY}`를 받습니다. metric은 아틀라스 픽셀과 폰트 상대 단위입니다. 한 번 올리고 실행 중 Canvas2D 측정/래스터화, crop, 픽셀 readback을 하지 않습니다. `measureText`는 width/ascent/descent를 보고합니다. `fillText`와 `strokeText`는 `fontSize`, `align`(`left|center|right`), `baseline`(`top|hanging|middle|alphabetic|ideographic|bottom`), RGBA 색을 받습니다. 기본 missing-glyph 모드는 예외를 던지고, `skip`과 명시적 replacement는 선택 사항입니다. 같은 아틀라스의 인접한 글리프는 텍스트 draw call 하나로 묶입니다.
- `FontAssetLoader(device,{url,version,sha256,bytes},{signal,onProgress})`는 호출자가 고른 에셋을 CORS로 가져오고, 파싱 전에 정확한 바이트 수와 SHA-256을 확인하며, 스키마와 디코딩한 mask 해시를 검증한 뒤 `ready`를 `GlyphAtlas`로 resolve합니다. 상태는 `loading`, `ready`, `error`, `cancelled`, `disposed`이고, 진행 단계는 `download`, `verify`, `decode`, `ready`, `error`, `cancelled`, `disposed`입니다. 변하지 않는 URL/version/hash/byte 묶음을 명시적으로 줍니다. `cancel()`은 그 loader가 ready가 되지 못하게 하며, 공유된 진행 중 fetch는 다른 소비자를 위해 계속되어 브라우저 HTTP 캐시에 완료될 수 있습니다. `dispose()`는 장치별 아틀라스 lease를 해제하고, 마지막 lease가 GPU 텍스처와 보관 픽셀을 삭제합니다. 실패한 로드는 메모리 캐시에서 제거되어 이후 loader가 재시도할 수 있습니다. 같은 version/hash 쌍은 현재 JavaScript realm 안에서 진행 중 fetch와 CPU 디코딩을 하나로 공유하고, 한 `WebGLDevice`의 같은 쌍은 참조 수로 아틀라스 텍스처 하나도 공유합니다. 다른 탭, 브라우저 프로세스, origin, top-site 파티션은 브라우저 HTTP 캐시 정책에 달려 있어 바이트 공유를 약속하지 않습니다. 이 API는 CacheStorage에 쓰지 않습니다.
- 공개된 `noto-sans-kr-700-v1` 에셋은 버전이 붙은 750개 코드 포인트 목록(한글 음절 585개 포함)만 정확히 덮으며, 한국어나 Unicode 전체를 덮는다고 주장하지 않습니다. 없는 코드 포인트는 기본적으로 예외를 던집니다. 호출자가 에셋을 고르고 없는 글리프를 명시적으로 처리합니다. 목록을 늘리거나 바꾸려면 새 에셋 버전, 새 SHA-256/바이트 메타데이터, manifest 갱신이 필요합니다. 폰트 프로그램은 내려받지 않습니다. Noto Sans KR OFL 라이선스와 목록/생성기 출처는 미리 구운 mask 및 metric과 함께 저장됩니다.
- `VectorRenderer.flush()`는 대기 중인 모든 path/fan/glyph 정점을 제출합니다. 직접 쓰는 쪽은 device.endFrame(), 픽셀 readback, device.clear(), 텍스처 갱신/삭제, 다른 렌더러/장치 pass 전에 flush해야 합니다. VectorContext는 자기 프레임과 mesh/gradient 경계를 직접 처리합니다. `dispose()`는 pipeline, 스트림 버퍼, 흰 텍스처, group target을 해제합니다. `GlyphAtlas`는 따로 dispose합니다. 공유 `WebGLDevice`는 계속 호출자 소유입니다.

[rendering 예제](./examples/index.html)의 vector 탭이 polygon/곡선/텍스트/clip/group 합성을 보여 줍니다. 브라우저 E2E는 alpha 128, fill 구멍, clip, 글리프, 중첩 opacity, 제한된 target 할당, target 복원에 대해 실제 WebGL 픽셀을 읽습니다. 이는 기준이 되는 Chromium WebGL1/SwiftShader 경로를 검증하는 것이지 모바일 GPU 성능이 아닙니다. 경로 평탄화, scanline 삼각분할, clip 다각형 교차, 기하 글리프 윤곽, staging 증가, 업로드된 정점 바이트, render target clear는 CPU/GPU 작업을 더하며, 예제는 작은 장면 하나에 대한 CPU 제출 시간(GPU 완료가 아님)과 카운터를 보고할 뿐 장치 전체 벤치마크가 아닙니다.

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

`modules/rendering/assets/fonts/`가 미리 구운 데이터, 명시적 코드 포인트 목록, 생성기, 출처, metric, 라이선스를 소유합니다. `npm run build`는 고정된 에셋 목록을 `dist/assets/fonts/`로 복사하고, 정식 `manifest.json` 스키마 2는 기존 JavaScript 번들과 함께 각 에셋의 고정 경로·버전·바이트 수·SHA-256을 나열합니다. 검증기는 경로/스키마가 어긋나면 거부하고 게시 전에 바이트를 검증합니다. main 전용 게시기는 나열된 파일만 갱신하고 기존 dist 파일과 이력을 보존합니다. 에셋은 `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/assets/fonts/noto-sans-kr-700-v1.json`처럼 커밋에 고정한 URL에서 가져오며, 브랜치 최신 URL을 쓰거나 GitHub Raw에 브라우저 CORS 계약이 있다고 가정하지 않습니다. 모듈은 텍스처를 만들기 전에 CORS 응답, 바이트 길이, 바깥 SHA-256, PackBits 길이, 압축된/원본 mask의 SHA-256 값을 모두 검증합니다.

브라우저의 네트워크 캐시는 origin/top-site로 분할되며 브라우저가 관리합니다. 모듈의 fetch/디코딩 캐시는 JavaScript realm 하나로, GPU 아틀라스 캐시는 `WebGLDevice` 하나로 제한되어 탭이나 origin 사이의 공유를 보장하지 않습니다. 처음 오프라인 방문은 네트워크가 필요합니다. 재방문은 브라우저 HTTP 캐시가 변하지 않는 응답을 보관하고 있으면 그 캐시에서 불러올 수 있으며, 애플리케이션은 fetch/캐시 실패를 로드 오류로 다루고 재시도를 제공해야 합니다. context 복원은 `WebGLDevice`가 소유한 보관 텍스처 원본을 씁니다.

[device browser 회귀](./tests/device.browser.mjs)는 실제 built ESM과 Chromium/WebGL에서 depth LEQUAL/GREATER, stencil write/read/clear, FPV11 두 texture·radial·white mask, straight/premultiplied alpha, 부분 atlas update, NPOT luminance fog, GPU frame copy, bounded buffer 재사용, context 복구 및 해제를 검증합니다. 게임 전체 parity는 각 migration의 게임 E2E가 별도로 확인해야 합니다.

### 벡터 제출 비용 측정 (2026-10-10)

기준 `812a6e2`와 변경 소스를 Node 24의 recording device에서 비교했습니다. 4 frame × (200 rect fill + 5 stroke + 20 gradient fill + white-flash + 반투명 group), 중간 stop 변경 1회에서 draw/upload 호출은 각각 917→21입니다. 업로드 geometry 자체와 순서·projection·clip 결과·제출 시점의 texture bytes는 동일했고 CPU staging은 양쪽 128KiB였습니다. 낮은 batch 한도 7 vertices 경계도 확인했습니다. gradient raster 생성 5회와 gradient texture 생성 4회는 양쪽 동일하며 frame 간 보관 캐시는 추가하지 않았습니다.

이는 실제 GL 호출·GPU 실행을 포함하지 않는 제한된 비용 표본이며 FPS 개선 주장에 사용하지 않습니다. 실제 Chromium/WebGL E2E에는 batching/capacity/painter order, gradient stop 변경·context loss 시나리오를 반영했지만 이 환경의 Chromium socket 권한 제한으로 실행하지 못했습니다. 실기기/GPU 검증은 남아 있습니다. silhouette topology·인스턴스 구조 재작성과 frame 간 gradient 캐시는 당시 소비자에서 이익이 확인되지 않아 포함하지 않았습니다(v0.26.2에서 프레임마다 gradient를 새로 만드는 장면의 측정으로 stop 기준 ramp 캐시를 추가했습니다).

## 2D 프레임 비용 벤치마크

`npm run benchmark:rendering -- <label> [high|low]`는 2D 그리기 경로별 프레임 비용을 같은 장면 크기(1280x720)에서 잽니다. 장면마다 그리기 호출 수, 정점 수, 업로드 바이트, 프레임 제출 CPU 시간, GPU 시간(`EXT_disjoint_timer_query_webgl2`)의 중앙값(60프레임)을 `project/docs/rendering-benchmark.json`에 label별로 기록합니다. GPU 열은 실제 GPU 브라우저에서만 의미가 있습니다: `CHROMIUM_EXECUTABLE_PATH`로 Chrome/Edge를 지정하세요. SwiftShader 값은 동작 확인용입니다. 모바일 기기는 측정하지 않습니다. 장면 목록과 기록은 JSON에 있고, 게임이 쓰는 그라디언트는 프레임당 64개로 제한되어 있어 그 한도 안(60개)에서 잽니다. 그리기 호출 수만 세는 `npm run benchmark:draw-batching`(`project/docs/draw-batching-benchmark.json`)와 역할이 다릅니다.

## 인덱스가 있는 보관 geometry

`WebGLDevice.createIndexBuffer()`와 `uploadIndices(handle, Uint16Array)`는 WebGL 2 element 버퍼를 소유합니다. `MeshRenderer.createMesh()`는 완전히 펼친 삼각형, 또는 11-float 정점 레코드 위의 삼각형 인덱스 `Uint16Array`를 받으며, 인덱스가 있는 mesh는 `drawElements` 또는 대응하는 ANGLE instanced 호출로 제출됩니다. 보관 바이트 예산, context 복원, 해제에는 두 버퍼가 모두 포함됩니다. `MeshBuilder.combine()`은 painter 순서를 유지하면서 인덱스가 있는 입력을 다시 매핑해 보존합니다.

`MeshRenderer.createMesh()`는 같은 정점 레코드 위에서 이름을 `Uint16Array`에 대응시키는 별도의 맵 두 개를 받습니다. 의미상 표정 변형을 위한 `expressionIndices`와, 호스트가 고르는 일반 삼각형 범위를 위한 `indexVariants`입니다. 키는 안정적인 이름이어야 하고 두 맵에 동시에 나타날 수 없습니다. `drawMesh(mesh,{indexVariant:name})`는 둘 중 어느 맵에서든 목록을 고르며, 이름이 없으면 기본 `indices` 목록(또는 펼친 삼각형)을 그립니다. 고른 목록은 그 draw의 기본 목록을 대체하며, 호스트는 여러 범위를 painter 순서로 제출하고 shader-surface draw 같은 경계에서 flush합니다. 렌더러는 목록을 정렬하거나 변환하지 않습니다. 두 맵의 버퍼는 모두 보관되고 바이트 예산에 포함되며 context 손실 뒤 복원되고 mesh와 함께 해제됩니다. 기존 `expressionIndices` 필드는 `MeshRenderer.createMesh()`에서 계속 지원되며, vector asset은 이를 `metadata.expressions`와 대조해 검증하고 작성된 표정 이름만 자동으로 고릅니다.

`MeshBuilder.combine()`은 의미상 `expressionIndices`를 다시 매핑해 보존하며, 맞는 표정 키가 없는 원본은 기본 삼각형을 기여합니다. 비어 있지 않은 `indexVariants`는 거부합니다. 여러 에셋의 painter 순서 범위를 평탄화하려면 호스트 수준의 paint 일정이 필요하고, 끼어든 draw의 순서가 바뀔 수 있기 때문입니다. 그런 에셋은 범위를 조용히 버리거나 다시 묶지 말고 별도의 순서 있는 draw로 제출합니다.

Clip 없는 일반 `drawQuads`는 변환된 corner와 UV를 임시 point/배열 없이 정점 버퍼에 바로 기록합니다. clip이 있으면 원래의 삼각형 clip을 적용하고, posed sprite는 GPU pose를 사용합니다. 세 경로의 색·UV·깊이·삼각형 순서는 같으며, 작은 batch capacity에서도 삼각형 경계를 유지합니다.

## 불투명 합성 coverage 증명

`hasOpaqueCoverage(geometry,{indexVariant = null})`는 GPU 업로드 전의 작성된 11-float `Float32Array` mesh geometry를 받습니다. alpha가 0이 아닌 모든 삼각형이 **같은 부품**의 alpha 1 삼각형으로 덮여 있음을 증명합니다. 서로 다른 부품은 독립적으로 움직이거나 사라질 수 있습니다. 실제 이름 붙은 표정/인덱스 변형을 넘기며, 생략하면 기본 인덱스를 고릅니다. alpha가 0인 삼각형과 퇴화한 삼각형은 가리지 않습니다.

에셋 준비 중 한 번 실행하고 변하지 않는 geometry/변형 결과를 캐시하세요. 작성된 Float32 좌표로 한계가 있는 정확한 유리수 다각형 뺄셈을 수행하므로, 작은 실제 구멍이 픽셀/면적 허용치로 지워지지 않습니다. morph, 셰이더 재질, non-scaling stroke, 극단적인 좌표 지수 범위, 소진된 작업 예산은 `false`(coverage 증명 못 함)를 반환합니다. false는 투명하다는 증명이 아닙니다. 호출자는 root/부품 opacity를 완전 불투명으로 따로 유지하고, 실제 반투명 actor의 painter 순서를 보존해야 합니다. 이 조회는 geometry, 텍스처, 포즈, 게임 순서, 권위 상태를 바꾸지 않습니다.

이로써, 불투명 합성임이 증명된 몸체를 mesh별로 깊이 기록과 함께 묶어 그린 뒤 얼굴과 다른 overlay를 원래의 painter 순서로 깊이 검사만 하고 기록은 하지 않고 그리는 흔한 패턴이 가능해집니다. 독립된 반투명 몸체 영역은 순서 있는 제출이 필요합니다. 깊이를 기록하는 mesh 셰이더가 alpha 0 fragment를 버리므로 숨겨진 포즈 부품은 안전하며, 깊이 기록이 없는 일반 색 blend는 그대로입니다.

## 순서 있는 제출과 배치

`MeshRenderer.drawMesh()`는 대기 중인 배치에 순서 있는 인스턴스를 추가합니다. 액터마다 부르지 말고 실제 painter 순서 경계에서, 또는 프레임을 끝내기 전에 `flush()`를 부르세요. 인접한 제출은 mesh, 투영, clip, (다중 부품 mesh는) 묶인 부품 포즈가 같은 동안에만 배치됩니다. root 변환과 인스턴스 색은 배치 안에서 달라도 됩니다. 부품 포즈는 현재 공유 uniform이므로 다른 mesh나 부품 포즈는 배치를 닫습니다. 같은 mesh와 포즈를 쓰는 반복 outline 오프셋은 연속으로 제출해 한 번에 flush할 수 있습니다. `orderedMeshQuads`가 없으면 벡터 paint와 mesh draw가 번갈아 나오는 지점은 계속 painter 순서 경계입니다. opt-in 순서 있는 경로는 층 순서를 바꾸지 않고 호환되는 paint를 캡처할 수 있으며, 지원하지 않는 기능은 여전히 그 run을 끊습니다.

## 셰이더 yarn·sketch 표면

Yarn과 sketch는 별도 렌더러가 아니라 **`MeshRenderer` mesh의 재질**입니다. `backend:"shader"` 스타일의 SVG path는 보관된 fill과 닫힌 윤곽을 따르는 고정 strip으로 이루어진 일반 mesh 삼각형으로 컴파일되며, 모든 정점이 float 4개짜리 재질 레코드(yarn 또는 sketch 표면의 fill/edge 종류, 속한 표면, 윤곽을 따른 거리와 가로지른 거리)를 가집니다. 표면별 상수(bound와 효과 벡터 4개)는 mesh의 작은 표 하나에 들어 있습니다. 프래그먼트 셰이더가 그 데이터로 yarn 바느질, 가장자리 고리, 섬유, sketch 해칭, 애니메이션되는 sketch 잔상을 평가합니다. `stitchWidth`, `stitchHeight`, `fiberSpacing`, `fiberMax`를 바꿔도 정점이 늘지 않고, 아트워크 텍스처도 만들지 않습니다(모든 yarn mesh는 에셋과 무관하게 같은 256x256 바느질 거리장 하나를 공유하며, 렌더러가 `dispose()`에서 해제합니다).

표면은 mesh의 삼각형일 뿐이므로 호스트에게 특별히 요구하는 것이 없습니다. yarn 몸체를 가진 액터는 주변 액터와 **인스턴스 draw 하나**로 그려지고(yarn 액터 백 개도 이백 번이 아니라 한 draw입니다), GPU 부품 포즈를 따르며, 다른 모든 부품과 같은 clip 평면, stencil clip, 깊이, 3D 월드 변환을 씁니다. 재질이 있는 mesh만 더 큰 프래그먼트 셰이더를 컴파일하며 나머지 mesh는 한 줄짜리 셰이더를 유지합니다. 재질이 있는 mesh는 인스턴스 float 하나, 곧 그 인스턴스의 표시 시간을 더하므로 배치를 쪼개지 않고도 sketch 잔상이 액터마다 애니메이션됩니다.

```js
import { WebGLDevice, VectorContext } from './rendering.js';
import { createVectorActor } from './vector-assets.js';

const context = new VectorContext(device);
const actor = createVectorActor(context, compiledYarnSvg, { clip: 'idle' }); // yarn and sketch need no extra setup
context.drawVectorActor(actor, { matrix, clips, alpha, color }); // stencilRef comes from the context
```

컴파일된 SVG 밖에서 표면을 다루는 저수준 호출자는 `buildYarnSurfaceMesh({ fillVertices, outline, edgeColors, style })`로 같은 mesh를 만들어 `MeshRenderer.createMesh()`에 넘깁니다. `fillVertices`는 정점당 float 6개(`x, y, r, g, b, a`)의 완전한 삼각형 목록이고, `outline`은 평탄한 `x, y` 쌍으로 된 닫힌 윤곽 하나이며, `style`은 SVG 스타일 객체이고, `edgeColors`는 윤곽 점마다 선택적으로 주는 RGBA입니다(기본값은 fill 색의 평균). 잘못되었거나 불완전한 스타일은 예외를 던지며, 분할된 효과 삼각형으로 대체하지 않습니다. `buildYarnSurfaceGeometry()`는 정확한 단언을 위해 한계가 있는 geometry 자체를 반환합니다.

Yarn 메타데이터는 vector-assets 스키마가 쓰는 SVG `kind`, `seed`, stitch, edge, fiber 필드를 받습니다. Sketch 메타데이터는 SVG `kind`, `seed`, `periodMs`, echo, hatch 필드를 받습니다. echo는 `(echoX, echoY)`만큼 평행 이동한 윤곽이어서 sketch가 한쪽으로만 그림자를 드리울 수 있으며, strip이 평행 이동한 윤곽을 따르므로 정점도 uniform도 늘지 않습니다. Yarn 셀과 가장자리 섬유는 작성된 seed로 결정됩니다. Sketch 시간은 액터의 절대 표시 시간(직접 호출자는 `drawMesh({ timeMs })`)이고 렌더러는 시계를 소유하지 않습니다. painter 순서는 삼각형 순서이므로, 각 표면이 눈·outline·다른 SVG path 사이 어디에 나타날지는 여전히 호스트가 정하며 이 API는 정렬하지 않습니다.

좌표, 바느질 크기, 섬유 크기는 원본 벡터 단위이고 회전과 비균등 scale을 포함한 mesh의 부품 변환을 따릅니다. CSS 크기는 픽셀 샘플링에, DPR은 backing 해상도에 영향을 주지만 작성된 로컬 공간의 재질 scale은 바꾸지 않습니다. 재질이 있는 mesh는 `depthWriteAlphaThreshold`를 쓸 수 없습니다. `depthWrite: true`이면 렌더러는 mesh를 fill과 edge 삼각형 run으로 원래 순서대로 그리고 edge run에서는 깊이 기록을 끕니다. 일부만 덮인 edge 픽셀이 그 뒤에 있는 것을 가리면 안 되기 때문입니다.

집중 검증은 `npm run test:rendering:yarn-shader`이며, 밀도에 따라 달라지지 않는 geometry와 47, 74 CSS px에서의 실제 Chromium/WebGL 픽셀, clip, stencil, context 복원을 검사합니다. 정확성 검사이며 FPS나 CPU 벤치마크가 아닙니다.

## CPU geometry 진단 카운터 (0.11.5)

WebGLDevice.stats는 beginFrame()에서 초기화되는 프레임 단위 숫자 카운터를 노출합니다. vectorFlushCalls(명시적 VectorRenderer.flush 호출), vectorSubmissions(비어 있지 않은 벡터 버퍼 제출), pathTessellations(실제 fill/radial-fill 삼각분할기 호출), pathStrokeBuilds(stroke geometry 생성), meshCreates(성공한 보관 mesh 생성)입니다. 기존 drawCalls, bufferUploads, bufferBytes는 실제 장치 제출을 셉니다. 이 값들은 GPU 완료를 측정하지 않습니다. MeshRenderer에는 프레임마다 geometry를 다시 만드는 API가 없으며, geometryUploads는 인스턴스 버퍼 업로드가 아니라 보관 생성/복원을 측정합니다. 선택한 숫자를 같은 프레임의 CPU 단계 관찰과 함께 보관하려면 debug-tools의 FrameMetrics를 사용하며, 프로파일러는 자동으로 설치되지 않습니다.

## 벡터 스트림의 analytic primitive

VectorContext는 조건에 맞는 단순 도형을 analytic primitive 정점(스트림의 mode 5)으로 내보냅니다. 완전한 원과 타원, 사각형 fill과 조건에 맞는 stroke, 한 구간짜리 stroke입니다. 프래그먼트 셰이더가 도형의 거리 함수를 평가하므로 윤곽 점을 삼각분할하지 않습니다. 각 primitive는 변환, paint 색과 alpha, stroke 폭, cap 또는 join을 캡처하며 주변의 fill, 그라디언트, 글리프, 스프라이트와 같은 draw에 합류합니다.

초기화 뒤 빠른 경로는 전체 타원 path 점을 샘플링하지 않으며, fallback이나 이후 path 명령이 원래 윤곽을 필요로 할 때만 path geometry를 만듭니다. 프레임당 정점 바이트는 context의 `uploadedBytes`에 나타납니다.

빠른 경로는 Canvas path 변환, 유효 alpha, 볼록 clip, stencil clip, 제출 순서를 보존합니다. 부분 호, 복합 path, 구멍, 둥근 사각형, 점선 stroke는 여전히 같은 스트림 안에서 path 삼각분할기를 씁니다. VectorContext는 스트림을 context와 함께 복원하고 해제합니다. 통합 `npm run test:browser` 시나리오는 실제 Chromium/WebGL 픽셀, 단일 draw call, warm 프레임 삼각분할 카운터를 검사합니다. 이 정확성 검사는 GPU 완료나 모바일 성능을 측정하지 않습니다.

## 작성된 애니메이션 포즈 데이터 (v0.17)

WebGL 2가 기본이며 ANGLE 확장 유무와 관계없이 core instancing을 사용합니다. 기존 GLSL ES 100 shader 입력은 ES 300으로 정규화하고 native ES 300도 허용합니다. shader·VAO·buffer·texture는 context 복구와 dispose의 동일 소유권을 따릅니다.

Source 해제는 새 texture를 할당하지 않습니다. 남은 프로그램의 offset은 유지하고 여유 공간은 다음 source 등록 때 압축하며, 마지막 source 해제 시 전체 프로그램 texture를 반환합니다. 압축·atlas 증설은 새 데이터 할당에 성공한 뒤 교체합니다. 업로드 실패 시 row의 dirty 상태를 유지하고 context 복구 때 필요한 state/base/CPU pose 데이터를 다시 올립니다.

- createDataTexture(width,height,{data=null})와 updateDataTexture(handle,Float32Array,{x,y,width,height}): nearest RGBA32F 숫자 데이터입니다. CPU 원본을 보존해 context restore 후 다시 만듭니다. 그림 asset API가 아닙니다. DOM 이미지·바이트 atlas 업로드와 번갈아 호출해도 숫자 채널을 premultiply하거나 뒤집지 않습니다. 각 숫자 갱신은 pixel-unpack 상태를 명시적으로 초기화합니다. 반복 갱신이라 `gl.getError()` 동기 확인은 `checkGLErrors`일 때만 합니다.
- createRenderTarget(width,height,{format:'rgba32f',filter:'nearest'}): float 렌더 타깃입니다. floatRenderTargetsSupported와 isRenderTargetAvailable(handle)로 지원·복구 가능 여부를 확인합니다. EXT_color_buffer_float가 필요하며, 해당 target의 복구 실패가 일반 WebGL 2 렌더링을 중단시키지는 않습니다. 기본 애니메이션 경로는 이 타깃을 쓰지 않으며, `orderedMeshQuads`를 켠 경우 지원되는 float target에 부위별 GPU 행렬을 캐시합니다.
- new MeshRenderer(device,{poseBackend:'auto'|'cpu'|'uniform'}): auto는 정점 셰이더 평가를 시도하고 명시적 CPU pose fallback을 유지합니다. cpu는 같은 instancing에 CPU pose를 올리는 진단 경로(raster/sprite atlas는 GPU 키프레임 포즈 전용이라 cpu 포즈 액터를 그리면 TypeError), uniform은 기존 CPU pose uniform 참조 경로입니다.
- actor.preparePose({excludeParts})로 표시 상태를 준비하고 meshes.preparePoses()로 모아 평가합니다. 보이지 않는 pose 준비만 source별로 묶으며 visible mesh/alpha/paint를 재정렬하지 않습니다. 준비하지 않은 actor.draw도 동작하지만 뒤늦은 개별 준비는 같은 행을 이미 쓴 배치를 먼저 제출하게 만들 수 있습니다.
- context.drawVectorActor(actor,options)는 앞선 analytic primitive와 vector paint를 먼저 제출하고 actor.draw를 호출합니다. drawMesh와 같이 context 상태를 따릅니다: `matrix`는 현재 context 변환(카메라)과 합성되고(월드 모드 `viewProjection`/`worldMatrix`에서는 합성하지 않음), `alpha`는 context `globalAlpha`와 곱해지며, `forceColor`/`whiteFlash`는 지정하지 않으면 context의 `forceColor`와 `filter`를 따릅니다. `depthWriteAlphaThreshold`를 주면 actor가 GPU 포즈 대신 CPU 포즈로 그립니다(재질이 있는 에셋은 지원하지 않아 오류). 같은 mesh run 자체를 actor마다 강제로 flush하지 않습니다. 몸체→얼굴 overlay→다음 actor 순서는 그대로입니다. 직접 actor.draw를 호출하는 소비자는 이전 renderer의 순서 경계를 책임집니다.
- meshes.poseStats(): GPU/CPU/uniform draw instance 수, CPU fallback 비율/이유, state/base/CPU pose upload byte, atlas/프로그램 할당 byte를 보고합니다. prepare 호출 횟수와 실제 draw 사용량은 다릅니다.

서로 다른 행을 가진 같은 mesh의 연속 제출은 u_parts 변경으로 분리되지 않습니다.

기본 GPU pose는 별도 계산 패스가 없습니다. 이전 GTX 1660 Ti의 200개 측정에서는 별도 계산 패스의 이득이 없었으므로 이 기본값을 유지합니다. `orderedMeshQuads`를 명시적으로 켠 경우에는 대규모 병력에서 정점마다 반복되는 계산을 줄이기 위해 지원되는 RGBA32F target을 사용합니다. 바뀐 GPU 행마다 유효 부위를 한 번 준비하고 세 texel(row0·row1·morph/opacity/depth)을 저장하며, 실제 몸통 삼각형은 그 행렬을 샘플합니다. target 미지원·복구 불가 시 기본 GPU program 경로를 사용하며 CPU fallback 비율로 집계하지 않습니다. 이 선택의 실제 기기 성능은 별도 측정 범위입니다.

기본 경로의 키프레임(program)은 데이터 텍스처에 한 번 올리고, 인스턴스마다 상태 한 행(클립 헤더, 클립 시간, 반복 방식, 길이, morph, 숨김 파트 비트마스크, program 오프셋)과 파트 오버라이드 행만 갱신합니다. 정점 셰이더가 그 세 텍스처(program, state, overrides)를 읽어 부모 계층 행렬·이징·투명도를 같은 draw 안에서 계산하므로 pose 계산 때문에 draw가 늘지 않습니다. 정점마다 같은 파트 계산을 반복하는 비용은 NVIDIA(GTX 1660 Ti)에서 병목이 아닙니다: 같은 메시를 묶어 그린 200개는 이전 코드로도 1.7ms로 CPU pose uniform 경로(4.5ms)보다 빨랐습니다. 실제 비용은 draw가 쪼개질 때 flush마다 드는 일이었습니다. 두 경로 모두 `flushUpdates`는 바뀐 행(state/override/CPU 집합)만 방문하고 `updateDataTexture`는 `checkGLErrors`일 때만 `gl.getError()`를 부릅니다. 표정 index buffer·shader surface·paint·clip·stencil·depth state 경계는 유지합니다. 깊이 쓰기 alpha 분류처럼 CPU 삼각형 분석이 필요한 일반 draw API는 기존 parts 경로를 사용합니다. GPU pose atlas handle과 alpha depth 분류 옵션을 함께 넘기는 것은 지원하지 않습니다. 기존 vector asset draw API에는 해당 alpha 분류 옵션이 없습니다.

`mesh.poses.matrixCache`는 GPU 계산 pass·row·part 수, target byte, 남은 dirty row와 가용 여부를 보고합니다. `node modules/vector-assets/tests/run-gpu-poses.browser.mjs --compare-cache`는 동일 GPU program 경로를 참조로 삼아 새 캐시·중첩 전환·row 재사용·복구·정리의 실제 픽셀을 비교합니다.

숫자 프로그램은 원본 SVG 채널을 공유합니다. translation/rotation/nonuniform scale/opacity, pivot·부모 계층, 표정/가시성·부위 제외·base pose·morph를 유지합니다. 미지원 easing/매우 긴 채널과 진행 중 중첩 전환은 CPU pose atlas, SVG shader surface/drawOrder는 기존 CPU 제출 경로를 사용합니다. 완료된 전환은 시계를 초기화하지 않고 GPU 경로로 복귀합니다. GPU readback은 제품 루프에서 사용하지 않습니다.
