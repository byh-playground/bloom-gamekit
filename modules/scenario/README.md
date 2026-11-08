# scenario

**HTML 실행 프리뷰:** [scenario](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/scenario.html)

실제 게임 실행을 재사용하는 독립 `scenario.js`. 시간 누적과 RAF 취소는 기존 simloop.createLoop를 번들에 포함해 재사용합니다. LocalInputPreview(넷코드 예측), replay(기록), deterministic(PRNG/codec), presentation-events(표현 자원), audio(재생)는 다시 구현하지 않습니다.

## Definition과 실행

`createScenario({definition,createRun,requestFrame?,cancelFrame?,canAdvance?,onEnd?})`.
Definition은 `{seed,tickRate,endTick,initialState?,scene?,timeline:[],loop:false}`입니다. timeline 항목은 tick 또는 atMs 중 하나를 명시하며 나머지는 게임 데이터입니다. ms는 최초 도달 고정 tick으로 올림합니다. 같은 tick은 선언 순서를 유지합니다. 0 tick은 초기화이며 1..endTick이 실제 step입니다. seed·초기 상태·장면·명령을 복제해 반복 중 게임 변경이 원본에 새지 않습니다.

createRun({seed,initialState,scene,signal,iteration})은 **격리된** 게임 인스턴스를 만들고 {initialize?,step,render?,pause?,isComplete?,dispose}를 반환합니다. initialize(frame)는 tick 0 명령을 처리하며 0 명령이 있으면 필수입니다. step(frame)은 게임의 실제 고정 업데이트를 한 번 실행합니다. frame은 {tick,timeMs,dtMs,events,iteration}이며 events 실행과 게임 내 순서는 게임이 결정합니다. render({tick,timeMs,alpha,iteration})는 시뮬을 진행하지 않습니다. 게임이 제공한 isComplete() 또는 endTick이 종료 조건입니다.

- play({automatic:true}): 초기 시작/일시정지 재개. 중복 실행 금지. ended는 restart 필요.
- pause(): 시뮬/RAF 중지, pause callback으로 오디오 해제.
- restart(options): 이전 scope abort/dispose 후 같은 정의로 새 실행.
- stop(): scope 자원까지 정리. 다음 play는 처음부터 시작.
- snapshot(), 읽기 전용 state: 실행 상태/tick/시간/반복 번호.
- dispose(): 영구 종료, 반복 호출 안전.
- play({automatic:false}) 뒤 step(): QA/출력용 정확한 한 tick. 자동 RAF와 혼용 금지.
- pulse(timestamp,{render:false}), render(): 외부 시간 펌프와 표시를 분리. 시뮬의 dt는 고정.

종료는 마지막 프레임을 유지하며 pause callback을 부릅니다. 반복은 이전 scope를 폐기하고 새 scope로 시작합니다. 숨김/긴 프레임 지연은 simloop의 backlog 정책을 따르며 놓친 tick을 가변 dt로 바꾸지 않습니다. 게임 결과는 같은 완료 tick에서 비교하세요.

`canAdvance()`는 선택 사항이며 기본값은 항상 true입니다. 비동기 Worker의 미처리 상태처럼 다음 고정 tick을 아직 보낼 수 없을 때 false를 반환하면 tick과 timeline은 진행하지 않지만 렌더는 계속됩니다. 자동 재생의 대기 시간은 simloop 기본 `drop` 정책에 따라 최대 한 tick만 보존하므로 준비 후 대기한 시간을 한꺼번에 처리하지 않습니다. 수동 `step()`도 false일 때 `{status:'held', tick}`을 반환하며 상태를 진행하지 않습니다. 이 콜백은 비동기 작업 자체를 실행하거나 완료를 보장하지 않습니다.

게임 factory는 저장소·입력·오디오·renderer를 본게임과 공유하면 안 됩니다. abort signal은 늦은 비동기 작업의 커밋 전에 확인하고 dispose에서 모든 게임 자원을 해제하세요. Runner는 factory 내부의 공유 전역/저장소 접근을 격리해 주는 sandbox가 아닙니다. Bounko는 iframe 게임 인스턴스를 사용합니다. 게임 PRNG 초기화와 완전한 world 복원은 게임 책임입니다.

## 선택적 영상

이번 모듈은 인코더를 포함하지 않습니다. 소비자가 실제 renderer canvas의 captureStream과 MediaRecorder 지원·isTypeSupported를 검사하고 별도의 녹화 수명주기를 연결할 수 있습니다. 녹화 종료 시 recorder와 stream track을 닫고 생성 URL을 해제하세요. 미지원 브라우저/코덱을 지원한다고 가정하지 않습니다. 프레임 정확한 오프라인 인코딩·실제 영상 파일 검증은 이번 범위 밖입니다.

[실행 예제](examples/index.html)와 `npm run test:execution`은 DOM 재생/일시정지/재시작/반복/종료와 실제 WebGL 출력을 연결합니다. 별도 전투/물리/카메라 엔진은 없습니다. timeline은 생성 시 정렬, 진행은 cursor 순회이며 빈 tick에 명령 목록을 복제하지 않습니다.

`npm run test:consumer`는 Bounko의 실제 공개 게임을 기본 대상으로 사용하며 `BOUNKO_URL`로 검증 서버를 지정할 수 있습니다. 외부 게임/라이브러리를 실제로 로드하므로 네트워크가 필요하며 build 포함 180초 상한입니다. 모바일/PC 직접 URL·이력·저장 불변·프리뷰·소개·전투 중 설정 복귀의 고정 흐름을 검사합니다.

