const MODES = new Set(['continuous', 'rollback', 'load', 'reset', 'teleport', 'join', 'resync']);

function copyInput(input, seen = new Set()) {
  if (input instanceof Uint8Array) return input.slice();
  if (input instanceof DataView) return new DataView(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  if (ArrayBuffer.isView(input)) return new input.constructor(input);
  if (input instanceof ArrayBuffer) return input.slice(0);
  if (Array.isArray(input) || input && typeof input === 'object' && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
    if (seen.has(input)) throw new TypeError('preview input cannot contain cycles');
    seen.add(input);
    const copy = Array.isArray(input) ? new Array(input.length) : {};
    for (const key of Object.keys(input)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('unsafe preview input key');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('preview input accessors are not supported');
      copy[key] = copyInput(descriptor.value, seen);
    }
    seen.delete(input);
    return copy;
  }
  if (input === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof input)) return input;
  throw new TypeError('preview input must be immutable plain data or bytes');
}

function byteLength(value, seen = new Set()) {
  if (value == null) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object' || seen.has(value)) return 8;
  seen.add(value);
  let size = Array.isArray(value) ? 8 : 16;
  for (const [key, item] of Object.entries(value)) size += key.length * 2 + byteLength(item, seen);
  return size;
}

/**
 * Optional detached local-input prediction. It never reads or mutates the live session.
 * The caller supplies confirmed detached snapshots and a fork factory whose step uses
 * the same game simulation update while suppressing all external side effects.
 */
export class LocalInputPreview {
  #forkFactory; #cloneSnapshot; #readEntities; #presentation; #maxPending; #maxFutureTicks; #maxAgeMs;
  #snapshot = null; #fork = null; #pending = []; #revision = -1; #tick = -1; #epoch = -1; #generation = 0;
  #sequence = 0; #timeMs = -Infinity; #disposed = false; #enabled = true;
  #metrics = { snapshotBytes: 0, correctionBytes: 0, replayBytes: 0, snapshotCloneMs: 0, forkMs: 0, replayMs: 0, replayedInputs: 0, corrections: 0, correctionMs: 0, previewPublishes: 0, rejectedEpoch: 0, rejectedHorizon: 0, rejectedAge: 0, rejectedCapacity: 0 };

