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

// modules/three-kit/render-stats.js
var COUNTERS = ["drawCalls", "triangles", "programs", "textures"];
var RenderStats = class {
  /**
   * @param {object} renderer three.js WebGLRenderer
   * @param {{ capacity?: number, stages?: string[], counters?: string[], hitch?: object, trace?: object }} [options]
   *   보관할 최근 프레임 수, 게임이 같은 프레임에 더 적을 stage·counter 이름(`metrics.stage`·`metrics.count`로 적음), 히치 기준, 표시 프레임 추적(`trace.counters`는 위 counters 중 이름)
   */
  constructor(renderer, { capacity = 240, stages = [], counters = [], hitch, trace } = {}) {
    this.info = renderer.info;
    this.info.autoReset = false;
    this.metrics = new FrameMetrics({ capacity, stages, counters: [...COUNTERS, ...counters], hitch, trace });
  }
  /** 프레임 시작: 제출 카운터를 0으로 되돌리고 시간 재기를 시작합니다. 앞 프레임이 end() 없이 끝났으면 먼저 닫습니다. */
  begin() {
    if (this.metrics.active) {
      this.metrics.endFrame();
    }
    this.info.reset();
    this.metrics.beginFrame(performance.now());
  }
  /** 프레임 끝: begin() 뒤에 부른 모든 render()의 제출 합계를 기록합니다. */
  end() {
    const { metrics: METRICS, info: INFO } = this;
    METRICS.count("drawCalls", INFO.render.calls);
    METRICS.count("triangles", INFO.render.triangles);
    METRICS.count("programs", INFO.programs?.length ?? 0);
    METRICS.count("textures", INFO.memory.textures);
    METRICS.endFrame();
  }
  /** 최근 프레임 요약: intervalMs(프레임 간격), cpuMs(begin~end 구간), counts(제출량), 보관한 히치. */
  snapshot() {
    return this.metrics.snapshot();
  }
  /** 진단 복사에 넣는 한 줄. */
  line() {
    const SNAPSHOT = this.snapshot();
    if (!SNAPSHOT.retainedFrames) {
      return "render: no frames";
    }
    const ROUND = (value) => Math.round(value * 10) / 10;
    const { intervalMs: INTERVAL } = SNAPSHOT;
    const { drawCalls: DRAWS, triangles: TRIANGLES, programs: PROGRAMS, textures: TEXTURES } = SNAPSHOT.counts;
    return `render frames=${SNAPSHOT.retainedFrames} fps=${ROUND(SNAPSHOT.fps ?? 0)} intervalMs p50=${ROUND(INTERVAL.p50)} p95=${ROUND(INTERVAL.p95)} max=${ROUND(INTERVAL.max)} drawCalls mean=${Math.round(DRAWS.mean)} max=${DRAWS.max} triangles max=${TRIANGLES.max} programs=${PROGRAMS.max} textures=${TEXTURES.max}`;
  }
};
function warmUp(renderer, scene, camera) {
  const UNDO = [];
  scene.traverse((object) => {
    if (!object.visible) {
      object.visible = true;
      UNDO.push(() => object.visible = false);
    }
    if (object.frustumCulled) {
      object.frustumCulled = false;
      UNDO.push(() => object.frustumCulled = true);
    }
  });
  const RENDER = renderer.info.render;
  const COUNTS = { calls: RENDER.calls, triangles: RENDER.triangles, points: RENDER.points, lines: RENDER.lines };
  const TARGET = renderer.getRenderTarget();
  const FACE = renderer.getActiveCubeFace();
  const LEVEL = renderer.getActiveMipmapLevel();
  const SCISSOR = renderer.getScissor({
    x: 0,
    y: 0,
    z: 0,
    w: 0,
    copy(box) {
      [this.x, this.y, this.z, this.w] = [box.x, box.y, box.z, box.w];
      return this;
    }
  });
  const SCISSOR_TEST = renderer.getScissorTest();
  const SHADOW_NEEDS_UPDATE = renderer.shadowMap.needsUpdate;
  try {
    camera.updateMatrixWorld();
    renderer.setRenderTarget(null);
    renderer.setScissor(0, 0, 1, 1);
    renderer.setScissorTest(true);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    renderer.clear();
  } finally {
    renderer.setScissor(SCISSOR.x, SCISSOR.y, SCISSOR.z, SCISSOR.w);
    renderer.setScissorTest(SCISSOR_TEST);
    renderer.setRenderTarget(TARGET, FACE, LEVEL);
    renderer.shadowMap.needsUpdate = SHADOW_NEEDS_UPDATE;
    Object.assign(RENDER, COUNTS);
    for (const RESTORE of UNDO) {
      RESTORE();
    }
  }
}

