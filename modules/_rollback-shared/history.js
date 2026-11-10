export class StateHistory {
    constructor(size, maxBytes = 64 * 1024 * 1024) {
        this.slots = new Array(size);
        this.size = size;
        this.maxBytes = maxBytes;
        this.byteLength = 0;
    }
    get(tick) {
        const S = this.slots[tick % this.size];
        return S?.tick === tick ? S : undefined;
    }
    put(state) {
        const I = state.tick % this.size,
            NEXT = this.byteLength - (this.slots[I]?.bytes.length ?? 0) + state.bytes.length;
        if (NEXT > this.maxBytes) {
            throw Object.assign(new RangeError('state history byte budget'), {
                code: 'history-capacity',
                requiredBytes: NEXT,
                maxHistoryBytes: this.maxBytes,
                snapshotBytes: state.bytes.length,
            });
        }
        this.slots[I] = state;
        this.byteLength = NEXT;
    }
    invalidateAfter(tick) {
        for (let i = 0; i < this.size; i++) {
            if (this.slots[i]?.tick > tick) {
                this.byteLength -= this.slots[i].bytes.length;
                this.slots[i] = undefined;
            }
        }
    }
}

// Lockstep retains only confirmed checksum boundaries, independently of the input
// receipt/ACK window. Keep the checkpoint at/before the window's oldest input so
// every retained recovery base still has a complete replay suffix.
export class CheckpointHistory {
    constructor(size, maxBytes) {
        this.size = size;
        this.maxBytes = maxBytes;
        this.records = new Map();
        this.byteLength = 0;
    }
    get slots() {
        return this.records.values();
    }
    get(tick) {
        return this.records.get(tick);
    }
    atOrBefore(tick) {
        let result;
        for (const STATE of this.records.values()) {
            if (STATE.tick <= tick && (!result || STATE.tick > result.tick)) {
                result = STATE;
            }
        }
        return result;
    }
    /** 보관 중인 가장 이른 tick, 비었으면 Infinity(Math.min()과 같음). */
    get oldestTick() {
        let min = Infinity;
        for (const TICK of this.records.keys()) {
            if (TICK < min) {
                min = TICK;
            }
        }
        return min;
    }
    put(state) {
        const OLDEST = Math.max(0, state.tick - this.size + 1);
        const BASE = this.atOrBefore(OLDEST);
        let expiredBytes = 0;
        if (BASE) {
            for (const S of this.records.values()) {
                if (S.tick < BASE.tick) {
                    expiredBytes += S.bytes.length;
                }
            }
        }
        const NEXT =
            this.byteLength - expiredBytes - (this.records.get(state.tick)?.bytes.length ?? 0) + state.bytes.length;
        if (NEXT > this.maxBytes) {
            throw Object.assign(new RangeError('checkpoint history byte budget'), {
                code: 'history-capacity',
                requiredBytes: NEXT,
                maxHistoryBytes: this.maxBytes,
                snapshotBytes: state.bytes.length,
            });
        }
        if (BASE) {
            for (const TICK of this.records.keys()) {
                if (TICK < BASE.tick) {
                    this.records.delete(TICK);
                }
            }
        }
        this.records.set(state.tick, state);
        this.byteLength = NEXT;
    }
    invalidateAfter(tick) {
        for (const [T, STATE] of this.records) {
            if (T > tick) {
                this.records.delete(T);
                this.byteLength -= STATE.bytes.length;
            }
        }
    }
}
