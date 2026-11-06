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
      const CELL = STACK.pop(), COL = CELL % this.cols, ROW = (CELL - COL) / this.cols;
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
export {
  DIAGONAL_COST,
  DistanceField,
  FieldCache,
  PathGrid,
  STRAIGHT_COST,
  UNREACHED
};
