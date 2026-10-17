const MODES = new Set(['continuous', 'rollback', 'load', 'reset', 'teleport', 'join', 'resync']);
function equalInput(a, b) {
    if (a === b) {
        return true;
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        if (a.byteLength !== b.byteLength) {
            return false;
        }
        const X = new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
            Y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return X.every((v, i) => v === Y[i]);
    }
    const KEYS = Object.keys(a);
    return (
        KEYS.length === Object.keys(b).length &&
        KEYS.every((key) => Object.hasOwn(b, key) && equalInput(a[key], b[key]))
    );
}
function equalCommands(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (!equalInput(a[i]?.payload, b[i]?.payload)) {
            return false;
        }
        if (a[i]?.observationId !== undefined || b[i]?.observationId !== undefined) {
            if (a[i]?.observationId !== b[i]?.observationId) {
                return false;
            }
        } else if (a[i]?.sequence !== b[i]?.sequence) {
            return false;
        }
    }
    return true;
}
function copyInput(input, seen = new Set()) {
    if (input instanceof Uint8Array) {
        return input.slice();
    }
    if (input instanceof DataView) {
        return new DataView(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    }
    if (ArrayBuffer.isView(input)) {
        return new input.constructor(input);
    }
    if (input instanceof ArrayBuffer) {
        return input.slice(0);
    }
    if (
        Array.isArray(input) ||
        (input &&
            typeof input === 'object' &&
            (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null))
    ) {
        if (seen.has(input)) {
            throw new TypeError('preview input cannot contain cycles');
        }
        seen.add(input);
        const COPY = Array.isArray(input) ? new Array(input.length) : {};
        for (const KEY of Object.keys(input)) {
            if (['__proto__', 'prototype', 'constructor'].includes(KEY)) {
                throw new TypeError('unsafe preview input key');
            }
            const DESCRIPTOR = Object.getOwnPropertyDescriptor(input, KEY);
            if (!DESCRIPTOR || !Object.hasOwn(DESCRIPTOR, 'value')) {
                throw new TypeError('preview input accessors are not supported');
            }
            COPY[KEY] = copyInput(DESCRIPTOR.value, seen);
        }
        seen.delete(input);
        return COPY;
    }
    if (input === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof input)) {
        return input;
    }
    throw new TypeError('preview input must be immutable plain data or bytes');
}
function byteLength(value, seen = new Set()) {
    if (value == null) {
        return 0;
    }
    if (ArrayBuffer.isView(value)) {
        return value.byteLength;
    }
    if (value instanceof ArrayBuffer) {
        return value.byteLength;
    }
    if (typeof value === 'string') {
        return value.length * 2;
    }
    if (typeof value !== 'object' || seen.has(value)) {
        return 8;
    }
    seen.add(value);
    let size = Array.isArray(value) ? 8 : 16;
    for (const [KEY, ITEM] of Object.entries(value)) {
        size += KEY.length * 2 + byteLength(ITEM, seen);
    }
    return size;
}

/**
 * Optional detached local-input prediction. It never reads or mutates the live session.
 * The caller supplies confirmed detached snapshots and a fork factory whose step uses
 * the same game simulation update while suppressing all external side effects.
 */
