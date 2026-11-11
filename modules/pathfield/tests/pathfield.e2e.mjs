// pathfield 고정 시나리오: 작은 격자에서 비용·모서리 규칙·A* 경로·웨이포인트를 값으로 못 박고, geometry의 ObstacleField를
// 통과 판정으로 연결해 벽의 틈으로 도는 길을 확인한 뒤, PortalGraph(국소 무효화 = 처음부터)와 FlowField(성분·엄격한 내려가기·
// 정확 비용 이상·질의 순서와 무관)를 건물이 놓이고 지워지는 흐름으로 확인합니다. 비교 기준은 시험 안의 작은 구현(`exactCosts`·`floodMarks`)입니다.
import assert from 'node:assert/strict';
import { ObstacleField } from '../../../dist/geometry.js';
import {
    DIAGONAL_COST,
    FlowField,
    MAX_CHANGED_RECTS,
    PathGrid,
    PortalGraph,
    RouteFinder,
    STRAIGHT_COST,
    UNREACHED,
} from '../../../dist/pathfield.js';

// 글자 지도(# 막힘, . 통과)로 격자를 만듭니다. 칸 크기 10, 칸 번호 = 행 * 열 수 + 열.
function gridFrom(rows, counter = null) {
    const COLS = rows[0].length;
    return new PathGrid({
        width: COLS * 10,
        height: rows.length * 10,
        cellSize: 10,
        passable: (x, y, cell) => {
            if (counter) {
                counter.push(cell);
            }
            return rows[Math.floor(y / 10)][Math.floor(x / 10)] !== '#';
        },
    });
}
const CELL_OF = (grid, col, row) => row * grid.cols + col;
const CELL = 24;

// 비교 기준 1: `stepCell`만 쓰는 작은 다익스트라(칸 수가 작은 격자용). 출발 칸들에서 각 칸까지의 정확한 비용, 닿지 못하면 UNREACHED.
function exactCosts(grid, sources) {
    const DIST = new Array(grid.size).fill(UNREACHED),
        DONE = new Uint8Array(grid.size);
    for (const SOURCE of sources) {
        DIST[SOURCE] = 0;
    }
    for (;;) {
        let cell = -1;
        for (let i = 0; i < grid.size; i++) {
            if (!DONE[i] && DIST[i] !== UNREACHED && (cell < 0 || DIST[i] < DIST[cell])) {
                cell = i;
            }
        }
        if (cell < 0) {
            return DIST;
        }
        DONE[cell] = 1;
        const COL = cell % grid.cols,
            ROW = (cell - COL) / grid.cols;
        for (let direction = 0; direction < 8; direction++) {
            const NEXT = grid.stepCell(COL, ROW, direction);
            if (NEXT >= 0) {
                DIST[NEXT] = Math.min(DIST[NEXT], DIST[cell] + (direction < 4 ? STRAIGHT_COST : DIAGONAL_COST));
            }
        }
    }
}

// 비교 기준 2: `start`에서 8방향으로 걸어 닿는 칸을 1로 표시한 Uint8Array(막힌 시작이면 모두 0).
function floodMarks(grid, start) {
    const MARKS = new Uint8Array(grid.size),
        STACK = [];
    if (grid.isOpen(start)) {
        MARKS[start] = 1;
        STACK.push(start);
    }
    while (STACK.length) {
        const CELL_NOW = STACK.pop(),
            COL = CELL_NOW % grid.cols,
            ROW = (CELL_NOW - COL) / grid.cols;
        for (let direction = 0; direction < 8; direction++) {
            const NEXT = grid.stepCell(COL, ROW, direction);
            if (NEXT >= 0 && !MARKS[NEXT]) {
                MARKS[NEXT] = 1;
                STACK.push(NEXT);
            }
        }
    }
    return MARKS;
}

// 셀 중심은 모두 열려 있어도 그 사이의 얇은 벽은 가로지를 수 없습니다.
// 왕복 엣지 검사는 재사용하며, 지형 변경 시 새 경로를 계산합니다.
{
    const TERRAIN = new ObstacleField({
        width: 80,
        height: 80,
        fixedPoint: 100,
        polygons: [
            {
                id: 'thin-wall',
                points: [
                    { x: 19, y: 0 },
                    { x: 21, y: 0 },
                    { x: 21, y: 59 },
                    { x: 19, y: 59 },
                ],
            },
        ],
    });
    let calls = 0,
        enabled = true;
    const GRID = new PathGrid({
        width: 80,
        height: 80,
        cellSize: 10,
        passable: (x, y) => TERRAIN.pointClear(x, y, 1),
        passableEdge: (x, y, tx, ty) => {
            calls++;
            return !enabled || TERRAIN.segmentClear(x, y, tx, ty, 1, null, true, 0);
        },
    });
    const LEFT = CELL_OF(GRID, 1, 2),
        RIGHT = CELL_OF(GRID, 2, 2);
    assert.equal(GRID.isOpen(LEFT), true);
    assert.equal(GRID.isOpen(RIGHT), true);
    assert.equal(GRID.stepCell(1, 2, 0), -1, '양 끝은 열렸지만 벽을 통과할 수 없습니다');
    const BEFORE = calls;
    assert.equal(GRID.stepCell(2, 2, 2), -1, '반대 방향도 같은 결과입니다');
    assert.equal(calls, BEFORE, '양방향 검사는 한번만 계산합니다');
    const ROUTE = new RouteFinder(GRID).find(LEFT, [RIGHT]);
    assert.ok(ROUTE.length > 1, '막힌 직선 대신 벽 끝을 돌아갑니다');
    let previous = LEFT;
    for (const CELL of ROUTE) {
        assert.equal(
            TERRAIN.segmentClear(
                GRID.centerX(previous),
                GRID.centerY(previous),
                GRID.centerX(CELL),
                GRID.centerY(CELL),
                1,
                null,
                true,
                0,
            ),
            true,
        );
        previous = CELL;
    }
    assert.equal(previous, RIGHT);
    enabled = false;
    GRID.invalidate();
    assert.equal(GRID.stepCell(1, 2, 0), RIGHT, '갱신 뒤 막힌 엣지도 다시 판단합니다');
}

