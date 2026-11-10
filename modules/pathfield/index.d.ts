/** 직선 한 칸의 비용(10). */
export const STRAIGHT_COST: 10;
/** 대각 한 칸의 비용(14). */
export const DIAGONAL_COST: 14;
/** `PathGrid`가 기록하는 바뀐 사각형의 최대 개수. 넘치면 하나의 바운딩 사각형으로 합칩니다. */
export const MAX_CHANGED_RECTS: 16;
/** 닿지 못한 칸의 `DistanceField#dist` 값. */
export const UNREACHED: 0x7fffffff;

export interface PathGridOptions {
    /** 격자가 덮는 크기(좌표 단위). 칸 수는 `ceil(크기 / cellSize)`이고 총 칸 수는 2^22개 이하여야 합니다. */
    width: number;
    height: number;
    /** 칸 한 변의 크기. */
    cellSize: number;
    /**
     * 칸 중심 `(x, y)`에 이동체가 설 수 있는지. 칸마다 한 번만 불리고 `invalidate()`까지 기억됩니다.
     * 같은 입력에 같은 값을 돌려주는 순수 함수여야 합니다(예: 게임 장애물에 대한 반지름 r 원의 `pointClear`).
     * `cell`은 칸 번호이므로 미리 만든 차단 배열을 읽을 수도 있습니다.
     */
    passable: (x: number, y: number, cell: number) => boolean;
    /** 양방향 결과가 같은 인접 셀 중심 사이의 이동 검사. 결과는 invalidate까지 캐시합니다. */
    passableEdge?: (x: number, y: number, nextX: number, nextY: number, cell: number, nextCell: number) => boolean;
    /** 칸 (0, 0)의 좌표(기본 0). */
    originX?: number;
    originY?: number;
}

/** 거리장이 걷는 격자. 칸 번호는 행 우선(`row * cols + col`)입니다. */
export class PathGrid {
    constructor(options: PathGridOptions);
    readonly cellSize: number;
    readonly originX: number;
    readonly originY: number;
    readonly cols: number;
    readonly rows: number;
    /** `cols * rows`. */
    readonly size: number;
    /** 통과 판정을 비운 횟수. 이 격자로 만든 거리장이 낡았는지 알아보는 표식입니다. */
    readonly revision: number;

