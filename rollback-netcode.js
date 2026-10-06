// packages/deterministic/src/utilities.js
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
function statelessRandom(seed, eventId) {
  let x = (seed ^ Math.imul(integer(eventId, "eventId"), 2654435769)) >>> 0;
  x = Math.imul(x ^ x >>> 16, 2246822507);
  x = Math.imul(x ^ x >>> 13, 3266489909);
  return (x ^ x >>> 16) >>> 0;
}
var SeededPRNG = class {
  constructor(seed = 1) {
    this.state = integer(seed, "seed") >>> 0;
  }
  nextUint32() {
    this.state = this.state + 1831565813 >>> 0;
    let t = this.state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return (t ^ t >>> 14) >>> 0;
  }
  nextInt(bound) {
    integer(bound, "bound", 1, 4294967296);
    const limit = Math.floor(4294967296 / bound) * bound;
    let x;
    do {
      x = this.nextUint32();
    } while (x >= limit);
    return x % bound;
  }
};
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

// packages/_rollback-shared/src/protocol.js
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

// packages/_rollback-shared/src/history.js
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

// packages/rollback/src/core.js
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
  } = {}) {
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
    const initial = this._save();
    const retainedCount = this.profile.mode === "lockstep" ? Math.ceil(this.profile.stateHistorySize / this.profile.checksumInterval) + 2 : this.profile.stateHistorySize;
    const requiredBytes = initial.length * retainedCount;
    if (requiredBytes > this.profile.maxHistoryBytes) throw Object.assign(new RangeError("initial snapshot cannot fill retained history byte budget"), { code: "history-capacity", snapshotBytes: initial.length, requiredBytes, maxHistoryBytes: this.profile.maxHistoryBytes });
    this._initialState = initial.slice();
    const initialRecord = { tick: 0, bytes: initial, inputHash: this._inputHash };
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
    } catch (error2) {
      this._event("transport-error", { peerId: peer.id, error: error2 });
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
    } catch (error2) {
      this._metrics.rejectedPackets++;
      this._event("protocol-error", { peerId, error: error2 });
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
      if (lockstep) for (const frame of inputs) for (const command of frame.commands) {
        this._commandSequences.set(frame.playerId, Math.max(this._commandSequences.get(frame.playerId), command.sequence));
      }
    } catch (error2) {
      try {
        if (before) this.adapter.load(before.bytes.slice());
        else if (lockstep) this._restoreConfirmedBoundary(tick);
        if (lockstep) this._currentState = { tick, bytes: this._save(), inputHash: this._inputHash };
      } catch (restoreError) {
        this._currentState = null;
        this._fail("fatal", { error: error2, restoreError });
        throw error2;
      }
      this._fail("fatal", { error: error2 });
      throw error2;
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
        if (this.localPlayerId === this.authorityPlayerId || this.requestResync(tick)) peer.hashes.delete(tick);
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
    } catch (error2) {
      this.adapter.load(original.slice());
      this._rejectSnapshot(error2.message);
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

// packages/rollback/src/bootstrap.js
var MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
var MAX_SUFFIX_TICKS = 8192;
function roster(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || Array.from(value).some((id) => typeof id !== "string" || !id.length || id.length > 128) || new Set(value).size !== value.length) throw new TypeError(name);
  return value.slice();
}
function validateBootstrap(bootstrap, limits, expected) {
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
  if (hashBytes(checkpointBytes) !== checkpointHash) throw new Error("bootstrap checkpoint hash mismatch");
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
  integer(maxSnapshotBytes, "maxSnapshotBytes", 1, MAX_SNAPSHOT_BYTES);
  integer(maxSuffixTicks, "maxSuffixTicks", 0, MAX_SUFFIX_TICKS);
  integer(maxCommandBytes, "maxCommandBytes", 1, CHUNK_SIZE - 1024);
  integer(maxPendingCommands, "maxPendingCommands", 1, 2147483647);
  integer(maxReplayBytes, "maxReplayBytes", 1, 2147483647);
  const candidate = validateBootstrap(
    bootstrap,
    { maxSnapshotBytes, maxSuffixTicks, maxCommandBytes, maxPendingCommands, maxReplayBytes },
    { simulationVersion, inputSize, tickRate, players, seed }
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
  const original = save();
  let tick = candidate.checkpoint.tick, status = "catching-up", result = null, failure = null;
  const restore = (error2) => {
    failure = error2 instanceof Error ? error2 : new Error(String(error2));
    status = "failed";
    try {
      adapter.load(original.slice());
    } catch (restoreError) {
      failure = new AggregateError([failure, restoreError], "bootstrap replay failed and original snapshot restoration failed");
    }
    throw failure;
  };
  if (adapter.validateSnapshot(candidate.checkpoint.bytes.slice(), context(tick)) !== true) throw new Error("adapter rejected bootstrap checkpoint");
  try {
    adapter.load(candidate.checkpoint.bytes.slice());
    if (!equalBytes(save(), candidate.checkpoint.bytes)) throw new Error("bootstrap checkpoint round-trip mismatch");
  } catch (error2) {
    restore(error2);
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
      try {
        while (tick < candidate.tick && steps < maxCatchupSteps) {
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
          const final = save();
          if (hashBytes(final) !== candidate.hash) throw new Error("bootstrap final hash mismatch");
          if (adapter.validateSnapshot(final.slice(), context(tick)) !== true) throw new Error("adapter rejected bootstrap final state");
          status = "done";
          result = Object.freeze({ tick, hash: candidate.hash });
        }
        return Object.freeze({ status, tick, targetTick: candidate.tick, steps, ...result ?? {} });
      } catch (error2) {
        return restore(error2);
      }
    },
    cancel() {
      if (failure) throw failure;
      if (status === "catching-up") {
        try {
          adapter.load(original.slice());
          status = "cancelled";
        } catch (error2) {
          return restore(error2);
        }
      }
      return Object.freeze({ status, tick, targetTick: candidate.tick, steps: 0, ...result ?? {} });
    }
  });
}

// packages/deterministic/src/value-codec.js
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

// packages/rollback/src/room-session.js
var ROOM_MAGIC = 827477316;
var WIRE_HEADER = 24;
var MAX_EPOCH = 65534;
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
    }
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
      ...membership
    });
    for (const [k, v] of Object.entries(this.membership)) integer(v, k, 1, 2147483647);
    integer(this.membership.maxCatchupSteps, "maxCatchupSteps", 1, 8192);
    integer(this.membership.maxPlayers, "maxPlayers", 1, 8);
    integer(this.membership.maxTransferBytes, "maxTransferBytes", CHUNK_SIZE, 128 * 1024 * 1024);
    this.profile = Object.freeze({ ...profiles.lockstep, ...profile, mode: "lockstep", adaptiveInputDelay: false });
    this.codec = createValueCodec({ maxBytes: this.membership.maxTransferBytes, maxEntries: Math.min(this.membership.maxTransferBytes, 1e6), maxDepth: 32 });
    this.contract = hashBytes(this.codec.encode({
      version: 1,
      simulationVersion,
      seed,
      inputSize,
      maxPlayers: this.membership.maxPlayers,
      tickRate: this.profile.tickRate,
      baseInputDelayTicks: this.profile.baseInputDelayTicks,
      checksumInterval: this.profile.checksumInterval
    }));
    this.epoch = room?.epoch ?? 0;
    this.baseTick = 0;
    this.coordinatorId = room?.coordinatorId ?? localPlayerId;
    this.players = Object.freeze(ordered(mode === "online" ? room.players : [localPlayerId]));
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
    this._stats = { transitions: 0, bootstrapBytes: 0, bootstrapTicks: 0, rejectedMessages: 0, sentControlBytes: 0, receivedControlBytes: 0 };
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
  get failure() {
    return this._failure ?? this._core?.failure;
  }
  get ready() {
    return !this.closed && !this.failure && !this._transition && !!this._core?.ready;
  }
  get resimulating() {
    return this._transition?.proposal.reason === "reconnect" || !!this._transition?.replay || !!this._core?.resimulating;
  }
  get pace() {
    return this._core?.pace ?? 1;
  }
  get status() {
    if (this.closed) return "closed";
    if (this.failure) return "failed";
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
      this._transition?.replay?.cancel();
    } catch {
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
    return {
      save: () => a.save(),
      load: (data) => a.load(data),
      validateSnapshot: (data, context = {}) => a.validateSnapshot(data, { ...context, tick: (context.tick ?? 0) + baseTick, membershipEpoch: epoch }),
      step: (context) => {
        context.tick += baseTick;
        context.membershipEpoch = epoch;
        for (const frame of context.inputs) for (const command of frame.commands) command.executeTick = context.tick;
        return a.step(context);
      }
    };
  }
  _startCore(commandState, commandSequences) {
    this._core = createSession({
      players: [...this.players],
      localPlayerId: this.localPlayerId,
      authorityPlayerId: this.coordinatorId,
      sessionId: this.sessionId + ":" + this.epoch,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      inputSize: this.inputSize,
      profile: this.profile,
      adapter: this._adapter(),
      localCommandState: commandState,
      initialCommandSequences: commandSequences ? Object.fromEntries(this.players.map((id) => [id, commandSequences[id] ?? 0])) : void 0,
      clock: this.clock,
      recordReplay: false,
      onEvent: (event) => {
        if (event.type !== "closed") this._event(event.type, { ...event, tick: event.tick + this.baseTick });
      }
    });
    this.profile = this._core.profile;
    for (const [id, link] of this._links) this._attachCore(id, link);
    for (const payload of this._pendingBeforeJoin.splice(0)) this._core.queueCommand(payload);
  }
  _attachCore(id, link) {
    link.detachCore?.();
    link.detachCore = null;
    if (!this._core || !this.players.includes(id) || id === this.localPlayerId) return;
    const epoch = this.epoch, session = this;
    link.detachCore = this._core.attachTransport(id, {
      get state() {
        return link.transport.state ?? "open";
      },
      send(data) {
        if (session.closed || epoch !== session.epoch) return false;
        const out = data.slice();
        new DataView(out.buffer).setUint16(6, epoch + 1, true);
        return link.transport.send(out);
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
    const link = { transport, queue: [], queuedBytes: 0, incoming: null, coreReceive: null, future: [], detachCore: null };
    this._links.set(id, link);
    link.unsubscribe = transport.subscribe((data) => {
      if (!this.closed && this._links.get(id) === link) this._receiveWire(id, link, data);
    });
    this._attachCore(id, link);
    if (!this._core && id === this.coordinatorId) this._joinSent = false;
  }
  _receiveWire(id, link, raw) {
    try {
      const data = bytes(raw);
      if (data.length < 12 || data.length > CHUNK_SIZE) throw new Error("room wire size");
      const view = new DataView(data.buffer, data.byteOffset, data.length), magic = view.getUint32(0, true);
      if (magic === MAGIC) {
        const epoch = view.getUint16(6, true) - 1;
        if (epoch === this.epoch && link.coreReceive && !(this._transition?.proposal.reason === "reconnect")) {
          const copy = data.slice();
          new DataView(copy.buffer).setUint16(6, 0, true);
          link.coreReceive(copy);
        } else if (epoch === this.epoch + 1 && this._transition && link.future.length < 64) link.future.push(data.slice());
        return;
      }
      if (magic !== ROOM_MAGIC || data.length < WIRE_HEADER || data[4] !== 1 || data[5] !== 0) throw new Error("room wire protocol");
      const serial = view.getUint32(8, true), total = view.getUint32(12, true), offset = view.getUint32(16, true), digest = view.getUint32(20, true);
      if (!total || total > this.membership.maxTransferBytes || offset + data.length - WIRE_HEADER > total) throw new Error("room wire capacity");
      if (offset === 0) {
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
        if (this._incoming.length >= 128 || this._incomingBytes + total > this.membership.maxTransferBytes * 2) throw new Error("room control backlog");
        this._incoming.push({ from: id, value: this.codec.decode(incoming.bytes), size: total });
        this._incomingBytes += total;
      }
    } catch (error2) {
      link.incoming = null;
      this._stats.rejectedMessages++;
      if (this.players.includes(id)) this._fail("room-protocol-error", { peerId: id, reason: error2.message });
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
    if (this._transition || this.localPlayerId !== this.coordinatorId) throw new Error("membership coordinator busy");
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
    }).catch((error2) => this._fail("membership-connect-failed", { reason: error2.message }));
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
    }).catch((error2) => this._fail("membership-connect-failed", { reason: error2.message }));
  }
  _handle(from, m) {
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
      if (!this._transition) this._proposal([], [from], "leave");
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
    } else if (m.op === "resume-install" && from === this.coordinatorId && tr.proposal.reason === "reconnect" && !tr.replay && !tr.applied) {
      this._beginBootstrap(tr, m);
    } else if (m.op === "bootstrap" && from === this.coordinatorId && !this._core && !tr.replay && !tr.applied) {
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
    if (m.target !== tr.target || m.bootstrap.tick + m.baseTick !== tr.target || !Number.isSafeInteger(m.baseTick) || m.baseTick < 0 || this._core && m.baseTick !== this.baseTick) throw new Error("bootstrap epoch boundary");
    if (!this._core) this.baseTick = m.baseTick;
    if (this._core && tr.proposal.reason === "reconnect") this._core.verifyConfirmedBootstrap(m.bootstrap);
    tr.commandSequences = m.bootstrap.commandSequences;
    tr.replay = createBootstrapReplay({
      adapter: this._adapter(m.baseTick, this.epoch),
      bootstrap: m.bootstrap,
      maxCatchupSteps: this.membership.maxCatchupSteps,
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
  _applyMembership(tr) {
    const rollback = bytes(this.adapter.save()).slice();
    try {
      this.adapter.applyMembership({ ...tr.proposal, tick: tr.target });
      const state = bytes(this.adapter.save());
      if (state.length > this.profile.maxSnapshotBytes || !this.adapter.validateSnapshot(state, { tick: tr.target, membershipEpoch: tr.proposal.epoch })) throw new Error("invalid membership snapshot");
      tr.postHash = hashBytes(state);
      tr.postState = state.slice();
      this.adapter.load(rollback);
      tr.applied = true;
      this._send(this.coordinatorId, "installed", { epoch: tr.proposal.epoch, hash: tr.postHash });
    } catch (error2) {
      this.adapter.load(rollback);
      throw error2;
    }
  }
  _commit(tr) {
    const previousCoordinator = this.coordinatorId;
    const commandSequences = tr.commandSequences ?? this._core?.getCommandSequences?.();
    let commandState = this._core?.exportLocalCommandState() ?? (commandSequences ? { sequence: commandSequences[this.localPlayerId] ?? 0, lastInput: this._lastInput, commands: [] } : void 0);
    if (commandState && commandSequences) {
      const baseline = commandSequences[this.localPlayerId] ?? 0;
      commandState = { ...commandState, sequence: Math.max(commandState.sequence, baseline), commands: commandState.commands.filter((command) => command.sequence > baseline) };
    }
    this.adapter.load(tr.postState);
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
    this._transition = null;
    this._interruptedAt = null;
    this._stats.transitions++;
    this._retireAfter = this.clock() + this.membership.transitionTimeoutMs;
    for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._retirePeers.set(id, this._retireAfter);
    for (const id of this.players) this._retirePeers.delete(id);
    this.room?.setRoster({ epoch: this.epoch, players: [...this.players], coordinatorId: this.coordinatorId });
    this._event("membership-committed", { ...tr.proposal, tick: tr.target });
    if (!this.players.includes(this.localPlayerId)) {
      this._departing = true;
      this._retireApproved = previousCoordinator === this.localPlayerId;
      return;
    }
    this._startCore(commandState, commandSequences);
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
      if (!this._core && !this._transition && (!this._joinSent || now - this._lastJoinAt >= this.membership.joinRetryMs)) {
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
      if (this._core && !this._transition && this.coordinatorId === this.localPlayerId) {
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
      if (tr) {
        if (now - tr.startedAt >= this.membership.transitionTimeoutMs) throw new Error("membership deadline exceeded");
        if (tr.replay) {
          const result = tr.replay.pulse();
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
      } else if (!this._core && now - this._startedAt >= this.membership.transitionTimeoutMs) throw new Error("join deadline exceeded");
      for (const [id, link] of this._links) if (link.incoming && now - link.incoming.startedAt >= this.membership.transitionTimeoutMs) throw new Error("room transfer timeout: " + id);
      if (this._transition?.proposal.reason !== "reconnect") this._core?.poll(now);
      if (this._core && !tr) {
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
      if (tr && tr.commitSent && tr.applied && tr.committed.size === tr.participants.length - 1 && [...this._links.values()].every((link) => !link.queue.length)) {
        for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._send(id, "retire", { epoch: tr.proposal.epoch });
        this._commit(tr);
      }
    } catch (error2) {
      this._fail("membership-failed", { reason: error2.message });
    }
  }
  advance(input = this._lastInput) {
    if (this.closed) throw new Error("room session closed");
    const sample = bytes(input);
    if (sample.length !== this.inputSize) throw new RangeError("inputSize");
    this._lastInput = sample.slice();
    this.poll();
    if (this.failure) return { status: "failed", tick: this.tick, failure: this.failure };
    const tr = this._transition;
    if (!this._core || tr && (tr.proposal.reason === "reconnect" || tr.target === null || this.tick >= tr.target)) return { status: this.status, tick: this.tick };
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
    } catch (error2) {
      this._leaveReject(error2);
    }
    return this._leavePromise;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._core?.close();
    try {
      this._transition?.replay?.cancel();
    } catch {
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

// packages/deterministic/src/synctest.js
var DeterminismError = class extends Error {
  constructor({ tick, checkpointTick, expected, actual, inputs }) {
    let offset = 0;
    while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) offset++;
    super(`Determinism mismatch at state S[${tick}], first byte ${offset}, checkpoint S[${checkpointTick}]`);
    this.name = "DeterminismError";
    this.code = "determinism-mismatch";
    this.tick = tick;
    this.checkpointTick = checkpointTick;
    this.firstDifference = offset;
    this.expectedHash = hashBytes(expected);
    this.actualHash = hashBytes(actual);
    this.expectedState = expected.slice();
    this.actualState = actual.slice();
    this.inputs = inputs.map((frame) => ({ ...copyFrame(frame), playerId: frame.playerId, predicted: false }));
  }
};
function createSyncTestSession(options) {
  return new SyncTestSession(options);
}
var SyncTestSession = class {
  constructor({
    adapter,
    players,
    inputSize,
    tickRate = 60,
    initialTick = 0,
    checkDistance = 1,
    maxSnapshotBytes = 4 * 1024 * 1024,
    maxHistoryBytes = 64 * 1024 * 1024,
    now = () => globalThis.performance?.now() ?? Date.now()
  } = {}) {
    if (!adapter || ["save", "load", "step", "validateSnapshot"].some((key) => typeof adapter[key] !== "function")) throw new TypeError("Simulation Adapter capabilities");
    if (!Array.isArray(players) || !players.length || players.length > 8 || players.some((id) => typeof id !== "string" || !id.length) || new Set(players).size !== players.length) throw new TypeError("fixed player roster");
    if (typeof now !== "function") throw new TypeError("diagnostic clock");
    this._now = now;
    this._cost = { forwardCostMs: 0, resimulationCostMs: 0, totalCostMs: 0 };
    this.adapter = adapter;
    this.players = Object.freeze([...players].sort(compareIds));
    this.inputSize = integer(inputSize, "inputSize", 1, 1024);
    this.tickRate = integer(tickRate, "tickRate", 1, 240);
    this.checkDistance = integer(checkDistance, "checkDistance", 1, 256);
    this._tick = integer(initialTick, "initialTick", 0, MAX_TICK);
    this.initialTick = this.tick;
    this.maxSnapshotBytes = integer(maxSnapshotBytes, "maxSnapshotBytes", 1, 64 * 1024 * 1024);
    integer(maxHistoryBytes, "maxHistoryBytes", 1, 2147483647);
    this._history = new StateHistory(checkDistance + 1, maxHistoryBytes);
    this._frames = /* @__PURE__ */ new Map();
    this.failure = null;
    this.closed = false;
    this.resimulatedTicks = 0;
    this.checkedTicks = 0;
    const initial = this._save();
    if (initial.length * (checkDistance + 1) > maxHistoryBytes) throw new RangeError("synctest history byte budget");
    if (adapter.validateSnapshot(initial.slice(), { tick: this.tick }) !== true) throw new TypeError("initial snapshot validation");
    this._history.put({ tick: this.tick, bytes: initial });
  }
  get tick() {
    return this._tick;
  }
  get status() {
    return this.closed ? "closed" : this.failure ? "failed" : "running";
  }
  get metrics() {
    const error2 = this.failure;
    const failure = error2 ? Object.freeze({
      name: error2.name ?? "Error",
      message: String(error2.message ?? error2),
      code: error2.code ?? null,
      tick: error2.tick ?? null,
      checkpointTick: error2.checkpointTick ?? null,
      firstDifference: error2.firstDifference ?? null,
      expectedHash: error2.expectedHash ?? null,
      actualHash: error2.actualHash ?? null
    }) : null;
    return Object.freeze({
      status: this.status,
      tick: this.tick,
      checkDistance: this.checkDistance,
      checkedTicks: this.checkedTicks,
      resimulatedTicks: this.resimulatedTicks,
      stateHash: this.closed ? null : this.getStateHash() ?? null,
      historyBytes: this._history.byteLength,
      failure,
      ...this._cost
    });
  }
  _save() {
    const value = bytes(this.adapter.save()).slice();
    if (!value.length || value.length > this.maxSnapshotBytes) throw new RangeError("snapshot size");
    return value;
  }
  _inputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length !== this.players.length) throw new TypeError("all local player inputs required");
    const ordered2 = [...inputs].sort((a, b) => compareIds(a.playerId, b.playerId));
    return ordered2.map((frame, index) => {
      if (frame.playerId !== this.players[index] || bytes(frame.input).length !== this.inputSize) throw new TypeError("player/inputSize");
      const commands = frame.commands ?? [];
      if (!Array.isArray(commands) || commands.length > 256) throw new TypeError("commands");
      const sorted = [...commands].sort((a, b) => a.sequence - b.sequence);
      let previous = 0;
      for (const command of sorted) {
        integer(command.sequence, "command sequence", 1);
        if (command.sequence <= previous || command.executeTick !== this.tick) throw new TypeError("command ordering/executeTick");
        const payload = bytes(command.payload);
        if (!payload.length || payload.length > 15360) throw new RangeError("command payload");
        previous = command.sequence;
      }
      return { ...copyFrame({ input: bytes(frame.input), commands: sorted }), playerId: frame.playerId, predicted: false };
    });
  }
  advance(inputs) {
    if (this.closed) throw new Error("sync test closed");
    if (this.failure) throw this.failure;
    integer(this.tick + 1, "tick limit", 0, MAX_TICK);
    const frames = this._inputs(inputs), before = this._history.get(this.tick), frameTick = this.tick;
    let forward = before.bytes;
    const started = this._now();
    let replayStarted;
    try {
      runSimulationFrame(this.adapter, { tick: frameTick, tickRate: this.tickRate, inputs: frames, resimulating: false, synctesting: true });
      const next = this._save();
      this._history.put({ tick: frameTick + 1, bytes: next });
      forward = next;
      this._frames.set(frameTick, frames);
      this._tick++;
      replayStarted = this._now();
      this._cost.forwardCostMs += Math.max(0, replayStarted - started);
      const from = Math.max(this.initialTick, this.tick - this.checkDistance);
      this.adapter.load(this._history.get(from).bytes.slice());
      for (let tick = from; tick < this.tick; tick++) {
        const input = this._frames.get(tick);
        runSimulationFrame(this.adapter, { tick, tickRate: this.tickRate, inputs: input, resimulating: true, synctesting: true });
        const actual = this._save(), expected = this._history.get(tick + 1).bytes;
        this.resimulatedTicks++;
        if (!equalBytes(actual, expected)) throw new DeterminismError({ tick: tick + 1, checkpointTick: from, expected, actual, inputs: input });
      }
      this.checkedTicks++;
      for (const tick of this._frames.keys()) if (tick < from) this._frames.delete(tick);
    } catch (error2) {
      this.failure = error2;
      throw error2;
    } finally {
      try {
        this.adapter.load(forward.slice());
      } catch (error2) {
        if (this.failure) this.failure.restoreError = error2;
        else {
          this.failure = error2;
          throw error2;
        }
      } finally {
        const finished = this._now();
        if (replayStarted !== void 0) this._cost.resimulationCostMs += Math.max(0, finished - replayStarted);
        else this._cost.forwardCostMs += Math.max(0, finished - started);
        this._cost.totalCostMs += Math.max(0, finished - started);
      }
    }
    return { tick: this.tick, checkedTicks: this.checkedTicks, resimulatedTicks: this.resimulatedTicks };
  }
  getStateHash() {
    const state = this._history.get(this.tick);
    if (!state) return void 0;
    if (state.hash === void 0) state.hash = hashBytes(state.bytes);
    return state.hash;
  }
  close() {
    this.closed = true;
    this._frames.clear();
    this._history.slots.fill(void 0);
    this._history.byteLength = 0;
  }
};
function beginSyncTestBatch(frames, options) {
  if (!Array.isArray(frames)) throw new TypeError("frames");
  return { initial: bytes(options.adapter.save()).slice(), session: createSyncTestSession(options) };
}
function advanceSyncTestBatch(session, frame) {
  if (frame.tick !== session.tick) throw new TypeError("non-contiguous test frames");
  session.advance(frame.inputs);
}
function syncTestBatchResult(session) {
  return { tick: session.tick, checkedTicks: session.checkedTicks, resimulatedTicks: session.resimulatedTicks, hash: session.getStateHash(), metrics: session.metrics };
}
function syncTestBatchFailure(session, error2) {
  const failure = error2 instanceof Error ? error2 : new Error(String(error2));
  session.failure ??= failure;
  failure.syncTestMetrics = session.metrics;
  return failure;
}
function checkSyncTestAbort(signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error2 = new Error(signal.reason === void 0 ? "Synctest aborted" : String(signal.reason));
    error2.name = "AbortError";
    throw error2;
  }
}
function runSyncTest({ frames, ...options } = {}) {
  const { initial, session } = beginSyncTestBatch(frames, options);
  try {
    for (const frame of frames) advanceSyncTestBatch(session, frame);
    return syncTestBatchResult(session);
  } catch (error2) {
    throw syncTestBatchFailure(session, error2);
  } finally {
    session.close();
    options.adapter.load(initial);
  }
}
async function runSyncTestAsync({ frames, yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)), signal, ...options } = {}) {
  if (typeof yieldControl !== "function") throw new TypeError("yieldControl");
  const { initial, session } = beginSyncTestBatch(frames, options);
  try {
    checkSyncTestAbort(signal);
    for (const frame of frames) {
      await yieldControl();
      checkSyncTestAbort(signal);
      advanceSyncTestBatch(session, frame);
      await yieldControl();
      checkSyncTestAbort(signal);
    }
    return syncTestBatchResult(session);
  } catch (error2) {
    throw syncTestBatchFailure(session, error2);
  } finally {
    session.close();
    options.adapter.load(initial);
  }
}

// packages/simloop/src/loop.js
function createLoop({
  session,
  getInput = () => new Uint8Array(session.inputSize),
  render = () => {
  },
  backlogPolicy = "drop",
  beforeFrame = () => {
  },
  canAdvance = () => true,
  onAdvance = () => {
  },
  onError = (error2) => {
    throw error2;
  },
  onInputRelease = () => {
  },
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
} = {}) {
  if (!session || typeof session.poll !== "function" || typeof session.advance !== "function") throw new TypeError("session capability");
  for (const callback of [getInput, render, beforeFrame, canAdvance, onAdvance, onError, onInputRelease]) {
    if (typeof callback !== "function") throw new TypeError("loop callback");
  }
  if (backlogPolicy !== "drop" && backlogPolicy !== "retain") throw new RangeError("backlogPolicy");
  const quantum = 1e3 / session.profile.tickRate;
  let running = false, handle, last, accumulator = 0, generation = 0, timingGeneration = 0;
  const resetTiming = () => {
    timingGeneration++;
    last = void 0;
    accumulator = 0;
  };
  const release = () => {
    try {
      onInputRelease();
      session.releaseInput();
    } catch (error2) {
      stop();
      onError(error2);
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
    globalThis.removeEventListener?.("blur", release);
    globalThis.document?.removeEventListener("visibilitychange", hidden);
  };
  const pulse = (timestamp) => {
    const current = generation;
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError("frame timestamp");
      if (backlogPolicy === "retain" && last !== void 0 && timestamp < last) throw new RangeError("retained loop timestamp cannot regress");
      beforeFrame(timestamp);
      if (current !== generation) return;
      const timing = timingGeneration;
      if (last === void 0) last = timestamp;
      const elapsed = Math.max(0, timestamp - last);
      accumulator = backlogPolicy === "retain" ? accumulator + elapsed : Math.min(accumulator + Math.min(250, elapsed), quantum * session.profile.maxCatchupSteps);
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) throw new RangeError("loop backlog exceeds safe milliseconds");
      last = timestamp;
      session.poll();
      if (current !== generation || timing !== timingGeneration) return;
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
        const input = getInput();
        if (current !== generation || timing !== timingGeneration) return;
        const result = session.advance(input);
        work++;
        if (timing !== timingGeneration) return;
        if (result.status === "advanced") accumulator = Math.max(0, accumulator - quantum * pace);
        else if (backlogPolicy === "drop") accumulator = Math.min(accumulator, quantum);
        if (current !== generation) return;
        onAdvance(result);
        if (current !== generation || timing !== timingGeneration) return;
        if (result.status !== "advanced") break;
      }
      render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
    } catch (error2) {
      if (current === generation) stop();
      onError(error2);
    }
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") throw new TypeError("frame scheduler");
    running = true;
    resetTiming();
    const current = ++generation;
    const frame = (timestamp) => {
      if (!running || current !== generation) return;
      pulse(timestamp);
      if (running && current === generation) handle = requestFrame(frame);
    };
    globalThis.addEventListener?.("blur", release);
    globalThis.document?.addEventListener("visibilitychange", hidden);
    handle = requestFrame(frame);
  };
  return { start, stop, pulse, resetTiming, get running() {
    return running;
  } };
}

