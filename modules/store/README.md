# store

상품 구매를 하나의 인터페이스로 감싸고, **서버가 인정한 보유 상품만 소유로 취급**하는 순수 ESM 모듈입니다. 결제사마다 어댑터를 붙이며, 광고 모듈 [bm](../bm/README.md)과는 서로를 import하지 않습니다. 이번 범위는 한 번 사면 계속 갖는 상품(non-consumable, 예: 광고 제거)뿐입니다. 소비성 상품, 구독, 서버 구현은 포함하지 않습니다.

## 구성

    modules/store/index.js                코어 (dist/store.js)
    modules/store/adapters/mock/          테스트·문서용 (dist/store-mock.js)

어댑터는 코어를 import하지 않고 아래 계약만 지키는 별도 번들입니다. 실제 결제사 어댑터는 아직 없습니다. 새 결제사는 `adapters/<이름>/`에 index.js와, 신청·승인 절차와 키 발급을 적은 README.md를 두고 `project/distribution.mjs`·`project/build.mjs`에 등록합니다.

## 사용

    import { createStore } from '../../../dist/store.js';
    import { createBm } from '../../../dist/bm.js';

    const STORE = createStore({ adapter: paymentsAdapter });
    await STORE.refresh(); // 앱 시작 때 서버 기준으로 보유 상품을 읽음 (재설치·다른 기기 복원도 이것)

    const BM = createBm({
        adapter: adsAdapter,
        suppress: (type) => type === 'interstitial' && STORE.owns('no_ads'),
    });

    buyButton.onclick = async () => {
        const RESULT = await STORE.purchase('no_ads');
        if (RESULT.status === 'purchased') {
            hideAds();
        }
    };
    STORE.on('change', ({ owned }) => updateUi(owned));

## 핵심 원칙

어댑터의 `purchase()`가 `purchased`를 돌려줘도 `owns()`는 바로 true가 되지 않습니다. 코어가 어댑터의 `entitlements()`를 다시 읽어 서버가 그 상품을 인정한 뒤에야 `purchased`로 확정하고 `owns()`가 true가 됩니다. 브라우저 콜백은 조작할 수 있기 때문입니다. 서버가 아직 인정하지 않으면 `pending`/`not-confirmed`이며 나중에 `refresh()`로 다시 확인합니다.

## 결과

`purchase`는 항상 `{ status, productId, reason?, error? }`로 끝나며 던지지 않습니다.

| status      | 뜻                                           | 보유 처리 |
| ----------- | -------------------------------------------- | --------- |
| `purchased` | 서버가 보유로 인정함                         | 예        |
| `cancelled` | 사용자가 결제를 취소함                       | 아니오    |
| `pending`   | 결제 대기 중이거나 서버가 아직 인정하지 않음 | 아니오    |
| `error`     | 어댑터 오류·시간 초과·계약에 없는 결과       | 아니오    |
| `blocked`   | 요청하지 않음                                | 아니오    |

- `pending`의 `reason`: `adapter-pending`(결제사가 대기 상태라고 함), `not-confirmed`(서버가 아직 인정하지 않음), `refresh-failed`(서버 조회 실패).
- `blocked`의 `reason`: `busy`, `unknown-product`(목록을 읽은 뒤 없는 상품), `already-owned`, `disposed`.
- `error`의 `reason`: `adapter-failed`, `timeout`, `invalid-outcome`. **시간 초과도 결제가 실제로 끝났을 수 있으므로** 바로 `refresh()`로 확인하세요.
- `list()`는 `{ status, products }`, `refresh()`는 `{ status }`로 끝나며 실패해도 던지지 않습니다. 실패하면 기존 보유 상태를 유지합니다.
- 같은 시간에 구매는 하나만 열립니다. `refresh()`를 동시에 여러 번 불러도 서버 조회는 하나만 진행합니다.

## 어댑터 계약

    {
        id: 'stripe',
        list() { /* Promise<[{ id, title, type: 'non-consumable', price? }]> */ },
        purchase(productId) { /* Promise<'purchased' | 'cancelled' | 'pending' | 'error'> */ },
        entitlements() { /* Promise<string[]> 서버가 지금 이 사용자에게 인정하는 상품 id */ },
        dispose() {}, // 선택
    }

`purchase`와 `entitlements`는 같은 사용자의 서버 상태를 기준으로 해야 합니다. 결제 검증(영수증 확인)은 서버가 하고, 어댑터는 그 결과를 `entitlements()`로 노출합니다. 이 모듈은 서버를 만들지 않습니다.

## 범위 밖

소비성 상품(코인 등), 구독, 환불·취소 처리, 영수증 검증 서버, 가격 표시 형식은 포함하지 않습니다. 가치가 걸린 지급은 서버가 판단하는 경로에서 따로 설계해야 합니다.
