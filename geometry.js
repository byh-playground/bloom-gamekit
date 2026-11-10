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
function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const ABX = bx - ax, ABY = by - ay;
  const DENOM = ABX * ABX + ABY * ABY || 1;
  let t = ((px - ax) * ABX + (py - ay) * ABY) / DENOM;
  t = Math.max(0, Math.min(1, t));
  const CX = ax + ABX * t, CY = ay + ABY * t;
  return Math.hypot(px - CX, py - CY);
}
function pointPolylineDistance(px, py, points) {
  let best = 1e9;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, pointSegmentDistance(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y));
  }
  return best;
}
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const UX = bx - ax, UY = by - ay, VX = dx - cx, VY = dy - cy, DEN = UX * VY - UY * VX;
  if (Math.abs(DEN) < 1e-10) {
    return false;
  }
  const QX = cx - ax, QY = cy - ay, T = (QX * VY - QY * VX) / DEN, S = (QX * UY - QY * UX) / DEN;
  return T >= 0 && T <= 1 && S >= 0 && S <= 1;
}
function segmentDistance(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
    return 0;
  }
  return Math.min(
    pointSegmentDistance(ax, ay, cx, cy, dx, dy),
    pointSegmentDistance(bx, by, cx, cy, dx, dy),
    pointSegmentDistance(cx, cy, ax, ay, bx, by),
    pointSegmentDistance(dx, dy, ax, ay, bx, by)
  );
}
function segmentTouchesRect(ax, ay, bx, by, x0, y0, x1, y1) {
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) {
    return false;
  }
  const DX = bx - ax, DY = by - ay;
  let pos = false, neg = false;
  for (let i = 0; i < 4; i++) {
    const X = i === 1 || i === 2 ? x1 : x0, Y = i >= 2 ? y1 : y0;
    const C = DX * (Y - ay) - DY * (X - ax);
    if (C >= -1e-9) {
      pos = true;
    }
    if (C <= 1e-9) {
      neg = true;
    }
  }
  return pos && neg;
}
function polygonTouchesRect(points, x0, y0, x1, y1) {
  for (let i = 0; i < points.length; i++) {
    const A = points[i], B = points[(i + 1) % points.length];
    if (segmentTouchesRect(A.x, A.y, B.x, B.y, x0, y0, x1, y1)) {
      return true;
    }
  }
  return false;
}
function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (pointInSimplePolygon(a[i].x, a[i].y, b)) {
      return true;
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (pointInSimplePolygon(b[i].x, b[i].y, a)) {
      return true;
    }
  }
  return boundariesCross(a, b);
}
function boundariesCross(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const P = a[i], Q = a[(i + 1) % a.length], R = b[j], T = b[(j + 1) % b.length];
      if (segmentDistance(P.x, P.y, Q.x, Q.y, R.x, R.y, T.x, T.y) < 1e-3) {
        return true;
      }
    }
  }
  return false;
}
function assignBounds(item) {
  const POINTS = item.points;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < POINTS.length; i++) {
    minX = Math.min(minX, POINTS[i].x);
    maxX = Math.max(maxX, POINTS[i].x);
    minY = Math.min(minY, POINTS[i].y);
    maxY = Math.max(maxY, POINTS[i].y);
  }
  return Object.assign(item, { minX, maxX, minY, maxY });
}
function roundedPointOnPolyline(points, t) {
  if (!Array.isArray(points) || points.length < 2) {
    return points?.[0] ? { ...points[0] } : { x: 0, y: 0 };
  }
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  const TARGET = clamp(t, 0, 1) * total;
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const LEN = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (TARGET <= acc + LEN || i === points.length - 2) {
      const Q = (TARGET - acc) / (LEN || 1);
      return {
        x: Math.round(points[i].x + (points[i + 1].x - points[i].x) * Q),
        y: Math.round(points[i].y + (points[i + 1].y - points[i].y) * Q)
      };
    }
    acc += LEN;
  }
  return { ...points[points.length - 1] };
}
function polylineTangentAt(points, t, delta = 0.015) {
  const A = roundedPointOnPolyline(points, clamp(t - delta, 0, 1)), B = roundedPointOnPolyline(points, clamp(t + delta, 0, 1));
  const DX = B.x - A.x, DY = B.y - A.y, LEN = Math.hypot(DX, DY) || 1;
  return { x: DX / LEN, y: DY / LEN };
}
function closestPolylineProgress(points, x, y) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  if (total <= 0) {
    return 0;
  }
  let acc = 0, bestD = Infinity, bestAlong = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const A = points[i], B = points[i + 1], DX = B.x - A.x, DY = B.y - A.y, LEN2 = DX * DX + DY * DY || 1;
    const LEN = Math.hypot(B.x - A.x, B.y - A.y);
    const Q = clamp(((x - A.x) * DX + (y - A.y) * DY) / LEN2, 0, 1);
    const PX = A.x + DX * Q, PY = A.y + DY * Q, D = (x - PX) * (x - PX) + (y - PY) * (y - PY);
    if (D < bestD) {
      bestD = D;
      bestAlong = acc + LEN * Q;
    }
    acc += LEN;
  }
  return clamp(bestAlong / total, 0, 1);
}
function catmullRomPoint(p0, p1, p2, p3, t) {
  const T2 = t * t, T3 = T2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * T2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * T3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * T2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * T3)
  };
}
function smoothPolylineCatmull(points, steps = 5) {
  if (!Array.isArray(points) || points.length < 2) {
    return points || [];
  }
  const OUT = [];
  for (let i = 0; i < points.length - 1; i++) {
    const P0 = points[Math.max(0, i - 1)], P1 = points[i], P2 = points[i + 1], P3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      OUT.push(catmullRomPoint(P0, P1, P2, P3, s / steps));
    }
  }
  OUT.push({ ...points[points.length - 1] });
  return OUT;
}
function insetPolygonTowardCenter(points, factor) {
  if (!Array.isArray(points) || points.length < 3) {
    return points || [];
  }
  const CX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const CY = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => ({ x: p.x + (CX - p.x) * factor, y: p.y + (CY - p.y) * factor }));
}
function polylineToRibbonPolygon(points, halfWidth, clampFn = null) {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  const LEFT = [], RIGHT = [];
  for (let i = 0; i < points.length; i++) {
    const PREV = points[Math.max(0, i - 1)], NEXT = points[Math.min(points.length - 1, i + 1)];
    const DX = NEXT.x - PREV.x, DY = NEXT.y - PREV.y, LEN = Math.hypot(DX, DY) || 1;
    const TX = DX / LEN, TY = DY / LEN, NX = -TY, NY = TX;
    let bx = points[i].x, by = points[i].y;
    if (i === 0) {
      bx -= TX * halfWidth * 0.72;
      by -= TY * halfWidth * 0.72;
    } else if (i === points.length - 1) {
      bx += TX * halfWidth * 0.72;
      by += TY * halfWidth * 0.72;
    }
    const L = { x: bx + NX * halfWidth, y: by + NY * halfWidth };
    const R = { x: bx - NX * halfWidth, y: by - NY * halfWidth };
    LEFT.push(clampFn ? clampFn(L) : L);
    RIGHT.push(clampFn ? clampFn(R) : R);
  }
  return [...LEFT, ...RIGHT.reverse()];
}
function pointDistance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}
function nearestPointDistance(point, items) {
  let best = Infinity;
  for (const ITEM of items || []) {
    best = Math.min(best, pointDistance(point, ITEM));
  }
  return best;
}
function minPairDistance(items, none = Infinity) {
  let best = Infinity;
  for (let i = 0; i < (items || []).length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      best = Math.min(best, pointDistance(items[i], items[j]));
    }
  }
  return Number.isFinite(best) ? best : none;
}

