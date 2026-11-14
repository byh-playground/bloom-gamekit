// modules/debug-tools/frame-metrics.js
function names(values) {
  if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length) {
    throw new RangeError("Expected at most 128 unique metric names");
  }
  for (const NAME of values) {
    if (typeof NAME !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(NAME)) {
      throw new TypeError("Invalid metric name");
    }
  }
  return Object.freeze(values.slice());
}
function summary(values) {
  const SORTED = values.slice().sort((a, b) => a - b), TOTAL = values.reduce((sum, value) => sum + value, 0), COUNT = values.length;
  return {
    count: COUNT,
    total: TOTAL,
    mean: COUNT ? TOTAL / COUNT : 0,
    p50: COUNT ? SORTED[Math.floor((COUNT - 1) * 0.5)] : 0,
    p95: COUNT ? SORTED[Math.floor((COUNT - 1) * 0.95)] : 0,
    max: COUNT ? SORTED[COUNT - 1] : 0
  };
}
var ROUND_MS = (value) => Math.round(value * 10) / 10;
var ROUND_COUNT = (value) => Math.round(value * 100) / 100;
var MEDIAN_WINDOW = 15;
var HITCH_INFO = 4;
var TRACE_INFO = 6;
var FrameMetrics = class {
  constructor({
    capacity = 240,
    stages = [],
    counters = [],
    now = () => performance.now(),
    hitch: { capacity: hitchCapacity = 24, ms = 100, medianFactor = 2.5, maxMs = 1e3, before = 3 } = {},
    trace: {
      counters: traceCounters = [],
      capacity: traceCapacity = 8,
      before: traceBefore = 2,
      after: traceAfter = 10
    } = {}
  } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3600 || typeof now !== "function") {
      throw new RangeError("Invalid frame metric capacity or clock");
    }
    if (!Number.isSafeInteger(hitchCapacity) || hitchCapacity < 0 || hitchCapacity > 256 || !Number.isSafeInteger(before) || before < 0 || before > 8 || !(ms > 0) || !(medianFactor > 1) || !(maxMs > 0)) {
      throw new RangeError("Invalid hitch options");
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
    if (!Number.isSafeInteger(traceCapacity) || traceCapacity < 0 || traceCapacity > 64 || !Number.isSafeInteger(traceBefore) || traceBefore < 0 || traceBefore > 16 || TRACE_NAMES.length > 0 && traceBefore >= capacity || !Number.isSafeInteger(traceAfter) || traceAfter < 0 || traceAfter > 120) {
      throw new RangeError("Invalid trace options");
    }
    if (TRACE_NAMES.some((name) => !this.counterIndex.has(name))) {
      throw new TypeError("Trace counters must be registered counters");
    }
    this.traceRule = Object.freeze({
      counters: TRACE_NAMES,
      capacity: TRACE_NAMES.length ? traceCapacity : 0,
      before: traceBefore,
      after: traceAfter
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
    if (!Number.isFinite(timestampMs) || this.lastTimestampMs !== null && timestampMs < this.lastTimestampMs) {
      throw new RangeError("Frame timestamp must be finite and monotonic");
    }
    if (this.active) {
      throw new Error("endFrame required");
    }
    this.current.fill(0);
    this.current[0] = timestampMs;
    if (this.size > 0) {
      const PREVIOUS = (this.write - 1 + this.capacity) % this.capacity * this.stride, LINKED = this.lastTimestampMs !== null && !this.skipNext, INTERVAL = LINKED ? timestampMs - this.lastTimestampMs : 0;
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
    if (!this.active && this.size === 0 || COLUMN === void 0) {
      return false;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Metric values must be finite and non-negative");
    }
    if (this.active) {
      this.current[COLUMN] += value;
    } else {
      const PREVIOUS = (this.write - 1 + this.capacity) % this.capacity * this.stride;
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
    const MEDIAN = this.medianInterval(), THRESHOLD = MEDIAN > 0 ? Math.min(RULE.ms, MEDIAN * RULE.medianFactor) : RULE.ms;
    this.intervalWindow[this.windowWrite] = intervalMs;
    this.windowWrite = (this.windowWrite + 1) % MEDIAN_WINDOW;
    this.windowSize = Math.min(MEDIAN_WINDOW, this.windowSize + 1);
    if (intervalMs < THRESHOLD || RULE.capacity === 0) {
      return;
    }
    const { stride: STRIDE, capacity: CAPACITY } = this, BEFORE = Math.min(RULE.before, this.size - 1), SLOT = this.hitchWrite, ROWS = SLOT * (1 + RULE.before) * STRIDE;
    for (let row = 0; row <= BEFORE; row++) {
      const SOURCE = (this.write - 1 - row + CAPACITY * 2) % CAPACITY * STRIDE, TARGET = ROWS + row * STRIDE;
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
    const RULE = this.traceRule, { stride: STRIDE, capacity: CAPACITY } = this;
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
      const BEFORE = Math.min(RULE.before, this.size - 1), ROWS = slot * this.traceRowsPerSlot * STRIDE;
      for (let back = BEFORE; back >= 1; back--) {
        const SOURCE = (this.write - 1 - back + CAPACITY * 2) % CAPACITY * STRIDE, TARGET2 = ROWS + (BEFORE - back) * STRIDE;
        for (let column = 0; column < STRIDE; column++) {
          this.traceRows[TARGET2 + column] = this.samples[SOURCE + column];
        }
      }
      const INFO2 = slot * TRACE_INFO;
      this.traceInfo[INFO2] = this.sequence - BEFORE;
      this.traceInfo[INFO2 + 1] = this.sequence;
      this.traceInfo[INFO2 + 2] = BEFORE;
      this.traceInfo[INFO2 + 3] = 0;
      this.traceInfo[INFO2 + 4] = this.medianInterval();
      this.traceInfo[INFO2 + 5] = 0;
      this.traceOpen = slot;
      this.traceWrite = (slot + 1) % RULE.capacity;
      this.traceSize = Math.min(RULE.capacity, this.traceSize + 1);
      this.traceTotal++;
    }
    const INFO = slot * TRACE_INFO, FILLED = this.traceInfo[INFO + 2], TARGET = (slot * this.traceRowsPerSlot + FILLED) * STRIDE;
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
      counts: {}
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
    const RULE = this.hitchRule, RESULT = [];
    for (let offset = 0; offset < this.hitchSize; offset++) {
      const SLOT = (this.hitchWrite - this.hitchSize + offset + RULE.capacity) % RULE.capacity, INFO = SLOT * HITCH_INFO, SEQUENCE = this.hitchInfo[INFO], ROWS = SLOT * (1 + RULE.before) * this.stride, HITCH = this.readRow(this.hitchRows, ROWS, SEQUENCE), BEFORE = [];
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
      throw new RangeError("Invalid hitch text limit");
    }
    const RULE = this.hitchRule, VALUES = (frame) => {
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
      return PARTS.length ? " " + PARTS.join(" ") : "";
    }, LINES = [
      `hitches ${this.hitchTotal} (kept ${this.hitchSize}/${RULE.capacity}) rule >=${RULE.ms}ms or >=${RULE.medianFactor}x median, <${RULE.maxMs}ms; now t=${(this.now() / 1e3).toFixed(1)}s`
    ];
    for (const HITCH of limit ? this.hitches().slice(-limit) : []) {
      LINES.push(
        `#${HITCH.sequence} t=${(HITCH.timestampMs / 1e3).toFixed(1)}s ${ROUND_MS(HITCH.intervalMs)}ms (median ${ROUND_MS(HITCH.medianMs)}) cpu=${ROUND_MS(HITCH.cpuMs)}${VALUES(HITCH)}`
      );
      if (HITCH.before.length) {
        LINES.push(
          "  before " + HITCH.before.map((frame) => `#${frame.sequence} ${ROUND_MS(frame.intervalMs)}ms${VALUES(frame)}`).join(" | ")
        );
      }
    }
    return LINES.join("\n");
  }
  /**
   * 보관한 추적을 오래된 것부터. `frames`는 앞 프레임·표시 프레임·뒤 프레임 순이고 `offset`은 표시 프레임 기준 상대 순번입니다.
   * `medianMs`는 표시 때 최근 15간격 중앙값(15간격이 안 모였으면 추적 안 간격의 중앙값)입니다. 부를 때만 할당합니다.
   */
  traces() {
    const RULE = this.traceRule, RESULT = [];
    for (let offset = 0; offset < this.traceSize; offset++) {
      const SLOT = (this.traceWrite - this.traceSize + offset + RULE.capacity) % RULE.capacity, INFO = SLOT * TRACE_INFO, FIRST = this.traceInfo[INFO], MARK = this.traceInfo[INFO + 1], FRAMES = [];
      for (let row = 0; row < this.traceInfo[INFO + 2]; row++) {
        const FRAME = this.readRow(
          this.traceRows,
          (SLOT * this.traceRowsPerSlot + row) * this.stride,
          FIRST + row
        );
        FRAME.offset = FIRST + row - MARK;
        FRAMES.push(FRAME);
      }
      const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0), MEDIAN = this.traceInfo[INFO + 4] || summary(INTERVALS).p50, MAX = INTERVALS.length ? Math.max(...INTERVALS) : 0;
      RESULT.push({
        sequence: MARK,
        timestampMs: FRAMES.find((frame) => frame.offset === 0).timestampMs,
        marks: this.traceInfo[INFO + 3],
        open: SLOT === this.traceOpen,
        gap: this.traceInfo[INFO + 5] === 1,
        medianMs: MEDIAN,
        maxIntervalMs: MAX,
        maxFactor: MEDIAN > 0 ? MAX / MEDIAN : 0,
        doubledIntervals: MEDIAN > 0 ? INTERVALS.filter((value) => value >= MEDIAN * 1.8).length : 0,
        frames: FRAMES
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
      throw new RangeError("Invalid trace text limit");
    }
    const RULE = this.traceRule, LINES = [
      `traces ${this.traceTotal} (kept ${this.traceSize}/${RULE.capacity}) on ${RULE.counters.join(",") || "-"} before ${RULE.before} after ${RULE.after}; frame = offset intervalMs(to next frame) cpu stages counters`
    ];
    for (const TRACE of limit ? this.traces().slice(-limit) : []) {
      const FIRST = TRACE.frames[0], FIXED = this.counters.filter(
        (name) => !RULE.counters.includes(name) && TRACE.frames.every((frame) => frame.counts[name] === FIRST.counts[name])
      ), MARK = TRACE.frames.find((frame) => frame.offset === 0), FIXED_TEXT = FIXED.filter((name) => FIRST.counts[name] > 0).map((name) => `${name}=${ROUND_COUNT(FIRST.counts[name])}`).join(" "), STATE = [
        TRACE.marks > 1 ? ` marks=${TRACE.marks}` : "",
        TRACE.open ? ` open ${TRACE.frames.at(-1).offset}/${RULE.after}` : "",
        TRACE.gap ? " gap" : "",
        FIXED_TEXT ? ` | fixed ${FIXED_TEXT}` : ""
      ].join("");
      LINES.push(
        `#${TRACE.sequence} ${RULE.counters.filter((name) => MARK.counts[name] > 0).join(",")} t=${(TRACE.timestampMs / 1e3).toFixed(1)}s max ${ROUND_MS(TRACE.maxIntervalMs)}ms = ${ROUND_COUNT(TRACE.maxFactor)}x median ${ROUND_MS(TRACE.medianMs)}, >=1.8x ${TRACE.doubledIntervals}${STATE}`,
        "  " + TRACE.frames.map((frame, index) => {
          const PREVIOUS = TRACE.frames[index - 1], PARTS = [
            `${frame.offset > 0 ? "+" : ""}${frame.offset}`,
            frame.intervalMs > 0 ? `${ROUND_MS(frame.intervalMs)}` : "gap",
            `cpu=${ROUND_MS(frame.cpuMs)}`
          ];
          for (const NAME of this.stages) {
            if (frame.stagesMs[NAME] > 0) {
              PARTS.push(`${NAME}=${ROUND_MS(frame.stagesMs[NAME])}`);
            }
          }
          for (const NAME of this.counters) {
            const VALUE = frame.counts[NAME];
            if (RULE.counters.includes(NAME) ? VALUE > 0 : !FIXED.includes(NAME) && (PREVIOUS ? VALUE !== PREVIOUS.counts[NAME] : VALUE > 0)) {
              PARTS.push(`${NAME}=${ROUND_COUNT(frame.counts[NAME])}`);
            }
          }
          return PARTS.join(" ");
        }).join(" | ")
      );
    }
    return LINES.join("\n");
  }
  snapshot({ limit = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.capacity) {
      throw new RangeError("Invalid snapshot limits");
    }
    const FRAMES = [];
    for (let offset = 0; offset < this.size; offset++) {
      const INDEX = (this.write - this.size + offset + this.capacity) % this.capacity * this.stride;
      FRAMES.push(this.readRow(this.samples, INDEX, this.sequence - this.size + offset + 1));
    }
    const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0), WINDOW_MS = INTERVALS.reduce((sum, value) => sum + value, 0);
    return {
      format: "bloom numeric frame metrics v2",
      capacity: this.capacity,
      retainedFrames: this.size,
      firstSequence: FRAMES[0]?.sequence ?? 0,
      lastSequence: FRAMES.at(-1)?.sequence ?? 0,
      windowMs: WINDOW_MS,
      fps: WINDOW_MS > 0 ? INTERVALS.length * 1e3 / WINDOW_MS : null,
      intervalMs: summary(INTERVALS),
      cpuMs: summary(FRAMES.map((frame) => frame.cpuMs)),
      stagesMs: Object.fromEntries(
        this.stages.map((name) => [name, summary(FRAMES.map((frame) => frame.stagesMs[name]))])
      ),
      counts: Object.fromEntries(
        this.counters.map((name) => [name, summary(FRAMES.map((frame) => frame.counts[name]))])
      ),
      hitchTotal: this.hitchTotal,
      hitches: this.hitches(),
      traceTotal: this.traceTotal,
      traces: this.traces(),
      frames: limit ? FRAMES.slice(-limit) : []
    };
  }
};

// modules/debug-tools/debug-host.js
var RESERVED = /* @__PURE__ */ new Set(["debug", "scene", "tick"]);
var EPOCH_MS = 1e7;
var TICK = (text) => {
  const VALUE = Number(text);
  if (text === "" || !Number.isSafeInteger(VALUE) || VALUE < 0) {
    throw new RangeError(`tick must be a non-negative integer: ${text}`);
  }
  return VALUE;
};
var clockFrozen = false;
function freezePerformanceNow() {
  if (clockFrozen) {
    throw new Error("another debug scene holds the frozen clock; dispose it first");
  }
  const PERFORMANCE = globalThis.performance;
  const OWN = Object.getOwnPropertyDescriptor(PERFORMANCE, "now");
  const REAL = PERFORMANCE.now.bind(PERFORMANCE);
  if (REAL() >= EPOCH_MS) {
    throw new Error(`the debug clock must be frozen within ${EPOCH_MS} ms of page start`);
  }
  let virtual = EPOCH_MS;
  const VIRTUAL_NOW = () => virtual;
  const SET = (now) => Object.defineProperty(PERFORMANCE, "now", { configurable: true, writable: true, value: now });
  SET(VIRTUAL_NOW);
  clockFrozen = true;
  let restored = false;
  const LIVE = () => {
    if (restored) {
      throw new Error("the debug clock was restored with its scene");
    }
  };
  return {
    clock: {
      now: VIRTUAL_NOW,
      advance(ms) {
        LIVE();
        if (!Number.isFinite(ms) || ms < 0) {
          throw new RangeError(`clock advance must be a finite non-negative number: ${ms}`);
        }
        virtual += ms;
      },
      realTime(operation) {
        LIVE();
        SET(REAL);
        try {
          return operation();
        } finally {
          SET(VIRTUAL_NOW);
        }
      }
    },
    restore() {
      if (OWN) {
        Object.defineProperty(PERFORMANCE, "now", OWN);
      } else {
        delete PERFORMANCE.now;
      }
      clockFrozen = false;
      restored = true;
    }
  };
}
function installDebugHost({ scenes, search = globalThis.location?.search ?? "", target = globalThis } = {}) {
  const QUERY = new URLSearchParams(search);
  if (!QUERY.has("debug")) {
    return null;
  }
  const PARAMS = {};
  for (const [KEY, VALUE] of QUERY) {
    if (!RESERVED.has(KEY)) {
      PARAMS[KEY] = VALUE;
    }
  }
  const NAME = QUERY.get("scene");
  let handle = null, frozen = null;
  const RESTORE_CLOCK = () => {
    frozen?.restore();
    frozen = null;
  };
  const CONTEXT = {
    freezeClock() {
      frozen ??= freezePerformanceNow();
      return frozen.clock;
    }
  };
  const DEBUG = {
    ready: false,
    error: null,
    scene: NAME,
    params: PARAMS,
    tick: 0,
    step(count = 1) {
      if (!handle) {
        throw new Error("scene is not open");
      }
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError(`step count must be a non-negative integer: ${count}`);
      }
      if (count && typeof handle.step !== "function") {
        throw new TypeError(`scene ${NAME} has no step`);
      }
      for (let index = 0; index < count; index++) {
        handle.step();
        DEBUG.tick++;
      }
      handle.render?.();
    },
    /** Compact text-able view of what the screen shows. `options` reaches the scene's `state` as given. */
    state(options) {
      return { scene: NAME, params: PARAMS, tick: DEBUG.tick, ...handle.state?.(options) };
    },
    hash() {
      return handle.hash?.();
    },
    dispose() {
      try {
        handle?.dispose?.();
      } finally {
        handle = null;
        DEBUG.ready = false;
        RESTORE_CLOCK();
        if (target.__bloomDebug === DEBUG) {
          delete target.__bloomDebug;
        }
      }
    }
  };
  target.__bloomDebug = DEBUG;
  DEBUG.done = (async () => {
    if (typeof scenes?.[NAME] !== "function") {
      throw new Error(`unknown scene: ${NAME}`);
    }
    handle = await scenes[NAME](PARAMS, CONTEXT) ?? {};
    if (QUERY.has("tick")) {
      DEBUG.step(TICK(QUERY.get("tick")));
    } else {
      handle.render?.();
    }
    DEBUG.ready = true;
  })().catch((error) => {
    RESTORE_CLOCK();
    DEBUG.error = String(error?.stack || error);
    console.error(error);
  });
  return DEBUG;
}

// modules/debug-tools/index.js
var BOUND = (value, name, min = 1, max = 1e5) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} outside supported range`);
  }
  return value;
};
var FIELD = (object, key) => {
  try {
    return object?.[key];
  } catch {
    return void 0;
  }
};
var DIAGNOSTIC_VISIBILITIES = /* @__PURE__ */ new Set(["log", "notice", "blocking", "fatal"]);
var DIAGNOSTIC_VISIBILITY = (visibility, fatal) => {
  if (visibility !== void 0 && !DIAGNOSTIC_VISIBILITIES.has(visibility)) {
    throw new TypeError("visibility must be log, notice, blocking, or fatal");
  }
  return fatal || visibility === "fatal" ? "fatal" : visibility ?? "blocking";
};
function redactDiagnostic(value, limit = 1600) {
  BOUND(limit, "limit");
  const TEXT = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return TEXT.replace(/\{[\s\S]*\}/g, "[structured data omitted]").replace(
    /(?:["']?(?:password|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi,
    "[redacted]"
  ).replace(/\b(?:https?|blob|file):[^\r\n)\]<>"']+/gi, "[source]").replace(/(?:[A-Za-z]:[\\/]|\/(?!\/)[A-Za-z0-9_.~-]+\/)[^\r\n)\]<>"']*/g, "[local source]").replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)/gi, "[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit);
}
var DiagnosticRing = class {
  constructor({ capacity = 20, now = () => performance.now(), release = "" } = {}) {
    BOUND(capacity, "capacity", 1, 1e3);
    if (typeof now !== "function") {
      throw new TypeError("now must be function");
    }
    this.capacity = capacity;
    this.now = now;
    this.release = redactDiagnostic(release, 160);
    this.records = new Array(capacity);
    this.start = 0;
    this.size = 0;
    this.total = 0;
    this.dropped = 0;
    this._lastMs = 0;
    this._busy = false;
    this._listeners = /* @__PURE__ */ new Set();
  }
  /** @param {unknown} error @param {{kind?: string, visibility?: DiagnosticVisibility, fatal?: boolean, origin?: string, source?: string, line?: number, column?: number, workerTimeMs?: number|null, cause?: unknown}} options */
  report(error, {
    kind = "exception",
    visibility,
    fatal = false,
    origin = "main",
    source = "",
    line = 0,
    column = 0,
    workerTimeMs = null,
    cause = ""
  } = {}) {
    if (this._busy) {
      this.dropped++;
      return null;
    }
    this._busy = true;
    try {
      const SEVERITY = DIAGNOSTIC_VISIBILITY(visibility, Boolean(fatal));
      const AT = this.now();
      if (!Number.isFinite(AT)) {
        throw new TypeError("diagnostic clock must be finite");
      }
      this._lastMs = Math.max(this._lastMs, AT);
      const RECORD = {
        kind: redactDiagnostic(kind, 64),
        visibility: SEVERITY,
        fatal: SEVERITY === "fatal",
        origin: redactDiagnostic(origin, 64),
        message: redactDiagnostic(
          typeof error === "string" ? error : FIELD(error, "message") ?? "Non-text error omitted",
          500
        ),
        stack: redactDiagnostic(FIELD(error, "stack"), 1800),
        source: redactDiagnostic(source, 160),
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
        column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
        workerTimeMs: Number.isFinite(workerTimeMs) && workerTimeMs >= 0 ? workerTimeMs : null,
        cause: redactDiagnostic(
          typeof cause === "string" && cause ? cause : FIELD(FIELD(error, "cause"), "message") ?? FIELD(error, "cause"),
          300
        ),
        firstMs: this._lastMs,
        lastMs: this._lastMs,
        count: 1
      };
      this.total++;
      for (let i = 0; i < this.size; i++) {
        const OLD = this.records[(this.start + i) % this.capacity];
        if (OLD.kind === RECORD.kind && OLD.message === RECORD.message && OLD.stack === RECORD.stack && OLD.visibility === RECORD.visibility && OLD.origin === RECORD.origin && OLD.source === RECORD.source && OLD.line === RECORD.line && OLD.column === RECORD.column) {
          OLD.count++;
          OLD.lastMs = RECORD.lastMs;
          return {
            ...OLD
          };
        }
      }
      if (this.size === this.capacity) {
        this.records[this.start] = RECORD;
        this.start = (this.start + 1) % this.capacity;
        this.dropped++;
      } else {
        this.records[(this.start + this.size) % this.capacity] = RECORD;
        this.size++;
      }
      return {
        ...RECORD
      };
    } finally {
      this._busy = false;
    }
  }
  snapshot() {
    const ERRORS = [];
    for (let i = 0; i < this.size; i++) {
      ERRORS.push({
        ...this.records[(this.start + i) % this.capacity]
      });
    }
    const COUNTS = {
      log: 0,
      notice: 0,
      blocking: 0,
      fatal: 0
    };
    for (const RECORD of ERRORS) {
      COUNTS[RECORD.visibility] += RECORD.count;
    }
    return {
      format: "bloom-gamekit diagnostics v2",
      release: this.release,
      total: this.total,
      dropped: this.dropped,
      counts: {
        total: this.total,
        retained: Object.values(COUNTS).reduce((sum, count) => sum + count, 0),
        ...COUNTS
      },
      blockerCount: COUNTS.blocking + COUNTS.fatal,
      errors: ERRORS
    };
  }
  format() {
    return JSON.stringify(this.snapshot(), null, 2);
  }
  /** Does not swallow errors or replace onerror. Caller decides whether a fatal error should halt gameplay. */
  installGlobal(target, { onReport } = {}) {
    if (!target?.addEventListener || !target?.removeEventListener) {
      throw new TypeError("EventTarget required");
    }
    if (onReport !== void 0 && typeof onReport !== "function") {
      throw new TypeError("onReport must be function");
    }
    const REPORT = (error, kind) => {
      try {
        const RECORD = this.report(error, {
          kind
        });
        onReport?.(RECORD);
      } catch {
        this.dropped++;
      }
    };
    const ERROR = (event) => REPORT(event.error ?? event.message, "global-error");
    const REJECTION = (event) => REPORT(event.reason, "unhandled-rejection");
    target.addEventListener("error", ERROR);
    target.addEventListener("unhandledrejection", REJECTION);
    let active = true;
    const DISPOSE = () => {
      if (!active) {
        return;
      }
      active = false;
      target.removeEventListener("error", ERROR);
      target.removeEventListener("unhandledrejection", REJECTION);
      this._listeners.delete(DISPOSE);
    };
    this._listeners.add(DISPOSE);
    return DISPOSE;
  }
  clear() {
    this.records.fill(void 0);
    this.size = this.start = this.total = this.dropped = 0;
  }
  dispose() {
    for (const DISPOSE of this._listeners) {
      DISPOSE();
    }
    this.clear();
  }
};
var PROFILE_NAME = (value) => {
  if (typeof value !== "string" || !value || value.length > 96) {
    throw new TypeError("profile stage name must be a non-empty string up to 96 characters");
  }
  return redactDiagnostic(value, 96);
};
var PROFILE_META = (value) => {
  if (value === void 0) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("profile metadata must be an object");
  }
  const ENTRIES = Object.entries(value);
  if (ENTRIES.length > 8) {
    throw new RangeError("profile metadata supports up to 8 fields");
  }
  const RESULT = {};
  for (const [KEY, ITEM] of ENTRIES) {
    if (typeof KEY !== "string" || !KEY || KEY.length > 48) {
      throw new TypeError("profile metadata key is invalid");
    }
    if (typeof ITEM === "string") {
      RESULT[redactDiagnostic(KEY, 48)] = redactDiagnostic(ITEM, 160);
    } else if (typeof ITEM === "boolean" || ITEM === null) {
      RESULT[redactDiagnostic(KEY, 48)] = ITEM;
    } else if (typeof ITEM === "number" && Number.isFinite(ITEM)) {
      RESULT[redactDiagnostic(KEY, 48)] = ITEM;
    } else {
      throw new TypeError("profile metadata values must be primitive");
    }
  }
  return RESULT;
};
var PROFILE_SUMMARY = (values) => {
  if (!values.length) {
    return {
      count: 0,
      totalMs: 0,
      minMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0
    };
  }
  const TOTAL_MS = values.reduce((sum, value) => sum + value, 0);
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    totalMs: TOTAL_MS,
    minMs: values[0],
    maxMs: values[values.length - 1],
    p50Ms: values[Math.floor((values.length - 1) * 0.5)],
    p95Ms: values[Math.floor((values.length - 1) * 0.95)]
  };
};
var PerformanceProfiler = class {
  constructor({ capacity = 120, now = () => performance.now(), maxStages = 64 } = {}) {
    BOUND(capacity, "capacity", 1, 1e3);
    BOUND(maxStages, "maxStages", 1, 256);
    if (typeof now !== "function") {
      throw new TypeError("now must be function");
    }
    this.capacity = capacity;
    this.maxStages = maxStages;
    this.now = now;
    this.enabled = false;
    this.frames = new Array(capacity);
    this.frameStart = 0;
    this.frameCount = 0;
    this.current = null;
    this.sequence = 0;
  }
  setEnabled(enabled) {
    if (typeof enabled !== "boolean") {
      throw new TypeError("enabled must be boolean");
    }
    this.enabled = enabled;
    if (!enabled) {
      this.current = null;
    }
    return enabled;
  }
  beginFrame(meta = {}) {
    if (!this.enabled) {
      return false;
    }
    if (this.current) {
      throw new Error("profile frame already active");
    }
    const AT_MS = this.now();
    if (!Number.isFinite(AT_MS)) {
      throw new TypeError("profile clock must be finite");
    }
    this.current = {
      sequence: ++this.sequence,
      startedAtMs: AT_MS,
      meta: PROFILE_META(meta),
      stages: /* @__PURE__ */ new Map(),
      counts: /* @__PURE__ */ new Map()
    };
    return true;
  }
  stage(name, durationMs, metadata = {}) {
    if (!this.enabled || !this.current) {
      return false;
    }
    const KEY = PROFILE_NAME(name), VALUE = Number(durationMs);
    if (!Number.isFinite(VALUE) || VALUE < 0) {
      throw new RangeError("profile duration must be finite and non-negative");
    }
    let stage = this.current.stages.get(KEY);
    if (!stage) {
      if (this.current.stages.size >= this.maxStages) {
        return false;
      }
      stage = {
        ms: 0,
        calls: 0,
        maxMs: 0,
        metadata: {}
      };
      this.current.stages.set(KEY, stage);
    }
    stage.ms += VALUE;
    stage.calls++;
    stage.maxMs = Math.max(stage.maxMs, VALUE);
    Object.assign(stage.metadata, PROFILE_META(metadata));
    return true;
  }
  count(name, value = 1) {
    if (!this.enabled || !this.current) {
      return false;
    }
    const KEY = PROFILE_NAME(name), AMOUNT = Number(value);
    if (!Number.isFinite(AMOUNT) || AMOUNT < 0) {
      throw new RangeError("profile count must be finite and non-negative");
    }
    if (!this.current.counts.has(KEY) && this.current.counts.size >= this.maxStages) {
      return false;
    }
    this.current.counts.set(KEY, (this.current.counts.get(KEY) || 0) + AMOUNT);
    return true;
  }
  measure(name, operation, metadata = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("profile operation must be function");
    }
    if (!this.enabled || !this.current) {
      return operation();
    }
    const STARTED_AT_MS = this.now();
    try {
      return operation();
    } finally {
      const ENDED_AT_MS = this.now();
      this.stage(name, Math.max(0, ENDED_AT_MS - STARTED_AT_MS), metadata);
    }
  }
  endFrame(meta = {}) {
    if (!this.enabled || !this.current) {
      return null;
    }
    const CURRENT = this.current;
    this.current = null;
    const ENDED_AT_MS = this.now();
    if (!Number.isFinite(ENDED_AT_MS)) {
      throw new TypeError("profile clock must be finite");
    }
    const FRAME = {
      sequence: CURRENT.sequence,
      durationMs: Math.max(0, ENDED_AT_MS - CURRENT.startedAtMs),
      meta: {
        ...CURRENT.meta,
        ...PROFILE_META(meta)
      },
      stages: Object.fromEntries(
        [...CURRENT.stages].map(([name, value]) => [
          name,
          {
            ms: value.ms,
            calls: value.calls,
            maxMs: value.maxMs,
            metadata: {
              ...value.metadata
            }
          }
        ])
      ),
      counts: Object.fromEntries(CURRENT.counts)
    };
    if (this.frameCount === this.capacity) {
      this.frames[this.frameStart] = FRAME;
      this.frameStart = (this.frameStart + 1) % this.capacity;
    } else {
      this.frames[(this.frameStart + this.frameCount) % this.capacity] = FRAME;
      this.frameCount++;
    }
    return FRAME;
  }
  clear() {
    this.frames.fill(void 0);
    this.frameStart = this.frameCount = 0;
    this.current = null;
  }
  snapshot({ limit = Math.min(30, this.capacity) } = {}) {
    BOUND(limit, "limit", 0, this.capacity);
    const RETAINED = Array.from(
      {
        length: this.frameCount
      },
      (_, index) => this.frames[(this.frameStart + index) % this.capacity]
    );
    const FRAMES = RETAINED.slice(RETAINED.length - Math.min(limit, RETAINED.length)).map((frame) => ({
      sequence: frame.sequence,
      durationMs: frame.durationMs,
      meta: {
        ...frame.meta
      },
      stages: Object.fromEntries(
        Object.entries(frame.stages).map(([name, value]) => [
          name,
          {
            ms: value.ms,
            calls: value.calls,
            maxMs: value.maxMs,
            metadata: {
              ...value.metadata
            }
          }
        ])
      ),
      counts: {
        ...frame.counts
      }
    }));
    const STAGE_VALUES = /* @__PURE__ */ new Map();
    for (const FRAME of RETAINED) {
      for (const [NAME, STAGE] of Object.entries(FRAME.stages)) {
        const VALUES = STAGE_VALUES.get(NAME) || [];
        VALUES.push(STAGE.ms);
        STAGE_VALUES.set(NAME, VALUES);
      }
    }
    return {
      enabled: this.enabled,
      capacity: this.capacity,
      retainedFrames: this.frameCount,
      frames: FRAMES,
      summary: {
        frames: PROFILE_SUMMARY(RETAINED.map((frame) => frame.durationMs)),
        stages: Object.fromEntries([...STAGE_VALUES].map(([name, values]) => [name, PROFILE_SUMMARY(values)]))
      }
    };
  }
  dispose() {
    this.enabled = false;
    this.clear();
  }
};
async function copyDiagnostic(text, { clipboard, textarea } = {}) {
  if (typeof text !== "string") {
    throw new TypeError("text must be string");
  }
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return {
        copied: true,
        method: "clipboard"
      };
    } catch {
    }
  }
  if (textarea?.select) {
    textarea.value = text;
    textarea.focus();
    textarea.select();
    return {
      copied: false,
      method: "selection",
      text
    };
  }
  return {
    copied: false,
    method: "text",
    text
  };
}
var ReplayTimeline = class {
  constructor(adapter) {
    for (const NAME of ["read", "seek", "setPlaying"]) {
      if (typeof adapter?.[NAME] !== "function") {
        throw new TypeError(`replay adapter.${NAME} required`);
      }
    }
    this.adapter = adapter;
  }
  readInto(out) {
    const STATE = this.adapter.read();
    for (const NAME of ["tick", "firstTick", "lastTick"]) {
      if (!Number.isSafeInteger(STATE[NAME]) || STATE[NAME] < 0) {
        throw new RangeError(`invalid replay ${NAME}`);
      }
    }
    if (STATE.firstTick > STATE.lastTick || STATE.tick < STATE.firstTick || STATE.tick > STATE.lastTick) {
      throw new RangeError("invalid replay bounds");
    }
    out.tick = STATE.tick;
    out.firstTick = STATE.firstTick;
    out.lastTick = STATE.lastTick;
    out.playing = Boolean(STATE.playing);
    return out;
  }
  seek(tick) {
    const STATE = this.readInto({});
    if (!Number.isSafeInteger(tick)) {
      throw new RangeError("tick must be safe integer");
    }
    return this.adapter.seek(Math.max(STATE.firstTick, Math.min(STATE.lastTick, tick)));
  }
  step(delta = 1) {
    if (!Number.isSafeInteger(delta)) {
      throw new RangeError("delta must be safe integer");
    }
    const STATE = this.readInto({});
    this.adapter.setPlaying(false);
    return this.seek(STATE.tick + delta);
  }
  setPlaying(playing) {
    if (typeof playing !== "boolean") {
      throw new TypeError("playing must be boolean");
    }
    return this.adapter.setPlaying(playing);
  }
};
function compareStateFields(left, right, fields, { maxDifferences = 100 } = {}) {
  BOUND(maxDifferences, "maxDifferences");
  if (!Array.isArray(fields)) {
    throw new TypeError("fields must be array");
  }
  const DIFFERENCES = [];
  let mismatches = 0;
  for (const FIELD2 of fields) {
    if (typeof FIELD2?.name !== "string" || typeof FIELD2?.read !== "function" || FIELD2.equal !== void 0 && typeof FIELD2.equal !== "function") {
      throw new TypeError("field name/read required");
    }
    const A = FIELD2.read(left), B = FIELD2.read(right), EQUAL = FIELD2.equal ? FIELD2.equal(A, B) : Object.is(A, B);
    if (!EQUAL) {
      mismatches++;
      if (DIFFERENCES.length < maxDifferences) {
        DIFFERENCES.push({
          field: redactDiagnostic(FIELD2.name, 160),
          left: redactDiagnostic(A, 300),
          right: redactDiagnostic(B, 300)
        });
      }
    }
  }
  return {
    equal: mismatches === 0,
    mismatches,
    truncated: mismatches > DIFFERENCES.length,
    differences: DIFFERENCES
  };
}
export {
  DiagnosticRing,
  FrameMetrics,
  PerformanceProfiler,
  ReplayTimeline,
  compareStateFields,
  copyDiagnostic,
  installDebugHost,
  redactDiagnostic
};
