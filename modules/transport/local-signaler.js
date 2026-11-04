import { nostrToHex } from './nostr-crypto.js';
// 같은 페이지 안의 방 연결끼리만 신호를 주고받는 전달자. 방마다 하나의 버스를 공유한다.
const LOCAL_BUSES = new Map();
const HEX32 = /^[0-9a-f]{64}$/;
/**
 * `createNostrSignaler`와 같은 Signaler 계약을 만족하는 페이지 안 신호 전달자입니다.
 * 릴레이·서명·네트워크 없이 같은 `namespace`·`room`의 다른 전달자에게만 배달합니다.
 * 배달은 마이크로태스크에서 하며 메시지는 JSON으로 복사합니다. 구독하기 전에 온 메시지는 보관하지 않습니다.
 */
export async function createLocalSignaler({
    room,
    namespace = 'rollback-netcode',
    onStatus = () => {},
    signal,
    identity,
} = {}) {
    if (signal?.aborted) {
        throw new Error('Local signaler aborted');
    }
    if (typeof room !== 'string' || !/^\d{4}$/.test(room)) {
        throw new TypeError('room must contain exactly four ASCII digits');
    }
    if (typeof namespace !== 'string' || namespace.trim().length === 0) {
        throw new TypeError('namespace must be a nonempty string');
    }
    if (identity && (!HEX32.test(identity.id) || typeof identity.close !== 'function')) {
        throw new TypeError('Local signaler identity capability');
    }
    const KEY = `${namespace}\u0000${room}`;
    const ID = identity?.id ?? nostrToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const LISTENERS = new Set();
    let closed = false;
    const MEMBER = { id: ID, deliver: null };
    let members = LOCAL_BUSES.get(KEY);
    if (!members) {
        members = new Map();
        LOCAL_BUSES.set(KEY, members);
    }
    if (members.has(ID)) {
        throw new Error('Local signaler identity is already connected to this room');
    }
    members.set(ID, MEMBER);
    MEMBER.deliver = (envelope) => {
        if (closed) {
            return;
        }
        for (const LISTENER of [...LISTENERS]) {
            try {
                LISTENER(envelope);
            } catch (error) {
                onStatus({
                    type: 'signaler',
                    transport: 'local',
                    status: 'error',
                    message: String(error?.message ?? error),
                });
            }
        }
    };
    function close() {
        if (closed) {
            return;
        }
        closed = true;
        signal?.removeEventListener('abort', close);
        const CURRENT = LOCAL_BUSES.get(KEY);
        CURRENT?.delete(ID);
        if (CURRENT?.size === 0) {
            LOCAL_BUSES.delete(KEY);
        }
        LISTENERS.clear();
        identity?.close();
    }
    signal?.addEventListener('abort', close, { once: true });
    onStatus({ type: 'signaler', transport: 'local', status: 'connected' });
    return {
        id: ID,
        room,
        async send(to, message) {
            if (closed) {
                throw new Error('Local signaler closed');
            }
            if (to !== '*' && !HEX32.test(to)) {
                throw new TypeError('Local recipient must be a lowercase public key or *');
            }
            const COPY = JSON.parse(JSON.stringify(message));
            for (const [PEER_ID, PEER] of LOCAL_BUSES.get(KEY) ?? []) {
                if (PEER_ID !== ID && (to === '*' || to === PEER_ID)) {
                    queueMicrotask(() => PEER.deliver({ from: ID, to, message: JSON.parse(JSON.stringify(COPY)) }));
                }
            }
        },
        subscribe(listener) {
            if (closed) {
                throw new Error('Local signaler closed');
            }
            if (typeof listener !== 'function') {
                throw new TypeError('Signaling subscriber must be a function');
            }
            LISTENERS.add(listener);
            return () => LISTENERS.delete(listener);
        },
        close,
    };
}
