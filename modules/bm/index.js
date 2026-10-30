const EVENTS = Object.freeze(['adstart', 'adend']);
const OUTCOMES = Object.freeze({
    rewarded: Object.freeze(['rewarded', 'dismissed', 'unavailable', 'error']),
    interstitial: Object.freeze(['viewed', 'dismissed', 'unavailable', 'error']),
});
// 광고가 실제로 화면에 나온 결과만 세션 상한과 쿨다운에 반영합니다.
const SHOWN = Object.freeze(['rewarded', 'viewed', 'dismissed']);

/** 브라우저가 알려 주는 transient user activation. API가 없는 환경은 막지 않습니다. */
function defaultIsUserActive() {
    const ACTIVATION = globalThis.navigator?.userActivation;
    return ACTIVATION ? ACTIVATION.isActive : true;
}

function checkCount(value, name) {
    if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`bm policy.${name} must be a non-negative safe integer or Infinity.`);
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const TIMER = setTimeout(() => reject(new Error('bm adapter show timed out.')), ms);
        promise.then(
            (value) => {
                clearTimeout(TIMER);
                resolve(value);
            },
            (error) => {
                clearTimeout(TIMER);
                reject(error);
            },
        );
    });
}

/**
 * 광고 어댑터를 하나의 인터페이스로 감싸고 빈도 정책을 적용합니다.
 * 소리·시뮬레이션 정지는 소유하지 않으며 `adstart`/`adend` 이벤트로 게임이 처리합니다.
 * @param {object} options
 * @param {{ id: string, load: Function, show: Function, dispose?: Function }} options.adapter 광고사 어댑터
 * @param {object} [options.policy]
 * @param {number} [options.policy.interstitialCooldownMs=60000] 마지막 광고 종료 뒤 전면 광고를 막는 시간
 * @param {number} [options.policy.interstitialPerSession=Infinity] 세션당 전면 광고 상한
 * @param {number} [options.policy.rewardedPerSession=Infinity] 세션당 보상형 광고 상한
 * @param {number} [options.showTimeoutMs=120000] 어댑터가 응답하지 않을 때 광고 잠금을 푸는 시간
 * @param {boolean} [options.requireUserActivation=true] 사용자 입력 직후가 아닌 호출을 막을지 여부
 * @param {() => boolean} [options.isUserActive] 테스트·특수 환경용 입력 직후 판정
 * @param {() => number} [options.now] 쿨다운 시계
 */
