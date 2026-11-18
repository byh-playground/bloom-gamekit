/** simloop 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { Bytes } from '../deterministic/index.js';
import type { Profile, LocalInputState, LocalCapture } from '../rollback/index.js';
export interface LoopSession {
    readonly inputSize: number;
    readonly profile: Pick<Profile, 'tickRate' | 'maxCatchupSteps'>;
    readonly closed: boolean;
    readonly resimulating: boolean;
    readonly pace: number;
    poll(): void;
    advance(input?: Bytes): { status: string; tick: number };
    releaseInput(): void;
    /** submitInput 또는 inputPreview를 쓸 때 필요. RoomSession은 core가 없으면 null. */
    readonly localCaptureSequence?: number | null;
    readLocalCaptures?(afterSequence: number, out: LocalCapture[]): LocalCapture[];
    readonly epoch?: number;
    readonly baseTick?: number;
}
export interface PreviewEntity {
    id: string;
    generation: number;
    source: object;
    type?: Function;
}
export interface PreviewFork {
    restore?(snapshot: unknown): void;
    step(
        input: unknown,
        context: {
            sequence?: number;
            tick: number;
            epoch: number;
            commands: Array<{
                observationId?: number;
                sequence: number | null;
                executeTick?: number;
                payload: unknown;
            }>;
            speculative: true;
            replay?: boolean;
            gap?: boolean;
            confirmedReplay?: boolean;
        },
    ): void;
}
export interface LocalInputPreviewOptions {
    stepMs?: number;
    createFork(snapshot: unknown): PreviewFork;
    cloneSnapshot?(snapshot: unknown): unknown;
    captureSnapshot?(): unknown;
    readEntities(fork: PreviewFork): PreviewEntity[];
    presentation?: {
        selectPreview(ids: Array<{ id: string; generation: number }>): void;
        capturePreview(packet: object, nowMs: number): boolean;
        clearPreview?(): void;
    };
    maxPendingInputs?: number;
    maxFutureTicks?: number;
    maxAgeMs?: number;
}
export interface LoopInputSubmission {
    sequence: number;
    captureTick: number;
    executeTick: number;
    boundaryTick: number;
    epoch: number;
    timeMs: number;
    commands: Array<{ observationId?: number; sequence: number; executeTick: number; payload: Bytes }>;
}
export interface ObservingLoop {
    start(): void;
    stop(): void;
    pulse(timestamp: number, options?: { render?: boolean; input?: boolean }): void;
    /** rAF 한 번분. timestamp는 RAF timestamp입니다. 그렸으면 true, 프레임 제한이 건너뛰었거나 진행이 실패했으면 false. */
    frame(timestamp: number): boolean;
    /** timestamp를 주면 그 시각이, 없으면 직전 프레임 시각이 render의 frameTimeMs가 됩니다. */
    render(timestamp?: number): void;
    observeInput(timestamp: number): unknown;
    flushInput(timestamp: number): unknown;
    pollInput(timestamp: number): unknown;
    releaseInput(): void;
    resetTiming(): void;
    readonly running: boolean;
    /** 현재 완료된 틱 경계의 예정 시각. 초기화 전에는 null. */
    readonly simulationTimeMs: number | null;
    readonly nextDeadlineMs: number | null;
    readonly rates: ReturnType<typeof clockRates> | null;
}
/** 화면 프레임 제한 판정. RAF를 소유하지 않습니다. */
export class FramePacer {
    constructor(options: { minHz: number });
    /** RAF timestamp를 받아 이 프레임을 그릴지 답합니다(true면 그린 것으로 기록). */
    accept(timestampMs: number): boolean;
    /** RAF를 멈췄다 다시 시작할 때 부릅니다. 멈춘 동안의 간격을 표본에 넣지 않습니다. */
    rebase(): void;
    /** 추정한 화면 주사 간격(ms). 표본 15개가 차기 전에는 0. */
    readonly refreshMs: number;
    /** 화면 주사 몇 번마다 그리는지. */
    readonly stride: number;
}
export class LocalInputPreview {
    constructor(options: LocalInputPreviewOptions);
    readonly pendingCount: number;
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly metrics: Readonly<Record<string, number>>;
    reconcile(checkpoint: {
        snapshot: unknown;
        input?: unknown;
        revision: number;
        tick: number;
        epoch: number;
        continuationKey?: string;
        confirmedCommandSequence?: number;
        timeMs: number;
        mode?: 'continuous' | 'rollback' | 'load' | 'reset' | 'teleport' | 'join' | 'resync';
        reset?: boolean;
    }): boolean;
    continueFromCheckpoint(checkpoint: {
        input: unknown;
        revision: number;
        tick: number;
        epoch: number;
        continuationKey: string;
        confirmedCommandSequence?: number;
        timeMs: number;
    }): boolean;
    advanceConfirmedCheckpoint(checkpoint: {
        input: unknown;
        revision: number;
        tick: number;
        epoch: number;
        continuationKey: string;
        confirmedCommandSequence?: number;
        timeMs: number;
    }): boolean;
    observe(
        input: unknown,
        metadata: {
            sequence: number;
            tick: number;
            epoch: number;
            timeMs: number;
            continuationKey?: string;
            commands?: Array<{ observationId: number; sequence: number | null; payload: Bytes }>;
        },
    ): boolean;
    commit(
        capture: NonNullable<LocalInputState['capture']> & { boundaryTick?: number; predict?: boolean },
        nowMs: number,
    ): boolean;
    cancelObservation(nowMs: number): void;
    clockGap(): boolean;
    clear(): void;
    setEnabled(enabled: boolean): void;
    dispose(): void;
}
export function createLoop<S extends LoopSession>(options: {
    session: S & { queueCommand?: (payload: Bytes) => number };
    /** 주면 clockRates로 검사합니다(tickRate는 session에서). */
    rates?: { baseHz: number; inputHz: number };
    /** 프레임 제한. 화면 주사의 정수 배 가운데 minHz 이상인 가장 낮은 빈도로 그립니다. 없으면 RAF마다 그립니다. */
    frame?: { minHz: number };
    backlogPolicy?: 'drop' | 'retain' | 'defer';
    maxBacklogTicks?: number;
    onBacklogDrop?: (event: {
        elapsedMs: number;
        droppedMs?: number;
        droppedTicks: number;
        timestamp: number;
        reason?: 'clock-gap' | 'input-dt-clamp' | 'backlog-overflow' | 'drop-policy';
    }) => void;
    getInput?: () =>
        Bytes | { input: Bytes; commands?: Array<{ payload: Bytes }>; continuationKey?: string; predict?: boolean };
    beforeFrame?: (timestamp: number) => void;
    canAdvance?: () => boolean;
    canObserveInput?: () => boolean;
    /** tickTimeMs: 방금 끝난 틱의 예정 시각. 표시 capture의 nowMs로 그대로 넘깁니다. */
    onAdvance?: (
        result: ReturnType<S['advance']>,
        submission: LoopInputSubmission | undefined,
        tickTimeMs: number,
    ) => void;
    onPreviewError?: (error: unknown) => void;
    inputPreview?: Pick<LocalInputPreview, 'observe' | 'commit' | 'clear' | 'enabled'> &
        Partial<Pick<LocalInputPreview, 'clockGap'>>;
    /** frameTimeMs: 이 그리기의 화면 프레임 시각. 표시 frame(nowMs)에 그대로 넘깁니다. loop.render()를 프레임 없이 먼저 부르면 null. */
    render?: (context: { session: S; alpha: number; resimulating: boolean; frameTimeMs: number | null }) => void;
    onError?: (error: unknown) => void;
    onInputRelease?: () => void;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
}): ObservingLoop;
export function createDeadlineScheduler(options: {
    getIntervalMs: () => number;
    pulse: (timestamp: number, info: { due: number; scheduledAtMs: number | null }) => void;
    maxBacklogTicks?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    onGap?: (gap: { elapsedMs: number; droppedTicks: number; timestamp: number; scheduledAtMs: number }) => void;
}): {
    start(): void;
    stop(): void;
    wake(): void;
    rebase(nowMs?: number): void;
    readonly running: boolean;
    readonly deadlineMs: number | null;
};

export function clockRates(options: { baseHz: number; tickRate: number; inputHz: number }): Readonly<{
    baseHz: number;
    tickRate: number;
    inputHz: number;
    simulationDivisor: number;
    inputDivisor: number;
}>;
