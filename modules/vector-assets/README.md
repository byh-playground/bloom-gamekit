# vector-assets

## 언제 쓰나

- 손으로 그린 **SVG 원본을 그대로 캐릭터·애니메이션**으로 그리고 싶을 때. 부품 포즈·클립·표정을 SVG에 적고, 런타임은 컴파일된 geometry를 `createVectorActor`로 재생합니다.
- SVG 클립을 아틀라스 스프라이트로 구워 많은 수를 싸게 그리고 싶을 때(`createVectorSpriteAtlas`).

## 쓰는 모양

```js
// yarn-mayhem/src/main.js (줄임)
const actor = createVectorActor(context, ACTIVE_THEME_ASSETS.yarnBody); // 로더가 컴파일한 자산
// 프레임마다
actor.setExpression(expression);
actor.play(clip, startedAtMs).seek(timeMs);
context.drawVectorActor(actor, { matrix, alpha, color });
```

자산 로딩은 [vector-assets-loader](../vector-assets-loader/README.md)가 합니다. 스프라이트 굽기 예: `budmori-io`의 `createVectorSpriteAtlas`.

## 쓰지 말아야 할 때

| 이런 일                               | 대신                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| 컴파일한 메시를 배포물에 넣기         | 하지 않습니다. 원본 SVG만 두고 시작 시 컴파일합니다         |
| 표정 부품을 몸마다 그리기             | [face](../face/README.md)                                   |
| SVG가 아닌 스프라이트 시트 애니메이션 | [rendering](../rendering/README.md) `createSpriteAnimation` |

## 런타임 부품 atlas 비교

같은 예제에는 표본 추출 스프라이트 재생도 들어 있습니다. `createVectorSpriteAtlas(context, compiledAsset, { clip, expression, sampleIntervalMs, pixelsPerUnit, padding, supersample, paintRegions })`는 작성된 SVG clip을 각 구간의 중간 시점에서 표본 추출해, 완전한 포즈를 장치 공유 texture atlas(`device.textureAtlas`)의 한 영역에 굽습니다. `context`는 `asset`을 소유한 mesh renderer를 가진 `VectorContext`입니다. atlas 크기가 시트의 한도이며, 들어가지 않는 프레임 집합은 `atlasLimit`을 보고합니다. 같은 자산의 동등한 굽기 설정은 참조 횟수를 세는 하나의 영역을 공유합니다. once clip은 마지막 구간에서 작성된 끝점을 그대로 써서, 유지되는 마지막 이미지가 종료 포즈를 보존합니다. 마지막 구간은 더 짧은 길이를 유지하므로 재생은 작성된 clip 길이를 지킵니다. 결과는 SVG에 의존하는 actor가 아니라 일반 스프라이트 정의와 영역입니다:

```js
const BAKER = createVectorSpriteAtlas(CONTEXT, COMPILED, {
    clip: 'bounce',
    expression: 'neutral',
    sampleIntervalMs: 100,
    pixelsPerUnit: 1,
    padding: 2,
});
BAKER.bake(); // in an active device frame, before constructing SPRITES
const SPRITES = createSpriteAnimation(CONTEXT, BAKER.region, BAKER.definition);
const ACTOR = SPRITES.createActor({ clip: 'bounce', startedAtMs: 0 });
ACTOR.draw({ timeMs: displayTimeMs, matrix: MATRIX });
// Reuse during playback; do not bake in the animation render loop.
SPRITES.dispose();
BAKER.dispose(); // releases the region with its last user
```

스프라이트 좌표는 픽셀입니다. `pixelsPerUnit`이 1이 아니면 벡터 로컬 행렬의 scale을 그 값으로 나눕니다. 굽는 쪽은 표본 추출한 변환·morph 경계의 고정된 합집합을 유지하고 원래 SVG 원점을 스프라이트 pivot에 인코딩하므로, 프레임마다 여백이 달라져 떨리는 현상이 없습니다. SVG 표정과 불투명도는 각 프레임에 합성됩니다. 비공개 원본 플레이어는 계획·굽기 중에만 표본을 추출하고 호출자의 플레이어는 건드리지 않습니다. 원본 자산·clip·외관·구간·해상도가 모두 같은 요청은 참조 횟수를 세는 atlas를 공유하며, 입력이 바뀌거나 context가 복구되면 다시 구워야 합니다. 스프라이트 자원은 그것을 굽는 쪽을 해제하기 전에 먼저 dispose합니다. 지원하지 않는 shader surface, 자동 sketch 시간 morph, non-scaling stroke, 할당 한도는 사용할 수 있는 스프라이트 texture 없이 명시적인 vector 사유를 반환합니다.

이것은 표본 추출 근사입니다. 애니메이션 시간이 완전한 이미지 하나를 골라 유지합니다. 예제는 구간과 그 시간 오차 한계를 보여 주며, 연속적인 포즈 보간을 주장하지 않습니다. 구운 프레임을 키우면 픽셀이 흐려집니다. 작성된 부품별 morph 채널은 표본 시점에서 구울 수 있습니다. 자동 sketch morph는 절대 표시 시간에 의존하므로 clip atlas 하나를 거꾸로 재생하거나 반복해서는 표현할 수 없으며, 이 경우 명시적으로 timeDependentMorph vector fallback을 반환합니다. 임의의 라이브 override, socket, 전환은 일반 스프라이트 플레이어가 평가하지 않습니다. 그런 동적 계약에는 vector 경로를 쓰십시오. 처음 계획·굽기의 CPU 경과 시간과 texture 용량은 정상 재생 측정과 따로 봅니다.

**대화형 HTML:** [vector-raster-comparison](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-raster-comparison.html)

기본적으로 이 예제는 **Vector / Full sprite**만 비교합니다. **Advanced options → Part textures**를 켜면 세 번째 경로가 명시적으로 활성화되며, 라이브 패널, 카드, 비용 열, 순차·누적 표본이 함께 나옵니다. 꺼진 part texture는 굽지도 보관하지도 않고, 끄면 자원을 dispose합니다. 이 옵션을 바꾸는 것은 명시적인 준비·설정 변경이므로 유한한 준비 manifest를 다시 만들고, 설정이 그대로면 재생 중 이미지 업로드·재굽기 0 계약을 유지합니다. 활성화된 경로는 측정 조건 키의 일부이므로 두 경로와 세 경로의 기록이 섞이지 않고, 끝난 이전 결과에는 라벨이 남습니다. 모듈 API는 그대로 사용할 수 있습니다.

