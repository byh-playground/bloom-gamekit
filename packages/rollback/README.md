# rollback

입력 확정·예측·동기적 롤백·검증된 snapshot 복구를 소유합니다.

공개 API: `createSession, RollbackSession, VERSION, PROTOCOL_VERSION, CHUNK_SIZE, MAX_TICK, profiles`. 외부 import가 없는 `dist/rollback.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

state history는 기존 full-copy snapshot ring이고 보관 예산·입력 정책은 그대로입니다. 요청된 FullCopy/NativeMemento/DirtyDelta/UndoLog/CheckpointDelta 전략은 이 이전에 구현하지 않았습니다. 공개 onEvent의 rollback은 load 이후 재실행 전에 발생하며 poll/advance가 반환되기 전에 재실행을 완료합니다. confirmedTick은 확정된 마지막 입력 tick이고 tick은 다음 실행 tick입니다.

`session.pace`는 할당 없는 공개 scheduling multiplier입니다. 기존 `session.metrics.pace` 및 전체 snapshot API는 유지합니다. `attachTransport`가 돌려주는 detach는 반복 호출해도 같은 subscription만 한 번 해제하고 재연결된 peer를 지우지 않습니다. session.close도 같은 해제 경계를 사용하며 지연된 이전 transport callback은 무시합니다.
