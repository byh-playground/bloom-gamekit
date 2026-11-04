import { PROTOCOL_VERSION } from '../_rollback-shared/protocol.js';
import { integer } from '../deterministic/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { nostrBytesToNumber, nostrEncoder, nostrOrder, nostrPublicKey, nostrSign, nostrToHex } from './nostr-crypto.js';
import { createRoomChannels } from './room-channels.js';
import { DEFAULT_ICE } from './webrtc.js';
// 같은 방 코드를 쓰는 다른 프로토콜(고정·동적·공개 방)과 신호가 섞이지 않게 하는 신호 네임스페이스 접미사.
const WIRE_SUFFIX = ':room-v2';
const WATCH_MS = 1000;
const ICE_BATCH_MS = 100;
const ICE_BATCH_LIMIT = 64;
const ICE_BUFFER_LIMIT = 128;
const SDP_LIMIT = 100 * 1024;
const SESSION_ID = /^[0-9a-f]{32}$/;
const CHANNEL_LABELS = ['inputs', 'control', 'app'];

function randomHex(length) {
    return nostrToHex(globalThis.crypto.getRandomValues(new Uint8Array(length)));
}
/** 방 하나의 수명 동안 같은 서명 키를 유지해, 신호 전달자를 다시 만들어도 상대가 기억하는 id가 바뀌지 않게 합니다. */
function createMemoryIdentity() {
    const SECRET = new Uint8Array(32);
    let valid = false;
    for (let attempt = 0; attempt < 16 && !valid; attempt++) {
        globalThis.crypto.getRandomValues(SECRET);
        const VALUE = nostrBytesToNumber(SECRET);
        valid = VALUE > 0n && VALUE < nostrOrder;
    }
    if (!valid) {
        throw new Error('Secure random secret generation failed');
    }
    const ID = nostrToHex(nostrPublicKey(SECRET));
    let released = false;
    return {
        id: ID,
        // 전달자가 닫힐 때 부르는 close는 키를 지우지 않습니다. 키는 방이 닫힐 때만 지웁니다.
        capability: () => ({
            id: ID,
            sign(hash, auxiliary, cryptoImpl) {
                if (released) {
                    throw new Error('room identity released');
                }
                return nostrSign(hash, SECRET, auxiliary, cryptoImpl);
            },
            close() {},
        }),
        release() {
            released = true;
            SECRET.fill(0);
        },
    };
}
function deferred() {
    const RESULT = {};
    RESULT.promise = new Promise((resolve, reject) => {
        RESULT.resolve = resolve;
        RESULT.reject = reject;
    });
    // 아무도 기다리지 않는 실패가 unhandled rejection이 되지 않게 합니다. await하는 쪽은 그대로 거절을 받습니다.
    RESULT.promise.catch(() => {});
    return RESULT;
}
function description(value, type) {
    return (
        value !== null &&
        typeof value === 'object' &&
        value.type === type &&
        typeof value.sdp === 'string' &&
        value.sdp.length <= SDP_LIMIT
    );
}
const IS_SERIAL = (value) => Number.isSafeInteger(value) && value >= 1;

/**
 * 4자리 코드로 만나는 1:1 방 연결. Nostr로 서로를 찾고 WebRTC로 연결하며, 끊기면 같은 방에서 스스로 다시 잇습니다.
 * 반환은 신호 전달자가 준비된 뒤(host는 방 코드 충돌 확인까지)이고 상대와의 연결은 `opened`/`state`로 지켜봅니다.
 */
