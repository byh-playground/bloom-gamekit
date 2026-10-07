# rollback

입력 확정·예측·동기적 롤백·검증된 snapshot 복구를 소유합니다.

공개 API: `createSession, RollbackSession, VERSION, PROTOCOL_VERSION, CHUNK_SIZE, MAX_TICK, profiles`. 외부 import가 없는 `dist/rollback.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

기본 rollback 모드의 state history는 기존 full-copy snapshot ring이고 보관 예산·입력 정책은 그대로입니다. 요청된 FullCopy/NativeMemento/DirtyDelta/UndoLog/CheckpointDelta 전략은 이 이전에 구현하지 않았습니다. 공개 onEvent의 rollback은 load 이후 재실행 전에 발생하며 poll/advance가 반환되기 전에 재실행을 완료합니다. confirmedTick은 확정된 마지막 입력 tick이고 tick은 다음 실행 tick입니다.

`session.pace`는 할당 없는 공개 scheduling multiplier입니다. 기존 `session.metrics.pace` 및 전체 snapshot API는 유지합니다. `attachTransport`가 돌려주는 detach는 반복 호출해도 같은 subscription만 한 번 해제하고 재연결된 peer를 지우지 않습니다. session.close도 같은 해제 경계를 사용하며 지연된 이전 transport callback은 무시합니다.

## 실행 모드: rollback / lockstep

같은 `createSession({ profile, adapter, ... })`에서 `profile.mode`를 선택합니다. 생략한 기존 profile과 `profiles.action`, `profiles.rts`의 기본값은 `rollback`입니다. `profiles.lockstep`은 이제 `mode: 'lockstep'`을 명시하며 매 tick snapshot 복사를 생략합니다. 실행 중 모드 변경은 지원하지 않습니다. 새 세션을 만들 때 선택하세요.

```js
const session = createSession({
  ...gameOptions,
  profile: { ...profiles.rts, mode: 'lockstep', checksumInterval: 20 },
  adapter: gameAdapter,
});
```

- `rollback`: 기존 예측·full-copy ring·재실행 정책을 유지합니다. `rollbackWindowTicks: 0`만 지정한 기존 profile도 매 tick snapshot을 저장하는 기존 동작입니다.
- `lockstep`: `rollbackWindowTicks`를 0으로 정규화합니다. 고정 roster 전원의 해당 tick 실제 입력(no-op 포함)이 오기 전에는 `stalled`이며 시뮬레이션을 실행하지 않습니다. 기다리기 전에 로컬 입력을 capture/send하고 초기 지연 구간을 neutral 입력으로 채우므로 delay 0과 양수 모두 부트스트랩할 수 있습니다. 예측 입력·평상시 rollback·used-frame history 복사가 없습니다. 손실 입력은 기존 ACK·재전송 경로로 회복하며 timeout/leave가 임의 진행을 허용하지 않습니다.
- 입력·명령은 기존 immutable sequence/tick 계약을 유지합니다. 이미 실행된 보관 중 확정 입력에 상충하는 새 값이 오면 `desync-unrecoverable`로 정지합니다. 만료된 패킷은 기존 bounded-window 정책대로 무시합니다.

### checkpoint, hash, replay와 비용

`checksumInterval`은 lockstep에서 **확정 checkpoint 직렬화와 checksum 교환 간격(tick)**입니다. 1 이상, `stateHistorySize` 이하이어야 합니다. 20 TPS에서 20은 최대 약 1초 후 상태 불일치를 발견하는 비용/검출 지연 선택입니다. 1이면 매 tick 검사 비용을 다시 지불합니다. 검증을 조용히 비활성화하지 않습니다.

`stateHistorySize`는 입력/ACK window로 유지합니다. snapshot은 초기 상태와 주기적인 확정 checkpoint만 저장합니다. window 이전/동일의 마지막 checkpoint 하나와 그 뒤 실제 입력도 보관하므로 복구 시 시작 상태 없이 입력만 남는 구멍이 없습니다. 상태 바이트 예산은 sparse checkpoint 수에 맞게 검사하며, `maxHistoryBytes`, `maxSnapshotBytes`, command/replay/송신 큐 예산은 계속 적용합니다. 단위는 snapshot 크기에 따라 달라지며 입력·replay 메모리가 없어지는 것은 아닙니다.

`adapter.save()`는 호출 순간의 완전한 canonical 상태를 반환해야 합니다. 매 tick 미리 만든 cache가 호출 전제여서는 안 됩니다. 생성, checkpoint, 명시적 `getStateHash()`/`exportReplay()`, 복구/예외 경로에서 호출될 수 있습니다. 게임의 수동 저장도 자신의 canonical 상태를 완료된 tick 경계에서 저장하며, 미확정 pending command를 임의로 실행한 뒤 저장하면 안 됩니다.

- `getStateHash()`는 현재 완료된 경계를 필요할 때 직렬화합니다. 같은 tick의 반복 호출은 cache를 쓰지만, 매 tick 호출하면 다시 매 tick 비용이 생깁니다. 과거 `getStateHash(t)`는 보관 checkpoint에만 값이 있고 나머지는 `undefined`입니다. 과거 상태를 현재 save로 대체하지 않습니다.
- `requestResync(t)`는 t 이하의 가장 가까운 보관 checkpoint로 요청을 내립니다. 없으면 false입니다. 기존 authority 검증·chunk 전송·원자적 candidate commit을 유지하고 그 뒤 실제 입력을 현재 tick까지 재실행합니다. 이 **복구 재실행**은 정상 플레이 rollback과 별개이며 `resimulating/recovering` 표시를 지킵니다.
- 실패한 step은 직전 checkpoint부터 확정 입력을 재실행해 원래 경계를 복원하고 fatal로 정지합니다. adapter가 복원 자체에도 실패하면 fatal에 restoreError를 포함합니다. 평상시 실패 대비 snapshot을 매번 만들지는 않습니다.
- replay schema와 codec은 그대로입니다. 최종 hash는 export 때 현재 경계에서 계산하고 replay 용량에 도달할 때는 마지막 기록 경계를 미리 hash하여 보존합니다. 완료된 입력만 기록하며 초기 상태 이후 replay로 재현합니다.
- `metrics.snapshotSaves`, `serializedSnapshotBytes`는 SDK 직렬화 횟수/바이트를 제공합니다. 기존 `retainedSnapshotBytes`, `stateHashComputations`, `hashedStateBytes`도 유지합니다. 이는 adapter 내부 할당/게임의 별도 저장 비용까지 측정하지 않습니다.

HELLO는 양쪽 mode를 명시하며 lockstep에서는 초기 `baseInputDelayTicks`, `checksumInterval`도 일치해야 합니다. rollback의 peer별 delay 설정 및 런타임 delay 적응은 유지합니다. packet framing과 replay version은 유지하지만 이 handshake 필드가 없는 이전 bundle과 새 bundle을 섞으면 시작을 거절합니다. 함께 플레이할 소비자는 같은 검증된 dist pin으로 업데이트하세요.

## 확정 bootstrap과 bounded catch-up

`session.exportConfirmedBootstrap()`은 실행 중인 lockstep의 **현재 확정 경계**만 내보냅니다. rollback 모드, 복구/재실행 중, 실패/종료된 세션은 거절합니다. 반환값의 `version`은 1이며 `tick`, `checkpoint: { tick, bytes, hash }`, `players`, `frames`, 최종 `hash`, `inputSize`, `tickRate`, `simulationVersion`, `seed`를 포함합니다. checkpoint는 현재 tick 이하의 가장 가까운 보관 경계이고 suffix는 그 뒤 실행한 실제 입력만 포함합니다. 예측 입력과 아직 실행하지 않은 미래 명령은 넣지 않습니다.

- `frames`는 checkpoint tick부터 현재 tick 직전까지 연속하며 길이는 `checksumInterval` 이내입니다. checkpoint 경계에서는 빈 배열입니다.
- snapshot과 입력/명령 바이트는 복사하므로 호출자가 반환값을 바꾸어도 기존 Core는 바뀌지 않습니다.
- 평상시 tick의 직렬화 횟수는 늘어나지 않습니다. export할 때 checkpoint hash와 현재 완료 경계의 snapshot/hash가 필요하며, 같은 경계의 반복 요청은 Core cache를 사용합니다. 매 tick export하면 그만큼 저장/해시 비용을 다시 지불합니다.
- `createBootstrapReplay({ adapter, bootstrap, maxCatchupSteps: 8 })`는 후보를 검증하고 checkpoint를 load한 뒤 job을 반환합니다. `pulse()`마다 최대 지정한 tick 수를 동일 `runSimulationFrame` 경로로 실행합니다. 스케줄·렌더·전송은 호출자의 책임입니다.

```js
import { createBootstrapReplay } from './rollback.js';

