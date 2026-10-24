# scenario

**HTML 실행 프리뷰:** [scenario](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/scenario.html)

실제 게임 실행을 재사용하는 독립 `scenario.js`. 시간 누적과 RAF 취소는 기존 simloop.createLoop를 번들에 포함해 재사용합니다. LocalInputPreview(넷코드 예측), replay(기록), deterministic(PRNG/codec), presentation-events(표현 자원), audio(재생)는 다시 구현하지 않습니다.

## Definition과 실행

`createScenario({definition,createRun,requestFrame?,cancelFrame?,onEnd?})`.
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

게임 factory는 저장소·입력·오디오·renderer를 본게임과 공유하면 안 됩니다. abort signal은 늦은 비동기 작업의 커밋 전에 확인하고 dispose에서 모든 게임 자원을 해제하세요. Runner는 factory 내부의 공유 전역/저장소 접근을 격리해 주는 sandbox가 아닙니다. Bounko는 iframe 게임 인스턴스를 사용합니다. 게임 PRNG 초기화와 완전한 world 복원은 게임 책임입니다.

## 선택적 영상

이번 모듈은 인코더를 포함하지 않습니다. 소비자가 실제 renderer canvas의 captureStream과 MediaRecorder 지원·isTypeSupported를 검사하고 별도의 녹화 수명주기를 연결할 수 있습니다. 녹화 종료 시 recorder와 stream track을 닫고 생성 URL을 해제하세요. 미지원 브라우저/코덱을 지원한다고 가정하지 않습니다. 프레임 정확한 오프라인 인코딩·실제 영상 파일 검증은 이번 범위 밖입니다.

[실행 예제](examples/index.html)와 `npm run test:execution`은 DOM 재생/일시정지/재시작/반복/종료와 실제 WebGL 출력을 연결합니다. 별도 전투/물리/카메라 엔진은 없습니다. timeline은 생성 시 정렬, 진행은 cursor 순회이며 빈 tick에 명령 목록을 복제하지 않습니다.

`npm run test:consumer`는 Bounko의 실제 공개 게임을 기본 대상으로 사용하며 `BOUNKO_URL`로 검증 서버를 지정할 수 있습니다. 외부 게임/라이브러리를 실제로 로드하므로 네트워크가 필요하며 build 포함 180초 상한입니다. 모바일/PC 직접 URL·이력·저장 불변·프리뷰·소개·전투 중 설정 복귀의 고정 흐름을 검사합니다.

## Live Showcase Host (in-game introductions)

`modules/scenario/showcase-host.js` exports `installShowcase({ title, launcher, playSelector, ready, durationMs, timeline, custom })` for public game introductions. The launcher and `#/showcase` open a full-screen, keyboard-accessible player. The iframe fills the entire browser viewport (including landscape and mobile views) and the scene remains visible under translucent top controls and a bottom gradient containing large chapter captions, primary direct-play, replay, progress, and time. This layout follows the Bounko in-game introduction instead of limiting gameplay to a centered preview card. Safe-area insets and minimum 44px controls remain supported. The host creates a disposable, same-origin iframe at `?showcaseDemo=1`, then uses this module's `createScenario` tick timeline to dispatch game-owned input. It exposes pause, replay, close/Escape, and direct-play. The game keeps its own simulation, physics, rendering, and effects. No static imitation of combat is performed by this host.

The host **does not own the iframe's authoritative tick**; it coordinates a normal game instance from outside. Unlike the Bounko integrated scenario adapter, its scripted demo is not a frame-exact deterministic replay. Consumers must provide game-specific scenes and observe actual results. They must neutralize persistent storage in the disposable frame **before** boot and ensure a parent run is paused or stays on the main menu. Every intro requires desktop/mobile browser verification. The product remains responsible for direct URL, help, first-play clarity and intro captions. The runner uses the normal `scenario` lifetime and does not introduce a second physics engine or game-state serializer.
