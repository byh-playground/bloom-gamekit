// 경계 상자(minX·maxX·minY·maxY)를 가진 항목을 고정 칸 격자에 넣어 두고 범위로 후보를 찾는 AABB 버킷 색인입니다.
// 항목이 고정이라 만들 때 칸 범위를 알므로 버킷은 CSR(칸별 시작 위치 + 항목 번호의 평평한 Int32Array)입니다.
// 칸 안의 순서는 항목 번호 오름차순, 조회는 행(y) 바깥·열(x) 안쪽 순서입니다. 항목이 바뀌면 `rebuild`로 다시 채웁니다.

// 항목이 덮는 칸 사각형이 이보다 크면 칸 크기를 키우라고 알립니다(시작 위치 배열의 크기).
const MAX_CELLS = 1 << 22;

export class BoundsIndex {
    /** 마지막 `query`가 돌려준 항목들의 항목 번호(`items`의 위치). `out`과 같은 순서이고 `out.length`까지만 유효합니다. */
    found = new Int32Array(0);

    #cols = 0;
    #rows = 0;
    #col0 = 0;
    #row0 = 0;
    #start = new Int32Array(1);
    #entries = new Int32Array(0);

    /**
     * @param {Array<{minX: number, maxX: number, minY: number, maxY: number}>} items 경계를 가진 항목(보관만 하고 복사하지 않습니다)
     * @param {number} cell 칸 한 변의 길이
     */
    constructor(items, cell = 256) {
        this.cell = cell;
        this.marks = new Uint32Array(0);
        this.epoch = 0;
        this.out = [];
        this.rebuild(items);
    }

    /**
     * 항목 목록을 바꿔 색인을 다시 채웁니다. 버퍼는 용량이 모자랄 때만 새로 만듭니다(목록은 복사하지 않고 보관합니다).
     * 칸 범위는 항목들이 덮는 칸 사각형이고, 그 칸 수가 2^22를 넘으면 RangeError입니다(칸 크기를 키우세요).
     */
    rebuild(items) {
        const CELL = this.cell,
            COUNT = items.length;
        this.items = items;
        let col0 = Infinity,
            col1 = -Infinity,
            row0 = Infinity,
            row1 = -Infinity;
        for (let i = 0; i < COUNT; i++) {
            const B = items[i];
            col0 = Math.min(col0, Math.floor(B.minX / CELL));
            col1 = Math.max(col1, Math.floor(B.maxX / CELL));
            row0 = Math.min(row0, Math.floor(B.minY / CELL));
            row1 = Math.max(row1, Math.floor(B.maxY / CELL));
        }
        if (!COUNT) {
            col0 = col1 = row0 = row1 = 0;
        }
        const COLS = col1 - col0 + 1,
            ROWS = row1 - row0 + 1;
        if (!(COLS * ROWS <= MAX_CELLS)) {
            throw new RangeError(`BoundsIndex would need ${COLS} × ${ROWS} cells; use a larger cell.`);
        }
        this.#cols = COLS;
        this.#rows = ROWS;
        this.#col0 = col0;
        this.#row0 = row0;
        if (this.#start.length < COLS * ROWS + 1) {
            this.#start = new Int32Array(COLS * ROWS + 1);
        } else {
            this.#start.fill(0, 0, COLS * ROWS + 1);
        }
        if (this.marks.length < COUNT) {
            this.marks = new Uint32Array(COUNT);
            this.found = new Int32Array(COUNT);
            this.epoch = 0;
        }
        // 1) 칸마다 항목 수를 세고 2) 누적해 시작 위치를 만들고 3) 항목 번호 순서로 놓습니다(칸 안 순서 = 항목 번호 순서).
        const START = this.#start;
        let total = 0;
        for (let i = 0; i < COUNT; i++) {
            const B = items[i],
                X0 = Math.floor(B.minX / CELL) - col0,
                X1 = Math.floor(B.maxX / CELL) - col0;
            for (let y = Math.floor(B.minY / CELL) - row0; y <= Math.floor(B.maxY / CELL) - row0; y++) {
                for (let x = X0; x <= X1; x++) {
                    START[y * COLS + x + 1]++;
                    total++;
                }
            }
        }
        for (let k = 1; k <= COLS * ROWS; k++) {
            START[k] += START[k - 1];
        }
        if (this.#entries.length < total) {
            this.#entries = new Int32Array(total);
        }
        const ENTRIES = this.#entries;
        for (let i = 0; i < COUNT; i++) {
            const B = items[i],
                X0 = Math.floor(B.minX / CELL) - col0,
                X1 = Math.floor(B.maxX / CELL) - col0;
            for (let y = Math.floor(B.minY / CELL) - row0; y <= Math.floor(B.maxY / CELL) - row0; y++) {
                for (let x = X0; x <= X1; x++) {
                    // 놓을 때 시작 위치를 한 칸씩 밀고, 다 놓은 뒤 한 칸 되돌립니다.
                    ENTRIES[START[y * COLS + x]++] = i;
                }
            }
        }
        for (let k = COLS * ROWS; k > 0; k--) {
            START[k] = START[k - 1];
        }
        START[0] = 0;
        return this;
    }

