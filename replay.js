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
      const COMMAND = { ...commands[c], payload: bytes(commands[c].payload) };
      delete COMMAND.tick;
      delete COMMAND.playerId;
      INPUTS[players.indexOf(commands[c].playerId)].commands.push(COMMAND);
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
    hash: hashBytes(bytes(adapter.save()))
  };
}
export {
  playReplay
};
