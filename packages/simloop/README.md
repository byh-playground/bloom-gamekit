# simloop

고정 논리 tick과 실제 시간 누적을 분리합니다. session capability를 받아 poll/advance/render를 조합합니다.

공개 API: `createLoop`. 외부 import가 없는 `dist/simloop.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

pulse(timestampMs)는 자동 rAF와 같은 누적·pacing·maxCatchupSteps 경계를 사용합니다. getInput/onAdvance/beforeFrame/canAdvance/render를 사용하고 게임에 또 다른 accumulator를 만들지 않습니다. start만 전역 blur/visibility listener를 설치하며 stop이 해제합니다.
