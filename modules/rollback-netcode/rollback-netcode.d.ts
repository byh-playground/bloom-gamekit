/** 브라우저 단일 ES 모듈의 공개 계약. 구현 규칙의 SSOT는 CONTRACT.md. */
export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView;
export type PlayerId = string;
export interface Command { sequence: number; executeTick: number; payload: Uint8Array; }
export interface PlayerInput { playerId: PlayerId; input: Uint8Array; commands: Command[]; predicted: boolean; }
export interface StepContext {
  tick: number; tickRate: number; inputs: PlayerInput[]; resimulating: boolean;
  recovering?: boolean; replaying?: boolean; synctesting?: boolean;
  /** RoomSession이 전역 tick과 함께 전달하는 확정 roster 세대. */
  membershipEpoch?: number;
}
export interface SnapshotContext {
  activePlayers?: PlayerId[];
  tick: number; membershipEpoch?: number; tickRate?: number;
  players?: PlayerId[]; simulationVersion?: string; seed?: number;
}
export interface SnapshotJob<T> {
  readonly done: boolean; readonly result: T | undefined | null;
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
export type TransportState = 'connecting' | 'open' | 'interrupted' | 'closed' | 'failed';
export interface Transport {
  /** false는 backpressure 등으로 이번 송신을 받지 않았다는 뜻이다. */
  send(data: Uint8Array): boolean | void;
  subscribe(listener: (data: Uint8Array) => void): () => void;
  subscribeStatus?(listener: (state: TransportState) => void): () => void;
  readonly state?: TransportState;
  readonly bufferedAmount?: number;
  close?(): void;
}
export type PredictionPolicy = 'hold' | 'neutral' | ((context: { playerId: PlayerId; tick: number; previousInput: Uint8Array; lastConfirmedTick: number }) => Bytes);
export interface Profile {
  /** Omitted means rollback. Lockstep waits for all inputs and stores periodic checkpoints. */
  mode?: 'rollback' | 'lockstep';
  tickRate: number; baseInputDelayTicks: number; minInputDelayTicks: number; maxInputDelayTicks: number;
  rollbackWindowTicks: number; stateHistorySize: number; predictionPolicy: PredictionPolicy; stallPolicy: 'wait';
  tickDriftThreshold: number; pacingPolicy: 'none' | 'hold' | 'dilation'; checksumInterval: number;
  maxCatchupSteps: number; adaptiveInputDelay: boolean;
  heartbeatMs: number; adaptationIntervalMs: number; peerInterruptMs: number; peerTimeoutMs: number;
  maxSnapshotBytes: number; maxHistoryBytes: number; maxReplayBytes: number;
  maxCommandBytes: number; maxPendingCommands: number; maxQueuedBytes: number;
  recoveryTimeoutMs: number; maxRecoveryAttempts: number;
}
export const VERSION: string;
export const PROTOCOL_VERSION: number;
export const CHUNK_SIZE: number;
export const MAX_TICK: number;
export const profiles: Readonly<Record<'action' | 'rts' | 'lockstep', Readonly<Profile>>>;
export type SessionStatus = 'synchronizing' | 'running' | 'interrupted' | 'disconnected' | 'recovering' | 'resimulating' | 'failed' | 'closed';
export type PeerConnectionState = 'connecting' | 'connected' | 'interrupted' | 'disconnected';
export interface PeerState {
  peerId: PlayerId; state: PeerConnectionState; handshakeComplete: boolean; lastReceivedAt: number;
  simTick: number; confirmedInputTick: number; ackTick: number; rtt: number; jitter: number;
}
export interface SessionFailure {
  type: 'fatal' | 'desync-unrecoverable' | 'version-mismatch' | 'handshake-mismatch';
  error?: unknown; reason?: string; attempts?: number; authorityPlayerId?: PlayerId; peerId?: PlayerId;
  fields?: readonly string[]; mismatches?: readonly { field: string; expected: unknown; received: unknown }[];
}
export type SessionEvent = { tick: number } & (
  | SessionFailure
  | { type: 'version-mismatch'; peerId: PlayerId; field: 'protocol'; expected: number; received: number }
  | { type: 'peer-ready'; peerId: PlayerId }
  | { type: 'peer-interrupted' | 'peer-disconnected' | 'peer-timeout' | 'peer-resumed'; peerId: PlayerId; previous: PeerConnectionState; state: PeerConnectionState; reason?: string; silenceMs?: number }
  | { type: 'input-delay'; previous: number; value: number }
  | { type: 'input-release'; executeTick: number }
  | { type: 'rollback' | 'recovered'; from: number; target: number }
  | { type: 'desync' | 'input-history-mismatch'; peerId: PlayerId; at: number }
  | { type: 'recovery-rejected'; reason: string }
  | { type: 'protocol-error' | 'transport-error'; peerId: PlayerId; error: unknown }
  | { type: 'history-exhausted'; inputTick: number }
  | { type: 'recovery-backpressure'; peerId: PlayerId }
  | { type: 'recovery-timeout' | 'replay-capacity' | 'closed' }
);
export interface SessionOptions {
  players: PlayerId[]; localPlayerId: PlayerId; sessionId: string; simulationVersion: string;
  seed?: number; inputSize: number; profile?: Partial<Profile>; adapter: SimulationAdapter;
  authorityPlayerId?: PlayerId; onEvent?: (event: SessionEvent) => void; recordReplay?: boolean; clock?: () => number;
  /** 새 epoch에 아직 실행하지 않은 로컬 명령과 sequence를 넘긴다. 초기 delay 입력은 neutral이다. */
  localCommandState?: LocalCommandState;
  /** 현재 roster 각 플레이어가 이미 실행한 명령 sequence. 새 epoch와 reload 복원에 사용한다. */
  initialCommandSequences?: Record<PlayerId, number>;
}
export interface PendingCommand { sequence: number; payload: Uint8Array; }
export interface LocalCommandState { sequence: number; lastInput: Uint8Array; commands: PendingCommand[]; }
export interface ConfirmedPlayerInput extends PlayerInput { predicted: false; }
export interface ConfirmedBootstrap {
  version: 1; tick: number; checkpoint: { tick: number; bytes: Uint8Array; hash: number };
  players: PlayerId[]; frames: { tick: number; inputs: ConfirmedPlayerInput[] }[];
  hash: number; inputSize: number; tickRate: number; simulationVersion: string; seed: number;
  commandSequences: Record<PlayerId, number>;
}
export interface BootstrapReplayOptions {
  adapter: SimulationAdapter; bootstrap: ConfirmedBootstrap; maxCatchupSteps?: number;
  /** 틱 사이에서 확인하는 CPU 예산. 개별 동기 adapter/codec 작업을 선점하지 않는다. */
  maxCatchupMs?: number; clock?: () => number;
  maxSnapshotBytes?: number; maxSuffixTicks?: number; maxCommandBytes?: number;
  maxPendingCommands?: number; maxReplayBytes?: number;
  /** 지정한 값은 snapshot을 load하기 전에 bootstrap metadata와 대조한다. */
  simulationVersion?: string; inputSize?: number; tickRate?: number; players?: PlayerId[]; seed?: number;
}
export interface BootstrapReplayPulseResult {
  readonly status: 'catching-up' | 'done' | 'cancelled'; readonly tick: number;
  readonly targetTick: number; readonly steps: number; readonly hash?: number;
}
export interface BootstrapReplay {
  readonly tick: number; readonly targetTick: number; readonly done: boolean;
  readonly status: 'catching-up' | 'done' | 'cancelled' | 'failed'; readonly failure: Error | null;
  readonly result: Readonly<{ tick: number; hash: number }> | null;
  /** 한 번에 maxCatchupSteps 이하를 재실행한다. 실패하면 원래 snapshot을 복원하고 throw한다. */
  pulse(): BootstrapReplayPulseResult;
  /** 진행 중일 때만 원래 snapshot을 복원한다. 완료된 결과는 유지한다. */
  cancel(): BootstrapReplayPulseResult;
}
export function createBootstrapReplay(options: BootstrapReplayOptions): BootstrapReplay;
export interface SessionMetrics {
  rollbacks: number; resimulatedTicks: number; maxRollbackDepth: number; stalls: number; holds: number;
  recoveries: number; rejectedSnapshots: number; rejectedPackets: number; sentBytes: number; receivedBytes: number;
  predictedTicks: number; hashMismatches: number; latestResimulationMs: number; smoothedRTT: number; jitter: number;
  lateInputRate: number; rollbackFrequency: number; stallFrequency: number; resimulationCostMs: number;
  stateHashComputations: number; hashedStateBytes: number; retainedSnapshotBytes: number;
  snapshotSaves: number; serializedSnapshotBytes: number;
  inputDelay: number; requestedInputDelay: number; confirmedTick: number; tick: number; pace: number;
}
export interface Replay {
  version: string; simulationVersion: string; seed: number; players: PlayerId[]; inputSize: number; tickRate: number;
  initialState: Uint8Array; frames: { tick: number; inputs: PlayerInput[] }[]; tick: number; hash: number; truncated: boolean;
}
export interface AdvanceResult { status: 'advanced' | 'held' | 'stalled' | 'synchronizing' | 'resimulating' | 'recovering' | 'interrupted' | 'disconnected' | 'failed'; tick: number; failure?: Readonly<SessionFailure> | null; }
export class RollbackSession {
  readonly localInputState: LocalInputState;
  constructor(options: SessionOptions);
  readonly tick: number; readonly inputDelay: number; readonly requestedInputDelay: number; readonly confirmedTick: number;
  readonly ready: boolean; readonly resimulating: boolean; readonly closed: boolean; readonly status: SessionStatus;
  readonly failure: Readonly<SessionFailure> | null; readonly pace: number; readonly metrics: SessionMetrics; readonly profile: Readonly<Profile>;
  readonly players: readonly PlayerId[]; readonly localPlayerId: PlayerId; readonly inputSize: number; readonly authorityPlayerId: PlayerId;
  attachTransport(peerId: PlayerId, transport: Transport): () => void;
  receive(peerId: PlayerId, data: Bytes, now?: number): boolean;
  poll(now?: number): void;
  advance(input?: Bytes): AdvanceResult;
  queueCommand(payload: Bytes): number;
  /** 증가 즉시 적용. 감소는 동일 샘플에 한 틱씩 적용하며 requestedInputDelay로 목표를 조회한다. */
  setInputDelay(ticks: number): void;
  releaseInput(): void;
  /** In lockstep, uses the retained confirmed checkpoint at or before tick. */
  requestResync(tick: number): boolean;
  /** Lockstep: current boundary is serialized on demand; past ticks require a retained checkpoint. */
  getStateHash(tick?: number): number | undefined;
  getPeerState(peerId: PlayerId): Readonly<PeerState> | undefined;
  /** 현재 확정 lockstep 경계와 가장 가까운 보관 checkpoint/suffix를 복사한다. */
  exportConfirmedBootstrap(options?: { checkpointAtOrBefore?: number }): ConfirmedBootstrap;
  verifyConfirmedBootstrap(bootstrap: ConfirmedBootstrap): boolean;
  /** 이미 실행한 명령은 제외하며 미래 frame과 대기 queue의 명령을 sequence 순으로 복사한다. */
  exportLocalCommandState(): LocalCommandState;
  /** lockstep에서만 지원하며 미래 명령을 제외한 실행 sequence를 복사한다. */
  getCommandSequences(): Record<PlayerId, number>;
  exportReplay(): Replay;
  exportSyncTestFrames(options?: { maxFrames?: number }): { initialState: Uint8Array; players: PlayerId[]; inputSize: number; tickRate: number; initialTick: 0; frames: { tick: number; inputs: PlayerInput[] }[] };
  close(): void;
}
export function createSession(options: SessionOptions): RollbackSession;
export interface MembershipProposal {
  readonly activePlayers?: readonly PlayerId[]; readonly branch?: string;
  readonly epoch: number; readonly oldPlayers: readonly PlayerId[]; readonly players: readonly PlayerId[];
  readonly joined: readonly PlayerId[]; readonly left: readonly PlayerId[];
  readonly coordinatorId: PlayerId; readonly reason: string; readonly resumingId?: PlayerId | null;
}
export interface MembershipContext {
  activePlayers?: readonly PlayerId[]; branch?: string;
  epoch: number; tick: number; players: readonly PlayerId[]; joined: readonly PlayerId[]; left: readonly PlayerId[];
  coordinatorId: PlayerId; reason: string; oldPlayers?: readonly PlayerId[]; resumingId?: PlayerId | null;
}
export interface RoomSimulationAdapter extends SimulationAdapter {
  /** 확정 tick 경계에서 게임이 roster 변경을 결정론적으로 적용한다. */
  applyMembership(context: MembershipContext): unknown;
  /** live state를 유지한 채 detached branch에 변경을 적용하고 완전 검증한다.
   * bytes는 canonical encoding, prepared는 그 bytes와 context에 묶인 일회용 token이다. */
  prepareMembership?(change: MembershipContext, context: SnapshotContext): { bytes: Uint8Array; prepared: object };
  prepareMembershipJob?(change: MembershipContext, context: SnapshotContext): SnapshotJob<{ bytes: Uint8Array; prepared: object }>;
}
export interface MembershipOptions {
  maxPlayers: number; transitionTimeoutMs: number; reconnectGraceMs: number; maxCatchupSteps: number;
  maxTransferBytes: number; maxControlMessagesPerPulse: number; joinRetryMs: number; snapshotBudgetMs: number;
}
export interface RoomSessionEvent {
  type: string; tick: number; epoch: number; peerId?: PlayerId; reason?: string;
  proposal?: MembershipProposal; [key: string]: unknown;
}
export interface RoomSessionOptions {
  /** strict 기본. available은 재결합 시 한 분기의 진행을 버릴 수 있다. */
  availability?: Partial<AvailabilityOptions> & { autoTransfer?: Partial<CoordinatorTransferOptions> };
  /** 게임 방 소유자 식별. coordinator 이관으로 변경되지 않는다. */
  roomOwnerId?: PlayerId;
  mode?: 'local' | 'online'; room?: RoomTransport; localPlayerId?: PlayerId; sessionId?: string;
  simulationVersion: string; seed?: number; inputSize: number; profile?: Partial<Profile>;
  adapter: RoomSimulationAdapter; membership?: Partial<MembershipOptions>; clock?: () => number;
  onEvent?: (event: RoomSessionEvent) => void;
}
export interface RoomSessionFailure { readonly type: string; readonly reason?: string; readonly [key: string]: unknown; }
export interface CoordinatorTransferOptions {
  enabled: boolean; intervalMs: number; minTenureMs: number; minImprovementMs: number; minSamples: number;
  rttWeight: number; jitterWeight: number; stepWeight: number; stepEmaAlpha: number;
}
export interface AvailabilityOptions {
  mode: 'strict' | 'available'; heartbeatMs: number; silenceMs: number; inputGraceMs: number; resumeGapMs: number;
  roundTimeoutMs: number; retryMs: number;
}
export type RoomSessionStatus = SessionStatus | 'joining' | 'membership' | 'catching-up' | 'suspended' | 'resynchronizing';
export interface RoomAdvanceResult {
  status: AdvanceResult['status'] | 'joining' | 'membership' | 'catching-up' | 'suspended' | 'resynchronizing'; tick: number;
  failure?: Readonly<SessionFailure> | RoomSessionFailure | null;
}
export interface RoomSessionMetrics extends Partial<SessionMetrics> {
  branch?: string; coordinatorId?: PlayerId; activePlayers?: PlayerId[]; suspendedPlayers?: PlayerId[];
  recoveryRequired?: boolean; availabilityDeadlineMs?: number | null; simulationStepMs?: number; simulationSamples?: number;
  availabilityPeers?: Array<{peerId: PlayerId; state?: string; observedAtMs: number; silenceDeadlineMs: number; rttMs: number; jitterMs: number; stepMs: number; samples: number}>;
  tick: number; confirmedTick: number; epoch: number; transitions: number; bootstrapBytes: number;
  bootstrapTicks: number; rejectedMessages: number; sentControlBytes: number; receivedControlBytes: number;
  controlQueuedBytes: number; controlReceivingBytes: number; pendingAdmissions: number; controlIncomingBytes: number; snapshotSaves: number;
  serializedSnapshotBytes: number; stateHashComputations: number; hashedStateBytes: number;
  membershipPrepareMs: number; membershipCommitMs: number; bootstrapPrepareMs: number; bootstrapPulseMs: number;
  maxBoundaryTaskMs: number; boundaryLongTasks: number;
}
export class RoomSession {
  readonly localInputState: LocalInputState | null;
  constructor(options: RoomSessionOptions);
  readonly mode: 'local' | 'online'; readonly room?: RoomTransport;
  readonly localPlayerId: PlayerId; readonly sessionId: string; readonly inputSize: number;
  readonly simulationVersion: string; readonly seed: number; readonly players: readonly PlayerId[];
  readonly coordinatorId: PlayerId; readonly epoch: number; readonly baseTick: number;
  readonly roomOwnerId: PlayerId; readonly activePlayers: readonly PlayerId[];
  readonly availability: Readonly<AvailabilityOptions & { autoTransfer: Readonly<CoordinatorTransferOptions> }>;
  readonly tick: number; readonly confirmedTick: number; readonly inputDelay: number; readonly pace: number;
  readonly profile: Readonly<Profile>; readonly membership: Readonly<MembershipOptions>;
  readonly closed: boolean; readonly ready: boolean; readonly resimulating: boolean; readonly status: RoomSessionStatus;
  readonly failure: Readonly<SessionFailure> | RoomSessionFailure | null | undefined; readonly metrics: RoomSessionMetrics;
  poll(now?: number): void; advance(input?: Bytes): RoomAdvanceResult; queueCommand(payload: Bytes): number;
  releaseInput(): void; getPeerState(peerId: PlayerId): Readonly<PeerState> | undefined;
  getStateHash(tick?: number): number | undefined;
  /** 확정 roster 변경과 송신 완료까지 기다린다. 즉시 종료는 close()를 사용한다. */
  leave(): Promise<void>; close(): void;
}
export function createRoomSession(options: RoomSessionOptions): RoomSession;
export function playReplay(options: { adapter: SimulationAdapter; replay: Replay; simulationVersion?: string }): { tick: number; hash: number };
export interface SyncTestOptions {
  adapter: SimulationAdapter; players: PlayerId[]; inputSize: number; tickRate?: number; initialTick?: number;
  checkDistance?: number; maxSnapshotBytes?: number; maxHistoryBytes?: number; now?: () => number;
}
export interface SyncTestMetrics {
  readonly status: 'running' | 'failed' | 'closed'; readonly tick: number; readonly checkDistance: number;
  readonly checkedTicks: number; readonly resimulatedTicks: number; readonly stateHash: number | null; readonly historyBytes: number;
  readonly forwardCostMs: number; readonly resimulationCostMs: number; readonly totalCostMs: number;
  readonly failure: Readonly<{ name: string; message: string; code: string | null; tick: number | null;
    checkpointTick: number | null; firstDifference: number | null; expectedHash: number | null; actualHash: number | null }> | null;
}
export type LocalTestInput = { playerId: PlayerId; input: Uint8Array; commands?: Command[] };
export class DeterminismError extends Error {
  constructor(detail: { tick: number; checkpointTick: number; expected: Uint8Array; actual: Uint8Array; inputs: PlayerInput[] });
  readonly syncTestMetrics?: SyncTestMetrics; readonly code: 'determinism-mismatch'; readonly tick: number; readonly checkpointTick: number; readonly firstDifference: number;
  readonly expectedHash: number; readonly actualHash: number; readonly expectedState: Uint8Array; readonly actualState: Uint8Array; readonly inputs: PlayerInput[];
}
export class SyncTestSession {
  constructor(options: SyncTestOptions);
  readonly tick: number; readonly status: 'running' | 'failed' | 'closed'; readonly failure: unknown;
  readonly checkedTicks: number; readonly resimulatedTicks: number; readonly metrics: SyncTestMetrics;
  advance(inputs: LocalTestInput[]): { tick: number; checkedTicks: number; resimulatedTicks: number };
  getStateHash(): number | undefined;
  close(): void;
}
export function createSyncTestSession(options: SyncTestOptions): SyncTestSession;
export function runSyncTest(options: SyncTestOptions & { frames: { tick: number; inputs: LocalTestInput[] }[] }): { tick: number; checkedTicks: number; resimulatedTicks: number; hash: number; metrics: SyncTestMetrics };
export function runSyncTestAsync(options: SyncTestOptions & { frames: { tick: number; inputs: LocalTestInput[] }[]; yieldControl?: () => void | Promise<void>; signal?: AbortSignal }): Promise<{ tick: number; checkedTicks: number; resimulatedTicks: number; hash: number; metrics: SyncTestMetrics }>;
export class SeededPRNG { constructor(seed?: number); state: number; nextUint32(): number; nextInt(bound: number): number; }
export function statelessRandom(seed: number, eventId: number): number;
export function hashBytes(value: Bytes, seed?: number): number;
export const fixedPoint: Readonly<{ scale: number; fromNumber(x: number): number; toNumber(x: number): number; add(a: number,b: number): number; sub(a: number,b: number): number; mul(a: number,b: number): number; div(a: number,b: number): number }>;
export class WebRTCTransport implements Transport {
  constructor(options: { inputChannel?: RTCDataChannel; controlChannel: RTCDataChannel; highWaterMark?: number; lowWaterMark?: number });
  readonly state: TransportState; readonly bufferedAmount: number; readonly closed: boolean;
  send(data: Uint8Array): boolean; subscribe(listener: (data: Uint8Array) => void): () => void;
  subscribeStatus(listener: (state: TransportState) => void): () => void;
  setConnectionState(state: RTCPeerConnectionState): void; close(): void;
}
export interface SignalingMessage { type: 'discover' | 'presence' | 'offer' | 'answer' | 'ice' | 'bye' | 'group'; [key: string]: unknown; }
export interface SignalEnvelope { from: string; to: string; message: SignalingMessage; }
export interface Signaler { readonly id: string; send(to: string,message: SignalingMessage): Promise<void>; subscribe(listener: (event: SignalEnvelope) => unknown): () => void; close(): void; }
export interface ConnectionStatus { type: string; state?: string; status?: string; error?: unknown; room?: string; role?: string; relay?: string; message?: string; }
export interface NostrOptions {
  room: string; namespace?: string; relays?: string[]; timeoutMs?: number; onStatus?: (status: ConnectionStatus) => void;
  WebSocketImpl?: typeof WebSocket; cryptoImpl?: Crypto; signal?: AbortSignal; publishIntervalMs?: number;
  maxVerificationsPerSecond?: number; verificationBurst?: number;
  identity?: NostrSigningIdentity;
}
export interface NostrSigningIdentity {
  readonly id: string;
  sign(hash: Uint8Array, auxiliary: Uint8Array, cryptoImpl: Crypto): Uint8Array | Promise<Uint8Array>;
  close(): void;
}
export interface NostrSignaler extends Signaler { readonly room: string; readonly metrics: { attempted: number; verified: number; throttled: number; totalVerificationMs: number; maxVerificationMs: number }; }
export function createNostrSignaler(options: NostrOptions): Promise<NostrSignaler>;
export const nostrCrypto: Readonly<{ publicKey(secret: Uint8Array): Uint8Array; sign(message: Uint8Array,secret: Uint8Array,auxiliary: Uint8Array): Promise<Uint8Array>; verify(signature: Uint8Array,message: Uint8Array,publicKey: Uint8Array): Promise<boolean> }>;
export interface PeerOptions { initiator?: boolean; signaler: Signaler; remoteId: string; rtcConfig?: RTCConfiguration; timeoutMs?: number; RTCPeerConnectionImpl?: typeof RTCPeerConnection; onStatus?: (status: ConnectionStatus) => void; signal?: AbortSignal; }
export interface PeerConnection { transport: WebRTCTransport; peerConnection: RTCPeerConnection; close(): void; }
export function createWebRTCPeer(options: PeerOptions): Promise<PeerConnection>;
export interface RoomOptions { role: 'host' | 'join'; room?: string; namespace?: string; relays?: string[]; rtcConfig?: RTCConfiguration; timeoutMs?: number; onStatus?: (status: ConnectionStatus) => void; signal?: AbortSignal; signalerFactory?: typeof createNostrSignaler; peerFactory?: typeof createWebRTCPeer; }
export function createNostrRoom(options: RoomOptions): Promise<PeerConnection & { room: string; sessionId: string; localPlayerId: string; remotePlayerId: string }>;
export type RoomTopology = 'mesh' | 'star';
export interface GroupRoomStatus extends ConnectionStatus {
  type: string; room?: string; sessionId?: string; role?: 'host' | 'join'; playerCount?: number; topology?: RoomTopology;
  phase?: string; players?: readonly PlayerId[]; localPlayerId?: PlayerId; peerId?: PlayerId;
  reason?: string; previousPhase?: string; event?: ConnectionStatus;
}
export interface GroupRoomOptions {
  role: 'host' | 'join'; room?: string; playerCount?: number; topology?: RoomTopology;
  namespace?: string; relays?: string[]; rtcConfig?: RTCConfiguration; timeoutMs?: number;
  onStatus?: (status: GroupRoomStatus) => void; signal?: AbortSignal;
  signalerFactory?: typeof createNostrSignaler; peerFactory?: typeof createWebRTCPeer;
}
export interface GroupRoom {
  readonly room: string; readonly sessionId: string; readonly playerCount: number; readonly topology: RoomTopology;
  readonly players: readonly PlayerId[]; readonly localPlayerId: PlayerId;
  readonly authorityPlayerId: PlayerId; readonly hostPlayerId: PlayerId;
  /** Logical remote peers, including relayed guest-to-guest routes in star topology. */
  readonly transports: ReadonlyMap<PlayerId, Transport>;
  /** Physical connections only: N-1 per mesh/host, one per star guest. */
  readonly peerConnections: ReadonlyMap<PlayerId, RTCPeerConnection>;
  readonly closed: boolean;
  readonly metrics: Readonly<{ sentFrames: number; forwardedFrames: number; rejectedFrames: number;
    queuedBytes: number; queuedFrames: number; assemblyBytes: number }> | null;
  close(): void;
}
export function createNostrGroupRoom(options: GroupRoomOptions): Promise<GroupRoom>;
export interface DynamicRoomStatus extends ConnectionStatus {
  type: string; room?: string; sessionId?: string; role?: 'host' | 'join'; localPlayerId?: PlayerId; peerId?: PlayerId;
  transport?: Transport; generation?: number; reason?: string; event?: ConnectionStatus;
}
/** RoomSession이 사용하는 연결 capability. RTC 연결 자체는 roster 입장을 뜻하지 않는다. */
export interface RoomTransport {
  readonly sessionId: string; readonly localPlayerId: PlayerId; readonly coordinatorId: PlayerId;
  readonly players: readonly PlayerId[]; readonly epoch: number; readonly transports: ReadonlyMap<PlayerId, Transport>;
  readonly resumed?: boolean; readonly resumePeerId?: PlayerId | null;
  subscribe(listener: (event: DynamicRoomStatus) => void): () => void;
  setRoster(value: { epoch: number; players: PlayerId[]; coordinatorId: PlayerId; allowBranchReconnect?: boolean }): void;
  connectMesh(players: PlayerId[]): Promise<void>; disconnect?(peerId: PlayerId): boolean;
  forgetResume?(): void; close(): void;
}
export interface DynamicRoom extends RoomTransport {
  readonly room: string; readonly role: 'host' | 'join'; readonly maxPlayers: number;
  readonly joining: boolean; readonly closed: boolean; readonly peerConnections: ReadonlyMap<PlayerId, RTCPeerConnection>;
  readonly resumed: boolean; readonly resumePeerId: PlayerId | null;
  readonly metrics: Readonly<{ activePeerCount: number; pendingPeerCount: number; signalBacklogBytes: number }>;
  /** 같은 capability 수명 안에서만 동일 signaling identity를 유지한다. */
  reconnect(peerId: PlayerId): Promise<Transport>;
  disconnect(peerId: PlayerId): boolean;
  /** 저장된 재접속 identity만 지우며 현재 연결을 종료하지 않는다. */
  forgetResume(): void;
  close(reason?: string): void;
}
export interface DynamicRoomOptions {
  expectedSessionId?: string;
  authorizeJoin?: (peerId: PlayerId, context: { sessionId: string; room: string }) => boolean;
  role: 'host' | 'join'; room?: string; namespace?: string; maxPlayers?: number; maxPendingPeers?: number;
  timeoutMs?: number; peerTimeoutMs?: number; retryMs?: number; advertiseIntervalMs?: number;
  resume?: RoomResumeOptions | false; resumeProbeMs?: number;
  relays?: string[]; rtcConfig?: RTCConfiguration; signal?: AbortSignal;
  onStatus?: (status: DynamicRoomStatus) => void;
  signalerFactory?: typeof createNostrSignaler; peerFactory?: typeof createWebRTCPeer;
}
export interface RoomResumeOptions {
  /** 명시적으로 전달한 탭/브라우저 저장소에 재접속 identity를 저장한다. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  key?: string; lifetimeMs?: number; reset?: boolean;
}
export function createNostrDynamicRoom(options: DynamicRoomOptions): Promise<DynamicRoom>;
export interface PublicRoom extends DynamicRoom {
  readonly publicMetrics: Readonly<{ directoryEntries: number; pendingReservations: number; pendingPublications: number }>;
}
export interface PublicRoomOptions extends Omit<DynamicRoomOptions, 'role' | 'room' | 'expectedSessionId' | 'authorizeJoin' | 'timeoutMs'> {
  simulationVersion: string; discoveryMs?: number; totalTimeoutMs?: number; leaseMs?: number; reservationMs?: number; maxAttempts?: number;
  dynamicRoomFactory?: typeof createNostrDynamicRoom;
}
export function createNostrPublicRoom(options: PublicRoomOptions): Promise<PublicRoom>;

/** 고정 roster Core와 RoomSession 모두 같은 스케줄 capability를 제공한다. */
export interface LoopSession {
  readonly inputSize: number; readonly profile: Pick<Profile, 'tickRate' | 'maxCatchupSteps'>;
  readonly closed: boolean; readonly resimulating: boolean; readonly pace: number;
  poll(): void; advance(input?: Bytes): { status: string; tick: number }; releaseInput(): void;
}
export interface PreviewEntity { id: string; generation: number; source: object; type?: Function; }
export interface PreviewFork {restore?(snapshot:unknown):void;step(input: unknown, context: { sequence?: number; tick: number; epoch: number; commands: Array<{observationId?:number;sequence:number|null;executeTick?:number;payload: unknown}>; speculative: true; replay?: boolean;gap?:boolean }): void; }
export interface LocalInputPreviewOptions {
  stepMs?: number;
  createFork(snapshot: unknown): PreviewFork; cloneSnapshot?(snapshot: unknown): unknown; captureSnapshot?(): unknown; readEntities(fork: PreviewFork): PreviewEntity[];
  presentation?: { selectPreview(ids: Array<{ id: string; generation: number }>): void; capturePreview(packet: object, nowMs: number): boolean; clearPreview?(): void };
  maxPendingInputs?: number; maxFutureTicks?: number; maxAgeMs?: number;
}
export interface LoopInputSubmission {sequence:number;captureTick:number;executeTick:number;boundaryTick:number;epoch:number;timeMs:number;commands:Array<{observationId?:number;sequence:number;executeTick:number;payload:Bytes}>;}
export interface ObservingLoop {start():void;stop():void;pulse(timestamp:number, options?:{render?:boolean}):void;render():void;observeInput(timestamp:number):unknown;flushInput(timestamp:number):void;releaseInput():void;resetTiming():void;readonly running:boolean;}
export interface LocalInputState { epoch:number; baseTick:number; tick:number; confirmedTick:number; inputDelay:number; commandSequence:number;executedInput:Bytes|null;replayInput:Bytes|null;executedCommandSequence:number|null;capture:null|{sequence:number;captureTick:number;executeTick:number;input:Bytes;commands:Array<{sequence:number;executeTick:number;payload:Bytes}>}; }
export class LocalInputPreview {
  constructor(options: LocalInputPreviewOptions);
  readonly pendingCount: number; readonly enabled: boolean; readonly ready:boolean; readonly metrics: Readonly<Record<string, number>>;
  reconcile(checkpoint: {snapshot:unknown;input?:unknown;revision:number;tick:number;epoch:number;continuationKey?:string;confirmedCommandSequence?:number;timeMs:number;mode?:'continuous'|'rollback'|'load'|'reset'|'teleport'|'join'|'resync';reset?:boolean}):boolean;
  continueFromCheckpoint(checkpoint:{input:unknown;revision:number;tick:number;epoch:number;continuationKey:string;confirmedCommandSequence?:number;timeMs:number}):boolean;
  observe(input:unknown,metadata:{sequence:number;tick:number;epoch:number;timeMs:number;continuationKey?:string;commands?:Array<{observationId:number;sequence:number|null;payload:Bytes}>}):boolean;
  commit(capture:NonNullable<LocalInputState['capture']>&{boundaryTick?:number;predict?:boolean},nowMs:number):boolean;
  cancelObservation(nowMs:number):void; clockGap():boolean;
  clear(): void; setEnabled(enabled: boolean): void; dispose(): void;
}
export function createLoop<S extends LoopSession>(options: { session: S & { queueCommand?: (payload: Bytes) => number }; backlogPolicy?: 'drop' | 'retain'; getInput?: () => Bytes | { input: Bytes; commands?: Array<{ payload: Bytes }>; continuationKey?: string; predict?: boolean }; beforeFrame?: (timestamp: number) => void; canAdvance?: () => boolean; canObserveInput?:()=>boolean; onAdvance?: (result: ReturnType<S['advance']>, submission?: LoopInputSubmission) => void; onPreviewError?: (error: unknown) => void; inputPreview?: Pick<LocalInputPreview, 'observe' | 'commit' | 'clear' | 'enabled'> & Partial<Pick<LocalInputPreview,'clockGap'>>; render?: (context: { session: S; alpha: number; resimulating: boolean }) => void; onError?: (error: unknown) => void; onInputRelease?: () => void; requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (handle: number) => void }): ObservingLoop;
export function createDeadlineScheduler(options:{getIntervalMs:()=>number;pulse:(timestamp:number,info:{due:number;scheduledAtMs:number|null})=>void;maxBacklogTicks?:number;now?:()=>number;setTimer?:(callback:()=>void,delayMs:number)=>unknown;clearTimer?:(handle:unknown)=>void;onGap?:(gap:{elapsedMs:number;droppedTicks:number;timestamp:number;scheduledAtMs:number})=>void}):{start():void;stop():void;wake():void;rebase(nowMs?:number):void;readonly running:boolean;readonly deadlineMs:number|null};
export type CodecValue = null | boolean | number | string | Uint8Array | CodecValue[] | { [key: string]: CodecValue };
export interface ValueCodec { readonly format: 'binary' | 'json'; encode(value: CodecValue): Uint8Array; decode(bytes: Bytes): CodecValue; }
export function createValueCodec(options?: { format?: 'binary' | 'json'; maxBytes?: number; maxDepth?: number; maxEntries?: number }): ValueCodec;
export const binaryCodec: ValueCodec;
export const jsonCodec: ValueCodec;
