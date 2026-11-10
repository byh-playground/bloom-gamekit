export interface Point {
    x: number;
    y: number;
}

/** 축에 평행한 경계 상자. {@link BoundsIndex}에 넣는 항목이 갖춰야 합니다. */
export interface Bounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

// ---------- 점·선분·다각형·폴리라인 수학 ----------

/** 단순 다각형(자기 교차 없음) 안인지 짝수-홀수 규칙으로 판정합니다. 꼭짓점이 3개 미만이면 false, 경계 위는 정해지지 않습니다. */
export function pointInSimplePolygon(x: number, y: number, points: Point[]): boolean;
/** 점에서 선분 AB까지의 최단 거리. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number;
/** 점에서 폴리라인까지의 최단 거리. 선분이 없으면 1e9. */
export function pointPolylineDistance(px: number, py: number, points: Point[]): number;
/** 선분 AB와 CD의 교차(끝점 접촉 포함). 평행하면 겹쳐 있어도 false. */
export function segmentsIntersect(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
): boolean;
/** 선분 AB와 CD 사이의 최단 거리. 교차하면 0. */
export function segmentDistance(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
): number;
/** 선분이 닫힌 직사각형에 닿는지(거의 닿음 포함). */
export function segmentTouchesRect(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
): boolean;
/** 다각형 가장자리 중 하나라도 직사각형에 닿는지. */
export function polygonTouchesRect(points: Point[], x0: number, y0: number, x1: number, y1: number): boolean;
/** 두 다각형이 겹치는지(한쪽 꼭짓점이 다른 쪽 안이거나 가장자리 사이 거리 0.001 미만). */
export function polygonsOverlap(a: Point[], b: Point[]): boolean;
/** 두 다각형 가장자리끼리 닿거나 0.001 안으로 가까운지. */
export function boundariesCross(a: Point[], b: Point[]): boolean;
/** `points`로 `minX`·`maxX`·`minY`·`maxY`를 구해 항목에 붙이고 그 항목을 돌려줍니다. */
export function assignBounds<T extends { points: Point[] }>(item: T): T & Bounds;
/** 폴리라인 위 t(0~1, 전체 길이 비율)의 점. 좌표는 정수로 반올림합니다. 점이 2개 미만이면 첫 점의 복사본 또는 {0, 0}. */
export function roundedPointOnPolyline(points: Point[], t: number): Point;
/** t 앞뒤 `delta`(기본 0.015) 두 점을 잇는 단위 접선(반올림한 점 기준). */
export function polylineTangentAt(points: Point[], t: number, delta?: number): Point;
/** (x, y)에 가장 가까운 폴리라인 위치를 전체 길이 비율(0~1)로. */
export function closestPolylineProgress(points: Point[], x: number, y: number): number;
/** Catmull-Rom 스플라인 p1→p2 구간의 t(0~1) 위치. */
export function catmullRomPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point;
/** 폴리라인을 구간마다 `steps`(기본 5)점씩 부드럽게 만듭니다. 점이 2개 미만이면 입력을 그대로 돌려줍니다. */
export function smoothPolylineCatmull(points: Point[], steps?: number): Point[];
/** 모든 꼭짓점을 평균 중심 쪽으로 `factor`(0~1)만큼 당긴 새 다각형. 꼭짓점이 3개 미만이면 입력을 그대로. */
export function insetPolygonTowardCenter(points: Point[], factor: number): Point[];
/** 폴리라인을 `halfWidth` 폭의 띠 다각형으로. `clampFn`은 가장자리 점마다 거칩니다. */
export function polylineToRibbonPolygon(
    points: Point[],
    halfWidth: number,
    clampFn?: ((point: Point) => Point) | null,
): Point[];
/** 두 점 사이의 거리. 좌표가 없거나 NaN이면 0으로 칩니다. */
export function pointDistance(a: Partial<Point> | null | undefined, b: Partial<Point> | null | undefined): number;
/** `items` 중 `point`에 가장 가까운 것까지의 거리. 항목이 없으면 Infinity. */
export function nearestPointDistance(
    point: Partial<Point> | null | undefined,
    items: Partial<Point>[] | null | undefined,
): number;
/** `items` 중 가장 가까운 두 점 사이의 거리. 짝이 없거나 유한하지 않으면 `none`(기본 Infinity). */
export function minPairDistance(items: Partial<Point>[] | null | undefined, none?: number): number;