// modules/three-kit/shader-chunk.js
var CHECKED_REVISIONS = "r170·r180·r186";
function replaceShaderChunk(source, target, replacement) {
  if (typeof source !== "string" || !source.includes(target)) {
    throw new Error(
      `three-kit: 셰이더에 주입 대상 "${target}"이 없습니다. three.js revision을 확인하세요(확인한 revision: ${CHECKED_REVISIONS}).`
    );
  }
  return source.replace(target, () => replacement);
}

// modules/three-kit/instance-layer.js
function injectInstanceData(shader, shaped) {
  shader.vertexShader = replaceShaderChunk(
    replaceShaderChunk(
      shader.vertexShader,
      "void main() {",
      `attribute float instanceOpacity;
varying float vInstanceOpacity;
${shaped ? "attribute float aShape;\nattribute float instanceShape;\n" : ""}void main() {`
    ),
    "#include <begin_vertex>",
    `#include <begin_vertex>
    vInstanceOpacity = instanceOpacity;${shaped ? "\n    if (abs(aShape - instanceShape) > 0.5) transformed = vec3(0.0);" : ""}`
  );
  shader.fragmentShader = replaceShaderChunk(
    replaceShaderChunk(shader.fragmentShader, "void main() {", "varying float vInstanceOpacity;\nvoid main() {"),
    "vec4 diffuseColor = vec4( diffuse, opacity );",
    "vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );"
  );
}
function mergeShapes(three, geometries) {
  const POSITIONS = [], INDICES = [], SHAPE_OF = [], SHAPES = {};
  Object.keys(geometries).forEach((name, shape) => {
    const GEOMETRY = geometries[name], POSITION = GEOMETRY.getAttribute("position"), BASE = POSITIONS.length / 3;
    SHAPES[name] = shape;
    for (let i = 0; i < POSITION.count; i++) {
      POSITIONS.push(POSITION.getX(i), POSITION.getY(i), POSITION.getZ(i));
      SHAPE_OF.push(shape);
    }
    if (GEOMETRY.index) {
      for (let i = 0; i < GEOMETRY.index.count; i++) {
        INDICES.push(BASE + GEOMETRY.index.getX(i));
      }
    } else {
      for (let i = 0; i < POSITION.count; i++) {
        INDICES.push(BASE + i);
      }
    }
  });
  const MERGED = new three.BufferGeometry();
  MERGED.setAttribute("position", new three.Float32BufferAttribute(POSITIONS, 3));
  MERGED.setAttribute("aShape", new three.Float32BufferAttribute(SHAPE_OF, 1));
  MERGED.setIndex(INDICES);
  return { geometry: MERGED, shapes: SHAPES };
}
var InstanceLayer = class {
  /**
   * @param {object} three three.js 네임스페이스
   * @param {object} options
   * @param {object} options.geometry 그릴 모양. mergeShapes의 geometry면(aShape 속성) 인스턴스마다 모양을 고릅니다.
   *   정적 속성은 이 geometry와 공유하며, 레이어는 이 geometry를 해제하지 않습니다.
   * @param {number} options.capacity 한 프레임에 쓸 수 있는 인스턴스 수. 넘치는 add()는 그리지 않습니다.
   * @param {number} [options.side] THREE.FrontSide(기본)·DoubleSide·BackSide
   * @param {boolean} [options.opaque] 불투명(깊이를 쓰고 알파를 섞지 않음). 기본은 반투명
   * @param {boolean} [options.depthTest] false면 다른 물체에 가려지지 않는 겹쳐 그림
   * @param {number} [options.order] renderOrder
   * @param {{ key: string, inject: (shader: object) => void }} [options.extend] 소비자 셰이더 주입.
   *   inject는 이 레이어의 주입 뒤에 onBeforeCompile의 shader를 받고, key는 프로그램 캐시 키에 들어갑니다.
   */
  constructor(three, { geometry, capacity, side = three.FrontSide, opaque = false, depthTest = true, order = 0, extend } = {}) {
    if (!geometry?.isBufferGeometry || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError("InstanceLayer: geometry(BufferGeometry)와 1 이상의 정수 capacity가 필요합니다");
    }
    if (extend !== void 0 && (typeof extend.key !== "string" || typeof extend.inject !== "function")) {
      throw new TypeError("InstanceLayer: extend는 { key: string, inject(shader) }입니다");
    }
    const SHAPED = Boolean(geometry.getAttribute("aShape"));
    const MATERIAL = new three.MeshBasicMaterial({
      color: 16777215,
      transparent: !opaque,
      depthWrite: opaque,
      depthTest,
      side
    });
    MATERIAL.forceSinglePass = true;
    MATERIAL.onBeforeCompile = (shader) => {
      injectInstanceData(shader, SHAPED);
      extend?.inject(shader);
    };
    MATERIAL.customProgramCacheKey = () => `three-kit-instance:${SHAPED ? "shaped" : "plain"}:${opaque ? "solid" : "blend"}:${extend?.key ?? ""}`;
    const OWN = new three.BufferGeometry();
    for (const [NAME, ATTRIBUTE] of Object.entries(geometry.attributes)) {
      OWN.setAttribute(NAME, ATTRIBUTE);
    }
    if (geometry.index) {
      OWN.setIndex(geometry.index);
    }
    this.capacity = capacity;
    this.geometry = OWN;
    this.material = MATERIAL;
    this.mesh = new three.InstancedMesh(OWN, MATERIAL, capacity);
    this.mesh.instanceColor = new three.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.opacity = new three.InstancedBufferAttribute(new Float32Array(capacity), 1);
    OWN.setAttribute("instanceOpacity", this.opacity);
    this.shape = SHAPED ? new three.InstancedBufferAttribute(new Float32Array(capacity), 1) : null;
    if (this.shape) {
      OWN.setAttribute("instanceShape", this.shape);
    }
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.matrices = this.mesh.instanceMatrix.array;
    this.colors = this.mesh.instanceColor.array;
    this.fades = this.opacity.array;
    this.shapes = this.shape?.array ?? null;
    this.count = 0;
  }
  begin() {
    this.count = 0;
  }
  /**
   * 인스턴스 하나를 씁니다. 칸이 가득 차면 넘치는 인스턴스는 그리지 않습니다.
   * @param {object} matrix THREE.Matrix4
   * @param {object} color THREE.Color
   * @param {number} opacity 0..1
   * @param {number} [shape] mergeShapes의 모양 번호(모양 합본일 때만)
   */
  add(matrix, color, opacity, shape = 0) {
    const I = this.count;
    if (I >= this.capacity) {
      return;
    }
    this.count = I + 1;
    matrix.toArray(this.matrices, I * 16);
    this.colors[I * 3] = color.r;
    this.colors[I * 3 + 1] = color.g;
    this.colors[I * 3 + 2] = color.b;
    this.fades[I] = opacity;
    if (this.shapes) {
      this.shapes[I] = shape;
    }
  }
  /** 쓴 칸까지만 GPU로 올립니다. 비어 있으면 그리지 않습니다(visible=false). */
  end() {
    const MESH = this.mesh, COUNT = this.count;
    MESH.count = COUNT;
    MESH.visible = COUNT > 0;
    if (COUNT === 0) {
      return;
    }
    const UPLOAD = (attribute) => {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, COUNT * attribute.itemSize);
      attribute.needsUpdate = true;
    };
    UPLOAD(MESH.instanceMatrix);
    UPLOAD(MESH.instanceColor);
    UPLOAD(this.opacity);
    if (this.shape) {
      UPLOAD(this.shape);
    }
  }
  /** 메시·레이어 geometry·재질을 해제하고 장면에서 뺍니다. 생성자에 넘긴 geometry는 소비자가 해제합니다. */
  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
};

