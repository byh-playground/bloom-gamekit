import { CHUNK_SIZE, MAX_TICK, defaults, runSimulationFrame } from '../_rollback-shared/protocol.js';
import { bytes, compareIds, equalBytes, hashBytes, integer, nowMs } from '../deterministic/utilities.js';
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SUFFIX_TICKS = 8192;
function roster(value, name) {
    if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 8 ||
        Array.from(value).some((id) => typeof id !== 'string' || !id.length || id.length > 128) ||
        new Set(value).size !== value.length
    ) {
        throw new TypeError(name);
    }
    return value.slice();
}
function validateBootstrap(bootstrap, limits, expected, deferCheckpointHash = false) {
    if (!bootstrap || bootstrap.version !== 1) {
        throw new Error('bootstrap version');
    }
    const TICK = integer(bootstrap.tick, 'bootstrap tick', 0, MAX_TICK + 1);
    const INPUT_SIZE = integer(bootstrap.inputSize, 'bootstrap inputSize', 1, 1024);
    const TICK_RATE = integer(bootstrap.tickRate, 'bootstrap tickRate', 1, 240);
    const SEED = integer(bootstrap.seed, 'bootstrap seed');
    const SIMULATION_VERSION = bootstrap.simulationVersion;
    if (typeof SIMULATION_VERSION !== 'string' || !SIMULATION_VERSION.length || SIMULATION_VERSION.length > 128) {
        throw new TypeError('bootstrap simulationVersion');
    }
    const PLAYERS = roster(bootstrap.players, 'bootstrap players');
    if (PLAYERS.some((id, index) => index > 0 && compareIds(PLAYERS[index - 1], id) >= 0)) {
        throw new Error('bootstrap player order');
    }
    const PROVIDED_SEQUENCES = bootstrap.commandSequences;
    if (
        !PROVIDED_SEQUENCES ||
        typeof PROVIDED_SEQUENCES !== 'object' ||
        Array.isArray(PROVIDED_SEQUENCES) ||
        Object.keys(PROVIDED_SEQUENCES).length !== PLAYERS.length ||
        PLAYERS.some((id) => !Object.hasOwn(PROVIDED_SEQUENCES, id))
    ) {
        throw new TypeError('bootstrap command sequences roster');
    }
    const COMMAND_SEQUENCES = Object.fromEntries(
        PLAYERS.map((id) => [id, integer(PROVIDED_SEQUENCES[id], 'bootstrap command sequence boundary')]),
    );
    for (const FIELD of ['simulationVersion', 'inputSize', 'tickRate', 'seed']) {
        if (expected[FIELD] !== undefined && expected[FIELD] !== bootstrap[FIELD]) {
            throw new Error(`bootstrap ${FIELD} mismatch`);
        }
    }
    if (expected.players !== undefined) {
        const WANTED = roster(expected.players, 'expected players').sort(compareIds);
        if (WANTED.length !== PLAYERS.length || WANTED.some((id, index) => id !== PLAYERS[index])) {
            throw new Error('bootstrap players mismatch');
        }
    }
    const CHECKPOINT = bootstrap.checkpoint;
    const START = integer(CHECKPOINT?.tick, 'bootstrap checkpoint tick', 0, TICK);
    const DATA = bytes(CHECKPOINT?.bytes, 'bootstrap checkpoint');
    if (!DATA.length || DATA.length > limits.maxSnapshotBytes) {
        throw new RangeError('bootstrap snapshot size');
    }
    const CHECKPOINT_BYTES = DATA.slice();
    const CHECKPOINT_HASH = integer(CHECKPOINT.hash, 'bootstrap checkpoint hash');
    if (!deferCheckpointHash && hashBytes(CHECKPOINT_BYTES) !== CHECKPOINT_HASH) {
        throw new Error('bootstrap checkpoint hash mismatch');
    }
    const HASH = integer(bootstrap.hash, 'bootstrap final hash');
    if (
        !Array.isArray(bootstrap.frames) ||
        bootstrap.frames.length !== TICK - START ||
        TICK - START > limits.maxSuffixTicks
    ) {
        throw new RangeError('bootstrap suffix length');
    }
    if (START === TICK && CHECKPOINT_HASH !== HASH) {
        throw new Error('bootstrap final hash mismatch');
    }
    let totalBytes = DATA.length;
    if (totalBytes > limits.maxReplayBytes) {
        throw new RangeError('bootstrap replay byte budget');
    }
    const SEQUENCES = new Map(PLAYERS.map((id) => [id, 0]));
    const FRAMES = Array.from(bootstrap.frames, (frame, index) => {
        const FRAME_TICK = START + index;
        if (frame?.tick !== FRAME_TICK) {
            throw new Error('non-contiguous bootstrap suffix');
        }
        if (!Array.isArray(frame.inputs) || frame.inputs.length !== PLAYERS.length) {
            throw new Error('bootstrap input roster');
        }
        totalBytes += 16;
        const INPUTS = Array.from(frame.inputs, (inputFrame, player) => {
            if (inputFrame?.playerId !== PLAYERS[player] || inputFrame.predicted !== false) {
                throw new Error('bootstrap confirmed input order');
            }
            const INPUT = bytes(inputFrame.input, 'bootstrap input');
            if (INPUT.length !== INPUT_SIZE) {
                throw new RangeError('bootstrap inputSize');
            }
            if (!Array.isArray(inputFrame.commands) || inputFrame.commands.length > limits.maxPendingCommands) {
                throw new RangeError('bootstrap command count');
            }
            let commandBytes = 0;
            totalBytes += INPUT_SIZE;
            const COMMANDS = Array.from(inputFrame.commands, (command) => {
                const SEQUENCE = integer(command?.sequence, 'bootstrap command sequence', 1);
                if (SEQUENCE <= SEQUENCES.get(PLAYERS[player]) || command.executeTick !== FRAME_TICK) {
                    throw new Error('bootstrap command order/tick');
                }
                SEQUENCES.set(PLAYERS[player], SEQUENCE);
                const PAYLOAD = bytes(command.payload, 'bootstrap command payload');
                commandBytes += PAYLOAD.length + 6;
                totalBytes += PAYLOAD.length + 12;
                if (
                    !PAYLOAD.length ||
                    PAYLOAD.length > limits.maxCommandBytes ||
                    commandBytes > CHUNK_SIZE - 1024 - INPUT_SIZE
                ) {
                    throw new RangeError('bootstrap command size');
                }
                if (totalBytes > limits.maxReplayBytes) {
                    throw new RangeError('bootstrap replay byte budget');
                }
                return {
                    sequence: SEQUENCE,
                    executeTick: FRAME_TICK,
                    payload: PAYLOAD.slice(),
                };
            });
            if (totalBytes > limits.maxReplayBytes) {
                throw new RangeError('bootstrap replay byte budget');
            }
            return {
                playerId: PLAYERS[player],
                input: INPUT.slice(),
                commands: COMMANDS,
                predicted: false,
            };
        });
        return {
            tick: FRAME_TICK,
            inputs: INPUTS,
        };
    });
    for (const [ID, SEQUENCE] of SEQUENCES) {
        if (SEQUENCE && SEQUENCE !== COMMAND_SEQUENCES[ID]) {
            throw new Error('bootstrap command sequence boundary mismatch');
        }
    }
    return {
        version: 1,
        tick: TICK,
        checkpoint: {
            tick: START,
            bytes: CHECKPOINT_BYTES,
            hash: CHECKPOINT_HASH,
        },
        players: PLAYERS,
        frames: FRAMES,
        hash: HASH,
        inputSize: INPUT_SIZE,
        tickRate: TICK_RATE,
        simulationVersion: SIMULATION_VERSION,
        seed: SEED,
        commandSequences: COMMAND_SEQUENCES,
    };
}

