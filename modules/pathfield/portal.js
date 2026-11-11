// 청크 + 포털 계층 길찾기의 구조 부분입니다. 격자를 정사각 청크로 나누고, 청크 안 연결 성분·청크 경계의 포털 노드·
// 청크 안 노드 사이 걸음 비용·전역 연결 성분을 둡니다. 장애물이 바뀌면 격자가 기록한 바뀐 사각형과 겹치는 청크만 다시 만듭니다.
// 모든 판정은 `grid.stepCell` 하나로 하므로 칸 통과·변 통과·모서리 가로지르기 금지 규칙이 거리장·A*와 같습니다.
// 시간·난수·DOM·Map·문자열 키가 없고, 번호와 순서는 격자 상태만의 함수입니다(어떤 순서로 바뀌어 왔는지와 무관).
import { DIRECTION_COUNT, DIRECTION_DX, DIRECTION_DY, MAX_CHANGED_RECTS, PathGrid } from './grid.js';

const OPTIONS = ['chunkSize', 'portalSpan', 'goalCapacity'];
// 청크 안 최장 걸음 비용은 64² 칸 · 14 = 57344로 Uint16(0xFFFF는 "다른 성분")에 들어갑니다.
const MAX_CHUNK_SIZE = 64;
const NO_COMP = 0xffff;
const NO_EDGE = 0xffff;
// 칸 방향 비트의 9번째 비트: 열린 칸(갈 방향이 없어도 성분 하나).
const OPEN_BIT = 0x100;
// 지역 힙 키 = 비용 · 2^12 + 청크 안 칸(청크 안 칸 < 64² = 2^12, 비용 ≤ 57344라 키 < 2^28, Int32).
const LOCAL_BITS = 12;
const LOCAL_MASK = (1 << LOCAL_BITS) - 1;
const EAST = 0;
const SOUTH = 1;
const SOUTH_EAST = 4;
const SOUTH_WEST = 5;
const NORTH_EAST = 7;
const STRAIGHT = 10;
const DIAGONAL = 14;
// 청크가 소유하는 경계: 동쪽 변, 남쪽 변, 남동 모서리, 남서 모서리. 나머지 넷(서·북·북서·북동)은 이웃 청크가 소유합니다.
const BORDER_EAST = 0;
const BORDER_SOUTH = 1;
const BORDER_SOUTH_EAST = 2;
const BORDER_SOUTH_WEST = 3;
const BORDER_KINDS = 4;

function integerOption(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`PortalGraph ${name} must be an integer in [${min}, ${max}].`);
    }
    return value;
}

/**
 * 격자 위의 청크 + 포털 그래프입니다. 청크는 `chunkSize`칸 정사각형(가장자리 청크는 잘림)이고, 이웃 청크 사이에 `stepCell`이
 * 통과되는 걸음을 포털로 묶습니다. 노드 번호는 `(청크 · 청크당 포털 자리 + 경계 시작 + 순번) · 2 + 쪽`이라 바뀌지 않은 경계의
 * 노드 번호는 다른 곳이 바뀌어도 그대로이고, 짝 노드는 `node ^ 1`입니다.
 */
export class PortalGraph {
    /** @type {PathGrid} */
    grid;
    /** 청크 한 변의 칸 수(기본 16). */
    chunkSize;
    /** 포털 구간을 쪼개는 칸 수(기본 4). 조각마다 중앙 칸 하나가 노드입니다. */
    portalSpan;
    /** 목표 보관소의 용량(기본 64). 목표 보관은 다음 단계에서 이 값을 씁니다. */
    goalCapacity;
    /** 청크의 열·행·총 수. 청크 번호는 행 우선 `chunkRow * chunkCols + chunkCol`입니다. */
    chunkCols;
    chunkRows;
    chunkCount;
    /** 노드 번호의 상한(노드 번호는 0 이상 이 값 미만). 대부분은 비어 있는 자리입니다. */
    nodeCapacity;
    /** 구조를 다시 만든 횟수. 처음 만들 때와, 바뀐 사각형을 소비해 청크를 다시 만들 때마다 오릅니다. */
    revision = 0;
    /** 누적 횟수: 성분·포털을 다시 만든 청크, 노드만 다시 모은 청크, 만든 노드 간 비용 행렬. */
    stats = { chunksRebuilt: 0, nodeChunksRebuilt: 0, matricesBuilt: 0 };

