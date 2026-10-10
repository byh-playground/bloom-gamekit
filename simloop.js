// modules/simloop/loop.js
function createLoop({
  session,
  getInput = () => new Uint8Array(session.inputSize),
  render = () => {
  },
  inputPreview,
  backlogPolicy = "drop",
  beforeFrame = () => {
  },
  canAdvance = () => true,
  canObserveInput = () => true,
  onAdvance = () => {
  },
  onPreviewError = () => {
  },
  onError = (error) => {
    throw error;
  },
  onInputRelease = () => {
  },
  onBacklogDrop = () => {
  },
  maxBacklogTicks = 8,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
} = {}) {
  if (!session || typeof session.poll !== "function" || typeof session.advance !== "function") throw new TypeError("session capability");
  for (const callback of [getInput, render, beforeFrame, canAdvance, canObserveInput, onAdvance, onPreviewError, onError, onInputRelease, onBacklogDrop]) {
    if (typeof callback !== "function") throw new TypeError("loop callback");
  }
  if (backlogPolicy !== "drop" && backlogPolicy !== "retain") throw new RangeError("backlogPolicy");
  if (!Number.isInteger(maxBacklogTicks) || maxBacklogTicks < 1 || maxBacklogTicks > 8192) throw new RangeError("maxBacklogTicks");
  const quantum = 1e3 / session.profile.tickRate;
  const maxBacklogMs = quantum * maxBacklogTicks;
  let running = false, handle, last, accumulator = 0, generation = 0, timingGeneration = 0;
  if (inputPreview && typeof inputPreview.observe !== "function") throw new TypeError("inputPreview observation capability");
  let inputSequence = 0, commandObservation = 0, observedAt = -Infinity, cached = null, captureKey = "";
  const observedCommands = [];
  const observeInput = (timestamp) => {
    if (!Number.isFinite(timestamp)) throw new TypeError("input observation timestamp");
    if (!canObserveInput()) {
      cached = null;
      inputPreview?.clear?.();
      return null;
    }
    if (timestamp === observedAt && cached) return cached;
    const sampled = getInput(), packet = sampled && typeof sampled === "object" && !ArrayBuffer.isView(sampled) && Object.hasOwn(sampled, "input");
    const input = packet ? sampled.input : sampled, commands = packet ? sampled.commands ?? [] : [];
    if (!Array.isArray(commands)) throw new TypeError("input packet commands");
    const held = observedCommands;
    if (held.length + commands.length > 64) throw new RangeError("unsubmitted input command capacity");
    for (const command of commands) {
      if (!command || command.payload === void 0) throw new TypeError("command payload required");
      held.push({ observationId: ++commandObservation, sequence: null, payload: command.payload.slice?.() ?? structuredClone(command.payload) });
    }
    cached = { input: input.slice?.() ?? structuredClone(input), commands: held, predict: !packet || sampled.predict !== false || held.length > 0, continuationKey: packet ? sampled.continuationKey : void 0, sequence: ++inputSequence };
    observedAt = timestamp;
    if (inputPreview && packet && sampled.predict === false && !held.length) inputPreview.cancelObservation?.(Math.max(timestamp, performance.now()));
    else if (inputPreview?.enabled !== false && inputPreview) try {
      inputPreview.observe(cached.input, {
        sequence: cached.sequence,
        tick: session.tick,
        epoch: session.epoch ?? 0,
        continuationKey: cached.continuationKey,
        timeMs: Math.max(timestamp, globalThis.performance?.now?.() ?? timestamp),
        commands: cached.commands
      });
    } catch (error) {
      inputPreview.clear?.();
      onPreviewError(error);
    }
    return cached;
  };
  const resetTiming = (clearPreview = true) => {
    timingGeneration++;
    last = void 0;
    accumulator = 0;
    if (clearPreview) {
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    }
  };
  const release = () => {
    try {
      onInputRelease();
      session.releaseInput();
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    } catch (error) {
      stop();
      onError(error);
    }
  };
  const hidden = () => {
    if (globalThis.document?.hidden) {
      release();
      resetTiming();
    }
  };
  const stop = () => {
    generation++;
    running = false;
    if (handle !== void 0) cancelFrame?.(handle);
    handle = void 0;
    inputPreview?.clear?.();
    globalThis.removeEventListener?.("blur", release);
    globalThis.document?.removeEventListener("visibilitychange", hidden);
  };
  const renderFrame = () => render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
  const pulse = (timestamp, { render: shouldRender = true } = {}) => {
    const current = generation;
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError("frame timestamp");
      if (backlogPolicy === "retain" && last !== void 0 && timestamp < last) throw new RangeError("retained loop timestamp cannot regress");
      beforeFrame(timestamp);
      if (current !== generation) return;
      const timing = timingGeneration;
      if (last === void 0) last = timestamp;
      const elapsed = Math.max(0, timestamp - last);
      if (elapsed > maxBacklogMs) {
        accumulator = 0;
        last = timestamp;
        if (typeof inputPreview?.clockGap === "function") inputPreview.clockGap();
        else inputPreview?.clear?.();
        onBacklogDrop({ elapsedMs: elapsed, droppedTicks: Math.floor(elapsed / quantum), timestamp });
      } else {
        accumulator = backlogPolicy === "retain" ? accumulator + elapsed : Math.min(accumulator + Math.min(250, elapsed), quantum * session.profile.maxCatchupSteps);
        last = timestamp;
      }
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) throw new RangeError("loop backlog exceeds safe milliseconds");
      session.poll();
      if (current !== generation || timing !== timingGeneration) return;
      if (inputPreview && (!cached || timestamp - observedAt >= quantum)) observeInput(timestamp);
      let work = 0;
      while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
        const pace = session.pace ?? session.metrics.pace;
        if (accumulator < quantum * pace) break;
        const allowed = canAdvance();
        if (current !== generation || timing !== timingGeneration) return;
        if (!allowed) {
          if (backlogPolicy === "drop") accumulator = Math.min(accumulator, quantum);
          break;
        }
        const sampled = inputPreview ? cached ?? observeInput(timestamp) : getInput();
        if (!sampled) break;
        if (current !== generation || timing !== timingGeneration) return;
        const packet = sampled && typeof sampled === "object" && !ArrayBuffer.isView(sampled) && !(sampled instanceof ArrayBuffer) && Object.hasOwn(sampled, "input");
        const inputValue = packet ? sampled.input : sampled;
        const input = inputPreview && inputPreview.enabled !== false && ArrayBuffer.isView(inputValue) ? new inputValue.constructor(inputValue) : inputValue;
        if (packet) {
          const commands = sampled.commands ?? [];
          if (!Array.isArray(commands)) throw new TypeError("input packet commands must be an array");
          if (commands.length && typeof session.queueCommand !== "function") throw new TypeError("session does not support queued input commands");
          for (const command of commands) {
            if (!command || command.payload === void 0) throw new TypeError("input command payload required");
            const payload = ArrayBuffer.isView(command.payload) ? new command.payload.constructor(command.payload) : command.payload;
            if (inputPreview && command.sequence !== null && command.sequence !== void 0) continue;
            const sequence = session.queueCommand(payload);
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("session command sequence");
            if (inputPreview) command.sequence = sequence;
          }
        }
        const previousTick = session.tick;
        const result = session.advance(input);
        work++;
        let submission;
        if (inputPreview) {
          const metadata = session.localInputState, capture = metadata?.capture;
          const key = capture ? `${metadata.epoch}:${metadata.baseTick}:${capture.sequence}` : "";
          if (capture && key !== captureKey) {
            captureKey = key;
            submission = { ...capture, predict: cached?.predict !== false, boundaryTick: metadata.tick, epoch: metadata.epoch, timeMs: Math.max(timestamp, performance.now()) };
            submission.commands = capture.commands.map((command) => ({ ...command, observationId: cached?.commands.find((c) => c.sequence === command.sequence)?.observationId }));
            try {
              inputPreview.commit(submission, submission.timeMs);
            } catch (error) {
              inputPreview.clear?.();
              onPreviewError(error);
            }
            const assigned = new Set(capture.commands.map((c) => c.sequence));
            for (let i = observedCommands.length - 1; i >= 0; i--) if (assigned.has(observedCommands[i].sequence)) observedCommands.splice(i, 1);
          }
        }
        if (timing !== timingGeneration) return;
        if (result.status === "advanced") accumulator = Math.max(0, accumulator - quantum * pace);
        else if (backlogPolicy === "drop") accumulator = Math.min(accumulator, quantum);
        if (current !== generation) return;
        onAdvance(result, submission);
        if (current !== generation || timing !== timingGeneration) return;
        if (result.status !== "advanced") break;
      }
      if (shouldRender) renderFrame();
    } catch (error) {
      if (current === generation) stop();
      onError(error);
    }
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") throw new TypeError("frame scheduler");
    running = true;
    resetTiming(false);
    const current = ++generation;
    const frame = (timestamp) => {
      if (!running || current !== generation) return;
      if (inputPreview) observeInput(timestamp);
      pulse(timestamp);
      if (running && current === generation) handle = requestFrame(frame);
    };
    globalThis.addEventListener?.("blur", release);
    globalThis.document?.addEventListener("visibilitychange", hidden);
    handle = requestFrame(frame);
  };
  const flushInput = (timestamp) => {
    accumulator = Math.max(accumulator, quantum * (session.pace ?? 1));
    pulse(timestamp);
  };
  return { start, stop, pulse, render: renderFrame, observeInput, flushInput, releaseInput: release, resetTiming, get running() {
    return running;
  } };
}

