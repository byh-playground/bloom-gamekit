// 청크 + 포털 계층 길찾기의 구조 부분입니다. 격자를 정사각 청크로 나누고, 청크 안 연결 성분·청크 경계의 포털 노드·
// 청크 안 노드 사이 걸음 비용·전역 연결 성분을 둡니다. 장애물이 바뀌면 격자가 기록한 바뀐 사각형과 겹치는 청크만 다시 만듭니다.
// 모든 판정은 `grid.stepCell` 하나로 하므로 칸 통과·변 통과·모서리 가로지르기 금지 규칙이 A*와 같습니다.
// 시간·난수·DOM·Map·문자열 키가 없고, 번호와 순서는 격자 상태만의 함수입니다(어떤 순서로 바뀌어 왔는지와 무관).
// 그 위의 목표 보관소와 유동장(FlowField): 목표마다 포털 노드의 추상 거리 D를 게으르게 확정하고(질의한 청크의 노드가 확정되면
// 멈추는 A*, 다음 질의는 이어서), 질의가 온 청크만 청크 장 F0(노드 씨앗)·F1(이웃 F0 경계 값 이어받기)을 만듭니다.
// 모든 값은 (목표 칸 집합, 격자 상태)만의 함수라 계산 순서·캐시 폐기·질의 순서가 답을 바꾸지 않습니다.
import {
    DIRECTION_COST,
    DIRECTION_COUNT,
    DIRECTION_DX,
    DIRECTION_DY,
    MAX_CHANGED_RECTS,
    PathGrid,
    UNREACHED,
    stepCost,
} from './grid.js';

