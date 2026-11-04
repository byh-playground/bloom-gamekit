// 2D 기하 수학: 점·선분·다각형·폴리라인. 게임 규칙·시간·난수·DOM을 읽지 않는 순수 함수입니다.
// 같은 입력은 같은 부동소수 연산 순서로 같은 값을 돌려줍니다(결정론 시뮬레이션이 그대로 씁니다).

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * 점이 단순 다각형(자기 교차 없음) 안에 있는지 짝수-홀수 규칙으로 판정합니다. 꼭짓점이 3개 미만이면 false입니다.
 * 경계 위의 점은 어느 쪽인지 정하지 않습니다.
 */
export function pointInSimplePolygon(x, y, points) {
    if (!Array.isArray(points) || points.length < 3) {
        return false;
    }
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const A = points[i],
            B = points[j];
        const HIT = A.y > y !== B.y > y && x < ((B.x - A.x) * (y - A.y)) / (B.y - A.y || 1e-9) + A.x;
        if (HIT) {
            inside = !inside;
        }
    }
    return inside;
}

/** 점에서 선분 AB까지의 최단 거리. A와 B가 같은 점이면 점과 점의 거리입니다. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const ABX = bx - ax,
        ABY = by - ay;
    const DENOM = ABX * ABX + ABY * ABY || 1;
    let t = ((px - ax) * ABX + (py - ay) * ABY) / DENOM;
    t = Math.max(0, Math.min(1, t));
    const CX = ax + ABX * t,
        CY = ay + ABY * t;
    return Math.hypot(px - CX, py - CY);
}

/** 점에서 폴리라인까지의 최단 거리. 선분이 없으면(점 2개 미만) 1e9입니다. */
export function pointPolylineDistance(px, py, points) {
    let best = 1e9;
    for (let i = 0; i < points.length - 1; i++) {
        best = Math.min(best, pointSegmentDistance(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y));
    }
    return best;
}

/** 선분 AB와 CD가 교차(끝점 접촉 포함)하는지. 평행(분모 1e-10 미만)이면 겹쳐 있어도 false입니다. */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const UX = bx - ax,
        UY = by - ay,
        VX = dx - cx,
        VY = dy - cy,
        DEN = UX * VY - UY * VX;
    if (Math.abs(DEN) < 1e-10) {
        return false;
    }
    const QX = cx - ax,
        QY = cy - ay,
        T = (QX * VY - QY * VX) / DEN,
        S = (QX * UY - QY * UX) / DEN;
    return T >= 0 && T <= 1 && S >= 0 && S <= 1;
}

/** 선분 AB와 CD 사이의 최단 거리. 교차하면 0입니다. */
export function segmentDistance(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
        return 0;
    }
    return Math.min(
        pointSegmentDistance(ax, ay, cx, cy, dx, dy),
        pointSegmentDistance(bx, by, cx, cy, dx, dy),
        pointSegmentDistance(cx, cy, ax, ay, bx, by),
        pointSegmentDistance(dx, dy, ax, ay, bx, by),
    );
}

/** 선분이 닫힌 직사각형에 닿는지(분리축 판정, 거의 닿음도 닿음으로 칩니다). */
export function segmentTouchesRect(ax, ay, bx, by, x0, y0, x1, y1) {
    if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) {
        return false;
    }
    const DX = bx - ax,
        DY = by - ay;
    let pos = false,
        neg = false;
    // 모서리 순서: (x0,y0) (x1,y0) (x1,y1) (x0,y1)
    for (let i = 0; i < 4; i++) {
        const X = i === 1 || i === 2 ? x1 : x0,
            Y = i >= 2 ? y1 : y0;
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

/** 다각형 가장자리 중 하나라도 직사각형에 닿는지. */
export function polygonTouchesRect(points, x0, y0, x1, y1) {
    for (let i = 0; i < points.length; i++) {
        const A = points[i],
            B = points[(i + 1) % points.length];
        if (segmentTouchesRect(A.x, A.y, B.x, B.y, x0, y0, x1, y1)) {
            return true;
        }
    }
    return false;
}

/** 두 다각형이 겹치는지: 한쪽 꼭짓점이 다른 쪽 안에 있거나 가장자리 사이 거리가 0.001 미만입니다. */
export function polygonsOverlap(a, b) {
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

/** 두 다각형의 가장자리끼리 닿거나 0.001 안으로 가까운지(꼭짓점 포함 판정은 하지 않습니다). */
export function boundariesCross(a, b) {
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            const P = a[i],
                Q = a[(i + 1) % a.length],
                R = b[j],
                T = b[(j + 1) % b.length];
            if (segmentDistance(P.x, P.y, Q.x, Q.y, R.x, R.y, T.x, T.y) < 0.001) {
                return true;
            }
        }
    }
    return false;
}

