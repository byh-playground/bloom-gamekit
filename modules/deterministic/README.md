# deterministic

순수 난수·고정소수점·값 codec 및 실제 save/load 재실행 진단을 제공합니다. 네트워크나 렌더러를 초기화하지 않습니다.

공개 API: `hashBytes, statelessRandom, SeededPRNG, PseudoRandomDistribution, fixedPoint, createValueCodec, binaryCodec, jsonCodec, createSyncTestSession, SyncTestSession, runSyncTest, runSyncTestAsync, DeterminismError`. 외부 import가 없는 `dist/deterministic.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](./index.d.ts), [개발 계약](../rollback/CONTRACT.md), [상세 사용법과 이전](../rollback/docs/api-migration.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

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
