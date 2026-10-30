# store mock 어댑터

실제 결제 없이 "서버가 보유 상품을 인정하는 과정"을 흉내 내는 어댑터입니다. 구매 성공, 취소, 서버 미확인, 다른 기기에서 구매한 복원 상황을 확인할 때 씁니다. 신청이나 키가 필요 없습니다.

    import { createStore } from '../../../../dist/store.js';
    import { createMockStoreAdapter } from '../../../../dist/store-mock.js';

    const ADAPTER = createMockStoreAdapter({ outcomes: ['cancelled', 'purchased'], latencyMs: 300 });
    const STORE = createStore({ adapter: ADAPTER });

- `products`: 판매 상품입니다. 기본은 광고 제거(`no_ads`) 하나입니다.
- `initialEntitlements`: 서버가 처음부터 인정하는 상품입니다. 재설치 복원을 확인할 때 씁니다.
- `outcomes`: `purchase`마다 순서대로 돌려줄 결과입니다. 다 쓰면 `purchased`입니다.
- `serverConfirms`: false면 `purchased`를 돌려주고도 서버가 인정하지 않습니다. 코어가 `pending`/`not-confirmed`로 처리하는지 확인합니다.
- `serverEntitlements`: 서버가 인정하는 집합입니다. 다른 기기에서 산 상황은 여기에 직접 `add`한 뒤 `STORE.refresh()`를 부릅니다.
- `calls`: `list`/`purchase`/`entitlements` 호출 기록입니다.
