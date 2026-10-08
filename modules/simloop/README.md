# simloop

고정 논리 tick과 실제 시간 누적을 분리합니다. session capability를 받아 poll/advance/render를 조합합니다.

공개 API: `createLoop`. 외부 import가 없는 `dist/simloop.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

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