/**
 * Replay a confirmed sparse checkpoint and suffix in bounded pulses. The caller
 * owns scheduling and must not step the same adapter while this job is active.
 * Adapter context uses bootstrap-local ticks; wrap the adapter for epoch offsets.
 * Candidate data is copied before loading. Any load, replay, or final validation
 * failure restores the original snapshot and throws; cancel() also restores it.
 */
export function createBootstrapReplay({
    adapter,
    bootstrap,
    maxCatchupSteps = 8,
    maxCatchupMs = 8,
    clock = nowMs,
    maxSnapshotBytes = defaults.maxSnapshotBytes,
    maxSuffixTicks = MAX_SUFFIX_TICKS,
    maxCommandBytes = defaults.maxCommandBytes,
    maxPendingCommands = defaults.maxPendingCommands,
    maxReplayBytes = defaults.maxReplayBytes,
    simulationVersion,
    inputSize,
    tickRate,
    players,
    seed,
} = {}) {
    if (!adapter || ['save', 'load', 'step', 'validateSnapshot'].some((name) => typeof adapter[name] !== 'function')) {
        throw new TypeError('Simulation Adapter must save, load, step, validateSnapshot');
    }
    integer(maxCatchupSteps, 'maxCatchupSteps', 1, MAX_SUFFIX_TICKS);
    if (!Number.isFinite(maxCatchupMs) || maxCatchupMs <= 0 || typeof clock !== 'function') {
        throw new TypeError('bootstrap time budget');
    }
    integer(maxSnapshotBytes, 'maxSnapshotBytes', 1, MAX_SNAPSHOT_BYTES);
    integer(maxSuffixTicks, 'maxSuffixTicks', 0, MAX_SUFFIX_TICKS);
    integer(maxCommandBytes, 'maxCommandBytes', 1, CHUNK_SIZE - 1024);
    integer(maxPendingCommands, 'maxPendingCommands', 1, 0x7fffffff);
    integer(maxReplayBytes, 'maxReplayBytes', 1, 0x7fffffff);
    const COOPERATIVE =
        typeof adapter.saveJob === 'function' &&
        typeof adapter.prepareSnapshotJob === 'function' &&
        typeof adapter.loadPreparedSnapshot === 'function';
    const CANDIDATE = validateBootstrap(
        bootstrap,
        {
            maxSnapshotBytes,
            maxSuffixTicks,
            maxCommandBytes,
            maxPendingCommands,
            maxReplayBytes,
        },
        {
            simulationVersion,
            inputSize,
            tickRate,
            players,
            seed,
        },
        COOPERATIVE,
    );
    const SAVE = () => {
        const DATA = bytes(adapter.save(), 'bootstrap adapter snapshot');
        if (!DATA.length || DATA.length > maxSnapshotBytes) {
            throw new RangeError('bootstrap adapter snapshot size');
        }
        return DATA.slice();
    };
    const CONTEXT = (tick) => ({
        tick,
        tickRate: CANDIDATE.tickRate,
        players: CANDIDATE.players.slice(),
        simulationVersion: CANDIDATE.simulationVersion,
        seed: CANDIDATE.seed,
    });
    if (COOPERATIVE) {
        return createCooperativeReplay({
            adapter,
            candidate: CANDIDATE,
            context: CONTEXT,
            maxSnapshotBytes,
            maxCatchupSteps,
            maxCatchupMs,
            clock,
        });
    }
    const ORIGINAL = SAVE();
    let tick = CANDIDATE.checkpoint.tick;
    let status = 'catching-up';
    let result = null;
    let failure = null;
    const RESTORE = (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
        status = 'failed';
        try {
            adapter.load(ORIGINAL.slice());
        } catch (restoreError) {
            failure = new AggregateError(
                [failure, restoreError],
                'bootstrap replay failed and original snapshot restoration failed',
            );
        }
        throw failure;
    };
    // Shape, ordering, capacity and checkpoint hash checks above cannot load a
    // malformed candidate into the game. Validation also precedes the first load.
    const PREPARED_PATH =
        typeof adapter.prepareSnapshot === 'function' && typeof adapter.loadPreparedSnapshot === 'function';
    // prepareSnapshot must perform all existing validation, including canonical
    // byte round-trip equivalence, and bind its owned state to this exact context.
    const PREPARED = PREPARED_PATH ? adapter.prepareSnapshot(CANDIDATE.checkpoint.bytes.slice(), CONTEXT(tick)) : null;
    if (
        PREPARED_PATH ? !PREPARED : adapter.validateSnapshot(CANDIDATE.checkpoint.bytes.slice(), CONTEXT(tick)) !== true
    ) {
        throw new Error('adapter rejected bootstrap checkpoint');
    }
    try {
        if (PREPARED_PATH) {
            adapter.loadPreparedSnapshot(PREPARED, CONTEXT(tick));
        } else {
            adapter.load(CANDIDATE.checkpoint.bytes.slice());
            if (!equalBytes(SAVE(), CANDIDATE.checkpoint.bytes)) {
                throw new Error('bootstrap checkpoint round-trip mismatch');
            }
        }
    } catch (error) {
        RESTORE(error);
    }
    return Object.freeze({
        get tick() {
            return tick;
        },
        get targetTick() {
            return CANDIDATE.tick;
        },
        get status() {
            return status;
        },
        get done() {
            return status === 'done';
        },
        get result() {
            return result;
        },
        get failure() {
            return failure;
        },
        pulse() {
            if (failure) {
                throw failure;
            }
            if (status !== 'catching-up') {
                return Object.freeze({
                    status,
                    tick,
                    targetTick: CANDIDATE.tick,
                    steps: 0,
                    ...(result ?? {}),
                });
            }
            let steps = 0;
            const STARTED = clock();
            try {
                while (
                    tick < CANDIDATE.tick &&
                    steps < maxCatchupSteps &&
                    (steps === 0 || clock() - STARTED < maxCatchupMs)
                ) {
                    const FRAME = CANDIDATE.frames[tick - CANDIDATE.checkpoint.tick];
                    runSimulationFrame(adapter, {
                        tick,
                        tickRate: CANDIDATE.tickRate,
                        inputs: FRAME.inputs,
                        resimulating: true,
                        recovering: true,
                        replaying: true,
                    });
                    tick++;
                    steps++;
                }
                if (tick === CANDIDATE.tick) {
                    const UNCHANGED = PREPARED_PATH && CANDIDATE.tick === CANDIDATE.checkpoint.tick;
                    const FINAL = UNCHANGED ? CANDIDATE.checkpoint.bytes : SAVE();
                    if (!UNCHANGED && hashBytes(FINAL) !== CANDIDATE.hash) {
                        throw new Error('bootstrap final hash mismatch');
                    }
                    if (!UNCHANGED && adapter.validateSnapshot(FINAL.slice(), CONTEXT(tick)) !== true) {
                        throw new Error('adapter rejected bootstrap final state');
                    }
                    status = 'done';
                    result = Object.freeze({
                        tick,
                        hash: CANDIDATE.hash,
                    });
                }
                return Object.freeze({
                    status,
                    tick,
                    targetTick: CANDIDATE.tick,
                    steps,
                    ...(result ?? {}),
                });
            } catch (error) {
                return RESTORE(error);
            }
        },
        cancel() {
            if (failure) {
                throw failure;
            }
            if (status === 'catching-up') {
                try {
                    adapter.load(ORIGINAL.slice());
                    status = 'cancelled';
                } catch (error) {
                    return RESTORE(error);
                }
            }
            return Object.freeze({
                status,
                tick,
                targetTick: CANDIDATE.tick,
                steps: 0,
                ...(result ?? {}),
            });
        },
    });
}

