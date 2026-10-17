/** rollback 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { Bytes } from '../deterministic/index.js';
import type { Transport, RoomTransport } from '../transport/index.js';
import type { Replay } from '../replay/index.js';
export type PlayerId = string;
export interface Command {
    sequence: number;
    executeTick: number;
    payload: Uint8Array;
}
export interface PlayerInput {
    playerId: PlayerId;
    input: Uint8Array;
    commands: Command[];
    predicted: boolean;
}
export interface StepContext {
    tick: number;
    tickRate: number;
    inputs: PlayerInput[];
    resimulating: boolean;
    recovering?: boolean;
    replaying?: boolean;
    synctesting?: boolean;
    /** RoomSession이 전역 tick과 함께 전달하는 확정 roster 세대. */
    membershipEpoch?: number;
}
export interface SnapshotContext {
    activePlayers?: PlayerId[];
    tick: number;
    membershipEpoch?: number;
    tickRate?: number;
    players?: PlayerId[];
    simulationVersion?: string;
    seed?: number;
}
export interface SnapshotJob<T> {
    readonly done: boolean;
    readonly result: T | undefined | null;
    /** 각 pulse가 실제 CPU 예산에 협력해야 한다. await와 live simulation 변경은 금지한다. */
    pulse(options: { budgetMs: number }): unknown;
    cancel(): unknown;
}
export interface SimulationAdapter {
    /** 반환 버퍼를 재사용해도 된다. Core는 보관 전에 복사한다. */
    save(): Bytes;
    load(snapshot: Uint8Array): void;
    step(context: StepContext): unknown;
    /** 현재 simulation을 변경하지 않는 후보 검증. */
    validateSnapshot(snapshot: Uint8Array, context: SnapshotContext): boolean;
    /** 선택적 원자적 준비: 비신뢰 bytes의 전체 검증과 canonical round-trip을 확인한다.
     * 반환 token은 private owned state/bytes/context에 묶이며 live state를 바꾸지 않는다. */
    prepareSnapshot?(snapshot: Uint8Array, context: SnapshotContext): object;
    /** 동일 adapter/context의 token을 정확히 한 번 소비하여 그대로 설치한다. */
    loadPreparedSnapshot?(prepared: object, context: SnapshotContext): void;
    /** 호출자가 simulation을 멈춘 동안 canonical snapshot을 점진적으로 캡처한다. */
    saveJob?(): SnapshotJob<Uint8Array>;
    prepareSnapshotJob?(snapshot: Uint8Array, context: SnapshotContext): SnapshotJob<object>;
}
export type PredictionPolicy =
    | 'hold'
    | 'neutral'
    | ((context: { playerId: PlayerId; tick: number; previousInput: Uint8Array; lastConfirmedTick: number }) => Bytes);
export interface Profile {
    /** Core defaults to rollback; RoomSession defaults to lockstep. Lockstep waits for all inputs and stores periodic checkpoints. */
    mode?: 'rollback' | 'lockstep';
    inputScheduling: 'configured' | 'network';
    inputSafetyMarginMs: number;
    inputJitterMultiplier: number;
    tickRate: number;
    baseInputDelayTicks: number;
    minInputDelayTicks: number;
    maxInputDelayTicks: number;
    rollbackWindowTicks: number;
    stateHistorySize: number;
    predictionPolicy: PredictionPolicy;
    stallPolicy: 'wait';
    tickDriftThreshold: number;
    pacingPolicy: 'none' | 'hold' | 'dilation';
    checksumInterval: number;
    maxCatchupSteps: number;
    adaptiveInputDelay: boolean;
    heartbeatMs: number;
    adaptationIntervalMs: number;
    peerInterruptMs: number;
    peerTimeoutMs: number;
    maxSnapshotBytes: number;
    maxHistoryBytes: number;
    maxReplayBytes: number;
    maxCommandBytes: number;
    maxPendingCommands: number;
    maxQueuedBytes: number;
    recoveryTimeoutMs: number;
    maxRecoveryAttempts: number;
}
export const VERSION: string;
export const PROTOCOL_VERSION: number;
export const CHUNK_SIZE: number;
export const MAX_TICK: number;
export const profiles: Readonly<Record<'action' | 'rts' | 'lockstep', Readonly<Profile>>>;
export type SessionStatus =
    'synchronizing' | 'running' | 'interrupted' | 'disconnected' | 'recovering' | 'resimulating' | 'failed' | 'closed';