// ---------- 1. 비용: 직선 10·대각 14, 모서리 가로지르기 금지 ----------
{
    assert.deepEqual([STRAIGHT_COST, DIAGONAL_COST, UNREACHED], [10, 14, 0x7fffffff]);
    const OPEN = gridFrom(['...', '...', '...']),
        OPEN_FINDER = new RouteFinder(OPEN);
    assert.deepEqual(exactCosts(OPEN, [4]), [14, 10, 14, 10, 0, 10, 14, 10, 14], '가운데에서 직선 10, 대각 14');
    OPEN_FINDER.find(0, [8]);
    assert.equal(OPEN_FINDER.cost, 28, '대각 두 걸음');

    const CORNER = gridFrom(['.#.', '...', '...']);
    // (1,0)이 막혀 (0,0)→(1,1) 대각은 모서리를 가로지르므로 못 가고, (0,1)을 지나 20입니다. (1,2)는 (0,1)→(1,2) 대각 24.
    assert.deepEqual(exactCosts(CORNER, [0]), [0, UNREACHED, 40, 10, 20, 30, 20, 24, 34]);
}

// ---------- 2. 칸 번호·좌표·통과 판정 기억 ----------
const MAZE = ['.......', '.#####.', '.....#.', '####.#.', '.......'];
{
    const CALLS = [];
    const GRID = gridFrom(MAZE, CALLS);
    assert.deepEqual([GRID.cols, GRID.rows, GRID.size, GRID.cellSize], [7, 5, 35, 10]);
    assert.deepEqual(
        [GRID.cellAt(35, 25), GRID.cellAt(-50, -50), GRID.cellAt(9999, 9999)],
        [17, 0, 34],
        '밖은 가장자리 칸',
    );
    assert.deepEqual([GRID.centerX(17), GRID.centerY(17), GRID.colOf(17), GRID.rowOf(17)], [35, 25, 3, 2]);
    assert.equal(GRID.isOpen(8), false);
    assert.equal(GRID.isOpen(8), false, '막힌 칸은 계속 막힘');
    assert.equal(GRID.isOpen(0), true);
    assert.deepEqual(CALLS, [8, 0], '통과 판정은 칸마다 한 번만, 칸 중심으로');
    assert.equal(GRID.isOpen(-1) || GRID.isOpen(35) || GRID.isOpen(NaN), false, '격자 밖 번호는 막힘');
    // 방향 규칙: 동·남·서·북·남동·남서·북서·북동. 모서리 가로지르기와 가장자리 처리.
    assert.deepEqual(
        [0, 1, 2, 3, 4, 5, 6, 7].map((direction) => GRID.stepCell(0, 0, direction)),
        [1, 7, -1, -1, -1, -1, -1, -1],
    );
    assert.equal(GRID.stepCell(4, 2, 4), -1, '(4,2)→(5,3): (5,3)이 막힘');
    assert.equal(GRID.stepCell(4, 4, 7), -1, '(4,4)→(5,3): 목표 칸이 막힘');
    assert.equal(GRID.stepCell(6, 3, 5), -1, '(6,3)→(5,4): (5,3)이 막혀 모서리를 가로지름');
    // 판정이 바뀐 뒤: invalidate()를 부를 때까지는 기억이 남는다.
    let wall = true;
    const SWITCHED = new PathGrid({ width: 20, height: 10, cellSize: 10, passable: (x) => x < 10 || !wall });
    assert.equal(SWITCHED.isOpen(1), false);
    wall = false;
    assert.equal(SWITCHED.isOpen(1), false, '기억이 남아 있어 아직 막힘');
    const REVISION = SWITCHED.revision;
    SWITCHED.invalidate();
    assert.equal(SWITCHED.isOpen(1), true);
    assert.equal(SWITCHED.revision, REVISION + 1);
    // 사각형 무효화: 그 칸만 다시 묻고, 바뀐 칸 범위를 기록 순서대로 한 번 넘겨준다.
    const CHANGED = new Int32Array(4 * MAX_CHANGED_RECTS);
    assert.deepEqual(
        [SWITCHED.takeChangedRects(CHANGED), ...CHANGED.slice(0, 4)],
        [1, 0, 0, 1, 0],
        'invalidate는 전체 한 개',
    );
    wall = true;
    assert.equal(SWITCHED.isOpen(1), true, '기억이 남아 있어 열림');
    SWITCHED.invalidateRect(11, 2, 14, 8);
    assert.equal(SWITCHED.isOpen(1), false, '사각형이 걸친 칸만 다시 물음');
    assert.equal(SWITCHED.isOpen(0), true);
    assert.equal(SWITCHED.revision, REVISION + 2);
    SWITCHED.invalidateRect(500, 500, 600, 600);
    assert.equal(SWITCHED.revision, REVISION + 2, '격자 밖 사각형은 아무 일도 없음');
    assert.deepEqual([SWITCHED.takeChangedRects(CHANGED), ...CHANGED.slice(0, 4)], [1, 1, 0, 1, 0]);
    assert.equal(SWITCHED.takeChangedRects(CHANGED), 0, '가져가면 비워짐');
    assert.throws(() => SWITCHED.invalidateRect(5, 0, 1, 0), RangeError);
    assert.throws(() => SWITCHED.invalidateRect(0, 0, NaN, 0), RangeError);
    assert.throws(() => SWITCHED.takeChangedRects(new Int32Array(4)), TypeError);
    SWITCHED.invalidate();
    assert.equal(SWITCHED.revision, REVISION + 3);
}

