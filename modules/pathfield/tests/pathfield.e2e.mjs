// pathfield 고정 시나리오: 작은 격자에서 비용·모서리 규칙·게으른 확정·내려가기·동률 규칙을 값으로 못 박고,
// geometry의 ObstacleField를 통과 판정으로 연결해 벽의 틈으로 도는 길을 확인한 뒤, rally-frontier가 쓰던
// 격자 거리장(NavigationGrid)이 하던 질의 흐름을 한 판 돌려 결과의 해시가 원본으로 돌린 해시와 같은지 확인합니다.
// 이 파일의 `createPlanner`가 곧 게임이 거리장을 쓸 때의 호출 모양입니다(목표 해석·캐시 정책·직선 광선은 게임의 몫).
import assert from 'node:assert/strict';
import { ObstacleField } from '../../../dist/geometry.js';
import {
    DIAGONAL_COST,
    DistanceField,
    FieldCache,
    MAX_CHANGED_RECTS,
    PathGrid,
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
    const ROUTE = new DistanceField(GRID, [RIGHT]).descend(LEFT, 40);
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
    const OPEN = gridFrom(['...', '...', '...']);
    const FIELD = new DistanceField(OPEN, [4]);
    FIELD.settle();
    assert.deepEqual([...FIELD.dist], [14, 10, 14, 10, 0, 10, 14, 10, 14], '가운데에서 직선 10, 대각 14');
    assert.equal(FIELD.done, true);

    const CORNER = gridFrom(['.#.', '...', '...']);
    const BENT = new DistanceField(CORNER, [0]);
    BENT.settle();
    // (1,0)이 막혀 (0,0)→(1,1) 대각은 모서리를 가로지르므로 못 가고, (0,1)을 지나 20입니다. (1,2)는 (0,1)→(1,2) 대각 24.
    assert.deepEqual([...BENT.dist], [0, UNREACHED, 40, 10, 20, 30, 20, 24, 34]);
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
    // 판정이 바뀐 뒤: sync는 세대가 바뀔 때만 기억을 비운다.
    let wall = true;
    const SWITCHED = new PathGrid({ width: 20, height: 10, cellSize: 10, passable: (x) => x < 10 || !wall });
    assert.equal(SWITCHED.sync(1), true, '처음 알리는 세대는 비움');
    assert.equal(SWITCHED.sync(1), false);
    assert.equal(SWITCHED.isOpen(1), false);
    wall = false;
    assert.equal(SWITCHED.isOpen(1), false, '기억이 남아 있어 아직 막힘');
    const REVISION = SWITCHED.revision;
    assert.equal(SWITCHED.sync(2), true);
    assert.equal(SWITCHED.isOpen(1), true);
    assert.equal(SWITCHED.revision, REVISION + 1);
    // 사각형 무효화: 그 칸만 다시 묻고, 바뀐 칸 범위를 기록 순서대로 한 번 넘겨준다.
    const CHANGED = new Int32Array(4 * MAX_CHANGED_RECTS);
    assert.deepEqual(
        [SWITCHED.takeChangedRects(CHANGED), ...CHANGED.slice(0, 4)],
        [1, 0, 0, 1, 0],
        'sync는 전체 한 개',
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

// ---------- 3. 게으른 확정·여러 출발 칸·내려가기 ----------
{
    const GRID = gridFrom(MAZE);
    const FIELD = new DistanceField(GRID, [0, 0]);
    assert.equal(FIELD.distance(CELL_OF(GRID, 4, 2)), 60, '겹친 출발 칸은 한 번');
    assert.equal(FIELD.done, false, '필요한 칸까지만 확정');
    assert.equal(FIELD.dist[CELL_OF(GRID, 0, 4)], UNREACHED, '아직 닿지 않은 칸은 임시값도 없음');
    assert.equal(FIELD.distance(CELL_OF(GRID, 0, 4)), 120);
    FIELD.settle();
    assert.equal(FIELD.done, true);
    assert.equal(FIELD.dist[CELL_OF(GRID, 6, 4)], 100);
    assert.equal(FIELD.dist[CELL_OF(GRID, 1, 1)], UNREACHED, '막힌 칸');

    const PATH = [];
    const TO_CELLS = (list) => list.map((cell) => [GRID.colOf(cell), GRID.rowOf(cell)].join(','));
    FIELD.descend(CELL_OF(GRID, 0, 4), 8, PATH);
    assert.deepEqual(TO_CELLS(PATH), ['1,4', '2,4', '3,4', '4,4', '4,3', '4,2', '3,2', '2,2'], '틈을 돌아 위로');
    FIELD.descend(CELL_OF(GRID, 0, 4), 99, PATH);
    assert.deepEqual(TO_CELLS(PATH).slice(-4), ['1,2', '0,2', '0,1', '0,0'], '출발 칸에서 멈춤');
    assert.deepEqual(FIELD.descend(0, 5, PATH), [], '출발 칸에서는 갈 곳이 없음');
    assert.equal(PATH, FIELD.descend(0, 5, PATH), '호출자의 out을 채워 돌려줌');
    assert.deepEqual(FIELD.descend(CELL_OF(GRID, 1, 1), 5), [], '닿지 못하는 칸');

    // 여러 출발 칸: 가까운 쪽까지의 비용입니다.
    const TWO = new DistanceField(GRID, [0, CELL_OF(GRID, 6, 4)]);
    TWO.settle();
    assert.deepEqual([TWO.dist[0], TWO.dist[CELL_OF(GRID, 6, 4)], TWO.dist[CELL_OF(GRID, 3, 4)]], [0, 0, 30]);
    assert.throws(() => new DistanceField(GRID, [35]), RangeError);
    assert.throws(() => new DistanceField(GRID, [1.5]), RangeError);
    assert.equal(new DistanceField(GRID, []).done, true, '출발 칸이 없으면 퍼질 곳이 없음');
}
{
    // 동률: 더 싼 이웃이 둘이면 방향 순서(동·남·서·북…)가 앞선 쪽. (1,1)에서 서쪽 (0,1)과 북쪽 (1,0)이 모두 0입니다.
    const GRID = gridFrom(['...', '...', '...']);
    const FIELD = new DistanceField(GRID, [1, 3]);
    FIELD.settle();
    assert.equal(FIELD.lowestNeighbor(4), 3, '서쪽이 북쪽보다 앞');
    assert.equal(FIELD.lowestNeighbor(1), -1);
}

// ---------- 4. 가장 가까운 열린 칸·고리 안의 열린 칸·이어짐 ----------
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

    const REACH = gridFrom(['..#..', '..#..', '..#..']);
    const MARKS = new Uint8Array(REACH.size);
    assert.equal(REACH.reachableFrom(0, MARKS), MARKS, '호출자의 out을 비우고 채움');
    assert.deepEqual([...MARKS], [1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0]);
    assert.deepEqual([...REACH.reachableFrom(2, MARKS)], new Array(15).fill(0), '막힌 칸에서는 아무 데도 못 감');
    assert.deepEqual([...REACH.reachableFrom(-1, MARKS)], new Array(15).fill(0));
    assert.deepEqual(
        [...REACH.reachableFrom(3, MARKS)],
        [0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1],
        '스택을 재사용해도 같음',
    );
    assert.throws(() => REACH.reachableFrom(0), TypeError, 'out은 필수');
    assert.throws(() => REACH.reachableFrom(0, new Uint8Array(4)), TypeError, '칸 수보다 짧은 out');
}

// ---------- 5. 캐시: 용량·낡음·세대 ----------
{
    let wall = true;
    const GRID = new PathGrid({ width: 40, height: 10, cellSize: 10, passable: (x) => !(wall && x > 20 && x < 30) });
    const CACHE = new FieldCache(GRID, { capacity: 2 });
    const FIELD_OF = (source) => new DistanceField(GRID, [source]);
    const A = CACHE.set('a', FIELD_OF(0)),
        B = CACHE.set('b', FIELD_OF(1));
    assert.equal(CACHE.get('a'), A, '꺼내도 순서는 그대로(LRU가 아님)');
    CACHE.set('c', FIELD_OF(3));
    assert.deepEqual(
        [CACHE.has('a'), CACHE.has('b'), CACHE.has('c'), CACHE.size],
        [false, true, true, 2],
        '먼저 넣은 a를 버림',
    );
    assert.equal(CACHE.set('b', FIELD_OF(2)) === B, false);
    CACHE.set('d', FIELD_OF(0));
    assert.deepEqual(
        [CACHE.has('b'), CACHE.has('c'), CACHE.has('d')],
        [false, true, true],
        '덮어써도 b의 순서는 그대로였음',
    );
    assert.equal(CACHE.sync(10), true, '처음 알리는 세대는 비움');
    assert.equal(CACHE.size, 0);
    CACHE.set('x', FIELD_OF(0));
    assert.equal(CACHE.sync(10), false);
    assert.equal(CACHE.has('x'), true);
    assert.equal(CACHE.sync(11), true);
    assert.equal(CACHE.has('x'), false);
    CACHE.set('y', FIELD_OF(0));
    wall = false;
    GRID.invalidate();
    assert.equal(CACHE.get('y'), undefined, '격자가 비워지면 낡은 거리장은 없음');
    assert.throws(() => new FieldCache(GRID, { capacity: 0 }), RangeError);
    assert.throws(() => new FieldCache({}), TypeError);
    assert.equal(new FieldCache(GRID).capacity, Infinity);
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
    assert.throws(() => new DistanceField({}, []), TypeError);
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
        FIELD = new DistanceField(GRID, [GOAL]);
    assert.equal(GRID.reachableFrom(START, new Uint8Array(GRID.size))[GOAL], 1, '틈이 이어 줌');
    const PATH = FIELD.descend(START, 100);
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

// ---------- 9. A* 경로(RouteFinder): 거리장과 같은 비용·막힌 목표·모서리·여러 목표·한도·웨이포인트·재검증·결정론 ----------
{
    const GRID = gridFrom(MAZE),
        FINDER = new RouteFinder(GRID),
        TO_CELLS = (list) => list.map((cell) => [GRID.colOf(cell), GRID.rowOf(cell)].join(','));
    // 같은 격자에서 모든 출발 칸의 A* 비용이 거리장 비용과 같습니다(닿지 못하는 칸은 둘 다 실패).
    const FIELD = new DistanceField(GRID, [0]);
    for (let start = 0; start < GRID.size; start++) {
        const PATH = FINDER.find(start, [0]);
        assert.equal(PATH === null ? UNREACHED : FINDER.cost, FIELD.distance(start), `칸 ${start}의 비용`);
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

// ---------- 10. 원본 격자 거리장과 같은 질의 흐름 ----------
// scenario begin
// 이 구간의 코드는 rally-frontier의 NavigationGrid로 돌려도 같은 결과를 내는 어댑터입니다(`createPlanner`만 다름).
const WORLD_SIZE = 1800;
const CELL = 24;
const MAX_FIXED = 6;
const LOOKAHEAD = 8;
const GOAL_MARGIN = CELL * 0.71;

function randomSource(seed) {
    let state = seed;
    return () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 4294967296;
    };
}

function buildTerrain(rand) {
    const BOXES = [],
        DISCS = [];
    for (let i = 0; i < 12; i++) {
        const X = rand() * WORLD_SIZE,
            Y = rand() * WORLD_SIZE;
        BOXES.push({ x0: X, y0: Y, x1: X + 40 + rand() * 260, y1: Y + 20 + rand() * 90 });
    }
    for (let i = 0; i < 14; i++) {
        DISCS.push({ x: rand() * WORLD_SIZE, y: rand() * WORLD_SIZE, r: 30 + rand() * 90 });
    }
    // 사방이 막힌 방(안쪽 목표는 닿을 수 없음)과, 한쪽 끝이 열린 긴 벽(돌아가야 함)
    BOXES.push(
        { x0: 1400, y0: 200, x1: 1440, y1: 420 },
        { x0: 1600, y0: 200, x1: 1640, y1: 420 },
        { x0: 1400, y0: 200, x1: 1640, y1: 240 },
        { x0: 1400, y0: 380, x1: 1640, y1: 420 },
    );
    for (let i = 0; i < 3; i++) {
        BOXES.push({ x0: i % 2 ? 0 : 300, y0: 700 + i * 350, x1: i % 2 ? 1500 : 1800, y1: 736 + i * 350 });
    }
    return {
        blocked(x, y, r) {
            if (x < r || y < r || x > WORLD_SIZE - r || y > WORLD_SIZE - r) {
                return true;
            }
            for (const B of BOXES) {
                if (x > B.x0 - r && x < B.x1 + r && y > B.y0 - r && y < B.y1 + r) {
                    return true;
                }
            }
            for (const D of DISCS) {
                const DX = x - D.x,
                    DY = y - D.y,
                    NEEDED = D.r + r;
                if (DX * DX + DY * DY < NEEDED * NEEDED) {
                    return true;
                }
            }
            return false;
        },
        segmentClear(x0, y0, x1, y1, r) {
            const STEPS = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8));
            for (let i = 0; i <= STEPS; i++) {
                const T = i / STEPS;
                if (this.blocked(x0 + (x1 - x0) * T, y0 + (y1 - y0) * T, r)) {
                    return false;
                }
            }
            return true;
        },
    };
}

// 모듈로 만든 계획자: 목표 해석(고리 영역·여유)·캐시 정책(고정 목표는 오래, 추격 목표는 틱마다)·"직선 광선이 막히면 거리장"·
// "내려가는 칸 중 보이는 가장 먼 칸"은 모두 게임이 정합니다.
function createPlanner(terrain, radius) {
    const GRID = new PathGrid({
        width: WORLD_SIZE,
        height: WORLD_SIZE,
        cellSize: CELL,
        passable: (x, y) => terrain.blocked(x, y, radius) === false,
    });
    const FIXED = new FieldCache(GRID, { capacity: MAX_FIXED }),
        CHASE = new FieldCache(GRID);
    const DESCENT = [];
    function sources(goal) {
        const FOUND = GRID.openCellsWithin(
            goal.x,
            goal.y,
            goal.radius + GOAL_MARGIN,
            Math.max(0, goal.innerRadius - GOAL_MARGIN),
            goal.terrainLine ? (x, y) => terrain.segmentClear(x, y, goal.x, goal.y, 0) : null,
        );
        if (!FOUND.length) {
            const NEAR = GRID.nearestOpen(GRID.cellAt(goal.x, goal.y), 24);
            if (NEAR >= 0) {
                FOUND.push(NEAR);
            }
        }
        return FOUND;
    }
    return {
        next(x, y, goal, fixed, tick) {
            const CACHE = fixed ? FIXED : CHASE;
            if (!fixed) {
                CHASE.sync(tick);
            }
            const FIELD = CACHE.get(goal.key) ?? CACHE.set(goal.key, new DistanceField(GRID, sources(goal)));
            const START = GRID.nearestOpen(GRID.cellAt(x, y));
            if (START < 0 || FIELD.distance(START) === UNREACHED) {
                return null;
            }
            const PATH = FIELD.descend(START, LOOKAHEAD, DESCENT);
            if (!PATH.length) {
                return { x: GRID.centerX(START), y: GRID.centerY(START) };
            }
            for (let i = PATH.length - 1; i > 0; i--) {
                const PX = GRID.centerX(PATH[i]),
                    PY = GRID.centerY(PATH[i]);
                if (terrain.segmentClear(x, y, PX, PY, radius)) {
                    return { x: PX, y: PY };
                }
            }
            return { x: GRID.centerX(PATH[0]), y: GRID.centerY(PATH[0]) };
        },
        invalidate(version) {
            GRID.sync(version);
        },
        connected(from, points) {
            const REACHED = GRID.reachableFrom(
                GRID.nearestOpen(GRID.cellAt(from.x, from.y), 4),
                new Uint8Array(GRID.size),
            );
            return points.map((p) => {
                const CELL_OF = GRID.nearestOpen(GRID.cellAt(p.x, p.y), 4);
                return CELL_OF >= 0 && REACHED[CELL_OF] === 1 ? 1 : 0;
            });
        },
    };
}

function runScenario(makePlanner) {
    const RAND = randomSource(20261104),
        TERRAIN = buildTerrain(RAND),
        PLANNERS = [makePlanner(TERRAIN, 13.62), makePlanner(TERRAIN, 20.25)],
        GOALS = [];
    for (let i = 0; i < 24; i++) {
        const X = RAND() * WORLD_SIZE,
            Y = RAND() * WORLD_SIZE,
            KIND = i % 4,
            RADIUS = KIND === 0 ? 0 : 20 + RAND() * 160,
            INNER = KIND === 3 ? RADIUS * RAND() * 0.6 : 0;
        GOALS.push({
            x: X,
            y: Y,
            radius: RADIUS,
            innerRadius: INNER,
            terrainLine: KIND === 3 && i % 8 === 3,
            key: `${X}:${Y}:${RADIUS}:${INNER}`,
        });
    }
    GOALS.push(
        { x: 1520, y: 310, radius: 0, innerRadius: 0, terrainLine: false, key: 'room-point' },
        { x: 1520, y: 310, radius: 50, innerRadius: 0, terrainLine: false, key: 'room-range' },
    );
    let text = '',
        unreachable = 0;
    for (let q = 0; q < 700; q++) {
        const TICK = Math.floor(q / 25);
        // 한 번 지형이 바뀌었다고 알립니다(통과 판정 기억과 거리장이 모두 낡음).
        for (const PLANNER of PLANNERS) {
            PLANNER.invalidate(q < 400 ? 1 : 2);
        }
        const GOAL = GOALS[Math.floor(RAND() * GOALS.length)],
            POINT = PLANNERS[q % 2].next(RAND() * WORLD_SIZE, RAND() * WORLD_SIZE, GOAL, GOAL.radius === 0, TICK);
        if (POINT === null) {
            unreachable++;
        }
        text += POINT === null ? 'n;' : `${POINT.x},${POINT.y};`;
    }
    const POINTS = [
        { x: 1700, y: 1700 },
        { x: 900, y: 900 },
        { x: 90, y: 1700 },
        { x: 1520, y: 310 },
        { x: 1500, y: 100 },
    ];
    const CONNECTED = PLANNERS.map((planner) => planner.connected({ x: 90, y: 90 }, POINTS).join(''));
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    }
    return { hash, length: text.length, unreachable, connected: CONNECTED.join() };
}
// scenario end

// 원본(rally-frontier NavigationGrid, 위 어댑터와 같은 질의)으로 같은 흐름을 돌려 얻은 값입니다. 모듈을 바꿔 이 값이 달라지면
// 게임의 이동 목표 점이 달라진다는 뜻입니다.
const EXPECTED = { hash: 3669598282, length: 4766, unreachable: 192, connected: '01101,01101' };
const RESULT = runScenario(createPlanner);
assert.deepEqual(RESULT, EXPECTED);
console.log('pathfield scenario ok', RESULT.hash.toString(16), RESULT.length, RESULT.unreachable);
