import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession, hashBytes, playReplay, profiles } from '../../dist/rollback-netcode.js';
import { packet, TYPE } from '../../packages/_rollback-shared/src/protocol.js';

const TICK_RATE = 60;
const stream = (player, tick) => new Uint8Array([(tick * 7 + player.charCodeAt(0) * 11) % 31 + 1]);
const neutral = () => new Uint8Array(1);
const lockstepProfile = {
  ...profiles.lockstep, tickRate: TICK_RATE, baseInputDelayTicks: 0, minInputDelayTicks: 0,
  maxInputDelayTicks: 8, adaptiveInputDelay: false, pacingPolicy: 'none',
  stateHistorySize: 32, checksumInterval: 8,
};

function world(players, entityCount = 1) {
  // Snapshot buffers are deliberately reused; the session must own every retained copy.
  const state = new Uint32Array(4 + entityCount * 3);
  const stats = { saves: 0, loads: 0, steps: 0, predicted: 0, resimulated: 0, recovering: 0 };
  const seen = [];
  const adapter = {
    save() { stats.saves++; return new Uint8Array(state.buffer); },
    load(data) { stats.loads++; assert.equal(data.byteLength, state.byteLength); new Uint8Array(state.buffer).set(data); },
    validateSnapshot(data, { tick }) {
      return data.byteLength === state.byteLength && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) === tick;
    },
    step({ tick, tickRate, inputs, resimulating, recovering }) {
      assert.equal(tick, state[0], 'S[t] is the only state stepped by inputs[t]');
      assert.equal(tickRate, TICK_RATE);
      assert.deepEqual(inputs.map(frame => frame.playerId), players);
      let force = 0;
      for (const [index, frame] of inputs.entries()) {
        stats.predicted += Number(frame.predicted);
        force += (index + 1) * frame.input[0];
        state[1] = (Math.imul(state[1], 31) + frame.input[0] + index) >>> 0;
        let previousSequence = 0;
        for (const command of frame.commands) {
          assert.equal(command.executeTick, tick);
          assert.ok(command.sequence > previousSequence);
          previousSequence = command.sequence;
          state[2]++;
          state[3] += command.payload[0] + index * 100 + command.sequence;
        }
      }
      for (let entity = 0; entity < entityCount; entity++) {
        const offset = 4 + entity * 3;
        state[offset] += force + entity;
        state[offset + 1] = (Math.imul(state[offset + 1], 17) + force + tick) >>> 0;
        state[offset + 2] ^= force + entity + tick;
      }
      state[0]++;
      stats.steps++; stats.resimulated += Number(!!resimulating); stats.recovering += Number(!!recovering);
      seen.push({ tick, resimulating: !!resimulating, recovering: !!recovering, inputs: structuredClone(inputs) });
    },
  };
  return { state, stats, seen, adapter };
}

function oracle(players, target, { delay = 0, input = stream, commands = [], entityCount = 1 } = {}) {
  const expected = world(players, entityCount);
  for (let tick = 0; tick < target; tick++) expected.adapter.step({ tick, tickRate: TICK_RATE, inputs: players.map(playerId => ({
    playerId, input: tick < delay ? neutral() : input(playerId, tick - delay), predicted: false,
    commands: commands.filter(command => command.playerId === playerId && command.executeTick === tick),
  })), resimulating: false });
  return expected.state;
}

