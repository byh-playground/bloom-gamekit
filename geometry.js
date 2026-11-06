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
var BoundsIndex = class {
  /**
   * @param {Array<{minX: number, maxX: number, minY: number, maxY: number}>} items 경계를 가진 항목(보관만 하고 복사하지 않습니다)
   * @param {number} cell 칸 한 변의 길이
   */
  constructor(items, cell = 256) {
    this.items = items;
    this.cell = cell;
    this.bins = /* @__PURE__ */ new Map();
    this.marks = new Uint32Array(items.length);
    this.epoch = 0;
    this.out = [];
    for (let i = 0; i < items.length; i++) {
      const B = items[i];
      for (let y = Math.floor(B.minY / cell); y <= Math.floor(B.maxY / cell); y++) {
        for (let x = Math.floor(B.minX / cell); x <= Math.floor(B.maxX / cell); x++) {
          let row = this.bins.get(y);
          if (!row) {
            this.bins.set(y, row = /* @__PURE__ */ new Map());
          }
          let bin = row.get(x);
          if (!bin) {
            row.set(x, bin = []);
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
    const MIN_X = Math.min(x0, x1) - pad, MAX_X = Math.max(x0, x1) + pad, MIN_Y = Math.min(y0, y1) - pad, MAX_Y = Math.max(y0, y1) + pad;
    const BX0 = Math.floor(MIN_X / this.cell), BX1 = Math.floor(MAX_X / this.cell), BY0 = Math.floor(MIN_Y / this.cell), BY1 = Math.floor(MAX_Y / this.cell);
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
    if (++this.epoch === 4294967295) {
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
function defaultTieRank(tieKey, contactKey, sign) {
  const TEXT = tieKey + "|" + contactKey + "|" + sign;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < TEXT.length; i++) {
    h ^= TEXT.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function earlierContact(best, hit) {
  return hit && (!best || hit.t < best.t - 1e-10 || Math.abs(hit.t - best.t) <= 1e-10 && hit.key < best.key) ? hit : best;
}
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
   * 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy) 한 틱(t: 0~1) 동안 반지름 r인 원 안에 처음 들어가는 시각과 법선.
   * 닿지 않으면 null입니다. 법선이 0에 가까우면 `fallback()`이 돌려주는 `{x, y}`(없으면 `{x: 1, y: 0}`)를 씁니다.
   * @returns {{t: number, nx: number, ny: number} | null}
   */
  static cast(rx, ry, vx, vy, r, policy, fallback = null) {
    const AA = vx * vx + vy * vy, RADIAL = rx * vx + ry * vy, C = rx * rx + ry * ry - r * r;
    const DISTANCE_POLICY = policy.contactDistanceEpsilon != null, LENGTH = DISTANCE_POLICY ? Math.hypot(rx, ry) : 0;
    if (DISTANCE_POLICY && AA < policy.minSpeed2) {
      return null;
    }
    const CONTACT = DISTANCE_POLICY ? LENGTH <= r + policy.contactDistanceEpsilon : C <= policy.contactSquaredEpsilon;
    let t = 0;
    if (CONTACT) {
      const INWARD = DISTANCE_POLICY ? vx * (LENGTH > policy.normalEpsilon ? rx / LENGTH : 1) + vy * (LENGTH > policy.normalEpsilon ? ry / LENGTH : 0) : RADIAL;
      if (INWARD >= -policy.inwardEpsilon) {
        return null;
      }
    } else {
      if (DISTANCE_POLICY ? AA < policy.minSpeed2 : AA <= policy.minSpeed2) {
        return null;
      }
      const DISC = RADIAL * RADIAL - AA * C;
      if (policy.includeTangent ? DISC < policy.discriminantEpsilon : DISC <= policy.discriminantEpsilon) {
        return null;
      }
      if (DISTANCE_POLICY && RADIAL >= 0) {
        return null;
      }
      const ENTER = (-RADIAL - Math.sqrt(DISC)) / AA;
      if (ENTER < 0 || ENTER > 1) {
        return null;
      }
      t = Math.max(0, ENTER - policy.retreat);
    }
    const QX = rx + vx * t, QY = ry + vy * t, L = Math.hypot(QX, QY);
    let nx, ny;
    if (L > policy.normalEpsilon) {
      nx = QX / L;
      ny = QY / L;
    } else {
      const NORMAL = fallback ? fallback() : { x: 1, y: 0 };
      nx = NORMAL.x;
      ny = NORMAL.y;
    }
    return { t, nx, ny };
  }
};
var SurfaceContactGeometry = class {
  /** 선분 AB 위에서 (x, y)에 가장 가까운 점. */
  static closest(ax, ay, bx, by, x, y) {
    const DX = bx - ax, DY = by - ay, L2 = DX * DX + DY * DY, T = L2 ? clamp(((x - ax) * DX + (y - ay) * DY) / L2, 0, 1) : 0;
    return { x: ax + DX * T, y: ay + DY * T };
  }
  /** 원 (x, y)가 속도 (vx, vy)로 움직일 때 고정된 원 (cx, cy, 반지름 r)에 닿는 접촉. 닿지 않으면 null. */
  static circleCast(x, y, vx, vy, cx, cy, r, key, obstacle = null) {
    const HIT = SweptCircleContact.cast(x - cx, y - cy, vx, vy, r, POLICIES.surface);
    if (!HIT) {
      return null;
    }
    HIT.key = key;
    HIT.obstacle = obstacle;
    return HIT;
  }
  /**
   * 원 (x, y, 반지름 r)이 속도 (vx, vy)로 움직일 때 선분 a-b(양 끝 원 포함)에 닿는 가장 이른 접촉.
   * `slack`은 이미 선분에서 그만큼(보통 고정소수 한 칸) 안쪽에 들어와 있어도 t = 0 접촉으로 치는 허용 거리입니다.
   */
  static edgeCast(x, y, vx, vy, a, b, r, key, slack = 0) {
    const DX = b.x - a.x, DY = b.y - a.y, LEN = Math.hypot(DX, DY);
    if (LEN < 1e-9) {
      return this.circleCast(x, y, vx, vy, a.x, a.y, r, key);
    }
    const EX = DX / LEN, EY = DY / LEN, NX = -EY, NY = EX;
    let best = null;
    const SIGNED = (x - a.x) * NX + (y - a.y) * NY, VN = vx * NX + vy * NY;
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
      const ALONG = (x + vx * t - a.x) * EX + (y + vy * t - a.y) * EY;
      if (ALONG >= -1e-8 && ALONG <= LEN + 1e-8) {
        best = earlierContact(best, { t, nx: NX * SIDE, ny: NY * SIDE, key: key + ":edge" });
      }
    }
    best = earlierContact(best, this.circleCast(x, y, vx, vy, a.x, a.y, r, key + ":a"));
    best = earlierContact(best, this.circleCast(x, y, vx, vy, b.x, b.y, r, key + ":b"));
    return best;
  }
  /**
   * 원 (x, y, 반지름 r)이 다각형 `block`(`{id, points}`)과 이미 닿았거나 `epsilon` 안으로 가까운 접촉 목록.
   * 접촉마다 `{nx, ny, depth, key, distance}`이고 법선은 원이 밀려날 방향입니다. 원 중심이 다각형 안에 있으면
   * 가장 가까운 가장자리 하나만 돌려줍니다. 접촉은 `out`(기본: 새 배열) 뒤에 덧붙이고 `out`을 돌려줍니다.
   */
  static polygonContacts(x, y, r, block, epsilon, out = []) {
    const POINTS = block.points, INSIDE = pointInSimplePolygon(x, y, POINTS);
    let nearest = null;
    for (let i = 0; i < POINTS.length; i++) {
      const A = POINTS[i], B = POINTS[(i + 1) % POINTS.length];
      const EX = B.x - A.x, EY = B.y - A.y, L2 = EX * EX + EY * EY, T = L2 ? clamp(((x - A.x) * EX + (y - A.y) * EY) / L2, 0, 1) : 0;
      const DX = x - (A.x + EX * T), DY = y - (A.y + EY * T), D = Math.hypot(DX, DY);
      if (INSIDE ? nearest && !(D < nearest.distance) : !(D <= r + epsilon)) {
        continue;
      }
      let nx, ny;
      if (D > 1e-9) {
        const SIGN = INSIDE ? -1 : 1;
        nx = SIGN * DX / D;
        ny = SIGN * DY / D;
      } else {
        let area = 0;
        for (let j = 0; j < POINTS.length; j++) {
          const V = POINTS[j], W = POINTS[(j + 1) % POINTS.length];
          area = area + V.x * W.y - W.x * V.y;
        }
        const LEN = Math.hypot(B.x - A.x, B.y - A.y) || 1, SIGN = area >= 0 ? 1 : -1;
        nx = (B.y - A.y) / LEN * SIGN;
        ny = -(B.x - A.x) / LEN * SIGN;
      }
      const CONTACT = {
        nx,
        ny,
        depth: INSIDE ? r + D : r - D,
        key: String(block.id) + ":" + i,
        distance: D
      };
      if (INSIDE) {
        nearest = CONTACT;
      } else {
        out.push(CONTACT);
      }
    }
    if (INSIDE && nearest) {
      out.push(nearest);
    }
    return out;
  }
  /** 속도 v = (x, y)가 모든 접촉 법선에서 밀려나는 쪽이거나 평행(허용 -1e-7)인지. */
  static feasible(v, contacts) {
    return feasibleAt(v.x, v.y, contacts);
  }
  /**
   * 원하는 이동 (vx, vy)를 모든 접촉에 위배되지 않는 가장 가까운 이동으로 돌려줍니다.
   * 이미 가능하면 그대로, 접촉 하나의 접평면에 사영해 가능한 것 중 가장 덜 바뀐 것, 없으면 정지 {0, 0}입니다.
   */
  static project(vx, vy, contacts) {
    if (feasibleAt(vx, vy, contacts)) {
      return { x: vx, y: vy };
    }
    let best = null, cost = vx * vx + vy * vy;
    for (const N of contacts) {
      const DOT = vx * N.nx + vy * N.ny, PX = vx - N.nx * DOT, PY = vy - N.ny * DOT;
      if (!feasibleAt(PX, PY, contacts)) {
        continue;
      }
      const D = (PX - vx) ** 2 + (PY - vy) ** 2;
      if (D < cost - 1e-12) {
        best = { x: PX, y: PY };
        cost = D;
      }
    }
    return best || { x: 0, y: 0 };
  }
  /**
   * 접촉에 막힌 이동 (vx, vy)를 `budget` 길이 안에서 미끄러뜨린 이동 `{x, y}`.
   * `steer`가 false면 사영 결과 그대로(바깥 힘은 새 옆 방향 충격을 얻지 않습니다), true면 사영 결과가 거의 0일 때
   * `goalX`·`goalY`에 가장 맞는 접선 방향을 골라 `budget` 길이로 늘립니다. 방향 점수가 같으면 낮은 `tieRank`가 이깁니다.
   * @param {number} vx
   * @param {number} vy
   * @param {Array<{nx: number, ny: number, key: string}>} contacts
   * @param {number} budget
   * @param {{steer?: boolean, goalX?: number, goalY?: number, tieKey?: string,
   *   tieRank?: (tieKey: string, contactKey: string, sign: number) => number}} [options]
   */
  static slide(vx, vy, contacts, budget, options = {}) {
    const {
      steer: STEER = false,
      goalX: GOAL_X = vx,
      goalY: GOAL_Y = vy,
      tieKey: TIE_KEY = "",
      tieRank: TIE_RANK = defaultTieRank
    } = options;
    if (budget < 1e-8) {
      return { x: 0, y: 0 };
    }
    let p = this.project(vx, vy, contacts), len = Math.hypot(p.x, p.y);
    if (!STEER) {
      return p;
    }
    if (len < budget * 0.035) {
      let bestX = 0, bestY = 0, found = false, score = -Infinity, tie = Infinity;
      for (const C of contacts) {
        for (let k = 0; k < 2; k++) {
          const SIGN = k === 0 ? -1 : 1;
          const QX = -C.ny * SIGN, QY = C.nx * SIGN;
          if (!feasibleAt(QX, QY, contacts)) {
            continue;
          }
          const VALUE = QX * GOAL_X + QY * GOAL_Y;
          if (VALUE < -1e-7) {
            continue;
          }
          if (VALUE > score + 1e-7) {
            bestX = QX;
            bestY = QY;
            found = true;
            score = VALUE;
            tie = TIE_RANK(TIE_KEY, C.key, SIGN) >>> 0;
          } else if (Math.abs(VALUE - score) <= 1e-7) {
            const RANK = TIE_RANK(TIE_KEY, C.key, SIGN) >>> 0;
            if (RANK < tie) {
              bestX = QX;
              bestY = QY;
              found = true;
              score = VALUE;
              tie = RANK;
            }
          }
        }
      }
      if (!found) {
        return { x: 0, y: 0 };
      }
      p = { x: bestX, y: bestY };
      len = 1;
    }
    return len > 1e-8 ? { x: p.x / len * budget, y: p.y / len * budget } : { x: 0, y: 0 };
  }
};
function feasibleAt(x, y, contacts) {
  for (let i = 0; i < contacts.length; i++) {
    if (!(x * contacts[i].nx + y * contacts[i].ny >= -1e-7)) {
      return false;
    }
  }
  return true;
}

// modules/geometry/obstacle-field.js
function contactThreshold(r, quantum) {
  return r > 0 ? Math.max(0, r - quantum) : 1e-3;
}
function segmentBlockedBy(index, x0, y0, x1, y1, r = 0, quantum = 0) {
  for (const B of index.query(x0, y0, x1, y1, r)) {
    if (pointInSimplePolygon(x0, y0, B.points) || pointInSimplePolygon(x1, y1, B.points)) {
      return true;
    }
    for (let i = 0; i < B.points.length; i++) {
      const A = B.points[i], C = B.points[(i + 1) % B.points.length];
      if (segmentDistance(x0, y0, x1, y1, A.x, A.y, C.x, C.y) < contactThreshold(r, quantum)) {
        return true;
      }
    }
  }
  return false;
}
function circleWithBounds(circle) {
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
   * @param {Array<{id: unknown, points: Array<{x: number, y: number}>}> | BoundsIndex} [options.polygons]
   *   막는 다각형. 경계(`minX` 등)가 없으면 만들어 붙입니다. 이미 만든 {@link BoundsIndex}도 받습니다.
   * @param {Array<{id: unknown, x: number, y: number, r: number}>} [options.circles] 막는 원. 경계가 없으면 만들어 붙입니다.
   * @param {number} [options.cell] 색인 칸 한 변의 길이(기본 256)
   * @param {{id: unknown, keep: (circle: object) => boolean}} [options.ignoreAll]
   *   "모두 무시" 와일드카드. 이동체가 `ignoreId`로 `id`를 내면 `keep(circle)`이 참인 원(항상 막는 방벽 등)만 장애물로 보고
   *   나머지 원은 모두 무시합니다. 없으면 와일드카드가 없습니다.
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
    if (ignoreAll !== null && typeof ignoreAll?.keep !== "function") {
      throw new TypeError("ObstacleField ignoreAll must be {id, keep(circle)}.");
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
    this.active = this.polygons.items.length > 0;
    this.version = -1;
    this.setCircles(circles);
  }
  /**
   * 원 장애물 목록을 통째로 바꾸고 {@link ObstacleField#version}을 올립니다. 목록은 복사하지 않고 보관합니다.
   * 장애물이 바뀐 틱에만 부르세요(색인을 다시 만듭니다).
   */
  setCircles(circles) {
    for (const C of circles) {
      circleWithBounds(C);
    }
    this.circles = circles;
    this.circleIndex = new BoundsIndex(circles, this.cell);
    this.version++;
  }
  /**
   * (x0, y0)-(x1, y1) 상자를 `pad`만큼 넓힌 범위의 원 장애물 후보. `ignoreId`가 와일드카드면 `keep`을 통과한 원만 남깁니다.
   * 돌려주는 배열은 색인이 재사용하는 것이라 다음 조회 때 덮어씁니다.
   */
  obstacles(x0, y0, x1, y1, pad, ignoreId) {
    const FOUND = this.circleIndex.query(x0, y0, x1, y1, pad);
    return this.ignoreAll && ignoreId === this.ignoreAll.id ? FOUND.filter(this.ignoreAll.keep) : FOUND;
  }
  /** 다각형과 월드 경계만 본 원의 자리 검사. 다각형이 없으면 항상 true입니다. */
  polygonCircleClear(x, y, r = 0) {
    if (!this.active) {
      return true;
    }
    if (x < r || y < r || x > this.width - r || y > this.height - r) {
      return false;
    }
    for (const B of this.polygons.query(x, y, x, y, r)) {
      if (pointInSimplePolygon(x, y, B.points)) {
        return false;
      }
      for (let i = 0; i < B.points.length; i++) {
        const A = B.points[i], C = B.points[(i + 1) % B.points.length];
        if (pointSegmentDistance(x, y, A.x, A.y, C.x, C.y) < contactThreshold(r, this.quantum)) {
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
   * (x, y) 가까이에서 `polygonCircleClear`(와 `accept`)를 통과하는 가장 가까운 자리. 16 간격 고리 32방향을 `maxDistance`까지 봅니다.
   * 못 찾으면 null입니다.
   */
  nearestOpen(x, y, r, maxDistance = 768, accept = null) {
    if (this.polygonCircleClear(x, y, r) && (!accept || accept(x, y))) {
      return { x, y };
    }
    let best = null, bestD = Infinity;
    const STEP = 16;
    for (let range = STEP; range <= maxDistance; range += STEP) {
      for (let i = 0; i < 32; i++) {
        const A = i * Math.PI / 16, QX = clamp(x + Math.cos(A) * range, r + 1, this.width - r - 1), QY = clamp(y + Math.sin(A) * range, r + 1, this.height - r - 1);
        const D = (QX - x) ** 2 + (QY - y) ** 2;
        if (D < bestD && this.polygonCircleClear(QX, QY, r) && (!accept || accept(QX, QY))) {
          best = { x: QX, y: QY };
          bestD = D;
        }
      }
      if (best) {
        return best;
      }
    }
    return null;
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
    for (const B of this.obstacles(x, y, tx, ty, r + margin, ignoreId)) {
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
    for (const P of this.polygons.query(x, y, x, y, outerRadius)) {
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
    for (const C of this.obstacles(x, y, x, y, outerRadius + 0.25, ignoreId)) {
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
   * (x, y)에서 가장 가까운, 다각형과 원 장애물 모두 비어 있는 자리. 없으면 null.
   * 특정 id는 무시하지 않고 `ignoreAll` 와일드카드일 때만 원 장애물을 무시합니다(Rally 원본의 동작을 그대로 보존).
   */
  nearestExterior(x, y, r, ignoreId = null) {
    const IGNORED = this.ignoreAll && ignoreId === this.ignoreAll.id ? ignoreId : null;
    return this.nearestOpen(x, y, r, this.exteriorSearchDistance, (px, py) => this.pointClear(px, py, r, IGNORED));
  }
};

// modules/geometry/surface-motion.js
var WALL_LEFT = "world:left";
var WALL_RIGHT = "world:right";
var WALL_TOP = "world:top";
var WALL_BOTTOM = "world:bottom";
function pushWall(out, distance, nx, ny, key, epsilon) {
  if (distance <= epsilon) {
    out.push({ nx, ny, depth: -distance, key });
  }
}
function castWall(best, distance, velocity, nx, ny, key) {
  if (velocity >= -1e-8) {
    return best;
  }
  const T = Math.max(0, -distance / velocity);
  return T <= 1 ? earlierContact(best, { t: T, nx, ny, key }) : best;
}
var SurfaceMotion = class {
  /**
   * @param {import('./obstacle-field.js').ObstacleField} field 장애물 장. 좌표 격자(`fixedPoint`)도 여기서 읽습니다.
   * @param {object} [options]
   * @param {(tieKey: string, contactKey: string, sign: number) => number} [options.tieRank]
   *   방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선, 부호 없는 32비트 정수). 순수 함수여야 합니다.
   *   기본은 `tieKey|contactKey|sign` 문자열의 FNV-1a 32비트 해시입니다.
   * @param {() => void} [options.sync] `solve`·`constrain`이 시작할 때 부르는 갱신 자리(장애물 지연 갱신 등).
   */
  constructor(field, { tieRank, sync } = {}) {
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
   * 지금 (x, y) 반지름 r 원이 닿았거나 `epsilon`(기본 고정소수 두 칸) 안으로 가까운 접촉 모두를 키 순서로.
   * 접촉마다 `{nx, ny, depth, key}`(+ 다각형이면 `distance`, 원 장애물이면 `obstacle`). 같은 접평면의 접촉은 가장 깊은 하나만 남깁니다.
   */
  contacts(x, y, r, ignoreId = null, epsilon = 2 / this.field.fixedPoint) {
    const FIELD = this.field, OUT = [];
    for (const B of FIELD.polygons.query(x, y, x, y, r + epsilon)) {
      SurfaceContactGeometry.polygonContacts(x, y, r, B, epsilon, OUT);
    }
    for (const B of FIELD.obstacles(x, y, x, y, r + epsilon, ignoreId)) {
      if (B.id === ignoreId) {
        continue;
      }
      const DX = x - B.x, DY = y - B.y, D = Math.hypot(DX, DY), NEEDED = r + B.r;
      if (D <= NEEDED + epsilon) {
        OUT.push({
          nx: D > 1e-9 ? DX / D : 1,
          ny: D > 1e-9 ? DY / D : 0,
          depth: NEEDED - D,
          key: "building:" + B.id,
          obstacle: B
        });
      }
    }
    pushWall(OUT, x - r, 1, 0, WALL_LEFT, epsilon);
    pushWall(OUT, FIELD.width - r - x, -1, 0, WALL_RIGHT, epsilon);
    pushWall(OUT, y - r, 0, 1, WALL_TOP, epsilon);
    pushWall(OUT, FIELD.height - r - y, 0, -1, WALL_BOTTOM, epsilon);
    OUT.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return OUT.filter((c, i) => {
      for (let j = 0; j < i; j++) {
        const N = OUT[j];
        if (Math.abs(c.nx - N.nx) + Math.abs(c.ny - N.ny) < 1e-7 && N.depth >= c.depth) {
          return false;
        }
      }
      return true;
    });
  }
  /** 원 장애물만 본 가장 이른 접촉. */
  circleObstacleCast(x, y, vx, vy, r, ignoreId = null) {
    let best = null;
    for (const B of this.field.obstacles(x, y, x + vx, y + vy, r, ignoreId)) {
      if (B.id === ignoreId) {
        continue;
      }
      best = earlierContact(
        best,
        SurfaceContactGeometry.circleCast(x, y, vx, vy, B.x, B.y, r + B.r, "building:" + B.id, B)
      );
    }
    return best;
  }
  /** 다각형·원 장애물·월드 경계 중 (vx, vy) 이동이 가장 먼저 닿는 접촉 `{t, nx, ny, key}`. 없으면 null. */
  cast(x, y, vx, vy, r, ignoreId = null) {
    const FIELD = this.field;
    const SLACK = FIELD.quantum;
    let best = null;
    for (const B of FIELD.polygons.query(x, y, x + vx, y + vy, r)) {
      for (let i = 0; i < B.points.length; i++) {
        best = earlierContact(
          best,
          SurfaceContactGeometry.edgeCast(
            x,
            y,
            vx,
            vy,
            B.points[i],
            B.points[(i + 1) % B.points.length],
            r,
            String(B.id) + ":" + i,
            SLACK
          )
        );
      }
    }
    best = earlierContact(best, this.circleObstacleCast(x, y, vx, vy, r, ignoreId));
    best = castWall(best, x - r, vx, 1, 0, WALL_LEFT);
    best = castWall(best, FIELD.width - r - x, -vx, -1, 0, WALL_RIGHT);
    best = castWall(best, y - r, vy, 0, 1, WALL_TOP);
    best = castWall(best, FIELD.height - r - y, -vy, 0, -1, WALL_BOTTOM);
    return best;
  }
  /**
   * 이미 겹쳐 버린 원을 가장 가까운 빈 자리로 옮깁니다. 겹침이 없으면 제자리, 옮길 수 없으면 제자리를 돌려줍니다.
   * 지형이나 다른 장애물을 가로질러 건너가는 일은 없습니다.
   */
  recover(x, y, r, ignoreId) {
    const FIELD = this.field, QUANTUM = FIELD.quantum, START = { x, y };
    if (this.clear(x, y, x, y, r, ignoreId)) {
      return START;
    }
    if (FIELD.polygonCircleClear(x, y, r)) {
      const P = FIELD.nearestExterior(x, y, r, ignoreId);
      if (P) {
        const END = { x: this.round(P.x), y: this.round(P.y) };
        if (this.clear(END.x, END.y, END.x, END.y, r, ignoreId) && FIELD.departureClear(x, y, END.x, END.y, r, ignoreId)) {
          return END;
        }
      }
      return START;
    }
    let remaining = r;
    for (let pass = 0; pass < 4; pass++) {
      const CONTACTS = this.contacts(x, y, r, ignoreId, 0).filter((c) => c.depth > QUANTUM);
      if (!CONTACTS.length) {
        break;
      }
      let delta = null, best = Infinity;
      const CONSIDER = (px, py) => {
        for (const C of CONTACTS) {
          if (px * C.nx + py * C.ny < C.depth + QUANTUM - 1e-7) {
            return;
          }
        }
        const D2 = px * px + py * py;
        if (D2 < best) {
          best = D2;
          delta = { x: px, y: py };
        }
      };
      for (const C of CONTACTS) {
        CONSIDER(C.nx * (C.depth + QUANTUM), C.ny * (C.depth + QUANTUM));
      }
      for (let i = 0; i < CONTACTS.length; i++) {
        for (let j = i + 1; j < CONTACTS.length; j++) {
          const A = CONTACTS[i], B = CONTACTS[j], DEN = A.nx * B.ny - A.ny * B.nx;
          if (Math.abs(DEN) < 1e-8) {
            continue;
          }
          const AD = A.depth + QUANTUM, BD = B.depth + QUANTUM;
          CONSIDER((AD * B.ny - A.ny * BD) / DEN, (A.nx * BD - AD * B.nx) / DEN);
        }
      }
      if (!delta || Math.sqrt(best) > remaining + 1e-7) {
        return START;
      }
      const D = Math.sqrt(best);
      x += delta.x;
      y += delta.y;
      remaining -= D;
      if (remaining <= 0) {
        break;
      }
    }
    return this.clear(x, y, x, y, r, ignoreId) ? { x, y } : START;
  }
  /**
   * (x, y)에서 (tx, ty)까지 이동하되 끝점을 고정소수 격자에 반올림해 비어 있는 곳까지만 갑니다.
   * `whole`이 true면 끝까지 갈 수 있을 때만 끝점을, 아니면 null을 돌려줍니다. false면 갈 수 있는 끝까지 이분 탐색(18회)합니다.
   */
  advance(x, y, tx, ty, r, ignoreId, whole = false) {
    const END = { x: this.round(tx), y: this.round(ty) };
    if (this.field.segmentClear(x, y, END.x, END.y, r, ignoreId, !whole && (x !== END.x || y !== END.y), 0)) {
      return END;
    }
    if (whole) {
      return null;
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
    return { x: safeX, y: safeY };
  }
  /**
   * 반지름 r인 원을 (x, y)에서 (tx, ty)로 옮긴 결과 `{x, y, hit}`. `hit`은 처음 닿은 접촉이고 없으면 null입니다.
   * 시작 자리가 막혀 있어 풀 수 없으면 `valid: false`도 담깁니다.
   * `mode`: `'steer'`는 닿은 뒤 접촉면을 따라 목표 쪽으로 미끄러지고(속도는 유지), `'stop'`은 닿는 자리에서 멈추고,
   * 그 밖의 값(`'project'`)은 접촉면에 사영한 만큼만 미끄러집니다. `tieKey`는 동률 순위의 입력입니다.
   */
  solve(x, y, tx, ty, r, ignoreId = null, mode = "steer", tieKey = "") {
    this.sync?.();
    const STRAIGHT = this.advance(x, y, tx, ty, r, ignoreId, true);
    if (STRAIGHT) {
      STRAIGHT.hit = null;
      return STRAIGHT;
    }
    let px = x, py = y, hit = null;
    const START = this.recover(px, py, r, ignoreId);
    px = START.x;
    py = START.y;
    if (!this.clear(px, py, px, py, r, ignoreId)) {
      return { x: px, y: py, hit, valid: false };
    }
    let rx = tx - x, ry = ty - y, remaining = Math.hypot(rx, ry);
    for (let pass = 0; pass < 8 && remaining > 1e-7; pass++) {
      const CONTACT = this.cast(px, py, rx, ry, r, ignoreId);
      if (!CONTACT) {
        const FREE = this.advance(px, py, px + rx, py + ry, r, ignoreId);
        px = FREE.x;
        py = FREE.y;
        break;
      }
      hit = hit || CONTACT;
      const T = clamp(CONTACT.t, 0, 1), Q = this.advance(px, py, px + rx * T, py + ry * T, r, ignoreId), SPENT = Math.hypot(Q.x - px, Q.y - py);
      px = Q.x;
      py = Q.y;
      remaining = Math.max(0, remaining - SPENT);
      if (mode === "stop" || remaining < 1e-7) {
        break;
      }
      const CONTACTS = this.contacts(px, py, r, ignoreId);
      if (!CONTACTS.some((n) => Math.abs(n.nx - CONTACT.nx) + Math.abs(n.ny - CONTACT.ny) < 1e-7)) {
        CONTACTS.push(CONTACT);
      }
      const P = SurfaceContactGeometry.slide(rx * (1 - T), ry * (1 - T), CONTACTS, remaining, {
        steer: mode === "steer",
        goalX: tx - px,
        goalY: ty - py,
        tieKey,
        tieRank: this.tieRank
      });
      const LEN = Math.hypot(P.x, P.y);
      if (LEN < 1e-7) {
        break;
      }
      if (SPENT < 1e-7 && Math.abs(P.x - rx) + Math.abs(P.y - ry) < 1e-8) {
        break;
      }
      rx = P.x;
      ry = P.y;
      remaining = Math.min(remaining, LEN);
    }
    return { x: px, y: py, hit };
  }
  /**
   * 마지막으로 위치를 확인한 체크포인트를 기록합니다(`verified`가 true면 그 자리는 장애물과 겹치지 않음이 확인된 것).
   * 체크포인트는 `ignoreId`와 이 시점의 {@link ObstacleField#version}도 함께 기억합니다.
   */
  remember(body, x, y, verified = true, ignoreId = null) {
    this.checkpoints.set(body, { x, y, verified, ignoreId, signature: this.field.version });
  }
  /** 모든 체크포인트를 잊습니다(한 이동 단계가 시작될 때). */
  forgetAll() {
    this.checkpoints = /* @__PURE__ */ new WeakMap();
  }
  /**
   * 몸체가 다른 힘으로 (x, y)까지 옮겨진 뒤, 마지막 체크포인트에서 그 자리까지를 `'project'`로 다시 풀어 장애물 안으로
   * 들어가지 않게 합니다. 체크포인트가 확인된 자리·같은 `ignoreId`·같은 장애물 버전이고 몸체가 안 움직였으면 null,
   * 아니면 `solve` 결과를 돌려줍니다. 결과를 몸체에 쓰고 `remember`하는 일은 호출자가 합니다.
   */
  constrain(body, x, y, r, ignoreId = null, tieKey = "") {
    this.sync?.();
    const S = this.checkpoints.get(body) || { x, y, verified: false };
    if (S.verified && S.ignoreId === ignoreId && S.signature === this.field.version && S.x === x && S.y === y) {
      return null;
    }
    return this.solve(S.x, S.y, x, y, r, ignoreId, "project", tieKey);
  }
};
export {
  BoundsIndex,
  ObstacleField,
  SurfaceContactGeometry,
  SurfaceMotion,
  SweptCircleContact,
  assignBounds,
  boundariesCross,
  catmullRomPoint,
  closestPolylineProgress,
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
