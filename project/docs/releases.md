## v0.18.0 (2026-10-27)

- `VectorContext.globalCompositeOperation`을 추가합니다. `source-over`(기본)와 가산 `lighter`를 지원하며 단순 도형 painter와 vector path/stroke/text에 적용되고 save/restore에 포함됩니다. `PrimitiveRenderer.draw`는 batch 상태에 `blend`를 포함합니다. 불·전기·폭발처럼 겹치면 밝아지는 효과를 게임이 반투명 원 겹침으로 흉내 내지 않아도 됩니다.
- 검증: 실제 Chromium/WebGL에서 단순 도형·path의 가산 포화, save/restore 복원, 잘못된 값 예외를 임시 pixel 검사로 확인했습니다(저장소에는 남기지 않음).

## v0.17.1 (2026-10-27)

Prepared vector poses are reused within the same frame and pose revision, including mutable exclusion contents and context restoration. Drawing a previously prepared CPU pose no longer uploads its row again. Clean pose atlases return without scanning all actors on each visible mesh flush. `poseStats()` exposes `flushCalls`, `flushRecordVisits`, and `cleanFlushSkips`; player metrics expose `preparedPoseCacheHits`. Animation, paint order, geometry and image quality are unchanged. This fixes measured preparation overhead; it does not claim that every consumer scene is faster than its earlier renderer.

## v0.17.0 (2026-10-27)

공통 렌더러의 기본 backend를 WebGL 2로 전환합니다. Core instancing과 VAO를 사용하며 기존 analytic 도형과 공유 캔버스 순서를 유지합니다. 숫자 애니메이션 데이터 텍스처와 공유 pose atlas를 추가해 원본 SVG의 transform 채널·pivot·부모 계층을 GPU에서 평가합니다. CPU 소켓/부위 조회는 같은 채널의 Float64 데이터로 필요한 조상만 평가하고, 진행 중 중첩 전환·미지원 easing 등은 시계를 바꾸지 않고 명시적 CPU pose 경로를 사용합니다. Float render target 미지원/복구 실패도 CPU 숫자 텍스처로 처리합니다. 사용 비율·업로드·할당은 `MeshRenderer.poseStats()`로 구분합니다.

`player.preparePose()`, `MeshRenderer.preparePoses()`, `VectorContext.drawVectorAsset()`는 포즈 준비와 순서 보존 제출을 연결합니다. 종별 재정렬이나 메시 제거, 새 래스터 이미지 텍스처 시스템은 추가하지 않습니다. 독립 고정 브라우저 시나리오가 전환·표정/base pose·소켓/모프·반투명 paint·행 재사용/용량 증가·resize·context 복구·dispose를 CPU 참조와 비교합니다. 물리 모바일과 소비자 게임 전체 성능은 별도 검증 범위입니다.

**호환:** WebGL 2가 없는 환경에서는 생성이 실패합니다. 공개 시계/포즈/소켓 계약과 CPU 판정용 정밀도를 유지하며, GLSL ES 100의 기존 shader 입력은 device에서 ES 300으로 정규화합니다. WebGL 1/ANGLE 전용 backend 및 확장 객체에 의존한 직접 GL 호출은 core API로 이관해야 합니다.

## v0.16.0 (2026-10-27)

`vector-assets`가 소스 SVG 파일 자체가 기본 표정을 그리도록 강제합니다. `defaultExpression`의 `hide`에 있는 파트의 SVG 노드에는 `display="none"`이 있어야 하고, 그 밖의 노드에는 있으면 안 됩니다. 어느 쪽이든 어기면 컴파일 오류가 파트 id를 알려 줍니다. 컴파일러는 이 속성을 메모리 입력에서만 지우므로 모든 표정 변형은 이전과 같은 지오메트리로 컴파일되고, 런타임이 보임 여부를 정합니다. 표정이 여럿 들어 있는 SVG를 `<img>`나 미리보기로 열면 전부 겹쳐 보이던 문제가 없어져, 게임 UI가 아이콘·초상화·도감에서 원본 파일을 그대로 참조할 수 있습니다. 허용하는 `display` 값은 `none` 하나뿐입니다.