// ---------- 색인·삼각분할 ----------

/** 경계 상자 항목을 고정 칸 격자에 넣어 범위로 후보를 찾는 AABB 버킷 색인(CSR: 칸별 시작 위치 + 항목 번호 배열). */
export class BoundsIndex<T extends Bounds = Bounds> {
    constructor(items: T[], cell?: number);
    readonly items: T[];
    readonly cell: number;
    /** 마지막 `query`가 돌려준 항목들의 항목 번호(`items`의 위치). 같은 순서이고 결과 길이까지만 유효합니다. */
    readonly found: Int32Array;
    /** 항목 목록을 바꿔 색인을 다시 채웁니다(버퍼는 모자랄 때만 키움). 덮는 칸이 2^22개를 넘으면 RangeError. */
    rebuild(items: T[]): void;
    /** 돌려주는 배열은 색인이 재사용하므로 다음 `query` 때 덮어씁니다. 칸 안은 항목 번호 순, 칸은 행 우선 순서입니다. */
    query(x0: number, y0: number, x1?: number, y1?: number, pad?: number): T[];
}
/** 단순 다각형의 귀 자르기 삼각분할. 결과는 `points` 객체 단위로 캐시하므로 고치지 않습니다. 나눌 수 없으면 오류를 던집니다. */
export function triangulatePolygon(points: Point[]): { convex: boolean; triangles: number[][] };

// ---------- 접촉 ----------

/** 접촉 키 종류: 다각형(장애물 번호 = 다각형 색인의 항목 번호). */
export const CONTACT_POLYGON: 0;
/** 접촉 키 종류: 원 장애물(장애물 번호 = 원의 정수 id). */
export const CONTACT_CIRCLE: 1;
/** 접촉 키 종류: 월드 경계(변 0 왼쪽, 1 오른쪽, 2 위, 3 아래). */
export const CONTACT_WALL: 2;
/** 접촉 키 종류: 게임이 직접 만드는 접촉(예: 유닛 쌍). */
export const CONTACT_USER: 3;
/** 접촉 키 부위: 변. */
export const CONTACT_EDGE: 0;
/** 접촉 키 부위: 변의 시작 꼭짓점. */
export const CONTACT_START: 1;
/** 접촉 키 부위: 변의 끝 꼭짓점. */
export const CONTACT_END: 2;
/** 장애물 번호 상한(포함): 2^28 - 1. */
export const CONTACT_MAX_OBSTACLE: number;
/** 변 번호 상한(포함): 2^20 - 1. */
export const CONTACT_MAX_EDGE: number;
/**
 * 접촉 키 = kind·2^50 + obstacle·2^22 + edge·4 + part (< 2^52, 안전 정수). 작을수록 같은 시각 동률에서 앞서고
 * 접촉 목록에서 먼저 옵니다.
 */
export function contactKey(kind: 0 | 1 | 2 | 3, obstacle: number, edge?: number, part?: number): number;
/**
 * 기본 동률 순위: (tieKey 하위·상위 32비트, contactKey 하위·상위 32비트, sign > 0 ? 1 : 0)의 FNV-1a를 murmur3 fmix32로
 * 마무리한 부호 없는 32비트 정수. 음수·비정수·안전 범위 밖 입력은 TypeError.
 */
export function defaultTieRank(tieKey: number, contactKey: number, sign: number): number;
/** 방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선). 부호 없는 32비트 정수를 돌려주는 순수 함수여야 합니다. */
export type TieRank = (tieKey: number, contactKey: number, sign: number) => number;

/** 이동이 처음 닿은 접촉. 한 번 만들어 `cast` 계열에 `out`으로 넘깁니다. */
export class ContactHit {
    /** 닿는 시각(0~1). 비어 있으면 Infinity. */
    t: number;
    /** 닿는 곳에서 이동체가 밀려날 방향(단위 법선). */
    nx: number;
    ny: number;
    /** 접촉 키({@link contactKey}). */
    key: number;
    /** 원 장애물에 닿았으면 그 원, 아니면 null. */
    obstacle: unknown;
    /** 법선을 정할 수 없어 (1, 0)을 쓴 경우 true. 대체 법선은 호출자가 그때만 채웁니다. */
    degenerate: boolean;
}
/** 더 이른(같은 시각 1e-10 안이면 키가 작은) 접촉. 둘 다 없으면 null. */
export function earlierContact<T extends { t: number; key: number }>(best: T | null, hit: T | null): T | null;

