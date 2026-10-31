import { nostrOrder, nostrBytesToNumber, nostrToHex, nostrFromHex, nostrPublicKey, nostrSign } from './nostr-crypto.js';
import { integer } from '../deterministic/utilities.js';
import { createSave as CREATE_SAVE, SaveError as SAVE_ERROR } from '../save/index.js';
const HEX32 = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID = 'invalid resume record; explicitly reset for a fresh room',
    EXPIRED = 'resume record expired; explicitly reset for a fresh room',
    UNAVAILABLE = 'resume storage unavailable';
const UNREADABLE = (error) => error instanceof SAVE_ERROR && error.kind === 'unreadable';

/**
 * One save record written from synchronous room handlers. Writes run in call order. After `release()`
 * the save closes once queued writes finish; a later write reopens it with a fresh load.
 */
export function createResumeRecord(options) {
    let save = null,
        pending = Promise.resolve(),
        released = false;
    const SETTLE = () => {
        if (!released) {
            return;
        }
        const LAST = pending;
        LAST.then(() => {
            if (pending === LAST && save) {
                save.dispose();
                save = null;
            }
        });
    };
    const RUN = (operation) => {
        const RESULT = pending.then(operation);
        pending = RESULT.then(
            () => {},
            () => {},
        );
        SETTLE();
        return RESULT;
    };
    return {
        /** Reads the record, or discards whatever is stored (readable or not) when `reset` is true. */
        open: (reset) =>
            RUN(() => {
                save ??= CREATE_SAVE(options);
                return reset ? save.reset() : save.load();
            }),
        /** Applies a synchronous `mutate` after every earlier write. */
        write: (mutate) =>
            RUN(async () => {
                if (!save) {
                    save = CREATE_SAVE(options);
                    await save.load();
                }
                return save.update(mutate);
            }),
        release() {
            released = true;
            SETTLE();
        },
    };
}

const IDENTITY_SAVE = ({ adapter, key }, { namespace, room }) => ({
    adapter,
    key: key ?? `bloom-gamekit:dynamic-v2:${namespace}:${room}`,
    version: 1,
    create: () => ({ identity: null }),
    validate(data) {
        const VALUE = data?.identity;
        if (VALUE === null) {
            return;
        }
        if (
            !VALUE ||
            typeof VALUE !== 'object' ||
            VALUE.namespace !== namespace ||
            VALUE.room !== room ||
            !HEX32.test(VALUE.id) ||
            !HEX32.test(VALUE.secret) ||
            !Number.isSafeInteger(VALUE.createdAt) ||
            !Number.isSafeInteger(VALUE.expiresAt) ||
            VALUE.expiresAt - VALUE.createdAt > DAY_MS ||
            (VALUE.sessionId !== null &&
                (typeof VALUE.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(VALUE.sessionId))) ||
            !Array.isArray(VALUE.players) ||
            VALUE.players.length > 5 ||
            VALUE.players.some((id) => !HEX32.test(id)) ||
            new Set(VALUE.players).size !== VALUE.players.length ||
            !Number.isSafeInteger(VALUE.epoch) ||
            VALUE.epoch < 0 ||
            VALUE.epoch > 65534 ||
            (VALUE.coordinatorId !== null && !VALUE.players.includes(VALUE.coordinatorId))
        ) {
            throw new TypeError('resume identity record');
        }
    },
});
function resumeOptions({ key, lifetimeMs = 8 * 60 * 60 * 1000, reset = false } = {}) {
    integer(lifetimeMs, 'resume lifetimeMs', 1000, DAY_MS);
    if (key !== undefined && (typeof key !== 'string' || !key.length || key.length > 512)) {
        throw new TypeError('resume storage key');
    }
    if (typeof reset !== 'boolean') {
        throw new TypeError('resume reset');
    }
    return { lifetimeMs, reset };
}

/** Discards the stored room identity, readable or not. */
export async function resetRoomResume(resume, scope) {
    resumeOptions(resume);
    const RECORD = createResumeRecord(IDENTITY_SAVE(resume, scope));
    try {
        await RECORD.open(true);
    } finally {
        RECORD.release();
    }
}

/**
 * Internal opt-in resume identity kept in one save record. No plaintext credential is returned by the room.
 * Writes during play are queued; a failed one closes the identity and reaches `onWriteFailure`.
 */
export async function createRoomResumeIdentity(resume, { namespace, room, onWriteFailure }) {
    const { lifetimeMs: LIFETIME_MS, reset: RESET } = resumeOptions(resume);
    if (typeof onWriteFailure !== 'function') {
        throw new TypeError('resume onWriteFailure');
    }
    const RECORD = createResumeRecord(IDENTITY_SAVE(resume, { namespace, room }));
    let saved;
    let secret;
    let forgotten = false;
    let closed = false;
    try {
        try {
            ({ identity: saved } = await RECORD.open(RESET));
        } catch (error) {
            throw UNREADABLE(error) ? new Error(INVALID, { cause: error }) : error;
        }
        const NOW = Date.now();
        if (saved) {
            if (saved.expiresAt <= NOW) {
                throw new Error(EXPIRED);
            }
            secret = nostrFromHex(saved.secret);
            const SCALAR = nostrBytesToNumber(secret);
            if (
                saved.createdAt > NOW ||
                SCALAR <= 0n ||
                SCALAR >= nostrOrder ||
                nostrToHex(nostrPublicKey(secret)) !== saved.id
            ) {
                throw new Error(INVALID);
            }
        } else {
            secret = new Uint8Array(32);
            let valid = false;
            for (let attempt = 0; attempt < 16; attempt++) {
                globalThis.crypto.getRandomValues(secret);
                const VALUE = nostrBytesToNumber(secret);
                if (VALUE > 0n && VALUE < nostrOrder) {
                    valid = true;
                    break;
                }
            }
            if (!valid) {
                throw new Error('resume identity generation failed');
            }
            const FRESH = {
                namespace,
                room,
                id: nostrToHex(nostrPublicKey(secret)),
                secret: nostrToHex(secret),
                createdAt: NOW,
                expiresAt: NOW + LIFETIME_MS,
                sessionId: null,
                coordinatorId: null,
                epoch: 0,
                players: [],
            };
            try {
                await RECORD.write((draft) => {
                    draft.identity = FRESH;
                });
            } catch (error) {
                throw new Error(UNAVAILABLE, { cause: error });
            }
            saved = FRESH;
        }
    } catch (error) {
        secret?.fill(0);
        RECORD.release();
        throw error;
    }
    const ID = saved.id;
    let record = saved;
    const METADATA =
        saved.sessionId === null
            ? null
            : {
                  sessionId: saved.sessionId,
                  coordinatorId: saved.coordinatorId,
                  epoch: saved.epoch,
                  players: [...saved.players],
              };
    function close() {
        if (closed) {
            return;
        }
        closed = true;
        secret.fill(0);
        record = null;
        RECORD.release();
    }
    function persist(value) {
        RECORD.write((draft) => {
            draft.identity = value;
        }).catch((error) => {
            close();
            onWriteFailure(error);
        });
    }
    return {
        metadata: METADATA,
        identity: {
            id: ID,
            sign(hash, auxiliary, cryptoImpl) {
                if (closed) {
                    throw new Error('resume identity closed');
                }
                return nostrSign(hash, secret, auxiliary, cryptoImpl);
            },
            close,
        },
        update(value) {
            if (!forgotten && !closed) {
                record = {
                    ...record,
                    ...value,
                    players: [...value.players],
                };
                persist(record);
            }
        },
        forget() {
            forgotten = true;
            persist(null);
        },
    };
}