**호환:** 소스 바이트가 바뀌므로 숨겨야 할 표정이 있는 기존 SVG는 `display="none"`을 추가해야 하고 SHA-256도 달라집니다(`seed-scout.svg`는 컴파일된 지오메트리가 같고 해시만 바뀌는 것을 확인했습니다). 표정이 하나뿐이거나 `hide`가 빈 SVG는 그대로 컴파일됩니다. 검증 범위는 PR 기록을 따릅니다.

## v0.15.3 (2026-10-19)

`rendering`의 색 처리 비용을 줄였습니다. `normalizeColor`가 같은 CSS 색 문자열(hex·rgb()·hsl()·이름 색)을 매번 다시 파싱하던 것을 작은 캐시(512개 상한)로 재사용하고, `VectorRenderer`의 RGBA 검증은 draw마다 `Array.from`으로 배열을 만들던 것을 인덱스 루프로 바꿨습니다. `currentcolor`와 브라우저가 해석하는 이름은 문서 상태에 따라 달라져 캐시하지 않고, 반환 배열은 호출마다 새 사본이라 호출 쪽이 바꿔도 안전합니다. 파싱 결과와 오류 조건은 그대로입니다. 7가지 색을 40만 번 정규화하는 마이크로벤치가 207ms에서 28ms로 줄었고(Node 22 한 대), budmori-io 85마리 프로파일에서 두 함수가 렌더 CPU 상위였습니다. 브라우저 E2E와 실기기는 검증하지 않았습니다.

## v0.15.2 (2026-10-19)

`interpolation`의 지연 버퍼(`delayMs > 0`)가 캡처마다 엔티티별로 이력 항목을 구조분해로 복사하던 것을 없앴습니다. 교체되는 트랙은 다시 바뀌지 않으므로 이력 링에 그대로 넣고 자체 history만 떼어냅니다. 샘플 결과·시간·세대·reset 계약은 그대로입니다. 이전/이후 구현의 `sampleInto` 출력을 delay 0/50/100/200ms, reset·teleport·generation·revision 변경·소멸이 섞인 40개 무작위 시나리오로 비교해 불일치가 없었고, 100 엔티티 × 41 필드 · delay 50ms · 3000 캡처 마이크로벤치는 840ms에서 625ms로 줄었습니다(Node 22 한 대). 게임(budmori-io) 85마리 헤드리스 프로파일에서는 이 함수와 GC가 CPU 바쁜 시간의 약 절반이었습니다. 브라우저 E2E와 실기기는 검증하지 않았습니다.

## v0.15.1 (2026-10-18)

`rendering`의 `VectorRenderer`가 일반 solid/linear gradient 드로우에서 radial gradient 계산을 사용하지 않는 fragment shader pipeline을 선택합니다. radial shader와 픽셀, painter order, texture, clipping 동작은 기존 계약을 유지합니다. 기존 Chromium/WebGL E2E에서 pipeline 전환, radial 결과, clipping, context 복원과 자원 정리를 확인했습니다. SwiftShader 합성 측정은 mixed alternating에서 프레임 중앙값 40.32ms에서 20.77ms로 줄었고, radial-only는 127.60ms에서 128.04ms였습니다. 실물 GPU와 모바일 기기 성능은 검증하지 않았습니다.

## v0.15.0 (2026-10-18)

