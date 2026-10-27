// modules/deterministic/utilities.js
var NOW_MS = () => globalThis.performance?.now() ?? Date.now();
var COMPARE_IDS = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, name, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(name);
  }
  return value;
}
function bytes(value, name = "bytes") {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
function equalBytes(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  const DATA = bytes(value);
  for (let i = 0; i < DATA.length; i++) {
    h = Math.imul(h ^ DATA[i], 16777619) >>> 0;
  }
  return h;
}
var SIGNED = (x) => integer(x, "fixed-point result", -2147483648, 2147483647);
var FIXED_POINT = Object.freeze({
  scale: 1024,
  fromNumber: (x) => SIGNED(Math.round(x * 1024)),
  toNumber: (x) => SIGNED(x) / 1024,
  add: (a, b) => SIGNED(SIGNED(a) + SIGNED(b)),
  sub: (a, b) => SIGNED(SIGNED(a) - SIGNED(b)),
  mul: (a, b) => {
    SIGNED(a);
    SIGNED(b);
    const PRODUCT = a * b;
    if (Number.isSafeInteger(PRODUCT)) {
      return SIGNED(Math.trunc(PRODUCT / 1024) || 0);
    }
    return SIGNED(Number(BigInt(a) * BigInt(b) / 1024n));
  },
  div: (a, b) => {
    if (SIGNED(b) === 0) {
      throw new RangeError("fixed-point division by zero");
    }
    return SIGNED(Number(BigInt(SIGNED(a)) * 1024n / BigInt(b)));
  }
});

// modules/_rollback-shared/version.js
var VERSION = "0.17.0";

// modules/_rollback-shared/protocol.js
var REPLAY_FORMAT_VERSION = "0.2.0-dev";
var PROTOCOL_VERSION = 3;
var CHUNK_SIZE = 16384;
var MAX_TICK = 2147483646;
var DEFAULTS = {
  mode: "rollback",
  inputScheduling: "configured",
  inputSafetyMarginMs: 8,
  inputJitterMultiplier: 2,
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
var PROFILES = Object.freeze({
  action: Object.freeze({
    ...DEFAULTS
  }),
  rts: Object.freeze({
    ...DEFAULTS,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 12,
    rollbackWindowTicks: 6,
    stateHistorySize: 32,
    predictionPolicy: "neutral",
    checksumInterval: 20
  }),
  lockstep: Object.freeze({
    ...DEFAULTS,
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
var ENCODER = new TextEncoder();
var DECODER = new TextDecoder("utf-8", {
  fatal: true
});
var MAGIC = 827015762;
var TYPE = Object.freeze({
  HELLO: 1,
  INPUT: 2,
  CLOCK: 3,
  HASH: 4,
  REQUEST: 5,
  BEGIN: 6,
  CHUNK: 7,
  INPUT_RESERVATION: 8,
  INPUT_RESERVATION_ACK: 9
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
    if (this.offset + n > this.data.length) {
      throw new RangeError("packet capacity");
    }
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
    if (this.offset + n > this.data.length) {
      throw new RangeError("truncated packet");
    }
  }
  u8() {
    this.room(1);
    return this.view.getUint8(this.offset++);
  }
  u16() {
    this.room(2);
    const N = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return N;
  }
  u32() {
    this.room(4);
    const N = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return N;
  }
  i32() {
    this.room(4);
    const N = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return N;
  }
  raw(n) {
    this.room(n);
    const B = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return B;
  }
  end() {
    if (this.offset !== this.data.length) {
      throw new RangeError("trailing packet bytes");
    }
  }
};
function packet(type, sequence, write) {
  const W = new Writer();
  W.u32(MAGIC);
  W.u8(PROTOCOL_VERSION);
  W.u8(type);
  W.u16(0);
  W.u32(sequence);
  write(W);
  return W.finish();
}
function frameEqual(a, b) {
  if (!equalBytes(a.input, b.input) || a.commands.length !== b.commands.length) {
    return false;
  }
  return a.commands.every(
    (c, i) => c.sequence === b.commands[i].sequence && equalBytes(c.payload, b.commands[i].payload)
  );
}
function copyFrame(frame) {
  return {
    input: frame.input.slice(),
    commands: frame.commands.map((c) => ({
      ...c,
      payload: c.payload.slice()
    }))
  };
}
function runSimulationFrame(adapter, context) {
  return adapter.step({
    ...context,
    inputs: context.inputs.map((frame) => ({
      ...copyFrame(frame),
      playerId: frame.playerId,
      predicted: !!frame.predicted
    }))
  });
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
    const S = this.slots[tick % this.size];
    return S?.tick === tick ? S : void 0;
  }
  put(state) {
    const I = state.tick % this.size, NEXT = this.byteLength - (this.slots[I]?.bytes.length ?? 0) + state.bytes.length;
    if (NEXT > this.maxBytes) {
      throw Object.assign(new RangeError("state history byte budget"), {
        code: "history-capacity",
        requiredBytes: NEXT,
        maxHistoryBytes: this.maxBytes,
        snapshotBytes: state.bytes.length
      });
    }
    this.slots[I] = state;
    this.byteLength = NEXT;
  }
  invalidateAfter(tick) {
    for (let i = 0; i < this.size; i++) {
      if (this.slots[i]?.tick > tick) {
        this.byteLength -= this.slots[i].bytes.length;
        this.slots[i] = void 0;
      }
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
    for (const STATE of this.records.values()) {
      if (STATE.tick <= tick && (!result || STATE.tick > result.tick)) {
        result = STATE;
      }
    }
    return result;
  }
  get oldestTick() {
    return Math.min(...this.records.keys());
  }
  put(state) {
    const OLDEST = Math.max(0, state.tick - this.size + 1);
    const BASE = this.atOrBefore(OLDEST);
    const EXPIRED = [...this.records.values()].filter((s) => BASE && s.tick < BASE.tick);
    const NEXT = this.byteLength - EXPIRED.reduce((n, s) => n + s.bytes.length, 0) - (this.records.get(state.tick)?.bytes.length ?? 0) + state.bytes.length;
    if (NEXT > this.maxBytes) {
      throw Object.assign(new RangeError("checkpoint history byte budget"), {
        code: "history-capacity",
        requiredBytes: NEXT,
        maxHistoryBytes: this.maxBytes,
        snapshotBytes: state.bytes.length
      });
    }
    for (const S of EXPIRED) {
      this.records.delete(S.tick);
    }
    this.records.set(state.tick, state);
    this.byteLength = NEXT;
  }
  invalidateAfter(tick) {
    for (const [T, STATE] of this.records) {
      if (T > tick) {
        this.records.delete(T);
        this.byteLength -= STATE.bytes.length;
      }
    }
  }
};

// modules/rollback/core.js
function copyLocalCommandState(state, inputSize, profile, executedSequence = 0) {
  if (!state || typeof state !== "object") {
    throw new TypeError("localCommandState");
  }
  const SEQUENCE = integer(state.sequence, "local command sequence", executedSequence);
  const LAST_INPUT = bytes(state.lastInput, "local command lastInput");
  if (LAST_INPUT.length !== inputSize) {
    throw new RangeError("local command inputSize");
  }
  const MAX_COMMANDS = profile.maxPendingCommands * (profile.maxInputDelayTicks + profile.stateHistorySize + 2);
  if (!Array.isArray(state.commands) || state.commands.length > MAX_COMMANDS) {
    throw new RangeError("local command capacity");
  }
  const MAX_PAYLOAD = Math.min(profile.maxCommandBytes, CHUNK_SIZE - 1024 - inputSize - 6);
  const MAX_BYTES = profile.maxPendingCommands * MAX_PAYLOAD + (profile.maxInputDelayTicks + profile.stateHistorySize + 1) * (CHUNK_SIZE - 1024 - inputSize);
  let previous = executedSequence;
  let previousTick = -1;
  let size = 0;
  const COMMANDS = Array.from(state.commands, (command) => {
    const NEXT = integer(command?.sequence, "local command order", 1, SEQUENCE);
    if (NEXT <= previous) {
      throw new RangeError("local command order");
    }
    const PAYLOAD = bytes(command.payload, "local command payload");
    if (!PAYLOAD.length || PAYLOAD.length > MAX_PAYLOAD || (size += PAYLOAD.length) > MAX_BYTES) {
      throw new RangeError("local command capacity");
    }
    const EXECUTE_TICK = integer(command.executeTick, "reserved execution tick", 0, MAX_TICK);
    if (EXECUTE_TICK < previousTick) {
      throw new RangeError("reserved execution order");
    }
    previous = NEXT;
    previousTick = EXECUTE_TICK;
    return {
      sequence: NEXT,
      executeTick: EXECUTE_TICK,
      payload: PAYLOAD.slice()
    };
  });
  let inputTick = -1;
  const FRAMES = state.inputs ?? [];
  if (!Array.isArray(FRAMES) || FRAMES.length > profile.stateHistorySize * 4 + profile.maxInputDelayTicks + 1) {
    throw new RangeError("reserved input capacity");
  }
  const INPUTS = FRAMES.map((frame) => {
    const TICK = integer(frame.tick, "reserved input tick", 0, MAX_TICK), INPUT_LOCAL = bytes(frame.input);
    if (TICK <= inputTick || INPUT_LOCAL.length !== inputSize) {
      throw new RangeError("reserved input order/size");
    }
    inputTick = TICK;
    return {
      tick: TICK,
      input: INPUT_LOCAL.slice()
    };
  });
  const SEALED_THROUGH = integer(state.sealedThrough ?? -1, "sealed input boundary", -1, MAX_TICK);
  return {
    sequence: SEQUENCE,
    lastInput: LAST_INPUT.slice(),
    commands: COMMANDS,
    inputs: INPUTS,
    sealedThrough: SEALED_THROUGH,
    tickOffset: 0
  };
}
function commandSequenceMap(players, initial) {
  if (initial === void 0) {
    return new Map(players.map((id) => [id, 0]));
  }
  if (!initial || typeof initial !== "object" || Array.isArray(initial) || Object.keys(initial).length !== players.length || players.some((id) => !Object.hasOwn(initial, id))) {
    throw new TypeError("initial command sequences roster");
  }
  return new Map(players.map((id) => [id, integer(initial[id], "initial command sequence")]));
}
function executedSequences(previous, inputs) {
  let next = previous;
  for (const FRAME of inputs) {
    for (const COMMAND of FRAME.commands) {
      if (next === previous) {
        next = new Map(previous);
      }
      next.set(FRAME.playerId, Math.max(next.get(FRAME.playerId), COMMAND.sequence));
    }
  }
  return next;
}
function profileOf(profile) {
  const P = {
    ...DEFAULTS,
    ...profile
  };
  for (const [KEY, MAX] of [
    ["inputSafetyMarginMs", 1e3],
    ["inputJitterMultiplier", 8]
  ]) {
    if (!Number.isFinite(P[KEY]) || P[KEY] < 0 || P[KEY] > MAX) {
      throw new RangeError(KEY);
    }
  }
  if (!["configured", "network"].includes(P.inputScheduling)) {
    throw new TypeError("inputScheduling");
  }
  if (!["rollback", "lockstep"].includes(P.mode)) {
    throw new TypeError("session mode");
  }
  if (P.mode === "lockstep") {
    P.rollbackWindowTicks = 0;
  }
  for (const FIELD of [
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
  ]) {
    integer(P[FIELD], FIELD, 1, 2147483647);
  }
  for (const FIELD of [
    "baseInputDelayTicks",
    "minInputDelayTicks",
    "maxInputDelayTicks",
    "rollbackWindowTicks",
    "tickDriftThreshold"
  ]) {
    integer(P[FIELD], FIELD, 0, 65535);
  }
  if (P.minInputDelayTicks > P.baseInputDelayTicks || P.baseInputDelayTicks > P.maxInputDelayTicks) {
    throw new RangeError("input delay bounds");
  }
  if (P.peerTimeoutMs <= P.peerInterruptMs) {
    throw new RangeError("peerTimeoutMs must exceed peerInterruptMs");
  }
  if (P.stateHistorySize < P.rollbackWindowTicks + 2) {
    throw new RangeError("stateHistorySize must exceed rollback window by two");
  }
  if (P.mode === "lockstep" && P.checksumInterval > P.stateHistorySize) {
    throw new RangeError("lockstep checksumInterval must fit input history window");
  }
  if (P.stateHistorySize > 8192) {
    throw new RangeError("stateHistorySize capacity (8192)");
  }
  if (P.tickRate > 240 || P.maxCommandBytes > CHUNK_SIZE - 1024 || P.maxSnapshotBytes > 64 * 1024 * 1024) {
    throw new RangeError("profile size limit");
  }
  if (!["hold", "neutral"].includes(P.predictionPolicy) && typeof P.predictionPolicy !== "function") {
    throw new TypeError("predictionPolicy");
  }
  if (!["none", "hold", "dilation"].includes(P.pacingPolicy) || P.stallPolicy !== "wait") {
    throw new TypeError("pacing/stall policy");
  }
  return Object.freeze(P);
}
function createSession(options) {
  return new RollbackSession(options);
}
function createLocalFastPathSession(options) {
  return new RollbackSession(options, void 0, true);
}
function delegateRoomRecovery(session, selectBoundary) {
  session._roomRecovery = selectBoundary;
}
var BOUNDARIES = /* @__PURE__ */ new WeakMap();
function createSessionFromBoundary(options, state, hash) {
  const TOKEN = {};
  BOUNDARIES.set(TOKEN, {
    adapter: options.adapter,
    state,
    hash
  });
  return new RollbackSession(options, TOKEN);
}
var RollbackSession = class {
  constructor({
    players,
    localPlayerId,
    sessionId,
    simulationVersion,
    seed = 1,
    inputSize,
    profile = PROFILES.action,
    adapter,
    authorityPlayerId,
    onEvent = () => {
    },
    recordReplay = true,
    clock = NOW_MS,
    localCommandState,
    initialCommandSequences
  } = {}, boundaryToken, localFastPath = false) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 8 || players.some((p) => typeof p !== "string" || !p.length || p.length > 128) || new Set(players).size !== players.length) {
      throw new TypeError("fixed player roster (1..8 unique IDs)");
    }
    this.players = Object.freeze([...players].sort(COMPARE_IDS));
    if (!this.players.includes(localPlayerId)) {
      throw new TypeError("localPlayerId");
    }
    if (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 128 || typeof simulationVersion !== "string" || !simulationVersion.length || simulationVersion.length > 128) {
      throw new TypeError("sessionId/simulationVersion");
    }
    if (!adapter || ["save", "load", "step", "validateSnapshot"].some((n) => typeof adapter[n] !== "function")) {
      throw new TypeError("Simulation Adapter must save, load, step, validateSnapshot");
    }
    this.localPlayerId = localPlayerId;
    this.sessionId = sessionId;
    this.simulationVersion = simulationVersion;
    this.seed = integer(seed, "seed");
    this.inputSize = integer(inputSize, "inputSize", 1, 1024);
    if (typeof clock !== "function") {
      throw new TypeError("monotonic runtime clock");
    }
    this._clock = clock;
    this.profile = profileOf(profile);
    this.adapter = adapter;
    this.onEvent = onEvent;
    this.localFastPath = localFastPath;
    if (localFastPath && (this.players.length !== 1 || this.profile.mode !== "lockstep" || recordReplay || boundaryToken)) {
      throw new TypeError("local fast path requires one-player lockstep without replay or a recovery boundary");
    }
    this.authorityPlayerId = authorityPlayerId ?? this.players[0];
    if (!this.players.includes(this.authorityPlayerId)) {
      throw new TypeError("authorityPlayerId");
    }
    this._tick = 0;
    this._inputDelay = this.profile.inputScheduling === "network" ? this.profile.minInputDelayTicks : this.profile.baseInputDelayTicks;
    this._requestedInputDelay = this._inputDelay;
    this.closed = false;
    this._failure = null;
    this._history = this.localFastPath ? null : this._newHistory();
    this._inputWriter = this.localFastPath ? null : new Writer(CHUNK_SIZE * this.players.length);
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
    this._localReservations = /* @__PURE__ */ new Map();
    this._reservationRevision = 0;
    this._localCaptures = [];
    this._localExecutedInput = null;
    let carriedInputs = [];
    let carriedThrough = -1;
    if (localCommandState !== void 0) {
      const CARRIED = copyLocalCommandState(
        localCommandState,
        this.inputSize,
        this.profile,
        this._commandSequence
      );
      this._commandSequence = CARRIED.sequence;
      this._lastLocalInput = CARRIED.lastInput;
      this._pendingCommands = CARRIED.commands;
      carriedInputs = CARRIED.inputs;
      carriedThrough = CARRIED.sealedThrough;
      integer(
        carriedThrough,
        "sealed input horizon",
        -1,
        this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks
      );
      for (let tick = 0; tick <= carriedThrough; tick++) {
        if (carriedInputs[tick]?.tick !== tick) {
          throw new RangeError("missing sealed input");
        }
      }
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
    this._window = {
      advances: 0,
      received: 0,
      late: 0,
      depth: 0,
      rollback: 0,
      stall: 0,
      cost: 0,
      costSamples: 0
    };
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
      serializedSnapshotBytes: 0,
      inputReservations: 0,
      inputReservationSentBytes: 0,
      inputReservationReceivedBytes: 0
    };
    this._recordReplay = recordReplay;
    this._replayFrames = [];
    this._replayBytes = 0;
    this._replayFinalHash = void 0;
    const BOUNDARY = BOUNDARIES.get(boundaryToken);
    if (BOUNDARY) {
      BOUNDARIES.delete(boundaryToken);
    }
    if (BOUNDARY && BOUNDARY.adapter !== adapter) {
      throw new Error("initial boundary adapter");
    }
    if (this.localFastPath) {
      this._initialState = null;
      this._currentState = null;
      this._hello = null;
    } else {
      const INITIAL = BOUNDARY ? BOUNDARY.state : this._save();
      if (!INITIAL.length || INITIAL.length > this.profile.maxSnapshotBytes) {
        throw new RangeError("snapshot size");
      }
      const RETAINED_COUNT = this.profile.mode === "lockstep" ? Math.ceil(this.profile.stateHistorySize / this.profile.checksumInterval) + 2 : this.profile.stateHistorySize;
      const REQUIRED_BYTES = INITIAL.length * RETAINED_COUNT;
      if (REQUIRED_BYTES > this.profile.maxHistoryBytes) {
        throw Object.assign(new RangeError("initial snapshot cannot fill retained history byte budget"), {
          code: "history-capacity",
          snapshotBytes: INITIAL.length,
          requiredBytes: REQUIRED_BYTES,
          maxHistoryBytes: this.profile.maxHistoryBytes
        });
      }
      this._initialState = BOUNDARY ? INITIAL : INITIAL.slice();
      const INITIAL_RECORD = {
        tick: 0,
        bytes: INITIAL,
        inputHash: this._inputHash,
        commandSequences: this._commandSequences,
        ...BOUNDARY ? {
          hash: BOUNDARY.hash
        } : {}
      };
      this._history.put(INITIAL_RECORD);
      this._currentState = INITIAL_RECORD;
      this._hello = ENCODER.encode(
        JSON.stringify({
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
          initialHash: this._stateHash(INITIAL_RECORD)
        })
      );
    }
    const NEUTRAL = new Uint8Array(this.inputSize);
    if (localCommandState) {
      for (const ENTRY of carriedInputs) {
        this._localReservations.set(ENTRY.tick, {
          tick: ENTRY.tick,
          input: bytes(ENTRY.input).slice(),
          commands: [],
          revision: ++this._reservationRevision,
          packet: null
        });
      }
      for (const COMMAND of this._pendingCommands) {
        if (!this._localReservations.has(COMMAND.executeTick)) {
          this._localReservations.set(COMMAND.executeTick, {
            tick: COMMAND.executeTick,
            input: this._lastLocalInput.slice(),
            commands: [],
            revision: ++this._reservationRevision,
            packet: null
          });
        }
        this._localReservations.get(COMMAND.executeTick).commands.push(COMMAND);
      }
    }
    for (let t = 0; t <= Math.max(this.inputDelay - 1, carriedThrough); t++) {
      this._sealLocal(t, NEUTRAL);
    }
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
  get confirmedBoundary() {
    return Math.min(this.tick, this.confirmedTick + 1);
  }
  /** Detached metadata about immutable local captures, not a simulation snapshot. */
  get localInputState() {
    const FRAME = this._localCapture;
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
      captures: this._localCaptures.map((c) => ({
        ...c,
        input: c.input.slice(),
        commands: c.commands.map((command) => ({
          ...command,
          payload: command.payload.slice()
        }))
      })),
      capture: FRAME ? {
        ...FRAME,
        input: FRAME.input.slice(),
        commands: FRAME.commands.map((c) => ({
          ...c,
          payload: c.payload.slice()
        }))
      } : null
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
    return !this.closed && !this._failure && this.players.every(
      (p) => p === this.localPlayerId || this._peers.get(p)?.ready && this._peers.get(p).connectionState === "connected"
    );
  }
  get status() {
    if (this.closed) {
      return "closed";
    }
    if (this._failure) {
      return "failed";
    }
    const PEERS = [...this._peers.values()];
    if (PEERS.some((p) => p.connectionState === "disconnected")) {
      return "disconnected";
    }
    if (PEERS.some((p) => p.connectionState === "interrupted")) {
      return "interrupted";
    }
    if (!this.ready) {
      return "synchronizing";
    }
    if (this._requestedRecovery) {
      return "recovering";
    }
    return this.resimulating ? "resimulating" : "running";
  }
  getPeerState(peerId) {
    const PEER = this._peers.get(peerId);
    if (!PEER) {
      return void 0;
    }
    return Object.freeze({
      peerId,
      state: PEER.connectionState,
      handshakeComplete: PEER.ready,
      lastReceivedAt: PEER.lastReceivedAt,
      simTick: PEER.tick,
      confirmedInputTick: PEER.confirmed,
      ackTick: PEER.ack,
      rtt: PEER.rtt,
      jitter: PEER.jitter
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
      retainedSnapshotBytes: this._history?.byteLength ?? 0
    };
  }
  _newHistory() {
    const HISTORY = this.profile.mode === "lockstep" ? CheckpointHistory : StateHistory;
    return new HISTORY(this.profile.stateHistorySize, this.profile.maxHistoryBytes);
  }
  _stateAt(tick) {
    if (this.localFastPath) {
      return void 0;
    }
    const RETAINED = this._history.get(tick);
    if (RETAINED) {
      return RETAINED;
    }
    if (this.profile.mode !== "lockstep" || tick !== this.tick || this.resimulating) {
      return void 0;
    }
    if (this._currentState?.tick === tick) {
      return this._currentState;
    }
    if (this._failure?.type === "fatal") {
      return void 0;
    }
    if (this._currentState?.tick !== tick) {
      this._currentState = {
        tick,
        bytes: this._save(),
        inputHash: this._inputHash,
        commandSequences: this._commandSequences
      };
    }
    return this._currentState;
  }
  _stateHash(state) {
    if (!state) {
      return void 0;
    }
    if (state.hash === void 0) {
      state.hash = hashBytes(state.bytes);
      this._metrics.stateHashComputations++;
      this._metrics.hashedStateBytes += state.bytes.length;
    }
    return state.hash;
  }
  _hashInputFrame(tick, inputs, previousHash) {
    const W = this._inputWriter.reset();
    W.u32(tick);
    for (const F of inputs) {
      W.raw(F.input);
      W.u16(F.commands.length);
      for (const C of F.commands) {
        W.u32(C.sequence);
        W.u16(C.payload.length);
        W.raw(C.payload);
      }
    }
    return hashBytes(W.usedBytes(), previousHash);
  }
  _event(type, detail = {}) {
    try {
      this.onEvent({
        type,
        tick: this.tick,
        ...detail
      });
    } catch {
    }
  }
  _fail(type, detail = {}) {
    if (this._failure || this.closed) {
      return;
    }
    this._failure = Object.freeze({
      type,
      ...detail
    });
    this._event(type, detail);
  }
  _peerTransition(peer, state, type, detail = {}) {
    if (peer.connectionState === state) {
      return;
    }
    const PREVIOUS = peer.connectionState;
    peer.connectionState = state;
    if (type) {
      this._event(type, {
        peerId: peer.id,
        previous: PREVIOUS,
        state,
        ...detail
      });
    }
  }
  _transportStatus(peer, state) {
    const VALUE = typeof state === "string" ? state : state?.state;
    peer.transportState = VALUE;
    if (VALUE === "closed" || VALUE === "failed") {
      this._peerTransition(peer, "disconnected", "peer-disconnected", {
        reason: "transport-" + VALUE
      });
    } else if (VALUE === "interrupted") {
      this._peerTransition(peer, "interrupted", "peer-interrupted", {
        reason: "transport-interrupted"
      });
    }
  }
  _peerAlive(peer, sequence, now) {
    if (["closed", "failed"].includes(peer.transportState)) {
      return;
    }
    const DELTA = peer.lastReceivedSequence === null ? 1 : sequence - peer.lastReceivedSequence >>> 0;
    if (DELTA === 0 || DELTA >= 2147483648) {
      return;
    }
    peer.lastReceivedSequence = sequence;
    peer.lastReceivedAt = now;
    this._peerTransition(peer, "connected", peer.connectionState === "connecting" ? null : "peer-resumed");
  }
  _peerLiveness(peer, now) {
    if (["closed", "failed"].includes(peer.transportState)) {
      return;
    }
    const SILENCE = Math.max(0, now - peer.lastReceivedAt);
    if (SILENCE >= this.profile.peerTimeoutMs) {
      this._peerTransition(peer, "disconnected", "peer-timeout", {
        silenceMs: SILENCE
      });
    } else if (SILENCE >= this.profile.peerInterruptMs && peer.connectionState !== "disconnected") {
      this._peerTransition(peer, "interrupted", "peer-interrupted", {
        reason: "silence",
        silenceMs: SILENCE
      });
    }
  }
  _save() {
    const STATE = bytes(this.adapter.save(), "snapshot").slice();
    if (!STATE.length || STATE.length > this.profile.maxSnapshotBytes) {
      throw new RangeError("snapshot size");
    }
    this._metrics.snapshotSaves++;
    this._metrics.serializedSnapshotBytes += STATE.length;
    return STATE;
  }
  _nextSequence() {
    this._sequence = this._sequence + 1 >>> 0;
    return this._sequence;
  }
  attachTransport(peerId, transport) {
    if (this.localFastPath) {
      throw new Error("transport unavailable in local fast path");
    }
    if (this.closed) {
      throw new Error("session closed");
    }
    if (this._failure) {
      throw new Error("session failed: " + this._failure.type);
    }
    if (peerId === this.localPlayerId || !this.players.includes(peerId) || this._peers.has(peerId)) {
      throw new TypeError("peerId already attached or outside roster");
    }
    if (typeof transport?.send !== "function" || typeof transport.subscribe !== "function") {
      throw new TypeError("Transport capability: send and subscribe");
    }
    const PEER = {
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
    this._peers.set(peerId, PEER);
    let detached = false;
    const CURRENT = () => !this.closed && !detached && this._peers.get(peerId) === PEER;
    PEER.detach = () => {
      if (detached) {
        return;
      }
      detached = true;
      if (this._peers.get(peerId) === PEER) {
        this._peers.delete(peerId);
      }
      const UNSUBSCRIBE = PEER.unsubscribe, UNSUBSCRIBE_STATUS = PEER.unsubscribeStatus;
      PEER.unsubscribe = PEER.unsubscribeStatus = null;
      try {
        UNSUBSCRIBE?.();
      } finally {
        UNSUBSCRIBE_STATUS?.();
      }
    };
    PEER.unsubscribe = transport.subscribe((data) => {
      if (CURRENT()) {
        this.receive(peerId, data);
      }
    });
    PEER.unsubscribeStatus = transport.subscribeStatus?.((state) => {
      if (CURRENT()) {
        this._transportStatus(PEER, state);
      }
    });
    if (transport.state) {
      this._transportStatus(PEER, transport.state);
    }
    this._sendHello(PEER, this._clock());
    return PEER.detach;
  }
  _send(peer, data) {
    try {
      if (peer.transport.send(data) === false) {
        return false;
      }
      this._metrics.sentBytes += data.length;
      return true;
    } catch (error) {
      this._event("transport-error", {
        peerId: peer.id,
        error
      });
      return false;
    }
  }
  _sendHello(peer, now) {
    if (this._send(
      peer,
      packet(TYPE.HELLO, this._nextSequence(), (w) => w.raw(this._hello))
    )) {
      peer.lastHello = now;
    }
  }
  _queue(peer, data) {
    if (peer.queuedBytes + data.length > this.profile.maxQueuedBytes) {
      return false;
    }
    peer.controls.push(data);
    peer.queuedBytes += data.length;
    return true;
  }
  _commitLocal(tick, input, commands) {
    integer(tick, "session tick limit", 0, MAX_TICK);
    const FRAME = {
      input: input.slice(),
      commands
    };
    if (this._inputs.get(this.localPlayerId).has(tick)) {
      throw new Error("committed input is immutable");
    }
    this._inputs.get(this.localPlayerId).set(tick, FRAME);
    this._through.set(this.localPlayerId, tick);
  }
  queueCommand(payload) {
    return this.submitInput(this._lastLocalInput, {
      commands: [payload]
    }).commandSequences[0];
  }
  _schedulingDelay(now = this._clock(), details) {
    if (this.profile.inputScheduling !== "network") {
      return this.inputDelay;
    }
    const RATE = this.profile.tickRate / 1e3;
    let delay = this.profile.minInputDelayTicks;
    for (const PEER of this._peers.values()) {
      if (PEER.ready) {
        const ONE_WAY_MS = PEER.rtt / 2, JITTER_MARGIN_MS = PEER.jitter / 2 * this.profile.inputJitterMultiplier;
        const LEAD = (ONE_WAY_MS + JITTER_MARGIN_MS + this.profile.inputSafetyMarginMs) * RATE;
        const AGE = PEER.clockSequence === null ? 0 : Math.min(Math.max(0, now - PEER.clockAt), this.profile.heartbeatMs * 2) * RATE;
        const REMOTE_TICK = PEER.clockSequence === null ? this.tick : PEER.tick + AGE + PEER.rtt / 2 * RATE;
        const PEER_LEAD_TICKS = Math.ceil(Math.floor(REMOTE_TICK) + LEAD - this.tick);
        delay = Math.max(delay, Math.ceil(LEAD), PEER_LEAD_TICKS);
        details?.push({
          peerId: PEER.id,
          rttMs: PEER.rtt,
          oneWayMs: ONE_WAY_MS,
          rttJitterMs: PEER.jitter,
          jitterMarginMs: JITTER_MARGIN_MS,
          safetyMarginMs: this.profile.inputSafetyMarginMs,
          reportedTick: PEER.tick,
          reportAgeMs: AGE / RATE,
          estimatedPeerTick: REMOTE_TICK,
          integerPeerTick: Math.floor(REMOTE_TICK),
          leadTicks: LEAD,
          peerLeadTicks: PEER_LEAD_TICKS
        });
      }
    }
    return Math.min(this.profile.maxInputDelayTicks, delay);
  }
  /** Reserve execution ticks at the event boundary; frame sealing cannot move them. */
  submitInput(input, { commands = [] } = {}) {
    if (this.closed || this._failure) {
      throw new Error("session unavailable");
    }
    const HELD = bytes(input);
    if (HELD.length !== this.inputSize) {
      throw new RangeError("inputSize");
    }
    if (!Array.isArray(commands) || commands.length > 0 && this._pendingCommands.length + commands.length > this.profile.maxPendingCommands) {
      throw new RangeError("command capacity");
    }
    const PAYLOADS = commands.map((payload) => {
      const VALUE = bytes(payload);
      if (!VALUE.length || VALUE.length > Math.min(this.profile.maxCommandBytes, CHUNK_SIZE - 1024 - this.inputSize - 6)) {
        throw new RangeError("command capacity");
      }
      return VALUE.slice();
    });
    integer(this._commandSequence + PAYLOADS.length, "command sequence");
    const CHANGED = PAYLOADS.length > 0 || !equalBytes(HELD, this._lastLocalInput);
    const SCHEDULE = CHANGED ? {
      policy: this.profile.inputScheduling,
      localTick: this.tick,
      nextOpenTick: this._through.get(this.localPlayerId) + 1,
      lastReservedTick: Math.max(-1, ...this._localReservations.keys()),
      peers: []
    } : void 0;
    const DELAY = this._schedulingDelay(this._clock(), SCHEDULE?.peers);
    if (SCHEDULE) {
      SCHEDULE.delayTicks = DELAY;
    }
    if (this.profile.inputScheduling === "network") {
      this._requestedInputDelay = DELAY;
      if (DELAY !== this.inputDelay) {
        this._applyInputDelay(DELAY);
      }
    }
    const TICK = integer(
      Math.max(this.tick + DELAY, this._through.get(this.localPlayerId) + 1, ...this._localReservations.keys()),
      "input reservation tick",
      0,
      MAX_TICK
    );
    if (!PAYLOADS.length && equalBytes(HELD, this._lastLocalInput)) {
      return {
        status: "unchanged",
        tick: this.tick,
        executeTick: TICK,
        commandSequences: [],
        commands: []
      };
    }
    const UPDATES = /* @__PURE__ */ new Map(), SCHEDULED = [];
    const FRAME_AT = (t) => {
      if (!UPDATES.has(t)) {
        const PRIOR = this._localReservations.get(t);
        UPDATES.set(t, {
          tick: t,
          input: HELD.slice(),
          commands: PRIOR?.commands.slice() ?? [],
          schedule: {
            ...SCHEDULE,
            executeTick: t
          }
        });
      }
      return UPDATES.get(t);
    };
    FRAME_AT(TICK);
    let target = TICK;
    let sequence = this._commandSequence;
    for (const PAYLOAD of PAYLOADS) {
      let frame = FRAME_AT(target);
      while (frame.commands.length >= this.profile.maxPendingCommands || frame.commands.reduce((n, c) => n + c.payload.length + 6, 0) + PAYLOAD.length + 6 > CHUNK_SIZE - 1024 - this.inputSize) {
        target = integer(
          target + 1,
          "command reservation horizon",
          0,
          Math.min(MAX_TICK, this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks)
        );
        frame = FRAME_AT(target);
      }
      const COMMAND = {
        sequence: ++sequence,
        executeTick: target,
        payload: PAYLOAD
      };
      frame.commands.push(COMMAND);
      SCHEDULED.push(COMMAND);
    }
    this._commandSequence = sequence;
    this._lastLocalInput = HELD.slice();
    this._pendingCommands.push(...SCHEDULED);
    for (const FRAME of UPDATES.values()) {
      this._publishReservation(FRAME);
    }
    return {
      status: "submitted",
      tick: this.tick,
      executeTick: TICK,
      commandSequences: SCHEDULED.map((c) => c.sequence),
      commands: SCHEDULED.map(({ sequence: sequence2, executeTick }) => ({
        sequence: sequence2,
        executeTick
      }))
    };
  }
  _publishReservation(frame) {
    frame.revision = integer(++this._reservationRevision, "input reservation revision", 1, MAX_TICK);
    frame.packet = null;
    this._localReservations.set(frame.tick, frame);
    this._metrics.inputReservations++;
    for (const PEER of this._peers.values()) {
      if (PEER.ready) {
        this._sendReservation(PEER, frame, this._clock());
      }
    }
    this._event("input-submitted", {
      executeTick: frame.tick,
      revision: frame.revision,
      schedule: frame.schedule,
      commands: frame.commands.map(({ sequence, executeTick }) => ({
        sequence,
        executeTick
      }))
    });
  }
  _sendReservation(peer, frame, now) {
    if ((peer.reservationAcks?.get(frame.tick) ?? 0) >= frame.revision) {
      return;
    }
    frame.packet ??= packet(TYPE.INPUT_RESERVATION, this._nextSequence(), (w) => {
      w.u32(frame.tick);
      w.u32(frame.revision);
      w.u16(this.inputSize);
      w.raw(frame.input);
      w.u16(frame.commands.length);
      for (const COMMAND of frame.commands) {
        w.u32(COMMAND.sequence);
        w.u16(COMMAND.payload.length);
        w.raw(COMMAND.payload);
      }
    });
    if (this._send(peer, frame.packet)) {
      peer.lastReservationSent = now;
      this._metrics.inputReservationSentBytes += frame.packet.length;
    }
  }
  _receiveReservation(peer, r) {
    const TICK = r.u32(), REVISION = r.u32(), SIZE = r.u16();
    if (!REVISION || REVISION > MAX_TICK || SIZE !== this.inputSize || TICK > MAX_TICK || TICK > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks) {
      throw new RangeError("input reservation timeline");
    }
    const INPUT_LOCAL = r.raw(SIZE), COUNT = r.u16(), COMMANDS = [];
    if (COUNT > this.profile.maxPendingCommands) {
      throw new RangeError("input reservation commands");
    }
    let previous = 0;
    for (let n = 0; n < COUNT; n++) {
      const SEQUENCE = r.u32(), LENGTH = r.u16();
      if (!SEQUENCE || SEQUENCE <= previous || !LENGTH || LENGTH > this.profile.maxCommandBytes) {
        throw new RangeError("input reservation command order");
      }
      previous = SEQUENCE;
      COMMANDS.push({
        sequence: SEQUENCE,
        executeTick: TICK,
        payload: r.raw(LENGTH)
      });
    }
    r.end();
    this._send(
      peer,
      packet(TYPE.INPUT_RESERVATION_ACK, this._nextSequence(), (w) => {
        w.u32(TICK);
        w.u32(REVISION);
      })
    );
    const ACTUAL = this._inputs.get(peer.id).get(TICK);
    if (ACTUAL || TICK < Math.max(0, this.tick - this.profile.stateHistorySize + 1)) {
      return;
    }
    peer.reservations ??= /* @__PURE__ */ new Map();
    peer.reservedCommands ??= /* @__PURE__ */ new Map();
    const PRIOR = peer.reservations.get(TICK);
    if (PRIOR && REVISION <= PRIOR.revision) {
      return;
    }
    for (const COMMAND of COMMANDS) {
      const KNOWN = peer.reservedCommands.get(COMMAND.sequence);
      if (KNOWN && (KNOWN.executeTick !== TICK || !equalBytes(KNOWN.payload, COMMAND.payload))) {
        throw new Error("reserved command is immutable");
      }
    }
    if (PRIOR && PRIOR.commands.some(
      (c) => !COMMANDS.some((n) => n.sequence === c.sequence && equalBytes(n.payload, c.payload))
    )) {
      throw new Error("reserved command cannot be removed");
    }
    const FRAME = {
      tick: TICK,
      input: INPUT_LOCAL,
      commands: COMMANDS,
      revision: REVISION
    };
    peer.reservations.set(TICK, FRAME);
    for (const COMMAND of COMMANDS) {
      peer.reservedCommands.set(COMMAND.sequence, COMMAND);
    }
    const USED = this._used.get(TICK)?.find((frame) => frame.playerId === peer.id);
    if (USED && !frameEqual(USED, FRAME)) {
      if (!this._history.get(TICK)) {
        this.requestResync(this.confirmedBoundary);
      } else {
        this._rollbackFrom = Math.min(this._rollbackFrom, TICK);
      }
    }
    this._event("input-received", {
      peerId: peer.id,
      executeTick: TICK,
      revision: REVISION,
      provisional: true
    });
  }
  /** Copy unexecuted local commands for a new fixed-roster epoch. */
  exportLocalCommandState({ fromTick = this.confirmedBoundary } = {}) {
    if (this.closed || this.resimulating) {
      throw new Error("local command state is unavailable");
    }
    const BASELINE = this.getCommandSequences(fromTick)[this.localPlayerId];
    const COMMANDS = /* @__PURE__ */ new Map();
    const INCLUDE = (command) => {
      const PRIOR = COMMANDS.get(command.sequence);
      if (PRIOR && (PRIOR.executeTick !== command.executeTick || !equalBytes(PRIOR.payload, command.payload))) {
        throw new Error("conflicting local command sequence");
      }
      if (!PRIOR) {
        COMMANDS.set(command.sequence, command);
      }
    };
    for (const [TICK, FRAME] of this._inputs.get(this.localPlayerId)) {
      if (TICK >= fromTick) {
        for (const COMMAND of FRAME.commands) {
          INCLUDE(COMMAND);
        }
      }
    }
    for (const COMMAND of this._pendingCommands) {
      INCLUDE(COMMAND);
    }
    const INPUTS = new Map(
      [...this._inputs.get(this.localPlayerId)].filter(([tick]) => tick >= fromTick).map(([tick, frame]) => [
        tick,
        {
          tick,
          input: frame.input
        }
      ])
    );
    for (const [TICK, FRAME] of this._localReservations) {
      if (TICK >= fromTick) {
        INPUTS.set(TICK, {
          tick: TICK,
          input: FRAME.input
        });
      }
    }
    return copyLocalCommandState(
      {
        sequence: this._commandSequence,
        lastInput: this._lastLocalInput,
        sealedThrough: this._through.get(this.localPlayerId),
        inputs: [...INPUTS.values()].sort((a, b) => a.tick - b.tick),
        commands: [...COMMANDS.values()].sort((a, b) => a.sequence - b.sequence)
      },
      this.inputSize,
      this.profile,
      BASELINE
    );
  }
  /** Command maxima immediately before a confirmed boundary in either mode. */
  getCommandSequences(tick = this.confirmedBoundary) {
    integer(tick, "confirmed command boundary", 0, this.confirmedBoundary);
    if (this.resimulating) {
      throw new Error("confirmed command boundary is unavailable");
    }
    let sequences = tick === this.tick ? this._commandSequences : this._history.get(tick)?.commandSequences;
    if (!sequences && this.profile.mode === "lockstep") {
      const BASE = this._history.atOrBefore(tick);
      if (BASE) {
        sequences = BASE.commandSequences;
        for (let t = BASE.tick; t < tick; t++) {
          const INPUTS = this.players.map((id) => {
            const FRAME = this._inputs.get(id).get(t);
            return FRAME ? {
              ...FRAME,
              playerId: id
            } : void 0;
          });
          if (INPUTS.some((frame) => !frame)) {
            throw new Error("command boundary inputs expired");
          }
          sequences = executedSequences(sequences, INPUTS);
        }
      }
    }
    if (!sequences) {
      throw new Error("command boundary expired");
    }
    return Object.fromEntries(sequences);
  }
  setInputDelay(ticks) {
    integer(ticks, "input delay", this.profile.minInputDelayTicks, this.profile.maxInputDelayTicks);
    this._requestedInputDelay = ticks;
    if (ticks > this.inputDelay) {
      this._applyInputDelay(ticks);
    }
  }
  _applyInputDelay(ticks) {
    const PREVIOUS = this.inputDelay;
    this._inputDelay = ticks;
    this._event("input-delay", {
      previous: PREVIOUS,
      value: ticks
    });
  }
  _sealLocal(tick, fallback) {
    const RESERVED = this._localReservations.get(tick);
    const INPUT_LOCAL = RESERVED?.input ?? fallback;
    const COMMANDS = this._pendingCommands.filter((c) => c.executeTick === tick);
    if (this._pendingCommands.some((c) => c.executeTick < tick)) {
      throw new Error("reserved command missed its execution tick");
    }
    this._pendingCommands = this._pendingCommands.filter((c) => c.executeTick !== tick);
    this._commitLocal(tick, INPUT_LOCAL, COMMANDS);
    this._localReservations.delete(tick);
    this._localCapture = {
      sequence: ++this._localCaptureSequence,
      captureTick: this.tick,
      executeTick: tick,
      input: INPUT_LOCAL.slice(),
      commands: COMMANDS.map((c) => ({
        ...c,
        payload: c.payload.slice()
      }))
    };
    this._localCaptures.push(this._localCapture);
    this._localCaptures = this._localCaptures.filter((c) => c.executeTick >= Math.max(0, this.tick - 1));
    return INPUT_LOCAL;
  }
  _capture(input) {
    this.submitInput(input);
    if (this._captureTick === this.tick) {
      return;
    }
    this._captureTick = this.tick;
    const THROUGH = this._through.get(this.localPlayerId);
    let held = this._inputs.get(this.localPlayerId).get(THROUGH)?.input ?? this._lastLocalInput;
    if (this.profile.inputScheduling === "configured" && this._requestedInputDelay < this.inputDelay && equalBytes(this._lastLocalInput, held) && !this._pendingCommands.length) {
      this._applyInputDelay(this.inputDelay - 1);
    }
    const TARGET = integer(this.tick + this.inputDelay, "session tick limit", 0, MAX_TICK);
    for (let t = THROUGH + 1; t <= TARGET; t++) {
      held = this._sealLocal(t, held);
    }
  }
  releaseInput() {
    if (this.closed || this._failure) {
      return;
    }
    const RECEIPT = this.submitInput(new Uint8Array(this.inputSize));
    let held = this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId))?.input ?? this._lastLocalInput;
    for (let t = this._through.get(this.localPlayerId) + 1; t <= RECEIPT.executeTick; t++) {
      held = this._sealLocal(t, held);
    }
    for (const PEER of this._peers.values()) {
      if (PEER.ready) {
        this._sendInputs(PEER);
      }
    }
    this._event("input-release", {
      executeTick: RECEIPT.executeTick
    });
  }
  _sendInputs(peer) {
    const MAP = this._inputs.get(this.localPlayerId);
    const FIRST = peer.ack + 1;
    if (!MAP.has(FIRST)) {
      return;
    }
    const FRAMES = [];
    let cost = HEADER + 16;
    for (let t = FIRST; FRAMES.length < 128 && MAP.has(t); t++) {
      const F = MAP.get(t);
      const N = 7 + this.inputSize + F.commands.reduce((s, c) => s + 6 + c.payload.length, 0);
      if (cost + N > CHUNK_SIZE) {
        break;
      }
      FRAMES.push(F);
      cost += N;
    }
    if (!FRAMES.length) {
      return;
    }
    this._send(
      peer,
      packet(TYPE.INPUT, this._nextSequence(), (w) => {
        w.u32(FIRST);
        w.u16(FRAMES.length);
        w.u16(this.inputSize);
        w.i32(this._through.get(peer.id));
        w.u32(this.tick);
        for (let i = 0; i < FRAMES.length; ) {
          const F = FRAMES[i];
          let run = 1;
          while (i + run < FRAMES.length && !FRAMES[i + run].commands.length && equalBytes(F.input, FRAMES[i + run].input)) {
            run++;
          }
          w.u16(run);
          w.raw(F.input);
          w.u16(F.commands.length);
          for (const C of F.commands) {
            w.u32(C.sequence);
            w.u16(C.payload.length);
            w.raw(C.payload);
          }
          i += run;
        }
      })
    );
  }
  _sendClock(peer, now, replyTo) {
    const ID = this._nextSequence();
    const DATA = packet(TYPE.CLOCK, ID, (w) => {
      w.u32(this.tick);
      w.i32(this.confirmedTick);
      w.i32(this._through.get(peer.id));
      w.u32(replyTo ?? 0);
      w.u8(replyTo === void 0 ? 0 : 1);
    });
    if (this._send(peer, DATA)) {
      if (replyTo === void 0) {
        peer.pendingPings.set(ID, now);
        peer.lastSent = now;
      }
      while (peer.pendingPings.size > 32) {
        peer.pendingPings.delete(peer.pendingPings.keys().next().value);
      }
    }
  }
  poll(now = this._clock()) {
    if (this.closed || this._failure) {
      return;
    }
    if (!Number.isFinite(now)) {
      throw new TypeError("network time");
    }
    for (const PEER of this._peers.values()) {
      this._peerLiveness(PEER, now);
      if (!PEER.ready) {
        if (now - PEER.lastHello >= this.profile.heartbeatMs) {
          this._sendHello(PEER, now);
        }
        continue;
      }
      if (now - (PEER.lastReservationSent ?? -Infinity) >= this.profile.heartbeatMs) {
        for (const FRAME of this._localReservations.values()) {
          this._sendReservation(PEER, FRAME, now);
        }
      }
      if (now - PEER.lastSent >= this.profile.heartbeatMs) {
        this._sendInputs(PEER);
        this._sendClock(PEER, now);
      }
      let sent = 0;
      while (PEER.controls.length && sent < 65536) {
        const DATA = PEER.controls[0];
        if (!this._send(PEER, DATA)) {
          break;
        }
        PEER.controls.shift();
        PEER.queuedBytes -= DATA.length;
        sent += DATA.length;
      }
    }
    if (this._incomingSnapshot && now - this._incomingSnapshot.started > this.profile.recoveryTimeoutMs) {
      this._rejectSnapshot("snapshot timeout");
    }
    if (this._requestedRecovery && now - this._requestedRecovery.at > this.profile.recoveryTimeoutMs) {
      this._requestedRecovery = null;
      this._event("recovery-timeout");
      this._recoveryExhausted("timeout");
    }
    if (this._failure) {
      return;
    }
    if (this.resimulating) {
      this._rollback();
    }
    if (this._failure) {
      return;
    }
    this._adapt(now);
    this._sendHashes();
    this._checkHashes();
    this._recordConfirmed();
  }
  receive(peerId, data, now = this._clock()) {
    if (this.closed || this._failure) {
      return false;
    }
    const PEER = this._peers.get(peerId);
    if (!PEER || ["closed", "failed"].includes(PEER.transportState)) {
      return false;
    }
    try {
      const B = bytes(data);
      if (B.length < HEADER || B.length > CHUNK_SIZE) {
        throw new RangeError("packet size");
      }
      const R = new Reader(B);
      if (R.u32() !== MAGIC) {
        throw new Error("protocol magic");
      }
      const PROTOCOL_VERSION_LOCAL = R.u8();
      if (PROTOCOL_VERSION_LOCAL !== PROTOCOL_VERSION) {
        this._event("version-mismatch", {
          peerId,
          field: "protocol",
          expected: PROTOCOL_VERSION,
          received: PROTOCOL_VERSION_LOCAL
        });
        throw new Error("protocol version");
      }
      const TYPE_LOCAL = R.u8();
      if (R.u16() !== 0) {
        throw new Error("reserved header");
      }
      const SEQUENCE = R.u32();
      this._metrics.receivedBytes += B.length;
      if (TYPE_LOCAL === TYPE.HELLO) {
        const HELLO_LOCAL = R.raw(B.length - HEADER);
        R.end();
        if (!equalBytes(HELLO_LOCAL, this._hello)) {
          const EXPECTED = JSON.parse(DECODER.decode(this._hello)), RECEIVED = JSON.parse(DECODER.decode(HELLO_LOCAL));
          const FIELDS = Object.keys(EXPECTED).filter(
            (field) => JSON.stringify(EXPECTED[field]) !== JSON.stringify(RECEIVED?.[field])
          );
          if (!FIELDS.length) {
            throw new Error("noncanonical HELLO");
          }
          const TYPE_LOCAL2 = FIELDS.some(
            (field) => ["protocol", "library", "simulationVersion"].includes(field)
          ) ? "version-mismatch" : "handshake-mismatch";
          this._fail(TYPE_LOCAL2, {
            peerId,
            fields: Object.freeze(FIELDS),
            mismatches: Object.freeze(
              FIELDS.map(
                (field) => Object.freeze({
                  field,
                  expected: EXPECTED[field],
                  received: RECEIVED?.[field]
                })
              )
            )
          });
          return false;
        }
        const WAS_READY = PEER.ready;
        PEER.ready = true;
        this._peerAlive(PEER, SEQUENCE, now);
        if (!WAS_READY) {
          this._sendHello(PEER, now);
          this._event("peer-ready", {
            peerId
          });
        }
        return true;
      }
      if (!PEER.ready) {
        return false;
      }
      if (TYPE_LOCAL === TYPE.INPUT) {
        this._receiveInputs(PEER, R, SEQUENCE, now);
      } else if (TYPE_LOCAL === TYPE.INPUT_RESERVATION) {
        this._receiveReservation(PEER, R);
        this._metrics.inputReservationReceivedBytes += B.length;
      } else if (TYPE_LOCAL === TYPE.INPUT_RESERVATION_ACK) {
        const TICK = R.u32(), REVISION = R.u32();
        R.end();
        if (!REVISION || REVISION > this._reservationRevision || TICK > MAX_TICK) {
          throw new RangeError("input reservation acknowledgement");
        }
        PEER.reservationAcks ??= /* @__PURE__ */ new Map();
        PEER.reservationAcks.set(TICK, Math.max(PEER.reservationAcks.get(TICK) ?? 0, REVISION));
      } else if (TYPE_LOCAL === TYPE.CLOCK) {
        this._receiveClock(PEER, R, SEQUENCE, now);
      } else if (TYPE_LOCAL === TYPE.HASH) {
        const TICK = R.u32(), HASH_LOCAL = R.u32(), INPUT_HASH = R.u32();
        R.end();
        if (TICK <= this.tick + this.profile.stateHistorySize && TICK >= Math.max(0, this.tick - this.profile.stateHistorySize + 1)) {
          PEER.hashes.set(TICK, {
            hash: HASH_LOCAL,
            inputHash: INPUT_HASH
          });
        }
      } else if (TYPE_LOCAL === TYPE.REQUEST) {
        const TICK = R.u32();
        R.end();
        this._sendSnapshot(PEER, TICK);
      } else if (TYPE_LOCAL === TYPE.BEGIN) {
        this._beginSnapshot(PEER, R, now);
      } else if (TYPE_LOCAL === TYPE.CHUNK) {
        this._snapshotChunk(PEER, R);
      } else {
        throw new Error("unknown packet type");
      }
      this._peerAlive(PEER, SEQUENCE, now);
      if (this._rollbackFrom !== Infinity && !this._replaying && !this._requestedRecovery) {
        this._rollback();
      }
      return true;
    } catch (error) {
      this._metrics.rejectedPackets++;
      this._event("protocol-error", {
        peerId,
        error
      });
      return false;
    }
  }
  _receiveInputs(peer, r, sequence, now) {
    const FIRST = r.u32(), COUNT = r.u16(), SIZE = r.u16(), ACK = r.i32(), SIM_TICK = r.u32();
    if (!COUNT || COUNT > 128 || SIZE !== this.inputSize || FIRST + COUNT - 1 > MAX_TICK || FIRST + COUNT > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks + 1) {
      throw new RangeError("input timeline");
    }
    if (ACK < -1 || ACK > this._through.get(this.localPlayerId)) {
      throw new RangeError("ack");
    }
    const INCOMING = [];
    while (INCOMING.length < COUNT) {
      const RUN = r.u16();
      if (!RUN || INCOMING.length + RUN > COUNT) {
        throw new RangeError("input run");
      }
      const INPUT_LOCAL = r.raw(SIZE), N = r.u16(), COMMANDS = [];
      if (N > this.profile.maxPendingCommands) {
        throw new RangeError("command count");
      }
      let previous = 0;
      for (let i = 0; i < N; i++) {
        const SEQUENCE = r.u32(), LEN = r.u16();
        if (!SEQUENCE || SEQUENCE <= previous || !LEN || LEN > this.profile.maxCommandBytes) {
          throw new RangeError("command shape/order");
        }
        previous = SEQUENCE;
        COMMANDS.push({
          sequence: SEQUENCE,
          executeTick: FIRST + INCOMING.length,
          payload: r.raw(LEN)
        });
      }
      INCOMING.push({
        input: INPUT_LOCAL,
        commands: COMMANDS
      });
      for (let j = 1; j < RUN; j++) {
        INCOMING.push({
          input: INPUT_LOCAL.slice(),
          commands: []
        });
      }
    }
    r.end();
    const MAP = this._inputs.get(peer.id);
    for (let i = 0; i < COUNT; i++) {
      for (const COMMAND of INCOMING[i].commands) {
        const RESERVED = peer.reservedCommands?.get(COMMAND.sequence);
        if (RESERVED && (RESERVED.executeTick !== FIRST + i || !equalBytes(RESERVED.payload, COMMAND.payload))) {
          throw new Error("canonical command moved its reserved tick");
        }
      }
      const PRIOR_RESERVATION = peer.reservations?.get(FIRST + i);
      if (PRIOR_RESERVATION?.commands.some(
        (c) => !INCOMING[i].commands.some(
          (n) => n.sequence === c.sequence && equalBytes(n.payload, c.payload)
        )
      )) {
        throw new Error("canonical command missing reservation");
      }
      const OLD = MAP.get(FIRST + i);
      if (OLD && !frameEqual(OLD, INCOMING[i])) {
        if (this.profile.mode === "lockstep" && FIRST + i < this.tick) {
          this._fail("desync-unrecoverable", {
            reason: "conflicting-confirmed-input",
            peerId: peer.id,
            inputTick: FIRST + i
          });
        }
        throw new Error("conflicting committed input");
      }
    }
    peer.ack = Math.max(peer.ack, ACK);
    if (peer.progressSequence === void 0 || sequence - peer.progressSequence >>> 0 < 2147483648 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence;
      peer.tick = SIM_TICK;
      peer.clockAt = now;
    }
    const OLDEST = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    for (let i = 0; i < COUNT; i++) {
      const T = FIRST + i;
      if (MAP.has(T) || T < OLDEST) {
        continue;
      }
      peer.reservedCommands ??= /* @__PURE__ */ new Map();
      for (const COMMAND of INCOMING[i].commands) {
        peer.reservedCommands.set(COMMAND.sequence, COMMAND);
      }
      MAP.set(T, INCOMING[i]);
      peer.reservations?.delete(T);
      this._window.received++;
      if (T < this.tick) {
        this._window.late++;
      }
      const USED = this._used.get(T)?.find((x) => x.playerId === peer.id);
      if (USED && T < this.tick && !frameEqual(USED, INCOMING[i])) {
        if (this.profile.mode === "lockstep") {
          this._fail("desync-unrecoverable", {
            reason: "conflicting-confirmed-input",
            peerId: peer.id,
            inputTick: T
          });
          return;
        }
        if (!this._history.get(T)) {
          this._event("history-exhausted", {
            inputTick: T
          });
          this.requestResync(Math.min(this.confirmedTick + 1, this.tick));
        } else {
          this._rollbackFrom = Math.min(this._rollbackFrom, T);
        }
      }
    }
    let through = this._through.get(peer.id);
    while (MAP.has(through + 1)) {
      through++;
    }
    this._through.set(peer.id, through);
  }
  _receiveClock(peer, r, sequence, now) {
    const TICK = r.u32(), CONFIRMED = r.i32(), ACK = r.i32(), ECHO = r.u32(), REPLY = r.u8();
    r.end();
    if (REPLY > 1) {
      throw new RangeError("clock reply flag");
    }
    if (TICK > MAX_TICK + 1 || CONFIRMED < -1 || CONFIRMED > ACK || ACK < -1 || ACK > this._through.get(this.localPlayerId)) {
      throw new RangeError("clock/ack");
    }
    const FRESH = peer.clockSequence === null || sequence - peer.clockSequence >>> 0 < 2147483648 && sequence !== peer.clockSequence;
    if (!FRESH) {
      return;
    }
    peer.clockSequence = sequence;
    peer.confirmed = CONFIRMED;
    if (peer.progressSequence === void 0 || sequence - peer.progressSequence >>> 0 < 2147483648 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence;
      peer.tick = TICK;
      peer.clockAt = now;
    }
    peer.ack = Math.max(peer.ack, ACK);
    peer.echo = sequence;
    if (!REPLY) {
      this._sendClock(peer, now, sequence);
    }
    const SENT = REPLY ? peer.pendingPings.get(ECHO) : void 0;
    if (SENT !== void 0 && now >= SENT) {
      const SAMPLE = now - SENT;
      peer.pendingPings.delete(ECHO);
      const DIFFERENCE = Math.abs(SAMPLE - peer.rtt);
      peer.rtt = peer.rtt ? peer.rtt * 0.875 + SAMPLE * 0.125 : SAMPLE;
      peer.jitter = peer.jitter * 0.75 + (peer.rtt === SAMPLE ? 0 : DIFFERENCE * 0.25);
      this._metrics.smoothedRTT = Math.max(...[...this._peers.values()].map((p) => p.rtt));
      this._metrics.jitter = Math.max(...[...this._peers.values()].map((p) => p.jitter));
    }
  }
  _resolve(tick) {
    return this.players.map((playerId) => {
      const MAP = this._inputs.get(playerId), ACTUAL = MAP.get(tick);
      if (ACTUAL) {
        return {
          playerId,
          ...copyFrame(ACTUAL),
          predicted: false
        };
      }
      if (this.profile.mode === "lockstep") {
        throw new Error("lockstep input is not confirmed");
      }
      const RESERVED = this._peers.get(playerId)?.reservations?.get(tick);
      if (RESERVED) {
        return {
          playerId,
          ...copyFrame(RESERVED),
          predicted: true
        };
      }
      let prior = this._used.get(tick - 1)?.find((f) => f.playerId === playerId)?.input ?? new Uint8Array(this.inputSize);
      const POLICY = this.profile.predictionPolicy;
      if (typeof POLICY === "function") {
        prior = bytes(
          POLICY({
            playerId,
            tick,
            previousInput: prior.slice(),
            lastConfirmedTick: this._through.get(playerId)
          })
        );
      } else if (POLICY === "neutral") {
        prior = new Uint8Array(this.inputSize);
      }
      if (prior.length !== this.inputSize) {
        throw new RangeError("predictor inputSize");
      }
      return {
        playerId,
        input: prior.slice(),
        commands: [],
        predicted: true
      };
    });
  }
  _restoreConfirmedBoundary(tick) {
    const BASE = this._history.atOrBefore(tick);
    if (!BASE) {
      throw new Error("lockstep recovery base expired");
    }
    this.adapter.load(BASE.bytes.slice());
    for (let t = BASE.tick; t < tick; t++) {
      runSimulationFrame(this.adapter, {
        tick: t,
        tickRate: this.profile.tickRate,
        inputs: this._resolve(t),
        resimulating: true,
        recovering: true
      });
    }
  }
  _replayFrameBytes(inputs) {
    return inputs.reduce(
      (s, f) => s + f.input.length + f.commands.reduce((k, c) => k + c.payload.length + 12, 0),
      16
    );
  }
  _step(inputs, resimulating) {
    const BEFORE = this._history?.get(this.tick);
    const TICK = this.tick, LOCKSTEP = this.profile.mode === "lockstep";
    integer(TICK, "session tick limit", 0, MAX_TICK);
    if (LOCKSTEP && this._recordReplay && this._replayBytes + this._replayFrameBytes(inputs) > this.profile.maxReplayBytes) {
      this._replayFinalHash = this._stateHash(this._stateAt(TICK));
      this._recordReplay = false;
      this._event("replay-capacity");
    }
    try {
      runSimulationFrame(this.adapter, {
        tick: TICK,
        tickRate: this.profile.tickRate,
        inputs,
        resimulating
      });
      const INPUT_HASH = this.localFastPath ? this._inputHash : this._hashInputFrame(TICK, inputs, this._inputHash);
      const COMMAND_SEQUENCES = executedSequences(this._commandSequences, inputs);
      if (!this.localFastPath && (!LOCKSTEP || (TICK + 1) % this.profile.checksumInterval === 0)) {
        const STATE = this._save();
        this._history.put({
          tick: TICK + 1,
          bytes: STATE,
          inputHash: INPUT_HASH,
          commandSequences: COMMAND_SEQUENCES
        });
      }
      if (!LOCKSTEP) {
        this._used.set(
          TICK,
          inputs.map((f) => ({
            ...copyFrame(f),
            playerId: f.playerId,
            predicted: f.predicted
          }))
        );
      }
      this._tick++;
      this._inputHash = INPUT_HASH;
      this._currentState = null;
      const LOCAL_FRAME = inputs.find((frame) => frame.playerId === this.localPlayerId);
      if (LOCAL_FRAME) {
        this._localExecutedInput = LOCAL_FRAME.input.slice();
      }
      this._commandSequences = COMMAND_SEQUENCES;
    } catch (error) {
      if (this.localFastPath) {
        this._currentState = null;
        this._fail("fatal", {
          error,
          restoreUnavailable: true
        });
        throw error;
      }
      try {
        if (BEFORE) {
          this.adapter.load(BEFORE.bytes.slice());
        } else if (LOCKSTEP) {
          this._restoreConfirmedBoundary(TICK);
        }
        if (LOCKSTEP) {
          this._currentState = {
            tick: TICK,
            bytes: this._save(),
            inputHash: this._inputHash
          };
        }
      } catch (restoreError) {
        this._currentState = null;
        this._fail("fatal", {
          error,
          restoreError
        });
        throw error;
      }
      this._fail("fatal", {
        error
      });
      throw error;
    }
  }
  _rollback() {
    const STARTED = NOW_MS();
    let reconciled;
    this._replaying = true;
    try {
      if (this._rollbackFrom !== Infinity) {
        const TARGET = this.tick, FROM = this._rollbackFrom;
        const SAVED = this._history.get(FROM);
        if (!SAVED) {
          throw new Error("rollback state expired");
        }
        this.adapter.load(SAVED.bytes.slice());
        this._tick = FROM;
        this._inputHash = SAVED.inputHash;
        this._commandSequences = SAVED.commandSequences;
        this._history.invalidateAfter(FROM);
        this._rollbackFrom = Infinity;
        this._metrics.rollbacks++;
        this._window.rollback++;
        this._metrics.maxRollbackDepth = Math.max(this._metrics.maxRollbackDepth, TARGET - FROM);
        this._window.depth = Math.max(this._window.depth, TARGET - FROM);
        this._event("rollback", {
          from: FROM,
          target: TARGET
        });
        while (this.tick < TARGET) {
          this._step(this._resolve(this.tick), true);
          this._metrics.resimulatedTicks++;
        }
        reconciled = {
          from: FROM,
          target: TARGET
        };
      }
      return true;
    } finally {
      this._replaying = false;
      this._metrics.latestResimulationMs = NOW_MS() - STARTED;
      this._window.cost += this._metrics.latestResimulationMs;
      this._window.costSamples++;
      if (reconciled) {
        this._event("reconciled", reconciled);
      }
    }
  }
  _frameAdvantage(now) {
    let advantage = -Infinity;
    for (const PEER of this._peers.values()) {
      if (PEER.ready && PEER.clockSequence !== null) {
        const AGE = Math.max(0, Math.min(1e3 / this.profile.tickRate, now - PEER.clockAt));
        const ESTIMATED = PEER.tick + (AGE + PEER.rtt / 2) * this.profile.tickRate / 1e3;
        advantage = Math.max(advantage, this.tick - ESTIMATED);
      }
    }
    return Number.isFinite(advantage) ? advantage : 0;
  }
  advance(input = this._lastLocalInput) {
    if (this.closed) {
      throw new Error("session closed");
    }
    const NOW = this._clock();
    this.poll(NOW);
    if (this._failure) {
      return {
        status: "failed",
        tick: this.tick,
        failure: this.failure
      };
    }
    if (["interrupted", "disconnected"].includes(this.status)) {
      return {
        status: this.status,
        tick: this.tick
      };
    }
    if (this._requestedRecovery) {
      return {
        status: "recovering",
        tick: this.tick
      };
    }
    if (this.resimulating) {
      return {
        status: "resimulating",
        tick: this.tick
      };
    }
    this._capture(input);
    for (const PEER of this._peers.values()) {
      if (PEER.ready) {
        this._sendInputs(PEER);
      }
    }
    if (!this.ready) {
      return {
        status: "synchronizing",
        tick: this.tick
      };
    }
    const ADVANTAGE = this._frameAdvantage(NOW);
    const THRESHOLD = this.profile.tickDriftThreshold;
    const HOLD = this.profile.pacingPolicy === "hold" && ADVANTAGE > THRESHOLD || this.profile.pacingPolicy === "dilation" && ADVANTAGE > Math.max(4, THRESHOLD * 3);
    if (HOLD) {
      this._metrics.holds++;
      return {
        status: "held",
        tick: this.tick
      };
    }
    if (this.profile.mode === "lockstep" && this.players.some((id) => !this._inputs.get(id).has(this.tick))) {
      this._metrics.stalls++;
      this._window.stall++;
      return {
        status: "stalled",
        tick: this.tick
      };
    }
    const INPUTS = this._resolve(this.tick), PREDICTED = INPUTS.some((f) => f.predicted);
    const MIN_ACK = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
    if (PREDICTED && this.tick - (this.confirmedTick + 1) >= this.profile.rollbackWindowTicks || this._through.get(this.localPlayerId) - MIN_ACK >= this.profile.stateHistorySize * 4) {
      this._metrics.stalls++;
      this._window.stall++;
      return {
        status: "stalled",
        tick: this.tick
      };
    }
    this._step(INPUTS, false);
    this._window.advances++;
    if (PREDICTED) {
      this._metrics.predictedTicks++;
    }
    this._recordConfirmed();
    this._sendHashes();
    this._checkHashes();
    this._prune();
    return {
      status: "advanced",
      tick: this.tick
    };
  }
  _adapt(now) {
    if (this._lastAdaptation === null) {
      this._lastAdaptation = now;
      return;
    }
    if (now - this._lastAdaptation < this.profile.adaptationIntervalMs) {
      return;
    }
    const SECONDS = (now - this._lastAdaptation) / 1e3;
    this._lastAdaptation = now;
    const W = this._window;
    const LATE_RATE = W.received ? W.late / W.received : 0;
    this._metrics.lateInputRate = this._metrics.lateInputRate * 0.75 + LATE_RATE * 0.25;
    this._metrics.rollbackFrequency = this._metrics.rollbackFrequency * 0.75 + W.rollback / SECONDS * 0.25;
    this._metrics.stallFrequency = this._metrics.stallFrequency * 0.75 + W.stall / SECONDS * 0.25;
    const COST = W.costSamples ? W.cost / W.costSamples : 0;
    this._metrics.resimulationCostMs = this._metrics.resimulationCostMs * 0.75 + COST * 0.25;
    if (this.profile.adaptiveInputDelay && this.profile.inputScheduling === "configured") {
      const MEASURED = Math.ceil(
        (this._metrics.smoothedRTT / 2 + 2 * this._metrics.jitter) * this.profile.tickRate / 1e3
      );
      const PRESSURE = this._metrics.lateInputRate > 0.1 || this._metrics.rollbackFrequency > 2 || W.depth > 3 || this._metrics.stallFrequency > 2 || this._metrics.resimulationCostMs > 1e3 / this.profile.tickRate;
      if (PRESSURE || MEASURED > this.inputDelay + 1) {
        this.setInputDelay(Math.min(this.profile.maxInputDelayTicks, Math.max(this.inputDelay + 1, MEASURED)));
        this._stableWindows = 0;
      } else if (W.advances > 0 && !W.late && !W.stall && MEASURED <= this.inputDelay - 1) {
        if (++this._stableWindows >= 3) {
          this.setInputDelay(Math.max(this.profile.minInputDelayTicks, this.inputDelay - 1));
          this._stableWindows = 0;
        }
      } else {
        this._stableWindows = 0;
      }
    }
    if (this.profile.pacingPolicy === "dilation") {
      const DRIFT = this._frameAdvantage(now);
      const TARGET = Math.abs(DRIFT) < 0.5 ? 1 : Math.max(0.98, Math.min(1.05, 1 + DRIFT * 5e-3));
      const CHANGE = Math.max(-5e-3, Math.min(5e-3, (TARGET - this._pace) * 0.2));
      this._pace = Math.max(0.98, Math.min(1.05, this._pace + CHANGE));
    }
    this._window = {
      advances: 0,
      received: 0,
      late: 0,
      depth: 0,
      rollback: 0,
      stall: 0,
      cost: 0,
      costSamples: 0
    };
  }
  _sendHashes() {
    if (this.localFastPath || this.resimulating) {
      return;
    }
    const UP_TO = Math.min(this.tick, this.confirmedTick + 1);
    const T = Math.floor(UP_TO / this.profile.checksumInterval) * this.profile.checksumInterval;
    if (!T) {
      return;
    }
    const S = this._history.get(T);
    if (!S) {
      return;
    }
    for (const PEER of this._peers.values()) {
      if (PEER.ready && PEER.lastHashQueued < T) {
        if (this._queue(
          PEER,
          packet(TYPE.HASH, this._nextSequence(), (w) => {
            w.u32(T);
            w.u32(this._stateHash(S));
            w.u32(S.inputHash);
          })
        )) {
          PEER.lastHashQueued = T;
        }
      }
    }
  }
  _checkHashes() {
    if (this.localFastPath || this.resimulating) {
      return;
    }
    for (const PEER of this._peers.values()) {
      for (const [TICK, REMOTE] of PEER.hashes) {
        if (TICK > Math.min(this.tick, this.confirmedTick + 1)) {
          continue;
        }
        const LOCAL = this._history.get(TICK);
        if (!LOCAL) {
          PEER.hashes.delete(TICK);
          continue;
        }
        if (LOCAL.inputHash !== REMOTE.inputHash) {
          PEER.hashes.delete(TICK);
          this._event("input-history-mismatch", {
            peerId: PEER.id,
            at: TICK
          });
          if (this.profile.mode === "lockstep") {
            this._fail("desync-unrecoverable", {
              reason: "input-history-mismatch",
              peerId: PEER.id,
              at: TICK
            });
          }
          continue;
        }
        if (this._stateHash(LOCAL) !== REMOTE.hash) {
          if (!REMOTE.notified) {
            REMOTE.notified = true;
            this._metrics.hashMismatches++;
            this._event("desync", {
              peerId: PEER.id,
              at: TICK
            });
          }
          if (this._roomRecovery) {
            this._roomRecovery(TICK);
            PEER.hashes.delete(TICK);
          } else if (this.localPlayerId === this.authorityPlayerId || this.requestResync(TICK)) {
            PEER.hashes.delete(TICK);
          }
        } else {
          PEER.hashes.delete(TICK);
        }
      }
    }
  }
  getStateHash(tick = this.tick) {
    return this._stateHash(this._stateAt(tick));
  }
  /** Export the requested confirmed boundary, never the predicted present. */
  exportConfirmedBootstrap({ tick = this.confirmedBoundary, checkpointAtOrBefore = tick } = {}) {
    if (this.localFastPath) {
      throw new Error("confirmed bootstrap unavailable in local fast path");
    }
    if (this.closed || this._failure || this.resimulating || this._requestedRecovery) {
      throw new Error("confirmed boundary is required");
    }
    integer(tick, "bootstrap confirmed boundary", 0, this.confirmedBoundary);
    integer(checkpointAtOrBefore, "bootstrap checkpoint boundary", 0, tick);
    const CHECKPOINT = this.profile.mode === "lockstep" ? this._history.atOrBefore(checkpointAtOrBefore) : this._history.get(checkpointAtOrBefore);
    if (!CHECKPOINT || tick - CHECKPOINT.tick > this.profile.stateHistorySize) {
      throw new Error("bootstrap checkpoint is unavailable");
    }
    const FRAMES = [];
    for (let frameTick = CHECKPOINT.tick; frameTick < tick; frameTick++) {
      const INPUTS = this.players.map((playerId) => {
        const FRAME = this._inputs.get(playerId).get(frameTick);
        if (!FRAME) {
          throw new Error("confirmed bootstrap input is unavailable");
        }
        return {
          playerId,
          ...copyFrame(FRAME),
          predicted: false
        };
      });
      FRAMES.push({
        tick: frameTick,
        inputs: INPUTS
      });
    }
    return {
      version: 1,
      tick,
      checkpoint: {
        tick: CHECKPOINT.tick,
        bytes: CHECKPOINT.bytes.slice(),
        hash: this._stateHash(CHECKPOINT)
      },
      players: [...this.players],
      frames: FRAMES,
      hash: this.getStateHash(tick),
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      commandSequences: this.getCommandSequences(tick)
    };
  }
  /** Fence a donor against retained confirmed history and immutable local inputs. */
  verifyConfirmedBootstrap(bootstrap) {
    if (this.localFastPath) {
      throw new Error("confirmed bootstrap unavailable in local fast path");
    }
    if (this.closed || this._failure || this.resimulating || !bootstrap || bootstrap.tick < this.confirmedBoundary || bootstrap.tick - bootstrap.checkpoint?.tick > this.profile.stateHistorySize || !Array.isArray(bootstrap.frames) || bootstrap.frames.length !== bootstrap.tick - bootstrap.checkpoint.tick || JSON.stringify(bootstrap.players) !== JSON.stringify(this.players)) {
      throw new Error("resume bootstrap boundary");
    }
    const BASE = this._history.get(bootstrap.checkpoint.tick);
    if (!BASE || BASE.tick > this.confirmedBoundary || this._stateHash(BASE) !== bootstrap.checkpoint.hash || !equalBytes(BASE.bytes, bytes(bootstrap.checkpoint.bytes))) {
      throw new Error("resume checkpoint does not match retained agreement");
    }
    const SEQUENCES = new Map(BASE.commandSequences);
    for (let i = 0; i < bootstrap.frames.length; i++) {
      const FRAME = bootstrap.frames[i], TICK = BASE.tick + i;
      if (FRAME.tick !== TICK || FRAME.inputs?.length !== this.players.length) {
        throw new Error("resume input suffix shape");
      }
      for (let p = 0; p < this.players.length; p++) {
        const ID = this.players[p], INCOMING = FRAME.inputs[p], KNOWN = this._inputs.get(ID).get(TICK);
        if (INCOMING?.playerId !== ID || INCOMING.predicted || !Array.isArray(INCOMING.commands) || !KNOWN && (TICK < this.confirmedBoundary || ID === this.localPlayerId) || KNOWN && !frameEqual(KNOWN, INCOMING)) {
          throw new Error("resume input conflicts with retained agreement");
        }
        for (const COMMAND of INCOMING.commands) {
          SEQUENCES.set(ID, Math.max(SEQUENCES.get(ID), COMMAND.sequence));
        }
      }
    }
    for (const ID of this.players) {
      if (bootstrap.commandSequences?.[ID] !== SEQUENCES.get(ID)) {
        throw new Error("resume command sequence conflicts with retained agreement");
      }
    }
    if (bootstrap.tick === this.confirmedBoundary && bootstrap.hash !== this.getStateHash(bootstrap.tick)) {
      throw new Error("resume final state conflicts with confirmed boundary");
    }
    return true;
  }
  requestResync(tick) {
    if (this.localFastPath) {
      return false;
    }
    if (this.closed || this._failure) {
      return false;
    }
    integer(tick, "recovery tick", 0, Math.min(this.tick, this.confirmedTick + 1));
    if (this.localPlayerId === this.authorityPlayerId) {
      return false;
    }
    const PEER = this._peers.get(this.authorityPlayerId);
    if (!PEER?.ready || this._requestedRecovery) {
      return false;
    }
    if (this._recoveryExhausted("attempt-limit")) {
      return false;
    }
    const STATE = this.profile.mode === "lockstep" ? this._history.atOrBefore(tick) : this._history.get(tick);
    if (!STATE) {
      return false;
    }
    tick = STATE.tick;
    if (!this._queue(
      PEER,
      packet(TYPE.REQUEST, this._nextSequence(), (w) => w.u32(tick))
    )) {
      return false;
    }
    this._requestedRecovery = {
      tick,
      inputHash: STATE.inputHash,
      at: this._clock()
    };
    this._recoveryAttempts++;
    return true;
  }
  _sendSnapshot(peer, tick) {
    if (this.localPlayerId !== this.authorityPlayerId || this.resimulating || tick > this.confirmedTick + 1) {
      return;
    }
    const STATE = this._history.get(tick);
    if (!STATE) {
      return;
    }
    const TRANSFER = ++this._nextTransfer >>> 0, COUNT = Math.ceil(STATE.bytes.length / SNAP_CHUNK_BYTES);
    const PACKETS = [
      packet(TYPE.BEGIN, this._nextSequence(), (w) => {
        w.u32(TRANSFER);
        w.u32(tick);
        w.u32(STATE.bytes.length);
        w.u32(this._stateHash(STATE));
        w.u32(STATE.inputHash);
        w.u16(COUNT);
      })
    ];
    for (let i = 0; i < COUNT; i++) {
      PACKETS.push(
        packet(TYPE.CHUNK, this._nextSequence(), (w) => {
          w.u32(TRANSFER);
          w.u32(i);
          w.raw(STATE.bytes.subarray(i * SNAP_CHUNK_BYTES, (i + 1) * SNAP_CHUNK_BYTES));
        })
      );
    }
    if (peer.queuedBytes + PACKETS.reduce((s, b) => s + b.length, 0) > this.profile.maxQueuedBytes) {
      this._event("recovery-backpressure", {
        peerId: peer.id
      });
      return;
    }
    for (const P of PACKETS) {
      this._queue(peer, P);
    }
  }
  _beginSnapshot(peer, r, now) {
    const TRANSFER = r.u32(), TICK = r.u32(), TOTAL = r.u32(), HASH_LOCAL = r.u32(), INPUT_HASH = r.u32(), COUNT = r.u16();
    r.end();
    const BUSY = this._incomingSnapshot;
    if (BUSY) {
      if (peer.id === this.authorityPlayerId && TRANSFER === BUSY.transfer && TICK === BUSY.tick && TOTAL === BUSY.total && HASH_LOCAL === BUSY.hash && INPUT_HASH === BUSY.inputHash && COUNT === BUSY.count) {
        return;
      }
      throw new Error("another snapshot candidate is active");
    }
    if (peer.id !== this.authorityPlayerId || !this._requestedRecovery || this._requestedRecovery.tick !== TICK || INPUT_HASH !== this._requestedRecovery.inputHash || !this._history.get(TICK) || TICK > this.confirmedTick + 1 || !TOTAL || TOTAL > this.profile.maxSnapshotBytes || COUNT !== Math.ceil(TOTAL / SNAP_CHUNK_BYTES) || this._incomingSnapshot) {
      throw new Error("snapshot candidate metadata");
    }
    this._incomingSnapshot = {
      transfer: TRANSFER,
      tick: TICK,
      total: TOTAL,
      hash: HASH_LOCAL,
      inputHash: INPUT_HASH,
      count: COUNT,
      bytes: new Uint8Array(TOTAL),
      seen: new Uint8Array(COUNT),
      received: 0,
      started: now
    };
  }
  _snapshotChunk(peer, r) {
    const TRANSFER = r.u32(), INDEX = r.u32(), CANDIDATE = this._incomingSnapshot;
    if (peer.id !== this.authorityPlayerId || !CANDIDATE || TRANSFER !== CANDIDATE.transfer || INDEX >= CANDIDATE.count) {
      throw new Error("snapshot transfer");
    }
    const CHUNK_LOCAL = r.raw(r.data.length - r.offset);
    r.end();
    const EXPECTED = Math.min(SNAP_CHUNK_BYTES, CANDIDATE.total - INDEX * SNAP_CHUNK_BYTES);
    if (CHUNK_LOCAL.length !== EXPECTED) {
      throw new RangeError("snapshot chunk length");
    }
    const START = INDEX * SNAP_CHUNK_BYTES;
    if (CANDIDATE.seen[INDEX]) {
      if (!equalBytes(CANDIDATE.bytes.subarray(START, START + EXPECTED), CHUNK_LOCAL)) {
        throw new Error("conflicting snapshot chunk");
      }
      return;
    }
    CANDIDATE.bytes.set(CHUNK_LOCAL, START);
    CANDIDATE.seen[INDEX] = 1;
    CANDIDATE.received++;
    if (CANDIDATE.received === CANDIDATE.count) {
      this._commitSnapshot(CANDIDATE);
    }
  }
  _rejectSnapshot(reason) {
    this._incomingSnapshot = null;
    this._requestedRecovery = null;
    this._metrics.rejectedSnapshots++;
    this._event("recovery-rejected", {
      reason
    });
    this._recoveryExhausted(reason);
  }
  _recoveryExhausted(reason) {
    if (this._recoveryAttempts < this.profile.maxRecoveryAttempts) {
      return false;
    }
    this._fail("desync-unrecoverable", {
      reason,
      attempts: this._recoveryAttempts,
      authorityPlayerId: this.authorityPlayerId
    });
    return true;
  }
  _commitSnapshot(candidate) {
    if (this.resimulating || !this._history.get(candidate.tick) || hashBytes(candidate.bytes) !== candidate.hash) {
      this._rejectSnapshot("expired or corrupt candidate");
      return;
    }
    const STARTED = NOW_MS(), ORIGINAL = this._save();
    this._replaying = true;
    try {
      if (this.adapter.validateSnapshot(candidate.bytes.slice(), {
        tick: candidate.tick
      }) !== true) {
        throw new Error("adapter rejected candidate");
      }
      this.adapter.load(candidate.bytes.slice());
      if (!equalBytes(this._save(), candidate.bytes)) {
        throw new Error("snapshot round-trip changed candidate");
      }
      const JOB = {
        candidate,
        original: ORIGINAL,
        current: this.tick,
        next: candidate.tick,
        inputHash: candidate.inputHash,
        commandSequences: this._history.get(candidate.tick).commandSequences,
        state: candidate.bytes.slice(),
        staged: [],
        stagedInputs: [],
        stageBytes: 0
      };
      this._incomingSnapshot = null;
      while (JOB.next < JOB.current) {
        const T = JOB.next, INPUTS = this._resolve(T);
        runSimulationFrame(this.adapter, {
          tick: T,
          tickRate: this.profile.tickRate,
          inputs: INPUTS,
          resimulating: true,
          recovering: true
        });
        JOB.inputHash = this._hashInputFrame(T, INPUTS, JOB.inputHash);
        JOB.commandSequences = executedSequences(JOB.commandSequences, INPUTS);
        const LOCKSTEP = this.profile.mode === "lockstep";
        if (!LOCKSTEP || (T + 1) % this.profile.checksumInterval === 0) {
          JOB.state = this._save();
          JOB.staged.push({
            tick: T + 1,
            bytes: JOB.state,
            inputHash: JOB.inputHash,
            commandSequences: JOB.commandSequences
          });
          JOB.stageBytes += JOB.state.length;
        }
        if (!LOCKSTEP) {
          JOB.stagedInputs.push([T, INPUTS]);
        }
        if (LOCKSTEP && !this._recordReplay && T + 1 === this._replayFrames.length) {
          JOB.replayFinalHash = hashBytes(this._save());
        }
        JOB.next++;
        this._metrics.resimulatedTicks++;
        if (JOB.stageBytes > this.profile.maxHistoryBytes) {
          throw new RangeError("candidate replay byte budget");
        }
      }
      const REPLACEMENT = this._newHistory();
      for (const STATE of this._history.slots) {
        if (STATE && STATE.tick < JOB.candidate.tick) {
          REPLACEMENT.put(STATE);
        }
      }
      REPLACEMENT.put({
        tick: JOB.candidate.tick,
        bytes: JOB.candidate.bytes,
        hash: JOB.candidate.hash,
        inputHash: JOB.candidate.inputHash,
        commandSequences: this._history.get(JOB.candidate.tick).commandSequences
      });
      for (const STATE of JOB.staged) {
        REPLACEMENT.put(STATE);
      }
      const USED = new Map(this._used);
      for (const [T, INPUTS] of JOB.stagedInputs) {
        USED.set(T, INPUTS);
      }
      this._commandSequences = JOB.commandSequences;
      this._history = REPLACEMENT;
      this._used = USED;
      this._inputHash = JOB.inputHash;
      this._currentState = null;
      if (this.profile.mode === "lockstep") {
        this._replayFinalState = null;
        if (!this._recordReplay && JOB.candidate.tick === this._replayFrames.length) {
          this._replayFinalHash = JOB.candidate.hash;
        }
        if (JOB.replayFinalHash !== void 0) {
          this._replayFinalHash = JOB.replayFinalHash;
        }
      }
      this._requestedRecovery = null;
      this._recoveryAttempts = 0;
      this._metrics.recoveries++;
      this._event("recovered", {
        from: JOB.candidate.tick,
        target: JOB.current
      });
    } catch (error) {
      this.adapter.load(ORIGINAL.slice());
      this._rejectSnapshot(error.message);
    } finally {
      this._replaying = false;
      this._metrics.latestResimulationMs = NOW_MS() - STARTED;
      this._window.cost += this._metrics.latestResimulationMs;
      this._window.costSamples++;
    }
  }
  _recordConfirmed() {
    if (!this._recordReplay || this.resimulating || this._failure) {
      return;
    }
    this._replayFinalState = this._history.get(this._replayFrames.length) ?? this._replayFinalState;
    const THROUGH = Math.min(this.confirmedTick, this.tick - 1);
    for (let t = this._replayFrames.length; t <= THROUGH; t++) {
      const INPUTS = this.players.map((playerId) => ({
        playerId,
        ...copyFrame(this._inputs.get(playerId).get(t)),
        predicted: false
      }));
      const N = this._replayFrameBytes(INPUTS);
      if (this._replayBytes + N > this.profile.maxReplayBytes) {
        this._replayFinalHash = this._stateHash(this._replayFinalState);
        this._replayFinalState = null;
        this._recordReplay = false;
        this._event("replay-capacity");
        return;
      }
      this._replayFrames.push({
        tick: t,
        inputs: INPUTS
      });
      this._replayBytes += N;
      this._replayFinalState = this._history.get(t + 1);
    }
  }
  exportSyncTestFrames({ maxFrames = 32 } = {}) {
    if (this.localFastPath) {
      throw new Error("replay unavailable in local fast path");
    }
    integer(maxFrames, "maxFrames", 1, 256);
    if (this.resimulating) {
      throw new Error("finish rollback before exporting synctest frames");
    }
    this._recordConfirmed();
    return {
      initialState: this._initialState.slice(),
      players: [...this.players],
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      initialTick: 0,
      frames: this._replayFrames.slice(0, maxFrames).map((f) => ({
        tick: f.tick,
        inputs: f.inputs.map((x) => ({
          ...copyFrame(x),
          playerId: x.playerId,
          predicted: false
        }))
      }))
    };
  }
  exportReplay() {
    if (this.localFastPath) {
      throw new Error("replay unavailable in local fast path");
    }
    if (this.resimulating) {
      throw new Error("finish rollback before exporting replay");
    }
    this._recordConfirmed();
    const TICK = this._replayFrames.length;
    const HASH_LOCAL = this._stateHash(this._stateAt(TICK)) ?? this._stateHash(this._replayFinalState) ?? this._replayFinalHash;
    if (TICK > 0 && HASH_LOCAL === void 0) {
      throw new Error("replay final boundary is unavailable after fatal restoration failure");
    }
    return {
      version: REPLAY_FORMAT_VERSION,
      simulationVersion: this.simulationVersion,
      seed: this.seed,
      players: [...this.players],
      inputSize: this.inputSize,
      tickRate: this.profile.tickRate,
      initialState: this._initialState.slice(),
      frames: this._replayFrames.map((f) => ({
        tick: f.tick,
        inputs: f.inputs.map((x) => ({
          ...copyFrame(x),
          playerId: x.playerId,
          predicted: false
        }))
      })),
      tick: TICK,
      hash: HASH_LOCAL ?? hashBytes(this._initialState),
      truncated: !this._recordReplay
    };
  }
  _prune() {
    const WINDOW_OLDEST = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    const OLDEST = this.profile.mode === "lockstep" ? Math.min(WINDOW_OLDEST, this._history?.oldestTick ?? WINDOW_OLDEST) : WINDOW_OLDEST;
    for (const T of this._used.keys()) {
      if (T < OLDEST - 1) {
        this._used.delete(T);
      }
    }
    for (const PEER of this._peers.values()) {
      for (const T of PEER.reservations?.keys() ?? []) {
        if (T < OLDEST) {
          PEER.reservations.delete(T);
        }
      }
      for (const [SEQ, C] of PEER.reservedCommands ?? []) {
        if (C.executeTick < OLDEST) {
          PEER.reservedCommands.delete(SEQ);
        }
      }
      for (const T of PEER.reservationAcks?.keys() ?? []) {
        if (T < OLDEST) {
          PEER.reservationAcks.delete(T);
        }
      }
    }
    const MIN_ACK = this._peers.size ? Math.min(...[...this._peers.values()].map((p) => p.ack)) : this.tick;
    for (const [PLAYER_ID, MAP] of this._inputs) {
      for (const T of MAP.keys()) {
        if (T < OLDEST && (PLAYER_ID !== this.localPlayerId || T <= MIN_ACK)) {
          MAP.delete(T);
        }
      }
    }
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const PEER of this._peers.values()) {
      try {
        PEER.detach();
      } finally {
        PEER.transport.close?.();
      }
    }
    this._peers.clear();
    this._localReservations.clear();
    this._localCaptures.length = 0;
    this._incomingSnapshot = null;
    this._pendingCommands.length = 0;
    this._event("closed");
  }
};

// modules/rollback/bootstrap.js
var MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
var MAX_SUFFIX_TICKS = 8192;
function roster(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || Array.from(value).some((id) => typeof id !== "string" || !id.length || id.length > 128) || new Set(value).size !== value.length) {
    throw new TypeError(name);
  }
  return value.slice();
}
function validateBootstrap(bootstrap, limits, expected, deferCheckpointHash = false) {
  if (!bootstrap || bootstrap.version !== 1) {
    throw new Error("bootstrap version");
  }
  const TICK = integer(bootstrap.tick, "bootstrap tick", 0, MAX_TICK + 1);
  const INPUT_SIZE = integer(bootstrap.inputSize, "bootstrap inputSize", 1, 1024);
  const TICK_RATE = integer(bootstrap.tickRate, "bootstrap tickRate", 1, 240);
  const SEED = integer(bootstrap.seed, "bootstrap seed");
  const SIMULATION_VERSION = bootstrap.simulationVersion;
  if (typeof SIMULATION_VERSION !== "string" || !SIMULATION_VERSION.length || SIMULATION_VERSION.length > 128) {
    throw new TypeError("bootstrap simulationVersion");
  }
  const PLAYERS = roster(bootstrap.players, "bootstrap players");
  if (PLAYERS.some((id, index) => index > 0 && COMPARE_IDS(PLAYERS[index - 1], id) >= 0)) {
    throw new Error("bootstrap player order");
  }
  const PROVIDED_SEQUENCES = bootstrap.commandSequences;
  if (!PROVIDED_SEQUENCES || typeof PROVIDED_SEQUENCES !== "object" || Array.isArray(PROVIDED_SEQUENCES) || Object.keys(PROVIDED_SEQUENCES).length !== PLAYERS.length || PLAYERS.some((id) => !Object.hasOwn(PROVIDED_SEQUENCES, id))) {
    throw new TypeError("bootstrap command sequences roster");
  }
  const COMMAND_SEQUENCES = Object.fromEntries(
    PLAYERS.map((id) => [id, integer(PROVIDED_SEQUENCES[id], "bootstrap command sequence boundary")])
  );
  for (const FIELD of ["simulationVersion", "inputSize", "tickRate", "seed"]) {
    if (expected[FIELD] !== void 0 && expected[FIELD] !== bootstrap[FIELD]) {
      throw new Error(`bootstrap ${FIELD} mismatch`);
    }
  }
  if (expected.players !== void 0) {
    const WANTED = roster(expected.players, "expected players").sort(COMPARE_IDS);
    if (WANTED.length !== PLAYERS.length || WANTED.some((id, index) => id !== PLAYERS[index])) {
      throw new Error("bootstrap players mismatch");
    }
  }
  const CHECKPOINT = bootstrap.checkpoint;
  const START = integer(CHECKPOINT?.tick, "bootstrap checkpoint tick", 0, TICK);
  const DATA = bytes(CHECKPOINT?.bytes, "bootstrap checkpoint");
  if (!DATA.length || DATA.length > limits.maxSnapshotBytes) {
    throw new RangeError("bootstrap snapshot size");
  }
  const CHECKPOINT_BYTES = DATA.slice();
  const CHECKPOINT_HASH = integer(CHECKPOINT.hash, "bootstrap checkpoint hash");
  if (!deferCheckpointHash && hashBytes(CHECKPOINT_BYTES) !== CHECKPOINT_HASH) {
    throw new Error("bootstrap checkpoint hash mismatch");
  }
  const HASH = integer(bootstrap.hash, "bootstrap final hash");
  if (!Array.isArray(bootstrap.frames) || bootstrap.frames.length !== TICK - START || TICK - START > limits.maxSuffixTicks) {
    throw new RangeError("bootstrap suffix length");
  }
  if (START === TICK && CHECKPOINT_HASH !== HASH) {
    throw new Error("bootstrap final hash mismatch");
  }
  let totalBytes = DATA.length;
  if (totalBytes > limits.maxReplayBytes) {
    throw new RangeError("bootstrap replay byte budget");
  }
  const SEQUENCES = new Map(PLAYERS.map((id) => [id, 0]));
  const FRAMES = Array.from(bootstrap.frames, (frame, index) => {
    const FRAME_TICK = START + index;
    if (frame?.tick !== FRAME_TICK) {
      throw new Error("non-contiguous bootstrap suffix");
    }
    if (!Array.isArray(frame.inputs) || frame.inputs.length !== PLAYERS.length) {
      throw new Error("bootstrap input roster");
    }
    totalBytes += 16;
    const INPUTS = Array.from(frame.inputs, (inputFrame, player) => {
      if (inputFrame?.playerId !== PLAYERS[player] || inputFrame.predicted !== false) {
        throw new Error("bootstrap confirmed input order");
      }
      const INPUT = bytes(inputFrame.input, "bootstrap input");
      if (INPUT.length !== INPUT_SIZE) {
        throw new RangeError("bootstrap inputSize");
      }
      if (!Array.isArray(inputFrame.commands) || inputFrame.commands.length > limits.maxPendingCommands) {
        throw new RangeError("bootstrap command count");
      }
      let commandBytes = 0;
      totalBytes += INPUT_SIZE;
      const COMMANDS = Array.from(inputFrame.commands, (command) => {
        const SEQUENCE = integer(command?.sequence, "bootstrap command sequence", 1);
        if (SEQUENCE <= SEQUENCES.get(PLAYERS[player]) || command.executeTick !== FRAME_TICK) {
          throw new Error("bootstrap command order/tick");
        }
        SEQUENCES.set(PLAYERS[player], SEQUENCE);
        const PAYLOAD = bytes(command.payload, "bootstrap command payload");
        commandBytes += PAYLOAD.length + 6;
        totalBytes += PAYLOAD.length + 12;
        if (!PAYLOAD.length || PAYLOAD.length > limits.maxCommandBytes || commandBytes > CHUNK_SIZE - 1024 - INPUT_SIZE) {
          throw new RangeError("bootstrap command size");
        }
        if (totalBytes > limits.maxReplayBytes) {
          throw new RangeError("bootstrap replay byte budget");
        }
        return {
          sequence: SEQUENCE,
          executeTick: FRAME_TICK,
          payload: PAYLOAD.slice()
        };
      });
      if (totalBytes > limits.maxReplayBytes) {
        throw new RangeError("bootstrap replay byte budget");
      }
      return {
        playerId: PLAYERS[player],
        input: INPUT.slice(),
        commands: COMMANDS,
        predicted: false
      };
    });
    return {
      tick: FRAME_TICK,
      inputs: INPUTS
    };
  });
  for (const [ID, SEQUENCE] of SEQUENCES) {
    if (SEQUENCE && SEQUENCE !== COMMAND_SEQUENCES[ID]) {
      throw new Error("bootstrap command sequence boundary mismatch");
    }
  }
  return {
    version: 1,
    tick: TICK,
    checkpoint: {
      tick: START,
      bytes: CHECKPOINT_BYTES,
      hash: CHECKPOINT_HASH
    },
    players: PLAYERS,
    frames: FRAMES,
    hash: HASH,
    inputSize: INPUT_SIZE,
    tickRate: TICK_RATE,
    simulationVersion: SIMULATION_VERSION,
    seed: SEED,
    commandSequences: COMMAND_SEQUENCES
  };
}
function createBootstrapReplay({
  adapter,
  bootstrap,
  maxCatchupSteps = 8,
  maxCatchupMs = 8,
  clock = NOW_MS,
  maxSnapshotBytes = DEFAULTS.maxSnapshotBytes,
  maxSuffixTicks = MAX_SUFFIX_TICKS,
  maxCommandBytes = DEFAULTS.maxCommandBytes,
  maxPendingCommands = DEFAULTS.maxPendingCommands,
  maxReplayBytes = DEFAULTS.maxReplayBytes,
  simulationVersion,
  inputSize,
  tickRate,
  players,
  seed
} = {}) {
  if (!adapter || ["save", "load", "step", "validateSnapshot"].some((name) => typeof adapter[name] !== "function")) {
    throw new TypeError("Simulation Adapter must save, load, step, validateSnapshot");
  }
  integer(maxCatchupSteps, "maxCatchupSteps", 1, MAX_SUFFIX_TICKS);
  if (!Number.isFinite(maxCatchupMs) || maxCatchupMs <= 0 || typeof clock !== "function") {
    throw new TypeError("bootstrap time budget");
  }
  integer(maxSnapshotBytes, "maxSnapshotBytes", 1, MAX_SNAPSHOT_BYTES);
  integer(maxSuffixTicks, "maxSuffixTicks", 0, MAX_SUFFIX_TICKS);
  integer(maxCommandBytes, "maxCommandBytes", 1, CHUNK_SIZE - 1024);
  integer(maxPendingCommands, "maxPendingCommands", 1, 2147483647);
  integer(maxReplayBytes, "maxReplayBytes", 1, 2147483647);
  const COOPERATIVE = typeof adapter.saveJob === "function" && typeof adapter.prepareSnapshotJob === "function" && typeof adapter.loadPreparedSnapshot === "function";
  const CANDIDATE = validateBootstrap(
    bootstrap,
    {
      maxSnapshotBytes,
      maxSuffixTicks,
      maxCommandBytes,
      maxPendingCommands,
      maxReplayBytes
    },
    {
      simulationVersion,
      inputSize,
      tickRate,
      players,
      seed
    },
    COOPERATIVE
  );
  const SAVE = () => {
    const DATA = bytes(adapter.save(), "bootstrap adapter snapshot");
    if (!DATA.length || DATA.length > maxSnapshotBytes) {
      throw new RangeError("bootstrap adapter snapshot size");
    }
    return DATA.slice();
  };
  const CONTEXT = (tick2) => ({
    tick: tick2,
    tickRate: CANDIDATE.tickRate,
    players: CANDIDATE.players.slice(),
    simulationVersion: CANDIDATE.simulationVersion,
    seed: CANDIDATE.seed
  });
  if (COOPERATIVE) {
    return createCooperativeReplay({
      adapter,
      candidate: CANDIDATE,
      context: CONTEXT,
      maxSnapshotBytes,
      maxCatchupSteps,
      maxCatchupMs,
      clock
    });
  }
  const ORIGINAL = SAVE();
  let tick = CANDIDATE.checkpoint.tick;
  let status = "catching-up";
  let result = null;
  let failure = null;
  const RESTORE = (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    status = "failed";
    try {
      adapter.load(ORIGINAL.slice());
    } catch (restoreError) {
      failure = new AggregateError(
        [failure, restoreError],
        "bootstrap replay failed and original snapshot restoration failed"
      );
    }
    throw failure;
  };
  const PREPARED_PATH = typeof adapter.prepareSnapshot === "function" && typeof adapter.loadPreparedSnapshot === "function";
  const PREPARED = PREPARED_PATH ? adapter.prepareSnapshot(CANDIDATE.checkpoint.bytes.slice(), CONTEXT(tick)) : null;
  if (PREPARED_PATH ? !PREPARED : adapter.validateSnapshot(CANDIDATE.checkpoint.bytes.slice(), CONTEXT(tick)) !== true) {
    throw new Error("adapter rejected bootstrap checkpoint");
  }
  try {
    if (PREPARED_PATH) {
      adapter.loadPreparedSnapshot(PREPARED, CONTEXT(tick));
    } else {
      adapter.load(CANDIDATE.checkpoint.bytes.slice());
      if (!equalBytes(SAVE(), CANDIDATE.checkpoint.bytes)) {
        throw new Error("bootstrap checkpoint round-trip mismatch");
      }
    }
  } catch (error) {
    RESTORE(error);
  }
  return Object.freeze({
    get tick() {
      return tick;
    },
    get targetTick() {
      return CANDIDATE.tick;
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
      if (failure) {
        throw failure;
      }
      if (status !== "catching-up") {
        return Object.freeze({
          status,
          tick,
          targetTick: CANDIDATE.tick,
          steps: 0,
          ...result ?? {}
        });
      }
      let steps = 0;
      const STARTED = clock();
      try {
        while (tick < CANDIDATE.tick && steps < maxCatchupSteps && (steps === 0 || clock() - STARTED < maxCatchupMs)) {
          const FRAME = CANDIDATE.frames[tick - CANDIDATE.checkpoint.tick];
          runSimulationFrame(adapter, {
            tick,
            tickRate: CANDIDATE.tickRate,
            inputs: FRAME.inputs,
            resimulating: true,
            recovering: true,
            replaying: true
          });
          tick++;
          steps++;
        }
        if (tick === CANDIDATE.tick) {
          const UNCHANGED = PREPARED_PATH && CANDIDATE.tick === CANDIDATE.checkpoint.tick;
          const FINAL = UNCHANGED ? CANDIDATE.checkpoint.bytes : SAVE();
          if (!UNCHANGED && hashBytes(FINAL) !== CANDIDATE.hash) {
            throw new Error("bootstrap final hash mismatch");
          }
          if (!UNCHANGED && adapter.validateSnapshot(FINAL.slice(), CONTEXT(tick)) !== true) {
            throw new Error("adapter rejected bootstrap final state");
          }
          status = "done";
          result = Object.freeze({
            tick,
            hash: CANDIDATE.hash
          });
        }
        return Object.freeze({
          status,
          tick,
          targetTick: CANDIDATE.tick,
          steps,
          ...result ?? {}
        });
      } catch (error) {
        return RESTORE(error);
      }
    },
    cancel() {
      if (failure) {
        throw failure;
      }
      if (status === "catching-up") {
        try {
          adapter.load(ORIGINAL.slice());
          status = "cancelled";
        } catch (error) {
          return RESTORE(error);
        }
      }
      return Object.freeze({
        status,
        tick,
        targetTick: CANDIDATE.tick,
        steps: 0,
        ...result ?? {}
      });
    }
  });
}
function createCooperativeReplay({
  adapter,
  candidate,
  context,
  maxSnapshotBytes,
  maxCatchupSteps,
  maxCatchupMs,
  clock
}) {
  let tick = candidate.checkpoint.tick;
  let status = "catching-up";
  let phase = "checkpoint-hash";
  let result = null;
  let failure = null;
  let original;
  let final;
  let loaded = false;
  let job;
  let hash = 2166136261;
  let hashOffset = 0;
  const OWN = (value) => {
    const DATA = bytes(value, "bootstrap job snapshot");
    if (!DATA.length || DATA.length > maxSnapshotBytes) {
      throw new RangeError("bootstrap adapter snapshot size");
    }
    return DATA.slice();
  };
  const CHECK_JOB = (value) => {
    if (!value || typeof value.pulse !== "function" || typeof value.cancel !== "function") {
      throw new TypeError("snapshot preparation job");
    }
    return value;
  };
  const FAIL = (error) => {
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
        failure = new AggregateError(
          [failure, restoreError],
          "bootstrap replay failed and original snapshot restoration failed"
        );
      }
    }
    original = final = null;
    throw failure;
  };
  const FINISH = () => {
    status = "done";
    phase = "done";
    result = Object.freeze({
      tick,
      hash: candidate.hash
    });
    original = final = null;
  };
  const RESPONSE = (steps) => Object.freeze({
    status,
    tick,
    targetTick: candidate.tick,
    steps,
    ...result ?? {}
  });
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
      if (failure) {
        throw failure;
      }
      if (status !== "catching-up") {
        return RESPONSE(0);
      }
      let steps = 0;
      const STARTED = clock();
      try {
        if (phase === "checkpoint-hash") {
          do {
            const END = Math.min(candidate.checkpoint.bytes.length, hashOffset + 65536);
            hash = hashBytes(candidate.checkpoint.bytes.subarray(hashOffset, END), hash);
            hashOffset = END;
          } while (hashOffset < candidate.checkpoint.bytes.length && clock() - STARTED < maxCatchupMs);
          if (hashOffset === candidate.checkpoint.bytes.length) {
            if (hash !== candidate.checkpoint.hash) {
              throw new Error("bootstrap checkpoint hash mismatch");
            }
            hash = 2166136261;
            hashOffset = 0;
            phase = "original";
          }
        } else if (phase === "original" || phase === "final") {
          job ??= CHECK_JOB(adapter.saveJob());
          job.pulse({
            budgetMs: maxCatchupMs
          });
          if (job.done) {
            const DATA = OWN(job.result);
            job = null;
            if (phase === "original") {
              original = DATA;
              phase = "prepare";
            } else {
              final = DATA;
              phase = "hash";
            }
          }
        } else if (phase === "prepare" || phase === "validate") {
          job ??= CHECK_JOB(
            adapter.prepareSnapshotJob(
              (phase === "prepare" ? candidate.checkpoint.bytes : final).slice(),
              context(tick)
            )
          );
          job.pulse({
            budgetMs: maxCatchupMs
          });
          if (job.done) {
            const TOKEN = job.result;
            job = null;
            if (!TOKEN) {
              throw new Error("adapter rejected bootstrap snapshot");
            }
            if (phase === "validate") {
              FINISH();
            } else {
              final = TOKEN;
              phase = "install";
            }
          }
        } else if (phase === "install") {
          const TOKEN = final;
          final = null;
          loaded = true;
          adapter.loadPreparedSnapshot(TOKEN, context(tick));
          if (tick === candidate.tick) {
            FINISH();
          } else {
            phase = "replay";
          }
        } else if (phase === "replay") {
          while (tick < candidate.tick && steps < maxCatchupSteps && (steps === 0 || clock() - STARTED < maxCatchupMs)) {
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
          if (tick === candidate.tick) {
            phase = "final";
          }
        } else if (phase === "hash") {
          do {
            const END = Math.min(final.length, hashOffset + 65536);
            hash = hashBytes(final.subarray(hashOffset, END), hash);
            hashOffset = END;
          } while (hashOffset < final.length && clock() - STARTED < maxCatchupMs);
          if (hashOffset === final.length) {
            if (hash !== candidate.hash) {
              throw new Error("bootstrap final hash mismatch");
            }
            phase = "validate";
          }
        }
        return RESPONSE(steps);
      } catch (error) {
        return FAIL(error);
      }
    },
    cancel() {
      if (failure) {
        throw failure;
      }
      if (status === "catching-up") {
        try {
          job?.cancel();
          job = null;
          if (loaded) {
            adapter.load(original.slice());
          }
        } catch (error) {
          return FAIL(error);
        }
        status = "cancelled";
        original = final = null;
      }
      return RESPONSE(0);
    }
  });
}

