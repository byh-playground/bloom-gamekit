// modules/deterministic/utilities.js
var nowMs = () => globalThis.performance?.now() ?? Date.now();
var compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, name, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name);
  return value;
}
function bytes(value, name = "bytes") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (const b of bytes(value)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
var signed = (x) => integer(x, "fixed-point result", -2147483648, 2147483647);
var fixedPoint = Object.freeze({
  scale: 1024,
  fromNumber: (x) => signed(Math.round(x * 1024)),
  toNumber: (x) => signed(x) / 1024,
  add: (a, b) => signed(signed(a) + signed(b)),
  sub: (a, b) => signed(signed(a) - signed(b)),
  mul: (a, b) => {
    signed(a);
    signed(b);
    const product = a * b;
    if (Number.isSafeInteger(product)) return signed(Math.trunc(product / 1024) || 0);
    return signed(Number(BigInt(a) * BigInt(b) / 1024n));
  },
  div: (a, b) => {
    if (signed(b) === 0) throw new RangeError("fixed-point division by zero");
    return signed(Number(BigInt(signed(a)) * 1024n / BigInt(b)));
  }
});

// modules/_rollback-shared/protocol.js
var VERSION = "0.2.0-dev";
var PROTOCOL_VERSION = 1;
var CHUNK_SIZE = 16384;
var MAX_TICK = 2147483646;
var defaults = {
  mode: "rollback",
  tickRate: 60,
  baseInputDelayTicks: 2,
  minInputDelayTicks: 0,
  maxInputDelayTicks: 8,
  rollbackWindowTicks: 12,
  stateHistorySize: 64,
  predictionPolicy: "hold",
  stallPolicy: "wait",
  tickDriftThreshold: 2,
  pacingPolicy: "hold",
  checksumInterval: 30,
  maxCatchupSteps: 4,
  adaptiveInputDelay: true,
  heartbeatMs: 100,
  adaptationIntervalMs: 1e3,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxHistoryBytes: 64 * 1024 * 1024,
  maxReplayBytes: 64 * 1024 * 1024,
  maxCommandBytes: 2048,
  maxPendingCommands: 256,
  maxQueuedBytes: 5 * 1024 * 1024,
  recoveryTimeoutMs: 1e4,
  maxRecoveryAttempts: 3,
  peerInterruptMs: 1e3,
  peerTimeoutMs: 1e4
};
var profiles = Object.freeze({
  action: Object.freeze({ ...defaults }),
  rts: Object.freeze({
    ...defaults,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 12,
    rollbackWindowTicks: 6,
    stateHistorySize: 32,
    predictionPolicy: "neutral",
    checksumInterval: 20
  }),
  lockstep: Object.freeze({
    ...defaults,
    mode: "lockstep",
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 20,
    rollbackWindowTicks: 0,
    checksumInterval: 20,
    stateHistorySize: 32,
    predictionPolicy: "neutral"
  })
});
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var MAGIC = 827015762;
var TYPE = Object.freeze({
  HELLO: 1,
  INPUT: 2,
  CLOCK: 3,
  HASH: 4,
  REQUEST: 5,
  BEGIN: 6,
  CHUNK: 7
});
var HEADER = 12;
var SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;
var Writer = class {
  constructor(size = CHUNK_SIZE) {
    this.data = new Uint8Array(size);
    this.view = new DataView(this.data.buffer);
    this.offset = 0;
  }
  room(n) {
    if (this.offset + n > this.data.length) throw new RangeError("packet capacity");
  }
  u8(n) {
    this.room(1);
    this.view.setUint8(this.offset++, n);
  }
  u16(n) {
    this.room(2);
    this.view.setUint16(this.offset, n, true);
    this.offset += 2;
  }
  u32(n) {
    this.room(4);
    this.view.setUint32(this.offset, n, true);
    this.offset += 4;
  }
  i32(n) {
    this.room(4);
    this.view.setInt32(this.offset, n, true);
    this.offset += 4;
  }
  raw(b) {
    this.room(b.length);
    this.data.set(b, this.offset);
    this.offset += b.length;
  }
  finish() {
    return this.data.slice(0, this.offset);
  }
  reset() {
    this.offset = 0;
    return this;
  }
  usedBytes() {
    return this.data.subarray(0, this.offset);
  }
};
var Reader = class {
  constructor(data) {
    this.data = bytes(data);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.offset = 0;
  }
  room(n) {
    if (this.offset + n > this.data.length) throw new RangeError("truncated packet");
  }
  u8() {
    this.room(1);
    return this.view.getUint8(this.offset++);
  }
  u16() {
    this.room(2);
    const n = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return n;
  }
  u32() {
    this.room(4);
    const n = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return n;
  }
  i32() {
    this.room(4);
    const n = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return n;
  }
  raw(n) {
    this.room(n);
    const b = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  end() {
    if (this.offset !== this.data.length) throw new RangeError("trailing packet bytes");
  }
};
function packet(type, sequence, write) {
  const w = new Writer();
  w.u32(MAGIC);
  w.u8(PROTOCOL_VERSION);
  w.u8(type);
  w.u16(0);
  w.u32(sequence);
  write(w);
  return w.finish();
}
function frameEqual(a, b) {
  if (!equalBytes(a.input, b.input) || a.commands.length !== b.commands.length) return false;
  return a.commands.every((c, i) => c.sequence === b.commands[i].sequence && equalBytes(c.payload, b.commands[i].payload));
}
function copyFrame(frame) {
  return { input: frame.input.slice(), commands: frame.commands.map((c) => ({ ...c, payload: c.payload.slice() })) };
}
function runSimulationFrame(adapter, context) {
  return adapter.step({ ...context, inputs: context.inputs.map((frame) => ({
    ...copyFrame(frame),
    playerId: frame.playerId,
    predicted: !!frame.predicted
  })) });
}

// modules/_rollback-shared/history.js
var StateHistory = class {
  constructor(size, maxBytes = 64 * 1024 * 1024) {
    this.slots = new Array(size);
    this.size = size;
    this.maxBytes = maxBytes;
    this.byteLength = 0;
  }
  get(tick) {
    const s = this.slots[tick % this.size];
    return s?.tick === tick ? s : void 0;
  }
  put(state) {
    const i = state.tick % this.size, next = this.byteLength - (this.slots[i]?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError("state history byte budget"), { code: "history-capacity", requiredBytes: next, maxHistoryBytes: this.maxBytes, snapshotBytes: state.bytes.length });
    this.slots[i] = state;
    this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (let i = 0; i < this.size; i++) if (this.slots[i]?.tick > tick) {
      this.byteLength -= this.slots[i].bytes.length;
      this.slots[i] = void 0;
    }
  }
};
var CheckpointHistory = class {
  constructor(size, maxBytes) {
    this.size = size;
    this.maxBytes = maxBytes;
    this.records = /* @__PURE__ */ new Map();
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
    for (const state of this.records.values()) if (state.tick <= tick && (!result || state.tick > result.tick)) result = state;
    return result;
  }
  get oldestTick() {
    return Math.min(...this.records.keys());
  }
  put(state) {
    const oldest = Math.max(0, state.tick - this.size + 1);
    const base = this.atOrBefore(oldest);
    const expired = [...this.records.values()].filter((s) => base && s.tick < base.tick);
    const next = this.byteLength - expired.reduce((n, s) => n + s.bytes.length, 0) - (this.records.get(state.tick)?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError("checkpoint history byte budget"), { code: "history-capacity", requiredBytes: next, maxHistoryBytes: this.maxBytes, snapshotBytes: state.bytes.length });
    for (const s of expired) this.records.delete(s.tick);
    this.records.set(state.tick, state);
    this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (const [t, state] of this.records) if (t > tick) {
      this.records.delete(t);
      this.byteLength -= state.bytes.length;
    }
  }
};

// modules/rollback/core.js
function copyLocalCommandState(state, inputSize, profile, executedSequence = 0) {
  if (!state || typeof state !== "object") throw new TypeError("localCommandState");
  const sequence = integer(state.sequence, "local command sequence", executedSequence);
  const lastInput = bytes(state.lastInput, "local command lastInput");
  if (lastInput.length !== inputSize) throw new RangeError("local command inputSize");
  const maxCommands = profile.maxPendingCommands * (profile.maxInputDelayTicks + 2);
  if (!Array.isArray(state.commands) || state.commands.length > maxCommands) throw new RangeError("local command capacity");
  const maxPayload = Math.min(profile.maxCommandBytes, CHUNK_SIZE - 1024 - inputSize - 6);
  const maxBytes = profile.maxPendingCommands * maxPayload + (profile.maxInputDelayTicks + 1) * (CHUNK_SIZE - 1024 - inputSize);
  let previous = executedSequence, size = 0;
  const commands = Array.from(state.commands, (command) => {
    const next = integer(command?.sequence, "local command order", 1, sequence);
    if (next <= previous) throw new RangeError("local command order");
    const payload = bytes(command.payload, "local command payload");
    if (!payload.length || payload.length > maxPayload || (size += payload.length) > maxBytes) throw new RangeError("local command capacity");
    previous = next;
    return { sequence: next, payload: payload.slice() };
  });
  return { sequence, lastInput: lastInput.slice(), commands };
}
function commandSequenceMap(players, initial) {
  if (initial === void 0) return new Map(players.map((id) => [id, 0]));
  if (!initial || typeof initial !== "object" || Array.isArray(initial) || Object.keys(initial).length !== players.length || players.some((id) => !Object.hasOwn(initial, id))) throw new TypeError("initial command sequences roster");
  return new Map(players.map((id) => [id, integer(initial[id], "initial command sequence")]));
}
function profileOf(profile) {
  const p = { ...defaults, ...profile };
  if (!["rollback", "lockstep"].includes(p.mode)) throw new TypeError("session mode");
  if (p.mode === "lockstep") p.rollbackWindowTicks = 0;
  for (const field of [
    "tickRate",
    "stateHistorySize",
    "checksumInterval",
    "maxCatchupSteps",
    "heartbeatMs",
    "adaptationIntervalMs",
    "maxSnapshotBytes",
    "maxHistoryBytes",
    "maxReplayBytes",
    "maxCommandBytes",
    "maxPendingCommands",
    "maxQueuedBytes",
    "recoveryTimeoutMs",
    "maxRecoveryAttempts",
    "peerInterruptMs",
    "peerTimeoutMs"
  ]) integer(p[field], field, 1, 2147483647);
  for (const field of ["baseInputDelayTicks", "minInputDelayTicks", "maxInputDelayTicks", "rollbackWindowTicks", "tickDriftThreshold"]) integer(p[field], field, 0, 65535);
  if (p.minInputDelayTicks > p.baseInputDelayTicks || p.baseInputDelayTicks > p.maxInputDelayTicks) throw new RangeError("input delay bounds");
  if (p.peerTimeoutMs <= p.peerInterruptMs) throw new RangeError("peerTimeoutMs must exceed peerInterruptMs");
  if (p.stateHistorySize < p.rollbackWindowTicks + 2) throw new RangeError("stateHistorySize must exceed rollback window by two");
  if (p.mode === "lockstep" && p.checksumInterval > p.stateHistorySize) throw new RangeError("lockstep checksumInterval must fit input history window");
  if (p.stateHistorySize > 8192) throw new RangeError("stateHistorySize capacity (8192)");
  if (p.tickRate > 240 || p.maxCommandBytes > CHUNK_SIZE - 1024 || p.maxSnapshotBytes > 64 * 1024 * 1024) throw new RangeError("profile size limit");
  if (!["hold", "neutral"].includes(p.predictionPolicy) && typeof p.predictionPolicy !== "function") throw new TypeError("predictionPolicy");
  if (!["none", "hold", "dilation"].includes(p.pacingPolicy) || p.stallPolicy !== "wait") throw new TypeError("pacing/stall policy");
  return Object.freeze(p);
}
function createSession(options) {
  return new RollbackSession(options);
}
function delegateRoomRecovery(session, selectBoundary) {
  session._roomRecovery = selectBoundary;
}
var boundaries = /* @__PURE__ */ new WeakMap();
function createSessionFromBoundary(options, state, hash) {
  const token = {};
  boundaries.set(token, { adapter: options.adapter, state, hash });
  return new RollbackSession(options, token);
}
var RollbackSession = class {
  constructor({
    players,
    localPlayerId,
    sessionId,
    simulationVersion,
    seed = 1,
    inputSize,
    profile = profiles.action,
    adapter,
    authorityPlayerId,
    onEvent = () => {
    },
    recordReplay = true,
    clock = nowMs,
    localCommandState,
    initialCommandSequences
  } = {}, boundaryToken) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 8 || players.some((p) => typeof p !== "string" || !p.length || p.length > 128) || new Set(players).size !== players.length) throw new TypeError("fixed player roster (1..8 unique IDs)");
    this.players = Object.freeze([...players].sort(compareIds));
    if (!this.players.includes(localPlayerId)) throw new TypeError("localPlayerId");
    if (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 128 || typeof simulationVersion !== "string" || !simulationVersion.length || simulationVersion.length > 128) throw new TypeError("sessionId/simulationVersion");
    if (!adapter || ["save", "load", "step", "validateSnapshot"].some((n) => typeof adapter[n] !== "function")) throw new TypeError("Simulation Adapter must save, load, step, validateSnapshot");
    this.localPlayerId = localPlayerId;
    this.sessionId = sessionId;
    this.simulationVersion = simulationVersion;
    this.seed = integer(seed, "seed");
    this.inputSize = integer(inputSize, "inputSize", 1, 1024);
    if (typeof clock !== "function") throw new TypeError("monotonic runtime clock");
    this._clock = clock;
    this.profile = profileOf(profile);
    this.adapter = adapter;
    this.onEvent = onEvent;
    this.authorityPlayerId = authorityPlayerId ?? this.players[0];
    if (!this.players.includes(this.authorityPlayerId)) throw new TypeError("authorityPlayerId");
    this._tick = 0;
    this._inputDelay = this.profile.baseInputDelayTicks;
    this._requestedInputDelay = this._inputDelay;
    this.closed = false;
    this._failure = null;
    this._history = this._newHistory();
    this._inputWriter = new Writer(CHUNK_SIZE * this.players.length);
    this._inputs = new Map(this.players.map((p) => [p, /* @__PURE__ */ new Map()]));
    this._through = new Map(this.players.map((p) => [p, -1]));
    this._used = /* @__PURE__ */ new Map();
    this._peers = /* @__PURE__ */ new Map();
    this._pendingCommands = [];
    this._commandSequences = commandSequenceMap(this.players, initialCommandSequences);
    this._commandSequence = this._commandSequences.get(localPlayerId);
    this._sequence = 0;
    this._captureTick = -1;
    this._lastLocalInput = new Uint8Array(this.inputSize);
    this._localCapture = null;
    this._localCaptureSequence = 0;
    this._localExecutedInput = null;
    if (localCommandState !== void 0) {
      const carried = copyLocalCommandState(localCommandState, this.inputSize, this.profile, this._commandSequence);
      this._commandSequence = carried.sequence;
      this._lastLocalInput = carried.lastInput;
      this._pendingCommands = carried.commands;
    }
    this._rollbackFrom = Infinity;
    this._replaying = false;
    this._inputHash = 2166136261;
    this._lastHashTick = -1;
    this._nextTransfer = 0;
    this._recoveryAttempts = 0;
    this._incomingSnapshot = null;
    this._requestedRecovery = null;
    this._lastAdaptation = null;
    this._stableWindows = 0;
    this._pace = 1;
    this._window = { advances: 0, received: 0, late: 0, depth: 0, rollback: 0, stall: 0, cost: 0, costSamples: 0 };
    this._metrics = {
      rollbacks: 0,
      resimulatedTicks: 0,
      maxRollbackDepth: 0,
      stalls: 0,
      holds: 0,
      recoveries: 0,
      rejectedSnapshots: 0,
      rejectedPackets: 0,
      sentBytes: 0,
      receivedBytes: 0,
      predictedTicks: 0,
      hashMismatches: 0,
      latestResimulationMs: 0,
      smoothedRTT: 0,
      jitter: 0,
      lateInputRate: 0,
      rollbackFrequency: 0,
      stallFrequency: 0,
      resimulationCostMs: 0,
      stateHashComputations: 0,
      hashedStateBytes: 0,
      snapshotSaves: 0,
      serializedSnapshotBytes: 0
    };
    this._recordReplay = recordReplay;
    this._replayFrames = [];
    this._replayBytes = 0;
    this._replayFinalHash = void 0;
    const boundary = boundaries.get(boundaryToken);
    if (boundary) boundaries.delete(boundaryToken);
    if (boundary && boundary.adapter !== adapter) throw new Error("initial boundary adapter");
    const initial = boundary ? boundary.state : this._save();
    if (!initial.length || initial.length > this.profile.maxSnapshotBytes) throw new RangeError("snapshot size");
    const retainedCount = this.profile.mode === "lockstep" ? Math.ceil(this.profile.stateHistorySize / this.profile.checksumInterval) + 2 : this.profile.stateHistorySize;
    const requiredBytes = initial.length * retainedCount;
    if (requiredBytes > this.profile.maxHistoryBytes) throw Object.assign(new RangeError("initial snapshot cannot fill retained history byte budget"), { code: "history-capacity", snapshotBytes: initial.length, requiredBytes, maxHistoryBytes: this.profile.maxHistoryBytes });
    this._initialState = boundary ? initial : initial.slice();
    const initialRecord = { tick: 0, bytes: initial, inputHash: this._inputHash, ...boundary ? { hash: boundary.hash } : {} };
    this._history.put(initialRecord);
    this._currentState = initialRecord;
    this._hello = encoder.encode(JSON.stringify({
      protocol: PROTOCOL_VERSION,
      library: VERSION,
      sessionId,
      simulationVersion,
      seed,
      players: this.players,
      tickRate: this.profile.tickRate,
      inputSize,
      authorityPlayerId: this.authorityPlayerId,
      mode: this.profile.mode,
      baseInputDelayTicks: this.profile.mode === "lockstep" ? this.profile.baseInputDelayTicks : null,
      checksumInterval: this.profile.mode === "lockstep" ? this.profile.checksumInterval : null,
      initialHash: this._stateHash(initialRecord)
    }));
    const neutral = new Uint8Array(this.inputSize);
    for (let t = 0; t < this.inputDelay; t++) this._commitLocal(t, neutral, []);
  }
  get tick() {
    return this._tick;
  }
  get inputDelay() {
    return this._inputDelay;
  }
  get confirmedTick() {
    return Math.min(...this._through.values());
  }
  /** Detached metadata about immutable local captures, not a simulation snapshot. */
  get localInputState() {
    const frame = this._localCapture;
    return {
      epoch: 0,
      baseTick: 0,
      tick: this.tick,
      confirmedTick: Math.min(this.tick - 1, this.confirmedTick),
      inputDelay: this.inputDelay,
      commandSequence: this._commandSequence,
      executedInput: this._localExecutedInput?.slice() ?? null,
      replayInput: (this._inputs.get(this.localPlayerId).get(this.tick)?.input ?? this._localExecutedInput)?.slice() ?? null,
      executedCommandSequence: this.profile.mode === "lockstep" ? this._commandSequences.get(this.localPlayerId) : null,
      capture: frame ? { ...frame, input: frame.input.slice(), commands: frame.commands.map((c) => ({ ...c, payload: c.payload.slice() })) } : null
    };
  }
  get resimulating() {
    return this._replaying || this._rollbackFrom !== Infinity;
  }
  get failure() {
    return this._failure;
  }
  get requestedInputDelay() {
    return this._requestedInputDelay;
  }
  get ready() {
    return !this.closed && !this._failure && this.players.every((p) => p === this.localPlayerId || this._peers.get(p)?.ready && this._peers.get(p).connectionState === "connected");
  }
  get status() {
    if (this.closed) return "closed";
    if (this._failure) return "failed";
    const peers = [...this._peers.values()];
    if (peers.some((p) => p.connectionState === "disconnected")) return "disconnected";
    if (peers.some((p) => p.connectionState === "interrupted")) return "interrupted";
    if (!this.ready) return "synchronizing";
    if (this._requestedRecovery) return "recovering";
    return this.resimulating ? "resimulating" : "running";
  }
  getPeerState(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return void 0;
    return Object.freeze({
      peerId,
      state: peer.connectionState,
      handshakeComplete: peer.ready,
      lastReceivedAt: peer.lastReceivedAt,
      simTick: peer.tick,
      confirmedInputTick: peer.confirmed,
      ackTick: peer.ack,
      rtt: peer.rtt,
      jitter: peer.jitter
    });
  }
  /** Current scheduling multiplier without allocating a diagnostic metrics snapshot. */
  get pace() {
    return this._pace;
  }
  get metrics() {
    return {
      ...this._metrics,
      inputDelay: this.inputDelay,
      requestedInputDelay: this.requestedInputDelay,
      confirmedTick: this.confirmedTick,
      tick: this.tick,
      pace: this._pace,
      retainedSnapshotBytes: this._history.byteLength
    };
  }
  _newHistory() {
    const History = this.profile.mode === "lockstep" ? CheckpointHistory : StateHistory;
    return new History(this.profile.stateHistorySize, this.profile.maxHistoryBytes);
  }
  _stateAt(tick) {
    const retained = this._history.get(tick);
    if (retained) return retained;
    if (this.profile.mode !== "lockstep" || tick !== this.tick || this.resimulating) return void 0;
    if (this._currentState?.tick === tick) return this._currentState;
    if (this._failure?.type === "fatal") return void 0;
    if (this._currentState?.tick !== tick) this._currentState = { tick, bytes: this._save(), inputHash: this._inputHash };
    return this._currentState;
  }
  _stateHash(state) {
    if (!state) return void 0;
    if (state.hash === void 0) {
      state.hash = hashBytes(state.bytes);
      this._metrics.stateHashComputations++;
      this._metrics.hashedStateBytes += state.bytes.length;
    }
    return state.hash;
  }
  _hashInputFrame(tick, inputs, previousHash) {
    const w = this._inputWriter.reset();
    w.u32(tick);
    for (const f of inputs) {
      w.raw(f.input);
      w.u16(f.commands.length);
      for (const c of f.commands) {
        w.u32(c.sequence);
        w.u16(c.payload.length);
        w.raw(c.payload);
      }
    }
    return hashBytes(w.usedBytes(), previousHash);
  }
  _event(type, detail = {}) {
    try {
      this.onEvent({ type, tick: this.tick, ...detail });
    } catch {
    }
  }
  _fail(type, detail = {}) {
    if (this._failure || this.closed) return;
    this._failure = Object.freeze({ type, ...detail });
    this._event(type, detail);
  }
  _peerTransition(peer, state, type, detail = {}) {
    if (peer.connectionState === state) return;
    const previous = peer.connectionState;
    peer.connectionState = state;
    if (type) this._event(type, { peerId: peer.id, previous, state, ...detail });
  }
  _transportStatus(peer, state) {
    const value = typeof state === "string" ? state : state?.state;
    peer.transportState = value;
    if (value === "closed" || value === "failed") this._peerTransition(peer, "disconnected", "peer-disconnected", { reason: "transport-" + value });
    else if (value === "interrupted") this._peerTransition(peer, "interrupted", "peer-interrupted", { reason: "transport-interrupted" });
  }
  _peerAlive(peer, sequence, now) {
    if (["closed", "failed"].includes(peer.transportState)) return;
    const delta = peer.lastReceivedSequence === null ? 1 : sequence - peer.lastReceivedSequence >>> 0;
    if (delta === 0 || delta >= 2147483648) return;
    peer.lastReceivedSequence = sequence;
    peer.lastReceivedAt = now;
    this._peerTransition(peer, "connected", peer.connectionState === "connecting" ? null : "peer-resumed");
  }
  _peerLiveness(peer, now) {
    if (["closed", "failed"].includes(peer.transportState)) return;
    const silence = Math.max(0, now - peer.lastReceivedAt);
    if (silence >= this.profile.peerTimeoutMs) this._peerTransition(peer, "disconnected", "peer-timeout", { silenceMs: silence });
    else if (silence >= this.profile.peerInterruptMs && peer.connectionState !== "disconnected") this._peerTransition(peer, "interrupted", "peer-interrupted", { reason: "silence", silenceMs: silence });
  }
  _save() {
    const state = bytes(this.adapter.save(), "snapshot").slice();
    if (!state.length || state.length > this.profile.maxSnapshotBytes) throw new RangeError("snapshot size");
    this._metrics.snapshotSaves++;
    this._metrics.serializedSnapshotBytes += state.length;
    return state;
  }
  _nextSequence() {
    this._sequence = this._sequence + 1 >>> 0;
    return this._sequence;
  }
  attachTransport(peerId, transport) {
    if (this.closed) throw new Error("session closed");
    if (this._failure) throw new Error("session failed: " + this._failure.type);
    if (peerId === this.localPlayerId || !this.players.includes(peerId) || this._peers.has(peerId)) throw new TypeError("peerId already attached or outside roster");
    if (typeof transport?.send !== "function" || typeof transport.subscribe !== "function") throw new TypeError("Transport capability: send and subscribe");
    const peer = {
      id: peerId,
      transport,
      ready: false,
      ack: -1,
      tick: 0,
      confirmed: -1,
      clockSequence: null,
      clockAt: 0,
      lastSent: -Infinity,
      lastHello: -Infinity,
      pendingPings: /* @__PURE__ */ new Map(),
      echo: 0,
      rtt: 0,
      jitter: 0,
      hashes: /* @__PURE__ */ new Map(),
      controls: [],
      queuedBytes: 0,
      lastHashQueued: 0,
      unsubscribe: null,
      unsubscribeStatus: null,
      connectionState: "connecting",
      transportState: void 0,
      lastReceivedAt: this._clock(),
      lastReceivedSequence: null
    };
    this._peers.set(peerId, peer);
    let detached = false;
    const current = () => !this.closed && !detached && this._peers.get(peerId) === peer;
    peer.detach = () => {
      if (detached) return;
      detached = true;
      if (this._peers.get(peerId) === peer) this._peers.delete(peerId);
      const unsubscribe = peer.unsubscribe, unsubscribeStatus = peer.unsubscribeStatus;
      peer.unsubscribe = peer.unsubscribeStatus = null;
      try {
        unsubscribe?.();
      } finally {
        unsubscribeStatus?.();
      }
    };
    peer.unsubscribe = transport.subscribe((data) => {
      if (current()) this.receive(peerId, data);
    });
    peer.unsubscribeStatus = transport.subscribeStatus?.((state) => {
      if (current()) this._transportStatus(peer, state);
    });
    if (transport.state) this._transportStatus(peer, transport.state);
    this._sendHello(peer, this._clock());
    return peer.detach;
  }
  _send(peer, data) {
    try {
      if (peer.transport.send(data) === false) return false;
      this._metrics.sentBytes += data.length;
      return true;
    } catch (error) {
      this._event("transport-error", { peerId: peer.id, error });
      return false;
    }
  }
  _sendHello(peer, now) {
    if (this._send(peer, packet(TYPE.HELLO, this._nextSequence(), (w) => w.raw(this._hello)))) peer.lastHello = now;
  }
  _queue(peer, data) {
    if (peer.queuedBytes + data.length > this.profile.maxQueuedBytes) return false;
    peer.controls.push(data);
    peer.queuedBytes += data.length;
    return true;
  }
  _commitLocal(tick, input, commands) {
    integer(tick, "session tick limit", 0, MAX_TICK);
    const frame = { input: input.slice(), commands };
    if (this._inputs.get(this.localPlayerId).has(tick)) throw new Error("committed input is immutable");
    this._inputs.get(this.localPlayerId).set(tick, frame);
    this._through.set(this.localPlayerId, tick);
  }
  queueCommand(payload) {
    if (this.closed) throw new Error("session closed");
    if (this._failure) throw new Error("session failed: " + this._failure.type);
    const b = bytes(payload).slice();
    if (!b.length || b.length > Math.min(this.profile.maxCommandBytes, CHUNK_SIZE - 1024 - this.inputSize - 6) || this._pendingCommands.length >= this.profile.maxPendingCommands) throw new RangeError("command capacity");
    integer(this._commandSequence + 1, "command sequence", 1);
    const sequence = ++this._commandSequence;
    this._pendingCommands.push({ sequence, payload: b });
    return sequence;
  }
  /** Copy unexecuted local commands for a new fixed-roster epoch. */
  exportLocalCommandState() {
    if (this.closed || this.resimulating) throw new Error("local command state is unavailable");
    const commands = /* @__PURE__ */ new Map();
    const include = (command) => {
      const prior = commands.get(command.sequence);
      if (prior && !equalBytes(prior.payload, command.payload)) throw new Error("conflicting local command sequence");
      if (!prior) commands.set(command.sequence, command);
    };
    for (const [tick, frame] of this._inputs.get(this.localPlayerId)) if (tick >= this.tick) for (const command of frame.commands) include(command);
    for (const command of this._pendingCommands) include(command);
    return copyLocalCommandState(
      {
        sequence: this._commandSequence,
        lastInput: this._lastLocalInput,
        commands: [...commands.values()].sort((a, b) => a.sequence - b.sequence)
      },
      this.inputSize,
      this.profile,
      this._commandSequences.get(this.localPlayerId)
    );
  }
  /** Executed lockstep command maxima; future captured/queued commands are excluded. */
  getCommandSequences() {
    if (this.profile.mode !== "lockstep") throw new Error("confirmed lockstep command sequences are required");
    return Object.fromEntries(this._commandSequences);
  }
  setInputDelay(ticks) {
    integer(ticks, "input delay", this.profile.minInputDelayTicks, this.profile.maxInputDelayTicks);
    this._requestedInputDelay = ticks;
    if (ticks > this.inputDelay) this._applyInputDelay(ticks);
  }
  _applyInputDelay(ticks) {
    const previous = this.inputDelay;
    this._inputDelay = ticks;
    this._event("input-delay", { previous, value: ticks });
  }
  _capture(input) {
    const b = bytes(input);
    if (b.length !== this.inputSize) throw new RangeError("inputSize");
    const previous = this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId))?.input ?? this._lastLocalInput;
    this._lastLocalInput = b.slice();
    if (this._captureTick === this.tick) return;
    this._captureTick = this.tick;
    if (this._requestedInputDelay < this.inputDelay && equalBytes(b, previous) && !this._pendingCommands.length) this._applyInputDelay(this.inputDelay - 1);
    const target = integer(this.tick + this.inputDelay, "session tick limit", 0, MAX_TICK);
    const through = this._through.get(this.localPlayerId);
    if (target <= through) return;
    for (let t = through + 1; t < target; t++) this._commitLocal(t, previous, []);
    let budget = CHUNK_SIZE - 1024 - this.inputSize;
    const commands = [];
    while (this._pendingCommands.length && commands.length < this.profile.maxPendingCommands && this._pendingCommands[0].payload.length + 6 <= budget) {
      const c = this._pendingCommands.shift();
      budget -= c.payload.length + 6;
      commands.push({ ...c, executeTick: target });
    }
    this._commitLocal(target, this._lastLocalInput, commands);
    this._localCapture = {
      sequence: ++this._localCaptureSequence,
      captureTick: this.tick,
      executeTick: target,
      input: this._lastLocalInput.slice(),
      commands: commands.map((c) => ({ ...c, payload: c.payload.slice() }))
    };
  }
  releaseInput() {
    if (this.closed || this._failure) return;
    this._lastLocalInput = new Uint8Array(this.inputSize);
    const last = this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId));
    if (last && equalBytes(last.input, this._lastLocalInput)) {
      for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
      return;
    }
    const target = integer(Math.max(this.tick + this.inputDelay, this._through.get(this.localPlayerId) + 1), "session tick limit", 0, MAX_TICK);
    for (let t = this._through.get(this.localPlayerId) + 1; t <= target; t++) this._commitLocal(t, this._lastLocalInput, []);
    for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
    this._event("input-release", { executeTick: target });
  }
  _sendInputs(peer) {
    const map = this._inputs.get(this.localPlayerId);
    const first = peer.ack + 1;
    if (!map.has(first)) return;
    const frames = [];
    let cost = HEADER + 16;
    for (let t = first; frames.length < 128 && map.has(t); t++) {
      const f = map.get(t);
      const n = 7 + this.inputSize + f.commands.reduce((s, c) => s + 6 + c.payload.length, 0);
      if (cost + n > CHUNK_SIZE) break;
      frames.push(f);
      cost += n;
    }
    if (!frames.length) return;
    this._send(peer, packet(TYPE.INPUT, this._nextSequence(), (w) => {
      w.u32(first);
      w.u16(frames.length);
      w.u16(this.inputSize);
      w.i32(this._through.get(peer.id));
      w.u32(this.tick);
      for (let i = 0; i < frames.length; ) {
        const f = frames[i];
        let run = 1;
        while (i + run < frames.length && !frames[i + run].commands.length && equalBytes(f.input, frames[i + run].input)) run++;
        w.u16(run);
        w.raw(f.input);
        w.u16(f.commands.length);
        for (const c of f.commands) {
          w.u32(c.sequence);
          w.u16(c.payload.length);
          w.raw(c.payload);
        }
        i += run;
      }
    }));
  }
  _sendClock(peer, now, replyTo) {
    const id = this._nextSequence();
    const data = packet(TYPE.CLOCK, id, (w) => {
      w.u32(this.tick);
      w.i32(this.confirmedTick);
      w.i32(this._through.get(peer.id));
      w.u32(replyTo ?? 0);
      w.u8(replyTo === void 0 ? 0 : 1);
    });
    if (this._send(peer, data)) {
      if (replyTo === void 0) {
        peer.pendingPings.set(id, now);
        peer.lastSent = now;
      }
      while (peer.pendingPings.size > 32) peer.pendingPings.delete(peer.pendingPings.keys().next().value);
    }
  }
  poll(now = this._clock()) {
    if (this.closed || this._failure) return;
    if (!Number.isFinite(now)) throw new TypeError("network time");
    for (const peer of this._peers.values()) {
      this._peerLiveness(peer, now);
      if (!peer.ready) {
        if (now - peer.lastHello >= this.profile.heartbeatMs) this._sendHello(peer, now);
        continue;
      }
      if (now - peer.lastSent >= this.profile.heartbeatMs) {
        this._sendInputs(peer);
        this._sendClock(peer, now);
      }
      let sent = 0;
      while (peer.controls.length && sent < 65536) {
        const data = peer.controls[0];
        if (!this._send(peer, data)) break;
        peer.controls.shift();
        peer.queuedBytes -= data.length;
        sent += data.length;
      }
    }
    if (this._incomingSnapshot && now - this._incomingSnapshot.started > this.profile.recoveryTimeoutMs) this._rejectSnapshot("snapshot timeout");
    if (this._requestedRecovery && now - this._requestedRecovery.at > this.profile.recoveryTimeoutMs) {
      this._requestedRecovery = null;
      this._event("recovery-timeout");
      this._recoveryExhausted("timeout");
    }
    if (this._failure) return;
    if (this.resimulating) this._rollback();
    if (this._failure) return;
    this._adapt(now);
    this._sendHashes();
    this._checkHashes();
    this._recordConfirmed();
  }
  receive(peerId, data, now = this._clock()) {
    if (this.closed || this._failure) return false;
    const peer = this._peers.get(peerId);
    if (!peer || ["closed", "failed"].includes(peer.transportState)) return false;
    try {
      const b = bytes(data);
      if (b.length < HEADER || b.length > CHUNK_SIZE) throw new RangeError("packet size");
      const r = new Reader(b);
      if (r.u32() !== MAGIC) throw new Error("protocol magic");
      const protocolVersion = r.u8();
      if (protocolVersion !== PROTOCOL_VERSION) {
        this._event("version-mismatch", { peerId, field: "protocol", expected: PROTOCOL_VERSION, received: protocolVersion });
        throw new Error("protocol version");
      }
      const type = r.u8();
      if (r.u16() !== 0) throw new Error("reserved header");
      const sequence = r.u32();
      this._metrics.receivedBytes += b.length;
      if (type === TYPE.HELLO) {
        const hello = r.raw(b.length - HEADER);
        r.end();
        if (!equalBytes(hello, this._hello)) {
          const expected = JSON.parse(decoder.decode(this._hello)), received = JSON.parse(decoder.decode(hello));
          const fields = Object.keys(expected).filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(received?.[field]));
          if (!fields.length) throw new Error("noncanonical HELLO");
          const type2 = fields.some((field) => ["protocol", "library", "simulationVersion"].includes(field)) ? "version-mismatch" : "handshake-mismatch";
          this._fail(type2, { peerId, fields: Object.freeze(fields), mismatches: Object.freeze(fields.map((field) => Object.freeze({ field, expected: expected[field], received: received?.[field] }))) });
          return false;
        }
        const wasReady = peer.ready;
        peer.ready = true;
        this._peerAlive(peer, sequence, now);
        if (!wasReady) {
          this._sendHello(peer, now);
          this._event("peer-ready", { peerId });
        }
        return true;
      }
      if (!peer.ready) return false;
      if (type === TYPE.INPUT) this._receiveInputs(peer, r, sequence, now);
      else if (type === TYPE.CLOCK) this._receiveClock(peer, r, sequence, now);
      else if (type === TYPE.HASH) {
        const tick = r.u32(), hash = r.u32(), inputHash = r.u32();
        r.end();
        if (tick <= this.tick + this.profile.stateHistorySize && tick >= Math.max(0, this.tick - this.profile.stateHistorySize + 1)) peer.hashes.set(tick, { hash, inputHash });
      } else if (type === TYPE.REQUEST) {
        const tick = r.u32();
        r.end();
        this._sendSnapshot(peer, tick);
      } else if (type === TYPE.BEGIN) this._beginSnapshot(peer, r, now);
      else if (type === TYPE.CHUNK) this._snapshotChunk(peer, r);
      else throw new Error("unknown packet type");
      this._peerAlive(peer, sequence, now);
      return true;
    } catch (error) {
      this._metrics.rejectedPackets++;
      this._event("protocol-error", { peerId, error });
      return false;
    }
  }
  _receiveInputs(peer, r, sequence, now) {
    const first = r.u32(), count = r.u16(), size = r.u16(), ack = r.i32(), simTick = r.u32();
    if (!count || count > 128 || size !== this.inputSize || first + count - 1 > MAX_TICK || first + count > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks + 1) throw new RangeError("input timeline");
    if (ack < -1 || ack > this._through.get(this.localPlayerId)) throw new RangeError("ack");
    const incoming = [];
    while (incoming.length < count) {
      const run = r.u16();
      if (!run || incoming.length + run > count) throw new RangeError("input run");
      const input = r.raw(size), n = r.u16(), commands = [];
      if (n > this.profile.maxPendingCommands) throw new RangeError("command count");
      let previous = 0;
      for (let i = 0; i < n; i++) {
        const sequence2 = r.u32(), len = r.u16();
        if (!sequence2 || sequence2 <= previous || !len || len > this.profile.maxCommandBytes) throw new RangeError("command shape/order");
        previous = sequence2;
        commands.push({ sequence: sequence2, executeTick: first + incoming.length, payload: r.raw(len) });
      }
      incoming.push({ input, commands });
      for (let j = 1; j < run; j++) incoming.push({ input: input.slice(), commands: [] });
    }
    r.end();
    const map = this._inputs.get(peer.id);
    for (let i = 0; i < count; i++) {
      const old = map.get(first + i);
      if (old && !frameEqual(old, incoming[i])) {
        if (this.profile.mode === "lockstep" && first + i < this.tick) this._fail("desync-unrecoverable", { reason: "conflicting-confirmed-input", peerId: peer.id, inputTick: first + i });
        throw new Error("conflicting committed input");
      }
    }
    peer.ack = Math.max(peer.ack, ack);
    if (peer.progressSequence === void 0 || sequence - peer.progressSequence >>> 0 < 2147483648 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence;
      peer.tick = simTick;
      peer.clockAt = now;
    }
    const oldest = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    for (let i = 0; i < count; i++) {
      const t = first + i;
      if (map.has(t) || t < oldest) continue;
      map.set(t, incoming[i]);
      this._window.received++;
      if (t < this.tick) this._window.late++;
      const used = this._used.get(t)?.find((x) => x.playerId === peer.id);
      if (used && t < this.tick && !frameEqual(used, incoming[i])) {
        if (this.profile.mode === "lockstep") {
          this._fail("desync-unrecoverable", { reason: "conflicting-confirmed-input", peerId: peer.id, inputTick: t });
          return;
        }
        if (!this._history.get(t)) {
          this._event("history-exhausted", { inputTick: t });
          this.requestResync(Math.min(this.confirmedTick + 1, this.tick));
        } else this._rollbackFrom = Math.min(this._rollbackFrom, t);
      }
    }
    let through = this._through.get(peer.id);
    while (map.has(through + 1)) through++;
    this._through.set(peer.id, through);
  }
  _receiveClock(peer, r, sequence, now) {
    const tick = r.u32(), confirmed = r.i32(), ack = r.i32(), echo = r.u32(), reply = r.u8();
    r.end();
    if (reply > 1) throw new RangeError("clock reply flag");
    if (tick > MAX_TICK + 1 || confirmed < -1 || confirmed > ack || ack < -1 || ack > this._through.get(this.localPlayerId)) throw new RangeError("clock/ack");
    const fresh = peer.clockSequence === null || sequence - peer.clockSequence >>> 0 < 2147483648 && sequence !== peer.clockSequence;
    if (!fresh) return;
    peer.clockSequence = sequence;
    peer.confirmed = confirmed;
    if (peer.progressSequence === void 0 || sequence - peer.progressSequence >>> 0 < 2147483648 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence;
      peer.tick = tick;
      peer.clockAt = now;
    }
    peer.ack = Math.max(peer.ack, ack);
    peer.echo = sequence;
    if (!reply) this._sendClock(peer, now, sequence);
    const sent = reply ? peer.pendingPings.get(echo) : void 0;
    if (sent !== void 0 && now >= sent) {
      const sample = now - sent;
      peer.pendingPings.delete(echo);
      const difference = Math.abs(sample - peer.rtt);
      peer.rtt = peer.rtt ? peer.rtt * 0.875 + sample * 0.125 : sample;
      peer.jitter = peer.jitter * 0.75 + (peer.rtt === sample ? 0 : difference * 0.25);
      this._metrics.smoothedRTT = Math.max(...[...this._peers.values()].map((p) => p.rtt));
      this._metrics.jitter = Math.max(...[...this._peers.values()].map((p) => p.jitter));
    }
  }
  _resolve(tick) {
    return this.players.map((playerId) => {
      const map = this._inputs.get(playerId), actual = map.get(tick);
      if (actual) return { playerId, ...copyFrame(actual), predicted: false };
      if (this.profile.mode === "lockstep") throw new Error("lockstep input is not confirmed");
      let prior = this._used.get(tick - 1)?.find((f) => f.playerId === playerId)?.input ?? new Uint8Array(this.inputSize);
      const policy = this.profile.predictionPolicy;
      if (typeof policy === "function") prior = bytes(policy({ playerId, tick, previousInput: prior.slice(), lastConfirmedTick: this._through.get(playerId) }));
      else if (policy === "neutral") prior = new Uint8Array(this.inputSize);
      if (prior.length !== this.inputSize) throw new RangeError("predictor inputSize");
      return { playerId, input: prior.slice(), commands: [], predicted: true };
    });
  }
  _restoreConfirmedBoundary(tick) {
    const base = this._history.atOrBefore(tick);
    if (!base) throw new Error("lockstep recovery base expired");
    this.adapter.load(base.bytes.slice());
    for (let t = base.tick; t < tick; t++) runSimulationFrame(this.adapter, {
      tick: t,
      tickRate: this.profile.tickRate,
      inputs: this._resolve(t),
      resimulating: true,
      recovering: true
    });
  }
  _replayFrameBytes(inputs) {
    return inputs.reduce((s, f) => s + f.input.length + f.commands.reduce((k, c) => k + c.payload.length + 12, 0), 16);
  }
  _step(inputs, resimulating) {
    const before = this._history.get(this.tick);
    const tick = this.tick, lockstep = this.profile.mode === "lockstep";
    integer(tick, "session tick limit", 0, MAX_TICK);
    if (lockstep && this._recordReplay && this._replayBytes + this._replayFrameBytes(inputs) > this.profile.maxReplayBytes) {
      this._replayFinalHash = this._stateHash(this._stateAt(tick));
      this._recordReplay = false;
      this._event("replay-capacity");
    }
    try {
      runSimulationFrame(this.adapter, { tick, tickRate: this.profile.tickRate, inputs, resimulating });
      const inputHash = this._hashInputFrame(tick, inputs, this._inputHash);
      if (!lockstep || (tick + 1) % this.profile.checksumInterval === 0) {
        const state = this._save();
        this._history.put({ tick: tick + 1, bytes: state, inputHash });
      }
      if (!lockstep) this._used.set(tick, inputs.map((f) => ({ ...copyFrame(f), playerId: f.playerId, predicted: f.predicted })));
      this._tick++;
      this._inputHash = inputHash;
      this._currentState = null;
      const localFrame = inputs.find((frame) => frame.playerId === this.localPlayerId);
      if (localFrame) this._localExecutedInput = localFrame.input.slice();
      if (lockstep) for (const frame of inputs) for (const command of frame.commands) {
        this._commandSequences.set(frame.playerId, Math.max(this._commandSequences.get(frame.playerId), command.sequence));
      }
    } catch (error) {
      try {
        if (before) this.adapter.load(before.bytes.slice());
        else if (lockstep) this._restoreConfirmedBoundary(tick);
        if (lockstep) this._currentState = { tick, bytes: this._save(), inputHash: this._inputHash };
      } catch (restoreError) {
        this._currentState = null;
        this._fail("fatal", { error, restoreError });
        throw error;
      }
      this._fail("fatal", { error });
      throw error;
    }
  }
  _rollback() {
    const started = nowMs();
    this._replaying = true;
    try {
      if (this._rollbackFrom !== Infinity) {
        const target = this.tick, from = this._rollbackFrom;
        const saved = this._history.get(from);
        if (!saved) throw new Error("rollback state expired");
        this.adapter.load(saved.bytes.slice());
        this._tick = from;
        this._inputHash = saved.inputHash;
        this._history.invalidateAfter(from);
        this._rollbackFrom = Infinity;
        this._metrics.rollbacks++;
        this._window.rollback++;
        this._metrics.maxRollbackDepth = Math.max(this._metrics.maxRollbackDepth, target - from);
        this._window.depth = Math.max(this._window.depth, target - from);
        this._event("rollback", { from, target });
        while (this.tick < target) {
          this._step(this._resolve(this.tick), true);
          this._metrics.resimulatedTicks++;
        }
      }
      return true;
    } finally {
      this._replaying = false;
      this._metrics.latestResimulationMs = nowMs() - started;
      this._window.cost += this._metrics.latestResimulationMs;
      this._window.costSamples++;
    }
  }
  _frameAdvantage(now) {
    let advantage = -Infinity;
    for (const peer of this._peers.values()) if (peer.ready && peer.clockSequence !== null) {
      const age = Math.max(0, Math.min(1e3 / this.profile.tickRate, now - peer.clockAt));
      const estimated = peer.tick + (age + peer.rtt / 2) * this.profile.tickRate / 1e3;
      advantage = Math.max(advantage, this.tick - estimated);
    }
    return Number.isFinite(advantage) ? advantage : 0;
  }
  advance(input = this._lastLocalInput) {
    if (this.closed) throw new Error("session closed");
    const now = this._clock();
    this.poll(now);
    if (this._failure) return { status: "failed", tick: this.tick, failure: this.failure };
    if (["interrupted", "disconnected"].includes(this.status)) return { status: this.status, tick: this.tick };
    if (this._requestedRecovery) return { status: "recovering", tick: this.tick };
    if (this.resimulating) return { status: "resimulating", tick: this.tick };
    this._capture(input);
    for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
    if (!this.ready) return { status: "synchronizing", tick: this.tick };
    const advantage = this._frameAdvantage(now);
    const threshold = this.profile.tickDriftThreshold;
    const hold = this.profile.pacingPolicy === "hold" && advantage > threshold || this.profile.pacingPolicy === "dilation" && advantage > Math.max(4, threshold * 3);
    if (hold) {
      this._metrics.holds++;
      return { status: "held", tick: this.tick };
    }
    if (this.profile.mode === "lockstep" && this.players.some((id) => !this._inputs.get(id).has(this.tick))) {
      this._metrics.stalls++;
      this._window.stall++;
      return { status: "stalled", tick: this.tick };
    }
    const inputs = this._resolve(this.tick), predicted = inputs.some((f) => f.predicted);
    const minAck = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
    if (predicted && this.tick - (this.confirmedTick + 1) >= this.profile.rollbackWindowTicks || this._through.get(this.localPlayerId) - minAck >= this.profile.stateHistorySize * 4) {
      this._metrics.stalls++;
      this._window.stall++;
      return { status: "stalled", tick: this.tick };
    }
    this._step(inputs, false);
    this._window.advances++;
    if (predicted) this._metrics.predictedTicks++;
    this._recordConfirmed();
    this._sendHashes();
    this._checkHashes();
    this._prune();
    return { status: "advanced", tick: this.tick };
  }
  _adapt(now) {
    if (this._lastAdaptation === null) {
      this._lastAdaptation = now;
      return;
    }
    if (now - this._lastAdaptation < this.profile.adaptationIntervalMs) return;
    const seconds = (now - this._lastAdaptation) / 1e3;
    this._lastAdaptation = now;
    const w = this._window;
    const lateRate = w.received ? w.late / w.received : 0;
    this._metrics.lateInputRate = this._metrics.lateInputRate * 0.75 + lateRate * 0.25;
    this._metrics.rollbackFrequency = this._metrics.rollbackFrequency * 0.75 + w.rollback / seconds * 0.25;
    this._metrics.stallFrequency = this._metrics.stallFrequency * 0.75 + w.stall / seconds * 0.25;
    const cost = w.costSamples ? w.cost / w.costSamples : 0;
    this._metrics.resimulationCostMs = this._metrics.resimulationCostMs * 0.75 + cost * 0.25;
    if (this.profile.adaptiveInputDelay) {
      const measured = Math.ceil((this._metrics.smoothedRTT / 2 + 2 * this._metrics.jitter) * this.profile.tickRate / 1e3);
      const pressure = this._metrics.lateInputRate > 0.1 || this._metrics.rollbackFrequency > 2 || w.depth > 3 || this._metrics.stallFrequency > 2 || this._metrics.resimulationCostMs > 1e3 / this.profile.tickRate;
      if (pressure || measured > this.inputDelay + 1) {
        this.setInputDelay(Math.min(this.profile.maxInputDelayTicks, Math.max(this.inputDelay + 1, measured)));
        this._stableWindows = 0;
      } else if (w.advances > 0 && !w.late && !w.stall && measured <= this.inputDelay - 1) {
        if (++this._stableWindows >= 3) {
          this.setInputDelay(Math.max(this.profile.minInputDelayTicks, this.inputDelay - 1));
          this._stableWindows = 0;
        }
      } else this._stableWindows = 0;
    }
    if (this.profile.pacingPolicy === "dilation") {
      const drift = this._frameAdvantage(now);
      const target = Math.abs(drift) < 0.5 ? 1 : Math.max(0.98, Math.min(1.05, 1 + drift * 5e-3));
      const change = Math.max(-5e-3, Math.min(5e-3, (target - this._pace) * 0.2));
      this._pace = Math.max(0.98, Math.min(1.05, this._pace + change));
    }
    this._window = { advances: 0, received: 0, late: 0, depth: 0, rollback: 0, stall: 0, cost: 0, costSamples: 0 };
  }
  _sendHashes() {
    if (this.resimulating) return;
    const upTo = Math.min(this.tick, this.confirmedTick + 1);
    const t = Math.floor(upTo / this.profile.checksumInterval) * this.profile.checksumInterval;
    if (!t) return;
    const s = this._history.get(t);
    if (!s) return;
    for (const peer of this._peers.values()) if (peer.ready && peer.lastHashQueued < t) {
      if (this._queue(peer, packet(TYPE.HASH, this._nextSequence(), (w) => {
        w.u32(t);
        w.u32(this._stateHash(s));
        w.u32(s.inputHash);
      }))) peer.lastHashQueued = t;
    }
  }
  _checkHashes() {
    if (this.resimulating) return;
    for (const peer of this._peers.values()) for (const [tick, remote] of peer.hashes) {
      if (tick > Math.min(this.tick, this.confirmedTick + 1)) continue;
      const local = this._history.get(tick);
      if (!local) {
        peer.hashes.delete(tick);
        continue;
      }
      if (local.inputHash !== remote.inputHash) {
        peer.hashes.delete(tick);
        this._event("input-history-mismatch", { peerId: peer.id, at: tick });
        if (this.profile.mode === "lockstep") this._fail("desync-unrecoverable", { reason: "input-history-mismatch", peerId: peer.id, at: tick });
        continue;
      }
      if (this._stateHash(local) !== remote.hash) {
        if (!remote.notified) {
          remote.notified = true;
          this._metrics.hashMismatches++;
          this._event("desync", { peerId: peer.id, at: tick });
        }
        if (this._roomRecovery) {
          this._roomRecovery(tick);
          peer.hashes.delete(tick);
        } else if (this.localPlayerId === this.authorityPlayerId || this.requestResync(tick)) peer.hashes.delete(tick);
      } else peer.hashes.delete(tick);
    }
  }
  getStateHash(tick = this.tick) {
    return this._stateHash(this._stateAt(tick));
  }
  /** Export a sparse, fully confirmed boundary without enabling per-tick saves. */
  exportConfirmedBootstrap({ checkpointAtOrBefore = this.tick } = {}) {
    if (this.profile.mode !== "lockstep" || this.closed || this._failure || this.resimulating || this._requestedRecovery || this.confirmedTick < this.tick - 1) throw new Error("confirmed lockstep boundary is required");
    integer(checkpointAtOrBefore, "bootstrap checkpoint boundary", 0, this.tick);
    const checkpoint = this._history.atOrBefore(checkpointAtOrBefore);
    if (!checkpoint || this.tick - checkpoint.tick > this.profile.stateHistorySize) throw new Error("bootstrap checkpoint is unavailable");
    const frames = [];
    for (let tick = checkpoint.tick; tick < this.tick; tick++) {
      const inputs = this.players.map((playerId) => {
        const frame = this._inputs.get(playerId).get(tick);
        if (!frame) throw new Error("confirmed bootstrap input is unavailable");
        return { playerId, ...copyFrame(frame), predicted: false };
      });
      frames.push({ tick, inputs });
    }
    return {
      version: 1,
      tick: this.tick,
      checkpoint: { tick: checkpoint.tick, bytes: checkpoint.bytes.slice(), hash: this._stateHash(checkpoint) },
      players: [...this.players],
      frames,
      hash: this.getStateHash(),
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      commandSequences: this.getCommandSequences()
    };
  }
  /** Fence an external resume donor against this peer's retained agreed history. */
  verifyConfirmedBootstrap(bootstrap) {
    if (this.profile.mode !== "lockstep" || this.closed || this._failure || this.resimulating || !bootstrap || bootstrap.tick < this.tick || bootstrap.tick - bootstrap.checkpoint?.tick > this.profile.stateHistorySize || !Array.isArray(bootstrap.frames) || bootstrap.frames.length !== bootstrap.tick - bootstrap.checkpoint.tick || JSON.stringify(bootstrap.players) !== JSON.stringify(this.players)) throw new Error("resume bootstrap boundary");
    const base = this._history.get(bootstrap.checkpoint.tick);
    if (!base || this._stateHash(base) !== bootstrap.checkpoint.hash || !equalBytes(base.bytes, bytes(bootstrap.checkpoint.bytes))) throw new Error("resume checkpoint does not match retained agreement");
    const sequences = new Map(this._commandSequences);
    for (let i = 0; i < bootstrap.frames.length; i++) {
      const frame = bootstrap.frames[i], tick = base.tick + i;
      if (frame.tick !== tick || frame.inputs?.length !== this.players.length) throw new Error("resume input suffix shape");
      for (let p = 0; p < this.players.length; p++) {
        const id = this.players[p], incoming = frame.inputs[p], known = this._inputs.get(id).get(tick);
        if (incoming?.playerId !== id || incoming.predicted || !Array.isArray(incoming.commands) || !known && (tick < this.tick || id === this.localPlayerId) || known && !frameEqual(known, incoming)) throw new Error("resume input conflicts with retained agreement");
        if (tick >= this.tick) for (const command of incoming.commands) sequences.set(id, Math.max(sequences.get(id), command.sequence));
      }
    }
    for (const id of this.players) if (bootstrap.commandSequences?.[id] !== sequences.get(id)) throw new Error("resume command sequence conflicts with retained agreement");
    if (bootstrap.tick === this.tick && bootstrap.hash !== this.getStateHash()) throw new Error("resume final state conflicts with confirmed boundary");
    return true;
  }
  requestResync(tick) {
    if (this.closed || this._failure) return false;
    integer(tick, "recovery tick", 0, Math.min(this.tick, this.confirmedTick + 1));
    if (this.localPlayerId === this.authorityPlayerId) return false;
    const peer = this._peers.get(this.authorityPlayerId);
    if (!peer?.ready || this._requestedRecovery) return false;
    if (this._recoveryExhausted("attempt-limit")) return false;
    const state = this.profile.mode === "lockstep" ? this._history.atOrBefore(tick) : this._history.get(tick);
    if (!state) return false;
    tick = state.tick;
    if (!this._queue(peer, packet(TYPE.REQUEST, this._nextSequence(), (w) => w.u32(tick)))) return false;
    this._requestedRecovery = { tick, inputHash: state.inputHash, at: this._clock() };
    this._recoveryAttempts++;
    return true;
  }
  _sendSnapshot(peer, tick) {
    if (this.localPlayerId !== this.authorityPlayerId || this.resimulating || tick > this.confirmedTick + 1) return;
    const state = this._history.get(tick);
    if (!state) return;
    const transfer = ++this._nextTransfer >>> 0, count = Math.ceil(state.bytes.length / SNAP_CHUNK_BYTES);
    const packets = [packet(TYPE.BEGIN, this._nextSequence(), (w) => {
      w.u32(transfer);
      w.u32(tick);
      w.u32(state.bytes.length);
      w.u32(this._stateHash(state));
      w.u32(state.inputHash);
      w.u16(count);
    })];
    for (let i = 0; i < count; i++) packets.push(packet(TYPE.CHUNK, this._nextSequence(), (w) => {
      w.u32(transfer);
      w.u32(i);
      w.raw(state.bytes.subarray(i * SNAP_CHUNK_BYTES, (i + 1) * SNAP_CHUNK_BYTES));
    }));
    if (peer.queuedBytes + packets.reduce((s, b) => s + b.length, 0) > this.profile.maxQueuedBytes) {
      this._event("recovery-backpressure", { peerId: peer.id });
      return;
    }
    for (const p of packets) this._queue(peer, p);
  }
  _beginSnapshot(peer, r, now) {
    const transfer = r.u32(), tick = r.u32(), total = r.u32(), hash = r.u32(), inputHash = r.u32(), count = r.u16();
    r.end();
    const busy = this._incomingSnapshot;
    if (busy) {
      if (peer.id === this.authorityPlayerId && transfer === busy.transfer && tick === busy.tick && total === busy.total && hash === busy.hash && inputHash === busy.inputHash && count === busy.count) return;
      throw new Error("another snapshot candidate is active");
    }
    if (peer.id !== this.authorityPlayerId || !this._requestedRecovery || this._requestedRecovery.tick !== tick || inputHash !== this._requestedRecovery.inputHash || !this._history.get(tick) || tick > this.confirmedTick + 1 || !total || total > this.profile.maxSnapshotBytes || count !== Math.ceil(total / SNAP_CHUNK_BYTES) || this._incomingSnapshot) throw new Error("snapshot candidate metadata");
    this._incomingSnapshot = {
      transfer,
      tick,
      total,
      hash,
      inputHash,
      count,
      bytes: new Uint8Array(total),
      seen: new Uint8Array(count),
      received: 0,
      started: now
    };
  }
  _snapshotChunk(peer, r) {
    const transfer = r.u32(), index = r.u32(), candidate = this._incomingSnapshot;
    if (peer.id !== this.authorityPlayerId || !candidate || transfer !== candidate.transfer || index >= candidate.count) throw new Error("snapshot transfer");
    const chunk = r.raw(r.data.length - r.offset);
    r.end();
    const expected = Math.min(SNAP_CHUNK_BYTES, candidate.total - index * SNAP_CHUNK_BYTES);
    if (chunk.length !== expected) throw new RangeError("snapshot chunk length");
    const start = index * SNAP_CHUNK_BYTES;
    if (candidate.seen[index]) {
      if (!equalBytes(candidate.bytes.subarray(start, start + expected), chunk)) throw new Error("conflicting snapshot chunk");
      return;
    }
    candidate.bytes.set(chunk, start);
    candidate.seen[index] = 1;
    candidate.received++;
    if (candidate.received === candidate.count) this._commitSnapshot(candidate);
  }
  _rejectSnapshot(reason) {
    this._incomingSnapshot = null;
    this._requestedRecovery = null;
    this._metrics.rejectedSnapshots++;
    this._event("recovery-rejected", { reason });
    this._recoveryExhausted(reason);
  }
  _recoveryExhausted(reason) {
    if (this._recoveryAttempts < this.profile.maxRecoveryAttempts) return false;
    this._fail("desync-unrecoverable", { reason, attempts: this._recoveryAttempts, authorityPlayerId: this.authorityPlayerId });
    return true;
  }
  _commitSnapshot(candidate) {
    if (this.resimulating || !this._history.get(candidate.tick) || hashBytes(candidate.bytes) !== candidate.hash) {
      this._rejectSnapshot("expired or corrupt candidate");
      return;
    }
    const started = nowMs(), original = this._save();
    this._replaying = true;
    try {
      if (this.adapter.validateSnapshot(candidate.bytes.slice(), { tick: candidate.tick }) !== true) throw new Error("adapter rejected candidate");
      this.adapter.load(candidate.bytes.slice());
      if (!equalBytes(this._save(), candidate.bytes)) throw new Error("snapshot round-trip changed candidate");
      const job = {
        candidate,
        original,
        current: this.tick,
        next: candidate.tick,
        inputHash: candidate.inputHash,
        state: candidate.bytes.slice(),
        staged: [],
        stagedInputs: [],
        stageBytes: 0
      };
      this._incomingSnapshot = null;
      while (job.next < job.current) {
        const t = job.next, inputs = this._resolve(t);
        runSimulationFrame(this.adapter, {
          tick: t,
          tickRate: this.profile.tickRate,
          inputs,
          resimulating: true,
          recovering: true
        });
        job.inputHash = this._hashInputFrame(t, inputs, job.inputHash);
        const lockstep = this.profile.mode === "lockstep";
        if (!lockstep || (t + 1) % this.profile.checksumInterval === 0) {
          job.state = this._save();
          job.staged.push({ tick: t + 1, bytes: job.state, inputHash: job.inputHash });
          job.stageBytes += job.state.length;
        }
        if (!lockstep) job.stagedInputs.push([t, inputs]);
        if (lockstep && !this._recordReplay && t + 1 === this._replayFrames.length) job.replayFinalHash = hashBytes(this._save());
        job.next++;
        this._metrics.resimulatedTicks++;
        if (job.stageBytes > this.profile.maxHistoryBytes) throw new RangeError("candidate replay byte budget");
      }
      const replacement = this._newHistory();
      for (const state of this._history.slots) if (state && state.tick < job.candidate.tick) replacement.put(state);
      replacement.put({
        tick: job.candidate.tick,
        bytes: job.candidate.bytes,
        hash: job.candidate.hash,
        inputHash: job.candidate.inputHash
      });
      for (const state of job.staged) replacement.put(state);
      const used = new Map(this._used);
      for (const [t, inputs] of job.stagedInputs) used.set(t, inputs);
      this._history = replacement;
      this._used = used;
      this._inputHash = job.inputHash;
      this._currentState = null;
      if (this.profile.mode === "lockstep") {
        this._replayFinalState = null;
        if (!this._recordReplay && job.candidate.tick === this._replayFrames.length) this._replayFinalHash = job.candidate.hash;
        if (job.replayFinalHash !== void 0) this._replayFinalHash = job.replayFinalHash;
      }
      this._requestedRecovery = null;
      this._recoveryAttempts = 0;
      this._metrics.recoveries++;
      this._event("recovered", { from: job.candidate.tick, target: job.current });
    } catch (error) {
      this.adapter.load(original.slice());
      this._rejectSnapshot(error.message);
    } finally {
      this._replaying = false;
      this._metrics.latestResimulationMs = nowMs() - started;
      this._window.cost += this._metrics.latestResimulationMs;
      this._window.costSamples++;
    }
  }
  _recordConfirmed() {
    if (!this._recordReplay || this.resimulating || this._failure) return;
    this._replayFinalState = this._history.get(this._replayFrames.length) ?? this._replayFinalState;
    const through = Math.min(this.confirmedTick, this.tick - 1);
    for (let t = this._replayFrames.length; t <= through; t++) {
      const inputs = this.players.map((playerId) => ({ playerId, ...copyFrame(this._inputs.get(playerId).get(t)), predicted: false }));
      const n = this._replayFrameBytes(inputs);
      if (this._replayBytes + n > this.profile.maxReplayBytes) {
        this._replayFinalHash = this._stateHash(this._replayFinalState);
        this._replayFinalState = null;
        this._recordReplay = false;
        this._event("replay-capacity");
        return;
      }
      this._replayFrames.push({ tick: t, inputs });
      this._replayBytes += n;
      this._replayFinalState = this._history.get(t + 1);
    }
  }
  exportSyncTestFrames({ maxFrames = 32 } = {}) {
    integer(maxFrames, "maxFrames", 1, 256);
    if (this.resimulating) throw new Error("finish rollback before exporting synctest frames");
    this._recordConfirmed();
    return {
      initialState: this._initialState.slice(),
      players: [...this.players],
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      initialTick: 0,
      frames: this._replayFrames.slice(0, maxFrames).map((f) => ({
        tick: f.tick,
        inputs: f.inputs.map((x) => ({ ...copyFrame(x), playerId: x.playerId, predicted: false }))
      }))
    };
  }
  exportReplay() {
    if (this.resimulating) throw new Error("finish rollback before exporting replay");
    this._recordConfirmed();
    const tick = this._replayFrames.length;
    const hash = this._stateHash(this._stateAt(tick)) ?? this._stateHash(this._replayFinalState) ?? this._replayFinalHash;
    if (tick > 0 && hash === void 0) throw new Error("replay final boundary is unavailable after fatal restoration failure");
    return {
      version: VERSION,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      players: [...this.players],
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      initialState: this._initialState.slice(),
      frames: this._replayFrames.map((f) => ({
        tick: f.tick,
        inputs: f.inputs.map((x) => ({ ...copyFrame(x), playerId: x.playerId, predicted: false }))
      })),
      tick,
      hash: hash ?? hashBytes(this._initialState),
      truncated: !this._recordReplay
    };
  }
  _prune() {
    const windowOldest = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    const oldest = this.profile.mode === "lockstep" ? Math.min(windowOldest, this._history.oldestTick) : windowOldest;
    for (const t of this._used.keys()) if (t < oldest - 1) this._used.delete(t);
    const minAck = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
    for (const [playerId, map] of this._inputs) for (const t of map.keys()) if (t < oldest && (playerId !== this.localPlayerId || t <= minAck)) map.delete(t);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this._peers.values()) {
      try {
        peer.detach();
      } finally {
        peer.transport.close?.();
      }
    }
    this._peers.clear();
    this._incomingSnapshot = null;
    this._pendingCommands.length = 0;
    this._event("closed");
  }
};

