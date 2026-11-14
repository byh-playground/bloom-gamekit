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
const ROUND_MS = (value) => Math.round(value * 10) / 10,
    ROUND_COUNT = (value) => Math.round(value * 100) / 100,
    /** 중앙값을 내는 최근 간격 수. 60Hz에서 약 0.25초입니다. */
    MEDIAN_WINDOW = 15,
    /** 히치 한 건의 부가 칸: 순번, 그때의 중앙값, 그때의 기준, 함께 복사한 직전 프레임 수. */
    HITCH_INFO = 4,
    /** 추적 한 건의 부가 칸: 첫 행 순번, 표시 프레임 순번, 채운 행 수, 표시 프레임 수, 시작 때 중앙값, 끊김(skipInterval) 여부. */
    TRACE_INFO = 6;

/**
 * Fixed-layout numeric frame ring. Register names once; recording reuses typed arrays.
 * No metadata, state snapshots, JSON, network or logs. snapshot()/hitches()/hitchText()/traces()/traceText() allocate only on demand.
 * Durations are CPU wall milliseconds; GPU completion is never inferred.
 *
 * 프레임 간격이 기준(`hitch.ms` 이상, 또는 최근 15간격 중앙값의 `hitch.medianFactor`배 이상, 단 `hitch.maxMs` 미만)을
 * 넘으면 그 프레임의 행과 직전 `hitch.before`프레임의 행을 따로 잡아 둔 Float64Array 보관함에 복사합니다.
 * 링이 한 바퀴 돌아도 보관함은 최근 `hitch.capacity`건을 유지합니다.
 *
 * `trace.counters` 중 하나라도 0보다 큰 프레임(표시 프레임)이 오면 기준과 무관하게 그 앞 `trace.before`프레임과
 * 뒤 `trace.after`프레임의 행을 별도 보관함(최근 `trace.capacity`건)에 이어 붙입니다. 진행 중에 다시 표시가 오면 새로 시작하지 않고 그 추적에 셉니다.
 */
