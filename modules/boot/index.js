// 게임 시작 로딩의 단계별 실제 개수와 전체 진행률을 한 곳에서 계산합니다.
// 시간·ETA를 추정하지 않습니다. 재시도는 게임 UI가 전체 페이지를 다시 읽는 것(location.reload())입니다.

function fail(message) {
    throw new Error(`boot: ${message}`);
}

const COUNT = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * @param {{ stages: { id: string, weight: number }[], onChange?: (state: object) => void }} options
 */
export function createBoot({ stages, onChange = null, ...rest }) {
    if (Object.keys(rest).length > 0) {
        fail(`unknown option ${Object.keys(rest)[0]}`);
    }
    if (!Array.isArray(stages) || stages.length === 0) {
        fail('stages must be a non-empty array');
    }
    if (onChange !== null && typeof onChange !== 'function') {
        fail('onChange must be a function');
    }
    const LISTENERS = new Set(onChange ? [onChange] : []);
    const STAGES = new Map();
    let weightSum = 0;
    for (const { id: ID, weight: WEIGHT } of stages) {
        if (typeof ID !== 'string' || !ID || STAGES.has(ID)) {
            fail(`stage id must be a unique non-empty string: ${ID}`);
        }
        if (!Number.isFinite(WEIGHT) || WEIGHT <= 0) {
            fail(`stage ${ID} weight must be a positive number`);
        }
        STAGES.set(ID, { weight: WEIGHT, begun: false, done: false, completed: 0, total: null });
        weightSum += WEIGHT;
    }
    let settled = null;
    let state = Object.freeze({ stage: null, completed: 0, total: null, overall: 0 });

    function overall() {
        let sum = 0;
        for (const STAGE of STAGES.values()) {
            if (STAGE.done) {
                sum += STAGE.weight;
            } else if (STAGE.total) {
                sum += (STAGE.weight * STAGE.completed) / STAGE.total;
            }
        }
        return Math.min(1, sum / weightSum);
    }
    function emit(id, extra = {}) {
        const STAGE = STAGES.get(id);
        state = Object.freeze({
            stage: id,
            completed: STAGE?.completed ?? 0,
            total: STAGE?.total ?? null,
            overall: settled === 'complete' ? 1 : overall(),
            ...extra,
        });
        for (const LISTENER of LISTENERS) {
            LISTENER(state);
        }
    }
    function owned(id) {
        const STAGE = STAGES.get(id);
        if (!STAGE) {
            fail(`unknown stage ${id}`);
        }
        return STAGE;
    }
    function running(id) {
        const STAGE = owned(id);
        if (!STAGE.begun) {
            fail(`stage ${id} has not begun`);
        }
        if (STAGE.done) {
            fail(`stage ${id} has already finished`);
        }
        return STAGE;
    }
    // 정상 종료(complete)나 실패(fail) 뒤의 늦은 보고는 무시합니다. 화면 상태는 끝난 값으로 고정됩니다.
    const BOOT = {
        get state() {
            return state;
        },
        subscribe(listener) {
            if (typeof listener !== 'function') {
                fail('listener must be a function');
            }
            LISTENERS.add(listener);
            return () => LISTENERS.delete(listener);
        },
        begin(id, total = null) {
            if (settled) {
                return;
            }
            const STAGE = owned(id);
            if (STAGE.begun) {
                fail(`stage ${id} has already begun`);
            }
            if (total !== null && !COUNT(total)) {
                fail(`stage ${id} total must be a non-negative integer or null`);
            }
            STAGE.begun = true;
            STAGE.total = total;
            STAGE.done = total === 0;
            emit(id);
        },
        advance(id, count = 1) {
            if (settled) {
                return;
            }
            const STAGE = running(id);
            if (!COUNT(count) || count === 0) {
                fail(`stage ${id} advance count must be a positive integer`);
            }
            if (STAGE.total !== null && STAGE.completed + count > STAGE.total) {
                fail(`stage ${id} advanced past its total ${STAGE.total}`);
            }
            STAGE.completed += count;
            STAGE.done = STAGE.completed === STAGE.total;
            emit(id);
        },
        finish(id) {
            if (settled) {
                return;
            }
            const STAGE = running(id);
            if (STAGE.total !== null && STAGE.completed !== STAGE.total) {
                fail(`stage ${id} finished at ${STAGE.completed}/${STAGE.total}`);
            }
            STAGE.done = true;
            emit(id);
        },
        complete() {
            if (settled) {
                return;
            }
            settled = 'complete';
            emit(state.stage);
        },
        fail(error) {
            if (settled) {
                return;
            }
            settled = 'failed';
            emit(state.stage, { failed: error instanceof Error ? error : new Error(String(error)) });
        },
        async preloadModules(urls, { stage, ...extra } = {}) {
            if (Object.keys(extra).length > 0) {
                fail(`unknown preloadModules option ${Object.keys(extra)[0]}`);
            }
            if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string' || !url)) {
                fail('preloadModules urls must be an array of non-empty strings');
            }
            // import()가 쓰는 주소와 같은 절대 URL이어야 브라우저 module map의 결과를 다시 씁니다.
            const HREFS = [...new Set(urls.map((url) => new URL(url, document.baseURI).href))];
            BOOT.begin(stage, HREFS.length);
            const FAILURES = [];
            const DONE = (href, ok) => {
                if (ok) {
                    BOOT.advance(stage);
                } else {
                    FAILURES.push(href);
                }
            };
            await Promise.all(HREFS.map((href) => (MODULEPRELOAD() ? preloadLink : preloadFetch)(href, DONE)));
            if (FAILURES.length > 0) {
                fail(`module preload failed (${FAILURES.length}/${HREFS.length}): ${FAILURES[0]}`);
            }
        },
        async importPinnedModules(pin, { stage, ...extra } = {}) {
            if (Object.keys(extra).length > 0) {
                fail(`unknown importPinnedModules option ${Object.keys(extra)[0]}`);
            }
            const { base: BASE, modules: MODULES, ...REST } = pin ?? {};
            if (Object.keys(REST).length > 0) {
                fail(`unknown importPinnedModules pin field ${Object.keys(REST)[0]}`);
            }
            if (typeof BASE !== 'string' || !BASE.endsWith('/')) {
                fail('importPinnedModules base must be a URL string ending with /');
            }
            const ENTRIES = Object.entries(MODULES ?? {});
            for (const [NAME, ENTRY] of ENTRIES) {
                if (typeof ENTRY?.file !== 'string' || !ENTRY.file || !/^[a-f0-9]{64}$/.test(ENTRY.sha256 ?? '')) {
                    fail(`importPinnedModules entry ${NAME} needs file and a lowercase hex sha256`);
                }
            }
            BOOT.begin(stage, ENTRIES.length);
            const FAILURES = [];
            const LOADED = await Promise.all(
                ENTRIES.map(async ([name, entry]) => {
                    try {
                        const NAMESPACE = await importVerified(new URL(entry.file, BASE).href, entry.sha256);
                        BOOT.advance(stage);
                        return [name, NAMESPACE];
                    } catch (error) {
                        FAILURES.push(`${name}: ${error?.message ?? error}`);
                        return null;
                    }
                }),
            );
            if (FAILURES.length > 0) {
                fail(`pinned module import failed (${FAILURES.length}/${ENTRIES.length}): ${FAILURES[0]}`);
            }
            return Object.freeze(Object.fromEntries(LOADED));
        },
    };
    return Object.freeze(BOOT);
}

