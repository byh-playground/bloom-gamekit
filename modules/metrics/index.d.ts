/** metrics 공개 계약. 수집 서버와 공유하는 전송 계약은 protocol.js가 소유합니다. */
export const SCHEMA_VERSION: 2;
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
    schemaVersion: 2;
    game: string;
    build: string;
    sessionId: string;
    seq: number;
    playMs: number;
    tester: string | null;
    events: MetricsEvent[];
    matches: MetricsMatch[];
}

export interface MetricsOptions {
    game: string;
    version: string;
    adapter: MetricsAdapter;
    heartbeatMs?: number;
    flushMs?: number;
    maxBatchEvents?: number;
    now?: () => number;
}
export interface Metrics {
    readonly sessionId: string;
    readonly playMs: number;
    readonly droppedBatches: number;
    readonly tester: string | null;
    setTester(name: string | null): void;
    track(category: string, target: string, action: string, props?: Record<string, unknown>): void;
    recordMatch(recorder: MatchRecorder, summary?: Record<string, unknown>): Promise<void>;
    flush(): Promise<void>;
    dispose(): Promise<void>;
}
export function createMetrics(options: MetricsOptions): Metrics;