// modules/three-kit/rigid-batch.js
var MAIN = "void main() {";
var SKIN_BASE = "#include <skinbase_vertex>";
var EMISSIVE = "vec3 totalEmissiveRadiance = emissive;";
var RigidBatch = class {
  /** @param {object} three three.js 네임스페이스 */
  constructor(three) {
    this.three = three;
    this.root = new three.Group();
    this.bones = [];
    this.skeleton = null;
    this.glowValues = null;
  }
  /** 물체 하나를 더하고 번호를 돌려줍니다. 뼈 수는 첫 mesh()에서 정해지므로 그 전에만 부릅니다. */
  add() {
    if (this.skeleton) {
      throw new Error("RigidBatch: mesh()를 만든 뒤에는 물체를 더할 수 없습니다");
    }
    const BONE = new this.three.Bone();
    this.root.add(BONE);
    this.bones.push(BONE);
    return this.bones.length - 1;
  }
  /** 물체 번호의 뼈(Object3D). position·quaternion·scale에 그 물체의 변환을 씁니다. 렌더러가 모든 뼈를 한 번에 올립니다. */
  bone(index) {
    return this.bones[index];
  }
  /**
   * 물체 번호가 붙은 geometry(skinIndex·skinWeight)를 이 묶음의 뼈대에 묶은 SkinnedMesh로 만들어 root에 넣습니다.
   * 메시는 몇 개든 같은 뼈대를 씁니다(재질이 다른 층마다 하나). 첫 호출에서 뼈대를 만듭니다.
   */
  mesh(geometry, material) {
    const T = this.three;
    requireSkin(geometry);
    if (!this.skeleton) {
      this.skeleton = new T.Skeleton(
        this.bones,
        this.bones.map(() => new T.Matrix4())
      );
      this.glowValues = new Float32Array(Math.ceil(this.bones.length / 4) * 4);
    }
    const MESH = new T.SkinnedMesh(geometry, material);
    MESH.bind(this.skeleton, new T.Matrix4());
    MESH.frustumCulled = false;
    this.root.add(MESH);
    return MESH;
  }
  /** 메시의 geometry를 바꿉니다(이전 것은 해제). 뼈와 재질은 그대로입니다. */
  setGeometry(mesh, geometry) {
    requireSkin(geometry);
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.boundingBox = mesh.boundingSphere = null;
  }
  /**
   * 표준 계열 재질(MeshStandardMaterial·MeshPhysicalMaterial)이 물체별 setGlow 값을 emissive에 더하게 하고 그 재질을 돌려줍니다.
   * mesh() 전에 불러도 됩니다. 값은 uniform vec4 배열(물체 4개당 1벡터)이라 바꿔도 재컴파일이 없습니다. 재질 하나는 한 묶음에만 씁니다.
   */
  glowMaterial(material) {
    material.onBeforeCompile = (shader) => {
      if (!this.glowValues) {
        throw new Error("RigidBatch: mesh()를 만들기 전에는 그릴 수 없습니다");
      }
      shader.uniforms.rigidGlow = { value: this.glowValues };
      shader.vertexShader = replaceShaderChunk(
        replaceShaderChunk(
          shader.vertexShader,
          MAIN,
          `uniform vec4 rigidGlow[${this.glowValues.length / 4}];
varying float vRigidGlow;
${MAIN}`
        ),
        SKIN_BASE,
        `${SKIN_BASE}
	int rigidBody = int(skinIndex.x);
	vRigidGlow = rigidGlow[rigidBody / 4][rigidBody % 4];`
      );
      shader.fragmentShader = replaceShaderChunk(
        replaceShaderChunk(shader.fragmentShader, MAIN, `varying float vRigidGlow;
${MAIN}`),
        EMISSIVE,
        "vec3 totalEmissiveRadiance = emissive + vec3(vRigidGlow);"
      );
    };
    material.customProgramCacheKey = () => `rigid-glow:${this.glowValues?.length ?? 0}`;
    return material;
  }
  /** 물체 번호의 emissive 가산 값(0이면 끔). glowMaterial로 감싼 재질에만 보입니다. */
  setGlow(index, value) {
    this.glowValues[index] = value;
  }
  /** 메시 geometry와 뼈 텍스처를 해제하고 장면에서 뺍니다. 재질은 소비자가 소유합니다. */
  dispose() {
    for (const CHILD of this.root.children) {
      if (CHILD.isSkinnedMesh) {
        CHILD.geometry.dispose();
      }
    }
    this.skeleton?.dispose();
    this.root.removeFromParent();
  }
};
function requireSkin(geometry) {
  if (!geometry.getAttribute("skinIndex") || !geometry.getAttribute("skinWeight")) {
    throw new Error("RigidBatch: geometry에 물체 번호(skinIndex·skinWeight)가 없습니다");
  }
}

