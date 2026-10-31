/** transport 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { PlayerId, RoomSession } from '../rollback/index.js';
import type { SaveAdapter } from '../save/index.js';
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
export class WebRTCTransport implements Transport {
    constructor(options: {
        inputChannel?: RTCDataChannel;
        controlChannel: RTCDataChannel;
        highWaterMark?: number;
        lowWaterMark?: number;
    });
    readonly state: TransportState;
    readonly bufferedAmount: number;
    readonly closed: boolean;
    send(data: Uint8Array): boolean;
    subscribe(listener: (data: Uint8Array) => void): () => void;
    subscribeStatus(listener: (state: TransportState) => void): () => void;
    setConnectionState(state: RTCPeerConnectionState): void;
    close(): void;
}
export interface SignalingMessage {
    type: 'discover' | 'presence' | 'offer' | 'answer' | 'ice' | 'bye' | 'group';
    [key: string]: unknown;
}
export interface SignalEnvelope {
    from: string;
    to: string;
    message: SignalingMessage;
}
export interface Signaler {
    readonly id: string;
    send(to: string, message: SignalingMessage): Promise<void>;
    subscribe(listener: (event: SignalEnvelope) => unknown): () => void;
    close(): void;
}
export interface ConnectionStatus {
    type: string;
    state?: string;
    status?: string;
    error?: unknown;
    room?: string;
    role?: string;
    relay?: string;
    message?: string;
}
export interface NostrOptions {
    room: string;
    namespace?: string;
    relays?: string[];
    timeoutMs?: number;
    onStatus?: (status: ConnectionStatus) => void;
    WebSocketImpl?: typeof WebSocket;
    cryptoImpl?: Crypto;
    signal?: AbortSignal;
    publishIntervalMs?: number;
    maxVerificationsPerSecond?: number;
    verificationBurst?: number;
    identity?: NostrSigningIdentity;
}
export interface NostrSigningIdentity {
    readonly id: string;
    sign(hash: Uint8Array, auxiliary: Uint8Array, cryptoImpl: Crypto): Uint8Array | Promise<Uint8Array>;
    close(): void;
}
export interface NostrSignaler extends Signaler {
    readonly room: string;
    readonly metrics: {
        attempted: number;
        verified: number;
        throttled: number;
        totalVerificationMs: number;
        maxVerificationMs: number;
    };
}
export function createNostrSignaler(options: NostrOptions): Promise<NostrSignaler>;
export const nostrCrypto: Readonly<{
    publicKey(secret: Uint8Array): Uint8Array;
    sign(message: Uint8Array, secret: Uint8Array, auxiliary: Uint8Array): Promise<Uint8Array>;
    verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
}>;
export interface PeerOptions {
    initiator?: boolean;
    signaler: Signaler;
    remoteId: string;
    rtcConfig?: RTCConfiguration;
    timeoutMs?: number;
    RTCPeerConnectionImpl?: typeof RTCPeerConnection;
    onStatus?: (status: ConnectionStatus) => void;
    signal?: AbortSignal;
}
export interface PeerConnection {
    transport: WebRTCTransport;
    peerConnection: RTCPeerConnection;
    close(): void;
}
export function createWebRTCPeer(options: PeerOptions): Promise<PeerConnection>;
export interface RoomOptions {
    role: 'host' | 'join';
    room?: string;
    namespace?: string;
    relays?: string[];
    rtcConfig?: RTCConfiguration;
    timeoutMs?: number;
    onStatus?: (status: ConnectionStatus) => void;
    signal?: AbortSignal;
    signalerFactory?: typeof createNostrSignaler;
    peerFactory?: typeof createWebRTCPeer;
}
export function createNostrRoom(
    options: RoomOptions,
): Promise<PeerConnection & { room: string; sessionId: string; localPlayerId: string; remotePlayerId: string }>;
export type RoomTopology = 'mesh' | 'star';
export interface GroupRoomStatus extends ConnectionStatus {
    type: string;
    room?: string;
    sessionId?: string;
    role?: 'host' | 'join';
    playerCount?: number;
    topology?: RoomTopology;
    phase?: string;
    players?: readonly PlayerId[];
    localPlayerId?: PlayerId;
    peerId?: PlayerId;
    reason?: string;
    previousPhase?: string;
    event?: ConnectionStatus;
}
export interface GroupRoomOptions {
    role: 'host' | 'join';
    room?: string;
    playerCount?: number;
    topology?: RoomTopology;
    namespace?: string;
    relays?: string[];
    rtcConfig?: RTCConfiguration;
    timeoutMs?: number;
    onStatus?: (status: GroupRoomStatus) => void;
    signal?: AbortSignal;
    signalerFactory?: typeof createNostrSignaler;
    peerFactory?: typeof createWebRTCPeer;
}
export interface GroupRoom {
    readonly room: string;
    readonly sessionId: string;
    readonly playerCount: number;
    readonly topology: RoomTopology;
    readonly players: readonly PlayerId[];
    readonly localPlayerId: PlayerId;
    readonly authorityPlayerId: PlayerId;
    readonly hostPlayerId: PlayerId;
    /** Logical remote peers, including relayed guest-to-guest routes in star topology. */
    readonly transports: ReadonlyMap<PlayerId, Transport>;
    /** Physical connections only: N-1 per mesh/host, one per star guest. */
    readonly peerConnections: ReadonlyMap<PlayerId, RTCPeerConnection>;
    readonly closed: boolean;
    readonly metrics: Readonly<{
        sentFrames: number;
        forwardedFrames: number;
        rejectedFrames: number;
        queuedBytes: number;
        queuedFrames: number;
        assemblyBytes: number;
    }> | null;
    close(): void;
}
export function createNostrGroupRoom(options: GroupRoomOptions): Promise<GroupRoom>;
export interface DynamicRoomStatus extends ConnectionStatus {
    type: string;
    room?: string;
    sessionId?: string;
    role?: 'host' | 'join';
    localPlayerId?: PlayerId;
    peerId?: PlayerId;
    transport?: Transport;
    generation?: number;
    reason?: string;
    event?: ConnectionStatus;
    /** `type: 'resume-save-failed'`: 어느 레코드의 대기 쓰기가 실패했는지. identity 실패는 identity를 닫는다. */
    record?: 'identity' | 'pointer';
    /** `type: 'resume-save-failed'`: save 모듈의 오류(`kind`: 'storage' | 'conflict' | 'unreadable' | 'closed'). */
    error?: Error & { kind?: string };
}
/** RoomSession이 사용하는 연결 capability. RTC 연결 자체는 roster 입장을 뜻하지 않는다. */
export interface RoomTransport {
    readonly sessionId: string;
    readonly localPlayerId: PlayerId;
    readonly coordinatorId: PlayerId;
    readonly players: readonly PlayerId[];
    readonly epoch: number;
    readonly transports: ReadonlyMap<PlayerId, Transport>;
    readonly resumed?: boolean;
    readonly resumePeerId?: PlayerId | null;
    subscribe(listener: (event: DynamicRoomStatus) => void): () => void;
    setRoster(value: {
        epoch: number;
        players: PlayerId[];
        coordinatorId: PlayerId;
        allowBranchReconnect?: boolean;
    }): void;
    connectMesh(players: PlayerId[]): Promise<void>;
    disconnect?(peerId: PlayerId): boolean;
    forgetResume?(): void;
    close(): void;
}
export interface DynamicRoom extends RoomTransport {
    readonly room: string;
    readonly role: 'host' | 'join';
    readonly maxPlayers: number;
    readonly joining: boolean;
    readonly closed: boolean;
    readonly peerConnections: ReadonlyMap<PlayerId, RTCPeerConnection>;
    readonly resumed: boolean;
    readonly resumePeerId: PlayerId | null;
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
    role: 'host' | 'join';
    room?: string;
    namespace?: string;
    maxPlayers?: number;
    maxPendingPeers?: number;
    timeoutMs?: number;
    peerTimeoutMs?: number;
    retryMs?: number;
    advertiseIntervalMs?: number;
    resume?: RoomResumeOptions | false;
    resumeProbeMs?: number;
    relays?: string[];
    rtcConfig?: RTCConfiguration;
    signal?: AbortSignal;
    onStatus?: (status: DynamicRoomStatus) => void;
    signalerFactory?: typeof createNostrSignaler;
    peerFactory?: typeof createWebRTCPeer;
}
export interface RoomResumeOptions {
    /**
     * 재접속 identity·공개 방 pointer를 save 레코드로 두는 저장소 어댑터.
     * 탭 한정은 `localStorageAdapter({ storage: sessionStorage, prefix })`, 격리 장면은 `memoryAdapter()`.
     */
    adapter: SaveAdapter;
    /** 레코드 key(공개 방에서는 `:<room>`·`:pointer`를 붙이는 접두). 기본은 `bloom-gamekit:dynamic-v2:<namespace>:<room>`(공개 방 pointer는 `bloom-gamekit:public-v2:…:pointer`). */
    key?: string;
    lifetimeMs?: number;
    reset?: boolean;
}
export function createNostrDynamicRoom(options: DynamicRoomOptions): Promise<DynamicRoom>;
export interface PublicRoom extends DynamicRoom {
    readonly publicMetrics: Readonly<{
        directoryEntries: number;
        pendingReservations: number;
        pendingPublications: number;
    }>;
}
export interface PublicRoomOptions extends Omit<
    DynamicRoomOptions,
    'role' | 'room' | 'expectedSessionId' | 'authorizeJoin' | 'timeoutMs'
> {
    simulationVersion: string;
    discoveryMs?: number;
    totalTimeoutMs?: number;
    leaseMs?: number;
    reservationMs?: number;
    maxAttempts?: number;
    dynamicRoomFactory?: typeof createNostrDynamicRoom;
}
export function createNostrPublicRoom(options: PublicRoomOptions): Promise<PublicRoom>;

/** 고정 roster Core와 RoomSession 모두 같은 스케줄 capability를 제공한다. */