`pixel-physics`에 열린 월드(창 이동)와 뷰포트 렌더를 추가합니다. 격자는 고정 크기 창이고 큰 맵은 게임의 맵 데이터입니다. `shiftWindow(dx, dy, {load, evict})`가 셀·청크 플래그·발사체·엔티티·강체·핀·고정 조인트·정적 충돌체를 16의 배수 칸만큼 함께 옮기고, `scrollTo(focusX, focusY, hooks)`가 `stream: {margin, step}` 설정(미리 불러올 거리와 한 번에 옮기는 단위)에 따라 필요할 때만 옮깁니다. `readRegion`/`writeRegion`으로 맵 데이터를 일괄 읽고 쓰며, `hashCell(seed, x, y)`는 절대 좌표 기반 해시입니다. `writeGridPixels`와 `PixelRenderer`는 `view` 사각형만 쓰고 올리며(격자 밖은 배경), 음영은 절대 좌표 기준이라 창이 움직여도 같은 셀은 같은 색입니다. `enableCollapse`에 `anchorTop` 옵션을 추가했습니다(기본 꺼짐).

**호환:** `PixelWorld`의 snapshot과 `hash()`에 `originX`/`originY`가 들어가므로 이전 SDK가 만든 바이트는 `validatePixelWorld`가 거부하고, 같은 장면의 해시 값도 이전 버전과 다릅니다(origin이 0이어도). 버전이 섞인 방에서는 쓰지 마세요. 새 예제 `pixel-physics-open-world`(로켓)가 프리뷰 목록에 추가됩니다. 검증 범위는 PR 기록을 따릅니다.

## v0.14.3 (2026-10-18)

`RoomSession`이 퇴장 commit으로 로컬 피어를 roster에서 제거한 poll에서 join deadline 검사로 들어가지 않게 합니다. 커밋된 퇴장 ACK를 reliable queue에 flush하고 기존 retire 확인·연결 정리 순서를 이어갑니다. 고정 RTC E2E가 중복 leave 호출과 committed ACK, 5인 방 손님 퇴장 후 4→5 재입장, 기존 재연결과 호스트 퇴장을 확인합니다. wire protocol, snapshot/replay, 게임 규칙 계약은 바꾸지 않습니다.

## v0.14.2 (2026-10-18)

`deterministic`의 값 codec에 바이너리 형식 전용 typed array 태그(`Int8Array`·`Int16Array`·`Uint16Array`·`Int32Array`·`Uint32Array`·`Float32Array`·`Float64Array`, 요소는 little-endian, 실수는 유한 값만, `-0`은 `0`)와 `omitUndefined` 옵션을 추가합니다. 이전 SDK의 디코더는 새 태그가 든 payload를 읽지 못하므로 SDK 버전이 섞인 방에서는 쓰지 마세요. 기존 payload는 바이트 그대로 읽히고 같은 값의 인코딩 결과도 바이트가 같습니다. encode는 작업 버퍼를 재사용해 반복 호출에서 확장 복사를 없앱니다(격자 상태 인코딩 0.51~1.0ms → 0.15~0.27ms). `pixel-physics`의 `savePixelWorld`는 래퍼의 복사를 없애고(`snapshot(false)`) 새 태그를 직접 쓰며, 격자 배열을 같은 값 구간으로 줄여 저장합니다. 정지한 1280×720 월드의 스냅샷이 2.77MB에서 약 24KB로 줄어 히스토리 예산과 합류·복구 전송량이 크게 줄고, 구간이 줄지 않으면 원본으로 저장합니다. 이전 `savePixelWorld` 바이트는 새 `loadPixelWorld`로 읽을 수 없으므로 두 버전의 피어를 섞지 마세요. 수치는 Node 22 한 대에서 잰 값입니다.

## v0.14.1 (2026-10-18)

성능 개선 세 가지입니다. `deterministic`의 `hashBytes`가 이터레이터 대신 인덱스 루프를 써서 같은 FNV-1a 값을 약 20배 빠르게 계산합니다(695KB 17.9ms → 0.88ms, 체크섬 불변). `pixel-physics`는 첫 틱에 청크 sleep 판정을 한 번에 확정해, 큰 월드(1280×720)가 정지 상태에서도 약 3600틱 동안 전 청크를 돌리던 비용(틱 5.5ms → 0.15ms)을 없앱니다. 이 변경으로 첫 틱 이후 청크 스캔 집합이 달라지므로 같은 입력의 셀 시뮬레이션 결과가 이전 버전과 다를 수 있습니다. `rendering`의 `Renderer2D`는 RGBA 바이트 텍스처에서 알파가 모두 255이면 premultiply를 건너뛰고, `createTexture`의 `premultiplied:true` 선언과 `updateTexture`의 제자리 갱신·`{x,y,width,height}` 영역 갱신을 지원합니다. 수치는 Node 22와 소프트웨어 GL 헤드리스 Chromium 한 대에서 잰 값입니다.

