# presentation-events

실제 게임의 hit/damage text·particle·SFX를 위한 자원 journal입니다. 시뮬레이션 history나 gameplay 이벤트 생성기는 아닙니다. tick은 순서, nowMs/durationMs는 표현 시간입니다.

`new PresentationEventQueue({adapters,retentionTicks=120,maxPending=100000,nowMs=0})`의 adapters는 kind별 `{start(event,nowMs),reversible?,stop(handle,reason,event)?,update(handle,ageMs,event)?,reconcile(handle,newEvent,oldEvent,nowMs)?,confirm(handle,event)?}`입니다. start가 반환한 자원을 후속 hook에 전달합니다.

`emit({tick,sequence,entityId,generation,kind,payload,policy='confirmed',durationMs?})`는 새 identity일 때 true입니다. identity는 JSON tuple [origin tick, per-entity sequence, entity ID, generation, kind]이며 문자열 연결 충돌이 없습니다. payload는 게임 소유의 불변 데이터로 전달하세요. sequence와 generation은 재실행에서 동일해야 하며 render 순서나 랜덤값으로 만들면 안 됩니다.

- 기본 confirmed는 실제 confirmation 이후에만 start합니다. 재생한 소리는 취소해도 이미 들린 부분을 되돌릴 수 없으므로 one-shot SFX는 이 정책을 쓰세요.
- speculative는 reversible=true와 stop이 있는 adapter만 허용합니다. start는 즉시, 동일 identity의 재실행은 reconcile만 호출합니다. 만료된 이벤트도 tombstone을 남겨 다시 재생하지 않습니다.
- `beginRollback(fromTick)` 후 재실행 emit을 받고 `endRollback()`하면 재등장하지 않은 예측 자원을 취소합니다. 이미 확정한 tick의 rollback과 중첩 rollback은 거부합니다. 취소 identity가 이후 유효한 resim에서 돌아오면 새 자원으로 재개합니다.
- `confirmThrough(tick)`은 단조 증가합니다. `update(nowMs)`도 단조 증가하며 만료/adapter update를 처리합니다. `finish(event)`는 자연 종료 자원을 정리하면서 dedup identity는 유지합니다.
- GC는 confirmedTick−retentionTicks 이하이면서 종료된 기록만 지웁니다. 그 이하의 늦은 emit은 거부합니다. 활성 장기 자원과 미확정 기록은 버리지 않습니다. maxPending 초과는 throw해 backpressure를 드러내며 실제 hit를 조용히 누락하지 않습니다. 게임은 확인 진행·활성 자원 수명·capacity를 설정해야 합니다.
- `dispose()`는 모든 자원을 정리하고 집계 오류를 반환하며 반복 호출은 안전합니다. replay seek/새 세션은 dispose 후 새 journal로 epoch를 분리합니다.

## 실제 SDK 연결

기존 SDK의 `adapter.step({tick,inputs,resimulating,recovering,replaying})`에서 게임이 이벤트를 생성합니다. `onEvent({type:'rollback',tick})`은 상태 복구 후 resim 전에 발생하므로 beginRollback을 연결하고, 동기 `poll()/advance()`가 반환한 뒤 endRollback을 호출합니다. 확정은 `Math.min(session.confirmedTick,session.tick-1)`가 0 이상일 때 confirmThrough합니다. SDK에는 rollback-end callback이 없습니다.

recovering 후보의 이벤트는 게임이 임시 저장하고 성공한 recovered 이후에만 journal에 전달해야 합니다. 실패한 recovery나 replay 검사용 step에서 실제 외부 자원을 만들면 안 됩니다. 이 모듈이 SDK private 상태나 별도 history를 읽지 않습니다.

Budmori의 tick별 effect/damage feedback과 [Rally f6037f05](https://github.com/byh-playground/rally-frontier/tree/f6037f05)의 confirmed presentation journal 경계를 참고한 신규 구현입니다. 원본 게임의 효과·아트·라이선스를 복제하거나 바꾸지 않습니다.

종료된 confirmed 자원은 payload/handle 참조를 즉시 해제하고 identity-only tombstone만 보관합니다. durationMs:0은 start 직후 만료하므로 큰 actor clone을 보관하지 않는 순간 feedback adapter에 적합합니다. frame update는 active Set만 순회하며 retained tombstone 전체를 매 frame 스캔하지 않습니다. confirmation/rollback은 해당 시점의 journal을 순회합니다. 새 이벤트·identity 문자열·map record는 할당되므로 0-allocation이라고 부르지 않습니다.
