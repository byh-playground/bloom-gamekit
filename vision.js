// modules/vision/index.js
var MAX_CELL_COUNT = 1 << 24;
var MAX_RADIUS_CELLS = 256;
var MAP_OPTIONS = ["width", "height", "cellSize", "level", "blocked"];
var SAMPLE_OPTIONS = ["width", "height", "cellSize", "levelAt", "blockedAt"];
var LEVEL_MIN = -128;
var LEVEL_MAX = 127;
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
function isLevelArray(value) {
  return value instanceof Int8Array || value instanceof Uint8Array || value instanceof Int16Array || value instanceof Uint16Array || value instanceof Int32Array;
}
var offsetTable = null;
function offsetsFor(radius) {
  if (offsetTable !== null && offsetTable.radius >= radius) {
    return offsetTable;
  }
  const RADIUS = Math.min(MAX_RADIUS_CELLS, Math.max(radius, 2 * (offsetTable?.radius || 8))), SPAN = 2 * RADIUS + 1, SPAN2 = SPAN * SPAN, LIMIT = RADIUS * RADIUS;
  const KEYS = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const D2 = dx * dx + dy * dy;
      if (D2 <= LIMIT) {
        KEYS.push(D2 * SPAN2 + (dy + RADIUS) * SPAN + (dx + RADIUS));
      }
    }
  }
  const SORTED = Float64Array.from(KEYS).sort(), COUNT = SORTED.length, DX = new Int16Array(COUNT), DY = new Int16Array(COUNT), D2S = new Int32Array(COUNT), PARENT = new Int32Array(COUNT), AT = new Int32Array(SPAN2);
  for (let i = 0; i < COUNT; i++) {
    const D2 = Math.floor(SORTED[i] / SPAN2), CELL = SORTED[i] - D2 * SPAN2;
    D2S[i] = D2;
    DY[i] = Math.floor(CELL / SPAN) - RADIUS;
    DX[i] = CELL % SPAN - RADIUS;
    AT[CELL] = i;
  }
  for (let i = 0; i < COUNT; i++) {
    const X = DX[i], Y = DY[i], AX = Math.abs(X), AY = Math.abs(Y);
    if (AX === 0 && AY === 0) {
      PARENT[i] = -1;
      continue;
    }
    let px, py;
    if (AX >= AY) {
      px = X - Math.sign(X);
      py = Math.sign(Y) * Math.round(AY * (AX - 1) / AX);
    } else {
      py = Y - Math.sign(Y);
      px = Math.sign(X) * Math.round(AX * (AY - 1) / AY);
    }
    PARENT[i] = AT[(py + RADIUS) * SPAN + px + RADIUS];
  }
  offsetTable = { radius: RADIUS, dx: DX, dy: DY, d2: D2S, parent: PARENT };
  return offsetTable;
}
function assertObserver(observer, maxRadius) {
  if (observer === null || typeof observer !== "object") {
    throw new TypeError("VisionField observer must be an object.");
  }
  const { x: X, y: Y, radius: RADIUS } = observer;
  if (typeof X !== "number" || typeof Y !== "number" || !Number.isFinite(X) || !Number.isFinite(Y)) {
    throw new RangeError("VisionField observer x and y must be finite numbers.");
  }
  if (typeof RADIUS !== "number" || !(RADIUS >= 0) || !(RADIUS <= maxRadius)) {
    throw new RangeError(
      `VisionField observer radius must be a number from 0 to ${maxRadius} (${MAX_RADIUS_CELLS} cells).`
    );
  }
  if (observer.xray !== true && (typeof observer.level !== "number" || Number.isNaN(observer.level))) {
    throw new TypeError("VisionField observer level must be a number (or set xray).");
  }
  if (observer.id === void 0) {
    throw new TypeError("VisionField observer needs an id.");
  }
}
var VisionMap = class _VisionMap {
  /** 래스터가 덮는 월드의 너비·높이(좌표 단위). */
  width;
  height;
  /** 칸 한 변(좌표 단위). 열·행 수는 ceil(크기 / cellSize)입니다. */
  cellSize;
  cols;
  rows;
  /** 칸 높이 층. 칸 번호(`row * cols + col`) 순서의 정수 typed array. 만든 뒤 쓰기 금지. */
  level;
  /** 막힌 칸(0이 아니면 막힘). 칸 번호 순서의 Uint8Array. 만든 뒤 쓰기 금지. */
  blocked;
  #maxCol;
  #maxRow;
  /**
   * 이미 가진 래스터를 그대로 받습니다(복사하지 않습니다).
   * @param {object} options
   * @param {number} options.width 월드 너비
   * @param {number} options.height 월드 높이
   * @param {number} options.cellSize 칸 한 변의 크기(0보다 큰 유한 수)
   * @param {Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array} options.level 칸마다 높이 층, 길이 cols * rows
   * @param {Uint8Array} [options.blocked] 칸마다 막힘 여부, 길이 cols * rows(생략하면 막힌 칸 없음)
   */
  constructor(options) {
    assertOptions(options, MAP_OPTIONS, "VisionMap");
    this.width = positiveNumber(options.width, "width", "VisionMap");
    this.height = positiveNumber(options.height, "height", "VisionMap");
    this.cellSize = positiveNumber(options.cellSize, "cellSize", "VisionMap");
    this.cols = Math.ceil(this.width / this.cellSize);
    this.rows = Math.ceil(this.height / this.cellSize);
    const SIZE = this.cols * this.rows;
    if (SIZE > MAX_CELL_COUNT) {
      throw new RangeError(`VisionMap would need more than ${MAX_CELL_COUNT} cells; use a larger cellSize.`);
    }
    if (!isLevelArray(options.level) || options.level.length !== SIZE) {
      throw new TypeError(`VisionMap level must be an integer typed array of cols * rows (${SIZE}) cells.`);
    }
    if (options.blocked !== void 0 && (!(options.blocked instanceof Uint8Array) || options.blocked.length !== SIZE)) {
      throw new TypeError(`VisionMap blocked must be a Uint8Array of cols * rows (${SIZE}) cells.`);
    }
    this.level = options.level;
    this.blocked = options.blocked ?? new Uint8Array(SIZE);
    this.#maxCol = this.cols - 1;
    this.#maxRow = this.rows - 1;
    Object.freeze(this);
  }
  /**
   * 연속 좌표의 지형에서 칸 중심을 표집해 래스터를 만듭니다. 칸 중심이 월드 밖(마지막 칸이 걸친 경우)이면 월드
   * 가장자리 좌표를 씁니다. `levelAt`은 -128..127의 정수를 돌려줘야 합니다.
   * @param {object} options
   * @param {number} options.width 월드 너비
   * @param {number} options.height 월드 높이
   * @param {number} options.cellSize 칸 한 변의 크기
   * @param {(x: number, y: number) => number} options.levelAt 좌표의 높이 층
   * @param {(x: number, y: number) => boolean} [options.blockedAt] 좌표가 막힌 곳인지(생략하면 막힌 곳 없음)
   */
  static sample(options) {
    assertOptions(options, SAMPLE_OPTIONS, "VisionMap.sample");
    if (typeof options.levelAt !== "function" || options.blockedAt !== void 0 && typeof options.blockedAt !== "function") {
      throw new TypeError(
        "VisionMap.sample levelAt must be a function and blockedAt must be a function or omitted."
      );
    }
    const WIDTH = positiveNumber(options.width, "width", "VisionMap.sample"), HEIGHT = positiveNumber(options.height, "height", "VisionMap.sample"), CELL_SIZE = positiveNumber(options.cellSize, "cellSize", "VisionMap.sample"), COLS = Math.ceil(WIDTH / CELL_SIZE), ROWS = Math.ceil(HEIGHT / CELL_SIZE);
    if (COLS * ROWS > MAX_CELL_COUNT) {
      throw new RangeError(`VisionMap would need more than ${MAX_CELL_COUNT} cells; use a larger cellSize.`);
    }
    const LEVEL = new Int8Array(COLS * ROWS), BLOCKED = new Uint8Array(COLS * ROWS);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const X = Math.min(WIDTH, (col + 0.5) * CELL_SIZE), Y = Math.min(HEIGHT, (row + 0.5) * CELL_SIZE), CELL = row * COLS + col, LEVEL_HERE = options.levelAt(X, Y);
        if (!Number.isInteger(LEVEL_HERE) || LEVEL_HERE < LEVEL_MIN || LEVEL_HERE > LEVEL_MAX) {
          throw new RangeError(`VisionMap.sample levelAt(${X}, ${Y}) must be an integer from -128 to 127.`);
        }
        LEVEL[CELL] = LEVEL_HERE;
        BLOCKED[CELL] = options.blockedAt?.(X, Y) ? 1 : 0;
      }
    }
    return new _VisionMap({ width: WIDTH, height: HEIGHT, cellSize: CELL_SIZE, level: LEVEL, blocked: BLOCKED });
  }
  /** 좌표의 칸 번호(`row * cols + col`). 월드 밖은 가장자리 칸이고, NaN은 NaN입니다. */
  cellAt(x, y) {
    let col = Math.floor(x / this.cellSize), row = Math.floor(y / this.cellSize);
    col = col < 0 ? 0 : col > this.#maxCol ? this.#maxCol : col;
    row = row < 0 ? 0 : row > this.#maxRow ? this.#maxRow : row;
    return row * this.cols + col;
  }
};
var VisionField = class {
  /** 이 격자가 보는 지형. */
  map;
  #revision = 0;
  #any;
  #layers = [];
  #records = /* @__PURE__ */ new Map();
  #epoch = 0;
  #pass = new Uint8Array(0);
  #scratch = new Int32Array(0);
  /** @param {VisionMap} map 팀들이 공유하는 지형 래스터 */
  constructor(map) {
    if (!(map instanceof VisionMap)) {
      throw new TypeError("VisionField needs a VisionMap.");
    }
    this.map = map;
    this.#any = new Uint16Array(map.cols * map.rows);
  }
  /** 칸이 비춰지거나 지워질 때마다 1 늘어납니다. 안개 텍스처 같은 파생 결과의 재생성 기준입니다. */
  get revision() {
    return this.#revision;
  }
  /**
   * 관찰자 전체를 새 목록으로 바꿉니다. 이전 목록에 있던 `id`가 같고 칸·반경·높이 층·`xray`가 그대로면
   * 다시 칠하지 않습니다. 같은 `id`가 한 목록에 여러 번 있어도 각각 따로 셉니다. 목록을 먼저 모두 검사하므로
   * 잘못된 관찰자가 하나라도 있으면 던지고 격자는 그대로입니다.
   * @param {readonly {id: string | number, x: number, y: number, radius: number, level: number, xray?: boolean}[]} observers
   *   `radius`는 비추는 거리(좌표 단위, 0이면 아무것도 비추지 않음). `level`은 관찰자의 높이 층.
   *   `xray`가 true면 막힌 칸과 높이를 모두 무시하고 반경 안의 모든 칸을 모든 높이에서 봅니다(`level`은 무시).
   * @returns {VisionField} this
   */
  update(observers) {
    const MAP = this.map, MAX_RADIUS = MAX_RADIUS_CELLS * MAP.cellSize;
    if (!Array.isArray(observers)) {
      throw new TypeError("VisionField.update needs an array of observers.");
    }
    for (const OBSERVER of observers) {
      assertObserver(OBSERVER, MAX_RADIUS);
    }
    const EPOCH = ++this.#epoch;
    let changed = false;
    for (const OBSERVER of observers) {
      const X = OBSERVER.x, Y = OBSERVER.y, RADIUS = OBSERVER.radius, XRAY = OBSERVER.xray === true;
      const LEVEL = XRAY ? 0 : OBSERVER.level, CELL = MAP.cellAt(X, Y);
      let id = OBSERVER.id, record = this.#records.get(id);
      for (let n = 1; record !== void 0 && record.epoch === EPOCH; n++) {
        id = `${OBSERVER.id}#${n}`;
        record = this.#records.get(id);
      }
      if (record !== void 0 && record.cell === CELL && record.radius === RADIUS && record.xray === XRAY && record.level === LEVEL) {
        record.epoch = EPOCH;
        continue;
      }
      if (record !== void 0) {
        this.#apply(record, -1);
      }
      const NEXT = this.#paint(CELL, RADIUS, LEVEL, XRAY);
      NEXT.epoch = EPOCH;
      this.#records.set(id, NEXT);
      this.#apply(NEXT, 1);
      changed = true;
    }
    for (const [ID, RECORD] of this.#records) {
      if (RECORD.epoch !== EPOCH) {
        this.#apply(RECORD, -1);
        this.#records.delete(ID);
        changed = true;
      }
    }
    if (changed) {
      this.#revision++;
    }
    return this;
  }
  /**
   * 높이 층 `targetLevel`에 있는 대상이 (x, y)에서 보이는지. 그 칸을 비추는 관찰자 중 한 명이라도 높이 상한(자기
   * 높이 층, `xray`는 무한대)이 `targetLevel` 이상이면 보입니다. 월드 밖 좌표는 가장자리 칸을 읽습니다.
   */
  visibleAt(x, y, targetLevel) {
    if (typeof targetLevel !== "number") {
      throw new TypeError("VisionField.visibleAt needs a numeric targetLevel.");
    }
    const CELL = this.map.cellAt(x, y);
    if (!this.#any[CELL]) {
      return false;
    }
    for (const LAYER of this.#layers) {
      if (LAYER.ceiling >= targetLevel && LAYER.counts[CELL]) {
        return true;
      }
    }
    return false;
  }
  /**
   * (x, y)를 비추는 관찰자 중 가장 높은 높이 상한. 비추는 관찰자가 없으면 -Infinity, `xray`가 비추면 Infinity.
   * 높이 층 L을 보는 마스크는 `ceilingAt(x, y) >= L`입니다.
   */
  ceilingAt(x, y) {
    const CELL = this.map.cellAt(x, y);
    if (!this.#any[CELL]) {
      return -Infinity;
    }
    let best = -Infinity;
    for (const LAYER of this.#layers) {
      if (LAYER.counts[CELL] && LAYER.ceiling > best) {
        best = LAYER.ceiling;
      }
    }
    return best;
  }
  // 원점 칸에서 반경 안 칸을 가까운 순으로 걸으며, 부모 칸이 통과한 칸만 봅니다.
  //  보임 = 막히지 않았고(원점 칸 자체도) 원점이 아니면 관찰자보다 높지 않은 칸. xray는 모두 보임.
  //  통과 = 보임. 보이지 않는 칸에서 길이 끊깁니다.
  #paint(origin, radius, level, xray) {
    const { cols: COLS, rows: ROWS, level: LEVELS, blocked: BLOCKED, cellSize: CELL_SIZE } = this.map, REACH = radius / CELL_SIZE, REACH2 = REACH * REACH, TABLE = offsetsFor(Math.ceil(REACH));
    if (this.#pass.length < TABLE.d2.length) {
      this.#pass = new Uint8Array(TABLE.d2.length);
      this.#scratch = new Int32Array(TABLE.d2.length);
    }
    const PASS = this.#pass, CELLS = this.#scratch, OX = origin % COLS, OY = (origin - OX) / COLS;
    let count = 0;
    for (let i = 0; i < TABLE.d2.length; i++) {
      if (TABLE.d2[i] > REACH2) {
        break;
      }
      const X = OX + TABLE.dx[i], Y = OY + TABLE.dy[i], PARENT = TABLE.parent[i];
      if (X < 0 || Y < 0 || X >= COLS || Y >= ROWS || PARENT >= 0 && !PASS[PARENT]) {
        PASS[i] = 0;
        continue;
      }
      const CELL = Y * COLS + X;
      if (xray || !BLOCKED[CELL] && (PARENT < 0 || LEVELS[CELL] <= level)) {
        PASS[i] = 1;
        CELLS[count++] = CELL;
      } else {
        PASS[i] = 0;
      }
    }
    const COUNT = radius > 0 ? count : 0;
    return {
      cell: origin,
      radius,
      level,
      xray,
      counts: this.#layerFor(xray ? Infinity : level).counts,
      cells: CELLS.slice(0, COUNT),
      epoch: 0
    };
  }
  #layerFor(ceiling) {
    for (const LAYER2 of this.#layers) {
      if (LAYER2.ceiling === ceiling) {
        return LAYER2;
      }
    }
    const LAYER = { ceiling, counts: new Uint16Array(this.#any.length) };
    this.#layers.push(LAYER);
    return LAYER;
  }
  #apply(record, delta) {
    const { cells: CELLS, counts: COUNTS } = record, ANY = this.#any;
    for (let i = 0; i < CELLS.length; i++) {
      COUNTS[CELLS[i]] += delta;
      ANY[CELLS[i]] += delta;
    }
  }
};
export {
  VisionField,
  VisionMap
};