    #built = false;
    #componentCount = 0;
    #cellsPerChunk;
    // 칸마다 청크 안 성분 번호(0..), 막힌 칸은 NO_COMP.
    #cellComp;
    // 칸마다 청크 안 걸음 방향 비트 + OPEN_BIT(막힌 칸은 0).
    #stepMask;
    #compCount;
    // 성분 열쇠 = 청크 · chunkSize² + 청크 안 성분(< 청크 수 · S² ≤ (cols + S − 1)(rows + S − 1) < 2^31, Int32). 합치기용 부모와 전역 번호.
    #compParent;
    #compLabel;
    #borderCap;
    #portalStride;
    #borderPortals;
    // 노드 n의 칸(n = 포털 · 2 + 쪽, 쪽 0은 경계를 소유한 청크), 포털의 건너는 비용(10|14).
    #nodeCell;
    #portalCost;
    // 노드가 속한 청크와 그 청크 노드 목록에서의 순번.
    #nodeChunk;
    #nodeIndex;
    #chunkNodeCap;
    #chunkNodes;
    #chunkNodeCount;
    // 청크 노드 목록의 칸(행렬을 다시 만들어야 하는지 비교용)과 수집 중 달라졌는지.
    #chunkNodeCells;
    #listChanged = false;
    // 청크마다 노드 × 노드 걸음 비용(Uint16, NO_EDGE는 다른 성분). 크기가 맞으면 재사용하고 처음 물을 때 만듭니다.
    #matrix;
    #matrixReady;
    // 마지막으로 구조를 바꾼 동기화에서 청크의 처리: 0 그대로, 1 노드만, 2 성분·포털을 다시 만듦.
    #change;
    #rects = new Int32Array(MAX_CHANGED_RECTS * 4);
    #stack;
    #localDist;
    #localCells;
    #targets;
    #heap;
    #pairs;

    /**
     * @param {PathGrid} grid
     * @param {{ chunkSize?: number, portalSpan?: number, goalCapacity?: number }} [options]
     */
    constructor(grid, options = {}) {
        if (!(grid instanceof PathGrid)) {
            throw new TypeError('PortalGraph needs a PathGrid.');
        }
        if (options === null || typeof options !== 'object') {
            throw new TypeError('PortalGraph options must be an object.');
        }
        for (const KEY of Object.keys(options)) {
            if (!OPTIONS.includes(KEY)) {
                throw new TypeError(`PortalGraph has an unknown option: ${KEY}`);
            }
        }
        this.grid = grid;
        this.chunkSize = integerOption(options.chunkSize ?? 16, 'chunkSize', 2, MAX_CHUNK_SIZE);
        this.portalSpan = integerOption(options.portalSpan ?? 4, 'portalSpan', 1, this.chunkSize);
        this.goalCapacity = integerOption(options.goalCapacity ?? 64, 'goalCapacity', 1, 0xffff);
        const SIZE = this.chunkSize;
        this.chunkCols = Math.ceil(grid.cols / SIZE);
        this.chunkRows = Math.ceil(grid.rows / SIZE);
        this.chunkCount = this.chunkCols * this.chunkRows;
        this.#cellsPerChunk = SIZE * SIZE;
        // 변 하나의 포털: 직선 조각은 변의 칸 수 이하, 대각만 열린 단칸 포털은 변 안 대각 걸음 수(2·(S-1)) 이하.
        this.#borderCap = 3 * SIZE - 2;
        this.#portalStride = 2 * this.#borderCap + 2;
        this.nodeCapacity = this.chunkCount * this.#portalStride * 2;
        this.#chunkNodeCap = 4 * this.#borderCap + 4;
        this.#cellComp = new Uint16Array(grid.size).fill(NO_COMP);
        this.#stepMask = new Uint16Array(grid.size);
        this.#compCount = new Uint16Array(this.chunkCount);
        this.#compParent = new Int32Array(this.chunkCount * this.#cellsPerChunk);
        this.#compLabel = new Int32Array(this.chunkCount * this.#cellsPerChunk);
        this.#borderPortals = new Uint16Array(this.chunkCount * BORDER_KINDS);
        this.#nodeCell = new Int32Array(this.nodeCapacity).fill(-1);
        this.#portalCost = new Uint8Array(this.nodeCapacity / 2);
        this.#nodeChunk = new Int32Array(this.nodeCapacity).fill(-1);
        this.#nodeIndex = new Uint16Array(this.nodeCapacity);
        this.#chunkNodes = new Int32Array(this.chunkCount * this.#chunkNodeCap);
        this.#chunkNodeCount = new Uint16Array(this.chunkCount);
        this.#chunkNodeCells = new Int32Array(this.chunkCount * this.#chunkNodeCap).fill(-1);
        this.#matrix = new Array(this.chunkCount).fill(null);
        this.#matrixReady = new Uint8Array(this.chunkCount);
        this.#change = new Uint8Array(this.chunkCount);
        this.#stack = new Int32Array(this.#cellsPerChunk);
        this.#localDist = new Int32Array(this.#cellsPerChunk);
        this.#localCells = new Int32Array(this.#cellsPerChunk);
        this.#targets = new Uint16Array(this.#cellsPerChunk);
        // 지역 힙: 칸마다 이웃 8개가 한 번씩 넣을 수 있습니다.
        this.#heap = new Int32Array(this.#cellsPerChunk * DIRECTION_COUNT + 1);
        this.#pairs = new Int32Array(this.#borderCap);
    }