// 받은 bytes의 SHA-256이 고정값과 같을 때만 그 bytes를 실행합니다. blob URL로 import하므로 파일은 상대 import가 없는
// 단일 파일이어야 하고, 같은 파일을 다른 주소로 import하면 별개의 모듈 인스턴스가 됩니다. DOM을 쓰지 않아 Worker에서도 됩니다.
async function importVerified(href, sha256) {
    const RESPONSE = await fetch(href);
    if (!RESPONSE.ok) {
        throw new Error(`HTTP ${RESPONSE.status} ${href}`);
    }
    const BYTES = await RESPONSE.arrayBuffer();
    const DIGEST = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', BYTES)), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    if (DIGEST !== sha256) {
        throw new Error(`SHA-256 mismatch ${href}`);
    }
    const OBJECT_URL = URL.createObjectURL(new Blob([BYTES], { type: 'text/javascript' }));
    try {
        return await import(OBJECT_URL);
    } finally {
        URL.revokeObjectURL(OBJECT_URL);
    }
}

let modulepreload = null;
const MODULEPRELOAD = () => (modulepreload ??= document.createElement('link').relList.supports('modulepreload'));

// 문서의 module map에 넣으므로 같은 URL의 import()는 네트워크를 다시 쓰지 않습니다. load는 그 파일 하나의 수신·파싱 완료입니다.
function preloadLink(href, done) {
    return new Promise((resolve) => {
        const LINK = document.createElement('link');
        LINK.rel = 'modulepreload';
        LINK.href = href;
        LINK.onload = LINK.onerror = (event) => {
            LINK.remove();
            done(href, event.type === 'load');
            resolve();
        };
        document.head.append(LINK);
    });
}

