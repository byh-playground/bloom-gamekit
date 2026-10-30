const SCRIPT_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const INTERSTITIAL_TYPES = Object.freeze(['next', 'start', 'pause', 'browse']);

/** adBreak가 보상·종료 콜백 없이 끝났을 때 breakStatus로 결과를 정합니다. */
function outcomeFromStatus(type, status) {
    if (status === 'viewed') {
        return type === 'rewarded' ? 'rewarded' : 'viewed';
    }
    if (status === 'dismissed') {
        return 'dismissed';
    }
    return status === 'error' ? 'error' : 'unavailable';
}

/**
 * Google H5 Games Ads(Ad Placement API)용 어댑터입니다. 신청·승인 절차는 README를 따릅니다.
 * @param {object} options
 * @param {string} options.clientId AdSense 게시자 ID (`ca-pub-...`)
 * @param {boolean} [options.testMode=false] 테스트 광고만 받습니다. 출시 전에 반드시 끕니다.
 * @param {'on' | 'off'} [options.sound='on'] 광고 소리
 * @param {'next' | 'start' | 'pause' | 'browse'} [options.interstitialType='next'] 전면 광고 배치 시점
 * @param {boolean} [options.loadScript=true] adsbygoogle.js를 직접 넣을지 여부. 페이지에 이미 넣었다면 false
 * @param {number} [options.readyTimeoutMs=5000] SDK 준비를 기다리는 시간
 * @param {((acceptAd: () => void) => void) | null} [options.onRewardReady=null] 보상형 광고가 준비됐을 때 호출합니다.
 *   없으면 사용자가 이미 누른 입력을 수락으로 보고 바로 재생합니다. 한 번 더 확인 창을 띄우려면 여기서 acceptAd를 나중에 호출하세요.
 */
export function createGoogleAdsAdapter({
    clientId,
    testMode = false,
    sound = 'on',
    interstitialType = 'next',
    loadScript = true,
    readyTimeoutMs = 5000,
    onRewardReady = null,
} = {}) {
    if (typeof clientId !== 'string' || !/^ca-pub-\d+$/.test(clientId)) {
        throw new TypeError("google-ads clientId must look like 'ca-pub-123456789'.");
    }
    if (!INTERSTITIAL_TYPES.includes(interstitialType)) {
        throw new TypeError(`google-ads interstitialType must be one of ${INTERSTITIAL_TYPES.join(', ')}.`);
    }
    let ready = false;
    let readyPromise = null;

    function ensureReady() {
        readyPromise ??= new Promise((resolve) => {
            globalThis.adsbygoogle = globalThis.adsbygoogle || [];
            if (typeof globalThis.adBreak !== 'function') {
                const PUSH = (options) => globalThis.adsbygoogle.push(options);
                globalThis.adBreak = PUSH;
                globalThis.adConfig = PUSH;
            }
            if (loadScript && !document.querySelector(`script[src^="${SCRIPT_URL}"]`)) {
                const SCRIPT = document.createElement('script');
                SCRIPT.async = true;
                SCRIPT.crossOrigin = 'anonymous';
                SCRIPT.src = `${SCRIPT_URL}?client=${encodeURIComponent(clientId)}`;
                if (testMode) {
                    SCRIPT.setAttribute('data-adbreak-test', 'on');
                }
                SCRIPT.onerror = () => resolve(false);
                document.head.append(SCRIPT);
            }
            const TIMER = setTimeout(() => resolve(false), readyTimeoutMs);
            globalThis.adConfig({
                sound,
                preloadAdBreaks: 'on',
                onReady() {
                    ready = true;
                    clearTimeout(TIMER);
                    resolve(true);
                },
            });
        });
        return readyPromise;
    }

    return {
        id: 'google-ads',
        /** SDK 준비 여부를 돌려줍니다. 광고 한 편이 준비됐는지는 Google이 알려 주지 않습니다. */
        async load() {
            await ensureReady();
            return ready;
        },
        show(placement, type) {
            // 준비를 기다리지 않습니다. 기다리는 동안 클릭의 user activation이 끝나 광고가 막힐 수 있고,
            // SDK가 준비되기 전의 adBreak 호출은 adsbygoogle 큐가 받아 둡니다.
            ensureReady();
            return new Promise((resolve) => {
                let outcome = null;
                const OPTIONS = {
                    type: type === 'rewarded' ? 'reward' : interstitialType,
                    name: placement,
                    beforeAd() {
                        // 보상형은 adViewed가 오기 전까지 viewed로 확정하지 않습니다.
                        outcome = type === 'rewarded' ? outcome : 'viewed';
                    },
                    adBreakDone(info) {
                        resolve(outcome ?? outcomeFromStatus(type, info?.breakStatus));
                    },
                };
                if (type === 'rewarded') {
                    OPTIONS.beforeReward = (showAdFn) => {
                        if (onRewardReady) {
                            onRewardReady(showAdFn);
                        } else {
                            showAdFn();
                        }
                    };
                    OPTIONS.adViewed = () => {
                        outcome = 'rewarded';
                    };
                    OPTIONS.adDismissed = () => {
                        outcome = 'dismissed';
                    };
                }
                globalThis.adBreak(OPTIONS);
            });
        },
    };
}
