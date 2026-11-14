/**
 * ms로 적은 시간 값을 고정 틱에 반영하는 공통 도우미(DEV-035).
 *
 * 틱 수는 `tickTime({ tickRate })` 한 곳에서만 받습니다. 누적값은 게임 상태에 넣는 평범한 정수이며
 * 단위는 "ms × tickRate"입니다. 한 틱은 이 단위로 늘 1000이라 1000/tickRate가 정수가 아니어도 정수로만 셉니다.
 * 모든 메서드는 순수 함수이고 할당하지 않습니다. 누적값은 스냅샷·롤백·상태 해시에 그대로 포함하세요.
 */
const STEP = 1000;

function positiveMs(ms, name) {
    if (!Number.isSafeInteger(ms) || ms <= 0) {
        throw new RangeError(`${name} must be a positive integer ms`);
    }
    return ms;
}
function nonNegativeMs(ms, name) {
    if (!Number.isSafeInteger(ms) || ms < 0) {
        throw new RangeError(`${name} must be a non-negative integer ms`);
    }
    return ms;
}
function counter(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

/**
 * @param {{ tickRate: number }} options 시뮬레이션 초당 틱 수. simloop `clockRates()` 결과를 그대로 넘겨도 됩니다.
 */
export function tickTime({ tickRate } = {}) {
    if (!Number.isSafeInteger(tickRate) || tickRate <= 0) {
        throw new RangeError('tickRate must be a positive integer');
    }
    const UNITS = (ms, name) => {
        const VALUE = ms * tickRate;
        if (!Number.isSafeInteger(VALUE)) {
            throw new RangeError(`${name} × tickRate exceeds the safe integer range`);
        }
        return VALUE;
    };
    const PERIOD = (ms) => UNITS(positiveMs(ms, 'periodMs'), 'periodMs');
    const EVERY = (acc, periodMs, fn, arg, once) => {
        const LIMIT = PERIOD(periodMs);
        const SUM = counter(acc, 'accumulator') + STEP;
        if (SUM < LIMIT) {
            return SUM;
        }
        const COUNT = Math.floor(SUM / LIMIT);
        const CALLS = fn ? (once ? 1 : COUNT) : 0;
        for (let i = 0; i < CALLS; i++) {
            fn(arg);
        }
        // 0으로 지우지 않고 나머지를 남깁니다. 결과는 늘 [0, periodMs × tickRate)라 커지지 않습니다.
        return SUM - COUNT * LIMIT;
    };
    return Object.freeze({
        tickRate,
        /** 한 틱의 ms(1000 / tickRate, 소수 가능). 표시·보간 전용이며 시뮬레이션 판정에 쓰지 않습니다. */
        stepMs: STEP / tickRate,
        /**
         * 주기 누적값을 한 틱 진행하고 새 누적값을 돌려줍니다. 이번 틱에 주기가 n번 들어가면 `fn(arg)`를 n번 부릅니다.
         * 처음 누적값은 0이고, 0에서 시작하면 첫 실행은 periodMs가 지난 첫 틱입니다.
         */
        every: (acc, periodMs, fn, arg) => EVERY(acc, periodMs, fn, arg, false),
        /** `every`와 같은 누적값을 돌려주되 이번 틱에 여러 번 들어가도 `fn(arg)`는 한 번만 부릅니다(최신 상태만 필요한 갱신). */
        everyOnce: (acc, periodMs, fn, arg) => EVERY(acc, periodMs, fn, arg, true),
        /** 이번 틱에 주기가 몇 번 들어가는지. 같은 틱의 `every(acc, periodMs)`보다 먼저 부릅니다. */
        fires: (acc, periodMs) => Math.floor((counter(acc, 'accumulator') + STEP) / PERIOD(periodMs)),
        /** 지속·지연·쿨다운을 시작한 "남은 시간" 값. 0ms는 이미 끝난 값(0)입니다. */
        start: (ms) => UNITS(nonNegativeMs(ms, 'ms'), 'ms'),
        /**
         * 남은 시간을 한 틱 줄입니다(0에서 멈춤). 이번 틱에 0이 되면 `fn(arg)`를 한 번 부릅니다.
         * 끝난 값(0)은 그대로 0이라 매 틱 불러도 됩니다. 넘친 부분은 버립니다(반복 주기는 `every`).
         */
        advance: (remaining, fn, arg) => {
            if (counter(remaining, 'remaining') === 0) {
                return 0;
            }
            if (remaining > STEP) {
                return remaining - STEP;
            }
            if (fn) {
                fn(arg);
            }
            return 0;
        },
        /** 끝났거나 시작하지 않은 값인지(쿨다운이면 "다시 쓸 수 있음"). */
        done: (remaining) => counter(remaining, 'remaining') === 0,
        /** 남은 ms(소수 가능). 표시 전용. */
        remainingMs: (remaining) => counter(remaining, 'remaining') / tickRate,
        /** 시작한 길이 `totalMs` 중 지난 ms(소수 가능, 0~totalMs). 표시 전용. */
        elapsedMs: (remaining, totalMs) =>
            Math.max(0, nonNegativeMs(totalMs, 'totalMs') - counter(remaining, 'remaining') / tickRate),
        /**
         * ms를 덮는 최소 틱 개수(올림). 틱 개수를 요구하는 외부 API·프로토콜 경계에서 한 번만 씁니다.
         * 0번 틱(시각 0)부터 세면 ms 시각을 지난 첫 틱 번호와 같습니다.
         */
        ceilTicks: (ms) => {
            const VALUE = UNITS(nonNegativeMs(ms, 'ms'), 'ms');
            // 나머지(%)는 정수에서 정확하므로 큰 값에서도 부동소수 나눗셈 반올림을 타지 않습니다.
            const REST = VALUE % STEP;
            return (VALUE - REST) / STEP + (REST === 0 ? 0 : 1);
        },
        /** 틱 번호의 경과 ms(소수 가능). 표시 전용. */
        tickToMs: (tick) => (counter(tick, 'tick') * STEP) / tickRate,
    });
}