// modules/rollback/availability.js
var SORTED = (ids) => [...ids].sort(COMPARE_IDS);
var EQUAL = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var NONCE = () => [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
var BRANCH_VALID = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
function availabilityConfig(value = {}) {
  const CONFIG = {
    mode: "strict",
    heartbeatMs: 250,
    silenceMs: 3e3,
    inputGraceMs: 3e3,
    resumeGapMs: 3e3,
    roundTimeoutMs: 5e3,
    retryMs: 500,
    ...value
  };
  if (!["strict", "available"].includes(CONFIG.mode)) {
    throw new TypeError("availability mode");
  }
  CONFIG.autoTransfer = Object.freeze({
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
  for (const KEY of ["heartbeatMs", "silenceMs", "inputGraceMs", "resumeGapMs", "roundTimeoutMs", "retryMs"]) {
    integer(CONFIG[KEY], KEY, 1);
  }
  if (CONFIG.silenceMs < CONFIG.heartbeatMs * 2 || CONFIG.inputGraceMs < CONFIG.heartbeatMs * 2) {
    throw new RangeError("availability grace must cover two heartbeats");
  }
  if (typeof CONFIG.autoTransfer.enabled !== "boolean") {
    throw new TypeError("autoTransfer enabled");
  }
  for (const [KEY, N] of Object.entries(CONFIG.autoTransfer)) {
    if (KEY !== "enabled") {
      if (!Number.isFinite(N) || N < 0 || ["intervalMs", "minTenureMs", "minSamples"].includes(KEY) && (!Number.isSafeInteger(N) || N < 1)) {
        throw new RangeError("autoTransfer " + KEY);
      }
    }
  }
  if (CONFIG.autoTransfer.stepEmaAlpha <= 0 || CONFIG.autoTransfer.stepEmaAlpha > 1) {
    throw new RangeError("autoTransfer stepEmaAlpha");
  }
  return Object.freeze(CONFIG);
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
    const ALPHA = this.config.autoTransfer.stepEmaAlpha;
    this.stepMs = this.samples ? this.stepMs * (1 - ALPHA) + elapsed * ALPHA : elapsed;
    this.samples++;
  }
  summary(now) {
    const S = this.session, NETWORK = S.activePlayers.filter((id) => id !== S.localPlayerId).map((id) => S._core?.getPeerState(id)).filter((p) => p?.handshakeComplete);
    return {
      branch: this.branch,
      epoch: S.epoch,
      tick: S.confirmedTick + 1,
      coordinatorId: S.coordinatorId,
      anchorId: this.anchorId,
      retainedBoundary: !!S._suspendedBootstrap || !!S._core && !S._core.failure && !S._core.resimulating && S._core.confirmedBoundary >= 0,
      activePlayers: [...S.activePlayers],
      pumping: now - this.lastAdvance <= this.config.inputGraceMs,
      eligible: !this.recovering && now - this.lastAdvance <= this.config.inputGraceMs,
      requested: this.requested,
      recovering: this.recovering,
      inputIdleMs: Math.max(0, now - this.lastAdvance),
      stepMs: this.stepMs,
      samples: this.samples,
      rtt: NETWORK.length ? Math.max(...NETWORK.map((p) => p.rtt)) : 0,
      jitter: NETWORK.length ? Math.max(...NETWORK.map((p) => p.jitter)) : 0
    };
  }
  live(now) {
    const S = this.session;
    return SORTED(
      S.players.filter(
        (id) => id === S.localPlayerId || this.peers.has(id) && now - this.peers.get(id).at < this.config.silenceMs
      )
    );
  }
  send(ids, op, detail) {
    this.session._broadcast(ids, "availability-" + op, detail);
  }
  poll(now) {
    const S = this.session;
    if (!this.polled) {
      this.polled = true;
      this.lastPoll = now;
      this.lastAdvance = now;
      this.tenureAt = now;
    }
    if (now - this.lastPoll > this.config.resumeGapMs && S.players.length > 1) {
      this.recovering = true;
      this.requested = "resume";
      S.releaseInput();
      S._event("resynchronizing", {
        reason: "pump-gap"
      });
    }
    this.lastPoll = now;
    if (!S._core && !S._suspendedBootstrap && !S.room?.resumed || S._transition && !S._transition.availability) {
      return;
    }
    if (now - this.lastHeartbeat >= this.config.heartbeatMs) {
      this.lastHeartbeat = now;
      this.send(
        S.players.filter((id) => id !== S.localPlayerId && S._links.has(id)),
        "activity",
        this.summary(now)
      );
    }
    const LIVE = this.live(now), SUMMARIES = new Map([
      [S.localPlayerId, this.summary(now)],
      ...[...this.peers].map(([id, p]) => [id, p.value])
    ]);
    for (const ID of S.players) {
      const STATE = !LIVE.includes(ID) ? "unresponsive" : SUMMARIES.get(ID)?.recovering ? "resynchronizing" : !SUMMARIES.get(ID)?.eligible || !S.activePlayers.includes(ID) ? "suspended" : "active";
      if (this.states.get(ID) !== STATE) {
        this.states.set(ID, STATE);
        S._event("participant-state", {
          peerId: ID,
          state: STATE,
          deadlineMs: (this.peers.get(ID)?.at ?? now) + this.config.silenceMs
        });
      }
    }
    const ROUND = this.round;
    if (ROUND) {
      if (now - ROUND.started >= this.config.roundTimeoutMs) {
        this.cancel();
        this.retryAt = now + this.config.retryMs;
        this.requested = "round-timeout";
        S._event("availability-retry");
        return;
      }
      this.drain(now);
      if (this.round !== ROUND) {
        return;
      }
      if (ROUND.replay) {
        const RESULT = S._boundaryWork("bootstrapPulseMs", () => ROUND.replay.pulse());
        S._stats.bootstrapTicks += RESULT.steps ?? 0;
        if (ROUND.replay.done) {
          ROUND.replay = null;
          S._applyMembership(S._transition);
        }
      }
      if (ROUND.leader === S.localPlayerId && ROUND.votes.size === ROUND.participants.length && !ROUND.decision) {
        const CHOICE = this.choose(ROUND);
        ROUND.decision = {
          ...CHOICE,
          branch: ROUND.id,
          epoch: Math.max(S.epoch, ...[...ROUND.votes.values()].map((v) => v.epoch)) + 1
        };
        this.send(ROUND.participants, "decision", {
          round: ROUND.id,
          decision: ROUND.decision
        });
      }
      if (ROUND.leader === S.localPlayerId && ROUND.staged.size === ROUND.participants.length && !ROUND.commitSent) {
        if (new Set(ROUND.staged.values()).size !== 1) {
          throw new Error("availability installation mismatch");
        }
        ROUND.commitSent = true;
        this.send(ROUND.participants, "commit", {
          round: ROUND.id,
          hash: ROUND.staged.get(S.localPlayerId)
        });
      }
      return;
    }
    const ELIGIBLE = LIVE.filter((id) => SUMMARIES.get(id)?.eligible);
    const PARTICIPANTS = LIVE.filter((id) => SUMMARIES.get(id)?.pumping);
    const ALL_RESUMED = !ELIGIBLE.length && LIVE.length === S.players.length && LIVE.every((id) => SUMMARIES.get(id)?.retainedBoundary) && PARTICIPANTS.some((id) => SUMMARIES.get(id)?.recovering);
    const LEADERS = ALL_RESUMED ? PARTICIPANTS : ELIGIBLE;
    if (!LEADERS.length || now < this.retryAt) {
      return;
    }
    if (S.players.some((id) => id !== S.localPlayerId && !this.peers.has(id)) && now - this.tenureAt < this.config.silenceMs) {
      return;
    }
    let reason = ALL_RESUMED ? "all-resume" : this.requested;
    reason ??= PARTICIPANTS.map((id) => SUMMARIES.get(id)?.requested).find(Boolean);
    if (!EQUAL(ELIGIBLE, S.activePlayers) || PARTICIPANTS.some((id) => SUMMARIES.get(id)?.branch !== this.branch)) {
      reason ??= "liveness";
    }
    let transferTo = null;
    const CONFIG = this.config.autoTransfer;
    if (!reason && CONFIG.enabled && now - this.lastEvaluation >= CONFIG.intervalMs && now - this.tenureAt >= CONFIG.minTenureMs) {
      this.lastEvaluation = now;
      const SCORE = (v) => v.rtt * CONFIG.rttWeight + v.jitter * CONFIG.jitterWeight + v.stepMs * CONFIG.stepWeight;
      const CANDIDATES = ELIGIBLE.filter((id) => SUMMARIES.get(id).samples >= CONFIG.minSamples).sort(
        (a, b) => SCORE(SUMMARIES.get(a)) - SCORE(SUMMARIES.get(b)) || COMPARE_IDS(a, b)
      );
      const CURRENT = SUMMARIES.get(S.coordinatorId), BEST = CANDIDATES[0];
      if (CURRENT?.samples >= CONFIG.minSamples && BEST && BEST !== S.coordinatorId && SCORE(CURRENT) > SCORE(SUMMARIES.get(BEST)) && SCORE(CURRENT) - SCORE(SUMMARIES.get(BEST)) >= CONFIG.minImprovementMs) {
        reason = "auto-transfer";
        transferTo = BEST;
      }
    }
    if (reason && LEADERS[0] === S.localPlayerId) {
      const VOTERS = ALL_RESUMED ? LIVE : PARTICIPANTS;
      this.requested = null;
      this.send(VOTERS, "probe", {
        round: NONCE(),
        participants: VOTERS,
        leader: S.localPlayerId,
        reason,
        transferTo
      });
    }
  }
  choose(round) {
    const S = this.session;
    let votes = [...round.votes].filter(([, v]) => v.eligible);
    const ALL_RESUMED = !votes.length;
    if (ALL_RESUMED) {
      if (round.reason !== "all-resume" || round.votes.size !== S.players.length || [...round.votes.values()].some((v) => !v.retainedBoundary) || ![...round.votes.values()].some((v) => v.pumping && v.recovering)) {
        throw new Error("availability has no active donor");
      }
      votes = [...round.votes];
    }
    const GROUPS = /* @__PURE__ */ new Map();
    for (const [ID, V2] of votes) {
      const KEY = V2.tick + ":" + V2.hash;
      if (!GROUPS.has(KEY)) {
        GROUPS.set(KEY, []);
      }
      GROUPS.get(KEY).push(ID);
    }
    const MAJORITY = [...GROUPS.values()].filter((ids) => ids.length > S.players.length / 2).sort((a, b) => b.length - a.length)[0];
    let donor = MAJORITY?.sort(COMPARE_IDS)[0];
    const LATEST_TICK = Math.max(...votes.map(([, v]) => v.tick));
    const ANCHOR = votes.find(([id, v]) => id === this.anchorId && (!ALL_RESUMED || v.tick === LATEST_TICK))?.[0];
    if (!donor) {
      donor = ANCHOR ?? votes.sort((a, b) => b[1].tick - a[1].tick || COMPARE_IDS(a[0], b[0]))[0][0];
    }
    const V = round.votes.get(donor), ACTIVE_PLAYERS = SORTED([...round.votes].filter(([, value]) => value.pumping).map(([id]) => id));
    const COORDINATOR_ID = round.transferTo && ACTIVE_PLAYERS.includes(round.transferTo) ? round.transferTo : ACTIVE_PLAYERS.includes(V.coordinatorId) ? V.coordinatorId : ACTIVE_PLAYERS.includes(donor) ? donor : ACTIVE_PLAYERS[0];
    return {
      donor,
      tick: V.tick,
      hash: V.hash,
      coordinatorId: COORDINATOR_ID,
      activePlayers: ACTIVE_PLAYERS,
      basis: MAJORITY ? "roster-majority" : ANCHOR ? "responsive-coordinator" : "active-branch",
      votes: MAJORITY?.length ?? 0,
      rosterSize: S.players.length
    };
  }
  handle(from, m, now) {
    const S = this.session, OP = m.op.slice("availability-".length);
    if (!S.players.includes(from)) {
      return;
    }
    if (OP === "activity") {
      if (!BRANCH_VALID(m.branch) || !Number.isSafeInteger(m.tick) || m.tick < 0 || !Number.isInteger(m.epoch) || m.epoch < 0 || !Array.isArray(m.activePlayers) || m.activePlayers.length > S.membership.maxPlayers || typeof m.eligible !== "boolean" || typeof m.retainedBoundary !== "boolean" || ["stepMs", "rtt", "jitter", "samples", "inputIdleMs"].some((k) => !Number.isFinite(m[k]) || m[k] < 0)) {
        throw new Error("invalid availability observation");
      }
      if (!S.players.includes(m.coordinatorId) || m.activePlayers.some((id) => !S.players.includes(id))) {
        return;
      }
      this.peers.set(from, {
        at: now,
        value: m
      });
      return;
    }
    if (OP === "probe") {
      if (!BRANCH_VALID(m.round) || m.leader !== from || !Array.isArray(m.participants) || !EQUAL(SORTED([...new Set(m.participants)]), m.participants) || !m.participants.includes(S.localPlayerId) || m.participants.some((id) => !S.players.includes(id))) {
        return;
      }
      if (S._transition && !S._transition.availability) {
        return;
      }
      if (this.round?.id === m.round || this.round && COMPARE_IDS(this.round.leader, from) <= 0) {
        return;
      }
      this.cancel();
      if (S._core?.resimulating) {
        S._core.poll();
      }
      const ROUND2 = this.round = {
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
      const VOTE = {
        ...this.summary(now),
        hash: S._core?.getStateHash(S._core.confirmedBoundary) ?? S._suspendedBootstrap?.hash ?? 0
      };
      ROUND2.bootstrap = S._core ? S._exportBootstrap() : S._suspendedBootstrap;
      ROUND2.sourceBaseTick = S.baseTick;
      ROUND2.sourceEpoch = S.epoch;
      ROUND2.original = bytes(S.adapter.save()).slice();
      if (ROUND2.reason === "all-resume" && VOTE.retainedBoundary && VOTE.tick === S.tick) {
        if (!ROUND2.bootstrap || hashBytes(ROUND2.original) !== VOTE.hash) {
          throw new Error("availability retained boundary changed");
        }
        ROUND2.bootstrap = {
          ...ROUND2.bootstrap,
          checkpoint: {
            tick: ROUND2.bootstrap.tick,
            bytes: ROUND2.original.slice(),
            hash: VOTE.hash
          },
          frames: []
        };
      }
      this.send(ROUND2.participants, "vote", {
        round: ROUND2.id,
        vote: VOTE
      });
      S._event("availability-preparing", {
        reason: ROUND2.reason,
        deadlineMs: now + this.config.roundTimeoutMs
      });
      return;
    }
    const ROUND = this.round;
    if (!ROUND || m.round !== ROUND.id || !ROUND.participants.includes(from)) {
      return;
    }
    if (OP === "vote") {
      const V = m.vote;
      if (!BRANCH_VALID(V?.branch) || !Number.isSafeInteger(V.tick) || V.tick < 0 || !Number.isInteger(V.hash) || V.hash < 0 || V.hash > 4294967295 || !Number.isInteger(V.epoch) || V.epoch < 0 || V.epoch > 65534 || typeof V.eligible !== "boolean" || typeof V.pumping !== "boolean" || typeof V.recovering !== "boolean" || typeof V.retainedBoundary !== "boolean" || V.eligible && !V.pumping || !Array.isArray(V.activePlayers) || V.activePlayers.some((id) => !S.players.includes(id)) || !S.players.includes(V.coordinatorId)) {
        throw new Error("invalid availability vote");
      }
      ROUND.votes.set(from, V);
      return;
    }
    if (OP === "decision" && from === ROUND.leader && !S._transition) {
      if (ROUND.votes.size !== ROUND.participants.length) {
        ROUND.pendingDecision = m;
        return;
      }
      const EXPECTED = this.choose(ROUND), D = m.decision;
      if (!EQUAL(EXPECTED, Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, D?.[k]]))) || D.branch !== ROUND.id || D.epoch !== Math.max(S.epoch, ...[...ROUND.votes.values()].map((v) => v.epoch)) + 1 || D.epoch > 65534) {
        throw new Error("availability decision certificate");
      }
      ROUND.decision = D;
      if (S.localPlayerId === D.donor) {
        this.send(ROUND.participants, "checkpoint", {
          round: ROUND.id,
          bootstrap: ROUND.bootstrap,
          baseTick: ROUND.sourceBaseTick,
          sourceEpoch: ROUND.sourceEpoch
        });
      }
      S._event("branch-selected", {
        ...D,
        reason: ROUND.reason,
        discardedTick: S.tick
      });
      return;
    }
    if (OP === "checkpoint" && !ROUND.decision) {
      ROUND.pendingCheckpoint = {
        from,
        message: m
      };
      return;
    }
    if (OP === "checkpoint" && from === ROUND.decision?.donor && !S._transition) {
      const D = ROUND.decision;
      if (m.bootstrap?.hash !== D.hash || m.baseTick + m.bootstrap?.tick !== D.tick || m.sourceEpoch !== ROUND.votes.get(from).epoch || !EQUAL(m.bootstrap.players, ROUND.votes.get(from).activePlayers)) {
        throw new Error("availability checkpoint certificate");
      }
      S._transition = {
        availability: true,
        proposal: {
          epoch: D.epoch,
          oldPlayers: [...S.players],
          players: [...S.players],
          joined: [],
          left: [],
          activePlayers: D.activePlayers,
          coordinatorId: D.coordinatorId,
          reason: ROUND.reason,
          branch: D.branch
        },
        participants: ROUND.participants,
        target: D.tick,
        startedAt: now,
        applied: false,
        boundaryLoaded: true,
        commandSequences: S._bootstrapCommandSequences(m.bootstrap, S.players)
      };
      ROUND.replay = createBootstrapReplay({
        adapter: S._adapter(m.baseTick, m.sourceEpoch),
        bootstrap: m.bootstrap,
        maxCatchupSteps: S.membership.maxCatchupSteps,
        maxCatchupMs: S.membership.snapshotBudgetMs,
        maxSnapshotBytes: S.profile.maxSnapshotBytes,
        maxSuffixTicks: S.profile.checksumInterval,
        maxCommandBytes: S.profile.maxCommandBytes,
        maxPendingCommands: S.profile.maxPendingCommands,
        maxReplayBytes: S.membership.maxTransferBytes,
        simulationVersion: S.simulationVersion,
        inputSize: S.inputSize,
        tickRate: S.profile.tickRate,
        seed: S.seed
      });
      S._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length;
      return;
    }
    if (OP === "staged") {
      if (!Number.isInteger(m.hash)) {
        throw new Error("availability staged hash");
      }
      ROUND.staged.set(from, m.hash);
      return;
    }
    if (OP === "commit" && from === ROUND.leader) {
      if (ROUND.staged.size !== ROUND.participants.length || !S._transition?.applied) {
        ROUND.pendingCommit = m;
        return;
      }
      if ([...ROUND.staged.values()].some((hash) => hash !== m.hash) || S._transition.postHash !== m.hash) {
        throw new Error("availability commit certificate");
      }
      const TR = S._transition;
      if (ROUND.reason === "auto-transfer" || ROUND.participants.length === S.players.length) {
        this.anchorId = TR.proposal.coordinatorId;
      }
      this.branch = TR.proposal.branch;
      this.recovering = false;
      this.tenureAt = now;
      this.lastEvaluation = now;
      this.retryAt = now + this.config.retryMs;
      this.wireBranch = Uint8Array.from(this.branch.match(/../g), (hex) => parseInt(hex, 16));
      this.requested = null;
      if (ROUND.votes.get(S.localPlayerId).pumping) {
        this.lastAdvance = now;
      }
      TR.discardCommands = ROUND.votes.get(S.localPlayerId).branch !== ROUND.votes.get(ROUND.decision.donor).branch || ROUND.votes.get(S.localPlayerId).tick === ROUND.decision.tick && ROUND.votes.get(S.localPlayerId).hash !== ROUND.decision.hash;
      const PREVIOUS_COORDINATOR = S.coordinatorId;
      this.round = null;
      S._commit(TR);
      if (S.coordinatorId !== PREVIOUS_COORDINATOR) {
        S._event("coordinator-changed", {
          previousCoordinatorId: PREVIOUS_COORDINATOR,
          coordinatorId: S.coordinatorId,
          reason: ROUND.reason
        });
      }
      return;
    }
  }
  installed(hash) {
    this.send(this.round.participants, "staged", {
      round: this.round.id,
      hash
    });
  }
  drain(now) {
    const R = this.round;
    if (R?.pendingDecision && R.votes.size === R.participants.length) {
      const M = R.pendingDecision;
      R.pendingDecision = null;
      this.handle(R.leader, M, now);
    }
    if (R?.pendingCheckpoint && R.decision) {
      const P = R.pendingCheckpoint;
      R.pendingCheckpoint = null;
      this.handle(P.from, P.message, now);
    }
    if (R?.pendingCommit && R.staged.size === R.participants.length && this.session._transition?.applied) {
      const M = R.pendingCommit;
      R.pendingCommit = null;
      this.handle(R.leader, M, now);
    }
  }
  cancel() {
    this.round?.replay?.cancel();
    const S = this.session, TR = S._transition;
    if (TR?.availability) {
      TR.stageJob?.cancel();
      if (this.round?.original) {
        S.adapter.load(this.round.original);
      }
      S._transition = null;
    }
    this.round = null;
  }
};

