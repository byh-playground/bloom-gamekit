export interface BootState {
    /** The stage that changed last; null before any stage begins. */
    readonly stage: string | null;
    readonly completed: number;
    /** null while the stage total is unknown. */
    readonly total: number | null;
    /** 0..1, never decreases. Sum of weight × completed/total over stages ÷ sum of weights; an unknown-total stage counts 0 until finished. */
    readonly overall: number;
    /** Set once by `fail()`. */
    readonly failed?: Error;
}
export interface Boot {
    readonly state: BootState;
    /** Adds a listener; returns a function that removes it. */
    subscribe(listener: (state: BootState) => void): () => void;
    /** Starts a stage once. `total` is the real count of work items, or null when unknown. 0 finishes it at once. */
    begin(stage: string, total?: number | null): void;
    /** Adds `count` (default 1) completed items. Reaching `total` finishes the stage. */
    advance(stage: string, count?: number): void;
    /** Finishes a begun stage. A known total must already be reached. */
    finish(stage: string): void;
    /** Ends loading: overall becomes 1. Later calls are ignored. */
    complete(): void;
    /** Ends loading as failed: `state.failed` is set. Later calls are ignored. Retry is a full page reload. */
    fail(error: unknown): void;
    /**
     * Begins `stage` with the unique URL count and fetches every URL in parallel with `<link rel=modulepreload>`,
     * advancing once per loaded file. Use the same URLs a later import() resolves to so the module map is reused.
     * Rejects after all settle when any failed.
     */
    preloadModules(urls: string[], options: { stage: string }): Promise<void>;
}
export function createBoot(options: {
    /** Weight is the stage's share of the overall bar. */
    stages: { id: string; weight: number }[];
    onChange?: (state: BootState) => void;
}): Boot;
/** Draws `overall` into a `<progress>` and `text(state)` into `label`. Returns an unbind function. */
export function bindBootProgress(
    boot: Boot,
    options: { progress: HTMLProgressElement; label?: Element | null; text?: (state: BootState) => string },
): () => void;
/** Resolves after the next paint opportunity, or after 80ms when rAF is paused (hidden tab). */
export function yieldFrame(): Promise<void>;