// Cooperative path is opt-in: factories and every pulse must do bounded work.
// The caller owns a paused adapter for the entire job, including original save.
function createCooperativeReplay({
    adapter,
    candidate,
    context,
    maxSnapshotBytes,
    maxCatchupSteps,
    maxCatchupMs,
    clock,
}) {
    let tick = candidate.checkpoint.tick;
    let status = 'catching-up';
    let phase = 'checkpoint-hash';
    let result = null;
    let failure = null;
    let original;
    let final;
    let loaded = false;
    let job;
    let hash = 2166136261;
    let hashOffset = 0;
    const OWN = (value) => {
        const DATA = bytes(value, 'bootstrap job snapshot');
        if (!DATA.length || DATA.length > maxSnapshotBytes) {
            throw new RangeError('bootstrap adapter snapshot size');
        }
        return DATA.slice();
    };
    const CHECK_JOB = (value) => {
        if (!value || typeof value.pulse !== 'function' || typeof value.cancel !== 'function') {
            throw new TypeError('snapshot preparation job');
        }
        return value;
    };
    const FAIL = (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
        status = 'failed';
        try {
            job?.cancel();
        } catch {
            // Cancellation is best-effort; continue restoring the original state after failure.
        }
        job = null;
        if (loaded && original) {
            try {
                adapter.load(original.slice());
            } catch (restoreError) {
                failure = new AggregateError(
                    [failure, restoreError],
                    'bootstrap replay failed and original snapshot restoration failed',
                );
            }
        }
        original = final = null;
        throw failure;
    };
    const FINISH = () => {
        status = 'done';
        phase = 'done';
        result = Object.freeze({
            tick,
            hash: candidate.hash,
        });
        original = final = null;
    };
    const RESPONSE = (steps) =>
        Object.freeze({
            status,
            tick,
            targetTick: candidate.tick,
            steps,
            ...(result ?? {}),
        });
    return Object.freeze({
        get tick() {
            return tick;
        },
        get targetTick() {
            return candidate.tick;
        },
        get status() {
            return status;
        },
        get done() {
            return status === 'done';
        },
        get result() {
            return result;
        },
        get failure() {
            return failure;
        },
        pulse() {
            if (failure) {
                throw failure;
            }
            if (status !== 'catching-up') {
                return RESPONSE(0);
            }
            let steps = 0;
            const STARTED = clock();
            try {
                if (phase === 'checkpoint-hash') {
                    do {
                        const END = Math.min(candidate.checkpoint.bytes.length, hashOffset + 65536);
                        hash = hashBytes(candidate.checkpoint.bytes.subarray(hashOffset, END), hash);
                        hashOffset = END;
                    } while (hashOffset < candidate.checkpoint.bytes.length && clock() - STARTED < maxCatchupMs);
                    if (hashOffset === candidate.checkpoint.bytes.length) {
                        if (hash !== candidate.checkpoint.hash) {
                            throw new Error('bootstrap checkpoint hash mismatch');
                        }
                        hash = 2166136261;
                        hashOffset = 0;
                        phase = 'original';
                    }
                } else if (phase === 'original' || phase === 'final') {
                    job ??= CHECK_JOB(adapter.saveJob());
                    job.pulse({
                        budgetMs: maxCatchupMs,
                    });
                    if (job.done) {
                        const DATA = OWN(job.result);
                        job = null;
                        if (phase === 'original') {
                            original = DATA;
                            phase = 'prepare';
                        } else {
                            final = DATA;
                            phase = 'hash';
                        }
                    }
                } else if (phase === 'prepare' || phase === 'validate') {
                    job ??= CHECK_JOB(
                        adapter.prepareSnapshotJob(
                            (phase === 'prepare' ? candidate.checkpoint.bytes : final).slice(),
                            context(tick),
                        ),
                    );
                    job.pulse({
                        budgetMs: maxCatchupMs,
                    });
                    if (job.done) {
                        const TOKEN = job.result;
                        job = null;
                        if (!TOKEN) {
                            throw new Error('adapter rejected bootstrap snapshot');
                        }
                        if (phase === 'validate') {
                            FINISH();
                        } else {
                            final = TOKEN;
                            phase = 'install';
                        }
                    }
                } else if (phase === 'install') {
                    const TOKEN = final;
                    final = null;
                    loaded = true;
                    adapter.loadPreparedSnapshot(TOKEN, context(tick));
                    if (tick === candidate.tick) {
                        FINISH();
                    } else {
                        phase = 'replay';
                    }
                } else if (phase === 'replay') {
                    while (
                        tick < candidate.tick &&
                        steps < maxCatchupSteps &&
                        (steps === 0 || clock() - STARTED < maxCatchupMs)
                    ) {
                        runSimulationFrame(adapter, {
                            tick,
                            tickRate: candidate.tickRate,
                            inputs: candidate.frames[tick - candidate.checkpoint.tick].inputs,
                            resimulating: true,
                            recovering: true,
                            replaying: true,
                        });
                        tick++;
                        steps++;
                    }
                    if (tick === candidate.tick) {
                        phase = 'final';
                    }
                } else if (phase === 'hash') {
                    do {
                        const END = Math.min(final.length, hashOffset + 65536);
                        hash = hashBytes(final.subarray(hashOffset, END), hash);
                        hashOffset = END;
                    } while (hashOffset < final.length && clock() - STARTED < maxCatchupMs);
                    if (hashOffset === final.length) {
                        if (hash !== candidate.hash) {
                            throw new Error('bootstrap final hash mismatch');
                        }
                        phase = 'validate';
                    }
                }
                return RESPONSE(steps);
            } catch (error) {
                return FAIL(error);
            }
        },
        cancel() {
            if (failure) {
                throw failure;
            }
            if (status === 'catching-up') {
                try {
                    job?.cancel();
                    job = null;
                    if (loaded) {
                        adapter.load(original.slice());
                    }
                } catch (error) {
                    return FAIL(error);
                }
                status = 'cancelled';
                original = final = null;
            }
            return RESPONSE(0);
        },
    });
}
