// modules/deterministic/utilities.js
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
var ByteBuffer = class {
  constructor(capacity = 1024) {
    this.bytes = new Uint8Array(integer(capacity, "capacity", 1, 2147483647));
    this.length = 0;
  }
  reset() {
    this.length = 0;
    return this;
  }
  /** 뒤에 `size` bytes를 쓸 자리를 확보하고 쓰기 시작 위치를 돌려줍니다. 길이는 쓰는 쪽이 늘립니다. */
  reserve(size) {
    const END = this.length + size;
    if (END > this.bytes.length) {
      const NEXT = new Uint8Array(Math.max(END, this.bytes.length * 2));
      NEXT.set(this.bytes.subarray(0, this.length));
      this.bytes = NEXT;
    }
    return this.length;
  }
  write(data) {
    const DATA = bytes(data);
    const AT = this.reserve(DATA.length);
    this.bytes.set(DATA, AT);
    this.length += DATA.length;
    return this;
  }
  /** 쓴 범위의 보기. 다음 reset·write 전까지만 유효합니다. */
  view() {
    return this.bytes.subarray(0, this.length);
  }
  /** 쓴 범위의 독립 복사본. */
  copy() {
    return this.bytes.slice(0, this.length);
  }
  /**
   * 쓴 범위를 소유권째 넘기고 버퍼는 같은 크기의 새 공간으로 바꿉니다(복사 없음).
   * 남는 공간이 쓴 길이의 1/8보다 크면 보관 메모리를 아끼려고 copy()와 같이 복사합니다.
   */
  take() {
    const LENGTH = this.length;
    this.length = 0;
    if (this.bytes.length - LENGTH > LENGTH >> 3) {
      return this.bytes.slice(0, LENGTH);
    }
    const TAKEN = this.bytes.subarray(0, LENGTH);
    this.bytes = new Uint8Array(this.bytes.length);
    return TAKEN;
  }
};
function saveSnapshot(adapter, buffer) {
  adapter.saveInto(buffer.reset());
  return buffer.view();
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
    return SIGNED(Math.trunc(SIGNED(a) * 1024 / b) || 0);
  }
});

// modules/_rollback-shared/protocol.js
var REPLAY_FORMAT_VERSION = "0.3.0-dev";
var CHUNK_SIZE = 16384;
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
var PACKET_WRITER = new Writer();
function runSimulationFrame(adapter, context) {
  const SOURCE = context.inputs, INPUTS = new Array(SOURCE.length);
  for (let i = 0; i < SOURCE.length; i++) {
    const FRAME = SOURCE[i];
    INPUTS[i] = {
      input: FRAME.input.slice(),
      commands: copyCommands(FRAME.commands),
      playerId: FRAME.playerId,
      predicted: !!FRAME.predicted
    };
  }
  context.inputs = INPUTS;
  return adapter.step(context);
}
function copyCommands(commands) {
  const OUT = new Array(commands.length);
  for (let i = 0; i < commands.length; i++) {
    OUT[i] = {
      ...commands[i],
      payload: commands[i].payload.slice()
    };
  }
  return OUT;
}
function decodeReplayFrames({ inputChanges, commands, players, inputSize, tick }) {
  const DATA = bytes(inputChanges), CURRENT = players.map(() => null), FRAMES = [];
  let at = 0, next = 0;
  const READ = () => {
    if (at >= DATA.length) {
      return null;
    }
    let delta = 0;
    for (let shift = 0; ; shift += 7) {
      const B = DATA[at++];
      delta += (B & 127) * 2 ** shift;
      if (B < 128) {
        break;
      }
    }
    const P = DATA[at++];
    if (P >= players.length || at + inputSize > DATA.length) {
      throw new Error("replay input changes");
    }
    next += delta;
    at += inputSize;
    return { tick: next, player: P, input: DATA.slice(at - inputSize, at) };
  };
  let pending = READ();
  let c = 0;
  for (let t = 0; t < tick; t++) {
    while (pending && pending.tick === t) {
      CURRENT[pending.player] = pending.input;
      pending = READ();
    }
    if (CURRENT.some((x) => !x)) {
      throw new Error("replay input changes");
    }
    const INPUTS = players.map((playerId, i) => ({ playerId, input: CURRENT[i], commands: [], predicted: false }));
    for (; c < commands.length && commands[c].tick === t; c++) {
      const { tick: OMITTED_TICK, playerId: PLAYER_ID, ...COMMAND } = commands[c];
      COMMAND.payload = bytes(COMMAND.payload);
      INPUTS[players.indexOf(PLAYER_ID)].commands.push(COMMAND);
    }
    FRAMES.push({ tick: t, inputs: INPUTS });
  }
  if (pending || c !== commands.length) {
    throw new Error("replay input changes");
  }
  return FRAMES;
}

// modules/replay/index.js
function playReplay({ adapter, replay, simulationVersion = replay?.simulationVersion } = {}) {
  if (replay?.version !== REPLAY_FORMAT_VERSION || replay.simulationVersion !== simulationVersion || !Array.isArray(replay.players) || !Array.isArray(replay.commands)) {
    throw new Error("replay compatibility");
  }
  const FRAMES = decodeReplayFrames(replay);
  const BASE_TICK = replay.baseTick ?? 0;
  adapter.load(bytes(replay.initialState).slice());
  for (const F of FRAMES) {
    runSimulationFrame(adapter, {
      tick: BASE_TICK + F.tick,
      tickRate: replay.tickRate,
      inputs: F.inputs.map((x) => ({
        ...x,
        commands: x.commands.map((c) => ({ ...c, executeTick: c.executeTick + BASE_TICK }))
      })),
      resimulating: true,
      replaying: true,
      ...replay.membershipEpoch === void 0 ? {} : { membershipEpoch: replay.membershipEpoch }
    });
  }
  return {
    tick: FRAMES.length,
    hash: hashBytes(saveSnapshot(adapter, new ByteBuffer()))
  };
}
export {
  playReplay
};
