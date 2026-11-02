// 페이지 언어와 화면 문구. 언어는 페이지를 읽을 때 한 번 정하고, 바꾸면 저장한 뒤 새로고침합니다(실행 중 재번역 없음).
// 문구 원본은 TextPair: 모든 언어를 한 객체에 나란히 둡니다. 값이 들어가는 문구는 언어마다 함수로 어순·조사를 직접 소유합니다.
//   { ko: '서브', en: 'Serve' }
//   { ko: ({ name }) => `${name} 선수가 팀에 합류했어요.`, en: ({ name }) => `${name} joined the team.` }

function fail(message) {
    throw new Error(`i18n: ${message}`);
}

/**
 * 요청(?lang=) → 저장한 선택 → 브라우저 언어(주 언어 부분, ko-KR → ko) → fallback 순으로 지원 언어 하나를 고릅니다.
 * @param {{ locales: string[], fallback: string, requested?: string | null, saved?: string | null, languages?: string[] }} options
 */
export function resolveLocale({ locales, fallback, requested = null, saved = null, languages = [] }) {
    for (const CANDIDATE of [requested, saved]) {
        if (locales.includes(CANDIDATE)) {
            return CANDIDATE;
        }
    }
    for (const LANGUAGE of languages) {
        const PRIMARY = String(LANGUAGE).toLowerCase().split('-')[0];
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
        // 저장소를 쓸 수 없는 환경(차단된 사이트 데이터 등)은 저장한 선택이 없는 것과 같습니다.
        return null;
    }
}

/**
 * @param {{ locales: string[], fallback: string, storageKey: string, param?: string, isolated?: boolean,
 *   location?: Location, navigator?: Navigator, storage?: Storage | null, document?: Document }} options
 */
export function createLocale({
    locales,
    fallback,
    storageKey,
    param = 'lang',
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
        fail('locales must be a non-empty array of unique codes');
    }
    if (!locales.includes(fallback)) {
        fail(`fallback ${fallback} is not one of locales`);
    }
    if (typeof storageKey !== 'string' || !storageKey) {
        fail('storageKey must be a non-empty string');
    }
    const LOCALES = Object.freeze([...locales]);
    const LOCALE = resolveLocale({
        locales: LOCALES,
        fallback,
        requested: new URLSearchParams(location.search).get(param),
        // 격리 장면(디버그 주소·소개영상 iframe·시험)은 저장한 선택을 읽지도 쓰지도 않습니다.
        saved: isolated ? null : readStorage(storage, storageKey),
        languages: navigator?.languages?.length ? navigator.languages : [navigator?.language],
    });
    const NUMBER_FORMAT = new Intl.NumberFormat(LOCALE);
    const PLURAL_RULES = new Intl.PluralRules(LOCALE);

    function isTextPair(value) {
        return (
            !!value &&
            typeof value === 'object' &&
            Object.keys(value).length === LOCALES.length &&
            LOCALES.every((code) => ['string', 'function'].includes(typeof value[code]))
        );
    }

    function text(pair, values) {
        if (!isTextPair(pair)) {
            fail(`not a text pair of ${LOCALES.join(', ')}: ${JSON.stringify(pair)}`);
        }
        const TEXT = pair[LOCALE];
        return typeof TEXT === 'function' ? TEXT(values ?? {}) : TEXT;
    }

    function messages(table) {
        const ENTRIES = Object.entries(table ?? {});
        for (const [KEY, PAIR] of ENTRIES) {
            if (!isTextPair(PAIR)) {
                fail(`message ${KEY} must define exactly ${LOCALES.join(', ')}`);
            }
        }
        const RESOLVED = Object.freeze(
            Object.fromEntries(ENTRIES.map(([key, pair]) => [key, (values) => text(pair, values)])),
        );
        // 없는 키는 undefined가 아니라 바로 오류입니다. 오타가 화면에 키 이름이나 빈칸으로 새지 않습니다.
        return new Proxy(RESOLVED, {
            get(target, key) {
                if (typeof key === 'string' && !Object.hasOwn(target, key)) {
                    fail(`unknown message ${key}`);
                }
                return target[key];
            },
        });
    }

    function applyPage(root, table) {
        if (document?.documentElement) {
            document.documentElement.lang = LOCALE;
        }
        for (const ELEMENT of root.querySelectorAll('*')) {
            for (const NAME of ELEMENT.getAttributeNames()) {
                if (!NAME.startsWith('data-i18n')) {
                    continue;
                }
                const VALUE = table[ELEMENT.getAttribute(NAME)]();
                if (NAME === 'data-i18n') {
                    ELEMENT.textContent = VALUE;
                } else {
                    ELEMENT.setAttribute(NAME.slice('data-i18n-'.length), VALUE);
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
                // 저장이 거부되어도 아래 ?lang= 주소로 이번 방문은 바뀝니다.
            }
        }
        // 이전 ?lang=이 새 선택을 덮지 않도록 주소에도 같은 값을 둡니다.
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
        plural: (count, forms) => forms[PLURAL_RULES.select(count)] ?? forms.other,
    });
}
