function names(values) {
    if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length) {
        throw new RangeError('Expected at most 128 unique metric names');
    }
    for (const NAME of values) {
        if (typeof NAME !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(NAME)) {
            throw new TypeError('Invalid metric name');
        }
    }
    return Object.freeze(values.slice());
}
function summary(values) {
    const SORTED = values.slice().sort((a, b) => a - b),
        TOTAL = values.reduce((sum, value) => sum + value, 0),
        COUNT = values.length;
    return {
        count: COUNT,
        total: TOTAL,
        mean: COUNT ? TOTAL / COUNT : 0,
        p50: COUNT ? SORTED[Math.floor((COUNT - 1) * 0.5)] : 0,
        p95: COUNT ? SORTED[Math.floor((COUNT - 1) * 0.95)] : 0,
        max: COUNT ? SORTED[COUNT - 1] : 0,
    };
}

/**
 * Fixed-layout numeric frame ring. Register names once; recording reuses typed arrays.
 * No metadata, state snapshots, JSON, network or logs. snapshot() allocates only on demand.
 * Durations are CPU wall milliseconds; GPU completion is never inferred.
 */
export class FrameMetrics {
    constructor({ capacity = 240, stages = [], counters = [], now = () => performance.now() } = {}) {
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3600 || typeof now !== 'function') {
            throw new RangeError('Invalid frame metric capacity or clock');
        }
        this.capacity = capacity;
        this.stages = names(stages);
        this.counters = names(counters);
        this.stageIndex = new Map(this.stages.map((name, index) => [name, index + 3]));
        this.counterIndex = new Map(this.counters.map((name, index) => [name, index + 3 + this.stages.length]));
        this.stride = 3 + this.stages.length + this.counters.length;
        this.samples = new Float64Array(this.stride * capacity);
        this.current = new Float64Array(this.stride);
        this.now = now;
        this.clear();
    }
    clear() {
        this.size = 0;
        this.write = 0;
        this.sequence = 0;
        this.lastTimestampMs = null;
        this.active = false;
        this.samples.fill(0);
        this.current.fill(0);
    }
    beginFrame(timestampMs) {
        if (!Number.isFinite(timestampMs) || (this.lastTimestampMs !== null && timestampMs < this.lastTimestampMs)) {
            throw new RangeError('Frame timestamp must be finite and monotonic');
        }
        if (this.active) {
            throw new Error('endFrame required');
        }
        this.current.fill(0);
        this.current[0] = timestampMs;
        if (this.size > 0 && this.lastTimestampMs !== null) {
            const PREVIOUS = ((this.write - 1 + this.capacity) % this.capacity) * this.stride;
            this.samples[PREVIOUS + 1] = timestampMs - this.lastTimestampMs;
        }
        this.lastTimestampMs = timestampMs;
        this.startedAtMs = this.now();
        this.active = true;
    }
    stage(name, durationMs) {
        return this.record(this.stageIndex, name, durationMs);
    }
    count(name, amount = 1) {
        return this.record(this.counterIndex, name, amount);
    }
    record(index, name, value) {
        const COLUMN = index.get(name);
        if ((!this.active && this.size === 0) || COLUMN === undefined) {
            return false;
        }
        if (!Number.isFinite(value) || value < 0) {
            throw new RangeError('Metric values must be finite and non-negative');
        }
        if (this.active) {
            this.current[COLUMN] += value;
        } else {
            const PREVIOUS = ((this.write - 1 + this.capacity) % this.capacity) * this.stride;
            this.samples[PREVIOUS + COLUMN] += value;
        }
        return true;
    }
    endFrame() {
        if (!this.active) {
            return false;
        }
        this.current[2] = Math.max(0, this.now() - this.startedAtMs);
        this.samples.set(this.current, this.write * this.stride);
        this.write = (this.write + 1) % this.capacity;
        this.size = Math.min(this.capacity, this.size + 1);
        this.sequence++;
        this.active = false;
        return true;
    }
    snapshot({ limit = 0, slowFrameMs = 50, slowLimit = 3 } = {}) {
        if (
            !Number.isSafeInteger(limit) ||
            limit < 0 ||
            limit > this.capacity ||
            !Number.isSafeInteger(slowLimit) ||
            slowLimit < 0 ||
            slowLimit > this.capacity ||
            !Number.isFinite(slowFrameMs) ||
            slowFrameMs < 0
        ) {
            throw new RangeError('Invalid snapshot limits');
        }
        const FRAMES = [];
        for (let offset = 0; offset < this.size; offset++) {
            const INDEX = ((this.write - this.size + offset + this.capacity) % this.capacity) * this.stride,
                FRAME = {
                    sequence: this.sequence - this.size + offset + 1,
                    timestampMs: this.samples[INDEX],
                    intervalMs: this.samples[INDEX + 1],
                    cpuMs: this.samples[INDEX + 2],
                    stagesMs: {},
                    counts: {},
                };
            for (const [NAME, COLUMN] of this.stageIndex) {
                FRAME.stagesMs[NAME] = this.samples[INDEX + COLUMN];
            }
            for (const [NAME, COLUMN] of this.counterIndex) {
                FRAME.counts[NAME] = this.samples[INDEX + COLUMN];
            }
            FRAMES.push(FRAME);
        }
        const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0),
            WINDOW_MS = INTERVALS.reduce((sum, value) => sum + value, 0);
        return {
            format: 'bloom numeric frame metrics v1',
            capacity: this.capacity,
            retainedFrames: this.size,
            firstSequence: FRAMES[0]?.sequence ?? 0,
            lastSequence: FRAMES.at(-1)?.sequence ?? 0,
            windowMs: WINDOW_MS,
            fps: WINDOW_MS > 0 ? (INTERVALS.length * 1000) / WINDOW_MS : null,
            intervalMs: summary(INTERVALS),
            cpuMs: summary(FRAMES.map((frame) => frame.cpuMs)),
            stagesMs: Object.fromEntries(
                this.stages.map((name) => [name, summary(FRAMES.map((frame) => frame.stagesMs[name]))]),
            ),
            counts: Object.fromEntries(
                this.counters.map((name) => [name, summary(FRAMES.map((frame) => frame.counts[name]))]),
            ),
            slowFrames: FRAMES.filter((frame) => frame.intervalMs >= slowFrameMs)
                .sort((a, b) => b.intervalMs - a.intervalMs)
                .slice(0, slowLimit),
            frames: limit ? FRAMES.slice(-limit) : [],
        };
    }
}
