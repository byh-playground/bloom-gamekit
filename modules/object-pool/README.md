# object-pool

Rally의 `ReusableObjectPool`에서 추출한 독립 ESM 객체 재사용 코어입니다. 게임별 VFX, 시간, 렌더러, 이력, typed buffer 정책은 소유하지 않습니다.

```js
import { ObjectPool } from './object-pool.js';
const pool = new ObjectPool(
  () => ({ x: 0, target: null }),
  item => { item.x = 0; item.target = null; },
  64,
);
const item = pool.acquire();
item.x = 10;
// 소유자의 활성 목록과 모든 외부 참조에서 제거한 뒤:
pool.release(item);
```

## API와 수명 계약

- `new ObjectPool(create, reset = null, max = 256)`: factory와 선택적 reset은 함수여야 하며, max는 0 이상의 유한한 safe integer입니다. 설정 오류는 생성 시 한 번 거부합니다. max는 유휴 보관 상한이며 활성 객체 수를 제한하지 않습니다. 0이면 reset 후 보관하지 않습니다.
- `acquire()`: 마지막으로 반납한 객체를 반환(LIFO)하며, 없으면 factory를 호출합니다. factory는 매번 독립적인 non-null 객체를 반환해야 합니다. acquire에서 reset을 다시 호출하지 않으므로 대여자가 필요한 활성 상태를 초기화합니다.
- `release(item)`: null/undefined는 무시합니다. reset을 먼저 실행하고 여유가 있으면 보관합니다. 상한을 넘긴 객체에도 reset을 실행한 뒤 참조를 버립니다.
- `clear()`: 이미 reset된 유휴 객체의 참조만 비웁니다. 활성 객체에는 접근하지 않으며 reset을 다시 실행하지 않습니다. 이후 acquire/release는 계속 사용할 수 있습니다. 자원을 소유하는 객체의 실제 해제는 호출자/reset의 책임입니다.

객체의 타입, 풀 소속, 중복 반납, 대여 중 여부는 hot path에서 검사하지 않습니다. 같은 객체를 두 번 반납하거나 다른 풀/외부 객체를 반납하는 것은 계약 위반이며, 중복 반납하면 같은 객체를 동시에 두 번 대여해 상태를 훼손할 수 있습니다. 호출자는 자신의 풀에서 대여한 객체만 정확히 한 번 반납해야 합니다. release 전 소유자의 활성 목록·이벤트·콜백·snapshot·보간 이력 등 모든 사용을 끝내고, release 뒤에는 다시 acquire할 때까지 참조를 읽거나 쓰지 않습니다. 배열 압축 중에는 반납한 항목을 다시 읽거나 대여하기 전에 남은 배열 참조를 제거합니다.

reset은 객체에 남은 외부 참조를 끊고 다음 대여에 필요한 기본 상태를 복원해야 합니다. factory/reset은 동기 함수이며 같은 풀을 재진입하지 않아야 합니다. 예외는 그대로 전파합니다. factory 실패는 유휴 목록을 바꾸지 않으며 reset 실패 객체는 풀에 보관하지 않습니다. 실패 객체의 정리 책임은 호출자에게 남습니다. clear 후에도 이전에 대여한 활성 객체는 유효하며 수명이 끝나면 반납할 수 있습니다.

## 비용과 적용 경계

acquire/release는 배열 pop/push와 상한 비교만 사용합니다. 멤버십 Set, 객체별 태그, 프레임별 전체 순회나 활성 추적은 없습니다. 저장 메모리는 유휴 객체와 상한 내 배열로 제한되며 factory/reset 비용은 소비자가 소유합니다. 할당을 줄일 수 있으나 FPS 개선을 보장하거나 벤치마크 결과를 주장하지 않습니다.

Rally의 불꽃·emitter·전기 arc scratch 및 표현 이펙트 풀을 같은 LIFO/reset/유휴 상한으로 이관합니다. 과거 풀의 미사용 진단 카운터는 공통 API가 아닙니다. 시뮬레이션 snapshot이나 SDK 보간 source처럼 이력에서 참조하는 객체, WeakMap으로 actor 수명에 결합한 객체, 단일 소유 scratch 배열은 이 풀로 대체하지 않습니다. `ReusableFloat32Buffer`는 별도 수명의 API이므로 포함하지 않습니다.
