import test from 'node:test';
import assert from 'node:assert/strict';
import { createNostrPublicRoom } from '../public-room.js';
import { createNostrDynamicRoom } from '../dynamic-room.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
// Deterministic in-memory signaling and RTC capability fixture, not real internet.
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
  const signalerFactory = async ({ identity, room = '0000', namespace = '', signal } = {}) => {
    if (signal?.aborted) throw Error('signaler aborted');
    const id = identity?.id ?? 'p' + serial++, listeners = new Set(); let closed = false;
    const value = { id, room, namespace, listeners, get closed() { return closed; },
      async send(to, message) {
        if (closed) throw Error('signaler closed');
        const envelope = { from: id, to, message: structuredClone(message) }; messages.push(envelope);
        if (drop(envelope)) return;
        queueMicrotask(() => {
          for (const target of instances) if (target.id !== id && target.room === room && target.namespace === namespace && (to === '*' || target.id === to) && !target.closed)
            for (const fn of [...target.listeners]) fn(structuredClone(envelope));
        });
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { closed = true; listeners.clear(); }
    }; signal?.addEventListener('abort', () => value.close(), { once: true }); signals.set(id, value); instances.add(value); return value;
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
  return { instances, signals, messages, connections, peerSignals, signalerFactory, peerFactory,
    options: { room: '3210', timeoutMs: 1500, peerTimeoutMs: 500, retryMs: 20, advertiseIntervalMs: 40, signalerFactory, peerFactory },
    get liveSignalers() { return [...instances].filter(s => !s.closed).length; }
  };
}
function options(f, extra = {}) {
  return { namespace: 'public-fixture', simulationVersion: 'sim-v1', discoveryMs: 15, totalTimeoutMs: 1500,
    leaseMs: 300, reservationMs: 600, retryMs: 15, peerTimeoutMs: 500, advertiseIntervalMs: 30,
    signalerFactory: f.signalerFactory, peerFactory: f.peerFactory, ...extra };
}
function commit(rooms, epoch) {
  const players = rooms.map(room => room.localPlayerId);
  for (const room of rooms) room.setRoster({ epoch, players, coordinatorId: rooms[0].localPlayerId });
}

test('public fixture: healthy empty directory starts alone, later Start joins exact room and admission stays explicit', async () => {
  const f = fixture(), rooms = [];
  try {
    const host = await createNostrPublicRoom(options(f)); rooms.push(host);
    assert.equal(host.role, 'host'); assert.equal(host.players.length, 1);
    for (let n = 2; n <= 5; n++) {
      const joined = await createNostrPublicRoom(options(f)); rooms.push(joined);
      assert.equal(joined.role, 'join'); assert.equal(joined.sessionId, host.sessionId);
      assert.equal(joined.room, host.room); assert.equal(joined.joining, true);
      assert.equal(host.players.length, n - 1); assert.equal(host.publicMetrics.pendingReservations, 1);
      await Promise.all(rooms.map(room => room.connectMesh(rooms.map(r => r.localPlayerId))));
      commit(rooms, n - 1); await settle();
      assert.equal(host.publicMetrics.pendingReservations, 0);
    }
    assert.equal(host.players.length, 5);
    assert.ok(f.messages.some(e => e.message.op === 'reserve' && e.from === rooms[1].localPlayerId));
    assert.ok(f.messages.some(e => e.message.op === 'lease' && e.message.committed === 5));
    assert.ok([...f.instances].some(s => s.room === '0000' && s.namespace === 'public-fixture:public-v1'));
  } finally { rooms.forEach(room => room.close()); }
  await settle(); assert.equal(f.liveSignalers, 0); assert.ok(f.connections.every(peer => peer.closed));
});

test('public fixture: no relay and silently failed directory never create a replacement world', async () => {
  let created = 0;
  await assert.rejects(createNostrPublicRoom({ ...options(fixture()), signalerFactory: async () => { throw Error('relay offline'); },
    dynamicRoomFactory: async () => { created++; } }), error => error.code === 'PUBLIC_RELAY_UNAVAILABLE');
  const f = fixture(); let sends = 0;
  await assert.rejects(createNostrPublicRoom({ ...options(f), signalerFactory: async args => {
    const value = await f.signalerFactory(args), send = value.send;
    value.send = (...params) => ++sends === 1 ? send(...params) : Promise.reject(Error('No live Nostr relays'));
    return value;
  }, dynamicRoomFactory: async () => { created++; } }), error => error.code === 'PUBLIC_RELAY_UNAVAILABLE');
  assert.equal(created, 0); assert.equal(f.liveSignalers, 0);
});

test('public fixture: identity-bound idempotent reservations count pending seats and release failed arrivals', async () => {
  const f = fixture(), host = await createNostrPublicRoom(options(f, { maxPlayers: 2, reservationMs: 100 }));
  let stranger;
  try {
    stranger = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' });
    const lease = f.messages.find(e => e.message.op === 'lease').message;
    const request = { ...lease, op: 'reserve', requestId: 'request1', expiresAt: Date.now() + 100 };
    await stranger.send(host.localPlayerId, request); await stranger.send(host.localPlayerId, request); await settle();
    assert.equal(host.publicMetrics.pendingReservations, 1);
    const outsider = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' });
    await outsider.send(host.localPlayerId, { ...request, requestId: 'request2' }); await settle();
    assert.equal(host.publicMetrics.pendingReservations, 1);
    assert.ok(f.messages.some(e => e.to === outsider.id && e.message.op === 'deny'));
    // Knowing the public request nonce is insufficient without its sender identity.
    await outsider.send(host.localPlayerId, { ...request, op: 'release' }); await settle();
    assert.equal(host.publicMetrics.pendingReservations, 1);
    await stranger.send(host.localPlayerId, { ...request, op: 'release' }); await settle();
    assert.equal(host.publicMetrics.pendingReservations, 0);
    await stranger.send(host.localPlayerId, { ...request, expiresAt: Date.now() + 100 }); await settle();
    await sleep(230); assert.equal(host.publicMetrics.pendingReservations, 0);
    outsider.close();
  } finally { stranger?.close(); host.close(); }
  assert.equal(f.liveSignalers, 0);
});

test('public fixture: new coordinator advertises same session after committed succession', async () => {
  const f = fixture(), rooms = [];
  try {
    const a = await createNostrPublicRoom(options(f)), b = await createNostrPublicRoom(options(f)); rooms.push(a, b);
    commit(rooms, 1);
    const sessionId = a.sessionId;
    for (const room of rooms) room.setRoster({ epoch: 2, players: [b.localPlayerId], coordinatorId: b.localPlayerId });
    a.close(); await settle();
    const c = await createNostrPublicRoom(options(f)); rooms.push(c);
    assert.equal(c.sessionId, sessionId); assert.equal(c.coordinatorId, b.localPlayerId); assert.equal(c.room, b.room);
  } finally { rooms.forEach(r => r.close()); }
});

test('public fixture: incompatible simulation versions are isolated and bounded setup/abort cleans late factories', async () => {
  const f = fixture(), rooms = [];
  try {
    rooms.push(await createNostrPublicRoom(options(f)));
    rooms.push(await createNostrPublicRoom(options(f, { simulationVersion: 'sim-v2' })));
    assert.notEqual(rooms[0].sessionId, rooms[1].sessionId); assert.equal(rooms[1].role, 'host');
  } finally { rooms.forEach(room => room.close()); }
  const stalled = fixture();
  await assert.rejects(createNostrPublicRoom(options(stalled, { totalTimeoutMs: 60, dynamicRoomFactory: () => new Promise(() => {}) })), /timeout/);
  assert.equal(stalled.liveSignalers, 0);
  const aborted = fixture(), controller = new AbortController();
  const pending = createNostrPublicRoom(options(aborted, { discoveryMs: 100, signal: controller.signal }));
  setTimeout(() => controller.abort(), 10); await assert.rejects(pending, /aborted/); assert.equal(aborted.liveSignalers, 0);
});

test('public fixture: simultaneous Start reserves at most four seats and rejects unreserved dynamic joins', async () => {
  const f = fixture(), rooms = [];
  try {
    const host = await createNostrPublicRoom(options(f)); rooms.push(host);
    const newcomers = await Promise.all(Array.from({ length: 4 }, () => createNostrPublicRoom(options(f)))); rooms.push(...newcomers);
    assert.ok(newcomers.every(room => room.sessionId === host.sessionId));
    assert.equal(host.players.length, 1); assert.equal(host.publicMetrics.pendingReservations, 4);
    await assert.rejects(createNostrDynamicRoom({ ...options(f), role: 'join', room: host.room, namespace: 'public-fixture', timeoutMs: 300,
      expectedSessionId: host.sessionId }), /reservation|rejected|full/);
    assert.equal(host.publicMetrics.pendingReservations, 4);
    // Serial admission must preserve reservations of remaining identity-bound seats.
    for (let count = 2; count <= 5; count++) {
      const admitted = rooms.slice(0, count), players = admitted.map(room => room.localPlayerId);
      if (count > 2) admitted.at(-1).setRoster({ epoch: count - 2, players: players.slice(0, -1), coordinatorId: host.localPlayerId });
      await Promise.all(admitted.map(room => room.connectMesh(players)));
      for (const room of admitted) room.setRoster({ epoch: count - 1, players, coordinatorId: host.localPlayerId });
      assert.equal(host.publicMetrics.pendingReservations, 5 - count);
    }
    assert.equal(host.players.length, 5);
  } finally { rooms.forEach(room => room.close()); }
  assert.equal(f.liveSignalers, 0);
});

test('public fixture: bounded signed leases reject stale epochs, duplicate sequences, expiry and wrong versions', async () => {
  const f = fixture(), host = await createNostrPublicRoom(options(f)), peers = [];
  try {
    const advertiser = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' }); peers.push(advertiser);
    const base = f.messages.find(e => e.message.op === 'lease').message;
    const lease = { ...base, room: '9000', sessionId: 'session01', coordinatorId: advertiser.id, players: [advertiser.id],
      sequence: 2, epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 200, committed: 1, pending: 0 };
    await advertiser.send('*', { ...lease, simulationVersion: 'wrong' });
    await advertiser.send('*', { ...lease, expiresAt: Date.now() - 1 }); await settle(); assert.equal(host.publicMetrics.directoryEntries, 0);
    await advertiser.send('*', lease); await settle(); assert.equal(host.publicMetrics.directoryEntries, 1);
    for (let i = 0; i < 100; i++) await advertiser.send('*', { ...lease, sessionId: 'session' + i });
    await settle(); assert.equal(host.publicMetrics.directoryEntries, 64);
    const successor = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' }); peers.push(successor);
    await successor.send('*', { ...lease, coordinatorId: successor.id, players: [successor.id], epoch: 2 }); await settle();
    assert.equal(host.publicMetrics.directoryEntries, 64);
    await sleep(310); assert.equal(host.publicMetrics.directoryEntries, 1, 'expired ordinary leases clear while bounded handover quarantine remains');
  } finally { peers.forEach(peer => peer.close()); host.close(); }
});

test('public fixture: room-scoped resume pointer restores same identity and world or fails closed', async () => {
  const f = fixture(), rooms = [], records = new Map();
  const storage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
  try {
    const host = await createNostrPublicRoom(options(f)), guest = await createNostrPublicRoom(options(f, { resume: { storage }, resumeProbeMs: 20 })); rooms.push(host, guest);
    commit(rooms, 1); const id = guest.localPlayerId, sessionId = guest.sessionId;
    guest.close(); await settle();
    const restored = await createNostrPublicRoom(options(f, { resume: { storage }, resumeProbeMs: 20 })); rooms.push(restored);
    assert.equal(restored.localPlayerId, id); assert.equal(restored.sessionId, sessionId); assert.equal(restored.resumed, true);
    assert.equal(records.size, 2); // one non-secret pointer and one room-scoped signer record
    assert.ok([...records.keys()].some(key => key.endsWith(':pointer')));
    const pointerRecord = JSON.parse([...records].find(([key]) => key.endsWith(':pointer'))[1]);
    const identityRecord = JSON.parse([...records].find(([key]) => !key.endsWith(':pointer'))[1]);
    assert.ok(pointerRecord.expiresAt <= identityRecord.expiresAt, 'public pointer must not outlive its signer record');
    restored.close(); host.close(); await settle();
    await assert.rejects(createNostrPublicRoom(options(f, { resume: { storage }, totalTimeoutMs: 80, resumeProbeMs: 20 })), /timeout/);
    assert.equal(records.size, 2, 'failed resume must not silently erase or replace the identity');
    assert.equal(f.liveSignalers, 0);
  } finally { rooms.forEach(room => room.close()); }
});

test('public fixture: failed candidate retries another known room within a bounded attempt budget', async () => {
  let hiddenHost, hide = false;
  const f = fixture({ drop: e => hide && e.from === hiddenHost && e.message.op === 'lease' }), rooms = [], attempted = [];
  try {
    const a = await createNostrPublicRoom(options(f)); rooms.push(a); hiddenHost = a.localPlayerId; hide = true;
    const b = await createNostrPublicRoom(options(f)); rooms.push(b); hide = false;
    assert.equal(b.role, 'host'); assert.notEqual(a.sessionId, b.sessionId);
    const c = await createNostrPublicRoom(options(f, { dynamicRoomFactory: async args => {
      attempted.push(args.expectedSessionId);
      if (attempted.length === 1) throw Error('fixture first peer unreachable');
      return createNostrDynamicRoom(args);
    } })); rooms.push(c);
    assert.equal(attempted.length, 2); assert.notEqual(attempted[0], attempted[1]);
    assert.equal(c.role, 'join'); assert.equal(c.sessionId, attempted[1]);
    let attempts = 0;
    await assert.rejects(createNostrPublicRoom(options(f, { maxAttempts: 1,
      dynamicRoomFactory: async () => { attempts++; throw Error('fixture unreachable'); } })), /fixture unreachable/);
    assert.equal(attempts, 1);
  } finally { rooms.forEach(room => room.close()); }
  assert.equal(f.liveSignalers, 0);
});

test('public fixture: forgetting resume stays forgotten across later roster updates', async () => {
  const f = fixture(), records = new Map();
  const storage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
  const host = await createNostrPublicRoom(options(f, { resume: { storage } }));
  try {
    assert.equal(records.size, 2); host.forgetResume(); assert.equal(records.size, 0);
    host.setRoster({ epoch: 1, players: [host.localPlayerId], coordinatorId: host.localPlayerId });
    assert.equal(records.size, 0);
  } finally { host.close(); }
});

test('public fixture: staggered Start retries the same room when admission advances during directory setup', async () => {
  const f = fixture(), rooms = [], records = new Map(), events = [];
  const storage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
  try {
    const host = await createNostrPublicRoom(options(f)), first = await createNostrPublicRoom(options(f)); rooms.push(host, first);
    assert.equal(host.epoch, 0); assert.equal(host.publicMetrics.pendingReservations, 1);
    let openedDirectories = 0;
    const next = await createNostrPublicRoom(options(f, { resume: { storage }, onStatus: event => events.push(event),
      signalerFactory: async args => {
        if (args.namespace.endsWith(':public-v1') && ++openedDirectories === 2) {
          // The previous lease was epoch 0. Another arrival commits before this
          // room-scoped signer subscribes and submits its reservation.
          commit(rooms, 1); await sleep(10);
        }
        return f.signalerFactory(args);
      }
    })); rooms.push(next);
    assert.equal(next.sessionId, host.sessionId); assert.equal(next.room, host.room); assert.equal(next.epoch, 1);
    assert.equal(next.role, 'join'); assert.equal(host.publicMetrics.pendingReservations, 1);
    assert.equal(events.filter(event => event.type === 'public-attempt-failed').length, 1);
    const requests = f.messages.filter(e => e.message.op === 'reserve' && e.from === next.localPlayerId);
    assert.deepEqual(requests.map(e => e.message.epoch), [0, 1]);
    assert.ok(f.messages.some(e => e.message.op === 'deny' && e.message.reason === 'stale-epoch' && e.message.epoch === 0));
  } finally { rooms.forEach(room => room.close()); }
  assert.equal(f.liveSignalers, 0);
});

test('public fixture: original identity can release its pending reservation after a different admission advances epoch', async () => {
  const f = fixture(), host = await createNostrPublicRoom(options(f)); let requester;
  try {
    requester = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' });
    const lease = f.messages.find(e => e.message.op === 'lease').message;
    const request = { ...lease, op: 'reserve', requestId: 'release-after-epoch', expiresAt: Date.now() + 500 };
    await requester.send(host.localPlayerId, request); await settle(); assert.equal(host.publicMetrics.pendingReservations, 1);
    host.setRoster({ epoch: 1, players: [host.localPlayerId], coordinatorId: host.localPlayerId });
    assert.equal(host.publicMetrics.pendingReservations, 1);
    await requester.send(host.localPlayerId, { ...request, op: 'release' }); await settle();
    assert.equal(host.publicMetrics.pendingReservations, 0);
  } finally { requester?.close(); host.close(); }
});

test('public fixture: missed membership lease quarantines departed coordinator until a fresh post-expiry successor lease', async () => {
  const f = fixture(), seed = await createNostrPublicRoom(options(f));
  const template = f.messages.find(e => e.message.op === 'lease').message; seed.close();
  const previous = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' });
  const successor = await f.signalerFactory({ room: '0000', namespace: 'public-fixture:public-v1' });
  successor.subscribe(({ from, message }) => {
    if (message.op === 'reserve') successor.send(from, { ...message, op: 'grant', expiresAt: Date.now() + 500 });
  });
  let startedRooms = 0;
  async function lookup(fresh) {
    const now = Date.now(), lease = { ...template, room: '9090', sessionId: 'missed-membership', coordinatorId: previous.id,
      players: [previous.id], epoch: 0, sequence: 1, committed: 1, pending: 0, issuedAt: now, expiresAt: now + 100 };
    const handover = { ...lease, coordinatorId: successor.id, players: [successor.id], epoch: 2, expiresAt: now + 500 };
    let refreshTimer;
    try {
      await createNostrPublicRoom(options(f, { discoveryMs: fresh ? 180 : 15, maxAttempts: 1,
        signalerFactory: async args => {
          const value = await f.signalerFactory(args);
          if (args.namespace.endsWith(':public-v1')) {
            const send = value.send; let sent = false;
            value.send = async (to, message) => {
              await send(to, message);
              if (message.op === 'discover' && !sent) {
                sent = true;
                await previous.send('*', lease); await successor.send('*', handover);
                // Replayed old-coordinator advertising must not revive or extend it.
                await previous.send('*', { ...lease, sequence: 2, expiresAt: now + 500 });
                if (fresh) refreshTimer = setTimeout(() => successor.send('*', { ...handover, sequence: 2, issuedAt: Date.now(), expiresAt: Date.now() + 500 }), 140);
              }
            };
          }
          return value;
        },
        dynamicRoomFactory: async args => {
          startedRooms++;
          const channel = await args.signalerFactory({ room: args.room, namespace: args.namespace + ':dynamic-v1', signal: args.signal });
          channel.close(); throw Error('fixture selected refreshed successor');
        }
      }));
    } finally { clearTimeout(refreshTimer); }
  }
  try {
    await assert.rejects(lookup(false), failure => failure.code === 'PUBLIC_HANDOVER_PENDING');
    assert.equal(startedRooms, 0, 'a known pending handover must never become a join to departed A or a new host');
    await assert.rejects(lookup(true), /fixture selected refreshed successor/);
    assert.equal(startedRooms, 1);
    const reservations = f.messages.filter(e => e.message.op === 'reserve');
    assert.equal(reservations.length, 1); assert.equal(reservations[0].to, successor.id); assert.equal(reservations[0].message.epoch, 2);
  } finally { previous.close(); successor.close(); }
  assert.equal(f.liveSignalers, 0);
});