누적 측정 컨트롤은 멈출 때까지 균형 잡힌 전체 뷰포트 라운드를 반복합니다. 각 경로는 같은 표시 시간에서 워밍업 30프레임과 측정 60프레임을 받으며, 끝난 라운드마다 정방향·역방향 순서를 번갈아 씁니다. 정지하면 끝나지 않은 라운드는 취소되고, 설정이 같은 채로 재개하면 라벨이 붙은 해당 조건에 이어서 쌓입니다. 정지한 뒤 설정을 바꿀 수 있고 이전 조건은 계속 보입니다. 크기 변경, 페이지 숨김, context 손실, 조건 변경은 끝나지 않은 라운드를 취소합니다. 정확한 표본은 경로당, 그리고 가장 최근에 측정한 다섯 조건에 대해 6,000개로 제한됩니다. 초기화하면 지워지고 페이지를 닫거나 새로고침하면 기록을 잃습니다. 백분위수는 라운드별 백분위수의 평균이 아니라 정렬된 표본의 선형 보간으로 계산합니다. 이 반복 부하는 비교 도구이며, 게임 전체 성능이나 교차점 연구가 아닙니다.

누적 표는 CPU 합계(애니메이션 갱신 + 마지막 flush를 포함한 렌더 준비·제출), CPU 제출(그 부분 집합), 유효한 비동기 GPU 렌더 시간(pose pass 포함), 실제 RAF 간격(브라우저 대기와 무관한 작업 포함)을 구분합니다. CPU와 GPU는 겹치므로 더하면 안 됩니다. 각 지표는 개수, 평균, p50/p95/p99/최댓값, 그리고 16.7ms 기준 예산을 엄격히 초과한 횟수를 보고하며, RAF FPS는 GPU 시간의 역수가 아니라 평균 RAF 간격에서 계산합니다. 표본 기간은 측정된 RAF 간격의 합이며 설정, 워밍업, 중단, 쿼리 비우기는 제외합니다. GPU 포함 범위는 명시되며, 없거나 지원되지 않거나 대기 중인 결과는 0이 아니라 빠진 것으로 두고, 끊긴 라운드의 GPU 표본은 보수적으로 버립니다. 초기 준비와 논리 atlas 할당은 따로 표시합니다. 끝난 라운드는 이미지 업로드·재굽기가 없음을 검증하고, 숫자 pose와 instance 업로드는 별개입니다. 통계와 HUD는 표본마다가 아니라 라운드나 단계 사이에 갱신됩니다. 분할 라이브 타이밍은 공유되므로 개별 경로의 순위를 매길 수 없습니다.

분할 뷰의 라이브 호출은 개별 렌더 경로에 귀속시킬 수 없습니다. 뒤 경로가 앞서 보관된 batch를 flush할 수 있고, 마지막 flush는 그 호출 밖에서 일어나기 때문입니다. 그래서 분할 HUD는 공유 RAF FPS를 보여 주고 경로별 CPU/GPU 비교는 순차 벤치마크로 안내합니다. 전체 뷰포트의 단일 경로는 마지막 flush를 포함한 라이브 제출을 보여 줄 수 있습니다. 이 표시 보정은 그리기 순서, batch, 품질을 바꾸지 않으며, vector의 CPU 제출 시간이 실제로 더 낮다면 순차 결과에 그대로 드러납니다.

비교 화면은 mesh 곡선 정밀도도 보여 줍니다. 낮음(2), 표준(4), 높음(16) `curveSegments`이며 `strokeArcDivisions`는 2로 고정입니다. 이들은 컴파일러 옵션이고 64–512px 이미지 texture 해상도와는 별개입니다. 다른 정밀도를 고르면 기존 브라우저 로더로 같은 SVG를 불러와 컴파일한 뒤 그 geometry의 atlas를 준비합니다. 설정이 같고 정상 애니메이션 프레임이면 컴파일된 geometry와 준비된 이미지를 재사용합니다. 표준 geometry는 빌드 시점에 이미 미리보기에 컴파일되어 있으며, 런타임 컴파일 시간을 알 수 없으면 0이 아니라 알 수 없다고 표시합니다. 간략한 트레이드오프 비교는 실제 원본 정점·인덱스 수, 렌더러 CPU geometry 보관량, 논리 RGBA 이미지 저장량, 공유 숫자 pose texture 할당량을 구분합니다. 이것은 선택한 조건을 직접 살피고 측정하는 수단이지, 공표된 교차 임계값이나 한 표현이 항상 이긴다는 주장이 아닙니다.

예제에는 별도의 **Single** 품질·줌 탭과 **Crowd** 비교 탭이 있습니다. Crowd의 개체 수, 캐릭터 크기(CSS 픽셀, viewBox의 가장 긴 변), 배치 범위, seed는 서로 독립입니다. actor를 추가해도 기존 seed 위치는 유지되며 캐릭터가 작아지지 않습니다. 배치 영역을 줄이면 painter 순서를 보존한 채 밀도와 겹침이 늘어납니다. 공유 라이브 RAF FPS는 동시에 보이는 모든 경로에 적용되며, 백엔드별 독립 FPS가 아닙니다. 순차 비교는 각 백엔드에 같은 전체 캔버스, 워밍업 30프레임, 측정 60프레임을 쓰고, 실제 RAF 주기를 CPU 렌더·제출 및 비동기 GPU p50/p95와 따로 보고합니다. GPU 시간을 화면 FPS로 뒤집어 환산하지 않습니다. 반복 비교는 지원되는 `transform-repeat` clip과 혼합 모션 해제를 요구하며, 다른 clip은 시각 확인용으로 계속 쓸 수 있습니다. 준비는 따로 이루어지고 준비된 재생은 이미지 데이터를 굽거나 업로드해서는 안 됩니다. 설정, 크기, DPR, context 복구가 바뀌면 표시된 벤치마크 결과는 무효가 됩니다. 이 예제 작업은 렌더링 파이프라인을 바꾸지 않으며, 보편적으로 성능이 앞서는 쪽이 있음을 뜻하지도 않습니다.

선택 사항인 `createVectorRasterAtlas(context, compiledAsset, { pixelsPerUnit, padding })`는 보관된 원본 mesh를 장치 공유 texture atlas의 한 영역에 굽습니다. 한 부품에 속하는 연속된 삼각형 구간 하나하나가 여백이 붙은 타일과 context의 vector 스트림에 있는 사각형 하나(`VectorContext.drawQuads`)가 되며, GPU pose는 같은 vertex shader에서 평가됩니다. 따라서 blend와 clip 상태가 같은 구운 자산·도형·글리프·스프라이트는 모두 draw call 하나입니다. 250 actor, 5종 벤치마크 장면은 draw call 1회로 그려집니다(`project/docs/draw-batching-benchmark.json`). 분리된 구간은 분리된 채로 남습니다. 벡터 렌더링과 같은 플레이어 시계, 계층, easing, 전환, 빌려 온 pose handle을 쓰며, 애니메이션 프레임을 굽거나 두 번째 애니메이션 시스템을 평가하지 않습니다. `morph`, `opacityChannel`, shader surface, `forceColor` fallback이 있는 자산은 계속 `MeshRenderer`로 그려지며 vector fallback으로 보고됩니다.

