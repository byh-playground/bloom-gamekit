# deterministic

순수 난수·고정소수점·값 codec 및 실제 save/load 재실행 진단을 제공합니다. 네트워크나 렌더러를 초기화하지 않습니다.

공개 API: `hashBytes, statelessRandom, SeededPRNG, PseudoRandomDistribution, fixedPoint, createValueCodec, binaryCodec, jsonCodec, createSyncTestSession, SyncTestSession, runSyncTest, runSyncTestAsync, DeterminismError`. 외부 import가 없는 `dist/deterministic.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](./index.d.ts), [개발 계약](../rollback/CONTRACT.md), [상세 사용법과 이전](../rollback/docs/api-migration.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 값 codec 형식

`createValueCodec({format, maxBytes, maxDepth, maxEntries, omitUndefined=false})`은 `null`·불리언·유한 숫자·문자열·`Uint8Array`·배열·일반 레코드를 정규(canonical) 바이트로 만듭니다. 바이너리 형식은 여기에 `Int8Array`·`Int16Array`·`Uint16Array`·`Int32Array`·`Uint32Array`·`Float32Array`·`Float64Array`를 받으며 요소는 항상 little-endian으로 씁니다. 격자·수치 배열을 요소별 값으로 풀지 않아 `maxEntries`를 쓰지 않고 `Uint8Array`처럼 한 번의 복사에 가깝게 처리합니다. 실수 요소는 유한해야 하며 `-0`은 `0`으로 정규화됩니다. 디코더는 `-0`·`NaN`·`Infinity` 비트 패턴을 비정규로 거부합니다. `Uint8ClampedArray`와 BigInt 배열은 지원하지 않고, JSON 형식은 어떤 typed array도 받지 않습니다. `omitUndefined:true`이면 값이 `undefined`인 레코드 키를 건너뜁니다(기본은 거부, 배열 항목의 `undefined`는 항상 거부). typed array 태그는 추가 형식이라 이전 SDK의 디코더는 이 태그가 든 payload를 읽지 못합니다. 같은 방에서 SDK 버전이 섞이면 해당 payload를 쓰지 마세요. 기존 payload는 그대로 읽힙니다.

## 소유권과 비용

codec은 권위 값을 선택하지 않습니다. 어댑터가 이후 결과에 영향을 주는 모든 값을 선택·검증해야 합니다. Synctest는 실제 공통 frame/StateHistory를 재사용하며 추가 저장·load·재실행 CPU를 사용합니다. 단일 브라우저 검사는 교차 엔진 결정성 증명이 아닙니다.

## Pseudo-random distribution

`PseudoRandomDistribution`은 PRD 성공 확률을 연속 실패 횟수에 따라 `q(n) = min(1, n * C)`로 올립니다. 성공하면 실패 횟수를 0으로 되돌립니다. 각 인스턴스는 초기 실패 횟수를 0으로 시작하므로 첫 시도의 실제 확률은 `C`입니다. `C`는 생존확률 합 `E[T] = Σ P(T > k)`가 `1 / probability`가 되도록 설정 시 수치 계산하고 캐시합니다. `probability`는 장기 평균 성공률이며, 첫 시도나 짧은 구간의 비율이 입력 확률과 같다는 뜻은 아닙니다.

양의 입력 확률은 `0.0001`부터 `1`까지이며, `0`은 항상 실패하는 경계값입니다. `0.0001` 미만은 계수 계산과 대기 분포 준비가 설정 시 오래 걸릴 수 있어 지원하지 않습니다. `0`에서는 난수 스트림을 소비하지 않고 각 요청을 실패 횟수에 더합니다. `1`은 항상 성공하고 실패 횟수를 초기화합니다. 보통 확률은 32-bit 난수 스트림을 입력으로 사용하며, `rollMany(draws)`는 성공 간 실패 구간을 누적분포에서 건너뜁니다. 결과는 추첨 수나 당첨 수를 임의로 자르지 않으며 비용은 성공 횟수와 비례합니다. 따라서 낮은 확률에서 큰 배치의 빈 실패 시도를 건너뛰지만, 성공 수 자체가 많은 배치는 그 횟수만큼 처리합니다. 중앙 확률의 수십억 건을 상수 시간으로 축약하지는 않습니다.

확률 `.02`의 계수는 `0.0006200876164356005`, `.04`의 계수는 `0.002448555471647705`입니다. 이 값은 해당 입력을 각각 평균 대기 시간 50회와 25회로 맞춥니다. 32-bit RNG에서 누적분포를 선택하므로 확률 경계에는 1/2³² 단위의 작은 양자화가 있습니다.

```js
import { PseudoRandomDistribution, SeededPRNG } from './deterministic.js';

