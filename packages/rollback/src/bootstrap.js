import { CHUNK_SIZE, MAX_TICK, defaults, runSimulationFrame } from '../../_rollback-shared/src/protocol.js';
import { bytes, compareIds, equalBytes, hashBytes, integer } from '../../deterministic/src/utilities.js';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SUFFIX_TICKS = 8192;

function roster(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 ||
    Array.from(value).some(id => typeof id !== 'string' || !id.length || id.length > 128) || new Set(value).size !== value.length) throw new TypeError(name);
  return value.slice();
}

function validateBootstrap(bootstrap, limits, expected) {
  if (!bootstrap || bootstrap.version !== 1) throw new Error('bootstrap version');
  const tick = integer(bootstrap.tick, 'bootstrap tick', 0, MAX_TICK + 1);
  const inputSize = integer(bootstrap.inputSize, 'bootstrap inputSize', 1, 1024);
  const tickRate = integer(bootstrap.tickRate, 'bootstrap tickRate', 1, 240);
  const seed = integer(bootstrap.seed, 'bootstrap seed');
  const simulationVersion = bootstrap.simulationVersion;
  if (typeof simulationVersion !== 'string' || !simulationVersion.length || simulationVersion.length > 128) throw new TypeError('bootstrap simulationVersion');
  const players = roster(bootstrap.players, 'bootstrap players');
  if (players.some((id, index) => index > 0 && compareIds(players[index - 1], id) >= 0)) throw new Error('bootstrap player order');
  const providedSequences = bootstrap.commandSequences;
  if (!providedSequences || typeof providedSequences !== 'object' || Array.isArray(providedSequences) ||
    Object.keys(providedSequences).length !== players.length || players.some(id => !Object.hasOwn(providedSequences, id))) throw new TypeError('bootstrap command sequences roster');
  const commandSequences = Object.fromEntries(players.map(id => [id, integer(providedSequences[id], 'bootstrap command sequence boundary')]));
  for (const field of ['simulationVersion', 'inputSize', 'tickRate', 'seed']) {
    if (expected[field] !== undefined && expected[field] !== bootstrap[field]) throw new Error(`bootstrap ${field} mismatch`);
  }
  if (expected.players !== undefined) {
    const wanted = roster(expected.players, 'expected players').sort(compareIds);
    if (wanted.length !== players.length || wanted.some((id, index) => id !== players[index])) throw new Error('bootstrap players mismatch');
  }
  const checkpoint = bootstrap.checkpoint;
  const start = integer(checkpoint?.tick, 'bootstrap checkpoint tick', 0, tick);
  const data = bytes(checkpoint?.bytes, 'bootstrap checkpoint');
  if (!data.length || data.length > limits.maxSnapshotBytes) throw new RangeError('bootstrap snapshot size');
  const checkpointBytes = data.slice();
  const checkpointHash = integer(checkpoint.hash, 'bootstrap checkpoint hash');
  if (hashBytes(checkpointBytes) !== checkpointHash) throw new Error('bootstrap checkpoint hash mismatch');
  const hash = integer(bootstrap.hash, 'bootstrap final hash');
  if (!Array.isArray(bootstrap.frames) || bootstrap.frames.length !== tick - start || tick - start > limits.maxSuffixTicks) throw new RangeError('bootstrap suffix length');
  if (start === tick && checkpointHash !== hash) throw new Error('bootstrap final hash mismatch');
  let totalBytes = data.length;
  if (totalBytes > limits.maxReplayBytes) throw new RangeError('bootstrap replay byte budget');
  const sequences = new Map(players.map(id => [id, 0]));
  const frames = Array.from(bootstrap.frames, (frame, index) => {
    const frameTick = start + index;
    if (frame?.tick !== frameTick) throw new Error('non-contiguous bootstrap suffix');
    if (!Array.isArray(frame.inputs) || frame.inputs.length !== players.length) throw new Error('bootstrap input roster');
    totalBytes += 16;
    const inputs = Array.from(frame.inputs, (inputFrame, player) => {
      if (inputFrame?.playerId !== players[player] || inputFrame.predicted !== false) throw new Error('bootstrap confirmed input order');
      const input = bytes(inputFrame.input, 'bootstrap input');
      if (input.length !== inputSize) throw new RangeError('bootstrap inputSize');
      if (!Array.isArray(inputFrame.commands) || inputFrame.commands.length > limits.maxPendingCommands) throw new RangeError('bootstrap command count');
      let commandBytes = 0;
      totalBytes += inputSize;
      const commands = Array.from(inputFrame.commands, command => {
        const sequence = integer(command?.sequence, 'bootstrap command sequence', 1);
        if (sequence <= sequences.get(players[player]) || command.executeTick !== frameTick) throw new Error('bootstrap command order/tick');
        sequences.set(players[player], sequence);
        const payload = bytes(command.payload, 'bootstrap command payload');
        commandBytes += payload.length + 6;
        totalBytes += payload.length + 12;
        if (!payload.length || payload.length > limits.maxCommandBytes || commandBytes > CHUNK_SIZE - 1024 - inputSize) throw new RangeError('bootstrap command size');
        if (totalBytes > limits.maxReplayBytes) throw new RangeError('bootstrap replay byte budget');
        return { sequence, executeTick: frameTick, payload: payload.slice() };
      });
      if (totalBytes > limits.maxReplayBytes) throw new RangeError('bootstrap replay byte budget');
      return { playerId: players[player], input: input.slice(), commands, predicted: false };
    });
    return { tick: frameTick, inputs };
  });
  for (const [id, sequence] of sequences) if (sequence && sequence !== commandSequences[id]) throw new Error('bootstrap command sequence boundary mismatch');
  return { version: 1, tick, checkpoint: { tick: start, bytes: checkpointBytes, hash: checkpointHash },
    players, frames, hash, inputSize, tickRate, simulationVersion, seed, commandSequences };
}

