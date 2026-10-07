import test from 'node:test';
import assert from 'node:assert/strict';
import { createNostrDynamicRoom } from '../index.js';

// In-memory signaling + RTC capability fixture. This is not a real browser/RTC test.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function fixture({ drop = () => false, pendingPeers = false } = {}) {
  const instances = new Set(), signals = new Map(), offers = new Map(), messages = [], connections = [], peerSignals = [];
  let serial = 0, offerSerial = 0;
  function endpoint() {
    const listeners = new Set(), statuses = new Set(); let other, closed = false;
    const peer = { bind(value) { other = value; }, get closed() { return closed; },
      transport: { get state() { return closed ? 'closed' : 'open'; },
        send(bytes) { if (closed) return false; queueMicrotask(() => other?.receive(bytes.slice())); return true; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        subscribeStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); }, close() { peer.close(); } },
      receive(bytes) { if (!closed && !peer.blackhole) for (const fn of [...listeners]) fn(bytes); },
      close() { if (closed) return; closed = true; for (const fn of [...statuses]) fn('closed'); other?.close(); listeners.clear(); statuses.clear(); },
      peerConnection: { connectionState: 'connected' }
    }; return peer;
  }
  const signalerFactory = async ({ identity } = {}) => {
    const id = identity?.id ?? 'p' + serial++, listeners = new Set(); let closed = false;
    const value = { id, listeners, get closed() { return closed; },
      async send(to, message) {
        if (closed) throw Error('signaler closed');
        const envelope = { from: id, to, message: structuredClone(message) }; messages.push(envelope);
        if (drop(envelope)) return;
        queueMicrotask(() => {
          for (const target of instances) if (target.id !== id && (to === '*' || target.id === to) && !target.closed)
            for (const fn of [...target.listeners]) fn(structuredClone(envelope));
        });
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { closed = true; listeners.clear(); }
    }; signals.set(id, value); instances.add(value); return value;
  };
  const peerFactory = ({ signaler, remoteId, initiator, signal }) => new Promise((resolve, reject) => {
    const peer = endpoint(); peer.localId = signaler.id; connections.push(peer); let complete = false, unsubscribe;
    const abort = () => { unsubscribe?.(); peer.close(); reject(Error('peer aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (pendingPeers) return;
    unsubscribe = signaler.subscribe(envelope => {
      peerSignals.push(envelope);
      const m = envelope.message;
      if (complete || peer.closed) return;
      if (!initiator && m.type === 'offer') {
        const waiting = offers.get(m.description.sdp); if (!waiting) return;
        peer.bind(waiting.peer); waiting.peer.bind(peer); complete = true;
        signaler.send(remoteId, { type: 'answer', description: m.description }).then(() => resolve(peer), reject);
      } else if (initiator && m.type === 'answer') { complete = true; resolve(peer); }
    });
    if (initiator) {
      const sdp = 'fixture-' + offerSerial++; offers.set(sdp, { peer });
      signaler.send(remoteId, { type: 'offer', description: { type: 'offer', sdp } }).catch(reject);
    }
  });
  return { signals, messages, connections, peerSignals, signalerFactory, peerFactory,
    options: { room: '3210', timeoutMs: 1500, peerTimeoutMs: 500, retryMs: 20, advertiseIntervalMs: 40, signalerFactory, peerFactory },
    get liveSignalers() { return [...instances].filter(s => !s.closed).length; }
  };
}
async function pair(f) {
  const a = await createNostrDynamicRoom({ ...f.options, role: 'host' });
  const b = await createNostrDynamicRoom({ ...f.options, role: 'join' });
  await settle();
  for (const room of [a, b]) room.setRoster({ epoch: 1, players: [a.localPlayerId, b.localPlayerId], coordinatorId: a.localPlayerId });
  return [a, b];
}

test('dynamic fixture: host starts alone, late joins build 1..5 full mesh without implicitly admitting RTC peers', async () => {
  const f = fixture(), rooms = [], events = [];
  try {
    const host = await createNostrDynamicRoom({ ...f.options, role: 'host' }); rooms.push(host);
    host.subscribe(event => events.push(event));
    assert.deepEqual(host.players, [host.localPlayerId]); assert.equal(host.epoch, 0);
    assert.equal(host.transports.size, 0); assert.equal(host.joining, false); assert.equal(f.connections.length, 0);
    for (let count = 2; count <= 5; count++) {
      const joined = await createNostrDynamicRoom({ ...f.options, role: 'join' }); rooms.push(joined);
      assert.equal(joined.joining, true); assert.equal(joined.role, 'join');
      assert.equal(host.players.length, count - 1); assert.equal(joined.players.length, count - 1);
      assert.equal(joined.sessionId, host.sessionId); assert.equal(joined.coordinatorId, host.localPlayerId);
      const players = rooms.map(r => r.localPlayerId);
      await Promise.all(rooms.map(r => r.connectMesh(players)));
      for (const r of rooms) r.setRoster({ epoch: count - 1, players, coordinatorId: host.localPlayerId });
      assert.ok(rooms.every(r => r.transports.size === count - 1 && !r.joining));
    }
    assert.equal(f.connections.length, 20); assert.equal(events.filter(e => e.type === 'peer-connected').length, 4);
    assert.equal(new Set(rooms.map(r => r.sessionId)).size, 1);
    const received = [];
    for (const r of rooms) for (const [from, transport] of r.transports) transport.subscribe(bytes => received.push([from, r.localPlayerId, bytes]));
    for (const [i, r] of rooms.entries()) for (const transport of r.transports.values()) assert.equal(transport.send(new Uint8Array(16384).fill(i)), true);
    await settle(); assert.equal(received.length, 20);
    for (const [from, to, bytes] of received) { assert.notEqual(from, to); assert.deepEqual(bytes, new Uint8Array(16384).fill(rooms.findIndex(r => r.localPlayerId === from))); }
    await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'join' }), /full/);
    assert.equal(f.connections.length, 20);
    const remaining = rooms.slice(0, 4).map(r => r.localPlayerId);
    for (const r of rooms) r.setRoster({ epoch: 5, players: remaining, coordinatorId: host.localPlayerId });
    assert.ok(rooms.every(r => r.transports.size === 4), 'roster publication leaves commit channels open');
    rooms[4].close(); await settle();
    assert.ok(rooms.slice(0, 4).every(r => !r.closed && r.transports.size === 3));
  } finally { rooms.forEach(r => r.close()); }
  await settle(); assert.equal(f.liveSignalers, 0); assert.ok(f.connections.every(p => p.closed));
});

