// 정수 비용 격자 위의 거리장을 만드는 데 필요한 격자입니다. 호출자가 준 통과 판정을 칸마다 한 번만 부르고 기억하며,
// 8방향 이동 규칙(직선 10·대각 14, 모서리 가로지르기 없음)과 칸 번호 계산의 단일 원본입니다.
// 시간·난수·DOM을 읽지 않고 Map·문자열 키가 없습니다. 통과 판정이 순수하면 같은 호출 순서는 같은 결과를 냅니다.

/** 직선 한 칸의 비용. */
export const STRAIGHT_COST = 10;
/** 대각 한 칸의 비용. */
export const DIAGONAL_COST = 14;
// 칸 하나에서 이웃으로 가는 8방향입니다. 순서가 곧 동률 규칙이므로 바꾸면 결과가 달라집니다.
export const DIRECTION_COUNT = 8;
export const DIRECTION_DX = Int8Array.of(1, 0, -1, 0, 1, -1, -1, 1);
export const DIRECTION_DY = Int8Array.of(0, 1, 0, -1, 1, 1, -1, -1);
export const DIRECTION_COST = Uint8Array.of(
    STRAIGHT_COST,
    STRAIGHT_COST,
    STRAIGHT_COST,
    STRAIGHT_COST,
    DIAGONAL_COST,
    DIAGONAL_COST,
    DIAGONAL_COST,
    DIAGONAL_COST,
);

// 거리장의 힙 키가 cost * 2^k + 칸 번호로 정확히 표현되도록 칸 수를 제한합니다(키는 2^53 아래, 비용은 Int32 안).
const MAX_CELLS = 1 << 22;
const UNKNOWN = -1;
const BLOCKED = 0;
const OPEN = 1;
const OPTIONS = ['width', 'height', 'cellSize', 'passable', 'originX', 'originY'];

function positiveNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`PathGrid ${name} must be a positive finite number.`);
    }
    return value;
}

function finiteNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RangeError(`PathGrid ${name} must be a finite number.`);
    }
    return value;
}

/**
 * 거리장이 걷는 격자입니다. 칸 번호는 행 우선(`row * cols + col`)이고, 칸의 통과 여부는 칸 중심 좌표로 호출자의
 * `passable`을 한 번 불러 기억합니다. 장애물이 바뀌면 `invalidate()`(또는 `sync(version)`)로 기억을 비웁니다.
 */
export class PathGrid {
    /** 칸 한 변의 크기(좌표와 같은 단위). */
    cellSize;
    /** 칸 (0, 0)의 좌표 원점. */
    originX;
    originY;
    /** 열·행·총 칸 수. 칸 수는 `ceil(크기 / cellSize)`입니다. */
    cols;
    rows;
    size;
    /** 통과 판정을 비운 횟수. 이 격자에서 만든 거리장과 캐시가 낡았는지 알아보는 표식입니다. */
    revision = 0;

    #passable;
    #open;
    #version;

    constructor(options) {
        if (options === null || typeof options !== 'object') {
            throw new TypeError('PathGrid options must be an object.');
        }
        for (const KEY of Object.keys(options)) {
            if (!OPTIONS.includes(KEY)) {
                throw new TypeError(`PathGrid has an unknown option: ${KEY}`);
            }
        }
        if (typeof options.passable !== 'function') {
            throw new TypeError('PathGrid passable must be a function.');
        }
        this.cellSize = positiveNumber(options.cellSize, 'cellSize');
        this.originX = finiteNumber(options.originX ?? 0, 'originX');
        this.originY = finiteNumber(options.originY ?? 0, 'originY');
        this.cols = Math.ceil(positiveNumber(options.width, 'width') / this.cellSize);
        this.rows = Math.ceil(positiveNumber(options.height, 'height') / this.cellSize);
        this.size = this.cols * this.rows;
        if (this.size > MAX_CELLS) {
            throw new RangeError(`PathGrid would need more than ${MAX_CELLS} cells; use a larger cellSize.`);
        }
        this.#passable = options.passable;
        this.#open = new Int8Array(this.size).fill(UNKNOWN);
    }

