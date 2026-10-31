export type DiagnosticVisibility = 'log' | 'notice' | 'blocking' | 'fatal';

export interface DiagnosticRecord {
    kind: string;
    visibility: DiagnosticVisibility;
    /** Kept for existing consumers; true exactly when visibility is fatal. */
    fatal: boolean;
    origin: string;
    message: string;
    stack: string;
    source: string;
    line: number;
    column: number;
    workerTimeMs: number | null;
    cause: string;
    firstMs: number;
    lastMs: number;
    count: number;
}

export interface DiagnosticCounts {
    /** Accepted report calls since the last clear, including records later evicted from the ring. */
    total: number;
    /** Report calls represented by records currently retained in the ring. */
    retained: number;
    log: number;
    notice: number;
    blocking: number;
    fatal: number;
}

export interface DiagnosticSnapshot {
    format: 'bloom-gamekit diagnostics v2';
    release: string;
    total: number;
    dropped: number;
    counts: DiagnosticCounts;
    /** Retained blocking + fatal report calls; excludes log and notice. */
    blockerCount: number;
    /** Retained diagnostic records. Kept under the legacy `errors` key. */
    errors: DiagnosticRecord[];
}

export interface DiagnosticReportOptions {
    kind?: string;
    visibility?: DiagnosticVisibility;
    /** Legacy option. True takes precedence over visibility and sets visibility to fatal. */
    fatal?: boolean;
    origin?: string;
    source?: string;
    line?: number;
    column?: number;
    workerTimeMs?: number | null;
    cause?: unknown;
}

export interface DiagnosticRingOptions {
    capacity?: number;
    now?: () => number;
    release?: string;
}

export class DiagnosticRing {
    constructor(options?: DiagnosticRingOptions);
    report(error: unknown, options?: DiagnosticReportOptions): DiagnosticRecord | null;
    snapshot(): DiagnosticSnapshot;
    format(): string;
    installGlobal(
        target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
        options?: {
            onReport?: (record: DiagnosticRecord | null) => void;
        },
    ): () => void;
    clear(): void;
    dispose(): void;
}

export function redactDiagnostic(value: unknown, limit?: number): string;

export type ProfilePrimitive = string | number | boolean | null;
export type ProfileMetadata = Record<string, ProfilePrimitive>;
export interface PerformanceProfilerOptions {
    capacity?: number;
    now?: () => number;
    /** Independent per-frame limits for distinct stage names and counter names. */
    maxStages?: number;
}
export interface ProfileSummary {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
}
export interface ProfileStage {
    ms: number;
    calls: number;
    maxMs: number;
    metadata: ProfileMetadata;
}
export interface ProfileFrame {
    sequence: number;
    durationMs: number;
    meta: ProfileMetadata;
    stages: Record<string, ProfileStage>;
    counts: Record<string, number>;
}
export interface PerformanceProfileSnapshot {
    enabled: boolean;
    capacity: number;
    retainedFrames: number;
    frames: ProfileFrame[];
    summary: { frames: ProfileSummary; stages: Record<string, ProfileSummary> };
}
export class PerformanceProfiler {
    constructor(options?: PerformanceProfilerOptions);
    setEnabled(enabled: boolean): boolean;
    beginFrame(metadata?: ProfileMetadata): boolean;
    stage(name: string, durationMs: number, metadata?: ProfileMetadata): boolean;
    count(name: string, value?: number): boolean;
    measure<T>(name: string, operation: () => T, metadata?: ProfileMetadata): T;
    endFrame(metadata?: ProfileMetadata): ProfileFrame | null;
    clear(): void;
    /** limit affects returned frames only; zero still summarizes all retained frames. */
    snapshot(options?: { limit?: number }): PerformanceProfileSnapshot;
    dispose(): void;
}

export interface DiagnosticClipboard {
    writeText(text: string): Promise<void>;
}
export interface DiagnosticTextarea {
    value: string;
    focus(): void;
    select(): void;
}
export type CopyDiagnosticResult =
    { copied: true; method: 'clipboard' } | { copied: false; method: 'selection' | 'text'; text: string };
