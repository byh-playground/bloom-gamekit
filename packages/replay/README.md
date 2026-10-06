# replay

기존 replay를 같은 게임 adapter로 재생하고 최종 tick/hash를 반환합니다. 기록은 rollback session의 exportReplay()가 소유합니다.

공개 API: `playReplay`. 외부 import가 없는 `dist/replay.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

replay.frames는 연속 확정 입력의 기록이며 truncated:true는 기록 예산의 한도로 뒤쪽이 빠졌음을 뜻합니다. replay.hash와 반환 hash를 비교하세요. playReplay는 주어진 adapter를 초기 snapshot으로 load한 뒤 실행하므로 별도 진단 adapter를 쓰거나 호출자가 기존 상태를 보존해야 합니다.
