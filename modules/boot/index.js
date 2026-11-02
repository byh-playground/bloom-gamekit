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
    };
    return Object.freeze(BOOT);
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
 * 진행 상태를 `<progress>`와 글자 요소에 그립니다. `text`가 없으면 `단계 n/N`을 씁니다.
 * 반환한 함수를 부르면 이후 갱신을 멈춥니다. 요소는 지우거나 숨기지 않습니다.
 */
export function bindBootProgress(boot, { progress, label = null, text = defaultText, ...rest }) {
    if (Object.keys(rest).length > 0) {
        fail(`unknown bindBootProgress option ${Object.keys(rest)[0]}`);
    }
    if (!(progress instanceof HTMLProgressElement)) {
        fail('progress must be a <progress> element');
    }
    progress.max = 1;
    const RENDER = (state) => {
        progress.value = state.overall;
        if (label) {
            label.textContent = text(state);
        }
    };
    RENDER(boot.state);
    return boot.subscribe(RENDER);
}

function defaultText(state) {
    if (!state.stage) {
        return '';
    }
    return state.total === null ? state.stage : `${state.stage} ${state.completed}/${state.total}`;
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
