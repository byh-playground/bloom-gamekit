import { CHUNK_SIZE, TYPE } from '../_rollback-shared/protocol.js';
import { bytes, hashBytes, nowMs, integer } from '../deterministic/utilities.js';
const STAR_HEADER = 24,
    STAR_PAYLOAD = CHUNK_SIZE - STAR_HEADER,
    STAR_MAGIC = 0x31535452;
/** Logical peer transports over one physical host link per guest. Owns framing, not game state. */
export function createStarTransports({
    players,
    localPlayerId,
    hostPlayerId,
    sessionId,
    physicalTransports,
    onError = () => {},
    maxQueuedBytes = 5 * 1024 * 1024,
} = {}) {
    if (
        !Array.isArray(players) ||
        players.length < 2 ||
        players.length > 8 ||
        new Set(players).size !== players.length ||
        !players.includes(localPlayerId) ||
        !players.includes(hostPlayerId) ||
        typeof sessionId !== 'string' ||
        !(physicalTransports instanceof Map) ||
        typeof onError !== 'function'
    ) {
        throw new TypeError('star transport configuration');
    }
    integer(maxQueuedBytes, 'star queue budget', CHUNK_SIZE * 2, 64 * 1024 * 1024);
    const LOCAL = players.indexOf(localPlayerId),
        HOST = players.indexOf(hostPlayerId),
        IS_HOST = LOCAL === HOST;
    const REQUIRED = IS_HOST ? players.filter((id) => id !== localPlayerId) : [hostPlayerId];
    if (REQUIRED.some((id) => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) {
        throw new TypeError('missing star physical transport');
    }
    const TAG = hashBytes(new TextEncoder().encode(sessionId)),
        LISTENERS = new Map(),
        STATUS_LISTENERS = new Map();
    const QUEUES = new Map(REQUIRED.map((id) => [id, []])),
        ASSEMBLIES = new Map(),
        COMPLETED = new Map();
    const UNSUBS = [],
        STATS = {
            sentFrames: 0,
            forwardedFrames: 0,
            rejectedFrames: 0,
            queuedBytes: 0,
            queuedFrames: 0,
            assemblyBytes: 0,
        };
    let closed = false;
    let sequence = 0;
    let pumping = false;
    function reject() {
        STATS.rejectedFrames++;
    }
    function close() {
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(TIMER);
        for (const REMOVE of UNSUBS.splice(0)) {
            REMOVE();
        }
        QUEUES.forEach((q) => (q.length = 0));
        ASSEMBLIES.clear();
        COMPLETED.clear();
        STATS.queuedBytes = 0;
        STATS.queuedFrames = 0;
        STATS.assemblyBytes = 0;
        for (const SET of STATUS_LISTENERS.values()) {
            for (const FN of SET) {
                try {
                    FN('closed');
                } catch {
                    // One status listener must not block transport teardown.
                }
            }
        }
        LISTENERS.clear();
        STATUS_LISTENERS.clear();
    }
    function fail(message) {
        if (closed) {
            return;
        }
        close();
        try {
            onError(new Error(message));
        } catch {
            // An error observer must not replace the original transport failure.
        }
    }
    function pump() {
        if (closed || pumping) {
            return;
        }
        pumping = true;
        try {
            const NOW = nowMs();
            for (const [ID, Q] of QUEUES) {
                let work = 0;
                while (Q.length && work++ < 128 && !closed) {
                    if (NOW - Q[0].at > 10000) {
                        fail('star forwarding backpressure timeout');
                        break;
                    }
                    if (physicalTransports.get(ID).send(Q[0].bytes) === false) {
                        break;
                    }
                    STATS.queuedBytes -= Q.shift().bytes.length;
                    STATS.queuedFrames--;
                    STATS.sentFrames++;
                }
            }
            for (const [KEY, A] of ASSEMBLIES) {
                if (NOW - A.at > 2000) {
                    ASSEMBLIES.delete(KEY);
                    STATS.assemblyBytes -= A.total;
                }
            }
        } catch (error) {
            fail('star forwarding failed: ' + error.message);
        } finally {
            pumping = false;
        }
    }
    function enqueue(id, frames, forwarded) {
        const SIZE = frames.reduce((n, b) => n + b.length, 0),
            Q = QUEUES.get(id);
        if (closed || !Q || (physicalTransports.get(id).state && physicalTransports.get(id).state !== 'open')) {
            return false;
        }
        if (STATS.queuedBytes + SIZE > maxQueuedBytes || STATS.queuedFrames + frames.length > 4096) {
            if (forwarded) {
                fail('star forwarding queue capacity');
            }
            return false;
        }
        const AT = nowMs();
        for (const B of frames) {
            Q.push({
                bytes: B.slice(),
                at: AT,
            });
        }
        STATS.queuedBytes += SIZE;
        STATS.queuedFrames += frames.length;
        if (forwarded) {
            STATS.forwardedFrames += frames.length;
        }
        pump();
        return !closed;
    }
    function deliver(from, id, payload, lane) {
        const ACTUAL_LANE = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
        if (ACTUAL_LANE !== lane) {
            reject();
            return;
        }
        let seen = COMPLETED.get(from);
        if (!seen) {
            COMPLETED.set(from, (seen = new Set()));
        }
        if (seen.has(id)) {
            return;
        }
        seen.add(id);
        if (seen.size > 256) {
            seen.delete(seen.values().next().value);
        }
        const TARGET = LISTENERS.get(players[from]);
        if (TARGET?.size) {
            for (const FN of TARGET) {
                FN(payload.slice());
            }
        }
        // Core HELLO/input retransmission owns delivery before a consumer subscribes.
    }
    function receive(physicalId, data) {
        if (closed) {
            return;
        }
        let b;
        try {
            b = bytes(data);
        } catch {
            reject();
            return;
        }
        if (b.length < STAR_HEADER || b.length > CHUNK_SIZE) {
            reject();
            return;
        }
        const V = new DataView(b.buffer, b.byteOffset, b.byteLength),
            FROM = b[6],
            TO = b[7],
            LANE = b[5];
        const ID = V.getUint32(12, true),
            TOTAL = V.getUint16(16, true),
            OFFSET = V.getUint16(18, true),
            LENGTH = V.getUint16(20, true);
        if (
            V.getUint32(0, true) !== STAR_MAGIC ||
            b[4] !== 1 ||
            V.getUint32(8, true) !== TAG ||
            V.getUint16(22, true) !== 0 ||
            ![1, TYPE.INPUT, TYPE.CLOCK].includes(LANE) ||
            FROM >= players.length ||
            TO >= players.length ||
            FROM === TO ||
            FROM === LOCAL ||
            !ID ||
            !TOTAL ||
            TOTAL > CHUNK_SIZE ||
            ![0, STAR_PAYLOAD].includes(OFFSET) ||
            OFFSET >= TOTAL ||
            LENGTH !== Math.min(STAR_PAYLOAD, TOTAL - OFFSET) ||
            b.length !== STAR_HEADER + LENGTH ||
            (IS_HOST ? players[FROM] !== physicalId : physicalId !== hostPlayerId || TO !== LOCAL)
        ) {
            reject();
            return;
        }
        if (TO !== LOCAL) {
            if (!IS_HOST || !enqueue(players[TO], [b], true)) {
                if (!closed) {
                    fail('star destination is not available');
                }
            }
            return;
        }
        if (COMPLETED.get(FROM)?.has(ID)) {
            return;
        }
        if (TOTAL <= STAR_PAYLOAD) {
            deliver(FROM, ID, b.slice(STAR_HEADER), LANE);
            return;
        }
        const KEY = FROM + ':' + ID;
        let a = ASSEMBLIES.get(KEY);
        if (!a) {
            if (ASSEMBLIES.size >= 32 || STATS.assemblyBytes + TOTAL > 512 * 1024) {
                reject();
                return;
            }
            a = {
                total: TOTAL,
                lane: LANE,
                bytes: new Uint8Array(TOTAL),
                seen: new Set(),
                at: nowMs(),
            };
            ASSEMBLIES.set(KEY, a);
            STATS.assemblyBytes += TOTAL;
        }
        if (a.total !== TOTAL || a.lane !== LANE) {
            reject();
            return;
        }
        if (a.seen.has(OFFSET)) {
            for (let i = 0; i < LENGTH; i++) {
                if (a.bytes[OFFSET + i] !== b[STAR_HEADER + i]) {
                    reject();
                    return;
                }
            }
            return;
        }
        a.bytes.set(b.subarray(STAR_HEADER), OFFSET);
        a.seen.add(OFFSET);
        if (a.seen.size === 2) {
            ASSEMBLIES.delete(KEY);
            STATS.assemblyBytes -= TOTAL;
            deliver(FROM, ID, a.bytes, LANE);
        }
    }
    const TIMER = setInterval(pump, 16);
    TIMER.unref?.();
    const TRANSPORTS = new Map();
    for (const REMOTE of players.filter((id) => id !== localPlayerId)) {
        LISTENERS.set(REMOTE, new Set());
        STATUS_LISTENERS.set(REMOTE, new Set());
        const PHYSICAL = IS_HOST ? REMOTE : hostPlayerId;
        TRANSPORTS.set(REMOTE, {
            get state() {
                return closed ? 'closed' : (physicalTransports.get(PHYSICAL).state ?? 'open');
            },
            send(data) {
                if (closed) {
                    return false;
                }
                const PAYLOAD = bytes(data);
                if (!PAYLOAD.length || PAYLOAD.length > CHUNK_SIZE) {
                    throw new RangeError('star packet size');
                }
                sequence = (sequence + 1) >>> 0 || 1;
                const ID = sequence,
                    FRAMES = [];
                const LANE = PAYLOAD.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(PAYLOAD[5]) ? PAYLOAD[5] : 1;
                for (let offset = 0; offset < PAYLOAD.length; offset += STAR_PAYLOAD) {
                    const LENGTH = Math.min(STAR_PAYLOAD, PAYLOAD.length - offset),
                        B = new Uint8Array(STAR_HEADER + LENGTH),
                        V = new DataView(B.buffer);
                    V.setUint32(0, STAR_MAGIC, true);
                    B[4] = 1;
                    B[5] = LANE;
                    B[6] = LOCAL;
                    B[7] = players.indexOf(REMOTE);
                    V.setUint32(8, TAG, true);
                    V.setUint32(12, ID, true);
                    V.setUint16(16, PAYLOAD.length, true);
                    V.setUint16(18, offset, true);
                    V.setUint16(20, LENGTH, true);
                    B.set(PAYLOAD.subarray(offset, offset + LENGTH), STAR_HEADER);
                    FRAMES.push(B);
                }
                return enqueue(PHYSICAL, FRAMES, false);
            },
            subscribe(fn) {
                if (closed || typeof fn !== 'function') {
                    throw new TypeError('star subscriber');
                }
                const SET = LISTENERS.get(REMOTE);
                SET.add(fn);
                return () => SET.delete(fn);
            },
            subscribeStatus(fn) {
                if (closed || typeof fn !== 'function') {
                    throw new TypeError('star status subscriber');
                }
                const SET = STATUS_LISTENERS.get(REMOTE);
                SET.add(fn);
                return () => SET.delete(fn);
            },
            close() {
                LISTENERS.get(REMOTE)?.clear();
                STATUS_LISTENERS.get(REMOTE)?.clear();
            },
        });
    }
    try {
        for (const ID of REQUIRED) {
            const RAW = physicalTransports.get(ID);
            UNSUBS.push(RAW.subscribe((data) => receive(ID, data)));
            if (RAW.subscribeStatus) {
                UNSUBS.push(
                    RAW.subscribeStatus((state) => {
                        for (const [REMOTE, SET] of STATUS_LISTENERS) {
                            if (!IS_HOST || REMOTE === ID) {
                                for (const FN of SET) {
                                    try {
                                        FN(state);
                                    } catch {
                                        // One status listener must not block the remaining listeners.
                                    }
                                }
                            }
                        }
                    }),
                );
            }
        }
    } catch (error) {
        close();
        throw error;
    }
    return {
        transports: TRANSPORTS,
        close,
        get metrics() {
            return {
                ...STATS,
            };
        },
    };
}
