import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../../packages/rollback/src/core.js';
import { createBootstrapReplay } from '../../packages/rollback/src/bootstrap.js';
import { hashBytes } from '../../packages/deterministic/src/utilities.js';

const profile = { mode: 'lockstep', tickRate: 20, baseInputDelayTicks: 0, minInputDelayTicks: 0,
  maxInputDelayTicks: 8, adaptiveInputDelay: false, pacingPolicy: 'none', stateHistorySize: 16, checksumInterval: 8 };

function world({ initial, tickOffset = 0, mutateInputs = false, failAt, rejectAt, corruptLoad = false } = {}) {
  const state = new Uint32Array(4), seen = [];
  if (initial) new Uint8Array(state.buffer).set(initial);
  const stats = { saves: 0, loads: 0, steps: 0 };
  const adapter = {
    save() { stats.saves++; return new Uint8Array(state.buffer); },
    load(data) { stats.loads++; new Uint8Array(state.buffer).set(data); if (corruptLoad && stats.loads === 1) state[2]++; },
    validateSnapshot(data, { tick }) {
      return tick !== rejectAt && data.length === state.byteLength && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === tick + tickOffset;
    },
    step(context) {
      assert.equal(context.tick + tickOffset, state[0]);
      assert.equal(context.tickRate, 20);
      seen.push(structuredClone(context));
      state[0]++;
      if (context.tick === failAt) throw new Error('deliberate step failure');
      for (const frame of context.inputs) {
        assert.equal(frame.predicted, false);
        state[1] = (Math.imul(state[1], 31) + frame.input[0]) >>> 0;
        for (const command of frame.commands) {
          assert.equal(command.executeTick, context.tick);
          state[2]++;
          state[3] = (Math.imul(state[3], 17) + command.sequence + command.payload[0]) >>> 0;
        }
        if (mutateInputs) { frame.input.fill(255); for (const command of frame.commands) command.payload.fill(255); }
      }
      stats.steps++;
    },
  };
  return { state, seen, stats, adapter };
}

function session(sim, options = {}) {
  return createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'bootstrap', simulationVersion: 'integer-v1',
    seed: 73, inputSize: 1, recordReplay: false, adapter: sim.adapter, ...options, profile: { ...profile, ...options.profile } });
}

function source(target = 23) {
  const sim = world(), core = session(sim);
  for (let tick = 0; tick < target; tick++) {
    if (tick % 3 === 1) core.queueCommand(new Uint8Array([tick]));
    assert.equal(core.advance(new Uint8Array([tick + 1])).status, 'advanced');
  }
  return { sim, core, bootstrap: core.exportConfirmedBootstrap() };
}

test('confirmed bootstrap exports the latest sparse checkpoint and copies only its confirmed suffix', () => {
  const sim = world(), core = session(sim);
  for (let tick = 0; tick < 39; tick++) core.advance(new Uint8Array([tick + 1]));
  assert.equal(sim.stats.saves, 5, 'initial + four periodic checkpoints; no per-tick save');
  const first = core.exportConfirmedBootstrap();
  assert.equal(first.version, 1);
  assert.equal(first.tick, 39); assert.equal(first.checkpoint.tick, 32);
  assert.equal(first.frames.length, 7); assert.equal(first.checkpoint.hash, hashBytes(first.checkpoint.bytes));
  assert.equal(first.hash, hashBytes(sim.adapter.save()));
  assert.deepEqual(first.players, ['a']);
  assert.equal(first.seed, 73); assert.equal(first.simulationVersion, 'integer-v1');
  assert.deepEqual(first.frames.map(frame => frame.tick), [32, 33, 34, 35, 36, 37, 38]);
  assert.ok(first.frames.every(frame => frame.inputs.every(input => input.predicted === false)));
  const saves = sim.stats.saves, hashes = core.metrics.stateHashComputations;
  const second = core.exportConfirmedBootstrap();
  assert.equal(sim.stats.saves, saves); assert.equal(core.metrics.stateHashComputations, hashes);
  first.checkpoint.bytes.fill(255); first.frames[0].inputs[0].input.fill(255); first.players[0] = 'changed';
  assert.deepEqual(core.exportConfirmedBootstrap(), second, 'exports do not expose retained core buffers');
  core.advance(new Uint8Array([40]));
  const atCheckpoint = core.exportConfirmedBootstrap();
  assert.equal(atCheckpoint.checkpoint.tick, 40); assert.equal(atCheckpoint.frames.length, 0);
  core.close();
});

