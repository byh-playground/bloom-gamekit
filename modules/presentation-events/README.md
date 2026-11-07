# presentation-events

실제 게임의 hit/damage text·particle·SFX를 위한 자원 journal입니다. 시뮬레이션 history나 gameplay 이벤트 생성기는 아닙니다. tick은 순서, nowMs/durationMs는 표현 시간입니다.

`new PresentationEventQueue({adapters,retentionTicks=120,maxPending=100000,nowMs=0})`의 adapters는 kind별 `{start(event,nowMs),reversible?,stop(handle,reason,event)?,update(handle,ageMs,event)?,reconcile(handle,newEvent,oldEvent,nowMs)?,confirm(handle,event)?}`입니다. start가 반환한 자원을 후속 hook에 전달합니다.

### 표시 시계에 맞춘 이벤트

위 기본 모드는 확정 또는 예측 시 즉시 시작하고 `update(nowMs)`의 단조 벽시계로 수명을 진행하는 기존 계약입니다. 위치 보간과 효과를 같은 표시 시뮬레이션 시각에 맞춰야 하는 소비자는 `display: { stepMs, maxLatenessMs }`를 명시하고 각 렌더 프레임에서 **같은** `PresentationRuntime.frame(now)`을 `queue.present(frame)`에 전달합니다. `stepMs`는 배속과 무관한 기본 한 틱의 시뮬레이션 밀리초이며 `maxLatenessMs`는 소비자가 정한 유한한 최대 표시 지연입니다. 이 모드의 `update(nowMs)`는 확인 즉시 전달하는 제어 피드백의 단조 벽시계만 갱신하며 표시 자원의 나이와 수명은 `present(frame)`만 진행합니다. 두 시각의 값을 서로 비교하거나 빼지 않습니다.

네트워크 협상 후 실제 틱 간격을 알게 되는 소비자는 생성 시 display를 생략하고 첫 이벤트 발행·첫 권위 확정 전에 `configureDisplay({ stepMs, maxLatenessMs, classify? })`를 한 번 호출할 수 있습니다. 이미 이벤트나 확인이 있었거나 정책을 다시 설정하려 하면 원본 journal을 바꾸지 않고 오류를 냅니다. `classify(event)`는 선택 사항인 소비자 소유의 순수 동기 함수로 `{ delivery, durationMs? }`를 반환합니다. 기본 `delivery: 'presentation'`은 아래 표시 시계에서 시작합니다. 즉시 보여야 하는 일시적 제어 피드백에는 `{ delivery: 'confirmation', durationMs: 0 }`을 반환하여 권위 확인 즉시 한 번 전달할 수 있습니다. 즉시형은 confirmed one-shot만 허용하며, `durationMs: Infinity`는 display classifier에서 composite resource의 명시적 `finish()` 용도로 사용할 수 있습니다. 이벤트 종류 판단은 게임 adapter가 소유하며 Queue에 게임별 분기를 넣지 않습니다. 분류가 오류를 던지거나 유효하지 않으면 event identity·상태를 바꾸기 전에 원본 오류를 전달합니다. 같은 identity의 delivery 정책을 중간에 바꾸는 것은 허용하지 않습니다.

`setPresentationActive(false)`는 화면이 보이지 않을 때 **표현 전용 자원만** 중단하고 미표시 confirmed visual event를 소비합니다. 이후 hidden 상태의 confirmed visual event도 재생하지 않으며, 확인 watermark·시뮬레이션·리플레이 기록은 변경하지 않습니다. `confirmation` 일시 제어 피드백은 비활성 중에도 기존처럼 확인 즉시 전달됩니다. `setPresentationActive(true)` 다음 현재 표시 프레임을 제공하면 새 이벤트부터 표시합니다. 일시정지에서 효과를 보존해야 한다면 이 API를 사용하지 말고 표시 시계의 rate를 0으로 유지하세요. 숨김 중 미확정 예측 이벤트는 확정 전 rollback으로 취소·복구할 수 있으며, 안전한 숨김 생략은 큐가 권위 데이터가 아닌 표현 전용 이벤트를 소유하는 경우에만 사용해야 합니다.