// ---------- 4. 가장 가까운 열린 칸·고리 안의 열린 칸 ----------
{
    const GRID = gridFrom(['.....', '.###.', '.###.', '.###.', '.....']);
    assert.equal(GRID.nearestOpen(0), 0, '열린 칸은 자기 자신');
    assert.equal(GRID.nearestOpen(12), 2, '가운데에서 거리 제곱이 같은 4칸 중 훑는 순서가 먼저인 위쪽');
    assert.equal(GRID.nearestOpen(12, 1), -1, '고리를 넘지 않음');
    assert.equal(GRID.nearestOpen(99), -1);

    const MAP = gridFrom(MAZE);
    // (35,25)에서 중심 거리 5 이상 15 이하: (2,2)·(4,2)는 10, (4,3)은 약 14.1. (3,2) 자신은 0, 나머지는 막혔거나 멉니다.
    assert.deepEqual(MAP.openCellsWithin(35, 25, 15, 5), [16, 18, 25]);
    assert.deepEqual(
        MAP.openCellsWithin(35, 25, 15, 5, (x, y, cell) => cell !== 18 && x > 0 && y > 0),
        [16, 25],
        'accept를 통과한 칸만',
    );
    const OUT = [99];
    assert.equal(MAP.openCellsWithin(35, 25, 1, 0, null, OUT), OUT, 'out을 먼저 비우고 채움');
    assert.deepEqual(OUT, [17]);
}

// ---------- 6. 잘못된 입력은 만들 때 던짐 ----------
{
    const OK = { width: 10, height: 10, cellSize: 10, passable: () => true };
    assert.throws(() => new PathGrid(null), TypeError);
    assert.throws(() => new PathGrid({ ...OK, passable: undefined }), TypeError);
    assert.throws(() => new PathGrid({ ...OK, cellSize: 0 }), RangeError);
    assert.throws(() => new PathGrid({ ...OK, width: NaN }), RangeError);
    assert.throws(() => new PathGrid({ ...OK, originX: Infinity }), RangeError);
    assert.throws(() => new PathGrid({ ...OK, cells: 3 }), TypeError, '알 수 없는 옵션');
    assert.throws(() => new PathGrid({ ...OK, width: 1e9, height: 1e9 }), RangeError, '칸이 너무 많음');
}

// ---------- 7. 원점이 0이 아닌 격자 ----------
{
    const GRID = new PathGrid({
        width: 40,
        height: 20,
        cellSize: 10,
        originX: -20,
        originY: 100,
        passable: () => true,
    });
    assert.deepEqual([GRID.cols, GRID.rows], [4, 2]);
    assert.deepEqual([GRID.cellAt(-15, 105), GRID.cellAt(15, 115), GRID.centerX(5), GRID.centerY(5)], [0, 7, -5, 115]);
    assert.deepEqual(GRID.openCellsWithin(-15, 105, 0.5), [0]);
}

// ---------- 8. geometry의 ObstacleField를 통과 판정으로: 벽의 틈으로 도는 길 ----------
{
    const WORLD = { width: 200, height: 100 },
        RADIUS = 6,
        OBSTACLES = new ObstacleField({
            ...WORLD,
            fixedPoint: 100,
            polygons: [
                // 세로 벽: 위아래에서 내려오고 y 40~80 사이에 틈이 있음
                {
                    id: 'upper',
                    points: [
                        { x: 90, y: 0 },
                        { x: 110, y: 0 },
                        { x: 110, y: 40 },
                        { x: 90, y: 40 },
                    ],
                },
                {
                    id: 'lower',
                    points: [
                        { x: 90, y: 80 },
                        { x: 110, y: 80 },
                        { x: 110, y: 100 },
                        { x: 90, y: 100 },
                    ],
                },
            ],
            circles: [],
        }),
        GRID = new PathGrid({
            ...WORLD,
            cellSize: 10,
            passable: (x, y) => OBSTACLES.pointClear(x, y, RADIUS),
        });
    const GOAL = GRID.cellAt(180, 20),
        START = GRID.cellAt(20, 20),
        PATH = new RouteFinder(GRID).find(START, [GOAL]);
    assert.ok(PATH, '틈이 이어 줌');
    assert.equal(floodMarks(GRID, START)[GOAL], 1);
    assert.equal(PATH.at(-1), GOAL);
    const THROUGH_GAP = PATH.some((cell) => GRID.centerX(cell) > 85 && GRID.centerX(cell) < 115);
    assert.ok(THROUGH_GAP, '벽 옆을 지나는 칸이 있음');
    assert.ok(
        PATH.every((cell) => OBSTACLES.pointClear(GRID.centerX(cell), GRID.centerY(cell), RADIUS)),
        '내려가는 칸은 모두 장애물 밖',
    );
    const GAP_CELLS = PATH.filter((cell) => GRID.centerX(cell) > 85 && GRID.centerX(cell) < 115);
    assert.ok(
        GAP_CELLS.every((cell) => GRID.centerY(cell) > 40 && GRID.centerY(cell) < 80),
        '벽을 가로지르는 칸은 틈(y 40~80) 안',
    );
}

