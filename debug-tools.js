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
var FrameMetrics = class {
  constructor({ capacity = 240, stages = [], counters = [], now = () => performance.now() } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 3600 || typeof now !== "function") {
      throw new RangeError("Invalid frame metric capacity or clock");
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
    if (!Number.isFinite(timestampMs) || this.lastTimestampMs !== null && timestampMs < this.lastTimestampMs) {
      throw new RangeError("Frame timestamp must be finite and monotonic");
    }
    if (this.active) {
      throw new Error("endFrame required");
    }
    this.current.fill(0);
    this.current[0] = timestampMs;
    if (this.size > 0 && this.lastTimestampMs !== null) {
      const PREVIOUS = (this.write - 1 + this.capacity) % this.capacity * this.stride;
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
  snapshot({ limit = 0, slowFrameMs = 50, slowLimit = 3 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.capacity || !Number.isSafeInteger(slowLimit) || slowLimit < 0 || slowLimit > this.capacity || !Number.isFinite(slowFrameMs) || slowFrameMs < 0) {
      throw new RangeError("Invalid snapshot limits");
    }
    const FRAMES = [];
    for (let offset = 0; offset < this.size; offset++) {
      const INDEX = (this.write - this.size + offset + this.capacity) % this.capacity * this.stride, FRAME = {
        sequence: this.sequence - this.size + offset + 1,
        timestampMs: this.samples[INDEX],
        intervalMs: this.samples[INDEX + 1],
        cpuMs: this.samples[INDEX + 2],
        stagesMs: {},
        counts: {}
      };
      for (const [NAME, COLUMN] of this.stageIndex) {
        FRAME.stagesMs[NAME] = this.samples[INDEX + COLUMN];
      }
      for (const [NAME, COLUMN] of this.counterIndex) {
        FRAME.counts[NAME] = this.samples[INDEX + COLUMN];
      }
      FRAMES.push(FRAME);
    }
    const INTERVALS = FRAMES.map((frame) => frame.intervalMs).filter((value) => value > 0), WINDOW_MS = INTERVALS.reduce((sum, value) => sum + value, 0);
    return {
      format: "bloom numeric frame metrics v1",
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
      slowFrames: FRAMES.filter((frame) => frame.intervalMs >= slowFrameMs).sort((a, b) => b.intervalMs - a.intervalMs).slice(0, slowLimit),
      frames: limit ? FRAMES.slice(-limit) : []
    };
  }
};

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
  redactDiagnostic
};