// modules/rollback/bootstrap.js
var MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
var MAX_SUFFIX_TICKS = 8192;
function roster(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || Array.from(value).some((id) => typeof id !== "string" || !id.length || id.length > 128) || new Set(value).size !== value.length) throw new TypeError(name);
  return value.slice();
}
function validateBootstrap(bootstrap, limits, expected, deferCheckpointHash = false) {
  if (!bootstrap || bootstrap.version !== 1) throw new Error("bootstrap version");
  const tick = integer(bootstrap.tick, "bootstrap tick", 0, MAX_TICK + 1);
  const inputSize = integer(bootstrap.inputSize, "bootstrap inputSize", 1, 1024);
  const tickRate = integer(bootstrap.tickRate, "bootstrap tickRate", 1, 240);
  const seed = integer(bootstrap.seed, "bootstrap seed");
  const simulationVersion = bootstrap.simulationVersion;
  if (typeof simulationVersion !== "string" || !simulationVersion.length || simulationVersion.length > 128) throw new TypeError("bootstrap simulationVersion");
  const players = roster(bootstrap.players, "bootstrap players");
  if (players.some((id, index) => index > 0 && compareIds(players[index - 1], id) >= 0)) throw new Error("bootstrap player order");
  const providedSequences = bootstrap.commandSequences;
  if (!providedSequences || typeof providedSequences !== "object" || Array.isArray(providedSequences) || Object.keys(providedSequences).length !== players.length || players.some((id) => !Object.hasOwn(providedSequences, id))) throw new TypeError("bootstrap command sequences roster");
  const commandSequences = Object.fromEntries(players.map((id) => [id, integer(providedSequences[id], "bootstrap command sequence boundary")]));
  for (const field of ["simulationVersion", "inputSize", "tickRate", "seed"]) {
    if (expected[field] !== void 0 && expected[field] !== bootstrap[field]) throw new Error(`bootstrap ${field} mismatch`);
  }
  if (expected.players !== void 0) {
    const wanted = roster(expected.players, "expected players").sort(compareIds);
    if (wanted.length !== players.length || wanted.some((id, index) => id !== players[index])) throw new Error("bootstrap players mismatch");
  }
  const checkpoint = bootstrap.checkpoint;
  const start = integer(checkpoint?.tick, "bootstrap checkpoint tick", 0, tick);
  const data = bytes(checkpoint?.bytes, "bootstrap checkpoint");
  if (!data.length || data.length > limits.maxSnapshotBytes) throw new RangeError("bootstrap snapshot size");
  const checkpointBytes = data.slice();
  const checkpointHash = integer(checkpoint.hash, "bootstrap checkpoint hash");
  if (!deferCheckpointHash && hashBytes(checkpointBytes) !== checkpointHash) throw new Error("bootstrap checkpoint hash mismatch");
  const hash = integer(bootstrap.hash, "bootstrap final hash");
  if (!Array.isArray(bootstrap.frames) || bootstrap.frames.length !== tick - start || tick - start > limits.maxSuffixTicks) throw new RangeError("bootstrap suffix length");
  if (start === tick && checkpointHash !== hash) throw new Error("bootstrap final hash mismatch");
  let totalBytes = data.length;
  if (totalBytes > limits.maxReplayBytes) throw new RangeError("bootstrap replay byte budget");
  const sequences = new Map(players.map((id) => [id, 0]));
  const frames = Array.from(bootstrap.frames, (frame, index) => {
    const frameTick = start + index;
    if (frame?.tick !== frameTick) throw new Error("non-contiguous bootstrap suffix");
    if (!Array.isArray(frame.inputs) || frame.inputs.length !== players.length) throw new Error("bootstrap input roster");
    totalBytes += 16;
    const inputs = Array.from(frame.inputs, (inputFrame, player) => {
      if (inputFrame?.playerId !== players[player] || inputFrame.predicted !== false) throw new Error("bootstrap confirmed input order");
      const input = bytes(inputFrame.input, "bootstrap input");
      if (input.length !== inputSize) throw new RangeError("bootstrap inputSize");
      if (!Array.isArray(inputFrame.commands) || inputFrame.commands.length > limits.maxPendingCommands) throw new RangeError("bootstrap command count");
      let commandBytes = 0;
      totalBytes += inputSize;
      const commands = Array.from(inputFrame.commands, (command) => {
        const sequence = integer(command?.sequence, "bootstrap command sequence", 1);
        if (sequence <= sequences.get(players[player]) || command.executeTick !== frameTick) throw new Error("bootstrap command order/tick");
        sequences.set(players[player], sequence);
        const payload = bytes(command.payload, "bootstrap command payload");
        commandBytes += payload.length + 6;
        totalBytes += payload.length + 12;
        if (!payload.length || payload.length > limits.maxCommandBytes || commandBytes > CHUNK_SIZE - 1024 - inputSize) throw new RangeError("bootstrap command size");
        if (totalBytes > limits.maxReplayBytes) throw new RangeError("bootstrap replay byte budget");
        return { sequence, executeTick: frameTick, payload: payload.slice() };
      });
      if (totalBytes > limits.maxReplayBytes) throw new RangeError("bootstrap replay byte budget");
      return { playerId: players[player], input: input.slice(), commands, predicted: false };
    });
    return { tick: frameTick, inputs };
  });
  for (const [id, sequence] of sequences) if (sequence && sequence !== commandSequences[id]) throw new Error("bootstrap command sequence boundary mismatch");
  return {
    version: 1,
    tick,
    checkpoint: { tick: start, bytes: checkpointBytes, hash: checkpointHash },
    players,
    frames,
    hash,
    inputSize,
    tickRate,
    simulationVersion,
    seed,
    commandSequences
  };
}
function createBootstrapReplay({
  adapter,
  bootstrap,
  maxCatchupSteps = 8,
  maxCatchupMs = 8,
  clock = nowMs,
  maxSnapshotBytes = defaults.maxSnapshotBytes,
  maxSuffixTicks = MAX_SUFFIX_TICKS,
  maxCommandBytes = defaults.maxCommandBytes,
  maxPendingCommands = defaults.maxPendingCommands,
  maxReplayBytes = defaults.maxReplayBytes,
  simulationVersion,
  inputSize,
  tickRate,
  players,
  seed
} = {}) {
  if (!adapter || ["save", "load", "step", "validateSnapshot"].some((name) => typeof adapter[name] !== "function")) throw new TypeError("Simulation Adapter must save, load, step, validateSnapshot");
  integer(maxCatchupSteps, "maxCatchupSteps", 1, MAX_SUFFIX_TICKS);
  if (!Number.isFinite(maxCatchupMs) || maxCatchupMs <= 0 || typeof clock !== "function") throw new TypeError("bootstrap time budget");
  integer(maxSnapshotBytes, "maxSnapshotBytes", 1, MAX_SNAPSHOT_BYTES);
  integer(maxSuffixTicks, "maxSuffixTicks", 0, MAX_SUFFIX_TICKS);
  integer(maxCommandBytes, "maxCommandBytes", 1, CHUNK_SIZE - 1024);
  integer(maxPendingCommands, "maxPendingCommands", 1, 2147483647);
  integer(maxReplayBytes, "maxReplayBytes", 1, 2147483647);
  const cooperative = typeof adapter.saveJob === "function" && typeof adapter.prepareSnapshotJob === "function" && typeof adapter.loadPreparedSnapshot === "function";
  const candidate = validateBootstrap(
    bootstrap,
    { maxSnapshotBytes, maxSuffixTicks, maxCommandBytes, maxPendingCommands, maxReplayBytes },
    { simulationVersion, inputSize, tickRate, players, seed },
    cooperative
  );
  const save = () => {
    const data = bytes(adapter.save(), "bootstrap adapter snapshot");
    if (!data.length || data.length > maxSnapshotBytes) throw new RangeError("bootstrap adapter snapshot size");
    return data.slice();
  };
  const context = (tick2) => ({
    tick: tick2,
    tickRate: candidate.tickRate,
    players: candidate.players.slice(),
    simulationVersion: candidate.simulationVersion,
    seed: candidate.seed
  });
  if (cooperative) {
    return createCooperativeReplay({ adapter, candidate, context, maxSnapshotBytes, maxCatchupSteps, maxCatchupMs, clock });
  }
  const original = save();
  let tick = candidate.checkpoint.tick, status = "catching-up", result = null, failure = null;
  const restore = (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    status = "failed";
    try {
      adapter.load(original.slice());
    } catch (restoreError) {
      failure = new AggregateError([failure, restoreError], "bootstrap replay failed and original snapshot restoration failed");
    }
    throw failure;
  };
  const preparedPath = typeof adapter.prepareSnapshot === "function" && typeof adapter.loadPreparedSnapshot === "function";
  const prepared = preparedPath ? adapter.prepareSnapshot(candidate.checkpoint.bytes.slice(), context(tick)) : null;
  if (preparedPath ? !prepared : adapter.validateSnapshot(candidate.checkpoint.bytes.slice(), context(tick)) !== true) throw new Error("adapter rejected bootstrap checkpoint");
  try {
    if (preparedPath) adapter.loadPreparedSnapshot(prepared, context(tick));
    else {
      adapter.load(candidate.checkpoint.bytes.slice());
      if (!equalBytes(save(), candidate.checkpoint.bytes)) throw new Error("bootstrap checkpoint round-trip mismatch");
    }
  } catch (error) {
    restore(error);
  }
  return Object.freeze({
    get tick() {
      return tick;
    },
    get targetTick() {
      return candidate.tick;
    },
    get status() {
      return status;
    },
    get done() {
      return status === "done";
    },
    get result() {
      return result;
    },
    get failure() {
      return failure;
    },
    pulse() {
      if (failure) throw failure;
      if (status !== "catching-up") return Object.freeze({ status, tick, targetTick: candidate.tick, steps: 0, ...result ?? {} });
      let steps = 0;
      const started = clock();
      try {
        while (tick < candidate.tick && steps < maxCatchupSteps && (steps === 0 || clock() - started < maxCatchupMs)) {
          const frame = candidate.frames[tick - candidate.checkpoint.tick];
          runSimulationFrame(adapter, {
            tick,
            tickRate: candidate.tickRate,
            inputs: frame.inputs,
            resimulating: true,
            recovering: true,
            replaying: true
          });
          tick++;
          steps++;
        }
        if (tick === candidate.tick) {
          const unchanged = preparedPath && candidate.tick === candidate.checkpoint.tick;
          const final = unchanged ? candidate.checkpoint.bytes : save();
          if (!unchanged && hashBytes(final) !== candidate.hash) throw new Error("bootstrap final hash mismatch");
          if (!unchanged && adapter.validateSnapshot(final.slice(), context(tick)) !== true) throw new Error("adapter rejected bootstrap final state");
          status = "done";
          result = Object.freeze({ tick, hash: candidate.hash });
        }
        return Object.freeze({ status, tick, targetTick: candidate.tick, steps, ...result ?? {} });
      } catch (error) {
        return restore(error);
      }
    },
    cancel() {
      if (failure) throw failure;
      if (status === "catching-up") {
        try {
          adapter.load(original.slice());
          status = "cancelled";
        } catch (error) {
          return restore(error);
        }
      }
      return Object.freeze({ status, tick, targetTick: candidate.tick, steps: 0, ...result ?? {} });
    }
  });
}
function createCooperativeReplay({ adapter, candidate, context, maxSnapshotBytes, maxCatchupSteps, maxCatchupMs, clock }) {
  let tick = candidate.checkpoint.tick, status = "catching-up", phase = "checkpoint-hash", result = null, failure = null;
  let original, final, loaded = false, job, hash = 2166136261, hashOffset = 0;
  const own = (value) => {
    const data = bytes(value, "bootstrap job snapshot");
    if (!data.length || data.length > maxSnapshotBytes) throw new RangeError("bootstrap adapter snapshot size");
    return data.slice();
  };
  const checkJob = (value) => {
    if (!value || typeof value.pulse !== "function" || typeof value.cancel !== "function") throw new TypeError("snapshot preparation job");
    return value;
  };
  const fail = (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    status = "failed";
    try {
      job?.cancel();
    } catch {
    }
    job = null;
    if (loaded && original) {
      try {
        adapter.load(original.slice());
      } catch (restoreError) {
        failure = new AggregateError([failure, restoreError], "bootstrap replay failed and original snapshot restoration failed");
      }
    }
    original = final = null;
    throw failure;
  };
  const finish = () => {
    status = "done";
    phase = "done";
    result = Object.freeze({ tick, hash: candidate.hash });
    original = final = null;
  };
  const response = (steps) => Object.freeze({ status, tick, targetTick: candidate.tick, steps, ...result ?? {} });
  return Object.freeze({
    get tick() {
      return tick;
    },
    get targetTick() {
      return candidate.tick;
    },
    get status() {
      return status;
    },
    get done() {
      return status === "done";
    },
    get result() {
      return result;
    },
    get failure() {
      return failure;
    },
    pulse() {
      if (failure) throw failure;
      if (status !== "catching-up") return response(0);
      let steps = 0;
      const started = clock();
      try {
        if (phase === "checkpoint-hash") {
          do {
            const end = Math.min(candidate.checkpoint.bytes.length, hashOffset + 65536);
            hash = hashBytes(candidate.checkpoint.bytes.subarray(hashOffset, end), hash);
            hashOffset = end;
          } while (hashOffset < candidate.checkpoint.bytes.length && clock() - started < maxCatchupMs);
          if (hashOffset === candidate.checkpoint.bytes.length) {
            if (hash !== candidate.checkpoint.hash) throw new Error("bootstrap checkpoint hash mismatch");
            hash = 2166136261;
            hashOffset = 0;
            phase = "original";
          }
        } else if (phase === "original" || phase === "final") {
          job ??= checkJob(adapter.saveJob());
          job.pulse({ budgetMs: maxCatchupMs });
          if (job.done) {
            const data = own(job.result);
            job = null;
            if (phase === "original") {
              original = data;
              phase = "prepare";
            } else {
              final = data;
              phase = "hash";
            }
          }
        } else if (phase === "prepare" || phase === "validate") {
          job ??= checkJob(adapter.prepareSnapshotJob((phase === "prepare" ? candidate.checkpoint.bytes : final).slice(), context(tick)));
          job.pulse({ budgetMs: maxCatchupMs });
          if (job.done) {
            const token = job.result;
            job = null;
            if (!token) throw new Error("adapter rejected bootstrap snapshot");
            if (phase === "validate") finish();
            else {
              final = token;
              phase = "install";
            }
          }
        } else if (phase === "install") {
          const token = final;
          final = null;
          loaded = true;
          adapter.loadPreparedSnapshot(token, context(tick));
          if (tick === candidate.tick) finish();
          else phase = "replay";
        } else if (phase === "replay") {
          while (tick < candidate.tick && steps < maxCatchupSteps && (steps === 0 || clock() - started < maxCatchupMs)) {
            runSimulationFrame(adapter, {
              tick,
              tickRate: candidate.tickRate,
              inputs: candidate.frames[tick - candidate.checkpoint.tick].inputs,
              resimulating: true,
              recovering: true,
              replaying: true
            });
            tick++;
            steps++;
          }
          if (tick === candidate.tick) phase = "final";
        } else if (phase === "hash") {
          do {
            const end = Math.min(final.length, hashOffset + 65536);
            hash = hashBytes(final.subarray(hashOffset, end), hash);
            hashOffset = end;
          } while (hashOffset < final.length && clock() - started < maxCatchupMs);
          if (hashOffset === final.length) {
            if (hash !== candidate.hash) throw new Error("bootstrap final hash mismatch");
            phase = "validate";
          }
        }
        return response(steps);
      } catch (error) {
        return fail(error);
      }
    },
    cancel() {
      if (failure) throw failure;
      if (status === "catching-up") {
        try {
          job?.cancel();
          job = null;
          if (loaded) adapter.load(original.slice());
        } catch (error) {
          return fail(error);
        }
        status = "cancelled";
        original = final = null;
      }
      return response(0);
    }
  });
}

