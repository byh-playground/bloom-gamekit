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
    get oldestTick() {
        return Math.min(...this.records.keys());
    }
    put(state) {
        const OLDEST = Math.max(0, state.tick - this.size + 1);
        const BASE = this.atOrBefore(OLDEST);
        const EXPIRED = [...this.records.values()].filter((s) => BASE && s.tick < BASE.tick);
        const NEXT =
            this.byteLength -
            EXPIRED.reduce((n, s) => n + s.bytes.length, 0) -
            (this.records.get(state.tick)?.bytes.length ?? 0) +
            state.bytes.length;
        if (NEXT > this.maxBytes) {
            throw Object.assign(new RangeError('checkpoint history byte budget'), {
                code: 'history-capacity',
                requiredBytes: NEXT,
                maxHistoryBytes: this.maxBytes,
                snapshotBytes: state.bytes.length,
            });
        }
        for (const S of EXPIRED) {
            this.records.delete(S.tick);
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