/**
 * `points`(`{x, y}` 배열)로 `minX`·`maxX`·`minY`·`maxY`를 구해 항목에 붙이고 그 항목을 돌려줍니다.
 * {@link BoundsIndex}에 넣을 항목이 갖춰야 하는 경계입니다.
 */
export function assignBounds(item) {
    const POINTS = item.points;
    let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
    for (let i = 0; i < POINTS.length; i++) {
        minX = Math.min(minX, POINTS[i].x);
        maxX = Math.max(maxX, POINTS[i].x);
        minY = Math.min(minY, POINTS[i].y);
        maxY = Math.max(maxY, POINTS[i].y);
    }
    return Object.assign(item, { minX, maxX, minY, maxY });
}

/**
 * 폴리라인 위 t(0~1, 전체 길이 비율)의 점. 좌표는 정수로 반올림(Math.round)해 돌려줍니다.
 * 점이 2개 미만이면 첫 점의 복사본, 없으면 {x: 0, y: 0}입니다.
 */
export function roundedPointOnPolyline(points, t) {
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
                y: Math.round(points[i].y + (points[i + 1].y - points[i].y) * Q),
            };
        }
        acc += LEN;
    }
    return { ...points[points.length - 1] };
}

/** t 앞뒤 `delta`(기본 0.015, 전체 길이 비율) 두 점을 잇는 단위 접선. {@link roundedPointOnPolyline}의 반올림 점을 씁니다. */
export function polylineTangentAt(points, t, delta = 0.015) {
    const A = roundedPointOnPolyline(points, clamp(t - delta, 0, 1)),
        B = roundedPointOnPolyline(points, clamp(t + delta, 0, 1));
    const DX = B.x - A.x,
        DY = B.y - A.y,
        LEN = Math.hypot(DX, DY) || 1;
    return { x: DX / LEN, y: DY / LEN };
}

/** (x, y)에 가장 가까운 폴리라인 위치를 전체 길이 비율(0~1)로. 점이 2개 미만이거나 길이가 0이면 0입니다. */
export function closestPolylineProgress(points, x, y) {
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
    let acc = 0,
        bestD = Infinity,
        bestAlong = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const A = points[i],
            B = points[i + 1],
            DX = B.x - A.x,
            DY = B.y - A.y,
            LEN2 = DX * DX + DY * DY || 1;
        const LEN = Math.hypot(B.x - A.x, B.y - A.y);
        const Q = clamp(((x - A.x) * DX + (y - A.y) * DY) / LEN2, 0, 1);
        const PX = A.x + DX * Q,
            PY = A.y + DY * Q,
            D = (x - PX) * (x - PX) + (y - PY) * (y - PY);
        if (D < bestD) {
            bestD = D;
            bestAlong = acc + LEN * Q;
        }
        acc += LEN;
    }
    return clamp(bestAlong / total, 0, 1);
}

