import { MAX_TICK, runSimulationFrame, copyFrame } from '../_rollback-shared/protocol.js';
import { StateHistory } from '../_rollback-shared/history.js';
import { integer, bytes, equalBytes, hashBytes, compareIds } from './utilities.js';

/** A mismatch between the forward execution and a real load/resimulation. */
export class DeterminismError extends Error {
    constructor({ tick, checkpointTick, expected, actual, inputs }) {
        let offset = 0;
        while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) {
            offset++;
        }
        super(`Determinism mismatch at state S[${tick}], first byte ${offset}, checkpoint S[${checkpointTick}]`);
        this.name = 'DeterminismError';
        this.code = 'determinism-mismatch';
        this.tick = tick;
        this.checkpointTick = checkpointTick;
        this.firstDifference = offset;
        this.expectedHash = hashBytes(expected);
        this.actualHash = hashBytes(actual);
        this.expectedState = expected.slice();
        this.actualState = actual.slice();
        this.inputs = inputs.map((frame) => ({
            ...copyFrame(frame),
            playerId: frame.playerId,
            predicted: false,
        }));
    }
}
export function createSyncTestSession(options) {
    return new SyncTestSession(options);
}

/** Local determinism diagnostic; all players supply actual input. No transport or clock. */
export class SyncTestSession {
    constructor({
        adapter,
        players,
        inputSize,
        tickRate = 60,
        initialTick = 0,
        checkDistance = 1,
        maxSnapshotBytes = 4 * 1024 * 1024,
        maxHistoryBytes = 64 * 1024 * 1024,
        now = () => globalThis.performance?.now() ?? Date.now(),
    } = {}) {
        if (
            !adapter ||
            ['save', 'load', 'step', 'validateSnapshot'].some((key) => typeof adapter[key] !== 'function')
        ) {
            throw new TypeError('Simulation Adapter capabilities');
        }
        if (
            !Array.isArray(players) ||
            !players.length ||
            players.length > 8 ||
            players.some((id) => typeof id !== 'string' || !id.length) ||
            new Set(players).size !== players.length
        ) {
            throw new TypeError('fixed player roster');
        }
        if (typeof now !== 'function') {
            throw new TypeError('diagnostic clock');
        }
        this._now = now;
        this._cost = {
            forwardCostMs: 0,
            resimulationCostMs: 0,
            totalCostMs: 0,
        };
        this.adapter = adapter;
        this.players = Object.freeze([...players].sort(compareIds));
        this.inputSize = integer(inputSize, 'inputSize', 1, 1024);
        this.tickRate = integer(tickRate, 'tickRate', 1, 240);
        this.checkDistance = integer(checkDistance, 'checkDistance', 1, 256);
        this._tick = integer(initialTick, 'initialTick', 0, MAX_TICK);
        this.initialTick = this.tick;
        this.maxSnapshotBytes = integer(maxSnapshotBytes, 'maxSnapshotBytes', 1, 64 * 1024 * 1024);
        integer(maxHistoryBytes, 'maxHistoryBytes', 1, 0x7fffffff);
        this._history = new StateHistory(checkDistance + 1, maxHistoryBytes);
        this._frames = new Map();
        this.failure = null;
        this.closed = false;
        this.resimulatedTicks = 0;
        this.checkedTicks = 0;
        const INITIAL = this._save();
        if (INITIAL.length * (checkDistance + 1) > maxHistoryBytes) {
            throw new RangeError('synctest history byte budget');
        }
        if (
            adapter.validateSnapshot(INITIAL.slice(), {
                tick: this.tick,
            }) !== true
        ) {
            throw new TypeError('initial snapshot validation');
        }
        this._history.put({
            tick: this.tick,
            bytes: INITIAL,
        });
    }
    get tick() {
        return this._tick;
    }
    get status() {
        return this.closed ? 'closed' : this.failure ? 'failed' : 'running';
    }
    get metrics() {
        const ERROR = this.failure;
        const FAILURE = ERROR
            ? Object.freeze({
                  name: ERROR.name ?? 'Error',
                  message: String(ERROR.message ?? ERROR),
                  code: ERROR.code ?? null,
                  tick: ERROR.tick ?? null,
                  checkpointTick: ERROR.checkpointTick ?? null,
                  firstDifference: ERROR.firstDifference ?? null,
                  expectedHash: ERROR.expectedHash ?? null,
                  actualHash: ERROR.actualHash ?? null,
              })
            : null;
        return Object.freeze({
            status: this.status,
            tick: this.tick,
            checkDistance: this.checkDistance,
            checkedTicks: this.checkedTicks,
            resimulatedTicks: this.resimulatedTicks,
            stateHash: this.closed ? null : (this.getStateHash() ?? null),
            historyBytes: this._history.byteLength,
            failure: FAILURE,
            ...this._cost,
        });
    }
    _save() {
        const VALUE = bytes(this.adapter.save()).slice();
        if (!VALUE.length || VALUE.length > this.maxSnapshotBytes) {
            throw new RangeError('snapshot size');
        }
        return VALUE;
    }
    _inputs(inputs) {
        if (!Array.isArray(inputs) || inputs.length !== this.players.length) {
            throw new TypeError('all local player inputs required');
        }
        const ORDERED = [...inputs].sort((a, b) => compareIds(a.playerId, b.playerId));
        return ORDERED.map((frame, index) => {
            if (frame.playerId !== this.players[index] || bytes(frame.input).length !== this.inputSize) {
                throw new TypeError('player/inputSize');
            }
            const COMMANDS = frame.commands ?? [];
            if (!Array.isArray(COMMANDS) || COMMANDS.length > 256) {
                throw new TypeError('commands');
            }
            const SORTED = [...COMMANDS].sort((a, b) => a.sequence - b.sequence);
            let previous = 0;
            for (const COMMAND of SORTED) {
                integer(COMMAND.sequence, 'command sequence', 1);
                if (COMMAND.sequence <= previous || COMMAND.executeTick !== this.tick) {
                    throw new TypeError('command ordering/executeTick');
                }
                const PAYLOAD = bytes(COMMAND.payload);
                if (!PAYLOAD.length || PAYLOAD.length > 15360) {
                    throw new RangeError('command payload');
                }
                previous = COMMAND.sequence;
            }
            return {
                ...copyFrame({
                    input: bytes(frame.input),
                    commands: SORTED,
                }),
                playerId: frame.playerId,
                predicted: false,
            };
        });
    }
    advance(inputs) {
        if (this.closed) {
            throw new Error('sync test closed');
        }
        if (this.failure) {
            throw this.failure;
        }
        integer(this.tick + 1, 'tick limit', 0, MAX_TICK);
        const FRAMES = this._inputs(inputs),
            BEFORE = this._history.get(this.tick),
            FRAME_TICK = this.tick;
        let forward = BEFORE.bytes;
        const STARTED = this._now();
        let replayStarted;
        try {
            runSimulationFrame(this.adapter, {
                tick: FRAME_TICK,
                tickRate: this.tickRate,
                inputs: FRAMES,
                resimulating: false,
                synctesting: true,
            });
            const NEXT = this._save();
            this._history.put({
                tick: FRAME_TICK + 1,
                bytes: NEXT,
            });
            forward = NEXT;
            this._frames.set(FRAME_TICK, FRAMES);
            this._tick++;
            replayStarted = this._now();
            this._cost.forwardCostMs += Math.max(0, replayStarted - STARTED);
            const FROM = Math.max(this.initialTick, this.tick - this.checkDistance);
            this.adapter.load(this._history.get(FROM).bytes.slice());
            for (let tick = FROM; tick < this.tick; tick++) {
                const INPUT = this._frames.get(tick);
                runSimulationFrame(this.adapter, {
                    tick,
                    tickRate: this.tickRate,
                    inputs: INPUT,
                    resimulating: true,
                    synctesting: true,
                });
                const ACTUAL = this._save(),
                    EXPECTED = this._history.get(tick + 1).bytes;
                this.resimulatedTicks++;
                if (!equalBytes(ACTUAL, EXPECTED)) {
                    throw new DeterminismError({
                        tick: tick + 1,
                        checkpointTick: FROM,
                        expected: EXPECTED,
                        actual: ACTUAL,
                        inputs: INPUT,
                    });
                }
            }
            this.checkedTicks++;
            for (const TICK of this._frames.keys()) {
                if (TICK < FROM) {
                    this._frames.delete(TICK);
                }
            }
        } catch (error) {
            this.failure = error;
            throw error;
        } finally {
            // Restore the forward snapshot even after a partial diagnostic replay.
            try {
                this.adapter.load(forward.slice());
            } catch (error) {
                if (this.failure) {
                    this.failure.restoreError = error;
                } else {
                    this.failure = error;
                    // eslint-disable-next-line no-unsafe-finally -- No earlier failure exists; propagate the restore failure.
                    throw error;
                }
            } finally {
                const FINISHED = this._now();
                if (replayStarted !== undefined) {
                    this._cost.resimulationCostMs += Math.max(0, FINISHED - replayStarted);
                } else {
                    this._cost.forwardCostMs += Math.max(0, FINISHED - STARTED);
                }
                this._cost.totalCostMs += Math.max(0, FINISHED - STARTED);
            }
        }
        return {
            tick: this.tick,
            checkedTicks: this.checkedTicks,
            resimulatedTicks: this.resimulatedTicks,
        };
    }
    getStateHash() {
        const STATE = this._history.get(this.tick);
        if (!STATE) {
            return undefined;
        }
        if (STATE.hash === undefined) {
            STATE.hash = hashBytes(STATE.bytes);
        }
        return STATE.hash;
    }
    close() {
        this.closed = true;
        this._frames.clear();
        this._history.slots.fill(undefined);
        this._history.byteLength = 0;
    }
}
function beginSyncTestBatch(frames, options) {
    if (!Array.isArray(frames)) {
        throw new TypeError('frames');
    }
    return {
        initial: bytes(options.adapter.save()).slice(),
        session: createSyncTestSession(options),
    };
}
function advanceSyncTestBatch(session, frame) {
    if (frame.tick !== session.tick) {
        throw new TypeError('non-contiguous test frames');
    }
    session.advance(frame.inputs);
}
function syncTestBatchResult(session) {
    return {
        tick: session.tick,
        checkedTicks: session.checkedTicks,
        resimulatedTicks: session.resimulatedTicks,
        hash: session.getStateHash(),
        metrics: session.metrics,
    };
}
function syncTestBatchFailure(session, error) {
    const FAILURE = error instanceof Error ? error : new Error(String(error));
    session.failure ??= FAILURE;
    FAILURE.syncTestMetrics = session.metrics;
    return FAILURE;
}
function checkSyncTestAbort(signal) {
    if (signal?.aborted) {
        if (signal.reason instanceof Error) {
            throw signal.reason;
        }
        const ERROR = new Error(signal.reason === undefined ? 'Synctest aborted' : String(signal.reason));
        ERROR.name = 'AbortError';
        throw ERROR;
    }
}

