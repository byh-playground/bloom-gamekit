import { createRoomSession, profiles } from '../../../../dist/rollback.js';
import { createNostrDynamicRoom } from '../../../../dist/transport.js';
import { createValueCodec } from '../../../../dist/deterministic.js';
import { createLoop, createDeadlineScheduler } from '../../../../dist/simloop.js';
const CODEC = createValueCodec(),
    KEYS = new Set(),
    STATUS = document.querySelector('#status'),
    CANVAS = document.querySelector('#view'),
    CTX = CANVAS.getContext('2d');
let session;
let room;
let loop;
let scheduler;
let animation;
let state;
let lastEvent = '';
function display() {
    CTX.clearRect(0, 0, CANVAS.width, CANVAS.height);
    if (state) {
        for (const [I, ID] of state.players.entries()) {
            CTX.fillStyle = state.activePlayers.includes(ID) ? '#007c70' : '#7f888b';
            CTX.beginPath();
            CTX.arc(state.positions[ID], 40 + I * 36, 12, 0, Math.PI * 2);
            CTX.fill();
            CTX.fillText(ID.slice(0, 8), 16, 45 + I * 36);
        }
    }
    if (session) {
        STATUS.textContent = `상태: ${session.status} / tick: ${session.tick}\n방 소유자: ${session.roomOwnerId}\n시뮬레이션 coordinator: ${session.coordinatorId}\n활성: ${session.activePlayers.length}/${session.players.length}\n${lastEvent}`;
    }
}
async function connect(role) {
    document.querySelector('#host').disabled = document.querySelector('#join').disabled = true;
    document.querySelector('#simulation').disabled = document.querySelector('#policy').disabled = true;
    try {
        room = await createNostrDynamicRoom({
            role,
            room: document.querySelector('#code').value,
            namespace: 'bloom-gamekit-availability-example',
            maxPlayers: 4,
        });
        state = {
            tick: 0,
            epoch: -1,
            players: [],
            activePlayers: [],
            positions: {},
        };
        const ADAPTER = {
            save: () => CODEC.encode(state),
            load: (data) => {
                state = CODEC.decode(data);
            },
            validateSnapshot: (data, { tick }) => {
                try {
                    const CANDIDATE = CODEC.decode(data);
                    return (
                        CANDIDATE.tick === tick &&
                        CANDIDATE.players.every((id) => Number.isFinite(CANDIDATE.positions[id]))
                    );
                } catch {
                    return false;
                }
            },
            applyMembership(change) {
                state.tick = change.tick;
                state.epoch = change.epoch;
                state.players = [...change.players];
                state.activePlayers = [...(change.activePlayers ?? change.players)];
                for (const ID of change.joined) {
                    state.positions[ID] = 100;
                }
                for (const ID of change.left) {
                    delete state.positions[ID];
                }
            },
            step({ tick, inputs }) {
                for (const FRAME of inputs) {
                    state.positions[FRAME.playerId] = Math.max(
                        70,
                        Math.min(
                            730,
                            state.positions[FRAME.playerId] +
                                (FRAME.input[0] === 1 ? -4 : FRAME.input[0] === 2 ? 4 : 0),
                        ),
                    );
                }
                state.tick = tick + 1;
            },
        };
        session = createRoomSession({
            mode: 'online',
            room,
            adapter: ADAPTER,
            inputSize: 1,
            simulationVersion: 'availability-example-v1',
            profile: document.querySelector('#simulation').value === 'rollback' ? profiles.action : profiles.lockstep,
            membership: {
                maxPlayers: 4,
            },
            roomOwnerId: room.coordinatorId,
            availability: {
                mode: document.querySelector('#policy').value,
                autoTransfer: {
                    enabled: true,
                },
            },
            onEvent: (event) => {
                lastEvent = `${event.type} ${event.reason ?? ''}`;
            },
        });
        loop = createLoop({
            session,
            getInput: () => new Uint8Array([KEYS.has('ArrowLeft') ? 1 : KEYS.has('ArrowRight') ? 2 : 0]),
            render: display,
            onInputRelease: () => KEYS.clear(),
            onError: (error) => {
                STATUS.textContent = error.message;
            },
        });
        // Device maintenance runs at its own cadence; the loop retains the configured simulation TPS.
        scheduler = createDeadlineScheduler({
            getIntervalMs: () => 1000 / 60,
            pulse: (timestamp) => {
                loop.pollInput(timestamp);
                loop.pulse(timestamp, {
                    render: false,
                    input: false,
                });
            },
            onGap: () => loop.resetTiming(),
        });
        const RENDER = () => {
            loop.render();
            animation = requestAnimationFrame(RENDER);
        };
        animation = requestAnimationFrame(RENDER);
        scheduler.start();
        document.querySelector('#leave').disabled = false;
    } catch (error) {
        STATUS.textContent = error.message;
        room?.close();
        document.querySelector('#simulation').disabled = document.querySelector('#policy').disabled = false;
        document.querySelector('#host').disabled = document.querySelector('#join').disabled = false;
    }
}
document.querySelector('#host').onclick = () => connect('host');
document.querySelector('#join').onclick = () => connect('join');
document.querySelector('#leave').onclick = async () => {
    try {
        await session.leave();
        scheduler.stop();
        cancelAnimationFrame(animation);
        loop.stop();
        display();
    } catch (error) {
        STATUS.textContent = error.message;
    }
};
window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        KEYS.add(e.key);
        if (scheduler?.running) {
            loop.observeInput(performance.now());
        }
    }
});
window.addEventListener('keyup', (e) => {
    KEYS.delete(e.key);
    if (scheduler?.running) {
        loop.observeInput(performance.now());
    }
});
window.addEventListener('blur', () => loop?.releaseInput());
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        loop?.releaseInput();
    } else if (scheduler?.running) {
        loop.resetTiming();
        scheduler.rebase();
        scheduler.wake();
    }
});
window.addEventListener('pagehide', () => {
    scheduler?.stop();
    cancelAnimationFrame(animation);
    loop?.stop();
    session?.close();
});
