// modules/debug-tools/index.js
var bound = (value, name, min = 1, max = 1e5) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} outside supported range`);
  return value;
};
var field = (object, key) => {
  try {
    return object?.[key];
  } catch {
    return void 0;
  }
};
function redactDiagnostic(value, limit = 1600) {
  bound(limit, "limit");
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return text.replace(/\{[\s\S]*\}/g, "[structured data omitted]").replace(/(?:["']?(?:password|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi, "[redacted]").replace(/\b(?:https?|blob|file):[^\r\n)\]<>"']+/gi, "[source]").replace(/(?:[A-Za-z]:[\\/]|\/(?!\/)[A-Za-z0-9_.~-]+\/)[^\r\n)\]<>"']*/g, "[local source]").replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)/gi, "[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit);
}
var DiagnosticRing = class {
  constructor({ capacity = 20, now = () => performance.now(), release = "" } = {}) {
    bound(capacity, "capacity", 1, 1e3);
    if (typeof now !== "function") throw new TypeError("now must be function");
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
  report(error, { kind = "exception", fatal = false, origin = "main", source = "", line = 0, column = 0, workerTimeMs = null, cause = "" } = {}) {
    if (this._busy) {
      this.dropped++;
      return null;
    }
    this._busy = true;
    try {
      const at = this.now();
      if (!Number.isFinite(at)) throw new TypeError("diagnostic clock must be finite");
      this._lastMs = Math.max(this._lastMs, at);
      const record = {
        kind: redactDiagnostic(kind, 64),
        fatal: Boolean(fatal),
        origin: redactDiagnostic(origin, 64),
        message: redactDiagnostic(typeof error === "string" ? error : field(error, "message") ?? "Non-text error omitted", 500),
        stack: redactDiagnostic(field(error, "stack"), 1800),
        source: redactDiagnostic(source, 160),
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
        column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
        workerTimeMs: Number.isFinite(workerTimeMs) && workerTimeMs >= 0 ? workerTimeMs : null,
        cause: redactDiagnostic(typeof cause === "string" && cause ? cause : field(field(error, "cause"), "message") ?? field(error, "cause"), 300),
        firstMs: this._lastMs,
        lastMs: this._lastMs,
        count: 1
      };
      this.total++;
      for (let i = 0; i < this.size; i++) {
        const old = this.records[(this.start + i) % this.capacity];
        if (old.kind === record.kind && old.message === record.message && old.stack === record.stack && old.fatal === record.fatal && old.origin === record.origin && old.source === record.source && old.line === record.line && old.column === record.column) {
          old.count++;
          old.lastMs = record.lastMs;
          return { ...old };
        }
      }
      if (this.size === this.capacity) {
        this.records[this.start] = record;
        this.start = (this.start + 1) % this.capacity;
        this.dropped++;
      } else {
        this.records[(this.start + this.size) % this.capacity] = record;
        this.size++;
      }
      return { ...record };
    } finally {
      this._busy = false;
    }
  }
  snapshot() {
    const errors = [];
    for (let i = 0; i < this.size; i++) errors.push({ ...this.records[(this.start + i) % this.capacity] });
    return { format: "bloom-gamekit diagnostics v1", release: this.release, total: this.total, dropped: this.dropped, errors };
  }
  format() {
    return JSON.stringify(this.snapshot(), null, 2);
  }
  /** Does not swallow errors or replace onerror. Caller decides whether a fatal error should halt gameplay. */
  installGlobal(target, { onReport } = {}) {
    if (!target?.addEventListener || !target?.removeEventListener) throw new TypeError("EventTarget required");
    if (onReport !== void 0 && typeof onReport !== "function") throw new TypeError("onReport must be function");
    const report = (error2, kind) => {
      try {
        const record = this.report(error2, { kind });
        onReport?.(record);
      } catch {
        this.dropped++;
      }
    };
    const error = (event) => report(event.error ?? event.message, "global-error");
    const rejection = (event) => report(event.reason, "unhandled-rejection");
    target.addEventListener("error", error);
    target.addEventListener("unhandledrejection", rejection);
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      target.removeEventListener("error", error);
      target.removeEventListener("unhandledrejection", rejection);
      this._listeners.delete(dispose);
    };
    this._listeners.add(dispose);
    return dispose;
  }
  clear() {
    this.records.fill(void 0);
    this.size = this.start = this.total = this.dropped = 0;
  }
  dispose() {
    for (const dispose of this._listeners) dispose();
    this.clear();
  }
};
var profileName = (value) => {
  if (typeof value !== "string" || !value || value.length > 96) throw new TypeError("profile stage name must be a non-empty string up to 96 characters");
  return redactDiagnostic(value, 96);
};
var profileMeta = (value) => {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("profile metadata must be an object");
  const entries = Object.entries(value);
  if (entries.length > 8) throw new RangeError("profile metadata supports up to 8 fields");
  const result = {};
  for (const [key, item] of entries) {
    if (typeof key !== "string" || !key || key.length > 48) throw new TypeError("profile metadata key is invalid");
    if (typeof item === "string") result[redactDiagnostic(key, 48)] = redactDiagnostic(item, 160);
    else if (typeof item === "boolean" || item === null) result[redactDiagnostic(key, 48)] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[redactDiagnostic(key, 48)] = item;
    else throw new TypeError("profile metadata values must be primitive");
  }
  return result;
};
var percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};
var profileSummary = (values) => {
  if (!values.length) return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  return { count: values.length, totalMs: values.reduce((sum, value) => sum + value, 0), minMs: Math.min(...values), maxMs: Math.max(...values), p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
};
var PerformanceProfiler = class {
  constructor({ capacity = 120, now = () => performance.now(), maxStages = 64 } = {}) {
    bound(capacity, "capacity", 1, 1e3);
    bound(maxStages, "maxStages", 1, 256);
    if (typeof now !== "function") throw new TypeError("now must be function");
    this.capacity = capacity;
    this.maxStages = maxStages;
    this.now = now;
    this.enabled = false;
    this.frames = [];
    this.current = null;
    this.sequence = 0;
  }
  setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
    this.enabled = enabled;
    if (!enabled) this.current = null;
    return enabled;
  }
  beginFrame(meta = {}) {
    if (!this.enabled) return false;
    if (this.current) throw new Error("profile frame already active");
    const atMs = this.now();
    if (!Number.isFinite(atMs)) throw new TypeError("profile clock must be finite");
    this.current = { sequence: ++this.sequence, startedAtMs: atMs, meta: profileMeta(meta), stages: /* @__PURE__ */ new Map(), counts: /* @__PURE__ */ new Map() };
    return true;
  }
  stage(name, durationMs, metadata = {}) {
    if (!this.enabled || !this.current) return false;
    const key = profileName(name), value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) throw new RangeError("profile duration must be finite and non-negative");
    let stage = this.current.stages.get(key);
    if (!stage) {
      if (this.current.stages.size >= this.maxStages) return false;
      stage = { ms: 0, calls: 0, maxMs: 0, metadata: {} };
      this.current.stages.set(key, stage);
    }
    stage.ms += value;
    stage.calls++;
    stage.maxMs = Math.max(stage.maxMs, value);
    Object.assign(stage.metadata, profileMeta(metadata));
    return true;
  }
  count(name, value = 1) {
    if (!this.enabled || !this.current) return false;
    const key = profileName(name), amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError("profile count must be finite and non-negative");
    this.current.counts.set(key, (this.current.counts.get(key) || 0) + amount);
    return true;
  }
  measure(name, operation, metadata = {}) {
    if (typeof operation !== "function") throw new TypeError("profile operation must be function");
    if (!this.enabled || !this.current) return operation();
    const startedAtMs = this.now();
    try {
      return operation();
    } finally {
      const endedAtMs = this.now();
      this.stage(name, Math.max(0, endedAtMs - startedAtMs), metadata);
    }
  }
  endFrame(meta = {}) {
    if (!this.enabled || !this.current) return null;
    const current = this.current;
    this.current = null;
    const endedAtMs = this.now();
    if (!Number.isFinite(endedAtMs)) throw new TypeError("profile clock must be finite");
    const frame = { sequence: current.sequence, durationMs: Math.max(0, endedAtMs - current.startedAtMs), meta: { ...current.meta, ...profileMeta(meta) }, stages: Object.fromEntries([...current.stages].map(([name, value]) => [name, { ms: value.ms, calls: value.calls, maxMs: value.maxMs, metadata: { ...value.metadata } }])), counts: Object.fromEntries(current.counts) };
    this.frames.push(frame);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    return frame;
  }
  clear() {
    this.frames.length = 0;
    this.current = null;
  }
  snapshot({ limit = Math.min(30, this.capacity) } = {}) {
    bound(limit, "limit", 0, this.capacity);
    const frames = this.frames.slice(-limit).map((frame) => ({ sequence: frame.sequence, durationMs: frame.durationMs, meta: { ...frame.meta }, stages: Object.fromEntries(Object.entries(frame.stages).map(([name, value]) => [name, { ms: value.ms, calls: value.calls, maxMs: value.maxMs, metadata: { ...value.metadata } }])), counts: { ...frame.counts } }));
    const stageValues = /* @__PURE__ */ new Map();
    for (const frame of this.frames) {
      for (const [name, stage] of Object.entries(frame.stages)) {
        const values = stageValues.get(name) || [];
        values.push(stage.ms);
        stageValues.set(name, values);
      }
    }
    return { enabled: this.enabled, capacity: this.capacity, retainedFrames: this.frames.length, frames, summary: { frames: profileSummary(this.frames.map((frame) => frame.durationMs)), stages: Object.fromEntries([...stageValues].map(([name, values]) => [name, profileSummary(values)])) } };
  }
  dispose() {
    this.enabled = false;
    this.clear();
  }
};
async function copyDiagnostic(text, { clipboard, textarea } = {}) {
  if (typeof text !== "string") throw new TypeError("text must be string");
  if (clipboard?.writeText) try {
    await clipboard.writeText(text);
    return { copied: true, method: "clipboard" };
  } catch {
  }
  if (textarea?.select) {
    textarea.value = text;
    textarea.focus();
    textarea.select();
    return { copied: false, method: "selection", text };
  }
  return { copied: false, method: "text", text };
}
var ReplayTimeline = class {
  constructor(adapter) {
    for (const name of ["read", "seek", "setPlaying"]) if (typeof adapter?.[name] !== "function") throw new TypeError(`replay adapter.${name} required`);
    this.adapter = adapter;
  }
  readInto(out) {
    const state = this.adapter.read();
    for (const name of ["tick", "firstTick", "lastTick"]) if (!Number.isSafeInteger(state[name]) || state[name] < 0) throw new RangeError(`invalid replay ${name}`);
    if (state.firstTick > state.lastTick || state.tick < state.firstTick || state.tick > state.lastTick) throw new RangeError("invalid replay bounds");
    out.tick = state.tick;
    out.firstTick = state.firstTick;
    out.lastTick = state.lastTick;
    out.playing = Boolean(state.playing);
    return out;
  }
  seek(tick) {
    const state = this.readInto({});
    if (!Number.isSafeInteger(tick)) throw new RangeError("tick must be safe integer");
    return this.adapter.seek(Math.max(state.firstTick, Math.min(state.lastTick, tick)));
  }
  step(delta = 1) {
    if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be safe integer");
    const state = this.readInto({});
    this.adapter.setPlaying(false);
    return this.seek(state.tick + delta);
  }
  setPlaying(playing) {
    if (typeof playing !== "boolean") throw new TypeError("playing must be boolean");
    return this.adapter.setPlaying(playing);
  }
};
function compareStateFields(left, right, fields, { maxDifferences = 100 } = {}) {
  bound(maxDifferences, "maxDifferences");
  if (!Array.isArray(fields)) throw new TypeError("fields must be array");
  const differences = [];
  let mismatches = 0;
  for (const field2 of fields) {
    if (typeof field2?.name !== "string" || typeof field2?.read !== "function" || field2.equal !== void 0 && typeof field2.equal !== "function") throw new TypeError("field name/read required");
    const a = field2.read(left), b = field2.read(right), equal = field2.equal ? field2.equal(a, b) : Object.is(a, b);
    if (!equal) {
      mismatches++;
      if (differences.length < maxDifferences) differences.push({ field: redactDiagnostic(field2.name, 160), left: redactDiagnostic(a, 300), right: redactDiagnostic(b, 300) });
    }
  }
  return { equal: mismatches === 0, mismatches, truncated: mismatches > differences.length, differences };
}
export {
  DiagnosticRing,
  PerformanceProfiler,
  ReplayTimeline,
  compareStateFields,
  copyDiagnostic,
  redactDiagnostic
};