## Live Showcase Host (in-game introductions)

`mountScenarioFrame({container,src,configure?,prepare?,timeoutMs?,timeoutAfterLoad?,loadMessage?,timeoutMessage?})`은 소개 화면이나 임베드 미리보기가 공유하는 iframe 생성·준비·취소·정리 경계입니다. `{frame,ready,dispose}`를 반환합니다. `configure(frame)`은 삽입 전 속성을 설정하고, `prepare({frame,loaded,signal})`은 삽입 전에 호출되므로 `postMessage` 리스너를 일찍 등록할 수 있습니다. `loaded`는 load 시 true, 취소 시 false를 반환하며, 기본 prepare는 load를 기다립니다. `ready`가 load보다 먼저 끝나더라도 `loaded`는 load 또는 취소까지 유지됩니다. `ready`는 준비 완료 시 true, `dispose()`로 취소되면 false를 반환합니다. 기본 제한 시간은 삽입부터 적용하며, 기존 소개 호스트처럼 `timeoutAfterLoad: true`를 지정하면 load 이후부터 적용합니다. 로드 실패·시간 초과·prepare 오류는 원본 예외를 전달하고 프레임을 제거합니다. `dispose()`는 여러 번 호출해도 안전하며 signal을 abort하고 프레임을 제거합니다. `prepare`가 등록한 이벤트와 자원은 signal 또는 소비자 dispose에서 해제해야 합니다. 동일 출처 검사·저장소 격리·렌더러 및 게임 수명주기는 소비자 책임입니다.

### 같은 문서에서 준비된 표면 재사용

`createScenarioSurface({ createSurface, prepare })`는 이미 준비한 표시 자원을 같은 문서의 여러 소개 장면에서 이어서 사용하는 선택적 호스트입니다.

- `createSurface()`는 첫 장면이 열릴 때 한 번 호출되며, 렌더링 DOM `element`와 소비자가 제공하는 자원, 선택적 `dispose()`를 동기 반환합니다.
- `host.mount({ container, scene, active: false })`는 이전 실행을 닫고 같은 `element`를 새 컨테이너에 붙입니다. 반환값은 `{ ready, setActive(active), dispose() }`입니다.
- `prepare({ surface, scene, signal })`는 표면을 붙인 뒤 호출되며 초기 일시정지 상태인 `{ play(), pause(), dispose() }`를 동기 또는 비동기로 반환합니다. `ready`는 준비가 완료되면 `true`, 교체 또는 닫기로 취소되면 `false`입니다. 준비 오류는 원본 예외로 거부됩니다.
- `setActive()`는 준비 중에도 원하는 재생 상태를 지정합니다. 같은 상태를 반복 지정해도 재생과 정지를 중복 호출하지 않습니다. 닫힌 장면의 준비가 늦게 끝나면 재생하지 않고 그 실행을 정리합니다.
- 장면의 `dispose()`는 실행을 멈추고 표면을 떼지만 준비된 표시 자원은 유지합니다. `host.dispose()`가 실행과 표면 자원을 모두 해제합니다.
- 소개의 권위 시뮬레이션과 저장은 본게임과 분리합니다. 자원 주입은 게임이 소유하고, 비동기 준비는 공유 표면에 쓰기 전에 `signal.aborted`를 확인해야 합니다. 장면별 정리는 다음 장면이 쓰는 공용 표면을 해제하거나 덮어쓰지 않습니다. 호스트는 저장소나 렌더러의 전역 상태를 격리하지 않습니다.

`modules/scenario/showcase-host.js` exports `installShowcase({ title, locale, launcher, playSelector, ready, durationMs, timeline, custom })` for public game introductions. `locale` is required and is `'ko'` or `'en'` (anything else throws a `TypeError`): the host owns its control text (pause, close, direct play, replay, time, status and error lines) in both languages, while `title` and the chapter captions in `timeline` are already-resolved strings from the game. The disposable iframe also gets `?lang=<locale>`, because an isolated demo does not read the page's saved language choice. The launcher and `#/showcase` open a full-screen, keyboard-accessible player. The iframe fills the entire browser viewport (including landscape and mobile views) and the scene remains visible under translucent top controls and a bottom gradient containing large chapter captions, primary direct-play, replay, progress, and time. This layout follows the Bounko in-game introduction instead of limiting gameplay to a centered preview card. Safe-area insets and minimum 44px controls remain supported. The host creates a disposable, same-origin iframe at `?showcaseDemo=1`, then uses this module's `createScenario` tick timeline to dispatch game-owned input. It exposes pause, replay, close/Escape, and direct-play. The game keeps its own simulation, physics, rendering, and effects. No static imitation of combat is performed by this host.

The host **does not own the iframe's authoritative tick**; it coordinates a normal game instance from outside. Unlike the Bounko integrated scenario adapter, its scripted demo is not a frame-exact deterministic replay. Consumers must provide game-specific scenes and observe actual results. They must neutralize persistent storage in the disposable frame **before** boot and ensure a parent run is paused or stays on the main menu. Every intro requires desktop/mobile browser verification. The product remains responsible for direct URL, help, first-play clarity and intro captions. The runner uses the normal `scenario` lifetime and does not introduce a second physics engine or game-state serializer.