// modules/simloop/input-preview.js
var MODES = /* @__PURE__ */ new Set(["continuous", "rollback", "load", "reset", "teleport", "join", "resync"]);
function equalInput(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.every((v, i) => v === y[i]);
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalInput(a[key], b[key]));
}
function equalCommands(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!equalInput(a[i]?.payload, b[i]?.payload)) return false;
    if (a[i]?.observationId !== void 0 || b[i]?.observationId !== void 0) {
      if (a[i]?.observationId !== b[i]?.observationId) return false;
    } else if (a[i]?.sequence !== b[i]?.sequence) return false;
  }
  return true;
}
function copyInput(input, seen = /* @__PURE__ */ new Set()) {
  if (input instanceof Uint8Array) return input.slice();
  if (input instanceof DataView) return new DataView(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  if (ArrayBuffer.isView(input)) return new input.constructor(input);
  if (input instanceof ArrayBuffer) return input.slice(0);
  if (Array.isArray(input) || input && typeof input === "object" && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
    if (seen.has(input)) throw new TypeError("preview input cannot contain cycles");
    seen.add(input);
    const copy = Array.isArray(input) ? new Array(input.length) : {};
    for (const key of Object.keys(input)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError("unsafe preview input key");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("preview input accessors are not supported");
      copy[key] = copyInput(descriptor.value, seen);
    }
    seen.delete(input);
    return copy;
  }
  if (input === null || ["string", "number", "boolean", "undefined"].includes(typeof input)) return input;
  throw new TypeError("preview input must be immutable plain data or bytes");
}
function byteLength(value, seen = /* @__PURE__ */ new Set()) {
  if (value == null) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object" || seen.has(value)) return 8;
  seen.add(value);
  let size = Array.isArray(value) ? 8 : 16;
  for (const [key, item] of Object.entries(value)) size += key.length * 2 + byteLength(item, seen);
  return size;
}
var LocalInputPreview = class {
  #forkFactory;
  #cloneSnapshot;
  #captureSnapshot;
  #readEntities;
  #presentation;
  #maxPending;
  #maxFutureTicks;
  #maxAgeMs;
  #stepMs;
  #snapshot = null;
  #snapshotTick = -1;
  #fork = null;
  #forkTick = -1;
  #forkCurrent = false;
  #clockGap = false;
  #forecast = [];
  #pending = [];
  #observed = null;
  #baseInput;
  #continuationKey;
  #revision = -1;
  #tick = -1;
  #epoch = -1;
  #generation = 0;
  #sequence = 0;
  #timeMs = -Infinity;
  #disposed = false;
  #enabled = true;
  #captureSequence = -1;
  #confirmedCommandSequence;
  #confirmedOnlySteps = 0;
  #metrics = {
    snapshotBytes: 0,
    correctionBytes: 0,
    replayBytes: 0,
    snapshotCloneMs: 0,
    forkMs: 0,
    replayMs: 0,
    replayedInputs: 0,
    replayGapSteps: 0,
    corrections: 0,
    correctionMs: 0,
    continuedCheckpoints: 0,
    continuationRejectedDisabled: 0,
    continuationRejectedTick: 0,
    continuationRejectedRevision: 0,
    continuationRejectedEpoch: 0,
    continuationRejectedKey: 0,
    continuationRejectedObserved: 0,
    continuationRejectedForecast: 0,
    continuationRejectedInput: 0,
    continuationRejectedFork: 0,
    continuationRejectedCommands: 0,
    forkRebuilds: 0,
    snapshotRefreshes: 0,
    forecastReuses: 0,
    forecastExtensions: 0,
    currentForkExtensions: 0,
    clockGaps: 0,
    confirmedAdvances: 0,
    confirmedAdvanceRejected: 0,
    confirmedAdvanceRejectedDisabled: 0,
    confirmedAdvanceRejectedKey: 0,
    confirmedAdvanceRejectedTick: 0,
    confirmedAdvanceRejectedRevision: 0,
    confirmedAdvanceRejectedEpoch: 0,
    confirmedAdvanceRejectedInput: 0,
    confirmedAdvanceRejectedCommands: 0,
    confirmedAdvanceRejectedFork: 0,
    confirmedAdvanceRejectedPending: 0,
    confirmedAdvanceRejectedLimit: 0,
    confirmedAdvanceMs: 0,
    previewPublishes: 0,
    rejectedEpoch: 0,
    rejectedHorizon: 0,
    rejectedAge: 0,
    rejectedCapacity: 0
  };
  /** @param {{createFork:(snapshot:unknown)=>{step:(input:unknown,context:object)=>void},cloneSnapshot?:(snapshot:unknown)=>unknown,captureSnapshot?:()=>unknown,readEntities:(fork:unknown)=>Array, presentation?:{selectPreview:(ids:Array)=>void,capturePreview:(packet:object,nowMs:number)=>boolean,clearPreview?:()=>void},maxPendingInputs?:number,maxFutureTicks?:number,maxAgeMs?:number}} options */
  constructor({
    createFork,
    cloneSnapshot = (value) => structuredClone(value),
    captureSnapshot,
    readEntities,
    presentation,
    maxPendingInputs = 8,
    maxFutureTicks = 8,
    maxAgeMs = 250,
    stepMs = 100
  } = {}) {
    if (typeof createFork !== "function" || typeof readEntities !== "function") throw new TypeError("preview fork and entity reader are required");
    if (presentation && (typeof presentation.selectPreview !== "function" || typeof presentation.capturePreview !== "function")) throw new TypeError("presentation preview capability");
    if (!Number.isInteger(maxPendingInputs) || maxPendingInputs < 1 || maxPendingInputs > 64) throw new RangeError("maxPendingInputs");
    if (!Number.isInteger(maxFutureTicks) || maxFutureTicks < 1 || maxFutureTicks > 64) throw new RangeError("maxFutureTicks");
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 2e3) throw new RangeError("maxAgeMs");
    if (!Number.isFinite(stepMs) || stepMs <= 0) throw new RangeError("stepMs");
    this.#forkFactory = createFork;
    this.#cloneSnapshot = cloneSnapshot;
    this.#captureSnapshot = captureSnapshot;
    this.#readEntities = readEntities;
    this.#presentation = presentation;
    this.#maxPending = maxPendingInputs;
    this.#maxFutureTicks = maxFutureTicks;
    this.#maxAgeMs = maxAgeMs;
    this.#stepMs = stepMs;
    if (typeof cloneSnapshot !== "function") throw new TypeError("cloneSnapshot");
    if (captureSnapshot !== void 0 && typeof captureSnapshot !== "function") throw new TypeError("captureSnapshot");
  }
  get pendingCount() {
    return this.#pending.length;
  }
  get enabled() {
    return this.#enabled;
  }
  get ready() {
    return !!this.#snapshot && !!this.#fork && this.#enabled && !this.#disposed && performance.now() - this.#timeMs <= this.#maxAgeMs;
  }
  get metrics() {
    return { ...this.#metrics, pendingCount: this.#pending.length, epoch: this.#epoch, generation: this.#generation };
  }
  #clear() {
    this.#pending.length = 0;
    this.#observed = null;
    this.#forecast.length = 0;
    this.#fork = null;
    this.#snapshot = null;
    this.#snapshotTick = this.#forkTick = -1;
    this.#forkCurrent = false;
    this.#clockGap = false;
    this.#baseInput = void 0;
    this.#continuationKey = void 0;
    this.#confirmedCommandSequence = void 0;
    this.#confirmedOnlySteps = 0;
    this.#captureSequence = -1;
    this.#presentation?.clearPreview?.();
    this.#presentation?.selectPreview([]);
  }
  /**
   * Install an already detached authoritative checkpoint. rollback preserves and replays
   * only unacknowledged inputs; other discontinuities intentionally discard speculation.
   * @param {{snapshot:unknown,revision:number,tick:number,epoch:number,confirmedSequence?:number,continuationKey?:string,timeMs:number,mode?:string,reset?:boolean}} checkpoint
   */
  reconcile(checkpoint) {
    this.#assertLive();
    const start = performance.now();
    if (!checkpoint || !MODES.has(checkpoint.mode ?? "continuous")) throw new TypeError("preview reconciliation mode");
    for (const key of ["revision", "tick", "epoch"]) if (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0) throw new RangeError("checkpoint " + key);
    if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) throw new RangeError("checkpoint timeMs must be monotonic");
    const mode = checkpoint.mode ?? "continuous";
    if (checkpoint.revision < this.#revision) throw new RangeError("checkpoint revision cannot regress");
    if (checkpoint.continuationKey !== void 0 && (typeof checkpoint.continuationKey !== "string" || checkpoint.continuationKey.length > 65536)) throw new TypeError("checkpoint continuationKey");
    const changedRevision = this.#revision >= 0 && checkpoint.revision !== this.#revision;
    if (changedRevision && !["rollback", "load", "reset", "teleport", "join", "resync"].includes(mode)) throw new RangeError("new preview revision requires an explicit lifecycle mode");
    for (const key of ["confirmedSequence", "confirmedCommandSequence"]) if (checkpoint[key] !== void 0 && (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0)) throw new RangeError("checkpoint " + key);
    const discontinuity = checkpoint.reset || ["load", "reset", "teleport", "join", "resync"].includes(mode) || this.#epoch >= 0 && checkpoint.epoch !== this.#epoch;
    if (discontinuity) {
      this.#pending.length = 0;
      this.#observed = null;
      this.#forecast.length = 0;
      this.#forkCurrent = false;
      this.#captureSequence = -1;
    } else this.#pending = this.#pending.filter((input) => input.executeTick >= checkpoint.tick && input.executeTick - checkpoint.tick < this.#maxFutureTicks).map((input) => ({
      ...input,
      commands: checkpoint.confirmedCommandSequence === void 0 ? input.commands : input.commands.filter((command) => command.sequence > checkpoint.confirmedCommandSequence)
    }));
    const clonedAt = performance.now();
    const snapshot = this.#cloneSnapshot(checkpoint.snapshot);
    this.#metrics.snapshotCloneMs += performance.now() - clonedAt;
    const snapshotSize = byteLength(snapshot);
    this.#metrics.snapshotBytes += snapshotSize;
    this.#metrics.correctionBytes += snapshotSize;
    this.#snapshot = snapshot;
    this.#snapshotTick = checkpoint.tick;
    this.#continuationKey = checkpoint.continuationKey;
    this.#clockGap = false;
    this.#revision = checkpoint.revision;
    this.#tick = checkpoint.tick;
    this.#epoch = checkpoint.epoch;
    this.#forkCurrent = false;
    this.#forkTick = -1;
    this.#forecast.length = 0;
    this.#baseInput = checkpoint.input === void 0 ? void 0 : copyInput(checkpoint.input);
    this.#confirmedCommandSequence = checkpoint.confirmedCommandSequence;
    this.#confirmedOnlySteps = 0;
    this.#timeMs = checkpoint.timeMs;
    this.#generation++;
    if (this.#pending.length || this.#observed || !this.#fork) this.#rebuild(checkpoint.timeMs);
    this.#metrics.corrections++;
    this.#metrics.correctionMs += performance.now() - start;
    if (!this.#pending.length && !this.#observed) {
      this.#forecast.length = 0;
      this.#forkCurrent = false;
      this.#presentation?.clearPreview?.();
      return true;
    }
    return true;
  }
  /**
   * Confirm one already-predicted authority step without reinstalling a full snapshot.
   * The host supplies an exact key for remote inputs/commands; any discontinuity returns false.
   */
  continueFromCheckpoint(checkpoint) {
    this.#assertLive();
    const reject = (reason) => {
      this.#metrics["continuationRejected" + reason]++;
      return false;
    };
    if (!this.#enabled) return reject("Disabled");
    if (!checkpoint || typeof checkpoint.continuationKey !== "string") return reject("Key");
    for (const key of ["revision", "tick", "epoch"]) if (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0) throw new RangeError("checkpoint " + key);
    if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) throw new RangeError("checkpoint timeMs must be monotonic");
    if (checkpoint.tick !== this.#tick + 1) return reject("Tick");
    if (checkpoint.revision !== this.#revision) return reject("Revision");
    if (checkpoint.epoch !== this.#epoch) return reject("Epoch");
    if (checkpoint.continuationKey !== this.#continuationKey) return reject("Key");
    if (this.#observed) return reject("Observed");
    if (checkpoint.input === void 0) return reject("Input");
    if (!this.#fork) return reject("Fork");
    const predicted = this.#forecast.find((step) => step.tick === this.#tick);
    if (!predicted) return reject("Forecast");
    if (!equalInput(predicted.input, checkpoint.input)) return reject("Input");
    if (this.#forkTick < checkpoint.tick) return reject("Fork");
    const commands = predicted.commands || [];
    if (commands.length && (checkpoint.confirmedCommandSequence === void 0 || !Number.isSafeInteger(checkpoint.confirmedCommandSequence) || commands.some((command) => !Number.isSafeInteger(command.sequence) || command.sequence > checkpoint.confirmedCommandSequence))) return reject("Commands");
    this.#pending = this.#pending.filter((input) => input.executeTick >= checkpoint.tick && input.executeTick - checkpoint.tick < this.#maxFutureTicks).map((input) => ({
      ...input,
      commands: checkpoint.confirmedCommandSequence === void 0 ? input.commands : input.commands.filter((command) => command.sequence > checkpoint.confirmedCommandSequence)
    }));
    this.#forecast = this.#forecast.filter((step) => step.tick >= checkpoint.tick);
    this.#tick = checkpoint.tick;
    this.#epoch = checkpoint.epoch;
    this.#revision = checkpoint.revision;
    this.#baseInput = copyInput(checkpoint.input);
    this.#timeMs = checkpoint.timeMs;
    this.#generation++;
    this.#continuationKey = checkpoint.continuationKey;
    this.#confirmedCommandSequence = checkpoint.confirmedCommandSequence ?? this.#confirmedCommandSequence;
    this.#confirmedOnlySteps = 0;
    this.#forkCurrent = this.#forkTick === this.#tick && !this.#pending.length;
    this.#clockGap = false;
    this.#metrics.continuedCheckpoints++;
    if (!this.#pending.length && !this.#observed) {
      if (this.#forecast.some((step) => step.kind === "observed" && step.tick >= checkpoint.tick)) this.#publish(checkpoint.timeMs);
      else this.#presentation?.clearPreview?.();
    }
    return true;
  }
  /**
   * Advance one exact confirmed local frame when no speculative frame was available.
   * Only a contiguous fork with no pending work or newly confirmed command can use this path;
   * one step maximum keeps non-local state staleness bounded before snapshot rebase.
   * @param {{input:unknown,revision:number,tick:number,epoch:number,continuationKey:string,confirmedCommandSequence?:number,timeMs:number}} checkpoint
   * @returns {boolean} Whether the detached fork advanced without installing a full snapshot.
   */
  advanceConfirmedCheckpoint(checkpoint) {
    this.#assertLive();
    const reject = (reason) => {
      this.#metrics.confirmedAdvanceRejected++;
      this.#metrics["confirmedAdvanceRejected" + reason]++;
      return false;
    };
    if (!this.#enabled) return reject("Disabled");
    if (!checkpoint || typeof checkpoint.continuationKey !== "string") return reject("Key");
    for (const key of ["revision", "tick", "epoch"]) if (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0) throw new RangeError("checkpoint " + key);
    if (!Number.isFinite(checkpoint.timeMs) || checkpoint.timeMs < this.#timeMs) throw new RangeError("checkpoint timeMs must be monotonic");
    if (checkpoint.confirmedCommandSequence !== void 0 && (!Number.isSafeInteger(checkpoint.confirmedCommandSequence) || checkpoint.confirmedCommandSequence < 0)) throw new RangeError("checkpoint confirmedCommandSequence");
    if (checkpoint.tick !== this.#tick + 1) return reject("Tick");
    if (checkpoint.revision !== this.#revision) return reject("Revision");
    if (checkpoint.epoch !== this.#epoch) return reject("Epoch");
    if (checkpoint.continuationKey !== this.#continuationKey) return reject("Key");
    if (checkpoint.input === void 0) return reject("Input");
    if (checkpoint.confirmedCommandSequence !== this.#confirmedCommandSequence) return reject("Commands");
    if (!this.#fork || !this.#forkCurrent || this.#forkTick !== this.#tick) return reject("Fork");
    if (this.#pending.length || this.#observed || this.#forecast.length) return reject("Pending");
    if (this.#confirmedOnlySteps >= 1) return reject("Limit");
    const started = performance.now(), input = copyInput(checkpoint.input);
    this.#fork.step(copyInput(input), { tick: this.#tick, epoch: this.#epoch, commands: [], speculative: true, confirmedReplay: true });
    this.#metrics.confirmedAdvanceMs += performance.now() - started;
    this.#metrics.confirmedAdvances++;
    this.#baseInput = copyInput(input);
    this.#tick = checkpoint.tick;
    this.#epoch = checkpoint.epoch;
    this.#revision = checkpoint.revision;
    this.#timeMs = checkpoint.timeMs;
    this.#continuationKey = checkpoint.continuationKey;
    this.#forkTick = checkpoint.tick;
    this.#forkCurrent = true;
    this.#confirmedOnlySteps++;
    this.#generation++;
    this.#presentation?.clearPreview?.();
    return true;
  }
  /** Observe a coalesced future frame BEFORE authority advances. Provisional IDs are not SDK command sequences. */
  observe(input, { sequence, tick, epoch, timeMs, continuationKey, commands = [] }) {
    this.#assertLive();
    if (!this.#enabled) return false;
    if (!this.#snapshot || !this.#fork) return false;
    for (const [name, value] of Object.entries({ sequence, tick, epoch, timeMs })) {
      if (name === "timeMs" ? !Number.isFinite(value) : !Number.isSafeInteger(value) || value < 0) throw new RangeError("preview submission " + name);
    }
    if (epoch !== this.#epoch) {
      this.#metrics.rejectedEpoch++;
      this.#clear();
      return false;
    }
    const futureEnd = Math.max(this.#tick, ...this.#pending.map((frame) => frame.executeTick + 1));
    if (tick < this.#tick || futureEnd - this.#tick + 1 > this.#maxFutureTicks) {
      this.#metrics.rejectedHorizon++;
      this.#clear();
      return false;
    }
    const sameCheckpointAfterGap = this.#clockGap && tick === this.#tick && (continuationKey ?? this.#continuationKey) === this.#continuationKey;
    if (timeMs - this.#timeMs > this.#maxAgeMs && !sameCheckpointAfterGap) {
      this.#metrics.rejectedAge++;
      this.#clear();
      return false;
    }
    if (this.#pending.length >= this.#maxPending) {
      this.#metrics.rejectedCapacity++;
      this.#clear();
      return false;
    }
    if (!Array.isArray(commands)) throw new TypeError("preview commands must be an array");
    const owned = { sequence, tick, epoch, timeMs, input: copyInput(input), commands: copyInput(commands) };
    const same = this.#observed && equalInput(this.#observed.input, owned.input) && equalInput(this.#observed.commands, owned.commands);
    if (same) {
      if (this.#clockGap) {
        this.#clockGap = false;
        this.#publish(timeMs);
      }
      return true;
    }
    let conflictingObserved = false;
    for (let i = this.#forecast.length - 1; i >= 0; i--) {
      const step = this.#forecast[i];
      if (step.kind === "observed" && step.tick >= tick) {
        if (equalInput(step.input, owned.input) && equalCommands(step.commands, owned.commands)) {
          this.#observed = owned;
          step.sequence = owned.sequence;
          this.#metrics.forecastReuses++;
          this.#clockGap = false;
          this.#publish(timeMs);
          return true;
        }
        conflictingObserved = true;
        break;
      }
    }
    if (this.#forkCurrent && this.#forkTick === this.#tick && !this.#pending.length) {
      const started = performance.now(), stepInput = copyInput(owned.input), stepCommands = copyInput(owned.commands);
      this.#fork.step(stepInput, { sequence: owned.sequence, tick: this.#tick, epoch: this.#epoch, commands: stepCommands, speculative: true });
      this.#metrics.replayMs += performance.now() - started;
      this.#metrics.replayedInputs++;
      this.#metrics.replayBytes += byteLength(owned.input) + byteLength(owned.commands);
      this.#forecast.push({ tick: this.#tick, input: copyInput(owned.input), commands: copyInput(owned.commands), sequence: owned.sequence, kind: "observed" });
      this.#observed = owned;
      this.#forkTick = this.#tick + 1;
      this.#forkCurrent = false;
      this.#clockGap = false;
      this.#metrics.currentForkExtensions++;
      this.#publish(timeMs);
      return true;
    }
    if (!conflictingObserved && tick === this.#tick && this.#fork && this.#forkTick > this.#tick) {
      const started = performance.now(), stepInput = copyInput(owned.input), stepCommands = copyInput(owned.commands), tick2 = this.#forkTick;
      this.#fork.step(stepInput, { sequence: owned.sequence, tick: tick2, epoch: this.#epoch, commands: stepCommands, speculative: true });
      this.#metrics.replayMs += performance.now() - started;
      this.#metrics.replayedInputs++;
      this.#metrics.replayBytes += byteLength(owned.input) + byteLength(owned.commands);
      this.#forecast.push({ tick: tick2, input: copyInput(owned.input), commands: copyInput(owned.commands), sequence: owned.sequence, kind: "observed" });
      this.#observed = owned;
      this.#forkTick++;
      this.#forkCurrent = false;
      this.#clockGap = false;
      this.#metrics.forecastExtensions++;
      this.#publish(timeMs);
      return true;
    }
    this.#observed = owned;
    this.#rebuild(timeMs);
    return true;
  }
  /** Bind provisional observations once to immutable SDK captures, including their real execution ticks. */
  commit(capture, nowMs) {
    this.#assertLive();
    if (!this.#enabled) return false;
    if (!this.#snapshot || !capture || capture.sequence === this.#captureSequence) return false;
    if (!Number.isSafeInteger(capture.executeTick) || capture.executeTick < this.#tick) return false;
    if (capture.executeTick - this.#tick >= this.#maxFutureTicks) {
      this.#metrics.rejectedHorizon++;
      this.#clear();
      return false;
    }
    this.#captureSequence = capture.sequence;
    this.#pending = this.#pending.filter((frame) => frame.executeTick !== capture.executeTick);
    if (capture.predict !== false || capture.commands?.length) this.#pending.push({ ...capture, input: copyInput(capture.input), commands: copyInput(capture.commands ?? []), timeMs: nowMs });
    const forecast = this.#forecast.find((step) => step.tick === capture.executeTick);
    if (forecast) {
      forecast.input = copyInput(capture.input);
      forecast.commands = copyInput(capture.commands ?? []);
      forecast.sequence = capture.sequence;
      forecast.executeTick = capture.executeTick;
      forecast.kind = "pending";
    }
    if (Number.isSafeInteger(capture.boundaryTick)) this.#pending = this.#pending.filter((frame) => frame.executeTick >= capture.boundaryTick);
    this.#observed = null;
    if (this.#pending.length > this.#maxPending) {
      this.#metrics.rejectedCapacity++;
      this.#clear();
      return false;
    }
    return true;
  }
  /** No active device intent: preserve immutable future captures and release the coalesced slot smoothly. */
  cancelObservation(nowMs) {
    const changed = !!this.#observed;
    this.#observed = null;
    if (!this.#pending.length) {
      if (changed) {
        this.#forecast.length = 0;
        this.#forkCurrent = false;
      }
      this.#presentation?.releasePreview?.(nowMs);
    } else if (changed) this.#rebuild(nowMs);
  }
  /** A main-thread clock gap drops frame timing; keep the fork only for exact next-tick confirmation. */
  clockGap() {
    this.#assertLive();
    if (!this.#enabled || !this.#snapshot || !this.#fork) return false;
    this.#clockGap = true;
    this.#metrics.clockGaps++;
    this.#presentation?.clearPreview?.();
    this.#presentation?.selectPreview([]);
    return true;
  }
  #rebuild(timeMs) {
    if (!this.#snapshot) {
      this.#fork = null;
      return;
    }
    if (this.#snapshotTick !== this.#tick) {
      if (!this.#captureSnapshot) throw new Error("A fresh authoritative snapshot is required to rebase the preview fork");
      const captured = this.#captureSnapshot(), clonedAt = performance.now();
      this.#snapshot = this.#cloneSnapshot(captured);
      this.#snapshotTick = this.#tick;
      this.#metrics.snapshotCloneMs += performance.now() - clonedAt;
      this.#metrics.snapshotBytes += byteLength(this.#snapshot);
      this.#metrics.snapshotRefreshes++;
    }
    const started = performance.now();
    this.#metrics.forkRebuilds++;
    this.#clockGap = false;
    this.#forecast.length = 0;
    this.#forkCurrent = false;
    if (this.#fork?.restore) this.#fork.restore(this.#cloneSnapshot(this.#snapshot));
    else this.#fork = this.#forkFactory(this.#cloneSnapshot(this.#snapshot));
    if (!this.#fork || typeof this.#fork.step !== "function") throw new TypeError("fork must expose step(input, context)");
    this.#metrics.forkMs += performance.now() - started;
    let tick = this.#tick, held = this.#baseInput;
    for (const entry of this.#pending.slice().sort((a, b) => a.executeTick - b.executeTick)) {
      while (tick < entry.executeTick) {
        if (held === void 0) throw new TypeError("Replay gaps require explicit confirmed checkpoint input");
        const gapInput = copyInput(held), gapAt = performance.now();
        this.#forecast.push({ tick, input: copyInput(gapInput), commands: [], kind: "gap" });
        this.#fork.step(gapInput, { tick: tick++, epoch: this.#epoch, commands: [], speculative: true, replay: true, gap: true });
        this.#metrics.replayMs += performance.now() - gapAt;
        this.#metrics.replayedInputs++;
        this.#metrics.replayGapSteps++;
        this.#metrics.replayBytes += byteLength(held);
      }
      const replayAt = performance.now();
      const replayInput = copyInput(entry.input), replayCommands = copyInput(entry.commands);
      this.#forecast.push({ tick, input: copyInput(replayInput), commands: copyInput(replayCommands), sequence: entry.sequence, executeTick: entry.executeTick, kind: "pending" });
      this.#fork.step(replayInput, { sequence: entry.sequence, tick: tick++, executeTick: entry.executeTick, epoch: this.#epoch, commands: replayCommands, speculative: true, replay: true });
      held = entry.input;
      this.#metrics.replayMs += performance.now() - replayAt;
      this.#metrics.replayBytes += byteLength(entry.input) + byteLength(entry.commands);
      this.#metrics.replayedInputs++;
    }
    if (this.#observed) {
      const entry = this.#observed, replayAt = performance.now();
      const observedInput = copyInput(entry.input), observedCommands = copyInput(entry.commands);
      this.#forecast.push({ tick, input: copyInput(observedInput), commands: copyInput(observedCommands), sequence: entry.sequence, kind: "observed" });
      this.#fork.step(observedInput, { sequence: entry.sequence, tick, epoch: this.#epoch, commands: observedCommands, speculative: true });
      this.#metrics.replayMs += performance.now() - replayAt;
      this.#metrics.replayedInputs++;
      this.#metrics.replayBytes += byteLength(entry.input) + byteLength(entry.commands);
    }
    this.#forkTick = tick + (this.#observed ? 1 : 0);
    this.#forkCurrent = this.#forkTick === this.#tick && !this.#pending.length && !this.#observed;
    if (this.#pending.length || this.#observed) this.#publish(timeMs);
  }
  #publish(timeMs, initial) {
    if (!this.#enabled) return false;
    if (!this.#presentation || !this.#fork) return true;
    const entities = this.#readEntities(this.#fork);
    if (!Array.isArray(entities) || entities.some((entity) => !entity || typeof entity.id !== "string" || !Number.isSafeInteger(entity.generation) || !entity.source)) throw new TypeError("preview entities must be schema-backed identities");
    this.#presentation.selectPreview(entities.map(({ id, generation }) => ({ id, generation })));
    const starts = new Map((initial ?? []).map((entity) => [entity.id, entity.source]));
    const accepted = this.#presentation.capturePreview({
      revision: this.#revision,
      sequence: ++this.#sequence,
      timeMs,
      phaseStartMs: this.#timeMs,
      stepMs: this.#stepMs,
      entities: entities.map((entity) => ({ ...entity, initialSource: starts.get(entity.id) }))
    }, timeMs);
    if (accepted) this.#metrics.previewPublishes++;
    return accepted;
  }
  /** Clear prediction at pause, blur, clock gap, lifecycle reset, or when preview is disabled. */
  clear() {
    this.#assertLive();
    this.#clear();
  }
  setEnabled(enabled) {
    this.#assertLive();
    if (typeof enabled !== "boolean") throw new TypeError("enabled");
    this.#enabled = enabled;
    if (!enabled) this.#clear();
  }
  dispose() {
    if (this.#disposed) return;
    this.#clear();
    this.#disposed = true;
  }
  #assertLive() {
    if (this.#disposed) throw new Error("input preview disposed");
  }
};

// modules/simloop/deadline.js
function createDeadlineScheduler({
  getIntervalMs,
  pulse,
  maxBacklogTicks = 8,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onGap
} = {}) {
  if (typeof getIntervalMs !== "function") throw new TypeError("getIntervalMs must be a function");
  if (typeof pulse !== "function") throw new TypeError("pulse must be a function");
  if (!Number.isSafeInteger(maxBacklogTicks) || maxBacklogTicks < 1) {
    throw new RangeError("maxBacklogTicks must be a positive safe integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof setTimer !== "function") throw new TypeError("setTimer must be a function");
  if (typeof clearTimer !== "function") throw new TypeError("clearTimer must be a function");
  if (onGap !== void 0 && typeof onGap !== "function") throw new TypeError("onGap must be a function");
  let active = false;
  let timerPending = false;
  let timerHandle;
  let generation = 0;
  let intervalMs;
  let deadline = null;
  let lastPulseAt = null;
  let lastNow = null;
  let dispatchingWake = false;
  const readNow = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new RangeError("now() must return a finite timestamp");
    if (lastNow !== null && value < lastNow) throw new RangeError("now() must be monotonic");
    lastNow = value;
    return value;
  };
  const readInterval = () => {
    const value = getIntervalMs();
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError("getIntervalMs() must return a positive finite interval");
    }
    return value;
  };
  const clearPendingTimer = () => {
    if (!timerPending) return;
    timerPending = false;
    clearTimer(timerHandle);
    timerHandle = void 0;
  };
  let arm;
  const dispatchRegular = (token) => {
    if (!active || token !== generation) return;
    timerPending = false;
    timerHandle = void 0;
    const timestamp = readNow();
    if (timestamp < deadline) {
      arm(token);
      return;
    }
    const interval = intervalMs;
    const lateness = timestamp - deadline;
    if (!Number.isFinite(lateness)) throw new RangeError("clock gap is outside the supported range");
    const due = Math.floor(lateness / interval) + 1;
    const elapsedMs = lastPulseAt === null ? interval : timestamp - lastPulseAt;
    const maxGapMs = interval * maxBacklogTicks;
    if (elapsedMs > maxGapMs) {
      const droppedTicks = Math.max(0, due - 1);
      deadline = timestamp + interval;
      if (!Number.isFinite(deadline)) throw new RangeError("next deadline is outside the supported range");
      lastPulseAt = timestamp;
      onGap?.({ elapsedMs, droppedTicks, timestamp, scheduledAtMs: timestamp });
      if (!active || token !== generation) return;
      pulse(timestamp, { due: 1, scheduledAtMs: timestamp });
    } else {
      const scheduledAtMs = deadline;
      deadline += due * interval;
      if (!Number.isFinite(deadline)) throw new RangeError("next deadline is outside the supported range");
      lastPulseAt = timestamp;
      pulse(timestamp, { due, scheduledAtMs });
    }
    if (active && token === generation) arm(token);
  };
  arm = (token) => {
    if (!active || token !== generation || timerPending) return;
    const timestamp = readNow();
    const delay = Math.max(0, deadline - timestamp);
    timerPending = true;
    timerHandle = setTimer(() => dispatchRegular(token), delay);
  };
  const rebase = (timestampMs) => {
    const timestamp = timestampMs === void 0 ? readNow() : timestampMs;
    if (!Number.isFinite(timestamp)) throw new RangeError("rebase timestamp must be finite");
    if (lastNow !== null && timestamp < lastNow) throw new RangeError("rebase timestamp must be monotonic");
    lastNow = timestamp;
    intervalMs = readInterval();
    deadline = timestamp + intervalMs;
    if (!Number.isFinite(deadline)) throw new RangeError("next deadline is outside the supported range");
    lastPulseAt = timestamp;
    generation += 1;
    clearPendingTimer();
    if (active) arm(generation);
  };
  const stop = () => {
    generation += 1;
    active = false;
    deadline = null;
    lastPulseAt = null;
    clearPendingTimer();
  };
  const start = () => {
    if (active) return;
    const timestamp = readNow();
    intervalMs = readInterval();
    deadline = timestamp + intervalMs;
    if (!Number.isFinite(deadline)) throw new RangeError("next deadline is outside the supported range");
    lastPulseAt = timestamp;
    active = true;
    generation += 1;
    arm(generation);
  };
  const wake = () => {
    if (!active || dispatchingWake) return;
    const timestamp = readNow();
    lastPulseAt = timestamp;
    dispatchingWake = true;
    try {
      pulse(timestamp, { due: 0, scheduledAtMs: null });
    } finally {
      dispatchingWake = false;
    }
  };
  return {
    start,
    stop,
    wake,
    rebase,
    get running() {
      return active;
    },
    get deadlineMs() {
      return deadline;
    }
  };
}
export {
  LocalInputPreview,
  createDeadlineScheduler,
  createLoop
};
