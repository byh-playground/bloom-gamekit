import { bytes, compareIds, hashBytes, integer } from '../deterministic/utilities.js';
import { createBootstrapReplay } from './bootstrap.js';
const SORTED = (ids) => [...ids].sort(compareIds);
const EQUAL = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NONCE = () =>
    [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
const BRANCH_VALID = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function availabilityConfig(value = {}) {
    const CONFIG = {
        mode: 'strict',
        heartbeatMs: 250,
        silenceMs: 3000,
        inputGraceMs: 3000,
        resumeGapMs: 3000,
        roundTimeoutMs: 5000,
        retryMs: 500,
        ...value,
    };
    if (!['strict', 'available'].includes(CONFIG.mode)) {
        throw new TypeError('availability mode');
    }
    CONFIG.autoTransfer = Object.freeze({
        enabled: false,
        intervalMs: 10000,
        minTenureMs: 30000,
        minImprovementMs: 10,
        minSamples: 10,
        rttWeight: 1,
        jitterWeight: 2,
        stepWeight: 4,
        stepEmaAlpha: 0.1,
        ...value.autoTransfer,
    });
    for (const KEY of ['heartbeatMs', 'silenceMs', 'inputGraceMs', 'resumeGapMs', 'roundTimeoutMs', 'retryMs']) {
        integer(CONFIG[KEY], KEY, 1);
    }
    if (CONFIG.silenceMs < CONFIG.heartbeatMs * 2 || CONFIG.inputGraceMs < CONFIG.heartbeatMs * 2) {
        throw new RangeError('availability grace must cover two heartbeats');
    }
    if (typeof CONFIG.autoTransfer.enabled !== 'boolean') {
        throw new TypeError('autoTransfer enabled');
    }
    for (const [KEY, N] of Object.entries(CONFIG.autoTransfer)) {
        if (KEY !== 'enabled') {
            if (
                !Number.isFinite(N) ||
                N < 0 ||
                (['intervalMs', 'minTenureMs', 'minSamples'].includes(KEY) && (!Number.isSafeInteger(N) || N < 1))
            ) {
                throw new RangeError('autoTransfer ' + KEY);
            }
        }
    }
    if (CONFIG.autoTransfer.stepEmaAlpha <= 0 || CONFIG.autoTransfer.stepEmaAlpha > 1) {
        throw new RangeError('autoTransfer stepEmaAlpha');
    }
    return Object.freeze(CONFIG);
}

/** Availability boundaries replace fixed-roster Cores; no predicted input is invented. */
export class Availability {
    constructor(session) {
        this.session = session;
        this.config = session.availability;
        this.peers = new Map();
        this.round = null;
        this.branch = '0'.repeat(32);
        this.wireBranch = new Uint8Array(16);
        this.anchorId = session.coordinatorId;
        this.recovering = !!session.room?.resumed;
        this.lastPoll = session.clock();
        this.lastAdvance = this.lastPoll;
        this.lastHeartbeat = -Infinity;
        this.tenureAt = this.lastPoll;
        this.lastEvaluation = this.lastPoll;
        this.retryAt = 0;
        this.stepMs = 0;
        this.samples = 0;
        this.requested = this.recovering ? 'resume' : null;
        this.states = new Map();
    }
    get metrics() {
        return {
            branch: this.branch,
            coordinatorId: this.session.coordinatorId,
            activePlayers: [...this.session.activePlayers],
            suspendedPlayers: this.session.players.filter((id) => !this.session.activePlayers.includes(id)),
            recoveryRequired: this.recovering,
            availabilityDeadlineMs: this.round ? this.round.started + this.config.roundTimeoutMs : null,
            simulationStepMs: this.stepMs,
            simulationSamples: this.samples,
            availabilityPeers: [...this.peers].map(([peerId, observation]) => ({
                peerId,
                state: this.states.get(peerId),
                observedAtMs: observation.at,
                silenceDeadlineMs: observation.at + this.config.silenceMs,
                rttMs: observation.value.rtt,
                jitterMs: observation.value.jitter,
                stepMs: observation.value.stepMs,
                samples: observation.value.samples,
            })),
        };
    }
    measureStep(elapsed) {
        const ALPHA = this.config.autoTransfer.stepEmaAlpha;
        this.stepMs = this.samples ? this.stepMs * (1 - ALPHA) + elapsed * ALPHA : elapsed;
        this.samples++;
    }
    summary(now) {
        const S = this.session,
            NETWORK = S.activePlayers
                .filter((id) => id !== S.localPlayerId)
                .map((id) => S._core?.getPeerState(id))
                .filter((p) => p?.handshakeComplete);
        return {
            branch: this.branch,
            epoch: S.epoch,
            tick: S.confirmedTick + 1,
            coordinatorId: S.coordinatorId,
            anchorId: this.anchorId,
            retainedBoundary:
                !!S._suspendedBootstrap ||
                (!!S._core && !S._core.failure && !S._core.resimulating && S._core.confirmedBoundary >= 0),
            activePlayers: [...S.activePlayers],
            pumping: now - this.lastAdvance <= this.config.inputGraceMs,
            eligible: !this.recovering && now - this.lastAdvance <= this.config.inputGraceMs,
            requested: this.requested,
            recovering: this.recovering,
            inputIdleMs: Math.max(0, now - this.lastAdvance),
            stepMs: this.stepMs,
            samples: this.samples,
            rtt: NETWORK.length ? Math.max(...NETWORK.map((p) => p.rtt)) : 0,
            jitter: NETWORK.length ? Math.max(...NETWORK.map((p) => p.jitter)) : 0,
        };
    }
    live(now) {
        const S = this.session;
        return SORTED(
            S.players.filter(
                (id) =>
                    id === S.localPlayerId ||
                    (this.peers.has(id) && now - this.peers.get(id).at < this.config.silenceMs),
            ),
        );
    }
    send(ids, op, detail) {
        this.session._broadcast(ids, 'availability-' + op, detail);
    }
    poll(now) {
        const S = this.session;
        if (!this.polled) {
            this.polled = true;
            this.lastPoll = now;
            this.lastAdvance = now;
            this.tenureAt = now;
        }
        if (now - this.lastPoll > this.config.resumeGapMs && S.players.length > 1) {
            this.recovering = true;
            this.requested = 'resume';
            S.releaseInput();
            S._event('resynchronizing', {
                reason: 'pump-gap',
            });
        }
        this.lastPoll = now;
        if (
            (!S._core && !S._suspendedBootstrap && !S.room?.resumed) ||
            (S._transition && !S._transition.availability)
        ) {
            return;
        }
        if (now - this.lastHeartbeat >= this.config.heartbeatMs) {
            this.lastHeartbeat = now;
            this.send(
                S.players.filter((id) => id !== S.localPlayerId && S._links.has(id)),
                'activity',
                this.summary(now),
            );
        }
        const LIVE = this.live(now),
            SUMMARIES = new Map([
                [S.localPlayerId, this.summary(now)],
                ...[...this.peers].map(([id, p]) => [id, p.value]),
            ]);
        for (const ID of S.players) {
            const STATE = !LIVE.includes(ID)
                ? 'unresponsive'
                : SUMMARIES.get(ID)?.recovering
                  ? 'resynchronizing'
                  : !SUMMARIES.get(ID)?.eligible || !S.activePlayers.includes(ID)
                    ? 'suspended'
                    : 'active';
            if (this.states.get(ID) !== STATE) {
                this.states.set(ID, STATE);
                S._event('participant-state', {
                    peerId: ID,
                    state: STATE,
                    deadlineMs: (this.peers.get(ID)?.at ?? now) + this.config.silenceMs,
                });
            }
        }
        const ROUND = this.round;
        if (ROUND) {
            if (now - ROUND.started >= this.config.roundTimeoutMs) {
                this.cancel();
                this.retryAt = now + this.config.retryMs;
                this.requested = 'round-timeout';
                S._event('availability-retry');
                return;
            }
            this.drain(now);
            if (this.round !== ROUND) {
                return;
            }
            if (ROUND.replay) {
                const RESULT = S._boundaryWork('bootstrapPulseMs', () => ROUND.replay.pulse());
                S._stats.bootstrapTicks += RESULT.steps ?? 0;
                if (ROUND.replay.done) {
                    ROUND.replay = null;
                    S._applyMembership(S._transition);
                }
            }
            if (ROUND.leader === S.localPlayerId && ROUND.votes.size === ROUND.participants.length && !ROUND.decision) {
                const CHOICE = this.choose(ROUND);
                ROUND.decision = {
                    ...CHOICE,
                    branch: ROUND.id,
                    epoch: Math.max(S.epoch, ...[...ROUND.votes.values()].map((v) => v.epoch)) + 1,
                };
                this.send(ROUND.participants, 'decision', {
                    round: ROUND.id,
                    decision: ROUND.decision,
                });
            }
            if (
                ROUND.leader === S.localPlayerId &&
                ROUND.staged.size === ROUND.participants.length &&
                !ROUND.commitSent
            ) {
                if (new Set(ROUND.staged.values()).size !== 1) {
                    throw new Error('availability installation mismatch');
                }
                ROUND.commitSent = true;
                this.send(ROUND.participants, 'commit', {
                    round: ROUND.id,
                    hash: ROUND.staged.get(S.localPlayerId),
                });
            }
            return;
        }
        const ELIGIBLE = LIVE.filter((id) => SUMMARIES.get(id)?.eligible);
        const PARTICIPANTS = LIVE.filter((id) => SUMMARIES.get(id)?.pumping);
        // A room-wide clock gap must not wait forever for an unpaused donor that
        // cannot exist. Only the entire confirmed roster may restart from retained
        // boundaries; a single stale coordinator still follows an active guest.
        const ALL_RESUMED =
            !ELIGIBLE.length &&
            LIVE.length === S.players.length &&
            LIVE.every((id) => SUMMARIES.get(id)?.retainedBoundary) &&
            PARTICIPANTS.some((id) => SUMMARIES.get(id)?.recovering);
        const LEADERS = ALL_RESUMED ? PARTICIPANTS : ELIGIBLE;
        if (!LEADERS.length || now < this.retryAt) {
            return;
        }
        if (
            S.players.some((id) => id !== S.localPlayerId && !this.peers.has(id)) &&
            now - this.tenureAt < this.config.silenceMs
        ) {
            return;
        }
        let reason = ALL_RESUMED ? 'all-resume' : this.requested;
        reason ??= PARTICIPANTS.map((id) => SUMMARIES.get(id)?.requested).find(Boolean);
        if (!EQUAL(ELIGIBLE, S.activePlayers) || PARTICIPANTS.some((id) => SUMMARIES.get(id)?.branch !== this.branch)) {
            reason ??= 'liveness';
        }
        let transferTo = null;
        const CONFIG = this.config.autoTransfer;
        if (
            !reason &&
            CONFIG.enabled &&
            now - this.lastEvaluation >= CONFIG.intervalMs &&
            now - this.tenureAt >= CONFIG.minTenureMs
        ) {
            this.lastEvaluation = now;
            const SCORE = (v) =>
                v.rtt * CONFIG.rttWeight + v.jitter * CONFIG.jitterWeight + v.stepMs * CONFIG.stepWeight;
            const CANDIDATES = ELIGIBLE.filter((id) => SUMMARIES.get(id).samples >= CONFIG.minSamples).sort(
                (a, b) => SCORE(SUMMARIES.get(a)) - SCORE(SUMMARIES.get(b)) || compareIds(a, b),
            );
            const CURRENT = SUMMARIES.get(S.coordinatorId),
                BEST = CANDIDATES[0];
            if (
                CURRENT?.samples >= CONFIG.minSamples &&
                BEST &&
                BEST !== S.coordinatorId &&
                SCORE(CURRENT) > SCORE(SUMMARIES.get(BEST)) &&
                SCORE(CURRENT) - SCORE(SUMMARIES.get(BEST)) >= CONFIG.minImprovementMs
            ) {
                reason = 'auto-transfer';
                transferTo = BEST;
            }
        }
        if (reason && LEADERS[0] === S.localPlayerId) {
            const VOTERS = ALL_RESUMED ? LIVE : PARTICIPANTS;
            this.requested = null;
            this.send(VOTERS, 'probe', {
                round: NONCE(),
                participants: VOTERS,
                leader: S.localPlayerId,
                reason,
                transferTo,
            });
        }
    }
    choose(round) {
        const S = this.session;
        let votes = [...round.votes].filter(([, v]) => v.eligible);
        const ALL_RESUMED = !votes.length;
        if (ALL_RESUMED) {
            if (
                round.reason !== 'all-resume' ||
                round.votes.size !== S.players.length ||
                [...round.votes.values()].some((v) => !v.retainedBoundary) ||
                ![...round.votes.values()].some((v) => v.pumping && v.recovering)
            ) {
                throw new Error('availability has no active donor');
            }
            votes = [...round.votes];
        }
        const GROUPS = new Map();
        for (const [ID, V] of votes) {
            const KEY = V.tick + ':' + V.hash;
            if (!GROUPS.has(KEY)) {
                GROUPS.set(KEY, []);
            }
            GROUPS.get(KEY).push(ID);
        }
        const MAJORITY = [...GROUPS.values()]
            .filter((ids) => ids.length > S.players.length / 2)
            .sort((a, b) => b.length - a.length)[0];
        let donor = MAJORITY?.sort(compareIds)[0];
        const LATEST_TICK = Math.max(...votes.map(([, v]) => v.tick));
        // After *all* pumps paused, prefer the furthest retained progress. The
        // shared coordinator breaks an equal-tick tie, not a stale branch's lead.
        const ANCHOR = votes.find(([id, v]) => id === this.anchorId && (!ALL_RESUMED || v.tick === LATEST_TICK))?.[0];
        if (!donor) {
            donor = ANCHOR ?? votes.sort((a, b) => b[1].tick - a[1].tick || compareIds(a[0], b[0]))[0][0];
        }
        const V = round.votes.get(donor),
            ACTIVE_PLAYERS = SORTED([...round.votes].filter(([, value]) => value.pumping).map(([id]) => id));
        const COORDINATOR_ID =
            round.transferTo && ACTIVE_PLAYERS.includes(round.transferTo)
                ? round.transferTo
                : ACTIVE_PLAYERS.includes(V.coordinatorId)
                  ? V.coordinatorId
                  : ACTIVE_PLAYERS.includes(donor)
                    ? donor
                    : ACTIVE_PLAYERS[0];
        return {
            donor,
            tick: V.tick,
            hash: V.hash,
            coordinatorId: COORDINATOR_ID,
            activePlayers: ACTIVE_PLAYERS,
            basis: MAJORITY ? 'roster-majority' : ANCHOR ? 'responsive-coordinator' : 'active-branch',
            votes: MAJORITY?.length ?? 0,
            rosterSize: S.players.length,
        };
    }
    handle(from, m, now) {
        const S = this.session,
            OP = m.op.slice('availability-'.length);
        if (!S.players.includes(from)) {
            return;
        }
        if (OP === 'activity') {
            if (
                !BRANCH_VALID(m.branch) ||
                !Number.isSafeInteger(m.tick) ||
                m.tick < 0 ||
                !Number.isInteger(m.epoch) ||
                m.epoch < 0 ||
                !Array.isArray(m.activePlayers) ||
                m.activePlayers.length > S.membership.maxPlayers ||
                typeof m.eligible !== 'boolean' ||
                typeof m.retainedBoundary !== 'boolean' ||
                ['stepMs', 'rtt', 'jitter', 'samples', 'inputIdleMs'].some((k) => !Number.isFinite(m[k]) || m[k] < 0)
            ) {
                throw new Error('invalid availability observation');
            }
            if (!S.players.includes(m.coordinatorId) || m.activePlayers.some((id) => !S.players.includes(id))) {
                return;
            }
            this.peers.set(from, {
                at: now,
                value: m,
            });
            return;
        }
        if (OP === 'probe') {
            if (
                !BRANCH_VALID(m.round) ||
                m.leader !== from ||
                !Array.isArray(m.participants) ||
                !EQUAL(SORTED([...new Set(m.participants)]), m.participants) ||
                !m.participants.includes(S.localPlayerId) ||
                m.participants.some((id) => !S.players.includes(id))
            ) {
                return;
            }
            if (S._transition && !S._transition.availability) {
                return;
            }
            if (this.round?.id === m.round || (this.round && compareIds(this.round.leader, from) <= 0)) {
                return;
            }
            this.cancel();
            if (S._core?.resimulating) {
                S._core.poll();
            }
            const ROUND = (this.round = {
                id: m.round,
                leader: from,
                participants: m.participants,
                reason: m.reason,
                transferTo: m.transferTo,
                started: now,
                votes: new Map(),
                staged: new Map(),
                decision: null,
                replay: null,
            });
            const VOTE = {
                ...this.summary(now),
                hash: S._core?.getStateHash(S._core.confirmedBoundary) ?? S._suspendedBootstrap?.hash ?? 0,
            };
            // Captured once at the frozen, confirmed boundary; never exported per heartbeat.
            ROUND.bootstrap = S._core ? S._exportBootstrap() : S._suspendedBootstrap;
            ROUND.sourceBaseTick = S.baseTick;
            ROUND.sourceEpoch = S.epoch;
            ROUND.original = bytes(S.adapter.save()).slice();
            // Slow resumed voters can confirm a retained state without supplying new
            // input. Capture its confirmed current checkpoint once, so suffix replay
            // does not require a simulation-rate pump just to install that state.
            if (ROUND.reason === 'all-resume' && VOTE.retainedBoundary && VOTE.tick === S.tick) {
                if (!ROUND.bootstrap || hashBytes(ROUND.original) !== VOTE.hash) {
                    throw new Error('availability retained boundary changed');
                }
                ROUND.bootstrap = {
                    ...ROUND.bootstrap,
                    checkpoint: {
                        tick: ROUND.bootstrap.tick,
                        bytes: ROUND.original.slice(),
                        hash: VOTE.hash,
                    },
                    frames: [],
                };
            }
            this.send(ROUND.participants, 'vote', {
                round: ROUND.id,
                vote: VOTE,
            });
            S._event('availability-preparing', {
                reason: ROUND.reason,
                deadlineMs: now + this.config.roundTimeoutMs,
            });
            return;
        }
        const ROUND = this.round;
        if (!ROUND || m.round !== ROUND.id || !ROUND.participants.includes(from)) {
            return;
        }
        if (OP === 'vote') {
            const V = m.vote;
            if (
                !BRANCH_VALID(V?.branch) ||
                !Number.isSafeInteger(V.tick) ||
                V.tick < 0 ||
                !Number.isInteger(V.hash) ||
                V.hash < 0 ||
                V.hash > 0xffffffff ||
                !Number.isInteger(V.epoch) ||
                V.epoch < 0 ||
                V.epoch > 65534 ||
                typeof V.eligible !== 'boolean' ||
                typeof V.pumping !== 'boolean' ||
                typeof V.recovering !== 'boolean' ||
                typeof V.retainedBoundary !== 'boolean' ||
                (V.eligible && !V.pumping) ||
                !Array.isArray(V.activePlayers) ||
                V.activePlayers.some((id) => !S.players.includes(id)) ||
                !S.players.includes(V.coordinatorId)
            ) {
                throw new Error('invalid availability vote');
            }
            ROUND.votes.set(from, V);
            return;
        }
        if (OP === 'decision' && from === ROUND.leader && !S._transition) {
            if (ROUND.votes.size !== ROUND.participants.length) {
                ROUND.pendingDecision = m;
                return;
            }
            const EXPECTED = this.choose(ROUND),
                D = m.decision;
            if (
                !EQUAL(EXPECTED, Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, D?.[k]]))) ||
                D.branch !== ROUND.id ||
                D.epoch !== Math.max(S.epoch, ...[...ROUND.votes.values()].map((v) => v.epoch)) + 1 ||
                D.epoch > 65534
            ) {
                throw new Error('availability decision certificate');
            }
            ROUND.decision = D;
            if (S.localPlayerId === D.donor) {
                this.send(ROUND.participants, 'checkpoint', {
                    round: ROUND.id,
                    bootstrap: ROUND.bootstrap,
                    baseTick: ROUND.sourceBaseTick,
                    sourceEpoch: ROUND.sourceEpoch,
                });
            }
            S._event('branch-selected', {
                ...D,
                reason: ROUND.reason,
                discardedTick: S.tick,
            });
            return;
        }
        if (OP === 'checkpoint' && !ROUND.decision) {
            ROUND.pendingCheckpoint = {
                from,
                message: m,
            };
            return;
        }
        if (OP === 'checkpoint' && from === ROUND.decision?.donor && !S._transition) {
            const D = ROUND.decision;
            if (
                m.bootstrap?.hash !== D.hash ||
                m.baseTick + m.bootstrap?.tick !== D.tick ||
                m.sourceEpoch !== ROUND.votes.get(from).epoch ||
                !EQUAL(m.bootstrap.players, ROUND.votes.get(from).activePlayers)
            ) {
                throw new Error('availability checkpoint certificate');
            }
            S._transition = {
                availability: true,
                proposal: {
                    epoch: D.epoch,
                    oldPlayers: [...S.players],
                    players: [...S.players],
                    joined: [],
                    left: [],
                    activePlayers: D.activePlayers,
                    coordinatorId: D.coordinatorId,
                    reason: ROUND.reason,
                    branch: D.branch,
                },
                participants: ROUND.participants,
                target: D.tick,
                startedAt: now,
                applied: false,
                boundaryLoaded: true,
                commandSequences: S._bootstrapCommandSequences(m.bootstrap, S.players),
            };
            ROUND.replay = createBootstrapReplay({
                adapter: S._adapter(m.baseTick, m.sourceEpoch),
                bootstrap: m.bootstrap,
                maxCatchupSteps: S.membership.maxCatchupSteps,
                maxCatchupMs: S.membership.snapshotBudgetMs,
                maxSnapshotBytes: S.profile.maxSnapshotBytes,
                maxSuffixTicks: S.profile.checksumInterval,
                maxCommandBytes: S.profile.maxCommandBytes,
                maxPendingCommands: S.profile.maxPendingCommands,
                maxReplayBytes: S.membership.maxTransferBytes,
                simulationVersion: S.simulationVersion,
                inputSize: S.inputSize,
                tickRate: S.profile.tickRate,
                seed: S.seed,
            });
            S._stats.bootstrapBytes += m.bootstrap.checkpoint.bytes.length;
            return;
        }
        if (OP === 'staged') {
            if (!Number.isInteger(m.hash)) {
                throw new Error('availability staged hash');
            }
            ROUND.staged.set(from, m.hash);
            return;
        }
        if (OP === 'commit' && from === ROUND.leader) {
            if (ROUND.staged.size !== ROUND.participants.length || !S._transition?.applied) {
                ROUND.pendingCommit = m;
                return;
            }
            if ([...ROUND.staged.values()].some((hash) => hash !== m.hash) || S._transition.postHash !== m.hash) {
                throw new Error('availability commit certificate');
            }
            const TR = S._transition;
            if (ROUND.reason === 'auto-transfer' || ROUND.participants.length === S.players.length) {
                this.anchorId = TR.proposal.coordinatorId;
            }
            this.branch = TR.proposal.branch;
            this.recovering = false;
            this.tenureAt = now;
            this.lastEvaluation = now;
            this.retryAt = now + this.config.retryMs;
            this.wireBranch = Uint8Array.from(this.branch.match(/../g), (hex) => parseInt(hex, 16));
            this.requested = null;
            if (ROUND.votes.get(S.localPlayerId).pumping) {
                this.lastAdvance = now;
            }
            // Losing branches discard their pending intent as well as executed progress.
            TR.discardCommands =
                ROUND.votes.get(S.localPlayerId).branch !== ROUND.votes.get(ROUND.decision.donor).branch ||
                (ROUND.votes.get(S.localPlayerId).tick === ROUND.decision.tick &&
                    ROUND.votes.get(S.localPlayerId).hash !== ROUND.decision.hash);
            const PREVIOUS_COORDINATOR = S.coordinatorId;
            this.round = null;
            S._commit(TR);
            if (S.coordinatorId !== PREVIOUS_COORDINATOR) {
                S._event('coordinator-changed', {
                    previousCoordinatorId: PREVIOUS_COORDINATOR,
                    coordinatorId: S.coordinatorId,
                    reason: ROUND.reason,
                });
            }
            return;
        }
    }
    installed(hash) {
        this.send(this.round.participants, 'staged', {
            round: this.round.id,
            hash,
        });
    }
    drain(now) {
        const R = this.round;
        if (R?.pendingDecision && R.votes.size === R.participants.length) {
            const M = R.pendingDecision;
            R.pendingDecision = null;
            this.handle(R.leader, M, now);
        }
        if (R?.pendingCheckpoint && R.decision) {
            const P = R.pendingCheckpoint;
            R.pendingCheckpoint = null;
            this.handle(P.from, P.message, now);
        }
        if (R?.pendingCommit && R.staged.size === R.participants.length && this.session._transition?.applied) {
            const M = R.pendingCommit;
            R.pendingCommit = null;
            this.handle(R.leader, M, now);
        }
    }
    cancel() {
        this.round?.replay?.cancel();
        const S = this.session,
            TR = S._transition;
        if (TR?.availability) {
            TR.stageJob?.cancel();
            if (this.round?.original) {
                S.adapter.load(this.round.original);
            }
            S._transition = null;
        }
        this.round = null;
    }
}
