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
/**
 * ms로 적은 시간 값을 틱에 반영하는 도우미(DEV-035). 누적값은 단위 "ms × tickRate"의 평범한 정수라
 * 게임 상태에 넣으면 스냅샷·롤백·상태 해시에 그대로 들어갑니다. 모든 메서드는 할당하지 않습니다.
 * ms 인자는 정수여야 하고(주기는 양수, 나머지는 0 이상) ms × tickRate가 안전 정수를 넘으면 RangeError입니다.
 */
export interface TickTime {
    readonly tickRate: number;
    /** 한 틱의 ms(1000 / tickRate, 소수 가능). 표시·보간 전용이며 시뮬레이션 판정에 쓰지 않는다. */
    readonly stepMs: number;
    /** 주기 누적값을 한 틱 진행해 새 값을 돌려준다. 이번 틱에 n번 들어가면 fn(arg)를 n번 부른다. 나머지는 이월. */
    every<T>(acc: number, periodMs: number, fn?: (arg: T) => void, arg?: T): number;
    /** every와 같은 누적값을 돌려주되 fn(arg)는 이번 틱에 많아야 한 번 부른다. */
    everyOnce<T>(acc: number, periodMs: number, fn?: (arg: T) => void, arg?: T): number;
    /** 이번 틱에 주기가 들어가는 횟수. 같은 틱의 every(acc, periodMs)보다 먼저 부른다. */
    fires(acc: number, periodMs: number): number;
    /** 지속·지연·쿨다운의 "남은 시간" 값을 만든다. 0ms는 끝난 값 0. */
    start(ms: number): number;
    /** 남은 시간을 한 틱 줄인다(0에서 멈춤). 이번 틱에 0이 되면 fn(arg)를 한 번 부른다. */
    advance<T>(remaining: number, fn?: (arg: T) => void, arg?: T): number;
    /** 끝났거나 시작하지 않은 값인지. */
    done(remaining: number): boolean;
    /** 남은 ms(소수 가능). 표시 전용. */
    remainingMs(remaining: number): number;
    /** 길이 totalMs로 시작한 값의 지난 ms(소수 가능). 표시 전용. */
    elapsedMs(remaining: number, totalMs: number): number;
    /** ms를 덮는 최소 틱 개수(올림). 틱 개수를 요구하는 외부 API 경계에서만 쓴다. ms 시각을 지난 첫 틱 번호와 같다. */
    ceilTicks(ms: number): number;
    /** 틱 번호의 경과 ms(소수 가능). 표시 전용. */
    tickToMs(tick: number): number;
}
/** 틱 수는 여기 한 곳에서만 받는다. simloop clockRates() 결과도 그대로 받는다. */
export function tickTime(options: { tickRate: number }): TickTime;
export function statelessRandom(seed: number, eventId: number): number;
export function hashBytes(value: Bytes, seed?: number): number;
/** 호출마다 새 배열을 만들지 않고 이어 쓰는 재사용 버퍼. `bytes`는 자랄 때 바뀌므로 보관하지 않는다. */
export class ByteBuffer {
    constructor(capacity?: number);
    readonly bytes: Uint8Array;
    readonly length: number;
    reset(): this;
    /** 뒤에 size bytes 자리를 확보하고 쓰기 시작 위치를 돌려준다. 길이는 쓰는 쪽이 늘린다. */
    reserve(size: number): number;
    write(data: Bytes): this;
    /** 쓴 범위의 보기. 다음 reset·write 전까지만 유효하다. */
    view(): Uint8Array;
    /** 쓴 범위의 독립 복사본. */
    copy(): Uint8Array;
    /** 쓴 범위를 넘기고 새 공간으로 바꾼다(남는 공간이 1/8보다 크면 복사). 길이는 0이 된다. */
    take(): Uint8Array;
}
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
    /** 새 bytes 복사본. */
    encode(value: CodecValue): Uint8Array;
    /** encode와 같은 bytes를 `out` 끝에 이어 쓴다(새 배열 없음). maxBytes는 이번 값의 길이에 적용한다. */
    encodeInto(value: CodecValue, out: ByteBuffer): ByteBuffer;
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
