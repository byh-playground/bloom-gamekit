import { createRoomSession, profiles, createValueCodec, createLoop, createDeadlineScheduler } from '../../../dist/rollback-netcode.js';

const codec = createValueCodec(), links = new Map(), events = [];
let session, loop, scheduler, frame, draw, state, renderedFrames = 0, input = 1, costMs = 0, stopped = false, target = Infinity, corruptTick = -1;
const room = { localPlayerId: '', sessionId: 'availability-browser', coordinatorId: 'A', epoch: 0, players: [], transports: new Map(),
  subscribe() { return () => {}; }, connectMesh() { return Promise.resolve(); },
  setRoster(value) { Object.assign(this, value); }, close() {} };
function adapter() { return {
  save: () => codec.encode(state), load: data => { state = codec.decode(data); },
  validateSnapshot: (data, context) => { try { const candidate = codec.decode(data); return candidate.tick === context.tick && candidate.players.every(id => typeof id === 'string'); } catch { return false; } },
  applyMembership(change) {
    if (state.tick !== change.tick) throw new Error('membership boundary');
    state.epoch = change.epoch; state.players = [...change.players]; state.activePlayers = [...(change.activePlayers ?? change.players)];
  },
  step({ tick, membershipEpoch, inputs }) {
    if (tick !== state.tick || membershipEpoch !== state.epoch) throw new Error('simulation boundary');
    const start = performance.now(); while (performance.now() - start < costMs) {}
    for (const f of inputs) { state.value += f.input[0]; for (const c of f.commands) state.commands.push(f.playerId + ':' + c.sequence + ':' + c.payload[0]); }
    if (tick === corruptTick) state.value += 7;
    state.tick++;
  },
}; }
window.setup = async (id, players, available = true, autoTransfer = false) => {
  state = { tick: 0, epoch: -1, players: [], activePlayers: [], value: 0, commands: [] };
  room.localPlayerId = id; room.players = players;
  session = createRoomSession({ mode: 'online', room, simulationVersion: 'availability-v1', inputSize: 1, adapter: adapter(),
    profile: { ...profiles.lockstep, tickRate: 20, baseInputDelayTicks: 2, pacingPolicy: 'none', checksumInterval: 10,
      heartbeatMs: 100, peerInterruptMs: 3000, peerTimeoutMs: 15000 }, membership: { reconnectGraceMs: 15000 },
    availability: available ? { mode: 'available', heartbeatMs: 100, silenceMs: 1600, inputGraceMs: 1600, resumeGapMs: 1600,
      roundTimeoutMs: 4500, retryMs: 300, autoTransfer: { enabled: autoTransfer, intervalMs: 600, minTenureMs: 1600, minImprovementMs: 2, minSamples: 8, rttWeight: 0, jitterWeight: 0, stepWeight: 4 } } : {},
    onEvent: event => events.push(event) });
  loop = createLoop({ session, getInput: () => new Uint8Array([input]), canAdvance: () => session.tick < target,
    render: () => { renderedFrames++; document.querySelector('#state').value = `${session.tick}: ${state.value}`; }, onError: error => { window.failure = error.stack; } });
  scheduler = createDeadlineScheduler({ getIntervalMs: () => 50, pulse: timestamp => loop.pulse(timestamp, { render: false }),
    onGap: () => loop.resetTiming() });
  draw = timestamp => { if (!stopped) { loop.observeInput(timestamp); loop.render(); frame = requestAnimationFrame(draw); } };
  frame = requestAnimationFrame(draw);
  document.querySelector('#move').onclick = () => { input = 3; session.queueCommand(new Uint8Array([7])); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) loop.releaseInput();
    else { loop.resetTiming(); scheduler.rebase(); scheduler.wake(); }
  });
  window.snapshot = () => ({ state: structuredClone(state), tick: session.tick, hash: session.getStateHash(), status: session.status,
    failure: session.failure ?? window.failure, activePlayers: session.activePlayers, coordinatorId: session.coordinatorId, epoch: session.epoch,
    branch: session.metrics.branch, baseTick: session.baseTick, events: events.slice(-24), hidden: document.hidden, renderedFrames, stepMs: session.metrics.simulationStepMs });
};
function attach(peerId, channel, pc) {
  const listeners = new Set();
  channel.binaryType = 'arraybuffer';
  const transport = { get state() { return channel.readyState === 'open' ? 'open' : 'connecting'; },
    send(data) { if (channel.readyState !== 'open') return false; const link = links.get(peerId); if (link.blocked) { if (link.saved.length < 64) link.saved.push(data.slice()); return true; } channel.send(data); return true; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  channel.onmessage = event => { if (!links.get(peerId).blocked) for (const fn of listeners) fn(new Uint8Array(event.data)); };
  links.set(peerId, { pc, channel, blocked: false, saved: [] }); room.transports.set(peerId, transport); session._attach(peerId, transport);
}
window.offer = async peerId => { const pc = new RTCPeerConnection({ iceServers: [] }); attach(peerId, pc.createDataChannel('room', { ordered: true }), pc); await pc.setLocalDescription(await pc.createOffer()); await gathered(pc); return pc.localDescription.toJSON(); };
window.answer = async (peerId, offer) => { const pc = new RTCPeerConnection({ iceServers: [] }); pc.ondatachannel = e => attach(peerId, e.channel, pc); links.set(peerId, { pc }); await pc.setRemoteDescription(offer); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc); return pc.localDescription.toJSON(); };
window.accept = (id, answer) => links.get(id).pc.setRemoteDescription(answer);
async function gathered(pc) { if (pc.iceGatheringState === 'complete') return; await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); })); }
window.block = (ids, blocked, replay = false) => { for (const id of ids) { const link = links.get(id); link.blocked = blocked; if (!blocked) { if (replay) for (const packet of link.saved) link.channel.send(packet); link.saved = []; } } };
window.setTarget = tick => { target = tick; };
window.setCost = ms => { costMs = ms; };
window.corruptAt = tick => { corruptTick = tick; };
window.stopPump = () => { scheduler.stop(); };
window.stopRender = () => cancelAnimationFrame(frame);
window.resumeRender = () => { frame = requestAnimationFrame(draw); };
window.resumePump = () => { scheduler.stop(); loop.resetTiming(); scheduler.start(); };
window.startPump = () => scheduler.start();
window.stop = () => { stopped = true; scheduler.stop(); cancelAnimationFrame(frame); session.close(); for (const link of links.values()) link.pc.close(); };
window.rtcStats = async () => { let bytesSent = 0; for (const link of links.values()) (await link.pc.getStats()).forEach(row => { if (row.type === 'data-channel') bytesSent += row.bytesSent ?? 0; }); return { connections: links.size, bytesSent }; };