/** 접촉 하나: 법선·깊이·키(+ 다각형이면 거리, 원 장애물이면 그 원). */
export class SurfaceContact {
    nx: number;
    ny: number;
    /** 파고든 깊이(경계 안쪽이면 양수). */
    depth: number;
    key: number;
    /** 다각형 접촉에서 가장자리까지의 거리(그 밖은 0). */
    distance: number;
    /** 원 장애물 접촉이면 그 장애물, 아니면 null. */
    obstacle: unknown;
}
/** 재사용하는 접촉 목록. `items[0..count)`가 유효하고 `clear()` 뒤 `add()`는 이전 객체를 덮어씁니다. */
export class ContactList {
    items: SurfaceContact[];
    count: number;
    clear(): this;
    /** 끝에 하나 넣고 그 객체를 돌려줍니다. */
    add(nx: number, ny: number, depth?: number, key?: number, distance?: number, obstacle?: unknown): SurfaceContact;
}

/** 접촉 판정 정책. 사용자 정책도 같은 필드를 갖추면 됩니다. */
export interface SweptCirclePolicy {
    minSpeed2: number;
    /** 있으면 거리 기준 정책(`surface`), 없으면 `contactSquaredEpsilon` 기준(`relative`). */
    contactDistanceEpsilon?: number;
    contactSquaredEpsilon?: number;
    normalEpsilon: number;
    inwardEpsilon: number;
    discriminantEpsilon: number;
    includeTangent: boolean;
    retreat: number;
}
export interface CastOut {
    t: number;
    nx: number;
    ny: number;
    degenerate: boolean;
}

export class SweptCircleContact {
    static readonly policies: Readonly<{ surface: Readonly<SweptCirclePolicy>; relative: Readonly<SweptCirclePolicy> }>;
    /**
     * 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy)로 반지름 r인 원에 처음 들어가면 true이고 `out`에 t·법선·degenerate를
     * 씁니다. 닿지 않으면 false이고 `out`은 그대로입니다.
     */
    static cast(
        rx: number,
        ry: number,
        vx: number,
        vy: number,
        r: number,
        policy: SweptCirclePolicy,
        out: CastOut,
    ): boolean;
}

export class SurfaceContactGeometry {
    /** 선분 AB 위에서 (x, y)에 가장 가까운 점을 `out`에 씁니다. */
    static closest<T extends Point>(ax: number, ay: number, bx: number, by: number, x: number, y: number, out: T): T;
    /** 정적 원에 닿으면 true이고 `out`에 t·법선·`key`·`obstacle`을 씁니다. */
    static circleCast(
        x: number,
        y: number,
        vx: number,
        vy: number,
        cx: number,
        cy: number,
        r: number,
        key: number,
        obstacle: unknown,
        out: ContactHit,
    ): boolean;
    /**
     * 선분(양 끝 원 포함)에 닿으면 true이고 `out`에 씁니다. 키는 변 `key`, 시작 꼭짓점 `key + 1`, 끝 꼭짓점 `key + 2`라
     * `key`는 4의 배수(보통 `contactKey(kind, obstacle, edge)`)로 줍니다. `slack`: 이미 그만큼 안쪽이어도 t = 0 접촉으로 침.
     */
    static edgeCast(
        x: number,
        y: number,
        vx: number,
        vy: number,
        ax: number,
        ay: number,
        bx: number,
        by: number,
        r: number,
        key: number,
        slack: number,
        out: ContactHit,
    ): boolean;
    /** 다각형 `points`(번호 `polygon`)와의 접촉을 `list` 뒤에 넣고 `list`를 돌려줍니다. 키는 `contactKey(CONTACT_POLYGON, polygon, 변)`. */
    static polygonContacts(
        x: number,
        y: number,
        r: number,
        points: Point[],
        polygon: number,
        epsilon: number,
        list: ContactList,
    ): ContactList;
    static feasible(x: number, y: number, list: ContactList): boolean;
    static project<T extends Point>(vx: number, vy: number, list: ContactList, out: T): T;
    /**
     * 접촉에 막힌 이동을 `budget` 길이 안에서 미끄러뜨려 `out`에 씁니다. `steer`가 true면 사영 결과가 거의 0일 때 (goalX,
     * goalY)에 가장 맞는 접선으로 `budget`만큼, 점수가 같으면 `tieRank(tieKey, 접촉 키, 부호)`가 낮은 쪽(null이면
     * {@link defaultTieRank}). `tieKey`는 0 이상 안전 정수입니다.
     */
    static slide<T extends Point>(
        vx: number,
        vy: number,
        list: ContactList,
        budget: number,
        steer: boolean,
        goalX: number,
        goalY: number,
        tieKey: number,
        tieRank: TieRank | null,
        out: T,
    ): T;
}