test('bounded pulses replay through the same adapter path and match live state', () => {
  const { sim, core, bootstrap } = source();
  const target = world(), job = createBootstrapReplay({ adapter: target.adapter, bootstrap, maxCatchupSteps: 2,
    simulationVersion: 'integer-v1', inputSize: 1, tickRate: 20, players: ['a'], seed: 73 });
  assert.equal(target.stats.steps, 0); assert.equal(job.tick, 16); assert.equal(job.targetTick, 23);
  const steps = [], statuses = [];
  while (!job.done) { const result = job.pulse(); steps.push(result.steps); statuses.push(result.status); }
  assert.deepEqual(steps, [2, 2, 2, 1]); assert.deepEqual(statuses, ['catching-up', 'catching-up', 'catching-up', 'done']);
  assert.deepEqual(target.state, sim.state); assert.deepEqual(job.result, { tick: 23, hash: bootstrap.hash });
  assert.equal(target.stats.saves, 3, 'one original, one round trip, one final; no per-pulse snapshots');
  assert.ok(target.seen.every(context => context.resimulating && context.recovering && context.replaying));
  assert.equal(job.pulse().steps, 0); assert.equal(target.stats.steps, 7);
  assert.equal(job.cancel().status, 'done'); assert.deepEqual(target.state, sim.state);
  core.close();
});

test('replay owns immutable copies of all candidate arrays and isolates adapter input mutation', () => {
  const { sim, core, bootstrap } = source();
  const target = world({ mutateInputs: true });
  const job = createBootstrapReplay({ adapter: target.adapter, bootstrap, maxCatchupSteps: 1 });
  bootstrap.checkpoint.bytes.fill(255); bootstrap.players.fill('invalid'); bootstrap.hash = 1;
  for (const frame of bootstrap.frames) {
    frame.tick = 1000;
    for (const input of frame.inputs) { input.input.fill(255); input.playerId = 'invalid'; for (const command of input.commands) command.payload.fill(255); }
  }
  while (!job.done) job.pulse();
  assert.deepEqual(target.state, sim.state);
  core.close();
});

test('empty suffix still validates the final boundary without stepping', () => {
  const { sim, core, bootstrap } = source(24), target = world();
  const job = createBootstrapReplay({ adapter: target.adapter, bootstrap, maxSuffixTicks: 0 });
  assert.equal(job.pulse().status, 'done'); assert.equal(target.stats.steps, 0); assert.deepEqual(target.state, sim.state);
  core.close();
});

for (const [name, change, options = {}] of [
  ['version', value => { value.version = 2; }],
  ['fractional tick', value => { value.tick += .5; }],
  ['checkpoint hash', value => { value.checkpoint.bytes[0] ^= 1; }],
  ['non-contiguous suffix', value => { value.frames[2].tick++; }],
  ['missing suffix frame', value => { value.frames.pop(); }],
  ['sparse suffix array', value => { delete value.frames[2]; }],
  ['sparse input array', value => { delete value.frames[0].inputs[0]; }],
  ['sparse command array', value => { delete value.frames[0].inputs[0].commands[0]; }],
  ['sparse roster array', value => { delete value.players[0]; }],
  ['predicted input', value => { value.frames[0].inputs[0].predicted = true; }],
  ['unknown input player', value => { value.frames[0].inputs[0].playerId = 'b'; }],
  ['input size', value => { value.frames[0].inputs[0].input = new Uint8Array(2); }],
  ['duplicate roster', value => { value.players.push('a'); }],
  ['command tick', value => { value.frames[0].inputs[0].commands[0].executeTick++; }],
  ['command order', value => { value.frames[3].inputs[0].commands[0].sequence = value.frames[0].inputs[0].commands[0].sequence; }],
  ['empty command', value => { value.frames[0].inputs[0].commands[0].payload = new Uint8Array(); }],
  ['suffix limit', () => {}, { maxSuffixTicks: 6 }],
  ['snapshot limit', () => {}, { maxSnapshotBytes: 15 }],
  ['byte budget', () => {}, { maxReplayBytes: 40 }],
  ['version compatibility', () => {}, { simulationVersion: 'other' }],
  ['roster compatibility', () => {}, { players: ['b'] }],
  ['seed compatibility', () => {}, { seed: 72 }],
  ['missing command sequence map', value => { delete value.commandSequences; }],
  ['missing command sequence player', value => { delete value.commandSequences.a; }],
  ['extra command sequence player', value => { value.commandSequences.b = 1; }],
  ['invalid command sequence', value => { value.commandSequences.a = -1; }],
  ['command sequence boundary', value => { value.commandSequences.a++; }],
  ['tick rate compatibility', () => {}, { tickRate: 60 }],
  ['input compatibility', () => {}, { inputSize: 2 }],
]) test(`malformed bootstrap rejects ${name} before loading candidate`, () => {
  const { core, bootstrap } = source(), target = world();
  target.state.set([91, 92, 93, 94]); const original = target.state.slice();
  change(bootstrap);
  assert.throws(() => createBootstrapReplay({ adapter: target.adapter, bootstrap, ...options }));
  assert.equal(target.stats.loads, 0); assert.equal(target.stats.steps, 0); assert.deepEqual(target.state, original);
  core.close();
});