test('dynamic fixture: coordinator invitation alone establishes newcomer links to admitted peers', async () => {
  const f = fixture(), rooms = await pair(f);
  try {
    const next = await createNostrDynamicRoom({ ...f.options, role: 'join' }); rooms.push(next);
    await rooms[0].connectMesh(rooms.map(r => r.localPlayerId));
    for (let i = 0; i < 20 && rooms.some(r => r.transports.size !== 2); i++) await sleep(10);
    assert.ok(rooms.every(r => r.transports.size === 2));
    assert.ok(rooms.every(r => r.players.length === 2), 'mesh invitation is not admission');
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic fixture: explicit reconnect retains identity and rejects previous-generation/session signaling', async () => {
  const f = fixture(), rooms = await pair(f), [a, b] = rooms;
  try {
    const firstOffer = f.messages.find(e => e.message.type === 'offer');
    const firstLink = f.messages.find(e => e.message.op === 'link');
    const identity = [a.localPlayerId, b.localPlayerId, a.sessionId];
    const oldTransport = a.transports.get(b.localPlayerId);
    oldTransport.close(); await settle(); assert.equal(a.transports.size, 0); assert.equal(b.transports.size, 0);
    const replacement = await a.reconnect(b.localPlayerId); await settle();
    assert.notEqual(replacement, oldTransport); assert.equal(b.transports.size, 1);
    assert.deepEqual([a.localPlayerId, b.localPlayerId, a.sessionId], identity);
    const delivered = f.peerSignals.length, count = f.connections.length;
    await f.signals.get(firstOffer.from).send(firstOffer.to, firstOffer.message);
    await f.signals.get(firstLink.from).send(firstLink.to, firstLink.message);
    await f.signals.get(firstOffer.from).send(firstOffer.to, { ...firstOffer.message, dynamicSession: 'wrong-session' });
    await settle(); assert.equal(f.peerSignals.length, delivered); assert.equal(f.connections.length, count);
    await Promise.all([a.reconnect(b.localPlayerId), b.reconnect(a.localPlayerId)]);
    await settle(); assert.equal(a.transports.size, 1); assert.equal(b.transports.size, 1);
    assert.ok(f.messages.filter(e => e.message.op === 'link').some(e => e.message.generation >= 3));
    assert.ok(rooms.every(r => r.metrics.pendingPeerCount === 0));
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic fixture: graceful explicit succession re-advertises the same room/session; no election on loss', async () => {
  const f = fixture(), rooms = await pair(f), [a, b] = rooms;
  try {
    const sessionId = a.sessionId, final = [];
    b.transports.get(a.localPlayerId).subscribe(bytes => final.push([...bytes]));
    for (const r of rooms) r.setRoster({ epoch: 2, players: [b.localPlayerId], coordinatorId: b.localPlayerId });
    assert.equal(a.transports.get(b.localPlayerId).send(new Uint8Array([9])), true);
    await settle(); assert.deepEqual(final, [[9]]);
    a.close(); await settle(); assert.equal(b.closed, false); assert.equal(b.transports.size, 0);
    const c = await createNostrDynamicRoom({ ...f.options, role: 'join' }); rooms.push(c);
    assert.equal(c.sessionId, sessionId); assert.equal(c.coordinatorId, b.localPlayerId);
    assert.deepEqual(c.players, [b.localPlayerId]); assert.equal(c.epoch, 2);
    for (const r of [b, c]) r.setRoster({ epoch: 3, players: [b.localPlayerId, c.localPlayerId], coordinatorId: b.localPlayerId });
    b.close(); await settle(); assert.equal(c.closed, false); assert.equal(c.coordinatorId, b.localPlayerId);
    assert.equal(c.transports.size, 0);
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic fixture: lost link announcement queues scoped offer until bounded retry', async () => {
  let lost = false;
  const f = fixture({ drop: e => { if (!lost && e.message.op === 'link') { lost = true; return true; } return false; } });
  const rooms = await pair(f);
  try { assert.equal(lost, true); assert.equal(f.connections.length, 2); assert.ok(rooms.every(r => r.metrics.signalBacklogBytes === 0)); }
  finally { rooms.forEach(r => r.close()); }
});

test('dynamic fixture: absent host, stalled peers and abort all have bounded cleanup', async () => {
  const missing = fixture();
  await assert.rejects(createNostrDynamicRoom({ ...missing.options, role: 'join', timeoutMs: 40 }), /timeout/);
  assert.equal(missing.liveSignalers, 0);
  const stalled = fixture({ pendingPeers: true });
  const host = await createNostrDynamicRoom({ ...stalled.options, role: 'host', peerTimeoutMs: 30 });
  try {
    await assert.rejects(createNostrDynamicRoom({ ...stalled.options, role: 'join', timeoutMs: 70, peerTimeoutMs: 30 }), /timeout/);
    await sleep(70); assert.equal(host.closed, false); assert.equal(host.metrics.pendingPeerCount, 0);
    assert.ok(stalled.connections.every(p => p.closed));
  } finally { host.close(); }
  assert.equal(stalled.liveSignalers, 0);
  for (const role of ['host', 'join']) {
    const f = fixture(), controller = new AbortController();
    await assert.rejects(createNostrDynamicRoom({ ...f.options, role, signal: controller.signal,
      onStatus: e => { if (e.type === 'room-ready') controller.abort(); } }), /aborted/);
    assert.equal(f.liveSignalers, 0);
  }
});

test('dynamic fixture: strangers cannot allocate peers and pre-start backlog is size bounded', async () => {
  let blockLinks = false;
  const f = fixture({ drop: e => blockLinks && e.message.op === 'link' }), [a, b] = await pair(f);
  const stranger = await f.signalerFactory();
  try {
    const valid = f.messages.find(e => e.message.op === 'request')?.message ?? f.messages.find(e => e.message.op === 'link').message;
    await stranger.send(a.localPlayerId, { ...valid, op: 'request', generation: 0 });
    await settle(); assert.equal(f.connections.length, 2);
    // p1 is the deterministic initiator; p0 accepts only bounded future scopes.
    blockLinks = true;
    for (let generation = 100; generation < 140; generation++) await f.signals.get(b.localPlayerId).send(a.localPlayerId, {
      ...f.messages.find(e => e.message.type === 'offer').message,
      type: 'offer', dynamicSession: a.sessionId, dynamicGeneration: generation,
      dynamicConnection: 'future-' + generation, description: { sdp: 'x'.repeat(100000) }
    });
    await settle(); assert.ok(a.metrics.signalBacklogBytes > 0); assert.ok(a.metrics.signalBacklogBytes <= 5 * 128 * 1024);
    assert.equal(f.connections.length, 2);
  } finally { a.close(); b.close(); stranger.close(); }
});

test('dynamic room validates options/rosters and does not reinterpret fixed-group configuration', async () => {
  for (const invalid of [{ role: 'watch' }, { role: 'host', maxPlayers: 6 }, { role: 'host', maxPendingPeers: 6 },
    { role: 'host', peerTimeoutMs: 0 }, { role: 'host', retryMs: 0 }, { role: 'host', namespace: 'x'.repeat(128) }, { role: 'join', room: 'bad' }]) {
    await assert.rejects(createNostrDynamicRoom(invalid));
  }
  const f = fixture(), [a, b] = await pair(f);
  try {
    assert.throws(() => a.setRoster({ epoch: 0, players: [a.localPlayerId], coordinatorId: a.localPlayerId }), /stale/);
    assert.throws(() => a.setRoster({ epoch: 1, players: [a.localPlayerId], coordinatorId: a.localPlayerId }), /conflicting/);
    assert.throws(() => a.setRoster({ epoch: 2, players: [a.localPlayerId], coordinatorId: b.localPlayerId }), /coordinator/);
    await assert.rejects(b.connectMesh([b.localPlayerId]), /coordinator/);
    await assert.rejects(a.reconnect('stranger'), /invited/);
    const old = a.players; a.setRoster({ epoch: 1, players: [...old].reverse(), coordinatorId: a.coordinatorId });
    assert.deepEqual(a.players, old); assert.ok(Object.isFrozen(a.players));
  } finally { a.close(); b.close(); }
  await assert.rejects(a.connectMesh(['p0']), /closed/);
});

test('dynamic fixture: owner disconnect releases links without editing membership; pending admission is bounded', async () => {
  const f = fixture(), [a, b] = await pair(f);
  try {
    const before = a.players;
    assert.equal(a.disconnect(b.localPlayerId), true); await settle();
    assert.equal(a.transports.size, 0); assert.equal(a.peerConnections.size, 0); assert.equal(b.transports.size, 0);
    assert.deepEqual(a.players, before); assert.equal(a.disconnect(b.localPlayerId), false);
    await a.reconnect(b.localPlayerId); await settle(); assert.equal(a.transports.size, 1);
  } finally { a.close(); b.close(); }
  const stalled = fixture({ pendingPeers: true });
  const host = await createNostrDynamicRoom({ ...stalled.options, role: 'host', maxPendingPeers: 1, peerTimeoutMs: 150 });
  const controller = new AbortController();
  const first = createNostrDynamicRoom({ ...stalled.options, role: 'join', signal: controller.signal });
  const firstEnd = assert.rejects(first, /aborted/);
  try {
    await sleep(10); assert.equal(host.metrics.pendingPeerCount, 1);
    await assert.rejects(createNostrDynamicRoom({ ...stalled.options, role: 'join' }), /full/);
    assert.equal(host.metrics.pendingPeerCount, 1);
  } finally { controller.abort(); host.close(); await firstEnd; }
  assert.equal(stalled.liveSignalers, 0);
});

test('dynamic signaler initialization itself obeys abort/deadline even for a stalled injected factory', async () => {
  await assert.rejects(createNostrDynamicRoom({ role: 'host', timeoutMs: 20,
    signalerFactory: () => new Promise(() => {}) }), /signaling timeout/);
  const controller = new AbortController();
  const promise = createNostrDynamicRoom({ role: 'host', signal: controller.signal,
    signalerFactory: () => new Promise(() => {}) });
  controller.abort(); await assert.rejects(promise, /aborted/);
  let closed = false;
  await assert.rejects(createNostrDynamicRoom({ role: 'host', timeoutMs: 10,
    signalerFactory: async () => { await sleep(30); return { id: 'late', send() {}, subscribe() {}, close() { closed = true; } }; } }), /timeout/);
  await sleep(30); assert.equal(closed, true, 'late resources are closed after setup timed out');
});

function memoryStorage(copy) {
  const data = new Map(copy?.data);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
async function resumablePair(f) {
  const stores = [memoryStorage(), memoryStorage()];
  const a = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: stores[0] }, resumeProbeMs: 30 });
  const b = await createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: stores[1] }, resumeProbeMs: 30 });
  await settle();
  for (const r of [a, b]) r.setRoster({ epoch: 1, players: [a.localPlayerId, b.localPlayerId], coordinatorId: a.localPlayerId });
  return { rooms: [a, b], stores };
}

