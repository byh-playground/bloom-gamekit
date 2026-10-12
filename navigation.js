// modules/navigation/navigation.js
function createNavigation({ window: host = globalThis.window, normalize = (route) => route } = {}) {
  if (!host?.history || typeof normalize !== "function") throw new TypeError("navigation host/normalize");
  const subscribers = /* @__PURE__ */ new Set();
  let disposed = false, revision = 0;
  const copy = (route) => ({ screen: route.screen, item: route.item, query: new URLSearchParams(route.query) });
  const canonical = (route) => {
    const value = normalize(copy({ screen: route.screen || "main", item: route.item ?? null, query: route.query }));
    return {
      screen: String(value.screen || "main"),
      item: value.item == null ? null : String(value.item),
      query: new URLSearchParams(value.screen === "main" ? "" : value.query)
    };
  };
  const hash = (route) => route.screen === "main" ? "" : "#/" + encodeURIComponent(route.screen) + (route.item ? "/" + encodeURIComponent(route.item) : "") + (route.query.size ? "?" + route.query : "");
  const read = () => {
    const raw = host.location.hash.replace(/^#\/?/, ""), separator = raw.indexOf("?");
    const path = separator < 0 ? raw : raw.slice(0, separator);
    const parts = path.split("/").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
    return canonical({ screen: parts[0], item: parts[1], query: separator < 0 ? "" : raw.slice(separator + 1) });
  };
  let current = read();
  function publish(next, source, force = false) {
    if (disposed || !force && hash(next) === hash(current)) return;
    const previous = current, token = ++revision;
    current = next;
    for (const listener of [...subscribers]) {
      if (disposed || token !== revision) break;
      if (subscribers.has(listener)) listener(copy(next), { previous: copy(previous), source });
    }
  }
  function move(route, replace, { force = false } = {}) {
    if (disposed) return;
    const next = canonical(route), url = new URL(host.location.href);
    url.hash = hash(next);
    if (url.href !== host.location.href) host.history[replace ? "replaceState" : "pushState"](host.history.state, "", url);
    publish(next, replace ? "replace" : "navigate", force);
  }
  const restore = () => publish(read(), "history");
  host.addEventListener("popstate", restore);
  host.addEventListener("hashchange", restore);
  return {
    navigate: (route, options) => move(route, false, options),
    replace: (route, options) => move(route, true, options),
    back() {
      if (!disposed) host.history.back();
    },
    snapshot: () => copy(current),
    subscribe(listener, { immediate = false } = {}) {
      if (typeof listener !== "function") throw new TypeError("navigation listener");
      if (disposed) return () => {
      };
      subscribers.add(listener);
      if (immediate) listener(copy(current), { previous: null, source: "initial" });
      return () => subscribers.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener("popstate", restore);
      host.removeEventListener("hashchange", restore);
      subscribers.clear();
    }
  };
}
export {
  createNavigation
};
