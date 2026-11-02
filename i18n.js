// modules/i18n/index.js
function fail(message) {
  throw new Error(`i18n: ${message}`);
}
function resolveLocale({ locales, fallback, requested = null, saved = null, languages = [] }) {
  for (const CANDIDATE of [requested, saved]) {
    if (locales.includes(CANDIDATE)) {
      return CANDIDATE;
    }
  }
  for (const LANGUAGE of languages) {
    const PRIMARY = String(LANGUAGE).toLowerCase().split("-")[0];
    if (locales.includes(PRIMARY)) {
      return PRIMARY;
    }
  }
  return fallback;
}
function readStorage(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function createLocale({
  locales,
  fallback,
  storageKey,
  param = "lang",
  isolated = false,
  location = globalThis.location,
  navigator = globalThis.navigator,
  storage = globalThis.localStorage ?? null,
  document = globalThis.document,
  ...rest
}) {
  if (Object.keys(rest).length > 0) {
    fail(`unknown option ${Object.keys(rest)[0]}`);
  }
  if (!Array.isArray(locales) || locales.length === 0 || new Set(locales).size !== locales.length) {
    fail("locales must be a non-empty array of unique codes");
  }
  if (!locales.includes(fallback)) {
    fail(`fallback ${fallback} is not one of locales`);
  }
  if (typeof storageKey !== "string" || !storageKey) {
    fail("storageKey must be a non-empty string");
  }
  const LOCALES = Object.freeze([...locales]);
  const LOCALE = resolveLocale({
    locales: LOCALES,
    fallback,
    requested: new URLSearchParams(location.search).get(param),
    // 격리 장면(디버그 주소·소개영상 iframe·시험)은 저장한 선택을 읽지도 쓰지도 않습니다.
    saved: isolated ? null : readStorage(storage, storageKey),
    languages: navigator?.languages?.length ? navigator.languages : [navigator?.language]
  });
  const NUMBER_FORMAT = new Intl.NumberFormat(LOCALE);
  const PLURAL_RULES = new Intl.PluralRules(LOCALE);
  function isTextPair(value) {
    return !!value && typeof value === "object" && Object.keys(value).length === LOCALES.length && LOCALES.every((code) => ["string", "function"].includes(typeof value[code]));
  }
  function text(pair, values) {
    if (!isTextPair(pair)) {
      fail(`not a text pair of ${LOCALES.join(", ")}: ${JSON.stringify(pair)}`);
    }
    const TEXT = pair[LOCALE];
    return typeof TEXT === "function" ? TEXT(values ?? {}) : TEXT;
  }
  function messages(table) {
    const ENTRIES = Object.entries(table ?? {});
    for (const [KEY, PAIR] of ENTRIES) {
      if (!isTextPair(PAIR)) {
        fail(`message ${KEY} must define exactly ${LOCALES.join(", ")}`);
      }
    }
    const RESOLVED = Object.freeze(
      Object.fromEntries(ENTRIES.map(([key, pair]) => [key, (values) => text(pair, values)]))
    );
    return new Proxy(RESOLVED, {
      get(target, key) {
        if (typeof key === "string" && !Object.hasOwn(target, key)) {
          fail(`unknown message ${key}`);
        }
        return target[key];
      }
    });
  }
  function applyPage(root, table) {
    if (document?.documentElement) {
      document.documentElement.lang = LOCALE;
    }
    for (const ELEMENT of root.querySelectorAll("*")) {
      for (const NAME of ELEMENT.getAttributeNames()) {
        if (!NAME.startsWith("data-i18n")) {
          continue;
        }
        const VALUE = table[ELEMENT.getAttribute(NAME)]();
        if (NAME === "data-i18n") {
          ELEMENT.textContent = VALUE;
        } else {
          ELEMENT.setAttribute(NAME.slice("data-i18n-".length), VALUE);
        }
      }
    }
  }
  function choose(code) {
    if (!LOCALES.includes(code)) {
      fail(`unsupported locale ${code}`);
    }
    if (!isolated) {
      try {
        storage?.setItem(storageKey, code);
      } catch {
      }
    }
    const URL_NOW = new URL(location.href);
    URL_NOW.searchParams.set(param, code);
    location.replace(URL_NOW.href);
  }
  return Object.freeze({
    locale: LOCALE,
    locales: LOCALES,
    text,
    messages,
    applyPage,
    choose,
    number: (value) => NUMBER_FORMAT.format(value),
    plural: (count, forms) => forms[PLURAL_RULES.select(count)] ?? forms.other
  });
}
export {
  createLocale,
  resolveLocale
};