test('dynamic resume fixture: refreshed participant keeps signed identity and reconnects same live roster', async () => {
  const f = fixture(), { rooms, stores } = await resumablePair(f), [a, old] = rooms;
  try {
    const id = old.localPlayerId, session = old.sessionId; old.close(); await settle();
    const resumed = await createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: stores[1] }, resumeProbeMs: 30 }); rooms.push(resumed);
    await settle(); assert.equal(resumed.resumed, true); assert.equal(resumed.localPlayerId, id); assert.equal(resumed.sessionId, session);
    assert.equal(resumed.coordinatorId, a.localPlayerId); assert.equal(resumed.resumePeerId, a.localPlayerId);
    assert.equal(resumed.joining, false); assert.equal(resumed.epoch, 1); assert.equal(a.transports.size, 1);
    for (const r of [a, resumed]) r.setRoster({ epoch: 2, players: [a.localPlayerId, id], coordinatorId: a.localPlayerId });
    const newcomer = await createNostrDynamicRoom({ ...f.options, role: 'join' }); rooms.push(newcomer);
    await Promise.all([a, resumed, newcomer].map(r => r.connectMesh([a.localPlayerId, id, newcomer.localPlayerId])));
    assert.ok([a, resumed, newcomer].every(r => r.transports.size === 2));
    resumed.forgetResume(); assert.equal(stores[1].data.size, 0);
  } finally { rooms.forEach(r => r.close()); }
  assert.equal(f.liveSignalers, 0);
});