// modulepreload를 모르는 브라우저: HTTP 캐시만 데웁니다. 이후 import()의 재사용은 캐시 정책에 달려 있습니다.
async function preloadFetch(href, done) {
    let ok = false;
    try {
        const RESPONSE = await fetch(href, { credentials: 'same-origin' });
        await RESPONSE.arrayBuffer();
        ok = RESPONSE.ok;
    } catch {
        // 실패한 주소는 done(false)로 모아 preloadModules가 한 번에 던집니다.
    }
    done(href, ok);
}

/**
 * 진행 상태를 `<progress>`와 글자 요소에 그립니다. `text`를 주면 글자는 게임이 전부 정합니다.
 * `text`가 없으면 기본 문구 `이름 n/N · P%`를 씁니다. 이름은 `labels[단계]`(없으면 단계 id), 개수를 모르는 단계는
 * `이름 · P%`, 끝나면 `done`(있을 때), 실패하면 오류 문장입니다. 첫 단계가 시작되기 전에는 글자 요소를 건드리지 않습니다.
 * 반환한 함수를 부르면 이후 갱신을 멈춥니다. 요소는 지우거나 숨기지 않습니다.
 */
export function bindBootProgress(boot, { progress, label = null, text = null, labels = null, done = null, ...rest }) {
    if (Object.keys(rest).length > 0) {
        fail(`unknown bindBootProgress option ${Object.keys(rest)[0]}`);
    }
    if (!(progress instanceof HTMLProgressElement)) {
        fail('progress must be a <progress> element');
    }
    if (text !== null && typeof text !== 'function') {
        fail('text must be a function');
    }
    if (text !== null && (labels !== null || done !== null)) {
        fail('labels and done belong to the default text; do not combine them with text');
    }
    if (
        labels !== null &&
        (typeof labels !== 'object' || Object.values(labels).some((name) => typeof name !== 'string'))
    ) {
        fail('labels must map stage ids to strings');
    }
    if (done !== null && typeof done !== 'string') {
        fail('done must be a string');
    }
    progress.max = 1;
    const TEXT = text ?? ((state) => defaultText(state, labels, done));
    const RENDER = (state) => {
        progress.value = state.overall;
        if (label) {
            const VALUE = TEXT(state);
            if (VALUE !== null) {
                label.textContent = VALUE;
            }
        }
    };
    RENDER(boot.state);
    return boot.subscribe(RENDER);
}

// null은 "글자 요소를 그대로 둔다"입니다. 첫 단계 전에는 게임이 HTML에 써 둔 문구가 남습니다.
function defaultText(state, labels, done) {
    if (state.failed) {
        return String(state.failed.message || state.failed);
    }
    if (!state.stage) {
        return null;
    }
    if (state.overall === 1 && done !== null) {
        return done;
    }
    const NAME = labels?.[state.stage] ?? state.stage;
    const COUNT = state.total === null ? '' : ` ${state.completed}/${state.total}`;
    return `${NAME}${COUNT} · ${Math.round(state.overall * 100)}%`;
}

/** 다음 화면 갱신 기회까지 기다립니다. 숨긴 탭처럼 rAF가 멈춰도 80ms 뒤에는 이어갑니다. */
export function yieldFrame() {
    return new Promise((resolve) => {
        const DONE = () => {
            clearTimeout(TIMER);
            cancelAnimationFrame(FRAME);
            resolve();
        };
        const TIMER = setTimeout(DONE, 80);
        const FRAME = requestAnimationFrame(() => setTimeout(DONE, 0));
    });
}
