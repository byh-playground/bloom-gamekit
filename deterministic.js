// modules/deterministic/utilities.js
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
  for (const B of bytes(value)) {
    h = Math.imul(h ^ B, 16777619) >>> 0;
  }
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
    const LIMIT = Math.floor(4294967296 / bound) * bound;
    let x;
    do {
      x = this.nextUint32();
    } while (x >= LIMIT);
    return x % bound;
  }
};
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

// modules/deterministic/value-codec.js
function createValueCodec({
  format = "binary",
  maxBytes = 16 * 1024 * 1024,
  maxDepth = 128,
  maxEntries = 1e6
} = {}) {
  if (!["binary", "json"].includes(format)) {
    throw new TypeError("Unknown codec format");
  }
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
    if (value instanceof Uint8Array) {
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
      for (const KEY of Object.keys(value).sort()) {
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
    let bytes2 = new Uint8Array(Math.min(1024, maxBytes));
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
          const KEYS = Object.keys(v).sort();
          length(KEYS.length);
          for (const KEY of KEYS) {
            write(KEY, depth + 1);
            write(v[KEY], depth + 1);
          }
        }
        SEEN.delete(v);
      }
    }
    byte(82);
    byte(86);
    byte(1);
    write(value);
    return bytes2.slice(0, offset);
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

// modules/_rollback-shared/protocol.js
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