/** Catmull-Rom 스플라인 p1→p2 구간의 t(0~1) 위치. p0·p3은 양 옆 제어점입니다. */
export function catmullRomPoint(p0, p1, p2, p3, t) {
    const T2 = t * t,
        T3 = T2 * t;
    return {
        x:
            0.5 *
            (2 * p1.x +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * T2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * T3),
        y:
            0.5 *
            (2 * p1.y +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * T2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * T3),
    };
}

/** 폴리라인을 구간마다 `steps`점씩 Catmull-Rom으로 부드럽게 만듭니다. 점이 2개 미만이면 입력을 그대로 돌려줍니다. */
export function smoothPolylineCatmull(points, steps = 5) {
    if (!Array.isArray(points) || points.length < 2) {
        return points || [];
    }
    const OUT = [];
    for (let i = 0; i < points.length - 1; i++) {
        const P0 = points[Math.max(0, i - 1)],
            P1 = points[i],
            P2 = points[i + 1],
            P3 = points[Math.min(points.length - 1, i + 2)];
        for (let s = 0; s < steps; s++) {
            OUT.push(catmullRomPoint(P0, P1, P2, P3, s / steps));
        }
    }
    OUT.push({ ...points[points.length - 1] });
    return OUT;
}

/** 모든 꼭짓점을 평균 중심 쪽으로 `factor`(0~1)만큼 당긴 새 다각형. 꼭짓점이 3개 미만이면 입력을 그대로 돌려줍니다. */
export function insetPolygonTowardCenter(points, factor) {
    if (!Array.isArray(points) || points.length < 3) {
        return points || [];
    }
    const CX = points.reduce((s, p) => s + p.x, 0) / points.length;
    const CY = points.reduce((s, p) => s + p.y, 0) / points.length;
    return points.map((p) => ({ x: p.x + (CX - p.x) * factor, y: p.y + (CY - p.y) * factor }));
}

/**
 * 폴리라인을 `halfWidth` 폭의 띠 다각형으로 만듭니다(왼쪽 가장자리 + 뒤집은 오른쪽 가장자리).
 * 양 끝은 halfWidth의 0.72배 바깥으로 늘립니다. `clampFn`이 있으면 가장자리 점마다 거칩니다.
 */
export function polylineToRibbonPolygon(points, halfWidth, clampFn = null) {
    if (!Array.isArray(points) || points.length < 2) {
        return [];
    }
    const LEFT = [],
        RIGHT = [];
    for (let i = 0; i < points.length; i++) {
        const PREV = points[Math.max(0, i - 1)],
            NEXT = points[Math.min(points.length - 1, i + 1)];
        const DX = NEXT.x - PREV.x,
            DY = NEXT.y - PREV.y,
            LEN = Math.hypot(DX, DY) || 1;
        const TX = DX / LEN,
            TY = DY / LEN,
            NX = -TY,
            NY = TX;
        let bx = points[i].x,
            by = points[i].y;
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
    // 중심선이 이미 매끄러우므로 닫힌 다각형 전체를 다시 평균 내지 않습니다(긴 곡선에서 양 가장자리가 말려 자기 교차가 생깁니다).
    return [...LEFT, ...RIGHT.reverse()];
}

/** 두 점 사이의 거리. 좌표가 없거나 NaN이면 0으로 칩니다. */
export function pointDistance(a, b) {
    return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

/** `items` 중 `point`에 가장 가까운 것까지의 거리. 항목이 없으면 Infinity입니다. */
export function nearestPointDistance(point, items) {
    let best = Infinity;
    for (const ITEM of items || []) {
        best = Math.min(best, pointDistance(point, ITEM));
    }
    return best;
}

/** `items` 중 가장 가까운 두 점 사이의 거리. 짝이 없거나 유한한 값이 아니면 `none`(기본 Infinity)입니다. */
export function minPairDistance(items, none = Infinity) {
    let best = Infinity;
    for (let i = 0; i < (items || []).length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            best = Math.min(best, pointDistance(items[i], items[j]));
        }
    }
    return Number.isFinite(best) ? best : none;
}
