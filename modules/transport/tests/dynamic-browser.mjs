import { PresentationEventQueue } from '../../../dist/presentation-events.js';
import {
    createNostrDynamicRoom,
    createNostrPublicRoom,
    createNostrSignaler,
    createWebRTCPeer,
} from '../../../dist/transport.js';
import { localStorageAdapter as LOCAL_STORAGE_ADAPTER, memoryAdapter as MEMORY_ADAPTER } from '../../../dist/save.js';
import { createRoomSession, profiles } from '../../../dist/rollback.js';
import { createValueCodec } from '../../../dist/deterministic.js';
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class LocalRelay extends EventTarget {
    static sockets = new Set();
    constructor() {
        super();
        this.readyState = 0;
        LocalRelay.sockets.add(this);
        queueMicrotask(() => {
            if (this.readyState === 0) {
                this.readyState = 1;
                this.dispatchEvent(new Event('open'));
            }
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
function assert(value, message) {
    if (!value) {
        throw new Error(message);
    }
}
function actor(prepared = false, available = false, assignments = new Map()) {
    const CODEC = createValueCodec();
    let state = {
        tick: 0,
        epoch: -1,
        players: [],
        value: 0,
        commands: [],
        joins: 0,
        leaves: 0,
        padding: new Uint8Array(32768),
    };
    let saves = 0;
    let journal;
    let rollingBack = false;
    let presentationFailure = null;
    const PLAYED = new Set();
    const RESET_JOURNAL = () => {
        journal?.dispose();
        rollingBack = false;
        journal = new PresentationEventQueue({
            adapters: {
                command: {
                    start(event) {
                        const ID = event.entityId + ':' + event.sequence;
                        assert(!PLAYED.has(ID), 'duplicate confirmed presentation ' + ID);
                        PLAYED.add(ID);
                    },
                },
            },
        });
    };
    RESET_JOURNAL();
    const ACTOR = {
        state: () => state,
        event(e, playerId) {
            try {
                if (e.type === 'input-submitted') {
                    for (const C of e.commands ?? []) {
                        const KEY = playerId + ':' + C.sequence;
                        assert(
                            !assignments.has(KEY) || assignments.get(KEY) === C.executeTick,
                            'reservation changed execution tick',
                        );
                        assignments.set(KEY, C.executeTick);
                    }
                }
                if (e.type === 'rollback') {
                    assert(e.from >= 0 && e.from <= e.target, 'global rollback range'); // Membership restores a canonical boundary and resets the journal at commit; only discard its speculative tail.
                    const FROM = e.reason === 'membership' ? Math.max(e.from, journal.confirmedTick + 1) : e.from;
                    journal.beginRollback(FROM);
                    rollingBack = true;
                }
                if (e.type === 'reconciled' && rollingBack) {
                    journal.endRollback();
                    rollingBack = false;
                }
                if (e.type === 'membership-committed') {
                    RESET_JOURNAL();
                }
            } catch (error) {
                presentationFailure = error;
            }
        },
        confirm(s) {
            if (presentationFailure) {
                throw presentationFailure;
            }
            if (rollingBack) {
                journal.endRollback();
                rollingBack = false;
            }
            if (!s.resimulating && s.confirmedTick >= 0) {
                journal.confirmThrough(s.confirmedTick);
            }
        },
        dispose() {
            journal.dispose();
        },
        get presentations() {
            return PLAYED.size;
        },
        get saves() {
            return saves;
        },
        adapter: {
            save() {
                saves++;
                return CODEC.encode(state);
            },
            load: (b) => {
                state = CODEC.decode(b);
            },
            validateSnapshot: (b, { tick }) => {
                try {
                    return CODEC.decode(b).tick === tick;
                } catch {
                    return false;
                }
            },
            applyMembership({ tick, epoch, players, activePlayers, joined, left }) {
                assert(
                    state.tick === tick && (available || state.epoch + 1 === epoch),
                    'membership canonical boundary',
                );
                state.epoch = epoch;
                state.players = [...players];
                if (available) {
                    state.activePlayers = [...(activePlayers ?? players)];
                }
                state.joins += joined.length;
                state.leaves += left.length;
            },
            step({ tick, membershipEpoch, inputs, recovering }) {
                assert(tick === state.tick && membershipEpoch === state.epoch, 'global tick/epoch regression');
                assert(
                    JSON.stringify(inputs.map((i) => i.playerId)) ===
                        JSON.stringify(available ? state.activePlayers : state.players),
                    'input roster mismatch',
                );
                for (const FRAME of inputs) {
                    state.value += FRAME.input[0];
                    for (const C of FRAME.commands) {
                        assert(C.executeTick === tick, 'command execution metadata');
                        const SCHEDULED = assignments.get(FRAME.playerId + ':' + C.sequence);
                        if (SCHEDULED !== undefined) {
                            assert(SCHEDULED === tick, 'initial reservation tick changed across reconnect');
                        }
                        state.commands.push(FRAME.playerId + ':' + C.sequence + ':' + C.payload[0]);
                        if (!recovering) {
                            journal.emit({
                                tick,
                                sequence: C.sequence,
                                entityId: FRAME.playerId,
                                generation: 0,
                                kind: 'command',
                                durationMs: 0,
                            });
                        }
                    }
                }
                state.tick++;
            },
        },
    };
    if (prepared) {
        const TOKENS = new WeakMap(),
            SAME = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const TOKEN = (candidate, context) => {
            assert(
                candidate.tick === context.tick &&
                    candidate.epoch === context.membershipEpoch &&
                    SAME(candidate.players, context.players),
                'prepared context',
            );
            const KEY = {};
            TOKENS.set(KEY, {
                candidate,
                context: structuredClone(context),
            });
            return KEY;
        };
        const JOB = (work) => {
            let done = false;
            let result;
            let pulses = 0;
            return {
                get done() {
                    return done;
                },
                get result() {
                    return result;
                },
                cancel() {
                    done = true;
                },
                pulse() {
                    if (!done && ++pulses === 2) {
                        result = work();
                        done = true;
                    }
                },
            };
        };
        ACTOR.adapter.saveJob = () => JOB(() => ACTOR.adapter.save());
        ACTOR.adapter.prepareSnapshotJob = (data, context) => JOB(() => TOKEN(CODEC.decode(data), context));
        ACTOR.adapter.loadPreparedSnapshot = (key, context) => {
            const OWNED = TOKENS.get(key);
            assert(OWNED && SAME(OWNED.context, context), 'owned token binding');
            TOKENS.delete(key);
            state = OWNED.candidate;
        };
        ACTOR.adapter.prepareMembershipJob = (change, context) => {
            const ORIGINAL = state;
            return JOB(() => {
                assert(state === ORIGINAL && state.tick === change.tick, 'no live mutation during prepared job');
                const CANDIDATE = structuredClone(state);
                CANDIDATE.epoch = change.epoch;
                CANDIDATE.players = [...change.players];
                CANDIDATE.joins += change.joined.length;
                CANDIDATE.leaves += change.left.length;
                return {
                    bytes: CODEC.encode(CANDIDATE),
                    prepared: TOKEN(CANDIDATE, context),
                };
            });
        };
    }
    return ACTOR;
}
// Resume records go through the save module: an isolated adapter, a broken record, an explicit reset and a failed write.
async function resumeRecordScenario(namespace) {
    const SESSION = LOCAL_STORAGE_ADAPTER({ storage: sessionStorage }),
        KEY = namespace + ':record',
        EVENTS = [];
    const HOST = (resume) =>
        createNostrDynamicRoom({
            role: 'host',
            room: '0001',
            namespace: namespace + ':records',
            timeoutMs: 10000,
            resume,
            onStatus: (event) => EVENTS.push(event),
            signalerFactory: (opts) =>
                createNostrSignaler({
                    ...opts,
                    relays: ['wss://fixture.invalid'],
                    WebSocketImpl: LocalRelay,
                    publishIntervalMs: 0,
                }),
        });
    const SNAPSHOT = () => JSON.stringify(Object.entries(sessionStorage).sort());
    const BEFORE = SNAPSHOT();
    const ISOLATED = await HOST({ adapter: MEMORY_ADAPTER(), key: KEY });
    await SLEEP(50);
    ISOLATED.close();
    await SLEEP(50);
    assert(SNAPSHOT() === BEFORE, 'memoryAdapter resume left sessionStorage unchanged');
    sessionStorage.setItem(KEY, '{broken');
    const BROKEN = await HOST({ adapter: SESSION, key: KEY }).then(
        (room) => {
            room.close();
            return null;
        },
        (error) => error,
    );
    assert(
        BROKEN?.message === 'invalid resume record; explicitly reset for a fresh room',
        'broken resume record is an explicit error',
    );
    assert(sessionStorage.getItem(KEY) === '{broken', 'broken resume record is preserved');
    const FRESH = await HOST({ adapter: SESSION, key: KEY, reset: true });
    await SLEEP(50);
    const STORED = JSON.parse(sessionStorage.getItem(KEY));
    assert(
        STORED.identity.id === FRESH.localPlayerId && STORED.identity.sessionId === FRESH.sessionId,
        'reset starts a fresh stored identity',
    );
    let failing = false;
    const FLAKY = {
        channelName: null,
        transact: (key, body) =>
            failing ? Promise.reject(new Error('resume write fixture failure')) : SESSION.transact(key, body),
    };
    const FAILING = await HOST({ adapter: FLAKY, key: KEY + ':failing' });
    await SLEEP(50);
    failing = true;
    FAILING.setRoster({
        epoch: FAILING.epoch + 1,
        players: [...FAILING.players],
        coordinatorId: FAILING.coordinatorId,
    });
    await SLEEP(50);
    const FAILURE = EVENTS.find((event) => event.type === 'resume-save-failed');
    assert(
        FAILURE?.record === 'identity' && FAILURE.reason === 'resume write fixture failure',
        'failed resume write reaches onStatus',
    );
    FRESH.close();
    FAILING.close();
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY + ':failing');
    return { isolatedUnchanged: true, brokenRejected: true, resetFresh: true, writeFailure: FAILURE.type };
}
export async function runDynamicRoomScenario({
    prepared = false,
    paced = false,
    available = false,
    simulationMode = 'lockstep',
} = {}) {
    const ASSIGNMENTS = new Map(),
        SESSIONS = [],
        ROOMS = [],
        ACTORS = [],
        EVENTS = [],
        SAMPLES = [],
        INTERRUPTED = new Set();
    let timer;
    let target = Infinity;
    let failure = null;
    let maxPulseMs = 0;
    let maxCatchupPerPulse = 0;
    let handoffCommands = 0;
    const RESUME_ADAPTER = LOCAL_STORAGE_ADAPTER({ storage: sessionStorage }),
        NAMESPACE = 'dynamic-e2e-' + crypto.randomUUID(),
        ROOM_CODE = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const OPTIONS = {
        room: ROOM_CODE,
        namespace: NAMESPACE,
        timeoutMs: 60000,
        peerTimeoutMs: 20000,
        retryMs: paced ? 1500 : 100,
        advertiseIntervalMs: paced ? 5000 : 1000,
        rtcConfig: {
            iceServers: [],
        },
        signalerFactory: (opts) =>
            createNostrSignaler({
                ...opts,
                relays: ['wss://fixture.invalid'],
                WebSocketImpl: LocalRelay,
                publishIntervalMs: paced ? 500 : 0,
            }),
        peerFactory: (opts) =>
            createWebRTCPeer({
                ...opts,
                rtcConfig: {
                    iceServers: [],
                },
            }),
    };
    const PROFILE = {
        ...(simulationMode === 'rollback' ? profiles.action : profiles.lockstep),
        baseInputDelayTicks: 2,
        pacingPolicy: 'none',
        checksumInterval: 20,
        stateHistorySize: 96,
        heartbeatMs: 30,
        peerInterruptMs: 500,
        peerTimeoutMs: 8000,
    };
    async function add(_role, slot = ROOMS.length) {
        const ROOM = await createNostrPublicRoom({
            ...OPTIONS,
            simulationVersion: 'dynamic-browser-v1',
            discoveryMs: paced ? 1500 : 150,
            totalTimeoutMs: 60000,
            leaseMs: paced ? 15000 : 1500,
            reservationMs: 30000,
            resume: {
                adapter: RESUME_ADAPTER,
                key: NAMESPACE + ':actor:' + slot,
                lifetimeMs: 600000,
            },
        });
        ROOMS.push(ROOM);
        const A = actor(prepared, available, ASSIGNMENTS);
        ACTORS.push(A);
        const S = createRoomSession({
            mode: 'online',
            room: ROOM,
            adapter: A.adapter,
            inputSize: 1,
            simulationVersion: 'dynamic-browser-v1',
            profile: PROFILE,
            ...(available
                ? {
                      availability: {
                          mode: 'available',
                          heartbeatMs: 100,
                          silenceMs: 1600,
                          inputGraceMs: 1600,
                          resumeGapMs: 1600,
                          roundTimeoutMs: 5000,
                      },
                  }
                : {}),
            membership: {
                transitionTimeoutMs: 60000,
                reconnectGraceMs: 30000,
                maxCatchupSteps: 2,
            },
            onEvent: (e) => {
                A.event(e, ROOM.localPlayerId);
                if (['membership-committed', 'membership-failed', 'partition-failed'].includes(e.type)) {
                    EVENTS.push(e);
                }
            },
        });
        SESSIONS.push(S);
        return S;
    }
    function pulse() {
        const START = performance.now();
        try {
            for (const [INDEX, S] of SESSIONS.entries()) {
                if (!S.closed && !INTERRUPTED.has(S)) {
                    const BEFORE = S.metrics.bootstrapTicks;
                    S.poll();
                    maxCatchupPerPulse = Math.max(maxCatchupPerPulse, S.metrics.bootstrapTicks - BEFORE);
                    if (!S.closed && S.tick < target && !S.resimulating) {
                        S.advance(new Uint8Array([1]));
                    }
                    ACTORS[INDEX].confirm(S);
                    if (S.failure) {
                        throw new Error(
                            JSON.stringify({
                                player: S.localPlayerId,
                                failure: S.failure,
                            }),
                        );
                    }
                }
            }
        } catch (error) {
            failure = error;
        }
        maxPulseMs = Math.max(maxPulseMs, performance.now() - START);
    }
    async function until(predicate, label, timeoutMs = 65000) {
        const END = performance.now() + timeoutMs;
        while (!predicate()) {
            if (failure) {
                throw failure;
            }
            if (performance.now() > END) {
                throw new Error(
                    label +
                        ' timeout ' +
                        JSON.stringify(
                            SESSIONS.map((s) => ({
                                tick: s.tick,
                                epoch: s.epoch,
                                status: s.status,
                                transition: s._transition && {
                                    target: s._transition.target,
                                    prepared: s._transition.prepared.size,
                                    reached: s._transition.reached.size,
                                    installed: s._transition.installed.size,
                                    committed: s._transition.committed.size,
                                },
                            })),
                        ),
                );
            }
            await SLEEP(10);
        }
    }
    async function checkpoint(label) {
        const ACTIVE = SESSIONS.filter((s) => !s.closed);
        target = Math.max(...ACTIVE.map((s) => s.tick));
        await until(
            () => ACTIVE.every((s) => s.tick === target && s.confirmedTick + 1 >= target && !s.resimulating),
            'checkpoint ' + label,
        );
        const HASHES = ACTIVE.map((s) => s.getStateHash());
        assert(new Set(HASHES).size === 1, 'hash mismatch ' + label);
        SAMPLES.push({
            label,
            tick: target,
            hash: HASHES[0],
            players: ACTIVE.length,
        });
        target = Infinity;
    }
    try {
        const RESUME_RECORDS =
            !available && !prepared && !paced && simulationMode === 'lockstep'
                ? await resumeRecordScenario(NAMESPACE)
                : null;
        let host = await add('host');
        timer = setInterval(pulse, 8);
        await until(() => host.tick >= 75, 'single start');
        for (let i = 1; i < 5; i++) {
            host.queueCommand(new Uint8Array([i]));
            const JOINED = await add('join');
            await until(
                () => JOINED.ready && host.players.length === i + 1 && !host._transition,
                'sequential join ' + (i + 1),
            );
            await until(() => SESSIONS.every((s) => s.tick >= host.baseTick + 25), 'post admission advance');
            await checkpoint('players-' + (i + 1));
            if (i === 1 && simulationMode === 'rollback' && !available) {
                INTERRUPTED.add(SESSIONS[1]);
                host.queueCommand(new Uint8Array([99]));
                await until(
                    () => ACTORS[0].state().commands.some((c) => c.endsWith(':99')),
                    'predicted command before reconnect',
                );
                assert(host.confirmedTick + 1 < host.tick, 'handoff actually has an unconfirmed tail');
                const RECONNECT = ROOMS[0].reconnect(ROOMS[1].localPlayerId);
                INTERRUPTED.clear();
                await RECONNECT;
                await until(() => SESSIONS.every((s) => s.ready), 'predicted command reconnect');
                await checkpoint('predicted-command-handoff');
                assert(
                    ACTORS.every((a) => a.state().commands.filter((c) => c.endsWith(':99')).length === 1),
                    'predicted command lost or duplicated',
                );
                handoffCommands++;
            }
        }
        assert(
            ACTORS.every((a) => a.state().commands.length === 4 + handoffCommands),
            'pending commands duplicated or lost',
        );
        assert(maxCatchupPerPulse <= 2, 'bootstrap work exceeded per-pulse bound');
        if (available) {
            INTERRUPTED.add(SESSIONS[2]);
            let prior = host.tick;
            await until(
                () =>
                    SESSIONS.filter((s) => !INTERRUPTED.has(s)).every(
                        (s) => s.tick > prior + 15 && s.activePlayers.length === 4,
                    ),
                'inactive dynamic guest',
            );
            await ROOMS[0].reconnect(ROOMS[2].localPlayerId);
            INTERRUPTED.clear();
            await until(() => SESSIONS.every((s) => s.ready && s.activePlayers.length === 5), 'dynamic guest return');
            await checkpoint('available-guest-return');
            INTERRUPTED.add(host);
            prior = SESSIONS[1].tick;
            await until(
                () =>
                    SESSIONS.filter((s) => s !== host).every(
                        (s) => s.tick > prior + 15 && s.coordinatorId !== host.localPlayerId,
                    ),
                'inactive dynamic coordinator',
            );
            await ROOMS[1].reconnect(host.localPlayerId);
            INTERRUPTED.clear();
            await until(
                () => SESSIONS.every((s) => s.ready && s.activePlayers.length === 5),
                'dynamic coordinator return',
            );
            await checkpoint('available-coordinator-return');
            let bytesSent = 0;
            let connections = 0;
            for (const ROOM of ROOMS) {
                for (const PC of ROOM.peerConnections.values()) {
                    connections++;
                    (await PC.getStats()).forEach((row) => {
                        if (row.type === 'data-channel') {
                            bytesSent += row.bytesSent || 0;
                        }
                    });
                }
            }
            assert(connections === 20 && bytesSent > 0, 'available dynamic real RTC');
            return {
                passed: true,
                reservedCommands: [...ASSIGNMENTS],
                policy: 'available',
                transport:
                    'actual createNostrPublicRoom/dynamic room and Chromium RTC; signed local relay fixture; session pump stop injected',
                samples: SAMPLES,
                connections: connections / 2,
                bytesSent,
                maxPulseMs,
                maxCatchupPerPulse,
                events: EVENTS,
            };
        }
        await ROOMS[0].reconnect(ROOMS[2].localPlayerId);
        await until(() => SESSIONS.every((s) => s.ready), 'retained identity reconnect');
        await checkpoint('reconnect');
        const OLD_GUEST = SESSIONS[2],
            GUEST_ID = OLD_GUEST.localPlayerId;
        OLD_GUEST.queueCommand(new Uint8Array([9]));
        await until(() => ACTORS[0].state().commands.length === 5 + handoffCommands, 'pre-refresh command');
        OLD_GUEST.close();
        const RESUMED_GUEST = await add('join', 2);
        assert(RESUMED_GUEST.localPlayerId === GUEST_ID, 'refresh identity changed');
        await until(() => RESUMED_GUEST.ready && !host._transition, 'guest refresh admission');
        RESUMED_GUEST.queueCommand(new Uint8Array([8]));
        await until(() => ACTORS[0].state().commands.length === 6 + handoffCommands, 'post-refresh command');
        await checkpoint('guest-refresh');
        let gracefulGuestReentry = null;
        if (!available && !prepared && !paced && simulationMode === 'lockstep') {
            const PRE_LEAVE_SESSIONS = SESSIONS.filter((s) => !s.closed);
            assert(PRE_LEAVE_SESSIONS.length === 5, 'guest leave starts at full room capacity');
            RESUMED_GUEST._startedAt = RESUMED_GUEST.clock() - RESUMED_GUEST.membership.transitionTimeoutMs - 1;
            const ORIGINAL_SEND = RESUMED_GUEST._send.bind(RESUMED_GUEST);
            let duplicatedCommitAck = false;
            RESUMED_GUEST._send = (to, op, detail = {}) => {
                ORIGINAL_SEND(to, op, detail);
                if (op === 'committed' && !duplicatedCommitAck) {
                    duplicatedCommitAck = true;
                    ORIGINAL_SEND(to, op, detail);
                }
            };
            const DEPARTURE = RESUMED_GUEST.leave();
            const DEPARTURE_RESULT = DEPARTURE.then(
                () => ({ resolved: true }),
                (error) => ({ error }),
            );
            assert(RESUMED_GUEST.leave() === DEPARTURE, 'duplicate leave calls share one operation');
            try {
                await until(
                    () =>
                        RESUMED_GUEST.closed &&
                        host.players.length === 4 &&
                        SESSIONS.filter((s) => !s.closed).every((s) => s.players.length === 4),
                    'graceful guest leave',
                );
                const DEPARTURE_OUTCOME = await DEPARTURE_RESULT;
                assert(DEPARTURE_OUTCOME.resolved, 'graceful guest leave promise resolved');
                assert(duplicatedCommitAck, 'departure sent a duplicate committed acknowledgement');
                assert(
                    EVENTS.filter((e) => e.reason === 'leave').length === PRE_LEAVE_SESSIONS.length,
                    'duplicate leave acknowledgement committed exactly once per participant',
                );
                assert(
                    [...SESSIONS.filter((s) => !s.closed), RESUMED_GUEST].every(
                        (s) => ACTORS[SESSIONS.indexOf(s)].state().leaves === 1,
                    ),
                    'host and guests apply the graceful leave exactly once',
                );
                await checkpoint('graceful-guest-left');
                const REENTRY = await add('join', 5);
                assert(
                    REENTRY.localPlayerId !== RESUMED_GUEST.localPlayerId,
                    'same-room re-entry uses a fresh identity',
                );
                await until(
                    () =>
                        REENTRY.ready &&
                        host.players.length === 5 &&
                        SESSIONS.filter((s) => !s.closed).every((s) => s.ready && s.players.length === 5),
                    'same-room guest re-entry',
                );
                await checkpoint('graceful-guest-rejoined');
                assert(
                    ACTORS[0].state().joins === 6 && ACTORS[0].state().leaves === 1,
                    're-entry updates host roster once',
                );
                gracefulGuestReentry = {
                    duplicateLeaveCalls: 2,
                    duplicateCommitAcknowledgements: 2,
                    playersAfterLeave: 4,
                    playersAfterReentry: 5,
                };
            } finally {
                RESUMED_GUEST._send = ORIGINAL_SEND;
            }
        }
        const OLD_HOST_ID = host.localPlayerId;
        host.close();
        host = await add('host', 0);
        assert(host.localPlayerId === OLD_HOST_ID, 'coordinator refresh identity changed');
        await until(() => host.ready && SESSIONS.filter((s) => !s.closed).every((s) => s.ready), 'coordinator refresh');
        await checkpoint('coordinator-refresh');
        // Collect physical RTC traffic while all ten mesh edges still exist.
        let bytesSent = 0;
        let connections = 0;
        for (const ROOM of ROOMS.filter((r) => !r.closed)) {
            for (const PC of ROOM.peerConnections.values()) {
                connections++;
                const STATS = await PC.getStats();
                STATS.forEach((row) => {
                    if (row.type === 'data-channel') {
                        bytesSent += row.bytesSent || 0;
                    }
                });
            }
        }
        assert(connections === 20 && bytesSent > 0, 'five-player real RTC mesh evidence');
        const DEPARTING = host.leave();
        await until(
            () =>
                host.closed &&
                SESSIONS.filter((s) => !s.closed).every(
                    (s) => s.players.length === 4 && s.coordinatorId !== host.localPlayerId,
                ),
            'coordinator succession',
        );
        await DEPARTING;
        const PRIOR = Math.max(...SESSIONS.filter((s) => !s.closed).map((s) => s.tick));
        await until(() => SESSIONS.filter((s) => !s.closed).every((s) => s.tick >= PRIOR + 25), 'successor simulation');
        await checkpoint('coordinator-left');
        const EXPECTED_JOINS = gracefulGuestReentry ? 6 : 5;
        const EXPECTED_LEAVES = gracefulGuestReentry ? 2 : 1;
        assert(
            ACTORS.filter((_a, i) => !SESSIONS[i].closed).every(
                (a) => a.state().joins === EXPECTED_JOINS && a.state().leaves === EXPECTED_LEAVES,
            ),
            'membership exactly-once',
        );
        return {
            passed: true,
            reservedCommands: [...ASSIGNMENTS],
            publishIntervalMs: paced ? 500 : 0,
            snapshotPath: prepared ? 'cooperative fixture' : 'legacy',
            transport:
                'real Chromium RTCPeerConnections; public directory/reservations via signed local Nostr relay fixture',
            samples: SAMPLES,
            connections: connections / 2,
            bytesSent,
            maxPulseMs,
            maxCatchupPerPulse,
            metrics: SESSIONS.map((s) => s.metrics),
            snapshotSaves: ACTORS.map((a) => a.saves),
            confirmedPresentations: ACTORS.map((a) => a.presentations),
            gracefulGuestReentry,
            resumeRecords: RESUME_RECORDS,
            events: EVENTS,
        };
    } finally {
        clearInterval(timer);
        SESSIONS.forEach((s) => s.close());
        ROOMS.forEach((r) => r.close());
        ACTORS.forEach((a) => a.dispose());
    }
}