// modules/deterministic/synctest.js
var DeterminismError = class extends Error {
  constructor({ tick, checkpointTick, expected, actual, inputs }) {
    let offset = 0;
    while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) {
      offset++;
    }
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
    this.inputs = inputs.map((frame) => ({
      ...copyFrame(frame),
      playerId: frame.playerId,
      predicted: false
    }));
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
    if (!adapter || ["save", "load", "step", "validateSnapshot"].some((key) => typeof adapter[key] !== "function")) {
      throw new TypeError("Simulation Adapter capabilities");
    }
    if (!Array.isArray(players) || !players.length || players.length > 8 || players.some((id) => typeof id !== "string" || !id.length) || new Set(players).size !== players.length) {
      throw new TypeError("fixed player roster");
    }
    if (typeof now !== "function") {
      throw new TypeError("diagnostic clock");
    }
    this._now = now;
    this._cost = {
      forwardCostMs: 0,
      resimulationCostMs: 0,
      totalCostMs: 0
    };
    this.adapter = adapter;
    this.players = Object.freeze([...players].sort(COMPARE_IDS));
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
    const INITIAL = this._save();
    if (INITIAL.length * (checkDistance + 1) > maxHistoryBytes) {
      throw new RangeError("synctest history byte budget");
    }
    if (adapter.validateSnapshot(INITIAL.slice(), {
      tick: this.tick
    }) !== true) {
      throw new TypeError("initial snapshot validation");
    }
    this._history.put({
      tick: this.tick,
      bytes: INITIAL
    });
  }
  get tick() {
    return this._tick;
  }
  get status() {
    return this.closed ? "closed" : this.failure ? "failed" : "running";
  }
  get metrics() {
    const ERROR = this.failure;
    const FAILURE = ERROR ? Object.freeze({
      name: ERROR.name ?? "Error",
      message: String(ERROR.message ?? ERROR),
      code: ERROR.code ?? null,
      tick: ERROR.tick ?? null,
      checkpointTick: ERROR.checkpointTick ?? null,
      firstDifference: ERROR.firstDifference ?? null,
      expectedHash: ERROR.expectedHash ?? null,
      actualHash: ERROR.actualHash ?? null
    }) : null;
    return Object.freeze({
      status: this.status,
      tick: this.tick,
      checkDistance: this.checkDistance,
      checkedTicks: this.checkedTicks,
      resimulatedTicks: this.resimulatedTicks,
      stateHash: this.closed ? null : this.getStateHash() ?? null,
      historyBytes: this._history.byteLength,
      failure: FAILURE,
      ...this._cost
    });
  }
  _save() {
    const VALUE = bytes(this.adapter.save()).slice();
    if (!VALUE.length || VALUE.length > this.maxSnapshotBytes) {
      throw new RangeError("snapshot size");
    }
    return VALUE;
  }
  _inputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length !== this.players.length) {
      throw new TypeError("all local player inputs required");
    }
    const ORDERED = [...inputs].sort((a, b) => COMPARE_IDS(a.playerId, b.playerId));
    return ORDERED.map((frame, index) => {
      if (frame.playerId !== this.players[index] || bytes(frame.input).length !== this.inputSize) {
        throw new TypeError("player/inputSize");
      }
      const COMMANDS = frame.commands ?? [];
      if (!Array.isArray(COMMANDS) || COMMANDS.length > 256) {
        throw new TypeError("commands");
      }
      const SORTED = [...COMMANDS].sort((a, b) => a.sequence - b.sequence);
      let previous = 0;
      for (const COMMAND of SORTED) {
        integer(COMMAND.sequence, "command sequence", 1);
        if (COMMAND.sequence <= previous || COMMAND.executeTick !== this.tick) {
          throw new TypeError("command ordering/executeTick");
        }
        const PAYLOAD = bytes(COMMAND.payload);
        if (!PAYLOAD.length || PAYLOAD.length > 15360) {
          throw new RangeError("command payload");
        }
        previous = COMMAND.sequence;
      }
      return {
        ...copyFrame({
          input: bytes(frame.input),
          commands: SORTED
        }),
        playerId: frame.playerId,
        predicted: false
      };
    });
  }
  advance(inputs) {
    if (this.closed) {
      throw new Error("sync test closed");
    }
    if (this.failure) {
      throw this.failure;
    }
    integer(this.tick + 1, "tick limit", 0, MAX_TICK);
    const FRAMES = this._inputs(inputs), BEFORE = this._history.get(this.tick), FRAME_TICK = this.tick;
    let forward = BEFORE.bytes;
    const STARTED = this._now();
    let replayStarted;
    try {
      runSimulationFrame(this.adapter, {
        tick: FRAME_TICK,
        tickRate: this.tickRate,
        inputs: FRAMES,
        resimulating: false,
        synctesting: true
      });
      const NEXT = this._save();
      this._history.put({
        tick: FRAME_TICK + 1,
        bytes: NEXT
      });
      forward = NEXT;
      this._frames.set(FRAME_TICK, FRAMES);
      this._tick++;
      replayStarted = this._now();
      this._cost.forwardCostMs += Math.max(0, replayStarted - STARTED);
      const FROM = Math.max(this.initialTick, this.tick - this.checkDistance);
      this.adapter.load(this._history.get(FROM).bytes.slice());
      for (let tick = FROM; tick < this.tick; tick++) {
        const INPUT = this._frames.get(tick);
        runSimulationFrame(this.adapter, {
          tick,
          tickRate: this.tickRate,
          inputs: INPUT,
          resimulating: true,
          synctesting: true
        });
        const ACTUAL = this._save(), EXPECTED = this._history.get(tick + 1).bytes;
        this.resimulatedTicks++;
        if (!equalBytes(ACTUAL, EXPECTED)) {
          throw new DeterminismError({
            tick: tick + 1,
            checkpointTick: FROM,
            expected: EXPECTED,
            actual: ACTUAL,
            inputs: INPUT
          });
        }
      }
      this.checkedTicks++;
      for (const TICK of this._frames.keys()) {
        if (TICK < FROM) {
          this._frames.delete(TICK);
        }
      }
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      try {
        this.adapter.load(forward.slice());
      } catch (error) {
        if (this.failure) {
          this.failure.restoreError = error;
        } else {
          this.failure = error;
          throw error;
        }
      } finally {
        const FINISHED = this._now();
        if (replayStarted !== void 0) {
          this._cost.resimulationCostMs += Math.max(0, FINISHED - replayStarted);
        } else {
          this._cost.forwardCostMs += Math.max(0, FINISHED - STARTED);
        }
        this._cost.totalCostMs += Math.max(0, FINISHED - STARTED);
      }
    }
    return {
      tick: this.tick,
      checkedTicks: this.checkedTicks,
      resimulatedTicks: this.resimulatedTicks
    };
  }
  getStateHash() {
    const STATE = this._history.get(this.tick);
    if (!STATE) {
      return void 0;
    }
    if (STATE.hash === void 0) {
      STATE.hash = hashBytes(STATE.bytes);
    }
    return STATE.hash;
  }
  close() {
    this.closed = true;
    this._frames.clear();
    this._history.slots.fill(void 0);
    this._history.byteLength = 0;
  }
};
function beginSyncTestBatch(frames, options) {
  if (!Array.isArray(frames)) {
    throw new TypeError("frames");
  }
  return {
    initial: bytes(options.adapter.save()).slice(),
    session: createSyncTestSession(options)
  };
}
function advanceSyncTestBatch(session, frame) {
  if (frame.tick !== session.tick) {
    throw new TypeError("non-contiguous test frames");
  }
  session.advance(frame.inputs);
}
function syncTestBatchResult(session) {
  return {
    tick: session.tick,
    checkedTicks: session.checkedTicks,
    resimulatedTicks: session.resimulatedTicks,
    hash: session.getStateHash(),
    metrics: session.metrics
  };
}
function syncTestBatchFailure(session, error) {
  const FAILURE = error instanceof Error ? error : new Error(String(error));
  session.failure ??= FAILURE;
  FAILURE.syncTestMetrics = session.metrics;
  return FAILURE;
}
function checkSyncTestAbort(signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) {
      throw signal.reason;
    }
    const ERROR = new Error(signal.reason === void 0 ? "Synctest aborted" : String(signal.reason));
    ERROR.name = "AbortError";
    throw ERROR;
  }
}
function runSyncTest({ frames, ...options } = {}) {
  const { initial: INITIAL, session: SESSION } = beginSyncTestBatch(frames, options);
  try {
    for (const FRAME of frames) {
      advanceSyncTestBatch(SESSION, FRAME);
    }
    return syncTestBatchResult(SESSION);
  } catch (error) {
    throw syncTestBatchFailure(SESSION, error);
  } finally {
    SESSION.close();
    options.adapter.load(INITIAL);
  }
}
async function runSyncTestAsync({
  frames,
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  signal,
  ...options
} = {}) {
  if (typeof yieldControl !== "function") {
    throw new TypeError("yieldControl");
  }
  const { initial: INITIAL, session: SESSION } = beginSyncTestBatch(frames, options);
  try {
    checkSyncTestAbort(signal);
    for (const FRAME of frames) {
      await yieldControl();
      checkSyncTestAbort(signal);
      advanceSyncTestBatch(SESSION, FRAME);
      await yieldControl();
      checkSyncTestAbort(signal);
    }
    return syncTestBatchResult(SESSION);
  } catch (error) {
    throw syncTestBatchFailure(SESSION, error);
  } finally {
    SESSION.close();
    options.adapter.load(INITIAL);
  }
}
export {
  DeterminismError,
  SeededPRNG,
  SyncTestSession,
  BINARY_CODEC as binaryCodec,
  createSyncTestSession,
  createValueCodec,
  FIXED_POINT as fixedPoint,
  hashBytes,
  JSON_CODEC as jsonCodec,
  runSyncTest,
  runSyncTestAsync,
  statelessRandom
};