`confirmThrough`는 여전히 권위 확정 watermark만 뜻합니다. 확정된 이벤트와 가역 예측 이벤트는 이벤트 시각이 `frame.timeMs`에 도달할 때까지 대기하고, 준비된 이벤트는 시각·틱·sequence 순서로 처리합니다. 기본 이벤트 시각은 `event.tick * stepMs`입니다. 틱 내부 접촉 시각을 아는 소비자는 `classify(event)`가 0부터 1까지 `phase`를 반환하게 할 수 있습니다. 이때 공통 Queue가 `(tick - 1 + phase) * stepMs`를 계산하며, 권위 identity의 정수 tick은 바꾸지 않습니다. 0틱은 시작 이전 구간이 없으므로 `phase: 1`만 허용합니다. 30 TPS처럼 틱 길이가 정수가 아니어도 부동소수점 표현 오차로 이벤트가 한 프레임 늦어지지 않도록 경계에서만 시간 크기에 비례한 기계 오차를 허용합니다.

`adapter.start(event, frame.timeMs, ageMs)`의 세 번째 인수와 이후 `adapter.update(handle, ageMs, event)`의 age는 원래 이벤트 시각으로부터의 **시뮬레이션 밀리초**로, 이미 시작해야 했던 늦은 이벤트도 남은 수명부터 표시합니다. 예측 이벤트의 활성 자원이 동일 identity 재실행 시 다른 `phase`로 정정되면 `reconcile`을 호출하되 이미 표시한 나이는 거꾸로 돌리지 않고 정정 시계가 따라올 때까지 유지합니다. `maxLatenessMs`를 초과했거나 양수 `durationMs`가 이미 지난 이벤트는 재생하지 않고 종료된 identity를 유지합니다. `durationMs: 0`인 즉시 효과는 프레임이 틱과 정확히 일치하지 않아도 허용 지연 이내라면 한 번 시작하고 즉시 종료합니다. 효과·소리별 허용 지연이 다르면 adapter가 명시된 입력을 바탕으로 결정해야 합니다.

첫 보간 capture 전의 `{ revision: -1, timeMs: null }`과 초기 음수 `frame.timeMs`는 정상적인 대기 상태입니다. 표시 시계의 같은 revision에서는 시간이 역행하지 않아야 합니다. 더 높은 revision이 뒤로 이동하면 이전 표시 epoch의 활성 자원은 `timeline-reset`으로 종료하지만 확정 identity와 아직 시작하지 않은 이벤트는 유지합니다. 의도적인 리플레이 seek로 과거 효과를 다시 보려면 기존처럼 journal을 dispose한 뒤 새 journal을 만들어야 합니다. 일시정지나 배속 변경은 보간 프레임의 시간 진행에 반영되므로 별도의 벽시계 보정이 필요 없습니다. adapter가 여러 게임 효과를 composite handle로 소유할 수 있으며 `update` 중 `finish(event)`로 자연 종료할 수 있습니다. 외부 풀을 쓰면 adapter가 반납 및 재사용된 자원의 소유권을 스스로 검증해야 합니다.

adapter 오류는 기존과 같이 원본 예외를 전파합니다. 시작이 실패한 대기 이벤트는 다음 `present`에서 재시도할 수 있지만, 이미 완료된 외부 효과를 자동으로 되돌리거나 전체 배치의 exactly-once를 보장하지는 않습니다. `maxPending`을 넘어 조용히 효과를 버리지 않으며, 장시간 표시가 중단된 상황에서는 표시 지연·capacity를 함께 설계해야 합니다.

`emit({tick,sequence,entityId,generation,kind,payload,policy='confirmed',durationMs?})`는 새 identity일 때 true입니다. identity는 JSON tuple [origin tick, per-entity sequence, entity ID, generation, kind]이며 문자열 연결 충돌이 없습니다. payload는 게임 소유의 불변 데이터로 전달하세요. sequence와 generation은 재실행에서 동일해야 하며 render 순서나 랜덤값으로 만들면 안 됩니다.

