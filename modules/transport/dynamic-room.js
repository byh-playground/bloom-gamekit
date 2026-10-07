import { PROTOCOL_VERSION, encoder } from '../_rollback-shared/protocol.js';
import { compareIds, integer, nowMs } from '../deterministic/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createWebRTCPeer } from './webrtc.js';
import { createRoomResumeIdentity } from './room-resume-identity.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const signalTypes = new Set(['offer', 'answer', 'ice', 'bye']);
const PROBE_MAGIC = new Uint8Array([66, 77, 68, 89, 78, 80, 82, 49]);
const MAX_SIGNAL_BYTES = 128 * 1024, MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const randomId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
function roster(value, maxPlayers) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPlayers ||
      value.some(id => !validId(id)) || new Set(value).size !== value.length) throw new TypeError('dynamic room players');
  return Object.freeze([...value].sort(compareIds));
}

/** Ongoing 1..5-player mesh connectivity. RTC connection is not roster admission.
 * A RoomSession owns admission, snapshots, committed epochs and graceful succession.
 * Optional resume storage retains the room-scoped signing identity across reload.
 */
export async function createNostrDynamicRoom({ role, room, namespace = 'rollback-netcode',
  maxPlayers = 5, maxPendingPeers = 5, timeoutMs = 60000, peerTimeoutMs = 20000,
  retryMs = 1500, advertiseIntervalMs = 5000, resume, resumeProbeMs = 1500, relays, rtcConfig, signal, onStatus = () => {},
  signalerFactory = createNostrSignaler, peerFactory = createWebRTCPeer, expectedSessionId, authorizeJoin = () => true } = {}) {
  if (!['host', 'join'].includes(role)) throw new TypeError('dynamic room role');
  integer(maxPlayers, 'maxPlayers', 1, 5); integer(maxPendingPeers, 'maxPendingPeers', 1, 5);
  integer(timeoutMs, 'timeoutMs', 1, 120000); integer(peerTimeoutMs, 'peerTimeoutMs', 1, 120000);
  integer(resumeProbeMs, 'resumeProbeMs', 10, 10000);
  integer(retryMs, 'retryMs', 10, 10000); integer(advertiseIntervalMs, 'advertiseIntervalMs', 10, 120000);
  if (typeof namespace !== 'string' || !namespace.trim() || encoder.encode(namespace + ':dynamic-v1').length > 128) throw new TypeError('dynamic room namespace');
  if (expectedSessionId !== undefined && (!validId(expectedSessionId) || expectedSessionId.length > 116)) throw new TypeError('expectedSessionId');
  if ([onStatus, signalerFactory, peerFactory, authorizeJoin].some(fn => typeof fn !== 'function')) throw new TypeError('dynamic room capability');
  if (signal?.aborted) throw new Error('dynamic room aborted');
  if (!room && role === 'host') room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
  if (!/^\d{4}$/.test(room ?? '')) throw new TypeError('four-digit room');
  const resumeIdentity = resume ? createRoomResumeIdentity(resume, { namespace, room }) : null;
  const startedAt = nowMs(), signalController = new AbortController();
  let initializationReject;
  const initializationFailure = new Promise((resolve, reject) => { initializationReject = reject; });
  const initializationTimer = setTimeout(() => {
    signalController.abort(); initializationReject(new Error('dynamic room signaling timeout'));
  }, timeoutMs);
  const earlyAbort = () => { signalController.abort(); initializationReject(new Error('dynamic room aborted')); };
  signal?.addEventListener('abort', earlyAbort, { once: true });
  let signaler;
  try {
    const setup = Promise.resolve().then(() => signalerFactory({ room, namespace: namespace + ':dynamic-v1', relays,
      signal: signalController.signal, timeoutMs: Math.min(timeoutMs, 10000), onStatus,
      maxVerificationsPerSecond: 32, verificationBurst: 20, identity: resumeIdentity?.identity })).then(value => {
        if (signalController.signal.aborted) value?.close?.();
        return value;
      });
    signaler = await Promise.race([setup, initializationFailure]);
    if (!validId(signaler?.id) || ['send', 'subscribe', 'close'].some(key => typeof signaler?.[key] !== 'function')) throw new TypeError('dynamic signaler capability');
    if (signal?.aborted || signalController.signal.aborted) throw new Error('dynamic room aborted');
  } catch (error) { signalController.abort(); signaler?.close?.(); resumeIdentity?.identity.close(); throw error; }
  finally { clearTimeout(initializationTimer); signal?.removeEventListener('abort', earlyAbort); }

  if (resumeIdentity && signaler.id !== resumeIdentity.identity.id) { signaler.close(); resumeIdentity.identity.close(); throw new Error('resume signaler identity mismatch'); }
  const self = signaler.id, incarnation = randomId(), transports = new Map(), peerConnections = new Map(), listeners = new Set();
  const links = new Map(), generations = new Map(), candidates = new Map(), backlog = new Map(), publications = new Map();
  const saved = resumeIdentity?.metadata, resumed = !!(saved?.sessionId && saved.players.includes(self));
  if (saved?.sessionId && expectedSessionId !== undefined && expectedSessionId !== saved.sessionId) {
    signaler.close(); resumeIdentity.identity.close(); throw new Error('resume session does not match expectedSessionId; explicitly reset');
  }
  const resumeTargets = new Set(resumed ? saved.players : []);
  const establishing = role === 'join' || resumed, incarnations = new Map([[self, incarnation]]), resumeApproved = new Set(), resumeChecks = new Map();
  let resumePeerId = null;
  let players = Object.freeze(resumed ? [...saved.players] : role === 'host' ? [self] : []);
  let coordinatorId = resumed ? saved.coordinatorId : role === 'host' ? self : null;
  let sessionId = resumed ? saved.sessionId : role === 'host' ? randomId() : null;
  let epoch = resumed ? saved.epoch : 0, meshPlayers = new Set(players), meshUntil = resumed ? Infinity : 0;
  let hasBeenAdmitted = players.includes(self);
  let disposed = false, settled = false, backlogBytes = 0, unsubscribe, interval, deadline, invitation, nextAdvertisement = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Hosts return before any peers exist. Background failures are observable events.
  const status = (type, detail = {}) => {
    const event = { type, room, role, ...detail };
    try { onStatus(event); } catch { /* Observers never own room state. */ }
    for (const fn of [...listeners]) { try { fn(event); } catch { /* Observer only. */ } }
  };
  const pendingCount = () => [...links.values()].filter(link => !link.peer).length;
  const accepted = id => players.includes(id) || meshPlayers.has(id) && meshUntil > nowMs() || candidates.has(id);
  const leader = id => compareIds(self, id) > 0;
  const control = (op, extra = {}) => ({ type: 'group', mode: 'dynamic', version: 1, protocol: PROTOCOL_VERSION,
    op, sessionId, coordinatorId, epoch, incarnation, ...extra });
  function publish(to, payload, key = to + ':' + payload.op) {
    if (disposed) return Promise.reject(new Error('dynamic room closed'));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= 32) return Promise.reject(new Error('dynamic signaling publication capacity'));
    const promise = Promise.resolve().then(() => {
      if (disposed) throw new Error('dynamic room closed');
      return signaler.send(to, payload);
    }).finally(() => { if (publications.get(key) === promise) publications.delete(key); });
    publications.set(key, promise); return promise;
  }
  function send(to, op, extra = {}) {
    const promise = publish(to, control(op, { targetIncarnation: incarnations.get(to), ...extra }));
    promise.catch(error => { if (!disposed) status('signal-error', { peerId: to, reason: error.message }); });
    return promise;
  }
  function forgetBacklog(key) {
    const queued = backlog.get(key); if (!queued) return;
    for (const item of queued.items) backlogBytes -= item.size;
    backlog.delete(key);
  }
  function rememberGeneration(id, generation) {
    generations.delete(id); generations.set(id, generation);
    // Only disconnected tombstones are evicted; live peers always retain their scope.
    for (const old of generations.keys()) {
      if (generations.size <= 64) break;
      if (!links.has(old) && !accepted(old)) generations.delete(old);
    }
  }
  function destroyLink(link, reason, notify = true, preserveWaiter = false) {
    if (links.get(link.id) !== link) return;
    links.delete(link.id); clearTimeout(link.deadline); link.removeStatus?.(); link.removeRaw?.(); link.cancelProbe?.(); link.controller.abort();
    const wasConnected = transports.delete(link.id); peerConnections.delete(link.id);
    link.peer?.close(); link.subscribers.clear(); link.outbound.clear();
    if (!preserveWaiter) link.reject(new Error(reason));
    if (wasConnected && notify && !disposed) status('peer-disconnected', { peerId: link.id, reason });
  }
  function finish() {
    if (disposed || settled) return;
    settled = true; clearTimeout(deadline); readyResolve(capability);
  }
  function close(reason = 'dynamic room closed') {
    if (disposed) return;
    disposed = true; clearInterval(interval); clearTimeout(deadline); unsubscribe?.();
    signal?.removeEventListener('abort', abort);
    for (const link of [...links.values()]) destroyLink(link, reason, false);
    signalController.abort(); signaler.close(); resumeIdentity?.identity.close(); backlog.clear(); backlogBytes = 0; candidates.clear(); publications.clear();
    if (!settled) { settled = true; readyReject(new Error(reason)); }
    status('room-closed', { reason }); listeners.clear();
  }
  function abort() { close('dynamic room aborted'); }
  function failLink(link, error) {
    if (disposed || links.get(link.id) !== link) return;
    destroyLink(link, error.message || String(error));
    status('peer-failed', { peerId: link.id, reason: error.message || String(error) });
    // Initial join is bounded by its own deadline and may retry this link.
  }
  function newLink(id, generation, connectionId, prior) {
    if (!prior && (pendingCount() >= maxPendingPeers || links.size >= maxPlayers - 1 + maxPendingPeers)) throw new Error('dynamic pending peer capacity');
    let resolve, reject, promise;
    if (prior && !prior.peer) ({ resolve, reject, promise } = prior);
    else { promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); }
    if (prior) destroyLink(prior, 'peer reconnecting', true, !prior.peer);
    const link = { id, generation, connectionId, resolve, reject, promise, controller: new AbortController(),
      peer: null, started: false, subscribers: new Set(), outbound: new Map(), nextRetry: 0,
      requestGeneration: generations.get(id) ?? 0, force: false };
    links.set(id, link);
    link.deadline = setTimeout(() => failLink(link, new Error('dynamic peer timeout')), peerTimeoutMs);
    return link;
  }
  function scopedSignaler(link) {
    return { id: self, close() {},
      send(to, payload) {
        if (disposed || links.get(link.id) !== link || to !== link.id || !signalTypes.has(payload?.type)) return Promise.reject(new Error('dynamic peer scope'));
        const message = { ...payload, dynamicSession: sessionId, dynamicGeneration: link.generation, dynamicConnection: link.connectionId, dynamicFrom: incarnation, dynamicTo: incarnations.get(to) };
        if (encoder.encode(JSON.stringify(message)).length > MAX_SIGNAL_BYTES) return Promise.reject(new RangeError('dynamic signaling message capacity'));
        // Offers and answers are safe to replay. ICE is bounded by createWebRTCPeer.
        if (payload.type === 'offer' || payload.type === 'answer') link.outbound.set(payload.type, message);
        return Promise.resolve(link.announcement).then(() => {
          if (disposed || links.get(link.id) !== link) throw new Error('dynamic peer scope');
          return publish(to, message, `${to}:signal:${link.generation}:${payload.type}`);
        });
      },
      subscribe(fn) {
        if (typeof fn !== 'function') throw new TypeError('dynamic signaling subscriber');
        link.subscribers.add(fn);
        const key = `${link.id}:${link.generation}:${link.connectionId}`, queued = backlog.get(key);
        if (queued) { const items = queued.items.slice(); forgetBacklog(key); for (const item of items) if (!disposed) fn(item.envelope); }
        return () => link.subscribers.delete(fn);
      }
    };
  }
  function saveResume() {
    if (!resumeIdentity || !sessionId) return;
    if (hasBeenAdmitted && !players.includes(self)) { resumeIdentity.forget(); return; }
    if (players.includes(self)) hasBeenAdmitted = true;
    resumeIdentity.update({ sessionId, coordinatorId, epoch, players });
  }
  function acceptIncarnations(value, next) {
    if (!value || typeof value !== 'object') return;
    for (const id of next) if (id !== self && validId(value[id])) {
      // Existing connections require their own resume challenge before replacement.
      if (!links.get(id)?.peer || !incarnations.has(id)) incarnations.set(id, value[id]);
    }
  }
  function wrapTransport(link, raw) {
    const handlers = new Set();
    link.removeRaw = raw.subscribe(bytes => {
      if (bytes.length === 25 && PROBE_MAGIC.every((value, i) => bytes[i] === value)) {
        if (bytes[8] === 1) { const reply = bytes.slice(); reply[8] = 2; raw.send(reply); }
        else if (bytes[8] === 2) link.onPong?.(bytes.subarray(9));
        return;
      }
      for (const fn of [...handlers]) fn(bytes);
    });
    return { get state() { return raw.state; }, get bufferedAmount() { return raw.bufferedAmount ?? 0; },
      send: data => raw.send(data), close: () => link.peer.close(),
      subscribe(fn) { if (typeof fn !== 'function') throw new TypeError('dynamic transport subscriber'); handlers.add(fn); return () => handlers.delete(fn); },
      subscribeStatus: fn => raw.subscribeStatus?.(fn) ?? (() => {}) };
  }
  function probePeer(link) {
    if (!link?.peer || link.peer.transport.state && link.peer.transport.state !== 'open') return Promise.resolve(false);
    return new Promise(resolve => {
      const bytes = new Uint8Array(25); bytes.set(PROBE_MAGIC); bytes[8] = 1;
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16)); bytes.set(nonce, 9);
      let done = false, timer;
      const finish = alive => { if (done) return; done = true; clearTimeout(timer); link.onPong = null; link.cancelProbe = null; resolve(alive); };
      link.onPong = response => { if (nonce.every((value, i) => response[i] === value)) finish(true); };
      link.cancelProbe = () => finish(false);
      timer = setTimeout(() => finish(false), resumeProbeMs);
      // Backpressure is not evidence of death: reject the duplicate conservatively.
      if (!link.peer.transport.send(bytes)) finish(true);
    });
  }
  function approveResume(id, requestedIncarnation) {
    if (incarnations.get(id) === requestedIncarnation) {
      send(id, 'resume-accept', { generation: links.get(id)?.connectionId ? links.get(id).generation : (generations.get(id) ?? 0) + 1 }); return;
    }
    if (resumeChecks.has(id)) return;
    const existing = links.get(id);
    const check = probePeer(existing).then(alive => {
      if (disposed) return;
      if (alive) { send(id, 'resume-reject', { targetIncarnation: requestedIncarnation }); return; }
      if (existing && links.get(id) === existing) destroyLink(existing, 'peer resuming');
      incarnations.set(id, requestedIncarnation);
      const generation = (generations.get(id) ?? 0) + 1;
      send(id, 'resume-accept', { generation, targetIncarnation: requestedIncarnation });
      status('peer-resuming', { peerId: id });
      if (leader(id)) { try { startGeneration(id, generation); } catch {} }
    }).finally(() => resumeChecks.delete(id));
    resumeChecks.set(id, check);
  }
  function startPeer(link) {
    if (disposed || link.started || links.get(link.id) !== link) return;
    link.started = true;
    Promise.resolve().then(() => {
      if (disposed || links.get(link.id) !== link) throw new Error('dynamic peer superseded');
      return peerFactory({ initiator: leader(link.id), signaler: scopedSignaler(link), remoteId: link.id,
        rtcConfig, timeoutMs: peerTimeoutMs, signal: link.controller.signal,
        onStatus: event => status('peer-status', { peerId: link.id, event }) });
    }).then(peer => {
      if (disposed || links.get(link.id) !== link) { peer?.close?.(); return; }
      if (typeof peer?.transport?.send !== 'function' || typeof peer.transport.subscribe !== 'function' || typeof peer.close !== 'function') {
        peer?.close?.(); throw new TypeError('dynamic peer capability');
      }
      if (peer.transport.state && peer.transport.state !== 'open') { peer.close(); throw new Error('dynamic transport not open'); }
      link.peer = peer; clearTimeout(link.deadline); link.outbound.clear();
      const transport = wrapTransport(link, peer.transport);
      transports.set(link.id, transport); peerConnections.set(link.id, peer.peerConnection);
      if (peer.transport.subscribeStatus) link.removeStatus = peer.transport.subscribeStatus(state => {
        if (state === 'closed' || state === 'failed' || state === 'interrupted') failLink(link, new Error('dynamic peer ' + state));
      });
      link.resolve(transport);
      status('peer-connected', { peerId: link.id, transport, generation: link.generation });
      if (!disposed && establishing && (link.id === coordinatorId || resumed && coordinatorId === self)) { resumePeerId ??= link.id; finish(); }
    }).catch(error => failLink(link, error));
  }
  function announceLink(link) {
    return send(link.id, 'link', { generation: link.generation, connectionId: link.connectionId });
  }
  function startGeneration(id, generation) {
    const link = newLink(id, generation, randomId(), links.get(id));
    rememberGeneration(id, generation); link.announcement = announceLink(link);
    // Errors here fail the individual attempt, not an already running room.
    link.announcement.catch(error => failLink(link, error)); startPeer(link); return link;
  }
  function ensurePeer(id, force = false) {
    if (disposed) return Promise.reject(new Error('dynamic room closed'));
    if (!validId(id) || id === self || !accepted(id)) return Promise.reject(new Error('dynamic peer is not invited'));
    const old = links.get(id);
    if (resumed && resumeTargets.has(id) && !resumeApproved.has(id)) {
      try { const waiting = old ?? newLink(id, 0, null); waiting.resuming = true;
        send(id, 'resume-request', { resumeSession: sessionId }); return waiting.promise;
      } catch (error) { return Promise.reject(error); }
    }
    if (!incarnations.has(id)) {
      try { const waiting = old ?? newLink(id, 0, null); waiting.waitingIncarnation = true; return waiting.promise; }
      catch (error) { return Promise.reject(error); }
    }
    if (old && !old.waitingIncarnation && (!force || !old.peer)) return old.promise;
    try {
      if (leader(id)) return startGeneration(id, (generations.get(id) ?? 0) + 1).promise;
      const link = newLink(id, 0, null, old); link.force = force;
      send(id, 'request', { generation: link.requestGeneration, reconnect: force }); return link.promise;
    } catch (error) { return Promise.reject(error); }
  }
  function advertise(to = '*') {
    if (coordinatorId !== self || resumed && !settled) return;
    send(to, 'hello', { players, maxPlayers, accepting: players.length < maxPlayers });
  }
  function inviteMesh(value) {
    const next = roster(value, maxPlayers);
    if (!next.includes(self) || !next.includes(coordinatorId)) throw new TypeError('dynamic mesh requires local player and coordinator');
    meshPlayers = new Set(next); meshUntil = nowMs() + peerTimeoutMs;
    if (coordinatorId === self) {
      invitation = { players: next, until: meshUntil };
      send('*', 'mesh', { players: next, peerIncarnations: Object.fromEntries(incarnations) });
    }
    return next;
  }
  function setRoster(value) {
    if (disposed) throw new Error('dynamic room closed');
    const next = roster(value?.players, maxPlayers), nextEpoch = integer(value?.epoch, 'epoch', 0, 65534);
    if (!validId(value?.coordinatorId) || !next.includes(value.coordinatorId)) throw new TypeError('dynamic roster coordinator');
    if (nextEpoch < epoch) throw new Error('stale dynamic room epoch');
    if (nextEpoch === epoch && (players.join('\n') !== next.join('\n') || coordinatorId !== value.coordinatorId)) throw new Error('conflicting dynamic room epoch');
    players = next; epoch = nextEpoch; coordinatorId = value.coordinatorId;
    meshPlayers = new Set(next); meshUntil = Infinity; invitation = null;
    for (const id of candidates.keys()) if (next.includes(id)) candidates.delete(id);
    for (const id of incarnations.keys()) if (id !== self && !next.includes(id) && !links.has(id) && !candidates.has(id)) incarnations.delete(id);
    saveResume();
    // Existing RTC links deliberately remain open until RoomSession delivers commit.
    if (coordinatorId === self) advertise();
  }
  const capability = {
    room, role, maxPlayers, resumed, get resumePeerId() { return resumePeerId; }, localPlayerId: self, transports, peerConnections,
    get sessionId() { return sessionId; }, get coordinatorId() { return coordinatorId; },
    get players() { return players; }, get epoch() { return epoch; },
    get joining() { return !players.includes(self); }, get closed() { return disposed; },
    get metrics() { return { activePeerCount: transports.size, pendingPeerCount: pendingCount(), signalBacklogBytes: backlogBytes }; },
    subscribe(fn) { if (disposed || typeof fn !== 'function') throw new TypeError('dynamic room subscriber'); listeners.add(fn); return () => listeners.delete(fn); },
    setRoster,
    connectMesh(value) {
      try { if (disposed) throw new Error('dynamic room closed'); const next = inviteMesh(value);
        return Promise.all(next.filter(id => id !== self).map(id => ensurePeer(id))).then(() => undefined);
      } catch (error) { return Promise.reject(error); }
    },
    reconnect(id) { return ensurePeer(id, true); },
    forgetResume() { resumeIdentity?.forget(); },
    disconnect(id) {
      if (!validId(id) || id === self) throw new TypeError('dynamic peer id');
      const link = links.get(id); if (link) destroyLink(link, 'peer disconnected by owner');
      candidates.delete(id); meshPlayers.delete(id); if (!players.includes(id)) incarnations.delete(id);
      for (const key of backlog.keys()) if (key.startsWith(id + ':')) forgetBacklog(key);
      return !!link;
    }, close
  };
  function routeSignal(envelope) {
    const { from, to, message: m } = envelope;
    if (to !== self || m.dynamicSession !== sessionId || m.dynamicTo !== incarnation || m.dynamicFrom !== incarnations.get(from) || !accepted(from) ||
        !Number.isSafeInteger(m.dynamicGeneration) || m.dynamicGeneration < 1 || !validId(m.dynamicConnection)) return;
    let size; try { size = encoder.encode(JSON.stringify(m)).length; } catch { return; }
    if (size > MAX_SIGNAL_BYTES) return;
    const link = links.get(from);
    if (link?.generation === m.dynamicGeneration && link.connectionId === m.dynamicConnection && link.subscribers.size) {
      for (const fn of [...link.subscribers]) fn(envelope); return;
    }
    // Only a future deterministic initiator may precede its link announcement.
    const known = generations.get(from) ?? 0;
    if (leader(from) || m.dynamicGeneration < known || m.dynamicGeneration === known &&
        (!link || link.generation !== m.dynamicGeneration || link.connectionId !== m.dynamicConnection)) return;
    const key = `${from}:${m.dynamicGeneration}:${m.dynamicConnection}`;
    const queued = backlog.get(key) ?? { items: [], until: nowMs() + peerTimeoutMs };
    if (queued.items.length >= 32 || (!backlog.has(key) && backlog.size >= maxPendingPeers) || backlogBytes + size > MAX_BACKLOG_BYTES) return;
    queued.items.push({ envelope, size }); backlogBytes += size; backlog.set(key, queued);
  }
  function receive(envelope) {
    if (disposed || !envelope || !validId(envelope.from) || envelope.from === self ||
        !['*', self].includes(envelope.to) || !envelope.message || typeof envelope.message !== 'object') return;
    const { from, message: m } = envelope;
    if (signalTypes.has(m.type)) { routeSignal(envelope); return; }
    if (m.type !== 'group' || m.mode !== 'dynamic' || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
    if (m.targetIncarnation && m.targetIncarnation !== incarnation) return;
    if (m.op === 'discover') {
      if (m.resumeSession === sessionId && players.includes(from) && validId(m.incarnation)) {
        send(from, 'resume-hello', { targetIncarnation: m.incarnation, players, peerIncarnations: Object.fromEntries(incarnations) });
      } else advertise(from);
      return;
    }
    if (m.op === 'resume-hello' && resumed && !settled && m.sessionId === sessionId && players.includes(from) && validId(m.incarnation)) {
      let next; try { next = roster(m.players, maxPlayers); integer(m.epoch, 'epoch', epoch, 65534); } catch { return; }
      if (!next.includes(self) || !next.includes(from) || !next.includes(m.coordinatorId)) return;
      players = next; epoch = m.epoch; coordinatorId = m.coordinatorId; meshPlayers = new Set(next); meshUntil = Infinity;
      acceptIncarnations(m.peerIncarnations, next); incarnations.set(from, m.incarnation); saveResume();
      const donor = coordinatorId === self ? from : coordinatorId;
      if (incarnations.has(donor)) ensurePeer(donor).catch(() => {});
      return;
    }
    if (m.op === 'hello' && expectedSessionId !== undefined && m.sessionId !== expectedSessionId) return;
    if (m.op === 'hello' && !resumed && !settled && role === 'join' && m.coordinatorId === from && validId(m.sessionId)) {
      if (coordinatorId && (coordinatorId !== from || sessionId !== m.sessionId)) return;
      let known; try { known = roster(m.players, maxPlayers); integer(m.epoch, 'epoch', 0, 65534); } catch { return; }
      if (!known.includes(from)) return;
      if (m.maxPlayers !== maxPlayers) { close('dynamic room maxPlayers mismatch'); return; }
      if (m.accepting === false && !known.includes(self)) { close('dynamic room is full'); return; }
      coordinatorId = from; sessionId = m.sessionId; players = known; epoch = m.epoch; incarnations.set(from, m.incarnation);
      meshPlayers = new Set(known); meshUntil = Infinity;
      saveResume(); send(from, 'join'); ensurePeer(from).catch(() => {}); return;
    }
    if (!sessionId || m.sessionId !== sessionId || m.coordinatorId !== coordinatorId) return;
    if (m.op === 'resume-request' && players.includes(from) && m.resumeSession === sessionId && validId(m.incarnation)) {
      approveResume(from, m.incarnation); return;
    }
    if (m.op === 'resume-reject' && resumed && players.includes(from)) {
      if (!settled) close('duplicate live resume identity');
      else if (links.get(from)?.resuming) failLink(links.get(from), new Error('duplicate live resume identity'));
      return;
    }
    if (m.op === 'resume-accept' && resumed && players.includes(from) && validId(m.incarnation) &&
        Number.isSafeInteger(m.generation) && m.generation > 0) {
      if (resumeApproved.has(from)) return;
      incarnations.set(from, m.incarnation); resumeApproved.add(from);
      if (leader(from)) { try { startGeneration(from, Math.max(m.generation, (generations.get(from) ?? 0) + 1)); } catch {} }
      return;
    }
    if (m.op === 'join' && coordinatorId === self) {
      if (!validId(m.incarnation)) return;
      if (incarnations.has(from) && incarnations.get(from) !== m.incarnation) {
        send(from, 'reject', { targetIncarnation: m.incarnation, reason: 'duplicate live identity; use resume' }); return;
      }
      if (!players.includes(from) && !candidates.has(from)) {
        let authorized = false;
        try { authorized = authorizeJoin(from, { sessionId, room }) === true; } catch { /* Admission callbacks fail closed. */ }
        if (!authorized) { send(from, 'reject', { targetIncarnation: m.incarnation, reason: 'dynamic room admission reservation required' }); return; }
        if (players.length + candidates.size >= maxPlayers || pendingCount() >= maxPendingPeers) { send(from, 'reject', { targetIncarnation: m.incarnation, reason: 'dynamic room is full' }); return; }
        candidates.set(from, nowMs() + peerTimeoutMs);
      }
      incarnations.set(from, m.incarnation);
      ensurePeer(from).catch(() => {}); return;
    }
    if (m.op === 'reject' && !settled && from === coordinatorId) { close(typeof m.reason === 'string' ? m.reason.slice(0, 256) : 'dynamic room rejected'); return; }
    if (m.op === 'mesh' && from === coordinatorId && m.incarnation === incarnations.get(from) && m.epoch === epoch) {
      let next; try { next = roster(m.players, maxPlayers); } catch { return; }
      if (!next.includes(self) || !next.includes(coordinatorId)) return;
      acceptIncarnations(m.peerIncarnations, next);
      meshPlayers = new Set(next); meshUntil = nowMs() + peerTimeoutMs;
      for (const id of next) if (id !== self) ensurePeer(id).catch(() => {});
      return;
    }
    if (!accepted(from) || m.incarnation !== incarnations.get(from)) return;
    if (m.op === 'request' && leader(from) && Number.isSafeInteger(m.generation) && m.generation >= 0) {
      const link = links.get(from), generation = generations.get(from) ?? 0;
      if (m.generation > generation) return;
      if (!link || m.reconnect === true && m.generation === generation && link.peer) {
        try { startGeneration(from, generation + 1); } catch { /* Pending capacity is bounded. */ }
      } else if (link.connectionId) announceLink(link);
    } else if (m.op === 'link' && !leader(from) && Number.isSafeInteger(m.generation) && m.generation > 0 && validId(m.connectionId)) {
      const known = generations.get(from) ?? 0, current = links.get(from);
      if (m.generation < known || m.generation === known && current?.connectionId !== m.connectionId) return;
      if (current?.generation === m.generation && current.connectionId === m.connectionId) return;
      try { const link = newLink(from, m.generation, m.connectionId, current);
        rememberGeneration(from, m.generation); startPeer(link);
      } catch { /* Pending capacity is bounded. */ }
    }
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return ready; }
  try { unsubscribe = signaler.subscribe(envelope => { try { receive(envelope); } catch (error) { close(error.message); } }); } catch (error) { close(error.message); return ready; }
  if (disposed) { unsubscribe?.(); return ready; }
  const remaining = timeoutMs - (nowMs() - startedAt);
  if (remaining <= 0) { close('dynamic room timeout'); return ready; }
  if (establishing) deadline = setTimeout(() => close('dynamic room join timeout'), remaining);
  interval = setInterval(() => {
    const now = nowMs();
    for (const [id, until] of candidates) if (until <= now && !players.includes(id)) {
      candidates.delete(id); incarnations.delete(id); const link = links.get(id); if (link) destroyLink(link, 'dynamic admission timeout');
    }
    for (const [key, queued] of backlog) if (queued.until <= now) forgetBacklog(key);
    if (coordinatorId === self && now >= nextAdvertisement) { nextAdvertisement = now + advertiseIntervalMs; advertise(); }
    if (!settled && establishing) {
      if (resumed) send('*', 'discover', { resumeSession: sessionId });
      else if (!coordinatorId) send('*', 'discover');
      else { send(coordinatorId, 'join'); ensurePeer(coordinatorId).catch(() => {}); }
    }
    if (invitation && invitation.until > now) send('*', 'mesh', { players: invitation.players, peerIncarnations: Object.fromEntries(incarnations) });
    else invitation = null;
    for (const link of links.values()) if (!link.peer && now >= link.nextRetry) {
      link.nextRetry = now + retryMs;
      if (link.waitingIncarnation) { if (incarnations.has(link.id)) ensurePeer(link.id).catch(() => {}); continue; }
      if (link.resuming && !resumeApproved.has(link.id)) { send(link.id, 'resume-request', { resumeSession: sessionId }); continue; }
      if (leader(link.id)) announceLink(link);
      else if (!link.connectionId) send(link.id, 'request', { generation: link.requestGeneration, reconnect: link.force });
      for (const [type, message] of link.outbound) publish(link.id, message, `${link.id}:signal:${link.generation}:${type}`).catch(() => {});
    }
  }, retryMs);
  interval.unref?.();
  status('room-ready', { localPlayerId: self });
  if (!disposed) {
    try { saveResume(); } catch (error) { close(error.message); return ready; }
    if (!establishing) { advertise(); finish(); }
    else send('*', 'discover', resumed ? { resumeSession: sessionId } : {});
  }
  return ready;
}