// modules/deterministic/value-codec.js
var TYPED_KINDS = [
  [Int8Array, "getInt8", "setInt8", 1],
  [Int16Array, "getInt16", "setInt16", 2],
  [Uint16Array, "getUint16", "setUint16", 2],
  [Int32Array, "getInt32", "setInt32", 4],
  [Uint32Array, "getUint32", "setUint32", 4],
  [Float32Array, "getFloat32", "setFloat32", 4],
  [Float64Array, "getFloat64", "setFloat64", 8]
];
var FLOAT_KIND_START = 5;
var SCRATCH_LIMIT = 8 * 1024 * 1024;
function typedKindOf(value) {
  for (let i = 0; i < TYPED_KINDS.length; i++) {
    if (value instanceof TYPED_KINDS[i][0]) {
      return i;
    }
  }
  return -1;
}
function createValueCodec({
  format = "binary",
  maxBytes = 16 * 1024 * 1024,
  maxDepth = 128,
  maxEntries = 1e6,
  omitUndefined = false
} = {}) {
  if (!["binary", "json"].includes(format)) {
    throw new TypeError("Unknown codec format");
  }
  if (typeof omitUndefined !== "boolean") {
    throw new TypeError("omitUndefined must be boolean");
  }
  const KEYS_OF = (value) => Object.keys(value).filter((key) => !omitUndefined || value[key] !== void 0).sort();
  for (const LIMIT of [maxBytes, maxDepth, maxEntries]) {
    if (!Number.isSafeInteger(LIMIT) || LIMIT < 1) {
      throw new RangeError("Invalid codec limit");
    }
  }
  const ENCODER2 = new TextEncoder(), DECODER2 = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true
  });
  function normalize(value, depth = 0, seen = /* @__PURE__ */ new Set(), budget = {
    count: 0
  }) {
    if (depth > maxDepth || ++budget.count > maxEntries) {
      throw new RangeError("Value codec budget exceeded");
    }
    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Finite numbers required");
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      if (DECODER2.decode(ENCODER2.encode(value)) !== value) {
        throw new TypeError("Invalid Unicode string");
      }
      return value;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      throw new TypeError("Unsupported or cyclic value");
    }
    seen.add(value);
    let result;
    if (value instanceof Uint8Array || typedKindOf(value) >= 0) {
      if (format === "json") {
        throw new TypeError("JSON codec does not support byte values");
      }
      result = value;
    } else if (Array.isArray(value)) {
      result = Array.from(value, (item) => normalize(item, depth + 1, seen, budget));
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new TypeError("Plain records required");
      }
      result = {};
      for (const KEY of KEYS_OF(value)) {
        normalize(KEY, depth + 1, seen, budget);
        Object.defineProperty(result, KEY, {
          value: normalize(value[KEY], depth + 1, seen, budget),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
    }
    seen.delete(value);
    return result;
  }
  let scratch = null, encoding = false;
  const STRING_CACHE = /* @__PURE__ */ new Map();
  let cachedStringBytes = 0;
  function stringBytes(value) {
    let data = STRING_CACHE.get(value);
    if (data) {
      return data;
    }
    for (let i = 0; i < value.length; i++) {
      const C = value.charCodeAt(i);
      if (C >= 55296 && C <= 56319) {
        const NEXT = value.charCodeAt(++i);
        if (!(NEXT >= 56320 && NEXT <= 57343)) {
          throw new TypeError("Invalid Unicode string");
        }
      } else if (C >= 56320 && C <= 57343) {
        throw new TypeError("Invalid Unicode string");
      }
    }
    data = ENCODER2.encode(value);
    if (data.length <= 256 && STRING_CACHE.size < 1024 && cachedStringBytes + data.length <= 131072) {
      STRING_CACHE.set(value, data);
      cachedStringBytes += data.length;
    }
    return data;
  }
  function encode(value) {
    if (format === "json") {
      const BYTES = ENCODER2.encode(JSON.stringify(normalize(value)));
      if (BYTES.length > maxBytes) {
        throw new RangeError("Codec byte budget exceeded");
      }
      return BYTES;
    }
    const NESTED = encoding;
    encoding = true;
    let bytes2 = !NESTED && scratch ? scratch : new Uint8Array(Math.min(1024, maxBytes));
    let offset = 0;
    let view = new DataView(bytes2.buffer);
    let entries = 0;
    const SEEN = /* @__PURE__ */ new Set(), STRINGS = /* @__PURE__ */ new Map();
    function reserve(size) {
      if (offset + size > maxBytes) {
        throw new RangeError("Codec byte budget exceeded");
      }
      if (offset + size > bytes2.length) {
        const NEXT = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes2.length * 2)));
        NEXT.set(bytes2);
        bytes2 = NEXT;
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
      if (depth > maxDepth || ++entries > maxEntries) {
        throw new RangeError("Value codec budget exceeded");
      }
      if (v === null) {
        byte(0);
      } else if (v === false) {
        byte(1);
      } else if (v === true) {
        byte(2);
      } else if (typeof v === "number") {
        if (!Number.isFinite(v)) {
          throw new TypeError("Finite numbers required");
        }
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
        const REF = STRINGS.get(v);
        if (REF !== void 0) {
          byte(9);
          variable(REF);
        } else {
          STRINGS.set(v, STRINGS.size);
          byte(4);
          raw(stringBytes(v));
        }
      } else {
        if (!v || typeof v !== "object" || SEEN.has(v)) {
          throw new TypeError("Unsupported or cyclic value");
        }
        if (v instanceof Uint8Array) {
          byte(7);
          raw(v);
          return;
        }
        const KIND = typedKindOf(v);
        if (KIND >= 0) {
          const [, , SET, SIZE] = TYPED_KINDS[KIND];
          byte(10);
          byte(KIND);
          length(v.length);
          reserve(v.length * SIZE);
          for (let i = 0; i < v.length; i++) {
            let element = v[i];
            if (KIND >= FLOAT_KIND_START) {
              if (!Number.isFinite(element)) {
                throw new TypeError("Finite numbers required");
              }
              if (element === 0) {
                element = 0;
              }
            }
            view[SET](offset, element, true);
            offset += SIZE;
          }
          return;
        }
        SEEN.add(v);
        if (Array.isArray(v)) {
          byte(5);
          length(v.length);
          for (const ITEM of v) {
            write(ITEM, depth + 1);
          }
        } else {
          const PROTOTYPE = Object.getPrototypeOf(v);
          if (PROTOTYPE !== Object.prototype && PROTOTYPE !== null) {
            throw new TypeError("Plain records required");
          }
          byte(6);
          const KEYS = KEYS_OF(v);
          length(KEYS.length);
          for (const KEY of KEYS) {
            write(KEY, depth + 1);
            write(v[KEY], depth + 1);
          }
        }
        SEEN.delete(v);
      }
    }
    try {
      byte(82);
      byte(86);
      byte(1);
      write(value);
      return bytes2.slice(0, offset);
    } finally {
      if (!NESTED) {
        scratch = bytes2.length <= SCRATCH_LIMIT ? bytes2 : null;
        encoding = false;
      }
    }
  }
  function decode(input) {
    const BYTES = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
    if (!BYTES || BYTES.length > maxBytes) {
      throw new RangeError("Invalid codec bytes");
    }
    let result;
    if (format === "json") {
      result = normalize(JSON.parse(DECODER2.decode(BYTES)));
    } else {
      let need = function(n) {
        if (n > BYTES.length - offset) {
          throw new RangeError("Truncated codec bytes");
        }
      }, byte = function() {
        need(1);
        return BYTES[offset++];
      }, length = function() {
        need(4);
        const N = VIEW.getUint32(offset, true);
        offset += 4;
        return N;
      }, raw = function() {
        const N = length();
        need(N);
        const DATA = BYTES.subarray(offset, offset + N);
        offset += N;
        return DATA;
      }, read = function(depth = 0) {
        if (depth > maxDepth || ++entries > maxEntries) {
          throw new RangeError("Value codec budget exceeded");
        }
        const TAG = byte();
        if (TAG === 0) {
          return null;
        }
        if (TAG === 1) {
          return false;
        }
        if (TAG === 2) {
          return true;
        }
        if (TAG === 3) {
          need(8);
          const N2 = VIEW.getFloat64(offset, true);
          offset += 8;
          if (!Number.isFinite(N2) || Object.is(N2, -0) || Number.isInteger(N2) && N2 >= -2147483648 && N2 <= 2147483647) {
            throw new TypeError("Noncanonical number");
          }
          return N2;
        }
        if (TAG === 8 || TAG === 9) {
          let n = 0;
          let scale = 1;
          let part;
          for (let i = 0; i < 5; i++) {
            part = byte();
            n += (part & 127) * scale;
            if (n > 4294967295) {
              throw new TypeError("Integer overflow");
            }
            if (part < 128) {
              if (i && part === 0) {
                throw new TypeError("Noncanonical integer");
              }
              if (TAG === 9) {
                if (n >= STRINGS.length) {
                  throw new TypeError("Invalid string reference");
                }
                return STRINGS[n];
              }
              return n % 2 ? -(n + 1) / 2 : n / 2;
            }
            scale *= 128;
          }
          throw new TypeError("Invalid integer");
        }
        if (TAG === 4) {
          const VALUE = DECODER2.decode(raw());
          if (STRING_SET.has(VALUE)) {
            throw new TypeError("Noncanonical repeated string");
          }
          STRING_SET.add(VALUE);
          STRINGS.push(VALUE);
          return VALUE;
        }
        if (TAG === 7) {
          return raw().slice();
        }
        if (TAG === 10) {
          const KIND = byte();
          if (KIND >= TYPED_KINDS.length) {
            throw new TypeError("Invalid typed array kind");
          }
          const [TYPE2, GET, , SIZE] = TYPED_KINDS[KIND];
          const COUNT = length();
          need(COUNT * SIZE);
          const ARRAY = new TYPE2(COUNT);
          for (let i = 0; i < COUNT; i++) {
            const ELEMENT = VIEW[GET](offset, true);
            if (KIND >= FLOAT_KIND_START && (!Number.isFinite(ELEMENT) || Object.is(ELEMENT, -0))) {
              throw new TypeError("Noncanonical typed array number");
            }
            ARRAY[i] = ELEMENT;
            offset += SIZE;
          }
          return ARRAY;
        }
        if (TAG !== 5 && TAG !== 6) {
          throw new TypeError("Invalid codec tag");
        }
        const N = length();
        if (N > maxEntries - entries) {
          throw new RangeError("Value codec budget exceeded");
        }
        if (TAG === 5) {
          const ARR = [];
          for (let i = 0; i < N; i++) {
            ARR.push(read(depth + 1));
          }
          return ARR;
        }
        const OBJ = {};
        let previous;
        for (let i = 0; i < N; i++) {
          const KEY = read(depth + 1);
          if (typeof KEY !== "string" || i && KEY <= previous) {
            throw new TypeError("Noncanonical record key");
          }
          if (KEY === "__proto__") {
            Object.defineProperty(OBJ, KEY, {
              value: read(depth + 1),
              enumerable: true,
              writable: true,
              configurable: true
            });
          } else {
            OBJ[KEY] = read(depth + 1);
          }
          previous = KEY;
        }
        return OBJ;
      };
      let offset = 0;
      let entries = 0;
      const STRINGS = [], STRING_SET = /* @__PURE__ */ new Set();
      const VIEW = new DataView(BYTES.buffer, BYTES.byteOffset, BYTES.byteLength);
      if (byte() !== 82 || byte() !== 86 || byte() !== 1) {
        throw new TypeError("Invalid codec header");
      }
      result = read();
      if (offset !== BYTES.length) {
        throw new TypeError("Trailing codec bytes");
      }
    }
    if (format === "json") {
      const CANONICAL = encode(result);
      if (CANONICAL.length !== BYTES.length || CANONICAL.some((v, i) => v !== BYTES[i])) {
        throw new TypeError("Noncanonical codec bytes");
      }
    }
    return result;
  }
  return Object.freeze({
    format,
    encode,
    decode
  });
}
var BINARY_CODEC = createValueCodec();
var JSON_CODEC = createValueCodec({
  format: "json"
});