function network({ players = ['a', 'b'], profile = {}, peerProfiles = [], input = stream, entityCount = 1, faults = {}, recordReplay = true } = {}) {
  const sims = players.map(() => world(players, entityCount));
  const events = players.map(() => []), pending = [], listeners = new Map(), packets = [];
  const stats = { dropped: 0, duplicated: 0, reordered: 0, blocked: 0 };
  const lastDelivered = new Map();
  let now = 1000, serial = 0, delivery = true, sending = true;
  const sessions = players.map((localPlayerId, index) => createSession({
    players: [...players].reverse(), localPlayerId, sessionId: 'efficient-lockstep', simulationVersion: 'integer-lockstep-v1',
    inputSize: 1, seed: 17, adapter: sims[index].adapter, recordReplay, clock: () => now,
    profile: { ...lockstepProfile, ...profile, ...peerProfiles[index] }, onEvent: event => events[index].push(event),
  }));
  for (let from = 0; from < players.length; from++) for (let to = 0; to < players.length; to++) if (from !== to) {
    const key = `${from}/${to}`;
    sessions[from].attachTransport(players[to], {
      send(bytes) {
        assert.ok(bytes instanceof Uint8Array && bytes.length <= 16384);
        const message = { from, to, key, bytes: bytes.slice(), number: ++serial, at: now };
        packets.push(message);
        if (!sending || faults.block?.(message)) { stats.blocked++; return false; }
        if (faults.drop?.(message)) { stats.dropped++; return true; }
        message.at += faults.delay?.(message) ?? 0;
        pending.push(message);
        if (faults.duplicate?.(message)) { stats.duplicated++; pending.push({ ...message, bytes: bytes.slice(), at: message.at + 1 }); }
        return true;
      },
      subscribe(callback) { listeners.set(`${to}/${from}`, callback); return () => listeners.delete(`${to}/${from}`); },
    });
  }
  function pump(ms = 20) {
    now += ms;
    sessions.forEach(session => session.poll(now));
    if (!delivery) return;
    const ready = pending.filter(message => message.at <= now);
    for (let index = pending.length - 1; index >= 0; index--) if (pending[index].at <= now) pending.splice(index, 1);
    if (faults.reorder) ready.reverse();
    for (const message of ready) {
      if (message.number < (lastDelivered.get(message.key) ?? 0)) stats.reordered++;
      lastDelivered.set(message.key, Math.max(message.number, lastDelivered.get(message.key) ?? 0));
      listeners.get(message.key)?.(message.bytes);
    }
  }
  function drain(rounds = 12) { for (let round = 0; round < rounds; round++) pump(50); }
  function drive(target, beforeAdvance = () => {}) {
    for (let round = 0; round < target * 80 + 300; round++) {
      sessions.forEach((session, index) => {
        assert.equal(session.failure, null, `peer ${players[index]} failed: ${JSON.stringify(session.failure)}`);
        if (session.tick < target) { beforeAdvance(session, index); session.advance(input(players[index], session.tick)); }
      });
      pump();
      if (sessions.every(session => session.tick === target && session.confirmedTick >= target - 1 && !session.resimulating)) { drain(); return; }
    }
    assert.fail(`lockstep did not reach ${target}: ${JSON.stringify(sessions.map(session => ({ tick: session.tick, status: session.status, failure: session.failure })))}`);
  }
  drain();
  return { players, sessions, sims, events, stats, packets, pump, drain, drive,
    setDelivery: value => { delivery = value; }, setSending: value => { sending = value; },
    close: () => sessions.forEach(session => session.close()) };
}

function assertNormalLockstep(pair, expected) {
  for (const [index, session] of pair.sessions.entries()) {
    assert.deepEqual(pair.sims[index].state, expected, 'live state agrees with the independently generated input oracle');
    assert.equal(session.metrics.predictedTicks, 0);
    assert.equal(session.metrics.rollbacks, 0);
    assert.equal(session.metrics.resimulatedTicks, 0);
    assert.equal(session.metrics.recoveries, 0, 'recovery must not hide a normal-play divergence');
    assert.equal(pair.sims[index].stats.predicted, 0);
    assert.equal(pair.sims[index].stats.resimulated, 0);
    assert.equal(pair.sims[index].stats.loads, 0);
    assert.equal(pair.sims[index].stats.steps, session.tick);
    assert.equal(session.failure, null);
  }
}

test('mode defaults to rollback, presets select explicitly, and unknown modes are rejected', () => {
  assert.equal(profiles.action.mode, 'rollback');
  assert.equal(profiles.rts.mode, 'rollback');
  assert.equal(profiles.lockstep.mode, 'lockstep');
  const options = { players: ['a'], localPlayerId: 'a', sessionId: 'mode', simulationVersion: '1', inputSize: 1, adapter: world(['a']).adapter };
  for (const profile of [undefined, {}, { rollbackWindowTicks: 0 }]) {
    const session = createSession({ ...options, profile });
    assert.equal(session.profile.mode, 'rollback'); session.close();
  }
  assert.throws(() => createSession({ ...options, profile: { mode: 'prediction-free-ish' } }), /mode/);
  assert.throws(() => createSession({ ...options, profile: { ...lockstepProfile, checksumInterval: 33, stateHistorySize: 32 } }), /checksumInterval/);
});

