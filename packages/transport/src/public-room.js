import { PROTOCOL_VERSION, encoder } from '../../_rollback-shared/src/protocol.js';
import { integer, nowMs } from '../../deterministic/src/utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createNostrDynamicRoom } from './dynamic-room.js';
import { createRoomResumeIdentity } from './room-resume-identity.js';

const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const randomId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
const randomRoom = () => String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
const DIRECTORY_LIMIT = 64, PUBLICATION_LIMIT = 16;
const error = (code, message) => Object.assign(new Error(message), { code });

/** Advisory, short-lived public room discovery. Only RoomSession commits game admission. */
export async function createNostrPublicRoom({ namespace = 'rollback-netcode', simulationVersion, maxPlayers = 5,
  discoveryMs = 1500, totalTimeoutMs = 60000, leaseMs = 15000, reservationMs = 30000, maxAttempts = 3,
  relays, rtcConfig, resume, signal, onStatus = () => {}, signalerFactory = createNostrSignaler,
  dynamicRoomFactory = createNostrDynamicRoom, ...dynamicOptions } = {}) {
  if (typeof namespace !== 'string' || !namespace.trim() || encoder.encode(namespace + ':public-v1').length > 128) throw new TypeError('public room namespace');
  if (typeof simulationVersion !== 'string' || !simulationVersion.length || encoder.encode(simulationVersion).length > 128) throw new TypeError('public simulationVersion');
  integer(maxPlayers, 'maxPlayers', 1, 5); integer(discoveryMs, 'discoveryMs', 10, 30000);
  integer(totalTimeoutMs, 'totalTimeoutMs', 10, 120000); integer(leaseMs, 'leaseMs', 100, 60000);
  integer(reservationMs, 'reservationMs', 100, 120000); integer(maxAttempts, 'maxAttempts', 1, 8);
  if ([onStatus, signalerFactory, dynamicRoomFactory].some(fn => typeof fn !== 'function')) throw new TypeError('public room capability');
  if (resume) {
    if (!resume.storage || ['getItem', 'setItem', 'removeItem'].some(k => typeof resume.storage[k] !== 'function')) throw new TypeError('resume storage capability');
    integer(resume.lifetimeMs ?? 8 * 60 * 60 * 1000, 'resume lifetimeMs', 1000, 86400000);
    if (resume.reset !== undefined && typeof resume.reset !== 'boolean') throw new TypeError('resume reset');
    if (resume.key !== undefined && (typeof resume.key !== 'string' || !resume.key.length || resume.key.length > 500)) throw new TypeError('resume key');
  }
  if (signal?.aborted) throw error('PUBLIC_ABORTED', 'public room aborted');
  const started = nowMs(), startedWallAt = Date.now(), controller = new AbortController(), directory = new Map(), reservations = new Map(), publications = new Map();
  const ephemeralStore = new Map();
  const ephemeral = createRoomResumeIdentity({ storage: { getItem: k => ephemeralStore.get(k) ?? null, setItem: (k, v) => ephemeralStore.set(k, v), removeItem: k => ephemeralStore.delete(k) } }, { namespace, room: '0000' });
  // A private in-memory identity is shared only by this room attempt's signalers.
  const shared = identity => ({ id: identity.id, sign: (...args) => identity.sign(...args), close() {} });
  let disposed = false, everAdmitted = false, resumeForgotten = false, room, directorySignaler, removeDirectory, removeRoom, interval, nextAdvertisement = 0;
  let sequence = 0, reservationWaiter, selected, setupTimer, generation = 0, directoryId, pointer, pointerKey, storedUntil;
  const timerWaiters = new Map(), observers = new Set();
  const status = (type, detail = {}) => { const event = { type, ...detail }; try { onStatus(event); } catch {} for (const fn of [...observers]) { try { fn(event); } catch {} } };
  const remaining = () => Math.max(0, Math.floor(totalTimeoutMs - (nowMs() - started)));
  const scopedResume = code => resume ? { ...resume, ...(resume.key ? { key: `${resume.key}:${code}` } : {}) } : undefined;
  const roomStorageKey = code => scopedResume(code)?.key ?? `bloom-gamekit:dynamic-v1:${namespace}:${code}`;
  if (resume) {
    if (!resume.storage || ['getItem', 'setItem', 'removeItem'].some(k => typeof resume.storage[k] !== 'function')) throw new TypeError('resume storage capability');
    pointerKey = `${resume.key ?? `bloom-gamekit:public-v1:${namespace}:${simulationVersion}`}:pointer`;
    if (pointerKey.length > 512) throw new TypeError('public resume key');
    const raw = resume.storage.getItem(pointerKey);
    if (resume.reset) {
      if (raw) { try { const old = JSON.parse(raw); if (/^\d{4}$/.test(old?.room)) resume.storage.removeItem(roomStorageKey(old.room)); } catch {} }
      resume.storage.removeItem(pointerKey);
    } else if (raw != null) {
      try {
        if (typeof raw !== 'string' || raw.length > 2048) throw Error();
        pointer = JSON.parse(raw);
        if (pointer.version !== 1 || pointer.namespace !== namespace || pointer.simulationVersion !== simulationVersion ||
            !/^\d{4}$/.test(pointer.room) || !idValid(pointer.sessionId) || !Number.isSafeInteger(pointer.expiresAt) ||
            pointer.expiresAt <= Date.now() || pointer.expiresAt > Date.now() + 86400000) throw Error();
        storedUntil = pointer.expiresAt;
      } catch { ephemeral.identity.close(); throw error('PUBLIC_RESUME_INVALID', 'invalid or expired public resume pointer; explicitly reset for a fresh room'); }
    }
  }
  const fail = message => error('PUBLIC_TIMEOUT', message ?? 'public room total timeout');
  function wait(ms) {
    if (disposed) return Promise.reject(error('PUBLIC_CLOSED', 'public room closed'));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { timerWaiters.delete(timer); resolve(); }, Math.max(1, ms)); timerWaiters.set(timer, reject); });
  }
  function bounded(promise, ms, reason) {
    let timer;
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(reason), Math.max(1, ms)); timerWaiters.set(timer, reject); });
    return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer); timerWaiters.delete(timer); });
  }
  function close(reason = 'public room closed') {
    if (disposed) return;
    disposed = true; clearTimeout(setupTimer); clearInterval(interval); removeRoom?.(); removeDirectory?.();
    controller.abort(); signal?.removeEventListener('abort', abort);
    const pending = reservationWaiter; reservationWaiter = null; pending?.reject(error('PUBLIC_CLOSED', reason));
    for (const [timer, reject] of timerWaiters) { clearTimeout(timer); reject(error('PUBLIC_CLOSED', reason)); }
    timerWaiters.clear(); directorySignaler?.close(); room?.close(); ephemeral.identity.close(); ephemeralStore.clear();
    directory.clear(); reservations.clear(); publications.clear(); status('public-room-closed', { reason }); observers.clear();
  }
  function abort() { close('public room aborted'); }
  signal?.addEventListener('abort', abort, { once: true });
  setupTimer = setTimeout(() => close('public room total timeout'), totalTimeoutMs);
  function publish(to, op, extra = {}, key = `${to}:${op}`) {
    if (disposed || !directorySignaler) return Promise.reject(error('PUBLIC_CLOSED', 'public directory closed'));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= PUBLICATION_LIMIT) return Promise.reject(error('PUBLIC_CAPACITY', 'public directory publication capacity'));
    const channel = directorySignaler, promise = Promise.resolve().then(() => channel.send(to,
      { type: 'group', mode: 'public-directory', version: 1, protocol: PROTOCOL_VERSION, simulationVersion, maxPlayers, op, ...extra }))
      .finally(() => { if (publications.get(key) === promise) publications.delete(key); });
    publications.set(key, promise); return promise;
  }
  function prune() {
    const now = Date.now();
    for (const [id, lease] of directory) if ((lease.refreshUntil ?? lease.expiresAt) <= now) directory.delete(id);
    for (const [id, seat] of reservations) if (!room || room.players.includes(id) || seat.expiresAt <= now || room.coordinatorId !== room.localPlayerId) {
      reservations.delete(id);
      if (room && !room.players.includes(id)) room.disconnect(id);
    }
  }
  function advertise(to = '*') {
    if (!room || room.closed || room.joining || room.coordinatorId !== room.localPlayerId) return Promise.resolve();
    prune(); const issuedAt = Date.now();
    return publish(to, 'lease', { room: room.room, sessionId: room.sessionId, coordinatorId: room.coordinatorId,
      players: [...room.players], epoch: room.epoch, sequence: ++sequence, issuedAt, expiresAt: issuedAt + leaseMs,
      committed: room.players.length, pending: reservations.size });
  }
  const background = promise => promise.catch(cause => { if (!disposed) status('public-directory-error', { reason: cause.message }); });
  function receive({ from, to, message: m } = {}) {
    if (disposed || !idValid(from) || from === directoryId || !['*', directoryId].includes(to) || !m ||
        m.type !== 'group' || m.mode !== 'public-directory' || m.version !== 1 || m.protocol !== PROTOCOL_VERSION ||
        m.simulationVersion !== simulationVersion || m.maxPlayers !== maxPlayers) return;
    const now = Date.now();
    if (m.op === 'lease') {
      if (!/^\d{4}$/.test(m.room) || !idValid(m.sessionId) || m.coordinatorId !== from ||
          !Number.isSafeInteger(m.epoch) || m.epoch < 0 || m.epoch > 65534 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 ||
          !Number.isSafeInteger(m.issuedAt) || m.issuedAt > now + 1000 || !Number.isSafeInteger(m.expiresAt) ||
          m.expiresAt <= now || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > 60000 ||
          !Array.isArray(m.players) || m.players.length < 1 || m.players.length > maxPlayers ||
          m.players.some(id => !idValid(id)) || new Set(m.players).size !== m.players.length || !m.players.includes(from) ||
          m.committed !== m.players.length || !Number.isSafeInteger(m.pending) || m.pending < 0 || m.pending + m.committed > maxPlayers) return;
      prune();
      const prior = directory.get(m.sessionId);
      if (prior && (m.room !== prior.room || m.epoch < prior.epoch || m.epoch === prior.epoch &&
          (prior.refreshAfter || m.coordinatorId !== prior.coordinatorId || m.sequence <= prior.sequence))) return;
      if (prior && m.epoch > prior.epoch && !prior.players.includes(from)) {
        // A receiver may miss the membership lease that introduced a successor.
        // Quarantine the old coordinator rather than adopting an unknown signer
        // or treating this known room as healthy-empty. The gap expires in a
        // bounded 60s; after the original lease expires, only a newly issued lease
        // can establish the same first-seen advisory trust used by a new client.
        prior.refreshAfter ??= prior.expiresAt;
        prior.refreshUntil ??= prior.refreshAfter + 60000;
        if (now < prior.refreshAfter || m.issuedAt < prior.refreshAfter) return;
      }
      if (!directory.has(m.sessionId) && directory.size >= DIRECTORY_LIMIT) return;
      directory.set(m.sessionId, { room: m.room, sessionId: m.sessionId, coordinatorId: from, players: [...m.players],
        epoch: m.epoch, sequence: m.sequence, issuedAt: m.issuedAt, expiresAt: m.expiresAt, committed: m.committed, pending: m.pending }); return;
    }
    if (m.op === 'discover') { background(advertise()); return; }
    if (m.op === 'grant' || m.op === 'deny') {
      const pending = reservationWaiter;
      if (!pending || to !== directoryId || from !== pending.lease.coordinatorId || m.sessionId !== pending.lease.sessionId ||
          m.requestId !== pending.requestId || m.epoch !== pending.lease.epoch) return;
      if (m.op === 'deny') { reservationWaiter = null; pending.reject(m.reason === 'stale-epoch'
        ? error('PUBLIC_STALE_LEASE', 'public room lease advanced; retry discovery')
        : error('PUBLIC_RESERVED', 'public room has no available reservation')); }
      else if (Number.isSafeInteger(m.expiresAt) && m.expiresAt > now && m.expiresAt <= now + 120000) {
        reservationWaiter = null; pending.resolve({ expiresAt: m.expiresAt });
      }
      return;
    }
    if (!room || room.closed || room.coordinatorId !== room.localPlayerId || m.sessionId !== room.sessionId ||
        to !== directoryId || !idValid(m.requestId)) return;
    prune();
    if (m.op === 'release') {
      const seat = reservations.get(from);
      if (seat?.requestId === m.requestId) { reservations.delete(from); if (!room.players.includes(from)) room.disconnect(from); background(advertise()); }
      return;
    }
    if (m.op !== 'reserve' || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= now || m.expiresAt > now + 120000) return;
    if (m.epoch !== room.epoch) {
      if (Number.isSafeInteger(m.epoch) && m.epoch >= 0 && m.epoch < room.epoch) {
        // Admission can advance while a discovered requester opens its signer.
        // Reply in the request epoch, and advertise the current scope for retry.
        background(advertise(from));
        background(publish(from, 'deny', { sessionId: room.sessionId, epoch: m.epoch, requestId: m.requestId, reason: 'stale-epoch' }));
      }
      return;
    }
    let seat = reservations.get(from);
    if (room.players.includes(from)) {
      background(publish(from, 'grant', { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: now + reservationMs })); return;
    }
    if (!seat && room.players.length + reservations.size < maxPlayers) {
      seat = { requestId: m.requestId, expiresAt: Math.min(now + reservationMs, m.expiresAt), epoch: room.epoch }; reservations.set(from, seat);
    }
    if (seat) {
      seat.requestId = m.requestId;
      // One identity owns one seat. Duplicate requests never extend its lifetime.
      background(publish(from, 'grant', { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: seat.expiresAt }));
    } else background(publish(from, 'deny', { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId }));
    background(advertise());
  }
  async function openDirectory(identity) {
    if (directorySignaler && directoryId === identity.id) return;
    removeDirectory?.(); directorySignaler?.close(); publications.clear(); const current = ++generation;
    const setup = Promise.resolve().then(() => signalerFactory({ room: '0000', namespace: namespace + ':public-v1', relays,
      timeoutMs: Math.max(1, Math.min(10000, remaining())), signal: controller.signal, onStatus,
      maxVerificationsPerSecond: 32, verificationBurst: 20, identity: shared(identity) })).then(value => {
        if (disposed || current !== generation) { value?.close?.(); throw error('PUBLIC_CLOSED', 'public directory closed'); } return value;
      });
    try { directorySignaler = await bounded(setup, remaining(), fail()); }
    catch (cause) { throw error('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message); }
    if (directorySignaler?.id !== identity.id || ['send', 'subscribe', 'close'].some(k => typeof directorySignaler?.[k] !== 'function')) throw new TypeError('public signaler capability');
    directoryId = identity.id; removeDirectory = directorySignaler.subscribe(envelope => { try { receive(envelope); } catch (cause) { status('public-directory-error', { reason: cause.message }); } });
  }
  async function discover() {
    status('public-discovering');
    try { await bounded(publish('*', 'discover'), remaining(), fail()); }
    catch (cause) { throw error('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message); }
    await wait(Math.min(discoveryMs, remaining()));
    // A positive relay OK after the observation window distinguishes an empty
    // healthy directory from a subscription that silently lost all relays.
    try { await bounded(publish('*', 'discover'), remaining(), fail()); }
    catch (cause) { throw error('PUBLIC_RELAY_UNAVAILABLE', 'public directory relay unavailable: ' + cause.message); }
    prune();
    const available = [...directory.values()].filter(lease => !lease.refreshAfter && lease.committed + lease.pending < maxPlayers)
      .sort((a, b) => b.committed - a.committed || a.sessionId.localeCompare(b.sessionId));
    if (!available.length && [...directory.values()].some(lease => lease.refreshAfter)) {
      throw error('PUBLIC_HANDOVER_PENDING', 'public room coordinator changed; waiting for a fresh lease after prior expiry');
    }
    return available;
  }
  async function reserve(lease) {
    const requestId = randomId(), expiresAt = Date.now() + Math.min(remaining(), reservationMs);
    let resolve, reject; const response = new Promise((yes, no) => { resolve = yes; reject = no; });
    reservationWaiter = { lease, requestId, resolve, reject }; response.catch(() => {});
    selected = { ...lease, requestId };
    const attemptMs = Math.min(remaining(), Math.max(250, discoveryMs * 2));
    try {
      await bounded(publish(lease.coordinatorId, 'reserve', { sessionId: lease.sessionId, epoch: lease.epoch, requestId, expiresAt }), attemptMs, error('PUBLIC_RESERVATION_TIMEOUT', 'public reservation timeout'));
      await bounded(response, attemptMs, error('PUBLIC_RESERVATION_TIMEOUT', 'public reservation timeout'));
    } finally { if (reservationWaiter?.requestId === requestId) reservationWaiter = null; }
  }
  async function release() {
    if (!selected?.requestId || disposed) return;
    const prior = selected; selected = null;
    try { await bounded(publish(prior.coordinatorId, 'release', { sessionId: prior.sessionId, epoch: prior.epoch, requestId: prior.requestId }), Math.min(remaining(), 1000), fail()); } catch {}
  }
  function savePointer(committed = false) {
    if (!resume || !room || resumeForgotten) return;
    if (room.players.includes(room.localPlayerId)) everAdmitted = true;
    if (committed && everAdmitted && !room.players.includes(room.localPlayerId)) { resumeForgotten = true; resume.storage.removeItem(pointerKey); return; }
    if (room.joining) return;
    storedUntil ??= startedWallAt + (resume.lifetimeMs ?? 8 * 60 * 60 * 1000);
    resume.storage.setItem(pointerKey, JSON.stringify({ version: 1, namespace, simulationVersion, room: room.room, sessionId: room.sessionId, expiresAt: storedUntil }));
  }
  async function connect(lease, restoring = false) {
    const code = lease?.room ?? randomRoom();
    let cancelled = false;
    const attemptController = new AbortController(), abortAttempt = () => attemptController.abort();
    controller.signal.addEventListener('abort', abortAttempt, { once: true });
    if (controller.signal.aborted) abortAttempt();
    const attemptTimeout = Math.max(1, Math.min(remaining(), restoring ? totalTimeoutMs : Math.max(discoveryMs * 2, dynamicOptions.peerTimeoutMs ?? 20000)));
    const pending = Promise.resolve().then(() => dynamicRoomFactory({ ...dynamicOptions, role: lease ? 'join' : 'host', room: code, namespace, maxPlayers,
      timeoutMs: attemptTimeout, relays, rtcConfig, resume: scopedResume(code), signal: attemptController.signal, onStatus,
      expectedSessionId: lease?.sessionId,
      authorizeJoin: id => { prune(); return !!room && room.coordinatorId === room.localPlayerId && reservations.has(id); },
      signalerFactory: async options => {
        const identity = options.identity ?? ephemeral.identity;
        await openDirectory(identity);
        if (attemptController.signal.aborted) throw error('PUBLIC_CLOSED', 'public attempt aborted');
        if (lease && !restoring) await reserve(lease);
        const value = await signalerFactory({ ...options, identity: shared(identity) });
        if (disposed) value?.close?.();
        return value;
      }
    })).then(result => { if (disposed || cancelled) result?.close?.(); return result; });
    let result;
    try { result = await bounded(pending, attemptTimeout, fail('public room connection attempt timeout')); }
    catch (cause) { cancelled = true; attemptController.abort(); controller.signal.removeEventListener('abort', abortAttempt); throw cause; }
    if (disposed) { result?.close?.(); throw fail(); }
    room = result;
    if (lease && room.sessionId !== lease.sessionId || room.localPlayerId !== directoryId) { room.close(); room = null; throw error('PUBLIC_SCOPE', 'public room identity/session mismatch'); }
    return room;
  }
  try {
    await openDirectory(ephemeral.identity);
    if (pointer) {
      status('public-resuming', { room: pointer.room });
      // DynamicRoom's stored roster and live-peer challenge decide resume. No
      // fresh world or identity is silently substituted when resume fails.
      await connect(pointer, true);
    } else {
      let lastError;
      const tried = new Set();
      for (let attempt = 0; attempt < maxAttempts && !room; attempt++) {
        const available = await discover(), lease = available.find(value => !tried.has(`${value.sessionId}:${value.epoch}`));
        if (!lease && available.length) { lastError ??= error('PUBLIC_NO_ROOM', 'available public rooms did not accept this connection'); break; }
        if (!lease) {
          status('public-hosting'); await connect(null); break;
        }
        tried.add(`${lease.sessionId}:${lease.epoch}`); status('public-joining', { room: lease.room, sessionId: lease.sessionId });
        try { await connect(lease); }
        catch (cause) { lastError = cause; await release(); await openDirectory(ephemeral.identity); status('public-attempt-failed', { reason: cause.message }); }
      }
      if (!room) throw lastError ?? fail();
    }
    savePointer();
    removeRoom = room.subscribe(event => {
      if (event.type === 'peer-failed' || event.type === 'peer-disconnected') { if (reservations.delete(event.peerId)) background(advertise()); }
      if (event.type === 'room-closed') close(event.reason);
    });
    await bounded(advertise(), remaining(), fail());
    clearTimeout(setupTimer);
    interval = setInterval(() => { if (disposed) return; prune(); if (Date.now() >= nextAdvertisement) {
      nextAdvertisement = Date.now() + Math.max(30, Math.floor(leaseMs / 3)); background(advertise());
    } }, Math.max(10, Math.min(1000, Math.floor(leaseMs / 3)))); interval.unref?.();
    const capability = {};
    for (const key of Object.keys(room)) Object.defineProperty(capability, key, { enumerable: true, configurable: true, get: () => room[key] });
    Object.defineProperties(capability, {
      close: { enumerable: true, configurable: true, value: close },
      setRoster: { enumerable: true, configurable: true, value(value) { room.setRoster(value); prune(); savePointer(true); background(advertise()); } },
      forgetResume: { enumerable: true, configurable: true, value() { resumeForgotten = true; room.forgetResume?.(); resume?.storage.removeItem(pointerKey); } },
      publicMetrics: { enumerable: true, get: () => ({ directoryEntries: directory.size, pendingReservations: reservations.size, pendingPublications: publications.size }) },
      subscribe: { enumerable: true, configurable: true, value(fn) { if (typeof fn !== 'function' || disposed) throw new TypeError('public room subscriber'); const remove = room.subscribe(fn); observers.add(fn); return () => { remove(); observers.delete(fn); }; } }
    });
    status('public-room-ready', { room: room.room, sessionId: room.sessionId });
    return capability;
  } catch (cause) { close(cause.message); throw cause; }
}
