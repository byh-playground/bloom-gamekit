// 여러 출발 칸에서 퍼지는 정수 비용 거리장과, 그 위를 내려가는 `descend`입니다.
// 비용은 PathGrid의 8방향 규칙(직선 10·대각 14)이고, 힙은 (비용, 칸 번호)를 하나의 수로 묶어 동점을 칸 번호로 가립니다.
// 거리장은 게으르게 확정됩니다: `settle(cell)`은 그 칸의 값이 확정될 때까지만 퍼지므로 가까운 질의 하나는 지도 전체를 훑지 않습니다.
import { DIRECTION_COST, DIRECTION_COUNT, PathGrid } from './grid.js';

/** 닿지 못한 칸의 값. */
export const UNREACHED = 0x7fffffff;

// (비용, 칸 번호)를 `비용 * scale + 칸 번호` 하나의 수로 묶은 이진 최소 힙입니다. scale은 칸 수 이상의 2의 거듭제곱이라
// 나눗셈이 정확하고, 비용이 같으면 칸 번호가 작은 쪽이 먼저 나옵니다.
class CellHeap {
    scale;
    keys = [];

    constructor(scale) {
        this.scale = scale;
    }

    get size() {
        return this.keys.length;
    }

    push(cost, cell) {
        const KEYS = this.keys,
            KEY = cost * this.scale + cell;
        let i = KEYS.length;
        KEYS.push(KEY);
        while (i > 0) {
            const PARENT = (i - 1) >> 1;
            if (KEYS[PARENT] <= KEY) {
                break;
            }
            KEYS[i] = KEYS[PARENT];
            i = PARENT;
        }
        KEYS[i] = KEY;
    }

    pop() {
        const KEYS = this.keys,
            TOP = KEYS[0],
            LAST = KEYS.pop();
        if (KEYS.length) {
            let i = 0;
            for (;;) {
                let child = 2 * i + 1;
                if (child >= KEYS.length) {
                    break;
                }
                if (child + 1 < KEYS.length && KEYS[child + 1] < KEYS[child]) {
                    child++;
                }
                if (KEYS[child] >= LAST) {
                    break;
                }
                KEYS[i] = KEYS[child];
                i = child;
            }
            KEYS[i] = LAST;
        }
        return TOP;
    }
}

/**
 * 출발 칸(들)에서 각 칸까지의 걸음 비용입니다. 출발 칸은 0이고, 닿지 못한 칸은 `UNREACHED`입니다.
 * `dist`의 값은 `settle`이 확정한 칸만 믿을 수 있고, 확정하지 않은 칸의 값은 임시입니다(실제보다 크거나 `UNREACHED`).
 */
export class DistanceField {
    grid;
    /** 칸마다 비용. `settle`(또는 `distance`)로 확정한 칸만 최종값입니다. */
    dist;
    /** 모든 칸이 확정됐는지(힙이 비었는지). */
    done;

    #heap;

    /**
     * @param {PathGrid} grid 걸어갈 격자.
     * @param {ArrayLike<number>} sources 출발 칸 번호. 열린 칸을 넘기세요(닫힌 칸을 넘기면 거기서 퍼집니다). 같은 칸이 겹쳐도 됩니다.
     */
    constructor(grid, sources) {
        if (!(grid instanceof PathGrid)) {
            throw new TypeError('DistanceField needs a PathGrid.');
        }
        this.grid = grid;
        this.dist = new Int32Array(grid.size).fill(UNREACHED);
        let scale = 1;
        while (scale < grid.size) {
            scale *= 2;
        }
        this.#heap = new CellHeap(scale);
        for (let i = 0; i < sources.length; i++) {
            const CELL = sources[i];
            if (!Number.isInteger(CELL) || CELL < 0 || CELL >= grid.size) {
                throw new RangeError(`DistanceField source ${CELL} is not a cell of the grid.`);
            }
            if (this.dist[CELL] !== 0) {
                this.dist[CELL] = 0;
                this.#heap.push(0, CELL);
            }
        }
        this.done = this.#heap.size === 0;
    }

    /**
     * 비용 순서로 칸을 확정해 갑니다. `target`을 주면 그 칸이 확정되는 즉시(자기보다 싼 칸이 힙에 없을 때) 멈추고, 주지 않으면
     * 닿을 수 있는 모든 칸을 확정합니다. `target`이 확정되면 그보다 싸거나 같은 비용의 칸도 모두 확정입니다.
     */
    settle(target = -1) {
        const GRID = this.grid,
            COLS = GRID.cols,
            DIST = this.dist,
            HEAP = this.#heap,
            SCALE = HEAP.scale;
        while (HEAP.size) {
            // 힙에 target보다 싼 칸이 없으면 target은 확정입니다.
            if (target >= 0 && DIST[target] < Math.floor(HEAP.keys[0] / SCALE)) {
                return;
            }
            const KEY = HEAP.pop(),
                CELL = KEY % SCALE,
                COST = (KEY - CELL) / SCALE;
            if (COST > DIST[CELL]) {
                continue;
            }
            const COL = CELL % COLS,
                ROW = (CELL - COL) / COLS;
            for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                const NEXT = GRID.stepCell(COL, ROW, direction);
                if (NEXT < 0) {
                    continue;
                }
                const TOTAL = COST + DIRECTION_COST[direction];
                if (TOTAL < DIST[NEXT]) {
                    DIST[NEXT] = TOTAL;
                    HEAP.push(TOTAL, NEXT);
                }
            }
        }
        this.done = true;
    }

    /** `cell`의 비용을 확정해 돌려줍니다(닿지 못하면 `UNREACHED`). 지도 전체가 아니라 그 칸까지만 퍼뜨립니다. */
    distance(cell) {
        this.settle(cell);
        return this.dist[cell];
    }

    /**
     * `cell`에서 가장 싼 이웃 칸(`cell`보다 싼 이웃 중 최저, 같으면 방향 순서가 앞선 쪽)의 번호, 없으면 -1.
     * `cell`의 비용이 확정되어 있어야 합니다(`descend`는 알아서 확정합니다).
     */
    lowestNeighbor(cell) {
        const GRID = this.grid,
            DIST = this.dist,
            COL = cell % GRID.cols,
            ROW = (cell - COL) / GRID.cols;
        let best = -1,
            bestCost = DIST[cell];
        for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
            const NEXT = GRID.stepCell(COL, ROW, direction);
            // `cell`보다 싼 칸은 이미 확정된 칸이라 임시값을 읽을 일이 없습니다.
            if (NEXT >= 0 && DIST[NEXT] < bestCost) {
                best = NEXT;
                bestCost = DIST[NEXT];
            }
        }
        return best;
    }

    /**
     * `start`에서 비용이 줄어드는 쪽으로 최대 `maxSteps`칸을 걸은 칸 번호를 `out`(먼저 비움)에 채웁니다. `start` 자신은 넣지 않고,
     * 출발 칸이나 더 싼 이웃이 없는 칸에서 멈춥니다. `start`가 닿지 못하는 칸이면 빈 결과입니다. `start`까지 확정합니다.
     * 어느 칸을 목표로 삼을지(가장 먼 보이는 칸, 첫 칸 등)는 호출자가 이 목록에서 고릅니다.
     */
    descend(start, maxSteps, out = []) {
        out.length = 0;
        if (this.distance(start) === UNREACHED) {
            return out;
        }
        let cell = start;
        for (let i = 0; i < maxSteps; i++) {
            const NEXT = this.lowestNeighbor(cell);
            if (NEXT < 0) {
                break;
            }
            out.push(NEXT);
            cell = NEXT;
        }
        return out;
    }
}
