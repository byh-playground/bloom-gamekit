# deterministic

순수 난수·고정소수점·값 codec 및 실제 save/load 재실행 진단을 제공합니다. 네트워크나 렌더러를 초기화하지 않습니다.

공개 API: `hashBytes, statelessRandom, SeededPRNG, fixedPoint, createValueCodec, binaryCodec, jsonCodec, createSyncTestSession, SyncTestSession, runSyncTest, runSyncTestAsync, DeterminismError`. 외부 import가 없는 `dist/deterministic.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

codec은 권위 값을 선택하지 않습니다. 어댑터가 이후 결과에 영향을 주는 모든 값을 선택·검증해야 합니다. Synctest는 실제 공통 frame/StateHistory를 재사용하며 추가 저장·load·재실행 CPU를 사용합니다. 단일 브라우저 검사는 교차 엔진 결정성 증명이 아닙니다.