test('dynamic resume fixture: refreshed coordinator uses surviving member with no election or replacement world', async () => {
  const f = fixture(), { rooms, stores } = await resumablePair(f), [old, b] = rooms;
  try {
    const id = old.localPlayerId, session = old.sessionId; old.close(); await settle();
    const resumed = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: stores[0] }, resumeProbeMs: 30 }); rooms.push(resumed);
    await settle(); assert.equal(resumed.resumed, true); assert.equal(resumed.localPlayerId, id); assert.equal(resumed.coordinatorId, id);
    assert.equal(resumed.sessionId, session); assert.equal(resumed.resumePeerId, b.localPlayerId); assert.equal(resumed.epoch, 1);
    assert.equal(b.coordinatorId, id); assert.equal(b.transports.size, 1);
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic resume fixture: duplicate healthy tab is rejected without evicting old RTC or exposing liveness packets', async () => {
  const f = fixture(), { rooms, stores } = await resumablePair(f), [a, b] = rooms;
  try {
    const messages = []; b.transports.get(a.localPlayerId).subscribe(bytes => messages.push(bytes));
    const before = a.transports.get(b.localPlayerId), peers = f.connections.length;
    await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: memoryStorage(stores[1]) }, resumeProbeMs: 30 }), /duplicate live/);
    await settle(); assert.equal(a.transports.get(b.localPlayerId), before); assert.equal(f.connections.length, peers);
    assert.equal(messages.length, 0); assert.equal(a.closed, false); assert.equal(b.closed, false);
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic resume fixture: sole refreshed member times out rather than silently starting another session', async () => {
  const f = fixture(), store = memoryStorage();
  const host = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store } });
  const id = host.localPlayerId; host.close();
  await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store }, timeoutMs: 50 }), /timeout/);
  const fresh = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store, reset: true } });
  assert.notEqual(fresh.localPlayerId, id); assert.equal(fresh.resumed, false); fresh.close();
});

