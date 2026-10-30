const SDK_URL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';

/**
 * Google IMA 문서의 공개 샘플 광고 태그입니다. 테스트 전용이며 운영 광고로 쓰지 마세요.
 * 출처: https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/tags
 */
export const IMA_SAMPLE_TAGS = Object.freeze({
    linear: 'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=',
    skippable:
        'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_preroll_skippable&sz=640x480&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=',
    vertical:
        'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_vertical_ad_samples&sz=360x640&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=',
    redirectError:
        'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dredirecterror&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&nofb=1&correlator=',
});

/** 샘플 태그 끝의 빈 `correlator=`에 매번 다른 값을 채워 캐시된 응답을 피합니다. */
function withCorrelator(url) {
    return url.replace(/correlator=(?=&|$)/, `correlator=${Math.floor(Math.random() * 1e12)}`);
}

/**
 * Google IMA SDK(HTML5)로 VAST 영상 광고를 재생하는 어댑터입니다. 광고마다 전체 화면 오버레이를 만들고 끝나면 지웁니다.
 * 보상형은 광고가 끝까지 재생되었을 때만 `rewarded`이고, 스킵하거나 닫으면 `dismissed`입니다.
 * @param {object} options
 * @param {string | ((placement: string, type: string) => string)} options.adTagUrl VAST 광고 태그 (https)
 * @param {boolean} [options.loadScript=true] ima3.js를 직접 넣을지 여부. 페이지에 이미 넣었다면 false
 * @param {number} [options.loadTimeoutMs=10000] 광고가 시작되기까지 기다리는 시간. 넘으면 unavailable
 * @param {number} [options.playTimeoutMs=100000] 시작한 광고가 끝나기까지 기다리는 시간. 넘으면 error
 * @param {number} [options.zIndex=2147483647] 오버레이의 z-index
 * @param {string} [options.resumeLabel='광고 계속 보기'] 광고가 멈췄을 때 보여 주는 재생 버튼의 글자
 * @param {string} [options.closeLabel='광고 닫기'] 광고를 중간에 그만볼 때 누르는 버튼의 글자. 누르면 `dismissed`(보상 없음)입니다.
 */