// modules/geometry/bounds-index.js
var MAX_CELLS = 1 << 22;
var BoundsIndex = class {
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
    const CELL = this.cell, COUNT = items.length;
    this.items = items;
    let col0 = Infinity, col1 = -Infinity, row0 = Infinity, row1 = -Infinity;
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
    const COLS = col1 - col0 + 1, ROWS = row1 - row0 + 1;
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
    const START = this.#start;
    let total = 0;
    for (let i = 0; i < COUNT; i++) {
      const B = items[i], X0 = Math.floor(B.minX / CELL) - col0, X1 = Math.floor(B.maxX / CELL) - col0;
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
      const B = items[i], X0 = Math.floor(B.minX / CELL) - col0, X1 = Math.floor(B.maxX / CELL) - col0;
      for (let y = Math.floor(B.minY / CELL) - row0; y <= Math.floor(B.maxY / CELL) - row0; y++) {
        for (let x = X0; x <= X1; x++) {
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
    const OUT = this.out, ITEMS = this.items;
    OUT.length = 0;
    if (!ITEMS.length) {
      return OUT;
    }
    const MIN_X = Math.min(x0, x1) - pad, MAX_X = Math.max(x0, x1) + pad, MIN_Y = Math.min(y0, y1) - pad, MAX_Y = Math.max(y0, y1) + pad;
    const BX0 = Math.max(0, Math.floor(MIN_X / this.cell) - this.#col0), BX1 = Math.min(this.#cols - 1, Math.floor(MAX_X / this.cell) - this.#col0), BY0 = Math.max(0, Math.floor(MIN_Y / this.cell) - this.#row0), BY1 = Math.min(this.#rows - 1, Math.floor(MAX_Y / this.cell) - this.#row0);
    if (!(BX0 <= BX1 && BY0 <= BY1)) {
      return OUT;
    }
    const START = this.#start, ENTRIES = this.#entries, FOUND = this.found, COLS = this.#cols;
    if (BX0 === BX1 && BY0 === BY1) {
      const END = START[BY0 * COLS + BX0 + 1];
      for (let k = START[BY0 * COLS + BX0]; k < END; k++) {
        const I = ENTRIES[k], B = ITEMS[I];
        if (B.maxX >= MIN_X && B.minX <= MAX_X && B.maxY >= MIN_Y && B.minY <= MAX_Y) {
          FOUND[OUT.length] = I;
          OUT.push(B);
        }
      }
      return OUT;
    }
    if (++this.epoch === 4294967295) {
      this.marks.fill(0);
      this.epoch = 1;
    }
    const MARKS = this.marks, EPOCH = this.epoch;
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
};

// modules/geometry/triangulation.js
var MESH_CACHE = /* @__PURE__ */ new WeakMap();
function crossAt(a, b, c) {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}
function triangulatePolygon(points) {
  let cached = MESH_CACHE.get(points);
  if (cached) {
    return cached;
  }
  const AREA = points.reduce((n, p, i) => {
    const Q = points[(i + 1) % points.length];
    return n + p.x * Q.y - Q.x * p.y;
  }, 0);
  const SIGN = AREA >= 0 ? 1 : -1;
  const CONVEX = points.every(
    (p, i) => crossAt(p, points[(i + 1) % points.length], points[(i + 2) % points.length]) * SIGN >= -1e-7
  );
  const INDICES = points.map((_, i) => i), TRIANGLES = [];
  while (INDICES.length > 3) {
    let found = false;
    for (let j = 0; j < INDICES.length; j++) {
      const A = INDICES[(j + INDICES.length - 1) % INDICES.length], B = INDICES[j], C = INDICES[(j + 1) % INDICES.length], CR = crossAt(points[A], points[B], points[C]) * SIGN;
      if (Math.abs(CR) < 1e-7) {
        INDICES.splice(j, 1);
        found = true;
        break;
      }
      if (CR < 0) {
        continue;
      }
      const CONTAINS = INDICES.some(
        (i) => i !== A && i !== B && i !== C && crossAt(points[A], points[B], points[i]) * SIGN >= -1e-7 && crossAt(points[B], points[C], points[i]) * SIGN >= -1e-7 && crossAt(points[C], points[A], points[i]) * SIGN >= -1e-7
      );
      if (CONTAINS) {
        continue;
      }
      TRIANGLES.push([A, B, C]);
      INDICES.splice(j, 1);
      found = true;
      break;
    }
    if (!found) {
      throw new Error("다각형을 삼각분할할 수 없습니다(자기 교차 또는 퇴화).");
    }
  }
  if (INDICES.length === 3) {
    TRIANGLES.push(INDICES.slice());
  }
  cached = { convex: CONVEX, triangles: TRIANGLES };
  MESH_CACHE.set(points, cached);
  return cached;
}

// modules/geometry/contact.js
var KIND_SCALE = 2 ** 50;
var OBSTACLE_SCALE = 2 ** 22;
var WORD = 2 ** 32;
var CONTACT_MAX_OBSTACLE = 2 ** 28 - 1;
var CONTACT_MAX_EDGE = 2 ** 20 - 1;
var CONTACT_POLYGON = 0;
var CONTACT_CIRCLE = 1;
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
function earlierContact(best, hit) {
  return hit && (!best || hit.t < best.t - 1e-10 || Math.abs(hit.t - best.t) <= 1e-10 && hit.key < best.key) ? hit : best;
}
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
function offerHit(best, hit) {
  if (hit.t !== Infinity) {
    offerContact(best, hit.t, hit.nx, hit.ny, hit.key, hit.obstacle, hit.degenerate);
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
      const INWARD = DISTANCE_POLICY ? vx * (LENGTH > policy.normalEpsilon ? rx / LENGTH : 1) + vy * (LENGTH > policy.normalEpsilon ? ry / LENGTH : 0) : RADIAL;
      if (INWARD >= -policy.inwardEpsilon) {
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

// modules/geometry/obstacle-field.js
var RING_COS = new Float64Array(32);
var RING_SIN = new Float64Array(32);
for (let i = 0; i < 32; i++) {
  RING_COS[i] = Math.cos(i * Math.PI / 16);
  RING_SIN[i] = Math.sin(i * Math.PI / 16);
}
function contactThreshold(r, quantum) {
  return r > 0 ? Math.max(0, r - quantum) : 1e-3;
}
function segmentBlockedBy(index, x0, y0, x1, y1, r = 0, quantum = 0) {
  const FOUND = index.query(x0, y0, x1, y1, r), THRESHOLD = contactThreshold(r, quantum);
  for (let k = 0; k < FOUND.length; k++) {
    const B = FOUND[k];
    if (pointInSimplePolygon(x0, y0, B.points) || pointInSimplePolygon(x1, y1, B.points)) {
      return true;
    }
    for (let i = 0; i < B.points.length; i++) {
      const A = B.points[i], C = B.points[(i + 1) % B.points.length];
      if (segmentDistance(x0, y0, x1, y1, A.x, A.y, C.x, C.y) < THRESHOLD) {
        return true;
      }
    }
  }
  return false;
}
function circleWithBounds(circle) {
  const ID = circle.id;
  if (!Number.isSafeInteger(ID) || ID < 0 || ID > CONTACT_MAX_OBSTACLE) {
    throw new RangeError(
      `ObstacleField circle id must be an integer from 0 to ${CONTACT_MAX_OBSTACLE} (got ${ID}).`
    );
  }
  if (typeof circle.minX !== "number") {
    circle.minX = circle.x - circle.r;
    circle.maxX = circle.x + circle.r;
    circle.minY = circle.y - circle.r;
    circle.maxY = circle.y + circle.r;
  }
  return circle;
}
var ObstacleField = class {
  /**
   * @param {object} options
   * @param {number} options.width 월드 경계 [0, width] × [0, height]. 원은 중심이 경계에서 반지름 이상 안쪽이어야 합니다.
   * @param {number} options.height
   * @param {number} options.fixedPoint 게임이 좌표를 1/fixedPoint 격자에 반올림해 저장하는 배율(예: 100). 접촉 허용 거리의 단위입니다.
   * @param {Array<{points: Array<{x: number, y: number}>}> | BoundsIndex} [options.polygons]
   *   막는 다각형. 경계(`minX` 등)가 없으면 만들어 붙입니다. 이미 만든 {@link BoundsIndex}도 받습니다. 접촉 키의 장애물 번호는
   *   색인 안의 항목 번호(배열 위치)이고, 다각형은 2^28개 이하·다각형마다 꼭짓점은 2^20개 이하여야 합니다.
   * @param {Array<{id: number, x: number, y: number, r: number}>} [options.circles] 막는 원. `id`는 0..2^28-1 정수이고 접촉 키의
   *   장애물 번호입니다. 경계가 없으면 만들어 붙입니다.
   * @param {number} [options.cell] 색인 칸 한 변의 길이(기본 256)
   * @param {{id: number, keep: (circle: object) => boolean}} [options.ignoreAll]
   *   "모두 무시" 와일드카드. 이동체가 `ignoreId`로 `id`(정수, 원 id와 겹치지 않게 보통 -1)를 내면 `keep(circle)`이 참인
   *   원(항상 막는 방벽 등)만 장애물로 보고 나머지 원은 모두 무시합니다. 없으면 와일드카드가 없습니다.
   * @param {number} [options.exteriorSearchDistance] {@link ObstacleField#nearestExterior}가 찾는 최대 거리(기본 256)
   */
  constructor({
    width,
    height,
    fixedPoint,
    polygons = [],
    circles = [],
    cell = 256,
    ignoreAll = null,
    exteriorSearchDistance = 256
  }) {
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new RangeError("ObstacleField width and height must be positive finite numbers.");
    }
    if (!(fixedPoint > 0) || !Number.isFinite(fixedPoint)) {
      throw new RangeError("ObstacleField fixedPoint must be a positive finite number.");
    }
    if (ignoreAll !== null && (typeof ignoreAll?.keep !== "function" || !Number.isSafeInteger(ignoreAll.id))) {
      throw new TypeError("ObstacleField ignoreAll must be {id: integer, keep(circle)}.");
    }
    this.width = width;
    this.height = height;
    this.fixedPoint = fixedPoint;
    this.quantum = 1 / fixedPoint;
    this.cell = cell;
    this.ignoreAll = ignoreAll;
    this.exteriorSearchDistance = exteriorSearchDistance;
    if (polygons instanceof BoundsIndex) {
      this.polygons = polygons;
    } else {
      for (const P of polygons) {
        if (typeof P.minX !== "number") {
          assignBounds(P);
        }
      }
      this.polygons = new BoundsIndex(polygons, cell);
    }
    const ITEMS = this.polygons.items;
    if (ITEMS.length > CONTACT_MAX_OBSTACLE + 1) {
      throw new RangeError(`ObstacleField supports at most ${CONTACT_MAX_OBSTACLE + 1} polygons.`);
    }
    for (let i = 0; i < ITEMS.length; i++) {
      if (ITEMS[i].points.length > CONTACT_MAX_EDGE + 1) {
        throw new RangeError(`ObstacleField polygon ${i} has more than ${CONTACT_MAX_EDGE + 1} points.`);
      }
    }
    this.active = ITEMS.length > 0;
    this.version = -1;
    this.circleIndex = null;
    this.kept = [];
    this.setCircles(circles);
  }
  /**
   * 원 장애물 목록을 통째로 바꾸고 {@link ObstacleField#version}을 올립니다. 목록은 복사하지 않고 보관합니다.
   * 장애물이 바뀐 틱에만 부르세요(색인을 다시 채웁니다. 버퍼는 용량이 모자랄 때만 새로 만듭니다).
   */
  setCircles(circles) {
    for (let i = 0; i < circles.length; i++) {
      circleWithBounds(circles[i]);
    }
    this.circles = circles;
    if (this.circleIndex === null) {
      this.circleIndex = new BoundsIndex(circles, this.cell);
    } else {
      this.circleIndex.rebuild(circles);
    }
    this.version++;
  }
  /**
   * (x0, y0)-(x1, y1) 상자를 `pad`만큼 넓힌 범위의 원 장애물 후보. `ignoreId`가 와일드카드면 `keep`을 통과한 원만 남깁니다.
   * 돌려주는 배열은 재사용하는 것이라 다음 조회 때 덮어씁니다.
   */
  obstacles(x0, y0, x1, y1, pad, ignoreId) {
    const FOUND = this.circleIndex.query(x0, y0, x1, y1, pad);
    if (!this.ignoreAll || ignoreId !== this.ignoreAll.id) {
      return FOUND;
    }
    const KEPT = this.kept, KEEP = this.ignoreAll.keep;
    KEPT.length = 0;
    for (let i = 0; i < FOUND.length; i++) {
      if (KEEP(FOUND[i])) {
        KEPT.push(FOUND[i]);
      }
    }
    return KEPT;
  }
  /** 다각형과 월드 경계만 본 원의 자리 검사. 다각형이 없으면 항상 true입니다. */
  polygonCircleClear(x, y, r = 0) {
    if (!this.active) {
      return true;
    }
    if (x < r || y < r || x > this.width - r || y > this.height - r) {
      return false;
    }
    const FOUND = this.polygons.query(x, y, x, y, r), THRESHOLD = contactThreshold(r, this.quantum);
    for (let k = 0; k < FOUND.length; k++) {
      const B = FOUND[k];
      if (pointInSimplePolygon(x, y, B.points)) {
        return false;
      }
      for (let i = 0; i < B.points.length; i++) {
        const A = B.points[i], C = B.points[(i + 1) % B.points.length];
        if (pointSegmentDistance(x, y, A.x, A.y, C.x, C.y) < THRESHOLD) {
          return false;
        }
      }
    }
    return true;
  }
  /** 다각형과 월드 경계만 본 선분 이동 검사. 다각형이 없으면 항상 true입니다. */
  polygonSegmentClear(x0, y0, x1, y1, r = 0) {
    if (!this.active) {
      return true;
    }
    if (Math.min(x0, x1) < r || Math.min(y0, y1) < r || Math.max(x0, x1) > this.width - r || Math.max(y0, y1) > this.height - r) {
      return false;
    }
    return !segmentBlockedBy(this.polygons, x0, y0, x1, y1, r, this.quantum);
  }
  /**
   * (x, y) 가까이에서 `polygonCircleClear`(와 `accept`)를 통과하는 가장 가까운 자리를 `out`에 쓰고 true를 돌려줍니다.
   * 16 간격 고리 32방향을 `maxDistance`까지 봅니다. 못 찾으면 false이고 `out`을 건드리지 않습니다.
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {number} maxDistance
   * @param {((x: number, y: number) => boolean) | null} accept
   * @param {{x: number, y: number}} out
   */
  nearestOpen(x, y, r, maxDistance, accept, out) {
    return this.#nearestOpen(x, y, r, maxDistance, accept, false, null, out);
  }
  // exterior가 true면 accept 대신 pointClear(·, r, exteriorIgnore)로 거릅니다(nearestExterior의 클로저를 없앤 경로).
  #nearestOpen(x, y, r, maxDistance, accept, exterior, exteriorIgnore, out) {
    if (this.polygonCircleClear(x, y, r) && (exterior ? this.pointClear(x, y, r, exteriorIgnore) : !accept || accept(x, y))) {
      out.x = x;
      out.y = y;
      return true;
    }
    let found = false, bestD = Infinity;
    const STEP = 16;
    for (let range = STEP; range <= maxDistance; range += STEP) {
      for (let i = 0; i < 32; i++) {
        const QX = clamp(x + RING_COS[i] * range, r + 1, this.width - r - 1), QY = clamp(y + RING_SIN[i] * range, r + 1, this.height - r - 1);
        const D = (QX - x) ** 2 + (QY - y) ** 2;
        if (D < bestD && this.polygonCircleClear(QX, QY, r) && (exterior ? this.pointClear(QX, QY, r, exteriorIgnore) : !accept || accept(QX, QY))) {
          out.x = QX;
          out.y = QY;
          found = true;
          bestD = D;
        }
      }
      if (found) {
        return true;
      }
    }
    return false;
  }
  /**
   * 반지름 r인 원이 (x, y)에서 (tx, ty)까지 직선으로 갈 수 있는지(월드 경계·다각형·원 장애물).
   * `ignoreId`와 같은 id의 원은 건너뜁니다. `departure`가 true면 이미 겹친 원에서 멀어지는 이동은 허용합니다.
   * `margin`은 원 장애물에 더 비워 두는 간격입니다(기본 0.25).
   */
  segmentClear(x, y, tx, ty, r, ignoreId = null, departure = false, margin = 0.25) {
    if (Math.min(x, tx) < r || Math.min(y, ty) < r || Math.max(x, tx) > this.width - r || Math.max(y, ty) > this.height - r || !this.polygonSegmentClear(x, y, tx, ty, r)) {
      return false;
    }
    const FOUND = this.obstacles(x, y, tx, ty, r + margin, ignoreId);
    for (let k = 0; k < FOUND.length; k++) {
      const B = FOUND[k];
      if (B.id === ignoreId) {
        continue;
      }
      const NEEDED = r + B.r + margin, START = Math.hypot(x - B.x, y - B.y);
      if (departure && START < NEEDED && (x - B.x) * (tx - x) + (y - B.y) * (ty - y) >= 0 && Math.hypot(tx - B.x, ty - B.y) >= START) {
        continue;
      }
      if (pointSegmentDistance(B.x, B.y, x, y, tx, ty) < NEEDED - 1e-3) {
        return false;
      }
    }
    return true;
  }
  /** 반지름 r인 원이 (x, y)에 둘 수 있는지. */
  pointClear(x, y, r, ignoreId = null) {
    return this.segmentClear(x, y, x, y, r, ignoreId);
  }
  /**
   * Test two concentric radii in one traversal. Returns 0 if the inner radius
   * is blocked, 1 if only the inner radius is clear, and 2 if both are clear.
   * Each result has exactly the same boundary and circle margin as pointClear.
   */
  pointClearanceBand(x, y, innerRadius, outerRadius, ignoreId = null) {
    if (!Number.isFinite(innerRadius) || !Number.isFinite(outerRadius) || innerRadius < 0 || outerRadius < innerRadius) {
      throw new RangeError("ObstacleField radii must be finite, non-negative and ordered.");
    }
    if (x < innerRadius || y < innerRadius || x > this.width - innerRadius || y > this.height - innerRadius) {
      return 0;
    }
    let outerClear = !(x < outerRadius || y < outerRadius || x > this.width - outerRadius || y > this.height - outerRadius);
    const INNER = contactThreshold(innerRadius, this.quantum), OUTER = contactThreshold(outerRadius, this.quantum);
    const POLYGONS = this.polygons.query(x, y, x, y, outerRadius);
    for (let k = 0; k < POLYGONS.length; k++) {
      const P = POLYGONS[k];
      if (pointInSimplePolygon(x, y, P.points)) {
        return 0;
      }
      for (let i = 0; i < P.points.length; i++) {
        const A = P.points[i], B = P.points[(i + 1) % P.points.length];
        const DISTANCE = pointSegmentDistance(x, y, A.x, A.y, B.x, B.y);
        if (DISTANCE < INNER) {
          return 0;
        }
        if (DISTANCE < OUTER) {
          outerClear = false;
        }
      }
    }
    const CIRCLES = this.obstacles(x, y, x, y, outerRadius + 0.25, ignoreId);
    for (let k = 0; k < CIRCLES.length; k++) {
      const C = CIRCLES[k];
      if (C.id === ignoreId) {
        continue;
      }
      const DISTANCE = Math.hypot(x - C.x, y - C.y);
      if (DISTANCE < innerRadius + C.r + 0.25 - 1e-3) {
        return 0;
      }
      if (DISTANCE < outerRadius + C.r + 0.25 - 1e-3) {
        outerClear = false;
      }
    }
    return outerClear ? 2 : 1;
  }
  /** {@link ObstacleField#segmentClear}를 `departure`로 부릅니다. */
  departureClear(x, y, tx, ty, r, ignoreId = null) {
    return this.segmentClear(x, y, tx, ty, r, ignoreId, true);
  }
  /**
   * (x, y)에서 가장 가까운, 다각형과 원 장애물 모두 비어 있는 자리를 `out`에 쓰고 true. 없으면 false.
   * 특정 id는 무시하지 않고 `ignoreAll` 와일드카드일 때만 원 장애물을 무시합니다(Rally 원본의 동작을 그대로 보존).
   * @param {{x: number, y: number}} out
   */
  nearestExterior(x, y, r, ignoreId, out) {
    const IGNORED = this.ignoreAll && ignoreId === this.ignoreAll.id ? ignoreId : null;
    return this.#nearestOpen(x, y, r, this.exteriorSearchDistance, null, true, IGNORED, out);
  }
};

// modules/geometry/surface-motion.js
var WALL_LEFT = contactKey(CONTACT_WALL, 0, 0);
var WALL_RIGHT = contactKey(CONTACT_WALL, 0, 1);
var WALL_TOP = contactKey(CONTACT_WALL, 0, 2);
var WALL_BOTTOM = contactKey(CONTACT_WALL, 0, 3);
function pushWall(list, distance, nx, ny, key, epsilon) {
  if (distance <= epsilon) {
    list.add(nx, ny, -distance, key, 0, null);
  }
}
function castWall(best, distance, velocity, nx, ny, key) {
  if (velocity >= -1e-8) {
    return;
  }
  const T = Math.max(0, -distance / velocity);
  if (T <= 1) {
    offerContact(best, T, nx, ny, key, null, false);
  }
}
function sortByKey(list) {
  const ITEMS = list.items;
  for (let i = 1; i < list.count; i++) {
    const C = ITEMS[i], KEY = C.key;
    let j = i - 1;
    while (j >= 0 && ITEMS[j].key > KEY) {
      ITEMS[j + 1] = ITEMS[j];
      j--;
    }
    ITEMS[j + 1] = C;
  }
}
function compact(list, keep) {
  const ITEMS = list.items;
  let write = 0;
  for (let i = 0; i < list.count; i++) {
    if (keep[i] === 1) {
      if (write !== i) {
        const C = ITEMS[write];
        ITEMS[write] = ITEMS[i];
        ITEMS[i] = C;
      }
      write++;
    }
  }
  list.count = write;
}
var MotionResult = class {
  x = 0;
  y = 0;
  /** 시작 자리가 막혀 있어 풀지 못했으면 false. */
  valid = true;
  /** 이동 중 장애물에 닿았는지. 닿았으면 `contact`가 처음 닿은 접촉입니다. */
  hit = false;
  contact = new ContactHit();
};
var Checkpoint = class {
  x = 0;
  y = 0;
  verified = false;
  ignoreId = null;
  signature = 0;
  epoch = 0;
};
var SurfaceMotion = class {
  #epoch = 1;
  #list = new ContactList();
  #recoverList = new ContactList();
  #keep = new Uint8Array(16);
  #best = new ContactHit();
  #edge = new ContactHit();
  #scratch = new ContactHit();
  #point = { x: 0, y: 0 };
  #exterior = { x: 0, y: 0 };
  #slide = { x: 0, y: 0 };
  #deltaX = 0;
  #deltaY = 0;
  #deltaBest = Infinity;
  /**
   * @param {import('./obstacle-field.js').ObstacleField} field 장애물 장. 좌표 격자(`fixedPoint`)도 여기서 읽습니다.
   * @param {object} [options]
   * @param {(tieKey: number, contactKey: number, sign: number) => number} [options.tieRank]
   *   방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선, 부호 없는 32비트 정수). 순수 함수여야 합니다.
   *   기본은 {@link defaultTieRank}(정수 조합의 FNV-1a + fmix32)입니다.
   * @param {() => void} [options.sync] `solve`·`constrain`이 시작할 때 부르는 갱신 자리(장애물 지연 갱신 등).
   */
  constructor(field, { tieRank = null, sync = null } = {}) {
    this.field = field;
    this.tieRank = tieRank;
    this.sync = sync;
    this.checkpoints = /* @__PURE__ */ new WeakMap();
  }
  round(value) {
    return Math.round(value * this.field.fixedPoint) / this.field.fixedPoint;
  }
  /** (x, y)에서 (tx, ty)로 가는 직선이 비어 있는지(제자리면 `departure` 없이, 움직이면 `departure`로 봅니다). */
  clear(x, y, tx, ty, r, ignoreId = null) {
    return this.field.segmentClear(x, y, tx, ty, r, ignoreId, x !== tx || y !== ty, 0);
  }
  /**
   * 지금 (x, y) 반지름 r 원이 닿았거나 `epsilon`(기본 고정소수 두 칸) 안으로 가까운 접촉 모두를 키 순서로 `list`에 채웁니다
   * (먼저 비움). 접촉마다 법선·깊이·키(+ 다각형이면 `distance`, 원 장애물이면 `obstacle`)이고 같은 접평면의 접촉은 가장
   * 깊은 하나만 남깁니다. 키는 다각형 < 원 장애물 < 월드 경계 순입니다.
   * @param {ContactList} list
   */
  contacts(x, y, r, ignoreId, list, epsilon = 2 / this.field.fixedPoint) {
    const FIELD = this.field;
    list.clear();
    const POLYGONS = FIELD.polygons.query(x, y, x, y, r + epsilon), POLYGON_INDEX = FIELD.polygons.found;
    for (let k = 0; k < POLYGONS.length; k++) {
      SurfaceContactGeometry.polygonContacts(x, y, r, POLYGONS[k].points, POLYGON_INDEX[k], epsilon, list);
    }
    const CIRCLES = FIELD.obstacles(x, y, x, y, r + epsilon, ignoreId);
    for (let k = 0; k < CIRCLES.length; k++) {
      const B = CIRCLES[k];
      if (B.id === ignoreId) {
        continue;
      }
      const DX = x - B.x, DY = y - B.y, D = Math.hypot(DX, DY), NEEDED = r + B.r;
      if (D <= NEEDED + epsilon) {
        list.add(
          D > 1e-9 ? DX / D : 1,
          D > 1e-9 ? DY / D : 0,
          NEEDED - D,
          contactKey(CONTACT_CIRCLE, B.id),
          0,
          B
        );
      }
    }
    pushWall(list, x - r, 1, 0, WALL_LEFT, epsilon);
    pushWall(list, FIELD.width - r - x, -1, 0, WALL_RIGHT, epsilon);
    pushWall(list, y - r, 0, 1, WALL_TOP, epsilon);
    pushWall(list, FIELD.height - r - y, 0, -1, WALL_BOTTOM, epsilon);
    sortByKey(list);
    const ITEMS = list.items, KEEP = this.#keepFor(list.count);
    for (let i = 0; i < list.count; i++) {
      const C = ITEMS[i];
      KEEP[i] = 1;
      for (let j = 0; j < i; j++) {
        const N = ITEMS[j];
        if (Math.abs(C.nx - N.nx) + Math.abs(C.ny - N.ny) < 1e-7 && N.depth >= C.depth) {
          KEEP[i] = 0;
          break;
        }
      }
    }
    compact(list, KEEP);
    return list;
  }
  /** 원 장애물만 본 가장 이른 접촉을 `best`(비어 있으면 t = Infinity)에 제안합니다. */
  #offerCircles(best, x, y, vx, vy, r, ignoreId) {
    const CIRCLES = this.field.obstacles(x, y, x + vx, y + vy, r, ignoreId), SCRATCH2 = this.#scratch;
    for (let k = 0; k < CIRCLES.length; k++) {
      const B = CIRCLES[k];
      if (B.id === ignoreId) {
        continue;
      }
      if (SurfaceContactGeometry.circleCast(
        x,
        y,
        vx,
        vy,
        B.x,
        B.y,
        r + B.r,
        contactKey(CONTACT_CIRCLE, B.id),
        B,
        SCRATCH2
      )) {
        offerHit(best, SCRATCH2);
      }
    }
  }
  /**
   * 다각형·원 장애물·월드 경계 중 (vx, vy) 이동이 가장 먼저 닿는 접촉. 닿으면 true이고 `out`(ContactHit)에 씁니다.
   * 다각형 꼭짓점은 한 번만 봅니다(변 i의 끝 = 변 i + 1의 시작이고, 같은 시각이면 키가 작은 앞 변의 끝으로 기록).
   * @param {ContactHit} out
   */
  cast(x, y, vx, vy, r, ignoreId, out) {
    const FIELD = this.field, SLACK = FIELD.quantum, EDGE = this.#edge, SCRATCH2 = this.#scratch;
    out.t = Infinity;
    out.key = 0;
    const POLYGONS = FIELD.polygons.query(x, y, x + vx, y + vy, r), POLYGON_INDEX = FIELD.polygons.found;
    for (let k = 0; k < POLYGONS.length; k++) {
      const POINTS = POLYGONS[k].points, COUNT = POINTS.length, BASE = contactKey(CONTACT_POLYGON, POLYGON_INDEX[k]);
      let startSeen = false;
      for (let i = 0; i < COUNT; i++) {
        const A = POINTS[i], B = POINTS[(i + 1) % COUNT], DEGENERATE = Math.hypot(B.x - A.x, B.y - A.y) < 1e-9;
        EDGE.t = Infinity;
        EDGE.key = 0;
        castEdgeInto(
          EDGE,
          x,
          y,
          vx,
          vy,
          A.x,
          A.y,
          B.x,
          B.y,
          r,
          BASE + i * 4,
          SLACK,
          !startSeen,
          i !== COUNT - 1,
          SCRATCH2
        );
        startSeen = !DEGENERATE;
        offerHit(out, EDGE);
      }
    }
    EDGE.t = Infinity;
    EDGE.key = 0;
    this.#offerCircles(EDGE, x, y, vx, vy, r, ignoreId);
    offerHit(out, EDGE);
    castWall(out, x - r, vx, 1, 0, WALL_LEFT);
    castWall(out, FIELD.width - r - x, -vx, -1, 0, WALL_RIGHT);
    castWall(out, y - r, vy, 0, 1, WALL_TOP);
    castWall(out, FIELD.height - r - y, -vy, 0, -1, WALL_BOTTOM);
    return out.t !== Infinity;
  }
  #keepFor(count) {
    if (this.#keep.length < count) {
      this.#keep = new Uint8Array(Math.max(count, this.#keep.length * 2));
    }
    return this.#keep;
  }
  // recover의 후보 이동 (px, py)가 모든 접촉을 풀면 가장 짧은 것으로 기억합니다.
  #consider(list, quantum, px, py) {
    const ITEMS = list.items;
    for (let i = 0; i < list.count; i++) {
      const C = ITEMS[i];
      if (px * C.nx + py * C.ny < C.depth + quantum - 1e-7) {
        return;
      }
    }
    const D = px * px + py * py;
    if (D < this.#deltaBest) {
      this.#deltaBest = D;
      this.#deltaX = px;
      this.#deltaY = py;
    }
  }
  /**
   * 이미 겹쳐 버린 원을 가장 가까운 빈 자리로 옮겨 `out`에 씁니다. 겹침이 없거나 옮길 수 없으면 제자리입니다.
   * 지형이나 다른 장애물을 가로질러 건너가는 일은 없습니다.
   * @param {{x: number, y: number}} out
   */
  recover(x, y, r, ignoreId, out) {
    const FIELD = this.field, QUANTUM = FIELD.quantum;
    out.x = x;
    out.y = y;
    if (this.clear(x, y, x, y, r, ignoreId)) {
      return out;
    }
    if (FIELD.polygonCircleClear(x, y, r)) {
      const P = this.#exterior;
      if (FIELD.nearestExterior(x, y, r, ignoreId, P)) {
        const END_X = this.round(P.x), END_Y = this.round(P.y);
        if (this.clear(END_X, END_Y, END_X, END_Y, r, ignoreId) && FIELD.departureClear(x, y, END_X, END_Y, r, ignoreId)) {
          out.x = END_X;
          out.y = END_Y;
        }
      }
      return out;
    }
    const LIST = this.#recoverList;
    let remaining = r, px = x, py = y;
    for (let pass = 0; pass < 4; pass++) {
      this.contacts(px, py, r, ignoreId, LIST, 0);
      const KEEP = this.#keepFor(LIST.count);
      for (let i = 0; i < LIST.count; i++) {
        KEEP[i] = LIST.items[i].depth > QUANTUM ? 1 : 0;
      }
      compact(LIST, KEEP);
      if (!LIST.count) {
        break;
      }
      this.#deltaBest = Infinity;
      const ITEMS = LIST.items;
      for (let i = 0; i < LIST.count; i++) {
        const C = ITEMS[i];
        this.#consider(LIST, QUANTUM, C.nx * (C.depth + QUANTUM), C.ny * (C.depth + QUANTUM));
      }
      for (let i = 0; i < LIST.count; i++) {
        for (let j = i + 1; j < LIST.count; j++) {
          const A = ITEMS[i], B = ITEMS[j], DEN = A.nx * B.ny - A.ny * B.nx;
          if (Math.abs(DEN) < 1e-8) {
            continue;
          }
          const AD = A.depth + QUANTUM, BD = B.depth + QUANTUM;
          this.#consider(LIST, QUANTUM, (AD * B.ny - A.ny * BD) / DEN, (A.nx * BD - AD * B.nx) / DEN);
        }
      }
      if (this.#deltaBest === Infinity || Math.sqrt(this.#deltaBest) > remaining + 1e-7) {
        return out;
      }
      const D = Math.sqrt(this.#deltaBest);
      px += this.#deltaX;
      py += this.#deltaY;
      remaining -= D;
      if (remaining <= 0) {
        break;
      }
    }
    if (this.clear(px, py, px, py, r, ignoreId)) {
      out.x = px;
      out.y = py;
    }
    return out;
  }
  /**
   * (x, y)에서 (tx, ty)까지 이동하되 끝점을 고정소수 격자에 반올림해 비어 있는 곳까지만 가서 `out`에 씁니다.
   * `whole`이 true면 끝까지 갈 수 있을 때만 끝점을 쓰고 true, 아니면 `out`을 건드리지 않고 false를 돌려줍니다.
   * false면 갈 수 있는 끝까지 이분 탐색(18회)하고 true입니다.
   * @param {{x: number, y: number}} out
   */
  advance(x, y, tx, ty, r, ignoreId, whole, out) {
    const END_X = this.round(tx), END_Y = this.round(ty);
    if (this.field.segmentClear(x, y, END_X, END_Y, r, ignoreId, !whole && (x !== END_X || y !== END_Y), 0)) {
      out.x = END_X;
      out.y = END_Y;
      return true;
    }
    if (whole) {
      return false;
    }
    let lo = 0, hi = 1, safeX = this.round(x), safeY = this.round(y);
    for (let i = 0; i < 18; i++) {
      const T = (lo + hi) / 2, PX = this.round(x + (tx - x) * T), PY = this.round(y + (ty - y) * T);
      if (this.clear(x, y, PX, PY, r, ignoreId)) {
        lo = T;
        safeX = PX;
        safeY = PY;
      } else {
        hi = T;
      }
    }
    out.x = safeX;
    out.y = safeY;
    return true;
  }
  /**
   * 반지름 r인 원을 (x, y)에서 (tx, ty)로 옮긴 결과를 `out`({@link MotionResult})에 씁니다. `out.hit`이면 `out.contact`가
   * 처음 닿은 접촉입니다. 시작 자리가 막혀 있어 풀 수 없으면 `out.valid`가 false입니다.
   * `mode`: `'steer'`는 닿은 뒤 접촉면을 따라 목표 쪽으로 미끄러지고(속도는 유지), `'stop'`은 닿는 자리에서 멈추고,
   * 그 밖의 값(`'project'`)은 접촉면에 사영한 만큼만 미끄러집니다. `tieKey`(0 이상 안전 정수)는 동률 순위의 입력입니다.
   * @param {MotionResult} out
   */
  solve(x, y, tx, ty, r, ignoreId, mode, tieKey, out) {
    this.sync?.();
    out.valid = true;
    out.hit = false;
    if (this.advance(x, y, tx, ty, r, ignoreId, true, out)) {
      return out;
    }
    const POINT = this.#point;
    this.recover(x, y, r, ignoreId, POINT);
    let px = POINT.x, py = POINT.y;
    if (!this.clear(px, py, px, py, r, ignoreId)) {
      out.x = px;
      out.y = py;
      out.valid = false;
      return out;
    }
    const CONTACT = this.#best, LIST = this.#list, SLIDE = this.#slide;
    let rx = tx - x, ry = ty - y, remaining = Math.hypot(rx, ry);
    for (let pass = 0; pass < 8 && remaining > 1e-7; pass++) {
      if (!this.cast(px, py, rx, ry, r, ignoreId, CONTACT)) {
        this.advance(px, py, px + rx, py + ry, r, ignoreId, false, POINT);
        px = POINT.x;
        py = POINT.y;
        break;
      }
      if (!out.hit) {
        out.hit = true;
        const FIRST = out.contact;
        FIRST.t = CONTACT.t;
        FIRST.nx = CONTACT.nx;
        FIRST.ny = CONTACT.ny;
        FIRST.key = CONTACT.key;
        FIRST.obstacle = CONTACT.obstacle;
        FIRST.degenerate = CONTACT.degenerate;
      }
      const T = clamp(CONTACT.t, 0, 1);
      this.advance(px, py, px + rx * T, py + ry * T, r, ignoreId, false, POINT);
      const SPENT = Math.hypot(POINT.x - px, POINT.y - py);
      px = POINT.x;
      py = POINT.y;
      remaining = Math.max(0, remaining - SPENT);
      if (mode === "stop" || remaining < 1e-7) {
        break;
      }
      this.contacts(px, py, r, ignoreId, LIST);
      let same = false;
      for (let i = 0; i < LIST.count; i++) {
        const N = LIST.items[i];
        if (Math.abs(N.nx - CONTACT.nx) + Math.abs(N.ny - CONTACT.ny) < 1e-7) {
          same = true;
          break;
        }
      }
      if (!same) {
        LIST.add(CONTACT.nx, CONTACT.ny, 0, CONTACT.key, 0, CONTACT.obstacle);
      }
      SurfaceContactGeometry.slide(
        rx * (1 - T),
        ry * (1 - T),
        LIST,
        remaining,
        mode === "steer",
        tx - px,
        ty - py,
        tieKey,
        this.tieRank,
        SLIDE
      );
      const LEN = Math.hypot(SLIDE.x, SLIDE.y);
      if (LEN < 1e-7) {
        break;
      }
      if (SPENT < 1e-7 && Math.abs(SLIDE.x - rx) + Math.abs(SLIDE.y - ry) < 1e-8) {
        break;
      }
      rx = SLIDE.x;
      ry = SLIDE.y;
      remaining = Math.min(remaining, LEN);
    }
    out.x = px;
    out.y = py;
    return out;
  }
  /**
   * 마지막으로 위치를 확인한 체크포인트를 기록합니다(`verified`가 true면 그 자리는 장애물과 겹치지 않음이 확인된 것).
   * 체크포인트는 `ignoreId`와 이 시점의 {@link ObstacleField#version}도 함께 기억합니다. 몸체마다 기록 객체 하나를 재사용합니다.
   */
  remember(body, x, y, verified = true, ignoreId = null) {
    let checkpoint = this.checkpoints.get(body);
    if (checkpoint === void 0) {
      checkpoint = new Checkpoint();
      this.checkpoints.set(body, checkpoint);
    }
    checkpoint.x = x;
    checkpoint.y = y;
    checkpoint.verified = verified;
    checkpoint.ignoreId = ignoreId;
    checkpoint.signature = this.field.version;
    checkpoint.epoch = this.#epoch;
  }
  /** 모든 체크포인트를 잊습니다(한 이동 단계가 시작될 때). 세대 번호만 올리고 기록 객체는 다음 `remember`가 재사용합니다. */
  forgetAll() {
    this.#epoch++;
  }
  /**
   * 몸체가 다른 힘으로 (x, y)까지 옮겨진 뒤, 마지막 체크포인트에서 그 자리까지를 `'project'`로 다시 풀어 장애물 안으로
   * 들어가지 않게 합니다. 체크포인트가 확인된 자리·같은 `ignoreId`·같은 장애물 버전이고 몸체가 안 움직였으면 false,
   * 아니면 `solve` 결과를 `out`에 쓰고 true를 돌려줍니다. 결과를 몸체에 쓰고 `remember`하는 일은 호출자가 합니다.
   * @param {MotionResult} out
   */
  constrain(body, x, y, r, ignoreId, tieKey, out) {
    this.sync?.();
    const S = this.checkpoints.get(body);
    if (S === void 0 || S.epoch !== this.#epoch) {
      this.solve(x, y, x, y, r, ignoreId, "project", tieKey, out);
      return true;
    }
    if (S.verified && S.ignoreId === ignoreId && S.signature === this.field.version && S.x === x && S.y === y) {
      return false;
    }
    this.solve(S.x, S.y, x, y, r, ignoreId, "project", tieKey, out);
    return true;
  }
};
export {
  BoundsIndex,
  CONTACT_CIRCLE,
  CONTACT_EDGE,
  CONTACT_END,
  CONTACT_MAX_EDGE,
  CONTACT_MAX_OBSTACLE,
  CONTACT_POLYGON,
  CONTACT_START,
  CONTACT_USER,
  CONTACT_WALL,
  ContactHit,
  ContactList,
  MotionResult,
  ObstacleField,
  SurfaceContact,
  SurfaceContactGeometry,
  SurfaceMotion,
  SweptCircleContact,
  assignBounds,
  boundariesCross,
  catmullRomPoint,
  closestPolylineProgress,
  contactKey,
  defaultTieRank,
  earlierContact,
  insetPolygonTowardCenter,
  minPairDistance,
  nearestPointDistance,
  pointDistance,
  pointInSimplePolygon,
  pointPolylineDistance,
  pointSegmentDistance,
  polygonTouchesRect,
  polygonsOverlap,
  polylineTangentAt,
  polylineToRibbonPolygon,
  roundedPointOnPolyline,
  segmentBlockedBy,
  segmentDistance,
  segmentTouchesRect,
  segmentsIntersect,
  smoothPolylineCatmull,
  triangulatePolygon
};
