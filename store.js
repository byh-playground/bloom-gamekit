// modules/store/index.js
var PURCHASE_OUTCOMES = Object.freeze(["purchased", "cancelled", "pending", "error"]);
var TIMED_OUT = new Error("store adapter purchase timed out.");
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const TIMER = setTimeout(() => reject(TIMED_OUT), ms);
    promise.then(
      (value) => {
        clearTimeout(TIMER);
        resolve(value);
      },
      (error) => {
        clearTimeout(TIMER);
        reject(error);
      }
    );
  });
}
function isProduct(product) {
  return product !== null && typeof product === "object" && typeof product.id === "string" && product.id !== "" && typeof product.title === "string" && product.type === "non-consumable";
}
function createStore({ adapter, purchaseTimeoutMs = 3e5 } = {}) {
  if (!adapter || typeof adapter.id !== "string" || typeof adapter.list !== "function" || typeof adapter.purchase !== "function" || typeof adapter.entitlements !== "function") {
    throw new TypeError("store adapter must provide id, list(), purchase() and entitlements().");
  }
  if (!Number.isFinite(purchaseTimeoutMs) || purchaseTimeoutMs <= 0) {
    throw new RangeError("store purchaseTimeoutMs must be a positive finite number.");
  }
  const OWNED = /* @__PURE__ */ new Set();
  const PRODUCTS = /* @__PURE__ */ new Map();
  const LISTENERS = /* @__PURE__ */ new Set();
  let busy = false;
  let disposed = false;
  let refreshing = null;
  function emitChange() {
    const PAYLOAD = { owned: [...OWNED] };
    for (const LISTENER of [...LISTENERS]) {
      try {
        LISTENER(PAYLOAD);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
  function applyEntitlements(ids) {
    const CHANGED = ids.length !== OWNED.size || ids.some((id) => !OWNED.has(id));
    OWNED.clear();
    for (const ID of ids) {
      OWNED.add(ID);
    }
    if (CHANGED) {
      emitChange();
    }
  }
  async function readEntitlements() {
    let ids;
    try {
      ids = await adapter.entitlements();
    } catch (error) {
      return { status: "error", reason: "adapter-failed", error };
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return { status: "error", reason: "invalid-entitlements" };
    }
    if (disposed) {
      return { status: "blocked", reason: "disposed" };
    }
    applyEntitlements(ids);
    return { status: "ok" };
  }
  function refresh() {
    if (disposed) {
      return Promise.resolve({ status: "blocked", reason: "disposed" });
    }
    refreshing ??= readEntitlements().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function refreshFresh() {
    if (refreshing) {
      await refreshing;
    }
    return refresh();
  }
  return {
    /** @returns {string} 연결된 어댑터 id */
    get adapterId() {
      return adapter.id;
    },
    /** @returns {string[]} 서버가 인정한 보유 상품 id의 복사본 */
    get owned() {
      return [...OWNED];
    },
    /** 서버 확인을 마친 보유 상품만 true입니다. refresh 전에는 false입니다. */
    owns(productId) {
      return OWNED.has(productId);
    },
    /**
     * 판매 상품 목록을 읽고 구매 검사에 씁니다. 실패는 던지지 않고 status로 알립니다.
     * @returns {Promise<{ status: 'ok' | 'error' | 'blocked', products?: object[], reason?: string, error?: unknown }>}
     */
    async list() {
      if (disposed) {
        return { status: "blocked", reason: "disposed" };
      }
      let products;
      try {
        products = await adapter.list();
      } catch (error) {
        return { status: "error", reason: "adapter-failed", error };
      }
      if (!Array.isArray(products) || !products.every(isProduct)) {
        return { status: "error", reason: "invalid-products" };
      }
      PRODUCTS.clear();
      for (const PRODUCT of products) {
        PRODUCTS.set(PRODUCT.id, PRODUCT);
      }
      return { status: "ok", products: products.map((product) => ({ ...product })) };
    },
    /**
     * 서버 기준으로 보유 상품을 다시 읽습니다. 앱 시작, 재설치, 다른 기기에서의 복원, 구매 시간 초과 뒤에 부릅니다.
     * @returns {Promise<{ status: 'ok' | 'error' | 'blocked', reason?: string, error?: unknown }>}
     */
    refresh,
    /**
     * 구매합니다. 어댑터가 purchased를 돌려줘도 서버가 보유로 인정해야 'purchased'입니다.
     * 인정되지 않으면 'pending'(reason 'not-confirmed')이며 나중에 refresh로 다시 확인하세요.
     * 시간 초과(reason 'timeout')도 결제가 실제로 끝났을 수 있으니 refresh로 확인하세요.
     * @param {string} productId
     * @returns {Promise<{ status: 'purchased' | 'cancelled' | 'pending' | 'error' | 'blocked', productId: string, reason?: string, error?: unknown }>}
     */
    async purchase(productId) {
      const RESULT = { status: "error", productId };
      if (disposed) {
        return { ...RESULT, status: "blocked", reason: "disposed" };
      }
      if (busy) {
        return { ...RESULT, status: "blocked", reason: "busy" };
      }
      if (PRODUCTS.size > 0 && !PRODUCTS.has(productId)) {
        return { ...RESULT, status: "blocked", reason: "unknown-product" };
      }
      if (OWNED.has(productId)) {
        return { ...RESULT, status: "blocked", reason: "already-owned" };
      }
      busy = true;
      try {
        const OUTCOME = await withTimeout(Promise.resolve(adapter.purchase(productId)), purchaseTimeoutMs);
        if (!PURCHASE_OUTCOMES.includes(OUTCOME)) {
          RESULT.reason = "invalid-outcome";
        } else if (OUTCOME === "purchased") {
          const REFRESHED = await refreshFresh();
          if (OWNED.has(productId)) {
            RESULT.status = "purchased";
          } else {
            RESULT.status = "pending";
            RESULT.reason = REFRESHED.status === "ok" ? "not-confirmed" : "refresh-failed";
          }
        } else {
          RESULT.status = OUTCOME;
          if (OUTCOME === "pending") {
            RESULT.reason = "adapter-pending";
          }
        }
      } catch (error) {
        RESULT.reason = error === TIMED_OUT ? "timeout" : "adapter-failed";
        RESULT.error = error;
      } finally {
        busy = false;
      }
      return RESULT;
    },
    /**
     * 보유 상품이 바뀔 때마다 불립니다.
     * @param {'change'} event
     * @param {(payload: { owned: string[] }) => void} listener
     * @returns {() => void} 구독 해제
     */
    on(event, listener) {
      if (event !== "change") {
        throw new TypeError(`store event must be 'change': ${event}`);
      }
      if (typeof listener !== "function") {
        throw new TypeError("store listener must be a function.");
      }
      LISTENERS.add(listener);
      return () => LISTENERS.delete(listener);
    },
    /** 반복 호출할 수 있습니다. 이후 요청은 'disposed'로 막힙니다. */
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      LISTENERS.clear();
      adapter.dispose?.();
    }
  };
}
export {
  createStore
};