    /**
     * (x0, y0)-(x1, y1) 상자를 `pad`만큼 넓힌 범위와 경계가 겹치는 항목을 돌려줍니다. 항목 번호는 `found`에 같은 순서로 담깁니다.
     * 돌려주는 배열은 색인이 재사용하는 것이라 다음 `query` 호출 때 덮어씁니다. 보관하려면 복사하세요.
     */
    query(x0, y0, x1 = x0, y1 = y0, pad = 0) {
        const OUT = this.out,
            ITEMS = this.items;
        OUT.length = 0;
        if (!ITEMS.length) {
            return OUT;
        }
        const MIN_X = Math.min(x0, x1) - pad,
            MAX_X = Math.max(x0, x1) + pad,
            MIN_Y = Math.min(y0, y1) - pad,
            MAX_Y = Math.max(y0, y1) + pad;
        // 항목이 없는 칸 범위 밖은 잘라 냅니다(빈 칸만 버리므로 결과는 같습니다).
        const BX0 = Math.max(0, Math.floor(MIN_X / this.cell) - this.#col0),
            BX1 = Math.min(this.#cols - 1, Math.floor(MAX_X / this.cell) - this.#col0),
            BY0 = Math.max(0, Math.floor(MIN_Y / this.cell) - this.#row0),
            BY1 = Math.min(this.#rows - 1, Math.floor(MAX_Y / this.cell) - this.#row0);
        if (!(BX0 <= BX1 && BY0 <= BY1)) {
            return OUT;
        }
        const START = this.#start,
            ENTRIES = this.#entries,
            FOUND = this.found,
            COLS = this.#cols;
        if (BX0 === BX1 && BY0 === BY1) {
            const END = START[BY0 * COLS + BX0 + 1];
            for (let k = START[BY0 * COLS + BX0]; k < END; k++) {
                const I = ENTRIES[k],
                    B = ITEMS[I];
                if (B.maxX >= MIN_X && B.minX <= MAX_X && B.maxY >= MIN_Y && B.minY <= MAX_Y) {
                    FOUND[OUT.length] = I;
                    OUT.push(B);
                }
            }
            return OUT;
        }
        // 여러 칸에 걸친 항목을 한 번만 담도록 조회마다 표식 세대를 올립니다.
        if (++this.epoch === 0xffffffff) {
            this.marks.fill(0);
            this.epoch = 1;
        }
        const MARKS = this.marks,
            EPOCH = this.epoch;
        for (let y = BY0; y <= BY1; y++) {
            const ROW = y * COLS;
            for (let x = BX0; x <= BX1; x++) {
                const END = START[ROW + x + 1];
                for (let k = START[ROW + x]; k < END; k++) {
                    const I = ENTRIES[k];
                    if (MARKS[I] === EPOCH) {
                        continue;
                    }
                    MARKS[I] = EPOCH;
                    const B = ITEMS[I];
                    if (B.maxX >= MIN_X && B.minX <= MAX_X && B.maxY >= MIN_Y && B.minY <= MAX_Y) {
                        FOUND[OUT.length] = I;
                        OUT.push(B);
                    }
                }
            }
        }
        return OUT;
    }
}
