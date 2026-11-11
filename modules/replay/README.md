# replay

## 언제 쓰나

- rollback 세션이 기록한 경기(`session.exportReplay()`)를 같은 게임 adapter로 **처음부터 다시 실행해 최종 tick·hash를 확인**하고 싶을 때.

## 쓰는 모양

쓰는 게임이 아직 없습니다. [rollback 브라우저 시험](../rollback/tests/browser.html)에서 줄였습니다.

```js
import { playReplay } from '../../../dist/replay.js';
const REPLAY = session.exportReplay();
const RESULT = playReplay({ adapter: adapterFor(new Int32Array(8)), replay: REPLAY });
if (RESULT.hash !== REPLAY.hash) throw new Error('replay mismatch');
```

## 쓰지 말아야 할 때

| 이런 일                               | 대신                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| 저장→불러오기 반복으로 깨지는 틱 찾기 | [deterministic](../deterministic/README.md) `runSyncTestAsync` |
| 리플레이 탐색 UI                      | [debug-tools](../debug-tools/README.md) `ReplayTimeline`       |
| 게임 안 시연 재생                     | [scenario](../scenario/README.md)                              |

## 상세

기존 replay를 같은 게임 adapter로 재생하고 최종 tick/hash를 반환합니다. 기록은 rollback session의 exportReplay()가 소유합니다.

공개 API: `playReplay`. 외부 import가 없는 `dist/replay.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](./index.d.ts), [개발 계약](../rollback/CONTRACT.md), [상세 사용법과 이전](../rollback/docs/api-migration.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

replay는 연속 확정 입력의 기록입니다. 입력은 바뀐 tick만 `inputChanges` 바이트에, 실행된 명령은 `commands`에 담고 `tick`이 기록된 tick 수입니다. RoomSession 구간은 `baseTick`·`membershipEpoch`를 더 갖고, playReplay는 adapter에 그 전역 tick·세대를 그대로 넘깁니다. truncated:true는 기록 예산의 한도로 뒤쪽이 빠졌음을 뜻합니다. replay.hash와 반환 hash를 비교하세요. playReplay는 주어진 adapter를 초기 snapshot으로 load한 뒤 실행하므로 별도 진단 adapter를 쓰거나 호출자가 기존 상태를 보존해야 합니다.

## SDK 버전과 기록 형식

SDK 제품 버전은 내부 공유 version.js 한 곳에서 관리합니다. replay.version은 기존 기록을 그대로 읽기 위한 REPLAY_FORMAT_VERSION 식별자이며 SDK 표시 버전과 분리합니다. simulationVersion은 게임 규칙·snapshot 호환성을 게임이 정의합니다. SDK 버전이 같다는 이유만으로 멀티플레이나 게임 리플레이 호환성을 보장하지 않습니다.