export class LocalInputPreview {
    #isActive;
    #forkFactory;
    #cloneSnapshot;
    #captureSnapshot;
    #readEntities;
    #presentation;
    #maxPending;
    #maxFutureTicks;
    #maxAgeMs;
    #stepMs;
    #snapshot = null;
    #snapshotTick = -1;
    #fork = null;
    #forkTick = -1;
    #forkCurrent = false;
    #clockGap = false;
    #forecast = [];
    #pending = [];
    #observed = null;
    #baseInput;
    #continuationKey;
    #revision = -1;
    #tick = -1;
    #epoch = -1;
    #generation = 0;
    #sequence = 0;
    #phaseStartMs = 0;
    #timeMs = -Infinity;
    #disposed = false;
    #enabled = true;
    #captureSequence = -1;
    #confirmedCommandSequence;
    #confirmedOnlySteps = 0;
    #metrics = {
        snapshotBytes: 0,
        correctionBytes: 0,
        replayBytes: 0,
        snapshotCloneMs: 0,
        forkMs: 0,
        replayMs: 0,
        replayedInputs: 0,
        replayGapSteps: 0,
        corrections: 0,
        correctionMs: 0,
        continuedCheckpoints: 0,
        continuationRejectedDisabled: 0,
        continuationRejectedTick: 0,
        continuationRejectedRevision: 0,
        continuationRejectedEpoch: 0,
        continuationRejectedKey: 0,
        continuationRejectedObserved: 0,
        continuationRejectedForecast: 0,
        continuationRejectedInput: 0,
        continuationRejectedFork: 0,
        continuationRejectedCommands: 0,
        forkRebuilds: 0,
        snapshotRefreshes: 0,
        forecastReuses: 0,
        forecastExtensions: 0,
        currentForkExtensions: 0,
        clockGaps: 0,
        confirmedAdvances: 0,
        confirmedAdvanceRejected: 0,
        confirmedAdvanceRejectedDisabled: 0,
        confirmedAdvanceRejectedKey: 0,
        confirmedAdvanceRejectedTick: 0,
        confirmedAdvanceRejectedRevision: 0,
        confirmedAdvanceRejectedEpoch: 0,
        confirmedAdvanceRejectedInput: 0,
        confirmedAdvanceRejectedCommands: 0,
        confirmedAdvanceRejectedFork: 0,
        confirmedAdvanceRejectedPending: 0,
        confirmedAdvanceRejectedLimit: 0,
        confirmedAdvanceMs: 0,
        previewPublishes: 0,
        rejectedEpoch: 0,
        rejectedHorizon: 0,
        rejectedAge: 0,
        rejectedCapacity: 0,
    };

    /** @param {{createFork:(snapshot:unknown)=>{step:(input:unknown,context:object)=>void},cloneSnapshot?:(snapshot:unknown)=>unknown,captureSnapshot?:()=>unknown,isActive?:(fork:unknown)=>boolean,readEntities:(fork:unknown)=>Array, presentation?:{selectPreview:(ids:Array)=>void,capturePreview:(packet:object,nowMs:number)=>boolean,clearPreview?:()=>void},maxPendingInputs?:number,maxFutureTicks?:number,maxAgeMs?:number}} options */
    constructor({
        createFork,
        cloneSnapshot = (value) => structuredClone(value),
        captureSnapshot,
        readEntities,
        presentation,
        isActive,
        maxPendingInputs = 8,
        maxFutureTicks = 8,
        maxAgeMs = 250,
        stepMs = 100,
    } = {}) {
        if (typeof createFork !== 'function' || typeof readEntities !== 'function') {
            throw new TypeError('preview fork and entity reader are required');
        }
        if (
            presentation &&
            (typeof presentation.selectPreview !== 'function' || typeof presentation.capturePreview !== 'function')
        ) {
            throw new TypeError('presentation preview capability');
        }
        if (!Number.isInteger(maxPendingInputs) || maxPendingInputs < 1 || maxPendingInputs > 64) {
            throw new RangeError('maxPendingInputs');
        }
        if (!Number.isInteger(maxFutureTicks) || maxFutureTicks < 1 || maxFutureTicks > 64) {
            throw new RangeError('maxFutureTicks');
        }
        if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 2000) {
            throw new RangeError('maxAgeMs');
        }
        if (!Number.isFinite(stepMs) || stepMs <= 0) {
            throw new RangeError('stepMs');
        }
        this.#forkFactory = createFork;
        this.#cloneSnapshot = cloneSnapshot;
        this.#captureSnapshot = captureSnapshot;
        this.#readEntities = readEntities;
        this.#presentation = presentation;
        this.#maxPending = maxPendingInputs;
        this.#maxFutureTicks = maxFutureTicks;
        this.#maxAgeMs = maxAgeMs;
        this.#stepMs = stepMs;
        if (isActive !== undefined && typeof isActive !== 'function') {
            throw new TypeError('isActive');
        }
        this.#isActive = isActive;
        if (typeof cloneSnapshot !== 'function') {
            throw new TypeError('cloneSnapshot');
        }
        if (captureSnapshot !== undefined && typeof captureSnapshot !== 'function') {
            throw new TypeError('captureSnapshot');
        }
    }

    /** Ongoing detached action intent, independent of newly observed device commands. */
    get active() {
        return (
            this.ready &&
            !!this.#isActive &&
            (this.#isActive(this.#fork) ||
                this.#pending.some((frame) => frame.commands?.length) ||
                !!this.#observed?.commands.length)
        );
    }
    get pendingCount() {
        return this.#pending.length;
    }
    get enabled() {
        return this.#enabled;
    }
    get ready() {
        return (
            !!this.#snapshot &&
            !!this.#fork &&
            this.#enabled &&
            !this.#disposed &&
            performance.now() - this.#timeMs <= this.#maxAgeMs
        );
    }
    get metrics() {
        return {
            ...this.#metrics,
            pendingCount: this.#pending.length,
            epoch: this.#epoch,
            generation: this.#generation,
        };
    }
    #clear() {
        this.#pending.length = 0;
        this.#observed = null;
        this.#forecast.length = 0;
        this.#fork = null;
        this.#snapshot = null;
        this.#snapshotTick = this.#forkTick = -1;
        this.#forkCurrent = false;
        this.#clockGap = false;
        this.#baseInput = undefined;
        this.#continuationKey = undefined;
        this.#confirmedCommandSequence = undefined;
        this.#confirmedOnlySteps = 0;
        this.#captureSequence = -1;
        this.#presentation?.clearPreview?.();
        this.#presentation?.selectPreview([]);
    }

    /**
     * Install an already detached authoritative checkpoint. rollback preserves and replays
     * only unacknowledged inputs; other discontinuities intentionally discard speculation.
     * @param {{snapshot:unknown,revision:number,tick:number,epoch:number,confirmedSequence?:number,continuationKey?:string,timeMs:number,mode?:string,reset?:boolean}} checkpoint
     */
    reconcile(checkpoint) {
        this.#assertLive();
        const START = performance.now();
        if (!checkpoint || !MODES.has(checkpoint.mode ?? 'continuous')) {
            throw new TypeError('preview reconciliation mode');
        }
        for (const KEY of ['revision', 'tick', 'epoch']) {
            if (!Number.isSafeInteger(checkpoint[KEY]) || checkpoint[KEY] < 0) {
                throw new RangeError('checkpoint ' + KEY);
            }
        }
        if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) {
            throw new RangeError('checkpoint timeMs must be monotonic');
        }
        if (
            checkpoint.phaseStartMs !== undefined &&
            (!Number.isFinite(checkpoint.phaseStartMs) || checkpoint.phaseStartMs > checkpoint.timeMs)
        ) {
            throw new RangeError('checkpoint phaseStartMs must not exceed timeMs');
        }
        const MODE = checkpoint.mode ?? 'continuous';
        if (checkpoint.revision < this.#revision) {
            throw new RangeError('checkpoint revision cannot regress');
        }
        if (
            checkpoint.continuationKey !== undefined &&
            (typeof checkpoint.continuationKey !== 'string' || checkpoint.continuationKey.length > 65536)
        ) {
            throw new TypeError('checkpoint continuationKey');
        }
        const CHANGED_REVISION = this.#revision >= 0 && checkpoint.revision !== this.#revision;
        if (CHANGED_REVISION && !['rollback', 'load', 'reset', 'teleport', 'join', 'resync'].includes(MODE)) {
            throw new RangeError('new preview revision requires an explicit lifecycle mode');
        }
        for (const KEY of ['confirmedSequence', 'confirmedCommandSequence']) {
            if (checkpoint[KEY] !== undefined && (!Number.isSafeInteger(checkpoint[KEY]) || checkpoint[KEY] < 0)) {
                throw new RangeError('checkpoint ' + KEY);
            }
        }
        const DISCONTINUITY =
            checkpoint.reset ||
            ['load', 'reset', 'teleport', 'join', 'resync'].includes(MODE) ||
            (this.#epoch >= 0 && checkpoint.epoch !== this.#epoch);
        if (DISCONTINUITY) {
            this.#pending.length = 0;
            this.#observed = null;
            this.#forecast.length = 0;
            this.#forkCurrent = false;
            this.#captureSequence = -1;
        } else {
            this.#pending = this.#pending
                .filter(
                    (input) =>
                        input.executeTick >= checkpoint.tick &&
                        input.executeTick - checkpoint.tick < this.#maxFutureTicks,
                )
                .map((input) => ({
                    ...input,
                    commands:
                        checkpoint.confirmedCommandSequence === undefined
                            ? input.commands
                            : input.commands.filter(
                                  (command) => command.sequence > checkpoint.confirmedCommandSequence,
                              ),
                }));
        }
        const CLONED_AT = performance.now();
        const SNAPSHOT = this.#cloneSnapshot(checkpoint.snapshot);
        this.#metrics.snapshotCloneMs += performance.now() - CLONED_AT;
        const SNAPSHOT_SIZE = byteLength(SNAPSHOT);
        this.#metrics.snapshotBytes += SNAPSHOT_SIZE;
        this.#metrics.correctionBytes += SNAPSHOT_SIZE;
        this.#snapshot = SNAPSHOT;
        this.#snapshotTick = checkpoint.tick;
        this.#continuationKey = checkpoint.continuationKey;
        this.#clockGap = false;
        this.#revision = checkpoint.revision;
        this.#tick = checkpoint.tick;
        this.#epoch = checkpoint.epoch;
        this.#forkCurrent = false;
        this.#forkTick = -1;
        this.#forecast.length = 0;
        this.#baseInput = checkpoint.input === undefined ? undefined : copyInput(checkpoint.input);
        this.#confirmedCommandSequence = checkpoint.confirmedCommandSequence;
        this.#confirmedOnlySteps = 0;
        this.#timeMs = checkpoint.timeMs;
        this.#phaseStartMs = checkpoint.phaseStartMs ?? checkpoint.timeMs;
        this.#generation++;
        if (this.#pending.length || this.#observed || !this.#fork) {
            this.#rebuild(checkpoint.timeMs);
        }
        this.#metrics.corrections++;
        this.#metrics.correctionMs += performance.now() - START;
        if (!this.#pending.length && !this.#observed) {
            this.#forecast.length = 0;
            this.#forkCurrent = false;
            if (DISCONTINUITY || MODE === 'rollback') {
                this.#presentation?.clearPreview?.();
            } else {
                this.#presentation?.releasePreview?.(checkpoint.timeMs);
            }
            return true;
        }
        return true;
    }

    /**
     * Confirm one already-predicted authority step without reinstalling a full snapshot.
     * The host supplies an exact key for remote inputs/commands; any discontinuity returns false.
     */
    continueFromCheckpoint(checkpoint) {
        this.#assertLive();
        const REJECT = (reason) => {
            this.#metrics['continuationRejected' + reason]++;
            return false;
        };
        if (!this.#enabled) {
            return REJECT('Disabled');
        }
        if (!checkpoint || typeof checkpoint.continuationKey !== 'string') {
            return REJECT('Key');
        }
        for (const KEY of ['revision', 'tick', 'epoch']) {
            if (!Number.isSafeInteger(checkpoint[KEY]) || checkpoint[KEY] < 0) {
                throw new RangeError('checkpoint ' + KEY);
            }
        }
        if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) {
            throw new RangeError('checkpoint timeMs must be monotonic');
        }
        if (checkpoint.tick !== this.#tick + 1) {
            return REJECT('Tick');
        }
        if (checkpoint.revision !== this.#revision) {
            return REJECT('Revision');
        }
        if (checkpoint.epoch !== this.#epoch) {
            return REJECT('Epoch');
        }
        if (checkpoint.continuationKey !== this.#continuationKey) {
            return REJECT('Key');
        }
        if (this.#observed) {
            return REJECT('Observed');
        }
        if (checkpoint.input === undefined) {
            return REJECT('Input');
        }
        if (!this.#fork) {
            return REJECT('Fork');
        }
        const PREDICTED = this.#forecast.find((step) => step.tick === this.#tick);
        if (!PREDICTED) {
            return REJECT('Forecast');
        }
        if (!equalInput(PREDICTED.input, checkpoint.input)) {
            return REJECT('Input');
        }
        if (this.#forkTick < checkpoint.tick) {
            return REJECT('Fork');
        }
        const COMMANDS = PREDICTED.commands || [];
        if (
            COMMANDS.length &&
            (checkpoint.confirmedCommandSequence === undefined ||
                !Number.isSafeInteger(checkpoint.confirmedCommandSequence) ||
                COMMANDS.some(
                    (command) =>
                        !Number.isSafeInteger(command.sequence) ||
                        command.sequence > checkpoint.confirmedCommandSequence,
                ))
        ) {
            return REJECT('Commands');
        }
        this.#pending = this.#pending
            .filter(
                (input) =>
                    input.executeTick >= checkpoint.tick && input.executeTick - checkpoint.tick < this.#maxFutureTicks,
            )
            .map((input) => ({
                ...input,
                commands:
                    checkpoint.confirmedCommandSequence === undefined
                        ? input.commands
                        : input.commands.filter((command) => command.sequence > checkpoint.confirmedCommandSequence),
            }));
        this.#forecast = this.#forecast.filter((step) => step.tick >= checkpoint.tick);
        this.#tick = checkpoint.tick;
        this.#epoch = checkpoint.epoch;
        this.#revision = checkpoint.revision;
        this.#baseInput = copyInput(checkpoint.input);
        this.#timeMs = checkpoint.timeMs;
        this.#phaseStartMs = checkpoint.phaseStartMs ?? checkpoint.timeMs;
        this.#generation++;
        this.#continuationKey = checkpoint.continuationKey;
        this.#confirmedCommandSequence = checkpoint.confirmedCommandSequence ?? this.#confirmedCommandSequence;
        this.#confirmedOnlySteps = 0;
        this.#forkCurrent = this.#forkTick === this.#tick && !this.#pending.length;
        this.#clockGap = false;
        this.#metrics.continuedCheckpoints++;
        if (!this.#pending.length && !this.#observed) {
            if (this.#forecast.some((step) => step.kind === 'observed' && step.tick >= checkpoint.tick)) {
                this.#publish(checkpoint.timeMs);
            } else {
                this.#presentation?.clearPreview?.();
            }
        }
        return true;
    }

    /**
     * Advance one exact confirmed local frame when no speculative frame was available.
     * Only a contiguous fork with no pending work or newly confirmed command can use this path;
     * one step maximum keeps non-local state staleness bounded before snapshot rebase.
     * @param {{input:unknown,revision:number,tick:number,epoch:number,continuationKey:string,confirmedCommandSequence?:number,timeMs:number}} checkpoint
     * @returns {boolean} Whether the detached fork advanced without installing a full snapshot.
     */
    advanceConfirmedCheckpoint(checkpoint) {
        this.#assertLive();
        const REJECT = (reason) => {
            this.#metrics.confirmedAdvanceRejected++;
            this.#metrics['confirmedAdvanceRejected' + reason]++;
            return false;
        };
        if (!this.#enabled) {
            return REJECT('Disabled');
        }
        if (!checkpoint || typeof checkpoint.continuationKey !== 'string') {
            return REJECT('Key');
        }
        for (const KEY of ['revision', 'tick', 'epoch']) {
            if (!Number.isSafeInteger(checkpoint[KEY]) || checkpoint[KEY] < 0) {
                throw new RangeError('checkpoint ' + KEY);
            }
        }
        if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) {
            throw new RangeError('checkpoint timeMs must be monotonic');
        }
        if (
            checkpoint.confirmedCommandSequence !== undefined &&
            (!Number.isSafeInteger(checkpoint.confirmedCommandSequence) || checkpoint.confirmedCommandSequence < 0)
        ) {
            throw new RangeError('checkpoint confirmedCommandSequence');
        }
        if (checkpoint.tick !== this.#tick + 1) {
            return REJECT('Tick');
        }
        if (checkpoint.revision !== this.#revision) {
            return REJECT('Revision');
        }
        if (checkpoint.epoch !== this.#epoch) {
            return REJECT('Epoch');
        }
        if (checkpoint.continuationKey !== this.#continuationKey) {
            return REJECT('Key');
        }
        if (checkpoint.input === undefined) {
            return REJECT('Input');
        }
        if (checkpoint.confirmedCommandSequence !== this.#confirmedCommandSequence) {
            return REJECT('Commands');
        }
        if (!this.#fork || !this.#forkCurrent || this.#forkTick !== this.#tick) {
            return REJECT('Fork');
        }
        if (this.#pending.length || this.#observed || this.#forecast.length) {
            return REJECT('Pending');
        }
        if (this.#confirmedOnlySteps >= 1) {
            return REJECT('Limit');
        }
        const STARTED = performance.now(),
            INPUT = copyInput(checkpoint.input);
        this.#fork.step(copyInput(INPUT), {
            tick: this.#tick,
            epoch: this.#epoch,
            commands: [],
            speculative: true,
            confirmedReplay: true,
        });
        this.#metrics.confirmedAdvanceMs += performance.now() - STARTED;
        this.#metrics.confirmedAdvances++;
        this.#baseInput = copyInput(INPUT);
        this.#tick = checkpoint.tick;
        this.#epoch = checkpoint.epoch;
        this.#revision = checkpoint.revision;
        this.#timeMs = checkpoint.timeMs;
        this.#continuationKey = checkpoint.continuationKey;
        this.#forkTick = checkpoint.tick;
        this.#forkCurrent = true;
        this.#confirmedOnlySteps++;
        this.#generation++;
        this.#presentation?.clearPreview?.();
        return true;
    }

    /** Observe a coalesced future frame BEFORE authority advances. Provisional IDs are not SDK command sequences. */
    observe(input, { sequence, tick, epoch, timeMs, continuationKey, commands = [] }) {
        this.#assertLive();
        if (!this.#enabled) {
            return false;
        }
        if (!this.#snapshot || !this.#fork) {
            return false;
        }
        for (const [NAME, VALUE] of Object.entries({
            sequence,
            tick,
            epoch,
            timeMs,
        })) {
            if (NAME === 'timeMs' ? !Number.isFinite(VALUE) : !Number.isSafeInteger(VALUE) || VALUE < 0) {
                throw new RangeError('preview submission ' + NAME);
            }
        }
        if (epoch !== this.#epoch) {
            this.#metrics.rejectedEpoch++;
            this.#clear();
            return false;
        }
        const FUTURE_END = Math.max(this.#tick, ...this.#pending.map((frame) => frame.executeTick + 1));
        if (tick < this.#tick || FUTURE_END - this.#tick + 1 > this.#maxFutureTicks) {
            this.#metrics.rejectedHorizon++;
            this.#clear();
            return false;
        }
        const SAME_CHECKPOINT_AFTER_GAP =
            this.#clockGap &&
            tick === this.#tick &&
            (continuationKey ?? this.#continuationKey) === this.#continuationKey;
        if (timeMs - this.#timeMs > this.#maxAgeMs && !SAME_CHECKPOINT_AFTER_GAP) {
            this.#metrics.rejectedAge++;
            this.#clear();
            return false;
        }
        if (this.#pending.length >= this.#maxPending) {
            this.#metrics.rejectedCapacity++;
            this.#clear();
            return false;
        }
        if (!Array.isArray(commands)) {
            throw new TypeError('preview commands must be an array');
        }
        const OWNED = {
            sequence,
            tick,
            epoch,
            timeMs,
            input: copyInput(input),
            commands: copyInput(commands),
        };
        const SAME =
            this.#observed &&
            equalInput(this.#observed.input, OWNED.input) &&
            equalInput(this.#observed.commands, OWNED.commands);
        if (SAME) {
            if (this.#clockGap) {
                this.#clockGap = false;
                this.#publish(timeMs);
            }
            return true;
        }
        let conflictingObserved = false;
        for (let i = this.#forecast.length - 1; i >= 0; i--) {
            const STEP = this.#forecast[i];
            if (STEP.kind === 'observed' && STEP.tick >= tick) {
                if (equalInput(STEP.input, OWNED.input) && equalCommands(STEP.commands, OWNED.commands)) {
                    this.#observed = OWNED;
                    STEP.sequence = OWNED.sequence;
                    this.#metrics.forecastReuses++;
                    this.#clockGap = false;
                    this.#publish(timeMs);
                    return true;
                }
                conflictingObserved = true;
                break;
            }
        }
        if (this.#forkCurrent && this.#forkTick === this.#tick && !this.#pending.length) {
            const STARTED = performance.now(),
                STEP_INPUT = copyInput(OWNED.input),
                STEP_COMMANDS = copyInput(OWNED.commands);
            this.#fork.step(STEP_INPUT, {
                sequence: OWNED.sequence,
                tick: this.#tick,
                epoch: this.#epoch,
                commands: STEP_COMMANDS,
                speculative: true,
            });
            this.#metrics.replayMs += performance.now() - STARTED;
            this.#metrics.replayedInputs++;
            this.#metrics.replayBytes += byteLength(OWNED.input) + byteLength(OWNED.commands);
            this.#forecast.push({
                tick: this.#tick,
                input: copyInput(OWNED.input),
                commands: copyInput(OWNED.commands),
                sequence: OWNED.sequence,
                kind: 'observed',
            });
            this.#observed = OWNED;
            this.#forkTick = this.#tick + 1;
            this.#forkCurrent = false;
            this.#clockGap = false;
            this.#metrics.currentForkExtensions++;
            this.#publish(timeMs);
            return true;
        }
        if (!conflictingObserved && tick === this.#tick && this.#fork && this.#forkTick > this.#tick) {
            const STARTED = performance.now(),
                STEP_INPUT = copyInput(OWNED.input),
                STEP_COMMANDS = copyInput(OWNED.commands),
                TICK = this.#forkTick;
            this.#fork.step(STEP_INPUT, {
                sequence: OWNED.sequence,
                tick: TICK,
                epoch: this.#epoch,
                commands: STEP_COMMANDS,
                speculative: true,
            });
            this.#metrics.replayMs += performance.now() - STARTED;
            this.#metrics.replayedInputs++;
            this.#metrics.replayBytes += byteLength(OWNED.input) + byteLength(OWNED.commands);
            this.#forecast.push({
                tick: TICK,
                input: copyInput(OWNED.input),
                commands: copyInput(OWNED.commands),
                sequence: OWNED.sequence,
                kind: 'observed',
            });
            this.#observed = OWNED;
            this.#forkTick++;
            this.#forkCurrent = false;
            this.#clockGap = false;
            this.#metrics.forecastExtensions++;
            this.#publish(timeMs);
            return true;
        }
        this.#observed = OWNED;
        this.#rebuild(timeMs);
        return true;
    }

    /** Bind provisional observations once to immutable SDK captures, including their real execution ticks. */
    commit(capture, nowMs) {
        this.#assertLive();
        if (!this.#enabled) {
            return false;
        }
        if (!this.#snapshot || !capture || capture.sequence === this.#captureSequence) {
            return false;
        }
        if (!Number.isSafeInteger(capture.executeTick) || capture.executeTick < this.#tick) {
            return false;
        }
        if (capture.executeTick - this.#tick >= this.#maxFutureTicks) {
            this.#metrics.rejectedHorizon++;
            this.#clear();
            return false;
        }
        this.#captureSequence = capture.sequence;
        this.#pending = this.#pending.filter((frame) => frame.executeTick !== capture.executeTick);
        if (capture.predict !== false || capture.commands?.length) {
            this.#pending.push({
                ...capture,
                input: copyInput(capture.input),
                commands: copyInput(capture.commands ?? []),
                timeMs: nowMs,
            });
        }
        const FORECAST = this.#forecast.find((step) => step.tick === capture.executeTick);
        if (FORECAST) {
            FORECAST.input = copyInput(capture.input);
            FORECAST.commands = copyInput(capture.commands ?? []);
            FORECAST.sequence = capture.sequence;
            FORECAST.executeTick = capture.executeTick;
            FORECAST.kind = 'pending';
        }
        if (Number.isSafeInteger(capture.boundaryTick)) {
            this.#pending = this.#pending.filter((frame) => frame.executeTick >= capture.boundaryTick);
        }
        this.#observed = null;
        if (this.#pending.length > this.#maxPending) {
            this.#metrics.rejectedCapacity++;
            this.#clear();
            return false;
        }
        return true;
    }
    /** No active device intent: preserve immutable future captures and release the coalesced slot smoothly. */
    cancelObservation(nowMs) {
        const CHANGED = !!this.#observed;
        this.#observed = null;
        if (!this.#pending.length) {
            if (CHANGED) {
                this.#forecast.length = 0;
                this.#forkCurrent = false;
            }
            this.#presentation?.releasePreview?.(nowMs);
        } else if (CHANGED) {
            this.#rebuild(nowMs);
        }
    }
    /** A main-thread clock gap drops frame timing; keep the fork only for exact next-tick confirmation. */
    clockGap() {
        this.#assertLive();
        if (!this.#enabled || !this.#snapshot || !this.#fork) {
            return false;
        }
        this.#clockGap = true;
        this.#metrics.clockGaps++;
        this.#presentation?.clearPreview?.();
        this.#presentation?.selectPreview([]);
        return true;
    }
    #rebuild(timeMs) {
        if (!this.#snapshot) {
            this.#fork = null;
            return;
        }
        if (this.#snapshotTick !== this.#tick) {
            if (!this.#captureSnapshot) {
                throw new Error('A fresh authoritative snapshot is required to rebase the preview fork');
            }
            const CAPTURED = this.#captureSnapshot(),
                CLONED_AT = performance.now();
            this.#snapshot = this.#cloneSnapshot(CAPTURED);
            this.#snapshotTick = this.#tick;
            this.#metrics.snapshotCloneMs += performance.now() - CLONED_AT;
            this.#metrics.snapshotBytes += byteLength(this.#snapshot);
            this.#metrics.snapshotRefreshes++;
        }
        const STARTED = performance.now();
        this.#metrics.forkRebuilds++;
        this.#clockGap = false;
        this.#forecast.length = 0;
        this.#forkCurrent = false;
        if (this.#fork?.restore) {
            this.#fork.restore(this.#cloneSnapshot(this.#snapshot));
        } else {
            this.#fork = this.#forkFactory(this.#cloneSnapshot(this.#snapshot));
        }
        if (!this.#fork || typeof this.#fork.step !== 'function') {
            throw new TypeError('fork must expose step(input, context)');
        }
        this.#metrics.forkMs += performance.now() - STARTED;
        let tick = this.#tick;
        let held = this.#baseInput;
        for (const ENTRY of this.#pending.slice().sort((a, b) => a.executeTick - b.executeTick)) {
            while (tick < ENTRY.executeTick) {
                if (held === undefined) {
                    throw new TypeError('Replay gaps require explicit confirmed checkpoint input');
                }
                const GAP_INPUT = copyInput(held),
                    GAP_AT = performance.now();
                this.#forecast.push({
                    tick,
                    input: copyInput(GAP_INPUT),
                    commands: [],
                    kind: 'gap',
                });
                this.#fork.step(GAP_INPUT, {
                    tick: tick++,
                    epoch: this.#epoch,
                    commands: [],
                    speculative: true,
                    replay: true,
                    gap: true,
                });
                this.#metrics.replayMs += performance.now() - GAP_AT;
                this.#metrics.replayedInputs++;
                this.#metrics.replayGapSteps++;
                this.#metrics.replayBytes += byteLength(held);
            }
            const REPLAY_AT = performance.now();
            const REPLAY_INPUT = copyInput(ENTRY.input),
                REPLAY_COMMANDS = copyInput(ENTRY.commands);
            this.#forecast.push({
                tick,
                input: copyInput(REPLAY_INPUT),
                commands: copyInput(REPLAY_COMMANDS),
                sequence: ENTRY.sequence,
                executeTick: ENTRY.executeTick,
                kind: 'pending',
            });
            this.#fork.step(REPLAY_INPUT, {
                sequence: ENTRY.sequence,
                tick: tick++,
                executeTick: ENTRY.executeTick,
                epoch: this.#epoch,
                commands: REPLAY_COMMANDS,
                speculative: true,
                replay: true,
            });
            held = ENTRY.input;
            this.#metrics.replayMs += performance.now() - REPLAY_AT;
            this.#metrics.replayBytes += byteLength(ENTRY.input) + byteLength(ENTRY.commands);
            this.#metrics.replayedInputs++;
        }
        if (this.#observed) {
            const ENTRY = this.#observed,
                REPLAY_AT = performance.now();
            const OBSERVED_INPUT = copyInput(ENTRY.input),
                OBSERVED_COMMANDS = copyInput(ENTRY.commands);
            this.#forecast.push({
                tick,
                input: copyInput(OBSERVED_INPUT),
                commands: copyInput(OBSERVED_COMMANDS),
                sequence: ENTRY.sequence,
                kind: 'observed',
            });
            this.#fork.step(OBSERVED_INPUT, {
                sequence: ENTRY.sequence,
                tick,
                epoch: this.#epoch,
                commands: OBSERVED_COMMANDS,
                speculative: true,
            });
            this.#metrics.replayMs += performance.now() - REPLAY_AT;
            this.#metrics.replayedInputs++;
            this.#metrics.replayBytes += byteLength(ENTRY.input) + byteLength(ENTRY.commands);
        }
        this.#forkTick = tick + (this.#observed ? 1 : 0);
        this.#forkCurrent = this.#forkTick === this.#tick && !this.#pending.length && !this.#observed;
        if (this.#pending.length || this.#observed) {
            this.#publish(timeMs);
        }
    }
    #publish(timeMs, initial) {
        if (!this.#enabled) {
            return false;
        }
        if (!this.#presentation || !this.#fork) {
            return true;
        }
        const ENTITIES = this.#readEntities(this.#fork);
        if (
            !Array.isArray(ENTITIES) ||
            ENTITIES.some(
                (entity) =>
                    !entity ||
                    typeof entity.id !== 'string' ||
                    !Number.isSafeInteger(entity.generation) ||
                    !entity.source,
            )
        ) {
            throw new TypeError('preview entities must be schema-backed identities');
        }
        this.#presentation.selectPreview(
            ENTITIES.map(({ id, generation }) => ({
                id,
                generation,
            })),
        );
        const STARTS = new Map((initial ?? []).map((entity) => [entity.id, entity.source]));
        const ACCEPTED = this.#presentation.capturePreview(
            {
                revision: this.#revision,
                sequence: ++this.#sequence,
                timeMs,
                phaseStartMs: this.#phaseStartMs,
                stepMs: Math.max(1, this.#forkTick - this.#tick) * this.#stepMs,
                entities: ENTITIES.map((entity) => ({
                    ...entity,
                    initialSource: STARTS.get(entity.id),
                })),
            },
            timeMs,
        );
        if (ACCEPTED) {
            this.#metrics.previewPublishes++;
        }
        return ACCEPTED;
    }

    /** Clear prediction at pause, blur, clock gap, lifecycle reset, or when preview is disabled. */
    clear() {
        this.#assertLive();
        this.#clear();
    }
    setEnabled(enabled) {
        this.#assertLive();
        if (typeof enabled !== 'boolean') {
            throw new TypeError('enabled');
        }
        this.#enabled = enabled;
        if (!enabled) {
            this.#clear();
        }
    }
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#clear();
        this.#disposed = true;
    }
    #assertLive() {
        if (this.#disposed) {
            throw new Error('input preview disposed');
        }
    }
}