test('dynamic resume fixture: expired, invalid and wrong-scope records fail explicitly until reset', async () => {
  const f = fixture(), store = memoryStorage();
  const first = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store } });
  first.close();
  await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'host', expectedSessionId: 'different-session', resume: { storage: store } }), /does not match expectedSessionId/);
  const [key, raw] = [...store.data][0], expired = JSON.parse(raw);
  expired.expiresAt = Date.now() - 1; store.setItem(key, JSON.stringify(expired));
  for (let i = 0; i < 2; i++) await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store } }), /expired/);
  assert.equal(store.data.size, 1, 'failed resume cannot silently become a fresh identity on retry');
  store.setItem(key, '{malformed');
  await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store } }), /invalid resume/);
  store.setItem(key, raw);
  await assert.rejects(createNostrDynamicRoom({ ...f.options, namespace: 'different-game', role: 'host', resume: { storage: store, key } }), /invalid resume/);
  const fresh = await createNostrDynamicRoom({ ...f.options, role: 'host', resume: { storage: store, reset: true } });
  fresh.close();
});

test('resume identity signs actual Nostr events under the same public key after storage reload', async () => {
  const { createRoomResumeIdentity } = await import('../room-resume-identity.js');
  const { createNostrSignaler, nostrCrypto } = await import('../index.js');
  const events = [];
  class Relay extends EventTarget {
    constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) {
      const [type, ...args] = JSON.parse(text);
      if (type === 'REQ') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', args[0]]) })));
      if (type === 'EVENT') { events.push(args[0]); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['OK', args[0].id, true, '']) }))); }
    }
    close() { this.readyState = 3; }
  }
  const storage = memoryStorage(), ids = [];
  for (let i = 0; i < 2; i++) {
    const holder = createRoomResumeIdentity({ storage }, { namespace: 'signed-resume', room: '3210' });
    const signaler = await createNostrSignaler({ room: '3210', namespace: 'signed-resume', identity: holder.identity,
      relays: ['wss://fixture.invalid'], WebSocketImpl: Relay, publishIntervalMs: 0, timeoutMs: 100 });
    ids.push(signaler.id); await signaler.send('*', { type: 'discover' }); signaler.close();
  }
  assert.equal(ids[0], ids[1]); assert.equal(events.length, 2);
  const fromHex = value => new Uint8Array(value.match(/../g).map(byte => parseInt(byte, 16)));
  for (const event of events) {
    assert.equal(event.pubkey, ids[0]);
    assert.equal(await nostrCrypto.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey)), true);
  }
});

