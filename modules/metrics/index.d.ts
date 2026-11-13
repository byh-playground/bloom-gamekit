/** metrics 공개 계약. 수집 서버와 공유하는 전송 계약은 protocol.js가 소유합니다. */
export const SCHEMA_VERSION: 3;
export function reviveBytes(key: string, value: unknown): unknown;

export class MetricsAdapter {
    send(body: string): Promise<void>;
    sendOnHide(body: string): boolean;
}
export class HttpAdapter extends MetricsAdapter {
    constructor(url: string);
    readonly url: string;
}
export class MemoryAdapter extends MetricsAdapter {
    readonly batches: MetricsBatch[];
}

export interface MatchRecorderOptions {
    matchId?: string;
    mode?: string;
    seed?: unknown;
    players?: unknown[];
}
/** beginMatch 옵션: Recorder 생성 옵션 + 기록 여부 */
export type BeginMatchOptions<O = MatchRecorderOptions> = O & {
    /** false: 끝을 기록하지 않는 모드(관전·연습). 시작은 events에 남고 완주율에서 빠지며 recordMatch할 수 없습니다. */
    record?: boolean;
};
export interface MatchCapture {
    seed: unknown;
    players: unknown[];
    replay: unknown;
}
export class MatchRecorder {
    constructor(options?: MatchRecorderOptions);
    readonly matchId: string;
    readonly mode: string;
    readonly seed: unknown;
    readonly players: unknown[];
    capture(): MatchCapture;
}
export class InputLogRecorder extends MatchRecorder {
    readonly frames: { tick: number; input: unknown }[];
    input(tick: number, input: unknown): void;
}
export class SessionReplayRecorder extends MatchRecorder {
    /** rollback `Session` 또는 `recordReplay: true`인 `RoomSession`. */
    constructor(options: MatchRecorderOptions & { session: { exportReplay(): { seed: unknown; players: unknown[] } } });
}

export interface MetricsEvent {
    type: 'session_start' | 'heartbeat' | 'event' | 'session_end';
    t: number;
    category?: string;
    target?: string;
    action?: string;
    props?: Record<string, unknown>;
}
export const MAX_PROPS_BYTES: 2000;
export const MAX_SUMMARY_BYTES: 8000;
export const MAX_PLAYERS_BYTES: 4000;
export const MAX_REPLAY_BYTES: 900000;

export interface MetricsMatch {
    matchId: string;
    mode: string;
    t: number;
    seed: unknown;
    players: unknown[];
    summary: Record<string, unknown>;
    replay: unknown;
}
export interface MetricsBatch {
    schemaVersion: 3;
    game: string;
    build: string;
    sessionId: string;
    seq: number;
    playMs: number;
    events: MetricsEvent[];
    matches: MetricsMatch[];
}

export interface MetricsOptions {
    game: string;
    version: string;
    adapter: MetricsAdapter;
    /** 게임이 고른 화면 언어 코드(예: 'ko'). session_start props에 들어갑니다. */
    locale?: string;
    heartbeatMs?: number;
    flushMs?: number;
    maxBatchEvents?: number;
    now?: () => number;
}
export interface Metrics {
    readonly sessionId: string;
    readonly playMs: number;
    readonly droppedBatches: number;
    track(category: string, target: string, action: string, props?: Record<string, unknown>): void;
    /** 시작 이벤트 match:<mode>:start({ matchId })를 남기고 같은 matchId로 끝을 남길 recorder를 돌려줍니다. */
    beginMatch(options?: BeginMatchOptions): MatchRecorder;
    beginMatch<R extends MatchRecorder, O>(options: BeginMatchOptions<O>, Recorder: new (options: O) => R): R;
    /** beginMatch가 돌려준 recorder로 경기 하나에 한 번. */
    recordMatch(recorder: MatchRecorder, summary?: Record<string, unknown>): Promise<void>;
    flush(): Promise<void>;
    dispose(): Promise<void>;
}
export function createMetrics(options: MetricsOptions): Metrics;
