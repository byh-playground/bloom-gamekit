import type { SurfaceMotion } from '../geometry';

/** 몸 열 `flags` 비트: 이번 스텝에 움직이고 지형과 닿음(죽었지만 궤적을 마치는 몸 포함). 스텝 안에서 바꾸지 않습니다. */
export const ACTIVE: 1;
/** 충격 속도(`ivx`·`ivy`)와 정수 잔여 변위(`rx`·`ry`)를 가진 몸. 아니면 조향 몸(속도 = 이번 틱 조향 변위 / dt). */
export const DYNAMIC: 2;
/** 몸-몸 접촉에 참여. 바꾸면 그 몸의 다음 cast부터 적용됩니다. */
export const PAIRS: 4;
/** 높이로 쌍이 갈릴 수 있음: 쌍의 한쪽이라도 켜 있으면 `z`(바닥 높이)와 지름을 비교합니다. */
export const VERTICAL: 8;
/** 겹침 풀기(`separate`)에 참여. */
export const SEPARATE: 16;

/** 관계 표 값: 서로 지나감. */
export const PASS: 0;
/** 접촉 큐에 넣지 않고 겹침 풀기에서 질량비로 일부만 밀어냄(아군). */
export const SOFT: 1;
/** 접촉 큐에 넣고 겹침 풀기에서 침투한 쪽을 완전히 밀어냄(적). */
export const SOLID: 2;

export const RESPONSE_NONE: 0;
export const RESPONSE_REFLECT: 1;
export const RESPONSE_SLIDE: 2;
export const RESPONSE_EXCHANGE: 3;
export const RESPONSE_STOP: 4;
export const RESPONSE_STICK: 5;
export const RESPONSE_BOUNCE: 6;
export type ContactResponse = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ContactSolverOptions {
    /** 지형·건물·맵 경계(게임이 이미 가진 geometry SurfaceMotion). `cast`·`solve`와 `field.width/height`만 씁니다. */
    surface: SurfaceMotion;
    /** 위치 격자 배율. 위치 열은 1/fixedPoint 단위 정수입니다(쌀콩팡 100). */
    fixedPoint: number;
    /** 동적 몸 잔여 변위의 정수 배율(쌀콩팡 10000). */
    remainderScale: number;
    /** 한 스텝에 푸는 몸-몸 접촉 수(0 이상 정수 또는 Infinity). 표면 접촉은 항상 풉니다. */
    pairBudget: number;
    /** 같은 0초 접촉 반복 한도(쌀콩팡 32). */
    maxZeroTimeRepeats: number;
    /** 기본 응답의 반발 계수(기본 0). */
    restitution?: number;
    /** 후보 격자 칸 한 변(월드 단위). 결과에는 영향이 없고 비용만 바뀝니다. */
    cellSize: number;
    /** SOFT 겹침 풀기에서 한 pass에 푸는 침투 비율(기본 0.8). */
    softFraction?: number;
    /** SOFT 겹침 풀기 최대 pass(기본 4). */
    softPasses?: number;
    /** SOLID 겹침 풀기 최대 pass(기본 4). */
    hardPasses?: number;
}

/** 한 스텝 동안만 쓰는 몸 열. 게임이 `begin` 뒤 `[0, count)`를 모두 채웁니다. */
export class ContactBodies {
    readonly count: number;
    readonly capacity: number;
    /** 입력: 틱 시작 위치(FP 정수). 스텝 중: 몸의 시간 기준점 위치. `end()` 뒤: 결과 위치. */
    x: Int32Array;
    y: Int32Array;
    /** 입력: 이번 틱 조향이 옮긴 자리(FP 정수). 조향 속도 = (steer - x) / FP / dt. 안 움직이면 x·y와 같게. 막히지 않은 조향 몸은 `end()` 뒤 정확히 이 자리입니다. */
    steerX: Int32Array;
    steerY: Int32Array;
    /** 모듈이 계산하는 궤적 속도(월드/초). 응답 중에 읽고 고칠 수 있습니다(고치면 `touched`). */
    vx: Float64Array;
    vy: Float64Array;
    /** DYNAMIC 몸의 충격 속도(FP/초 정수). 입력이자 결과. DYNAMIC이 아니면 0으로 둡니다. */
    ivx: Float64Array;
    ivy: Float64Array;
    /** DYNAMIC 몸의 잔여 변위(1/remainderScale FP 정수). 입력이자 결과. */
    rx: Int32Array;
    ry: Int32Array;
    radius: Float64Array;
    mass: Float64Array;
    /** 엔티티 번호(0 이상 안전 정수): 동률·대체 법선·미끄러짐 순위. 한 스텝 안에서 겹치지 않게. */
    key: Float64Array;
    /** 관계 표의 행·열. */
    group: Uint8Array;
    /** VERTICAL 몸의 바닥 높이(월드). */
    z: Float64Array;
    /** SOFT 겹침 풀기에서 한 pass에 움직일 수 있는 최대 거리(FP 정수, 1 이상으로 씀). */
    softCap: Int32Array;
    /** ACTIVE·DYNAMIC·PAIRS·VERTICAL·SEPARATE. `end()` 뒤 새로 켜진 DYNAMIC = 조향 몸이 맞아 동적이 됨. */
    flags: Uint8Array;
}