  /** @param {{createFork:(snapshot:unknown)=>{step:(input:unknown,context:object)=>void},cloneSnapshot?:(snapshot:unknown)=>unknown,readEntities:(fork:unknown)=>Array, presentation?:{selectPreview:(ids:Array)=>void,capturePreview:(packet:object,nowMs:number)=>boolean,clearPreview?:()=>void},maxPendingInputs?:number,maxFutureTicks?:number,maxAgeMs?:number}} options */
  constructor({ createFork, cloneSnapshot = value => structuredClone(value), readEntities, presentation,
    maxPendingInputs = 8, maxFutureTicks = 8, maxAgeMs = 250 } = {}) {
    if (typeof createFork !== 'function' || typeof readEntities !== 'function') throw new TypeError('preview fork and entity reader are required');
    if (presentation && (typeof presentation.selectPreview !== 'function' || typeof presentation.capturePreview !== 'function')) throw new TypeError('presentation preview capability');
    if (!Number.isInteger(maxPendingInputs) || maxPendingInputs < 1 || maxPendingInputs > 64) throw new RangeError('maxPendingInputs');
    if (!Number.isInteger(maxFutureTicks) || maxFutureTicks < 1 || maxFutureTicks > 64) throw new RangeError('maxFutureTicks');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 2000) throw new RangeError('maxAgeMs');
    this.#forkFactory = createFork; this.#cloneSnapshot = cloneSnapshot; this.#readEntities = readEntities;
    this.#presentation = presentation; this.#maxPending = maxPendingInputs; this.#maxFutureTicks = maxFutureTicks; this.#maxAgeMs = maxAgeMs;
    if (typeof cloneSnapshot !== 'function') throw new TypeError('cloneSnapshot');
  }

  get pendingCount() { return this.#pending.length; }
  get enabled() { return this.#enabled; }
  get metrics() { return { ...this.#metrics, pendingCount: this.#pending.length, epoch: this.#epoch, generation: this.#generation }; }

  #clear() {
    this.#pending.length = 0; this.#fork = null; this.#snapshot = null;
    this.#presentation?.clearPreview?.();
    this.#presentation?.selectPreview([]);
  }

  /**
   * Install an already detached authoritative checkpoint. rollback preserves and replays
   * only unacknowledged inputs; other discontinuities intentionally discard speculation.
   * @param {{snapshot:unknown,revision:number,tick:number,epoch:number,confirmedSequence?:number,timeMs:number,mode?:string,reset?:boolean}} checkpoint
   */
  reconcile(checkpoint) {
    this.#assertLive();
    const start = performance.now();
    if (!checkpoint || !MODES.has(checkpoint.mode ?? 'continuous')) throw new TypeError('preview reconciliation mode');
    for (const key of ['revision', 'tick', 'epoch']) if (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0) throw new RangeError('checkpoint ' + key);
    if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) throw new RangeError('checkpoint timeMs must be monotonic');
    const mode = checkpoint.mode ?? 'continuous';
    if (checkpoint.revision < this.#revision) throw new RangeError('checkpoint revision cannot regress');
    const changedRevision = this.#revision >= 0 && checkpoint.revision !== this.#revision;
    if (changedRevision && !['rollback', 'load', 'reset', 'teleport', 'join', 'resync'].includes(mode)) throw new RangeError('new preview revision requires an explicit lifecycle mode');
    for (const key of ['confirmedSequence', 'confirmedCommandSequence']) if (checkpoint[key] !== undefined && (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0)) throw new RangeError('checkpoint ' + key);
    const discontinuity = checkpoint.reset || ['load', 'reset', 'teleport', 'join', 'resync'].includes(mode) || (this.#epoch >= 0 && checkpoint.epoch !== this.#epoch);
    if (discontinuity) this.#pending.length = 0;
    else this.#pending = this.#pending.filter(input => (checkpoint.confirmedSequence === undefined || input.sequence > checkpoint.confirmedSequence) &&
      input.tick > checkpoint.tick && input.tick - checkpoint.tick <= this.#maxFutureTicks && checkpoint.timeMs - input.timeMs <= this.#maxAgeMs).map(input => ({ ...input,
        commands: checkpoint.confirmedCommandSequence === undefined ? input.commands : input.commands.filter(command => command.sequence > checkpoint.confirmedCommandSequence) }));
    const clonedAt = performance.now();
    const snapshot = this.#cloneSnapshot(checkpoint.snapshot);
    this.#metrics.snapshotCloneMs += performance.now() - clonedAt;
    const snapshotSize = byteLength(snapshot);
    this.#metrics.snapshotBytes += snapshotSize; this.#metrics.correctionBytes += snapshotSize;
    this.#snapshot = snapshot; this.#revision = checkpoint.revision; this.#tick = checkpoint.tick; this.#epoch = checkpoint.epoch;
    this.#timeMs = checkpoint.timeMs; this.#generation++;
    this.#rebuild(checkpoint.timeMs);
    this.#metrics.corrections++; this.#metrics.correctionMs += performance.now() - start;
    if (!this.#pending.length) { this.#presentation?.selectPreview([]); this.#presentation?.clearPreview?.(); return true; }
    return this.#publish(checkpoint.timeMs, mode === 'teleport');
  }

  /** Called by createLoop after the single successful authoritative submission. */
  submit(input, { sequence, tick, epoch, timeMs, commands = [] }) {
    this.#assertLive();
    if (!this.#enabled) return false;
    if (!this.#snapshot || !this.#fork) return false;
    for (const [name, value] of Object.entries({ sequence, tick, epoch, timeMs })) {
      if (name === 'timeMs' ? !Number.isFinite(value) : !Number.isSafeInteger(value) || value < 0) throw new RangeError('preview submission ' + name);
    }
    if (epoch !== this.#epoch) { this.#metrics.rejectedEpoch++; this.#clear(); return false; }
    if (tick <= this.#tick || tick - this.#tick > this.#maxFutureTicks) { this.#metrics.rejectedHorizon++; this.#clear(); return false; }
    if (timeMs - this.#timeMs > this.#maxAgeMs) { this.#metrics.rejectedAge++; this.#clear(); return false; }
    if (this.#pending.length >= this.#maxPending) { this.#metrics.rejectedCapacity++; this.#clear(); return false; }
    if (!Array.isArray(commands)) throw new TypeError('preview commands must be an array');
    const immutableCommands = commands.map(command => {
      if (!command || !Number.isSafeInteger(command.sequence) || command.sequence < 0 || command.payload === undefined) throw new TypeError('preview command must retain SDK sequence and payload');
      return { sequence: command.sequence, payload: copyInput(command.payload) };
    });
    const owned = { sequence, tick, epoch, timeMs, input: copyInput(input), commands: immutableCommands };
    const started = performance.now();
    this.#fork.step(copyInput(owned.input), { sequence, tick, epoch, commands: copyInput(owned.commands), speculative: true });
    this.#metrics.replayMs += performance.now() - started; this.#metrics.replayBytes += byteLength(owned.input) + byteLength(owned.commands); this.#metrics.replayedInputs++;
    this.#pending.push(owned); this.#sequence = Math.max(this.#sequence, sequence);
    return this.#publish(timeMs, false);
  }

  #rebuild(timeMs) {
    if (!this.#snapshot) { this.#fork = null; return; }
    const started = performance.now();
    this.#fork = this.#forkFactory(this.#cloneSnapshot(this.#snapshot));
    if (!this.#fork || typeof this.#fork.step !== 'function') throw new TypeError('fork must expose step(input, context)');
    this.#metrics.forkMs += performance.now() - started;
    for (const entry of this.#pending) {
      if (entry.epoch !== this.#epoch || entry.tick <= this.#tick || entry.tick - this.#tick > this.#maxFutureTicks || timeMs - entry.timeMs > this.#maxAgeMs) continue;
      const replayAt = performance.now();
      this.#fork.step(copyInput(entry.input), { sequence: entry.sequence, tick: entry.tick, epoch: entry.epoch, commands: copyInput(entry.commands), speculative: true, replay: true });
      this.#metrics.replayMs += performance.now() - replayAt; this.#metrics.replayBytes += byteLength(entry.input) + byteLength(entry.commands); this.#metrics.replayedInputs++;
    }
  }

  #publish(timeMs, teleport) {
    if (!this.#presentation || !this.#fork) return true;
    const entities = this.#readEntities(this.#fork);
    if (!Array.isArray(entities) || entities.some(entity => !entity || typeof entity.id !== 'string' || !Number.isSafeInteger(entity.generation) || !entity.source)) throw new TypeError('preview entities must be schema-backed identities');
    this.#presentation.selectPreview(entities.map(({ id, generation }) => ({ id, generation })));
    const accepted = this.#presentation.capturePreview({ revision: this.#revision, sequence: ++this.#sequence,
      timeMs, entities: entities.map(entity => ({ ...entity, ...(teleport ? { teleport: true } : {}) })) }, timeMs);
    if (accepted) this.#metrics.previewPublishes++;
    return accepted;
  }

  /** Clear prediction at pause, blur, clock gap, lifecycle reset, or when preview is disabled. */
  clear() { this.#assertLive(); this.#clear(); }
  setEnabled(enabled) { this.#assertLive(); if (typeof enabled !== 'boolean') throw new TypeError('enabled'); this.#enabled = enabled; if (!enabled) this.#clear(); }
  dispose() { if (this.#disposed) return; this.#clear(); this.#disposed = true; }
  #assertLive() { if (this.#disposed) throw new Error('input preview disposed'); }
}
