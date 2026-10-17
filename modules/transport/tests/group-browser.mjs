import { createNostrGroupRoom, createNostrSignaler, createWebRTCPeer } from '../../../dist/transport.js';
import { createSession, profiles } from '../../../dist/rollback.js';
import { createLoop } from '../../../dist/simloop.js';
import { playReplay } from '../../../dist/replay.js';
const DOLLAR = (id) => document.getElementById(id),
    SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
class LocalRelay extends EventTarget {
    static sockets = new Set();
    constructor() {
        super();
        this.readyState = 0;
        this.filter = null;
        LocalRelay.sockets.add(this);
        queueMicrotask(() => {
            if (this.readyState !== 0) {
                return;
            }
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
        });
    }
    deliver(value) {
        if (this.readyState === 1) {
            this.dispatchEvent(
                new MessageEvent('message', {
                    data: JSON.stringify(value),
                }),
            );
        }
    }
    send(text) {
        const [TYPE, ...ARGS] = JSON.parse(text);
        if (TYPE === 'REQ') {
            this.subscription = ARGS[0];
            this.filter = ARGS[1];
            queueMicrotask(() => this.deliver(['EOSE', this.subscription]));
        }
        if (TYPE === 'EVENT') {
            const EVENT = ARGS[0];
            queueMicrotask(() => {
                this.deliver(['OK', EVENT.id, true, '']);
                for (const SOCKET of LocalRelay.sockets) {
                    if (SOCKET.filter?.['#d']?.includes(EVENT.tags.find((t) => t[0] === 'd')?.[1])) {
                        SOCKET.deliver(['EVENT', SOCKET.subscription, EVENT]);
                    }
                }
            });
        }
    }
    close() {
        if (this.readyState === 3) {
            return;
        }
        this.readyState = 3;
        LocalRelay.sockets.delete(this);
        this.dispatchEvent(new Event('close'));
    }
}
let active;
let rows = [];
function adapter(n) {
    let state = new Int32Array(4200);
    let faultTick = -1;
    return {
        adapter: {
            save: () => new Uint8Array(state.buffer.slice(0)),
            load: (b) => {
                state = new Int32Array(b.slice().buffer);
            },
            validateSnapshot: (b, { tick }) =>
                b.length === 16800 && new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(0, true) === tick,
            step({ tick, inputs }) {
                if (state[0] !== tick) {
                    throw Error('adapter tick');
                }
                if (tick === faultTick) {
                    state[1] += 999;
                }
                state[0]++;
                inputs.forEach((p, i) => {
                    state[i + 1] += p.input[0];
                    state[n + 1] += p.commands.length;
                });
            },
        },
        corrupt() {
            faultTick = state[0] + 10;
        },
        state: () => state,
    };
}
async function scenario(playerCount, topology, signal, publicRelay = false) {
    let now = 0;
    let rooms = [];
    let sessions = [];
    let loops = [];
    let corrupted = false;
    let packetCounter = 0;
    const EVENTS = [];
    const STARTED = performance.now(),
        TIMERS = new Set(),
        ACTORS = Array.from(
            {
                length: playerCount,
            },
            () => adapter(playerCount),
        );
    const ROOM = String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
        NAMESPACE = 'netcode-check-' + crypto.randomUUID();
    const PEER_FACTORY = async (options) => {
        const P = await createWebRTCPeer({
                ...options,
                rtcConfig: {
                    iceServers: [],
                },
            }),
            RAW = P.transport;
        let closed = false;
        const CONTROLS = [];
        const LATER = (fn, ms) => {
            const H = setTimeout(() => {
                TIMERS.delete(H);
                fn();
            }, ms);
            TIMERS.add(H);
        };
        const FLUSH_CONTROL = () => {
            if (closed) {
                return;
            }
            while (CONTROLS.length) {
                if (RAW.send(CONTROLS[0]) === false) {
                    if (RAW.state === 'open') {
                        LATER(FLUSH_CONTROL, 10);
                    }
                    return;
                }
                CONTROLS.shift();
            }
        };
        return {
            ...P,
            transport: {
                get state() {
                    return RAW.state;
                },
                subscribe: (fn) => RAW.subscribe(fn),
                subscribeStatus: (fn) => RAW.subscribeStatus(fn),
                send(bytes) {
                    if (closed) {
                        return false;
                    }
                    const COUNT = ++packetCounter;
                    if (bytes[5] === 2 && COUNT % 37 === 0) {
                        return true;
                    }
                    const DATA = bytes.slice();
                    // Reordering applies only to unordered input/clock. Control remains reliable and ordered.
                    if (![2, 3].includes(bytes[5])) {
                        const WAS_EMPTY = CONTROLS.length === 0;
                        CONTROLS.push(DATA);
                        if (WAS_EMPTY) {
                            LATER(FLUSH_CONTROL, 30);
                        }
                        return true;
                    }
                    const ATTEMPT = () => {
                        if (closed) {
                            return;
                        }
                        if (RAW.send(DATA) === false && RAW.state === 'open') {
                            const H = setTimeout(() => {
                                TIMERS.delete(H);
                                ATTEMPT();
                            }, 10);
                            TIMERS.add(H);
                        }
                    };
                    const H = setTimeout(
                        () => {
                            TIMERS.delete(H);
                            ATTEMPT();
                        },
                        15 + ((COUNT * 13) % 30),
                    );
                    TIMERS.add(H);
                    return true;
                },
                close() {},
            },
            close() {
                closed = true;
                P.close();
            },
        };
    };
    try {
        const RESULTS = await Promise.allSettled(
            Array.from(
                {
                    length: playerCount,
                },
                (_, i) =>
                    createNostrGroupRoom({
                        role: i ? 'join' : 'host',
                        room: ROOM,
                        namespace: NAMESPACE,
                        playerCount,
                        topology,
                        timeoutMs: 90000,
                        signal,
                        peerFactory: PEER_FACTORY,
                        signalerFactory: publicRelay
                            ? createNostrSignaler
                            : (options) =>
                                  createNostrSignaler({
                                      ...options,
                                      relays: ['wss://test.invalid'],
                                      WebSocketImpl: LocalRelay,
                                      publishIntervalMs: 0,
                                  }),
                        onStatus: (e) => {
                            if (e.type === 'group-failed') {
                                DOLLAR('status').textContent = e.reason;
                            } else if (e.type.startsWith('group-')) {
                                DOLLAR('status').textContent = `${playerCount}인 ${topology} · ${e.type}`;
                            }
                        },
                    }),
            ),
        );
        rooms = RESULTS.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const FAILURE = RESULTS.find((r) => r.status === 'rejected');
        if (FAILURE) {
            throw FAILURE.reason;
        }
        const CONNECTIONS = rooms.reduce((sum, r) => sum + r.peerConnections.size, 0),
            EXPECTED = topology === 'mesh' ? playerCount * (playerCount - 1) : 2 * (playerCount - 1);
        if (CONNECTIONS !== EXPECTED) {
            throw Error('physical topology mismatch');
        }
        sessions = rooms.map((r, i) =>
            createSession({
                players: [...r.players],
                localPlayerId: r.localPlayerId,
                authorityPlayerId: r.authorityPlayerId,
                sessionId: r.sessionId,
                simulationVersion: 'group-browser-v1',
                inputSize: 1,
                adapter: ACTORS[i].adapter,
                clock: () => now,
                onEvent: (e) => {
                    if (
                        [
                            'protocol-error',
                            'recovery-rejected',
                            'recovery-timeout',
                            'desync',
                            'input-history-mismatch',
                            'recovered',
                            'desync-unrecoverable',
                        ].includes(e.type)
                    ) {
                        EVENTS.push({
                            i,
                            ...e,
                            error: e.error?.message,
                        });
                        if (EVENTS.length > 80) {
                            EVENTS.shift();
                        }
                    }
                },
                profile: {
                    ...profiles.action,
                    adaptiveInputDelay: false,
                    pacingPolicy: 'none',
                    checksumInterval: 10,
                    stateHistorySize: 96,
                },
            }),
        );
        sessions.forEach((s, i) => {
            for (const [ID, T] of rooms[i].transports) {
                s.attachTransport(ID, T);
            }
            s.queueCommand(new Uint8Array([i + 1]));
        });
        loops = sessions.map((s, i) =>
            createLoop({
                session: s,
                canAdvance: () => s.tick < 240,
                getInput: () => new Uint8Array([(Math.floor(s.tick / 11) + i) % 8]),
            }),
        );
        let maxWorkMs = 0;
        for (let frame = 0; frame < 4000; frame++) {
            if (signal.aborted) {
                throw Error('cancelled');
            }
            now = performance.now();
            if (!corrupted && sessions.every((s) => s.tick >= 70)) {
                ACTORS[1].corrupt();
                corrupted = true;
            }
            const BEFORE = performance.now();
            loops.forEach((loop) => loop.pulse(now));
            maxWorkMs = Math.max(maxWorkMs, performance.now() - BEFORE);
            if (sessions.some((s) => s.status === 'failed')) {
                throw Error(
                    'Core failed: ' +
                        JSON.stringify({
                            failures: sessions.map((s) => s.failure),
                            events: EVENTS,
                            ticks: sessions.map((s) => s.tick),
                        }),
                );
            }
            if (sessions.every((s) => s.tick === 240 && s.confirmedTick >= 239 && !s.resimulating)) {
                break;
            }
            if (frame % 60 === 0) {
                DOLLAR('status').textContent =
                    `${playerCount}인 ${topology} · ticks ${sessions.map((s) => s.tick).join('/')}`;
            }
            await SLEEP(8);
        }
        if (!sessions.every((s) => s.tick === 240 && s.confirmedTick >= 239)) {
            throw Error('convergence timeout');
        }
        const HASHES = sessions.map((s) => s.getStateHash());
        if (new Set(HASHES).size !== 1) {
            throw Error('final state mismatch');
        }
        const RECOVERIES = sessions.reduce((n, s) => n + s.metrics.recoveries, 0),
            ROLLBACKS = sessions.reduce((n, s) => n + s.metrics.rollbacks, 0);
        if (!corrupted || !RECOVERIES || !ROLLBACKS) {
            throw Error(
                'rollback/recovery scenario not exercised: ' +
                    JSON.stringify({
                        corrupted,
                        recoveries: RECOVERIES,
                        rollbacks: ROLLBACKS,
                    }),
            );
        }
        if (ACTORS.some((a) => a.state()[playerCount + 1] !== playerCount)) {
            throw Error('command duplicated/lost');
        }
        const REPLAY = sessions[0].exportReplay(),
            RESTORED = playReplay({
                adapter: adapter(playerCount).adapter,
                replay: REPLAY,
            });
        if (RESTORED.hash !== REPLAY.hash) {
            throw Error('replay mismatch');
        }
        let bytesSent = 0;
        for (const R of rooms) {
            for (const PC of R.peerConnections.values()) {
                const STATS = await PC.getStats();
                STATS.forEach((row) => {
                    if (row.type === 'data-channel') {
                        bytesSent += row.bytesSent || 0;
                    }
                });
            }
        }
        if (!bytesSent) {
            throw Error('no real RTC traffic');
        }
        return {
            playerCount,
            topology,
            signaling: publicRelay ? 'public Nostr relays' : 'local signed relay fixture',
            status: 'PASS',
            physicalConnections: CONNECTIONS / 2,
            tick: 240,
            hash: HASHES[0],
            rollbacks: ROLLBACKS,
            recoveries: RECOVERIES,
            bytesSent,
            largestWorkMs: +maxWorkMs.toFixed(2),
            elapsedMs: Math.round(performance.now() - STARTED),
        };
    } finally {
        loops.forEach((l) => l.stop());
        sessions.forEach((s) => s.close());
        rooms.forEach((r) => r.close());
        TIMERS.forEach(clearTimeout);
        TIMERS.clear();
    }
}
async function run(all) {
    if (active) {
        return;
    }
    active = new AbortController();
    DOLLAR('run').disabled = DOLLAR('all').disabled = true;
    rows = [];
    try {
        const CASES = all
            ? ['mesh', 'star'].flatMap((t) => [2, 3, 4, 8].map((n) => [n, t]))
            : [[Number(DOLLAR('count').value), DOLLAR('topology').value]];
        for (const [N, T] of CASES) {
            const ROW = await scenario(N, T, active.signal, DOLLAR('public-relay').checked);
            rows.push(ROW);
            DOLLAR('result').textContent = JSON.stringify(rows, null, 2);
            await SLEEP(100);
        }
        DOLLAR('status').textContent = '전체 선택 검사 통과';
    } catch (e) {
        DOLLAR('status').textContent = '실패: ' + e.message;
        DOLLAR('result').textContent = JSON.stringify(rows, null, 2) + '\n' + e.stack;
    } finally {
        active.abort();
        active = null;
        DOLLAR('run').disabled = DOLLAR('all').disabled = false;
    }
}
DOLLAR('run').onclick = () => run(false);
DOLLAR('all').onclick = () => run(true);
DOLLAR('cancel').onclick = () => active?.abort();