// modules/three-kit/merge-geometry.js
function mergeColored(three, parts) {
  let vertexCount = 0, indexCount = 0;
  for (const { geometry: GEOMETRY } of parts) {
    const COUNT = GEOMETRY.getAttribute("position").count;
    vertexCount += COUNT;
    indexCount += GEOMETRY.index ? GEOMETRY.index.count : COUNT;
  }
  const POSITIONS = new Float32Array(vertexCount * 3), NORMALS = new Float32Array(vertexCount * 3), COLORS = new Float32Array(vertexCount * 3), INDICES = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount), SKINNED = optional(parts, "body"), SKIN_INDEX = SKINNED ? new Uint16Array(vertexCount * 4) : null, SKIN_WEIGHT = SKINNED ? new Float32Array(vertexCount * 4) : null, UVS = optional(parts, "uvRect") ? new Float32Array(vertexCount * 2) : null;
  const POINT = new three.Vector3(), NORMAL_MATRIX = new three.Matrix3(), PAINT = new three.Color();
  let vertexOffset = 0, indexOffset = 0;
  for (const { geometry: GEOMETRY, color: COLOR = 16777215, matrix: MATRIX, body: BODY, uvRect: UV_RECT } of parts) {
    const POSITION = GEOMETRY.getAttribute("position"), NORMAL = GEOMETRY.getAttribute("normal"), UV = GEOMETRY.getAttribute("uv"), COUNT = POSITION.count;
    PAINT.set(COLOR);
    if (MATRIX) {
      NORMAL_MATRIX.getNormalMatrix(MATRIX);
    }
    for (let i = 0; i < COUNT; i++) {
      const AT = (vertexOffset + i) * 3;
      POINT.fromBufferAttribute(POSITION, i);
      if (SKINNED) {
        SKIN_INDEX[(vertexOffset + i) * 4] = typeof BODY === "function" ? BODY(POINT) : BODY;
        SKIN_WEIGHT[(vertexOffset + i) * 4] = 1;
      }
      if (UVS) {
        UVS[(vertexOffset + i) * 2] = UV_RECT[0] + UV.getX(i) * UV_RECT[2];
        UVS[(vertexOffset + i) * 2 + 1] = UV_RECT[1] + UV.getY(i) * UV_RECT[3];
      }
      if (MATRIX) {
        POINT.applyMatrix4(MATRIX);
      }
      POSITIONS[AT] = POINT.x;
      POSITIONS[AT + 1] = POINT.y;
      POSITIONS[AT + 2] = POINT.z;
      if (NORMAL) {
        POINT.fromBufferAttribute(NORMAL, i);
        if (MATRIX) {
          POINT.applyMatrix3(NORMAL_MATRIX).normalize();
        }
        NORMALS[AT] = POINT.x;
        NORMALS[AT + 1] = POINT.y;
        NORMALS[AT + 2] = POINT.z;
      }
      COLORS[AT] = PAINT.r;
      COLORS[AT + 1] = PAINT.g;
      COLORS[AT + 2] = PAINT.b;
    }
    const MIRRORED = MATRIX ? MATRIX.determinant() < 0 : false, INDEX = GEOMETRY.index, TOTAL = INDEX ? INDEX.count : COUNT;
    for (let i = 0; i < TOTAL; i += 3) {
      const A = INDEX ? INDEX.getX(i) : i, B = INDEX ? INDEX.getX(i + 1) : i + 1, C = INDEX ? INDEX.getX(i + 2) : i + 2;
      INDICES[indexOffset + i] = vertexOffset + A;
      INDICES[indexOffset + i + 1] = vertexOffset + (MIRRORED ? C : B);
      INDICES[indexOffset + i + 2] = vertexOffset + (MIRRORED ? B : C);
    }
    vertexOffset += COUNT;
    indexOffset += TOTAL;
  }
  const MERGED = new three.BufferGeometry();
  MERGED.setAttribute("position", new three.BufferAttribute(POSITIONS, 3));
  MERGED.setAttribute("normal", new three.BufferAttribute(NORMALS, 3));
  MERGED.setAttribute("color", new three.BufferAttribute(COLORS, 3));
  if (SKINNED) {
    MERGED.setAttribute("skinIndex", new three.BufferAttribute(SKIN_INDEX, 4));
    MERGED.setAttribute("skinWeight", new three.BufferAttribute(SKIN_WEIGHT, 4));
  }
  if (UVS) {
    MERGED.setAttribute("uv", new three.BufferAttribute(UVS, 2));
  }
  MERGED.setIndex(new three.BufferAttribute(INDICES, 1));
  MERGED.computeBoundingBox();
  MERGED.computeBoundingSphere();
  return MERGED;
}
function optional(parts, key) {
  const COUNT = parts.filter((part) => part[key] !== void 0).length;
  if (COUNT > 0 && COUNT < parts.length) {
    throw new Error(`mergeColored: ${key}가 일부 도형에만 있습니다(${COUNT}/${parts.length})`);
  }
  return COUNT > 0;
}
var PartList = class {
  /** @param {object} three three.js 네임스페이스 */
  constructor(three) {
    this.three = three;
    this.parts = [];
    this.cache = /* @__PURE__ */ new Map();
    this.object = new three.Object3D();
    this.body = void 0;
  }
  /** 같은 key의 geometry는 한 번만 만듭니다. 이 목록이 소유하며 build()에서 해제합니다. */
  geometry(key, factory) {
    if (!this.cache.has(key)) {
      this.cache.set(key, factory());
    }
    return this.cache.get(key);
  }
  /** geometry 하나를 변환과 색을 붙여 추가합니다. */
  add(geometry, color, { position, rotation, scale, parent, body = this.body, uvRect } = {}) {
    const OBJECT = this.object;
    OBJECT.position.set(...position ?? [0, 0, 0]);
    OBJECT.rotation.set(...rotation ?? [0, 0, 0]);
    OBJECT.scale.set(...scale ?? [1, 1, 1]);
    OBJECT.updateMatrix();
    const MATRIX = parent ? new this.three.Matrix4().multiplyMatrices(parent, OBJECT.matrix) : OBJECT.matrix.clone();
    this.parts.push({ geometry, color, matrix: MATRIX, body, uvRect });
  }
  box(width, height, depth, color, x = 0, y = 0, z = 0, options) {
    const GEOMETRY = this.geometry(
      `box:${width}:${height}:${depth}`,
      () => new this.three.BoxGeometry(width, height, depth)
    );
    this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
  }
  /** 원기둥(옆 12분할). options.top은 윗면 반지름(기본 radius). */
  cylinder(radius, height, color, x = 0, y = 0, z = 0, options = {}) {
    const TOP = options.top ?? radius, GEOMETRY = this.geometry(
      `cylinder:${radius}:${TOP}:${height}`,
      () => new this.three.CylinderGeometry(TOP, radius, height, 12)
    );
    this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
  }
  /** 구(가로 options.segments 기본 12, 세로 10분할). */
  sphere(radius, color, x = 0, y = 0, z = 0, options = {}) {
    const SEGMENTS = options.segments ?? 12, GEOMETRY = this.geometry(
      `sphere:${radius}:${SEGMENTS}`,
      () => new this.three.SphereGeometry(radius, SEGMENTS, 10)
    );
    this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
  }
  /** 합친 geometry를 돌려주고 임시 geometry를 해제합니다. 목록은 비워 다시 쓸 수 있습니다. */
  build() {
    const MERGED = mergeColored(this.three, this.parts);
    for (const GEOMETRY of this.cache.values()) {
      GEOMETRY.dispose();
    }
    this.cache.clear();
    this.parts.length = 0;
    return MERGED;
  }
};
export {
  InstanceLayer,
  PartList,
  RenderStats,
  RigidBatch,
  mergeColored,
  mergeShapes,
  replaceShaderChunk,
  warmUp
};