## v0.14.0 (2026-10-18)

`pixel-physics`가 rollback·deterministic·rendering과 맞물립니다. `savePixelWorld`/`loadPixelWorld`/`validatePixelWorld`가 월드를 deterministic 값 코덱 바이트로 저장·복원하고, `writeGridPixels`가 격자를 rendering 텍스처로 올릴 RGBA로 씁니다. 엔티티는 `world.addEntity(body)`로 등록해야 하며 `world.bodies.push`로 넣은 엔티티는 바이트 저장에서 오류입니다. 스냅샷에 마스크 강체 셀·강체 크기·조인트 파라미터를 추가했습니다. rollback 모드는 `MatterBridge({checkpoint:1})`과 60Hz가 필요합니다. 검증은 Node syncTest와 헤드리스 Chromium 한 대이며 다른 기기 결정성과 큰 월드는 검증하지 않았습니다.

## v0.13.0 (2026-10-18)

픽셀·강체 물리는 `pixel-physics.js` 하나로 제공하고 Matter.js 0.19.0은 고정 웹 URL에서 가져옵니다. URL의 단일 원본은 소유 모듈의 dependencies.js이며 빌드·프리뷰·E2E가 공유합니다. Matter 엔진 소스는 GameKit 번들·예제 HTML에 포함하지 않습니다. 생성자는 `new MatterBridge(options)`이며 소비자는 별도 Matter import와 기존 첫 생성자 인자를 제거합니다. 별도 `pixel-physics-matter` 공개 모듈·npm 패키지 의존성·구 생성자 호환 경로를 제거합니다. 물리 계산·60Hz·체크포인트 계약은 유지하며 초기 실행에는 Matter 웹 URL 접근이 필요합니다.

## v0.12.3 (2026-10-18)

사용자가 제공한 PixelPhysics HTML에서 픽셀 재료·엔티티·강체 연동·Canvas 렌더링을 독립 `pixel-physics` ESM으로 이전합니다. Matter.js 0.19.0은 선택형 `pixel-physics-matter` 번들로 고정하며 플랫포머 예제와 단일 HTML 프리뷰를 함께 제공합니다. 원본 파일과 SHA-256은 모듈 출처 문서에 보존합니다. 물리의 시간 단위는 원본의 60Hz 고정 틱이며, Matter 스냅샷은 체크포인트 제약을 유지합니다. 서로 다른 브라우저·CPU 사이의 결정성이나 기존 rollback Adapter와의 통합을 보장하지 않습니다.

## v0.12.2 (2026-10-18)

`deterministic` 모듈에 count-only `createRollJob()` / `restoreRollJob()`을 추가해 PRD 대량 배치를 고정 성공 간격 예산으로 나누고 재개할 수 있습니다. job snapshot은 PRD·`SeededPRNG` state와 전체/처리/잔여 추첨 수, 누적 성공 수만 보존합니다. 기존 `roll()`·`rollMany()` 경로와 확률 분포는 유지하며, 고정 브라우저 시나리오는 작은 chunk의 중단·복원·chunk 크기 불변성과 0/1 경계를 확인합니다. Stage 61 규모에서는 yield가 동기 블로킹을 나눌 뿐 전체 처리 시간은 여전히 매우 깁니다.

## v0.12.1 (2026-10-18)

