// 유닛 하나가 한 번 가는 길을 A*로 찾는 `RouteFinder`입니다. `PortalGraph`·`FlowField`와 같은 격자·비용(직선 10·대각 14)·
// 통과 규칙(칸·변 통과 판정, 모서리 가로지르기 금지)을 씁니다.
// 찾은 길은 칸 번호 배열이라 유닛 상태에 그대로 저장할 수 있고, 따라가기(`advance`)와 남은 길 재검증(`remainingClear`)은
// 저장된 웨이포인트와 인덱스 하나만 읽습니다. 탐색 버퍼는 격자 크기의 타입드 배열을 세대 번호로 재사용합니다.
import { DIRECTION_COST, DIRECTION_COUNT, PathGrid } from './grid.js';

const NO_PARENT = -1;
const MAX_STAMP = 0xffffffff;
// 힙 키는 f * 2^26 + h 하나의 수입니다. 칸 수가 2^22 이하라 h < 10 * 2^22 < 2^26, f < 2^27이므로 키는 2^53 아래에서 정확합니다.
const H_SCALE = 2 ** 26;

// 칸 (dx, dy)만큼 떨어진 곳까지 장애물이 없을 때의 걸음 비용(옥타일 거리). 대각 14·직선 10과 같은 단위라 일관된 하한입니다.
function octile(dx, dy) {
    return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
}

/**
 * 격자 하나에 묶인 A* 탐색기입니다. 탐색 버퍼를 들고 있으므로 격자마다 하나 만들어 재사용합니다.
 * 같은 격자·통과 판정·입력이면 항상 같은 경로를 냅니다(정수 비용, 동률은 f → h → 칸 번호 순).
 */
export class RouteFinder {
    grid;
    /** 마지막 `find`의 결과: `'found'`, `'unreachable'`(닿을 수 없음), `'limit'`(확장 한도 초과). */
    status = 'unreachable';
    /** 마지막 `find`가 찾은 경로의 걸음 비용. 찾지 못했으면 -1. */
    cost = -1;
    /** 마지막 `find`가 확정(확장)한 칸 수. */
    expanded = 0;

    #stamp = 0;
    #seen;
    #closed;
    #goal;
    #g;
    #h;
    #key;
    #parent;
    #heap;
    #heapIndex;
    #heapSize = 0;

    /** @param {PathGrid} grid */
    constructor(grid) {
        if (!(grid instanceof PathGrid)) {
            throw new TypeError('RouteFinder needs a PathGrid.');
        }
        this.grid = grid;
        const SIZE = grid.size;
        this.#seen = new Uint32Array(SIZE);
        this.#closed = new Uint32Array(SIZE);
        this.#goal = new Uint32Array(SIZE);
        this.#g = new Int32Array(SIZE);
        this.#h = new Int32Array(SIZE);
        this.#key = new Float64Array(SIZE);
        this.#parent = new Int32Array(SIZE);
        this.#heap = new Int32Array(SIZE);
        this.#heapIndex = new Int32Array(SIZE);
    }

