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
  installGlobal(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, options?: {
    onReport?: (record: DiagnosticRecord | null) => void;
  }): () => void;
  clear(): void;
  dispose(): void;
}

export function redactDiagnostic(value: unknown, limit?: number): string;

export type ProfilePrimitive = string | number | boolean | null;
export type ProfileMetadata = Record<string, ProfilePrimitive>;
export interface PerformanceProfilerOptions {
  capacity?: number;
  now?: () => number;
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
  | { copied: true; method: 'clipboard' }
  | { copied: false; method: 'selection' | 'text'; text: string };
export function copyDiagnostic(text: string, options?: {
  clipboard?: DiagnosticClipboard;
  textarea?: DiagnosticTextarea;
}): Promise<CopyDiagnosticResult>;

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
export function compareStateFields<T>(left: T, right: T, fields: StateField<T>[], options?: {
  maxDifferences?: number;
}): StateFieldComparison;