`deterministic` 모듈에 호출자가 소유한 결정론적 uint32 스트림용 `PseudoRandomDistribution`을 추가합니다. 선형 hazard `min(1, n * C)`의 계수를 설정 확률의 장기 평균에 맞춰 계산하고, 성공 후 실패 횟수를 초기화하며, 성공 횟수만 필요한 배치에서는 실패 간격을 건너뜁니다. 저장 상태에는 설정 확률·실패 횟수·대기 시도가 들어가며 PRNG 상태는 게임이 별도로 저장합니다. 고정 브라우저 시나리오는 평균과 분산, 연속 실패, seed 재현, 상태 복원, 확률 경계와 입력 검증을 확인합니다. 낮은 확률에서도 배치 비용은 실제 표본 성공 수만큼 처리됩니다.

## v0.12.0 (2026-10-18)

Adds a fixed-work-unit scheduler for resumable non-urgent tasks. It supports bounded per-task quanta, deterministic 4:2:1 priority rotation, duplicate-key coalescing, owner cancellation, and opt-in numeric diagnostics. Wall-clock timing never affects scheduling. The fixed browser scenario covers budget limits, resumption, fairness, cancellation, waiting-age counters, and FrameMetrics integration.

## v0.11.8 (2026-10-17)

Vector asset players accept a caller-owned `Set` of excluded part IDs on each `draw()` call.
Exclusions affect that draw only and preserve the player's expression, visibility state, and resolved pose cache.
Ordered mesh ranges and shader surfaces keep their painter order, alpha, clipping, and batch behavior.
The integrated browser checks cover face-only outline passes, unchanged body pixels, invalid exclusions, and shader-surface clip preflight.

## v0.11.7 (2026-10-17)

Interpolation reuses steady-state capture buffers and track records while keeping captured target snapshots detached.
Vector asset players cache resolved poses until playback or pose inputs change; public pose results remain detached copies.
Simloop drop notifications add exact dropped duration and reasons for clock gaps, input-dt clamps, backlog caps, and drop-policy trimming.
These additive telemetry fields do not change simulation timing or backlog policy behavior.
Core browser checks cover snapshot isolation, pose isolation, and drop telemetry. Allocation samples are CPU-only; GPU completion and physical mobile performance remain unmeasured.

## v0.11.6 (2026-10-17)

VectorContext adds a module-owned unit-quad renderer for full circles, ellipses, rectangles, and single-segment strokes.
It captures each shape's transform, color, alpha, stroke width, and cap or join style.
Full-ellipse fast paths defer arc point sampling unless the path later needs the existing vector fallback.
ANGLE devices batch compatible instances while preserving painter order and clipping.
Unsupported shapes keep the existing path fallback.
The fixed browser E2E checks real WebGL pixels, warm-frame tessellation, and instance-upload counters.
GPU completion time and physical mobile performance remain unmeasured.

## v0.11.4 (2026-10-17)

공통 코드 규칙을 Prettier와 ESLint로 검사합니다. 내부 const 바인딩을 UPPER_SNAKE_CASE로 정리하되 공개 export·import 이름, 객체 키, 클래스 이름, 함수 인자 수와 runtime 계약은 유지합니다. 소스·예제의 형식 정리로 비압축 배포 bytes가 바뀌므로 기존 불변 태그를 보존하기 위해 호환 PATCH를 발행합니다. API·wire protocol·게임 snapshot·replay 형식과 소비자 게임의 고정 버전은 바꾸지 않습니다.

## v0.11.3 (2026-10-17)

Rally에서 사용하던 범용 객체 풀을 독립 `object-pool.js`의 `ObjectPool`로 추출합니다. factory/reset/유휴 보관 상한과 LIFO acquire/release, 유휴 참조만 비우는 clear를 제공하며 게임별 상태와 buffer 수명은 포함하지 않습니다. 생성 설정만 검사하고 중복 반납·타입·외부 참조 해제는 소비자 계약으로 둡니다.

## v0.11.2 (2026-10-16)

Vector clip sampling skips a transition's source tree before its start and after it completes, avoiding repeat sampling and pose blending for settled historical transitions. Active transitions still blend from the prior tree to the target clip. Playback history remains retained for deterministic backward seeks, so this patch does not bound transition-history memory.