export async function createNostrRoom({
    role,
    room,
    namespace = 'rollback-netcode',
    version,
    relays,
    rtcConfig = { iceServers: DEFAULT_ICE },
    timeoutMs = 60000,
    reconnectTimeoutMs = 60000,
    peerTimeoutMs = 8000,
    retryMs = 1000,
    disconnectGraceMs = 2500,
    collisionCheckMs = 1200,
    onStatus = () => {},
    signal,
    signalerFactory = createNostrSignaler,
} = {}) {
    if (!['host', 'join'].includes(role)) {
        throw new TypeError('room role');
    }
    if (typeof version !== 'string' || version.length < 1 || version.length > 64) {
        throw new TypeError('room version must be a string of 1 to 64 characters');
    }
    integer(timeoutMs, 'timeoutMs', 1, 3600000);
    integer(reconnectTimeoutMs, 'reconnectTimeoutMs', 1, 3600000);
    integer(peerTimeoutMs, 'peerTimeoutMs', 100, 120000);
    integer(retryMs, 'retryMs', 10, 10000);
    integer(disconnectGraceMs, 'disconnectGraceMs', 0, 60000);
    integer(collisionCheckMs, 'collisionCheckMs', 0, 10000);
    if (
        typeof namespace !== 'string' ||
        !namespace.trim() ||
        nostrEncoder.encode(namespace + WIRE_SUFFIX).length > 128
    ) {
        throw new TypeError('room namespace');
    }
    if (typeof onStatus !== 'function' || typeof signalerFactory !== 'function') {
        throw new TypeError('room adapter factories');
    }
    if (typeof globalThis.RTCPeerConnection !== 'function' || rtcConfig === null || typeof rtcConfig !== 'object') {
        throw new TypeError('WebRTC capability and rtcConfig object required');
    }
    if (signal?.aborted) {
        throw new Error('room aborted');
    }
    if (!room && role === 'host') {
        room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
    }
    if (!/^\d{4}$/.test(room ?? '')) {
        throw new TypeError('four-digit room');
    }
    // 잘못된 설정은 첫 협상에서 조용히 멈추지 않고 만들 때 던집니다.
    new globalThis.RTCPeerConnection(rtcConfig).close();

    const NAMESPACE = namespace + WIRE_SUFFIX;
    const HOST = role === 'host';
    const IDENTITY = createMemoryIdentity();
    const SELF = IDENTITY.id;
    const CONTROLLER = new AbortController();
    const LISTENERS = new Set();
    const INFLIGHT = new Map();
    const HELLO = { version, protocol: PROTOCOL_VERSION };
    let state = 'connecting';
    let closed = false;
    let failure = null;
    let everOpened = false;
    let generation = 0;
    let signaler = null;
    let unsubscribeSignals = null;
    let signalingEnabled = true;
    let signalFailures = 0;
    let rebuilding = null;
    let chain = Promise.resolve();
    let current = null;
    let remoteId = null;
    let sessionId = HOST ? randomHex(16) : null;
    let serialCounter = 0;
    let lastOffer = { peer: null, serial: 0 };
    let mismatchKey = '';
    let openedWaiter = deferred();
    let pulseTimer = 0;
    let watchTimer = 0;
    let deadlineTimer = 0;
    let claim = null;
    let collided = false;
    const EARLY_ICE = new Map();

    function dispatch(event) {
        try {
            onStatus(event);
        } catch {
            /* 관찰자의 예외는 방 상태를 바꾸지 않습니다. */
        }
        for (const LISTENER of [...LISTENERS]) {
            try {
                LISTENER(event);
            } catch {
                /* 관찰자의 예외는 방 상태를 바꾸지 않습니다. */
            }
        }
    }
    function emit(type, detail = {}) {
        dispatch({ type, room, role, ...detail });
    }
    function reportError(code, error) {
        if (!closed) {
            emit('error', { code, error, message: String(error?.message ?? error) });
        }
    }
    const CHANNELS = createRoomChannels({
        onError: reportError,
        onSendFailure: () => queueMicrotask(() => reconnect({ reason: 'send-failed' })),
    });
    function setState(next, detail = {}) {
        if (state === next) {
            return;
        }
        const PREVIOUS = state;
        state = next;
        CHANNELS.setState(next);
        emit('state', { state: next, previous: PREVIOUS, generation, ...detail });
    }

    /* ---------- 신호 ---------- */
    async function openSignaling() {
        const SIGNALER = await signalerFactory({
            room,
            namespace: NAMESPACE,
            relays,
            signal: CONTROLLER.signal,
            timeoutMs: Math.min(timeoutMs, 10000),
            onStatus: dispatch,
            identity: IDENTITY.capability(),
        });
        const VALID =
            SIGNALER &&
            ['send', 'subscribe', 'close'].every((key) => typeof SIGNALER[key] === 'function') &&
            SIGNALER.id === SELF;
        if (closed || !signalingEnabled || !VALID) {
            SIGNALER?.close?.();
            if (!closed && signalingEnabled) {
                throw new TypeError('room signaler capability: the signaler must use the identity it is given');
            }
            throw new Error('room aborted');
        }
        signaler = SIGNALER;
        signalFailures = 0;
        unsubscribeSignals = SIGNALER.subscribe(onSignal);
    }
    function closeSignaling() {
        unsubscribeSignals?.();
        unsubscribeSignals = null;
        signaler?.close();
        signaler = null;
    }
    /** 같은 서명 키로 전달자를 다시 만듭니다. 상대가 기억하는 id가 유지되므로 짝이 바뀌지 않습니다. */
    function rebuildSignaling() {
        if (rebuilding) {
            return rebuilding;
        }
        closeSignaling();
        rebuilding = (async () => {
            while (signalingEnabled && !closed && !signaler) {
                try {
                    await openSignaling();
                } catch (error) {
                    if (signalingEnabled && !closed) {
                        reportError('signaling-unavailable', error);
                        await new Promise((resolve) => setTimeout(resolve, retryMs));
                    }
                }
            }
            if (signaler && signalingEnabled && !closed) {
                emit('signaling-ready', { rebuilt: true });
                startPairing();
            }
        })().finally(() => {
            rebuilding = null;
        });
        return rebuilding;
    }
    function publish(to, payload, key = null) {
        const SIGNALER = signaler;
        if (!SIGNALER) {
            return Promise.resolve(false);
        }
        if (key && INFLIGHT.has(key)) {
            return INFLIGHT.get(key);
        }
        const PROMISE = Promise.resolve()
            .then(() => SIGNALER.send(to, payload))
            .then(
                () => {
                    if (signaler === SIGNALER) {
                        signalFailures = 0;
                    }
                    return true;
                },
                (error) => {
                    if (!closed && signaler === SIGNALER) {
                        reportError('signal-error', error);
                        if (++signalFailures >= 3) {
                            rebuildSignaling();
                        }
                    }
                    return false;
                },
            )
            .finally(() => {
                if (key && INFLIGHT.get(key) === PROMISE) {
                    INFLIGHT.delete(key);
                }
            });
        if (key) {
            INFLIGHT.set(key, PROMISE);
        }
        return PROMISE;
    }
    function pulse() {
        if (closed || current || !signaler || rebuilding || claim) {
            return;
        }
        if (HOST) {
            publish('*', { type: 'presence', ...HELLO }, 'pulse');
        } else {
            publish(
                remoteId ?? '*',
                { type: 'discover', ...HELLO, accepted: lastOffer.serial, acceptedFrom: lastOffer.peer },
                'pulse',
            );
        }
    }
    function startPairing() {
        stopPairing();
        if (closed || !signalingEnabled || state === 'failed') {
            return;
        }
        pulseTimer = setInterval(pulse, retryMs);
        pulse();
    }
    function stopPairing() {
        clearInterval(pulseTimer);
        pulseTimer = 0;
    }

    /* ---------- 수명주기 ---------- */
    function armDeadline(ms, fresh) {
        if (deadlineTimer && !fresh) {
            return;
        }
        clearTimeout(deadlineTimer);
        deadlineTimer = setTimeout(() => fail(everOpened ? 'reconnect-timeout' : 'timeout'), ms);
    }
    function clearDeadline() {
        clearTimeout(deadlineTimer);
        deadlineTimer = 0;
    }
    function startWatch() {
        stopWatch();
        // 이벤트를 놓친 채널·연결 종료를 늦게라도 잡는 보조 점검입니다. 열려 있는 동안에만 돕니다.
        watchTimer = setInterval(() => {
            const NEG = current;
            if (!NEG?.opened) {
                return;
            }
            if (CHANNEL_LABELS.some((label) => NEG.channels[label].readyState !== 'open')) {
                lose(NEG, 'datachannel-close');
            } else if (['failed', 'closed'].includes(NEG.pc.connectionState)) {
                lose(NEG, 'rtc-' + NEG.pc.connectionState);
            }
        }, WATCH_MS);
    }
    function stopWatch() {
        clearInterval(watchTimer);
        watchTimer = 0;
    }
    function dropNegotiation() {
        const NEG = current;
        if (!NEG) {
            return;
        }
        current = null;
        clearTimeout(NEG.timer);
        clearTimeout(NEG.graceTimer);
        clearTimeout(NEG.iceTimer);
        stopWatch();
        if (NEG.opened) {
            CHANNELS.detach();
        }
        for (const CHANNEL of Object.values(NEG.channels)) {
            CHANNEL.onopen = CHANNEL.onclose = CHANNEL.onerror = null;
        }
        NEG.pc.onicecandidate = NEG.pc.onconnectionstatechange = NEG.pc.oniceconnectionstatechange = null;
        NEG.pc.ondatachannel = null;
        try {
            NEG.pc.close();
        } catch {
            /* 이미 닫힌 연결입니다. */
        }
    }
    /** 현재 협상을 버립니다. 열린 적이 있으면 interrupted로 알리고, 아니면 실패한 시도로만 기록합니다. */
    function lose(neg, reason, { resume = true } = {}) {
        if (closed || neg !== current) {
            return;
        }
        const WAS_OPEN = neg.opened;
        dropNegotiation();
        if (WAS_OPEN) {
            setState('interrupted', { reason });
            armDeadline(reconnectTimeoutMs, false);
        } else {
            emit('attempt-failed', { reason });
        }
        if (resume) {
            startPairing();
        }
    }
    function fail(reason) {
        if (closed || state === 'failed') {
            return;
        }
        dropNegotiation();
        stopPairing();
        clearDeadline();
        signalingEnabled = false;
        closeSignaling();
        failure = Object.freeze({ reason, message: 'room failed: ' + reason });
        setState('failed', { reason });
        if (!everOpened) {
            openedWaiter.reject(Object.assign(new Error(failure.message), { code: reason }));
        }
    }
    function reconnect({ reason = 'manual', newPeer = false } = {}) {
        if (typeof reason !== 'string' || reason.length < 1 || reason.length > 64 || typeof newPeer !== 'boolean') {
            throw new TypeError('reconnect options');
        }
        if (closed) {
            return false;
        }
        const REVIVE = state === 'failed';
        dropNegotiation();
        if (newPeer) {
            remoteId = null;
        }
        if (REVIVE) {
            failure = null;
            signalingEnabled = true;
            if (!everOpened) {
                openedWaiter = deferred();
            }
        }
        setState(everOpened ? 'interrupted' : 'connecting', { reason, forced: true });
        armDeadline(everOpened ? reconnectTimeoutMs : timeoutMs, true);
        if (signaler) {
            startPairing();
        } else {
            rebuildSignaling();
        }
        return true;
    }
    function close(reason = 'closed') {
        if (closed) {
            return;
        }
        closed = true;
        signalingEnabled = false;
        signal?.removeEventListener('abort', onAbort);
        clearDeadline();
        stopPairing();
        dropNegotiation();
        closeSignaling();
        CONTROLLER.abort();
        IDENTITY.release();
        claim?.resolve();
        if (!everOpened) {
            openedWaiter.reject(Object.assign(new Error('room closed: ' + reason), { code: reason }));
        }
        setState('closed', { reason });
        CHANNELS.close();
        LISTENERS.clear();
    }
    function onAbort() {
        close('aborted');
    }

    /* ---------- 협상 ---------- */
    function createNegotiation(number, initiator) {
        const PC = new globalThis.RTCPeerConnection(rtcConfig);
        const NEG = {
            serial: number,
            initiator,
            pc: PC,
            channels: {},
            pendingIce: [],
            outgoingIce: [],
            remoteSet: false,
            opened: false,
            timer: 0,
            graceTimer: 0,
            iceTimer: 0,
        };
        current = NEG;
        PC.onicecandidate = (event) => queueCandidate(NEG, event.candidate);
        PC.onconnectionstatechange = PC.oniceconnectionstatechange = () => watchConnection(NEG);
        PC.ondatachannel = (event) => bindChannel(NEG, event.channel);
        if (initiator) {
            bindChannel(NEG, PC.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
            bindChannel(NEG, PC.createDataChannel('control', { ordered: true }));
            bindChannel(NEG, PC.createDataChannel('app', { ordered: true }));
        }
        NEG.timer = setTimeout(() => lose(NEG, 'connect-timeout'), peerTimeoutMs);
        return NEG;
    }
    function bindChannel(neg, channel) {
        if (neg !== current || !CHANNEL_LABELS.includes(channel.label) || neg.channels[channel.label]) {
            channel.close();
            return;
        }
        neg.channels[channel.label] = channel;
        channel.onopen = () => maybeOpen(neg);
        channel.onclose = () => lose(neg, 'datachannel-close');
        // 연결을 잃으며 나오는 오류는 close 이벤트가 interrupted로 알립니다. 열린 채널의 오류만 따로 알립니다.
        channel.onerror = (event) => {
            if (channel.readyState === 'open') {
                reportError('channel-error', event?.error ?? event);
            }
        };
        maybeOpen(neg);
    }
    function maybeOpen(neg) {
        if (
            neg !== current ||
            neg.opened ||
            CHANNEL_LABELS.some((label) => neg.channels[label]?.readyState !== 'open')
        ) {
            return;
        }
        neg.opened = true;
        clearTimeout(neg.timer);
        CHANNELS.attach(neg.channels);
        everOpened = true;
        generation++;
        mismatchKey = '';
        clearDeadline();
        stopPairing();
        startWatch();
        openedWaiter.resolve();
        setState('open', { reconnect: generation > 1 });
    }
    /** 연결이 잠시 disconnected가 되면 interrupted로 알리고, 유예 안에 돌아오면 같은 연결을 그대로 씁니다. */
    function watchConnection(neg) {
        if (closed || neg !== current) {
            return;
        }
        const CONNECTION = neg.pc.connectionState;
        const ICE = neg.pc.iceConnectionState;
        if (CONNECTION === 'failed' || CONNECTION === 'closed' || ICE === 'failed') {
            lose(neg, 'rtc-' + (CONNECTION === 'closed' ? 'closed' : 'failed'));
        } else if (CONNECTION === 'disconnected' || ICE === 'disconnected') {
            if (neg.opened) {
                setState('interrupted', { reason: 'rtc-disconnected' });
            }
            if (!neg.graceTimer) {
                neg.graceTimer = setTimeout(() => {
                    neg.graceTimer = 0;
                    if (neg === current && ['disconnected', 'failed', 'closed'].includes(neg.pc.connectionState)) {
                        lose(neg, 'rtc-disconnected');
                    }
                }, disconnectGraceMs);
            }
        } else {
            clearTimeout(neg.graceTimer);
            neg.graceTimer = 0;
            if (neg.opened && state === 'interrupted') {
                setState('open', { reconnect: true, healed: true });
            }
        }
    }
    function queueCandidate(neg, candidate) {
        if (neg !== current) {
            return;
        }
        if (candidate) {
            if (neg.outgoingIce.length < ICE_BUFFER_LIMIT) {
                neg.outgoingIce.push(candidate.toJSON());
            }
            clearTimeout(neg.iceTimer);
            neg.iceTimer = setTimeout(() => flushCandidates(neg), ICE_BATCH_MS);
        } else {
            flushCandidates(neg);
        }
    }
    function flushCandidates(neg) {
        clearTimeout(neg.iceTimer);
        if (neg !== current || !remoteId) {
            return;
        }
        while (neg.outgoingIce.length) {
            publish(remoteId, {
                type: 'ice',
                serial: neg.serial,
                candidates: neg.outgoingIce.splice(0, ICE_BATCH_LIMIT),
            });
        }
    }
    async function addCandidates(neg, candidates) {
        for (const CANDIDATE of candidates) {
            if (neg !== current) {
                return;
            }
            try {
                await neg.pc.addIceCandidate(CANDIDATE);
            } catch (error) {
                if (neg === current) {
                    reportError('ice-candidate', error);
                }
            }
        }
    }
    async function settleRemote(neg, remote) {
        await neg.pc.setRemoteDescription({ type: remote.type, sdp: remote.sdp });
        if (neg !== current) {
            return false;
        }
        neg.remoteSet = true;
        await addCandidates(neg, neg.pendingIce.splice(0));
        return neg === current;
    }
    function failNegotiation(neg, error) {
        if (neg === current) {
            reportError('negotiation', error);
            lose(neg, 'negotiation-error');
        }
    }

    /* ---------- 신호 처리 ---------- */
    function mismatchOf(message) {
        if (typeof message.version !== 'string' || !Number.isSafeInteger(message.protocol)) {
            return undefined;
        }
        if (message.protocol !== PROTOCOL_VERSION) {
            return { kind: 'protocol', local: PROTOCOL_VERSION, remote: message.protocol };
        }
        return message.version === version ? null : { kind: 'version', local: version, remote: message.version };
    }
    function reportMismatch(peerId, mismatch) {
        const KEY = `${peerId}:${mismatch.kind}:${mismatch.remote}`;
        if (mismatchKey !== KEY) {
            mismatchKey = KEY;
            emit('version-mismatch', { peerId, ...mismatch });
        }
    }
    function onSignal(envelope) {
        const { from: FROM, to: TO, message: MESSAGE } = envelope ?? {};
        if (closed || !signalingEnabled || FROM === SELF || (TO !== '*' && TO !== SELF)) {
            return;
        }
        if (MESSAGE === null || typeof MESSAGE !== 'object' || typeof FROM !== 'string') {
            return;
        }
        chain = chain.then(() => handleSignal(FROM, MESSAGE)).catch((error) => reportError('signal', error));
    }
    function handleSignal(from, message) {
        if (closed || !signalingEnabled) {
            return undefined;
        }
        switch (message.type) {
            case 'presence':
                return onPresence(from, message);
            case 'discover':
                return onDiscover(from, message);
            case 'offer':
                return onOffer(from, message);
            case 'answer':
                return onAnswer(from, message);
            case 'ice':
                return onIce(from, message);
            default:
                return undefined;
        }
    }
    function onPresence(from, message) {
        if (HOST) {
            // 같은 방 코드로 먼저 열린 다른 host입니다.
            collided = collided || !!claim;
            return;
        }
        if (current || (remoteId && from !== remoteId)) {
            return;
        }
        const MISMATCH = mismatchOf(message);
        if (MISMATCH) {
            reportMismatch(from, MISMATCH);
            fail('version-mismatch');
        }
    }
    async function onDiscover(from, message) {
        if (!HOST || claim) {
            return;
        }
        const MISMATCH = mismatchOf(message);
        if (MISMATCH === undefined) {
            return;
        }
        if (MISMATCH) {
            // 연결을 시도하기 전에 양쪽에 알립니다. 게스트는 host의 presence로 불일치를 압니다.
            reportMismatch(from, MISMATCH);
            publish(from, { type: 'presence', ...HELLO });
            return;
        }
        if (remoteId && from !== remoteId) {
            return;
        }
        if (current) {
            // 게스트가 이 offer를 받은 뒤에도 다시 찾고 있으면, 그 협상은 게스트 쪽에서 끝난 것입니다.
            const DEAD = message.acceptedFrom === SELF && message.accepted >= current.serial;
            if (!DEAD) {
                return;
            }
            lose(current, 'peer-restarted', { resume: false });
        }
        remoteId = from;
        const NEG = createNegotiation(++serialCounter, true);
        try {
            await NEG.pc.setLocalDescription(await NEG.pc.createOffer());
            if (NEG !== current) {
                return;
            }
            const SENT = await publish(from, {
                type: 'offer',
                ...HELLO,
                serial: NEG.serial,
                sessionId,
                description: NEG.pc.localDescription.toJSON(),
            });
            if (!SENT && NEG === current) {
                lose(NEG, 'signal-error');
            }
        } catch (error) {
            failNegotiation(NEG, error);
        }
    }
    async function onOffer(from, message) {
        if (HOST || (remoteId && from !== remoteId)) {
            return;
        }
        const MISMATCH = mismatchOf(message);
        if (MISMATCH === undefined || !IS_SERIAL(message.serial) || !SESSION_ID.test(message.sessionId ?? '')) {
            return;
        }
        if (MISMATCH) {
            reportMismatch(from, MISMATCH);
            fail('version-mismatch');
            return;
        }
        if (!description(message.description, 'offer')) {
            return;
        }
        // 이미 받은 협상이거나 더 오래된 협상의 늦은 offer입니다.
        if (lastOffer.peer === from && message.serial <= lastOffer.serial) {
            return;
        }
        if (current) {
            lose(current, 'peer-restarted', { resume: false });
        }
        remoteId = from;
        lastOffer = { peer: from, serial: message.serial };
        sessionId = message.sessionId;
        stopPairing();
        const NEG = createNegotiation(message.serial, false);
        NEG.pendingIce.push(...(EARLY_ICE.get(`${from}:${message.serial}`) ?? []));
        EARLY_ICE.clear();
        try {
            if (!(await settleRemote(NEG, message.description))) {
                return;
            }
            await NEG.pc.setLocalDescription(await NEG.pc.createAnswer());
            if (NEG !== current) {
                return;
            }
            const SENT = await publish(from, {
                type: 'answer',
                serial: NEG.serial,
                description: NEG.pc.localDescription.toJSON(),
            });
            if (!SENT && NEG === current) {
                lose(NEG, 'signal-error');
            }
        } catch (error) {
            failNegotiation(NEG, error);
        }
    }
    async function onAnswer(from, message) {
        const NEG = current;
        if (!HOST || !NEG?.initiator || from !== remoteId || message.serial !== NEG.serial || NEG.remoteSet) {
            return;
        }
        if (!description(message.description, 'answer')) {
            return;
        }
        try {
            await settleRemote(NEG, message.description);
        } catch (error) {
            failNegotiation(NEG, error);
        }
    }
    async function onIce(from, message) {
        const CANDIDATES = message.candidates;
        if (!IS_SERIAL(message.serial) || !Array.isArray(CANDIDATES) || CANDIDATES.length > ICE_BATCH_LIMIT) {
            return;
        }
        const NEG = current;
        if (NEG && from === remoteId && message.serial === NEG.serial) {
            if (NEG.remoteSet) {
                await addCandidates(NEG, CANDIDATES);
            } else if (NEG.pendingIce.length + CANDIDATES.length <= ICE_BUFFER_LIMIT) {
                NEG.pendingIce.push(...CANDIDATES);
            }
            return;
        }
        // offer보다 먼저 도착한 후보는 그 협상이 시작될 때를 위해 잠시 보관합니다. 더 오래된 협상의 후보는 버립니다.
        const NEWER = lastOffer.peer !== from || message.serial > lastOffer.serial;
        const KEY = `${from}:${message.serial}`;
        if (!HOST && NEWER && !(remoteId && from !== remoteId) && (EARLY_ICE.has(KEY) || EARLY_ICE.size < 8)) {
            const KEPT = EARLY_ICE.get(KEY) ?? [];
            if (KEPT.length + CANDIDATES.length <= ICE_BUFFER_LIMIT) {
                EARLY_ICE.set(KEY, [...KEPT, ...CANDIDATES]);
            }
        }
    }

    /* ---------- 시작 ---------- */
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        await openSignaling();
        emit('room', { namespace });
        if (HOST && collisionCheckMs > 0) {
            // 먼저 열린 같은 코드의 host가 있으면 그쪽 presence를 듣고 실패합니다. 0이면 확인 없이 바로 돌아옵니다.
            await new Promise((resolve) => {
                claim = { resolve };
                claim.timer = setTimeout(resolve, collisionCheckMs);
            });
            clearTimeout(claim.timer);
            claim = null;
            if (closed) {
                throw new Error('room aborted');
            }
            if (collided) {
                throw Object.assign(new Error('room code is already in use; choose another four-digit code'), {
                    code: 'room-in-use',
                });
            }
        }
    } catch (error) {
        close('creation-failed');
        throw error;
    }
    armDeadline(timeoutMs, true);
    emit('signaling-ready');
    startPairing();
    return Object.freeze({
        get room() {
            return room;
        },
        role,
        get sessionId() {
            return sessionId;
        },
        localPlayerId: HOST ? 'a' : 'b',
        remotePlayerId: HOST ? 'b' : 'a',
        get peerId() {
            return remoteId;
        },
        get state() {
            return state;
        },
        get generation() {
            return generation;
        },
        get failure() {
            return failure;
        },
        get closed() {
            return closed;
        },
        get opened() {
            return openedWaiter.promise;
        },
        get peerConnection() {
            return current?.pc ?? null;
        },
        transport: CHANNELS.transport,
        app: CHANNELS.app,
        subscribe(listener) {
            if (typeof listener !== 'function') {
                throw new TypeError('room subscriber');
            }
            if (closed) {
                return () => {};
            }
            LISTENERS.add(listener);
            return () => LISTENERS.delete(listener);
        },
        subscribeStatus: (listener) => CHANNELS.transport.subscribeStatus(listener),
        reconnect,
        close,
    });
}