    /** 좌표가 든 칸의 번호. 격자 밖은 가장자리 칸으로 자릅니다. 좌표는 NaN이 아니어야 합니다. */
    cellAt(x, y) {
        const COL = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.originX) / this.cellSize))),
            ROW = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.originY) / this.cellSize)));
        return ROW * this.cols + COL;
    }

    colOf(cell) {
        return cell % this.cols;
    }

    rowOf(cell) {
        return Math.floor(cell / this.cols);
    }

    /** 칸 중심의 좌표. */
    centerX(cell) {
        return this.originX + ((cell % this.cols) + 0.5) * this.cellSize;
    }

    centerY(cell) {
        return this.originY + (Math.floor(cell / this.cols) + 0.5) * this.cellSize;
    }

    /** 칸이 통과 가능한지. 처음 물으면 `passable(centerX, centerY, cell)`을 한 번 부르고 기억합니다. 격자 밖 번호는 false. */
    isOpen(cell) {
        let open = this.#open[cell];
        if (open === UNKNOWN) {
            open = this.#passable(this.centerX(cell), this.centerY(cell), cell) ? OPEN : BLOCKED;
            this.#open[cell] = open;
        }
        return open === OPEN;
    }

    /**
     * (col, row)에서 방향 `direction`(0..7)으로 한 걸음 갈 수 있으면 이웃 칸 번호, 아니면 -1. 이웃이 격자 밖이거나
     * 막혔거나, 대각이면서 두 직교 이웃 중 하나가 막힌 경우(모서리 가로지르기 금지)입니다.
     */
    stepCell(col, row, direction) {
        const DX = DIRECTION_DX[direction],
            DY = DIRECTION_DY[direction],
            NX = col + DX,
            NY = row + DY;
        if (NX < 0 || NY < 0 || NX >= this.cols || NY >= this.rows) {
            return -1;
        }
        const NEXT = NY * this.cols + NX;
        if (!this.isOpen(NEXT)) {
            return -1;
        }
        if (DX !== 0 && DY !== 0 && (!this.isOpen(row * this.cols + NX) || !this.isOpen(NY * this.cols + col))) {
            return -1;
        }
        return NEXT;
    }

    /** 통과 판정의 기억을 비우고 `revision`을 올립니다. 장애물이 바뀐 뒤에 부릅니다. */
    invalidate() {
        this.#open.fill(UNKNOWN);
        this.revision++;
    }

    /** 게임이 가진 장애물 배치의 세대 번호를 알립니다. 지난번과 다르면 `invalidate()`하고 true를 돌려줍니다. */
    sync(version) {
        if (version === this.#version) {
            return false;
        }
        this.#version = version;
        this.invalidate();
        return true;
    }

    /**
     * 가장 가까운 통과 가능한 칸. `cell` 자신이 열려 있으면 그 칸이고, 아니면 정사각 고리를 `maxRing`까지 넓히며 찾습니다.
     * 같은 고리 안의 동률은 훑는 순서(행 오름차순, 행 안에서 열 오름차순)에서 먼저인 칸입니다. 없으면 -1.
     */
    nearestOpen(cell, maxRing = 12) {
        if (!(cell >= 0 && cell < this.size)) {
            return -1;
        }
        if (this.isOpen(cell)) {
            return cell;
        }
        const COL = cell % this.cols,
            ROW = (cell - COL) / this.cols;
        for (let ring = 1; ring <= maxRing; ring++) {
            let best = -1,
                bestD = Infinity;
            for (let dy = -ring; dy <= ring; dy++) {
                const NY = ROW + dy;
                if (NY < 0 || NY >= this.rows) {
                    continue;
                }
                // 고리의 첫·마지막 행은 모든 칸, 그 사이 행은 양 끝 칸만 봅니다.
                const STRIDE = dy === -ring || dy === ring ? 1 : 2 * ring;
                for (let dx = -ring; dx <= ring; dx += STRIDE) {
                    const NX = COL + dx;
                    if (NX < 0 || NX >= this.cols) {
                        continue;
                    }
                    const NEXT = NY * this.cols + NX,
                        D = dx * dx + dy * dy;
                    if (D < bestD && this.isOpen(NEXT)) {
                        best = NEXT;
                        bestD = D;
                    }
                }
            }
            if (best >= 0) {
                return best;
            }
        }
        return -1;
    }

    /**
     * (x, y)에서 중심까지의 거리가 `innerRadius` 이상 `outerRadius` 이하이고 통과 가능한 칸을 `out`(먼저 비움)에 행 우선으로
     * 채웁니다. `accept(centerX, centerY, cell)`을 주면 그것도 통과한 칸만 남깁니다(예: 목표가 보이는 칸). 목표 영역의
     * 여유(칸 대각선의 절반 등)를 더하는 것은 호출자의 몫입니다.
     */
    openCellsWithin(x, y, outerRadius, innerRadius = 0, accept = null, out = []) {
        out.length = 0;
        const COL0 = Math.max(0, Math.floor((x - outerRadius - this.originX) / this.cellSize)),
            COL1 = Math.min(this.cols - 1, Math.floor((x + outerRadius - this.originX) / this.cellSize)),
            ROW0 = Math.max(0, Math.floor((y - outerRadius - this.originY) / this.cellSize)),
            ROW1 = Math.min(this.rows - 1, Math.floor((y + outerRadius - this.originY) / this.cellSize));
        for (let row = ROW0; row <= ROW1; row++) {
            for (let col = COL0; col <= COL1; col++) {
                const CELL = row * this.cols + col,
                    CX = this.centerX(CELL),
                    CY = this.centerY(CELL),
                    D = Math.hypot(CX - x, CY - y);
                if (D > outerRadius || D < innerRadius || !this.isOpen(CELL)) {
                    continue;
                }
                if (accept !== null && !accept(CX, CY, CELL)) {
                    continue;
                }
                out.push(CELL);
            }
        }
        return out;
    }

    /**
     * `start`(열린 칸)에서 8방향으로 걸어 닿는 칸을 1로 표시한 `Uint8Array(size)`. `start`가 열려 있지 않으면(-1 포함) 모두 0입니다.
     * 거리장보다 가볍게 "이어져 있는가"만 알고 싶을 때 씁니다. `out`을 주면 그것을 비우고 채웁니다.
     */
    reachableFrom(start, out = new Uint8Array(this.size)) {
        out.fill(0);
        if (!this.isOpen(start)) {
            return out;
        }
        const STACK = [start];
        out[start] = 1;
        while (STACK.length) {
            const CELL = STACK.pop(),
                COL = CELL % this.cols,
                ROW = (CELL - COL) / this.cols;
            for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                const NEXT = this.stepCell(COL, ROW, direction);
                if (NEXT >= 0 && out[NEXT] === 0) {
                    out[NEXT] = 1;
                    STACK.push(NEXT);
                }
            }
        }
        return out;
    }
}
