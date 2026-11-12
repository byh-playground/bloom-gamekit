# bloom-gamekit

브라우저 게임에서 공통으로 쓰는 보간·렌더링·입력·실행·결정론·전송·리플레이·롤백 기능을 독립 모듈로 개발하는 저장소입니다. 필요한 기능만 골라 조합하며, 게임 전체를 소유하는 범용 엔진 클래스는 만들지 않습니다.

**모든 공개 기능은 plain JavaScript ESM입니다.** 소비자는 필요한 파일만 가져갑니다. `pixel-physics`는 소유 모듈에서 정의한 Matter 웹 URL을 import하며 엔진 소스를 포함하지 않습니다. 그 외 모듈은 외부 runtime import나 공유 chunk를 요구하지 않습니다. 보간은 pose, WebGL renderer/device는 GPU 제출·자원, input은 장치 이벤트/action, simloop는 실행 스케줄, camera는 투영·충돌 boom 거리 표현, presentation-events는 표현 자원, hud는 화면 anchor, debug-tools는 진단, audio는 실제 오디오 자원과 재생 예산을 소유합니다. 결정론·전송·리플레이·rollback은 기존 SDK 구현을 책임별로 분리했으며, 이전 후 수정 이력은 SDK 출처 문서에 구분해 기록합니다.

## 하려는 일 → 모듈

