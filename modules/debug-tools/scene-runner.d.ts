import type { BrowserType, Page } from 'playwright';

/** One checkout served for the scene runner. */
export interface DebugSceneSite {
    /** The scene page; the runner appends `?debug=1&<query>` (or `&debug=1&…` when it already has a query). */
    url: string;
    /** Called on each new page before it loads, e.g. to fulfil the pinned GameKit files from the local cache. */
    route?(page: Page): unknown;
    close(): unknown;
}
export interface DebugSceneHeap {
    /** Estimated bytes allocated (collected ones included) by `step(ticks)`, which renders once at the end. */
    stepBytes: number;
    /** Estimated bytes allocated by `step(0)`: one render of the same state. */
    renderBytes: number;
    /** `(stepBytes - renderBytes) / ticks`, rounded. */
    perTickBytes: number;
}
export interface DebugSceneRun {
    side: 'A' | 'B';
    round: number;
    root: string;
    commit: string;
    /** True when the checkout had uncommitted changes. */
    dirty: boolean;
    query: string;
    gpu: 'swiftshader' | 'd3d11';
    /** `__bloomDebug.state(--state)` after the ticks. */
    state: Record<string, unknown>;
    /** `__bloomDebug.hash()`, null when the scene has none. */
    hash: unknown;
    heap?: DebugSceneHeap;
    capture?: string;
    pageErrors?: string[];
}

/**
 * Types for `dist/debug-scene.mjs`. Opens one debug scene address per run, prints its state (or, with `--compare` /
 * `--compare-query`, a table of both sides in alternating rounds) and resolves with every run. A tool, not a test.
 *
 * Arguments: `"<query>" [--ticks N] [--state <json>] [--capture out.png] [--compare <checkout>]
 * [--compare-query "<query>"] [--repeat N] [--heap] [--gpu] [--json]`.
 */
export function runDebugScene(options: {
    /** Playwright `chromium`, passed in so this module never resolves the game's node_modules. */
    chromium: BrowserType;
    /** Command-line arguments, usually `process.argv.slice(2)`. */
    argv: string[];
    /** This checkout. `--compare` paths resolve against the current working directory. */
    root: string;
    /** Serves one checkout. Called once per distinct checkout; closed when the runner ends. */
    serve(root: string): Promise<DebugSceneSite>;
    /** Extra page condition to wait for after `__bloomDebug.ready`, e.g. a loading screen being gone. */
    ready?: () => unknown;
    /** State paths shown in the compare table, dot separated (`'tickMs.mean'`). */
    fields?: string[];
    viewport?: { width: number; height: number };
}): Promise<DebugSceneRun[]>;