for (const kind of ['hash', 'step', 'final validation']) test(`failed ${kind} restores the original adapter snapshot`, () => {
  const { core, bootstrap } = source();
  if (kind === 'hash') bootstrap.hash ^= 1;
  const target = world({ failAt: kind === 'step' ? 19 : undefined, rejectAt: kind === 'final validation' ? 23 : undefined });
  target.state.set([91, 92, 93, 94]);
  const original = target.state.slice(), job = createBootstrapReplay({ adapter: target.adapter, bootstrap, maxCatchupSteps: 2 });
  assert.equal(job.pulse().status, 'catching-up');
  assert.throws(() => { while (!job.done) job.pulse(); }, /failure|hash|rejected/);
  assert.equal(job.status, 'failed'); assert.equal(job.done, false); assert.equal(job.result, null);
  assert.deepEqual(target.state, original); const loads = target.stats.loads;
  assert.throws(() => job.pulse()); assert.equal(target.stats.loads, loads, 'failed jobs cannot replay or repeatedly restore');
  core.close();
});

test('invalid adapter checkpoint, round-trip failure, and cancellation preserve the original state', () => {
  const { core, bootstrap } = source();
  const rejected = world({ rejectAt: 16 }); rejected.state.set([91, 92, 93, 94]);
  assert.throws(() => createBootstrapReplay({ adapter: rejected.adapter, bootstrap }), /rejected/);
  assert.equal(rejected.stats.loads, 0); assert.deepEqual([...rejected.state], [91, 92, 93, 94]);
  const corrupt = world({ corruptLoad: true }); corrupt.state.set([91, 92, 93, 94]);
  assert.throws(() => createBootstrapReplay({ adapter: corrupt.adapter, bootstrap }), /round-trip/);
  assert.equal(corrupt.stats.loads, 2); assert.deepEqual([...corrupt.state], [91, 92, 93, 94]);
  const cancelled = world(); cancelled.state.set([91, 92, 93, 94]);
  const job = createBootstrapReplay({ adapter: cancelled.adapter, bootstrap, maxCatchupSteps: 1 });
  job.pulse(); assert.equal(job.cancel().status, 'cancelled');
  assert.deepEqual([...cancelled.state], [91, 92, 93, 94]);
  assert.equal(job.pulse().steps, 0); assert.equal(job.cancel().status, 'cancelled');
  assert.equal(cancelled.stats.steps, 1); assert.equal(cancelled.stats.loads, 2);
  core.close();
});

test('bootstrap export requires a live fully confirmed lockstep boundary', () => {
  const rollback = session(world(), { profile: { mode: 'rollback' } });
  assert.throws(() => rollback.exportConfirmedBootstrap(), /confirmed lockstep/); rollback.close();
  const closed = session(world()); closed.close();
  assert.throws(() => closed.exportConfirmedBootstrap(), /confirmed lockstep/);
  const failed = session(world({ failAt: 0 }));
  assert.throws(() => failed.advance(new Uint8Array([1])), /failure/);
  assert.throws(() => failed.exportConfirmedBootstrap(), /confirmed lockstep/); failed.close();
});