export function copyDiagnostic(
    text: string,
    options?: {
        clipboard?: DiagnosticClipboard;
        textarea?: DiagnosticTextarea;
    },
): Promise<CopyDiagnosticResult>;

export interface ReplayState {
    tick: number;
    firstTick: number;
    lastTick: number;
    playing?: boolean;
}
export interface ReplayAdapter {
    read(): ReplayState;
    seek(tick: number): unknown;
    setPlaying(playing: boolean): unknown;
}
export class ReplayTimeline {
    constructor(adapter: ReplayAdapter);
    readInto<T extends Record<string, unknown>>(out: T): T & ReplayState & { playing: boolean };
    seek(tick: number): unknown;
    step(delta?: number): unknown;
    setPlaying(playing: boolean): unknown;
}

export interface StateField<T = unknown> {
    name: string;
    read(state: T): unknown;
    equal?(left: unknown, right: unknown): boolean;
}
export interface StateDifference {
    field: string;
    left: string;
    right: string;
}
export interface StateFieldComparison {
    equal: boolean;
    mismatches: number;
    truncated: boolean;
    differences: StateDifference[];
}
export function compareStateFields<T>(
    left: T,
    right: T,
    fields: StateField<T>[],
    options?: {
        maxDifferences?: number;
    },
): StateFieldComparison;

export interface NumericMetricSummary {
    count: number;
    total: number;
    mean: number;
    p50: number;
    p95: number;
    max: number;
}
export interface NumericFrameSample {
    sequence: number;
    timestampMs: number;
    intervalMs: number;
    cpuMs: number;
    stagesMs: Record<string, number>;
    counts: Record<string, number>;
}
export interface NumericFrameSnapshot {
    format: 'bloom numeric frame metrics v1';
    capacity: number;
    retainedFrames: number;
    firstSequence: number;
    lastSequence: number;
    windowMs: number;
    fps: number | null;
    intervalMs: NumericMetricSummary;
    cpuMs: NumericMetricSummary;
    stagesMs: Record<string, NumericMetricSummary>;
    counts: Record<string, NumericMetricSummary>;
    slowFrames: NumericFrameSample[];
    frames: NumericFrameSample[];
}
export class FrameMetrics {
    constructor(options?: { capacity?: number; stages?: string[]; counters?: string[]; now?: () => number });
    readonly capacity: number;
    readonly samples: Float64Array;
    readonly current: Float64Array;
    readonly size: number;
    readonly sequence: number;
    readonly active: boolean;
    beginFrame(timestampMs: number): void;
    stage(name: string, durationMs: number): boolean;
    count(name: string, amount?: number): boolean;
    endFrame(): boolean;
    clear(): void;
    snapshot(options?: { limit?: number; slowFrameMs?: number; slowLimit?: number }): NumericFrameSnapshot;
}

export interface DebugScene {
    /** Advances the game by exactly one fixed tick. Required only when the URL carries `tick` or `step` is called. */
    step?(): void;
    /** Draws the current state without advancing the simulation. */
    render?(): void;
    /** Game fields that describe what the screen shows; merged into `state()` after scene, params and tick. */
    state?(): Record<string, unknown>;
    hash?(): unknown;
    dispose?(): void;
}
export interface DebugHost {
    /** True once the scene is open at the requested tick and rendered. Stays false when `error` is set. */
    ready: boolean;
    error: string | null;
    scene: string | null;
    /** URL parameters other than `debug`, `scene` and `tick`, as the raw strings the URL carried. */
    params: Record<string, string>;
    tick: number;
    done: Promise<void>;
    step(count?: number): void;
    state(): { scene: string | null; params: Record<string, string>; tick: number } & Record<string, unknown>;
    hash(): unknown;
    dispose(): void;
}
/** Installs `window.__bloomDebug` when the URL has `debug`; returns null otherwise. */
export function installDebugHost(options: {
    scenes: Record<string, (params: Record<string, string>) => DebugScene | void | Promise<DebugScene | void>>;
    search?: string;
    target?: object;
}): DebugHost | null;
