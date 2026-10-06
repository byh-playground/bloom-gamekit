// packages/deterministic/src/utilities.js
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

// packages/_rollback-shared/src/protocol.js
var VERSION = "0.2.0-dev";
var CHUNK_SIZE = 16384;
var defaults = {
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
  playReplay
};