test('epoch handoff preserves captured and pending commands once, stable sequences, ongoing input and neutral delay', () => {
  const sim = world(), core = session(sim, { profile: { baseInputDelayTicks: 3, maxPendingCommands: 2 } });
  core.queueCommand(new Uint8Array([11]));
  for (let tick = 0; tick < 6; tick++) {
    if (tick === 4) core.queueCommand(new Uint8Array([22]));
    if (tick === 5) core.queueCommand(new Uint8Array([33]));
    core.advance(new Uint8Array([tick + 1]));
  }
  assert.equal(sim.state[2], 1, 'first command already executed');
  assert.equal(core.queueCommand(new Uint8Array([44])), 4);
  const carried = core.exportLocalCommandState();
  assert.deepEqual(carried.commands.map(command => command.sequence), [2, 3, 4]);
  assert.equal(carried.sequence, 4); assert.deepEqual([...carried.lastInput], [6]);
  assert.deepEqual(core.getCommandSequences(), { a: 1 }, 'future captured and pending commands are excluded');
  assert.ok(carried.commands.every(command => !Object.hasOwn(command, 'executeTick')));
  const nextWorld = world({ initial: sim.adapter.save(), tickOffset: core.tick });
  const next = session(nextWorld, { localCommandState: carried, profile: { baseInputDelayTicks: 3, maxPendingCommands: 2 } });
  carried.lastInput.fill(255); carried.commands[0].payload.fill(255);
  assert.throws(() => next.queueCommand(new Uint8Array([55])), /capacity/, 'carried commands drain within the existing queue cap');
  assert.equal(next.advance().status, 'advanced');
  assert.equal(next.queueCommand(new Uint8Array([55])), 5);
  for (let tick = 1; tick < 8; tick++) next.advance();
  const executed = nextWorld.seen.flatMap(context => context.inputs.flatMap(input => input.commands));
  assert.deepEqual(executed.map(command => command.sequence), [2, 3, 4, 5]);
  assert.deepEqual(executed.map(command => command.payload[0]), [22, 33, 44, 55]);
  assert.deepEqual(executed.map(command => command.executeTick), [3, 3, 4, 4]);
  assert.ok(nextWorld.seen.every(context => context.inputs[0].commands.length <= 2));
  assert.deepEqual(nextWorld.seen.map(context => context.inputs[0].input[0]), [0, 0, 0, 6, 6, 6, 6, 6]);
  assert.equal(nextWorld.state[2], 5); assert.deepEqual(next.exportLocalCommandState().commands, []);
  assert.equal(next.queueCommand(new Uint8Array([66])), 6);
  assert.equal(core.exportLocalCommandState().commands[0].payload[0], 22);
  core.close(); next.close();
});

test('local command state validates capacity, ordering, sequence and input before initial snapshot save', () => {
  const valid = { sequence: 2, lastInput: new Uint8Array([9]), commands: [
    { sequence: 1, payload: new Uint8Array([1]) }, { sequence: 2, payload: new Uint8Array([2]) }] };
  for (const edit of [
    value => { value.sequence = 1; },
    value => { value.commands.reverse(); },
    value => { value.commands[1].sequence = 1; },
    value => { delete value.commands[1]; },
    value => { value.commands[1].payload = new Uint8Array(); },
    value => { value.commands[1].payload = new Uint8Array(2049); },
    value => { value.lastInput = new Uint8Array(2); },
    value => { value.sequence = 21; value.commands = Array.from({ length: 21 }, (_, index) => ({ sequence: index + 1, payload: new Uint8Array([1]) })); },
  ]) {
    const value = structuredClone(valid), sim = world(); edit(value);
    assert.throws(() => session(sim, { localCommandState: value, profile: { maxPendingCommands: 2 } }));
    assert.equal(sim.stats.saves, 0);
  }
});