/** 재사용하는 접촉 하나. `next()`가 덮어씁니다. */
export class ContactEvent {
    i: number;
    /** 상대 몸, 표면이면 -1. 쌍은 동적 몸이 `i`(둘 다 같으면 작은 번호). */
    j: number;
    /** j → i 방향 단위 법선(표면이면 바깥쪽). */
    nx: number;
    ny: number;
    /** 스텝 안 시각(초). 두 몸은 이미 이 시각 위치에 있습니다. */
    t: number;
    /** 표면 접촉의 geometry 정수 접촉 키(쌍은 0). */
    key: number;
    /** 표면 접촉의 원 장애물 레코드, 아니면 null. */
    obstacle: unknown;
    /** 시간이 흐르지 않고 연속으로 같은 접촉을 만난 횟수(이 접촉 포함). 시간이 흐른 뒤 첫 접촉은 0. */
    repeats: number;
    /** repeats >= maxZeroTimeRepeats. */
    stuck: boolean;
    /** 마지막 응답. */
    response: ContactResponse;
    /** `exchange`가 주고받은 충격량(아니면 0). */
    impulse: number;
    /** 응답했는지. 응답 없이 다음 `next()`를 부르면 기본 응답이 적용됩니다. */
    handled: boolean;
}

export interface ContactStats {
    surfaceContacts: number;
    pairContacts: number;
    /** 예산을 넘어 풀지 않은 몸-몸 접촉. */
    skippedPairs: number;
    casts: number;
    groups: number;
    softMoves: number;
    hardMoves: number;
}

export class ContactSolver {
    constructor(options: ContactSolverOptions);
    pairBudget: number;
    maxZeroTimeRepeats: number;
    restitution: number;
    readonly stats: ContactStats;
    readonly bodies: ContactBodies;
    /** groups × groups 대칭 표(PASS·SOFT·SOLID). 복사합니다. */
    setRelations(groups: number, table: ArrayLike<number>): void;
    begin(count: number, dt: number): ContactBodies;
    /** 다음 접촉을 ev에 쓰고 true. 예산을 넘은 몸-몸 접촉은 건너뜀. 앞 접촉이 응답 없으면 기본 응답을 먼저 적용. */
    next(ev: ContactEvent): boolean;
    /** 기본 응답: 표면 = 동적 반사 / 조향 미끄러짐, 쌍 = 교환(조향끼리는 미끄러짐), stuck = 멈춤·붙기. */
    resolve(ev: ContactEvent): void;
    /** 접근 속도(양수 = 다가옴). 응답 전에 읽습니다. */
    closing(ev: ContactEvent): number;
    /** 반발 e 운동량 교환, 맞은 쪽 충격량 배율 gainI·gainJ. 조향 몸은 DYNAMIC으로. 주고받은 J, 멀어지는 쌍이면 0. */
    exchange(ev: ContactEvent, restitution: number, gainI?: number, gainJ?: number): number;
    /** DYNAMIC 몸의 표면 반사. */
    reflect(ev: ContactEvent, restitution: number): void;
    /** stuck 쌍에서 표시한 DYNAMIC 몸만 상대 접근 속도를 반사(둘 다면 반씩). 붙지 않음. */
    bounce(ev: ContactEvent, moveI: boolean, moveJ: boolean, restitutionI: number, restitutionJ?: number): void;
    /** 게임이 vx·vy·flags를 직접 고친 몸을 지금 묶음 끝에 다시 cast. */
    touched(i: number): void;
    /** 남은 접촉을 기본 응답으로 풀고 모든 몸을 dt까지 옮긴 뒤 지형 밖으로 복구. */
    end(): void;
    /** 위치 겹침 풀기: SOFT는 질량비 Jacobi, SOLID는 침투한 쪽 완전 분리, 단계마다 지형 복구. 옮긴 수. */
    separate(): number;
}

/** 0 이상 안전 정수 두 개의 32비트 낱말 FNV-1a(대체 법선 방향). */
export function pairHash(a: number, b: number): number;
