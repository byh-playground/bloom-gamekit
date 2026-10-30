// modules/bm/index.js
var EVENTS = Object.freeze(["adstart", "adend"]);
var OUTCOMES = Object.freeze({
  rewarded: Object.freeze(["rewarded", "dismissed", "unavailable", "error"]),
  interstitial: Object.freeze(["viewed", "dismissed", "unavailable", "error"])
});
var SHOWN = Object.freeze(["rewarded", "viewed", "dismissed"]);
function defaultIsUserActive() {
  const ACTIVATION = globalThis.navigator?.userActivation;
  return ACTIVATION ? ACTIVATION.isActive : true;
}
function checkCount(value, name) {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`bm policy.${name} must be a non-negative safe integer or Infinity.`);
  }
}
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const TIMER = setTimeout(() => reject(new Error("bm adapter show timed out.")), ms);
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
function createBm({
  adapter,
  policy = {},
  suppress = null,
  showTimeoutMs = 12e4,
  requireUserActivation = true,
  isUserActive = defaultIsUserActive,
  now = () => Date.now()
} = {}) {
  if (!adapter || typeof adapter.id !== "string" || typeof adapter.load !== "function" || typeof adapter.show !== "function") {
    throw new TypeError("bm adapter must provide id, load() and show().");
  }
  const {
    interstitialCooldownMs: COOLDOWN_MS = 6e4,
    interstitialPerSession: INTERSTITIAL_CAP = Infinity,
    rewardedPerSession: REWARDED_CAP = Infinity
  } = policy;
  if (!Number.isFinite(COOLDOWN_MS) || COOLDOWN_MS < 0) {
    throw new RangeError("bm policy.interstitialCooldownMs must be a non-negative finite number.");
  }
  checkCount(INTERSTITIAL_CAP, "interstitialPerSession");
  checkCount(REWARDED_CAP, "rewardedPerSession");
  if (suppress !== null && typeof suppress !== "function") {
    throw new TypeError("bm suppress must be a function or null.");
  }
  if (!Number.isFinite(showTimeoutMs) || showTimeoutMs <= 0) {
    throw new RangeError("bm showTimeoutMs must be a positive finite number.");
  }
  const LIMITS = { rewarded: REWARDED_CAP, interstitial: INTERSTITIAL_CAP };
  const LISTENERS = { adstart: /* @__PURE__ */ new Set(), adend: /* @__PURE__ */ new Set() };
  const SHOWN_COUNT = { rewarded: 0, interstitial: 0 };
  const LOADED = { rewarded: null, interstitial: null };
  let busy = false;
  let disposed = false;
  let lastAdEndedAt = -Infinity;
  function emit(event, payload) {
    for (const LISTENER of [...LISTENERS[event]]) {
      try {
        LISTENER(payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
  function isSuppressed(type) {
    if (!suppress) {
      return false;
    }
    try {
      return suppress(type) === true;
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
      return false;
    }
  }
  function check(type) {
    if (!(type in LIMITS)) {
      throw new TypeError(`bm ad type must be 'rewarded' or 'interstitial': ${type}`);
    }
    if (disposed) {
      return { ok: false, reason: "disposed" };
    }
    if (isSuppressed(type)) {
      return { ok: false, reason: "suppressed" };
    }
    if (busy) {
      return { ok: false, reason: "busy" };
    }
    if (SHOWN_COUNT[type] >= LIMITS[type]) {
      return { ok: false, reason: "session-cap" };
    }
    if (type === "interstitial") {
      const WAIT = lastAdEndedAt + COOLDOWN_MS - now();
      if (WAIT > 0) {
        return { ok: false, reason: "cooldown", retryAfterMs: WAIT };
      }
    }
    return { ok: true };
  }
  async function show(type, placement) {
    const GATE = check(type);
    if (!GATE.ok) {
      return { status: "blocked", type, placement, reason: GATE.reason };
    }
    if (requireUserActivation && !isUserActive()) {
      return { status: "blocked", type, placement, reason: "no-user-activation" };
    }
    busy = true;
    emit("adstart", { type, placement });
    const RESULT = { status: "error", type, placement };
    try {
      const OUTCOME = await withTimeout(Promise.resolve(adapter.show(placement, type)), showTimeoutMs);
      if (OUTCOMES[type].includes(OUTCOME)) {
        RESULT.status = OUTCOME;
      } else {
        RESULT.reason = "invalid-outcome";
      }
    } catch (error) {
      RESULT.reason = "adapter-failed";
      RESULT.error = error;
    }
    busy = false;
    if (SHOWN.includes(RESULT.status)) {
      SHOWN_COUNT[type]++;
      lastAdEndedAt = now();
    }
    emit("adend", RESULT);
    return RESULT;
  }
  return {
    /** @returns {string} 연결된 어댑터 id */
    get adapterId() {
      return adapter.id;
    },
    /** 세션 동안 실제로 나온 광고 수와 마지막 광고 종료 시각입니다. 읽을 때만 새 객체를 만듭니다. */
    get stats() {
      return { shown: { ...SHOWN_COUNT }, lastAdEndedAt };
    },
    /**
     * 어댑터가 광고를 미리 준비합니다. 실패는 false로 돌려주며 던지지 않습니다.
     * @param {string} placement
     * @param {'rewarded' | 'interstitial'} [type='rewarded']
     * @returns {Promise<boolean>}
     */
    async preload(placement, type = "rewarded") {
      check(type);
      let ready = false;
      try {
        ready = await adapter.load(placement, type) === true;
      } catch {
      }
      LOADED[type] = ready;
      return ready;
    },
    /**
     * 정책과 마지막 preload 결과를 검사합니다. 사용자 입력 직후 여부는 show 시점에 판정합니다.
     * preload가 false였던 종류는 `not-ready`입니다. 아직 preload하지 않았으면 준비 여부를 모르므로 막지 않으며,
     * show는 준비 결과와 상관없이 시도해 `unavailable`로 끝납니다.
     */
    canShow(type) {
      const GATE = check(type);
      return GATE.ok && LOADED[type] === false ? { ok: false, reason: "not-ready" } : GATE;
    },
    /** 사용자가 직접 누른 입력 처리 안에서 호출합니다. 보상은 status가 'rewarded'일 때만 지급하세요. */
    showRewarded(placement) {
      return show("rewarded", placement);
    },
    showInterstitial(placement) {
      return show("interstitial", placement);
    },
    /**
     * @param {'adstart' | 'adend'} event
     * @param {(payload: object) => void} listener
     * @returns {() => void} 구독 해제
     */
    on(event, listener) {
      if (!EVENTS.includes(event)) {
        throw new TypeError(`bm event must be one of ${EVENTS.join(", ")}: ${event}`);
      }
      if (typeof listener !== "function") {
        throw new TypeError("bm listener must be a function.");
      }
      LISTENERS[event].add(listener);
      return () => LISTENERS[event].delete(listener);
    },
    /** 반복 호출할 수 있습니다. 이후 광고 요청은 'disposed'로 막힙니다. */
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      LISTENERS.adstart.clear();
      LISTENERS.adend.clear();
      adapter.dispose?.();
    }
  };
}
export {
  createBm
};
