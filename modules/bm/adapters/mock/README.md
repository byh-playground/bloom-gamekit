# bm mock 어댑터

SDK 없이 정해 둔 결과를 돌려주는 어댑터입니다. 광고 중 UI 흐름, 거절·실패 경로, 정책 동작을 확인할 때 씁니다. 신청이나 키가 필요 없습니다.

    import { createBm } from '../../../../dist/bm.js';
    import { createMockAdapter } from '../../../../dist/bm-mock.js';

    const ADAPTER = createMockAdapter({ outcomes: ['rewarded', 'dismissed', 'unavailable'], latencyMs: 800 });
    const BM = createBm({ adapter: ADAPTER, requireUserActivation: false });

- `outcomes`: `show`마다 순서대로 돌려줄 결과입니다. 다 쓰면 보상형은 `rewarded`, 전면은 `viewed`입니다.
- `loadable`: `load()`가 돌려줄 값입니다(기본 true).
- `latencyMs`: 광고가 끝나기까지 걸리는 시간입니다.
- `calls`: `load`/`show` 호출 기록 배열입니다.

Node에서는 `navigator.userActivation`이 없어 막히지 않지만, 입력 직후 판정을 확인하려면 `isUserActive`를 직접 넘기세요.
