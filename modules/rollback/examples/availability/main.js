import { createRoomSession, createNostrDynamicRoom, createValueCodec, profiles, createLoop, createDeadlineScheduler } from '../../../../dist/rollback-netcode.js';

const codec = createValueCodec(), keys = new Set(), status = document.querySelector('#status'), canvas = document.querySelector('#view'), ctx = canvas.getContext('2d');
let session, room, loop, scheduler, animation, state, lastEvent = '';
function display() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state) for (const [i, id] of state.players.entries()) {
    ctx.fillStyle = state.activePlayers.includes(id) ? '#007c70' : '#7f888b'; ctx.beginPath(); ctx.arc(state.positions[id], 40 + i * 36, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(id.slice(0, 8), 16, 45 + i * 36);
  }
  if (session) status.textContent = `상태: ${session.status} / tick: ${session.tick}\n방 소유자: ${session.roomOwnerId}\n시뮬레이션 coordinator: ${session.coordinatorId}\n활성: ${session.activePlayers.length}/${session.players.length}\n${lastEvent}`;
}
async function connect(role) {
  document.querySelector('#host').disabled = document.querySelector('#join').disabled = true;
  try {
    room = await createNostrDynamicRoom({ role, room: document.querySelector('#code').value, namespace: 'bloom-gamekit-availability-example', maxPlayers: 4 });
    state = { tick: 0, epoch: -1, players: [], activePlayers: [], positions: {} };
    const adapter = {
      save: () => codec.encode(state), load: data => { state = codec.decode(data); },
      validateSnapshot: (data, { tick }) => { try { const candidate = codec.decode(data); return candidate.tick === tick && candidate.players.every(id => Number.isFinite(candidate.positions[id])); } catch { return false; } },
      applyMembership(change) {
        state.tick = change.tick; state.epoch = change.epoch; state.players = [...change.players]; state.activePlayers = [...(change.activePlayers ?? change.players)];
        for (const id of change.joined) state.positions[id] = 100;
        for (const id of change.left) delete state.positions[id];
      },
      step({ tick, inputs }) {
        for (const frame of inputs) state.positions[frame.playerId] = Math.max(70, Math.min(730, state.positions[frame.playerId] + (frame.input[0] === 1 ? -4 : frame.input[0] === 2 ? 4 : 0)));
        state.tick = tick + 1;
      },
    };
    session = createRoomSession({ mode: 'online', room, adapter, inputSize: 1, simulationVersion: 'availability-example-v1', profile: profiles.lockstep,
      membership: { maxPlayers: 4 }, roomOwnerId: room.coordinatorId,
      availability: { mode: document.querySelector('#policy').value, autoTransfer: { enabled: true } },
      onEvent: event => { lastEvent = `${event.type} ${event.reason ?? ''}`; } });
    loop = createLoop({ session, getInput: () => new Uint8Array([keys.has('ArrowLeft') ? 1 : keys.has('ArrowRight') ? 2 : 0]), render: display,
      onInputRelease: () => keys.clear(), onError: error => { status.textContent = error.message; } });
    scheduler = createDeadlineScheduler({ getIntervalMs: () => 1000 / session.profile.tickRate,
      pulse: timestamp => loop.pulse(timestamp, { render: false }), onGap: () => loop.resetTiming() });
    const render = timestamp => { loop.observeInput(timestamp); loop.render(); animation = requestAnimationFrame(render); };
    animation = requestAnimationFrame(render); scheduler.start(); document.querySelector('#leave').disabled = false;
  } catch (error) { status.textContent = error.message; room?.close(); document.querySelector('#host').disabled = document.querySelector('#join').disabled = false; }
}
document.querySelector('#host').onclick = () => connect('host'); document.querySelector('#join').onclick = () => connect('join');
document.querySelector('#leave').onclick = async () => { try { await session.leave(); scheduler.stop(); cancelAnimationFrame(animation); loop.stop(); display(); } catch (error) { status.textContent = error.message; } };
window.addEventListener('keydown', e => { if (e.key.startsWith('Arrow')) { e.preventDefault(); keys.add(e.key); } });
window.addEventListener('keyup', e => keys.delete(e.key)); window.addEventListener('blur', () => loop?.releaseInput());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) loop?.releaseInput();
  else if (scheduler?.running) { loop.resetTiming(); scheduler.rebase(); scheduler.wake(); }
});
window.addEventListener('pagehide', () => { scheduler?.stop(); cancelAnimationFrame(animation); loop?.stop(); session?.close(); });
