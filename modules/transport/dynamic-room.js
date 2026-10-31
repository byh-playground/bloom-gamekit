import { PROTOCOL_VERSION, encoder } from '../_rollback-shared/protocol.js';
import { compareIds, integer, nowMs } from '../deterministic/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createWebRTCPeer } from './webrtc.js';
import { createRoomResumeIdentity } from './room-resume-identity.js';
const VALID_ID = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);
const PROBE_MAGIC = new Uint8Array([66, 77, 68, 89, 78, 80, 82, 49]);
const MAX_SIGNAL_BYTES = 128 * 1024,
    MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const RANDOM_ID = () =>
    [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
function roster(value, maxPlayers) {
    if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > maxPlayers ||
        value.some((id) => !VALID_ID(id)) ||
        new Set(value).size !== value.length
    ) {
        throw new TypeError('dynamic room players');
    }
    return Object.freeze([...value].sort(compareIds));
}

/** Ongoing 1..5-player mesh connectivity. RTC connection is not roster admission.
 * A RoomSession owns admission, snapshots, committed epochs and graceful succession.
 * Optional resume keeps the room-scoped signing identity in a save record across reload.
 */
export async function createNostrDynamicRoom({
    role,
    room,
    namespace = 'rollback-netcode',
    maxPlayers = 5,
    maxPendingPeers = 5,
    timeoutMs = 60000,
    peerTimeoutMs = 20000,
    retryMs = 1500,
    advertiseIntervalMs = 5000,
    resume,
    resumeProbeMs = 1500,
    relays,
    rtcConfig,
    signal,
    onStatus = () => {},
    signalerFactory = createNostrSignaler,
    peerFactory = createWebRTCPeer,
    expectedSessionId,
    authorizeJoin = () => true,
} = {}) {
    if (!['host', 'join'].includes(role)) {
        throw new TypeError('dynamic room role');
    }
    integer(maxPlayers, 'maxPlayers', 1, 5);
    integer(maxPendingPeers, 'maxPendingPeers', 1, 5);
    integer(timeoutMs, 'timeoutMs', 1, 120000);
    integer(peerTimeoutMs, 'peerTimeoutMs', 1, 120000);
    integer(resumeProbeMs, 'resumeProbeMs', 10, 10000);
    integer(retryMs, 'retryMs', 10, 10000);
    integer(advertiseIntervalMs, 'advertiseIntervalMs', 10, 120000);
    if (typeof namespace !== 'string' || !namespace.trim() || encoder.encode(namespace + ':dynamic-v1').length > 128) {
        throw new TypeError('dynamic room namespace');
    }
    if (expectedSessionId !== undefined && (!VALID_ID(expectedSessionId) || expectedSessionId.length > 116)) {
        throw new TypeError('expectedSessionId');
    }
    if ([onStatus, signalerFactory, peerFactory, authorizeJoin].some((fn) => typeof fn !== 'function')) {
        throw new TypeError('dynamic room capability');
    }
    if (signal?.aborted) {
        throw new Error('dynamic room aborted');
    }
    if (!room && role === 'host') {
        room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
    }
    if (!/^\d{4}$/.test(room ?? '')) {
        throw new TypeError('four-digit room');
    }
    // A queued resume write that fails closes the identity and is reported as a status event.
    const RESUME_IDENTITY = resume
        ? await createRoomResumeIdentity(resume, {
              namespace,
              room,
              onWriteFailure: (error) =>
                  STATUS('resume-save-failed', {
                      record: 'identity',
                      reason: error.message,
                      error,
                  }),
          })
        : null;
    const STARTED_AT = nowMs(),
        SIGNAL_CONTROLLER = new AbortController();
    let initializationReject;
    const INITIALIZATION_FAILURE = new Promise((_resolve, reject) => {
        initializationReject = reject;
    });
    const INITIALIZATION_TIMER = setTimeout(() => {
        SIGNAL_CONTROLLER.abort();
        initializationReject(new Error('dynamic room signaling timeout'));
    }, timeoutMs);
    const EARLY_ABORT = () => {
        SIGNAL_CONTROLLER.abort();
        initializationReject(new Error('dynamic room aborted'));
    };
    signal?.addEventListener('abort', EARLY_ABORT, {
        once: true,
    });
    let signaler;
    try {
        const SETUP = Promise.resolve()
            .then(() =>
                signalerFactory({
                    room,
                    namespace: namespace + ':dynamic-v1',
                    relays,
                    signal: SIGNAL_CONTROLLER.signal,
                    timeoutMs: Math.min(timeoutMs, 10000),
                    onStatus,
                    maxVerificationsPerSecond: 32,
                    verificationBurst: 20,
                    identity: RESUME_IDENTITY?.identity,
                }),
            )
            .then((value) => {
                if (SIGNAL_CONTROLLER.signal.aborted) {
                    value?.close?.();
                }
                return value;
            });
        signaler = await Promise.race([SETUP, INITIALIZATION_FAILURE]);
        if (
            !VALID_ID(signaler?.id) ||
            ['send', 'subscribe', 'close'].some((key) => typeof signaler?.[key] !== 'function')
        ) {
            throw new TypeError('dynamic signaler capability');
        }
        if (signal?.aborted || SIGNAL_CONTROLLER.signal.aborted) {
            throw new Error('dynamic room aborted');
        }
    } catch (error) {
        SIGNAL_CONTROLLER.abort();
        signaler?.close?.();
        RESUME_IDENTITY?.identity.close();
        throw error;
    } finally {
        clearTimeout(INITIALIZATION_TIMER);
        signal?.removeEventListener('abort', EARLY_ABORT);
    }
    if (RESUME_IDENTITY && signaler.id !== RESUME_IDENTITY.identity.id) {
        signaler.close();
        RESUME_IDENTITY.identity.close();
        throw new Error('resume signaler identity mismatch');
    }
    const SELF = signaler.id,
        INCARNATION = RANDOM_ID(),
        TRANSPORTS = new Map(),
        PEER_CONNECTIONS = new Map(),
        LISTENERS = new Set();
    const LINKS = new Map(),
        GENERATIONS = new Map(),
        CANDIDATES = new Map(),
        BACKLOG = new Map(),
        PUBLICATIONS = new Map();
    const SAVED = RESUME_IDENTITY?.metadata,
        RESUMED = !!(SAVED?.sessionId && SAVED.players.includes(SELF));
    if (SAVED?.sessionId && expectedSessionId !== undefined && expectedSessionId !== SAVED.sessionId) {
        signaler.close();
        RESUME_IDENTITY.identity.close();
        throw new Error('resume session does not match expectedSessionId; explicitly reset');
    }
    const RESUME_TARGETS = new Set(RESUMED ? SAVED.players : []);
    const ESTABLISHING = role === 'join' || RESUMED,
        INCARNATIONS = new Map([[SELF, INCARNATION]]),
        RESUME_APPROVED = new Set(),
        RESUME_CHECKS = new Map();
    let resumePeerId = null;
    let players = Object.freeze(RESUMED ? [...SAVED.players] : role === 'host' ? [SELF] : []);
    let coordinatorId = RESUMED ? SAVED.coordinatorId : role === 'host' ? SELF : null;
    let sessionId = RESUMED ? SAVED.sessionId : role === 'host' ? RANDOM_ID() : null;
    let epoch = RESUMED ? SAVED.epoch : 0;
    let meshPlayers = new Set(players);
    let meshUntil = RESUMED ? Infinity : 0;
    let hasBeenAdmitted = players.includes(SELF);
    let allowBranchReconnect = false;
    let disposed = false;
    let settled = false;
    let backlogBytes = 0;
    let unsubscribe;
    let interval;
    let deadline;
    let invitation;
    let nextAdvertisement = 0;
    let readyResolve;
    let readyReject;
    const READY = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    // Hosts return before any peers exist. Background failures are observable events.
    const STATUS = (type, detail = {}) => {
        const EVENT = {
            type,
            room,
            role,
            ...detail,
        };
        try {
            onStatus(EVENT);
        } catch {
            /* Observers never own room state. */
        }
        for (const FN of [...LISTENERS]) {
            try {
                FN(EVENT);
            } catch {
                /* Observer only. */
            }
        }
    };
    const PENDING_COUNT = () => [...LINKS.values()].filter((link) => !link.peer).length;
    const ACCEPTED = (id) => players.includes(id) || (meshPlayers.has(id) && meshUntil > nowMs()) || CANDIDATES.has(id);
    const LEADER = (id) => compareIds(SELF, id) > 0;
    const CONTROL = (op, extra = {}) => ({
        type: 'group',
        mode: 'dynamic',
        version: 1,
        protocol: PROTOCOL_VERSION,
        op,
        sessionId,
        coordinatorId,
        epoch,
        incarnation: INCARNATION,
        ...extra,
    });
    function publish(to, payload, key = to + ':' + payload.op) {
        if (disposed) {
            return Promise.reject(new Error('dynamic room closed'));
        }
        if (PUBLICATIONS.has(key)) {
            return PUBLICATIONS.get(key);
        }
        if (PUBLICATIONS.size >= 32) {
            return Promise.reject(new Error('dynamic signaling publication capacity'));
        }
        const PROMISE = Promise.resolve()
            .then(() => {
                if (disposed) {
                    throw new Error('dynamic room closed');
                }
                return signaler.send(to, payload);
            })
            .finally(() => {
                if (PUBLICATIONS.get(key) === PROMISE) {
                    PUBLICATIONS.delete(key);
                }
            });
        PUBLICATIONS.set(key, PROMISE);
        return PROMISE;
    }
    function send(to, op, extra = {}) {
        const PROMISE = publish(
            to,
            CONTROL(op, {
                targetIncarnation: INCARNATIONS.get(to),
                ...extra,
            }),
        );
        PROMISE.catch((error) => {
            if (!disposed) {
                STATUS('signal-error', {
                    peerId: to,
                    reason: error.message,
                });
            }
        });
        return PROMISE;
    }
    function forgetBacklog(key) {
        const QUEUED = BACKLOG.get(key);
        if (!QUEUED) {
            return;
        }
        for (const ITEM of QUEUED.items) {
            backlogBytes -= ITEM.size;
        }
        BACKLOG.delete(key);
    }
    function rememberGeneration(id, generation) {
        GENERATIONS.delete(id);
        GENERATIONS.set(id, generation);
        // Only disconnected tombstones are evicted; live peers always retain their scope.
        for (const OLD of GENERATIONS.keys()) {
            if (GENERATIONS.size <= 64) {
                break;
            }
            if (!LINKS.has(OLD) && !ACCEPTED(OLD)) {
                GENERATIONS.delete(OLD);
            }
        }
    }
    function destroyLink(link, reason, notify = true, preserveWaiter = false) {
        if (LINKS.get(link.id) !== link) {
            return;
        }
        LINKS.delete(link.id);
        clearTimeout(link.deadline);
        link.removeStatus?.();
        link.removeRaw?.();
        link.cancelProbe?.();
        link.controller.abort();
        const WAS_CONNECTED = TRANSPORTS.delete(link.id);
        PEER_CONNECTIONS.delete(link.id);
        link.peer?.close();
        link.subscribers.clear();
        link.outbound.clear();
        if (!preserveWaiter) {
            link.reject(new Error(reason));
        }
        if (WAS_CONNECTED && notify && !disposed) {
            STATUS('peer-disconnected', {
                peerId: link.id,
                reason,
            });
        }
    }
    function finish() {
        if (disposed || settled) {
            return;
        }
        settled = true;
        clearTimeout(deadline);
        readyResolve(CAPABILITY);
    }
    function close(reason = 'dynamic room closed') {
        if (disposed) {
            return;
        }
        disposed = true;
        clearInterval(interval);
        clearTimeout(deadline);
        unsubscribe?.();
        signal?.removeEventListener('abort', abort);
        for (const LINK of [...LINKS.values()]) {
            destroyLink(LINK, reason, false);
        }
        SIGNAL_CONTROLLER.abort();
        signaler.close();
        RESUME_IDENTITY?.identity.close();
        BACKLOG.clear();
        backlogBytes = 0;
        CANDIDATES.clear();
        PUBLICATIONS.clear();
        if (!settled) {
            settled = true;
            readyReject(new Error(reason));
        }
        STATUS('room-closed', {
            reason,
        });
        LISTENERS.clear();
    }
    function abort() {
        close('dynamic room aborted');
    }
    function failLink(link, error) {
        if (disposed || LINKS.get(link.id) !== link) {
            return;
        }
        destroyLink(link, error.message || String(error));
        STATUS('peer-failed', {
            peerId: link.id,
            reason: error.message || String(error),
        });
        // Initial join is bounded by its own deadline and may retry this link.
    }
    function newLink(id, generation, connectionId, prior) {
        if (!prior && (PENDING_COUNT() >= maxPendingPeers || LINKS.size >= maxPlayers - 1 + maxPendingPeers)) {
            throw new Error('dynamic pending peer capacity');
        }
        let resolve;
        let reject;
        let promise;
        if (prior && !prior.peer) {
            ({ resolve, reject, promise } = prior);
        } else {
            promise = new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            });
            promise.catch(() => {});
        }
        if (prior) {
            destroyLink(prior, 'peer reconnecting', true, !prior.peer);
        }
        const LINK = {
            id,
            generation,
            connectionId,
            resolve,
            reject,
            promise,
            controller: new AbortController(),
            peer: null,
            started: false,
            subscribers: new Set(),
            outbound: new Map(),
            nextRetry: 0,
            requestGeneration: GENERATIONS.get(id) ?? 0,
            force: false,
        };
        LINKS.set(id, LINK);
        LINK.deadline = setTimeout(() => failLink(LINK, new Error('dynamic peer timeout')), peerTimeoutMs);
        return LINK;
    }
    function scopedSignaler(link) {
        return {
            id: SELF,
            close() {},
            send(to, payload) {
                if (disposed || LINKS.get(link.id) !== link || to !== link.id || !SIGNAL_TYPES.has(payload?.type)) {
                    return Promise.reject(new Error('dynamic peer scope'));
                }
                const MESSAGE = {
                    ...payload,
                    dynamicSession: sessionId,
                    dynamicGeneration: link.generation,
                    dynamicConnection: link.connectionId,
                    dynamicFrom: INCARNATION,
                    dynamicTo: INCARNATIONS.get(to),
                };
                if (encoder.encode(JSON.stringify(MESSAGE)).length > MAX_SIGNAL_BYTES) {
                    return Promise.reject(new RangeError('dynamic signaling message capacity'));
                }
                // Offers and answers are safe to replay. ICE is bounded by createWebRTCPeer.
                if (payload.type === 'offer' || payload.type === 'answer') {
                    link.outbound.set(payload.type, MESSAGE);
                }
                return Promise.resolve(link.announcement).then(() => {
                    if (disposed || LINKS.get(link.id) !== link) {
                        throw new Error('dynamic peer scope');
                    }
                    return publish(to, MESSAGE, `${to}:signal:${link.generation}:${payload.type}`);
                });
            },
            subscribe(fn) {
                if (typeof fn !== 'function') {
                    throw new TypeError('dynamic signaling subscriber');
                }
                link.subscribers.add(fn);
                const KEY = `${link.id}:${link.generation}:${link.connectionId}`,
                    QUEUED = BACKLOG.get(KEY);
                if (QUEUED) {
                    const ITEMS = QUEUED.items.slice();
                    forgetBacklog(KEY);
                    for (const ITEM of ITEMS) {
                        if (!disposed) {
                            fn(ITEM.envelope);
                        }
                    }
                }
                return () => link.subscribers.delete(fn);
            },
        };
    }
    function saveResume() {
        if (!RESUME_IDENTITY || !sessionId) {
            return;
        }
        if (hasBeenAdmitted && !players.includes(SELF)) {
            RESUME_IDENTITY.forget();
            return;
        }
        if (players.includes(SELF)) {
            hasBeenAdmitted = true;
        }
        RESUME_IDENTITY.update({
            sessionId,
            coordinatorId,
            epoch,
            players,
        });
    }
    function acceptIncarnations(value, next) {
        if (!value || typeof value !== 'object') {
            return;
        }
        for (const ID of next) {
            if (ID !== SELF && VALID_ID(value[ID])) {
                // Existing and pending connections require their own resume challenge before replacement.
                if (!LINKS.has(ID) || !INCARNATIONS.has(ID)) {
                    INCARNATIONS.set(ID, value[ID]);
                }
            }
        }
    }
    function wrapTransport(link, raw) {
        const HANDLERS = new Set();
        link.removeRaw = raw.subscribe((bytes) => {
            if (bytes.length === 25 && PROBE_MAGIC.every((value, i) => bytes[i] === value)) {
                if (bytes[8] === 1) {
                    const REPLY = bytes.slice();
                    REPLY[8] = 2;
                    raw.send(REPLY);
                } else if (bytes[8] === 2) {
                    link.onPong?.(bytes.subarray(9));
                }
                return;
            }
            for (const FN of [...HANDLERS]) {
                FN(bytes);
            }
        });
        return {
            get state() {
                return raw.state;
            },
            get bufferedAmount() {
                return raw.bufferedAmount ?? 0;
            },
            send: (data) => raw.send(data),
            close: () => link.peer.close(),
            subscribe(fn) {
                if (typeof fn !== 'function') {
                    throw new TypeError('dynamic transport subscriber');
                }
                HANDLERS.add(fn);
                return () => HANDLERS.delete(fn);
            },
            subscribeStatus: (fn) => raw.subscribeStatus?.(fn) ?? (() => {}),
        };
    }
    function probePeer(link) {
        if (!link?.peer || (link.peer.transport.state && link.peer.transport.state !== 'open')) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            const BYTES = new Uint8Array(25);
            BYTES.set(PROBE_MAGIC);
            BYTES[8] = 1;
            const NONCE = globalThis.crypto.getRandomValues(new Uint8Array(16));
            BYTES.set(NONCE, 9);
            let done = false;
            let timer;
            const FINISH = (alive) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                link.onPong = null;
                link.cancelProbe = null;
                resolve(alive);
            };
            link.onPong = (response) => {
                if (NONCE.every((value, i) => response[i] === value)) {
                    FINISH(true);
                }
            };
            link.cancelProbe = () => FINISH(false);
            timer = setTimeout(() => FINISH(false), resumeProbeMs);
            // Backpressure is not evidence of death: reject the duplicate conservatively.
            if (!link.peer.transport.send(BYTES)) {
                FINISH(true);
            }
        });
    }
    function approveResume(id, requestedIncarnation) {
        if (INCARNATIONS.get(id) === requestedIncarnation) {
            send(id, 'resume-accept', {
                generation: LINKS.get(id)?.connectionId ? LINKS.get(id).generation : (GENERATIONS.get(id) ?? 0) + 1,
            });
            return;
        }
        if (RESUME_CHECKS.has(id)) {
            return;
        }
        const EXISTING = LINKS.get(id);
        const CHECK = probePeer(EXISTING)
            .then((alive) => {
                if (disposed || LINKS.get(id) !== EXISTING) {
                    return;
                }
                if (alive) {
                    send(id, 'resume-reject', {
                        targetIncarnation: requestedIncarnation,
                    });
                    return;
                }
                // A mesh transition may already be awaiting this reconnect. Keep that
                // pending promise attached to its replacement; rejecting it would fail
                // the whole RoomSession before the approved incarnation can connect.
                if (EXISTING?.peer && LINKS.get(id) === EXISTING) {
                    destroyLink(EXISTING, 'peer resuming');
                }
                INCARNATIONS.set(id, requestedIncarnation);
                const GENERATION = (GENERATIONS.get(id) ?? 0) + 1;
                send(id, 'resume-accept', {
                    generation: GENERATION,
                    targetIncarnation: requestedIncarnation,
                });
                STATUS('peer-resuming', {
                    peerId: id,
                });
                if (LEADER(id)) {
                    try {
                        startGeneration(id, GENERATION);
                    } catch {
                        // The connection attempt reports failure through its existing status/cleanup path.
                    }
                } else if (EXISTING && LINKS.get(id) === EXISTING) {
                    try {
                        newLink(id, 0, null, EXISTING);
                    } catch {
                        // The replacement attempt reports failure through its existing status/cleanup path.
                    }
                }
            })
            .finally(() => RESUME_CHECKS.delete(id));
        RESUME_CHECKS.set(id, CHECK);
    }
    function startPeer(link) {
        if (disposed || link.started || LINKS.get(link.id) !== link) {
            return;
        }
        link.started = true;
        Promise.resolve()
            .then(() => {
                if (disposed || LINKS.get(link.id) !== link) {
                    throw new Error('dynamic peer superseded');
                }
                return peerFactory({
                    initiator: LEADER(link.id),
                    signaler: scopedSignaler(link),
                    remoteId: link.id,
                    rtcConfig,
                    timeoutMs: peerTimeoutMs,
                    signal: link.controller.signal,
                    onStatus: (event) =>
                        STATUS('peer-status', {
                            peerId: link.id,
                            event,
                        }),
                });
            })
            .then((peer) => {
                if (disposed || LINKS.get(link.id) !== link) {
                    peer?.close?.();
                    return;
                }
                if (
                    typeof peer?.transport?.send !== 'function' ||
                    typeof peer.transport.subscribe !== 'function' ||
                    typeof peer.close !== 'function'
                ) {
                    peer?.close?.();
                    throw new TypeError('dynamic peer capability');
                }
                if (peer.transport.state && peer.transport.state !== 'open') {
                    peer.close();
                    throw new Error('dynamic transport not open');
                }
                link.peer = peer;
                clearTimeout(link.deadline);
                link.outbound.clear();
                const TRANSPORT = wrapTransport(link, peer.transport);
                TRANSPORTS.set(link.id, TRANSPORT);
                PEER_CONNECTIONS.set(link.id, peer.peerConnection);
                if (peer.transport.subscribeStatus) {
                    link.removeStatus = peer.transport.subscribeStatus((state) => {
                        if (state === 'closed' || state === 'failed' || state === 'interrupted') {
                            failLink(link, new Error('dynamic peer ' + state));
                        }
                    });
                }
                link.resolve(TRANSPORT);
                STATUS('peer-connected', {
                    peerId: link.id,
                    transport: TRANSPORT,
                    generation: link.generation,
                });
                if (!disposed && ESTABLISHING && (link.id === coordinatorId || (RESUMED && coordinatorId === SELF))) {
                    resumePeerId ??= link.id;
                    finish();
                }
            })
            .catch((error) => failLink(link, error));
    }
    function announceLink(link) {
        return send(link.id, 'link', {
            generation: link.generation,
            connectionId: link.connectionId,
        });
    }
    function startGeneration(id, generation) {
        const LINK = newLink(id, generation, RANDOM_ID(), LINKS.get(id));
        rememberGeneration(id, generation);
        LINK.announcement = announceLink(LINK);
        // Errors here fail the individual attempt, not an already running room.
        LINK.announcement.catch((error) => failLink(LINK, error));
        startPeer(LINK);
        return LINK;
    }
    function ensurePeer(id, force = false) {
        if (disposed) {
            return Promise.reject(new Error('dynamic room closed'));
        }
        if (!VALID_ID(id) || id === SELF || !ACCEPTED(id)) {
            return Promise.reject(new Error('dynamic peer is not invited'));
        }
        const OLD = LINKS.get(id);
        if (RESUMED && RESUME_TARGETS.has(id) && !RESUME_APPROVED.has(id)) {
            try {
                const WAITING = OLD ?? newLink(id, 0, null);
                WAITING.resuming = true;
                send(id, 'resume-request', {
                    resumeSession: sessionId,
                });
                return WAITING.promise;
            } catch (error) {
                return Promise.reject(error);
            }
        }
        if (!INCARNATIONS.has(id)) {
            try {
                const WAITING = OLD ?? newLink(id, 0, null);
                WAITING.waitingIncarnation = true;
                return WAITING.promise;
            } catch (error) {
                return Promise.reject(error);
            }
        }
        if (OLD && !OLD.waitingIncarnation && (!force || !OLD.peer)) {
            return OLD.promise;
        }
        try {
            if (LEADER(id)) {
                return startGeneration(id, (GENERATIONS.get(id) ?? 0) + 1).promise;
            }
            const LINK = newLink(id, 0, null, OLD);
            LINK.force = force;
            send(id, 'request', {
                generation: LINK.requestGeneration,
                reconnect: force,
            });
            return LINK.promise;
        } catch (error) {
            return Promise.reject(error);
        }
    }
    function advertise(to = '*') {
        if (coordinatorId !== SELF || (RESUMED && !settled)) {
            return;
        }
        send(to, 'hello', {
            players,
            maxPlayers,
            accepting: players.length < maxPlayers,
        });
    }
    function inviteMesh(value) {
        const NEXT = roster(value, maxPlayers);
        if (!NEXT.includes(SELF) || !NEXT.includes(coordinatorId)) {
            throw new TypeError('dynamic mesh requires local player and coordinator');
        }
        meshPlayers = new Set(NEXT);
        meshUntil = nowMs() + peerTimeoutMs;
        if (coordinatorId === SELF) {
            invitation = {
                players: NEXT,
                until: meshUntil,
            };
            send('*', 'mesh', {
                players: NEXT,
                peerIncarnations: Object.fromEntries(INCARNATIONS),
            });
        }
        return NEXT;
    }
    function setRoster(value) {
        if (disposed) {
            throw new Error('dynamic room closed');
        }
        const NEXT = roster(value?.players, maxPlayers),
            NEXT_EPOCH = integer(value?.epoch, 'epoch', 0, 65534);
        if (!VALID_ID(value?.coordinatorId) || !NEXT.includes(value.coordinatorId)) {
            throw new TypeError('dynamic roster coordinator');
        }
        if (NEXT_EPOCH < epoch) {
            throw new Error('stale dynamic room epoch');
        }
        if (NEXT_EPOCH === epoch && (players.join('\n') !== NEXT.join('\n') || coordinatorId !== value.coordinatorId)) {
            throw new Error('conflicting dynamic room epoch');
        }
        players = NEXT;
        epoch = NEXT_EPOCH;
        coordinatorId = value.coordinatorId;
        if (value.allowBranchReconnect === true) {
            allowBranchReconnect = true;
        }
        meshPlayers = new Set(NEXT);
        meshUntil = Infinity;
        invitation = null;
        for (const ID of CANDIDATES.keys()) {
            if (NEXT.includes(ID)) {
                CANDIDATES.delete(ID);
            }
        }
        for (const ID of INCARNATIONS.keys()) {
            if (ID !== SELF && !NEXT.includes(ID) && !LINKS.has(ID) && !CANDIDATES.has(ID)) {
                INCARNATIONS.delete(ID);
            }
        }
        saveResume();
        // Existing RTC links deliberately remain open until RoomSession delivers commit.
        if (coordinatorId === SELF) {
            advertise();
        }
    }
    const CAPABILITY = {
        room,
        role,
        maxPlayers,
        resumed: RESUMED,
        get resumePeerId() {
            return resumePeerId;
        },
        localPlayerId: SELF,
        transports: TRANSPORTS,
        peerConnections: PEER_CONNECTIONS,
        get sessionId() {
            return sessionId;
        },
        get coordinatorId() {
            return coordinatorId;
        },
        get players() {
            return players;
        },
        get epoch() {
            return epoch;
        },
        get joining() {
            return !players.includes(SELF);
        },
        get closed() {
            return disposed;
        },
        get metrics() {
            return {
                activePeerCount: TRANSPORTS.size,
                pendingPeerCount: PENDING_COUNT(),
                signalBacklogBytes: backlogBytes,
            };
        },
        subscribe(fn) {
            if (disposed || typeof fn !== 'function') {
                throw new TypeError('dynamic room subscriber');
            }
            LISTENERS.add(fn);
            return () => LISTENERS.delete(fn);
        },
        setRoster,
        connectMesh(value) {
            try {
                if (disposed) {
                    throw new Error('dynamic room closed');
                }
                const NEXT = inviteMesh(value);
                return Promise.all(NEXT.filter((id) => id !== SELF).map((id) => ensurePeer(id))).then(() => undefined);
            } catch (error) {
                return Promise.reject(error);
            }
        },
        reconnect(id) {
            return ensurePeer(id, true);
        },
        forgetResume() {
            RESUME_IDENTITY?.forget();
        },
        disconnect(id) {
            if (!VALID_ID(id) || id === SELF) {
                throw new TypeError('dynamic peer id');
            }
            const LINK = LINKS.get(id);
            if (LINK) {
                destroyLink(LINK, 'peer disconnected by owner');
            }
            CANDIDATES.delete(id);
            meshPlayers.delete(id);
            if (!players.includes(id)) {
                INCARNATIONS.delete(id);
            }
            for (const KEY of BACKLOG.keys()) {
                if (KEY.startsWith(id + ':')) {
                    forgetBacklog(KEY);
                }
            }
            return !!LINK;
        },
        close,
    };
    function routeSignal(envelope) {
        const { from: FROM, to: TO, message: M } = envelope;
        if (
            TO !== SELF ||
            M.dynamicSession !== sessionId ||
            M.dynamicTo !== INCARNATION ||
            M.dynamicFrom !== INCARNATIONS.get(FROM) ||
            !ACCEPTED(FROM) ||
            !Number.isSafeInteger(M.dynamicGeneration) ||
            M.dynamicGeneration < 1 ||
            !VALID_ID(M.dynamicConnection)
        ) {
            return;
        }
        let size;
        try {
            size = encoder.encode(JSON.stringify(M)).length;
        } catch {
            return;
        }
        if (size > MAX_SIGNAL_BYTES) {
            return;
        }
        const LINK = LINKS.get(FROM);
        if (
            LINK?.generation === M.dynamicGeneration &&
            LINK.connectionId === M.dynamicConnection &&
            LINK.subscribers.size
        ) {
            for (const FN of [...LINK.subscribers]) {
                FN(envelope);
            }
            return;
        }
        // Only a future deterministic initiator may precede its link announcement.
        const KNOWN = GENERATIONS.get(FROM) ?? 0;
        if (
            LEADER(FROM) ||
            M.dynamicGeneration < KNOWN ||
            (M.dynamicGeneration === KNOWN &&
                (!LINK || LINK.generation !== M.dynamicGeneration || LINK.connectionId !== M.dynamicConnection))
        ) {
            return;
        }
        const KEY = `${FROM}:${M.dynamicGeneration}:${M.dynamicConnection}`;
        const QUEUED = BACKLOG.get(KEY) ?? {
            items: [],
            until: nowMs() + peerTimeoutMs,
        };
        if (
            QUEUED.items.length >= 32 ||
            (!BACKLOG.has(KEY) && BACKLOG.size >= maxPendingPeers) ||
            backlogBytes + size > MAX_BACKLOG_BYTES
        ) {
            return;
        }
        QUEUED.items.push({
            envelope,
            size,
        });
        backlogBytes += size;
        BACKLOG.set(KEY, QUEUED);
    }
    function receive(envelope) {
        if (
            disposed ||
            !envelope ||
            !VALID_ID(envelope.from) ||
            envelope.from === SELF ||
            !['*', SELF].includes(envelope.to) ||
            !envelope.message ||
            typeof envelope.message !== 'object'
        ) {
            return;
        }
        const { from: FROM, message: M } = envelope;
        if (SIGNAL_TYPES.has(M.type)) {
            routeSignal(envelope);
            return;
        }
        if (M.type !== 'group' || M.mode !== 'dynamic' || M.version !== 1 || M.protocol !== PROTOCOL_VERSION) {
            return;
        }
        if (M.targetIncarnation && M.targetIncarnation !== INCARNATION) {
            return;
        }
        if (M.op === 'discover') {
            if (M.resumeSession === sessionId && players.includes(FROM) && VALID_ID(M.incarnation)) {
                send(FROM, 'resume-hello', {
                    targetIncarnation: M.incarnation,
                    players,
                    peerIncarnations: Object.fromEntries(INCARNATIONS),
                });
            } else {
                advertise(FROM);
            }
            return;
        }
        if (
            M.op === 'resume-hello' &&
            RESUMED &&
            !settled &&
            M.sessionId === sessionId &&
            players.includes(FROM) &&
            VALID_ID(M.incarnation)
        ) {
            let next;
            try {
                next = roster(M.players, maxPlayers);
                integer(M.epoch, 'epoch', epoch, 65534);
            } catch {
                return;
            }
            if (!next.includes(SELF) || !next.includes(FROM) || !next.includes(M.coordinatorId)) {
                return;
            }
            players = next;
            epoch = M.epoch;
            coordinatorId = M.coordinatorId;
            meshPlayers = new Set(next);
            meshUntil = Infinity;
            acceptIncarnations(M.peerIncarnations, next);
            INCARNATIONS.set(FROM, M.incarnation);
            saveResume();
            const DONOR = coordinatorId === SELF ? FROM : coordinatorId;
            if (INCARNATIONS.has(DONOR)) {
                ensurePeer(DONOR).catch(() => {});
            }
            return;
        }
        if (M.op === 'hello' && expectedSessionId !== undefined && M.sessionId !== expectedSessionId) {
            return;
        }
        if (
            M.op === 'hello' &&
            !RESUMED &&
            !settled &&
            role === 'join' &&
            M.coordinatorId === FROM &&
            VALID_ID(M.sessionId)
        ) {
            if (coordinatorId && (coordinatorId !== FROM || sessionId !== M.sessionId)) {
                return;
            }
            let known;
            try {
                known = roster(M.players, maxPlayers);
                integer(M.epoch, 'epoch', 0, 65534);
            } catch {
                return;
            }
            if (!known.includes(FROM)) {
                return;
            }
            if (M.maxPlayers !== maxPlayers) {
                close('dynamic room maxPlayers mismatch');
                return;
            }
            if (M.accepting === false && !known.includes(SELF)) {
                close('dynamic room is full');
                return;
            }
            coordinatorId = FROM;
            sessionId = M.sessionId;
            players = known;
            epoch = M.epoch;
            INCARNATIONS.set(FROM, M.incarnation);
            meshPlayers = new Set(known);
            meshUntil = Infinity;
            saveResume();
            send(FROM, 'join');
            ensurePeer(FROM).catch(() => {});
            return;
        }
        const BRANCH_RECONNECT =
            allowBranchReconnect &&
            players.includes(FROM) &&
            ['request', 'link', 'resume-request', 'resume-accept', 'resume-reject'].includes(M.op);
        if (!sessionId || M.sessionId !== sessionId || (M.coordinatorId !== coordinatorId && !BRANCH_RECONNECT)) {
            return;
        }
        if (
            M.op === 'resume-request' &&
            players.includes(FROM) &&
            M.resumeSession === sessionId &&
            VALID_ID(M.incarnation)
        ) {
            approveResume(FROM, M.incarnation);
            return;
        }
        if (M.op === 'resume-reject' && RESUMED && players.includes(FROM)) {
            if (!settled) {
                close('duplicate live resume identity');
            } else if (LINKS.get(FROM)?.resuming) {
                failLink(LINKS.get(FROM), new Error('duplicate live resume identity'));
            }
            return;
        }
        if (
            M.op === 'resume-accept' &&
            RESUMED &&
            players.includes(FROM) &&
            VALID_ID(M.incarnation) &&
            Number.isSafeInteger(M.generation) &&
            M.generation > 0
        ) {
            if (RESUME_APPROVED.has(FROM)) {
                return;
            }
            INCARNATIONS.set(FROM, M.incarnation);
            RESUME_APPROVED.add(FROM);
            if (LEADER(FROM)) {
                try {
                    startGeneration(FROM, Math.max(M.generation, (GENERATIONS.get(FROM) ?? 0) + 1));
                } catch {
                    // The new generation reports failure through its existing status/cleanup path.
                }
            }
            return;
        }
        if (M.op === 'join' && coordinatorId === SELF) {
            if (!VALID_ID(M.incarnation)) {
                return;
            }
            if (INCARNATIONS.has(FROM) && INCARNATIONS.get(FROM) !== M.incarnation) {
                send(FROM, 'reject', {
                    targetIncarnation: M.incarnation,
                    reason: 'duplicate live identity; use resume',
                });
                return;
            }
            if (!players.includes(FROM) && !CANDIDATES.has(FROM)) {
                let authorized = false;
                try {
                    authorized =
                        authorizeJoin(FROM, {
                            sessionId,
                            room,
                        }) === true;
                } catch {
                    /* Admission callbacks fail closed. */
                }
                if (!authorized) {
                    send(FROM, 'reject', {
                        targetIncarnation: M.incarnation,
                        reason: 'dynamic room admission reservation required',
                    });
                    return;
                }
                if (players.length + CANDIDATES.size >= maxPlayers || PENDING_COUNT() >= maxPendingPeers) {
                    send(FROM, 'reject', {
                        targetIncarnation: M.incarnation,
                        reason: 'dynamic room is full',
                    });
                    return;
                }
                CANDIDATES.set(FROM, nowMs() + peerTimeoutMs);
            }
            INCARNATIONS.set(FROM, M.incarnation);
            ensurePeer(FROM).catch(() => {});
            return;
        }
        if (M.op === 'reject' && !settled && FROM === coordinatorId) {
            close(typeof M.reason === 'string' ? M.reason.slice(0, 256) : 'dynamic room rejected');
            return;
        }
        if (
            M.op === 'mesh' &&
            FROM === coordinatorId &&
            M.incarnation === INCARNATIONS.get(FROM) &&
            M.epoch === epoch
        ) {
            let next;
            try {
                next = roster(M.players, maxPlayers);
            } catch {
                return;
            }
            if (!next.includes(SELF) || !next.includes(coordinatorId)) {
                return;
            }
            acceptIncarnations(M.peerIncarnations, next);
            meshPlayers = new Set(next);
            meshUntil = nowMs() + peerTimeoutMs;
            for (const ID of next) {
                if (ID !== SELF) {
                    ensurePeer(ID).catch(() => {});
                }
            }
            return;
        }
        if (!ACCEPTED(FROM) || M.incarnation !== INCARNATIONS.get(FROM)) {
            return;
        }
        if (M.op === 'request' && LEADER(FROM) && Number.isSafeInteger(M.generation) && M.generation >= 0) {
            const LINK = LINKS.get(FROM),
                GENERATION = GENERATIONS.get(FROM) ?? 0;
            if (M.generation > GENERATION) {
                return;
            }
            if (!LINK || (M.reconnect === true && M.generation === GENERATION && LINK.peer)) {
                try {
                    startGeneration(FROM, GENERATION + 1);
                } catch {
                    /* Pending capacity is bounded. */
                }
            } else if (LINK.connectionId) {
                announceLink(LINK);
            }
        } else if (
            M.op === 'link' &&
            !LEADER(FROM) &&
            Number.isSafeInteger(M.generation) &&
            M.generation > 0 &&
            VALID_ID(M.connectionId)
        ) {
            const KNOWN = GENERATIONS.get(FROM) ?? 0,
                CURRENT = LINKS.get(FROM);
            if (M.generation < KNOWN || (M.generation === KNOWN && CURRENT?.connectionId !== M.connectionId)) {
                return;
            }
            if (CURRENT?.generation === M.generation && CURRENT.connectionId === M.connectionId) {
                return;
            }
            try {
                const LINK = newLink(FROM, M.generation, M.connectionId, CURRENT);
                rememberGeneration(FROM, M.generation);
                startPeer(LINK);
            } catch {
                /* Pending capacity is bounded. */
            }
        }
    }
    signal?.addEventListener('abort', abort, {
        once: true,
    });
    if (signal?.aborted) {
        abort();
        return READY;
    }
    try {
        unsubscribe = signaler.subscribe((envelope) => {
            try {
                receive(envelope);
            } catch (error) {
                close(error.message);
            }
        });
    } catch (error) {
        close(error.message);
        return READY;
    }
    if (disposed) {
        unsubscribe?.();
        return READY;
    }
    const REMAINING = timeoutMs - (nowMs() - STARTED_AT);
    if (REMAINING <= 0) {
        close('dynamic room timeout');
        return READY;
    }
    if (ESTABLISHING) {
        deadline = setTimeout(() => close('dynamic room join timeout'), REMAINING);
    }
    interval = setInterval(() => {
        const NOW = nowMs();
        for (const [ID, UNTIL] of CANDIDATES) {
            if (UNTIL <= NOW && !players.includes(ID)) {
                CANDIDATES.delete(ID);
                INCARNATIONS.delete(ID);
                const LINK = LINKS.get(ID);
                if (LINK) {
                    destroyLink(LINK, 'dynamic admission timeout');
                }
            }
        }
        for (const [KEY, QUEUED] of BACKLOG) {
            if (QUEUED.until <= NOW) {
                forgetBacklog(KEY);
            }
        }
        if (coordinatorId === SELF && NOW >= nextAdvertisement) {
            nextAdvertisement = NOW + advertiseIntervalMs;
            advertise();
        }
        if (!settled && ESTABLISHING) {
            if (RESUMED) {
                send('*', 'discover', {
                    resumeSession: sessionId,
                });
            } else if (!coordinatorId) {
                send('*', 'discover');
            } else {
                send(coordinatorId, 'join');
                ensurePeer(coordinatorId).catch(() => {});
            }
        }
        if (invitation && invitation.until > NOW) {
            send('*', 'mesh', {
                players: invitation.players,
                peerIncarnations: Object.fromEntries(INCARNATIONS),
            });
        } else {
            invitation = null;
        }
        for (const LINK of LINKS.values()) {
            if (!LINK.peer && NOW >= LINK.nextRetry) {
                LINK.nextRetry = NOW + retryMs;
                if (LINK.waitingIncarnation) {
                    if (INCARNATIONS.has(LINK.id)) {
                        ensurePeer(LINK.id).catch(() => {});
                    }
                    continue;
                }
                if (LINK.resuming && !RESUME_APPROVED.has(LINK.id)) {
                    send(LINK.id, 'resume-request', {
                        resumeSession: sessionId,
                    });
                    continue;
                }
                if (LEADER(LINK.id)) {
                    announceLink(LINK);
                } else if (!LINK.connectionId) {
                    send(LINK.id, 'request', {
                        generation: LINK.requestGeneration,
                        reconnect: LINK.force,
                    });
                }
                for (const [TYPE, MESSAGE] of LINK.outbound) {
                    publish(LINK.id, MESSAGE, `${LINK.id}:signal:${LINK.generation}:${TYPE}`).catch(() => {});
                }
            }
        }
    }, retryMs);
    interval.unref?.();
    STATUS('room-ready', {
        localPlayerId: SELF,
    });
    if (!disposed) {
        saveResume();
        if (!ESTABLISHING) {
            advertise();
            finish();
        } else {
            send(
                '*',
                'discover',
                RESUMED
                    ? {
                          resumeSession: sessionId,
                      }
                    : {},
            );
        }
    }
    return READY;
}
