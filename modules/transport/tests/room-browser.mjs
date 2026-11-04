import { createLocalSignaler, createNostrRoom } from '../../../dist/transport.js';
// 같은 페이지의 두 방 연결이 실제 RTCPeerConnection으로 만나고, 끊기고, 다시 이어지는 한 흐름을 확인합니다.
// 신호만 같은 페이지 전달자(createLocalSignaler)로 대신하며 릴레이·NAT 검증이 아닙니다.
const NAMESPACE = 'room-browser';
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value, message) {
    if (!value) {
        throw new Error(message);
    }
}
function same(actual, expected, message) {
    assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
}
async function until(predicate, label, timeoutMs = 12000) {
    const STARTED = performance.now();
    while (!predicate()) {
        assert(performance.now() - STARTED < timeoutMs, `timeout waiting for ${label}`);
        await SLEEP(20);
    }
}
async function rejects(promise, code, label) {
    try {
        await promise;
    } catch (error) {
        assert(error.code === code, `${label}: expected code ${code}, got ${error.code} (${error.message})`);
        return error;
    }
    throw new Error(`${label}: expected rejection ${code}`);
}
// rollback 패킷 12바이트 머리글의 5번 바이트가 종류입니다. 2는 입력(unordered 채널), 1은 제어(ordered 채널).
function packet(kind, tag) {
    return Uint8Array.from({ length: 16 }, (_, index) => (index === 5 ? kind : index === 0 ? tag : 0));
}
function frame(index) {
    return Uint8Array.from({ length: 65536 }, (_, offset) => (offset < 4 ? (index >> (offset * 8)) & 255 : 7));
}
function frameIndex(data) {
    return data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
}

