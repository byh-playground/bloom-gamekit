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
/** A frame whose interval crossed the hitch rule, copied out of the ring with the frames just before it. */
export interface NumericFrameHitch extends NumericFrameSample {
    /** Median of the 15 intervals before this one, or 0 while fewer than 15 were seen. */
    medianMs: number;
    /** min(rule.ms, medianMs * rule.medianFactor), or rule.ms without a median. */
    thresholdMs: number;
    /** Up to `rule.before` preceding frames, oldest first. */
    before: NumericFrameSample[];
}
export interface FrameHitchRule {
    /** Retained hitches (0 keeps none). Default 24, at most 256. */
    capacity: number;
    /** Absolute interval that always counts. Default 100. */
    ms: number;
    /** Interval / median of the last 15 intervals that counts. Default 2.5 (above one dropped frame, at two at 60 or 120 Hz). */
    medianFactor: number;
    /** Intervals at or above this are pauses (hidden tab), not hitches, and stay out of the median. Default 1000. */
    maxMs: number;
    /** Preceding frames copied with each hitch. Default 3, at most 8. */
    before: number;
}
export interface FrameTraceRule {
    /** Registered counters that mark a frame when above 0 (any of them). Empty (default) turns tracing off. */
    counters: string[];
    /** Retained traces. Default 8, at most 64. */
    capacity: number;
    /** Frames copied before the marked frame. Default 2, at most 16, below the ring capacity. */
    before: number;
    /** Frames appended after the marked frame. Default 10, at most 120. A mark while a trace is open only bumps `marks`. */
    after: number;
}
export interface NumericFrameTraceFrame extends NumericFrameSample {
    /** Sequence relative to the marked frame (negative before, 0 the mark, positive after). */
    offset: number;
}
/** Frames around a marked frame, kept regardless of the hitch rule. */
export interface NumericFrameTrace {
    /** Sequence of the marked frame. */
    sequence: number;
    timestampMs: number;
    /** Marked frames inside this trace (1 + marks that arrived while it was open). */
    marks: number;
    /** Still collecting `after` frames. */
    open: boolean;
    /** skipInterval() cut an interval inside the trace (that frame has intervalMs 0). */
    gap: boolean;
    /** Median of the last 15 intervals at the mark, or of the trace's own intervals while fewer than 15 were seen. */
    medianMs: number;
    maxIntervalMs: number;
    /** maxIntervalMs / medianMs. */
    maxFactor: number;
    /** Intervals in the trace at or above twice medianMs. */
    doubledIntervals: number;
    frames: NumericFrameTraceFrame[];
}
export interface NumericFrameSnapshot {
    format: 'bloom numeric frame metrics v2';
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
    /** Hitches seen since clear(), including ones pushed out of the store. */
    hitchTotal: number;
    hitches: NumericFrameHitch[];
    /** Traces started since clear(), including ones pushed out of the store. */
    traceTotal: number;
    traces: NumericFrameTrace[];
    frames: NumericFrameSample[];
}
export class FrameMetrics {
    constructor(options?: {
        capacity?: number;
        stages?: string[];
        counters?: string[];
        now?: () => number;
        hitch?: Partial<FrameHitchRule>;
        trace?: Partial<FrameTraceRule>;
    });
    readonly capacity: number;
    readonly samples: Float64Array;
    readonly current: Float64Array;
    readonly size: number;
    readonly sequence: number;
    readonly active: boolean;
    readonly hitchRule: Readonly<FrameHitchRule>;
    readonly hitchTotal: number;
    readonly traceRule: Readonly<FrameTraceRule>;
    readonly traceTotal: number;
    beginFrame(timestampMs: number): void;
    stage(name: string, durationMs: number): boolean;
    count(name: string, amount?: number): boolean;
    endFrame(): boolean;
    /** The next beginFrame does not link to the previous frame (hidden tab returning, resume from pause). An open trace keeps it and is flagged `gap`. */
    skipInterval(): void;
    clear(): void;
    /** Retained hitches, oldest first. Allocates per call. */
    hitches(): NumericFrameHitch[];
    /** Header line, then per hitch one frame line and one `before` line. Zero stages and counters are left out. */
    hitchText(options?: { limit?: number }): string;
    /** Retained traces, oldest first. Allocates per call. */
    traces(): NumericFrameTrace[];
    /**
     * Header line, then per trace a summary line (max interval, x median, intervals >= 2x median, `fixed` counters)
     * and one line of `offset intervalMs cpu=… stage=… counter=…` tokens. Zero values and fixed counters are left out of tokens.
     */
    traceText(options?: { limit?: number }): string;
    snapshot(options?: { limit?: number }): NumericFrameSnapshot;
}

export interface DebugScene {
    /** Advances the game by exactly one fixed tick. Required only when the URL carries `tick` or `step` is called. */
    step?(): void;
    /** Draws the current state without advancing the simulation. */
    render?(): void;
    /**
     * Game fields that describe what the screen shows; merged into `state()` after scene, params and tick.
     * `options` is whatever the caller passed to the host's `state(options)`; the host does not read it.
     */
    state?(options?: unknown): Record<string, unknown>;
    hash?(): unknown;
    dispose?(): void;
}
/** The virtual `performance.now` of one open scene. */
export interface DebugClock {
    /** Virtual milliseconds. Starts at the same fixed value on every open and moves only by `advance`. */
    now(): number;
    /** Moves the virtual clock forward (finite, non-negative ms), e.g. one fixed tick before each step. */
    advance(ms: number): void;
    /** Runs a synchronous operation with the real `performance.now` (tick timing) and returns its result. */
    realTime<T>(operation: () => T): T;
}
export interface DebugSceneContext {
    /**
     * Replaces `performance.now` with the virtual clock until the scene is disposed or fails to open, so the same
     * address draws the same picture. Repeat calls return the same clock. A scene that runs on real time does not call it.
     * Throws if more than 10,000,000 ms of real time have passed since page start, or another scene holds the clock.
     */
    freezeClock(): DebugClock;
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
    /** `options` reaches the scene's `state` as given. */
    state(
        options?: unknown,
    ): { scene: string | null; params: Record<string, string>; tick: number } & Record<string, unknown>;
    hash(): unknown;
    /** Disposes the scene and restores `performance.now` if the scene froze it. */
    dispose(): void;
}
/** Installs `window.__bloomDebug` when the URL has `debug`; returns null otherwise and replaces nothing. */
export function installDebugHost(options: {
    scenes: Record<
        string,
        (params: Record<string, string>, context: DebugSceneContext) => DebugScene | void | Promise<DebugScene | void>
    >;
    search?: string;
    target?: object;
}): DebugHost | null;
