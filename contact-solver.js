// modules/geometry/math.js
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function pointInSimplePolygon(x, y, points) {
  if (!Array.isArray(points) || points.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const A = points[i], B = points[j];
    const HIT = A.y > y !== B.y > y && x < (B.x - A.x) * (y - A.y) / (B.y - A.y || 1e-9) + A.x;
    if (HIT) {
      inside = !inside;
    }
  }
  return inside;
}

// modules/geometry/contact.js
var KIND_SCALE = 2 ** 50;
var OBSTACLE_SCALE = 2 ** 22;
var WORD = 2 ** 32;
var CONTACT_MAX_OBSTACLE = 2 ** 28 - 1;
var CONTACT_MAX_EDGE = 2 ** 20 - 1;
var CONTACT_POLYGON = 0;
var CONTACT_WALL = 2;
var CONTACT_USER = 3;
var CONTACT_EDGE = 0;
var CONTACT_START = 1;
var CONTACT_END = 2;
function contactKey(kind, obstacle, edge = 0, part = 0) {
  return kind * KIND_SCALE + obstacle * OBSTACLE_SCALE + edge * 4 + part;
}
function mixWord(h, word) {
  return Math.imul(h ^ word, 16777619);
}
function defaultTieRank(tieKey, contactKeyValue, sign) {
  if (!Number.isSafeInteger(tieKey) || tieKey < 0 || !Number.isSafeInteger(contactKeyValue) || contactKeyValue < 0) {
    throw new TypeError(
      `tieRank needs non-negative safe integers (tieKey ${tieKey}, contactKey ${contactKeyValue}).`
    );
  }
  const TIE_LOW = tieKey % WORD, KEY_LOW = contactKeyValue % WORD;
  let h = 2166136261;
  h = mixWord(h, TIE_LOW);
  h = mixWord(h, (tieKey - TIE_LOW) / WORD);
  h = mixWord(h, KEY_LOW);
  h = mixWord(h, (contactKeyValue - KEY_LOW) / WORD);
  h = mixWord(h, sign > 0 ? 1 : 0);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}
var ContactHit = class {
  /** 닿는 시각(0..1). 닿지 않았으면 Infinity로 둡니다. */
  t = Infinity;
  nx = 0;
  ny = 0;
  /** 접촉 키(정수, {@link contactKey}). */
  key = 0;
  /** 원 장애물에 닿았으면 그 원, 아니면 null. */
  obstacle = null;
  /** 법선이 0에 가까워 기본 법선 (1, 0)을 쓴 경우 true. 호출자가 대체 법선을 채웁니다. */
  degenerate = false;
};
function offerContact(best, t, nx, ny, key, obstacle, degenerate) {
  if (t < best.t - 1e-10 || Math.abs(t - best.t) <= 1e-10 && key < best.key) {
    best.t = t;
    best.nx = nx;
    best.ny = ny;
    best.key = key;
    best.obstacle = obstacle;
    best.degenerate = degenerate;
  }
}
var SurfaceContact = class {
  nx = 0;
  ny = 0;
  depth = 0;
  key = 0;
  distance = 0;
  obstacle = null;
};
var ContactList = class {
  /** @type {SurfaceContact[]} */
  items = [];
  count = 0;
  clear() {
    this.count = 0;
    return this;
  }
  /** 접촉 하나를 끝에 넣고 그 객체를 돌려줍니다. */
  add(nx, ny, depth = 0, key = 0, distance = 0, obstacle = null) {
    let contact = this.items[this.count];
    if (contact === void 0) {
      contact = this.items[this.count] = new SurfaceContact();
    }
    contact.nx = nx;
    contact.ny = ny;
    contact.depth = depth;
    contact.key = key;
    contact.distance = distance;
    contact.obstacle = obstacle;
    this.count++;
    return contact;
  }
};
var POLICIES = Object.freeze({
  // 정적 표면(다각형·원 장애물·월드 경계)에 대한 이동. 표면에 이미 닿아 있으면 안쪽으로 들어갈 때만 접촉입니다.
  surface: Object.freeze({
    minSpeed2: 1e-16,
    contactDistanceEpsilon: 1e-8,
    normalEpsilon: 1e-10,
    inwardEpsilon: 1e-8,
    discriminantEpsilon: 1e-12,
    includeTangent: false,
    retreat: 0
  }),
  // 움직이는 두 원의 상대 이동. 닿는 순간보다 `retreat`만큼 일찍 멈추고 접선도 접촉으로 칩니다.
  relative: Object.freeze({
    minSpeed2: 1e-9,
    contactSquaredEpsilon: 1e-7,
    normalEpsilon: 1e-6,
    inwardEpsilon: 0,
    discriminantEpsilon: 0,
    includeTangent: true,
    retreat: 5e-4
  })
});
var SweptCircleContact = class {
  /** `cast`에 넘기는 정책. 사용자 정책 객체도 같은 필드를 갖추면 됩니다. */
  static policies = POLICIES;
  /**
   * 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy) 한 틱(t: 0~1) 동안 반지름 r인 원 안에 처음 들어가는지.
   * 닿으면 true이고 `out.t`·`out.nx`·`out.ny`·`out.degenerate`를 씁니다. 닿지 않으면 false이고 `out`을 건드리지 않습니다.
   * 법선이 0에 가까우면 `out.degenerate = true`, 법선 (1, 0)을 씁니다. 대체 법선이 필요하면 호출자가 그때만 채웁니다.
   * @param {{t: number, nx: number, ny: number, degenerate: boolean}} out
   */
  static cast(rx, ry, vx, vy, r, policy, out) {
    const AA = vx * vx + vy * vy, RADIAL = rx * vx + ry * vy, C = rx * rx + ry * ry - r * r;
    const DISTANCE_POLICY = policy.contactDistanceEpsilon != null, LENGTH = DISTANCE_POLICY ? Math.hypot(rx, ry) : 0;
    if (DISTANCE_POLICY && AA < policy.minSpeed2) {
      return false;
    }
    const CONTACT = DISTANCE_POLICY ? LENGTH <= r + policy.contactDistanceEpsilon : C <= policy.contactSquaredEpsilon;
    let t = 0;
    if (CONTACT) {
      const INWARD2 = DISTANCE_POLICY ? vx * (LENGTH > policy.normalEpsilon ? rx / LENGTH : 1) + vy * (LENGTH > policy.normalEpsilon ? ry / LENGTH : 0) : RADIAL;
      if (INWARD2 >= -policy.inwardEpsilon) {
        return false;
      }
    } else {
      if (DISTANCE_POLICY ? AA < policy.minSpeed2 : AA <= policy.minSpeed2) {
        return false;
      }
      const DISC = RADIAL * RADIAL - AA * C;
      if (policy.includeTangent ? DISC < policy.discriminantEpsilon : DISC <= policy.discriminantEpsilon) {
        return false;
      }
      if (DISTANCE_POLICY && RADIAL >= 0) {
        return false;
      }
      const ENTER = (-RADIAL - Math.sqrt(DISC)) / AA;
      if (ENTER < 0 || ENTER > 1) {
        return false;
      }
      t = Math.max(0, ENTER - policy.retreat);
    }
    const QX = rx + vx * t, QY = ry + vy * t, L = Math.hypot(QX, QY);
    out.t = t;
    if (L > policy.normalEpsilon) {
      out.nx = QX / L;
      out.ny = QY / L;
      out.degenerate = false;
    } else {
      out.nx = 1;
      out.ny = 0;
      out.degenerate = true;
    }
    return true;
  }
};
function offerCircle(best, x, y, vx, vy, cx, cy, r, key, obstacle, scratch) {
  if (SweptCircleContact.cast(x - cx, y - cy, vx, vy, r, POLICIES.surface, scratch)) {
    offerContact(best, scratch.t, scratch.nx, scratch.ny, key, obstacle, scratch.degenerate);
  }
}
function castEdgeInto(best, x, y, vx, vy, ax, ay, bx, by, r, key, slack, testStart, testEnd, scratch) {
  const DX = bx - ax, DY = by - ay, LEN = Math.hypot(DX, DY);
  if (LEN < 1e-9) {
    offerCircle(best, x, y, vx, vy, ax, ay, r, key, null, scratch);
    return;
  }
  const EX = DX / LEN, EY = DY / LEN, NX = -EY, NY = EX;
  const SIGNED = (x - ax) * NX + (y - ay) * NY, VN = vx * NX + vy * NY;
  for (let k = 0; k < 2; k++) {
    const SIDE = k === 0 ? -1 : 1;
    if (SIDE * VN >= -1e-8) {
      continue;
    }
    let t = (r - SIDE * SIGNED) / (SIDE * VN);
    if (t < 0 && SIDE * SIGNED >= r - slack) {
      t = 0;
    }
    if (t < 0 || t > 1) {
      continue;
    }
    const ALONG = (x + vx * t - ax) * EX + (y + vy * t - ay) * EY;
    if (ALONG >= -1e-8 && ALONG <= LEN + 1e-8) {
      offerContact(best, t, NX * SIDE, NY * SIDE, key + CONTACT_EDGE, null, false);
    }
  }
  if (testStart) {
    offerCircle(best, x, y, vx, vy, ax, ay, r, key + CONTACT_START, null, scratch);
  }
  if (testEnd) {
    offerCircle(best, x, y, vx, vy, bx, by, r, key + CONTACT_END, null, scratch);
  }
}
var SCRATCH = new ContactHit();
var SurfaceContactGeometry = class {
  /** 선분 AB 위에서 (x, y)에 가장 가까운 점을 `out`에 씁니다. */
  static closest(ax, ay, bx, by, x, y, out) {
    const DX = bx - ax, DY = by - ay, L2 = DX * DX + DY * DY, T = L2 ? clamp(((x - ax) * DX + (y - ay) * DY) / L2, 0, 1) : 0;
    out.x = ax + DX * T;
    out.y = ay + DY * T;
    return out;
  }
  /**
   * 원 (x, y)가 속도 (vx, vy)로 움직일 때 고정된 원 (cx, cy, 반지름 r)에 닿으면 true이고 `out`(ContactHit 모양)에
   * t·법선·`key`·`obstacle`을 씁니다. 닿지 않으면 false입니다.
   */
  static circleCast(x, y, vx, vy, cx, cy, r, key, obstacle, out) {
    out.t = Infinity;
    offerCircle(out, x, y, vx, vy, cx, cy, r, key, obstacle, SCRATCH);
    return out.t !== Infinity;
  }
  /**
   * 원 (x, y, 반지름 r)이 속도 (vx, vy)로 움직일 때 선분 (ax, ay)-(bx, by)(양 끝 원 포함)에 닿는 가장 이른 접촉.
   * 닿으면 true이고 `out`에 씁니다. 키는 변이면 `key`, 시작 꼭짓점이면 `key + 1`, 끝 꼭짓점이면 `key + 2`이므로 `key`는
   * 4의 배수(보통 {@link contactKey}의 부위 0)로 줍니다. `slack`은 이미 선분에서 그만큼(보통 고정소수 한 칸) 안쪽에
   * 들어와 있어도 t = 0 접촉으로 치는 허용 거리입니다.
   */
  static edgeCast(x, y, vx, vy, ax, ay, bx, by, r, key, slack, out) {
    out.t = Infinity;
    castEdgeInto(out, x, y, vx, vy, ax, ay, bx, by, r, key, slack, true, true, SCRATCH);
    return out.t !== Infinity;
  }
  /**
   * 원 (x, y, 반지름 r)이 다각형 `points`(꼭짓점 배열)와 이미 닿았거나 `epsilon` 안으로 가까운 접촉을 `list` 뒤에 넣습니다.
   * 접촉 키는 `contactKey(CONTACT_POLYGON, polygon, 변 번호)`이고 법선은 원이 밀려날 방향입니다. 원 중심이 다각형 안에
   * 있으면 가장 가까운 가장자리 하나만 넣습니다. `list`를 돌려줍니다.
   * @param {ContactList} list
   */
  static polygonContacts(x, y, r, points, polygon, epsilon, list) {
    const INSIDE = pointInSimplePolygon(x, y, points), COUNT = points.length;
    let nearestD = -1, nearestNx = 0, nearestNy = 0, nearestEdge = 0;
    for (let i = 0; i < COUNT; i++) {
      const A = points[i], B = points[(i + 1) % COUNT];
      const EX = B.x - A.x, EY = B.y - A.y, L2 = EX * EX + EY * EY, T = L2 ? clamp(((x - A.x) * EX + (y - A.y) * EY) / L2, 0, 1) : 0;
      const DX = x - (A.x + EX * T), DY = y - (A.y + EY * T), D = Math.hypot(DX, DY);
      if (INSIDE ? nearestD >= 0 && !(D < nearestD) : !(D <= r + epsilon)) {
        continue;
      }
      let nx, ny;
      if (D > 1e-9) {
        const SIGN = INSIDE ? -1 : 1;
        nx = SIGN * DX / D;
        ny = SIGN * DY / D;
      } else {
        let area = 0;
        for (let j = 0; j < COUNT; j++) {
          const V = points[j], W = points[(j + 1) % COUNT];
          area = area + V.x * W.y - W.x * V.y;
        }
        const LEN = Math.hypot(B.x - A.x, B.y - A.y) || 1, SIGN = area >= 0 ? 1 : -1;
        nx = (B.y - A.y) / LEN * SIGN;
        ny = -(B.x - A.x) / LEN * SIGN;
      }
      if (INSIDE) {
        nearestD = D;
        nearestNx = nx;
        nearestNy = ny;
        nearestEdge = i;
      } else {
        list.add(nx, ny, r - D, contactKey(CONTACT_POLYGON, polygon, i), D, null);
      }
    }
    if (INSIDE && nearestD >= 0) {
      list.add(
        nearestNx,
        nearestNy,
        r + nearestD,
        contactKey(CONTACT_POLYGON, polygon, nearestEdge),
        nearestD,
        null
      );
    }
    return list;
  }
  /** 속도 (x, y)가 `list`의 모든 접촉 법선에서 밀려나는 쪽이거나 평행(허용 -1e-7)인지. */
  static feasible(x, y, list) {
    return feasibleAt(x, y, list);
  }
  /**
   * 원하는 이동 (vx, vy)를 모든 접촉에 위배되지 않는 가장 가까운 이동으로 바꿔 `out`에 씁니다.
   * 이미 가능하면 그대로, 접촉 하나의 접평면에 사영해 가능한 것 중 가장 덜 바뀐 것, 없으면 정지 (0, 0)입니다.
   * @param {ContactList} list
   * @param {{x: number, y: number}} out
   */
  static project(vx, vy, list, out) {
    if (feasibleAt(vx, vy, list)) {
      out.x = vx;
      out.y = vy;
      return out;
    }
    const ITEMS = list.items, COUNT = list.count;
    let bestX = 0, bestY = 0, cost = vx * vx + vy * vy;
    for (let i = 0; i < COUNT; i++) {
      const N = ITEMS[i], DOT = vx * N.nx + vy * N.ny, PX = vx - N.nx * DOT, PY = vy - N.ny * DOT;
      if (!feasibleAt(PX, PY, list)) {
        continue;
      }
      const D = (PX - vx) ** 2 + (PY - vy) ** 2;
      if (D < cost - 1e-12) {
        bestX = PX;
        bestY = PY;
        cost = D;
      }
    }
    out.x = bestX;
    out.y = bestY;
    return out;
  }
  /**
   * 접촉에 막힌 이동 (vx, vy)를 `budget` 길이 안에서 미끄러뜨린 이동을 `out`에 씁니다.
   * `steer`가 false면 사영 결과 그대로(바깥 힘은 새 옆 방향 충격을 얻지 않습니다), true면 사영 결과가 거의 0일 때
   * (`goalX`, `goalY`)에 가장 맞는 접선 방향을 골라 `budget` 길이로 늘립니다. 방향 점수가 같으면 `tieRank(tieKey,
   * 접촉 키, 부호)`가 낮은 쪽이 이깁니다(`tieRank`가 null이면 {@link defaultTieRank}). `tieKey`는 0 이상 안전 정수입니다.
   * @param {number} vx
   * @param {number} vy
   * @param {ContactList} list
   * @param {number} budget
   * @param {boolean} steer
   * @param {number} goalX
   * @param {number} goalY
   * @param {number} tieKey
   * @param {((tieKey: number, contactKey: number, sign: number) => number) | null} tieRank
   * @param {{x: number, y: number}} out
   */
  static slide(vx, vy, list, budget, steer, goalX, goalY, tieKey, tieRank, out) {
    if (budget < 1e-8) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    this.project(vx, vy, list, out);
    if (!steer) {
      return out;
    }
    let px = out.x, py = out.y, len = Math.hypot(px, py);
    if (len < budget * 0.035) {
      const RANK = tieRank ?? defaultTieRank, ITEMS = list.items, COUNT = list.count;
      let bestX = 0, bestY = 0, found = false, score = -Infinity, tie = Infinity;
      for (let i = 0; i < COUNT; i++) {
        const C = ITEMS[i];
        for (let k = 0; k < 2; k++) {
          const SIGN = k === 0 ? -1 : 1;
          const QX = -C.ny * SIGN, QY = C.nx * SIGN;
          if (!feasibleAt(QX, QY, list)) {
            continue;
          }
          const VALUE = QX * goalX + QY * goalY;
          if (VALUE < -1e-7) {
            continue;
          }
          if (VALUE > score + 1e-7) {
            bestX = QX;
            bestY = QY;
            found = true;
            score = VALUE;
            tie = RANK(tieKey, C.key, SIGN) >>> 0;
          } else if (Math.abs(VALUE - score) <= 1e-7) {
            const VALUE_RANK = RANK(tieKey, C.key, SIGN) >>> 0;
            if (VALUE_RANK < tie) {
              bestX = QX;
              bestY = QY;
              found = true;
              score = VALUE;
              tie = VALUE_RANK;
            }
          }
        }
      }
      if (!found) {
        out.x = 0;
        out.y = 0;
        return out;
      }
      px = bestX;
      py = bestY;
      len = 1;
    }
    if (len > 1e-8) {
      out.x = px / len * budget;
      out.y = py / len * budget;
    } else {
      out.x = 0;
      out.y = 0;
    }
    return out;
  }
};
function feasibleAt(x, y, list) {
  const ITEMS = list.items, COUNT = list.count;
  for (let i = 0; i < COUNT; i++) {
    if (!(x * ITEMS[i].nx + y * ITEMS[i].ny >= -1e-7)) {
      return false;
    }
  }
  return true;
}

