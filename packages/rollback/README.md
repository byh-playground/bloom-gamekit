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