// modules/rollback/availability.js
var sorted = (ids) => [...ids].sort(compareIds);
var equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
var branchValid = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
function availabilityConfig(value = {}) {
  const config = {
    mode: "strict",
    heartbeatMs: 250,
    silenceMs: 3e3,
    inputGraceMs: 3e3,
    resumeGapMs: 3e3,
    roundTimeoutMs: 5e3,
    retryMs: 500,
    ...value
  };
  if (!["strict", "available"].includes(config.mode)) throw new TypeError("availability mode");
  config.autoTransfer = Object.freeze({
    enabled: false,
    intervalMs: 1e4,
    minTenureMs: 3e4,
    minImprovementMs: 10,
    minSamples: 10,
    rttWeight: 1,
    jitterWeight: 2,
    stepWeight: 4,
    stepEmaAlpha: 0.1,
    ...value.autoTransfer
  });
  for (const key of ["heartbeatMs", "silenceMs", "inputGraceMs", "resumeGapMs", "roundTimeoutMs", "retryMs"]) integer(config[key], key, 1);
  if (config.silenceMs < config.heartbeatMs * 2 || config.inputGraceMs < config.heartbeatMs * 2) throw new RangeError("availability grace must cover two heartbeats");
  if (typeof config.autoTransfer.enabled !== "boolean") throw new TypeError("autoTransfer enabled");
  for (const [key, n] of Object.entries(config.autoTransfer)) if (key !== "enabled") {
    if (!Number.isFinite(n) || n < 0 || ["intervalMs", "minTenureMs", "minSamples"].includes(key) && (!Number.isSafeInteger(n) || n < 1)) throw new RangeError("autoTransfer " + key);
  }
  if (config.autoTransfer.stepEmaAlpha <= 0 || config.autoTransfer.stepEmaAlpha > 1) throw new RangeError("autoTransfer stepEmaAlpha");
  return Object.freeze(config);
}
var Availability = class {
  constructor(session) {
    this.session = session;
    this.config = session.availability;
    this.peers = /* @__PURE__ */ new Map();
    this.round = null;
    this.branch = "0".repeat(32);
    this.wireBranch = new Uint8Array(16);
    this.anchorId = session.coordinatorId;
    this.recovering = !!session.room?.resumed;
    this.lastPoll = session.clock();
    this.lastAdvance = this.lastPoll;
    this.lastHeartbeat = -Infinity;
    this.tenureAt = this.lastPoll;
    this.lastEvaluation = this.lastPoll;
    this.retryAt = 0;
    this.stepMs = 0;
    this.samples = 0;
    this.requested = this.recovering ? "resume" : null;
    this.states = /* @__PURE__ */ new Map();
  }
  get metrics() {
    return {
      branch: this.branch,
      coordinatorId: this.session.coordinatorId,
      activePlayers: [...this.session.activePlayers],
      suspendedPlayers: this.session.players.filter((id) => !this.session.activePlayers.includes(id)),
      recoveryRequired: this.recovering,
      availabilityDeadlineMs: this.round ? this.round.started + this.config.roundTimeoutMs : null,
      simulationStepMs: this.stepMs,
      simulationSamples: this.samples,
      availabilityPeers: [...this.peers].map(([peerId, observation]) => ({
        peerId,
        state: this.states.get(peerId),
        observedAtMs: observation.at,
        silenceDeadlineMs: observation.at + this.config.silenceMs,
        rttMs: observation.value.rtt,
        jitterMs: observation.value.jitter,
        stepMs: observation.value.stepMs,
        samples: observation.value.samples
      }))
    };
  }
  measureStep(elapsed) {
    const alpha = this.config.autoTransfer.stepEmaAlpha;
    this.stepMs = this.samples ? this.stepMs * (1 - alpha) + elapsed * alpha : elapsed;
    this.samples++;
  }
  summary(now) {
    const s = this.session, network = s.activePlayers.filter((id) => id !== s.localPlayerId).map((id) => s._core?.getPeerState(id)).filter((p) => p?.handshakeComplete);
    return {
      branch: this.branch,
      epoch: s.epoch,
      tick: s.tick,
      coordinatorId: s.coordinatorId,
      anchorId: this.anchorId,
      retainedBoundary: !!s._suspendedBootstrap || !!s._core && !s._core.failure && !s._core.resimulating && s._core.confirmedTick >= s._core.tick - 1,
      activePlayers: [...s.activePlayers],
      pumping: now - this.lastAdvance <= this.config.inputGraceMs,
      eligible: !this.recovering && now - this.lastAdvance <= this.config.inputGraceMs,
      requested: this.requested,
      recovering: this.recovering,
      inputIdleMs: Math.max(0, now - this.lastAdvance),
      stepMs: this.stepMs,
      samples: this.samples,
      rtt: network.length ? Math.max(...network.map((p) => p.rtt)) : 0,
      jitter: network.length ? Math.max(...network.map((p) => p.jitter)) : 0
    };
  }
  live(now) {
    const s = this.session;
    return sorted(s.players.filter((id) => id === s.localPlayerId || this.peers.has(id) && now - this.peers.get(id).at < this.config.silenceMs));
  }
  send(ids, op, detail) {
    this.session._broadcast(ids, "availability-" + op, detail);
  }
  poll(now) {
    const s = this.session;
    if (!this.polled) {
      this.polled = true;
      this.lastPoll = now;
      this.lastAdvance = now;
      this.tenureAt = now;
    }
    if (now - this.lastPoll > this.config.resumeGapMs && s.players.length > 1) {
      this.recovering = true;
      this.requested = "resume";
      s.releaseInput();
      s._event("resynchronizing", { reason: "pump-gap" });
    }
    this.lastPoll = now;
    if (!s._core && !s._suspendedBootstrap && !s.room?.resumed || s._transition && !s._transition.availability) return;
    if (now - this.lastHeartbeat >= this.config.heartbeatMs) {
      this.lastHeartbeat = now;
      this.send(s.players.filter((id) => id !== s.localPlayerId && s._links.has(id)), "activity", this.summary(now));
    }
    const live = this.live(now), summaries = new Map([[s.localPlayerId, this.summary(now)], ...[...this.peers].map(([id, p]) => [id, p.value])]);
    for (const id of s.players) {
      const state = !live.includes(id) ? "unresponsive" : summaries.get(id)?.recovering ? "resynchronizing" : !summaries.get(id)?.eligible || !s.activePlayers.includes(id) ? "suspended" : "active";
      if (this.states.get(id) !== state) {
        this.states.set(id, state);
        s._event("participant-state", { peerId: id, state, deadlineMs: (this.peers.get(id)?.at ?? now) + this.config.silenceMs });
      }
    }
    const round = this.round;
    if (round) {
      if (now - round.started >= this.config.roundTimeoutMs) {
        this.cancel();
        this.retryAt = now + this.config.retryMs;
        this.requested = "round-timeout";
        s._event("availability-retry");
        return;
      }
      this.drain(now);
      if (this.round !== round) return;
      if (round.replay) {
        const result = s._boundaryWork("bootstrapPulseMs", () => round.replay.pulse());
        s._stats.bootstrapTicks += result.steps ?? 0;
        if (round.replay.done) {
          round.replay = null;
          s._applyMembership(s._transition);
        }
      }
      if (round.leader === s.localPlayerId && round.votes.size === round.participants.length && !round.decision) {
        const choice = this.choose(round);
        round.decision = { ...choice, branch: round.id, epoch: Math.max(s.epoch, ...[...round.votes.values()].map((v) => v.epoch)) + 1 };
        this.send(round.participants, "decision", { round: round.id, decision: round.decision });
      }
      if (round.leader === s.localPlayerId && round.staged.size === round.participants.length && !round.commitSent) {
        if (new Set(round.staged.values()).size !== 1) throw new Error("availability installation mismatch");
        round.commitSent = true;
        this.send(round.participants, "commit", { round: round.id, hash: round.staged.get(s.localPlayerId) });
      }
      return;
    }
    const eligible = live.filter((id) => summaries.get(id)?.eligible);
    const participants = live.filter((id) => summaries.get(id)?.pumping);
    const allResumed = !eligible.length && live.length === s.players.length && live.every((id) => summaries.get(id)?.retainedBoundary) && participants.some((id) => summaries.get(id)?.recovering);
    const leaders = allResumed ? participants : eligible;
    if (!leaders.length || now < this.retryAt) return;
    if (s.players.some((id) => id !== s.localPlayerId && !this.peers.has(id)) && now - this.tenureAt < this.config.silenceMs) return;
    let reason = allResumed ? "all-resume" : this.requested;
    reason ??= participants.map((id) => summaries.get(id)?.requested).find(Boolean);
    if (!equal(eligible, s.activePlayers) || participants.some((id) => summaries.get(id)?.branch !== this.branch)) reason ??= "liveness";
    let transferTo = null;
    const config = this.config.autoTransfer;
    if (!reason && config.enabled && now - this.lastEvaluation >= config.intervalMs && now - this.tenureAt >= config.minTenureMs) {
      this.lastEvaluation = now;
      const score = (v) => v.rtt * config.rttWeight + v.jitter * config.jitterWeight + v.stepMs * config.stepWeight;
      const candidates = eligible.filter((id) => summaries.get(id).samples >= config.minSamples).sort((a, b) => score(summaries.get(a)) - score(summaries.get(b)) || compareIds(a, b));
      const current = summaries.get(s.coordinatorId), best = candidates[0];
      if (current?.samples >= config.minSamples && best && best !== s.coordinatorId && score(current) > score(summaries.get(best)) && score(current) - score(summaries.get(best)) >= config.minImprovementMs) {
        reason = "auto-transfer";
        transferTo = best;
      }
    }
    if (reason && leaders[0] === s.localPlayerId) {
      const voters = allResumed ? live : participants;
      this.requested = null;
      this.send(voters, "probe", { round: nonce(), participants: voters, leader: s.localPlayerId, reason, transferTo });
    }
  }
  choose(round) {
    const s = this.session;
    let votes = [...round.votes].filter(([, v2]) => v2.eligible);
    const allResumed = !votes.length;
    if (allResumed) {
      if (round.reason !== "all-resume" || round.votes.size !== s.players.length || [...round.votes.values()].some((v2) => !v2.retainedBoundary) || ![...round.votes.values()].some((v2) => v2.pumping && v2.recovering)) throw new Error("availability has no active donor");
      votes = [...round.votes];
    }
    const groups = /* @__PURE__ */ new Map();
    for (const [id, v2] of votes) {
      const key = v2.tick + ":" + v2.hash;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    const majority = [...groups.values()].filter((ids) => ids.length > s.players.length / 2).sort((a, b) => b.length - a.length)[0];
    let donor = majority?.sort(compareIds)[0];
    const latestTick = Math.max(...votes.map(([, v2]) => v2.tick));
    const anchor = votes.find(([id, v2]) => id === this.anchorId && (!allResumed || v2.tick === latestTick))?.[0];
    if (!donor) donor = anchor ?? votes.sort((a, b) => b[1].tick - a[1].tick || compareIds(a[0], b[0]))[0][0];
    const v = round.votes.get(donor), activePlayers = sorted([...round.votes].filter(([, value]) => value.pumping).map(([id]) => id));
    const coordinatorId = round.transferTo && activePlayers.includes(round.transferTo) ? round.transferTo : activePlayers.includes(v.coordinatorId) ? v.coordinatorId : activePlayers.includes(donor) ? donor : activePlayers[0];
    return {
      donor,
      tick: v.tick,
      hash: v.hash,
      coordinatorId,
      activePlayers,
      basis: majority ? "roster-majority" : anchor ? "responsive-coordinator" : "active-branch",
      votes: majority?.length ?? 0,
      rosterSize: s.players.length
    };
  }
  handle(from, m, now) {
    const s = this.session, op = m.op.slice("availability-".length);
    if (!s.players.includes(from)) return;
    if (op === "activity") {
      if (!branchValid(m.branch) || !Number.isSafeInteger(m.tick) || m.tick < 0 || !Number.isInteger(m.epoch) || m.epoch < 0 || !Array.isArray(m.activePlayers) || m.activePlayers.length > s.membership.maxPlayers || typeof m.eligible !== "boolean" || typeof m.retainedBoundary !== "boolean" || ["stepMs", "rtt", "jitter", "samples", "inputIdleMs"].some((k) => !Number.isFinite(m[k]) || m[k] < 0)) throw new Error("invalid availability observation");
      if (!s.players.includes(m.coordinatorId) || m.activePlayers.some((id) => !s.players.includes(id))) return;
      this.peers.set(from, { at: now, value: m });
      return;
    }
    if (op === "probe") {
      if (!branchValid(m.round) || m.leader !== from || !Array.isArray(m.participants) || !equal(sorted([...new Set(m.participants)]), m.participants) || !m.participants.includes(s.localPlayerId) || m.participants.some((id) => !s.players.includes(id))) return;
      if (s._transition && !s._transition.availability) return;
      if (this.round?.id === m.round || this.round && compareIds(this.round.leader, from) <= 0) return;
      this.cancel();
      const round2 = this.round = {
        id: m.round,
        leader: from,
        participants: m.participants,
        reason: m.reason,
        transferTo: m.transferTo,
        started: now,
        votes: /* @__PURE__ */ new Map(),
        staged: /* @__PURE__ */ new Map(),
        decision: null,
        replay: null
      };
      const vote = { ...this.summary(now), hash: s._core?.getStateHash() ?? s._suspendedBootstrap?.hash ?? 0 };
      round2.bootstrap = s._core?.exportConfirmedBootstrap() ?? s._suspendedBootstrap;
      round2.sourceBaseTick = s.baseTick;
      round2.sourceEpoch = s.epoch;
      round2.original = bytes(s.adapter.save()).slice();
      if (round2.reason === "all-resume" && vote.retainedBoundary) {
        if (!round2.bootstrap || hashBytes(round2.original) !== vote.hash) throw new Error("availability retained boundary changed");
        round2.bootstrap = { ...round2.bootstrap, checkpoint: { tick: round2.bootstrap.tick, bytes: round2.original.slice(), hash: vote.hash }, frames: [] };
      }
      this.send(round2.participants, "vote", { round: round2.id, vote });
      s._event("availability-preparing", { reason: round2.reason, deadlineMs: now + this.config.roundTimeoutMs });
      return;
    }
    const round = this.round;
    if (!round || m.round !== round.id || !round.participants.includes(from)) return;
    if (op === "vote") {
      const v = m.vote;
      if (!branchValid(v?.branch) || !Number.isSafeInteger(v.tick) || v.tick < 0 || !Number.isInteger(v.hash) || v.hash < 0 || v.hash > 4294967295 || !Number.isInteger(v.epoch) || v.epoch < 0 || v.epoch > 65534 || typeof v.eligible !== "boolean" || typeof v.pumping !== "boolean" || typeof v.recovering !== "boolean" || typeof v.retainedBoundary !== "boolean" || v.eligible && !v.pumping || !Array.isArray(v.activePlayers) || v.activePlayers.some((id) => !s.players.includes(id)) || !s.players.includes(v.coordinatorId)) throw new Error("invalid availability vote");
      round.votes.set(from, v);
      return;
    }
    if (op === "decision" && from === round.leader && !s._transition) {
      if (round.votes.size !== round.participants.length) {
        round.pendingDecision = m;
        return;
      }
      const expected = this.choose(round), d = m.decision;
      if (!equal(expected, Object.fromEntries(Object.keys(expected).map((k) => [k, d?.[k]]))) || d.branch !== round.id || d.epoch !== Math.max(s.epoch, ...[...round.votes.values()].map((v) => v.epoch)) + 1 || d.epoch > 65534) throw new Error("availability decision certificate");
      round.decision = d;
      if (s.localPlayerId === d.donor) this.send(round.participants, "checkpoint", { round: round.id, bootstrap: round.bootstrap, baseTick: round.sourceBaseTick, sourceEpoch: round.sourceEpoch });
      s._event("branch-selected", { ...d, reason: round.reason, discardedTick: s.tick });
      return;
    }
    if (op === "checkpoint" && !round.decision) {
      round.pendingCheckpoint = { from, message: m };
      return;
    }
    if (op === "checkpoint" && from === round.decision?.donor && !s._transition) {
      const d = round.decision;
      if (m.bootstrap?.hash !== d.hash || m.baseTick + m.bootstrap?.tick !== d.tick || m.sourceEpoch !== round.votes.get(from).epoch || !equal(m.bootstrap.players, round.votes.get(from).activePlayers)) throw new Error("availability checkpoint certificate");
      const tr = s._transition = {
        availability: true,
        proposal: {
          epoch: d.epoch,
          oldPlayers: [...s.players],
          players: [...s.players],
          joined: [],
          left: [],
          activePlayers: d.activePlayers,
          coordinatorId: d.coordinatorId,
          reason: round.reason,
          branch: d.branch
        },
        participants: round.participants,
        target: d.tick,
        startedAt: now,
        applied: false,
        commandSequences: m.bootstrap.commandSequences
      };
      round.replay = createBootstrapReplay({
        adapter: s._adapter(m.baseTick, m.sourceEpoch),
        bootstrap: m.bootstrap,
        maxCatchupSteps: s.membership.maxCatchupSteps,
        maxCatchupMs: s.membership.snapshotBudgetMs,
        maxSnapshotBytes: s.profile.maxSnapshotBytes,
        maxSuffixTicks: s.profile.checksumInterval,
        maxCommandBytes: s.profile.maxCommandBytes,
        maxPendingCommands: s.profile.maxPendingCommands,
        maxReplayBytes: s.membership.maxTransferBytes,
        simulationVersion: s.simulationVersion,
        inputSize: s.inputSize,
        tickRate: s.profile.tickRate,
        seed: s.seed
      });
      s._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length;
      return;
    }
    if (op === "staged") {
      if (!Number.isInteger(m.hash)) throw new Error("availability staged hash");
      round.staged.set(from, m.hash);
      return;
    }
    if (op === "commit" && from === round.leader) {
      if (round.staged.size !== round.participants.length || !s._transition?.applied) {
        round.pendingCommit = m;
        return;
      }
      if ([...round.staged.values()].some((hash) => hash !== m.hash) || s._transition.postHash !== m.hash) throw new Error("availability commit certificate");
      const tr = s._transition;
      if (round.reason === "auto-transfer" || round.participants.length === s.players.length) this.anchorId = tr.proposal.coordinatorId;
      this.branch = tr.proposal.branch;
      this.recovering = false;
      this.tenureAt = now;
      this.lastEvaluation = now;
      this.retryAt = now + this.config.retryMs;
      this.wireBranch = Uint8Array.from(this.branch.match(/../g), (hex) => parseInt(hex, 16));
      this.requested = null;
      if (round.votes.get(s.localPlayerId).pumping) this.lastAdvance = now;
      tr.discardCommands = round.votes.get(s.localPlayerId).branch !== round.votes.get(round.decision.donor).branch || round.votes.get(s.localPlayerId).hash !== round.decision.hash;
      const previousCoordinator = s.coordinatorId;
      this.round = null;
      s._commit(tr);
      if (s.coordinatorId !== previousCoordinator) s._event("coordinator-changed", { previousCoordinatorId: previousCoordinator, coordinatorId: s.coordinatorId, reason: round.reason });
      return;
    }
  }
  installed(hash) {
    this.send(this.round.participants, "staged", { round: this.round.id, hash });
  }
  drain(now) {
    const r = this.round;
    if (r?.pendingDecision && r.votes.size === r.participants.length) {
      const m = r.pendingDecision;
      r.pendingDecision = null;
      this.handle(r.leader, m, now);
    }
    if (r?.pendingCheckpoint && r.decision) {
      const p = r.pendingCheckpoint;
      r.pendingCheckpoint = null;
      this.handle(p.from, p.message, now);
    }
    if (r?.pendingCommit && r.staged.size === r.participants.length && this.session._transition?.applied) {
      const m = r.pendingCommit;
      r.pendingCommit = null;
      this.handle(r.leader, m, now);
    }
  }
  cancel() {
    this.round?.replay?.cancel();
    const s = this.session, tr = s._transition;
    if (tr?.availability) {
      tr.stageJob?.cancel();
      if (this.round?.original) s.adapter.load(this.round.original);
      s._transition = null;
    }
    this.round = null;
  }
};

// modules/deterministic/value-codec.js
function createValueCodec({ format = "binary", maxBytes = 16 * 1024 * 1024, maxDepth = 128, maxEntries = 1e6 } = {}) {
  if (!["binary", "json"].includes(format)) throw new TypeError("Unknown codec format");
  for (const limit of [maxBytes, maxDepth, maxEntries]) if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid codec limit");
  const encoder2 = new TextEncoder(), decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function normalize(value, depth = 0, seen = /* @__PURE__ */ new Set(), budget = { count: 0 }) {
    if (depth > maxDepth || ++budget.count > maxEntries) throw new RangeError("Value codec budget exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Finite numbers required");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      if (decoder2.decode(encoder2.encode(value)) !== value) throw new TypeError("Invalid Unicode string");
      return value;
    }
    if (!value || typeof value !== "object" || seen.has(value)) throw new TypeError("Unsupported or cyclic value");
    seen.add(value);
    let result;
    if (value instanceof Uint8Array) {
      if (format === "json") throw new TypeError("JSON codec does not support byte values");
      result = value;
    } else if (Array.isArray(value)) {
      result = Array.from(value, (item) => normalize(item, depth + 1, seen, budget));
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Plain records required");
      result = {};
      for (const key of Object.keys(value).sort()) {
        normalize(key, depth + 1, seen, budget);
        Object.defineProperty(result, key, { value: normalize(value[key], depth + 1, seen, budget), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(value);
    return result;
  }
  const stringCache = /* @__PURE__ */ new Map();
  let cachedStringBytes = 0;
  function stringBytes(value) {
    let data = stringCache.get(value);
    if (data) return data;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 55296 && c <= 56319) {
        const next = value.charCodeAt(++i);
        if (!(next >= 56320 && next <= 57343)) throw new TypeError("Invalid Unicode string");
      } else if (c >= 56320 && c <= 57343) throw new TypeError("Invalid Unicode string");
    }
    data = encoder2.encode(value);
    if (data.length <= 256 && stringCache.size < 1024 && cachedStringBytes + data.length <= 131072) {
      stringCache.set(value, data);
      cachedStringBytes += data.length;
    }
    return data;
  }
  function encode(value) {
    if (format === "json") {
      const bytes3 = encoder2.encode(JSON.stringify(normalize(value)));
      if (bytes3.length > maxBytes) throw new RangeError("Codec byte budget exceeded");
      return bytes3;
    }
    let bytes2 = new Uint8Array(Math.min(1024, maxBytes)), offset = 0, view = new DataView(bytes2.buffer), entries = 0;
    const seen = /* @__PURE__ */ new Set(), strings = /* @__PURE__ */ new Map();
    function reserve(size) {
      if (offset + size > maxBytes) throw new RangeError("Codec byte budget exceeded");
      if (offset + size > bytes2.length) {
        const next = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes2.length * 2)));
        next.set(bytes2);
        bytes2 = next;
        view = new DataView(bytes2.buffer);
      }
    }
    function byte(n) {
      reserve(1);
      bytes2[offset++] = n;
    }
    function length(n) {
      reserve(4);
      view.setUint32(offset, n, true);
      offset += 4;
    }
    function raw(data) {
      length(data.length);
      reserve(data.length);
      bytes2.set(data, offset);
      offset += data.length;
    }
    function variable(n) {
      while (n >= 128) {
        byte(n % 128 + 128);
        n = Math.floor(n / 128);
      }
      byte(n);
    }
    function write(v, depth = 0) {
      if (depth > maxDepth || ++entries > maxEntries) throw new RangeError("Value codec budget exceeded");
      if (v === null) byte(0);
      else if (v === false) byte(1);
      else if (v === true) byte(2);
      else if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new TypeError("Finite numbers required");
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
          byte(8);
          variable(v < 0 ? -v * 2 - 1 : v * 2);
        } else {
          byte(3);
          reserve(8);
          view.setFloat64(offset, v, true);
          offset += 8;
        }
      } else if (typeof v === "string") {
        const ref = strings.get(v);
        if (ref !== void 0) {
          byte(9);
          variable(ref);
        } else {
          strings.set(v, strings.size);
          byte(4);
          raw(stringBytes(v));
        }
      } else {
        if (!v || typeof v !== "object" || seen.has(v)) throw new TypeError("Unsupported or cyclic value");
        if (v instanceof Uint8Array) {
          byte(7);
          raw(v);
          return;
        }
        seen.add(v);
        if (Array.isArray(v)) {
          byte(5);
          length(v.length);
          for (const item of v) write(item, depth + 1);
        } else {
          const prototype = Object.getPrototypeOf(v);
          if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Plain records required");
          byte(6);
          const keys = Object.keys(v).sort();
          length(keys.length);
          for (const key of keys) {
            write(key, depth + 1);
            write(v[key], depth + 1);
          }
        }
        seen.delete(v);
      }
    }
    byte(82);
    byte(86);
    byte(1);
    write(value);
    return bytes2.slice(0, offset);
  }
  function decode(input) {
    const bytes2 = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
    if (!bytes2 || bytes2.length > maxBytes) throw new RangeError("Invalid codec bytes");
    let result;
    if (format === "json") result = normalize(JSON.parse(decoder2.decode(bytes2)));
    else {
      let need = function(n) {
        if (n > bytes2.length - offset) throw new RangeError("Truncated codec bytes");
      }, byte = function() {
        need(1);
        return bytes2[offset++];
      }, length = function() {
        need(4);
        const n = view.getUint32(offset, true);
        offset += 4;
        return n;
      }, raw = function() {
        const n = length();
        need(n);
        const data = bytes2.subarray(offset, offset + n);
        offset += n;
        return data;
      }, read = function(depth = 0) {
        if (depth > maxDepth || ++entries > maxEntries) throw new RangeError("Value codec budget exceeded");
        const tag = byte();
        if (tag === 0) return null;
        if (tag === 1) return false;
        if (tag === 2) return true;
        if (tag === 3) {
          need(8);
          const n2 = view.getFloat64(offset, true);
          offset += 8;
          if (!Number.isFinite(n2) || Object.is(n2, -0) || Number.isInteger(n2) && n2 >= -2147483648 && n2 <= 2147483647) throw new TypeError("Noncanonical number");
          return n2;
        }
        if (tag === 8 || tag === 9) {
          let n2 = 0, scale = 1, part;
          for (let i = 0; i < 5; i++) {
            part = byte();
            n2 += (part & 127) * scale;
            if (n2 > 4294967295) throw new TypeError("Integer overflow");
            if (part < 128) {
              if (i && part === 0) throw new TypeError("Noncanonical integer");
              if (tag === 9) {
                if (n2 >= strings.length) throw new TypeError("Invalid string reference");
                return strings[n2];
              }
              return n2 % 2 ? -(n2 + 1) / 2 : n2 / 2;
            }
            scale *= 128;
          }
          throw new TypeError("Invalid integer");
        }
        if (tag === 4) {
          const value = decoder2.decode(raw());
          if (stringSet.has(value)) throw new TypeError("Noncanonical repeated string");
          stringSet.add(value);
          strings.push(value);
          return value;
        }
        if (tag === 7) return raw().slice();
        if (tag !== 5 && tag !== 6) throw new TypeError("Invalid codec tag");
        const n = length();
        if (n > maxEntries - entries) throw new RangeError("Value codec budget exceeded");
        if (tag === 5) {
          const arr = [];
          for (let i = 0; i < n; i++) arr.push(read(depth + 1));
          return arr;
        }
        const obj = {};
        let previous;
        for (let i = 0; i < n; i++) {
          const key = read(depth + 1);
          if (typeof key !== "string" || i && key <= previous) throw new TypeError("Noncanonical record key");
          if (key === "__proto__") Object.defineProperty(obj, key, { value: read(depth + 1), enumerable: true, writable: true, configurable: true });
          else obj[key] = read(depth + 1);
          previous = key;
        }
        return obj;
      };
      let offset = 0, entries = 0;
      const strings = [], stringSet = /* @__PURE__ */ new Set();
      const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
      if (byte() !== 82 || byte() !== 86 || byte() !== 1) throw new TypeError("Invalid codec header");
      result = read();
      if (offset !== bytes2.length) throw new TypeError("Trailing codec bytes");
    }
    if (format === "json") {
      const canonical = encode(result);
      if (canonical.length !== bytes2.length || canonical.some((v, i) => v !== bytes2[i])) throw new TypeError("Noncanonical codec bytes");
    }
    return result;
  }
  return Object.freeze({ format, encode, decode });
}
var binaryCodec = createValueCodec();
var jsonCodec = createValueCodec({ format: "json" });