// modules/geometry/surface-motion.js
var WALL_LEFT = contactKey(CONTACT_WALL, 0, 0);
var WALL_RIGHT = contactKey(CONTACT_WALL, 0, 1);
var WALL_TOP = contactKey(CONTACT_WALL, 0, 2);
var WALL_BOTTOM = contactKey(CONTACT_WALL, 0, 3);
var MotionResult = class {
  x = 0;
  y = 0;
  /** 시작 자리가 막혀 있어 풀지 못했으면 false. */
  valid = true;
  /** 이동 중 장애물에 닿았는지. 닿았으면 `contact`가 처음 닿은 접촉입니다. */
  hit = false;
  contact = new ContactHit();
};

// modules/spatial/index.js
var NONE = -1;
var MODE_UNTRACKED = 0;
var MODE_INDEX = 1;
var MODE_IDENTITY = 2;
var MAX_CELL_COUNT = 1 << 24;
var MAX_ITEM_INDEX = (1 << 24) - 1;
var EMPTY = Object.freeze([]);
var UNIFORM_OPTIONS = ["cellSize", "width", "height", "originX", "originY", "outside", "groups", "track"];
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
  // 사용한 칸 번호와 개수. 비울 때 배열 길이를 0으로 만들면 V8이 저장 공간을 놓아 다음 채우기가 다시 할당하므로 개수만 되돌립니다.
  #used = [];
  #usedCount = 0;
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
    if (this.#used.length !== this.#usedCount) {
      this.#used.length = this.#usedCount;
    }
    return this.#used;
  }
  /** 담긴 항목을 모두 비웁니다. 사용한 칸만 비우고 버킷 배열은 재사용합니다. */
  clear() {
    if (this.#plain) {
      const USED2 = this.#used;
      for (let i = 0; i < this.#usedCount; i++) {
        this.#touched[USED2[i]] = 0;
      }
      this.#usedCount = 0;
      this.#plainCount = 0;
      this.#plainDirty = true;
      return;
    }
    const CELLS = this.#cells, USED = this.#used, GROUP_CELLS = this.#groupCells;
    for (let i = 0; i < this.#usedCount; i++) {
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
    this.#usedCount = 0;
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
      this.#used[this.#usedCount++] = KEY;
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
      this.#used[this.#usedCount++] = KEY;
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
   * `queryRect`와 같은 후보를 같은 순서로 정수 배열(`Int32Array` 등) `out`의 앞에서부터 쓰고 개수를 돌려줍니다. 항목이 정수
   * 번호일 때(track `false`·`'index'`) 쓰며, 결과 길이가 들쭉날쭉해도 배열을 다시 만들지 않습니다. `out`이 모자라면
   * `RangeError`입니다(항목 수 이상으로 잡아 두면 모자라지 않습니다).
   */
  queryRectInto(minX, minY, maxX, maxY, out, group = NONE) {
    if (this.#mode === MODE_IDENTITY) {
      throw new TypeError("UniformGrid queryRectInto needs integer items (track false or 'index').");
    }
    if (this.#plain && group < 0) {
      return this.#collectPlainInto(this.cellX(minX), this.cellY(minY), this.cellX(maxX), this.cellY(maxY), out);
    }
    const BUCKETS = this.#bucketsFor(group);
    if (this.#clamp) {
      return this.#collectCellsInto(
        BUCKETS,
        this.cellX(minX),
        this.cellY(minY),
        this.cellX(maxX),
        this.cellY(maxY),
        out
      );
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return 0;
    }
    let count = 0;
    if (maxX >= this.originX && maxY >= this.originY && minX < this.#worldMaxX && minY < this.#worldMaxY) {
      count = this.#collectCellsInto(
        BUCKETS,
        Math.max(0, this.cellX(minX)),
        Math.max(0, this.cellY(minY)),
        Math.min(this.#maxCol, this.cellX(maxX)),
        Math.min(this.#maxRow, this.cellY(maxY)),
        out
      );
    }
    const OVERFLOW = this.#cells[this.cellTotal];
    if (OVERFLOW !== void 0) {
      for (let i = 0; i < OVERFLOW.length; i++) {
        const X = this.#overflowX[i], Y = this.#overflowY[i];
        if (X >= minX && X <= maxX && Y >= minY && Y <= maxY) {
          if (count >= out.length) {
            throw new RangeError("UniformGrid queryRectInto out is too short.");
          }
          out[count++] = OVERFLOW[i];
        }
      }
    }
    return count;
  }
  /** `queryCircle`의 정수 배열판입니다. `queryRectInto(x - r, y - r, x + r, y + r, out, group)`와 같습니다. */
  queryCircleInto(x, y, radius, out, group = NONE) {
    return this.queryRectInto(x - radius, y - radius, x + radius, y + radius, out, group);
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
      this.#used[this.#usedCount++] = key;
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
  #collectCellsInto(buckets, x0, y0, x1, y1, out) {
    const COLS = this.cols;
    let count = 0;
    for (let cy = y0; cy <= y1; cy++) {
      const ROW = cy * COLS;
      for (let cx = x0; cx <= x1; cx++) {
        const BUCKET = buckets[ROW + cx];
        if (BUCKET === void 0) {
          continue;
        }
        if (count + BUCKET.length > out.length) {
          throw new RangeError("UniformGrid queryRectInto out is too short.");
        }
        for (let i = 0; i < BUCKET.length; i++) {
          out[count++] = BUCKET[i];
        }
      }
    }
    return count;
  }
  #collectPlainInto(x0, y0, x1, y1, out) {
    if (this.#plainDirty) {
      this.#buildPlain();
    }
    const COLS = this.cols, START = this.#plainStart, ITEMS = this.#plainItems;
    let count = 0;
    for (let cy = y0; cy <= y1; cy++) {
      const ROW = cy * COLS, FROM = START[ROW + x0], END = START[ROW + x1 + 1];
      if (count + END - FROM > out.length) {
        throw new RangeError("UniformGrid queryRectInto out is too short.");
      }
      for (let k = FROM; k < END; k++) {
        out[count++] = ITEMS[k];
      }
    }
    return count;
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

// modules/contact-solver/solver.js
var ACTIVE = 1;
var DYNAMIC = 2;
var PAIRS = 4;
var VERTICAL = 8;
var SEPARATE = 16;
var PASS = 0;
var SOFT = 1;
var SOLID = 2;
var RESPONSE_NONE = 0;
var RESPONSE_REFLECT = 1;
var RESPONSE_SLIDE = 2;
var RESPONSE_EXCHANGE = 3;
var RESPONSE_STOP = 4;
var RESPONSE_STICK = 5;
var RESPONSE_BOUNCE = 6;
var OPTIONS = [
  "surface",
  "fixedPoint",
  "remainderScale",
  "pairBudget",
  "maxZeroTimeRepeats",
  "restitution",
  "cellSize",
  "softFraction",
  "softPasses",
  "hardPasses"
];
var SAME_TIME = 1e-9;
var INWARD = -1e-7;
var NORMAL_SCALE = 4096;
var NORMAL_X = Int32Array.of(4096, 2896, 0, -2896, -4096, -2896, 0, 2896);
var NORMAL_Y = Int32Array.of(0, 2896, 4096, 2896, 0, -2896, -4096, -2896);
var TWO_32 = 4294967296;
var IDLE = 0;
var FILLING = 1;
var RUNNING = 2;
var DONE = 3;
function finitePositive(value, name) {
  if (typeof value !== "number" || !(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`ContactSolver ${name} must be a positive finite number.`);
  }
  return value;
}
function integerOption(value, name, min) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`ContactSolver ${name} must be an integer >= ${min}.`);
  }
  return value;
}
function pairHash(a, b) {
  let h = Math.imul(2166136261 ^ a % TWO_32, 16777619);
  h = Math.imul(h ^ Math.floor(a / TWO_32), 16777619);
  h = Math.imul(h ^ b % TWO_32, 16777619);
  h = Math.imul(h ^ Math.floor(b / TWO_32), 16777619);
  return h >>> 0;
}
var ContactBodies = class {
  count = 0;
  capacity = 0;
  constructor() {
    this.grow(64);
  }
  grow(capacity) {
    const OLD = this.capacity;
    if (capacity <= OLD) {
      return;
    }
    const COLUMNS = [
      ["x", Int32Array],
      ["y", Int32Array],
      ["steerX", Int32Array],
      ["steerY", Int32Array],
      ["vx", Float64Array],
      ["vy", Float64Array],
      ["ivx", Float64Array],
      ["ivy", Float64Array],
      ["rx", Int32Array],
      ["ry", Int32Array],
      ["radius", Float64Array],
      ["mass", Float64Array],
      ["key", Float64Array],
      ["group", Uint8Array],
      ["z", Float64Array],
      ["softCap", Int32Array],
      ["flags", Uint8Array]
    ];
    for (const [NAME, TYPE] of COLUMNS) {
      const NEXT = new TYPE(capacity);
      if (this[NAME]) {
        NEXT.set(this[NAME]);
      }
      this[NAME] = NEXT;
    }
    this.capacity = capacity;
  }
};
var ContactEvent = class {
  /** 접촉한 몸. */
  i = -1;
  /** 상대 몸, 표면이면 -1. 쌍은 동적 몸이 `i`(둘 다 같으면 작은 번호)입니다. */
  j = -1;
  /** j → i 방향 단위 법선(표면이면 표면 바깥쪽). */
  nx = 0;
  ny = 0;
  /** 스텝 안 시각(초). 두 몸은 이미 이 시각 위치에 있습니다. */
  t = 0;
  /** 표면 접촉의 geometry 정수 접촉 키(쌍은 0). */
  key = 0;
  /** 표면 접촉의 장애물(원 장애물 레코드, 아니면 null). */
  obstacle = null;
  /** 시간이 흐르지 않고 연속으로 같은 접촉을 만난 횟수(이 접촉 포함). 시간이 흐른 뒤 첫 접촉은 0입니다. */
  repeats = 0;
  /** `repeats >= maxZeroTimeRepeats`. 기본 응답이 멈춤(표면)·붙기(쌍)가 됩니다. */
  stuck = false;
  /** 마지막 응답(`RESPONSE_*`). `next`가 RESPONSE_NONE으로 비웁니다. */
  response = RESPONSE_NONE;
  /** `exchange`가 주고받은 충격량 J(아니면 0). */
  impulse = 0;
  /** 응답했는지(모듈 내부, 응답 없이 다음 `next`를 부르면 기본 응답을 적용). */
  handled = true;
};
var ContactSolver = class {
  /** 한 스텝에 푸는 몸-몸 접촉 수. 다음 스텝의 첫 `next`부터 적용됩니다. Infinity면 무제한. */
  pairBudget;
  /** 같은 0초 접촉 반복 한도. */
  maxZeroTimeRepeats;
  /** 기본 응답의 반발 계수(표면 반사·쌍 교환·조향 미끄러짐의 안쪽 속도 제거). */
  restitution;
  /** 지난 스텝의 계수. `begin`이 비웁니다. */
  stats = { surfaceContacts: 0, pairContacts: 0, skippedPairs: 0, casts: 0, groups: 0, softMoves: 0, hardMoves: 0 };
  #surface;
  #fp;
  #remainderScale;
  #width;
  #height;
  #cellSize;
  #softFraction;
  #softPasses;
  #hardPasses;
  #groups = 1;
  #relations = Uint8Array.of(PASS);
  #bodies = new ContactBodies();
  #state = IDLE;
  #dt = 0;
  #grid = null;
  // 격자가 지금 위치의 SEPARATE 몸을 담고 있는지. 위치가 바뀐 pass 뒤에만 다시 만듭니다.
  #separationGridFresh = false;
  // 격자 후보(몸 번호)와 개수. 몸 용량만큼 잡아 두므로 모자라지 않습니다.
  #candidates = new Int32Array(0);
  #hit = new ContactHit();
  #pairHit = new ContactHit();
  #slideList = new ContactList();
  #slideOut = { x: 0, y: 0 };
  #motion = new MotionResult();
  // 몸별 스텝 상태.
  #capacity = 0;
  #base = new Float64Array(0);
  #fracX = new Float64Array(0);
  #fracY = new Float64Array(0);
  #involved = new Int32Array(0);
  #recast = new Int32Array(0);
  #startX = new Int32Array(0);
  #startY = new Int32Array(0);
  #segX = new Int32Array(0);
  #segY = new Int32Array(0);
  #stageX = new Int32Array(0);
  #stageY = new Int32Array(0);
  #radiusFP = new Int32Array(0);
  #sumX = new Int32Array(0);
  #sumY = new Int32Array(0);
  #counts = new Int32Array(0);
  #stamp = 0;
  #speedBound = 0;
  #maxRadius = 0;
  #pairsLeft = 0;
  #now = 0;
  #elapsed = 0;
  // 접촉 기록 풀: 몸마다 가장 이른 시각(1e-9 창)의 접촉 연결 리스트.
  #poolCapacity = 0;
  #free = -1;
  #head = new Int32Array(0);
  #earliest = new Float64Array(0);
  #cT = new Float64Array(0);
  #cI = new Int32Array(0);
  #cJ = new Int32Array(0);
  #cNx = new Float64Array(0);
  #cNy = new Float64Array(0);
  #cKey = new Float64Array(0);
  #cSortA = new Float64Array(0);
  #cSortB = new Float64Array(0);
  #cNext = new Int32Array(0);
  #cObstacle = [];
  // 같은 시각 묶음(안정 병합 정렬).
  #order = new Int32Array(0);
  #orderScratch = new Int32Array(0);
  #orderLength = 0;
  #cursor = 0;
  #lastI = -1;
  #lastJ = -1;
  #pending = null;
  // 0초 반복 횟수: (몸 또는 작은 번호, 접촉 키 또는 -(큰 번호 + 1)) → 횟수. 열린 주소 해시, 세대 표식으로 비움.
  #repeatA = new Int32Array(0);
  #repeatB = new Float64Array(0);
  #repeatCount = new Int32Array(0);
  #repeatEpoch = new Uint32Array(0);
  #repeatEpochNow = 1;
  #repeatUsed = 0;
  // 겹침 풀기의 쌍 목록(정렬한 정수 키)과 병합 정렬 버퍼.
  #pairs = new Float64Array(0);
  #pairsScratch = new Float64Array(0);
  /**
   * @param {object} options
   * @param {import('../geometry/surface-motion.js').SurfaceMotion} options.surface 지형·건물·맵 경계(게임이 가진 것).
   *   `cast`·`solve`와 `field.width/height`만 씁니다. 체크포인트(`remember`/`constrain`)는 건드리지 않습니다.
   * @param {number} options.fixedPoint 위치 격자 배율(1/fixedPoint). 위치 열은 이 단위의 정수입니다.
   * @param {number} options.remainderScale 동적 몸 잔여 변위의 정수 배율(1/remainderScale 격자 칸).
   * @param {number} options.pairBudget 한 스텝에 푸는 몸-몸 접촉 수(0 이상 정수 또는 Infinity).
   * @param {number} options.maxZeroTimeRepeats 같은 0초 접촉 반복 한도(1 이상).
   * @param {number} [options.restitution] 기본 응답의 반발 계수(기본 0).
   * @param {number} options.cellSize 후보 격자 칸 한 변(월드 단위). 결과에는 영향이 없고 비용만 바뀝니다.
   * @param {number} [options.softFraction] SOFT 겹침 풀기에서 한 pass에 푸는 침투 비율(기본 0.8).
   * @param {number} [options.softPasses] SOFT 겹침 풀기 최대 pass(기본 4, 움직임이 없으면 멈춤).
   * @param {number} [options.hardPasses] SOLID 겹침 풀기 최대 pass(기본 4, 움직임이 없으면 멈춤).
   */
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("ContactSolver options must be an object.");
    }
    for (const KEY of Object.keys(options)) {
      if (!OPTIONS.includes(KEY)) {
        throw new TypeError(`ContactSolver has an unknown option: ${KEY}`);
      }
    }
    const SURFACE = options.surface;
    if (!SURFACE || typeof SURFACE.cast !== "function" || typeof SURFACE.solve !== "function" || !SURFACE.field) {
      throw new TypeError("ContactSolver surface must be a geometry SurfaceMotion.");
    }
    this.#surface = SURFACE;
    this.#fp = integerOption(options.fixedPoint, "fixedPoint", 1);
    this.#remainderScale = integerOption(options.remainderScale, "remainderScale", 1);
    this.#width = SURFACE.field.width;
    this.#height = SURFACE.field.height;
    this.#cellSize = finitePositive(options.cellSize, "cellSize");
    this.pairBudget = options.pairBudget;
    this.#checkBudget();
    this.maxZeroTimeRepeats = integerOption(options.maxZeroTimeRepeats, "maxZeroTimeRepeats", 1);
    this.restitution = options.restitution ?? 0;
    if (!(this.restitution >= 0) || !Number.isFinite(this.restitution)) {
      throw new RangeError("ContactSolver restitution must be a finite number >= 0.");
    }
    this.#softFraction = options.softFraction ?? 0.8;
    if (!(this.#softFraction > 0 && this.#softFraction <= 1)) {
      throw new RangeError("ContactSolver softFraction must be in (0, 1].");
    }
    this.#softPasses = integerOption(options.softPasses ?? 4, "softPasses", 0);
    this.#hardPasses = integerOption(options.hardPasses ?? 4, "hardPasses", 0);
    this.#grid = new UniformGrid({
      cellSize: this.#cellSize * this.#fp,
      width: this.#width * this.#fp,
      height: this.#height * this.#fp,
      outside: "clamp"
    });
    this.#growPool(256);
    this.#growRepeats(256);
  }
  /**
   * 몸 `group` 사이의 관계 표(`groups × groups`, 행 = i의 group, 열 = j의 group)를 정합니다. 값은 PASS·SOFT·SOLID이고
   * 대칭이어야 합니다. 표는 복사합니다.
   */
  setRelations(groups, table) {
    integerOption(groups, "relation groups", 1);
    if (groups > 256 || !table || table.length !== groups * groups) {
      throw new RangeError("ContactSolver relations need groups <= 256 and a groups × groups table.");
    }
    const COPY = new Uint8Array(groups * groups);
    for (let a = 0; a < groups; a++) {
      for (let b = 0; b < groups; b++) {
        const VALUE = table[a * groups + b];
        if (VALUE !== PASS && VALUE !== SOFT && VALUE !== SOLID) {
          throw new RangeError("ContactSolver relation values are PASS, SOFT or SOLID.");
        }
        if (VALUE !== table[b * groups + a]) {
          throw new RangeError("ContactSolver relations must be symmetric.");
        }
        COPY[a * groups + b] = VALUE;
      }
    }
    this.#groups = groups;
    this.#relations = COPY;
  }
  /**
   * 새 스텝을 시작하고 몸 열을 돌려줍니다. 게임은 `[0, count)`의 열을 모두 채웁니다(이전 스텝 값이 남아 있습니다).
   * @returns {ContactBodies}
   */
  begin(count, dt) {
    integerOption(count, "count", 0);
    finitePositive(dt, "dt");
    const BODIES = this.#bodies;
    if (BODIES.capacity < count) {
      let capacity = BODIES.capacity;
      while (capacity < count) {
        capacity *= 2;
      }
      BODIES.grow(capacity);
    }
    BODIES.count = count;
    this.#growBodies(count);
    this.#dt = dt;
    this.#state = FILLING;
    this.#pending = null;
    const STATS = this.stats;
    STATS.surfaceContacts = 0;
    STATS.pairContacts = 0;
    STATS.skippedPairs = 0;
    STATS.casts = 0;
    STATS.groups = 0;
    STATS.softMoves = 0;
    STATS.hardMoves = 0;
    return BODIES;
  }
  /** 지금 스텝의 몸 열(`begin`이 돌려준 것). */
  get bodies() {
    return this.#bodies;
  }
  /**
   * 다음 접촉을 `ev`에 쓰고 true, 더 없으면 false. 앞 접촉에 응답하지 않았으면 먼저 기본 응답(`resolve`)을 적용합니다.
   * 예산을 넘은 몸-몸 접촉은 건너뜁니다(`stats.skippedPairs`). 표면 접촉은 예산과 무관합니다.
   * @param {ContactEvent} ev
   */
  next(ev) {
    if (this.#state === FILLING) {
      this.#prepare();
    } else if (this.#state !== RUNNING) {
      if (this.#state === DONE) {
        return false;
      }
      throw new Error("ContactSolver.next needs begin() first.");
    }
    const PENDING = this.#pending;
    if (PENDING !== null && !PENDING.handled) {
      this.resolve(PENDING);
    }
    this.#pending = null;
    for (; ; ) {
      while (this.#cursor < this.#orderLength) {
        const C = this.#order[this.#cursor++], I = this.#cI[C], J = this.#cJ[C];
        if (J >= 0) {
          if (I === this.#lastI && J === this.#lastJ) {
            continue;
          }
          this.#lastI = I;
          this.#lastJ = J;
          if (!(this.#pairsLeft > 0)) {
            this.stats.skippedPairs++;
            continue;
          }
          this.#pairsLeft--;
          this.stats.pairContacts++;
        } else {
          this.stats.surfaceContacts++;
        }
        const REPEATS = this.#elapsed <= SAME_TIME ? this.#repeat(C) : 0;
        ev.i = I;
        ev.j = J;
        ev.nx = this.#cNx[C];
        ev.ny = this.#cNy[C];
        ev.t = this.#now;
        ev.key = this.#cKey[C];
        ev.obstacle = this.#cObstacle[C];
        ev.repeats = REPEATS;
        ev.stuck = REPEATS >= this.maxZeroTimeRepeats;
        ev.response = RESPONSE_NONE;
        ev.impulse = 0;
        ev.handled = false;
        this.#pending = ev;
        return true;
      }
      if (this.#orderLength > 0) {
        this.#finishGroup();
      }
      if (!this.#startGroup()) {
        this.#state = DONE;
        return false;
      }
    }
  }
  /** 기본 응답: 표면 = 동적 몸 반사(`restitution`)·조향 몸 미끄러짐, 쌍 = 교환(조향끼리는 둘 다 미끄러짐), 한도 = 멈춤·붙기. */
  resolve(ev) {
    const FLAGS = this.#bodies.flags, I = ev.i, J = ev.j;
    if (J < 0) {
      if (ev.stuck) {
        this.#stop(ev);
      } else if (FLAGS[I] & DYNAMIC) {
        this.reflect(ev, this.restitution);
      } else {
        this.#slide(I, ev.nx, ev.ny, ev.key);
        ev.response = RESPONSE_SLIDE;
      }
    } else if (ev.stuck) {
      this.#stick(ev);
    } else if ((FLAGS[I] | FLAGS[J]) & DYNAMIC) {
      this.exchange(ev, this.restitution, 1, 1);
    } else {
      this.#slide(I, ev.nx, ev.ny, contactKey(CONTACT_USER, J));
      this.#slide(J, -ev.nx, -ev.ny, contactKey(CONTACT_USER, I));
      ev.response = RESPONSE_SLIDE;
    }
    ev.handled = true;
  }
  /** 접근 속도(양수면 다가옴): 표면은 -(v_i · n), 쌍은 -((v_i - v_j) · n). 응답 전에 읽습니다. */
  closing(ev) {
    const B = this.#bodies, I = ev.i, J = ev.j;
    return J < 0 ? -(B.vx[I] * ev.nx + B.vy[I] * ev.ny) : -((B.vx[I] - B.vx[J]) * ev.nx + (B.vy[I] - B.vy[J]) * ev.ny);
  }
  /**
   * 쌍의 반발 `restitution` 운동량 교환. 조향 몸은 그 자리에서 동적 몸으로 바뀝니다(지금 속도를 충격 속도로 잡고 잔여
   * 변위를 넘김). 맞은 쪽 충격량에 `gainI`·`gainJ`를 곱합니다. 주고받은 충격량 J를 돌려주고, 이미 멀어지는 쌍이면
   * 아무것도 바꾸지 않고 0입니다.
   */
  exchange(ev, restitution, gainI = 1, gainJ = 1) {
    const B = this.#bodies, I = ev.i, J = ev.j, NX = ev.nx, NY = ev.ny;
    ev.handled = true;
    const VIX = B.vx[I], VIY = B.vy[I], VJX = B.vx[J], VJY = B.vy[J], RELATIVE = (VIX - VJX) * NX + (VIY - VJY) * NY;
    if (RELATIVE >= 0) {
      ev.response = RESPONSE_NONE;
      ev.impulse = 0;
      return 0;
    }
    const HAD_I = (B.flags[I] & DYNAMIC) !== 0, HAD_J = (B.flags[J] & DYNAMIC) !== 0;
    this.#setImpact(I, VIX, VIY);
    this.#setImpact(J, VJX, VJY);
    const IMPULSE = -(1 + restitution) * RELATIVE / (1 / B.mass[I] + 1 / B.mass[J]);
    this.#push(I, IMPULSE * NX * gainI, IMPULSE * NY * gainI);
    this.#push(J, -IMPULSE * NX * gainJ, -IMPULSE * NY * gainJ);
    if (!HAD_I) {
      this.#takeRemainder(I);
    }
    if (!HAD_J) {
      this.#takeRemainder(J);
    }
    B.vx[I] = B.ivx[I] / this.#fp;
    B.vy[I] = B.ivy[I] / this.#fp;
    B.vx[J] = B.ivx[J] / this.#fp;
    B.vy[J] = B.ivy[J] / this.#fp;
    ev.response = RESPONSE_EXCHANGE;
    ev.impulse = IMPULSE;
    return IMPULSE;
  }
  /** 동적 몸 `i`의 표면 반사: 충격 속도를 지금 속도로 맞춘 뒤 안쪽 성분을 `restitution`으로 되돌립니다(잔여 변위도). */
  reflect(ev, restitution) {
    const B = this.#bodies, I = ev.i;
    if (ev.j >= 0 || !(B.flags[I] & DYNAMIC)) {
      throw new TypeError("ContactSolver.reflect needs a surface contact of a DYNAMIC body.");
    }
    ev.handled = true;
    this.#setImpact(I, B.vx[I], B.vy[I]);
    this.#removeInward(I, ev.nx, ev.ny, restitution);
    B.vx[I] = B.ivx[I] / this.#fp;
    B.vy[I] = B.ivy[I] / this.#fp;
    ev.response = RESPONSE_REFLECT;
  }
  /**
   * 0초 반복에 걸린 쌍에서 `moveI`·`moveJ`로 표시한 동적 몸만 상대 접근 속도를 각자의 반발 계수로 되돌려 튕깁니다(둘 다면
   * 반씩). 붙지 않습니다. 이미 멀어지면 아무것도 바꾸지 않습니다. 궤적 속도는 반올림하지 않습니다(다음 cast가 떨어짐을 봄).
   */
  bounce(ev, moveI, moveJ, restitutionI, restitutionJ = restitutionI) {
    const B = this.#bodies, I = ev.i, J = ev.j, NX = ev.nx, NY = ev.ny;
    if (J < 0 || moveI && !(B.flags[I] & DYNAMIC) || moveJ && !(B.flags[J] & DYNAMIC)) {
      throw new TypeError("ContactSolver.bounce needs a pair whose moving bodies are DYNAMIC.");
    }
    ev.handled = true;
    const CLOSING = (B.vx[I] - B.vx[J]) * NX + (B.vy[I] - B.vy[J]) * NY;
    if (CLOSING >= 0) {
      ev.response = RESPONSE_NONE;
      return;
    }
    const SHARE = moveI && moveJ ? 0.5 : 1;
    for (let side = 0; side < 2; side++) {
      if (!(side === 0 ? moveI : moveJ)) {
        continue;
      }
      const K = side === 0 ? I : J, CHANGE = -(1 + (side === 0 ? restitutionI : restitutionJ)) * CLOSING * SHARE * (side === 0 ? 1 : -1);
      B.vx[K] += CHANGE * NX;
      B.vy[K] += CHANGE * NY;
      this.#setImpact(K, B.vx[K], B.vy[K]);
    }
    ev.response = RESPONSE_BOUNCE;
  }
  /** 게임이 스텝 중 `vx`·`vy`·`flags`를 직접 고친 몸을 지금 묶음이 끝날 때 다시 cast하게 합니다. */
  touched(i) {
    this.#involved[i] = this.#stamp;
  }
  /**
   * 남은 접촉을 기본 응답으로 마저 풀고(응답하지 않은 접촉 포함) 모든 몸을 dt까지 옮기고(조향 몸은 소수 잔여를 반올림으로
   * 정산해 막히지 않았으면 조향 끝점에 섬), 움직인 몸을 지형 밖으로 복구합니다. 결과: `x`·`y`(격자 정수), `vx`·`vy`, 동적 몸의 `ivx`·`ivy`·`rx`·`ry`, 새로 동적이 된 몸의 `flags`.
   */
  end() {
    if (this.#state === FILLING) {
      this.#prepare();
    }
    if (this.#state === RUNNING) {
      const EV = this.#drain;
      while (this.next(EV)) {
        this.resolve(EV);
      }
    }
    if (this.#state !== DONE) {
      throw new Error("ContactSolver.end needs begin() first.");
    }
    const B = this.#bodies, N = B.count, FP = this.#fp, RESULT = this.#motion;
    this.#now = this.#dt;
    for (let i = 0; i < N; i++) {
      this.#advance(i);
      if (!(B.flags[i] & DYNAMIC)) {
        B.x[i] += Math.round(this.#fracX[i]);
        B.y[i] += Math.round(this.#fracY[i]);
        this.#fracX[i] = 0;
        this.#fracY[i] = 0;
      }
    }
    for (let i = 0; i < N; i++) {
      if (!(B.flags[i] & ACTIVE)) {
        continue;
      }
      const X = B.x[i] / FP, Y = B.y[i] / FP;
      this.#surface.solve(X, Y, X, Y, B.radius[i], null, "project", B.key[i], RESULT);
      B.x[i] = Math.round(RESULT.x * FP);
      B.y[i] = Math.round(RESULT.y * FP);
    }
    this.#state = IDLE;
  }
  #drain = new ContactEvent();
  /**
   * 위치 겹침 풀기(`end` 뒤). SOFT 쌍은 질량비로 침투의 `softFraction`만큼 모아 몸별 `softCap`으로 자른 뒤 함께 옮기고(Jacobi),
   * SOLID 쌍은 침투한 쪽(틱 시작부터 상대 쪽으로 더 움직인 쪽)을 완전히 밀어냅니다(쌍 키 순서로 차례로). 각 단계가 끝나면
   * 옮긴 몸을 단계 시작 자리에서 지형을 따라 다시 풀어 벽 안으로 들어가지 않게 합니다. 옮긴 몸 수를 돌려줍니다.
   */
  separate() {
    const B = this.#bodies, N = B.count;
    if (N === 0) {
      return 0;
    }
    let maxRadius = 0;
    for (let i = 0; i < N; i++) {
      this.#radiusFP[i] = Math.round(B.radius[i] * this.#fp);
      if (B.flags[i] & SEPARATE && this.#radiusFP[i] > maxRadius) {
        maxRadius = this.#radiusFP[i];
      }
    }
    this.#separationGridFresh = false;
    this.#copyPositions();
    let soft = 0;
    for (let pass = 0; pass < this.#softPasses; pass++) {
      const MOVED = this.#softPass(maxRadius);
      soft += MOVED;
      if (!MOVED) {
        break;
      }
    }
    if (soft) {
      this.#constrainMoved();
    }
    this.#copyPositions();
    let hard = 0;
    for (let pass = 0; pass < this.#hardPasses; pass++) {
      const MOVED = this.#hardPass(maxRadius);
      hard += MOVED;
      if (!MOVED) {
        break;
      }
    }
    if (hard) {
      this.#constrainMoved();
    }
    this.stats.softMoves = soft;
    this.stats.hardMoves = hard;
    return soft + hard;
  }
  #checkBudget() {
    const BUDGET = this.pairBudget;
    if (!(BUDGET === Infinity || Number.isSafeInteger(BUDGET) && BUDGET >= 0)) {
      throw new RangeError("ContactSolver pairBudget must be an integer >= 0 or Infinity.");
    }
  }
  #growBodies(count) {
    if (this.#capacity >= count) {
      return;
    }
    const CAPACITY = Math.max(count, this.#capacity * 2, 64);
    this.#base = new Float64Array(CAPACITY);
    this.#fracX = new Float64Array(CAPACITY);
    this.#fracY = new Float64Array(CAPACITY);
    this.#involved = new Int32Array(CAPACITY);
    this.#recast = new Int32Array(CAPACITY);
    this.#startX = new Int32Array(CAPACITY);
    this.#startY = new Int32Array(CAPACITY);
    this.#segX = new Int32Array(CAPACITY);
    this.#segY = new Int32Array(CAPACITY);
    this.#stageX = new Int32Array(CAPACITY);
    this.#stageY = new Int32Array(CAPACITY);
    this.#radiusFP = new Int32Array(CAPACITY);
    this.#sumX = new Int32Array(CAPACITY);
    this.#sumY = new Int32Array(CAPACITY);
    this.#counts = new Int32Array(CAPACITY);
    this.#candidates = new Int32Array(CAPACITY);
    this.#head = new Int32Array(CAPACITY);
    this.#earliest = new Float64Array(CAPACITY);
    this.#capacity = CAPACITY;
    this.#stamp = 0;
  }
  #growPool(capacity) {
    const OLD = this.#poolCapacity;
    const GROW = (array, type) => {
      const NEXT = new type(capacity);
      NEXT.set(array);
      return NEXT;
    };
    this.#cT = GROW(this.#cT, Float64Array);
    this.#cI = GROW(this.#cI, Int32Array);
    this.#cJ = GROW(this.#cJ, Int32Array);
    this.#cNx = GROW(this.#cNx, Float64Array);
    this.#cNy = GROW(this.#cNy, Float64Array);
    this.#cKey = GROW(this.#cKey, Float64Array);
    this.#cSortA = GROW(this.#cSortA, Float64Array);
    this.#cSortB = GROW(this.#cSortB, Float64Array);
    this.#cNext = GROW(this.#cNext, Int32Array);
    this.#order = GROW(this.#order, Int32Array);
    this.#orderScratch = new Int32Array(capacity);
    for (let c = capacity - 1; c >= OLD; c--) {
      this.#cNext[c] = this.#free;
      this.#free = c;
      this.#cObstacle[c] = null;
    }
    this.#poolCapacity = capacity;
  }
  // 표면 접촉 키(< 2^52)와 쌍 키 -(큰 번호 + 1)을 Float64로, 몸·작은 번호를 Int32로 둡니다. 비교는 두 값의 정확한 일치입니다.
  #growRepeats(capacity) {
    const OLD_A = this.#repeatA, OLD_B = this.#repeatB, OLD_COUNT = this.#repeatCount, OLD_EPOCH = this.#repeatEpoch, OLD_NOW = this.#repeatEpochNow;
    this.#repeatA = new Int32Array(capacity);
    this.#repeatB = new Float64Array(capacity);
    this.#repeatCount = new Int32Array(capacity);
    this.#repeatEpoch = new Uint32Array(capacity);
    this.#repeatEpochNow = 1;
    this.#repeatUsed = 0;
    for (let s = 0; s < OLD_A.length; s++) {
      if (OLD_EPOCH[s] === OLD_NOW) {
        this.#repeatSlot(OLD_A[s], OLD_B[s]);
        this.#repeatCount[this.#lastSlot] = OLD_COUNT[s];
      }
    }
  }
  #lastSlot = 0;
  // (a, b)의 칸을 찾거나 만들고 `#lastSlot`에 둡니다(새 칸은 횟수 0).
  #repeatSlot(a, b) {
    const MASK = this.#repeatA.length - 1, POSITIVE = b < 0 ? -b : b;
    let h = Math.imul(a ^ 668265263, 2654435761) ^ POSITIVE % TWO_32;
    h = Math.imul(h ^ Math.floor(POSITIVE / TWO_32) ^ (b < 0 ? 1540483477 : 0), 2246822507);
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    let s = h & MASK;
    const EPOCH = this.#repeatEpochNow;
    while (this.#repeatEpoch[s] === EPOCH) {
      if (this.#repeatA[s] === a && this.#repeatB[s] === b) {
        this.#lastSlot = s;
        return;
      }
      s = s + 1 & MASK;
    }
    this.#repeatEpoch[s] = EPOCH;
    this.#repeatA[s] = a;
    this.#repeatB[s] = b;
    this.#repeatCount[s] = 0;
    this.#repeatUsed++;
    this.#lastSlot = s;
  }
  #clearRepeats() {
    this.#repeatUsed = 0;
    if (++this.#repeatEpochNow > 4294967280) {
      this.#repeatEpoch.fill(0);
      this.#repeatEpochNow = 1;
    }
  }
  #repeat(c) {
    if (this.#repeatUsed * 2 >= this.#repeatA.length) {
      this.#growRepeats(this.#repeatA.length * 2);
    }
    if (this.#cJ[c] >= 0) {
      this.#repeatSlot(this.#cSortA[c], -(this.#cSortB[c] + 1));
    } else {
      this.#repeatSlot(this.#cI[c], this.#cKey[c]);
    }
    return ++this.#repeatCount[this.#lastSlot];
  }
  // 몸 b의 접촉 기록을 모두 잊습니다.
  #release(b) {
    for (let c = this.#head[b]; c >= 0; ) {
      const NEXT = this.#cNext[c];
      this.#cObstacle[c] = null;
      this.#cNext[c] = this.#free;
      this.#free = c;
      c = NEXT;
    }
    this.#head[b] = -1;
    this.#earliest[b] = Infinity;
  }
  // 몸 b의 가장 이른 접촉(1e-9 창)이면 기록하고, 더 이르면 그전 기록을 버립니다. 시각은 cast 시작 시각(`#castNow`) +
  // clamp(hit.t) · 남은 길이(`#castSpan`), 쌍(j ≥ 0)은 접촉 키 0·장애물 null입니다. 부동소수 값을 인자로 넘기지 않습니다(상자 할당).
  #keep(b, i, j, hit) {
    const TIME = this.#castNow + Math.max(0, Math.min(1, hit.t)) * this.#castSpan, PAIR = j >= 0;
    if (TIME < this.#earliest[b] - SAME_TIME) {
      this.#release(b);
      this.#earliest[b] = TIME;
    } else if (Math.abs(TIME - this.#earliest[b]) > SAME_TIME) {
      return;
    }
    if (this.#free < 0) {
      this.#growPool(this.#poolCapacity * 2);
    }
    const C = this.#free;
    this.#free = this.#cNext[C];
    this.#cT[C] = TIME;
    this.#cI[C] = i;
    this.#cJ[C] = j;
    this.#cNx[C] = hit.nx;
    this.#cNy[C] = hit.ny;
    this.#cKey[C] = PAIR ? 0 : hit.key;
    this.#cObstacle[C] = PAIR ? null : hit.obstacle;
    this.#cSortA[C] = PAIR ? Math.min(i, j) : i;
    this.#cSortB[C] = PAIR ? Math.max(i, j) : hit.key;
    this.#cNext[C] = this.#head[b];
    this.#head[b] = C;
  }
  // 같은 시각 접촉의 순서: 표면 먼저(몸, 접촉 키), 다음 쌍(작은 번호, 큰 번호), 마지막으로 i. 같으면 모은 순서(안정).
  #compare(a, b) {
    return (this.#cJ[a] < 0 ? 0 : 1) - (this.#cJ[b] < 0 ? 0 : 1) || this.#cSortA[a] - this.#cSortA[b] || this.#cSortB[a] - this.#cSortB[b] || this.#cI[a] - this.#cI[b];
  }
  #sortOrder(length) {
    let from = this.#order, to = this.#orderScratch;
    for (let width = 1; width < length; width *= 2) {
      for (let lo = 0; lo < length; lo += width * 2) {
        const MID = Math.min(lo + width, length), HI = Math.min(lo + width * 2, length);
        let a = lo, b = MID, k = lo;
        while (a < MID && b < HI) {
          to[k++] = this.#compare(from[a], from[b]) <= 0 ? from[a++] : from[b++];
        }
        while (a < MID) {
          to[k++] = from[a++];
        }
        while (b < HI) {
          to[k++] = from[b++];
        }
      }
      const SWAP = from;
      from = to;
      to = SWAP;
    }
    if (from !== this.#order) {
      for (let k = 0; k < length; k++) {
        this.#order[k] = from[k];
      }
    }
  }
  #prepare() {
    this.#checkBudget();
    const B = this.#bodies, N = B.count, FP = this.#fp, DT = this.#dt, GRID = this.#grid;
    GRID.clear();
    this.#separationGridFresh = false;
    this.#maxRadius = 0;
    this.#speedBound = 0;
    for (let i = 0; i < N; i++) {
      const FLAGS = B.flags[i];
      if (!(FLAGS & DYNAMIC)) {
        B.ivx[i] = 0;
        B.ivy[i] = 0;
        B.rx[i] = 0;
        B.ry[i] = 0;
      }
      B.vx[i] = (B.steerX[i] - B.x[i]) / FP / DT + B.ivx[i] / FP;
      B.vy[i] = (B.steerY[i] - B.y[i]) / FP / DT + B.ivy[i] / FP;
      this.#startX[i] = B.x[i];
      this.#startY[i] = B.y[i];
      this.#fracX[i] = 0;
      this.#fracY[i] = 0;
      this.#base[i] = 0;
      this.#head[i] = -1;
      this.#earliest[i] = Infinity;
      if (FLAGS & ACTIVE) {
        GRID.insert(i, B.x[i], B.y[i]);
        if (B.radius[i] > this.#maxRadius) {
          this.#maxRadius = B.radius[i];
        }
        this.#speedBound = Math.max(this.#speedBound, Math.sqrt(B.vx[i] * B.vx[i] + B.vy[i] * B.vy[i]));
      }
    }
    this.#free = -1;
    for (let c = this.#poolCapacity - 1; c >= 0; c--) {
      this.#cNext[c] = this.#free;
      this.#cObstacle[c] = null;
      this.#free = c;
    }
    this.#clearRepeats();
    this.#pairsLeft = this.pairBudget;
    this.#now = 0;
    this.#elapsed = 0;
    this.#orderLength = 0;
    this.#cursor = 0;
    this.#state = RUNNING;
    for (let i = 0; i < N; i++) {
      this.#castBody(i);
    }
  }
  // 가장 이른 접촉 시각의 묶음을 모으고 그 몸들을 그 시각까지 옮깁니다. 접촉이 없으면 false.
  #startGroup() {
    const N = this.#bodies.count;
    let first = Infinity;
    for (let b = 0; b < N; b++) {
      if (this.#head[b] >= 0 && this.#earliest[b] < first) {
        first = this.#earliest[b];
      }
    }
    this.#orderLength = 0;
    this.#cursor = 0;
    if (first === Infinity) {
      return false;
    }
    this.#elapsed = first - this.#now;
    this.#now = first;
    if (this.#elapsed > SAME_TIME) {
      this.#clearRepeats();
    }
    this.stats.groups++;
    const STAMP = ++this.#stamp;
    let length = 0;
    for (let b = 0; b < N; b++) {
      if (this.#head[b] >= 0 && this.#earliest[b] <= first + SAME_TIME) {
        for (let c = this.#head[b]; c >= 0; c = this.#cNext[c]) {
          this.#order[length++] = c;
        }
      }
    }
    this.#sortOrder(length);
    this.#orderLength = length;
    for (let q = 0; q < length; q++) {
      const C = this.#order[q], I = this.#cI[C], J = this.#cJ[C];
      this.#involved[I] = STAMP;
      this.#advance(I);
      if (J >= 0) {
        this.#involved[J] = STAMP;
        this.#advance(J);
      }
    }
    this.#lastI = -1;
    this.#lastJ = -1;
    return true;
  }
  // 묶음에 응답한 몸과 그 몸에 접촉을 걸어 둔 몸만 다시 cast합니다.
  #finishGroup() {
    const N = this.#bodies.count, STAMP = this.#stamp, INVOLVED = this.#involved, RECAST = this.#recast;
    for (let b = 0; b < N; b++) {
      let mark = INVOLVED[b] === STAMP;
      for (let c = this.#head[b]; !mark && c >= 0; c = this.#cNext[c]) {
        mark = INVOLVED[this.#cI[c]] === STAMP || this.#cJ[c] >= 0 && INVOLVED[this.#cJ[c]] === STAMP;
      }
      RECAST[b] = mark ? STAMP : 0;
    }
    for (let b = 0; b < N; b++) {
      if (RECAST[b] === STAMP) {
        this.#advance(b);
        this.#castBody(b);
      }
    }
    this.#orderLength = 0;
    this.#cursor = 0;
  }
  // 몸 i를 자기 시간 기준점에서 지금 시각(`#now`)까지 직선으로 옮깁니다. 격자 정수 위치 + 잔여 변위(동적 몸은 정수, 조향
  // 몸은 소수). 시각을 인자로 넘기지 않는 것은 인라인되지 않은 호출의 부동소수 인자가 틱마다 상자(HeapNumber)를 만들기 때문입니다.
  #advance(i) {
    const B = this.#bodies, TIME = this.#now, ELAPSED = TIME - this.#base[i];
    this.#base[i] = TIME;
    if (!(ELAPSED > 0) || !(B.flags[i] & ACTIVE)) {
      return;
    }
    const FP = this.#fp, SCALE = this.#remainderScale, DYNAMIC_BODY = (B.flags[i] & DYNAMIC) !== 0, RX = DYNAMIC_BODY ? B.rx[i] / SCALE : this.#fracX[i], RY = DYNAMIC_BODY ? B.ry[i] / SCALE : this.#fracY[i], DX = B.vx[i] * FP * ELAPSED + RX, DY = B.vy[i] * FP * ELAPSED + RY, SX = Math.trunc(DX), SY = Math.trunc(DY);
    if (DYNAMIC_BODY) {
      B.rx[i] = Math.round((DX - SX) * SCALE);
      B.ry[i] = Math.round((DY - SY) * SCALE);
    } else {
      this.#fracX[i] = DX - SX;
      this.#fracY[i] = DY - SY;
    }
    B.x[i] += SX;
    B.y[i] += SY;
  }
  // 높이로 갈린 쌍인지(한쪽이 VERTICAL일 때만): 한쪽 바닥이 다른 쪽 바닥 + 그쪽 지름 이상.
  #separated(a, b) {
    const B = this.#bodies;
    if (!((B.flags[a] | B.flags[b]) & VERTICAL)) {
      return false;
    }
    return B.z[a] >= B.z[b] + 2 * B.radius[b] || B.z[b] >= B.z[a] + 2 * B.radius[a];
  }
  // 두 key의 정수 8방향(NORMAL_SCALE 배율), 작은 key → 큰 key. 결과는 #normalX/#normalY.
  #fallback(a, b) {
    const B = this.#bodies, NA = B.key[a], NB = B.key[b], LO = Math.min(NA, NB), HI = Math.max(NA, NB), D = pairHash(LO, HI) & 7, SIGN = NA === LO ? 1 : -1;
    this.#normalX = SIGN * NORMAL_X[D];
    this.#normalY = SIGN * NORMAL_Y[D];
  }
  #normalX = 0;
  #normalY = 0;
  // 지금 cast의 시작 시각과 남은 길이(초). #keep이 접촉 시각을 계산합니다.
  #castNow = 0;
  #castSpan = 0;
  // 지금 시각(`#now`, 자기 시간 기준점)에 있는 몸 i를 남은 틱 동안 cast해 가장 이른 접촉을 기록합니다: 표면, 그다음 SOLID 관계의 몸.
  // 쌍은 (동적 몸, 상대)로 cast하고 둘 다 같은 종류면 작은 번호가 먼저입니다(어느 쪽이 cast하든 같은 식).
  #castBody(i) {
    const NOW = this.#now, B = this.#bodies, FP = this.#fp, END = this.#dt;
    this.#release(i);
    const SPAN = END - NOW, FLAGS = B.flags[i];
    if (!(FLAGS & ACTIVE) || SPAN <= SAME_TIME) {
      return;
    }
    this.stats.casts++;
    this.#castNow = NOW;
    this.#castSpan = SPAN;
    const VX = B.vx, VY = B.vy, SPEED = Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i]);
    if (SPEED > this.#speedBound) {
      this.#speedBound = SPEED;
    }
    const DX = VX[i] * SPAN, DY = VY[i] * SPAN, X = B.x[i] / FP, Y = B.y[i] / FP, HIT = this.#hit;
    if (Math.abs(DX) + Math.abs(DY) > SAME_TIME && this.#surface.cast(X, Y, DX, DY, B.radius[i], null, HIT) && VX[i] * HIT.nx + VY[i] * HIT.ny < INWARD) {
      this.#keep(i, i, -1, HIT);
    }
    if (!(this.#pairsLeft > 0) || !(FLAGS & PAIRS)) {
      return;
    }
    const REACH = Math.ceil((SPEED * SPAN + this.#speedBound * END + B.radius[i] + this.#maxRadius) * FP + 2), CANDIDATES = this.#candidates, COUNT = this.#grid.queryRectInto(
      B.x[i] - REACH,
      B.y[i] - REACH,
      B.x[i] + REACH,
      B.y[i] + REACH,
      CANDIDATES
    );
    for (let k = 1; k < COUNT; k++) {
      const VALUE = CANDIDATES[k];
      let m = k - 1;
      while (m >= 0 && CANDIDATES[m] > VALUE) {
        CANDIDATES[m + 1] = CANDIDATES[m];
        m--;
      }
      CANDIDATES[m + 1] = VALUE;
    }
    const RELATIONS = this.#relations, GROUPS = this.#groups, ROW = B.group[i] * GROUPS, BASE = this.#base, PAIR_HIT = this.#pairHit, DYNAMIC_I = FLAGS & DYNAMIC;
    for (let k = 0; k < COUNT; k++) {
      const J = CANDIDATES[k];
      if (J === i || !(B.flags[J] & PAIRS) || RELATIONS[ROW + B.group[J]] !== SOLID || this.#separated(i, J)) {
        continue;
      }
      const DYNAMIC_J = B.flags[J] & DYNAMIC, A = (DYNAMIC_I ? 1 : 0) === (DYNAMIC_J ? 1 : 0) ? Math.min(i, J) : DYNAMIC_I ? i : J, O = A === i ? J : i, AX = B.x[A] / FP + VX[A] * (NOW - BASE[A]), AY = B.y[A] / FP + VY[A] * (NOW - BASE[A]), OX = B.x[O] / FP + VX[O] * (NOW - BASE[O]), OY = B.y[O] / FP + VY[O] * (NOW - BASE[O]);
      if (!SweptCircleContact.cast(
        AX - OX,
        AY - OY,
        (VX[A] - VX[O]) * SPAN,
        (VY[A] - VY[O]) * SPAN,
        B.radius[A] + B.radius[O],
        SweptCircleContact.policies.relative,
        PAIR_HIT
      )) {
        continue;
      }
      if (PAIR_HIT.degenerate) {
        this.#fallback(A, O);
        PAIR_HIT.nx = this.#normalX / NORMAL_SCALE;
        PAIR_HIT.ny = this.#normalY / NORMAL_SCALE;
      }
      if ((VX[A] - VX[O]) * PAIR_HIT.nx + (VY[A] - VY[O]) * PAIR_HIT.ny < INWARD) {
        this.#keep(i, A, O, PAIR_HIT);
      }
    }
  }
  // 몸 i의 충격 속도를 궤적 속도 (vx, vy)로 맞춥니다(조향 몸은 동적으로 바뀜). 쌀콩팡 applyImpulse의 Δv = J / m 반올림 식.
  #setImpact(i, vx, vy) {
    const B = this.#bodies, FP = this.#fp, MASS = B.mass[i];
    B.ivx[i] += Math.round((vx - B.ivx[i] / FP) * MASS / MASS * FP);
    B.ivy[i] += Math.round((vy - B.ivy[i] / FP) * MASS / MASS * FP);
    B.flags[i] |= DYNAMIC;
  }
  // 충격량 (jx, jy)를 충격 속도에 더합니다(1/FP 반올림).
  #push(i, jx, jy) {
    const B = this.#bodies, FP = this.#fp, MASS = B.mass[i];
    B.ivx[i] += Math.round(jx / MASS * FP);
    B.ivy[i] += Math.round(jy / MASS * FP);
  }
  // 동적이 된 조향 몸의 소수 잔여 변위를 정수 잔여로 넘깁니다.
  #takeRemainder(i) {
    const B = this.#bodies, SCALE = this.#remainderScale;
    B.rx[i] = Math.round(this.#fracX[i] * SCALE);
    B.ry[i] = Math.round(this.#fracY[i] * SCALE);
  }
  // 충격 속도의 안쪽 성분을 (1 + e)배로 되돌리고, 반올림이 남긴 안쪽 성분과 안쪽 잔여 변위를 지웁니다.
  #removeInward(i, nx, ny, restitution) {
    const B = this.#bodies, INWARD_SPEED = B.ivx[i] * nx + B.ivy[i] * ny;
    if (INWARD_SPEED >= 0) {
      return;
    }
    const FACTOR = 1 + restitution;
    B.ivx[i] = Math.round(B.ivx[i] - FACTOR * INWARD_SPEED * nx);
    B.ivy[i] = Math.round(B.ivy[i] - FACTOR * INWARD_SPEED * ny);
    const RESIDUAL = B.ivx[i] * nx + B.ivy[i] * ny;
    if (RESIDUAL < 0) {
      if (Math.abs(nx) >= Math.abs(ny)) {
        B.ivx[i] += Math.sign(nx) * Math.ceil(-RESIDUAL / Math.abs(nx));
      } else {
        B.ivy[i] += Math.sign(ny) * Math.ceil(-RESIDUAL / Math.abs(ny));
      }
    }
    const REMAINDER = B.rx[i] * nx + B.ry[i] * ny;
    if (REMAINDER < 0) {
      B.rx[i] = Math.round(B.rx[i] - REMAINDER * nx);
      B.ry[i] = Math.round(B.ry[i] - REMAINDER * ny);
    }
  }
  // 조향 몸 i가 법선 (nx, ny) 접촉을 따라 미끄러집니다(목표 = 지금 방향, 길이 유지). 1/FP 격자로 반올림한 뒤 안쪽 성분 제거.
  #slide(i, nx, ny, key) {
    const B = this.#bodies, FP = this.#fp, VX = B.vx[i], VY = B.vy[i], LIST = this.#slideList.clear(), OUT = this.#slideOut;
    LIST.add(nx, ny, 0, key);
    SurfaceContactGeometry.slide(VX, VY, LIST, Math.hypot(VX, VY), true, VX, VY, B.key[i], null, OUT);
    let sx = Math.round(OUT.x * FP), sy = Math.round(OUT.y * FP);
    const INWARD_SPEED = sx * nx + sy * ny;
    if (INWARD_SPEED < 0) {
      const FACTOR = 1 + this.restitution;
      sx = Math.round(sx - FACTOR * INWARD_SPEED * nx);
      sy = Math.round(sy - FACTOR * INWARD_SPEED * ny);
      const RESIDUAL = sx * nx + sy * ny;
      if (RESIDUAL < 0) {
        if (Math.abs(nx) >= Math.abs(ny)) {
          sx += Math.sign(nx) * Math.ceil(-RESIDUAL / Math.abs(nx));
        } else {
          sy += Math.sign(ny) * Math.ceil(-RESIDUAL / Math.abs(ny));
        }
      }
    }
    B.vx[i] = sx / FP;
    B.vy[i] = sy / FP;
  }
  // 0초 반복 한도의 표면 접촉: 동적 몸은 충격 속도를 0으로(같은 반올림 식), 궤적 속도도 0.
  #stop(ev) {
    const B = this.#bodies, I = ev.i;
    if (B.flags[I] & DYNAMIC) {
      const FP = this.#fp, MASS = B.mass[I];
      B.ivx[I] += Math.round(-B.ivx[I] / FP * MASS / MASS * FP);
      B.ivy[I] += Math.round(-B.ivy[I] / FP * MASS / MASS * FP);
    }
    B.vx[I] = 0;
    B.vy[I] = 0;
    ev.response = RESPONSE_STOP;
  }
  // 0초 반복 한도의 쌍: 질량 가중 공통 속도로 붙습니다. 동적 몸이 끼면 조향 몸도 동적으로(잔여 변위는 넘기지 않음).
  #stick(ev) {
    const B = this.#bodies, I = ev.i, J = ev.j, MA = B.mass[I], MB = B.mass[J], COMMON_X = (B.vx[I] * MA + B.vx[J] * MB) / (MA + MB), COMMON_Y = (B.vy[I] * MA + B.vy[J] * MB) / (MA + MB), PROMOTE = ((B.flags[I] | B.flags[J]) & DYNAMIC) !== 0;
    for (let side = 0; side < 2; side++) {
      const K = side === 0 ? I : J;
      if (PROMOTE) {
        if (!(B.flags[K] & DYNAMIC)) {
          B.rx[K] = 0;
          B.ry[K] = 0;
        }
        this.#setImpact(K, COMMON_X, COMMON_Y);
      }
      B.vx[K] = COMMON_X;
      B.vy[K] = COMMON_Y;
    }
    ev.response = RESPONSE_STICK;
  }
  // 단계(SOFT 전체, SOLID 전체) 시작 자리. 단계가 끝나면 여기서부터 지형을 따라 다시 풉니다.
  #copyPositions() {
    const B = this.#bodies;
    for (let i = 0; i < B.count; i++) {
      this.#stageX[i] = B.x[i];
      this.#stageY[i] = B.y[i];
    }
  }
  // 단계 시작 자리(#stageX/#stageY)에서 옮겨진 몸을 지형을 따라 다시 풉니다('project', 원본 constrain과 같은 식).
  #constrainMoved() {
    const B = this.#bodies, FP = this.#fp, RESULT = this.#motion;
    this.#separationGridFresh = false;
    for (let i = 0; i < B.count; i++) {
      if (!(B.flags[i] & SEPARATE) || B.x[i] === this.#stageX[i] && B.y[i] === this.#stageY[i]) {
        continue;
      }
      this.#surface.solve(
        this.#stageX[i] / FP,
        this.#stageY[i] / FP,
        B.x[i] / FP,
        B.y[i] / FP,
        B.radius[i],
        null,
        "project",
        B.key[i],
        RESULT
      );
      B.x[i] = Math.round(RESULT.x * FP);
      B.y[i] = Math.round(RESULT.y * FP);
    }
  }
  #rebuildSeparationGrid() {
    if (this.#separationGridFresh) {
      return;
    }
    this.#separationGridFresh = true;
    const B = this.#bodies, GRID = this.#grid;
    GRID.clear();
    for (let i = 0; i < B.count; i++) {
      if (B.flags[i] & SEPARATE) {
        GRID.insert(i, B.x[i], B.y[i]);
      }
    }
  }
  // SOFT 한 pass(Jacobi): 모든 쌍의 보정을 pass 시작 위치로 모은 뒤 함께 옮깁니다. 보정은 정수 합이라 순서와 무관합니다.
  #softPass(maxRadius) {
    const B = this.#bodies, N = B.count, FP = this.#fp, R = this.#radiusFP, SUM_X = this.#sumX, SUM_Y = this.#sumY, COUNTS = this.#counts, RELATIONS = this.#relations, GROUPS = this.#groups, FRACTION = this.#softFraction, CANDIDATES = this.#candidates;
    this.#rebuildSeparationGrid();
    SUM_X.fill(0, 0, N);
    SUM_Y.fill(0, 0, N);
    COUNTS.fill(0, 0, N);
    for (let i = 0; i < N; i++) {
      if (!(B.flags[i] & SEPARATE)) {
        continue;
      }
      const REACH = R[i] + maxRadius, COUNT = this.#grid.queryRectInto(
        B.x[i] - REACH,
        B.y[i] - REACH,
        B.x[i] + REACH,
        B.y[i] + REACH,
        CANDIDATES
      ), ROW = B.group[i] * GROUPS;
      for (let k = 0; k < COUNT; k++) {
        const J = CANDIDATES[k];
        if (J <= i || RELATIONS[ROW + B.group[J]] !== SOFT) {
          continue;
        }
        const MIN = R[i] + R[J], DX = B.x[J] - B.x[i], DY = B.y[J] - B.y[i], D2 = DX * DX + DY * DY;
        if (D2 >= MIN * MIN) {
          continue;
        }
        let nx, ny, distance;
        if (D2 === 0) {
          this.#fallback(i, J);
          nx = this.#normalX;
          ny = this.#normalY;
          distance = 0;
        } else {
          distance = Math.max(1, Math.floor(Math.sqrt(D2)));
          nx = Math.trunc(DX * NORMAL_SCALE / distance);
          ny = Math.trunc(DY * NORMAL_SCALE / distance);
        }
        const PEN = MIN - distance;
        if (PEN <= 0) {
          continue;
        }
        const SOFT_PEN = Math.max(1, Math.trunc(PEN * FRACTION)), MA = B.mass[i], MB = B.mass[J], TOTAL = Math.max(1, MA + MB), PA = Math.trunc(SOFT_PEN * MB / TOTAL), PB = SOFT_PEN - PA;
        SUM_X[i] -= Math.trunc(nx * PA / NORMAL_SCALE);
        SUM_Y[i] -= Math.trunc(ny * PA / NORMAL_SCALE);
        SUM_X[J] += Math.trunc(nx * PB / NORMAL_SCALE);
        SUM_Y[J] += Math.trunc(ny * PB / NORMAL_SCALE);
        COUNTS[i]++;
        COUNTS[J]++;
      }
    }
    const WIDTH = this.#width * FP, HEIGHT = this.#height * FP;
    let moved = 0;
    for (let i = 0; i < N; i++) {
      if (!COUNTS[i]) {
        continue;
      }
      let cx = Math.trunc(SUM_X[i] / COUNTS[i]), cy = Math.trunc(SUM_Y[i] / COUNTS[i]);
      const CAP = Math.max(1, B.softCap[i]), LENGTH2 = cx * cx + cy * cy;
      if (LENGTH2 > CAP * CAP) {
        const SCALE = CAP / Math.max(1, Math.sqrt(LENGTH2));
        cx = Math.trunc(cx * SCALE);
        cy = Math.trunc(cy * SCALE);
      }
      if (cx === 0 && cy === 0) {
        continue;
      }
      const OLD_X = B.x[i], OLD_Y = B.y[i];
      B.x[i] = Math.min(Math.max(OLD_X + cx, R[i]), WIDTH - R[i]);
      B.y[i] = Math.min(Math.max(OLD_Y + cy, R[i]), HEIGHT - R[i]);
      if (B.x[i] !== OLD_X || B.y[i] !== OLD_Y) {
        moved++;
      }
    }
    if (moved) {
      this.#separationGridFresh = false;
    }
    return moved;
  }
  // 침투한 쪽: 틱 시작 자리에서 상대 쪽으로 더 다가간 몸, 같으면 더 많이 움직인 몸, 같으면 key가 작은 몸.
  #owner(a, b) {
    const B = this.#bodies, ASX = this.#startX[a], ASY = this.#startY[a], BSX = this.#startX[b], BSY = this.#startY[b];
    let dx = BSX - ASX, dy = BSY - ASY;
    if (dx === 0 && dy === 0) {
      this.#fallback(a, b);
      dx = this.#normalX;
      dy = this.#normalY;
    }
    const AVX = B.x[a] - ASX, AVY = B.y[a] - ASY, BVX = B.x[b] - BSX, BVY = B.y[b] - BSY, APPROACH_A = AVX * dx + AVY * dy, APPROACH_B = -(BVX * dx + BVY * dy);
    if (APPROACH_A > APPROACH_B) {
      return a;
    }
    if (APPROACH_B > APPROACH_A) {
      return b;
    }
    const MOVE_A = AVX * AVX + AVY * AVY, MOVE_B = BVX * BVX + BVY * BVY;
    if (MOVE_A > MOVE_B) {
      return a;
    }
    if (MOVE_B > MOVE_A) {
      return b;
    }
    return B.key[a] <= B.key[b] ? a : b;
  }
  // SOLID 한 pass: pass 시작 위치로 축 상자(|dx|, |dy| ≤ 반경 합)가 겹치는 쌍을 모아 (침투한 쪽 · (n + 1) + 상대) 오름차순으로
  // 차례로 완전히 밀어냅니다. 상대 위치는 pass 시작 자리, 자기 위치는 앞 쌍이 옮긴 자리입니다.
  #hardPass(maxRadius) {
    const B = this.#bodies, N = B.count, FP = this.#fp, R = this.#radiusFP, RELATIONS = this.#relations, GROUPS = this.#groups, SEG_X = this.#segX, SEG_Y = this.#segY, CANDIDATES = this.#candidates;
    for (let i = 0; i < N; i++) {
      SEG_X[i] = B.x[i];
      SEG_Y[i] = B.y[i];
    }
    this.#rebuildSeparationGrid();
    const PAIR_BASE = N + 1;
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (!(B.flags[i] & SEPARATE)) {
        continue;
      }
      const REACH = R[i] + maxRadius, COUNT = this.#grid.queryRectInto(
        B.x[i] - REACH,
        B.y[i] - REACH,
        B.x[i] + REACH,
        B.y[i] + REACH,
        CANDIDATES
      ), ROW = B.group[i] * GROUPS;
      for (let k = 0; k < COUNT; k++) {
        const J = CANDIDATES[k];
        if (J <= i || RELATIONS[ROW + B.group[J]] !== SOLID) {
          continue;
        }
        const MIN = R[i] + R[J];
        if (Math.abs(B.x[i] - B.x[J]) > MIN || Math.abs(B.y[i] - B.y[J]) > MIN || this.#separated(i, J)) {
          continue;
        }
        const OWNER = this.#owner(i, J);
        if (count >= this.#pairs.length) {
          this.#growPairs(count * 2 + 64);
        }
        this.#pairs[count++] = OWNER * PAIR_BASE + (OWNER === i ? J : i);
      }
    }
    this.#sortPairs(count);
    const WIDTH = this.#width * FP, HEIGHT = this.#height * FP;
    let changed = 0;
    for (let q = 0; q < count; q++) {
      const PACKED = this.#pairs[q], I = Math.floor(PACKED / PAIR_BASE), J = PACKED - I * PAIR_BASE, MIN = R[I] + R[J], DX = B.x[I] - SEG_X[J], DY = B.y[I] - SEG_Y[J], D2 = DX * DX + DY * DY;
      if (D2 >= MIN * MIN) {
        continue;
      }
      let nx, ny, distance;
      if (D2 === 0) {
        this.#fallback(I, J);
        nx = this.#normalX;
        ny = this.#normalY;
        distance = 0;
      } else {
        distance = Math.max(1, Math.floor(Math.sqrt(D2)));
        nx = Math.trunc(DX * NORMAL_SCALE / distance);
        ny = Math.trunc(DY * NORMAL_SCALE / distance);
      }
      const PEN = MIN - distance + 1;
      B.x[I] = Math.min(Math.max(B.x[I] + Math.trunc(nx * PEN / NORMAL_SCALE), R[I]), WIDTH - R[I]);
      B.y[I] = Math.min(Math.max(B.y[I] + Math.trunc(ny * PEN / NORMAL_SCALE), R[I]), HEIGHT - R[I]);
      changed++;
    }
    if (changed) {
      this.#separationGridFresh = false;
    }
    return changed;
  }
  #growPairs(capacity) {
    const NEXT = new Float64Array(capacity);
    NEXT.set(this.#pairs);
    this.#pairs = NEXT;
    this.#pairsScratch = new Float64Array(capacity);
  }
  #sortPairs(length) {
    let from = this.#pairs, to = this.#pairsScratch;
    for (let width = 1; width < length; width *= 2) {
      for (let lo = 0; lo < length; lo += width * 2) {
        const MID = Math.min(lo + width, length), HI = Math.min(lo + width * 2, length);
        let a = lo, b = MID, k = lo;
        while (a < MID && b < HI) {
          to[k++] = from[a] <= from[b] ? from[a++] : from[b++];
        }
        while (a < MID) {
          to[k++] = from[a++];
        }
        while (b < HI) {
          to[k++] = from[b++];
        }
      }
      const SWAP = from;
      from = to;
      to = SWAP;
    }
    if (from !== this.#pairs) {
      for (let k = 0; k < length; k++) {
        this.#pairs[k] = from[k];
      }
    }
  }
};
export {
  ACTIVE,
  ContactBodies,
  ContactEvent,
  ContactSolver,
  DYNAMIC,
  PAIRS,
  PASS,
  RESPONSE_BOUNCE,
  RESPONSE_EXCHANGE,
  RESPONSE_NONE,
  RESPONSE_REFLECT,
  RESPONSE_SLIDE,
  RESPONSE_STICK,
  RESPONSE_STOP,
  SEPARATE,
  SOFT,
  SOLID,
  VERTICAL,
  pairHash
};
