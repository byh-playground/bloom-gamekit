export type SchedulerKey = string | number;
export type SchedulerPriority = 0 | 1 | 2;

export interface BudgetedStepContext {
    /** Current canonical game tick. */
    tickId: number;
    /** Stable caller key for this work item. */
    key: SchedulerKey;
    /** Maximum caller-defined work units available in this synchronous quantum. */
    maxUnits: number;
}

export interface BudgetedStepResult<Result = unknown> {
    /** True when this item has no further work. */
    done: boolean;
    /** Work units actually consumed; each invoked quantum must consume at least one. */
    unitsUsed: number;
    /** Optional completed result passed to onComplete. */
    result?: Result;
}

export interface BudgetedSchedulerRequest<Result = unknown> {
    key: SchedulerKey;
    /** Entity or lifecycle owner used by cancelOwner(). */
    owner?: unknown;
    /** 0 is low, 1 is standard, and 2 is urgent. */
    priority?: SchedulerPriority;
    step(context: BudgetedStepContext): BudgetedStepResult<Result>;
    /** O(1) game-owned validity check before work and before result delivery. */
    isValid?(): boolean;
    /** Keep bounded; validate the result and perform any atomic reservation here. */
    onComplete?(completion: { key: SchedulerKey; owner: unknown; result: Result | undefined }): void;
}

export interface BudgetedSchedulerMetrics {
    ticks: number;
    jobsQueued: number;
    jobsMerged: number;
    jobsCompleted: number;
    jobsCancelled: number;
    queueDepth: number;
    activeJobs: number;
    pendingJobs: number;
    activeByPriority: number[];
    unitsProcessed: number;
    throughputUnitsPerTick: number;
    throughputUnitsPerSecond: number;
    waitedJobs: number;
    waitingTicksTotal: number;
    averageWaitTicks: number;
    maxWaitTicks: number;
    budgetExhaustions: number;
    lastTickId: number | null;
    lastTickUnits: number;
    lastTickCompleted: number;
    lastTickWaitedJobs: number;
    lastTickWaitingTicks: number;
    lastTickMaxWaitTicks: number;
    lastTickBudgetExhausted: boolean;
    lastTickMs: number;
    totalTickMs: number;
    maxTickMs: number;
}

export interface BudgetedScheduler {
    /** Adds work, or merges an active duplicate key and raises its priority. Returns true only for a new job. */
    enqueue<Result = unknown>(request: BudgetedSchedulerRequest<Result>): boolean;
    /** Cancels one active key. */
    cancel(key: SchedulerKey): boolean;
    /** Cancels every active job owned by the supplied identity and returns the count. */
    cancelOwner(owner: unknown): number;
    /** Runs up to unitsPerTick units. Must be called once from each logical tick. */
    tick(tickId: number): number;
    /** Cancels queued work and releases owners, keys, callbacks, and reusable buffers. */
    dispose(): void;
    /** Allocates a frozen metrics snapshot only when read. */
    readonly metrics: Readonly<BudgetedSchedulerMetrics>;
}

/**
 * Creates a deterministic budgeted scheduler. The fixed work-unit limit selects work;
 * elapsed milliseconds are diagnostics only and cannot change job order or results.
 */
export function createBudgetedScheduler(options?: {
    /** Total candidate/work units available during one logical tick. Default: 24. */
    unitsPerTick?: number;
    /** Per-job bounded synchronous quantum. Default: 1. */
    quantumUnits?: number;
    /** Monotonic diagnostics clock. Defaults to performance.now; never controls scheduling. */
    now?: () => number;
}): BudgetedScheduler;