test('lockstep commits and sends before waiting, resumes frozen ticks, and executes each command once under lossy transport', () => {
  const delay = 3, target = 180, commandTicks = [0, 21, 79], commands = [], queued = [new Set(), new Set()];
  const pair = network({ profile: { baseInputDelayTicks: delay, predictionPolicy: () => { throw new Error('lockstep must never predict'); } }, faults: {
    drop: message => message.number % 11 === 0,
    delay: message => message.number % 5 * 13,
    duplicate: message => message.number % 7 === 0,
    reorder: true,
  } });
  const queueCommands = (session, player) => {
    if (!commandTicks.includes(session.tick) || queued[player].has(session.tick)) return;
    queued[player].add(session.tick);
    for (let item = 0; item < 2; item++) {
      const payload = new Uint8Array([player * 10 + item + 1]);
      const sequence = session.queueCommand(payload);
      commands.push({ playerId: pair.players[player], sequence, executeTick: session.tick + delay, payload: payload.slice() });
      payload[0] = 255;
    }
  };
  try {
    pair.drive(40, queueCommands);
    pair.setDelivery(false);
    // Exhaust precommitted delay slots, then repeatedly submit while frozen.
    for (let round = 0; round < delay + 12; round++) {
      pair.sessions.forEach((session, index) => session.advance(stream(pair.players[index], session.tick)));
      pair.pump(10);
    }
    const frozen = pair.sessions.map(session => session.tick), saves = pair.sims.map(sim => sim.stats.saves);
    const sentBefore = pair.packets.length;
    for (let round = 0; round < 20; round++) pair.sessions.forEach(session => assert.equal(session.advance(new Uint8Array([255])).status, 'stalled'));
    assert.deepEqual(pair.sessions.map(session => session.tick), frozen);
    assert.deepEqual(pair.sims.map(sim => sim.stats.saves), saves, 'waiting does not serialize state');
    assert.ok(pair.packets.slice(sentBefore).some(message => message.bytes[5] === TYPE.INPUT), 'inputs still send before a frozen-tick wait');
    pair.setDelivery(true); pair.drain();
    pair.drive(target, queueCommands);
    assertNormalLockstep(pair, oracle(pair.players, target, { delay, commands }));
    assert.ok(pair.sessions.some(session => session.metrics.stalls > 0));
    for (const kind of ['dropped', 'duplicated', 'reordered']) assert.ok(pair.stats[kind] > 0, `${kind} actually occurred`);
    for (const session of pair.sessions) {
      const replay = session.exportReplay(), replayWorld = world(pair.players);
      const result = playReplay({ adapter: replayWorld.adapter, replay });
      assert.equal(result.tick, target); assert.equal(result.hash, replay.hash); assert.equal(result.hash, session.getStateHash());
      assert.equal(replay.frames.flatMap(frame => frame.inputs.flatMap(input => input.commands)).length, commands.length);
    }
  } finally { pair.close(); }
});

test('every roster member is required even with a nonzero rollback window', () => {
  let blockThird = true;
  const pair = network({ players: ['a', 'b', 'c'], profile: { rollbackWindowTicks: 12 }, faults: {
    block: message => blockThird && message.from === 2 && message.bytes[5] === TYPE.INPUT,
  } });
  try {
    for (let round = 0; round < 10; round++) { pair.sessions.forEach((session, index) => session.advance(stream(pair.players[index], session.tick))); pair.pump(); }
    assert.equal(pair.sessions[0].tick, 0); assert.equal(pair.sessions[1].tick, 0);
    assert.equal(pair.sims[0].stats.steps, 0); assert.equal(pair.sims[1].stats.steps, 0);
    assert.ok(pair.stats.blocked > 0);
    blockThird = false; pair.drive(72);
    assertNormalLockstep(pair, oracle(pair.players, 72));
  } finally { pair.close(); }
});

test('backpressure resumes without predicting or changing a committed frame', () => {
  const pair = network();
  try {
    pair.drive(19); pair.setSending(false);
    for (let round = 0; round < 20; round++) { pair.sessions.forEach((session, index) => session.advance(stream(pair.players[index], session.tick))); pair.pump(10); }
    assert.deepEqual(pair.sessions.map(session => session.tick), [19, 19]);
    pair.setSending(true); pair.drive(80);
    assertNormalLockstep(pair, oracle(pair.players, 80));
  } finally { pair.close(); }
});