// packages/transport/src/webrtc.js
var WebRTCTransport = class {
  constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
    if (!controlChannel || typeof controlChannel.send !== "function") throw new TypeError("controlChannel");
    integer(highWaterMark, "highWaterMark", CHUNK_SIZE, 16 * 1024 * 1024);
    integer(lowWaterMark, "lowWaterMark", 0, highWaterMark);
    this.inputChannel = inputChannel ?? controlChannel;
    this.controlChannel = controlChannel;
    this.highWaterMark = highWaterMark;
    this.listeners = /* @__PURE__ */ new Set();
    this.statusListeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.connectionState = "connected";
    this._lastStatus = null;
    this.channels = [.../* @__PURE__ */ new Set([this.inputChannel, this.controlChannel])];
    this._onMessage = async (event) => {
      if (this.closed) return;
      let data = event.data;
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        if (data.size > CHUNK_SIZE) return;
        data = await data.arrayBuffer();
      }
      if (this.closed) return;
      try {
        const b = bytes(data);
        if (b.length > CHUNK_SIZE) return;
        for (const listener of this.listeners) listener(b.slice());
      } catch {
      }
    };
    for (const channel of this.channels) {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = lowWaterMark;
      channel.addEventListener("message", this._onMessage);
      channel.addEventListener("open", this._onStatus = this._onStatus ?? (() => this._notifyStatus()));
      channel.addEventListener("close", this._onStatus);
      channel.addEventListener("error", this._onChannelError = this._onChannelError ?? (() => {
        this.connectionState = "failed";
        this._notifyStatus();
      }));
    }
  }
  get state() {
    if (this.closed || this.connectionState === "closed" || this.channels.some((c) => c.readyState === "closed" || c.readyState === "closing")) return "closed";
    if (this.connectionState === "failed") return "failed";
    if (this.connectionState === "disconnected") return "interrupted";
    return this.channels.every((c) => c.readyState === "open") ? "open" : "connecting";
  }
  _notifyStatus() {
    const state = this.state;
    if (state === this._lastStatus) return;
    this._lastStatus = state;
    for (const listener of this.statusListeners) {
      try {
        listener(state);
      } catch {
      }
    }
  }
  setConnectionState(state) {
    this.connectionState = state;
    this._notifyStatus();
  }
  subscribeStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("status subscriber");
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  get bufferedAmount() {
    return this.channels.reduce((n, c) => n + c.bufferedAmount, 0);
  }
  send(data) {
    const b = bytes(data);
    if (b.length > CHUNK_SIZE) throw new RangeError("DataChannel chunk size");
    const type = b.length >= HEADER ? b[5] : 0;
    const channel = type === TYPE.INPUT || type === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
    if (this.closed || channel.readyState !== "open" || this.bufferedAmount + b.length > this.highWaterMark) return false;
    try {
      channel.send(b);
      return true;
    } catch (error2) {
      if (error2.name === "OperationError" || error2.name === "InvalidStateError") return false;
      throw error2;
    }
  }
  subscribe(handler) {
    if (this.closed || typeof handler !== "function") throw new TypeError("transport subscriber");
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._notifyStatus();
    for (const channel of this.channels) {
      channel.removeEventListener("message", this._onMessage);
      channel.removeEventListener("open", this._onStatus);
      channel.removeEventListener("close", this._onStatus);
      channel.removeEventListener("error", this._onChannelError);
      channel.close();
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }
};
var DEFAULT_ICE = Object.freeze([{ urls: "stun:stun.l.google.com:19302" }]);
function createWebRTCPeer({
  initiator = false,
  signaler,
  remoteId,
  rtcConfig = { iceServers: DEFAULT_ICE },
  timeoutMs = 2e4,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  onStatus = () => {
  },
  signal
} = {}) {
  if (signal?.aborted) return Promise.reject(new Error("connection aborted"));
  if (typeof RTCPeerConnectionImpl !== "function" || typeof signaler?.send !== "function" || typeof signaler.subscribe !== "function" || !remoteId) return Promise.reject(new TypeError("WebRTC and Signaler capabilities required"));
  let pc;
  try {
    integer(timeoutMs, "timeoutMs", 1, 12e4);
    pc = new RTCPeerConnectionImpl(rtcConfig);
  } catch (error2) {
    return Promise.reject(error2);
  }
  let inputChannel, controlChannel, transport, unsubscribe, timer, disposed = false, settled = false;
  let chain = Promise.resolve();
  const earlyIce = [], iceBatch = [];
  let iceTimer;
  const status = (value) => {
    try {
      onStatus(value);
    } catch {
    }
  };
  let resolve, reject;
  const result = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(iceTimer);
    unsubscribe?.();
    signal?.removeEventListener("abort", close);
    transport?.close();
    pc.close();
    if (!settled) {
      settled = true;
      reject(new Error("WebRTC connection closed"));
    }
  };
  const fail = (error2) => {
    status({ type: "connection-error", error: error2 });
    if (!settled) {
      settled = true;
      reject(error2);
    }
    close();
  };
  signal?.addEventListener("abort", close, { once: true });
  const send = (message) => Promise.resolve(signaler.send(remoteId, message));
  const maybeReady = () => {
    if (disposed || settled || inputChannel?.readyState !== "open" || controlChannel?.readyState !== "open") return;
    clearTimeout(timer);
    settled = true;
    transport = new WebRTCTransport({ inputChannel, controlChannel });
    status({ type: "connected" });
    resolve({ transport, peerConnection: pc, close });
  };
  const channel = (value) => {
    if (value.label === "inputs" && !inputChannel) inputChannel = value;
    else if (value.label === "control" && !controlChannel) controlChannel = value;
    else {
      value.close();
      return;
    }
    value.addEventListener("open", maybeReady);
    maybeReady();
  };
  pc.addEventListener("datachannel", (event) => channel(event.channel));
  const flushCandidates = () => {
    clearTimeout(iceTimer);
    if (disposed || !iceBatch.length) return;
    send({ type: "ice", candidates: iceBatch.splice(0) }).catch(fail);
  };
  pc.addEventListener("icecandidate", (event) => {
    if (disposed) return;
    if (event.candidate) {
      if (iceBatch.length >= 128) {
        fail(new RangeError("ICE candidate batch capacity"));
        return;
      }
      iceBatch.push(event.candidate.toJSON());
      clearTimeout(iceTimer);
      iceTimer = setTimeout(flushCandidates, 100);
    } else flushCandidates();
  });
  pc.addEventListener("connectionstatechange", () => {
    transport?.setConnectionState(pc.connectionState);
    status({ type: "connection-state", state: pc.connectionState });
    if (pc.connectionState === "failed") fail(new Error("P2P connection failed; no automatic TURN fallback"));
  });
  const flushIce = async () => {
    while (earlyIce.length) await pc.addIceCandidate(earlyIce.shift());
  };
  unsubscribe = signaler.subscribe((event) => {
    if (disposed || event.from !== remoteId || event.to !== signaler.id && event.to !== "*") return;
    const message = event.message;
    chain = chain.then(async () => {
      if (disposed) return;
      if (message?.type === "offer" && !initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
        await pc.setLocalDescription(await pc.createAnswer());
        await send({ type: "answer", description: pc.localDescription.toJSON() });
      } else if (message?.type === "answer" && initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
      } else if (message?.type === "ice") {
        const candidates = message.candidates ?? (message.candidate ? [message.candidate] : []);
        if (!Array.isArray(candidates) || candidates.length > 128) throw new RangeError("ICE candidate batch");
        for (const candidate of candidates) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else if (earlyIce.length < 128) earlyIce.push(candidate);
          else throw new RangeError("ICE queue capacity");
        }
      } else if (message?.type === "bye") close();
    }).catch(fail);
  });
  timer = setTimeout(() => fail(new Error("P2P connection timeout")), integer(timeoutMs, "timeoutMs", 1, 12e4));
  if (initiator) {
    channel(pc.createDataChannel("inputs", { ordered: false, maxRetransmits: 0 }));
    channel(pc.createDataChannel("control", { ordered: true }));
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await send({ type: "offer", description: pc.localDescription.toJSON() });
    }).catch(fail);
  }
  return result;
}