    /** 좌표가 든 칸. 격자 밖은 가장자리 칸으로 자릅니다. 좌표는 NaN이 아니어야 합니다. */
    cellAt(x: number, y: number): number;
    colOf(cell: number): number;
    rowOf(cell: number): number;
    /** 칸 중심의 좌표. */
    centerX(cell: number): number;
    centerY(cell: number): number;
    /** 통과 가능한지. 처음 물으면 `passable`을 한 번 부릅니다. 격자 밖 번호는 false. */
    isOpen(cell: number): boolean;
    /**
     * (col, row)에서 방향 `direction`(0..7: 동·남·서·북·남동·남서·북서·북동)으로 한 걸음 갈 수 있으면 이웃 칸 번호, 아니면 -1.
     * 격자 밖·막힌 칸·모서리 가로지르기(대각인데 두 직교 이웃 중 하나가 막힘)는 -1입니다.
     */
    stepCell(col: number, row: number, direction: number): number;
    /** 통과 판정의 기억을 비우고 `revision`을 올립니다. 장애물이 바뀐 뒤에 부릅니다. */
    invalidate(): void;
    /**
     * 월드 좌표 사각형에 걸친 칸의 통과 판정 기억(과 맞닿은 한 겹의 변 기억)만 비우고 `revision`을 올리며, 비운 칸 범위를
     * 기록합니다. 격자 밖은 자르고 전혀 안 겹치면 아무것도 안 합니다. 유한하지 않거나 min > max면 RangeError.
     */
    invalidateRect(minX: number, minY: number, maxX: number, maxY: number): void;
    /** 마지막으로 가져간 뒤 기록된 바뀐 사각형 개수(0..`MAX_CHANGED_RECTS`). */
    readonly changedRectCount: number;
    /**
     * 바뀐 칸 사각형을 `out`(Int32Array, 길이 `4 * MAX_CHANGED_RECTS` 이상)에 `[minCol, minRow, maxCol, maxRow]`(양끝 포함)
     * 네 정수씩 기록 순서대로 쓰고 개수를 돌려준 뒤 기록을 비웁니다. `invalidate()`·`sync`는 격자 전체 한 개로 기록됩니다.
     * 소비자는 하나라고 가정합니다. `out`이 맞지 않으면 TypeError.
     */
    takeChangedRects(out: Int32Array): number;
    /** 게임의 장애물 배치 세대 번호를 알립니다. 지난번과 다르면 `invalidate()`하고 true. */
    sync(version: unknown): boolean;
    /**
     * 가장 가까운 통과 가능한 칸(자신이 열려 있으면 자신). 정사각 고리를 `maxRing`(기본 12)까지 넓히고,
     * 같은 고리의 동률은 행 오름차순·열 오름차순에서 먼저인 칸입니다. 없으면 -1.
     */
    nearestOpen(cell: number, maxRing?: number): number;
    /**
     * (x, y)에서 칸 중심까지의 거리가 `innerRadius` 이상 `outerRadius` 이하인 통과 가능한 칸을 `out`(먼저 비움)에 행 우선으로 채웁니다.
     * `accept`를 주면 그것도 통과한 칸만 남깁니다.
     */
    openCellsWithin<Out extends number[] = number[]>(
        x: number,
        y: number,
        outerRadius: number,
        innerRadius?: number,
        accept?: ((centerX: number, centerY: number, cell: number) => boolean) | null,
        out?: Out,
    ): Out;
    /**
     * `start`(열린 칸)에서 8방향으로 걸어 닿는 칸을 1로 표시해 `out`(길이 `size` 이상, 먼저 비움)에 채웁니다.
     * `start`가 열려 있지 않으면 모두 0. `out`이 Uint8Array가 아니거나 짧으면 TypeError.
     */
    reachableFrom(start: number, out: Uint8Array): Uint8Array;
}

/**
 * 출발 칸(들)에서 각 칸까지의 걸음 비용입니다. 필요한 칸까지만 게으르게 확정합니다.
 * `dist`는 확정한 칸만 믿을 수 있습니다.
 */
export class DistanceField {
    /** @param sources 출발 칸 번호(열린 칸). 겹쳐도 됩니다. 격자 밖 번호는 `RangeError`. */
    constructor(grid: PathGrid, sources: ArrayLike<number>);
    readonly grid: PathGrid;
    readonly dist: Int32Array;
    /** 모든 칸이 확정됐는지. */
    readonly done: boolean;

    /** 비용 순서로 확정합니다. `target`이 확정되면 멈추고, 주지 않으면 닿을 수 있는 모든 칸을 확정합니다. */
    settle(target?: number): void;
    /** `cell`의 비용을 확정해 돌려줍니다(닿지 못하면 `UNREACHED`). */
    distance(cell: number): number;
    /** `cell`보다 싼 이웃 중 가장 싼 칸(동률은 방향 순서가 앞선 쪽), 없으면 -1. `cell`이 확정되어 있어야 합니다. */
    lowestNeighbor(cell: number): number;
    /**
     * `start`에서 비용이 줄어드는 쪽으로 최대 `maxSteps`칸을 걸은 칸 번호를 `out`(먼저 비움)에 채웁니다. `start`는 넣지 않습니다.
     * 닿지 못하는 `start`나 이미 출발 칸이면 빈 결과입니다.
     */
    descend<Out extends number[] = number[]>(start: number, maxSteps: number, out?: Out): Out;
}

export interface FieldCacheOptions {
    /** 1 이상의 정수 또는 `Infinity`(기본). 넘으면 먼저 넣은 것부터 버립니다. */
    capacity?: number;
}

