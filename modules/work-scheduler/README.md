# work-scheduler

비긴급 탐색·조사 작업을 논리 게임 tick의 고정 work-unit 예산 안에서 분산하는 순수 ESM 모듈입니다. 타이머나 물리 서브틱은 만들지 않습니다. 호출 게임이 기존 권위 tick마다 tick(tickId)를 한 번 호출합니다.

## 예산과 순서

createBudgetedScheduler({ unitsPerTick = 24, quantumUnits = 1, now })에서 unitsPerTick은 tick 하나가 쓸 수 있는 고정 작업 단위이고 quantumUnits는 작업 하나가 양보 전에 쓸 수 있는 최대 단위입니다. 후보를 하나 검사하는 게임이라면 한 후보 검사가 1 unit이 되도록 quantumUnits: 1을 유지하세요. step은 받은 maxUnits 이내에서만 실행하고 { done, unitsUsed, result? }를 반환합니다. 불완료 작업의 호출은 최소 1 unit을 소비해야 합니다. 한 번의 콜백 내부에 무제한 후보 순회를 넣지 마세요.

Priority는 0(low), 1(standard), 2(urgent)입니다. 고정 wheel은 [2, 1, 2, 0, 2, 1, 2]이며 대기 중인 작업이 있는 priority에 대해 각각 4/7, 2/7, 1/7 quantum을 줍니다. 해당 priority가 비어 있으면 다음 대기 priority의 quantum이 사용됩니다. 각 priority 내부는 enqueue 순서로 순환합니다. 따라서 urgent의 연속 유입도 일반 작업의 진행을 막지 않습니다. priority는 같은 key 요청이 들어왔을 때 더 높은 값으로만 승격됩니다.

wall-clock은 tick CPU 시간과 처리량 진단에만 씁니다. 시간값은 실행 순서·결과·예산 계산에 관여하지 않습니다. 모든 입력과 후보 배열을 같은 순서로 제공하면 결과 순서도 고정됩니다.

## API

    import { createBudgetedScheduler } from '../../../dist/work-scheduler.js';

    const SCHEDULER = createBudgetedScheduler({ unitsPerTick: 24, quantumUnits: 1 });

    SCHEDULER.enqueue({
        key: 'actor-17:4',
        owner: ACTOR,
        priority: 1,
        isValid: () => ACTOR.alive && ACTOR.generation === 4,
        step({ maxUnits }) {
            let unitsUsed = 0;
            while (unitsUsed < maxUnits && cursor < candidates.length) {
                inspect(candidates[cursor++]);
                unitsUsed++;
            }
            return { done: cursor >= candidates.length, unitsUsed, result };
        },
        onComplete({ result }) {
            if (ACTOR.alive && canReserve(result)) {
                reserveAtomically(result);
            }
        },
    });

    // Exactly once in the game's existing fixed update:
    SCHEDULER.tick(gameTick);

step context는 callback 사이에 재사용됩니다. callback에서 필요한 필드만 즉시 읽고 context 객체 자체를 저장하지 마세요. unitsUsed는 후보 검사처럼 소비자가 정의한 안정적인 단위입니다. 작업량을 단계별로 나눌 수 없는 함수는 이 API가 중간에 중단할 수 없습니다.

같은 활성 key를 다시 enqueue하면 새 closure/callback은 저장하지 않고 기존 작업과 병합합니다. 더 높은 priority만 기존 작업에 반영합니다. 새 시작점 또는 새 후보 snapshot이 필요하면 기존 key를 취소한 뒤 다시 등록하세요. 같은 key는 같은 owner여야 합니다. entity가 삭제될 때 cancelOwner(entity)를 호출해 관련 queue 참조와 callback을 제거하세요. 소유 게임은 isValid에서 stale 작업을 걸러내고 onComplete 안에서 결과를 다시 검증한 뒤 예약을 원자적으로 수행합니다. 두 계약은 scheduler가 구현하지 않습니다.

tick(tickId)는 새롭고 증가하는 0 이상의 safe integer tick ID를 요구합니다. rollback/reset으로 tick ID가 되돌아가는 경우에는 기존 scheduler를 dispose()하고 새 인스턴스를 만드세요. enqueue는 새 작업이면 true, 동일 key 병합이면 false입니다. cancel(key)는 한 건의 취소 성공 여부, cancelOwner(owner)는 취소 수를 반환합니다. dispose()는 반복 호출 가능하며 이후 enqueue/tick은 오류입니다.

## 진단 연결

metrics는 읽을 때만 고정 snapshot을 할당합니다. 처리량(unitsProcessed, throughputUnitsPerTick, throughputUnitsPerSecond), first-service 대기 tick의 누적/평균/최대값, priority별 active queue, 완료·병합·취소, tick 시간, 예산 소진을 보여줍니다. lastTick* 필드는 기존 FrameMetrics의 등록 카운터에 논리 tick별로 더할 수 있습니다.

    const UNITS = SCHEDULER.tick(gameTick);
    const SNAPSHOT = SCHEDULER.metrics;
    FRAME_METRICS.count('search.units', UNITS);
    FRAME_METRICS.count('search.waitTicks', SNAPSHOT.lastTickWaitingTicks);
    FRAME_METRICS.count('search.budgetExhausted', Number(SNAPSHOT.lastTickBudgetExhausted));

이 모듈은 debug-tools에 의존하지 않으므로 SDK 번들은 독립적입니다. 프로파일링이 필요한 소비자는 기존 FrameMetrics에 명시적으로 연결합니다. metrics snapshot은 호출자가 읽을 때만 할당하고 scheduler의 queue node와 step context는 재사용합니다.

## 실행 예제와 검증

examples/index.html은 버튼으로 논리 tick을 직접 호출해 우선순위, 후보별 yield, entity 취소와 FrameMetrics 연동을 보여줍니다. timer를 사용하지 않습니다. 공식 core browser 시나리오도 고정 예산·결정 순서·취소·중복·수명주기를 확인합니다.
