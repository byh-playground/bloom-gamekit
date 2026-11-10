const INTEGER = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
    return value;
};
const TIME = (value, name) => {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be nonnegative milliseconds`);
    }
    return value;
};
function displayOptions(value) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.stepMs) || value.stepMs <= 0) {
        throw new RangeError('display.stepMs must be positive milliseconds');
    }
    TIME(value.maxLatenessMs, 'display.maxLatenessMs');
    if (value.classify !== undefined && typeof value.classify !== 'function') {
        throw new TypeError('display.classify must be a function');
    }
    return {
        stepMs: value.stepMs,
        maxLatenessMs: value.maxLatenessMs,
        classify: value.classify ?? null,
        timeMs: -Infinity,
        revision: -1,
        active: true,
    };
}
/** Identity is independent of local arrival time, random values, and render frames. */
export function presentationEventKey(event) {
    INTEGER(event.tick, 'tick');
    INTEGER(event.sequence, 'sequence');
    INTEGER(event.generation, 'generation');
    if (
        (typeof event.entityId !== 'string' && typeof event.entityId !== 'number') ||
        (typeof event.entityId === 'number' && !Number.isSafeInteger(event.entityId))
    ) {
        throw new TypeError('entityId must be string or safe integer');
    }
    if (typeof event.kind !== 'string' || !event.kind) {
        throw new TypeError('kind required');
    }
    return JSON.stringify([event.tick, event.sequence, event.entityId, event.generation, event.kind]);
}
/** Presentation order of due records: display time, then tick, then sequence. */
function compareDue(a, b) {
    return (
        a.presentationTimeMs - b.presentationTimeMs ||
        a.event.tick - b.event.tick ||
        a.event.sequence - b.event.sequence
    );
}
/** Resource journal, not simulation history. Clock is explicit and independent of tick rate. */
export class PresentationEventQueue {
    constructor({ adapters, retentionTicks = 120, maxPending = 100000, nowMs = 0, display = null } = {}) {
        if (!adapters || typeof adapters !== 'object') {
            throw new TypeError('adapters required');
        }
        INTEGER(retentionTicks, 'retentionTicks');
        if (!retentionTicks) {
            throw new RangeError('retentionTicks must be positive');
        }
        INTEGER(maxPending, 'maxPending');
        if (!maxPending) {
            throw new RangeError('maxPending must be positive');
        }
        this.adapters = new Map(Object.entries(adapters));
        for (const [KIND, ADAPTER] of this.adapters) {
            if (!KIND || typeof ADAPTER?.start !== 'function') {
                throw new TypeError('adapter.start required');
            }
            if (ADAPTER.reversible === true && typeof ADAPTER.stop !== 'function') {
                throw new TypeError('reversible adapter.stop required');
            }
            for (const KEY of ['stop', 'update', 'reconcile', 'confirm']) {
                if (ADAPTER[KEY] !== undefined && typeof ADAPTER[KEY] !== 'function') {
                    throw new TypeError(`adapter.${KEY} must be function`);
                }
            }
        }
        this.retentionTicks = retentionTicks;
        this.maxPending = maxPending;
        this.nowMs = TIME(nowMs, 'nowMs');
        this.wallNowMs = this.nowMs;
        this.display = display === null ? null : displayOptions(display);
        this.confirmedTick = -1;
        // Only unconfirmed/retry work is visited on confirmation and rollback.
        this.records = new Map();
        this.active = new Set();
        this.awaitingConfirmation = new Set();
        this.awaitingPresentation = this.display ? new Set() : null;
        this.dueLists = [];
        this.dueDepth = 0;
        this.collectibleTicks = new Map();
        this.rollbackFrom = null;
        this.disposed = false;
        this.presenting = false;
        this.confirmationDirty = false;
        this.stats = {
            started: 0,
            duplicates: 0,
            cancelled: 0,
            expired: 0,
            collected: 0,
            rejectedOld: 0,
        };
    }
    _ready() {
        if (this.disposed) {
            throw new Error('event queue disposed');
        }
    }
    /** Select display scheduling after handshake, before any event or authority confirmation. */
    configureDisplay(display) {
        this._ready();
        if (this.display || this.records.size || this.confirmedTick !== -1 || this.rollbackFrom !== null) {
            throw new Error('display scheduling must be configured before events or confirmation');
        }
        this.display = displayOptions(display);
        this.awaitingPresentation = new Set();
        this.nowMs = 0;
    }
    /** Hide transient presentation without altering authority confirmation or event identity. */
    setPresentationActive(active) {
        this._ready();
        if (!this.display || typeof active !== 'boolean') {
            throw new TypeError('display scheduling and a boolean active state are required');
        }
        if (this.display.active === active) {
            return;
        }
        this.display.active = active;
        if (active) {
            return;
        }
        const ERRORS = [];
        for (const RECORD of this.active) {
            try {
                this._stop(RECORD, 'hidden');
            } catch (error) {
                ERRORS.push(error);
            } finally {
                if (!RECORD.confirmed && RECORD.state === 'hidden') {
                    RECORD.state = 'cancelled';
                }
            }
        }
        for (const RECORD of this.awaitingPresentation) {
            if (RECORD.confirmed) {
                this._stop(RECORD, 'hidden');
            } else {
                this.awaitingPresentation.delete(RECORD);
                RECORD.state = 'cancelled';
            }
        }
        if (ERRORS.length === 1) {
            throw ERRORS[0];
        }
        if (ERRORS.length) {
            throw new AggregateError(ERRORS, 'presentation hide cleanup failed');
        }
    }
    _start(record, startedMs = this.nowMs) {
        const EVENT = record.event;
        if (this.display) {
            record.state = 'starting';
            record.finishDuringStart = false;
        }
        let handle;
        try {
            handle =
                this.display && record.delivery === 'presentation'
                    ? record.adapter.start(EVENT, this.nowMs, Math.max(0, this.nowMs - startedMs))
                    : record.adapter.start(EVENT, this.display ? this.wallNowMs : this.nowMs);
        } catch (error) {
            const RETRYABLE = !this.display || record.state === 'starting';
            if (this.display && RETRYABLE) {
                record.state = 'pending';
                record.finishDuringStart = false;
            }
            if (!this.disposed && RETRYABLE && this.display && record.delivery === 'presentation') {
                this.awaitingPresentation.add(record);
            } else if (!this.disposed && RETRYABLE && record.confirmed) {
                this.confirmationDirty = true;
                this.awaitingConfirmation.add(record);
            }
            throw error;
        }
        if (this.display && record.state !== 'starting') {
            // The adapter may synchronously hide, roll back or dispose the journal.
            // That transition occurred before the returned resource existed.
            record.adapter.stop?.(handle, record.state, EVENT);
            return;
        }
        record.handle = handle;
        record.startedMs = startedMs;
        if (this.display && record.delivery === 'presentation') {
            record.lastAgeMs = Math.max(0, this.nowMs - startedMs);
        }
        record.state = 'active';
        this.awaitingPresentation?.delete(record);
        this.active.add(record);
        this.stats.started++;
        if (record.durationMs === 0 || record.finishDuringStart) {
            this._stop(record, 'expired');
            this.stats.expired++;
        }
    }
    _release(record) {
        if (
            !record.confirmed ||
            record.state === 'active' ||
            record.state === 'pending' ||
            record.state === 'starting'
        ) {
            return;
        }
        const { tick: TICK } = record.event;
        if (!record.compacted) {
            const {
                sequence: SEQUENCE,
                entityId: ENTITY_ID,
                generation: GENERATION,
                kind: KIND,
                policy: POLICY,
            } = record.event;
            record.event = {
                tick: TICK,
                sequence: SEQUENCE,
                entityId: ENTITY_ID,
                generation: GENERATION,
                kind: KIND,
                policy: POLICY,
            };
            record.handle = undefined;
            record.compacted = true;
            // A compacted record enters its terminal tick bucket exactly once.
            if (TICK > this.confirmedTick - this.retentionTicks) {
                let bucket = this.collectibleTicks.get(TICK);
                if (!bucket) {
                    this.collectibleTicks.set(TICK, (bucket = []));
                }
                bucket.push(record);
            }
        }
        if (TICK <= this.confirmedTick - this.retentionTicks && this.records.delete(record.key)) {
            this.stats.collected++;
        }
    }
    _stop(record, reason) {
        this.awaitingPresentation?.delete(record);
        if (record.state === 'active') {
            record.state = reason;
            this.active.delete(record);
            try {
                record.adapter.stop?.(record.handle, reason, record.event);
            } finally {
                record.handle = undefined;
                this._release(record);
            }
        } else {
            record.state = reason;
            this._release(record);
        }
    }
    emit(event) {
        this._ready();
        const KEY = presentationEventKey(event),
            ADAPTER = this.adapters.get(event.kind);
        if (!ADAPTER) {
            throw new RangeError(`unknown presentation kind: ${event.kind}`);
        }
        const POLICY = event.policy ?? 'confirmed';
        if (POLICY !== 'confirmed' && POLICY !== 'speculative') {
            throw new RangeError('policy must be confirmed or speculative');
        }
        if (POLICY === 'speculative' && ADAPTER.reversible !== true) {
            throw new Error('speculation requires reversible resources; played one-shot sounds cannot be unplayed');
        }
        let delivery = null,
            requestedDuration = event.durationMs,
            phase = 1;
        if (this.display) {
            const CLASSIFICATION = this.display.classify ? this.display.classify(event) : null;
            if (
                this.display.classify &&
                (!CLASSIFICATION || typeof CLASSIFICATION !== 'object' || Array.isArray(CLASSIFICATION))
            ) {
                throw new TypeError('display.classify must return an object');
            }
            delivery = CLASSIFICATION?.delivery ?? 'presentation';
            if (delivery !== 'presentation' && delivery !== 'confirmation') {
                throw new RangeError('display delivery must be presentation or confirmation');
            }
            if (CLASSIFICATION?.durationMs !== undefined) {
                requestedDuration = CLASSIFICATION.durationMs;
            }
            if (CLASSIFICATION?.phase !== undefined) {
                phase = CLASSIFICATION.phase;
            }
        }
        const DELIVERY = delivery,
            REQUESTED_DURATION = requestedDuration;
        if (this.display && (!Number.isFinite(phase) || phase < 0 || phase > 1 || (event.tick === 0 && phase !== 1))) {
            throw new RangeError('display phase must be between zero and one within a positive tick');
        }
        const EVENT_TIME = this.display ? (event.tick - 1 + phase) * this.display.stepMs : null;
        if (this.display && !Number.isFinite(EVENT_TIME)) {
            throw new RangeError('display event time must be finite');
        }
        const DURATION_MS =
            REQUESTED_DURATION === undefined || (this.display && REQUESTED_DURATION === Infinity)
                ? Infinity
                : TIME(REQUESTED_DURATION, 'durationMs');
        if (DELIVERY === 'confirmation' && (POLICY !== 'confirmed' || DURATION_MS !== 0)) {
            throw new Error('confirmation delivery requires a confirmed one-shot event');
        }
        if (this.rollbackFrom !== null && event.tick < this.rollbackFrom) {
            throw new RangeError('resimulation event precedes rollback range');
        }
        if (event.tick <= this.confirmedTick - this.retentionTicks) {
            this.stats.rejectedOld++;
            return false;
        }
        let record = this.records.get(KEY);
        if (record) {
            if (record.policy !== POLICY || (this.display && record.delivery !== DELIVERY)) {
                throw new Error('event policy cannot change for a stable identity');
            }
            record.seen = true;
            this.stats.duplicates++;
            if (!record.confirmed) {
                const PREVIOUS = record.event;
                record.event = {
                    ...event,
                    policy: POLICY,
                };
                record.durationMs = DURATION_MS;
                if (this.display) {
                    record.presentationTimeMs = EVENT_TIME;
                }
                if (record.state === 'cancelled') {
                    record.state = 'pending';
                    if (POLICY === 'speculative' && this.display) {
                        if (this.display.active) {
                            this.awaitingPresentation.add(record);
                        } else {
                            record.state = 'cancelled';
                        }
                    } else if (POLICY === 'speculative') {
                        this._start(record);
                    }
                } else if (record.state === 'active') {
                    ADAPTER.reconcile?.(record.handle, record.event, PREVIOUS, this.nowMs);
                    if (this.display && record.delivery === 'presentation') {
                        record.startedMs = EVENT_TIME;
                    }
                } else if (record.state === 'pending' && POLICY === 'speculative' && this.display) {
                    if (this.display.active) {
                        this.awaitingPresentation.add(record);
                    } else {
                        record.state = 'cancelled';
                    }
                } else if (record.state === 'pending' && POLICY === 'speculative') {
                    this._start(record);
                }
            }
            if (record.confirmed && record.state === 'pending' && this.display && record.delivery === 'confirmation') {
                this._start(record);
            } else if (record.confirmed && record.state === 'pending' && this.display) {
                if (this.display.active) {
                    this.awaitingPresentation.add(record);
                } else {
                    this._stop(record, 'hidden');
                }
            } else if (record.confirmed && record.state === 'pending') {
                this._start(record);
            }
            return false;
        }
        if (this.records.size >= this.maxPending) {
            throw new RangeError(
                'presentation journal capacity exceeded; confirm/collect or increase capacity explicitly',
            );
        }
        record = {
            key: KEY,
            event: {
                ...event,
                policy: POLICY,
            },
            adapter: ADAPTER,
            policy: POLICY,
            durationMs: DURATION_MS,
            confirmed: event.tick <= this.confirmedTick,
            state: 'pending',
            handle: undefined,
            startedMs: 0,
            seen: true,
            compacted: false,
        };
        if (this.display) {
            record.delivery = DELIVERY;
            record.presentationTimeMs = EVENT_TIME;
        }
        this.records.set(KEY, record);
        if (!record.confirmed) {
            this.awaitingConfirmation.add(record);
        }
        if (record.confirmed && this.display && DELIVERY === 'confirmation') {
            this._start(record);
        } else if ((POLICY === 'speculative' || record.confirmed) && this.display) {
            if (this.display.active) {
                this.awaitingPresentation.add(record);
            } else if (record.confirmed) {
                this._stop(record, 'hidden');
            } else {
                record.state = 'cancelled';
            }
        } else if (POLICY === 'speculative' || record.confirmed) {
            this._start(record);
        }
        return true;
    }
    beginRollback(fromTick) {
        this._ready();
        INTEGER(fromTick, 'fromTick');
        if (this.rollbackFrom !== null) {
            throw new Error('rollback already active');
        }
        if (fromTick <= this.confirmedTick) {
            throw new RangeError('cannot rollback confirmed presentation');
        }
        this.rollbackFrom = fromTick;
        for (const RECORD of this.awaitingConfirmation) {
            if (RECORD.event.tick >= fromTick && !RECORD.confirmed) {
                RECORD.seen = false;
            }
        }
    }
    endRollback() {
        this._ready();
        if (this.rollbackFrom === null) {
            throw new Error('no rollback active');
        }
        this.rollbackFrom = null;
        const ERRORS = [];
        for (const RECORD of this.awaitingConfirmation) {
            if (!RECORD.seen && !RECORD.confirmed && RECORD.state !== 'cancelled') {
                try {
                    this._stop(RECORD, 'cancelled');
                } catch (error) {
                    ERRORS.push(error);
                }
                this.stats.cancelled++;
            }
        }
        if (ERRORS.length) {
            throw new AggregateError(ERRORS, 'rollback resource cleanup failed');
        }
    }
    confirmThrough(tick) {
        this._ready();
        INTEGER(tick, 'tick');
        if (this.rollbackFrom !== null) {
            throw new Error('finish rollback before confirmation');
        }
        if (tick < this.confirmedTick) {
            throw new RangeError('confirmed tick cannot regress');
        }
        if (tick === this.confirmedTick && !this.confirmationDirty) {
            return;
        }
        // An interrupted pass or a failed late start must remain retryable at the same watermark.
        this.confirmedTick = tick;
        this.confirmationDirty = true;
        for (const RECORD of this.awaitingConfirmation) {
            if (RECORD.event.tick <= tick) {
                const WAS_CONFIRMED = RECORD.confirmed;
                RECORD.confirmed = true;
                if (RECORD.state === 'starting' && this.display && !WAS_CONFIRMED) {
                    RECORD.confirmOnStart = true;
                } else if (RECORD.state === 'pending' && this.display && RECORD.delivery === 'confirmation') {
                    this._start(RECORD);
                } else if (RECORD.state === 'pending' && this.display && !this.display.active) {
                    this._stop(RECORD, 'hidden');
                } else if (RECORD.state === 'pending' && this.display) {
                    RECORD.confirmOnStart = !WAS_CONFIRMED;
                    this.awaitingPresentation.add(RECORD);
                } else if (RECORD.state === 'pending') {
                    this._start(RECORD);
                }
                if (this.display && RECORD.state === 'active' && (!WAS_CONFIRMED || RECORD.confirmOnStart)) {
                    RECORD.confirmOnStart = true;
                    RECORD.adapter.confirm?.(RECORD.handle, RECORD.event);
                    RECORD.confirmOnStart = false;
                } else if (!WAS_CONFIRMED && RECORD.state === 'active') {
                    RECORD.adapter.confirm?.(RECORD.handle, RECORD.event);
                }
                this._release(RECORD);
                this.awaitingConfirmation.delete(RECORD);
            }
        }
        this.collect();
        this.confirmationDirty = false;
    }
    update(nowMs) {
        this._ready();
        TIME(nowMs, 'nowMs');
        if (this.display) {
            if (nowMs < this.wallNowMs) {
                throw new RangeError('confirmation clock must be monotonic');
            }
            this.wallNowMs = nowMs;
            return;
        }
        if (nowMs < this.nowMs) {
            throw new RangeError('presentation clock must be monotonic');
        }
        this.nowMs = nowMs;
        this.wallNowMs = nowMs;
        for (const RECORD of this.active) {
            const AGE_MS = nowMs - RECORD.startedMs;
            if (AGE_MS >= RECORD.durationMs) {
                this._stop(RECORD, 'expired');
                this.stats.expired++;
            } else {
                RECORD.adapter.update?.(RECORD.handle, AGE_MS, RECORD.event);
            }
        }
    }
    /** Advance display-scheduled resources on the same simulation-time frame as interpolated models. */
    present(frame) {
        this._ready();
        if (this.presenting) {
            throw new Error('presentation frame is already being processed');
        }
        this.presenting = true;
        try {
            return this._present(frame);
        } finally {
            this.presenting = false;
        }
    }
    _present(frame) {
        if (!this.display) {
            throw new Error('present(frame) requires a display-scheduled journal');
        }
        if (!this.display.active) {
            return;
        }
        // The interpolation runtime exposes an uninitialized frame before its first capture.
        if (frame?.revision === -1 && frame.timeMs === null) {
            return;
        }
        if (!frame || !Number.isFinite(frame.timeMs)) {
            throw new TypeError('display frame.timeMs must be finite');
        }
        INTEGER(frame.revision, 'display frame.revision');
        const DISPLAY = this.display;
        if (
            frame.revision < DISPLAY.revision ||
            (frame.revision === DISPLAY.revision && frame.timeMs < DISPLAY.timeMs)
        ) {
            throw new RangeError('display time and revision must not regress within an epoch');
        }
        if (frame.revision > DISPLAY.revision && frame.timeMs < DISPLAY.timeMs) {
            // A presentation reset/rollback can rewind display without revoking confirmed
            // authority. Release effects from the old display epoch but retain their IDs.
            const ERRORS = [];
            for (const RECORD of this.active) {
                try {
                    this._stop(RECORD, 'timeline-reset');
                } catch (error) {
                    ERRORS.push(error);
                } finally {
                    if (!RECORD.confirmed && RECORD.state === 'timeline-reset') {
                        RECORD.state = 'cancelled';
                    }
                }
            }
            if (ERRORS.length === 1) {
                throw ERRORS[0];
            }
            if (ERRORS.length) {
                throw new AggregateError(ERRORS, 'presentation epoch cleanup failed');
            }
        }
        DISPLAY.revision = frame.revision;
        DISPLAY.timeMs = frame.timeMs;
        this.nowMs = Math.max(0, frame.timeMs);
        if (frame.timeMs < 0) {
            return;
        }
        for (const RECORD of this.active) {
            if (RECORD.confirmOnStart) {
                RECORD.adapter.confirm?.(RECORD.handle, RECORD.event);
                RECORD.confirmOnStart = false;
            }
            if (this.disposed || !this.display.active) {
                return;
            }
            if (RECORD.state !== 'active') {
                continue;
            }
            const AGE_MS = Math.max(RECORD.lastAgeMs ?? 0, frame.timeMs - RECORD.startedMs);
            RECORD.lastAgeMs = AGE_MS;
            if (AGE_MS >= RECORD.durationMs) {
                this._stop(RECORD, 'expired');
                this.stats.expired++;
            } else {
                RECORD.adapter.update?.(RECORD.handle, AGE_MS, RECORD.event);
            }
        }
        if (this.disposed || !this.display.active) {
            return;
        }
        if (this.awaitingPresentation.size === 0) {
            return;
        }
        // Due records in presentation order, in a reused list per nesting depth (an adapter callback may run another
        // update). Stable insertion by (time, tick, sequence) gives the order of the former filter and stable sort.
        const DEPTH = this.dueDepth++,
            DUE = (this.dueLists[DEPTH] ??= []);
        try {
            DUE.length = 0;
            for (const RECORD of this.awaitingPresentation) {
                const EVENT_MS = RECORD.presentationTimeMs;
                // Both tick→time and presentation clock arithmetic can round at fractional TPS.
                const ROUNDING =
                    Math.max(Math.abs(EVENT_MS), Math.abs(frame.timeMs), DISPLAY.stepMs) * Number.EPSILON * 4;
                if (EVENT_MS <= frame.timeMs + ROUNDING) {
                    let at = DUE.length;
                    DUE.push(RECORD);
                    while (at > 0 && compareDue(DUE[at - 1], RECORD) > 0) {
                        DUE[at] = DUE[at - 1];
                        at--;
                    }
                    DUE[at] = RECORD;
                }
            }
            for (const RECORD of DUE) {
                if (this.disposed || !this.display.active) {
                    return;
                }
                if (!this.awaitingPresentation.has(RECORD)) {
                    continue;
                }
                const EVENT_MS = RECORD.presentationTimeMs,
                    AGE_MS = Math.max(0, frame.timeMs - EVENT_MS);
                if (AGE_MS > DISPLAY.maxLatenessMs || (RECORD.durationMs > 0 && AGE_MS >= RECORD.durationMs)) {
                    this._stop(RECORD, 'expired');
                    this.stats.expired++;
                    continue;
                }
                this._start(RECORD, EVENT_MS);
                if (this.disposed || !this.display.active) {
                    return;
                }
                if (RECORD.state === 'active' && RECORD.confirmOnStart) {
                    RECORD.adapter.confirm?.(RECORD.handle, RECORD.event);
                    RECORD.confirmOnStart = false;
                }
                if (RECORD.state === 'active' && AGE_MS > 0) {
                    RECORD.adapter.update?.(RECORD.handle, AGE_MS, RECORD.event);
                }
            }
        } finally {
            DUE.length = 0;
            this.dueDepth--;
        }
    }
    /** Adapter reports a naturally completed audio/particle resource without discarding its dedup identity. */
    finish(event) {
        this._ready();
        const RECORD = this.records.get(presentationEventKey(event));
        if (this.display && RECORD?.state === 'starting' && !RECORD.finishDuringStart) {
            RECORD.finishDuringStart = true;
            return true;
        }
        if (!RECORD || RECORD.state !== 'active') {
            return false;
        }
        this._stop(RECORD, 'expired');
        this.stats.expired++;
        return true;
    }
    collect() {
        this._ready();
        const CUTOFF = this.confirmedTick - this.retentionTicks;
        for (const [TICK, BUCKET] of this.collectibleTicks) {
            if (TICK <= CUTOFF) {
                for (const RECORD of BUCKET) {
                    if (this.records.delete(RECORD.key)) {
                        this.stats.collected++;
                    }
                }
                this.collectibleTicks.delete(TICK);
            }
        }
    }
    get size() {
        return this.records.size;
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const ERRORS = [];
        for (const RECORD of this.records.values()) {
            try {
                this._stop(RECORD, 'disposed');
            } catch (error) {
                ERRORS.push(error);
            }
        }
        this.records.clear();
        this.active.clear();
        this.awaitingConfirmation.clear();
        this.awaitingPresentation?.clear();
        this.collectibleTicks.clear();
        this.rollbackFrom = null;
        if (ERRORS.length) {
            throw new AggregateError(ERRORS, 'presentation cleanup failed');
        }
    }
}
