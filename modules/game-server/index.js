/**
 * Owns the inputs and applied acknowledgments for one authoritative world.
 * The adapter supplies a single clock in milliseconds and calls step once per tick.
 *
 * @template Id, Input, Packet, Snapshot
 * @param {import('./index.d.ts').AuthoritativeSessionOptions<Id, Input, Packet, Snapshot>} options
 * @returns {import('./index.d.ts').AuthoritativeSession<Id, Packet, Snapshot>}
 */
export function createAuthoritativeSession({
    world,
    createInput,
    mergeInput,
    resetInput,
    consumeInput,
    inputTimeoutMs = 500,
}) {
    if (!Number.isFinite(inputTimeoutMs) || inputTimeoutMs < 0) {
        throw new RangeError('inputTimeoutMs must be a non-negative finite number');
    }
    const PARTICIPANTS = new Map();
    const INPUTS = new Map();
    let disposed = false;

    return {
        get size() {
            return PARTICIPANTS.size;
        },
        join(id, nowMs) {
            if (disposed || PARTICIPANTS.has(id)) {
                return false;
            }
            const INPUT = createInput();
            world.join(id);
            PARTICIPANTS.set(id, { receivedSeq: -1, ackSeq: -1, receivedAt: nowMs });
            INPUTS.set(id, INPUT);
            return true;
        },
        leave(id) {
            if (!PARTICIPANTS.has(id)) {
                return false;
            }
            world.leave(id);
            PARTICIPANTS.delete(id);
            INPUTS.delete(id);
            return true;
        },
        receive(id, seq, packet, nowMs) {
            const PARTICIPANT = PARTICIPANTS.get(id);
            if (!PARTICIPANT || !Number.isSafeInteger(seq) || seq <= PARTICIPANT.receivedSeq) {
                return false;
            }
            mergeInput(INPUTS.get(id), packet);
            PARTICIPANT.receivedSeq = seq;
            PARTICIPANT.receivedAt = nowMs;
            return true;
        },
        lastReceivedAt(id) {
            return PARTICIPANTS.get(id)?.receivedAt;
        },
        step(nowMs) {
            if (PARTICIPANTS.size === 0) {
                return;
            }
            for (const [ID, PARTICIPANT] of PARTICIPANTS) {
                if (nowMs - PARTICIPANT.receivedAt > inputTimeoutMs) {
                    resetInput(INPUTS.get(ID));
                }
            }
            world.tick(INPUTS);
            for (const [ID, PARTICIPANT] of PARTICIPANTS) {
                PARTICIPANT.ackSeq = PARTICIPANT.receivedSeq;
                consumeInput(INPUTS.get(ID));
            }
        },
        snapshot(id) {
            const PARTICIPANT = PARTICIPANTS.get(id);
            if (!PARTICIPANT) {
                return null;
            }
            const SNAPSHOT = world.snapshot(id);
            return SNAPSHOT == null ? null : { snapshot: SNAPSHOT, ackSeq: PARTICIPANT.ackSeq };
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            PARTICIPANTS.clear();
            INPUTS.clear();
            world.dispose();
        },
    };
}
