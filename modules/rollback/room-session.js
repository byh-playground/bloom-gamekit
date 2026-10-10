import { createSession, createSessionFromBoundary, delegateRoomRecovery } from './core.js';
import { Availability, availabilityConfig } from './availability.js';
import { createBootstrapReplay } from './bootstrap.js';
import { profiles, CHUNK_SIZE, MAGIC } from '../_rollback-shared/protocol.js';
import { createValueCodec } from '../deterministic/value-codec.js';
import { bytes, compareIds, hashBytes, integer, nowMs } from '../deterministic/utilities.js';

const ROOM_MAGIC = 0x31524d44, WIRE_HEADER = 24, MAX_EPOCH = 65534;
const BRANCH_MAGIC = 0x32424d44, BRANCH_HEADER = 36;
const ordered = ids => [...ids].sort(compareIds);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idValid = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
/** A membership boundary composes fixed-roster lockstep sessions, never game worlds. */
export function createRoomSession(options) { return new RoomSession(options); }
export class RoomSession {
  constructor({ mode = 'local', room, localPlayerId = room?.localPlayerId ?? 'local', sessionId = room?.sessionId ?? 'local',
    simulationVersion, seed = 1, inputSize, profile = profiles.lockstep, adapter, membership = {}, clock = nowMs,
    onEvent = () => {}, availability = {}, roomOwnerId = room?.coordinatorId ?? localPlayerId } = {}) {
    if (!['local', 'online'].includes(mode) || !idValid(localPlayerId) || !idValid(sessionId)) throw new TypeError('room session identity/mode');
    integer(inputSize, 'inputSize', 1, 1024);
    if (!idValid(simulationVersion) || sessionId.length > 116) throw new TypeError('room simulationVersion/sessionId');
    if (mode === 'local' && room) throw new TypeError('local room cannot own online transport');
    if (profile.mode && profile.mode !== 'lockstep') throw new TypeError('dynamic membership requires lockstep');
    if (!adapter || ['step', 'save', 'load', 'validateSnapshot', 'applyMembership'].some(k => typeof adapter[k] !== 'function')) throw new TypeError('room simulation adapter');
    if (mode === 'online' && (!room || typeof room.subscribe !== 'function' || typeof room.connectMesh !== 'function' || typeof room.setRoster !== 'function')) throw new TypeError('dynamic room capability');
    if (typeof clock !== 'function' || typeof onEvent !== 'function') throw new TypeError('room session capability');
    this.mode = mode; this.room = room; this.localPlayerId = localPlayerId; this.sessionId = sessionId;
    this.simulationVersion = simulationVersion; this.seed = seed; this.inputSize = inputSize; this.adapter = adapter; this.clock = clock; this.onEvent = onEvent;
    this.membership = Object.freeze({ maxPlayers: 5, transitionTimeoutMs: 15000, reconnectGraceMs: 10000, joinRetryMs: 500, maxCatchupSteps: 4,
      maxTransferBytes: 8 * 1024 * 1024, maxControlMessagesPerPulse: 32, snapshotBudgetMs: 8, ...membership });
    for (const [k, v] of Object.entries(this.membership)) integer(v, k, 1, 0x7fffffff);
    integer(this.membership.maxCatchupSteps, 'maxCatchupSteps', 1, 8192);
    integer(this.membership.maxPlayers, 'maxPlayers', 1, 8); integer(this.membership.maxTransferBytes, 'maxTransferBytes', CHUNK_SIZE, 128 * 1024 * 1024);
    this.profile = Object.freeze({ ...profiles.lockstep, ...profile, mode: 'lockstep', adaptiveInputDelay: false });
    this.availability = availabilityConfig(availability); if (!idValid(roomOwnerId)) throw new TypeError('roomOwnerId'); this.roomOwnerId = roomOwnerId;
    this.codec = createValueCodec({ maxBytes: this.membership.maxTransferBytes, maxEntries: Math.min(this.membership.maxTransferBytes, 1000000), maxDepth: 32 });
    this.contract = hashBytes(this.codec.encode({ version: 1, simulationVersion, seed, inputSize, maxPlayers: this.membership.maxPlayers,
      tickRate: this.profile.tickRate, baseInputDelayTicks: this.profile.baseInputDelayTicks, checksumInterval: this.profile.checksumInterval,
      ...(this.availability.mode === 'available' ? { availability: this.availability } : {}) }));
    this.epoch = room?.epoch ?? 0; this.baseTick = 0; this.coordinatorId = room?.coordinatorId ?? localPlayerId;
    this.players = Object.freeze(ordered(mode === 'online' ? room.players : [localPlayerId]));
    this.activePlayers = this.players;
    this._availability = this.availability.mode === 'available' ? new Availability(this) : null;
    this.closed = false; this._failure = null; this._core = null; this._transition = null; this._links = new Map(); this._retirePeers = new Map(); this._admissionQueue = new Map(); this._incoming = []; this._incomingBytes = 0;
    this._lastInput = new Uint8Array(inputSize); this._pendingBeforeJoin = []; this._messageSequence = 0; this._joinSent = false;
    this._startedAt = clock(); this._interruptedAt = null; this._leavePromise = null; this._leaveResolve = null; this._leaveReject = null;
    this._stats = { transitions: 0, bootstrapBytes: 0, bootstrapTicks: 0, rejectedMessages: 0, sentControlBytes: 0, receivedControlBytes: 0, membershipPrepareMs: 0, membershipCommitMs: 0, bootstrapPrepareMs: 0, bootstrapPulseMs: 0, maxBoundaryTaskMs: 0, boundaryLongTasks: 0 };
    this._totals = { snapshotSaves: 0, serializedSnapshotBytes: 0, stateHashComputations: 0, hashedStateBytes: 0 };
    if (mode === 'local' || this.players.includes(localPlayerId) && !room?.resumed) {
      this.adapter.applyMembership({ epoch: this.epoch, tick: 0, players: [...this.players], joined: [...this.players], left: [], coordinatorId: this.coordinatorId, reason: 'initial' });
      this._startCore();
    }
    if (room) {
      this._unsubscribeRoom = room.subscribe(event => {
        if (this.closed || this.failure) return;
        if (event.type === 'peer-connected') this._attach(event.peerId, event.transport);
        if (event.type === 'peer-disconnected') {
          if (!this.players.includes(event.peerId) && !this._transition?.participants.includes(event.peerId)) {
            const link = this._links.get(event.peerId); link?.unsubscribe?.(); link?.detachCore?.(); this._links.delete(event.peerId);
          }
          this._event('peer-disconnected', { peerId: event.peerId, reason: event.reason });
        }
        if (event.type === 'room-failed') this._fail('transport-failed', { reason: event.reason });
      });
      for (const [id, transport] of room.transports) this._attach(id, transport);
    }
  }
  get tick() { return this.baseTick + (this._core?.tick ?? 0); }
  get confirmedTick() { return this._core ? this.baseTick + Math.min(this._core.tick - 1, this._core.confirmedTick) : this.baseTick - 1; }
  get inputDelay() { return this._core?.inputDelay ?? this.profile.baseInputDelayTicks; }
  /** Global tick metadata; command sequences retain their core-assigned values. */
  get localInputState() {
    const state = this._core?.localInputState;
    if (!state) return null;
    return { ...state, epoch: this.epoch, baseTick: this.baseTick, tick: this.tick, confirmedTick: this.confirmedTick,
      capture: state.capture ? { ...state.capture, captureTick: state.capture.captureTick + this.baseTick,
        executeTick: state.capture.executeTick + this.baseTick,
        commands: state.capture.commands.map(c => ({ ...c, executeTick: c.executeTick + this.baseTick })) } : null };
  }
  get failure() { return this._failure ?? this._core?.failure; }
  get ready() { return !this.closed && !this.failure && !this._availability?.round && !this._availability?.recovering && this._availability?.requested !== 'state-mismatch' && !this._transition && !!this._core?.ready; }
  get resimulating() { return !!this._availability?.round || this._transition?.proposal.reason === 'reconnect' || !!this._transition?.replay || !!this._core?.resimulating; }
  get pace() { return this._core?.pace ?? 1; }
  get status() {
    if (this.closed) return 'closed'; if (this.failure) return 'failed';
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === 'state-mismatch') return 'resynchronizing';
    if (!this.activePlayers.includes(this.localPlayerId) && this.players.includes(this.localPlayerId)) return 'suspended';
    if (this._transition?.replay) return 'catching-up';
    if (this._transition) return 'membership';
    return this._core?.status ?? 'joining';
  }
  get metrics() {
    const core = this._core?.metrics ?? {};
    const sums = Object.fromEntries(Object.entries(this._totals).map(([k, v]) => [k, v + (core[k] ?? 0)]));
    return { ...core, ...sums, ...this._stats, ...this._availability?.metrics, tick: this.tick, confirmedTick: this.confirmedTick, epoch: this.epoch,
      pendingAdmissions: this._admissionQueue.size, controlIncomingBytes: this._incomingBytes,
      controlQueuedBytes: [...this._links.values()].reduce((n, l) => n + l.queuedBytes, 0),
      controlReceivingBytes: [...this._links.values()].reduce((n, l) => n + (l.incoming?.bytes.length ?? 0), 0) };
  }
  getPeerState(id) { return this._core?.getPeerState(id); }
  getStateHash(tick = this.tick) { return this.resimulating ? undefined : this._core?.getStateHash(tick - this.baseTick); }
  _event(type, detail = {}) { try { this.onEvent({ type, tick: this.tick, epoch: this.epoch, ...detail }); } catch {} }
  _fail(type, detail = {}) {
    if (this.closed || this._failure) return;
    this._failure = Object.freeze({ type, ...detail });
    try { this._availability?.cancel(); } catch (error) { this._failure = Object.freeze({ type, ...detail, restoreError: error.message }); }
    try { this._transition?.replay?.cancel(); } catch {}
    try { this._transition?.stageJob?.cancel(); } catch {}
    if (this._transition) { this._transition.preparedState = null; this._transition.stageJob = null; }
    this._leaveReject?.(new Error(type)); this._leaveResolve = this._leaveReject = null;
    this._unsubscribeRoom?.(); for (const link of this._links.values()) { link.unsubscribe?.(); link.detachCore?.(); }
    this._links.clear(); this._incoming.length = 0; this._incomingBytes = 0; this.room?.close(); this._event(type, detail);
  }
  _adapter(baseTick = this.baseTick, epoch = this.epoch) {
    const a = this.adapter;
    const contextAt = (context = {}) => ({ ...context, tick: (context.tick ?? 0) + baseTick, membershipEpoch: epoch,
      ...(this._availability ? { players: [...this.players], activePlayers: context.players ?? [...this.activePlayers] } : {}) });
    return { save: () => a.save(), load: data => a.load(data),
      ...(typeof a.saveJob === 'function' ? { saveJob: () => a.saveJob() } : {}),
      ...(typeof a.prepareSnapshotJob === 'function' && typeof a.loadPreparedSnapshot === 'function' ? {
        prepareSnapshotJob: (data, context) => a.prepareSnapshotJob(data, contextAt(context)),
        loadPreparedSnapshot: (prepared, context) => a.loadPreparedSnapshot(prepared, contextAt(context)),
      } : {}),
      ...(typeof a.prepareSnapshot === 'function' && typeof a.loadPreparedSnapshot === 'function' ? {
        prepareSnapshot: (data, context) => a.prepareSnapshot(data, contextAt(context)),
        loadPreparedSnapshot: (prepared, context) => a.loadPreparedSnapshot(prepared, contextAt(context)),
      } : {}),
      validateSnapshot: (data, context = {}) => a.validateSnapshot(data, contextAt(context)),
      step: context => {
        // runSimulationFrame already supplies owned frame/command copies.
        context.tick += baseTick; context.membershipEpoch = epoch;
        for (const frame of context.inputs) for (const command of frame.commands) command.executeTick = context.tick;
        const start = this._availability ? nowMs() : 0;
        try { return a.step(context); }
        finally { if (this._availability && !context.resimulating) this._availability.measureStep(Math.max(0, nowMs() - start)); }
      } };
  }
  _startCore(commandState, commandSequences, boundary) {
    const options = { players: [...this.activePlayers], localPlayerId: this.localPlayerId, authorityPlayerId: this.coordinatorId,
      sessionId: this.sessionId + ':' + this.epoch, simulationVersion: this.simulationVersion, seed: this.seed, inputSize: this.inputSize,
      profile: this.profile, adapter: this._adapter(), localCommandState: commandState, initialCommandSequences: commandSequences ? Object.fromEntries(this.activePlayers.map(id => [id, commandSequences[id] ?? 0])) : undefined, clock: this.clock, recordReplay: false,
      onEvent: event => { if (event.type !== 'closed') this._event(event.type, { ...event, tick: event.tick + this.baseTick }); } };
    this._core = boundary ? createSessionFromBoundary(options, boundary.bytes, boundary.hash) : createSession(options);
    if (this._availability) delegateRoomRecovery(this._core, () => { this._availability.requested = 'state-mismatch'; });
    this.profile = this._core.profile;
    for (const [id, link] of this._links) this._attachCore(id, link);
    for (const payload of this._pendingBeforeJoin.splice(0)) this._core.queueCommand(payload);
  }
  _attachCore(id, link) {
    link.detachCore?.(); link.detachCore = null;
    if (!this._core || !this.activePlayers.includes(id) || id === this.localPlayerId) return;
    const epoch = this.epoch, session = this;
    link.detachCore = this._core.attachTransport(id, {
      get state() { return link.transport.state ?? 'open'; },
      send(data) {
        if (session.closed || epoch !== session.epoch) return false;
        const out = data.slice(); new DataView(out.buffer).setUint16(6, epoch + 1, true);
        if (!session._availability) return link.transport.send(out);
        const capacity = CHUNK_SIZE - BRANCH_HEADER, fragmented = out.length > capacity;
        for (let offset = 0; offset < out.length; offset += capacity) {
          const part = out.subarray(offset, offset + capacity), envelope = new Uint8Array(part.length + BRANCH_HEADER), view = new DataView(envelope.buffer);
          view.setUint32(0, BRANCH_MAGIC, true); envelope[4] = 1; envelope[5] = fragmented ? 1 : out[5];
          view.setUint32(8, new DataView(out.buffer).getUint32(8, true), true); view.setUint32(12, offset, true); view.setUint32(16, out.length, true);
          envelope.set(session._availability.wireBranch, 20); envelope.set(part, BRANCH_HEADER);
          if (link.transport.send(envelope) === false) return false;
        }
        return true;
      },
      subscribe(fn) { link.coreReceive = fn; return () => { if (link.coreReceive === fn) link.coreReceive = null; }; },
      subscribeStatus(fn) { return link.transport.subscribeStatus?.(fn) ?? (() => {}); }
    });
    for (const packet of link.future.splice(0)) this._receiveWire(id, link, packet);
  }
  _attach(id, transport) {
    if (!idValid(id) || id === this.localPlayerId || !transport?.send || !transport.subscribe) return;
    const old = this._links.get(id);
    if (old?.transport === transport) return;
    old?.unsubscribe?.(); old?.detachCore?.();
    const link = { transport, queue: [], queuedBytes: 0, incoming: null, coreReceive: null, future: [], detachCore: null, lastControlSerial: 0 };
    this._links.set(id, link);
    link.unsubscribe = transport.subscribe(data => { if (!this.closed && this._links.get(id) === link) this._receiveWire(id, link, data); });
    this._attachCore(id, link);
    // The retained Core performs a fresh handshake on a replacement transport.
    if (!this._core && id === this.coordinatorId) this._joinSent = false;
  }
  _boundaryFrozen() {
    if (this._availability?.round || this._availability?.recovering || this._availability?.requested === 'state-mismatch') return true;
    const tr = this._transition;
    return !!tr && (tr.proposal.reason === 'reconnect' || !!tr.stageJob || !!tr.preparedState || tr.applied || !!tr.replay);
  }
  _receiveWire(id, link, raw) {
    try {
      let data = bytes(raw);
      if (this._availability && data.length >= BRANCH_HEADER && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === BRANCH_MAGIC) {
        if (data.length > CHUNK_SIZE || data[4] !== 1 || this._availability.wireBranch.some((n, i) => data[20 + i] !== n)) return;
        const envelope = new DataView(data.buffer, data.byteOffset), serial = envelope.getUint32(8, true), offset = envelope.getUint32(12, true), total = envelope.getUint32(16, true);
        const part = data.subarray(BRANCH_HEADER);
        if (!total || total > CHUNK_SIZE || offset + part.length > total) throw new Error('branch wire capacity');
        if (!offset && total === part.length) data = part;
        else {
          if (!offset) link.branchIncoming = { serial, bytes: new Uint8Array(total), offset: 0, at: this.clock() };
          const pending = link.branchIncoming;
          if (!pending || pending.serial !== serial || pending.bytes.length !== total || offset !== pending.offset) return;
          pending.bytes.set(part, offset); pending.offset += part.length;
          if (pending.offset !== total) return;
          data = pending.bytes; link.branchIncoming = null;
        }
      } else if (this._availability && data.length >= 4 && new DataView(data.buffer, data.byteOffset).getUint32(0, true) === MAGIC) return;
      if (data.length < 12 || data.length > CHUNK_SIZE) throw new Error('room wire size');
      const view = new DataView(data.buffer, data.byteOffset, data.length), magic = view.getUint32(0, true);
      if (magic === MAGIC) {
        if (this._availability?.polled && this.clock() - this._availability.lastPoll > this.availability.resumeGapMs) {
          this._availability.recovering = true; this._availability.requested = 'resume';
        }
        const epoch = view.getUint16(6, true) - 1;
        if (epoch === this.epoch && link.coreReceive && !this._boundaryFrozen()) { const copy = data.slice(); new DataView(copy.buffer).setUint16(6, 0, true); link.coreReceive(copy); }
        else if (epoch === this.epoch + 1 && this._transition && link.future.length < 64) link.future.push(data.slice());
        return;
      }
      if (magic !== ROOM_MAGIC || data.length < WIRE_HEADER || data[4] !== 1 || data[5] !== 0) throw new Error('room wire protocol');
      const serial = view.getUint32(8, true), total = view.getUint32(12, true), offset = view.getUint32(16, true), digest = view.getUint32(20, true);
      if (this._availability && serial <= link.lastControlSerial) return;
      if (!total || total > this.membership.maxTransferBytes || offset + data.length - WIRE_HEADER > total) throw new Error('room wire capacity');
      if (offset === 0) {
        if (this._availability && serial <= link.lastControlSerial) return;
        if (link.incoming) throw new Error('overlapping room transfer');
        link.incoming = { serial, bytes: new Uint8Array(total), offset: 0, digest, startedAt: this.clock() };
      }
      const incoming = link.incoming;
      if (!incoming || incoming.serial !== serial || incoming.offset !== offset || incoming.digest !== digest || incoming.bytes.length !== total) throw new Error('room wire order');
      incoming.bytes.set(data.subarray(WIRE_HEADER), offset); incoming.offset += data.length - WIRE_HEADER;
      this._stats.receivedControlBytes += data.length;
      if (incoming.offset === total) {
        link.incoming = null; if (hashBytes(incoming.bytes) !== digest) throw new Error('room wire digest');
        link.lastControlSerial = serial;
        const value = this.codec.decode(incoming.bytes);
        // A frozen browser can deliver many heartbeat tasks before its first poll.
        // Keep one newest observation per sender, within the same queue budget.
        if (this._availability && value?.op === 'availability-activity') {
          const previous = this._incoming.findIndex(m => m.from === id && m.value?.op === value.op);
          if (previous >= 0) { this._incomingBytes -= this._incoming[previous].size; this._incoming.splice(previous, 1); }
        }
        if (this._incoming.length >= 128 || this._incomingBytes + total > this.membership.maxTransferBytes * 2) throw new Error('room control backlog');
        this._incoming.push({ from: id, value, size: total }); this._incomingBytes += total;
      }
    } catch (error) { link.incoming = null; this._stats.rejectedMessages++; if (this.players.includes(id)) this._fail('room-protocol-error', { peerId: id, reason: error.message }); }
  }
  _send(to, op, detail = {}) {
    if (to === this.localPlayerId) { this._incoming.push({ from: to, value: { op, sessionId: this.sessionId, contract: this.contract, ...detail } }); return; }
    const link = this._links.get(to); if (!link) throw new Error('room peer unavailable: ' + to);
    const body = this.codec.encode({ op, sessionId: this.sessionId, contract: this.contract, ...detail });
    const chunks = Math.ceil(body.length / (CHUNK_SIZE - WIRE_HEADER)), budget = body.length + chunks * WIRE_HEADER;
    if (link.queuedBytes + budget > this.membership.maxTransferBytes * 2) throw new Error('room send queue capacity');
    const serial = ++this._messageSequence >>> 0, digest = hashBytes(body);
    for (let offset = 0; offset < body.length; offset += CHUNK_SIZE - WIRE_HEADER) {
      const slice = body.subarray(offset, offset + CHUNK_SIZE - WIRE_HEADER), packet = new Uint8Array(WIRE_HEADER + slice.length), view = new DataView(packet.buffer);
      view.setUint32(0, ROOM_MAGIC, true); packet[4] = 1; view.setUint32(8, serial, true); view.setUint32(12, body.length, true);
      view.setUint32(16, offset, true); view.setUint32(20, digest, true); packet.set(slice, WIRE_HEADER);
      link.queue.push(packet); link.queuedBytes += packet.length;
    }
  }
  _broadcast(ids, op, detail = {}) { for (const id of ids) this._send(id, op, detail); }
  _flush() {
    for (const link of this._links.values()) {
      let count = 0;
      while (link.queue.length && count++ < 16) {
        const data = link.queue[0]; if (link.transport.send(data) === false) break;
        link.queue.shift(); link.queuedBytes -= data.length; this._stats.sentControlBytes += data.length;
      }
    }
  }
  _proposal(joined, left, reason, resumingId = null) {
    if (this._transition || this._availability?.round || this.localPlayerId !== this.coordinatorId) throw new Error('membership coordinator busy');
    if (left.includes(this.localPlayerId)) {
      for (const id of this._admissionQueue.keys()) this._send(id, 'reject', { reason: 'coordinator-changing' });
      this._admissionQueue.clear();
    }
    if (this.epoch >= MAX_EPOCH) throw new Error('room epoch exhausted');
    const players = ordered([...this.players.filter(id => !left.includes(id)), ...joined]);
    if (!players.length) { this.close(); return; }
    if (players.length > this.membership.maxPlayers || new Set(players).size !== players.length) throw new Error('room capacity');
    const proposal = { epoch: this.epoch + 1, oldPlayers: [...this.players], players, joined, left, reason, resumingId,
      coordinatorId: players.includes(this.coordinatorId) ? this.coordinatorId : players[0] };
    for (const id of joined) this._send(id, 'welcome', { epoch: this.epoch, players: [...this.players] });
    this._acceptProposal(this.localPlayerId, proposal);
    const tr = this._transition;
    Promise.resolve(this.room?.connectMesh(tr.participants)).then(() => {
      if (this.closed || this.failure || this._transition !== tr) return;
      for (const [id, transport] of this.room?.transports ?? []) this._attach(id, transport);
      this._broadcast(tr.participants.filter(id => id !== this.localPlayerId), 'propose', { proposal });
    }).catch(error => this._fail('membership-connect-failed', { reason: error.message }));
  }
  _acceptProposal(from, proposal) {
    if (from !== this.coordinatorId || this._transition || !proposal || proposal.epoch !== this.epoch + 1 || proposal.epoch > MAX_EPOCH) throw new Error('membership proposal authority/epoch');
    if (!Array.isArray(proposal.oldPlayers) || !Array.isArray(proposal.players) || !Array.isArray(proposal.joined) || !Array.isArray(proposal.left)) throw new Error('membership roster shape');
    if (!['join', 'leave', 'reconnect'].includes(proposal.reason) || proposal.reason === 'reconnect' && (!proposal.oldPlayers.includes(proposal.resumingId) || proposal.joined.length || proposal.left.length)) throw new Error('membership reason');
    if (!same(proposal.oldPlayers, this.players) || !same(ordered(proposal.players), proposal.players) ||
      !proposal.players.length || proposal.players.length > this.membership.maxPlayers || new Set(proposal.players).size !== proposal.players.length ||
      proposal.players.some(id => !idValid(id)) || !proposal.players.includes(proposal.coordinatorId) ||
      !same(ordered([...proposal.oldPlayers.filter(id => !proposal.left.includes(id)), ...proposal.joined]), proposal.players) ||
      proposal.joined.some(id => proposal.oldPlayers.includes(id)) || proposal.left.some(id => !proposal.oldPlayers.includes(id))) throw new Error('membership roster mismatch');
    proposal = Object.freeze({ ...proposal, oldPlayers: Object.freeze([...proposal.oldPlayers]), players: Object.freeze([...proposal.players]), joined: Object.freeze([...proposal.joined]), left: Object.freeze([...proposal.left]) });
    const participants = ordered([...new Set([...proposal.oldPlayers, ...proposal.joined])]);
    if (!participants.includes(this.localPlayerId)) throw new Error('membership local participant');
    const tr = this._transition = { proposal, participants, startedAt: this.clock(), prepared: new Map(), reached: new Map(), installed: new Map(),
      target: null, reachedSent: false, installSent: false, applied: false, replay: null, commitSent: false, committed: new Set() };
    this._event('membership-preparing', { proposal });
    Promise.resolve(this.room?.connectMesh(participants)).then(() => {
      if (this.closed || this.failure || this._transition !== tr) return;
      for (const [id, transport] of this.room?.transports ?? []) this._attach(id, transport);
      this._send(from, 'prepared', { epoch: proposal.epoch, tick: this._core ? this.tick : -1 });
    }).catch(error => this._fail('membership-connect-failed', { reason: error.message }));
  }
  _handle(from, m) {
    if (this._availability && m?.op?.startsWith('availability-') && m.sessionId === this.sessionId && m.contract === this.contract) {
      if (this._transition && !this._transition.availability) return;
      this._availability.handle(from, m, this.clock()); return;
    }
    const participant = this.players.includes(from) || this._transition?.participants.includes(from);
    if (!participant && m?.op !== 'join') { this._stats.rejectedMessages++; return; }
    if (['propose', 'barrier', 'install', 'bootstrap', 'resume-install', 'commit', 'reject', 'leave-busy', 'welcome'].includes(m?.op) && from !== this.coordinatorId) { this._stats.rejectedMessages++; return; }
    if (!m || m.sessionId !== this.sessionId || m.contract !== this.contract) { this._stats.rejectedMessages++; if (m?.op === 'join') this._send(from, 'reject', { reason: 'incompatible-session' }); return; }
    if (m.op === 'welcome' && from === this.coordinatorId && !this._core && !this.room?.resumed && !this._transition) {
      if (!Number.isInteger(m.epoch) || m.epoch < this.epoch || m.epoch > MAX_EPOCH || !Array.isArray(m.players) || m.players.length < 1 || m.players.length >= this.membership.maxPlayers || m.players.includes(this.localPlayerId) || !m.players.includes(from) || m.players.some(id => !idValid(id)) || new Set(m.players).size !== m.players.length || !same(ordered(m.players), m.players)) return;
      this.epoch = m.epoch; this.players = Object.freeze([...m.players]); this.activePlayers = this.players; this.room?.setRoster({ epoch: this.epoch, players: [...this.players], coordinatorId: this.coordinatorId }); return;
    }
    if (m.op === 'retire' && this._departing && from === this.coordinatorId && m.epoch === this.epoch) { this._retireApproved = true; return; }
    if (m.op === 'reject' && from === this.coordinatorId && !this._core) { this._fail('join-rejected', { reason: m.reason }); return; }
    if (m.op === 'join' && this.localPlayerId === this.coordinatorId) {
      if (this.players.includes(from)) {
        if (m.resume === true && !this._transition) this._proposal([], [], 'reconnect', from);
        return;
      }
      if (this._transition?.participants.includes(from)) return;
      if (this._availability && this.activePlayers.length !== this.players.length) { this._send(from, 'reject', { reason: 'suspended-members' }); return; }
      if (this._admissionQueue.has(from)) return;
      const expectedCount = this._transition?.proposal.players.length ?? this.players.length;
      if (expectedCount + this._admissionQueue.size >= this.membership.maxPlayers) { this._send(from, 'reject', { reason: 'room-full' }); return; }
      this._admissionQueue.set(from, this.clock()); return;
    }
    if (m.op === 'leave-request' && this.localPlayerId === this.coordinatorId && this.players.includes(from)) {
      if (!this._transition && !this._availability?.round) this._proposal([], [from], 'leave'); else this._send(from, 'leave-busy'); return;
    }
    if (m.op === 'leave-busy' && from === this.coordinatorId) { this._leaveReject?.(new Error('membership busy')); this._leavePromise = this._leaveResolve = this._leaveReject = null; return; }
    if (m.op === 'propose') { this._acceptProposal(from, m.proposal); return; }
    const tr = this._transition;
    if (!tr || m.epoch !== tr.proposal.epoch || !tr.participants.includes(from)) return;
    const leader = this.coordinatorId === this.localPlayerId;
    if (m.op === 'prepared' && leader) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 0x7ffffffe || (tr.proposal.oldPlayers.includes(from) && tr.proposal.resumingId !== from ? m.tick < this.baseTick : m.tick !== -1)) throw new Error('membership prepared tick');
      tr.prepared.set(from, m.tick);
      if (tr.prepared.size === tr.participants.length && tr.target === null) {
        const target = Math.max(...tr.prepared.values()), minimum = Math.min(...[...tr.prepared.values()].filter(tick => tick >= 0));
        if (target - minimum > this.profile.stateHistorySize - this.profile.checksumInterval) throw new Error('resume boundary exceeds retained history');
        const donor = [...tr.prepared].filter(([, tick]) => tick === target).map(([id]) => id).sort(compareIds)[0];
        this._broadcast(tr.participants, 'barrier', { epoch: m.epoch, tick: target, minimum, donor });
      }
    } else if (m.op === 'barrier' && from === this.coordinatorId && tr.target === null) {
      if (!Number.isSafeInteger(m.tick) || m.tick > 0x7ffffffe || m.tick < this.tick || this._core && m.tick - this.tick > this.profile.stateHistorySize) throw new Error('membership barrier window');
      tr.target = m.tick;
      if (tr.proposal.reason === 'reconnect') {
        tr.donor = m.donor;
        if (!tr.proposal.oldPlayers.includes(tr.donor) || tr.donor === tr.proposal.resumingId) throw new Error('invalid resume donor');
        if (this.localPlayerId === tr.donor) this._send(this.coordinatorId, 'resume-source', { epoch: m.epoch, baseTick: this.baseTick, bootstrap: this._core.exportConfirmedBootstrap({ checkpointAtOrBefore: m.minimum - this.baseTick }) });
      }
    } else if (m.op === 'reached' && leader && tr.proposal.oldPlayers.includes(from)) {
      if (m.tick !== tr.target || !Number.isInteger(m.hash)) throw new Error('membership checkpoint boundary');
      tr.reached.set(from, m.hash);
      if (tr.reached.size === tr.proposal.oldPlayers.length && !tr.installSent) {
        if (new Set(tr.reached.values()).size !== 1) throw new Error('membership checkpoint mismatch');
        tr.installSent = true;
        const bootstrap = tr.proposal.joined.length ? this._core.exportConfirmedBootstrap() : null;
        for (const id of tr.participants) {
          if (tr.proposal.joined.includes(id)) { this._send(id, 'bootstrap', { epoch: m.epoch, baseTick: this.baseTick, bootstrap, target: tr.target }); this._stats.bootstrapBytes += bootstrap.checkpoint.bytes.length; }
          else this._send(id, 'install', { epoch: m.epoch, tick: tr.target });
        }
      }
    } else if (m.op === 'resume-source' && leader && from === tr.donor && tr.proposal.reason === 'reconnect' && !tr.installSent) {
      if (m.bootstrap.tick + m.baseTick !== tr.target) throw new Error('resume donor boundary');
      tr.installSent = true; this._broadcast(tr.participants, 'resume-install', { epoch: m.epoch, baseTick: m.baseTick, bootstrap: m.bootstrap, target: tr.target });
    } else if (m.op === 'resume-install' && from === this.coordinatorId && tr.proposal.reason === 'reconnect' && !tr.replay && !tr.stageJob && !tr.preparedState && !tr.applied) {
      this._beginBootstrap(tr, m);
    } else if (m.op === 'bootstrap' && from === this.coordinatorId && !this._core && !tr.replay && !tr.stageJob && !tr.preparedState && !tr.applied) {
      this._beginBootstrap(tr, m);
    } else if (m.op === 'install' && from === this.coordinatorId && this._core && !tr.applied) {
      if (m.tick !== tr.target || this.tick !== tr.target) throw new Error('membership installation boundary');
      this._applyMembership(tr);
    } else if (m.op === 'installed' && leader) {
      if (!Number.isInteger(m.hash)) throw new Error('membership installed hash');
      tr.installed.set(from, m.hash);
      if (tr.installed.size === tr.participants.length && !tr.commitSent) {
        if (new Set(tr.installed.values()).size !== 1) throw new Error('membership state mismatch');
        tr.commitSent = true; this._broadcast(tr.participants.filter(id => id !== this.localPlayerId), 'commit', { epoch: m.epoch, hash: m.hash });
        // Commit locally only after every reliable control queue accepted the commit bytes.
      }
    } else if (m.op === 'commit' && from === this.coordinatorId) {
      if (!tr.applied || tr.postHash !== m.hash) throw new Error('membership commit without matching preparation');
      this._send(this.coordinatorId, 'committed', { epoch: m.epoch, hash: tr.postHash });
      this._commit(tr);
    } else if (m.op === 'committed' && leader && tr.commitSent && m.hash === tr.postHash) {
      tr.committed.add(from);
    }
  }
  _beginBootstrap(tr, m) { return this._boundaryWork('bootstrapPrepareMs', () => this._prepareBootstrap(tr, m)); }
  _prepareBootstrap(tr, m) {
    if (m.target !== tr.target || m.bootstrap.tick + m.baseTick !== tr.target || !Number.isSafeInteger(m.baseTick) || m.baseTick < 0 || this._core && m.baseTick !== this.baseTick) throw new Error('bootstrap epoch boundary');
    if (!this._core) this.baseTick = m.baseTick;
    if (this._core && tr.proposal.reason === 'reconnect') this._core.verifyConfirmedBootstrap(m.bootstrap);
    tr.commandSequences = m.bootstrap.commandSequences;
    tr.replay = createBootstrapReplay({ adapter: this._adapter(m.baseTick, this.epoch), bootstrap: m.bootstrap,
      maxCatchupSteps: this.membership.maxCatchupSteps, maxCatchupMs: this.membership.snapshotBudgetMs, maxSnapshotBytes: this.profile.maxSnapshotBytes,
      maxSuffixTicks: tr.proposal.reason === 'reconnect' ? this.profile.stateHistorySize : this.profile.checksumInterval, maxCommandBytes: this.profile.maxCommandBytes, maxPendingCommands: this.profile.maxPendingCommands,
      maxReplayBytes: this.membership.maxTransferBytes, simulationVersion: this.simulationVersion, inputSize: this.inputSize,
      tickRate: this.profile.tickRate, seed: this.seed, players: [...this.players] });
    this._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length;
  }
  _membershipContext(tr) {
    return { tick: tr.target, membershipEpoch: tr.proposal.epoch, simulationVersion: this.simulationVersion,
      tickRate: this.profile.tickRate, seed: this.seed, players: [...tr.proposal.players],
      ...(tr.proposal.activePlayers ? { activePlayers: [...tr.proposal.activePlayers] } : {}) };
  }
  _boundaryWork(name, work) {
    const started = nowMs();
    try { return work(); }
    finally {
      const elapsed = Math.max(0, nowMs() - started);
      this._stats[name] = elapsed;
      this._stats.maxBoundaryTaskMs = Math.max(this._stats.maxBoundaryTaskMs, elapsed);
      if (elapsed > 50) this._stats.boundaryLongTasks++;
    }
  }
  _applyMembership(tr) { return this._boundaryWork('membershipPrepareMs', () => this._prepareMembership(tr)); }
  _prepareMembership(tr) {
    if (tr.stageJob || tr.preparedState || tr.applied) return;
    if (typeof this.adapter.prepareMembershipJob === 'function' && typeof this.adapter.loadPreparedSnapshot === 'function') {
      tr.stageJob = this.adapter.prepareMembershipJob({ ...tr.proposal, tick: tr.target }, this._membershipContext(tr));
      if (!tr.stageJob || typeof tr.stageJob.pulse !== 'function' || typeof tr.stageJob.cancel !== 'function') throw new TypeError('membership preparation job');
      return;
    }
    if (typeof this.adapter.prepareMembership === 'function' && typeof this.adapter.loadPreparedSnapshot === 'function') {
      const context = this._membershipContext(tr);
      // The optional adapter capability validates a detached, canonical branch.
      // Live state remains unchanged until the coordinator commits this epoch.
      const staged = this.adapter.prepareMembership({ ...tr.proposal, tick: tr.target }, context);
      this._acceptPreparedMembership(tr, staged);
      return;
    }
    const rollback = bytes(this.adapter.save()).slice();
    try {
      this.adapter.applyMembership({ ...tr.proposal, tick: tr.target });
      const state = bytes(this.adapter.save());
      if (state.length > this.profile.maxSnapshotBytes || !this.adapter.validateSnapshot(state, { tick: tr.target, membershipEpoch: tr.proposal.epoch })) throw new Error('invalid membership snapshot');
      tr.postHash = hashBytes(state); tr.postState = state.slice(); this.adapter.load(rollback); tr.applied = true;
      this._installed(tr);
    } catch (error) { this.adapter.load(rollback); throw error; }
  }
  _acceptPreparedMembership(tr, staged, deferHash = false) {
    const state = bytes(staged?.bytes, 'prepared membership snapshot').slice();
    if (!state.length || state.length > this.profile.maxSnapshotBytes || !staged.prepared) throw new Error('invalid prepared membership snapshot');
    tr.postState = state; tr.preparedState = staged.prepared;
    if (deferHash) { tr.postHash = 2166136261; tr.hashOffset = 0; return; }
    tr.postHash = hashBytes(state); tr.applied = true;
    this._installed(tr);
  }
  _installed(tr) {
    if (tr.availability) this._availability.installed(tr.postHash);
    else this._send(this.coordinatorId, 'installed', { epoch: tr.proposal.epoch, hash: tr.postHash });
  }
  _commit(tr) { return this._boundaryWork('membershipCommitMs', () => this._commitMembership(tr)); }
  _commitMembership(tr) {
    const previousCoordinator = this.coordinatorId;
    const commandSequences = tr.commandSequences ?? this._core?.getCommandSequences?.();
    let commandState = !tr.discardCommands ? this._core?.exportLocalCommandState() : undefined;
    commandState ??= commandSequences ? { sequence: commandSequences[this.localPlayerId] ?? 0, lastInput: new Uint8Array(this.inputSize), commands: [] } : undefined;
    if (commandState && commandSequences) {
      const baseline = commandSequences[this.localPlayerId] ?? 0;
      commandState = { ...commandState, sequence: Math.max(commandState.sequence, baseline), commands: commandState.commands.filter(command => command.sequence > baseline) };
    }
    if (tr.preparedState) {
      const prepared = tr.preparedState; tr.preparedState = null;
      this.adapter.loadPreparedSnapshot(prepared, this._membershipContext(tr));
    } else this.adapter.load(tr.postState.slice());
    if (this._core) {
      const metrics = this._core.metrics;
      for (const k of Object.keys(this._totals)) this._totals[k] += metrics[k] ?? 0;
      this._core.close(); this._core = null;
    }
    this.epoch = tr.proposal.epoch; this.baseTick = tr.target; this.players = Object.freeze([...tr.proposal.players]); this.coordinatorId = tr.proposal.coordinatorId;
    this.activePlayers = Object.freeze([...(tr.proposal.activePlayers ?? tr.proposal.players)]);
    if (this._availability) for (const id of this._availability.peers.keys()) if (!this.players.includes(id)) { this._availability.peers.delete(id); this._availability.states.delete(id); }
    if (this._availability && !tr.availability) { this._availability.tenureAt = this.clock(); this._availability.anchorId = this.coordinatorId; }
    this._transition = null; this._interruptedAt = null; this._stats.transitions++;
    this._retireAfter = this.clock() + this.membership.transitionTimeoutMs;
    for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._retirePeers.set(id, this._retireAfter);
    for (const id of this.players) this._retirePeers.delete(id);
    this.room?.setRoster({ epoch: this.epoch, players: [...this.players], coordinatorId: this.coordinatorId,
      ...(this._availability ? { allowBranchReconnect: true } : {}) });
    this._event('membership-committed', { ...tr.proposal, tick: tr.target });
    if (!this.players.includes(this.localPlayerId)) { this._departing = true; this._retireApproved = previousCoordinator === this.localPlayerId; return; }
    if (!this.activePlayers.includes(this.localPlayerId)) {
      this._suspendedBootstrap = { version: 1, tick: 0, checkpoint: { tick: 0, bytes: tr.postState.slice(), hash: tr.postHash },
        players: [...this.activePlayers], frames: [], hash: tr.postHash, inputSize: this.inputSize, tickRate: this.profile.tickRate,
        simulationVersion: this.simulationVersion, seed: this.seed, commandSequences: Object.fromEntries(this.activePlayers.map(id => [id, commandSequences?.[id] ?? 0])) };
      return;
    }
    this._suspendedBootstrap = null;
    this._startCore(commandState, commandSequences, { bytes: tr.postState, hash: tr.postHash });
  }
  poll(now = this.clock()) {
    if (this.closed || this.failure) return;
    if (this._departing) {
      while (this._incoming.length) { const message = this._incoming.shift(); this._incomingBytes -= message.size ?? 0; if (message.value?.op === 'retire') this._handle(message.from, message.value); }
      this._flush();
      if (now >= this._retireAfter && !this._retireApproved) { this._fail('departure-timeout'); return; }
      if (this._retireApproved && [...this._links.values()].every(link => !link.queue.length)) { this._leaveResolve?.(); this._leaveResolve = this._leaveReject = null; this.close(); }
      return;
    }
    try {
      this._availability?.poll(now);
      if (!this._core && !this._transition && !(this._availability && this.room?.resumed) && (!this._joinSent || now - this._lastJoinAt >= this.membership.joinRetryMs)) {
        if (this.room?.resumed && this.localPlayerId === this.coordinatorId && this._links.size) { this._joinSent = true; this._proposal([], [], 'reconnect', this.localPlayerId); }
        else if (this._links.has(this.coordinatorId)) { this._send(this.coordinatorId, 'join', { resume: !!this.room?.resumed }); this._joinSent = true; this._lastJoinAt = now; }
      }
      let count = 0;
      while (this._incoming.length && count++ < this.membership.maxControlMessagesPerPulse && !this.failure && !this.closed) {
        const message = this._incoming.shift(); this._incomingBytes -= message.size ?? 0; this._handle(message.from, message.value);
      }
      if (this._core && !this._transition && !this._availability?.round && this.coordinatorId === this.localPlayerId && this.activePlayers.length === this.players.length) {
        for (const [id, requestedAt] of this._admissionQueue) {
          const link = this._links.get(id);
          if (!link || now - requestedAt >= this.membership.transitionTimeoutMs) {
            if (link) this._send(id, 'reject', { reason: 'admission-expired' }); this._admissionQueue.delete(id); continue;
          }
          this._admissionQueue.delete(id); this._proposal([id], [], 'join'); break;
        }
      }
      const tr = this._transition;
      if (tr && !tr.availability) {
        if (now - tr.startedAt >= this.membership.transitionTimeoutMs) throw new Error('membership deadline exceeded');
        if (tr.preparedState && !tr.applied) {
          this._boundaryWork('membershipPrepareMs', () => {
            const started = nowMs();
            do {
              const end = Math.min(tr.postState.length, tr.hashOffset + 65536);
              tr.postHash = hashBytes(tr.postState.subarray(tr.hashOffset, end), tr.postHash); tr.hashOffset = end;
            } while (tr.hashOffset < tr.postState.length && nowMs() - started < this.membership.snapshotBudgetMs);
            if (tr.hashOffset === tr.postState.length) { tr.applied = true; this._installed(tr); }
          });
        }
        if (tr.stageJob) {
          this._boundaryWork('membershipPrepareMs', () => {
            tr.stageJob.pulse({ budgetMs: this.membership.snapshotBudgetMs });
            if (tr.stageJob.done) { const staged = tr.stageJob.result; tr.stageJob = null; this._acceptPreparedMembership(tr, staged, true); }
          });
        }
        if (tr.replay) {
          const result = this._boundaryWork('bootstrapPulseMs', () => tr.replay.pulse()); this._stats.bootstrapTicks += result.steps ?? 0;
          if (tr.replay.done) { tr.replay = null; this._applyMembership(tr); }
        }
        if (this._core && tr.proposal.reason !== 'reconnect' && tr.target !== null && this.tick === tr.target && !tr.reachedSent) {
          tr.reachedSent = true; this._send(this.coordinatorId, 'reached', { epoch: tr.proposal.epoch, tick: this.tick, hash: this._core.getStateHash() });
        }
      } else if (!this._core && !this._suspendedBootstrap && now - this._startedAt >= this.membership.transitionTimeoutMs) throw new Error('join deadline exceeded');
      if (tr?.availability && tr.stageJob) {
        tr.stageJob.pulse({ budgetMs: this.membership.snapshotBudgetMs });
        if (tr.stageJob.done) { const staged = tr.stageJob.result; tr.stageJob = null; this._acceptPreparedMembership(tr, staged); }
      }
      for (const [id, link] of this._links) if (link.incoming && now - link.incoming.startedAt >= this.membership.transitionTimeoutMs) throw new Error('room transfer timeout: ' + id);
      for (const link of this._links.values()) if (link.branchIncoming && now - link.branchIncoming.at >= this.membership.transitionTimeoutMs) link.branchIncoming = null;
      if (!this._boundaryFrozen()) this._core?.poll(now);
      if (this._core && !tr && !this._availability) {
        if (['interrupted', 'disconnected'].includes(this._core.status)) {
          this._interruptedAt ??= now;
          if (now - this._interruptedAt >= this.membership.reconnectGraceMs) this._fail('partition-failed', { policy: 'fail-closed', coordinatorId: this.coordinatorId });
        } else this._interruptedAt = null;
      }
      this._flush();
      for (const [id, deadline] of this._retirePeers) {
        const link = this._links.get(id); if (link && !['closed', 'failed'].includes(link.transport.state) && now < deadline) continue;
        link?.unsubscribe?.(); link?.detachCore?.(); this._links.delete(id); this.room?.disconnect?.(id); this._retirePeers.delete(id);
      }
      if (tr && !tr.availability && tr.commitSent && tr.applied && tr.committed.size === tr.participants.length - 1 && [...this._links.values()].every(link => !link.queue.length)) {
        for (const id of tr.proposal.left) if (id !== this.localPlayerId) this._send(id, 'retire', { epoch: tr.proposal.epoch });
        this._commit(tr);
      }
    } catch (error) { this._fail('membership-failed', { reason: error.message }); }
  }
  advance(input = this._lastInput) {
    if (this.closed) throw new Error('room session closed');
    const sample = bytes(input); if (sample.length !== this.inputSize) throw new RangeError('inputSize'); this._lastInput = sample.slice();
    if (this._availability) { this._availability.lastAdvance = this.clock(); if (!this.activePlayers.includes(this.localPlayerId)) { this._availability.recovering = true; this._availability.requested = 'resume'; } }
    this.poll();
    if (this.failure) return { status: 'failed', tick: this.tick, failure: this.failure };
    const tr = this._transition;
    if (!this._core || this._availability?.round || this._availability?.recovering || this._availability?.requested === 'state-mismatch' || tr && (tr.proposal.reason === 'reconnect' || tr.target === null || this.tick >= tr.target)) return { status: this.status, tick: this.tick };
    const result = this._core.advance(sample); return { ...result, tick: this.tick };
  }
  queueCommand(payload) {
    if (this.closed || this.failure) throw new Error('room session unavailable');
    if (!this._core) throw new Error('player not admitted');
    return this._core.queueCommand(payload);
  }
  releaseInput() { this._lastInput = new Uint8Array(this.inputSize); this._core?.releaseInput(); }
  leave() {
    if (this.closed) return Promise.resolve(); if (this.failure) return Promise.reject(new Error('room session failed'));
    if (this._leavePromise) return this._leavePromise;
    if (!this._core || this.players.length === 1) { this.close(); return Promise.resolve(); }
    this._leavePromise = new Promise((resolve, reject) => { this._leaveResolve = resolve; this._leaveReject = reject; });
    try { this._send(this.coordinatorId, 'leave-request'); } catch (error) { this._leaveReject(error); }
    return this._leavePromise;
  }
  close() {
    if (this.closed) return; this._availability?.cancel(); this.closed = true; this._core?.close(); try { this._transition?.replay?.cancel(); } catch {}
    try { this._transition?.stageJob?.cancel(); } catch {}
    if (this._transition) { this._transition.preparedState = null; this._transition.stageJob = null; }
    this._unsubscribeRoom?.(); for (const link of this._links.values()) { link.unsubscribe?.(); link.detachCore?.(); }
    this._links.clear(); this._incoming.length = 0; this.room?.close(); this._event('closed');
    this._leaveReject?.(new Error('room closed before graceful departure')); this._leaveResolve = this._leaveReject = null;
  }
}
