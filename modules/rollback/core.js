import {
    REPLAY_FORMAT_VERSION,
    VERSION,
    PROTOCOL_VERSION,
    CHUNK_SIZE,
    MAX_TICK,
    defaults,
    profiles,
    encoder,
    decoder,
    MAGIC,
    TYPE,
    HEADER,
    SNAP_CHUNK_BYTES,
    Writer,
    Reader,
    packet,
    frameEqual,
    copyFrame,
    runSimulationFrame,
} from '../_rollback-shared/protocol.js';
import { nowMs, compareIds, integer, bytes, equalBytes, hashBytes } from '../deterministic/utilities.js';
function copyLocalCommandState(state, inputSize, profile, executedSequence = 0) {
    if (!state || typeof state !== 'object') {
        throw new TypeError('localCommandState');
    }
    const SEQUENCE = integer(state.sequence, 'local command sequence', executedSequence);
    const LAST_INPUT = bytes(state.lastInput, 'local command lastInput');
    if (LAST_INPUT.length !== inputSize) {
        throw new RangeError('local command inputSize');
    }
    // Already captured commands can occupy every delayed slot as well as the
    // waiting queue. Importing them must not silently discard valid edge input.
    const MAX_COMMANDS = profile.maxPendingCommands * (profile.maxInputDelayTicks + profile.stateHistorySize + 2);
    if (!Array.isArray(state.commands) || state.commands.length > MAX_COMMANDS) {
        throw new RangeError('local command capacity');
    }
    const MAX_PAYLOAD = Math.min(profile.maxCommandBytes, CHUNK_SIZE - 1024 - inputSize - 6);
    const MAX_BYTES =
        profile.maxPendingCommands * MAX_PAYLOAD +
        (profile.maxInputDelayTicks + profile.stateHistorySize + 1) * (CHUNK_SIZE - 1024 - inputSize);
    let previous = executedSequence;
    let previousTick = -1;
    let size = 0;
    const COMMANDS = Array.from(state.commands, (command) => {
        const NEXT = integer(command?.sequence, 'local command order', 1, SEQUENCE);
        if (NEXT <= previous) {
            throw new RangeError('local command order');
        }
        const PAYLOAD = bytes(command.payload, 'local command payload');
        if (!PAYLOAD.length || PAYLOAD.length > MAX_PAYLOAD || (size += PAYLOAD.length) > MAX_BYTES) {
            throw new RangeError('local command capacity');
        }
        const EXECUTE_TICK = integer(command.executeTick, 'reserved execution tick', 0, MAX_TICK);
        if (EXECUTE_TICK < previousTick) {
            throw new RangeError('reserved execution order');
        }
        previous = NEXT;
        previousTick = EXECUTE_TICK;
        return {
            sequence: NEXT,
            executeTick: EXECUTE_TICK,
            payload: PAYLOAD.slice(),
        };
    });
    let inputTick = -1;
    const FRAMES = state.inputs ?? [];
    if (!Array.isArray(FRAMES) || FRAMES.length > profile.stateHistorySize * 4 + profile.maxInputDelayTicks + 1) {
        throw new RangeError('reserved input capacity');
    }
    const INPUTS = FRAMES.map((frame) => {
        const TICK = integer(frame.tick, 'reserved input tick', 0, MAX_TICK),
            INPUT_LOCAL = bytes(frame.input);
        if (TICK <= inputTick || INPUT_LOCAL.length !== inputSize) {
            throw new RangeError('reserved input order/size');
        }
        inputTick = TICK;
        return {
            tick: TICK,
            input: INPUT_LOCAL.slice(),
        };
    });
    const SEALED_THROUGH = integer(state.sealedThrough ?? -1, 'sealed input boundary', -1, MAX_TICK);
    return {
        sequence: SEQUENCE,
        lastInput: LAST_INPUT.slice(),
        commands: COMMANDS,
        inputs: INPUTS,
        sealedThrough: SEALED_THROUGH,
        tickOffset: 0,
    };
}
function commandSequenceMap(players, initial) {
    if (initial === undefined) {
        return new Map(players.map((id) => [id, 0]));
    }
    if (
        !initial ||
        typeof initial !== 'object' ||
        Array.isArray(initial) ||
        Object.keys(initial).length !== players.length ||
        players.some((id) => !Object.hasOwn(initial, id))
    ) {
        throw new TypeError('initial command sequences roster');
    }
    return new Map(players.map((id) => [id, integer(initial[id], 'initial command sequence')]));
}
// Snapshot records share a command map until a command executes.
function executedSequences(previous, inputs) {
    let next = previous;
    for (const FRAME of inputs) {
        for (const COMMAND of FRAME.commands) {
            if (next === previous) {
                next = new Map(previous);
            }
            next.set(FRAME.playerId, Math.max(next.get(FRAME.playerId), COMMAND.sequence));
        }
    }
    return next;
}
function profileOf(profile) {
    const P = {
        ...defaults,
        ...profile,
    };
    for (const [KEY, MAX] of [
        ['inputSafetyMarginMs', 1000],
        ['inputJitterMultiplier', 8],
    ]) {
        if (!Number.isFinite(P[KEY]) || P[KEY] < 0 || P[KEY] > MAX) {
            throw new RangeError(KEY);
        }
    }
    if (!['configured', 'network'].includes(P.inputScheduling)) {
        throw new TypeError('inputScheduling');
    }
    if (!['rollback', 'lockstep'].includes(P.mode)) {
        throw new TypeError('session mode');
    }
    if (P.mode === 'lockstep') {
        P.rollbackWindowTicks = 0;
    }
    for (const FIELD of [
        'tickRate',
        'stateHistorySize',
        'checksumInterval',
        'maxCatchupSteps',
        'heartbeatMs',
        'adaptationIntervalMs',
        'maxSnapshotBytes',
        'maxHistoryBytes',
        'maxReplayBytes',
        'maxCommandBytes',
        'maxPendingCommands',
        'maxQueuedBytes',
        'recoveryTimeoutMs',
        'maxRecoveryAttempts',
        'peerInterruptMs',
        'peerTimeoutMs',
    ]) {
        integer(P[FIELD], FIELD, 1, 0x7fffffff);
    }
    for (const FIELD of [
        'baseInputDelayTicks',
        'minInputDelayTicks',
        'maxInputDelayTicks',
        'rollbackWindowTicks',
        'tickDriftThreshold',
    ]) {
        integer(P[FIELD], FIELD, 0, 65535);
    }
    if (P.minInputDelayTicks > P.baseInputDelayTicks || P.baseInputDelayTicks > P.maxInputDelayTicks) {
        throw new RangeError('input delay bounds');
    }
    if (P.peerTimeoutMs <= P.peerInterruptMs) {
        throw new RangeError('peerTimeoutMs must exceed peerInterruptMs');
    }
    if (P.stateHistorySize < P.rollbackWindowTicks + 2) {
        throw new RangeError('stateHistorySize must exceed rollback window by two');
    }
    if (P.mode === 'lockstep' && P.checksumInterval > P.stateHistorySize) {
        throw new RangeError('lockstep checksumInterval must fit input history window');
    }
    if (P.stateHistorySize > 8192) {
        throw new RangeError('stateHistorySize capacity (8192)');
    }
    if (P.tickRate > 240 || P.maxCommandBytes > CHUNK_SIZE - 1024 || P.maxSnapshotBytes > 64 * 1024 * 1024) {
        throw new RangeError('profile size limit');
    }
    if (!['hold', 'neutral'].includes(P.predictionPolicy) && typeof P.predictionPolicy !== 'function') {
        throw new TypeError('predictionPolicy');
    }
    if (!['none', 'hold', 'dilation'].includes(P.pacingPolicy) || P.stallPolicy !== 'wait') {
        throw new TypeError('pacing/stall policy');
    }
    return Object.freeze(P);
}
import { StateHistory, CheckpointHistory } from '../_rollback-shared/history.js';
export function createSession(options) {
    return new RollbackSession(options);
}
// RoomSession's explicitly opted-in local single-player path has no peer,
// replay, recovery, or state-hash consumer. Keep this constructor internal to
// the public aggregate API so generic RollbackSession defaults don't change.
export function createLocalFastPathSession(options) {
    return new RollbackSession(options, undefined, true);
}
// RoomSession owns optional multi-peer snapshot selection. Not a public Core option.
export function delegateRoomRecovery(session, selectBoundary) {
    session._roomRecovery = selectBoundary;
}
// Module-private, consume-once handoff. Public options cannot supply a trusted
// checkpoint or bypass the normal initial save/hash path.
const BOUNDARIES = new WeakMap();
export function createSessionFromBoundary(options, state, hash) {
    const TOKEN = {};
    BOUNDARIES.set(TOKEN, {
        adapter: options.adapter,
        state,
        hash,
    });
    return new RollbackSession(options, TOKEN);
}
export class RollbackSession {
    constructor(
        {
            players,
            localPlayerId,
            sessionId,
            simulationVersion,
            seed = 1,
            inputSize,
            profile = profiles.action,
            adapter,
            authorityPlayerId,
            onEvent = () => {},
            recordReplay = true,
            clock = nowMs,
            localCommandState,
            initialCommandSequences,
        } = {},
        boundaryToken,
        localFastPath = false,
    ) {
        if (
            !Array.isArray(players) ||
            players.length < 1 ||
            players.length > 8 ||
            players.some((p) => typeof p !== 'string' || !p.length || p.length > 128) ||
            new Set(players).size !== players.length
        ) {
            throw new TypeError('fixed player roster (1..8 unique IDs)');
        }
        this.players = Object.freeze([...players].sort(compareIds));
        if (!this.players.includes(localPlayerId)) {
            throw new TypeError('localPlayerId');
        }
        if (
            typeof sessionId !== 'string' ||
            !sessionId.length ||
            sessionId.length > 128 ||
            typeof simulationVersion !== 'string' ||
            !simulationVersion.length ||
            simulationVersion.length > 128
        ) {
            throw new TypeError('sessionId/simulationVersion');
        }
        if (!adapter || ['save', 'load', 'step', 'validateSnapshot'].some((n) => typeof adapter[n] !== 'function')) {
            throw new TypeError('Simulation Adapter must save, load, step, validateSnapshot');
        }
        this.localPlayerId = localPlayerId;
        this.sessionId = sessionId;
        this.simulationVersion = simulationVersion;
        this.seed = integer(seed, 'seed');
        this.inputSize = integer(inputSize, 'inputSize', 1, 1024);
        if (typeof clock !== 'function') {
            throw new TypeError('monotonic runtime clock');
        }
        this._clock = clock;
        this.profile = profileOf(profile);
        this.adapter = adapter;
        this.onEvent = onEvent;
        this.localFastPath = localFastPath;
        if (
            localFastPath &&
            (this.players.length !== 1 || this.profile.mode !== 'lockstep' || recordReplay || boundaryToken)
        ) {
            throw new TypeError('local fast path requires one-player lockstep without replay or a recovery boundary');
        }
        this.authorityPlayerId = authorityPlayerId ?? this.players[0];
        if (!this.players.includes(this.authorityPlayerId)) {
            throw new TypeError('authorityPlayerId');
        }
        this._tick = 0;
        this._inputDelay =
            this.profile.inputScheduling === 'network'
                ? this.profile.minInputDelayTicks
                : this.profile.baseInputDelayTicks;
        this._requestedInputDelay = this._inputDelay;
        this.closed = false;
        this._failure = null;
        this._history = this.localFastPath ? null : this._newHistory();
        this._inputWriter = this.localFastPath ? null : new Writer(CHUNK_SIZE * this.players.length);
        this._inputs = new Map(this.players.map((p) => [p, new Map()]));
        this._through = new Map(this.players.map((p) => [p, -1]));
        this._used = new Map();
        this._peers = new Map();
        this._pendingCommands = [];
        this._commandSequences = commandSequenceMap(this.players, initialCommandSequences);
        this._commandSequence = this._commandSequences.get(localPlayerId);
        this._sequence = 0;
        this._captureTick = -1;
        this._lastLocalInput = new Uint8Array(this.inputSize);
        this._localCapture = null;
        this._localCaptureSequence = 0;
        this._localReservations = new Map();
        this._reservationRevision = 0;
        this._localCaptures = [];
        this._localExecutedInput = null;
        let carriedInputs = [];
        let carriedThrough = -1;
        if (localCommandState !== undefined) {
            const CARRIED = copyLocalCommandState(
                localCommandState,
                this.inputSize,
                this.profile,
                this._commandSequence,
            );
            this._commandSequence = CARRIED.sequence;
            this._lastLocalInput = CARRIED.lastInput;
            this._pendingCommands = CARRIED.commands;
            carriedInputs = CARRIED.inputs;
            carriedThrough = CARRIED.sealedThrough;
            integer(
                carriedThrough,
                'sealed input horizon',
                -1,
                this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks,
            );
            for (let tick = 0; tick <= carriedThrough; tick++) {
                if (carriedInputs[tick]?.tick !== tick) {
                    throw new RangeError('missing sealed input');
                }
            }
        }
        this._rollbackFrom = Infinity;
        this._replaying = false;
        this._inputHash = 2166136261;
        this._lastHashTick = -1;
        this._nextTransfer = 0;
        this._recoveryAttempts = 0;
        this._incomingSnapshot = null;
        this._requestedRecovery = null;
        this._lastAdaptation = null;
        this._stableWindows = 0;
        this._pace = 1;
        this._window = {
            advances: 0,
            received: 0,
            late: 0,
            depth: 0,
            rollback: 0,
            stall: 0,
            cost: 0,
            costSamples: 0,
        };
        this._metrics = {
            rollbacks: 0,
            resimulatedTicks: 0,
            maxRollbackDepth: 0,
            stalls: 0,
            holds: 0,
            recoveries: 0,
            rejectedSnapshots: 0,
            rejectedPackets: 0,
            sentBytes: 0,
            receivedBytes: 0,
            predictedTicks: 0,
            hashMismatches: 0,
            latestResimulationMs: 0,
            smoothedRTT: 0,
            jitter: 0,
            lateInputRate: 0,
            rollbackFrequency: 0,
            stallFrequency: 0,
            resimulationCostMs: 0,
            stateHashComputations: 0,
            hashedStateBytes: 0,
            snapshotSaves: 0,
            serializedSnapshotBytes: 0,
            inputReservations: 0,
            inputReservationSentBytes: 0,
            inputReservationReceivedBytes: 0,
        };
        this._recordReplay = recordReplay;
        this._replayFrames = [];
        this._replayBytes = 0;
        this._replayFinalHash = undefined;
        const BOUNDARY = BOUNDARIES.get(boundaryToken);
        if (BOUNDARY) {
            BOUNDARIES.delete(boundaryToken);
        }
        if (BOUNDARY && BOUNDARY.adapter !== adapter) {
            throw new Error('initial boundary adapter');
        }
        if (this.localFastPath) {
            // A local single-player session has no handshake, checksum, replay, or
            // automatic recovery consumer. The game's adapter remains available to
            // its owner for explicit saves and restores.
            this._initialState = null;
            this._currentState = null;
            this._hello = null;
        } else {
            const INITIAL = BOUNDARY ? BOUNDARY.state : this._save();
            if (!INITIAL.length || INITIAL.length > this.profile.maxSnapshotBytes) {
                throw new RangeError('snapshot size');
            }
            const RETAINED_COUNT =
                this.profile.mode === 'lockstep'
                    ? Math.ceil(this.profile.stateHistorySize / this.profile.checksumInterval) + 2
                    : this.profile.stateHistorySize;
            const REQUIRED_BYTES = INITIAL.length * RETAINED_COUNT;
            if (REQUIRED_BYTES > this.profile.maxHistoryBytes) {
                throw Object.assign(new RangeError('initial snapshot cannot fill retained history byte budget'), {
                    code: 'history-capacity',
                    snapshotBytes: INITIAL.length,
                    requiredBytes: REQUIRED_BYTES,
                    maxHistoryBytes: this.profile.maxHistoryBytes,
                });
            }
            this._initialState = BOUNDARY ? INITIAL : INITIAL.slice();
            const INITIAL_RECORD = {
                tick: 0,
                bytes: INITIAL,
                inputHash: this._inputHash,
                commandSequences: this._commandSequences,
                ...(BOUNDARY
                    ? {
                          hash: BOUNDARY.hash,
                      }
                    : {}),
            };
            this._history.put(INITIAL_RECORD);
            this._currentState = INITIAL_RECORD;
            this._hello = encoder.encode(
                JSON.stringify({
                    protocol: PROTOCOL_VERSION,
                    library: VERSION,
                    sessionId,
                    simulationVersion,
                    seed,
                    players: this.players,
                    tickRate: this.profile.tickRate,
                    inputSize,
                    authorityPlayerId: this.authorityPlayerId,
                    mode: this.profile.mode,
                    baseInputDelayTicks: this.profile.mode === 'lockstep' ? this.profile.baseInputDelayTicks : null,
                    checksumInterval: this.profile.mode === 'lockstep' ? this.profile.checksumInterval : null,
                    initialHash: this._stateHash(INITIAL_RECORD),
                }),
            );
        }
        const NEUTRAL = new Uint8Array(this.inputSize);
        if (localCommandState) {
            for (const ENTRY of carriedInputs) {
                this._localReservations.set(ENTRY.tick, {
                    tick: ENTRY.tick,
                    input: bytes(ENTRY.input).slice(),
                    commands: [],
                    revision: ++this._reservationRevision,
                    packet: null,
                });
            }
            for (const COMMAND of this._pendingCommands) {
                if (!this._localReservations.has(COMMAND.executeTick)) {
                    this._localReservations.set(COMMAND.executeTick, {
                        tick: COMMAND.executeTick,
                        input: this._lastLocalInput.slice(),
                        commands: [],
                        revision: ++this._reservationRevision,
                        packet: null,
                    });
                }
                this._localReservations.get(COMMAND.executeTick).commands.push(COMMAND);
            }
        }
        for (let t = 0; t <= Math.max(this.inputDelay - 1, carriedThrough); t++) {
            this._sealLocal(t, NEUTRAL);
        }
    }
    get tick() {
        return this._tick;
    }
    get inputDelay() {
        return this._inputDelay;
    }
    get confirmedTick() {
        return Math.min(...this._through.values());
    }
    get confirmedBoundary() {
        return Math.min(this.tick, this.confirmedTick + 1);
    }
    /** Detached metadata about immutable local captures, not a simulation snapshot. */
    get localInputState() {
        const FRAME = this._localCapture;
        return {
            epoch: 0,
            baseTick: 0,
            tick: this.tick,
            confirmedTick: Math.min(this.tick - 1, this.confirmedTick),
            inputDelay: this.inputDelay,
            commandSequence: this._commandSequence,
            executedInput: this._localExecutedInput?.slice() ?? null,
            replayInput:
                (this._inputs.get(this.localPlayerId).get(this.tick)?.input ?? this._localExecutedInput)?.slice() ??
                null,
            executedCommandSequence:
                this.profile.mode === 'lockstep' ? this._commandSequences.get(this.localPlayerId) : null,
            captures: this._localCaptures.map((c) => ({
                ...c,
                input: c.input.slice(),
                commands: c.commands.map((command) => ({
                    ...command,
                    payload: command.payload.slice(),
                })),
            })),
            capture: FRAME
                ? {
                      ...FRAME,
                      input: FRAME.input.slice(),
                      commands: FRAME.commands.map((c) => ({
                          ...c,
                          payload: c.payload.slice(),
                      })),
                  }
                : null,
        };
    }
    get resimulating() {
        return this._replaying || this._rollbackFrom !== Infinity;
    }
    get failure() {
        return this._failure;
    }
    get requestedInputDelay() {
        return this._requestedInputDelay;
    }
    get ready() {
        return (
            !this.closed &&
            !this._failure &&
            this.players.every(
                (p) =>
                    p === this.localPlayerId ||
                    (this._peers.get(p)?.ready && this._peers.get(p).connectionState === 'connected'),
            )
        );
    }
    get status() {
        if (this.closed) {
            return 'closed';
        }
        if (this._failure) {
            return 'failed';
        }
        const PEERS = [...this._peers.values()];
        if (PEERS.some((p) => p.connectionState === 'disconnected')) {
            return 'disconnected';
        }
        if (PEERS.some((p) => p.connectionState === 'interrupted')) {
            return 'interrupted';
        }
        if (!this.ready) {
            return 'synchronizing';
        }
        if (this._requestedRecovery) {
            return 'recovering';
        }
        return this.resimulating ? 'resimulating' : 'running';
    }
    getPeerState(peerId) {
        const PEER = this._peers.get(peerId);
        if (!PEER) {
            return undefined;
        }
        return Object.freeze({
            peerId,
            state: PEER.connectionState,
            handshakeComplete: PEER.ready,
            lastReceivedAt: PEER.lastReceivedAt,
            simTick: PEER.tick,
            confirmedInputTick: PEER.confirmed,
            ackTick: PEER.ack,
            rtt: PEER.rtt,
            jitter: PEER.jitter,
        });
    }
    /** Current scheduling multiplier without allocating a diagnostic metrics snapshot. */
    get pace() {
        return this._pace;
    }
    get metrics() {
        return {
            ...this._metrics,
            inputDelay: this.inputDelay,
            requestedInputDelay: this.requestedInputDelay,
            confirmedTick: this.confirmedTick,
            tick: this.tick,
            pace: this._pace,
            retainedSnapshotBytes: this._history?.byteLength ?? 0,
        };
    }
    _newHistory() {
        const HISTORY = this.profile.mode === 'lockstep' ? CheckpointHistory : StateHistory;
        return new HISTORY(this.profile.stateHistorySize, this.profile.maxHistoryBytes);
    }
    _stateAt(tick) {
        if (this.localFastPath) {
            return undefined;
        }
        const RETAINED = this._history.get(tick);
        if (RETAINED) {
            return RETAINED;
        }
        if (this.profile.mode !== 'lockstep' || tick !== this.tick || this.resimulating) {
            return undefined;
        }
        if (this._currentState?.tick === tick) {
            return this._currentState;
        }
        if (this._failure?.type === 'fatal') {
            return undefined;
        }
        if (this._currentState?.tick !== tick) {
            this._currentState = {
                tick,
                bytes: this._save(),
                inputHash: this._inputHash,
                commandSequences: this._commandSequences,
            };
        }
        return this._currentState;
    }
    _stateHash(state) {
        if (!state) {
            return undefined;
        }
        if (state.hash === undefined) {
            state.hash = hashBytes(state.bytes);
            this._metrics.stateHashComputations++;
            this._metrics.hashedStateBytes += state.bytes.length;
        }
        return state.hash;
    }
    _hashInputFrame(tick, inputs, previousHash) {
        const W = this._inputWriter.reset();
        W.u32(tick);
        for (const F of inputs) {
            W.raw(F.input);
            W.u16(F.commands.length);
            for (const C of F.commands) {
                W.u32(C.sequence);
                W.u16(C.payload.length);
                W.raw(C.payload);
            }
        }
        return hashBytes(W.usedBytes(), previousHash);
    }
    _event(type, detail = {}) {
        try {
            this.onEvent({
                type,
                tick: this.tick,
                ...detail,
            });
        } catch {
            /* Observers cannot change the protocol. */
        }
    }
    _fail(type, detail = {}) {
        if (this._failure || this.closed) {
            return;
        }
        this._failure = Object.freeze({
            type,
            ...detail,
        });
        this._event(type, detail);
    }
    _peerTransition(peer, state, type, detail = {}) {
        if (peer.connectionState === state) {
            return;
        }
        const PREVIOUS = peer.connectionState;
        peer.connectionState = state;
        if (type) {
            this._event(type, {
                peerId: peer.id,
                previous: PREVIOUS,
                state,
                ...detail,
            });
        }
    }
    _transportStatus(peer, state) {
        const VALUE = typeof state === 'string' ? state : state?.state;
        peer.transportState = VALUE;
        if (VALUE === 'closed' || VALUE === 'failed') {
            this._peerTransition(peer, 'disconnected', 'peer-disconnected', {
                reason: 'transport-' + VALUE,
            });
        } else if (VALUE === 'interrupted') {
            this._peerTransition(peer, 'interrupted', 'peer-interrupted', {
                reason: 'transport-interrupted',
            });
        }
        // An open channel still needs a fresh, valid protocol packet to resume.
    }
    _peerAlive(peer, sequence, now) {
        if (['closed', 'failed'].includes(peer.transportState)) {
            return;
        }
        const DELTA = peer.lastReceivedSequence === null ? 1 : (sequence - peer.lastReceivedSequence) >>> 0;
        if (DELTA === 0 || DELTA >= 0x80000000) {
            return;
        }
        peer.lastReceivedSequence = sequence;
        peer.lastReceivedAt = now;
        this._peerTransition(peer, 'connected', peer.connectionState === 'connecting' ? null : 'peer-resumed');
    }
    _peerLiveness(peer, now) {
        if (['closed', 'failed'].includes(peer.transportState)) {
            return;
        }
        const SILENCE = Math.max(0, now - peer.lastReceivedAt);
        if (SILENCE >= this.profile.peerTimeoutMs) {
            this._peerTransition(peer, 'disconnected', 'peer-timeout', {
                silenceMs: SILENCE,
            });
        } else if (SILENCE >= this.profile.peerInterruptMs && peer.connectionState !== 'disconnected') {
            this._peerTransition(peer, 'interrupted', 'peer-interrupted', {
                reason: 'silence',
                silenceMs: SILENCE,
            });
        }
    }
    _save() {
        const STATE = bytes(this.adapter.save(), 'snapshot').slice();
        if (!STATE.length || STATE.length > this.profile.maxSnapshotBytes) {
            throw new RangeError('snapshot size');
        }
        this._metrics.snapshotSaves++;
        this._metrics.serializedSnapshotBytes += STATE.length;
        return STATE;
    }
    _nextSequence() {
        this._sequence = (this._sequence + 1) >>> 0;
        return this._sequence;
    }
    attachTransport(peerId, transport) {
        if (this.localFastPath) {
            throw new Error('transport unavailable in local fast path');
        }
        if (this.closed) {
            throw new Error('session closed');
        }
        if (this._failure) {
            throw new Error('session failed: ' + this._failure.type);
        }
        if (peerId === this.localPlayerId || !this.players.includes(peerId) || this._peers.has(peerId)) {
            throw new TypeError('peerId already attached or outside roster');
        }
        if (typeof transport?.send !== 'function' || typeof transport.subscribe !== 'function') {
            throw new TypeError('Transport capability: send and subscribe');
        }
        const PEER = {
            id: peerId,
            transport,
            ready: false,
            ack: -1,
            tick: 0,
            confirmed: -1,
            clockSequence: null,
            clockAt: 0,
            lastSent: -Infinity,
            lastHello: -Infinity,
            pendingPings: new Map(),
            echo: 0,
            rtt: 0,
            jitter: 0,
            hashes: new Map(),
            controls: [],
            queuedBytes: 0,
            lastHashQueued: 0,
            unsubscribe: null,
            unsubscribeStatus: null,
            connectionState: 'connecting',
            transportState: undefined,
            lastReceivedAt: this._clock(),
            lastReceivedSequence: null,
        };
        this._peers.set(peerId, PEER);
        let detached = false;
        const CURRENT = () => !this.closed && !detached && this._peers.get(peerId) === PEER;
        PEER.detach = () => {
            if (detached) {
                return;
            }
            detached = true;
            if (this._peers.get(peerId) === PEER) {
                this._peers.delete(peerId);
            }
            // Clear first so reentrant cleanup and close never unsubscribe twice.
            const UNSUBSCRIBE = PEER.unsubscribe,
                UNSUBSCRIBE_STATUS = PEER.unsubscribeStatus;
            PEER.unsubscribe = PEER.unsubscribeStatus = null;
            try {
                UNSUBSCRIBE?.();
            } finally {
                UNSUBSCRIBE_STATUS?.();
            }
        };
        PEER.unsubscribe = transport.subscribe((data) => {
            if (CURRENT()) {
                this.receive(peerId, data);
            }
        });
        PEER.unsubscribeStatus = transport.subscribeStatus?.((state) => {
            if (CURRENT()) {
                this._transportStatus(PEER, state);
            }
        });
        if (transport.state) {
            this._transportStatus(PEER, transport.state);
        }
        this._sendHello(PEER, this._clock());
        return PEER.detach;
    }
    _send(peer, data) {
        try {
            if (peer.transport.send(data) === false) {
                return false;
            }
            this._metrics.sentBytes += data.length;
            return true;
        } catch (error) {
            this._event('transport-error', {
                peerId: peer.id,
                error,
            });
            return false;
        }
    }
    _sendHello(peer, now) {
        if (
            this._send(
                peer,
                packet(TYPE.HELLO, this._nextSequence(), (w) => w.raw(this._hello)),
            )
        ) {
            peer.lastHello = now;
        }
    }
    _queue(peer, data) {
        if (peer.queuedBytes + data.length > this.profile.maxQueuedBytes) {
            return false;
        }
        peer.controls.push(data);
        peer.queuedBytes += data.length;
        return true;
    }
    _commitLocal(tick, input, commands) {
        integer(tick, 'session tick limit', 0, MAX_TICK);
        const FRAME = {
            input: input.slice(),
            commands,
        };
        if (this._inputs.get(this.localPlayerId).has(tick)) {
            throw new Error('committed input is immutable');
        }
        this._inputs.get(this.localPlayerId).set(tick, FRAME);
        this._through.set(this.localPlayerId, tick);
    }
    queueCommand(payload) {
        return this.submitInput(this._lastLocalInput, {
            commands: [payload],
        }).commandSequences[0];
    }
    _schedulingDelay(now = this._clock(), details) {
        if (this.profile.inputScheduling !== 'network') {
            return this.inputDelay;
        }
        const RATE = this.profile.tickRate / 1000;
        let delay = this.profile.minInputDelayTicks;
        for (const PEER of this._peers.values()) {
            if (PEER.ready) {
                const ONE_WAY_MS = PEER.rtt / 2,
                    JITTER_MARGIN_MS = (PEER.jitter / 2) * this.profile.inputJitterMultiplier;
                const LEAD = (ONE_WAY_MS + JITTER_MARGIN_MS + this.profile.inputSafetyMarginMs) * RATE;
                const AGE =
                    PEER.clockSequence === null
                        ? 0
                        : Math.min(Math.max(0, now - PEER.clockAt), this.profile.heartbeatMs * 2) * RATE;
                const REMOTE_TICK = PEER.clockSequence === null ? this.tick : PEER.tick + AGE + (PEER.rtt / 2) * RATE;
                const PEER_LEAD_TICKS = Math.ceil(Math.floor(REMOTE_TICK) + LEAD - this.tick);
                delay = Math.max(delay, Math.ceil(LEAD), PEER_LEAD_TICKS);
                details?.push({
                    peerId: PEER.id,
                    rttMs: PEER.rtt,
                    oneWayMs: ONE_WAY_MS,
                    rttJitterMs: PEER.jitter,
                    jitterMarginMs: JITTER_MARGIN_MS,
                    safetyMarginMs: this.profile.inputSafetyMarginMs,
                    reportedTick: PEER.tick,
                    reportAgeMs: AGE / RATE,
                    estimatedPeerTick: REMOTE_TICK,
                    integerPeerTick: Math.floor(REMOTE_TICK),
                    leadTicks: LEAD,
                    peerLeadTicks: PEER_LEAD_TICKS,
                });
            }
        }
        return Math.min(this.profile.maxInputDelayTicks, delay);
    }
    /** Reserve execution ticks at the event boundary; frame sealing cannot move them. */
    submitInput(input, { commands = [] } = {}) {
        if (this.closed || this._failure) {
            throw new Error('session unavailable');
        }
        const HELD = bytes(input);
        if (HELD.length !== this.inputSize) {
            throw new RangeError('inputSize');
        }
        if (
            !Array.isArray(commands) ||
            (commands.length > 0 && this._pendingCommands.length + commands.length > this.profile.maxPendingCommands)
        ) {
            throw new RangeError('command capacity');
        }
        const PAYLOADS = commands.map((payload) => {
            const VALUE = bytes(payload);
            if (
                !VALUE.length ||
                VALUE.length > Math.min(this.profile.maxCommandBytes, CHUNK_SIZE - 1024 - this.inputSize - 6)
            ) {
                throw new RangeError('command capacity');
            }
            return VALUE.slice();
        });
        integer(this._commandSequence + PAYLOADS.length, 'command sequence');
        const CHANGED = PAYLOADS.length > 0 || !equalBytes(HELD, this._lastLocalInput);
        const SCHEDULE = CHANGED
            ? {
                  policy: this.profile.inputScheduling,
                  localTick: this.tick,
                  nextOpenTick: this._through.get(this.localPlayerId) + 1,
                  lastReservedTick: Math.max(-1, ...this._localReservations.keys()),
                  peers: [],
              }
            : undefined;
        const DELAY = this._schedulingDelay(this._clock(), SCHEDULE?.peers);
        if (SCHEDULE) {
            SCHEDULE.delayTicks = DELAY;
        }
        if (this.profile.inputScheduling === 'network') {
            this._requestedInputDelay = DELAY;
            if (DELAY !== this.inputDelay) {
                this._applyInputDelay(DELAY);
            }
        }
        const TICK = integer(
            Math.max(this.tick + DELAY, this._through.get(this.localPlayerId) + 1, ...this._localReservations.keys()),
            'input reservation tick',
            0,
            MAX_TICK,
        );
        if (!PAYLOADS.length && equalBytes(HELD, this._lastLocalInput)) {
            return {
                status: 'unchanged',
                tick: this.tick,
                executeTick: TICK,
                commandSequences: [],
                commands: [],
            };
        }
        // Allocate the whole request before publishing it, including overflow slots.
        const UPDATES = new Map(),
            SCHEDULED = [];
        const FRAME_AT = (t) => {
            if (!UPDATES.has(t)) {
                const PRIOR = this._localReservations.get(t);
                UPDATES.set(t, {
                    tick: t,
                    input: HELD.slice(),
                    commands: PRIOR?.commands.slice() ?? [],
                    schedule: {
                        ...SCHEDULE,
                        executeTick: t,
                    },
                });
            }
            return UPDATES.get(t);
        };
        FRAME_AT(TICK);
        let target = TICK;
        let sequence = this._commandSequence;
        for (const PAYLOAD of PAYLOADS) {
            let frame = FRAME_AT(target);
            while (
                frame.commands.length >= this.profile.maxPendingCommands ||
                frame.commands.reduce((n, c) => n + c.payload.length + 6, 0) + PAYLOAD.length + 6 >
                    CHUNK_SIZE - 1024 - this.inputSize
            ) {
                target = integer(
                    target + 1,
                    'command reservation horizon',
                    0,
                    Math.min(MAX_TICK, this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks),
                );
                frame = FRAME_AT(target);
            }
            const COMMAND = {
                sequence: ++sequence,
                executeTick: target,
                payload: PAYLOAD,
            };
            frame.commands.push(COMMAND);
            SCHEDULED.push(COMMAND);
        }
        this._commandSequence = sequence;
        this._lastLocalInput = HELD.slice();
        this._pendingCommands.push(...SCHEDULED);
        for (const FRAME of UPDATES.values()) {
            this._publishReservation(FRAME);
        }
        return {
            status: 'submitted',
            tick: this.tick,
            executeTick: TICK,
            commandSequences: SCHEDULED.map((c) => c.sequence),
            commands: SCHEDULED.map(({ sequence, executeTick }) => ({
                sequence,
                executeTick,
            })),
        };
    }
    _publishReservation(frame) {
        frame.revision = integer(++this._reservationRevision, 'input reservation revision', 1, MAX_TICK);
        frame.packet = null;
        this._localReservations.set(frame.tick, frame);
        this._metrics.inputReservations++;
        for (const PEER of this._peers.values()) {
            if (PEER.ready) {
                this._sendReservation(PEER, frame, this._clock());
            }
        }
        this._event('input-submitted', {
            executeTick: frame.tick,
            revision: frame.revision,
            schedule: frame.schedule,
            commands: frame.commands.map(({ sequence, executeTick }) => ({
                sequence,
                executeTick,
            })),
        });
    }
    _sendReservation(peer, frame, now) {
        if ((peer.reservationAcks?.get(frame.tick) ?? 0) >= frame.revision) {
            return;
        }
        frame.packet ??= packet(TYPE.INPUT_RESERVATION, this._nextSequence(), (w) => {
            w.u32(frame.tick);
            w.u32(frame.revision);
            w.u16(this.inputSize);
            w.raw(frame.input);
            w.u16(frame.commands.length);
            for (const COMMAND of frame.commands) {
                w.u32(COMMAND.sequence);
                w.u16(COMMAND.payload.length);
                w.raw(COMMAND.payload);
            }
        });
        if (this._send(peer, frame.packet)) {
            peer.lastReservationSent = now;
            this._metrics.inputReservationSentBytes += frame.packet.length;
        }
    }
    _receiveReservation(peer, r) {
        const TICK = r.u32(),
            REVISION = r.u32(),
            SIZE = r.u16();
        if (
            !REVISION ||
            REVISION > MAX_TICK ||
            SIZE !== this.inputSize ||
            TICK > MAX_TICK ||
            TICK > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks
        ) {
            throw new RangeError('input reservation timeline');
        }
        const INPUT_LOCAL = r.raw(SIZE),
            COUNT = r.u16(),
            COMMANDS = [];
        if (COUNT > this.profile.maxPendingCommands) {
            throw new RangeError('input reservation commands');
        }
        let previous = 0;
        for (let n = 0; n < COUNT; n++) {
            const SEQUENCE = r.u32(),
                LENGTH = r.u16();
            if (!SEQUENCE || SEQUENCE <= previous || !LENGTH || LENGTH > this.profile.maxCommandBytes) {
                throw new RangeError('input reservation command order');
            }
            previous = SEQUENCE;
            COMMANDS.push({
                sequence: SEQUENCE,
                executeTick: TICK,
                payload: r.raw(LENGTH),
            });
        }
        r.end();
        this._send(
            peer,
            packet(TYPE.INPUT_RESERVATION_ACK, this._nextSequence(), (w) => {
                w.u32(TICK);
                w.u32(REVISION);
            }),
        );
        const ACTUAL = this._inputs.get(peer.id).get(TICK);
        if (ACTUAL || TICK < Math.max(0, this.tick - this.profile.stateHistorySize + 1)) {
            return;
        }
        peer.reservations ??= new Map();
        peer.reservedCommands ??= new Map();
        const PRIOR = peer.reservations.get(TICK);
        if (PRIOR && REVISION <= PRIOR.revision) {
            return;
        }
        for (const COMMAND of COMMANDS) {
            const KNOWN = peer.reservedCommands.get(COMMAND.sequence);
            if (KNOWN && (KNOWN.executeTick !== TICK || !equalBytes(KNOWN.payload, COMMAND.payload))) {
                throw new Error('reserved command is immutable');
            }
        }
        if (
            PRIOR &&
            PRIOR.commands.some(
                (c) => !COMMANDS.some((n) => n.sequence === c.sequence && equalBytes(n.payload, c.payload)),
            )
        ) {
            throw new Error('reserved command cannot be removed');
        }
        const FRAME = {
            tick: TICK,
            input: INPUT_LOCAL,
            commands: COMMANDS,
            revision: REVISION,
        };
        peer.reservations.set(TICK, FRAME);
        for (const COMMAND of COMMANDS) {
            peer.reservedCommands.set(COMMAND.sequence, COMMAND);
        }
        const USED = this._used.get(TICK)?.find((frame) => frame.playerId === peer.id);
        if (USED && !frameEqual(USED, FRAME)) {
            if (!this._history.get(TICK)) {
                this.requestResync(this.confirmedBoundary);
            } else {
                this._rollbackFrom = Math.min(this._rollbackFrom, TICK);
            }
        }
        this._event('input-received', {
            peerId: peer.id,
            executeTick: TICK,
            revision: REVISION,
            provisional: true,
        });
    }
    /** Copy unexecuted local commands for a new fixed-roster epoch. */
    exportLocalCommandState({ fromTick = this.confirmedBoundary } = {}) {
        if (this.closed || this.resimulating) {
            throw new Error('local command state is unavailable');
        }
        const BASELINE = this.getCommandSequences(fromTick)[this.localPlayerId];
        const COMMANDS = new Map();
        const INCLUDE = (command) => {
            const PRIOR = COMMANDS.get(command.sequence);
            if (PRIOR && (PRIOR.executeTick !== command.executeTick || !equalBytes(PRIOR.payload, command.payload))) {
                throw new Error('conflicting local command sequence');
            }
            if (!PRIOR) {
                COMMANDS.set(command.sequence, command);
            }
        };
        for (const [TICK, FRAME] of this._inputs.get(this.localPlayerId)) {
            if (TICK >= fromTick) {
                for (const COMMAND of FRAME.commands) {
                    INCLUDE(COMMAND);
                }
            }
        }
        for (const COMMAND of this._pendingCommands) {
            INCLUDE(COMMAND);
        }
        const INPUTS = new Map(
            [...this._inputs.get(this.localPlayerId)]
                .filter(([tick]) => tick >= fromTick)
                .map(([tick, frame]) => [
                    tick,
                    {
                        tick,
                        input: frame.input,
                    },
                ]),
        );
        for (const [TICK, FRAME] of this._localReservations) {
            if (TICK >= fromTick) {
                INPUTS.set(TICK, {
                    tick: TICK,
                    input: FRAME.input,
                });
            }
        }
        return copyLocalCommandState(
            {
                sequence: this._commandSequence,
                lastInput: this._lastLocalInput,
                sealedThrough: this._through.get(this.localPlayerId),
                inputs: [...INPUTS.values()].sort((a, b) => a.tick - b.tick),
                commands: [...COMMANDS.values()].sort((a, b) => a.sequence - b.sequence),
            },
            this.inputSize,
            this.profile,
            BASELINE,
        );
    }
    /** Command maxima immediately before a confirmed boundary in either mode. */
    getCommandSequences(tick = this.confirmedBoundary) {
        integer(tick, 'confirmed command boundary', 0, this.confirmedBoundary);
        if (this.resimulating) {
            throw new Error('confirmed command boundary is unavailable');
        }
        let sequences = tick === this.tick ? this._commandSequences : this._history.get(tick)?.commandSequences;
        if (!sequences && this.profile.mode === 'lockstep') {
            const BASE = this._history.atOrBefore(tick);
            if (BASE) {
                sequences = BASE.commandSequences;
                for (let t = BASE.tick; t < tick; t++) {
                    const INPUTS = this.players.map((id) => {
                        const FRAME = this._inputs.get(id).get(t);
                        return FRAME
                            ? {
                                  ...FRAME,
                                  playerId: id,
                              }
                            : undefined;
                    });
                    if (INPUTS.some((frame) => !frame)) {
                        throw new Error('command boundary inputs expired');
                    }
                    sequences = executedSequences(sequences, INPUTS);
                }
            }
        }
        if (!sequences) {
            throw new Error('command boundary expired');
        }
        return Object.fromEntries(sequences);
    }
    setInputDelay(ticks) {
        integer(ticks, 'input delay', this.profile.minInputDelayTicks, this.profile.maxInputDelayTicks);
        this._requestedInputDelay = ticks;
        if (ticks > this.inputDelay) {
            this._applyInputDelay(ticks);
        }
    }
    _applyInputDelay(ticks) {
        const PREVIOUS = this.inputDelay;
        this._inputDelay = ticks;
        this._event('input-delay', {
            previous: PREVIOUS,
            value: ticks,
        });
    }
    _sealLocal(tick, fallback) {
        const RESERVED = this._localReservations.get(tick);
        const INPUT_LOCAL = RESERVED?.input ?? fallback;
        const COMMANDS = this._pendingCommands.filter((c) => c.executeTick === tick);
        if (this._pendingCommands.some((c) => c.executeTick < tick)) {
            throw new Error('reserved command missed its execution tick');
        }
        this._pendingCommands = this._pendingCommands.filter((c) => c.executeTick !== tick);
        this._commitLocal(tick, INPUT_LOCAL, COMMANDS);
        this._localReservations.delete(tick);
        this._localCapture = {
            sequence: ++this._localCaptureSequence,
            captureTick: this.tick,
            executeTick: tick,
            input: INPUT_LOCAL.slice(),
            commands: COMMANDS.map((c) => ({
                ...c,
                payload: c.payload.slice(),
            })),
        };
        this._localCaptures.push(this._localCapture);
        this._localCaptures = this._localCaptures.filter((c) => c.executeTick >= Math.max(0, this.tick - 1));
        return INPUT_LOCAL;
    }
    _capture(input) {
        this.submitInput(input);
        if (this._captureTick === this.tick) {
            return;
        }
        this._captureTick = this.tick;
        const THROUGH = this._through.get(this.localPlayerId);
        let held = this._inputs.get(this.localPlayerId).get(THROUGH)?.input ?? this._lastLocalInput;
        if (
            this.profile.inputScheduling === 'configured' &&
            this._requestedInputDelay < this.inputDelay &&
            equalBytes(this._lastLocalInput, held) &&
            !this._pendingCommands.length
        ) {
            this._applyInputDelay(this.inputDelay - 1);
        }
        const TARGET = integer(this.tick + this.inputDelay, 'session tick limit', 0, MAX_TICK);
        for (let t = THROUGH + 1; t <= TARGET; t++) {
            held = this._sealLocal(t, held);
        }
    }
    releaseInput() {
        if (this.closed || this._failure) {
            return;
        }
        const RECEIPT = this.submitInput(new Uint8Array(this.inputSize));
        let held =
            this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId))?.input ??
            this._lastLocalInput;
        for (let t = this._through.get(this.localPlayerId) + 1; t <= RECEIPT.executeTick; t++) {
            held = this._sealLocal(t, held);
        }
        for (const PEER of this._peers.values()) {
            if (PEER.ready) {
                this._sendInputs(PEER);
            }
        }
        this._event('input-release', {
            executeTick: RECEIPT.executeTick,
        });
    }
    _sendInputs(peer) {
        const MAP = this._inputs.get(this.localPlayerId);
        const FIRST = peer.ack + 1;
        if (!MAP.has(FIRST)) {
            return;
        }
        const FRAMES = [];
        let cost = HEADER + 16;
        for (let t = FIRST; FRAMES.length < 128 && MAP.has(t); t++) {
            const F = MAP.get(t);
            const N = 7 + this.inputSize + F.commands.reduce((s, c) => s + 6 + c.payload.length, 0);
            if (cost + N > CHUNK_SIZE) {
                break;
            }
            FRAMES.push(F);
            cost += N;
        }
        if (!FRAMES.length) {
            return;
        }
        this._send(
            peer,
            packet(TYPE.INPUT, this._nextSequence(), (w) => {
                w.u32(FIRST);
                w.u16(FRAMES.length);
                w.u16(this.inputSize);
                w.i32(this._through.get(peer.id));
                w.u32(this.tick);
                for (let i = 0; i < FRAMES.length;) {
                    const F = FRAMES[i];
                    let run = 1;
                    while (
                        i + run < FRAMES.length &&
                        !FRAMES[i + run].commands.length &&
                        equalBytes(F.input, FRAMES[i + run].input)
                    ) {
                        run++;
                    }
                    w.u16(run);
                    w.raw(F.input);
                    w.u16(F.commands.length);
                    for (const C of F.commands) {
                        w.u32(C.sequence);
                        w.u16(C.payload.length);
                        w.raw(C.payload);
                    }
                    i += run;
                }
            }),
        );
    }
    _sendClock(peer, now, replyTo) {
        const ID = this._nextSequence();
        const DATA = packet(TYPE.CLOCK, ID, (w) => {
            w.u32(this.tick);
            w.i32(this.confirmedTick);
            w.i32(this._through.get(peer.id));
            w.u32(replyTo ?? 0);
            w.u8(replyTo === undefined ? 0 : 1);
        });
        if (this._send(peer, DATA)) {
            if (replyTo === undefined) {
                peer.pendingPings.set(ID, now);
                peer.lastSent = now;
            }
            while (peer.pendingPings.size > 32) {
                peer.pendingPings.delete(peer.pendingPings.keys().next().value);
            }
        }
    }
    poll(now = this._clock()) {
        if (this.closed || this._failure) {
            return;
        }
        if (!Number.isFinite(now)) {
            throw new TypeError('network time');
        }
        for (const PEER of this._peers.values()) {
            this._peerLiveness(PEER, now);
            if (!PEER.ready) {
                if (now - PEER.lastHello >= this.profile.heartbeatMs) {
                    this._sendHello(PEER, now);
                }
                continue;
            }
            if (now - (PEER.lastReservationSent ?? -Infinity) >= this.profile.heartbeatMs) {
                for (const FRAME of this._localReservations.values()) {
                    this._sendReservation(PEER, FRAME, now);
                }
            }
            if (now - PEER.lastSent >= this.profile.heartbeatMs) {
                this._sendInputs(PEER);
                this._sendClock(PEER, now);
            }
            let sent = 0;
            while (PEER.controls.length && sent < 65536) {
                const DATA = PEER.controls[0];
                if (!this._send(PEER, DATA)) {
                    break;
                }
                PEER.controls.shift();
                PEER.queuedBytes -= DATA.length;
                sent += DATA.length;
            }
        }
        if (this._incomingSnapshot && now - this._incomingSnapshot.started > this.profile.recoveryTimeoutMs) {
            this._rejectSnapshot('snapshot timeout');
        }
        if (this._requestedRecovery && now - this._requestedRecovery.at > this.profile.recoveryTimeoutMs) {
            this._requestedRecovery = null;
            this._event('recovery-timeout');
            this._recoveryExhausted('timeout');
        }
        // Reconciliation must finish even when gameplay is paused at a terminal tick.
        // Restore and replay to the original current tick in this call.
        if (this._failure) {
            return;
        }
        if (this.resimulating) {
            this._rollback();
        }
        if (this._failure) {
            return;
        }
        this._adapt(now);
        this._sendHashes();
        this._checkHashes();
        this._recordConfirmed();
    }
    receive(peerId, data, now = this._clock()) {
        if (this.closed || this._failure) {
            return false;
        }
        const PEER = this._peers.get(peerId);
        if (!PEER || ['closed', 'failed'].includes(PEER.transportState)) {
            return false;
        }
        try {
            const B = bytes(data);
            if (B.length < HEADER || B.length > CHUNK_SIZE) {
                throw new RangeError('packet size');
            }
            const R = new Reader(B);
            if (R.u32() !== MAGIC) {
                throw new Error('protocol magic');
            }
            const PROTOCOL_VERSION_LOCAL = R.u8();
            if (PROTOCOL_VERSION_LOCAL !== PROTOCOL_VERSION) {
                this._event('version-mismatch', {
                    peerId,
                    field: 'protocol',
                    expected: PROTOCOL_VERSION,
                    received: PROTOCOL_VERSION_LOCAL,
                });
                throw new Error('protocol version');
            }
            const TYPE_LOCAL = R.u8();
            if (R.u16() !== 0) {
                throw new Error('reserved header');
            }
            const SEQUENCE = R.u32();
            this._metrics.receivedBytes += B.length;
            if (TYPE_LOCAL === TYPE.HELLO) {
                const HELLO_LOCAL = R.raw(B.length - HEADER);
                R.end();
                if (!equalBytes(HELLO_LOCAL, this._hello)) {
                    const EXPECTED = JSON.parse(decoder.decode(this._hello)),
                        RECEIVED = JSON.parse(decoder.decode(HELLO_LOCAL));
                    const FIELDS = Object.keys(EXPECTED).filter(
                        (field) => JSON.stringify(EXPECTED[field]) !== JSON.stringify(RECEIVED?.[field]),
                    );
                    if (!FIELDS.length) {
                        throw new Error('noncanonical HELLO');
                    }
                    const TYPE_LOCAL = FIELDS.some((field) =>
                        ['protocol', 'library', 'simulationVersion'].includes(field),
                    )
                        ? 'version-mismatch'
                        : 'handshake-mismatch';
                    this._fail(TYPE_LOCAL, {
                        peerId,
                        fields: Object.freeze(FIELDS),
                        mismatches: Object.freeze(
                            FIELDS.map((field) =>
                                Object.freeze({
                                    field,
                                    expected: EXPECTED[field],
                                    received: RECEIVED?.[field],
                                }),
                            ),
                        ),
                    });
                    return false;
                }
                const WAS_READY = PEER.ready;
                PEER.ready = true;
                this._peerAlive(PEER, SEQUENCE, now);
                if (!WAS_READY) {
                    this._sendHello(PEER, now);
                    this._event('peer-ready', {
                        peerId,
                    });
                }
                return true;
            }
            if (!PEER.ready) {
                return false;
            }
            if (TYPE_LOCAL === TYPE.INPUT) {
                this._receiveInputs(PEER, R, SEQUENCE, now);
            } else if (TYPE_LOCAL === TYPE.INPUT_RESERVATION) {
                this._receiveReservation(PEER, R);
                this._metrics.inputReservationReceivedBytes += B.length;
            } else if (TYPE_LOCAL === TYPE.INPUT_RESERVATION_ACK) {
                const TICK = R.u32(),
                    REVISION = R.u32();
                R.end();
                if (!REVISION || REVISION > this._reservationRevision || TICK > MAX_TICK) {
                    throw new RangeError('input reservation acknowledgement');
                }
                PEER.reservationAcks ??= new Map();
                PEER.reservationAcks.set(TICK, Math.max(PEER.reservationAcks.get(TICK) ?? 0, REVISION));
            } else if (TYPE_LOCAL === TYPE.CLOCK) {
                this._receiveClock(PEER, R, SEQUENCE, now);
            } else if (TYPE_LOCAL === TYPE.HASH) {
                const TICK = R.u32(),
                    HASH_LOCAL = R.u32(),
                    INPUT_HASH = R.u32();
                R.end();
                if (
                    TICK <= this.tick + this.profile.stateHistorySize &&
                    TICK >= Math.max(0, this.tick - this.profile.stateHistorySize + 1)
                ) {
                    PEER.hashes.set(TICK, {
                        hash: HASH_LOCAL,
                        inputHash: INPUT_HASH,
                    });
                }
            } else if (TYPE_LOCAL === TYPE.REQUEST) {
                const TICK = R.u32();
                R.end();
                this._sendSnapshot(PEER, TICK);
            } else if (TYPE_LOCAL === TYPE.BEGIN) {
                this._beginSnapshot(PEER, R, now);
            } else if (TYPE_LOCAL === TYPE.CHUNK) {
                this._snapshotChunk(PEER, R);
            } else {
                throw new Error('unknown packet type');
            }
            this._peerAlive(PEER, SEQUENCE, now);
            if (this._rollbackFrom !== Infinity && !this._replaying && !this._requestedRecovery) {
                this._rollback();
            }
            return true;
        } catch (error) {
            this._metrics.rejectedPackets++;
            this._event('protocol-error', {
                peerId,
                error,
            });
            return false;
        }
    }
    _receiveInputs(peer, r, sequence, now) {
        const FIRST = r.u32(),
            COUNT = r.u16(),
            SIZE = r.u16(),
            ACK = r.i32(),
            SIM_TICK = r.u32();
        if (
            !COUNT ||
            COUNT > 128 ||
            SIZE !== this.inputSize ||
            FIRST + COUNT - 1 > MAX_TICK ||
            FIRST + COUNT > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks + 1
        ) {
            throw new RangeError('input timeline');
        }
        if (ACK < -1 || ACK > this._through.get(this.localPlayerId)) {
            throw new RangeError('ack');
        }
        const INCOMING = [];
        while (INCOMING.length < COUNT) {
            const RUN = r.u16();
            if (!RUN || INCOMING.length + RUN > COUNT) {
                throw new RangeError('input run');
            }
            const INPUT_LOCAL = r.raw(SIZE),
                N = r.u16(),
                COMMANDS = [];
            if (N > this.profile.maxPendingCommands) {
                throw new RangeError('command count');
            }
            let previous = 0;
            for (let i = 0; i < N; i++) {
                const SEQUENCE = r.u32(),
                    LEN = r.u16();
                if (!SEQUENCE || SEQUENCE <= previous || !LEN || LEN > this.profile.maxCommandBytes) {
                    throw new RangeError('command shape/order');
                }
                previous = SEQUENCE;
                COMMANDS.push({
                    sequence: SEQUENCE,
                    executeTick: FIRST + INCOMING.length,
                    payload: r.raw(LEN),
                });
            }
            INCOMING.push({
                input: INPUT_LOCAL,
                commands: COMMANDS,
            });
            for (let j = 1; j < RUN; j++) {
                INCOMING.push({
                    input: INPUT_LOCAL.slice(),
                    commands: [],
                });
            }
        }
        r.end();
        const MAP = this._inputs.get(peer.id);
        // Validate the complete packet before publishing any portion of it.
        for (let i = 0; i < COUNT; i++) {
            for (const COMMAND of INCOMING[i].commands) {
                const RESERVED = peer.reservedCommands?.get(COMMAND.sequence);
                if (
                    RESERVED &&
                    (RESERVED.executeTick !== FIRST + i || !equalBytes(RESERVED.payload, COMMAND.payload))
                ) {
                    throw new Error('canonical command moved its reserved tick');
                }
            }
            const PRIOR_RESERVATION = peer.reservations?.get(FIRST + i);
            if (
                PRIOR_RESERVATION?.commands.some(
                    (c) =>
                        !INCOMING[i].commands.some(
                            (n) => n.sequence === c.sequence && equalBytes(n.payload, c.payload),
                        ),
                )
            ) {
                throw new Error('canonical command missing reservation');
            }
            const OLD = MAP.get(FIRST + i);
            if (OLD && !frameEqual(OLD, INCOMING[i])) {
                if (this.profile.mode === 'lockstep' && FIRST + i < this.tick) {
                    this._fail('desync-unrecoverable', {
                        reason: 'conflicting-confirmed-input',
                        peerId: peer.id,
                        inputTick: FIRST + i,
                    });
                }
                throw new Error('conflicting committed input');
            }
        }
        peer.ack = Math.max(peer.ack, ACK);
        if (
            peer.progressSequence === undefined ||
            ((sequence - peer.progressSequence) >>> 0 < 0x80000000 && sequence !== peer.progressSequence)
        ) {
            peer.progressSequence = sequence;
            peer.tick = SIM_TICK;
            peer.clockAt = now;
        }
        const OLDEST = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
        for (let i = 0; i < COUNT; i++) {
            const T = FIRST + i;
            if (MAP.has(T) || T < OLDEST) {
                continue;
            }
            peer.reservedCommands ??= new Map();
            for (const COMMAND of INCOMING[i].commands) {
                peer.reservedCommands.set(COMMAND.sequence, COMMAND);
            }
            MAP.set(T, INCOMING[i]);
            peer.reservations?.delete(T);
            this._window.received++;
            if (T < this.tick) {
                this._window.late++;
            }
            const USED = this._used.get(T)?.find((x) => x.playerId === peer.id);
            if (USED && T < this.tick && !frameEqual(USED, INCOMING[i])) {
                if (this.profile.mode === 'lockstep') {
                    this._fail('desync-unrecoverable', {
                        reason: 'conflicting-confirmed-input',
                        peerId: peer.id,
                        inputTick: T,
                    });
                    return;
                }
                if (!this._history.get(T)) {
                    this._event('history-exhausted', {
                        inputTick: T,
                    });
                    this.requestResync(Math.min(this.confirmedTick + 1, this.tick));
                } else {
                    this._rollbackFrom = Math.min(this._rollbackFrom, T);
                }
            }
        }
        let through = this._through.get(peer.id);
        while (MAP.has(through + 1)) {
            through++;
        }
        this._through.set(peer.id, through);
    }
    _receiveClock(peer, r, sequence, now) {
        const TICK = r.u32(),
            CONFIRMED = r.i32(),
            ACK = r.i32(),
            ECHO = r.u32(),
            REPLY = r.u8();
        r.end();
        if (REPLY > 1) {
            throw new RangeError('clock reply flag');
        }
        if (
            TICK > MAX_TICK + 1 ||
            CONFIRMED < -1 ||
            CONFIRMED > ACK ||
            ACK < -1 ||
            ACK > this._through.get(this.localPlayerId)
        ) {
            throw new RangeError('clock/ack');
        }
        const FRESH =
            peer.clockSequence === null ||
            ((sequence - peer.clockSequence) >>> 0 < 0x80000000 && sequence !== peer.clockSequence);
        if (!FRESH) {
            return;
        }
        peer.clockSequence = sequence;
        peer.confirmed = CONFIRMED;
        if (
            peer.progressSequence === undefined ||
            ((sequence - peer.progressSequence) >>> 0 < 0x80000000 && sequence !== peer.progressSequence)
        ) {
            peer.progressSequence = sequence;
            peer.tick = TICK;
            peer.clockAt = now;
        }
        peer.ack = Math.max(peer.ack, ACK);
        peer.echo = sequence;
        if (!REPLY) {
            this._sendClock(peer, now, sequence);
        }
        const SENT = REPLY ? peer.pendingPings.get(ECHO) : undefined;
        if (SENT !== undefined && now >= SENT) {
            const SAMPLE = now - SENT;
            peer.pendingPings.delete(ECHO);
            const DIFFERENCE = Math.abs(SAMPLE - peer.rtt);
            peer.rtt = peer.rtt ? peer.rtt * 0.875 + SAMPLE * 0.125 : SAMPLE;
            peer.jitter = peer.jitter * 0.75 + (peer.rtt === SAMPLE ? 0 : DIFFERENCE * 0.25);
            this._metrics.smoothedRTT = Math.max(...[...this._peers.values()].map((p) => p.rtt));
            this._metrics.jitter = Math.max(...[...this._peers.values()].map((p) => p.jitter));
        }
    }
    _resolve(tick) {
        return this.players.map((playerId) => {
            const MAP = this._inputs.get(playerId),
                ACTUAL = MAP.get(tick);
            if (ACTUAL) {
                return {
                    playerId,
                    ...copyFrame(ACTUAL),
                    predicted: false,
                };
            }
            if (this.profile.mode === 'lockstep') {
                throw new Error('lockstep input is not confirmed');
            }
            const RESERVED = this._peers.get(playerId)?.reservations?.get(tick);
            if (RESERVED) {
                return {
                    playerId,
                    ...copyFrame(RESERVED),
                    predicted: true,
                };
            }
            let prior =
                this._used.get(tick - 1)?.find((f) => f.playerId === playerId)?.input ?? new Uint8Array(this.inputSize);
            const POLICY = this.profile.predictionPolicy;
            if (typeof POLICY === 'function') {
                prior = bytes(
                    POLICY({
                        playerId,
                        tick,
                        previousInput: prior.slice(),
                        lastConfirmedTick: this._through.get(playerId),
                    }),
                );
            } else if (POLICY === 'neutral') {
                prior = new Uint8Array(this.inputSize);
            }
            if (prior.length !== this.inputSize) {
                throw new RangeError('predictor inputSize');
            }
            // Only continuous state is predicted; a missing one-shot command is never repeated.
            return {
                playerId,
                input: prior.slice(),
                commands: [],
                predicted: true,
            };
        });
    }
    _restoreConfirmedBoundary(tick) {
        const BASE = this._history.atOrBefore(tick);
        if (!BASE) {
            throw new Error('lockstep recovery base expired');
        }
        this.adapter.load(BASE.bytes.slice());
        for (let t = BASE.tick; t < tick; t++) {
            runSimulationFrame(this.adapter, {
                tick: t,
                tickRate: this.profile.tickRate,
                inputs: this._resolve(t),
                resimulating: true,
                recovering: true,
            });
        }
    }
    _replayFrameBytes(inputs) {
        return inputs.reduce(
            (s, f) => s + f.input.length + f.commands.reduce((k, c) => k + c.payload.length + 12, 0),
            16,
        );
    }
    _step(inputs, resimulating) {
        const BEFORE = this._history?.get(this.tick);
        const TICK = this.tick,
            LOCKSTEP = this.profile.mode === 'lockstep';
        integer(TICK, 'session tick limit', 0, MAX_TICK);
        // Freeze the last recorded boundary before mutating it when the input log is
        // full. Normal replay recording needs no per-frame state copy in lockstep.
        if (
            LOCKSTEP &&
            this._recordReplay &&
            this._replayBytes + this._replayFrameBytes(inputs) > this.profile.maxReplayBytes
        ) {
            this._replayFinalHash = this._stateHash(this._stateAt(TICK));
            this._recordReplay = false;
            this._event('replay-capacity');
        }
        try {
            runSimulationFrame(this.adapter, {
                tick: TICK,
                tickRate: this.profile.tickRate,
                inputs,
                resimulating,
            });
            const INPUT_HASH = this.localFastPath
                ? this._inputHash
                : this._hashInputFrame(TICK, inputs, this._inputHash);
            const COMMAND_SEQUENCES = executedSequences(this._commandSequences, inputs);
            if (!this.localFastPath && (!LOCKSTEP || (TICK + 1) % this.profile.checksumInterval === 0)) {
                const STATE = this._save();
                this._history.put({
                    tick: TICK + 1,
                    bytes: STATE,
                    inputHash: INPUT_HASH,
                    commandSequences: COMMAND_SEQUENCES,
                });
            }
            if (!LOCKSTEP) {
                this._used.set(
                    TICK,
                    inputs.map((f) => ({
                        ...copyFrame(f),
                        playerId: f.playerId,
                        predicted: f.predicted,
                    })),
                );
            }
            this._tick++;
            this._inputHash = INPUT_HASH;
            this._currentState = null;
            const LOCAL_FRAME = inputs.find((frame) => frame.playerId === this.localPlayerId);
            if (LOCAL_FRAME) {
                this._localExecutedInput = LOCAL_FRAME.input.slice();
            }
            this._commandSequences = COMMAND_SEQUENCES;
        } catch (error) {
            if (this.localFastPath) {
                // Without a retained canonical boundary, partial adapter mutation
                // cannot be rolled back safely. Stop immediately and surface fatal.
                this._currentState = null;
                this._fail('fatal', {
                    error,
                    restoreUnavailable: true,
                });
                throw error;
            }
            try {
                if (BEFORE) {
                    this.adapter.load(BEFORE.bytes.slice());
                } else if (LOCKSTEP) {
                    this._restoreConfirmedBoundary(TICK);
                }
                if (LOCKSTEP) {
                    this._currentState = {
                        tick: TICK,
                        bytes: this._save(),
                        inputHash: this._inputHash,
                    };
                }
            } catch (restoreError) {
                this._currentState = null;
                this._fail('fatal', {
                    error,
                    restoreError,
                });
                throw error;
            }
            this._fail('fatal', {
                error,
            });
            throw error;
        }
    }
    _rollback() {
        const STARTED = nowMs();
        let reconciled;
        this._replaying = true;
        try {
            if (this._rollbackFrom !== Infinity) {
                const TARGET = this.tick,
                    FROM = this._rollbackFrom;
                const SAVED = this._history.get(FROM);
                if (!SAVED) {
                    throw new Error('rollback state expired');
                }
                this.adapter.load(SAVED.bytes.slice());
                this._tick = FROM;
                this._inputHash = SAVED.inputHash;
                this._commandSequences = SAVED.commandSequences;
                this._history.invalidateAfter(FROM);
                this._rollbackFrom = Infinity;
                this._metrics.rollbacks++;
                this._window.rollback++;
                this._metrics.maxRollbackDepth = Math.max(this._metrics.maxRollbackDepth, TARGET - FROM);
                this._window.depth = Math.max(this._window.depth, TARGET - FROM);
                this._event('rollback', {
                    from: FROM,
                    target: TARGET,
                });
                while (this.tick < TARGET) {
                    this._step(this._resolve(this.tick), true);
                    this._metrics.resimulatedTicks++;
                }
                reconciled = {
                    from: FROM,
                    target: TARGET,
                };
            }
            return true;
        } finally {
            this._replaying = false;
            this._metrics.latestResimulationMs = nowMs() - STARTED;
            this._window.cost += this._metrics.latestResimulationMs;
            this._window.costSamples++;
            if (reconciled) {
                this._event('reconciled', reconciled);
            }
        }
    }
    _frameAdvantage(now) {
        let advantage = -Infinity;
        for (const PEER of this._peers.values()) {
            if (PEER.ready && PEER.clockSequence !== null) {
                // Remote reports are samples. Extrapolation is deliberately capped on stale data.
                const AGE = Math.max(0, Math.min(1000 / this.profile.tickRate, now - PEER.clockAt));
                const ESTIMATED = PEER.tick + ((AGE + PEER.rtt / 2) * this.profile.tickRate) / 1000;
                advantage = Math.max(advantage, this.tick - ESTIMATED);
            }
        }
        return Number.isFinite(advantage) ? advantage : 0;
    }
    advance(input = this._lastLocalInput) {
        if (this.closed) {
            throw new Error('session closed');
        }
        const NOW = this._clock();
        this.poll(NOW);
        if (this._failure) {
            return {
                status: 'failed',
                tick: this.tick,
                failure: this.failure,
            };
        }
        if (['interrupted', 'disconnected'].includes(this.status)) {
            return {
                status: this.status,
                tick: this.tick,
            };
        }
        if (this._requestedRecovery) {
            return {
                status: 'recovering',
                tick: this.tick,
            };
        }
        if (this.resimulating) {
            return {
                status: 'resimulating',
                tick: this.tick,
            };
        }
        this._capture(input);
        for (const PEER of this._peers.values()) {
            if (PEER.ready) {
                this._sendInputs(PEER);
            }
        }
        if (!this.ready) {
            return {
                status: 'synchronizing',
                tick: this.tick,
            };
        }
        const ADVANTAGE = this._frameAdvantage(NOW);
        const THRESHOLD = this.profile.tickDriftThreshold;
        const HOLD =
            (this.profile.pacingPolicy === 'hold' && ADVANTAGE > THRESHOLD) ||
            (this.profile.pacingPolicy === 'dilation' && ADVANTAGE > Math.max(4, THRESHOLD * 3));
        if (HOLD) {
            this._metrics.holds++;
            return {
                status: 'held',
                tick: this.tick,
            };
        }
        if (this.profile.mode === 'lockstep' && this.players.some((id) => !this._inputs.get(id).has(this.tick))) {
            this._metrics.stalls++;
            this._window.stall++;
            return {
                status: 'stalled',
                tick: this.tick,
            };
        }
        const INPUTS = this._resolve(this.tick),
            PREDICTED = INPUTS.some((f) => f.predicted);
        const MIN_ACK = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
        if (
            (PREDICTED && this.tick - (this.confirmedTick + 1) >= this.profile.rollbackWindowTicks) ||
            this._through.get(this.localPlayerId) - MIN_ACK >= this.profile.stateHistorySize * 4
        ) {
            this._metrics.stalls++;
            this._window.stall++;
            return {
                status: 'stalled',
                tick: this.tick,
            };
        }
        this._step(INPUTS, false);
        this._window.advances++;
        if (PREDICTED) {
            this._metrics.predictedTicks++;
        }
        this._recordConfirmed();
        this._sendHashes();
        this._checkHashes();
        this._prune();
        return {
            status: 'advanced',
            tick: this.tick,
        };
    }
    _adapt(now) {
        if (this._lastAdaptation === null) {
            this._lastAdaptation = now;
            return;
        }
        if (now - this._lastAdaptation < this.profile.adaptationIntervalMs) {
            return;
        }
        const SECONDS = (now - this._lastAdaptation) / 1000;
        this._lastAdaptation = now;
        const W = this._window;
        const LATE_RATE = W.received ? W.late / W.received : 0;
        this._metrics.lateInputRate = this._metrics.lateInputRate * 0.75 + LATE_RATE * 0.25;
        this._metrics.rollbackFrequency = this._metrics.rollbackFrequency * 0.75 + (W.rollback / SECONDS) * 0.25;
        this._metrics.stallFrequency = this._metrics.stallFrequency * 0.75 + (W.stall / SECONDS) * 0.25;
        const COST = W.costSamples ? W.cost / W.costSamples : 0;
        this._metrics.resimulationCostMs = this._metrics.resimulationCostMs * 0.75 + COST * 0.25;
        if (this.profile.adaptiveInputDelay && this.profile.inputScheduling === 'configured') {
            const MEASURED = Math.ceil(
                ((this._metrics.smoothedRTT / 2 + 2 * this._metrics.jitter) * this.profile.tickRate) / 1000,
            );
            const PRESSURE =
                this._metrics.lateInputRate > 0.1 ||
                this._metrics.rollbackFrequency > 2 ||
                W.depth > 3 ||
                this._metrics.stallFrequency > 2 ||
                this._metrics.resimulationCostMs > 1000 / this.profile.tickRate;
            if (PRESSURE || MEASURED > this.inputDelay + 1) {
                this.setInputDelay(Math.min(this.profile.maxInputDelayTicks, Math.max(this.inputDelay + 1, MEASURED)));
                this._stableWindows = 0;
            } else if (W.advances > 0 && !W.late && !W.stall && MEASURED <= this.inputDelay - 1) {
                if (++this._stableWindows >= 3) {
                    this.setInputDelay(Math.max(this.profile.minInputDelayTicks, this.inputDelay - 1));
                    this._stableWindows = 0;
                }
            } else {
                this._stableWindows = 0;
            }
        }
        if (this.profile.pacingPolicy === 'dilation') {
            const DRIFT = this._frameAdvantage(now);
            const TARGET = Math.abs(DRIFT) < 0.5 ? 1 : Math.max(0.98, Math.min(1.05, 1 + DRIFT * 0.005));
            const CHANGE = Math.max(-0.005, Math.min(0.005, (TARGET - this._pace) * 0.2));
            this._pace = Math.max(0.98, Math.min(1.05, this._pace + CHANGE));
        }
        this._window = {
            advances: 0,
            received: 0,
            late: 0,
            depth: 0,
            rollback: 0,
            stall: 0,
            cost: 0,
            costSamples: 0,
        };
    }
    _sendHashes() {
        if (this.localFastPath || this.resimulating) {
            return;
        }
        const UP_TO = Math.min(this.tick, this.confirmedTick + 1);
        const T = Math.floor(UP_TO / this.profile.checksumInterval) * this.profile.checksumInterval;
        if (!T) {
            return;
        }
        const S = this._history.get(T);
        if (!S) {
            return;
        }
        for (const PEER of this._peers.values()) {
            if (PEER.ready && PEER.lastHashQueued < T) {
                // Coalesce congestion into the newest retained confirmed boundary.
                // Unsent hashes remain derivable from the ring instead of an unbounded queue.
                if (
                    this._queue(
                        PEER,
                        packet(TYPE.HASH, this._nextSequence(), (w) => {
                            w.u32(T);
                            w.u32(this._stateHash(S));
                            w.u32(S.inputHash);
                        }),
                    )
                ) {
                    PEER.lastHashQueued = T;
                }
            }
        }
    }
    _checkHashes() {
        if (this.localFastPath || this.resimulating) {
            return;
        }
        for (const PEER of this._peers.values()) {
            for (const [TICK, REMOTE] of PEER.hashes) {
                if (TICK > Math.min(this.tick, this.confirmedTick + 1)) {
                    continue;
                }
                const LOCAL = this._history.get(TICK);
                if (!LOCAL) {
                    PEER.hashes.delete(TICK);
                    continue;
                }
                if (LOCAL.inputHash !== REMOTE.inputHash) {
                    PEER.hashes.delete(TICK);
                    this._event('input-history-mismatch', {
                        peerId: PEER.id,
                        at: TICK,
                    });
                    if (this.profile.mode === 'lockstep') {
                        this._fail('desync-unrecoverable', {
                            reason: 'input-history-mismatch',
                            peerId: PEER.id,
                            at: TICK,
                        });
                    }
                    continue;
                }
                if (this._stateHash(LOCAL) !== REMOTE.hash) {
                    if (!REMOTE.notified) {
                        REMOTE.notified = true;
                        this._metrics.hashMismatches++;
                        this._event('desync', {
                            peerId: PEER.id,
                            at: TICK,
                        });
                    }
                    if (this._roomRecovery) {
                        this._roomRecovery(TICK);
                        PEER.hashes.delete(TICK);
                    } else if (this.localPlayerId === this.authorityPlayerId || this.requestResync(TICK)) {
                        PEER.hashes.delete(TICK);
                    }
                } else {
                    PEER.hashes.delete(TICK);
                }
            }
        }
    }
    getStateHash(tick = this.tick) {
        return this._stateHash(this._stateAt(tick));
    }
    /** Export the requested confirmed boundary, never the predicted present. */
    exportConfirmedBootstrap({ tick = this.confirmedBoundary, checkpointAtOrBefore = tick } = {}) {
        if (this.localFastPath) {
            throw new Error('confirmed bootstrap unavailable in local fast path');
        }
        if (this.closed || this._failure || this.resimulating || this._requestedRecovery) {
            throw new Error('confirmed boundary is required');
        }
        integer(tick, 'bootstrap confirmed boundary', 0, this.confirmedBoundary);
        integer(checkpointAtOrBefore, 'bootstrap checkpoint boundary', 0, tick);
        const CHECKPOINT =
            this.profile.mode === 'lockstep'
                ? this._history.atOrBefore(checkpointAtOrBefore)
                : this._history.get(checkpointAtOrBefore);
        if (!CHECKPOINT || tick - CHECKPOINT.tick > this.profile.stateHistorySize) {
            throw new Error('bootstrap checkpoint is unavailable');
        }
        const FRAMES = [];
        for (let frameTick = CHECKPOINT.tick; frameTick < tick; frameTick++) {
            const INPUTS = this.players.map((playerId) => {
                const FRAME = this._inputs.get(playerId).get(frameTick);
                if (!FRAME) {
                    throw new Error('confirmed bootstrap input is unavailable');
                }
                return {
                    playerId,
                    ...copyFrame(FRAME),
                    predicted: false,
                };
            });
            FRAMES.push({
                tick: frameTick,
                inputs: INPUTS,
            });
        }
        return {
            version: 1,
            tick,
            checkpoint: {
                tick: CHECKPOINT.tick,
                bytes: CHECKPOINT.bytes.slice(),
                hash: this._stateHash(CHECKPOINT),
            },
            players: [...this.players],
            frames: FRAMES,
            hash: this.getStateHash(tick),
            inputSize: this.inputSize,
            tickRate: this.profile.tickRate,
            simulationVersion: this.simulationVersion,
            seed: this.seed,
            commandSequences: this.getCommandSequences(tick),
        };
    }
    /** Fence a donor against retained confirmed history and immutable local inputs. */
    verifyConfirmedBootstrap(bootstrap) {
        if (this.localFastPath) {
            throw new Error('confirmed bootstrap unavailable in local fast path');
        }
        if (
            this.closed ||
            this._failure ||
            this.resimulating ||
            !bootstrap ||
            bootstrap.tick < this.confirmedBoundary ||
            bootstrap.tick - bootstrap.checkpoint?.tick > this.profile.stateHistorySize ||
            !Array.isArray(bootstrap.frames) ||
            bootstrap.frames.length !== bootstrap.tick - bootstrap.checkpoint.tick ||
            JSON.stringify(bootstrap.players) !== JSON.stringify(this.players)
        ) {
            throw new Error('resume bootstrap boundary');
        }
        const BASE = this._history.get(bootstrap.checkpoint.tick);
        if (
            !BASE ||
            BASE.tick > this.confirmedBoundary ||
            this._stateHash(BASE) !== bootstrap.checkpoint.hash ||
            !equalBytes(BASE.bytes, bytes(bootstrap.checkpoint.bytes))
        ) {
            throw new Error('resume checkpoint does not match retained agreement');
        }
        const SEQUENCES = new Map(BASE.commandSequences);
        for (let i = 0; i < bootstrap.frames.length; i++) {
            const FRAME = bootstrap.frames[i],
                TICK = BASE.tick + i;
            if (FRAME.tick !== TICK || FRAME.inputs?.length !== this.players.length) {
                throw new Error('resume input suffix shape');
            }
            for (let p = 0; p < this.players.length; p++) {
                const ID = this.players[p],
                    INCOMING = FRAME.inputs[p],
                    KNOWN = this._inputs.get(ID).get(TICK);
                if (
                    INCOMING?.playerId !== ID ||
                    INCOMING.predicted ||
                    !Array.isArray(INCOMING.commands) ||
                    (!KNOWN && (TICK < this.confirmedBoundary || ID === this.localPlayerId)) ||
                    (KNOWN && !frameEqual(KNOWN, INCOMING))
                ) {
                    throw new Error('resume input conflicts with retained agreement');
                }
                for (const COMMAND of INCOMING.commands) {
                    SEQUENCES.set(ID, Math.max(SEQUENCES.get(ID), COMMAND.sequence));
                }
            }
        }
        for (const ID of this.players) {
            if (bootstrap.commandSequences?.[ID] !== SEQUENCES.get(ID)) {
                throw new Error('resume command sequence conflicts with retained agreement');
            }
        }
        if (bootstrap.tick === this.confirmedBoundary && bootstrap.hash !== this.getStateHash(bootstrap.tick)) {
            throw new Error('resume final state conflicts with confirmed boundary');
        }
        return true;
    }
    requestResync(tick) {
        if (this.localFastPath) {
            return false;
        }
        if (this.closed || this._failure) {
            return false;
        }
        integer(tick, 'recovery tick', 0, Math.min(this.tick, this.confirmedTick + 1));
        if (this.localPlayerId === this.authorityPlayerId) {
            return false;
        }
        const PEER = this._peers.get(this.authorityPlayerId);
        if (!PEER?.ready || this._requestedRecovery) {
            return false;
        }
        if (this._recoveryExhausted('attempt-limit')) {
            return false;
        }
        const STATE = this.profile.mode === 'lockstep' ? this._history.atOrBefore(tick) : this._history.get(tick);
        if (!STATE) {
            return false;
        }
        tick = STATE.tick;
        if (
            !this._queue(
                PEER,
                packet(TYPE.REQUEST, this._nextSequence(), (w) => w.u32(tick)),
            )
        ) {
            return false;
        }
        this._requestedRecovery = {
            tick,
            inputHash: STATE.inputHash,
            at: this._clock(),
        };
        this._recoveryAttempts++;
        return true;
    }
    _sendSnapshot(peer, tick) {
        if (this.localPlayerId !== this.authorityPlayerId || this.resimulating || tick > this.confirmedTick + 1) {
            return;
        }
        const STATE = this._history.get(tick);
        if (!STATE) {
            return;
        }
        const TRANSFER = ++this._nextTransfer >>> 0,
            COUNT = Math.ceil(STATE.bytes.length / SNAP_CHUNK_BYTES);
        const PACKETS = [
            packet(TYPE.BEGIN, this._nextSequence(), (w) => {
                w.u32(TRANSFER);
                w.u32(tick);
                w.u32(STATE.bytes.length);
                w.u32(this._stateHash(STATE));
                w.u32(STATE.inputHash);
                w.u16(COUNT);
            }),
        ];
        for (let i = 0; i < COUNT; i++) {
            PACKETS.push(
                packet(TYPE.CHUNK, this._nextSequence(), (w) => {
                    w.u32(TRANSFER);
                    w.u32(i);
                    w.raw(STATE.bytes.subarray(i * SNAP_CHUNK_BYTES, (i + 1) * SNAP_CHUNK_BYTES));
                }),
            );
        }
        if (peer.queuedBytes + PACKETS.reduce((s, b) => s + b.length, 0) > this.profile.maxQueuedBytes) {
            this._event('recovery-backpressure', {
                peerId: peer.id,
            });
            return;
        }
        for (const P of PACKETS) {
            this._queue(peer, P);
        }
    }
    _beginSnapshot(peer, r, now) {
        const TRANSFER = r.u32(),
            TICK = r.u32(),
            TOTAL = r.u32(),
            HASH_LOCAL = r.u32(),
            INPUT_HASH = r.u32(),
            COUNT = r.u16();
        r.end();
        const BUSY = this._incomingSnapshot;
        if (BUSY) {
            if (
                peer.id === this.authorityPlayerId &&
                TRANSFER === BUSY.transfer &&
                TICK === BUSY.tick &&
                TOTAL === BUSY.total &&
                HASH_LOCAL === BUSY.hash &&
                INPUT_HASH === BUSY.inputHash &&
                COUNT === BUSY.count
            ) {
                return;
            }
            throw new Error('another snapshot candidate is active');
        }
        if (
            peer.id !== this.authorityPlayerId ||
            !this._requestedRecovery ||
            this._requestedRecovery.tick !== TICK ||
            INPUT_HASH !== this._requestedRecovery.inputHash ||
            !this._history.get(TICK) ||
            TICK > this.confirmedTick + 1 ||
            !TOTAL ||
            TOTAL > this.profile.maxSnapshotBytes ||
            COUNT !== Math.ceil(TOTAL / SNAP_CHUNK_BYTES) ||
            this._incomingSnapshot
        ) {
            throw new Error('snapshot candidate metadata');
        }
        this._incomingSnapshot = {
            transfer: TRANSFER,
            tick: TICK,
            total: TOTAL,
            hash: HASH_LOCAL,
            inputHash: INPUT_HASH,
            count: COUNT,
            bytes: new Uint8Array(TOTAL),
            seen: new Uint8Array(COUNT),
            received: 0,
            started: now,
        };
    }
    _snapshotChunk(peer, r) {
        const TRANSFER = r.u32(),
            INDEX = r.u32(),
            CANDIDATE = this._incomingSnapshot;
        if (
            peer.id !== this.authorityPlayerId ||
            !CANDIDATE ||
            TRANSFER !== CANDIDATE.transfer ||
            INDEX >= CANDIDATE.count
        ) {
            throw new Error('snapshot transfer');
        }
        const CHUNK_LOCAL = r.raw(r.data.length - r.offset);
        r.end();
        const EXPECTED = Math.min(SNAP_CHUNK_BYTES, CANDIDATE.total - INDEX * SNAP_CHUNK_BYTES);
        if (CHUNK_LOCAL.length !== EXPECTED) {
            throw new RangeError('snapshot chunk length');
        }
        const START = INDEX * SNAP_CHUNK_BYTES;
        if (CANDIDATE.seen[INDEX]) {
            if (!equalBytes(CANDIDATE.bytes.subarray(START, START + EXPECTED), CHUNK_LOCAL)) {
                throw new Error('conflicting snapshot chunk');
            }
            return;
        }
        CANDIDATE.bytes.set(CHUNK_LOCAL, START);
        CANDIDATE.seen[INDEX] = 1;
        CANDIDATE.received++;
        if (CANDIDATE.received === CANDIDATE.count) {
            this._commitSnapshot(CANDIDATE);
        }
    }
    _rejectSnapshot(reason) {
        this._incomingSnapshot = null;
        this._requestedRecovery = null;
        this._metrics.rejectedSnapshots++;
        this._event('recovery-rejected', {
            reason,
        });
        this._recoveryExhausted(reason);
    }
    _recoveryExhausted(reason) {
        if (this._recoveryAttempts < this.profile.maxRecoveryAttempts) {
            return false;
        }
        this._fail('desync-unrecoverable', {
            reason,
            attempts: this._recoveryAttempts,
            authorityPlayerId: this.authorityPlayerId,
        });
        return true;
    }
    _commitSnapshot(candidate) {
        if (this.resimulating || !this._history.get(candidate.tick) || hashBytes(candidate.bytes) !== candidate.hash) {
            this._rejectSnapshot('expired or corrupt candidate');
            return;
        }
        const STARTED = nowMs(),
            ORIGINAL = this._save();
        this._replaying = true;
        try {
            if (
                this.adapter.validateSnapshot(candidate.bytes.slice(), {
                    tick: candidate.tick,
                }) !== true
            ) {
                throw new Error('adapter rejected candidate');
            }
            this.adapter.load(candidate.bytes.slice());
            if (!equalBytes(this._save(), candidate.bytes)) {
                throw new Error('snapshot round-trip changed candidate');
            }
            const JOB = {
                candidate,
                original: ORIGINAL,
                current: this.tick,
                next: candidate.tick,
                inputHash: candidate.inputHash,
                commandSequences: this._history.get(candidate.tick).commandSequences,
                state: candidate.bytes.slice(),
                staged: [],
                stagedInputs: [],
                stageBytes: 0,
            };
            this._incomingSnapshot = null;
            while (JOB.next < JOB.current) {
                const T = JOB.next,
                    INPUTS = this._resolve(T);
                runSimulationFrame(this.adapter, {
                    tick: T,
                    tickRate: this.profile.tickRate,
                    inputs: INPUTS,
                    resimulating: true,
                    recovering: true,
                });
                JOB.inputHash = this._hashInputFrame(T, INPUTS, JOB.inputHash);
                JOB.commandSequences = executedSequences(JOB.commandSequences, INPUTS);
                const LOCKSTEP = this.profile.mode === 'lockstep';
                if (!LOCKSTEP || (T + 1) % this.profile.checksumInterval === 0) {
                    JOB.state = this._save();
                    JOB.staged.push({
                        tick: T + 1,
                        bytes: JOB.state,
                        inputHash: JOB.inputHash,
                        commandSequences: JOB.commandSequences,
                    });
                    JOB.stageBytes += JOB.state.length;
                }
                if (!LOCKSTEP) {
                    JOB.stagedInputs.push([T, INPUTS]);
                }
                if (LOCKSTEP && !this._recordReplay && T + 1 === this._replayFrames.length) {
                    JOB.replayFinalHash = hashBytes(this._save());
                }
                JOB.next++;
                this._metrics.resimulatedTicks++;
                if (JOB.stageBytes > this.profile.maxHistoryBytes) {
                    throw new RangeError('candidate replay byte budget');
                }
            }
            // Construct a complete replacement ring before exposing either game or runtime state.
            const REPLACEMENT = this._newHistory();
            for (const STATE of this._history.slots) {
                if (STATE && STATE.tick < JOB.candidate.tick) {
                    REPLACEMENT.put(STATE);
                }
            }
            REPLACEMENT.put({
                tick: JOB.candidate.tick,
                bytes: JOB.candidate.bytes,
                hash: JOB.candidate.hash,
                inputHash: JOB.candidate.inputHash,
                commandSequences: this._history.get(JOB.candidate.tick).commandSequences,
            });
            for (const STATE of JOB.staged) {
                REPLACEMENT.put(STATE);
            }
            const USED = new Map(this._used);
            for (const [T, INPUTS] of JOB.stagedInputs) {
                USED.set(T, INPUTS);
            }
            this._commandSequences = JOB.commandSequences;
            this._history = REPLACEMENT;
            this._used = USED;
            this._inputHash = JOB.inputHash;
            this._currentState = null;
            if (this.profile.mode === 'lockstep') {
                this._replayFinalState = null;
                if (!this._recordReplay && JOB.candidate.tick === this._replayFrames.length) {
                    this._replayFinalHash = JOB.candidate.hash;
                }
                if (JOB.replayFinalHash !== undefined) {
                    this._replayFinalHash = JOB.replayFinalHash;
                }
            }
            this._requestedRecovery = null;
            this._recoveryAttempts = 0;
            this._metrics.recoveries++;
            this._event('recovered', {
                from: JOB.candidate.tick,
                target: JOB.current,
            });
        } catch (error) {
            this.adapter.load(ORIGINAL.slice());
            this._rejectSnapshot(error.message);
        } finally {
            this._replaying = false;
            this._metrics.latestResimulationMs = nowMs() - STARTED;
            this._window.cost += this._metrics.latestResimulationMs;
            this._window.costSamples++;
        }
    }
    _recordConfirmed() {
        if (!this._recordReplay || this.resimulating || this._failure) {
            return;
        }
        this._replayFinalState = this._history.get(this._replayFrames.length) ?? this._replayFinalState;
        const THROUGH = Math.min(this.confirmedTick, this.tick - 1);
        for (let t = this._replayFrames.length; t <= THROUGH; t++) {
            const INPUTS = this.players.map((playerId) => ({
                playerId,
                ...copyFrame(this._inputs.get(playerId).get(t)),
                predicted: false,
            }));
            const N = this._replayFrameBytes(INPUTS);
            if (this._replayBytes + N > this.profile.maxReplayBytes) {
                this._replayFinalHash = this._stateHash(this._replayFinalState);
                this._replayFinalState = null;
                this._recordReplay = false;
                this._event('replay-capacity');
                return;
            }
            this._replayFrames.push({
                tick: t,
                inputs: INPUTS,
            });
            this._replayBytes += N;
            this._replayFinalState = this._history.get(t + 1);
        }
    }
    exportSyncTestFrames({ maxFrames = 32 } = {}) {
        if (this.localFastPath) {
            throw new Error('replay unavailable in local fast path');
        }
        integer(maxFrames, 'maxFrames', 1, 256);
        if (this.resimulating) {
            throw new Error('finish rollback before exporting synctest frames');
        }
        this._recordConfirmed();
        return {
            initialState: this._initialState.slice(),
            players: [...this.players],
            inputSize: this.inputSize,
            tickRate: this.profile.tickRate,
            initialTick: 0,
            frames: this._replayFrames.slice(0, maxFrames).map((f) => ({
                tick: f.tick,
                inputs: f.inputs.map((x) => ({
                    ...copyFrame(x),
                    playerId: x.playerId,
                    predicted: false,
                })),
            })),
        };
    }
    exportReplay() {
        if (this.localFastPath) {
            throw new Error('replay unavailable in local fast path');
        }
        if (this.resimulating) {
            throw new Error('finish rollback before exporting replay');
        }
        this._recordConfirmed();
        const TICK = this._replayFrames.length;
        const HASH_LOCAL =
            this._stateHash(this._stateAt(TICK)) ?? this._stateHash(this._replayFinalState) ?? this._replayFinalHash;
        if (TICK > 0 && HASH_LOCAL === undefined) {
            throw new Error('replay final boundary is unavailable after fatal restoration failure');
        }
        return {
            version: REPLAY_FORMAT_VERSION,
            simulationVersion: this.simulationVersion,
            seed: this.seed,
            players: [...this.players],
            inputSize: this.inputSize,
            tickRate: this.profile.tickRate,
            initialState: this._initialState.slice(),
            frames: this._replayFrames.map((f) => ({
                tick: f.tick,
                inputs: f.inputs.map((x) => ({
                    ...copyFrame(x),
                    playerId: x.playerId,
                    predicted: false,
                })),
            })),
            tick: TICK,
            hash: HASH_LOCAL ?? hashBytes(this._initialState),
            truncated: !this._recordReplay,
        };
    }
    _prune() {
        const WINDOW_OLDEST = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
        const OLDEST =
            this.profile.mode === 'lockstep'
                ? Math.min(WINDOW_OLDEST, this._history?.oldestTick ?? WINDOW_OLDEST)
                : WINDOW_OLDEST;
        for (const T of this._used.keys()) {
            if (T < OLDEST - 1) {
                this._used.delete(T);
            }
        }
        for (const PEER of this._peers.values()) {
            for (const T of PEER.reservations?.keys() ?? []) {
                if (T < OLDEST) {
                    PEER.reservations.delete(T);
                }
            }
            for (const [SEQ, C] of PEER.reservedCommands ?? []) {
                if (C.executeTick < OLDEST) {
                    PEER.reservedCommands.delete(SEQ);
                }
            }
            for (const T of PEER.reservationAcks?.keys() ?? []) {
                if (T < OLDEST) {
                    PEER.reservationAcks.delete(T);
                }
            }
        }
        const MIN_ACK = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
        for (const [PLAYER_ID, MAP] of this._inputs) {
            for (const T of MAP.keys()) {
                if (T < OLDEST && (PLAYER_ID !== this.localPlayerId || T <= MIN_ACK)) {
                    MAP.delete(T);
                }
            }
        }
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const PEER of this._peers.values()) {
            try {
                PEER.detach();
            } finally {
                PEER.transport.close?.();
            }
        }
        this._peers.clear();
        this._localReservations.clear();
        this._localCaptures.length = 0;
        this._incomingSnapshot = null;
        this._pendingCommands.length = 0;
        this._event('closed');
    }
}