// modules/rollback/room-session.js
var ROOM_MAGIC = 827477316;
var WIRE_HEADER = 24;
var MAX_EPOCH = 65534;
var BRANCH_MAGIC = 843205956;
var BRANCH_HEADER = 36;
var ordered = (ids) => [...ids].sort(compareIds);
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var idValid = (id) => typeof id === "string" && id.length > 0 && id.length <= 128;
function createRoomSession(options) {
  return new RoomSession(options);
}
var RoomSession = class {
  constructor({
    mode = "local",
    room,
    localPlayerId = room?.localPlayerId ?? "local",
    sessionId = room?.sessionId ?? "local",
    simulationVersion,
    seed = 1,
    inputSize,
    profile = profiles.lockstep,
    adapter,
    membership = {},
    clock = nowMs,
    onEvent = () => {
    },
    availability = {},
    roomOwnerId = room?.coordinatorId ?? localPlayerId
  } = {}) {
    if (!["local", "online"].includes(mode) || !idValid(localPlayerId) || !idValid(sessionId)) throw new TypeError("room session identity/mode");
    integer(inputSize, "inputSize", 1, 1024);
    if (!idValid(simulationVersion) || sessionId.length > 116) throw new TypeError("room simulationVersion/sessionId");
    if (mode === "local" && room) throw new TypeError("local room cannot own online transport");
    if (profile.mode && profile.mode !== "lockstep") throw new TypeError("dynamic membership requires lockstep");
    if (!adapter || ["step", "save", "load", "validateSnapshot", "applyMembership"].some((k) => typeof adapter[k] !== "function")) throw new TypeError("room simulation adapter");
    if (mode === "online" && (!room || typeof room.subscribe !== "function" || typeof room.connectMesh !== "function" || typeof room.setRoster !== "function")) throw new TypeError("dynamic room capability");
    if (typeof clock !== "function" || typeof onEvent !== "function") throw new TypeError("room session capability");
    this.mode = mode;
    this.room = room;
    this.localPlayerId = localPlayerId;
    this.sessionId = sessionId;
    this.simulationVersion = simulationVersion;
    this.seed = seed;
    this.inputSize = inputSize;
    this.adapter = adapter;
    this.clock = clock;
    this.onEvent = onEvent;
    this.membership = Object.freeze({
      maxPlayers: 5,
      transitionTimeoutMs: 15e3,
      reconnectGraceMs: 1e4,
      joinRetryMs: 500,
      maxCatchupSteps: 4,
      maxTransferBytes: 8 * 1024 * 1024,
      maxControlMessagesPerPulse: 32,
      snapshotBudgetMs: 8,
      ...membership
    });
    for (const [k, v] of Object.entries(this.membership)) integer(v, k, 1, 2147483647);
    integer(this.membership.maxCatchupSteps, "maxCatchupSteps", 1, 8192);
    integer(this.membership.maxPlayers, "maxPlayers", 1, 8);
    integer(this.membership.maxTransferBytes, "maxTransferBytes", CHUNK_SIZE, 128 * 1024 * 1024);
    this.profile = Object.freeze({ ...profiles.lockstep, ...profile, mode: "lockstep", adaptiveInputDelay: false });
    this.availability = availabilityConfig(availability);
    if (!idValid(roomOwnerId)) throw new TypeError("roomOwnerId");
    this.roomOwnerId = roomOwnerId;
    this.codec = createValueCodec({ maxBytes: this.membership.maxTransferBytes, maxEntries: Math.min(this.membership.maxTransferBytes, 1e6), maxDepth: 32 });
    this.contract = hashBytes(this.codec.encode({
      version: 1,
      simulationVersion,
      seed,
      inputSize,
      maxPlayers: this.membership.maxPlayers,
      tickRate: this.profile.tickRate,
      baseInputDelayTicks: this.profile.baseInputDelayTicks,
      checksumInterval: this.profile.checksumInterval,
      ...this.availability.mode === "available" ? { availability: this.availability } : {}
    }));
    this.epoch = room?.epoch ?? 0;
    this.baseTick = 0;
    this.coordinatorId = room?.coordinatorId ?? localPlayerId;
    this.players = Object.freeze(ordered(mode === "online" ? room.players : [localPlayerId]));
    this.activePlayers = this.players;
    this._availability = this.availability.mode === "available" ? new Availability(this) : null;
    this.closed = false;
    this._failure = null;
    this._core = null;
    this._transition = null;
    this._links = /* @__PURE__ */ new Map();
    this._retirePeers = /* @__PURE__ */ new Map();
    this._admissionQueue = /* @__PURE__ */ new Map();
    this._incoming = [];
    this._incomingBytes = 0;
    this._lastInput = new Uint8Array(inputSize);
    this._pendingBeforeJoin = [];
    this._messageSequence = 0;
    this._joinSent = false;
    this._startedAt = clock();
    this._interruptedAt = null;
    this._leavePromise = null;
    this._leaveResolve = null;
    this._leaveReject = null;
    this._stats = { transitions: 0, bootstrapBytes: 0, bootstrapTicks: 0, rejectedMessages: 0, sentControlBytes: 0, receivedControlBytes: 0, membershipPrepareMs: 0, membershipCommitMs: 0, bootstrapPrepareMs: 0, bootstrapPulseMs: 0, maxBoundaryTaskMs: 0, boundaryLongTasks: 0 };
    this._totals = { snapshotSaves: 0, serializedSnapshotBytes: 0, stateHashComputations: 0, hashedStateBytes: 0 };
    if (mode === "local" || this.players.includes(localPlayerId) && !room?.resumed) {
      this.adapter.applyMembership({ epoch: this.epoch, tick: 0, players: [...this.players], joined: [...this.players], left: [], coordinatorId: this.coordinatorId, reason: "initial" });
      this._startCore();
    }
    if (room) {
      this._unsubscribeRoom = room.subscribe((event) => {
        if (this.closed || this.failure) return;
        if (event.type === "peer-connected") this._attach(event.peerId, event.transport);
        if (event.type === "peer-disconnected") {
          if (!this.players.includes(event.peerId) && !this._transition?.participants.includes(event.peerId)) {
            const link = this._links.get(event.peerId);
            link?.unsubscribe?.();
            link?.detachCore?.();
            this._links.delete(event.peerId);
          }
          this._event("peer-disconnected", { peerId: event.peerId, reason: event.reason });
        }
        if (event.type === "room-failed") this._fail("transport-failed", { reason: event.reason });
      });
      for (const [id, transport] of room.transports) this._attach(id, transport);
    }
  }
  get tick() {
    return this.baseTick + (this._core?.tick ?? 0);
  }
  get confirmedTick() {
    return this._core ? this.baseTick + Math.min(this._core.tick - 1, this._core.confirmedTick) : this.baseTick - 1;
  }
  get inputDelay() {
    return this._core?.inputDelay ?? this.profile.baseInputDelayTicks;
  }
  /** Global tick metadata; command sequences retain their core-assigned values. */
  get localInputState() {
    const state = this._core?.localInputState;
    if (!state) return null;
    return {
      ...state,
      epoch: this.epoch,
      baseTick: this.baseTick,
      tick: this.tick,
      confirmedTick: this.confirmedTick,
      capture: state.capture ? {
        ...state.capture,
        captureTick: state.capture.captureTick + this.baseTick,
        executeTick: state.capture.executeTick + this.baseTick,
        commands: state.capture.commands.map((c) => ({ ...c, executeTick: c.executeTick + this.baseTick }))
      } : null
    };
  }
  get failure() {
    return this._failure ?? this._core?.failure;
  }
  get ready() {
    return !this.closed && !this.failure && !this._availability?.round && !this._availability?.recovering && this._availability?.requested !== "state-mismatch" && !this._transition && !!this._core?.ready;
  }
  get resimulating() {
    return !!this._availability?.round || this._transition?.proposal.reason === "reconnect" || !!this._transition?.replay || !!this._core?.resimulating;
  }
  get pace() {
    return this._core?.pace ?? 1;
  }
  get status() {
    if (this.closed) return "closed";
    if (this.failure) return "failed";
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch") return "resynchronizing";
    if (!this.activePlayers.includes(this.localPlayerId) && this.players.includes(this.localPlayerId)) return "suspended";
    if (this._transition?.replay) return "catching-up";
    if (this._transition) return "membership";
    return this._core?.status ?? "joining";
  }
  get metrics() {
    const core = this._core?.metrics ?? {};
    const sums = Object.fromEntries(Object.entries(this._totals).map(([k, v]) => [k, v + (core[k] ?? 0)]));
    return {
      ...core,
      ...sums,
      ...this._stats,
      ...this._availability?.metrics,
      tick: this.tick,
      confirmedTick: this.confirmedTick,
      epoch: this.epoch,
      pendingAdmissions: this._admissionQueue.size,
      controlIncomingBytes: this._incomingBytes,
      controlQueuedBytes: [...this._links.values()].reduce((n, l) => n + l.queuedBytes, 0),
      controlReceivingBytes: [...this._links.values()].reduce((n, l) => n + (l.incoming?.bytes.length ?? 0), 0)
    };
  }
  getPeerState(id) {
    return this._core?.getPeerState(id);
  }
  getStateHash(tick = this.tick) {
    return this.resimulating ? void 0 : this._core?.getStateHash(tick - this.baseTick);
  }
  _event(type, detail = {}) {
    try {
      this.onEvent({ type, tick: this.tick, epoch: this.epoch, ...detail });
    } catch {
    }
  }
  _fail(type, detail = {}) {
    if (this.closed || this._failure) return;
    this._failure = Object.freeze({ type, ...detail });
    try {
      this._availability?.cancel();
    } catch (error) {
      this._failure = Object.freeze({ type, ...detail, restoreError: error.message });
    }
    try {
      this._transition?.replay?.cancel();
    } catch {
    }
    try {
      this._transition?.stageJob?.cancel();
    } catch {
    }
    if (this._transition) {
      this._transition.preparedState = null;
      this._transition.stageJob = null;
    }
    this._leaveReject?.(new Error(type));
    this._leaveResolve = this._leaveReject = null;
    this._unsubscribeRoom?.();
    for (const link of this._links.values()) {
      link.unsubscribe?.();
      link.detachCore?.();
    }
    this._links.clear();
    this._incoming.length = 0;
    this._incomingBytes = 0;
    this.room?.close();
    this._event(type, detail);
  }
  _adapter(baseTick = this.baseTick, epoch = this.epoch) {
    const a = this.adapter;
    const contextAt = (context = {}) => ({
      ...context,
      tick: (context.tick ?? 0) + baseTick,
      membershipEpoch: epoch,
      ...this._availability ? { players: [...this.players], activePlayers: context.players ?? [...this.activePlayers] } : {}
    });
    return {
      save: () => a.save(),
      load: (data) => a.load(data),
      ...typeof a.saveJob === "function" ? { saveJob: () => a.saveJob() } : {},
      ...typeof a.prepareSnapshotJob === "function" && typeof a.loadPreparedSnapshot === "function" ? {
        prepareSnapshotJob: (data, context) => a.prepareSnapshotJob(data, contextAt(context)),
        loadPreparedSnapshot: (prepared, context) => a.loadPreparedSnapshot(prepared, contextAt(context))
      } : {},
      ...typeof a.prepareSnapshot === "function" && typeof a.loadPreparedSnapshot === "function" ? {
        prepareSnapshot: (data, context) => a.prepareSnapshot(data, contextAt(context)),
        loadPreparedSnapshot: (prepared, context) => a.loadPreparedSnapshot(prepared, contextAt(context))
      } : {},
      validateSnapshot: (data, context = {}) => a.validateSnapshot(data, contextAt(context)),
      step: (context) => {
        context.tick += baseTick;
        context.membershipEpoch = epoch;
        for (const frame of context.inputs) for (const command of frame.commands) command.executeTick = context.tick;
        const start = this._availability ? nowMs() : 0;
        try {
          return a.step(context);
        } finally {
          if (this._availability && !context.resimulating) this._availability.measureStep(Math.max(0, nowMs() - start));
        }
      }
    };
  }
  _startCore(commandState, commandSequences, boundary) {
    const options = {
      players: [...this.activePlayers],
      localPlayerId: this.localPlayerId,
      authorityPlayerId: this.coordinatorId,
      sessionId: this.sessionId + ":" + this.epoch,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      inputSize: this.inputSize,
      profile: this.profile,
      adapter: this._adapter(),
      localCommandState: commandState,
      initialCommandSequences: commandSequences ? Object.fromEntries(this.activePlayers.map((id) => [id, commandSequences[id] ?? 0])) : void 0,
      clock: this.clock,
      recordReplay: false,
      onEvent: (event) => {
        if (event.type !== "closed") this._event(event.type, { ...event, tick: event.tick + this.baseTick });
      }
    };
    this._core = boundary ? createSessionFromBoundary(options, boundary.bytes, boundary.hash) : createSession(options);
    if (this._availability) delegateRoomRecovery(this._core, () => {
      this._availability.requested = "state-mismatch";
    });
    this.profile = this._core.profile;
    for (const [id, link] of this._links) this._attachCore(id, link);
    for (const payload of this._pendingBeforeJoin.splice(0)) this._core.queueCommand(payload);
  }
  _attachCore(id, link) {
    link.detachCore?.();
    link.detachCore = null;
    if (!this._core || !this.activePlayers.includes(id) || id === this.localPlayerId) return;
    const epoch = this.epoch, session = this;
    link.detachCore = this._core.attachTransport(id, {
      get state() {
        return link.transport.state ?? "open";
      },
      send(data) {
        if (session.closed || epoch !== session.epoch) return false;
        const out = data.slice();
        new DataView(out.buffer).setUint16(6, epoch + 1, true);
        if (!session._availability) return link.transport.send(out);
        const capacity = CHUNK_SIZE - BRANCH_HEADER, fragmented = out.length > capacity;
        for (let offset = 0; offset < out.length; offset += capacity) {
          const part = out.subarray(offset, offset + capacity), envelope = new Uint8Array(part.length + BRANCH_HEADER), view = new DataView(envelope.buffer);
          view.setUint32(0, BRANCH_MAGIC, true);
          envelope[4] = 1;
          envelope[5] = fragmented ? 1 : out[5];
          view.setUint32(8, new DataView(out.buffer).getUint32(8, true), true);
          view.setUint32(12, offset, true);
          view.setUint32(16, out.length, true);
          envelope.set(session._availability.wireBranch, 20);
          envelope.set(part, BRANCH_HEADER);
          if (link.transport.send(envelope) === false) return false;
        }
        return true;
      },
      subscribe(fn) {
        link.coreReceive = fn;
        return () => {
          if (link.coreReceive === fn) link.coreReceive = null;
        };
      },
      subscribeStatus(fn) {
        return link.transport.subscribeStatus?.(fn) ?? (() => {
        });
      }
    });
    for (const packet2 of link.future.splice(0)) this._receiveWire(id, link, packet2);
  }
  _attach(id, transport) {
    if (!idValid(id) || id === this.localPlayerId || !transport?.send || !transport.subscribe) return;
    const old = this._links.get(id);
    if (old?.transport === transport) return;
    old?.unsubscribe?.();
    old?.detachCore?.();
    const link = { transport, queue: [], queuedBytes: 0, incoming: null, coreReceive: null, future: [], detachCore: null, lastControlSerial: 0 };
    this._links.set(id, link);
    link.unsubscribe = transport.subscribe((data) => {
      if (!this.closed && this._links.get(id) === link) this._receiveWire(id, link, data);
    });
    this._attachCore(id, link);
    if (!this._core && id === this.coordinatorId) this._joinSent = false;
  }
  _boundaryFrozen() {
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch") return true;
    const tr = this._transition;
    return !!tr && (tr.proposal.reason === "reconnect" || !!tr.stageJob || !!tr.preparedState || tr.applied || !!tr.replay);
  }
  _receiveWire(id, link, raw) {
    try {
      let data = bytes(raw);
      if (this._availability && data.length >= BRANCH_HEADER && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === BRANCH_MAGIC) {
        if (data.length > CHUNK_SIZE || data[4] !== 1 || this._availability.wireBranch.some((n, i) => data[20 + i] !== n)) return;
        const envelope = new DataView(data.buffer, data.byteOffset), serial2 = envelope.getUint32(8, true), offset2 = envelope.getUint32(12, true), total2 = envelope.getUint32(16, true);
        const part = data.subarray(BRANCH_HEADER);
        if (!total2 || total2 > CHUNK_SIZE || offset2 + part.length > total2) throw new Error("branch wire capacity");
        if (!offset2 && total2 === part.length) data = part;
        else {
          if (!offset2) link.branchIncoming = { serial: serial2, bytes: new Uint8Array(total2), offset: 0, at: this.clock() };
          const pending = link.branchIncoming;
          if (!pending || pending.serial !== serial2 || pending.bytes.length !== total2 || offset2 !== pending.offset) return;
          pending.bytes.set(part, offset2);
          pending.offset += part.length;
          if (pending.offset !== total2) return;
          data = pending.bytes;
          link.branchIncoming = null;
        }
      } else if (this._availability && data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === MAGIC) return;
      if (data.length < 12 || data.length > CHUNK_SIZE) throw new Error("room wire size");
      const view = new DataView(data.buffer, data.byteOffset, data.length), magic = view.getUint32(0, true);
      if (magic === MAGIC) {
        if (this._availability?.polled && this.clock() - this._availability.lastPoll > this.availability.resumeGapMs) {
          this._availability.recovering = true;
          this._availability.requested = "resume";
        }
        const epoch = view.getUint16(6, true) - 1;
        if (epoch === this.epoch && link.coreReceive && !this._boundaryFrozen()) {
          const copy = data.slice();
          new DataView(copy.buffer).setUint16(6, 0, true);
          link.coreReceive(copy);
        } else if (epoch === this.epoch + 1 && this._transition && link.future.length < 64) link.future.push(data.slice());
        return;
      }
      if (magic !== ROOM_MAGIC || data.length < WIRE_HEADER || data[4] !== 1 || data[5] !== 0) throw new Error("room wire protocol");
      const serial = view.getUint32(8, true), total = view.getUint32(12, true), offset = view.getUint32(16, true), digest = view.getUint32(20, true);
      if (this._availability && serial <= link.lastControlSerial) return;
      if (!total || total > this.membership.maxTransferBytes || offset + data.length - WIRE_HEADER > total) throw new Error("room wire capacity");
      if (offset === 0) {
        if (this._availability && serial <= link.lastControlSerial) return;
        if (link.incoming) throw new Error("overlapping room transfer");
        link.incoming = { serial, bytes: new Uint8Array(total), offset: 0, digest, startedAt: this.clock() };
      }
      const incoming = link.incoming;
      if (!incoming || incoming.serial !== serial || incoming.offset !== offset || incoming.digest !== digest || incoming.bytes.length !== total) throw new Error("room wire order");
      incoming.bytes.set(data.subarray(WIRE_HEADER), offset);
      incoming.offset += data.length - WIRE_HEADER;
      this._stats.receivedControlBytes += data.length;
      if (incoming.offset === total) {
        link.incoming = null;
        if (hashBytes(incoming.bytes) !== digest) throw new Error("room wire digest");
        link.lastControlSerial = serial;
        const value = this.codec.decode(incoming.bytes);
        if (this._availability && value?.op === "availability-activity") {
          const previous = this._incoming.findIndex((m) => m.from === id && m.value?.op === value.op);
          if (previous >= 0) {
            this._incomingBytes -= this._incoming[previous].size;
            this._incoming.splice(previous, 1);
          }
        }
        if (this._incoming.length >= 128 || this._incomingBytes + total > this.membership.maxTransferBytes * 2) throw new Error("room control backlog");
        this._incoming.push({ from: id, value, size: total });
        this._incomingBytes += total;
      }
    } catch (error) {
      link.incoming = null;
      this._stats.rejectedMessages++;
      if (this.players.includes(id)) this._fail("room-protocol-error", { peerId: id, reason: error.message });
    }
  }
  _send(to, op, detail = {}) {
    if (to === this.localPlayerId) {
      this._incoming.push({ from: to, value: { op, sessionId: this.sessionId, contract: this.contract, ...detail } });
      return;
    }
    const link = this._links.get(to);
    if (!link) throw new Error("room peer unavailable: " + to);
    const body = this.codec.encode({ op, sessionId: this.sessionId, contract: this.contract, ...detail });
    const chunks = Math.ceil(body.length / (CHUNK_SIZE - WIRE_HEADER)), budget = body.length + chunks * WIRE_HEADER;
    if (link.queuedBytes + budget > this.membership.maxTransferBytes * 2) throw new Error("room send queue capacity");
    const serial = ++this._messageSequence >>> 0, digest = hashBytes(body);
    for (let offset = 0; offset < body.length; offset += CHUNK_SIZE - WIRE_HEADER) {
      const slice = body.subarray(offset, offset + CHUNK_SIZE - WIRE_HEADER), packet2 = new Uint8Array(WIRE_HEADER + slice.length), view = new DataView(packet2.buffer);
      view.setUint32(0, ROOM_MAGIC, true);
      packet2[4] = 1;
      view.setUint32(8, serial, true);
      view.setUint32(12, body.length, true);
      view.setUint32(16, offset, true);
      view.setUint32(20, digest, true);
      packet2.set(slice, WIRE_HEADER);
      link.queue.push(packet2);
      link.queuedBytes += packet2.length;
    }
  }
  _broadcast(ids, op, detail = {}) {
    for (const id of ids) this._send(id, op, detail);
  }
  _flush() {
    for (const link of this._links.values()) {
      let count = 0;
      while (link.queue.length && count++ < 16) {
        const data = link.queue[0];
        if (link.transport.send(data) === false) break;
        link.queue.shift();
        link.queuedBytes -= data.length;
        this._stats.sentControlBytes += data.length;
      }
    }
  }
  _proposal(joined, left, reason, resumingId = null) {
    if (this._transition || this._availability?.round || this.localPlayerId !== this.coordinatorId) throw new Error("membership coordinator busy");
    if (left.includes(this.localPlayerId)) {
      for (const id of this._admissionQueue.keys()) this._send(id, "reject", { reason: "coordinator-changing" });
      this._admissionQueue.clear();
    }
    if (this.epoch >= MAX_EPOCH) throw new Error("room epoch exhausted");
    const players = ordered([...this.players.filter((id) => !left.includes(id)), ...joined]);
    if (!players.length) {
      this.close();
      return;
    }
    if (players.length > this.membership.maxPlayers || new Set(players).size !== players.length) throw new Error("room capacity");
    const proposal = {
      epoch: this.epoch + 1,
      oldPlayers: [...this.players],
      players,
      joined,
      left,
      reason,
      resumingId,
      coordinatorId: players.includes(this.coordinatorId) ? this.coordinatorId : players[0]
    };
    for (const id of joined) this._send(id, "welcome", { epoch: this.epoch, players: [...this.players] });
    this._acceptProposal(this.localPlayerId, proposal);
    const tr = this._transition;
    Promise.resolve(this.room?.connectMesh(tr.participants)).then(() => {
      if (this.closed || this.failure || this._transition !== tr) return;
      for (const [id, transport] of this.room?.transports ?? []) this._attach(id, transport);
      this._broadcast(tr.participants.filter((id) => id !== this.localPlayerId), "propose", { proposal });
    }).catch((error) => this._fail("membership-connect-failed", { reason: error.message }));
  }
  _acceptProposal(from, proposal) {
    if (from !== this.coordinatorId || this._transition || !proposal || proposal.epoch !== this.epoch + 1 || proposal.epoch > MAX_EPOCH) throw new Error("membership proposal authority/epoch");
    if (!Array.isArray(proposal.oldPlayers) || !Array.isArray(proposal.players) || !Array.isArray(proposal.joined) || !Array.isArray(proposal.left)) throw new Error("membership roster shape");
    if (!["join", "leave", "reconnect"].includes(proposal.reason) || proposal.reason === "reconnect" && (!proposal.oldPlayers.includes(proposal.resumingId) || proposal.joined.length || proposal.left.length)) throw new Error("membership reason");
    if (!same(proposal.oldPlayers, this.players) || !same(ordered(proposal.players), proposal.players) || !proposal.players.length || proposal.players.length > this.membership.maxPlayers || new Set(proposal.players).size !== proposal.players.length || proposal.players.some((id) => !idValid(id)) || !proposal.players.includes(proposal.coordinatorId) || !same(ordered([...proposal.oldPlayers.filter((id) => !proposal.left.includes(id)), ...proposal.joined]), proposal.players) || proposal.joined.some((id) => proposal.oldPlayers.includes(id)) || proposal.left.some((id) => !proposal.oldPlayers.includes(id))) throw new Error("membership roster mismatch");
    proposal = Object.freeze({ ...proposal, oldPlayers: Object.freeze([...proposal.oldPlayers]), players: Object.freeze([...proposal.players]), joined: Object.freeze([...proposal.joined]), left: Object.freeze([...proposal.left]) });
    const participants = ordered([.../* @__PURE__ */ new Set([...proposal.oldPlayers, ...proposal.joined])]);
    if (!participants.includes(this.localPlayerId)) throw new Error("membership local participant");
    const tr = this._transition = {
      proposal,
      participants,
      startedAt: this.clock(),
      prepared: /* @__PURE__ */ new Map(),
      reached: /* @__PURE__ */ new Map(),
      installed: /* @__PURE__ */ new Map(),
      target: null,
      reachedSent: false,
      installSent: false,
      applied: false,
      replay: null,
      commitSent: false,
      committed: /* @__PURE__ */ new Set()
    };
    this._event("membership-preparing", { proposal });
    Promise.resolve(this.room?.connectMesh(participants)).then(() => {
      if (this.closed || this.failure || this._transition !== tr) return;
      for (const [id, transport] of this.room?.transports ?? []) this._attach(id, transport);
      this._send(from, "prepared", { epoch: proposal.epoch, tick: this._core ? this.tick : -1 });
    }).catch((error) => this._fail("membership-connect-failed", { reason: error.message }));
  }
  _handle(from, m) {
    if (this._availability && m?.op?.startsWith("availability-") && m.sessionId === this.sessionId && m.contract === this.contract) {
      if (this._transition && !this._transition.availability) return;
      this._availability.handle(from, m, this.clock());
      return;
    }
    const participant = this.players.includes(from) || this._transition?.participants.includes(from);
    if (!participant && m?.op !== "join") {
      this._stats.rejectedMessages++;
      return;
    }
    if (["propose", "barrier", "install", "bootstrap", "resume-install", "commit", "reject", "leave-busy", "welcome"].includes(m?.op) && from !== this.coordinatorId) {
      this._stats.rejectedMessages++;
      return;
    }
    if (!m || m.sessionId !== this.sessionId || m.contract !== this.contract) {
      this._stats.rejectedMessages++;
      if (m?.op === "join") this._send(from, "reject", { reason: "incompatible-session" });
      return;
    }
    if (m.op === "welcome" && from === this.coordinatorId && !this._core && !this.room?.resumed && !this._transition) {
      if (!Number.isInteger(m.epoch) || m.epoch < this.epoch || m.epoch > MAX_EPOCH || !Array.isArray(m.players) || m.players.length < 1 || m.players.length >= this.membership.maxPlayers || m.players.includes(this.localPlayerId) || !m.players.includes(from) || m.players.some((id) => !idValid(id)) || new Set(m.players).size !== m.players.length || !same(ordered(m.players), m.players)) return;
      this.epoch = m.epoch;
      this.players = Object.freeze([...m.players]);
      this.activePlayers = this.players;
      this.room?.setRoster({ epoch: this.epoch, players: [...this.players], coordinatorId: this.coordinatorId });
      return;
    }
    if (m.op === "retire" && this._departing && from === this.coordinatorId && m.epoch === this.epoch) {
      this._retireApproved = true;
      return;
    }
    if (m.op === "reject" && from === this.coordinatorId && !this._core) {
      this._fail("join-rejected", { reason: m.reason });
      return;
    }
    if (m.op === "join" && this.localPlayerId === this.coordinatorId) {
      if (this.players.includes(from)) {
        if (m.resume === true && !this._transition) this._proposal([], [], "reconnect", from);
        return;
      }
      if (this._transition?.participants.includes(from)) return;
      if (this._availability && this.activePlayers.length !== this.players.length) {
        this._send(from, "reject", { reason: "suspended-members" });
        return;
      }
      if (this._admissionQueue.has(from)) return;
      const expectedCount = this._transition?.proposal.players.length ?? this.players.length;
      if (expectedCount + this._admissionQueue.size >= this.membership.maxPlayers) {
        this._send(from, "reject", { reason: "room-full" });
        return;
      }
      this._admissionQueue.set(from, this.clock());
      return;
    }
    if (m.op === "leave-request" && this.localPlayerId === this.coordinatorId && this.players.includes(from)) {
      if (!this._transition && !this._availability?.round) this._proposal([], [from], "leave");
      else this._send(from, "leave-busy");
      return;
    }
    if (m.op === "leave-busy" && from === this.coordinatorId) {
      this._leaveReject?.(new Error("membership busy"));
      this._leavePromise = this._leaveResolve = this._leaveReject = null;
      return;
    }
    if (m.op === "propose") {
      this._acceptProposal(from, m.proposal);
      return;
    }
    const tr = this._transition;
    if (!tr || m.epoch !== tr.proposal.epoch || !tr.participants.includes(from)) return;
    const leader = this.coordinatorId === this.localPlayerId;
    if (m.op === "prepared" && leader) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 2147483646 || (tr.proposal.oldPlayers.includes(from) && tr.proposal.resumingId !== from ? m.tick < this.baseTick : m.tick !== -1)) throw new Error("membership prepared tick");
      tr.prepared.set(from, m.tick);
      if (tr.prepared.size === tr.participants.length && tr.target === null) {
        const target = Math.max(...tr.prepared.values()), minimum = Math.min(...[...tr.prepared.values()].filter((tick) => tick >= 0));
        if (target - minimum > this.profile.stateHistorySize - this.profile.checksumInterval) throw new Error("resume boundary exceeds retained history");
        const donor = [...tr.prepared].filter(([, tick]) => tick === target).map(([id]) => id).sort(compareIds)[0];
        this._broadcast(tr.participants, "barrier", { epoch: m.epoch, tick: target, minimum, donor });
      }
    } else if (m.op === "barrier" && from === this.coordinatorId && tr.target === null) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 2147483646 || m.tick < this.tick || this._core && m.tick - this.tick > this.profile.stateHistorySize) throw new Error("membership barrier window");
      tr.target = m.tick;
      if (tr.proposal.reason === "reconnect") {
        tr.donor = m.donor;
        if (!tr.proposal.oldPlayers.includes(tr.donor) || tr.donor === tr.proposal.resumingId) throw new Error("invalid resume donor");
        if (this.localPlayerId === tr.donor) this._send(this.coordinatorId, "resume-source", { epoch: m.epoch, baseTick: this.baseTick, bootstrap: this._core.exportConfirmedBootstrap({ checkpointAtOrBefore: m.minimum - this.baseTick }) });
      }
    } else if (m.op === "reached" && leader && tr.proposal.oldPlayers.includes(from)) {
      if (m.tick !== tr.target || !Number.isInteger(m.hash)) throw new Error("membership checkpoint boundary");
      tr.reached.set(from, m.hash);
      if (tr.reached.size === tr.proposal.oldPlayers.length && !tr.installSent) {
        if (new Set(tr.reached.values()).size !== 1) throw new Error("membership checkpoint mismatch");
        tr.installSent = true;
        const bootstrap = tr.proposal.joined.length ? this._core.exportConfirmedBootstrap() : null;
        for (const id of tr.participants) {
          if (tr.proposal.joined.includes(id)) {
            this._send(id, "bootstrap", { epoch: m.epoch, baseTick: this.baseTick, bootstrap, target: tr.target });
            this._stats.bootstrapBytes += bootstrap.checkpoint.bytes.length;
          } else this._send(id, "install", { epoch: m.epoch, tick: tr.target });
        }
      }
    } else if (m.op === "resume-source" && leader && from === tr.donor && tr.proposal.reason === "reconnect" && !tr.installSent) {
      if (m.bootstrap.tick + m.baseTick !== tr.target) throw new Error("resume donor boundary");
      tr.installSent = true;
      this._broadcast(tr.participants, "resume-install", { epoch: m.epoch, baseTick: m.baseTick, bootstrap: m.bootstrap, target: tr.target });
    } else if (m.op === "resume-install" && from === this.coordinatorId && tr.proposal.reason === "reconnect" && !tr.replay && !tr.stageJob && !tr.preparedState && !tr.applied) {
      this._beginBootstrap(tr, m);
    } else if (m.op === "bootstrap" && from === this.coordinatorId && !this._core && !tr.replay && !tr.stageJob && !tr.preparedState && !tr.applied) {
      this._beginBootstrap(tr, m);
    } else if (m.op === "install" && from === this.coordinatorId && this._core && !tr.applied) {
      if (m.tick !== tr.target || this.tick !== tr.target) throw new Error("membership installation boundary");
      this._applyMembership(tr);
    } else if (m.op === "installed" && leader) {
      if (!Number.isInteger(m.hash)) throw new Error("membership installed hash");
      tr.installed.set(from, m.hash);
      if (tr.installed.size === tr.participants.length && !tr.commitSent) {
        if (new Set(tr.installed.values()).size !== 1) throw new Error("membership state mismatch");
        tr.commitSent = true;
        this._broadcast(tr.participants.filter((id) => id !== this.localPlayerId), "commit", { epoch: m.epoch, hash: m.hash });
      }
    } else if (m.op === "commit" && from === this.coordinatorId) {
      if (!tr.applied || tr.postHash !== m.hash) throw new Error("membership commit without matching preparation");
      this._send(this.coordinatorId, "committed", { epoch: m.epoch, hash: tr.postHash });
      this._commit(tr);
    } else if (m.op === "committed" && leader && tr.commitSent && m.hash === tr.postHash) {
      tr.committed.add(from);
    }
  }
  _beginBootstrap(tr, m) {
    return this._boundaryWork("bootstrapPrepareMs", () => this._prepareBootstrap(tr, m));
  }
  _prepareBootstrap(tr, m) {
    if (m.target !== tr.target || m.bootstrap.tick + m.baseTick !== tr.target || !Number.isSafeInteger(m.baseTick) || m.baseTick < 0 || this._core && m.baseTick !== this.baseTick) throw new Error("bootstrap epoch boundary");
    if (!this._core) this.baseTick = m.baseTick;
    if (this._core && tr.proposal.reason === "reconnect") this._core.verifyConfirmedBootstrap(m.bootstrap);
    tr.commandSequences = m.bootstrap.commandSequences;
    tr.replay = createBootstrapReplay({
      adapter: this._adapter(m.baseTick, this.epoch),
      bootstrap: m.bootstrap,
      maxCatchupSteps: this.membership.maxCatchupSteps,
      maxCatchupMs: this.membership.snapshotBudgetMs,
      maxSnapshotBytes: this.profile.maxSnapshotBytes,
      maxSuffixTicks: tr.proposal.reason === "reconnect" ? this.profile.stateHistorySize : this.profile.checksumInterval,
      maxCommandBytes: this.profile.maxCommandBytes,
      maxPendingCommands: this.profile.maxPendingCommands,
      maxReplayBytes: this.membership.maxTransferBytes,
      simulationVersion: this.simulationVersion,
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      seed: this.seed,
      players: [...this.players]
    });
    this._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length;
  }
  _membershipContext(tr) {
    return {
      tick: tr.target,
      membershipEpoch: tr.proposal.epoch,
      simulationVersion: this.simulationVersion,
      tickRate: this.profile.tickRate,
      seed: this.seed,
      players: [...tr.proposal.players],
      ...tr.proposal.activePlayers ? { activePlayers: [...tr.proposal.activePlayers] } : {}
    };
  }
  _boundaryWork(name, work) {
    const started = nowMs();
    try {
      return work();
    } finally {
      const elapsed = Math.max(0, nowMs() - started);
      this._stats[name] = elapsed;
      this._stats.maxBoundaryTaskMs = Math.max(this._stats.maxBoundaryTaskMs, elapsed);
      if (elapsed > 50) this._stats.boundaryLongTasks++;
    }
  }
  _applyMembership(tr) {
    return this._boundaryWork("membershipPrepareMs", () => this._prepareMembership(tr));
  }
  _prepareMembership(tr) {
    if (tr.stageJob || tr.preparedState || tr.applied) return;
    if (typeof this.adapter.prepareMembershipJob === "function" && typeof this.adapter.loadPreparedSnapshot === "function") {
      tr.stageJob = this.adapter.prepareMembershipJob({ ...tr.proposal, tick: tr.target }, this._membershipContext(tr));
      if (!tr.stageJob || typeof tr.stageJob.pulse !== "function" || typeof tr.stageJob.cancel !== "function") throw new TypeError("membership preparation job");
      return;
    }
    if (typeof this.adapter.prepareMembership === "function" && typeof this.adapter.loadPreparedSnapshot === "function") {
      const context = this._membershipContext(tr);
      const staged = this.adapter.prepareMembership({ ...tr.proposal, tick: tr.target }, context);
      this._acceptPreparedMembership(tr, staged);
      return;
    }
    const rollback = bytes(this.adapter.save()).slice();
    try {
      this.adapter.applyMembership({ ...tr.proposal, tick: tr.target });
      const state = bytes(this.adapter.save());
      if (state.length > this.profile.maxSnapshotBytes || !this.adapter.validateSnapshot(state, { tick: tr.target, membershipEpoch: tr.proposal.epoch })) throw new Error("invalid membership snapshot");
      tr.postHash = hashBytes(state);
      tr.postState = state.slice();
      this.adapter.load(rollback);
      tr.applied = true;
      this._installed(tr);
    } catch (error) {
      this.adapter.load(rollback);
      throw error;
    }
  }
  _acceptPreparedMembership(tr, staged, deferHash = false) {
    const state = bytes(staged?.bytes, "prepared membership snapshot").slice();
    if (!state.length || state.length > this.profile.maxSnapshotBytes || !staged.prepared) throw new Error("invalid prepared membership snapshot");
    tr.postState = state;
    tr.preparedState = staged.prepared;
    if (deferHash) {
      tr.postHash = 2166136261;
      tr.hashOffset = 0;
      return;
    }
    tr.postHash = hashBytes(state);
    tr.applied = true;
    this._installed(tr);
  }
  _installed(tr) {
    if (tr.availability) this._availability.installed(tr.postHash);
    else this._send(this.coordinatorId, "installed", { epoch: tr.proposal.epoch, hash: tr.postHash });
  }
  _commit(tr) {
    return this._boundaryWork("membershipCommitMs", () => this._commitMembership(tr));
  }
  _commitMembership(tr) {
    const previousCoordinator = this.coordinatorId;
    const commandSequences = tr.commandSequences ?? this._core?.getCommandSequences?.();
    let commandState = !tr.discardCommands ? this._core?.exportLocalCommandState() : void 0;
    commandState ??= commandSequences ? { sequence: commandSequences[this.localPlayerId] ?? 0, lastInput: new Uint8Array(this.inputSize), commands: [] } : void 0;
    if (commandState && commandSequences) {
      const baseline = commandSequences[this.localPlayerId] ?? 0;
      commandState = { ...commandState, sequence: Math.max(commandState.sequence, baseline), commands: commandState.commands.filter((command) => command.sequence > baseline) };
    }
    if (tr.preparedState) {
      const prepared = tr.preparedState;
      tr.preparedState = null;
      this.adapter.loadPreparedSnapshot(prepared, this._membershipContext(tr));
    } else this.adapter.load(tr.postState.slice());
    if (this._core) {
      const metrics = this._core.metrics;
      for (const k of Object.keys(this._totals)) this._totals[k] += metrics[k] ?? 0;
      this._core.close();
      this._core = null;
    }
    this.epoch = tr.proposal.epoch;
    this.baseTick = tr.target;
    this.players = Object.freeze([...tr.proposal.players]);
    this.coordinatorId = tr.proposal.coordinatorId;
    this.activePlayers = Object.freeze([...tr.proposal.activePlayers ?? tr.proposal.players]);
    if (this._availability) {
      for (const id of this._availability.peers.keys()) if (!this.players.includes(id)) {
        this._availability.peers.delete(id);
        this._availability.states.delete(id);
      }
    }
    if (this._availability && !tr.availability) {
      this._availability.tenureAt = this.clock();
      this._availability.anchorId = this.coordinatorId;
    }
    this._transition = null;
    this._interruptedAt = null;
    this._stats.transitions++;
    this._retireAfter = this.clock() + this.membership.transitionTimeoutMs;
    for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._retirePeers.set(id, this._retireAfter);
    for (const id of this.players) this._retirePeers.delete(id);
    this.room?.setRoster({
      epoch: this.epoch,
      players: [...this.players],
      coordinatorId: this.coordinatorId,
      ...this._availability ? { allowBranchReconnect: true } : {}
    });
    this._event("membership-committed", { ...tr.proposal, tick: tr.target });
    if (!this.players.includes(this.localPlayerId)) {
      this._departing = true;
      this._retireApproved = previousCoordinator === this.localPlayerId;
      return;
    }
    if (!this.activePlayers.includes(this.localPlayerId)) {
      this._suspendedBootstrap = {
        version: 1,
        tick: 0,
        checkpoint: { tick: 0, bytes: tr.postState.slice(), hash: tr.postHash },
        players: [...this.activePlayers],
        frames: [],
        hash: tr.postHash,
        inputSize: this.inputSize,
        tickRate: this.profile.tickRate,
        simulationVersion: this.simulationVersion,
        seed: this.seed,
        commandSequences: Object.fromEntries(this.activePlayers.map((id) => [id, commandSequences?.[id] ?? 0]))
      };
      return;
    }
    this._suspendedBootstrap = null;
    this._startCore(commandState, commandSequences, { bytes: tr.postState, hash: tr.postHash });
  }
  poll(now = this.clock()) {
    if (this.closed || this.failure) return;
    if (this._departing) {
      while (this._incoming.length) {
        const message = this._incoming.shift();
        this._incomingBytes -= message.size ?? 0;
        if (message.value?.op === "retire") this._handle(message.from, message.value);
      }
      this._flush();
      if (now >= this._retireAfter && !this._retireApproved) {
        this._fail("departure-timeout");
        return;
      }
      if (this._retireApproved && [...this._links.values()].every((link) => !link.queue.length)) {
        this._leaveResolve?.();
        this._leaveResolve = this._leaveReject = null;
        this.close();
      }
      return;
    }
    try {
      this._availability?.poll(now);
      if (!this._core && !this._transition && !(this._availability && this.room?.resumed) && (!this._joinSent || now - this._lastJoinAt >= this.membership.joinRetryMs)) {
        if (this.room?.resumed && this.localPlayerId === this.coordinatorId && this._links.size) {
          this._joinSent = true;
          this._proposal([], [], "reconnect", this.localPlayerId);
        } else if (this._links.has(this.coordinatorId)) {
          this._send(this.coordinatorId, "join", { resume: !!this.room?.resumed });
          this._joinSent = true;
          this._lastJoinAt = now;
        }
      }
      let count = 0;
      while (this._incoming.length && count++ < this.membership.maxControlMessagesPerPulse && !this.failure && !this.closed) {
        const message = this._incoming.shift();
        this._incomingBytes -= message.size ?? 0;
        this._handle(message.from, message.value);
      }
      if (this._core && !this._transition && !this._availability?.round && this.coordinatorId === this.localPlayerId && this.activePlayers.length === this.players.length) {
        for (const [id, requestedAt] of this._admissionQueue) {
          const link = this._links.get(id);
          if (!link || now - requestedAt >= this.membership.transitionTimeoutMs) {
            if (link) this._send(id, "reject", { reason: "admission-expired" });
            this._admissionQueue.delete(id);
            continue;
          }
          this._admissionQueue.delete(id);
          this._proposal([id], [], "join");
          break;
        }
      }
      const tr = this._transition;
      if (tr && !tr.availability) {
        if (now - tr.startedAt >= this.membership.transitionTimeoutMs) throw new Error("membership deadline exceeded");
        if (tr.preparedState && !tr.applied) {
          this._boundaryWork("membershipPrepareMs", () => {
            const started = nowMs();
            do {
              const end = Math.min(tr.postState.length, tr.hashOffset + 65536);
              tr.postHash = hashBytes(tr.postState.subarray(tr.hashOffset, end), tr.postHash);
              tr.hashOffset = end;
            } while (tr.hashOffset < tr.postState.length && nowMs() - started < this.membership.snapshotBudgetMs);
            if (tr.hashOffset === tr.postState.length) {
              tr.applied = true;
              this._installed(tr);
            }
          });
        }
        if (tr.stageJob) {
          this._boundaryWork("membershipPrepareMs", () => {
            tr.stageJob.pulse({ budgetMs: this.membership.snapshotBudgetMs });
            if (tr.stageJob.done) {
              const staged = tr.stageJob.result;
              tr.stageJob = null;
              this._acceptPreparedMembership(tr, staged, true);
            }
          });
        }
        if (tr.replay) {
          const result = this._boundaryWork("bootstrapPulseMs", () => tr.replay.pulse());
          this._stats.bootstrapTicks += result.steps ?? 0;
          if (tr.replay.done) {
            tr.replay = null;
            this._applyMembership(tr);
          }
        }
        if (this._core && tr.proposal.reason !== "reconnect" && tr.target !== null && this.tick === tr.target && !tr.reachedSent) {
          tr.reachedSent = true;
          this._send(this.coordinatorId, "reached", { epoch: tr.proposal.epoch, tick: this.tick, hash: this._core.getStateHash() });
        }
      } else if (!this._core && !this._suspendedBootstrap && now - this._startedAt >= this.membership.transitionTimeoutMs) throw new Error("join deadline exceeded");
      if (tr?.availability && tr.stageJob) {
        tr.stageJob.pulse({ budgetMs: this.membership.snapshotBudgetMs });
        if (tr.stageJob.done) {
          const staged = tr.stageJob.result;
          tr.stageJob = null;
          this._acceptPreparedMembership(tr, staged);
        }
      }
      for (const [id, link] of this._links) if (link.incoming && now - link.incoming.startedAt >= this.membership.transitionTimeoutMs) throw new Error("room transfer timeout: " + id);
      for (const link of this._links.values()) if (link.branchIncoming && now - link.branchIncoming.at >= this.membership.transitionTimeoutMs) link.branchIncoming = null;
      if (!this._boundaryFrozen()) this._core?.poll(now);
      if (this._core && !tr && !this._availability) {
        if (["interrupted", "disconnected"].includes(this._core.status)) {
          this._interruptedAt ??= now;
          if (now - this._interruptedAt >= this.membership.reconnectGraceMs) this._fail("partition-failed", { policy: "fail-closed", coordinatorId: this.coordinatorId });
        } else this._interruptedAt = null;
      }
      this._flush();
      for (const [id, deadline] of this._retirePeers) {
        const link = this._links.get(id);
        if (link && !["closed", "failed"].includes(link.transport.state) && now < deadline) continue;
        link?.unsubscribe?.();
        link?.detachCore?.();
        this._links.delete(id);
        this.room?.disconnect?.(id);
        this._retirePeers.delete(id);
      }
      if (tr && !tr.availability && tr.commitSent && tr.applied && tr.committed.size === tr.participants.length - 1 && [...this._links.values()].every((link) => !link.queue.length)) {
        for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._send(id, "retire", { epoch: tr.proposal.epoch });
        this._commit(tr);
      }
    } catch (error) {
      this._fail("membership-failed", { reason: error.message });
    }
  }
  advance(input = this._lastInput) {
    if (this.closed) throw new Error("room session closed");
    const sample = bytes(input);
    if (sample.length !== this.inputSize) throw new RangeError("inputSize");
    this._lastInput = sample.slice();
    if (this._availability) {
      this._availability.lastAdvance = this.clock();
      if (!this.activePlayers.includes(this.localPlayerId)) {
        this._availability.recovering = true;
        this._availability.requested = "resume";
      }
    }
    this.poll();
    if (this.failure) return { status: "failed", tick: this.tick, failure: this.failure };
    const tr = this._transition;
    if (!this._core || this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch" || tr && (tr.proposal.reason === "reconnect" || tr.target === null || this.tick >= tr.target)) return { status: this.status, tick: this.tick };
    const result = this._core.advance(sample);
    return { ...result, tick: this.tick };
  }
  queueCommand(payload) {
    if (this.closed || this.failure) throw new Error("room session unavailable");
    if (!this._core) throw new Error("player not admitted");
    return this._core.queueCommand(payload);
  }
  releaseInput() {
    this._lastInput = new Uint8Array(this.inputSize);
    this._core?.releaseInput();
  }
  leave() {
    if (this.closed) return Promise.resolve();
    if (this.failure) return Promise.reject(new Error("room session failed"));
    if (this._leavePromise) return this._leavePromise;
    if (!this._core || this.players.length === 1) {
      this.close();
      return Promise.resolve();
    }
    this._leavePromise = new Promise((resolve, reject) => {
      this._leaveResolve = resolve;
      this._leaveReject = reject;
    });
    try {
      this._send(this.coordinatorId, "leave-request");
    } catch (error) {
      this._leaveReject(error);
    }
    return this._leavePromise;
  }
  close() {
    if (this.closed) return;
    this._availability?.cancel();
    this.closed = true;
    this._core?.close();
    try {
      this._transition?.replay?.cancel();
    } catch {
    }
    try {
      this._transition?.stageJob?.cancel();
    } catch {
    }
    if (this._transition) {
      this._transition.preparedState = null;
      this._transition.stageJob = null;
    }
    this._unsubscribeRoom?.();
    for (const link of this._links.values()) {
      link.unsubscribe?.();
      link.detachCore?.();
    }
    this._links.clear();
    this._incoming.length = 0;
    this.room?.close();
    this._event("closed");
    this._leaveReject?.(new Error("room closed before graceful departure"));
    this._leaveResolve = this._leaveReject = null;
  }
};
export {
  CHUNK_SIZE,
  MAX_TICK,
  PROTOCOL_VERSION,
  RollbackSession,
  RoomSession,
  VERSION,
  createBootstrapReplay,
  createRoomSession,
  createSession,
  profiles
};
