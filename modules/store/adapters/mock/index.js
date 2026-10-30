/**
 * 테스트·문서용 결제 어댑터입니다. 실제 결제를 하지 않고 서버가 보유 상품을 인정하는 과정만 흉내 냅니다.
 * @param {object} [options]
 * @param {object[]} [options.products] 판매 상품. 기본은 광고 제거 하나
 * @param {string[]} [options.initialEntitlements=[]] 서버가 처음부터 인정하는 보유 상품
 * @param {string[]} [options.outcomes=[]] purchase마다 순서대로 돌려줄 결과. 소진하면 'purchased'
 * @param {boolean} [options.serverConfirms=true] purchased 뒤 서버가 보유로 인정할지 여부
 * @param {number} [options.latencyMs=0] 각 호출이 끝나기까지의 시간
 */
export function createMockStoreAdapter({
    products = [{ id: 'no_ads', title: '광고 제거', type: 'non-consumable', price: { amount: 3900, currency: 'KRW' } }],
    initialEntitlements = [],
    outcomes = [],
    serverConfirms = true,
    latencyMs = 0,
} = {}) {
    const SERVER = new Set(initialEntitlements);
    const CALLS = [];
    let next = 0;
    const LATER = (value) => new Promise((resolve) => setTimeout(() => resolve(value), latencyMs));
    return {
        id: 'mock',
        /** 호출 기록입니다. 검증용으로 읽기만 하세요. */
        calls: CALLS,
        /** 서버가 인정하는 보유 상품입니다. 다른 기기에서 구매한 상황을 만들 때 직접 더합니다. */
        serverEntitlements: SERVER,
        list() {
            CALLS.push({ op: 'list' });
            return LATER(products.map((product) => ({ ...product })));
        },
        purchase(productId) {
            CALLS.push({ op: 'purchase', productId });
            const OUTCOME = outcomes[next++] ?? 'purchased';
            if (OUTCOME === 'purchased' && serverConfirms) {
                SERVER.add(productId);
            }
            return LATER(OUTCOME);
        },
        entitlements() {
            CALLS.push({ op: 'entitlements' });
            return LATER([...SERVER]);
        },
    };
}
