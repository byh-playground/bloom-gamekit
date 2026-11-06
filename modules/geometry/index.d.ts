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

/** 경계 상자 항목을 고정 칸 격자에 넣어 범위로 후보를 찾는 AABB 버킷 색인. */
export class BoundsIndex<T extends Bounds = Bounds> {
    constructor(items: T[], cell?: number);
    readonly items: T[];
    readonly cell: number;
    /** 돌려주는 배열은 색인이 재사용하므로 다음 `query` 때 덮어씁니다. */
    query(x0: number, y0: number, x1?: number, y1?: number, pad?: number): T[];
}
/** 단순 다각형의 귀 자르기 삼각분할. 결과는 `points` 객체 단위로 캐시하므로 고치지 않습니다. 나눌 수 없으면 오류를 던집니다. */
export function triangulatePolygon(points: Point[]): { convex: boolean; triangles: number[][] };

// ---------- 접촉 ----------

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
export interface CastHit {
    /** 이동의 어느 시점(0~1)에 닿는지. */
    t: number;
    /** 닿는 곳에서 이동체가 밀려날 방향(단위 법선). */
    nx: number;
    ny: number;
}
export interface SurfaceHit extends CastHit {
    key: string;
    /** 원 장애물과 닿았으면 그 장애물. */
    obstacle?: unknown;
}
export interface SurfaceContact {
    nx: number;
    ny: number;
    /** 파고든 깊이(경계 안쪽이면 양수). */
    depth: number;
    key: string;
    /** 다각형 접촉에서 가장자리까지의 거리. */
    distance?: number;
    /** 원 장애물 접촉이면 그 장애물. */
    obstacle?: unknown;
}

export class SweptCircleContact {
    static readonly policies: Readonly<{ surface: Readonly<SweptCirclePolicy>; relative: Readonly<SweptCirclePolicy> }>;
    /** 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy)로 반지름 r인 원에 처음 들어가는 시각과 법선. 닿지 않으면 null. */
    static cast(
        rx: number,
        ry: number,
        vx: number,
        vy: number,
        r: number,
        policy: SweptCirclePolicy,
        fallback?: (() => Point) | null,
    ): CastHit | null;
}

export class SurfaceContactGeometry {
    static closest(ax: number, ay: number, bx: number, by: number, x: number, y: number): Point;
    static circleCast(
        x: number,
        y: number,
        vx: number,
        vy: number,
        cx: number,
        cy: number,
        r: number,
        key: string,
        obstacle?: unknown,
    ): SurfaceHit | null;
    /** `slack`: 선분에서 이만큼 안쪽에 이미 들어와 있어도 t = 0 접촉으로 치는 허용 거리(보통 `1 / fixedPoint`). 기본 0. */
    static edgeCast(
        x: number,
        y: number,
        vx: number,
        vy: number,
        a: Point,
        b: Point,
        r: number,
        key: string,
        slack?: number,
    ): SurfaceHit | null;
    /** 접촉은 `out`(기본 새 배열) 뒤에 덧붙이고 `out`을 돌려줍니다. */
    static polygonContacts(
        x: number,
        y: number,
        r: number,
        block: { id: unknown; points: Point[] },
        epsilon: number,
        out?: SurfaceContact[],
    ): SurfaceContact[];
    static feasible(v: Point, contacts: ReadonlyArray<{ nx: number; ny: number }>): boolean;
    static project(vx: number, vy: number, contacts: ReadonlyArray<{ nx: number; ny: number }>): Point;
    static slide(
        vx: number,
        vy: number,
        contacts: ReadonlyArray<{ nx: number; ny: number; key: string }>,
        budget: number,
        options?: SlideOptions,
    ): Point;
}
export interface SlideOptions {
    /** true면 사영 결과가 거의 0일 때 목표에 맞는 접선 방향으로 `budget` 길이만큼 미끄러집니다. 기본 false. */
    steer?: boolean;
    goalX?: number;
    goalY?: number;
    tieKey?: string;
    tieRank?: TieRank;
}
/** 방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선). 부호 없는 32비트 정수를 돌려주는 순수 함수여야 합니다. */
export type TieRank = (tieKey: string, contactKey: string, sign: number) => number;

// ---------- 장애물 장과 조정 이동 ----------

