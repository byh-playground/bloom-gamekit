import { clockRates } from './rates.js';
/** Fixed Simulation dt, separately adjustable real-time scheduling. No import side effects. */
export function createLoop({
    session,
    getInput = () => new Uint8Array(session.inputSize),
    render = () => {},
    inputPreview,
    rates,
    backlogPolicy = 'drop',
    beforeFrame = () => {},
    canAdvance = () => true,
    canObserveInput = () => true,
    onAdvance = () => {},
    onPreviewError = () => {},
    onError = (error) => {
        throw error;
    },
    onInputRelease = () => {},
    onBacklogDrop = () => {},
    maxBacklogTicks = 8,
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
    cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
} = {}) {
    if (!session || typeof session.poll !== 'function' || typeof session.advance !== 'function') {
        throw new TypeError('session capability');
    }
    for (const CALLBACK of [
        getInput,
        render,
        beforeFrame,
        canAdvance,
        canObserveInput,
        onAdvance,
        onPreviewError,
        onError,
        onInputRelease,
        onBacklogDrop,
    ]) {
        if (typeof CALLBACK !== 'function') {
            throw new TypeError('loop callback');
        }
    }
    if (backlogPolicy !== 'drop' && backlogPolicy !== 'retain' && backlogPolicy !== 'defer') {
        throw new RangeError('backlogPolicy');
    }
    if (!Number.isInteger(maxBacklogTicks) || maxBacklogTicks < 1 || maxBacklogTicks > 8192) {
        throw new RangeError('maxBacklogTicks');
    }
    const HAS_SUBMISSION = typeof session.submitInput === 'function';
    const CONFIGURED_RATES =
        rates === undefined
            ? null
            : clockRates({
                  ...rates,
                  tickRate: session.profile.tickRate,
              });
    const QUANTUM = 1000 / session.profile.tickRate;
    const MAX_BACKLOG_MS = QUANTUM * maxBacklogTicks;
    const REPORT_BACKLOG_DROP = (elapsedMs, droppedMs, timestamp, reason) => {
        if (droppedMs <= 0) {
            return;
        }
        onBacklogDrop({
            elapsedMs,
            droppedMs,
            droppedTicks: Math.floor(droppedMs / QUANTUM),
            timestamp,
            reason,
        });
    };
    let running = false;
    let handle;
    let last;
    let accumulator = 0;
    let generation = 0;
    let timingGeneration = 0;
    if (inputPreview && typeof inputPreview.observe !== 'function') {
        throw new TypeError('inputPreview observation capability');
    }
    let inputSequence = 0;
    let commandObservation = 0;
    let observedAt = -Infinity;
    let cached = null;
    let captureEpoch = '';
    let captureSequence = -1;
    const OBSERVED_COMMANDS = [];
    const OBSERVE_INPUT = (timestamp) => {
        if (!Number.isFinite(timestamp)) {
            throw new TypeError('input observation timestamp');
        }
        if (!canObserveInput()) {
            cached = null;
            inputPreview?.clear?.();
            return null;
        }
        const SAMPLED = getInput(),
            PACKET =
                SAMPLED &&
                typeof SAMPLED === 'object' &&
                !ArrayBuffer.isView(SAMPLED) &&
                Object.hasOwn(SAMPLED, 'input');
        const INPUT = PACKET ? SAMPLED.input : SAMPLED,
            COMMANDS = PACKET ? (SAMPLED.commands ?? []) : [];
        if (!Array.isArray(COMMANDS)) {
            throw new TypeError('input packet commands');
        }
        const HELD = OBSERVED_COMMANDS;
        if (HELD.length + COMMANDS.length > 64) {
            throw new RangeError('unsubmitted input command capacity');
        }
        for (const COMMAND of COMMANDS) {
            if (!COMMAND || COMMAND.payload === undefined) {
                throw new TypeError('command payload required');
            }
            HELD.push({
                observationId: ++commandObservation,
                sequence: null,
                payload: COMMAND.payload.slice?.() ?? structuredClone(COMMAND.payload),
            });
        }
        cached = {
            input: INPUT.slice?.() ?? structuredClone(INPUT),
            commands: HELD,
            predict: !PACKET || SAMPLED.predict !== false || HELD.length > 0 || inputPreview?.active === true,
            continuationKey: PACKET ? SAMPLED.continuationKey : undefined,
            sequence: ++inputSequence,
        };
        observedAt = timestamp;
        if (HAS_SUBMISSION) {
            const PENDING = HELD.filter((command) => command.sequence === null);
            const SUBMISSION = session.submitInput(cached.input, {
                commands: PENDING.map((command) => command.payload),
            });
            if (SUBMISSION.commandSequences.length !== PENDING.length) {
                throw new Error('input submission command receipt');
            }
            for (let i = 0; i < PENDING.length; i++) {
                PENDING[i].sequence = SUBMISSION.commandSequences[i];
            }
        }
        if (inputPreview && PACKET && SAMPLED.predict === false && !HELD.length && !inputPreview.active) {
            inputPreview.cancelObservation?.(Math.max(timestamp, performance.now()));
        } else if (inputPreview?.enabled !== false && inputPreview) {
            try {
                inputPreview.observe(cached.input, {
                    sequence: cached.sequence,
                    tick: session.tick,
                    epoch: session.epoch ?? 0,
                    continuationKey: cached.continuationKey,
                    timeMs: Math.max(timestamp, globalThis.performance?.now?.() ?? timestamp),
                    commands: cached.commands,
                });
            } catch (error) {
                inputPreview.clear?.();
                onPreviewError(error);
            }
        }
        return cached;
    };
    const RESET_TIMING = (clearPreview = true) => {
        timingGeneration++;
        last = undefined;
        accumulator = 0;
        if (clearPreview) {
            cached = null;
            observedAt = -Infinity;
            inputPreview?.clear?.();
        }
    };
    const RELEASE = () => {
        try {
            onInputRelease();
            session.releaseInput();
            cached = null;
            observedAt = -Infinity;
            inputPreview?.clear?.();
        } catch (error) {
            STOP();
            onError(error);
        }
    };
    const HIDDEN = () => {
        if (globalThis.document?.hidden) {
            RELEASE();
            RESET_TIMING();
        }
    };
    const STOP = () => {
        generation++;
        running = false;
        if (handle !== undefined) {
            cancelFrame?.(handle);
        }
        handle = undefined;
        inputPreview?.clear?.();
        globalThis.removeEventListener?.('blur', RELEASE);
        globalThis.document?.removeEventListener('visibilitychange', HIDDEN);
    };
    const RENDER_FRAME = () =>
        render({
            session,
            alpha: Math.min(1, accumulator / QUANTUM),
            resimulating: session.resimulating,
        });
    const PULSE = (timestamp, { render: shouldRender = true, input: shouldSampleInput = true } = {}) => {
        const CURRENT = generation;
        try {
            if (!Number.isFinite(timestamp)) {
                throw new TypeError('frame timestamp');
            }
            if (backlogPolicy === 'retain' && last !== undefined && timestamp < last) {
                throw new RangeError('retained loop timestamp cannot regress');
            }
            if (backlogPolicy === 'defer' && last !== undefined && timestamp < last) {
                throw new RangeError('deferred loop timestamp cannot regress');
            }
            beforeFrame(timestamp);
            if (CURRENT !== generation) {
                return;
            }
            const TIMING = timingGeneration;
            if (last === undefined) {
                last = timestamp;
            }
            const ELAPSED = Math.max(0, timestamp - last);
            if (backlogPolicy === 'drop' && ELAPSED > MAX_BACKLOG_MS) {
                const DROPPED_MS = accumulator + ELAPSED;
                accumulator = 0;
                last = timestamp;
                if (typeof inputPreview?.clockGap === 'function') {
                    inputPreview.clockGap();
                } else {
                    inputPreview?.clear?.();
                }
                REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, 'clock-gap');
            } else if (backlogPolicy === 'defer' && ELAPSED > MAX_BACKLOG_MS) {
                const DROPPED_MS = accumulator + ELAPSED;
                accumulator = 0;
                last = timestamp;
                if (typeof inputPreview?.clockGap === 'function') {
                    inputPreview.clockGap();
                } else {
                    inputPreview?.clear?.();
                }
                REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, 'clock-gap');
            } else {
                if (backlogPolicy === 'retain') {
                    accumulator += ELAPSED;
                } else if (backlogPolicy === 'defer') {
                    const ACCUMULATED_MS = accumulator + ELAPSED;
                    if (ACCUMULATED_MS > MAX_BACKLOG_MS) {
                        const DROPPED_MS = ACCUMULATED_MS - MAX_BACKLOG_MS;
                        accumulator = MAX_BACKLOG_MS;
                        if (typeof inputPreview?.clockGap === 'function') {
                            inputPreview.clockGap();
                        } else {
                            inputPreview?.clear?.();
                        }
                        REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, 'backlog-overflow');
                    } else {
                        accumulator = ACCUMULATED_MS;
                    }
                } else {
                    const CLAMPED_ELAPSED = Math.min(250, ELAPSED),
                        ACCUMULATED_MS = accumulator + CLAMPED_ELAPSED,
                        MAX_CATCHUP_MS = QUANTUM * session.profile.maxCatchupSteps,
                        INPUT_DROPPED_MS = ELAPSED - CLAMPED_ELAPSED,
                        BACKLOG_DROPPED_MS = Math.max(0, ACCUMULATED_MS - MAX_CATCHUP_MS);
                    accumulator = Math.min(ACCUMULATED_MS, MAX_CATCHUP_MS);
                    REPORT_BACKLOG_DROP(ELAPSED, INPUT_DROPPED_MS, timestamp, 'input-dt-clamp');
                    REPORT_BACKLOG_DROP(ELAPSED, BACKLOG_DROPPED_MS, timestamp, 'backlog-overflow');
                }
                last = timestamp;
            }
            if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) {
                throw new RangeError('loop backlog exceeds safe milliseconds');
            }
            session.poll();
            if (CURRENT !== generation || TIMING !== timingGeneration) {
                return;
            }
            // A manual deadline must not depend on another RAF arriving to refresh devices.
            if (
                shouldSampleInput &&
                (inputPreview || HAS_SUBMISSION) &&
                (!cached || timestamp - observedAt >= QUANTUM)
            ) {
                OBSERVE_INPUT(timestamp);
            }
            let work = 0;
            while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
                // Scalar capability avoids allocating a complete metrics snapshot per pacing read.
                const PACE = session.pace ?? session.metrics.pace;
                if (accumulator + 1e-7 < QUANTUM * PACE) {
                    break;
                }
                const ALLOWED = canAdvance();
                if (CURRENT !== generation || TIMING !== timingGeneration) {
                    return;
                }
                if (!ALLOWED) {
                    if (backlogPolicy === 'drop') {
                        const DROPPED_MS = Math.max(0, accumulator - QUANTUM);
                        accumulator = Math.min(accumulator, QUANTUM);
                        REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, 'drop-policy');
                    }
                    break;
                }
                const SAMPLED =
                    inputPreview || HAS_SUBMISSION || !shouldSampleInput
                        ? (cached ?? (shouldSampleInput ? OBSERVE_INPUT(timestamp) : null))
                        : getInput();
                if (!SAMPLED) {
                    break;
                }
                if (CURRENT !== generation || TIMING !== timingGeneration) {
                    return;
                }
                const PACKET =
                    SAMPLED &&
                    typeof SAMPLED === 'object' &&
                    !ArrayBuffer.isView(SAMPLED) &&
                    !(SAMPLED instanceof ArrayBuffer) &&
                    Object.hasOwn(SAMPLED, 'input');
                const INPUT_VALUE = PACKET ? SAMPLED.input : SAMPLED;
                const INPUT =
                    inputPreview && inputPreview.enabled !== false && ArrayBuffer.isView(INPUT_VALUE)
                        ? new INPUT_VALUE.constructor(INPUT_VALUE)
                        : INPUT_VALUE;
                if (PACKET) {
                    const COMMANDS = SAMPLED.commands ?? [];
                    if (!Array.isArray(COMMANDS)) {
                        throw new TypeError('input packet commands must be an array');
                    }
                    if (COMMANDS.length && typeof session.queueCommand !== 'function') {
                        throw new TypeError('session does not support queued input commands');
                    }
                    for (const COMMAND of COMMANDS) {
                        if (!COMMAND || COMMAND.payload === undefined) {
                            throw new TypeError('input command payload required');
                        }
                        const PAYLOAD = ArrayBuffer.isView(COMMAND.payload)
                            ? new COMMAND.payload.constructor(COMMAND.payload)
                            : COMMAND.payload;
                        if (
                            (inputPreview || HAS_SUBMISSION || !shouldSampleInput) &&
                            COMMAND.sequence !== null &&
                            COMMAND.sequence !== undefined
                        ) {
                            continue;
                        }
                        const SEQUENCE = session.queueCommand(PAYLOAD);
                        if (!Number.isSafeInteger(SEQUENCE) || SEQUENCE < 0) {
                            throw new TypeError('session command sequence');
                        }
                        if (inputPreview || HAS_SUBMISSION || !shouldSampleInput) {
                            COMMAND.sequence = SEQUENCE;
                        }
                    }
                }
                if (!inputPreview && !HAS_SUBMISSION && !shouldSampleInput) {
                    OBSERVED_COMMANDS.length = 0;
                }
                const RESULT = session.advance(INPUT);
                work++;
                let submission;
                if (inputPreview || HAS_SUBMISSION) {
                    const METADATA = session.localInputState;
                    const EPOCH = METADATA ? METADATA.epoch + ':' + METADATA.baseTick : '';
                    if (EPOCH !== captureEpoch) {
                        captureEpoch = EPOCH;
                        captureSequence = -1;
                    }
                    for (const CAPTURE of METADATA?.captures ?? (METADATA?.capture ? [METADATA.capture] : [])) {
                        if (CAPTURE.sequence <= captureSequence) {
                            continue;
                        }
                        captureSequence = CAPTURE.sequence;
                        submission = {
                            ...CAPTURE,
                            predict: cached?.predict !== false,
                            boundaryTick: METADATA.tick,
                            epoch: METADATA.epoch,
                            timeMs: Math.max(timestamp, performance.now()),
                        };
                        submission.commands = CAPTURE.commands.map((command) => ({
                            ...command,
                            observationId: cached?.commands.find((c) => c.sequence === command.sequence)?.observationId,
                        }));
                        try {
                            inputPreview?.commit(submission, submission.timeMs);
                        } catch (error) {
                            inputPreview.clear?.();
                            onPreviewError(error);
                        }
                        const ASSIGNED = new Set(CAPTURE.commands.map((c) => c.sequence));
                        for (let i = OBSERVED_COMMANDS.length - 1; i >= 0; i--) {
                            if (ASSIGNED.has(OBSERVED_COMMANDS[i].sequence)) {
                                OBSERVED_COMMANDS.splice(i, 1);
                            }
                        }
                    }
                }
                // A completed tick still consumes debt after stop(), but never touches a reset/new run.
                if (TIMING !== timingGeneration) {
                    return;
                }
                if (RESULT.status === 'advanced') {
                    accumulator = Math.max(0, accumulator - QUANTUM * PACE);
                } else if (backlogPolicy === 'drop') {
                    const DROPPED_MS = Math.max(0, accumulator - QUANTUM);
                    accumulator = Math.min(accumulator, QUANTUM);
                    REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, 'drop-policy');
                }
                if (CURRENT !== generation) {
                    return;
                }
                onAdvance(RESULT, submission);
                if (CURRENT !== generation || TIMING !== timingGeneration) {
                    return;
                }
                if (RESULT.status !== 'advanced') {
                    break;
                }
            }
            // Rendering continues when the session is waiting for input or connection recovery.
            if (shouldRender) {
                RENDER_FRAME();
            }
        } catch (error) {
            if (CURRENT === generation) {
                STOP();
            }
            onError(error);
        }
    };
    const START = () => {
        if (running) {
            return;
        }
        if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') {
            throw new TypeError('frame scheduler');
        }
        running = true;
        RESET_TIMING(false);
        const CURRENT = ++generation;
        const FRAME = (timestamp) => {
            if (!running || CURRENT !== generation) {
                return;
            }
            if (inputPreview || HAS_SUBMISSION) {
                OBSERVE_INPUT(timestamp);
            }
            PULSE(timestamp);
            if (running && CURRENT === generation) {
                handle = requestFrame(FRAME);
            }
        };
        globalThis.addEventListener?.('blur', RELEASE);
        globalThis.document?.addEventListener('visibilitychange', HIDDEN);
        handle = requestFrame(FRAME);
    };
    const FLUSH_INPUT = (timestamp) => OBSERVE_INPUT(timestamp);
    const POLL_INPUT = (timestamp) => {
        const SAMPLE = OBSERVE_INPUT(timestamp);
        session.poll();
        return SAMPLE;
    };
    return {
        get simulationTimeMs() {
            return last === undefined ? null : last - accumulator;
        },
        get rates() {
            return CONFIGURED_RATES;
        },
        get nextDeadlineMs() {
            return last === undefined
                ? null
                : last + Math.max(0, QUANTUM * (session.pace ?? session.metrics.pace) - accumulator);
        },
        start: START,
        stop: STOP,
        pulse: PULSE,
        render: RENDER_FRAME,
        observeInput: OBSERVE_INPUT,
        flushInput: FLUSH_INPUT,
        pollInput: POLL_INPUT,
        releaseInput: RELEASE,
        resetTiming: RESET_TIMING,
        get running() {
            return running;
        },
    };
}
