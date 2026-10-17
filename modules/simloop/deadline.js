/**
 * Owns a single timer for a monotonic, fixed-interval pulse cadence.
 * `due` is the number of regular deadlines represented by a pulse; wake pulses
 * use `due: 0` and do not move the regular deadline. Large gaps discard overdue
 * deadlines and resume with one pulse. Call `rebase()` after pause/resume or a
 * rate change; changing the interval callback alone does not move a deadline.
 *
 * @param {object} options
 * @param {() => number} options.getIntervalMs Positive finite interval; read on
 *   start/rebase. Rebase after changing its effective value.
 * @param {(timestampMs: number, info: {due: number, scheduledAtMs: number|null}) => void} options.pulse
 * @param {number} [options.maxBacklogTicks=8] Maximum regular ticks represented
 *   during a delayed pulse before overdue time is dropped.
 * @param {() => number} [options.now=performance.now] Monotonic millisecond clock.
 * @param {(callback: () => void, delayMs: number) => unknown} [options.setTimer=setTimeout]
 * @param {(handle: unknown) => void} [options.clearTimer=clearTimeout]
 * @param {(gap: {elapsedMs: number, droppedTicks: number, timestamp: number, scheduledAtMs: number}) => void} [options.onGap]
 * @returns {{start: () => void, stop: () => void, wake: () => void, rebase: (nowMs?: number) => void, readonly running: boolean, readonly deadlineMs: number|null}}
 *
 * This is a timer cadence helper, not a simulation accumulator or clock. Timer
 * delivery can be late; it provides no frame-rate or real-time guarantee.
 */
export function createDeadlineScheduler({
    getIntervalMs,
    getDeadlineMs,
    pulse,
    maxBacklogTicks = 8,
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onGap,
} = {}) {
    if (getDeadlineMs !== undefined) {
        if (getIntervalMs !== undefined) {
            throw new TypeError('choose getDeadlineMs or getIntervalMs');
        }
        return ownedDeadline({
            getDeadlineMs,
            pulse,
            now,
            setTimer,
            clearTimer,
        });
    }
    if (typeof getIntervalMs !== 'function') {
        throw new TypeError('getIntervalMs must be a function');
    }
    if (typeof pulse !== 'function') {
        throw new TypeError('pulse must be a function');
    }
    if (!Number.isSafeInteger(maxBacklogTicks) || maxBacklogTicks < 1) {
        throw new RangeError('maxBacklogTicks must be a positive safe integer');
    }
    if (typeof now !== 'function') {
        throw new TypeError('now must be a function');
    }
    if (typeof setTimer !== 'function') {
        throw new TypeError('setTimer must be a function');
    }
    if (typeof clearTimer !== 'function') {
        throw new TypeError('clearTimer must be a function');
    }
    if (onGap !== undefined && typeof onGap !== 'function') {
        throw new TypeError('onGap must be a function');
    }
    let active = false;
    let timerPending = false;
    let timerHandle;
    let generation = 0;
    let intervalMs;
    let deadline = null;
    let lastPulseAt = null;
    let lastNow = null;
    let dispatchingWake = false;
    const READ_NOW = () => {
        const VALUE = now();
        if (!Number.isFinite(VALUE)) {
            throw new RangeError('now() must return a finite timestamp');
        }
        if (lastNow !== null && VALUE < lastNow) {
            throw new RangeError('now() must be monotonic');
        }
        lastNow = VALUE;
        return VALUE;
    };
    const READ_INTERVAL = () => {
        const VALUE = getIntervalMs();
        if (!Number.isFinite(VALUE) || VALUE <= 0) {
            throw new RangeError('getIntervalMs() must return a positive finite interval');
        }
        return VALUE;
    };
    const CLEAR_PENDING_TIMER = () => {
        if (!timerPending) {
            return;
        }
        timerPending = false;
        clearTimer(timerHandle);
        timerHandle = undefined;
    };
    let arm;
    const DISPATCH_REGULAR = (token) => {
        if (!active || token !== generation) {
            return;
        }
        timerPending = false;
        timerHandle = undefined;
        const TIMESTAMP = READ_NOW();
        if (TIMESTAMP < deadline) {
            arm(token);
            return;
        }
        const INTERVAL = intervalMs;
        const LATENESS = TIMESTAMP - deadline;
        if (!Number.isFinite(LATENESS)) {
            throw new RangeError('clock gap is outside the supported range');
        }
        const DUE = Math.floor(LATENESS / INTERVAL) + 1;
        const ELAPSED_MS = lastPulseAt === null ? INTERVAL : TIMESTAMP - lastPulseAt;
        const MAX_GAP_MS = INTERVAL * maxBacklogTicks;
        if (ELAPSED_MS > MAX_GAP_MS) {
            const DROPPED_TICKS = Math.max(0, DUE - 1);
            deadline = TIMESTAMP + INTERVAL;
            if (!Number.isFinite(deadline)) {
                throw new RangeError('next deadline is outside the supported range');
            }
            lastPulseAt = TIMESTAMP;
            onGap?.({
                elapsedMs: ELAPSED_MS,
                droppedTicks: DROPPED_TICKS,
                timestamp: TIMESTAMP,
                scheduledAtMs: TIMESTAMP,
            });
            if (!active || token !== generation) {
                return;
            }
            pulse(TIMESTAMP, {
                due: 1,
                scheduledAtMs: TIMESTAMP,
            });
        } else {
            const SCHEDULED_AT_MS = deadline;
            deadline += DUE * INTERVAL;
            if (!Number.isFinite(deadline)) {
                throw new RangeError('next deadline is outside the supported range');
            }
            lastPulseAt = TIMESTAMP;
            pulse(TIMESTAMP, {
                due: DUE,
                scheduledAtMs: SCHEDULED_AT_MS,
            });
        }
        if (active && token === generation) {
            arm(token);
        }
    };
    arm = (token) => {
        if (!active || token !== generation || timerPending) {
            return;
        }
        const TIMESTAMP = READ_NOW();
        const DELAY = Math.max(0, deadline - TIMESTAMP);
        timerPending = true;
        timerHandle = setTimer(() => DISPATCH_REGULAR(token), DELAY);
    };
    const REBASE = (timestampMs) => {
        const TIMESTAMP = timestampMs === undefined ? READ_NOW() : timestampMs;
        if (!Number.isFinite(TIMESTAMP)) {
            throw new RangeError('rebase timestamp must be finite');
        }
        if (lastNow !== null && TIMESTAMP < lastNow) {
            throw new RangeError('rebase timestamp must be monotonic');
        }
        lastNow = TIMESTAMP;
        intervalMs = READ_INTERVAL();
        deadline = TIMESTAMP + intervalMs;
        if (!Number.isFinite(deadline)) {
            throw new RangeError('next deadline is outside the supported range');
        }
        lastPulseAt = TIMESTAMP;
        generation += 1;
        CLEAR_PENDING_TIMER();
        if (active) {
            arm(generation);
        }
    };
    const STOP = () => {
        generation += 1;
        active = false;
        deadline = null;
        lastPulseAt = null;
        CLEAR_PENDING_TIMER();
    };
    const START = () => {
        if (active) {
            return;
        }
        const TIMESTAMP = READ_NOW();
        intervalMs = READ_INTERVAL();
        deadline = TIMESTAMP + intervalMs;
        if (!Number.isFinite(deadline)) {
            throw new RangeError('next deadline is outside the supported range');
        }
        lastPulseAt = TIMESTAMP;
        active = true;
        generation += 1;
        arm(generation);
    };
    const WAKE = () => {
        if (!active || dispatchingWake) {
            return;
        }
        const TIMESTAMP = READ_NOW();
        lastPulseAt = TIMESTAMP;
        dispatchingWake = true;
        try {
            pulse(TIMESTAMP, {
                due: 0,
                scheduledAtMs: null,
            });
        } finally {
            dispatchingWake = false;
        }
    };
    return {
        start: START,
        stop: STOP,
        wake: WAKE,
        rebase: REBASE,
        get running() {
            return active;
        },
        get deadlineMs() {
            return deadline;
        },
    };
}

