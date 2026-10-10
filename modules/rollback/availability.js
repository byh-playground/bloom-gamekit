import { bytes, compareIds, integer } from '../deterministic/utilities.js';
import { createBootstrapReplay } from './bootstrap.js';

const sorted = ids => [...ids].sort(compareIds);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
const branchValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function availabilityConfig(value = {}) {
  const config = { mode: 'strict', heartbeatMs: 250, silenceMs: 3000, inputGraceMs: 3000, resumeGapMs: 3000,
    roundTimeoutMs: 5000, retryMs: 500, ...value };
  if (!['strict', 'available'].includes(config.mode)) throw new TypeError('availability mode');
  config.autoTransfer = Object.freeze({ enabled: false, intervalMs: 10000, minTenureMs: 30000,
    minImprovementMs: 10, minSamples: 10, rttWeight: 1, jitterWeight: 2, stepWeight: 4, stepEmaAlpha: .1, ...value.autoTransfer });
  for (const key of ['heartbeatMs', 'silenceMs', 'inputGraceMs', 'resumeGapMs', 'roundTimeoutMs', 'retryMs']) integer(config[key], key, 1);
  if (config.silenceMs < config.heartbeatMs * 2 || config.inputGraceMs < config.heartbeatMs * 2) throw new RangeError('availability grace must cover two heartbeats');
  if (typeof config.autoTransfer.enabled !== 'boolean') throw new TypeError('autoTransfer enabled');
  for (const [key, n] of Object.entries(config.autoTransfer)) if (key !== 'enabled') {
    if (!Number.isFinite(n) || n < 0 || ['intervalMs', 'minTenureMs', 'minSamples'].includes(key) && (!Number.isSafeInteger(n) || n < 1)) throw new RangeError('autoTransfer ' + key);
  }
  if (config.autoTransfer.stepEmaAlpha <= 0 || config.autoTransfer.stepEmaAlpha > 1) throw new RangeError('autoTransfer stepEmaAlpha');
  return Object.freeze(config);
}

