// modules/pwa/index.js
var OPTION_KEYS = /* @__PURE__ */ new Set(["serviceWorker", "onError", "onInstallable"]);
function registerPwa(options = {}) {
  for (const KEY of Object.keys(options)) {
    if (!OPTION_KEYS.has(KEY)) {
      throw new TypeError(`registerPwa unknown option "${KEY}"`);
    }
  }
  const { serviceWorker: SERVICE_WORKER, onError: ON_ERROR, onInstallable: ON_INSTALLABLE } = options;
  if (typeof SERVICE_WORKER !== "string" || SERVICE_WORKER === "") {
    throw new TypeError("registerPwa serviceWorker must be the sw.js URL");
  }
  if (typeof ON_ERROR !== "function") {
    throw new TypeError("registerPwa onError must be a function");
  }
  if (ON_INSTALLABLE !== void 0 && typeof ON_INSTALLABLE !== "function") {
    throw new TypeError("registerPwa onInstallable must be a function");
  }
  let installPrompt = null, disposed = false;
  const CONTAINER = navigator.serviceWorker;
  const ON_BEFORE_INSTALL = (event) => {
    event.preventDefault();
    installPrompt = event;
    ON_INSTALLABLE?.();
  };
  const ON_INSTALLED = () => {
    installPrompt = null;
  };
  const PWA = {
    /** `beforeinstallprompt`를 받은 뒤에만 true입니다. */
    get installable() {
      return installPrompt !== null;
    },
    /** 설치 창을 띄우고 'accepted' 또는 'dismissed'를 돌려줍니다. 설치 창은 한 번만 쓸 수 있습니다. */
    async install() {
      if (disposed) {
        throw new Error("PWA is disposed");
      }
      if (installPrompt === null) {
        throw new Error("PWA is not installable yet (no beforeinstallprompt)");
      }
      const PROMPT = installPrompt;
      installPrompt = null;
      await PROMPT.prompt();
      return (await PROMPT.userChoice).outcome;
    },
    /** 이벤트 구독을 끊습니다. 등록된 service worker는 그대로 둡니다. */
    dispose() {
      disposed = true;
      installPrompt = null;
      window.removeEventListener("beforeinstallprompt", ON_BEFORE_INSTALL);
      window.removeEventListener("appinstalled", ON_INSTALLED);
    }
  };
  window.addEventListener("beforeinstallprompt", ON_BEFORE_INSTALL);
  window.addEventListener("appinstalled", ON_INSTALLED);
  (CONTAINER ? CONTAINER.register(SERVICE_WORKER, { updateViaCache: "none" }) : Promise.reject(new Error("service workers are not available on this page"))).then((registration) => {
    if (!registration) {
      throw new Error("service worker registration was blocked by the browser");
    }
  }).catch((error) => {
    if (!disposed) {
      ON_ERROR(error);
    }
  });
  return PWA;
}
export {
  registerPwa
};
