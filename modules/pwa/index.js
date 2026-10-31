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
        disposed = false;
    const CONTAINER = navigator.serviceWorker;
    const REPORT = (error) => {
        if (!disposed) {
            onError(error);
        }
    };
    const WATCH = (worker) => {
        if (!worker) {
            return;
        }
        let installed = false;
        worker.addEventListener('statechange', () => {
            if (disposed) {
                return;
            }
            if (worker.state === 'installed') {
                installed = true;
                // controller가 없으면 첫 설치입니다. 기다리는 새 버전이 아닙니다.
                if (CONTAINER.controller && notified !== worker) {
                    notified = worker;
                    onUpdate();
                }
            } else if (worker.state === 'redundant' && !installed) {
                REPORT(new Error(`service worker failed to install: ${worker.scriptURL}`));
            }
        });
    };
    const ON_UPDATE_FOUND = () => WATCH(registration.installing);
    const ON_CONTROLLER_CHANGE = () => {
        if (updating && !disposed) {
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
    const PWA = {
        /** `beforeinstallprompt`를 받은 뒤에만 true입니다. */
        get installable() {
            return installPrompt !== null;
        },
        /** 설치 창을 띄우고 'accepted' 또는 'dismissed'를 돌려줍니다. 설치 창은 한 번만 쓸 수 있습니다. */
        async install() {
            if (installPrompt === null) {
                throw new Error('PWA is not installable yet (no beforeinstallprompt)');
            }
            const PROMPT = installPrompt;
            installPrompt = null;
            await PROMPT.prompt();
            return (await PROMPT.userChoice).outcome;
        },
        /** 기다리는 새 worker를 활성화하고, 그 worker가 페이지를 넘겨받으면 다시 읽습니다. */
        async update() {
            const WAITING = registration?.waiting;
            if (!WAITING) {
                throw new Error('no waiting service worker to activate');
            }
            updating = true;
            WAITING.postMessage({ type: ACTIVATE_MESSAGE });
        },
        /** 이벤트 구독을 끊습니다. 등록된 service worker는 그대로 둡니다. */
        dispose() {
            disposed = true;
            window.removeEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
            window.removeEventListener('appinstalled', ON_INSTALLED);
            CONTAINER?.removeEventListener('controllerchange', ON_CONTROLLER_CHANGE);
            registration?.removeEventListener('updatefound', ON_UPDATE_FOUND);
        },
    };
    window.addEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
    window.addEventListener('appinstalled', ON_INSTALLED);
    if (!CONTAINER) {
        // http 주소·일부 사생활 보호 모드. 게임이 알림 여부를 정합니다.
        queueMicrotask(() => REPORT(new Error('service workers are not available on this page')));
        return PWA;
    }
    CONTAINER.addEventListener('controllerchange', ON_CONTROLLER_CHANGE);
    CONTAINER.register(serviceWorker).then(
        (value) => {
            if (disposed) {
                return;
            }
            if (!value) {
                // 자동화 브라우저가 service worker를 막으면 register가 오류 없이 빈 값으로 끝납니다.
                REPORT(new Error('service worker registration was blocked by the browser'));
                return;
            }
            registration = value;
            registration.addEventListener('updatefound', ON_UPDATE_FOUND);
            WATCH(registration.installing);
            if (registration.waiting && CONTAINER.controller) {
                notified = registration.waiting;
                onUpdate();
            }
        },
        (error) => REPORT(error),
    );
    return PWA;
}