/**
 * Replay a confirmed sparse checkpoint and suffix in bounded pulses. The caller
 * owns scheduling and must not step the same adapter while this job is active.
 * Adapter context uses bootstrap-local ticks; wrap the adapter for epoch offsets.
 * Candidate data is copied before loading. Any load, replay, or final validation
 * failure restores the original snapshot and throws; cancel() also restores it.
 */
export function createBootstrapReplay({ adapter, bootstrap, maxCatchupSteps = 8,
  maxSnapshotBytes = defaults.maxSnapshotBytes, maxSuffixTicks = MAX_SUFFIX_TICKS,
  maxCommandBytes = defaults.maxCommandBytes, maxPendingCommands = defaults.maxPendingCommands,
  maxReplayBytes = defaults.maxReplayBytes, simulationVersion, inputSize, tickRate, players, seed } = {}) {
  if (!adapter || ['save', 'load', 'step', 'validateSnapshot'].some(name => typeof adapter[name] !== 'function')) throw new TypeError('Simulation Adapter must save, load, step, validateSnapshot');
  integer(maxCatchupSteps, 'maxCatchupSteps', 1, MAX_SUFFIX_TICKS);
  integer(maxSnapshotBytes, 'maxSnapshotBytes', 1, MAX_SNAPSHOT_BYTES);
  integer(maxSuffixTicks, 'maxSuffixTicks', 0, MAX_SUFFIX_TICKS);
  integer(maxCommandBytes, 'maxCommandBytes', 1, CHUNK_SIZE - 1024);
  integer(maxPendingCommands, 'maxPendingCommands', 1, 0x7fffffff);
  integer(maxReplayBytes, 'maxReplayBytes', 1, 0x7fffffff);
  const candidate = validateBootstrap(bootstrap, { maxSnapshotBytes, maxSuffixTicks, maxCommandBytes, maxPendingCommands, maxReplayBytes },
    { simulationVersion, inputSize, tickRate, players, seed });
  const save = () => {
    const data = bytes(adapter.save(), 'bootstrap adapter snapshot');
    if (!data.length || data.length > maxSnapshotBytes) throw new RangeError('bootstrap adapter snapshot size');
    return data.slice();
  };
  const context = tick => ({ tick, tickRate: candidate.tickRate, players: candidate.players.slice(),
    simulationVersion: candidate.simulationVersion, seed: candidate.seed });
  const original = save();
  let tick = candidate.checkpoint.tick, status = 'catching-up', result = null, failure = null;
  const restore = error => {
    failure = error instanceof Error ? error : new Error(String(error));
    status = 'failed';
    try { adapter.load(original.slice()); }
    catch (restoreError) { failure = new AggregateError([failure, restoreError], 'bootstrap replay failed and original snapshot restoration failed'); }
    throw failure;
  };
  // Shape, ordering, capacity and checkpoint hash checks above cannot load a
  // malformed candidate into the game. Validation also precedes the first load.
  if (adapter.validateSnapshot(candidate.checkpoint.bytes.slice(), context(tick)) !== true) throw new Error('adapter rejected bootstrap checkpoint');
  try {
    adapter.load(candidate.checkpoint.bytes.slice());
    if (!equalBytes(save(), candidate.checkpoint.bytes)) throw new Error('bootstrap checkpoint round-trip mismatch');
  } catch (error) { restore(error); }
  return Object.freeze({
    get tick() { return tick; },
    get targetTick() { return candidate.tick; },
    get status() { return status; },
    get done() { return status === 'done'; },
    get result() { return result; },
    get failure() { return failure; },
    pulse() {
      if (failure) throw failure;
      if (status !== 'catching-up') return Object.freeze({ status, tick, targetTick: candidate.tick, steps: 0, ...(result ?? {}) });
      let steps = 0;
      try {
        while (tick < candidate.tick && steps < maxCatchupSteps) {
          const frame = candidate.frames[tick - candidate.checkpoint.tick];
          runSimulationFrame(adapter, { tick, tickRate: candidate.tickRate, inputs: frame.inputs,
            resimulating: true, recovering: true, replaying: true });
          tick++; steps++;
        }
        if (tick === candidate.tick) {
          const final = save();
          if (hashBytes(final) !== candidate.hash) throw new Error('bootstrap final hash mismatch');
          if (adapter.validateSnapshot(final.slice(), context(tick)) !== true) throw new Error('adapter rejected bootstrap final state');
          status = 'done'; result = Object.freeze({ tick, hash: candidate.hash });
        }
        return Object.freeze({ status, tick, targetTick: candidate.tick, steps, ...(result ?? {}) });
      } catch (error) { return restore(error); }
    },
    cancel() {
      if (failure) throw failure;
      if (status === 'catching-up') {
        try { adapter.load(original.slice()); status = 'cancelled'; }
        catch (error) { return restore(error); }
      }
      return Object.freeze({ status, tick, targetTick: candidate.tick, steps: 0, ...(result ?? {}) });
    },
  });
}