// modules/rollback/room-session.js
var ROOM_MAGIC = 827477316;
var WIRE_HEADER = 24;
var MAX_EPOCH = 65534;
var BRANCH_MAGIC = 843205956;
var BRANCH_HEADER = 36;
var ORDERED = (ids) => [...ids].sort(COMPARE_IDS);
var SAME = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var ID_VALID = (id) => typeof id === "string" && id.length > 0 && id.length <= 128;
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
    profile = PROFILES.lockstep,
    adapter,
    membership = {},
    clock = NOW_MS,
    onEvent = () => {
    },
    availability = {},
    roomOwnerId = room?.coordinatorId ?? localPlayerId,
    localFastPath = false
  } = {}) {
    if (!["local", "online"].includes(mode) || !ID_VALID(localPlayerId) || !ID_VALID(sessionId)) {
      throw new TypeError("room session identity/mode");
    }
    if (typeof localFastPath !== "boolean") {
      throw new TypeError("localFastPath");
    }
    integer(inputSize, "inputSize", 1, 1024);
    if (!ID_VALID(simulationVersion) || sessionId.length > 116) {
      throw new TypeError("room simulationVersion/sessionId");
    }
    if (mode === "local" && room) {
      throw new TypeError("local room cannot own online transport");
    }
    if (profile.mode && !["lockstep", "rollback"].includes(profile.mode)) {
      throw new TypeError("session mode");
    }
    if (!adapter || ["step", "save", "load", "validateSnapshot", "applyMembership"].some(
      (k) => typeof adapter[k] !== "function"
    )) {
      throw new TypeError("room simulation adapter");
    }
    if (mode === "online" && (!room || typeof room.subscribe !== "function" || typeof room.connectMesh !== "function" || typeof room.setRoster !== "function")) {
      throw new TypeError("dynamic room capability");
    }
    if (typeof clock !== "function" || typeof onEvent !== "function") {
      throw new TypeError("room session capability");
    }
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
    for (const [K, V] of Object.entries(this.membership)) {
      integer(V, K, 1, 2147483647);
    }
    integer(this.membership.maxCatchupSteps, "maxCatchupSteps", 1, 8192);
    integer(this.membership.maxPlayers, "maxPlayers", 1, 8);
    integer(this.membership.maxTransferBytes, "maxTransferBytes", CHUNK_SIZE, 128 * 1024 * 1024);
    const SIMULATION_MODE = profile.mode ?? "lockstep";
    if (localFastPath && (mode !== "local" || SIMULATION_MODE !== "lockstep")) {
      throw new TypeError("localFastPath requires a local lockstep RoomSession");
    }
    this.profile = Object.freeze({
      ...SIMULATION_MODE === "rollback" ? PROFILES.action : PROFILES.lockstep,
      ...profile,
      mode: SIMULATION_MODE,
      adaptiveInputDelay: SIMULATION_MODE === "rollback" ? profile.adaptiveInputDelay ?? true : false
    });
    this.localFastPath = localFastPath;
    this.availability = availabilityConfig(availability);
    if (localFastPath && this.availability.mode !== "strict") {
      throw new TypeError("localFastPath requires strict availability");
    }
    if (!ID_VALID(roomOwnerId)) {
      throw new TypeError("roomOwnerId");
    }
    this.roomOwnerId = roomOwnerId;
    this.codec = createValueCodec({
      maxBytes: this.membership.maxTransferBytes,
      maxEntries: Math.min(this.membership.maxTransferBytes, 1e6),
      maxDepth: 32
    });
    this.contract = hashBytes(
      this.codec.encode({
        version: 2,
        protocol: PROTOCOL_VERSION,
        mode: this.profile.mode,
        rollbackWindowTicks: this.profile.rollbackWindowTicks,
        stateHistorySize: this.profile.stateHistorySize,
        simulationVersion,
        seed,
        inputSize,
        maxPlayers: this.membership.maxPlayers,
        tickRate: this.profile.tickRate,
        baseInputDelayTicks: this.profile.baseInputDelayTicks,
        checksumInterval: this.profile.checksumInterval,
        ...this.availability.mode === "available" ? {
          availability: this.availability
        } : {}
      })
    );
    this.epoch = room?.epoch ?? 0;
    this.baseTick = 0;
    this.coordinatorId = room?.coordinatorId ?? localPlayerId;
    this.players = Object.freeze(ORDERED(mode === "online" ? room.players : [localPlayerId]));
    this.activePlayers = this.players;
    this._availability = this.availability.mode === "available" ? new Availability(this) : null;
    this._retainedCommandSequences = Object.fromEntries(this.players.map((id) => [id, 0]));
    this._suspendedCommands = null;
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
    this._stats = {
      transitions: 0,
      bootstrapBytes: 0,
      bootstrapTicks: 0,
      rejectedMessages: 0,
      sentControlBytes: 0,
      receivedControlBytes: 0,
      membershipPrepareMs: 0,
      membershipCommitMs: 0,
      bootstrapPrepareMs: 0,
      bootstrapPulseMs: 0,
      maxBoundaryTaskMs: 0,
      boundaryLongTasks: 0
    };
    this._totals = {
      snapshotSaves: 0,
      serializedSnapshotBytes: 0,
      stateHashComputations: 0,
      hashedStateBytes: 0
    };
    if (mode === "local" || this.players.includes(localPlayerId) && !room?.resumed) {
      this.adapter.applyMembership({
        epoch: this.epoch,
        tick: 0,
        players: [...this.players],
        joined: [...this.players],
        left: [],
        coordinatorId: this.coordinatorId,
        reason: "initial"
      });
      this._startCore();
    }
    if (room) {
      this._unsubscribeRoom = room.subscribe((event) => {
        if (this.closed || this.failure) {
          return;
        }
        if (event.type === "peer-connected") {
          this._attach(event.peerId, event.transport);
        }
        if (event.type === "peer-disconnected") {
          if (!this.players.includes(event.peerId) && !this._transition?.participants.includes(event.peerId)) {
            const LINK = this._links.get(event.peerId);
            LINK?.unsubscribe?.();
            LINK?.detachCore?.();
            this._links.delete(event.peerId);
          }
          this._event("peer-disconnected", {
            peerId: event.peerId,
            reason: event.reason
          });
        }
        if (event.type === "room-failed") {
          this._fail("transport-failed", {
            reason: event.reason
          });
        }
      });
      for (const [ID, TRANSPORT] of room.transports) {
        this._attach(ID, TRANSPORT);
      }
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
    const STATE = this._core?.localInputState;
    if (!STATE) {
      return null;
    }
    return {
      ...STATE,
      epoch: this.epoch,
      baseTick: this.baseTick,
      tick: this.tick,
      confirmedTick: this.confirmedTick,
      captures: STATE.captures.map((c) => ({
        ...c,
        captureTick: c.captureTick + this.baseTick,
        executeTick: c.executeTick + this.baseTick,
        commands: c.commands.map((command) => ({
          ...command,
          executeTick: command.executeTick + this.baseTick
        }))
      })),
      capture: STATE.capture ? {
        ...STATE.capture,
        captureTick: STATE.capture.captureTick + this.baseTick,
        executeTick: STATE.capture.executeTick + this.baseTick,
        commands: STATE.capture.commands.map((c) => ({
          ...c,
          executeTick: c.executeTick + this.baseTick
        }))
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
    if (this.closed) {
      return "closed";
    }
    if (this.failure) {
      return "failed";
    }
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch") {
      return "resynchronizing";
    }
    if (!this.activePlayers.includes(this.localPlayerId) && this.players.includes(this.localPlayerId)) {
      return "suspended";
    }
    if (this._transition?.replay) {
      return "catching-up";
    }
    if (this._transition) {
      return "membership";
    }
    return this._core?.status ?? "joining";
  }
  get metrics() {
    const CORE = this._core?.metrics ?? {};
    const SUMS = Object.fromEntries(Object.entries(this._totals).map(([k, v]) => [k, v + (CORE[k] ?? 0)]));
    return {
      ...CORE,
      ...SUMS,
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
      this.onEvent({
        type,
        tick: this.tick,
        epoch: this.epoch,
        ...detail
      });
    } catch {
    }
  }
  _fail(type, detail = {}) {
    if (this.closed || this._failure) {
      return;
    }
    this._failure = Object.freeze({
      type,
      ...detail
    });
    try {
      this._availability?.cancel();
    } catch (error) {
      this._failure = Object.freeze({
        type,
        ...detail,
        restoreError: error.message
      });
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
    for (const LINK of this._links.values()) {
      LINK.unsubscribe?.();
      LINK.detachCore?.();
    }
    this._links.clear();
    this._incoming.length = 0;
    this._incomingBytes = 0;
    this.room?.close();
    this._event(type, detail);
  }
  _adapter(baseTick = this.baseTick, epoch = this.epoch) {
    const A = this.adapter;
    const CONTEXT_AT = (context = {}) => ({
      ...context,
      tick: (context.tick ?? 0) + baseTick,
      membershipEpoch: epoch,
      ...this._availability ? {
        players: [...this.players],
        activePlayers: context.players ?? [...this.activePlayers]
      } : {}
    });
    return {
      save: () => A.save(),
      load: (data) => A.load(data),
      ...typeof A.saveJob === "function" ? {
        saveJob: () => A.saveJob()
      } : {},
      ...typeof A.prepareSnapshotJob === "function" && typeof A.loadPreparedSnapshot === "function" ? {
        prepareSnapshotJob: (data, context) => A.prepareSnapshotJob(data, CONTEXT_AT(context)),
        loadPreparedSnapshot: (prepared, context) => A.loadPreparedSnapshot(prepared, CONTEXT_AT(context))
      } : {},
      ...typeof A.prepareSnapshot === "function" && typeof A.loadPreparedSnapshot === "function" ? {
        prepareSnapshot: (data, context) => A.prepareSnapshot(data, CONTEXT_AT(context)),
        loadPreparedSnapshot: (prepared, context) => A.loadPreparedSnapshot(prepared, CONTEXT_AT(context))
      } : {},
      validateSnapshot: (data, context = {}) => A.validateSnapshot(data, CONTEXT_AT(context)),
      step: (context) => {
        context.tick += baseTick;
        context.membershipEpoch = epoch;
        for (const FRAME of context.inputs) {
          for (const COMMAND of FRAME.commands) {
            COMMAND.executeTick += baseTick;
            if (COMMAND.executeTick !== context.tick) {
              throw new Error("reserved command execution tick");
            }
          }
        }
        const START = this._availability ? NOW_MS() : 0;
        try {
          return A.step(context);
        } finally {
          if (this._availability && !context.resimulating) {
            this._availability.measureStep(Math.max(0, NOW_MS() - START));
          }
        }
      }
    };
  }
  _exportBootstrap(options) {
    const BOOTSTRAP = this._core.exportConfirmedBootstrap(options);
    return {
      ...BOOTSTRAP,
      roomCommandSequences: {
        ...this._retainedCommandSequences,
        ...BOOTSTRAP.commandSequences
      }
    };
  }
  _bootstrapCommandSequences(bootstrap, players) {
    const SEQUENCES = bootstrap.roomCommandSequences;
    if (!SEQUENCES || Object.keys(SEQUENCES).length !== players.length || players.some((id) => !Object.hasOwn(SEQUENCES, id))) {
      throw new Error("room command sequence roster");
    }
    for (const ID of players) {
      integer(SEQUENCES[ID], "room command sequence");
    }
    for (const ID of bootstrap.players) {
      if (SEQUENCES[ID] !== bootstrap.commandSequences[ID]) {
        throw new Error("room command sequence baseline");
      }
    }
    return SEQUENCES;
  }
  _startCore(commandState, commandSequences, boundary) {
    if (commandState) {
      const OFFSET = (commandState.tickOffset ?? 0) - this.baseTick;
      commandState = {
        ...commandState,
        sealedThrough: Math.max(-1, (commandState.sealedThrough ?? -1) + OFFSET),
        commands: commandState.commands.map((c) => ({
          ...c,
          executeTick: c.executeTick + OFFSET
        })),
        inputs: (commandState.inputs ?? []).filter((f) => f.tick + OFFSET >= 0).map((f) => ({
          ...f,
          tick: f.tick + OFFSET
        })),
        tickOffset: 0
      };
      if (commandState.commands.some((c) => c.executeTick < 0)) {
        throw new Error("reserved command precedes accepted boundary; resynchronization required");
      }
    }
    const OPTIONS = {
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
        if (event.type !== "closed") {
          this._event(event.type, {
            ...event,
            tick: event.tick + this.baseTick,
            ...event.schedule ? {
              schedule: {
                ...event.schedule,
                baseTick: this.baseTick
              }
            } : {},
            ...Array.isArray(event.commands) ? {
              commands: event.commands.map((c) => ({
                ...c,
                executeTick: c.executeTick + this.baseTick
              }))
            } : {},
            ...Number.isSafeInteger(event.executeTick) ? {
              executeTick: event.executeTick + this.baseTick
            } : {},
            ...["rollback", "recovered", "reconciled"].includes(event.type) ? {
              from: event.from + this.baseTick,
              target: event.target + this.baseTick
            } : {}
          });
        }
      }
    };
    if (this.localFastPath && boundary) {
      throw new Error("local fast path cannot install a recovery boundary");
    }
    this._core = boundary ? createSessionFromBoundary(OPTIONS, boundary.bytes, boundary.hash) : this.localFastPath ? createLocalFastPathSession(OPTIONS) : createSession(OPTIONS);
    if (this._availability) {
      delegateRoomRecovery(this._core, () => {
        this._availability.requested = "state-mismatch";
      });
    }
    this.profile = this._core.profile;
    for (const [ID, LINK] of this._links) {
      this._attachCore(ID, LINK);
    }
    for (const PAYLOAD of this._pendingBeforeJoin.splice(0)) {
      this._core.queueCommand(PAYLOAD);
    }
  }
  _attachCore(id, link) {
    link.detachCore?.();
    link.detachCore = null;
    if (!this._core || !this.activePlayers.includes(id) || id === this.localPlayerId) {
      return;
    }
    const EPOCH = this.epoch, SESSION = this;
    link.detachCore = this._core.attachTransport(id, {
      get state() {
        return link.transport.state ?? "open";
      },
      send(data) {
        if (SESSION.closed || EPOCH !== SESSION.epoch) {
          return false;
        }
        const OUT = data.slice();
        new DataView(OUT.buffer).setUint16(6, EPOCH + 1, true);
        if (!SESSION._availability) {
          return link.transport.send(OUT);
        }
        const CAPACITY = CHUNK_SIZE - BRANCH_HEADER, FRAGMENTED = OUT.length > CAPACITY;
        for (let offset = 0; offset < OUT.length; offset += CAPACITY) {
          const PART = OUT.subarray(offset, offset + CAPACITY), ENVELOPE = new Uint8Array(PART.length + BRANCH_HEADER), VIEW = new DataView(ENVELOPE.buffer);
          VIEW.setUint32(0, BRANCH_MAGIC, true);
          ENVELOPE[4] = 1;
          ENVELOPE[5] = FRAGMENTED ? 1 : OUT[5];
          VIEW.setUint32(8, new DataView(OUT.buffer).getUint32(8, true), true);
          VIEW.setUint32(12, offset, true);
          VIEW.setUint32(16, OUT.length, true);
          ENVELOPE.set(SESSION._availability.wireBranch, 20);
          ENVELOPE.set(PART, BRANCH_HEADER);
          if (link.transport.send(ENVELOPE) === false) {
            return false;
          }
        }
        return true;
      },
      subscribe(fn) {
        link.coreReceive = fn;
        return () => {
          if (link.coreReceive === fn) {
            link.coreReceive = null;
          }
        };
      },
      subscribeStatus(fn) {
        return link.transport.subscribeStatus?.(fn) ?? (() => {
        });
      }
    });
    for (const PACKET of link.future.splice(0)) {
      this._receiveWire(id, link, PACKET);
    }
  }
  _attach(id, transport) {
    if (!ID_VALID(id) || id === this.localPlayerId || !transport?.send || !transport.subscribe) {
      return;
    }
    const OLD = this._links.get(id);
    if (OLD?.transport === transport) {
      return;
    }
    OLD?.unsubscribe?.();
    OLD?.detachCore?.();
    const LINK = {
      transport,
      queue: [],
      queuedBytes: 0,
      incoming: null,
      coreReceive: null,
      future: [],
      detachCore: null,
      lastControlSerial: 0
    };
    this._links.set(id, LINK);
    LINK.unsubscribe = transport.subscribe((data) => {
      if (!this.closed && this._links.get(id) === LINK) {
        this._receiveWire(id, LINK, data);
      }
    });
    this._attachCore(id, LINK);
    if (!this._core && id === this.coordinatorId) {
      this._joinSent = false;
    }
  }
  _boundaryFrozen() {
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch") {
      return true;
    }
    const TR = this._transition;
    return !!TR && (TR.proposal.reason === "reconnect" || !!TR.stageJob || !!TR.preparedState || TR.applied || !!TR.replay);
  }
  _receiveWire(id, link, raw) {
    try {
      let data = bytes(raw);
      if (this._availability && data.length >= BRANCH_HEADER && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === BRANCH_MAGIC) {
        if (data.length > CHUNK_SIZE || data[4] !== 1 || this._availability.wireBranch.some((n, i) => data[20 + i] !== n)) {
          return;
        }
        const ENVELOPE = new DataView(data.buffer, data.byteOffset), SERIAL2 = ENVELOPE.getUint32(8, true), OFFSET2 = ENVELOPE.getUint32(12, true), TOTAL2 = ENVELOPE.getUint32(16, true);
        const PART = data.subarray(BRANCH_HEADER);
        if (!TOTAL2 || TOTAL2 > CHUNK_SIZE || OFFSET2 + PART.length > TOTAL2) {
          throw new Error("branch wire capacity");
        }
        if (!OFFSET2 && TOTAL2 === PART.length) {
          data = PART;
        } else {
          if (!OFFSET2) {
            link.branchIncoming = {
              serial: SERIAL2,
              bytes: new Uint8Array(TOTAL2),
              offset: 0,
              at: this.clock()
            };
          }
          const PENDING = link.branchIncoming;
          if (!PENDING || PENDING.serial !== SERIAL2 || PENDING.bytes.length !== TOTAL2 || OFFSET2 !== PENDING.offset) {
            return;
          }
          PENDING.bytes.set(PART, OFFSET2);
          PENDING.offset += PART.length;
          if (PENDING.offset !== TOTAL2) {
            return;
          }
          data = PENDING.bytes;
          link.branchIncoming = null;
        }
      } else if (this._availability && data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === MAGIC) {
        return;
      }
      if (data.length < 12 || data.length > CHUNK_SIZE) {
        throw new Error("room wire size");
      }
      const VIEW = new DataView(data.buffer, data.byteOffset, data.length), MAGIC_LOCAL = VIEW.getUint32(0, true);
      if (MAGIC_LOCAL === MAGIC) {
        if (this._availability?.polled && this.clock() - this._availability.lastPoll > this.availability.resumeGapMs) {
          this._availability.recovering = true;
          this._availability.requested = "resume";
        }
        const EPOCH = VIEW.getUint16(6, true) - 1;
        if (EPOCH === this.epoch && link.coreReceive && !this._boundaryFrozen()) {
          const COPY = data.slice();
          new DataView(COPY.buffer).setUint16(6, 0, true);
          link.coreReceive(COPY);
        } else if (EPOCH === this.epoch + 1 && this._transition && link.future.length < 64) {
          link.future.push(data.slice());
        }
        return;
      }
      if (MAGIC_LOCAL !== ROOM_MAGIC || data.length < WIRE_HEADER || data[4] !== 1 || data[5] !== 0) {
        throw new Error("room wire protocol");
      }
      const SERIAL = VIEW.getUint32(8, true), TOTAL = VIEW.getUint32(12, true), OFFSET = VIEW.getUint32(16, true), DIGEST = VIEW.getUint32(20, true);
      if (this._availability && SERIAL <= link.lastControlSerial) {
        return;
      }
      if (!TOTAL || TOTAL > this.membership.maxTransferBytes || OFFSET + data.length - WIRE_HEADER > TOTAL) {
        throw new Error("room wire capacity");
      }
      if (OFFSET === 0) {
        if (this._availability && SERIAL <= link.lastControlSerial) {
          return;
        }
        if (link.incoming) {
          throw new Error("overlapping room transfer");
        }
        link.incoming = {
          serial: SERIAL,
          bytes: new Uint8Array(TOTAL),
          offset: 0,
          digest: DIGEST,
          startedAt: this.clock()
        };
      }
      const INCOMING = link.incoming;
      if (!INCOMING || INCOMING.serial !== SERIAL || INCOMING.offset !== OFFSET || INCOMING.digest !== DIGEST || INCOMING.bytes.length !== TOTAL) {
        throw new Error("room wire order");
      }
      INCOMING.bytes.set(data.subarray(WIRE_HEADER), OFFSET);
      INCOMING.offset += data.length - WIRE_HEADER;
      this._stats.receivedControlBytes += data.length;
      if (INCOMING.offset === TOTAL) {
        link.incoming = null;
        if (hashBytes(INCOMING.bytes) !== DIGEST) {
          throw new Error("room wire digest");
        }
        link.lastControlSerial = SERIAL;
        const VALUE = this.codec.decode(INCOMING.bytes);
        if (this._availability && VALUE?.op === "availability-activity") {
          const PREVIOUS = this._incoming.findIndex((m) => m.from === id && m.value?.op === VALUE.op);
          if (PREVIOUS >= 0) {
            this._incomingBytes -= this._incoming[PREVIOUS].size;
            this._incoming.splice(PREVIOUS, 1);
          }
        }
        if (this._incoming.length >= 128 || this._incomingBytes + TOTAL > this.membership.maxTransferBytes * 2) {
          throw new Error("room control backlog");
        }
        this._incoming.push({
          from: id,
          value: VALUE,
          size: TOTAL
        });
        this._incomingBytes += TOTAL;
      }
    } catch (error) {
      link.incoming = null;
      this._stats.rejectedMessages++;
      if (this.players.includes(id)) {
        this._fail("room-protocol-error", {
          peerId: id,
          reason: error.message
        });
      }
    }
  }
  _send(to, op, detail = {}) {
    if (to === this.localPlayerId) {
      this._incoming.push({
        from: to,
        value: {
          op,
          sessionId: this.sessionId,
          contract: this.contract,
          ...detail
        }
      });
      return;
    }
    const LINK = this._links.get(to);
    if (!LINK) {
      throw new Error("room peer unavailable: " + to);
    }
    const BODY = this.codec.encode({
      op,
      sessionId: this.sessionId,
      contract: this.contract,
      ...detail
    });
    const CHUNKS = Math.ceil(BODY.length / (CHUNK_SIZE - WIRE_HEADER)), BUDGET = BODY.length + CHUNKS * WIRE_HEADER;
    if (LINK.queuedBytes + BUDGET > this.membership.maxTransferBytes * 2) {
      throw new Error("room send queue capacity");
    }
    const SERIAL = ++this._messageSequence >>> 0, DIGEST = hashBytes(BODY);
    for (let offset = 0; offset < BODY.length; offset += CHUNK_SIZE - WIRE_HEADER) {
      const SLICE = BODY.subarray(offset, offset + CHUNK_SIZE - WIRE_HEADER), PACKET = new Uint8Array(WIRE_HEADER + SLICE.length), VIEW = new DataView(PACKET.buffer);
      VIEW.setUint32(0, ROOM_MAGIC, true);
      PACKET[4] = 1;
      VIEW.setUint32(8, SERIAL, true);
      VIEW.setUint32(12, BODY.length, true);
      VIEW.setUint32(16, offset, true);
      VIEW.setUint32(20, DIGEST, true);
      PACKET.set(SLICE, WIRE_HEADER);
      LINK.queue.push(PACKET);
      LINK.queuedBytes += PACKET.length;
    }
  }
  _broadcast(ids, op, detail = {}) {
    for (const ID of ids) {
      this._send(ID, op, detail);
    }
  }
  _flush() {
    for (const LINK of this._links.values()) {
      let count = 0;
      while (LINK.queue.length && count++ < 16) {
        const DATA = LINK.queue[0];
        if (LINK.transport.send(DATA) === false) {
          break;
        }
        LINK.queue.shift();
        LINK.queuedBytes -= DATA.length;
        this._stats.sentControlBytes += DATA.length;
      }
    }
  }
  _proposal(joined, left, reason, resumingId = null) {
    if (this._transition || this._availability?.round || this.localPlayerId !== this.coordinatorId) {
      throw new Error("membership coordinator busy");
    }
    if (left.includes(this.localPlayerId)) {
      for (const ID of this._admissionQueue.keys()) {
        this._send(ID, "reject", {
          reason: "coordinator-changing"
        });
      }
      this._admissionQueue.clear();
    }
    if (this.epoch >= MAX_EPOCH) {
      throw new Error("room epoch exhausted");
    }
    const PLAYERS = ORDERED([...this.players.filter((id) => !left.includes(id)), ...joined]);
    if (!PLAYERS.length) {
      this.close();
      return;
    }
    if (PLAYERS.length > this.membership.maxPlayers || new Set(PLAYERS).size !== PLAYERS.length) {
      throw new Error("room capacity");
    }
    const PROPOSAL = {
      epoch: this.epoch + 1,
      oldPlayers: [...this.players],
      players: PLAYERS,
      joined,
      left,
      reason,
      resumingId,
      coordinatorId: PLAYERS.includes(this.coordinatorId) ? this.coordinatorId : PLAYERS[0]
    };
    for (const ID of joined) {
      this._send(ID, "welcome", {
        epoch: this.epoch,
        players: [...this.players]
      });
    }
    this._acceptProposal(this.localPlayerId, PROPOSAL);
    const TR = this._transition;
    Promise.resolve(this.room?.connectMesh(TR.participants)).then(() => {
      if (this.closed || this.failure || this._transition !== TR) {
        return;
      }
      for (const [ID, TRANSPORT] of this.room?.transports ?? []) {
        this._attach(ID, TRANSPORT);
      }
      this._broadcast(
        TR.participants.filter((id) => id !== this.localPlayerId),
        "propose",
        {
          proposal: PROPOSAL
        }
      );
    }).catch(
      (error) => this._fail("membership-connect-failed", {
        reason: error.message
      })
    );
  }
  _acceptProposal(from, proposal) {
    if (from !== this.coordinatorId || this._transition || !proposal || proposal.epoch !== this.epoch + 1 || proposal.epoch > MAX_EPOCH) {
      throw new Error("membership proposal authority/epoch");
    }
    if (!Array.isArray(proposal.oldPlayers) || !Array.isArray(proposal.players) || !Array.isArray(proposal.joined) || !Array.isArray(proposal.left)) {
      throw new Error("membership roster shape");
    }
    if (!["join", "leave", "reconnect"].includes(proposal.reason) || proposal.reason === "reconnect" && (!proposal.oldPlayers.includes(proposal.resumingId) || proposal.joined.length || proposal.left.length)) {
      throw new Error("membership reason");
    }
    if (!SAME(proposal.oldPlayers, this.players) || !SAME(ORDERED(proposal.players), proposal.players) || !proposal.players.length || proposal.players.length > this.membership.maxPlayers || new Set(proposal.players).size !== proposal.players.length || proposal.players.some((id) => !ID_VALID(id)) || !proposal.players.includes(proposal.coordinatorId) || !SAME(
      ORDERED([...proposal.oldPlayers.filter((id) => !proposal.left.includes(id)), ...proposal.joined]),
      proposal.players
    ) || proposal.joined.some((id) => proposal.oldPlayers.includes(id)) || proposal.left.some((id) => !proposal.oldPlayers.includes(id))) {
      throw new Error("membership roster mismatch");
    }
    proposal = Object.freeze({
      ...proposal,
      oldPlayers: Object.freeze([...proposal.oldPlayers]),
      players: Object.freeze([...proposal.players]),
      joined: Object.freeze([...proposal.joined]),
      left: Object.freeze([...proposal.left])
    });
    const PARTICIPANTS = ORDERED([.../* @__PURE__ */ new Set([...proposal.oldPlayers, ...proposal.joined])]);
    if (!PARTICIPANTS.includes(this.localPlayerId)) {
      throw new Error("membership local participant");
    }
    const TR = this._transition = {
      proposal,
      participants: PARTICIPANTS,
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
    this._event("membership-preparing", {
      proposal
    });
    Promise.resolve(this.room?.connectMesh(PARTICIPANTS)).then(() => {
      if (this.closed || this.failure || this._transition !== TR) {
        return;
      }
      for (const [ID, TRANSPORT] of this.room?.transports ?? []) {
        this._attach(ID, TRANSPORT);
      }
      if (this._core?.resimulating) {
        this._core.poll();
      }
      this._send(from, "prepared", {
        epoch: proposal.epoch,
        tick: this._core ? this.confirmedTick + 1 : -1
      });
    }).catch(
      (error) => this._fail("membership-connect-failed", {
        reason: error.message
      })
    );
  }
  _handle(from, m) {
    if (this._availability && m?.op?.startsWith("availability-") && m.sessionId === this.sessionId && m.contract === this.contract) {
      if (this._transition && !this._transition.availability) {
        return;
      }
      this._availability.handle(from, m, this.clock());
      return;
    }
    const PARTICIPANT = this.players.includes(from) || this._transition?.participants.includes(from);
    if (!PARTICIPANT && m?.op !== "join") {
      this._stats.rejectedMessages++;
      return;
    }
    if ([
      "propose",
      "barrier",
      "install",
      "bootstrap",
      "resume-install",
      "commit",
      "reject",
      "leave-busy",
      "welcome"
    ].includes(m?.op) && from !== this.coordinatorId) {
      this._stats.rejectedMessages++;
      return;
    }
    if (!m || m.sessionId !== this.sessionId || m.contract !== this.contract) {
      this._stats.rejectedMessages++;
      if (m?.op === "join") {
        this._send(from, "reject", {
          reason: "incompatible-session"
        });
      }
      return;
    }
    if (m.op === "welcome" && from === this.coordinatorId && !this._core && !this.room?.resumed && !this._transition) {
      if (!Number.isInteger(m.epoch) || m.epoch < this.epoch || m.epoch > MAX_EPOCH || !Array.isArray(m.players) || m.players.length < 1 || m.players.length >= this.membership.maxPlayers || m.players.includes(this.localPlayerId) || !m.players.includes(from) || m.players.some((id) => !ID_VALID(id)) || new Set(m.players).size !== m.players.length || !SAME(ORDERED(m.players), m.players)) {
        return;
      }
      this.epoch = m.epoch;
      this.players = Object.freeze([...m.players]);
      this.activePlayers = this.players;
      this.room?.setRoster({
        epoch: this.epoch,
        players: [...this.players],
        coordinatorId: this.coordinatorId
      });
      return;
    }
    if (m.op === "retire" && this._departing && from === this.coordinatorId && m.epoch === this.epoch) {
      this._retireApproved = true;
      return;
    }
    if (m.op === "reject" && from === this.coordinatorId && !this._core) {
      this._fail("join-rejected", {
        reason: m.reason
      });
      return;
    }
    if (m.op === "join" && this.localPlayerId === this.coordinatorId) {
      if (this.players.includes(from)) {
        if (m.resume === true && !this._transition) {
          this._proposal([], [], "reconnect", from);
        }
        return;
      }
      if (this._transition?.participants.includes(from)) {
        return;
      }
      if (this._availability && this.activePlayers.length !== this.players.length) {
        this._send(from, "reject", {
          reason: "suspended-members"
        });
        return;
      }
      if (this._admissionQueue.has(from)) {
        return;
      }
      const EXPECTED_COUNT = this._transition?.proposal.players.length ?? this.players.length;
      if (EXPECTED_COUNT + this._admissionQueue.size >= this.membership.maxPlayers) {
        this._send(from, "reject", {
          reason: "room-full"
        });
        return;
      }
      this._admissionQueue.set(from, this.clock());
      return;
    }
    if (m.op === "leave-request" && this.localPlayerId === this.coordinatorId && this.players.includes(from)) {
      if (!this._transition && !this._availability?.round) {
        this._proposal([], [from], "leave");
      } else {
        this._send(from, "leave-busy");
      }
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
    const TR = this._transition;
    if (!TR || m.epoch !== TR.proposal.epoch || !TR.participants.includes(from)) {
      return;
    }
    const LEADER = this.coordinatorId === this.localPlayerId;
    if (m.op === "prepared" && LEADER) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 2147483646 || (TR.proposal.oldPlayers.includes(from) && TR.proposal.resumingId !== from ? m.tick < this.baseTick : m.tick !== -1)) {
        throw new Error("membership prepared tick");
      }
      TR.prepared.set(from, m.tick);
      if (TR.prepared.size === TR.participants.length && TR.target === null) {
        const TARGET = Math.max(...TR.prepared.values()), MINIMUM = Math.min(...[...TR.prepared.values()].filter((tick) => tick >= 0));
        if (TARGET - MINIMUM > this.profile.stateHistorySize - this.profile.checksumInterval) {
          throw new Error("resume boundary exceeds retained history");
        }
        const DONOR = [...TR.prepared].filter(([, tick]) => tick === TARGET).map(([id]) => id).sort(COMPARE_IDS)[0];
        this._broadcast(TR.participants, "barrier", {
          epoch: m.epoch,
          tick: TARGET,
          minimum: MINIMUM,
          donor: DONOR
        });
      }
    } else if (m.op === "barrier" && from === this.coordinatorId && TR.target === null) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 2147483646 || m.tick < this.baseTick || this._core && Math.abs(m.tick - this.tick) > this.profile.stateHistorySize - 1) {
        throw new Error("membership barrier window");
      }
      TR.target = m.tick;
      if (TR.proposal.reason === "reconnect") {
        TR.donor = m.donor;
        if (!TR.proposal.oldPlayers.includes(TR.donor) || TR.donor === TR.proposal.resumingId) {
          throw new Error("invalid resume donor");
        }
        if (this.localPlayerId === TR.donor) {
          this._send(this.coordinatorId, "resume-source", {
            epoch: m.epoch,
            baseTick: this.baseTick,
            bootstrap: this._exportBootstrap({
              tick: TR.target - this.baseTick,
              checkpointAtOrBefore: m.minimum - this.baseTick
            })
          });
        }
      }
    } else if (m.op === "reached" && LEADER && TR.proposal.oldPlayers.includes(from)) {
      if (m.tick !== TR.target || !Number.isInteger(m.hash)) {
        throw new Error("membership checkpoint boundary");
      }
      TR.reached.set(from, m.hash);
      if (TR.reached.size === TR.proposal.oldPlayers.length && !TR.installSent) {
        if (new Set(TR.reached.values()).size !== 1) {
          throw new Error("membership checkpoint mismatch");
        }
        TR.installSent = true;
        const BOOTSTRAP = TR.proposal.joined.length ? this._exportBootstrap({
          tick: TR.target - this.baseTick
        }) : null;
        for (const ID of TR.participants) {
          if (TR.proposal.joined.includes(ID)) {
            this._send(ID, "bootstrap", {
              epoch: m.epoch,
              baseTick: this.baseTick,
              bootstrap: BOOTSTRAP,
              target: TR.target
            });
            this._stats.bootstrapBytes += BOOTSTRAP.checkpoint.bytes.length;
          } else {
            this._send(ID, "install", {
              epoch: m.epoch,
              tick: TR.target
            });
          }
        }
      }
    } else if (m.op === "resume-source" && LEADER && from === TR.donor && TR.proposal.reason === "reconnect" && !TR.installSent) {
      if (m.bootstrap.tick + m.baseTick !== TR.target) {
        throw new Error("resume donor boundary");
      }
      TR.installSent = true;
      this._broadcast(TR.participants, "resume-install", {
        epoch: m.epoch,
        baseTick: m.baseTick,
        bootstrap: m.bootstrap,
        target: TR.target
      });
    } else if (m.op === "resume-install" && from === this.coordinatorId && TR.proposal.reason === "reconnect" && !TR.replay && !TR.stageJob && !TR.preparedState && !TR.applied) {
      this._beginBootstrap(TR, m);
    } else if (m.op === "bootstrap" && from === this.coordinatorId && !this._core && !TR.replay && !TR.stageJob && !TR.preparedState && !TR.applied) {
      this._beginBootstrap(TR, m);
    } else if (m.op === "install" && from === this.coordinatorId && this._core && !TR.applied) {
      if (m.tick !== TR.target || this.tick < TR.target || this.confirmedTick + 1 < TR.target) {
        throw new Error("membership installation boundary");
      }
      this._applyMembership(TR);
    } else if (m.op === "installed" && LEADER) {
      if (!Number.isInteger(m.hash)) {
        throw new Error("membership installed hash");
      }
      TR.installed.set(from, m.hash);
      if (TR.installed.size === TR.participants.length && !TR.commitSent) {
        if (new Set(TR.installed.values()).size !== 1) {
          throw new Error("membership state mismatch");
        }
        TR.commitSent = true;
        this._broadcast(
          TR.participants.filter((id) => id !== this.localPlayerId),
          "commit",
          {
            epoch: m.epoch,
            hash: m.hash
          }
        );
      }
    } else if (m.op === "commit" && from === this.coordinatorId) {
      if (!TR.applied || TR.postHash !== m.hash) {
        throw new Error("membership commit without matching preparation");
      }
      this._send(this.coordinatorId, "committed", {
        epoch: m.epoch,
        hash: TR.postHash
      });
      this._commit(TR);
    } else if (m.op === "committed" && LEADER && TR.commitSent && m.hash === TR.postHash) {
      TR.committed.add(from);
    }
  }
  _beginBootstrap(tr, m) {
    return this._boundaryWork("bootstrapPrepareMs", () => this._prepareBootstrap(tr, m));
  }
  _prepareBootstrap(tr, m) {
    if (m.target !== tr.target || m.bootstrap.tick + m.baseTick !== tr.target || !Number.isSafeInteger(m.baseTick) || m.baseTick < 0 || this._core && m.baseTick !== this.baseTick) {
      throw new Error("bootstrap epoch boundary");
    }
    if (!this._core) {
      this.baseTick = m.baseTick;
    }
    if (this._core && tr.proposal.reason === "reconnect") {
      this._core.verifyConfirmedBootstrap(m.bootstrap);
    }
    tr.commandSequences = this._bootstrapCommandSequences(m.bootstrap, tr.proposal.oldPlayers);
    tr.boundaryLoaded = true;
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
      ...tr.proposal.activePlayers ? {
        activePlayers: [...tr.proposal.activePlayers]
      } : {}
    };
  }
  _boundaryWork(name, work) {
    const STARTED = NOW_MS();
    try {
      return work();
    } finally {
      const ELAPSED = Math.max(0, NOW_MS() - STARTED);
      this._stats[name] = ELAPSED;
      this._stats.maxBoundaryTaskMs = Math.max(this._stats.maxBoundaryTaskMs, ELAPSED);
      if (ELAPSED > 50) {
        this._stats.boundaryLongTasks++;
      }
    }
  }
  _applyMembership(tr) {
    return this._boundaryWork("membershipPrepareMs", () => this._prepareMembership(tr));
  }
  _prepareMembership(tr) {
    if (tr.stageJob || tr.preparedState || tr.applied) {
      return;
    }
    if (!tr.boundaryLoaded && this._core && this.tick > tr.target) {
      const BOUNDARY = this._exportBootstrap({
        tick: tr.target - this.baseTick
      });
      if (BOUNDARY.checkpoint.tick !== BOUNDARY.tick) {
        throw new Error("membership boundary snapshot missing");
      }
      this.adapter.load(BOUNDARY.checkpoint.bytes.slice());
      tr.boundaryLoaded = true;
      this._event("rollback", {
        from: tr.target,
        target: this.tick,
        reason: "membership"
      });
    }
    if (typeof this.adapter.prepareMembershipJob === "function" && typeof this.adapter.loadPreparedSnapshot === "function") {
      tr.stageJob = this.adapter.prepareMembershipJob(
        {
          ...tr.proposal,
          tick: tr.target
        },
        this._membershipContext(tr)
      );
      if (!tr.stageJob || typeof tr.stageJob.pulse !== "function" || typeof tr.stageJob.cancel !== "function") {
        throw new TypeError("membership preparation job");
      }
      return;
    }
    if (typeof this.adapter.prepareMembership === "function" && typeof this.adapter.loadPreparedSnapshot === "function") {
      const CONTEXT = this._membershipContext(tr);
      const STAGED = this.adapter.prepareMembership(
        {
          ...tr.proposal,
          tick: tr.target
        },
        CONTEXT
      );
      this._acceptPreparedMembership(tr, STAGED);
      return;
    }
    const ROLLBACK = bytes(this.adapter.save()).slice();
    try {
      this.adapter.applyMembership({
        ...tr.proposal,
        tick: tr.target
      });
      const STATE = bytes(this.adapter.save());
      if (STATE.length > this.profile.maxSnapshotBytes || !this.adapter.validateSnapshot(STATE, {
        tick: tr.target,
        membershipEpoch: tr.proposal.epoch
      })) {
        throw new Error("invalid membership snapshot");
      }
      tr.postHash = hashBytes(STATE);
      tr.postState = STATE.slice();
      this.adapter.load(ROLLBACK);
      tr.applied = true;
      this._installed(tr);
    } catch (error) {
      this.adapter.load(ROLLBACK);
      throw error;
    }
  }
  _acceptPreparedMembership(tr, staged, deferHash = false) {
    const STATE = bytes(staged?.bytes, "prepared membership snapshot").slice();
    if (!STATE.length || STATE.length > this.profile.maxSnapshotBytes || !staged.prepared) {
      throw new Error("invalid prepared membership snapshot");
    }
    tr.postState = STATE;
    tr.preparedState = staged.prepared;
    if (deferHash) {
      tr.postHash = 2166136261;
      tr.hashOffset = 0;
      return;
    }
    tr.postHash = hashBytes(STATE);
    tr.applied = true;
    this._installed(tr);
  }
  _pulseMembershipPreparation(tr) {
    if (!tr.stageJob && (!tr.preparedState || tr.applied)) {
      return;
    }
    this._boundaryWork("membershipPrepareMs", () => {
      const STARTED = NOW_MS(), BUDGET_MS = this.membership.snapshotBudgetMs;
      if (tr.stageJob) {
        tr.stageJob.pulse({
          budgetMs: BUDGET_MS
        });
        if (tr.stageJob.done) {
          const STAGED = tr.stageJob.result;
          tr.stageJob = null;
          this._acceptPreparedMembership(tr, STAGED, true);
        }
      }
      if (tr.preparedState && !tr.applied && NOW_MS() - STARTED < BUDGET_MS) {
        do {
          const END = Math.min(tr.postState.length, tr.hashOffset + 65536);
          tr.postHash = hashBytes(tr.postState.subarray(tr.hashOffset, END), tr.postHash);
          tr.hashOffset = END;
        } while (tr.hashOffset < tr.postState.length && NOW_MS() - STARTED < BUDGET_MS);
        if (tr.hashOffset === tr.postState.length) {
          tr.applied = true;
          this._installed(tr);
        }
      }
    });
  }
  _installed(tr) {
    if (tr.availability) {
      this._availability.installed(tr.postHash);
    } else {
      this._send(this.coordinatorId, "installed", {
        epoch: tr.proposal.epoch,
        hash: tr.postHash
      });
    }
  }
  _commit(tr) {
    return this._boundaryWork("membershipCommitMs", () => this._commitMembership(tr));
  }
  _commitMembership(tr) {
    const PREVIOUS_COORDINATOR = this.coordinatorId;
    const COMMAND_SEQUENCES = tr.commandSequences ?? {
      ...this._retainedCommandSequences,
      ...this._core?.getCommandSequences(tr.target - this.baseTick)
    };
    let commandState = !tr.discardCommands ? this._core?.exportLocalCommandState({
      fromTick: Math.min(tr.target - this.baseTick, this._core.confirmedBoundary)
    }) ?? this._suspendedCommands : void 0;
    if (commandState && this._core) {
      commandState = {
        ...commandState,
        tickOffset: this.baseTick
      };
    }
    commandState ??= COMMAND_SEQUENCES ? {
      sequence: COMMAND_SEQUENCES[this.localPlayerId] ?? 0,
      lastInput: new Uint8Array(this.inputSize),
      commands: []
    } : void 0;
    if (commandState && COMMAND_SEQUENCES) {
      const BASELINE = COMMAND_SEQUENCES[this.localPlayerId] ?? 0;
      commandState = {
        ...commandState,
        sequence: Math.max(commandState.sequence, BASELINE),
        commands: commandState.commands.filter((command) => command.sequence > BASELINE)
      };
    }
    if (tr.preparedState) {
      const PREPARED = tr.preparedState;
      tr.preparedState = null;
      this.adapter.loadPreparedSnapshot(PREPARED, this._membershipContext(tr));
    } else {
      this.adapter.load(tr.postState.slice());
    }
    if (this._core) {
      const METRICS = this._core.metrics;
      for (const K of Object.keys(this._totals)) {
        this._totals[K] += METRICS[K] ?? 0;
      }
      this._core.close();
      this._core = null;
    }
    this.epoch = tr.proposal.epoch;
    this.baseTick = tr.target;
    this.players = Object.freeze([...tr.proposal.players]);
    this.coordinatorId = tr.proposal.coordinatorId;
    this.activePlayers = Object.freeze([...tr.proposal.activePlayers ?? tr.proposal.players]);
    this._retainedCommandSequences = Object.fromEntries(
      this.players.map((id) => [id, COMMAND_SEQUENCES?.[id] ?? 0])
    );
    if (this._availability) {
      for (const ID of this._availability.peers.keys()) {
        if (!this.players.includes(ID)) {
          this._availability.peers.delete(ID);
          this._availability.states.delete(ID);
        }
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
    for (const ID of tr.proposal.left) {
      if (ID !== this.localPlayerId) {
        this._retirePeers.set(ID, this._retireAfter);
      }
    }
    for (const ID of this.players) {
      this._retirePeers.delete(ID);
    }
    this.room?.setRoster({
      epoch: this.epoch,
      players: [...this.players],
      coordinatorId: this.coordinatorId,
      ...this._availability ? {
        allowBranchReconnect: true
      } : {}
    });
    this._event("membership-committed", {
      ...tr.proposal,
      tick: tr.target
    });
    if (!this.players.includes(this.localPlayerId)) {
      this._departing = true;
      this._retireApproved = PREVIOUS_COORDINATOR === this.localPlayerId;
      return;
    }
    if (!this.activePlayers.includes(this.localPlayerId)) {
      this._suspendedCommands = commandState;
      this._suspendedBootstrap = {
        roomCommandSequences: {
          ...this._retainedCommandSequences
        },
        version: 1,
        tick: 0,
        checkpoint: {
          tick: 0,
          bytes: tr.postState.slice(),
          hash: tr.postHash
        },
        players: [...this.activePlayers],
        frames: [],
        hash: tr.postHash,
        inputSize: this.inputSize,
        tickRate: this.profile.tickRate,
        simulationVersion: this.simulationVersion,
        seed: this.seed,
        commandSequences: Object.fromEntries(
          this.activePlayers.map((id) => [id, COMMAND_SEQUENCES?.[id] ?? 0])
        )
      };
      return;
    }
    this._suspendedBootstrap = null;
    this._suspendedCommands = null;
    this._startCore(commandState, COMMAND_SEQUENCES, {
      bytes: tr.postState,
      hash: tr.postHash
    });
  }
  poll(now = this.clock()) {
    if (this.closed || this.failure) {
      return;
    }
    if (this._departing) {
      while (this._incoming.length) {
        const MESSAGE = this._incoming.shift();
        this._incomingBytes -= MESSAGE.size ?? 0;
        if (MESSAGE.value?.op === "retire") {
          this._handle(MESSAGE.from, MESSAGE.value);
        }
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
          this._send(this.coordinatorId, "join", {
            resume: !!this.room?.resumed
          });
          this._joinSent = true;
          this._lastJoinAt = now;
        }
      }
      let count = 0;
      while (this._incoming.length && count++ < this.membership.maxControlMessagesPerPulse && !this.failure && !this.closed) {
        const MESSAGE = this._incoming.shift();
        this._incomingBytes -= MESSAGE.size ?? 0;
        this._handle(MESSAGE.from, MESSAGE.value);
      }
      if (this._departing) {
        this._flush();
        return;
      }
      if (this._core && !this._transition && !this._availability?.round && this.coordinatorId === this.localPlayerId && this.activePlayers.length === this.players.length) {
        for (const [ID, REQUESTED_AT] of this._admissionQueue) {
          const LINK = this._links.get(ID);
          if (!LINK || now - REQUESTED_AT >= this.membership.transitionTimeoutMs) {
            if (LINK) {
              this._send(ID, "reject", {
                reason: "admission-expired"
              });
            }
            this._admissionQueue.delete(ID);
            continue;
          }
          this._admissionQueue.delete(ID);
          this._proposal([ID], [], "join");
          break;
        }
      }
      const TR = this._transition;
      if (TR && !TR.availability) {
        if (now - TR.startedAt >= this.membership.transitionTimeoutMs) {
          throw new Error("membership deadline exceeded");
        }
        this._pulseMembershipPreparation(TR);
        if (TR.replay) {
          const RESULT = this._boundaryWork("bootstrapPulseMs", () => TR.replay.pulse());
          this._stats.bootstrapTicks += RESULT.steps ?? 0;
          if (TR.replay.done) {
            TR.replay = null;
            this._applyMembership(TR);
          }
        }
        if (this._core && TR.proposal.reason !== "reconnect" && TR.target !== null && this.tick >= TR.target && this.confirmedTick + 1 >= TR.target && !this._core.resimulating && !TR.reachedSent) {
          TR.reachedSent = true;
          this._send(this.coordinatorId, "reached", {
            epoch: TR.proposal.epoch,
            tick: TR.target,
            hash: this._core.getStateHash(TR.target - this.baseTick)
          });
        }
      } else if (!this._core && !this._suspendedBootstrap && now - this._startedAt >= this.membership.transitionTimeoutMs) {
        throw new Error("join deadline exceeded");
      }
      if (TR?.availability) {
        this._pulseMembershipPreparation(TR);
      }
      for (const [ID, LINK] of this._links) {
        if (LINK.incoming && now - LINK.incoming.startedAt >= this.membership.transitionTimeoutMs) {
          throw new Error("room transfer timeout: " + ID);
        }
      }
      for (const LINK of this._links.values()) {
        if (LINK.branchIncoming && now - LINK.branchIncoming.at >= this.membership.transitionTimeoutMs) {
          LINK.branchIncoming = null;
        }
      }
      if (!this._boundaryFrozen()) {
        this._core?.poll(now);
      }
      if (this._core && !TR && !this._availability) {
        if (["interrupted", "disconnected"].includes(this._core.status)) {
          this._interruptedAt ??= now;
          if (now - this._interruptedAt >= this.membership.reconnectGraceMs) {
            this._fail("partition-failed", {
              policy: "fail-closed",
              coordinatorId: this.coordinatorId
            });
          }
        } else {
          this._interruptedAt = null;
        }
      }
      this._flush();
      for (const [ID, DEADLINE] of this._retirePeers) {
        const LINK = this._links.get(ID);
        if (LINK && !["closed", "failed"].includes(LINK.transport.state) && now < DEADLINE) {
          continue;
        }
        LINK?.unsubscribe?.();
        LINK?.detachCore?.();
        this._links.delete(ID);
        this.room?.disconnect?.(ID);
        this._retirePeers.delete(ID);
      }
      if (TR && !TR.availability && TR.commitSent && TR.applied && TR.committed.size === TR.participants.length - 1 && [...this._links.values()].every((link) => !link.queue.length)) {
        for (const ID of TR.proposal.left) {
          if (ID !== this.localPlayerId) {
            this._send(ID, "retire", {
              epoch: TR.proposal.epoch
            });
          }
        }
        this._commit(TR);
      }
    } catch (error) {
      this._fail("membership-failed", {
        reason: error.message
      });
    }
  }
  advance(input = this._lastInput) {
    if (this.closed) {
      throw new Error("room session closed");
    }
    const SAMPLE = bytes(input);
    if (SAMPLE.length !== this.inputSize) {
      throw new RangeError("inputSize");
    }
    this._lastInput = SAMPLE.slice();
    if (this._availability) {
      this._availability.lastAdvance = this.clock();
      if (!this.activePlayers.includes(this.localPlayerId)) {
        this._availability.recovering = true;
        this._availability.requested = "resume";
      }
    }
    this.poll();
    if (this.failure) {
      return {
        status: "failed",
        tick: this.tick,
        failure: this.failure
      };
    }
    const TR = this._transition;
    if (!this._core || this._availability?.round || this._availability?.recovering || this._availability?.requested === "state-mismatch" || TR && (TR.proposal.reason === "reconnect" || TR.target === null || this.tick >= TR.target)) {
      return {
        status: this.status,
        tick: this.tick
      };
    }
    const RESULT = this._core.advance(SAMPLE);
    return {
      ...RESULT,
      tick: this.tick
    };
  }
  submitInput(input, options) {
    if (this.closed || this.failure) {
      throw new Error("room session unavailable");
    }
    const SAMPLE = bytes(input);
    if (SAMPLE.length !== this.inputSize) {
      throw new RangeError("inputSize");
    }
    this._lastInput = SAMPLE.slice();
    if (!this._core) {
      if (options?.commands?.length) {
        throw new Error("player not admitted");
      }
      return {
        status: "waiting",
        tick: this.tick,
        commandSequences: [],
        commands: []
      };
    }
    const RESULT = this._core.submitInput(SAMPLE, options);
    return {
      ...RESULT,
      tick: this.tick,
      executeTick: RESULT.executeTick + this.baseTick,
      commands: RESULT.commands.map((c) => ({
        ...c,
        executeTick: c.executeTick + this.baseTick
      }))
    };
  }
  queueCommand(payload) {
    if (this.closed || this.failure) {
      throw new Error("room session unavailable");
    }
    if (!this._core) {
      throw new Error("player not admitted");
    }
    return this._core.queueCommand(payload);
  }
  releaseInput() {
    this._lastInput = new Uint8Array(this.inputSize);
    this._core?.releaseInput();
  }
  leave() {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.failure) {
      return Promise.reject(new Error("room session failed"));
    }
    if (this._leavePromise) {
      return this._leavePromise;
    }
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
    if (this.closed) {
      return;
    }
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
    for (const LINK of this._links.values()) {
      LINK.unsubscribe?.();
      LINK.detachCore?.();
    }
    this._links.clear();
    this._incoming.length = 0;
    this._suspendedCommands = null;
    this._suspendedBootstrap = null;
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
  PROFILES as profiles
};
