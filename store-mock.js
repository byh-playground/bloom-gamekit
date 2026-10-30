// modules/store/adapters/mock/index.js
function createMockStoreAdapter({
  products = [{ id: "no_ads", title: "광고 제거", type: "non-consumable", price: { amount: 3900, currency: "KRW" } }],
  initialEntitlements = [],
  outcomes = [],
  serverConfirms = true,
  latencyMs = 0
} = {}) {
  const SERVER = new Set(initialEntitlements);
  const CALLS = [];
  let next = 0;
  const LATER = (value) => new Promise((resolve) => setTimeout(() => resolve(value), latencyMs));
  return {
    id: "mock",
    /** 호출 기록입니다. 검증용으로 읽기만 하세요. */
    calls: CALLS,
    /** 서버가 인정하는 보유 상품입니다. 다른 기기에서 구매한 상황을 만들 때 직접 더합니다. */
    serverEntitlements: SERVER,
    list() {
      CALLS.push({ op: "list" });
      return LATER(products.map((product) => ({ ...product })));
    },
    purchase(productId) {
      CALLS.push({ op: "purchase", productId });
      const OUTCOME = outcomes[next++] ?? "purchased";
      if (OUTCOME === "purchased" && serverConfirms) {
        SERVER.add(productId);
      }
      return LATER(OUTCOME);
    },
    entitlements() {
      CALLS.push({ op: "entitlements" });
      return LATER([...SERVER]);
    }
  };
}
export {
  createMockStoreAdapter
};
