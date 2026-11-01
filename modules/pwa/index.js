// 게임 페이지에서 생성된 sw.js를 등록하고 설치·업데이트 알림을 게임에 넘기는 브라우저 runtime입니다.
// 무엇을 precache할지와 sw.js 내용은 build.js(`dist/pwa-build.mjs`)가 정합니다. 저장 데이터는 다루지 않습니다.

const ACTIVATE_MESSAGE = 'bloom-pwa:activate';

/**
 * @param {object} options
 * @param {string} options.serviceWorker 게임 origin의 sw.js 주소(예: './sw.js')
 * @param {() => void} options.onUpdate 새 버전이 설치되어 기다릴 때. 게임이 알림을 띄우고 `update()`를 부릅니다.
 * @param {(error: Error) => void} options.onError 등록·설치 실패, service worker 미지원
 * @param {() => void} [options.onInstallable] 브라우저가 설치를 허용했을 때(`beforeinstallprompt`)
 */
export function registerPwa({ serviceWorker, onUpdate, onError, onInstallable } = {}) {
    if (typeof serviceWorker !== 'string' || serviceWorker === '') {
        throw new TypeError('registerPwa serviceWorker must be the sw.js URL');
    }
    if (typeof onUpdate !== 'function' || typeof onError !== 'function') {
        throw new TypeError('registerPwa onUpdate and onError must be functions');
    }
    if (onInstallable !== undefined && typeof onInstallable !== 'function') {
        throw new TypeError('registerPwa onInstallable must be a function');
    }
    let registration = null,
        installPrompt = null,
        notified = null,
        updating = false,
        checking = null,
        cancelCheck = null,
        latestWorker = null,
        disposed = false;
    const CONTAINER = navigator.serviceWorker;
    const WORKERS = new Map();
    const COMPLETIONS = new WeakMap();
    const REPORTED = new WeakSet();
    const ASSERT_OPEN = () => {
        if (disposed) {
            throw new Error('PWA is disposed');
        }
    };
    const REPORT = (error) => {
        if (!disposed) {
            if (error && typeof error === 'object') {
                if (REPORTED.has(error)) {
                    return;
                }
                REPORTED.add(error);
            }
            onError(error);
        }
    };
    const WATCH = (worker) => {
        if (!worker) {
            return;
        }
        if (COMPLETIONS.has(worker)) {
            return COMPLETIONS.get(worker);
        }
        latestWorker = worker;
        let installed = false;
        let resolveCompletion, rejectCompletion;
        const COMPLETION = new Promise((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        COMPLETIONS.set(worker, COMPLETION);
        COMPLETION.catch(REPORT);
        const ON_STATE = () => {
            if (disposed) {
                return;
            }
            if (['installed', 'activating', 'activated'].includes(worker.state)) {
                installed = true;
                resolveCompletion();
                // controller가 없으면 첫 설치입니다. 기다리는 새 버전이 아닙니다.
                if (worker.state === 'installed' && CONTAINER.controller && notified !== worker) {
                    notified = worker;
                    onUpdate();
                }
            } else if (worker.state === 'redundant' && !installed) {
                rejectCompletion(new Error(`service worker failed to install: ${worker.scriptURL}`));
            }
            if (worker.state === 'redundant' || worker.state === 'activated') {
                worker.removeEventListener('statechange', ON_STATE);
                WORKERS.delete(worker);
            }
        };
        WORKERS.set(worker, { listener: ON_STATE, cancel: rejectCompletion });
        worker.addEventListener('statechange', ON_STATE);
        ON_STATE();
        return COMPLETION;
    };
    const ON_UPDATE_FOUND = () => WATCH(registration.installing);
    const ON_CONTROLLER_CHANGE = () => {
        if (updating && !disposed) {
            updating = false;
            location.reload();
        }
    };
    const ON_BEFORE_INSTALL = (event) => {
        // 브라우저 기본 배너 대신 게임이 정한 때에 install()로 띄웁니다.
        event.preventDefault();
        installPrompt = event;
        onInstallable?.();
    };
    const ON_INSTALLED = () => {
        installPrompt = null;
    };
    const ON_RECHECK = () => {
        if (!disposed && !document.hidden && navigator.onLine !== false && !checking) {
            PWA.checkForUpdate().catch(REPORT);
        }
    };
    const PWA = {
        /** `beforeinstallprompt`를 받은 뒤에만 true입니다. */
        get installable() {
            return installPrompt !== null;
        },
        /** 설치 창을 띄우고 'accepted' 또는 'dismissed'를 돌려줍니다. 설치 창은 한 번만 쓸 수 있습니다. */
        async install() {
            ASSERT_OPEN();
            if (installPrompt === null) {
                throw new Error('PWA is not installable yet (no beforeinstallprompt)');
            }
            const PROMPT = installPrompt;
            installPrompt = null;
            await PROMPT.prompt();
            return (await PROMPT.userChoice).outcome;
        },
        /** 등록·재확인과 발견된 worker의 설치를 기다립니다. 최신 버전 여부는 반환하지 않습니다. */
        checkForUpdate() {
            if (disposed) {
                return Promise.reject(new Error('PWA is disposed'));
            }
            if (checking) {
                return checking;
            }
            const REQUEST = READY.then(async (value) => {
                ASSERT_OPEN();
                if (navigator.onLine === false) {
                    throw new Error('cannot check for a PWA update while offline');
                }
                const BEFORE = latestWorker,
                    INSTALLING = value.installing;
                await value.update();
                ASSERT_OPEN();
                // An installer can fail before update() resolves and disappear
                // from registration.installing. Keep that attempt's completion.
                await WATCH(value.installing || (latestWorker !== BEFORE ? latestWorker : INSTALLING));
                ASSERT_OPEN();
            });
            const CHECK = new Promise((resolve, reject) => {
                cancelCheck = reject;
                REQUEST.then(resolve, reject);
            });
            checking = CHECK;
            const CLEAR = () => {
                if (checking === CHECK) {
                    checking = null;
                    cancelCheck = null;
                }
            };
            CHECK.then(CLEAR, CLEAR);
            return CHECK;
        },
        /** 기다리는 새 worker를 활성화하고, 그 worker가 페이지를 넘겨받으면 다시 읽습니다. */
        async update() {
            ASSERT_OPEN();
            await READY;
            ASSERT_OPEN();
            if (updating) {
                return;
            }
            const WAITING = registration?.waiting;
            if (!WAITING) {
                throw new Error('no waiting service worker to activate');
            }
            updating = true;
            try {
                WAITING.postMessage({ type: ACTIVATE_MESSAGE });
            } catch (error) {
                updating = false;
                throw error;
            }
        },
        /** 이벤트 구독을 끊습니다. 등록된 service worker는 그대로 둡니다. */
        dispose() {
            disposed = true;
            cancelCheck?.(new Error('PWA is disposed'));
            installPrompt = null;
            window.removeEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
            window.removeEventListener('appinstalled', ON_INSTALLED);
            CONTAINER?.removeEventListener('controllerchange', ON_CONTROLLER_CHANGE);
            registration?.removeEventListener('updatefound', ON_UPDATE_FOUND);
            window.removeEventListener('online', ON_RECHECK);
            document.removeEventListener('visibilitychange', ON_RECHECK);
            for (const [WORKER, ENTRY] of WORKERS) {
                WORKER.removeEventListener('statechange', ENTRY.listener);
                ENTRY.cancel(new Error('PWA is disposed'));
            }
            WORKERS.clear();
            latestWorker = null;
        },
    };
    window.addEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
    window.addEventListener('appinstalled', ON_INSTALLED);
    CONTAINER?.addEventListener('controllerchange', ON_CONTROLLER_CHANGE);
    window.addEventListener('online', ON_RECHECK);
    document.addEventListener('visibilitychange', ON_RECHECK);
    const READY = (
        CONTAINER
            ? CONTAINER.register(serviceWorker, { updateViaCache: 'none' })
            : Promise.reject(new Error('service workers are not available on this page'))
    ).then((value) => {
        if (disposed) {
            return value;
        }
        if (!value) {
            // 자동화 브라우저가 service worker를 막으면 register가 오류 없이 빈 값으로 끝납니다.
            throw new Error('service worker registration was blocked by the browser');
        }
        registration = value;
        registration.addEventListener('updatefound', ON_UPDATE_FOUND);
        WATCH(registration.installing);
        if (registration.waiting && CONTAINER.controller && notified !== registration.waiting) {
            notified = registration.waiting;
            onUpdate();
        }
        return registration;
    });
    READY.catch(REPORT);
    return PWA;
}
