import assert from 'node:assert/strict';
import { createAuthoritativeSession } from '../../../dist/authoritative-session.js';

const PLAYERS = new Map();
let disposed = 0;
const SESSION = createAuthoritativeSession({
    world: {
        join(id) {
            PLAYERS.set(id, { x: 0, hits: 0 });
        },
        leave(id) {
            PLAYERS.delete(id);
        },
        tick(inputs) {
            for (const [ID, INPUT] of inputs) {
                const PLAYER = PLAYERS.get(ID);
                PLAYER.x += INPUT.x;
                PLAYER.hits += Number(INPUT.attack);
            }
        },
        snapshot() {
            return Object.fromEntries([...PLAYERS].map(([id, player]) => [id, { ...player }]));
        },
        dispose() {
            PLAYERS.clear();
            disposed++;
        },
    },
    createInput: () => ({ x: 0, attack: false }),
    mergeInput(current, packet) {
        current.x = packet.x;
        current.attack ||= packet.attack;
    },
    resetInput(current) {
        current.x = 0;
        current.attack = false;
    },
    consumeInput(current) {
        current.attack = false;
    },
});

// Two miners see one world. Keep the attack edge even when the next packet only moves.
assert.equal(SESSION.join('miner', 0), true);
assert.equal(SESSION.join('partner', 0), true);
assert.equal(SESSION.join('miner', 1), false);
assert.equal(SESSION.size, 2);
assert.equal(SESSION.receive('miner', 3, { x: 1, attack: true }, 4), true);
assert.equal(SESSION.receive('miner', 4, { x: 2, attack: false }, 8), true);
assert.equal(SESSION.receive('miner', 4, { x: 9, attack: true }, 12), false);
assert.equal(SESSION.receive('miner', 3, { x: 9, attack: true }, 12), false);
assert.equal(SESSION.receive('miner', 4.5, { x: 9, attack: true }, 12), false);
assert.equal(SESSION.lastReceivedAt('miner'), 8);
assert.equal(SESSION.snapshot('miner').ackSeq, -1);
SESSION.step(16);
assert.deepEqual(SESSION.snapshot('miner'), {
    snapshot: {
        miner: { x: 2, hits: 1 },
        partner: { x: 0, hits: 0 },
    },
    ackSeq: 4,
});
assert.deepEqual(SESSION.snapshot('partner'), {
    snapshot: SESSION.snapshot('miner').snapshot,
    ackSeq: -1,
});

// The edge is consumed once. Movement expires strictly after 500 ms since accepted receipt.
SESSION.step(508);
assert.deepEqual(SESSION.snapshot('miner').snapshot.miner, { x: 4, hits: 1 });
SESSION.step(509);
assert.deepEqual(SESSION.snapshot('miner').snapshot.miner, { x: 4, hits: 1 });

assert.equal(SESSION.leave('miner'), true);
assert.equal(SESSION.leave('miner'), false);
assert.equal(SESSION.snapshot('miner'), null);
assert.equal(SESSION.lastReceivedAt('miner'), undefined);
assert.equal(SESSION.receive('miner', 10, { x: 3, attack: true }, 510), false);
assert.deepEqual(SESSION.snapshot('partner').snapshot, { partner: { x: 0, hits: 0 } });

// Rejoining starts a new input stream, independent of the previous connection.
assert.equal(SESSION.join('miner', 520), true);
assert.equal(SESSION.receive('miner', 0, { x: -1, attack: true }, 524), true);
SESSION.step(532);
assert.equal(SESSION.snapshot('miner').ackSeq, 0);
assert.deepEqual(SESSION.snapshot('partner').snapshot.miner, { x: -1, hits: 1 });

SESSION.dispose();
SESSION.dispose();
assert.equal(disposed, 1);
assert.equal(SESSION.size, 0);
assert.equal(SESSION.join('miner', 540), false);

console.log(
    'Authoritative session: shared world, input order, applied ACK, edge, timeout, reconnect and disposal PASS',
);