```js
const ACTOR = createVectorActor(CONTEXT, COMPILED, { clip: 'bounce' });
const ATLAS = createVectorRasterAtlas(CONTEXT, COMPILED, {
    pixelsPerUnit: 1,
    padding: 2,
});
CONTEXT.beginFrame({ width: 800, height: 600 });
ATLAS.bake(); // optional explicit first bake; requires an active device frame
ACTOR.seek(displayTimeMs);
ACTOR.preparePose();
CONTEXT.meshRenderer.preparePoses();
const RESULT = ATLAS.draw(ACTOR, { matrix: MATRIX });
CONTEXT.endFrame();
// RESULT.backend is raster or vector; RESULT.reason explains fallback.
ATLAS.dispose();
```

atlas는 컴파일된 SVG의 GPU 자원을 context와 공유하고 그 자원에 대한 자체 참조를 가지므로, 자원은 그것이 그리는 actor보다 오래 삽니다. atlas와 모든 actor를 context보다 먼저 dispose합니다. atlas가 소유하는 것은 자신의 atlas 영역과 굽기 대상뿐입니다. texture 픽셀은 기존 source-over 렌더 pass에서 premultiplied되고 선형 필터링으로 샘플링되며, 숫자 pose texture는 별도 sampler에서 nearest 필터링을 유지합니다. 처음 굽기의 CPU 제출 비용, atlas 할당, 정상 프레임 업로드, draw 수는 `atlas.stats`와 예제에서 따로 보고됩니다. `gpuTextureBytes`에는 이미 render-target texture 저장량이 들어 있으니 `gpuRenderTargetBytes`를 다시 더하지 마십시오.

부품 아틀라스의 첫 굽기와 context 복구 때는 가로·세로 2배 RGBA 작업 버퍼에 그린 뒤 2:1 선형 blit으로 각 2×2 표본을 평균합니다. 오프스크린 버퍼에는 캔버스 MSAA가 없으므로, 이 과정을 생략하면 낮은 곡선 분할의 삼각형 가장자리가 거칠어집니다. 작업 버퍼는 굽기가 끝나거나 실패하면 해제하고 재생 중에는 만들지 않습니다. 최종 아틀라스 해상도와 정상 재생 메모리는 그대로지만, 굽는 동안 `atlasBytes * 4`의 작업 텍스처와 추가 그리기 비용이 듭니다. 2배 크기가 장치 한도를 넘지 않도록 배치하며 담을 수 없으면 기존 `atlasLimit` 사유로 벡터 경로를 사용합니다. 품질 비교의 기존 픽셀 허용치는 유지합니다.