export type PeerConnectionState = 'connecting' | 'connected' | 'interrupted' | 'disconnected';
export interface PeerState {
    peerId: PlayerId;
    state: PeerConnectionState;
    handshakeComplete: boolean;
    lastReceivedAt: number;
    simTick: number;
    confirmedInputTick: number;
    ackTick: number;
    rtt: number;
    jitter: number;
}
export interface SessionFailure {
    type: 'fatal' | 'desync-unrecoverable' | 'version-mismatch' | 'handshake-mismatch';
    error?: unknown;
    reason?: string;
    attempts?: number;
    authorityPlayerId?: PlayerId;
    peerId?: PlayerId;
    fields?: readonly string[];
    mismatches?: readonly { field: string; expected: unknown; received: unknown }[];
}
export type SessionEvent = { tick: number } & (
    | SessionFailure
    | { type: 'version-mismatch'; peerId: PlayerId; field: 'protocol'; expected: number; received: number }
    | { type: 'peer-ready'; peerId: PlayerId }
    | {
          type: 'peer-interrupted' | 'peer-disconnected' | 'peer-timeout' | 'peer-resumed';
          peerId: PlayerId;
          previous: PeerConnectionState;
          state: PeerConnectionState;
          reason?: string;
          silenceMs?: number;
      }
    | { type: 'input-delay'; previous: number; value: number }
    | { type: 'input-release'; executeTick: number }
    | {
          type: 'input-submitted';
          executeTick: number;
          revision: number;
          commands: Array<{ sequence: number; executeTick: number }>;
          schedule?: InputSchedule;
      }
    | { type: 'input-received'; peerId: PlayerId; executeTick: number; revision: number; provisional: true }
    | { type: 'rollback' | 'recovered' | 'reconciled'; from: number; target: number }
    | { type: 'desync' | 'input-history-mismatch'; peerId: PlayerId; at: number }
    | { type: 'recovery-rejected'; reason: string }
    | { type: 'protocol-error' | 'transport-error'; peerId: PlayerId; error: unknown }
    | { type: 'history-exhausted'; inputTick: number }
    | { type: 'recovery-backpressure'; peerId: PlayerId }
    | { type: 'recovery-timeout' | 'replay-capacity' | 'closed' }
);
export interface SessionOptions {
    players: PlayerId[];
    localPlayerId: PlayerId;
    sessionId: string;
    simulationVersion: string;
    seed?: number;
    inputSize: number;
    profile?: Partial<Profile>;
    adapter: SimulationAdapter;
    authorityPlayerId?: PlayerId;
    onEvent?: (event: SessionEvent) => void;
    recordReplay?: boolean;
    clock?: () => number;
    /** 새 epoch에 아직 실행하지 않은 로컬 명령과 sequence를 넘긴다. 초기 delay 입력은 neutral이다. */
    localCommandState?: LocalCommandState;
    /** 현재 roster 각 플레이어가 이미 실행한 명령 sequence. 새 epoch와 reload 복원에 사용한다. */
    initialCommandSequences?: Record<PlayerId, number>;
}
export interface PendingCommand {
    sequence: number;
    executeTick: number;
    payload: Uint8Array;
}
export interface LocalCommandState {
    sequence: number;
    lastInput: Uint8Array;
    commands: PendingCommand[];
    inputs?: Array<{ tick: number; input: Uint8Array }>;
    sealedThrough?: number;
    tickOffset?: number;
}
export interface ConfirmedPlayerInput extends PlayerInput {
    predicted: false;
}
export interface ConfirmedBootstrap {
    version: 1;
    tick: number;
    checkpoint: { tick: number; bytes: Uint8Array; hash: number };
    players: PlayerId[];
    frames: { tick: number; inputs: ConfirmedPlayerInput[] }[];
    hash: number;
    inputSize: number;
    tickRate: number;
    simulationVersion: string;
    seed: number;
    commandSequences: Record<PlayerId, number>;
}
export interface BootstrapReplayOptions {
    adapter: SimulationAdapter;
    bootstrap: ConfirmedBootstrap;
    maxCatchupSteps?: number;
    /** 틱 사이에서 확인하는 CPU 예산. 개별 동기 adapter/codec 작업을 선점하지 않는다. */
    maxCatchupMs?: number;
    clock?: () => number;
    maxSnapshotBytes?: number;
    maxSuffixTicks?: number;
    maxCommandBytes?: number;
    maxPendingCommands?: number;
    maxReplayBytes?: number;
    /** 지정한 값은 snapshot을 load하기 전에 bootstrap metadata와 대조한다. */
    simulationVersion?: string;
    inputSize?: number;
    tickRate?: number;
    players?: PlayerId[];
    seed?: number;
}
export interface BootstrapReplayPulseResult {
    readonly status: 'catching-up' | 'done' | 'cancelled';
    readonly tick: number;
    readonly targetTick: number;
    readonly steps: number;
    readonly hash?: number;
}
export interface BootstrapReplay {
    readonly tick: number;
    readonly targetTick: number;
    readonly done: boolean;
    readonly status: 'catching-up' | 'done' | 'cancelled' | 'failed';
    readonly failure: Error | null;
    readonly result: Readonly<{ tick: number; hash: number }> | null;
    /** 한 번에 maxCatchupSteps 이하를 재실행한다. 실패하면 원래 snapshot을 복원하고 throw한다. */
    pulse(): BootstrapReplayPulseResult;
    /** 진행 중일 때만 원래 snapshot을 복원한다. 완료된 결과는 유지한다. */
    cancel(): BootstrapReplayPulseResult;
}
export function createBootstrapReplay(options: BootstrapReplayOptions): BootstrapReplay;
export interface InputSchedule {
    policy: 'configured' | 'network';
    localTick: number;
    nextOpenTick: number;
    lastReservedTick: number;
    delayTicks: number;
    executeTick: number;
    baseTick?: number;
    peers: Array<{
        peerId: PlayerId;
        rttMs: number;
        oneWayMs: number;
        rttJitterMs: number;
        jitterMarginMs: number;
        safetyMarginMs: number;
        reportedTick: number;
        reportAgeMs: number;
        estimatedPeerTick: number;
        integerPeerTick: number;
        leadTicks: number;
        peerLeadTicks: number;
    }>;
}
export interface InputSubmission {
    status: 'submitted' | 'unchanged' | 'waiting';
    tick: number;
    executeTick?: number;
    commandSequences: number[];
    commands: Array<{ sequence: number; executeTick: number }>;
}
export interface SessionMetrics {
    inputReservations: number;
    inputReservationSentBytes: number;
    inputReservationReceivedBytes: number;
    rollbacks: number;
    resimulatedTicks: number;
    maxRollbackDepth: number;
    stalls: number;
    holds: number;
    recoveries: number;
    rejectedSnapshots: number;
    rejectedPackets: number;
    sentBytes: number;
    receivedBytes: number;
    predictedTicks: number;
    hashMismatches: number;
    latestResimulationMs: number;
    smoothedRTT: number;
    jitter: number;
    lateInputRate: number;
    rollbackFrequency: number;
    stallFrequency: number;
    resimulationCostMs: number;
    stateHashComputations: number;
    hashedStateBytes: number;
    retainedSnapshotBytes: number;
    snapshotSaves: number;
    serializedSnapshotBytes: number;
    inputDelay: number;
    requestedInputDelay: number;
    confirmedTick: number;
    tick: number;
    pace: number;
}
export interface AdvanceResult {
    status:
        | 'advanced'
        | 'held'
        | 'stalled'
        | 'synchronizing'
        | 'resimulating'
        | 'recovering'
        | 'interrupted'
        | 'disconnected'
        | 'failed';
    tick: number;
    failure?: Readonly<SessionFailure> | null;
}
export class RollbackSession {
    readonly localInputState: LocalInputState;
    constructor(options: SessionOptions);
    readonly tick: number;
    readonly inputDelay: number;
    readonly requestedInputDelay: number;
    readonly confirmedTick: number;
    /** Executed confirmed boundary, before the next tick. */
    readonly confirmedBoundary: number;
    readonly ready: boolean;
    readonly resimulating: boolean;
    readonly closed: boolean;
    readonly status: SessionStatus;
    readonly failure: Readonly<SessionFailure> | null;
    readonly pace: number;
    readonly metrics: SessionMetrics;
    readonly profile: Readonly<Profile>;
    readonly players: readonly PlayerId[];
    readonly localPlayerId: PlayerId;
    readonly inputSize: number;
    readonly authorityPlayerId: PlayerId;
    attachTransport(peerId: PlayerId, transport: Transport): () => void;
    receive(peerId: PlayerId, data: Bytes, now?: number): boolean;
    poll(now?: number): void;
    advance(input?: Bytes): AdvanceResult;
    submitInput(input: Bytes, options?: { commands?: Bytes[] }): InputSubmission;
    queueCommand(payload: Bytes): number;
    /** 증가 즉시 적용. 감소는 동일 샘플에 한 틱씩 적용하며 requestedInputDelay로 목표를 조회한다. */
    setInputDelay(ticks: number): void;
    releaseInput(): void;
    /** In lockstep, uses the retained confirmed checkpoint at or before tick. */
    requestResync(tick: number): boolean;
    /** Lockstep: current boundary is serialized on demand; past ticks require a retained checkpoint. */
    getStateHash(tick?: number): number | undefined;
    getPeerState(peerId: PlayerId): Readonly<PeerState> | undefined;
    /** Copies a retained confirmed boundary. Defaults to confirmedBoundary in both modes. */
    exportConfirmedBootstrap(options?: { tick?: number; checkpointAtOrBefore?: number }): ConfirmedBootstrap;
    verifyConfirmedBootstrap(bootstrap: ConfirmedBootstrap): boolean;
    /** Copies commands at/after fromTick (default confirmedBoundary), including predicted execution. */
    exportLocalCommandState(options?: { fromTick?: number }): LocalCommandState;
    /** Copies executed sequence baselines at a retained confirmed boundary. */
    getCommandSequences(tick?: number): Record<PlayerId, number>;
    exportReplay(): Replay;
    exportSyncTestFrames(options?: { maxFrames?: number }): {
        initialState: Uint8Array;
        players: PlayerId[];
        inputSize: number;
        tickRate: number;
        initialTick: 0;
        frames: { tick: number; inputs: PlayerInput[] }[];
    };
    close(): void;
}
export function createSession(options: SessionOptions): RollbackSession;
export interface MembershipProposal {
    readonly activePlayers?: readonly PlayerId[];
    readonly branch?: string;
    readonly epoch: number;
    readonly oldPlayers: readonly PlayerId[];
    readonly players: readonly PlayerId[];
    readonly joined: readonly PlayerId[];
    readonly left: readonly PlayerId[];
    readonly coordinatorId: PlayerId;
    readonly reason: string;
    readonly resumingId?: PlayerId | null;
}
export interface MembershipContext {
    activePlayers?: readonly PlayerId[];
    branch?: string;
    epoch: number;
    tick: number;
    players: readonly PlayerId[];
    joined: readonly PlayerId[];
    left: readonly PlayerId[];
    coordinatorId: PlayerId;
    reason: string;
    oldPlayers?: readonly PlayerId[];
    resumingId?: PlayerId | null;
}
export interface RoomSimulationAdapter extends SimulationAdapter {
    /** 확정 tick 경계에서 게임이 roster 변경을 결정론적으로 적용한다. */
    applyMembership(context: MembershipContext): unknown;
    /** live state를 유지한 채 detached branch에 변경을 적용하고 완전 검증한다.
     * bytes는 canonical encoding, prepared는 그 bytes와 context에 묶인 일회용 token이다. */
    prepareMembership?(change: MembershipContext, context: SnapshotContext): { bytes: Uint8Array; prepared: object };
    prepareMembershipJob?(
        change: MembershipContext,
        context: SnapshotContext,
    ): SnapshotJob<{ bytes: Uint8Array; prepared: object }>;
}
export interface MembershipOptions {
    maxPlayers: number;
    transitionTimeoutMs: number;
    reconnectGraceMs: number;
    maxCatchupSteps: number;
    maxTransferBytes: number;
    maxControlMessagesPerPulse: number;
    joinRetryMs: number;
    snapshotBudgetMs: number;
}
export interface RoomSessionEvent {
    type: string;
    tick: number;
    epoch: number;
    peerId?: PlayerId;
    reason?: string;
    proposal?: MembershipProposal;
    [key: string]: unknown;
}
export interface RoomSessionOptions {
    /** strict 기본. available은 재결합 시 한 분기의 진행을 버릴 수 있다. */
    availability?: Partial<AvailabilityOptions> & { autoTransfer?: Partial<CoordinatorTransferOptions> };
    /** strict local lockstep에서 SDK 내부 snapshot/checkpoint/hash/replay 생성을 생략한다. 앱의 adapter 저장 기능은 그대로 쓴다. */
    localFastPath?: boolean;
    /** 게임 방 소유자 식별. coordinator 이관으로 변경되지 않는다. */
    roomOwnerId?: PlayerId;
    mode?: 'local' | 'online';
    room?: RoomTransport;
    localPlayerId?: PlayerId;
    sessionId?: string;
    simulationVersion: string;
    seed?: number;
    inputSize: number;
    profile?: Partial<Profile>;
    adapter: RoomSimulationAdapter;
    membership?: Partial<MembershipOptions>;
    clock?: () => number;
    onEvent?: (event: RoomSessionEvent) => void;
}
export interface RoomSessionFailure {
    readonly type: string;
    readonly reason?: string;
    readonly [key: string]: unknown;
}
export interface CoordinatorTransferOptions {
    enabled: boolean;
    intervalMs: number;
    minTenureMs: number;
    minImprovementMs: number;
    minSamples: number;
    rttWeight: number;
    jitterWeight: number;
    stepWeight: number;
    stepEmaAlpha: number;
}
export interface AvailabilityOptions {
    mode: 'strict' | 'available';
    heartbeatMs: number;
    silenceMs: number;
    inputGraceMs: number;
    resumeGapMs: number;
    roundTimeoutMs: number;
    retryMs: number;
}
export type RoomSessionStatus =
    SessionStatus | 'joining' | 'membership' | 'catching-up' | 'suspended' | 'resynchronizing';
