// modules/spatial/index.js
var NONE = -1;
var MODE_UNTRACKED = 0;
var MODE_INDEX = 1;
var MODE_IDENTITY = 2;
var MAX_CELL_COUNT = 1 << 24;
var MAX_ITEM_INDEX = (1 << 24) - 1;
var MAX_VIEWS = 30;
var EMPTY = Object.freeze([]);
var UNIFORM_OPTIONS = ["cellSize", "width", "height", "originX", "originY", "outside", "groups", "track"];
var BOUNDS_OPTIONS = ["cellSize", "width", "height", "originX", "originY", "maxCells", "views"];
function assertOptions(options, allowed, owner) {
  if (options === null || typeof options !== "object") {
    throw new TypeError(`${owner} options must be an object.`);
  }
  for (const KEY of Object.keys(options)) {
    if (!allowed.includes(KEY)) {
      throw new TypeError(`${owner} has an unknown option: ${KEY}`);
    }
  }
}
function positiveNumber(value, name, owner) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${owner} ${name} must be a positive finite number.`);
  }
  return value;
}
function finiteNumber(value, name, owner) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${owner} ${name} must be a finite number.`);
  }
  return value;
}
function integerInRange(value, name, min, max, owner) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${owner} ${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
function readLayout(options, owner) {
  const CELL_SIZE = positiveNumber(options.cellSize, "cellSize", owner), WIDTH = positiveNumber(options.width, "width", owner), HEIGHT = positiveNumber(options.height, "height", owner), ORIGIN_X = finiteNumber(options.originX ?? 0, "originX", owner), ORIGIN_Y = finiteNumber(options.originY ?? 0, "originY", owner), COLS = Math.ceil(WIDTH / CELL_SIZE), ROWS = Math.ceil(HEIGHT / CELL_SIZE);
  if (COLS * ROWS > MAX_CELL_COUNT) {
    throw new RangeError(`${owner} would need more than ${MAX_CELL_COUNT} cells; use a larger cellSize.`);
  }
  return {
    cellSize: CELL_SIZE,
    originX: ORIGIN_X,
    originY: ORIGIN_Y,
    cols: COLS,
    rows: ROWS
  };
}
function swapRemove(bucket, slot) {
  const LAST = bucket.pop();
  if (slot < bucket.length) {
    bucket[slot] = LAST;
    return LAST;
  }
  return void 0;
}
var UniformGrid = class {
  /** 칸 한 변의 크기(좌표와 같은 단위). */
  cellSize;
  /** 격자가 덮는 너비·높이(좌표 단위). 칸 수는 ceil(크기 / cellSize)입니다. */
  width;
  height;
  /** 칸 (0, 0)의 좌표 원점. */
  originX;
  originY;
  /** 칸 열·행의 수. */
  cols;
  rows;
  /** 총 칸 수(cols * rows). 칸 번호는 0..cellTotal-1이고, cellTotal은 세계 밖 보관 칸의 번호입니다. */
  cellTotal;
  /** 'clamp'(세계 밖은 가장자리 칸) 또는 'overflow'(세계 밖은 따로 보관). */
  outside;
  groups;
  track;
  #clamp;
  #plain;
  #indexed;
  #maxCol;
  #maxRow;
  #worldMaxX;
  #worldMaxY;
  #mode;
  #cells;
  #groupCells;
  #used = [];
  #touched;
  #cellOf = null;
  #slotOf = null;
  #groupOf = null;
  #groupSlotOf = null;
  #top = 0;
  #itemCells = null;
  #overflowX = [];
  #overflowY = [];
  // plain 격자(clamp·추적 없음·구분 없음)의 CSR 버킷: 넣은 순서의 (칸, 항목)을 모아 두고, 처음 읽을 때 칸별 개수 → 누적 →
  // 배치로 칸 순서 배열을 만듭니다(같은 칸 안은 넣은 순서 그대로).
  #plainKeys = null;
  #plainRaw = [];
  #plainItems = [];
  #plainStart = null;
  #plainCount = 0;
  #plainDirty = false;
  #cellScratch = [];
  /**
   * @param {object} options
   * @param {number} options.cellSize 칸 한 변의 크기(0보다 큰 유한 수)
   * @param {number} options.width 격자 너비
   * @param {number} options.height 격자 높이
   * @param {number} [options.originX=0] 칸 (0, 0)의 x 원점
   * @param {number} [options.originY=0] 칸 (0, 0)의 y 원점
   * @param {'clamp' | 'overflow'} options.outside 세계 밖 좌표 규약(필수)
   * @param {number} [options.groups=0] 항목 구분 수(0이면 구분 없음)
   * @param {false | 'index' | 'identity'} [options.track=false] 항목을 다시 찾는 방법
   */
  constructor(options) {
    assertOptions(options, UNIFORM_OPTIONS, "UniformGrid");
    const LAYOUT = readLayout(options, "UniformGrid");
    if (options.outside !== "clamp" && options.outside !== "overflow") {
      throw new TypeError("UniformGrid outside must be 'clamp' or 'overflow'.");
    }
    const GROUPS = integerInRange(options.groups ?? 0, "groups", 0, 256, "UniformGrid"), TRACK = options.track ?? false;
    if (TRACK !== false && TRACK !== "index" && TRACK !== "identity") {
      throw new TypeError("UniformGrid track must be false, 'index' or 'identity'.");
    }
    if (GROUPS > 0 && (options.outside === "overflow" || TRACK === "identity")) {
      throw new TypeError("UniformGrid groups need outside 'clamp' and track false or 'index'.");
    }
    this.cellSize = LAYOUT.cellSize;
    this.width = options.width;
    this.height = options.height;
    this.originX = LAYOUT.originX;
    this.originY = LAYOUT.originY;
    this.cols = LAYOUT.cols;
    this.rows = LAYOUT.rows;
    this.cellTotal = LAYOUT.cols * LAYOUT.rows;
    this.outside = options.outside;
    this.groups = GROUPS;
    this.track = TRACK;
    this.#clamp = options.outside === "clamp";
    this.#plain = this.#clamp && TRACK === false && GROUPS === 0;
    this.#indexed = this.#clamp && TRACK === "index";
    this.#maxCol = this.cols - 1;
    this.#maxRow = this.rows - 1;
    this.#worldMaxX = this.originX + this.cols * this.cellSize;
    this.#worldMaxY = this.originY + this.rows * this.cellSize;
    this.#mode = TRACK === "index" ? MODE_INDEX : TRACK === "identity" ? MODE_IDENTITY : MODE_UNTRACKED;
    this.#cells = new Array(this.cellTotal + 1);
    this.#touched = new Uint8Array(this.cellTotal + 1);
    this.#touched[this.cellTotal] = 1;
    this.#groupCells = Array.from({ length: GROUPS }, () => new Array(this.cellTotal + 1));
    if (this.#plain) {
      this.#plainKeys = new Int32Array(64);
      this.#plainStart = new Int32Array(this.cellTotal + 1);
    }
    if (this.#mode === MODE_INDEX) {
      this.#growIndex(64);
    } else if (this.#mode === MODE_IDENTITY) {
      this.#itemCells = /* @__PURE__ */ new Map();
    }
  }
  /** 항목이 들어갔던 칸의 번호(첫 사용 순, 세계 밖 보관 칸 제외)입니다. 읽기 전용이며 clear 때 비워집니다. */
  get usedCells() {
    return this.#used;
  }
  /** 담긴 항목을 모두 비웁니다. 사용한 칸만 비우고 버킷 배열은 재사용합니다. */
  clear() {
    if (this.#plain) {
      const USED2 = this.#used;
      for (let i = 0; i < USED2.length; i++) {
        this.#touched[USED2[i]] = 0;
      }
      USED2.length = 0;
      this.#plainCount = 0;
      this.#plainDirty = true;
      return;
    }
    const CELLS = this.#cells, USED = this.#used, GROUP_CELLS = this.#groupCells;
    for (let i = 0; i < USED.length; i++) {
      const KEY = USED[i];
      CELLS[KEY].length = 0;
      this.#touched[KEY] = 0;
      for (let g = 0; g < GROUP_CELLS.length; g++) {
        const BUCKET = GROUP_CELLS[g][KEY];
        if (BUCKET !== void 0) {
          BUCKET.length = 0;
        }
      }
    }
    USED.length = 0;
    const OVERFLOW = CELLS[this.cellTotal];
    if (OVERFLOW !== void 0) {
      OVERFLOW.length = 0;
    }
    this.#overflowX.length = 0;
    this.#overflowY.length = 0;
    if (this.#mode === MODE_INDEX) {
      this.#cellOf.fill(NONE, 0, this.#top);
      this.#top = 0;
    } else if (this.#mode === MODE_IDENTITY) {
      this.#itemCells.clear();
    }
  }
  /**
   * 좌표의 칸 열 번호입니다. 'clamp'이면 0..cols-1로 자르고, 'overflow'이면 자르지 않은 번호입니다
   * (세계 밖이면 음수이거나 cols 이상).
   */
  cellX(x) {
    const CELL = Math.floor((x - this.originX) / this.cellSize);
    return this.#clamp ? CELL <= 0 ? 0 : CELL > this.#maxCol ? this.#maxCol : CELL : CELL;
  }
  /** 좌표의 칸 행 번호입니다. cellX와 같은 규약입니다. */
  cellY(y) {
    const CELL = Math.floor((y - this.originY) / this.cellSize);
    return this.#clamp ? CELL <= 0 ? 0 : CELL > this.#maxRow ? this.#maxRow : CELL : CELL;
  }
  /**
   * 항목을 좌표의 칸 끝에 넣습니다. 추적하는 격자(track)에서 이미 있는 항목이면 먼저 빼고 다시 넣습니다.
   * @param {*} item track 'index'면 0 이상의 정수, 'identity'면 객체, false면 아무 값
   * @param {number} x
   * @param {number} y
   * @param {number} [group=0]
   */
  insert(item, x, y, group = 0) {
    if (this.#plain && group === 0) {
      this.#insertPlain(item, x, y);
    } else if (this.#indexed) {
      this.#insertIndexed(item, x, y, group);
    } else {
      this.#insertGeneral(item, x, y, group);
    }
  }
  #insertPlain(item, x, y) {
    const CX = Math.floor((x - this.originX) / this.cellSize), CY = Math.floor((y - this.originY) / this.cellSize);
    if (CX !== CX || CY !== CY) {
      throw new RangeError("UniformGrid coordinate must not be NaN.");
    }
    const KEY = (CY <= 0 ? 0 : CY > this.#maxRow ? this.#maxRow : CY) * this.cols + (CX <= 0 ? 0 : CX > this.#maxCol ? this.#maxCol : CX);
    if (this.#touched[KEY] === 0) {
      this.#touched[KEY] = 1;
      this.#used.push(KEY);
    }
    const COUNT = this.#plainCount;
    if (COUNT === this.#plainKeys.length) {
      const GROWN = new Int32Array(COUNT * 2);
      GROWN.set(this.#plainKeys);
      this.#plainKeys = GROWN;
    }
    this.#plainKeys[COUNT] = KEY;
    this.#plainRaw[COUNT] = item;
    this.#plainCount = COUNT + 1;
    this.#plainDirty = true;
  }
  // plain 격자의 칸 순서 배열을 다시 만듭니다(넣거나 비운 뒤 처음 읽을 때 한 번).
  #buildPlain() {
    this.#plainDirty = false;
    const START = this.#plainStart, KEYS = this.#plainKeys, RAW = this.#plainRaw, ITEMS = this.#plainItems, COUNT = this.#plainCount, TOTAL = this.cellTotal;
    START.fill(0);
    for (let i = 0; i < COUNT; i++) {
      START[KEYS[i] + 1]++;
    }
    for (let k = 1; k <= TOTAL; k++) {
      START[k] += START[k - 1];
    }
    for (let i = 0; i < COUNT; i++) {
      ITEMS[START[KEYS[i]]++] = RAW[i];
    }
    for (let k = TOTAL; k > 0; k--) {
      START[k] = START[k - 1];
    }
    START[0] = 0;
    ITEMS.length = COUNT;
  }
  // track 'index' + 'clamp'(구분 있거나 없거나)의 매 틱 재구축·추가 경로입니다.
  #insertIndexed(item, x, y, group) {
    if (group !== 0) {
      this.#assertGroup(group);
    }
    this.#reserve(item);
    if (this.#cellOf[item] !== NONE) {
      this.#detach(item);
    }
    const CX = Math.floor((x - this.originX) / this.cellSize), CY = Math.floor((y - this.originY) / this.cellSize);
    if (CX !== CX || CY !== CY) {
      throw new RangeError("UniformGrid coordinate must not be NaN.");
    }
    const KEY = (CY <= 0 ? 0 : CY > this.#maxRow ? this.#maxRow : CY) * this.cols + (CX <= 0 ? 0 : CX > this.#maxCol ? this.#maxCol : CX);
    let bucket = this.#cells[KEY];
    if (bucket === void 0) {
      bucket = this.#cells[KEY] = [];
    }
    if (this.#touched[KEY] === 0) {
      this.#touched[KEY] = 1;
      this.#used.push(KEY);
    }
    this.#cellOf[item] = KEY;
    this.#slotOf[item] = bucket.length;
    bucket.push(item);
    if (this.groups > 0) {
      let groupBucket = this.#groupCells[group][KEY];
      if (groupBucket === void 0) {
        groupBucket = this.#groupCells[group][KEY] = [];
      }
      this.#groupOf[item] = group;
      this.#groupSlotOf[item] = groupBucket.length;
      groupBucket.push(item);
    }
  }
  #insertGeneral(item, x, y, group) {
    if (group !== 0) {
      this.#assertGroup(group);
    }
    if (this.#mode === MODE_INDEX) {
      this.#reserve(item);
      if (this.#cellOf[item] !== NONE) {
        this.#detach(item);
      }
    } else if (this.#mode === MODE_IDENTITY && this.#itemCells.has(item)) {
      this.#detach(item);
    }
    this.#attach(item, this.#locate(x, y), x, y, group);
  }
  /**
   * 항목이 움직였을 때 칸이 바뀌면 옮깁니다(빼서 새 칸 끝에 넣음). 칸이 같으면 아무것도 하지 않습니다.
   * 없던 항목이면 insert와 같습니다. group을 생략하면 지금 구분을 유지합니다(없던 항목은 0).
   */
  move(item, x, y, group = NONE) {
    this.#assertTracked("move");
    const KEY = this.#locate(x, y);
    let previous;
    if (this.#mode === MODE_INDEX) {
      this.#reserve(item);
      previous = this.#cellOf[item];
    } else {
      const FOUND = this.#itemCells.get(item);
      previous = FOUND === void 0 ? NONE : FOUND;
    }
    if (previous === KEY && group < 0 && KEY !== this.cellTotal) {
      return;
    }
    let current = 0, target = 0;
    if (this.groups > 0) {
      current = previous === NONE ? 0 : this.#groupOf[item];
      target = group < 0 ? current : group;
      if (target !== current || previous === NONE) {
        this.#assertGroup(target);
      }
    } else if (group > 0) {
      this.#assertGroup(group);
    }
    if (previous === KEY && target === current) {
      if (KEY === this.cellTotal) {
        const SLOT = this.#mode === MODE_INDEX ? this.#slotOf[item] : this.#cells[KEY].indexOf(item);
        this.#overflowX[SLOT] = x;
        this.#overflowY[SLOT] = y;
      }
      return;
    }
    if (previous !== NONE) {
      this.#detach(item);
    }
    this.#attach(item, KEY, x, y, target);
  }
  /** 항목을 뺍니다. 마지막 항목이 그 자리로 옮겨 옵니다(swap-remove). 있었으면 true. */
  remove(item) {
    this.#assertTracked("remove");
    if (this.#keyOf(item) === NONE) {
      return false;
    }
    this.#detach(item);
    return true;
  }
  /** 항목이 격자에 있는지 알려 줍니다(세계 밖 보관 칸의 항목 포함). */
  has(item) {
    this.#assertTracked("has");
    return this.#keyOf(item) !== NONE;
  }
  /** 추적하는 격자에서 항목이 들어 있는 칸 번호(행 * cols + 열, 보관 칸이면 cellTotal)이고, 없으면 -1입니다. */
  keyOf(item) {
    this.#assertTracked("keyOf");
    return this.#keyOf(item);
  }
  /**
   * 좌표가 들어갈 칸 번호(행 * cols + 열)입니다. 'overflow' 격자에서 세계 밖이면 cellTotal입니다.
   * 'clamp' 격자는 NaN 좌표를 RangeError로 거부합니다.
   */
  keyAt(x, y) {
    return this.#locate(x, y);
  }
  /**
   * 사각형이 덮는 칸의 항목을 out에 채워 돌려줍니다(out은 먼저 비웁니다). 칸은 행 우선(y 바깥, x 안쪽)이고
   * 칸 안은 버킷 순서입니다. 'overflow' 격자는 그 뒤에 사각형 안에 있는 세계 밖 항목이 보관 순서로 붙습니다.
   * group이 0 이상이면 그 구분의 항목만 돌려줍니다(생략하면 전부).
   */
  queryRect(minX, minY, maxX, maxY, out, group = NONE) {
    out.length = 0;
    if (this.#plain && group < 0) {
      this.#collectPlain(this.cellX(minX), this.cellY(minY), this.cellX(maxX), this.cellY(maxY), out);
      return out;
    }
    const BUCKETS = this.#bucketsFor(group);
    if (this.#clamp) {
      this.#collectCells(BUCKETS, this.cellX(minX), this.cellY(minY), this.cellX(maxX), this.cellY(maxY), out);
      return out;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return out;
    }
    if (maxX >= this.originX && maxY >= this.originY && minX < this.#worldMaxX && minY < this.#worldMaxY) {
      this.#collectCells(
        BUCKETS,
        Math.max(0, this.cellX(minX)),
        Math.max(0, this.cellY(minY)),
        Math.min(this.#maxCol, this.cellX(maxX)),
        Math.min(this.#maxRow, this.cellY(maxY)),
        out
      );
    }
    this.#collectOverflow(minX, minY, maxX, maxY, out);
    return out;
  }
  /** 중심 (x, y) 반지름 radius 원의 외접 사각형 후보입니다. queryRect(x - r, y - r, x + r, y + r)와 같습니다. */
  queryCircle(x, y, radius, out, group = NONE) {
    return this.queryRect(x - radius, y - radius, x + radius, y + radius, out, group);
  }
  /**
   * 칸 번호의 버킷을 읽기 전용으로 돌려줍니다(없으면 빈 배열). 다음 변경 전까지만 유효합니다.
   * plain 격자(clamp·track 없음·groups 0)는 칸 순서 배열에서 공유 배열로 복사해 돌려주므로 다음 `cellItems` 호출 전까지만
   * 유효합니다. 모든 칸을 칸 순서로 훑으려면 {@link UniformGrid#itemsInCellOrder}가 더 쌉니다.
   */
  cellItems(key, group = NONE) {
    if (this.#plain && group < 0) {
      const OUT = this.#cellScratch;
      OUT.length = 0;
      this.#appendPlainCell(key, OUT);
      return OUT;
    }
    const BUCKET = this.#bucketsFor(group)[key];
    return BUCKET === void 0 ? EMPTY : BUCKET;
  }
  /**
   * 세계 안 칸(0..cellTotal-1)의 항목을 칸 번호 순서(같은 칸은 버킷 순서)로 `out`에 채웁니다(먼저 비움). 세계 밖 보관 칸의
   * 항목은 넣지 않습니다. 칸마다 `cellItems`를 부르는 것과 같은 순서입니다.
   */
  itemsInCellOrder(out) {
    out.length = 0;
    if (this.#plain) {
      if (this.#plainDirty) {
        this.#buildPlain();
      }
      const ITEMS = this.#plainItems;
      for (let i = 0; i < ITEMS.length; i++) {
        out.push(ITEMS[i]);
      }
      return out;
    }
    const CELLS = this.#cells;
    for (let key = 0; key < this.cellTotal; key++) {
      const BUCKET = CELLS[key];
      if (BUCKET !== void 0) {
        for (let i = 0; i < BUCKET.length; i++) {
          out.push(BUCKET[i]);
        }
      }
    }
    return out;
  }
  /**
   * 사각형이 덮는 칸 범위를 `out`(길이 4 이상의 정수 배열)에 [x0, y0, x1, y1]로 씁니다. 'clamp' 격자는 가장자리로 자르고,
   * 'overflow' 격자는 세계 안으로 자릅니다. 덮는 칸이 없으면(세계 밖 사각형·NaN) false입니다. 결과를 복사하지 않고 칸마다
   * `cellItems(y * cols + x)`를 직접 훑을 때 씁니다(세계 밖 보관 칸은 따로).
   */
  cellRange(minX, minY, maxX, maxY, out) {
    if (!this.#clamp && (!(Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) || !(maxX >= this.originX && maxY >= this.originY && minX < this.#worldMaxX && minY < this.#worldMaxY))) {
      return false;
    }
    out[0] = Math.max(0, this.cellX(minX));
    out[1] = Math.max(0, this.cellY(minY));
    out[2] = Math.min(this.#maxCol, this.cellX(maxX));
    out[3] = Math.min(this.#maxRow, this.cellY(maxY));
    return out[0] <= out[2] && out[1] <= out[3];
  }
  /** ring 칸 떨어진 고리의 칸 수입니다. ring 0은 중심 칸 하나이고 ring ≥ 1은 8 * ring칸입니다. */
  ringCellCount(ring) {
    return ring === 0 ? 1 : 8 * ring;
  }
  /**
   * 고리의 index번째 칸 번호를 돌려줍니다(격자 밖이면 -1). 순서는 첫 행·마지막 행을 열마다 번갈아(첫 행, 마지막 행) 가고,
   * 이어서 첫 열·마지막 열을 행마다 번갈아(첫 열, 마지막 열) 갑니다. queryCellRing과 같은 순서라 칸 단위로
   * 이어서 탐색(예산 분할)할 수 있습니다.
   */
  ringCell(centerX, centerY, ring, index) {
    let cellX = centerX, cellY = centerY;
    if (ring !== 0) {
      const EDGE_COUNT = 2 * (2 * ring + 1);
      if (index < EDGE_COUNT) {
        cellX = centerX - ring + Math.floor(index / 2);
        cellY = index % 2 === 0 ? centerY - ring : centerY + ring;
      } else {
        const INNER = index - EDGE_COUNT;
        cellX = INNER % 2 === 0 ? centerX - ring : centerX + ring;
        cellY = centerY - ring + 1 + Math.floor(INNER / 2);
      }
    }
    return cellX >= 0 && cellY >= 0 && cellX < this.cols && cellY < this.rows ? cellY * this.cols + cellX : NONE;
  }
  /**
   * 칸 (centerX, centerY)에서 ring 칸 떨어진 고리의 모든 칸 항목을 out에 채웁니다(ringCell 순서, 격자 밖
   * 칸은 건너뜀). ring 0은 중심 칸입니다. 세계 밖 보관 칸은 포함하지 않습니다.
   */
  queryCellRing(centerX, centerY, ring, out) {
    out.length = 0;
    const X0 = centerX - ring, X1 = centerX + ring, Y0 = centerY - ring, Y1 = centerY + ring;
    if (ring === 0) {
      this.#appendCell(centerX, centerY, out);
      return out;
    }
    for (let x = X0; x <= X1; x++) {
      this.#appendCell(x, Y0, out);
      this.#appendCell(x, Y1, out);
    }
    for (let y = Y0 + 1; y < Y1; y++) {
      this.#appendCell(X0, y, out);
      this.#appendCell(X1, y, out);
    }
    return out;
  }
  /**
   * 칸 (centerX, centerY)를 중심으로 ring 고리까지 덮은 칸 사각형의 바깥 칸에 있는 항목이 점 (x, y)에서
   * 가질 수 있는 최소 거리입니다(격자 가장자리에 닿은 쪽에는 바깥이 없어 제외, 바깥이 없으면 Infinity).
   * 지금까지 찾은 최근접 거리가 이 값보다 작으면 더 바깥 고리를 볼 필요가 없습니다.
   */
  distanceToOutsideRing(x, y, centerX, centerY, ring) {
    const LEFT = Math.max(0, centerX - ring), RIGHT = Math.min(this.#maxCol, centerX + ring), BOTTOM = Math.max(0, centerY - ring), TOP = Math.min(this.#maxRow, centerY + ring);
    let nearest = Infinity;
    if (LEFT > 0) {
      nearest = Math.min(nearest, x - (this.originX + LEFT * this.cellSize));
    }
    if (RIGHT < this.#maxCol) {
      nearest = Math.min(nearest, this.originX + (RIGHT + 1) * this.cellSize - x);
    }
    if (BOTTOM > 0) {
      nearest = Math.min(nearest, y - (this.originY + BOTTOM * this.cellSize));
    }
    if (TOP < this.#maxRow) {
      nearest = Math.min(nearest, this.originY + (TOP + 1) * this.cellSize - y);
    }
    return Math.max(0, nearest);
  }
  /**
   * 사각형 안의 칸을 (x, y)의 칸에서 고리 순서로 바깥으로 훑으며 항목마다 visit(item)을 부릅니다. visit은 지금까지
   * 찾은 최근접 거리를 돌려주고, k번째 고리가 (k - 1) * cellSize보다 멀어 그 거리를 이길 수 없으면 멈춥니다.
   * 이 중단은 항목이 중심 칸에 정확히 들어 있을 때만 맞습니다('overflow' 격자, 또는 항목이 세계 안에 있는
   * 'clamp' 격자). (x, y)가 사각형 밖이면 중단 없이 사각형 전체를 행 우선으로 한 번 훑습니다. 사각형 안의
   * 세계 밖 항목은 마지막에 보관 순서로 visit하며 그 반환값은 쓰지 않습니다. 훑는 동안 격자를 바꾸지 않습니다.
   */
  visitNearestFirst(x, y, minX, minY, maxX, maxY, visit) {
    if (!this.#clamp && (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY))) {
      return;
    }
    let best = Infinity;
    const PLAIN = this.#plain;
    if (PLAIN && this.#plainDirty) {
      this.#buildPlain();
    }
    const CELLS = this.#cells, COLS = this.cols, START = this.#plainStart, ITEMS = this.#plainItems;
    if (this.#clamp || maxX >= this.originX && maxY >= this.originY && minX < this.#worldMaxX && minY < this.#worldMaxY) {
      const X0 = Math.max(0, this.cellX(minX)), Y0 = Math.max(0, this.cellY(minY)), X1 = Math.min(this.#maxCol, this.cellX(maxX)), Y1 = Math.min(this.#maxRow, this.cellY(maxY)), CX = this.cellX(x), CY = this.cellY(y), INSIDE = CX >= X0 && CX <= X1 && CY >= Y0 && CY <= Y1, LAST = INSIDE ? Math.max(CX - X0, X1 - CX, CY - Y0, Y1 - CY) : 0;
      for (let ring = 0; ring <= LAST; ring++) {
        if (INSIDE && ring > 0 && best <= (ring - 1) * this.cellSize) {
          break;
        }
        const RING_Y0 = INSIDE ? Math.max(Y0, CY - ring) : Y0, RING_Y1 = INSIDE ? Math.min(Y1, CY + ring) : Y1;
        for (let cellY = RING_Y0; cellY <= RING_Y1; cellY++) {
          const ROW = cellY * COLS, EDGE = !INSIDE || Math.abs(cellY - CY) === ring, RING_X0 = INSIDE ? Math.max(X0, CX - ring) : X0, RING_X1 = INSIDE ? Math.min(X1, CX + ring) : X1, STEP = EDGE || ring === 0 ? 1 : 2 * ring;
          for (let cellX = EDGE ? RING_X0 : CX - ring; cellX <= RING_X1; cellX += STEP) {
            if (cellX < X0) {
              continue;
            }
            if (PLAIN) {
              const END = START[ROW + cellX + 1];
              for (let k = START[ROW + cellX]; k < END; k++) {
                best = visit(ITEMS[k]);
              }
              continue;
            }
            const BUCKET = CELLS[ROW + cellX];
            if (BUCKET !== void 0) {
              for (let i = 0; i < BUCKET.length; i++) {
                best = visit(BUCKET[i]);
              }
            }
          }
        }
      }
    }
    if (!this.#clamp) {
      const OVERFLOW = CELLS[this.cellTotal];
      if (OVERFLOW !== void 0) {
        for (let i = 0; i < OVERFLOW.length; i++) {
          if (this.#overflowX[i] >= minX && this.#overflowX[i] <= maxX && this.#overflowY[i] >= minY && this.#overflowY[i] <= maxY) {
            visit(OVERFLOW[i]);
          }
        }
      }
    }
  }
  #keyOf(item) {
    if (this.#mode === MODE_INDEX) {
      return (item | 0) === item && item >= 0 && item < this.#cellOf.length ? this.#cellOf[item] : NONE;
    }
    const KEY = this.#itemCells.get(item);
    return KEY === void 0 ? NONE : KEY;
  }
  #assertTracked(method) {
    if (this.#mode === MODE_UNTRACKED) {
      throw new TypeError(`UniformGrid.${method} needs the track option ('index' or 'identity').`);
    }
  }
  #bucketsFor(group) {
    if (group < 0) {
      return this.#cells;
    }
    const BUCKETS = this.#groupCells[group];
    if (BUCKETS === void 0) {
      throw new RangeError("UniformGrid group is out of range.");
    }
    return BUCKETS;
  }
  // 좌표가 들어갈 칸 번호입니다. 세계 밖('overflow')이면 보관 칸(cellTotal)입니다.
  #locate(x, y) {
    const CX = Math.floor((x - this.originX) / this.cellSize), CY = Math.floor((y - this.originY) / this.cellSize);
    if (this.#clamp) {
      if (CX !== CX || CY !== CY) {
        throw new RangeError("UniformGrid coordinate must not be NaN.");
      }
      const COL = CX <= 0 ? 0 : CX > this.#maxCol ? this.#maxCol : CX, ROW = CY <= 0 ? 0 : CY > this.#maxRow ? this.#maxRow : CY;
      return ROW * this.cols + COL;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return this.cellTotal;
    }
    return CX < 0 || CY < 0 || CX >= this.cols || CY >= this.rows ? this.cellTotal : CY * this.cols + CX;
  }
  #reserve(item) {
    if ((item | 0) !== item || item < 0 || item > MAX_ITEM_INDEX) {
      throw new RangeError(`UniformGrid track 'index' needs an integer item from 0 to ${MAX_ITEM_INDEX}.`);
    }
    if (item >= this.#top) {
      if (item >= this.#cellOf.length) {
        this.#growIndex(Math.max(item + 1, this.#cellOf.length * 2));
      }
      this.#top = item + 1;
    }
  }
  #assertGroup(group) {
    if (!Number.isInteger(group) || group < 0 || group >= this.groups) {
      throw new RangeError("UniformGrid group is out of range.");
    }
  }
  #growIndex(capacity) {
    const OLD_CELL_OF = this.#cellOf, OLD_SLOT_OF = this.#slotOf, OLD_GROUP_OF = this.#groupOf, OLD_GROUP_SLOT_OF = this.#groupSlotOf;
    this.#cellOf = new Int32Array(capacity).fill(NONE);
    this.#slotOf = new Int32Array(capacity);
    if (this.groups > 0) {
      this.#groupOf = new Int32Array(capacity);
      this.#groupSlotOf = new Int32Array(capacity);
    }
    if (OLD_CELL_OF !== null) {
      this.#cellOf.set(OLD_CELL_OF);
      this.#slotOf.set(OLD_SLOT_OF);
      if (OLD_GROUP_OF !== null) {
        this.#groupOf.set(OLD_GROUP_OF);
        this.#groupSlotOf.set(OLD_GROUP_SLOT_OF);
      }
    }
  }
  #attach(item, key, x, y, group) {
    let bucket = this.#cells[key];
    if (bucket === void 0) {
      bucket = this.#cells[key] = [];
    }
    if (this.#touched[key] === 0) {
      this.#touched[key] = 1;
      this.#used.push(key);
    }
    if (this.#mode === MODE_INDEX) {
      this.#cellOf[item] = key;
      this.#slotOf[item] = bucket.length;
    } else if (this.#mode === MODE_IDENTITY) {
      this.#itemCells.set(item, key);
    }
    bucket.push(item);
    if (this.groups > 0) {
      let groupBucket = this.#groupCells[group][key];
      if (groupBucket === void 0) {
        groupBucket = this.#groupCells[group][key] = [];
      }
      if (this.#mode === MODE_INDEX) {
        this.#groupOf[item] = group;
        this.#groupSlotOf[item] = groupBucket.length;
      }
      groupBucket.push(item);
    }
    if (key === this.cellTotal) {
      this.#overflowX.push(x);
      this.#overflowY.push(y);
    }
  }
  #detach(item) {
    let key, slot;
    if (this.#mode === MODE_INDEX) {
      key = this.#cellOf[item];
      slot = this.#slotOf[item];
      this.#cellOf[item] = NONE;
    } else {
      key = this.#itemCells.get(item);
      this.#itemCells.delete(item);
      slot = this.#cells[key].indexOf(item);
      if (slot < 0) {
        return;
      }
    }
    const BUCKET = this.#cells[key], MOVED = swapRemove(BUCKET, slot);
    if (MOVED !== void 0 && this.#mode === MODE_INDEX) {
      this.#slotOf[MOVED] = slot;
    }
    if (key === this.cellTotal) {
      this.#overflowX[slot] = this.#overflowX[this.#overflowX.length - 1];
      this.#overflowY[slot] = this.#overflowY[this.#overflowY.length - 1];
      this.#overflowX.pop();
      this.#overflowY.pop();
    }
    if (this.groups > 0) {
      const GROUP = this.#groupOf[item], GROUP_BUCKET = this.#groupCells[GROUP][key], GROUP_SLOT = this.#groupSlotOf[item], GROUP_MOVED = swapRemove(GROUP_BUCKET, GROUP_SLOT);
      if (GROUP_MOVED !== void 0) {
        this.#groupSlotOf[GROUP_MOVED] = GROUP_SLOT;
      }
    }
  }
  #collectCells(buckets, x0, y0, x1, y1, out) {
    const COLS = this.cols;
    for (let cy = y0; cy <= y1; cy++) {
      const ROW = cy * COLS;
      for (let cx = x0; cx <= x1; cx++) {
        const BUCKET = buckets[ROW + cx];
        if (BUCKET !== void 0) {
          for (let i = 0; i < BUCKET.length; i++) {
            out.push(BUCKET[i]);
          }
        }
      }
    }
  }
  #appendPlainCell(key, out) {
    if (this.#plainDirty) {
      this.#buildPlain();
    }
    if (!(key >= 0 && key < this.cellTotal)) {
      return;
    }
    const START = this.#plainStart, ITEMS = this.#plainItems, END = START[key + 1];
    for (let k = START[key]; k < END; k++) {
      out.push(ITEMS[k]);
    }
  }
  #collectPlain(x0, y0, x1, y1, out) {
    if (this.#plainDirty) {
      this.#buildPlain();
    }
    const COLS = this.cols, START = this.#plainStart, ITEMS = this.#plainItems;
    for (let cy = y0; cy <= y1; cy++) {
      const ROW = cy * COLS, END = START[ROW + x1 + 1];
      for (let k = START[ROW + x0]; k < END; k++) {
        out.push(ITEMS[k]);
      }
    }
  }
  #collectOverflow(minX, minY, maxX, maxY, out) {
    const OVERFLOW = this.#cells[this.cellTotal];
    if (OVERFLOW === void 0) {
      return;
    }
    for (let i = 0; i < OVERFLOW.length; i++) {
      const X = this.#overflowX[i], Y = this.#overflowY[i];
      if (X >= minX && X <= maxX && Y >= minY && Y <= maxY) {
        out.push(OVERFLOW[i]);
      }
    }
  }
  #appendCell(x, y, out) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) {
      return;
    }
    if (this.#plain) {
      this.#appendPlainCell(y * this.cols + x, out);
      return;
    }
    const BUCKET = this.#cells[y * this.cols + x];
    if (BUCKET !== void 0) {
      for (let i = 0; i < BUCKET.length; i++) {
        out.push(BUCKET[i]);
      }
    }
  }
};
var BoundsGrid = class {
  cellSize;
  width;
  height;
  originX;
  originY;
  cols;
  rows;
  cellTotal;
  maxCells;
  views;
  #maxCol;
  #maxRow;
  #cells;
  #viewCells;
  #used = [];
  #touched;
  #ordered = [];
  #viewOrdered;
  #overflow = [];
  #viewOverflow;
  #lists = [];
  #cursors;
  #capacity = 0;
  #minX = null;
  #minY = null;
  #maxX = null;
  #maxY = null;
  #rank = null;
  /**
   * @param {object} options
   * @param {number} options.cellSize 칸 한 변의 크기
   * @param {number} options.width 격자 너비
   * @param {number} options.height 격자 높이
   * @param {number} [options.originX=0]
   * @param {number} [options.originY=0]
   * @param {number} [options.maxCells=16] 항목 하나가 들어갈 수 있는 칸 수의 상한(넘으면 큰 항목 목록)
   * @param {number} [options.views=0] 일부 항목만 보는 부분 목록의 수(0..30)
   */
  constructor(options) {
    assertOptions(options, BOUNDS_OPTIONS, "BoundsGrid");
    const LAYOUT = readLayout(options, "BoundsGrid");
    this.maxCells = integerInRange(options.maxCells ?? 16, "maxCells", 1, 4096, "BoundsGrid");
    this.views = integerInRange(options.views ?? 0, "views", 0, MAX_VIEWS, "BoundsGrid");
    this.cellSize = LAYOUT.cellSize;
    this.width = options.width;
    this.height = options.height;
    this.originX = LAYOUT.originX;
    this.originY = LAYOUT.originY;
    this.cols = LAYOUT.cols;
    this.rows = LAYOUT.rows;
    this.cellTotal = LAYOUT.cols * LAYOUT.rows;
    this.#maxCol = this.cols - 1;
    this.#maxRow = this.rows - 1;
    this.#cells = new Array(this.cellTotal);
    this.#touched = new Uint8Array(this.cellTotal);
    this.#viewCells = Array.from({ length: this.views }, () => new Array(this.cellTotal));
    this.#viewOrdered = Array.from({ length: this.views }, () => []);
    this.#viewOverflow = Array.from({ length: this.views }, () => []);
    this.#cursors = new Int32Array(this.maxCells + 1);
  }
  /** 지금까지 넣은 항목 수입니다. */
  get size() {
    return this.#ordered.length;
  }
  /** 모두 비웁니다. 사용한 칸만 비우고 버킷 배열은 재사용합니다. */
  clear() {
    const USED = this.#used;
    for (let i = 0; i < USED.length; i++) {
      const KEY = USED[i];
      this.#cells[KEY].length = 0;
      this.#touched[KEY] = 0;
      for (let v = 0; v < this.views; v++) {
        const BUCKET = this.#viewCells[v][KEY];
        if (BUCKET !== void 0) {
          BUCKET.length = 0;
        }
      }
    }
    USED.length = 0;
    this.#ordered.length = 0;
    this.#overflow.length = 0;
    for (let v = 0; v < this.views; v++) {
      this.#viewOrdered[v].length = 0;
      this.#viewOverflow[v].length = 0;
    }
  }
  /**
   * 경계 상자 [minX, maxX] × [minY, maxY]를 가진 항목을 넣습니다. 넣은 순서가 질의 결과의 순서(rank)입니다.
   * @param {number} id 0 이상의 정수. 같은 clear 안에서 한 번만 넣습니다.
   * @param {number} viewMask 부분 목록 v에 속하면 비트 (1 << v)를 켠 값
   */
  insert(id, minX, minY, maxX, maxY, viewMask = 0) {
    if (id >= this.#capacity) {
      this.#grow(id);
    } else if (!(id >= 0) || !Number.isInteger(id)) {
      throw new RangeError("BoundsGrid id must be a non-negative integer.");
    }
    if (!(minX <= maxX && minY <= maxY)) {
      throw new RangeError("BoundsGrid bounds need min <= max and no NaN.");
    }
    this.#rank[id] = this.#ordered.length;
    this.#ordered.push(id);
    this.#minX[id] = minX;
    this.#minY[id] = minY;
    this.#maxX[id] = maxX;
    this.#maxY[id] = maxY;
    const VIEWS = this.views;
    for (let v = 0; v < VIEWS; v++) {
      if ((viewMask & 1 << v) !== 0) {
        this.#viewOrdered[v].push(id);
      }
    }
    const X0 = this.#cellX(minX), X1 = this.#cellX(maxX), Y0 = this.#cellY(minY), Y1 = this.#cellY(maxY);
    if ((X1 - X0 + 1) * (Y1 - Y0 + 1) > this.maxCells) {
      this.#overflow.push(id);
      for (let v = 0; v < VIEWS; v++) {
        if ((viewMask & 1 << v) !== 0) {
          this.#viewOverflow[v].push(id);
        }
      }
      return;
    }
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const KEY = y * this.cols + x;
        let bucket = this.#cells[KEY];
        if (bucket === void 0) {
          bucket = this.#cells[KEY] = [];
        }
        if (this.#touched[KEY] === 0) {
          this.#touched[KEY] = 1;
          this.#used.push(KEY);
        }
        bucket.push(id);
        for (let v = 0; v < VIEWS; v++) {
          if ((viewMask & 1 << v) !== 0) {
            let viewBucket = this.#viewCells[v][KEY];
            if (viewBucket === void 0) {
              viewBucket = this.#viewCells[v][KEY] = [];
            }
            viewBucket.push(id);
          }
        }
      }
    }
  }
  /**
   * 경계 상자가 주어진 상자와 겹치는(맞닿음 포함) 항목의 id를 삽입 순서로 중복 없이 out에 채웁니다.
   * view가 0 이상이면 그 부분 목록의 항목만 봅니다. afterId보다 큰 id만 돌려줍니다(쌍을 한 번씩 만들 때
   * `afterId = 자기 id`).
   */
  queryBounds(minX, minY, maxX, maxY, out, view = NONE, afterId = NONE) {
    out.length = 0;
    if (view >= this.views) {
      throw new RangeError("BoundsGrid view is out of range.");
    }
    const ORDERED = view < 0 ? this.#ordered : this.#viewOrdered[view], X0 = this.#cellX(minX), X1 = this.#cellX(maxX), Y0 = this.#cellY(minY), Y1 = this.#cellY(maxY);
    if ((X1 - X0 + 1) * (Y1 - Y0 + 1) > this.maxCells) {
      for (let k = 0; k < ORDERED.length; k++) {
        this.#accept(ORDERED[k], minX, minY, maxX, maxY, out, afterId);
      }
      return out;
    }
    const BUCKETS = view < 0 ? this.#cells : this.#viewCells[view], OVERFLOW = view < 0 ? this.#overflow : this.#viewOverflow[view], LISTS = this.#lists, CURSORS = this.#cursors, RANK = this.#rank;
    LISTS.length = 0;
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const BUCKET = BUCKETS[y * this.cols + x];
        if (BUCKET !== void 0 && BUCKET.length > 0) {
          LISTS.push(BUCKET);
        }
      }
    }
    if (OVERFLOW.length > 0) {
      LISTS.push(OVERFLOW);
    }
    CURSORS.fill(0, 0, LISTS.length);
    for (; ; ) {
      let next = -1, bestRank = Infinity;
      for (let k = 0; k < LISTS.length; k++) {
        const CURSOR = CURSORS[k];
        if (CURSOR >= LISTS[k].length) {
          continue;
        }
        const ID = LISTS[k][CURSOR];
        if (RANK[ID] < bestRank) {
          bestRank = RANK[ID];
          next = ID;
        }
      }
      if (next < 0) {
        break;
      }
      for (let k = 0; k < LISTS.length; k++) {
        if (LISTS[k][CURSORS[k]] === next) {
          CURSORS[k]++;
        }
      }
      this.#accept(next, minX, minY, maxX, maxY, out, afterId);
    }
    return out;
  }
  /** 넣어 둔 id의 경계 상자와 겹치는 항목을 queryBounds와 같은 순서로 채웁니다(자기 자신 포함). */
  queryOverlaps(id, out, view = NONE, afterId = NONE) {
    return this.queryBounds(this.#minX[id], this.#minY[id], this.#maxX[id], this.#maxY[id], out, view, afterId);
  }
  #cellX(x) {
    const CELL = Math.floor((x - this.originX) / this.cellSize);
    return CELL <= 0 ? 0 : CELL > this.#maxCol ? this.#maxCol : CELL;
  }
  #cellY(y) {
    const CELL = Math.floor((y - this.originY) / this.cellSize);
    return CELL <= 0 ? 0 : CELL > this.#maxRow ? this.#maxRow : CELL;
  }
  #accept(id, minX, minY, maxX, maxY, out, afterId) {
    if (id <= afterId) {
      return;
    }
    if (maxX < this.#minX[id] || this.#maxX[id] < minX || maxY < this.#minY[id] || this.#maxY[id] < minY) {
      return;
    }
    out.push(id);
  }
  #grow(id) {
    if (!Number.isSafeInteger(id) || id < 0 || id > MAX_ITEM_INDEX) {
      throw new RangeError("BoundsGrid id must be a non-negative integer.");
    }
    const CAPACITY = Math.max(id + 1, this.#capacity * 2, 64), OLD = [this.#minX, this.#minY, this.#maxX, this.#maxY, this.#rank];
    this.#minX = new Float64Array(CAPACITY);
    this.#minY = new Float64Array(CAPACITY);
    this.#maxX = new Float64Array(CAPACITY);
    this.#maxY = new Float64Array(CAPACITY);
    this.#rank = new Int32Array(CAPACITY);
    if (OLD[0] !== null) {
      this.#minX.set(OLD[0]);
      this.#minY.set(OLD[1]);
      this.#maxX.set(OLD[2]);
      this.#maxY.set(OLD[3]);
      this.#rank.set(OLD[4]);
    }
    this.#capacity = CAPACITY;
  }
};
export {
  BoundsGrid,
  UniformGrid
};
