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
export type CodecValue = null | boolean | number | string | Uint8Array | CodecValue[] | { [key: string]: CodecValue };
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
}): ValueCodec;
export const binaryCodec: ValueCodec;
export const jsonCodec: ValueCodec;
