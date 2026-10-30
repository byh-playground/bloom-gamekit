// modules/bm/adapters/google-ads/index.js
var SCRIPT_URL = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
var INTERSTITIAL_TYPES = Object.freeze(["next", "start", "pause", "browse"]);
function outcomeFromStatus(type, status) {
  if (status === "viewed") {
    return type === "rewarded" ? "rewarded" : "viewed";
  }
  if (status === "dismissed") {
    return "dismissed";
  }
  return status === "error" ? "error" : "unavailable";
}
function createGoogleAdsAdapter({
  clientId,
  testMode = false,
  sound = "on",
  interstitialType = "next",
  loadScript = true,
  readyTimeoutMs = 5e3,
  onRewardReady = null
} = {}) {
  if (typeof clientId !== "string" || !/^ca-pub-\d+$/.test(clientId)) {
    throw new TypeError("google-ads clientId must look like 'ca-pub-123456789'.");
  }
  if (!INTERSTITIAL_TYPES.includes(interstitialType)) {
    throw new TypeError(`google-ads interstitialType must be one of ${INTERSTITIAL_TYPES.join(", ")}.`);
  }
  let ready = false;
  let readyPromise = null;
  function ensureReady() {
    readyPromise ??= new Promise((resolve) => {
      globalThis.adsbygoogle = globalThis.adsbygoogle || [];
      if (typeof globalThis.adBreak !== "function") {
        const PUSH = (options) => globalThis.adsbygoogle.push(options);
        globalThis.adBreak = PUSH;
        globalThis.adConfig = PUSH;
      }
      if (loadScript && !document.querySelector(`script[src^="${SCRIPT_URL}"]`)) {
        const SCRIPT = document.createElement("script");
        SCRIPT.async = true;
        SCRIPT.crossOrigin = "anonymous";
        SCRIPT.src = `${SCRIPT_URL}?client=${encodeURIComponent(clientId)}`;
        if (testMode) {
          SCRIPT.setAttribute("data-adbreak-test", "on");
        }
        SCRIPT.onerror = () => resolve(false);
        document.head.append(SCRIPT);
      }
      const TIMER = setTimeout(() => resolve(false), readyTimeoutMs);
      globalThis.adConfig({
        sound,
        preloadAdBreaks: "on",
        onReady() {
          ready = true;
          clearTimeout(TIMER);
          resolve(true);
        }
      });
    });
    return readyPromise;
  }
  return {
    id: "google-ads",
    /** SDK 준비 여부를 돌려줍니다. 광고 한 편이 준비됐는지는 Google이 알려 주지 않습니다. */
    async load() {
      await ensureReady();
      return ready;
    },
    show(placement, type) {
      ensureReady();
      return new Promise((resolve) => {
        let outcome = null;
        const OPTIONS = {
          type: type === "rewarded" ? "reward" : interstitialType,
          name: placement,
          beforeAd() {
            outcome = type === "rewarded" ? outcome : "viewed";
          },
          adBreakDone(info) {
            resolve(outcome ?? outcomeFromStatus(type, info?.breakStatus));
          }
        };
        if (type === "rewarded") {
          OPTIONS.beforeReward = (showAdFn) => {
            if (onRewardReady) {
              onRewardReady(showAdFn);
            } else {
              showAdFn();
            }
          };
          OPTIONS.adViewed = () => {
            outcome = "rewarded";
          };
          OPTIONS.adDismissed = () => {
            outcome = "dismissed";
          };
        }
        globalThis.adBreak(OPTIONS);
      });
    }
  };
}
export {
  createGoogleAdsAdapter
};