## v0.11.1 (2026-10-16)

`createRoomSession` adds an opt-in single-player local lockstep fast path. It preserves deterministic input/command execution and app-owned explicit saves while skipping SDK snapshot serialization/copies, checkpoint history, and state/input hashes when no peer can consume them. Existing local and online behavior is unchanged unless selected.

## v0.11.0 (2026-10-16)

The SVG compiler default changes to 4 curve segments and 2 round-stroke arc divisions. The exported frozen `VECTOR_ASSET_QUALITY_PRESETS` provides the `standard` 4/2 preset for most assets and the `smallAsset` 2/2 preset. Explicit 16/12 options retain the previous geometry; the supported range remains 1–64. Node compilation, the browser loader, the CLI, and the three-view example share these defaults.

## v0.10.7 (2026-10-16)

The SVG compiler accepts curve and round-stroke subdivisions from 1 through 64. The three-view quality example accepts direct integer input and offers quick presets. The existing defaults remain unchanged.

## v0.10.6 (2026-10-16)

Vector asset rendering no longer creates per-part morph arrays on the private draw path when those values are discarded; public `partPoses()` still returns independent mutable morph weights. The compiler adds `strokeArcDivisions` (4–64, default 12) for scaling and non-scaling round stroke tessellation, exposed through Node/browser compilation, browser loader caching, and the CLI. The default preserves prior stroke geometry.

## v0.10.5 (2026-10-16)

The vector asset compiler and browser startup loader add opt-in `normalizeCenteredViewBox` support for centered-local-coordinate SVG sources with legacy viewport dimensions and empty no-op clip poses. The compiler verifies the original source hash first, normalizes only its in-memory compiler input, drops only empty no-op poses from compiled metadata, and preserves the authored viewBox, paths, part pivots, sockets, and nonempty clip transforms. Source SVG files and the original-byte hash are unchanged.

## v0.10.4 (2026-10-16)

Vector assets add a standalone browser startup loader that verifies original SVG bytes, compiles them with the shared Node/browser core, deduplicates concurrent requests, and retains successful compiled geometry in a bounded cache. The production render bundle remains separate; the loader bundle includes no authored sample SVGs or precompiled sample geometry. Hash mismatches fail before compilation and caching.

## v0.10.2 (2026-10-16)

`createLoop` adds opt-in `backlogPolicy: 'defer'` for bounded real-time catch-up. It preserves unprocessed wall-clock debt up to `maxBacklogTicks`, keeps the existing per-pulse `maxCatchupSteps` limit, and reports dropped debt with explicit `clock-gap` or `backlog-overflow` diagnostics. It never skips authoritative simulation ticks. Existing `drop` default and unbounded opt-in `retain` behavior remain unchanged. Pause/resume and hidden-document reset behavior are documented and regression-tested.

## v0.10.0 (2026-10-16)

Rendering adds Canvas-compatible two-circle radial gradients to `VectorContext.createRadialGradient()` while retaining the creation transform and existing gradient texture lifecycle. `YarnSurfaceRenderer.drawSurface()` accepts an explicit `stencilRef` so retained Yarn fill and edge passes respect the active concave `VectorContext` stencil clip. Missing stencil attachments and invalid refs fail explicitly. Existing meshes and `MeshRenderer` batching semantics are unchanged. Focused browser pixel checks cover the Squish radial-gradient descriptor at 47 CSS px/DPR 1 and 74 CSS px/DPR 2, plus concave Yarn clipping and context restoration.

## v0.9.0 (2026-10-16)

Rendering adds endpoint-preserving linear gradient paints, retained single-contour stencil clips for full-detail concave paths, and safe mixed-alpha run instancing for disjoint bounds. `MeshRenderer.stats()` reports flush-boundary and actual draw-dispatch reasons. Unsupported clip shapes or unsafe batch bounds keep their explicit error or ordered fallback behavior.

## v0.8.0 (2026-10-16)