export interface RoomAdvanceResult {
    status: AdvanceResult['status'] | 'joining' | 'membership' | 'catching-up' | 'suspended' | 'resynchronizing';
    tick: number;
    failure?: Readonly<SessionFailure> | RoomSessionFailure | null;
}
export interface RoomSessionMetrics extends Partial<SessionMetrics> {
    branch?: string;
    coordinatorId?: PlayerId;
    activePlayers?: PlayerId[];
    suspendedPlayers?: PlayerId[];
    recoveryRequired?: boolean;
    availabilityDeadlineMs?: number | null;
    simulationStepMs?: number;
    simulationSamples?: number;
    availabilityPeers?: Array<{
        peerId: PlayerId;
        state?: string;
        observedAtMs: number;
        silenceDeadlineMs: number;
        rttMs: number;
        jitterMs: number;
        stepMs: number;
        samples: number;
    }>;
    tick: number;
    confirmedTick: number;
    epoch: number;
    transitions: number;
    bootstrapBytes: number;
    bootstrapTicks: number;
    rejectedMessages: number;
    sentControlBytes: number;
    receivedControlBytes: number;
    controlQueuedBytes: number;
    controlReceivingBytes: number;
    pendingAdmissions: number;
    controlIncomingBytes: number;
    snapshotSaves: number;
    serializedSnapshotBytes: number;
    stateHashComputations: number;
    hashedStateBytes: number;
    membershipPrepareMs: number;
    membershipCommitMs: number;
    bootstrapPrepareMs: number;
    bootstrapPulseMs: number;
    maxBoundaryTaskMs: number;
    boundaryLongTasks: number;
}
export class RoomSession {
    readonly localInputState: LocalInputState | null;
    constructor(options: RoomSessionOptions);
    readonly mode: 'local' | 'online';
    readonly localFastPath: boolean;
    readonly room?: RoomTransport;
    readonly localPlayerId: PlayerId;
    readonly sessionId: string;
    readonly inputSize: number;
    readonly simulationVersion: string;
    readonly seed: number;
    readonly players: readonly PlayerId[];
    readonly coordinatorId: PlayerId;
    readonly epoch: number;
    readonly baseTick: number;
    readonly roomOwnerId: PlayerId;
    readonly activePlayers: readonly PlayerId[];
    readonly availability: Readonly<AvailabilityOptions & { autoTransfer: Readonly<CoordinatorTransferOptions> }>;
    readonly tick: number;
    readonly confirmedTick: number;
    readonly inputDelay: number;
    readonly pace: number;
    readonly profile: Readonly<Profile>;
    readonly membership: Readonly<MembershipOptions>;
    readonly closed: boolean;
    readonly ready: boolean;
    readonly resimulating: boolean;
    readonly status: RoomSessionStatus;
    readonly failure: Readonly<SessionFailure> | RoomSessionFailure | null | undefined;
    readonly metrics: RoomSessionMetrics;
    poll(now?: number): void;
    advance(input?: Bytes): RoomAdvanceResult;
    submitInput(input: Bytes, options?: { commands?: Bytes[] }): InputSubmission;
    queueCommand(payload: Bytes): number;
    releaseInput(): void;
    getPeerState(peerId: PlayerId): Readonly<PeerState> | undefined;
    getStateHash(tick?: number): number | undefined;
    /** 확정 roster 변경과 송신 완료까지 기다린다. 즉시 종료는 close()를 사용한다. */
    leave(): Promise<void>;
    close(): void;
}
export function createRoomSession(options: RoomSessionOptions): RoomSession;
export interface LocalInputState {
    epoch: number;
    baseTick: number;
    tick: number;
    confirmedTick: number;
    inputDelay: number;
    commandSequence: number;
    executedInput: Bytes | null;
    replayInput: Bytes | null;
    executedCommandSequence: number | null;
    captures: Array<NonNullable<LocalInputState['capture']>>;
    capture: null | {
        sequence: number;
        captureTick: number;
        executeTick: number;
        input: Bytes;
        commands: Array<{ sequence: number; executeTick: number; payload: Bytes }>;
    };
}