for (const [field, overrides] of [
  ['mode', { mode: 'rollback' }], ['baseInputDelayTicks', { baseInputDelayTicks: 2 }], ['checksumInterval', { checksumInterval: 4 }],
]) test(`HELLO rejects a lockstep ${field} mismatch before simulation`, () => {
  const pair = network({ peerProfiles: [{}, overrides] });
  try {
    for (const [index, session] of pair.sessions.entries()) {
      assert.equal(session.status, 'failed'); assert.equal(session.tick, 0); assert.equal(pair.sims[index].stats.steps, 0);
      assert.equal(session.failure.type, 'handshake-mismatch');
      assert.ok(session.failure.fields.includes(field));
      assert.equal(session.advance(neutral()).status, 'failed');
    }
  } finally { pair.close(); }
});

for (const recordReplay of [true, false]) test(`1,000 entities serialize only at sparse checkpoints (recordReplay=${recordReplay})`, () => {
  const target = 257, interval = 16, sim = world(['a'], 1000);
  const session = createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'serialization-cost', simulationVersion: '1',
    inputSize: 1, adapter: sim.adapter, recordReplay, profile: { ...lockstepProfile, stateHistorySize: 64, checksumInterval: interval } });
  try {
    for (let tick = 0; tick < target; tick++) assert.equal(session.advance(stream('a', tick)).status, 'advanced');
    assert.equal(sim.stats.saves, 1 + Math.floor(target / interval), 'initial snapshot plus checksum checkpoints, never a per-tick replay copy');
    assert.equal(sim.stats.steps, target); assert.equal(sim.stats.loads, 0);
    assert.equal(session.metrics.snapshotSaves, sim.stats.saves);
    assert.equal(session.metrics.serializedSnapshotBytes, sim.stats.saves * sim.state.byteLength);
    if (recordReplay) {
      const rollbackWorld = world(['a'], 1000);
      const rollback = createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'rollback-cost', simulationVersion: '1',
        inputSize: 1, adapter: rollbackWorld.adapter, profile: { ...session.profile, mode: 'rollback' } });
      try {
        for (let tick = 0; tick < target; tick++) rollback.advance(stream('a', tick));
        assert.equal(rollbackWorld.stats.saves, target + 1, 'rollback retains its established every-tick snapshot behavior');
        assert.deepEqual(rollbackWorld.state, sim.state, 'the same 1,000-entity workload produces the same state in both modes');
      } finally { rollback.close(); }
    }
    const retained = session.metrics.retainedSnapshotBytes;
    assert.ok(retained <= (Math.ceil(session.profile.stateHistorySize / interval) + 1) * sim.state.byteLength, `sparse snapshots retain ${retained} bytes`);
    assert.equal(session.getStateHash(255), undefined, 'unretained historical states cannot be manufactured');
    const beforeCheckpointHash = sim.stats.saves;
    assert.equal(typeof session.getStateHash(256), 'number');
    assert.equal(sim.stats.saves, beforeCheckpointHash, 'retained checkpoint hashing needs no serialization');
    const expected = hashBytes(new Uint8Array(sim.state.buffer));
    assert.equal(session.getStateHash(), expected);
    assert.equal(sim.stats.saves, beforeCheckpointHash + 1, 'current noncheckpoint hashing serializes on demand');
    if (recordReplay) {
      const replay = session.exportReplay(), replayWorld = world(['a'], 1000);
      assert.equal(replay.truncated, false); assert.equal(replay.tick, target); assert.equal(replay.hash, expected);
      const result = playReplay({ adapter: replayWorld.adapter, replay });
      assert.equal(result.hash, expected); assert.deepEqual(replayWorld.state, sim.state);
      replay.initialState[0] = 255; replay.frames[0].inputs[0].input[0] = 255;
      assert.equal(session.exportReplay().initialState[0], 0, 'exports do not alias retained snapshots');
      assert.equal(session.exportReplay().frames[0].inputs[0].input[0], stream('a', 0)[0]);
    }
  } finally { session.close(); }
});

test('replay capacity captures the exact noncheckpoint boundary and remains valid after input/history eviction', () => {
  const pair = network({ profile: { maxReplayBytes: 18 * 9, checksumInterval: 8 } });
  try {
    pair.drive(100);
    for (const [index, session] of pair.sessions.entries()) {
      const replay = session.exportReplay(), replayWorld = world(pair.players);
      assert.equal(replay.truncated, true); assert.equal(replay.tick, 9); assert.equal(replay.frames.length, 9);
      assert.equal(session.getStateHash(9), undefined);
      const result = playReplay({ adapter: replayWorld.adapter, replay });
      assert.equal(result.hash, replay.hash); assert.deepEqual(replayWorld.state, oracle(pair.players, 9));
      assert.equal(pair.events[index].filter(event => event.type === 'replay-capacity').length, 1);
      assert.ok(pair.sims[index].stats.saves <= 1 + Math.floor(100 / 8) + 1, 'a capped replay retains only its one final boundary snapshot');
    }
  } finally { pair.close(); }
});