Rendering adds a generic `indexVariants` map for host-selected named triangle ranges. Vector asset `expressionIndices` remain semantic and are validated against authored expression names; the two maps are retained and rendered independently with explicit collision checks. `MeshBuilder.combine()` preserves semantic expression lists and rejects painter-order range maps that cannot be flattened without changing host paint order.

## v0.7.2 (2026-10-16)

Keep ordinary fill triangles unchanged when their retained SVG mesh also contains `vector-effect="non-scaling-stroke"` lines. The vertex shader now expands only the line vertices marked by their retained tangent data.

## v0.7.1 (2026-10-16)

Vector assets add an explicit, retained WebGL implementation for SVG `vector-effect="non-scaling-stroke"` on straight `<line>` elements. The feature keeps the 11-float mesh layout and expands authored line caps in viewport CSS pixels after camera and part transforms. Existing compiled assets and the default scaling-stroke path remain compatible. Unsupported vector-effect shapes and morph combinations fail compilation instead of silently changing appearance.

## v0.7.0 (2026-10-15)

Rendering adds alpha-threshold depth writes to MeshRenderer. With depthWrite enabled, depthWriteAlphaThreshold applies the requested cutoff to effective per-vertex alpha, draw opacity, color alpha, and part opacity. It submits only contiguous qualifying runs in the selected expression-index order and preserves painter order. Existing mesh-wide depthWrite calls are unchanged when the threshold is omitted. This is an additive rendering API; wire protocol and replay formats are unchanged.

# SDK 버전과 배포