// ---------- 장애물 장과 조정 이동 ----------

export interface PolygonObstacle extends Partial<Bounds> {
    points: Point[];
}
export interface CircleObstacle extends Partial<Bounds> {
    /** 0..2^28-1 정수. 접촉 키의 장애물 번호입니다. */
    id: number;
    x: number;
    y: number;
    r: number;
}

export interface ObstacleFieldOptions<
    P extends PolygonObstacle = PolygonObstacle,
    C extends CircleObstacle = CircleObstacle,
> {
    /** 월드 경계 [0, width] × [0, height]. */
    width: number;
    height: number;
    /** 좌표를 1/fixedPoint 격자에 반올림해 저장하는 배율(예: 100). 접촉 허용 거리의 단위. */
    fixedPoint: number;
    /** 다각형은 2^28개 이하, 다각형마다 꼭짓점 2^20개 이하. 접촉 키의 장애물 번호는 배열 위치입니다. */
    polygons?: P[] | BoundsIndex<P & Bounds>;
    circles?: C[];
    /** 색인 칸 한 변의 길이. 기본 256. */
    cell?: number;
    /** "모두 무시" 와일드카드: `ignoreId`가 `id`(정수, 보통 -1)이면 `keep(circle)`이 참인 원만 장애물로 봅니다. */
    ignoreAll?: { id: number; keep: (circle: C) => boolean } | null;
    /** `nearestExterior`가 찾는 최대 거리. 기본 256. */
    exteriorSearchDistance?: number;
}

/** 정적 장애물 장: 다각형 + 원 + 월드 경계. 자리·선분 통과 가능 여부를 답합니다. `ignoreId`는 원 id(정수) 또는 null입니다. */
export class ObstacleField<P extends PolygonObstacle = PolygonObstacle, C extends CircleObstacle = CircleObstacle> {
    constructor(options: ObstacleFieldOptions<P, C>);
    readonly width: number;
    readonly height: number;
    readonly fixedPoint: number;
    /** `1 / fixedPoint` */
    readonly quantum: number;
    readonly polygons: BoundsIndex<P & Bounds>;
    readonly circles: C[];
    /** `setCircles`가 불릴 때마다 오릅니다. */
    readonly version: number;
    /** 원 장애물 목록을 통째로 바꾸고 `version`을 올립니다(색인 버퍼는 재사용). 목록은 복사하지 않습니다. */
    setCircles(circles: C[]): void;
    /** 돌려주는 배열은 재사용하므로 다음 조회 때 덮어씁니다. */
    obstacles(x0: number, y0: number, x1: number, y1: number, pad: number, ignoreId: number | null): C[];
    /** 다각형과 월드 경계만 본 원의 자리 검사. 다각형이 없으면 항상 true. */
    polygonCircleClear(x: number, y: number, r?: number): boolean;
    /** 다각형과 월드 경계만 본 선분 이동 검사. 다각형이 없으면 항상 true. */
    polygonSegmentClear(x0: number, y0: number, x1: number, y1: number, r?: number): boolean;
    /** 가장 가까운 빈 자리를 `out`에 쓰고 true. 못 찾으면 false(`out`은 그대로). */
    nearestOpen(
        x: number,
        y: number,
        r: number,
        maxDistance: number,
        accept: ((x: number, y: number) => boolean) | null,
        out: Point,
    ): boolean;
    segmentClear(
        x: number,
        y: number,
        tx: number,
        ty: number,
        r: number,
        ignoreId?: number | null,
        departure?: boolean,
        margin?: number,
    ): boolean;
    pointClear(x: number, y: number, r: number, ignoreId?: number | null): boolean;
    /** 두 반경의 pointClear를 한번에 확인: 둘 다 불가 0, 작은 반경만 가능 1, 둘 다 가능 2. */
    pointClearanceBand(
        x: number,
        y: number,
        innerRadius: number,
        outerRadius: number,
        ignoreId?: number | null,
    ): 0 | 1 | 2;
    departureClear(x: number, y: number, tx: number, ty: number, r: number, ignoreId?: number | null): boolean;
    /** 다각형·원 모두 빈 가장 가까운 자리를 `out`에 쓰고 true. 없으면 false. */
    nearestExterior(x: number, y: number, r: number, ignoreId: number | null, out: Point): boolean;
}

