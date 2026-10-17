import { integer, nowMs } from '../deterministic/utilities.js';
import {
    nostrOrder,
    nostrEncoder,
    nostrRequireCrypto,
    nostrHash,
    nostrVerify,
    nostrSign,
    nostrBytesToNumber,
    nostrToHex,
    nostrFromHex,
    nostrPublicKey,
} from './nostr-crypto.js';
const NOSTR_HEX32 = /^[0-9a-f]{64}$/;
const NOSTR_HEX64 = /^[0-9a-f]{128}$/;
const NOSTR_SIGNAL_TYPES = new Set(['discover', 'presence', 'offer', 'answer', 'ice', 'bye', 'group']);
const NOSTR_CONTENT_LIMIT = 128 * 1024;
const NOSTR_FRESH_SECONDS = 120;
const NOSTR_FUTURE_SECONDS = 30;
function nostrIsSignalMessage(nostrMessage) {
    return (
        nostrMessage !== null &&
        typeof nostrMessage === 'object' &&
        !Array.isArray(nostrMessage) &&
        Object.prototype.hasOwnProperty.call(nostrMessage, 'type') &&
        NOSTR_SIGNAL_TYPES.has(nostrMessage.type)
    );
}
function nostrListen(nostrSocket, nostrType, nostrHandler) {
    if (typeof nostrSocket.addEventListener === 'function') {
        nostrSocket.addEventListener(nostrType, nostrHandler);
        return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
    }
    const NOSTR_PROPERTY = `on${nostrType}`;
    nostrSocket[NOSTR_PROPERTY] = nostrHandler;
    return () => {
        if (nostrSocket[NOSTR_PROPERTY] === nostrHandler) {
            nostrSocket[NOSTR_PROPERTY] = null;
        }
    };
}