export class FrameMetrics {
    constructor({
        capacity = 240,
        stages = [],
        counters = [],
        now = () => performance.now(),
        hitch: { capacity: hitchCapacity = 24, ms = 100, medianFactor = 2.5, maxMs = 1000, before = 3 } = {},
        trace: {
            counters: traceCounters = [],
            capacity: traceCapacity = 8,
            before: traceBefore = 2,
            after: traceAfter = 10,
        } = {},
    } = {}) {
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3600 || typeof now !== 'function') {
            throw new RangeError('Invalid frame metric capacity or clock');
        }
        if (
            !Number.isSafeInteger(hitchCapacity) ||
            hitchCapacity < 0 ||
            hitchCapacity > 256 ||
            !Number.isSafeInteger(before) ||
            before < 0 ||
            before > 8 ||
            !(ms > 0) ||
            !(medianFactor > 1) ||
            !(maxMs > 0)
        ) {
            throw new RangeError('Invalid hitch options');
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
        this.hitchRule = Object.freeze({ capacity: hitchCapacity, ms, medianFactor, maxMs, before });
        this.hitchRows = new Float64Array(hitchCapacity * (1 + before) * this.stride);
        this.hitchInfo = new Float64Array(hitchCapacity * HITCH_INFO);
        this.intervalWindow = new Float64Array(MEDIAN_WINDOW);
        this.medianScratch = new Float64Array(MEDIAN_WINDOW);
        const TRACE_NAMES = names(traceCounters);
        if (
            !Number.isSafeInteger(traceCapacity) ||
            traceCapacity < 0 ||
            traceCapacity > 64 ||
            !Number.isSafeInteger(traceBefore) ||
            traceBefore < 0 ||
            traceBefore > 16 ||
            (TRACE_NAMES.length > 0 && traceBefore >= capacity) ||
            !Number.isSafeInteger(traceAfter) ||
            traceAfter < 0 ||
            traceAfter > 120
        ) {
            throw new RangeError('Invalid trace options');
        }
        if (TRACE_NAMES.some((name) => !this.counterIndex.has(name))) {
            throw new TypeError('Trace counters must be registered counters');
        }
        this.traceRule = Object.freeze({
            counters: TRACE_NAMES,
            capacity: TRACE_NAMES.length ? traceCapacity : 0,
            before: traceBefore,
            after: traceAfter,
        });
        this.traceColumns = Int32Array.from(TRACE_NAMES, (name) => this.counterIndex.get(name));
        this.traceRowsPerSlot = traceBefore + 1 + traceAfter;
        this.traceRows = new Float64Array(this.traceRule.capacity * this.traceRowsPerSlot * this.stride);
        this.traceInfo = new Float64Array(this.traceRule.capacity * TRACE_INFO);
        this.clear();
    }
    clear() {
        this.size = 0;
        this.write = 0;
        this.sequence = 0;
        this.lastTimestampMs = null;
        this.active = false;
        this.skipNext = false;
        this.samples.fill(0);
        this.current.fill(0);
        this.hitchSize = 0;
        this.hitchWrite = 0;
        this.hitchTotal = 0;
        this.hitchRows.fill(0);
        this.hitchInfo.fill(0);
        this.windowSize = 0;
        this.windowWrite = 0;
        this.traceSize = 0;
        this.traceWrite = 0;
        this.traceTotal = 0;
        this.traceOpen = -1;
        this.traceRows.fill(0);
        this.traceInfo.fill(0);
    }
    /**
     * 다음 beginFrame이 직전 프레임과 간격을 잇지 않게 합니다(그 간격은 0으로 남고 히치로 세지 않습니다).
     * 탭이 숨겨졌다 돌아올 때(visibilitychange)나 일시 정지에서 다시 시작할 때 부릅니다.
     * 진행 중인 추적은 버리지 않고 그 프레임을 끊김(`gap`)으로 표시합니다.
     */
    skipInterval() {
        this.skipNext = true;
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
        if (this.size > 0) {
            const PREVIOUS = ((this.write - 1 + this.capacity) % this.capacity) * this.stride,
                LINKED = this.lastTimestampMs !== null && !this.skipNext,
                INTERVAL = LINKED ? timestampMs - this.lastTimestampMs : 0;
            if (LINKED) {
                this.samples[PREVIOUS + 1] = INTERVAL;
            }
            if (this.traceRule.capacity) {
                this.traceFrame(PREVIOUS, !LINKED);
            }
            if (LINKED) {
                this.judgeInterval(INTERVAL);
            }
        }
        this.skipNext = false;
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
    /** 방금 확정한 직전 프레임(순번 this.sequence)의 간격을 판정하고, 넘으면 그 행과 직전 행들을 보관함에 복사합니다. */
    judgeInterval(intervalMs) {
        const RULE = this.hitchRule;
        if (intervalMs >= RULE.maxMs) {
            return;
        }
        const MEDIAN = this.medianInterval(),
            THRESHOLD = MEDIAN > 0 ? Math.min(RULE.ms, MEDIAN * RULE.medianFactor) : RULE.ms;
        this.intervalWindow[this.windowWrite] = intervalMs;
        this.windowWrite = (this.windowWrite + 1) % MEDIAN_WINDOW;
        this.windowSize = Math.min(MEDIAN_WINDOW, this.windowSize + 1);
        if (intervalMs < THRESHOLD || RULE.capacity === 0) {
            return;
        }
        const { stride: STRIDE, capacity: CAPACITY } = this,
            BEFORE = Math.min(RULE.before, this.size - 1),
            SLOT = this.hitchWrite,
            ROWS = SLOT * (1 + RULE.before) * STRIDE;
        for (let row = 0; row <= BEFORE; row++) {
            const SOURCE = ((this.write - 1 - row + CAPACITY * 2) % CAPACITY) * STRIDE,
                TARGET = ROWS + row * STRIDE;
            for (let column = 0; column < STRIDE; column++) {
                this.hitchRows[TARGET + column] = this.samples[SOURCE + column];
            }
        }
        const INFO = SLOT * HITCH_INFO;
        this.hitchInfo[INFO] = this.sequence;
        this.hitchInfo[INFO + 1] = MEDIAN;
        this.hitchInfo[INFO + 2] = THRESHOLD;
        this.hitchInfo[INFO + 3] = BEFORE;
        this.hitchWrite = (SLOT + 1) % RULE.capacity;
        this.hitchSize = Math.min(RULE.capacity, this.hitchSize + 1);
        this.hitchTotal++;
    }
    /**
     * 간격이 확정된 직전 프레임(순번 this.sequence, 링 위치 row)을 추적에 넣습니다. 진행 중이면 이어 붙이고,
     * 아니면 표시 counter가 0보다 클 때 앞 프레임들과 함께 새 추적을 엽니다. 숫자 복사뿐이라 할당이 없습니다.
     */
    traceFrame(row, gap) {
        const RULE = this.traceRule,
            { stride: STRIDE, capacity: CAPACITY } = this;
        let marked = false;
        for (let index = 0; index < this.traceColumns.length; index++) {
            if (this.samples[row + this.traceColumns[index]] > 0) {
                marked = true;
                break;
            }
        }
        let slot = this.traceOpen;
        if (slot < 0) {
            if (!marked) {
                return;
            }
            slot = this.traceWrite;
            const BEFORE = Math.min(RULE.before, this.size - 1),
                ROWS = slot * this.traceRowsPerSlot * STRIDE;
            for (let back = BEFORE; back >= 1; back--) {
                const SOURCE = ((this.write - 1 - back + CAPACITY * 2) % CAPACITY) * STRIDE,
                    TARGET = ROWS + (BEFORE - back) * STRIDE;
                for (let column = 0; column < STRIDE; column++) {
                    this.traceRows[TARGET + column] = this.samples[SOURCE + column];
                }
            }
            const INFO = slot * TRACE_INFO;
            this.traceInfo[INFO] = this.sequence - BEFORE;
            this.traceInfo[INFO + 1] = this.sequence;
            this.traceInfo[INFO + 2] = BEFORE;
            this.traceInfo[INFO + 3] = 0;
            this.traceInfo[INFO + 4] = this.medianInterval();
            this.traceInfo[INFO + 5] = 0;
            this.traceOpen = slot;
            this.traceWrite = (slot + 1) % RULE.capacity;
            this.traceSize = Math.min(RULE.capacity, this.traceSize + 1);
            this.traceTotal++;
        }
        const INFO = slot * TRACE_INFO,
            FILLED = this.traceInfo[INFO + 2],
            TARGET = (slot * this.traceRowsPerSlot + FILLED) * STRIDE;
        for (let column = 0; column < STRIDE; column++) {
            this.traceRows[TARGET + column] = this.samples[row + column];
        }
        this.traceInfo[INFO + 2] = FILLED + 1;
        if (marked) {
            this.traceInfo[INFO + 3]++;
        }
        if (gap) {
            this.traceInfo[INFO + 5] = 1;
        }
        if (this.sequence - this.traceInfo[INFO + 1] >= RULE.after) {
            this.traceOpen = -1;
        }
    }
    /** 최근 15간격이 다 차면 그 중앙값, 아니면 0. 고정 배열 삽입 정렬이라 할당이 없습니다. */
    medianInterval() {
        if (this.windowSize < MEDIAN_WINDOW) {
            return 0;
        }
        const SORTED = this.medianScratch;
        for (let index = 0; index < MEDIAN_WINDOW; index++) {
            const VALUE = this.intervalWindow[index];
            let at = index;
            while (at > 0 && SORTED[at - 1] > VALUE) {
                SORTED[at] = SORTED[at - 1];
                at--;
            }
            SORTED[at] = VALUE;
        }
        return SORTED[MEDIAN_WINDOW >> 1];
    }
    readRow(source, offset, sequence) {
        const FRAME = {
            sequence,
            timestampMs: source[offset],
            intervalMs: source[offset + 1],
            cpuMs: source[offset + 2],
            stagesMs: {},
            counts: {},
        };
        for (const [NAME, COLUMN] of this.stageIndex) {
            FRAME.stagesMs[NAME] = source[offset + COLUMN];
        }
        for (const [NAME, COLUMN] of this.counterIndex) {
            FRAME.counts[NAME] = source[offset + COLUMN];
        }
        return FRAME;
    }
    /** 보관한 히치를 오래된 것부터. `before`는 직전 프레임들(오래된 것부터)입니다. 부를 때만 할당합니다. */
    hitches() {
        const RULE = this.hitchRule,
            RESULT = [];
        for (let offset = 0; offset < this.hitchSize; offset++) {
            const SLOT = (this.hitchWrite - this.hitchSize + offset + RULE.capacity) % RULE.capacity,
                INFO = SLOT * HITCH_INFO,
                SEQUENCE = this.hitchInfo[INFO],
                ROWS = SLOT * (1 + RULE.before) * this.stride,
                HITCH = this.readRow(this.hitchRows, ROWS, SEQUENCE),
                BEFORE = [];
            for (let row = this.hitchInfo[INFO + 3]; row >= 1; row--) {
                BEFORE.push(this.readRow(this.hitchRows, ROWS + row * this.stride, SEQUENCE - row));
            }
            HITCH.medianMs = this.hitchInfo[INFO + 1];
            HITCH.thresholdMs = this.hitchInfo[INFO + 2];
            HITCH.before = BEFORE;
            RESULT.push(HITCH);
        }
        return RESULT;
    }
    /**
     * 진단 글에 붙일 짧은 여러 줄. 첫 줄은 기준과 건수, 히치 한 건은 두 줄(그 프레임, 직전 프레임들)입니다.
     * 0인 stage·counter는 적지 않습니다. `limit`은 최근 몇 건만 적을지입니다.
     */
    hitchText({ limit = this.hitchRule.capacity } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new RangeError('Invalid hitch text limit');
        }
        const RULE = this.hitchRule,
            VALUES = (frame) => {
                const PARTS = [];
                for (const NAME of this.stages) {
                    if (frame.stagesMs[NAME] > 0) {
                        PARTS.push(`${NAME}=${ROUND_MS(frame.stagesMs[NAME])}`);
                    }
                }
                for (const NAME of this.counters) {
                    if (frame.counts[NAME] > 0) {
                        PARTS.push(`${NAME}=${ROUND_COUNT(frame.counts[NAME])}`);
                    }
                }
                return PARTS.length ? ' ' + PARTS.join(' ') : '';
            },
            LINES = [
                `hitches ${this.hitchTotal} (kept ${this.hitchSize}/${RULE.capacity}) rule >=${RULE.ms}ms or >=${RULE.medianFactor}x median, <${RULE.maxMs}ms; now t=${(this.now() / 1000).toFixed(1)}s`,
            ];
        for (const HITCH of limit ? this.hitches().slice(-limit) : []) {
            LINES.push(
                `#${HITCH.sequence} t=${(HITCH.timestampMs / 1000).toFixed(1)}s ${ROUND_MS(HITCH.intervalMs)}ms (median ${ROUND_MS(HITCH.medianMs)}) cpu=${ROUND_MS(HITCH.cpuMs)}${VALUES(HITCH)}`,
            );
            if (HITCH.before.length) {
                LINES.push(
                    '  before ' +
                        HITCH.before
                            .map((frame) => `#${frame.sequence} ${ROUND_MS(frame.intervalMs)}ms${VALUES(frame)}`)
                            .join(' | '),
                );
            }
        }
        return LINES.join('\n');
    }
    /**
     * 보관한 추적을 오래된 것부터. `frames`는 앞 프레임·표시 프레임·뒤 프레임 순이고 `offset`은 표시 프레임 기준 상대 순번입니다.
     * `medianMs`는 표시 때 최근 15간격 중앙값(15간격이 안 모였으면 추적 안 간격의 중앙값)입니다. 부를 때만 할당합니다.
     */
    traces() {
        const RULE = this.traceRule,
            RESULT = [];
        for (let offset = 0; offset < this.traceSize; offset++) {
            const SLOT = (this.traceWrite - this.traceSize + offset + RULE.capacity) % RULE.capacity,
                INFO = SLOT * TRACE_INFO,
                FIRST = this.traceInfo[INFO],
                MARK = this.traceInfo[INFO + 1],
                FRAMES = [];
            for (let row = 0; row < this.traceInfo[INFO + 2]; row++) {
                const FRAME = this.readRow(
                    this.traceRows,
                    (SLOT * this.traceRowsPerSlot + row) * this.stride,
                    FIRST + row,
                );
                FRAME.offset = FIRST + row - MARK;
                FRAMES.push(FRAME);
            }
            const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0),
                MEDIAN = this.traceInfo[INFO + 4] || summary(INTERVALS).p50,
                MAX = INTERVALS.length ? Math.max(...INTERVALS) : 0;
            RESULT.push({
                sequence: MARK,
                timestampMs: FRAMES.find((frame) => frame.offset === 0).timestampMs,
                marks: this.traceInfo[INFO + 3],
                open: SLOT === this.traceOpen,
                gap: this.traceInfo[INFO + 5] === 1,
                medianMs: MEDIAN,
                maxIntervalMs: MAX,
                maxFactor: MEDIAN > 0 ? MAX / MEDIAN : 0,
                doubledIntervals: MEDIAN > 0 ? INTERVALS.filter((value) => value >= MEDIAN * 2).length : 0,
                frames: FRAMES,
            });
        }
        return RESULT;
    }
    /**
     * 진단 글에 붙일 짧은 여러 줄. 첫 줄은 설정과 건수, 추적 한 건은 두 줄(요약, 프레임 토막)입니다.
     * 토막은 `상대순번 간격ms cpu=…`와 0이 아닌 stage, 0보다 큰 표시 counter입니다. 나머지 counter는 추적 안에서 값이 늘 같으면
     * 요약 줄 `fixed`에 한 번(0이면 생략), 아니면 첫 프레임(0이 아닐 때)과 값이 바뀐 프레임에만 적습니다. `limit`은 최근 몇 건만 적을지입니다.
     */
    traceText({ limit = this.traceRule.capacity } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new RangeError('Invalid trace text limit');
        }
        const RULE = this.traceRule,
            LINES = [
                `traces ${this.traceTotal} (kept ${this.traceSize}/${RULE.capacity}) on ${RULE.counters.join(',') || '-'} before ${RULE.before} after ${RULE.after}; frame = offset intervalMs(to next frame) cpu stages counters`,
            ];
        for (const TRACE of limit ? this.traces().slice(-limit) : []) {
            const FIRST = TRACE.frames[0],
                FIXED = this.counters.filter(
                    (name) =>
                        !RULE.counters.includes(name) &&
                        TRACE.frames.every((frame) => frame.counts[name] === FIRST.counts[name]),
                ),
                MARK = TRACE.frames.find((frame) => frame.offset === 0),
                FIXED_TEXT = FIXED.filter((name) => FIRST.counts[name] > 0)
                    .map((name) => `${name}=${ROUND_COUNT(FIRST.counts[name])}`)
                    .join(' '),
                STATE = [
                    TRACE.marks > 1 ? ` marks=${TRACE.marks}` : '',
                    TRACE.open ? ` open ${TRACE.frames.at(-1).offset}/${RULE.after}` : '',
                    TRACE.gap ? ' gap' : '',
                    FIXED_TEXT ? ` | fixed ${FIXED_TEXT}` : '',
                ].join('');
            LINES.push(
                `#${TRACE.sequence} ${RULE.counters.filter((name) => MARK.counts[name] > 0).join(',')} t=${(TRACE.timestampMs / 1000).toFixed(1)}s max ${ROUND_MS(TRACE.maxIntervalMs)}ms = ${ROUND_COUNT(TRACE.maxFactor)}x median ${ROUND_MS(TRACE.medianMs)}, >=2x ${TRACE.doubledIntervals}${STATE}`,
                '  ' +
                    TRACE.frames
                        .map((frame, index) => {
                            const PREVIOUS = TRACE.frames[index - 1],
                                PARTS = [
                                    `${frame.offset > 0 ? '+' : ''}${frame.offset}`,
                                    frame.intervalMs > 0 ? `${ROUND_MS(frame.intervalMs)}` : 'gap',
                                    `cpu=${ROUND_MS(frame.cpuMs)}`,
                                ];
                            for (const NAME of this.stages) {
                                if (frame.stagesMs[NAME] > 0) {
                                    PARTS.push(`${NAME}=${ROUND_MS(frame.stagesMs[NAME])}`);
                                }
                            }
                            for (const NAME of this.counters) {
                                const VALUE = frame.counts[NAME];
                                if (
                                    RULE.counters.includes(NAME)
                                        ? VALUE > 0
                                        : !FIXED.includes(NAME) &&
                                          (PREVIOUS ? VALUE !== PREVIOUS.counts[NAME] : VALUE > 0)
                                ) {
                                    PARTS.push(`${NAME}=${ROUND_COUNT(frame.counts[NAME])}`);
                                }
                            }
                            return PARTS.join(' ');
                        })
                        .join(' | '),
            );
        }
        return LINES.join('\n');
    }
    snapshot({ limit = 0 } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.capacity) {
            throw new RangeError('Invalid snapshot limits');
        }
        const FRAMES = [];
        for (let offset = 0; offset < this.size; offset++) {
            const INDEX = ((this.write - this.size + offset + this.capacity) % this.capacity) * this.stride;
            FRAMES.push(this.readRow(this.samples, INDEX, this.sequence - this.size + offset + 1));
        }
        const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0),
            WINDOW_MS = INTERVALS.reduce((sum, value) => sum + value, 0);
        return {
            format: 'bloom numeric frame metrics v2',
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
            hitchTotal: this.hitchTotal,
            hitches: this.hitches(),
            traceTotal: this.traceTotal,
            traces: this.traces(),
            frames: limit ? FRAMES.slice(-limit) : [],
        };
    }
}