export interface PolygonObstacle extends Partial<Bounds> {
    id: unknown;
    points: Point[];
}
export interface CircleObstacle extends Partial<Bounds> {
    id: unknown;
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
    polygons?: P[] | BoundsIndex<P & Bounds>;
    circles?: C[];
    /** 색인 칸 한 변의 길이. 기본 256. */
    cell?: number;
    /** "모두 무시" 와일드카드: `ignoreId`가 `id`이면 `keep(circle)`이 참인 원만 장애물로 봅니다. */
    ignoreAll?: { id: unknown; keep: (circle: C) => boolean } | null;
    /** `nearestExterior`가 찾는 최대 거리. 기본 256. */
    exteriorSearchDistance?: number;
}

/** 정적 장애물 장: 다각형 + 원 + 월드 경계. 자리·선분 통과 가능 여부를 답합니다. */
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
    /** 원 장애물 목록을 통째로 바꾸고 `version`을 올립니다(색인을 다시 만듭니다). 목록은 복사하지 않습니다. */
    setCircles(circles: C[]): void;
    obstacles(x0: number, y0: number, x1: number, y1: number, pad: number, ignoreId?: unknown): C[];
    /** 다각형과 월드 경계만 본 원의 자리 검사. 다각형이 없으면 항상 true. */
    polygonCircleClear(x: number, y: number, r?: number): boolean;
    /** 다각형과 월드 경계만 본 선분 이동 검사. 다각형이 없으면 항상 true. */
    polygonSegmentClear(x0: number, y0: number, x1: number, y1: number, r?: number): boolean;
    nearestOpen(
        x: number,
        y: number,
        r: number,
        maxDistance?: number,
        accept?: ((x: number, y: number) => boolean) | null,
    ): Point | null;
    segmentClear(
        x: number,
        y: number,
        tx: number,
        ty: number,
        r: number,
        ignoreId?: unknown,
        departure?: boolean,
        margin?: number,
    ): boolean;
    pointClear(x: number, y: number, r: number, ignoreId?: unknown): boolean;
    /** 두 반경의 pointClear를 한번에 확인: 둘 다 불가 0, 작은 반경만 가능 1, 둘 다 가능 2. */
    pointClearanceBand(x: number, y: number, innerRadius: number, outerRadius: number, ignoreId?: unknown): 0 | 1 | 2;
    departureClear(x: number, y: number, tx: number, ty: number, r: number, ignoreId?: unknown): boolean;
    nearestExterior(x: number, y: number, r: number, ignoreId?: unknown): Point | null;
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
    tieRank?: TieRank;
    /** `solve`·`constrain`이 시작할 때 부르는 갱신 자리. */
    sync?: () => void;
}
export interface SolveResult {
    x: number;
    y: number;
    /** 처음 닿은 접촉. 없으면 null. */
    hit: SurfaceHit | null;
    /** 시작 자리가 막혀 풀 수 없을 때만 false가 담깁니다. */
    valid?: false;
}
export type SolveMode = 'steer' | 'stop' | 'project';

/** 장애물 장 위에서 원형 이동체를 목표로 옮기는 조정 이동. */
export class SurfaceMotion<Body extends object = object> {
    constructor(field: ObstacleField, options?: SurfaceMotionOptions);
    readonly field: ObstacleField;
    clear(x: number, y: number, tx: number, ty: number, r: number, ignoreId?: unknown): boolean;
    contacts(x: number, y: number, r: number, ignoreId?: unknown, epsilon?: number): SurfaceContact[];
    circleObstacleCast(x: number, y: number, vx: number, vy: number, r: number, ignoreId?: unknown): SurfaceHit | null;
    cast(x: number, y: number, vx: number, vy: number, r: number, ignoreId?: unknown): SurfaceHit | null;
    recover(x: number, y: number, r: number, ignoreId?: unknown): Point;
    advance(x: number, y: number, tx: number, ty: number, r: number, ignoreId?: unknown, whole?: boolean): Point | null;
    solve(
        x: number,
        y: number,
        tx: number,
        ty: number,
        r: number,
        ignoreId?: unknown,
        mode?: SolveMode,
        tieKey?: string,
    ): SolveResult;
    remember(body: Body, x: number, y: number, verified?: boolean, ignoreId?: unknown): void;
    forgetAll(): void;
    /** 확인된 체크포인트에서 그대로면 null, 아니면 `'project'`로 다시 푼 결과. 결과를 몸체에 쓰고 `remember`하는 일은 호출자가 합니다. */
    constrain(body: Body, x: number, y: number, r: number, ignoreId?: unknown, tieKey?: string): SolveResult | null;
}