// ---------- 9. A* 경로(RouteFinder): 기준 다익스트라와 같은 비용·막힌 목표·모서리·여러 목표·한도·웨이포인트·재검증·결정론 ----------
{
    const GRID = gridFrom(MAZE),
        FINDER = new RouteFinder(GRID),
        TO_CELLS = (list) => list.map((cell) => [GRID.colOf(cell), GRID.rowOf(cell)].join(','));
    // 같은 격자에서 모든 출발 칸의 A* 비용이 기준 다익스트라 비용과 같습니다(닿지 못하는 칸은 둘 다 실패).
    const EXACT = exactCosts(GRID, [0]);
    for (let start = 0; start < GRID.size; start++) {
        const PATH = FINDER.find(start, [0]);
        assert.equal(PATH === null ? UNREACHED : FINDER.cost, EXACT[start], `칸 ${start}의 비용`);
    }
    const PATH = FINDER.find(CELL_OF(GRID, 0, 4), [0]);
    assert.deepEqual(
        TO_CELLS(PATH),
        ['0,4', '1,4', '2,4', '3,4', '4,4', '4,3', '4,2', '3,2', '2,2', '1,2', '0,2', '0,1', '0,0'],
        '틈을 돌아 위로, 시작·목표 칸 포함',
    );
    assert.deepEqual([FINDER.cost, FINDER.status], [120, 'found']);
    assert.deepEqual(FINDER.find(0, [0]), [0], '시작 칸이 목표면 그 칸 하나');

    // 막힌 목표·닫힌 방·막힌 시작은 null이고, 한도를 넘으면 status가 다릅니다.
    assert.equal(FINDER.find(0, [CELL_OF(GRID, 1, 1)]), null, '막힌 목표 칸');
    assert.equal(FINDER.status, 'unreachable');
    const ROOM = gridFrom(['.....', '.###.', '.#.#.', '.###.', '.....']);
    assert.equal(new RouteFinder(ROOM).find(0, [CELL_OF(ROOM, 2, 2)]), null, '사방이 막힌 칸');
    assert.equal(FINDER.find(CELL_OF(GRID, 1, 1), [0]), null, '막힌 시작 칸');
    assert.equal(FINDER.find(CELL_OF(GRID, 0, 4), [0], { maxExpanded: 3 }), null);
    assert.deepEqual([FINDER.status, FINDER.expanded, FINDER.cost], ['limit', 3, -1], '확장 한도');
    assert.throws(() => FINDER.find(35, [0]), RangeError);
    assert.throws(() => FINDER.find(0, [-1]), RangeError);
    assert.throws(() => new RouteFinder({}), TypeError);

    // 모서리 가로지르기 금지: (1,0)이 막혀 (0,0)→(1,1) 대각을 못 가고 (0,1)을 지나 20입니다.
    const CORNER = gridFrom(['.#.', '...', '...']),
        CORNER_FINDER = new RouteFinder(CORNER);
    assert.deepEqual(CORNER_FINDER.find(0, [4]), [0, 3, 4]);
    assert.equal(CORNER_FINDER.cost, 20);

    // 여러 목표 칸: 가장 싼 칸에 닿습니다. (2,2)에서 (0,0)은 40, (6,4)는 그보다 멉니다.
    assert.deepEqual(TO_CELLS(FINDER.find(CELL_OF(GRID, 2, 2), [CELL_OF(GRID, 6, 4), 0])), [
        '2,2',
        '1,2',
        '0,2',
        '0,1',
        '0,0',
    ]);
    assert.equal(FINDER.cost, 40);

    // 웨이포인트: 꺾이는 칸만 남기고, 직선 판정을 주면 보이는 가장 먼 칸으로 건너뜁니다.
    const LINE_CLEAR = (x0, y0, x1, y1) => {
        const STEPS = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
        for (let i = 0; i <= STEPS; i++) {
            const X = x0 + ((x1 - x0) * i) / STEPS,
                Y = y0 + ((y1 - y0) * i) / STEPS;
            if (MAZE[Math.floor(Y / 10)]?.[Math.floor(X / 10)] !== '.') {
                return false;
            }
        }
        return true;
    };
    const WAYPOINTS = FINDER.waypoints(PATH);
    assert.deepEqual(TO_CELLS(WAYPOINTS), ['0,4', '4,4', '4,2', '0,2', '0,0']);
    assert.deepEqual(TO_CELLS(FINDER.waypoints(PATH, LINE_CLEAR)), ['0,4', '4,4', '4,2', '0,2', '0,0'], '벽이 다 막음');
    const OPEN = gridFrom(['......', '......', '......', '......']),
        OPEN_FINDER = new RouteFinder(OPEN),
        OPEN_PATH = OPEN_FINDER.find(0, [23]);
    assert.deepEqual(OPEN_PATH, [0, 7, 14, 21, 22, 23], '빈 격자: 대각 먼저(동률은 f → h → 칸 번호)');
    assert.deepEqual(OPEN_FINDER.waypoints(OPEN_PATH), [0, 21, 23]);
    assert.deepEqual(
        OPEN_FINDER.waypoints(OPEN_PATH, () => true),
        [0, 23],
        '보이면 끝까지 건너뜀',
    );
    assert.deepEqual(OPEN_FINDER.waypoints([]), []);

    // 따라가기: 인덱스 하나만 저장합니다. 다가오면(reach) 또는 다음 웨이포인트가 보이면 넘어가고, 줄지 않습니다.
    assert.equal(FINDER.advance(WAYPOINTS, 0, 5, 45, 1), 1, '첫 웨이포인트 위');
    assert.equal(FINDER.advance(WAYPOINTS, 0, 20, 45, 1), 0, '아직 멀다');
    assert.equal(FINDER.advance(WAYPOINTS, 1, 44, 45, 2), 2);
    assert.equal(FINDER.advance(WAYPOINTS, 0, 20, 45, 0, LINE_CLEAR), 1, '(4,4)는 보이고 (4,2)는 벽 너머');
    assert.equal(FINDER.advance(WAYPOINTS, 3, 5, 45, 1), 3, '되돌아가지 않음');
    assert.equal(FINDER.advance(WAYPOINTS, 99, 5, 45), 4, '마지막에서 멈춤');

    // 재검증: 남은 경로 위에 벽을 놓으면 false, 경로 밖이나 지나간 구간이면 true.
    const WALLS = new Set();
    const SEGMENT_CLEAR = (x0, y0, x1, y1) => {
        const STEPS = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
        for (let i = 0; i <= STEPS; i++) {
            const CELL = OPEN.cellAt(x0 + ((x1 - x0) * i) / STEPS, y0 + ((y1 - y0) * i) / STEPS);
            if (WALLS.has(CELL)) {
                return false;
            }
        }
        return true;
    };
    const ROUTE = OPEN_FINDER.waypoints(OPEN_PATH);
    assert.equal(OPEN_FINDER.remainingClear(ROUTE, 0, 5, 5, SEGMENT_CLEAR), true);
    WALLS.add(5);
    assert.equal(OPEN_FINDER.remainingClear(ROUTE, 0, 5, 5, SEGMENT_CLEAR), true, '경로 밖의 벽');
    WALLS.add(22);
    assert.equal(OPEN_FINDER.remainingClear(ROUTE, 0, 5, 5, SEGMENT_CLEAR), false, '남은 경로 위의 벽');
    WALLS.clear();
    WALLS.add(7);
    assert.equal(OPEN_FINDER.remainingClear(ROUTE, 0, 5, 5, SEGMENT_CLEAR), false);
    assert.equal(OPEN_FINDER.remainingClear(ROUTE, 2, 50, 35, SEGMENT_CLEAR), true, '지나간 구간의 벽은 보지 않음');
    assert.equal(OPEN_FINDER.remainingClear([], 0, 5, 5, SEGMENT_CLEAR), false, '빈 경로');
    assert.throws(() => OPEN_FINDER.remainingClear(ROUTE, 0, 5, 5), TypeError);

    // 결정론: 같은 입력은 몇 번을 돌려도, 다른 탐색기로 돌려도 같은 경로입니다(버퍼 재사용·탐색 순서와 무관).
    const FIRST = FINDER.find(CELL_OF(GRID, 6, 4), [0, CELL_OF(GRID, 0, 4)]).slice();
    FINDER.find(CELL_OF(GRID, 2, 2), [0]);
    assert.deepEqual(FINDER.find(CELL_OF(GRID, 6, 4), [0, CELL_OF(GRID, 0, 4)]), FIRST);
    assert.deepEqual(new RouteFinder(gridFrom(MAZE)).find(CELL_OF(GRID, 6, 4), [0, CELL_OF(GRID, 0, 4)]), FIRST);
    const OUT = [99];
    assert.equal(FINDER.find(0, [0], {}, OUT), OUT, '호출자의 out을 비우고 채움');
    assert.deepEqual(OUT, [0]);
}

