// modules/bm/adapters/ima/index.js
var SDK_URL = "https://imasdk.googleapis.com/js/sdkloader/ima3.js";
var IMA_SAMPLE_TAGS = Object.freeze({
  linear: "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=",
  skippable: "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_preroll_skippable&sz=640x480&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=",
  vertical: "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_vertical_ad_samples&sz=360x640&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=",
  redirectError: "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dredirecterror&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&nofb=1&correlator="
});
function withCorrelator(url) {
  return url.replace(/correlator=(?=&|$)/, `correlator=${Math.floor(Math.random() * 1e12)}`);
}
function createImaAdapter({
  adTagUrl,
  loadScript = true,
  loadTimeoutMs = 1e4,
  playTimeoutMs = 1e5,
  zIndex = 2147483647,
  resumeLabel = "광고 계속 보기",
  closeLabel = "광고 닫기"
} = {}) {
  if (typeof adTagUrl !== "function" && !(typeof adTagUrl === "string" && adTagUrl.startsWith("https://"))) {
    throw new TypeError("ima adTagUrl must be an https URL string or a function returning one.");
  }
  for (const [NAME, VALUE] of [
    ["loadTimeoutMs", loadTimeoutMs],
    ["playTimeoutMs", playTimeoutMs]
  ]) {
    if (!Number.isFinite(VALUE) || VALUE <= 0) {
      throw new RangeError(`ima ${NAME} must be a positive finite number.`);
    }
  }
  let sdkPromise = null;
  function ensureSdk() {
    if (globalThis.google?.ima) {
      return Promise.resolve(true);
    }
    if (!loadScript) {
      return Promise.resolve(false);
    }
    sdkPromise ??= new Promise((resolve) => {
      const SCRIPT = document.createElement("script");
      SCRIPT.async = true;
      SCRIPT.src = SDK_URL;
      SCRIPT.onload = () => resolve(Boolean(globalThis.google?.ima));
      SCRIPT.onerror = () => {
        sdkPromise = null;
        resolve(false);
      };
      document.head.append(SCRIPT);
    });
    return sdkPromise;
  }
  function run(placement, type) {
    return new Promise((resolve) => {
      const IMA = globalThis.google.ima;
      const OVERLAY = document.createElement("div");
      OVERLAY.style.cssText = `position:fixed;inset:0;background:#000;z-index:${zIndex}`;
      const SLOT = document.createElement("div");
      SLOT.style.cssText = "position:absolute;inset:0";
      const VIDEO = document.createElement("video");
      VIDEO.setAttribute("playsinline", "");
      VIDEO.style.cssText = "position:absolute;width:1px;height:1px;opacity:0";
      const RESUME = document.createElement("button");
      RESUME.type = "button";
      RESUME.textContent = resumeLabel;
      RESUME.hidden = true;
      RESUME.style.cssText = "position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:1;min-width:200px;min-height:56px;padding:0 24px;font:600 18px system-ui,sans-serif;color:#fff;background:#1a73e8;border:0;border-radius:28px";
      const CLOSE = document.createElement("button");
      CLOSE.type = "button";
      CLOSE.textContent = closeLabel;
      CLOSE.style.cssText = "position:absolute;top:12px;right:12px;z-index:1;min-width:96px;min-height:56px;padding:0 16px;font:600 16px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.6);border-radius:28px";
      CLOSE.addEventListener("click", () => finish("dismissed"));
      OVERLAY.append(SLOT, VIDEO, RESUME, CLOSE);
      document.body.append(OVERLAY);
      let manager = null;
      let started = false;
      let done = false;
      let timer = null;
      let paused = false;
      function onResize() {
        manager?.resize(globalThis.innerWidth, globalThis.innerHeight);
      }
      function resume() {
        try {
          manager?.resume();
        } catch {
        }
      }
      function onReturn() {
        if (paused && !document.hidden) {
          resume();
        }
      }
      RESUME.addEventListener("click", resume);
      function finish(outcome) {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        globalThis.removeEventListener("resize", onResize);
        globalThis.removeEventListener("focus", onReturn);
        document.removeEventListener("visibilitychange", onReturn);
        try {
          manager?.destroy();
        } catch {
        }
        OVERLAY.remove();
        resolve(outcome);
      }
      function completed() {
        return type === "rewarded" ? "rewarded" : "viewed";
      }
      function failed() {
        finish(started ? "error" : "unavailable");
      }
      try {
        const WIDTH = globalThis.innerWidth;
        const HEIGHT = globalThis.innerHeight;
        const CONTAINER = new IMA.AdDisplayContainer(SLOT, VIDEO);
        CONTAINER.initialize();
        const LOADER = new IMA.AdsLoader(CONTAINER);
        LOADER.addEventListener(IMA.AdErrorEvent.Type.AD_ERROR, failed);
        LOADER.addEventListener(IMA.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (event) => {
          try {
            manager = event.getAdsManager(VIDEO);
            const TYPES = IMA.AdEvent.Type;
            manager.addEventListener(IMA.AdErrorEvent.Type.AD_ERROR, failed);
            manager.addEventListener(TYPES.STARTED, () => {
              started = true;
              clearTimeout(timer);
              timer = setTimeout(() => finish("error"), playTimeoutMs);
            });
            manager.addEventListener(TYPES.PAUSED, () => {
              paused = true;
              RESUME.hidden = false;
            });
            for (const NAME of [TYPES.RESUMED, TYPES.STARTED]) {
              manager.addEventListener(NAME, () => {
                paused = false;
                RESUME.hidden = true;
              });
            }
            manager.addEventListener(TYPES.COMPLETE, () => finish(completed()));
            manager.addEventListener(TYPES.SKIPPED, () => finish("dismissed"));
            manager.addEventListener(TYPES.USER_CLOSE, () => finish("dismissed"));
            manager.addEventListener(
              TYPES.ALL_ADS_COMPLETED,
              () => finish(started ? completed() : "unavailable")
            );
            globalThis.addEventListener("resize", onResize);
            globalThis.addEventListener("focus", onReturn);
            document.addEventListener("visibilitychange", onReturn);
            manager.init(WIDTH, HEIGHT);
            manager.start();
          } catch {
            failed();
          }
        });
        timer = setTimeout(() => finish("unavailable"), loadTimeoutMs);
        const REQUEST = new IMA.AdsRequest();
        const TAG = typeof adTagUrl === "function" ? adTagUrl(placement, type) : adTagUrl;
        REQUEST.adTagUrl = withCorrelator(TAG);
        REQUEST.linearAdSlotWidth = WIDTH;
        REQUEST.linearAdSlotHeight = HEIGHT;
        LOADER.requestAds(REQUEST);
      } catch {
        finish("error");
      }
    });
  }
  return {
    id: "ima",
    /** IMA SDK 스크립트가 준비되었는지 돌려줍니다. 광고 한 편이 준비되었는지는 알 수 없습니다. */
    load() {
      return ensureSdk();
    },
    show(placement, type) {
      if (globalThis.google?.ima) {
        return run(placement, type);
      }
      return ensureSdk().then((ready) => ready ? run(placement, type) : "unavailable");
    }
  };
}
export {
  IMA_SAMPLE_TAGS,
  createImaAdapter
};
