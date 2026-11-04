// 정적 장애물 장: 다각형 장애물 + 원 장애물 + 직사각형 월드 경계.
// "여기에 지름 r인 원이 들어갈 수 있는가, 이 선분을 따라 이동할 수 있는가"를 답합니다. 장애물이 무엇을 뜻하는지
// (지형·건물·절벽)와 누가 무시되는지는 게임이 정하고, 이 클래스는 기하만 계산합니다.
import { BoundsIndex } from './bounds-index.js';
import { assignBounds, clamp, pointInSimplePolygon, pointSegmentDistance, segmentDistance } from './math.js';

// 반지름 r인 원이 가장자리에서 이 거리 안이면 닿은 것으로 칩니다. 고정소수 한 칸(quantum)만큼 봐주고, 반지름이 0이면 0.001입니다.
function contactThreshold(r, quantum) {
    return r > 0 ? Math.max(0, r - quantum) : 0.001;
}

/**
 * 선분 (x0, y0)-(x1, y1)을 반지름 r로 쓸었을 때 `index`의 다각형(`{points}`) 중 하나에 막히는지.
 * 끝점이 다각형 안이거나 가장자리와의 거리가 `r - quantum`(r이 0이면 0.001) 미만이면 막힌 것입니다.
 */
export function segmentBlockedBy(index, x0, y0, x1, y1, r = 0, quantum = 0) {
    for (const B of index.query(x0, y0, x1, y1, r)) {
        if (pointInSimplePolygon(x0, y0, B.points) || pointInSimplePolygon(x1, y1, B.points)) {
            return true;
        }
        for (let i = 0; i < B.points.length; i++) {
            const A = B.points[i],
                C = B.points[(i + 1) % B.points.length];
            if (segmentDistance(x0, y0, x1, y1, A.x, A.y, C.x, C.y) < contactThreshold(r, quantum)) {
                return true;
            }
        }
    }
    return false;
}

function circleWithBounds(circle) {
    if (typeof circle.minX !== 'number') {
        circle.minX = circle.x - circle.r;
        circle.maxX = circle.x + circle.r;
        circle.minY = circle.y - circle.r;
        circle.maxY = circle.y + circle.r;
    }
    return circle;
}

export class ObstacleField {
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
        exteriorSearchDistance = 256,
    }) {
        if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
            throw new RangeError('ObstacleField width and height must be positive finite numbers.');
        }
        if (!(fixedPoint > 0) || !Number.isFinite(fixedPoint)) {
            throw new RangeError('ObstacleField fixedPoint must be a positive finite number.');
        }
        if (ignoreAll !== null && typeof ignoreAll?.keep !== 'function') {
            throw new TypeError('ObstacleField ignoreAll must be {id, keep(circle)}.');
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
                if (typeof P.minX !== 'number') {
                    assignBounds(P);
                }
            }
            this.polygons = new BoundsIndex(polygons, cell);
        }
        // 다각형이 하나도 없으면 다각형 검사는 항상 통과입니다(월드 경계 검사 포함, 아래 polygonCircleClear 참고).
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
                const A = B.points[i],
                    C = B.points[(i + 1) % B.points.length];
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
        if (
            Math.min(x0, x1) < r ||
            Math.min(y0, y1) < r ||
            Math.max(x0, x1) > this.width - r ||
            Math.max(y0, y1) > this.height - r
        ) {
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
        let best = null,
            bestD = Infinity;
        const STEP = 16;
        for (let range = STEP; range <= maxDistance; range += STEP) {
            for (let i = 0; i < 32; i++) {
                const A = (i * Math.PI) / 16,
                    QX = clamp(x + Math.cos(A) * range, r + 1, this.width - r - 1),
                    QY = clamp(y + Math.sin(A) * range, r + 1, this.height - r - 1);
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
        if (
            Math.min(x, tx) < r ||
            Math.min(y, ty) < r ||
            Math.max(x, tx) > this.width - r ||
            Math.max(y, ty) > this.height - r ||
            !this.polygonSegmentClear(x, y, tx, ty, r)
        ) {
            return false;
        }
        for (const B of this.obstacles(x, y, tx, ty, r + margin, ignoreId)) {
            if (B.id === ignoreId) {
                continue;
            }
            const NEEDED = r + B.r + margin,
                START = Math.hypot(x - B.x, y - B.y);
            if (
                departure &&
                START < NEEDED &&
                (x - B.x) * (tx - x) + (y - B.y) * (ty - y) >= 0 &&
                Math.hypot(tx - B.x, ty - B.y) >= START
            ) {
                continue;
            }
            if (pointSegmentDistance(B.x, B.y, x, y, tx, ty) < NEEDED - 0.001) {
                return false;
            }
        }
        return true;
    }

    /** 반지름 r인 원이 (x, y)에 둘 수 있는지. */
    pointClear(x, y, r, ignoreId = null) {
        return this.segmentClear(x, y, x, y, r, ignoreId);
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
}