test('integrated dynamic transport + real RoomSession: late join, same-key refresh and coordinator succession converge', async () => {
  const { createRoomSession } = await import('../../rollback/room-session.js');
  const { createValueCodec } = await import('../../deterministic/value-codec.js');
  const { profiles } = await import('../../_rollback-shared/protocol.js');
  const f = fixture(), rooms = [], sessions = [], actors = [], stores = [];
  let now = 0, target = Infinity;
  function actor() {
    const codec = createValueCodec(); let state = { tick: 0, epoch: -1, players: [], value: 0, commands: [], padding: new Uint8Array(32768) };
    return { state: () => state, adapter: {
      save: () => codec.encode(state), load: bytes => { state = codec.decode(bytes); },
      validateSnapshot: (bytes, { tick }) => { try { return codec.decode(bytes).tick === tick; } catch { return false; } },
      applyMembership({ tick, epoch, players }) { assert.equal(state.tick, tick); assert.equal(state.epoch + 1, epoch); state.epoch = epoch; state.players = [...players]; },
      step({ tick, membershipEpoch, inputs }) {
        assert.equal(tick, state.tick); assert.equal(membershipEpoch, state.epoch); assert.deepEqual(inputs.map(i => i.playerId), state.players);
        for (const input of inputs) { state.value += input.input[0]; for (const command of input.commands) state.commands.push(input.playerId + ':' + command.sequence + ':' + command.payload[0]); }
        state.tick++;
      }
    } };
  }
  async function add(role, slot = stores.length) {
    stores[slot] ??= memoryStorage();
    const room = await createNostrDynamicRoom({ ...f.options, role, resume: { storage: stores[slot] }, resumeProbeMs: 30 }); rooms.push(room);
    const a = actor(); actors.push(a);
    const session = createRoomSession({ mode: 'online', room, adapter: a.adapter, inputSize: 1,
      simulationVersion: 'integrated-dynamic-fixture', clock: () => now,
      profile: { ...profiles.lockstep, pacingPolicy: 'none', baseInputDelayTicks: 2, checksumInterval: 20, stateHistorySize: 96 },
      membership: { transitionTimeoutMs: 15000, reconnectGraceMs: 10000, maxCatchupSteps: 2 } });
    sessions.push(session); return session;
  }
  async function until(predicate, label) {
    for (let step = 0; step < 3000; step++) {
      if (predicate()) return;
      now += 4;
      for (const s of sessions) if (!s.closed) {
        s.poll(); if (s.tick < target && !s.resimulating) s.advance(new Uint8Array([1]));
        assert.ok(!s.failure, label + ' failure: ' + JSON.stringify({ failure: s.failure, peers: sessions.map(x => ({ id: x.localPlayerId, tick: x.tick, status: x.status, links: x.room.transports.size, failure: x.failure, prepared: x._transition?.prepared.size })) }));
      }
      await settle(); if (step % 20 === 0) await sleep(0);
    }
    assert.fail(label + ': ' + JSON.stringify(sessions.map(s => ({ tick: s.tick, epoch: s.epoch, status: s.status }))));
  }
  async function checkpoint(label) {
    const active = sessions.filter(s => !s.closed); target = Math.max(...active.map(s => s.tick));
    await until(() => active.every(s => s.tick === target && s.ready), label);
    assert.equal(new Set(active.map(s => s.getStateHash())).size, 1, label + ' state hashes'); target = Infinity;
  }
  try {
    let host = await add('host'); await until(() => host.tick >= 60, 'host alone');
    for (let count = 2; count <= 5; count++) {
      host.queueCommand(new Uint8Array([count])); const joined = await add('join');
      await until(() => joined.ready && sessions.filter(s => !s.closed).every(s => s.players.length === count && !s._transition), 'join ' + count);
      await until(() => sessions.every(s => s.tick >= host.baseTick + 20), 'advance ' + count);
      await checkpoint('players ' + count);
    }
    assert.ok(actors.every(a => a.state().commands.length === 4));
    await rooms[0].reconnect(rooms[2].localPlayerId); await until(() => sessions.every(s => s.ready), 'retained reconnect'); await checkpoint('retained reconnect');
    const oldGuest = sessions[2], guestId = oldGuest.localPlayerId; oldGuest.close();
    const resumedGuest = await add('join', 2); assert.equal(resumedGuest.localPlayerId, guestId);
    await until(() => resumedGuest.ready && !host._transition && sessions.filter(s => !s.closed).every(s => s.ready), 'guest refresh'); await checkpoint('guest refresh');
    const oldHostId = host.localPlayerId; host.close(); host = await add('host', 0); assert.equal(host.localPlayerId, oldHostId);
    await until(() => sessions.filter(s => !s.closed).every(s => s.ready), 'coordinator refresh'); await checkpoint('coordinator refresh');
    const left = host.leave(); left.catch(() => {}); await until(() => host.closed && sessions.filter(s => !s.closed).every(s => s.players.length === 4 && s.ready), 'coordinator leave'); await left;
    await checkpoint('coordinator succession');
  } finally { sessions.forEach(s => s.close()); rooms.forEach(r => r.close()); }
  await settle(); assert.equal(f.liveSignalers, 0);
});

