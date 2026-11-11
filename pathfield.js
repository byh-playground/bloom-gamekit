// modules/pathfield/grid.js
var STRAIGHT_COST = 10;
var DIAGONAL_COST = 14;
var DIRECTION_COUNT = 8;
var DIRECTION_DX = Int8Array.of(1, 0, -1, 0, 1, -1, -1, 1);
var DIRECTION_DY = Int8Array.of(0, 1, 0, -1, 1, 1, -1, -1);
var DIRECTION_COST = Uint8Array.of(
  STRAIGHT_COST,
  STRAIGHT_COST,
  STRAIGHT_COST,
  STRAIGHT_COST,
  DIAGONAL_COST,
  DIAGONAL_COST,
  DIAGONAL_COST,
  DIAGONAL_COST
);
var MAX_CELLS = 1 << 22;
var UNKNOWN = -1;
var BLOCKED = 0;
var OPEN = 1;
var OPTIONS = ["width", "height", "cellSize", "passable", "passableEdge", "originX", "originY"];
var REVERSE_DIRECTION = Uint8Array.of(2, 3, 0, 1, 6, 7, 4, 5);
var MAX_CHANGED_RECTS = 16;
function positiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`PathGrid ${name} must be a positive finite number.`);
  }
  return value;
}
function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`PathGrid ${name} must be a finite number.`);
  }
  return value;
}
var PathGrid = class {
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
  #passableEdge;
  #edgeKnown;
  #edgeOpen;
  #stack = null;
  // 마지막 takeChangedRects 이후 바뀐 사각형: 칸 좌표 [minCol, minRow, maxCol, maxRow] 네 정수씩, 기록 순서대로.
  #changed = new Int32Array(MAX_CHANGED_RECTS * 4);
  #changedCount = 0;
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("PathGrid options must be an object.");
    }
    for (const KEY of Object.keys(options)) {
      if (!OPTIONS.includes(KEY)) {
        throw new TypeError(`PathGrid has an unknown option: ${KEY}`);
      }
    }
    if (typeof options.passable !== "function") {
      throw new TypeError("PathGrid passable must be a function.");
    }
    if (options.passableEdge != null && typeof options.passableEdge !== "function") {
      throw new TypeError("PathGrid passableEdge must be a function.");
    }
    this.cellSize = positiveNumber(options.cellSize, "cellSize");
    this.originX = finiteNumber(options.originX ?? 0, "originX");
    this.originY = finiteNumber(options.originY ?? 0, "originY");
    this.cols = Math.ceil(positiveNumber(options.width, "width") / this.cellSize);
    this.rows = Math.ceil(positiveNumber(options.height, "height") / this.cellSize);
    this.size = this.cols * this.rows;
    if (this.size > MAX_CELLS) {
      throw new RangeError(`PathGrid would need more than ${MAX_CELLS} cells; use a larger cellSize.`);
    }
    this.#passable = options.passable;
    this.#open = new Int8Array(this.size).fill(UNKNOWN);
    this.#passableEdge = options.passableEdge ?? null;
    this.#edgeKnown = this.#passableEdge ? new Uint8Array(this.size) : null;
    this.#edgeOpen = this.#passableEdge ? new Uint8Array(this.size) : null;
  }
  /** 좌표가 든 칸의 번호. 격자 밖은 가장자리 칸으로 자릅니다. 좌표는 NaN이 아니어야 합니다. */
  cellAt(x, y) {
    const COL = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.originX) / this.cellSize))), ROW = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.originY) / this.cellSize)));
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
    return this.originX + (cell % this.cols + 0.5) * this.cellSize;
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
    const DX = DIRECTION_DX[direction], DY = DIRECTION_DY[direction], NX = col + DX, NY = row + DY;
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
    if (this.#passableEdge) {
      const CURRENT = row * this.cols + col, BIT = 1 << direction;
      if (!(this.#edgeKnown[CURRENT] & BIT)) {
        const REVERSE = 1 << REVERSE_DIRECTION[direction];
        const OPEN2 = this.#passableEdge(
          this.centerX(CURRENT),
          this.centerY(CURRENT),
          this.centerX(NEXT),
          this.centerY(NEXT),
          CURRENT,
          NEXT
        );
        this.#edgeKnown[CURRENT] |= BIT;
        this.#edgeKnown[NEXT] |= REVERSE;
        if (OPEN2) {
          this.#edgeOpen[CURRENT] |= BIT;
          this.#edgeOpen[NEXT] |= REVERSE;
        }
      }
      if (!(this.#edgeOpen[CURRENT] & BIT)) {
        return -1;
      }
    }
    return NEXT;
  }
  /** 통과 판정의 기억을 비우고 `revision`을 올립니다. 장애물이 바뀐 뒤에 부릅니다. */
  invalidate() {
    this.#open.fill(UNKNOWN);
    this.#edgeKnown?.fill(0);
    this.#edgeOpen?.fill(0);
    this.revision++;
    this.#changedCount = 0;
    this.#recordChange(0, 0, this.cols - 1, this.rows - 1);
  }
  /**
   * 월드 좌표 사각형 [minX, maxX] × [minY, maxY]에 걸친 칸(경계가 칸 경계에 정확히 닿으면 그 너머 칸도 포함)의 통과 판정
   * 기억만 비우고 `revision`을 올립니다. 이 칸들과 맞닿은 한 겹 칸의 변 판정(`passableEdge`)도 함께 비웁니다. 격자 밖으로
   * 나간 부분은 자르고, 격자와 전혀 겹치지 않으면 아무것도 하지 않습니다(`revision`도 그대로). 비운 칸 범위는
   * `takeChangedRects`로 가져갈 수 있게 기록합니다. 좌표가 유한한 수가 아니거나 min이 max보다 크면 `RangeError`.
   */
  invalidateRect(minX, minY, maxX, maxY) {
    for (const VALUE of [minX, minY, maxX, maxY]) {
      if (typeof VALUE !== "number" || !Number.isFinite(VALUE)) {
        throw new RangeError("PathGrid.invalidateRect needs finite numbers.");
      }
    }
    if (minX > maxX || minY > maxY) {
      throw new RangeError("PathGrid.invalidateRect needs min <= max.");
    }
    const COL0 = Math.max(0, Math.floor((minX - this.originX) / this.cellSize)), COL1 = Math.min(this.cols - 1, Math.floor((maxX - this.originX) / this.cellSize)), ROW0 = Math.max(0, Math.floor((minY - this.originY) / this.cellSize)), ROW1 = Math.min(this.rows - 1, Math.floor((maxY - this.originY) / this.cellSize));
    if (COL0 > COL1 || ROW0 > ROW1) {
      return;
    }
    for (let row = ROW0; row <= ROW1; row++) {
      this.#open.fill(UNKNOWN, row * this.cols + COL0, row * this.cols + COL1 + 1);
    }
    if (this.#passableEdge) {
      const EDGE_COL0 = Math.max(0, COL0 - 1), EDGE_COL1 = Math.min(this.cols - 1, COL1 + 1);
      for (let row = Math.max(0, ROW0 - 1); row <= Math.min(this.rows - 1, ROW1 + 1); row++) {
        this.#edgeKnown.fill(0, row * this.cols + EDGE_COL0, row * this.cols + EDGE_COL1 + 1);
        this.#edgeOpen.fill(0, row * this.cols + EDGE_COL0, row * this.cols + EDGE_COL1 + 1);
      }
    }
    this.revision++;
    this.#recordChange(COL0, ROW0, COL1, ROW1);
  }
  /** 마지막으로 가져간 뒤 기록된 바뀐 사각형의 개수(0..`MAX_CHANGED_RECTS`). */
  get changedRectCount() {
    return this.#changedCount;
  }
  /**
   * 마지막으로 가져간 뒤 바뀐 칸 사각형을 `out`(길이 `4 * MAX_CHANGED_RECTS` 이상의 Int32Array)에
   * `[minCol, minRow, maxCol, maxRow]`(양끝 포함) 네 정수씩 기록 순서대로 쓰고 개수를 돌려준 뒤 기록을 비웁니다.
   * 소비자는 하나라고 가정합니다(두 곳이 가져가면 나중 쪽은 놓칩니다). `invalidate()`·`sync`가 비운 경우는 격자 전체 한 개입니다.
   * @param {Int32Array} out
   */
  takeChangedRects(out) {
    if (!(out instanceof Int32Array) || out.length < MAX_CHANGED_RECTS * 4) {
      throw new TypeError(`PathGrid.takeChangedRects needs an Int32Array of at least ${MAX_CHANGED_RECTS * 4}.`);
    }
    const COUNT = this.#changedCount;
    out.set(this.#changed.subarray(0, COUNT * 4));
    this.#changedCount = 0;
    return COUNT;
  }
  // 기록 규칙(호출 순서에만 의존): 이미 기록된 사각형에 완전히 들어가면 버리고, 아니면 뒤에 붙입니다.
  // 가득 차면 기록 전체와 새 사각형을 하나의 바운딩 사각형으로 합칩니다.
  #recordChange(minCol, minRow, maxCol, maxRow) {
    const LIST = this.#changed;
    for (let i = 0; i < this.#changedCount * 4; i += 4) {
      if (LIST[i] <= minCol && LIST[i + 1] <= minRow && LIST[i + 2] >= maxCol && LIST[i + 3] >= maxRow) {
        return;
      }
    }
    if (this.#changedCount < MAX_CHANGED_RECTS) {
      const AT = this.#changedCount++ * 4;
      LIST[AT] = minCol;
      LIST[AT + 1] = minRow;
      LIST[AT + 2] = maxCol;
      LIST[AT + 3] = maxRow;
      return;
    }
    let x0 = minCol, y0 = minRow, x1 = maxCol, y1 = maxRow;
    for (let i = 0; i < LIST.length; i += 4) {
      x0 = Math.min(x0, LIST[i]);
      y0 = Math.min(y0, LIST[i + 1]);
      x1 = Math.max(x1, LIST[i + 2]);
      y1 = Math.max(y1, LIST[i + 3]);
    }
    LIST[0] = x0;
    LIST[1] = y0;
    LIST[2] = x1;
    LIST[3] = y1;
    this.#changedCount = 1;
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
    const COL = cell % this.cols, ROW = (cell - COL) / this.cols;
    for (let ring = 1; ring <= maxRing; ring++) {
      let best = -1, bestD = Infinity;
      for (let dy = -ring; dy <= ring; dy++) {
        const NY = ROW + dy;
        if (NY < 0 || NY >= this.rows) {
          continue;
        }
        const STRIDE = dy === -ring || dy === ring ? 1 : 2 * ring;
        for (let dx = -ring; dx <= ring; dx += STRIDE) {
          const NX = COL + dx;
          if (NX < 0 || NX >= this.cols) {
            continue;
          }
          const NEXT = NY * this.cols + NX, D = dx * dx + dy * dy;
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
    const COL0 = Math.max(0, Math.floor((x - outerRadius - this.originX) / this.cellSize)), COL1 = Math.min(this.cols - 1, Math.floor((x + outerRadius - this.originX) / this.cellSize)), ROW0 = Math.max(0, Math.floor((y - outerRadius - this.originY) / this.cellSize)), ROW1 = Math.min(this.rows - 1, Math.floor((y + outerRadius - this.originY) / this.cellSize));
    for (let row = ROW0; row <= ROW1; row++) {
      for (let col = COL0; col <= COL1; col++) {
        const CELL = row * this.cols + col, CX = this.centerX(CELL), CY = this.centerY(CELL), D = Math.hypot(CX - x, CY - y);
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
   * `start`(열린 칸)에서 8방향으로 걸어 닿는 칸을 1로 표시해 `out`(길이 `size` 이상의 Uint8Array, 먼저 비움)에 채웁니다.
   * `start`가 열려 있지 않으면(-1 포함) 모두 0입니다. 거리장보다 가볍게 "이어져 있는가"만 알고 싶을 때 씁니다.
   * 탐색 스택은 격자가 가진 Int32Array(칸마다 한 번만 들어감)를 재사용합니다.
   * @param {number} start
   * @param {Uint8Array} out
   */
  reachableFrom(start, out) {
    if (!(out instanceof Uint8Array) || out.length < this.size) {
      throw new TypeError(`PathGrid.reachableFrom needs a Uint8Array of at least ${this.size} cells.`);
    }
    out.fill(0, 0, this.size);
    if (!this.isOpen(start)) {
      return out;
    }
    const STACK = this.#stack ??= new Int32Array(this.size);
    let top = 0;
    STACK[top++] = start;
    out[start] = 1;
    while (top) {
      const CELL = STACK[--top], COL = CELL % this.cols, ROW = (CELL - COL) / this.cols;
      for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
        const NEXT = this.stepCell(COL, ROW, direction);
        if (NEXT >= 0 && out[NEXT] === 0) {
          out[NEXT] = 1;
          STACK[top++] = NEXT;
        }
      }
    }
    return out;
  }
};

// modules/pathfield/field.js
var UNREACHED = 2147483647;
var CellHeap = class {
  scale;
  keys = [];
  constructor(scale) {
    this.scale = scale;
  }
  get size() {
    return this.keys.length;
  }
  push(cost, cell) {
    const KEYS = this.keys, KEY = cost * this.scale + cell;
    let i = KEYS.length;
    KEYS.push(KEY);
    while (i > 0) {
      const PARENT = i - 1 >> 1;
      if (KEYS[PARENT] <= KEY) {
        break;
      }
      KEYS[i] = KEYS[PARENT];
      i = PARENT;
    }
    KEYS[i] = KEY;
  }
  pop() {
    const KEYS = this.keys, TOP = KEYS[0], LAST = KEYS.pop();
    if (KEYS.length) {
      let i = 0;
      for (; ; ) {
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
};
var DistanceField = class {
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
      throw new TypeError("DistanceField needs a PathGrid.");
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
    const GRID = this.grid, COLS = GRID.cols, DIST = this.dist, HEAP = this.#heap, SCALE = HEAP.scale;
    while (HEAP.size) {
      if (target >= 0 && DIST[target] < Math.floor(HEAP.keys[0] / SCALE)) {
        return;
      }
      const KEY = HEAP.pop(), CELL = KEY % SCALE, COST = (KEY - CELL) / SCALE;
      if (COST > DIST[CELL]) {
        continue;
      }
      const COL = CELL % COLS, ROW = (CELL - COL) / COLS;
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
    const GRID = this.grid, DIST = this.dist, COL = cell % GRID.cols, ROW = (cell - COL) / GRID.cols;
    let best = -1, bestCost = DIST[cell];
    for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
      const NEXT = GRID.stepCell(COL, ROW, direction);
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
};

// modules/pathfield/cache.js
var FieldCache = class {
  /** 거리장을 만든 격자. 이 격자가 `invalidate()`되면 담긴 거리장은 모두 버립니다. */
  grid;
  /** 담을 수 있는 최대 개수. 넘기려 하면 먼저 넣은 것부터 버립니다(FIFO). */
  capacity;
  #fields = /* @__PURE__ */ new Map();
  #revision;
  #epoch;
  /**
   * @param {PathGrid} grid
   * @param {{ capacity?: number }} [options] `capacity`는 1 이상의 정수 또는 `Infinity`(기본).
   */
  constructor(grid, options = {}) {
    if (!(grid instanceof PathGrid)) {
      throw new TypeError("FieldCache needs a PathGrid.");
    }
    const CAPACITY = options.capacity ?? Infinity;
    if (CAPACITY !== Infinity && !(Number.isInteger(CAPACITY) && CAPACITY >= 1)) {
      throw new RangeError("FieldCache capacity must be a positive integer or Infinity.");
    }
    this.grid = grid;
    this.capacity = CAPACITY;
    this.#revision = grid.revision;
  }
  /** 담긴 개수. */
  get size() {
    this.#dropStale();
    return this.#fields.size;
  }
  has(key) {
    this.#dropStale();
    return this.#fields.has(key);
  }
  /** 키의 거리장, 없으면 `undefined`. 꺼내도 순서는 바뀌지 않습니다(LRU가 아님). */
  get(key) {
    this.#dropStale();
    return this.#fields.get(key);
  }
  /** 거리장을 담고 돌려줍니다. 용량이 차 있으면 가장 먼저 넣은 것을 버립니다. 있는 키를 덮어써도 순서는 그대로입니다. */
  set(key, field) {
    this.#dropStale();
    if (!this.#fields.has(key) && this.#fields.size >= this.capacity) {
      this.#fields.delete(this.#fields.keys().next().value);
    }
    this.#fields.set(key, field);
    return field;
  }
  clear() {
    this.#fields.clear();
  }
  /** 세대 번호(틱 등)를 알립니다. 지난번과 다르면 비우고 true를 돌려줍니다. 한 세대 안에서만 공유할 거리장에 씁니다. */
  sync(epoch) {
    if (epoch === this.#epoch) {
      return false;
    }
    this.#epoch = epoch;
    this.#fields.clear();
    return true;
  }
  #dropStale() {
    if (this.#revision !== this.grid.revision) {
      this.#revision = this.grid.revision;
      this.#fields.clear();
    }
  }
};

// modules/pathfield/route.js
var NO_PARENT = -1;
var MAX_STAMP = 4294967295;
var H_SCALE = 2 ** 26;
function octile(dx, dy) {
  return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
}
var RouteFinder = class {
  grid;
  /** 마지막 `find`의 결과: `'found'`, `'unreachable'`(닿을 수 없음), `'limit'`(확장 한도 초과). */
  status = "unreachable";
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
      throw new TypeError("RouteFinder needs a PathGrid.");
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
    const GRID = this.grid, COLS = GRID.cols, MAX_EXPANDED = options.maxExpanded ?? GRID.size;
    if (!Number.isInteger(start) || start < 0 || start >= GRID.size) {
      throw new RangeError(`RouteFinder start ${start} is not a cell of the grid.`);
    }
    if (!(MAX_EXPANDED >= 0)) {
      throw new RangeError("RouteFinder maxExpanded must be a non-negative number.");
    }
    const STAMP = this.#nextStamp(), GOAL = this.#goal;
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (let i = 0; i < goals.length; i++) {
      const CELL = goals[i];
      if (!Number.isInteger(CELL) || CELL < 0 || CELL >= GRID.size) {
        throw new RangeError(`RouteFinder goal ${CELL} is not a cell of the grid.`);
      }
      GOAL[CELL] = STAMP;
      const COL = CELL % COLS, ROW = (CELL - COL) / COLS;
      minCol = Math.min(minCol, COL);
      maxCol = Math.max(maxCol, COL);
      minRow = Math.min(minRow, ROW);
      maxRow = Math.max(maxRow, ROW);
    }
    this.cost = -1;
    this.expanded = 0;
    this.#heapSize = 0;
    if (!goals.length || !GRID.isOpen(start)) {
      this.status = "unreachable";
      return null;
    }
    const SEEN = this.#seen, CLOSED = this.#closed, G = this.#g, H = this.#h, KEY = this.#key, PARENT = this.#parent;
    const HEURISTIC = (col, row) => octile(
      col < minCol ? minCol - col : col > maxCol ? col - maxCol : 0,
      row < minRow ? minRow - row : row > maxRow ? row - maxRow : 0
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
        this.status = "found";
        this.cost = G[CELL];
        for (let cell = CELL; cell !== NO_PARENT; cell = PARENT[cell]) {
          out.push(cell);
        }
        out.reverse();
        return out;
      }
      if (this.expanded >= MAX_EXPANDED) {
        this.status = "limit";
        return null;
      }
      CLOSED[CELL] = STAMP;
      this.expanded++;
      const COL = CELL % COLS, ROW = (CELL - COL) / COLS, COST = G[CELL];
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
    this.status = "unreachable";
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
    const GRID = this.grid, COLS = GRID.cols, LENGTH = cells.length;
    if (!LENGTH) {
      return out;
    }
    out.push(cells[0]);
    for (let i = 1; i < LENGTH - 1; i++) {
      const PREVIOUS = cells[i - 1], CELL = cells[i], NEXT = cells[i + 1];
      if (CELL % COLS - PREVIOUS % COLS !== NEXT % COLS - CELL % COLS || Math.floor(CELL / COLS) - Math.floor(PREVIOUS / COLS) !== Math.floor(NEXT / COLS) - Math.floor(CELL / COLS)) {
        out.push(CELL);
      }
    }
    if (LENGTH > 1) {
      out.push(cells[LENGTH - 1]);
    }
    if (lineClear === null || out.length < 3) {
      return out;
    }
    let kept = 1, anchor = out[0];
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
    const GRID = this.grid, LAST = waypoints.length - 1, REACH_SQUARED = reach * reach;
    let current = Math.max(0, Math.min(index, LAST));
    while (current < LAST) {
      const CELL = waypoints[current], DX = GRID.centerX(CELL) - x, DY = GRID.centerY(CELL) - y;
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
    if (typeof segmentClear !== "function") {
      throw new TypeError("RouteFinder remainingClear needs a segmentClear function.");
    }
    const GRID = this.grid, LAST = waypoints.length - 1;
    if (LAST < 0) {
      return false;
    }
    let fromX = x, fromY = y;
    for (let i = Math.max(0, Math.min(index, LAST)); i <= LAST; i++) {
      const TO_X = GRID.centerX(waypoints[i]), TO_Y = GRID.centerY(waypoints[i]);
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
    const HEAP = this.#heap, TOP = HEAP[0], LAST = HEAP[--this.#heapSize];
    if (this.#heapSize) {
      HEAP[0] = LAST;
      this.#heapIndex[LAST] = 0;
      this.#siftDown(0);
    }
    return TOP;
  }
  #siftUp(index) {
    const HEAP = this.#heap, HEAP_INDEX = this.#heapIndex, KEY = this.#key, CELL = HEAP[index], CELL_KEY = KEY[CELL];
    let i = index;
    while (i > 0) {
      const PARENT = i - 1 >> 1, PARENT_CELL = HEAP[PARENT], PARENT_KEY = KEY[PARENT_CELL];
      if (PARENT_KEY < CELL_KEY || PARENT_KEY === CELL_KEY && PARENT_CELL < CELL) {
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
    const HEAP = this.#heap, HEAP_INDEX = this.#heapIndex, KEY = this.#key, SIZE = this.#heapSize, CELL = HEAP[index], CELL_KEY = KEY[CELL];
    let i = index;
    for (; ; ) {
      let child = 2 * i + 1;
      if (child >= SIZE) {
        break;
      }
      if (child + 1 < SIZE) {
        const LEFT_KEY = KEY[HEAP[child]], RIGHT_KEY = KEY[HEAP[child + 1]];
        if (RIGHT_KEY < LEFT_KEY || RIGHT_KEY === LEFT_KEY && HEAP[child + 1] < HEAP[child]) {
          child++;
        }
      }
      const CHILD_KEY = KEY[HEAP[child]];
      if (CELL_KEY < CHILD_KEY || CELL_KEY === CHILD_KEY && CELL < HEAP[child]) {
        break;
      }
      HEAP[i] = HEAP[child];
      HEAP_INDEX[HEAP[child]] = i;
      i = child;
    }
    HEAP[i] = CELL;
    HEAP_INDEX[CELL] = i;
  }
};

// modules/pathfield/portal.js
var OPTIONS2 = ["chunkSize", "portalSpan", "goalCapacity"];
var MAX_CHUNK_SIZE = 64;
var NO_COMP = 65535;
var NO_EDGE = 65535;
var OPEN_BIT = 256;
var LOCAL_BITS = 12;
var LOCAL_MASK = (1 << LOCAL_BITS) - 1;
var EAST = 0;
var SOUTH = 1;
var SOUTH_EAST = 4;
var SOUTH_WEST = 5;
var NORTH_EAST = 7;
var STRAIGHT = 10;
var DIAGONAL = 14;
var BORDER_EAST = 0;
var BORDER_SOUTH = 1;
var BORDER_SOUTH_EAST = 2;
var BORDER_SOUTH_WEST = 3;
var BORDER_KINDS = 4;
function integerOption(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`PortalGraph ${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}
var PortalGraph = class {
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
      throw new TypeError("PortalGraph needs a PathGrid.");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("PortalGraph options must be an object.");
    }
    for (const KEY of Object.keys(options)) {
      if (!OPTIONS2.includes(KEY)) {
        throw new TypeError(`PortalGraph has an unknown option: ${KEY}`);
      }
    }
    this.grid = grid;
    this.chunkSize = integerOption(options.chunkSize ?? 16, "chunkSize", 2, MAX_CHUNK_SIZE);
    this.portalSpan = integerOption(options.portalSpan ?? 4, "portalSpan", 1, this.chunkSize);
    this.goalCapacity = integerOption(options.goalCapacity ?? 64, "goalCapacity", 1, 65535);
    const SIZE = this.chunkSize;
    this.chunkCols = Math.ceil(grid.cols / SIZE);
    this.chunkRows = Math.ceil(grid.rows / SIZE);
    this.chunkCount = this.chunkCols * this.chunkRows;
    this.#cellsPerChunk = SIZE * SIZE;
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
    const COLS = this.grid.cols, COL = cell % COLS, ROW = (cell - COL) / COLS;
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
      throw new RangeError("PortalGraph.chunkNode index is out of range.");
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
      throw new RangeError("PortalGraph.edgeCost index is out of range.");
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
    const SIZE = this.chunkSize, GRID = this.grid, CHANGE = this.#change, RECTS = this.#rects;
    CHANGE.fill(0);
    for (let i = 0; i < count * 4; i += 4) {
      const COL0 = Math.max(0, RECTS[i] - 1), ROW0 = Math.max(0, RECTS[i + 1] - 1), COL1 = Math.min(GRID.cols - 1, RECTS[i + 2] + 1), ROW1 = Math.min(GRID.rows - 1, RECTS[i + 3] + 1);
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
    const COL = chunk % this.chunkCols, ROW = (chunk - COL) / this.chunkCols, LAST_COL = COL === this.chunkCols - 1, LAST_ROW = ROW === this.chunkRows - 1;
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
    const NEXT = this.#borderNeighbor(chunk, kind), CHANGE = this.#change;
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
    const GRID = this.grid, COLS = GRID.cols, SIZE = this.chunkSize, COMP = this.#cellComp, MASK = this.#stepMask, STACK = this.#stack, CHUNK_COL = chunk % this.chunkCols, COL0 = CHUNK_COL * SIZE, ROW0 = (chunk - CHUNK_COL) / this.chunkCols * SIZE, COL1 = Math.min(COLS, COL0 + SIZE) - 1, ROW1 = Math.min(GRID.rows, ROW0 + SIZE) - 1;
    for (let row = ROW0; row <= ROW1; row++) {
      COMP.fill(NO_COMP, row * COLS + COL0, row * COLS + COL1 + 1);
    }
    for (let row = ROW0; row <= ROW1; row++) {
      for (let col = COL0; col <= COL1; col++) {
        const CELL = row * COLS + col;
        let mask = 0;
        if (GRID.isOpen(CELL)) {
          for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
            const NEXT_COL = col + DIRECTION_DX[direction], NEXT_ROW = row + DIRECTION_DY[direction];
            if (NEXT_COL >= COL0 && NEXT_COL <= COL1 && NEXT_ROW >= ROW0 && NEXT_ROW <= ROW1 && GRID.stepCell(col, row, direction) >= 0) {
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
          const CELL = STACK[--top], BITS = MASK[CELL];
          for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
            if (!(BITS & 1 << direction)) {
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
    const OFFSET = kind === BORDER_EAST ? 0 : kind === BORDER_SOUTH ? this.#borderCap : this.#borderCap * 2 + kind - 2;
    return chunk * this.#portalStride + OFFSET;
  }
  /**
   * 청크가 소유한 경계 하나의 포털을 다시 놓습니다. 변: 직선 걸음이 통과되고 양쪽 성분이 같은 연속 구간을 `portalSpan`칸씩
   * 쪼개 조각마다 중앙 칸(짝수 길이는 앞쪽)을 노드로 둡니다. 그 뒤 변을 따라 대각 걸음을 보며, 직선 포털로 아직 이어지지 않은
   * (성분, 성분) 쌍만 첫 대각 걸음 하나를 단칸 포털(비용 14)로 둡니다. 모서리: 대각 걸음 하나가 통과되면 포털 하나.
   */
  #scanBorder(chunk, kind) {
    const GRID = this.grid, COLS = GRID.cols, SIZE = this.chunkSize, COMP = this.#cellComp, CHUNK_COL = chunk % this.chunkCols, COL0 = CHUNK_COL * SIZE, ROW0 = (chunk - CHUNK_COL) / this.chunkCols * SIZE, COL1 = Math.min(COLS, COL0 + SIZE) - 1, ROW1 = Math.min(GRID.rows, ROW0 + SIZE) - 1;
    this.#borderPortals[chunk * BORDER_KINDS + kind] = 0;
    if (this.#borderNeighbor(chunk, kind) < 0) {
      return;
    }
    if (kind === BORDER_SOUTH_EAST || kind === BORDER_SOUTH_WEST) {
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
    const EAST_SIDE = kind === BORDER_EAST, FIRST = EAST_SIDE ? ROW0 : COL0, LAST = EAST_SIDE ? ROW1 : COL1, SPAN = this.portalSpan, STEP = EAST_SIDE ? 1 : COLS, PAIRS = this.#pairs;
    let pairCount = 0, runStart = -1, runA = -1, runB = -1;
    for (let t = FIRST; t <= LAST + 1; t++) {
      let compA = -1, compB = -1;
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
          const MIDDLE = piece + (Math.min(SPAN, t - piece) - 1 >> 1), CENTER = EAST_SIDE ? MIDDLE * COLS + COL1 : ROW1 * COLS + MIDDLE;
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
    for (let t = FIRST; t <= LAST; t++) {
      const CELL = EAST_SIDE ? t * COLS + COL1 : ROW1 * COLS + t, CELL_COL = CELL % COLS, CELL_ROW = (CELL - CELL_COL) / COLS;
      if (COMP[CELL] === NO_COMP) {
        continue;
      }
      for (let side = 0; side < 2; side++) {
        if (side === 0 && t === LAST || side === 1 && t === FIRST) {
          continue;
        }
        const DIRECTION = side === 0 ? SOUTH_EAST : EAST_SIDE ? NORTH_EAST : SOUTH_WEST, NEXT = GRID.stepCell(CELL_COL, CELL_ROW, DIRECTION);
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
    const COL = chunk % this.chunkCols, ROW = (chunk - COL) / this.chunkCols, CC = this.chunkCols;
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
    for (let kind = 0; kind < BORDER_KINDS; kind++) {
      const BASE = this.#portalBase(chunk, kind), END = BASE + (kind < BORDER_SOUTH_EAST ? this.#borderCap : 1);
      for (let portal = BASE + this.#borderPortals[chunk * BORDER_KINDS + kind]; portal < END; portal++) {
        this.#nodeChunk[portal * 2] = -1;
        this.#nodeChunk[portal * 2 + 1] = -1;
      }
    }
    if (this.#listChanged || count !== this.#chunkNodeCount[chunk] || this.#change[chunk] === 2) {
      this.#matrixReady[chunk] = 0;
    }
    this.#chunkNodeCount[chunk] = count;
  }
  // 경계 하나의 한쪽 노드들을 청크 노드 목록 뒤에 붙이고 새 개수를 돌려줍니다.
  #take(chunk, count, owner, kind, side) {
    const BASE = this.#portalBase(owner, kind), PORTALS = this.#borderPortals[owner * BORDER_KINDS + kind];
    for (let i = 0; i < PORTALS; i++) {
      const NODE = (BASE + i) * 2 + side, AT = chunk * this.#chunkNodeCap + count;
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
    const PARENT = this.#compParent, LABEL = this.#compLabel, PER = this.#cellsPerChunk;
    for (let chunk = 0; chunk < this.chunkCount; chunk++) {
      for (let comp = 0; comp < this.#compCount[chunk]; comp++) {
        PARENT[chunk * PER + comp] = chunk * PER + comp;
      }
    }
    for (let chunk = 0; chunk < this.chunkCount; chunk++) {
      for (let kind = 0; kind < BORDER_KINDS; kind++) {
        const BASE = this.#portalBase(chunk, kind), PORTALS = this.#borderPortals[chunk * BORDER_KINDS + kind];
        for (let portal = BASE; portal < BASE + PORTALS; portal++) {
          const ROOT_A = this.#find(this.#compKey(this.#nodeCell[portal * 2])), ROOT_B = this.#find(this.#compKey(this.#nodeCell[portal * 2 + 1]));
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
        const KEY = chunk * PER + comp, ROOT = this.#find(KEY);
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
    const GRID = this.grid, COLS = GRID.cols, SIZE = this.chunkSize, COUNT = this.#chunkNodeCount[chunk], NODES = this.#chunkNodes, NODE_CELL = this.#nodeCell, NODE_BASE = chunk * this.#chunkNodeCap, COMP = this.#cellComp, MASK = this.#stepMask, DIST = this.#localDist, CELL_OF = this.#localCells, TARGET = this.#targets, HEAP = this.#heap, CHUNK_COL = chunk % this.chunkCols, COL0 = CHUNK_COL * SIZE, ROW0 = (chunk - CHUNK_COL) / this.chunkCols * SIZE, WIDTH = Math.min(COLS, COL0 + SIZE) - COL0, HEIGHT = Math.min(GRID.rows, ROW0 + SIZE) - ROW0;
    let matrix = this.#matrix[chunk];
    if (matrix === null || matrix.length < COUNT * COUNT) {
      matrix = this.#matrix[chunk] = new Uint16Array(Math.max(COUNT * COUNT, 1));
    }
    for (let row = 0; row < HEIGHT; row++) {
      for (let col = 0; col < WIDTH; col++) {
        CELL_OF[row * SIZE + col] = (ROW0 + row) * COLS + COL0 + col;
      }
    }
    for (let from = 0; from < COUNT; from++) {
      matrix[from * COUNT + from] = 0;
      const FROM_CELL = NODE_CELL[NODES[NODE_BASE + from]], FROM_COMP = COMP[FROM_CELL];
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
        const TOP = HEAP[0], LAST = HEAP[--size];
        if (size) {
          let at = 0;
          for (; ; ) {
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
        const AT = TOP & LOCAL_MASK, COST = TOP >>> LOCAL_BITS;
        if (COST !== DIST[AT]) {
          continue;
        }
        if (TARGET[AT]) {
          remaining -= TARGET[AT];
          TARGET[AT] = 0;
        }
        const BITS = MASK[CELL_OF[AT]];
        for (let direction = 0; direction < DIRECTION_COUNT; direction++) {
          if (!(BITS & 1 << direction)) {
            continue;
          }
          const NEXT_AT = AT + DIRECTION_DX[direction] + DIRECTION_DY[direction] * SIZE, NEXT_COST = COST + (direction < 4 ? STRAIGHT : DIAGONAL);
          if (DIST[NEXT_AT] >= 0 && DIST[NEXT_AT] <= NEXT_COST) {
            continue;
          }
          DIST[NEXT_AT] = NEXT_COST;
          let at = size++;
          const KEY = NEXT_COST << LOCAL_BITS | NEXT_AT;
          while (at > 0) {
            const PARENT = at - 1 >> 1;
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
        const CELL = NODE_CELL[NODES[NODE_BASE + to]], D = COMP[CELL] === FROM_COMP ? DIST[this.#localCell(CELL, COL0, ROW0)] : -1, VALUE = D < 0 ? NO_EDGE : D;
        matrix[from * COUNT + to] = VALUE;
        matrix[to * COUNT + from] = VALUE;
      }
    }
    this.#matrixReady[chunk] = 1;
    this.stats.matricesBuilt++;
  }
};
export {
  DIAGONAL_COST,
  DistanceField,
  FieldCache,
  MAX_CHANGED_RECTS,
  PathGrid,
  PortalGraph,
  RouteFinder,
  STRAIGHT_COST,
  UNREACHED
};