[공통 관리 규칙](https://github.com/byh-playground/bloom-reference/blob/main/rules/project-management.html#version)을 따릅니다. MAJOR는 제품 세대(0은 개발 단계, 1은 최초 정식), MINOR는 비호환 변경, PATCH는 호환되는 의미 있는 변경입니다. 일반 SemVer와 동일한 규칙이 아닙니다. 문서·검사·예제만 수정하고 SDK 배포 bytes가 같으면 버전을 유지합니다.

SDK 버전 단일 원본은 [version.js](../../modules/_rollback-shared/version.js)입니다. 공개 VERSION과 배포 태그·commit metadata는 이 값을 읽습니다. 모듈별 버전이나 npm 배포는 없습니다. 첫 불변 태그는 기존 개발 버전을 정리한 `v0.2.0`입니다. API·wire protocol 3·manifest schema 2·기존 replay 형식은 유지하므로 MINOR를 올리지 않았습니다.

SDK VERSION은 제품 배포 식별자입니다. PROTOCOL_VERSION은 실제 packet/HELLO 호환성을 검사하고, simulationVersion은 게임이 정의하는 규칙·snapshot 호환성입니다. replay의 기존 형식 식별자도 제품 버전과 분리해 보존합니다. SDK 버전만 일치시켜 멀티플레이 호환을 보장할 수 없습니다.

SDK 0.3.0은 요청되지 않은 rollback-netcode 집계 진입점을 제거한 비호환 MINOR입니다. 필요한 API를 rollback/deterministic/simloop/transport/replay에서 직접 import합니다. 과거 v0.2.0 태그와 파일은 유지하지만 현재 dist에서는 제거된 번들을 제공하지 않습니다. wire protocol 3과 게임 snapshot·replay 형식은 바꾸지 않았습니다.

SDK 0.3.1은 로컬 preview의 STATE_KEY 경계와 지연 authority 연결·해제의 위치 되감김을
수정한 호환 PATCH입니다. 게임 규칙·wire protocol·공개 입력 형식은 유지합니다.

현재 SDK 0.3.2는 camera 모듈에 충돌 안전 거리의 즉시 축소·최근접 유지·반감기 복원을 소유하는
`CollisionBoom`을 추가한 호환 PATCH입니다. 충돌 쿼리·3D 방향·게임 규칙은 소비자가 소유합니다.

SDK 0.4.0은 vector-assets의 샘플 전용 createSeedScout 및 seedScoutMetadata 공개 내보내기를 제거하고 제네릭 createVectorAsset만 프로덕션 번들에 남기는 비호환 MINOR입니다. Seed Scout 샘플 API는 HTML 예제 진입점으로 옮겼으며 wire protocol, 게임 snapshot, replay 형식은 바꾸지 않았습니다.

## 불변 태그

main push의 기존 contents:write 권한으로 재빌드와 manifest 검증 후 `dist` commit과 `vX.Y.Z` 태그를 atomic push합니다. 태그는 **빌드된 dist commit**을 가리킵니다. Source-Commit, SDK-Version, Manifest-SHA256과 파일별 hash는 commit 메시지에 남깁니다. 이전 SHA URL과 dist 이력은 보존합니다.

이미 있는 태그의 실제 bundle·asset·manifest blobs가 모두 같으면 해당 릴리스를 재사용하며 새 dist commit/tag를 만들지 않습니다. 하나라도 다르면 PR CI와 publish에서 버전 누락 오류로 실패합니다. 태그는 force 이동하지 않습니다. 빌드 도구나 주석 변경으로 배포 bytes가 바뀌어도 불변성 때문에 새 버전이 필요합니다. 같은 외부 계약이면 PATCH를 사용합니다. stale main 실행은 건너뛰고 경합은 덮어쓰지 않습니다.

```js
// 검증 릴리스를 정확히 고정한 예시. 최신 버전의 단일 원본은 위 version.js입니다.
import { PresentationRuntime } from 'https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@v0.3.1/interpolation.js';
```

`git ls-remote --tags https://github.com/byh-playground/bloom-gamekit.git refs/tags/v0.3.1`으로 dist commit을 확인합니다. `<dist-commit>` SHA로 위 URL을 바꿔도 같은 파일이어야 합니다. 같은 ref의 manifest.json에서 파일 SHA-256을 읽고 다운로드한 bytes의 SHA-256을 비교하세요. 검증된 manifest hash 자체는 해당 dist commit 메시지와 대조합니다. 자산에는 byte length도 적용합니다. GitHub blob 페이지나 raw URL을 브라우저 ESM 호스팅 주소로 사용하지 않습니다.

## 실행 HTML 프리뷰

[프리뷰 목록](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/index.html)은 모든 예제를 포함합니다. [previews.mjs](../previews.mjs)의 EXAMPLES가 목록입니다. 원본 예제는 소유 모듈 아래에 있으며 API 설명만 있는 모듈에 빈 데모를 만들지 않습니다.

기존 html-share 문서처럼 HTML Preview를 사용합니다. 원본 ESM 예제를 직접 열면 상대 import와 module 실행이 실패하므로 `npm run build:previews`가 각 예제를 독립 IIFE script가 포함된 HTML 하나로 묶습니다. 예제 간 링크는 공개 프리뷰 URL로 변환합니다. PixelPhysics는 HTML Preview가 `type="module"`을 지우고 classic script로 다시 만들어 정적 import가 실패하므로 IIFE 안에서 정의된 Matter 웹 URL을 실행 직전에 동적 `import()`로 받으며 엔진 코드를 HTML에 넣지 않습니다. 나머지 예제는 외부 SDK import·CDN·공유 chunk가 없습니다. 소스 보기 링크는 GitHub 파일로 연결합니다. `dist/*.js`의 독립 ESM 계약과 프리뷰 빌드는 별개입니다.

같은 main CI가 생성 HTML만 별도 `previews` 브랜치에 게시합니다. SDK bytes가 그대로인 예제 수정은 프리뷰만 갱신합니다. 새 계정·토큰·유료 호스팅·Pages 설정은 필요하지 않습니다. 프리뷰는 최신 main의 예제이며 불변 SDK 릴리스 URL과 혼동하지 마세요. Nostr 온라인 예제는 여전히 공용 relay·NAT 환경 영향을 받습니다. 오디오 재생에는 사용자의 시작 동작이 필요합니다.