export function createBm({
    adapter,
    policy = {},
    showTimeoutMs = 120000,
    requireUserActivation = true,
    isUserActive = defaultIsUserActive,
    now = () => Date.now(),
} = {}) {
    if (
        !adapter ||
        typeof adapter.id !== 'string' ||
        typeof adapter.load !== 'function' ||
        typeof adapter.show !== 'function'
    ) {
        throw new TypeError('bm adapter must provide id, load() and show().');
    }
    const {
        interstitialCooldownMs: COOLDOWN_MS = 60000,
        interstitialPerSession: INTERSTITIAL_CAP = Infinity,
        rewardedPerSession: REWARDED_CAP = Infinity,
    } = policy;
    if (!Number.isFinite(COOLDOWN_MS) || COOLDOWN_MS < 0) {
        throw new RangeError('bm policy.interstitialCooldownMs must be a non-negative finite number.');
    }
    checkCount(INTERSTITIAL_CAP, 'interstitialPerSession');
    checkCount(REWARDED_CAP, 'rewardedPerSession');
    if (!Number.isFinite(showTimeoutMs) || showTimeoutMs <= 0) {
        throw new RangeError('bm showTimeoutMs must be a positive finite number.');
    }
    const LIMITS = { rewarded: REWARDED_CAP, interstitial: INTERSTITIAL_CAP };
    const LISTENERS = { adstart: new Set(), adend: new Set() };
    const SHOWN_COUNT = { rewarded: 0, interstitial: 0 };
    let busy = false;
    let disposed = false;
    let lastAdEndedAt = -Infinity;

    function emit(event, payload) {
        for (const LISTENER of [...LISTENERS[event]]) {
            try {
                LISTENER(payload);
            } catch (error) {
                // 한 구독자의 오류가 광고 잠금 해제를 막지 않도록 격리하고, 오류 자체는 전역으로 올립니다.
                queueMicrotask(() => {
                    throw error;
                });
            }
        }
    }

    function check(type) {
        if (!(type in LIMITS)) {
            throw new TypeError(`bm ad type must be 'rewarded' or 'interstitial': ${type}`);
        }
        if (disposed) {
            return { ok: false, reason: 'disposed' };
        }
        if (busy) {
            return { ok: false, reason: 'busy' };
        }
        if (SHOWN_COUNT[type] >= LIMITS[type]) {
            return { ok: false, reason: 'session-cap' };
        }
        if (type === 'interstitial') {
            const WAIT = lastAdEndedAt + COOLDOWN_MS - now();
            if (WAIT > 0) {
                return { ok: false, reason: 'cooldown', retryAfterMs: WAIT };
            }
        }
        return { ok: true };
    }

    async function show(type, placement) {
        const GATE = check(type);
        if (!GATE.ok) {
            return { status: 'blocked', type, placement, reason: GATE.reason };
        }
        // 첫 await 전에 판정해야 클릭과 같은 task의 activation을 읽습니다.
        if (requireUserActivation && !isUserActive()) {
            return { status: 'blocked', type, placement, reason: 'no-user-activation' };
        }
        busy = true;
        emit('adstart', { type, placement });
        const RESULT = { status: 'error', type, placement };
        try {
            const OUTCOME = await withTimeout(Promise.resolve(adapter.show(placement, type)), showTimeoutMs);
            if (OUTCOMES[type].includes(OUTCOME)) {
                RESULT.status = OUTCOME;
            } else {
                RESULT.reason = 'invalid-outcome';
            }
        } catch (error) {
            RESULT.reason = 'adapter-failed';
            RESULT.error = error;
        }
        busy = false;
        if (SHOWN.includes(RESULT.status)) {
            SHOWN_COUNT[type]++;
            lastAdEndedAt = now();
        }
        emit('adend', RESULT);
        return RESULT;
    }

    return {
        /** @returns {string} 연결된 어댑터 id */
        get adapterId() {
            return adapter.id;
        },
        /** 세션 동안 실제로 나온 광고 수와 마지막 광고 종료 시각입니다. 읽을 때만 새 객체를 만듭니다. */
        get stats() {
            return { shown: { ...SHOWN_COUNT }, lastAdEndedAt };
        },
        /**
         * 어댑터가 광고를 미리 준비합니다. 실패는 false로 돌려주며 던지지 않습니다.
         * @param {string} placement
         * @param {'rewarded' | 'interstitial'} [type='rewarded']
         * @returns {Promise<boolean>}
         */
        async preload(placement, type = 'rewarded') {
            check(type);
            try {
                return (await adapter.load(placement, type)) === true;
            } catch {
                // 준비 실패는 광고를 못 보여 주는 것과 같으므로 호출자에게 false로만 알립니다.
                return false;
            }
        },
        /** 정책만 검사합니다. 사용자 입력 직후 여부는 show 시점에 판정합니다. */
        canShow(type) {
            return check(type);
        },
        /** 사용자가 직접 누른 입력 처리 안에서 호출합니다. 보상은 status가 'rewarded'일 때만 지급하세요. */
        showRewarded(placement) {
            return show('rewarded', placement);
        },
        showInterstitial(placement) {
            return show('interstitial', placement);
        },
        /**
         * @param {'adstart' | 'adend'} event
         * @param {(payload: object) => void} listener
         * @returns {() => void} 구독 해제
         */
        on(event, listener) {
            if (!EVENTS.includes(event)) {
                throw new TypeError(`bm event must be one of ${EVENTS.join(', ')}: ${event}`);
            }
            if (typeof listener !== 'function') {
                throw new TypeError('bm listener must be a function.');
            }
            LISTENERS[event].add(listener);
            return () => LISTENERS[event].delete(listener);
        },
        /** 반복 호출할 수 있습니다. 이후 광고 요청은 'disposed'로 막힙니다. */
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            LISTENERS.adstart.clear();
            LISTENERS.adend.clear();
            adapter.dispose?.();
        },
    };
}
