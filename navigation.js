// modules/navigation/navigation.js
function createNavigation({ window: host = globalThis.window, normalize = (route) => route } = {}) {
  if (!host?.history || typeof normalize !== "function") {
    throw new TypeError("navigation host/normalize");
  }
  const SUBSCRIBERS = /* @__PURE__ */ new Set();
  let disposed = false;
  let revision = 0;
  const COPY = (route) => ({
    screen: route.screen,
    item: route.item,
    query: new URLSearchParams(route.query)
  });
  const CANONICAL = (route) => {
    const VALUE = normalize(
      COPY({
        screen: route.screen || "main",
        item: route.item ?? null,
        query: route.query
      })
    );
    return {
      screen: String(VALUE.screen || "main"),
      item: VALUE.item == null ? null : String(VALUE.item),
      query: new URLSearchParams(VALUE.screen === "main" ? "" : VALUE.query)
    };
  };
  const HASH = (route) => route.screen === "main" ? "" : "#/" + encodeURIComponent(route.screen) + (route.item ? "/" + encodeURIComponent(route.item) : "") + (route.query.size ? "?" + route.query : "");
  const READ = () => {
    const RAW = host.location.hash.replace(/^#\/?/, ""), SEPARATOR = RAW.indexOf("?");
    const PATH = SEPARATOR < 0 ? RAW : RAW.slice(0, SEPARATOR);
    const PARTS = PATH.split("/").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
    return CANONICAL({
      screen: PARTS[0],
      item: PARTS[1],
      query: SEPARATOR < 0 ? "" : RAW.slice(SEPARATOR + 1)
    });
  };
  let current = READ();
  function publish(next, source, force = false) {
    if (disposed || !force && HASH(next) === HASH(current)) {
      return;
    }
    const PREVIOUS = current, TOKEN = ++revision;
    current = next;
    for (const LISTENER of [...SUBSCRIBERS]) {
      if (disposed || TOKEN !== revision) {
        break;
      }
      if (SUBSCRIBERS.has(LISTENER)) {
        LISTENER(COPY(next), {
          previous: COPY(PREVIOUS),
          source
        });
      }
    }
  }
  function move(route, replace, { force = false } = {}) {
    if (disposed) {
      return;
    }
    const NEXT = CANONICAL(route), URL_LOCAL = new URL(host.location.href);
    URL_LOCAL.hash = HASH(NEXT);
    if (URL_LOCAL.href !== host.location.href) {
      host.history[replace ? "replaceState" : "pushState"](host.history.state, "", URL_LOCAL);
    }
    publish(NEXT, replace ? "replace" : "navigate", force);
  }
  const RESTORE = () => publish(READ(), "history");
  host.addEventListener("popstate", RESTORE);
  host.addEventListener("hashchange", RESTORE);
  return {
    navigate: (route, options) => move(route, false, options),
    replace: (route, options) => move(route, true, options),
    back() {
      if (!disposed) {
        host.history.back();
      }
    },
    snapshot: () => COPY(current),
    subscribe(listener, { immediate = false } = {}) {
      if (typeof listener !== "function") {
        throw new TypeError("navigation listener");
      }
      if (disposed) {
        return () => {
        };
      }
      SUBSCRIBERS.add(listener);
      if (immediate) {
        listener(COPY(current), {
          previous: null,
          source: "initial"
        });
      }
      return () => SUBSCRIBERS.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      host.removeEventListener("popstate", RESTORE);
      host.removeEventListener("hashchange", RESTORE);
      SUBSCRIBERS.clear();
    }
  };
}
export {
  createNavigation
};