/** Batch check. Restores the caller's initial serialized state on completion/failure. */
export function runSyncTest({ frames, ...options } = {}) {
    const { initial: INITIAL, session: SESSION } = beginSyncTestBatch(frames, options);
    try {
        for (const FRAME of frames) {
            advanceSyncTestBatch(SESSION, FRAME);
        }
        return syncTestBatchResult(SESSION);
    } catch (error) {
        throw syncTestBatchFailure(SESSION, error);
    } finally {
        SESSION.close();
        options.adapter.load(INITIAL);
    }
}

/** Cooperative batch check using the same session and frame boundary as the synchronous API. */
export async function runSyncTestAsync({
    frames,
    yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
    signal,
    ...options
} = {}) {
    if (typeof yieldControl !== 'function') {
        throw new TypeError('yieldControl');
    }
    const { initial: INITIAL, session: SESSION } = beginSyncTestBatch(frames, options);
    try {
        checkSyncTestAbort(signal);
        for (const FRAME of frames) {
            await yieldControl();
            checkSyncTestAbort(signal);
            advanceSyncTestBatch(SESSION, FRAME);
            await yieldControl();
            checkSyncTestAbort(signal);
        }
        return syncTestBatchResult(SESSION);
    } catch (error) {
        throw syncTestBatchFailure(SESSION, error);
    } finally {
        SESSION.close();
        options.adapter.load(INITIAL);
    }
}