/** 거리장을 키로 보관합니다. 키와 만들 때를 정하는 것은 호출자입니다. */
export class FieldCache<Key = unknown> {
    constructor(grid: PathGrid, options?: FieldCacheOptions);
    readonly grid: PathGrid;
    readonly capacity: number;
    readonly size: number;
    has(key: Key): boolean;
    /** 키의 거리장, 없으면 `undefined`. 꺼내도 순서는 바뀌지 않습니다. */
    get(key: Key): DistanceField | undefined;
    /** 담고 돌려줍니다. 용량이 차 있으면 가장 먼저 넣은 것을 버립니다. */
    set(key: Key, field: DistanceField): DistanceField;
    clear(): void;
    /** 세대 번호(틱 등)가 지난번과 다르면 비우고 true. */
    sync(epoch: unknown): boolean;
}

export interface RouteFindOptions {
    /** 확장(확정)할 수 있는 칸 수의 상한(기본 격자 칸 수). 넘으면 `find`가 null이고 `status`는 `'limit'`입니다. */
    maxExpanded?: number;
}

/** 두 점 사이를 막힘 없이 갈 수 있는지. 같은 입력에 같은 값을 돌려주는 순수 함수여야 합니다. */
export type SegmentClear = (x0: number, y0: number, x1: number, y1: number) => boolean;

/**
 * 유닛 하나가 한 번 가는 길을 찾는 A* 탐색기. 격자·비용·통과 규칙이 `DistanceField`와 같아 최단 비용이 같습니다.
 * 탐색 버퍼를 들고 있으므로 격자마다 하나 만들어 재사용합니다. 같은 입력이면 항상 같은 경로입니다.
 */
export class RouteFinder {
    constructor(grid: PathGrid);
    readonly grid: PathGrid;
    /** 마지막 `find`의 결과. */
    readonly status: 'found' | 'unreachable' | 'limit';
    /** 마지막 `find`가 찾은 경로의 걸음 비용, 못 찾았으면 -1. */
    readonly cost: number;
    /** 마지막 `find`가 확장한 칸 수. */
    readonly expanded: number;
    /**
     * `start`에서 `goals` 중 가장 싼 칸까지의 최단 경로(시작·목표 칸 포함 칸 번호)를 `out`(먼저 비움)에 채웁니다.
     * 닿을 수 없거나 한도를 넘으면 null(`status`로 구분). `start`가 막혔으면 null, 목표 칸이면 `[start]`. 격자 밖 번호는 `RangeError`.
     */
    find<Out extends number[] = number[]>(
        start: number,
        goals: ArrayLike<number>,
        options?: RouteFindOptions,
        out?: Out,
    ): Out | null;
    /**
     * 칸 경로에서 꺾이는 칸만 남긴 웨이포인트(칸 번호, 첫·마지막 칸 포함)를 `out`(먼저 비움)에 채웁니다.
     * `lineClear`를 주면 보이는 가장 먼 웨이포인트로 건너뛰어 더 줄입니다.
     */
    waypoints<Out extends number[] = number[]>(
        cells: ArrayLike<number>,
        lineClear?: SegmentClear | null,
        out?: Out,
    ): Out;
    /**
     * 지금 향할 웨이포인트의 인덱스. `index`에서 시작해 `reach` 이내로 다가왔거나 `lineClear`가 다음 웨이포인트를 보면 넘어갑니다.
     * 줄지 않고 마지막 인덱스에서 멈춥니다.
     */
    advance(
        waypoints: ArrayLike<number>,
        index: number,
        x: number,
        y: number,
        reach?: number,
        lineClear?: SegmentClear | null,
    ): number;
    /** (x, y) → `waypoints[index]` → … → 마지막 웨이포인트의 남은 구간이 모두 `segmentClear`를 통과하는지. 빈 경로는 false. */
    remainingClear(
        waypoints: ArrayLike<number>,
        index: number,
        x: number,
        y: number,
        segmentClear: SegmentClear,
    ): boolean;
}