test('checksum divergence recovers from a sparse checkpoint without normal-play rollback', () => {
  const pair = network({ profile: { checksumInterval: 8 }, entityCount: 1000 });
  try {
    pair.drive(21); pair.sims[1].state[4] += 999;
    pair.drive(100);
    for (const sim of pair.sims) assert.deepEqual(sim.state, oracle(pair.players, 100, { entityCount: 1000 }));
    const guest = pair.sessions[1];
    assert.ok(guest.metrics.hashMismatches > 0); assert.ok(guest.metrics.recoveries > 0);
    assert.equal(guest.metrics.rollbacks, 0); assert.equal(guest.metrics.predictedTicks, 0);
    assert.ok(pair.sims[1].seen.filter(frame => frame.resimulating).every(frame => frame.recovering));
    assert.equal(pair.sessions[0].getStateHash(), guest.getStateHash());
  } finally { pair.close(); }
});

test('recovery repairs an already-capped replay hash when its exact boundary is between checkpoints', () => {
  let blockHashes = true;
  const pair = network({ profile: { maxReplayBytes: 18 * 9 }, faults: {
    block: message => blockHashes && message.bytes[5] === TYPE.HASH,
  } });
  try {
    pair.drive(5); pair.sims[1].state[4] += 1234;
    pair.drive(12);
    assert.equal(pair.sessions[1].exportReplay().tick, 9);
    blockHashes = false; pair.drain(30);
    assert.ok(pair.sessions[1].metrics.recoveries > 0);
    assert.deepEqual(pair.sims[1].state, oracle(pair.players, 12));
    const replay = pair.sessions[1].exportReplay(), replayWorld = world(pair.players);
    assert.equal(replay.truncated, true); assert.equal(replay.tick, 9);
    assert.equal(playReplay({ adapter: replayWorld.adapter, replay }).hash, replay.hash);
    assert.deepEqual(replayWorld.state, oracle(pair.players, 9));
  } finally { pair.close(); }
});

test('manual recovery replays retained confirmed inputs from a checkpoint to a noncheckpoint current tick', () => {
  const pair = network();
  try {
    pair.drive(43);
    const guest = pair.sessions[1], sim = pair.sims[1];
    assert.equal(guest.getStateHash(42), undefined);
    sim.state[4] += 999;
    const saves = sim.stats.saves, steps = sim.stats.steps;
    assert.equal(guest.requestResync(24), true);
    assert.equal(guest.advance(stream('b', 43)).status, 'recovering');
    pair.drain(20);
    assert.equal(guest.tick, 43); assert.equal(guest.metrics.recoveries, 1);
    assert.equal(sim.stats.steps - steps, 19);
    assert.ok(sim.stats.saves - saves <= 5, 'recovery snapshots original, candidate and crossed checkpoints, not every replay tick');
    assert.deepEqual(sim.state, oracle(pair.players, 43));
    assert.ok(sim.seen.slice(-19).every(frame => frame.resimulating && frame.recovering && frame.inputs.every(input => !input.predicted)));
    assert.equal(guest.getStateHash(42), undefined, 'recovery keeps sparse history sparse');
    assert.equal(guest.requestResync(0), false, 'expired input windows cannot be recovered from an old checkpoint');
    assert.equal(guest.requestResync(42), true, 'a noncheckpoint request selects an earlier retained checkpoint');
    pair.drain(20);
    assert.equal(guest.metrics.recoveries, 2);
    assert.ok(pair.events[1].some(event => event.type === 'recovered' && event.from === 40 && event.target === 43));
    pair.drive(90); assert.equal(guest.metrics.rollbacks, 0);
    assert.deepEqual(sim.state, oracle(pair.players, 90));
  } finally { pair.close(); }
});