/** 선분을 반지름 r로 쓸었을 때 `index`의 다각형 중 하나에 막히는지. `quantum`은 접촉 허용(보통 `1 / fixedPoint`). */
export function segmentBlockedBy(
    index: BoundsIndex<Bounds & { points: Point[] }>,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r?: number,
    quantum?: number,
): boolean;

export interface SurfaceMotionOptions {
    tieRank?: TieRank | null;
    /** `solve`·`constrain`이 시작할 때 부르는 갱신 자리. */
    sync?: (() => void) | null;
}
/** `solve`·`constrain`의 결과. 한 번 만들어 재사용합니다. */
export class MotionResult {
    x: number;
    y: number;
    /** 시작 자리가 막혀 풀 수 없으면 false. */
    valid: boolean;
    /** 이동 중 닿았는지. true면 `contact`가 처음 닿은 접촉입니다. */
    hit: boolean;
    readonly contact: ContactHit;
}
export type SolveMode = 'steer' | 'stop' | 'project';

/** 장애물 장 위에서 원형 이동체를 목표로 옮기는 조정 이동. 틱마다 부르는 함수는 새 객체를 만들지 않습니다. */
export class SurfaceMotion<Body extends object = object> {
    constructor(field: ObstacleField, options?: SurfaceMotionOptions);
    readonly field: ObstacleField;
    clear(x: number, y: number, tx: number, ty: number, r: number, ignoreId?: number | null): boolean;
    /** 지금 닿았거나 `epsilon`(기본 2/fixedPoint) 안의 접촉을 키 순서로 `list`에 채웁니다(먼저 비움). */
    contacts(
        x: number,
        y: number,
        r: number,
        ignoreId: number | null,
        list: ContactList,
        epsilon?: number,
    ): ContactList;
    /** 가장 먼저 닿는 접촉. 닿으면 true이고 `out`에 씁니다. */
    cast(x: number, y: number, vx: number, vy: number, r: number, ignoreId: number | null, out: ContactHit): boolean;
    /** 겹친 원을 가장 가까운 빈 자리로 옮겨 `out`에 씁니다(못 옮기면 제자리). */
    recover<T extends Point>(x: number, y: number, r: number, ignoreId: number | null, out: T): T;
    /** `whole`이면 끝까지 갈 수 있을 때만 `out`을 쓰고 true, 아니면 갈 수 있는 끝까지 쓰고 true. */
    advance(
        x: number,
        y: number,
        tx: number,
        ty: number,
        r: number,
        ignoreId: number | null,
        whole: boolean,
        out: Point,
    ): boolean;
    /** `tieKey`는 0 이상 안전 정수(동률 순위 입력). */
    solve(
        x: number,
        y: number,
        tx: number,
        ty: number,
        r: number,
        ignoreId: number | null,
        mode: SolveMode,
        tieKey: number,
        out: MotionResult,
    ): MotionResult;
    remember(body: Body, x: number, y: number, verified?: boolean, ignoreId?: number | null): void;
    /** 모든 체크포인트를 잊습니다(세대 번호만 올림). */
    forgetAll(): void;
    /** 확인된 체크포인트에서 그대로면 false, 아니면 `'project'`로 다시 푼 결과를 `out`에 쓰고 true. */
    constrain(
        body: Body,
        x: number,
        y: number,
        r: number,
        ignoreId: number | null,
        tieKey: number,
        out: MotionResult,
    ): boolean;
}
