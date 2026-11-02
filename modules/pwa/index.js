// 게임 페이지에서 생성된 sw.js를 등록하고 설치 창을 게임에 넘기는 브라우저 runtime입니다.
// 페이지를 읽을 때마다 최신 버전이 열리며(sw.js는 build.js가 생성), 업데이트 확인·알림·대기 worker는 없습니다.
// "업데이트 확인"은 게임이 저장한 뒤 location.reload()를 부르는 것입니다. 저장 데이터는 다루지 않습니다.

const OPTION_KEYS = new Set(['serviceWorker', 'onError', 'onInstallable']);

/**
 * @param {object} options
 * @param {string} options.serviceWorker 게임 origin의 sw.js 주소(예: './sw.js')
 * @param {(error: Error) => void} options.onError 등록 실패, service worker 미지원
 * @param {() => void} [options.onInstallable] 브라우저가 설치를 허용했을 때(`beforeinstallprompt`)
 */
export function registerPwa(options = {}) {
    for (const KEY of Object.keys(options)) {
        if (!OPTION_KEYS.has(KEY)) {
            throw new TypeError(`registerPwa unknown option "${KEY}"`);
        }
    }
    const { serviceWorker: SERVICE_WORKER, onError: ON_ERROR, onInstallable: ON_INSTALLABLE } = options;
    if (typeof SERVICE_WORKER !== 'string' || SERVICE_WORKER === '') {
        throw new TypeError('registerPwa serviceWorker must be the sw.js URL');
    }
    if (typeof ON_ERROR !== 'function') {
        throw new TypeError('registerPwa onError must be a function');
    }
    if (ON_INSTALLABLE !== undefined && typeof ON_INSTALLABLE !== 'function') {
        throw new TypeError('registerPwa onInstallable must be a function');
    }
    let installPrompt = null,
        disposed = false;
    const CONTAINER = navigator.serviceWorker;
    const ON_BEFORE_INSTALL = (event) => {
        // 브라우저 기본 배너 대신 게임이 정한 때에 install()로 띄웁니다.
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
                throw new Error('PWA is disposed');
            }
            if (installPrompt === null) {
                throw new Error('PWA is not installable yet (no beforeinstallprompt)');
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
            window.removeEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
            window.removeEventListener('appinstalled', ON_INSTALLED);
        },
    };
    window.addEventListener('beforeinstallprompt', ON_BEFORE_INSTALL);
    window.addEventListener('appinstalled', ON_INSTALLED);
    (CONTAINER
        ? CONTAINER.register(SERVICE_WORKER, { updateViaCache: 'none' })
        : Promise.reject(new Error('service workers are not available on this page'))
    )
        .then((registration) => {
            if (!registration) {
                // 자동화 브라우저가 service worker를 막으면 register가 오류 없이 빈 값으로 끝납니다.
                throw new Error('service worker registration was blocked by the browser');
            }
        })
        .catch((error) => {
            if (!disposed) {
                ON_ERROR(error);
            }
        });
    return PWA;
}
