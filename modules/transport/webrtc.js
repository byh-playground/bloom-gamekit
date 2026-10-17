import { CHUNK_SIZE, TYPE, HEADER } from '../_rollback-shared/protocol.js';
import { integer, bytes } from '../deterministic/utilities.js';
/** Transport capability adapter. Channel reliability is independent of ordering. */
export class WebRTCTransport {
    constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
        if (!controlChannel || typeof controlChannel.send !== 'function') {
            throw new TypeError('controlChannel');
        }
        integer(highWaterMark, 'highWaterMark', CHUNK_SIZE, 16 * 1024 * 1024);
        integer(lowWaterMark, 'lowWaterMark', 0, highWaterMark);
        this.inputChannel = inputChannel ?? controlChannel;
        this.controlChannel = controlChannel;
        this.highWaterMark = highWaterMark;
        this.listeners = new Set();
        this.statusListeners = new Set();
        this.closed = false;
        this.connectionState = 'connected';
        this._lastStatus = null;
        this.channels = [...new Set([this.inputChannel, this.controlChannel])];
        this._onMessage = async (event) => {
            if (this.closed) {
                return;
            }
            let data = event.data;
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                if (data.size > CHUNK_SIZE) {
                    return;
                }
                data = await data.arrayBuffer();
            }
            if (this.closed) {
                return;
            }
            try {
                const B = bytes(data);
                if (B.length > CHUNK_SIZE) {
                    return;
                }
                for (const LISTENER of this.listeners) {
                    LISTENER(B.slice());
                }
            } catch {
                /* Malformed external messages are not JS evaluation. */
            }
        };
        for (const CHANNEL of this.channels) {
            CHANNEL.binaryType = 'arraybuffer';
            CHANNEL.bufferedAmountLowThreshold = lowWaterMark;
            CHANNEL.addEventListener('message', this._onMessage);
            CHANNEL.addEventListener('open', (this._onStatus = this._onStatus ?? (() => this._notifyStatus())));
            CHANNEL.addEventListener('close', this._onStatus);
            CHANNEL.addEventListener(
                'error',
                (this._onChannelError =
                    this._onChannelError ??
                    (() => {
                        this.connectionState = 'failed';
                        this._notifyStatus();
                    })),
            );
        }
    }
    get state() {
        if (
            this.closed ||
            this.connectionState === 'closed' ||
            this.channels.some((c) => c.readyState === 'closed' || c.readyState === 'closing')
        ) {
            return 'closed';
        }
        if (this.connectionState === 'failed') {
            return 'failed';
        }
        if (this.connectionState === 'disconnected') {
            return 'interrupted';
        }
        return this.channels.every((c) => c.readyState === 'open') ? 'open' : 'connecting';
    }
    _notifyStatus() {
        const STATE = this.state;
        if (STATE === this._lastStatus) {
            return;
        }
        this._lastStatus = STATE;
        for (const LISTENER of this.statusListeners) {
            try {
                LISTENER(STATE);
            } catch {
                // One status listener must not block the remaining listeners.
            }
        }
    }
    setConnectionState(state) {
        this.connectionState = state;
        this._notifyStatus();
    }
    subscribeStatus(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('status subscriber');
        }
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }
    get bufferedAmount() {
        return this.channels.reduce((n, c) => n + c.bufferedAmount, 0);
    }
    send(data) {
        const B = bytes(data);
        if (B.length > CHUNK_SIZE) {
            throw new RangeError('DataChannel chunk size');
        }
        const TYPE_LOCAL = B.length >= HEADER ? B[5] : 0;
        const CHANNEL =
            TYPE_LOCAL === TYPE.INPUT || TYPE_LOCAL === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
        if (this.closed || CHANNEL.readyState !== 'open' || this.bufferedAmount + B.length > this.highWaterMark) {
            return false;
        }
        try {
            CHANNEL.send(B);
            return true;
        } catch (error) {
            if (error.name === 'OperationError' || error.name === 'InvalidStateError') {
                return false;
            }
            throw error;
        }
    }
    subscribe(handler) {
        if (this.closed || typeof handler !== 'function') {
            throw new TypeError('transport subscriber');
        }
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this._notifyStatus();
        for (const CHANNEL of this.channels) {
            CHANNEL.removeEventListener('message', this._onMessage);
            CHANNEL.removeEventListener('open', this._onStatus);
            CHANNEL.removeEventListener('close', this._onStatus);
            CHANNEL.removeEventListener('error', this._onChannelError);
            CHANNEL.close();
        }
        this.listeners.clear();
        this.statusListeners.clear();
    }
}
const DEFAULT_ICE = Object.freeze([
    {
        urls: 'stun:stun.l.google.com:19302',
    },
]);
/** Signaler is-a routing adapter: send(to,message), subscribe(handler), id. */
export function createWebRTCPeer({
    initiator = false,
    signaler,
    remoteId,
    rtcConfig = {
        iceServers: DEFAULT_ICE,
    },
    timeoutMs = 20000,
    RTCPeerConnectionImpl: rTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    onStatus = () => {},
    signal,
} = {}) {
    if (signal?.aborted) {
        return Promise.reject(new Error('connection aborted'));
    }
    if (
        typeof rTCPeerConnectionImpl !== 'function' ||
        typeof signaler?.send !== 'function' ||
        typeof signaler.subscribe !== 'function' ||
        !remoteId
    ) {
        return Promise.reject(new TypeError('WebRTC and Signaler capabilities required'));
    }
    // Explicit opt-in is required for caller supplied TURN; defaults contain STUN only.
    let pc;
    try {
        integer(timeoutMs, 'timeoutMs', 1, 120000);
        pc = new rTCPeerConnectionImpl(rtcConfig);
    } catch (error) {
        return Promise.reject(error);
    }
    let inputChannel;
    let controlChannel;
    let transport;
    let unsubscribe;
    let timer;
    let disposed = false;
    let settled = false;
    let chain = Promise.resolve();
    const EARLY_ICE = [],
        ICE_BATCH = [];
    let iceTimer;
    const STATUS = (value) => {
        try {
            onStatus(value);
        } catch {
            /* Observer only. */
        }
    };
    let resolve;
    let reject;
    const RESULT = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const CLOSE = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        clearTimeout(timer);
        clearTimeout(iceTimer);
        unsubscribe?.();
        signal?.removeEventListener('abort', CLOSE);
        transport?.close();
        pc.close();
        if (!settled) {
            settled = true;
            reject(new Error('WebRTC connection closed'));
        }
    };
    const FAIL = (error) => {
        STATUS({
            type: 'connection-error',
            error,
        });
        if (!settled) {
            settled = true;
            reject(error);
        }
        CLOSE();
    };
    signal?.addEventListener('abort', CLOSE, {
        once: true,
    });
    const SEND = (message) => Promise.resolve(signaler.send(remoteId, message));
    const MAYBE_READY = () => {
        if (disposed || settled || inputChannel?.readyState !== 'open' || controlChannel?.readyState !== 'open') {
            return;
        }
        clearTimeout(timer);
        settled = true;
        transport = new WebRTCTransport({
            inputChannel,
            controlChannel,
        });
        STATUS({
            type: 'connected',
        });
        resolve({
            transport,
            peerConnection: pc,
            close: CLOSE,
        });
    };
    const CHANNEL = (value) => {
        if (value.label === 'inputs' && !inputChannel) {
            inputChannel = value;
        } else if (value.label === 'control' && !controlChannel) {
            controlChannel = value;
        } else {
            value.close();
            return;
        }
        value.addEventListener('open', MAYBE_READY);
        MAYBE_READY();
    };
    pc.addEventListener('datachannel', (event) => CHANNEL(event.channel));
    const FLUSH_CANDIDATES = () => {
        clearTimeout(iceTimer);
        if (disposed || !ICE_BATCH.length) {
            return;
        }
        SEND({
            type: 'ice',
            candidates: ICE_BATCH.splice(0),
        }).catch(FAIL);
    };
    pc.addEventListener('icecandidate', (event) => {
        if (disposed) {
            return;
        }
        if (event.candidate) {
            if (ICE_BATCH.length >= 128) {
                FAIL(new RangeError('ICE candidate batch capacity'));
                return;
            }
            ICE_BATCH.push(event.candidate.toJSON());
            clearTimeout(iceTimer);
            iceTimer = setTimeout(FLUSH_CANDIDATES, 100);
        } else {
            FLUSH_CANDIDATES();
        }
    });
    pc.addEventListener('connectionstatechange', () => {
        transport?.setConnectionState(pc.connectionState);
        STATUS({
            type: 'connection-state',
            state: pc.connectionState,
        });
        if (pc.connectionState === 'failed') {
            FAIL(new Error('P2P connection failed; no automatic TURN fallback'));
        }
    });
    const FLUSH_ICE = async () => {
        while (EARLY_ICE.length) {
            await pc.addIceCandidate(EARLY_ICE.shift());
        }
    };
    unsubscribe = signaler.subscribe((event) => {
        if (disposed || event.from !== remoteId || (event.to !== signaler.id && event.to !== '*')) {
            return;
        }
        const MESSAGE = event.message;
        chain = chain
            .then(async () => {
                if (disposed) {
                    return;
                }
                if (MESSAGE?.type === 'offer' && !initiator && !pc.remoteDescription) {
                    await pc.setRemoteDescription(MESSAGE.description);
                    await FLUSH_ICE();
                    await pc.setLocalDescription(await pc.createAnswer());
                    await SEND({
                        type: 'answer',
                        description: pc.localDescription.toJSON(),
                    });
                } else if (MESSAGE?.type === 'answer' && initiator && !pc.remoteDescription) {
                    await pc.setRemoteDescription(MESSAGE.description);
                    await FLUSH_ICE();
                } else if (MESSAGE?.type === 'ice') {
                    const CANDIDATES = MESSAGE.candidates ?? (MESSAGE.candidate ? [MESSAGE.candidate] : []);
                    if (!Array.isArray(CANDIDATES) || CANDIDATES.length > 128) {
                        throw new RangeError('ICE candidate batch');
                    }
                    for (const CANDIDATE of CANDIDATES) {
                        if (pc.remoteDescription) {
                            await pc.addIceCandidate(CANDIDATE);
                        } else if (EARLY_ICE.length < 128) {
                            EARLY_ICE.push(CANDIDATE);
                        } else {
                            throw new RangeError('ICE queue capacity');
                        }
                    }
                } else if (MESSAGE?.type === 'bye') {
                    CLOSE();
                }
            })
            .catch(FAIL);
    });
    timer = setTimeout(() => FAIL(new Error('P2P connection timeout')), integer(timeoutMs, 'timeoutMs', 1, 120000));
    if (initiator) {
        CHANNEL(
            pc.createDataChannel('inputs', {
                ordered: false,
                maxRetransmits: 0,
            }),
        );
        CHANNEL(
            pc.createDataChannel('control', {
                ordered: true,
            }),
        );
        chain = chain
            .then(async () => {
                await pc.setLocalDescription(await pc.createOffer());
                await SEND({
                    type: 'offer',
                    description: pc.localDescription.toJSON(),
                });
            })
            .catch(FAIL);
    }
    return RESULT;
}