export function createImaAdapter({
    adTagUrl,
    loadScript = true,
    loadTimeoutMs = 10000,
    playTimeoutMs = 100000,
    zIndex = 2147483647,
    resumeLabel = '광고 계속 보기',
    closeLabel = '광고 닫기',
} = {}) {
    if (typeof adTagUrl !== 'function' && !(typeof adTagUrl === 'string' && adTagUrl.startsWith('https://'))) {
        throw new TypeError('ima adTagUrl must be an https URL string or a function returning one.');
    }
    for (const [NAME, VALUE] of [
        ['loadTimeoutMs', loadTimeoutMs],
        ['playTimeoutMs', playTimeoutMs],
    ]) {
        if (!Number.isFinite(VALUE) || VALUE <= 0) {
            throw new RangeError(`ima ${NAME} must be a positive finite number.`);
        }
    }
    let sdkPromise = null;

    function ensureSdk() {
        if (globalThis.google?.ima) {
            return Promise.resolve(true);
        }
        if (!loadScript) {
            return Promise.resolve(false);
        }
        sdkPromise ??= new Promise((resolve) => {
            const SCRIPT = document.createElement('script');
            SCRIPT.async = true;
            SCRIPT.src = SDK_URL;
            SCRIPT.onload = () => resolve(Boolean(globalThis.google?.ima));
            SCRIPT.onerror = () => {
                // 광고 차단 등으로 실패하면 다음 요청에서 다시 시도할 수 있게 비웁니다.
                sdkPromise = null;
                resolve(false);
            };
            document.head.append(SCRIPT);
        });
        return sdkPromise;
    }

    /** AdDisplayContainer.initialize()는 클릭과 같은 task에서 불러야 하므로 SDK가 있을 때 동기로 시작합니다. */
    function run(placement, type) {
        return new Promise((resolve) => {
            const IMA = globalThis.google.ima;
            const OVERLAY = document.createElement('div');
            OVERLAY.style.cssText = `position:fixed;inset:0;background:#000;z-index:${zIndex}`;
            const SLOT = document.createElement('div');
            SLOT.style.cssText = 'position:absolute;inset:0';
            const VIDEO = document.createElement('video');
            VIDEO.setAttribute('playsinline', '');
            VIDEO.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0';
            // 광고를 눌러 랜딩 페이지가 열리거나 일시정지되면 IMA는 스스로 다시 재생하지 않으므로 재생 버튼을 둡니다.
            const RESUME = document.createElement('button');
            RESUME.type = 'button';
            RESUME.textContent = resumeLabel;
            RESUME.hidden = true;
            RESUME.style.cssText =
                'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:1;min-width:200px;min-height:56px;padding:0 24px;font:600 18px system-ui,sans-serif;color:#fff;background:#1a73e8;border:0;border-radius:28px';
            // 스킵할 수 없는 광고나 로딩 중에도 사용자가 그만볼 수 있어야 하므로 닫기 버튼은 항상 둡니다.
            const CLOSE = document.createElement('button');
            CLOSE.type = 'button';
            CLOSE.textContent = closeLabel;
            CLOSE.style.cssText =
                'position:absolute;top:12px;right:12px;z-index:1;min-width:96px;min-height:56px;padding:0 16px;font:600 16px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.6);border-radius:28px';
            CLOSE.addEventListener('click', () => finish('dismissed'));
            OVERLAY.append(SLOT, VIDEO, RESUME, CLOSE);
            document.body.append(OVERLAY);
            let manager = null;
            let started = false;
            let done = false;
            let timer = null;
            let paused = false;
            function onResize() {
                manager?.resize(globalThis.innerWidth, globalThis.innerHeight);
            }
            function resume() {
                try {
                    manager?.resume();
                } catch {
                    // 재개 호출이 실패해도 버튼이 남아 있으므로 사용자가 다시 누를 수 있습니다.
                }
            }
            function onReturn() {
                if (paused && !document.hidden) {
                    resume();
                }
            }
            RESUME.addEventListener('click', resume);

            function finish(outcome) {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                globalThis.removeEventListener('resize', onResize);
                globalThis.removeEventListener('focus', onReturn);
                document.removeEventListener('visibilitychange', onReturn);
                try {
                    manager?.destroy();
                } catch {
                    // 이미 정리된 광고 관리자의 destroy 오류는 결과에 영향이 없으므로 무시합니다.
                }
                OVERLAY.remove();
                resolve(outcome);
            }
            function completed() {
                return type === 'rewarded' ? 'rewarded' : 'viewed';
            }
            // 시작 전 오류는 보여 줄 광고가 없는 것이고, 재생 중 오류는 실패입니다.
            function failed() {
                finish(started ? 'error' : 'unavailable');
            }

            try {
                const WIDTH = globalThis.innerWidth;
                const HEIGHT = globalThis.innerHeight;
                const CONTAINER = new IMA.AdDisplayContainer(SLOT, VIDEO);
                CONTAINER.initialize();
                const LOADER = new IMA.AdsLoader(CONTAINER);
                LOADER.addEventListener(IMA.AdErrorEvent.Type.AD_ERROR, failed);
                LOADER.addEventListener(IMA.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (event) => {
                    try {
                        manager = event.getAdsManager(VIDEO);
                        const TYPES = IMA.AdEvent.Type;
                        manager.addEventListener(IMA.AdErrorEvent.Type.AD_ERROR, failed);
                        manager.addEventListener(TYPES.STARTED, () => {
                            started = true;
                            clearTimeout(timer);
                            timer = setTimeout(() => finish('error'), playTimeoutMs);
                        });
                        manager.addEventListener(TYPES.PAUSED, () => {
                            paused = true;
                            RESUME.hidden = false;
                        });
                        for (const NAME of [TYPES.RESUMED, TYPES.STARTED]) {
                            manager.addEventListener(NAME, () => {
                                paused = false;
                                RESUME.hidden = true;
                            });
                        }
                        manager.addEventListener(TYPES.COMPLETE, () => finish(completed()));
                        manager.addEventListener(TYPES.SKIPPED, () => finish('dismissed'));
                        manager.addEventListener(TYPES.USER_CLOSE, () => finish('dismissed'));
                        // 응답에 유효한 광고가 없으면 이 이벤트만 옵니다.
                        manager.addEventListener(TYPES.ALL_ADS_COMPLETED, () =>
                            finish(started ? completed() : 'unavailable'),
                        );
                        globalThis.addEventListener('resize', onResize);
                        globalThis.addEventListener('focus', onReturn);
                        document.addEventListener('visibilitychange', onReturn);
                        manager.init(WIDTH, HEIGHT);
                        manager.start();
                    } catch {
                        // VAST 응답이 잘못되면 init/start가 던질 수 있습니다. 광고가 시작되지 않은 경우입니다.
                        failed();
                    }
                });
                timer = setTimeout(() => finish('unavailable'), loadTimeoutMs);
                const REQUEST = new IMA.AdsRequest();
                const TAG = typeof adTagUrl === 'function' ? adTagUrl(placement, type) : adTagUrl;
                REQUEST.adTagUrl = withCorrelator(TAG);
                REQUEST.linearAdSlotWidth = WIDTH;
                REQUEST.linearAdSlotHeight = HEIGHT;
                LOADER.requestAds(REQUEST);
            } catch {
                // SDK 호출 자체가 던진 경우입니다. 광고를 보여 주지 못한 실패로 끝냅니다.
                finish('error');
            }
        });
    }

    return {
        id: 'ima',
        /** IMA SDK 스크립트가 준비되었는지 돌려줍니다. 광고 한 편이 준비되었는지는 알 수 없습니다. */
        load() {
            return ensureSdk();
        },
        show(placement, type) {
            if (globalThis.google?.ima) {
                return run(placement, type);
            }
            return ensureSdk().then((ready) => (ready ? run(placement, type) : 'unavailable'));
        },
    };
}
