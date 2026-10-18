/** deterministic 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { PlayerId, Command, PlayerInput, SimulationAdapter } from '../rollback/index.js';
export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView;
export interface SyncTestOptions {
    adapter: SimulationAdapter;
    players: PlayerId[];
    inputSize: number;
    tickRate?: number;
    initialTick?: number;
    checkDistance?: number;
    maxSnapshotBytes?: number;
    maxHistoryBytes?: number;
    now?: () => number;
}
export interface SyncTestMetrics {
    readonly status: 'running' | 'failed' | 'closed';
    readonly tick: number;
    readonly checkDistance: number;
    readonly checkedTicks: number;
    readonly resimulatedTicks: number;
    readonly stateHash: number | null;
    readonly historyBytes: number;
    readonly forwardCostMs: number;
    readonly resimulationCostMs: number;
    readonly totalCostMs: number;
    readonly failure: Readonly<{
        name: string;
        message: string;
        code: string | null;
        tick: number | null;
        checkpointTick: number | null;
        firstDifference: number | null;
        expectedHash: number | null;
        actualHash: number | null;
    }> | null;
}
export type LocalTestInput = { playerId: PlayerId; input: Uint8Array; commands?: Command[] };
export class DeterminismError extends Error {
    constructor(detail: {
        tick: number;
        checkpointTick: number;
        expected: Uint8Array;
        actual: Uint8Array;
        inputs: PlayerInput[];
    });
    readonly syncTestMetrics?: SyncTestMetrics;
    readonly code: 'determinism-mismatch';
    readonly tick: number;
    readonly checkpointTick: number;
    readonly firstDifference: number;
    readonly expectedHash: number;
    readonly actualHash: number;
    readonly expectedState: Uint8Array;
    readonly actualState: Uint8Array;
    readonly inputs: PlayerInput[];
}
export class SyncTestSession {
    constructor(options: SyncTestOptions);
    readonly tick: number;
    readonly status: 'running' | 'failed' | 'closed';
    readonly failure: unknown;
    readonly checkedTicks: number;
    readonly resimulatedTicks: number;
    readonly metrics: SyncTestMetrics;
    advance(inputs: LocalTestInput[]): { tick: number; checkedTicks: number; resimulatedTicks: number };
    getStateHash(): number | undefined;
    close(): void;
}
export function createSyncTestSession(options: SyncTestOptions): SyncTestSession;
export function runSyncTest(options: SyncTestOptions & { frames: { tick: number; inputs: LocalTestInput[] }[] }): {
    tick: number;
    checkedTicks: number;
    resimulatedTicks: number;
    hash: number;
    metrics: SyncTestMetrics;
};
export function runSyncTestAsync(
    options: SyncTestOptions & {
        frames: { tick: number; inputs: LocalTestInput[] }[];
        yieldControl?: () => void | Promise<void>;
        signal?: AbortSignal;
    },
): Promise<{ tick: number; checkedTicks: number; resimulatedTicks: number; hash: number; metrics: SyncTestMetrics }>;
export class SeededPRNG {
    constructor(seed?: number);
    state: number;
    nextUint32(): number;
    nextInt(bound: number): number;
}
export interface PseudoRandomDistributionState {
    readonly version: 1;
    readonly probability: number;
    readonly consecutiveFailures: number;
    readonly pendingTrials: number;
}
export interface PseudoRandomDistributionJobState {
    readonly version: 1;
    readonly totalTrials: number;
    readonly processedTrials: number;
    readonly remainingTrials: number;
    readonly successes: number;
    readonly distributionState: PseudoRandomDistributionState;
    readonly rngState: number;
}
export interface PseudoRandomDistributionJobStep {
    readonly done: boolean;
    /** 평가한 성공 간격 수입니다. 각 단위에서 RNG 표본과 누적분포 조회는 최대 한 번입니다. */
    readonly unitsUsed: number;
    readonly processedTrials: number;
    readonly remainingTrials: number;
    readonly successes: number;
}
export interface PseudoRandomDistributionJob {
    readonly done: boolean;
    readonly processedTrials: number;
    readonly remainingTrials: number;
    readonly successes: number;
    /** 성공 간격을 maxUnits회 이하로 평가합니다. */
    step(maxUnits: number): PseudoRandomDistributionJobStep;
    /** PRD·SeededPRNG 상태, 추첨 cursor, 누적 성공 수를 저장합니다. */
    capture(): PseudoRandomDistributionJobState;
    /** 현재 PRD/RNG 상태를 유지하면서 job 점유만 해제합니다. */
    dispose(): void;
}
export interface Uint32RandomSource {
    nextUint32(): number;
}
export class PseudoRandomDistribution {
    /** 확률은 0 또는 0.0001~1이어야 합니다. RNG 소유권은 호출자에게 있습니다. */
    constructor(options: { probability: number; rng: Uint32RandomSource });
    readonly probability: number;
    readonly consecutiveFailures: number;
    roll(): boolean;
    /** 표본화한 실패 간격을 건너뛰며 배치의 성공 횟수를 반환합니다. */
    rollMany(draws: number): number;
    /** 예산형 집계 job을 만듭니다. 재개 기능은 rng.state에 쓰기 가능한 own uint32 속성이 필요합니다. */
    createRollJob(draws: number): PseudoRandomDistributionJob;
    /** 저장한 job snapshot에서 PRD와 RNG 진행을 함께 복원합니다. */
    restoreRollJob(state: PseudoRandomDistributionJobState): PseudoRandomDistributionJob;
    setProbability(probability: number): void;
    capture(): PseudoRandomDistributionState;
    restore(state: PseudoRandomDistributionState): void;
    reset(): void;
    dispose(): void;
}
export function statelessRandom(seed: number, eventId: number): number;
export function hashBytes(value: Bytes, seed?: number): number;
export const fixedPoint: Readonly<{
    scale: number;
    fromNumber(x: number): number;
    toNumber(x: number): number;
    add(a: number, b: number): number;
    sub(a: number, b: number): number;
    mul(a: number, b: number): number;
    div(a: number, b: number): number;
}>;
/** 바이너리 코덱은 Uint8Array 외에 아래 정수·실수 typed array도 받습니다. 실수 요소는 유한해야 하며 -0은 0이 됩니다. */
export type CodecTypedArray =
    Int8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
export type CodecValue =
    null | boolean | number | string | Uint8Array | CodecTypedArray | CodecValue[] | { [key: string]: CodecValue };
export interface ValueCodec {
    readonly format: 'binary' | 'json';
    encode(value: CodecValue): Uint8Array;
    decode(bytes: Bytes): CodecValue;
}
export function createValueCodec(options?: {
    format?: 'binary' | 'json';
    maxBytes?: number;
    maxDepth?: number;
    maxEntries?: number;
    /** true이면 값이 undefined인 레코드 키를 건너뜁니다. 기본은 undefined를 거부합니다. */
    omitUndefined?: boolean;
}): ValueCodec;
export const binaryCodec: ValueCodec;
export const jsonCodec: ValueCodec;
