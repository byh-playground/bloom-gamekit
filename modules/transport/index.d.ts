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
/** 신호 전달자를 만드는 함수. `createNostrSignaler`와 `createLocalSignaler`가 이 모양입니다. */
export type SignalerFactory = (options: NostrOptions) => Promise<Signaler>;
export interface LocalSignalerOptions {
    room: string;
    namespace?: string;
    onStatus?: (status: ConnectionStatus) => void;
    signal?: AbortSignal;
    identity?: NostrSigningIdentity;
}
/** 같은 페이지의 방 연결끼리만 신호를 주고받는 전달자. 릴레이·서명·네트워크가 없습니다. */
export function createLocalSignaler(options: LocalSignalerOptions): Promise<Signaler & { readonly room: string }>;
export interface RoomOptions {
    role: 'host' | 'join';
    /** 네 자리 숫자. host가 생략하면 무작위로 정합니다. */
    room?: string;
    namespace?: string;
    /** 게임이 정한 호환 값(1~64자). 두 쪽이 같아야 연결을 시도합니다. 의미는 게임이 정하고 모듈은 비교만 합니다. */
    version: string;
    relays?: string[];
    rtcConfig?: RTCConfiguration;
    /** 처음 열릴 때까지 기다리는 시간(ms). 기본 60000. 넘기면 `failed`('timeout')입니다. */
    timeoutMs?: number;
    /** 열린 적 있는 연결을 잃은 뒤 다시 열릴 때까지 기다리는 시간(ms). 기본 60000. 넘기면 `failed`('reconnect-timeout')입니다. */
    reconnectTimeoutMs?: number;
    /** 협상 한 번(offer부터 채널 열림까지)의 제한(ms). 기본 8000. 넘기면 그 시도를 버리고 다시 시작합니다. */
    peerTimeoutMs?: number;
    /** 상대를 찾는 신호(guest의 discover, host의 presence)를 되풀이하는 간격(ms). 기본 1000. */
    retryMs?: number;
    /** 연결이 `disconnected`가 된 뒤 저절로 돌아오기를 기다리는 시간(ms). 기본 2500. 넘기면 연결을 버리고 다시 만듭니다. */
    disconnectGraceMs?: number;
    /**
     * host가 돌아오기 전에 같은 방 코드의 다른 host를 기다려 듣는 시간(ms). 기본 1200, 0..10000. join은 무시합니다.
     * 0이면 확인 없이 바로 돌아오며 같은 코드의 두 host를 `room-in-use`로 거르지 못합니다.
     */
    collisionCheckMs?: number;
    onStatus?: (event: RoomEvent) => void;
    signal?: AbortSignal;
    /** 신호 전달자 생성 함수. 받은 `identity`로 만들어야 하며, 기본은 Nostr, 같은 페이지 시험은 `createLocalSignaler`입니다. */
    signalerFactory?: SignalerFactory;
}
export type RoomFailureReason = 'timeout' | 'reconnect-timeout' | 'version-mismatch';
interface RoomEventBase {
    room: string;
    role: 'host' | 'join';
}
export type RoomEvent =
    | (RoomEventBase & { type: 'room'; namespace: string })
    /** 신호가 준비되어 상대를 찾거나 기다리기 시작했습니다. 전달자를 다시 만든 뒤에도 옵니다. */
    | (RoomEventBase & { type: 'signaling-ready'; rebuilt?: boolean })
    | (RoomEventBase & {
          type: 'state';
          state: TransportState;
          previous: TransportState;
          /** 지금까지 열린 횟수. */
          generation: number;
          /** `interrupted`로 가는 이유('datachannel-close'·'rtc-failed'·'rtc-disconnected'·'peer-restarted'·'send-failed'·reconnect()에 준 이유 …). */
          reason?: string;
          /** `reconnect()`로 직접 다시 연 경우. */
          forced?: boolean;
          /** `open`: 처음이 아닌 열림. */
          reconnect?: boolean;
          /** `open`: 연결을 새로 만들지 않고 disconnected에서 저절로 돌아옴. */
          healed?: boolean;
      })
    | (RoomEventBase & { type: 'attempt-failed'; reason: string })
    | (RoomEventBase & {
          type: 'version-mismatch';
          peerId: string;
          kind: 'version' | 'protocol';
          local: string | number;
          remote: string | number;
      })
    | (RoomEventBase & { type: 'error'; code: string; error: unknown; message: string })
    | { type: 'signaler'; transport: string; status: string; relay?: string; message?: string };
/** 앱이 자기 프로토콜을 얹는 ordered 채널. 직렬화는 앱이 하고 모듈은 바이트와 흐름 제어만 맡습니다. */
export interface AppChannel {
    /** 열려 있지 않거나 큐가 넘치면 false. 256 KiB 가까운 크기를 넘기면 RangeError. */
    send(data: Uint8Array | ArrayBuffer | ArrayBufferView): boolean;
    subscribe(listener: (data: Uint8Array) => void): () => void;
    /** 채널 버퍼와 송신 큐에 남은 바이트. */
    readonly bufferedAmount: number;
}
export interface Room {
    readonly room: string;
    readonly role: 'host' | 'join';
    /** host는 만들 때 정하고, join은 첫 offer를 받은 뒤(열리기 전까지는 null) host의 값을 따릅니다. */
    readonly sessionId: string | null;
    readonly localPlayerId: 'a' | 'b';
    readonly remotePlayerId: 'a' | 'b';
    /** 짝으로 고정한 상대의 신호 id. 아직 없으면 null. */
    readonly peerId: string | null;
    readonly state: TransportState;
    /** 지금까지 열린 횟수. 0이면 아직 한 번도 열리지 않았습니다. */
    readonly generation: number;
    readonly failure: Readonly<{ reason: RoomFailureReason; message: string }> | null;
    readonly closed: boolean;
    /** 처음 열릴 때 이행하고 `failed`·`closed`가 먼저면 `code`가 이유인 오류로 거절합니다. */
    readonly opened: Promise<void>;
    /** 지금 연결. 재연결마다 바뀌고 없으면 null. */
    readonly peerConnection: RTCPeerConnection | null;
    /** netcode 입력(unordered)·제어(ordered) 채널. 재연결해도 같은 객체이고 구독이 유지되며, 닫는 일은 방이 합니다. */
    readonly transport: Transport;
    readonly app: AppChannel;
    subscribe(listener: (event: RoomEvent) => void): () => void;
    subscribeStatus(listener: (state: TransportState) => void): () => void;
    /**
     * 지금 연결을 버리고 새로 맺습니다. `failed`였다면 다시 시작합니다.
     * `newPeer`는 고정한 상대를 풀고 같은 방의 다른 상대도 받습니다. 방이 닫혔으면 false.
     */
    reconnect(options?: { reason?: string; newPeer?: boolean }): boolean;
    close(): void;
}
export function createNostrRoom(options: RoomOptions): Promise<Room>;
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
