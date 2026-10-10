const bound = (value, name, min = 1, max = 100000) => { if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} outside supported range`); return value; };
const field = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
const DIAGNOSTIC_VISIBILITIES = new Set(['log', 'notice', 'blocking', 'fatal']);
const diagnosticVisibility = (visibility, fatal) => {
  if (visibility !== undefined && !DIAGNOSTIC_VISIBILITIES.has(visibility)) {
    throw new TypeError('visibility must be log, notice, blocking, or fatal');
  }
  // `fatal` predates visibility and remains authoritative for existing consumers.
  return fatal || visibility === 'fatal' ? 'fatal' : visibility ?? 'blocking';
};
/** Best-effort text redaction, not a guarantee that a report is safe to publish. Review before sharing. */
export function redactDiagnostic(value, limit = 1600) {
  bound(limit, 'limit'); const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return text.replace(/\{[\s\S]*\}/g, '[structured data omitted]')
    .replace(/(?:["']?(?:password|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/\b(?:https?|blob|file):[^\r\n)\]<>"']+/gi, '[source]')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?!\/)[A-Za-z0-9_.~-]+\/)[^\r\n)\]<>"']*/g, '[local source]')
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)/gi, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
}
/** @typedef {'log'|'notice'|'blocking'|'fatal'} DiagnosticVisibility */
/**
 * Fixed-capacity local diagnostic ring. No storage, network, game state, or automatic global installation.
 * Reports without visibility remain blocking for compatibility; `fatal: true` remains fatal.
 */
export class DiagnosticRing {
  constructor({ capacity = 20, now = () => performance.now(), release = '' } = {}) {
    bound(capacity, 'capacity', 1, 1000); if (typeof now !== 'function') throw new TypeError('now must be function');
    this.capacity = capacity; this.now = now; this.release = redactDiagnostic(release, 160); this.records = new Array(capacity); this.start = 0; this.size = 0;
    this.total = 0; this.dropped = 0; this._lastMs = 0; this._busy = false; this._listeners = new Set();
  }
  /** @param {unknown} error @param {{kind?: string, visibility?: DiagnosticVisibility, fatal?: boolean, origin?: string, source?: string, line?: number, column?: number, workerTimeMs?: number|null, cause?: unknown}} options */
  report(error, { kind = 'exception', visibility, fatal = false, origin = 'main', source = '', line = 0, column = 0, workerTimeMs = null, cause = '' } = {}) {
    if (this._busy) { this.dropped++; return null; } this._busy = true;
    try {
      const severity = diagnosticVisibility(visibility, Boolean(fatal));
      const at = this.now(); if (!Number.isFinite(at)) throw new TypeError('diagnostic clock must be finite'); this._lastMs = Math.max(this._lastMs, at);
      const record = { kind: redactDiagnostic(kind, 64), visibility: severity, fatal: severity === 'fatal', origin: redactDiagnostic(origin, 64),
        message: redactDiagnostic(typeof error === 'string' ? error : field(error, 'message') ?? 'Non-text error omitted', 500),
        stack: redactDiagnostic(field(error, 'stack'), 1800), source: redactDiagnostic(source, 160),
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0, column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
        workerTimeMs: Number.isFinite(workerTimeMs) && workerTimeMs >= 0 ? workerTimeMs : null,
        cause: redactDiagnostic(typeof cause === 'string' && cause ? cause : field(field(error, 'cause'), 'message') ?? field(error, 'cause'), 300), firstMs: this._lastMs, lastMs: this._lastMs, count: 1 };
      this.total++;
      for (let i = 0; i < this.size; i++) {
        const old = this.records[(this.start + i) % this.capacity];
        if (old.kind === record.kind && old.message === record.message && old.stack === record.stack && old.visibility === record.visibility && old.origin === record.origin && old.source === record.source && old.line === record.line && old.column === record.column) { old.count++; old.lastMs = record.lastMs; return { ...old }; }
      }
      if (this.size === this.capacity) { this.records[this.start] = record; this.start = (this.start + 1) % this.capacity; this.dropped++; }
      else { this.records[(this.start + this.size) % this.capacity] = record; this.size++; }
      return { ...record };
    } finally { this._busy = false; }
  }
  snapshot() {
    const errors = []; for (let i = 0; i < this.size; i++) errors.push({ ...this.records[(this.start + i) % this.capacity] });
    const counts = { log: 0, notice: 0, blocking: 0, fatal: 0 };
    for (const record of errors) counts[record.visibility] += record.count;
    return {
      format: 'bloom-gamekit diagnostics v2', release: this.release, total: this.total, dropped: this.dropped,
      counts: { total: this.total, retained: Object.values(counts).reduce((sum, count) => sum + count, 0), ...counts },
      blockerCount: counts.blocking + counts.fatal, errors,
    };
  }
  format() { return JSON.stringify(this.snapshot(), null, 2); }
  /** Does not swallow errors or replace onerror. Caller decides whether a fatal error should halt gameplay. */
  installGlobal(target, { onReport } = {}) {
    if (!target?.addEventListener || !target?.removeEventListener) throw new TypeError('EventTarget required');
    if (onReport !== undefined && typeof onReport !== 'function') throw new TypeError('onReport must be function');
    const report = (error, kind) => { try { const record = this.report(error, { kind }); onReport?.(record); } catch { this.dropped++; } };
    const error = event => report(event.error ?? event.message, 'global-error');
    const rejection = event => report(event.reason, 'unhandled-rejection');
    target.addEventListener('error', error); target.addEventListener('unhandledrejection', rejection);
    let active = true; const dispose = () => { if (!active) return; active = false; target.removeEventListener('error', error); target.removeEventListener('unhandledrejection', rejection); this._listeners.delete(dispose); };
    this._listeners.add(dispose); return dispose;
  }
  clear() { this.records.fill(undefined); this.size = this.start = this.total = this.dropped = 0; }
  dispose() { for (const dispose of this._listeners) dispose(); this.clear(); }
}
const profileName = value => { if (typeof value !== 'string' || !value || value.length > 96) throw new TypeError('profile stage name must be a non-empty string up to 96 characters'); return redactDiagnostic(value, 96); };
const profileMeta = value => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('profile metadata must be an object');
  const entries = Object.entries(value); if (entries.length > 8) throw new RangeError('profile metadata supports up to 8 fields');
  const result = {};
  for (const [key, item] of entries) {
    if (typeof key !== 'string' || !key || key.length > 48) throw new TypeError('profile metadata key is invalid');
    if (typeof item === 'string') result[redactDiagnostic(key, 48)] = redactDiagnostic(item, 160);
    else if (typeof item === 'boolean' || item === null) result[redactDiagnostic(key, 48)] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) result[redactDiagnostic(key, 48)] = item;
    else throw new TypeError('profile metadata values must be primitive');
  }
  return result;
};
const profileSummary = values => {
  if (!values.length) return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  values.sort((a, b) => a - b);
  return { count: values.length, totalMs, minMs: values[0], maxMs: values[values.length - 1], p50Ms: values[Math.floor((values.length - 1) * .5)], p95Ms: values[Math.floor((values.length - 1) * .95)] };
};
/**
 * Bounded, opt-in synchronous performance samples for local diagnostics.
 * It retains only stage durations/counters and caller-approved primitive metadata;
 * it never stores game state, snapshots, DOM objects, or sends data anywhere.
 */
export class PerformanceProfiler {
  constructor({ capacity = 120, now = () => performance.now(), maxStages = 64 } = {}) {
    bound(capacity, 'capacity', 1, 1000); bound(maxStages, 'maxStages', 1, 256); if (typeof now !== 'function') throw new TypeError('now must be function');
    this.capacity = capacity; this.maxStages = maxStages; this.now = now; this.enabled = false; this.frames = new Array(capacity); this.frameStart = 0; this.frameCount = 0; this.current = null; this.sequence = 0;
  }
  setEnabled(enabled) { if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean'); this.enabled = enabled; if (!enabled) this.current = null; return enabled; }
  beginFrame(meta = {}) {
    if (!this.enabled) return false; if (this.current) throw new Error('profile frame already active'); const atMs = this.now(); if (!Number.isFinite(atMs)) throw new TypeError('profile clock must be finite');
    this.current = { sequence: ++this.sequence, startedAtMs: atMs, meta: profileMeta(meta), stages: new Map(), counts: new Map() }; return true;
  }
  stage(name, durationMs, metadata = {}) {
    if (!this.enabled || !this.current) return false; const key = profileName(name), value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('profile duration must be finite and non-negative');
    let stage = this.current.stages.get(key); if (!stage) { if (this.current.stages.size >= this.maxStages) return false; stage = { ms: 0, calls: 0, maxMs: 0, metadata: {} }; this.current.stages.set(key, stage); }
    stage.ms += value; stage.calls++; stage.maxMs = Math.max(stage.maxMs, value); Object.assign(stage.metadata, profileMeta(metadata)); return true;
  }
  count(name, value = 1) {
    if (!this.enabled || !this.current) return false; const key = profileName(name), amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError('profile count must be finite and non-negative');
    if (!this.current.counts.has(key) && this.current.counts.size >= this.maxStages) return false;
    this.current.counts.set(key, (this.current.counts.get(key) || 0) + amount); return true;
  }
  measure(name, operation, metadata = {}) {
    if (typeof operation !== 'function') throw new TypeError('profile operation must be function'); if (!this.enabled || !this.current) return operation();
    const startedAtMs = this.now(); try { return operation(); } finally { const endedAtMs = this.now(); this.stage(name, Math.max(0, endedAtMs - startedAtMs), metadata); }
  }
  endFrame(meta = {}) {
    if (!this.enabled || !this.current) return null; const current = this.current; this.current = null; const endedAtMs = this.now();
    if (!Number.isFinite(endedAtMs)) throw new TypeError('profile clock must be finite'); const frame = { sequence: current.sequence, durationMs: Math.max(0, endedAtMs - current.startedAtMs), meta: { ...current.meta, ...profileMeta(meta) }, stages: Object.fromEntries([...current.stages].map(([name, value]) => [name, { ms: value.ms, calls: value.calls, maxMs: value.maxMs, metadata: { ...value.metadata } }])), counts: Object.fromEntries(current.counts) };
    if (this.frameCount === this.capacity) { this.frames[this.frameStart] = frame; this.frameStart = (this.frameStart + 1) % this.capacity; }
    else { this.frames[(this.frameStart + this.frameCount) % this.capacity] = frame; this.frameCount++; }
    return frame;
  }
  clear() { this.frames.fill(undefined); this.frameStart = this.frameCount = 0; this.current = null; }
  snapshot({ limit = Math.min(30, this.capacity) } = {}) {
    bound(limit, 'limit', 0, this.capacity);
    const retained = Array.from({ length: this.frameCount }, (_, index) => this.frames[(this.frameStart + index) % this.capacity]);
    const frames = retained.slice(retained.length - Math.min(limit, retained.length)).map(frame => ({ sequence: frame.sequence, durationMs: frame.durationMs, meta: { ...frame.meta }, stages: Object.fromEntries(Object.entries(frame.stages).map(([name, value]) => [name, { ms: value.ms, calls: value.calls, maxMs: value.maxMs, metadata: { ...value.metadata } }])), counts: { ...frame.counts } }));
    const stageValues = new Map(); for (const frame of retained) { for (const [name, stage] of Object.entries(frame.stages)) { const values = stageValues.get(name) || []; values.push(stage.ms); stageValues.set(name, values); } }
    return { enabled: this.enabled, capacity: this.capacity, retainedFrames: this.frameCount, frames, summary: { frames: profileSummary(retained.map(frame => frame.durationMs)), stages: Object.fromEntries([...stageValues].map(([name, values]) => [name, profileSummary(values)])) } };
  }
  dispose() { this.enabled = false; this.clear(); }
}
/** A caller-supplied textarea remains selected if clipboard is denied. Never claims copy success on selection alone. */
export async function copyDiagnostic(text, { clipboard, textarea } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be string');
  if (clipboard?.writeText) try { await clipboard.writeText(text); return { copied: true, method: 'clipboard' }; } catch { /* manual selection below */ }
  if (textarea?.select) { textarea.value = text; textarea.focus(); textarea.select(); return { copied: false, method: 'selection', text }; }
  return { copied: false, method: 'text', text };
}
/** Delegates all history/seek ownership to a replay adapter; never retains simulation snapshots. */
export class ReplayTimeline {
  constructor(adapter) {
    for (const name of ['read', 'seek', 'setPlaying']) if (typeof adapter?.[name] !== 'function') throw new TypeError(`replay adapter.${name} required`);
    this.adapter = adapter;
  }
  readInto(out) {
    const state = this.adapter.read();
    for (const name of ['tick', 'firstTick', 'lastTick']) if (!Number.isSafeInteger(state[name]) || state[name] < 0) throw new RangeError(`invalid replay ${name}`);
    if (state.firstTick > state.lastTick || state.tick < state.firstTick || state.tick > state.lastTick) throw new RangeError('invalid replay bounds');
    out.tick = state.tick; out.firstTick = state.firstTick; out.lastTick = state.lastTick; out.playing = Boolean(state.playing); return out;
  }
  seek(tick) { const state = this.readInto({}); if (!Number.isSafeInteger(tick)) throw new RangeError('tick must be safe integer'); return this.adapter.seek(Math.max(state.firstTick, Math.min(state.lastTick, tick))); }
  step(delta = 1) { if (!Number.isSafeInteger(delta)) throw new RangeError('delta must be safe integer'); const state = this.readInto({}); this.adapter.setPlaying(false); return this.seek(state.tick + delta); }
  setPlaying(playing) { if (typeof playing !== 'boolean') throw new TypeError('playing must be boolean'); return this.adapter.setPlaying(playing); }
}
/** Explicit field selectors expose only chosen comparable values, not an automatic world dump. */
export function compareStateFields(left, right, fields, { maxDifferences = 100 } = {}) {
  bound(maxDifferences, 'maxDifferences'); if (!Array.isArray(fields)) throw new TypeError('fields must be array');
  const differences = []; let mismatches = 0;
  for (const field of fields) {
    if (typeof field?.name !== 'string' || typeof field?.read !== 'function' || (field.equal !== undefined && typeof field.equal !== 'function')) throw new TypeError('field name/read required');
    const a = field.read(left), b = field.read(right), equal = field.equal ? field.equal(a, b) : Object.is(a, b);
    if (!equal) { mismatches++; if (differences.length < maxDifferences) differences.push({ field: redactDiagnostic(field.name, 160), left: redactDiagnostic(a, 300), right: redactDiagnostic(b, 300) }); }
  }
  return { equal: mismatches === 0, mismatches, truncated: mismatches > differences.length, differences };
}