test('dynamic resume fixture: stale-open RTC is replaced only after probe timeout; wrong incarnation cannot trigger replacement', async () => {
  const f = fixture(), { rooms, stores } = await resumablePair(f), [a, b] = rooms;
  try {
    const before = a.transports.get(b.localPlayerId), join = f.messages.find(e => e.from === b.localPlayerId && e.message.op === 'join');
    await f.signals.get(b.localPlayerId).send(a.localPlayerId, { ...join.message, op: 'resume-request',
      resumeSession: a.sessionId, incarnation: 'unrelated-incarnation', targetIncarnation: 'wrong-target' });
    await settle(); assert.equal(a.transports.get(b.localPlayerId), before); assert.equal(f.connections.length, 2);
    const stale = f.connections.find(p => p.localId === b.localPlayerId); stale.blackhole = true;
    const start = performance.now();
    const resumed = await createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: memoryStorage(stores[1]) }, resumeProbeMs: 30 }); rooms.push(resumed);
    await settle(); assert.ok(performance.now() - start >= 20); assert.equal(resumed.localPlayerId, b.localPlayerId);
    assert.notEqual(a.transports.get(b.localPlayerId), before); assert.equal(stale.closed, true);
    assert.equal(b.transports.size, 0); assert.equal(resumed.transports.size, 1);
  } finally { rooms.forEach(r => r.close()); }
});

test('dynamic directory hooks: exact-session selection and synchronous reservation gate precede host peer allocation', async () => {
  const f = fixture(), allowed = new Set(); let calls = 0;
  const host = await createNostrDynamicRoom({ ...f.options, role: 'host', authorizeJoin(id, context) {
    calls++; assert.equal(context.sessionId, host.sessionId); assert.equal(context.room, host.room); return allowed.has(id);
  } });
  const rooms = [host];
  try {
    await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'join', expectedSessionId: 'different-session', timeoutMs: 50 }), /timeout/);
    assert.equal(calls, 0); assert.equal(f.connections.length, 0);
    await assert.rejects(createNostrDynamicRoom({ ...f.options, role: 'join', expectedSessionId: host.sessionId }), /reservation/);
    assert.equal(host.transports.size, 0); assert.equal(calls, 1);
    allowed.add('p3');
    const joined = await createNostrDynamicRoom({ ...f.options, role: 'join', expectedSessionId: host.sessionId }); rooms.push(joined);
    await settle(); assert.equal(host.transports.size, 1); assert.equal(joined.sessionId, host.sessionId);
  } finally { rooms.forEach(r => r.close()); }
});