// packages/transport/src/nostr-crypto.js
var nostrField = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
var nostrOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
var nostrGenerator = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n
];
var nostrInfinity = [0n, 1n, 0n];
var nostrEncoder = new TextEncoder();
function nostrMod(nostrValue, nostrModulus = nostrField) {
  const nostrRemainder = nostrValue % nostrModulus;
  return nostrRemainder < 0n ? nostrRemainder + nostrModulus : nostrRemainder;
}
function nostrPow(nostrBase, nostrExponent) {
  let nostrResult = 1n;
  nostrBase = nostrMod(nostrBase);
  while (nostrExponent > 0n) {
    if (nostrExponent & 1n) nostrResult = nostrMod(nostrResult * nostrBase);
    nostrBase = nostrMod(nostrBase * nostrBase);
    nostrExponent >>= 1n;
  }
  return nostrResult;
}
function nostrDouble(nostrPoint) {
  const [nostrX, nostrY, nostrZ] = nostrPoint;
  if (nostrZ === 0n || nostrY === 0n) return nostrInfinity;
  const nostrA = nostrMod(nostrX * nostrX);
  const nostrB = nostrMod(nostrY * nostrY);
  const nostrC = nostrMod(nostrB * nostrB);
  const nostrD = nostrMod(2n * (nostrMod((nostrX + nostrB) ** 2n) - nostrA - nostrC));
  const nostrE = nostrMod(3n * nostrA);
  const nostrNextX = nostrMod(nostrE * nostrE - 2n * nostrD);
  return [nostrNextX, nostrMod(nostrE * (nostrD - nostrNextX) - 8n * nostrC), nostrMod(2n * nostrY * nostrZ)];
}
function nostrAdd(nostrLeft, nostrRight) {
  if (nostrLeft[2] === 0n) return nostrRight;
  if (nostrRight[2] === 0n) return nostrLeft;
  const [nostrX1, nostrY1, nostrZ1] = nostrLeft;
  const [nostrX2, nostrY2, nostrZ2] = nostrRight;
  const nostrZ1Squared = nostrMod(nostrZ1 * nostrZ1);
  const nostrZ2Squared = nostrMod(nostrZ2 * nostrZ2);
  const nostrU1 = nostrMod(nostrX1 * nostrZ2Squared);
  const nostrU2 = nostrMod(nostrX2 * nostrZ1Squared);
  const nostrS1 = nostrMod(nostrY1 * nostrZ2Squared * nostrZ2);
  const nostrS2 = nostrMod(nostrY2 * nostrZ1Squared * nostrZ1);
  if (nostrU1 === nostrU2) return nostrS1 === nostrS2 ? nostrDouble(nostrLeft) : nostrInfinity;
  const nostrH = nostrMod(nostrU2 - nostrU1);
  const nostrI = nostrMod(4n * nostrH * nostrH);
  const nostrJ = nostrMod(nostrH * nostrI);
  const nostrR = nostrMod(2n * (nostrS2 - nostrS1));
  const nostrV = nostrMod(nostrU1 * nostrI);
  const nostrNextX = nostrMod(nostrR * nostrR - nostrJ - 2n * nostrV);
  return [
    nostrNextX,
    nostrMod(nostrR * (nostrV - nostrNextX) - 2n * nostrS1 * nostrJ),
    nostrMod(((nostrZ1 + nostrZ2) ** 2n - nostrZ1Squared - nostrZ2Squared) * nostrH)
  ];
}
function nostrMultiply(nostrScalar, nostrPoint = nostrGenerator) {
  let nostrResult = nostrInfinity;
  while (nostrScalar > 0n) {
    if (nostrScalar & 1n) nostrResult = nostrAdd(nostrResult, nostrPoint);
    nostrPoint = nostrDouble(nostrPoint);
    nostrScalar >>= 1n;
  }
  return nostrResult;
}
function nostrAffine(nostrPoint) {
  if (nostrPoint[2] === 0n) return null;
  const nostrInverse = nostrPow(nostrPoint[2], nostrField - 2n);
  const nostrInverseSquared = nostrMod(nostrInverse * nostrInverse);
  return [nostrMod(nostrPoint[0] * nostrInverseSquared), nostrMod(nostrPoint[1] * nostrInverseSquared * nostrInverse)];
}
function nostrLiftX(nostrX) {
  if (nostrX >= nostrField) return null;
  const nostrC = nostrMod(nostrX ** 3n + 7n);
  const nostrY = nostrPow(nostrC, (nostrField + 1n) / 4n);
  if (nostrMod(nostrY * nostrY) !== nostrC) return null;
  return [nostrX, nostrY & 1n ? nostrField - nostrY : nostrY, 1n];
}
function nostrRequireBytes(nostrValue, nostrLength, nostrName) {
  if (!(nostrValue instanceof Uint8Array) || nostrValue.length !== nostrLength) {
    throw new TypeError(`${nostrName} must be a ${nostrLength}-byte Uint8Array`);
  }
  return new Uint8Array(nostrValue);
}
function nostrBytesToNumber(nostrBytes) {
  let nostrValue = 0n;
  for (const nostrByte of nostrBytes) nostrValue = nostrValue << 8n | BigInt(nostrByte);
  return nostrValue;
}
function nostrNumberToBytes(nostrValue) {
  const nostrBytes = new Uint8Array(32);
  for (let nostrIndex = 31; nostrIndex >= 0; nostrIndex--) {
    nostrBytes[nostrIndex] = Number(nostrValue & 255n);
    nostrValue >>= 8n;
  }
  return nostrBytes;
}
function nostrToHex(nostrBytes) {
  return Array.from(nostrBytes, (nostrByte) => nostrByte.toString(16).padStart(2, "0")).join("");
}
function nostrFromHex(nostrHex) {
  return Uint8Array.from(nostrHex.match(/../g), (nostrByte) => parseInt(nostrByte, 16));
}
function nostrConcat(...nostrParts) {
  const nostrBytes = new Uint8Array(nostrParts.reduce((nostrSize, nostrPart) => nostrSize + nostrPart.length, 0));
  let nostrOffset = 0;
  for (const nostrPart of nostrParts) {
    nostrBytes.set(nostrPart, nostrOffset);
    nostrOffset += nostrPart.length;
  }
  return nostrBytes;
}
function nostrRequireCrypto(nostrCryptoImpl, nostrRandom = false) {
  if (!nostrCryptoImpl?.subtle || typeof nostrCryptoImpl.subtle.digest !== "function" || nostrRandom && typeof nostrCryptoImpl.getRandomValues !== "function") {
    throw new Error("Nostr signaling requires WebCrypto SHA-256 and secure randomness (use HTTPS)");
  }
}
async function nostrHash(nostrBytes, nostrCryptoImpl) {
  nostrRequireCrypto(nostrCryptoImpl);
  return new Uint8Array(await nostrCryptoImpl.subtle.digest("SHA-256", nostrBytes));
}
async function nostrTaggedHash(nostrTag, nostrBytes, nostrCryptoImpl) {
  const nostrTagHash = await nostrHash(nostrEncoder.encode(nostrTag), nostrCryptoImpl);
  return nostrHash(nostrConcat(nostrTagHash, nostrTagHash, nostrBytes), nostrCryptoImpl);
}
function nostrPublicKey(nostrSecret) {
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    return nostrNumberToBytes(nostrAffine(nostrMultiply(nostrScalar))[0]);
  } finally {
    nostrSecretCopy.fill(0);
  }
}
async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
  if (!(nostrSignature instanceof Uint8Array) || nostrSignature.length !== 64 || !(nostrMessage instanceof Uint8Array) || nostrMessage.length !== 32 || !(nostrPublic instanceof Uint8Array) || nostrPublic.length !== 32) return false;
  const nostrSignatureCopy = new Uint8Array(nostrSignature);
  const nostrMessageCopy = new Uint8Array(nostrMessage);
  const nostrPublicCopy = new Uint8Array(nostrPublic);
  const nostrPoint = nostrLiftX(nostrBytesToNumber(nostrPublicCopy));
  const nostrR = nostrBytesToNumber(nostrSignatureCopy.subarray(0, 32));
  const nostrS = nostrBytesToNumber(nostrSignatureCopy.subarray(32));
  if (!nostrPoint || nostrR >= nostrField || nostrS >= nostrOrder) return false;
  const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
    "BIP0340/challenge",
    nostrConcat(nostrSignatureCopy.subarray(0, 32), nostrPublicCopy, nostrMessageCopy),
    nostrCryptoImpl
  )) % nostrOrder;
  const nostrResult = nostrAffine(nostrAdd(nostrMultiply(nostrS), nostrMultiply(
    nostrChallenge,
    [nostrPoint[0], nostrMod(-nostrPoint[1]), 1n]
  )));
  return nostrResult !== null && (nostrResult[1] & 1n) === 0n && nostrResult[0] === nostrR;
}
async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
  const nostrMessageCopy = nostrRequireBytes(nostrMessage, 32, "message");
  const nostrAuxiliaryCopy = nostrRequireBytes(nostrAuxiliary, 32, "auxiliary randomness");
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  let nostrMaskedSecret;
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    const nostrPoint = nostrAffine(nostrMultiply(nostrScalar));
    const nostrNormalizedSecret = nostrPoint[1] & 1n ? nostrOrder - nostrScalar : nostrScalar;
    const nostrPublic = nostrNumberToBytes(nostrPoint[0]);
    const nostrAuxiliaryHash = await nostrTaggedHash("BIP0340/aux", nostrAuxiliaryCopy, nostrCryptoImpl);
    nostrMaskedSecret = nostrNumberToBytes(nostrNormalizedSecret);
    for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) nostrMaskedSecret[nostrIndex] ^= nostrAuxiliaryHash[nostrIndex];
    const nostrNonce = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/nonce",
      nostrConcat(nostrMaskedSecret, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    if (nostrNonce === 0n) throw new Error("BIP340 nonce generation failed");
    const nostrNoncePoint = nostrAffine(nostrMultiply(nostrNonce));
    const nostrNormalizedNonce = nostrNoncePoint[1] & 1n ? nostrOrder - nostrNonce : nostrNonce;
    const nostrR = nostrNumberToBytes(nostrNoncePoint[0]);
    const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/challenge",
      nostrConcat(nostrR, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    const nostrSignature = nostrConcat(nostrR, nostrNumberToBytes(nostrMod(nostrNormalizedNonce + nostrChallenge * nostrNormalizedSecret, nostrOrder)));
    if (!await nostrVerify(nostrSignature, nostrMessageCopy, nostrPublic, nostrCryptoImpl)) throw new Error("BIP340 signature self-check failed");
    return nostrSignature;
  } finally {
    nostrSecretCopy.fill(0);
    nostrAuxiliaryCopy.fill(0);
    nostrMaskedSecret?.fill(0);
  }
}
var nostrCrypto = Object.freeze({
  publicKey: nostrPublicKey,
  sign: (nostrMessage, nostrSecret, nostrAuxiliary) => nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
  verify: (nostrSignature, nostrMessage, nostrPublic) => nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto)
});