// PortalGraph(청크 + 포털 구조): 건물(원)을 놓고 지우는 동안 바뀐 사각형만으로 따라간 구조가 같은 배치에서 처음부터 만든 구조와
// 노드 번호·칸·건너는 비용·청크 안 비용·성분까지 같고, 바뀐 사각형과 겹치는 청크만 다시 만들며, 성분이 실제 연결(시험 안 flood fill)과 같습니다.
{
    const SIDE = 1800,
        RADIUS = 13.62,
        PAD = RADIUS + CELL,
        WALLS = [
            // 가운데를 가르는 벽: 위쪽 틈은 원 하나로 막을 수 있습니다.
            { x0: 880, y0: 160, x1: 920, y1: SIDE },
            { x0: 200, y0: 600, x1: 700, y1: 640 },
        ].map((box, i) => ({
            id: 'wall-' + i,
            points: [
                { x: box.x0, y: box.y0 },
                { x: box.x1, y: box.y0 },
                { x: box.x1, y: box.y1 },
                { x: box.x0, y: box.y1 },
            ],
        }));
    const MAKE = (circles) => {
        const FIELD = new ObstacleField({ width: SIDE, height: SIDE, fixedPoint: 100, polygons: WALLS, circles });
        const GRID = new PathGrid({
            width: SIDE,
            height: SIDE,
            cellSize: CELL,
            passable: (x, y) => FIELD.pointClear(x, y, RADIUS),
            passableEdge: (x, y, tx, ty) => FIELD.segmentClear(x, y, tx, ty, RADIUS, null, true, 0),
        });
        return { field: FIELD, grid: GRID, graph: new PortalGraph(GRID) };
    };
    const DESCRIBE = (graph) => {
        const OUT = [graph.componentCount];
        for (let chunk = 0; chunk < graph.chunkCount; chunk++) {
            const COUNT = graph.chunkNodeCount(chunk);
            OUT.push(COUNT);
            for (let i = 0; i < COUNT; i++) {
                const NODE = graph.chunkNode(chunk, i);
                OUT.push(NODE, graph.nodeCell(NODE), graph.nodeCell(graph.nodePeer(NODE)), graph.nodeCrossCost(NODE));
                for (let j = 0; j < COUNT; j++) {
                    OUT.push(graph.edgeCost(chunk, i, j));
                }
            }
        }
        for (let cell = 0; cell < graph.grid.size; cell++) {
            OUT.push(graph.component(cell));
        }
        return OUT;
    };
    const LIVE = MAKE([]);
    assert.equal(LIVE.graph.chunkSize, 16, '청크 기본 16칸');
    assert.equal(LIVE.graph.portalSpan, 4, '포털 조각 기본 4칸');
    assert.equal(LIVE.graph.prepare(), true, '처음은 전부 만듦');
    assert.equal(LIVE.graph.prepare(), false, '바뀐 것이 없으면 그대로');
    const LEFT = LIVE.grid.cellAt(300, 300),
        RIGHT = LIVE.grid.cellAt(1500, 300);
    assert.equal(LIVE.graph.component(LEFT), LIVE.graph.component(RIGHT), '벽 위쪽 틈으로 이어짐');
    assert.equal(LIVE.graph.component(LIVE.grid.cellAt(900, 900)), -1, '벽 안 칸은 -1');
    const GAP = { id: 1, x: 900, y: 80, r: 90 };
    const STEPS = [
        [{ id: 2, x: 400, y: 1200, r: 70 }],
        [{ id: 2, x: 400, y: 1200, r: 70 }, GAP],
        [GAP],
        [GAP, { id: 3, x: 1300, y: 1500, r: 40 }],
        [{ id: 3, x: 1300, y: 1500, r: 40 }],
    ];
    let previous = [];
    for (const CIRCLES of STEPS) {
        LIVE.field.setCircles(CIRCLES);
        const CHANGED = [
            ...CIRCLES.filter((c) => !previous.includes(c)),
            ...previous.filter((c) => !CIRCLES.includes(c)),
        ];
        const EXPECTED = new Set();
        for (const C of CHANGED) {
            LIVE.grid.invalidateRect(C.x - C.r - PAD, C.y - C.r - PAD, C.x + C.r + PAD, C.y + C.r + PAD);
            // 격자가 기록한 칸 사각형을 한 칸 넓힌 범위와 겹치는 청크만 다시 만듭니다.
            const COL0 = Math.max(0, Math.floor((C.x - C.r - PAD) / CELL) - 1),
                COL1 = Math.min(LIVE.grid.cols - 1, Math.floor((C.x + C.r + PAD) / CELL) + 1),
                ROW0 = Math.max(0, Math.floor((C.y - C.r - PAD) / CELL) - 1),
                ROW1 = Math.min(LIVE.grid.rows - 1, Math.floor((C.y + C.r + PAD) / CELL) + 1);
            for (let row = Math.floor(ROW0 / 16); row <= Math.floor(ROW1 / 16); row++) {
                for (let col = Math.floor(COL0 / 16); col <= Math.floor(COL1 / 16); col++) {
                    EXPECTED.add(row * LIVE.graph.chunkCols + col);
                }
            }
        }
        assert.equal(LIVE.graph.prepare(), true);
        const REBUILT = [];
        for (let chunk = 0; chunk < LIVE.graph.chunkCount; chunk++) {
            if (LIVE.graph.chunkChange(chunk) === 2) {
                REBUILT.push(chunk);
            }
        }
        assert.deepEqual(
            REBUILT,
            [...EXPECTED].sort((a, b) => a - b),
            '겹치는 청크만 다시 만듦',
        );
        assert.deepEqual(DESCRIBE(LIVE.graph), DESCRIBE(MAKE(CIRCLES).graph), '국소 무효화 = 처음부터');
        for (const START of [LEFT, RIGHT, LIVE.grid.cellAt(300, 1500), LIVE.grid.cellAt(1500, 1700)]) {
            const MARKS = floodMarks(LIVE.grid, START);
            const OWN = LIVE.graph.component(START);
            for (let cell = 0; cell < LIVE.grid.size; cell++) {
                assert.equal(OWN >= 0 && LIVE.graph.component(cell) === OWN, MARKS[cell] === 1, '성분 = 실제 연결');
            }
        }
        previous = CIRCLES;
    }
    LIVE.field.setCircles([GAP]);
    LIVE.grid.invalidateRect(GAP.x - GAP.r - PAD, GAP.y - GAP.r - PAD, GAP.x + GAP.r + PAD, GAP.y + GAP.r + PAD);
    assert.notEqual(
        LIVE.graph.component(LEFT),
        LIVE.graph.component(RIGHT),
        '틈을 막으면 질의가 스스로 다시 만들고 갈라짐',
    );
    assert.throws(() => new PortalGraph(LIVE.grid, { chunkSize: 65 }), RangeError);
    assert.throws(() => new PortalGraph(LIVE.grid, { portalSpan: 17 }), RangeError);
    assert.throws(() => new PortalGraph(LIVE.grid, { size: 16 }), TypeError);
    assert.throws(() => new PortalGraph({}), TypeError);
    console.log('pathfield portal graph ok', LIVE.graph.chunkCount, LIVE.graph.componentCount);
}