export async function runRoomScenario() {
    const REAL_PEER_CONNECTION = globalThis.RTCPeerConnection;
    const PEERS = [];
    const CHANNELS = [];
    let probes = 0;
    globalThis.RTCPeerConnection = class extends REAL_PEER_CONNECTION {
        constructor(...args) {
            super(...args);
            PEERS.push(this);
        }
        addIceCandidate(candidate) {
            this.candidatesAdded = (this.candidatesAdded ?? 0) + 1;
            return super.addIceCandidate(candidate);
        }
        createDataChannel(label, init) {
            CHANNELS.push({ label, ordered: init?.ordered, maxRetransmits: init?.maxRetransmits });
            return super.createDataChannel(label, init);
        }
    };
    // 방이 설정을 검사하려고 만드는 연결 하나를 뺀, 협상용 RTCPeerConnection 수.
    function negotiations() {
        return PEERS.length - probes;
    }
    const OPEN_ROOMS = [];
    function makeSignaling() {
        const CONTROL = { outage: false, offerDelayMs: 0, created: 0, sent: [], wrapper: null };
        CONTROL.factory = async (options) => {
            if (CONTROL.outage) {
                throw new Error('injected signaling outage');
            }
            const INNER = await createLocalSignaler(options);
            CONTROL.created++;
            CONTROL.wrapper = {
                id: INNER.id,
                room: INNER.room,
                async send(to, message) {
                    if (CONTROL.outage) {
                        throw new Error('injected signaling outage');
                    }
                    CONTROL.sent.push({ to, message: JSON.parse(JSON.stringify(message)) });
                    if (message.type === 'offer' && CONTROL.offerDelayMs) {
                        await SLEEP(CONTROL.offerDelayMs);
                    }
                    await INNER.send(to, message);
                },
                subscribe: (listener) => INNER.subscribe(listener),
                close: () => INNER.close(),
                // 지난 신호를 그대로 다시 보냅니다(릴레이의 늦은·중복 배달).
                replay: (to, message) => INNER.send(to, message),
            };
            return CONTROL.wrapper;
        };
        return CONTROL;
    }
    async function open(role, options = {}) {
        const SIGNALING = makeSignaling();
        const WIRE = { events: [], states: [], app: [], netcode: [], signaling: SIGNALING };
        probes++;
        const ROOM = await createNostrRoom({
            role,
            namespace: NAMESPACE,
            version: 'sim-1',
            rtcConfig: { iceServers: [] },
            signalerFactory: SIGNALING.factory,
            timeoutMs: 20000,
            reconnectTimeoutMs: 15000,
            peerTimeoutMs: 3000,
            retryMs: 200,
            disconnectGraceMs: 300,
            onStatus: (event) => WIRE.events.push(event),
            ...options,
        });
        OPEN_ROOMS.push(ROOM);
        WIRE.room = ROOM;
        ROOM.subscribeStatus((state) => WIRE.states.push(state));
        ROOM.transport.subscribe((data) => WIRE.netcode.push(data));
        ROOM.app.subscribe((data) => WIRE.app.push(data));
        return WIRE;
    }
    function errorsOf(wire) {
        return wire.events.filter((event) => event.type === 'error');
    }
    function describe(...wires) {
        return JSON.stringify(wires.flatMap(errorsOf).map((event) => [event.code, event.message]));
    }
    function bothOpen(a, b, generation) {
        return (
            a.room.state === 'open' &&
            b.room.state === 'open' &&
            a.room.generation === generation &&
            b.room.generation === generation
        );
    }
    async function exchange(a, b, tag) {
        const BEFORE = [a.app.length, a.netcode.length, b.app.length, b.netcode.length];
        assert(a.room.app.send(Uint8Array.of(tag, 1)), 'app send a->b');
        assert(b.room.app.send(Uint8Array.of(tag, 2)), 'app send b->a');
        assert(a.room.transport.send(packet(1, tag)), 'control send a->b');
        assert(b.room.transport.send(packet(2, tag)), 'input send b->a');
        await until(
            () =>
                a.app.length > BEFORE[0] &&
                a.netcode.length > BEFORE[1] &&
                b.app.length > BEFORE[2] &&
                b.netcode.length > BEFORE[3],
            `exchange ${tag}`,
        );
        same([...a.app.at(-1)], [tag, 2], 'app b->a payload');
        same([...b.app.at(-1)], [tag, 1], 'app a->b payload');
        assert(a.netcode.at(-1)[0] === tag && a.netcode.at(-1)[5] === 2, 'input b->a payload');
        assert(b.netcode.at(-1)[0] === tag && b.netcode.at(-1)[5] === 1, 'control a->b payload');
    }

    const REPORT = { steps: {} };
    const STARTED = performance.now();
    const STEP = (name) => {
        REPORT.steps[name] = Math.round(performance.now() - STARTED);
    };
    try {
        // 1. host와 guest가 같은 코드로 만나 열린다. guest는 host의 방 코드 확인이 끝나기 전부터 찾는다.
        const [HOST, GUEST] = await Promise.all([open('host', { room: '4821' }), open('join', { room: '4821' })]);
        await Promise.all([HOST.room.opened, GUEST.room.opened]);
        assert(bothOpen(HOST, GUEST, 1), 'both open at generation 1');
        assert(
            /^[0-9a-f]{32}$/.test(HOST.room.sessionId) && HOST.room.sessionId === GUEST.room.sessionId,
            'shared sessionId',
        );
        same(
            [HOST.room.localPlayerId, HOST.room.remotePlayerId, GUEST.room.localPlayerId],
            ['a', 'b', 'b'],
            'player ids',
        );
        assert(
            HOST.room.peerId === GUEST.signaling.wrapper.id && GUEST.room.peerId === HOST.signaling.wrapper.id,
            'peer ids',
        );
        same(
            [HOST.room.transport.state, GUEST.room.transport.state],
            ['open', 'open'],
            'netcode state follows the room',
        );
        assert(
            typeof HOST.room.transport.close === 'undefined',
            'the room owns the transport: no close on the netcode view',
        );
        same(
            CHANNELS.map((c) => [c.label, c.ordered, c.maxRetransmits ?? null]),
            [
                ['inputs', false, 0],
                ['control', true, null],
                ['app', true, null],
            ],
            'host creates input(unordered, no retransmit), control and app channels',
        );
        STEP('connected');

        // 2. 앱 채널·netcode 채널 양방향, 그리고 앱 채널의 송신 큐 흐름 제어.
        await exchange(HOST, GUEST, 1);
        const FRAMES = 24;
        const SENT_BEFORE = GUEST.app.length;
        for (let index = 0; index < FRAMES; index++) {
            assert(HOST.room.app.send(frame(index)), 'queued app frame ' + index);
        }
        assert(HOST.room.app.bufferedAmount > 512 * 1024, 'frames beyond the high-water mark wait in the send queue');
        await until(() => GUEST.app.length === SENT_BEFORE + FRAMES, 'queued frames delivered');
        same(GUEST.app.slice(SENT_BEFORE).map(frameIndex), [...Array(FRAMES).keys()], 'queued frames keep their order');
        await until(() => HOST.room.app.bufferedAmount === 0, 'send queue drained');
        let oversize;
        try {
            HOST.room.app.send(new Uint8Array(300 * 1024));
        } catch (error) {
            oversize = error;
        }
        assert(oversize instanceof RangeError, 'oversize app frame is a programming error');
        let notBytes;
        try {
            HOST.room.app.send('text');
        } catch (error) {
            notBytes = error;
        }
        assert(notBytes instanceof TypeError, 'app frames are bytes');
        STEP('messages');

        // 3. guest가 자기 PeerConnection을 닫는다. 두 쪽이 스스로 다시 잇고, 같은 객체와 구독자가 그대로 쓰인다.
        const HOST_TRANSPORT = HOST.room.transport;
        const HOST_APP = HOST.room.app;
        const SESSION = HOST.room.sessionId;
        const PEER_COUNT = negotiations();
        GUEST.room.peerConnection.close();
        await until(() => bothOpen(HOST, GUEST, 2), 'reconnect after the guest closed its connection');
        same(HOST.states, ['open', 'interrupted', 'open'], 'host state history');
        same(GUEST.states, ['open', 'interrupted', 'open'], 'guest state history');
        assert(
            HOST.room.transport === HOST_TRANSPORT && HOST.room.app === HOST_APP,
            'transport and app channel survive',
        );
        assert(HOST.room.sessionId === SESSION && GUEST.room.sessionId === SESSION, 'session survives the reconnect');
        assert(negotiations() === PEER_COUNT + 2, 'one new connection per side');
        const LOSS = HOST.events.find((event) => event.type === 'state' && event.state === 'interrupted');
        assert(
            typeof LOSS.reason === 'string' && LOSS.previous === 'open' && LOSS.generation === 1,
            'loss reason is reported',
        );
        await exchange(HOST, GUEST, 2);
        STEP('reconnected');

        // 4. 릴레이가 늦게·중복 배달한 옛 협상 신호는 버려진다.
        const SIGNALS = (wire) => wire.signaling.sent.map((entry) => entry);
        const OLD = {
            offer: SIGNALS(HOST).find((entry) => entry.message.type === 'offer' && entry.message.serial === 1),
            answer: SIGNALS(GUEST).find((entry) => entry.message.type === 'answer' && entry.message.serial === 1),
            hostIce: SIGNALS(HOST).find((entry) => entry.message.type === 'ice' && entry.message.serial === 1),
            guestIce: SIGNALS(GUEST).find((entry) => entry.message.type === 'ice' && entry.message.serial === 1),
            firstHello: SIGNALS(GUEST).find((entry) => entry.message.type === 'discover'),
            lostHello: SIGNALS(GUEST).find(
                (entry) => entry.message.type === 'discover' && entry.message.accepted === 1,
            ),
        };
        assert(
            Object.values(OLD).every(Boolean),
            'recorded signals of the first negotiation: ' + Object.keys(OLD).filter((k) => !OLD[k]),
        );
        const SETTLED_PEERS = negotiations();
        await HOST.signaling.wrapper.replay(OLD.offer.to, OLD.offer.message);
        await HOST.signaling.wrapper.replay(OLD.hostIce.to, OLD.hostIce.message);
        await GUEST.signaling.wrapper.replay(OLD.answer.to, OLD.answer.message);
        await GUEST.signaling.wrapper.replay(OLD.guestIce.to, OLD.guestIce.message);
        await GUEST.signaling.wrapper.replay(OLD.firstHello.to, OLD.firstHello.message);
        await GUEST.signaling.wrapper.replay(OLD.lostHello.to, OLD.lostHello.message);
        await SLEEP(1200);
        assert(
            bothOpen(HOST, GUEST, 2) && negotiations() === SETTLED_PEERS,
            'stale signals neither tear down nor restart a healthy link',
        );
        assert(
            errorsOf(HOST).length + errorsOf(GUEST).length === 0,
            'stale signals are dropped silently ' + describe(HOST, GUEST),
        );
        STEP('stale-signals');

        // 5. host 쪽에서 끊기, 그리고 앱이 reconnect()로 직접 다시 열기.
        HOST.room.peerConnection.close();
        await until(() => bothOpen(HOST, GUEST, 3), 'reconnect after the host closed its connection');
        assert(GUEST.room.reconnect({ reason: 'manual' }) === true, 'reconnect() accepted');
        await until(() => bothOpen(HOST, GUEST, 4), 'reconnect() brings the link back');
        const MANUAL = GUEST.events.find((event) => event.type === 'state' && event.reason === 'manual');
        assert(
            MANUAL?.state === 'interrupted' && MANUAL.forced === true,
            'reconnect() reason is reported as a state event',
        );
        await exchange(HOST, GUEST, 3);
        assert(
            errorsOf(HOST).length + errorsOf(GUEST).length === 0,
            'no errors while the signaling was healthy ' + describe(HOST, GUEST),
        );
        STEP('both-directions');

        // 6. offer가 자기 ICE 후보보다 늦게 도착해도(릴레이 순서 뒤바뀜) 후보는 버려지지 않고 그 협상에 쓰인다.
        HOST.signaling.offerDelayMs = 400;
        assert(GUEST.room.reconnect({ reason: 'early-ice' }) === true, 'reconnect for the early-ICE step');
        await until(() => bothOpen(HOST, GUEST, 5), 'reconnect with a delayed offer');
        HOST.signaling.offerDelayMs = 0;
        const LAST_OFFER = HOST.signaling.sent.findLast((entry) => entry.message.type === 'offer').message;
        const SENT_CANDIDATES = HOST.signaling.sent
            .filter((entry) => entry.message.type === 'ice' && entry.message.serial === LAST_OFFER.serial)
            .reduce((total, entry) => total + entry.message.candidates.length, 0);
        assert(SENT_CANDIDATES > 0, 'the host gathered candidates');
        assert(
            PEERS.at(-1).candidatesAdded === SENT_CANDIDATES,
            `every candidate that raced ahead of the offer was applied: ${PEERS.at(-1).candidatesAdded} of ${SENT_CANDIDATES}`,
        );
        STEP('early-ice');

        // 7. 신호가 끊긴 채 연결도 끊기면 상태를 지키다가, 신호가 돌아오면 같은 짝으로 다시 잇는다.
        const IDS = [HOST.signaling.wrapper.id, GUEST.signaling.wrapper.id];
        const BEFORE_OUTAGE = negotiations();
        HOST.signaling.outage = GUEST.signaling.outage = true;
        HOST.room.peerConnection.close();
        await until(() => HOST.room.state === 'interrupted' && GUEST.room.state === 'interrupted', 'both interrupted');
        await SLEEP(1500);
        assert(
            HOST.room.state === 'interrupted' && GUEST.room.state === 'interrupted',
            'interrupted, not failed, during the outage',
        );
        assert(
            errorsOf(GUEST).some((event) => event.code === 'signal-error'),
            'publish failures are reported',
        );
        assert(
            errorsOf(GUEST).some((event) => event.code === 'signaling-unavailable'),
            'rebuild failures are reported',
        );
        assert(negotiations() === BEFORE_OUTAGE, 'no negotiation without signaling');
        HOST.signaling.outage = GUEST.signaling.outage = false;
        await until(() => bothOpen(HOST, GUEST, 6), 'recovery after the outage');
        assert(HOST.signaling.created >= 2 && GUEST.signaling.created >= 2, 'the signaler was rebuilt');
        same([HOST.signaling.wrapper.id, GUEST.signaling.wrapper.id], IDS, 'the rebuilt signalers keep the identity');
        await exchange(HOST, GUEST, 4);
        STEP('signaling-outage');

        // 8. 게임 버전이 다르면 연결을 만들지 않고 양쪽에 알린다. host는 맞는 상대를 계속 기다린다.
        const MISMATCH_HOST = await open('host', { room: '4822', version: 'sim-A' });
        const PEERS_BEFORE_MISMATCH = negotiations();
        const WRONG = await open('join', { room: '4822', version: 'sim-B' });
        const FAILURE = await rejects(WRONG.room.opened, 'version-mismatch', 'mismatched guest');
        assert(FAILURE.message.includes('version-mismatch'), 'failure message names the reason');
        same(
            [WRONG.room.state, WRONG.room.transport.state, WRONG.room.failure.reason],
            ['failed', 'failed', 'version-mismatch'],
            'guest failed',
        );
        await until(() => MISMATCH_HOST.events.some((event) => event.type === 'version-mismatch'), 'host notified');
        const NOTICE = MISMATCH_HOST.events.find((event) => event.type === 'version-mismatch');
        same([NOTICE.kind, NOTICE.local, NOTICE.remote], ['version', 'sim-A', 'sim-B'], 'host notice');
        assert(MISMATCH_HOST.room.state === 'connecting', 'host keeps waiting');
        assert(negotiations() === PEERS_BEFORE_MISMATCH, 'no connection is attempted between mismatched versions');
        const RIGHT = await open('join', { room: '4822', version: 'sim-A' });
        await Promise.all([MISMATCH_HOST.room.opened, RIGHT.room.opened]);
        assert(bothOpen(MISMATCH_HOST, RIGHT, 1), 'matching guest connects to the waiting host');
        STEP('version-mismatch');

        // 9. 첫 연결 시간이 지나면 failed로 알리고, 같은 방 코드 충돌은 막으며, reconnect()로 다시 시작한다.
        const LONELY = await open('join', { room: '4823', timeoutMs: 800 });
        await rejects(LONELY.room.opened, 'timeout', 'lonely guest');
        same([LONELY.room.state, LONELY.room.failure.reason], ['failed', 'timeout'], 'timed out');
        const WAITING = await open('host', { room: '4823' });
        const CLASH = await rejects(open('host', { room: '4823' }), 'room-in-use', 'duplicate host');
        assert(/already in use/.test(CLASH.message), 'duplicate host message');
        assert(LONELY.room.reconnect() === true && LONELY.room.failure === null, 'a failed room can be reopened');
        await Promise.all([LONELY.room.opened, WAITING.room.opened]);
        assert(bothOpen(LONELY, WAITING, 1), 'reopened guest connects');
        STEP('timeout-and-revive');

        // 10. close()는 재연결을 일으키지 않는다. 상대는 interrupted로 알아채고, 닫은 쪽은 신호도 연결도 만들지 않는다.
        const GUEST_SENT = GUEST.signaling.sent.length;
        const PEERS_AT_CLOSE = negotiations();
        GUEST.room.close();
        same(
            [GUEST.room.state, GUEST.room.transport.state, GUEST.room.closed],
            ['closed', 'closed', true],
            'guest closed',
        );
        assert(
            GUEST.room.app.send(Uint8Array.of(1)) === false && GUEST.room.transport.send(packet(1, 1)) === false,
            'sends fail after close',
        );
        assert(GUEST.room.reconnect() === false, 'closed room cannot reconnect');
        await until(() => HOST.room.state === 'interrupted', 'host sees the guest leave');
        await SLEEP(1500);
        assert(GUEST.signaling.sent.length === GUEST_SENT, 'a closed room publishes nothing');
        assert(negotiations() === PEERS_AT_CLOSE, 'a closed room does not reconnect');

        // 11. 새로고침한 guest는 신호 id가 바뀌어 고정한 상대로 인정되지 않는다. host가 newPeer로 고정을 풀어야 받는다.
        const REPLACEMENT = await open('join', { room: '4821' });
        await SLEEP(1200);
        assert(
            HOST.room.state === 'interrupted' && REPLACEMENT.room.state === 'connecting',
            'a pinned host ignores a stranger',
        );
        const OLD_PEER = HOST.room.peerId;
        assert(HOST.room.reconnect({ reason: 'replace-guest', newPeer: true }) === true, 'newPeer reconnect accepted');
        await until(
            () => HOST.room.state === 'open' && REPLACEMENT.room.state === 'open' && HOST.room.generation === 7,
            'replacement guest connects',
        );
        assert(
            HOST.room.peerId !== OLD_PEER && HOST.room.peerId === REPLACEMENT.signaling.wrapper.id,
            'new peer pinned',
        );
        assert(REPLACEMENT.room.sessionId === HOST.room.sessionId, 'the host keeps its session');
        await exchange(HOST, REPLACEMENT, 5);
        const PEERS_AT_REPLACEMENT = negotiations();
        const HOST_SENT = HOST.signaling.sent.length;
        HOST.room.close();
        await SLEEP(800);
        assert(
            HOST.signaling.sent.length === HOST_SENT && negotiations() === PEERS_AT_REPLACEMENT,
            'closing the other side stops it too',
        );
        same(HOST.states.slice(-3), ['interrupted', 'open', 'closed'], 'host history ends open then closed');
        assert(REPLACEMENT.room.state === 'interrupted', 'the remaining guest notices');
        STEP('close');

        for (const ROOM of OPEN_ROOMS) {
            ROOM.close();
        }
        await SLEEP(100);
        assert(
            PEERS.every((peer) => peer.connectionState === 'closed' || peer.signalingState === 'closed'),
            'every connection is closed',
        );
        REPORT.negotiations = negotiations();
        REPORT.passed = true;
        return REPORT;
    } finally {
        for (const ROOM of OPEN_ROOMS) {
            ROOM.close();
        }
        globalThis.RTCPeerConnection = REAL_PEER_CONNECTION;
    }
}