// packages/transport/src/nostr.js
var nostrHex32 = /^[0-9a-f]{64}$/;
var nostrHex64 = /^[0-9a-f]{128}$/;
var nostrSignalTypes = /* @__PURE__ */ new Set(["discover", "presence", "offer", "answer", "ice", "bye", "group"]);
var nostrContentLimit = 128 * 1024;
var nostrFreshSeconds = 120;
var nostrFutureSeconds = 30;
function nostrIsSignalMessage(nostrMessage) {
  return nostrMessage !== null && typeof nostrMessage === "object" && !Array.isArray(nostrMessage) && Object.prototype.hasOwnProperty.call(nostrMessage, "type") && nostrSignalTypes.has(nostrMessage.type);
}
function nostrListen(nostrSocket, nostrType, nostrHandler) {
  if (typeof nostrSocket.addEventListener === "function") {
    nostrSocket.addEventListener(nostrType, nostrHandler);
    return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
  }
  const nostrProperty = `on${nostrType}`;
  nostrSocket[nostrProperty] = nostrHandler;
  return () => {
    if (nostrSocket[nostrProperty] === nostrHandler) nostrSocket[nostrProperty] = null;
  };
}
async function createNostrSignaler({
  room,
  namespace = "rollback-netcode",
  relays = ["wss://relay.primal.net", "wss://relay.damus.io"],
  timeoutMs = 1e4,
  onStatus = () => {
  },
  WebSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto,
  signal,
  publishIntervalMs = 500,
  maxVerificationsPerSecond = 16,
  verificationBurst = 8,
  identity
} = {}) {
  if (signal?.aborted) throw new Error("Nostr signaler aborted");
  if (typeof room !== "string" || !/^\d{4}$/.test(room)) throw new TypeError("room must contain exactly four ASCII digits");
  if (typeof namespace !== "string" || namespace.trim().length === 0 || nostrEncoder.encode(namespace).length > 128) throw new TypeError("namespace must be a nonempty string of at most 128 UTF-8 bytes");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12e4) throw new RangeError("timeoutMs must be greater than zero and at most 120000");
  integer(publishIntervalMs, "publishIntervalMs", 0, 1e4);
  integer(maxVerificationsPerSecond, "maxVerificationsPerSecond", 1, 1024);
  integer(verificationBurst, "verificationBurst", 1, 32);
  if (typeof WebSocketImpl !== "function") throw new Error("Nostr signaling requires WebSocket support");
  if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");
  nostrRequireCrypto(cryptoImpl, true);
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) throw new TypeError("relays must contain between 1 and 16 WebSocket URLs");
  const nostrUrls = [...new Set(relays.map((nostrRelay) => {
    if (typeof nostrRelay !== "string") throw new TypeError("Relay URLs must be strings");
    const nostrUrl = new URL(nostrRelay);
    if (!["ws:", "wss:"].includes(nostrUrl.protocol) || nostrUrl.username || nostrUrl.password || nostrUrl.hash) throw new TypeError("Relays must be ws:// or wss:// URLs without credentials or fragments");
    return nostrUrl.href;
  }))];
  const nostrRandom = (nostrLength) => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
  if (identity && (!nostrHex32.test(identity.id) || typeof identity.sign !== "function" || typeof identity.close !== "function")) throw new TypeError("Nostr identity capability");
  const nostrSecret = new Uint8Array(32);
  let nostrSecretReady = !!identity;
  for (let nostrAttempt = 0; !nostrSecretReady && nostrAttempt < 16; nostrAttempt++) {
    nostrSecret.set(nostrRandom(32));
    const nostrValue = nostrBytesToNumber(nostrSecret);
    if (nostrValue > 0n && nostrValue < nostrOrder) {
      nostrSecretReady = true;
      break;
    }
  }
  if (!nostrSecretReady) {
    nostrSecret.fill(0);
    throw new Error("Secure random secret generation failed");
  }
  const nostrId = identity?.id ?? nostrToHex(nostrPublicKey(nostrSecret));
  const nostrRoomTag = `${namespace}:${room}`;
  const nostrSubscription = `rn-${nostrToHex(nostrRandom(16))}`;
  const nostrListeners = /* @__PURE__ */ new Set();
  const nostrBacklog = [];
  const nostrSeen = /* @__PURE__ */ new Map();
  const nostrVerifying = /* @__PURE__ */ new Set();
  const nostrPending = /* @__PURE__ */ new Map();
  const nostrStates = [];
  let verificationTokens = verificationBurst, verificationAt = nowMs();
  const verificationMetrics = { attempted: 0, verified: 0, throttled: 0, totalVerificationMs: 0, maxVerificationMs: 0 };
  let nostrClosed = false;
  let nostrSending = 0;
  let nostrSendTail = Promise.resolve(), nostrLastPublication = -Infinity;
  const nostrWaiters = /* @__PURE__ */ new Map();
  let nostrHasSubscriber = false;
  let nostrReadyResolve;
  let nostrReadyReject;
  let nostrInitializationSettled = false;
  const nostrReady = new Promise((nostrResolve, nostrReject) => {
    nostrReadyResolve = nostrResolve;
    nostrReadyReject = nostrReject;
  });
  const nostrStatus = (nostrStatusName, nostrRelay, nostrMessage) => {
    if (nostrClosed && nostrStatusName !== "closed") return;
    try {
      onStatus({ type: "signaler", transport: "nostr", status: nostrStatusName, ...nostrRelay ? { relay: nostrRelay } : {}, ...nostrMessage ? { message: String(nostrMessage) } : {} });
    } catch {
    }
  };
  function nostrFinishPublication(nostrEventId, nostrError) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication) return;
    clearTimeout(nostrPublication.timer);
    nostrPending.delete(nostrEventId);
    if (nostrError) nostrPublication.reject(nostrError);
    else nostrPublication.resolve();
  }
  function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication || !nostrPublication.remaining.delete(nostrState)) return;
    nostrPublication.failures.push(`${nostrState.url}: ${nostrReason}`);
    if (nostrPublication.remaining.size === 0 && !nostrStates.some((nostrRelay) => !nostrRelay.failed && !nostrRelay.ready)) nostrFinishPublication(
      nostrEventId,
      new Error(`No Nostr relay accepted the event: ${nostrPublication.failures.join("; ")}`)
    );
  }
  function nostrFailRelay(nostrState, nostrReason) {
    if (nostrState.failed || nostrClosed) return;
    nostrState.failed = true;
    nostrState.ready = false;
    clearTimeout(nostrState.timer);
    for (const nostrRemove of nostrState.remove) nostrRemove();
    try {
      nostrState.socket?.close();
    } catch {
    }
    for (const nostrEventId of nostrPending.keys()) nostrPublicationFailure(nostrState, nostrEventId, nostrReason);
    nostrStatus("error", nostrState.url, nostrReason);
    if (!nostrInitializationSettled && nostrStates.length === nostrUrls.length && nostrStates.every((nostrRelay) => nostrRelay.failed)) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
    }
  }
  function nostrDeliver(nostrEnvelope) {
    if (nostrClosed) return;
    if (!nostrHasSubscriber) {
      if (nostrBacklog.length === 32) nostrBacklog.shift();
      nostrBacklog.push(nostrEnvelope);
      return;
    }
    for (const nostrHandler of [...nostrListeners]) {
      if (nostrClosed) break;
      try {
        const nostrResult = nostrHandler(nostrEnvelope);
        if (nostrResult && typeof nostrResult.then === "function") Promise.resolve(nostrResult).catch((nostrError) => nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed"));
      } catch (nostrError) {
        nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed");
      }
    }
  }
  async function nostrReceive(nostrEvent) {
    if (nostrClosed || !nostrEvent || typeof nostrEvent !== "object" || Array.isArray(nostrEvent) || typeof nostrEvent.id !== "string" || typeof nostrEvent.pubkey !== "string" || typeof nostrEvent.sig !== "string" || !nostrHex32.test(nostrEvent.id) || !nostrHex32.test(nostrEvent.pubkey) || !nostrHex64.test(nostrEvent.sig) || nostrEvent.pubkey === nostrId || nostrEvent.kind !== 20078 || !Number.isSafeInteger(nostrEvent.created_at) || typeof nostrEvent.content !== "string" || nostrEvent.content.length > nostrContentLimit || !Array.isArray(nostrEvent.tags) || nostrEvent.tags.length > 16 || nostrVerifying.size >= 32) return;
    const nostrNow = Date.now();
    const nostrNowSeconds = Math.floor(nostrNow / 1e3);
    if (nostrEvent.created_at < nostrNowSeconds - nostrFreshSeconds || nostrEvent.created_at > nostrNowSeconds + nostrFutureSeconds || nostrEncoder.encode(nostrEvent.content).length > nostrContentLimit) return;
    for (const [nostrSeenId, nostrExpiry] of nostrSeen) {
      if (nostrExpiry > nostrNow) break;
      nostrSeen.delete(nostrSeenId);
    }
    if (nostrSeen.has(nostrEvent.id) || nostrVerifying.has(nostrEvent.id)) return;
    if (!nostrEvent.tags.every((nostrTag) => Array.isArray(nostrTag) && nostrTag.length > 0 && nostrTag.length <= 4 && nostrTag.every((nostrValue) => typeof nostrValue === "string" && nostrEncoder.encode(nostrValue).length <= 256))) return;
    const nostrRoomTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "d");
    const nostrRecipientTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "p");
    if (nostrRoomTags.length !== 1 || nostrRoomTags[0][1] !== nostrRoomTag) return;
    let nostrContent;
    try {
      nostrContent = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (!nostrContent || nostrContent.v !== 1 || nostrContent.namespace !== namespace || nostrContent.room !== room || nostrContent.from !== nostrEvent.pubkey || typeof nostrContent.nonce !== "string" || !/^[0-9a-f]{32}$/.test(nostrContent.nonce) || nostrContent.to !== "*" && nostrContent.to !== nostrId || !nostrIsSignalMessage(nostrContent.message)) return;
    if (nostrContent.to === "*" ? nostrRecipientTags.length !== 0 : nostrRecipientTags.length !== 1 || nostrRecipientTags[0][1] !== nostrContent.to) return;
    const measuredNow = nowMs();
    verificationTokens = Math.min(verificationBurst, verificationTokens + Math.max(0, measuredNow - verificationAt) * maxVerificationsPerSecond / 1e3);
    verificationAt = measuredNow;
    if (verificationTokens < 1) {
      verificationMetrics.throttled++;
      return;
    }
    verificationTokens--;
    verificationMetrics.attempted++;
    nostrVerifying.add(nostrEvent.id);
    try {
      const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content])), cryptoImpl);
      if (nostrToHex(nostrHashBytes) !== nostrEvent.id || !await nostrVerify(nostrFromHex(nostrEvent.sig), nostrHashBytes, nostrFromHex(nostrEvent.pubkey), cryptoImpl) || nostrClosed) return;
      if (nostrSeen.size >= 2048) nostrSeen.delete(nostrSeen.keys().next().value);
      nostrSeen.set(nostrEvent.id, nostrNow + 3e5);
      verificationMetrics.verified++;
      nostrDeliver({ from: nostrContent.from, to: nostrContent.to, message: nostrContent.message });
    } catch (nostrError) {
      nostrStatus("error", null, nostrError?.message || "Nostr verification failed");
    } finally {
      nostrVerifying.delete(nostrEvent.id);
      const elapsed = nowMs() - measuredNow;
      verificationMetrics.totalVerificationMs += elapsed;
      verificationMetrics.maxVerificationMs = Math.max(verificationMetrics.maxVerificationMs, elapsed);
    }
  }
  function nostrHandleMessage(nostrState, nostrData) {
    if (nostrClosed || nostrState.failed || typeof nostrData !== "string" || nostrData.length > 1024 * 1024) return;
    let nostrFrame;
    try {
      nostrFrame = JSON.parse(nostrData);
    } catch {
      return;
    }
    if (!Array.isArray(nostrFrame)) return;
    if (nostrFrame[0] === "EOSE" && nostrFrame.length === 2 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      if (nostrState.ready) return;
      nostrState.ready = true;
      clearTimeout(nostrState.timer);
      nostrStatus("connected", nostrState.url);
      if (!nostrInitializationSettled) {
        nostrInitializationSettled = true;
        nostrReadyResolve();
      }
      for (const nostrPublication of nostrPending.values()) if (!nostrPublication.attempted.has(nostrState)) {
        nostrPublication.attempted.add(nostrState);
        nostrPublication.remaining.add(nostrState);
        try {
          nostrState.socket.send(nostrPublication.frame);
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Fallback publication failed");
        }
      }
    } else if (nostrFrame[0] === "EVENT" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      void nostrReceive(nostrFrame[2]);
    } else if (nostrFrame[0] === "OK" && nostrFrame.length === 4 && typeof nostrFrame[1] === "string" && typeof nostrFrame[2] === "boolean" && typeof nostrFrame[3] === "string") {
      const nostrPublication = nostrPending.get(nostrFrame[1]);
      if (!nostrPublication?.remaining.has(nostrState)) return;
      if (nostrFrame[2]) {
        nostrFinishPublication(nostrFrame[1]);
        nostrStatus("published", nostrState.url);
      } else nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || "Relay rejected the event");
    } else if (nostrFrame[0] === "CLOSED" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && typeof nostrFrame[2] === "string") {
      nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
    } else if (nostrFrame[0] === "NOTICE" && typeof nostrFrame[1] === "string") {
      nostrStatus("notice", nostrState.url, nostrFrame[1].slice(0, 256));
    }
  }
  function nostrClose() {
    if (nostrClosed) return;
    nostrClosed = true;
    signal?.removeEventListener("abort", nostrClose);
    for (const [nostrTimer, nostrReject] of nostrWaiters) {
      clearTimeout(nostrTimer);
      nostrReject(new Error("Nostr signaler closed"));
    }
    nostrWaiters.clear();
    for (const nostrState of nostrStates) {
      clearTimeout(nostrState.timer);
      if (nostrState.socket?.readyState === 1 && nostrState.requested) {
        try {
          nostrState.socket.send(JSON.stringify(["CLOSE", nostrSubscription]));
        } catch {
        }
      }
      for (const nostrRemove of nostrState.remove) nostrRemove();
      try {
        nostrState.socket?.close();
      } catch {
      }
      nostrState.ready = false;
    }
    for (const nostrEventId of nostrPending.keys()) nostrFinishPublication(nostrEventId, new Error("Nostr signaler closed"));
    if (!nostrInitializationSettled) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error("Nostr signaler closed"));
    }
    nostrSecret.fill(0);
    identity?.close();
    nostrListeners.clear();
    nostrBacklog.length = 0;
    nostrSeen.clear();
    nostrVerifying.clear();
    nostrStatus("closed");
  }
  signal?.addEventListener("abort", nostrClose, { once: true });
  for (const nostrUrl of nostrUrls) {
    if (nostrClosed) break;
    const nostrState = { url: nostrUrl, socket: null, ready: false, requested: false, failed: false, remove: [], timer: null };
    nostrStates.push(nostrState);
    nostrStatus("connecting", nostrUrl);
    if (nostrClosed) break;
    try {
      const nostrSocket = nostrState.socket = new WebSocketImpl(nostrUrl);
      if (nostrClosed) {
        try {
          nostrSocket.close();
        } catch {
        }
        break;
      }
      nostrState.timer = setTimeout(() => nostrFailRelay(nostrState, "Nostr connection/subscription timed out"), timeoutMs);
      const nostrOpen = () => {
        if (nostrClosed || nostrState.failed || nostrState.requested) return;
        nostrState.requested = true;
        try {
          nostrSocket.send(JSON.stringify(["REQ", nostrSubscription, { kinds: [20078], "#d": [nostrRoomTag], since: Math.floor(Date.now() / 1e3) - nostrFreshSeconds, limit: 0 }]));
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Nostr subscription failed");
        }
      };
      nostrState.remove.push(
        nostrListen(nostrSocket, "open", nostrOpen),
        nostrListen(nostrSocket, "message", (nostrEvent) => nostrHandleMessage(nostrState, nostrEvent.data)),
        nostrListen(nostrSocket, "error", () => nostrFailRelay(nostrState, "Nostr WebSocket error")),
        nostrListen(nostrSocket, "close", () => nostrFailRelay(nostrState, "Nostr relay disconnected"))
      );
      if (nostrSocket.readyState === 1) nostrOpen();
    } catch (nostrError) {
      nostrFailRelay(nostrState, nostrError?.message || "Nostr connection failed");
    }
  }
  try {
    await nostrReady;
  } catch (nostrError) {
    nostrClose();
    throw nostrError;
  }
  return {
    id: nostrId,
    room,
    get metrics() {
      return { ...verificationMetrics };
    },
    async send(nostrTo, nostrMessage) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (nostrTo !== "*" && (typeof nostrTo !== "string" || !nostrHex32.test(nostrTo))) throw new TypeError("Nostr recipient must be a lowercase public key or *");
      if (!nostrIsSignalMessage(nostrMessage)) throw new TypeError("Nostr carries discovery, presence, offer, answer, ice, bye and group signaling only");
      if (nostrSending >= 64) throw new Error("Too many pending Nostr publications");
      if (!nostrStates.some((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1)) throw new Error("No live Nostr relays");
      nostrSending++;
      const nostrPrevious = nostrSendTail;
      let nostrUnlock;
      nostrSendTail = new Promise((nostrResolve) => {
        nostrUnlock = nostrResolve;
      });
      try {
        let nostrContent;
        try {
          nostrContent = JSON.stringify({ v: 1, namespace, room, from: nostrId, to: nostrTo, nonce: nostrToHex(nostrRandom(16)), message: nostrMessage });
        } catch {
          throw new TypeError("Nostr signaling message must be JSON serializable");
        }
        if (nostrEncoder.encode(nostrContent).length > nostrContentLimit) throw new RangeError("Nostr signaling content exceeds 128 KiB");
        if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) throw new TypeError("Nostr signaling message serialization changed its type");
        await nostrPrevious;
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrWait = publishIntervalMs - (Date.now() - nostrLastPublication);
        if (nostrWait > 0) await new Promise((nostrResolve, nostrReject) => {
          const nostrTimer = setTimeout(() => {
            nostrWaiters.delete(nostrTimer);
            nostrResolve();
          }, nostrWait);
          nostrWaiters.set(nostrTimer, nostrReject);
        });
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrEvent = {
          pubkey: nostrId,
          created_at: Math.floor(Date.now() / 1e3),
          kind: 20078,
          tags: [["d", nostrRoomTag], ...nostrTo === "*" ? [] : [["p", nostrTo]]],
          content: nostrContent
        };
        const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrId, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrContent])), cryptoImpl);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAuxiliary = nostrRandom(32);
        try {
          nostrEvent.sig = nostrToHex(await (identity ? identity.sign(nostrHashBytes, nostrAuxiliary, cryptoImpl) : nostrSign(nostrHashBytes, nostrSecret, nostrAuxiliary, cryptoImpl)));
        } finally {
          nostrAuxiliary.fill(0);
        }
        nostrEvent.id = nostrToHex(nostrHashBytes);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAvailable = nostrStates.filter((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1);
        if (nostrAvailable.length === 0) throw new Error("No live Nostr relays");
        const nostrFrame = JSON.stringify(["EVENT", nostrEvent]);
        nostrLastPublication = Date.now();
        await new Promise((nostrResolve, nostrReject) => {
          const nostrPublication = {
            resolve: nostrResolve,
            reject: nostrReject,
            remaining: new Set(nostrAvailable),
            attempted: new Set(nostrAvailable),
            frame: nostrFrame,
            failures: [],
            timer: null
          };
          nostrPending.set(nostrEvent.id, nostrPublication);
          nostrPublication.timer = setTimeout(() => nostrFinishPublication(nostrEvent.id, new Error("Nostr publication timed out without a positive relay OK")), timeoutMs);
          for (const nostrState of nostrAvailable) {
            if (nostrClosed) break;
            try {
              nostrState.socket.send(nostrFrame);
            } catch (nostrError) {
              nostrFailRelay(nostrState, nostrError?.message || "Nostr publication failed");
            }
          }
        });
      } finally {
        await nostrPrevious;
        nostrSending--;
        nostrUnlock();
      }
    },
    subscribe(nostrHandler) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (typeof nostrHandler !== "function") throw new TypeError("Signaling subscriber must be a function");
      nostrListeners.add(nostrHandler);
      if (!nostrHasSubscriber) {
        nostrHasSubscriber = true;
        const nostrQueued = nostrBacklog.splice(0);
        for (const nostrEnvelope of nostrQueued) nostrDeliver(nostrEnvelope);
      }
      return () => nostrListeners.delete(nostrHandler);
    },
    close: nostrClose
  };
}

// packages/transport/src/room.js
async function createNostrRoom({
  role,
  room,
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 3e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role)) throw new TypeError("room role");
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof signalerFactory !== "function" || typeof peerFactory !== "function") throw new TypeError("room adapter factories");
  if (signal?.aborted) throw new Error("room aborted");
  if (!room && role === "host") {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    room = String(value[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", externalAbort, { once: true });
  const roomSignal = controller.signal;
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace,
      relays,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      signal: roomSignal
    });
  } catch (error2) {
    signal?.removeEventListener("abort", externalAbort);
    throw error2;
  }
  if (roomSignal.aborted) {
    signaler.close();
    signal?.removeEventListener("abort", externalAbort);
    throw new Error("room aborted");
  }
  return new Promise((resolve, reject) => {
    let connection, unsubscribe, pulse, deadline, collisionTimer;
    let disposed = false, connecting = false, completed = false, selectedPeer, checking = role === "host";
    const nonce = new Uint8Array(16);
    globalThis.crypto.getRandomValues(nonce);
    let sessionId = [...nonce].map((n) => n.toString(16).padStart(2, "0")).join("");
    const status = (value) => {
      try {
        onStatus(value);
      } catch {
      }
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(pulse);
      clearTimeout(deadline);
      clearTimeout(collisionTimer);
      unsubscribe?.();
      roomSignal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", externalAbort);
      controller.abort();
      connection?.close();
      signaler.close();
    };
    const fail = (error2) => {
      if (!completed) {
        completed = true;
        reject(error2);
      }
      close();
    };
    const abort = () => fail(new Error("room aborted"));
    roomSignal.addEventListener("abort", abort, { once: true });
    const send = (to, message) => signaler.send(to, message).catch(fail);
    const presence = (to) => send(to, { type: "presence", room, namespace, host: signaler.id, sessionId, protocol: PROTOCOL_VERSION });
    const connect = (remoteId) => {
      if (connecting || disposed) return;
      connecting = true;
      selectedPeer = remoteId;
      Promise.resolve().then(() => peerFactory({
        initiator: role === "join",
        signaler,
        remoteId,
        rtcConfig,
        timeoutMs: Math.min(timeoutMs, 2e4),
        onStatus,
        signal: roomSignal
      })).then((value) => {
        if (disposed) {
          value.close();
          return;
        }
        connection = value;
        completed = true;
        clearInterval(pulse);
        clearTimeout(deadline);
        clearTimeout(collisionTimer);
        unsubscribe?.();
        resolve({
          room,
          sessionId,
          localPlayerId: role === "host" ? "a" : "b",
          remotePlayerId: role === "host" ? "b" : "a",
          transport: value.transport,
          peerConnection: value.peerConnection,
          close
        });
      }).catch(fail);
    };
    unsubscribe = signaler.subscribe(({ from, to, message }) => {
      if (disposed || from === signaler.id) return;
      if (role === "host") {
        if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION) {
          fail(new Error("room code is already in use; choose another four-digit code"));
          return;
        }
        if (message.type === "discover" && !checking && (!selectedPeer || selectedPeer === from)) {
          connect(from);
          presence(from);
        }
      } else if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION && typeof message.sessionId === "string") {
        if (selectedPeer && selectedPeer !== from) return;
        selectedPeer = from;
        if (to === signaler.id) {
          sessionId = message.sessionId;
          connect(from);
        } else send(from, { type: "discover" });
      }
    });
    if (disposed) {
      unsubscribe?.();
      return;
    }
    deadline = setTimeout(() => fail(new Error("room discovery timeout")), timeoutMs);
    const advertise = () => {
      if (disposed || connecting || checking) return;
      if (role === "host") presence("*");
      else send(selectedPeer ?? "*", { type: "discover" });
    };
    pulse = setInterval(advertise, 1e3);
    status({ type: "room", room, role });
    if (disposed) return;
    if (checking) collisionTimer = setTimeout(() => {
      checking = false;
      advertise();
    }, 1200);
    else advertise();
  });
}

