import { bytes } from '../deterministic/utilities.js';
import { WebRTCTransport } from './webrtc.js';
// 앱 채널 한 프레임의 최대 크기. 브라우저 SCTP 메시지 한도(기본 256 KiB)보다 작게 둡니다.
export const APP_MESSAGE_LIMIT = 256 * 1024 - 1024;
// 채널 버퍼가 이 크기 이상이면 송신 큐에 쌓고, 낮은 수위 아래로 내려오면 이어서 보냅니다.
const APP_HIGH_WATER = 512 * 1024;
const APP_LOW_WATER = 128 * 1024;
// 큐에 쌓을 수 있는 총량. 넘기면 그 프레임은 버리고 오류로 알립니다.
const APP_QUEUE_LIMIT = 8 * 1024 * 1024;

/**
 * 재연결을 거쳐도 같은 객체로 남는 두 송수신 창구를 만듭니다.
 * `transport`는 netcode 입력·제어 채널(rollback `Transport`), `app`은 앱 채널입니다.
 * 방은 연결이 열릴 때마다 `attach`, 잃을 때마다 `detach`하고, 구독자는 그동안 그대로 유지됩니다.
 * 두 창구는 방이 소유하므로 `close()`를 노출하지 않습니다. rollback 코어가 닫아도 방은 남습니다.
 */
export function createRoomChannels({ onError, onSendFailure }) {
    const NETCODE_LISTENERS = new Set();
    const APP_LISTENERS = new Set();
    const STATUS_LISTENERS = new Set();
    let state = 'connecting';
    let netcode = null;
    let unsubscribeNetcode = null;
    let appChannel = null;
    let queue = [];
    let queuedBytes = 0;
    let closed = false;

    function listen(set, listener, name) {
        if (typeof listener !== 'function') {
            throw new TypeError(name);
        }
        if (closed) {
            return () => {};
        }
        set.add(listener);
        return () => set.delete(listener);
    }
    function deliver(set, data, code) {
        let first = true;
        for (const LISTENER of [...set]) {
            try {
                LISTENER(first ? data : data.slice());
            } catch (error) {
                onError(code, error);
            }
            first = false;
        }
    }
    function flush() {
        const CHANNEL = appChannel;
        while (CHANNEL && queue.length && CHANNEL.readyState === 'open' && CHANNEL.bufferedAmount < APP_HIGH_WATER) {
            const FRAME = queue.shift();
            queuedBytes -= FRAME.length;
            try {
                CHANNEL.send(FRAME);
            } catch (error) {
                onError('send-failed', error);
                onSendFailure();
                return;
            }
        }
    }
    function dropQueue() {
        queue = [];
        queuedBytes = 0;
    }

    const TRANSPORT = {
        get state() {
            return state;
        },
        get bufferedAmount() {
            return netcode?.bufferedAmount ?? 0;
        },
        send(data) {
            // 연결이 붙어 있는 동안은 `disconnected` 유예 중에도 보냅니다. 채널이 닫히면 detach되어 false가 됩니다.
            return netcode ? netcode.send(data) : false;
        },
        subscribe: (listener) => listen(NETCODE_LISTENERS, listener, 'transport subscriber'),
        subscribeStatus: (listener) => listen(STATUS_LISTENERS, listener, 'status subscriber'),
    };
    const APP = {
        get bufferedAmount() {
            return (appChannel?.bufferedAmount ?? 0) + queuedBytes;
        },
        send(data) {
            const FRAME = bytes(data, 'app message');
            if (FRAME.length > APP_MESSAGE_LIMIT) {
                throw new RangeError('app message size');
            }
            const CHANNEL = appChannel;
            if (!CHANNEL || CHANNEL.readyState !== 'open') {
                return false;
            }
            if (queue.length || CHANNEL.bufferedAmount >= APP_HIGH_WATER) {
                if (queuedBytes + FRAME.length > APP_QUEUE_LIMIT) {
                    onError('send-queue-overflow', new RangeError('app send queue overflow'));
                    return false;
                }
                queue.push(FRAME.slice());
                queuedBytes += FRAME.length;
                return true;
            }
            try {
                CHANNEL.send(FRAME);
                return true;
            } catch (error) {
                onError('send-failed', error);
                onSendFailure();
                return false;
            }
        },
        subscribe: (listener) => listen(APP_LISTENERS, listener, 'app subscriber'),
    };

    return {
        transport: TRANSPORT,
        app: APP,
        /** 열린 연결의 세 채널을 창구에 연결합니다. 이전 연결은 먼저 `detach`되어 있어야 합니다. */
        attach({ inputs, control, app }) {
            const CARRIER = new WebRTCTransport({ inputChannel: inputs, controlChannel: control });
            netcode = CARRIER;
            unsubscribeNetcode = CARRIER.subscribe((packet) => deliver(NETCODE_LISTENERS, packet, 'listener'));
            app.binaryType = 'arraybuffer';
            app.bufferedAmountLowThreshold = APP_LOW_WATER;
            app.onbufferedamountlow = flush;
            app.onmessage = (event) => {
                if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > APP_MESSAGE_LIMIT) {
                    onError('app-frame', new TypeError('app frames must be binary and at most ' + APP_MESSAGE_LIMIT));
                    return;
                }
                deliver(APP_LISTENERS, new Uint8Array(event.data), 'listener');
            };
            appChannel = app;
        },
        /** 세 채널을 닫고 송신 큐를 버립니다. 구독자는 남깁니다. */
        detach() {
            unsubscribeNetcode?.();
            unsubscribeNetcode = null;
            netcode?.close();
            netcode = null;
            if (appChannel) {
                appChannel.onbufferedamountlow = appChannel.onmessage = null;
                appChannel.close();
                appChannel = null;
            }
            dropQueue();
        },
        setState(next) {
            if (next === state) {
                return;
            }
            state = next;
            for (const LISTENER of [...STATUS_LISTENERS]) {
                try {
                    LISTENER(next);
                } catch (error) {
                    onError('listener', error);
                }
            }
        },
        close() {
            closed = true;
            NETCODE_LISTENERS.clear();
            APP_LISTENERS.clear();
            STATUS_LISTENERS.clear();
        },
    };
}