test('executed sequence baselines survive checkpoints and epoch reload without future-command leakage', () => {
  const sim = world(), initialCommandSequences = { a: 9 };
  const core = session(sim, { initialCommandSequences, profile: { baseInputDelayTicks: 3 } });
  initialCommandSequences.a = 999;
  assert.equal(core.queueCommand(new Uint8Array([11])), 10);
  for (let tick = 0; tick < 3; tick++) core.advance(new Uint8Array([1]));
  assert.deepEqual(core.getCommandSequences(), { a: 9 });
  assert.deepEqual(core.exportConfirmedBootstrap().commandSequences, { a: 9 });
  for (let tick = 3; tick < 9; tick++) core.advance(new Uint8Array([1]));
  const bootstrap = core.exportConfirmedBootstrap();
  assert.equal(bootstrap.checkpoint.tick, 8); assert.equal(bootstrap.frames.length, 1);
  assert.equal(bootstrap.frames[0].inputs[0].commands.length, 0, 'sequence must survive a suffix with no commands');
  assert.deepEqual(bootstrap.commandSequences, { a: 10 });
  assert.equal(core.queueCommand(new Uint8Array([12])), 11);
  assert.deepEqual(core.exportConfirmedBootstrap().commandSequences, { a: 10 });
  const copy = core.getCommandSequences(); copy.a = 1234;
  assert.deepEqual(core.getCommandSequences(), { a: 10 });
  const target = world(), replay = createBootstrapReplay({ adapter: target.adapter, bootstrap });
  assert.equal(replay.pulse().status, 'done');
  const restoredWorld = world({ initial: target.adapter.save(), tickOffset: bootstrap.tick });
  const restored = session(restoredWorld, { initialCommandSequences: bootstrap.commandSequences });
  assert.equal(restored.queueCommand(new Uint8Array([13])), 11, 'reloaded player never reuses an executed sequence');
  restored.advance(new Uint8Array([1]));
  assert.deepEqual(restored.getCommandSequences(), { a: 11 });
  core.close(); restored.close();
});

test('initial executed sequences validate roster and cannot exceed carried local command state', () => {
  for (const value of [{}, { b: 1 }, { a: 1, b: 2 }, { a: -1 }, { a: .5 }, { a: 0x100000000 }, []]) {
    const sim = world(); assert.throws(() => session(sim, { initialCommandSequences: value })); assert.equal(sim.stats.saves, 0);
  }
  assert.throws(() => session(world(), { initialCommandSequences: { a: 9 }, localCommandState: {
    sequence: 8, lastInput: new Uint8Array(1), commands: [] } }), /sequence/);
  assert.throws(() => session(world(), { initialCommandSequences: { a: 9 }, localCommandState: {
    sequence: 10, lastInput: new Uint8Array(1), commands: [{ sequence: 9, payload: new Uint8Array([1]) }] } }), /order/);
  const failed = session(world({ failAt: 0 }), { initialCommandSequences: { a: 9 } });
  failed.queueCommand(new Uint8Array([1])); assert.throws(() => failed.advance(), /failure/);
  assert.deepEqual(failed.getCommandSequences(), { a: 9 }, 'failed simulation never publishes an executed sequence');
  failed.close();
});
test('resume donor is checked against surviving checkpoint, owned future input and command baseline',()=>{
 const early=world(),late=world(),a=session(early,{profile:{baseInputDelayTicks:2}}),b=session(late,{profile:{baseInputDelayTicks:2}});
 for(let tick=0;tick<24;tick++){a.advance(new Uint8Array([tick+1]));if(tick<23)b.advance(new Uint8Array([tick+1]));}
 assert.equal(a.exportConfirmedBootstrap().checkpoint.tick,24);
 const candidate=a.exportConfirmedBootstrap({checkpointAtOrBefore:b.tick});assert.equal(candidate.checkpoint.tick,16);
 assert.equal(b.verifyConfirmedBootstrap(candidate),true);
 const input=structuredClone(candidate);input.frames.at(-1).inputs[0].input[0]++;assert.throws(()=>b.verifyConfirmedBootstrap(input),/retained agreement/);
 const checkpoint=structuredClone(candidate);checkpoint.checkpoint.bytes[4]++;checkpoint.checkpoint.hash=hashBytes(checkpoint.checkpoint.bytes);assert.throws(()=>b.verifyConfirmedBootstrap(checkpoint),/retained agreement/);
 const sequence=structuredClone(candidate);sequence.commandSequences.a++;assert.throws(()=>b.verifyConfirmedBootstrap(sequence),/sequence/);
 const final=structuredClone(candidate);final.hash^=1;assert.throws(()=>a.verifyConfirmedBootstrap(final),/final state/);a.close();b.close();
});