// packages/transport/src/star-transport.js
var starHeader = 24;
var starPayload = CHUNK_SIZE - starHeader;
var starMagic = 827544658;
function createStarTransports({
  players,
  localPlayerId,
  hostPlayerId,
  sessionId,
  physicalTransports,
  onError = () => {
  },
  maxQueuedBytes = 5 * 1024 * 1024
} = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8 || new Set(players).size !== players.length || !players.includes(localPlayerId) || !players.includes(hostPlayerId) || typeof sessionId !== "string" || !(physicalTransports instanceof Map) || typeof onError !== "function") throw new TypeError("star transport configuration");
  integer(maxQueuedBytes, "star queue budget", CHUNK_SIZE * 2, 64 * 1024 * 1024);
  const local = players.indexOf(localPlayerId), host = players.indexOf(hostPlayerId), isHost = local === host;
  const required = isHost ? players.filter((id) => id !== localPlayerId) : [hostPlayerId];
  if (required.some((id) => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) throw new TypeError("missing star physical transport");
  const tag = hashBytes(new TextEncoder().encode(sessionId)), listeners = /* @__PURE__ */ new Map(), statusListeners = /* @__PURE__ */ new Map();
  const queues = new Map(required.map((id) => [id, []])), assemblies = /* @__PURE__ */ new Map(), completed = /* @__PURE__ */ new Map();
  const unsubs = [], stats = { sentFrames: 0, forwardedFrames: 0, rejectedFrames: 0, queuedBytes: 0, queuedFrames: 0, assemblyBytes: 0 };
  let closed = false, sequence = 0, pumping = false;
  function reject() {
    stats.rejectedFrames++;
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const remove of unsubs.splice(0)) remove();
    queues.forEach((q) => q.length = 0);
    assemblies.clear();
    completed.clear();
    stats.queuedBytes = 0;
    stats.queuedFrames = 0;
    stats.assemblyBytes = 0;
    for (const set of statusListeners.values()) for (const fn of set) {
      try {
        fn("closed");
      } catch {
      }
    }
    listeners.clear();
    statusListeners.clear();
  }
  function fail(message) {
    if (closed) return;
    close();
    try {
      onError(new Error(message));
    } catch {
    }
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      const now = nowMs();
      for (const [id, q] of queues) {
        let work = 0;
        while (q.length && work++ < 128 && !closed) {
          if (now - q[0].at > 1e4) {
            fail("star forwarding backpressure timeout");
            break;
          }
          if (physicalTransports.get(id).send(q[0].bytes) === false) break;
          stats.queuedBytes -= q.shift().bytes.length;
          stats.queuedFrames--;
          stats.sentFrames++;
        }
      }
      for (const [key, a] of assemblies) if (now - a.at > 2e3) {
        assemblies.delete(key);
        stats.assemblyBytes -= a.total;
      }
    } catch (error2) {
      fail("star forwarding failed: " + error2.message);
    } finally {
      pumping = false;
    }
  }
  function enqueue(id, frames, forwarded) {
    const size = frames.reduce((n, b) => n + b.length, 0), q = queues.get(id);
    if (closed || !q || physicalTransports.get(id).state && physicalTransports.get(id).state !== "open") return false;
    if (stats.queuedBytes + size > maxQueuedBytes || stats.queuedFrames + frames.length > 4096) {
      if (forwarded) fail("star forwarding queue capacity");
      return false;
    }
    const at = nowMs();
    for (const b of frames) q.push({ bytes: b.slice(), at });
    stats.queuedBytes += size;
    stats.queuedFrames += frames.length;
    if (forwarded) stats.forwardedFrames += frames.length;
    pump();
    return !closed;
  }
  function deliver(from, id, payload, lane) {
    const actualLane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
    if (actualLane !== lane) {
      reject();
      return;
    }
    let seen = completed.get(from);
    if (!seen) completed.set(from, seen = /* @__PURE__ */ new Set());
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 256) seen.delete(seen.values().next().value);
    const target = listeners.get(players[from]);
    if (target?.size) for (const fn of target) fn(payload.slice());
  }
  function receive(physicalId, data) {
    if (closed) return;
    let b;
    try {
      b = bytes(data);
    } catch {
      reject();
      return;
    }
    if (b.length < starHeader || b.length > CHUNK_SIZE) {
      reject();
      return;
    }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), from = b[6], to = b[7], lane = b[5];
    const id = v.getUint32(12, true), total = v.getUint16(16, true), offset = v.getUint16(18, true), length = v.getUint16(20, true);
    if (v.getUint32(0, true) !== starMagic || b[4] !== 1 || v.getUint32(8, true) !== tag || v.getUint16(22, true) !== 0 || ![1, TYPE.INPUT, TYPE.CLOCK].includes(lane) || from >= players.length || to >= players.length || from === to || from === local || !id || !total || total > CHUNK_SIZE || ![0, starPayload].includes(offset) || offset >= total || length !== Math.min(starPayload, total - offset) || b.length !== starHeader + length || (isHost ? players[from] !== physicalId : physicalId !== hostPlayerId || to !== local)) {
      reject();
      return;
    }
    if (to !== local) {
      if (!isHost || !enqueue(players[to], [b], true)) {
        if (!closed) fail("star destination is not available");
      }
      return;
    }
    if (completed.get(from)?.has(id)) return;
    if (total <= starPayload) {
      deliver(from, id, b.slice(starHeader), lane);
      return;
    }
    const key = from + ":" + id;
    let a = assemblies.get(key);
    if (!a) {
      if (assemblies.size >= 32 || stats.assemblyBytes + total > 512 * 1024) {
        reject();
        return;
      }
      a = { total, lane, bytes: new Uint8Array(total), seen: /* @__PURE__ */ new Set(), at: nowMs() };
      assemblies.set(key, a);
      stats.assemblyBytes += total;
    }
    if (a.total !== total || a.lane !== lane) {
      reject();
      return;
    }
    if (a.seen.has(offset)) {
      for (let i = 0; i < length; i++) if (a.bytes[offset + i] !== b[starHeader + i]) {
        reject();
        return;
      }
      return;
    }
    a.bytes.set(b.subarray(starHeader), offset);
    a.seen.add(offset);
    if (a.seen.size === 2) {
      assemblies.delete(key);
      stats.assemblyBytes -= total;
      deliver(from, id, a.bytes, lane);
    }
  }
  const timer = setInterval(pump, 16);
  timer.unref?.();
  const transports = /* @__PURE__ */ new Map();
  for (const remote of players.filter((id) => id !== localPlayerId)) {
    listeners.set(remote, /* @__PURE__ */ new Set());
    statusListeners.set(remote, /* @__PURE__ */ new Set());
    const physical = isHost ? remote : hostPlayerId;
    transports.set(remote, {
      get state() {
        return closed ? "closed" : physicalTransports.get(physical).state ?? "open";
      },
      send(data) {
        if (closed) return false;
        const payload = bytes(data);
        if (!payload.length || payload.length > CHUNK_SIZE) throw new RangeError("star packet size");
        sequence = sequence + 1 >>> 0 || 1;
        const id = sequence, frames = [];
        const lane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
        for (let offset = 0; offset < payload.length; offset += starPayload) {
          const length = Math.min(starPayload, payload.length - offset), b = new Uint8Array(starHeader + length), v = new DataView(b.buffer);
          v.setUint32(0, starMagic, true);
          b[4] = 1;
          b[5] = lane;
          b[6] = local;
          b[7] = players.indexOf(remote);
          v.setUint32(8, tag, true);
          v.setUint32(12, id, true);
          v.setUint16(16, payload.length, true);
          v.setUint16(18, offset, true);
          v.setUint16(20, length, true);
          b.set(payload.subarray(offset, offset + length), starHeader);
          frames.push(b);
        }
        return enqueue(physical, frames, false);
      },
      subscribe(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star subscriber");
        const set = listeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      subscribeStatus(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star status subscriber");
        const set = statusListeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      close() {
        listeners.get(remote)?.clear();
        statusListeners.get(remote)?.clear();
      }
    });
  }
  try {
    for (const id of required) {
      const raw = physicalTransports.get(id);
      unsubs.push(raw.subscribe((data) => receive(id, data)));
      if (raw.subscribeStatus) unsubs.push(raw.subscribeStatus((state) => {
        for (const [remote, set] of statusListeners) if (!isHost || remote === id) for (const fn of set) {
          try {
            fn(state);
          } catch {
          }
        }
      }));
    }
  } catch (error2) {
    close();
    throw error2;
  }
  return { transports, close, get metrics() {
    return { ...stats };
  } };
}

// packages/transport/src/group-room.js
function groupRoomId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
async function createNostrGroupRoom({
  role,
  room,
  playerCount = 2,
  topology = "mesh",
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 6e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role) || !["mesh", "star"].includes(topology)) throw new TypeError("group room role/topology");
  integer(playerCount, "playerCount", 2, 8);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || new TextEncoder().encode(namespace + ":group-v1").length > 128) throw new TypeError("group namespace");
  if ([onStatus, signalerFactory, peerFactory].some((fn) => typeof fn !== "function")) throw new TypeError("group room capability");
  if (signal?.aborted) throw new Error("group room aborted");
  const random = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (!room && role === "host") room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const peerController = new AbortController(), signalController = new AbortController(), startedAt = nowMs();
  const earlyAbort = () => {
    peerController.abort();
    signalController.abort();
  };
  signal?.addEventListener("abort", earlyAbort, { once: true });
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace: namespace + ":group-v1",
      relays,
      signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: Math.max(16, playerCount * 4),
      verificationBurst: playerCount * 4
    });
    if (!groupRoomId(signaler?.id) || typeof signaler.send !== "function" || typeof signaler.subscribe !== "function" || typeof signaler.close !== "function") throw new TypeError("group signaler capability");
    if (signal?.aborted || signalController.signal.aborted) throw new Error("group room aborted");
  } catch (error2) {
    earlyAbort();
    signaler?.close?.();
    signal?.removeEventListener("abort", earlyAbort);
    throw error2;
  }
  signal?.removeEventListener("abort", earlyAbort);
  return new Promise((resolve, reject) => {
    const self = signaler.id, members = /* @__PURE__ */ new Set([self]), departed = /* @__PURE__ */ new Set(), acks = /* @__PURE__ */ new Set([self]), ready = /* @__PURE__ */ new Set(), starts = /* @__PURE__ */ new Set([self]);
    const peers = /* @__PURE__ */ new Map(), subscribers = /* @__PURE__ */ new Map(), backlog = /* @__PURE__ */ new Map(), controlPending = /* @__PURE__ */ new Map(), removers = [];
    let host = role === "host" ? self : null, sessionId = role === "host" ? random() : null, roster3 = null, rosterKey = "";
    let phase = role === "host" ? "checking" : "discovering", disposed = false, settled = false, connecting = false, localReady = false;
    let unsubscribe, interval, collisionTimer, deadline, router, backlogBytes = 0, startPublished = false;
    const status = (type, detail = {}) => {
      try {
        onStatus({ type, room, role, playerCount, topology, phase, ...detail });
      } catch {
      }
    };
    function message(op, extra = {}) {
      return { type: "group", version: 1, protocol: PROTOCOL_VERSION, op, host, sessionId, playerCount, topology, ...extra };
    }
    function dispose(reason, notify = true) {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      clearTimeout(collisionTimer);
      clearTimeout(deadline);
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      peerController.abort();
      removers.splice(0).forEach((fn) => fn());
      router?.close();
      peers.forEach((p) => p.close());
      peers.clear();
      subscribers.clear();
      backlog.clear();
      backlogBytes = 0;
      const finish2 = () => {
        signalController.abort();
        signaler.close();
      };
      if (notify && host && sessionId) {
        const grace = setTimeout(finish2, 1500);
        grace.unref?.();
        Promise.resolve().then(() => signaler.send(role === "host" ? "*" : host, message("leave", { reason }))).catch(() => {
        }).finally(() => {
          clearTimeout(grace);
          finish2();
        });
      } else finish2();
    }
    function fail(error2, notify = true) {
      if (disposed) return;
      const value = error2 instanceof Error ? error2 : new Error(String(error2));
      const former = phase;
      phase = "failed";
      dispose(value.message, notify);
      status("group-failed", { reason: value.message, previousPhase: former });
      if (!settled) {
        settled = true;
        reject(value);
      }
    }
    function abort() {
      fail(new Error("group room aborted"));
    }
    function send(to, op, extra = {}) {
      if (disposed) return Promise.resolve();
      const key = to + ":" + op;
      if (controlPending.has(key)) return controlPending.get(key);
      if (controlPending.size >= 32) return Promise.resolve();
      const pending = Promise.resolve().then(() => {
        if (!disposed) return signaler.send(to, message(op, extra));
      }).catch((error2) => {
        fail(error2);
      }).finally(() => controlPending.delete(key));
      controlPending.set(key, pending);
      return pending;
    }
    function close() {
      if (disposed) return;
      const pending = !settled;
      phase = "closed";
      dispose("room closed");
      status("group-closed");
      if (pending) {
        settled = true;
        reject(new Error("group room closed"));
      }
    }
    function finish() {
      if (disposed || settled || !localReady) return;
      settled = true;
      phase = "running";
      clearTimeout(deadline);
      clearInterval(interval);
      const physical = new Map([...peers].map(([id, peer]) => [id, peer.transport]));
      status("group-started", { players: [...roster3], localPlayerId: self });
      if (disposed) {
        reject(new Error("group room closed by observer"));
        return;
      }
      resolve({
        room,
        sessionId,
        playerCount,
        topology,
        players: Object.freeze([...roster3]),
        localPlayerId: self,
        authorityPlayerId: host,
        hostPlayerId: host,
        transports: new Map(router?.transports ?? physical),
        peerConnections: new Map([...peers].map(([id, peer]) => [id, peer.peerConnection])),
        get closed() {
          return disposed;
        },
        get metrics() {
          return router?.metrics ?? null;
        },
        close
      });
    }
    function hostProgress() {
      if (disposed || role !== "host" || !roster3) return;
      if (phase === "roster" && acks.size === playerCount) {
        phase = "connecting";
        connect();
        send("*", "connect", { rosterKey });
      }
      if (phase === "connecting" && ready.size === playerCount) {
        phase = "starting";
        send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      }
      if (phase === "starting" && startPublished && starts.size === playerCount) finish();
    }
    function wantedPeers() {
      return roster3.filter((id) => id !== self && (topology === "mesh" || self === host || id === host));
    }
    function scopedSignaler(remote) {
      return {
        id: self,
        send(to, payload) {
          if (disposed || to !== remote) return Promise.reject(new Error("group peer scope"));
          return signaler.send(to, { ...payload, groupSession: sessionId });
        },
        subscribe(fn) {
          const set = subscribers.get(remote) ?? /* @__PURE__ */ new Set();
          subscribers.set(remote, set);
          set.add(fn);
          const queued = backlog.get(remote) ?? [];
          backlog.delete(remote);
          for (const item of queued) {
            backlogBytes -= item.size;
            if (!disposed) fn(item.envelope);
          }
          return () => set.delete(fn);
        },
        close() {
        }
      };
    }
    function connect() {
      if (disposed || connecting || !roster3) return;
      connecting = true;
      phase = "connecting";
      status("group-connecting", { players: [...roster3] });
      if (disposed) return;
      Promise.all(wantedPeers().map((remote) => Promise.resolve().then(() => {
        if (disposed) throw new Error("group room closed");
        return peerFactory({
          initiator: compareIds(self, remote) > 0,
          signaler: scopedSignaler(remote),
          remoteId: remote,
          rtcConfig,
          timeoutMs: Math.min(timeoutMs, 3e4),
          onStatus: (event) => status("group-peer", { peerId: remote, event }),
          signal: peerController.signal
        });
      }).then((peer) => {
        if (disposed) {
          peer.close();
          return;
        }
        if (!peer?.transport?.send || !peer.transport.subscribe || typeof peer.close !== "function") throw new TypeError("group peer capability");
        peers.set(remote, peer);
        if (peer.transport.subscribeStatus) removers.push(peer.transport.subscribeStatus((state) => {
          if (!disposed && (state === "closed" || state === "failed" || !settled && state === "interrupted")) fail(new Error("group peer unavailable: " + remote));
        }));
      }))).then(() => {
        if (disposed) return;
        if ([...peers.values()].some((p) => p.transport.state && p.transport.state !== "open")) throw new Error("group transport not open");
        if (topology === "star") router = createStarTransports({
          players: roster3,
          localPlayerId: self,
          hostPlayerId: host,
          sessionId,
          physicalTransports: new Map([...peers].map(([id, p]) => [id, p.transport])),
          onError: fail
        });
        localReady = true;
        status("group-ready", { players: [...roster3] });
        if (disposed) return;
        if (role === "host") {
          ready.add(self);
          hostProgress();
        } else send(host, "ready", { rosterKey });
      }).catch(fail);
    }
    function publishRoster() {
      send("*", "roster", { players: roster3, rosterKey });
    }
    function advertise(to = "*") {
      send(to, "hello", { accepting: phase === "collecting", memberCount: members.size });
    }
    function acceptRoster(from, m) {
      if (from !== host || !Array.isArray(m.players) || m.players.length !== playerCount || m.players.some((id) => !groupRoomId(id)) || new Set(m.players).size !== playerCount || !m.players.includes(self) || !m.players.includes(host) || m.players.join("\n") !== [...m.players].sort(compareIds).join("\n") || m.rosterKey !== m.players.join("\n")) {
        fail(new Error("invalid group roster"));
        return;
      }
      if (roster3 && rosterKey !== m.rosterKey) {
        fail(new Error("group roster changed"));
        return;
      }
      if (!roster3) {
        roster3 = Object.freeze([...m.players]);
        rosterKey = m.rosterKey;
        phase = "roster";
        status("group-roster", { players: [...roster3] });
      }
      send(host, "ack", { rosterKey });
    }
    function receive(envelope) {
      if (disposed || !envelope || envelope.from === self || !groupRoomId(envelope.from) || !["*", self].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") return;
      const { from, to, message: m } = envelope;
      if (["offer", "answer", "ice", "bye"].includes(m.type)) {
        if (!roster3 || to !== self || m.groupSession !== sessionId || !wantedPeers().includes(from)) return;
        const set = subscribers.get(from);
        if (set?.size) {
          for (const fn of set) fn(envelope);
          return;
        }
        const size = encoder.encode(JSON.stringify(m)).length, queued = backlog.get(from) ?? [];
        if (queued.length >= 32 || backlogBytes + size > 2 * 1024 * 1024) {
          fail(new Error("group signaling backlog capacity"));
          return;
        }
        queued.push({ envelope, size });
        backlog.set(from, queued);
        backlogBytes += size;
        return;
      }
      if (m.type !== "group" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
      if (role === "host" && m.op === "hello" && m.host === from) {
        if (["checking", "collecting"].includes(phase)) fail(new Error("room code is already in use"));
        else if (m.accepting !== false) advertise(from);
        return;
      }
      if (role === "join" && m.op === "hello" && m.host === from && groupRoomId(m.sessionId)) {
        if (host && (host !== from || sessionId !== m.sessionId)) return;
        if (m.playerCount !== playerCount || m.topology !== topology) {
          fail(new Error("group playerCount/topology mismatch"), false);
          return;
        }
        const selected = !!host;
        if (!host) {
          host = from;
          sessionId = m.sessionId;
        }
        if (!roster3) {
          if (m.accepting === false && !selected) {
            fail(new Error("group room is full or already started"), false);
            return;
          }
          send(host, "join");
        }
        return;
      }
      if (role === "host" && m.op === "discover") {
        if (phase !== "checking") advertise(from);
        return;
      }
      if (m.host !== host || m.sessionId !== sessionId || m.playerCount !== playerCount || m.topology !== topology) return;
      if (role === "host") {
        if (m.op === "join") {
          if (members.has(from)) {
            if (roster3) publishRoster();
            return;
          }
          if (phase !== "collecting" || departed.has(from)) {
            send(from, "reject", { reason: "group room is full or already started" });
            return;
          }
          members.add(from);
          status("group-members", { players: [...members].sort(compareIds) });
          if (disposed) return;
          if (members.size === playerCount) {
            roster3 = Object.freeze([...members].sort(compareIds));
            rosterKey = roster3.join("\n");
            phase = "roster";
            status("group-roster", { players: [...roster3] });
            publishRoster();
          }
        } else if (m.op === "leave" && members.has(from)) {
          if (phase === "collecting") {
            members.delete(from);
            departed.add(from);
            if (departed.size > 64) fail(new Error("group membership churn limit"));
            else status("group-members", { players: [...members].sort(compareIds) });
          } else fail(new Error("group participant left"));
        } else if (roster3?.includes(from) && m.rosterKey === rosterKey) {
          if (m.op === "ack") acks.add(from);
          if (m.op === "ready" && ["connecting", "starting"].includes(phase)) ready.add(from);
          if (m.op === "start-ack" && phase === "starting") starts.add(from);
          hostProgress();
        }
      } else if (from === host) {
        if (m.op === "reject") fail(new Error(String(m.reason || "group rejected")), false);
        else if (m.op === "leave") fail(new Error("group host left"), false);
        else if (m.op === "roster") acceptRoster(from, m);
        else if (roster3 && m.rosterKey === rosterKey) {
          if (m.op === "connect") {
            connect();
            if (localReady) send(host, "ready", { rosterKey });
          }
          if (m.op === "start" && localReady) send(host, "start-ack", { rosterKey }).then(finish);
        }
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    unsubscribe = signaler.subscribe(receive);
    if (disposed) {
      unsubscribe?.();
      return;
    }
    const remaining = timeoutMs - (nowMs() - startedAt);
    if (remaining <= 0) {
      fail(new Error("group room timeout"));
      return;
    }
    deadline = setTimeout(() => fail(new Error("group room timeout: " + phase)), remaining);
    interval = setInterval(() => {
      if (disposed) return;
      if (role === "host") {
        if (phase === "collecting") advertise();
        else if (phase === "roster") publishRoster();
        else if (phase === "connecting") send("*", "connect", { rosterKey });
        else if (phase === "starting") send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      } else if (!host) send("*", "discover");
      else if (!roster3) send(host, "join");
      else if (!connecting) send(host, "ack", { rosterKey });
      else if (localReady) send(host, "ready", { rosterKey });
    }, 1e3);
    status("room");
    if (disposed) return;
    if (role === "host") collisionTimer = setTimeout(() => {
      if (!disposed) {
        phase = "collecting";
        advertise();
      }
    }, 1200);
    else send("*", "discover");
  });
}

// packages/transport/src/room-resume-identity.js
var hex32 = /^[0-9a-f]{64}$/;
function createRoomResumeIdentity({ storage, key, lifetimeMs = 8 * 60 * 60 * 1e3, reset = false } = {}, { namespace, room }) {
  if (!storage || ["getItem", "setItem", "removeItem"].some((name) => typeof storage[name] !== "function")) throw new TypeError("resume storage capability");
  integer(lifetimeMs, "resume lifetimeMs", 1e3, 24 * 60 * 60 * 1e3);
  key ??= `bloom-gamekit:dynamic-v1:${namespace}:${room}`;
  if (typeof key !== "string" || !key.length || key.length > 512) throw new TypeError("resume storage key");
  if (typeof reset !== "boolean") throw new TypeError("resume reset");
  if (reset) storage.removeItem(key);
  let saved, secret, forgotten = false, closed = false;
  const raw = storage.getItem(key), now = Date.now();
  if (raw != null) {
    let expired = false;
    try {
      if (typeof raw !== "string" || raw.length > 8192) throw new Error("invalid record");
      saved = JSON.parse(raw);
      expired = Number.isSafeInteger(saved?.expiresAt) && saved.expiresAt <= now;
      if (saved.version !== 1 || saved.namespace !== namespace || saved.room !== room || !hex32.test(saved.secret) || !Number.isSafeInteger(saved.createdAt) || !Number.isSafeInteger(saved.expiresAt) || saved.createdAt > now || saved.expiresAt <= now || saved.expiresAt - saved.createdAt > 24 * 60 * 60 * 1e3 || saved.sessionId !== null && (typeof saved.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(saved.sessionId)) || !Array.isArray(saved.players) || saved.players.length > 5 || saved.players.some((id2) => !hex32.test(id2)) || new Set(saved.players).size !== saved.players.length || !Number.isSafeInteger(saved.epoch) || saved.epoch < 0 || saved.epoch > 65534 || saved.coordinatorId !== null && !saved.players.includes(saved.coordinatorId)) throw new Error("invalid record");
      secret = nostrFromHex(saved.secret);
      const scalar = nostrBytesToNumber(secret);
      if (scalar <= 0n || scalar >= nostrOrder || nostrToHex(nostrPublicKey(secret)) !== saved.id) throw new Error("invalid key");
    } catch {
      secret?.fill(0);
      throw new Error(expired ? "resume record expired; explicitly reset for a fresh room" : "invalid resume record; explicitly reset for a fresh room");
    }
  }
  if (!secret) {
    secret = new Uint8Array(32);
    let valid = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      globalThis.crypto.getRandomValues(secret);
      const value = nostrBytesToNumber(secret);
      if (value > 0n && value < nostrOrder) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      secret.fill(0);
      throw new Error("resume identity generation failed");
    }
  }
  const id = nostrToHex(nostrPublicKey(secret));
  let record = saved ?? {
    version: 1,
    namespace,
    room,
    id,
    secret: nostrToHex(secret),
    createdAt: now,
    expiresAt: now + lifetimeMs,
    sessionId: null,
    coordinatorId: null,
    epoch: 0,
    players: []
  };
  const metadata = saved ? { sessionId: saved.sessionId, coordinatorId: saved.coordinatorId, epoch: saved.epoch, players: [...saved.players] } : null;
  function write() {
    if (forgotten || closed) return;
    try {
      storage.setItem(key, JSON.stringify(record));
    } catch {
      secret.fill(0);
      closed = true;
      throw new Error("resume storage unavailable");
    }
  }
  write();
  return {
    metadata,
    identity: {
      id,
      sign(hash, auxiliary, cryptoImpl) {
        if (closed) throw new Error("resume identity closed");
        return nostrSign(hash, secret, auxiliary, cryptoImpl);
      },
      close() {
        if (closed) return;
        closed = true;
        secret.fill(0);
        record = null;
      }
    },
    update(value) {
      if (!forgotten && !closed) {
        record = { ...record, ...value, players: [...value.players] };
        write();
      }
    },
    forget() {
      storage.removeItem(key);
      forgotten = true;
    }
  };
}

// packages/transport/src/dynamic-room.js
var validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var signalTypes = /* @__PURE__ */ new Set(["offer", "answer", "ice", "bye"]);
var PROBE_MAGIC = new Uint8Array([66, 77, 68, 89, 78, 80, 82, 49]);
var MAX_SIGNAL_BYTES = 128 * 1024;
var MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
var randomId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
function roster2(value, maxPlayers) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPlayers || value.some((id) => !validId(id)) || new Set(value).size !== value.length) throw new TypeError("dynamic room players");
  return Object.freeze([...value].sort(compareIds));
}
async function createNostrDynamicRoom({
  role,
  room,
  namespace = "rollback-netcode",
  maxPlayers = 5,
  maxPendingPeers = 5,
  timeoutMs = 6e4,
  peerTimeoutMs = 2e4,
  retryMs = 1500,
  advertiseIntervalMs = 5e3,
  resume,
  resumeProbeMs = 1500,
  relays,
  rtcConfig,
  signal,
  onStatus = () => {
  },
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer,
  expectedSessionId,
  authorizeJoin = () => true
} = {}) {
  if (!["host", "join"].includes(role)) throw new TypeError("dynamic room role");
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(maxPendingPeers, "maxPendingPeers", 1, 5);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  integer(peerTimeoutMs, "peerTimeoutMs", 1, 12e4);
  integer(resumeProbeMs, "resumeProbeMs", 10, 1e4);
  integer(retryMs, "retryMs", 10, 1e4);
  integer(advertiseIntervalMs, "advertiseIntervalMs", 10, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || encoder.encode(namespace + ":dynamic-v1").length > 128) throw new TypeError("dynamic room namespace");
  if (expectedSessionId !== void 0 && (!validId(expectedSessionId) || expectedSessionId.length > 116)) throw new TypeError("expectedSessionId");
  if ([onStatus, signalerFactory, peerFactory, authorizeJoin].some((fn) => typeof fn !== "function")) throw new TypeError("dynamic room capability");
  if (signal?.aborted) throw new Error("dynamic room aborted");
  if (!room && role === "host") room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const resumeIdentity = resume ? createRoomResumeIdentity(resume, { namespace, room }) : null;
  const startedAt = nowMs(), signalController = new AbortController();
  let initializationReject;
  const initializationFailure = new Promise((resolve, reject) => {
    initializationReject = reject;
  });
  const initializationTimer = setTimeout(() => {
    signalController.abort();
    initializationReject(new Error("dynamic room signaling timeout"));
  }, timeoutMs);
  const earlyAbort = () => {
    signalController.abort();
    initializationReject(new Error("dynamic room aborted"));
  };
  signal?.addEventListener("abort", earlyAbort, { once: true });
  let signaler;
  try {
    const setup = Promise.resolve().then(() => signalerFactory({
      room,
      namespace: namespace + ":dynamic-v1",
      relays,
      signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: 32,
      verificationBurst: 20,
      identity: resumeIdentity?.identity
    })).then((value) => {
      if (signalController.signal.aborted) value?.close?.();
      return value;
    });
    signaler = await Promise.race([setup, initializationFailure]);
    if (!validId(signaler?.id) || ["send", "subscribe", "close"].some((key) => typeof signaler?.[key] !== "function")) throw new TypeError("dynamic signaler capability");
    if (signal?.aborted || signalController.signal.aborted) throw new Error("dynamic room aborted");
  } catch (error2) {
    signalController.abort();
    signaler?.close?.();
    resumeIdentity?.identity.close();
    throw error2;
  } finally {
    clearTimeout(initializationTimer);
    signal?.removeEventListener("abort", earlyAbort);
  }
  if (resumeIdentity && signaler.id !== resumeIdentity.identity.id) {
    signaler.close();
    resumeIdentity.identity.close();
    throw new Error("resume signaler identity mismatch");
  }
  const self = signaler.id, incarnation = randomId(), transports = /* @__PURE__ */ new Map(), peerConnections = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Set();
  const links = /* @__PURE__ */ new Map(), generations = /* @__PURE__ */ new Map(), candidates = /* @__PURE__ */ new Map(), backlog = /* @__PURE__ */ new Map(), publications = /* @__PURE__ */ new Map();
  const saved = resumeIdentity?.metadata, resumed = !!(saved?.sessionId && saved.players.includes(self));
  if (saved?.sessionId && expectedSessionId !== void 0 && expectedSessionId !== saved.sessionId) {
    signaler.close();
    resumeIdentity.identity.close();
    throw new Error("resume session does not match expectedSessionId; explicitly reset");
  }
  const resumeTargets = new Set(resumed ? saved.players : []);
  const establishing = role === "join" || resumed, incarnations = /* @__PURE__ */ new Map([[self, incarnation]]), resumeApproved = /* @__PURE__ */ new Set(), resumeChecks = /* @__PURE__ */ new Map();
  let resumePeerId = null;
  let players = Object.freeze(resumed ? [...saved.players] : role === "host" ? [self] : []);
  let coordinatorId = resumed ? saved.coordinatorId : role === "host" ? self : null;
  let sessionId = resumed ? saved.sessionId : role === "host" ? randomId() : null;
  let epoch = resumed ? saved.epoch : 0, meshPlayers = new Set(players), meshUntil = resumed ? Infinity : 0;
  let hasBeenAdmitted = players.includes(self);
  let disposed = false, settled = false, backlogBytes = 0, unsubscribe, interval, deadline, invitation, nextAdvertisement = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const status = (type, detail = {}) => {
    const event = { type, room, role, ...detail };
    try {
      onStatus(event);
    } catch {
    }
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch {
      }
    }
  };
  const pendingCount = () => [...links.values()].filter((link) => !link.peer).length;
  const accepted = (id) => players.includes(id) || meshPlayers.has(id) && meshUntil > nowMs() || candidates.has(id);
  const leader = (id) => compareIds(self, id) > 0;
  const control = (op, extra = {}) => ({
    type: "group",
    mode: "dynamic",
    version: 1,
    protocol: PROTOCOL_VERSION,
    op,
    sessionId,
    coordinatorId,
    epoch,
    incarnation,
    ...extra
  });
  function publish(to, payload, key = to + ":" + payload.op) {
    if (disposed) return Promise.reject(new Error("dynamic room closed"));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= 32) return Promise.reject(new Error("dynamic signaling publication capacity"));
    const promise = Promise.resolve().then(() => {
      if (disposed) throw new Error("dynamic room closed");
      return signaler.send(to, payload);
    }).finally(() => {
      if (publications.get(key) === promise) publications.delete(key);
    });
    publications.set(key, promise);
    return promise;
  }
  function send(to, op, extra = {}) {
    const promise = publish(to, control(op, { targetIncarnation: incarnations.get(to), ...extra }));
    promise.catch((error2) => {
      if (!disposed) status("signal-error", { peerId: to, reason: error2.message });
    });
    return promise;
  }
  function forgetBacklog(key) {
    const queued = backlog.get(key);
    if (!queued) return;
    for (const item of queued.items) backlogBytes -= item.size;
    backlog.delete(key);
  }
  function rememberGeneration(id, generation) {
    generations.delete(id);
    generations.set(id, generation);
    for (const old of generations.keys()) {
      if (generations.size <= 64) break;
      if (!links.has(old) && !accepted(old)) generations.delete(old);
    }
  }
  function destroyLink(link, reason, notify = true, preserveWaiter = false) {
    if (links.get(link.id) !== link) return;
    links.delete(link.id);
    clearTimeout(link.deadline);
    link.removeStatus?.();
    link.removeRaw?.();
    link.cancelProbe?.();
    link.controller.abort();
    const wasConnected = transports.delete(link.id);
    peerConnections.delete(link.id);
    link.peer?.close();
    link.subscribers.clear();
    link.outbound.clear();
    if (!preserveWaiter) link.reject(new Error(reason));
    if (wasConnected && notify && !disposed) status("peer-disconnected", { peerId: link.id, reason });
  }
  function finish() {
    if (disposed || settled) return;
    settled = true;
    clearTimeout(deadline);
    readyResolve(capability);
  }
  function close(reason = "dynamic room closed") {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    clearTimeout(deadline);
    unsubscribe?.();
    signal?.removeEventListener("abort", abort);
    for (const link of [...links.values()]) destroyLink(link, reason, false);
    signalController.abort();
    signaler.close();
    resumeIdentity?.identity.close();
    backlog.clear();
    backlogBytes = 0;
    candidates.clear();
    publications.clear();
    if (!settled) {
      settled = true;
      readyReject(new Error(reason));
    }
    status("room-closed", { reason });
    listeners.clear();
  }
  function abort() {
    close("dynamic room aborted");
  }
  function failLink(link, error2) {
    if (disposed || links.get(link.id) !== link) return;
    destroyLink(link, error2.message || String(error2));
    status("peer-failed", { peerId: link.id, reason: error2.message || String(error2) });
  }
  function newLink(id, generation, connectionId, prior) {
    if (!prior && (pendingCount() >= maxPendingPeers || links.size >= maxPlayers - 1 + maxPendingPeers)) throw new Error("dynamic pending peer capacity");
    let resolve, reject, promise;
    if (prior && !prior.peer) ({ resolve, reject, promise } = prior);
    else {
      promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {
      });
    }
    if (prior) destroyLink(prior, "peer reconnecting", true, !prior.peer);
    const link = {
      id,
      generation,
      connectionId,
      resolve,
      reject,
      promise,
      controller: new AbortController(),
      peer: null,
      started: false,
      subscribers: /* @__PURE__ */ new Set(),
      outbound: /* @__PURE__ */ new Map(),
      nextRetry: 0,
      requestGeneration: generations.get(id) ?? 0,
      force: false
    };
    links.set(id, link);
    link.deadline = setTimeout(() => failLink(link, new Error("dynamic peer timeout")), peerTimeoutMs);
    return link;
  }
  function scopedSignaler(link) {
    return {
      id: self,
      close() {
      },
      send(to, payload) {
        if (disposed || links.get(link.id) !== link || to !== link.id || !signalTypes.has(payload?.type)) return Promise.reject(new Error("dynamic peer scope"));
        const message = { ...payload, dynamicSession: sessionId, dynamicGeneration: link.generation, dynamicConnection: link.connectionId, dynamicFrom: incarnation, dynamicTo: incarnations.get(to) };
        if (encoder.encode(JSON.stringify(message)).length > MAX_SIGNAL_BYTES) return Promise.reject(new RangeError("dynamic signaling message capacity"));
        if (payload.type === "offer" || payload.type === "answer") link.outbound.set(payload.type, message);
        return Promise.resolve(link.announcement).then(() => {
          if (disposed || links.get(link.id) !== link) throw new Error("dynamic peer scope");
          return publish(to, message, `${to}:signal:${link.generation}:${payload.type}`);
        });
      },
      subscribe(fn) {
        if (typeof fn !== "function") throw new TypeError("dynamic signaling subscriber");
        link.subscribers.add(fn);
        const key = `${link.id}:${link.generation}:${link.connectionId}`, queued = backlog.get(key);
        if (queued) {
          const items = queued.items.slice();
          forgetBacklog(key);
          for (const item of items) if (!disposed) fn(item.envelope);
        }
        return () => link.subscribers.delete(fn);
      }
    };
  }
  function saveResume() {
    if (!resumeIdentity || !sessionId) return;
    if (hasBeenAdmitted && !players.includes(self)) {
      resumeIdentity.forget();
      return;
    }
    if (players.includes(self)) hasBeenAdmitted = true;
    resumeIdentity.update({ sessionId, coordinatorId, epoch, players });
  }
  function acceptIncarnations(value, next) {
    if (!value || typeof value !== "object") return;
    for (const id of next) if (id !== self && validId(value[id])) {
      if (!links.get(id)?.peer || !incarnations.has(id)) incarnations.set(id, value[id]);
    }
  }
  function wrapTransport(link, raw) {
    const handlers = /* @__PURE__ */ new Set();
    link.removeRaw = raw.subscribe((bytes2) => {
      if (bytes2.length === 25 && PROBE_MAGIC.every((value, i) => bytes2[i] === value)) {
        if (bytes2[8] === 1) {
          const reply = bytes2.slice();
          reply[8] = 2;
          raw.send(reply);
        } else if (bytes2[8] === 2) link.onPong?.(bytes2.subarray(9));
        return;
      }
      for (const fn of [...handlers]) fn(bytes2);
    });
    return {
      get state() {
        return raw.state;
      },
      get bufferedAmount() {
        return raw.bufferedAmount ?? 0;
      },
      send: (data) => raw.send(data),
      close: () => link.peer.close(),
      subscribe(fn) {
        if (typeof fn !== "function") throw new TypeError("dynamic transport subscriber");
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
      subscribeStatus: (fn) => raw.subscribeStatus?.(fn) ?? (() => {
      })
    };
  }
  function probePeer(link) {
    if (!link?.peer || link.peer.transport.state && link.peer.transport.state !== "open") return Promise.resolve(false);
    return new Promise((resolve) => {
      const bytes2 = new Uint8Array(25);
      bytes2.set(PROBE_MAGIC);
      bytes2[8] = 1;
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes2.set(nonce, 9);
      let done = false, timer;
      const finish2 = (alive) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        link.onPong = null;
        link.cancelProbe = null;
        resolve(alive);
      };
      link.onPong = (response) => {
        if (nonce.every((value, i) => response[i] === value)) finish2(true);
      };
      link.cancelProbe = () => finish2(false);
      timer = setTimeout(() => finish2(false), resumeProbeMs);
      if (!link.peer.transport.send(bytes2)) finish2(true);
    });
  }
  function approveResume(id, requestedIncarnation) {
    if (incarnations.get(id) === requestedIncarnation) {
      send(id, "resume-accept", { generation: links.get(id)?.connectionId ? links.get(id).generation : (generations.get(id) ?? 0) + 1 });
      return;
    }
    if (resumeChecks.has(id)) return;
    const existing = links.get(id);
    const check = probePeer(existing).then((alive) => {
      if (disposed) return;
      if (alive) {
        send(id, "resume-reject", { targetIncarnation: requestedIncarnation });
        return;
      }
      if (existing && links.get(id) === existing) destroyLink(existing, "peer resuming");
      incarnations.set(id, requestedIncarnation);
      const generation = (generations.get(id) ?? 0) + 1;
      send(id, "resume-accept", { generation, targetIncarnation: requestedIncarnation });
      status("peer-resuming", { peerId: id });
      if (leader(id)) {
        try {
          startGeneration(id, generation);
        } catch {
        }
      }
    }).finally(() => resumeChecks.delete(id));
    resumeChecks.set(id, check);
  }
  function startPeer(link) {
    if (disposed || link.started || links.get(link.id) !== link) return;
    link.started = true;
    Promise.resolve().then(() => {
      if (disposed || links.get(link.id) !== link) throw new Error("dynamic peer superseded");
      return peerFactory({
        initiator: leader(link.id),
        signaler: scopedSignaler(link),
        remoteId: link.id,
        rtcConfig,
        timeoutMs: peerTimeoutMs,
        signal: link.controller.signal,
        onStatus: (event) => status("peer-status", { peerId: link.id, event })
      });
    }).then((peer) => {
      if (disposed || links.get(link.id) !== link) {
        peer?.close?.();
        return;
      }
      if (typeof peer?.transport?.send !== "function" || typeof peer.transport.subscribe !== "function" || typeof peer.close !== "function") {
        peer?.close?.();
        throw new TypeError("dynamic peer capability");
      }
      if (peer.transport.state && peer.transport.state !== "open") {
        peer.close();
        throw new Error("dynamic transport not open");
      }
      link.peer = peer;
      clearTimeout(link.deadline);
      link.outbound.clear();
      const transport = wrapTransport(link, peer.transport);
      transports.set(link.id, transport);
      peerConnections.set(link.id, peer.peerConnection);
      if (peer.transport.subscribeStatus) link.removeStatus = peer.transport.subscribeStatus((state) => {
        if (state === "closed" || state === "failed" || state === "interrupted") failLink(link, new Error("dynamic peer " + state));
      });
      link.resolve(transport);
      status("peer-connected", { peerId: link.id, transport, generation: link.generation });
      if (!disposed && establishing && (link.id === coordinatorId || resumed && coordinatorId === self)) {
        resumePeerId ??= link.id;
        finish();
      }
    }).catch((error2) => failLink(link, error2));
  }
  function announceLink(link) {
    return send(link.id, "link", { generation: link.generation, connectionId: link.connectionId });
  }
  function startGeneration(id, generation) {
    const link = newLink(id, generation, randomId(), links.get(id));
    rememberGeneration(id, generation);
    link.announcement = announceLink(link);
    link.announcement.catch((error2) => failLink(link, error2));
    startPeer(link);
    return link;
  }
  function ensurePeer(id, force = false) {
    if (disposed) return Promise.reject(new Error("dynamic room closed"));
    if (!validId(id) || id === self || !accepted(id)) return Promise.reject(new Error("dynamic peer is not invited"));
    const old = links.get(id);
    if (resumed && resumeTargets.has(id) && !resumeApproved.has(id)) {
      try {
        const waiting = old ?? newLink(id, 0, null);
        waiting.resuming = true;
        send(id, "resume-request", { resumeSession: sessionId });
        return waiting.promise;
      } catch (error2) {
        return Promise.reject(error2);
      }
    }
    if (!incarnations.has(id)) {
      try {
        const waiting = old ?? newLink(id, 0, null);
        waiting.waitingIncarnation = true;
        return waiting.promise;
      } catch (error2) {
        return Promise.reject(error2);
      }
    }
    if (old && !old.waitingIncarnation && (!force || !old.peer)) return old.promise;
    try {
      if (leader(id)) return startGeneration(id, (generations.get(id) ?? 0) + 1).promise;
      const link = newLink(id, 0, null, old);
      link.force = force;
      send(id, "request", { generation: link.requestGeneration, reconnect: force });
      return link.promise;
    } catch (error2) {
      return Promise.reject(error2);
    }
  }
  function advertise(to = "*") {
    if (coordinatorId !== self || resumed && !settled) return;
    send(to, "hello", { players, maxPlayers, accepting: players.length < maxPlayers });
  }
  function inviteMesh(value) {
    const next = roster2(value, maxPlayers);
    if (!next.includes(self) || !next.includes(coordinatorId)) throw new TypeError("dynamic mesh requires local player and coordinator");
    meshPlayers = new Set(next);
    meshUntil = nowMs() + peerTimeoutMs;
    if (coordinatorId === self) {
      invitation = { players: next, until: meshUntil };
      send("*", "mesh", { players: next, peerIncarnations: Object.fromEntries(incarnations) });
    }
    return next;
  }
  function setRoster(value) {
    if (disposed) throw new Error("dynamic room closed");
    const next = roster2(value?.players, maxPlayers), nextEpoch = integer(value?.epoch, "epoch", 0, 65534);
    if (!validId(value?.coordinatorId) || !next.includes(value.coordinatorId)) throw new TypeError("dynamic roster coordinator");
    if (nextEpoch < epoch) throw new Error("stale dynamic room epoch");
    if (nextEpoch === epoch && (players.join("\n") !== next.join("\n") || coordinatorId !== value.coordinatorId)) throw new Error("conflicting dynamic room epoch");
    players = next;
    epoch = nextEpoch;
    coordinatorId = value.coordinatorId;
    meshPlayers = new Set(next);
    meshUntil = Infinity;
    invitation = null;
    for (const id of candidates.keys()) if (next.includes(id)) candidates.delete(id);
    for (const id of incarnations.keys()) if (id !== self && !next.includes(id) && !links.has(id) && !candidates.has(id)) incarnations.delete(id);
    saveResume();
    if (coordinatorId === self) advertise();
  }
  const capability = {
    room,
    role,
    maxPlayers,
    resumed,
    get resumePeerId() {
      return resumePeerId;
    },
    localPlayerId: self,
    transports,
    peerConnections,
    get sessionId() {
      return sessionId;
    },
    get coordinatorId() {
      return coordinatorId;
    },
    get players() {
      return players;
    },
    get epoch() {
      return epoch;
    },
    get joining() {
      return !players.includes(self);
    },
    get closed() {
      return disposed;
    },
    get metrics() {
      return { activePeerCount: transports.size, pendingPeerCount: pendingCount(), signalBacklogBytes: backlogBytes };
    },
    subscribe(fn) {
      if (disposed || typeof fn !== "function") throw new TypeError("dynamic room subscriber");
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setRoster,
    connectMesh(value) {
      try {
        if (disposed) throw new Error("dynamic room closed");
        const next = inviteMesh(value);
        return Promise.all(next.filter((id) => id !== self).map((id) => ensurePeer(id))).then(() => void 0);
      } catch (error2) {
        return Promise.reject(error2);
      }
    },
    reconnect(id) {
      return ensurePeer(id, true);
    },
    forgetResume() {
      resumeIdentity?.forget();
    },
    disconnect(id) {
      if (!validId(id) || id === self) throw new TypeError("dynamic peer id");
      const link = links.get(id);
      if (link) destroyLink(link, "peer disconnected by owner");
      candidates.delete(id);
      meshPlayers.delete(id);
      if (!players.includes(id)) incarnations.delete(id);
      for (const key of backlog.keys()) if (key.startsWith(id + ":")) forgetBacklog(key);
      return !!link;
    },
    close
  };
  function routeSignal(envelope) {
    const { from, to, message: m } = envelope;
    if (to !== self || m.dynamicSession !== sessionId || m.dynamicTo !== incarnation || m.dynamicFrom !== incarnations.get(from) || !accepted(from) || !Number.isSafeInteger(m.dynamicGeneration) || m.dynamicGeneration < 1 || !validId(m.dynamicConnection)) return;
    let size;
    try {
      size = encoder.encode(JSON.stringify(m)).length;
    } catch {
      return;
    }
    if (size > MAX_SIGNAL_BYTES) return;
    const link = links.get(from);
    if (link?.generation === m.dynamicGeneration && link.connectionId === m.dynamicConnection && link.subscribers.size) {
      for (const fn of [...link.subscribers]) fn(envelope);
      return;
    }
    const known = generations.get(from) ?? 0;
    if (leader(from) || m.dynamicGeneration < known || m.dynamicGeneration === known && (!link || link.generation !== m.dynamicGeneration || link.connectionId !== m.dynamicConnection)) return;
    const key = `${from}:${m.dynamicGeneration}:${m.dynamicConnection}`;
    const queued = backlog.get(key) ?? { items: [], until: nowMs() + peerTimeoutMs };
    if (queued.items.length >= 32 || !backlog.has(key) && backlog.size >= maxPendingPeers || backlogBytes + size > MAX_BACKLOG_BYTES) return;
    queued.items.push({ envelope, size });
    backlogBytes += size;
    backlog.set(key, queued);
  }
  function receive(envelope) {
    if (disposed || !envelope || !validId(envelope.from) || envelope.from === self || !["*", self].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") return;
    const { from, message: m } = envelope;
    if (signalTypes.has(m.type)) {
      routeSignal(envelope);
      return;
    }
    if (m.type !== "group" || m.mode !== "dynamic" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
    if (m.targetIncarnation && m.targetIncarnation !== incarnation) return;
    if (m.op === "discover") {
      if (m.resumeSession === sessionId && players.includes(from) && validId(m.incarnation)) {
        send(from, "resume-hello", { targetIncarnation: m.incarnation, players, peerIncarnations: Object.fromEntries(incarnations) });
      } else advertise(from);
      return;
    }
    if (m.op === "resume-hello" && resumed && !settled && m.sessionId === sessionId && players.includes(from) && validId(m.incarnation)) {
      let next;
      try {
        next = roster2(m.players, maxPlayers);
        integer(m.epoch, "epoch", epoch, 65534);
      } catch {
        return;
      }
      if (!next.includes(self) || !next.includes(from) || !next.includes(m.coordinatorId)) return;
      players = next;
      epoch = m.epoch;
      coordinatorId = m.coordinatorId;
      meshPlayers = new Set(next);
      meshUntil = Infinity;
      acceptIncarnations(m.peerIncarnations, next);
      incarnations.set(from, m.incarnation);
      saveResume();
      const donor = coordinatorId === self ? from : coordinatorId;
      if (incarnations.has(donor)) ensurePeer(donor).catch(() => {
      });
      return;
    }
    if (m.op === "hello" && expectedSessionId !== void 0 && m.sessionId !== expectedSessionId) return;
    if (m.op === "hello" && !resumed && !settled && role === "join" && m.coordinatorId === from && validId(m.sessionId)) {
      if (coordinatorId && (coordinatorId !== from || sessionId !== m.sessionId)) return;
      let known;
      try {
        known = roster2(m.players, maxPlayers);
        integer(m.epoch, "epoch", 0, 65534);
      } catch {
        return;
      }
      if (!known.includes(from)) return;
      if (m.maxPlayers !== maxPlayers) {
        close("dynamic room maxPlayers mismatch");
        return;
      }
      if (m.accepting === false && !known.includes(self)) {
        close("dynamic room is full");
        return;
      }
      coordinatorId = from;
      sessionId = m.sessionId;
      players = known;
      epoch = m.epoch;
      incarnations.set(from, m.incarnation);
      meshPlayers = new Set(known);
      meshUntil = Infinity;
      saveResume();
      send(from, "join");
      ensurePeer(from).catch(() => {
      });
      return;
    }
    if (!sessionId || m.sessionId !== sessionId || m.coordinatorId !== coordinatorId) return;
    if (m.op === "resume-request" && players.includes(from) && m.resumeSession === sessionId && validId(m.incarnation)) {
      approveResume(from, m.incarnation);
      return;
    }
    if (m.op === "resume-reject" && resumed && players.includes(from)) {
      if (!settled) close("duplicate live resume identity");
      else if (links.get(from)?.resuming) failLink(links.get(from), new Error("duplicate live resume identity"));
      return;
    }
    if (m.op === "resume-accept" && resumed && players.includes(from) && validId(m.incarnation) && Number.isSafeInteger(m.generation) && m.generation > 0) {
      if (resumeApproved.has(from)) return;
      incarnations.set(from, m.incarnation);
      resumeApproved.add(from);
      if (leader(from)) {
        try {
          startGeneration(from, Math.max(m.generation, (generations.get(from) ?? 0) + 1));
        } catch {
        }
      }
      return;
    }
    if (m.op === "join" && coordinatorId === self) {
      if (!validId(m.incarnation)) return;
      if (incarnations.has(from) && incarnations.get(from) !== m.incarnation) {
        send(from, "reject", { targetIncarnation: m.incarnation, reason: "duplicate live identity; use resume" });
        return;
      }
      if (!players.includes(from) && !candidates.has(from)) {
        let authorized = false;
        try {
          authorized = authorizeJoin(from, { sessionId, room }) === true;
        } catch {
        }
        if (!authorized) {
          send(from, "reject", { targetIncarnation: m.incarnation, reason: "dynamic room admission reservation required" });
          return;
        }
        if (players.length + candidates.size >= maxPlayers || pendingCount() >= maxPendingPeers) {
          send(from, "reject", { targetIncarnation: m.incarnation, reason: "dynamic room is full" });
          return;
        }
        candidates.set(from, nowMs() + peerTimeoutMs);
      }
      incarnations.set(from, m.incarnation);
      ensurePeer(from).catch(() => {
      });
      return;
    }
    if (m.op === "reject" && !settled && from === coordinatorId) {
      close(typeof m.reason === "string" ? m.reason.slice(0, 256) : "dynamic room rejected");
      return;
    }
    if (m.op === "mesh" && from === coordinatorId && m.incarnation === incarnations.get(from) && m.epoch === epoch) {
      let next;
      try {
        next = roster2(m.players, maxPlayers);
      } catch {
        return;
      }
      if (!next.includes(self) || !next.includes(coordinatorId)) return;
      acceptIncarnations(m.peerIncarnations, next);
      meshPlayers = new Set(next);
      meshUntil = nowMs() + peerTimeoutMs;
      for (const id of next) if (id !== self) ensurePeer(id).catch(() => {
      });
      return;
    }
    if (!accepted(from) || m.incarnation !== incarnations.get(from)) return;
    if (m.op === "request" && leader(from) && Number.isSafeInteger(m.generation) && m.generation >= 0) {
      const link = links.get(from), generation = generations.get(from) ?? 0;
      if (m.generation > generation) return;
      if (!link || m.reconnect === true && m.generation === generation && link.peer) {
        try {
          startGeneration(from, generation + 1);
        } catch {
        }
      } else if (link.connectionId) announceLink(link);
    } else if (m.op === "link" && !leader(from) && Number.isSafeInteger(m.generation) && m.generation > 0 && validId(m.connectionId)) {
      const known = generations.get(from) ?? 0, current = links.get(from);
      if (m.generation < known || m.generation === known && current?.connectionId !== m.connectionId) return;
      if (current?.generation === m.generation && current.connectionId === m.connectionId) return;
      try {
        const link = newLink(from, m.generation, m.connectionId, current);
        rememberGeneration(from, m.generation);
        startPeer(link);
      } catch {
      }
    }
  }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
    return ready;
  }
  try {
    unsubscribe = signaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (error2) {
        close(error2.message);
      }
    });
  } catch (error2) {
    close(error2.message);
    return ready;
  }
  if (disposed) {
    unsubscribe?.();
    return ready;
  }
  const remaining = timeoutMs - (nowMs() - startedAt);
  if (remaining <= 0) {
    close("dynamic room timeout");
    return ready;
  }
  if (establishing) deadline = setTimeout(() => close("dynamic room join timeout"), remaining);
  interval = setInterval(() => {
    const now = nowMs();
    for (const [id, until] of candidates) if (until <= now && !players.includes(id)) {
      candidates.delete(id);
      incarnations.delete(id);
      const link = links.get(id);
      if (link) destroyLink(link, "dynamic admission timeout");
    }
    for (const [key, queued] of backlog) if (queued.until <= now) forgetBacklog(key);
    if (coordinatorId === self && now >= nextAdvertisement) {
      nextAdvertisement = now + advertiseIntervalMs;
      advertise();
    }
    if (!settled && establishing) {
      if (resumed) send("*", "discover", { resumeSession: sessionId });
      else if (!coordinatorId) send("*", "discover");
      else {
        send(coordinatorId, "join");
        ensurePeer(coordinatorId).catch(() => {
        });
      }
    }
    if (invitation && invitation.until > now) send("*", "mesh", { players: invitation.players, peerIncarnations: Object.fromEntries(incarnations) });
    else invitation = null;
    for (const link of links.values()) if (!link.peer && now >= link.nextRetry) {
      link.nextRetry = now + retryMs;
      if (link.waitingIncarnation) {
        if (incarnations.has(link.id)) ensurePeer(link.id).catch(() => {
        });
        continue;
      }
      if (link.resuming && !resumeApproved.has(link.id)) {
        send(link.id, "resume-request", { resumeSession: sessionId });
        continue;
      }
      if (leader(link.id)) announceLink(link);
      else if (!link.connectionId) send(link.id, "request", { generation: link.requestGeneration, reconnect: link.force });
      for (const [type, message] of link.outbound) publish(link.id, message, `${link.id}:signal:${link.generation}:${type}`).catch(() => {
      });
    }
  }, retryMs);
  interval.unref?.();
  status("room-ready", { localPlayerId: self });
  if (!disposed) {
    try {
      saveResume();
    } catch (error2) {
      close(error2.message);
      return ready;
    }
    if (!establishing) {
      advertise();
      finish();
    } else send("*", "discover", resumed ? { resumeSession: sessionId } : {});
  }
  return ready;
}

