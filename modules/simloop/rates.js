/** Configured frequencies share integer divisions; physical RAF/timers may be irregular. */
export function clockRates({ baseHz, tickRate, inputHz, renderHz } = {}) {
    for (const [NAME, VALUE] of Object.entries({
        baseHz,
        tickRate,
        inputHz,
        renderHz,
    })) {
        if (!Number.isSafeInteger(VALUE) || VALUE <= 0) {
            throw new RangeError(`${NAME} must be a positive integer frequency`);
        }
        if (NAME !== 'baseHz' && baseHz % VALUE !== 0) {
            throw new RangeError(`${NAME} (${VALUE}) must divide baseHz (${baseHz}) exactly`);
        }
    }
    return Object.freeze({
        baseHz,
        tickRate,
        inputHz,
        renderHz,
        simulationDivisor: baseHz / tickRate,
        inputDivisor: baseHz / inputHz,
        renderDivisor: baseHz / renderHz,
    });
}