/** Public-relay discovery/SDP/ICE only. Game input and state belong on WebRTC. */
export async function createNostrSignaler({
    room,
    namespace = 'rollback-netcode',
    relays = ['wss://relay.primal.net', 'wss://relay.damus.io'],
    timeoutMs = 10000,
    onStatus = () => {},
    WebSocketImpl: webSocketImpl = globalThis.WebSocket,
    cryptoImpl = globalThis.crypto,
    signal,
    publishIntervalMs = 500,
    maxVerificationsPerSecond = 16,
    verificationBurst = 8,
    identity,
} = {}) {
    if (signal?.aborted) {
        throw new Error('Nostr signaler aborted');
    }
    if (typeof room !== 'string' || !/^\d{4}$/.test(room)) {
        throw new TypeError('room must contain exactly four ASCII digits');
    }
    if (typeof namespace !== 'string' || namespace.trim().length === 0 || nostrEncoder.encode(namespace).length > 128) {
        throw new TypeError('namespace must be a nonempty string of at most 128 UTF-8 bytes');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
        throw new RangeError('timeoutMs must be greater than zero and at most 120000');
    }
    integer(publishIntervalMs, 'publishIntervalMs', 0, 10000);
    integer(maxVerificationsPerSecond, 'maxVerificationsPerSecond', 1, 1024);
    integer(verificationBurst, 'verificationBurst', 1, 32);
    if (typeof webSocketImpl !== 'function') {
        throw new Error('Nostr signaling requires WebSocket support');
    }
    if (typeof onStatus !== 'function') {
        throw new TypeError('onStatus must be a function');
    }
    nostrRequireCrypto(cryptoImpl, true);
    if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) {
        throw new TypeError('relays must contain between 1 and 16 WebSocket URLs');
    }
    const NOSTR_URLS = [
        ...new Set(
            relays.map((nostrRelay) => {
                if (typeof nostrRelay !== 'string') {
                    throw new TypeError('Relay URLs must be strings');
                }
                const NOSTR_URL = new URL(nostrRelay);
                if (
                    !['ws:', 'wss:'].includes(NOSTR_URL.protocol) ||
                    NOSTR_URL.username ||
                    NOSTR_URL.password ||
                    NOSTR_URL.hash
                ) {
                    throw new TypeError('Relays must be ws:// or wss:// URLs without credentials or fragments');
                }
                return NOSTR_URL.href;
            }),
        ),
    ];
    const NOSTR_RANDOM = (nostrLength) => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
    if (
        identity &&
        (!NOSTR_HEX32.test(identity.id) || typeof identity.sign !== 'function' || typeof identity.close !== 'function')
    ) {
        throw new TypeError('Nostr identity capability');
    }
    const NOSTR_SECRET = new Uint8Array(32);
    let nostrSecretReady = !!identity;
    for (let nostrAttempt = 0; !nostrSecretReady && nostrAttempt < 16; nostrAttempt++) {
        NOSTR_SECRET.set(NOSTR_RANDOM(32));
        const NOSTR_VALUE = nostrBytesToNumber(NOSTR_SECRET);
        if (NOSTR_VALUE > 0n && NOSTR_VALUE < nostrOrder) {
            nostrSecretReady = true;
            break;
        }
    }
    if (!nostrSecretReady) {
        NOSTR_SECRET.fill(0);
        throw new Error('Secure random secret generation failed');
    }
    const NOSTR_ID = identity?.id ?? nostrToHex(nostrPublicKey(NOSTR_SECRET));
    const NOSTR_ROOM_TAG = `${namespace}:${room}`;
    const NOSTR_SUBSCRIPTION = `rn-${nostrToHex(NOSTR_RANDOM(16))}`;
    const NOSTR_LISTENERS = new Set();
    const NOSTR_BACKLOG = [];
    const NOSTR_SEEN = new Map();
    const NOSTR_VERIFYING = new Set();
    const NOSTR_PENDING = new Map();
    const NOSTR_STATES = [];
    let verificationTokens = verificationBurst;
    let verificationAt = nowMs();
    const VERIFICATION_METRICS = {
        attempted: 0,
        verified: 0,
        throttled: 0,
        totalVerificationMs: 0,
        maxVerificationMs: 0,
    };
    let nostrClosed = false;
    let nostrSending = 0;
    let nostrSendTail = Promise.resolve();
    let nostrLastPublication = -Infinity;
    const NOSTR_WAITERS = new Map();
    let nostrHasSubscriber = false;
    let nostrReadyResolve;
    let nostrReadyReject;
    let nostrInitializationSettled = false;
    const NOSTR_READY = new Promise((nostrResolve, nostrReject) => {
        nostrReadyResolve = nostrResolve;
        nostrReadyReject = nostrReject;
    });
    const NOSTR_STATUS = (nostrStatusName, nostrRelay, nostrMessage) => {
        if (nostrClosed && nostrStatusName !== 'closed') {
            return;
        }
        try {
            onStatus({
                type: 'signaler',
                transport: 'nostr',
                status: nostrStatusName,
                ...(nostrRelay
                    ? {
                          relay: nostrRelay,
                      }
                    : {}),
                ...(nostrMessage
                    ? {
                          message: String(nostrMessage),
                      }
                    : {}),
            });
        } catch {
            /* An observer cannot break signaling. */
        }
    };
    function nostrFinishPublication(nostrEventId, nostrError) {
        const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrEventId);
        if (!NOSTR_PUBLICATION) {
            return;
        }
        clearTimeout(NOSTR_PUBLICATION.timer);
        NOSTR_PENDING.delete(nostrEventId);
        if (nostrError) {
            NOSTR_PUBLICATION.reject(nostrError);
        } else {
            NOSTR_PUBLICATION.resolve();
        }
    }
    function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
        const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrEventId);
        if (!NOSTR_PUBLICATION || !NOSTR_PUBLICATION.remaining.delete(nostrState)) {
            return;
        }
        NOSTR_PUBLICATION.failures.push(`${nostrState.url}: ${nostrReason}`);
        if (
            NOSTR_PUBLICATION.remaining.size === 0 &&
            !NOSTR_STATES.some((nostrRelay) => !nostrRelay.failed && !nostrRelay.ready)
        ) {
            nostrFinishPublication(
                nostrEventId,
                new Error(`No Nostr relay accepted the event: ${NOSTR_PUBLICATION.failures.join('; ')}`),
            );
        }
    }
    function nostrFailRelay(nostrState, nostrReason) {
        if (nostrState.failed || nostrClosed) {
            return;
        }
        nostrState.failed = true;
        nostrState.ready = false;
        clearTimeout(nostrState.timer);
        for (const NOSTR_REMOVE of nostrState.remove) {
            NOSTR_REMOVE();
        }
        try {
            nostrState.socket?.close();
        } catch {
            /* Already closed. */
        }
        for (const NOSTR_EVENT_ID of NOSTR_PENDING.keys()) {
            nostrPublicationFailure(nostrState, NOSTR_EVENT_ID, nostrReason);
        }
        NOSTR_STATUS('error', nostrState.url, nostrReason);
        if (
            !nostrInitializationSettled &&
            NOSTR_STATES.length === NOSTR_URLS.length &&
            NOSTR_STATES.every((nostrRelay) => nostrRelay.failed)
        ) {
            nostrInitializationSettled = true;
            nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
        }
    }
    function nostrDeliver(nostrEnvelope) {
        if (nostrClosed) {
            return;
        }
        if (!nostrHasSubscriber) {
            if (NOSTR_BACKLOG.length === 32) {
                NOSTR_BACKLOG.shift();
            }
            NOSTR_BACKLOG.push(nostrEnvelope);
            return;
        }
        for (const NOSTR_HANDLER of [...NOSTR_LISTENERS]) {
            if (nostrClosed) {
                break;
            }
            try {
                const NOSTR_RESULT = NOSTR_HANDLER(nostrEnvelope);
                if (NOSTR_RESULT && typeof NOSTR_RESULT.then === 'function') {
                    Promise.resolve(NOSTR_RESULT).catch((nostrError) =>
                        NOSTR_STATUS('error', null, nostrError?.message || 'Signaling subscriber failed'),
                    );
                }
            } catch (nostrError) {
                NOSTR_STATUS('error', null, nostrError?.message || 'Signaling subscriber failed');
            }
        }
    }
    async function nostrReceive(nostrEvent) {
        if (
            nostrClosed ||
            !nostrEvent ||
            typeof nostrEvent !== 'object' ||
            Array.isArray(nostrEvent) ||
            typeof nostrEvent.id !== 'string' ||
            typeof nostrEvent.pubkey !== 'string' ||
            typeof nostrEvent.sig !== 'string' ||
            !NOSTR_HEX32.test(nostrEvent.id) ||
            !NOSTR_HEX32.test(nostrEvent.pubkey) ||
            !NOSTR_HEX64.test(nostrEvent.sig) ||
            nostrEvent.pubkey === NOSTR_ID ||
            nostrEvent.kind !== 20078 ||
            !Number.isSafeInteger(nostrEvent.created_at) ||
            typeof nostrEvent.content !== 'string' ||
            nostrEvent.content.length > NOSTR_CONTENT_LIMIT ||
            !Array.isArray(nostrEvent.tags) ||
            nostrEvent.tags.length > 16 ||
            NOSTR_VERIFYING.size >= 32
        ) {
            return;
        }
        const NOSTR_NOW = Date.now();
        const NOSTR_NOW_SECONDS = Math.floor(NOSTR_NOW / 1000);
        if (
            nostrEvent.created_at < NOSTR_NOW_SECONDS - NOSTR_FRESH_SECONDS ||
            nostrEvent.created_at > NOSTR_NOW_SECONDS + NOSTR_FUTURE_SECONDS ||
            nostrEncoder.encode(nostrEvent.content).length > NOSTR_CONTENT_LIMIT
        ) {
            return;
        }
        for (const [NOSTR_SEEN_ID, NOSTR_EXPIRY] of NOSTR_SEEN) {
            if (NOSTR_EXPIRY > NOSTR_NOW) {
                break;
            }
            NOSTR_SEEN.delete(NOSTR_SEEN_ID);
        }
        if (NOSTR_SEEN.has(nostrEvent.id) || NOSTR_VERIFYING.has(nostrEvent.id)) {
            return;
        }
        if (
            !nostrEvent.tags.every(
                (nostrTag) =>
                    Array.isArray(nostrTag) &&
                    nostrTag.length > 0 &&
                    nostrTag.length <= 4 &&
                    nostrTag.every(
                        (nostrValue) => typeof nostrValue === 'string' && nostrEncoder.encode(nostrValue).length <= 256,
                    ),
            )
        ) {
            return;
        }
        const NOSTR_ROOM_TAGS = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === 'd');
        const NOSTR_RECIPIENT_TAGS = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === 'p');
        if (NOSTR_ROOM_TAGS.length !== 1 || NOSTR_ROOM_TAGS[0][1] !== NOSTR_ROOM_TAG) {
            return;
        }
        let nostrContent;
        try {
            nostrContent = JSON.parse(nostrEvent.content);
        } catch {
            return;
        }
        if (
            !nostrContent ||
            nostrContent.v !== 1 ||
            nostrContent.namespace !== namespace ||
            nostrContent.room !== room ||
            nostrContent.from !== nostrEvent.pubkey ||
            typeof nostrContent.nonce !== 'string' ||
            !/^[0-9a-f]{32}$/.test(nostrContent.nonce) ||
            (nostrContent.to !== '*' && nostrContent.to !== NOSTR_ID) ||
            !nostrIsSignalMessage(nostrContent.message)
        ) {
            return;
        }
        if (
            nostrContent.to === '*'
                ? NOSTR_RECIPIENT_TAGS.length !== 0
                : NOSTR_RECIPIENT_TAGS.length !== 1 || NOSTR_RECIPIENT_TAGS[0][1] !== nostrContent.to
        ) {
            return;
        }
        const MEASURED_NOW = nowMs();
        verificationTokens = Math.min(
            verificationBurst,
            verificationTokens + (Math.max(0, MEASURED_NOW - verificationAt) * maxVerificationsPerSecond) / 1000,
        );
        verificationAt = MEASURED_NOW;
        if (verificationTokens < 1) {
            VERIFICATION_METRICS.throttled++;
            return;
        }
        verificationTokens--;
        VERIFICATION_METRICS.attempted++;
        NOSTR_VERIFYING.add(nostrEvent.id);
        try {
            const NOSTR_HASH_BYTES = await nostrHash(
                nostrEncoder.encode(
                    JSON.stringify([
                        0,
                        nostrEvent.pubkey,
                        nostrEvent.created_at,
                        nostrEvent.kind,
                        nostrEvent.tags,
                        nostrEvent.content,
                    ]),
                ),
                cryptoImpl,
            );
            if (
                nostrToHex(NOSTR_HASH_BYTES) !== nostrEvent.id ||
                !(await nostrVerify(
                    nostrFromHex(nostrEvent.sig),
                    NOSTR_HASH_BYTES,
                    nostrFromHex(nostrEvent.pubkey),
                    cryptoImpl,
                )) ||
                nostrClosed
            ) {
                return;
            }
            if (NOSTR_SEEN.size >= 2048) {
                NOSTR_SEEN.delete(NOSTR_SEEN.keys().next().value);
            }
            NOSTR_SEEN.set(nostrEvent.id, NOSTR_NOW + 300000);
            VERIFICATION_METRICS.verified++;
            nostrDeliver({
                from: nostrContent.from,
                to: nostrContent.to,
                message: nostrContent.message,
            });
        } catch (nostrError) {
            NOSTR_STATUS('error', null, nostrError?.message || 'Nostr verification failed');
        } finally {
            NOSTR_VERIFYING.delete(nostrEvent.id);
            const ELAPSED = nowMs() - MEASURED_NOW;
            VERIFICATION_METRICS.totalVerificationMs += ELAPSED;
            VERIFICATION_METRICS.maxVerificationMs = Math.max(VERIFICATION_METRICS.maxVerificationMs, ELAPSED);
        }
    }
    function nostrHandleMessage(nostrState, nostrData) {
        if (nostrClosed || nostrState.failed || typeof nostrData !== 'string' || nostrData.length > 1024 * 1024) {
            return;
        }
        let nostrFrame;
        try {
            nostrFrame = JSON.parse(nostrData);
        } catch {
            return;
        }
        if (!Array.isArray(nostrFrame)) {
            return;
        }
        if (
            nostrFrame[0] === 'EOSE' &&
            nostrFrame.length === 2 &&
            nostrFrame[1] === NOSTR_SUBSCRIPTION &&
            nostrState.requested
        ) {
            if (nostrState.ready) {
                return;
            }
            nostrState.ready = true;
            clearTimeout(nostrState.timer);
            NOSTR_STATUS('connected', nostrState.url);
            if (!nostrInitializationSettled) {
                nostrInitializationSettled = true;
                nostrReadyResolve();
            }
            // A fast relay can reject a publication while a fallback is still opening.
            // Forward the same signed event when that fallback becomes ready.
            for (const NOSTR_PUBLICATION of NOSTR_PENDING.values()) {
                if (!NOSTR_PUBLICATION.attempted.has(nostrState)) {
                    NOSTR_PUBLICATION.attempted.add(nostrState);
                    NOSTR_PUBLICATION.remaining.add(nostrState);
                    try {
                        nostrState.socket.send(NOSTR_PUBLICATION.frame);
                    } catch (nostrError) {
                        nostrFailRelay(nostrState, nostrError?.message || 'Fallback publication failed');
                    }
                }
            }
        } else if (
            nostrFrame[0] === 'EVENT' &&
            nostrFrame.length === 3 &&
            nostrFrame[1] === NOSTR_SUBSCRIPTION &&
            nostrState.requested
        ) {
            void nostrReceive(nostrFrame[2]);
        } else if (
            nostrFrame[0] === 'OK' &&
            nostrFrame.length === 4 &&
            typeof nostrFrame[1] === 'string' &&
            typeof nostrFrame[2] === 'boolean' &&
            typeof nostrFrame[3] === 'string'
        ) {
            const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrFrame[1]);
            if (!NOSTR_PUBLICATION?.remaining.has(nostrState)) {
                return;
            }
            if (nostrFrame[2]) {
                nostrFinishPublication(nostrFrame[1]);
                NOSTR_STATUS('published', nostrState.url);
            } else {
                nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || 'Relay rejected the event');
            }
        } else if (
            nostrFrame[0] === 'CLOSED' &&
            nostrFrame.length === 3 &&
            nostrFrame[1] === NOSTR_SUBSCRIPTION &&
            typeof nostrFrame[2] === 'string'
        ) {
            nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
        } else if (nostrFrame[0] === 'NOTICE' && typeof nostrFrame[1] === 'string') {
            NOSTR_STATUS('notice', nostrState.url, nostrFrame[1].slice(0, 256));
        }
    }
    function nostrClose() {
        if (nostrClosed) {
            return;
        }
        nostrClosed = true;
        signal?.removeEventListener('abort', nostrClose);
        for (const [NOSTR_TIMER, NOSTR_REJECT] of NOSTR_WAITERS) {
            clearTimeout(NOSTR_TIMER);
            NOSTR_REJECT(new Error('Nostr signaler closed'));
        }
        NOSTR_WAITERS.clear();
        for (const NOSTR_STATE of NOSTR_STATES) {
            clearTimeout(NOSTR_STATE.timer);
            if (NOSTR_STATE.socket?.readyState === 1 && NOSTR_STATE.requested) {
                try {
                    NOSTR_STATE.socket.send(JSON.stringify(['CLOSE', NOSTR_SUBSCRIPTION]));
                } catch {
                    /* Best-effort unsubscribe. */
                }
            }
            for (const NOSTR_REMOVE of NOSTR_STATE.remove) {
                NOSTR_REMOVE();
            }
            try {
                NOSTR_STATE.socket?.close();
            } catch {
                /* Already closed. */
            }
            NOSTR_STATE.ready = false;
        }
        for (const NOSTR_EVENT_ID of NOSTR_PENDING.keys()) {
            nostrFinishPublication(NOSTR_EVENT_ID, new Error('Nostr signaler closed'));
        }
        if (!nostrInitializationSettled) {
            nostrInitializationSettled = true;
            nostrReadyReject(new Error('Nostr signaler closed'));
        }
        NOSTR_SECRET.fill(0);
        identity?.close();
        NOSTR_LISTENERS.clear();
        NOSTR_BACKLOG.length = 0;
        NOSTR_SEEN.clear();
        NOSTR_VERIFYING.clear();
        NOSTR_STATUS('closed');
    }
    signal?.addEventListener('abort', nostrClose, {
        once: true,
    });
    for (const NOSTR_URL of NOSTR_URLS) {
        if (nostrClosed) {
            break;
        }
        const NOSTR_STATE = {
            url: NOSTR_URL,
            socket: null,
            ready: false,
            requested: false,
            failed: false,
            remove: [],
            timer: null,
        };
        NOSTR_STATES.push(NOSTR_STATE);
        NOSTR_STATUS('connecting', NOSTR_URL);
        if (nostrClosed) {
            break;
        }
        try {
            const NOSTR_SOCKET = (NOSTR_STATE.socket = new webSocketImpl(NOSTR_URL));
            if (nostrClosed) {
                try {
                    NOSTR_SOCKET.close();
                } catch {
                    /* Already closed. */
                }
                break;
            }
            NOSTR_STATE.timer = setTimeout(
                () => nostrFailRelay(NOSTR_STATE, 'Nostr connection/subscription timed out'),
                timeoutMs,
            );
            const NOSTR_OPEN = () => {
                if (nostrClosed || NOSTR_STATE.failed || NOSTR_STATE.requested) {
                    return;
                }
                NOSTR_STATE.requested = true;
                try {
                    NOSTR_SOCKET.send(
                        JSON.stringify([
                            'REQ',
                            NOSTR_SUBSCRIPTION,
                            {
                                kinds: [20078],
                                '#d': [NOSTR_ROOM_TAG],
                                since: Math.floor(Date.now() / 1000) - NOSTR_FRESH_SECONDS,
                                limit: 0,
                            },
                        ]),
                    );
                } catch (nostrError) {
                    nostrFailRelay(NOSTR_STATE, nostrError?.message || 'Nostr subscription failed');
                }
            };
            NOSTR_STATE.remove.push(
                nostrListen(NOSTR_SOCKET, 'open', NOSTR_OPEN),
                nostrListen(NOSTR_SOCKET, 'message', (nostrEvent) => nostrHandleMessage(NOSTR_STATE, nostrEvent.data)),
                nostrListen(NOSTR_SOCKET, 'error', () => nostrFailRelay(NOSTR_STATE, 'Nostr WebSocket error')),
                nostrListen(NOSTR_SOCKET, 'close', () => nostrFailRelay(NOSTR_STATE, 'Nostr relay disconnected')),
            );
            if (NOSTR_SOCKET.readyState === 1) {
                NOSTR_OPEN();
            }
        } catch (nostrError) {
            nostrFailRelay(NOSTR_STATE, nostrError?.message || 'Nostr connection failed');
        }
    }
    try {
        await NOSTR_READY;
    } catch (nostrError) {
        nostrClose();
        throw nostrError;
    }
    return {
        id: NOSTR_ID,
        room,
        get metrics() {
            return {
                ...VERIFICATION_METRICS,
            };
        },
        async send(nostrTo, nostrMessage) {
            if (nostrClosed) {
                throw new Error('Nostr signaler closed');
            }
            if (nostrTo !== '*' && (typeof nostrTo !== 'string' || !NOSTR_HEX32.test(nostrTo))) {
                throw new TypeError('Nostr recipient must be a lowercase public key or *');
            }
            if (!nostrIsSignalMessage(nostrMessage)) {
                throw new TypeError(
                    'Nostr carries discovery, presence, offer, answer, ice, bye and group signaling only',
                );
            }
            if (nostrSending >= 64) {
                throw new Error('Too many pending Nostr publications');
            }
            if (
                !NOSTR_STATES.some(
                    (nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1,
                )
            ) {
                throw new Error('No live Nostr relays');
            }
            nostrSending++;
            const NOSTR_PREVIOUS = nostrSendTail;
            let nostrUnlock;
            nostrSendTail = new Promise((nostrResolve) => {
                nostrUnlock = nostrResolve;
            });
            try {
                let nostrContent;
                try {
                    nostrContent = JSON.stringify({
                        v: 1,
                        namespace,
                        room,
                        from: NOSTR_ID,
                        to: nostrTo,
                        nonce: nostrToHex(NOSTR_RANDOM(16)),
                        message: nostrMessage,
                    });
                } catch {
                    throw new TypeError('Nostr signaling message must be JSON serializable');
                }
                if (nostrEncoder.encode(nostrContent).length > NOSTR_CONTENT_LIMIT) {
                    throw new RangeError('Nostr signaling content exceeds 128 KiB');
                }
                if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) {
                    throw new TypeError('Nostr signaling message serialization changed its type');
                }
                await NOSTR_PREVIOUS;
                if (nostrClosed) {
                    throw new Error('Nostr signaler closed');
                }
                const NOSTR_WAIT = publishIntervalMs - (Date.now() - nostrLastPublication);
                if (NOSTR_WAIT > 0) {
                    await new Promise((nostrResolve, nostrReject) => {
                        const NOSTR_TIMER = setTimeout(() => {
                            NOSTR_WAITERS.delete(NOSTR_TIMER);
                            nostrResolve();
                        }, NOSTR_WAIT);
                        NOSTR_WAITERS.set(NOSTR_TIMER, nostrReject);
                    });
                }
                if (nostrClosed) {
                    throw new Error('Nostr signaler closed');
                }
                const NOSTR_EVENT = {
                    pubkey: NOSTR_ID,
                    created_at: Math.floor(Date.now() / 1000),
                    kind: 20078,
                    tags: [['d', NOSTR_ROOM_TAG], ...(nostrTo === '*' ? [] : [['p', nostrTo]])],
                    content: nostrContent,
                };
                const NOSTR_HASH_BYTES = await nostrHash(
                    nostrEncoder.encode(
                        JSON.stringify([
                            0,
                            NOSTR_ID,
                            NOSTR_EVENT.created_at,
                            NOSTR_EVENT.kind,
                            NOSTR_EVENT.tags,
                            nostrContent,
                        ]),
                    ),
                    cryptoImpl,
                );
                if (nostrClosed) {
                    throw new Error('Nostr signaler closed');
                }
                const NOSTR_AUXILIARY = NOSTR_RANDOM(32);
                try {
                    NOSTR_EVENT.sig = nostrToHex(
                        await (identity
                            ? identity.sign(NOSTR_HASH_BYTES, NOSTR_AUXILIARY, cryptoImpl)
                            : nostrSign(NOSTR_HASH_BYTES, NOSTR_SECRET, NOSTR_AUXILIARY, cryptoImpl)),
                    );
                } finally {
                    NOSTR_AUXILIARY.fill(0);
                }
                NOSTR_EVENT.id = nostrToHex(NOSTR_HASH_BYTES);
                if (nostrClosed) {
                    throw new Error('Nostr signaler closed');
                }
                const NOSTR_AVAILABLE = NOSTR_STATES.filter(
                    (nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1,
                );
                if (NOSTR_AVAILABLE.length === 0) {
                    throw new Error('No live Nostr relays');
                }
                const NOSTR_FRAME = JSON.stringify(['EVENT', NOSTR_EVENT]);
                nostrLastPublication = Date.now();
                await new Promise((nostrResolve, nostrReject) => {
                    const NOSTR_PUBLICATION = {
                        resolve: nostrResolve,
                        reject: nostrReject,
                        remaining: new Set(NOSTR_AVAILABLE),
                        attempted: new Set(NOSTR_AVAILABLE),
                        frame: NOSTR_FRAME,
                        failures: [],
                        timer: null,
                    };
                    NOSTR_PENDING.set(NOSTR_EVENT.id, NOSTR_PUBLICATION);
                    NOSTR_PUBLICATION.timer = setTimeout(
                        () =>
                            nostrFinishPublication(
                                NOSTR_EVENT.id,
                                new Error('Nostr publication timed out without a positive relay OK'),
                            ),
                        timeoutMs,
                    );
                    for (const NOSTR_STATE of NOSTR_AVAILABLE) {
                        if (nostrClosed) {
                            break;
                        }
                        try {
                            NOSTR_STATE.socket.send(NOSTR_FRAME);
                        } catch (nostrError) {
                            nostrFailRelay(NOSTR_STATE, nostrError?.message || 'Nostr publication failed');
                        }
                    }
                });
            } finally {
                await NOSTR_PREVIOUS;
                nostrSending--;
                nostrUnlock();
            }
        },
        subscribe(nostrHandler) {
            if (nostrClosed) {
                throw new Error('Nostr signaler closed');
            }
            if (typeof nostrHandler !== 'function') {
                throw new TypeError('Signaling subscriber must be a function');
            }
            NOSTR_LISTENERS.add(nostrHandler);
            if (!nostrHasSubscriber) {
                nostrHasSubscriber = true;
                const NOSTR_QUEUED = NOSTR_BACKLOG.splice(0);
                for (const NOSTR_ENVELOPE of NOSTR_QUEUED) {
                    nostrDeliver(NOSTR_ENVELOPE);
                }
            }
            return () => NOSTR_LISTENERS.delete(nostrHandler);
        },
        close: nostrClose,
    };
}