/** The loop owns elapsed time and backlog. This timer only wakes at its next deadline. */
function ownedDeadline({ getDeadlineMs, pulse, now, setTimer, clearTimer }) {
    for (const CALLBACK of [getDeadlineMs, pulse, now, setTimer, clearTimer]) {
        if (typeof CALLBACK !== 'function') {
            throw new TypeError('deadline callback');
        }
    }
    let active = false;
    let handle;
    let generation = 0;
    let deadline = null;
    let last = -Infinity;
    let dispatching = false;
    const READ_NOW = () => {
        const T = now();
        if (!Number.isFinite(T) || T < last) {
            throw new RangeError('now must be finite and monotonic');
        }
        last = T;
        return T;
    };
    const CLEAR = () => {
        if (handle !== undefined) {
            clearTimer(handle);
        }
        handle = undefined;
    };
    const ARM = () => {
        if (!active) {
            return;
        }
        CLEAR();
        const T = READ_NOW(),
            NEXT = getDeadlineMs();
        if (NEXT !== null && !Number.isFinite(NEXT)) {
            throw new RangeError('deadline must be finite or null');
        }
        deadline = NEXT ?? T;
        const TOKEN = generation;
        handle = setTimer(
            () => {
                if (!active || TOKEN !== generation) {
                    return;
                }
                handle = undefined;
                const AT = READ_NOW();
                if (AT < deadline) {
                    ARM();
                    return;
                }
                dispatching = true;
                try {
                    pulse(AT, {
                        due: 0,
                        scheduledAtMs: deadline,
                    });
                } finally {
                    dispatching = false;
                    if (active && TOKEN === generation) {
                        ARM();
                    }
                }
            },
            Math.max(1, deadline - T),
        );
    };
    return {
        start() {
            if (active) {
                return;
            }
            active = true;
            generation++;
            ARM();
        },
        stop() {
            active = false;
            generation++;
            CLEAR();
            deadline = null;
        },
        rebase() {
            generation++;
            if (active) {
                ARM();
            }
        },
        wake() {
            if (!active || dispatching) {
                return;
            }
            dispatching = true;
            try {
                pulse(READ_NOW(), {
                    due: 0,
                    scheduledAtMs: null,
                });
            } finally {
                dispatching = false;
                ARM();
            }
        },
        get running() {
            return active;
        },
        get deadlineMs() {
            return deadline;
        },
    };
}