    /**
     * 구조를 최신으로 만듭니다. 처음이면 모든 청크를 만들고, 아니면 격자의 `takeChangedRects`를 소비해 바뀐 사각형(변 기억이
     * 비워진 바깥 한 겹 포함)과 겹치는 청크만 다시 만듭니다. 무언가 다시 만들었으면 true. 질의도 필요하면 스스로 부릅니다.
     * 격자의 바뀐 사각형 기록을 가져가는 소비자는 이 그래프 하나여야 합니다.
     */
    prepare() {
        if (!this.#built) {
            this.grid.takeChangedRects(this.#rects);
            this.#buildAll();
            this.#built = true;
            return true;
        }
        if (this.grid.changedRectCount === 0) {
            return false;
        }
        this.#rebuildChanged(this.grid.takeChangedRects(this.#rects));
        return true;
    }

    /** 전역 연결 성분의 수. 성분 번호는 0 이상 이 값 미만입니다. */
    get componentCount() {
        this.prepare();
        return this.#componentCount;
    }

    /** 칸의 전역 연결 성분 번호. 막힌 칸·격자 밖 번호는 -1. 두 칸의 번호가 같으면 걸어서 닿고, 다르면 닿지 않습니다. */
    component(cell) {
        this.prepare();
        if (!(cell >= 0 && cell < this.grid.size)) {
            return -1;
        }
        const COMP = this.#cellComp[cell];
        return COMP === NO_COMP ? -1 : this.#compLabel[this.chunkOf(cell) * this.#cellsPerChunk + COMP];
    }

    /** 칸이 든 청크 번호. */
    chunkOf(cell) {
        const COLS = this.grid.cols,
            COL = cell % COLS,
            ROW = (cell - COL) / COLS;
        return Math.floor(ROW / this.chunkSize) * this.chunkCols + Math.floor(COL / this.chunkSize);
    }

    /** 청크의 노드 수. 노드 목록 순서는 동·남·서·북 변, 남동·남서·북서·북동 모서리, 각 경계 안에서는 놓인 순서입니다. */
    chunkNodeCount(chunk) {
        this.prepare();
        return this.#chunkNodeCount[chunk];
    }

    /** 청크 노드 목록의 `index`번째 노드 번호. */
    chunkNode(chunk, index) {
        this.prepare();
        if (!(index >= 0 && index < this.#chunkNodeCount[chunk])) {
            throw new RangeError('PortalGraph.chunkNode index is out of range.');
        }
        return this.#chunkNodes[chunk * this.#chunkNodeCap + index];
    }

    /** 노드가 선 칸. 비어 있는 자리는 -1. */
    nodeCell(node) {
        this.prepare();
        return this.#nodeChunk[node] < 0 ? -1 : this.#nodeCell[node];
    }

    /** 노드가 속한 청크. 비어 있는 자리는 -1. */
    nodeChunk(node) {
        this.prepare();
        return this.#nodeChunk[node];
    }

    /** 경계 건너편의 짝 노드(`node ^ 1`). */
    nodePeer(node) {
        return node ^ 1;
    }

    /** 노드에서 짝 노드로 건너는 비용(직선 10, 대각 14). */
    nodeCrossCost(node) {
        this.prepare();
        return this.#portalCost[node >> 1];
    }

    /**
     * 청크 안에서만 걸어 노드 목록의 `from`번째 노드 칸에서 `to`번째 노드 칸까지 가는 최단 비용. 청크 안에서 이어지지 않으면 -1.
     * 그 청크의 비용 행렬을 처음 물을 때 만듭니다(청크의 노드 수 n이면 청크 안 Dijkstra n-1번).
     */
    edgeCost(chunk, from, to) {
        this.prepare();
        const COUNT = this.#chunkNodeCount[chunk];
        if (!(from >= 0 && from < COUNT && to >= 0 && to < COUNT)) {
            throw new RangeError('PortalGraph.edgeCost index is out of range.');
        }
        if (!this.#matrixReady[chunk]) {
            this.#buildMatrix(chunk);
        }
        const COST = this.#matrix[chunk][from * COUNT + to];
        return COST === NO_EDGE ? -1 : COST;
    }

    /** 구조를 마지막으로 바꾼 동기화에서 청크를 어떻게 했는지: 0 그대로, 1 노드만 다시 모음, 2 성분·포털을 다시 만듦. */
    chunkChange(chunk) {
        return this.#change[chunk];
    }

    #buildAll() {
        this.#change.fill(2);
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            this.#buildComponents(chunk);
        }
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            for (let kind = 0; kind < BORDER_KINDS; kind++) {
                this.#scanBorder(chunk, kind);
            }
        }
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            this.#collectNodes(chunk);
        }
        this.stats.chunksRebuilt += this.chunkCount;
        this.#relabel();
        this.revision++;
    }

    #rebuildChanged(count) {
        const SIZE = this.chunkSize,
            GRID = this.grid,
            CHANGE = this.#change,
            RECTS = this.#rects;
        CHANGE.fill(0);
        for (let i = 0; i < count * 4; i += 4) {
            // 격자는 바깥 한 겹의 변 기억도 비웠지만 기록에는 넣지 않으므로 한 칸 넓혀 읽습니다.
            const COL0 = Math.max(0, RECTS[i] - 1),
                ROW0 = Math.max(0, RECTS[i + 1] - 1),
                COL1 = Math.min(GRID.cols - 1, RECTS[i + 2] + 1),
                ROW1 = Math.min(GRID.rows - 1, RECTS[i + 3] + 1);
            for (let chunkRow = Math.floor(ROW0 / SIZE); chunkRow <= Math.floor(ROW1 / SIZE); chunkRow++) {
                for (let chunkCol = Math.floor(COL0 / SIZE); chunkCol <= Math.floor(COL1 / SIZE); chunkCol++) {
                    CHANGE[chunkRow * this.chunkCols + chunkCol] = 2;
                }
            }
        }
        let rebuilt = 0;
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            if (CHANGE[chunk] === 2) {
                this.#buildComponents(chunk);
                rebuilt++;
            }
        }
        // 경계의 포털은 그 경계에 걸음이 닿는 청크(변은 두 청크, 모서리는 2×2 네 청크)의 칸·성분에만 의존합니다.
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            for (let kind = 0; kind < BORDER_KINDS; kind++) {
                if (this.#borderTouchesRebuilt(chunk, kind)) {
                    this.#scanBorder(chunk, kind);
                    CHANGE[chunk] ||= 1;
                    CHANGE[this.#borderNeighbor(chunk, kind)] ||= 1;
                }
            }
        }
        let collected = 0;
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            if (CHANGE[chunk] !== 0) {
                this.#collectNodes(chunk);
                collected++;
            }
        }
        this.stats.chunksRebuilt += rebuilt;
        this.stats.nodeChunksRebuilt += collected - rebuilt;
        this.#relabel();
        this.revision++;
    }

    // 경계 건너편 청크. 경계가 없는 자리(격자 가장자리)는 -1.
    #borderNeighbor(chunk, kind) {
        const COL = chunk % this.chunkCols,
            ROW = (chunk - COL) / this.chunkCols,
            LAST_COL = COL === this.chunkCols - 1,
            LAST_ROW = ROW === this.chunkRows - 1;
        if (kind === BORDER_EAST) {
            return LAST_COL ? -1 : chunk + 1;
        }
        if (kind === BORDER_SOUTH) {
            return LAST_ROW ? -1 : chunk + this.chunkCols;
        }
        if (kind === BORDER_SOUTH_EAST) {
            return LAST_COL || LAST_ROW ? -1 : chunk + this.chunkCols + 1;
        }
        return COL === 0 || LAST_ROW ? -1 : chunk + this.chunkCols - 1;
    }

    #borderTouchesRebuilt(chunk, kind) {
        const NEXT = this.#borderNeighbor(chunk, kind),
            CHANGE = this.#change;
        if (NEXT < 0) {
            return false;
        }
        if (CHANGE[chunk] === 2 || CHANGE[NEXT] === 2) {
            return true;
        }
        if (kind === BORDER_SOUTH_EAST) {
            return CHANGE[chunk + 1] === 2 || CHANGE[chunk + this.chunkCols] === 2;
        }
        if (kind === BORDER_SOUTH_WEST) {
            return CHANGE[chunk - 1] === 2 || CHANGE[chunk + this.chunkCols] === 2;
        }
        return false;
    }

    // 청크 안 연결 성분: 행 우선으로 훑어 처음 만난 열린 칸부터 청크 안으로만 퍼뜨리며 0부터 번호를 붙입니다.
    #buildComponents(chunk) {
        const GRID = this.grid,
            COLS = GRID.cols,
            SIZE = this.chunkSize,
            COMP = this.#cellComp,
            MASK = this.#stepMask,
            STACK = this.#stack,
            CHUNK_COL = chunk % this.chunkCols,
            COL0 = CHUNK_COL * SIZE,
            ROW0 = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE,
            COL1 = Math.min(COLS, COL0 + SIZE) - 1,
            ROW1 = Math.min(GRID.rows, ROW0 + SIZE) - 1;
        for (let row = ROW0; row <= ROW1; row++) {
            COMP.fill(NO_COMP, row * COLS + COL0, row * COLS + COL1 + 1);
        }
        // 칸마다 청크 안으로 갈 수 있는 방향의 비트(bit d = 방향 d). 성분 채우기와 청크 안 Dijkstra가 stepCell 대신 읽습니다.
        for (let row = ROW0; row <= ROW1; row++) {
            for (let col = COL0; col <= COL1; col++) {
                const CELL = row * COLS + col;
                let mask = 0;
                if (GRID.isOpen(CELL)) {
                    for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                        const NEXT_COL = col + DIRECTION_DX[direction],
                            NEXT_ROW = row + DIRECTION_DY[direction];
                        if (
                            NEXT_COL >= COL0 &&
                            NEXT_COL <= COL1 &&
                            NEXT_ROW >= ROW0 &&
                            NEXT_ROW <= ROW1 &&
                            GRID.stepCell(col, row, direction) >= 0
                        ) {
                            mask |= 1 << direction;
                        }
                    }
                    MASK[CELL] = mask | OPEN_BIT;
                } else {
                    MASK[CELL] = 0;
                }
            }
        }
        let count = 0;
        for (let row = ROW0; row <= ROW1; row++) {
            for (let col = COL0; col <= COL1; col++) {
                const START = row * COLS + col;
                if (COMP[START] !== NO_COMP || MASK[START] === 0) {
                    continue;
                }
                const ID = count++;
                COMP[START] = ID;
                let top = 0;
                STACK[top++] = START;
                while (top) {
                    const CELL = STACK[--top],
                        BITS = MASK[CELL];
                    for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                        if (!(BITS & (1 << direction))) {
                            continue;
                        }
                        const NEXT = CELL + DIRECTION_DX[direction] + DIRECTION_DY[direction] * COLS;
                        if (COMP[NEXT] === NO_COMP) {
                            COMP[NEXT] = ID;
                            STACK[top++] = NEXT;
                        }
                    }
                }
            }
        }
        this.#compCount[chunk] = count;
    }

    #compKey(cell) {
        return this.chunkOf(cell) * this.#cellsPerChunk + this.#cellComp[cell];
    }

    #addPortal(chunk, kind, cellA, cellB, cost) {
        const PORTAL = this.#portalBase(chunk, kind) + this.#borderPortals[chunk * BORDER_KINDS + kind]++;
        this.#nodeCell[PORTAL * 2] = cellA;
        this.#nodeCell[PORTAL * 2 + 1] = cellB;
        this.#portalCost[PORTAL] = cost;
    }

    #portalBase(chunk, kind) {
        const OFFSET =
            kind === BORDER_EAST ? 0 : kind === BORDER_SOUTH ? this.#borderCap : this.#borderCap * 2 + kind - 2;
        return chunk * this.#portalStride + OFFSET;
    }

    /**
     * 청크가 소유한 경계 하나의 포털을 다시 놓습니다. 변: 직선 걸음이 통과되고 양쪽 성분이 같은 연속 구간을 `portalSpan`칸씩
     * 쪼개 조각마다 중앙 칸(짝수 길이는 앞쪽)을 노드로 둡니다. 그 뒤 변을 따라 대각 걸음을 보며, 직선 포털로 아직 이어지지 않은
     * (성분, 성분) 쌍만 첫 대각 걸음 하나를 단칸 포털(비용 14)로 둡니다. 모서리: 대각 걸음 하나가 통과되면 포털 하나.
     */
    #scanBorder(chunk, kind) {
        const GRID = this.grid,
            COLS = GRID.cols,
            SIZE = this.chunkSize,
            COMP = this.#cellComp,
            CHUNK_COL = chunk % this.chunkCols,
            COL0 = CHUNK_COL * SIZE,
            ROW0 = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE,
            COL1 = Math.min(COLS, COL0 + SIZE) - 1,
            ROW1 = Math.min(GRID.rows, ROW0 + SIZE) - 1;
        this.#borderPortals[chunk * BORDER_KINDS + kind] = 0;
        if (this.#borderNeighbor(chunk, kind) < 0) {
            return;
        }
        if (kind === BORDER_SOUTH_EAST || kind === BORDER_SOUTH_WEST) {
            // stepCell은 출발 칸이 열렸는지 보지 않으므로 이쪽 칸이 성분에 든 경우만 봅니다.
            const COL = kind === BORDER_SOUTH_EAST ? COL1 : COL0;
            if (COMP[ROW1 * COLS + COL] === NO_COMP) {
                return;
            }
            const NEXT = GRID.stepCell(COL, ROW1, kind === BORDER_SOUTH_EAST ? SOUTH_EAST : SOUTH_WEST);
            if (NEXT >= 0) {
                this.#addPortal(chunk, kind, ROW1 * COLS + COL, NEXT, DIAGONAL);
            }
            return;
        }
        // 변을 따라가는 위치 t(동쪽 변은 행, 남쪽 변은 열)와 그 자리의 이쪽 칸.
        const EAST_SIDE = kind === BORDER_EAST,
            FIRST = EAST_SIDE ? ROW0 : COL0,
            LAST = EAST_SIDE ? ROW1 : COL1,
            SPAN = this.portalSpan,
            STEP = EAST_SIDE ? 1 : COLS,
            PAIRS = this.#pairs;
        let pairCount = 0,
            runStart = -1,
            runA = -1,
            runB = -1;
        for (let t = FIRST; t <= LAST + 1; t++) {
            let compA = -1,
                compB = -1;
            const CELL = EAST_SIDE ? t * COLS + COL1 : ROW1 * COLS + t;
            if (t <= LAST && COMP[CELL] !== NO_COMP) {
                const NEXT = EAST_SIDE ? GRID.stepCell(COL1, t, EAST) : GRID.stepCell(t, ROW1, SOUTH);
                if (NEXT >= 0) {
                    compA = COMP[CELL];
                    compB = COMP[NEXT];
                }
            }
            if (runStart >= 0 && (compA !== runA || compB !== runB)) {
                for (let piece = runStart; piece < t; piece += SPAN) {
                    const MIDDLE = piece + ((Math.min(SPAN, t - piece) - 1) >> 1),
                        CENTER = EAST_SIDE ? MIDDLE * COLS + COL1 : ROW1 * COLS + MIDDLE;
                    this.#addPortal(chunk, kind, CENTER, CENTER + STEP, STRAIGHT);
                }
                PAIRS[pairCount++] = runA * this.#cellsPerChunk + runB;
                runStart = -1;
            }
            if (compA >= 0 && runStart < 0) {
                runStart = t;
                runA = compA;
                runB = compB;
            }
        }
        // 대각 걸음: 동쪽 변은 남동(다음 행)·북동(앞 행), 남쪽 변은 남동(다음 열)·남서(앞 열). 변 범위 안의 걸음만 봅니다.
        for (let t = FIRST; t <= LAST; t++) {
            const CELL = EAST_SIDE ? t * COLS + COL1 : ROW1 * COLS + t,
                CELL_COL = CELL % COLS,
                CELL_ROW = (CELL - CELL_COL) / COLS;
            if (COMP[CELL] === NO_COMP) {
                continue;
            }
            for (let side = 0; side < 2; side++) {
                if ((side === 0 && t === LAST) || (side === 1 && t === FIRST)) {
                    continue;
                }
                const DIRECTION = side === 0 ? SOUTH_EAST : EAST_SIDE ? NORTH_EAST : SOUTH_WEST,
                    NEXT = GRID.stepCell(CELL_COL, CELL_ROW, DIRECTION);
                if (NEXT < 0) {
                    continue;
                }
                const PAIR = COMP[CELL] * this.#cellsPerChunk + COMP[NEXT];
                let linked = false;
                for (let i = 0; i < pairCount; i++) {
                    if (PAIRS[i] === PAIR) {
                        linked = true;
                        break;
                    }
                }
                if (!linked) {
                    PAIRS[pairCount++] = PAIR;
                    this.#addPortal(chunk, kind, CELL, NEXT, DIAGONAL);
                }
            }
        }
    }

    // 청크의 노드 목록을 동·남·서·북 변, 남동·남서·북서·북동 모서리 순서로 모읍니다.
    #collectNodes(chunk) {
        const COL = chunk % this.chunkCols,
            ROW = (chunk - COL) / this.chunkCols,
            CC = this.chunkCols;
        this.#listChanged = false;
        let count = 0;
        count = this.#take(chunk, count, chunk, BORDER_EAST, 0);
        count = this.#take(chunk, count, chunk, BORDER_SOUTH, 0);
        if (COL > 0) {
            count = this.#take(chunk, count, chunk - 1, BORDER_EAST, 1);
        }
        if (ROW > 0) {
            count = this.#take(chunk, count, chunk - CC, BORDER_SOUTH, 1);
        }
        count = this.#take(chunk, count, chunk, BORDER_SOUTH_EAST, 0);
        count = this.#take(chunk, count, chunk, BORDER_SOUTH_WEST, 0);
        if (COL > 0 && ROW > 0) {
            count = this.#take(chunk, count, chunk - CC - 1, BORDER_SOUTH_EAST, 1);
        }
        if (COL < CC - 1 && ROW > 0) {
            count = this.#take(chunk, count, chunk - CC + 1, BORDER_SOUTH_WEST, 1);
        }
        // 비워진 자리(포털 수가 줄어든 경계의 뒤쪽)는 다음 수집 전까지 어느 청크에도 속하지 않습니다.
        for (let kind = 0; kind < BORDER_KINDS; kind++) {
            const BASE = this.#portalBase(chunk, kind),
                END = BASE + (kind < BORDER_SOUTH_EAST ? this.#borderCap : 1);
            for (let portal = BASE + this.#borderPortals[chunk * BORDER_KINDS + kind]; portal < END; portal++) {
                this.#nodeChunk[portal * 2] = -1;
                this.#nodeChunk[portal * 2 + 1] = -1;
            }
        }
        // 성분을 다시 만들지 않은 청크는 칸·걸음이 그대로이므로 노드 칸 목록까지 같으면 비용 행렬도 같습니다.
        if (this.#listChanged || count !== this.#chunkNodeCount[chunk] || this.#change[chunk] === 2) {
            this.#matrixReady[chunk] = 0;
        }
        this.#chunkNodeCount[chunk] = count;
    }

    // 경계 하나의 한쪽 노드들을 청크 노드 목록 뒤에 붙이고 새 개수를 돌려줍니다.
    #take(chunk, count, owner, kind, side) {
        const BASE = this.#portalBase(owner, kind),
            PORTALS = this.#borderPortals[owner * BORDER_KINDS + kind];
        for (let i = 0; i < PORTALS; i++) {
            const NODE = (BASE + i) * 2 + side,
                AT = chunk * this.#chunkNodeCap + count;
            if (this.#chunkNodeCells[AT] !== this.#nodeCell[NODE]) {
                this.#chunkNodeCells[AT] = this.#nodeCell[NODE];
                this.#listChanged = true;
            }
            this.#chunkNodes[AT] = NODE;
            this.#nodeChunk[NODE] = chunk;
            this.#nodeIndex[NODE] = count++;
        }
        return count;
    }

    #find(key) {
        const PARENT = this.#compParent;
        while (PARENT[key] !== key) {
            PARENT[key] = PARENT[PARENT[key]];
            key = PARENT[key];
        }
        return key;
    }

    // 전역 성분: 포털로 이어진 청크 성분을 합치고(뿌리는 작은 열쇠), 열쇠 오름차순으로 처음 만난 뿌리부터 0, 1, 2…를 줍니다.
    #relabel() {
        const PARENT = this.#compParent,
            LABEL = this.#compLabel,
            PER = this.#cellsPerChunk;
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            for (let comp = 0; comp < this.#compCount[chunk]; comp++) {
                PARENT[chunk * PER + comp] = chunk * PER + comp;
            }
        }
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            for (let kind = 0; kind < BORDER_KINDS; kind++) {
                const BASE = this.#portalBase(chunk, kind),
                    PORTALS = this.#borderPortals[chunk * BORDER_KINDS + kind];
                for (let portal = BASE; portal < BASE + PORTALS; portal++) {
                    const ROOT_A = this.#find(this.#compKey(this.#nodeCell[portal * 2])),
                        ROOT_B = this.#find(this.#compKey(this.#nodeCell[portal * 2 + 1]));
                    if (ROOT_A < ROOT_B) {
                        PARENT[ROOT_B] = ROOT_A;
                    } else if (ROOT_B < ROOT_A) {
                        PARENT[ROOT_A] = ROOT_B;
                    }
                }
            }
        }
        let next = 0;
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            for (let comp = 0; comp < this.#compCount[chunk]; comp++) {
                const KEY = chunk * PER + comp,
                    ROOT = this.#find(KEY);
                LABEL[KEY] = ROOT === KEY ? next++ : LABEL[ROOT];
            }
        }
        this.#componentCount = next;
    }

    #localCell(cell, col0, row0) {
        const COL = cell % this.grid.cols;
        return ((cell - COL) / this.grid.cols - row0) * this.chunkSize + (COL - col0);
    }

    // 청크 안 노드 × 노드 비용: 노드마다 그 칸에서 청크 안으로만 Dijkstra(키 = 비용 · S² + 청크 안 칸)를 돌려 뒤 노드들의 칸 값을 읽습니다.
    #buildMatrix(chunk) {
        const GRID = this.grid,
            COLS = GRID.cols,
            SIZE = this.chunkSize,
            COUNT = this.#chunkNodeCount[chunk],
            NODES = this.#chunkNodes,
            NODE_CELL = this.#nodeCell,
            NODE_BASE = chunk * this.#chunkNodeCap,
            COMP = this.#cellComp,
            MASK = this.#stepMask,
            DIST = this.#localDist,
            CELL_OF = this.#localCells,
            TARGET = this.#targets,
            HEAP = this.#heap,
            CHUNK_COL = chunk % this.chunkCols,
            COL0 = CHUNK_COL * SIZE,
            ROW0 = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE,
            WIDTH = Math.min(COLS, COL0 + SIZE) - COL0,
            HEIGHT = Math.min(GRID.rows, ROW0 + SIZE) - ROW0;
        let matrix = this.#matrix[chunk];
        if (matrix === null || matrix.length < COUNT * COUNT) {
            matrix = this.#matrix[chunk] = new Uint16Array(Math.max(COUNT * COUNT, 1));
        }
        // 청크 안 칸 번호(행 · chunkSize + 열) → 격자 칸 번호.
        for (let row = 0; row < HEIGHT; row++) {
            for (let col = 0; col < WIDTH; col++) {
                CELL_OF[row * SIZE + col] = (ROW0 + row) * COLS + COL0 + col;
            }
        }
        for (let from = 0; from < COUNT; from++) {
            matrix[from * COUNT + from] = 0;
            const FROM_CELL = NODE_CELL[NODES[NODE_BASE + from]],
                FROM_COMP = COMP[FROM_CELL];
            // 같은 성분의 뒤 노드 칸이 모두 확정되면 멈춥니다. 다른 성분의 칸은 닿지 않으므로 -1로 남습니다.
            let remaining = 0;
            for (let to = from + 1; to < COUNT; to++) {
                const CELL = NODE_CELL[NODES[NODE_BASE + to]];
                if (COMP[CELL] === FROM_COMP) {
                    TARGET[this.#localCell(CELL, COL0, ROW0)]++;
                    remaining++;
                }
            }
            DIST.fill(-1);
            const START = this.#localCell(FROM_CELL, COL0, ROW0);
            let size = 0;
            DIST[START] = 0;
            HEAP[size++] = START;
            while (size && remaining) {
                const TOP = HEAP[0],
                    LAST = HEAP[--size];
                if (size) {
                    let at = 0;
                    for (;;) {
                        const LEFT = at * 2 + 1;
                        if (LEFT >= size) {
                            break;
                        }
                        const CHILD = LEFT + 1 < size && HEAP[LEFT + 1] < HEAP[LEFT] ? LEFT + 1 : LEFT;
                        if (HEAP[CHILD] >= LAST) {
                            break;
                        }
                        HEAP[at] = HEAP[CHILD];
                        at = CHILD;
                    }
                    HEAP[at] = LAST;
                }
                const AT = TOP & LOCAL_MASK,
                    COST = TOP >>> LOCAL_BITS;
                if (COST !== DIST[AT]) {
                    continue;
                }
                if (TARGET[AT]) {
                    remaining -= TARGET[AT];
                    TARGET[AT] = 0;
                }
                const BITS = MASK[CELL_OF[AT]];
                for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                    if (!(BITS & (1 << direction))) {
                        continue;
                    }
                    const NEXT_AT = AT + DIRECTION_DX[direction] + DIRECTION_DY[direction] * SIZE,
                        NEXT_COST = COST + (direction < 4 ? STRAIGHT : DIAGONAL);
                    if (DIST[NEXT_AT] >= 0 && DIST[NEXT_AT] <= NEXT_COST) {
                        continue;
                    }
                    DIST[NEXT_AT] = NEXT_COST;
                    let at = size++;
                    const KEY = (NEXT_COST << LOCAL_BITS) | NEXT_AT;
                    while (at > 0) {
                        const PARENT = (at - 1) >> 1;
                        if (HEAP[PARENT] <= KEY) {
                            break;
                        }
                        HEAP[at] = HEAP[PARENT];
                        at = PARENT;
                    }
                    HEAP[at] = KEY;
                }
            }
            for (let to = from + 1; to < COUNT; to++) {
                const CELL = NODE_CELL[NODES[NODE_BASE + to]],
                    D = COMP[CELL] === FROM_COMP ? DIST[this.#localCell(CELL, COL0, ROW0)] : -1,
                    VALUE = D < 0 ? NO_EDGE : D;
                matrix[from * COUNT + to] = VALUE;
                matrix[to * COUNT + from] = VALUE;
            }
        }
        this.#matrixReady[chunk] = 1;
        this.stats.matricesBuilt++;
    }
}
