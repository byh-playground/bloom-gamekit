/** simloop 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { Bytes } from '../deterministic/index.js';
import type { Profile, LocalInputState } from '../rollback/index.js';
export interface LoopSession {
  readonly inputSize: number; readonly profile: Pick<Profile, 'tickRate' | 'maxCatchupSteps'>;
  readonly closed: boolean; readonly resimulating: boolean; readonly pace: number;
  poll(): void; advance(input?: Bytes): { status: string; tick: number }; releaseInput(): void;
}
export interface PreviewEntity { id: string; generation: number; source: object; type?: Function; }
export interface PreviewFork {restore?(snapshot:unknown):void;step(input: unknown, context: { sequence?: number; tick: number; epoch: number; commands: Array<{observationId?:number;sequence:number|null;executeTick?:number;payload: unknown}>; speculative: true; replay?: boolean;gap?:boolean;confirmedReplay?:boolean }): void; }
export interface LocalInputPreviewOptions {
  stepMs?: number;
  createFork(snapshot: unknown): PreviewFork; cloneSnapshot?(snapshot: unknown): unknown; captureSnapshot?(): unknown; readEntities(fork: PreviewFork): PreviewEntity[];
  presentation?: { selectPreview(ids: Array<{ id: string; generation: number }>): void; capturePreview(packet: object, nowMs: number): boolean; clearPreview?(): void };
  maxPendingInputs?: number; maxFutureTicks?: number; maxAgeMs?: number;
}
export interface LoopInputSubmission {sequence:number;captureTick:number;executeTick:number;boundaryTick:number;epoch:number;timeMs:number;commands:Array<{observationId?:number;sequence:number;executeTick:number;payload:Bytes}>;}
export interface ObservingLoop {start():void;stop():void;pulse(timestamp:number, options?:{render?:boolean;input?:boolean}):void;render():void;observeInput(timestamp:number):unknown;flushInput(timestamp:number):unknown;pollInput(timestamp:number):unknown;releaseInput():void;resetTiming():void;readonly running:boolean;}
export class LocalInputPreview {
  constructor(options: LocalInputPreviewOptions);
  readonly pendingCount: number; readonly enabled: boolean; readonly ready:boolean; readonly metrics: Readonly<Record<string, number>>;
  reconcile(checkpoint: {snapshot:unknown;input?:unknown;revision:number;tick:number;epoch:number;continuationKey?:string;confirmedCommandSequence?:number;timeMs:number;mode?:'continuous'|'rollback'|'load'|'reset'|'teleport'|'join'|'resync';reset?:boolean}):boolean;
  continueFromCheckpoint(checkpoint:{input:unknown;revision:number;tick:number;epoch:number;continuationKey:string;confirmedCommandSequence?:number;timeMs:number}):boolean;
  advanceConfirmedCheckpoint(checkpoint:{input:unknown;revision:number;tick:number;epoch:number;continuationKey:string;confirmedCommandSequence?:number;timeMs:number}):boolean;
  observe(input:unknown,metadata:{sequence:number;tick:number;epoch:number;timeMs:number;continuationKey?:string;commands?:Array<{observationId:number;sequence:number|null;payload:Bytes}>}):boolean;
  commit(capture:NonNullable<LocalInputState['capture']>&{boundaryTick?:number;predict?:boolean},nowMs:number):boolean;
  cancelObservation(nowMs:number):void; clockGap():boolean;
  clear(): void; setEnabled(enabled: boolean): void; dispose(): void;
}
export function createLoop<S extends LoopSession>(options: { session: S & { queueCommand?: (payload: Bytes) => number }; backlogPolicy?: 'drop' | 'retain' | 'defer'; maxBacklogTicks?: number; onBacklogDrop?: (event: {elapsedMs:number;droppedMs?:number;droppedTicks:number;timestamp:number;reason?:'clock-gap'|'backlog-overflow'}) => void; getInput?: () => Bytes | { input: Bytes; commands?: Array<{ payload: Bytes }>; continuationKey?: string; predict?: boolean }; beforeFrame?: (timestamp: number) => void; canAdvance?: () => boolean; canObserveInput?:()=>boolean; onAdvance?: (result: ReturnType<S['advance']>, submission?: LoopInputSubmission) => void; onPreviewError?: (error: unknown) => void; inputPreview?: Pick<LocalInputPreview, 'observe' | 'commit' | 'clear' | 'enabled'> & Partial<Pick<LocalInputPreview,'clockGap'>>; render?: (context: { session: S; alpha: number; resimulating: boolean }) => void; onError?: (error: unknown) => void; onInputRelease?: () => void; requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (handle: number) => void }): ObservingLoop;
export function createDeadlineScheduler(options:{getIntervalMs:()=>number;pulse:(timestamp:number,info:{due:number;scheduledAtMs:number|null})=>void;maxBacklogTicks?:number;now?:()=>number;setTimer?:(callback:()=>void,delayMs:number)=>unknown;clearTimer?:(handle:unknown)=>void;onGap?:(gap:{elapsedMs:number;droppedTicks:number;timestamp:number;scheduledAtMs:number})=>void}):{start():void;stop():void;wake():void;rebase(nowMs?:number):void;readonly running:boolean;readonly deadlineMs:number|null};

export function clockRates(options: {baseHz:number;tickRate:number;inputHz:number;renderHz:number}): Readonly<{baseHz:number;tickRate:number;inputHz:number;renderHz:number;simulationDivisor:number;inputDivisor:number;renderDivisor:number}>;