const OPTIONS = ['chunkSize', 'portalSpan', 'goalCapacity'];
const TWO_32 = 4294967296;
// 노드 상태(목표마다): 아직 안 닿음, 힙에 있음(임시 값), 확정.
const NODE_NEW = 0;
const NODE_OPEN = 1;
const NODE_SETTLED = 2;
const FLOW_TOKEN = Symbol('FlowField');
// PortalGraph의 private 메서드를 FlowField가 부르는 통로(모듈 안에서만 보임). 정적 블록에서 한 번 채웁니다.
let flowAccess = null;
// 청크 안 최장 걸음 비용(칸 수 · 가장 비싼 걸음)이 Uint16(0xFFFF는 "다른 성분") 아래여야 합니다. 칸 비용이 모두 1이면
// 64² 칸 · 14 = 57344로 들어가고, 더 비싼 칸이 있으면 생성자가 확인합니다.
const MAX_CHUNK_SIZE = 64;
const NO_COMP = 0xffff;
const NO_EDGE = 0xffff;
// 칸 방향 비트의 9번째 비트: 열린 칸(갈 방향이 없어도 성분 하나).
const OPEN_BIT = 0x100;
// 지역 힙 키 = 비용 · 2^12 + 청크 안 칸(청크 안 칸 < 64² = 2^12, 비용 < 2^16이라 키 < 2^28, Int32).
const LOCAL_BITS = 12;
const LOCAL_MASK = (1 << LOCAL_BITS) - 1;
const EAST = 0;
const SOUTH = 1;
const SOUTH_EAST = 4;
const SOUTH_WEST = 5;
const NORTH_EAST = 7;
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
    /** 목표 보관소의 용량(기본 64). 넘으면 가장 오래 안 쓴(`goal`·`setGoal`로 마지막으로 꺼낸 때가 가장 이른) 목표를 버립니다. */
    goalCapacity;
    /** 청크의 열·행·총 수. 청크 번호는 행 우선 `chunkRow * chunkCols + chunkCol`입니다. */
    chunkCols;
    chunkRows;
    chunkCount;
    /** 노드 번호의 상한(노드 번호는 0 이상 이 값 미만). 대부분은 비어 있는 자리입니다. */
    nodeCapacity;
    /** 구조를 다시 만든 횟수. 처음 만들 때와, 바뀐 사각형을 소비해 청크를 다시 만들 때마다 오릅니다. */
    revision = 0;
    /**
     * 누적 횟수: 성분·포털을 다시 만든 청크, 노드만 다시 모은 청크, 만든 노드 간 비용 행렬, `setGoal`로 넣은 목표,
     * 만든 청크 장(F0·F1 각각 하나), 목표별 추상 거리를 확정한 노드.
     */
    stats = {
        chunksRebuilt: 0,
        nodeChunksRebuilt: 0,
        matricesBuilt: 0,
        goalsBuilt: 0,
        fieldsBuilt: 0,
        nodesSettled: 0,
    };

    #built = false;
    #componentCount = 0;
    #cellsPerChunk;
    // 칸마다 청크 안 성분 번호(0..), 막힌 칸은 NO_COMP.
    #cellComp;
    // 칸마다 청크 안 걸음 방향 비트 + OPEN_BIT(막힌 칸은 0).
    #stepMask;
    // 청크 안 칸마다 비용(격자의 costOf, 막힌 칸은 0), 자리 = 청크 · S² + 청크 안 칸. 성분을 만들 때 옮겨 적어 청크 안
    // Dijkstra·비용 행렬이 청크 안 칸 번호로 바로 읽습니다.
    #chunkCost;
    // 모든 칸 비용이 1(maxCellCost 1)이면 걸음 비용은 방향만의 함수(stepCost(d, 1, 1) = DIRECTION_COST[d])라 청크 안
    // Dijkstra가 칸 비용을 읽지 않습니다. 같은 값이고 읽기만 줄입니다.
    #uniform;
    #compCount;
    // 성분 열쇠 = 청크 · chunkSize² + 청크 안 성분(< 청크 수 · S² ≤ (cols + S − 1)(rows + S − 1) < 2^31, Int32). 합치기용 부모와 전역 번호.
    #compParent;
    #compLabel;
    #borderCap;
    #portalStride;
    #borderPortals;
    // 노드 n의 칸(n = 포털 · 2 + 쪽, 쪽 0은 경계를 소유한 청크), 포털의 건너는 비용(두 칸 사이 한 걸음의 stepCost).
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
    // 살아 있는 노드의 조밀 번호(노드 번호 순). 구조가 바뀔 때마다 다시 매기고, 목표별 배열은 이 번호로 씁니다.
    #denseCount = 0;
    #denseOf;
    #denseNode;
    #denseCol;
    #denseRow;
    #denseLabel;
    // 추상 힙 키 = (D + h) · nodeScale + 조밀 번호. nodeScale은 nodeCapacity 이상의 2의 거듭제곱(생성자가 2^53 아래를 확인).
    #nodeScale;
    // 목표 보관소: 슬롯마다 GoalSlot 하나와 그 FlowField 하나(재사용). (keyA, keyB) → 슬롯은 선형 탐사 해시.
    #slots = [];
    #goalCount = 0;
    #clock = 0;
    #table;
    #tableMask;
    // 청크 장 블록(청크 칸 수 Int32Array) 풀. 목표가 버려지면 블록 번호가 빈 목록으로 돌아갑니다.
    #blocks = [];
    #freeBlocks = [];
    #fieldHeap;
    #fieldPos;
    #seeds;
    // 청크 안 칸 → 청크 왼쪽 위 칸 기준 격자 칸 차이, 방향마다 청크 안 칸 번호 차이.
    #localOffset;
    #localStep;
    #scratchDist;
    #chunkCursor;

    static {
        flowAccess = {
            check: (graph, slot) => graph.#check(slot),
            distance: (graph, slot, cell) => graph.#distance(slot, cell),
            lowest: (graph, slot, cell) => graph.#lowestNeighbor(slot, cell),
            stage: (graph, slot, chunk) => graph.#chunkStage(slot, chunk),
            node: (graph, slot, node, want) => graph.#nodeOf(slot, node, want),
        };
    }

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
        this.#chunkCost = new Uint8Array(this.chunkCount * this.#cellsPerChunk);
        this.#uniform = grid.maxCellCost === 1;
        this.#compCount = new Uint16Array(this.chunkCount);
        this.#compParent = new Int32Array(this.chunkCount * this.#cellsPerChunk);
        this.#compLabel = new Int32Array(this.chunkCount * this.#cellsPerChunk);
        this.#borderPortals = new Uint16Array(this.chunkCount * BORDER_KINDS);
        this.#nodeCell = new Int32Array(this.nodeCapacity).fill(-1);
        this.#portalCost = new Uint16Array(this.nodeCapacity / 2);
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
        // 값의 범위(M = 가장 비싼 걸음, 칸 비용이 모두 1이면 14): 청크 안 최단 경로는 S² · M 아래여야 비용 행렬(Uint16)에
        // 들어갑니다. 추상 최단 경로는 노드를 한 번씩만 지나고 청크 안 구간은 앞뒤 노드가 서로 달라, 청크를 지나는 횟수는
        // 노드 수의 절반(≤ K · (2B + 2)) 이하입니다. 구간 하나는 청크 안 최단 경로(≤ M · S²) + 건너기 M, 첫 구간(목표 칸 →
        // 노드)은 M · S² 이하라 D ≤ M · (S² + 1) · (K · (2B + 2) + 1). 청크 장 값은 D + 청크 안 두 구간 + M 이하,
        // 휴리스틱은 14 · (cols + rows) 이하입니다. 이 합이 Int32 안이고, 추상 힙 키 (D + h) · nodeScale + 번호가 2^53 아래여야 합니다.
        const MAX_STEP = stepCost(SOUTH_EAST, grid.maxCellCost, grid.maxCellCost);
        if (this.#cellsPerChunk * MAX_STEP >= NO_EDGE) {
            throw new RangeError(
                'PortalGraph chunk path costs would not fit 16 bits; use a smaller chunkSize or maxCellCost.',
            );
        }
        const D_LIMIT = MAX_STEP * (this.#cellsPerChunk + 1) * (this.chunkCount * this.#portalStride + 1),
            VALUE_LIMIT = D_LIMIT + MAX_STEP * (2 * this.#cellsPerChunk + 1) + 14 * (grid.cols + grid.rows);
        let scale = 1;
        while (scale < this.nodeCapacity) {
            scale *= 2;
        }
        this.#nodeScale = scale;
        if (VALUE_LIMIT >= 0x7fffffff || (VALUE_LIMIT + 1) * scale > Number.MAX_SAFE_INTEGER) {
            throw new RangeError('PortalGraph grid is too large for exact integer distances; use a larger cellSize.');
        }
        this.#denseOf = new Int32Array(this.nodeCapacity).fill(-1);
        this.#denseNode = new Int32Array(this.nodeCapacity);
        this.#denseCol = new Int32Array(this.nodeCapacity);
        this.#denseRow = new Int32Array(this.nodeCapacity);
        this.#denseLabel = new Int32Array(this.nodeCapacity);
        let tableSize = 1;
        while (tableSize < this.goalCapacity * 2) {
            tableSize *= 2;
        }
        this.#table = new Int32Array(tableSize);
        this.#tableMask = tableSize - 1;
        // 청크 장 힙(청크 안 칸의 위치 색인 힙)과 씨앗 목록: 칸마다 한 번씩만 들어갑니다.
        this.#fieldHeap = new Int32Array(this.#cellsPerChunk);
        this.#fieldPos = new Int32Array(this.#cellsPerChunk);
        this.#seeds = new Int32Array(this.#cellsPerChunk);
        this.#localOffset = new Int32Array(this.#cellsPerChunk);
        for (let local = 0; local < this.#cellsPerChunk; local++) {
            this.#localOffset[local] = Math.floor(local / SIZE) * grid.cols + (local % SIZE);
        }
        this.#localStep = new Int32Array(DIRECTION_COUNT);
        for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
            this.#localStep[direction] = DIRECTION_DX[direction] + DIRECTION_DY[direction] * SIZE;
        }
        this.#scratchDist = new Int32Array(this.#cellsPerChunk);
        this.#chunkCursor = new Int32Array(this.chunkCount + 1);
    }

    /**
     * 구조를 최신으로 만듭니다. 처음이면 모든 청크를 만들고, 아니면 격자의 `takeChangedRects`를 소비해 바뀐 사각형(변 기억이
     * 비워진 바깥 한 겹 포함)과 겹치는 청크만 다시 만듭니다. 무언가 다시 만들었으면 true. 질의도 필요하면 스스로 부릅니다.
     * 격자의 바뀐 사각형 기록을 가져가는 소비자는 이 그래프 하나여야 합니다. 다시 만들었으면 목표 보관소를 모두 비웁니다
     * (목표 칸 집합이 통과 판정에 의존하므로 남기면 답이 이력에 의존합니다).
     */
    prepare() {
        if (!this.#built) {
            this.grid.takeChangedRects(this.#rects);
            this.#buildAll();
            this.#built = true;
        } else if (this.grid.changedRectCount === 0) {
            return false;
        } else {
            this.#rebuildChanged(this.grid.takeChangedRects(this.#rects));
        }
        this.#renumber();
        this.#discardGoals();
        return true;
    }

    /** 보관 중인 목표의 수. */
    get goalCount() {
        return this.#goalCount;
    }

    /**
     * 키 (keyA, keyB)로 보관한 목표의 유동장, 없으면 null. 꺼내면 "최근에 씀"이 됩니다. 키는 안전 정수 두 개입니다(문자열 키 없음).
     * 돌려준 FlowField는 보관소의 슬롯이라, 이 목표가 버려진 뒤(용량 초과로 밀려남)에는 다른 목표에 다시 쓰입니다. 틱마다 다시 꺼내세요.
     */
    goal(keyA, keyB) {
        this.prepare();
        checkGoalKey(keyA, keyB);
        const SLOT = this.#lookup(keyA, keyB);
        if (SLOT < 0) {
            return null;
        }
        const GOAL = this.#slots[SLOT];
        GOAL.use = ++this.#clock;
        return GOAL.field;
    }

    /**
     * 목표 칸 `cells`(격자 칸 번호, 겹쳐도 됨)를 키 (keyA, keyB)로 보관하고 그 유동장을 돌려줍니다. 같은 키가 있으면 칸을 바꾸고
     * 계산을 비웁니다. 가득 찼으면 가장 오래 안 쓴 목표를 버립니다. 막힌 칸은 목표에서 빠집니다. 여기서는 칸을 정리만 하고,
     * 계산은 첫 질의 때 합니다. 같은 키에는 같은 칸 집합을 넣어야 합니다(키가 목표의 정의이고, 칸 집합을 바꾸는 것은 호출자의 책임).
     */
    setGoal(keyA, keyB, cells) {
        this.prepare();
        checkGoalKey(keyA, keyB);
        if (cells === null || typeof cells !== 'object' || !Number.isInteger(cells.length)) {
            throw new TypeError('PortalGraph.setGoal cells must be an array-like of cell numbers.');
        }
        for (let i = 0; i < cells.length; i++) {
            const CELL = cells[i];
            if (!Number.isInteger(CELL) || CELL < 0 || CELL >= this.grid.size) {
                throw new RangeError(`PortalGraph.setGoal cell ${CELL} is not a cell of the grid.`);
            }
        }
        let slot = this.#lookup(keyA, keyB);
        if (slot < 0) {
            slot = this.#freeSlot();
            const GOAL = this.#slots[slot];
            GOAL.keyA = keyA;
            GOAL.keyB = keyB;
            GOAL.live = true;
            this.#goalCount++;
            this.#insert(slot);
        }
        const GOAL = this.#slots[slot];
        this.#resetGoal(GOAL, cells);
        GOAL.use = ++this.#clock;
        this.stats.goalsBuilt++;
        return GOAL.field;
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

    /** 노드에서 짝 노드로 건너는 비용: 두 노드 칸 사이 한 걸음의 `stepCost`(칸 비용이 모두 1이면 직선 10, 대각 14). */
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
            COST = this.#chunkCost,
            COST_BASE = chunk * this.#cellsPerChunk,
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
                const CELL_COST = GRID.costOf(CELL);
                COST[COST_BASE + (row - ROW0) * SIZE + (col - COL0)] = CELL_COST;
                if (CELL_COST !== 0) {
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
            const DIRECTION = kind === BORDER_SOUTH_EAST ? SOUTH_EAST : SOUTH_WEST,
                CELL = ROW1 * COLS + COL,
                NEXT = GRID.stepCell(COL, ROW1, DIRECTION);
            if (NEXT >= 0) {
                this.#addPortal(chunk, kind, CELL, NEXT, stepCost(DIRECTION, GRID.costOf(CELL), GRID.costOf(NEXT)));
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
                    this.#addPortal(
                        chunk,
                        kind,
                        CENTER,
                        CENTER + STEP,
                        stepCost(EAST_SIDE ? EAST : SOUTH, GRID.costOf(CENTER), GRID.costOf(CENTER + STEP)),
                    );
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
                    this.#addPortal(chunk, kind, CELL, NEXT, stepCost(DIRECTION, GRID.costOf(CELL), GRID.costOf(NEXT)));
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
            CELL_COST = this.#chunkCost,
            COST_BASE = chunk * this.#cellsPerChunk,
            UNIFORM = this.#uniform,
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
                const BITS = MASK[CELL_OF[AT]],
                    AT_COST = CELL_COST[COST_BASE + AT];
                for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                    if (!(BITS & (1 << direction))) {
                        continue;
                    }
                    const NEXT_AT = AT + DIRECTION_DX[direction] + DIRECTION_DY[direction] * SIZE,
                        NEXT_COST =
                            COST +
                            (UNIFORM
                                ? DIRECTION_COST[direction]
                                : stepCost(direction, AT_COST, CELL_COST[COST_BASE + NEXT_AT]));
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

    // ---------- 목표 보관소 ----------

    // 살아 있는 노드에 노드 번호 순으로 0, 1, 2…를 붙이고 칸 좌표·전역 성분을 적어 둡니다.
    #renumber() {
        const COLS = this.grid.cols,
            PER = this.#cellsPerChunk;
        let count = 0;
        for (let node = 0; node < this.nodeCapacity; node++) {
            const CHUNK = this.#nodeChunk[node];
            if (CHUNK < 0) {
                this.#denseOf[node] = -1;
                continue;
            }
            const CELL = this.#nodeCell[node],
                COL = CELL % COLS;
            this.#denseOf[node] = count;
            this.#denseNode[count] = node;
            this.#denseCol[count] = COL;
            this.#denseRow[count] = (CELL - COL) / COLS;
            this.#denseLabel[count] = this.#compLabel[CHUNK * PER + this.#cellComp[CELL]];
            count++;
        }
        this.#denseCount = count;
    }

    #discardGoals() {
        for (const GOAL of this.#slots) {
            if (GOAL.live) {
                this.#releaseBlocks(GOAL);
                GOAL.live = false;
            }
        }
        this.#table.fill(0);
        this.#goalCount = 0;
    }

    // (keyA, keyB)의 해시: 두 키의 하위·상위 32비트를 murmur3 fmix32 식으로 섞습니다.
    #hash(keyA, keyB) {
        let h = Math.imul((keyA >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
        h ^= Math.floor(keyA / TWO_32) | 0;
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        h ^= keyB >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        h ^= Math.floor(keyB / TWO_32) | 0;
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        return (h ^ (h >>> 16)) & this.#tableMask;
    }

    #lookup(keyA, keyB) {
        const TABLE = this.#table,
            MASK = this.#tableMask;
        for (let at = this.#hash(keyA, keyB); ; at = (at + 1) & MASK) {
            const ENTRY = TABLE[at];
            if (ENTRY === 0) {
                return -1;
            }
            const GOAL = this.#slots[ENTRY - 1];
            if (GOAL.keyA === keyA && GOAL.keyB === keyB) {
                return ENTRY - 1;
            }
        }
    }

    #insert(slot) {
        const TABLE = this.#table,
            GOAL = this.#slots[slot];
        let at = this.#hash(GOAL.keyA, GOAL.keyB);
        while (TABLE[at] !== 0) {
            at = (at + 1) & this.#tableMask;
        }
        TABLE[at] = slot + 1;
    }

    // 선형 탐사의 뒤로 당기기 삭제: 빈자리 뒤의 항목 중 제 자리(해시)가 빈자리보다 앞인 것을 당겨 탐사 사슬을 유지합니다.
    #remove(slot) {
        const TABLE = this.#table,
            MASK = this.#tableMask;
        let hole = this.#hash(this.#slots[slot].keyA, this.#slots[slot].keyB);
        while (TABLE[hole] !== slot + 1) {
            hole = (hole + 1) & MASK;
        }
        TABLE[hole] = 0;
        for (let at = (hole + 1) & MASK; TABLE[at] !== 0; at = (at + 1) & MASK) {
            const GOAL = this.#slots[TABLE[at] - 1],
                HOME = this.#hash(GOAL.keyA, GOAL.keyB);
            // HOME이 (hole, at] 구간(원형) 밖이면 hole로 옮겨도 찾을 수 있습니다.
            const STAYS = hole <= at ? HOME > hole && HOME <= at : HOME > hole || HOME <= at;
            if (!STAYS) {
                TABLE[hole] = TABLE[at];
                TABLE[at] = 0;
                hole = at;
            }
        }
    }

    // 빈 슬롯(번호가 가장 작은 것)이나, 가득 찼으면 가장 오래 안 쓴 슬롯을 비워 돌려줍니다.
    #freeSlot() {
        for (let slot = 0; slot < this.#slots.length; slot++) {
            if (!this.#slots[slot].live) {
                return slot;
            }
        }
        if (this.#slots.length < this.goalCapacity) {
            const GOAL = new GoalSlot(this.chunkCount);
            GOAL.field = new FlowField(FLOW_TOKEN, this, GOAL);
            this.#slots.push(GOAL);
            return this.#slots.length - 1;
        }
        let oldest = 0;
        for (let slot = 1; slot < this.#slots.length; slot++) {
            if (this.#slots[slot].use < this.#slots[oldest].use) {
                oldest = slot;
            }
        }
        this.#remove(oldest);
        this.#releaseBlocks(this.#slots[oldest]);
        this.#slots[oldest].live = false;
        this.#goalCount--;
        return oldest;
    }

    #releaseBlocks(goal) {
        const BLOCKS = goal.blocks;
        for (let i = 0; i < BLOCKS.length; i++) {
            if (BLOCKS[i] >= 0) {
                this.#freeBlocks.push(BLOCKS[i]);
                BLOCKS[i] = -1;
            }
        }
    }

    #allocBlock() {
        if (this.#freeBlocks.length) {
            return this.#freeBlocks.pop();
        }
        this.#blocks.push(new Int32Array(this.#cellsPerChunk));
        return this.#blocks.length - 1;
    }

    // 목표 칸을 청크별로 모읍니다(청크 번호 순 계수 정렬, 청크 안은 넘긴 순서). 막힌 칸은 뺍니다. 목표 성분을 표시합니다.
    #resetGoal(goal, cells) {
        this.#releaseBlocks(goal);
        const COMP = this.#cellComp,
            PER = this.#cellsPerChunk,
            START = goal.chunkStart,
            CURSOR = this.#chunkCursor,
            N = this.#denseCount;
        START.fill(0);
        let open = 0;
        for (let i = 0; i < cells.length; i++) {
            if (COMP[cells[i]] !== NO_COMP) {
                START[this.chunkOf(cells[i]) + 1]++;
                open++;
            }
        }
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            START[chunk + 1] += START[chunk];
        }
        if (goal.cells.length < open) {
            goal.cells = new Int32Array(open);
        }
        CURSOR.set(START);
        if (goal.comps.length < this.#componentCount) {
            goal.comps = new Uint8Array(this.#componentCount);
        } else {
            goal.comps.fill(0);
        }
        for (let i = 0; i < cells.length; i++) {
            const CELL = cells[i];
            if (COMP[CELL] !== NO_COMP) {
                const CHUNK = this.chunkOf(CELL);
                goal.cells[CURSOR[CHUNK]++] = CELL;
                goal.comps[this.#compLabel[CHUNK * PER + COMP[CELL]]] = 1;
            }
        }
        if (goal.dist.length < N) {
            const SIZE = Math.ceil(N * 1.25);
            goal.dist = new Int32Array(SIZE);
            goal.state = new Uint8Array(SIZE);
            goal.heap = new Int32Array(SIZE);
            goal.pos = new Int32Array(SIZE);
            goal.key = new Float64Array(SIZE);
        } else {
            goal.state.fill(NODE_NEW, 0, N);
        }
        goal.heapSize = 0;
        goal.seeded = false;
    }

    // ---------- 유동장 질의 ----------

    #check(goal) {
        if (this.grid.changedRectCount !== 0) {
            this.prepare();
        }
        if (!goal.live) {
            throw new Error(
                'FlowField was discarded (structure changed or evicted); get it again with goal()/setGoal().',
            );
        }
    }

    // 칸이 든 청크 안의 칸 번호(행 · chunkSize + 열).
    #localOf(cell) {
        const COLS = this.grid.cols,
            SIZE = this.chunkSize,
            COL = cell % COLS,
            ROW = (cell - COL) / COLS;
        return (ROW % SIZE) * SIZE + (COL % SIZE);
    }

    #distance(goal, cell) {
        if (!(cell >= 0 && cell < this.grid.size)) {
            return UNREACHED;
        }
        const COMP = this.#cellComp[cell];
        if (COMP === NO_COMP) {
            return UNREACHED;
        }
        const COLS = this.grid.cols,
            SIZE = this.chunkSize,
            COL = cell % COLS,
            ROW = (cell - COL) / COLS,
            LOCAL_COL = COL % SIZE,
            LOCAL_ROW = ROW % SIZE,
            CHUNK = ((ROW - LOCAL_ROW) / SIZE) * this.chunkCols + (COL - LOCAL_COL) / SIZE;
        if (!goal.comps[this.#compLabel[CHUNK * this.#cellsPerChunk + COMP]]) {
            return UNREACHED;
        }
        return this.#blocks[this.#ensureNear(goal, CHUNK)][LOCAL_ROW * SIZE + LOCAL_COL];
    }

    // 이웃이 같은 청크면 그 청크의 F1을 바로 읽고, 다른 청크로 건너는 이웃만 #distance로 묻습니다(값은 같음).
    #lowestNeighbor(goal, cell) {
        let best = -1,
            bestCost = this.#distance(goal, cell);
        if (bestCost === UNREACHED) {
            return -1;
        }
        const GRID = this.grid,
            SIZE = this.chunkSize,
            COL = cell % GRID.cols,
            ROW = (cell - COL) / GRID.cols,
            LOCAL_COL = COL % SIZE,
            LOCAL_ROW = ROW % SIZE,
            OWN = this.#blocks[goal.blocks[this.chunkOf(cell) * 2 + 1]],
            BITS = this.#stepMask[cell];
        for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
            let cost;
            const NEXT_COL = LOCAL_COL + DIRECTION_DX[direction],
                NEXT_ROW = LOCAL_ROW + DIRECTION_DY[direction];
            // 청크 안 걸음은 stepMask가 stepCell과 같은 판정을 담고 있습니다(잘린 청크의 격자 밖 자리는 비트가 없음).
            if (NEXT_COL >= 0 && NEXT_COL < SIZE && NEXT_ROW >= 0 && NEXT_ROW < SIZE) {
                if (!(BITS & (1 << direction))) {
                    continue;
                }
                cost = OWN[NEXT_ROW * SIZE + NEXT_COL];
            } else {
                const NEXT = GRID.stepCell(COL, ROW, direction);
                if (NEXT < 0) {
                    continue;
                }
                cost = this.#distance(goal, NEXT);
            }
            if (cost < bestCost) {
                best = ROW * GRID.cols + COL + DIRECTION_DX[direction] + DIRECTION_DY[direction] * GRID.cols;
                bestCost = cost;
            }
        }
        return best;
    }

    #chunkStage(goal, chunk) {
        return (goal.blocks[chunk * 2] >= 0 ? 1 : 0) | (goal.blocks[chunk * 2 + 1] >= 0 ? 2 : 0);
    }

    // want 0: 노드 상태(0 안 닿음, 1 힙, 2 확정), 1: 확정한 추상 거리(아니면 UNREACHED).
    #nodeOf(goal, node, want) {
        const DENSE = node >= 0 && node < this.nodeCapacity ? this.#denseOf[node] : -1;
        if (DENSE < 0) {
            return want === 0 ? NODE_NEW : UNREACHED;
        }
        const STATE = goal.state[DENSE];
        if (want === 0) {
            return STATE;
        }
        return STATE === NODE_SETTLED ? goal.dist[DENSE] : UNREACHED;
    }

    // 청크 안 목표 칸을 0으로 놓고 씨앗 목록(this.#seeds) 앞에 한 번씩 적습니다. 적은 수를 돌려줍니다.
    #seedGoalCells(goal, chunk, dist) {
        const SEEDS = this.#seeds,
            START = goal.chunkStart;
        let count = 0;
        for (let i = START[chunk]; i < START[chunk + 1]; i++) {
            const LOCAL = this.#localOf(goal.cells[i]);
            if (dist[LOCAL] !== 0) {
                dist[LOCAL] = 0;
                SEEDS[count++] = LOCAL;
            }
        }
        return count;
    }

    // 목표 칸에서 각 목표 청크 안으로만 퍼뜨려 그 청크 노드에 처음 값을 줍니다(첫 질의 때 한 번).
    #seed(goal) {
        const DIST = this.#scratchDist,
            START = goal.chunkStart,
            CAP = this.#chunkNodeCap;
        for (let chunk = 0; chunk < this.chunkCount; chunk++) {
            if (START[chunk + 1] === START[chunk]) {
                continue;
            }
            DIST.fill(UNREACHED);
            this.#chunkDijkstra(chunk, DIST, this.#seeds, this.#seedGoalCells(goal, chunk, DIST));
            for (let i = 0; i < this.#chunkNodeCount[chunk]; i++) {
                const NODE = this.#chunkNodes[chunk * CAP + i],
                    D = DIST[this.#localOf(this.#nodeCell[NODE])];
                if (D !== UNREACHED) {
                    this.#relax(goal, this.#denseOf[NODE], D);
                }
            }
        }
        goal.seeded = true;
    }

    // 휴리스틱: 노드 칸에서 목표 사각형(지금 확정하려는 청크)까지의 옥타일 거리. 간선 비용은 실제로 걷는 길의 비용이라 두 끝 칸의
    // 옥타일 거리 이상이므로 일관(consistent)되고, 꺼낸 노드의 값은 휴리스틱과 무관하게 정확한 최단 추상 거리입니다.
    #heuristic(goal, dense) {
        const COL = this.#denseCol[dense],
            ROW = this.#denseRow[dense],
            DX = COL < goal.col0 ? goal.col0 - COL : COL > goal.col1 ? COL - goal.col1 : 0,
            DY = ROW < goal.row0 ? goal.row0 - ROW : ROW > goal.row1 ? ROW - goal.row1 : 0;
        return DX > DY ? 10 * DX + 4 * DY : 10 * DY + 4 * DX;
    }

    #relax(goal, dense, cost) {
        const STATE = goal.state[dense];
        if (STATE === NODE_SETTLED || (STATE === NODE_OPEN && cost >= goal.dist[dense])) {
            return;
        }
        goal.dist[dense] = cost;
        goal.key[dense] = (cost + this.#heuristic(goal, dense)) * this.#nodeScale + dense;
        if (STATE === NODE_NEW) {
            goal.state[dense] = NODE_OPEN;
            goal.pos[dense] = goal.heapSize;
            goal.heap[goal.heapSize++] = dense;
        }
        siftUp(goal, goal.pos[dense]);
    }

    /**
     * 청크의 노드(목표와 같은 전역 성분인 것) 추상 거리가 모두 확정될 때까지 목표의 A*를 이어서 돌립니다. 휴리스틱 사각형이 바뀌면
     * 힙의 키만 다시 계산합니다(확정한 노드와 임시 값은 그대로).
     */
    #settle(goal, chunk) {
        const CAP = this.#chunkNodeCap,
            COUNT = this.#chunkNodeCount[chunk],
            BASE = chunk * CAP;
        let remaining = 0;
        for (let i = 0; i < COUNT; i++) {
            const DENSE = this.#denseOf[this.#chunkNodes[BASE + i]];
            if (goal.comps[this.#denseLabel[DENSE]] && goal.state[DENSE] !== NODE_SETTLED) {
                remaining++;
            }
        }
        if (remaining === 0) {
            return;
        }
        const SIZE = this.chunkSize,
            CHUNK_COL = chunk % this.chunkCols,
            COL0 = CHUNK_COL * SIZE,
            ROW0 = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE;
        if (goal.col0 !== COL0 || goal.row0 !== ROW0) {
            goal.col0 = COL0;
            goal.row0 = ROW0;
            goal.col1 = Math.min(this.grid.cols, COL0 + SIZE) - 1;
            goal.row1 = Math.min(this.grid.rows, ROW0 + SIZE) - 1;
            const HEAP = goal.heap;
            for (let at = 0; at < goal.heapSize; at++) {
                const DENSE = HEAP[at];
                goal.key[DENSE] = (goal.dist[DENSE] + this.#heuristic(goal, DENSE)) * this.#nodeScale + DENSE;
            }
            for (let at = (goal.heapSize >> 1) - 1; at >= 0; at--) {
                siftDown(goal, at);
            }
        }
        if (!goal.seeded) {
            this.#seed(goal);
        }
        const NODE_CHUNK = this.#nodeChunk,
            NODE_INDEX = this.#nodeIndex,
            NODES = this.#chunkNodes,
            DENSE_OF = this.#denseOf;
        while (remaining > 0) {
            if (goal.heapSize === 0) {
                throw new Error('PortalGraph internal error: a goal-component node was not reached.');
            }
            const DENSE = goal.heap[0];
            goal.heap[0] = goal.heap[--goal.heapSize];
            goal.pos[goal.heap[0]] = 0;
            if (goal.heapSize) {
                siftDown(goal, 0);
            }
            goal.state[DENSE] = NODE_SETTLED;
            this.stats.nodesSettled++;
            const NODE = this.#denseNode[DENSE],
                OWN = NODE_CHUNK[NODE],
                D = goal.dist[DENSE];
            if (OWN === chunk) {
                remaining--;
            }
            const PEER = DENSE_OF[NODE ^ 1];
            if (PEER >= 0) {
                this.#relax(goal, PEER, D + this.#portalCost[NODE >> 1]);
            }
            if (!this.#matrixReady[OWN]) {
                this.#buildMatrix(OWN);
            }
            const MATRIX = this.#matrix[OWN],
                N = this.#chunkNodeCount[OWN],
                INDEX = NODE_INDEX[NODE],
                ROW = INDEX * N,
                OWN_BASE = OWN * CAP;
            for (let to = 0; to < N; to++) {
                const COST = MATRIX[ROW + to];
                if (to !== INDEX && COST !== NO_EDGE) {
                    this.#relax(goal, DENSE_OF[NODES[OWN_BASE + to]], D + COST);
                }
            }
        }
    }

    // F0(청크): 씨앗 = 청크 안 목표 칸 0, 청크 노드 칸의 추상 거리. 청크 안으로만 퍼뜨립니다.
    #ensureFar(goal, chunk) {
        const HAVE = goal.blocks[chunk * 2];
        if (HAVE >= 0) {
            return HAVE;
        }
        this.#settle(goal, chunk);
        const BLOCK = this.#allocBlock(),
            DIST = this.#blocks[BLOCK],
            CAP = this.#chunkNodeCap,
            SEEDS = this.#seeds;
        DIST.fill(UNREACHED);
        let count = this.#seedGoalCells(goal, chunk, DIST);
        for (let i = 0; i < this.#chunkNodeCount[chunk]; i++) {
            const NODE = this.#chunkNodes[chunk * CAP + i],
                DENSE = this.#denseOf[NODE];
            if (goal.state[DENSE] === NODE_SETTLED) {
                const LOCAL = this.#localOf(this.#nodeCell[NODE]);
                if (DIST[LOCAL] === UNREACHED) {
                    SEEDS[count++] = LOCAL;
                }
                if (goal.dist[DENSE] < DIST[LOCAL]) {
                    DIST[LOCAL] = goal.dist[DENSE];
                }
            }
        }
        this.#chunkDijkstra(chunk, DIST, SEEDS, count);
        goal.blocks[chunk * 2] = BLOCK;
        this.stats.fieldsBuilt++;
        return BLOCK;
    }

    // F1(청크): F0 값에 더해, 청크 밖으로 나가는 합법 걸음마다 건너편 청크의 F0 값 + 걸음 비용을 씨앗으로 다시 퍼뜨립니다.
    // F1 ≤ F0이고 씨앗이 모두 실제로 걸을 수 있는 길의 비용이라 실제 최단 이상입니다.
    #ensureNear(goal, chunk) {
        const HAVE = goal.blocks[chunk * 2 + 1];
        if (HAVE >= 0) {
            return HAVE;
        }
        const FAR = this.#ensureFar(goal, chunk),
            BLOCK = this.#allocBlock(),
            DIST = this.#blocks[BLOCK],
            GRID = this.grid,
            COLS = GRID.cols,
            SIZE = this.chunkSize,
            PER = this.#cellsPerChunk,
            CHUNK_COL = chunk % this.chunkCols,
            COL0 = CHUNK_COL * SIZE,
            ROW0 = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE,
            COL1 = Math.min(COLS, COL0 + SIZE) - 1,
            ROW1 = Math.min(GRID.rows, ROW0 + SIZE) - 1;
        DIST.set(this.#blocks[FAR]);
        for (let row = ROW0; row <= ROW1; row++) {
            // 가장자리 행은 모든 칸, 그 사이 행은 양 끝 칸만.
            const STRIDE = row === ROW0 || row === ROW1 ? 1 : Math.max(1, COL1 - COL0);
            for (let col = COL0; col <= COL1; col += STRIDE) {
                const CELL = row * COLS + col,
                    COMP = this.#cellComp[CELL];
                if (COMP === NO_COMP || !goal.comps[this.#compLabel[chunk * PER + COMP]]) {
                    continue;
                }
                const LOCAL = (row - ROW0) * SIZE + (col - COL0);
                for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                    const NEXT_COL = col + DIRECTION_DX[direction],
                        NEXT_ROW = row + DIRECTION_DY[direction];
                    if (NEXT_COL >= COL0 && NEXT_COL <= COL1 && NEXT_ROW >= ROW0 && NEXT_ROW <= ROW1) {
                        continue;
                    }
                    const NEXT = GRID.stepCell(col, row, direction);
                    if (NEXT < 0) {
                        continue;
                    }
                    const VALUE = this.#blocks[this.#ensureFar(goal, this.chunkOf(NEXT))][this.#localOf(NEXT)];
                    if (VALUE === UNREACHED) {
                        continue;
                    }
                    const THROUGH =
                        VALUE +
                        (this.#uniform
                            ? DIRECTION_COST[direction]
                            : stepCost(direction, GRID.costOf(CELL), GRID.costOf(NEXT)));
                    if (THROUGH < DIST[LOCAL]) {
                        DIST[LOCAL] = THROUGH;
                    }
                }
            }
        }
        // F0은 이미 닫혀 있으므로 값이 줄어든 가장자리 칸만 씨앗으로 다시 퍼뜨리면 전체 씨앗의 닫힘과 같습니다.
        const SEEDS = this.#seeds,
            FAR_DIST = this.#blocks[FAR];
        let count = 0;
        for (let row = ROW0; row <= ROW1; row++) {
            const STRIDE = row === ROW0 || row === ROW1 ? 1 : Math.max(1, COL1 - COL0);
            for (let col = COL0; col <= COL1; col += STRIDE) {
                const LOCAL = (row - ROW0) * SIZE + (col - COL0);
                if (DIST[LOCAL] < FAR_DIST[LOCAL]) {
                    SEEDS[count++] = LOCAL;
                }
            }
        }
        this.#chunkDijkstra(chunk, DIST, SEEDS, count);
        goal.blocks[chunk * 2 + 1] = BLOCK;
        this.stats.fieldsBuilt++;
        return BLOCK;
    }

    /**
     * 청크 안 Dijkstra: `dist`(청크 안 칸 번호)에서 `seeds`의 앞 `count`칸부터 청크 안 걸음으로만 값을 줄여 퍼뜨립니다. 씨앗이 아닌
     * 칸의 값은 이미 이웃과 맞는(닫힌) 값이어야 합니다(UNREACHED이거나 앞선 퍼뜨리기의 결과). 그러면 결과는 모든 씨앗 값의 닫힘이고
     * 순서와 무관합니다. 힙은 청크 안 칸의 위치 색인 힙이고 (값, 칸 번호) 순으로 꺼냅니다.
     */
    #chunkDijkstra(chunk, dist, seeds, count) {
        const COLS = this.grid.cols,
            SIZE = this.chunkSize,
            MASK = this.#stepMask,
            CELL_COST = this.#chunkCost,
            COST_BASE = chunk * this.#cellsPerChunk,
            UNIFORM = this.#uniform,
            HEAP = this.#fieldHeap,
            POS = this.#fieldPos,
            OFFSET = this.#localOffset,
            STEP = this.#localStep,
            CHUNK_COL = chunk % this.chunkCols,
            BASE = ((chunk - CHUNK_COL) / this.chunkCols) * SIZE * COLS + CHUNK_COL * SIZE;
        POS.fill(-1);
        let size = 0;
        for (let i = 0; i < count; i++) {
            const LOCAL = seeds[i];
            if (POS[LOCAL] < 0) {
                POS[LOCAL] = size;
                HEAP[size++] = LOCAL;
            }
            localSiftUp(HEAP, POS, dist, POS[LOCAL]);
        }
        while (size) {
            const LOCAL = HEAP[0],
                COST = dist[LOCAL];
            POS[LOCAL] = -2;
            if (--size) {
                HEAP[0] = HEAP[size];
                POS[HEAP[0]] = 0;
                localSiftDown(HEAP, POS, dist, size, 0);
            }
            const BITS = MASK[BASE + OFFSET[LOCAL]],
                LOCAL_COST = CELL_COST[COST_BASE + LOCAL];
            for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
                if (!(BITS & (1 << direction))) {
                    continue;
                }
                const NEXT = LOCAL + STEP[direction],
                    NEXT_COST =
                        COST +
                        (UNIFORM
                            ? DIRECTION_COST[direction]
                            : stepCost(direction, LOCAL_COST, CELL_COST[COST_BASE + NEXT]));
                if (NEXT_COST < dist[NEXT]) {
                    dist[NEXT] = NEXT_COST;
                    if (POS[NEXT] === -1) {
                        POS[NEXT] = size;
                        HEAP[size++] = NEXT;
                    }
                    localSiftUp(HEAP, POS, dist, POS[NEXT]);
                }
            }
        }
    }
}

