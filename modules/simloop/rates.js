const RATE_NAMES = ['baseHz', 'tickRate', 'inputHz'];
// clockRates가 돌려준 객체를 다시 넣을 수 있게 파생 값 이름은 받되 다시 계산합니다.
const DERIVED_NAMES = ['simulationDivisor', 'inputDivisor'];
/** Configured frequencies share integer divisions; physical RAF/timers may be irregular. */
export function clockRates(rates = {}) {
    for (const NAME of Object.keys(rates)) {
        if (!RATE_NAMES.includes(NAME) && !DERIVED_NAMES.includes(NAME)) {
            // 표시 빈도는 화면 주사율이 정합니다. createLoop의 frame.minHz를 씁니다.
            throw new TypeError(`unknown clock rate: ${NAME}`);
        }
    }
    const BASE_HZ = rates.baseHz;
    for (const NAME of RATE_NAMES) {
        const VALUE = rates[NAME];
        if (!Number.isSafeInteger(VALUE) || VALUE <= 0) {
            throw new RangeError(`${NAME} must be a positive integer frequency`);
        }
        if (NAME !== 'baseHz' && BASE_HZ % VALUE !== 0) {
            throw new RangeError(`${NAME} (${VALUE}) must divide baseHz (${BASE_HZ}) exactly`);
        }
    }
    return Object.freeze({
        baseHz: BASE_HZ,
        tickRate: rates.tickRate,
        inputHz: rates.inputHz,
        simulationDivisor: BASE_HZ / rates.tickRate,
        inputDivisor: BASE_HZ / rates.inputHz,
    });
}
