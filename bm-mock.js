// modules/bm/adapters/mock/index.js
function createMockAdapter({ outcomes = [], loadable = true, latencyMs = 0 } = {}) {
  const CALLS = [];
  let next = 0;
  return {
    id: "mock",
    /** 호출 기록입니다. 검증용으로 읽기만 하세요. */
    calls: CALLS,
    load(placement, type) {
      CALLS.push({ op: "load", placement, type });
      return Promise.resolve(loadable);
    },
    show(placement, type) {
      CALLS.push({ op: "show", placement, type });
      const OUTCOME = outcomes[next++] ?? (type === "rewarded" ? "rewarded" : "viewed");
      return new Promise((resolve) => setTimeout(() => resolve(OUTCOME), latencyMs));
    }
  };
}
export {
  createMockAdapter
};