`scaleX`와 `scaleY`는 작성된 keyframe과 호출자의 기본 pose에서 0이 될 수 있습니다. 한 축이 0이면 보관된 일반 삼각형의 넓이가 0이 되어 그 부품과 후손은 fragment를 만들지 않으며, scale을 되돌리면 alpha 애니메이션이나 재할당 없이 같은 geometry가 다시 나타납니다. scale은 유한하게 유지되고 opacity는 `[0,1]` 범위로 제한됩니다. socket 변환은 접힌 pivot에서도 유한합니다. 이는 `scale(0)`이 따르는 [비가역 변환 규칙](https://www.w3.org/TR/css-transforms-1/#transform-rendering)과 같습니다.

애니메이션 프레임은 atlas를 재사용합니다. 해상도가 바뀌면 새 atlas가 필요합니다. context 복구 뒤에는 보관된 원본 geometry가 잃어버린 render-target 내용을 한 번 다시 굽습니다. 한도나 할당 실패는 vector fallback으로 보고됩니다. 고정 픽셀 해상도는 샘플링과 확대 흐림을 일으키며, clip 프레임 양자화는 없습니다. 기본 비교는 명시적인 `transform-repeat` fixture를 씁니다. 원래 Seed Scout geometry와 bounce 변환에, 연속적인 독립 위상 측정을 위한 별도의 repeat clip을 더한 것이며 원래 once clip은 바뀌지 않습니다. Idle에는 opacity 채널이 있어, 반투명 삼각형 합성을 조용히 바꾸지 않고 명시적인 part-atlas fallback을 보여 줍니다. 세 비교 라벨은 순수 vector(보관된 mesh + GPU pose), vector + part texture(part atlas + 같은 GPU pose), texture(표본 추출한 전체 프레임 스프라이트)입니다. 기본 표본 간격은 100ms이며 렌더 속도와 독립적으로 설정할 수 있습니다.

morph target, 시간 의존 shader surface, non-scaling stroke, paint 구간의 일부만 선택하는 표정, 지원되지 않는 alpha 합성은 vector 경로를 씁니다. Force-color와 depth-write alpha 분류도 vector 렌더링을 씁니다. texture atlas는 대안 표현일 뿐 더 빠른 렌더링을 약속하지 않으므로, 워밍업 뒤 두 경로를 비교하고 처음 굽기 비용을 포함하십시오. 예제는 분할/A-B 뷰, 일시정지·스크럽, clip, 표정, 독립 위상, 개체 수, 해상도, 줌을 지원합니다. 분할 뷰의 카운터에는 두 제출이 모두 들어가므로, 성능 비교에는 단일 경로 A-B 모드를 쓰십시오.

## 이름 붙은 fill 영역

작성된 단색 fill 도형은 `data-paint-region="cheeks"`를 선언할 수 있습니다. 이름은 rig 부품과 독립이며, 모든 표정에서 대응하는 도형에 반복해 쓸 수 있습니다. 이름은 최대 여덟 개까지 지원합니다. 영역은 명시적인 `path`, `rect`, `circle`, `ellipse`, `polygon`, `polyline` fill이어야 하며, 그룹 상속, gradient, 작성된 yarn/sketch 재질 대상은 거부됩니다. UV texture mesh는 구워진 texture 픽셀을 다시 칠하는 대신 이름 붙은 fill 영역을 명시적으로 거부합니다. 바뀌는 것은 fill RGB뿐입니다. stroke, vertex/fill alpha, geometry, socket, rig 변환, 표정 가시성은 작성된 그대로 유지됩니다.

```js
const paintRegions = { cheeks: [0.35, 0.6, 0.9] }; // three finite RGB channels in [0,1]
actor.draw({ projection, matrix, paintRegions });
actor.draw({ projection, matrix }); // original fill colours

// The UI uses the same source and named fills. The input SVG stays unchanged.
const portrait = applySvgPaintRegions(originalSvgRoot, paintRegions);
container.replaceChildren(portrait);
```

알 수 없는 영역 이름, alpha override, 잘못된 RGB 채널, 영역 id를 가로지르는 삼각형은 명시적으로 실패합니다. `applySvgPaintRegions`는 복제본을 반환하며, 숨겨진 표정에 있는 같은 이름의 fill도 함께 바꿉니다. 독립적인 UI 팔레트가 재사용 가능한 원본을 오염시킬 수 없습니다. 이 helper는 얼굴 geometry를 더하지 않고 그 밖의 모든 속성을 보존합니다. 소비자는 유한한 초상 변형을 캐시할 수 있으며, 이 helper는 렌더 루프에 두는 것이 아닙니다.

컴파일된 geometry는 원래의 11-float 레코드와 선택 사항인 `paintRegions: { names, indices }`를 유지하며, 고유 정점마다 `Uint16` 영역 id 하나를 가집니다(`0`은 원래 재질). fill 삼각형은 id를 받고 stroke는 0으로 남습니다. 렌더러는 태그가 붙은 mesh의 GPU 스트림에 float 하나를 생성·복원 때 한 번만 추가합니다. 그 mesh와 표정 인덱스 변형은 모든 플레이어 팔레트가 공유합니다. 팔레트가 바뀌면 RGB uniform을 바꾸기 전에 순서가 있는 제출을 flush하며, 어떤 팔레트도 geometry를 다시 컴파일하거나 업로드하지 않습니다. 태그가 없는 자산은 기존 GPU 레이아웃과 shader를 유지합니다. 컴파일된 영역 id는 정점당 CPU 2바이트가 필요합니다. 렌더러는 11-float 원본과 함께 12-float로 묶은 스트림 하나를 보관하므로, texture 없는 mesh에 비해 태그된 정점당 CPU 48바이트와 GPU 4바이트가 늘어납니다. context 복구는 그 묶은 스트림을 재사용합니다. 팔레트가 다르면 인접한 instance batch가 갈라질 수 있습니다. 명시적인 전역 tint, forceColor, whiteFlash는 기존의 더 뒤 단계 동작을 유지합니다.

`npm run test:vector-assets:paint-regions`는 Chromium WebGL에서 원래의 SVG/UI helper/기준 mesh 흐름을 실행합니다. 표정·모션·clipping·world pass 전반에서 RGB와 alpha를 비교하고, 독립 팔레트와 초기화를 확인하며, 프레임당 geometry 업로드가 0임을 관찰하고, context를 복구하고, 자원을 dispose합니다. SwiftShader 픽셀은 기능을 검증할 뿐 실제 기기의 성능을 검증하지 않습니다.

**공개 HTML 예제:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

SVG 파일이 유일한 작성된 시각 원본입니다. `assets/seed-scout.svg`는 경로, paint, stroke, SVG id, 부품 계층과 pivot, socket, 표정 변형, clip, keyframe, easing, loop 모드를 직접 쓴 JSON `metadata#vector-asset` 노드 하나에 담습니다. 따로 편집하는 시각 JSON이나 raster texture는 쓰지 않습니다. 아래의 선택 사항인 런타임 raster atlas는 같은 컴파일된 SVG geometry에서 픽셀을 얻습니다.

같은 페이지에는 SVG로 작성한 yarn과 sketch 샘플도 있습니다. 스티치 배치, 해칭 패턴, 윤곽 흔들림, 색 대비, 결정적 seed는 각 SVG metadata 노드에 있으며, 빌드는 raster texture가 아니라 보관된 vector 삼각형을 내놓습니다. yarn 껍질은 표면에 SVG로 작성된 linear-gradient stop을 쓰고, 생성되는 각 스티치·가장자리 고리·섬유 정점을 따라 같은 stop을 샘플링합니다. 원본 경로의 가장자리 계량에서 생성한 물결 모양 윤곽, yarn/빛 pass를 겹친 두 개의 Bézier 스티치 고리, 가장자리 고리, 물결 가장자리에서 바깥으로 뻗는 결정적 seed 섬유가 함께 쓰입니다. sketch 스타일에는 절대 표시 시간으로 표본 추출하는, topology가 고정된 morph target 두 개가 있습니다.

## 작성 규칙: 원본 파일은 기본 포즈를 그린다

일반 뷰어, `<img>`, 편집기가 여는 SVG는 런타임이 시작하는 포즈와 같은 포즈를 보여 주어야 합니다. `metadata.expressions[defaultExpression].hide`가 나열한 모든 부품은 SVG 노드에 `display="none"`을 달고, 그 밖의 노드는 달 수 없습니다. 기본 표정이 보이게 하거나 언급하지 않은 부품은 플레이어가 표정을 적용하는 방식에 맞게 계속 보입니다. 컴파일러는 어느 쪽 방향이든 어기는 자산을 부품 이름을 밝히며 거부하므로, 모든 표정을 겹쳐 놓거나 숨겨야 할 변형을 그린 파일은 배포될 수 없습니다.

`display="none"`은 스키마가 받아들이는 유일한 `display` 값입니다. 이것은 원본 파일에서만 기본 포즈를 표시하며, 컴파일러는 메모리 안의 입력에서 이를 제거하므로 모든 표정 변형은 여전히 같은 geometry로 컴파일되고 가시성은 런타임이 정합니다. 원본 SHA-256은 이 속성을 포함하므로 기존 자산에 추가하면 해시가 바뀝니다. 그래서 WebGL 장면 밖에서 종을 보여 주는 게임 UI(아이콘, 초상, 도감 페이지)는 metadata에서 포즈를 다시 유도하지 않고 원본 파일을 직접 참조할 수 있습니다. Idle clip의 시작 opacity는 이 규칙에 포함되지 않습니다.

## 빌드와 런타임

공개 예제는 작성된 그 SVG, 컴파일된 삼각형 topology, 실제 GameKit WebGL 2 mesh를 세 개의 나란한 뷰로 비교합니다. 원본 SVG를 직접 가져와 표시하기 전에 컴파일된 자산과 SHA-256을 대조하며, 예제는 표시 전용 부품 그룹과 포즈를 같은 경로와 metadata에서 유도합니다. 하나의 clip, 시간, 표정, 줌, 팬 컨트롤이 모든 뷰를 구동합니다. 패널을 끌면 팬이 되고, Center는 공유 카메라를 복원합니다. 좁은 세로 화면에서는 패널이 쌓이고, 가로 뷰포트에서는 세 개가 모두 보입니다.

뷰별 카운터는 범위를 명시합니다. 원본 패널은 내려받은 SVG 바이트와 도형 수를, topology 패널은 컴파일된 삼각형·edge 수와 Canvas 2D 그리기 CPU 시간을, GameKit 패널은 선택된 WebGL 2 instancing 경로, 장치 draw call, 보관된 mesh 바이트, 생성·프레임 업로드 바이트, GPU 버퍼 할당, 렌더러·자산 초기화 시간을 보고합니다. GPU 경과 시간은 CPU 시간에서 추정하지 않으며, 이 예제는 GPU 밀리초를 보고하지 않습니다.

`npm run vector-assets:compile`을 실행하면 기준 SVG를 검증하고 컴파일합니다. 일반 `npm run build`는 보관 렌더링을 위한 `dist/vector-assets.js`와, 브라우저 시작 시 컴파일을 위한 별도의 자체 완결 `dist/vector-assets-loader.js`를 내놓습니다. 로더 번들에는 고정된 Three.js `SVGLoader` 0.186.1, `@xmldom/xmldom` 0.9.12, 공유 컴파일러 코어가 들어 있고 작성된 SVG나 샘플 geometry는 들어 있지 않습니다. 브라우저와 Node 경로는 같은 코어를 쓰며, 원본 SHA-256, 자산 스키마 버전, 컴파일러 버전, 테셀레이션 옵션을 컴파일된 자산에 기록합니다. SVG 경로는 복합 fill과 stroke를 포함해 삼각형 geometry로 한 번 변환되어 GameKit의 11-float mesh 형식으로 담깁니다. 컴파일러는 비트 단위로 동일한 완전한 레코드만 삼각형 순서를 보존한 채 16비트 인덱스 버퍼로 중복 제거하며, 서로 다른 레코드가 65,536개를 넘는 자산은 거부합니다.

원본 SVG 리소스를 배포하는 게임은 생성된 geometry를 저장소에 올리지 말고 시작 시 한 번 컴파일하십시오. `createVectorAssetLoader()`는 Web Crypto SHA-256으로 원본 바이트를 가져와 컴파일하고, `createVectorActor()`에 넘길 수 있는 보관 geometry 기술자를 반환합니다. 같은 요청이 동시에 오면 하나의 fetch/compile promise를 공유하고, 끝난 결과는 한도가 있는 최근 최소 사용(LRU) 캐시(기본 64개)에 담기며, 컴파일이나 네트워크 오류는 로드를 reject합니다. `expectedSha256`을 주면 파싱이나 캐싱 전에 정확한 원본 바이트를 검증합니다. `maxBytes`로 특정 리소스에 대해 512 KiB 원본 상한을 낮출 수 있습니다. 디버그 전용 `sourcePaths`는 기본적으로 빠지며 `includeSourcePaths: true`로 요청할 수 있습니다.

```js
import { createVectorAssetLoader } from './vector-assets-loader.js';
import { createVectorActor } from './vector-assets.js';

const loader = createVectorAssetLoader({ maxEntries: 8 });
const [compiledScout] = await Promise.all([
    loader.load('/assets/scout.svg', {
        sourcePath: 'assets/scout.svg',
        expectedSha256: '...64 lowercase hex characters...',
        maxBytes: 256 * 1024,
    }),
]);
const actor = createVectorActor(context, compiledScout, { clip: 'idle', startedAtMs: 0 });
// In the render loop, seek and draw the already-compiled actor.
// On owner shutdown, dispose the actor, loader, context and device.
```

`loader.load(url, { sourcePath, expectedSha256, maxBytes, curveSegments, strokeArcDivisions, includeSourcePaths, normalizeCenteredViewBox })`는 promise를 반환합니다. 캐시 키에는 URL, 원본 경로, 기대 해시, 원본 상한, 곡선 품질, stroke 호 품질, 뷰포트 정규화 모드, 디버그 데이터 선택이 들어가므로 서로 다른 컴파일 계약은 캐시된 결과를 공유하지 않습니다. 공개 `VECTOR_ASSET_QUALITY_PRESETS` 상수는 `vector-assets.js`와 `vector-assets-loader.js` 양쪽에서 쓸 수 있습니다. 대부분의 자산에는 `standard`(곡선 분할 4 / stroke 호 분할 2)를, 작은 자산에는 `smallAsset`(2 / 2)을 쓰십시오. 두 preset과 옵션 객체는 모두 동결되어 있습니다. `normalizeCenteredViewBox: true`는 중심 기준 로컬 좌표로 작성되어 루트 뷰포트 크기가 예전 방식이거나 clip pose가 빈 `{}`인 원본을 위한 옵트인 컴파일러 모드입니다. 먼저 가져온 정확한 바이트를 검증하고 해시한 다음 메모리 안의 컴파일러 입력만 정규화합니다. 루트 width/height는 viewBox 크기에서 오고, 컴파일러용 viewBox는 0에서 시작하며, 비어 있어 아무 효과도 없는 pose 항목만 버려집니다. 반환되는 `viewBox`, 칠해진 geometry, pivot, socket, 비어 있지 않은 clip 변환은 원래 작성된 좌표 공간에 남습니다. 배포되는 SVG는 다시 쓰지 않습니다. `maxEntries: 0`을 주면 같은 키의 진행 중 중복 제거는 유지한 채 끝난 결과의 캐싱을 끕니다. 끝난 항목을 버리려면 `loader.clear()`를, 소유자 종료 시에는 `loader.dispose()`를 호출하십시오.

SVG fill 삼각분할(gradient fill과 yarn 바깥 fill 포함)과 stroke 경로 샘플링은 기본적으로 `VECTOR_ASSET_QUALITY_PRESETS.standard`, 즉 곡선 분할 4와 stroke 호 분할 2를 씁니다. 컴파일러 API는 `curveSegments`와 `strokeArcDivisions`를 1부터 64까지의 정수로 받으며, 생략하면 해당하는 standard preset 값을 쓰고 `null`, 소수, 범위 밖의 값은 거부합니다. 동결된 `smallAsset` preset은 2 / 2입니다. 이전 수준의 세부가 필요한 호출자는 계속 `{ curveSegments: 16, strokeArcDivisions: 12 }`를 명시적으로 넘길 수 있습니다. 위에서 설명한 옵트인 `normalizeCenteredViewBox: true` 모드는 Node와 브라우저 컴파일러 API 양쪽에 적용됩니다. CLI는 대응하는 `--curve-segments <integer>`와 `--stroke-arc-divisions <integer>` 십진수 옵션을 쓰며, 중복되거나 알 수 없는 플래그를 거부합니다. `ShapeGeometry`는 `curveSegments`를 쓰고, stroke 테셀레이션 전의 `SVGLoader` 경로 점 샘플링도 마찬가지입니다. 작성된 sketch morph 윤곽과 yarn 스티치 경로는 고정된 스타일 분할을 유지합니다. object-bounding-box gradient 좌표는 고정된 샘플링 품질로 계산되므로 geometry 세부를 바꿔도 gradient 끝점이 움직이지 않습니다. 컴파일된 자산은 선택된 컴파일러 옵션을 원본 해시와 함께 기록합니다. 예: `npm run vector-assets:compile -- modules/vector-assets/assets/seed-scout.svg --curve-segments 3 --stroke-arc-divisions 2 --output seed-scout.compiled.js`. 값을 낮추면 보관되는 삼각형 참조와 초기 geometry 바이트가 줄지만 일부 도형은 퇴화할 수 있으며, 선택한 테셀레이션에서 원본에 완전한 삼각형이 없으면 컴파일러가 이를 보고합니다. 의도한 표시 크기에서 실제 출력을 비교하십시오.

컴파일된 `geometry.expressionIndices` 목록은 원본 삼각형 순서를 보존하면서 서로 배타적인 표정 그룹의 geometry를 뺍니다. 모든 키는 작성된 `metadata.expressions` 항목의 이름이어야 하며, vector actor는 이 의미 있는 표정 목록만 자동으로 선택합니다. `setPartVisible()`을 호출하면 이후 `setExpression()`이 맞는 목록을 복원할 때까지 이 최적화가 꺼져 명시적인 가시성 동작이 보존됩니다.

`geometry.indexVariants`는 painter 순서 구간처럼 호스트가 고르는 이름 붙은 삼각형 범위를 위한 별도의 map입니다. 키는 안정적인 이름이고 값은 같은 정점 레코드에 대한 `Uint16Array` 삼각형 목록이며, 표정 가시성은 바꾸지 않습니다. 이름은 `expressionIndices`와 `indexVariants`를 통틀어 유일해야 합니다. 두 map은 `createVectorAsset()`를 거쳐 보관된 mesh로 전달되고, `drawMesh({ indexVariant })`가 이름 붙은 목록을 고르며 이름을 생략하면 기본 `geometry.indices`를 그립니다. 렌더러는 두 map의 인덱스 버퍼를 모두 보관하고, 예산에 반영하고, 복원하고, 해제합니다. 이렇게 분리하면 `paint_0` 같은 draw 범위 이름을 표정으로 취급하지 않고도 호스트가 작성된 표정 geometry와 painter 순서 범위를 제출할 수 있습니다.

프로덕션 엔트리는 일반 `createVectorActor(context, compiledAsset, options)` API와 공유 `VECTOR_ASSET_QUALITY_PRESETS` 상수를 내보내며, 기준 캐릭터의 컴파일된 geometry는 번들하지 않습니다. Seed Scout helper는 `examples/seed-scout.js`의 예제 전용이고 `dist/vector-assets.js`가 아니라 독립 HTML 미리보기에 번들됩니다.

브라우저 런타임은 기존 `MeshRenderer.createMesh` / `drawMesh` / 부품 pose API를 씁니다. `createVectorActor(context, compiledAsset, options)`는 clip, 표정, 부품 pose 상태가 독립적인 actor 하나를 만듭니다. 하나의 `VectorContext`에서 같은 컴파일된 객체를 쓰는 모든 actor는 그 context의 보관된 GPU mesh(yarn과 sketch 표면은 그 삼각형의 재질)와 pose 원천을 공유하며, 첫 actor가 만들고 마지막으로 dispose되는 actor(또는 `context.dispose()`)가 해제합니다. 컴파일된 객체가 곧 식별자이므로 로더가 반환한 객체를 그대로 두고 모든 actor에 다시 넘기십시오. context가 자신의 `MeshRenderer`를 소유하며 그 한도는 context 옵션 `mesh`에 넣습니다. 호출자가 소유하는 것은 `WebGLDevice`와 context뿐입니다.

`vector-effect="non-scaling-stroke"`는 보이는 단색 stroke와 `stroke-linecap="butt"`, `"square"`, `"round"`를 가진 단일 직선 SVG `<line>`에서 지원됩니다. 숫자 `stroke-width`는 CSS 픽셀로 해석합니다. SVG 경로, polyline, polygon, 길이 0인 선, 알 수 없는 `vector-effect` 값, vertex morph target이 있는 자산은 컴파일에 실패하며, 일반적으로 크기가 변하는 stroke로 fallback하지 않습니다. 단일 선에는 join이 없으므로 join과 miter 동작은 이 지원 형태에 적용되지 않습니다. 이 범위 덕분에 작성된 선의 중심선과 cap 삼각형이 같은 정적 11-float mesh에 남으며, vertex shader는 부품·객체·카메라 변환 뒤에 선 정점만 확장하고 그 mesh의 일반 fill은 그대로 둡니다. 프레임마다 geometry를 테셀레이션하거나 업로드하지 않습니다. 회전과 비균등 scale은 선의 방향에는 영향을 주지만 CSS 픽셀 너비에는 영향을 주지 않습니다.

기본 framebuffer에서는 렌더러가 `canvas.clientWidth`와 `clientHeight`에서 논리 뷰포트를 가져오므로 device-pixel ratio가 stroke 너비를 바꾸지 않습니다. render target에 그릴 때는 `MeshRenderer.drawMesh()`나 vector 플레이어의 `draw()` 호출에 `strokeViewport: [logicalCssWidth, logicalCssHeight]`를 넘기십시오. 호스트는 오프스크린 이미지가 나타내는 CSS 크기 뷰포트를 제공해야 하며, 활성 render target에서 이를 생략하면 예외가 발생합니다. 일반 alpha, painter 순서, depth, clipping, 보관 버퍼 복원, dispose 경로는 그대로 쓰이며, clipping은 확장된 화면 공간 가장자리를 projection을 거쳐 되돌린 뒤 평가합니다.

```svg
<line x1="20" y1="50" x2="80" y2="50" fill="none"
      stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"
      vector-effect="non-scaling-stroke" />
```

컴파일러·렌더 회귀 fixture는 `tests/non-scaling-stroke.svg`입니다. 브라우저 시험은 여러 CSS 뷰포트 크기, DPR, 카메라 줌, 애니메이션되는 부품 변환에서 실제 WebGL 픽셀을 측정합니다. SVG 2는 이 효과를 호스트/뷰포트 좌표에서 정의하며, Chromium의 SVG painter도 stroke를 그리기 전에 호스트 변환으로 되돌립니다([SVG 2](https://www.w3.org/TR/SVG2/painting.html#VectorEffectProperty), [Chromium `SVGShapePainter`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/svg_shape_painter.cc)).

애니메이션 데이터는 일반 객체 위에서 일시정지된 Anime.js v4.5.0 timeline이 평가합니다. `actor.seek(displayTimeMs)`는 호출자가 준 표시 타임스탬프에서 표본을 추출하며, 모듈의 애니메이션 루프, 이벤트 콜백, 게임 명령은 실행되지 않습니다. 스냅샷 위치 보간은 계속 호스트의 책임입니다. `transitionTo`는 전환이 활성인 동안 같은 타임스탬프에서 이전 clip 트리와 다음 clip 트리를 섞어 결정적인 시간 seek을 보존합니다. 시작 전에는 원본 트리만, 끝나거나 그 뒤에는 대상 clip만 표본 추출합니다. 끝난 전환 기록은 뒤로 seek해 이전 포즈를 재현할 수 있도록 유지되므로, 반복된 전환은 여전히 보관된 재생 트리 메모리를 늘립니다. 이는 피한 프레임별 표본 추출 작업과는 별개입니다. 일회성 연출 효과에는 기존 presentation-events/audio API를 쓰십시오.

```js
import { WebGLDevice, VectorContext } from './rendering.js';
import { createVectorActor } from './vector-assets.js';
import { compiledAsset } from './character.compiled.js'; // generated from the authored SVG and its metadata

const device = new WebGLDevice(canvas);
const context = new VectorContext(device);
const actor = createVectorActor(context, compiledAsset, { clip: 'idle', startedAtMs: 0 });

// Inside the host render frame:
context.beginFrame({ width: canvas.width, height: canvas.height });
actor.seek(displayTimeMs); // the absolute display time already chosen by the host
context.drawVectorActor(actor, { matrix }); // composes with the context transform (camera) and globalAlpha
context.endFrame();

// On owner shutdown:
actor.dispose();

// Keep a species resident while no actor of it exists, so the next actor does not upload its mesh again:
const hold = holdVectorAsset(context, compiled);
hold.release();
context.dispose();
device.dispose();
```

표정과 명시적인 부품 가시성은 actor에 설정합니다. 부품 pivot과 socket 좌표는 SVG metadata에서 읽습니다. 작성되는 숫자 clip 필드는 `x`, `y`, `rotation`(라디안), `scaleX`, `scaleY`, `opacity`이며, clip 모드는 `once`, `repeat`, `alternate`입니다. 각 자산은 부품을 최대 16개까지 지원합니다. geometry는 정적으로 유지되며, 작성된 clip은 topology morph 없이 부품을 변환하고 표정 변형을 선택합니다. SVG paint 지원에는 단색 fill/stroke와 제한된 linear-gradient 계약이 포함됩니다. 명시적인 stop, `pad` spread, object-bounding-box 또는 단위 없는 user-space 좌표, 내부 `fill="url(#id)"` 참조를 가진 루트 `<defs><linearGradient>` 요소가 직접 있어야 합니다. gradient stop은 보관된 삼각형으로 나뉘어 정점 RGBA로 컴파일되며, GPU는 texture를 샘플링하지 않습니다. 생성된 yarn stroke 삼각형도 같은 stop 경계에서 나뉘고, 각 스티치·가장자리 고리·섬유 정점이 metadata tint가 적용되기 전에 작성된 gradient를 샘플링합니다. `gradientTransform`, 상속된 gradient, radial gradient, CSS, text, `use`, 임의의 XML, 완전한 SVG 렌더링은 이 스키마 밖입니다. script, `foreignObject`, 외부 참조, 내장 raster, doctype, 알 수 없는 요소·속성, 지원되지 않는 style 값은 컴파일에 실패합니다. yarn 생성기는 곡선 stroke를 정적 삼각형으로 테셀레이션하며, 다른 렌더러의 raster 출력과 픽셀 단위로 같지 않고 매개변수로 구동됩니다.

`actor.draw({ projection, depth, depthTest, depthWrite, depthFunc })`는 명시적인 clip 공간 depth를 `MeshRenderer`에 전달합니다. depth는 `[-1,1]`이며 depth 시험과 쓰기는 기본적으로 꺼져 있으므로 일반 2D 자산은 painter 순서 동작을 유지합니다. 3D 배치에는 `viewProjection`(열 우선 4×4)과 아핀 `worldMatrix`(열 우선 4×4)를 모두 넘기며, actor의 2D `matrix`와 작성된 부품 변환이 그 world 변환에 합성됩니다. `projection`을 함께 넘기지 마십시오. 볼록 `clips`는 world XY 좌표에 머물며, 서로 다르게 변환된 actor와 shader surface가 바뀌지 않은 채 공유합니다. shader surface가 있는 자산은 painter 순서 draw를 제출하기 전에 공유 clip 목록을 `surfaceRenderer.maxClipPlanes`에 대해 런타임이 검증하며, 이 더 엄격한 렌더러 한도를 넘으면 자산을 일부만 그리지 않고 예외를 던집니다. depth 시험을 거치는 pass에는 depth attachment가 필요합니다. 투명 actor도 여전히 호스트의 painter 순서로 제출되며, 이 API는 정렬하거나 장면 정책을 바꾸지 않습니다. shader를 쓰는 SVG surface는 현재 surface당 단순 윤곽 하나만 지원하며, 구멍과 여러 윤곽은 보관된 shader-surface 스키마 밖입니다.

`actor.draw({ excludeParts })`는 호출자가 소유하고 재사용하는 알려진 부품 ID의 `Set`을 받아, 그 호출에서만 해당 부품을 보이지 않는 것으로 취급합니다. actor의 표정이나 명시적 가시성은 바꾸지 않으므로 같은 해석된 pose를 외곽선 pass와 본체 pass에 쓸 수 있습니다. 제외된 mesh 구간과 shader surface는 기존 painter 순서에서 건너뛰고, 남은 구간, alpha, clipping, batching 동작은 그대로 유지됩니다. `Set`이 아닌 값이나 알 수 없는 부품 ID는 draw 제출 전에 예외를 던집니다. Set은 복사하지 않고 직접 읽으므로 렌더 루프 밖에서 만들어 재사용하십시오.

SVG 저장 왕복 검사는 원본을 직렬화한 뒤 다시 파싱해, JSON metadata와 모든 DOM id가 유지되는지 확인합니다. 이 metadata를 지우거나 id를 바꾸는 편집기는 내보내기 설정이 필요하거나 다른 SVG 편집기를 써야 합니다.

## Painter 순서 geometry batch

`MeshBuilder.combine([assetA.geometry, assetB.geometry])`는 호환되는 컴파일된 geometry를 주어진 순서대로 이어 붙이고 부품 인덱스를 다시 매깁니다. 11-float mesh 데이터, 최대 두 개의 morph target, 전체 부품 최대 16개를 받습니다. 결과는 한 번 업로드되는 보관 mesh 하나입니다:

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

입력 목록이 painter 순서를 정하며 batch는 정렬하지 않습니다. 각 actor의 `partPoses()`는 로컬 변환, 작성된 두 target morph 가중치, 가시성, opacity를 노출합니다. actor를 합치기 전에 각 actor의 루트 행렬을 그 부품 변환 하나하나에 접어 넣고, pose 배열을 geometry 목록과 같은 순서로 이어 붙이십시오. 부품별 변환, morph 가중치, 가시성, opacity는 독립적으로 유지됩니다. draw 하나는 projection 하나와 공유 clip plane을 가지므로, projection이나 clip 영역이 다른 항목은 별도의 순서 있는 batch여야 합니다. 부품 `color`/white-flash 상태는 부품별이 아니므로, 색이 SVG geometry에 작성되어 있지 않다면 그런 항목은 별도 draw에 두십시오. 결합된 geometry는 프레임마다가 아니라 그룹 구성이나 순서가 바뀔 때 만드십시오. 기존 16부품 한도는 의도한 것이며, API는 더 큰 그룹을 부품을 조용히 버리는 대신 거부합니다.

브라우저 fixture는 공유 pose actor를, 독립 위상의 idle/bounce clip과 neutral/happy/surprised 표정과 구분해 보고합니다. 서로 다른 다부품 pose 100개와 400개, 서로 다른 pose당 draw 1회, 프레임당 geometry 업로드 0, 같은 시간 되감기 seek을 확인하고, 하드웨어에 특화된 시간 임계값을 강제하지 않은 채 CPU 제출과 GPU 타이머 사용 가능 여부를 기록합니다. 공유 pose의 draw 1회 사례는 독립적으로 애니메이션되는 actor의 대용으로 쓰지 않습니다.

## Pose 준비와 CPU 조회 (v0.17)

`createVectorSpriteAtlas(context, compiled, { clip, expression, sampleIntervalMs, pixelsPerUnit, paintRegions })`는 `actor.draw({ paintRegions })`와 같은 명시적인 이름 붙은 RGB 대체 값을 받습니다. 굽는 쪽은 atlas가 만들어질 때 값을 검증하고 캡처합니다. 동등한 값은 객체 키 순서와 무관하게 캐시를 공유하고, 서로 다른 값은 서로 다른 texture를 만듭니다. 호출자가 이후 값을 바꿔도 지연된 굽기나 context 복구 굽기에는 영향을 주지 못합니다. `null`이나 `{}`로 초기화하면 원래 fill을 씁니다. alpha, stroke, 표정, 작성된 pose는 원본이 소유한 채로 남습니다. 각 팔레트는 자체 atlas 이미지 바이트를 소비하므로, 호스트는 렌더 루프에서 새 조합을 만들지 말고 재생 전에 유한한 manifest를 예산에 넣고 준비해야 합니다.

`supersample`은 1(기본), 2 또는 4입니다. 1보다 크면 초기 표본을 더 큰 premultiplied RGBA 대상에 그린 뒤, 기존에 보관된 스프라이트 사각형을 써서 2:1 선형 필터 단계로 줄입니다. 최종 이미지를 키우거나 재생 작업을 늘리지 않고 준비된 커버리지를 개선합니다. 네이티브 MSAA와 픽셀 단위로 같지는 않습니다. 최종 이미지는 texture 배열 크기로 제한되고, 임시 supersample 대상은 `MAX_TEXTURE_SIZE / supersample`로 제한됩니다. 임시 굽기 대상은 최종 RGBA 바이트의 1배, 5배, 21배가 듭니다(`stats.bakeWorkingBytes`). 배열 자체는 호출자가 미리 할당합니다. `stats.atlasBytes` / `allocatedBytes`는 각각 최종 계획 / 실제 이미지 저장량이며, `stats.bakeWorkingBytes`는 최종 이미지를 포함한 이 굽기의 계획된 최대치입니다. 호스트는 장면의 최대치를 예산에 넣을 때 이미 상주 중인 다른 atlas를 추가로 더해야 합니다. 거부된 준비는 이미지 할당 전에 `atlasLimit`을 보고합니다. 임시 대상과 축소용 mesh는 성공·실패 뒤에 해제되며, context 복구는 같은 준비를 반복합니다. 정상 재생 중에는 supersample이 일어나지 않습니다.

Actor의 play/seek/transitionTo 시간선은 backend와 독립적입니다. 일반 clip은 원본 채널의 Float32 숫자 프로그램을 GPU에서 평가하고, CPU getSocket/getPartPose는 같은 배치의 Float64 채널로 해당 부위와 조상만 샘플링합니다. partPoses는 전체 CPU pose를 lazy로 계산해 독립 복사본을 반환합니다. 전환 중에는 원래 Anime.js CPU 평가를 사용하며 source/target/중첩/되감기 의미를 보존합니다. 종료된 전환은 GPU 경로로 돌아갈 수 있습니다. CPU 평가·부분 조회 횟수/시간은 actor.poseMetrics로 확인합니다.

actor.preparePose({excludeParts})와 MeshRenderer.preparePoses()를 actor 제출 전에 호출하면 여러 독립 위상을 한 준비 단계에서 평가할 수 있습니다. 이후 VectorContext.drawVectorActor(actor,options)는 앞선 paint와 순서를 보존합니다. excludeParts는 해당 부위만 숨기며 부모를 제외했다고 자식까지 숨기지 않습니다. setPartVisible의 부모 가시성 전파와 별개입니다. dispose는 소유 pose row를 반환하며 애플리케이션 ID를 GPU 행 번호로 사용하지 않습니다.

고정 브라우저 시나리오는 npm run test:vector-assets:gpu-poses로 실행합니다. test-results/gpu-poses.json에 사전에 고정한 픽셀/포즈 허용 기준, 차이가 난 픽셀 위치, GPU/CPU 사용량, 복구·dispose 결과를 기록합니다. 물리 모바일 검증을 대신하지 않습니다.