// FlowField(목표 보관소 + 청크 장): (1) 값이 유한 ⇔ 목표와 같은 성분, (2) lowestNeighbor를 따라가면 값이 엄격히 줄며 목표 칸에 닿음,
// (3) 값 ≥ RouteFinder 정확 비용이고 비율 ≤ 1.15, (4) 질의 순서를 뒤집어도·goalCapacity 1로 밀어내도·새 그래프로 물어도 같은 답,
// (5) 원 추가·제거를 국소 무효화로 따라간 그래프의 답 = 같은 배치로 처음부터 만든 그래프의 답.
{
    const SIDE = 1800,
        RADIUS = 13.62,
        PAD = RADIUS + CELL,
        RATIO_CAP = 1.15,
        WALLS = [
            { x0: 880, y0: 160, x1: 920, y1: SIDE },
            { x0: 200, y0: 600, x1: 700, y1: 640 },
            { x0: 1100, y0: 900, x1: 1500, y1: 940 },
        ].map((box, i) => ({
            id: 'wall-' + i,
            points: [
                { x: box.x0, y: box.y0 },
                { x: box.x1, y: box.y0 },
                { x: box.x1, y: box.y1 },
                { x: box.x0, y: box.y1 },
            ],
        }));
    const GAP = { id: 1, x: 900, y: 80, r: 90 },
        BASE_CIRCLES = [
            { id: 2, x: 400, y: 1200, r: 70 },
            { id: 3, x: 1300, y: 400, r: 60 },
        ];
    const MAKE = (circles, options = {}) => {
        const FIELD = new ObstacleField({ width: SIDE, height: SIDE, fixedPoint: 100, polygons: WALLS, circles });
        const GRID = new PathGrid({
            width: SIDE,
            height: SIDE,
            cellSize: CELL,
            passable: (x, y) => FIELD.pointClear(x, y, RADIUS),
            passableEdge: (x, y, tx, ty) => FIELD.segmentClear(x, y, tx, ty, RADIUS, null, true, 0),
        });
        return { field: FIELD, grid: GRID, graph: new PortalGraph(GRID, options) };
    };
    // 목표 정의(게임의 몫): 점 둘레의 열린 칸. 키는 (목표 번호, 0).
    const GOALS = [
        [300, 300, 60],
        [1500, 1500, 30],
        [1600, 200, 40],
        [200, 1700, 90],
        [1300, 1100, 0],
    ];
    const CELLS_OF_GOAL = (grid, [x, y, r]) => {
        const CELLS = grid.openCellsWithin(x, y, r + CELL * 0.71);
        return CELLS.length ? CELLS : [grid.nearestOpen(grid.cellAt(x, y), 8)];
    };
    const PROBES = [];
    for (let i = 0; i < 160; i++) {
        PROBES.push((i * 7919 + 13) % (75 * 75));
    }
    // 목표마다 탐침 칸의 [값, 가장 싼 이웃]을 이어 붙인 지문.
    const ANSWERS = (world, order) => {
        const OUT = [];
        for (const G of order) {
            const FIELD = world.graph.goal(G, 0) ?? world.graph.setGoal(G, 0, CELLS_OF_GOAL(world.grid, GOALS[G]));
            OUT[G] = PROBES.map((p) => FIELD.distance(p) + ':' + FIELD.lowestNeighbor(p)).join(',');
        }
        return OUT;
    };

    const SPLIT = MAKE([...BASE_CIRCLES, GAP]);
    const FINDER = new RouteFinder(SPLIT.grid);
    let reachable = 0,
        unreachable = 0,
        worstRatio = 1;
    for (let g = 0; g < GOALS.length; g++) {
        const CELLS = CELLS_OF_GOAL(SPLIT.grid, GOALS[g]),
            FIELD = SPLIT.graph.setGoal(g, 0, CELLS),
            GOAL_COMPONENTS = new Set(CELLS.map((c) => SPLIT.graph.component(c)));
        assert.ok(FIELD instanceof FlowField);
        assert.equal(SPLIT.graph.goal(g, 0), FIELD, '보관한 목표를 키로 다시 꺼냄');
        for (const START of PROBES) {
            const COST = FIELD.distance(START);
            // (1) 값이 유한 ⇔ 목표 칸과 같은 성분
            assert.equal(COST !== UNREACHED, GOAL_COMPONENTS.has(SPLIT.graph.component(START)), '유한 ⇔ 같은 성분');
            if (COST === UNREACHED) {
                unreachable++;
                assert.deepEqual(FIELD.descend(START, 8, []), [], '닿지 않으면 빈 내려가기');
                continue;
            }
            reachable++;
            // (2) 엄격히 줄어드는 내려가기가 목표 칸에서 끝남
            let cell = START,
                value = COST;
            const WALK = [];
            while (value > 0) {
                const NEXT = FIELD.lowestNeighbor(cell);
                assert.ok(NEXT >= 0, '목표가 아니면 더 싼 이웃이 있음');
                const NEXT_VALUE = FIELD.distance(NEXT);
                assert.ok(NEXT_VALUE < value, '값이 엄격히 줄어듦');
                WALK.push(NEXT);
                cell = NEXT;
                value = NEXT_VALUE;
            }
            assert.equal(FIELD.lowestNeighbor(cell), -1, '목표 칸에서 멈춤');
            assert.ok(CELLS.includes(cell), '목표 칸에 닿음');
            assert.deepEqual(FIELD.descend(START, WALK.length + 5, []), WALK, 'descend = lowestNeighbor 따라가기');
            // (3) 상한이고 비율이 못박은 값 이하
            assert.ok(FINDER.find(START, CELLS), 'A*도 닿음');
            assert.ok(COST >= FINDER.cost, '값 ≥ 정확한 최단 비용');
            if (FINDER.cost > 0) {
                worstRatio = Math.max(worstRatio, COST / FINDER.cost);
            }
        }
    }
    assert.ok(worstRatio <= RATIO_CAP, `값 ÷ 정확 비용 ${worstRatio} ≤ ${RATIO_CAP}`);
    assert.ok(reachable > 300 && unreachable > 100, '닿는 칸과 닿지 않는 칸을 모두 봄');

    // (4) 순서·밀어내기·새 그래프와 무관
    const ORDER = GOALS.map((_, g) => g);
    const EXPECTED_ANSWERS = ANSWERS(MAKE([...BASE_CIRCLES, GAP]), ORDER);
    assert.deepEqual(ANSWERS(SPLIT, ORDER), EXPECTED_ANSWERS, '이미 물어 둔 그래프 = 새 그래프');
    const REVERSED = MAKE([...BASE_CIRCLES, GAP]);
    const BACKWARD = [];
    for (const G of [...ORDER].reverse()) {
        const FIELD = REVERSED.graph.setGoal(G, 0, CELLS_OF_GOAL(REVERSED.grid, GOALS[G]));
        BACKWARD[G] = [...PROBES]
            .reverse()
            .map((p) => FIELD.distance(p) + ':' + FIELD.lowestNeighbor(p))
            .reverse()
            .join(',');
    }
    assert.deepEqual(BACKWARD, EXPECTED_ANSWERS, '목표·탐침 순서를 뒤집어도 같음');
    const ONE = MAKE([...BASE_CIRCLES, GAP], { goalCapacity: 1 });
    assert.deepEqual(ANSWERS(ONE, [4, 0, 3, 1, 2]), EXPECTED_ANSWERS, '용량 1로 계속 밀어내도 같음');
    assert.equal(ONE.graph.goalCount, 1);
    assert.equal(ONE.graph.goal(4, 0), null, '밀려난 목표는 없음');

    // (5) 원을 놓고 지우며 국소 무효화로 따라간 그래프 = 처음부터
    const LIVE = MAKE(BASE_CIRCLES);
    let previous = BASE_CIRCLES;
    for (const CIRCLES of [
        [...BASE_CIRCLES, GAP],
        [BASE_CIRCLES[1], GAP],
        [BASE_CIRCLES[1], GAP, { id: 4, x: 1500, y: 1350, r: 50 }],
        [BASE_CIRCLES[1], { id: 4, x: 1500, y: 1350, r: 50 }],
    ]) {
        ANSWERS(LIVE, ORDER);
        const HELD = LIVE.graph.goal(0, 0);
        LIVE.field.setCircles(CIRCLES);
        for (const C of [
            ...CIRCLES.filter((c) => !previous.includes(c)),
            ...previous.filter((c) => !CIRCLES.includes(c)),
        ]) {
            LIVE.grid.invalidateRect(C.x - C.r - PAD, C.y - C.r - PAD, C.x + C.r + PAD, C.y + C.r + PAD);
        }
        assert.throws(() => HELD.distance(PROBES[0]), Error, '구조가 바뀌면 들고 있던 유동장은 버려짐');
        assert.equal(LIVE.graph.goalCount, 0, '구조가 바뀌면 보관소를 비움');
        assert.deepEqual(ANSWERS(LIVE, ORDER), ANSWERS(MAKE(CIRCLES), ORDER), '국소 무효화 = 처음부터');
        previous = CIRCLES;
    }

    assert.throws(() => LIVE.graph.goal('a', 0), RangeError);
    assert.throws(() => LIVE.graph.setGoal(0, 0.5, []), RangeError);
    assert.throws(() => LIVE.graph.setGoal(0, 0, [-1]), RangeError);
    assert.throws(() => LIVE.graph.setGoal(0, 0, 5), TypeError);
    assert.throws(() => new FlowField(null, LIVE.graph, null), TypeError);
    console.log('pathfield flow field ok', reachable, unreachable, worstRatio.toFixed(4));
}