// 청크 안 칸의 위치 색인 최소 힙: (dist[칸], 칸 번호) 순. 값이 같으면 칸 번호가 작은 쪽이 먼저입니다.
function localSiftUp(heap, pos, dist, at) {
    const LOCAL = heap[at],
        VALUE = dist[LOCAL];
    while (at > 0) {
        const PARENT = (at - 1) >> 1,
            OTHER = heap[PARENT],
            OTHER_VALUE = dist[OTHER];
        if (OTHER_VALUE < VALUE || (OTHER_VALUE === VALUE && OTHER < LOCAL)) {
            break;
        }
        heap[at] = OTHER;
        pos[OTHER] = at;
        at = PARENT;
    }
    heap[at] = LOCAL;
    pos[LOCAL] = at;
}

function localSiftDown(heap, pos, dist, size, at) {
    const LOCAL = heap[at],
        VALUE = dist[LOCAL];
    for (;;) {
        const LEFT = at * 2 + 1;
        if (LEFT >= size) {
            break;
        }
        let child = LEFT;
        if (LEFT + 1 < size) {
            const A = heap[LEFT],
                B = heap[LEFT + 1];
            if (dist[B] < dist[A] || (dist[B] === dist[A] && B < A)) {
                child = LEFT + 1;
            }
        }
        const OTHER = heap[child],
            OTHER_VALUE = dist[OTHER];
        if (VALUE < OTHER_VALUE || (VALUE === OTHER_VALUE && LOCAL < OTHER)) {
            break;
        }
        heap[at] = OTHER;
        pos[OTHER] = at;
        at = child;
    }
    heap[at] = LOCAL;
    pos[LOCAL] = at;
}