const RNG = new SeededPRNG(1234);
const CRITICAL_HITS = new PseudoRandomDistribution({ probability: 0.02, rng: RNG });
const HIT = CRITICAL_HITS.roll();
const HIT_COUNT = CRITICAL_HITS.rollMany(1000000);
const SAVE = {
    prngState: RNG.state,
    criticalHits: CRITICAL_HITS.capture(),
};
```

`capture()`에는 입력 확률, 연속 실패 횟수, 다음 성공까지의 대기 시도가 들어갑니다. 이 상태와 함께 호출자가 소유한 `SeededPRNG.state`도 저장해야 재현 가능합니다. `restore()`는 난수 스트림을 변경하지 않습니다. `setProbability()`는 실패 횟수를 보존하고 아직 진행 중인 대기만 폐기해 새 확률에서 현재 실패 횟수 조건으로 다시 추출합니다. 실패 이력을 지우려면 `reset()`을 명시적으로 호출합니다. 일반/이벤트처럼 서로 다른 확률 흐름은 별도의 PRNG와 PRD 인스턴스로 나눌 수 있습니다.

### 예산형 재개 job

`rollMany(draws)`는 기존과 같이 한 번의 동기 호출에서 전체 배치를 끝냅니다. 큰 배치를 여러 게임 tick으로 나누려면 `createRollJob(draws)`를 사용합니다. `step(maxUnits)`는 성공 간격 평가를 최대 `maxUnits`회 수행하고 현재까지의 성공 누계와 남은 추첨 수를 반환합니다. job은 당첨 개별 기록을 만들지 않습니다.

```js
const RNG = new SeededPRNG(0x51f15e);
const CRITICAL_HITS = new PseudoRandomDistribution({ probability: 0.02, rng: RNG });
const JOB = CRITICAL_HITS.createRollJob(36_768_468_716);

SCHEDULER.enqueue({
    key: 'farm:stage-61-drops',
    step({ maxUnits }) {
        const PROGRESS = JOB.step(maxUnits);
        return {
            done: PROGRESS.done,
            unitsUsed: PROGRESS.unitsUsed,
            result: PROGRESS.done ? PROGRESS.successes : undefined,
        };
    },
    onComplete({ result }) {
        applyAggregateRewards(result);
    },
});
```

각 작업 단위는 성공까지의 wait 분포를 한 번 평가합니다. 확률이 0 또는 1이면 전체 구간을 O(1)로 처리하고, 그 외에는 uint32 난수를 최대 하나 소비해 사전 계산된 누적분포에서 이진 탐색합니다. 누적분포 임계값은 서로 다른 uint32 정수이므로 이진 탐색 비교는 작업 단위당 최대 32회입니다. 마지막의 미완성 성공 간격도 작업 단위 하나를 사용합니다. 따라서 `unitsUsed`는 호출 예산을 넘지 않고 성공 건수만 반환합니다.

job을 중단하기 전에 `JOB.capture()` 결과를 게임 저장 상태에 원자적으로 기록합니다. snapshot은 버전, 전체·처리·잔여 trial, 누적 성공 수, PRD state, `rngState`만 포함합니다. 재개 시 새 `SeededPRNG`와 PRD를 만든 뒤 `restoreRollJob(snapshot)`을 호출하면 RNG 진행과 PRD 상태를 함께 복원합니다. snapshot은 일반 JSON 직렬화가 가능하며 범위와 trial 카운터를 복원 시 검증합니다. 재개 API는 RNG에 쓰기 가능한 own `state` 속성을 요구하므로 `SeededPRNG`를 사용해야 합니다. 일반 `roll()`/`rollMany()`는 기존처럼 `nextUint32()`만 구현한 RNG도 계속 받을 수 있습니다.

job이 살아 있는 동안 해당 PRD의 직접 `roll()`, `rollMany()`, `reset()`, `setProbability()`와 별도 `capture()`/`restore()`는 거부됩니다. caller-owned RNG도 job 전용으로 두고 다른 코드에서 소비하지 마세요. snapshot을 저장한 뒤 `dispose()`하면 현재 PRD/RNG 위치를 보존하면서 job 점유만 해제합니다. chunk 크기는 같은 RNG 순서를 이어가므로 총 성공 수와 최종 PRD/RNG state를 바꾸지 않습니다.

bounded step은 한 호출의 동기 점유 시간을 제한하지만 총 계산량을 줄이지는 않습니다. stage 61의 `36,768,468,716`회 추첨은 입력 평균 2%에서 약 `735,369,374`개 성공 간격 평가를 요구합니다. 보수적 상한으로 이진 탐색 비교만 약 `23,531,819,978`회(약 235억 회)까지 발생할 수 있어, 여러 tick에 나눠도 완료 시간은 매우 깁니다. Farm은 필요한 총 시도를 줄이거나 취소·진행 저장을 게임 정책으로 다뤄야 합니다. 추첨 수나 성공 수 cap, 근사 분포는 적용하지 않습니다.