const job = createBootstrapReplay({
  adapter: joiningGameAdapter,
  bootstrap,
  maxCatchupSteps: 4,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxSuffixTicks: 20,
  simulationVersion: 'game-v1',
});

// 렌더 루프가 pulse를 한 번씩 호출한다. while로 끝까지 밀어 실행하지 않는다.
function catchupPulse() {
  const result = job.pulse();
  if (result.status === 'done') console.log(job.result.tick, job.result.hash);
}
```

job은 `tick`, `targetTick`, `status`, `done`, `result`, `failure`를 공개합니다. `pulse()` 결과의 `steps`는 이번 호출의 실제 재실행 수이고 완료하면 `hash`도 있습니다. frame에는 `resimulating`, `recovering`, `replaying`이 true로 전달되므로 게임은 표현 이펙트를 중복 발생시키지 않아야 합니다. bootstrap tick은 Core의 로컬 tick입니다. epoch 기준 tick을 쓰는 게임은 adapter 경계에서 변환하며 RoomSession은 이를 제공합니다.

후보의 version·roster/순서·연속 tick·확정 입력·command sequence/executeTick·크기와 checkpoint hash를 load 전에 검사합니다. `simulationVersion`, `inputSize`, `tickRate`, `players`, `seed` 옵션은 기대값 대조에 사용합니다. `maxSnapshotBytes`, `maxSuffixTicks`, `maxCommandBytes`, `maxPendingCommands`, `maxReplayBytes`는 후보 보관 한도이고, maxReplayBytes는 checkpoint와 suffix의 추정 바이트 합을 제한합니다. suffix는 최대 8,192 tick, snapshot은 최대 64 MiB입니다. 수신측에는 송신측 profile과 맞는 한도를 넘겨야 합니다.

load 후 checkpoint의 canonical round-trip과 최종 snapshot의 hash/`validateSnapshot`을 검사합니다. load/step/final 검증 실패는 job 생성 전 snapshot으로 복원하고 throw합니다. 진행 중 `cancel()`도 원래 snapshot으로 복원합니다. 완료된 job의 cancel은 완료 상태를 유지합니다. adapter 자체가 복원에도 실패하면 원래 실패와 복원 실패를 함께 보고합니다. job이 진행 중인 동안 같은 adapter를 다른 시뮬레이션에서 step하지 마세요. 이 rollback 보장은 성공적으로 완료한 뒤 별도 게임 동작까지 되돌리는 기능은 아닙니다.

## epoch 사이 로컬 명령 보존

`session.exportLocalCommandState()`는 `{ sequence, lastInput, commands }`를 복사합니다. 현재 tick 이후에 이미 capture된 로컬 frame과 아직 대기 중인 queue에서 **미실행 명령만** 모아 sequence 순으로 중복을 제거합니다. 이전 epoch의 executeTick은 버리고 payload와 stable sequence를 보존합니다.

새 `createSession({ ..., localCommandState })`에 이 값을 전달하면 다음 명령의 sequence가 이어지며, 미실행 명령은 새 epoch의 입력 delay에 맞춰 다시 capture됩니다. 초기 delay 구간은 그대로 neutral이고 `advance()`의 기본 입력은 넘겨받은 lastInput입니다. 세계 snapshot을 load하거나 membership을 적용하는 것은 이 옵션의 역할이 아니며 게임/RoomSession이 먼저 그 경계를 준비해야 합니다.

명령 전체가 한 tick에 실행된다고 가정하면 안 됩니다. 기존 frame 바이트 한도와 `maxPendingCommands` 개수 한도 안에서 차례로 나누어 capture합니다. handoff는 미래 delay frame과 대기 queue를 합한 기존 용량만 허용하고, 보존된 대기 명령 수가 일반 queue 한도 이상이면 새 `queueCommand()`는 이전 명령이 빠질 때까지 capacity 오류를 반환합니다. 이미 실행한 명령은 다시 넘기지 않으며, 새 epoch에서도 명령을 실행할 때의 tick은 해당 adapter context와 같습니다.

`getCommandSequences()`와 bootstrap의 `commandSequences`는 현재 roster 전체의 **이미 실행한** sequence 최대값을 `{ [playerId]: sequence }`로 복사합니다. 아직 capture된 미래 명령이나 대기 명령은 포함하지 않으며 값이 없으면 0입니다. checkpoint 이후 suffix에 명령이 하나도 없어도 마지막 실행 sequence를 유지하므로 reload한 플레이어가 이전 이벤트 ID를 재사용하지 않습니다. 새 Core의 `initialCommandSequences`에는 새 roster의 모든 ID와 baseline을 넘깁니다. 로컬 다음 sequence는 이 baseline부터 이어지며, 함께 넘긴 localCommandState의 sequence는 baseline 이상, 미실행 명령은 baseline보다 커야 합니다. live 세션의 아직 실행하지 않은 명령 보존과, reload 클라이언트의 이미 실행한 sequence 복원은 서로 다른 입력이며 RoomSession이 epoch 경계에서 조합합니다.

## 동적 방 세션: 같은 세계, 바뀌는 roster

`createRoomSession`/`RoomSession`은 기존 lockstep Core를 epoch마다 조합합니다. 게임 세계를 새로 시작하거나 서로 다른 싱글/온라인 시뮬레이터를 만들지 않습니다. `mode: 'local'`은 전송 없이 1명, `mode: 'online'`은 transport의 `createNostrDynamicRoom` capability를 받습니다. 정원은 `membership.maxPlayers`(기본 5, 범위 1–8)입니다. 기존 `createSession`, 고정 `createNostrGroupRoom`, rollback 모드의 API는 유지합니다.

```js
const session = createRoomSession({
  mode: room ? 'online' : 'local', room,
  simulationVersion: 'my-game-rules-v1', seed: 1, inputSize: 8,
  profile: { ...profiles.lockstep, baseInputDelayTicks: room ? 2 : 0 },
  membership: { maxPlayers: 5, transitionTimeoutMs: 15000,
    reconnectGraceMs: 10000, maxCatchupSteps: 4 },
  adapter: {
    save, load, validateSnapshot, step,
    applyMembership({ epoch, tick, players, joined, left, coordinatorId, reason }) {
      // canonical state만 변경합니다. spawn/despawn/재화/정책은 게임 소유입니다.
      // appliedMembershipEpoch와 playerId→entity 매핑도 save/load에 포함합니다.
    },
  },
});
```

`advance`, `poll`, `queueCommand`, `releaseInput`, `getStateHash`, `getPeerState`, `tick`, `confirmedTick`, `profile`, `pace`, `resimulating`, `failure`, `metrics`는 기존 loop capability와 연결됩니다. `tick`과 `adapter.step().tick`, command executeTick은 방 전체에서 단조 증가합니다. `membershipEpoch`는 step에 추가됩니다. Core 내부 tick 0 재생성은 게임 tick/세계 초기화가 아닙니다. 캡처했지만 아직 실행하지 않은 명령은 payload와 sequence를 보존해 새 epoch로 넘깁니다. held input도 이어집니다. 표현 이벤트는 `(playerId, command sequence)` 또는 `(global tick, game event sequence)`처럼 안정적인 키를 사용하세요.

### 합의된 경계와 정확한 callback 계약

1. coordinator가 한 번에 한 roster 변경만 제안합니다. 기존 참가자가 즉시 멈추고 모든 연결이 준비되면 그중 가장 앞선 tick을 공통 barrier로 선택합니다.
2. 기존 roster 전원이 그 tick까지 기존 실제 입력으로 실행하고 동일한 상태 hash를 확인합니다. 새 참가자는 아직 입력을 제출하거나 게임 actor를 소유하지 않습니다.
3. 새 참가자에게만 최근 sparse checkpoint와 그 뒤 확정 입력 suffix를 RTC reliable channel로 전송합니다. `poll` 한 번의 catch-up은 `membership.maxCatchupSteps` 이하입니다. 전체 세계를 매 tick 직렬화/방송하지 않습니다.
4. 모든 참가자가 같은 `applyMembership`을 canonical boundary에서 실행해 다음 snapshot을 준비하고 hash를 비교합니다. 준비 중에는 기존 snapshot으로 복원하며, commit 때 준비된 완전한 snapshot을 원자적으로 load합니다. 따라서 callback은 외부 effect/UI/음향/네트워크를 실행하면 안 됩니다. commit 알림은 `membership-committed` observer로 받습니다.
5. 전원 hash 일치와 commit 전달 확인 뒤 새 epoch 입력을 받습니다. 새 참가자의 callback은 가져온 기존 플레이어를 다시 spawn하지 않습니다. `joined`만 새 actor를 만들고 `left`에 대한 게임 정책을 적용하세요. initial callback은 host/local에만 있고, 새 참가자는 snapshot에 포함된 이전 membership을 반복 호출하지 않습니다.

서로 다른 gameplay 설정은 `simulationVersion`에 포함하거나 그 digest를 version에 넣어야 합니다. SDK는 version/seed/inputSize/TPS/input delay/checkpoint interval/정원도 검증합니다. duration 설정 단위는 ms, checkpoint/입력 이력은 tick입니다. 공개 방 선택/지역/자리 UX와 전투·랜덤 지역 spawn은 이 세션의 책임이 아닙니다.

### 퇴장, 복구, 분할 정책

`await session.leave()`는 합의된 퇴장입니다. 기존 coordinator가 나가면 같은 commit에서 남은 정렬 roster의 첫 ID로 coordinator를 넘깁니다. 살아 있는 세계와 tick은 유지됩니다. `close()`는 즉시 자원 정리이며 합의된 퇴장의 대체가 아닙니다. 평상시 Exit는 leave를 사용하세요.

끊긴 RTC는 같은 identity의 새 transport로 교체할 수 있습니다. 연결이 돌아올 때까지 lockstep은 누락 입력을 임의 no-op로 만들지 않습니다. 유예를 넘긴 partition은 `partition-failed`로 정지합니다. 정족수 없는 독립 선출·개별 timeout 강퇴·분할된 두 세계의 지속 실행은 하지 않습니다. 합의/전송/접속은 명시적인 deadline과 capacity를 넘기면 실패합니다. 정상 퇴장 중 누군가 응답하지 않는 경우도 무조건 성공했다고 보고하지 않습니다.

진행 중인 transition에서는 명령을 정상 queue할 수 있지만 새 참가자는 admission 완료 전 queue할 수 없습니다. 동시에 도착한 admission은 정원 이내의 bounded FIFO에서 순서대로 처리하며, 기다리는 참가자는 새 proposal 전 현재 확정 roster/epoch를 전달받습니다. 정원 초과와 deadline 만료는 명시적으로 거절하며, 초기 RTC join 요청만 `membership.joinRetryMs`(기본 500ms) 간격으로 입장 deadline까지 멱등 재전송합니다. 외부 매칭 정책은 제한된 재시도나 다른 방 선택을 결정합니다. epoch는 0–65534이고 소진되면 명시적으로 실패합니다.

### 비용과 검증 범위

정상 실행에서는 원래 sparse checkpoint 빈도를 유지합니다. membership마다 pre/post snapshot, 신규 참가자 catch-up, 새 Core의 초기 snapshot이 추가됩니다. `metrics.snapshotSaves` 등은 epoch별 Core 합계이고, membership staging/codec 전송 비용을 전부 포함하는 CPU 수치가 아닙니다. `bootstrapBytes`, `bootstrapTicks`, control 송수신/보관 바이트는 별도입니다. 외부 `getStateHash()`를 매 tick 부르면 그 직렬화 비용은 다시 발생합니다.

`modules/rollback/tests/room-session.test.mjs`는 실제 Core와 in-memory transport의 연속 1→2→5/퇴장/복구/분할 검사입니다. `modules/rollback-netcode/tests/dynamic-browser.mjs`는 signed local Nostr relay fixture와 실제 Chromium RTC mesh의 같은 순서를 검사하며 CI browser suite에 포함됩니다. 전자는 실제 RTC 검증이 아니고, 후자도 공용 relay/NAT/실기기 모바일 성능 보장이 아닙니다. 서버 없는 방은 마지막 참가자가 사라진 뒤 세계를 보존하지 않습니다. 32-bit 상태 hash는 버그 감지용이며 악의적 peer에 대한 인증·치트 방지 보장이 아닙니다.

RoomSession의 전체 여러 epoch replay 파일 export는 아직 제공하지 않습니다. 기존 고정 Core의 replay API는 유지하고, 동적 입장/복구에는 명시적인 checkpoint+suffix만 사용합니다.


### 새로고침 재접속

transport에 opt-in `resume: { storage: sessionStorage, key, lifetimeMs }`를 주면 같은 탭의 room-scoped 서명 identity를 복원할 수 있습니다. storage 수명/증명/중복 탭 충돌 계약은 transport 문서를 따릅니다. RoomSession은 `room.resumed`를 보고 초기 actor 생성 대신 같은 roster의 `reason: 'reconnect'`, `joined: []`, `left: []` epoch를 준비합니다. coordinator 새로고침도 살아 있는 member가 discovery/상태 donor를 제공하며 coordinator를 임의로 바꾸지 않습니다.

이미 멈춘 peer들의 실행 경계가 다를 수 있으므로 가장 앞선 확정 tick의 살아 있는 peer를 donor로 선택하고, 전원에게 그 checkpoint+확정 입력 suffix를 검증·bounded replay합니다. 새 epoch의 global tick은 모두의 이전 경계 이상입니다. donor가 이미 실행한 local command는 다시 queue하지 않고, player별 실행 command sequence baseline도 복원합니다. 임시 로컬 UI 입력·아직 어디에도 확정되지 않은 브라우저 내 queue는 새로고침으로 복원되지 않습니다.

게임은 기존 canonical actor/진행 상태를 유지합니다. 새 방에 개인 save를 넣거나 종료된 방의 세계를 되살리는 기능은 아닙니다. 살아 있는 donor 없음, identity 만료, 정상 연결이 살아 있는 중복 탭, 복구 timeout은 명시적으로 실패합니다. partition 유예가 끝나 세션이 이미 실패한 뒤 복구한다고 약속하지 않습니다.

## 준비된 snapshot 경계와 비용

기존 `save/load/validateSnapshot/applyMembership` 어댑터는 그대로 동작합니다. 큰 게임은 다음 선택적 capability를 쌍으로 제공할 수 있습니다.

- `prepareSnapshot(bytes, context)`는 비신뢰 bytes의 크기·형식·정규성·게임 schema·tick·epoch·roster를 모두 확인하고, 외부에서 수정할 수 없는 owned decoded state의 일회용 token을 반환합니다. 실패하면 throw하며 live simulation은 변경하지 않습니다. token은 정확한 canonical bytes, schema와 context에 귀속합니다.
- `loadPreparedSnapshot(token, context)`는 같은 어댑터가 만든 token과 정확히 일치하는 context만 허용합니다. 성공 시 token을 소비하여 이미 준비한 객체·Map·공간 참조를 원자적으로 설치합니다. 재사용·다른 epoch·다른 schema의 token은 거부해야 합니다. 설치된 상태의 `save()` 결과가 준비한 bytes와 같아야 합니다.
- `prepareMembership(change, context)`는 합의된 tick에서 detached owned state에만 roster 변경을 적용합니다. 완전한 게임 검증 후 `{ bytes, prepared }`를 반환합니다. 완료·실패 모두 기존 live state와 참조를 유지해야 합니다. 게임은 공유 mutable 객체를 숨겨서 재사용하지 않습니다. `context`에는 전역 tick, `membershipEpoch`, `simulationVersion`, tickRate, seed, 새 players가 들어갑니다.

SDK는 준비 bytes를 자체 소유하고 hash를 계산합니다. 모든 참가자의 installed/hash가 일치하기 전에는 token을 설치하지 않습니다. commit에서 token을 한 번 소비한 뒤 같은 bytes/hash를 새 Core의 초기 sparse checkpoint에 내부 전달하므로 경계 직후 다시 전체 save/hash하지 않습니다. 이 내부 경로는 공개 SessionOptions에 검증 우회 옵션을 추가하지 않습니다. prepared token은 wire·replay·공개 bootstrap 결과에 포함하지 않습니다.

prepared bootstrap은 이미 검증한 token의 정확한 설치 계약을 사용하여 decode→validate→load→save 정규성 검사의 반복을 없앱니다. suffix가 비어 있으면 동일 canonical checkpoint를 최종 상태로 재사용합니다. suffix가 있으면 기존 최종 hash/게임 검증을 수행합니다. legacy 어댑터의 load/round-trip 검사는 유지합니다. 원래 상태의 취소/실패 복원도 유지합니다.

`createBootstrapReplay`의 `maxCatchupMs` 기본값은 8ms이며 `maxCatchupSteps`와 함께 **완료된 tick 사이**에서 확인합니다. 개별 동기 step/save/load/codec을 선점하지 않으며, 이를 8ms 이하 전체 작업 보장으로 해석하지 않습니다. RoomSession metrics의 `membershipPrepareMs`, `membershipCommitMs`, `maxBoundaryTaskMs`, `boundaryLongTasks`는 실제 동기 경계 CPU 시간과 50ms 초과 관찰 횟수입니다. 게임의 매 tick deepcopy나 Worker는 추가하지 않습니다.

### 실제 cooperative job

`saveJob()`, `prepareSnapshotJob(bytes, context)`, `prepareMembershipJob(change, context)`를 제공하면 SDK가 각 단계의 job을 pulse로 진행합니다. job은 `pulse({budgetMs})`, `done`, `result`, `cancel()`을 제공하며, 결과는 각각 bytes, 준비 token, `{bytes, prepared}`입니다. factory 자체도 긴 동기 작업을 하지 않아야 합니다. SDK가 함수 호출 중간을 선점할 수 없으므로 게임은 clone·대형 문자열·typed array·검증 순회를 실제로 나누어 구현해야 합니다.

bootstrap은 checkpoint hash → 이전 상태 save job → 후보 prepare job → 원자적 install → replay → 최종 save job → hash → 최종 prepare 검증 순서로 진행합니다. checkpoint/hash 검사는 64KiB 조각으로 나눕니다. 빈 suffix는 재검증 없이 검증된 checkpoint를 그대로 사용합니다. membership은 준비 job과 hash가 끝나야 installed를 전송하며, 합의 후에만 설치합니다. RoomSession의 `membership.snapshotBudgetMs` 기본값은 8ms입니다.

job이 활성화된 동안 SDK는 합의 경계의 live tick뿐 아니라 이전 Core의 수신/복구/poll도 중지합니다. 다음 epoch 패킷의 기존 제한된 버퍼는 유지합니다. 그러므로 살아 있는 가변 상태를 여러 tick에 걸쳐 혼합 직렬화하지 않습니다. 취소/실패는 job을 취소하고, bootstrap이 이미 설치된 경우 원래 snapshot으로 복원합니다. 오류 경로 복원의 legacy `load`, wire envelope encode/decode, Core의 최초/주기 checkpoint save, 단일 replay tick은 여전히 동기입니다. 이 구간과 copy/GC 때문에 8ms 목표나 50ms 미초과를 보장하지 않습니다. `bootstrapPrepareMs`/`bootstrapPulseMs`도 경계 long-task metrics에 포함합니다.

검증은 동일 1→5 합류·pending commands·재연결·guest/coordinator refresh·정상 coordinator 퇴장 흐름에 legacy/prepared/job 경로를 연결합니다. Chromium RTC fixture도 같은 시나리오를 legacy와 cooperative adapter로 실행합니다. 작은 fixture의 deferred job은 프로토콜 검증용이며 대형 게임 codec 성능 증거는 소비 게임의 별도 실제 측정입니다.