기능이나 검증·측정 수단(장면 재현·캡처·리플레이·계측)을 새로 만들기 전에 이 표를 먼저 봅니다. 맞는 모듈이 모자라면 게임에서 우회하지 않고 모듈을 고칩니다([공통 규칙 AI-021·AI-009](https://github.com/byh-playground/bloom-reference/blob/main/rules/ai-development.html#module-first)). 사용법의 원본은 각 모듈 README 첫머리(언제 쓰나 · 쓰는 모양 · 쓰지 말아야 할 때)이고, 게임별 실제 사용은 각 게임의 AGENTS.md에 있습니다. 새 모듈을 추가하면 이 표에 행을 넣습니다(`npm run check`가 빠진 모듈을 잡습니다).

"쓰는 게임"은 저장소 이름입니다. 쌀콩팡 = `rally-frontier`, 발배구 = `bloom-takraw`. 비어 있으면 아직 쓰는 게임이 없습니다.

### 검증·재현·계측

| 하려는 일                                                                                    | 모듈                                                                                                                                                                                                     | 바로 보기              | 쓰는 게임                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| 같은 장면을 주소 한 줄(`?debug=1&scene=…&tick=N`)로 열어 확인·캡처하고, 작업 전후를 비교한다 | [debug-tools](./modules/debug-tools/README.md) `installDebugHost`(가상 시계 `freezeClock`) + 명령줄 실행기 `dist/debug-scene.mjs` `runDebugScene` + 장면 실행은 [scenario](./modules/scenario/README.md) | [접촉 탭][p-contacts]  | rally-frontier, bloom-takraw                             |
| 카드·타이틀·도움말 안에서 격리된 실제 게임 실행을 재생한다                                   | [scenario](./modules/scenario/README.md) `createScenario`·`createScenarioSurface`                                                                                                                        | [scenario][p-scenario] | rally-frontier, budmori-io, bloom-bounko                 |
| 공개 게임 소개(전체 화면 iframe 시연)를 붙인다                                               | [scenario](./modules/scenario/README.md) `installShowcase`                                                                                                                                               | [scenario][p-scenario] | meow-tumble, squish-born, yarn-mayhem, bloom-sketch-town |
| 기록한 경기를 같은 결과로 다시 재생해 최종 hash를 맞춰 본다                                  | [replay](./modules/replay/README.md) `playReplay` (기록은 rollback `exportReplay`)                                                                                                                       |                        |                                                          |
| 저장→불러오기→재실행으로 결정론이 깨지는 틱을 찾는다(synctest)                               | [deterministic](./modules/deterministic/README.md) `runSyncTestAsync`                                                                                                                                    |                        | rally-frontier                                           |
| 두 상태에서 고른 필드만 비교한다                                                             | [debug-tools](./modules/debug-tools/README.md) `compareStateFields`                                                                                                                                      |                        |                                                          |
| 프레임·단계별 CPU 시간과 카운터를 잰다                                                       | [debug-tools](./modules/debug-tools/README.md) `FrameMetrics`·`PerformanceProfiler`                                                                                                                      |                        | budmori-io                                               |
| 오류를 모아 복사 가능한 진단 문서로 보여 준다                                                | [debug-tools](./modules/debug-tools/README.md) `DiagnosticRing`·`copyDiagnostic`                                                                                                                         |                        | bloom-takraw                                             |
| 리플레이를 앞뒤로 탐색·재생하는 조작을 붙인다                                                | [debug-tools](./modules/debug-tools/README.md) `ReplayTimeline`                                                                                                                                          |                        | rally-frontier                                           |

### 시뮬레이션

| 하려는 일                                                      | 모듈                                                                           | 바로 보기                                                        | 쓰는 게임                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 고정 틱으로 시뮬을 돌리고 렌더와 분리한다                      | [simloop](./modules/simloop/README.md) `createLoop`                            | [simloop-input-preview][p-simloop]                               | rally-frontier, bloom-takraw, budmori-io, yarn-mayhem 등 9개 |
| 가까운 것만 찾는다(주변 유닛 후보, 겹치는 상자 쌍)             | [spatial](./modules/spatial/README.md) `UniformGrid`·`BoundsGrid`              |                                                                  | rally-frontier                                               |
| 유닛끼리·벽과의 충돌을 푼다                                    | [contact-solver](./modules/contact-solver/README.md) `ContactSolver`           | [접촉 탭][p-contacts]                                            | rally-frontier                                               |
| 원 하나를 벽에 미끄러지며 움직인다, 점·선분·다각형 거리를 잰다 | [geometry](./modules/geometry/README.md) `SurfaceMotion`·`ObstacleField`       | [기하 탭][p-geometry]                                            | rally-frontier                                               |
| 여러 유닛이 같은 목표로 길을 찾는다(지형마다 느린 칸 포함)     | [pathfield](./modules/pathfield/README.md) `PortalGraph`·`FlowField`           | [포털 탭][p-portal]                                              | rally-frontier                                               |
| 유닛 하나의 경로(웨이포인트)를 찾고 따라간다                   | [pathfield](./modules/pathfield/README.md) `RouteFinder`                       | [포털 탭][p-portal]                                              | rally-frontier                                               |
| 시야·안개(이 자리의 대상이 보이는가)를 정한다                  | [vision](./modules/vision/README.md) `VisionMap`·`VisionField`                 | [시야 탭][p-vision]                                              | rally-frontier                                               |
| AI가 지금 무엇을 할지 고르고, 시작한 동작의 단계를 진행한다    | [behavior](./modules/behavior/README.md) `BehaviorTree`·`StateMachine`         | [행동 탭][p-behavior]                                            | budmori-io                                                   |
| 무거운 탐색을 틱마다 정해진 양씩 나눠 처리한다                 | [work-scheduler](./modules/work-scheduler/README.md) `createBudgetedScheduler` | [작업 예산 탭][p-budget]                                         | budmori-io                                                   |
| 시드 난수·고정소수점·상태 직렬화를 결정론으로 한다             | [deterministic](./modules/deterministic/README.md)                             |                                                                  | rally-frontier, bloom-takraw, budmori-io, meow-tumble        |
| 모래·물 같은 픽셀 재료와 강체를 한 월드에서 돌린다             | [pixel-physics](./modules/pixel-physics/README.md) `PixelWorld`                | [플랫포머][p-pp] · [오픈 월드][p-pp-open] · [옆 전투][p-pp-side] |                                                              |

### 온라인

| 하려는 일                                            | 모듈                                                                                  | 바로 보기                                                   | 쓰는 게임                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 온라인 대전(입력 예측·롤백·복구)을 한다              | [rollback](./modules/rollback/README.md) `createSession`·`createRoomSession`          | [rollback-reference][p-rb-ref] · [availability][p-rb-avail] | rally-frontier, bloom-takraw, meow-tumble, bloom-digmori              |
| 방을 만들고 참가해 P2P로 연결한다                    | [transport](./modules/transport/README.md) `createNostrRoom`·`createNostrDynamicRoom` |                                                             | rally-frontier, bloom-takraw, meow-tumble, yarn-mayhem, bloom-digmori |
| 온라인 입력을 로컬에서 먼저 보여 준다(예측 미리보기) | [simloop](./modules/simloop/README.md) `LocalInputPreview`                            | [simloop-input-preview][p-simloop]                          |                                                                       |

### 입력·표현

| 하려는 일                                         | 모듈                                                                                                     | 바로 보기                                                  | 쓰는 게임                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| 키보드·마우스·터치를 게임 액션으로 바꾼다         | [input](./modules/input/README.md) `ActionState`·`createDOMInput`                                        | [interpolation][p-interp]                                  | rally-frontier, bloom-takraw, yarn-mayhem, meow-tumble 등 8개      |
| 틱 사이를 부드럽게 그린다(보간)                   | [interpolation](./modules/interpolation/README.md) `PresentationRuntime`·`RenderObject`                  | [interpolation][p-interp] · [frame][p-interp-frame]        | rally-frontier, bloom-takraw, budmori-io, yarn-mayhem 등 8개       |
| WebGL 2로 도형·스프라이트·벡터를 그린다           | [rendering](./modules/rendering/README.md) `WebGLDevice`·`VectorContext`                                 | [rendering][p-rendering]                                   | rally-frontier, budmori-io, squish-born, yarn-mayhem, bloom-bounko |
| SVG 원본을 그대로 캐릭터·애니메이션으로 그린다    | [vector-assets](./modules/vector-assets/README.md) `createVectorActor`                                   | [vector-assets][p-vector] · [래스터 비교][p-vector-raster] | rally-frontier, budmori-io, squish-born, yarn-mayhem, bloom-bounko |
| 게임 시작 때 SVG를 검증·컴파일해 불러온다         | [vector-assets-loader](./modules/vector-assets-loader/README.md) `createVectorAssetLoader`               |                                                            | rally-frontier, budmori-io, squish-born, yarn-mayhem, bloom-bounko |
| 캐릭터 얼굴에 표정을 얹는다                       | [face](./modules/face/README.md) `FaceOverlay`                                                           | [표정 탭][p-face]                                          | rally-frontier                                                     |
| 카메라 투영·추적·흔들림, 3D 카메라의 벽 충돌 거리 | [camera](./modules/camera/README.md) `CameraViewport`·`CollisionBoom`                                    |                                                            | rally-frontier, yarn-mayhem, bloom-bounko, meow-tumble             |
| 타격 이펙트·효과음을 롤백·재확정에도 한 번만 낸다 | [presentation-events](./modules/presentation-events/README.md) `PresentationEventQueue`                  |                                                            | rally-frontier, bloom-takraw, meow-tumble, bloom-digmori           |
| 월드 위치에 이름표·체력 같은 화면 요소를 붙인다   | [hud](./modules/hud/README.md) `resolveAnchorInto`·`DOMHud`                                              | [interpolation][p-interp]                                  | rally-frontier                                                     |
| 프레임마다 임시 객체를 안 만들고 재사용한다       | [object-pool](./modules/object-pool/README.md) `ObjectPool`                                              |                                                            | rally-frontier, bloom-takraw, budmori-io                           |
| 효과음·환경음을 음량·재생 예산 안에서 낸다        | [audio](./modules/audio/README.md) `AudioPlayer` · [합성·출력 예제](./modules/audio/examples/index.html) | [audio][p-audio]                                           | bloom-takraw, yarn-mayhem, bloom-bounko                            |

### 화면·운영

| 하려는 일                                                      | 모듈                                                                                                                                                                                             | 바로 보기                  | 쓰는 게임                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------- |
| 화면 전환을 주소(`#/화면/항목`)와 뒤로 가기로 다룬다           | [navigation](./modules/navigation/README.md) `createNavigation`                                                                                                                                  | [navigation][p-navigation] | rally-frontier, meow-tumble, bloom-bounko                                     |
| 업그레이드·연구 트리 화면을 만든다                             | [tech-tree](./modules/tech-tree/README.md) `createTechTree`                                                                                                                                      | [tech-tree][p-tech-tree]   |                                                                               |
| 저장·불러오기(이관·검증·탭 간 충돌)                            | [save](./modules/save/README.md) `createSave`                                                                                                                                                    |                            | bloom-takraw, budmori-io, squish-born, yarn-mayhem, bloom-bounko, meow-tumble |
| 화면 문구를 여러 언어로 낸다                                   | [i18n](./modules/i18n/README.md) `createLocale`                                                                                                                                                  |                            | bloom-takraw, budmori-io                                                      |
| 시작 로딩 진행률, 고정한 GameKit 파일을 SHA-256 확인 후 import | [boot](./modules/boot/README.md) `createBoot`·`importPinnedModules`                                                                                                                              |                            | rally-frontier, budmori-io                                                    |
| 설치 가능한 PWA·오프라인 시작                                  | [pwa](./modules/pwa/README.md) `registerPwa`·`buildPwa`                                                                                                                                          |                            | bloom-takraw, budmori-io, squish-born, yarn-mayhem, bloom-bounko              |
| 플레이 지표(세션·이벤트·경기 기록)를 모은다                    | [metrics](./modules/metrics/README.md) `createMetrics`                                                                                                                                           | [지표 탭][p-metrics]       | bloom-takraw                                                                  |
| 광고를 붙이고 빈도를 제한한다                                  | [bm](./modules/bm/README.md) `createBm` · 어댑터 [mock](./modules/bm/adapters/mock/README.md)·[Google H5](./modules/bm/adapters/google-ads/README.md)·[IMA](./modules/bm/adapters/ima/README.md) | [bm][p-bm]                 | bloom-bounko(`?ads=test`만)                                                   |
| 인앱 구매와 광고 제거 같은 보유 판정                           | [store](./modules/store/README.md) `createStore` · 어댑터 [mock](./modules/store/adapters/mock/README.md)                                                                                        | [상품 탭][p-store]         |                                                                               |

`_rollback-shared`는 rollback·deterministic·transport·replay의 내부 구현이라 소비자가 직접 쓰지 않으며 표에 없습니다.

[p-scenario]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/scenario.html
[p-simloop]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/simloop-input-preview.html
[p-contacts]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=contacts
[p-geometry]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=geometry
[p-portal]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=portal
[p-vision]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=vision
[p-behavior]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=behavior
[p-budget]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=budget
[p-pp]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics.html
[p-pp-open]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics-open-world.html
[p-pp-side]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics-side-battle.html
[p-rb-ref]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rollback-reference.html
[p-rb-avail]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rollback-availability.html
[p-interp]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/interpolation.html
[p-interp-frame]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/interpolation-frame.html
[p-rendering]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering.html
[p-face]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering.html#face
[p-vector]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html
[p-vector-raster]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-raster-comparison.html
[p-audio]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/audio.html
[p-navigation]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/navigation.html
[p-tech-tree]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/tech-tree.html
[p-metrics]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=metrics
[p-bm]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html
[p-store]: https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=store

## 그 밖의 문서

- [SDK 전체/분리 API와 이전](./modules/rollback/docs/api-migration.md) · [비활성 참가자·가용성 정책·자동 coordinator 이관](./modules/rollback/README.md#비활성-참가자와-선택형-가용성) · [1:1 방 연결과 재연결](./modules/transport/README.md#11-방-연결과-재연결-createnostrroom)
- 모듈 소스 예제: [보간](./modules/interpolation/examples/index.html) · [detached 입력 preview](./modules/simloop/examples/input-preview/index.html) · [렌더링(벡터·아틀라스·재질·그라디언트·표정 탭)](./modules/rendering/examples/index.html) · [독립 deadline pump](./modules/rollback/examples/availability/index.html)
- [고정 브라우저 E2E](./project/tests/browser.e2e.mjs) · [별도 보간 벤치마크](./modules/interpolation/scripts/benchmark.mjs) · 모듈별 고정 시나리오 명령은 각 모듈 README에 있습니다.

## 저장소 구조와 명령

```text
modules/<module>/*.js              공개 모듈 runtime 소스
modules/<module>/README.md         언제 쓰나·쓰는 모양·쓰지 말아야 할 때, 그 아래 API·비용·제한
modules/<module>/{docs,examples,tests,scripts}/  해당 모듈 소유 자료
modules/_rollback-shared/          rollback 계열의 내부 공유 구현·SDK 버전 단일 원본
modules/rollback/docs/provenance/  원본 zip·manifest·출처
project/                         저장소 공통 빌드·배포·프리뷰 생성
project/{tests,docs,benchmarks}/  통합 검증·측정 기록
.github/workflows/ci.yml           PR 검사 / main→dist·불변 태그·previews
```

개발 명령은 `npm ci`, `npm run format`, `npm run check`, `npm test`, `npm run test:browser`입니다. [코드 규칙](./project/docs/code-conventions.md)은 Prettier와 ESLint가 검사하며 `npm run build`도 먼저 같은 읽기 전용 검사를 실행합니다. 브라우저 첫 설치는 `npx playwright install chromium`입니다. 소스·문서·검사·예제·도구는 기능을 소유한 모듈에 함께 둡니다. 저장소 공통 자료는 project 아래로 모으며 루트에 docs/scripts/tests/examples를 두지 않습니다. `rollback`은 세션과 종합 예제, `transport`는 RTC/discovery 검사를 소유합니다. 공개 집계 진입점은 없습니다.

검증 정책 원본은 [공통 프로젝트 관리 규칙 §13](https://github.com/byh-playground/bloom-reference/blob/main/rules/project-management.html#verification)입니다. `npm test`는 실제 DOM 입력 → 시뮬 → 표시 모델 → WebGL·HUD·복구의 고정 시나리오를 실행합니다. `npm run test:network`는 RTC·방 수명주기, `npm run test:availability`는 가용성·복귀·분할 시나리오입니다. `npm run test:scenarios`는 build 후 독립 시나리오를 최대 두 개씩 실행하고 데모까지 포함합니다. 각 실행 전체 상한은 180초이며 초과하거나 한 경로가 실패하면 남은 자식 프로세스도 정리하고 실패합니다. 개발 중 단위 검증 파일은 완료 시 제거하고 구현 내부에 맞춘 회귀 파일을 누적하지 않습니다. CPU·할당 측정은 `benchmark:interpolation`, `benchmark:presentation`, 기존 SDK benchmark 명령으로 따로 실행합니다.

루트 package.json은 개발 도구만 관리하며 모듈별 버전·workspace·npm 발행은 아직 도입하지 않았습니다.

## GitHub 파일 배포

PR에서는 소스 전용 checkout, 독립 모듈 build, 생성 manifest, bundle bytes와 고정 목록의 font assets를 확인합니다. main에 승인된 변경이 들어오면 GitHub Actions가 같은 build 결과를 확인한 후 `dist` 브랜치의 공개 브라우저 JavaScript 번들과 Node 도구(`pwa-build.mjs`·`boot-build.mjs`·`debug-scene.mjs`, 목록은 `project/distribution.mjs`의 `NODE_TOOLS`), `manifest.json`, 명시된 font assets를 자동 갱신합니다. `vector-assets-loader.js`는 게임 시작 시 원본 SVG를 검증하고 공유 컴파일러로 retained geometry를 생성하는 별도 번들이며, 샘플 SVG를 포함하지 않습니다. modules/assets의 정확한 목록과 자산 경계는 project/distribution.mjs와 생성 manifest가 소유합니다. 생성 JS와 asset 복사본은 소스 커밋에 넣지 않습니다. 실제 Node·Chromium E2E와 benchmark는 로컬 검증 명령으로 유지하며 자동 배포 경로에 포함하지 않습니다. 표준 `ubuntu-latest`만 사용하며 유료 runner·artifact 저장·Release·npm·Pages는 쓰지 않습니다. HTML Preview용 단일 HTML은 같은 CI 권한으로 별도 previews 브랜치에 배포합니다.

main 실행이 성공하면 [interpolation.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/interpolation.js), [rendering.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/rendering.js), [input.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/input.js), [hash manifest](https://github.com/byh-playground/bloom-gamekit/blob/dist/manifest.json)에서 파일을 공유할 수 있습니다. GitHub Raw URL은 JS MIME/CORS를 보장하는 웹 호스팅 계약이 아니므로 브라우저의 직접 import 주소로 가정하지 마세요. **CORS-enabled font assets**는 `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/assets/fonts/<file>`처럼 정확한 공개 dist commit을 고정해 가져오고 manifest의 byte length/SHA-256을 적용합니다. 정확한 불변 버전 태그 또는 dist commit SHA를 사용하고 branch-latest 주소는 사용하지 마세요. dist 커밋 메시지에 source commit과 manifest의 bundle/asset SHA-256 및 asset byte length가 기록됩니다. 검사 job의 manifest hash와 배포 직전 모든 재빌드 파일을 대조합니다. 기존 dist의 다른 파일은 보존하고, stale main 실행은 건너뛰며 경합 시 non-fast-forward로 중단합니다. 브랜치 게시의 실제 성공은 main 머지 후 별도로 확인해야 합니다.

자세한 [버전·배포·프리뷰 계약](./project/docs/releases.md)과 [실제 검사 범위](./project/docs/verification.md)를 참고하세요.

## 공통 설계 원칙

- **최적화가 먼저, 재미가 그다음입니다.** 계산량·호출 빈도·할당·메모리·초기 로딩·틱·렌더 비용을 함께 판단합니다. 비용을 다른 구간으로 옮긴 것을 제거했다고 계산하지 않습니다. 예상과 실측을 구분하고 성능 회귀를 숨기지 않습니다.
- **Is-a:** 각 객체가 무엇이며 어떤 책임을 갖는지 좁고 구체적으로 정의합니다.
- **Has-a:** 필요한 capability와 정책을 조합합니다. 기능 추가를 위해 거대한 공통 클래스나 장르별 상속 체계를 만들지 않습니다.
- **Can-be:** 실행·대기·예측·복구 등은 해당 소유자의 상태와 정책으로 다룹니다. 같은 기능의 엔진을 상황별로 복제하지 않습니다.
- 밸런스·지속시간·표현 한도·동작 정책은 Definition 또는 명시적 설정을 기준으로 삼습니다. 같은 규칙을 여러 함수의 조건문과 상수로 복제하지 않습니다.
- 지속시간과 시각의 공통 단위는 **밀리초(ms)**입니다. 시뮬레이션 tick과 입력 sequence는 시간과 별개입니다. 외부 API의 단위가 다르면 경계에서 명시적으로 변환하며, TPS를 바꿔도 게임 지속시간이 달라지지 않아야 합니다.
- 입력 → 결정론적 시뮬레이션 → 표현의 소유권을 분리합니다. 렌더 pose·보간 캐시·카메라·이펙트로 권위 상태를 재구성하거나 덮어쓰지 않습니다.
- 패키지는 다른 패키지의 내부 상태를 읽지 않습니다. 필요한 데이터와 동작을 공개 계약으로 전달하며, 기능 하나를 사용하려고 나머지 패키지를 초기화하게 만들지 않습니다.

## rollback SDK 이전과 게임 경계

기존 [rollback-netcode 보존 snapshot](modules/rollback/docs/provenance/README.md)의 검증된 소스를 이 저장소로 책임별 이전했습니다. [독립 API·출처·이전 방법](./modules/rollback/docs/api-migration.md)을 참조하세요. 기존 저장소는 보존하며 입력 순서·명령 sequence·tick·예측·롤백·복구는 새로 구현하지 않습니다. `deterministic.js`, `simloop.js`, `transport.js`, `replay.js`, `rollback.js`를 필요한 기능별로 직접 가져옵니다. 분리 모듈도 외부 runtime import가 없으며 dist commit SHA와 manifest hash로 고정합니다.

게임은 자신의 Definition·규칙·권위 상태·완전한 snapshot과 결정론적 어댑터를 소유합니다. UI와 AI가 제출한 행동은 같은 명령 경로를 거쳐 SDK가 정한 tick에서 실행됩니다. input 패키지는 기기 이벤트를 정리할 뿐, 자체 타이머로 명령을 실행하거나 권위 상태를 직접 수정하지 않습니다. 포커스 상실과 입력 해제도 같은 입력 계약에 연결합니다.

보간·렌더링은 완료된 시뮬레이션 결과를 표현합니다. 표현의 실제 시간과 SDK의 고정 논리 시간을 혼동하지 않으며, 프레임 지연을 보정하려고 시뮬레이션 dt를 바꾸지 않습니다. 재실행 중 소리·알림·이펙트를 중복 발생시키지 않도록 게임의 표현 이벤트 경계에 맞춥니다.

## 첫 보간 구현의 기준

첫 대상은 새 snapshot 수신과 렌더 프레임 사이의 retarget 연속성입니다. 마지막 rAF에서 그렸던 pose를 그대로 새 시작점으로 쓰면 수신 순간까지 진행한 기존 곡선의 위치와 어긋날 수 있습니다.

- 새 목표가 도착한 **그 시각의 기존 보간 곡선을 평가한 pose**에서 출발해 최신 목표까지 이어갑니다. 수신과 렌더 평가에는 같은 단조 시간 기준을 사용합니다.
- 초기 기본 정책은 새 목표까지 **시뮬레이션 한 틱의 시간(`1000 / TPS` ms)** 동안 연결하는 continuous retarget입니다. 별도의 숨은 500ms 버퍼나 미래 위치 외삽을 기본값으로 넣지 않습니다.
- 이 정책에도 목표를 따라가는 표현 지연이 있습니다. 새 표본이 늦어 목표에 먼저 도착하면 그 위치에서 대기하므로 모든 지터와 멈춤을 없앤다고 주장하지 않습니다. 지연·버퍼·대기 정책의 변경은 설정과 비용을 드러냅니다.
- hitstop은 권위 XYZ로 순간 이동했다가 이전 보간으로 돌아가는 방식으로 처리하지 않습니다. 표현 정지와 재개가 같은 pose·시간 정책을 따르게 하며, 순간이동·spawn/despawn·롤백 보정처럼 불연속이 필요한 경우는 명시적으로 구분합니다.
- 기존 게임의 NavMesh·전투·성장·캠페인 규칙은 공통 패키지로 복사하지 않습니다. 게임별로 서로 다른 공간 탐색 정책을 하나로 강제하지 않습니다.

이 계약은 독립 모듈과 재현 fixture로 검사합니다. 기존 게임 자체에 적용하거나 그 게임의 지터를 해결했다는 보고는 아닙니다.

## 검증과 성능

큰 조합별 테스트 목록보다 **실제 패키지와 게임 경로를 연결하는 하나의 연속 E2E**를 중심으로 검증합니다. 첫 보간 구현에는 재현 가능한 snapshot 수신 시각·rAF 시각·목표 pose fixture를 연결해 규칙적 수신, 지터·지연, retarget, hitstop과 재개를 같은 흐름에서 확인합니다. 브라우저 E2E는 같은 실행 예제에서 실제 DOM 입력 → 100ms 고정 시뮬레이션 → 보간 → WebGL 픽셀을 연결합니다. 키/터치 edge·UI 제외·blur·DPR·texture/alpha/order·camera·batch 재사용·context loss/restore·dispose를 한 실행에서 이어 검사합니다. 발견한 실패에는 필요한 집중 회귀 검사만 추가합니다.

같은 입력·seed·규모에서 변경 전후를 비교하고, 보간 계산·할당·메모리와 실제 화면 갱신 간격을 구분해 기록합니다. CPU 렌더 제출 시간을 GPU 완료시간으로 부르지 않습니다. 개발 기기·브라우저·장면·측정 구간을 남기고 짧은 구간이나 한 기기의 결과를 전체 성능으로 일반화하지 않습니다.

정적 검사나 모의 실행을 실제 브라우저·WebGL·기기 검증으로 대신하지 않습니다. 통과·실패·미실행 범위를 구별하고, 확인하지 않은 결과를 Stable 또는 VALIDATED라고 표시하지 않습니다. 실제 실행한 환경과 커밋을 PR 검증 기록에 남깁니다. 현재 CI는 소스·빌드·배포 검증이며 브라우저 E2E는 로컬 명령입니다.

## 모듈을 조합하는 범위

예제의 게임이 100ms 시뮬레이션 규칙·명령 소비·y-sort·UI 내용을 소유합니다. simloop의 createLoop가 누적/프레임 실행을 맡고 camera·presentation-events·hud·debug-tools를 조합합니다. input의 sample은 edge를 지우지 않으며 게임/SDK가 명령을 수집한 뒤 consume합니다. rendering에는 interpolation import가 없고, 완성된 pose를 받은 게임이 body/shadow/health를 제출합니다. context 복구 시 texture handle은 유지되며 현재 프레임은 버립니다.

지형 의미·게임 아트·전투 규칙·scenegraph·게임별 투영은 공통 모듈로 만들지 않습니다. 지형 의미가 없는 순수 2D 기하 수학과 원형 이동체의 접촉 해소는 [geometry](./modules/geometry/README.md)·[contact-solver](./modules/contact-solver/README.md), 시야 판정은 [vision](./modules/vision/README.md), 스프라이트 애니메이션은 [rendering](./modules/rendering/README.md), SVG 자산 불러오기는 [vector-assets-loader](./modules/vector-assets-loader/README.md)가 맡습니다. WebGLDevice는 기존 게임이 제공하는 shader·geometry를 받아 자원·buffer·draw 호출을 관리합니다. 각 모듈을 실제로 쓰는 게임은 위 "하려는 일 → 모듈" 표의 "쓰는 게임" 열에 있습니다. 로컬 브라우저 E2E는 실제 WebGL 2 shader와 픽셀을 SwiftShader로 검사하므로 Canvas2D 모의 검증이 아니지만, 모바일·기기 GPU FPS 검증도 아닙니다. 화면 metrics는 실제 draw/vertex/upload count와 관찰 interval/CPU 제출 시간이며 GPU 완료 시간으로 해석하지 않습니다.

## 작업과 리뷰

이 README와 모듈 문서가 저장소의 개발 기준입니다. 관련 열린 PR과 기존 변경을 먼저 확인하고 다른 작업을 보존합니다. 최초 저장소 등록 이후의 변경은 `claude/` 또는 `codex/` 작업 브랜치에서 진행하고 `main` 대상 PR로 리뷰합니다. 병렬 수정은 파일뿐 아니라 함수·상태 소유자·공통 계약·호출 관계의 겹침도 확인합니다.

개별 작업의 의도·담당·상태는 PR 본문에 관리하며 같은 계획을 여러 파일에 복제하지 않습니다. 변경 이유와 중요한 회귀 위험, 실제 검증 결과와 미검증 범위를 남깁니다. 코드 구현 완료와 패키지 공개 배포를 구분합니다. 검증을 마친 PR은 별도 승인을 묻지 않고 머지하는 것이 기본이며([AGENTS.md](./AGENTS.md)), 명시적인 사용자 지시 없이 배포 설정을 변경하지 않습니다.

문서와 커밋 메시지는 한국어를 기본으로 합니다. 식별자·API 이름·널리 쓰는 기술 용어는 원래 표기를 유지합니다.

```text
[타입] 변경 내용 요약

- 필요한 변경 이유와 검증 내용
```

기본 타입은 `[feature]`, `[bug-fix]`, `[refactor]`, `[performance]`, `[docs]`, `[test]`, `[chore]`이며 최초 등록은 `[init]`을 사용합니다.

## 참고

- [RALLY FRONTIER](https://github.com/byh-playground/rally-frontier): 게임·SDK·표현의 경계와 공통 작업 운영
- [Budmori.io](https://github.com/byh-playground/budmori-io): 최적화 우선, Definition, ms 시간, 실제 게임 E2E 기준
- [rollback-netcode 개발 계약](modules/rollback/CONTRACT.md): 결정론·명령·틱·snapshot·복구의 기준

게임별 README의 실행물 구성·길찾기·전투 규칙은 각 게임에 남깁니다. 이 저장소에는 함께 사용할 수 있는 공통 경계만 가져옵니다.