function checkGoalKey(keyA, keyB) {
    if (!Number.isSafeInteger(keyA) || !Number.isSafeInteger(keyB)) {
        throw new RangeError('PortalGraph goal keys must be safe integers.');
    }
}

// 목표별 추상 힙(위치 색인 힙, 키는 goal.key[조밀 번호]).
function siftUp(goal, at) {
    const HEAP = goal.heap,
        POS = goal.pos,
        KEY = goal.key,
        DENSE = HEAP[at],
        VALUE = KEY[DENSE];
    while (at > 0) {
        const PARENT = (at - 1) >> 1;
        if (KEY[HEAP[PARENT]] <= VALUE) {
            break;
        }
        HEAP[at] = HEAP[PARENT];
        POS[HEAP[at]] = at;
        at = PARENT;
    }
    HEAP[at] = DENSE;
    POS[DENSE] = at;
}

function siftDown(goal, at) {
    const HEAP = goal.heap,
        POS = goal.pos,
        KEY = goal.key,
        SIZE = goal.heapSize,
        DENSE = HEAP[at],
        VALUE = KEY[DENSE];
    for (;;) {
        const LEFT = at * 2 + 1;
        if (LEFT >= SIZE) {
            break;
        }
        const CHILD = LEFT + 1 < SIZE && KEY[HEAP[LEFT + 1]] < KEY[HEAP[LEFT]] ? LEFT + 1 : LEFT;
        if (KEY[HEAP[CHILD]] >= VALUE) {
            break;
        }
        HEAP[at] = HEAP[CHILD];
        POS[HEAP[at]] = at;
        at = CHILD;
    }
    HEAP[at] = DENSE;
    POS[DENSE] = at;
}