    /**
     * `start` 칸에서 `goals` 칸 중 가장 싼 칸까지의 최단 경로를 `out`(먼저 비움)에 칸 번호로 채워 돌려줍니다(시작·목표 칸 포함).
     * 닿을 수 없거나 확장한 칸이 `maxExpanded`를 넘으면 null이고 `status`가 이유를 알려 줍니다. `start`가 막힌 칸이면 null,
     * `start`가 목표 칸이면 `[start]`입니다. 막힌 목표 칸에는 닿지 않습니다.
     * @param {number} start
     * @param {ArrayLike<number>} goals
     * @param {{ maxExpanded?: number }} [options]
     * @param {number[]} [out]
     */
    find(start, goals, options = {}, out = []) {
        out.length = 0;
        const GRID = this.grid,
            COLS = GRID.cols,
            MAX_EXPANDED = options.maxExpanded ?? GRID.size;
        if (!Number.isInteger(start) || start < 0 || start >= GRID.size) {
            throw new RangeError(`RouteFinder start ${start} is not a cell of the grid.`);
        }
        if (!(MAX_EXPANDED >= 0)) {
            throw new RangeError('RouteFinder maxExpanded must be a non-negative number.');
        }
        const STAMP = this.#nextStamp(),
            GOAL = this.#goal;
        // 목표 칸들을 감싸는 사각형까지의 옥타일 거리가 휴리스틱입니다(어느 목표까지의 거리보다도 크지 않음).
        let minCol = Infinity,
            maxCol = -Infinity,
            minRow = Infinity,
            maxRow = -Infinity;
        for (let i = 0; i < goals.length; i++) {
            const CELL = goals[i];
            if (!Number.isInteger(CELL) || CELL < 0 || CELL >= GRID.size) {
                throw new RangeError(`RouteFinder goal ${CELL} is not a cell of the grid.`);
            }
            GOAL[CELL] = STAMP;
            const COL = CELL % COLS,
                ROW = (CELL - COL) / COLS;
            minCol = Math.min(minCol, COL);
            maxCol = Math.max(maxCol, COL);
            minRow = Math.min(minRow, ROW);
            maxRow = Math.max(maxRow, ROW);
        }
        this.cost = -1;
        this.expanded = 0;
        this.#heapSize = 0;
        if (!goals.length || !GRID.isOpen(start)) {
            this.status = 'unreachable';
            return null;
        }
        const SEEN = this.#seen,
            CLOSED = this.#closed,
            G = this.#g,
            H = this.#h,
            KEY = this.#key,
            PARENT = this.#parent;
        const HEURISTIC = (col, row) =>
            octile(
                col < minCol ? minCol - col : col > maxCol ? col - maxCol : 0,
                row < minRow ? minRow - row : row > maxRow ? row - maxRow : 0,
            );
        {
            const COL = start % COLS;
            SEEN[start] = STAMP;
            G[start] = 0;
            H[start] = HEURISTIC(COL, (start - COL) / COLS);
            KEY[start] = H[start] * H_SCALE + H[start];
            PARENT[start] = NO_PARENT;
            this.#push(start);
        }
        while (this.#heapSize) {
            const CELL = this.#pop();
            if (GOAL[CELL] === STAMP) {
                this.status = 'found';
                this.cost = G[CELL];
                for (let cell = CELL; cell !== NO_PARENT; cell = PARENT[cell]) {
                    out.push(cell);
                }
                out.reverse();
                return out;
            }
            if (this.expanded >= MAX_EXPANDED) {
                this.status = 'limit';
                return null;
            }
            CLOSED[CELL] = STAMP;
            this.expanded++;
            const COL = CELL % COLS,
                ROW = (CELL - COL) / COLS,
                COST = G[CELL];
            for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                const NEXT = GRID.stepCell(COL, ROW, direction);
                if (NEXT < 0 || CLOSED[NEXT] === STAMP) {
                    continue;
                }
                const TOTAL = COST + DIRECTION_COST[direction];
                if (SEEN[NEXT] !== STAMP) {
                    const NEXT_COL = NEXT % COLS;
                    SEEN[NEXT] = STAMP;
                    H[NEXT] = HEURISTIC(NEXT_COL, (NEXT - NEXT_COL) / COLS);
                    G[NEXT] = TOTAL;
                    KEY[NEXT] = (TOTAL + H[NEXT]) * H_SCALE + H[NEXT];
                    PARENT[NEXT] = CELL;
                    this.#push(NEXT);
                } else if (TOTAL < G[NEXT]) {
                    G[NEXT] = TOTAL;
                    KEY[NEXT] = (TOTAL + H[NEXT]) * H_SCALE + H[NEXT];
                    PARENT[NEXT] = CELL;
                    this.#siftUp(this.#heapIndex[NEXT]);
                }
            }
        }
        this.status = 'unreachable';
        return null;
    }

    /**
     * 칸 경로를 꺾이는 칸만 남긴 웨이포인트(칸 번호)로 줄여 `out`(먼저 비움)에 채웁니다. 첫 칸과 마지막 칸은 항상 남습니다.
     * `lineClear(x0, y0, x1, y1)`(두 칸 중심 사이를 막힘 없이 갈 수 있는가)를 주면, 남은 웨이포인트 중 보이는 가장 먼 것으로
     * 건너뛰어 더 줄입니다. 콜백은 순수해야 하고, 결과의 이웃한 두 웨이포인트는 격자 직선이거나 콜백이 통과시킨 구간입니다.
     * @param {ArrayLike<number>} cells `find`의 결과.
     * @param {((x0: number, y0: number, x1: number, y1: number) => boolean) | null} [lineClear]
     * @param {number[]} [out]
     */
    waypoints(cells, lineClear = null, out = []) {
        out.length = 0;
        const GRID = this.grid,
            COLS = GRID.cols,
            LENGTH = cells.length;
        if (!LENGTH) {
            return out;
        }
        // 1단계: 걸음 방향이 바뀌는 칸만 남깁니다.
        out.push(cells[0]);
        for (let i = 1; i < LENGTH - 1; i++) {
            const PREVIOUS = cells[i - 1],
                CELL = cells[i],
                NEXT = cells[i + 1];
            if (
                (CELL % COLS) - (PREVIOUS % COLS) !== (NEXT % COLS) - (CELL % COLS) ||
                Math.floor(CELL / COLS) - Math.floor(PREVIOUS / COLS) !==
                    Math.floor(NEXT / COLS) - Math.floor(CELL / COLS)
            ) {
                out.push(CELL);
            }
        }
        if (LENGTH > 1) {
            out.push(cells[LENGTH - 1]);
        }
        if (lineClear === null || out.length < 3) {
            return out;
        }
        // 2단계: 기준 웨이포인트에서 다음 다음 웨이포인트가 보이는 동안 사이의 것을 버립니다(앞에서부터 한 번 훑음).
        let kept = 1,
            anchor = out[0];
        for (let i = 1; i < out.length - 1; i++) {
            const NEXT = out[i + 1];
            if (!lineClear(GRID.centerX(anchor), GRID.centerY(anchor), GRID.centerX(NEXT), GRID.centerY(NEXT))) {
                anchor = out[i];
                out[kept++] = anchor;
            }
        }
        out[kept++] = out[out.length - 1];
        out.length = kept;
        return out;
    }

    /**
     * 저장된 웨이포인트를 따라갈 때 지금 향할 웨이포인트의 인덱스입니다. `index`(지난번 값)에서 시작해, 웨이포인트에
     * `reach` 이내로 다가왔거나 `lineClear`가 (x, y)에서 다음 웨이포인트를 막힘 없이 본다면 다음으로 넘어갑니다. 인덱스는
     * 줄지 않고 마지막 웨이포인트에서 멈춥니다. 도착 판정(마지막 웨이포인트나 목표에 닿았는가)은 호출자의 몫입니다.
     * @param {ArrayLike<number>} waypoints
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {number} [reach]
     * @param {((x0: number, y0: number, x1: number, y1: number) => boolean) | null} [lineClear]
     */
    advance(waypoints, index, x, y, reach = 0, lineClear = null) {
        const GRID = this.grid,
            LAST = waypoints.length - 1,
            REACH_SQUARED = reach * reach;
        let current = Math.max(0, Math.min(index, LAST));
        while (current < LAST) {
            const CELL = waypoints[current],
                DX = GRID.centerX(CELL) - x,
                DY = GRID.centerY(CELL) - y;
            if (DX * DX + DY * DY <= REACH_SQUARED) {
                current++;
                continue;
            }
            const NEXT = waypoints[current + 1];
            if (lineClear !== null && lineClear(x, y, GRID.centerX(NEXT), GRID.centerY(NEXT))) {
                current++;
                continue;
            }
            break;
        }
        return current;
    }

    /**
     * (x, y)에서 `waypoints[index]`로, 거기서 마지막 웨이포인트까지 이어지는 남은 구간이 모두 `segmentClear`를 통과하는지.
     * 건물 배치가 바뀐 뒤 저장된 경로를 버릴지(다시 찾을지) 정할 때 씁니다. 지나간 구간은 보지 않습니다.
     * @param {ArrayLike<number>} waypoints
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {(x0: number, y0: number, x1: number, y1: number) => boolean} segmentClear
     */
    remainingClear(waypoints, index, x, y, segmentClear) {
        if (typeof segmentClear !== 'function') {
            throw new TypeError('RouteFinder remainingClear needs a segmentClear function.');
        }
        const GRID = this.grid,
            LAST = waypoints.length - 1;
        if (LAST < 0) {
            return false;
        }
        let fromX = x,
            fromY = y;
        for (let i = Math.max(0, Math.min(index, LAST)); i <= LAST; i++) {
            const TO_X = GRID.centerX(waypoints[i]),
                TO_Y = GRID.centerY(waypoints[i]);
            if (!segmentClear(fromX, fromY, TO_X, TO_Y)) {
                return false;
            }
            fromX = TO_X;
            fromY = TO_Y;
        }
        return true;
    }

    #nextStamp() {
        if (this.#stamp === MAX_STAMP) {
            this.#stamp = 0;
            this.#seen.fill(0);
            this.#closed.fill(0);
            this.#goal.fill(0);
        }
        return ++this.#stamp;
    }

    #push(cell) {
        const INDEX = this.#heapSize++;
        this.#heap[INDEX] = cell;
        this.#heapIndex[cell] = INDEX;
        this.#siftUp(INDEX);
    }

    #pop() {
        const HEAP = this.#heap,
            TOP = HEAP[0],
            LAST = HEAP[--this.#heapSize];
        if (this.#heapSize) {
            HEAP[0] = LAST;
            this.#heapIndex[LAST] = 0;
            this.#siftDown(0);
        }
        return TOP;
    }

    #siftUp(index) {
        const HEAP = this.#heap,
            HEAP_INDEX = this.#heapIndex,
            KEY = this.#key,
            CELL = HEAP[index],
            CELL_KEY = KEY[CELL];
        let i = index;
        while (i > 0) {
            const PARENT = (i - 1) >> 1,
                PARENT_CELL = HEAP[PARENT],
                PARENT_KEY = KEY[PARENT_CELL];
            // 힙 순서: f가 작은 칸, 같으면 h가 작은 칸(목표에 더 가까운 칸), 같으면 칸 번호가 작은 칸.
            if (PARENT_KEY < CELL_KEY || (PARENT_KEY === CELL_KEY && PARENT_CELL < CELL)) {
                break;
            }
            HEAP[i] = PARENT_CELL;
            HEAP_INDEX[PARENT_CELL] = i;
            i = PARENT;
        }
        HEAP[i] = CELL;
        HEAP_INDEX[CELL] = i;
    }

    #siftDown(index) {
        const HEAP = this.#heap,
            HEAP_INDEX = this.#heapIndex,
            KEY = this.#key,
            SIZE = this.#heapSize,
            CELL = HEAP[index],
            CELL_KEY = KEY[CELL];
        let i = index;
        for (;;) {
            let child = 2 * i + 1;
            if (child >= SIZE) {
                break;
            }
            if (child + 1 < SIZE) {
                const LEFT_KEY = KEY[HEAP[child]],
                    RIGHT_KEY = KEY[HEAP[child + 1]];
                if (RIGHT_KEY < LEFT_KEY || (RIGHT_KEY === LEFT_KEY && HEAP[child + 1] < HEAP[child])) {
                    child++;
                }
            }
            const CHILD_KEY = KEY[HEAP[child]];
            if (CELL_KEY < CHILD_KEY || (CELL_KEY === CHILD_KEY && CELL < HEAP[child])) {
                break;
            }
            HEAP[i] = HEAP[child];
            HEAP_INDEX[HEAP[child]] = i;
            i = child;
        }
        HEAP[i] = CELL;
        HEAP_INDEX[CELL] = i;
    }
}