// packages/transport/src/public-room.js
var idValid2 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var randomId2 = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
var randomRoom = () => String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
var DIRECTORY_LIMIT = 64;
var PUBLICATION_LIMIT = 16;
var error = (code, message) => Object.assign(new Error(message), { code });
async function createNostrPublicRoom({
  namespace = "rollback-netcode",
  simulationVersion,
  maxPlayers = 5,
  discoveryMs = 1500,
  totalTimeoutMs = 6e4,
  leaseMs = 15e3,
  reservationMs = 3e4,
  maxAttempts = 3,
  relays,
  rtcConfig,
  resume,
  signal,
  onStatus = () => {
  },
  signalerFactory = createNostrSignaler,
  dynamicRoomFactory = createNostrDynamicRoom,
  ...dynamicOptions
} = {}) {
  if (typeof namespace !== "string" || !namespace.trim() || encoder.encode(namespace + ":public-v1").length > 128) throw new TypeError("public room namespace");
  if (typeof simulationVersion !== "string" || !simulationVersion.length || encoder.encode(simulationVersion).length > 128) throw new TypeError("public simulationVersion");
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(discoveryMs, "discoveryMs", 10, 3e4);
  integer(totalTimeoutMs, "totalTimeoutMs", 10, 12e4);
  integer(leaseMs, "leaseMs", 100, 6e4);
  integer(reservationMs, "reservationMs", 100, 12e4);
  integer(maxAttempts, "maxAttempts", 1, 8);
  if ([onStatus, signalerFactory, dynamicRoomFactory].some((fn) => typeof fn !== "function")) throw new TypeError("public room capability");
  if (resume) {
    if (!resume.storage || ["getItem", "setItem", "removeItem"].some((k) => typeof resume.storage[k] !== "function")) throw new TypeError("resume storage capability");
    integer(resume.lifetimeMs ?? 8 * 60 * 60 * 1e3, "resume lifetimeMs", 1e3, 864e5);
    if (resume.reset !== void 0 && typeof resume.reset !== "boolean") throw new TypeError("resume reset");
    if (resume.key !== void 0 && (typeof resume.key !== "string" || !resume.key.length || resume.key.length > 500)) throw new TypeError("resume key");
  }
  if (signal?.aborted) throw error("PUBLIC_ABORTED", "public room aborted");
  const started = nowMs(), startedWallAt = Date.now(), controller = new AbortController(), directory = /* @__PURE__ */ new Map(), reservations = /* @__PURE__ */ new Map(), publications = /* @__PURE__ */ new Map();
  const ephemeralStore = /* @__PURE__ */ new Map();
  const ephemeral = createRoomResumeIdentity({ storage: { getItem: (k) => ephemeralStore.get(k) ?? null, setItem: (k, v) => ephemeralStore.set(k, v), removeItem: (k) => ephemeralStore.delete(k) } }, { namespace, room: "0000" });
  const shared = (identity) => ({ id: identity.id, sign: (...args) => identity.sign(...args), close() {
  } });
  let disposed = false, everAdmitted = false, resumeForgotten = false, room, directorySignaler, removeDirectory, removeRoom, interval, nextAdvertisement = 0;
  let sequence = 0, reservationWaiter, selected, setupTimer, generation = 0, directoryId, pointer, pointerKey, storedUntil;
  const timerWaiters = /* @__PURE__ */ new Map(), observers = /* @__PURE__ */ new Set();
  const status = (type, detail = {}) => {
    const event = { type, ...detail };
    try {
      onStatus(event);
    } catch {
    }
    for (const fn of [...observers]) {
      try {
        fn(event);
      } catch {
      }
    }
  };
  const remaining = () => Math.max(0, Math.floor(totalTimeoutMs - (nowMs() - started)));
  const scopedResume = (code) => resume ? { ...resume, ...resume.key ? { key: `${resume.key}:${code}` } : {} } : void 0;
  const roomStorageKey = (code) => scopedResume(code)?.key ?? `bloom-gamekit:dynamic-v1:${namespace}:${code}`;
  if (resume) {
    if (!resume.storage || ["getItem", "setItem", "removeItem"].some((k) => typeof resume.storage[k] !== "function")) throw new TypeError("resume storage capability");
    pointerKey = `${resume.key ?? `bloom-gamekit:public-v1:${namespace}:${simulationVersion}`}:pointer`;
    if (pointerKey.length > 512) throw new TypeError("public resume key");
    const raw = resume.storage.getItem(pointerKey);
    if (resume.reset) {
      if (raw) {
        try {
          const old = JSON.parse(raw);
          if (/^\d{4}$/.test(old?.room)) resume.storage.removeItem(roomStorageKey(old.room));
        } catch {
        }
      }
      resume.storage.removeItem(pointerKey);
    } else if (raw != null) {
      try {
        if (typeof raw !== "string" || raw.length > 2048) throw Error();
        pointer = JSON.parse(raw);
        if (pointer.version !== 1 || pointer.namespace !== namespace || pointer.simulationVersion !== simulationVersion || !/^\d{4}$/.test(pointer.room) || !idValid2(pointer.sessionId) || !Number.isSafeInteger(pointer.expiresAt) || pointer.expiresAt <= Date.now() || pointer.expiresAt > Date.now() + 864e5) throw Error();
        storedUntil = pointer.expiresAt;
      } catch {
        ephemeral.identity.close();
        throw error("PUBLIC_RESUME_INVALID", "invalid or expired public resume pointer; explicitly reset for a fresh room");
      }
    }
  }
  const fail = (message) => error("PUBLIC_TIMEOUT", message ?? "public room total timeout");
  function wait(ms) {
    if (disposed) return Promise.reject(error("PUBLIC_CLOSED", "public room closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timerWaiters.delete(timer);
        resolve();
      }, Math.max(1, ms));
      timerWaiters.set(timer, reject);
    });
  }
  function bounded(promise, ms, reason) {
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(reason), Math.max(1, ms));
      timerWaiters.set(timer, reject);
    });
    return Promise.race([promise, deadline]).finally(() => {
      clearTimeout(timer);
      timerWaiters.delete(timer);
    });
  }
  function close(reason = "public room closed") {
    if (disposed) return;
    disposed = true;
    clearTimeout(setupTimer);
    clearInterval(interval);
    removeRoom?.();
    removeDirectory?.();
    controller.abort();
    signal?.removeEventListener("abort", abort);
    const pending = reservationWaiter;
    reservationWaiter = null;
    pending?.reject(error("PUBLIC_CLOSED", reason));
    for (const [timer, reject] of timerWaiters) {
      clearTimeout(timer);
      reject(error("PUBLIC_CLOSED", reason));
    }
    timerWaiters.clear();
    directorySignaler?.close();
    room?.close();
    ephemeral.identity.close();
    ephemeralStore.clear();
    directory.clear();
    reservations.clear();
    publications.clear();
    status("public-room-closed", { reason });
    observers.clear();
  }
  function abort() {
    close("public room aborted");
  }
  signal?.addEventListener("abort", abort, { once: true });
  setupTimer = setTimeout(() => close("public room total timeout"), totalTimeoutMs);
  function publish(to, op, extra = {}, key = `${to}:${op}`) {
    if (disposed || !directorySignaler) return Promise.reject(error("PUBLIC_CLOSED", "public directory closed"));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= PUBLICATION_LIMIT) return Promise.reject(error("PUBLIC_CAPACITY", "public directory publication capacity"));
    const channel = directorySignaler, promise = Promise.resolve().then(() => channel.send(
      to,
      { type: "group", mode: "public-directory", version: 1, protocol: PROTOCOL_VERSION, simulationVersion, maxPlayers, op, ...extra }
    )).finally(() => {
      if (publications.get(key) === promise) publications.delete(key);
    });
    publications.set(key, promise);
    return promise;
  }
  function prune() {
    const now = Date.now();
    for (const [id, lease] of directory) if ((lease.refreshUntil ?? lease.expiresAt) <= now) directory.delete(id);
    for (const [id, seat] of reservations) if (!room || room.players.includes(id) || seat.expiresAt <= now || room.coordinatorId !== room.localPlayerId) {
      reservations.delete(id);
      if (room && !room.players.includes(id)) room.disconnect(id);
    }
  }
  function advertise(to = "*") {
    if (!room || room.closed || room.joining || room.coordinatorId !== room.localPlayerId) return Promise.resolve();
    prune();
    const issuedAt = Date.now();
    return publish(to, "lease", {
      room: room.room,
      sessionId: room.sessionId,
      coordinatorId: room.coordinatorId,
      players: [...room.players],
      epoch: room.epoch,
      sequence: ++sequence,
      issuedAt,
      expiresAt: issuedAt + leaseMs,
      committed: room.players.length,
      pending: reservations.size
    });
  }
  const background = (promise) => promise.catch((cause) => {
    if (!disposed) status("public-directory-error", { reason: cause.message });
  });
  function receive({ from, to, message: m } = {}) {
    if (disposed || !idValid2(from) || from === directoryId || !["*", directoryId].includes(to) || !m || m.type !== "group" || m.mode !== "public-directory" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION || m.simulationVersion !== simulationVersion || m.maxPlayers !== maxPlayers) return;
    const now = Date.now();
    if (m.op === "lease") {
      if (!/^\d{4}$/.test(m.room) || !idValid2(m.sessionId) || m.coordinatorId !== from || !Number.isSafeInteger(m.epoch) || m.epoch < 0 || m.epoch > 65534 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isSafeInteger(m.issuedAt) || m.issuedAt > now + 1e3 || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= now || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > 6e4 || !Array.isArray(m.players) || m.players.length < 1 || m.players.length > maxPlayers || m.players.some((id) => !idValid2(id)) || new Set(m.players).size !== m.players.length || !m.players.includes(from) || m.committed !== m.players.length || !Number.isSafeInteger(m.pending) || m.pending < 0 || m.pending + m.committed > maxPlayers) return;
      prune();
      const prior = directory.get(m.sessionId);
      if (prior && (m.room !== prior.room || m.epoch < prior.epoch || m.epoch === prior.epoch && (prior.refreshAfter || m.coordinatorId !== prior.coordinatorId || m.sequence <= prior.sequence))) return;
      if (prior && m.epoch > prior.epoch && !prior.players.includes(from)) {
        prior.refreshAfter ??= prior.expiresAt;
        prior.refreshUntil ??= prior.refreshAfter + 6e4;
        if (now < prior.refreshAfter || m.issuedAt < prior.refreshAfter) return;
      }
      if (!directory.has(m.sessionId) && directory.size >= DIRECTORY_LIMIT) return;
      directory.set(m.sessionId, {
        room: m.room,
        sessionId: m.sessionId,
        coordinatorId: from,
        players: [...m.players],
        epoch: m.epoch,
        sequence: m.sequence,
        issuedAt: m.issuedAt,
        expiresAt: m.expiresAt,
        committed: m.committed,
        pending: m.pending
      });
      return;
    }
    if (m.op === "discover") {
      background(advertise());
      return;
    }
    if (m.op === "grant" || m.op === "deny") {
      const pending = reservationWaiter;
      if (!pending || to !== directoryId || from !== pending.lease.coordinatorId || m.sessionId !== pending.lease.sessionId || m.requestId !== pending.requestId || m.epoch !== pending.lease.epoch) return;
      if (m.op === "deny") {
        reservationWaiter = null;
        pending.reject(m.reason === "stale-epoch" ? error("PUBLIC_STALE_LEASE", "public room lease advanced; retry discovery") : error("PUBLIC_RESERVED", "public room has no available reservation"));
      } else if (Number.isSafeInteger(m.expiresAt) && m.expiresAt > now && m.expiresAt <= now + 12e4) {
        reservationWaiter = null;
        pending.resolve({ expiresAt: m.expiresAt });
      }
      return;
    }
    if (!room || room.closed || room.coordinatorId !== room.localPlayerId || m.sessionId !== room.sessionId || to !== directoryId || !idValid2(m.requestId)) return;
    prune();
    if (m.op === "release") {
      const seat2 = reservations.get(from);
      if (seat2?.requestId === m.requestId) {
        reservations.delete(from);
        if (!room.players.includes(from)) room.disconnect(from);
        background(advertise());
      }
      return;
    }
    if (m.op !== "reserve" || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= now || m.expiresAt > now + 12e4) return;
    if (m.epoch !== room.epoch) {
      if (Number.isSafeInteger(m.epoch) && m.epoch >= 0 && m.epoch < room.epoch) {
        background(advertise(from));
        background(publish(from, "deny", { sessionId: room.sessionId, epoch: m.epoch, requestId: m.requestId, reason: "stale-epoch" }));
      }
      return;
    }
    let seat = reservations.get(from);
    if (room.players.includes(from)) {
      background(publish(from, "grant", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: now + reservationMs }));
      return;
    }
    if (!seat && room.players.length + reservations.size < maxPlayers) {
      seat = { requestId: m.requestId, expiresAt: Math.min(now + reservationMs, m.expiresAt), epoch: room.epoch };
      reservations.set(from, seat);
    }
    if (seat) {
      seat.requestId = m.requestId;
      background(publish(from, "grant", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: seat.expiresAt }));
    } else background(publish(from, "deny", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId }));
    background(advertise());
  }
  async function openDirectory(identity) {
    if (directorySignaler && directoryId === identity.id) return;
    removeDirectory?.();
    directorySignaler?.close();
    publications.clear();
    const current = ++generation;
    const setup = Promise.resolve().then(() => signalerFactory({
      room: "0000",
      namespace: namespace + ":public-v1",
      relays,
      timeoutMs: Math.max(1, Math.min(1e4, remaining())),
      signal: controller.signal,
      onStatus,
      maxVerificationsPerSecond: 32,
      verificationBurst: 20,
      identity: shared(identity)
    })).then((value) => {
      if (disposed || current !== generation) {
        value?.close?.();
        throw error("PUBLIC_CLOSED", "public directory closed");
      }
      return value;
    });
    try {
      directorySignaler = await bounded(setup, remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    if (directorySignaler?.id !== identity.id || ["send", "subscribe", "close"].some((k) => typeof directorySignaler?.[k] !== "function")) throw new TypeError("public signaler capability");
    directoryId = identity.id;
    removeDirectory = directorySignaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (cause) {
        status("public-directory-error", { reason: cause.message });
      }
    });
  }
  async function discover() {
    status("public-discovering");
    try {
      await bounded(publish("*", "discover"), remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    await wait(Math.min(discoveryMs, remaining()));
    try {
      await bounded(publish("*", "discover"), remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    prune();
    const available = [...directory.values()].filter((lease) => !lease.refreshAfter && lease.committed + lease.pending < maxPlayers).sort((a, b) => b.committed - a.committed || a.sessionId.localeCompare(b.sessionId));
    if (!available.length && [...directory.values()].some((lease) => lease.refreshAfter)) {
      throw error("PUBLIC_HANDOVER_PENDING", "public room coordinator changed; waiting for a fresh lease after prior expiry");
    }
    return available;
  }
  async function reserve(lease) {
    const requestId = randomId2(), expiresAt = Date.now() + Math.min(remaining(), reservationMs);
    let resolve, reject;
    const response = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    reservationWaiter = { lease, requestId, resolve, reject };
    response.catch(() => {
    });
    selected = { ...lease, requestId };
    const attemptMs = Math.min(remaining(), Math.max(250, discoveryMs * 2));
    try {
      await bounded(publish(lease.coordinatorId, "reserve", { sessionId: lease.sessionId, epoch: lease.epoch, requestId, expiresAt }), attemptMs, error("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout"));
      await bounded(response, attemptMs, error("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout"));
    } finally {
      if (reservationWaiter?.requestId === requestId) reservationWaiter = null;
    }
  }
  async function release() {
    if (!selected?.requestId || disposed) return;
    const prior = selected;
    selected = null;
    try {
      await bounded(publish(prior.coordinatorId, "release", { sessionId: prior.sessionId, epoch: prior.epoch, requestId: prior.requestId }), Math.min(remaining(), 1e3), fail());
    } catch {
    }
  }
  function savePointer(committed = false) {
    if (!resume || !room || resumeForgotten) return;
    if (room.players.includes(room.localPlayerId)) everAdmitted = true;
    if (committed && everAdmitted && !room.players.includes(room.localPlayerId)) {
      resumeForgotten = true;
      resume.storage.removeItem(pointerKey);
      return;
    }
    if (room.joining) return;
    storedUntil ??= startedWallAt + (resume.lifetimeMs ?? 8 * 60 * 60 * 1e3);
    resume.storage.setItem(pointerKey, JSON.stringify({ version: 1, namespace, simulationVersion, room: room.room, sessionId: room.sessionId, expiresAt: storedUntil }));
  }
  async function connect(lease, restoring = false) {
    const code = lease?.room ?? randomRoom();
    let cancelled = false;
    const attemptController = new AbortController(), abortAttempt = () => attemptController.abort();
    controller.signal.addEventListener("abort", abortAttempt, { once: true });
    if (controller.signal.aborted) abortAttempt();
    const attemptTimeout = Math.max(1, Math.min(remaining(), restoring ? totalTimeoutMs : Math.max(discoveryMs * 2, dynamicOptions.peerTimeoutMs ?? 2e4)));
    const pending = Promise.resolve().then(() => dynamicRoomFactory({
      ...dynamicOptions,
      role: lease ? "join" : "host",
      room: code,
      namespace,
      maxPlayers,
      timeoutMs: attemptTimeout,
      relays,
      rtcConfig,
      resume: scopedResume(code),
      signal: attemptController.signal,
      onStatus,
      expectedSessionId: lease?.sessionId,
      authorizeJoin: (id) => {
        prune();
        return !!room && room.coordinatorId === room.localPlayerId && reservations.has(id);
      },
      signalerFactory: async (options) => {
        const identity = options.identity ?? ephemeral.identity;
        await openDirectory(identity);
        if (attemptController.signal.aborted) throw error("PUBLIC_CLOSED", "public attempt aborted");
        if (lease && !restoring) await reserve(lease);
        const value = await signalerFactory({ ...options, identity: shared(identity) });
        if (disposed) value?.close?.();
        return value;
      }
    })).then((result2) => {
      if (disposed || cancelled) result2?.close?.();
      return result2;
    });
    let result;
    try {
      result = await bounded(pending, attemptTimeout, fail("public room connection attempt timeout"));
    } catch (cause) {
      cancelled = true;
      attemptController.abort();
      controller.signal.removeEventListener("abort", abortAttempt);
      throw cause;
    }
    if (disposed) {
      result?.close?.();
      throw fail();
    }
    room = result;
    if (lease && room.sessionId !== lease.sessionId || room.localPlayerId !== directoryId) {
      room.close();
      room = null;
      throw error("PUBLIC_SCOPE", "public room identity/session mismatch");
    }
    return room;
  }
  try {
    await openDirectory(ephemeral.identity);
    if (pointer) {
      status("public-resuming", { room: pointer.room });
      await connect(pointer, true);
    } else {
      let lastError;
      const tried = /* @__PURE__ */ new Set();
      for (let attempt = 0; attempt < maxAttempts && !room; attempt++) {
        const available = await discover(), lease = available.find((value) => !tried.has(`${value.sessionId}:${value.epoch}`));
        if (!lease && available.length) {
          lastError ??= error("PUBLIC_NO_ROOM", "available public rooms did not accept this connection");
          break;
        }
        if (!lease) {
          status("public-hosting");
          await connect(null);
          break;
        }
        tried.add(`${lease.sessionId}:${lease.epoch}`);
        status("public-joining", { room: lease.room, sessionId: lease.sessionId });
        try {
          await connect(lease);
        } catch (cause) {
          lastError = cause;
          await release();
          await openDirectory(ephemeral.identity);
          status("public-attempt-failed", { reason: cause.message });
        }
      }
      if (!room) throw lastError ?? fail();
    }
    savePointer();
    removeRoom = room.subscribe((event) => {
      if (event.type === "peer-failed" || event.type === "peer-disconnected") {
        if (reservations.delete(event.peerId)) background(advertise());
      }
      if (event.type === "room-closed") close(event.reason);
    });
    await bounded(advertise(), remaining(), fail());
    clearTimeout(setupTimer);
    interval = setInterval(() => {
      if (disposed) return;
      prune();
      if (Date.now() >= nextAdvertisement) {
        nextAdvertisement = Date.now() + Math.max(30, Math.floor(leaseMs / 3));
        background(advertise());
      }
    }, Math.max(10, Math.min(1e3, Math.floor(leaseMs / 3))));
    interval.unref?.();
    const capability = {};
    for (const key of Object.keys(room)) Object.defineProperty(capability, key, { enumerable: true, configurable: true, get: () => room[key] });
    Object.defineProperties(capability, {
      close: { enumerable: true, configurable: true, value: close },
      setRoster: { enumerable: true, configurable: true, value(value) {
        room.setRoster(value);
        prune();
        savePointer(true);
        background(advertise());
      } },
      forgetResume: { enumerable: true, configurable: true, value() {
        resumeForgotten = true;
        room.forgetResume?.();
        resume?.storage.removeItem(pointerKey);
      } },
      publicMetrics: { enumerable: true, get: () => ({ directoryEntries: directory.size, pendingReservations: reservations.size, pendingPublications: publications.size }) },
      subscribe: { enumerable: true, configurable: true, value(fn) {
        if (typeof fn !== "function" || disposed) throw new TypeError("public room subscriber");
        const remove = room.subscribe(fn);
        observers.add(fn);
        return () => {
          remove();
          observers.delete(fn);
        };
      } }
    });
    status("public-room-ready", { room: room.room, sessionId: room.sessionId });
    return capability;
  } catch (cause) {
    close(cause.message);
    throw cause;
  }
}

// packages/replay/src/index.js
function playReplay({ adapter, replay, simulationVersion = replay?.simulationVersion } = {}) {
  if (replay?.version !== VERSION || replay.simulationVersion !== simulationVersion || !Array.isArray(replay.frames)) throw new Error("replay compatibility");
  adapter.load(bytes(replay.initialState).slice());
  let tick = 0;
  for (const f of replay.frames) {
    if (f.tick !== tick) throw new Error("non-contiguous replay");
    runSimulationFrame(adapter, { tick, tickRate: replay.tickRate, inputs: f.inputs.map((x) => ({ ...x, predicted: false })), resimulating: true, replaying: true });
    tick++;
  }
  return { tick, hash: hashBytes(bytes(adapter.save())) };
}
export {
  CHUNK_SIZE,
  DeterminismError,
  MAX_TICK,
  PROTOCOL_VERSION,
  RollbackSession,
  RoomSession,
  SeededPRNG,
  SyncTestSession,
  VERSION,
  WebRTCTransport,
  binaryCodec,
  createBootstrapReplay,
  createLoop,
  createNostrDynamicRoom,
  createNostrGroupRoom,
  createNostrPublicRoom,
  createNostrRoom,
  createNostrSignaler,
  createRoomSession,
  createSession,
  createSyncTestSession,
  createValueCodec,
  createWebRTCPeer,
  fixedPoint,
  hashBytes,
  jsonCodec,
  nostrCrypto,
  playReplay,
  profiles,
  runSyncTest,
  runSyncTestAsync,
  statelessRandom
};