// 목표 하나의 보관 상태. 배열은 모자랄 때만 새로 만들고 슬롯을 다시 쓸 때 재사용합니다.
class GoalSlot {
    field = null;
    live = false;
    keyA = 0;
    keyB = 0;
    use = 0;
    seeded = false;
    // 목표 칸(청크 번호 순)과 청크마다 시작 위치(청크 수 + 1).
    cells = new Int32Array(0);
    chunkStart;
    // 전역 성분마다 목표 칸이 있는지.
    comps = new Uint8Array(0);
    // 조밀 번호마다 추상 거리(임시 또는 확정)·상태·힙 위치·힙 키, 힙.
    dist = new Int32Array(0);
    state = new Uint8Array(0);
    heap = new Int32Array(0);
    pos = new Int32Array(0);
    key = new Float64Array(0);
    heapSize = 0;
    // 휴리스틱 사각형(칸 좌표, 양끝 포함). -1은 아직 없음.
    col0 = -1;
    row0 = -1;
    col1 = -1;
    row1 = -1;
    // 청크 장 블록 번호: 청크 · 2 + 단계(0 = F0, 1 = F1), 없으면 -1.
    blocks;

    constructor(chunkCount) {
        this.chunkStart = new Int32Array(chunkCount + 1);
        this.blocks = new Int32Array(chunkCount * 2).fill(-1);
    }
}

