import { PROTOCOL_VERSION } from '../_rollback-shared/protocol.js';
import { integer } from '../deterministic/utilities.js';
import { createWebRTCPeer } from './webrtc.js';
import { createNostrSignaler } from './nostr.js';
/** Two-player room discovery is an optional capability, separate from the fixed-roster core. */
export async function createNostrRoom({
    role,
    room,
    namespace = 'rollback-netcode',
    relays,
    rtcConfig,
    timeoutMs = 30000,
    onStatus = () => {},
    signal,
    signalerFactory = createNostrSignaler,
    peerFactory = createWebRTCPeer,
} = {}) {
    if (!['host', 'join'].includes(role)) {
        throw new TypeError('room role');
    }
    integer(timeoutMs, 'timeoutMs', 1, 120000);
    if (typeof signalerFactory !== 'function' || typeof peerFactory !== 'function') {
        throw new TypeError('room adapter factories');
    }
    if (signal?.aborted) {
        throw new Error('room aborted');
    }
    if (!room && role === 'host') {
        const VALUE = new Uint32Array(1);
        globalThis.crypto.getRandomValues(VALUE);
        room = String(VALUE[0] % 10000).padStart(4, '0');
    }
    if (!/^\d{4}$/.test(room ?? '')) {
        throw new TypeError('four-digit room');
    }
    const CONTROLLER = new AbortController();
    const EXTERNAL_ABORT = () => CONTROLLER.abort(signal?.reason);
    signal?.addEventListener('abort', EXTERNAL_ABORT, {
        once: true,
    });
    const ROOM_SIGNAL = CONTROLLER.signal;
    let signaler;
    try {
        signaler = await signalerFactory({
            room,
            namespace,
            relays,
            timeoutMs: Math.min(timeoutMs, 10000),
            onStatus,
            signal: ROOM_SIGNAL,
        });
    } catch (error) {
        signal?.removeEventListener('abort', EXTERNAL_ABORT);
        throw error;
    }
    if (ROOM_SIGNAL.aborted) {
        signaler.close();
        signal?.removeEventListener('abort', EXTERNAL_ABORT);
        throw new Error('room aborted');
    }
    return new Promise((resolve, reject) => {
        let connection;
        let unsubscribe;
        let pulse;
        let deadline;
        let collisionTimer;
        let disposed = false;
        let connecting = false;
        let completed = false;
        let selectedPeer;
        let checking = role === 'host';
        const NONCE = new Uint8Array(16);
        globalThis.crypto.getRandomValues(NONCE);
        let sessionId = [...NONCE].map((n) => n.toString(16).padStart(2, '0')).join('');
        const STATUS = (value) => {
            try {
                onStatus(value);
            } catch {
                /* Presentation observer. */
            }
        };
        const CLOSE = () => {
            if (disposed) {
                return;
            }
            disposed = true;
            clearInterval(pulse);
            clearTimeout(deadline);
            clearTimeout(collisionTimer);
            unsubscribe?.();
            ROOM_SIGNAL.removeEventListener('abort', ABORT);
            signal?.removeEventListener('abort', EXTERNAL_ABORT);
            CONTROLLER.abort();
            connection?.close();
            signaler.close();
        };
        const FAIL = (error) => {
            if (!completed) {
                completed = true;
                reject(error);
            }
            CLOSE();
        };
        const ABORT = () => FAIL(new Error('room aborted'));
        ROOM_SIGNAL.addEventListener('abort', ABORT, {
            once: true,
        });
        const SEND = (to, message) => signaler.send(to, message).catch(FAIL);
        const PRESENCE = (to) =>
            SEND(to, {
                type: 'presence',
                room,
                namespace,
                host: signaler.id,
                sessionId,
                protocol: PROTOCOL_VERSION,
            });
        const CONNECT = (remoteId) => {
            if (connecting || disposed) {
                return;
            }
            connecting = true;
            selectedPeer = remoteId;
            Promise.resolve()
                .then(() =>
                    peerFactory({
                        initiator: role === 'join',
                        signaler,
                        remoteId,
                        rtcConfig,
                        timeoutMs: Math.min(timeoutMs, 20000),
                        onStatus,
                        signal: ROOM_SIGNAL,
                    }),
                )
                .then((value) => {
                    if (disposed) {
                        value.close();
                        return;
                    }
                    connection = value;
                    completed = true;
                    clearInterval(pulse);
                    clearTimeout(deadline);
                    clearTimeout(collisionTimer);
                    unsubscribe?.();
                    resolve({
                        room,
                        sessionId,
                        localPlayerId: role === 'host' ? 'a' : 'b',
                        remotePlayerId: role === 'host' ? 'b' : 'a',
                        transport: value.transport,
                        peerConnection: value.peerConnection,
                        close: CLOSE,
                    });
                })
                .catch(FAIL);
        };
        unsubscribe = signaler.subscribe(({ from, to, message }) => {
            if (disposed || from === signaler.id) {
                return;
            }
            if (role === 'host') {
                if (message.type === 'presence' && message.host === from && message.protocol === PROTOCOL_VERSION) {
                    FAIL(new Error('room code is already in use; choose another four-digit code'));
                    return;
                }
                if (message.type === 'discover' && !checking && (!selectedPeer || selectedPeer === from)) {
                    // Install the answer subscription before advertising to this joiner.
                    CONNECT(from);
                    PRESENCE(from);
                }
            } else if (
                message.type === 'presence' &&
                message.host === from &&
                message.protocol === PROTOCOL_VERSION &&
                typeof message.sessionId === 'string'
            ) {
                if (selectedPeer && selectedPeer !== from) {
                    return;
                }
                selectedPeer = from;
                if (to === signaler.id) {
                    sessionId = message.sessionId;
                    CONNECT(from);
                } else {
                    SEND(from, {
                        type: 'discover',
                    });
                }
            }
        });
        if (disposed) {
            unsubscribe?.();
            return;
        }
        deadline = setTimeout(() => FAIL(new Error('room discovery timeout')), timeoutMs);
        const ADVERTISE = () => {
            if (disposed || connecting || checking) {
                return;
            }
            if (role === 'host') {
                PRESENCE('*');
            } else {
                SEND(selectedPeer ?? '*', {
                    type: 'discover',
                });
            }
        };
        pulse = setInterval(ADVERTISE, 1000);
        STATUS({
            type: 'room',
            room,
            role,
        });
        if (disposed) {
            return;
        }
        if (checking) {
            collisionTimer = setTimeout(() => {
                checking = false;
                ADVERTISE();
            }, 1200);
        } else {
            ADVERTISE();
        }
    });
}