- 기본 confirmed는 실제 confirmation 이후에만 start합니다. 재생한 소리는 취소해도 이미 들린 부분을 되돌릴 수 없으므로 one-shot SFX는 이 정책을 쓰세요.
- speculative는 reversible=true와 stop이 있는 adapter만 허용합니다. start는 즉시, 동일 identity의 재실행은 reconcile만 호출합니다. 만료된 이벤트도 tombstone을 남겨 다시 재생하지 않습니다.
- `beginRollback(fromTick)` 후 재실행 emit을 받고 `endRollback()`하면 재등장하지 않은 예측 자원을 취소합니다. 이미 확정한 tick의 rollback과 중첩 rollback은 거부합니다. 취소 identity가 이후 유효한 resim에서 돌아오면 새 자원으로 재개합니다.
- `confirmThrough(tick)`은 단조 증가합니다. 같은 tick의 확정 처리를 이미 끝냈으면 journal 재순회를 생략합니다. adapter 오류로 중단된 확정이나 이미 확정된 tick에 늦게 emit한 이벤트의 start 실패는 같은 tick으로 재시도할 수 있습니다. `update(nowMs)`도 단조 증가하며 만료/adapter update를 처리합니다. `finish(event)`는 자연 종료 자원을 정리하면서 dedup identity는 유지합니다.
- GC는 confirmedTick−retentionTicks 이하이면서 종료된 기록만 지웁니다. 그 이하의 늦은 emit은 거부합니다. 활성 장기 자원·실패한 start의 pending 기록·미확정 기록은 버리지 않습니다. maxPending 초과는 throw해 backpressure를 드러내며 실제 hit를 조용히 누락하지 않습니다. 게임은 확인 진행·활성 자원 수명·capacity를 설정해야 합니다.
- `dispose()`는 모든 자원을 정리하고 집계 오류를 반환하며 반복 호출은 안전합니다. replay seek/새 세션은 dispose 후 새 journal로 epoch를 분리합니다.

## 실제 SDK 연결

기존 SDK의 `adapter.step({tick,inputs,resimulating,recovering,replaying})`에서 게임이 이벤트를 생성합니다. `onEvent({type:'rollback',from,target})`은 상태 복구 후 resim 전에 발생하므로 beginRollback을 연결하고, `onEvent({type:'reconciled'})`에서 endRollback을 호출합니다. 수신 callback에서도 동기 rollback이 완료되므로 다음 poll까지 미루지 않습니다. 확정은 `Math.min(session.confirmedTick,session.tick-1)`가 0 이상일 때 confirmThrough합니다. 멤버십 경계 복원은 membership-committed에서 journal을 재설정하는 별도 생명주기입니다. reason:membership은 Math.max(from,journal.confirmedTick+1)부터 예측 꼬리만 취소합니다. bootstrap은 외부 효과를 생성하지 않습니다.

recovering 후보의 이벤트는 게임이 임시 저장하고 성공한 recovered 이후에만 journal에 전달해야 합니다. 실패한 recovery나 replay 검사용 step에서 실제 외부 자원을 만들면 안 됩니다. 이 모듈이 SDK private 상태나 별도 history를 읽지 않습니다.

Budmori의 tick별 effect/damage feedback과 [Rally f6037f05](https://github.com/byh-playground/rally-frontier/tree/f6037f05)의 confirmed presentation journal 경계를 참고한 신규 구현입니다. 원본 게임의 효과·아트·라이선스를 복제하거나 바꾸지 않습니다.

종료된 confirmed 자원은 payload/handle 참조를 즉시 해제하고 identity-only tombstone만 보관합니다. 이 축약은 기록당 한 번만 수행하며 이후 확정 호출에서 tombstone 객체를 다시 할당하지 않습니다. durationMs:0은 start 직후 만료하므로 큰 actor clone을 보관하지 않는 순간 feedback adapter에 적합합니다. frame update는 active Set만 순회하며 retained tombstone 전체를 매 frame 스캔하지 않습니다. 확정 tick 전진·실패 재시도와 rollback은 미확정/재시도 집합만 순회하며 확정된 장기 활성 자원과 tombstone은 재순회하지 않습니다. collect는 종료된 confirmed 기록의 tick별 bucket을 검사하고 cutoff 이하 bucket만 제거합니다. bucket에는 compact 시 기록당 참조 하나를 넣으며 별도의 payload나 history를 복제하지 않습니다. adapter가 확정 중 throw하면 이전 tombstone의 GC는 성공한 재시도 또는 명시적 collect까지 지연될 수 있으며, 활성·pending 기록은 그대로 유지합니다. 같은 확정 tick의 완료된 호출은 O(1)이며 새 이벤트·identity 문자열·map record·최초 tombstone은 할당되므로 전체 API를 0-allocation이라고 부르지 않습니다.

CPU·보유 heap의 전후 비교와 재현 명령은 [비용 측정](./docs/cost-measurement.md)에 있습니다.
