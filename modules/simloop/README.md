# simloop

고정 논리 tick과 실제 시간 누적을 분리합니다. session capability를 받아 poll/advance/render를 조합합니다.

공개 API: `createLoop`, 선택 기능 `LocalInputPreview`. 외부 import가 없는 `dist/simloop.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

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

`createLoop`은 일반 입력 bytes 또는 `{input, commands:[{payload}]}` sample을 받습니다. 둘 다 **같은 getInput/sample 경로**에서 왔으며, packet의 각 command는 `session.queueCommand(payload)`로 한 번 제출하고 SDK가 반환한 원래 command sequence와 detached payload를 그 tick의 fork step context에 함께 전달합니다. input submission sequence와 SDK command sequence는 별도 namespace로 확인·보관합니다. commands가 있는 packet은 해당 session이 `queueCommand`를 제공해야 합니다. 기존 raw-bytes `getInput`은 그대로 동작합니다. pending 이력은 기본 최대 8개이며 tick horizon도 기본 8, 확인 snapshot의 유효 기간은 기본 250ms입니다. 초과·epoch 변경·큰 clock gap·blur·visibility 숨김·stop은 prediction을 지웁니다. load/reset/teleport/join/resync는 pending 입력을 버리고 새 checkpoint를 요구하며 rollback은 확인된 input/command sequence까지 제거한 뒤 나머지를 checkpoint부터 재생합니다. 재활성화와 lifecycle 이후에는 새로운 확인 checkpoint를 reconcile하세요.

`onAdvance(result, submission)`의 두 번째 값은 advanced tick에서만 `{sequence,tick,epoch,timeMs,commands}`를 제공합니다. 소비자는 자신의 authoritative confirmed tick/command maxima를 이 submission ID에 연결해 `reconcile({confirmedSequence,confirmedCommandSequence,...})`에 전달할 수 있습니다. 두 번째 인자를 사용하지 않는 기존 callback은 그대로 호환됩니다.

`PresentationRuntime`에 선택된 local identity만 즉시 preview schema model로 겹칩니다. 매 RAF에서 세계를 복제·재실행하지 않습니다. 입력 제출마다 fork를 한 번 증분 실행하고 authoritative 확인 때만 checkpoint clone/fork/replay를 합니다. 확인 capture는 기존 preview pose를 correction 출발점으로 사용해 공통 schema 곡선으로 잔차를 줄입니다. remote ID는 선택하지 않으면 authoritative track만 표시합니다. 원본 상태 대신 렌더 model을 직접 사용하며 preview 없는 객체를 위한 source fallback은 없습니다.

`metrics`는 추정 snapshot clone/correction bytes, replay 입력 bytes, clone/fork/replay/correction 시간을 구분합니다. `PresentationRuntime.previewMetrics`는 schema capture 시간과 선언-field/shape 기준 추정 capture bytes를 계측합니다. 이는 정밀 heap allocation/전송 bytes나 FPS 개선 증명이 아닙니다. preview OFF는 기존 input/session 경로를 그대로 쓰며, 선택 기능은 [실제 입력/WebGL 예제](../../examples/input-preview/index.html)와 browser E2E에서 별도로 확인합니다.