test('late conflicting committed input fails desync without stepping, restoring or rolling back', () => {
  const pair = network();
  try {
    pair.drive(20);
    const guest = pair.sessions[1], before = pair.sims[1].state.slice(), stats = { ...pair.sims[1].stats };
    const conflict = packet(TYPE.INPUT, 0x100000, writer => {
      writer.u32(18); writer.u16(1); writer.u16(1); writer.i32(-1); writer.u32(20);
      writer.u16(1); writer.raw(new Uint8Array([255])); writer.u16(0);
    });
    guest.receive('a', conflict);
    assert.equal(guest.status, 'failed'); assert.match(guest.failure.type, /desync/);
    assert.equal(guest.tick, 20); assert.deepEqual(pair.sims[1].state, before);
    assert.equal(guest.metrics.rollbacks, 0); assert.equal(guest.metrics.resimulatedTicks, 0);
    assert.equal(pair.sims[1].stats.steps, stats.steps); assert.equal(pair.sims[1].stats.loads, stats.loads);
    assert.equal(guest.advance(neutral()).status, 'failed');
    assert.equal(pair.events[1].filter(event => /desync/.test(event.type)).length, 1);
  } finally { pair.close(); }
});

test('a step failure restores its noncheckpoint boundary and exports the restored replay hash', () => {
  const sim = world(['a']), originalStep = sim.adapter.step;
  sim.adapter.step = frame => {
    originalStep(frame);
    if (frame.tick === 5 && !frame.resimulating) throw new Error('deliberate live step failure');
  };
  const session = createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'failed-step', simulationVersion: '1',
    inputSize: 1, adapter: sim.adapter, profile: lockstepProfile });
  try {
    for (let tick = 0; tick < 5; tick++) session.advance(stream('a', tick));
    const before = sim.state.slice();
    assert.throws(() => session.advance(stream('a', 5)), /deliberate live step failure/);
    assert.equal(session.status, 'failed'); assert.equal(session.tick, 5); assert.equal(sim.state[0], 5);
    assert.deepEqual(sim.state, before, 'a throwing partial mutation is reconstructed from the last confirmed checkpoint');
    const replay = session.exportReplay(), replayWorld = world(['a']);
    assert.equal(replay.tick, 5);
    assert.equal(playReplay({ adapter: replayWorld.adapter, replay }).hash, replay.hash);
    assert.equal(session.getStateHash(), replay.hash); assert.deepEqual(replayWorld.state, before);
    assert.equal(session.getStateHash(4), undefined); assert.equal(session.getStateHash(6), undefined);
    assert.equal(session.advance(neutral()).status, 'failed');
  } finally { session.close(); }
});

test('checkpoint byte-budget failure restores the present boundary without publishing the failed snapshot', () => {
  let tick = 0, size = 4;
  const adapter = {
    save() { const data = new Uint8Array(size); new DataView(data.buffer).setUint32(0, tick, true); return data; },
    load(data) { size = data.length; tick = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true); },
    validateSnapshot: data => data.length >= 4,
    step(frame) { assert.equal(frame.tick, tick); tick++; size = 40; },
  };
  const session = createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'failed-checkpoint', simulationVersion: '1',
    inputSize: 1, adapter, profile: { ...lockstepProfile, stateHistorySize: 4, checksumInterval: 2, maxHistoryBytes: 64 } });
  try {
    for (let index = 0; index < 3; index++) session.advance(neutral());
    const before = adapter.save(), originalHash = session.getStateHash(), retained = session.metrics.retainedSnapshotBytes;
    assert.equal(retained, 44, 'only S[0] and S[2] have been retained');
    assert.throws(() => session.advance(neutral()), error => error.code === 'history-capacity');
    assert.equal(session.status, 'failed'); assert.equal(session.tick, 3); assert.equal(tick, 3);
    assert.deepEqual(adapter.save(), before); assert.equal(session.metrics.retainedSnapshotBytes, retained);
    assert.equal(session.getStateHash(), originalHash); assert.equal(session.getStateHash(4), undefined);
    const replay = session.exportReplay();
    assert.equal(replay.tick, 3); assert.equal(replay.hash, originalHash);
    // This independent adapter reproduces the changing snapshot shape without touching the failed live state.
    let replayTick = 0;
    const replayAdapter = {
      load(data) { replayTick = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true); },
      step(frame) { assert.equal(frame.tick, replayTick); replayTick++; },
      save() { const data = new Uint8Array(replayTick ? 40 : 4); new DataView(data.buffer).setUint32(0, replayTick, true); return data; },
    };
    assert.equal(playReplay({ adapter: replayAdapter, replay }).hash, replay.hash);
  } finally { session.close(); }
});