/**
 * 목표 하나로 내려가는 유동장입니다. `PortalGraph.setGoal`·`goal`이 돌려주고 직접 만들 수 없습니다. 값은 실제로 걸을 수 있는 길의
 * 비용(정수)이라 실제 최단 비용 이상이고, 질의한 청크만 계산합니다. 같은 목표 칸 집합·격자 상태면 어떤 순서로 묻든 같은 값입니다.
 */
export class FlowField {
    #graph;
    #goal;

    constructor(token, graph, goal) {
        if (token !== FLOW_TOKEN) {
            throw new TypeError('FlowField is made by PortalGraph.setGoal.');
        }
        this.#graph = graph;
        this.#goal = goal;
    }

    /** 보관 키의 첫 수. */
    get keyA() {
        return this.#goal.keyA;
    }

    /** 보관 키의 둘째 수. */
    get keyB() {
        return this.#goal.keyB;
    }

    /**
     * 칸에서 목표까지의 비용(정수, 목표 칸은 0). 닿지 않는 칸·막힌 칸·격자 밖 번호는 `UNREACHED`. 칸이 든 청크의 F1을 처음 물을 때
     * 만들고(필요한 추상 거리·이웃 F0 포함), 다시 물으면 읽기만 합니다. 버려진 유동장이면 Error.
     */
    distance(cell) {
        flowAccess.check(this.#graph, this.#goal);
        return flowAccess.distance(this.#graph, this.#goal, cell);
    }

    /** `cell`보다 싼 이웃 중 가장 싼 칸(동률은 방향 순서 동·남·서·북·남동·남서·북서·북동에서 앞선 쪽), 없으면 -1. */
    lowestNeighbor(cell) {
        flowAccess.check(this.#graph, this.#goal);
        return flowAccess.lowest(this.#graph, this.#goal, cell);
    }

    /**
     * `start`에서 `lowestNeighbor`를 최대 `maxSteps`번 따라간 칸 번호를 `out`(먼저 비움)에 채워 돌려줍니다. `start`는 넣지 않고,
     * 목표 칸에서 멈춥니다. 닿지 않는 `start`면 빈 결과입니다. 값이 엄격히 줄어드는 쪽으로만 가므로 반드시 목표 칸에 닿습니다.
     */
    descend(start, maxSteps, out = []) {
        flowAccess.check(this.#graph, this.#goal);
        out.length = 0;
        if (flowAccess.distance(this.#graph, this.#goal, start) === UNREACHED) {
            return out;
        }
        let cell = start;
        for (let i = 0; i < maxSteps; i++) {
            const NEXT = flowAccess.lowest(this.#graph, this.#goal, cell);
            if (NEXT < 0) {
                break;
            }
            out.push(NEXT);
            cell = NEXT;
        }
        return out;
    }

    /** 청크 장을 만든 단계(관찰용): 비트 1 = F0, 비트 2 = F1. */
    chunkStage(chunk) {
        return flowAccess.stage(this.#graph, this.#goal, chunk);
    }

    /** 포털 노드의 추상 탐색 상태(관찰용): 0 안 닿음, 1 임시 값(힙), 2 확정. */
    nodeState(node) {
        return flowAccess.node(this.#graph, this.#goal, node, 0);
    }

    /** 확정한 포털 노드의 추상 거리(관찰용). 확정 전이거나 닿지 않으면 `UNREACHED`. */
    nodeDistance(node) {
        return flowAccess.node(this.#graph, this.#goal, node, 1);
    }
}
