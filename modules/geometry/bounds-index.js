// 경계 상자(minX·maxX·minY·maxY)를 가진 항목을 고정 칸 격자에 넣어 두고 범위로 후보를 찾는 AABB 버킷 색인입니다.
// 색인 구축은 한 번, 조회는 겹치는 칸의 항목만 봅니다. 항목을 옮기거나 지우는 API는 없으므로 바뀌면 새로 만듭니다.

export class BoundsIndex {
    /**
     * @param {Array<{minX: number, maxX: number, minY: number, maxY: number}>} items 경계를 가진 항목(보관만 하고 복사하지 않습니다)
     * @param {number} cell 칸 한 변의 길이
     */
    constructor(items, cell = 256) {
        this.items = items;
        this.cell = cell;
        this.bins = new Map();
        this.marks = new Uint32Array(items.length);
        this.epoch = 0;
        this.out = [];
        for (let i = 0; i < items.length; i++) {
            const B = items[i];
            for (let y = Math.floor(B.minY / cell); y <= Math.floor(B.maxY / cell); y++) {
                for (let x = Math.floor(B.minX / cell); x <= Math.floor(B.maxX / cell); x++) {
                    let row = this.bins.get(y);
                    if (!row) {
                        this.bins.set(y, (row = new Map()));
                    }
                    let bin = row.get(x);
                    if (!bin) {
                        row.set(x, (bin = []));
                    }
                    bin.push(i);
                }
            }
        }
    }

    /**
     * (x0, y0)-(x1, y1) 상자를 `pad`만큼 넓힌 범위와 경계가 겹치는 항목을 돌려줍니다.
     * 돌려주는 배열은 색인이 재사용하는 것이라 다음 `query` 호출 때 덮어씁니다. 보관하려면 복사하세요.
     */
    query(x0, y0, x1 = x0, y1 = y0, pad = 0) {
        this.out.length = 0;
        if (!this.items.length) {
            return this.out;
        }
        const MIN_X = Math.min(x0, x1) - pad,
            MAX_X = Math.max(x0, x1) + pad,
            MIN_Y = Math.min(y0, y1) - pad,
            MAX_Y = Math.max(y0, y1) + pad;
        const BX0 = Math.floor(MIN_X / this.cell),
            BX1 = Math.floor(MAX_X / this.cell),
            BY0 = Math.floor(MIN_Y / this.cell),
            BY1 = Math.floor(MAX_Y / this.cell);
        if (BX0 === BX1 && BY0 === BY1) {
            const BIN = this.bins.get(BY0)?.get(BX0);
            if (BIN) {
                for (const I of BIN) {
                    const B = this.items[I];
                    if (B.maxX >= MIN_X && B.minX <= MAX_X && B.maxY >= MIN_Y && B.minY <= MAX_Y) {
                        this.out.push(B);
                    }
                }
            }
            return this.out;
        }
        // 여러 칸에 걸친 항목을 한 번만 담도록 조회마다 표식 세대를 올립니다.
        if (++this.epoch === 0xffffffff) {
            this.marks.fill(0);
            this.epoch = 1;
        }
        for (let y = BY0; y <= BY1; y++) {
            const ROW = this.bins.get(y);
            if (!ROW) {
                continue;
            }
            for (let x = BX0; x <= BX1; x++) {
                const BIN = ROW.get(x);
                if (!BIN) {
                    continue;
                }
                for (const I of BIN) {
                    if (this.marks[I] === this.epoch) {
                        continue;
                    }
                    this.marks[I] = this.epoch;
                    const B = this.items[I];
                    if (B.maxX >= MIN_X && B.minX <= MAX_X && B.maxY >= MIN_Y && B.minY <= MAX_Y) {
                        this.out.push(B);
                    }
                }
            }
        }
        return this.out;
    }
}
