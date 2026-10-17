import { PROTOCOL_VERSION, encoder } from '../_rollback-shared/protocol.js';
import { integer, nowMs } from '../deterministic/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createNostrDynamicRoom } from './dynamic-room.js';
import { createRoomResumeIdentity } from './room-resume-identity.js';
const ID_VALID = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const RANDOM_ID = () =>
    [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
const RANDOM_ROOM = () => String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const DIRECTORY_LIMIT = 64,
    PUBLICATION_LIMIT = 16;
const ERROR = (code, message) =>
    Object.assign(new Error(message), {
        code,
    });

/** Advisory, short-lived public room discovery. Only RoomSession commits game admission. */
export async function createNostrPublicRoom({
    namespace = 'rollback-netcode',
    simulationVersion,
    maxPlayers = 5,
    discoveryMs = 1500,
    totalTimeoutMs = 60000,
    leaseMs = 15000,
    reservationMs = 30000,
    maxAttempts = 3,
    relays,
    rtcConfig,
    resume,
    signal,
    onStatus = () => {},
    signalerFactory = createNostrSignaler,
    dynamicRoomFactory = createNostrDynamicRoom,
    ...dynamicOptions
} = {}) {
    if (typeof namespace !== 'string' || !namespace.trim() || encoder.encode(namespace + ':public-v1').length > 128) {
        throw new TypeError('public room namespace');
    }
    if (
        typeof simulationVersion !== 'string' ||
        !simulationVersion.length ||
        encoder.encode(simulationVersion).length > 128
    ) {
        throw new TypeError('public simulationVersion');
    }
    integer(maxPlayers, 'maxPlayers', 1, 5);
    integer(discoveryMs, 'discoveryMs', 10, 30000);
    integer(totalTimeoutMs, 'totalTimeoutMs', 10, 120000);
    integer(leaseMs, 'leaseMs', 100, 60000);
    integer(reservationMs, 'reservationMs', 100, 120000);
    integer(maxAttempts, 'maxAttempts', 1, 8);
    if ([onStatus, signalerFactory, dynamicRoomFactory].some((fn) => typeof fn !== 'function')) {
        throw new TypeError('public room capability');
    }
    if (resume) {
        if (
            !resume.storage ||
            ['getItem', 'setItem', 'removeItem'].some((k) => typeof resume.storage[k] !== 'function')
        ) {
            throw new TypeError('resume storage capability');
        }
        integer(resume.lifetimeMs ?? 8 * 60 * 60 * 1000, 'resume lifetimeMs', 1000, 86400000);
        if (resume.reset !== undefined && typeof resume.reset !== 'boolean') {
            throw new TypeError('resume reset');
        }
        if (
            resume.key !== undefined &&
            (typeof resume.key !== 'string' || !resume.key.length || resume.key.length > 500)
        ) {
            throw new TypeError('resume key');
        }
    }
    if (signal?.aborted) {
        throw ERROR('PUBLIC_ABORTED', 'public room aborted');
    }
    const STARTED = nowMs(),
        STARTED_WALL_AT = Date.now(),
        CONTROLLER = new AbortController(),
        DIRECTORY = new Map(),
        RESERVATIONS = new Map(),
        PUBLICATIONS = new Map();
    const EPHEMERAL_STORE = new Map();
    const EPHEMERAL = createRoomResumeIdentity(
        {
            storage: {
                getItem: (k) => EPHEMERAL_STORE.get(k) ?? null,
                setItem: (k, v) => EPHEMERAL_STORE.set(k, v),
                removeItem: (k) => EPHEMERAL_STORE.delete(k),
            },
        },
        {
            namespace,
            room: '0000',
        },
    );
    // A private in-memory identity is shared only by this room attempt's signalers.
    const SHARED = (identity) => ({
        id: identity.id,
        sign: (...args) => identity.sign(...args),
        close() {},
    });
    let disposed = false;
    let everAdmitted = false;
    let resumeForgotten = false;
    let room;
    let directorySignaler;
    let removeDirectory;
    let removeRoom;
    let interval;
    let nextAdvertisement = 0;
    let sequence = 0;
    let reservationWaiter;
    let selected;
    let setupTimer;
    let generation = 0;
    let directoryId;
    let pointer;
    let pointerKey;
    let storedUntil;
    const TIMER_WAITERS = new Map(),
        OBSERVERS = new Set();
    const STATUS = (type, detail = {}) => {
        const EVENT = {
            type,
            ...detail,
        };
        try {
            onStatus(EVENT);
        } catch {
            // Status observers must not interrupt the public room state machine.
        }
        for (const FN of [...OBSERVERS]) {
            try {
                FN(EVENT);
            } catch {
                // One observer must not prevent the remaining observers from being notified.
            }
        }
    };
    const REMAINING = () => Math.max(0, Math.floor(totalTimeoutMs - (nowMs() - STARTED)));
    const SCOPED_RESUME = (code) =>
        resume
            ? {
                  ...resume,
                  ...(resume.key
                      ? {
                            key: `${resume.key}:${code}`,
                        }
                      : {}),
              }
            : undefined;
    const ROOM_STORAGE_KEY = (code) => SCOPED_RESUME(code)?.key ?? `bloom-gamekit:dynamic-v1:${namespace}:${code}`;
    if (resume) {
        if (
            !resume.storage ||
            ['getItem', 'setItem', 'removeItem'].some((k) => typeof resume.storage[k] !== 'function')
        ) {
            throw new TypeError('resume storage capability');
        }
        pointerKey = `${resume.key ?? `bloom-gamekit:public-v1:${namespace}:${simulationVersion}`}:pointer`;
        if (pointerKey.length > 512) {
            throw new TypeError('public resume key');
        }
        const RAW = resume.storage.getItem(pointerKey);
        if (resume.reset) {
            if (RAW) {
                try {
                    const OLD = JSON.parse(RAW);
                    if (/^\d{4}$/.test(OLD?.room)) {
                        resume.storage.removeItem(ROOM_STORAGE_KEY(OLD.room));
                    }
                } catch {
                    // A malformed optional resume pointer does not block clearing the pointer itself.
                }
            }
            resume.storage.removeItem(pointerKey);
        } else if (RAW != null) {
            try {
                if (typeof RAW !== 'string' || RAW.length > 2048) {
                    throw Error();
                }
                pointer = JSON.parse(RAW);
                if (
                    pointer.version !== 1 ||
                    pointer.namespace !== namespace ||
                    pointer.simulationVersion !== simulationVersion ||
                    !/^\d{4}$/.test(pointer.room) ||
                    !ID_VALID(pointer.sessionId) ||
                    !Number.isSafeInteger(pointer.expiresAt) ||
                    pointer.expiresAt <= Date.now() ||
                    pointer.expiresAt > Date.now() + 86400000
                ) {
                    throw Error();
                }
                storedUntil = pointer.expiresAt;
            } catch {
                EPHEMERAL.identity.close();
                throw ERROR(
                    'PUBLIC_RESUME_INVALID',
                    'invalid or expired public resume pointer; explicitly reset for a fresh room',
                );
            }
        }
    }
    const FAIL = (message) => ERROR('PUBLIC_TIMEOUT', message ?? 'public room total timeout');
    function wait(ms) {
        if (disposed) {
            return Promise.reject(ERROR('PUBLIC_CLOSED', 'public room closed'));
        }
        return new Promise((resolve, reject) => {
            const TIMER = setTimeout(
                () => {
                    TIMER_WAITERS.delete(TIMER);
                    resolve();
                },
                Math.max(1, ms),
            );
            TIMER_WAITERS.set(TIMER, reject);
        });
    }
    function bounded(promise, ms, reason) {
        let timer;
        const DEADLINE = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(reason), Math.max(1, ms));
            TIMER_WAITERS.set(timer, reject);
        });
        return Promise.race([promise, DEADLINE]).finally(() => {
            clearTimeout(timer);
            TIMER_WAITERS.delete(timer);
        });
    }
    function close(reason = 'public room closed') {
        if (disposed) {
            return;
        }
        disposed = true;
        clearTimeout(setupTimer);
        clearInterval(interval);
        removeRoom?.();
        removeDirectory?.();
        CONTROLLER.abort();
        signal?.removeEventListener('abort', abort);
        const PENDING = reservationWaiter;
        reservationWaiter = null;
        PENDING?.reject(ERROR('PUBLIC_CLOSED', reason));
        for (const [TIMER, REJECT] of TIMER_WAITERS) {
            clearTimeout(TIMER);
            REJECT(ERROR('PUBLIC_CLOSED', reason));
        }
        TIMER_WAITERS.clear();
        directorySignaler?.close();
        room?.close();
        EPHEMERAL.identity.close();
        EPHEMERAL_STORE.clear();
        DIRECTORY.clear();
        RESERVATIONS.clear();
        PUBLICATIONS.clear();
        STATUS('public-room-closed', {
            reason,
        });
        OBSERVERS.clear();
    }
    function abort() {
        close('public room aborted');
    }
    signal?.addEventListener('abort', abort, {
        once: true,
    });
    setupTimer = setTimeout(() => close('public room total timeout'), totalTimeoutMs);
    function publish(to, op, extra = {}, key = `${to}:${op}`) {
        if (disposed || !directorySignaler) {
            return Promise.reject(ERROR('PUBLIC_CLOSED', 'public directory closed'));
        }
        if (PUBLICATIONS.has(key)) {
            return PUBLICATIONS.get(key);
        }
        if (PUBLICATIONS.size >= PUBLICATION_LIMIT) {
            return Promise.reject(ERROR('PUBLIC_CAPACITY', 'public directory publication capacity'));
        }
        const CHANNEL = directorySignaler,
            PROMISE = Promise.resolve()
                .then(() =>
                    CHANNEL.send(to, {
                        type: 'group',
                        mode: 'public-directory',
                        version: 1,
                        protocol: PROTOCOL_VERSION,
                        simulationVersion,
                        maxPlayers,
                        op,
                        ...extra,
                    }),
                )
                .finally(() => {
                    if (PUBLICATIONS.get(key) === PROMISE) {
                        PUBLICATIONS.delete(key);
                    }
                });
        PUBLICATIONS.set(key, PROMISE);
        return PROMISE;
    }
    function prune() {
        const NOW = Date.now();
        for (const [ID, LEASE] of DIRECTORY) {
            if ((LEASE.refreshUntil ?? LEASE.expiresAt) <= NOW) {
                DIRECTORY.delete(ID);
            }
        }
        for (const [ID, SEAT] of RESERVATIONS) {
            if (
                !room ||
                room.players.includes(ID) ||
                SEAT.expiresAt <= NOW ||
                room.coordinatorId !== room.localPlayerId
            ) {
                RESERVATIONS.delete(ID);
                if (room && !room.players.includes(ID)) {
                    room.disconnect(ID);
                }
            }
        }
    }
    function advertise(to = '*') {
        if (!room || room.closed || room.joining || room.coordinatorId !== room.localPlayerId) {
            return Promise.resolve();
        }
        prune();
        const ISSUED_AT = Date.now();
        return publish(to, 'lease', {
            room: room.room,
            sessionId: room.sessionId,
            coordinatorId: room.coordinatorId,
            players: [...room.players],
            epoch: room.epoch,
            sequence: ++sequence,
            issuedAt: ISSUED_AT,
            expiresAt: ISSUED_AT + leaseMs,
            committed: room.players.length,
            pending: RESERVATIONS.size,
        });
    }
    const BACKGROUND = (promise) =>
        promise.catch((cause) => {
            if (!disposed) {
                STATUS('public-directory-error', {
                    reason: cause.message,
                });
            }
        });
    function receive({ from, to, message: m } = {}) {
        if (
            disposed ||
            !ID_VALID(from) ||
            from === directoryId ||
            !['*', directoryId].includes(to) ||
            !m ||
            m.type !== 'group' ||
            m.mode !== 'public-directory' ||
            m.version !== 1 ||
            m.protocol !== PROTOCOL_VERSION ||
            m.simulationVersion !== simulationVersion ||
            m.maxPlayers !== maxPlayers
        ) {
            return;
        }
        const NOW = Date.now();
        if (m.op === 'lease') {
            if (
                !/^\d{4}$/.test(m.room) ||
                !ID_VALID(m.sessionId) ||
                m.coordinatorId !== from ||
                !Number.isSafeInteger(m.epoch) ||
                m.epoch < 0 ||
                m.epoch > 65534 ||
                !Number.isSafeInteger(m.sequence) ||
                m.sequence < 1 ||
                !Number.isSafeInteger(m.issuedAt) ||
                m.issuedAt > NOW + 1000 ||
                !Number.isSafeInteger(m.expiresAt) ||
                m.expiresAt <= NOW ||
                m.expiresAt <= m.issuedAt ||
                m.expiresAt - m.issuedAt > 60000 ||
                !Array.isArray(m.players) ||
                m.players.length < 1 ||
                m.players.length > maxPlayers ||
                m.players.some((id) => !ID_VALID(id)) ||
                new Set(m.players).size !== m.players.length ||
                !m.players.includes(from) ||
                m.committed !== m.players.length ||
                !Number.isSafeInteger(m.pending) ||
                m.pending < 0 ||
                m.pending + m.committed > maxPlayers
            ) {
                return;
            }
            prune();
            const PRIOR = DIRECTORY.get(m.sessionId);
            if (
                PRIOR &&
                (m.room !== PRIOR.room ||
                    m.epoch < PRIOR.epoch ||
                    (m.epoch === PRIOR.epoch &&
                        (PRIOR.refreshAfter ||
                            m.coordinatorId !== PRIOR.coordinatorId ||
                            m.sequence <= PRIOR.sequence)))
            ) {
                return;
            }
            if (PRIOR && m.epoch > PRIOR.epoch && !PRIOR.players.includes(from)) {
                // A receiver may miss the membership lease that introduced a successor.
                // Quarantine the old coordinator rather than adopting an unknown signer
                // or treating this known room as healthy-empty. The gap expires in a
                // bounded 60s; after the original lease expires, only a newly issued lease
                // can establish the same first-seen advisory trust used by a new client.
                PRIOR.refreshAfter ??= PRIOR.expiresAt;
                PRIOR.refreshUntil ??= PRIOR.refreshAfter + 60000;
                if (NOW < PRIOR.refreshAfter || m.issuedAt < PRIOR.refreshAfter) {
                    return;
                }
            }
            if (!DIRECTORY.has(m.sessionId) && DIRECTORY.size >= DIRECTORY_LIMIT) {
                return;
            }
            DIRECTORY.set(m.sessionId, {
                room: m.room,
                sessionId: m.sessionId,
                coordinatorId: from,
                players: [...m.players],
                epoch: m.epoch,
                sequence: m.sequence,
                issuedAt: m.issuedAt,
                expiresAt: m.expiresAt,
                committed: m.committed,
                pending: m.pending,
            });
            return;
        }
        if (m.op === 'discover') {
            BACKGROUND(advertise());
            return;
        }
        if (m.op === 'grant' || m.op === 'deny') {
            const PENDING = reservationWaiter;
            if (
                !PENDING ||
                to !== directoryId ||
                from !== PENDING.lease.coordinatorId ||
                m.sessionId !== PENDING.lease.sessionId ||
                m.requestId !== PENDING.requestId ||
                m.epoch !== PENDING.lease.epoch
            ) {
                return;
            }
            if (m.op === 'deny') {
                reservationWaiter = null;
                PENDING.reject(
                    m.reason === 'stale-epoch'
                        ? ERROR('PUBLIC_STALE_LEASE', 'public room lease advanced; retry discovery')
                        : ERROR('PUBLIC_RESERVED', 'public room has no available reservation'),
                );
            } else if (Number.isSafeInteger(m.expiresAt) && m.expiresAt > NOW && m.expiresAt <= NOW + 120000) {
                reservationWaiter = null;
                PENDING.resolve({
                    expiresAt: m.expiresAt,
                });
            }
            return;
        }
        if (
            !room ||
            room.closed ||
            room.coordinatorId !== room.localPlayerId ||
            m.sessionId !== room.sessionId ||
            to !== directoryId ||
            !ID_VALID(m.requestId)
        ) {
            return;
        }
        prune();
        if (m.op === 'release') {
            const SEAT = RESERVATIONS.get(from);
            if (SEAT?.requestId === m.requestId) {
                RESERVATIONS.delete(from);
                if (!room.players.includes(from)) {
                    room.disconnect(from);
                }
                BACKGROUND(advertise());
            }
            return;
        }
        if (
            m.op !== 'reserve' ||
            !Number.isSafeInteger(m.expiresAt) ||
            m.expiresAt <= NOW ||
            m.expiresAt > NOW + 120000
        ) {
            return;
        }
        if (m.epoch !== room.epoch) {
            if (Number.isSafeInteger(m.epoch) && m.epoch >= 0 && m.epoch < room.epoch) {
                // Admission can advance while a discovered requester opens its signer.
                // Reply in the request epoch, and advertise the current scope for retry.
                BACKGROUND(advertise(from));
                BACKGROUND(
                    publish(from, 'deny', {
                        sessionId: room.sessionId,
                        epoch: m.epoch,
                        requestId: m.requestId,
                        reason: 'stale-epoch',
                    }),
                );
            }
            return;
        }
        let seat = RESERVATIONS.get(from);
        if (room.players.includes(from)) {
            BACKGROUND(
                publish(from, 'grant', {
                    sessionId: room.sessionId,
                    epoch: room.epoch,
                    requestId: m.requestId,
                    expiresAt: NOW + reservationMs,
                }),
            );
            return;
        }
        if (!seat && room.players.length + RESERVATIONS.size < maxPlayers) {
            seat = {
                requestId: m.requestId,
                expiresAt: Math.min(NOW + reservationMs, m.expiresAt),
                epoch: room.epoch,
            };
            RESERVATIONS.set(from, seat);
        }
        if (seat) {
            seat.requestId = m.requestId;
            // One identity owns one seat. Duplicate requests never extend its lifetime.
            BACKGROUND(
                publish(from, 'grant', {
                    sessionId: room.sessionId,
                    epoch: room.epoch,
                    requestId: m.requestId,
                    expiresAt: seat.expiresAt,
                }),
            );
        } else {
            BACKGROUND(
                publish(from, 'deny', {
                    sessionId: room.sessionId,
                    epoch: room.epoch,
                    requestId: m.requestId,
                }),
            );
        }
        BACKGROUND(advertise());
    }
    async function openDirectory(identity) {
        if (directorySignaler && directoryId === identity.id) {
            return;
        }
        removeDirectory?.();
        directorySignaler?.close();
        PUBLICATIONS.clear();
        const CURRENT = ++generation;
        const SETUP = Promise.resolve()
            .then(() =>
                signalerFactory({
                    room: '0000',
                    namespace: namespace + ':public-v1',
                    relays,
                    timeoutMs: Math.max(1, Math.min(10000, REMAINING())),
                    signal: CONTROLLER.signal,
                    onStatus,
                    maxVerificationsPerSecond: 32,
                    verificationBurst: 20,
                    identity: SHARED(identity),
                }),
            )
            .then((value) => {
                if (disposed || CURRENT !== generation) {
                    value?.close?.();
                    throw ERROR('PUBLIC_CLOSED', 'public directory closed');
                }
                return value;
            });
        try {
            directorySignaler = await bounded(SETUP, REMAINING(), FAIL());
        } catch (cause) {
            throw ERROR('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message);
        }
        if (
            directorySignaler?.id !== identity.id ||
            ['send', 'subscribe', 'close'].some((k) => typeof directorySignaler?.[k] !== 'function')
        ) {
            throw new TypeError('public signaler capability');
        }
        directoryId = identity.id;
        removeDirectory = directorySignaler.subscribe((envelope) => {
            try {
                receive(envelope);
            } catch (cause) {
                STATUS('public-directory-error', {
                    reason: cause.message,
                });
            }
        });
    }
    async function discover() {
        STATUS('public-discovering');
        try {
            await bounded(publish('*', 'discover'), REMAINING(), FAIL());
        } catch (cause) {
            throw ERROR('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message);
        }
        await wait(Math.min(discoveryMs, REMAINING()));
        // A positive relay OK after the observation window distinguishes an empty
        // healthy directory from a subscription that silently lost all relays.
        try {
            await bounded(publish('*', 'discover'), REMAINING(), FAIL());
        } catch (cause) {
            throw ERROR('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message);
        }
        prune();
        const AVAILABLE = [...DIRECTORY.values()]
            .filter((lease) => !lease.refreshAfter && lease.committed + lease.pending < maxPlayers)
            .sort((a, b) => b.committed - a.committed || a.sessionId.localeCompare(b.sessionId));
        if (!AVAILABLE.length && [...DIRECTORY.values()].some((lease) => lease.refreshAfter)) {
            throw ERROR(
                'PUBLIC_HANDOVER_PENDING',
                'public room coordinator changed; waiting for a fresh lease after prior expiry',
            );
        }
        return AVAILABLE;
    }
    async function reserve(lease) {
        const REQUEST_ID = RANDOM_ID(),
            EXPIRES_AT = Date.now() + Math.min(REMAINING(), reservationMs);
        let resolve;
        let reject;
        const RESPONSE = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        reservationWaiter = {
            lease,
            requestId: REQUEST_ID,
            resolve,
            reject,
        };
        RESPONSE.catch(() => {});
        selected = {
            ...lease,
            requestId: REQUEST_ID,
        };
        const ATTEMPT_MS = Math.min(REMAINING(), Math.max(250, discoveryMs * 2));
        try {
            await bounded(
                publish(lease.coordinatorId, 'reserve', {
                    sessionId: lease.sessionId,
                    epoch: lease.epoch,
                    requestId: REQUEST_ID,
                    expiresAt: EXPIRES_AT,
                }),
                ATTEMPT_MS,
                ERROR('PUBLIC_RESERVATION_TIMEOUT', 'public reservation timeout'),
            );
            await bounded(RESPONSE, ATTEMPT_MS, ERROR('PUBLIC_RESERVATION_TIMEOUT', 'public reservation timeout'));
        } finally {
            if (reservationWaiter?.requestId === REQUEST_ID) {
                reservationWaiter = null;
            }
        }
    }
    async function release() {
        if (!selected?.requestId || disposed) {
            return;
        }
        const PRIOR = selected;
        selected = null;
        try {
            await bounded(
                publish(PRIOR.coordinatorId, 'release', {
                    sessionId: PRIOR.sessionId,
                    epoch: PRIOR.epoch,
                    requestId: PRIOR.requestId,
                }),
                Math.min(REMAINING(), 1000),
                FAIL(),
            );
        } catch {
            // Releasing a reservation is best-effort within its bounded timeout.
        }
    }
    function savePointer(committed = false) {
        if (!resume || !room || resumeForgotten) {
            return;
        }
        if (room.players.includes(room.localPlayerId)) {
            everAdmitted = true;
        }
        if (committed && everAdmitted && !room.players.includes(room.localPlayerId)) {
            resumeForgotten = true;
            resume.storage.removeItem(pointerKey);
            return;
        }
        if (room.joining) {
            return;
        }
        storedUntil ??= STARTED_WALL_AT + (resume.lifetimeMs ?? 8 * 60 * 60 * 1000);
        resume.storage.setItem(
            pointerKey,
            JSON.stringify({
                version: 1,
                namespace,
                simulationVersion,
                room: room.room,
                sessionId: room.sessionId,
                expiresAt: storedUntil,
            }),
        );
    }
    async function connect(lease, restoring = false) {
        const CODE = lease?.room ?? RANDOM_ROOM();
        let cancelled = false;
        const ATTEMPT_CONTROLLER = new AbortController(),
            ABORT_ATTEMPT = () => ATTEMPT_CONTROLLER.abort();
        CONTROLLER.signal.addEventListener('abort', ABORT_ATTEMPT, {
            once: true,
        });
        if (CONTROLLER.signal.aborted) {
            ABORT_ATTEMPT();
        }
        const ATTEMPT_TIMEOUT = Math.max(
            1,
            Math.min(
                REMAINING(),
                restoring ? totalTimeoutMs : Math.max(discoveryMs * 2, dynamicOptions.peerTimeoutMs ?? 20000),
            ),
        );
        const PENDING = Promise.resolve()
            .then(() =>
                dynamicRoomFactory({
                    ...dynamicOptions,
                    role: lease ? 'join' : 'host',
                    room: CODE,
                    namespace,
                    maxPlayers,
                    timeoutMs: ATTEMPT_TIMEOUT,
                    relays,
                    rtcConfig,
                    resume: SCOPED_RESUME(CODE),
                    signal: ATTEMPT_CONTROLLER.signal,
                    onStatus,
                    expectedSessionId: lease?.sessionId,
                    authorizeJoin: (id) => {
                        prune();
                        return !!room && room.coordinatorId === room.localPlayerId && RESERVATIONS.has(id);
                    },
                    signalerFactory: async (options) => {
                        const IDENTITY = options.identity ?? EPHEMERAL.identity;
                        await openDirectory(IDENTITY);
                        if (ATTEMPT_CONTROLLER.signal.aborted) {
                            throw ERROR('PUBLIC_CLOSED', 'public attempt aborted');
                        }
                        if (lease && !restoring) {
                            await reserve(lease);
                        }
                        const VALUE = await signalerFactory({
                            ...options,
                            identity: SHARED(IDENTITY),
                        });
                        if (disposed) {
                            VALUE?.close?.();
                        }
                        return VALUE;
                    },
                }),
            )
            .then((result) => {
                if (disposed || cancelled) {
                    result?.close?.();
                }
                return result;
            });
        let result;
        try {
            result = await bounded(PENDING, ATTEMPT_TIMEOUT, FAIL('public room connection attempt timeout'));
        } catch (cause) {
            cancelled = true;
            ATTEMPT_CONTROLLER.abort();
            CONTROLLER.signal.removeEventListener('abort', ABORT_ATTEMPT);
            throw cause;
        }
        if (disposed) {
            result?.close?.();
            throw FAIL();
        }
        room = result;
        if ((lease && room.sessionId !== lease.sessionId) || room.localPlayerId !== directoryId) {
            room.close();
            room = null;
            throw ERROR('PUBLIC_SCOPE', 'public room identity/session mismatch');
        }
        return room;
    }
    try {
        await openDirectory(EPHEMERAL.identity);
        if (pointer) {
            STATUS('public-resuming', {
                room: pointer.room,
            });
            // DynamicRoom's stored roster and live-peer challenge decide resume. No
            // fresh world or identity is silently substituted when resume fails.
            await connect(pointer, true);
        } else {
            let lastError;
            const TRIED = new Set();
            for (let attempt = 0; attempt < maxAttempts && !room; attempt++) {
                const AVAILABLE = await discover(),
                    LEASE = AVAILABLE.find((value) => !TRIED.has(`${value.sessionId}:${value.epoch}`));
                if (!LEASE && AVAILABLE.length) {
                    lastError ??= ERROR('PUBLIC_NO_ROOM', 'available public rooms did not accept this connection');
                    break;
                }
                if (!LEASE) {
                    STATUS('public-hosting');
                    await connect(null);
                    break;
                }
                TRIED.add(`${LEASE.sessionId}:${LEASE.epoch}`);
                STATUS('public-joining', {
                    room: LEASE.room,
                    sessionId: LEASE.sessionId,
                });
                try {
                    await connect(LEASE);
                } catch (cause) {
                    lastError = cause;
                    await release();
                    await openDirectory(EPHEMERAL.identity);
                    STATUS('public-attempt-failed', {
                        reason: cause.message,
                    });
                }
            }
            if (!room) {
                throw lastError ?? FAIL();
            }
        }
        savePointer();
        removeRoom = room.subscribe((event) => {
            if (event.type === 'peer-failed' || event.type === 'peer-disconnected') {
                if (RESERVATIONS.delete(event.peerId)) {
                    BACKGROUND(advertise());
                }
            }
            if (event.type === 'room-closed') {
                close(event.reason);
            }
        });
        await bounded(advertise(), REMAINING(), FAIL());
        clearTimeout(setupTimer);
        interval = setInterval(
            () => {
                if (disposed) {
                    return;
                }
                prune();
                if (Date.now() >= nextAdvertisement) {
                    nextAdvertisement = Date.now() + Math.max(30, Math.floor(leaseMs / 3));
                    BACKGROUND(advertise());
                }
            },
            Math.max(10, Math.min(1000, Math.floor(leaseMs / 3))),
        );
        interval.unref?.();
        const CAPABILITY = {};
        for (const KEY of Object.keys(room)) {
            Object.defineProperty(CAPABILITY, KEY, {
                enumerable: true,
                configurable: true,
                get: () => room[KEY],
            });
        }
        Object.defineProperties(CAPABILITY, {
            close: {
                enumerable: true,
                configurable: true,
                value: close,
            },
            setRoster: {
                enumerable: true,
                configurable: true,
                value(value) {
                    room.setRoster(value);
                    prune();
                    savePointer(true);
                    BACKGROUND(advertise());
                },
            },
            forgetResume: {
                enumerable: true,
                configurable: true,
                value() {
                    resumeForgotten = true;
                    room.forgetResume?.();
                    resume?.storage.removeItem(pointerKey);
                },
            },
            publicMetrics: {
                enumerable: true,
                get: () => ({
                    directoryEntries: DIRECTORY.size,
                    pendingReservations: RESERVATIONS.size,
                    pendingPublications: PUBLICATIONS.size,
                }),
            },
            subscribe: {
                enumerable: true,
                configurable: true,
                value(fn) {
                    if (typeof fn !== 'function' || disposed) {
                        throw new TypeError('public room subscriber');
                    }
                    const REMOVE = room.subscribe(fn);
                    OBSERVERS.add(fn);
                    return () => {
                        REMOVE();
                        OBSERVERS.delete(fn);
                    };
                },
            },
        });
        STATUS('public-room-ready', {
            room: room.room,
            sessionId: room.sessionId,
        });
        return CAPABILITY;
    } catch (cause) {
        close(cause.message);
        throw cause;
    }
}
