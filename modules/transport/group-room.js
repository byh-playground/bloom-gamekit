import { PROTOCOL_VERSION, encoder } from '../_rollback-shared/protocol.js';
import { compareIds, integer, nowMs } from '../deterministic/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createWebRTCPeer } from './webrtc.js';
import { createStarTransports } from './star-transport.js';
function groupRoomId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
/** Fixed-roster 2..8-player room. Topology changes transports, never the simulation Core. */
export async function createNostrGroupRoom({
    role,
    room,
    playerCount = 2,
    topology = 'mesh',
    namespace = 'rollback-netcode',
    relays,
    rtcConfig,
    timeoutMs = 60000,
    onStatus = () => {},
    signal,
    signalerFactory = createNostrSignaler,
    peerFactory = createWebRTCPeer,
} = {}) {
    if (!['host', 'join'].includes(role) || !['mesh', 'star'].includes(topology)) {
        throw new TypeError('group room role/topology');
    }
    integer(playerCount, 'playerCount', 2, 8);
    integer(timeoutMs, 'timeoutMs', 1, 120000);
    if (
        typeof namespace !== 'string' ||
        !namespace.trim() ||
        new TextEncoder().encode(namespace + ':group-v1').length > 128
    ) {
        throw new TypeError('group namespace');
    }
    if ([onStatus, signalerFactory, peerFactory].some((fn) => typeof fn !== 'function')) {
        throw new TypeError('group room capability');
    }
    if (signal?.aborted) {
        throw new Error('group room aborted');
    }
    const RANDOM = () =>
        [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (!room && role === 'host') {
        room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
    }
    if (!/^\d{4}$/.test(room ?? '')) {
        throw new TypeError('four-digit room');
    }
    const PEER_CONTROLLER = new AbortController(),
        SIGNAL_CONTROLLER = new AbortController(),
        STARTED_AT = nowMs();
    const EARLY_ABORT = () => {
        PEER_CONTROLLER.abort();
        SIGNAL_CONTROLLER.abort();
    };
    signal?.addEventListener('abort', EARLY_ABORT, {
        once: true,
    });
    let signaler;
    try {
        signaler = await signalerFactory({
            room,
            namespace: namespace + ':group-v1',
            relays,
            signal: SIGNAL_CONTROLLER.signal,
            timeoutMs: Math.min(timeoutMs, 10000),
            onStatus,
            maxVerificationsPerSecond: Math.max(16, playerCount * 4),
            verificationBurst: playerCount * 4,
        });
        if (
            !groupRoomId(signaler?.id) ||
            typeof signaler.send !== 'function' ||
            typeof signaler.subscribe !== 'function' ||
            typeof signaler.close !== 'function'
        ) {
            throw new TypeError('group signaler capability');
        }
        if (signal?.aborted || SIGNAL_CONTROLLER.signal.aborted) {
            throw new Error('group room aborted');
        }
    } catch (error) {
        EARLY_ABORT();
        signaler?.close?.();
        signal?.removeEventListener('abort', EARLY_ABORT);
        throw error;
    }
    signal?.removeEventListener('abort', EARLY_ABORT);
    return new Promise((resolve, reject) => {
        const SELF = signaler.id,
            MEMBERS = new Set([SELF]),
            DEPARTED = new Set(),
            ACKS = new Set([SELF]),
            READY = new Set(),
            STARTS = new Set([SELF]);
        const PEERS = new Map(),
            SUBSCRIBERS = new Map(),
            BACKLOG = new Map(),
            CONTROL_PENDING = new Map(),
            REMOVERS = [];
        let host = role === 'host' ? SELF : null;
        let sessionId = role === 'host' ? RANDOM() : null;
        let roster = null;
        let rosterKey = '';
        let phase = role === 'host' ? 'checking' : 'discovering';
        let disposed = false;
        let settled = false;
        let connecting = false;
        let localReady = false;
        let unsubscribe;
        let interval;
        let collisionTimer;
        let deadline;
        let router;
        let backlogBytes = 0;
        let startPublished = false;
        const STATUS = (type, detail = {}) => {
            try {
                onStatus({
                    type,
                    room,
                    role,
                    playerCount,
                    topology,
                    phase,
                    ...detail,
                });
            } catch {
                // Status observers must not interrupt connection setup or cleanup.
            }
        };
        function message(op, extra = {}) {
            return {
                type: 'group',
                version: 1,
                protocol: PROTOCOL_VERSION,
                op,
                host,
                sessionId,
                playerCount,
                topology,
                ...extra,
            };
        }
        function dispose(reason, notify = true) {
            if (disposed) {
                return;
            }
            disposed = true;
            clearInterval(interval);
            clearTimeout(collisionTimer);
            clearTimeout(deadline);
            unsubscribe?.();
            signal?.removeEventListener('abort', abort);
            PEER_CONTROLLER.abort();
            REMOVERS.splice(0).forEach((fn) => fn());
            router?.close();
            PEERS.forEach((p) => p.close());
            PEERS.clear();
            SUBSCRIBERS.clear();
            BACKLOG.clear();
            backlogBytes = 0;
            // Give a departure publication a bounded grace period; RTC closes immediately.
            const FINISH = () => {
                SIGNAL_CONTROLLER.abort();
                signaler.close();
            };
            if (notify && host && sessionId) {
                const GRACE = setTimeout(FINISH, 1500);
                GRACE.unref?.();
                Promise.resolve()
                    .then(() =>
                        signaler.send(
                            role === 'host' ? '*' : host,
                            message('leave', {
                                reason,
                            }),
                        ),
                    )
                    .catch(() => {})
                    .finally(() => {
                        clearTimeout(GRACE);
                        FINISH();
                    });
            } else {
                FINISH();
            }
        }
        function fail(error, notify = true) {
            if (disposed) {
                return;
            }
            const VALUE = error instanceof Error ? error : new Error(String(error));
            const FORMER = phase;
            phase = 'failed';
            dispose(VALUE.message, notify);
            STATUS('group-failed', {
                reason: VALUE.message,
                previousPhase: FORMER,
            });
            if (!settled) {
                settled = true;
                reject(VALUE);
            }
        }
        function abort() {
            fail(new Error('group room aborted'));
        }
        function send(to, op, extra = {}) {
            if (disposed) {
                return Promise.resolve();
            }
            const KEY = to + ':' + op;
            if (CONTROL_PENDING.has(KEY)) {
                return CONTROL_PENDING.get(KEY);
            }
            if (CONTROL_PENDING.size >= 32) {
                return Promise.resolve();
            }
            const PENDING = Promise.resolve()
                .then(() => {
                    if (!disposed) {
                        return signaler.send(to, message(op, extra));
                    }
                })
                .catch((error) => {
                    fail(error);
                })
                .finally(() => CONTROL_PENDING.delete(KEY));
            CONTROL_PENDING.set(KEY, PENDING);
            return PENDING;
        }
        function close() {
            if (disposed) {
                return;
            }
            const PENDING = !settled;
            phase = 'closed';
            dispose('room closed');
            STATUS('group-closed');
            if (PENDING) {
                settled = true;
                reject(new Error('group room closed'));
            }
        }
        function finish() {
            if (disposed || settled || !localReady) {
                return;
            }
            settled = true;
            phase = 'running';
            clearTimeout(deadline);
            clearInterval(interval);
            const PHYSICAL = new Map([...PEERS].map(([id, peer]) => [id, peer.transport]));
            STATUS('group-started', {
                players: [...roster],
                localPlayerId: SELF,
            });
            // A status observer is allowed to close/abort before the result is exposed.
            if (disposed) {
                reject(new Error('group room closed by observer'));
                return;
            }
            resolve({
                room,
                sessionId,
                playerCount,
                topology,
                players: Object.freeze([...roster]),
                localPlayerId: SELF,
                authorityPlayerId: host,
                hostPlayerId: host,
                transports: new Map(router?.transports ?? PHYSICAL),
                peerConnections: new Map([...PEERS].map(([id, peer]) => [id, peer.peerConnection])),
                get closed() {
                    return disposed;
                },
                get metrics() {
                    return router?.metrics ?? null;
                },
                close,
            });
        }
        function hostProgress() {
            if (disposed || role !== 'host' || !roster) {
                return;
            }
            if (phase === 'roster' && ACKS.size === playerCount) {
                phase = 'connecting';
                connect();
                send('*', 'connect', {
                    rosterKey,
                });
            }
            if (phase === 'connecting' && READY.size === playerCount) {
                phase = 'starting';
                send('*', 'start', {
                    rosterKey,
                }).then(() => {
                    startPublished = true;
                    hostProgress();
                });
            }
            if (phase === 'starting' && startPublished && STARTS.size === playerCount) {
                finish();
            }
        }
        function wantedPeers() {
            return roster.filter((id) => id !== SELF && (topology === 'mesh' || SELF === host || id === host));
        }
        function scopedSignaler(remote) {
            return {
                id: SELF,
                send(to, payload) {
                    if (disposed || to !== remote) {
                        return Promise.reject(new Error('group peer scope'));
                    }
                    return signaler.send(to, {
                        ...payload,
                        groupSession: sessionId,
                    });
                },
                subscribe(fn) {
                    const SET = SUBSCRIBERS.get(remote) ?? new Set();
                    SUBSCRIBERS.set(remote, SET);
                    SET.add(fn);
                    const QUEUED = BACKLOG.get(remote) ?? [];
                    BACKLOG.delete(remote);
                    for (const ITEM of QUEUED) {
                        backlogBytes -= ITEM.size;
                        if (!disposed) {
                            fn(ITEM.envelope);
                        }
                    }
                    return () => SET.delete(fn);
                },
                close() {},
            };
        }
        function connect() {
            if (disposed || connecting || !roster) {
                return;
            }
            connecting = true;
            phase = 'connecting';
            STATUS('group-connecting', {
                players: [...roster],
            });
            if (disposed) {
                return;
            }
            Promise.all(
                wantedPeers().map((remote) =>
                    Promise.resolve()
                        .then(() => {
                            if (disposed) {
                                throw new Error('group room closed');
                            }
                            return peerFactory({
                                initiator: compareIds(SELF, remote) > 0,
                                signaler: scopedSignaler(remote),
                                remoteId: remote,
                                rtcConfig,
                                timeoutMs: Math.min(timeoutMs, 30000),
                                onStatus: (event) =>
                                    STATUS('group-peer', {
                                        peerId: remote,
                                        event,
                                    }),
                                signal: PEER_CONTROLLER.signal,
                            });
                        })
                        .then((peer) => {
                            if (disposed) {
                                peer.close();
                                return;
                            }
                            if (
                                !peer?.transport?.send ||
                                !peer.transport.subscribe ||
                                typeof peer.close !== 'function'
                            ) {
                                throw new TypeError('group peer capability');
                            }
                            PEERS.set(remote, peer);
                            if (peer.transport.subscribeStatus) {
                                REMOVERS.push(
                                    peer.transport.subscribeStatus((state) => {
                                        if (
                                            !disposed &&
                                            (state === 'closed' ||
                                                state === 'failed' ||
                                                (!settled && state === 'interrupted'))
                                        ) {
                                            fail(new Error('group peer unavailable: ' + remote));
                                        }
                                    }),
                                );
                            }
                        }),
                ),
            )
                .then(() => {
                    if (disposed) {
                        return;
                    }
                    if ([...PEERS.values()].some((p) => p.transport.state && p.transport.state !== 'open')) {
                        throw new Error('group transport not open');
                    }
                    if (topology === 'star') {
                        router = createStarTransports({
                            players: roster,
                            localPlayerId: SELF,
                            hostPlayerId: host,
                            sessionId,
                            physicalTransports: new Map([...PEERS].map(([id, p]) => [id, p.transport])),
                            onError: fail,
                        });
                    }
                    localReady = true;
                    STATUS('group-ready', {
                        players: [...roster],
                    });
                    if (disposed) {
                        return;
                    }
                    if (role === 'host') {
                        READY.add(SELF);
                        hostProgress();
                    } else {
                        send(host, 'ready', {
                            rosterKey,
                        });
                    }
                })
                .catch(fail);
        }
        function publishRoster() {
            send('*', 'roster', {
                players: roster,
                rosterKey,
            });
        }
        function advertise(to = '*') {
            send(to, 'hello', {
                accepting: phase === 'collecting',
                memberCount: MEMBERS.size,
            });
        }
        function acceptRoster(from, m) {
            if (
                from !== host ||
                !Array.isArray(m.players) ||
                m.players.length !== playerCount ||
                m.players.some((id) => !groupRoomId(id)) ||
                new Set(m.players).size !== playerCount ||
                !m.players.includes(SELF) ||
                !m.players.includes(host) ||
                m.players.join('\n') !== [...m.players].sort(compareIds).join('\n') ||
                m.rosterKey !== m.players.join('\n')
            ) {
                fail(new Error('invalid group roster'));
                return;
            }
            if (roster && rosterKey !== m.rosterKey) {
                fail(new Error('group roster changed'));
                return;
            }
            if (!roster) {
                roster = Object.freeze([...m.players]);
                rosterKey = m.rosterKey;
                phase = 'roster';
                STATUS('group-roster', {
                    players: [...roster],
                });
            }
            send(host, 'ack', {
                rosterKey,
            });
        }
        function receive(envelope) {
            if (
                disposed ||
                !envelope ||
                envelope.from === SELF ||
                !groupRoomId(envelope.from) ||
                !['*', SELF].includes(envelope.to) ||
                !envelope.message ||
                typeof envelope.message !== 'object'
            ) {
                return;
            }
            const { from: FROM, to: TO, message: M } = envelope;
            if (['offer', 'answer', 'ice', 'bye'].includes(M.type)) {
                if (!roster || TO !== SELF || M.groupSession !== sessionId || !wantedPeers().includes(FROM)) {
                    return;
                }
                const SET = SUBSCRIBERS.get(FROM);
                if (SET?.size) {
                    for (const FN of SET) {
                        FN(envelope);
                    }
                    return;
                }
                const SIZE = encoder.encode(JSON.stringify(M)).length,
                    QUEUED = BACKLOG.get(FROM) ?? [];
                if (QUEUED.length >= 32 || backlogBytes + SIZE > 2 * 1024 * 1024) {
                    fail(new Error('group signaling backlog capacity'));
                    return;
                }
                QUEUED.push({
                    envelope,
                    size: SIZE,
                });
                BACKLOG.set(FROM, QUEUED);
                backlogBytes += SIZE;
                return;
            }
            if (M.type !== 'group' || M.version !== 1 || M.protocol !== PROTOCOL_VERSION) {
                return;
            }
            if (role === 'host' && M.op === 'hello' && M.host === FROM) {
                if (['checking', 'collecting'].includes(phase)) {
                    fail(new Error('room code is already in use'));
                } else if (M.accepting !== false) {
                    advertise(FROM);
                }
                return;
            }
            if (role === 'join' && M.op === 'hello' && M.host === FROM && groupRoomId(M.sessionId)) {
                if (host && (host !== FROM || sessionId !== M.sessionId)) {
                    return;
                }
                if (M.playerCount !== playerCount || M.topology !== topology) {
                    fail(new Error('group playerCount/topology mismatch'), false);
                    return;
                }
                const SELECTED = !!host;
                if (!host) {
                    host = FROM;
                    sessionId = M.sessionId;
                }
                if (!roster) {
                    if (M.accepting === false && !SELECTED) {
                        fail(new Error('group room is full or already started'), false);
                        return;
                    }
                    send(host, 'join');
                }
                return;
            }
            if (role === 'host' && M.op === 'discover') {
                if (phase !== 'checking') {
                    advertise(FROM);
                }
                return;
            }
            if (
                M.host !== host ||
                M.sessionId !== sessionId ||
                M.playerCount !== playerCount ||
                M.topology !== topology
            ) {
                return;
            }
            if (role === 'host') {
                if (M.op === 'join') {
                    if (MEMBERS.has(FROM)) {
                        if (roster) {
                            publishRoster();
                        }
                        return;
                    }
                    if (phase !== 'collecting' || DEPARTED.has(FROM)) {
                        send(FROM, 'reject', {
                            reason: 'group room is full or already started',
                        });
                        return;
                    }
                    MEMBERS.add(FROM);
                    STATUS('group-members', {
                        players: [...MEMBERS].sort(compareIds),
                    });
                    if (disposed) {
                        return;
                    }
                    if (MEMBERS.size === playerCount) {
                        roster = Object.freeze([...MEMBERS].sort(compareIds));
                        rosterKey = roster.join('\n');
                        phase = 'roster';
                        STATUS('group-roster', {
                            players: [...roster],
                        });
                        publishRoster();
                    }
                } else if (M.op === 'leave' && MEMBERS.has(FROM)) {
                    if (phase === 'collecting') {
                        MEMBERS.delete(FROM);
                        DEPARTED.add(FROM);
                        if (DEPARTED.size > 64) {
                            fail(new Error('group membership churn limit'));
                        } else {
                            STATUS('group-members', {
                                players: [...MEMBERS].sort(compareIds),
                            });
                        }
                    } else {
                        fail(new Error('group participant left'));
                    }
                } else if (roster?.includes(FROM) && M.rosterKey === rosterKey) {
                    if (M.op === 'ack') {
                        ACKS.add(FROM);
                    }
                    if (M.op === 'ready' && ['connecting', 'starting'].includes(phase)) {
                        READY.add(FROM);
                    }
                    if (M.op === 'start-ack' && phase === 'starting') {
                        STARTS.add(FROM);
                    }
                    hostProgress();
                }
            } else if (FROM === host) {
                if (M.op === 'reject') {
                    fail(new Error(String(M.reason || 'group rejected')), false);
                } else if (M.op === 'leave') {
                    fail(new Error('group host left'), false);
                } else if (M.op === 'roster') {
                    acceptRoster(FROM, M);
                } else if (roster && M.rosterKey === rosterKey) {
                    if (M.op === 'connect') {
                        connect();
                        if (localReady) {
                            send(host, 'ready', {
                                rosterKey,
                            });
                        }
                    }
                    if (M.op === 'start' && localReady) {
                        send(host, 'start-ack', {
                            rosterKey,
                        }).then(finish);
                    }
                }
            }
        }
        signal?.addEventListener('abort', abort, {
            once: true,
        });
        if (signal?.aborted) {
            abort();
            return;
        }
        unsubscribe = signaler.subscribe(receive);
        if (disposed) {
            unsubscribe?.();
            return;
        }
        const REMAINING = timeoutMs - (nowMs() - STARTED_AT);
        if (REMAINING <= 0) {
            fail(new Error('group room timeout'));
            return;
        }
        deadline = setTimeout(() => fail(new Error('group room timeout: ' + phase)), REMAINING);
        interval = setInterval(() => {
            if (disposed) {
                return;
            }
            if (role === 'host') {
                if (phase === 'collecting') {
                    advertise();
                } else if (phase === 'roster') {
                    publishRoster();
                } else if (phase === 'connecting') {
                    send('*', 'connect', {
                        rosterKey,
                    });
                } else if (phase === 'starting') {
                    send('*', 'start', {
                        rosterKey,
                    }).then(() => {
                        startPublished = true;
                        hostProgress();
                    });
                }
            } else if (!host) {
                send('*', 'discover');
            } else if (!roster) {
                send(host, 'join');
            } else if (!connecting) {
                send(host, 'ack', {
                    rosterKey,
                });
            } else if (localReady) {
                send(host, 'ready', {
                    rosterKey,
                });
            }
        }, 1000);
        STATUS('room');
        if (disposed) {
            return;
        }
        if (role === 'host') {
            collisionTimer = setTimeout(() => {
                if (!disposed) {
                    phase = 'collecting';
                    advertise();
                }
            }, 1200);
        } else {
            send('*', 'discover');
        }
    });
}