/** Availability boundaries replace fixed-roster Cores; no predicted input is invented. */
export class Availability {
  constructor(session) {
    this.session = session; this.config = session.availability; this.peers = new Map(); this.round = null;
    this.branch = '0'.repeat(32); this.wireBranch = new Uint8Array(16); this.anchorId = session.coordinatorId; this.recovering = !!session.room?.resumed;
    this.lastPoll = session.clock(); this.lastAdvance = this.lastPoll; this.lastHeartbeat = -Infinity;
    this.tenureAt = this.lastPoll; this.lastEvaluation = this.lastPoll; this.retryAt = 0;
    this.stepMs = 0; this.samples = 0; this.requested = this.recovering ? 'resume' : null; this.states = new Map();
  }
  get metrics() {
    return { branch: this.branch, coordinatorId: this.session.coordinatorId, activePlayers: [...this.session.activePlayers],
      suspendedPlayers: this.session.players.filter(id => !this.session.activePlayers.includes(id)),
      recoveryRequired: this.recovering, availabilityDeadlineMs: this.round ? this.round.started + this.config.roundTimeoutMs : null,
      simulationStepMs: this.stepMs, simulationSamples: this.samples,
      availabilityPeers: [...this.peers].map(([peerId, observation]) => ({ peerId, state: this.states.get(peerId), observedAtMs: observation.at,
        silenceDeadlineMs: observation.at + this.config.silenceMs, rttMs: observation.value.rtt, jitterMs: observation.value.jitter,
        stepMs: observation.value.stepMs, samples: observation.value.samples })) };
  }
  measureStep(elapsed) { const alpha = this.config.autoTransfer.stepEmaAlpha; this.stepMs = this.samples ? this.stepMs * (1 - alpha) + elapsed * alpha : elapsed; this.samples++; }
  summary(now) {
    const s = this.session, network = s.activePlayers.filter(id => id !== s.localPlayerId).map(id => s._core?.getPeerState(id)).filter(p => p?.handshakeComplete);
    return { branch: this.branch, epoch: s.epoch, tick: s.tick, coordinatorId: s.coordinatorId, anchorId: this.anchorId,
      activePlayers: [...s.activePlayers], pumping: now - this.lastAdvance <= this.config.inputGraceMs,
      eligible: !this.recovering && now - this.lastAdvance <= this.config.inputGraceMs,
      requested: this.requested, recovering: this.recovering, inputIdleMs: Math.max(0, now - this.lastAdvance),
      stepMs: this.stepMs, samples: this.samples, rtt: network.length ? Math.max(...network.map(p => p.rtt)) : 0,
      jitter: network.length ? Math.max(...network.map(p => p.jitter)) : 0 };
  }
  live(now) {
    const s = this.session;
    return sorted(s.players.filter(id => id === s.localPlayerId || this.peers.has(id) && now - this.peers.get(id).at < this.config.silenceMs));
  }
  send(ids, op, detail) { this.session._broadcast(ids, 'availability-' + op, detail); }
  poll(now) {
    const s = this.session;
    if (!this.polled) { this.polled = true; this.lastPoll = now; this.lastAdvance = now; this.tenureAt = now; }
    if (now - this.lastPoll > this.config.resumeGapMs && s.players.length > 1) {
      this.recovering = true; this.requested = 'resume'; s.releaseInput(); s._event('resynchronizing', { reason: 'pump-gap' });
    }
    this.lastPoll = now;
    if (!s._core && !s._suspendedBootstrap && !s.room?.resumed || s._transition && !s._transition.availability) return;
    if (now - this.lastHeartbeat >= this.config.heartbeatMs) {
      this.lastHeartbeat = now;
      this.send(s.players.filter(id => id !== s.localPlayerId && s._links.has(id)), 'activity', this.summary(now));
    }
    const live = this.live(now), summaries = new Map([[s.localPlayerId, this.summary(now)], ...[...this.peers].map(([id, p]) => [id, p.value])]);
    for (const id of s.players) {
      const state = !live.includes(id) ? 'unresponsive' : summaries.get(id)?.recovering ? 'resynchronizing' : !summaries.get(id)?.eligible || !s.activePlayers.includes(id) ? 'suspended' : 'active';
      if (this.states.get(id) !== state) { this.states.set(id, state); s._event('participant-state', { peerId: id, state, deadlineMs: (this.peers.get(id)?.at ?? now) + this.config.silenceMs }); }
    }
    const round = this.round;
    if (round) {
      if (now - round.started >= this.config.roundTimeoutMs) { this.cancel(); this.retryAt = now + this.config.retryMs; this.requested = 'round-timeout'; s._event('availability-retry'); return; }
      this.drain(now);
      if (this.round !== round) return;
      if (round.replay) {
        const result = s._boundaryWork('bootstrapPulseMs', () => round.replay.pulse()); s._stats.bootstrapTicks += result.steps ?? 0;
        if (round.replay.done) { round.replay = null; s._applyMembership(s._transition); }
      }
      if (round.leader === s.localPlayerId && round.votes.size === round.participants.length && !round.decision) {
        const choice = this.choose(round);
        round.decision = { ...choice, branch: round.id, epoch: Math.max(s.epoch, ...[...round.votes.values()].map(v => v.epoch)) + 1 };
        this.send(round.participants, 'decision', { round: round.id, decision: round.decision });
      }
      if (round.leader === s.localPlayerId && round.staged.size === round.participants.length && !round.commitSent) {
        if (new Set(round.staged.values()).size !== 1) throw new Error('availability installation mismatch');
        round.commitSent = true; this.send(round.participants, 'commit', { round: round.id, hash: round.staged.get(s.localPlayerId) });
      }
      return;
    }
    const eligible = live.filter(id => summaries.get(id)?.eligible);
    const participants = live.filter(id => summaries.get(id)?.pumping);
    if (!eligible.length || now < this.retryAt) return;
    if (s.players.some(id => id !== s.localPlayerId && !this.peers.has(id)) && now - this.tenureAt < this.config.silenceMs) return;
    let reason = this.requested;
    reason ??= participants.map(id => summaries.get(id)?.requested).find(Boolean);
    if (!equal(eligible, s.activePlayers) || participants.some(id => summaries.get(id)?.branch !== this.branch)) reason ??= 'liveness';
    let transferTo = null;
    const config = this.config.autoTransfer;
    if (!reason && config.enabled && now - this.lastEvaluation >= config.intervalMs && now - this.tenureAt >= config.minTenureMs) {
      this.lastEvaluation = now;
      const score = v => v.rtt * config.rttWeight + v.jitter * config.jitterWeight + v.stepMs * config.stepWeight;
      const candidates = eligible.filter(id => summaries.get(id).samples >= config.minSamples).sort((a, b) => score(summaries.get(a)) - score(summaries.get(b)) || compareIds(a, b));
      const current = summaries.get(s.coordinatorId), best = candidates[0];
      if (current?.samples >= config.minSamples && best && best !== s.coordinatorId && score(current) > score(summaries.get(best)) && score(current) - score(summaries.get(best)) >= config.minImprovementMs) {
        reason = 'auto-transfer'; transferTo = best;
      }
    }
    if (reason && eligible[0] === s.localPlayerId) {
      this.requested = null; this.send(participants, 'probe', { round: nonce(), participants, leader: s.localPlayerId, reason, transferTo });
    }
  }
  choose(round) {
    const s = this.session, votes = [...round.votes].filter(([, v]) => v.eligible);
    if (!votes.length) throw new Error('availability has no active donor');
    const groups = new Map();
    for (const [id, v] of votes) { const key = v.tick + ':' + v.hash; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(id); }
    const majority = [...groups.values()].filter(ids => ids.length > s.players.length / 2).sort((a, b) => b.length - a.length)[0];
    let donor = majority?.sort(compareIds)[0];
    if (!donor) donor = votes.find(([id]) => id === this.anchorId)?.[0] ?? votes.sort((a, b) => b[1].tick - a[1].tick || compareIds(a[0], b[0]))[0][0];
    const v = round.votes.get(donor), activePlayers = sorted([...round.votes].filter(([, value]) => value.pumping).map(([id]) => id));
    const coordinatorId = round.transferTo && activePlayers.includes(round.transferTo) ? round.transferTo : activePlayers.includes(v.coordinatorId) ? v.coordinatorId : donor;
    return { donor, tick: v.tick, hash: v.hash, coordinatorId, activePlayers,
      basis: majority ? 'roster-majority' : votes.some(([id]) => id === this.anchorId) ? 'responsive-coordinator' : 'active-branch',
      votes: majority?.length ?? 0, rosterSize: s.players.length };
  }
  handle(from, m, now) {
    const s = this.session, op = m.op.slice('availability-'.length);
    if (!s.players.includes(from)) return;
    if (op === 'activity') {
      if (!branchValid(m.branch) || !Number.isSafeInteger(m.tick) || m.tick < 0 || !Number.isInteger(m.epoch) || m.epoch < 0 ||
        !Array.isArray(m.activePlayers) || m.activePlayers.length > s.membership.maxPlayers || typeof m.eligible !== 'boolean' ||
        ['stepMs', 'rtt', 'jitter', 'samples', 'inputIdleMs'].some(k => !Number.isFinite(m[k]) || m[k] < 0)) throw new Error('invalid availability observation');
      if (!s.players.includes(m.coordinatorId) || m.activePlayers.some(id => !s.players.includes(id))) return;
      this.peers.set(from, { at: now, value: m }); return;
    }
    if (op === 'probe') {
      if (!branchValid(m.round) || m.leader !== from || !Array.isArray(m.participants) || !equal(sorted([...new Set(m.participants)]), m.participants) ||
        !m.participants.includes(s.localPlayerId) || m.participants.some(id => !s.players.includes(id))) return;
      if (s._transition && !s._transition.availability) return;
      if (this.round?.id === m.round || this.round && compareIds(this.round.leader, from) <= 0) return;
      this.cancel();
      const round = this.round = { id: m.round, leader: from, participants: m.participants, reason: m.reason, transferTo: m.transferTo,
        started: now, votes: new Map(), staged: new Map(), decision: null, replay: null };
      const vote = { ...this.summary(now), hash: s._core?.getStateHash() ?? s._suspendedBootstrap?.hash ?? 0 };
      // Captured once at the frozen, confirmed boundary; never exported per heartbeat.
      round.bootstrap = s._core?.exportConfirmedBootstrap() ?? s._suspendedBootstrap; round.sourceBaseTick = s.baseTick; round.sourceEpoch = s.epoch;
      round.original = bytes(s.adapter.save()).slice();
      this.send(round.participants, 'vote', { round: round.id, vote });
      s._event('availability-preparing', { reason: round.reason, deadlineMs: now + this.config.roundTimeoutMs }); return;
    }
    const round = this.round;
    if (!round || m.round !== round.id || !round.participants.includes(from)) return;
    if (op === 'vote') {
      const v = m.vote;
      if (!branchValid(v?.branch) || !Number.isSafeInteger(v.tick) || v.tick < 0 || !Number.isInteger(v.hash) || v.hash < 0 || v.hash > 0xffffffff || !Number.isInteger(v.epoch) || v.epoch < 0 || v.epoch > 65534 || typeof v.eligible !== 'boolean' || typeof v.pumping !== 'boolean' || v.eligible && !v.pumping || !Array.isArray(v.activePlayers) || v.activePlayers.some(id => !s.players.includes(id)) || !s.players.includes(v.coordinatorId)) throw new Error('invalid availability vote');
      round.votes.set(from, v); return;
    }
    if (op === 'decision' && from === round.leader && !s._transition) {
      if (round.votes.size !== round.participants.length) { round.pendingDecision = m; return; }
      const expected = this.choose(round), d = m.decision;
      if (!equal(expected, Object.fromEntries(Object.keys(expected).map(k => [k, d?.[k]]))) || d.branch !== round.id || d.epoch !== Math.max(s.epoch, ...[...round.votes.values()].map(v => v.epoch)) + 1 || d.epoch > 65534) throw new Error('availability decision certificate');
      round.decision = d;
      if (s.localPlayerId === d.donor) this.send(round.participants, 'checkpoint', { round: round.id, bootstrap: round.bootstrap, baseTick: round.sourceBaseTick, sourceEpoch: round.sourceEpoch });
      s._event('branch-selected', { ...d, reason: round.reason, discardedTick: s.tick }); return;
    }
    if (op === 'checkpoint' && !round.decision) { round.pendingCheckpoint = { from, message: m }; return; }
    if (op === 'checkpoint' && from === round.decision?.donor && !s._transition) {
      const d = round.decision;
      if (m.bootstrap?.hash !== d.hash || m.baseTick + m.bootstrap?.tick !== d.tick || m.sourceEpoch !== round.votes.get(from).epoch ||
        !equal(m.bootstrap.players, round.votes.get(from).activePlayers)) throw new Error('availability checkpoint certificate');
      const tr = s._transition = { availability: true, proposal: { epoch: d.epoch, oldPlayers: [...s.players], players: [...s.players],
        joined: [], left: [], activePlayers: d.activePlayers, coordinatorId: d.coordinatorId, reason: round.reason, branch: d.branch },
        participants: round.participants, target: d.tick, startedAt: now, applied: false, commandSequences: m.bootstrap.commandSequences };
      round.replay = createBootstrapReplay({ adapter: s._adapter(m.baseTick, m.sourceEpoch), bootstrap: m.bootstrap,
        maxCatchupSteps: s.membership.maxCatchupSteps, maxCatchupMs: s.membership.snapshotBudgetMs,
        maxSnapshotBytes: s.profile.maxSnapshotBytes, maxSuffixTicks: s.profile.checksumInterval,
        maxCommandBytes: s.profile.maxCommandBytes, maxPendingCommands: s.profile.maxPendingCommands, maxReplayBytes: s.membership.maxTransferBytes,
        simulationVersion: s.simulationVersion, inputSize: s.inputSize, tickRate: s.profile.tickRate, seed: s.seed });
      s._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length; return;
    }
    if (op === 'staged') {
      if (!Number.isInteger(m.hash)) throw new Error('availability staged hash'); round.staged.set(from, m.hash); return;
    }
    if (op === 'commit' && from === round.leader) {
      if (round.staged.size !== round.participants.length || !s._transition?.applied) { round.pendingCommit = m; return; }
      if ([...round.staged.values()].some(hash => hash !== m.hash) || s._transition.postHash !== m.hash) throw new Error('availability commit certificate');
      const tr = s._transition;
      if (round.reason === 'auto-transfer' || round.participants.length === s.players.length) this.anchorId = tr.proposal.coordinatorId;
      this.branch = tr.proposal.branch; this.recovering = false; this.tenureAt = now; this.lastEvaluation = now; this.retryAt = now + this.config.retryMs;
      this.wireBranch = Uint8Array.from(this.branch.match(/../g), hex => parseInt(hex, 16));
      this.requested = null;
      if (round.votes.get(s.localPlayerId).pumping) this.lastAdvance = now;
      // Losing branches discard their pending intent as well as executed progress.
      tr.discardCommands = round.votes.get(s.localPlayerId).branch !== round.votes.get(round.decision.donor).branch || round.votes.get(s.localPlayerId).hash !== round.decision.hash;
      const previousCoordinator = s.coordinatorId;
      this.round = null; s._commit(tr);
      if (s.coordinatorId !== previousCoordinator) s._event('coordinator-changed', { previousCoordinatorId: previousCoordinator, coordinatorId: s.coordinatorId, reason: round.reason }); return;
    }
  }
  installed(hash) { this.send(this.round.participants, 'staged', { round: this.round.id, hash }); }
  drain(now) {
    const r = this.round;
    if (r?.pendingDecision && r.votes.size === r.participants.length) { const m = r.pendingDecision; r.pendingDecision = null; this.handle(r.leader, m, now); }
    if (r?.pendingCheckpoint && r.decision) { const p = r.pendingCheckpoint; r.pendingCheckpoint = null; this.handle(p.from, p.message, now); }
    if (r?.pendingCommit && r.staged.size === r.participants.length && this.session._transition?.applied) { const m = r.pendingCommit; r.pendingCommit = null; this.handle(r.leader, m, now); }
  }
  cancel() {
    this.round?.replay?.cancel();
    const s = this.session, tr = s._transition;
    if (tr?.availability) { tr.stageJob?.cancel(); if (this.round?.original) s.adapter.load(this.round.original); s._transition = null; }
    this.round = null;
  }
}
