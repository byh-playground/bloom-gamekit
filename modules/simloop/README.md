# simloop

고정 논리 tick과 실제 시간 누적을 분리합니다. session capability를 받아 poll/advance/render를 조합합니다.

공개 API: `createLoop`, 선택 기능 `LocalInputPreview`. 외부 import가 없는 `dist/simloop.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

`loop.pulse(timestamp, {render:false})`와 `loop.render()`로 timer pump와 rAF 표현을 분리할 수 있습니다. 기존 `pulse(timestamp)`는 계속 render를 호출합니다. `loop.render()`는 poll/advance/input 제출을 실행하지 않습니다. [RoomSession 예제](../rollback/examples/availability/index.html)는 단일 deadline scheduler와 rAF를 사용합니다. 숨김은 입력 해제이며, 큰 gap 뒤 timing을 초기화하고 RoomSession이 복귀 checkpoint를 처리합니다. 브라우저 freeze·OS suspend 중 실행을 보장하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

pulse(timestampMs)는 자동 rAF와 같은 누적·pacing·maxCatchupSteps 경계를 사용합니다. getInput/onAdvance/beforeFrame/canAdvance/render를 사용하고 게임에 또 다른 accumulator를 만들지 않습니다. start만 전역 blur/visibility listener를 설치하며 stop이 해제합니다.

## 실행 취소·pacing·backlog

- `stop()`은 현재 pulse의 남은 callback/추가 tick/render를 취소합니다. callback 안에서 stop/start해도 이전 세대가 새 rAF 체인을 만들지 않습니다. 나중에 직접 부른 `pulse()`는 stopped 상태에서도 실행됩니다.
- session의 공개 scalar `pace`를 우선 읽어 진단용 전체 `metrics` snapshot 할당을 피합니다. 기존 capability는 `metrics.pace` fallback을 유지하며 step 결정당 한 번 읽습니다. `RollbackSession.metrics`는 여전히 독립 snapshot입니다.
- `backlogPolicy: 'drop'`이 기본값입니다. `maxBacklogTicks`(기본 8틱)를 넘는 한 번의 clock gap은 backlog를 폐기하고 현재 시각을 새 기준으로 삼습니다. 작은 지연만 기존 250ms elapsed clamp와 maxCatchupSteps 경계 안에서 처리합니다.
- 명시적 `backlogPolicy: 'retain'`은 짧은 elapsed와 미처리 debt를 보존하지만 pulse당 maxCatchupSteps만 실행합니다. held/stalled/canAdvance=false에서도 debt를 유지합니다. `maxBacklogTicks`를 넘는 큰 지연은 여러 pulse로 replay하지 않고 `onBacklogDrop`을 호출한 뒤 버립니다. retain timestamp는 단조 증가해야 하며 safe millisecond 범위를 넘는 debt는 오류로 중단합니다.
- `onBacklogDrop({elapsedMs,droppedTicks,timestamp})`는 앱이 외부 driver의 `nextPulseAt`와 reconnect/resync 기준을 현재 시각으로 재설정할 수 있는 lifecycle 경계입니다. 게임 상태를 stale 클라이언트가 덮어쓰지 않도록 canonical snapshot 설치는 소비자 책임입니다.
- pause는 게임이 소유합니다. pause 전환과 resume에서 `resetTiming()`을 호출해 debt와 elapsed 기준을 지우면 pause 시간은 따라잡지 않습니다. `start()`도 timing을 초기화합니다. retain은 pause를 자동 추측하지 않습니다.

## 선택적 로컬 입력 미리보기

`loop.observeInput(timestamp)`가 권위 틱 전에 같은 `getInput()`을 관찰합니다. 자동 RAF loop는 프레임마다 이 경로를 사용하고, 외부 RAF와 deadline timer를 조합할 때는 RAF에서 observeInput, timer에서 pulse를 호출합니다. pulse는 관찰된 held bytes를 사용하며 명령을 canonical queue에 한 번만 제출합니다. 틱 사이의 held 변경은 하나의 미래 표본을 교체하고 edge 명령은 순서대로 축적합니다. provisional `observationId`와 `sequence:null`은 실제 SDK command sequence가 아닙니다. SDK queue 결과로 한 번 묶이고 `session.localInputState.capture`의 정확한 executeTick에서만 확인합니다. RoomSession의 metadata tick은 baseTick을 포함한 global tick입니다.

RAF가 deadline보다 느리거나 정지해도 pulse는 관찰 cache의 나이가 한 simulation quantum(`1000/tickRate` ms) 이상이면 canonical advance 전에 같은 observeInput/getInput 경로로 갱신합니다. quantum 안의 최근 관찰과 동일 timestamp는 재사용합니다. device edge의 수집·소비도 getInput 안의 이 단일 경로에서 수행해야 하며 별도 RAF collector를 중복 호출하지 않습니다. deadline fallback은 관찰만 추가하고 authority/command를 두 번 실행하지 않습니다.

`LocalInputPreview.observe()`는 별도 scope에서 같은 update로 미래 표본을 계산하고 `PresentationRuntime`는 그 표본을 schema/time으로 매 RAF 평가합니다. 동일 입력/명령 관찰은 캐시되어 fork를 실행하지 않습니다. 변경된 held 관찰은 기존 미래 한 틱을 다시 계산하며 RAF 수만큼 세계 시간을 증가시키지 않습니다. `fork.restore(snapshot)`를 제공하면 명시적 detached scope를 재사용합니다. 실제 authority에 snapshot을 설치하지 않습니다.

scope가 authority tick마다 전체 checkpoint를 다시 설치하지 않도록 선택적 `continueFromCheckpoint()`을 제공합니다. 게임은 `continuationKey`를 이전 snapshot 이후의 원격 입력·명령이 동일할 때만 재사용되는 정확한 stable key로 만들어야 합니다. API는 바로 전 authority tick에 예측 fork가 실행한 local input과 confirmed command sequence도 일치할 때만 snapshot 없이 경계를 확정하고, 하나라도 다르면 `false`를 반환해 일반 `reconcile(snapshot, ...)` fallback을 사용합니다. 이때 예측 branch가 예상한 다음 tick과 정확히 일치해야 하며 추정이나 hash 유사성만으로 이어가지 않습니다. confirm 이후 실제 입력 관찰은 현재 fork에서 이어서 한 번 실행합니다. 입력 변경으로 이전 미래 표본을 되감아야 하고 저장 snapshot이 오래됐다면 생성자에 전달한 선택적 `captureSnapshot()`을 불러 현재 권위 상태에서 rebase합니다. 변경된 remote key, 명령 미확정, revision/epoch/tick gap, rollback, pause 또는 lifecycle 전환은 fast continuation을 거부합니다.

`createDeadlineScheduler({getIntervalMs,pulse,maxBacklogTicks,onGap})`가 단일 timeout과 deadline cadence를 소유합니다. start/stop, wake(즉시 전달하되 deadline 유지), rebase(pause/resume/TPS 이후), running/deadlineMs를 제공합니다. 게임은 UI·persist·session gating만 결정합니다. 큰 gap은 미처리 deadline을 버리고 다시 기준을 잡으며 timer 지연과 게임 step을 선점할 수는 없습니다.

수동 deadline owner가 loop.start를 사용하지 않으면 자동 blur/visibility listener도 설치되지 않습니다. 그 owner의 기존 device/UI 해제 listener 다음에 window blur 및 document.hidden 경계에서 `loop.releaseInput()`을 호출하세요. 이 공개 API는 cached 관찰·SDK held input·preview를 함께 지우며 다음 pulse는 같은 getInput 경로에서 neutral을 다시 관찰합니다. UI command를 중복 제출하지 않고 별도 RAF loop를 시작하지 않습니다.

입력 지연·room baseTick으로 capture 사이의 실행 tick이 떨어져 있으면 그 간격도 실제 fork step으로 재생합니다. `reconcile({input,...})`에 게임이 확인한 baseline held bytes를 명시합니다(`localInputState.replayInput`이 현재 immutable frame을 알고 있으면 사용 가능). 없으면 gap prediction은 오류로 중단하며 입력이나 게임 규칙을 추측하지 않습니다. `executedInput`은 실제 step이 없었던 새 core에서는 null입니다. canonical command의 executeTick은 그대로 유지하고 provisional observation만 그 뒤의 제한된 미래 slot에서 평가합니다. gap tick도 maxFutureTicks와 비용 계측에 포함합니다.

게임이 `{input,commands,predict:false}`를 관찰하면 미확정 canonical command를 보존하면서 coalesced prediction slot을 해제합니다. idle/자동 실행 등 새 로컬 intent가 없을 때 매 authority tick마다 세계를 복제할 필요가 없으며, 다음 실제 intent에서 현재 완료 snapshot으로 rebase할 수 있습니다. `submit` 별칭은 제공하지 않습니다.

`LocalInputPreview`는 권위 simulation이 아니라, 앱이 준 확정 snapshot에서 만든 **명시적 detached fork**에만 `step(input, context)`를 호출합니다. 어댑터의 fork step은 기존 게임 update 함수를 재사용하고 모든 외부 효과를 억제해야 합니다. 라이브 session의 save/load 왕복, live closure, 행동 이름별 분기, DOM callback의 게임 로직 실행은 지원하지 않습니다. snapshot cloning/forking은 어댑터 경계에 있으며 실패해도 `createLoop`는 이미 수행한 단일 `session.advance(input)`을 취소하거나 두 번 제출하지 않습니다.

```js
const preview = new LocalInputPreview({
  createFork: detachedSnapshot => game.createDetachedSimulation(detachedSnapshot),
  readEntities: fork => fork.localRenderEntities(),
  presentation, // PresentationRuntime의 selectPreview/capturePreview capability
  maxPendingInputs: 8, maxFutureTicks: 8, maxAgeMs: 250,
});
preview.reconcile({ snapshot: confirmedSnapshot, revision, tick, epoch, confirmedSequence, timeMs, mode: 'reset' });
const loop = createLoop({ session, inputPreview: preview, getInput, render });
// 실제 확정 표본이 도착할 때 해당 detached checkpoint를 다시 제공
preview.reconcile({ snapshot, revision, tick, epoch, confirmedSequence, timeMs, mode: 'continuous' });
```

`createLoop`은 일반 입력 bytes 또는 `{input, commands:[{payload}]}` sample을 받습니다. 둘 다 **같은 getInput/sample 경로**에서 왔으며, packet의 각 command는 `session.queueCommand(payload)`로 한 번 제출하고 SDK가 반환한 원래 command sequence와 detached payload를 그 tick의 fork step context에 함께 전달합니다. input submission sequence와 SDK command sequence는 별도 namespace로 확인·보관합니다. commands가 있는 packet은 해당 session이 `queueCommand`를 제공해야 합니다. 기존 raw-bytes `getInput`은 그대로 동작합니다. pending 이력은 기본 최대 8개이며 tick horizon도 기본 8, 확인 snapshot의 유효 기간은 기본 250ms입니다. epoch/lifecycle reset·blur·visibility 숨김·stop은 prediction을 지웁니다. 큰 clock gap에서는 선택 capability의 `clockGap()`이 표시 preview만 해제하고, 다음 정확한 tick·input·remote continuation key 확인을 통과한 경우에만 기존 fork를 이어갑니다. 불일치하면 새 authority snapshot으로 rebase하고 `clockGap()`이 없는 capability는 기존처럼 clear합니다. load/reset/teleport/join/resync는 pending 입력을 버리고 새 checkpoint를 요구하며 rollback은 확인된 input/command sequence까지 제거한 뒤 나머지를 checkpoint부터 재생합니다. 재활성화와 lifecycle 이후에는 새로운 확인 checkpoint를 reconcile하세요.

`onAdvance(result, submission)`의 두 번째 값은 새로운 immutable capture에서 `{sequence,captureTick,executeTick,epoch,timeMs,commands}`를 제공합니다. held/stalled에서도 로컬 입력이 이미 capture될 수 있으므로 advanced 결과로 확인하지 않습니다. `reconcile`의 tick은 실제 snapshot boundary이며 그보다 앞에서 실행된 capture만 제거합니다. `confirmedCommandSequence`는 실행한 SDK command maxima입니다. `flushInput(timestamp)`는 suspended UI/save 명령을 같은 관찰·제출 경로에서 한 번 실행할 때 사용합니다.

`PresentationRuntime`는 선택된 local identity의 현재 표시에서 실제 fork 미래 표본까지 schema 곡선을 매 RAF 평가합니다. 입력이 바뀌거나 canonical 경계가 바뀔 때만 bounded restore/replay를 하고, 동일 held 관찰에는 저장한 미래 표본을 재사용합니다. remote ID는 선택하지 않으면 authoritative track만 표시합니다. timer/step callback은 협력형이며 거대한 게임 update를 하드 실시간으로 선점하지 않습니다.

`metrics`는 추정 snapshot clone/correction bytes, replay 입력 bytes, clone/fork/replay/correction 시간을 구분합니다. `PresentationRuntime.previewMetrics`는 schema capture 시간과 선언-field/shape 기준 추정 capture bytes를 계측합니다. 이는 정밀 heap allocation/전송 bytes나 FPS 개선 증명이 아닙니다. preview OFF는 기존 input/session 경로를 그대로 쓰며, 선택 기능은 [실제 입력/WebGL 예제](../../examples/input-preview/index.html)와 browser E2E에서 별도로 확인합니다.