test('queued dynamic candidate adopts newer welcome roster and accepts retried mesh without losing resume identity', async () => {
  const f = fixture(), rooms = [], stores = [memoryStorage(), memoryStorage(), memoryStorage()];
  try {
    for (let i = 0; i < 3; i++) rooms.push(await createNostrDynamicRoom({ ...f.options, role: i ? 'join' : 'host', resume: { storage: stores[i] } }));
    await settle(); const [a, b, pending] = rooms;
    assert.equal(pending.epoch, 0); assert.equal(pending.joining, true);
    const firstRoster = { epoch: 1, players: [a.localPlayerId, b.localPlayerId], coordinatorId: a.localPlayerId };
    a.setRoster(firstRoster); b.setRoster(firstRoster);
    // The next coordinator invitation arrives before the queued candidate's RTC welcome.
    await a.connectMesh(rooms.map(r => r.localPlayerId)); await sleep(30);
    assert.equal(pending.epoch, 0); assert.equal(pending.transports.size, 1);
    pending.setRoster(firstRoster);
    assert.equal(pending.joining, true); assert.equal(stores[2].data.size, 1, 'pending welcome is not a committed leave');
    for (let i = 0; i < 30 && rooms.some(r => r.transports.size !== 2); i++) await sleep(10);
    assert.ok(rooms.every(r => r.transports.size === 2), 'coordinator mesh retry follows the adopted committed epoch');
    for (const r of rooms) r.setRoster({ epoch: 2, players: rooms.map(item => item.localPlayerId), coordinatorId: a.localPlayerId });
    const record = JSON.parse([...stores[2].data.values()][0]); assert.equal(record.epoch, 2); assert.ok(record.players.includes(pending.localPlayerId));
    const id = pending.localPlayerId; pending.close(); await settle();
    const restored = await createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: stores[2] } }); rooms.push(restored);
    assert.equal(restored.localPlayerId, id); assert.equal(restored.resumed, true); assert.equal(restored.epoch, 2);
  } finally { rooms.forEach(room => room.close()); }
});

test('dynamic resume: approval replaces pending mesh links without rejecting their admission waiters', async () => {
  let hold = false, coordinator, held = [];
  const f = fixture({ drop(envelope) {
    if (hold && envelope.message.op === 'resume-request' && envelope.to !== coordinator) { held.push(envelope); return true; }
    return false;
  } });
  const rooms = [], stores = Array.from({ length: 3 }, () => memoryStorage());
  try {
    for (let slot = 0; slot < 3; slot++) {
      rooms.push(await createNostrDynamicRoom({ ...f.options, role: slot ? 'join' : 'host', resume: { storage: stores[slot] } }));
      coordinator = rooms[0].localPlayerId;
      const players = rooms.map(room => room.localPlayerId);
      await Promise.all(rooms.map(room => room.connectMesh(players)));
      for (const room of rooms) room.setRoster({ epoch: slot, players, coordinatorId: coordinator });
    }
    const players = rooms.map(room => room.localPlayerId), session = rooms[0].sessionId;
    for (const slot of [1, 2]) {
      rooms[slot].close(); hold = true; held = [];
      rooms[slot] = await createNostrDynamicRoom({ ...f.options, role: 'join', resume: { storage: stores[slot] } });
      assert.equal(rooms[slot].localPlayerId, players[slot]);
      assert.equal(rooms[slot].sessionId, session);
      // Production publications are serialized and rate limited. Resume control
      // can reach a survivor after RoomSession has already begun connectMesh.
      const mesh = Promise.all(rooms.map(room => room.connectMesh(players)));
      mesh.catch(() => {});
      await settle(); assert.ok(held.length, 'Hold a non-coordinator resume approval behind the pending mesh');
      hold = false;
      for (const envelope of held) await f.signals.get(envelope.from).send(envelope.to, envelope.message);
      await mesh; await settle();
      assert.ok(rooms.every(room => room.transports.size === 2));
      const received = [];
      for (const room of rooms) for (const transport of room.transports.values()) transport.subscribe(bytes => received.push(bytes[0]));
      for (const room of rooms) for (const transport of room.transports.values()) assert.equal(transport.send(new Uint8Array([7])), true);
      await settle(); assert.equal(received.length, 6, 'Every resumed mesh edge still carries data');
    }
  } finally { rooms.forEach(room => room.close()); }
});
